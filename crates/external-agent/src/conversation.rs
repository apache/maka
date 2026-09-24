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

use crate::{Agent, Error, digest, driver::Driver, transport::Connection};
use agent_client_protocol_schema::v1 as acp;
use maka_plugins::{
    executor,
    host::Services,
    storage::{Data, Mutation, Store},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum State {
    Creating,
    Ready {
        session_id: String,
    },
    Running {
        session_id: String,
        invocation_id: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    configuration: String,
    cwd: String,
    pub state: State,
    pub defaults: Vec<acp::SessionConfigOption>,
}

pub(crate) struct Journal {
    key: String,
    revision: Option<u64>,
    pub record: Record,
}
impl Journal {
    pub fn exists(&self) -> bool {
        self.revision.is_some()
    }
    async fn read(
        host: &Services,
        agent: &Agent,
        request: &executor::Request,
    ) -> Result<Self, Error> {
        let key = format!(
            "conversation/{}",
            digest(&(&agent.id, &request.conversation_key))?
        );
        let configuration = digest(&(&agent.executable, &agent.args, &agent.env))?;
        let stored = host.storage.read(key.clone()).await?;
        let revision = stored.as_ref().map(|value| value.revision);
        let record = match stored.and_then(|value| value.data.value().cloned()) {
            Some(value) => serde_json::from_value::<Record>(value)?,
            None => Record {
                configuration: configuration.clone(),
                cwd: request.cwd.clone(),
                state: State::Creating,
                defaults: vec![],
            },
        };
        if record.configuration != configuration || record.cwd != request.cwd {
            return Err(Error::Continuity(
                "agent launch configuration or workspace changed",
            ));
        }
        Ok(Self {
            key,
            revision,
            record,
        })
    }

    pub async fn save(&mut self, store: &dyn Store, state: State) -> Result<(), Error> {
        // Mutate memory only after confirmed CAS; an uncertain commit is never retried blindly.
        let next = Record {
            configuration: self.record.configuration.clone(),
            cwd: self.record.cwd.clone(),
            state,
            defaults: self.record.defaults.clone(),
        };
        let records = store
            .batch(vec![Mutation {
                key: self.key.clone(),
                expected_revision: self.revision,
                data: Data::Present(serde_json::to_value(&next)?),
            }])
            .await?;
        self.revision = Some(
            records
                .first()
                .ok_or(Error::Invalid("missing storage receipt"))?
                .revision,
        );
        self.record = next;
        Ok(())
    }
}

pub(crate) struct Live {
    pub connection: Connection,
    pub session_id: String,
    pub options: Vec<acp::SessionConfigOption>,
}

type Slot = Arc<tokio::sync::Mutex<Option<Live>>>;
#[derive(Clone)]
pub(crate) struct Provider {
    pub agent: Agent,
    pub host: Services,
    conversations: Arc<Mutex<BTreeMap<String, Slot>>>,
}
impl Provider {
    pub async fn close(&self) -> Result<(), Error> {
        let slots: Vec<_> = self
            .conversations
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for slot in slots {
            let mut slot = tokio::time::timeout(std::time::Duration::from_secs(5), slot.lock())
                .await
                .map_err(|_| Error::Output(executor::Error::CleanupUnconfirmed))?;
            if let Some(live) = slot.as_ref() {
                self.host.processes.close(live.connection.id()).await?;
                *slot = None;
            }
        }
        Ok(())
    }
    pub fn new(agent: Agent, host: Services) -> Self {
        Self {
            agent,
            host,
            conversations: Arc::default(),
        }
    }

    async fn execute(
        &self,
        request: executor::Request,
        context: executor::Context,
    ) -> Result<executor::Outcome, Error> {
        let scope = context
            .call
            .clone()
            .ok_or(Error::Invalid("missing invocation authority"))?;
        let slot = {
            let mut slots = self.conversations.lock().unwrap();
            slots.retain(|_, slot| {
                Arc::strong_count(slot) > 1 || slot.try_lock().map_or(true, |live| live.is_some())
            });
            if slots.len() >= 32 && !slots.contains_key(&request.conversation_key) {
                return Err(Error::Invalid("agent conversation capacity reached"));
            }
            slots
                .entry(request.conversation_key.clone())
                .or_default()
                .clone()
        };
        let mut slot = slot
            .try_lock()
            .map_err(|_| Error::Invalid("conversation is busy"))?;
        let mut journal = Journal::read(&self.host, &self.agent, &request).await?;
        if matches!(journal.record.state, State::Running { .. }) {
            return Err(Error::Continuity(
                "previous prompt has no confirmed outcome",
            ));
        }
        let handle = if let Some(live) = slot.as_ref() {
            self.host
                .processes
                .open(scope.clone(), live.connection.id())
        } else {
            self.host.processes.spawn(scope, self.agent.command()).await
        }?;
        let restored = slot.take();
        let process_id = handle.id.clone();
        let mut driver = Driver::new(&self.host, &request, &context);
        let result = async {
            let mut live = match restored {
                Some(mut live) => {
                    live.connection.rebind(handle)?;
                    live
                }
                None => driver.connect(handle, &mut journal).await?,
            };
            let outcome = driver.prompt(&mut live, &mut journal).await?;
            *slot = Some(live);
            Ok(outcome)
        }
        .await;
        if result.is_err() {
            // A lost connection can leave the remote prompt uncertain. The journal
            // remains Running, so another activation cannot silently duplicate it.
            self.host.processes.close(process_id).await?;
        }
        result
    }
}

impl executor::Provider for Provider {
    fn execute(
        &self,
        request: executor::Request,
        context: executor::Context,
    ) -> futures_util::future::BoxFuture<'static, Result<executor::Outcome, executor::Error>> {
        let provider = self.clone();
        Box::pin(async move {
            match Provider::execute(&provider, request, context).await {
                Ok(outcome) => Ok(outcome),
                Err(Error::Output(error)) => Err(error),
                Err(Error::Process(maka_plugins::process::Error::CleanupUnconfirmed(_))) => {
                    Err(executor::Error::CleanupUnconfirmed)
                }
                Err(Error::Cancelled) => Ok(executor::Outcome::Cancelled {
                    reason: Some("cancelled".into()),
                }),
                Err(error) => Ok(executor::Outcome::Failed {
                    code: Some(
                        match error {
                            Error::Continuity(_) => "external_conversation_unavailable",
                            Error::Timeout => "external_agent_timeout",
                            _ => "external_agent_failed",
                        }
                        .into(),
                    ),
                    message: error.to_string(),
                    recoverable: false,
                }),
            }
        })
    }
}
