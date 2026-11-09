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
pub(super) fn declarations<'a>(
    definitions: impl IntoIterator<Item = &'a ToolDefinition>,
    language: CodeLanguage,
) -> String {
    match language {
        CodeLanguage::JavaScript => declarations::render(definitions),
        CodeLanguage::Python => declarations::python(definitions),
    }
}

use crate::CodeExecutor;
use maka_agent_facts::execution::CodeLanguage;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_agent_facts::tools::ToolJournal;
use maka_code_runtime::{CellDiagnosticKind, CellResult};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::{ToolCatalog, ToolDefinition};
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

pub(super) fn definition(language: CodeLanguage) -> ToolDefinition {
    if language == CodeLanguage::Python {
        return ToolDefinition {
            freeform: Some(maka_agent_facts::tools::FreeformGrammar::Lark {
                definition: EXEC_GRAMMAR.replace(r"\/\/", "#"),
            }),
            output_schema: None,
            provider: None,
            name: "exec".into(),
            description: include_str!("cell/python.md").into(),
            input_schema: schemars::schema_for!(CodeInput).into(),
        };
    }
    ToolDefinition {
        freeform: Some(maka_agent_facts::tools::FreeformGrammar::Lark { definition: EXEC_GRAMMAR.into() }), output_schema: None, provider: None,
        name: "exec".into(),
        description: r#"Orchestrate tool calls in a fresh V8 async ES module. Use top-level await and output helpers; top-level return, Node, filesystem, network, imports and console are unavailable.
Pass raw JavaScript on freeform transports; on JSON-only transports put the same source in code. Optional first line: // @exec: {"yield_time_ms": 30000, "max_output_tokens": 10000}
Call tools.<name>(input). Names are normalized JavaScript identifiers. Await every intended operation, including Promise.all/Promise.allSettled. When the module finishes, unawaited operations are cancelled; admitted Host effects still settle before completion.
Helpers:
- text(value): emit a string or JSON value.
- image(value, detail?): emit a Host image, MCP image block or base64 data URL; image_url objects are accepted. detail is auto/low/high/original; an explicit argument overrides embedded detail.
- audio(value): emit an MCP audio block, audio_url object or base64 data URL. Audio bytes are delivered as native model input when supported; unsupported adapters receive an explicit notice. PCM WAV clips shorter than 25 ms are omitted with a text notice.
- generatedImage({image_url, output_hint?}): emit image content and its hint.
- store(key, value), load(key): retain JSON between exec calls in this live session, including across turns and compaction. No JS globals survive. Writes publish after settlement. Host restart/session retirement clears the store.
- notify(value): inject output into model history without wait, yielding or finishing the cell. Notifications during a model request arrive on the next step.
- await yield_control(): return accumulated output while the cell continues.
- exit(): end the script successfully.
- setTimeout(callback, delayMs=0), clearTimeout(id): timers alone do not keep a finished cell alive.
- ALL_TOOLS: frozen name/description metadata for all authorized nested tools, including deferred tools omitted from this description. Find a tool here and call it in the same cell.
Use wait only after exec returns a running cell_id. Tool permissions and schemas stay frozen for the cell. Calls to other advertised tools must be made directly. Do not invoke exec in parallel with other model tools.
Host execution: 64 MiB V8 heap and 30 seconds cumulative synchronous execution (async waits excluded). Tool work remains owned until cleanup; use wait to collect running cells."#.into(),
        input_schema: schemars::schema_for!(CodeInput).into(),
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CodeInput {
    /// Source in the selected Code Mode language. Emit content using helpers.
    code: String,
    /// Observation wait in milliseconds; steering can yield earlier.
    #[serde(default = "default_yield")]
    yield_time_ms: u64,
    /// Approximate text-output budget in tokens. Full output is retained as evidence.
    #[serde(default = "default_tokens")]
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
    /// Observation wait in milliseconds; steering can yield earlier.
    #[serde(default = "default_wait_yield")]
    yield_time_ms: u64,
    /// Approximate text-output budget in tokens.
    #[serde(default = "default_tokens")]
    max_tokens: usize,
    /// Request cancellation. Running means accepted effects are still being settled.
    #[serde(default)]
    terminate: bool,
}

pub(super) fn wait_definition() -> ToolDefinition {
    ToolDefinition {
        freeform: None, output_schema: None, provider: None, name: "wait".into(),
        description: "Observe a cell_id returned by running exec/wait. Returns new output and running/completed/terminated state. terminate requests cancellation; state stays running through cleanup. Collect final output once. IDs expire with this Run or Host restart.".into(),
        input_schema: schemars::schema_for!(WaitInput).into(),
    }
}

fn invalid(message: impl Into<String>) -> ToolRejection {
    ToolRejection::InvalidInput {
        message: message.into(),
    }
}

pub(super) fn source(input: &Value, language: CodeLanguage) -> Result<CodeInput, ToolRejection> {
    let prefix = match language {
        CodeLanguage::JavaScript => "// @exec:",
        CodeLanguage::Python => "# @exec:",
    };
    let mut value = if let Some(code) = input.as_str() {
        serde_json::json!({"code":code})
    } else {
        input.clone()
    };
    if let Some(code) = value.get("code").and_then(Value::as_str)
        && let Some(pragma) = code
            .lines()
            .next()
            .and_then(|line| line.trim_start().strip_prefix(prefix))
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
    serde_json::from_value::<CodeInput>(value).map_err(|error| invalid(error.to_string()))
}

pub(super) fn wait_input(input: &Value) -> Result<WaitInput, ToolRejection> {
    serde_json::from_value(input.clone()).map_err(|error| invalid(error.to_string()))
}

pub(super) struct CellTool {
    cells: CodeExecutor,
    input: CodeInput,
    catalog: ToolCatalog,
    direct: DirectAliases,
    journal: ToolJournal,
    parent_operation_id: String,
    parent_tool_call_id: String,
}

impl CellTool {
    pub(super) fn new(
        cells: CodeExecutor,
        input: CodeInput,
        catalog: ToolCatalog,
        direct: Vec<String>,
        journal: ToolJournal,
        parent_operation_id: String,
        parent_tool_call_id: String,
    ) -> Self {
        let direct = DirectAliases::new(&cells, &catalog, &direct);
        Self {
            cells,
            input,
            catalog,
            direct,
            journal,
            parent_operation_id,
            parent_tool_call_id,
        }
    }
}

/// The request's direct tools by the `tools` member a cell would call them
/// through. `tools` holds only the nested catalog, so such a call fails as a
/// missing member; the settled failure then names the calling mode.
struct DirectAliases {
    language: CodeLanguage,
    names: BTreeMap<String, String>,
}

impl DirectAliases {
    fn new(cells: &CodeExecutor, catalog: &ToolCatalog, direct: &[String]) -> Self {
        let callable: HashSet<_> = catalog
            .names()
            .iter()
            .map(|name| cells.tool_identifier(name))
            .collect();
        let direct: BTreeSet<_> = direct
            .iter()
            .map(String::as_str)
            .chain(["exec", "wait"])
            .collect();
        let mut names = BTreeMap::new();
        for name in direct {
            let alias = cells.tool_identifier(name);
            if !callable.contains(&alias) {
                // Two direct tools behind one member cannot say which was meant.
                names
                    .entry(alias)
                    .and_modify(|name| *name = None)
                    .or_insert(Some(name));
            }
        }
        Self {
            language: cells.language(),
            names: names
                .into_iter()
                .filter_map(|(alias, name)| Some((alias, name?.to_owned())))
                .collect(),
        }
    }

    fn explain(&self, result: &mut CellResult) {
        let CellResult::Failure { error, .. } = result else {
            return;
        };
        if error.kind != CellDiagnosticKind::ExecutionError {
            return;
        }
        // V8 reports the member alone; Monty ends its traceback with it.
        let member = match self.language {
            CodeLanguage::JavaScript => error
                .message
                .strip_prefix("TypeError: tools.")
                .and_then(|rest| rest.strip_suffix(" is not a function")),
            CodeLanguage::Python => error
                .message
                .lines()
                .last()
                .and_then(|line| {
                    line.strip_prefix("AttributeError: module 'tools' has no attribute '")
                })
                .and_then(|rest| rest.strip_suffix('\'')),
        };
        if let Some(name) = member.and_then(|member| self.names.get(member)) {
            error.message = format!(
                "{}\n{name} is a direct tool: call it outside exec, not through tools",
                error.message
            );
        }
    }
}

/// Nested preflight precedes T1. The cell supplies only arguments, never its
/// parent identity or a broader catalog. Direct-only entries were removed once.
struct NestedTools {
    execution: Arc<tokio::sync::RwLock<()>>,
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
        let execution = self.execution.clone();
        let parallel = catalog.semantics(&name) == Ok(crate::ToolSemantics::Parallel);
        let journal = self.journal.clone();
        let call = ToolCallIdentity {
            tool_call_id: Uuid::new_v4().to_string(),
            origin: self.origin.clone(),
        };
        let operation_id = Uuid::new_v4().to_string();
        Box::pin(async move {
            // Nested calls share a gate across live cells, separate from the
            // outer exec/wait envelopes to avoid recursive lock acquisition.
            let _execution = if parallel {
                futures_util::future::Either::Left(execution.read_owned().await)
            } else {
                futures_util::future::Either::Right(execution.write_owned().await)
            };
            let context = journal.context(operation_id.clone());
            let prepared = catalog
                .prepare(name.clone(), input.clone(), context, cancellation.clone())
                .await;
            let effect = match prepared {
                Ok(effect) => effect,
                Err(reason) => {
                    return journal
                        .reject(operation_id, call, name, input.into(), None, reason)
                        .await;
                }
            };
            let result = journal
                .invoke_prepared_output(
                    operation_id,
                    call,
                    name.clone(),
                    input,
                    None,
                    cancellation,
                    effect,
                )
                .await?;
            result
                .into_code_value()
                .map_err(|message| maka_agent_facts::tools::ToolError::Failed(message.into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_code_runtime::{CellDiagnostic, CellLimits};

    // The Python worker is not built with this crate's tests; the traceback is
    // the worker's actual report for `await tools.SessionCreate({})`.
    #[test]
    fn a_python_cell_names_the_direct_tool_it_called_through_tools() {
        let cells = CodeExecutor::new(CellLimits::default())
            .unwrap()
            .with_language(CodeLanguage::Python);
        let direct = DirectAliases::new(
            &cells,
            &ToolCatalog::new([]).unwrap(),
            &["SessionCreate".into()],
        );
        let explained = |name: &str| {
            let message = format!(
                "Traceback (most recent call last):\n  File \"code_mode.py\", line 1, in <module>\n    await tools.{name}({{}})\nAttributeError: module 'tools' has no attribute '{name}'"
            );
            let mut result = CellResult::Failure {
                error: CellDiagnostic::new(CellDiagnosticKind::ExecutionError, message.clone()),
                tool_calls: Vec::new(),
            };
            direct.explain(&mut result);
            let CellResult::Failure { error, .. } = result else {
                unreachable!()
            };
            (message, error.message)
        };
        let (message, direct) = explained("SessionCreate");
        assert_eq!(
            direct,
            format!(
                "{message}\nSessionCreate is a direct tool: call it outside exec, not through tools"
            )
        );
        let (message, unknown) = explained("UnknownTool");
        assert_eq!(unknown, message);
    }
}
