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

//! Foreign-source evidence is streamed to an authorized publisher, never admitted as execution.
pub(crate) mod content;
pub(crate) mod lines;
use crate::{Error, Fingerprint};
use futures_util::future::BoxFuture;
use maka_agent_facts::{
    artifact::{PublishedArtifact, ToolReturn},
    attachment::{AttachmentKind, AttachmentRef, StorageRef},
    durable::SCHEMA_VERSION,
    history_snapshot::{HistoricalRole, ImportedPart, ImportedTurnOrdinal},
    import::Source,
    input::MessageInput,
    model::ModelPart,
    tool_output::{
        AudioOutput, DurableToolProjection, ImageDetail, ImageOutput, ProjectionPart,
        ReturnedToolResult, ToolOutput,
    },
};
use maka_capabilities::filesystem::PinnedFile;
use serde_json::Value;

pub struct ExactTranscript {
    pub source: Source,
    pub cwd: Option<String>,
    pub title: String,
    pub fingerprint: Fingerprint,
}

pub trait ExactSink: Send {
    /// Includes records without projected messages, such as headers and unfinished tails.
    fn record(&mut self, record: ExactRecord) -> BoxFuture<'_, Result<(), Error>>;
}

pub struct ExactRecord {
    /// Exact JSONL bytes including delimiters, or an original SQL-cell archive
    /// whose JSON data strings are retained without parsing/reserialization.
    pub raw_record: Vec<u8>,
    pub messages: Vec<ExactMessage>,
}

pub struct ExactMessage {
    pub source_message_id: Option<String>,
    pub source_turn_id: Option<String>,
    pub turn_ordinal: ImportedTurnOrdinal,
    pub timestamp: Option<u64>,
    pub role: HistoricalRole,
    pub parts: Vec<ExactPart>,
    /// Opaque source metadata, never active message options.
    pub provider_metadata: Value,
}

pub enum ExactPart {
    Input {
        content: MessageInput,
        media: Vec<ExactMedia>,
    },
    Model {
        part: ModelPart,
    },
    ToolReturn {
        call_id: String,
        name: String,
        output: ToolOutput,
        is_error: bool,
        projection: Vec<ExactContent>,
    },
}

#[expect(
    clippy::large_enum_variant,
    reason = "Imported content streams carry owned media descriptors inline without an allocation per attachment"
)]
pub enum ExactContent {
    Text(String),
    Media(ExactMedia),
}

pub struct ExactMedia {
    pub name: String,
    pub mime_type: String,
    pub detail: Option<ImageDetail>,
    pub body: MediaBody,
}

#[expect(
    clippy::large_enum_variant,
    reason = "A file body owns its pinned descriptor directly; avoid a separate allocation per imported file"
)]
pub enum MediaBody {
    Inline(Vec<u8>),
    /// An actually opened, authorized descriptor, not a source pathname.
    File(PinnedFile),
}

pub trait MediaSink: Send {
    /// The publisher returns its actual copied descriptor and payload pin.
    fn copy<'a>(
        &'a mut self,
        media: &'a ExactMedia,
    ) -> BoxFuture<'a, Result<PublishedArtifact, Error>>;
}

impl ExactPart {
    pub async fn bind(self, sink: &mut dyn MediaSink) -> Result<ImportedPart, Error> {
        match self {
            Self::Model { part } => Ok(ImportedPart::Model { part }),
            Self::Input { mut content, media } => {
                for media in media {
                    let published = copy(media, sink).await?;
                    let artifact = published.artifact;
                    let mime_type = artifact
                        .mime_type
                        .ok_or(Error::Invalid("copied input media has no MIME type"))?;
                    let attachment = AttachmentRef {
                        kind: AttachmentKind::from_metadata(&mime_type, &artifact.name),
                        name: artifact.name,
                        mime_type,
                        bytes: artifact.size_bytes,
                        storage_ref: StorageRef::SessionFile {
                            session_id: artifact.session_id,
                            relative_path: artifact.id,
                        },
                    };
                    content
                        .attachments
                        .get_or_insert_with(Vec::new)
                        .push(attachment);
                }
                Ok(ImportedPart::Input { content })
            }
            Self::ToolReturn {
                call_id,
                name,
                output,
                is_error,
                projection,
            } => {
                let mut parts = Vec::new();
                let mut artifacts = Vec::new();
                for part in projection {
                    match part {
                        ExactContent::Text(text) => parts.push(ProjectionPart::Text { text }),
                        ExactContent::Media(media) => {
                            let mime_type = media.mime_type.clone();
                            let detail = media.detail;
                            let published = copy(media, sink).await?;
                            let reference = StorageRef::SessionFile {
                                session_id: published.artifact.session_id.clone(),
                                relative_path: published.artifact.id.clone(),
                            };
                            parts.push(if mime_type.starts_with("image/") {
                                ProjectionPart::Artifact {
                                    image: ImageOutput {
                                        detail,
                                        mime_type,
                                        reference,
                                    },
                                }
                            } else if mime_type.starts_with("audio/") {
                                ProjectionPart::Audio {
                                    audio: AudioOutput {
                                        mime_type,
                                        reference,
                                    },
                                }
                            } else {
                                return Err(Error::Unsupported(format!(
                                    "tool result media MIME {mime_type}"
                                )));
                            });
                            artifacts.push(published);
                        }
                    }
                }
                Ok(ImportedPart::ToolReturn {
                    call_id,
                    name,
                    result: ToolReturn {
                        schema_version: SCHEMA_VERSION,
                        artifacts,
                        body: ReturnedToolResult {
                            output,
                            projection: DurableToolProjection::Content { parts },
                            is_error,
                            loaded_tools: std::collections::BTreeSet::new(),
                        },
                    },
                })
            }
        }
    }
}

async fn copy(media: ExactMedia, sink: &mut dyn MediaSink) -> Result<PublishedArtifact, Error> {
    let result = sink.copy(&media).await;
    match media.body {
        MediaBody::Inline(_) => result,
        MediaBody::File(file) => match (result, file.close().await) {
            (Err(primary), Err(cleanup)) => Err(Error::Cleanup {
                primary: Box::new(primary),
                cleanup,
            }),
            (_, Err(cleanup)) => Err(cleanup.into()),
            (result, Ok(())) => result,
        },
    }
}
