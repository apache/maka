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

//! A sidecar stand-in for tests of what uses [`crate::BotService`], in this
//! crate and in the pages built on it (feature `test-support`).
//!
//! [`FakeSidecar::launcher`] gives the service a supervisor without a
//! process: it reports `Started` at once, answers each command from a
//! script ([`FakeSidecar::answer`], else a default: settings and the
//! workspace are taken, a channel test passes, no status is listed, and the
//! onboarding and bridge commands are refused), records the commands, and
//! stops on `shutdown`. [`FakeSidecar::send`] delivers an event as if the
//! sidecar had reported it.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};

use crate::launch::BotHost;
use crate::protocol::{ChannelStatus, SidecarRefusal};
use crate::service::BotLauncher;
use crate::supervisor::{BotCommandError, BotEvent, BotHandle, BotRun, Request, SupervisedBots};

/// The pid the fake reports.
pub const FAKE_PID: u32 = 4321;

#[derive(Default)]
struct Script {
    answers: HashMap<String, VecDeque<Result<Value, BotCommandError>>>,
    commands: Vec<Value>,
    launches: Vec<BotHost>,
    events: Option<async_channel::Sender<BotEvent>>,
}

/// The fake. Cheap to clone; clones share the script.
#[derive(Clone, Default)]
pub struct FakeSidecar {
    script: Arc<Mutex<Script>>,
}

impl std::fmt::Debug for FakeSidecar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeSidecar").finish_non_exhaustive()
    }
}

impl FakeSidecar {
    pub fn new() -> Self {
        Self::default()
    }

    fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.script.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a fake sidecar each time the service launches one.
    pub fn launcher(&self) -> BotLauncher {
        let fake = self.clone();
        Arc::new(move |host| {
            let fake = fake.clone();
            Box::pin(async move { Ok(fake.supervise(host)) })
        })
    }

    fn supervise(&self, host: BotHost) -> SupervisedBots {
        let (requests_tx, requests) = async_channel::bounded(8);
        let (events_tx, events) = async_channel::unbounded();
        {
            let mut script = self.script();
            script.launches.push(host);
            script.events = Some(events_tx.clone());
        }
        let fake = self.clone();
        let run = async move {
            let _ = events_tx
                .send(BotEvent::Started { pid: FAKE_PID, compatibility_epoch: None })
                .await;
            while let Ok(request) = requests.recv().await {
                match request {
                    Request::Command { command, reply } => {
                        let value = serde_json::to_value(&command).unwrap_or(Value::Null);
                        let answer = fake.answer_for(command.name(), value);
                        let _ = reply.try_send(answer);
                    }
                    Request::Restart => {}
                    Request::Shutdown { done } => {
                        fake.script().commands.push(json!({ "command": "shutdown" }));
                        let _ = done.try_send(());
                        break;
                    }
                }
            }
        };
        SupervisedBots {
            handle: BotHandle { requests: requests_tx },
            run: BotRun { future: Box::pin(run) },
            events,
        }
    }

    fn answer_for(&self, name: &str, command: Value) -> Result<Value, BotCommandError> {
        let mut script = self.script();
        script.commands.push(command);
        if let Some(answer) = script.answers.get_mut(name).and_then(VecDeque::pop_front) {
            return answer;
        }
        match name {
            "apply_settings" | "set_workspace" => Ok(json!({})),
            "test_channel" => Ok(json!({ "result": { "ok": true } })),
            "list_statuses" | "restart_listeners" => Ok(json!({ "statuses": [] })),
            _ => Err(BotCommandError::Refused(SidecarRefusal {
                code: "failed".into(),
                message: format!("the fake sidecar has no answer for {name}"),
            })),
        }
    }

    /// Answers the next `command` (`test_channel`, `onboarding_poll`, …)
    /// with `fields`, the answer's fields besides `id` and `ok`.
    pub fn answer(&self, command: &str, fields: Value) {
        self.script().answers.entry(command.to_owned()).or_default().push_back(Ok(fields));
    }

    /// Refuses the next `command` with the sidecar's `failed`.
    pub fn refuse(&self, command: &str, message: &str) {
        let refusal = SidecarRefusal { code: "failed".into(), message: message.to_owned() };
        self.script()
            .answers
            .entry(command.to_owned())
            .or_default()
            .push_back(Err(BotCommandError::Refused(refusal)));
    }

    /// Every command so far, as the sidecar would read it (without its id).
    pub fn commands(&self) -> Vec<Value> {
        self.script().commands.clone()
    }

    /// The commands named `name`.
    pub fn commands_named(&self, name: &str) -> Vec<Value> {
        self.commands().into_iter().filter(|command| command["command"] == name).collect()
    }

    /// The Hosts sidecars were launched for, in order.
    pub fn launches(&self) -> Vec<BotHost> {
        self.script().launches.clone()
    }

    /// Delivers `event` from the last sidecar launched.
    pub fn send(&self, event: BotEvent) {
        if let Some(events) = &self.script().events {
            let _ = events.try_send(event);
        }
    }

    /// A status event from its JSON (`{"status": {...}, "conflict"?: ...}`).
    pub fn status(value: Value) -> BotEvent {
        let status: ChannelStatus = serde_json::from_value(value).expect("a channel status");
        BotEvent::Status(status)
    }
}
