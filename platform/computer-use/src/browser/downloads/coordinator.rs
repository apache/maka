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

//! One admitted tab's paused responses and download intent lifetime.

use super::*;
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared as SharedFuture},
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Release {
    Request,
    Response,
    Fail,
}

type ReleaseFuture = SharedFuture<BoxFuture<'static, Result<(), ToolError>>>;

enum DispatchStatus {
    Unpolled,
    Started,
    Cancelled,
}

enum ResponsePhase {
    Held,
    Pending {
        release: Release,
        future: ReleaseFuture,
        dispatch: Arc<Mutex<DispatchStatus>>,
    },
    Failed {
        release: Release,
        error: ToolError,
    },
}

struct OwnedResponse {
    socket: Cdp,
    phase: ResponsePhase,
}

#[derive(Clone)]
struct Automatic {
    socket: Cdp,
    host: Option<Arc<dyn crate::BrowserHostEffects>>,
}

pub(super) type ArmFuture = SharedFuture<BoxFuture<'static, Result<Value, ToolError>>>;

struct PendingArm {
    cancellation: CancellationToken,
    future: Option<ArmFuture>,
}

struct Inner {
    arms: HashMap<uuid::Uuid, PendingArm>,
    enabled: bool,
    pending: Option<response::Paused>,
    responses: HashMap<String, OwnedResponse>,
    installation: Installation,
    automatic: Automatic,
    closed: bool,
    error: Option<ToolError>,
}

#[derive(Clone)]
enum Installation {
    New,
    Registered {
        future: ReleaseFuture,
        dispatch: Arc<Mutex<DispatchStatus>>,
    },
}

struct Shared {
    inner: Mutex<Inner>,
    changed: Notify,
    stopped: CancellationToken,
}

pub(in crate::browser) struct Controller {
    shared: Arc<Shared>,
    metadata: Option<metadata::Metadata>,
    worker: JoinHandle<()>,
    closed: bool,
}

/// Owned completion returned before releasing the Session lock.
/// The admitting Host keeps this same future through its ordinary T1/T2 custody.
pub(super) struct Armed {
    id: uuid::Uuid,
    shared: Arc<Shared>,
    metadata: metadata::Metadata,
    socket: Cdp,
    session_metadata: super::super::extension::SessionMetadataCall,
    access: Arc<dyn crate::BrowserAuthorization>,
    document: crate::BrowserDocument,
    cancellation: CancellationToken,
    timeout: Duration,
    settled: bool,
}

impl Shared {
    fn observe(self: &Arc<Self>, event: cua_driver_core::browser::cdp_ws::CdpEvent) {
        let action = {
            let mut inner = self.inner.lock().expect("download response lock poisoned");
            if inner.closed {
                return;
            }
            let disposition = match response::classify(&event, inner.enabled) {
                Ok(Some(action)) => action,
                Ok(None) => return,
                Err(error) => {
                    inner.error = Some(error);
                    self.changed.notify_waiters();
                    return;
                }
            };
            let context = inner.automatic.clone();
            let (id, release) = match disposition {
                response::Disposition::ContinueRequest(id) => (id, Release::Request),
                response::Disposition::ContinueResponse(id) => (id, Release::Response),
                response::Disposition::Download(paused) => {
                    let id = paused.id.clone();
                    inner.responses.insert(
                        id.clone(),
                        OwnedResponse {
                            socket: context.socket.clone(),
                            phase: ResponsePhase::Held,
                        },
                    );
                    if inner.enabled {
                        inner.enabled = false;
                        inner.pending = Some(paused);
                        self.changed.notify_waiters();
                        return;
                    }
                    (id, Release::Fail)
                }
            };
            inner
                .responses
                .entry(id.clone())
                .or_insert_with(|| OwnedResponse {
                    socket: context.socket.clone(),
                    phase: ResponsePhase::Held,
                });
            (context, id, release)
        };
        let (context, id, release) = action;
        let state = self.clone();
        let delayed = self.clone();
        let accepted = context
            .host
            .as_ref()
            .ok_or_else(|| failed("Download response handling requires Host effect admission"))
            .and_then(|host| {
                context.socket.spawn_host_effect(
                    host,
                    move |socket| {
                        Box::pin(async move {
                            state.release(&id, release, None, Some(socket), None).await
                        })
                    },
                    Box::new(move |error| delayed.admission_failed(error)),
                )
            });
        if let Err(error) = accepted {
            self.admission_failed(error);
        }
    }

    fn admission_failed(&self, error: ToolError) {
        self.inner
            .lock()
            .expect("download response lock poisoned")
            .error = Some(cleanup(format!(
            "Download response was retained because Host admission failed: {error}"
        )));
        self.changed.notify_waiters();
    }

    async fn release(
        &self,
        id: &str,
        release: Release,
        overrides: Option<Value>,
        socket_override: Option<Cdp>,
        cancellation: Option<CancellationToken>,
    ) -> Result<(), ToolError> {
        self.release_observed(id, release, overrides, socket_override, cancellation)
            .await
            .map(|_| ())
    }

    async fn release_observed(
        &self,
        id: &str,
        release: Release,
        overrides: Option<Value>,
        socket_override: Option<Cdp>,
        cancellation: Option<CancellationToken>,
    ) -> Result<Option<Release>, ToolError> {
        loop {
            let (actual_release, future) = {
                let mut inner = self.inner.lock().expect("download response lock poisoned");
                let Some(response) = inner.responses.get_mut(id) else {
                    return Ok(None);
                };
                match &response.phase {
                    ResponsePhase::Pending {
                        release: previous,
                        future,
                        dispatch,
                    } => {
                        if release == Release::Fail && *previous != Release::Fail {
                            let mut state =
                                dispatch.lock().expect("download dispatch lock poisoned");
                            if matches!(*state, DispatchStatus::Unpolled) {
                                *state = DispatchStatus::Cancelled;
                            }
                        }
                        (*previous, future.clone())
                    }
                    ResponsePhase::Failed {
                        release: previous,
                        error,
                    } if release != Release::Fail || *previous == Release::Fail => {
                        return Err(error.clone());
                    }
                    ResponsePhase::Held | ResponsePhase::Failed { .. } => {
                        let socket = socket_override
                            .clone()
                            .unwrap_or_else(|| response.socket.clone());
                        response.socket = socket.clone();
                        let (method, params) = match release {
                            Release::Request => ("Fetch.continueRequest", json!({"requestId":id})),
                            Release::Fail => (
                                "Fetch.failRequest",
                                json!({"requestId":id,"errorReason":"BlockedByClient"}),
                            ),
                            Release::Response => {
                                let mut params = overrides.clone().unwrap_or_else(|| json!({}));
                                params["requestId"] = Value::String(id.to_owned());
                                ("Fetch.continueResponse", params)
                            }
                        };
                        let dispatch = Arc::new(Mutex::new(DispatchStatus::Unpolled));
                        let gate = dispatch.clone();
                        let stopped = self.stopped.clone();
                        let cancelled = cancellation.clone();
                        let future = async move {
                            {
                                let mut state =
                                    gate.lock().expect("download dispatch lock poisoned");
                                if matches!(*state, DispatchStatus::Cancelled)
                                    || (release != Release::Fail
                                        && (stopped.is_cancelled()
                                            || cancelled
                                                .as_ref()
                                                .is_some_and(CancellationToken::is_cancelled)))
                                {
                                    *state = DispatchStatus::Cancelled;
                                    return Err(failed(
                                        "Document response continuation cancelled before dispatch",
                                    ));
                                }
                                *state = DispatchStatus::Started;
                            }
                            socket
                                .raw_call(None, method, params)
                                .await
                                .map(|_| ())
                                .map_err(Cdp::failure)
                        }
                        .boxed()
                        .shared();
                        // The canonical response owns the exact unpolled request before
                        // any observer can dispatch it or lose its observation future.
                        response.phase = ResponsePhase::Pending {
                            release,
                            future: future.clone(),
                            dispatch,
                        };
                        (release, future)
                    }
                }
            };
            let result = future.await;
            {
                let mut inner = self.inner.lock().expect("download response lock poisoned");
                let matching = inner.responses.get(id).is_some_and(|response| matches!(&response.phase, ResponsePhase::Pending { release, .. } if *release == actual_release));
                if matching {
                    match &result {
                        Ok(()) => {
                            inner.responses.remove(id);
                        }
                        Err(error) => {
                            inner
                                .responses
                                .get_mut(id)
                                .expect("retained original response")
                                .phase = ResponsePhase::Failed {
                                release: actual_release,
                                error: error.clone(),
                            };
                        }
                    }
                }
                self.changed.notify_waiters();
            }
            if release == Release::Fail && actual_release != Release::Fail && result.is_err() {
                // Failing a still-paused response is cleanup, never a replay of
                // the failed continuation. Concurrent cleanup awaits this same call.
                continue;
            }
            return result.map(|_| Some(actual_release));
        }
    }

    async fn release_download(
        &self,
        response: response::Paused,
        completion: &metadata::Completion,
        socket: Cdp,
        cancellation: &CancellationToken,
    ) -> Result<cua_driver_core::browser::ExtensionDownloadMetadata, ToolError> {
        let actual = self
            .release_observed(
                &response.id,
                Release::Response,
                response.overrides,
                Some(socket),
                Some(cancellation.clone()),
            )
            .await?;
        if actual != Some(Release::Response) {
            self.pending(&response.id)?;
            return Err(failed(
                "The paused download response is no longer available.",
            ));
        }
        // The original continuation's real ACK crossed the effect boundary.
        // Closing now cannot become a pre-release known failure.
        {
            let mut inner = self.inner.lock().expect("download response lock poisoned");
            if inner
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == response.id)
            {
                inner.pending = None;
            }
        }
        tokio::select! {
            biased;
            ()=self.stopped.cancelled()=>Err(unknown("Download tab detached after response release; extension file state is unknown")),
            result=completion.wait(cancellation)=>result,
        }
    }

    fn pending(&self, id: &str) -> Result<(), ToolError> {
        let inner = self.inner.lock().expect("download response lock poisoned");
        if inner
            .pending
            .as_ref()
            .is_none_or(|pending| pending.id != id)
        {
            return Err(failed(
                "The paused download response is no longer available.",
            ));
        }
        if inner.closed || self.stopped.is_cancelled() {
            return Err(failed("Download tab was detached"));
        }
        Ok(())
    }

    async fn disable(&self) -> Result<(), ToolError> {
        let pending = {
            let mut inner = self.inner.lock().expect("download response lock poisoned");
            inner.enabled = false;
            inner.pending.as_ref().map(|pending| pending.id.clone())
        };
        if let Some(id) = pending {
            self.release(&id, Release::Fail, None, None, None).await?;
            let mut inner = self.inner.lock().expect("download response lock poisoned");
            if inner
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
            {
                inner.pending = None;
            }
        }
        Ok(())
    }

    async fn request(
        &self,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<response::Paused, ToolError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let changed = self.changed.notified();
            {
                let inner = self.inner.lock().expect("download response lock poisoned");
                if let Some(error) = &inner.error {
                    return Err(error.clone());
                }
                if let Some(pending) = &inner.pending {
                    return Ok(pending.clone());
                }
                if inner.closed {
                    return Err(failed("Download tab was detached"));
                }
            }
            tokio::select! {
                biased;
                ()=cancellation.cancelled()=>return Err(failed("Download wait cancelled before response release")),
                ()=self.stopped.cancelled()=>return Err(failed("Download tab was detached")),
                ()=changed=>{},
                ()=tokio::time::sleep_until(deadline)=>return Err(failed(format!("Timed out after {}ms waiting for download.", timeout.as_millis()))),
            }
        }
    }
}

impl Controller {
    pub(in crate::browser) fn start(
        socket: Cdp,
        metadata: Option<metadata::Metadata>,
        host: Option<Arc<dyn crate::BrowserHostEffects>>,
    ) -> Self {
        let mut events = socket.connection.subscribe();
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                arms: HashMap::new(),
                enabled: false,
                pending: None,
                responses: HashMap::new(),
                installation: Installation::New,
                automatic: Automatic { socket, host },
                closed: false,
                error: None,
            }),
            changed: Notify::new(),
            stopped: CancellationToken::new(),
        });
        let observed = shared.clone();
        let worker = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                observed.observe(event);
            }
            let mut inner = observed
                .inner
                .lock()
                .expect("download response lock poisoned");
            inner.error = Some(unknown("Download tab event stream disconnected"));
            observed.changed.notify_waiters();
        });
        Self {
            shared,
            metadata,
            worker,
            closed: false,
        }
    }

    pub(in crate::browser) fn update(
        &self,
        socket: Cdp,
        host: Option<Arc<dyn crate::BrowserHostEffects>>,
    ) {
        self.shared
            .inner
            .lock()
            .expect("download response lock poisoned")
            .automatic = Automatic { socket, host };
    }

    pub(in crate::browser) async fn install(&self) -> Result<(), ToolError> {
        let future = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .expect("download response lock poisoned");
            match &inner.installation {
                Installation::Registered { future, .. } => future.clone(),
                Installation::New => {
                    let socket = inner.automatic.socket.clone();
                    let stopped = self.shared.stopped.clone();
                    let dispatch = Arc::new(Mutex::new(DispatchStatus::Unpolled));
                    let gate = dispatch.clone();
                    let future = async move {
                        {
                            let mut state = gate.lock().expect("download setup dispatch lock poisoned");
                            if matches!(*state, DispatchStatus::Cancelled) || stopped.is_cancelled() {
                                *state = DispatchStatus::Cancelled;
                                return Err(failed("Download interception setup cancelled before dispatch"));
                            }
                            *state = DispatchStatus::Started;
                        }
                        let result = socket.raw_call(None, "Fetch.enable", json!({"patterns":[{"resourceType":"Document","requestStage":"Response"}]})).await;
                        if let Err(error) = &result
                            && Cdp::is_pre_dispatch_guard_failure(error)
                        {
                            // The Host/ledger guard refused before this numeric
                            // RPC existed. Do not pretend setup was dispatched.
                            *gate.lock().expect("download setup dispatch lock poisoned") = DispatchStatus::Cancelled;
                        }
                        result.map(|_| ()).map_err(Cdp::failure)
                    }.boxed().shared();
                    inner.installation = Installation::Registered {
                        future: future.clone(),
                        dispatch,
                    };
                    future
                }
            }
        };
        future.await
    }

    pub(super) async fn arm(
        &self,
        document: crate::BrowserDocument,
        session_metadata: super::super::extension::SessionMetadataCall,
        access: Arc<dyn crate::BrowserAuthorization>,
        cancellation: CancellationToken,
        timeout: Duration,
    ) -> Result<Armed, ToolError> {
        let metadata = self.metadata.clone().ok_or_else(|| {
            failed("Extension download notifications are unavailable for this browser provider")
        })?;
        self.install().await?;
        let socket = self
            .shared
            .inner
            .lock()
            .expect("download response lock poisoned")
            .automatic
            .socket
            .clone();
        check_input(&cancellation)?;
        let id = uuid::Uuid::new_v4();
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .expect("download response lock poisoned");
            if inner.closed {
                return Err(failed("Download tab was detached"));
            }
            inner.enabled = true;
            inner.arms.insert(
                id,
                PendingArm {
                    cancellation: cancellation.clone(),
                    future: None,
                },
            );
        }
        Ok(Armed {
            id,
            shared: self.shared.clone(),
            metadata,
            socket,
            session_metadata,
            access,
            document,
            cancellation,
            timeout,
            settled: false,
        })
    }

    pub(in crate::browser) fn begin_close(&self) {
        let mut inner = self
            .shared
            .inner
            .lock()
            .expect("download response lock poisoned");
        inner.enabled = false;
        inner.closed = true;
        inner.automatic.host = None;
        for arm in inner.arms.values() {
            arm.cancellation.cancel();
        }
        self.shared.stopped.cancel();
        self.shared.changed.notify_waiters();
    }

    pub(in crate::browser) async fn close(&mut self) -> Result<(), ToolError> {
        self.close_with_socket(None).await
    }

    pub(in crate::browser) async fn close_with_socket(
        &mut self,
        admitted_socket: Option<Cdp>,
    ) -> Result<(), ToolError> {
        if self.closed {
            return Ok(());
        }
        self.begin_close();
        let installation = self
            .shared
            .inner
            .lock()
            .expect("download response lock poisoned")
            .installation
            .clone();
        match installation {
            Installation::Registered { future, dispatch } => {
                {
                    let mut gate = dispatch
                        .lock()
                        .expect("download setup dispatch lock poisoned");
                    if matches!(*gate, DispatchStatus::Unpolled) {
                        *gate = DispatchStatus::Cancelled;
                    }
                }
                let result = future.await;
                let unsent = matches!(
                    *dispatch
                        .lock()
                        .expect("download setup dispatch lock poisoned"),
                    DispatchStatus::Cancelled
                );
                if let Err(error) = result
                    && !unsent
                {
                    return Err(cleanup(format!(
                        "ChatGPT Document interception setup did not settle: {error}"
                    )));
                }
            }
            Installation::New => {}
        }
        let arms = {
            let inner = self
                .shared
                .inner
                .lock()
                .expect("download response lock poisoned");
            inner
                .arms
                .values()
                .map(|arm| {
                    arm.future.clone().ok_or_else(|| {
                        cleanup("Download arming custody was not registered before Session release")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        for arm in arms {
            super::required_completion(arm.await)?;
        }
        loop {
            let response = {
                let inner = self
                    .shared
                    .inner
                    .lock()
                    .expect("download response lock poisoned");
                inner
                    .responses
                    .iter()
                    .next()
                    .map(|(id, response)| match &response.phase {
                        ResponsePhase::Held | ResponsePhase::Pending { .. } => Ok(id.clone()),
                        ResponsePhase::Failed { release, error } => {
                            if *release != Release::Fail {
                                Ok(id.clone())
                            } else {
                                Err(cleanup(format!(
                                    "Document response release remains unconfirmed: {error}"
                                )))
                            }
                        }
                    })
            };
            match response {
                None => break,
                Some(Ok(id)) => {
                    self.shared
                        .release(&id, Release::Fail, None, admitted_socket.clone(), None)
                        .await?
                }
                Some(Err(error)) => return Err(error),
            }
        }
        self.worker.abort();
        match (&mut self.worker).await {
            Ok(()) => {}
            Err(error) if error.is_cancelled() => {}
            Err(error) => {
                return Err(cleanup(format!(
                    "Download response observer did not stop: {error}"
                )));
            }
        }
        self.closed = true;
        Ok(())
    }
}

impl Armed {
    pub(super) fn shared(self) -> ArmFuture {
        let state = self.shared.clone();
        let id = self.id;
        let future = self.wait().boxed().shared();
        state
            .inner
            .lock()
            .expect("download response lock poisoned")
            .arms
            .get_mut(&id)
            .expect("original download arm")
            .future = Some(future.clone());
        future
    }

    async fn current_document(&self) -> Result<crate::BrowserDocument, ToolError> {
        check_input(&self.cancellation)?;
        if self.session_metadata.generation() != self.document.generation {
            return Err(failed("Download browser generation changed"));
        }
        let tab = self.session_metadata.resolve(&self.document.tab_id).await?;
        if tab.id.to_string() != self.document.tab_id {
            return Err(failed("Download metadata resolved a different tab"));
        }
        let mut document = self.document.clone();
        document.url = tab
            .url
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| failed("Download current page URL is unavailable"))?;
        check_input(&self.cancellation)?;
        Ok(document)
    }

    async fn check_origin_current(
        &self,
        proof: &super::super::origin::DocumentOrigin,
    ) -> Result<(), ToolError> {
        let current = self.current_document().await?;
        self.access
            .check(
                crate::BrowserAccess::Metadata {
                    document: current.clone(),
                },
                self.cancellation.clone(),
            )
            .await?;
        proof.check_cdp_current(&self.socket, &current).await
    }

    async fn execute(&self) -> Result<Value, ToolError> {
        let response = self
            .shared
            .request(self.timeout, &self.cancellation)
            .await?;
        let document = self.current_document().await?;
        self.access
            .authorize(
                crate::BrowserAccess::Metadata {
                    document: document.clone(),
                },
                self.cancellation.clone(),
            )
            .await?;
        self.shared.pending(&response.id)?;
        let proof =
            super::super::origin::resolve_document_origin(&self.socket, document.clone(), None)
                .await?;
        self.access
            .authorize(proof.access(), self.cancellation.clone())
            .await?;
        self.shared.pending(&response.id)?;
        self.check_origin_current(&proof).await?;
        let access = crate::BrowserAccess::Download {
            document,
            source_origin: proof.origin(),
            url: response.url.clone(),
        };
        self.access
            .authorize(access.clone(), self.cancellation.clone())
            .await?;
        self.shared.pending(&response.id)?;
        self.check_origin_current(&proof).await?;
        self.access.check(access, self.cancellation.clone()).await?;
        self.shared.pending(&response.id)?;
        check_input(&self.cancellation)?;
        self.metadata.synchronize().await?;
        self.shared.pending(&response.id)?;
        self.check_origin_current(&proof).await?;
        check_input(&self.cancellation)?;
        let completion = self
            .metadata
            .completion(response.url.clone(), self.timeout)?;
        // The listener exists before release; a same-call Started/Complete cannot be lost.
        let result = self
            .shared
            .release_download(
                response,
                &completion,
                self.socket.clone(),
                &self.cancellation,
            )
            .await?;
        Ok(json!({"downloadId":result.id,"downloadScope":self.metadata.scope()}))
    }

    pub(super) async fn wait(mut self) -> Result<Value, ToolError> {
        let result = self.execute().await;
        let cleanup_result = self.shared.disable().await;
        self.settled = true;
        self.shared
            .inner
            .lock()
            .expect("download response lock poisoned")
            .arms
            .remove(&self.id);
        match (result, cleanup_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(cleanup(error)),
            (Err(error), Err(cleanup_error)) => Err(cleanup(format!(
                "{error}; download response cleanup: {cleanup_error}"
            ))),
        }
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.cancellation.cancel();
        let mut inner = self
            .shared
            .inner
            .lock()
            .expect("download response lock poisoned");
        inner.enabled = false;
        inner.error = Some(cleanup(
            "Download waiter lost its original Host settlement before cleanup confirmation",
        ));
        self.shared.changed.notify_waiters();
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.shared.stopped.cancel();
        self.worker.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

    async fn wire() -> (Cdp, WebSocketStream<tokio::net::TcpStream>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let connection = cua_driver_core::browser::cdp_ws::CdpConnection::connect_bounded(
            &format!("ws://{address}"),
            usize::MAX,
        )
        .await
        .unwrap();
        (
            Cdp {
                connection: Arc::new(connection),
                dialogs: None,
                extension_context: None,
                preparation: crate::browser::extension::PreparationTransport::NotRequired,
            },
            peer.await.unwrap(),
        )
    }

    fn paused(socket: Cdp) -> Arc<Shared> {
        Arc::new(Shared {
            inner: Mutex::new(Inner {
                arms: HashMap::new(),
                enabled: false,
                pending: Some(response::Paused {
                    id: "owned-response".into(),
                    url: "https://fixture.test/file".into(),
                    overrides: None,
                }),
                responses: HashMap::from([(
                    "owned-response".into(),
                    OwnedResponse {
                        socket: socket.clone(),
                        phase: ResponsePhase::Held,
                    },
                )]),
                installation: Installation::New,
                automatic: Automatic { socket, host: None },
                closed: false,
                error: None,
            }),
            changed: Notify::new(),
            stopped: CancellationToken::new(),
        })
    }

    async fn request(peer: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
        serde_json::from_str(peer.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
    }

    async fn reply(peer: &mut WebSocketStream<tokio::net::TcpStream>, request: &Value) {
        peer.send(Message::Text(
            json!({"id":request["id"],"result":{}}).to_string().into(),
        ))
        .await
        .unwrap();
    }

    #[derive(Default)]
    struct AutomaticEffects {
        pending: Mutex<Vec<JoinHandle<Result<(), ToolError>>>>,
    }

    impl crate::BrowserHostEffects for AutomaticEffects {
        fn spawn(&self, unpolled: crate::HostEffectFuture) -> Result<(), ToolError> {
            self.pending.lock().unwrap().push(tokio::spawn(unpolled));
            Ok(())
        }
    }

    impl AutomaticEffects {
        async fn observe_one(&self) {
            let pending = std::mem::take(&mut *self.pending.lock().unwrap());
            assert_eq!(pending.len(), 1, "one actual response creates one effect");
            pending.into_iter().next().unwrap().await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn absent_extension_metadata_still_intercepts_and_blocks_unarmed_downloads_once() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (socket, mut peer) = wire().await;
            // This executor only runs the original response futures. It does not
            // fabricate Extension provider capabilities, site grants or file custody.
            let effects = Arc::new(AutomaticEffects::default());
            let mut controller = Controller::start(socket.clone(), None, Some(effects.clone()));
            let (installed, ()) = tokio::join!(controller.install(), async {
                let command = request(&mut peer).await;
                assert_eq!(command["method"], "Fetch.enable");
                assert_eq!(
                    command["params"],
                    json!({"patterns":[{"resourceType":"Document","requestStage":"Response"}]})
                );
                reply(&mut peer, &command).await;
            });
            installed.unwrap();
            assert!(controller.metadata.is_none());
            for (id, mime, expected) in [
                ("ordinary-html", "text/html", "Fetch.continueResponse"),
                (
                    "unarmed-file",
                    "application/octet-stream",
                    "Fetch.failRequest",
                ),
            ] {
                peer.send(Message::Text(
                    json!({
                        "method":"Fetch.requestPaused",
                        "params":{
                            "requestId":id,
                            "resourceType":"Document",
                            "responseStatusCode":200,
                            "responseHeaders":[{"name":"Content-Type","value":mime}],
                            "request":{"url":"https://fixture.test/response"}
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
                let command = request(&mut peer).await;
                assert_eq!(command["method"], expected);
                assert_eq!(command["params"]["requestId"], id);
                if expected == "Fetch.failRequest" {
                    assert_eq!(command["params"]["errorReason"], "BlockedByClient");
                }
                reply(&mut peer, &command).await;
                effects.observe_one().await;
                let inner = controller.shared.inner.lock().unwrap();
                assert!(inner.responses.is_empty());
                assert!(inner.arms.is_empty());
                assert!(!inner.enabled);
                assert!(inner.pending.is_none());
                assert!(inner.error.is_none());
            }
            controller.close().await.unwrap();
            // A real later wire request orders all earlier continuations. Any
            // duplicate continue/fail or setup replay would appear before it.
            let (barrier, ()) = tokio::join!(
                socket.observe_in(None, "Page.getFrameTree", json!({})),
                async {
                    let command = request(&mut peer).await;
                    assert_eq!(command["method"], "Page.getFrameTree");
                    reply(&mut peer, &command).await;
                }
            );
            barrier.unwrap();
            assert!(effects.pending.lock().unwrap().is_empty());
            peer.close(None).await.unwrap();
        })
        .await
        .expect("actual response wire did not settle");
    }

    #[tokio::test]
    async fn dropped_release_observer_retains_the_exact_rpc_and_cleanup_does_not_replay_it() {
        let (socket, mut peer) = wire().await;
        let shared = paused(socket.clone());
        let mut continuation =
            Box::pin(shared.release("owned-response", Release::Response, None, None, None));
        let command = tokio::select! {
            command=request(&mut peer)=>command,
            result=&mut continuation=>panic!("continuation completed before its real reply: {result:?}"),
        };
        assert_eq!(command["method"], "Fetch.continueResponse");
        assert_eq!(command["params"]["requestId"], "owned-response");
        drop(continuation);
        reply(&mut peer, &command).await;
        shared
            .release("owned-response", Release::Fail, None, None, None)
            .await
            .unwrap();
        assert!(shared.inner.lock().unwrap().responses.is_empty());
        // A matched later request is an ordering barrier: any replay would appear first.
        let barrier = socket.observe_in(None, "Page.getFrameTree", json!({}));
        let (_, ()) = tokio::join!(
            async {
                barrier.await.unwrap();
            },
            async {
                let next = request(&mut peer).await;
                assert_eq!(next["method"], "Page.getFrameTree");
                reply(&mut peer, &next).await;
            }
        );
        peer.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn stop_before_first_poll_fails_the_owned_response_without_continuing_it() {
        let (socket, mut peer) = wire().await;
        let shared = paused(socket);
        shared.stopped.cancel();
        assert!(
            shared
                .release("owned-response", Release::Response, None, None, None)
                .await
                .is_err()
        );
        let (result, ()) = tokio::join!(
            shared.release("owned-response", Release::Fail, None, None, None),
            async {
                let command = request(&mut peer).await;
                assert_eq!(command["method"], "Fetch.failRequest");
                assert_eq!(command["params"]["requestId"], "owned-response");
                reply(&mut peer, &command).await;
            }
        );
        result.unwrap();
        assert!(shared.inner.lock().unwrap().responses.is_empty());
        peer.close(None).await.unwrap();
    }
    #[tokio::test]
    async fn dropped_setup_observer_keeps_the_original_fetch_enable_until_close_observes_its_reply()
    {
        let (socket, mut peer) = wire().await;
        let mut controller =
            Controller::start(socket.clone(), Some(metadata::setup_fixture()), None);
        let mut setup = Box::pin(controller.install());
        let command = tokio::select! {
            command=request(&mut peer)=>command,
            result=&mut setup=>panic!("setup completed before its real reply: {result:?}"),
        };
        assert_eq!(command["method"], "Fetch.enable");
        drop(setup);
        let mut close = Box::pin(controller.close());
        futures_util::future::poll_fn(|context| {
            assert!(
                std::future::Future::poll(close.as_mut(), context).is_pending(),
                "close must observe its original setup reply"
            );
            std::task::Poll::Ready(())
        })
        .await;
        reply(&mut peer, &command).await;
        close.await.unwrap();
        let barrier = socket.observe_in(None, "Page.getFrameTree", json!({}));
        let (_, ()) = tokio::join!(
            async {
                barrier.await.unwrap();
            },
            async {
                let next = request(&mut peer).await;
                assert_eq!(
                    next["method"], "Page.getFrameTree",
                    "setup must not replay during close"
                );
                reply(&mut peer, &next).await;
            }
        );
        peer.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn operation_stop_before_continuation_poll_fails_only_the_owned_response() {
        let (socket, mut peer) = wire().await;
        let shared = paused(socket);
        let operation = CancellationToken::new();
        operation.cancel();
        assert!(
            !shared.stopped.is_cancelled(),
            "operation cancellation is distinct from tab closure"
        );
        assert!(
            shared
                .release(
                    "owned-response",
                    Release::Response,
                    None,
                    None,
                    Some(operation)
                )
                .await
                .is_err()
        );
        let (result, ()) = tokio::join!(
            shared.release("owned-response", Release::Fail, None, None, None),
            async {
                let command = request(&mut peer).await;
                assert_eq!(command["method"], "Fetch.failRequest");
                assert_eq!(command["params"]["requestId"], "owned-response");
                reply(&mut peer, &command).await;
            }
        );
        result.unwrap();
        peer.close(None).await.unwrap();
    }
    #[tokio::test]
    async fn actual_continue_ack_and_stop_keep_unknown_custody_without_replay() {
        for stop_before_ack in [true, false] {
            let (socket, mut peer) = wire().await;
            let (metadata, _original_metadata_commands) = metadata::completion_fixture();
            let mut controller = Controller::start(socket.clone(), Some(metadata.clone()), None);
            let shared = controller.shared.clone();
            let response = response::Paused {
                id: "owned-response".into(),
                url: "https://fixture.test/file".into(),
                overrides: None,
            };
            {
                let mut inner = shared.inner.lock().unwrap();
                inner.pending = Some(response.clone());
                inner.responses.insert(
                    response.id.clone(),
                    OwnedResponse {
                        socket: socket.clone(),
                        phase: ResponsePhase::Held,
                    },
                );
            }
            let completion = metadata
                .completion(response.url.clone(), Duration::from_secs(60))
                .unwrap();
            let cancellation = CancellationToken::new();
            let mut continued = Box::pin(shared.release_download(
                response,
                &completion,
                socket.clone(),
                &cancellation,
            ));
            let command = tokio::select! {
                command=request(&mut peer)=>command,
                result=&mut continued=>panic!("continuation completed before its actual wire reply: {result:?}"),
            };
            assert_eq!(command["method"], "Fetch.continueResponse");
            assert_eq!(command["params"]["requestId"], "owned-response");
            if stop_before_ack {
                controller.begin_close();
                assert!(
                    futures_util::poll!(&mut continued).is_pending(),
                    "Stop cannot replace the original pending RPC before its actual ACK"
                );
                let inner = shared.inner.lock().unwrap();
                assert!(matches!(
                    &inner.responses["owned-response"].phase,
                    ResponsePhase::Pending {
                        release: Release::Response,
                        ..
                    }
                ));
            }
            reply(&mut peer, &command).await;
            if !stop_before_ack {
                tokio::time::timeout(
                    Duration::from_secs(5),
                    futures_util::future::poll_fn(|context| {
                        assert!(
                            std::future::Future::poll(continued.as_mut(), context).is_pending(),
                            "no Extension completion has been observed"
                        );
                        if shared.inner.lock().unwrap().responses.is_empty() {
                            std::task::Poll::Ready(())
                        } else {
                            std::task::Poll::Pending
                        }
                    }),
                )
                .await
                .expect("the original continuation ACK was not consumed");
                controller.begin_close();
            }
            let actual = continued.await;
            assert!(
                matches!(&actual, Err(ToolError::OutcomeUnknown(_))),
                "an actually released download cannot become known Failed on Stop: {actual:?}"
            );
            let actual_required = super::super::required_completion(actual.map(|_| Value::Null));
            assert!(
                matches!(actual_required, Err(ToolError::OutcomeUnknown(_))),
                "the actual wire outcome must not become checked-settlement Ok"
            );
            let pending_cancellation = CancellationToken::new();
            let mut original_completion = Box::pin(completion.wait(&pending_cancellation));
            assert!(
                futures_util::poll!(&mut original_completion).is_pending(),
                "neither wire ACK nor Stop invents a Extension completion"
            );
            assert!(shared.inner.lock().unwrap().responses.is_empty());
            controller.close().await.unwrap();
            let barrier = socket.observe_in(None, "Page.getFrameTree", json!({}));
            let (_, ()) = tokio::join!(
                async {
                    barrier.await.unwrap();
                },
                async {
                    let next = request(&mut peer).await;
                    assert_eq!(
                        next["method"], "Page.getFrameTree",
                        "cleanup must not replay ContinueResponse or fail an already released response"
                    );
                    reply(&mut peer, &next).await;
                }
            );
            peer.close(None).await.unwrap();
        }
    }
    #[tokio::test]
    async fn actual_fail_ack_does_not_claim_that_a_download_response_was_released() {
        let (socket, mut peer) = wire().await;
        let shared = paused(socket.clone());
        let (metadata, _original_metadata_commands) = metadata::completion_fixture();
        let completion = metadata
            .completion("https://fixture.test/file".into(), Duration::from_secs(60))
            .unwrap();
        let response = shared.inner.lock().unwrap().pending.clone().unwrap();
        let (blocked, ()) = tokio::join!(
            shared.release("owned-response", Release::Fail, None, None, None),
            async {
                let command = request(&mut peer).await;
                assert_eq!(command["method"], "Fetch.failRequest");
                reply(&mut peer, &command).await;
            }
        );
        blocked.unwrap();
        shared.stopped.cancel();
        let cancellation = CancellationToken::new();
        let actual = shared
            .release_download(response, &completion, socket.clone(), &cancellation)
            .await;
        assert!(
            matches!(actual, Err(ToolError::Failed(_))),
            "a real blocked response must not be called a released unknown download"
        );
        let barrier = socket.observe_in(None, "Page.getFrameTree", json!({}));
        let (_, ()) = tokio::join!(
            async {
                barrier.await.unwrap();
            },
            async {
                let next = request(&mut peer).await;
                assert_eq!(
                    next["method"], "Page.getFrameTree",
                    "no continuation may be replayed after the real Fail ACK"
                );
                reply(&mut peer, &next).await;
            }
        );
        peer.close(None).await.unwrap();
    }
    async fn no_replay_before_barrier(
        socket: &Cdp,
        peer: &mut WebSocketStream<tokio::net::TcpStream>,
    ) {
        let (result, ()) = tokio::join!(
            socket.observe_in(None, "Page.getFrameTree", json!({})),
            async {
                let observed = request(peer).await;
                assert_eq!(
                    observed["method"], "Page.getFrameTree",
                    "an old setup/release was replayed before the barrier"
                );
                reply(peer, &observed).await;
            }
        );
        result.unwrap();
    }

    #[tokio::test]
    async fn guard_refused_setup_has_no_numeric_wire_and_close_does_not_claim_it_started() {
        let (socket, mut peer) = wire().await;
        let mut refused = socket.clone();
        refused.preparation = super::super::super::extension::PreparationTransport::Unadmitted;
        let mut controller = Controller::start(refused, None, None);
        assert!(controller.install().await.is_err());
        {
            let inner = controller.shared.inner.lock().unwrap();
            let Installation::Registered { dispatch, .. } = &inner.installation else {
                panic!("original setup future retained");
            };
            assert!(matches!(
                *dispatch.lock().unwrap(),
                DispatchStatus::Cancelled
            ));
        }
        controller.close().await.unwrap();
        no_replay_before_barrier(&socket, &mut peer).await;
        peer.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn actual_wire_reply_is_not_unsent_even_if_its_message_looks_like_a_guard_refusal() {
        let (socket, mut peer) = wire().await;
        let mut controller = Controller::start(socket.clone(), None, None);
        let (result, ()) = tokio::join!(controller.install(), async {
            let observed = request(&mut peer).await;
            assert_eq!(observed["method"], "Fetch.enable");
            peer.send(Message::Text(json!({"id":observed["id"],"error":{"code":-32000,"message":"Browser session preparation requires Host authorization"}}).to_string().into())).await.unwrap();
        });
        assert!(result.is_err());
        {
            let inner = controller.shared.inner.lock().unwrap();
            let Installation::Registered { dispatch, .. } = &inner.installation else {
                panic!("original setup future retained");
            };
            assert!(matches!(*dispatch.lock().unwrap(), DispatchStatus::Started));
        }
        assert!(matches!(
            controller.close().await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(controller.install().await.is_err());
        no_replay_before_barrier(&socket, &mut peer).await;
        peer.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn explicit_close_uses_current_socket_for_held_response_not_terminal_producer_socket() {
        let (old_wire, mut old_peer) = wire().await;
        let mut old = old_wire.clone();
        old.preparation = super::super::super::extension::PreparationTransport::Unadmitted;
        let (current, mut current_peer) = wire().await;
        let mut controller = Controller::start(current.clone(), None, None);
        controller.shared = paused(old);
        let (closed, ()) =
            tokio::join!(controller.close_with_socket(Some(current.clone())), async {
                let observed = request(&mut current_peer).await;
                assert_eq!(observed["method"], "Fetch.failRequest");
                assert_eq!(observed["params"]["requestId"], "owned-response");
                reply(&mut current_peer, &observed).await;
            });
        closed.unwrap();
        assert!(controller.shared.inner.lock().unwrap().responses.is_empty());
        no_replay_before_barrier(&old_wire, &mut old_peer).await;
        no_replay_before_barrier(&current, &mut current_peer).await;
        old_peer.close(None).await.unwrap();
        current_peer.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn current_close_override_never_replaces_an_already_written_response_future() {
        let (old, mut old_peer) = wire().await;
        let (current, mut current_peer) = wire().await;
        let shared = paused(old.clone());
        let mut original =
            Box::pin(shared.release("owned-response", Release::Response, None, None, None));
        let written = tokio::select! {
            observed = request(&mut old_peer) => observed,
            result = &mut original => panic!("response completed before its actual ACK: {result:?}"),
        };
        assert_eq!(written["method"], "Fetch.continueResponse");
        drop(original);
        let mut controller = Controller::start(current.clone(), None, None);
        controller.shared = shared.clone();
        let mut closed = Box::pin(controller.close_with_socket(Some(current.clone())));
        assert!(
            futures_util::poll!(&mut closed).is_pending(),
            "an override cannot settle the original future"
        );
        reply(&mut old_peer, &written).await;
        closed.await.unwrap();
        assert!(shared.inner.lock().unwrap().responses.is_empty());
        no_replay_before_barrier(&old, &mut old_peer).await;
        no_replay_before_barrier(&current, &mut current_peer).await;
        old_peer.close(None).await.unwrap();
        current_peer.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn wire_loss_after_setup_write_keeps_registered_unknown_setup_and_no_replay() {
        let (socket, mut peer) = wire().await;
        let mut controller = Controller::start(socket, None, None);
        let (result, ()) = tokio::join!(controller.install(), async {
            let observed = request(&mut peer).await;
            assert_eq!(observed["method"], "Fetch.enable");
            peer.close(None).await.unwrap();
        });
        assert!(matches!(result, Err(ToolError::OutcomeUnknown(_))));
        {
            let inner = controller.shared.inner.lock().unwrap();
            let Installation::Registered { dispatch, .. } = &inner.installation else {
                panic!("unknown setup owner was lost");
            };
            assert!(matches!(*dispatch.lock().unwrap(), DispatchStatus::Started));
        }
        assert!(matches!(
            controller.close().await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(
            !controller.closed,
            "unknown interception setup is not confirmed cleanup"
        );
        assert!(
            matches!(
                controller.install().await,
                Err(ToolError::OutcomeUnknown(_))
            ),
            "the same registered future remains terminal unknown"
        );
    }
}
