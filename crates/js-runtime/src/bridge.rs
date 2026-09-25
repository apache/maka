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

use crate::result::diagnostic_fits;
use crate::{CellContext, CellDiagnostic, CellDiagnosticKind, CellLimits, CellOutput, ToolCall};
use deno_core::{OpState, op2};
use maka_runtime::tools::{ToolError, ToolExecutor};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::HashSet,
    future::Future,
    rc::Rc,
    sync::{Arc, Mutex},
};
use tokio::{
    runtime::Handle,
    sync::{Semaphore, oneshot},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Default)]
pub(crate) struct Admission {
    pub(crate) calls: Vec<ToolCall>,
}

pub(crate) struct ToolScope {
    pub(crate) context: CellContext,
    pub(crate) executor: Arc<dyn ToolExecutor>,
    pub(crate) names: HashSet<String>,
    pub(crate) cancellation: CancellationToken,
    pub(crate) tasks: TaskTracker,
    pub(crate) host: Handle,
    pub(crate) limits: CellLimits,
    pub(crate) admission: Mutex<Admission>,
    pub(crate) concurrency: Arc<Semaphore>,
}

impl ToolScope {
    fn start(
        self: &Arc<Self>,
        name: String,
        input: Value,
    ) -> Result<oneshot::Receiver<Result<Value, CellDiagnostic>>, CellDiagnostic> {
        if self.cancellation.is_cancelled() {
            return Err(CellDiagnostic::new(
                CellDiagnosticKind::ExecutionError,
                "cell cancelled",
            ));
        }
        if !self.names.contains(&name) {
            return Err(CellDiagnostic::new(
                CellDiagnosticKind::UnknownTool,
                format!("unknown tool: {name}"),
            ));
        }
        if serde_json::to_vec(&input)
            .map_err(|e| CellDiagnostic::new(CellDiagnosticKind::ExecutionError, e.to_string()))?
            .len()
            > self.limits.max_value_bytes
        {
            return Err(CellDiagnostic::limit("tool input byte limit exceeded"));
        }
        {
            let mut admission = self.admission.lock().unwrap();
            if self.cancellation.is_cancelled() {
                return Err(CellDiagnostic::new(
                    CellDiagnosticKind::ExecutionError,
                    "cell cancelled",
                ));
            }
            if admission.calls.len() >= self.limits.max_tool_calls {
                return Err(CellDiagnostic::limit("tool admission limit exceeded"));
            }
            let index = admission.calls.len() + 1;
            let mut reserved = admission.calls.clone();
            reserved.push(ToolCall {
                index,
                name: name.clone(),
            });
            if !diagnostic_fits(&reserved, self.limits.max_value_bytes) {
                return Err(CellDiagnostic::limit("tool summary byte limit exceeded"));
            }
            admission.calls = reserved;
        }
        let (sender, receiver) = oneshot::channel();
        let scope = self.clone();
        self.tasks.spawn_on(
            async move {
                use deno_core::futures::FutureExt;
                let result = std::panic::AssertUnwindSafe(async {
                    let _permit = tokio::select! {
                        biased;
                        _ = scope.cancellation.cancelled() => return Err(ToolError::Failed("cell cancelled before tool dispatch".into())),
                        permit = scope.concurrency.acquire() => permit.expect("cell semaphore stays open"),
                    };
                    scope
                        .executor
                        .invoke(name, input, scope.cancellation.clone())
                        .await
                })
                .catch_unwind()
                .await;
                let result = result.unwrap_or_else(|_| {
                    Err(ToolError::CleanupUnconfirmed(
                        "tool executor panicked".into(),
                    ))
                });
                if let Err(error @ (ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))) =
                    &result
                {
                    scope.cancellation.cancel();
                    scope.context.fail(error.clone());
                }
                // The effect is settled even if JS no longer observes its promise.
                let result = result
                    .map_err(|error| {
                        CellDiagnostic::new(CellDiagnosticKind::ToolFailure, error.to_string())
                    })
                    .and_then(|value| {
                        if serde_json::to_vec(&value).unwrap().len() > scope.limits.max_value_bytes
                        {
                            Err(CellDiagnostic::limit("tool output byte limit exceeded"))
                        } else {
                            Ok(value)
                        }
                    });
                let _ = sender.send(result);
            },
            &self.host,
        );
        Ok(receiver)
    }
}

// Synchronous admission before returning the future is intentional: even an
// unawaited JS call immediately becomes tracked host work.
#[op2]
#[serde]
fn op_maka_tool(
    state: Rc<RefCell<OpState>>,
    #[string] name: String,
    #[serde] input: serde_json::Value,
) -> impl Future<Output = serde_json::Value> {
    let scope = state.borrow().borrow::<Arc<ToolScope>>().clone();
    let receiver = scope.start(name, input);
    async move {
        let result = match receiver {
            Ok(receiver) => receiver.await.unwrap_or_else(|_| {
                Err(CellDiagnostic::new(
                    CellDiagnosticKind::ExecutionError,
                    "tool outcome unavailable",
                ))
            }),
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => serde_json::json!({"ok": true, "value": value}),
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        }
    }
}

#[op2]
#[serde]
fn op_maka_emit(state: &mut OpState, #[serde] output: CellOutput) -> Option<CellDiagnostic> {
    state.borrow::<CellContext>().emit(output).err()
}

#[op2]
#[serde]
fn op_maka_notify(state: &mut OpState, #[string] text: String) -> Option<CellDiagnostic> {
    state.borrow::<CellContext>().notify(text).err()
}

#[op2(fast)]
fn op_maka_yield(state: &mut OpState) {
    state.borrow::<CellContext>().yield_output();
}

#[op2]
#[serde]
fn op_maka_store(
    state: &mut OpState,
    #[string] key: String,
    #[serde] value: serde_json::Value,
) -> Option<CellDiagnostic> {
    state.borrow::<CellContext>().store(key, value).err()
}

#[op2]
#[serde]
fn op_maka_load(state: &mut OpState, #[string] key: String) -> serde_json::Value {
    match state.borrow::<CellContext>().load(&key) {
        Some(value) => serde_json::json!({"found":true,"value":value}),
        None => serde_json::json!({"found":false}),
    }
}

#[op2]
async fn op_maka_sleep(#[number] millis: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(millis.min(86_400_000))).await;
}

#[derive(Default)]
struct Timers(std::collections::BTreeMap<u32, CancellationToken>);

#[op2]
fn op_maka_timer(
    state: Rc<RefCell<OpState>>,
    id: u32,
    #[number] millis: u64,
) -> impl Future<Output = bool> {
    let cancellation = CancellationToken::new();
    {
        let mut state = state.borrow_mut();
        if !state.has::<Timers>() {
            state.put(Timers::default());
        }
        state
            .borrow_mut::<Timers>()
            .0
            .insert(id, cancellation.clone());
    }
    async move {
        let fired = tokio::select! {
            biased;
            _ = cancellation.cancelled() => false,
            _ = tokio::time::sleep(std::time::Duration::from_millis(millis)) => true,
        };
        state.borrow_mut().borrow_mut::<Timers>().0.remove(&id);
        fired
    }
}

#[op2(fast)]
fn op_maka_clear_timer(state: &mut OpState, id: u32) {
    if let Some(timers) = state.try_borrow_mut::<Timers>()
        && let Some(timer) = timers.0.remove(&id)
    {
        timer.cancel();
    }
}

deno_core::extension!(
    maka_code,
    ops = [
        op_maka_tool,
        op_maka_emit,
        op_maka_notify,
        op_maka_yield,
        op_maka_store,
        op_maka_load,
        op_maka_sleep,
        op_maka_timer,
        op_maka_clear_timer
    ]
);
