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
const MAX_ENTRIES: usize = 1024;

type Waiter = watch::Receiver<Option<Outcome>>;
struct Entry {
    identity: String,
    catalog_fetched_at: Option<u64>,
    result: Waiter,
}
#[derive(Clone)]
enum Outcome {
    Ready {
        fetched_at: u64,
        hashes: BTreeMap<String, String>,
    },
    Failed {
        retry_at: Instant,
    },
    Superseded,
}

pub(crate) struct Authority {
    entries: Mutex<HashMap<String, Entry>>,
    workers: TaskTracker,
    shutdown: CancellationToken,
}
impl Authority {
    pub fn new(workers: TaskTracker, shutdown: CancellationToken) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            workers,
            shutdown,
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
        let identity = match identity(material) {
            Ok(identity) => identity,
            Err(reason) => {
                tracing::warn!(stage = "codex_inventory_scope", cause = reason, connection_id = %binding.connection_id, "ChatGPT inventory identity unavailable");
                return;
            }
        };
        let mut receiver = {
            let mut entries = self.entries.lock().unwrap();
            if let Some(entry) = entries.get(&binding.connection_id)
                && (entry.result.borrow().is_none()
                    || (entry.identity == identity
                        && reusable(&entry.result.borrow(), now(), Instant::now())
                        && catalog_matches(entry, material, &binding.model)))
            {
                entry.result.clone()
            } else {
                let wall = now();
                let monotonic = Instant::now();
                entries.retain(|_, entry| reusable(&entry.result.borrow(), wall, monotonic));
                if !entries.contains_key(&binding.connection_id) && entries.len() >= MAX_ENTRIES {
                    tracing::warn!(
                        stage = "codex_inventory_capacity",
                        "ChatGPT inventory refresh capacity reached"
                    );
                    return;
                }
                let (sender, receiver) = watch::channel(None);
                entries.insert(
                    binding.connection_id.clone(),
                    Entry {
                        identity: identity.clone(),
                        catalog_fetched_at: material.connection.models_fetched_at,
                        result: receiver.clone(),
                    },
                );
                let shutdown = self.shutdown.clone();
                self.workers.spawn(async move {
                    let cancellation = shutdown.child_token();
                    let result = tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => return,
                        result = tokio::time::timeout(Duration::from_secs(15), refresh(&store, &credentials, definition, &binding, &identity, cancellation.clone())) => result.unwrap_or(Err("discovery_timeout")),
                    };
                    cancellation.cancel();
                    let outcome = match result {
                        Ok(outcome) => outcome,
                        Err(reason) => {
                            tracing::warn!(stage = "codex_inventory_refresh", connection_id = %binding.connection_id, cause = reason, "ChatGPT model inventory refresh failed");
                            Outcome::Failed { retry_at: Instant::now() + Duration::from_secs(fastrand::u64(30..=60)) }
                        }
                    };
                    sender.send_replace(Some(outcome));
                });
                receiver
            }
        };
        // Dropping this future only drops one waiter; the Host tracks the worker.
        while receiver.borrow().is_none() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
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
            let entries = self.entries.lock().unwrap();
            let entry = entries.get(&material.connection.connection_id)?;
            if entry.identity != identity {
                return None;
            }
            let result = entry.result.borrow();
            let Outcome::Ready { fetched_at, hashes } = result.as_ref()? else {
                return None;
            };
            let time = now()?;
            if *fetched_at > time
                || time - fetched_at >= MAX_AGE
                || material.connection.models_fetched_at != Some(*fetched_at)
            {
                return None;
            }
            let hash = hashes.get(model)?;
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
                fetched_at: *fetched_at,
            })
        });
        CodexRequestProvenance {
            connection_id: material.connection.connection_id.clone(),
            account_id,
            compatibility,
        }
    }
}

fn catalog_matches(entry: &Entry, material: &ConnectionObservation, model: &str) -> bool {
    match entry.result.borrow().as_ref() {
        Some(Outcome::Ready { fetched_at, hashes }) => {
            material.connection.models_fetched_at == Some(*fetched_at)
                && hashes.get(model)
                    == material
                        .connection
                        .models
                        .iter()
                        .find(|row| row.id == model)
                        .and_then(|row| row.codex_compaction_hash.as_ref())
        }
        _ => entry.catalog_fetched_at == material.connection.models_fetched_at,
    }
}

fn reusable(result: &Option<Outcome>, wall: Option<u64>, monotonic: Instant) -> bool {
    match result {
        None => true,
        Some(Outcome::Ready { fetched_at, .. }) => {
            wall.is_some_and(|now| *fetched_at <= now && now - fetched_at < REFRESH_AT)
        }
        Some(Outcome::Failed { retry_at }) => monotonic < *retry_at,
        Some(Outcome::Superseded) => false,
    }
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
    store: &Arc<ConfigurationStore>,
    credentials: &Credentials,
    definition: Arc<Definition>,
    binding: &ModelBinding,
    expected_identity: &str,
    cancellation: CancellationToken,
) -> Result<Outcome, &'static str> {
    // Recheck canonical identity after joining the shared task, before provider I/O.
    let material = store
        .observe_model(binding.clone())
        .await
        .map_err(|_| "configuration_read")?
        .ok_or("connection_unavailable")?;
    if identity(&material)? != expected_identity {
        return Ok(Outcome::Superseded);
    }
    let ModelFetchPreparation::Ready(mut ticket) = store
        .prepare_model_fetch(&binding.connection_id)
        .await
        .map_err(|_| "discovery_prepare")?
    else {
        return Ok(Outcome::Superseded);
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
    let fetched_at = now().ok_or("clock_unavailable")?;
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
        ConnectionModelFetchResult::Committed { .. } => Ok(Outcome::Ready { fetched_at, hashes }),
        ConnectionModelFetchResult::Superseded { .. } => Ok(Outcome::Superseded),
        ConnectionModelFetchResult::Rejected { .. } => Err("discovery_rejected"),
        ConnectionModelFetchResult::Failed { .. } => Err("discovery_failed"),
    }
}

#[cfg(test)]
mod tests;
