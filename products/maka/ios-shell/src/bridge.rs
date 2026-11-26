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
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    runtime::Handle,
    sync::{Mutex, oneshot, watch},
    task::AbortHandle,
};
use tokio_util::sync::CancellationToken;

const PAIR_SCHEME: &str = "maka://pair/v1?payload=";
const PROGRESS_WINDOW: u64 = 8;
const PROGRESS_ACK_STALL_TIMEOUT: Duration = Duration::from_secs(30);
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
    device_label: Option<String>,
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
    retired: CancellationToken,
    subscriptions: BTreeMap<String, (u64, AbortHandle)>,
}

impl Drop for ActiveHost {
    fn drop(&mut self) {
        self.retired.cancel();
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

struct ProgressWindow {
    sent: u64,
    acknowledged: watch::Sender<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressAck {
    delivery_id: u64,
    sequence: u64,
}

#[derive(Default)]
struct State {
    generation: u64,
    pairing: Option<Attempt>,
    pending: Option<Pending>,
    redeeming: BTreeMap<u64, RootId>,
    mutation_progress: BTreeMap<u64, ProgressWindow>,
    // The legacy pairing screen also uses cancelPairing for manual WebSocket admission.
    manual: Option<RootId>,
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
    }

    fn latest_connection(&self) -> Option<(&RootId, &ActiveHost)> {
        self.connections.iter().max_by_key(|(_, active)| active.id)
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
    shutdown: CancellationToken,
    progress_ack_stall_timeout: Duration,
    runtime: Handle,
}

struct MutationProgress<'a> {
    caller: &'a HostCall,
    progress_id: &'a str,
    delivery_id: u64,
    retired: CancellationToken,
    ack: watch::Receiver<u64>,
    stalled: AtomicBool,
}

impl MutationProgress<'_> {
    async fn emit(&self, bridge: &Bridge, root: &str, generation: u64, value: Value) {
        if self.stalled.load(Ordering::Relaxed) {
            return;
        }
        let mut ack = self.ack.clone();
        let mut event = json!({
            "rootId": root, "generation": generation, "progressId": self.progress_id,
            "deliveryId": self.delivery_id,
        });
        event["value"] = value;
        loop {
            let mut state = bridge.state.lock().await;
            if self.retired.is_cancelled() || state.current(root, generation).is_none() {
                return;
            }
            let window = state
                .mutation_progress
                .get_mut(&self.delivery_id)
                .expect("active delivery");
            if window.sent - *ack.borrow_and_update() < PROGRESS_WINDOW {
                let sequence = window.sent + 1;
                event["sequence"] = sequence.into();
                if bridge
                    .channel
                    .send_to_caller(self.caller, "ios.mutationProgress", event)
                    .expect("valid progress event name")
                {
                    window.sent = sequence;
                }
                return;
            }
            drop(state);
            // A dead or stalled consumer must not hold up the terminal receipt.
            tokio::select! {
                biased;
                _ = self.retired.cancelled() => return,
                _ = bridge.channel.caller_detached(self.caller) => return,
                changed = ack.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                _ = tokio::time::sleep(bridge.progress_ack_stall_timeout) => {
                    self.stalled.store(true, Ordering::Relaxed);
                    log::warn!(
                        "iOS mutation progress ACK stalled for Host {root}, delivery {}; continuing without progress",
                        self.delivery_id,
                    );
                    return;
                }
            }
        }
    }
}

impl HostBridge {
    pub fn attach(
        channel: HostChannel,
        support_dir: PathBuf,
        runtime: Handle,
    ) -> Result<Self, String> {
        Self::attach_with_progress_stall_timeout(
            channel,
            support_dir,
            runtime,
            PROGRESS_ACK_STALL_TIMEOUT,
        )
    }

    fn attach_with_progress_stall_timeout(
        channel: HostChannel,
        support_dir: PathBuf,
        runtime: Handle,
        progress_ack_stall_timeout: Duration,
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
            shutdown: CancellationToken::new(),
            progress_ack_stall_timeout,
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
                    } else if name == "ios.hostMutate" {
                        let result = bridge.mutate(data, Some(&call)).await;
                        call.reply(result);
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
        self.bridge.shutdown.cancel();
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
        let mut hosts: Vec<_> = state
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
                    "status": status["status"],
                })
            })
            .collect();
        hosts.extend(
            state
                .connections
                .iter()
                .filter(|(root, _)| !state.profiles.contains_key(*root))
                .map(|(root, active)| {
                    json!({
                        "rootId": root,
                        "hostName": active.info["hostName"],
                        "peerId": "",
                        "endpoints": [],
                        "ephemeral": true,
                        "status": "connected",
                    })
                }),
        );
        json!({
            "revision": self.snapshot_revision.fetch_add(1, Ordering::Relaxed) + 1,
            "devicePeerId": self.peer_id,
            "hosts": hosts,
            "active": state.latest_connection().map(|(_, active)| &active.info),
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
                    if state.redeeming.is_empty() {
                        state.cancel_pairing();
                    }
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
                    .or_else(|| state.latest_connection().map(|(root, _)| root.clone()))
                    && (state.connections.contains_key(&root)
                        || state.admissions.contains_key(&root))
                {
                    state.clear_admission(&root);
                    state.remove_connection(&root);
                    if state.profiles.contains_key(&root) {
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
                let (root, id, calls) = self.calls(&rpc).await?;
                let value = calls
                    .query(&rpc.endpoint, &rpc.method, rpc.input)
                    .await
                    .map_err(error)?;
                self.check_active(&root, id).await?;
                Ok(json!({"value": value}))
            }
            "ios.ackMutationProgress" => {
                let ProgressAck {
                    delivery_id,
                    sequence,
                } = decode(data)?;
                // JS receives events in order, but its ACK tasks can run out of order.
                if let Some(window) = self.state.lock().await.mutation_progress.get(&delivery_id)
                    && sequence <= window.sent
                {
                    window.acknowledged.send_if_modified(|acknowledged| {
                        if sequence <= *acknowledged {
                            return false;
                        }
                        *acknowledged = sequence;
                        true
                    });
                }
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

    async fn mutate(&self, mut data: Value, caller: Option<&HostCall>) -> Result<Value, String> {
        // Do not feed a credential to serde's diagnostics or the Host's JSON input.
        let secret = match data.as_object_mut().and_then(|data| data.remove("secret")) {
            Some(Value::String(secret)) => Some(secret),
            None | Some(Value::Null) => None,
            Some(_) => return Err("secret must be UTF-8 text".into()),
        };
        let rpc: Rpc = decode(data)?;
        let attachments = credential_attachments(&rpc, secret)?;
        if rpc.root_id.is_some() && rpc.generation.is_none() {
            return Err("root-scoped mutations require a connection generation".into());
        }
        let (root, id, calls, receipt_scope, progress) = {
            let mut state = self.state.lock().await;
            let (root, host) = Self::target(&state, &rpc)?;
            let retired = host.retired.clone();
            let (root, id, calls, receipt_scope) = (
                root.clone(),
                host.id,
                host.calls.clone(),
                host.receipt_scope.clone(),
            );
            let progress = caller
                .filter(|call| !call.is_post())
                .zip(rpc.progress_id.as_deref())
                .map(|(caller, progress_id)| {
                    let delivery_id = state.next_generation();
                    let (acknowledged, ack) = watch::channel(0);
                    state.mutation_progress.insert(
                        delivery_id,
                        ProgressWindow {
                            sent: 0,
                            acknowledged,
                        },
                    );
                    MutationProgress {
                        caller,
                        progress_id,
                        delivery_id,
                        retired,
                        ack,
                        stalled: AtomicBool::new(false),
                    }
                });
            (root, id, calls, receipt_scope, progress)
        };
        let result = calls
            .mutate_with_progress(
                &rpc.endpoint,
                &rpc.method,
                rpc.input,
                attachments,
                |value| {
                    let progress = progress.as_ref();
                    let root = root.as_str();
                    async move {
                        if let Some(progress) = progress {
                            progress.emit(self, root, id, value).await;
                        }
                    }
                },
            )
            .await;
        if let Some(progress) = progress {
            self.state
                .lock()
                .await
                .mutation_progress
                .remove(&progress.delivery_id);
        }
        if let Err(RemoteClientError::MutationUncertain { reference, .. }) = &result
            && let Some(scope) = receipt_scope
        {
            self.register_uncertain(id, scope, reference.clone()).await;
        }
        let value = match result {
            Err(RemoteClientError::MutationCleanup {
                reference, result, ..
            }) => {
                log::warn!(
                    "remote Host mutation cleanup failed (operation {})",
                    reference["operation"]
                );
                result.map_err(error)?
            }
            result => result.map_err(error)?,
        };
        Ok(json!({"value": value}))
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
        if confirm
            .device_label
            .as_deref()
            .is_some_and(|name| name.trim().len() > 128)
        {
            return Err("Device name exceeds 128 UTF-8 bytes".into());
        }
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
        let result = self.confirm_pairing(pending, id, &cancel, confirm).await;
        self.state.lock().await.redeeming.remove(&id);
        self.finish_admission(&root, id, &cancel, &result).await;
        self.finish_pairing(pairing_id).await;
        if let Ok(snapshot) = &result {
            self.emit("ios.hostState", snapshot.clone());
        }
        result
    }

    async fn confirm_pairing(
        &self,
        pending: Pending,
        id: u64,
        cancel: &CancellationToken,
        confirm: Confirm,
    ) -> Result<Value, String> {
        let label = confirm
            .device_label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Maka for iOS");
        let redeemed = pending
            .pairing
            .redeem(&confirm.sas, Some(label.to_owned()))
            .await
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
        let retired = self.shutdown.child_token();
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
            state.connections.insert(root.into(), ActiveHost {
                id,
                calls: connection.call_handle(),
                receipt_scope,
                retired: retired.clone(),
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
            bridge.monitor(id, connection, retired).await;
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
        retired: CancellationToken,
    ) {
        let root = connection.root_id().to_owned();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        {
            let calls = connection.call_handle();
            let disconnected = connection.disconnected();
            tokio::pin!(disconnected);
            loop {
                tokio::select! {
                    biased;
                    _ = retired.cancelled() => {
                        break;
                    }
                    disconnected = &mut disconnected => {
                        let mut state = self.state.lock().await;
                        if state.current(&root, id).is_some() {
                            state.remove_connection(&root);
                            let error = disconnected.err().map(|err| err.to_string());
                            if state.profiles.contains_key(&root) {
                                state.admissions.entry(root.clone()).or_insert_with(|| match &error {
                                    Some(reason) => Admission::Error(reason.clone()),
                                    None => Admission::Offline,
                                });
                            }
                            let mut snapshot = self.snapshot(&state);
                            if let Some(error) = error
                                && state.profiles.contains_key(&root)
                            {
                                snapshot["disconnectedRootId"] = json!(root);
                                snapshot["disconnectReason"] = json!(error);
                            }
                            self.emit("ios.hostState", snapshot);
                        }
                        return;
                    }
                    _ = interval.tick() => {
                        let path = path_summary(calls.path_summary());
                        let mut state = self.state.lock().await;
                        if let Some(active) = state.connections.get_mut(&root).filter(|active| active.id == id)
                            && active.info["pathSummary"] != path
                        {
                            active.info["pathSummary"] = path.clone();
                            self.emit("ios.hostPath", json!({ "rootId": root, "generation": id, "pathSummary": path }));
                        }
                    }
                }
            }
        }
        match tokio::time::timeout(Duration::from_secs(3), connection.close()).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => log::warn!("close remote Host: {err}"),
            Err(err) => log::warn!("close remote Host timed out: {err}"),
        }
    }

    async fn calls(&self, rpc: &Rpc) -> Result<(RootId, u64, RemoteCallHandle), String> {
        let state = self.state.lock().await;
        let (root, active) = Self::target(&state, rpc)?;
        Ok((root.clone(), active.id, active.calls.clone()))
    }

    fn target<'a>(state: &'a State, rpc: &Rpc) -> Result<(&'a RootId, &'a ActiveHost), String> {
        // Without an explicit root, require the selected anchor as before.
        // Explicit-root callers can independently pin a connection generation.
        let target = match &rpc.root_id {
            Some(root) => state.connections.get_key_value(root),
            None => state.latest_connection().filter(|(_, active)| {
                rpc.anchor_session
                    .as_ref()
                    .is_some_and(|session| active.info["session"] == *session)
            }),
        };
        target
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
            })
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
        let (root, active, calls) = self.calls(&rpc).await?;
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
        let mut finalizing = accept_async(socket).await.unwrap();
        let finalize = read_frame(&mut finalizing).await;
        assert_eq!(finalize["request"]["kind"], "finalize_access");
        send_frame(
            &mut finalizing,
            json!({"kind":"finalized","value":{"Ok":null}}),
        )
        .await;

        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(socket).await.unwrap();
        let open = read_frame(&mut ws).await;
        assert_eq!(open["request"]["kind"], "connect");
        assert_eq!(open["client_instance"], finalize["client_instance"]);
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
                } else if call == "ios.hostMutate" {
                    bridge.mutate(args, None).await.unwrap_err()
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
                .mutate(
                    json!({
                        "endpoint":endpoint, "method":method, "input":[], "secret":"attachment"
                    }),
                    None,
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
            let (query, mutation) = tokio::join!(
                attached.bridge.dispatch("ios.hostQuery", stale.clone()),
                attached.bridge.mutate(stale.clone(), None),
            );
            assert_eq!(
                query.unwrap_err(),
                "remote Host anchor no longer matches UI"
            );
            assert_eq!(
                mutation.unwrap_err(),
                "remote Host anchor no longer matches UI"
            );
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
            let b_generation = b_state.unwrap()["connections"]["b"]["connection"]["generation"].clone();
            let args = |method| {
                json!({
                    "rootId": "b", "generation": b_generation, "endpoint": "agent", "method": method, "input": {}
                })
            };
            let (query, mutation, ()) =
                tokio::join!(
                    bridge.dispatch("ios.hostQuery", args("read")),
                    bridge.mutate(args("write"), None),
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
    async fn progress_backpressure_is_lossless_and_isolated_to_the_call() {
        let (_dir, host, app, mut events) = progress_fixture(PROGRESS_ACK_STALL_TIMEOUT);
        let bridge = &host.bridge;
        let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let (a_generation, a_session, _anchor_a) = progress_host(bridge, &a, "a").await;
            let (b_generation, b_session, _anchor_b) = progress_host(bridge, &b, "b").await;
            let (mut a_call, a_ref) =
                start_progress(bridge, &a, "a", a_generation, a_session).await;
            for step in 0..PROGRESS_WINDOW * 2 {
                send_frame(&mut a_call, json!({"kind":"progress","value":step})).await;
            }
            finish_mutation(&mut a_call, a_ref).await;

            let mut last = Value::Null;
            for step in 0..PROGRESS_WINDOW {
                last = events.recv().await.unwrap();
                assert_progress(&last, "a", a_generation, json!(step));
            }

            // B's only prompt and its terminal error arrive while A is still unacked.
            let (mut b_call, _) = start_progress(bridge, &b, "b", b_generation, b_session).await;
            let prompt = json!({"url":"https://login.example.test/device","user_code":"SINGLE"});
            send_frame(&mut b_call, json!({"kind":"progress","value":prompt})).await;
            send_frame(
                &mut b_call,
                json!({"kind":"aborted","reason":"login failed"}),
            )
            .await;
            assert_progress(&events.recv().await.unwrap(), "b", b_generation, prompt);
            let terminal = events.recv().await.unwrap();
            assert_eq!(terminal["rootId"], "b");
            assert!(terminal["error"].as_str().unwrap().contains("login failed"));
            assert!(events.try_recv().is_err(), "unacked A exceeded its window");

            // Returning only one credit must deliver exactly the next frame.
            ack_progress(bridge, &last, 1);
            assert_progress(
                &events.recv().await.unwrap(),
                "a",
                a_generation,
                json!(PROGRESS_WINDOW),
            );
            ack_progress(bridge, &last, PROGRESS_WINDOW);
            for step in PROGRESS_WINDOW + 1..PROGRESS_WINDOW * 2 {
                assert_progress(
                    &events.recv().await.unwrap(),
                    "a",
                    a_generation,
                    json!(step),
                );
            }
            // The terminal reply does not require ACKs for the last window.
            assert_eq!(
                events.recv().await.unwrap(),
                json!({"rootId":"a","reply":{"value":"done"}}),
            );
        })
        .await
        .unwrap();
        drop(app);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retiring_the_host_wakes_unacked_progress_without_masking_the_error() {
        let (_dir, host, app, mut events) = progress_fixture(PROGRESS_ACK_STALL_TIMEOUT);
        let bridge = &host.bridge;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let (old, session, _anchor) = progress_host(bridge, &listener, "root").await;
            let (mut blocked, _) = start_progress(bridge, &listener, "root", old, session).await;
            fill_progress_window(&mut blocked, &mut events, old).await;
            send_frame(
                &mut blocked,
                json!({"kind":"aborted","reason":"original error"}),
            )
            .await;

            let (new, session, _anchor) = progress_host(bridge, &listener, "root").await;
            assert_ne!(old, new);
            let terminal = events.recv().await.unwrap();
            assert_eq!(terminal["rootId"], "root");
            assert!(
                terminal["error"]
                    .as_str()
                    .unwrap()
                    .contains("original error")
            );

            let (mut call, reference) =
                start_progress(bridge, &listener, "root", new, session).await;
            send_frame(&mut call, json!({"kind":"progress","value":"fresh"})).await;
            finish_mutation(&mut call, reference).await;
            assert_progress(&events.recv().await.unwrap(), "root", new, json!("fresh"));
            assert_eq!(
                events.recv().await.unwrap(),
                json!({"rootId":"root","reply":{"value":"done"}}),
            );
        })
        .await
        .unwrap();
        drop(app);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detaching_the_app_or_dropping_the_bridge_wakes_unacked_progress() {
        for detach_app in [true, false] {
            let (_dir, host, app, mut events) = progress_fixture(PROGRESS_ACK_STALL_TIMEOUT);
            let bridge = host.bridge.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                let (generation, session, _anchor) =
                    progress_host(&bridge, &listener, "root").await;
                let (mut call, _) =
                    start_progress(&bridge, &listener, "root", generation, session).await;
                fill_progress_window(&mut call, &mut events, generation).await;
                send_frame(&mut call, json!({"kind":"aborted","reason":"last error"})).await;
                if detach_app {
                    drop(app);
                    assert!(matches!(call.next().await, None | Some(Err(_))));
                } else {
                    drop(host);
                    let terminal = events.recv().await.unwrap();
                    assert!(terminal["error"].as_str().unwrap().contains("last error"));
                    drop(app);
                }
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stalled_progress_leaves_the_terminal_host_error_visible() {
        let stall_timeout = Duration::from_millis(50);
        let (_dir, host, _app, mut events) = progress_fixture(stall_timeout);
        let bridge = &host.bridge;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let (generation, session, _anchor) = progress_host(bridge, &listener, "root").await;
            let (mut call, _) =
                start_progress(bridge, &listener, "root", generation, session).await;
            for step in 0..PROGRESS_WINDOW {
                send_frame(&mut call, json!({"kind":"progress","value":step})).await;
                assert_progress(
                    &events.recv().await.unwrap(),
                    "root",
                    generation,
                    json!(step),
                );
            }

            let start = tokio::time::Instant::now();
            for step in PROGRESS_WINDOW..2 * PROGRESS_WINDOW {
                send_frame(&mut call, json!({"kind":"progress","value":step})).await;
            }
            send_frame(
                &mut call,
                json!({"kind":"aborted","reason":"Host aborted the mutation"}),
            )
            .await;

            let reply = events.recv().await.unwrap();
            assert_eq!(reply["rootId"], "root");
            assert!(
                reply["error"]
                    .as_str()
                    .unwrap()
                    .contains("Host aborted the mutation")
            );
            assert!(start.elapsed() >= stall_timeout);
            assert!(
                events.try_recv().is_err(),
                "stalled call exceeded the progress window"
            );
        })
        .await
        .expect("stalled progress blocked the terminal Host error");
    }

    fn progress_fixture(
        stall_timeout: Duration,
    ) -> (
        tempfile::TempDir,
        HostBridge,
        nsh_testing::Headless,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let channel = HostChannel::new();
        let host = HostBridge::attach_with_progress_stall_timeout(
            channel.clone(),
            dir.path().into(),
            Handle::current(),
            stall_timeout,
        )
        .unwrap();
        let bundle = nsh_engine::Bundle::source(
            r#"
            import { host } from 'nsh';
            host.on('ios.mutationProgress', event => host.post('test.event', event));
            host.on('test.ack', ack => host.post('ios.ackMutationProgress', ack));
            host.on('test.mutate', async (data) => {
                const {rootId} = data;
                try {
                    const reply = await host.call('ios.hostMutate', data, {timeout: 0});
                    host.post('test.event', {rootId, reply});
                } catch (error) {
                    host.post('test.event', {rootId, error: String(error)});
                }
            });
        "#
            .to_owned(),
        )
        .with_capabilities_json(Some(r#"{"host":true}"#))
        .unwrap();
        let (events, received) = tokio::sync::mpsc::unbounded_channel();
        channel.handle("test.event", move |mut call| {
            events.send(call.take_data()).unwrap();
        });
        let mut engine = nsh_engine::EngineConfig::new(bundle);
        engine.host = channel;
        engine.runtime = Some(Handle::current());
        (
            dir,
            host,
            nsh_testing::Headless::start(engine).unwrap(),
            received,
        )
    }

    async fn progress_host(
        bridge: &Bridge,
        listener: &TcpListener,
        root: &str,
    ) -> (
        u64,
        Uuid,
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        let session = Uuid::new_v4();
        let mut args = input(listener);
        args["rootId"] = json!(root);
        let (snap, anchor) = tokio::join!(
            bridge.dispatch("ios.connectWebSocket", args),
            admit_anchor(listener, root, session),
        );
        (
            snap.unwrap()["active"]["generation"].as_u64().unwrap(),
            session,
            anchor,
        )
    }

    async fn start_progress(
        bridge: &Bridge,
        listener: &TcpListener,
        root: &str,
        generation: u64,
        session: Uuid,
    ) -> (
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Value,
    ) {
        bridge
            .channel
            .send(
                "test.mutate",
                json!({
                    "rootId":root, "generation":generation, "endpoint":"agent",
                    "method":"write", "input":{}, "progressId":"shared",
                }),
            )
            .unwrap();
        let (_, mut call) = open_rpc(listener, session).await;
        let reference = prepare_mutation(&mut call).await;
        (call, reference)
    }

    async fn fill_progress_window(
        call: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        events: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
        generation: u64,
    ) {
        for step in 0..=PROGRESS_WINDOW {
            send_frame(call, json!({"kind":"progress","value":step})).await;
        }
        for step in 0..PROGRESS_WINDOW {
            assert_progress(
                &events.recv().await.unwrap(),
                "root",
                generation,
                json!(step),
            );
        }
    }

    fn assert_progress(event: &Value, root: &str, generation: u64, value: Value) {
        assert_eq!(event["rootId"], root, "{event}");
        assert_eq!(event["generation"], generation, "{event}");
        assert_eq!(event["progressId"], "shared", "{event}");
        assert_eq!(event["value"], value, "{event}");
    }

    fn ack_progress(bridge: &Bridge, event: &Value, sequence: u64) {
        bridge
            .channel
            .send(
                "test.ack",
                json!({
                    "deliveryId":event["deliveryId"], "sequence":sequence,
                }),
            )
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
