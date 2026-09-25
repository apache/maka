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

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Provider input, derived from canonical facts. These types are not stored
/// history and cannot authorize effects or artifact reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase", deny_unknown_fields)]
pub enum Message {
    System {
        content: String,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    User {
        content: Vec<ContentPart>,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    Assistant {
        content: Vec<AssistantPart>,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    Tool {
        content: Vec<ToolResult>,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User {
            content: vec![ContentPart::text(text)],
            provider_options: None,
        }
    }

    pub fn tool(id: impl Into<String>, name: impl Into<String>, output: ToolOutput) -> Self {
        Self::Tool {
            content: vec![ToolResult {
                kind: ResultKind::ToolResult,
                tool_call_id: id.into(),
                tool_name: name.into(),
                output,
                provider_options: None,
            }],
            provider_options: None,
        }
    }

    /// Supplemental output, distinct from a tool's required settled result.
    pub fn notification(id: impl Into<String>, text: impl Into<String>) -> Self {
        let mut message = Self::tool(id, "exec", ToolOutput::Text(text.into()));
        if let Self::Tool { content, .. } = &mut message {
            content[0].provider_options = Some(serde_json::json!({"maka":{"notification":true}}));
        }
        message
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ContentPart {
    Text {
        text: String,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    File {
        data: FileData,
        #[serde(rename = "mediaType")]
        media_type: String,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            provider_options: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub enum FileData {
    Data(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum AssistantPart {
    Text {
        text: String,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    Reasoning {
        text: String,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        input: Value,
        #[serde(rename = "providerExecuted", skip_serializing_if = "Option::is_none")]
        provider_executed: Option<bool>,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        output: ToolOutput,
        #[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResult {
    #[serde(rename = "type")]
    kind: ResultKind,
    pub tool_call_id: String,
    pub tool_name: String,
    pub output: ToolOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<Value>,
}

impl ToolResult {
    pub fn is_notification(&self) -> bool {
        self.provider_options
            .as_ref()
            .is_some_and(|value| value["maka"]["notification"] == true)
    }
    pub fn is_custom(&self) -> bool {
        self.provider_options
            .as_ref()
            .is_some_and(|value| value["openai"]["toolKind"] == "custom")
    }
}

/// JSON-only APIs require exactly one result per call. Supplemental Code Mode
/// output is carried as a labelled observation, never a second settlement.
pub fn notification_fallback(messages: Vec<Message>) -> Vec<Message> {
    messages
        .into_iter()
        .flat_map(|message| {
            let Message::Tool {
                content,
                provider_options,
            } = message
            else {
                return vec![message];
            };
            if !content.iter().any(ToolResult::is_notification) {
                return vec![Message::Tool {
                    content,
                    provider_options,
                }];
            }
            let mut result = Vec::new();
            for part in content {
                if part.is_notification() {
                    if let ToolOutput::Text(text) = part.output {
                        result.push(Message::user(format!(
                            "[Notification from exec {}]\n{text}",
                            part.tool_call_id
                        )));
                    }
                } else {
                    result.push(Message::Tool {
                        content: vec![part],
                        provider_options: provider_options.clone(),
                    });
                }
            }
            result
        })
        .collect()
}

// A tool-role message cannot contain assistant text or a tool-call tag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum ResultKind {
    #[serde(rename = "tool-result")]
    ToolResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum ToolOutput {
    Text(String),
    Json(Value),
    ErrorText(String),
    ErrorJson(Value),
    Content(Vec<ContentPart>),
}
