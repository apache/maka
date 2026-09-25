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

use crate::{CellDiagnostic, CellDiagnosticKind, ToolMetadata};
use deno_core::{JsRuntime, v8};
use serde::Deserialize;
use serde_json::Value;

pub(crate) async fn evaluate(
    runtime: &mut JsRuntime,
    source: &str,
    names: &[String],
    max_bytes: usize,
    metadata: &[ToolMetadata],
    module: bool,
) -> Result<Value, CellDiagnostic> {
    let execution = |error: String| CellDiagnostic::new(CellDiagnosticKind::ExecutionError, error);
    let names: Vec<_> = names
        .iter()
        .map(|name| (crate::tool_identifier(name), name))
        .collect();
    let mut unique = std::collections::HashSet::new();
    if names.iter().any(|(name, _)| !unique.insert(name)) {
        return Err(execution(
            "tool names collide after JavaScript normalization".into(),
        ));
    }
    let names = serde_json::to_string(&names).unwrap();
    let metadata = serde_json::to_string(metadata).unwrap();
    runtime
        .execute_script(
            "maka:code/bootstrap",
            format!(
                r#"(() => {{
        const call = Deno.core.ops.op_maka_tool;
        const emit = Deno.core.ops.op_maka_emit;
        const notify = Deno.core.ops.op_maka_notify;
        const yieldOutput = Deno.core.ops.op_maka_yield;
        const save = Deno.core.ops.op_maka_store;
        const read = Deno.core.ops.op_maka_load;
        const sleep = Deno.core.ops.op_maka_sleep;
        const timer = Deno.core.ops.op_maka_timer;
        const cancelTimer = Deno.core.ops.op_maka_clear_timer;
        const diagnostics = new WeakMap();
        const remember = diagnostics.set.bind(diagnostics);
        const lookup = diagnostics.get.bind(diagnostics);
        const stringify = JSON.stringify;
        const describe = String;
        const ErrorClass = Error;
        const exitSignal = Object.freeze({{}});
        const check = (diagnostic) => {{
            if (!diagnostic) return;
            const error = new ErrorClass(diagnostic.message);
            remember(error, diagnostic);
            throw error;
        }};
        const text = (value) => {{
            const content = typeof value === "string" ? value : stringify(value);
            check(emit({{kind:"text",text:content === undefined ? "undefined" : content}}));
        }};
        const timers = new Map();
        let nextTimer = 0;
        const media = (type, value, detail) => {{
            if (typeof value === "string") {{
                const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={{0,2}})$/.exec(value);
                if (!match || !match[1].startsWith(type + "/")) throw new ErrorClass("expected a base64 data URL");
                value = {{type, mimeType:match[1],data:match[2]}};
            }}
            if (!value || value.type !== type) throw new ErrorClass("expected a " + type + " content block");
            check(emit({{kind:"media",content:{{type,data:value.data,mimeType:value.mimeType}}, detail}}));
        }};
        const helpers = {{
            text,
            exit: () => {{ throw exitSignal; }},
            image: (value, detail) => {{
                detail = detail ?? value?.detail ?? value?._meta?.["codex/imageDetail"];
                if (detail != null && !["auto", "low", "high", "original"].includes(detail))
                    throw new ErrorClass("invalid image detail");
                if (!value?.ref) {{ media("image", value?.image_url ?? value, detail); return; }}
                const {{mimeType, ref}} = value;
                check(emit({{kind:"image",image:{{mimeType,ref,detail}}}}));
            }},
            audio: (value) => media("audio", value?.audio_url ?? value),
            generatedImage: (value) => {{ media("image", value.image_url); if (value.output_hint) text(value.output_hint); }},
            notify: (value) => {{
                const content = typeof value === "string" ? value : stringify(value);
                check(notify(content === undefined ? "undefined" : content));
            }},
            yield_control: async () => {{ yieldOutput(); await sleep(0); }},
            store: (key, value) => {{
                if (typeof key !== "string") throw new ErrorClass("store key must be a string");
                const json = stringify(value);
                if (json === undefined) throw new ErrorClass("stored value must be JSON");
                check(save(key, JSON.parse(json)));
            }},
            load: (key) => {{
                if (typeof key !== "string") throw new ErrorClass("load key must be a string");
                const result = read(key);
                return result.found ? result.value : undefined;
            }},
            setTimeout: (callback, millis = 0) => {{
                if (typeof callback !== "function" || !Number.isFinite(millis) || millis < 0 || millis > 86400000)
                    throw new ErrorClass("invalid timer");
                if (timers.size >= 128) throw new ErrorClass("timer limit exceeded");
                const id = ++nextTimer;
                timers.set(id, callback);
                timer(id, Math.trunc(millis)).then((fired) => {{
                    const callback = timers.get(id);
                    timers.delete(id);
                    if (fired && callback) callback();
                }});
                return id;
            }},
            clearTimeout: (id) => {{ if (timers.delete(id)) cancelTimer(id); }},
            ALL_TOOLS: Object.freeze({metadata}.map(Object.freeze)),
        }};
        for (const [name, value] of Object.entries(helpers))
            Object.defineProperty(globalThis, name, {{value}});
        const invoke = async (name, input) => {{
            const outcome = await call(name, input);
            if (outcome.ok) return outcome.value;
            const error = new ErrorClass(outcome.error.message);
            remember(error, outcome.error);
            throw error;
        }};
        const catalog = Object.create(null);
        for (const [alias, name] of {names}) {{
            Object.defineProperty(catalog, alias, {{
                value: (input) => invoke(name, input), enumerable: true
            }});
        }}
        Object.defineProperty(globalThis, "tools", {{value: Object.freeze(catalog)}});
        globalThis.__maka_run = async (promise) => {{
            try {{
                const value = await promise;
                const json = stringify(value === undefined ? null : value);
                if (json === undefined) throw new ErrorClass("result is not JSON");
                return stringify({{kind: "success", json}});
            }} catch (error) {{
                if (error === exitSignal) return stringify({{kind:"success", json:"null"}});
                const diagnostic = lookup(error);
                return stringify({{kind: "failure", error: diagnostic ?? {{
                    kind: "execution_error", message: describe(error)
                }} }});
            }}
        }};
        for (const name of ["Deno", "console", "Atomics", "SharedArrayBuffer", "WebAssembly", "__bootstrap"])
            delete globalThis[name];
    }})();"#
            ),
        )
        .map_err(|error| execution(error.to_string()))?;
    // Keep the diagnostic closure in Rust, inaccessible to user source.
    let runner = runtime
        .execute_script(
            "maka:code/runner",
            "(() => { const run = __maka_run; delete globalThis.__maka_run; return run; })()",
        )
        .map_err(|error| execution(error.to_string()))?;
    let promise = if module {
        crate::module::evaluate(runtime, source)?
    } else {
        // Standalone Rust/CLI function-body API predates model Code Mode.
        runtime
            .execute_script(
                "maka:code/cell",
                format!("(async () => {{\n{source}\n}})()"),
            )
            .map_err(|error| {
                CellDiagnostic::new(CellDiagnosticKind::ParseError, error.to_string())
            })?
    };
    let value = {
        deno_core::scope!(scope, runtime);
        let runner = v8::Local::<v8::Function>::try_from(v8::Local::new(scope, runner))
            .map_err(|error| execution(error.to_string()))?;
        let promise = v8::Local::new(scope, promise);
        let undefined = v8::undefined(scope).into();
        let value = runner
            .call(scope, undefined, &[promise])
            .ok_or_else(|| execution("module evaluation terminated".into()))?;
        v8::Global::new(scope, value)
    };
    let resolving = runtime.resolve(value);
    let value = runtime
        .with_event_loop_promise(resolving, Default::default())
        .await
        .map_err(|error| execution(error.to_string()))?;
    let json = {
        deno_core::scope!(scope, runtime);
        let value = v8::Local::new(scope, value);
        deno_core::serde_v8::from_v8::<String>(scope, value)
            .map_err(|error| execution(error.to_string()))?
    };
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum Outcome {
        Success { json: String },
        Failure { error: CellDiagnostic },
    }
    let outcome: Outcome =
        serde_json::from_str(&json).map_err(|error| execution(error.to_string()))?;
    let json = match outcome {
        Outcome::Success { json } => json,
        Outcome::Failure { error } => return Err(error),
    };
    if json.len() > max_bytes {
        return Err(CellDiagnostic::limit("result bytes"));
    }
    serde_json::from_str(&json).map_err(|error| execution(error.to_string()))
}
