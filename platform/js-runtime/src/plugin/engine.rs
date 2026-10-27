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
use super::{Health, Limits, Result, failed};
use deno_core::{JsRuntime, RuntimeOptions, v8};
use futures_util::future::LocalBoxFuture;
use serde_json::Value;
use std::sync::Arc;

#[path = "embedded.rs"]
mod embedded;

pub(super) struct Module(pub v8::Global<v8::Object>);
pub(super) struct Callbacks {
    receiver: v8::Global<v8::Object>,
    functions: std::collections::BTreeMap<String, v8::Global<v8::Function>>,
}
pub(super) type Call = LocalBoxFuture<'static, Result<v8::Global<v8::Value>>>;

fn runtime_base(health: &Arc<Health>, limits: &Limits, realm: super::Realm) -> Result<JsRuntime> {
    let mut extensions = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            Default::default(),
        ),
    ];
    embedded::embed(&mut extensions)?;
    if realm == super::Realm::Scoped {
        extensions.push(super::request::maka_requests::init());
    }
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions,
        create_params: Some(v8::CreateParams::default().heap_limits(0, limits.heap_bytes)),
        ..Default::default()
    })
    .map_err(failed)?;
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
            r#"const { DOMException } = Deno.core.loadExtScript('ext:deno_web/01_dom_exception.js');
            Deno.core.registerErrorBuilder('DOMExceptionInvalidCharacterError',
                message => new DOMException(message, 'InvalidCharacterError'));
            for (const [path, names] of [
                ['ext:deno_web/08_text_encoding.js', ['TextEncoder', 'TextDecoder']],
                ['ext:deno_web/05_base64.js', ['atob']],
                ['ext:deno_web/00_url.js', ['URL', 'URLSearchParams']],
            ]) {
                const exports = Deno.core.loadExtScript(path);
                for (const name of names) Object.defineProperty(globalThis, name, {
                    value: exports[name], configurable: true, writable: true,
                });
            }"#,
        )
        .map_err(failed)?;
    Ok(runtime)
}

pub(super) fn pure_runtime(health: &Arc<Health>, limits: &Limits) -> Result<JsRuntime> {
    let mut runtime = runtime_base(health, limits, super::Realm::Pure)?;
    runtime
        .execute_script(
            "maka-pure-globals",
            "delete globalThis.Deno; delete globalThis.__bootstrap; delete globalThis.console;",
        )
        .map_err(failed)?;
    Ok(runtime)
}

pub(super) fn scoped_runtime(health: &Arc<Health>, limits: &Limits) -> Result<JsRuntime> {
    let mut runtime = runtime_base(health, limits, super::Realm::Scoped)?;
    super::request::initialize(&mut runtime)?;
    runtime
        .execute_script(
            "maka-scoped-globals",
            "delete globalThis.Deno; delete globalThis.__bootstrap; delete globalThis.console;",
        )
        .map_err(failed)?;
    Ok(runtime)
}

pub(super) fn load(runtime: &mut JsRuntime, name: &str, source: &str) -> Result<Module> {
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
    let namespace =
        v8::Local::<v8::Object>::try_from(module.get_module_namespace()).map_err(failed)?;
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
    let value = invoke(runtime, module, path, args)?;
    let resolving = runtime.resolve(value);
    Ok(Box::pin(async move { resolving.await.map_err(failed) }))
}

fn invoke(
    runtime: &mut JsRuntime,
    module: &Module,
    path: &[String],
    args: &[Value],
) -> Result<v8::Global<v8::Value>> {
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
            .map(|value| super::json::to_v8(scope, value).map_err(failed))
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
    Ok(value)
}

/// Capture an actual receiver and all required functions before publishing a
/// registration. Property getters/proxies execute here under the caller's budget;
/// later mutation of the namespace never redirects an existing registration.
pub(super) fn capture_callbacks(
    runtime: &mut JsRuntime,
    module: &Module,
    namespace: &[String],
    methods: &[&str],
) -> Result<Callbacks> {
    deno_core::scope!(scope, runtime);
    v8::tc_scope!(scope, scope);
    let mut receiver = v8::Local::new(scope, &module.0);
    for part in namespace {
        let key =
            v8::String::new(scope, part).ok_or_else(|| failed("export name allocation failed"))?;
        let value = receiver
            .get(scope, key.into())
            .ok_or_else(|| failed("component lookup failed"))?;
        receiver = v8::Local::<v8::Object>::try_from(value).map_err(failed)?;
    }
    let mut functions = std::collections::BTreeMap::new();
    for method in methods {
        let key = v8::String::new(scope, method)
            .ok_or_else(|| failed("export name allocation failed"))?;
        let value = receiver
            .get(scope, key.into())
            .ok_or_else(|| failed("component callback lookup failed"))?;
        let function = v8::Local::<v8::Function>::try_from(value)
            .map_err(|_| failed(format!("component callback is not callable: {method}")))?;
        functions.insert((*method).into(), v8::Global::new(scope, function));
    }
    Ok(Callbacks {
        receiver: v8::Global::new(scope, receiver),
        functions,
    })
}

pub(super) fn call_bound(
    runtime: &mut JsRuntime,
    callbacks: &Callbacks,
    method: &str,
    args: &[Value],
    context: Option<&Arc<super::request::Owner>>,
) -> Result<Call> {
    let value = invoke_bound(runtime, callbacks, method, args, context)?;
    let resolving = runtime.resolve(value);
    Ok(Box::pin(async move { resolving.await.map_err(failed) }))
}

fn invoke_bound<'a>(
    runtime: &mut JsRuntime,
    callbacks: &Callbacks,
    method: &str,
    args: impl IntoIterator<Item = &'a Value>,
    context: Option<&Arc<super::request::Owner>>,
) -> Result<v8::Global<v8::Value>> {
    let factory = context.map(|_| {
        runtime
            .op_state()
            .borrow()
            .borrow::<super::request::Factory>()
            .0
            .clone()
    });
    let value = {
        deno_core::scope!(scope, runtime);
        v8::tc_scope!(scope, scope);
        let function = callbacks
            .functions
            .get(method)
            .ok_or_else(|| failed("callback was not captured"))?;
        let function = v8::Local::new(scope, function);
        let receiver = v8::Local::new(scope, &callbacks.receiver);
        let mut args = args
            .into_iter()
            .map(|value| super::json::to_v8(scope, value).map_err(failed))
            .collect::<Result<Vec<_>>>()?;
        if let Some(context) = context {
            let native =
                deno_core::cppgc::make_cppgc_object(scope, super::request::Handle::new(context));
            let factory = v8::Local::new(scope, factory.as_ref().expect("scoped factory"));
            let undefined = v8::undefined(scope).into();
            let context = factory
                .call(scope, undefined, &[native.into()])
                .ok_or_else(|| failed("request context construction failed"))?;
            args.push(context);
        }
        let value = function
            .call(scope, receiver.into(), &args)
            .ok_or_else(|| {
                failed(
                    scope
                        .exception()
                        .map(|value| value.to_rust_string_lossy(scope))
                        .unwrap_or_else(|| "plugin call terminated".into()),
                )
            })?;
        v8::Global::new(scope, value)
    };
    Ok(value)
}

pub(super) fn value(runtime: &mut JsRuntime, value: v8::Global<v8::Value>) -> Result<Value> {
    deno_core::scope!(scope, runtime);
    v8::tc_scope!(scope, scope);
    let value = v8::Local::new(scope, value);
    if value.is_promise() {
        return Err(failed("plugin result is an unresolved promise"));
    }
    super::json::decode(scope, value).map_err(failed)
}
