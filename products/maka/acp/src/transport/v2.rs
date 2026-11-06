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

use crate::presentation::{MessageKind, Text, ToolStatus, Update};
use agent_client_protocol::v2::schema as acp;

pub(crate) fn update(update: Update) -> acp::SessionUpdate {
    match update {
        Update::Message {
            id,
            kind,
            text,
            meta,
        } => match text {
            Text::Delta(text) => {
                let chunk = acp::ContentChunk::new(text.into(), id).meta(meta);
                match kind {
                    MessageKind::User => acp::SessionUpdate::UserMessageChunk(chunk),
                    MessageKind::Text => acp::SessionUpdate::AgentMessageChunk(chunk),
                    MessageKind::Thinking => acp::SessionUpdate::AgentThoughtChunk(chunk),
                }
            }
            text => {
                let content = match text {
                    Text::Snapshot(text) => {
                        agent_client_protocol::schema::MaybeUndefined::Value(vec![text.into()])
                    }
                    _ => agent_client_protocol::schema::MaybeUndefined::Undefined,
                };
                match kind {
                    MessageKind::User => acp::SessionUpdate::UserMessage(
                        acp::UserMessage::new(id).content(content).meta(meta),
                    ),
                    MessageKind::Text => acp::SessionUpdate::AgentMessage(
                        acp::AgentMessage::new(id).content(content).meta(meta),
                    ),
                    MessageKind::Thinking => acp::SessionUpdate::AgentThought(
                        acp::AgentThought::new(id).content(content).meta(meta),
                    ),
                }
            }
        },
        Update::Tool(card) => {
            let status = match card.status {
                ToolStatus::Running => acp::ToolCallStatus::InProgress,
                ToolStatus::Completed => acp::ToolCallStatus::Completed,
                ToolStatus::Failed => acp::ToolCallStatus::Failed,
            };
            let mut tool = acp::ToolCallUpdate::new(card.id)
                .title(card.title)
                .kind(acp::ToolKind::Other)
                .status(status)
                .content(
                    card.output
                        .map(|text| {
                            vec![acp::ToolCallContent::Content(Box::new(acp::Content::new(
                                text,
                            )))]
                        })
                        .unwrap_or_default(),
                )
                .meta(card.meta);
            if let Some(name) = card.name {
                tool = tool.name(name);
            }
            if let Some(input) = card.input {
                tool = tool.raw_input(input);
            }
            acp::SessionUpdate::ToolCallUpdate(tool)
        }
    }
}

pub(crate) fn config(options: Vec<crate::configuration::Select>) -> Vec<acp::SessionConfigOption> {
    options
        .into_iter()
        .map(|option| {
            let category = match option.category {
                crate::configuration::Category::Model => acp::SessionConfigOptionCategory::Model,
                crate::configuration::Category::ThoughtLevel => {
                    acp::SessionConfigOptionCategory::ThoughtLevel
                }
                crate::configuration::Category::WorkspaceAccess => {
                    acp::SessionConfigOptionCategory::Other("_maka/sandbox_mode".into())
                }
            };
            acp::SessionConfigOption::select(
                option.id,
                option.name,
                option.current,
                option
                    .choices
                    .into_iter()
                    .map(|choice| acp::SessionConfigSelectOption::new(choice.value, choice.name))
                    .collect::<Vec<_>>(),
            )
            .category(category)
        })
        .collect()
}
pub(crate) fn list(page: crate::session::list::Page) -> acp::ListSessionsResponse {
    acp::ListSessionsResponse::new(
        page.sessions
            .into_iter()
            .map(|s| acp::SessionInfo::new(s.id, acp::AbsolutePath::new(s.cwd)).title(s.title))
            .collect(),
    )
    .next_cursor(page.next_cursor.map(acp::SessionListCursor::new))
}

pub(crate) fn content(block: acp::ContentBlock) -> Result<crate::content::Input, crate::Error> {
    use crate::content::Input;
    Ok(match block {
        acp::ContentBlock::Text(v) => Input::Text(v.text),
        acp::ContentBlock::ResourceLink(v) => Input::Link {
            uri: v.uri.to_string(),
            name: v.name,
            mime: v.mime_type.map(|m| m.to_string()),
        },
        acp::ContentBlock::Image(v) => Input::Image {
            data: v.data,
            mime: v.mime_type.to_string(),
            uri: v.uri.map(|u| u.to_string()),
        },
        acp::ContentBlock::Resource(v) => match v.resource {
            acp::EmbeddedResourceResource::TextResourceContents(v) => Input::EmbeddedText {
                uri: v.uri.to_string(),
                text: v.text,
            },
            acp::EmbeddedResourceResource::BlobResourceContents(v) => Input::EmbeddedBlob {
                uri: v.uri.to_string(),
                blob: v.blob,
                mime: v.mime_type.map(|m| m.to_string()),
            },
            _ => return Err("Unsupported embedded resource type".into()),
        },
        _ => return Err("Unsupported prompt content type".into()),
    })
}

pub(crate) fn permission(offer: crate::interaction::Permission) -> acp::RequestPermissionRequest {
    use crate::interaction::PermissionKind;
    let options = offer
        .options
        .into_iter()
        .map(|choice| {
            acp::PermissionOption::new(
                choice.id,
                choice.name,
                match choice.kind {
                    PermissionKind::AllowOnce => acp::PermissionOptionKind::AllowOnce,
                    PermissionKind::AllowAlways => acp::PermissionOptionKind::AllowAlways,
                    PermissionKind::RejectOnce => acp::PermissionOptionKind::RejectOnce,
                },
            )
        })
        .collect();
    let subject = if let Some((command, cwd)) = offer.command {
        Some(acp::RequestPermissionSubject::from(
            acp::CommandPermissionSubject::new(command, acp::AbsolutePath::new(cwd))
                .tool_call_id(offer.tool_id.map(acp::ToolCallId::new)),
        ))
    } else {
        offer.tool_id.map(|id| {
            acp::RequestPermissionSubject::from(acp::ToolCallUpdate::new(id).raw_input(offer.input))
        })
    };
    acp::RequestPermissionRequest::new(offer.session, offer.title, options)
        .description(offer.description)
        .subject(subject)
}

pub(crate) fn permission_answer(
    response: acp::RequestPermissionResponse,
) -> Result<Option<String>, crate::Error> {
    match response.outcome {
        acp::RequestPermissionOutcome::Selected(selected) => {
            Ok(Some(selected.option_id.to_string()))
        }
        acp::RequestPermissionOutcome::Cancelled(_) => Ok(None),
        _ => Err("Unsupported ACP permission outcome".into()),
    }
}
pub(crate) fn form(
    form: crate::interaction::Form,
) -> Result<acp::CreateElicitationRequest, crate::Error> {
    let scope = acp::ElicitationSessionScope::new(acp::SessionId::new(form.session))
        .tool_call_id(acp::ToolCallId::new(form.tool_id));
    Ok(acp::CreateElicitationRequest::new(
        acp::ElicitationFormMode::new(
            scope,
            serde_json::from_value::<acp::ElicitationSchema>(form.schema)?,
        ),
        form.message,
    ))
}
pub(crate) fn form_answer(
    response: acp::CreateElicitationResponse,
) -> Result<crate::interaction::FormAnswer, crate::Error> {
    use crate::interaction::FormAnswer;
    match response.action {
        acp::ElicitationAction::Accept(accept) => {
            let content = accept
                .content
                .ok_or("Accepted elicitation is missing content")?;
            Ok(FormAnswer::Accept(
                content
                    .into_iter()
                    .map(|(key, value)| Ok((key, serde_json::to_value(value)?)))
                    .collect::<Result<_, serde_json::Error>>()?,
            ))
        }
        acp::ElicitationAction::Decline => Ok(FormAnswer::Decline),
        acp::ElicitationAction::Cancel => Ok(FormAnswer::Cancel),
        _ => Err("Unsupported ACP elicitation action".into()),
    }
}
