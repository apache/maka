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

use crate::ports::Ports;
use crate::{Agent, Error, digest, driver::Driver, transport::Connection};
use agent_client_protocol::v1::schema as acp;
use maka_agent_ports::executor;
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Store;
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
        task_id: maka_agent_facts::durable::ExternalTaskId,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    configuration: String,
    cwd: String,
    pub state: State,
    pub defaults: Vec<acp::SessionConfigOption>,
    #[serde(default)]
    pub v2_defaults: Option<Vec<agent_client_protocol::v2::schema::SessionConfigOption>>,
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
    async fn read(host: &Ports, agent: &Agent, request: &executor::Request) -> Result<Self, Error> {
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
                v2_defaults: None,
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
            v2_defaults: self.record.v2_defaults.clone(),
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
    pub v2_options: Option<Vec<agent_client_protocol::v2::schema::SessionConfigOption>>,
}

type Slot = Arc<tokio::sync::Mutex<Option<Live>>>;
#[derive(Clone)]
pub struct Provider {
    pub(crate) agent: Agent,
    pub(crate) host: Ports,
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
    pub fn new(agent: Agent, host: Ports) -> Self {
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
            self.host
                .processes
                .spawn(scope.clone(), self.agent.command())
                .await
        }?;
        let restored = slot.take();
        let mut cleanup = None;
        let mut driver = Driver::new(&self.host, &request, &context);
        let result = async {
            let mut live = match restored {
                Some(mut live) => {
                    live.connection.rebind(handle)?;
                    cleanup = Some(live.connection.owner.clone());
                    live
                }
                None => {
                    let connection = Connection::new(
                        self.host.clone(),
                        scope,
                        self.agent.command(),
                        handle,
                        true,
                    );
                    cleanup = Some(connection.owner.clone());
                    driver.connect(connection, &mut journal).await?
                }
            };
            let outcome = driver.prompt(&mut live, &mut journal).await?;
            *slot = Some(live);
            Ok(outcome)
        }
        .await;
        let business_kind = result.as_ref().err().map_or("Ok", failure_kind);
        eprintln!("acp engine: stage=engine_business_return error_kind={business_kind}");
        if result.is_err() {
            // A lost connection can leave the remote prompt uncertain. The journal
            // remains Running, so another activation cannot silently duplicate it.
            if let Some(cleanup) = cleanup
                && let Err(error) = cleanup.close().await
            {
                // The process port retains the original custody on failed close.
                eprintln!(
                    "acp engine: stage=engine_cleanup_return error_kind={} business_preserved=true",
                    failure_kind(&error)
                );
            }
        }
        result
    }
}

fn failure_kind(error: &Error) -> &'static str {
    match error {
        Error::Sdk(_) => "Sdk",
        Error::Process(maka_capabilities::process::Error::Denied) => "ProcessDenied",
        Error::Process(maka_capabilities::process::Error::Invalid(_)) => "ProcessInvalid",
        Error::Process(maka_capabilities::process::Error::Failed(_)) => "ProcessFailed",
        Error::Process(maka_capabilities::process::Error::CleanupUnconfirmed(_)) => {
            "ProcessCleanupUnconfirmed"
        }
        Error::Storage(_) => "Storage",
        Error::Output(_) => "Output",
        Error::Decode(_) => "Decode",
        Error::Continuity(_) => "Continuity",
        Error::Timeout => "Timeout",
        Error::Cancelled => "Cancelled",
        Error::Invalid(_) => "Invalid",
        Error::RejectedBeforePrompt(_) => "RejectedBeforePrompt",
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
            let result = Provider::execute(&provider, request, context).await;
            {
                let error_kind = result.as_ref().err().map_or("Ok", failure_kind);
                eprintln!("acp engine: stage=engine_provider_return error_kind={error_kind}");
            }
            match result {
                Ok(outcome) => Ok(outcome),
                Err(Error::Output(error)) => Err(error),
                Err(Error::Process(maka_capabilities::process::Error::CleanupUnconfirmed(_))) => {
                    Err(executor::Error::CleanupUnconfirmed)
                }
                Err(error @ Error::RejectedBeforePrompt(_)) => Ok(executor::Outcome::Failed {
                    code: Some("external_agent_prompt_rejected".into()),
                    message: error.to_string(),
                    recoverable: false,
                }),
                // Transport and observer errors cannot establish the original
                // agent's business outcome, even if its process has exited.
                Err(error) => Err(executor::Error::Provider(error.to_string())),
            }
        })
    }
}
