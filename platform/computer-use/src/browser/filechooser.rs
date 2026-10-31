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

//! File chooser handles belong to an existing tab, document and invocation turn.

use super::{BrowserCall, BrowserIdentity, Browsers, Cdp, Tab, check_input, failed, origin};
use crate::protocol::{BrowserFileChooserOptions, Handle};
use cua_driver_core::browser::cdp_ws::CdpEvent;
use futures_util::{FutureExt, future::BoxFuture, future::Shared};
use maka_agent_facts::language::Language;
use maka_agent_facts::tools::ToolError;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, Weak};
use std::{collections::HashMap, time::Duration};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Scope {
    owner: uuid::Uuid,
    browser: BrowserIdentity,
    tab: String,
    frame: String,
    loader: String,
    turn: String,
}

impl Scope {
    pub(super) fn capture(
        owner: uuid::Uuid,
        tab: &Tab,
        document: &origin::DocumentIdentity,
        turn: &str,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            owner,
            browser: tab.identity()?.browser,
            tab: tab.info.id.clone(),
            frame: document.frame_id().into(),
            loader: document.loader_id().into(),
            turn: turn.into(),
        })
    }

    fn same_tab(&self, current: &Self) -> bool {
        self.owner == current.owner && self.browser == current.browser && self.tab == current.tab
    }

    fn check(&self, current: &Self) -> Result<(), ToolError> {
        if self.owner != current.owner || self.browser != current.browser || self.tab != current.tab
        {
            return Err(failed(format!("File chooser belongs to tab {}", self.tab)));
        }
        if self.turn != current.turn {
            return Err(failed("File chooser belongs to an earlier invocation turn"));
        }
        if self.frame != current.frame || self.loader != current.loader {
            return Err(failed("File chooser document is no longer current"));
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Selection {
    scope: Scope,
    backend_node: u64,
    multiple: bool,
    frame: Option<FrameFence>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FrameFence {
    id: String,
    loader: String,
}

impl FrameFence {
    fn find(tree: &Value, id: &str) -> Option<Self> {
        let frame = &tree["frame"];
        if frame["id"].as_str() == Some(id) {
            return Some(Self {
                id: id.into(),
                loader: frame["loaderId"]
                    .as_str()
                    .filter(|loader| !loader.is_empty())?
                    .into(),
            });
        }
        tree["childFrames"]
            .as_array()?
            .iter()
            .find_map(|child| Self::find(child, id))
    }
}

#[derive(Clone)]
struct Opened {
    backend_node: u64,
    multiple: bool,
    frame: Option<String>,
}

fn opened(event: &CdpEvent) -> Option<Result<Opened, ToolError>> {
    if event.method != "Page.fileChooserOpened" {
        return None;
    }
    let backend_node = event.params["backendNodeId"]
        .as_u64()
        .filter(|value| *value > 0)?;
    if event.session_id.is_some() || event.source_target_id.is_some() {
        return Some(Err(failed(
            "File uploads in out-of-process frames are not supported.",
        )));
    }
    Some(Ok(Opened {
        backend_node,
        multiple: event.params["mode"] == "selectMultiple",
        frame: event.params["frameId"].as_str().map(str::to_owned),
    }))
}

type Effect = Shared<BoxFuture<'static, Result<(), ToolError>>>;
pub(super) type Wait = Shared<BoxFuture<'static, Result<Value, ToolError>>>;

enum Cleanup {
    Uninstalled(Cdp),
    Ready(Cdp),
    Pending(Effect),
}

struct Pending {
    scope: Scope,
    cancellation: CancellationToken,
    completion: Wait,
    cleanup: Cleanup,
}

#[derive(Default)]
struct State {
    closed: bool,
    pending: HashMap<uuid::Uuid, Pending>,
    selections: HashMap<String, Selection>,
    failure: Option<ToolError>,
}

/// Chooser handles for one existing Tab, not a permission store. The original
/// Host settlement owns each exact pending completion.
#[derive(Clone, Default)]
pub(super) struct Store {
    state: Arc<Mutex<State>>,
}

fn uncertain(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }
    )
}

impl Store {
    pub(super) async fn arm(
        &self,
        socket: Cdp,
        scope: Scope,
        timeout: Duration,
        cancellation: CancellationToken,
    ) -> Result<Wait, ToolError> {
        let id = uuid::Uuid::new_v4();
        let cancelled = cancellation.clone();
        let (started, ready) = oneshot::channel();
        let retained = Arc::downgrade(&self.state);
        let waiting_scope = scope.clone();
        let active_socket = socket.clone();
        let future = async move {
            let installed = async {
                check_input(&cancelled)?;
                active_socket
                    .raw_call(None, "Page.enable", json!({}))
                    .await
                    .map_err(Cdp::failure)?;
                check_input(&cancelled)?;
                mark_interception(&retained, id, true)?;
                if let Err(error) = active_socket
                    .raw_call(
                        None,
                        "Page.setInterceptFileChooserDialog",
                        json!({"enabled":true}),
                    )
                    .await
                {
                    let error = Cdp::failure(error);
                    if !uncertain(&error) {
                        mark_interception(&retained, id, false)?;
                    }
                    return Err(error);
                }
                Ok(())
            }
            .await;
            // Original begins observing after the interception ACK. Subscribe
            // before publishing arm readiness, so the following click cannot
            // precede this subscription. Earlier events are not replayed.
            let mut events = active_socket.connection.subscribe();
            let _ = started.send(installed.clone());
            let result = match installed {
                Ok(()) => {
                    wait_event(
                        &active_socket,
                        &waiting_scope,
                        &mut events,
                        timeout,
                        &cancelled,
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            let result = match result {
                Ok(selection) => {
                    let chooser = uuid::Uuid::new_v4().to_string();
                    let multiple = selection.multiple;
                    if let Some(state) = retained.upgrade() {
                        let mut state = state.lock().expect("file chooser state poisoned");
                        if state.closed {
                            Err(failed("File chooser Session closed"))
                        } else {
                            state.selections.insert(chooser.clone(), selection);
                            Ok(json!({"fileChooserId":chooser,"isMultiple":multiple}))
                        }
                    } else {
                        Err(failed("File chooser Session closed"))
                    }
                }
                Err(error) => Err(error),
            };
            let cleanup = cleanup_wait(&retained, id).await;
            let final_result = match (result, cleanup) {
                (Err(error), _) if uncertain(&error) => Err(error),
                (_, Err(error)) => Err(error),
                (result, Ok(())) => result,
            };
            if let Some(state) = retained.upgrade() {
                let mut state = state.lock().expect("file chooser state poisoned");
                if let Err(error) = &final_result
                    && uncertain(error)
                {
                    state.failure.get_or_insert_with(|| error.clone());
                }
                state.pending.remove(&id);
            }
            final_result
        }
        .boxed()
        .shared();
        {
            let mut state = self.state.lock().expect("file chooser state poisoned");
            if state.closed {
                return Err(failed("File chooser Session closed"));
            }
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            state.pending.insert(
                id,
                Pending {
                    scope,
                    cancellation,
                    completion: future.clone(),
                    cleanup: Cleanup::Uninstalled(socket),
                },
            );
        }
        // Drive installation while the Session lock is still held. The same
        // future is retained before polling; a click can follow only after ACK.
        let mut driven = future.clone();
        let installation = tokio::select! {
            result = &mut driven => return result.map(|_| future),
            installed = ready => installed.map_err(|_| failed("File chooser installation observer ended"))?,
        };
        match installation {
            Ok(()) => Ok(future),
            Err(error) => match future.await {
                Err(cause) if uncertain(&cause) => Err(cause),
                _ => Err(error),
            },
        }
    }

    fn selection(&self, id: &str, scope: &Scope, files: &[String]) -> Result<Selection, ToolError> {
        let state = self.state.lock().expect("file chooser state poisoned");
        if state.closed {
            return Err(failed("File chooser Session closed"));
        }
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        let selection = state
            .selections
            .get(id)
            .ok_or_else(|| failed(format!("Unknown file chooser id \"{id}\"")))?;
        selection.scope.check(scope)?;
        if files.is_empty() {
            return Err(failed("fileChooser.setFiles requires at least one file"));
        }
        if !selection.multiple && files.len() > 1 {
            return Err(failed("File chooser does not accept multiple files"));
        }
        Ok(selection.clone())
    }

    fn held(
        &self,
        id: &str,
        tab: &Tab,
        owner: uuid::Uuid,
        turn: &str,
        files: &[String],
    ) -> Result<Selection, ToolError> {
        let selection = {
            let state = self.state.lock().expect("file chooser state poisoned");
            if state.closed {
                return Err(failed("File chooser Session closed"));
            }
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            state
                .selections
                .get(id)
                .cloned()
                .ok_or_else(|| failed(format!("Unknown file chooser id \"{id}\"")))?
        };
        let current = Scope {
            owner,
            browser: tab.identity()?.browser,
            tab: tab.info.id.clone(),
            turn: turn.into(),
            ..selection.scope.clone()
        };
        // Validate the issued object and count before browser I/O or approval.
        self.selection(id, &current, files)
    }

    fn consumed(&self, id: &str) {
        self.state
            .lock()
            .expect("file chooser state poisoned")
            .selections
            .remove(id);
    }

    fn quarantine(&self, error: &ToolError) {
        if uncertain(error) {
            self.state
                .lock()
                .expect("file chooser state poisoned")
                .failure
                .get_or_insert_with(|| error.clone());
        }
    }

    pub(super) fn begin_close(&self) {
        let mut state = self.state.lock().expect("file chooser state poisoned");
        state.closed = true;
        state.selections.clear();
        for pending in state.pending.values() {
            pending.cancellation.cancel();
        }
    }

    pub(super) async fn close(
        &self,
        scope: Option<&Scope>,
        current: Option<Cdp>,
    ) -> Result<(), ToolError> {
        let pending = {
            let mut state = self.state.lock().expect("file chooser state poisoned");
            if scope.is_none() {
                state.closed = true;
            }
            state
                .selections
                .retain(|_, selection| scope.is_some_and(|scope| !selection.scope.same_tab(scope)));
            state
                .pending
                .values_mut()
                .filter(|pending| scope.is_none_or(|scope| pending.scope.same_tab(scope)))
                .map(|pending| {
                    if let (Cleanup::Ready(socket) | Cleanup::Uninstalled(socket), Some(current)) =
                        (&mut pending.cleanup, &current)
                    {
                        *socket = current.clone();
                    }
                    pending.cancellation.cancel();
                    pending.completion.clone()
                })
                .collect::<Vec<_>>()
        };
        let mut failure = None;
        for future in pending {
            if let Err(error) = future.await
                && uncertain(&error)
            {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        match &self
            .state
            .lock()
            .expect("file chooser state poisoned")
            .failure
        {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

fn mark_interception(
    state: &Weak<Mutex<State>>,
    id: uuid::Uuid,
    enabled: bool,
) -> Result<(), ToolError> {
    let state = state
        .upgrade()
        .ok_or_else(|| failed("File chooser lost its owner"))?;
    let mut state = state.lock().expect("file chooser state poisoned");
    let pending = state
        .pending
        .get_mut(&id)
        .ok_or_else(|| failed("File chooser wait is no longer tracked"))?;
    match &pending.cleanup {
        Cleanup::Uninstalled(socket) if enabled => pending.cleanup = Cleanup::Ready(socket.clone()),
        Cleanup::Ready(socket) if !enabled => {
            pending.cleanup = Cleanup::Uninstalled(socket.clone())
        }
        Cleanup::Pending(_) => {
            return Err(ToolError::CleanupUnconfirmed(
                "File chooser interception changed while cleanup was pending".into(),
            ));
        }
        _ => {}
    }
    Ok(())
}

async fn cleanup_wait(state: &Weak<Mutex<State>>, id: uuid::Uuid) -> Result<(), ToolError> {
    let Some(state) = state.upgrade() else {
        return Err(ToolError::CleanupUnconfirmed(
            "File chooser cleanup lost its actual owner".into(),
        ));
    };
    let future = {
        let mut state = state.lock().expect("file chooser state poisoned");
        let pending = state
            .pending
            .get_mut(&id)
            .ok_or_else(|| failed("File chooser wait is no longer tracked"))?;
        match &pending.cleanup {
            Cleanup::Uninstalled(_) => return Ok(()),
            Cleanup::Pending(future) => future.clone(),
            Cleanup::Ready(socket) => {
                let socket = socket.clone();
                let future = async move {
                    socket
                        .raw_call(
                            None,
                            "Page.setInterceptFileChooserDialog",
                            json!({"enabled":false}),
                        )
                        .await
                        .map(|_| ())
                        .map_err(|error| {
                            let error = Cdp::failure(error);
                            if uncertain(&error) {
                                error
                            } else {
                                ToolError::CleanupUnconfirmed(format!(
                                    "File chooser interception cleanup failed: {error}"
                                ))
                            }
                        })
                }
                .boxed()
                .shared();
                pending.cleanup = Cleanup::Pending(future.clone());
                future
            }
        }
    };
    future.await
}

async fn wait_event(
    socket: &Cdp,
    scope: &Scope,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<CdpEvent>,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<Selection, ToolError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        check_input(cancellation)?;
        if tokio::time::Instant::now() >= deadline {
            return Err(failed(format!(
                "Timed out after {}ms waiting for file chooser.",
                timeout.as_millis()
            )));
        }
        let event = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(failed("File chooser wait cancelled")),
            event = tokio::time::timeout_at(deadline, events.recv()) => event.map_err(|_| failed(format!("Timed out after {}ms waiting for file chooser.", timeout.as_millis())))?.ok_or_else(|| failed("File chooser event stream ended"))?,
        };
        if event.session_id.is_none()
            && event.source_target_id.is_none()
            && ((event.method == "Page.frameNavigated"
                && event.params["frame"]["id"] == scope.frame)
                || event.method == "Inspector.detached")
        {
            return Err(failed("File chooser document changed or detached"));
        }
        let Some(event) = opened(&event) else {
            continue;
        };
        let event = event?;
        let tree = socket
            .observe_in(None, "Page.getFrameTree", json!({}))
            .await?;
        let root = FrameFence::find(&tree["frameTree"], &scope.frame)
            .ok_or_else(|| failed("File chooser main document is no longer present"))?;
        if root.loader != scope.loader {
            return Err(failed("File chooser document is no longer current"));
        }
        let frame = event
            .frame
            .map(|id| {
                FrameFence::find(&tree["frameTree"], &id)
                    .ok_or_else(|| failed("File chooser frame document is no longer current"))
            })
            .transpose()?;
        return Ok(Selection {
            scope: scope.clone(),
            backend_node: event.backend_node,
            multiple: event.multiple,
            frame,
        });
    }
}

fn required_completion(result: Result<Value, ToolError>) -> Result<(), ToolError> {
    match result {
        Err(error) if uncertain(&error) => Err(error),
        _ => Ok(()),
    }
}

fn provenance_supported(tab: &Tab) -> Result<(), ToolError> {
    if let Some(provider) = tab.provider.extension()
        && !provider
            .capabilities()
            .map_err(super::provider::extension_error)?
            .cdp_event_source_target
    {
        return Err(failed(
            "This extension has not established complete CDP file chooser event provenance",
        ));
    }
    Ok(())
}

impl Browsers {
    pub(crate) async fn prepare_file_chooser(
        &mut self,
        handle: Handle,
        options: BrowserFileChooserOptions,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<crate::InvocationCompletion, ToolError> {
        let timeout = options.timeout()?;
        let Handle::Tab(handle) = handle else {
            return Err(failed("File chooser wait requires a browser tab"));
        };
        let tab = self
            .targets
            .get(&handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?;
        // This producer declaration is a provenance feature, not permission.
        // Missing support refuses before any chooser interception is sent.
        provenance_supported(tab)?;
        let identity = tab.identity()?;
        self.use_tab(&identity, invocation.turn(), cancellation)
            .await?;
        let tab = self
            .targets
            .get_mut(&handle)
            .expect("checked file chooser tab");
        tab.last_turn = invocation.turn().into();
        tab.authorize(None, invocation, cancellation, language)
            .await?;
        tab.verify(BrowserCall::new(invocation, cancellation, language))
            .await?;
        let document = tab.document_identity().await?;
        let proof = tab
            .origin_proof
            .clone()
            .ok_or_else(|| failed("File chooser requires its admitted current document"))?;
        proof.check_current(tab).await?;
        let services = invocation
            .prepare_browser_services(
                crate::BrowserAccess::Metadata {
                    document: tab.document(),
                },
                cancellation,
            )
            .await?;
        let settlement = services
            .settlement
            .ok_or_else(|| failed("File chooser waits require original Host settlement custody"))?;
        if tab.document_identity().await? != document {
            return Err(failed(
                "File chooser document changed during Host service admission",
            ));
        }
        let scope = Scope::capture(self.owner, tab, &document, invocation.turn())?;
        let store = tab.filechoosers.get_or_insert_with(Store::default).clone();
        let stop = cancellation.child_token();
        let socket = tab
            .socket
            .as_ref()
            .expect("verified file chooser socket")
            .clone();
        let future = store.arm(socket, scope, timeout, stop.clone()).await?;
        let retained = future.clone();
        if let Err((error, pending)) =
            settlement.retain_checked(Box::pin(async move { required_completion(retained.await) }))
        {
            stop.cancel();
            let original = future.await;
            let cleanup = pending.await;
            return match (original, cleanup) {
                (Err(cause), _) if uncertain(&cause) => Err(cause),
                (_, Err(cause)) => Err(cause),
                _ => Err(error),
            };
        }
        Ok(crate::InvocationCompletion::pending(future))
    }
}

impl Tab {
    pub(super) async fn cleanup_filechoosers_current(&mut self) -> Result<(), ToolError> {
        if let Some(store) = &self.filechoosers {
            store.close(None, self.socket.clone()).await?;
            self.filechoosers = None;
        }
        Ok(())
    }

    pub(super) async fn cleanup_filechoosers(&mut self) -> Result<(), ToolError> {
        if let Some(store) = &self.filechoosers {
            store.close(None, None).await?;
            self.filechoosers = None;
        }
        Ok(())
    }
}

struct PreparedUpload {
    selection: Selection,
    store: Store,
    chooser: String,
    socket: Cdp,
    proof: origin::DocumentOrigin,
    authorization: Arc<dyn crate::BrowserAuthorization>,
    provider: super::provider::Provider,
    control: super::extension::UploadControl,
    claim: cua_driver_core::browser::ExtensionPhysicalClaim,
    host: Arc<tokio::sync::Mutex<super::Host>>,
    owner: uuid::Uuid,
    request: crate::BrowserUploadRequest,
    files: Vec<crate::BrowserUploadFile>,
}
impl PreparedUpload {
    async fn control<T>(
        &self,
        pending: impl std::future::Future<
            Output = Result<T, Box<cua_driver_core::browser::ExtensionProviderError>>,
        >,
    ) -> Result<T, ToolError> {
        // UploadControl holds the same issued CallScope and its exact typed
        // control gate. Local staging does not claim a raw-CDP activation.
        // The caller rechecks upload authority before every new resource write.
        let result = Box::pin(pending)
            .await
            .map_err(super::provider::extension_error);
        let folded = self
            .host
            .lock()
            .await
            .reconcile_provider(self.owner, &self.provider)
            .await;
        let result = match (result, folded) {
            (Err(error), _) if uncertain(&error) => Err(error),
            (_, Err(error)) => Err(error),
            (result, Ok(_)) => result,
        };
        if let Err(error) = &result {
            self.store.quarantine(error);
        }
        result
    }

    fn descriptors(&self) -> Result<Vec<cua_driver_core::browser::ExtensionUploadFile>, ToolError> {
        self.files
            .iter()
            .map(|file| {
                let metadata = file.resource.metadata();
                let digest = metadata["digest"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("sha256:"))
                    .ok_or_else(|| {
                        failed("Host upload snapshot has no immutable SHA-256 digest")
                    })?;
                let sha256: [u8; 32] = hex::decode(digest)
                    .map_err(failed)?
                    .try_into()
                    .map_err(|_| failed("Host upload snapshot SHA-256 has the wrong length"))?;
                if metadata["name"].as_str() != Some(file.name.as_str())
                    || metadata["bytes"].as_u64() != Some(file.resource.bytes() as u64)
                {
                    return Err(failed(
                        "Host upload snapshot metadata disagrees with its immutable resource",
                    ));
                }
                let modified = metadata.get("modified").ok_or_else(|| {
                    failed("Host upload snapshot has no observed modification time")
                })?;
                let seconds = modified["seconds"].as_i64().ok_or_else(|| {
                    failed("Upload modification seconds are not a signed integer")
                })?;
                let nanos = u32::try_from(modified["nanos"].as_u64().ok_or_else(|| {
                    failed("Upload modification nanos are not an unsigned integer")
                })?)
                .map_err(failed)?;
                let modified =
                    cua_driver_core::browser::ExtensionUploadModifiedTime::new(seconds, nanos)
                        .map_err(failed)?;
                cua_driver_core::browser::ExtensionUploadFile::new(
                    file.name.clone(),
                    file.resource.bytes() as u64,
                    sha256,
                )
                .map(|descriptor| descriptor.with_modified(modified))
                .map_err(failed)
            })
            .collect()
    }

    async fn stage(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<cua_driver_core::browser::ExtensionRetainedUpload, ToolError> {
        let descriptors = self.descriptors()?;
        self.check(cancellation).await?;
        let stage = self
            .control(self.control.begin_upload(&self.claim, &descriptors))
            .await?;
        let copied = async {
            for (index, file) in self.files.iter().enumerate() {
                let index = u32::try_from(index).map_err(failed)?;
                let mut offset = 0usize;
                while offset < file.resource.bytes() {
                    self.check_authority(cancellation).await?;
                    let end = offset.saturating_add(64 * 1024).min(file.resource.bytes());
                    let resource = file.resource.clone();
                    let range = offset..end;
                    // Resource reads are bounded and the same physical job is
                    // joined; cancellation never detaches a source reader.
                    let chunk = tokio::task::spawn_blocking(move || resource.read(range))
                        .await
                        .map_err(failed)?
                        .map_err(failed)?;
                    if chunk.len() != end - offset {
                        return Err(failed("Host upload snapshot returned a partial chunk"));
                    }
                    self.control(self.control.write_upload_chunk(
                        &stage,
                        index,
                        offset as u64,
                        &chunk,
                    ))
                    .await?;
                    offset = end;
                }
            }
            self.check(cancellation).await
        }
        .await;
        if let Err(error) = copied {
            if uncertain(&error) {
                return Err(error);
            }
            // Only this unexposed stage can be abandoned. No new upload grant
            // is requested for cleanup and no retained selection is deleted.
            return match self.control(self.control.abandon_upload(&stage)).await {
                Ok(_) => Err(error),
                Err(cleanup) if uncertain(&cleanup) => Err(cleanup),
                Err(cleanup) => Err(ToolError::CleanupUnconfirmed(format!(
                    "{error}; upload stage cleanup failed: {cleanup}"
                ))),
            };
        }
        // Retain ACK is intentionally before DOM dispatch. Backing survives
        // success, caller loss, turn completion and detach, not merely this RPC.
        let retained = self
            .control(self.control.retain_upload_for_selection(&stage))
            .await?;
        // Every source read and native write is joined. This exact retain ACK
        // confirms the independent browser-host backing; DOM selection no
        // longer consumes the Host snapshots or their packing reservations.
        // Drop only this chooser's references. Other resource consumers retain
        // their own Arcs, and selected native backing remains with its owner.
        self.files.clear();
        Ok(retained)
    }

    async fn check_authority(&self, cancellation: &CancellationToken) -> Result<(), ToolError> {
        check_input(cancellation)?;
        self.authorization
            .check_upload(self.request.clone(), cancellation.clone())
            .await
    }
    async fn check(&self, cancellation: &CancellationToken) -> Result<(), ToolError> {
        self.check_authority(cancellation).await?;
        self.proof
            .check_cdp_current(&self.socket, &self.request.document)
            .await?;
        if let Some(frame) = &self.selection.frame {
            let tree = self
                .socket
                .observe_in(None, "Page.getFrameTree", json!({}))
                .await?;
            if FrameFence::find(&tree["frameTree"], &frame.id).as_ref() != Some(frame) {
                return Err(failed(
                    "File chooser frame document changed during upload authorization",
                ));
            }
        }
        check_input(cancellation)
    }
}

impl Tab {
    async fn prepare_file_upload(
        &mut self,
        owner: uuid::Uuid,
        chooser: String,
        paths: Vec<String>,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<PreparedUpload, ToolError> {
        let store = self
            .filechoosers
            .as_ref()
            .ok_or_else(|| failed(format!("Unknown file chooser id \"{chooser}\"")))?
            .clone();
        let held = store.held(&chooser, self, owner, invocation.turn(), &paths)?;
        provenance_supported(self)?;
        let provider = self.provider.clone();
        let extension=provider.extension().cloned().ok_or_else(||failed("Browser file upload requires a browser-host filesystem placement; configured CDP has none"))?;
        if !extension
            .capabilities()
            .map_err(super::provider::extension_error)?
            .upload_staging
        {
            return Err(failed(
                "This extension has no established browser-host upload placement",
            ));
        }
        // The embedding and worker share the same actual Host authorization
        // object; no local or remote file path is passed through as a grant.
        let authorization = invocation
            .browser_authorization()
            .ok_or_else(|| failed("Browser file upload requires Host authorization"))?;
        self.authorize(None, invocation, cancellation, language)
            .await?;
        self.verify(BrowserCall::new(invocation, cancellation, language))
            .await?;
        let current = self.document_identity().await?;
        held.scope
            .check(&Scope::capture(owner, self, &current, invocation.turn())?)?;
        let proof = self
            .origin_proof
            .clone()
            .ok_or_else(|| failed("Browser file upload requires its admitted current document"))?;
        proof.check_current(self).await?;
        let request = crate::BrowserUploadRequest {
            document: self.document(),
            source_origin: proof.origin(),
            files: paths,
        };
        let files = authorization
            .prepare_upload(request.clone(), cancellation.clone())
            .await?;
        if files.len() != request.files.len() {
            return Err(failed(
                "Host upload snapshot count does not match the admitted input",
            ));
        }
        let control = self.upload_control(invocation).await?;
        let claim = self
            .extension_claim
            .clone()
            .ok_or_else(|| failed("Upload lacks its actual physical claim"))?;
        let upload = PreparedUpload {
            selection: held,
            store,
            chooser,
            provider,
            control,
            claim,
            host: self.cursor_host.clone(),
            owner,
            socket: self
                .socket
                .as_ref()
                .expect("verified upload socket")
                .clone(),
            proof,
            authorization,
            request,
            files,
        };
        upload.check(cancellation).await?;
        Ok(upload)
    }
}

impl Browsers {
    pub(crate) async fn set_file_chooser_files(
        &mut self,
        handle: Handle,
        chooser: String,
        files: Vec<String>,
        options: BrowserFileChooserOptions,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let BrowserCall {
            invocation,
            cancellation,
            language,
        } = call;
        // Original validates an optional setter timeout but does not use it to
        // discard an already dispatched file-selection request.
        options.timeout()?;
        let Handle::Tab(handle) = handle else {
            return Err(failed("File chooser requires a browser tab"));
        };
        let tab = self
            .targets
            .get(&handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?;
        let store = tab
            .filechoosers
            .as_ref()
            .ok_or_else(|| failed(format!("Unknown file chooser id \"{chooser}\"")))?;
        store.held(&chooser, tab, self.owner, invocation.turn(), &files)?;
        let identity = tab.identity()?;
        self.use_tab(&identity, invocation.turn(), cancellation)
            .await?;
        let tab = self
            .targets
            .get_mut(&handle)
            .expect("checked file chooser tab");
        tab.last_turn = invocation.turn().into();
        let mut upload = tab
            .prepare_file_upload(
                self.owner,
                chooser,
                files,
                invocation,
                cancellation,
                language,
            )
            .await?;
        let result=async {
            let retained=upload.stage(cancellation).await?;
            upload.check(cancellation).await?;
            let paths=retained.paths().iter().map(|path|path.to_str().map(str::to_owned).ok_or_else(||failed("Browser-host upload path is not valid Unicode"))).collect::<Result<Vec<_>,_>>()?;
            if paths.len()!=upload.request.files.len() {return Err(failed("Browser-host upload path count does not match the approved files"));}
            // These paths came only from this actual native-host retain ACK.
            // No caller pathname or guessed cross-OS mapping reaches Chrome.
            match upload.socket.raw_call(None,"DOM.setFileInputFiles",json!({"backendNodeId":upload.selection.backend_node,"files":paths})).await {
                Ok(_) => {upload.store.consumed(&upload.chooser);Ok(Value::Null)},
                Err(error) => {
                    let guidance=error.downcast_ref::<cua_driver_core::browser::cdp_ws::CdpReplyError>().is_some_and(|reply|
                        reply.method()=="DOM.setFileInputFiles" && reply.message()=="Not allowed" && reply.disposition()==cua_driver_core::browser::CdpFailureDisposition::ReplyFailure);
                    let error=Cdp::failure(error);
                    if guidance {Err(failed(format!("{error}. Allow file URL access for the selected browser extension before retrying this chooser.")))} else {Err(error)}
                }
            }
        }.await;
        if let Err(error) = &result {
            upload.store.quarantine(error);
        }
        // The existing Host/provider ledger retains the native backing receipt.
        // Dropping this observer is not a request to delete selected files.
        result
    }
}

#[cfg(test)]
mod tests;
