/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Plugin-owned UI preferences using the existing instance checkpoint store.
//! Accepted writes drain before native retirement; paint never performs storage I/O.
use super::Scope;
use crate::budget::{Kind, NativeBudget, Permit};
use maka_capabilities::call::Resources;
use maka_plugin_core::contract::{Contract, Interface, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::mpsc;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValueCheckpointProps {
    #[schemars(length(min = 1))]
    pub key: String,
    #[schemars(length(min = 1))]
    pub format: String,
    pub command: Option<ValueCheckpointCommand>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ValueCheckpointCommand {
    Read {
        sequence: u64,
    },
    Write {
        sequence: u64,
        #[serde(rename = "expectedRevision")]
        expected_revision: Option<u64>,
        value: Value,
    },
}
impl ValueCheckpointCommand {
    fn sequence(&self) -> u64 {
        match self {
            Self::Read { sequence } | Self::Write { sequence, .. } => *sequence,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValueCheckpointObservation {
    pub sequence: u64,
    pub state: ValueCheckpointState,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ValueCheckpointState {
    Loading,
    Saving,
    Ready {
        revision: Option<u64>,
        value: Option<Value>,
    },
    Failed {
        diagnostic: String,
    },
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.ui.ValueCheckpoint".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Component {
            props: serde_json::to_value(schemars::schema_for!(ValueCheckpointProps))
                .unwrap()
                .into(),
            events: BTreeMap::from([(
                "changed".into(),
                serde_json::to_value(schemars::schema_for!(ValueCheckpointObservation))
                    .unwrap()
                    .into(),
            )]),
            captures: BTreeMap::new(),
        },
    }
}
pub struct ValueCheckpoint {
    key: String,
    format: String,
    command: Option<u64>,
    pending: Option<u64>,
    sender: Option<mpsc::Sender<(ValueCheckpointCommand, Option<Arc<Permit>>)>>,
    receiver: mpsc::Receiver<(ValueCheckpointObservation, Option<Arc<Permit>>)>,
    current: ValueCheckpointObservation,
    announced: Option<ValueCheckpointObservation>,
    current_memory: Option<Arc<Permit>>,
    announced_memory: Option<Arc<Permit>>,
    budget: NativeBudget,
}
fn failure(sequence: u64, error: impl std::fmt::Display) -> ValueCheckpointObservation {
    ValueCheckpointObservation {
        sequence,
        state: ValueCheckpointState::Failed {
            diagnostic: error.to_string().chars().take(1024).collect(),
        },
    }
}

impl ValueCheckpoint {
    pub fn new(
        scope: Option<Scope>,
        props: &ValueCheckpointProps,
        resources: &Arc<Resources>,
        budget: NativeBudget,
    ) -> Self {
        let initial = ValueCheckpointObservation {
            sequence: 0,
            state: ValueCheckpointState::Loading,
        };
        let (reply, receiver) = mpsc::channel(2);
        let (sender, requests) = mpsc::channel(1);
        let worker_budget = budget.clone();
        let started = (|| {
            let scope = scope.ok_or("UI preferences require an owned UI Root")?;
            let store = scope
                .store
                .upgrade()
                .ok_or("original UI Root is unavailable")?;
            let mut ticket = resources.reserve().map_err(|e| e.to_string())?;
            let key = props.key.clone();
            let format = props.format.clone();
            ticket.start();
            scope.scheduler.clone().spawn(async move {
                let mut requests = requests;
                let mut checkpoints = None;
                let mut command = ValueCheckpointCommand::Read { sequence: 0 };
                let mut memory = None;
                let budget = worker_budget;
                loop {
                    let sequence = command.sequence();
                    let result: Result<(ValueCheckpointState, Option<Arc<Permit>>), String> =
                        async {
                            if checkpoints.is_none() {
                                checkpoints = Some(scope.open(&store)?);
                            }
                            let checkpoints = checkpoints.as_ref().unwrap();
                            match command {
                                ValueCheckpointCommand::Read { .. } => {
                                    let budget = budget.clone();
                                    let saved = checkpoints
                                        .read(&key, move |total_bytes| {
                                            budget
                                                .reserve(Kind::Encoded, total_bytes)
                                                .map(Arc::new)
                                                .map_err(|error| {
                                                    maka_event_log::StoreError::InvalidTransition(
                                                        error.to_string(),
                                                    )
                                                })
                                        })
                                        .await
                                        .map_err(|e| e.to_string())?;
                                    match saved {
                                        None => Ok((
                                            ValueCheckpointState::Ready {
                                                revision: None,
                                                value: None,
                                            },
                                            None,
                                        )),
                                        Some((saved, bytes)) => {
                                            if saved.format != format
                                                || saved.data_source != Value::Null
                                            {
                                                return Err(
                                                    "UI preference format is incompatible".into()
                                                );
                                            }
                                            let value = serde_json::from_slice(&saved.content)
                                                .map_err(|e| e.to_string())?;
                                            Ok((
                                                ValueCheckpointState::Ready {
                                                    revision: Some(saved.revision),
                                                    value: Some(value),
                                                },
                                                Some(bytes),
                                            ))
                                        }
                                    }
                                }
                                ValueCheckpointCommand::Write {
                                    expected_revision,
                                    value,
                                    ..
                                } => {
                                    let bytes = match memory.take() {
                                        Some(bytes) => bytes,
                                        None => {
                                            let size = maka_plugin_core::json::value_size(
                                                &value,
                                                usize::MAX,
                                            )?;
                                            Arc::new(
                                                budget
                                                    .reserve(Kind::Encoded, size)
                                                    .map_err(|e| e.to_string())?,
                                            )
                                        }
                                    };
                                    let content =
                                        serde_json::to_vec(&value).map_err(|e| e.to_string())?;
                                    let revision = checkpoints
                                        .write(
                                            &key,
                                            expected_revision,
                                            &format,
                                            &Value::Null,
                                            &Value::Null,
                                            content,
                                        )
                                        .await
                                        .map_err(|e| e.to_string())?;
                                    Ok((
                                        ValueCheckpointState::Ready {
                                            revision: Some(revision),
                                            value: Some(value),
                                        },
                                        Some(bytes),
                                    ))
                                }
                            }
                        }
                        .await;
                    let _ = reply
                        .send(match result {
                            Ok((state, memory)) => {
                                (ValueCheckpointObservation { sequence, state }, memory)
                            }
                            Err(error) => (failure(sequence, error), None),
                        })
                        .await;
                    match requests.recv().await {
                        Some((next, next_memory)) => {
                            command = next;
                            memory = next_memory;
                        }
                        None => break,
                    }
                }
                ticket.complete(Ok(()));
            });
            Ok::<_, String>(())
        })();
        Self {
            key: props.key.clone(),
            format: props.format.clone(),
            command: None,
            pending: None,
            sender: started.is_ok().then_some(sender),
            receiver,
            current: started.err().map_or(initial, |error| failure(0, error)),
            announced: None,
            current_memory: None,
            announced_memory: None,
            budget,
        }
    }
    pub fn publication_capacity(&self, props: &ValueCheckpointProps) -> usize {
        let command = props.key == self.key
            && props.format == self.format
            && props.command.as_ref().is_some_and(|command| {
                self.command
                    .as_ref()
                    .is_none_or(|prior| command.sequence() > *prior)
            });
        2 * (usize::from(self.announced.is_none()) + usize::from(command))
    }
    pub fn update(&mut self, props: &ValueCheckpointProps) {
        if props.key != self.key || props.format != self.format {
            self.current_memory = None;
            self.current = failure(
                self.current.sequence,
                "UI preference identity cannot change on a live mount",
            );
            return;
        }
        let Some(command) = props.command.as_ref() else {
            return;
        };
        let sequence = command.sequence();
        if self.command.is_some_and(|prior| sequence <= prior) {
            return;
        }
        self.command = Some(sequence);
        if self.pending.is_some() {
            self.current_memory = None;
            self.current = failure(command.sequence(), "UI preferences are busy");
            return;
        }
        let memory = match command {
            ValueCheckpointCommand::Write { value, .. } => {
                let reservation =
                    maka_plugin_core::json::value_size(value, usize::MAX).and_then(|size| {
                        self.budget
                            .reserve(Kind::Encoded, size)
                            .map(Arc::new)
                            .map_err(|e| e.to_string())
                    });
                match reservation {
                    Ok(memory) => Some(memory),
                    Err(error) => {
                        self.current = failure(sequence, error);
                        self.current_memory = None;
                        return;
                    }
                }
            }
            ValueCheckpointCommand::Read { .. } => None,
        };
        self.current_memory = None;
        self.current = match self
            .sender
            .as_ref()
            .ok_or("UI preferences are unavailable")
            .and_then(|sender| {
                sender
                    .try_send((command.clone(), memory))
                    .map_err(|_| "UI preferences are busy")
            }) {
            Ok(()) => {
                self.pending = Some(command.sequence());
                ValueCheckpointObservation {
                    sequence: command.sequence(),
                    state: if matches!(command, ValueCheckpointCommand::Write { .. }) {
                        ValueCheckpointState::Saving
                    } else {
                        ValueCheckpointState::Loading
                    },
                }
            }
            Err(error) => failure(command.sequence(), error),
        };
    }
    fn poll(&mut self) {
        if let Ok((reply, memory)) = self.receiver.try_recv() {
            if self.pending == Some(reply.sequence) {
                self.pending = None;
            }
            self.current = reply;
            self.current_memory = memory;
        }
    }
    pub fn observe(&mut self) -> Option<ValueCheckpointObservation> {
        // Transfer a command's immediate outcome before polling the original
        // worker. A ready reply must not overwrite an unannounced busy/error.
        if self.announced.as_ref() != Some(&self.current) {
            self.announced = Some(self.current.clone());
            self.announced_memory = self.current_memory.clone();
            return Some(self.current.clone());
        }
        self.poll();
        if self.announced.as_ref() == Some(&self.current) {
            return None;
        }
        self.announced = Some(self.current.clone());
        self.announced_memory = self.current_memory.clone();
        Some(self.current.clone())
    }
    pub fn close(&mut self) {
        self.sender.take();
        // Accepted store operations still drain. Retired observation custody
        // must not leave that original worker blocked on a full result queue.
        self.receiver.close();
    }
}

pub const IMPLEMENTATION: &str = "maka.ui.checkpoint";

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [("Checkpoint", contract())],
    )
}
