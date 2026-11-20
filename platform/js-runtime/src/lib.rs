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

pub mod automation;
mod bridge;
mod embedded;
mod evaluate;
mod execution_budget;
mod json;
mod module;
pub mod plugin;
pub mod repl;

use bridge::maka_code;
use deno_core::{JsRuntime, RuntimeOptions, v8};
use evaluate::evaluate;
use execution_budget::ExecutionBudget;
use maka_agent_facts::tools::ToolExecutor;
use maka_code_runtime::{CellAbort, CellDiagnostic, CellDiagnosticKind, CellResult};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellStore, ToolMetadata, ToolScope};
use maka_code_runtime::{
    PreparedCell, RuntimeVmObservation, SourceRuntimeOwner, VmBinding, VmThreadReady, complete,
};
use std::sync::{Arc, Mutex, Once};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

/// Fresh isolates off the host's async worker threads, each retaining ownership
/// of admitted Rust tools until they have finished cleanup.
#[derive(Clone)]
pub struct CodeExecutor {
    limits: CellLimits,
    owner: SourceRuntimeOwner,
}

impl CodeExecutor {
    pub fn new(limits: CellLimits) -> Result<Self, CellAbort> {
        if limits.timeout.is_zero()
            || std::time::Instant::now()
                .checked_add(limits.timeout)
                .is_none()
            || limits.heap_bytes < 8 * 1024 * 1024
        {
            return Err(CellAbort::Internal("invalid cell limits".into()));
        }
        Ok(Self {
            limits,
            owner: SourceRuntimeOwner::default(),
        })
    }

    pub async fn execute(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
    ) -> Result<CellResult, CellAbort> {
        let metadata = tools
            .names()
            .into_iter()
            .map(|name| ToolMetadata {
                name,
                description: String::new(),
            })
            .collect();
        let context = CellContext::new(
            CellStore::temporary().map_err(|error| CellAbort::Internal(error.message))?,
            metadata,
        )
        .map_err(|error| CellAbort::Internal(error.message))?;
        self.execute_with_context(source, tools, cancellation, context)
            .await
    }

    pub fn limits(&self) -> &CellLimits {
        &self.limits
    }

    pub fn physical_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.owner.physical_changes()
    }

    pub async fn observe_binding(&self, binding: &VmBinding) -> RuntimeVmObservation {
        self.owner.observe_binding(binding).await
    }

    pub fn release_binding(&self, binding: &VmBinding) -> bool {
        self.owner.release_binding(binding)
    }

    pub async fn execute_with_context(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
    ) -> Result<CellResult, CellAbort> {
        self.execute_source(source, tools, cancellation, context, false)
            .await
    }

    /// Prepare a real isolate and frozen module, without executing user code.
    /// Durable callers must ACK VmBound before consuming execute_bound.
    pub async fn prepare_module(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
    ) -> Result<PreparedCell, CellAbort> {
        self.prepare_source(source, tools, cancellation, context, true)
            .await
    }

    async fn execute_source(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
        module: bool,
    ) -> Result<CellResult, CellAbort> {
        self.prepare_source(source, tools, cancellation, context, module)
            .await?
            .execute_bound()
            .await
    }

    async fn prepare_source(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
        module: bool,
    ) -> Result<PreparedCell, CellAbort> {
        if cancellation.is_cancelled() {
            return Err(CellAbort::Cancelled);
        }
        let cancellation = cancellation.child_token();
        let handle = Handle::current();
        let limits = self.limits.clone();
        let owner_cancel = cancellation.clone();
        self.owner
            .prepare_thread("maka-code-js", cancellation, move |ready, gate| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // V8's unsynchronized op scheduler stays on this dedicated
                    // current-thread runtime. Host effects remain on the Host.
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| CellAbort::Internal(error.to_string()))?
                        .block_on(run_cell(
                            source,
                            tools,
                            owner_cancel,
                            limits,
                            handle,
                            context,
                            module,
                            ready,
                            gate,
                        ))
                }))
                .unwrap_or_else(|_| {
                    Err(CellAbort::VmCleanupUnconfirmed(
                        "cell worker panicked".into(),
                    ))
                })
            })
            .await
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The VM thread receives independent tool, resource, call-context and startup-barrier owners"
)]
async fn run_cell(
    source: String,
    executor: Arc<dyn ToolExecutor>,
    cancellation: CancellationToken,
    limits: CellLimits,
    host: Handle,
    context: CellContext,
    module: bool,
    ready: VmThreadReady,
    start: tokio::sync::oneshot::Receiver<()>,
) -> Result<CellResult, CellAbort> {
    if cancellation.is_cancelled() {
        return Err(CellAbort::Cancelled);
    }
    let names = executor.names();
    let scope = ToolScope::new(
        context.clone(),
        executor,
        cancellation.child_token(),
        host.clone(),
    );
    initialize_platform();
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions: vec![maka_code::init()],
        create_params: Some(bounded_create_params(limits.heap_bytes)),
        ..Default::default()
    })
    .map_err(|error| CellAbort::Internal(error.to_string()))?;
    runtime.op_state().borrow_mut().put(scope.clone());
    runtime.op_state().borrow_mut().put(context.clone());

    ready.publish()?;
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(CellAbort::Cancelled),
        ack = start => if ack.is_err() { return Err(CellAbort::Cancelled); },
    }

    let stopped = Arc::new(Mutex::new(None));
    let isolate = runtime.v8_isolate().thread_safe_handle();
    let heap_stop = stopped.clone();
    let heap_isolate = isolate.clone();
    runtime.add_near_heap_limit_callback(move |current, _initial| {
        heap_stop
            .lock()
            .unwrap()
            .get_or_insert(StopReason::HeapLimit);
        heap_isolate.terminate_execution();
        // Let V8 unwind termination instead of immediately taking its fatal
        // OOM path. This is a best-effort heap guard, not process containment.
        current.saturating_add(16 * 1024 * 1024)
    });

    let finished = CancellationToken::new();
    let _finish_on_drop = finished.clone().drop_guard();
    let budget = ExecutionBudget::new(limits.timeout);
    let monitor_budget = budget.clone();
    let monitor_finished = finished.clone();
    let monitor_cancel = cancellation.clone();
    let monitor_stopped = stopped.clone();
    let monitor = host.spawn(async move {
        let reason = tokio::select! {
            biased;
            _ = monitor_finished.cancelled() => return,
            _ = monitor_cancel.cancelled() => StopReason::Cancelled,
            _ = monitor_budget.exhausted() => StopReason::ExecutionBudget,
        };
        monitor_stopped.lock().unwrap().get_or_insert(reason);
        monitor_cancel.cancel();
        isolate.terminate_execution();
    });

    // V8 termination interrupts CPU work; the token also wakes idle JS timers.
    let evaluation = tokio::select! {
           biased;
           _ = cancellation.cancelled() => {
               stopped.lock().unwrap().get_or_insert(StopReason::Cancelled);
               Ok(Err(CellDiagnostic::new(CellDiagnosticKind::ExecutionError, "cell cancelled")))
           }
           result = budget
           .run(evaluate(
               &mut runtime,
               &source,
               &names,
               context.metadata(),
               module,
           ))
    => result,
       };
    let result = match evaluation {
        Ok(result) => result,
        Err(()) => {
            stopped
                .lock()
                .unwrap()
                .get_or_insert(StopReason::ExecutionBudget);
            Err(CellDiagnostic::limit("cell execution budget exceeded"))
        }
    };
    if module || result.is_err() {
        scope.cancel();
    }
    // No more ops can enter once the runtime is destroyed.
    drop(runtime);
    scope.settle().await;
    finished.cancel();
    monitor
        .await
        .map_err(|error| CellAbort::Internal(error.to_string()))?;

    // A caught JS exception or a concurrent cancellation cannot turn an
    // uncertain effect/commit into an ordinary successful tool result.
    if let Some(error) = context.failure() {
        return Err(CellAbort::Tool(error));
    }
    let result = match *stopped.lock().unwrap() {
        Some(StopReason::Cancelled) => return Err(CellAbort::Cancelled),
        Some(StopReason::ExecutionBudget) => {
            Err(CellDiagnostic::limit("cell execution budget exceeded"))
        }
        Some(StopReason::HeapLimit) => Err(CellDiagnostic::limit("JavaScript heap")),
        None => result,
    };
    Ok(complete(result, scope.calls()))
}

#[derive(Clone, Copy)]
enum StopReason {
    Cancelled,
    ExecutionBudget,
    HeapLimit,
}

struct ArrayBufferBudget {
    allocated: std::sync::atomic::AtomicUsize,
    limit: usize,
}

impl ArrayBufferBudget {
    const ALIGN: usize = 16;

    fn layout(len: usize) -> Option<std::alloc::Layout> {
        std::alloc::Layout::from_size_align(len.max(1), Self::ALIGN).ok()
    }

    fn reserve(&self, len: usize) -> bool {
        use std::sync::atomic::Ordering;
        self.allocated
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(len).filter(|&next| next <= self.limit)
            })
            .is_ok()
    }

    fn release(&self, len: usize) {
        self.allocated
            .fetch_sub(len, std::sync::atomic::Ordering::AcqRel);
    }
}

/// Bounds both V8's JS heap and off-heap ArrayBuffer backing stores to `heap_bytes`.
/// Without a bounded ArrayBuffer allocator, `new Uint8Array(N)` allocates native RAM
/// outside V8's heap limit and can spike Host RSS or OOM-kill the Host process.
pub(crate) fn bounded_create_params(heap_bytes: usize) -> v8::CreateParams {
    use std::ffi::c_void;

    unsafe extern "C" fn allocate(budget: &ArrayBufferBudget, len: usize) -> *mut c_void {
        let Some(layout) = ArrayBufferBudget::layout(len) else {
            return std::ptr::null_mut();
        };
        if !budget.reserve(len) {
            return std::ptr::null_mut();
        }
        // SAFETY: `layout` has non-zero size (`len.max(1)`) and valid power-of-two alignment.
        let ptr = unsafe { std::alloc::alloc_zeroed(layout) };
        if ptr.is_null() {
            budget.release(len);
            return std::ptr::null_mut();
        }
        ptr.cast()
    }

    unsafe extern "C" fn allocate_uninitialized(
        budget: &ArrayBufferBudget,
        len: usize,
    ) -> *mut c_void {
        let Some(layout) = ArrayBufferBudget::layout(len) else {
            return std::ptr::null_mut();
        };
        if !budget.reserve(len) {
            return std::ptr::null_mut();
        }
        // SAFETY: `layout` has non-zero size (`len.max(1)`) and valid power-of-two alignment.
        let ptr = unsafe { std::alloc::alloc(layout) };
        if ptr.is_null() {
            budget.release(len);
            return std::ptr::null_mut();
        }
        ptr.cast()
    }

    unsafe extern "C" fn free(budget: &ArrayBufferBudget, data: *mut c_void, len: usize) {
        if data.is_null() {
            return;
        }
        if let Some(layout) = ArrayBufferBudget::layout(len) {
            // SAFETY: `data` was returned by `allocate` or `allocate_uninitialized` with the
            // exact same `len`, so `layout` matches the original allocation layout.
            unsafe { std::alloc::dealloc(data.cast(), layout) };
        }
        budget.release(len);
    }

    unsafe extern "C" fn drop_budget(handle: *const ArrayBufferBudget) {
        // SAFETY: `handle` was created once by `Arc::into_raw` when constructing the allocator.
        drop(unsafe { Arc::from_raw(handle) });
    }

    static VTABLE: v8::RustAllocatorVtable<ArrayBufferBudget> = v8::RustAllocatorVtable {
        allocate,
        allocate_uninitialized,
        free,
        drop: drop_budget,
    };

    let budget = Arc::new(ArrayBufferBudget {
        allocated: std::sync::atomic::AtomicUsize::new(0),
        limit: heap_bytes,
    });
    // SAFETY: `Arc::into_raw` transfers ownership of one strong reference to V8, which
    // passes `&ArrayBufferBudget` to callbacks and releases it once via `drop_budget`.
    let allocator = unsafe { v8::new_rust_allocator(Arc::into_raw(budget), &VTABLE) };
    v8::CreateParams::default()
        .heap_limits(0, heap_bytes)
        .array_buffer_allocator(allocator)
}

fn initialize_platform() {
    static INIT: Once = Once::new();
    INIT.call_once(|| JsRuntime::init_platform(None));
}

/// Codex-style JavaScript property spelling. Runtime construction rejects collisions.
pub fn tool_identifier(name: &str) -> String {
    let name: String = name
        .chars()
        .enumerate()
        .map(|(index, c)| {
            if c == '_' || c == '$' || c.is_ascii_alphabetic() || (index > 0 && c.is_ascii_digit())
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() { "_".into() } else { name }
}
