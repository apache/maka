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

//! Present normalized imported claims without inventing native execution identities.
use super::*;
use maka_agent_facts::{
    attachment::AttachmentRef,
    history_snapshot::{HistoricalRole, ImportedMessage},
};
use maka_agent_state::session_history::snapshot::Snapshot;
use serde::Deserialize;
use wire::{HistoryOrder, HistoryRowAddress, Role, SourceField};

enum Header {
    Input {
        content: InputContent,
    },
    Model {
        part: Model,
    },
    ToolReturn {
        call_id: String,
        name: String,
        result: ReturnHeader,
    },
}
#[derive(Deserialize)]
struct ReturnHeader {
    body: ReturnBody,
}
#[derive(Deserialize)]
struct ReturnBody {
    is_error: bool,
}
#[derive(Deserialize)]
struct InputContent {
    display_text: Option<serde::de::IgnoredAny>,
    attachments: Option<Vec<AttachmentRef>>,
    quotes: Option<Vec<maka_agent_facts::input::QuoteRef>>,
    directory_references: Option<Vec<serde::de::IgnoredAny>>,
    inline_references: Option<Vec<serde::de::IgnoredAny>>,
}
enum Model {
    Text {
        text_kind: TextKind,
    },
    Source {
        source: Citation,
    },
    ToolCall {
        call: Call,
    },
    ToolResult {
        id: String,
        name: String,
        is_error: bool,
    },
}
// Plain struct visitors discard unknown payloads while reading. Serde's
// internally-tagged enum visitor would first buffer the entire text/result.
#[derive(Deserialize)]
struct HeaderClaims {
    kind: HeaderKind,
    content: Option<InputContent>,
    part: Option<Model>,
    call_id: Option<String>,
    name: Option<String>,
    result: Option<ReturnHeader>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum HeaderKind {
    Input,
    Model,
    ToolReturn,
}
impl<'de> Deserialize<'de> for Header {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = HeaderClaims::deserialize(deserializer)?;
        Ok(match value.kind {
            HeaderKind::Input => Self::Input {
                content: value
                    .content
                    .ok_or_else(|| D::Error::missing_field("content"))?,
            },
            HeaderKind::Model => Self::Model {
                part: value.part.ok_or_else(|| D::Error::missing_field("part"))?,
            },
            HeaderKind::ToolReturn => Self::ToolReturn {
                call_id: value
                    .call_id
                    .ok_or_else(|| D::Error::missing_field("call_id"))?,
                name: value.name.ok_or_else(|| D::Error::missing_field("name"))?,
                result: value
                    .result
                    .ok_or_else(|| D::Error::missing_field("result"))?,
            },
        })
    }
}
#[derive(Deserialize)]
struct ModelClaims {
    kind: ModelKind,
    text_kind: Option<TextKind>,
    source: Option<Citation>,
    call: Option<Call>,
    id: Option<String>,
    name: Option<String>,
    is_error: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModelKind {
    Text,
    Source,
    ToolCall,
    ToolResult,
}
impl<'de> Deserialize<'de> for Model {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = ModelClaims::deserialize(deserializer)?;
        Ok(match value.kind {
            ModelKind::Text => Self::Text {
                text_kind: value
                    .text_kind
                    .ok_or_else(|| D::Error::missing_field("text_kind"))?,
            },
            ModelKind::Source => Self::Source {
                source: value
                    .source
                    .ok_or_else(|| D::Error::missing_field("source"))?,
            },
            ModelKind::ToolCall => Self::ToolCall {
                call: value.call.ok_or_else(|| D::Error::missing_field("call"))?,
            },
            ModelKind::ToolResult => Self::ToolResult {
                id: value.id.ok_or_else(|| D::Error::missing_field("id"))?,
                name: value.name.ok_or_else(|| D::Error::missing_field("name"))?,
                is_error: value
                    .is_error
                    .ok_or_else(|| D::Error::missing_field("is_error"))?,
            },
        })
    }
}
enum Citation {
    Url {
        url: String,
        title: Option<String>,
    },
    Document {
        title: String,
        filename: Option<String>,
    },
}
#[derive(Deserialize)]
struct CitationClaims {
    kind: CitationKind,
    url: Option<String>,
    title: Option<String>,
    filename: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CitationKind {
    Url,
    Document,
}
impl<'de> Deserialize<'de> for Citation {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = CitationClaims::deserialize(deserializer)?;
        Ok(match value.kind {
            CitationKind::Url => Self::Url {
                url: value.url.ok_or_else(|| D::Error::missing_field("url"))?,
                title: value.title,
            },
            CitationKind::Document => Self::Document {
                title: value
                    .title
                    .ok_or_else(|| D::Error::missing_field("title"))?,
                filename: value.filename,
            },
        })
    }
}
#[derive(Deserialize)]
struct Call {
    id: String,
    name: String,
}
fn field(reference: &ContentRef, selectors: &[&str], returned: bool) -> projection::Field {
    projection::Field::Imported {
        reference: reference.clone(),
        selectors: selectors.iter().map(|key| (*key).into()).collect(),
        returned,
    }
}
fn tool(chunk: &mut wire::Chunk, id: String, name: String, is_error: Option<bool>) {
    chunk.tool = Some(wire::Tool {
        tool_use_id: id,
        call: is_error.is_none().then(|| wire::ToolCall {
            ancestor_tool_use_ids: Vec::new(),
            origin: wire::ToolCallOrigin::Imported,
            presentation: None,
            position: chunk.position.clone(),
            name,
            title: None,
            pending: false,
            dispatched: false,
            external_target: None,
        }),
        result: is_error.map(|is_error| wire::ToolResult {
            position: chunk.position.clone(),
            is_error,
            image: false,
            images: 0,
            settlement: None,
            details: None,
        }),
    });
}
pub(super) async fn row(
    snapshot: &Snapshot,
    message: &ImportedMessage,
    message_ordinal: u64,
    part_ordinal: u64,
    address: HistoryRowAddress,
    order: HistoryOrder,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<projection::Row, String> {
    let reference = message
        .parts
        .get(usize::try_from(part_ordinal).map_err(|_| "agent_history_part_invalid")?)
        .ok_or("agent_history_part_invalid")?;
    let cancelled = stop.clone();
    let header: Header = snapshot
        .with_imported_content(message_ordinal, reference, move |reader| {
            struct Stopped<'a> {
                reader: &'a mut dyn std::io::Read,
                stop: tokio_util::sync::CancellationToken,
            }
            impl std::io::Read for Stopped<'_> {
                fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                    if self.stop.is_cancelled() {
                        return Err(std::io::Error::other("history read cancelled"));
                    }
                    self.reader.read(bytes)
                }
            }
            serde_json::from_reader(std::io::BufReader::new(Stopped {
                reader,
                stop: cancelled,
            }))
            .map_err(maka_event_log::StoreError::Json)
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut row = projection::Row {
        continuation: None,
        visible: true,
        chunk: wire::Chunk {
            order,
            position: address,
            run_id: None,
            model_part: None,
            has_references: false,
            quotes: Vec::new(),
            final_output: false,
            final_answer: false,
            model: None,
            origin: None,
            compaction: None,
            timing: None,
            folded_work: None,
            field: wire::HistoryField::Body,
            imported_turn: Some(message.turn_ordinal),
            message_id: message.source_message_id.clone(),
            turn_id: message.source_turn_id.clone(),
            timestamp: message.timestamp,
            role: match message.role {
                HistoricalRole::System => Role::System,
                HistoricalRole::User => Role::User,
                HistoricalRole::Assistant => Role::Assistant,
                HistoricalRole::Tool => Role::Tool,
                HistoricalRole::Context => Role::Context,
            },
            offset: 0,
            total_bytes: 0,
            text: String::new(),
            tool: None,
            attachments: Vec::new(),
        },
        body: projection::Body::Empty,
        fields: Vec::new(),
    };
    match header {
        Header::Input { content } => {
            let text = if content.display_text.is_some() {
                "display_text"
            } else {
                "text"
            };
            row.chunk.quotes = projection::quotes(content.quotes.as_deref().unwrap_or_default());
            let has_references = !row.chunk.quotes.is_empty()
                || content
                    .directory_references
                    .is_some_and(|value| !value.is_empty())
                || content
                    .inline_references
                    .is_some_and(|value| !value.is_empty());
            projection::input(
                &mut row,
                field(reference, &["content", text], false),
                content.attachments.unwrap_or_default(),
                has_references,
            );
        }
        Header::Model {
            part: Model::Text { text_kind },
        } => {
            let source_field = if text_kind == TextKind::Thinking {
                row.chunk.field = wire::HistoryField::Thinking;
                SourceField::Thinking
            } else {
                SourceField::Body
            };
            row.body = projection::Body::Field(source_field);
            row.fields
                .push((source_field, field(reference, &["part", "text"], false)));
        }
        Header::Model {
            part: Model::Source { source },
        } => {
            let text = match source {
                Citation::Url { url, title, .. } => {
                    title.map_or_else(|| url.clone(), |title| format!("[{title}]({url})"))
                }
                Citation::Document {
                    title, filename, ..
                } => filename.map_or(title.clone(), |name| format!("{title} ({name})")),
            };
            row.body = projection::Body::Text(text.into());
            row.fields.push((
                SourceField::Body,
                field(reference, &["part", "source"], false),
            ));
        }
        Header::Model {
            part: Model::ToolCall { call },
        } => {
            tool(&mut row.chunk, call.id, call.name.clone(), None);
            row.fields.push((
                SourceField::ToolName,
                projection::Field::Text(call.name.into()),
            ));
            row.fields.push((
                SourceField::Arguments,
                field(reference, &["part", "call", "input"], false),
            ));
        }
        Header::Model {
            part: Model::ToolResult { id, name, is_error },
        } => {
            row.fields.push((
                SourceField::ToolName,
                projection::Field::Text(name.clone().into()),
            ));
            tool(&mut row.chunk, id, name, Some(is_error));
            row.fields.push((
                SourceField::Result,
                field(reference, &["part", "output"], false),
            ));
        }
        Header::ToolReturn {
            call_id,
            name,
            result,
        } => {
            row.fields.push((
                SourceField::ToolName,
                projection::Field::Text(name.clone().into()),
            ));
            tool(&mut row.chunk, call_id, name, Some(result.body.is_error));
            row.fields
                .push((SourceField::Result, field(reference, &["result"], true)));
        }
    }
    if let Some(metadata) = &message.provider_metadata {
        row.fields
            .push((SourceField::ProviderMetadata, field(metadata, &[], false)));
    }
    row.fields
        .push((SourceField::Original, field(&message.original, &[], false)));
    Ok(row)
}
