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
    DeviceIdentity, HostProfile, PendingPairing, RelayAuthorization, RemoteCallHandle,
    RemoteClientError, RemoteHostConnection, SavedHosts, TlsTrust,
};
use nsh_engine::{HostCall, HostChannel};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
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

const PAIR_SCHEME: &str = "maka://pair/v1?payload=";
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
    anchor_session: String,
    endpoint: String,
    method: String,
    input: Value,
    subscription_id: Option<String>,
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

struct Active {
    id: u64,
    root: String,
    info: Value,
    calls: RemoteCallHandle,
    receipt_scope: Option<ReceiptScope>,
    stop: oneshot::Sender<()>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ReceiptScope {
    root: String,
    host_peer_id: String,
}

#[derive(Default)]
struct State {
    attempt: u64,
    attempt_cancel: tokio_util::sync::CancellationToken,
    pending: Option<Pending>,
    active: Option<Active>,
    profiles: BTreeMap<String, HostProfile>,
    credentials: BTreeMap<String, Arc<RelayCredential>>,
    filter: Option<String>,
    uncertain: BTreeMap<ReceiptScope, Vec<Value>>,
    subscriptions: BTreeMap<String, (u64, AbortHandle)>,
    subscription_id: u64,
}

impl State {
    fn cancel_attempt(&mut self) {
        self.attempt += 1;
        self.attempt_cancel.cancel();
        self.pending = None;
    }

    fn clear_active(&mut self) -> Option<Active> {
        for (_, (_, task)) in std::mem::take(&mut self.subscriptions) {
            task.abort();
        }
        self.active.take()
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
                            Ok((id, generation, start)) => {
                                call.reply(Ok(
                                    json!({ "subscriptionId": id, "generation": generation }),
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
            state.cancel_attempt();
            stop(state.clear_active());
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
        let hosts: Vec<_> = state.profiles.values().map(|host| json!({
            "rootId": host.root_id(),
            "hostName": host.host_name(),
            "peerId": host.host_peer_id(),
            "endpoints": host.direct_endpoints(),
            "relayUrls": host.relays().iter().map(|relay| &relay.url).collect::<Vec<_>>(),
            "connected": state.active.as_ref().is_some_and(|active| active.root == host.root_id()),
        })).collect();
        json!({
            "revision": self.snapshot_revision.fetch_add(1, Ordering::Relaxed) + 1,
            "devicePeerId": self.peer_id,
            "hosts": hosts,
            "active": state.active.as_ref().map(|active| &active.info),
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
                state.cancel_attempt();
                Ok(Value::Null)
            }
            "ios.connectHost" => self.connect(decode(data)?).await,
            "ios.connectWebSocket" => self.direct(decode(data)?).await,
            "ios.disconnectHost" => {
                let mut state = self.state.lock().await;
                state.cancel_attempt();
                stop(state.clear_active());
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
            "ios.hostQuery" | "ios.hostMutate" => {
                let rpc: Rpc = decode(data)?;
                let (id, calls, receipt_scope) = self.calls(&rpc.anchor_session).await?;
                let result = if name == "ios.hostQuery" {
                    calls.query(&rpc.endpoint, &rpc.method, rpc.input).await
                } else {
                    calls.mutate(&rpc.endpoint, &rpc.method, rpc.input).await
                };
                if let Err(RemoteClientError::MutationUncertain { reference, .. }) = &result
                    && let Some(scope) = receipt_scope
                {
                    self.register_uncertain(id, scope, reference.clone()).await;
                }
                let value = result.map_err(error)?;
                self.check_active(id).await?;
                Ok(json!({"value": value}))
            }
            "ios.unsubscribe" => {
                let task = self
                    .state
                    .lock()
                    .await
                    .subscriptions
                    .remove(field(&data, "subscriptionId")?);
                if let Some((_, task)) = &task {
                    task.abort();
                }
                Ok(json!({"cancelled": task.is_some()}))
            }
            _ => unreachable!("registered iOS Host call"),
        }
    }

    async fn new_attempt(&self) -> (u64, tokio_util::sync::CancellationToken) {
        let mut state = self.state.lock().await;
        state.cancel_attempt();
        state.attempt_cancel = tokio_util::sync::CancellationToken::new();
        (state.attempt, state.attempt_cancel.clone())
    }

    async fn begin(&self, begin: Begin) -> Result<Value, String> {
        let credential = match (begin.relay_url, begin.relay_token) {
            (None, None) => None,
            (Some(url), Some(token)) => Some(Arc::new(RelayCredential { url, token })),
            _ => return Err("relay authorization requires both URL and Bearer token".into()),
        };
        let (id, cancel) = self.new_attempt().await;
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
                begin.uri.trim(),
                now,
                credential.as_deref().map(RelayCredential::authorization),
                &saved,
            ))
            .await
            .ok_or("connection cancelled")?
            .map_err(error)?;
        let mut state = self.state.lock().await;
        if state.attempt != id {
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
        let (pending, cancel) = {
            let mut state = self.state.lock().await;
            if !state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == confirm.pairing_id)
            {
                return Err("there is no matching pairing to confirm".into());
            }
            (
                state.pending.take().expect("matched pending pairing"),
                state.attempt_cancel.clone(),
            )
        };
        let redeemed = cancel
            .run_until_cancelled(
                pending
                    .pairing
                    .redeem(&confirm.sas, Some("Maka for iOS".into())),
            )
            .await
            .ok_or("pairing cancelled")?
            .map_err(error)?;
        // Once a receipt is acknowledged the invite has been spent. Save the
        // authenticated profile even if the user cancels subsequent admission.
        let profile = redeemed.profile().clone();
        let root = profile.root_id().to_owned();
        let name = profile.host_name().to_owned();
        let edit = self.profile_edits.lock().await;
        let saved = self.saved.clone();
        let to_save = profile.clone();
        tokio::task::spawn_blocking(move || saved.lock().expect("saved Host lock").save(to_save))
            .await
            .map_err(error)?
            .map_err(error)?;
        {
            let mut state = self.state.lock().await;
            state.profiles.insert(root.clone(), profile);
            match pending.credential {
                Some(credential) => {
                    state.credentials.insert(root, credential);
                }
                None => {
                    state.credentials.remove(&root);
                }
            }
            self.emit("ios.hostState", self.snapshot(&state));
        }
        drop(edit);
        let (_, connection) = cancel
            .run_until_cancelled(redeemed.admit())
            .await
            .ok_or("pairing saved; connection cancelled")?
            .map_err(error)?;
        self.install(pending.id, name, connection, "quic").await
    }

    async fn connect(&self, request: ConnectHost) -> Result<Value, String> {
        let root = &request.root_id;
        let supplied = match (request.relay_url, request.relay_token) {
            (None, None) => None,
            (Some(url), Some(token)) => Some(Arc::new(RelayCredential { url, token })),
            _ => return Err("relay authorization requires both URL and Bearer token".into()),
        };
        let (id, cancel) = self.new_attempt().await;
        let (profile, credential) = {
            let state = self.state.lock().await;
            (
                state
                    .profiles
                    .get(root)
                    .cloned()
                    .ok_or("unknown paired Host")?,
                supplied.or_else(|| state.credentials.get(root).cloned()),
            )
        };
        let connection = cancel
            .run_until_cancelled(profile.reconnect(
                &self.identity,
                credential.as_deref().map(RelayCredential::authorization),
            ))
            .await
            .ok_or("connection cancelled")?
            .map_err(error)?;
        let snapshot = self
            .install(id, profile.host_name().to_owned(), connection, "quic")
            .await?;
        if let Some(credential) = credential {
            let mut state = self.state.lock().await;
            if state.active.as_ref().is_some_and(|active| active.id == id) {
                state.credentials.insert(root.clone(), credential);
            }
        }
        Ok(snapshot)
    }

    async fn direct(&self, direct: Direct) -> Result<Value, String> {
        let (id, cancel) = self.new_attempt().await;
        let connection = cancel
            .run_until_cancelled(RemoteHostConnection::connect_websocket(
                direct.endpoint.trim(),
                TlsTrust::System,
                direct.bearer.into(),
                direct.root_id.trim(),
                direct
                    .client_instance
                    .map_or_else(|| self.peer_id.clone(), Into::into),
            ))
            .await
            .ok_or("connection cancelled")?
            .map_err(error)?;
        self.install(id, "WebSocket".into(), connection, "websocket")
            .await
    }

    async fn remove(&self, root: String) -> Result<Value, String> {
        let _edit = self.profile_edits.lock().await;
        self.new_attempt().await;
        let saved = self.saved.clone();
        let key = root.clone();
        tokio::task::spawn_blocking(move || saved.lock().expect("saved Host lock").remove(&key))
            .await
            .map_err(error)?
            .map_err(error)?;
        let mut state = self.state.lock().await;
        state.profiles.remove(&root);
        state.credentials.remove(&root);
        state.uncertain.retain(|scope, _| scope.root != root);
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.root == root)
        {
            stop(state.clear_active());
        }
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
    ) -> Result<Value, String> {
        let (stop_tx, stop_rx) = oneshot::channel();
        let endpoints = connection.endpoint_names();
        let (snapshot, reconcile) = {
            let mut state = self.state.lock().await;
            if state.attempt != id {
                return Err("connection was superseded".into());
            }
            stop(state.clear_active());
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
            state.active = Some(Active {
                id,
                root: connection.root_id().to_owned(),
                calls: connection.call_handle(),
                receipt_scope,
                stop: stop_tx,
                info: json!({
                    "rootId": connection.root_id(), "hostName": name, "epoch": connection.epoch(),
                    "session": connection.session(), "endpoints": endpoints,
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
                    .active
                    .as_ref()
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
            let reference = reference.clone();
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
            if self.check_active(id).await.is_err() {
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
        if let Some(active) = state.active.as_ref().filter(|active| active.id == id) {
            let pending = state.uncertain.get(&scope).map_or(0, Vec::len);
            self.emit(
                "ios.operationRecovery",
                json!({
                    "session": active.info["session"], "settled": settled, "pending": pending
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
                    if state.active.as_ref().is_some_and(|active| active.id == id) {
                        let root = state.active.as_ref().expect("matching active Host").root.clone();
                        state.clear_active();
                        let mut snapshot = self.snapshot(&state);
                        snapshot["disconnectedRootId"] = json!(root);
                        snapshot["disconnectReason"] = json!(disconnected.err().map_or_else(|| "Host closed the connection".into(), |err| err.to_string()));
                        self.emit("ios.hostState", snapshot);
                    }
                    return;
                }
                _ = interval.tick() => {
                    let mut state = self.state.lock().await;
                    if let Some(active) = state.active.as_mut().filter(|active| active.id == id)
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
        anchor_session: &str,
    ) -> Result<(u64, RemoteCallHandle, Option<ReceiptScope>), String> {
        self.state
            .lock()
            .await
            .active
            .as_ref()
            .filter(|active| active.info["session"] == anchor_session)
            .map(|active| {
                (
                    active.id,
                    active.calls.clone(),
                    active.receipt_scope.clone(),
                )
            })
            .ok_or_else(|| "remote Host anchor no longer matches UI".into())
    }

    async fn check_active(&self, id: u64) -> Result<(), String> {
        if self
            .state
            .lock()
            .await
            .active
            .as_ref()
            .is_some_and(|active| active.id == id)
        {
            Ok(())
        } else {
            Err("remote Host changed during the call".into())
        }
    }

    async fn open_subscription(
        &self,
        data: Value,
    ) -> Result<(String, u64, oneshot::Sender<()>), String> {
        let rpc: Rpc = decode(data)?;
        let id = rpc.subscription_id.ok_or("missing subscription ID")?;
        let (active, calls, _) = self.calls(&rpc.anchor_session).await?;
        let mut subscription = calls
            .subscribe(&rpc.endpoint, &rpc.method, rpc.input)
            .await
            .map_err(error)?;
        let mut state = self.state.lock().await;
        if !state
            .active
            .as_ref()
            .is_some_and(|current| current.id == active)
        {
            return Err("remote Host changed during subscription setup".into());
        }
        state.subscription_id += 1;
        let generation = state.subscription_id;
        let (start, wait) = oneshot::channel::<()>();
        let bridge = self.clone();
        let key = id.clone();
        let task = self.runtime.spawn(async move {
            if wait.await.is_err() {
                return;
            }
            let outcome = loop {
                match subscription.next().await {
                    Ok(Some(item)) => bridge.emit(
                        "ios.subscriptionItem",
                        json!({
                            "subscriptionId": key, "generation": generation, "item": item,
                        }),
                    ),
                    Ok(None) => break None,
                    Err(err) => break Some(err.to_string()),
                }
            };
            let mut state = bridge.state.lock().await;
            if state
                .subscriptions
                .get(&key)
                .is_some_and(|(current, _)| *current == generation)
            {
                state.subscriptions.remove(&key);
                bridge.emit(
                    "ios.subscriptionEnded",
                    json!({
                        "subscriptionId": key, "generation": generation, "error": outcome,
                    }),
                );
            }
        });
        if let Some((_, replaced)) = state
            .subscriptions
            .insert(id.clone(), (generation, task.abort_handle()))
        {
            replaced.abort();
        }
        Ok((id, generation, start))
    }
}

fn stop(active: Option<Active>) {
    if let Some(active) = active {
        let _ = active.stop.send(());
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
        let original = bridge.new_attempt().await.0;
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
        let new = bridge.new_attempt().await.0;
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
                    .install(new, "test".into(), connection, "quic")
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
