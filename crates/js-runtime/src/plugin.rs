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
mod bridge;
mod engine;
mod pool;
mod worker;

pub use bridge::Bridge;
pub use pool::Pool;

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

#[derive(Clone)]
pub struct Vm(Arc<Inner>);
struct Inner {
    commands: mpsc::UnboundedSender<Command>,
    health: Arc<Health>,
    modules: Arc<Semaphore>,
    calls: Arc<Semaphore>,
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
    control_calls: Arc<Semaphore>,
    control_bytes: Arc<Semaphore>,
}

#[derive(Clone, Copy)]
pub enum Lifecycle {
    Retire,
    Dispose,
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
    pub used_heap_bytes: usize,
}

enum Command {
    Load {
        id: u64,
        bridge: Option<Arc<dyn Bridge>>,
        plugin: bool,
        name: String,
        source: String,
        state: watch::Sender<State>,
        slot: OwnedSemaphorePermit,
        bytes: OwnedSemaphorePermit,
    },
    Call {
        module: u64,
        path: Vec<String>,
        args: Vec<Value>,
        reply: oneshot::Sender<Result<Value>>,
        slot: OwnedSemaphorePermit,
        bytes: OwnedSemaphorePermit,
    },
    Close(u64),
    ReleaseCallback {
        module: u64,
        callback: u32,
    },
    Statistics {
        collect: bool,
        reply: oneshot::Sender<Statistics>,
        slot: OwnedSemaphorePermit,
    },
}

struct Health {
    isolate: OnceLock<v8::IsolateHandle>,
    failure: Mutex<Option<Error>>,
    stopped: CancellationToken,
    closed: CancellationToken,
    polling: watch::Sender<Option<tokio::time::Instant>>,
}
impl Health {
    fn fail(&self, error: Error) {
        self.failure.lock().unwrap().get_or_insert(error);
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
    pub fn new(limits: Limits) -> Result<Self> {
        Self::start(limits, None)
    }

    fn start(limits: Limits, reservation: Option<OwnedSemaphorePermit>) -> Result<Self> {
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
                        .block_on(worker::run(receiver, owner.clone(), limits))
                }));
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => owner.fail(error),
                    Err(_) => owner.fail(failed("worker panicked")),
                }
                drop(reservation);
                owner.closed.cancel();
            })
        {
            health.fail(failed(error));
            health.closed.cancel();
            return Err(health.error());
        }
        Ok(Self(Arc::new(Inner {
            commands,
            health,
            modules: Arc::new(Semaphore::new(64)),
            calls: Arc::new(Semaphore::new(128)),
            bytes: Arc::new(Semaphore::new(32 * 1024 * 1024)),
            sequence: AtomicU64::new(1),
        })))
    }

    /// Synchronous reservation lets a Fiber own cleanup before awaiting readiness.
    /// Entrypoints are prebuilt ESM bundles: no imports or top-level await.
    pub fn load(&self, name: String, source: String) -> Result<Module> {
        self.load_with_bridge(name, source, None)
    }

    pub fn load_with_bridge(
        &self,
        name: String,
        source: String,
        bridge: Option<Arc<dyn Bridge>>,
    ) -> Result<Module> {
        self.load_bound(name, source, bridge, false)
    }

    pub fn load_plugin(
        &self,
        name: String,
        source: String,
        bridge: Arc<dyn Bridge>,
    ) -> Result<Module> {
        self.load_bound(name, source, Some(bridge), true)
    }

    fn load_bound(
        &self,
        name: String,
        source: String,
        bridge: Option<Arc<dyn Bridge>>,
        plugin: bool,
    ) -> Result<Module> {
        if name.len() > 1024
            || source.len() > 8 * 1024 * 1024
            || self.0.health.stopped.is_cancelled()
        {
            return Err(failed("module is too large or VM is stopped"));
        }
        let slot = self
            .0
            .modules
            .clone()
            .try_acquire_owned()
            .map_err(|_| failed("module capacity exhausted"))?;
        let bytes = self
            .0
            .bytes
            .clone()
            .try_acquire_many_owned(source.len().max(1) as u32)
            .map_err(|_| failed("VM input budget exhausted"))?;
        let id = self
            .0
            .sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| failed("module identity exhausted"))?;
        let (state, receiver) = watch::channel(State::Loading);
        self.0
            .commands
            .send(Command::Load {
                id,
                bridge,
                plugin,
                name,
                source,
                state,
                slot,
                bytes,
            })
            .map_err(|_| self.0.health.error())?;
        Ok(Module(Arc::new(ModuleOwner {
            vm: self.clone(),
            id,
            closing: AtomicBool::new(false),
            state: receiver,
            control_calls: Arc::new(Semaphore::new(2)),
            control_bytes: Arc::new(Semaphore::new(8192)),
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
        let slot = self
            .0
            .calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| failed("VM call capacity exhausted"))?;
        let (reply, receive) = oneshot::channel();
        self.0
            .commands
            .send(Command::Statistics {
                collect,
                reply,
                slot,
            })
            .map_err(|_| self.0.health.error())?;
        receive.await.map_err(|_| self.0.health.error())
    }
}

impl Module {
    pub fn release_callback(&self, callback: u32) {
        let _ = self.0.vm.0.commands.send(Command::ReleaseCallback {
            module: self.0.id,
            callback,
        });
    }
    pub fn downgrade(&self) -> WeakModule {
        WeakModule(Arc::downgrade(&self.0))
    }
    pub fn vm_failed(&self) -> bool {
        self.0.vm.is_terminated()
    }
    pub async fn cancel_call(&self, id: String) -> Result<()> {
        if id.len() > 128 {
            return Err(failed("invalid invocation identity"));
        }
        self.call_inner(vec!["cancel".into()], vec![Value::String(id)], true)
            .await
            .map(|_| ())
    }
    /// Routing identity inside this VM, not authorization or a durable identity.
    pub fn host_key(&self) -> String {
        self.0.id.to_string()
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
        self.call_inner(path, args, false).await
    }

    /// Reserved control capacity lets retirement signal calls that fill the
    /// ordinary request budget and are waiting for that very signal.
    pub async fn lifecycle(&self, action: Lifecycle) -> Result<()> {
        let name = match action {
            Lifecycle::Retire => "retire",
            Lifecycle::Dispose => "dispose",
        };
        self.call_inner(vec![name.into()], vec![], true)
            .await
            .map(|_| ())
    }

    /// The fault domain is this module's entire VM, including shared peers.
    pub fn terminate_vm(&self, reason: impl ToString) {
        self.0.vm.terminate(reason);
    }

    async fn call_inner(
        &self,
        path: Vec<String>,
        args: Vec<Value>,
        control: bool,
    ) -> Result<Value> {
        self.ready().await?;
        if path.is_empty()
            || path.len() > 8
            || path.iter().any(|name| name.is_empty() || name.len() > 128)
        {
            return Err(failed("invalid export path"));
        }
        let size = serde_json::to_vec(&args).map_err(failed)?.len();
        if size > 32 * 1024 * 1024 {
            return Err(failed("call arguments exceed 32 MiB"));
        }
        let calls = if control {
            &self.0.control_calls
        } else {
            &self.0.vm.0.calls
        };
        let budget = if control {
            &self.0.control_bytes
        } else {
            &self.0.vm.0.bytes
        };
        let slot = if control {
            // Retirement and several stream cancellations may arrive together.
            // Wait in the reserved lane instead of rejecting cleanup while its
            // other signals are making progress; ordinary calls stay fail-fast.
            tokio::select! {
                biased;
                _ = self.0.vm.0.health.stopped.cancelled() => return Err(self.0.vm.0.health.error()),
                slot = calls.clone().acquire_owned() => slot.map_err(|_| self.0.vm.0.health.error())?,
            }
        } else {
            calls
                .clone()
                .try_acquire_owned()
                .map_err(|_| failed("VM call capacity exhausted"))?
        };
        let bytes = budget
            .clone()
            .try_acquire_many_owned(size.max(1) as u32)
            .map_err(|_| failed("VM input budget exhausted"))?;
        let (reply, result) = oneshot::channel();
        self.0
            .vm
            .0
            .commands
            .send(Command::Call {
                module: self.0.id,
                path,
                args,
                reply,
                slot,
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
        let deadline = polling.borrow_and_update().map(|started| started + slice);
        tokio::select! {
            _ = health.closed.cancelled() => return,
            _ = polling.changed() => {},
            _ = async { if let Some(deadline) = deadline { tokio::time::sleep_until(deadline).await } else { std::future::pending().await } } => {
                // Recheck under the watch read lock; the VM may already be idle.
                let clock = polling.borrow();
                if clock.is_some_and(|started| started + slice <= tokio::time::Instant::now()) {
                    health.fail(failed("synchronous execution budget exceeded"));
                    return;
                }
            }
        }
    }
}
fn failed(error: impl ToString) -> Error {
    Error(error.to_string())
}
