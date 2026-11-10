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
    identities: HashMap<
        u64,
        (
            (String, String, crate::ExecutionCorrelation),
            CancellationToken,
        ),
    >,
}
impl PendingInvocations {
    fn insert(
        &mut self,
        id: u64,
        session: String,
        turn: String,
        execution: crate::ExecutionCorrelation,
        cancellation: CancellationToken,
        pending: BoxFuture<'static, Result<Value, ToolError>>,
    ) {
        assert!(
            self.identities
                .insert(id, ((session, turn, execution), cancellation))
                .is_none(),
            "the validated desktop request {id} cannot be parked twice"
        );
        self.replies
            .push(Box::pin(async move { (id, pending.await) }));
    }
    fn is_empty(&self) -> bool {
        self.identities.is_empty()
    }
    fn cancel(&self, scope: Option<(&str, &str, &crate::ExecutionCorrelation)>) {
        for (owner, cancellation) in self.identities.values() {
            if scope.is_none_or(|(session, turn, execution)| {
                owner.0 == session && owner.1 == turn && &owner.2 == execution
            }) {
                cancellation.cancel();
            }
        }
    }
    async fn forward_next(&mut self, events: &mpsc::UnboundedSender<Event>) {
        if let Some((id, result)) = self.replies.next().await {
            self.identities
                .remove(&id)
                .expect("parked completion retains its original request identity");
            let _ = events.send(Event::Response {
                id,
                result: result.map_err(Failure::from),
                audio: None,
            });
        }
    }
    async fn drain(
        &mut self,
        scope: Option<(&str, &str, &crate::ExecutionCorrelation)>,
        events: &mpsc::UnboundedSender<Event>,
    ) -> Result<(), ToolError> {
        while self.identities.values().any(|(owner, _)| {
            scope.is_none_or(|(session, turn, execution)| {
                owner.0 == session && owner.1 == turn && &owner.2 == execution
            })
        }) {
            self.forward_next(events).await;
        }
        Ok(())
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

type EpochTask = futures_util::future::Shared<
    BoxFuture<'static, Result<Arc<Mutex<crate::session::Session>>, String>>,
>;

struct EpochWorker {
    session: String,
    queue: mpsc::UnboundedSender<Operation>,
    task: EpochTask,
    closing: Option<NativeCleanup>,
}

enum Operation {
    Invoke {
        id: u64,
        cancellation: CancellationToken,
        session: String,
        turn: String,
        execution: crate::ExecutionCorrelation,
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
        execution: crate::ExecutionCorrelation,
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
        execution: crate::ExecutionCorrelation,
        language: Language,
        reply: oneshot::Sender<Result<(), ToolError>>,
    },
    DrainTurn {
        session: String,
        turn: String,
        execution: crate::ExecutionCorrelation,
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
                preparation.check_scope(
                    &identity.turn,
                    &identity.execution,
                    &identity.operation_id,
                )?;
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
                        execution,
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
                                execution: execution.clone(),
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
                                                    let mut context = InvocationContext::new(
                                                        &session,
                                                        &turn,
                                                        execution.clone(),
                                                    )
                                                    .with_browser_preparation_policy(
                                                        preparation_policy,
                                                    )
                                                    .with_browser_authorization(authorization);
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
                                session,
                                turn,
                                execution,
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
                        execution,
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
                            execution: execution.clone(),
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
                                let context =
                                    InvocationContext::new(&session, &turn, execution.clone())
                                        .with_browser_preparation_policy(preparation_policy)
                                        .with_operation_id(operation_id)
                                        .with_browser_authorization(authorization)
                                        .with_browser_services(
                                            callbacks.scope(identity.clone(), id),
                                        );
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
                        execution,
                        language,
                        reply,
                    } => {
                        pending.cancel(Some((&session, &turn, &execution)));
                        let pending_cleanup = pending
                            .drain(Some((&session, &turn, &execution)), &events)
                            .await;
                        let native_cleanup = settle(
                            local.finish_turn(&session, &turn, &execution, language),
                            &disconnected,
                        )
                        .await;
                        let _ = reply.send(epoch_cleanup(pending_cleanup, native_cleanup));
                    }
                    Operation::DrainTurn {
                        session,
                        turn,
                        execution,
                        reply,
                    } => {
                        pending.cancel(Some((&session, &turn, &execution)));
                        let _ = reply.send(
                            pending
                                .drain(Some((&session, &turn, &execution)), &events)
                                .await,
                        );
                    }
                    Operation::Close { reply } => {
                        pending.cancel(None);
                        let pending_cleanup = pending.drain(None, &events).await;
                        let native_cleanup = settle(local.close_native(), &disconnected).await;
                        let result = epoch_cleanup(pending_cleanup, native_cleanup);
                        let closed = result.is_ok();
                        let _ = reply.send_replace(Some(result));
                        if closed {
                            break;
                        }
                    }
                }
            }
            pending.cancel(None);
            let _ = pending.drain(None, &events).await;
            local
        });
        let task = async move {
            task.await
                .map(|local| Arc::new(Mutex::new(local)))
                .map_err(|error| error.to_string())
        }
        .boxed()
        .shared();
        tokio::spawn(task.clone());
        Self {
            session,
            queue,
            task,
            closing: None,
        }
    }

    fn close(&mut self) -> NativeCleanup {
        if self
            .closing
            .as_ref()
            .is_some_and(|pending| matches!(*pending.borrow(), Some(Err(_))))
        {
            self.closing = None;
        }
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

    fn drain_turn(
        &self,
        session: &str,
        turn: &str,
        execution: &crate::ExecutionCorrelation,
    ) -> BoxFuture<'static, Result<(), ToolError>> {
        let worker = match self {
            Self::Open(worker) => match &worker.closing {
                Some(closing) => return Box::pin(observe_retirement(closing.clone())),
                None => worker,
            },
            Self::Closed(closing) => return Box::pin(observe_retirement(closing.clone())),
        };
        let (reply, completion) = oneshot::channel();
        let sent = worker.invoke(Operation::DrainTurn {
            session: session.to_owned(),
            turn: turn.to_owned(),
            execution: execution.clone(),
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

    fn task(&self) -> Option<EpochTask> {
        match self {
            Self::Open(worker) => Some(worker.task.clone()),
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
                (confirmed && matches!(worker.task.peek(), Some(Ok(_)))).then(|| result.clone())
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
        if self
            .closing
            .as_ref()
            .is_some_and(|pending| matches!(*pending.borrow(), Some(Err(_))))
        {
            self.closing = None;
        }
        self.closing
            .get_or_insert_with(|| {
                let epochs: Vec<_> = self
                    .epochs
                    .values_mut()
                    .map(|epoch| (epoch.close(), epoch.task()))
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
                    let mut retained = Vec::new();
                    for (observation, task) in epochs {
                        match observe_retirement(observation).await {
                            Err(error) => failures.push(error.to_string()),
                            Ok(()) => {
                                if let Some(task) = task {
                                    match task.await {
                                        Ok(local) => retained.push(local),
                                        Err(error) => failures.push(format!(
                                            "Windows native epoch worker failed: {error}"
                                        )),
                                    }
                                }
                            }
                        }
                    }
                    if !failures.is_empty() {
                        let _ = reply.send_replace(Some(Err(ToolError::CleanupUnconfirmed(
                            failures.join("; "),
                        ))));
                        return;
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
        Request::CloseEpoch { owner, epoch } => {
            callbacks.seal_matching(owner, Some(epoch), None, None, None)
        }
        Request::CloseOwner { owner } => callbacks.seal_matching(owner, None, None, None, None),
        Request::FinishTurn {
            owner,
            epoch,
            session,
            turn,
            execution,
            ..
        } => callbacks.seal_matching(
            owner,
            Some(epoch),
            Some(session),
            Some(turn),
            Some(execution),
        ),
        Request::FinishOwnerTurn {
            owner,
            session,
            turn,
            execution,
            ..
        } => callbacks.seal_matching(owner, None, Some(session), Some(turn), Some(execution)),
        _ => {}
    }
    match request {
        Request::Invoke {
            owner,
            epoch,
            session,
            turn,
            execution,
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
                execution,
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
            execution,
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
                execution,
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
            execution,
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
                execution,
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
            session,
            turn,
            execution,
            language,
        } => {
            let Some(owner) = owners.get_mut(&owner) else {
                respond(events, id, Ok(()));
                return Ok(());
            };
            if owner.closing.is_some() {
                return Err(failed("Computer Use Session owner is closed"));
            }
            if owner.session != session {
                return Err(failed("Computer Use Session identity mismatch"));
            }
            owner.shared.retain(|task| !task.is_finished());
            let drains = owner
                .epochs
                .values()
                .map(|epoch| epoch.drain_turn(&session, &turn, &execution))
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
                let native = settle(
                    resources.finish_turn(&session, &turn, &execution, language),
                    &disconnected,
                )
                .await;
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
