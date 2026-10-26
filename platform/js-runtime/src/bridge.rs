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

use crate::json::Json;
use crate::{CellContext, CellDiagnostic, CellDiagnosticKind, CellOutput};
use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use maka_code_runtime::ToolScope;
use std::{cell::RefCell, future::Future, rc::Rc, sync::Arc};
use tokio_util::sync::CancellationToken;

// Synchronous admission before returning the future is intentional: even an
// unawaited JS call immediately becomes tracked host work.
#[op2]
fn op_maka_tool(
    state: Rc<RefCell<OpState>>,
    #[string] name: String,
    #[serde] input: serde_json::Value,
) -> impl Future<Output = Result<Json, JsErrorBox>> {
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
        let outcome = match result {
            Ok(value) => serde_json::json!({"ok": true, "value": value}),
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        };
        Json::encode(&outcome)
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
fn op_maka_load(state: &mut OpState, #[string] key: String) -> Result<Json, JsErrorBox> {
    let outcome = match state.borrow::<CellContext>().load(&key) {
        Ok(Some(value)) => serde_json::json!({"found":true,"value":value}),
        Ok(None) => serde_json::json!({"found":false}),
        Err(error) => serde_json::json!({"error":error}),
    };
    Json::encode(&outcome)
}

#[op2]
async fn op_maka_sleep(#[number] millis: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
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
