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

use super::{
    Block, Builder, CacheDirective, Result, ToolResult, ToolValue, caller, wire::HostResult,
};
use crate::anthropic::hosted::{
    self, AdvisorResult, CodeResult, FetchResult, SearchResult, ToolReference,
};
use serde_json::{Value, json};
use std::collections::HashSet;

enum ProviderTool {
    Code,
    Fetch,
    Search,
    ToolSearch,
    Advisor,
}
impl ProviderTool {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "code_execution" => Some(Self::Code),
            "web_fetch" => Some(Self::Fetch),
            "web_search" => Some(Self::Search),
            "tool_search_tool_regex" | "tool_search_tool_bm25" => Some(Self::ToolSearch),
            "advisor" => Some(Self::Advisor),
            _ => None,
        }
    }
}
fn kind(output: &ToolValue) -> &'static str {
    match output {
        ToolValue::Text(_) => "text",
        ToolValue::Json(_) => "json",
        ToolValue::ErrorText(_) => "error-text",
        ToolValue::ErrorJson(_) => "error-json",
        ToolValue::Denied { .. } => "execution-denied",
        ToolValue::Content(_) => "content",
    }
}
fn error_value(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or(Value::Null),
        _ => value.clone(),
    }
}
fn error_code(value: &Value, default: &str) -> String {
    error_value(value)["error_code"]
        .as_str()
        .unwrap_or(default)
        .into()
}
impl Builder<'_> {
    pub(super) fn replay(
        &mut self,
        result: &ToolResult,
        mcp_ids: &HashSet<String>,
        cache: Option<CacheDirective>,
    ) -> Result<Option<Block>> {
        let output = &result.output.value;
        if mcp_ids.contains(&result.id) {
            return Ok(match output {
                ToolValue::Json(value) | ToolValue::ErrorJson(value) => {
                    Some(Block::McpToolResult {
                        tool_use_id: result.id.clone(),
                        content: value.clone(),
                        is_error: matches!(output, ToolValue::ErrorJson(_)),
                        cache_control: cache,
                    })
                }
                _ => {
                    self.unsupported_output(result);
                    None
                }
            });
        }
        let Some(tool) = ProviderTool::from_name(self.provider_name(&result.name)) else {
            self.warn(format!(
                "provider executed tool result for tool {} is not supported",
                result.name
            ));
            return Ok(None);
        };
        let mut host = HostResult {
            tool_use_id: result.id.clone(),
            content: Value::Null,
            caller: None,
            cache_control: cache,
        };
        if matches!(tool, ProviderTool::Fetch | ProviderTool::Search) {
            host.caller = caller(&result.extensions);
        }
        if matches!(tool, ProviderTool::Code) {
            match output {
                ToolValue::ErrorText(text) => {
                    return Ok(Some(code_error(host, &error_value(&json!(text)))));
                }
                ToolValue::ErrorJson(value) => {
                    return Ok(Some(code_error(host, &error_value(value))));
                }
                ToolValue::Json(value) if value["type"].is_string() => {
                    let code: CodeResult = hosted::parse(value)?;
                    let category = match &code {
                        CodeResult::CodeExecutionResult { .. }
                        | CodeResult::EncryptedCodeExecutionResult { .. } => 0,
                        CodeResult::BashCodeExecutionResult { .. }
                        | CodeResult::BashCodeExecutionToolResultError { .. } => 1,
                        _ => 2,
                    };
                    host.content = hosted::wire(code);
                    return Ok(Some(match category {
                        0 => Block::CodeExecutionToolResult(host),
                        1 => Block::BashCodeExecutionToolResult(host),
                        _ => Block::TextEditorCodeExecutionToolResult(host),
                    }));
                }
                ToolValue::Json(_) => {
                    self.warn(format!("provider executed tool result output value is not a valid code execution result for tool {}",result.name));
                    return Ok(None);
                }
                _ => {
                    self.unsupported_output(result);
                    return Ok(None);
                }
            }
        }
        let (value, error) = match output {
            ToolValue::Json(value) => (value, false),
            ToolValue::ErrorJson(value) => (value, true),
            _ => {
                self.unsupported_output(result);
                return Ok(None);
            }
        };
        Ok(Some(match tool {
            ProviderTool::Fetch => {
                host.content = if error {
                    json!({"type":"web_fetch_tool_result_error","error_code":error_code(value,"unavailable")})
                } else {
                    hosted::wire(hosted::parse::<FetchResult>(value)?)
                };
                Block::WebFetchToolResult(host)
            }
            ProviderTool::Search => {
                host.content = if error {
                    json!({"type":"web_search_tool_result_error","error_code":error_code(value,"unavailable")})
                } else {
                    hosted::wire(hosted::parse::<Vec<SearchResult>>(value)?)
                };
                Block::WebSearchToolResult(host)
            }
            ProviderTool::ToolSearch => {
                host.content = if error || value["type"] == "tool_search_tool_result_error" {
                    json!({"type":"tool_search_tool_result_error","error_code":error_code(value,"unavailable")})
                } else {
                    json!({"type":"tool_search_tool_search_result","tool_references":hosted::parse::<Vec<ToolReference>>(value)?})
                };
                Block::ToolSearchToolResult(host)
            }
            ProviderTool::Advisor => {
                host.content = hosted::wire(hosted::parse::<AdvisorResult>(value)?);
                Block::AdvisorToolResult(host)
            }
            ProviderTool::Code => {
                unreachable!("code results are handled before JSON-only providers")
            }
        }))
    }
    pub(super) fn unsupported_output(&mut self, result: &ToolResult) {
        self.warn(format!(
            "provider executed tool result output type {} for tool {} is not supported",
            kind(&result.output.value),
            result.name
        ));
    }
}
fn code_error(mut result: HostResult, value: &Value) -> Block {
    if value["type"] == "code_execution_tool_result_error" {
        result.content = json!({"type":"code_execution_tool_result_error","error_code":error_code(value,"unknown")});
        Block::CodeExecutionToolResult(result)
    } else {
        result.content = json!({"type":"bash_code_execution_tool_result_error","error_code":error_code(value,"unknown")});
        Block::BashCodeExecutionToolResult(result)
    }
}
