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

//! An isolated, persistent JavaScript REPL. This is independent of Code Mode:
//! no modules, Node, network inspector, filesystem or trusted plugin powers.
//! The caller owns its lifetime and supplies fresh authority for each evaluation.

use crate::{
    CellAbort, CellContext, CellDiagnostic, CellDiagnosticKind, CellLimits, CellResult,
    bridge::maka_code,
};
use deno_core::{
    InspectorMsg, InspectorMsgKind, InspectorSessionKind, JsRuntime, JsRuntimeInspector,
    RuntimeOptions, v8,
};
use maka_agent_facts::tools::ToolExecutor;
use maka_code_runtime::{ToolScope, complete};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::{
    runtime::Handle,
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

pub struct Repl {
    sender: mpsc::Sender<Evaluation>,
    stopped: CancellationToken,
    worker: oneshot::Receiver<Result<(), CellAbort>>,
}

/// A trusted Host admission fence for the native effects caused by one VM.
/// Sealing must reject new effects and wait until every previously registered
/// effect has either durable execution custody or a confirmed no-effect refusal.
/// It does not wait for admitted native effects to finish.
pub trait ReplAdmission: Send + Sync {
    fn seal(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), maka_agent_facts::tools::ToolError>> + Send + '_>>;
}

struct Evaluation {
    source: String,
    executor: Arc<dyn ToolExecutor>,
    cancellation: CancellationToken,
    context: CellContext,
    timeout: std::time::Duration,
    reply: oneshot::Sender<Result<CellResult, CellAbort>>,
}

impl Repl {
    pub fn is_closed(&self) -> bool {
        self.stopped.is_cancelled() || self.sender.is_closed()
    }

    /// `bootstrap` is trusted facade source, evaluated once. It can capture the
    /// two bridge functions `call(name, input)` and `emit(CellOutput)`; these
    /// are not globals and contain no persistent invocation authority.
    ///
    /// # Errors
    /// Returns an error if the dedicated worker thread cannot be started.
    pub fn new(bootstrap: impl Into<String>, limits: CellLimits) -> Result<Self, CellAbort> {
        Self::spawn(bootstrap.into(), limits, None)
    }

    /// Return an interrupted VM's result after the Host confirms admission
    /// custody. The Host must retain this REPL and join `close()` to observe
    /// actual effect settlement and any late persistence or cleanup failure.
    ///
    /// # Errors
    /// Returns an error if the dedicated worker thread cannot be started.
    pub fn new_observed(
        bootstrap: impl Into<String>,
        limits: CellLimits,
        admission: Arc<dyn ReplAdmission>,
    ) -> Result<Self, CellAbort> {
        Self::spawn(bootstrap.into(), limits, Some(admission))
    }

    fn spawn(
        bootstrap: String,
        limits: CellLimits,
        admission: Option<Arc<dyn ReplAdmission>>,
    ) -> Result<Self, CellAbort> {
        crate::initialize_platform();
        let (sender, receiver) = mpsc::channel(1);
        let stopped = CancellationToken::new();
        let stop = stopped.clone();
        let host = Handle::current();
        let (finished, worker) = oneshot::channel();
        // Persistent isolates must not occupy the pool used by their Host tools.
        std::thread::Builder::new()
            .name("maka-repl-js".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|e| CellAbort::Internal(e.to_string()))?
                        .block_on(serve(bootstrap, limits, receiver, stop, host, admission))
                }))
                .unwrap_or_else(|_| Err(CellAbort::Internal("REPL worker panicked".into())));
                let _ = finished.send(result);
            })
            .map_err(|error| CellAbort::Internal(format!("cannot start REPL worker: {error}")))?;
        Ok(Self {
            sender,
            stopped,
            worker,
        })
    }

    pub async fn evaluate(
        &self,
        source: String,
        executor: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
        timeout: std::time::Duration,
    ) -> Result<CellResult, CellAbort> {
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let (reply, receive) = oneshot::channel();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(CellAbort::Cancelled),
            _ = self.stopped.cancelled() => return Err(closed()),
            result = self.sender.send(Evaluation { source, executor, cancellation: cancellation.clone(), context, timeout, reply }) => {
                result.map_err(|_| closed())?;
            }
        }
        // Do not race cancellation against settlement of an admitted evaluation.
        receive.await.map_err(|_| closed())?
    }

    pub async fn close(self) -> Result<(), CellAbort> {
        self.stopped.cancel();
        self.worker
            .await
            .map_err(|e| CellAbort::Internal(e.to_string()))?
    }
}

fn closed() -> CellAbort {
    CellAbort::Internal("REPL is closed; reset it before evaluating more code".into())
}

async fn serve(
    bootstrap: String,
    limits: CellLimits,
    mut receiver: mpsc::Receiver<Evaluation>,
    stopped: CancellationToken,
    host: Handle,
    admission: Option<Arc<dyn ReplAdmission>>,
) -> Result<(), CellAbort> {
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        inspector: true,
        extensions: vec![maka_code::init()],
        create_params: Some(v8::CreateParams::default().heap_limits(0, limits.heap_bytes)),
        ..Default::default()
    })
    .map_err(|e| CellAbort::Internal(e.to_string()))?;
    runtime.execute_script("maka:repl/bootstrap", format!(r#"(() => {{
        const call = Deno.core.ops.op_maka_tool;
        const emit = Deno.core.ops.op_maka_emit;
        for (const name of ["Deno", "console", "Atomics", "SharedArrayBuffer", "WebAssembly", "__bootstrap"])
            delete globalThis[name];
        {bootstrap}
    }})()"#)).map_err(|e| CellAbort::Internal(e.to_string()))?;

    let isolate = runtime.v8_isolate().thread_safe_handle();
    let heap_exhausted = CancellationToken::new();
    let heap_stop = heap_exhausted.clone();
    let heap_isolate = isolate.clone();
    runtime.add_near_heap_limit_callback(move |current, _| {
        heap_stop.cancel();
        heap_isolate.terminate_execution();
        current.saturating_add(16 * 1024 * 1024)
    });
    let (replies, mut responses) = mpsc::unbounded_channel();
    let mut inspector = JsRuntimeInspector::create_local_session(
        runtime.inspector(),
        Box::new(move |msg: InspectorMsg| {
            if let InspectorMsgKind::Message(_) = msg.kind {
                let _ = replies.send(msg.content);
            }
        }),
        InspectorSessionKind::NonBlocking {
            wait_for_disconnect: false,
        },
    );
    let mut sequence = 0;
    loop {
        let request = tokio::select! {
            biased;
            _ = stopped.cancelled() => break,
            request = receiver.recv() => match request { Some(request) => request, None => break },
        };
        if request.cancellation.is_cancelled() {
            let _ = request.reply.send(Err(CellAbort::Cancelled));
            continue;
        }
        if request.timeout.is_zero()
            || std::time::Instant::now()
                .checked_add(request.timeout)
                .is_none()
        {
            let _ = request.reply.send(Ok(complete(
                Err(CellDiagnostic::limit("invalid REPL timeout")),
                vec![],
            )));
            continue;
        }
        let scope = ToolScope::new(
            request.context.clone(),
            request.executor,
            request.cancellation.child_token(),
            host.clone(),
        );
        runtime.op_state().borrow_mut().put(scope.clone());
        runtime.op_state().borrow_mut().put(request.context.clone());

        let finished = CancellationToken::new();
        let finish = finished.clone();
        let cancellation = request.cancellation.clone();
        let stop = stopped.clone();
        let terminate = isolate.clone();
        let interrupted = CancellationToken::new();
        let interrupt = interrupted.clone();
        let budget = request.context.timeout_budget(request.timeout);
        let timeout = budget.clone();
        let monitor = host.spawn(async move {
            tokio::select! {
                biased;
                _ = finish.cancelled() => return,
                _ = cancellation.cancelled() => {},
                _ = stop.cancelled() => {},
                _ = timeout.expired() => {},
            }
            interrupt.cancel();
            terminate.terminate_execution();
        });
        sequence += 1;
        // Local inspector transport gives real REPL lexical bindings and await;
        // there is deliberately no inspector socket or arbitrary CDP endpoint.
        {
            let _execution = request.context.enter_execution();
            inspector.post_message(
                sequence,
                "Runtime.evaluate",
                Some(json!({
                    "expression":request.source,
                    "replMode":true, "awaitPromise":true, "returnByValue":false,
                    "objectGroup":"maka-repl-result"
                })),
            );
        }
        let mut completed = false;
        let interrupted_message = if admission.is_some() {
            "REPL interrupted"
        } else {
            "REPL interrupted; reset required"
        };
        let result = tokio::select! {
            biased;
            _ = interrupted.cancelled() => Err(CellDiagnostic::limit(interrupted_message)),
            _ = heap_exhausted.cancelled() => Err(CellDiagnostic::limit(if admission.is_some() { "JavaScript heap" } else { "JavaScript heap; reset required" })),
            result = async {
                let mut event_loop = std::pin::pin!(runtime.run_event_loop(Default::default()));
                std::future::poll_fn(|cx| {
                    let _execution = request.context.enter_execution();
                    event_loop.as_mut().poll(cx)
                }).await
                    .map_err(|e| CellDiagnostic::new(CellDiagnosticKind::ExecutionError, e.to_string()))?;
                let response = responses.recv().await.ok_or_else(|| CellDiagnostic::new(CellDiagnosticKind::ExecutionError, "inspector closed"))?;
                let value: Value = serde_json::from_str(&response)
                    .map_err(|e| CellDiagnostic::new(CellDiagnosticKind::ExecutionError, e.to_string()))?;
                if let Some(error) = value.get("error") {
                    return Err(CellDiagnostic::new(CellDiagnosticKind::ExecutionError,
                        error["message"].as_str().unwrap_or("inspector evaluation failed")));
                }
                let result = value.get("result").filter(|result| result.is_object())
                    .ok_or_else(|| CellDiagnostic::new(CellDiagnosticKind::ExecutionError, "inspector response missing result"))?;
                // A regular JavaScript exception still completed the evaluation.
                completed = true;
                if let Some(error) = result.get("exceptionDetails") {
                    let message = error["exception"]["description"].as_str()
                        .or_else(|| error["text"].as_str()).or_else(|| error["message"].as_str())
                        .unwrap_or("JavaScript execution failed");
                    Err(CellDiagnostic::new(CellDiagnosticKind::ExecutionError, message))
                } else { Ok(Value::Null) }
            } => result,
        };
        let result = if budget.is_expired() {
            interrupted.cancel();
            Err(CellDiagnostic::limit(interrupted_message))
        } else {
            result
        };
        // This closes the VM producer, including queued operations that have
        // not obtained Host execution custody. Accepted effects retain the
        // Host's original Run cancellation source and their exact futures.
        scope.cancel();
        finished.cancel();
        monitor
            .await
            .map_err(|e| CellAbort::Internal(e.to_string()))?;
        // The watchdog may have committed termination concurrently with the
        // completion response. Read its final state after joining it.
        let poisoned = !completed || interrupted.is_cancelled() || heap_exhausted.is_cancelled();
        let owner_stopped = stopped.is_cancelled();
        if poisoned {
            stopped.cancel();
            receiver.close();
            while let Ok(queued) = receiver.try_recv() {
                let _ = queued.reply.send(Err(closed()));
            }
        }
        if poisoned && let Some(admission) = &admission {
            match admission.seal().await {
                Ok(()) => {
                    let observed = if let Some(error) = request.context.failure() {
                        Err(CellAbort::Tool(error))
                    } else if request.cancellation.is_cancelled() || owner_stopped {
                        Err(CellAbort::Cancelled)
                    } else {
                        Ok(complete(result, scope.calls()))
                    };
                    let _ = request.reply.send(observed);
                    // Keep polling the same original effects after the VM
                    // observer has returned. The retained owner joins us.
                    scope.settle().await;
                    if let Some(error) = request.context.failure() {
                        return Err(CellAbort::Tool(error));
                    }
                    return Ok(());
                }
                Err(error) => request.context.fail(error),
            }
        }
        // Ordinary REPL users and failed admission fences still drain before
        // publication. Failure to establish custody cannot authorize detachment.
        scope.settle().await;
        let result = if let Some(error) = request.context.failure() {
            Err(CellAbort::Tool(error))
        } else if request.cancellation.is_cancelled() || owner_stopped {
            Err(CellAbort::Cancelled)
        } else {
            Ok(complete(result, scope.calls()))
        };
        // Publish terminal state before waking the observer. The Session still
        // owns and joins this worker on reset/close, but it cannot be reused.
        let _ = request.reply.send(result);
        if poisoned {
            break;
        }
        // Release inspector's completion-value references, not user bindings.
        inspector.post_message(
            0,
            "Runtime.releaseObjectGroup",
            Some(json!({"objectGroup":"maka-repl-result"})),
        );
        let _ = responses.recv().await;
        runtime.op_state().borrow_mut().take::<Arc<ToolScope>>();
        runtime.op_state().borrow_mut().take::<CellContext>();
    }
    Ok(())
}
