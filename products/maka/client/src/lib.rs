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

//! View-independent Maka calls. The launcher retains this scope until `close` succeeds.
mod journal;
pub use journal::{
    Draft, DraftAttachment, DraftEdit, DraftKey, DraftReference, Journal, Operation,
    RecentWorkspace, UploadReference,
};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::{
    CallResources,
    host::{Client as HostClient, LocalCall},
    transport::{Description, wire::Reply},
};
use maka_plugin_core::work::resources::Resources;
use maka_plugin_core::{
    composition::InstanceId,
    contract::text_resource_type,
    deployment::DeploymentRef,
    operation::{OperationReply, RecoveryContract, receipt_reader_contract},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;

const CONTROL_METHODS: &[&str] = &[
    "create",
    "predictNextMessage",
    "trustProjectMcp",
    "selectBackend",
    "compact",
    "continueRun",
    "setCompactionPrompt",
    "markRead",
    "markBotRead",
    "stop",
    "stopComputerApp",
    "respond",
    "requestSystemPermission",
    "editQueue",
    "metadata",
    "changeSession",
    "fork",
    "openBot",
    "changeGoal",
    "schedule",
];
const CONTROL_KIND: &str = "agent-control";
const SETTINGS_KIND: &str = "settings";
const TERMINAL_KIND: &str = "terminal";
const TERMINAL_METHODS: [&str; 4] = ["start", "stop", "control", "release"];
const SETTINGS_ENDPOINTS: [&str; 6] = [
    "settings",
    "agent",
    "skills",
    "setup",
    "management",
    "authentication",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ServiceOwner {
    pub namespace: InstanceId,
    pub export: String,
}
impl ServiceOwner {
    fn from_description(description: &Description) -> Self {
        Self {
            namespace: description.provider.clone(),
            export: description.export.clone(),
        }
    }
    fn correlation(&self, kind: &str) -> Value {
        serde_json::json!({"kind":kind,"owner":self})
    }
}
const SETTINGS_METHODS: [&str; 11] = [
    "create",
    "update",
    "remove",
    "saveCredential",
    "saveUsageCredential",
    "deleteCredential",
    "updateModelSettings",
    "setDefault",
    "updateAssistantPreferences",
    "updateNetwork",
    "updateWorkspaceLocations",
];
fn settings_route(endpoint: &str, method: &str) -> bool {
    (endpoint == "settings" && SETTINGS_METHODS.contains(&method))
        || (endpoint == "agent"
            && matches!(
                method,
                "updateGlobalInstructions" | "selectWorkspace" | "manageMcpServer"
            ))
        || (endpoint == "skills" && matches!(method, "install" | "update" | "delete"))
        || (endpoint == "setup" && method == "discoverModels")
        || (endpoint == "management"
            && matches!(method, "setEnabled" | "configure" | "configureBatch"))
        || (endpoint == "authentication" && method == "loginCredential")
}
fn settings_owner(operation: &Operation, owner: &ServiceOwner) -> bool {
    operation.draft.is_none()
        && operation.session_id.is_none()
        && settings_route(&operation.endpoint, &operation.method)
        && operation.correlation == owner.correlation(SETTINGS_KIND)
}
fn control_correlation(method: &str, input: &Value, owner: &ServiceOwner) -> Result<Value> {
    let mut correlation = owner.correlation(CONTROL_KIND);
    let key = match method {
        "stop" => Some("runId"),
        "continueRun" => Some("sourceRunId"),
        "respond" | "requestSystemPermission" => Some("requestId"),
        "stopComputerApp" => Some("operationId"),
        _ => None,
    };
    if let Some(key) = key {
        let target = input
            .get(key)
            .and_then(Value::as_str)
            .filter(|target| !target.is_empty())
            .ok_or(if key == "operationId" {
                "agent control requires a valid operationId"
            } else {
                "agent control requires a valid runId or requestId"
            })?;
        correlation[key] = if matches!(key, "runId" | "sourceRunId") {
            let id =
                Uuid::parse_str(target).map_err(|_| "agent control requires a durable Run UUID")?;
            if id.is_nil() {
                return Err("agent control requires a non-nil Run UUID".into());
            }
            Value::String(id.to_string())
        } else {
            Value::String(target.to_owned())
        };
    }
    if method == "continueRun" {
        correlation["sourceHighWater"] = input
            .get("sourceHighWater")
            .and_then(Value::as_u64)
            .filter(|revision| (1..=9_007_199_254_740_991).contains(revision))
            .ok_or("agent Run control requires an exact observation fence")?
            .into();
        correlation["model"] = input
            .get("model")
            .filter(|model| model.is_object())
            .ok_or("Run continuation requires an explicit model")?
            .clone();
        if let Some(thinking) = input.get("thinkingLevel") {
            correlation["thinkingLevel"] = thinking.clone();
        }
    }
    if method == "requestSystemPermission" {
        let grant = input
            .get("grant")
            .and_then(Value::as_str)
            .filter(|grant| !grant.is_empty())
            .ok_or("system permission control requires a grant")?;
        correlation["grant"] = Value::String(grant.to_owned());
    }
    if matches!(
        method,
        "metadata" | "setCompactionPrompt" | "changeSession" | "fork"
    ) {
        let revision = input
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .filter(|revision| (1..=9_007_199_254_740_991).contains(revision))
            .ok_or("agent lifecycle control requires a valid expectedRevision")?;
        correlation["expectedRevision"] = revision.into();
        if method == "changeSession" {
            let action = input
                .get("action")
                .and_then(Value::as_str)
                .filter(|action| matches!(*action, "archive" | "restore" | "remove"))
                .ok_or("agent lifecycle control requires a valid action")?;
            correlation["action"] = action.into();
        }
        if method == "fork" {
            let position = input
                .get("position")
                .ok_or("agent fork control requires an original position")?;
            let valid = match position.get("kind").and_then(Value::as_str) {
                Some("start" | "end") => position.as_object().is_some_and(|value| value.len() == 1),
                Some("before_turn" | "through_turn") => {
                    position.as_object().is_some_and(|value| value.len() == 2)
                        && position
                            .get("turnId")
                            .and_then(Value::as_str)
                            .is_some_and(|turn| !turn.is_empty())
                }
                // The Host validates the qualified row address itself.
                Some("before_source_turn" | "through_source_turn") => {
                    position.as_object().is_some_and(|value| value.len() == 2)
                        && position.get("position").is_some_and(Value::is_object)
                }
                _ => false,
            };
            if !valid {
                return Err("agent fork control requires a valid position".into());
            }
            correlation["position"] = position.clone();
        }
    }
    Ok(correlation)
}

/// A shell-owned scope over one launcher-selected, authenticated Host connection.
/// Clones share custody; dropping a JS handle does not retire an accepted request.
#[derive(Clone)]
pub struct Client(Arc<Scope>);
struct Scope {
    host: Mutex<HostClient>,
    source: DeploymentRef,
    receipts: String,
    journal: Journal,
    requests: Mutex<BTreeMap<Uuid, Arc<Request>>>,
    binding_retired: AtomicBool,
    upload_updates: tokio::sync::watch::Sender<()>,
    parent: Option<(Weak<Scope>, Uuid)>,
    children: Mutex<BTreeMap<Uuid, Client>>,
    requests_changed: Notify,
    shutdown: CancellationToken,
    opening_stop: CancellationToken,
    openings: Arc<Resources>,
}
struct Request {
    id: Uuid,
    operation: Option<Uuid>,
    observation_ended: AtomicBool,
    preparation: std::sync::Mutex<Option<std::fs::File>>,
    stop: CancellationToken,
    state: Mutex<State>,
}
impl Request {
    fn end_observation(&self) {
        self.observation_ended.store(true, Ordering::Release);
        self.preparation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}
struct State {
    call: LocalCall,
    phase: Phase,
}
enum Drained {
    Finished {
        reply: Box<OperationReply>,
        cleanup: Result<()>,
    },
    NotDispatched,
    Closed {
        cleanup: Result<()>,
    },
}
#[derive(PartialEq)]
enum Phase {
    New,
    Preparing,
    Prepared,
    Confirming,
    Streaming,
    Pulling,
    Interrupted,
    Complete,
}

impl Client {
    pub fn new(host: HostClient, journal: Journal, receipts: String) -> Result<Self> {
        if host.catalogue().describe(&receipts)?.contract != receipt_reader_contract() {
            return Err("client receipt endpoint has a different contract".into());
        }
        Ok(Self(Arc::new(Scope {
            source: host.source().clone(),
            host: Mutex::new(host),
            journal,
            receipts,
            requests: Mutex::new(BTreeMap::new()),
            binding_retired: AtomicBool::new(false),
            upload_updates: tokio::sync::watch::channel(()).0,
            parent: None,
            children: Mutex::new(BTreeMap::new()),
            requests_changed: Notify::new(),
            shutdown: CancellationToken::new(),
            opening_stop: CancellationToken::new(),
            openings: Arc::default(),
        })))
    }
    /// Capture a UI consumer's declared bindings in an owned child session. Its
    /// calls share this journal and recover through the original receipt reader.
    pub async fn bind_ui(
        &self,
        source: DeploymentRef,
        instance: InstanceId,
    ) -> Result<(Self, BTreeMap<String, Vec<String>>)> {
        let capture = {
            let host = self.0.host.lock().await;
            if self.0.opening_stop.is_cancelled() {
                return Err("client scope is closing".into());
            }
            host.bind_ui(source, instance)
        };
        let host = capture.await?;
        let imports = host.ui_imports().ok_or("Host omitted UI bindings")?.clone();
        let id = Uuid::new_v4();
        let child = Self(Arc::new(Scope {
            source: host.source().clone(),
            host: Mutex::new(host),
            receipts: self.0.receipts.clone(),
            journal: self.0.journal.clone(),
            requests: Mutex::new(BTreeMap::new()),
            binding_retired: AtomicBool::new(false),
            upload_updates: self.0.upload_updates.clone(),
            parent: Some((Arc::downgrade(&self.0), id)),
            children: Mutex::new(BTreeMap::new()),
            requests_changed: Notify::new(),
            shutdown: self.0.shutdown.child_token(),
            opening_stop: CancellationToken::new(),
            openings: Arc::default(),
        }));
        let owner = self.0.host.lock().await;
        self.0.children.lock().await.insert(id, child.clone());
        let closing = self.0.opening_stop.is_cancelled();
        drop(owner);
        if closing {
            child.close().await?;
            return Err("client scope is closing".into());
        }
        Ok((child, imports))
    }

    /// A typed admission refusal retired this captured service generation.
    /// It does not authorize replaying any request made through this scope.
    pub fn binding_retired(&self) -> bool {
        self.0.binding_retired.load(Ordering::Acquire)
    }

    pub fn source(&self) -> &DeploymentRef {
        &self.0.source
    }

    /// Read the descriptor captured by this original Host connection.
    /// This does not open a request or grant access to its service.
    pub async fn describe(&self, endpoint: &str) -> Result<Description> {
        Ok(self
            .0
            .host
            .lock()
            .await
            .catalogue()
            .describe(endpoint)?
            .clone())
    }

    async fn service_owner(&self, endpoint: &str) -> Result<ServiceOwner> {
        Ok(ServiceOwner::from_description(
            &self.describe(endpoint).await?,
        ))
    }

    pub async fn refresh(&self) -> Result<()> {
        let mut host = self.0.host.lock().await;
        if self.0.opening_stop.is_cancelled() {
            return Err("client scope is closing".into());
        }
        host.refresh().await?;
        self.0.binding_retired.store(false, Ordering::Release);
        Ok(())
    }

    async fn open(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        resources: Attachments,
        mutation: Option<(Uuid, std::fs::File)>,
    ) -> Result<(Arc<Request>, Description)> {
        let (opened, opening) = tokio::sync::oneshot::channel();
        {
            let host = self.0.host.lock().await;
            if self.0.opening_stop.is_cancelled() {
                return Err("client scope is closing".into());
            }
            let description = host.catalogue().describe(endpoint)?.clone();
            let call = host.call(endpoint, method.into(), input, resources);
            let mut ticket = self.0.openings.reserve().map_err(error)?;
            ticket.start();
            let client = self.clone();
            // The scope retains physical opening work even if its caller disappears.
            tokio::spawn(async move {
                let result = tokio::select! {
                    biased;
                    () = client.0.opening_stop.cancelled() => Err("client scope is closing".into()),
                    result = call => result,
                };
                let result = match (result, mutation) {
                    (Ok(call), mutation) => {
                        let (operation, preparation) = match mutation {
                            Some((operation, preparation)) => (Some(operation), Some(preparation)),
                            None => (None, None),
                        };
                        let request = Arc::new(Request {
                            id: Uuid::new_v4(),
                            operation,
                            observation_ended: AtomicBool::new(false),
                            preparation: std::sync::Mutex::new(preparation),
                            stop: CancellationToken::new(),
                            state: Mutex::new(State {
                                call,
                                phase: Phase::New,
                            }),
                        });
                        if client.0.opening_stop.is_cancelled() {
                            request.stop.cancel();
                        }
                        client
                            .0
                            .requests
                            .lock()
                            .await
                            .insert(request.id, request.clone());
                        Ok((request, description))
                    }
                    (Err(error), _) => Err(error),
                };
                if let Err(Ok((request, _))) = opened.send(result) {
                    request.end_observation();
                    client.0.requests_changed.notify_waiters();
                }
                ticket.complete(Ok(()));
            });
        }
        opening
            .await
            .map_err(|_| "client channel opening cleanup remains unconfirmed".to_owned())?
    }
    async fn release_if_clean(&self, request: &Request, state: &State) {
        if state.call.binding_retired() {
            self.0.binding_retired.store(true, Ordering::Release);
        }
        if matches!(state.phase, Phase::Complete | Phase::Interrupted)
            || state.call.cleanup_confirmed()
        {
            request.end_observation();
            self.0.requests_changed.notify_waiters();
        }
        if state.call.cleanup_confirmed() {
            self.0.requests.lock().await.remove(&request.id);
        }
    }
    async fn observe_mutation(&self, request: &Request, reply: &OperationReply) -> Result<()> {
        let id = request
            .operation
            .ok_or("Host returned a mutation for a non-mutation request")?;
        let operation = self.operation(id).await?;
        if operation.reference.as_ref() != Some(&reply.reference) {
            return Err("Host completion differs from the original client operation".into());
        }
        self.0.journal.observe(&operation, &reply.receipt).await?;
        if operation.upload.is_some() {
            self.notify_uploads();
        }
        Ok(())
    }
    async fn drain_request(&self, request: &Request, state: &mut State) -> Result<Drained> {
        let unconfirmed = state.call.awaiting_confirmation();
        state.phase = Phase::Interrupted;
        let drained = match state.call.drain().await? {
            Some(Reply::Mutation { reply, cleanup }) => {
                self.observe_mutation(request, &reply).await?;
                Drained::Finished { reply, cleanup }
            }
            Some(Reply::Aborted { cleanup, .. })
                if unconfirmed && cleanup.is_ok() && request.operation.is_some() =>
            {
                let operation = self.operation(request.operation.unwrap()).await?;
                let reference = state
                    .call
                    .reference()
                    .ok_or("original undispatched preparation has no reference")?;
                self.0
                    .journal
                    .abandon_undispatched(&self.0.source, operation.id, reference)
                    .await?;
                if operation.upload.is_some() {
                    self.notify_uploads();
                }
                Drained::NotDispatched
            }
            Some(reply) => Drained::Closed {
                cleanup: reply
                    .cleanup()
                    .expect("drain returns a terminal reply")
                    .clone(),
            },
            None => Drained::Closed { cleanup: Ok(()) },
        };
        state.phase = Phase::Complete;
        Ok(drained)
    }
    pub async fn query(&self, endpoint: &str, method: &str, input: Value) -> Result<Value> {
        let (request, _) = self
            .open(endpoint, method, input, Attachments::new(), None)
            .await?;
        let mut state = request.state.lock().await;
        let result = tokio::select! {
            biased;
            () = request.stop.cancelled() => Err("client query cancelled".into()),
            result = async {
                state.call.start().await?;
                match state.call.receive().await? {
                    Reply::Finished { result, cleanup } => { cleanup?; result }
                    Reply::Aborted { reason, cleanup } | Reply::BindingRetired { reason, cleanup } => { cleanup?; Err(reason) }
                    _ => Err("Host method is not a query".into()),
                }
            } => result,
        };
        if result.is_err() {
            let _ = state.call.close().await;
        }
        self.release_if_clean(&request, &state).await;
        result
    }
    /// Reserve an attempt before opening it. An existing ID is recovery-only,
    /// including when the previous observer disappeared before preparation.
    #[allow(clippy::too_many_arguments)]
    pub async fn mutation(
        &self,
        id: Uuid,
        endpoint: &str,
        method: &str,
        input: Value,
        resources: Attachments,
        session_id: Option<String>,
        correlation: Value,
    ) -> Result<Mutation> {
        let operation = Operation {
            id,
            host: self.0.source.clone(),
            endpoint: endpoint.into(),
            method: method.into(),
            session_id,
            correlation,
            draft: None,
            upload: None,
            abandoned: false,
            reference: None,
            receipt: None,
        };
        self.begin_mutation(operation, input, resources).await
    }
    async fn begin_mutation(
        &self,
        operation: Operation,
        input: Value,
        resources: Attachments,
    ) -> Result<Mutation> {
        let preparation = self
            .0
            .journal
            .preparation_lease(false)
            .await?
            .expect("shared preparation lease");
        self.0.journal.reserve(&operation).await?;
        if operation.upload.is_some() {
            self.notify_uploads();
        }
        self.open_mutation(operation, input, resources, preparation)
            .await
    }
    async fn open_mutation(
        &self,
        operation: Operation,
        input: Value,
        resources: Attachments,
        preparation: std::fs::File,
    ) -> Result<Mutation> {
        let descriptors = CallResources::from(resources.clone()).descriptors()?;
        let reacquisition = if descriptors.is_empty() {
            serde_json::json!({"kind": "none"})
        } else {
            serde_json::json!({"kind": "unavailable", "reason": "live_only_request_resources"})
        };
        let recovery = serde_json::json!({
            "kind": "maka_client_mutation",
            "version": 1,
            "clientOperation": operation.id,
            "host": operation.host,
            "sessionId": operation.session_id,
            "correlation": operation.correlation,
            "draft": operation.draft,
            "upload": operation.upload,
            "request": {"endpoint": operation.endpoint, "method": operation.method, "input": input},
            "resources": {"descriptors": descriptors, "reacquisition": reacquisition},
        });
        let (request, description) = self
            .open(
                &operation.endpoint,
                &operation.method,
                input,
                resources,
                Some((operation.id, preparation)),
            )
            .await?;
        if matches!(
            operation.correlation.get("kind").and_then(Value::as_str),
            Some(CONTROL_KIND | SETTINGS_KIND | TERMINAL_KIND)
        ) && let Some(owner) = operation.correlation.get("owner")
            && *owner
                != serde_json::to_value(ServiceOwner::from_description(&description))
                    .map_err(error)?
        {
            let mut state = request.state.lock().await;
            let closed = state.call.close().await;
            self.release_if_clean(&request, &state).await;
            closed?;
            return Err("client operation target changed before opening its original call".into());
        }
        Ok(Mutation {
            client: self.clone(),
            request,
            operation,
            description,
            recovery,
        })
    }
    /// Reserve one Settings attempt across terminal launchers before opening it.
    /// An unresolved original blocks new Settings writes, including after restart.
    pub async fn settings_mutation(
        &self,
        id: Uuid,
        endpoint: &str,
        method: &str,
        input: Value,
        resources: Attachments,
    ) -> Result<Mutation> {
        if !settings_route(endpoint, method) {
            return Err("unsupported settings mutation method".into());
        }
        if endpoint == "settings" && matches!(method, "saveCredential" | "saveUsageCredential") {
            if resources.len() != 1
                || !resources.get("secret").is_some_and(|secret| {
                    secret.resource_type() == text_resource_type()
                        && secret.encoding() == ResourceEncoding::Utf8
                })
            {
                return Err("settings credential requires one UTF-8 secret resource".into());
            }
        } else if endpoint == "settings" && method == "updateNetwork" {
            match input.get("credential").and_then(Value::as_str) {
                Some("replace") => {
                    if resources.len() != 1
                        || !resources.get("secret").is_some_and(|secret| {
                            let bytes = secret.bytes();
                            secret.resource_type() == text_resource_type()
                                && secret.encoding() == ResourceEncoding::Utf8
                                && bytes > 0
                                && secret.read(0..bytes).is_ok_and(|value| {
                                    value.len() == bytes && std::str::from_utf8(&value).is_ok()
                                })
                        })
                    {
                        return Err("settings network credential requires one nonempty UTF-8 secret resource".into());
                    }
                }
                Some("keep" | "delete") if resources.is_empty() => {}
                Some("keep" | "delete") => {
                    return Err("settings mutation does not accept resources".into());
                }
                _ => return Err("settings network credential action is invalid".into()),
            }
        } else if !resources.is_empty() {
            return Err("settings mutation does not accept resources".into());
        }
        let owner = self.service_owner(endpoint).await?;
        let operation = Operation {
            id,
            host: self.0.source.clone(),
            endpoint: endpoint.into(),
            method: method.into(),
            session_id: None,
            correlation: owner.correlation(SETTINGS_KIND),
            draft: None,
            upload: None,
            abandoned: false,
            reference: None,
            receipt: None,
        };
        let preparation = self
            .0
            .journal
            .preparation_lease(false)
            .await?
            .expect("shared preparation lease");
        self.0.journal.reserve_settings(&operation).await?;
        self.open_mutation(operation, input, resources, preparation)
            .await
    }
    /// Upload bytes selected by native input, with the original editor/provider owner.
    pub async fn upload_attachment(
        &self,
        id: Uuid,
        session: &str,
        editor: &str,
        resource: Arc<dyn ReadResource>,
    ) -> Result<Mutation> {
        let key = self.draft_key("agent", session, editor).await?;
        let metadata = resource.metadata();
        let name = metadata["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or("invalid selected filename")?
            .to_owned();
        let bytes = metadata["bytes"]
            .as_u64()
            .and_then(|bytes| usize::try_from(bytes).ok())
            .filter(|bytes| *bytes == resource.bytes())
            .ok_or("invalid selected file size")?;
        let digest = metadata["digest"]
            .as_str()
            .filter(|digest| {
                digest.strip_prefix("sha256:").is_some_and(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
            })
            .ok_or("invalid selected file digest")?
            .to_owned();
        let input = serde_json::json!({"sessionId": session, "name": name, "bytes": bytes, "digest": digest});
        self.begin_mutation(
            Operation {
                id,
                host: self.0.source.clone(),
                endpoint: "agent".into(),
                method: "uploadAttachment".into(),
                session_id: Some(session.into()),
                correlation: Value::Null,
                draft: None,
                upload: Some(UploadReference {
                    key,
                    name,
                    bytes,
                    digest,
                }),
                abandoned: false,
                reference: None,
                receipt: None,
            },
            input,
            Attachments::from([("file".into(), resource)]),
        )
        .await
    }
    pub async fn pending_uploads(&self, session: &str, editor: &str) -> Result<Vec<Operation>> {
        let key = self.draft_key("agent", session, editor).await?;
        self.0.journal.pending_uploads(&self.0.source, &key).await
    }
    /// In-process invalidation only. Read the original journal after every wake.
    /// Subscribe before the first read; a new ScopedHost shares this same sender.
    pub fn watch_uploads(&self) -> tokio::sync::watch::Receiver<()> {
        self.0.upload_updates.subscribe()
    }
    fn notify_uploads(&self) {
        self.0.upload_updates.send_replace(());
    }
    pub async fn operation_for_upload(
        &self,
        session: &str,
        editor: &str,
        id: Uuid,
    ) -> Result<Operation> {
        let key = self.draft_key("agent", session, editor).await?;
        let operation = self.operation(id).await?;
        journal::validate_upload(&operation, &key)?;
        Ok(operation)
    }
    /// Exact lookup distinguishes a pre-reservation selection failure from an
    /// unknown original upload. List truncation and lookup errors are not absence.
    pub async fn find_upload(
        &self,
        session: &str,
        editor: &str,
        id: Uuid,
    ) -> Result<Option<Operation>> {
        let key = self.draft_key("agent", session, editor).await?;
        let operation = self.0.journal.find(&self.0.source, id).await?;
        if let Some(operation) = &operation {
            journal::validate_upload(operation, &key)?;
        }
        Ok(operation)
    }
    /// Reserve a shell control attempt separately from composer draft sends.
    pub async fn control(&self, id: Uuid, method: &str, input: Value) -> Result<Mutation> {
        if !CONTROL_METHODS.contains(&method) {
            return Err("unsupported agent control method".into());
        }
        let owner = self.service_owner("agent").await?;
        let correlation = control_correlation(method, &input, &owner)?;
        // Creation and scheduler actions are scoped to the service, not an existing Session.
        let session_id = if matches!(method, "create" | "openBot" | "schedule") {
            None
        } else {
            Some(
                input
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or("agent control requires a sessionId")?
                    .to_owned(),
            )
        };
        self.mutation(
            id,
            "agent",
            method,
            input,
            Attachments::new(),
            session_id,
            correlation,
        )
        .await
    }

    pub async fn terminal_mutation(
        &self,
        id: Uuid,
        method: &str,
        input: Value,
        session: &str,
    ) -> Result<Mutation> {
        if !TERMINAL_METHODS.contains(&method) {
            return Err("unsupported terminal mutation method".into());
        }
        let owner = self.service_owner("terminal").await?;
        self.mutation(
            id,
            "terminal",
            method,
            input,
            Attachments::new(),
            Some(session.into()),
            owner.correlation(TERMINAL_KIND),
        )
        .await
    }
    async fn workspace_owner(&self) -> Result<String> {
        let owner = self.service_owner("agent").await?;
        serde_json::to_string(&(&self.0.source.state_domain, self.0.source.deployment, owner))
            .map_err(|error| error.to_string())
    }

    pub async fn recent_workspaces(&self) -> Result<Vec<RecentWorkspace>> {
        self.0
            .journal
            .recent_workspaces(&self.workspace_owner().await?)
            .await
    }

    /// Move a directory to the front of the recent folders.
    pub async fn set_recent_workspace(&self, path: String) -> Result<Vec<RecentWorkspace>> {
        self.0
            .journal
            .set_recent_workspace(self.workspace_owner().await?, path)
            .await
    }

    async fn draft_key(&self, endpoint: &str, session: &str, editor: &str) -> Result<DraftKey> {
        let host = self.0.host.lock().await;
        let target = host.catalogue().describe(endpoint)?;
        DraftKey::new(
            &self.0.source,
            &target.provider,
            &target.export,
            session,
            editor,
        )
    }
    pub async fn load_draft(
        &self,
        endpoint: &str,
        session: &str,
        editor: &str,
    ) -> Result<Option<Draft>> {
        let key = self.draft_key(endpoint, session, editor).await?;
        self.0.journal.load_draft(&key).await
    }
    pub async fn save_draft(
        &self,
        endpoint: &str,
        session: &str,
        editor: &str,
        expected_revision: Option<u64>,
        edit: DraftEdit,
    ) -> Result<Draft> {
        let key = self.draft_key(endpoint, session, editor).await?;
        let adopted = !edit.settled_uploads.is_empty();
        let saved = self
            .0
            .journal
            .save_draft(&key, expected_revision, edit)
            .await?;
        if adopted {
            self.notify_uploads();
        }
        Ok(saved)
    }
    /// Transfer one saved draft to a recoverable send before opening a Host call.
    #[allow(clippy::too_many_arguments)]
    pub async fn reserve_send_draft(
        &self,
        id: Uuid,
        endpoint: &str,
        session: &str,
        editor: &str,
        revision: u64,
        selection: Value,
    ) -> Result<DraftSend> {
        let key = self.draft_key(endpoint, session, editor).await?;
        let draft = self
            .0
            .journal
            .load_draft(&key)
            .await?
            .ok_or("saved draft not found")?;
        if draft.revision != revision {
            return Err("saved draft revision changed before sending".into());
        }
        if draft.text.trim().is_empty() && draft.attachments.is_empty() && draft.quotes.is_empty() {
            return Err("saved draft is empty or already consumed".into());
        }
        if !selection.is_object() {
            return Err("send selection must be an object".into());
        }
        let snapshot = journal::SendSnapshot { draft, selection };
        let operation = Operation {
            id,
            host: self.0.source.clone(),
            endpoint: endpoint.into(),
            method: "send".into(),
            session_id: Some(session.into()),
            correlation: serde_json::to_value(snapshot).map_err(error)?,
            draft: Some(DraftReference { key, revision }),
            upload: None,
            abandoned: false,
            reference: None,
            receipt: None,
        };
        let preparation = self
            .0
            .journal
            .preparation_lease(false)
            .await?
            .expect("shared preparation lease");
        self.0.journal.reserve_send(&operation).await?;
        Ok(DraftSend {
            client: self.clone(),
            operation,
            preparation,
        })
    }

    /// Retry only a known unsent attempt, preserving its content and the new editor draft.
    pub async fn retry_send(
        &self,
        original: Uuid,
        id: Uuid,
        selection: Value,
    ) -> Result<DraftSend> {
        let previous = self.operation(original).await?;
        if previous.draft.is_none()
            || previous.method != "send"
            || (!journal::retryable_send(&previous)
                && self.send_delivery(original).await? != SendDelivery::Cancelled)
        {
            return Err("original send must be confirmed unsent before retrying".into());
        }
        if !selection.is_object() {
            return Err("send selection must be an object".into());
        }
        let mut snapshot: journal::SendSnapshot =
            serde_json::from_value(previous.correlation).map_err(error)?;
        snapshot.selection = selection;
        let operation = Operation {
            id,
            host: previous.host,
            endpoint: previous.endpoint,
            method: previous.method,
            session_id: previous.session_id,
            correlation: serde_json::to_value(snapshot).map_err(error)?,
            draft: previous.draft,
            upload: None,
            abandoned: false,
            reference: None,
            receipt: None,
        };
        let preparation = self
            .0
            .journal
            .preparation_lease(false)
            .await?
            .expect("shared preparation lease");
        self.0.journal.retry_send(original, &operation).await?;
        Ok(DraftSend {
            client: self.clone(),
            operation,
            preparation,
        })
    }

    /// Observe delivery using the native message ledger, independently of the queue view.
    pub async fn send_delivery(&self, id: Uuid) -> Result<SendDelivery> {
        let operation = self.operation(id).await?;
        let Some((message, mut revision)) = journal::queued_send(&operation) else {
            return Ok(SendDelivery::Unknown);
        };
        loop {
            let reply = self
                .query(
                    &operation.endpoint,
                    "queueMessage",
                    serde_json::json!({
                        "sessionId": operation.session_id,
                        "messageId": message,
                        "expectedRevision": revision,
                    }),
                )
                .await?;
            match reply["kind"].as_str() {
                Some("ready") => return Ok(SendDelivery::Accepted),
                Some("revision_conflict") => {
                    revision = reply["actual"].as_u64().ok_or("invalid queue revision")?;
                }
                Some("missing") => {
                    return match reply["reason"].as_str() {
                        Some("delivered") => {
                            self.0.journal.dismiss_send(id).await?;
                            Ok(SendDelivery::Delivered)
                        }
                        Some("cancelled") => Ok(SendDelivery::Cancelled),
                        Some("unknown") => Ok(SendDelivery::Unknown),
                        _ => Err("invalid message delivery reason".into()),
                    };
                }
                _ => return Err("invalid message delivery result".into()),
            }
        }
    }

    /// Dismiss presentation without cancelling or changing the original outcome.
    pub async fn dismiss_send(&self, id: Uuid) -> Result<()> {
        let operation = self.operation(id).await?;
        if operation.draft.is_none() || operation.method != "send" {
            return Err("original operation is not a draft send".into());
        }
        self.0.journal.dismiss_send(id).await
    }

    pub async fn operation(&self, id: Uuid) -> Result<Operation> {
        self.0.journal.load(&self.0.source, id).await
    }
    /// A settled or abandoned original still retains its control owner.
    pub async fn operation_for_control(&self, id: Uuid) -> Result<Operation> {
        let operation = self.operation(id).await?;
        let owner = self.service_owner("agent").await?;
        let correlation = control_correlation(&operation.method, &operation.correlation, &owner);
        if operation.draft.is_some()
            || operation.endpoint != "agent"
            || !CONTROL_METHODS.contains(&operation.method.as_str())
            || correlation.ok().as_ref() != Some(&operation.correlation)
        {
            return Err("original client operation belongs to another control owner".into());
        }
        Ok(operation)
    }
    /// This shell's user-initiated unsettled controls on the current Host deployment.
    /// Automatic predictions retain their receipts without prompting for manual recovery.
    pub async fn pending_controls(&self) -> Result<Vec<Operation>> {
        let owner = self.service_owner("agent").await?;
        Ok(self
            .0
            .journal
            .pending_controls(&self.0.source, &owner)
            .await?
            .into_iter()
            .filter(|operation| operation.method != "predictNextMessage")
            .collect())
    }
    /// Stop prompting for this original without cancelling, replaying, or changing its outcome.
    pub async fn dismiss_control(&self, id: Uuid) -> Result<()> {
        let operation = self.operation_for_control(id).await?;
        if operation.reference.is_none() {
            return Err("unprepared controls must be abandoned before dismissing".into());
        }
        self.0.journal.dismiss_control(id).await
    }
    /// A settled or abandoned Settings attempt retains its original owner.
    pub async fn operation_for_settings(&self, id: Uuid) -> Result<Operation> {
        let operation = self.operation(id).await?;
        let owner = self.service_owner(&operation.endpoint).await?;
        if !settings_owner(&operation, &owner) {
            return Err("original client operation belongs to another settings owner".into());
        }
        Ok(operation)
    }
    /// Unsettled terminal attempts for this exact Host and immutable Agent session.
    pub async fn pending_terminals(&self, session: &str) -> Result<Vec<Operation>> {
        let owner = self.service_owner("terminal").await?;
        self.0
            .journal
            .pending_terminals(&self.0.source, session, &owner)
            .await
    }

    pub async fn operation_for_terminal(&self, id: Uuid, session: &str) -> Result<Operation> {
        let operation = self.operation(id).await?;
        let owner = self.service_owner("terminal").await?;
        if operation.endpoint != "terminal"
            || operation.session_id.as_deref() != Some(session)
            || operation.draft.is_some()
            || operation.upload.is_some()
            || !TERMINAL_METHODS.contains(&operation.method.as_str())
            || operation.correlation != owner.correlation(TERMINAL_KIND)
        {
            return Err("original terminal action belongs to another owner".into());
        }
        Ok(operation)
    }
    /// Unsettled Settings attempts for this exact Host deployment.
    pub async fn pending_settings(&self) -> Result<Vec<Operation>> {
        let owners = {
            let host = self.0.host.lock().await;
            SETTINGS_ENDPOINTS
                .iter()
                .filter_map(|endpoint| host.catalogue().describe(endpoint).ok())
                .map(ServiceOwner::from_description)
                .collect::<Vec<_>>()
        };
        self.0
            .journal
            .pending_settings(&self.0.source, &owners)
            .await
    }
    /// Pending plugin operations belong to a stable UI instance, across package
    /// and binding updates. Endpoint aliases are never recovery identities.
    pub async fn pending_ui(&self, instance: &InstanceId) -> Result<Vec<Operation>> {
        self.0.journal.pending_ui(&self.0.source, instance).await
    }

    pub async fn operation_for_ui(&self, instance: &InstanceId, id: Uuid) -> Result<Operation> {
        let operation = self.operation(id).await?;
        if operation.correlation.get("kind").and_then(Value::as_str) != Some("ui")
            || operation.correlation.get("instance")
                != Some(&serde_json::to_value(instance).map_err(error)?)
        {
            return Err("original client operation belongs to another UI instance".into());
        }
        Ok(operation)
    }

    /// Check the immutable product owner independently of a mutable pending list.
    /// A settled or abandoned original still belongs to the same draft editor.
    pub async fn operation_for_draft(
        &self,
        endpoint: &str,
        session: &str,
        editor: &str,
        id: Uuid,
    ) -> Result<Operation> {
        let key = self.draft_key(endpoint, session, editor).await?;
        let operation = self.operation(id).await?;
        if operation.draft.as_ref().map(|draft| &draft.key) != Some(&key) {
            return Err("original client operation belongs to another draft owner".into());
        }
        Ok(operation)
    }
    /// Atomically fence an attempt with no committed original reference. If
    /// preparation won that race, the returned operation remains recovery-only.
    /// This never authorizes resending the same ID or acknowledges physical cleanup.
    pub async fn abandon_unprepared(&self, id: Uuid) -> Result<Operation> {
        let operation = self.0.journal.abandon(&self.0.source, id).await?;
        if operation.upload.is_some() {
            self.notify_uploads();
        }
        if operation.abandoned {
            let mut owners = vec![self.clone()];
            owners.extend(self.0.children.lock().await.values().cloned());
            for owner in owners {
                let requests: Vec<_> = owner
                    .0
                    .requests
                    .lock()
                    .await
                    .values()
                    .filter(|request| request.operation == Some(id))
                    .cloned()
                    .collect();
                for request in requests {
                    request.stop.cancel();
                }
            }
        }
        Ok(operation)
    }
    /// Unacknowledged send presentations, including failures with frozen content.
    pub async fn pending_operations(
        &self,
        endpoint: &str,
        session: &str,
        editor: &str,
    ) -> Result<Vec<Operation>> {
        let key = self.draft_key(endpoint, session, editor).await?;
        self.0.journal.pending(&self.0.source, &key).await
    }
    /// Query only the exact reference recorded before confirmation. A missing or
    /// unknown receipt never authorizes replay of the business method.
    pub async fn recover(&self, id: Uuid) -> Result<OperationReply> {
        let mut operation = self.operation(id).await?;
        if operation.reference.is_none() {
            let _lease = self
                .0
                .journal
                .preparation_lease(true)
                .await?
                .ok_or("client journal still has active preparation")?;
            operation = self.abandon_unprepared(id).await?;
        }
        let original = operation
            .reference
            .as_ref()
            .ok_or("client operation ended before dispatch")?;
        let reader = match &self.0.parent {
            Some((owner, _)) => Self(owner.upgrade().ok_or("original receipt reader is closed")?),
            None => self.clone(),
        };
        let value = reader
            .query(
                &reader.0.receipts,
                "read",
                serde_json::to_value(original).map_err(error)?,
            )
            .await?;
        let reply: OperationReply = serde_json::from_value(value).map_err(error)?;
        if &reply.reference != original {
            return Err("Host receipt differs from the original client operation".into());
        }
        self.0.journal.observe(&operation, &reply.receipt).await?;
        if operation.upload.is_some() {
            self.notify_uploads();
        }
        Ok(reply)
    }
    pub async fn subscribe(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Subscription> {
        let (request, _) = self
            .open(endpoint, method, input, Attachments::new(), None)
            .await?;
        let mut state = request.state.lock().await;
        let result = tokio::select! {
            biased;
            () = request.stop.cancelled() => Err("client subscription cancelled".into()),
            result = async {
                state.call.start().await?;
                match state.call.receive().await? {
                    Reply::Subscribed => { state.phase = Phase::Streaming; Ok(()) },
                    Reply::Aborted { reason, cleanup } | Reply::BindingRetired { reason, cleanup } => { cleanup?; Err(reason) }
                    _ => Err("Host method is not a subscription".into()),
                }
            } => result,
        };
        if result.is_err() {
            let _ = state.call.close().await;
        }
        self.release_if_clean(&request, &state).await;
        drop(state);
        result?;
        Ok(Subscription {
            client: self.clone(),
            request,
        })
    }
    pub async fn pending_requests(&self) -> usize {
        self.0.requests.lock().await.len()
    }
    /// Retire captured bindings without cancelling accepted mutations. Read calls
    /// stop immediately; original mutations retain this session until they settle.
    pub async fn retire(&self) -> Result<()> {
        self.0.opening_stop.cancel();
        let reads: Vec<_> = {
            let _host = self.0.host.lock().await;
            self.0.openings.settle().await.map_err(error)?;
            self.0
                .requests
                .lock()
                .await
                .values()
                .filter(|request| request.operation.is_none())
                .cloned()
                .collect()
        };
        for request in &reads {
            request.stop.cancel();
        }
        for request in reads {
            let mut state = request.state.lock().await;
            let _ = self.drain_request(&request, &mut state).await;
            self.release_if_clean(&request, &state).await;
        }
        loop {
            let changed = self.0.requests_changed.notified();
            let pending = self.0.requests.lock().await.values().any(|request| {
                request.operation.is_some() && !request.observation_ended.load(Ordering::Acquire)
            });
            if !pending {
                break;
            }
            tokio::select! {
                () = changed => {},
                () = self.0.shutdown.cancelled() => break,
            }
        }
        self.close().await
    }

    /// Request cancellation and drain this exact session. A recovered business
    /// result does not prove physical cleanup; only this session's own close ack
    /// can release disconnected requests. Retain the scope if this returns an error.
    pub async fn close(&self) -> Result<()> {
        self.close_session(false).await
    }

    /// Close this desktop's session and ask its ephemeral Host to quit if it is unshared.
    pub async fn quit_ephemeral(&self) -> Result<()> {
        self.close_session(true).await
    }

    async fn close_session(&self, quit_ephemeral: bool) -> Result<()> {
        self.0.opening_stop.cancel();
        self.0.shutdown.cancel();
        let mut host = self.0.host.lock().await;
        for request in self.0.requests.lock().await.values() {
            request.stop.cancel();
        }
        self.0.openings.settle().await.map_err(error)?;
        let children: Vec<_> = self.0.children.lock().await.values().cloned().collect();
        for child in &children {
            let _ = Box::pin(child.close()).await;
        }
        let requests: Vec<_> = self.0.requests.lock().await.values().cloned().collect();
        for request in &requests {
            request.stop.cancel();
        }
        // Closing the anchor revokes transport reply delivery. Drain original
        // Calls first so their business receipts survive session shutdown.
        for request in requests {
            let mut state = request.state.lock().await;
            let _ = self.drain_request(&request, &mut state).await;
            self.release_if_clean(&request, &state).await;
        }
        if quit_ephemeral {
            host.quit_ephemeral().await?;
        } else {
            host.close().await?;
        }
        self.0.requests.lock().await.clear();
        self.0.requests_changed.notify_waiters();
        for child in children {
            child.0.requests.lock().await.clear();
            child.0.requests_changed.notify_waiters();
        }
        self.0.children.lock().await.clear();
        if let Some((owner, id)) = &self.0.parent
            && let Some(owner) = owner.upgrade()
        {
            owner.children.lock().await.remove(id);
        }
        Ok(())
    }
}

/// Current native disposition of an accepted message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SendDelivery {
    Accepted,
    Delivered,
    Cancelled,
    Unknown,
}

/// A locally frozen send. Its lease prevents recovery from abandoning a live preparation.
pub struct DraftSend {
    client: Client,
    operation: Operation,
    preparation: std::fs::File,
}
impl DraftSend {
    pub fn id(&self) -> Uuid {
        self.operation.id
    }

    pub async fn open(self) -> Result<Mutation> {
        let snapshot: journal::SendSnapshot =
            serde_json::from_value(self.operation.correlation.clone()).map_err(error)?;
        let mut input = snapshot
            .selection
            .as_object()
            .cloned()
            .ok_or("send selection must be an object")?;
        input.insert(
            "sessionId".into(),
            serde_json::to_value(&self.operation.session_id).map_err(error)?,
        );
        input.insert("message".into(), Value::String(snapshot.draft.text));
        input.insert(
            "quotes".into(),
            serde_json::to_value(snapshot.draft.quotes).map_err(error)?,
        );
        input.insert(
            "attachments".into(),
            serde_json::to_value(
                snapshot
                    .draft
                    .attachments
                    .iter()
                    .map(|attachment| &attachment.id)
                    .collect::<Vec<_>>(),
            )
            .map_err(error)?,
        );
        self.client
            .open_mutation(
                self.operation,
                Value::Object(input),
                Attachments::new(),
                self.preparation,
            )
            .await
    }
}

/// A handle into the shell scope's original request, not a replayable command.
pub struct Mutation {
    client: Client,
    request: Arc<Request>,
    operation: Operation,
    description: Description,
    recovery: Value,
}
impl Drop for Mutation {
    fn drop(&mut self) {
        self.request.end_observation();
        self.client.0.requests_changed.notify_waiters();
    }
}

/// One observation from the original mutation. Cleanup never replaces its business receipt.
#[derive(Debug)]
pub enum MutationEvent {
    Progress(Value),
    /// The original preparation was cleanly aborted before confirmation began.
    NotDispatched,
    Finished {
        reply: Box<OperationReply>,
        cleanup: Result<()>,
    },
}
impl Mutation {
    pub fn id(&self) -> Uuid {
        self.operation.id
    }
    pub async fn prepare(&self) -> Result<Operation> {
        let mut state = self.request.state.lock().await;
        if state.phase != Phase::New {
            return Err("client mutation has already started; recover or close it".into());
        }
        state.phase = Phase::Preparing;
        let result = tokio::select! {
            biased;
            () = self.request.stop.cancelled() => Err("client mutation preparation cancelled".into()),
            result = async {
                state.call.start().await?;
                let reference = match state.call.receive().await? {
                    Reply::Prepared { reference } => reference,
                    Reply::Aborted { reason, cleanup } | Reply::BindingRetired { reason, cleanup } => { cleanup?; return Err(reason); }
                    _ => return Err("Host method is not a mutation".into()),
                };
                let contract = RecoveryContract::for_method(&self.description.contract, &self.operation.method).map_err(error)?;
                // The connection's source witness predates live configuration edits.
                // The Host freezes the selected consumer's revision in this original receipt.
                if reference.source.state_domain != self.operation.host.state_domain
                    || reference.source.deployment != self.operation.host.deployment
                    || reference.namespace != self.description.provider
                    || reference.export != self.description.export || reference.method != self.operation.method || reference.contract != contract {
                    return Err("Host preparation differs from the original client target".into());
                }
                if self.operation.draft.as_ref().is_some_and(|draft| !draft.key.matches(&reference))
                    || self.operation.upload.as_ref().is_some_and(|upload| !upload.key.matches(&reference)) {
                    return Err("Host preparation belongs to another draft owner".into());
                }
                self.client.0.journal.prepared(self.operation.id, &reference).await?;
                self.request.preparation.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                if self.operation.upload.is_some() { self.client.notify_uploads(); }
                state.phase = Phase::Prepared;
                self.client.operation(self.operation.id).await
            } => result,
        };
        if result.is_err() {
            state.phase = Phase::Interrupted;
            let _ = self.client.drain_request(&self.request, &mut state).await;
        }
        self.client.release_if_clean(&self.request, &state).await;
        result
    }
    /// Confirm only after successful durable preparation. Cancellation of this
    /// observer leaves the original Call in the shell scope and fences a second confirm.
    pub async fn confirm(&self) -> Result<OperationReply> {
        let mut event = self.next_step(true).await?;
        loop {
            match event {
                Some(MutationEvent::Progress(_)) => event = self.next().await?,
                Some(MutationEvent::Finished { reply, .. }) => {
                    return Ok(*reply);
                }
                Some(MutationEvent::NotDispatched) => {
                    return Err("client mutation was cancelled before dispatch".into());
                }
                None => return Err("client mutation ended without a business receipt".into()),
            }
        }
    }
    /// Read one original progress item or final receipt, confirming once on the first read.
    /// A dropped observation cannot continue or confirm again; close or recover its receipt.
    pub async fn next(&self) -> Result<Option<MutationEvent>> {
        self.next_step(false).await
    }
    /// Request cancellation of this exact call. Continue reading its original final receipt.
    pub fn request_cancel(&self) {
        self.request.stop.cancel();
    }
    async fn next_step(&self, first: bool) -> Result<Option<MutationEvent>> {
        let mut state = self.request.state.lock().await;
        if first && state.phase != Phase::Prepared {
            return Err("client mutation is not durably prepared".into());
        }
        let confirm = match &state.phase {
            Phase::Prepared => true,
            Phase::Confirming => false,
            Phase::Complete => return Ok(None),
            _ => return Err("original mutation lost its observer; close or recover it".into()),
        };
        state.phase = Phase::Pulling;
        // Only the wire observation races cancellation. Once a final business reply
        // arrives, recording it must finish even if cancellation wins afterwards.
        let received = tokio::select! {
            biased;
            () = self.request.stop.cancelled() => None,
            result = async {
                if confirm {
                    state.call.confirm(self.recovery.clone()).await
                } else {
                    state.call.receive().await
                }
            } => Some(result),
        };
        let result = async {
            match received {
                Some(Ok(Reply::Progress { value })) => {
                    state.phase = Phase::Confirming;
                    Ok(Some(MutationEvent::Progress(value)))
                }
                Some(Ok(Reply::Mutation { reply, cleanup })) => {
                    self.client.observe_mutation(&self.request, &reply).await?;
                    state.phase = Phase::Complete;
                    Ok(Some(MutationEvent::Finished { reply, cleanup }))
                }
                received => {
                    let failure = match received {
                        Some(Err(error)) => Some(error),
                        Some(Ok(
                            Reply::Aborted { reason, cleanup }
                            | Reply::BindingRetired { reason, cleanup },
                        )) => Some(cleanup.err().unwrap_or(reason)),
                        Some(Ok(_)) => {
                            Some("Host mutation did not return its original receipt".into())
                        }
                        None => None,
                    };
                    match self.client.drain_request(&self.request, &mut state).await {
                        Ok(Drained::Finished { reply, cleanup }) => {
                            Ok(Some(MutationEvent::Finished { reply, cleanup }))
                        }
                        Ok(Drained::NotDispatched) => Ok(Some(MutationEvent::NotDispatched)),
                        Ok(Drained::Closed { cleanup }) => {
                            cleanup?;
                            failure.map_or(Ok(None), Err)
                        }
                        Err(error) => Err(failure.unwrap_or(error)),
                    }
                }
            }
        }
        .await;
        self.client.release_if_clean(&self.request, &state).await;
        result
    }
    /// Release a presentation observer without submitting an unconfirmed call
    /// or cancelling work whose confirmation has already begun.
    pub async fn detach(&self) -> Result<()> {
        let mut state = self.request.state.lock().await;
        let result = if matches!(state.phase, Phase::New | Phase::Prepared) {
            self.client
                .drain_request(&self.request, &mut state)
                .await
                .and_then(|drained| match drained {
                    Drained::Finished { cleanup, .. } | Drained::Closed { cleanup } => cleanup,
                    Drained::NotDispatched => Ok(()),
                })
        } else {
            loop {
                if state.phase == Phase::Complete {
                    break Ok(());
                }
                let received = tokio::select! {
                    biased;
                    () = self.request.stop.cancelled() => {
                        break self.client.drain_request(&self.request, &mut state).await.and_then(|drained| match drained {
                            Drained::Finished { cleanup, .. } | Drained::Closed { cleanup } => cleanup,
                            Drained::NotDispatched => Ok(()),
                        });
                    }
                    result = state.call.receive() => result,
                };
                match received {
                    Ok(Reply::Progress { .. }) => state.phase = Phase::Confirming,
                    Ok(Reply::Mutation { reply, cleanup }) => {
                        let recorded = self.client.observe_mutation(&self.request, &reply).await;
                        state.phase = Phase::Complete;
                        break recorded.and(cleanup);
                    }
                    Ok(
                        Reply::Aborted { reason, cleanup }
                        | Reply::BindingRetired { reason, cleanup },
                    ) => {
                        state.phase = Phase::Complete;
                        break Err(cleanup.err().unwrap_or(reason));
                    }
                    Ok(_) => break Err("Host mutation did not return its original receipt".into()),
                    Err(error) => break Err(error),
                }
            }
        };
        self.request.end_observation();
        self.client.0.requests_changed.notify_waiters();
        self.client.release_if_clean(&self.request, &state).await;
        result
    }

    /// Lose only the physical observer. The shell still owns the original request.
    pub async fn disconnect(&self) -> Result<()> {
        let mut state = self.request.state.lock().await;
        let undispatched = state
            .call
            .awaiting_confirmation()
            .then(|| state.call.reference().cloned())
            .flatten();
        state.call.disconnect();
        state.phase = Phase::Interrupted;
        let recorded = if let Some(reference) = undispatched {
            // Disconnect fences this caller from ever confirming. It does not
            // acknowledge remote cleanup of the prepared call.
            self.client
                .0
                .journal
                .abandon_undispatched(&self.client.0.source, self.operation.id, &reference)
                .await
                .map(|_| ())
        } else {
            Ok(())
        };
        self.client.release_if_clean(&self.request, &state).await;
        recorded
    }
    pub async fn close(&self) -> Result<()> {
        self.request_cancel();
        let mut state = self.request.state.lock().await;
        let result = self
            .client
            .drain_request(&self.request, &mut state)
            .await
            .and_then(|drained| match drained {
                Drained::Finished { cleanup, .. } | Drained::Closed { cleanup } => cleanup,
                Drained::NotDispatched => Ok(()),
            });
        self.client.release_if_clean(&self.request, &state).await;
        result
    }
}

pub enum SubscriptionEvent {
    Item(Value),
    Finished(Value),
}
pub struct Subscription {
    client: Client,
    request: Arc<Request>,
}
impl Subscription {
    pub async fn next(&self) -> Result<Option<SubscriptionEvent>> {
        let mut state = self.request.state.lock().await;
        if state.call.cleanup_confirmed() {
            return Ok(None);
        }
        if state.phase != Phase::Streaming {
            return Err(
                "original subscription pull lost its observer; close the subscription".into(),
            );
        }
        state.phase = Phase::Pulling;
        let result = tokio::select! {
            biased;
            () = self.request.stop.cancelled() => Err("client subscription cancelled".into()),
            result = async {
                match state.call.pull().await? {
                    Reply::Item { value } => Ok(Some(SubscriptionEvent::Item(value))),
                    Reply::Finished { result, cleanup } => { cleanup?; Ok(Some(SubscriptionEvent::Finished(result?))) }
                    Reply::Aborted { reason, cleanup } | Reply::BindingRetired { reason, cleanup } => { cleanup?; Err(reason) }
                    _ => Err("Host subscription returned an unexpected response".into()),
                }
            } => result,
        };
        if result.is_err() {
            let _ = state.call.close().await;
        }
        state.phase = if state.call.cleanup_confirmed() {
            Phase::Complete
        } else {
            Phase::Streaming
        };
        self.client.release_if_clean(&self.request, &state).await;
        result
    }
    pub async fn close(&self) -> Result<()> {
        self.request.stop.cancel();
        let mut state = self.request.state.lock().await;
        let result = state.call.close().await;
        self.client.release_if_clean(&self.request, &state).await;
        result
    }
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod fork_position_tests {
    use super::*;
    use serde_json::json;

    fn owner() -> ServiceOwner {
        ServiceOwner {
            namespace: InstanceId(vec![Uuid::new_v4()]),
            export: "agent".into(),
        }
    }
    fn fork(position: Value) -> Value {
        json!({"sessionId": "s", "expectedRevision": 3, "position": position, "title": "t", "labels": []})
    }
    fn row() -> Value {
        json!({"kind": "live", "path": [], "sequence": 7})
    }

    #[test]
    fn fork_accepts_positions_qualified_by_a_source_row() {
        let owner = owner();
        for kind in ["before_source_turn", "through_source_turn"] {
            let position = json!({"kind": kind, "position": row()});
            let correlation = control_correlation("fork", &fork(position.clone()), &owner)
                .unwrap_or_else(|error| panic!("{kind}: {error}"));
            assert_eq!(correlation["position"], position);
            for invalid in [
                json!({"kind": kind}),
                json!({"kind": kind, "position": "row"}),
                json!({"kind": kind, "position": row(), "turnId": "t"}),
            ] {
                assert!(control_correlation("fork", &fork(invalid), &owner).is_err());
            }
        }
        for position in [
            json!({"kind": "start"}),
            json!({"kind": "end"}),
            json!({"kind": "before_turn", "turnId": "t"}),
            json!({"kind": "through_turn", "turnId": "t"}),
        ] {
            assert!(control_correlation("fork", &fork(position), &owner).is_ok());
        }
    }

    #[tokio::test]
    async fn unresolved_source_row_forks_are_recovered_from_the_journal() {
        let directory = tempfile::tempdir().unwrap();
        let journal = Journal::open(&directory.path().join("client.sqlite"))
            .await
            .unwrap();
        let host = DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::new_v4(),
            revision: 1,
        };
        let owner = owner();
        let mut reserved = Vec::new();
        for kind in ["before_source_turn", "through_source_turn", "before_turn"] {
            let position = if kind == "before_turn" {
                json!({"kind": kind, "turnId": "t"})
            } else {
                json!({"kind": kind, "position": row()})
            };
            let operation = Operation {
                id: Uuid::new_v4(),
                host: host.clone(),
                endpoint: "agent".into(),
                method: "fork".into(),
                session_id: Some("s".into()),
                correlation: control_correlation("fork", &fork(position), &owner).unwrap(),
                draft: None,
                upload: None,
                abandoned: false,
                reference: None,
                receipt: None,
            };
            journal.reserve(&operation).await.unwrap();
            reserved.push(operation.id);
        }
        let mut pending: Vec<_> = journal
            .pending_controls(&host, &owner)
            .await
            .unwrap()
            .into_iter()
            .map(|operation| operation.id)
            .collect();
        pending.sort();
        reserved.sort();
        assert_eq!(pending, reserved);
    }
}
