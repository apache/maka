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

//! Typed raw results retain their envelope and reference immutable value/media bytes.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::{
    capability::{CallResult, ContentBlock},
    tool_output::ImageOutput,
};
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, Receipt, RecoveryRef,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct ContentId(i64);

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredOutput {
    Json {
        value: ContentId,
    },
    Text {
        text: ContentId,
    },
    Model {
        value: ContentId,
    },
    Operation {
        reference: RecoveryRef,
        cleanup: OperationCleanup,
        value: ContentId,
    },
    Mcp {
        content: Vec<StoredBlock>,
        structured_content: Option<ContentId>,
    },
    Image {
        image: ImageOutput,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredBlock {
    Block {
        value: ContentId,
    },
    Text {
        text: ContentId,
    },
    Image {
        media: StoredMedia,
        mime_type: String,
    },
    Audio {
        media: StoredMedia,
        mime_type: String,
    },
    Resource {
        uri: String,
        mime_type: Option<String>,
        text: Option<ContentId>,
        blob: Option<StoredMedia>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "encoding", rename_all = "snake_case")]
enum StoredMedia {
    Base64 { content: ContentId },
    Literal { content: ContentId },
}
impl StoredMedia {
    fn decode(self, values: &BTreeMap<ContentId, Vec<u8>>) -> Result<String, StoreError> {
        let id = match self {
            Self::Base64 { content } | Self::Literal { content } => content,
        };
        let bytes = values.get(&id).ok_or_else(invalid)?;
        Ok(match self {
            Self::Base64 { .. } => STANDARD.encode(bytes),
            Self::Literal { .. } => serde_json::from_slice(bytes)?,
        })
    }
}

struct Builder<'a> {
    connection: &'a mut SqliteConnection,
    refs: BTreeSet<ContentId>,
}
impl Builder<'_> {
    async fn bytes(&mut self, bytes: &[u8]) -> Result<ContentId, StoreError> {
        let digest = maka_agent_facts::artifact::content_digest(bytes);
        let id = ContentId(crate::content::put(self.connection, &digest, bytes).await?);
        self.refs.insert(id);
        Ok(id)
    }
    async fn json(&mut self, value: &impl Serialize) -> Result<ContentId, StoreError> {
        self.bytes(&serde_json::to_vec(value)?).await
    }
    async fn media(&mut self, data: String) -> Result<StoredMedia, StoreError> {
        if let Ok(bytes) = STANDARD.decode(&data)
            && STANDARD.encode(&bytes) == data
        {
            Ok(StoredMedia::Base64 {
                content: self.bytes(&bytes).await?,
            })
        } else {
            Ok(StoredMedia::Literal {
                content: self.json(&data).await?,
            })
        }
    }
    async fn output(&mut self, output: ToolOutput) -> Result<StoredOutput, StoreError> {
        Ok(match output {
            ToolOutput::Json(value) => StoredOutput::Json {
                value: self.json(&value).await?,
            },
            ToolOutput::Text(text) => StoredOutput::Text {
                text: self.json(&text).await?,
            },
            ToolOutput::Model(value) => StoredOutput::Model {
                value: self.json(&value).await?,
            },
            ToolOutput::Image(image) => StoredOutput::Image { image },
            ToolOutput::Operation(reply) => {
                let OperationReply { reference, receipt } = *reply;
                let Receipt::Recorded {
                    outcome: OperationOutcome::Returned { value },
                    cleanup,
                } = receipt
                else {
                    return Err(invalid());
                };
                StoredOutput::Operation {
                    reference,
                    cleanup,
                    value: self.json(&value).await?,
                }
            }
            ToolOutput::Mcp(result) => {
                let mut content = Vec::with_capacity(result.content.len());
                for block in result.content {
                    let stored = match block {
                        ContentBlock::Text { text } => StoredBlock::Text {
                            text: self.json(&text).await?,
                        },
                        ContentBlock::Image { data, mime_type } => StoredBlock::Image {
                            media: self.media(data).await?,
                            mime_type,
                        },
                        ContentBlock::Audio { data, mime_type } => StoredBlock::Audio {
                            media: self.media(data).await?,
                            mime_type,
                        },
                        ContentBlock::Resource {
                            uri,
                            mime_type,
                            text,
                            blob,
                        } => StoredBlock::Resource {
                            uri,
                            mime_type,
                            text: if let Some(text) = text {
                                Some(self.json(&text).await?)
                            } else {
                                None
                            },
                            blob: if let Some(blob) = blob {
                                Some(self.media(blob).await?)
                            } else {
                                None
                            },
                        },
                        block => StoredBlock::Block {
                            value: self.json(&block).await?,
                        },
                    };
                    content.push(stored);
                }
                let structured_content = if let Some(value) = result.structured_content {
                    Some(self.json(&value).await?)
                } else {
                    None
                };
                StoredOutput::Mcp {
                    content,
                    structured_content,
                }
            }
        })
    }
}

impl StoredOutput {
    fn decode(self, values: &BTreeMap<ContentId, Vec<u8>>) -> Result<ToolOutput, StoreError> {
        let bytes = |id: &ContentId| values.get(id).map(Vec::as_slice).ok_or_else(invalid);
        let json = |id: &ContentId| -> Result<serde_json::Value, StoreError> {
            Ok(serde_json::from_slice(bytes(id)?)?)
        };
        Ok(match self {
            Self::Json { value } => ToolOutput::Json(json(&value)?),
            Self::Text { text } => ToolOutput::Text(serde_json::from_slice(bytes(&text)?)?),
            Self::Model { value } => ToolOutput::Model(serde_json::from_slice(bytes(&value)?)?),
            Self::Image { image } => ToolOutput::Image(image),
            Self::Operation {
                reference,
                cleanup,
                value,
            } => ToolOutput::Operation(Box::new(OperationReply {
                reference,
                receipt: Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        value: json(&value)?,
                    },
                    cleanup,
                },
            })),
            Self::Mcp {
                content,
                structured_content,
            } => ToolOutput::Mcp(CallResult {
                content: content
                    .into_iter()
                    .map(|part| {
                        Ok(match part {
                            StoredBlock::Block { value } => serde_json::from_slice(bytes(&value)?)?,
                            StoredBlock::Text { text } => ContentBlock::Text {
                                text: serde_json::from_slice(bytes(&text)?)?,
                            },
                            StoredBlock::Image { media, mime_type } => ContentBlock::Image {
                                data: media.decode(values)?,
                                mime_type,
                            },
                            StoredBlock::Audio { media, mime_type } => ContentBlock::Audio {
                                data: media.decode(values)?,
                                mime_type,
                            },
                            StoredBlock::Resource {
                                uri,
                                mime_type,
                                text,
                                blob,
                            } => ContentBlock::Resource {
                                uri,
                                mime_type,
                                text: text
                                    .map(|id| {
                                        serde_json::from_slice(bytes(&id)?)
                                            .map_err(StoreError::from)
                                    })
                                    .transpose()?,
                                blob: blob.map(|data| data.decode(values)).transpose()?,
                            },
                        })
                    })
                    .collect::<Result<_, StoreError>>()?,
                structured_content: structured_content.map(|id| json(&id)).transpose()?,
            }),
        })
    }
}

pub(super) async fn store(
    connection: &mut SqliteConnection,
    event: &str,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let mut builder = Builder {
        connection,
        refs: BTreeSet::new(),
    };
    let descriptor = builder.output(serde_json::from_slice(bytes)?).await?;
    let encoded = serde_json::to_vec(&descriptor)?;
    let digest = maka_agent_facts::artifact::content_digest(&encoded);
    let content = crate::content::put(builder.connection, &digest, &encoded).await?;
    sqlx::query("INSERT INTO tool_result_payloads(event_id,content_id,raw_bytes,raw_digest) VALUES(?,?,?,?)")
        .bind(event).bind(content).bind(bytes.len() as i64).bind(maka_agent_facts::artifact::content_digest(bytes))
        .execute(&mut *builder.connection).await?;
    for ContentId(id) in builder.refs {
        sqlx::query("INSERT INTO tool_result_parts(event_id,content_id) VALUES(?,?)")
            .bind(event)
            .bind(id)
            .execute(&mut *builder.connection)
            .await?;
    }
    Ok(())
}

pub(super) fn read_on_handle(db: &RawConnection, event: &str) -> Result<ToolOutput, StoreError> {
    let descriptor:Vec<u8>=db.query_row("SELECT c.payload FROM tool_result_payloads p JOIN contents c ON c.id=p.content_id WHERE event_id=?",[event],|row|row.get(0))?;
    let mut statement=db.prepare("SELECT c.id,c.payload FROM tool_result_parts p JOIN contents c ON c.id=p.content_id WHERE event_id=?")?;
    let values = statement
        .query_map([event], |row| Ok((ContentId(row.get(0)?), row.get(1)?)))?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    serde_json::from_slice::<StoredOutput>(&descriptor)?.decode(&values)
}

pub(crate) async fn encode(
    connection: &mut SqliteConnection,
    event: &str,
) -> Result<Vec<u8>, StoreError> {
    let descriptor:Vec<u8>=sqlx::query_scalar("SELECT c.payload FROM tool_result_payloads p JOIN contents c ON c.id=p.content_id WHERE event_id=?")
        .bind(event).fetch_one(&mut *connection).await?;
    let values:Vec<(i64,Vec<u8>)>=sqlx::query_as("SELECT c.id,c.payload FROM tool_result_parts p JOIN contents c ON c.id=p.content_id WHERE event_id=?")
        .bind(event).fetch_all(connection).await?;
    let values = values
        .into_iter()
        .map(|(id, bytes)| (ContentId(id), bytes))
        .collect();
    Ok(serde_json::to_vec(
        &serde_json::from_slice::<StoredOutput>(&descriptor)?.decode(&values)?,
    )?)
}
