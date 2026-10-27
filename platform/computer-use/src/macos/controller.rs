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

//! One native thread owns a controller's AX references and notification state.

use super::Target;
use super::page_scroll::{
    IndexedSelection, indexed_selection,
    metadata::{Observation, Query},
    target::{
        EventTarget, GlobalWindowObservation, PointMetadata, ProcessState, Resolution,
        TargetResolver,
    },
    windows::{WindowVariant, Windows},
};
use crate::{
    desktop::NativeEpochId,
    protocol::{Action, PasteFormat},
};
use core_foundation::{
    base::CFOptionFlags,
    filedescriptor::{
        CFFileDescriptor, CFFileDescriptorContext, CFFileDescriptorEnableCallBacks,
        CFFileDescriptorRef, kCFFileDescriptorReadCallBack,
    },
    runloop::{
        CFRunLoop, CFRunLoopRunInMode, CFRunLoopSource, kCFRunLoopDefaultMode,
        kCFRunLoopRunHandledSource,
    },
};
use cua_driver_contract::WindowBounds;
use maka_agent_facts::tools::ToolError;
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
    ffi::c_void,
    io::{Read, Write},
    marker::PhantomData,
    os::{fd::AsRawFd, unix::net::UnixStream},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

type Reply = oneshot::Sender<Result<Response, ToolError>>;
type Completion<T, E = ToolError> = watch::Receiver<Option<Result<T, E>>>;

#[derive(Clone)]
struct StartFailure {
    error: ToolError,
    owner: Option<Arc<Transport>>,
}

/// A cloneable passive client; creating it does not start a thread or AX I/O.
#[derive(Clone)]
pub(crate) struct Controller {
    inner: Arc<Inner>,
}

struct Inner {
    pid: i32,
    generation: String,
    bundle: Option<String>,
    lifecycle: Mutex<Lifecycle>,
}

enum Lifecycle {
    Dormant,
    Starting(Completion<Arc<Transport>, StartFailure>),
    Running(Arc<Transport>),
    Closing(Completion<()>),
    Terminal {
        result: Result<(), ToolError>,
        _owner: Option<Arc<Transport>>,
    },
}

enum RetirementState {
    Native,
    Closing(Completion<()>),
    Settled(Result<(), ToolError>),
}

/// A bound window slot, paired with its controller so handles cannot cross owners.
#[derive(Clone)]
pub(crate) struct Window {
    controller: Controller,
    slot: u64,
}

impl std::fmt::Debug for Window {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Window")
            .field("slot", &self.slot)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Controller {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Controller")
            .field("pid", &self.inner.pid)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct IndexedId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ResolveId(u64);

#[derive(Debug)]
pub(crate) struct IndexedPoint {
    pub(crate) point: Option<[f64; 2]>,
    pub(crate) frame: Option<WindowBounds>,
}

#[derive(Debug)]
pub(crate) enum IndexedStep {
    NeedChess { token: IndexedId },
    Ready(IndexedPoint),
}

/// Native event geometry, without any AX object or reference crossing the mailbox.
#[derive(Debug)]
pub(crate) struct TargetData {
    pub(crate) pid: i32,
    pub(crate) window_id: u32,
    pub(crate) bounds: WindowBounds,
    pub(crate) flipped: bool,
}

#[derive(Debug)]
pub(crate) enum ResolveStep {
    NeedQuery {
        token: ResolveId,
        query: Query,
    },
    Ready {
        token: ResolveId,
        target: TargetData,
    },
}

enum Command {
    Bind {
        epoch: NativeEpochId,
        window_id: u32,
    },
    Verify {
        slot: u64,
    },
    Observe {
        slot: u64,
    },
    CursorPoint {
        slot: u64,
        index: u64,
    },
    Clear {
        slot: u64,
    },
    ReleaseWindow {
        slot: u64,
    },
    Action {
        slot: u64,
        action: Action,
        cancellation: CancellationToken,
    },
    Paste {
        slot: u64,
        text: String,
        format: PasteFormat,
        cancellation: CancellationToken,
    },
    ReleaseEpoch {
        epoch: NativeEpochId,
    },
    Position,
    SetPosition {
        position: [i64; 2],
    },
    BeginIndexed {
        slot: u64,
        index: u64,
        cancellation: CancellationToken,
    },
    FinishIndexed {
        token: IndexedId,
        chess_pid: Option<i32>,
    },
    CancelIndexed {
        token: IndexedId,
    },
    BeginResolve {
        epoch: NativeEpochId,
        point: [f64; 2],
        cancellation: CancellationToken,
    },
    AdvanceResolve {
        token: ResolveId,
        observation: Observation,
    },
    ReleaseResolve {
        token: ResolveId,
    },
    Stop,
}

enum Response {
    Unit,
    Bound { slot: u64 },
    Geometry(WindowBounds),
    Observed(String),
    Point([f64; 2]),
    Pasted { restored: bool },
    Position([i64; 2]),
    Indexed(IndexedStep),
    Resolved(ResolveStep),
    Stopped,
}

struct Envelope {
    command: Command,
    reply: Reply,
}

struct Transport {
    sender: Mutex<Option<mpsc::Sender<Envelope>>>,
    wake: UnixStream,
    thread: Mutex<Option<JoinHandle<Result<(), ToolError>>>>,
}

impl Controller {
    pub(crate) fn new(pid: i32, generation: String, bundle: Option<String>) -> Self {
        Self {
            inner: Arc::new(Inner {
                pid,
                generation,
                bundle,
                lifecycle: Mutex::new(Lifecycle::Dormant),
            }),
        }
    }

    pub(crate) async fn ensure_started(&self) -> Result<(), ToolError> {
        self.transport().await.map(|_| ())
    }

    pub(crate) fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    async fn transport(&self) -> Result<Arc<Transport>, ToolError> {
        loop {
            let pending = {
                let mut lifecycle = self
                    .inner
                    .lifecycle
                    .lock()
                    .expect("AX controller lifecycle poisoned");
                match &*lifecycle {
                    Lifecycle::Running(transport) => return Ok(transport.clone()),
                    Lifecycle::Dormant => {
                        let (reply, pending) = watch::channel(None);
                        *lifecycle = Lifecycle::Starting(pending.clone());
                        let inner = self.inner.clone();
                        tokio::spawn(async move {
                            let result = Transport::start(
                                inner.pid,
                                inner.generation.clone(),
                                inner.bundle.clone(),
                            )
                            .await;
                            let _ = reply.send(Some(result));
                        });
                        pending
                    }
                    Lifecycle::Starting(pending) => pending.clone(),
                    Lifecycle::Closing(_) => return Err(failed("native AX controller is closing")),
                    Lifecycle::Terminal { result, .. } => {
                        return Err(result
                            .clone()
                            .err()
                            .unwrap_or_else(|| failed("native AX controller is closed")));
                    }
                }
            };
            let started = match started(pending).await {
                Ok(transport) => transport,
                Err(failure) => {
                    let mut lifecycle = self
                        .inner
                        .lifecycle
                        .lock()
                        .expect("AX controller lifecycle poisoned");
                    if matches!(*lifecycle, Lifecycle::Starting(_)) {
                        *lifecycle = Lifecycle::Terminal {
                            result: Err(failure.error.clone()),
                            _owner: failure.owner,
                        };
                    }
                    return Err(failure.error);
                }
            };
            let mut lifecycle = self
                .inner
                .lifecycle
                .lock()
                .expect("AX controller lifecycle poisoned");
            if matches!(*lifecycle, Lifecycle::Starting(_)) {
                *lifecycle = Lifecycle::Running(started);
            }
        }
    }

    async fn request(&self, command: Command) -> Result<Response, ToolError> {
        self.transport().await?.request(command).await
    }

    pub(crate) async fn bind_window(
        &self,
        epoch: NativeEpochId,
        window_id: u32,
    ) -> Result<Window, ToolError> {
        match self.request(Command::Bind { epoch, window_id }).await? {
            Response::Bound { slot } => Ok(Window {
                controller: self.clone(),
                slot,
            }),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn release_epoch(&self, epoch: NativeEpochId) -> Result<(), ToolError> {
        self.retire(Command::ReleaseEpoch { epoch }).await
    }

    fn retirement_state(&self) -> RetirementState {
        let lifecycle = self
            .inner
            .lifecycle
            .lock()
            .expect("AX controller lifecycle poisoned");
        match &*lifecycle {
            Lifecycle::Dormant => RetirementState::Settled(Ok(())),
            Lifecycle::Starting(_) | Lifecycle::Running(_) => RetirementState::Native,
            Lifecycle::Closing(pending) => RetirementState::Closing(pending.clone()),
            Lifecycle::Terminal { result, .. } => RetirementState::Settled(result.clone()),
        }
    }

    async fn retire(&self, command: Command) -> Result<(), ToolError> {
        match self.retirement_state() {
            RetirementState::Native => {}
            RetirementState::Closing(pending) => return completed(pending).await,
            RetirementState::Settled(result) => return result,
        }
        let result = self.request(command).await.and_then(unit);
        if result.is_ok() {
            return result;
        }
        // Close may have shut admission after the native-state check. Its
        // original ACK and join can confirm retirement even without a slot ACK.
        match self.retirement_state() {
            RetirementState::Native => result,
            RetirementState::Closing(pending) => completed(pending).await,
            RetirementState::Settled(closed) => closed,
        }
    }

    pub(crate) async fn position(&self) -> Result<[i64; 2], ToolError> {
        match self.request(Command::Position).await? {
            Response::Position(position) => Ok(position),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn set_position(&self, position: [i64; 2]) -> Result<(), ToolError> {
        unit(self.request(Command::SetPosition { position }).await?)
    }

    pub(crate) async fn begin_indexed(
        &self,
        window: &Window,
        index: u64,
        cancellation: CancellationToken,
    ) -> Result<IndexedStep, ToolError> {
        self.require_window(window)?;
        match self
            .request(Command::BeginIndexed {
                slot: window.slot,
                index,
                cancellation,
            })
            .await?
        {
            Response::Indexed(step) => Ok(step),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn finish_indexed(
        &self,
        token: IndexedId,
        chess_pid: Option<i32>,
    ) -> Result<IndexedPoint, ToolError> {
        match self
            .request(Command::FinishIndexed { token, chess_pid })
            .await?
        {
            Response::Indexed(IndexedStep::Ready(point)) => Ok(point),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn cancel_indexed(&self, token: IndexedId) -> Result<(), ToolError> {
        self.retire(Command::CancelIndexed { token }).await
    }

    pub(crate) async fn begin_resolve(
        &self,
        epoch: NativeEpochId,
        point: [f64; 2],
        cancellation: CancellationToken,
    ) -> Result<ResolveStep, ToolError> {
        match self
            .request(Command::BeginResolve {
                epoch,
                point,
                cancellation,
            })
            .await?
        {
            Response::Resolved(step) => Ok(step),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn advance_resolve(
        &self,
        token: ResolveId,
        observation: Observation,
    ) -> Result<ResolveStep, ToolError> {
        match self
            .request(Command::AdvanceResolve { token, observation })
            .await?
        {
            Response::Resolved(step) => Ok(step),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn release_resolve(&self, token: ResolveId) -> Result<(), ToolError> {
        self.retire(Command::ReleaseResolve { token }).await
    }

    fn require_window(&self, window: &Window) -> Result<(), ToolError> {
        if !Arc::ptr_eq(&self.inner, &window.controller.inner) {
            return Err(failed("native AX window belongs to another controller"));
        }
        Ok(())
    }

    /// Admit one close operation; its custodian retains the original Stop ACK
    /// and join even if an observer of the close future disappears.
    pub(crate) async fn close(&self) -> Result<(), ToolError> {
        enum ClosingOwner {
            Starting(Completion<Arc<Transport>, StartFailure>),
            Running(Arc<Transport>),
        }
        enum CloseAction {
            Observe(Completion<()>),
            Start {
                owner: ClosingOwner,
                reply: watch::Sender<Option<Result<(), ToolError>>>,
                pending: Completion<()>,
            },
        }
        let action = {
            let mut lifecycle = self
                .inner
                .lifecycle
                .lock()
                .expect("AX controller lifecycle poisoned");
            match &*lifecycle {
                Lifecycle::Dormant => {
                    *lifecycle = Lifecycle::Terminal {
                        result: Ok(()),
                        _owner: None,
                    };
                    return Ok(());
                }
                Lifecycle::Starting(pending) => {
                    let owner = ClosingOwner::Starting(pending.clone());
                    let (reply, pending) = watch::channel(None);
                    *lifecycle = Lifecycle::Closing(pending.clone());
                    CloseAction::Start {
                        owner,
                        reply,
                        pending,
                    }
                }
                Lifecycle::Running(transport) => {
                    let owner = ClosingOwner::Running(transport.clone());
                    let (reply, pending) = watch::channel(None);
                    *lifecycle = Lifecycle::Closing(pending.clone());
                    CloseAction::Start {
                        owner,
                        reply,
                        pending,
                    }
                }
                Lifecycle::Closing(pending) => CloseAction::Observe(pending.clone()),
                Lifecycle::Terminal { result, .. } => return result.clone(),
            }
        };
        let pending = match action {
            CloseAction::Observe(pending) => pending,
            CloseAction::Start {
                owner,
                reply,
                pending,
            } => {
                let inner = self.inner.clone();
                tokio::spawn(async move {
                    let transport = match owner {
                        ClosingOwner::Starting(pending) => started(pending).await,
                        ClosingOwner::Running(transport) => Ok(transport),
                    };
                    let (result, retained) = match transport {
                        Ok(transport) => {
                            let result = transport.stop_and_join().await;
                            let retained = result.is_err().then_some(transport);
                            (result, retained)
                        }
                        Err(failure) => (Err(failure.error), failure.owner),
                    };
                    *inner
                        .lifecycle
                        .lock()
                        .expect("AX controller lifecycle poisoned") = Lifecycle::Terminal {
                        result: result.clone(),
                        _owner: retained,
                    };
                    let _ = reply.send(Some(result));
                });
                pending
            }
        };
        completed(pending).await
    }
}

impl Window {
    pub(crate) async fn verify(&self) -> Result<WindowBounds, ToolError> {
        match self
            .controller
            .request(Command::Verify { slot: self.slot })
            .await?
        {
            Response::Geometry(bounds) => Ok(bounds),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn observe(&self) -> Result<String, ToolError> {
        match self
            .controller
            .request(Command::Observe { slot: self.slot })
            .await?
        {
            Response::Observed(text) => Ok(text),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn cursor_point(&self, index: u64) -> Result<[f64; 2], ToolError> {
        match self
            .controller
            .request(Command::CursorPoint {
                slot: self.slot,
                index,
            })
            .await?
        {
            Response::Point(point) => Ok(point),
            _ => Err(unexpected()),
        }
    }

    pub(crate) async fn clear(&self) -> Result<(), ToolError> {
        self.controller
            .retire(Command::Clear { slot: self.slot })
            .await
    }

    /// Release this slot and its indexed continuations on the native owner.
    ///
    /// The reply confirms that those references have been dropped. This is
    /// idempotent and preserves the controller's windows map and cursor state.
    /// An error does not confirm retirement; retain this handle until a later
    /// release or controller close confirms it.
    pub(crate) async fn release(&self) -> Result<(), ToolError> {
        self.controller
            .retire(Command::ReleaseWindow { slot: self.slot })
            .await
    }

    pub(crate) async fn action(
        &self,
        action: Action,
        cancellation: CancellationToken,
    ) -> Result<(), ToolError> {
        unit(
            self.controller
                .request(Command::Action {
                    slot: self.slot,
                    action,
                    cancellation,
                })
                .await?,
        )
    }

    pub(crate) async fn paste(
        &self,
        text: String,
        format: PasteFormat,
        cancellation: CancellationToken,
    ) -> Result<bool, ToolError> {
        match self
            .controller
            .request(Command::Paste {
                slot: self.slot,
                text,
                format,
                cancellation,
            })
            .await?
        {
            Response::Pasted { restored } => Ok(restored),
            _ => Err(unexpected()),
        }
    }
}

impl Transport {
    async fn start(
        pid: i32,
        generation: String,
        bundle: Option<String>,
    ) -> Result<Arc<Self>, StartFailure> {
        let (sender, receiver) = mpsc::channel();
        let (wake, reader) = UnixStream::pair().map_err(unowned_start_failure)?;
        wake.set_nonblocking(true).map_err(unowned_start_failure)?;
        reader
            .set_nonblocking(true)
            .map_err(unowned_start_failure)?;
        let wake_again = wake.try_clone().map_err(unowned_start_failure)?;
        let (ready, receive_ready) = oneshot::channel();
        let thread = thread::Builder::new()
            .name(format!("maka-ax-{pid}"))
            .spawn(move || {
                let mut ready = Some(ready);
                let result = catch_unwind(AssertUnwindSafe(|| {
                    run_worker(
                        pid, generation, bundle, receiver, reader, wake_again, &mut ready,
                    )
                }));
                match result {
                    Ok(result) => {
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(result.clone());
                        }
                        result
                    }
                    Err(_) => {
                        let error = cleanup_error("native AX controller thread panicked");
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(Err(error.clone()));
                        }
                        Err(error)
                    }
                }
            })
            .map_err(unowned_start_failure)?;
        let transport = Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            wake,
            thread: Mutex::new(Some(thread)),
        });
        let error = match receive_ready.await {
            Ok(Ok(())) => return Ok(transport),
            Ok(Err(error)) => error,
            Err(error) => cleanup_error(error),
        };
        match transport.join().await {
            Ok(()) => Err(StartFailure { error, owner: None }),
            Err(join) => Err(StartFailure {
                error: cleanup_error(format!("{error}; {join}")),
                owner: Some(transport),
            }),
        }
    }

    async fn request(&self, command: Command) -> Result<Response, ToolError> {
        let (reply, receive) = oneshot::channel();
        {
            let sender = self.sender.lock().expect("AX command admission poisoned");
            sender
                .as_ref()
                .ok_or_else(|| failed("native AX controller is closing"))?
                .send(Envelope { command, reply })
                .map_err(cleanup_error)?;
        }
        // An accepted command remains owned until its original reply. A wake
        // error does not prove that its native work never started.
        let wake = wake(&self.wake);
        match receive.await {
            Ok(result) => result,
            Err(error) => Err(cleanup_error(match wake {
                Ok(()) => error.to_string(),
                Err(wake) => format!("{error}; {wake}"),
            })),
        }
    }

    async fn stop_and_join(&self) -> Result<(), ToolError> {
        let (reply, receive) = oneshot::channel();
        let admitted = {
            let mut sender = self.sender.lock().expect("AX command admission poisoned");
            sender
                .take()
                .ok_or_else(|| cleanup_error("native AX stop was already admitted"))
                .and_then(|sender| {
                    sender
                        .send(Envelope {
                            command: Command::Stop,
                            reply,
                        })
                        .map_err(cleanup_error)
                })
        };
        let stopped = match admitted {
            Ok(()) => {
                let _ = wake(&self.wake);
                receive
                    .await
                    .map_err(cleanup_error)
                    .and_then(|result| result)
            }
            Err(error) => Err(error),
        };
        let stopped = match stopped {
            Ok(Response::Stopped) => Ok(()),
            Ok(_) => Err(unexpected()),
            Err(error) => Err(error),
        };
        let joined = self.join().await;
        match (stopped, joined) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(stop), Err(join)) => Err(cleanup_error(format!("{stop}; {join}"))),
        }
    }

    async fn join(&self) -> Result<(), ToolError> {
        let thread = self
            .thread
            .lock()
            .expect("AX thread ownership poisoned")
            .take();
        let Some(thread) = thread else {
            return Err(cleanup_error("native AX thread join was already consumed"));
        };
        tokio::task::spawn_blocking(move || {
            thread
                .join()
                .map_err(|_| cleanup_error("native AX thread join observed a panic"))?
        })
        .await
        .map_err(cleanup_error)?
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        if self.thread.get_mut().is_ok_and(|thread| thread.is_some()) {
            let (reply, _receive) = oneshot::channel();
            if self
                .sender
                .get_mut()
                .ok()
                .and_then(Option::take)
                .is_some_and(|sender| {
                    sender
                        .send(Envelope {
                            command: Command::Stop,
                            reply,
                        })
                        .is_ok()
                })
            {
                let _ = wake(&self.wake);
            }
        }
    }
}

async fn completed<T: Clone>(mut pending: Completion<T>) -> Result<T, ToolError> {
    loop {
        if let Some(result) = pending.borrow().clone() {
            return result;
        }
        pending.changed().await.map_err(cleanup_error)?;
    }
}

async fn started(
    mut pending: Completion<Arc<Transport>, StartFailure>,
) -> Result<Arc<Transport>, StartFailure> {
    loop {
        if let Some(result) = pending.borrow().clone() {
            return result;
        }
        pending.changed().await.map_err(unowned_start_failure)?;
    }
}

fn unowned_start_failure(reason: impl std::fmt::Display) -> StartFailure {
    StartFailure {
        error: cleanup_error(reason),
        owner: None,
    }
}

fn wake(socket: &UnixStream) -> Result<(), ToolError> {
    let mut socket = socket;
    match socket.write(&[1]) {
        Ok(1) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(()),
        Ok(_) => Err(cleanup_error("native AX wake stream accepted no byte")),
        Err(error) => Err(cleanup_error(error)),
    }
}

fn unit(response: Response) -> Result<(), ToolError> {
    match response {
        Response::Unit => Ok(()),
        _ => Err(unexpected()),
    }
}

fn failed(reason: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(reason.to_string())
}
fn cleanup_error(reason: impl std::fmt::Display) -> ToolError {
    ToolError::CleanupUnconfirmed(reason.to_string())
}
fn unexpected() -> ToolError {
    cleanup_error("native AX controller returned an unexpected reply")
}

struct WindowSlot {
    epoch: NativeEpochId,
    target: Target,
}

struct PendingIndexed {
    epoch: NativeEpochId,
    slot: u64,
    selection: IndexedSelection,
    cancellation: CancellationToken,
}

#[derive(Clone, Copy)]
enum NeededObservation {
    Process(i32),
    GlobalWindow,
}

enum PendingResolve {
    WindowOrder {
        epoch: NativeEpochId,
        point: [f64; 2],
        windows: HashMap<u32, WindowVariant>,
        cancellation: CancellationToken,
    },
    Searching {
        epoch: NativeEpochId,
        point: [f64; 2],
        resolver: TargetResolver,
        processes: HashMap<i32, ProcessState>,
        global: GlobalWindowObservation,
        needed: NeededObservation,
        cancellation: CancellationToken,
    },
    Ready {
        epoch: NativeEpochId,
        _target: EventTarget,
    },
}

impl PendingResolve {
    fn epoch(&self) -> NativeEpochId {
        match self {
            Self::WindowOrder { epoch, .. }
            | Self::Searching { epoch, .. }
            | Self::Ready { epoch, .. } => *epoch,
        }
    }
}

struct WorkerState {
    pid: i32,
    generation: String,
    bundle: Option<String>,
    windows: Windows,
    slots: HashMap<u64, WindowSlot>,
    indexed: HashMap<IndexedId, PendingIndexed>,
    resolving: HashMap<ResolveId, PendingResolve>,
    position: [i64; 2],
    next_token: u64,
}

impl WorkerState {
    fn new(pid: i32, generation: String, bundle: Option<String>) -> Result<Self, ToolError> {
        if pid <= 0 {
            return Err(failed("native AX controller requires an actual process"));
        }
        verify_generation(pid, &generation)?;
        let mut windows = Windows::new(pid, bundle.as_deref())?;
        if let Err(error) = verify_generation(pid, &generation) {
            return Err(match windows.close() {
                Ok(()) => error,
                Err(cleanup) => cleanup_error(format!("{error}; {cleanup}")),
            });
        }
        Ok(Self {
            pid,
            generation,
            bundle,
            windows,
            slots: HashMap::new(),
            indexed: HashMap::new(),
            resolving: HashMap::new(),
            position: [0, 0],
            next_token: 1,
        })
    }

    fn token(&mut self) -> Result<u64, ToolError> {
        let token = self.next_token;
        self.next_token = token
            .checked_add(1)
            .ok_or_else(|| failed("native AX continuation identity cannot be represented"))?;
        Ok(token)
    }

    fn slot(&self, slot: u64) -> Result<&WindowSlot, ToolError> {
        self.slots
            .get(&slot)
            .ok_or_else(|| failed("native AX window handle has retired"))
    }

    fn slot_mut(&mut self, slot: u64) -> Result<&mut WindowSlot, ToolError> {
        self.slots
            .get_mut(&slot)
            .ok_or_else(|| failed("native AX window handle has retired"))
    }

    fn handle(&mut self, command: Command) -> Result<Response, ToolError> {
        if !matches!(
            command,
            Command::ReleaseEpoch { .. }
                | Command::Clear { .. }
                | Command::ReleaseWindow { .. }
                | Command::Position
                | Command::SetPosition { .. }
                | Command::CancelIndexed { .. }
                | Command::ReleaseResolve { .. }
                | Command::Stop
        ) {
            verify_generation(self.pid, &self.generation)?;
        }
        match command {
            Command::Bind { epoch, window_id } => {
                let target = Target::bind(self.pid as u32, u64::from(window_id))?;
                let slot = self.token()?;
                self.slots.insert(slot, WindowSlot { epoch, target });
                Ok(Response::Bound { slot })
            }
            Command::Verify { slot } => {
                let target = &self.slot(slot)?.target;
                target.verify()?;
                Ok(Response::Geometry(target.geometry()?))
            }
            Command::Observe { slot } => {
                let target = &mut self.slot_mut(slot)?.target;
                match target.observe() {
                    Ok(observed) => Ok(Response::Observed(observed)),
                    Err(error) => {
                        target.clear();
                        Err(error)
                    }
                }
            }
            Command::CursorPoint { slot, index } => Ok(Response::Point(
                self.slot(slot)?.target.cursor_point(index)?,
            )),
            Command::Clear { slot } => {
                if let Some(window) = self.slots.get_mut(&slot) {
                    window.target.clear();
                }
                Ok(Response::Unit)
            }
            Command::ReleaseWindow { slot } => {
                self.slots.remove(&slot);
                self.indexed.retain(|_, pending| pending.slot != slot);
                Ok(Response::Unit)
            }
            Command::Action {
                slot,
                action,
                cancellation,
            } => {
                self.slot_mut(slot)?.target.action(action, &cancellation)?;
                Ok(Response::Unit)
            }
            Command::Paste {
                slot,
                text,
                format,
                cancellation,
            } => {
                let restored = self.slot(slot)?.target.paste(
                    &text,
                    matches!(format, PasteFormat::Html),
                    &cancellation,
                )?;
                Ok(Response::Pasted { restored })
            }
            Command::ReleaseEpoch { epoch } => {
                self.slots.retain(|_, slot| slot.epoch != epoch);
                self.indexed.retain(|_, pending| pending.epoch != epoch);
                self.resolving.retain(|_, pending| pending.epoch() != epoch);
                Ok(Response::Unit)
            }
            Command::Position => Ok(Response::Position(self.position)),
            Command::SetPosition { position } => {
                self.position = position;
                Ok(Response::Unit)
            }
            Command::BeginIndexed {
                slot,
                index,
                cancellation,
            } => self.begin_indexed(slot, index, cancellation),
            Command::FinishIndexed { token, chess_pid } => self.finish_indexed(token, chess_pid),
            Command::CancelIndexed { token } => {
                self.indexed.remove(&token);
                Ok(Response::Unit)
            }
            Command::BeginResolve {
                epoch,
                point,
                cancellation,
            } => {
                check_cancelled(&cancellation)?;
                if !point.iter().all(|coordinate| coordinate.is_finite()) {
                    return Err(failed("native event point is not finite"));
                }
                // Copy only within this thread, before the Host reads CG order.
                // The snapshot retains the original stored dictionary keys.
                let windows = self.windows.entries()?.clone();
                let token = ResolveId(self.token()?);
                self.resolving.insert(
                    token,
                    PendingResolve::WindowOrder {
                        epoch,
                        point,
                        windows,
                        cancellation,
                    },
                );
                Ok(Response::Resolved(ResolveStep::NeedQuery {
                    token,
                    query: Query::WindowOrder,
                }))
            }
            Command::AdvanceResolve { token, observation } => {
                self.advance_resolve(token, observation)
            }
            Command::ReleaseResolve { token } => {
                self.resolving.remove(&token);
                Ok(Response::Unit)
            }
            Command::Stop => Err(cleanup_error(
                "native AX stop must retire the run-loop owner",
            )),
        }
    }

    fn begin_indexed(
        &mut self,
        slot: u64,
        index: u64,
        cancellation: CancellationToken,
    ) -> Result<Response, ToolError> {
        let window = self.slot(slot)?;
        let epoch = window.epoch;
        let selection =
            indexed_selection(&window.target, index, self.bundle.as_deref(), &cancellation)?;
        if selection.clickable.needs_chess_application() {
            let token = IndexedId(self.token()?);
            self.indexed.insert(
                token,
                PendingIndexed {
                    epoch,
                    slot,
                    selection,
                    cancellation,
                },
            );
            Ok(Response::Indexed(IndexedStep::NeedChess { token }))
        } else {
            let point = selection.clickable.resolve(None, &cancellation)?;
            Ok(Response::Indexed(IndexedStep::Ready(IndexedPoint {
                point,
                frame: selection.frame,
            })))
        }
    }

    fn finish_indexed(
        &mut self,
        token: IndexedId,
        chess_pid: Option<i32>,
    ) -> Result<Response, ToolError> {
        let pending = self
            .indexed
            .remove(&token)
            .ok_or_else(|| failed("native indexed continuation has retired"))?;
        check_cancelled(&pending.cancellation)?;
        let application = chess_pid.map(super::page_scroll::application).transpose()?;
        let point = pending
            .selection
            .clickable
            .resolve(application.as_ref(), &pending.cancellation)?;
        Ok(Response::Indexed(IndexedStep::Ready(IndexedPoint {
            point,
            frame: pending.selection.frame,
        })))
    }

    fn advance_resolve(
        &mut self,
        token: ResolveId,
        observation: Observation,
    ) -> Result<Response, ToolError> {
        let pending = self
            .resolving
            .remove(&token)
            .ok_or_else(|| failed("native target continuation has retired"))?;
        let (epoch, point, mut resolver, processes, global, cancellation) =
            match (pending, observation) {
                (
                    PendingResolve::WindowOrder {
                        epoch,
                        point,
                        windows,
                        cancellation,
                    },
                    Observation::WindowOrder { ids },
                ) => {
                    check_cancelled(&cancellation)?;
                    let resolver = TargetResolver::new(
                        self.pid,
                        self.bundle.as_deref(),
                        &windows,
                        point,
                        &PointMetadata {
                            on_screen_window_ids: ids,
                        },
                    )?;
                    (
                        epoch,
                        point,
                        resolver,
                        HashMap::new(),
                        GlobalWindowObservation::Unqueried,
                        cancellation,
                    )
                }
                (
                    PendingResolve::Searching {
                        epoch,
                        point,
                        resolver,
                        mut processes,
                        global,
                        needed: NeededObservation::Process(pid),
                        cancellation,
                    },
                    Observation::Process { application },
                ) => {
                    check_cancelled(&cancellation)?;
                    processes.insert(
                        pid,
                        application.map_or(ProcessState::Absent, |app| ProcessState::Running {
                            finished_launching: app.finished_launching,
                            activation_policy: app.activation_policy,
                        }),
                    );
                    (epoch, point, resolver, processes, global, cancellation)
                }
                (
                    PendingResolve::Searching {
                        epoch,
                        point,
                        resolver,
                        processes,
                        needed: NeededObservation::GlobalWindow,
                        cancellation,
                        ..
                    },
                    Observation::GlobalWindow { id },
                ) => {
                    check_cancelled(&cancellation)?;
                    (
                        epoch,
                        point,
                        resolver,
                        processes,
                        GlobalWindowObservation::Observed(id),
                        cancellation,
                    )
                }
                (pending, _) => {
                    self.resolving.insert(token, pending);
                    return Err(failed(
                        "native target continuation received a different observation kind",
                    ));
                }
            };
        match resolver.advance(&processes, &global)? {
            Resolution::NeedsProcess(pid) => {
                self.resolving.insert(
                    token,
                    PendingResolve::Searching {
                        epoch,
                        point,
                        resolver,
                        processes,
                        global,
                        needed: NeededObservation::Process(pid),
                        cancellation,
                    },
                );
                Ok(Response::Resolved(ResolveStep::NeedQuery {
                    token,
                    query: Query::Process { pid },
                }))
            }
            Resolution::NeedsGlobalWindow => {
                self.resolving.insert(
                    token,
                    PendingResolve::Searching {
                        epoch,
                        point,
                        resolver,
                        processes,
                        global,
                        needed: NeededObservation::GlobalWindow,
                        cancellation,
                    },
                );
                Ok(Response::Resolved(ResolveStep::NeedQuery {
                    token,
                    query: Query::GlobalWindow { point },
                }))
            }
            Resolution::Ready(target) => {
                let data = TargetData {
                    pid: target.pid,
                    window_id: target.window_id,
                    bounds: target.bounds.clone(),
                    flipped: target.flipped,
                };
                self.resolving.insert(
                    token,
                    PendingResolve::Ready {
                        epoch,
                        _target: target,
                    },
                );
                Ok(Response::Resolved(ResolveStep::Ready {
                    token,
                    target: data,
                }))
            }
        }
    }

    fn close(&mut self) -> Result<(), ToolError> {
        let closed = self.windows.close();
        self.indexed.clear();
        self.resolving.clear();
        self.slots.clear();
        closed
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() {
        Err(failed("Computer Use cancelled before native AX dispatch"))
    } else {
        Ok(())
    }
}

fn verify_generation(pid: i32, generation: &str) -> Result<(), ToolError> {
    let pid = u32::try_from(pid).map_err(failed)?;
    if crate::identity::process(pid)? != generation {
        return Err(failed("stale_target: native application process changed"));
    }
    Ok(())
}

struct PumpContext {
    state: RefCell<WorkerState>,
    commands: mpsc::Receiver<Envelope>,
    deferred: RefCell<VecDeque<Envelope>>,
    reader: RefCell<UnixStream>,
    wake_again: UnixStream,
    stopping: Cell<bool>,
    failure: RefCell<Option<ToolError>>,
    stop_reply: RefCell<Option<Reply>>,
}

enum PumpResult {
    Reenable,
    Deferred,
}

impl PumpContext {
    fn fail(&self, error: ToolError) {
        if self.failure.borrow().is_none() {
            *self.failure.borrow_mut() = Some(error);
        }
        self.stopping.set(true);
    }

    fn drain_wake_bytes(&self) -> Result<(), ToolError> {
        let mut bytes = [0_u8; 256];
        let mut reader = self.reader.borrow_mut();
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => return Err(cleanup_error("native AX wake stream closed")),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) => return Err(cleanup_error(error)),
            }
        }
    }

    fn next_command(&self) -> Result<Option<Envelope>, ToolError> {
        if let Some(envelope) = self.deferred.borrow_mut().pop_front() {
            return Ok(Some(envelope));
        }
        match self.commands.try_recv() {
            Ok(envelope) => Ok(Some(envelope)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(cleanup_error("native AX mailbox disconnected before Stop"))
            }
        }
    }

    fn pump_one(&self) -> Result<PumpResult, ToolError> {
        self.drain_wake_bytes()?;
        let Some(envelope) = self.next_command()? else {
            return Ok(PumpResult::Reenable);
        };
        if matches!(envelope.command, Command::Stop) {
            *self.stop_reply.borrow_mut() = Some(envelope.reply);
            self.stopping.set(true);
            return Ok(PumpResult::Reenable);
        }
        let Ok(mut state) = self.state.try_borrow_mut() else {
            // A nested native run loop must not re-enter an AX command. The
            // outer call re-enables this one-shot source after releasing state.
            self.deferred.borrow_mut().push_front(envelope);
            return Ok(PumpResult::Deferred);
        };
        let result = objc2::rc::autoreleasepool(|_| state.handle(envelope.command));
        drop(state);
        let _ = envelope.reply.send(result);
        if !self.stopping.get() {
            if let Some(next) = self.next_command()? {
                self.deferred.borrow_mut().push_front(next);
                wake(&self.wake_again)?;
            }
        }
        Ok(PumpResult::Reenable)
    }
}

extern "C" fn command_ready(
    descriptor: CFFileDescriptorRef,
    _types: CFOptionFlags,
    context: *mut c_void,
) {
    // SAFETY: this Box stays on the same native thread until the source is
    // removed and invalidated. CF only invokes the callback on that run loop.
    let context = unsafe { &*context.cast::<PumpContext>() };
    let result = catch_unwind(AssertUnwindSafe(|| context.pump_one()));
    let reenable = match result {
        Ok(Ok(PumpResult::Reenable)) => true,
        Ok(Ok(PumpResult::Deferred)) => false,
        Ok(Err(error)) => {
            context.fail(error);
            true
        }
        Err(_) => {
            context.fail(cleanup_error("native AX command callback panicked"));
            true
        }
    };
    if reenable && !context.stopping.get() {
        // SAFETY: CF retains this descriptor throughout its active callback.
        unsafe {
            CFFileDescriptorEnableCallBacks(descriptor, kCFFileDescriptorReadCallBack);
        }
    }
}

struct CommandSource<'context> {
    run_loop: CFRunLoop,
    descriptor: CFFileDescriptor,
    source: CFRunLoopSource,
    _context: PhantomData<&'context PumpContext>,
}

impl<'context> CommandSource<'context> {
    fn new(context: &'context PumpContext) -> Result<Self, ToolError> {
        let descriptor_context = CFFileDescriptorContext {
            version: 0,
            info: (context as *const PumpContext).cast_mut().cast(),
            retain: None,
            release: None,
            copyDescription: None,
        };
        let descriptor = CFFileDescriptor::new(
            context.reader.borrow().as_raw_fd(),
            false,
            command_ready,
            Some(&descriptor_context),
        )
        .ok_or_else(|| cleanup_error("native AX command descriptor is unavailable"))?;
        let Some(source) = descriptor.to_run_loop_source(0) else {
            descriptor.invalidate();
            return Err(cleanup_error(
                "native AX command run-loop source is unavailable",
            ));
        };
        let run_loop = CFRunLoop::get_current();
        // SAFETY: this is Foundation's static default-mode string.
        run_loop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
        descriptor.enable_callbacks(kCFFileDescriptorReadCallBack);
        Ok(Self {
            run_loop,
            descriptor,
            source,
            _context: PhantomData,
        })
    }
}

impl Drop for CommandSource<'_> {
    fn drop(&mut self) {
        self.descriptor
            .disable_callbacks(kCFFileDescriptorReadCallBack);
        // SAFETY: the static mode is valid while CoreFoundation is loaded.
        self.run_loop
            .remove_source(&self.source, unsafe { kCFRunLoopDefaultMode });
        // The UnixStream owns the fd. This stops callbacks without closing it.
        self.descriptor.invalidate();
    }
}

fn run_worker(
    pid: i32,
    generation: String,
    bundle: Option<String>,
    commands: mpsc::Receiver<Envelope>,
    reader: UnixStream,
    wake_again: UnixStream,
    ready: &mut Option<oneshot::Sender<Result<(), ToolError>>>,
) -> Result<(), ToolError> {
    let state = objc2::rc::autoreleasepool(|_| WorkerState::new(pid, generation, bundle))?;
    let context = Box::new(PumpContext {
        state: RefCell::new(state),
        commands,
        deferred: RefCell::new(VecDeque::new()),
        reader: RefCell::new(reader),
        wake_again,
        stopping: Cell::new(false),
        failure: RefCell::new(None),
        stop_reply: RefCell::new(None),
    });
    let source = match CommandSource::new(&context) {
        Ok(source) => source,
        Err(error) => {
            let cleanup = context.state.borrow_mut().close();
            return combine_cleanup(Err(error), cleanup);
        }
    };
    // SAFETY: this is Foundation's static default-mode string.
    let mode = unsafe { kCFRunLoopDefaultMode };
    if let Some(ready) = ready.take() {
        let _ = ready.send(Ok(()));
    }
    while !context.stopping.get() {
        // SAFETY: only this thread pumps its own run loop. MAX is a lifetime
        // wait, not a product deadline; every handled source returns control.
        let status = unsafe { CFRunLoopRunInMode(mode, f64::MAX, 1) };
        if context.stopping.get() {
            break;
        }
        if status != kCFRunLoopRunHandledSource {
            context.fail(cleanup_error(format!(
                "native AX run loop stopped unexpectedly ({status})"
            )));
            break;
        }
        let updated = objc2::rc::autoreleasepool(|_| {
            context
                .state
                .borrow_mut()
                .windows
                .apply_pending_notifications()
        });
        if let Err(error) = updated {
            context.fail(error);
        }
    }
    drop(source);
    let closed = objc2::rc::autoreleasepool(|_| context.state.borrow_mut().close());
    let failure = context.failure.borrow_mut().take().map_or(Ok(()), Err);
    let result = combine_cleanup(failure, closed);
    let reply = context.stop_reply.borrow_mut().take();
    drop(context);
    if let Some(reply) = reply {
        let _ = reply.send(result.clone().map(|()| Response::Stopped));
    }
    result
}

fn combine_cleanup(
    work: Result<(), ToolError>,
    cleanup: Result<(), ToolError>,
) -> Result<(), ToolError> {
    match (work, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(cleanup_error(error)),
        (Err(work), Err(cleanup)) => Err(cleanup_error(format!("{work}; {cleanup}"))),
    }
}

const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<Envelope>();
    assert_send::<Controller>();
    assert_send::<Window>();
};

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retiring_an_unused_controller_does_not_start_native_work() {
        let controller = Controller::new(123, "never-a-real-process-generation".into(), None);
        controller
            .release_epoch(NativeEpochId::new())
            .await
            .unwrap();
        assert!(matches!(
            *controller.inner.lifecycle.lock().unwrap(),
            Lifecycle::Dormant
        ));
        controller.close().await.unwrap();
        assert!(matches!(
            *controller.inner.lifecycle.lock().unwrap(),
            Lifecycle::Terminal { result: Ok(()), .. }
        ));
        controller
            .release_epoch(NativeEpochId::new())
            .await
            .unwrap();
        let window = Window {
            controller: controller.clone(),
            slot: 1,
        };
        window.clear().await.unwrap();
        window.release().await.unwrap();
        controller.cancel_indexed(IndexedId(2)).await.unwrap();
        controller.release_resolve(ResolveId(3)).await.unwrap();
    }

    #[tokio::test]
    async fn window_retirement_preserves_unconfirmed_close() {
        let controller = Controller::new(123, "never-a-real-process-generation".into(), None);
        *controller.inner.lifecycle.lock().unwrap() = Lifecycle::Terminal {
            result: Err(cleanup_error("original close was not confirmed")),
            _owner: None,
        };
        let window = Window {
            controller: controller.clone(),
            slot: 1,
        };
        for result in [
            window.clear().await,
            window.release().await,
            controller.release_epoch(NativeEpochId::new()).await,
            controller.cancel_indexed(IndexedId(2)).await,
            controller.release_resolve(ResolveId(3)).await,
        ] {
            assert!(matches!(
                result,
                Err(ToolError::CleanupUnconfirmed(reason))
                    if reason == "original close was not confirmed"
            ));
        }
    }

    #[test]
    fn a_window_slot_cannot_be_rebound_to_another_controller() {
        let a = Controller::new(123, "a".into(), None);
        let b = Controller::new(123, "a".into(), None);
        let window = Window {
            controller: b,
            slot: 1,
        };
        assert!(
            matches!(a.require_window(&window), Err(ToolError::Failed(reason)) if reason == "native AX window belongs to another controller")
        );
    }
}
