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

use super::diagnostics;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Identity;
use maka_config::oauth::ProviderCredential;
use maka_model::ModelError;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::Instrument;

struct RefreshProvider {
    identity: Identity,
    definition: Arc<maka_agent_ports::provider::Definition>,
}
impl RefreshProvider {
    fn identity(&self) -> &Identity {
        &self.identity
    }
    fn prepare_refresh(
        &self,
        connection: Connection,
        credential: maka_agent_facts::provider::Credential,
    ) -> Result<maka_agent_ports::provider::RefreshCall, maka_agent_ports::provider::Error> {
        self.definition.prepare_refresh(connection, credential)
    }
}

mod settlement;
use settlement::State;

/// A root owns refresh coordination. Callers own waiters, not spent grants.
pub struct Authority {
    entries: Mutex<HashMap<String, Arc<Generation>>>,
    workers: TaskTracker,
    shutdown: CancellationToken,
}

#[derive(Clone)]
pub struct Credential {
    generation: Arc<Generation>,
    snapshot: ProviderCredential,
}

struct Generation {
    provider: Identity,
    identity: String,
    state: Arc<AsyncMutex<State>>,
    flight: Arc<Mutex<Option<RefreshWaiter>>>,
    workers: TaskTracker,
    shutdown: CancellationToken,
    superseded: CancellationToken,
}

type RefreshWaiter = watch::Receiver<Option<Result<ProviderCredential, ModelError>>>;

impl Authority {
    pub fn new(workers: TaskTracker, shutdown: CancellationToken) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            workers,
            shutdown,
        }
    }

    /// No network I/O and no waiting for an in-flight refresh.
    pub fn bind(&self, snapshot: ProviderCredential) -> Result<Credential, ModelError> {
        let mut entries = self.entries.lock().unwrap();
        let id = &snapshot.target().connection_id;
        if let Some(existing) = entries.get(id) {
            if existing.identity == snapshot.basis().credential_id
                && existing.provider == snapshot.target().provider
            {
                match existing.state.try_lock() {
                    Err(_) => {
                        return Ok(Credential {
                            generation: existing.clone(),
                            snapshot,
                        });
                    }
                    Ok(state) if state.credential.basis() == snapshot.basis() => {
                        return Ok(Credential {
                            generation: existing.clone(),
                            snapshot,
                        });
                    }
                    Ok(state) if state.credential.basis().revision > snapshot.basis().revision => {
                        return Err(failure("Provider credential observation is outdated"));
                    }
                    Ok(_) => {}
                }
            }
            existing.superseded.cancel();
        }
        let generation = Arc::new(Generation {
            provider: snapshot.target().provider.clone(),
            identity: snapshot.basis().credential_id.clone(),
            state: Arc::new(AsyncMutex::new(State {
                credential: snapshot.clone(),
                outcome: settlement::Outcome::Ready,
            })),
            flight: Arc::new(Mutex::new(None)),
            workers: self.workers.clone(),
            shutdown: self.shutdown.clone(),
            superseded: CancellationToken::new(),
        });
        entries.insert(id.clone(), generation.clone());
        Ok(Credential {
            generation,
            snapshot,
        })
    }
}

impl Credential {
    /// Use the same durable refresh owner for compiled native provider policy.
    pub async fn resolve_native(
        &self,
        identity: Identity,
        definition: Arc<maka_agent_ports::provider::Definition>,
        context: Context,
    ) -> Result<ProviderCredential, ModelError> {
        self.resolve_provider(
            RefreshProvider {
                identity,
                definition,
            },
            context,
        )
        .await
    }

    async fn resolve_provider(
        &self,
        provider: RefreshProvider,
        context: Context,
    ) -> Result<ProviderCredential, ModelError> {
        if provider.identity() != &self.snapshot.target().provider {
            return Err(failure("Provider does not match credential recipient"));
        }
        let connection = Connection {
            id: self.snapshot.target().connection_id.clone(),
            revision: self.snapshot.target().revision,
            configuration: self.snapshot.target().configuration.clone(),
        };
        let resolved = self
            .generation
            .resolve(provider, connection, context)
            .await?;
        // Re-observe through this request's store-bound handle: metadata and
        // routing are per request, while only the login generation is shared.
        let current = self
            .snapshot
            .current_generation()
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "credential_generation_observation",
                    &error,
                    Some(&self.snapshot.target().connection_id),
                );
                failure(error)
            })?
            .ok_or_else(|| failure("Provider credential was superseded"))?;
        if current.basis() != resolved.basis()
            || current.credential() != resolved.credential()
            || current.basis().revision < self.snapshot.basis().revision
        {
            return Err(failure("Provider credential changed during resolution"));
        }
        Ok(current)
    }
}

impl Generation {
    async fn resolve(
        &self,
        provider: RefreshProvider,
        connection: Connection,
        mut context: Context,
    ) -> Result<ProviderCredential, ModelError> {
        if self.shutdown.is_cancelled() || self.superseded.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        let mut receiver = {
            let mut flight = self.flight.lock().unwrap();
            if let Some(receiver) = &*flight {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                *flight = Some(receiver.clone());
                let state = self.state.clone();
                let shutdown = self.shutdown.clone();
                let superseded = self.superseded.clone();
                let flight = self.flight.clone();
                // A cancelled request waiter cannot cancel an accepted exchange.
                context.cancellation = shutdown.child_token();
                let span = tracing::warn_span!("agent_credential_refresh", connection_id = %connection.id,
                    provider = %provider.identity().name);
                self.workers.spawn(
                    async move {
                        let mut state = state.lock().await;
                        let result = if superseded.is_cancelled() {
                            Err(failure("Provider credential was superseded"))
                        } else {
                            state
                                .resolve(provider, connection, context, &shutdown, &superseded)
                                .await
                        };
                        sender.send_replace(Some(result));
                        *flight.lock().unwrap() = None;
                    }
                    .instrument(span),
                );
                receiver
            }
        };
        let result = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| {
                if !self.shutdown.is_cancelled() && !self.superseded.is_cancelled() {
                    tracing::warn!(
                        stage = "credential_refresh_wait",
                        cause = "credential_owner_stopped",
                        "Model preparation failed"
                    );
                }
                failure("Credential owner stopped before settlement")
            })?
            .as_ref()
            .expect("settled result")
            .clone();
        if self.superseded.is_cancelled() {
            return Err(failure("Provider credential was superseded"));
        }
        result
    }
}

fn failure(message: impl ToString) -> ModelError {
    ModelError::Adapter(message.to_string())
}
