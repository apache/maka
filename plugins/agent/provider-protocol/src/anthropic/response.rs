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

//! Response interpretation shares hosted-tool wire values with history replay.
//! Each response owns its identity maps, citation documents and accounting.
pub(crate) mod finish;
pub(crate) mod wire;
use super::{
    Usage,
    citations::{self, Document},
    hosted,
    prompt::Caller,
};
use crate::{
    Error, Result,
    input::Extensions,
    output::{self, Part, TextKind},
};
use citations::metadata;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use wire::Block;

#[derive(Debug, Default)]
pub struct Options {
    /// Provider names to names advertised by the host.
    pub tool_names: BTreeMap<String, String>,
    pub documents: citations::DocumentReferences,
    pub json_tool: bool,
    pub implicit_code_execution: bool,
    pub metadata_namespace: Option<String>,
}
pub(crate) struct Decoder {
    pub options: Options,
    pub mcp_calls: BTreeMap<String, output::ToolCall>,
    pub server_calls: BTreeMap<String, String>,
    pub json_answer: bool,
    pub has_search_results: bool,
}
impl Decoder {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            mcp_calls: BTreeMap::new(),
            server_calls: BTreeMap::new(),
            json_answer: false,
            has_search_results: false,
        }
    }
    pub fn name(&self, provider: &str) -> String {
        self.options
            .tool_names
            .get(provider)
            .cloned()
            .unwrap_or_else(|| provider.into())
    }
    pub fn tool_call(
        &mut self,
        id: String,
        name: String,
        mut input: Value,
        caller: Option<Caller>,
        toolset: Option<String>,
        hosted: bool,
    ) -> Option<output::ToolCall> {
        let mut extensions = caller_metadata(caller.as_ref());
        let mut dynamic = false;
        let name = if let Some(toolset) = toolset {
            input = member_input(&name, input);
            extensions = metadata(json!({"toolsetName":toolset}));
            self.name(&toolset)
        } else if hosted {
            self.server_calls.insert(id.clone(), name.clone());
            match name.as_str() {
                "code_execution" | "bash_code_execution" | "text_editor_code_execution" => {
                    dynamic = self.options.implicit_code_execution;
                    if name != "code_execution" {
                        input = discriminated_input(&name, input);
                    } else if input.get("code").is_some() && input.get("type").is_none() {
                        input = discriminated_input("programmatic-tool-call", input);
                    }
                    self.name("code_execution")
                }
                "web_fetch" | "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25" => {
                    self.name(&name)
                }
                "advisor" => {
                    input = json!({});
                    self.name(&name)
                }
                _ => return None,
            }
        } else {
            self.name(&name)
        };
        Some(output::ToolCall {
            id,
            name,
            input: input.to_string(),
            provider_executed: hosted,
            dynamic,
            extensions,
        })
    }
    pub fn block(
        &mut self,
        block: Block,
        next_id: &mut dyn FnMut() -> String,
    ) -> Result<Vec<Part>> {
        let mut parts = Vec::new();
        match block {
            Block::Text { text, citations } if !self.options.json_tool => {
                let citations = citations.unwrap_or_default();
                let extensions = (!citations.is_empty())
                    .then(|| metadata(json!({"citations":citations})))
                    .flatten();
                parts.push(Part::Text {
                    kind: TextKind::Text,
                    text,
                    citations: citations
                        .iter()
                        .map(|c| c.attachment(&self.options.documents))
                        .collect(),
                    extensions,
                });
                for citation in citations {
                    if !(citation.is_web_search() && self.has_search_results)
                        && let Some(source) = citation.source(&self.options.documents, next_id)
                    {
                        parts.push(Part::Source(source));
                    }
                }
            }
            Block::Text { .. } => {}
            Block::Thinking {
                thinking,
                signature,
            } => parts.push(Part::Text {
                kind: TextKind::Reasoning,
                text: thinking,
                citations: Vec::new(),
                extensions: metadata(json!({"signature":signature})),
            }),
            Block::RedactedThinking { data } => parts.push(Part::Text {
                kind: TextKind::Reasoning,
                text: String::new(),
                citations: Vec::new(),
                extensions: metadata(json!({"redactedData":data})),
            }),
            Block::Compaction { content, signature } => {
                if let Some(text) = content.filter(|s| !s.is_empty()) {
                    parts.push(Part::Text {
                        kind: TextKind::Text,
                        text,
                        citations: Vec::new(),
                        extensions: compaction_metadata(signature),
                    });
                }
            }
            Block::ToolUse {
                id,
                name,
                input,
                caller,
                toolset_name,
            } => {
                if self.options.json_tool && name == "json" {
                    self.json_answer = true;
                    parts.push(Part::Text {
                        kind: TextKind::Text,
                        text: input.to_string(),
                        citations: Vec::new(),
                        extensions: None,
                    });
                } else if let Some(call) =
                    self.tool_call(id, name, input, caller, toolset_name, false)
                {
                    parts.push(Part::ToolCall(call));
                }
            }
            Block::ServerToolUse {
                id,
                name,
                input,
                caller,
            } => {
                if let Some(call) = self.tool_call(
                    id,
                    name,
                    Value::Object(input.unwrap_or_default()),
                    caller,
                    None,
                    true,
                ) {
                    parts.push(Part::ToolCall(call));
                }
            }
            Block::McpToolUse {
                id,
                name,
                input,
                server_name,
            } => {
                let call = output::ToolCall {
                    id: id.clone(),
                    name,
                    input: input.to_string(),
                    provider_executed: true,
                    dynamic: true,
                    extensions: metadata(json!({"type":"mcp-tool-use","serverName":server_name})),
                };
                self.mcp_calls.insert(id, call.clone());
                parts.push(Part::ToolCall(call));
            }
            Block::McpToolResult {
                tool_use_id,
                is_error,
                content,
            } => {
                let call = self.mcp_calls.get(&tool_use_id).ok_or_else(|| {
                    Error::invalid(
                        "MCP result has no preceding call.",
                        json!({"tool_use_id":tool_use_id}),
                    )
                })?;
                parts.push(Part::ToolResult(output::ToolResult {
                    id: tool_use_id,
                    name: call.name.clone(),
                    value: hosted::wire(content),
                    is_error,
                    dynamic: true,
                    extensions: call.extensions.clone(),
                }));
            }
            Block::WebFetchToolResult(result) => {
                let is_error = matches!(result.content, wire::Fetch::Error(_));
                if let wire::Fetch::Result(fetch) = &result.content {
                    self.options.documents.push(Document {
                        title: fetch
                            .content
                            .title
                            .clone()
                            .unwrap_or_else(|| fetch.url.clone()),
                        filename: None,
                        media_type: match fetch.content.source {
                            hosted::DocumentSource::Base64 { .. } => "application/pdf",
                            hosted::DocumentSource::Text { .. } => "text/plain",
                        }
                        .into(),
                    });
                }
                parts.push(self.result(
                    result.tool_use_id,
                    "web_fetch",
                    hosted::wire(result.content),
                    is_error,
                    caller_metadata(result.caller.as_ref()),
                ));
            }
            Block::WebSearchToolResult(result) => {
                let is_error = matches!(result.content, wire::Search::Error(_));
                let value = hosted::wire(&result.content);
                parts.push(self.result(
                    result.tool_use_id,
                    "web_search",
                    value,
                    is_error,
                    caller_metadata(result.caller.as_ref()),
                ));
                if let wire::Search::Results(results) = result.content {
                    self.has_search_results |= !results.is_empty();
                    for result in results {
                        parts.push(Part::Source(output::Source::Url {
                            id: next_id(),
                            url: result.url,
                            title: result.title,
                            extensions: metadata(json!({"pageAge":result.page_age})),
                        }));
                    }
                }
            }
            Block::CodeExecutionToolResult(result) => {
                let is_error = matches!(result.content, wire::Code::Error(_));
                parts.push(self.result(
                    result.tool_use_id,
                    "code_execution",
                    hosted::wire(result.content),
                    is_error,
                    None,
                ));
            }
            Block::BashCodeExecutionToolResult(result)
            | Block::TextEditorCodeExecutionToolResult(result) => {
                let is_error = false;
                parts.push(self.result(
                    result.tool_use_id,
                    "code_execution",
                    hosted::wire(result.content),
                    is_error,
                    None,
                ));
            }
            Block::ToolSearchToolResult(result) => {
                let name = self
                    .server_calls
                    .get(&result.tool_use_id)
                    .cloned()
                    .unwrap_or_else(|| {
                        if self.name("tool_search_tool_bm25") != "tool_search_tool_bm25" {
                            "tool_search_tool_bm25"
                        } else {
                            "tool_search_tool_regex"
                        }
                        .into()
                    });
                let is_error = matches!(
                    result.content,
                    wire::ToolSearch::ToolSearchToolResultError { .. }
                );
                let value = match result.content {
                    wire::ToolSearch::ToolSearchToolSearchResult { tool_references } => {
                        hosted::wire(tool_references)
                    }
                    error => hosted::wire(error),
                };
                parts.push(self.result(result.tool_use_id, &name, value, is_error, None));
            }
            Block::AdvisorToolResult(result) => {
                let is_error = matches!(
                    result.content,
                    hosted::AdvisorResult::AdvisorToolResultError { .. }
                );
                parts.push(self.result(
                    result.tool_use_id,
                    "advisor",
                    hosted::wire(result.content),
                    is_error,
                    None,
                ));
            }
            Block::ContainerUpload { file_id } => parts.push(Part::Custom {
                kind: "anthropic.container_upload".into(),
                extensions: metadata(json!({"fileId":file_id})),
            }),
            Block::Fallback { from, to } => parts.push(Part::Custom {
                kind: "anthropic.fallback".into(),
                extensions: metadata(json!({"type":"fallback","from":from,"to":to})),
            }),
        }
        Ok(parts)
    }
    fn result(
        &self,
        id: String,
        name: &str,
        value: Value,
        is_error: bool,
        extensions: Extensions,
    ) -> Part {
        Part::ToolResult(output::ToolResult {
            id,
            name: self.name(name),
            value,
            is_error,
            dynamic: false,
            extensions,
        })
    }
}
pub(crate) fn caller_metadata(caller: Option<&Caller>) -> Extensions {
    caller.and_then(|caller| {
        let mut value = hosted::wire(caller);
        if let Some(id) = value.as_object_mut().and_then(|v| v.remove("tool_id")) {
            value["toolId"] = id;
        }
        metadata(json!({"caller":value}))
    })
}
pub(crate) fn compaction_metadata(signature: Option<String>) -> Extensions {
    let mut value = json!({"type":"compaction"});
    if let Some(signature) = signature {
        value["signature"] = json!(signature);
    }
    metadata(value)
}
pub(crate) fn member_input(name: &str, input: Value) -> Value {
    let mut value = json!({"action":name});
    if let Value::Object(input) = input {
        value.as_object_mut().unwrap().extend(input);
    }
    value
}
pub(crate) fn discriminated_input(kind: &str, input: Value) -> Value {
    let mut value = json!({"type":kind});
    if let Value::Object(input) = input {
        value.as_object_mut().unwrap().extend(input);
    }
    value
}
pub fn decode(
    bytes: &[u8],
    options: Options,
    next_id: &mut dyn FnMut() -> String,
) -> Result<output::Response> {
    let raw: Value = serde_json::from_slice(bytes)
        .map_err(|e| Error::json(&String::from_utf8_lossy(bytes), e))?;
    if raw["type"] != "message" {
        return Err(Error::invalid("Expected an Anthropic message.", raw));
    }
    let message: wire::Message = serde_json::from_value(raw.clone())
        .map_err(|e| Error::invalid(e.to_string(), raw.clone()))?;
    let mut decoder = Decoder::new(options);
    decoder.has_search_results = message.content.iter().any(|block|matches!(block, Block::WebSearchToolResult(wire::Hosted { content: wire::Search::Results(results), .. }) if !results.is_empty()));
    let mut parts = Vec::new();
    for block in message.content {
        if !wire::validate_block(&block, wire::Phase::Complete) {
            return Err(Error::invalid(
                "Invalid complete response content block.",
                raw,
            ));
        }
        parts.extend(decoder.block(block, next_id)?);
    }
    let finish = finish::finish(
        message.usage,
        message.end,
        message.input_transformations,
        message.context_management,
        decoder.json_answer,
        decoder.options.metadata_namespace.as_deref(),
    )?;
    Ok(output::Response {
        created_at_unix_seconds: None,
        id: message.id,
        model: message.model,
        parts,
        finish,
        raw,
    })
}
