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
use super::{Bootstrap, Health, Limits, Result, failed};
use deno_core::{JsRuntime, RuntimeOptions, v8};
use futures_util::future::LocalBoxFuture;
use serde_json::Value;
use std::sync::Arc;

pub(super) struct Module(pub v8::Global<v8::Object>);
struct Sdk {
    plugin: v8::Global<v8::Function>,
    presenter: v8::Global<v8::Function>,
    terminal: v8::Global<v8::Object>,
}
pub(super) type Call = LocalBoxFuture<'static, Result<v8::Global<v8::Value>>>;

pub(super) fn runtime(health: &Arc<Health>, limits: &Limits) -> Result<JsRuntime> {
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions: vec![
            deno_webidl::deno_webidl::init(),
            deno_web::deno_web::init(
                Arc::new(deno_web::BlobStore::default()),
                None,
                false,
                Default::default(),
            ),
            super::bridge::maka_plugins::init(),
        ],
        create_params: Some(v8::CreateParams::default().heap_limits(0, limits.heap_bytes)),
        ..Default::default()
    })
    .map_err(failed)?;
    runtime
        .op_state()
        .borrow_mut()
        .put(super::bridge::Bindings::default());
    let _ = health
        .isolate
        .set(runtime.v8_isolate().thread_safe_handle());
    let watch = health.clone();
    runtime.add_near_heap_limit_callback(move |current, _| {
        watch.fail(failed("heap budget exceeded"));
        current.saturating_add(16 * 1024 * 1024)
    });
    // Pure codec/URL APIs reuse the existing Deno dependency. Do not install
    // ambient fetch, timers or processes: system work goes through owned SDK calls.
    runtime
        .execute_script(
            "maka-plugin-globals",
            r#"for (const [path, names] of [
                ['ext:deno_web/08_text_encoding.js', ['TextEncoder', 'TextDecoder']],
                ['ext:deno_web/00_url.js', ['URL', 'URLSearchParams']],
            ]) {
                const exports = Deno.core.loadExtScript(path);
                for (const name of names) Object.defineProperty(globalThis, name, {
                    value: exports[name], configurable: true, writable: true,
                });
            }"#,
        )
        .map_err(failed)?;
    let terminal = runtime
        .execute_script(
            "maka-terminal-builders",
            include_str!("terminal-builders.js"),
        )
        .map_err(failed)?;
    let terminal = {
        deno_core::scope!(scope, runtime);
        let terminal =
            v8::Local::<v8::Object>::try_from(v8::Local::new(scope, terminal)).map_err(failed)?;
        v8::Global::new(scope, terminal)
    };
    let sdk = runtime
        .execute_script("maka-plugin-sdk", include_str!("sdk.js"))
        .map_err(failed)?;
    let plugin = {
        deno_core::scope!(scope, runtime);
        let sdk =
            v8::Local::<v8::Function>::try_from(v8::Local::new(scope, sdk)).map_err(failed)?;
        v8::Global::new(scope, sdk)
    };
    let presenter = runtime
        .execute_script("maka-terminal-presenter", include_str!("presenter.js"))
        .map_err(failed)?;
    let presenter = {
        deno_core::scope!(scope, runtime);
        let presenter = v8::Local::<v8::Function>::try_from(v8::Local::new(scope, presenter))
            .map_err(failed)?;
        v8::Global::new(scope, presenter)
    };
    runtime.op_state().borrow_mut().put(Sdk {
        plugin,
        presenter,
        terminal,
    });
    Ok(runtime)
}

pub(super) fn load(
    runtime: &mut JsRuntime,
    name: &str,
    source: &str,
    bootstrap: Bootstrap,
    id: u64,
) -> Result<Module> {
    let sdk = {
        let state = runtime.op_state();
        let state = state.borrow();
        let sdk = state.borrow::<Sdk>();
        match bootstrap {
            Bootstrap::Plain => None,
            Bootstrap::Plugin => Some((sdk.plugin.clone(), sdk.terminal.clone())),
            Bootstrap::Presenter => Some((sdk.presenter.clone(), sdk.terminal.clone())),
        }
    };
    deno_core::scope!(scope, runtime);
    v8::tc_scope!(scope, scope);
    let resource =
        v8::String::new(scope, name).ok_or_else(|| failed("module name allocation failed"))?;
    let origin = v8::ScriptOrigin::new(
        scope,
        resource.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        true,
        None,
    );
    let text =
        v8::String::new(scope, source).ok_or_else(|| failed("module source allocation failed"))?;
    let mut source = v8::script_compiler::Source::new(text, Some(&origin));
    let Some(module) = v8::script_compiler::compile_module(scope, &mut source) else {
        return Err(failed(
            scope
                .exception()
                .map(|value| value.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "module compilation terminated".into()),
        ));
    };
    if module.get_module_requests().length() != 0 {
        return Err(failed(
            "plugin entrypoints must be prebuilt bundles without imports",
        ));
    }
    if module.instantiate_module(scope, no_imports) != Some(true) {
        return Err(failed(
            scope
                .exception()
                .map(|value| value.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "module instantiation failed".into()),
        ));
    }
    if module.is_graph_async() {
        return Err(failed(
            "top-level await is unsupported; initialize asynchronously in activation",
        ));
    }
    let Some(result) = module.evaluate(scope) else {
        return Err(failed(
            scope
                .exception()
                .map(|value| value.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "module evaluation terminated".into()),
        ));
    };
    let promise = v8::Local::<v8::Promise>::try_from(result).map_err(failed)?;
    promise.mark_as_handled();
    if promise.state() == v8::PromiseState::Rejected {
        return Err(failed(promise.result(scope).to_rust_string_lossy(scope)));
    }
    let mut namespace =
        v8::Local::<v8::Object>::try_from(module.get_module_namespace()).map_err(failed)?;
    if let Some((sdk, terminal)) = sdk {
        let sdk = v8::Local::new(scope, sdk);
        let terminal = v8::Local::new(scope, terminal);
        let key = v8::String::new(scope, &id.to_string())
            .ok_or_else(|| failed("SDK identity allocation failed"))?;
        let undefined = v8::undefined(scope).into();
        let value = sdk
            .call(
                scope,
                undefined,
                &[namespace.into(), key.into(), terminal.into()],
            )
            .ok_or_else(|| {
                failed(
                    scope
                        .exception()
                        .map(|value| value.to_rust_string_lossy(scope))
                        .unwrap_or_else(|| "SDK initialization terminated".into()),
                )
            })?;
        namespace = v8::Local::<v8::Object>::try_from(value).map_err(failed)?;
    }
    Ok(Module(v8::Global::new(scope, namespace)))
}

fn no_imports<'s>(
    _: v8::Local<'s, v8::Context>,
    _: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
    _: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    None
}

pub(super) fn call(
    runtime: &mut JsRuntime,
    module: &Module,
    path: &[String],
    args: &[Value],
) -> Result<Call> {
    let value = {
        deno_core::scope!(scope, runtime);
        v8::tc_scope!(scope, scope);
        let mut object = v8::Local::new(scope, &module.0);
        for part in &path[..path.len() - 1] {
            let key = v8::String::new(scope, part)
                .ok_or_else(|| failed("export name allocation failed"))?;
            let value = object
                .get(scope, key.into())
                .ok_or_else(|| failed("export lookup failed"))?;
            object = v8::Local::<v8::Object>::try_from(value).map_err(failed)?;
        }
        let key = v8::String::new(scope, path.last().unwrap())
            .ok_or_else(|| failed("export name allocation failed"))?;
        let function = object
            .get(scope, key.into())
            .ok_or_else(|| failed("export lookup failed"))?;
        let function = v8::Local::<v8::Function>::try_from(function)
            .map_err(|_| failed("export is not callable"))?;
        let args = args
            .iter()
            .map(|value| deno_core::serde_v8::to_v8(scope, value).map_err(failed))
            .collect::<Result<Vec<_>>>()?;
        let Some(value) = function.call(scope, object.into(), &args) else {
            return Err(failed(
                scope
                    .exception()
                    .map(|value| value.to_rust_string_lossy(scope))
                    .unwrap_or_else(|| "plugin call terminated".into()),
            ));
        };
        v8::Global::new(scope, value)
    };
    let resolving = runtime.resolve(value);
    Ok(Box::pin(async move { resolving.await.map_err(failed) }))
}

pub(super) fn value(runtime: &mut JsRuntime, value: v8::Global<v8::Value>) -> Result<Value> {
    deno_core::scope!(scope, runtime);
    let value = v8::Local::new(scope, value);
    let mut value: Value = if value.is_undefined() {
        Value::Null
    } else {
        deno_core::serde_v8::from_v8(scope, value).map_err(failed)?
    };
    json_integers(&mut value);
    if serde_json::to_vec(&value).map_err(failed)?.len() > 1024 * 1024 {
        return Err(failed("plugin result exceeds 1 MiB"));
    }
    Ok(value)
}

/// JavaScript has one Number type. serde_v8 represents larger integers as
/// f64, while typed Remote results expect JSON integers (timestamps, counts).
/// Match Number.isSafeInteger without rounding fractional or imprecise values.
fn json_integers(value: &mut Value) {
    match value {
        Value::Number(number) if number.is_f64() => {
            if let Some(integer) = number.as_f64().filter(|value| {
                value.is_finite() && value.abs() <= 9_007_199_254_740_991.0 && value.fract() == 0.0
            }) {
                *number = serde_json::Number::from(integer as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(json_integers),
        Value::Object(items) => items.values_mut().for_each(json_integers),
        _ => {}
    }
}
