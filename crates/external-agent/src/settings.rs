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

use crate::{Agent, conversation::Provider};
use maka_plugins::{
    contributions::{Publisher, Staged},
    executor::{Capabilities, Executor},
    host::Services,
    remote::Error,
    storage::{Data, Directory, Mutation},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub revision: Option<u64>,
    pub agents: Vec<Agent>,
}
pub(crate) struct Manager {
    pub host: Services,
    pub data: Option<Directory>,
    publisher: Publisher,
    state: tokio::sync::Mutex<State>,
}
struct State {
    configuration: Configuration,
    providers: BTreeMap<String, Active>,
    activation_error: Option<String>,
}
struct Active {
    provider: Provider,
    publication: Publication,
}
enum Publication {
    /// Initial descriptors belong to the Fiber's shared staged registration.
    Initial,
    Dynamic(maka_plugins::Registration),
    /// Retain the provider until its resources have confirmed settlement.
    Retired,
}
impl Manager {
    pub async fn agent(&self, id: &str) -> Result<Agent, String> {
        self.state
            .lock()
            .await
            .configuration
            .agents
            .iter()
            .find(|agent| agent.id == id)
            .cloned()
            .ok_or_else(|| "external agent is not configured".into())
    }
    pub async fn load(
        host: Services,
        data: Option<Directory>,
        publisher: Publisher,
        staged: &mut Staged,
    ) -> Result<Arc<Self>, String> {
        let record = host
            .storage
            .read("configuration".into())
            .await
            .map_err(message)?;
        let agents = match record.as_ref().and_then(|record| record.data.value()) {
            Some(value) => serde_json::from_value(value.clone()).map_err(message)?,
            None => vec![],
        };
        validate(&agents)?;
        let mut providers = BTreeMap::new();
        for agent in &agents {
            let provider = Provider::new(agent.clone(), host.clone());
            stage(&provider, staged)?;
            providers.insert(
                agent.id.clone(),
                Active {
                    provider,
                    publication: Publication::Initial,
                },
            );
        }
        Ok(Arc::new(Self {
            host,
            data,
            publisher,
            state: tokio::sync::Mutex::new(State {
                configuration: Configuration {
                    revision: record.map(|record| record.revision),
                    agents,
                },
                providers,
                activation_error: None,
            }),
        }))
    }

    pub async fn read(&self) -> Result<serde_json::Value, String> {
        snapshot(&*self.state.lock().await)
    }

    pub async fn configure(
        &self,
        revision: Option<u64>,
        agents: Vec<Agent>,
    ) -> Result<serde_json::Value, Error> {
        validate(&agents).map_err(Error::Invalid)?;
        let mut state = self.state.lock().await;
        let records = self
            .host
            .storage
            .batch(vec![Mutation {
                key: "configuration".into(),
                expected_revision: revision,
                data: Data::Present(
                    serde_json::to_value(&agents).map_err(|e| Error::Invalid(message(e)))?,
                ),
            }])
            .await
            .map_err(|error| match error {
                maka_plugins::storage::StoreError::OutcomeUnknown(reason) => {
                    state.activation_error = Some("Configuration commit is unconfirmed; reconcile to reload durable desired state".into());
                    Error::OutcomeUnknown(reason)
                }
                other => Error::Provider(message(other)),
            })?;
        let revision = records
            .first()
            .ok_or_else(|| {
                Error::OutcomeUnknown("Configuration commit returned no receipt".into())
            })?
            .revision;
        // Desired state is durable even if activation below fails. Read reports
        // that desired state and the activation issue; reconcile retries without CAS.
        state.configuration = Configuration {
            revision: Some(revision),
            agents,
        };
        self.activate(&mut state).await?;
        snapshot(&state).map_err(Error::Provider)
    }

    pub async fn reconcile(&self) -> Result<serde_json::Value, Error> {
        let mut state = self.state.lock().await;
        let record = self
            .host
            .storage
            .read("configuration".into())
            .await
            .map_err(|error| Error::Provider(message(error)))?;
        let agents: Vec<Agent> = record
            .as_ref()
            .and_then(|record| record.data.value())
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| Error::Invalid(message(error)))?
            .unwrap_or_default();
        validate(&agents).map_err(Error::Invalid)?;
        state.configuration = Configuration {
            revision: record.map(|record| record.revision),
            agents,
        };
        self.activate(&mut state).await?;
        snapshot(&state).map_err(Error::Provider)
    }

    async fn activate(&self, state: &mut State) -> Result<(), Error> {
        state.activation_error =
            Some("Desired configuration is saved; activation is pending".into());
        let desired: BTreeMap<_, _> = state
            .configuration
            .agents
            .iter()
            .map(|agent| (agent.id.clone(), agent.clone()))
            .collect();
        let mut issues = vec![];
        let mut cleanup_failed = false;
        let obsolete: Vec<_> = state
            .providers
            .iter()
            .filter(|(id, active)| {
                matches!(active.publication, Publication::Retired)
                    || desired.get(*id) != Some(&active.provider.agent)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in obsolete {
            let active = state.providers.get_mut(&id).expect("selected provider");
            if matches!(active.publication, Publication::Initial)
                && let Err(error) = self.publisher.withdraw::<Executor>(&id)
            {
                issues.push(format!("{id}: failed to retire registration: {error}"));
                continue;
            }
            // Dropping a dynamic registration retires its captured calls. Initial
            // registrations are withdrawn by name without retiring their siblings.
            if let Publication::Dynamic(registration) =
                std::mem::replace(&mut active.publication, Publication::Retired)
            {
                drop(registration);
            }
            let closed =
                tokio::time::timeout(std::time::Duration::from_secs(5), active.provider.close())
                    .await;
            match closed {
                Ok(Ok(())) => {
                    state.providers.remove(&id);
                }
                other => {
                    cleanup_failed = true;
                    let detail = match other {
                        Ok(Err(error)) => error.to_string(),
                        _ => "cleanup timed out".into(),
                    };
                    issues.push(format!("{id}: resource cleanup is unconfirmed: {detail}"));
                }
            }
        }
        for (id, agent) in desired {
            if state.providers.contains_key(&id) {
                continue;
            }
            let provider = Provider::new(agent, self.host.clone());
            let mut staged = Staged::default();
            if let Err(error) = stage(&provider, &mut staged) {
                issues.push(format!("{id}: {error}"));
                continue;
            }
            // Publication consumes its staging and rolls back on failure; there
            // is no detached registration or live process in this new provider.
            match self.publisher.publish(staged) {
                Ok(registration) => {
                    state.providers.insert(
                        id,
                        Active {
                            provider,
                            publication: Publication::Dynamic(registration),
                        },
                    );
                }
                Err(error) => issues.push(format!("{id}: failed to publish registration: {error}")),
            }
        }
        state.activation_error = (!issues.is_empty()).then(|| issues.join("; "));
        if cleanup_failed {
            return Err(Error::CleanupUnconfirmed);
        }
        match &state.activation_error {
            Some(message) => Err(Error::Provider(format!(
                "Desired configuration is saved; activation failed: {message}"
            ))),
            None => Ok(()),
        }
    }
}

fn snapshot(state: &State) -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(&state.configuration).map_err(message)?;
    if let Some(error) = &state.activation_error {
        value["activationError"] = error.clone().into();
    }
    Ok(value)
}

fn stage(provider: &Provider, staged: &mut Staged) -> Result<(), String> {
    let agent = &provider.agent;
    staged
        .insert(
            agent.id.clone(),
            Executor {
                id: maka_runtime::executor::ExecutorId::try_from(agent.id.clone())
                    .map_err(str::to_owned)?,
                display_name: agent.display_name.clone(),
                capabilities: Capabilities {
                    thinking: true,
                    tool_activity: true,
                    attachments: false,
                    history_copy: false,
                },
                provider: Arc::new(provider.clone()),
            },
        )
        .map_err(message)
}

fn validate(agents: &[Agent]) -> Result<(), String> {
    if agents.len() > 16 {
        return Err("too many external agents".into());
    }
    let mut ids = BTreeSet::new();
    for agent in agents {
        agent.validate().map_err(message)?;
        if !ids.insert(&agent.id) {
            return Err("duplicate external agent identity".into());
        }
    }
    Ok(())
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
