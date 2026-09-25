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

use crate::{CellDiagnostic, CellDiagnosticKind};
use deno_core::{JsRuntime, v8};

pub(crate) fn evaluate(
    runtime: &mut JsRuntime,
    code: &str,
) -> Result<v8::Global<v8::Value>, CellDiagnostic> {
    deno_core::scope!(scope, runtime);
    v8::tc_scope!(scope, scope);
    let resource = v8::String::new(scope, "maka:code/cell").unwrap();
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
    let source = v8::String::new(scope, code)
        .ok_or_else(|| CellDiagnostic::limit("module source allocation"))?;
    let mut source = v8::script_compiler::Source::new(source, Some(&origin));
    let Some(module) = v8::script_compiler::compile_module(scope, &mut source) else {
        let message = scope
            .exception()
            .map(|error| error.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "module compilation terminated".into());
        return Err(CellDiagnostic::new(CellDiagnosticKind::ParseError, message));
    };
    if module.get_module_requests().length() != 0 {
        return Err(CellDiagnostic::new(
            CellDiagnosticKind::ExecutionError,
            "imports are unavailable in Code Mode",
        ));
    }
    if module.instantiate_module(scope, no_imports) != Some(true) {
        return Err(CellDiagnostic::new(
            CellDiagnosticKind::ExecutionError,
            "module instantiation failed",
        ));
    }
    let result = module.evaluate(scope).ok_or_else(|| {
        CellDiagnostic::new(
            CellDiagnosticKind::ExecutionError,
            "module evaluation terminated",
        )
    })?;
    Ok(v8::Global::new(scope, result))
}

fn no_imports<'s>(
    _: v8::Local<'s, v8::Context>,
    _: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
    _: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    None
}
