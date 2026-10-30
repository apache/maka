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

//! The child retains logical owners while independent native epochs settle.

use super::callbacks::{ScopeIdentity, WorkerCallbacks, WorkerMessage};
use super::{
    AuthorizationMode, BrowserAuthorizationRequest, Failure, Hello, PROTOCOL, ParentFrame, Request,
    Response, WorkerFrame, failed, local_platform, write,
};
use crate::desktop::{NativeCleanup, NativeEpochId, SessionOwner, observe_retirement};
use crate::{BrowserAccess, BrowserAuthorization, Driver, InvocationContext, protocol::Command};
use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use maka_agent_facts::{language::Language, tools::ToolError};
use maka_capabilities::computer::BrowserConnection;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    io,
    panic::AssertUnwindSafe,
    sync::Arc,
};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

type AudioWait = BoxFuture<'static, Result<(), ToolError>>;
type AudioObservations = FuturesUnordered<BoxFuture<'static, (u64, Result<(), Failure>)>>;

#[derive(Default)]
struct PendingInvocations {
    replies: FuturesUnordered<BoxFuture<'static, (u64, Result<Value, ToolError>)>>,
    identities: HashMap<u64, (String, CancellationToken)>,
    cleanup: Option<ToolError>,
}
impl PendingInvocations {
    fn insert(
        &mut self,
        id: u64,
        turn: String,
        cancellation: CancellationToken,
        pending: BoxFuture<'static, Result<Value, ToolError>>,
    ) {
        assert!(
            self.identities.insert(id, (turn, cancellation)).is_none(),
            "the validated desktop request {id} cannot be parked twice"
        );
        self.replies
            .push(Box::pin(async move { (id, pending.await) }));
    }
    fn is_empty(&self) -> bool {
        self.identities.is_empty()
    }
    fn cancel(&self, turn: Option<&str>) {
        for (owner_turn, cancellation) in self.identities.values() {
            if turn.is_none_or(|turn| turn == owner_turn) {
                cancellation.cancel();
            }
        }
    }
    async fn forward_next(&mut self, events: &mpsc::UnboundedSender<Event>) {
        if let Some((id, result)) = self.replies.next().await {
            self.identities
                .remove(&id)
                .expect("parked completion retains its original request identity");
            if let Err(
                error @ (ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. }
                | ToolError::Persistence(_)),
            ) = &result
            {
                self.cleanup.get_or_insert(error.clone());
            }
            let _ = events.send(Event::Response {
                id,
                result: result.map_err(Failure::from),
                audio: None,
            });
        }
    }
    async fn drain(
        &mut self,
        turn: Option<&str>,
        events: &mpsc::UnboundedSender<Event>,
    ) -> Result<(), ToolError> {
        while self
            .identities
            .values()
            .any(|(owner_turn, _)| turn.is_none_or(|turn| turn == owner_turn))
        {
            self.forward_next(events).await;
        }
        self.cleanup.clone().map_or(Ok(()), Err)
    }
}
fn epoch_cleanup(
    pending: Result<(), ToolError>,
    native: Result<(), ToolError>,
) -> Result<(), ToolError> {
    match (pending, native) {
        (Ok(()), result) | (result, Ok(())) => result,
        (Err(pending), Err(native)) => Err(ToolError::CleanupUnconfirmed(format!(
            "{pending}; {native}"
        ))),
    }
}

async fn settle<T>(
    future: impl Future<Output = Result<T, ToolError>>,
    disconnected: &CancellationToken,
) -> Result<T, ToolError> {
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(result) => result,
        Err(_) => {
            disconnected.cancel();
            Err(ToolError::CleanupUnconfirmed(
                "Windows native epoch worker panicked; native settlement was not confirmed".into(),
            ))
        }
    }
}

struct Owner {
    session: String,
    resources: SessionOwner,
    epochs: HashMap<String, Epoch>,
    closing: Option<NativeCleanup>,
    disconnected: CancellationToken,
    shared: Vec<JoinHandle<()>>,
}

enum Epoch {
    Open(EpochWorker),
    Closed(NativeCleanup),
}

struct EpochWorker {
    session: String,
    queue: mpsc::UnboundedSender<Operation>,
    task: Option<JoinHandle<crate::session::Session>>,
    closing: Option<NativeCleanup>,
}

enum Operation {
    Invoke {
        id: u64,
        cancellation: CancellationToken,
        session: String,
        turn: String,
        operation_id: Option<String>,
        native_observer_available: bool,
        browsers: Vec<BrowserConnection>,
        preparation_policy: crate::BrowserPreparationPolicy,
        command: Box<Command>,
        language: Language,
    },
    LeaseChild {
        id: u64,
        cancellation: CancellationToken,
        session: String,
        turn: String,
        operation_id: String,
        browsers: Vec<BrowserConnection>,
        preparation_policy: crate::BrowserPreparationPolicy,
        request: crate::BrowserLeaseChildRequest,
        language: Language,
    },
    DiscardAudio {
        id: u64,
    },
    FinishTurn {
        session: String,
        turn: String,
        language: Language,
        reply: oneshot::Sender<Result<(), ToolError>>,
    },
    DrainTurn {
        turn: String,
        reply: oneshot::Sender<Result<(), ToolError>>,
    },
    Close {
        reply: watch::Sender<Option<Result<(), ToolError>>>,
    },
}

enum Event {
    BrowserCallback {
        message: WorkerMessage,
    },
    Response {
        id: u64,
        result: Response,
        audio: Option<AudioWait>,
    },
    Authorization {
        id: u64,
        mode: AuthorizationMode,
        request: BrowserAuthorizationRequest,
        reply: oneshot::Sender<Result<(), Failure>>,
    },
}

struct Authorization {
    callbacks: WorkerCallbacks,
    id: u64,
    events: mpsc::UnboundedSender<Event>,
    identity: Option<ScopeIdentity>,
}

impl Authorization {
    fn request(
        &self,
        mode: AuthorizationMode,
        request: BrowserAuthorizationRequest,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        let events = self.events.clone();
        let id = self.id;
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(failed("Browser authorization cancelled"));
            }
            let (reply, response) = oneshot::channel();
            events
                .send(Event::Authorization {
                    id,
                    mode,
                    request,
                    reply,
                })
                .map_err(|_| failed("Browser authorization invocation expired"))?;
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(failed("Browser authorization cancelled")),
                result = response => result
                    .map_err(|_| failed("Browser authorization invocation expired"))?
                    .map_err(Into::into),
            }
        })
    }
}

impl Authorization {
    fn request_preparation(
        &self,
        mode: AuthorizationMode,
        preparation: crate::BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        let identity = self
            .identity
            .clone()
            .ok_or_else(|| {
                failed("Browser session preparation requires its original invocation identity")
            })
            .and_then(|identity| {
                preparation.check_scope(&identity.turn, &identity.operation_id)?;
                Ok(identity)
            });
        match identity {
            Ok(identity) => self.request(
                mode,
                BrowserAuthorizationRequest::SessionPreparation {
                    identity,
                    preparation,
                },
                cancellation,
            ),
            Err(error) => Box::pin(async move { Err(error) }),
        }
    }
}

impl BrowserAuthorization for Authorization {
    fn prepare_upload(
        &self,
        request: crate::BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> crate::BrowserUploadFuture {
        match self.identity.clone() {
            Some(identity) => {
                self.callbacks
                    .prepare_upload(identity, self.id, request, cancellation)
            }
            None => Box::pin(async {
                Err(failed(
                    "Upload snapshot requires its original invocation identity",
                ))
            }),
        }
    }
    fn check_upload(
        &self,
        request: crate::BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        match self.identity.clone() {
            Some(identity) => self
                .callbacks
                .check_upload(identity, self.id, request, cancellation),
            None => Box::pin(async {
                Err(failed(
                    "Upload check requires its original invocation identity",
                ))
            }),
        }
    }
    fn authorize_history(
        &self,
        request: crate::BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        if request.target != crate::BrowserPreparationTarget::SessionHistory {
            return Box::pin(async {
                Err(failed(
                    "Browser history requires its exact session-history purpose",
                ))
            });
        }
        self.request_preparation(AuthorizationMode::Authorize, request, cancellation)
    }

    fn check_history(
        &self,
        request: crate::BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        if request.target != crate::BrowserPreparationTarget::SessionHistory {
            return Box::pin(async {
                Err(failed(
                    "Browser history requires its exact session-history purpose",
                ))
            });
        }
        self.request_preparation(AuthorizationMode::Check, request, cancellation)
    }

    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request(
            AuthorizationMode::Authorize,
            BrowserAuthorizationRequest::Access(access),
            cancellation,
        )
    }

    fn check(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request(
            AuthorizationMode::Check,
            BrowserAuthorizationRequest::Access(access),
            cancellation,
        )
    }
    fn authorize_session_preparation(
        &self,
        preparation: crate::BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request_preparation(AuthorizationMode::Authorize, preparation, cancellation)
    }

    fn check_session_preparation(
        &self,
        preparation: crate::BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request_preparation(AuthorizationMode::Check, preparation, cancellation)
    }
}

impl EpochWorker {
    fn new(
        session: String,
        mut local: crate::session::Session,
        events: mpsc::UnboundedSender<Event>,
        disconnected: CancellationToken,
        owner_id: String,
        epoch_id: String,
        callbacks: WorkerCallbacks,
    ) -> Self {
        let (queue, mut receive) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut pending = PendingInvocations::default();
            loop {
                let operation = tokio::select! {
                    biased;
                    _ = pending.forward_next(&events), if !pending.is_empty() => continue,
                    operation = receive.recv() => match operation {
                        Some(operation) => operation,
                        None => break,
                    },
                };
                match operation {
                    Operation::Invoke {
                        id,
                        cancellation,
                        session,
                        turn,
                        operation_id,
                        native_observer_available,
                        browsers,
                        preparation_policy,
                        command,
                        language,
                    } => {
                        let start_audio =
                            matches!(command.as_ref(), Command::StartAudioRecording { .. });
                        let callback_identity =
                            operation_id.as_ref().map(|operation_id| ScopeIdentity {
                                owner: owner_id.clone(),
                                epoch: epoch_id.clone(),
                                session: session.clone(),
                                turn: turn.clone(),
                                operation_id: operation_id.clone(),
                            });
                        let authorization: Arc<dyn BrowserAuthorization> =
                            Arc::new(Authorization {
                                callbacks: callbacks.clone(),
                                id,
                                events: events.clone(),
                                identity: callback_identity.clone(),
                            });
                        let prepared = settle(
                            async {
                                if cancellation.is_cancelled() {
                                    return Err(failed("Computer Use cancelled before dispatch"));
                                }
                                match local.configure_browsers(browsers, language) {
                                    Ok(()) => {
                                        local
                                            .prepare_invoke(
                                                *command,
                                                &{
                                                    let mut context =
                                                        InvocationContext::new(&session, &turn)
                                                            .with_browser_preparation_policy(
                                                                preparation_policy,
                                                            )
                                                            .with_browser_authorization(
                                                                authorization,
                                                            );
                                                    if let Some(operation_id) = operation_id {
                                                        context =
                                                            context.with_operation_id(operation_id);
                                                    }
                                                    if let Some(identity) = &callback_identity {
                                                        context = context.with_browser_services(
                                                            callbacks.scope(identity.clone(), id),
                                                        );
                                                        if native_observer_available {
                                                            context = context
                                                                .with_native_interruption_observer(
                                                                    callbacks.native_observer(
                                                                        identity.clone(),
                                                                        id,
                                                                    ),
                                                                );
                                                        }
                                                    }
                                                    context
                                                },
                                                &cancellation,
                                                language,
                                            )
                                            .await
                                    }
                                    Err(error) => Err(error),
                                }
                            },
                            &disconnected,
                        )
                        .await;
                        if matches!(&prepared, Ok(completion) if completion.is_pending())
                            && !start_audio
                        {
                            let completion = prepared
                                .expect("the pending branch contains a prepared completion");
                            let callbacks = callbacks.clone();
                            let disconnected = disconnected.clone();
                            pending.insert(
                                id,
                                turn,
                                cancellation,
                                Box::pin(async move {
                                    let result = settle(completion.wait(), &disconnected).await;
                                    match callback_identity {
                                        Some(identity) => {
                                            match callbacks.barrier(&identity, id).await {
                                                Ok(()) => result,
                                                Err(error) => Err(error),
                                            }
                                        }
                                        None => result,
                                    }
                                }),
                            );
                        } else {
                            let result = match prepared {
                                Ok(completion) => settle(completion.wait(), &disconnected).await,
                                Err(error) => Err(error),
                            };
                            let result = match &callback_identity {
                                Some(identity) => match callbacks.barrier(identity, id).await {
                                    Ok(()) => result,
                                    Err(error) => Err(error),
                                },
                                None => result,
                            };
                            let audio = (start_audio && result.is_ok())
                                .then(|| local.wait_audio_finished());
                            let _ = events.send(Event::Response {
                                id,
                                result: result.map_err(Failure::from),
                                audio,
                            });
                        }
                    }
                    Operation::LeaseChild {
                        id,
                        cancellation,
                        session,
                        turn,
                        operation_id,
                        browsers,
                        preparation_policy,
                        request,
                        language,
                    } => {
                        let identity = ScopeIdentity {
                            owner: owner_id.clone(),
                            epoch: epoch_id.clone(),
                            session: session.clone(),
                            turn: turn.clone(),
                            operation_id: operation_id.clone(),
                        };
                        let authorization: Arc<dyn BrowserAuthorization> =
                            Arc::new(Authorization {
                                callbacks: callbacks.clone(),
                                id,
                                events: events.clone(),
                                identity: Some(identity.clone()),
                            });
                        let result = settle(
                            async {
                                if cancellation.is_cancelled() {
                                    return Err(failed("Computer Use cancelled before dispatch"));
                                }
                                local.configure_browsers(browsers, language)?;
                                let context = InvocationContext::new(&session, &turn)
                                    .with_browser_preparation_policy(preparation_policy)
                                    .with_operation_id(operation_id)
                                    .with_browser_authorization(authorization)
                                    .with_browser_services(callbacks.scope(identity.clone(), id));
                                local
                                    .adopt_browser_lease_child(
                                        request,
                                        &context,
                                        &cancellation,
                                        language,
                                    )
                                    .await
                            },
                            &disconnected,
                        )
                        .await;
                        let result = match callbacks.barrier(&identity, id).await {
                            Ok(()) => result,
                            Err(error) => Err(error),
                        };
                        let _ = events.send(Event::Response {
                            id,
                            result: result.map_err(Failure::from),
                            audio: None,
                        });
                    }
                    Operation::DiscardAudio { id } => {
                        let result = settle(local.discard_audio(), &disconnected).await;
                        let _ = events.send(Event::Response {
                            id,
                            result: result.map(|()| Value::Null).map_err(Failure::from),
                            audio: None,
                        });
                    }
                    Operation::FinishTurn {
                        session,
                        turn,
                        language,
                        reply,
                    } => {
                        pending.cancel(Some(&turn));
                        let pending_cleanup = pending.drain(Some(&turn), &events).await;
                        let native_cleanup =
                            settle(local.finish_turn(&session, &turn, language), &disconnected)
                                .await;
                        let _ = reply.send(epoch_cleanup(pending_cleanup, native_cleanup));
                    }
                    Operation::DrainTurn { turn, reply } => {
                        pending.cancel(Some(&turn));
                        let _ = reply.send(pending.drain(Some(&turn), &events).await);
                    }
                    Operation::Close { reply } => {
                        pending.cancel(None);
                        let pending_cleanup = pending.drain(None, &events).await;
                        let native_cleanup = settle(local.close_native(), &disconnected).await;
                        let _ = reply
                            .send_replace(Some(epoch_cleanup(pending_cleanup, native_cleanup)));
                        break;
                    }
                }
            }
            pending.cancel(None);
            let _ = pending.drain(None, &events).await;
            local
        });
        Self {
            session,
            queue,
            task: Some(task),
            closing: None,
        }
    }

    fn close(&mut self) -> NativeCleanup {
        self.closing
            .get_or_insert_with(|| {
                let (reply, observation) = watch::channel(None);
                if let Err(error) = self.queue.send(Operation::Close { reply }) {
                    let Operation::Close { reply } = error.0 else {
                        unreachable!()
                    };
                    let _ = reply.send_replace(Some(Err(ToolError::CleanupUnconfirmed(
                        "Windows native epoch worker ended before cleanup".into(),
                    ))));
                }
                observation
            })
            .clone()
    }

    fn invoke(&self, operation: Operation) -> Result<(), ToolError> {
        if self.closing.is_some() {
            return Err(failed("Computer Use native epoch is closed"));
        }
        self.queue.send(operation).map_err(|_| {
            ToolError::CleanupUnconfirmed("Windows native epoch worker ended unexpectedly".into())
        })
    }
}

impl Epoch {
    fn new(
        session: String,
        local: crate::session::Session,
        events: mpsc::UnboundedSender<Event>,
        disconnected: CancellationToken,
        owner_id: String,
        epoch_id: String,
        callbacks: WorkerCallbacks,
    ) -> Self {
        Self::Open(EpochWorker::new(
            session,
            local,
            events,
            disconnected,
            owner_id,
            epoch_id,
            callbacks,
        ))
    }

    fn session(&self) -> Option<&str> {
        match self {
            Self::Open(worker) => Some(&worker.session),
            Self::Closed(_) => None,
        }
    }

    fn close(&mut self) -> NativeCleanup {
        match self {
            Self::Open(worker) => worker.close(),
            Self::Closed(result) => result.clone(),
        }
    }

    fn drain_turn(&self, turn: &str) -> BoxFuture<'static, Result<(), ToolError>> {
        let worker = match self {
            Self::Open(worker) => match &worker.closing {
                Some(closing) => return Box::pin(observe_retirement(closing.clone())),
                None => worker,
            },
            Self::Closed(closing) => return Box::pin(observe_retirement(closing.clone())),
        };
        let (reply, completion) = oneshot::channel();
        let sent = worker.invoke(Operation::DrainTurn {
            turn: turn.to_owned(),
            reply,
        });
        Box::pin(async move {
            sent?;
            completion.await.map_err(|_| {
                ToolError::CleanupUnconfirmed(
                    "Windows native epoch ended before its original Turn waits drained".into(),
                )
            })?
        })
    }

    fn take_task(&mut self) -> Option<JoinHandle<crate::session::Session>> {
        match self {
            Self::Open(worker) => worker.task.take(),
            Self::Closed(_) => None,
        }
    }

    fn invoke(&self, operation: Operation) -> Result<(), ToolError> {
        match self {
            Self::Open(worker) => worker.invoke(operation),
            Self::Closed(_) => Err(failed("Computer Use native epoch is closed")),
        }
    }

    fn reap(&mut self) {
        let completed = match self {
            Self::Open(worker) => worker.closing.as_ref().and_then(|result| {
                let confirmed = matches!(result.borrow().as_ref(), Some(Ok(())));
                (confirmed && worker.task.as_ref().is_some_and(JoinHandle::is_finished))
                    .then(|| result.clone())
            }),
            Self::Closed(_) => None,
        };
        if let Some(result) = completed {
            *self = Self::Closed(result);
        }
    }
}

impl Owner {
    fn new(session: String, driver: Arc<Mutex<Driver>>, disconnected: CancellationToken) -> Self {
        Self {
            session,
            resources: SessionOwner::new(driver),
            epochs: HashMap::new(),
            closing: None,
            disconnected,
            shared: Vec::new(),
        }
    }

    fn close(&mut self) -> NativeCleanup {
        self.closing
            .get_or_insert_with(|| {
                let observations: Vec<_> = self.epochs.values_mut().map(Epoch::close).collect();
                let tasks: Vec<_> = self
                    .epochs
                    .values_mut()
                    .filter_map(Epoch::take_task)
                    .collect();
                let shared = std::mem::take(&mut self.shared);
                let resources = self.resources.clone();
                let disconnected = self.disconnected.clone();
                let (reply, observation) = watch::channel(None);
                tokio::spawn(async move {
                    let mut failures = Vec::new();
                    for task in shared {
                        if let Err(error) = task.await {
                            failures.push(format!(
                                "Windows shared turn cleanup worker failed: {error}"
                            ));
                        }
                    }
                    for observation in observations {
                        if let Err(error) = observe_retirement(observation).await {
                            failures.push(error.to_string());
                        }
                    }
                    let mut retained = Vec::new();
                    for task in tasks {
                        match task.await {
                            Ok(local) => retained.push(local),
                            Err(error) => failures
                                .push(format!("Windows native epoch worker failed: {error}")),
                        }
                    }
                    if let Err(error) = settle(resources.close(), &disconnected).await {
                        failures.push(error.to_string());
                    }
                    drop(retained);
                    let result = if failures.is_empty() {
                        Ok(())
                    } else {
                        Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
                    };
                    let _ = reply.send_replace(Some(result));
                });
                observation
            })
            .clone()
    }

    fn reap(&mut self) {
        if self
            .closing
            .as_ref()
            .is_some_and(|result| matches!(result.borrow().as_ref(), Some(Ok(()))))
        {
            self.epochs.clear();
        } else {
            for epoch in self.epochs.values_mut() {
                epoch.reap();
            }
        }
    }
}

struct Invocations {
    pending: HashMap<u64, CancellationToken>,
    authorizations: HashMap<u64, (u64, oneshot::Sender<Result<(), Failure>>)>,
    queued: HashMap<u64, VecDeque<Callback>>,
    last_authorization: u64,
}

struct Callback {
    mode: AuthorizationMode,
    request: BrowserAuthorizationRequest,
    reply: oneshot::Sender<Result<(), Failure>>,
}

impl Invocations {
    fn cancel(&self, id: u64, last_request: u64) -> io::Result<()> {
        if id > last_request {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "desktop cancellation identity mismatch",
            ));
        }
        if let Some(cancellation) = self.pending.get(&id) {
            cancellation.cancel();
        }
        Ok(())
    }

    fn cancel_authorizations(&mut self) {
        self.authorizations.clear();
        self.queued.clear();
    }

    fn finish(&mut self, id: u64) {
        self.pending.remove(&id);
        self.queued.remove(&id);
    }

    async fn authorize(
        &mut self,
        id: u64,
        callback: Callback,
        output: &mut (impl AsyncWrite + Unpin),
    ) -> io::Result<()> {
        if !self.pending.contains_key(&id) || callback.reply.is_closed() {
            let _ = callback.reply.send(Err(Failure::Failed(
                "Browser authorization invocation expired".into(),
            )));
            return Ok(());
        }
        if self.authorizations.contains_key(&id) {
            self.queued.entry(id).or_default().push_back(callback);
            return Ok(());
        }
        self.send_authorization(id, callback, output).await
    }

    async fn send_authorization(
        &mut self,
        id: u64,
        callback: Callback,
        output: &mut (impl AsyncWrite + Unpin),
    ) -> io::Result<()> {
        let authorization_id = self
            .last_authorization
            .checked_add(1)
            .ok_or_else(|| io::Error::other("desktop authorization identity exhausted"))?;
        self.last_authorization = authorization_id;
        self.authorizations
            .insert(id, (authorization_id, callback.reply));
        let frame = match callback.request {
            BrowserAuthorizationRequest::Access(access) => WorkerFrame::BrowserAuthorization {
                id,
                authorization_id,
                mode: callback.mode,
                access,
            },
            BrowserAuthorizationRequest::SessionPreparation {
                identity,
                preparation,
            } => WorkerFrame::BrowserSessionPreparationAuthorization {
                id,
                authorization_id,
                mode: callback.mode,
                identity,
                preparation,
            },
        };
        write(output, &frame).await
    }

    async fn authorization_result(
        &mut self,
        id: u64,
        authorization_id: u64,
        result: Result<(), Failure>,
        output: &mut (impl AsyncWrite + Unpin),
    ) -> io::Result<()> {
        match self.authorizations.remove(&id) {
            Some((expected, reply)) if expected == authorization_id => {
                let _ = reply.send(result);
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "desktop authorization identity mismatch",
                ));
            }
        }
        if !self.pending.contains_key(&id) {
            self.queued.remove(&id);
            return Ok(());
        }
        let queued = self.queued.entry(id).or_default();
        while let Some(callback) = queued.pop_front() {
            if !callback.reply.is_closed() {
                return self.send_authorization(id, callback, output).await;
            }
        }
        self.queued.remove(&id);
        Ok(())
    }
}

fn respond(events: &mpsc::UnboundedSender<Event>, id: u64, result: Result<(), ToolError>) {
    let _ = events.send(Event::Response {
        id,
        result: result.map(|()| Value::Null).map_err(Failure::from),
        audio: None,
    });
}

fn observe_close(events: mpsc::UnboundedSender<Event>, id: u64, observation: NativeCleanup) {
    tokio::spawn(async move {
        respond(&events, id, observe_retirement(observation).await);
    });
}

async fn respond_with_audio(
    output: &mut (impl AsyncWrite + Unpin),
    id: u64,
    result: Response,
    audio: Option<AudioWait>,
    observations: &mut AudioObservations,
    disconnected: &CancellationToken,
) -> io::Result<()> {
    write(output, &WorkerFrame::Response { id, result }).await?;
    if let Some(audio) = audio {
        let disconnected = disconnected.clone();
        observations.push(Box::pin(async move {
            let result = settle(audio, &disconnected).await.map_err(Failure::from);
            (id, result)
        }));
    }
    Ok(())
}

fn transport_cleanup(error: io::Error, cleanup: &io::Result<()>) -> io::Error {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => io::Error::new(error.kind(), format!("{error}; native cleanup: {cleanup}")),
    }
}

struct WorkerContext<'worker> {
    driver: &'worker Arc<Mutex<Driver>>,
    events: &'worker mpsc::UnboundedSender<Event>,
    disconnected: &'worker CancellationToken,
    callbacks: &'worker WorkerCallbacks,
}

fn dispatch(
    request: Request,
    id: u64,
    owners: &mut HashMap<String, Owner>,
    cancellation: CancellationToken,
    context: &WorkerContext<'_>,
) -> Result<(), ToolError> {
    let driver = context.driver;
    let events = context.events;
    let disconnected = context.disconnected;
    let callbacks = context.callbacks;
    match &request {
        Request::CloseEpoch { owner, epoch } => callbacks.seal_matching(owner, Some(epoch), None),
        Request::CloseOwner { owner } => callbacks.seal_matching(owner, None, None),
        Request::FinishTurn {
            owner, epoch, turn, ..
        } => callbacks.seal_matching(owner, Some(epoch), Some(turn)),
        Request::FinishOwnerTurn { owner, turn, .. } => {
            callbacks.seal_matching(owner, None, Some(turn))
        }
        _ => {}
    }
    match request {
        Request::Invoke {
            owner,
            epoch,
            session,
            turn,
            operation_id,
            native_observer_available,
            browsers,
            preparation_policy,
            command,
            language,
        } => {
            if owner.is_empty() || epoch.is_empty() || session.is_empty() || turn.is_empty() {
                return Err(failed(
                    "invalid desktop owner, epoch, Session or turn identity",
                ));
            }
            let owner_id = owner.clone();
            let epoch_id = epoch.clone();
            let owner = owners.entry(owner).or_insert_with(|| {
                Owner::new(session.clone(), driver.clone(), disconnected.clone())
            });
            if owner.closing.is_some() {
                return Err(failed("Computer Use Session owner is closed"));
            }
            if owner.session != session {
                return Err(failed("Computer Use Session identity mismatch"));
            }
            let epoch = owner.epochs.entry(epoch).or_insert_with(|| {
                Epoch::new(
                    session.clone(),
                    crate::session::Session::with_owner(
                        driver.clone(),
                        NativeEpochId::new(),
                        owner.resources.clone(),
                    ),
                    events.clone(),
                    disconnected.clone(),
                    owner_id,
                    epoch_id,
                    callbacks.clone(),
                )
            });
            if epoch.session().is_some_and(|bound| bound != session) {
                return Err(failed("Computer Use Session identity mismatch"));
            }
            epoch.invoke(Operation::Invoke {
                id,
                cancellation,
                session,
                turn,
                operation_id,
                native_observer_available,
                browsers,
                preparation_policy,
                command,
                language,
            })
        }
        Request::LeaseChild {
            owner,
            epoch,
            session,
            turn,
            operation_id,
            browsers,
            preparation_policy,
            request,
            language,
        } => {
            if owner.is_empty()
                || epoch.is_empty()
                || session.is_empty()
                || turn.is_empty()
                || operation_id.is_empty()
            {
                return Err(failed(
                    "invalid browser lease-child Host invocation identity",
                ));
            }
            // A retained source lease can only reenter its already existing
            // owner/epoch. This service cannot create a replacement Session.
            let owner = owners
                .get(&owner)
                .ok_or_else(|| failed("Browser lease-child source owner is unavailable"))?;
            if owner.closing.is_some() {
                return Err(failed("Computer Use Session owner is closed"));
            }
            if owner.session != session {
                return Err(failed("Computer Use Session identity mismatch"));
            }
            let epoch = owner
                .epochs
                .get(&epoch)
                .ok_or_else(|| failed("Browser lease-child source epoch is unavailable"))?;
            if epoch.session().is_some_and(|bound| bound != session) {
                return Err(failed("Computer Use Session identity mismatch"));
            }
            epoch.invoke(Operation::LeaseChild {
                id,
                cancellation,
                session,
                turn,
                operation_id,
                browsers,
                preparation_policy,
                request,
                language,
            })
        }
        Request::DiscardAudio { owner, epoch } => {
            match owners
                .get(&owner)
                .and_then(|owner| owner.epochs.get(&epoch))
            {
                Some(epoch) => epoch.invoke(Operation::DiscardAudio { id }),
                None => {
                    respond(events, id, Ok(()));
                    Ok(())
                }
            }
        }
        Request::CloseEpoch { owner, epoch } => {
            match owners
                .get_mut(&owner)
                .and_then(|owner| owner.epochs.get_mut(&epoch))
            {
                Some(epoch) => observe_close(events.clone(), id, epoch.close()),
                None => respond(events, id, Ok(())),
            }
            Ok(())
        }
        Request::CloseOwner { owner } => {
            match owners.get_mut(&owner) {
                Some(owner) => observe_close(events.clone(), id, owner.close()),
                None => respond(events, id, Ok(())),
            }
            Ok(())
        }
        Request::FinishTurn {
            owner,
            epoch,
            session,
            turn,
            language,
        } => {
            let Some(epoch) = owners
                .get(&owner)
                .and_then(|owner| owner.epochs.get(&epoch))
            else {
                respond(events, id, Ok(()));
                return Ok(());
            };
            if epoch.session().is_some_and(|bound| bound != session) {
                return Err(failed("Computer Use Session identity mismatch"));
            }
            let (reply, observation) = oneshot::channel();
            epoch.invoke(Operation::FinishTurn {
                session,
                turn,
                language,
                reply,
            })?;
            let events = events.clone();
            tokio::spawn(async move {
                let result = observation
                    .await
                    .map_err(|error| {
                        ToolError::CleanupUnconfirmed(format!(
                            "Windows turn cleanup observation was lost: {error}"
                        ))
                    })
                    .and_then(|result| result);
                respond(&events, id, result);
            });
            Ok(())
        }
        Request::FinishOwnerTurn {
            owner,
            turn,
            language,
        } => {
            let Some(owner) = owners.get_mut(&owner) else {
                respond(events, id, Ok(()));
                return Ok(());
            };
            if owner.closing.is_some() {
                return Err(failed("Computer Use Session owner is closed"));
            }
            owner.shared.retain(|task| !task.is_finished());
            let drains = owner
                .epochs
                .values()
                .map(|epoch| epoch.drain_turn(&turn))
                .collect::<Vec<_>>();
            let resources = owner.resources.clone();
            let disconnected = disconnected.clone();
            let events = events.clone();
            owner.shared.push(tokio::spawn(async move {
                let mut failures = Vec::new();
                for drain in drains {
                    if let Err(error) = drain.await {
                        failures.push(error.to_string());
                    }
                }
                let native = settle(resources.finish_turn(&turn, language), &disconnected).await;
                let pending = if failures.is_empty() {
                    Ok(())
                } else {
                    Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
                };
                respond(&events, id, epoch_cleanup(pending, native));
            }));
            Ok(())
        }
        #[cfg(target_os = "windows")]
        Request::NativeInvoke { .. }
        | Request::NativeDiscardAudio { .. }
        | Request::NativeRetire { .. } => Err(failed(
            "native-only request requires its actual dedicated process",
        )),
        Request::Shutdown => unreachable!("shutdown seals the whole connection"),
    }
}

pub(super) async fn serve(
    mut receive: mpsc::Receiver<ParentFrame>,
    mut output: impl AsyncWrite + Unpin,
    disconnected: CancellationToken,
    driver: Arc<Mutex<Driver>>,
) -> io::Result<()> {
    let audio_enabled = driver.lock().await.audio_enabled;
    write(
        &mut output,
        &Hello {
            protocol: PROTOCOL,
            platform: local_platform().into(),
            audio_enabled,
        },
    )
    .await?;
    let (events, mut received) = mpsc::unbounded_channel();
    let callback_events = events.clone();
    let callbacks = WorkerCallbacks::new(Arc::new(move |message| {
        callback_events
            .send(Event::BrowserCallback { message })
            .map_err(|_| ToolError::OutcomeUnknown("desktop callback event channel closed".into()))
    }));
    let context = WorkerContext {
        driver: &driver,
        events: &events,
        disconnected: &disconnected,
        callbacks: &callbacks,
    };
    let mut owners = HashMap::<String, Owner>::new();
    let mut invocations = Invocations {
        pending: Default::default(),
        authorizations: HashMap::new(),
        queued: HashMap::new(),
        last_authorization: 0,
    };
    let mut last_request = 0;
    let mut shutdown = None;
    let mut transport_error = None;
    let mut sealing = false;
    let mut receive_open = true;
    let mut cleanup: Option<NativeCleanup> = None;
    let mut audio_observations = AudioObservations::new();
    loop {
        for owner in owners.values_mut() {
            owner.reap();
        }
        if sealing && cleanup.is_none() {
            let observations: Vec<_> = owners.values_mut().map(Owner::close).collect();
            let (reply, observation) = watch::channel(None);
            tokio::spawn(async move {
                let mut failures = Vec::new();
                for observation in observations {
                    if let Err(error) = observe_retirement(observation).await {
                        failures.push(error.to_string());
                    }
                }
                let _ = reply.send_replace(Some(if failures.is_empty() {
                    Ok(())
                } else {
                    Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
                }));
            });
            cleanup = Some(observation);
        }
        if sealing
            && invocations.pending.is_empty()
            && invocations.authorizations.is_empty()
            && audio_observations.is_empty()
            && (!callbacks.has_unsettled() || disconnected.is_cancelled())
            && cleanup
                .as_ref()
                .is_some_and(|cleanup| cleanup.borrow().is_some())
        {
            break;
        }
        tokio::select! {
            biased;
            _ = disconnected.cancelled(), if !sealing => {
                sealing = true;
                callbacks.disconnect("desktop parent disconnected");
                invocations.cancel_authorizations();
            }
            frame = receive.recv(), if receive_open && transport_error.is_none() => {
                match frame {
                    Some(ParentFrame::BrowserCallback { message }) => {
                        if let Err(error)=callbacks.handle(*message){transport_error=Some(io::Error::other(error.to_string()));disconnected.cancel();sealing=true;callbacks.disconnect("desktop callback protocol failed");}
                    }
                    Some(ParentFrame::Request { id, request }) => {
                        if id <= last_request {
                            transport_error = Some(io::Error::new(io::ErrorKind::InvalidData, "desktop request identity mismatch"));
                            disconnected.cancel();
                            sealing = true;
                            invocations.cancel_authorizations();
                            continue;
                        }
                        last_request = id;
                        if matches!(*request, Request::Shutdown) {
                            if shutdown.is_some() || sealing {
                                transport_error = Some(io::Error::new(io::ErrorKind::InvalidData, "desktop shutdown identity mismatch"));
                                disconnected.cancel();
                            } else {
                                shutdown = Some(id);
                            }
                            sealing = true;
                            continue;
                        }
                        let cancellation = disconnected.child_token();
                        invocations.pending.insert(id, cancellation.clone());
                        let result = if sealing {
                            Err(failed("Windows desktop worker is closed"))
                        } else {
                            dispatch(*request, id, &mut owners, cancellation, &context)
                        };
                        if let Err(error) = result { respond(&events, id, Err(error)); }
                    }
                    Some(ParentFrame::BrowserAuthorizationResult { id, authorization_id, result }) => {
                        if let Err(error) = invocations.authorization_result(id, authorization_id, result, &mut output).await {
                                transport_error = Some(error);
                                disconnected.cancel();
                                sealing = true;
                                invocations.cancel_authorizations();
                        }
                    }
                    Some(ParentFrame::Cancel { id }) => {
                        if let Err(error) = invocations.cancel(id, last_request) {
                            transport_error = Some(error);
                            disconnected.cancel();
                            sealing = true;
                            invocations.cancel_authorizations();
                        }
                    }
                    None => {
                        callbacks.disconnect("desktop parent input reached EOF");
                        receive_open = false;
                        disconnected.cancel();
                        sealing = true;
                        invocations.cancel_authorizations();
                    }
                }
            }
            event = received.recv() => {
                match event.expect("the connection retains its event sender") {
                    Event::BrowserCallback { message } => {
                        if transport_error.is_none() && !disconnected.is_cancelled()
                            && let Err(error) = write(&mut output, &WorkerFrame::BrowserCallback { message }).await
                        {
                            transport_error = Some(error);
                            disconnected.cancel();
                            sealing = true;
                            callbacks.disconnect("desktop callback write failed");
                        }
                    }
                    Event::Response { id, result, audio } => {
                        invocations.finish(id);
                        if transport_error.is_none() && !disconnected.is_cancelled()
                            && let Err(error) = respond_with_audio(&mut output, id, result, audio, &mut audio_observations, &disconnected).await {
                            transport_error = Some(error);
                            disconnected.cancel();
                            sealing = true;
                            invocations.cancel_authorizations();
                        }
                    }
                    Event::Authorization { id, mode, request, reply } => {
                        if disconnected.is_cancelled() {
                            let _ = reply.send(Err(Failure::Failed("Browser authorization invocation expired".into())));
                            continue;
                        }
                        if let Err(error) = invocations.authorize(id, Callback {mode, request, reply}, &mut output).await {
                            transport_error = Some(error);
                            disconnected.cancel();
                            sealing = true;
                            invocations.cancel_authorizations();
                        }
                    }
                }
            }
            Some((id, result)) = audio_observations.next(), if !audio_observations.is_empty() => {
                if transport_error.is_none() && !disconnected.is_cancelled()
                    && let Err(error) = write(&mut output, &WorkerFrame::AudioFinished { id, result }).await
                {
                    transport_error = Some(error);
                    disconnected.cancel();
                    sealing = true;
                    invocations.cancel_authorizations();
                }
            }
            _ = async {
                if let Some(cleanup) = cleanup.as_mut() {
                    let pending = cleanup.borrow().is_none();
                    if pending { let _ = cleanup.changed().await; }
                    else { std::future::pending::<()>().await; }
                } else { std::future::pending::<()>().await; }
            } => {}
        }
    }
    let mut failures = Vec::new();
    if callbacks.has_unsettled() {
        callbacks.disconnect("desktop worker cleanup ended with callback custody");
        failures.push("browser callback custody remains physically unconfirmed".into());
    }
    if let Some(cleanup) = cleanup
        && let Err(error) = observe_retirement(cleanup).await
    {
        failures.push(error.to_string());
    }
    if let Err(error) = driver.lock().await.close().await {
        failures.push(error.to_string());
    }
    let result = if failures.is_empty() {
        Ok(Value::Null)
    } else {
        Err(Failure::CleanupUnconfirmed(failures.join("; ")))
    };
    let status = result
        .as_ref()
        .map(|_| ())
        .map_err(|error| io::Error::other(format!("{error:?}")));
    if let Some(id) = shutdown
        && transport_error.is_none()
        && !disconnected.is_cancelled()
        && let Err(error) = write(&mut output, &WorkerFrame::Response { id, result }).await
    {
        return Err(transport_cleanup(error, &status));
    }
    let output_error = output.shutdown().await.err();
    match transport_error.or(output_error) {
        Some(error) => Err(transport_cleanup(error, &status)),
        None => status,
    }
}

#[cfg(test)]
mod tests {
    use super::super::read;
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncRead;

    fn invoke(owner: &str, epoch: &str, command: Value) -> Request {
        Request::Invoke {
            owner: owner.into(),
            epoch: epoch.into(),
            session: "logical-session".into(),
            turn: "logical-turn".into(),
            native_observer_available: false,
            operation_id: None,
            browsers: Vec::new(),
            preparation_policy: Default::default(),
            command: serde_json::from_value(command).unwrap(),
            language: Language::En,
        }
    }

    async fn send(sender: &mpsc::Sender<ParentFrame>, id: u64, request: Request) {
        sender
            .send(ParentFrame::Request {
                id,
                request: Box::new(request),
            })
            .await
            .unwrap();
    }

    async fn response(reader: &mut (impl AsyncRead + Unpin)) -> (u64, Response) {
        match read::<_, WorkerFrame>(reader).await.unwrap() {
            WorkerFrame::Response { id, result } => (id, result),
            _ => panic!("a hermetic fixture cannot request browser or native audio access"),
        }
    }

    #[tokio::test]
    async fn replacement_epoch_read_completes_before_original_delayed_close_ack() {
        let (requests, receive) = mpsc::channel(1);
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let driver = Arc::new(Mutex::new(Driver::default()));
        let task = tokio::spawn(serve(
            receive,
            writer,
            CancellationToken::new(),
            driver.clone(),
        ));
        let _: Hello = read(&mut output).await.unwrap();
        send(
            &requests,
            1,
            invoke("owner", "old", json!({"method":"documentation"})),
        )
        .await;
        let (id, result) = response(&mut output).await;
        assert_eq!(id, 1);
        assert!(result.unwrap().as_str().unwrap().contains("getAXState"));

        // Existing epoch retirement takes this Driver guard. Documentation
        // needs no native runtime and can prove the independent path proceeds.
        let blocked_close = driver.lock().await;
        send(
            &requests,
            2,
            Request::CloseEpoch {
                owner: "owner".into(),
                epoch: "old".into(),
            },
        )
        .await;
        send(
            &requests,
            3,
            invoke("owner", "new", json!({"method":"documentation"})),
        )
        .await;
        let (id, result) = response(&mut output).await;
        assert_eq!(id, 3, "the new reply must precede the original close ACK");
        assert!(result.unwrap().as_str().unwrap().contains("getAXState"));
        drop(blocked_close);
        let (id, result) = response(&mut output).await;
        assert_eq!(id, 2);
        assert_eq!(result.unwrap(), Value::Null);

        send(
            &requests,
            4,
            Request::CloseEpoch {
                owner: "owner".into(),
                epoch: "old".into(),
            },
        )
        .await;
        assert_eq!(response(&mut output).await.1.unwrap(), Value::Null);
        send(
            &requests,
            5,
            invoke("owner", "old", json!({"method":"documentation"})),
        )
        .await;
        assert!(
            matches!(response(&mut output).await.1, Err(Failure::Failed(message))
            if message == "Computer Use native epoch is closed")
        );
        send(
            &requests,
            6,
            Request::CloseOwner {
                owner: "owner".into(),
            },
        )
        .await;
        assert_eq!(response(&mut output).await.1.unwrap(), Value::Null);
        send(
            &requests,
            7,
            invoke("owner", "third", json!({"method":"documentation"})),
        )
        .await;
        assert!(
            matches!(response(&mut output).await.1, Err(Failure::Failed(message))
            if message == "Computer Use Session owner is closed")
        );
        send(&requests, 8, Request::Shutdown).await;
        assert_eq!(response(&mut output).await.0, 8);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn logical_cursor_survives_epoch_replacement_and_stays_with_its_owner() {
        let (requests, receive) = mpsc::channel(1);
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(serve(
            receive,
            writer,
            CancellationToken::new(),
            Arc::new(Mutex::new(Driver::default())),
        ));
        let _: Hello = read(&mut output).await.unwrap();
        send(
            &requests,
            1,
            invoke(
                "a",
                "old",
                json!({"method":"configureCursor","options":{"label":"Retained","enabled":false}}),
            ),
        )
        .await;
        assert_eq!(
            response(&mut output).await.1.unwrap()["settings"]["label"],
            "Retained"
        );
        send(
            &requests,
            2,
            Request::CloseEpoch {
                owner: "a".into(),
                epoch: "old".into(),
            },
        )
        .await;
        assert!(response(&mut output).await.1.is_ok());
        send(
            &requests,
            3,
            invoke(
                "a",
                "replacement",
                json!({"method":"cursorState","options":{}}),
            ),
        )
        .await;
        assert_eq!(
            response(&mut output).await.1.unwrap()["settings"]["label"],
            "Retained"
        );
        send(
            &requests,
            4,
            invoke("b", "first", json!({"method":"cursorState","options":{}})),
        )
        .await;
        assert_eq!(
            response(&mut output).await.1.unwrap()["settings"]["label"],
            "Maka"
        );
        send(
            &requests,
            5,
            Request::FinishTurn {
                owner: "a".into(),
                epoch: "replacement".into(),
                session: "logical-session".into(),
                turn: "logical-turn".into(),
                language: Language::En,
            },
        )
        .await;
        assert!(response(&mut output).await.1.is_ok());
        send(
            &requests,
            6,
            Request::FinishOwnerTurn {
                owner: "a".into(),
                turn: "logical-turn".into(),
                language: Language::En,
            },
        )
        .await;
        assert!(response(&mut output).await.1.is_ok());
        send(
            &requests,
            7,
            invoke(
                "a",
                "replacement",
                json!({"method":"cursorState","options":{}}),
            ),
        )
        .await;
        assert_eq!(
            response(&mut output).await.1.unwrap()["settings"]["label"],
            "Retained"
        );
        send(&requests, 8, Request::Shutdown).await;
        assert!(response(&mut output).await.1.is_ok());
        task.await.unwrap().unwrap();
    }

    fn callback(url: &str) -> (Callback, oneshot::Receiver<Result<(), Failure>>) {
        let (reply, result) = oneshot::channel();
        (
            Callback {
                mode: AuthorizationMode::Authorize,
                request: BrowserAuthorizationRequest::Access(BrowserAccess::Read {
                    document: crate::BrowserDocument {
                        browser_id: "browser".into(),
                        generation: "generation".into(),
                        tab_id: "tab".into(),
                        url: url.into(),
                    },
                }),
                reply,
            },
            result,
        )
    }

    #[tokio::test]
    async fn original_authorization_result_is_accepted_after_its_native_response() {
        let mut calls = Invocations {
            pending: [41, 42]
                .into_iter()
                .map(|id| (id, CancellationToken::new()))
                .collect(),
            authorizations: HashMap::new(),
            queued: HashMap::new(),
            last_authorization: 0,
        };
        let (mut output, mut input) = tokio::io::duplex(64 * 1024);
        let (first, observed_first) = callback("https://first.invalid/");
        calls.authorize(41, first, &mut input).await.unwrap();
        let WorkerFrame::BrowserAuthorization {
            id: 41,
            authorization_id: first_id,
            ..
        } = read(&mut output).await.unwrap()
        else {
            panic!("first callback lost its identity")
        };
        let (queued, queued_result) = callback("https://expired.invalid/");
        calls.authorize(41, queued, &mut input).await.unwrap();
        calls.finish(41);
        assert!(
            queued_result.await.is_err(),
            "native terminal response expires queued authority"
        );
        calls
            .authorization_result(
                41,
                first_id,
                Err(Failure::Failed("original native operation ended".into())),
                &mut input,
            )
            .await
            .unwrap();
        assert!(
            matches!(observed_first.await.unwrap(), Err(Failure::Failed(message)) if message == "original native operation ended")
        );
        let (next, observed_next) = callback("https://next.invalid/");
        calls.authorize(42, next, &mut input).await.unwrap();
        let WorkerFrame::BrowserAuthorization {
            id: 42,
            authorization_id: next_id,
            ..
        } = read(&mut output).await.unwrap()
        else {
            panic!("expired queued authority reached the next request")
        };
        assert!(next_id > first_id);
        calls
            .authorization_result(42, next_id, Ok(()), &mut input)
            .await
            .unwrap();
        observed_next.await.unwrap().unwrap();
        assert_eq!(
            calls
                .authorization_result(41, first_id, Ok(()), &mut input)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn exact_cancel_refuses_queued_input_and_keeps_other_epoch_admissions_live() {
        let (requests, receive) = mpsc::channel(1);
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let driver = Arc::new(Mutex::new(Driver::default()));
        let task = tokio::spawn(serve(
            receive,
            writer,
            CancellationToken::new(),
            driver.clone(),
        ));
        let _: Hello = read(&mut output).await.unwrap();
        let blocked_native = driver.lock().await;
        send(
            &requests,
            1,
            invoke(
                "owner",
                "first",
                json!({"method":"configureCursor","options":{"enabled":false}}),
            ),
        )
        .await;
        send(
            &requests,
            2,
            invoke("owner", "first", json!({"method":"documentation"})),
        )
        .await;
        requests.send(ParentFrame::Cancel { id: 2 }).await.unwrap();
        send(
            &requests,
            3,
            invoke("owner", "second", json!({"method":"documentation"})),
        )
        .await;
        let (id, result) = response(&mut output).await;
        assert_eq!(
            id, 3,
            "another epoch must progress while original native admission remains owned"
        );
        assert!(result.is_ok());
        drop(blocked_native);
        let (id, result) = response(&mut output).await;
        assert_eq!(
            id, 1,
            "canceling queued work cannot replace the original native result"
        );
        assert!(result.is_ok());
        let (id, result) = response(&mut output).await;
        assert_eq!(id, 2);
        assert!(
            matches!(result, Err(Failure::Failed(message)) if message == "Computer Use cancelled before dispatch")
        );
        requests.send(ParentFrame::Cancel { id: 2 }).await.unwrap();
        send(
            &requests,
            4,
            invoke("owner", "second", json!({"method":"documentation"})),
        )
        .await;
        let (id, result) = response(&mut output).await;
        assert_eq!(id, 4);
        assert!(
            result.is_ok(),
            "late cancellation cannot revoke a newer native invocation"
        );
        send(&requests, 5, Request::Shutdown).await;
        assert!(response(&mut output).await.1.is_ok());
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn start_ack_flushes_before_polling_its_bound_audio_observation() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let polled = Arc::new(AtomicBool::new(false));
        let observed = polled.clone();
        let audio: AudioWait = Box::pin(async move {
            observed.store(true, Ordering::SeqCst);
            Err(failed("capture A finalized with its original error"))
        });
        let (mut reader, mut writer) = tokio::io::duplex(1);
        let cancellation = CancellationToken::new();
        let mut observations = AudioObservations::new();
        let (sent, frame) = tokio::join!(
            respond_with_audio(
                &mut writer,
                41,
                Ok(json!({"started":true})),
                Some(audio),
                &mut observations,
                &cancellation
            ),
            read::<_, WorkerFrame>(&mut reader),
        );
        sent.unwrap();
        let WorkerFrame::Response { id, result } = frame.unwrap() else {
            panic!("audio completion preceded its Start ACK")
        };
        assert_eq!(id, 41);
        assert_eq!(result.unwrap(), json!({"started":true}));
        assert!(!polled.load(Ordering::SeqCst));
        let (id, result) = observations.next().await.unwrap();
        assert_eq!(id, 41);
        assert!(polled.load(Ordering::SeqCst));
        assert!(
            matches!(result, Err(Failure::Failed(message)) if message == "capture A finalized with its original error")
        );

        let polled = Arc::new(AtomicBool::new(false));
        let observed = polled.clone();
        let audio: AudioWait = Box::pin(async move {
            observed.store(true, Ordering::SeqCst);
            Ok(())
        });
        let (reader, mut writer) = tokio::io::duplex(1);
        drop(reader);
        let error = respond_with_audio(
            &mut writer,
            42,
            Ok(Value::Null),
            Some(audio),
            &mut observations,
            &cancellation,
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        assert!(!polled.load(Ordering::SeqCst));
        assert!(
            observations.is_empty(),
            "failed Start ACK cannot publish a successful completion event"
        );
    }

    #[tokio::test]
    async fn finishing_a_turn_drains_its_original_wait_without_cancelling_the_later_turn() {
        let (events, mut responses) = mpsc::unbounded_channel();
        let old = CancellationToken::new();
        let fresh = CancellationToken::new();
        let mut pending = PendingInvocations::default();
        let first = old.clone();
        pending.insert(
            11,
            "old-turn".into(),
            old.clone(),
            Box::pin(async move {
                first.cancelled().await;
                Err(failed("old wait cancelled"))
            }),
        );
        let second = fresh.clone();
        pending.insert(
            12,
            "fresh-turn".into(),
            fresh.clone(),
            Box::pin(async move {
                second.cancelled().await;
                Err(failed("fresh wait cancelled"))
            }),
        );
        pending.cancel(Some("old-turn"));
        pending.drain(Some("old-turn"), &events).await.unwrap();
        assert!(old.is_cancelled());
        assert!(
            !fresh.is_cancelled(),
            "an older Turn cleanup cannot cancel the later original request"
        );
        assert!(pending.identities.contains_key(&12));
        assert!(
            matches!(responses.recv().await.unwrap(), Event::Response { id: 11, result: Err(Failure::Failed(message)), audio: None } if message == "old wait cancelled")
        );
        pending.cancel(None);
        pending.drain(None, &events).await.unwrap();
        assert!(
            matches!(responses.recv().await.unwrap(), Event::Response { id: 12, result: Err(Failure::Failed(message)), audio: None } if message == "fresh wait cancelled")
        );
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn a_forwarded_deferred_cleanup_failure_remains_in_epoch_close_custody() {
        let (events, mut responses) = mpsc::unbounded_channel();
        let mut pending = PendingInvocations::default();
        pending.insert(
            13,
            "turn".into(),
            CancellationToken::new(),
            Box::pin(async {
                Err(ToolError::CleanupUnconfirmed(
                    "original Fetch disable reply was lost".into(),
                ))
            }),
        );
        pending.forward_next(&events).await;
        assert!(
            matches!(responses.recv().await.unwrap(), Event::Response { id: 13, result: Err(Failure::CleanupUnconfirmed(message)), .. } if message == "original Fetch disable reply was lost")
        );
        assert!(pending.is_empty());
        let result = epoch_cleanup(pending.drain(None, &events).await, Ok(()));
        assert!(
            matches!(result, Err(ToolError::CleanupUnconfirmed(message)) if message == "original Fetch disable reply was lost")
        );
    }

    fn preparation_identity() -> ScopeIdentity {
        ScopeIdentity {
            owner: "transport-owner".into(),
            epoch: "transport-epoch".into(),
            session: "fixture-session".into(),
            turn: "fixture-turn".into(),
            operation_id: "fixture-operation".into(),
        }
    }
    fn preparation_dto() -> crate::BrowserSessionPreparation {
        crate::BrowserSessionPreparation {
            native_owner: uuid::Uuid::from_u128(17),
            native_epoch: "different-native-epoch".into(),
            browser_id: "fixture-browser".into(),
            generation: "fixture-generation".into(),
            turn_id: "fixture-turn".into(),
            operation_id: "fixture-operation".into(),
            target: crate::BrowserPreparationTarget::ReservedTab {
                tab_id: "fixture-tab".into(),
            },
        }
    }

    #[tokio::test]
    async fn typed_child_history_preserves_scoped_wire_and_the_original_host_refusal() {
        let (events, mut incoming) = mpsc::unbounded_channel();
        let authority = Authorization {
            callbacks: WorkerCallbacks::new(Arc::new(|_| {
                Err(failed("unexpected upload callback in preparation fixture"))
            })),
            id: 41,
            events,
            identity: Some(preparation_identity()),
        };
        let mut request = preparation_dto();
        request.target = crate::BrowserPreparationTarget::SessionHistory;
        for check in [false, true] {
            let future = if check {
                authority.check_history(request.clone(), CancellationToken::new())
            } else {
                authority.authorize_history(request.clone(), CancellationToken::new())
            };
            let pending = tokio::spawn(future);
            let Event::Authorization {
                id,
                mode,
                request:
                    BrowserAuthorizationRequest::SessionPreparation {
                        identity,
                        preparation,
                    },
                reply,
            } = incoming.recv().await.unwrap()
            else {
                panic!("history lost its scoped typed authorization wire");
            };
            assert_eq!(id, 41);
            assert_eq!(identity, preparation_identity());
            assert_eq!(preparation, request);
            assert_eq!(matches!(mode, AuthorizationMode::Check), check);
            reply
                .send(Err(Failure::Failed(
                    "fixture independent history refusal".into(),
                )))
                .unwrap();
            assert!(
                matches!(pending.await.unwrap(), Err(ToolError::Failed(reason)) if reason == "fixture independent history refusal")
            );
        }
        assert!(
            authority
                .check_history(preparation_dto(), CancellationToken::new())
                .await
                .is_err()
        );
        assert!(
            incoming.try_recv().is_err(),
            "wrong history purpose never emits a callback"
        );
    }
}
