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

mod bridge;
mod cell_context;
mod evaluate;
mod execution_budget;
mod module;
pub mod plugin;
mod result;
pub mod trusted;

use bridge::{Admission, ToolScope, maka_code};
pub use cell_context::{CellContext, CellOutput, CellStore, NotificationGate, ToolMetadata};
use deno_core::{JsRuntime, RuntimeOptions, v8};
use evaluate::evaluate;
use execution_budget::ExecutionBudget;
use maka_runtime::tools::ToolExecutor;
pub use result::{CellAbort, CellDiagnostic, CellDiagnosticKind, CellResult, ToolCall};
use result::{bounded, diagnostic_fits};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;
use tokio::runtime::Handle;
use tokio::sync::Semaphore;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Clone, Debug)]
pub struct CellLimits {
    /// Cumulative synchronous VM execution, excluding asynchronous Host tool waits.
    pub timeout: Duration,
    pub max_source_bytes: usize,
    /// Maximum serialized cell envelope, including diagnostics and call summaries.
    /// Also bounds individual tool inputs and outputs.
    pub max_value_bytes: usize,
    pub max_tool_calls: usize,
    pub max_in_flight_tools: usize,
    /// V8 heap limit only; not an OS memory limit or a process sandbox.
    pub heap_bytes: usize,
}

impl Default for CellLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            max_source_bytes: 64 * 1024,
            max_value_bytes: 1024 * 1024,
            max_tool_calls: 32,
            max_in_flight_tools: 8,
            heap_bytes: 64 * 1024 * 1024,
        }
    }
}

/// A bounded number of fresh isolates, off the host's async worker threads.
/// Permits remain held until admitted Rust tools have finished cleanup.
#[derive(Clone)]
pub struct CodeExecutor {
    permits: Arc<Semaphore>,
    limits: CellLimits,
}

impl CodeExecutor {
    pub fn new(max_cells: usize, limits: CellLimits) -> Result<Self, CellAbort> {
        if max_cells == 0
            || limits.timeout.is_zero()
            || limits.max_source_bytes == 0
            || !diagnostic_fits(&[], limits.max_value_bytes)
            || limits.max_tool_calls == 0
            || limits.max_in_flight_tools == 0
            || limits.heap_bytes < 8 * 1024 * 1024
        {
            return Err(CellAbort::Internal("invalid cell limits".into()));
        }
        initialize_platform();
        Ok(Self {
            permits: Arc::new(Semaphore::new(max_cells)),
            limits,
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
        let context = CellContext::new(CellStore::default(), self.limits.max_value_bytes, metadata);
        self.execute_with_context(source, tools, cancellation, context)
            .await
    }

    pub fn limits(&self) -> &CellLimits {
        &self.limits
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

    /// Model-facing Code Mode uses an async ES module, without a return value.
    pub async fn execute_module(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
    ) -> Result<CellResult, CellAbort> {
        self.execute_source(source, tools, cancellation, context, true)
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
        if cancellation.is_cancelled() {
            return Err(CellAbort::Cancelled);
        }
        if source.len() > self.limits.max_source_bytes {
            return Ok(bounded(
                Err(CellDiagnostic::limit("source bytes")),
                vec![],
                self.limits.max_value_bytes,
            ));
        }
        let cancellation = cancellation.child_token();
        // Dropping the caller's future cancels the worker; it does not detach
        // an unbounded execution or prematurely release the worker's permit.
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let permit = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(CellAbort::Cancelled),
            permit = self.permits.clone().acquire_owned() =>
                permit.map_err(|error| CellAbort::Internal(error.to_string()))?,
        };
        let handle = Handle::current();
        let limits = self.limits.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            // deno_core's unsynchronized op scheduler requires a current-thread
            // Tokio runtime. Host effects and watchdogs stay on the host runtime.
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| CellAbort::Internal(error.to_string()))?
                .block_on(run_cell(
                    source,
                    tools,
                    cancellation,
                    limits,
                    handle,
                    context,
                    module,
                ))
        })
        .await
        .map_err(|error| CellAbort::Internal(error.to_string()))?
    }
}

async fn run_cell(
    source: String,
    executor: Arc<dyn ToolExecutor>,
    cancellation: CancellationToken,
    limits: CellLimits,
    host: Handle,
    context: CellContext,
    module: bool,
) -> Result<CellResult, CellAbort> {
    if cancellation.is_cancelled() {
        return Err(CellAbort::Cancelled);
    }
    let names = executor.names();
    let scope = Arc::new(ToolScope {
        context: context.clone(),
        executor,
        names: names.iter().cloned().collect(),
        cancellation: cancellation.child_token(),
        tasks: TaskTracker::new(),
        host: host.clone(),
        limits: limits.clone(),
        admission: Mutex::new(Admission::default()),
        concurrency: Arc::new(Semaphore::new(limits.max_in_flight_tools)),
    });
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions: vec![maka_code::init()],
        create_params: Some(v8::CreateParams::default().heap_limits(0, limits.heap_bytes)),
        ..Default::default()
    })
    .map_err(|error| CellAbort::Internal(error.to_string()))?;
    runtime.op_state().borrow_mut().put(scope.clone());
    runtime.op_state().borrow_mut().put(context.clone());

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

    let result = match budget
        .run(evaluate(
            &mut runtime,
            &source,
            &names,
            limits.max_value_bytes,
            context.metadata(),
            module,
        ))
        .await
    {
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
        scope.cancellation.cancel();
    }
    // No more ops can enter once the runtime is destroyed.
    drop(runtime);
    scope.tasks.close();
    scope.tasks.wait().await;
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
    Ok(bounded(
        result,
        scope.admission.lock().unwrap().calls.clone(),
        limits.max_value_bytes,
    ))
}

#[derive(Clone, Copy)]
enum StopReason {
    Cancelled,
    ExecutionBudget,
    HeapLimit,
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
