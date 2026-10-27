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

use super::{
    AuthorizationMode, Failure, Hello, PROTOCOL, ParentFrame, Request, Response, WorkerFrame,
    failed, local_platform, write,
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
        browsers: Vec<BrowserConnection>,
        command: Command,
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
    Close {
        reply: watch::Sender<Option<Result<(), ToolError>>>,
    },
}

enum Event {
    Response {
        id: u64,
        result: Response,
        audio: Option<AudioWait>,
    },
    Authorization {
        id: u64,
        mode: AuthorizationMode,
        access: BrowserAccess,
        reply: oneshot::Sender<Result<(), Failure>>,
    },
}

struct Authorization {
    id: u64,
    events: mpsc::UnboundedSender<Event>,
}

impl Authorization {
    fn request(
        &self,
        mode: AuthorizationMode,
        access: BrowserAccess,
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
                    access,
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

impl BrowserAuthorization for Authorization {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request(AuthorizationMode::Authorize, access, cancellation)
    }

    fn check(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request(AuthorizationMode::Check, access, cancellation)
    }
}

impl EpochWorker {
    fn new(
        session: String,
        owner: &SessionOwner,
        driver: Arc<Mutex<Driver>>,
        events: mpsc::UnboundedSender<Event>,
        disconnected: CancellationToken,
    ) -> Self {
        let (queue, mut receive) = mpsc::unbounded_channel();
        let mut local =
            crate::session::Session::with_owner(driver, NativeEpochId::new(), owner.clone());
        let task = tokio::spawn(async move {
            while let Some(operation) = receive.recv().await {
                match operation {
                    Operation::Invoke {
                        id,
                        cancellation,
                        session,
                        turn,
                        browsers,
                        command,
                        language,
                    } => {
                        let start_audio = matches!(&command, Command::StartAudioRecording { .. });
                        let authorization: Arc<dyn BrowserAuthorization> =
                            Arc::new(Authorization {
                                id,
                                events: events.clone(),
                            });
                        let result = settle(
                            async {
                                if cancellation.is_cancelled() {
                                    return Err(failed("Computer Use cancelled before dispatch"));
                                }
                                match local.configure_browsers(browsers, language) {
                                    Ok(()) => {
                                        local
                                            .invoke(
                                                command,
                                                &InvocationContext::new(&session, &turn)
                                                    .with_browser_authorization(authorization),
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
                        let audio =
                            (start_audio && result.is_ok()).then(|| local.wait_audio_finished());
                        let _ = events.send(Event::Response {
                            id,
                            result: result.map_err(Failure::from),
                            audio,
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
                        let result =
                            settle(local.finish_turn(&session, &turn, language), &disconnected)
                                .await;
                        let _ = reply.send(result);
                    }
                    Operation::Close { reply } => {
                        let result = settle(local.close_native(), &disconnected).await;
                        let _ = reply.send_replace(Some(result));
                        break;
                    }
                }
            }
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
        owner: &SessionOwner,
        driver: Arc<Mutex<Driver>>,
        events: mpsc::UnboundedSender<Event>,
        disconnected: CancellationToken,
    ) -> Self {
        Self::Open(EpochWorker::new(
            session,
            owner,
            driver,
            events,
            disconnected,
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
    access: BrowserAccess,
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
        write(
            output,
            &WorkerFrame::BrowserAuthorization {
                id,
                authorization_id,
                mode: callback.mode,
                access: callback.access,
            },
        )
        .await
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

fn dispatch(
    request: Request,
    id: u64,
    owners: &mut HashMap<String, Owner>,
    driver: &Arc<Mutex<Driver>>,
    events: &mpsc::UnboundedSender<Event>,
    disconnected: &CancellationToken,
    cancellation: CancellationToken,
) -> Result<(), ToolError> {
    match request {
        Request::Invoke {
            owner,
            epoch,
            session,
            turn,
            browsers,
            command,
            language,
        } => {
            if owner.is_empty() || epoch.is_empty() || session.is_empty() || turn.is_empty() {
                return Err(failed(
                    "invalid desktop owner, epoch, Session or turn identity",
                ));
            }
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
                    &owner.resources,
                    driver.clone(),
                    events.clone(),
                    disconnected.clone(),
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
                browsers,
                command,
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
            let resources = owner.resources.clone();
            let disconnected = disconnected.clone();
            let events = events.clone();
            owner.shared.push(tokio::spawn(async move {
                let result = settle(resources.finish_turn(&turn, language), &disconnected).await;
                respond(&events, id, result);
            }));
            Ok(())
        }
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
                invocations.cancel_authorizations();
            }
            frame = receive.recv(), if receive_open && transport_error.is_none() => {
                match frame {
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
                            dispatch(*request, id, &mut owners, &driver, &events, &disconnected, cancellation)
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
                        receive_open = false;
                        disconnected.cancel();
                        sealing = true;
                        invocations.cancel_authorizations();
                    }
                }
            }
            event = received.recv() => {
                match event.expect("the connection retains its event sender") {
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
                    Event::Authorization { id, mode, access, reply } => {
                        if disconnected.is_cancelled() {
                            let _ = reply.send(Err(Failure::Failed("Browser authorization invocation expired".into())));
                            continue;
                        }
                        if let Err(error) = invocations.authorize(id, Callback {mode, access, reply}, &mut output).await {
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
    use tokio::io::{AsyncRead, AsyncReadExt};

    fn invoke(owner: &str, epoch: &str, command: Value) -> Request {
        Request::Invoke {
            owner: owner.into(),
            epoch: epoch.into(),
            session: "logical-session".into(),
            turn: "logical-turn".into(),
            browsers: Vec::new(),
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

    #[tokio::test]
    async fn eof_still_joins_the_original_epoch_close_without_forging_an_ack() {
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
        assert!(response(&mut output).await.1.is_ok());
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
        drop(requests);
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "EOF cannot replace native cleanup completion"
        );
        drop(blocked_close);
        task.await.unwrap().unwrap();
        assert_eq!(
            output.read(&mut [0]).await.unwrap(),
            0,
            "no terminal response exists after EOF"
        );
    }

    fn callback(url: &str) -> (Callback, oneshot::Receiver<Result<(), Failure>>) {
        let (reply, result) = oneshot::channel();
        (
            Callback {
                mode: AuthorizationMode::Authorize,
                access: BrowserAccess::Read {
                    document: crate::BrowserDocument {
                        browser_id: "browser".into(),
                        generation: "generation".into(),
                        tab_id: "tab".into(),
                        url: url.into(),
                    },
                },
                reply,
            },
            result,
        )
    }

    #[tokio::test]
    async fn cancelled_callback_observation_does_not_advance_its_invocation_authority() {
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
        drop(observed_first);
        let (second, observed_second) = callback("https://second.invalid/");
        calls.authorize(41, second, &mut input).await.unwrap();
        let (independent, observed_independent) = callback("https://independent.invalid/");
        calls.authorize(42, independent, &mut input).await.unwrap();
        let WorkerFrame::BrowserAuthorization {
            id: 42,
            authorization_id: independent_id,
            ..
        } = read(&mut output).await.unwrap()
        else {
            panic!("a cancelled observer advanced the next same-invocation callback early")
        };
        calls
            .authorization_result(42, independent_id, Ok(()), &mut input)
            .await
            .unwrap();
        observed_independent.await.unwrap().unwrap();
        calls
            .authorization_result(
                41,
                first_id,
                Err(Failure::Failed("first denied".into())),
                &mut input,
            )
            .await
            .unwrap();
        let WorkerFrame::BrowserAuthorization {
            id: 41,
            authorization_id: second_id,
            ..
        } = read(&mut output).await.unwrap()
        else {
            panic!("the queued callback was lost")
        };
        assert!(first_id < independent_id && independent_id < second_id);
        calls
            .authorization_result(
                41,
                second_id,
                Err(Failure::Failed("second denied".into())),
                &mut input,
            )
            .await
            .unwrap();
        assert!(
            matches!(observed_second.await.unwrap(), Err(Failure::Failed(message)) if message == "second denied")
        );
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
    async fn future_cancellation_identity_faults_without_dispatching_or_forging_an_ack() {
        let (requests, receive) = mpsc::channel(1);
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(serve(
            receive,
            writer,
            CancellationToken::new(),
            Arc::new(Mutex::new(Driver::default())),
        ));
        let _: Hello = read(&mut output).await.unwrap();
        requests.send(ParentFrame::Cancel { id: 1 }).await.unwrap();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "desktop cancellation identity mismatch");
        assert_eq!(output.read(&mut [0]).await.unwrap(), 0);
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
}
