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

//! Host-owned ChatGPT account inventory. Waiters do not own shared discovery work.

use super::{Credentials, connection};
use maka_agent_facts::{
    configuration::ConnectionModelFetchResult,
    context::{CodexCompatibility, CodexRequestProvenance},
    execution::ModelBinding,
};
use maka_agent_ports::provider::{Context, Definition, Discovery};
use maka_config::{ConfigurationStore, ConnectionObservation, model_fetch::ModelFetchPreparation};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const MAX_AGE: u64 = 300;
const REFRESH_AT: u64 = 270;

type Waiter = watch::Receiver<bool>;

#[derive(Clone)]
struct Ready {
    identity: String,
    connection_revision: u64,
    fetched_at: u64,
    hashes: BTreeMap<String, String>,
}

struct Flight {
    id: u64,
    identity: String,
    result: Waiter,
}

#[derive(Default)]
struct Entry {
    ready: Option<Ready>,
    previous_ready: Option<Ready>,
    failed: Option<(String, Option<u64>, Instant)>,
    flight: Option<Flight>,
}

#[derive(Default)]
struct State {
    next_flight: u64,
    entries: HashMap<String, Entry>,
}

enum Refreshed {
    Ready {
        connection_revision: u64,
        fetched_at: u64,
        hashes: BTreeMap<String, String>,
    },
    Superseded,
}

pub(crate) struct Authority {
    state: Mutex<State>,
    workers: TaskTracker,
    shutdown: CancellationToken,
    #[cfg(test)]
    clock: Mutex<Option<u64>>,
}
impl Authority {
    pub fn new(workers: TaskTracker, shutdown: CancellationToken) -> Self {
        Self {
            state: Mutex::new(State::default()),
            workers,
            shutdown,
            #[cfg(test)]
            clock: Mutex::new(None),
        }
    }

    pub fn warm(
        self: &Arc<Self>,
        store: Arc<ConfigurationStore>,
        credentials: Credentials,
        definition: Arc<Definition>,
        binding: ModelBinding,
        material: &ConnectionObservation,
    ) {
        if self.shutdown.is_cancelled() {
            return;
        }
        if let Ok(scope) = identity(material) {
            let _ = self.schedule(
                &store,
                &credentials,
                &definition,
                &binding,
                material,
                &scope,
            );
        }
    }

    pub async fn ensure(
        self: &Arc<Self>,
        store: Arc<ConfigurationStore>,
        credentials: Credentials,
        definition: Arc<Definition>,
        binding: ModelBinding,
        material: &ConnectionObservation,
    ) {
        if self.shutdown.is_cancelled() {
            return;
        }
        let scope = match identity(material) {
            Ok(identity) => identity,
            Err(reason) => {
                tracing::warn!(stage = "codex_inventory_scope", cause = reason, connection_id = %binding.connection_id, "ChatGPT inventory identity unavailable");
                return;
            }
        };
        let mut refreshed = None;
        loop {
            let current_material = refreshed.as_ref().unwrap_or(material);
            let Some((mut receiver, joined_other_identity)) = self.schedule(
                &store,
                &credentials,
                &definition,
                &binding,
                current_material,
                &scope,
            ) else {
                return;
            };
            // Dropping this future only drops one waiter; the Host tracks the worker.
            while !*receiver.borrow() {
                if receiver.changed().await.is_err() {
                    return;
                }
            }
            if !joined_other_identity || self.shutdown.is_cancelled() {
                return;
            }
            // Recheck freshness after waiting for another identity's lane.
            let current = match store.observe_model(binding.clone()).await {
                Ok(Some(current)) => current,
                _ => return,
            };
            if identity(&current).as_ref() != Ok(&scope) {
                return;
            }
            refreshed = Some(current);
        }
    }

    fn schedule(
        self: &Arc<Self>,
        store: &Arc<ConfigurationStore>,
        credentials: &Credentials,
        definition: &Arc<Definition>,
        binding: &ModelBinding,
        material: &ConnectionObservation,
        scope: &str,
    ) -> Option<(Waiter, bool)> {
        let wall = self.now();
        let monotonic = Instant::now();
        let mut state = self.state.lock().unwrap();
        state
            .entries
            .retain(|_, entry| retain_entry(entry, wall, monotonic));
        let flight_id = {
            let entry = state.entries.get(&binding.connection_id);
            let fresh = entry
                .and_then(|entry| entry.ready.as_ref())
                .is_some_and(|ready| {
                    valid_ready(ready, scope, material, &binding.model, wall, REFRESH_AT)
                });
            let usable = fresh
                || entry
                    .and_then(|entry| entry.ready.as_ref())
                    .is_some_and(|ready| {
                        valid_ready(ready, scope, material, &binding.model, wall, MAX_AGE)
                    });
            if let Some(flight) = entry
                .and_then(|entry| entry.flight.as_ref())
                .filter(|flight| !*flight.result.borrow())
            {
                return (!usable).then(|| (flight.result.clone(), flight.identity != scope));
            }
            if fresh
                || entry.is_some_and(|entry| backed_off(&entry.failed, scope, material, monotonic))
            {
                return None;
            }
            state.next_flight += 1;
            (state.next_flight, usable)
        };
        let (id, usable) = flight_id;
        let (sender, receiver) = watch::channel(false);
        let entry = state
            .entries
            .entry(binding.connection_id.clone())
            .or_default();
        entry.flight = Some(Flight {
            id,
            identity: scope.to_owned(),
            result: receiver.clone(),
        });
        let authority = Arc::clone(self);
        let shutdown = self.shutdown.clone();
        let store = store.clone();
        let credentials = credentials.clone();
        let definition = definition.clone();
        let binding = binding.clone();
        let identity = scope.to_owned();
        let catalog_fetched_at = material.connection.models_fetched_at;
        self.workers.spawn(async move {
            let cancellation = shutdown.child_token();
            let result = tokio::select! {
                biased;
                _ = shutdown.cancelled() => return,
                result = tokio::time::timeout(
                    Duration::from_secs(15),
                    refresh(&authority, &store, &credentials, definition, &binding, &identity, cancellation.clone()),
                ) => result.unwrap_or(Err("discovery_timeout")),
            };
            cancellation.cancel();
            let wall = authority.now();
            let mut state = authority.state.lock().unwrap();
            if let Some(entry) = state.entries.get_mut(&binding.connection_id) {
                if entry.flight.as_ref().is_some_and(|flight| flight.id == id) {
                    entry.flight = None;
                }
                match result {
                    Ok(Refreshed::Ready {
                        connection_revision,
                        fetched_at,
                        hashes,
                    }) => {
                        if let Some(previous) = entry.ready.take()
                            && within_ttl(previous.fetched_at, wall, MAX_AGE)
                        {
                            entry.previous_ready = Some(previous);
                        } else {
                            entry.previous_ready = None;
                        }
                        entry.ready = Some(Ready {
                            identity,
                            connection_revision,
                            fetched_at,
                            hashes,
                        });
                        entry.failed = None;
                    }
                    Ok(Refreshed::Superseded) => {}
                    Err(reason) => {
                        tracing::warn!(stage = "codex_inventory_refresh", connection_id = %binding.connection_id, cause = reason, "ChatGPT model inventory refresh failed");
                        entry.failed = Some((
                            identity,
                            catalog_fetched_at,
                            Instant::now() + Duration::from_secs(fastrand::u64(30..=60)),
                        ));
                    }
                }
            }
            sender.send_replace(true);
        });
        (!usable).then_some((receiver, false))
    }

    pub fn provenance(
        &self,
        material: &ConnectionObservation,
        model: &str,
    ) -> CodexRequestProvenance {
        let account_id = material.credential.as_ref().and_then(|value| {
            maka_providers::codex::credential_account_id(value.credential())
                .ok()
                .flatten()
        });
        let compatibility = identity(material).ok().and_then(|identity| {
            let time = self.now()?;
            let state = self.state.lock().unwrap();
            let entry = state.entries.get(&material.connection.connection_id)?;
            let ready = [entry.ready.as_ref(), entry.previous_ready.as_ref()]
                .into_iter()
                .flatten()
                .find(|ready| {
                    ready.identity == identity
                        && material.connection.revision >= ready.connection_revision
                        && within_ttl(ready.fetched_at, Some(time), MAX_AGE)
                        && material.connection.models_fetched_at == Some(ready.fetched_at)
                })?;
            let hash = ready.hashes.get(model)?;
            if material
                .connection
                .models
                .iter()
                .find(|row| row.id == model)?
                .codex_compaction_hash
                .as_ref()
                != Some(hash)
            {
                return None;
            }
            Some(CodexCompatibility {
                comp_hash: hash.clone(),
                fetched_at: ready.fetched_at,
            })
        });
        CodexRequestProvenance {
            connection_id: material.connection.connection_id.clone(),
            account_id,
            compatibility,
        }
    }

    fn now(&self) -> Option<u64> {
        #[cfg(test)]
        if let Some(clock) = *self.clock.lock().unwrap() {
            return Some(clock);
        }
        now()
    }
}

fn within_ttl(fetched_at: u64, wall: Option<u64>, limit: u64) -> bool {
    wall.is_some_and(|now| fetched_at <= now && now - fetched_at < limit)
}

fn valid_ready(
    ready: &Ready,
    identity: &str,
    material: &ConnectionObservation,
    model: &str,
    wall: Option<u64>,
    limit: u64,
) -> bool {
    ready.identity == identity
        && within_ttl(ready.fetched_at, wall, limit)
        && catalog_matches(ready, material, model)
}

fn catalog_matches(ready: &Ready, material: &ConnectionObservation, model: &str) -> bool {
    material.connection.revision < ready.connection_revision
        || (material.connection.models_fetched_at == Some(ready.fetched_at)
            && ready.hashes.get(model)
                == material
                    .connection
                    .models
                    .iter()
                    .find(|row| row.id == model)
                    .and_then(|row| row.codex_compaction_hash.as_ref()))
}

fn backed_off(
    failed: &Option<(String, Option<u64>, Instant)>,
    identity: &str,
    material: &ConnectionObservation,
    monotonic: Instant,
) -> bool {
    failed
        .as_ref()
        .is_some_and(|(failed_identity, catalog_fetched_at, retry_at)| {
            failed_identity == identity
                && *catalog_fetched_at == material.connection.models_fetched_at
                && monotonic < *retry_at
        })
}

fn retain_entry(entry: &Entry, wall: Option<u64>, monotonic: Instant) -> bool {
    entry
        .flight
        .as_ref()
        .is_some_and(|flight| !*flight.result.borrow())
        || entry
            .ready
            .as_ref()
            .is_some_and(|ready| within_ttl(ready.fetched_at, wall, MAX_AGE))
        || entry
            .previous_ready
            .as_ref()
            .is_some_and(|ready| within_ttl(ready.fetched_at, wall, MAX_AGE))
        || entry
            .failed
            .as_ref()
            .is_some_and(|(_, _, retry_at)| monotonic < *retry_at)
}

fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs())
}

fn identity(material: &ConnectionObservation) -> Result<String, &'static str> {
    let credential = material
        .credential
        .as_ref()
        .ok_or("credential_unavailable")?;
    let account = maka_providers::codex::credential_account_id(credential.credential())
        .map_err(|_| "credential_invalid")?;
    let encoded = serde_json::to_vec(&(
        &material.connection.provider,
        &material.connection.configuration,
        &credential.basis().credential_id,
        account,
        &material.request_headers,
        &material.network.proxy,
        &material.network.password,
        &material.connection.enabled_model_ids,
    ))
    .map_err(|_| "identity_invalid")?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(encoded))))
}

async fn refresh(
    authority: &Authority,
    store: &Arc<ConfigurationStore>,
    credentials: &Credentials,
    definition: Arc<Definition>,
    binding: &ModelBinding,
    expected_identity: &str,
    cancellation: CancellationToken,
) -> Result<Refreshed, &'static str> {
    // Recheck canonical identity after joining the shared task, before provider I/O.
    let material = store
        .observe_model(binding.clone())
        .await
        .map_err(|_| "configuration_read")?
        .ok_or("connection_unavailable")?;
    if identity(&material)? != expected_identity {
        return Ok(Refreshed::Superseded);
    }
    let ModelFetchPreparation::Ready(mut ticket) = store
        .prepare_model_fetch(&binding.connection_id)
        .await
        .map_err(|_| "discovery_prepare")?
    else {
        return Ok(Refreshed::Superseded);
    };
    let network = ticket.network_configuration();
    let policy =
        maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
            .map_err(|_| "network_policy")?;
    let transport = credentials
        .executor
        .transport(&policy)
        .map_err(|_| "discovery_transport")?;
    let context = Context {
        transport,
        cancellation,
        interaction: None,
    };
    let snapshot = ticket
        .provider_credential()
        .map_err(|_| "credential_read")?
        .ok_or("credential_unavailable")?;
    let resolved = credentials
        .refresh
        .bind(snapshot)
        .map_err(|_| "credential_binding")?
        .resolve_native(
            material.connection.provider.clone(),
            definition.clone(),
            context.clone(),
        )
        .await
        .map_err(|_| "credential_resolution")?;
    let credential = resolved.credential().clone();
    ticket
        .accept_credential(resolved)
        .map_err(|_| "credential_superseded")?;
    let request_headers = ticket
        .request_headers()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "request_headers")?
        .unwrap_or_default();
    let models = definition
        .discover(
            Discovery {
                connection: connection(ticket.connection()),
                credential: Some(credential),
                request_headers,
            },
            context,
        )
        .await
        .map_err(|_| "provider_discovery")?;
    let fetched_at = authority.now().ok_or("clock_unavailable")?;
    let hashes = models
        .iter()
        .filter_map(|model| {
            model
                .codex_compaction_hash
                .clone()
                .map(|hash| (model.id.clone(), hash))
        })
        .collect();
    match ticket
        .complete(models, fetched_at)
        .await
        .map_err(|_| "discovery_commit")?
    {
        ConnectionModelFetchResult::Committed { connection, .. } => Ok(Refreshed::Ready {
            connection_revision: connection.revision,
            fetched_at,
            hashes,
        }),
        ConnectionModelFetchResult::Superseded { .. } => Ok(Refreshed::Superseded),
        ConnectionModelFetchResult::Rejected { .. } => Err("discovery_rejected"),
        ConnectionModelFetchResult::Failed { .. } => Err("discovery_failed"),
    }
}

#[cfg(test)]
mod tests;
