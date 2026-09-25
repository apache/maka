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

mod declarations;
mod session;
pub(crate) use session::Cells;
pub(super) fn declarations(definitions: &[ToolDefinition]) -> String {
    declarations::render(definitions)
}

use maka_js_runtime::CodeExecutor;
use maka_runtime::tool_call::{ToolCallIdentity, ToolOrigin, ToolRejection};
use maka_runtime::tools::{ToolExecutor, ToolFuture, ToolJournal};
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{ToolCallContext, ToolCatalog, ToolDefinition};
use uuid::Uuid;

const EXEC_GRAMMAR: &str = r#"start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE
PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
"#;

fn default_wait_yield() -> u64 {
    10_000
}

pub(super) fn definition() -> ToolDefinition {
    ToolDefinition {
        freeform: Some(maka_runtime::tools::FreeformGrammar::Lark { definition: EXEC_GRAMMAR.into() }), output_schema: None, provider: None,
        name: "exec".into(),
        description: r#"Run JavaScript code to orchestrate tool calls in a fresh V8 isolate. Code is an async ES module: use top-level await and emit output with helpers; no top-level return. No Node, filesystem, network, imports or console.
Pass raw JavaScript on freeform transports; on JSON-only transports put the same source in code. Optional first line: // @exec: {"yield_time_ms": 30000, "max_output_tokens": 10000}
Call tools.<name>(input). Names are normalized JavaScript identifiers. Await every intended operation, including Promise.all/Promise.allSettled. When the module finishes, unawaited operations are cancelled; admitted Host effects still settle before completion.
Helpers:
- text(value): emit a string or JSON value.
- image(value, detail?): emit a Host image, MCP image block or base64 data URL; image_url objects are accepted. detail is auto/low/high/original; an explicit argument overrides embedded detail.
- audio(value): emit an MCP audio block, audio_url object or base64 data URL. Audio bytes are delivered as native model input when supported; unsupported adapters receive an explicit notice. PCM WAV clips shorter than 25 ms are omitted with a text notice.
- generatedImage({image_url, output_hint?}): emit image content and its hint.
- store(key, value), load(key): retain JSON between exec calls in this live session, including across turns and compaction. No JS globals survive. Writes publish after settlement. Host restart/session retirement clears the store.
- notify(value): independently inject additional output for the current exec into the model history; no wait call is needed. Does not yield or finish the cell. Notifications arriving during a model request are delivered on the next step.
- await yield_control(): return accumulated output while the cell continues.
- exit(): end the script successfully.
- setTimeout(callback, delayMs=0), clearTimeout(id): timers alone do not keep a finished cell alive.
- ALL_TOOLS: frozen name/description metadata for all authorized nested tools, including deferred tools omitted from this description. Find a tool here and call it in the same cell.
Use wait only after exec returns a running cell_id. Tool permissions and schemas stay frozen for the cell. Calls to other advertised tools must be made directly. Do not invoke exec in parallel with other model tools.
Host limits: 64 KiB source, 1 MiB JSON/output/store, 64 MiB V8 heap, 30 seconds cumulative synchronous execution (async waits excluded), 32 tool calls per cell, 8 simultaneous calls, 4 uncollected cells per Run, 128 pending timers."#.into(),
        input_schema: schemars::schema_for!(CodeInput).into(),
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CodeInput {
    /// Async JavaScript module, at most 64 KiB UTF-8. Emit content using helpers.
    code: String,
    /// Observation wait in milliseconds (0..60000), not an execution timeout.
    #[serde(default = "default_yield")]
    #[schemars(range(min = 0, max = 60000))]
    yield_time_ms: u64,
    /// Approximate text-output budget (64..32768 tokens). Full output is retained as evidence.
    #[serde(default = "default_tokens")]
    #[schemars(range(min = 64, max = 32768))]
    max_output_tokens: usize,
}

fn default_yield() -> u64 {
    30_000
}
fn default_tokens() -> usize {
    10_000
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct WaitInput {
    /// Identifier returned by a running exec cell.
    cell_id: String,
    /// Observation wait in milliseconds (0..60000), not an execution timeout.
    #[serde(default = "default_wait_yield")]
    #[schemars(range(min = 0, max = 60000))]
    yield_time_ms: u64,
    /// Approximate text-output budget (64..32768 tokens).
    #[serde(default = "default_tokens")]
    #[schemars(range(min = 64, max = 32768))]
    #[serde(alias = "max_output_tokens")]
    max_tokens: usize,
    /// Request cancellation. Running means accepted effects are still being settled.
    #[serde(default)]
    terminate: bool,
}

pub(super) fn wait_definition() -> ToolDefinition {
    ToolDefinition {
        freeform: None, output_schema: None, provider: None, name: "wait".into(),
        description: "Use only after exec returns a running cell_id. Observe a running Code Mode cell using the cell_id from exec/wait. Returns only new output and its running/completed/terminated state. terminate requests cancellation; while cleanup is pending the state stays running. Completed cells are collected once. IDs are scoped to this Run and do not survive Host restart. yield_time_ms is 0..60000 (default 10000); max_tokens is an approximate text budget, 64..32768 (default 10000).".into(),
        input_schema: schemars::schema_for!(WaitInput).into(),
    }
}

fn invalid(message: impl Into<String>) -> ToolRejection {
    ToolRejection::InvalidInput {
        message: message.into(),
    }
}

fn observation_limits(yield_time_ms: u64, tokens: usize) -> Result<(), ToolRejection> {
    if yield_time_ms > 60_000 || !(64..=32_768).contains(&tokens) {
        return Err(invalid(
            "yield_time_ms must be 0..60000; output token budget must be 64..32768",
        ));
    }
    Ok(())
}

pub(super) fn source(input: &Value) -> Result<CodeInput, ToolRejection> {
    let mut value = if let Some(code) = input.as_str() {
        serde_json::json!({"code":code})
    } else {
        input.clone()
    };
    if let Some(code) = value.get("code").and_then(Value::as_str)
        && let Some(pragma) = code
            .lines()
            .next()
            .and_then(|line| line.trim_start().strip_prefix("// @exec:"))
    {
        let options: serde_json::Map<String, Value> = serde_json::from_str(pragma)
            .map_err(|error| invalid(format!("invalid exec pragma: {error}")))?;
        for (key, option) in options {
            if !matches!(key.as_str(), "yield_time_ms" | "max_output_tokens") {
                return Err(invalid(format!("unknown exec pragma option: {key}")));
            }
            if value.get(&key).is_some() {
                return Err(invalid(format!("exec option specified twice: {key}")));
            }
            value[&key] = option;
        }
    }
    serde_json::from_value::<CodeInput>(value)
        .map_err(|error| invalid(error.to_string()))
        .and_then(|input| {
            observation_limits(input.yield_time_ms, input.max_output_tokens)?;
            if input.code.len() > 64 * 1024 {
                return Err(invalid("code exceeds 64 KiB"));
            }
            Ok(input)
        })
}

pub(super) fn wait_input(input: &Value) -> Result<WaitInput, ToolRejection> {
    let input: WaitInput =
        serde_json::from_value(input.clone()).map_err(|error| invalid(error.to_string()))?;
    observation_limits(input.yield_time_ms, input.max_tokens)?;
    Ok(input)
}

pub(super) struct CellTool {
    cells: CodeExecutor,
    input: CodeInput,
    catalog: ToolCatalog,
    journal: ToolJournal,
    parent_operation_id: String,
    parent_tool_call_id: String,
}

impl CellTool {
    pub(super) fn new(
        cells: CodeExecutor,
        input: CodeInput,
        catalog: ToolCatalog,
        journal: ToolJournal,
        parent_operation_id: String,
        parent_tool_call_id: String,
    ) -> Self {
        Self {
            cells,
            input,
            catalog,
            journal,
            parent_operation_id,
            parent_tool_call_id,
        }
    }
}

/// Nested preflight precedes T1. The cell supplies only arguments, never its
/// parent identity or a broader catalog. Direct-only entries were removed once.
struct NestedTools {
    catalog: ToolCatalog,
    journal: ToolJournal,
    origin: ToolOrigin,
}

impl ToolExecutor for NestedTools {
    fn names(&self) -> Vec<String> {
        self.catalog.names()
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let catalog = self.catalog.clone();
        let journal = self.journal.clone();
        let call = ToolCallIdentity {
            tool_call_id: Uuid::new_v4().to_string(),
            origin: self.origin.clone(),
        };
        let operation_id = Uuid::new_v4().to_string();
        Box::pin(async move {
            let context = ToolCallContext {
                invocation: journal.invocation().clone(),
                operation_id: operation_id.clone(),
            };
            let prepared = catalog
                .prepare(name.clone(), input.clone(), context, cancellation.clone())
                .await;
            let effect = match prepared {
                Ok(effect) => effect,
                Err(reason) => {
                    return journal
                        .reject(operation_id, call, name, input, reason)
                        .await;
                }
            };
            let result = journal
                .invoke_prepared_call(
                    operation_id,
                    call,
                    name.clone(),
                    input,
                    cancellation,
                    effect,
                )
                .await?;
            Ok(result)
        })
    }
}
