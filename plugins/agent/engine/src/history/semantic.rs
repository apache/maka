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

//! Pure projection for explicit owned-history callers and golden oracles.
use crate::RunError;
use maka_agent_facts::{
    history::semantic::{Payload, ResolvedRow, SemanticKind},
    language::Language,
    model::{ModelPart, TextKind},
};
use maka_model::prompt::{AssistantPart, Message, ToolOutput};

pub(super) fn project(
    rows: &[ResolvedRow],
    session: &str,
    language: Language,
) -> Result<Vec<Message>, RunError> {
    let resources = super::resources::Resources::native(session);
    render_rows(rows, &resources, language)
}

fn render_rows(
    rows: &[ResolvedRow],
    resources: &super::resources::Resources<'_>,
    language: Language,
) -> Result<Vec<Message>, RunError> {
    let mut messages = Vec::new();
    let mut assistant_group = None;
    for resolved in rows {
        let row = &resolved.row;
        let payload = resolved.payload.as_ref();
        if !matches!(row.kind, SemanticKind::AssistantPart { .. }) {
            assistant_group = None;
        }
        match &row.kind {
            SemanticKind::User { steering, .. } => {
                let Some(Payload::User(content)) = payload else {
                    return Err(invalid());
                };
                messages.push(super::user::project(
                    content, resources, *steering, language,
                )?);
            }
            SemanticKind::ImportedUser { .. } => {
                messages.push(Message::user(text(payload)?.to_owned()))
            }
            SemanticKind::ImportedAssistant { .. } | SemanticKind::ExecutorText { .. } => messages
                .push(Message::Assistant {
                    content: vec![AssistantPart::Text {
                        text: text(payload)?.to_owned(),
                        provider_options: None,
                    }],
                    provider_options: None,
                }),
            SemanticKind::AssistantPart { .. } => {
                let Some(Payload::Part(part)) = payload else {
                    return Err(invalid());
                };
                let Some(part) = assistant_part(part) else {
                    continue;
                };
                let group = row.order.source_sequence;
                if assistant_group != Some(group) {
                    messages.push(Message::Assistant {
                        content: Vec::new(),
                        provider_options: None,
                    });
                    assistant_group = Some(group);
                }
                let Some(Message::Assistant { content, .. }) = messages.last_mut() else {
                    return Err(invalid());
                };
                content.push(part);
            }
            SemanticKind::ToolResult {
                call_id,
                name,
                custom,
                is_error,
                archived,
                ..
            } => {
                let output = match payload {
                    Some(Payload::Text(text)) => ToolOutput::ErrorText(text.clone()),
                    Some(Payload::Tool(projection)) if *archived => {
                        let maka_agent_facts::tool_output::DurableToolProjection::Json { value } =
                            projection
                        else {
                            return Err(invalid());
                        };
                        let mut value = value.clone();
                        value["readInstructions"] = match language {
                            Language::En => "Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.",
                            Language::ZhCn => "仅使用已选定的会话工具结果读取工具读取 page.next；没有读取工具时，其余内容不可用。",
                            Language::ZhTw => "僅使用已選定的工作階段工具結果讀取工具讀取 page.next；沒有讀取工具時，其餘內容無法取得。",
                        }.into();
                        if *is_error {
                            ToolOutput::ErrorJson(value)
                        } else {
                            ToolOutput::Json(value)
                        }
                    }
                    Some(Payload::Tool(projection)) => super::output::project(projection, language),
                    _ => return Err(invalid()),
                };
                let mut message = Message::tool(call_id, name, output);
                mark_custom(&mut message, *custom);
                messages.push(message);
            }
            SemanticKind::Notification {
                call_id, custom, ..
            } => {
                let mut message = Message::notification(call_id, text(payload)?.to_owned());
                mark_custom(&mut message, *custom);
                messages.push(message);
            }
            SemanticKind::UnknownTool {
                call_id,
                name,
                custom,
                ..
            } => {
                let text = match language {
                    Language::En => {
                        "outcome_unknown: The tool was dispatched, but no durable result was recorded. Its effect may have happened. Inspect current state before repeating it."
                    }
                    Language::ZhCn => {
                        "outcome_unknown: 工具已派发，但未记录持久结果；操作可能已生效。重复操作前先检查当前状态。"
                    }
                    Language::ZhTw => {
                        "outcome_unknown: 工具已派發，但未記錄持久結果；操作可能已生效。重複操作前先檢查目前狀態。"
                    }
                };
                let mut message = Message::tool(call_id, name, ToolOutput::ErrorText(text.into()));
                mark_custom(&mut message, *custom);
                messages.push(message);
            }
        }
    }
    Ok(messages)
}

fn text(payload: Option<&Payload>) -> Result<&str, RunError> {
    match payload {
        Some(Payload::Text(text)) => Ok(text),
        _ => Err(invalid()),
    }
}
fn invalid() -> RunError {
    RunError::ReconciliationRequired("semantic group payload does not match its row".into())
}
fn mark_custom(message: &mut Message, custom: bool) {
    if custom && let Message::Tool { content, .. } = message {
        for part in content {
            let options = part
                .provider_options
                .get_or_insert_with(|| serde_json::json!({}));
            options["openai"] = serde_json::json!({"toolKind":"custom"});
        }
    }
}
fn assistant_part(part: &ModelPart) -> Option<AssistantPart> {
    Some(match part {
        ModelPart::Source { .. } => return None,
        ModelPart::Text {
            text_kind,
            text,
            provider_options,
        } => match text_kind {
            TextKind::Thinking => AssistantPart::Reasoning {
                text: text.chunks().collect(),
                provider_options: provider_options.as_deref().cloned(),
            },
            TextKind::Text => AssistantPart::Text {
                text: text.chunks().collect(),
                provider_options: provider_options.as_deref().cloned(),
            },
        },
        ModelPart::ToolCall { call } => AssistantPart::ToolCall {
            tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            input: call.input.clone(),
            provider_executed: Some(call.provider_executed),
            provider_options: call.provider_options.clone(),
        },
        ModelPart::ToolResult {
            id,
            name,
            output,
            is_error,
            provider_options,
        } => AssistantPart::ToolResult {
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            output: if *is_error {
                ToolOutput::ErrorJson(output.clone())
            } else {
                ToolOutput::Json(output.clone())
            },
            provider_options: provider_options.clone(),
        },
    })
}
