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
//! Native request capabilities have no addressable ambient router.
use super::{
    Result, failed,
    json::{Json, JsonInput},
};
use deno_core::{JsRuntime, OpState, op2, v8};
use deno_error::JsErrorBox;
use futures_util::{FutureExt, future::BoxFuture};
use serde_json::Value;
use std::{
    cell::RefCell,
    panic::AssertUnwindSafe,
    rc::Rc,
    sync::{Arc, Weak},
};
use tokio::sync::Semaphore;

/// A trusted request adapter, never selected by a guest-provided identity.
/// Actual work and cleanup must belong to its native owner before returning
/// an observation future. The future must not retain this request's payloads.
/// Native failures must be recorded in that owner's cleanup facts; a guest
/// catching a rejection cannot acknowledge successful resource settlement.
/// Panics in preparation or observation are isolated as guest errors, without
/// acknowledging cleanup of the independently owned native work.
pub trait RequestBridge: Send + Sync + 'static {
    fn invoke(&self, input: Value) -> BoxFuture<'static, Result<Value>>;
}

pub(super) struct Owner {
    bridge: Arc<dyn RequestBridge>,
}
impl Owner {
    pub(super) fn new(bridge: Arc<dyn RequestBridge>) -> Self {
        Self { bridge }
    }
}

pub(super) struct Handle(Weak<Owner>);
impl Handle {
    pub(super) fn new(owner: &Arc<Owner>) -> Self {
        Self(Arc::downgrade(owner))
    }
}
// SAFETY: Handle contains only a Rust Weak; it holds no traced V8/cppgc values.
unsafe impl deno_core::GarbageCollected for Handle {
    fn trace(&self, _: &mut v8::cppgc::Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"MakaRequest"
    }
}

pub(super) struct Factory(pub v8::Global<v8::Function>);
struct Budget {
    bytes: Arc<Semaphore>,
}

#[op2]
async fn op_maka_request(
    state: Rc<RefCell<OpState>>,
    #[cppgc] handle: &Handle,
    #[scoped] input: JsonInput,
) -> std::result::Result<Json, JsErrorBox> {
    let owner = handle
        .0
        .upgrade()
        .ok_or_else(|| JsErrorBox::generic("request context expired"))?;
    let size = super::json::encoded_size(&input.0, usize::MAX)
        .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let _bytes = {
        let state = state.borrow();
        state
            .borrow::<Budget>()
            .bytes
            .clone()
            .try_acquire_many_owned(
                super::input_charge(size).map_err(|e| JsErrorBox::generic(e.to_string()))?,
            )
            .map_err(|_| JsErrorBox::generic("request operation input budget exhausted"))?
    };
    // The observer owns no ContextState. A saved Promise or native cppgc root
    // cannot prolong the original bridge/snapshot after callback completion.
    let observing = std::panic::catch_unwind(AssertUnwindSafe(|| owner.bridge.invoke(input.0)));
    drop(owner);
    let observing =
        observing.map_err(|_| JsErrorBox::generic("request bridge preparation panicked"))?;
    let output = AssertUnwindSafe(observing)
        .catch_unwind()
        .await
        .map_err(|_| JsErrorBox::generic("request observer panicked"))?
        .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    tokio::task::yield_now().await;
    Json::encode(&output)
}
deno_core::extension!(maka_requests, ops = [op_maka_request]);

pub(super) fn initialize(runtime: &mut JsRuntime) -> Result<()> {
    let factory = runtime
        .execute_script(
            "maka-request-factory",
            r#"
        ((invoke, freeze) => native => freeze({
            invoke: input => invoke(native, input)
        }))(Deno.core.ops.op_maka_request, Object.freeze)
    "#,
        )
        .map_err(failed)?;
    let factory = {
        deno_core::scope!(scope, runtime);
        let factory =
            v8::Local::<v8::Function>::try_from(v8::Local::new(scope, factory)).map_err(failed)?;
        v8::Global::new(scope, factory)
    };
    let state = runtime.op_state();
    let mut state = state.borrow_mut();
    state.put(Factory(factory));
    state.put(Budget {
        bytes: Arc::new(Semaphore::new(32 * 1024 * 1024)),
    });
    Ok(())
}
