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

use maka_remote_client::{
    Attachments, DeviceIdentity, HostProfile, PendingPairing, ReadResource, RelayAuthorization,
    RemoteCallHandle, RemoteClientError, RemoteHostConnection, SavedHosts, TlsTrust,
};
use nsh_engine::{HostCall, HostChannel};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    runtime::Handle,
    sync::{Mutex, oneshot},
    task::AbortHandle,
};
use tokio_util::sync::CancellationToken;

const PAIR_SCHEME: &str = "maka://pair/v1?payload=";
const PROGRESS_WINDOW: usize = 8;
pub const ALLOWED_HOST_CALLS: &[&str] = &[
    "ios.bootstrap",
    "ios.beginPairing",
    "ios.confirmPairing",
    "ios.cancelPairing",
    "ios.connectWebSocket",
    "ios.connectHost",
    "ios.disconnectHost",
    "ios.removeHost",
    "ios.setFilter",
    "ios.hostQuery",
    "ios.hostMutate",
    "ios.ackMutationProgress",
    "ios.subscribe",
    "ios.unsubscribe",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    uri: String,
    relay_url: Option<String>,
    relay_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirm {
    pairing_id: u64,
    sas: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Direct {
    endpoint: String,
    bearer: String,
    client_instance: Option<String>,
    root_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Root {
    root_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectHost {
    root_id: String,
    relay_url: Option<String>,
    relay_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rpc {
    root_id: Option<RootId>,
    anchor_session: Option<String>,
    generation: Option<u64>,
    endpoint: String,
    method: String,
    input: Value,
    subscription_id: Option<String>,
    progress_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscriptionHandle {
    root_id: RootId,
    subscription_id: String,
    generation: u64,
}

type RootId = String;

struct Attempt {
    id: u64,
    cancel: CancellationToken,
}

enum Admission {
    Connecting(Attempt),
    Offline,
    Error(String),
}

struct RelayCredential {
    url: String,
    token: String,
}

impl RelayCredential {
    fn authorization(&self) -> RelayAuthorization<'_> {
        RelayAuthorization {
            relay_url: &self.url,
            bearer: &self.token,
        }
    }
}

struct Pending {
    id: u64,
    pairing: PendingPairing,
    credential: Option<Arc<RelayCredential>>,
}

struct ActiveHost {
    id: u64,
    info: Value,
    calls: RemoteCallHandle,
    receipt_scope: Option<ReceiptScope>,
    _stop: oneshot::Sender<()>,
    subscriptions: BTreeMap<String, (u64, AbortHandle)>,
}

impl Drop for ActiveHost {
    fn drop(&mut self) {
        for (_, task) in self.subscriptions.values() {
            task.abort();
        }
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ReceiptScope {
    root: String,
    host_peer_id: String,
}

#[derive(Default)]
struct State {
    generation: u64,
    pairing: Option<Attempt>,
    pending: Option<Pending>,
    redeeming: BTreeMap<u64, RootId>,
    unacked_progress: BTreeSet<u64>,
    // The legacy pairing screen also uses cancelPairing for manual WebSocket admission.
    manual: Option<RootId>,
    active_root: Option<RootId>,
    connections: BTreeMap<RootId, ActiveHost>,
    admissions: BTreeMap<RootId, Admission>,
    profiles: BTreeMap<RootId, HostProfile>,
    credentials: BTreeMap<RootId, Arc<RelayCredential>>,
    filter: Option<RootId>,
    uncertain: BTreeMap<ReceiptScope, Vec<Value>>,
}

impl State {
    fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    fn cancel_pairing(&mut self) {
        if let Some(pairing) = self.pairing.take() {
            pairing.cancel.cancel();
        }
        self.pending = None;
    }

    fn start_admission(&mut self, root: &str, cancel: CancellationToken) -> u64 {
        self.clear_admission(root);
        let id = self.next_generation();
        self.admissions
            .insert(root.into(), Admission::Connecting(Attempt { id, cancel }));
        id
    }

    fn clear_admission(&mut self, root: &str) {
        if let Some(Admission::Connecting(attempt)) = self.admissions.remove(root) {
            attempt.cancel.cancel();
        }
        if self.manual.as_deref() == Some(root) {
            self.manual = None;
        }
    }

    fn admitting(&self, root: &str, id: u64) -> bool {
        matches!(self.admissions.get(root), Some(Admission::Connecting(attempt)) if attempt.id == id)
    }

    fn remove_connection(&mut self, root: &str) {
        self.connections.remove(root);
        if self.active_root.as_deref() == Some(root) {
            self.active_root = None;
        }
    }

    fn current(&self, root: &str, id: u64) -> Option<&ActiveHost> {
        self.connections.get(root).filter(|active| active.id == id)
    }
}

pub struct HostBridge {
    bridge: Bridge,
}

#[derive(Clone)]
struct Bridge {
    state: Arc<Mutex<State>>,
    identity: Arc<DeviceIdentity>,
    peer_id: Arc<str>,
    saved: Arc<SyncMutex<SavedHosts>>,
    profile_path: PathBuf,
    profile_edits: Arc<Mutex<()>>,
    pending_uri: Arc<SyncMutex<Option<String>>>,
    channel: HostChannel,
    snapshot_revision: Arc<AtomicU64>,
    runtime: Handle,
}

impl HostBridge {
    pub fn attach(
        channel: HostChannel,
        support_dir: PathBuf,
        runtime: Handle,
    ) -> Result<Self, String> {
        let identity = crate::identity::load(&support_dir)?;
        let profile_path = support_dir.join("hosts.json");
        let saved = SavedHosts::load(&profile_path).map_err(error)?;
        let profiles = saved
            .hosts()
            .map(|host| (host.root_id().to_owned(), host.clone()))
            .collect();
        let bridge = Bridge {
            state: Arc::new(Mutex::new(State {
                profiles,
                ..State::default()
            })),
            peer_id: identity.public_key().to_string().into(),
            identity: Arc::new(identity),
            saved: Arc::new(SyncMutex::new(saved)),
            profile_path,
            profile_edits: Default::default(),
            pending_uri: Default::default(),
            runtime,
            channel: channel.clone(),
            snapshot_revision: Arc::new(AtomicU64::new(0)),
        };
        for &name in ALLOWED_HOST_CALLS {
            let bridge = bridge.clone();
            channel.handle(name, move |mut call: HostCall| {
                let data = call.take_data();
                let bridge = bridge.clone();
                bridge.runtime.clone().spawn(async move {
                    if name == "ios.subscribe" {
                        match bridge.open_subscription(data).await {
                            Ok((root, id, generation, start)) => {
                                call.reply(Ok(
                                    json!({ "rootId": root, "subscriptionId": id, "generation": generation }),
                                ));
                                let _ = start.send(());
                            }
                            Err(err) => call.reply(Err(err)),
                        }
                    } else {
                        call.reply(bridge.dispatch(name, data).await);
                    }
                });
            });
        }
        Ok(Self { bridge })
    }

    pub fn queue_pairing_uri(&self, uri: String) {
        if uri.starts_with(PAIR_SCHEME) {
            *self.bridge.pending_uri.lock().expect("pairing URI lock") = Some(uri);
        }
    }
}

impl Drop for HostBridge {
    fn drop(&mut self) {
        for name in ALLOWED_HOST_CALLS {
            self.bridge.channel.remove_handler(name);
        }
        let state = self.bridge.state.clone();
        self.bridge.runtime.spawn(async move {
            let mut state = state.lock().await;
            state.cancel_pairing();
            for admission in std::mem::take(&mut state.admissions).into_values() {
                if let Admission::Connecting(attempt) = admission {
                    attempt.cancel.cancel();
                }
            }
            state.connections.clear();
        });
    }
}

impl Bridge {
    fn emit(&self, event: &str, data: Value) {
        self.channel
            .send(event, data)
            .expect("valid iOS Host event name");
    }

    fn snapshot(&self, state: &State) -> Value {
        let mut connections = BTreeMap::new();
        for (root, admission) in &state.admissions {
            let info = match admission {
                Admission::Connecting(_) => json!({"status": "connecting"}),
                Admission::Offline => json!({"status": "offline"}),
                Admission::Error(reason) => json!({"status": "error", "error": reason}),
            };
            connections.insert(root.clone(), info);
        }
        for (root, active) in &state.connections {
            connections.insert(
                root.clone(),
                json!({"status": "connected", "connection": active.info}),
            );
        }
        let hosts: Vec<_> = state
            .profiles
            .values()
            .map(|host| {
                let root = host.root_id();
                let status = connections
                    .entry(root.to_owned())
                    .or_insert_with(|| json!({"status": "offline"}));
                json!({
                    "rootId": root,
                    "hostName": host.host_name(),
                    "peerId": host.host_peer_id(),
                    "endpoints": host.direct_endpoints(),
                    "relayUrls": host.relays().iter().map(|relay| &relay.url).collect::<Vec<_>>(),
                    // The existing drawer only renders the selected Host as live.
                    "connected": state.active_root.as_deref() == Some(root),
                    "status": status["status"],
                })
            })
            .collect();
        json!({
            "revision": self.snapshot_revision.fetch_add(1, Ordering::Relaxed) + 1,
            "devicePeerId": self.peer_id,
            "hosts": hosts,
            "activeRootId": state.active_root,
            "active": state.active_root.as_ref().and_then(|root| state.connections.get(root)).map(|active| &active.info),
            "connections": connections,
            "filter": match &state.filter {
                Some(root) => json!({"kind": "single_computer", "root_id": root}),
                None => json!({"kind": "all_computers"}),
            },
        })
    }

    async fn dispatch(&self, name: &str, data: Value) -> Result<Value, String> {
        match name {
            "ios.bootstrap" => {
                let mut snapshot = self.snapshot(&*self.state.lock().await);
                if let Some(uri) = self.pending_uri.lock().expect("pairing URI lock").take() {
                    snapshot["pendingPairUri"] = Value::String(uri);
                }
                Ok(snapshot)
            }
            "ios.beginPairing" => self.begin(decode(data)?).await,
            "ios.confirmPairing" => self.confirm(decode(data)?).await,
            "ios.cancelPairing" => {
                let mut state = self.state.lock().await;
                if let Some(root) = optional_root(&data)? {
                    if matches!(state.admissions.get(root), Some(Admission::Connecting(_))) {
                        state.clear_admission(root);
                        self.emit("ios.hostState", self.snapshot(&state));
                    }
                } else if state.pairing.is_some() {
                    state.cancel_pairing();
                } else if let Some(root) = state.manual.take() {
                    state.clear_admission(&root);
                    self.emit("ios.hostState", self.snapshot(&state));
                }
                Ok(Value::Null)
            }
            "ios.connectHost" => self.connect(decode(data)?).await,
            "ios.connectWebSocket" => self.direct(decode(data)?).await,
            "ios.disconnectHost" => {
                let mut state = self.state.lock().await;
                if let Some(root) = optional_root(&data)?
                    .map(str::to_owned)
                    .or_else(|| state.active_root.clone())
                {
                    if state.connections.contains_key(&root) || state.admissions.contains_key(&root)
                    {
                        state.clear_admission(&root);
                        state.remove_connection(&root);
                        state.admissions.insert(root, Admission::Offline);
                    }
                }
                Ok(self.snapshot(&state))
            }
            "ios.removeHost" => {
                let Root { root_id } = decode(data)?;
                self.remove(root_id).await
            }
            "ios.setFilter" => {
                let filter = &data["filter"];
                let mut state = self.state.lock().await;
                state.filter = match filter["kind"].as_str() {
                    Some("all_computers") => None,
                    Some("single_computer") => Some(field(filter, "root_id")?.to_owned()),
                    _ => return Err("invalid Host filter".into()),
                };
                Ok(self.snapshot(&state))
            }
            "ios.hostQuery" => {
                let rpc = read_only_rpc(data)?;
                let (root, id, calls, _) = self.calls(&rpc).await?;
                let value = calls
                    .query(&rpc.endpoint, &rpc.method, rpc.input)
                    .await
                    .map_err(error)?;
                self.check_active(&root, id).await?;
                Ok(json!({"value": value}))
            }
            "ios.hostMutate" => self.mutate(data).await,
            "ios.ackMutationProgress" => {
                let credit: u64 = decode(data)?;
                self.state.lock().await.unacked_progress.remove(&credit);
                Ok(Value::Null)
            }
            "ios.unsubscribe" => {
                let SubscriptionHandle {
                    root_id,
                    subscription_id,
                    generation,
                } = decode(data)?;
                let mut state = self.state.lock().await;
                let task = state.connections.get_mut(&root_id).and_then(|host| {
                    if host
                        .subscriptions
                        .get(&subscription_id)
                        .is_some_and(|(id, _)| *id == generation)
                    {
                        host.subscriptions.remove(&subscription_id)
                    } else {
                        None
                    }
                });
                if let Some((_, task)) = &task {
                    task.abort();
                }
                Ok(json!({"cancelled": task.is_some()}))
            }
            _ => unreachable!("registered iOS Host call"),
        }
    }

    async fn mutate(&self, mut data: Value) -> Result<Value, String> {
        // Do not feed a credential to serde's diagnostics or the Host's JSON input.
        let secret = match data.as_object_mut().and_then(|data| data.remove("secret")) {
            Some(Value::String(secret)) => Some(secret),
            None | Some(Value::Null) => None,
            Some(_) => return Err("secret must be UTF-8 text".into()),
        };
        let rpc: Rpc = decode(data)?;
        let attachments = credential_attachments(&rpc, secret)?;
        let (root, id, calls, receipt_scope) = self.calls(&rpc).await?;
        let result = calls
            .mutate_with_progress(
                &rpc.endpoint,
                &rpc.method,
                rpc.input,
                attachments,
                |value| self.emit_progress(&root, id, rpc.progress_id.as_deref(), value),
            )
            .await;
        if let Err(RemoteClientError::MutationUncertain { reference, .. }) = &result
            && let Some(scope) = receipt_scope
        {
            self.register_uncertain(id, scope, reference.clone()).await;
        }
        let value = result.map_err(error)?;
        self.check_active(&root, id).await?;
        Ok(json!({"value": value}))
    }

    async fn emit_progress(
        &self,
        root: &str,
        generation: u64,
        progress_id: Option<&str>,
        value: Value,
    ) {
        let Some(progress_id) = progress_id else {
            return;
        };
        let mut state = self.state.lock().await;
        // A shared window bounds the NSH queue even across reconnects and concurrent calls.
        // Progress is advisory when JS falls behind; never wait for credit on the receipt path.
        if state.unacked_progress.len() == PROGRESS_WINDOW
            || state.current(root, generation).is_none()
        {
            return;
        }
        let credit = state.next_generation();
        state.unacked_progress.insert(credit);
        self.emit("ios.mutationProgress", json!({
            "rootId": root, "generation": generation, "progressId": progress_id, "value": value, "credit": credit,
        }));
    }

    async fn new_pairing(&self) -> (u64, CancellationToken) {
        let mut state = self.state.lock().await;
        state.cancel_pairing();
        let id = state.next_generation();
        let cancel = CancellationToken::new();
        state.pairing = Some(Attempt {
            id,
            cancel: cancel.clone(),
        });
        (id, cancel)
    }

    async fn finish_pairing(&self, id: u64) {
        let mut state = self.state.lock().await;
        if state
            .pairing
            .as_ref()
            .is_some_and(|attempt| attempt.id == id)
        {
            state.cancel_pairing();
        }
    }

    async fn begin(&self, begin: Begin) -> Result<Value, String> {
        let credential = match (begin.relay_url, begin.relay_token) {
            (None, None) => None,
            (Some(url), Some(token)) => Some(Arc::new(RelayCredential { url, token })),
            _ => return Err("relay authorization requires both URL and Bearer token".into()),
        };
        let (id, cancel) = self.new_pairing().await;
        let result = self.begin_pairing(begin.uri, credential, id, cancel).await;
        if result.is_err() {
            self.finish_pairing(id).await;
        }
        result
    }

    async fn begin_pairing(
        &self,
        uri: String,
        credential: Option<Arc<RelayCredential>>,
        id: u64,
        cancel: CancellationToken,
    ) -> Result<Value, String> {
        let path = self.profile_path.clone();
        let saved = tokio::task::spawn_blocking(move || SavedHosts::load(path))
            .await
            .map_err(error)?
            .map_err(error)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(error)?
            .as_millis()
            .try_into()
            .map_err(error)?;
        let pairing = cancel
            .run_until_cancelled(PendingPairing::begin(
                &self.identity,
                uri.trim(),
                now,
                credential.as_deref().map(RelayCredential::authorization),
                &saved,
            ))
            .await
            .ok_or("connection cancelled")?
            .map_err(error)?;
        let mut state = self.state.lock().await;
        if cancel.is_cancelled() {
            return Err("pairing was superseded".into());
        }
        let info = json!({
            "pairingId": id,
            "rootId": pairing.root_id(), "hostName": pairing.host_name(),
            "peerId": pairing.host_peer_id(), "devicePeerId": self.peer_id,
            "sasCode": pairing.sas(), "pathSummary": path_summary(pairing.path_summary()),
        });
        state.pending = Some(Pending {
            id,
            pairing,
            credential,
        });
        Ok(info)
    }

    async fn confirm(&self, confirm: Confirm) -> Result<Value, String> {
        let (pending, root, id, cancel) = {
            let mut state = self.state.lock().await;
            if !state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == confirm.pairing_id)
            {
                return Err("there is no matching pairing to confirm".into());
            }
            let pending = state.pending.take().expect("matched pending pairing");
            let root = pending.pairing.root_id().to_owned();
            let cancel = state
                .pairing
                .as_ref()
                .expect("pending pairing has an attempt")
                .cancel
                .child_token();
            let id = state.start_admission(&root, cancel.clone());
            state.redeeming.insert(id, root.clone());
            self.emit("ios.hostState", self.snapshot(&state));
            (pending, root, id, cancel)
        };
        let pairing_id = pending.id;
        let result = self
            .confirm_pairing(pending, id, &cancel, &confirm.sas)
            .await;
        self.state.lock().await.redeeming.remove(&id);
        self.finish_admission(&root, id, &cancel, &result).await;
        self.finish_pairing(pairing_id).await;
        result
    }

    async fn confirm_pairing(
        &self,
        pending: Pending,
        id: u64,
        cancel: &CancellationToken,
        sas: &str,
    ) -> Result<Value, String> {
        let redeemed = cancel
            .run_until_cancelled(pending.pairing.redeem(sas, Some("Maka for iOS".into())))
            .await
            .ok_or("pairing cancelled")?
            .map_err(error)?;
        let profile = redeemed.profile().clone();
        let name = profile.host_name().to_owned();
        self.save_redeemed(id, profile, pending.credential).await?;
        if cancel.is_cancelled() {
            return Err("pairing saved; connection cancelled".into());
        }
        let (_, connection) = cancel
            .run_until_cancelled(redeemed.admit())
            .await
            .ok_or("pairing saved; connection cancelled")?
            .map_err(error)?;
        self.install(id, name, connection, "quic", None).await
    }

    async fn save_redeemed(
        &self,
        id: u64,
        profile: HostProfile,
        credential: Option<Arc<RelayCredential>>,
    ) -> Result<(), String> {
        // Redeem spends the invite. Save even after cancellation, unless unpaired.
        let root = profile.root_id().to_owned();
        let _edit = self.profile_edits.lock().await;
        if !self.state.lock().await.redeeming.contains_key(&id) {
            return Err("Host was removed during pairing".into());
        }
        let saved = self.saved.clone();
        let to_save = profile.clone();
        tokio::task::spawn_blocking(move || saved.lock().expect("saved Host lock").save(to_save))
            .await
            .map_err(error)?
            .map_err(error)?;
        {
            let mut state = self.state.lock().await;
            state.profiles.insert(root.to_owned(), profile);
            match credential {
                Some(credential) => {
                    state.credentials.insert(root.to_owned(), credential);
                }
                None => {
                    state.credentials.remove(&root);
                }
            }
            self.emit("ios.hostState", self.snapshot(&state));
        }
        Ok(())
    }

    async fn connect(&self, request: ConnectHost) -> Result<Value, String> {
        let root = &request.root_id;
        let supplied = match (request.relay_url, request.relay_token) {
            (None, None) => None,
            (Some(url), Some(token)) => Some(Arc::new(RelayCredential { url, token })),
            _ => return Err("relay authorization requires both URL and Bearer token".into()),
        };
        let cancel = CancellationToken::new();
        let (id, profile, credential) = {
            let mut state = self.state.lock().await;
            let profile = state
                .profiles
                .get(root)
                .cloned()
                .ok_or("unknown paired Host")?;
            let credential = supplied.or_else(|| state.credentials.get(root).cloned());
            let id = state.start_admission(root, cancel.clone());
            self.emit("ios.hostState", self.snapshot(&state));
            (id, profile, credential)
        };
        let result = async {
            let connection = cancel
                .run_until_cancelled(profile.reconnect(
                    &self.identity,
                    credential.as_deref().map(RelayCredential::authorization),
                ))
                .await
                .ok_or("connection cancelled")?
                .map_err(error)?;
            self.install(
                id,
                profile.host_name().to_owned(),
                connection,
                "quic",
                credential,
            )
            .await
        }
        .await;
        self.finish_admission(root, id, &cancel, &result).await;
        result
    }

    async fn direct(&self, direct: Direct) -> Result<Value, String> {
        let root = direct.root_id.trim();
        if root.is_empty() {
            return Err("missing rootId".into());
        }
        let cancel = CancellationToken::new();
        let id = {
            let mut state = self.state.lock().await;
            let id = state.start_admission(root, cancel.clone());
            state.manual = Some(root.into());
            self.emit("ios.hostState", self.snapshot(&state));
            id
        };
        let result = async {
            let connection = cancel
                .run_until_cancelled(RemoteHostConnection::connect_websocket(
                    direct.endpoint.trim(),
                    TlsTrust::System,
                    direct.bearer.into(),
                    root,
                    direct
                        .client_instance
                        .map_or_else(|| self.peer_id.clone(), Into::into),
                ))
                .await
                .ok_or("connection cancelled")?
                .map_err(error)?;
            self.install(id, "WebSocket".into(), connection, "websocket", None)
                .await
        }
        .await;
        self.finish_admission(root, id, &cancel, &result).await;
        result
    }

    async fn finish_admission(
        &self,
        root: &str,
        id: u64,
        cancel: &CancellationToken,
        result: &Result<Value, String>,
    ) {
        let Err(reason) = result else {
            return;
        };
        let mut state = self.state.lock().await;
        if state.admitting(root, id) {
            let cancelled = cancel.is_cancelled();
            state.clear_admission(root);
            if !cancelled && !state.connections.contains_key(root) {
                state
                    .admissions
                    .insert(root.into(), Admission::Error(reason.clone()));
            }
            self.emit("ios.hostState", self.snapshot(&state));
        }
    }

    async fn remove(&self, root: String) -> Result<Value, String> {
        let _edit = self.profile_edits.lock().await;
        let saved = self.saved.clone();
        let key = root.clone();
        tokio::task::spawn_blocking(move || saved.lock().expect("saved Host lock").remove(&key))
            .await
            .map_err(error)?
            .map_err(error)?;
        let mut state = self.state.lock().await;
        state
            .redeeming
            .retain(|_, pairing_root| *pairing_root != root);
        state.profiles.remove(&root);
        state.credentials.remove(&root);
        state.uncertain.retain(|scope, _| scope.root != root);
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.pairing.root_id() == root)
        {
            state.cancel_pairing();
        }
        state.clear_admission(&root);
        state.remove_connection(&root);
        if state.filter.as_deref() == Some(&root) {
            state.filter = None;
        }
        Ok(self.snapshot(&state))
    }

    async fn install(
        &self,
        id: u64,
        name: String,
        connection: RemoteHostConnection,
        transport: &str,
        credential: Option<Arc<RelayCredential>>,
    ) -> Result<Value, String> {
        let (stop_tx, stop_rx) = oneshot::channel();
        let endpoints = connection.endpoint_names();
        let (snapshot, reconcile) = {
            let mut state = self.state.lock().await;
            let root = connection.root_id();
            if !matches!(state.admissions.get(root), Some(Admission::Connecting(attempt)) if attempt.id == id && !attempt.cancel.is_cancelled())
            {
                return Err("connection was superseded".into());
            }
            state.clear_admission(root);
            if let Some(credential) = credential {
                state.credentials.insert(root.into(), credential);
            }
            let receipt_scope =
                if transport == "quic" && endpoints.iter().any(|endpoint| endpoint == "receipts") {
                    state
                        .profiles
                        .get(connection.root_id())
                        .map(|profile| ReceiptScope {
                            root: profile.root_id().to_owned(),
                            host_peer_id: profile.host_peer_id().to_owned(),
                        })
                } else {
                    None
                };
            let reconcile = receipt_scope.as_ref().and_then(|scope| {
                Some((
                    scope.clone(),
                    state.uncertain.get(scope)?.clone(),
                    connection.call_handle(),
                ))
            });
            state.active_root = Some(root.into());
            state.connections.insert(root.into(), ActiveHost {
                id,
                calls: connection.call_handle(),
                receipt_scope,
                _stop: stop_tx,
                subscriptions: BTreeMap::new(),
                info: json!({
                    "rootId": connection.root_id(), "hostName": name, "epoch": connection.epoch(),
                    "session": connection.session(), "generation": id, "endpoints": endpoints,
                    "pathSummary": path_summary(connection.path_summary()), "transport": transport,
                }),
            });
            (self.snapshot(&state), reconcile)
        };
        let bridge = self.clone();
        self.runtime.spawn(async move {
            bridge.monitor(id, connection, stop_rx).await;
        });
        if let Some((scope, references, calls)) = reconcile {
            let bridge = self.clone();
            self.runtime.spawn(async move {
                bridge.reconcile(id, scope, references, calls).await;
            });
        }
        Ok(snapshot)
    }

    async fn register_uncertain(&self, id: u64, scope: ReceiptScope, reference: Value) {
        let late = {
            let mut state = self.state.lock().await;
            if state
                .profiles
                .get(&scope.root)
                .is_some_and(|profile| profile.host_peer_id() == scope.host_peer_id)
            {
                state
                    .uncertain
                    .entry(scope.clone())
                    .or_default()
                    .push(reference.clone());
                state
                    .connections
                    .get(&scope.root)
                    .filter(|active| {
                        active.id != id && active.receipt_scope.as_ref() == Some(&scope)
                    })
                    .map(|active| (active.id, active.calls.clone()))
            } else {
                None
            }
        };
        if let Some((active, calls)) = late {
            let bridge = self.clone();
            self.runtime.spawn(async move {
                bridge
                    .reconcile(active, scope, vec![reference], calls)
                    .await;
            });
        }
    }

    async fn reconcile(
        &self,
        id: u64,
        scope: ReceiptScope,
        references: Vec<Value>,
        calls: RemoteCallHandle,
    ) {
        let mut settled = 0;
        for reference in references {
            if self.check_active(&scope.root, id).await.is_err() {
                return;
            }
            match calls.query("receipts", "read", reference.clone()).await {
                Ok(reply) if terminal_receipt(&reference, &reply) => {
                    settled += 1;
                    let mut state = self.state.lock().await;
                    if let Some(refs) = state.uncertain.get_mut(&scope) {
                        refs.retain(|item| *item != reference);
                        if refs.is_empty() {
                            state.uncertain.remove(&scope);
                        }
                    }
                }
                Ok(_) => {}
                Err(err) => {
                    log::warn!("read remote operation receipt: {err}");
                }
            }
        }
        let state = self.state.lock().await;
        if let Some(active) = state.current(&scope.root, id) {
            let pending = state.uncertain.get(&scope).map_or(0, Vec::len);
            self.emit(
                "ios.operationRecovery",
                json!({
                    "rootId": scope.root, "session": active.info["session"], "settled": settled, "pending": pending
                }),
            );
        }
    }

    async fn monitor(
        &self,
        id: u64,
        mut connection: RemoteHostConnection,
        mut stop: oneshot::Receiver<()>,
    ) {
        let root = connection.root_id().to_owned();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            let path = path_summary(connection.path_summary());
            tokio::select! {
                biased;
                _ = &mut stop => {
                    match tokio::time::timeout(Duration::from_secs(3), connection.close()).await {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => log::warn!("close remote Host: {err}"),
                        Err(err) => log::warn!("close remote Host timed out: {err}"),
                    }
                    return;
                }
                disconnected = connection.disconnected() => {
                    let mut state = self.state.lock().await;
                    if state.current(&root, id).is_some() {
                        let selected = state.active_root.as_ref() == Some(&root);
                        state.remove_connection(&root);
                        let error = disconnected.err().map(|err| err.to_string());
                        state.admissions.entry(root.clone()).or_insert_with(|| match &error {
                            Some(reason) => Admission::Error(reason.clone()),
                            None => Admission::Offline,
                        });
                        let mut snapshot = self.snapshot(&state);
                        if selected {
                            snapshot["disconnectedRootId"] = json!(root);
                            snapshot["disconnectReason"] = json!(error.as_deref().unwrap_or("Host closed the connection"));
                        }
                        self.emit("ios.hostState", snapshot);
                    }
                    return;
                }
                _ = interval.tick() => {
                    let mut state = self.state.lock().await;
                    if let Some(active) = state.connections.get_mut(&root).filter(|active| active.id == id)
                        && active.info["pathSummary"] != path
                    {
                        active.info["pathSummary"] = path;
                        self.emit("ios.hostState", self.snapshot(&state));
                    }
                }
            }
        }
    }

    async fn calls(
        &self,
        rpc: &Rpc,
    ) -> Result<(RootId, u64, RemoteCallHandle, Option<ReceiptScope>), String> {
        let state = self.state.lock().await;
        // Without an explicit root, require the selected anchor as before.
        // Explicit-root callers can independently pin a connection generation.
        let target = match &rpc.root_id {
            Some(root) => state.connections.get_key_value(root),
            None => state
                .active_root
                .as_ref()
                .and_then(|root| state.connections.get_key_value(root))
                .filter(|(_, active)| {
                    rpc.anchor_session
                        .as_ref()
                        .is_some_and(|session| active.info["session"] == *session)
                }),
        };
        let (root, active) = target
            .filter(|(_, active)| {
                rpc.anchor_session
                    .as_ref()
                    .is_none_or(|session| active.info["session"] == *session)
                    && rpc
                        .generation
                        .is_none_or(|generation| generation == active.id)
            })
            .ok_or_else(|| match &rpc.root_id {
                Some(root) if !state.connections.contains_key(root) => {
                    "remote Host is not connected".to_owned()
                }
                _ => "remote Host anchor no longer matches UI".to_owned(),
            })?;
        Ok((
            root.clone(),
            active.id,
            active.calls.clone(),
            active.receipt_scope.clone(),
        ))
    }

    async fn check_active(&self, root: &str, id: u64) -> Result<(), String> {
        if self.state.lock().await.current(root, id).is_some() {
            Ok(())
        } else {
            Err("remote Host changed during the call".into())
        }
    }

    async fn open_subscription(
        &self,
        data: Value,
    ) -> Result<(RootId, String, u64, oneshot::Sender<()>), String> {
        let rpc = read_only_rpc(data)?;
        let (root, active, calls, _) = self.calls(&rpc).await?;
        let id = rpc.subscription_id.ok_or("missing subscription ID")?;
        let mut subscription = calls
            .subscribe(&rpc.endpoint, &rpc.method, rpc.input)
            .await
            .map_err(error)?;
        let mut state = self.state.lock().await;
        if state.current(&root, active).is_none() {
            return Err("remote Host changed during subscription setup".into());
        }
        let generation = state.next_generation();
        let (start, wait) = oneshot::channel::<()>();
        let bridge = self.clone();
        let key = id.clone();
        let host_root = root.clone();
        let task = self.runtime.spawn(async move {
            if wait.await.is_err() {
                return;
            }
            let outcome = loop {
                match subscription.next().await {
                    Ok(Some(item)) => bridge.emit(
                        "ios.subscriptionItem",
                        json!({
                            "rootId": host_root, "subscriptionId": key, "generation": generation, "item": item,
                        }),
                    ),
                    Ok(None) => break None,
                    Err(err) => break Some(err.to_string()),
                }
            };
            let mut state = bridge.state.lock().await;
            if let Some(host) = state.connections.get_mut(&host_root)
                && host.subscriptions.get(&key).is_some_and(|(current, _)| *current == generation)
            {
                host.subscriptions.remove(&key);
                bridge.emit(
                    "ios.subscriptionEnded",
                    json!({
                        "rootId": host_root, "subscriptionId": key, "generation": generation, "error": outcome,
                    }),
                );
            }
        });
        let host = state
            .connections
            .get_mut(&root)
            .expect("matched active Host");
        if let Some((_, replaced)) = host
            .subscriptions
            .insert(id.clone(), (generation, task.abort_handle()))
        {
            replaced.abort();
        }
        Ok((root, id, generation, start))
    }
}

fn optional_root(data: &Value) -> Result<Option<&str>, String> {
    match data.get("rootId") {
        Some(Value::String(root)) => Ok(Some(root)),
        None | Some(Value::Null) => Ok(None),
        _ => Err("invalid rootId".into()),
    }
}

fn contains_secret(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            fields.contains_key("secret") || fields.values().any(contains_secret)
        }
        Value::Array(items) => items.iter().any(contains_secret),
        _ => false,
    }
}

fn read_only_rpc(data: Value) -> Result<Rpc, String> {
    if data.get("secret").is_some() || contains_secret(&data["input"]) {
        return Err("only credential mutations accept a secret attachment".into());
    }
    let rpc: Rpc = decode(data)?;
    if rpc.progress_id.is_some() {
        return Err("progress is only available for mutations".into());
    }
    Ok(rpc)
}

fn credential_attachments(rpc: &Rpc, secret: Option<String>) -> Result<Attachments, String> {
    if contains_secret(&rpc.input) {
        return Err("secret belongs in the request attachment, not JSON input".into());
    }
    let operation = (rpc.endpoint.as_str(), rpc.method.as_str());
    if matches!(
        operation,
        (
            "settings",
            "saveCredential" | "saveUsageCredential" | "updateNetwork"
        ) | ("web", "saveKey")
    ) && !rpc.input.is_object()
    {
        return Err("credential mutation input must be a JSON object".into());
    }
    let required = match operation {
        ("settings", "saveCredential" | "saveUsageCredential") | ("web", "saveKey") => true,
        ("settings", "updateNetwork") => {
            match rpc.input.get("credential").and_then(Value::as_str) {
                Some("replace") => true,
                Some("keep" | "delete") => false,
                _ => return Err("settings network credential action is invalid".into()),
            }
        }
        _ => false,
    };
    match (required, secret) {
        (true, Some(secret)) => Ok(Attachments::from([(
            "secret".into(),
            ReadResource::utf8(secret),
        )])),
        (false, None) => Ok(Attachments::new()),
        (true, None) => Err("this mutation requires a secret attachment".into()),
        (false, Some(_)) => Err("this mutation does not accept a secret attachment".into()),
    }
}

fn terminal_receipt(reference: &Value, reply: &Value) -> bool {
    reply.get("reference") == Some(reference)
        && reply["receipt"]["kind"] == "recorded"
        && matches!(
            reply["receipt"]["outcome"]["kind"].as_str(),
            Some("returned" | "not_executed")
        )
}

fn path_summary(path: Option<maka_remote_client::PathSummary>) -> Value {
    match path {
        Some(path) => {
            json!({"kind": if path.direct { "direct" } else { "relay" }, "rttMs": path.rtt.as_millis()})
        }
        None => Value::Null,
    }
}

fn decode<T: serde::de::DeserializeOwned>(data: Value) -> Result<T, String> {
    serde_json::from_value(data).map_err(error)
}

fn field<'a>(data: &'a Value, key: &str) -> Result<&'a str, String> {
    data[key].as_str().ok_or_else(|| format!("missing {key}"))
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};
    use uuid::Uuid;

    async fn open_anchor(
        listener: &TcpListener,
    ) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(socket).await.unwrap();
        // The opener sends the length prefix and payload as separate binary messages.
        let _prefix = ws.next().await.unwrap().unwrap();
        let open: Value =
            serde_json::from_slice(&ws.next().await.unwrap().unwrap().into_data()).unwrap();
        assert_eq!(open["request"]["kind"], "connect");
        ws
    }

    fn input(listener: &TcpListener) -> Value {
        json!({"endpoint": format!("ws://{}/runtime-host", listener.local_addr().unwrap()),
               "bearer":"fixture", "rootId":"root", "clientInstance":"test"})
    }

    #[tokio::test]
    async fn reserved_secret_fields_and_non_object_credential_inputs_fail_before_host_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let attached =
            HostBridge::attach(HostChannel::new(), dir.path().into(), Handle::current()).unwrap();
        let bridge = &attached.bridge;
        for input in [
            json!({"nested":{"secret":"not-on-wire"}}),
            json!({"nested":[{"secret":null}]}),
        ] {
            for call in ["ios.hostQuery", "ios.subscribe", "ios.hostMutate"] {
                let args = json!({"endpoint":"web","method":"saveKey","input":input});
                let error = if call == "ios.subscribe" {
                    bridge.open_subscription(args).await.unwrap_err()
                } else {
                    bridge.dispatch(call, args).await.unwrap_err()
                };
                assert!(error.contains("secret"), "{error}");
            }
        }
        for (endpoint, method) in [
            ("web", "saveKey"),
            ("settings", "saveCredential"),
            ("settings", "saveUsageCredential"),
            ("settings", "updateNetwork"),
        ] {
            let error = bridge
                .dispatch(
                    "ios.hostMutate",
                    json!({
                        "endpoint":endpoint, "method":method, "input":[], "secret":"attachment"
                    }),
                )
                .await
                .unwrap_err();
            assert!(error.contains("must be a JSON object"), "{error}");
        }
    }

    #[tokio::test]
    async fn a_redeemed_profile_waiting_to_save_survives_disconnect_but_not_remove() {
        for unpair in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let attached =
                HostBridge::attach(HostChannel::new(), dir.path().into(), Handle::current())
                    .unwrap();
            let bridge = &attached.bridge;
            let profile: HostProfile = serde_json::from_value(json!({
                "rootId":"root", "hostName":"Paired Host", "hostPeerId":bridge.peer_id,
                "relays":[], "directEndpoints":[],
            }))
            .unwrap();
            let cancel = CancellationToken::new();
            let id = {
                let mut state = bridge.state.lock().await;
                let id = state.start_admission("root", cancel.clone());
                state.redeeming.insert(id, "root".into());
                id
            };
            let edit = bridge.profile_edits.lock().await;
            let remove = bridge.dispatch("ios.removeHost", json!({"rootId":"root"}));
            tokio::pin!(remove);
            if unpair {
                assert!(futures_util::poll!(&mut remove).is_pending());
            }
            // This is the post-redeem path: the invite is spent and a profile is ready.
            let save = bridge.save_redeemed(id, profile, None);
            tokio::pin!(save);
            assert!(futures_util::poll!(&mut save).is_pending());
            if !unpair {
                bridge
                    .dispatch("ios.disconnectHost", json!({"rootId":"root"}))
                    .await
                    .unwrap();
            }
            drop(edit);
            if unpair {
                remove.await.unwrap();
                assert!(save.await.unwrap_err().contains("removed"));
            } else {
                save.await.unwrap();
            }
            assert!(cancel.is_cancelled());
            let stored = SavedHosts::load(&bridge.profile_path).unwrap();
            assert_eq!(stored.get("root").is_some(), !unpair);
            let snapshot = bridge.dispatch("ios.bootstrap", json!({})).await.unwrap();
            assert!(snapshot["active"].is_null());
            assert_eq!(
                snapshot["hosts"].as_array().unwrap().len(),
                usize::from(!unpair)
            );
        }
    }

    #[tokio::test]
    async fn cancelled_websocket_anchor_drops_the_connection_before_admission() {
        let dir = tempfile::tempdir().unwrap();
        let attached =
            HostBridge::attach(HostChannel::new(), dir.path().into(), Handle::current()).unwrap();
        let bridge = attached.bridge.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let args = input(&listener);
        let connecting =
            tokio::spawn(async move { bridge.dispatch("ios.connectWebSocket", args).await });
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut ws = open_anchor(&listener).await;
            attached
                .bridge
                .dispatch("ios.cancelPairing", Value::Null)
                .await
                .unwrap();
            assert_eq!(
                connecting.await.unwrap().unwrap_err(),
                "connection cancelled"
            );
            assert!(matches!(ws.next().await, None | Some(Err(_))));
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn stale_ui_anchor_cannot_put_query_mutation_or_subscription_on_the_new_host() {
        let dir = tempfile::tempdir().unwrap();
        let attached =
            HostBridge::attach(HostChannel::new(), dir.path().into(), Handle::current()).unwrap();
        let bridge = attached.bridge.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let args = input(&listener);
        let connecting =
            tokio::spawn(async move { bridge.dispatch("ios.connectWebSocket", args).await });
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut ws = open_anchor(&listener).await;
            let session = Uuid::new_v4();
            let connected = json!({"kind":"connected", "value":{
                "version":1,"epoch":Uuid::new_v4(),"session":session,
                "source":{"stateDomain":"root","deployment":Uuid::new_v4(),"revision":1},
                "consumers":{"agent":[Uuid::new_v4()]},
                "catalogue":{"endpoints":{"agent":{"registration_epoch":Uuid::new_v4()}}},
            }});
            let bytes = serde_json::to_vec(&connected).unwrap();
            let mut frame = u32::try_from(bytes.len()).unwrap().to_be_bytes().to_vec();
            frame.extend_from_slice(&bytes);
            ws.send(Message::Binary(frame.into())).await.unwrap();
            let state = connecting.await.unwrap().unwrap();
            assert_eq!(state["active"]["session"], session.to_string());
            let stale = json!({"anchorSession":Uuid::new_v4(),"endpoint":"agent","method":"openBot",
                               "input":{},"subscriptionId":"watch"});
            for method in ["ios.hostQuery", "ios.hostMutate"] {
                assert_eq!(
                    attached
                        .bridge
                        .dispatch(method, stale.clone())
                        .await
                        .unwrap_err(),
                    "remote Host anchor no longer matches UI"
                );
            }
            assert!(matches!(attached.bridge.open_subscription(stale).await,
                Err(reason) if reason == "remote Host anchor no longer matches UI"));
        })
        .await
        .unwrap();
    }

    async fn send_frame(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        value: Value,
    ) {
        let bytes = serde_json::to_vec(&value).unwrap();
        let mut frame = u32::try_from(bytes.len()).unwrap().to_be_bytes().to_vec();
        frame.extend_from_slice(&bytes);
        ws.send(Message::Binary(frame.into())).await.unwrap();
    }

    async fn read_frame(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Value {
        let _prefix = ws.next().await.unwrap().unwrap();
        serde_json::from_slice(&ws.next().await.unwrap().unwrap().into_data()).unwrap()
    }

    #[tokio::test]
    async fn another_host_can_disconnect_while_a_query_and_a_mutation_are_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let attached =
            HostBridge::attach(HostChannel::new(), dir.path().into(), Handle::current()).unwrap();
        let bridge = &attached.bridge;
        let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let b = TcpListener::bind("127.0.0.1:0").await.unwrap();

        tokio::time::timeout(Duration::from_secs(3), async {
            let session_a = Uuid::new_v4();
            let session_b = Uuid::new_v4();
            let connect = |listener: &TcpListener, root: &str| {
                let mut args = input(listener);
                args["rootId"] = json!(root);
                bridge.dispatch("ios.connectWebSocket", args)
            };
            let (a_state, b_state, anchor_a, _anchor_b) = tokio::join!(
                connect(&a, "a"),
                connect(&b, "b"),
                admit_anchor(&a, "a", session_a),
                admit_anchor(&b, "b", session_b),
            );
            a_state.unwrap();
            b_state.unwrap();
            let args = |method| {
                json!({
                    "rootId": "b", "endpoint": "agent", "method": method, "input": {}
                })
            };
            let (query, mutation, ()) =
                tokio::join!(
                    bridge.dispatch("ios.hostQuery", args("read")),
                    bridge.dispatch("ios.hostMutate", args("write")),
                    async {
                        let (method, first) = open_rpc(&b, session_b).await;
                        let (other, second) = open_rpc(&b, session_b).await;
                        assert_ne!(method, other);
                        let (mut query, mut mutation) = if method == "read" {
                            (first, second)
                        } else {
                            (second, first)
                        };
                        let reference = json!({"operation": Uuid::new_v4()});
                        send_frame(
                            &mut mutation,
                            json!({"kind":"prepared","reference":reference}),
                        )
                        .await;
                        assert_eq!(read_frame(&mut mutation).await["kind"], "confirm");

                        drop(anchor_a);
                        loop {
                            let state = bridge.dispatch("ios.bootstrap", json!({})).await.unwrap();
                            if state["connections"]["a"]["status"] != "connected" {
                                assert_eq!(
                                    state["connections"]["b"]["connection"]["session"],
                                    session_b.to_string()
                                );
                                break;
                            }
                            tokio::task::yield_now().await;
                        }

                        send_frame(&mut query, json!({
                        "kind":"finished","result":{"Ok":"read result"},"cleanup":{"Ok":null}
                    })).await;
                        send_frame(
                            &mut mutation,
                            json!({
                                "kind":"mutation","cleanup":{"Ok":null},
                                "reply":{"reference":reference,"receipt":{
                                    "kind":"recorded","outcome":{"kind":"returned",
                                        "result":{"kind":"success","value":"write result"}}
                                }}
                            }),
                        )
                        .await;
                    },
                );
            assert_eq!(query.unwrap()["value"], "read result");
            assert_eq!(mutation.unwrap()["value"], "write result");
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slow_js_progress_is_bounded_and_old_calls_cannot_emit_after_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let channel = HostChannel::new();
        let attached =
            HostBridge::attach(channel.clone(), dir.path().into(), Handle::current()).unwrap();
        let bridge = &attached.bridge;
        let bundle = nsh_engine::Bundle::source(
            r#"
            import { host } from 'nsh';
            let progress = [];
            host.on('ios.mutationProgress', event => progress.push(event));
            host.on('test.mutate', async (data) => {
                try {
                    const reply = await host.call('ios.hostMutate', data);
                    host.post('test.reply', {reply, progress});
                } catch (error) {
                    host.post('test.reply', {error: String(error), progress});
                } finally {
                    progress = [];
                }
            });
        "#
            .to_owned(),
        )
        .with_capabilities_json(Some(r#"{"host":true}"#))
        .unwrap();
        let (send, mut replies) = tokio::sync::mpsc::unbounded_channel();
        channel.handle("test.reply", move |mut call| {
            send.send(call.take_data()).unwrap()
        });
        let mut engine = nsh_engine::EngineConfig::new(bundle);
        engine.host = channel.clone();
        engine.runtime = Some(Handle::current());
        let _app = nsh_testing::Headless::start(engine).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();

        tokio::time::timeout(Duration::from_secs(5), async {
            let connect = async |session| {
                let (snap, anchor) = tokio::join!(
                    bridge.dispatch("ios.connectWebSocket", input(&listener)),
                    admit_anchor(&listener, "root", session),
                );
                (snap.unwrap()["active"]["generation"].clone(), anchor)
            };
            let start = |generation| {
                channel
                    .send(
                        "test.mutate",
                        json!({
                            "rootId":"root", "generation":generation, "endpoint":"agent",
                            "method":"write", "input":{}, "progressId":"shared",
                        }),
                    )
                    .unwrap();
            };
            let old_session = Uuid::new_v4();
            let (old_generation, _old_anchor) = connect(old_session).await;
            start(old_generation.clone());
            let (_, mut old_call) = open_rpc(&listener, old_session).await;
            let old_ref = prepare_mutation(&mut old_call).await;

            let session = Uuid::new_v4();
            let (generation, _anchor) = connect(session).await;
            assert_ne!(old_generation, generation);
            send_frame(&mut old_call, json!({"kind":"progress","value":"stale"})).await;
            finish_mutation(&mut old_call, old_ref).await;
            let old = replies.recv().await.unwrap();
            assert!(old["error"].as_str().unwrap().contains("Host changed"));
            assert_eq!(old["progress"], json!([]));

            start(generation.clone());
            let (_, mut call) = open_rpc(&listener, session).await;
            let reference = prepare_mutation(&mut call).await;
            for i in 0..PROGRESS_WINDOW * 4 {
                send_frame(&mut call, json!({"kind":"progress","value":i})).await;
            }
            finish_mutation(&mut call, reference).await;
            let response = replies.recv().await.unwrap();
            assert_eq!(response["reply"]["value"], "done");
            let progress = response["progress"].as_array().unwrap();
            assert_eq!(progress.len(), PROGRESS_WINDOW);
            for (i, event) in progress.iter().enumerate() {
                assert_eq!(event["rootId"], "root");
                assert_eq!(event["generation"], generation);
                assert_eq!(event["progressId"], "shared");
                assert_eq!(event["value"], i);
            }

            bridge
                .dispatch("ios.ackMutationProgress", progress[0]["credit"].clone())
                .await
                .unwrap();
            start(generation);
            let (_, mut call) = open_rpc(&listener, session).await;
            prepare_mutation(&mut call).await;
            send_frame(&mut call, json!({"kind":"progress","value":"one credit"})).await;
            send_frame(&mut call, json!({"kind":"progress","value":"no credit"})).await;
            send_frame(
                &mut call,
                json!({"kind":"aborted","reason":"mutation failed"}),
            )
            .await;
            let response = replies.recv().await.unwrap();
            assert!(
                response["error"]
                    .as_str()
                    .unwrap()
                    .contains("mutation failed")
            );
            let progress = response["progress"].as_array().unwrap();
            assert_eq!(progress.len(), 1);
            assert_eq!(progress[0]["value"], "one credit");
        })
        .await
        .unwrap();
    }

    async fn prepare_mutation(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Value {
        let reference = json!({"operation":Uuid::new_v4()});
        send_frame(ws, json!({"kind":"prepared","reference":reference})).await;
        assert_eq!(read_frame(ws).await["kind"], "confirm");
        reference
    }

    async fn finish_mutation(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        reference: Value,
    ) {
        send_frame(
            ws,
            json!({
                "kind":"mutation","cleanup":{"Ok":null},
                "reply":{"reference":reference,"receipt":{"kind":"recorded","outcome":{
                    "kind":"returned","result":{"kind":"success","value":"done"},
                }}},
            }),
        )
        .await;
    }

    async fn admit_anchor(
        listener: &TcpListener,
        root: &str,
        session: Uuid,
    ) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
        let mut ws = open_anchor(listener).await;
        send_frame(
            &mut ws,
            json!({"kind":"connected", "value":{
                "version":1,"epoch":Uuid::new_v4(),"session":session,
                "source":{"stateDomain":root,"deployment":Uuid::new_v4(),"revision":1},
                "consumers":{"agent":[Uuid::new_v4()]},
                "catalogue":{"endpoints":{"agent":{"registration_epoch":Uuid::new_v4()}}},
            }}),
        )
        .await;
        ws
    }

    async fn open_rpc(
        listener: &TcpListener,
        session: Uuid,
    ) -> (
        String,
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(socket).await.unwrap();
        assert_eq!(
            read_frame(&mut ws).await["request"]["session"],
            session.to_string()
        );
        send_frame(&mut ws, json!({"kind":"accepted"})).await;
        let call = read_frame(&mut ws).await;
        assert_eq!(read_frame(&mut ws).await, json!({}));
        send_frame(&mut ws, json!({"kind":"ready"})).await;
        (call["method"].as_str().unwrap().to_owned(), ws)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn receipts_are_read_for_both_early_and_late_registrations() {
        let dir = tempfile::tempdir().unwrap();
        let attached =
            HostBridge::attach(HostChannel::new(), dir.path().into(), Handle::current()).unwrap();
        let bridge = attached.bridge.clone();
        let host_peer_id = bridge.peer_id.to_string();
        let scope = ReceiptScope {
            root: "root".into(),
            host_peer_id: host_peer_id.clone(),
        };
        let original = bridge.state.lock().await.next_generation();
        bridge.state.lock().await.profiles.insert(scope.root.clone(), serde_json::from_value(json!({
            "rootId":"root","hostName":"test","hostPeerId":host_peer_id,"relays":[],"directEndpoints":[]
        })).unwrap());
        let early = json!({"operation":Uuid::new_v4()});
        let late = json!({"operation":Uuid::new_v4()});
        bridge
            .register_uncertain(original, scope.clone(), early.clone())
            .await;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/runtime-host", listener.local_addr().unwrap());
        let new = bridge
            .state
            .lock()
            .await
            .start_admission("root", CancellationToken::new());
        let connecting = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                let connection = RemoteHostConnection::connect_websocket(
                    &endpoint,
                    TlsTrust::System,
                    "fixture".into(),
                    "root",
                    "test".into(),
                )
                .await
                .unwrap();
                // Use the local wire fixture for RPC bytes; production uses the same
                // receipt query framing over the admitted QUIC connection.
                bridge
                    .install(new, "test".into(), connection, "quic", None)
                    .await
                    .unwrap()
            }
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut anchor = open_anchor(&listener).await;
            let session = Uuid::new_v4();
            send_frame(
                &mut anchor,
                json!({"kind":"connected","value":{
                    "version":1,"epoch":Uuid::new_v4(),"session":session,
                    "source":{"stateDomain":"root","deployment":Uuid::new_v4(),"revision":1},
                    "consumers":{"receipts":[Uuid::new_v4()]},
                    "catalogue":{"endpoints":{"receipts":{"registration_epoch":Uuid::new_v4()}}}
                }}),
            )
            .await;
            connecting.await.unwrap();

            let mut config = crate::engine_config(bridge.channel.clone(), Handle::current());
            config.viewport =
                nsh_core::Size::new(nsh_core::prelude::px(390.), nsh_core::prelude::px(844.));
            config.environment.reduce_motion = true;
            let mut app = nsh_testing::Headless::start(config).unwrap();
            app.wait_for("text:test · Online").unwrap();

            answer_receipt(&listener, session, &early, json!({"kind":"not_recorded"})).await;
            app.wait_for("text:/Recovered 0 results.*1 operation is still unconfirmed/")
                .unwrap();
            bridge
                .register_uncertain(original, scope, late.clone())
                .await;
            answer_receipt(
                &listener,
                session,
                &late,
                json!({"kind":"recorded","outcome":{"kind":"returned"}}),
            )
            .await;
            app.wait_for("text:/Recovered 1 result.*1 operation is still unconfirmed/")
                .unwrap();
        })
        .await
        .unwrap();
    }

    async fn answer_receipt(
        listener: &TcpListener,
        session: Uuid,
        reference: &Value,
        receipt: Value,
    ) {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(socket).await.unwrap();
        assert_eq!(
            read_frame(&mut ws).await["request"]["session"],
            session.to_string()
        );
        send_frame(&mut ws, json!({"kind":"accepted"})).await;
        let call = read_frame(&mut ws).await;
        assert_eq!(call["endpoint"], "receipts");
        assert_eq!(call["method"], "read");
        assert_eq!(&call["input"], reference);
        let _descriptors = read_frame(&mut ws).await;
        send_frame(&mut ws, json!({"kind":"ready"})).await;
        send_frame(
            &mut ws,
            json!({"kind":"finished",
                "result":{"Ok":{"reference":reference,"receipt":receipt}},
                "cleanup":{"Ok":null}
            }),
        )
        .await;
    }
}
