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
enum StoredOutput<Id = ContentId> {
    Json {
        value: Id,
    },
    Text {
        text: Id,
    },
    Model {
        value: Id,
    },
    Operation {
        reference: RecoveryRef,
        cleanup: OperationCleanup,
        value: Id,
    },
    Mcp {
        content: Vec<StoredBlock<Id>>,
        structured_content: Option<Id>,
    },
    Image {
        image: ImageOutput,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredBlock<Id = ContentId> {
    Block {
        value: Id,
    },
    Text {
        text: Id,
    },
    Image {
        media: StoredMedia<Id>,
        mime_type: String,
    },
    Audio {
        media: StoredMedia<Id>,
        mime_type: String,
    },
    Resource {
        uri: String,
        mime_type: Option<String>,
        text: Option<Id>,
        blob: Option<StoredMedia<Id>>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "encoding", rename_all = "snake_case")]
enum StoredMedia<Id = ContentId> {
    Base64 { content: Id },
    Literal { content: Id },
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

#[derive(Clone, Copy, Serialize)]
struct AtomId(usize);

struct Atom {
    digest: String,
    bytes: Vec<u8>,
}

struct Builder {
    atoms: Vec<Atom>,
}
impl Builder {
    fn bytes(&mut self, bytes: Vec<u8>) -> AtomId {
        let id = AtomId(self.atoms.len());
        self.atoms.push(Atom {
            digest: maka_agent_facts::artifact::content_digest(&bytes),
            bytes,
        });
        id
    }
    fn json(&mut self, value: &impl Serialize) -> Result<AtomId, StoreError> {
        Ok(self.bytes(serde_json::to_vec(value)?))
    }
    fn media(&mut self, data: String) -> Result<StoredMedia<AtomId>, StoreError> {
        if let Ok(bytes) = STANDARD.decode(&data)
            && STANDARD.encode(&bytes) == data
        {
            Ok(StoredMedia::Base64 {
                content: self.bytes(bytes),
            })
        } else {
            Ok(StoredMedia::Literal {
                content: self.json(&data)?,
            })
        }
    }
    fn output(&mut self, output: ToolOutput) -> Result<StoredOutput<AtomId>, StoreError> {
        Ok(match output {
            ToolOutput::Json(value) => StoredOutput::Json {
                value: self.json(&value)?,
            },
            ToolOutput::Text(text) => StoredOutput::Text {
                text: self.json(&text)?,
            },
            ToolOutput::Model(value) => StoredOutput::Model {
                value: self.json(&value)?,
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
                    value: self.json(&value)?,
                }
            }
            ToolOutput::Mcp(result) => {
                let mut content = Vec::with_capacity(result.content.len());
                for block in result.content {
                    let stored = match block {
                        ContentBlock::Text { text } => StoredBlock::Text {
                            text: self.json(&text)?,
                        },
                        ContentBlock::Image { data, mime_type } => StoredBlock::Image {
                            media: self.media(data)?,
                            mime_type,
                        },
                        ContentBlock::Audio { data, mime_type } => StoredBlock::Audio {
                            media: self.media(data)?,
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
                                Some(self.json(&text)?)
                            } else {
                                None
                            },
                            blob: if let Some(blob) = blob {
                                Some(self.media(blob)?)
                            } else {
                                None
                            },
                        },
                        block => StoredBlock::Block {
                            value: self.json(&block)?,
                        },
                    };
                    content.push(stored);
                }
                let structured_content = if let Some(value) = result.structured_content {
                    Some(self.json(&value)?)
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

pub(crate) struct PreparedToolMaterial {
    atoms: Vec<Atom>,
    descriptor: StoredOutput<AtomId>,
    raw_bytes: usize,
    raw_digest: String,
}
impl PreparedToolMaterial {
    pub(crate) fn new(bytes: &[u8], raw_digest: &str) -> Result<Self, StoreError> {
        let mut builder = Builder { atoms: Vec::new() };
        let descriptor = builder.output(serde_json::from_slice(bytes)?)?;
        Ok(Self {
            atoms: builder.atoms,
            descriptor,
            raw_bytes: bytes.len(),
            raw_digest: raw_digest.to_owned(),
        })
    }
    pub(crate) fn store(
        self,
        connection: &rusqlite::Connection,
        event: &str,
    ) -> Result<(), StoreError> {
        let mut ids = Vec::with_capacity(self.atoms.len());
        for atom in self.atoms {
            ids.push(ContentId(crate::content::put(
                connection,
                &atom.digest,
                &atom.bytes,
            )?));
        }
        let descriptor = self.descriptor.map_ids(&|AtomId(index)| ids[index]);
        let encoded = serde_json::to_vec(&descriptor)?;
        let digest = maka_agent_facts::artifact::content_digest(&encoded);
        let content = crate::content::put(connection, &digest, &encoded)?;
        connection.prepare_cached("INSERT INTO tool_result_payloads(event_id,content_id,raw_bytes,raw_digest) VALUES(?,?,?,?)")?
            .execute(rusqlite::params![event, content, self.raw_bytes as i64, self.raw_digest])?;
        for ContentId(id) in ids.into_iter().collect::<BTreeSet<_>>() {
            connection
                .prepare_cached("INSERT INTO tool_result_parts(event_id,content_id) VALUES(?,?)")?
                .execute(rusqlite::params![event, id])?;
        }
        Ok(())
    }
}

impl<Id> StoredMedia<Id> {
    fn map_ids<Next>(self, map: &impl Fn(Id) -> Next) -> StoredMedia<Next> {
        match self {
            Self::Base64 { content } => StoredMedia::Base64 {
                content: map(content),
            },
            Self::Literal { content } => StoredMedia::Literal {
                content: map(content),
            },
        }
    }
}
impl<Id> StoredBlock<Id> {
    fn map_ids<Next>(self, map: &impl Fn(Id) -> Next) -> StoredBlock<Next> {
        match self {
            Self::Block { value } => StoredBlock::Block { value: map(value) },
            Self::Text { text } => StoredBlock::Text { text: map(text) },
            Self::Image { media, mime_type } => StoredBlock::Image {
                media: media.map_ids(map),
                mime_type,
            },
            Self::Audio { media, mime_type } => StoredBlock::Audio {
                media: media.map_ids(map),
                mime_type,
            },
            Self::Resource {
                uri,
                mime_type,
                text,
                blob,
            } => StoredBlock::Resource {
                uri,
                mime_type,
                text: text.map(map),
                blob: blob.map(|media| media.map_ids(map)),
            },
        }
    }
}
impl<Id> StoredOutput<Id> {
    fn map_ids<Next>(self, map: &impl Fn(Id) -> Next) -> StoredOutput<Next> {
        match self {
            Self::Json { value } => StoredOutput::Json { value: map(value) },
            Self::Text { text } => StoredOutput::Text { text: map(text) },
            Self::Model { value } => StoredOutput::Model { value: map(value) },
            Self::Image { image } => StoredOutput::Image { image },
            Self::Operation {
                reference,
                cleanup,
                value,
            } => StoredOutput::Operation {
                reference,
                cleanup,
                value: map(value),
            },
            Self::Mcp {
                content,
                structured_content,
            } => StoredOutput::Mcp {
                content: content
                    .into_iter()
                    .map(|block| block.map_ids(map))
                    .collect(),
                structured_content: structured_content.map(map),
            },
        }
    }
}

pub(super) fn store(
    connection: &rusqlite::Connection,
    event: &str,
    bytes: &[u8],
    raw_digest: &str,
) -> Result<(), StoreError> {
    PreparedToolMaterial::new(bytes, raw_digest)?.store(connection, event)
}

pub(super) fn read_on_handle(db: &RawConnection, event: &str) -> Result<ToolOutput, StoreError> {
    let descriptor:Vec<u8>=db.query_row("SELECT c.payload FROM tool_result_payloads p JOIN contents c ON c.id=p.content_id WHERE event_id=?",[event],|row|row.get(0))?;
    let mut statement=db.prepare("SELECT c.id,c.payload FROM tool_result_parts p JOIN contents c ON c.id=p.content_id WHERE event_id=?")?;
    let values = statement
        .query_map([event], |row| Ok((ContentId(row.get(0)?), row.get(1)?)))?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    serde_json::from_slice::<StoredOutput>(&descriptor)?.decode(&values)
}

pub(crate) fn encode(
    connection: &rusqlite::Connection,
    event: &str,
) -> Result<Vec<u8>, StoreError> {
    let descriptor:Vec<u8>=connection.prepare_cached("SELECT c.payload FROM tool_result_payloads p JOIN contents c ON c.id=p.content_id WHERE event_id=?")?.query_row(rusqlite::params![event], |row| row.get(0))?;
    let values:Vec<(i64,Vec<u8>)>=connection.prepare_cached("SELECT c.id,c.payload FROM tool_result_parts p JOIN contents c ON c.id=p.content_id WHERE event_id=?")?.query_map(rusqlite::params![event], |row| Ok((row.get(0)?, row.get(1)?,)))?.collect::<Result<Vec<_>, _>>()?;
    let values = values
        .into_iter()
        .map(|(id, bytes)| (ContentId(id), bytes))
        .collect();
    Ok(serde_json::to_vec(
        &serde_json::from_slice::<StoredOutput>(&descriptor)?.decode(&values)?,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_tool_material_roundtrips_shared_and_literal_media_with_existing_content() {
        let output = ToolOutput::Mcp(CallResult {
            content: vec![
                ContentBlock::Text {
                    text: "shared".into(),
                },
                ContentBlock::Text {
                    text: "shared".into(),
                },
                ContentBlock::Image {
                    data: "AAEC".into(),
                    mime_type: "image/png".into(),
                },
                ContentBlock::Audio {
                    data: "literal media".into(),
                    mime_type: "audio/wav".into(),
                },
                ContentBlock::Resource {
                    uri: "resource:test".into(),
                    mime_type: None,
                    text: Some("resource text".into()),
                    blob: Some("AAEC".into()),
                },
            ],
            structured_content: Some(serde_json::Value::Null),
        });
        let bytes = serde_json::to_vec(&output).unwrap();
        let prepared =
            PreparedToolMaterial::new(&bytes, &maka_agent_facts::artifact::content_digest(&bytes))
                .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE contents(id INTEGER PRIMARY KEY,content_sha256 TEXT NOT NULL UNIQUE,payload BLOB NOT NULL);
            CREATE TABLE tool_result_payloads(event_id TEXT PRIMARY KEY,content_id INTEGER,raw_bytes INTEGER,raw_digest TEXT);
            CREATE TABLE tool_result_parts(event_id TEXT,content_id INTEGER,PRIMARY KEY(event_id,content_id));
            INSERT INTO contents VALUES(37,'existing',X'00');").unwrap();
        prepared.store(&db, "settled").unwrap();
        assert_eq!(read_on_handle(&db, "settled").unwrap(), output);
        assert_eq!(encode(&db, "settled").unwrap(), bytes);
    }
}
