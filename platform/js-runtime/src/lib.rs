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
mod evaluate;
mod execution_budget;
mod module;
pub mod plugin;
pub mod repl;

use bridge::maka_code;
use deno_core::{JsRuntime, RuntimeOptions, v8};
use evaluate::evaluate;
use execution_budget::ExecutionBudget;
use maka_agent_facts::tools::ToolExecutor;
use maka_code_runtime::complete;
use maka_code_runtime::{CellAbort, CellDiagnostic, CellDiagnosticKind, CellResult};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellStore, ToolMetadata, ToolScope};
use std::sync::{Arc, Mutex, Once};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

/// Fresh isolates off the host's async worker threads, each retaining ownership
/// of admitted Rust tools until they have finished cleanup.
#[derive(Clone)]
pub struct CodeExecutor {
    limits: CellLimits,
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
        Ok(Self { limits })
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
        let cancellation = cancellation.child_token();
        // Dropping the caller's future cancels the worker; it does not detach
        // execution without cleanup.
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let handle = Handle::current();
        let limits = self.limits.clone();
        let (reply, result) = tokio::sync::oneshot::channel();
        // A cell can await another cell through a Host tool. Holding a shared
        // blocking-pool worker across that wait can starve its own child, so
        // each independent isolate owns its thread through physical cleanup.
        std::thread::Builder::new()
            .name("maka-code-js".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // deno_core's unsynchronized op scheduler requires a
                    // current-thread runtime. Host effects stay on the host.
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
                }))
                .unwrap_or_else(|_| Err(CellAbort::Internal("cell worker panicked".into())));
                let _ = reply.send(result);
            })
            .map_err(|error| CellAbort::Internal(format!("cannot start cell worker: {error}")))?;
        result
            .await
            .map_err(|_| CellAbort::Internal("cell worker ended without a reply".into()))?
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
    let scope = ToolScope::new(
        context.clone(),
        executor,
        cancellation.child_token(),
        host.clone(),
    );
    initialize_platform();
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
