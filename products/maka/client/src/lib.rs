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
    UploadReference,
};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::{
    host::{Client as HostClient, LocalCall},
    transport::{Description, wire::Reply},
};
use maka_plugin_core::{
    contract::text_resource_type,
    deployment::DeploymentRef,
    operation::{OperationReply, RecoveryContract, receipt_reader_contract},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;

const CONTROL_METHODS: [&str; 12] = [
    "create",
    "trustProjectMcp",
    "selectBackend",
    "compact",
    "markRead",
    "stop",
    "stopComputerApp",
    "respond",
    "editQueue",
    "metadata",
    "changeSession",
    "fork",
];
const CONTROL_KIND: &str = "agent-control";
const SETTINGS_KIND: &str = "settings";
const SETTINGS_METHODS: [&str; 10] = [
    "create",
    "update",
    "remove",
    "saveCredential",
    "deleteCredential",
    "updateModelSettings",
    "setDefault",
    "updateAssistantPreferences",
    "updateNetwork",
    "updateWorkspaceLocations",
];
fn settings_route(endpoint: &str, method: &str) -> bool {
    (endpoint == "settings" && SETTINGS_METHODS.contains(&method))
        || (endpoint == "agent" && method == "updateGlobalInstructions")
        || (endpoint == "setup" && method == "discoverModels")
        || (endpoint == "management" && matches!(method, "setEnabled" | "configure"))
        || (endpoint == "authentication" && method == "loginCredential")
}
fn settings_owner(operation: &Operation) -> bool {
    operation.draft.is_none()
        && operation.session_id.is_none()
        && settings_route(&operation.endpoint, &operation.method)
        && operation.correlation == serde_json::json!({"kind": SETTINGS_KIND})
}
fn control_correlation(method: &str, input: &Value) -> Result<Value> {
    let mut correlation = serde_json::json!({"kind": CONTROL_KIND});
    let key = match method {
        "stop" => Some("invocationId"),
        "respond" => Some("requestId"),
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
                "agent control requires a valid invocationId or requestId"
            })?;
        correlation[key] = Value::String(target.to_owned());
    }
    if matches!(method, "metadata" | "changeSession" | "fork") {
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
            let turn = input
                .get("turnId")
                .filter(|turn| turn.is_null() || turn.as_str().is_some_and(|turn| !turn.is_empty()))
                .ok_or("agent fork control requires an original turnId")?;
            correlation["turnId"] = turn.clone();
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
    closing: AtomicBool,
    upload_updates: tokio::sync::watch::Sender<()>,
}
struct Request {
    id: Uuid,
    operation: Option<Uuid>,
    stop: CancellationToken,
    state: Mutex<State>,
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
            closing: AtomicBool::new(false),
            upload_updates: tokio::sync::watch::channel(()).0,
        })))
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

    pub async fn refresh(&self) -> Result<()> {
        let mut host = self.0.host.lock().await;
        if self.0.closing.load(Ordering::Acquire) {
            return Err("client scope is closing".into());
        }
        host.refresh().await
    }

    async fn open(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        resources: Attachments,
        operation: Option<Uuid>,
    ) -> Result<(Arc<Request>, Description)> {
        // Opening and registration share the anchor lock with shutdown. Once closing
        // fences admission, its snapshot includes every previously opened request.
        let host = self.0.host.lock().await;
        if self.0.closing.load(Ordering::Acquire) {
            return Err("client scope is closing".into());
        }
        let description = host.catalogue().describe(endpoint)?.clone();
        let call = host.call(endpoint, method.into(), input, resources).await?;
        let request = Arc::new(Request {
            id: Uuid::new_v4(),
            operation,
            stop: CancellationToken::new(),
            state: Mutex::new(State {
                call,
                phase: Phase::New,
            }),
        });
        self.0
            .requests
            .lock()
            .await
            .insert(request.id, request.clone());
        Ok((request, description))
    }
    async fn release_if_clean(&self, request: &Request, state: &State) {
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
                    Reply::Aborted { reason, cleanup } => { cleanup?; Err(reason) }
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
        self.0.journal.reserve(&operation).await?;
        if operation.upload.is_some() {
            self.notify_uploads();
        }
        self.open_mutation(operation, input, resources).await
    }
    async fn open_mutation(
        &self,
        operation: Operation,
        input: Value,
        resources: Attachments,
    ) -> Result<Mutation> {
        let (request, description) = self
            .open(
                &operation.endpoint,
                &operation.method,
                input,
                resources,
                Some(operation.id),
            )
            .await?;
        Ok(Mutation {
            client: self.clone(),
            request,
            operation,
            description,
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
        if endpoint == "settings" && method == "saveCredential" {
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
        let operation = Operation {
            id,
            host: self.0.source.clone(),
            endpoint: endpoint.into(),
            method: method.into(),
            session_id: None,
            correlation: serde_json::json!({"kind": SETTINGS_KIND}),
            draft: None,
            upload: None,
            abandoned: false,
            reference: None,
            receipt: None,
        };
        self.0.journal.reserve_settings(&operation).await?;
        self.open_mutation(operation, input, resources).await
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
        let correlation = control_correlation(method, &input)?;
        let session_id = if method == "create" {
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
    /// Read the exact saved text in Rust. UI callers provide only its revision
    /// and model selection; editing a subsequent revision remains independent.
    #[allow(clippy::too_many_arguments)]
    pub async fn send_draft(
        &self,
        id: Uuid,
        endpoint: &str,
        session: &str,
        editor: &str,
        revision: u64,
        selection: Value,
    ) -> Result<Mutation> {
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
        if draft.text.trim().is_empty() && draft.attachments.is_empty() {
            return Err("saved draft is empty or already consumed".into());
        }
        let mut input = selection
            .as_object()
            .cloned()
            .ok_or("send selection must be an object")?;
        input.insert("sessionId".into(), Value::String(session.into()));
        input.insert("message".into(), Value::String(draft.text));
        input.insert(
            "attachments".into(),
            serde_json::to_value(
                draft
                    .attachments
                    .iter()
                    .map(|attachment| &attachment.id)
                    .collect::<Vec<_>>(),
            )
            .map_err(error)?,
        );
        let operation = Operation {
            id,
            host: self.0.source.clone(),
            endpoint: endpoint.into(),
            method: "send".into(),
            session_id: Some(session.into()),
            correlation: Value::Null,
            draft: Some(DraftReference { key, revision }),
            upload: None,
            abandoned: false,
            reference: None,
            receipt: None,
        };
        self.0.journal.reserve(&operation).await?;
        let (request, description) = self
            .open(
                endpoint,
                "send",
                Value::Object(input),
                Attachments::new(),
                Some(id),
            )
            .await?;
        Ok(Mutation {
            client: self.clone(),
            request,
            operation,
            description,
        })
    }
    pub async fn operation(&self, id: Uuid) -> Result<Operation> {
        self.0.journal.load(&self.0.source, id).await
    }
    /// A settled or abandoned original still retains its control owner.
    pub async fn operation_for_control(&self, id: Uuid) -> Result<Operation> {
        let operation = self.operation(id).await?;
        let correlation = control_correlation(&operation.method, &operation.correlation);
        if operation.draft.is_some()
            || operation.endpoint != "agent"
            || !CONTROL_METHODS.contains(&operation.method.as_str())
            || correlation.ok().as_ref() != Some(&operation.correlation)
        {
            return Err("original client operation belongs to another control owner".into());
        }
        Ok(operation)
    }
    /// Only this shell's unsettled Agent controls on the current Host deployment.
    pub async fn pending_controls(&self) -> Result<Vec<Operation>> {
        self.0.journal.pending_controls(&self.0.source).await
    }
    /// A settled or abandoned Settings attempt retains its original owner.
    pub async fn operation_for_settings(&self, id: Uuid) -> Result<Operation> {
        let operation = self.operation(id).await?;
        if !settings_owner(&operation) {
            return Err("original client operation belongs to another settings owner".into());
        }
        Ok(operation)
    }
    /// Unsettled terminal attempts for this exact Host and immutable Agent session.
    pub async fn pending_terminals(&self, session: &str) -> Result<Vec<Operation>> {
        self.0
            .journal
            .pending_terminals(&self.0.source, session)
            .await
    }
    /// Unsettled Settings attempts for this exact Host deployment.
    pub async fn pending_settings(&self) -> Result<Vec<Operation>> {
        self.0.journal.pending_settings(&self.0.source).await
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
            let requests: Vec<_> = self
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
        Ok(operation)
    }
    /// Durable attempts for this exact Agent/editor owner. A reserved attempt
    /// without a reference remains unknown and cannot be sent again.
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
        let operation = self.operation(id).await?;
        let original = operation
            .reference
            .as_ref()
            .ok_or("client attempt has no confirmed preparation; it cannot be replayed")?;
        let value = self
            .query(
                &self.0.receipts,
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
                    Reply::Aborted { reason, cleanup } => { cleanup?; Err(reason) }
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
    /// Request cancellation and drain this exact session. A recovered business
    /// result does not prove physical cleanup; only this session's own close ack
    /// can release disconnected requests. Retain the scope if this returns an error.
    pub async fn close(&self) -> Result<()> {
        self.0.closing.store(true, Ordering::Release);
        let mut host = self.0.host.lock().await;
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
        host.close().await?;
        self.0.requests.lock().await.clear();
        Ok(())
    }
}

/// A handle into the shell scope's original request, not a replayable command.
pub struct Mutation {
    client: Client,
    request: Arc<Request>,
    operation: Operation,
    description: Description,
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
                    Reply::Aborted { reason, cleanup } => { cleanup?; return Err(reason); }
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
                Some(MutationEvent::Finished { reply, cleanup }) => {
                    cleanup?;
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
                    state.call.confirm().await
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
                        Some(Ok(Reply::Aborted { reason, cleanup })) => {
                            Some(cleanup.err().unwrap_or(reason))
                        }
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
    /// Lose only the physical observer. The shell still owns the original request.
    pub async fn disconnect(&self) {
        let mut state = self.request.state.lock().await;
        state.call.disconnect();
        state.phase = Phase::Interrupted;
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
                    Reply::Aborted { reason, cleanup } => { cleanup?; Err(reason) }
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
mod tests;
