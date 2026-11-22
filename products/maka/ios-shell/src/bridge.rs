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

//! Native Rust bridge backing the iOS shell's nsh/host channel.
//!
//! Owns the persistent device peer identity, saved Host profiles, mode-0600
//! remote credentials, PairingTicketV1 decoding + 6-digit SAS verification,
//! and the active remote Maka Host WebSocket connection.

use maka_remote_client::{
    HostViewFilter, OpenStream, PAIRING_URI_PREFIX, PairingTicketV1, RemoteHostClient,
    RemoteHostConnection, SavedHostProfile, SavedHostStore, tcp_endpoint_opener,
};
use nsh_engine::{HostCall, HostChannel};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;
use tokio::{runtime::Handle, sync::Mutex};
use uuid::Uuid;

/// Explicit nsh/host allowlist declared by the iOS shell UI bundle.
pub const ALLOWED_HOST_CALLS: &[&str] = &[
    "ios.bootstrap",
    "ios.parseTicket",
    "ios.pairHost",
    "ios.connectHost",
    "ios.disconnectHost",
    "ios.removeHost",
    "ios.setFilter",
    "ios.hostCall",
];

/// Factory turning a Host endpoint URL into a transport stream opener.
pub type EndpointOpener = Arc<dyn Fn(&str) -> Result<OpenStream, String> + Send + Sync>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentityFile {
    device_peer_id: String,
    client_instance: String,
}

#[derive(Default, Serialize, Deserialize)]
struct CredentialStoreFile {
    credentials: BTreeMap<String, String>,
}

struct ActiveConnection {
    root_id: String,
    host_name: String,
    connection: RemoteHostConnection,
}

struct BridgeState {
    support_dir: PathBuf,
    device_peer_id: String,
    client_instance: String,
    store: SavedHostStore,
    credentials: BTreeMap<String, String>,
    active: Option<ActiveConnection>,
    /// Monotonic generation fencing in-flight connect/pair operations against
    /// concurrent disconnect, remove, or newer connect requests.
    connection_epoch: u64,
}

/// Shared handle to the attached iOS native bridge.
#[derive(Clone)]
pub struct HostBridge {
    state: Arc<Mutex<BridgeState>>,
    /// Serializes blocking disk commits without blocking state reads or RPCs.
    persist_gate: Arc<Mutex<()>>,
    opener: EndpointOpener,
    channel: HostChannel,
    runtime: Handle,
}

impl HostBridge {
    /// Load persisted iOS shell state under support_dir and attach all handlers
    /// plus deep-link interception to channel.
    pub fn attach(
        channel: HostChannel,
        support_dir: impl Into<PathBuf>,
        runtime: Handle,
    ) -> Result<Self, String> {
        let default_opener: EndpointOpener =
            Arc::new(|endpoint| tcp_endpoint_opener(endpoint).map_err(|err| err.to_string()));
        Self::attach_with_opener(channel, support_dir, runtime, default_opener)
    }

    /// Attach using a custom transport stream opener (e.g. P2P Mesh carrier or
    /// deterministic test transport).
    pub fn attach_with_opener(
        channel: HostChannel,
        support_dir: impl Into<PathBuf>,
        runtime: Handle,
        opener: EndpointOpener,
    ) -> Result<Self, String> {
        let support_dir = support_dir.into();
        fs::create_dir_all(&support_dir).map_err(|err| format!("create support dir: {err}"))?;
        let identity = load_or_create_device_identity(&support_dir.join("device-identity.json"))?;
        let store = SavedHostStore::load_or_create(support_dir.join("saved-hosts.json"))
            .map_err(|err| err.to_string())?;
        let credentials = load_credentials(&support_dir.join("credentials.json"))?;

        let bridge = Self {
            state: Arc::new(Mutex::new(BridgeState {
                support_dir,
                device_peer_id: identity.device_peer_id,
                client_instance: identity.client_instance,
                store,
                credentials,
                active: None,
                connection_epoch: 0,
            })),
            persist_gate: Arc::new(Mutex::new(())),
            opener,
            channel: channel.clone(),
            runtime,
        };

        bridge.register_handlers(&channel);
        Ok(bridge)
    }

    fn register_handlers(&self, channel: &HostChannel) {
        self.register_async(channel, "ios.bootstrap", |bridge, _data| async move {
            bridge.bootstrap().await
        });
        self.register_async(channel, "ios.parseTicket", |bridge, data| async move {
            bridge.parse_ticket(data).await
        });
        self.register_async(channel, "ios.pairHost", |bridge, data| async move {
            bridge.pair_host(data).await
        });
        self.register_async(channel, "ios.connectHost", |bridge, data| async move {
            bridge.connect_host(data).await
        });
        self.register_async(channel, "ios.disconnectHost", |bridge, _data| async move {
            bridge.disconnect_host().await
        });
        self.register_async(channel, "ios.removeHost", |bridge, data| async move {
            bridge.remove_host(data).await
        });
        self.register_async(channel, "ios.setFilter", |bridge, data| async move {
            bridge.set_filter(data).await
        });
        self.register_async(channel, "ios.hostCall", |bridge, data| async move {
            bridge.host_call(data).await
        });

        let link_channel = channel.clone();
        channel.handle_open_url(move |request| {
            let url = request.url().to_owned();
            if url.trim().starts_with(PAIRING_URI_PREFIX) {
                let _ = link_channel.send("ios.pairingUri", json!({ "uri": url }));
                request.handled();
            } else {
                request.decline();
            }
        });
    }

    fn register_async<F, Fut>(&self, channel: &HostChannel, name: &'static str, handler: F)
    where
        F: Fn(HostBridge, Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Value, String>> + Send + 'static,
    {
        let bridge = self.clone();
        let handler = Arc::new(handler);
        channel.handle(name, move |mut call: HostCall| {
            let data = call.take_data();
            let bridge = bridge.clone();
            let runtime = bridge.runtime.clone();
            let handler = handler.clone();
            runtime.spawn(async move {
                let result = handler(bridge, data).await;
                call.reply(result);
            });
        });
    }

    fn emit_state_snapshot(&self, snapshot: Value) {
        let _ = self.channel.send("ios.hostState", snapshot);
    }

    fn snapshot_locked(state: &BridgeState) -> Value {
        let hosts: Vec<Value> = state
            .store
            .hosts()
            .map(|host| {
                let connected = state
                    .active
                    .as_ref()
                    .is_some_and(|a| a.root_id == host.root_id());
                json!({
                    "rootId": host.root_id(),
                    "hostName": host.host_name(),
                    "peerId": host.peer_id(),
                    "endpoints": host.endpoints(),
                    "credentialId": host.credential_id(),
                    "lastConnectedAtMs": host.last_connected_at_ms(),
                    "collapsedInAllView": host.collapsed_in_all_view(),
                    "connected": connected,
                    "hasCredential": state.credentials.contains_key(host.root_id()),
                })
            })
            .collect();
        let active = state.active.as_ref().map(|a| {
            json!({
                "rootId": a.root_id,
                "hostName": a.host_name,
                "epoch": a.connection.epoch().to_string(),
                "session": a.connection.session().to_string(),
                "endpoints": a.connection.endpoint_names(),
            })
        });
        json!({
            "devicePeerId": state.device_peer_id,
            "filter": state.store.filter(),
            "hosts": hosts,
            "active": active,
        })
    }

    /// Inspect current bridge state (usable both via nsh/host and Rust tests).
    pub async fn bootstrap(&self) -> Result<Value, String> {
        let state = self.state.lock().await;
        Ok(Self::snapshot_locked(&state))
    }

    pub async fn parse_ticket(&self, data: Value) -> Result<Value, String> {
        let uri = require_string(&data, "uri")?;
        let now_ms = now_epoch_ms()?;
        let ticket = PairingTicketV1::decode_uri(&uri, now_ms).map_err(|err| err.to_string())?;
        let device_peer_id = self.state.lock().await.device_peer_id.clone();
        let sas_code = ticket
            .short_auth_code(&device_peer_id)
            .map_err(|err| err.to_string())?;
        Ok(json!({
            "rootId": ticket.root_id(),
            "hostName": ticket.host_name(),
            "peerId": ticket.peer_id(),
            "endpoints": ticket.endpoints(),
            "nonce": ticket.nonce(),
            "expiresAtMs": ticket.expires_at_ms(),
            "sasCode": sas_code,
            "devicePeerId": device_peer_id,
        }))
    }

    pub async fn pair_host(&self, data: Value) -> Result<Value, String> {
        let uri = require_string(&data, "uri")?;
        let now_ms = now_epoch_ms()?;
        let ticket = PairingTicketV1::decode_uri(&uri, now_ms).map_err(|err| err.to_string())?;
        let credential_id = credential_fingerprint(ticket.pairing_token());
        let profile = SavedHostProfile::new(
            ticket.root_id(),
            ticket.host_name(),
            ticket.peer_id(),
            ticket.endpoints().to_vec(),
            credential_id,
            Some(now_ms),
            false,
        )
        .map_err(|err| err.to_string())?;

        // Fail closed on pinned Peer ID mismatch BEFORE any network finalize or
        // disk write takes place.
        let (client_instance, device_peer_id, my_epoch) = {
            let mut state = self.state.lock().await;
            state
                .store
                .check_peer_for_root(profile.root_id(), profile.peer_id())
                .map_err(|err| err.to_string())?;
            state.connection_epoch = state.connection_epoch.wrapping_add(1);
            (
                state.client_instance.clone(),
                state.device_peer_id.clone(),
                state.connection_epoch,
            )
        };
        let sas_code = ticket
            .short_auth_code(&device_peer_id)
            .map_err(|err| err.to_string())?;

        let endpoint = ticket
            .endpoints()
            .iter()
            .find(|ep| ep.trim().starts_with("ws://"))
            .or_else(|| ticket.endpoints().first())
            .ok_or_else(|| "pairing ticket has no endpoints".to_owned())?;
        let opener = (self.opener)(endpoint)?;

        // 1. Exchange one-time pairing credential on the remote Host (lock-free).
        RemoteHostClient::finalize_access(opener.clone(), ticket.pairing_token(), &client_instance)
            .await
            .map_err(|err| err.to_string())?;

        // 2. Connect and enforce fail-closed Root ID admission (lock-free).
        let bearer: Arc<str> = ticket.pairing_token().to_owned().into();
        let connection =
            RemoteHostClient::connect(opener, bearer, ticket.root_id(), client_instance.into())
                .await
                .map_err(|err| err.to_string())?;

        // 3. Serialize atomic two-file commit off Tokio runtime threads, with
        //    automatic rollback if either write fails. The persist_gate guard
        //    is strictly scoped to disk+memory commit and ALWAYS dropped before
        //    any network close().await.
        let commit_outcome: Result<
            (
                Option<ActiveConnection>,
                Option<RemoteHostConnection>,
                Value,
            ),
            (String, RemoteHostConnection),
        > = {
            let _persist_guard = self.persist_gate.lock().await;
            let staged = {
                let state = self.state.lock().await;
                if state.connection_epoch != my_epoch {
                    Err("pairing cancelled by a newer connection operation".to_owned())
                } else {
                    state
                        .store
                        .stage_upsert_paired_host(profile)
                        .map_err(|err| err.to_string())
                        .map(|next_store| {
                            let old_creds = state.credentials.clone();
                            let mut next_creds = old_creds.clone();
                            next_creds.insert(
                                ticket.root_id().to_owned(),
                                ticket.pairing_token().to_owned(),
                            );
                            (
                                state.support_dir.join("credentials.json"),
                                old_creds,
                                next_creds,
                                next_store,
                            )
                        })
                }
            };
            let (cred_path, old_creds, next_creds, next_store) = match staged {
                Ok(v) => v,
                Err(err) => {
                    drop(_persist_guard);
                    close_with_warning(connection, ticket.root_id()).await;
                    return Err(err);
                }
            };

            let store_for_disk = next_store.clone();
            let creds_for_disk = next_creds.clone();
            let persist_result = tokio::task::spawn_blocking(move || {
                commit_store_and_credentials(
                    &cred_path,
                    &old_creds,
                    &creds_for_disk,
                    &store_for_disk,
                )
            })
            .await
            .map_err(|err| format!("persist paired host task failed: {err}"))
            .and_then(|res| res);

            match persist_result {
                Err(err) => Err((err, connection)),
                Ok(()) => {
                    let mut state = self.state.lock().await;
                    state.store = next_store;
                    state.credentials = next_creds;
                    if state.connection_epoch != my_epoch {
                        let snap = Self::snapshot_locked(&state);
                        Ok((None, Some(connection), snap))
                    } else {
                        let prev = state.active.replace(ActiveConnection {
                            root_id: ticket.root_id().to_owned(),
                            host_name: ticket.host_name().to_owned(),
                            connection,
                        });
                        let snap = Self::snapshot_locked(&state);
                        Ok((prev, None, snap))
                    }
                }
            }
        };

        let (previous_active, discarded_new, snapshot) = match commit_outcome {
            Ok(v) => v,
            Err((err, conn)) => {
                close_with_warning(conn, ticket.root_id()).await;
                return Err(err);
            }
        };

        self.emit_state_snapshot(snapshot.clone());
        if let Some(discarded) = discarded_new {
            close_with_warning(discarded, ticket.root_id()).await;
            return Err(
                "host was paired and saved, but its active connection was cancelled".to_owned(),
            );
        }
        if let Some(prev) = previous_active {
            close_with_warning(prev.connection, &prev.root_id).await;
        }

        Ok(json!({
            "sasCode": sas_code,
            "state": snapshot,
        }))
    }

    pub async fn connect_host(&self, data: Value) -> Result<Value, String> {
        let root_id = require_string(&data, "rootId")?;
        let (profile, bearer, client_instance, my_epoch) = {
            let mut state = self.state.lock().await;
            let profile = state
                .store
                .get(&root_id)
                .cloned()
                .ok_or_else(|| format!("unknown saved host '{root_id}'"))?;
            let bearer = state
                .credentials
                .get(&root_id)
                .cloned()
                .ok_or_else(|| format!("missing stored credential for host '{root_id}'"))?;
            state.connection_epoch = state.connection_epoch.wrapping_add(1);
            (
                profile,
                bearer,
                state.client_instance.clone(),
                state.connection_epoch,
            )
        };

        let endpoint = profile
            .endpoints()
            .iter()
            .find(|ep| ep.trim().starts_with("ws://"))
            .or_else(|| profile.endpoints().first())
            .ok_or_else(|| "saved host has no endpoints".to_owned())?;
        let opener = (self.opener)(endpoint)?;
        let connection = RemoteHostClient::connect(
            opener,
            bearer.into(),
            profile.root_id(),
            client_instance.into(),
        )
        .await
        .map_err(|err| err.to_string())?;

        let (prev, discarded, snapshot) = {
            let mut state = self.state.lock().await;
            let superseded =
                state.connection_epoch != my_epoch || state.store.get(&root_id).is_none();
            if superseded {
                (None, Some(connection), Self::snapshot_locked(&state))
            } else {
                let prev = state.active.replace(ActiveConnection {
                    root_id: profile.root_id().to_owned(),
                    host_name: profile.host_name().to_owned(),
                    connection,
                });
                (prev, None, Self::snapshot_locked(&state))
            }
        };

        if let Some(discarded) = discarded {
            close_with_warning(discarded, &root_id).await;
            return Err("connection cancelled by disconnect or host removal".to_owned());
        }
        self.emit_state_snapshot(snapshot.clone());
        if let Some(prev) = prev {
            close_with_warning(prev.connection, &prev.root_id).await;
        }
        Ok(snapshot)
    }

    pub async fn disconnect_host(&self) -> Result<Value, String> {
        let (prev, snapshot) = {
            let mut state = self.state.lock().await;
            state.connection_epoch = state.connection_epoch.wrapping_add(1);
            let prev = state.active.take();
            let snap = Self::snapshot_locked(&state);
            (prev, snap)
        };
        // Always push the detached state to JS before remote close so UI never
        // remains stuck showing an active connection if close fails.
        self.emit_state_snapshot(snapshot.clone());
        if let Some(prev) = prev {
            prev.connection
                .close()
                .await
                .map_err(|err| format!("detached locally, but remote close failed: {err}"))?;
        }
        Ok(snapshot)
    }

    pub async fn remove_host(&self, data: Value) -> Result<Value, String> {
        let root_id = require_string(&data, "rootId")?;

        // Strictly scope persist_gate to disk + memory commit so any stalled
        // remote close().await never blocks subsequent persistence operations.
        let (prev, snapshot) = {
            let _persist_guard = self.persist_gate.lock().await;
            let staged = {
                let mut state = self.state.lock().await;
                state.connection_epoch = state.connection_epoch.wrapping_add(1);
                let (next_store, removed) = state.store.stage_remove_host(&root_id);
                if !removed {
                    return Ok(Self::snapshot_locked(&state));
                }
                let old_creds = state.credentials.clone();
                let mut next_creds = old_creds.clone();
                next_creds.remove(&root_id);
                (
                    state.support_dir.join("credentials.json"),
                    old_creds,
                    next_creds,
                    next_store,
                )
            };

            let (cred_path, old_creds, next_creds, next_store) = staged;
            let store_for_disk = next_store.clone();
            let creds_for_disk = next_creds.clone();
            tokio::task::spawn_blocking(move || {
                commit_store_and_credentials(
                    &cred_path,
                    &old_creds,
                    &creds_for_disk,
                    &store_for_disk,
                )
            })
            .await
            .map_err(|err| format!("persist host removal task failed: {err}"))??;

            let mut state = self.state.lock().await;
            state.store = next_store;
            state.credentials = next_creds;
            let prev = if state.active.as_ref().is_some_and(|a| a.root_id == root_id) {
                state.active.take()
            } else {
                None
            };
            let snap = Self::snapshot_locked(&state);
            (prev, snap)
        };

        self.emit_state_snapshot(snapshot.clone());
        if let Some(prev) = prev {
            prev.connection
                .close()
                .await
                .map_err(|err| format!("host removed, but remote close failed: {err}"))?;
        }
        Ok(snapshot)
    }

    pub async fn set_filter(&self, data: Value) -> Result<Value, String> {
        let filter: HostViewFilter =
            serde_json::from_value(data.get("filter").cloned().unwrap_or(Value::Null))
                .map_err(|err| format!("invalid host filter: {err}"))?;
        let _persist_guard = self.persist_gate.lock().await;

        let next_store = {
            let state = self.state.lock().await;
            state
                .store
                .stage_set_filter(filter)
                .map_err(|err| err.to_string())?
        };
        let store_for_disk = next_store.clone();
        tokio::task::spawn_blocking(move || {
            store_for_disk.persist().map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| format!("persist filter task failed: {err}"))??;

        let snapshot = {
            let mut state = self.state.lock().await;
            state.store = next_store;
            Self::snapshot_locked(&state)
        };
        self.emit_state_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn host_call(&self, data: Value) -> Result<Value, String> {
        let endpoint = require_string(&data, "endpoint")?;
        let method = require_string(&data, "method")?;
        let input = data.get("input").cloned().unwrap_or_else(|| json!({}));

        let call_handle = {
            let state = self.state.lock().await;
            state
                .active
                .as_ref()
                .map(|a| a.connection.call_handle())
                .ok_or_else(|| "no remote Host is currently connected".to_owned())?
        };
        let events = call_handle
            .call(&endpoint, &method, input)
            .await
            .map_err(|err| err.to_string())?;
        Ok(json!({ "events": events }))
    }
}

async fn close_with_warning(connection: RemoteHostConnection, root_id: &str) {
    if let Err(err) = connection.close().await {
        log::warn!("failed to close remote Host session for {root_id}: {err}");
    }
}

/// Atomically persist both credentials.json and saved-hosts.json, rolling back
/// credentials.json if saved-hosts.json fails to persist so disk never splits.
fn commit_store_and_credentials(
    cred_path: &Path,
    old_creds: &BTreeMap<String, String>,
    next_creds: &BTreeMap<String, String>,
    next_store: &SavedHostStore,
) -> Result<(), String> {
    save_credentials(cred_path, next_creds)?;
    if let Err(store_err) = next_store.persist() {
        if let Err(rollback_err) = save_credentials(cred_path, old_creds) {
            return Err(format!(
                "persist saved hosts failed ({store_err}); credential rollback also failed ({rollback_err})"
            ));
        }
        return Err(store_err.to_string());
    }
    Ok(())
}

fn require_string(data: &Value, field: &str) -> Result<String, String> {
    data.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing required string field '{field}'"))
}

fn now_epoch_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("system clock before UNIX epoch: {err}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system clock overflow".to_owned())
}

fn credential_fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut hex = String::with_capacity(16);
    for byte in &digest[..8] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("cred_{hex}")
}

fn load_or_create_device_identity(path: &Path) -> Result<DeviceIdentityFile, String> {
    if path.exists() {
        let raw = fs::read(path).map_err(|err| format!("read device identity: {err}"))?;
        return serde_json::from_slice(&raw).map_err(|err| format!("parse device identity: {err}"));
    }
    let seed = Uuid::new_v4();
    let digest = Sha256::digest(seed.as_bytes());
    let mut peer_hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut peer_hex, "{byte:02x}");
    }
    let identity = DeviceIdentityFile {
        device_peer_id: format!("peer_{peer_hex}"),
        client_instance: format!("maka-ios-{}", Uuid::new_v4()),
    };
    write_private_json(path, &identity)?;
    Ok(identity)
}

fn load_credentials(path: &Path) -> Result<BTreeMap<String, String>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read(path).map_err(|err| format!("read credentials: {err}"))?;
    let file: CredentialStoreFile =
        serde_json::from_slice(&raw).map_err(|err| format!("parse credentials: {err}"))?;
    Ok(file.credentials)
}

fn save_credentials(path: &Path, credentials: &BTreeMap<String, String>) -> Result<(), String> {
    write_private_json(
        path,
        &CredentialStoreFile {
            credentials: credentials.clone(),
        },
    )
}

fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid private JSON file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|err| format!("create parent dir: {err}"))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    let mut tmp =
        NamedTempFile::new_in(parent).map_err(|err| format!("create temp file: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("set 0600 permissions: {err}"))?;
    }
    tmp.write_all(&bytes)
        .map_err(|err| format!("write temp file: {err}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|err| format!("sync temp file: {err}"))?;
    tmp.persist(path)
        .map_err(|err| format!("persist private JSON file: {}", err.error))?;
    Ok(())
}
