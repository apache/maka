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
//! Trusted plugin VMs, separate from the model runtime.
//! A VM multiplexes modules and promises; module handles own code retention.
mod captured;
mod engine;
mod foreground;
mod request;
mod worker;

pub use captured::Captured;
pub use foreground::{Foreground, ForegroundCallbacks, ForegroundModule};
pub use request::RequestBridge;

use crate::json;
use deno_core::v8;
use serde_json::Value;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, thiserror::Error)]
#[error("plugin VM: {0}")]
pub struct Error(pub String);
type Result<T> = std::result::Result<T, Error>;

const INPUT_WINDOW: usize = 32 * 1024 * 1024;
fn input_charge(bytes: usize) -> Result<u32> {
    u32::try_from(bytes.clamp(1, INPUT_WINDOW)).map_err(|_| failed("VM input budget exhausted"))
}

#[derive(Clone)]
pub struct Limits {
    pub heap_bytes: usize,
    /// Maximum uninterrupted synchronous poll, not time waiting on a Host service.
    pub synchronous_slice: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            heap_bytes: 128 * 1024 * 1024,
            synchronous_slice: Duration::from_secs(5),
        }
    }
}

#[derive(Clone, Debug)]
enum State {
    Loading,
    Ready,
    Closed(Option<Error>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Realm {
    Pure,
    Scoped,
}

#[derive(Clone)]
pub struct Vm(Arc<Inner>);
struct Inner {
    realm: Realm,
    commands: mpsc::UnboundedSender<Command>,
    health: Arc<Health>,
    bytes: Arc<Semaphore>,
    sequence: AtomicU64,
}

#[derive(Clone)]
pub struct Module(Arc<ModuleOwner>);
#[derive(Clone)]
pub struct WeakModule(std::sync::Weak<ModuleOwner>);
impl WeakModule {
    pub fn upgrade(&self) -> Option<Module> {
        self.0.upgrade().map(Module)
    }
}
struct ModuleOwner {
    vm: Vm,
    id: u64,
    closing: AtomicBool,
    state: watch::Receiver<State>,
}

impl Drop for ModuleOwner {
    fn drop(&mut self) {
        if !self.closing.swap(true, Ordering::SeqCst) {
            let _ = self.vm.0.commands.send(Command::Close(self.id));
        }
    }
}

#[derive(Clone, Debug)]
pub struct Statistics {
    pub modules: usize,
    pub pending_calls: usize,
    pub captured_callbacks: usize,
    pub used_heap_bytes: usize,
}

enum Command {
    Load {
        id: u64,
        name: String,
        source: String,
        state: watch::Sender<State>,
        bytes: OwnedSemaphorePermit,
    },
    Call {
        module: Module,
        target: captured::Target,
        args: Vec<Value>,
        context: Option<Arc<request::Owner>>,
        reply: oneshot::Sender<Result<Value>>,
        bytes: OwnedSemaphorePermit,
    },
    Capture {
        module: Module,
        namespace: Vec<String>,
        methods: Vec<String>,
        reply: oneshot::Sender<Result<Captured>>,
        bytes: OwnedSemaphorePermit,
    },
    ReleaseCaptured {
        module: u64,
        callback: u64,
    },
    Close(u64),
    Statistics {
        collect: bool,
        reply: oneshot::Sender<Statistics>,
    },
}

struct Health {
    isolate: OnceLock<v8::IsolateHandle>,
    failure: Mutex<Option<Error>>,
    stopped: CancellationToken,
    closed: CancellationToken,
    initializing: AtomicBool,
    polling: watch::Sender<Option<PollClock>>,
}
#[derive(Clone, Copy)]
struct PollClock {
    started: tokio::time::Instant,
    initializing: bool,
}
impl Health {
    fn fail(&self, error: Error) {
        self.failure.lock().unwrap().get_or_insert_with(|| {
            let phase = if self.initializing.load(Ordering::SeqCst) {
                "runtime initialization"
            } else {
                "script poll"
            };
            failed(format!("{} (phase: {phase})", error.0))
        });
        self.stopped.cancel();
        if let Some(isolate) = self.isolate.get() {
            isolate.terminate_execution();
        }
    }
    fn error(&self) -> Error {
        self.failure
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| failed("worker closed"))
    }
}

impl Vm {
    /// A background realm without Host ops or ambient Deno access.
    pub fn pure(limits: Limits) -> Result<Self> {
        Self::create(limits, Realm::Pure)
    }

    /// A background realm with only native request-private capabilities.
    /// No ambient Host router or Deno globals are installed.
    pub fn scoped(limits: Limits) -> Result<Self> {
        Self::create(limits, Realm::Scoped)
    }

    fn create(limits: Limits, realm: Realm) -> Result<Self> {
        if limits.heap_bytes < 16 * 1024 * 1024 || limits.synchronous_slice.is_zero() {
            return Err(failed("invalid VM limits"));
        }
        let scheduler = tokio::runtime::Handle::try_current().map_err(failed)?;
        super::initialize_platform();
        let (commands, receiver) = mpsc::unbounded_channel();
        let health = Arc::new(Health {
            isolate: OnceLock::new(),
            failure: Mutex::default(),
            stopped: CancellationToken::new(),
            closed: CancellationToken::new(),
            initializing: AtomicBool::new(true),
            polling: watch::channel(None).0,
        });
        let observer = health.clone();
        let slice = limits.synchronous_slice;
        scheduler.spawn(async move {
            monitor(observer, slice).await;
        });
        let owner = health.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("maka-plugin-js".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(failed)?
                        .block_on(worker::run(receiver, owner.clone(), limits, realm))
                }));
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => owner.fail(error),
                    Err(_) => owner.fail(failed("worker panicked")),
                }
                owner.closed.cancel();
            })
        {
            health.fail(failed(error));
            health.closed.cancel();
            return Err(health.error());
        }
        Ok(Self(Arc::new(Inner {
            realm,
            commands,
            health,
            bytes: Arc::new(Semaphore::new(INPUT_WINDOW)),
            sequence: AtomicU64::new(1),
        })))
    }

    /// Reserve module custody before awaiting readiness.
    /// Entrypoints are prebuilt ESM bundles: no imports or top-level await.
    pub fn load(&self, name: String, source: String) -> Result<Module> {
        if self.0.health.stopped.is_cancelled() {
            return Err(failed("VM is stopped"));
        }
        let bytes = self
            .0
            .bytes
            .clone()
            .try_acquire_many_owned(input_charge(
                source
                    .len()
                    .checked_add(name.len())
                    .ok_or_else(|| failed("module input length is not representable"))?,
            )?)
            .map_err(|_| failed("VM input budget exhausted"))?;
        let id = self
            .0
            .sequence
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| failed("module identity exhausted"))?;
        let (state, receiver) = watch::channel(State::Loading);
        self.0
            .commands
            .send(Command::Load {
                id,
                name,
                source,
                state,
                bytes,
            })
            .map_err(|_| self.0.health.error())?;
        Ok(Module(Arc::new(ModuleOwner {
            vm: self.clone(),
            id,
            closing: AtomicBool::new(false),
            state: receiver,
        })))
    }

    pub fn terminate(&self, reason: impl ToString) {
        self.0.health.fail(failed(reason));
    }
    pub fn is_terminated(&self) -> bool {
        self.0.health.stopped.is_cancelled() || self.0.health.closed.is_cancelled()
    }
    pub async fn failed(&self) -> Error {
        self.0.health.stopped.cancelled().await;
        self.0.health.error()
    }
    pub async fn shutdown(&self) {
        self.terminate("VM shut down");
        self.0.health.closed.cancelled().await;
    }
    pub async fn statistics(&self, collect: bool) -> Result<Statistics> {
        let (reply, receive) = oneshot::channel();
        self.0
            .commands
            .send(Command::Statistics { collect, reply })
            .map_err(|_| self.0.health.error())?;
        receive.await.map_err(|_| self.0.health.error())
    }
}

impl Module {
    pub fn downgrade(&self) -> WeakModule {
        WeakModule(Arc::downgrade(&self.0))
    }
    pub fn vm_failed(&self) -> bool {
        self.0.vm.is_terminated()
    }
    /// First recorded VM stop reason. Cleanup owners inspect this before their
    /// own intentional shutdown, which may record a normal stop when none exists.
    pub fn vm_failure(&self) -> Option<Error> {
        self.0.vm.0.health.failure.lock().unwrap().clone()
    }
    pub async fn ready(&self) -> Result<()> {
        let mut state = self.0.state.clone();
        loop {
            match state.borrow_and_update().clone() {
                State::Ready if !self.0.closing.load(Ordering::SeqCst) => return Ok(()),
                State::Loading if !self.0.closing.load(Ordering::SeqCst) => {}
                State::Closed(Some(error)) => return Err(error),
                _ => return Err(failed("module is retired")),
            }
            state
                .changed()
                .await
                .map_err(|_| self.0.vm.0.health.error())?;
        }
    }

    /// Function paths are relative to the module namespace, not globalThis.
    pub async fn call(&self, path: Vec<String>, args: Vec<Value>) -> Result<Value> {
        self.call_inner(path, args).await
    }

    /// The fault domain is this module's entire VM, including shared peers.
    pub fn terminate_vm(&self, reason: impl ToString) {
        self.0.vm.terminate(reason);
    }

    async fn call_inner(&self, path: Vec<String>, args: Vec<Value>) -> Result<Value> {
        self.ready().await?;
        if path.is_empty() || path.iter().any(|name| name.is_empty()) {
            return Err(failed("invalid export path"));
        }
        let size = json::encoded_size(&(&path, &args), usize::MAX).map_err(failed)?;
        let bytes = self
            .0
            .vm
            .0
            .bytes
            .clone()
            .try_acquire_many_owned(input_charge(size)?)
            .map_err(|_| failed("VM input budget exhausted"))?;
        let (reply, result) = oneshot::channel();
        self.0
            .vm
            .0
            .commands
            .send(Command::Call {
                module: self.clone(),
                target: captured::Target::Path(path),
                args,
                context: None,
                reply,
                bytes,
            })
            .map_err(|_| self.0.vm.0.health.error())?;
        result.await.map_err(|_| self.0.vm.0.health.error())?
    }

    /// Closure stops new calls and acknowledges code reclamation after admitted
    /// calls drain. A caller deadline does not turn unfinished cleanup into success.
    pub async fn close(&self) -> Result<()> {
        if !self.0.closing.swap(true, Ordering::SeqCst) {
            let _ = self.0.vm.0.commands.send(Command::Close(self.0.id));
        }
        let mut state = self.0.state.clone();
        loop {
            if matches!(*state.borrow_and_update(), State::Closed(_)) {
                return Ok(());
            }
            if state.changed().await.is_err() {
                self.0.vm.0.health.closed.cancelled().await;
                return Ok(());
            }
        }
    }
}

async fn monitor(health: Arc<Health>, slice: Duration) {
    let mut polling = health.polling.subscribe();
    loop {
        let deadline = polling
            .borrow_and_update()
            .map(|clock| clock.started + slice);
        tokio::select! {
            _ = health.closed.cancelled() => return,
            _ = polling.changed() => {},
            _ = async { if let Some(deadline) = deadline { tokio::time::sleep_until(deadline).await } else { std::future::pending().await } } => {
                // Recheck under the watch read lock; the VM may already be idle.
                let clock = polling.borrow();
                if let Some(clock) = *clock
                    && clock.started + slice <= tokio::time::Instant::now() {
                    let phase = if clock.initializing { "runtime initialization" } else { "script poll" };
                    health.fail(failed(format!(
                        "synchronous execution budget exceeded (poll began in {phase}, wall elapsed {} ms)",
                        clock.started.elapsed().as_millis(),
                    )));
                    return;
                }
            }
        }
    }
}
fn failed(error: impl ToString) -> Error {
    Error(error.to_string())
}
