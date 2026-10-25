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
    Artifact, Blob, Copy, CopyRequest, CopyState, Inventory, Lineage, Quote, Record, Valuation,
};
use serde::{Deserialize, Deserializer, de::Error};
use serde_json::value::RawValue;

impl<'de> Deserialize<'de> for Record {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Records are decoded only from bundle frame slices and staged JSON text.
        // Borrow the original JSON: tagged Serde Content buffering loses typed
        // f64 decoding with arbitrary_precision, and Value would lose duplicates.
        let raw = <&RawValue>::deserialize(deserializer)?;
        decode(raw.get()).map_err(D::Error::custom)
    }
}

fn decode(json: &str) -> serde_json::Result<Record> {
    // Internal-tag Content previously validated even variant-ignored values.
    maka_agent_facts::public_catalog::validate_json(json)?;
    if !json.trim_start().starts_with('{') {
        return Err(serde_json::Error::custom("expected a bundle record object"));
    }
    #[derive(Deserialize)]
    struct Tag {
        kind: String,
    }
    let tag: Tag = serde_json::from_str(json)?;
    match tag.kind.as_str() {
        "header" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                inventory: Inventory,
                source_high_water: u64,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::Header {
                inventory: fields.inventory,
                source_high_water: fields.source_high_water,
            })
        }
        "session" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                id: String,
                parent: Option<String>,
                created_at: u64,
                updated_at: u64,
                archived: bool,
                configuration: serde_json::Value,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::Session {
                id: fields.id,
                parent: fields.parent,
                created_at: fields.created_at,
                updated_at: fields.updated_at,
                archived: fields.archived,
                configuration: fields.configuration,
            })
        }
        "copy" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                request: CopyRequest,
                through: u64,
                observed_through: u64,
                lineage: Lineage,
                state: CopyState,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::Copy(Copy {
                request: fields.request,
                through: fields.through,
                observed_through: fields.observed_through,
                lineage: fields.lineage,
                state: fields.state,
            }))
        }
        "member" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                session: String,
                sequence: u64,
                archive_sequence: Option<u64>,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::Member {
                session: fields.session,
                sequence: fields.sequence,
                archive_sequence: fields.archive_sequence,
            })
        }
        "revision_source" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                session: String,
                sequence: u64,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::RevisionSource {
                session: fields.session,
                sequence: fields.sequence,
            })
        }
        "history_artifact" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                session: String,
                source_session: String,
                source_artifact: String,
                artifact: String,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::HistoryArtifact {
                session: fields.session,
                source_session: fields.source_session,
                source_artifact: fields.source_artifact,
                artifact: fields.artifact,
            })
        }
        "event" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                sequence: u64,
                json: String,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::Event {
                sequence: fields.sequence,
                json: fields.json,
            })
        }
        "accounting" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                event_id: String,
                quote: Quote,
                valuation: Option<Valuation>,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::Accounting {
                event_id: fields.event_id,
                quote: fields.quote,
                valuation: fields.valuation,
            })
        }
        "end" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                digest: String,
                frames: u64,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Record::End {
                digest: fields.digest,
                frames: fields.frames,
            })
        }
        "blob" => blob(json).map(Record::Blob),
        kind => Err(serde_json::Error::unknown_variant(
            kind,
            &[
                "header",
                "session",
                "copy",
                "member",
                "revision_source",
                "history_artifact",
                "event",
                "blob",
                "accounting",
                "end",
            ],
        )),
    }
}

fn blob(json: &str) -> serde_json::Result<Blob> {
    #[derive(Deserialize)]
    struct Tag {
        resource: String,
    }
    let tag: Tag = serde_json::from_str(json)?;
    match tag.resource.as_str() {
        "tool_result" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                #[serde(rename = "resource")]
                _resource: String,
                event_id: String,
                bytes: u64,
                digest: String,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Blob::ToolResult {
                event_id: fields.event_id,
                bytes: fields.bytes,
                digest: fields.digest,
            })
        }
        "artifact" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                #[serde(rename = "resource")]
                _resource: String,
                metadata: Artifact,
                digest: String,
                frozen_at: Option<u64>,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Blob::Artifact {
                metadata: fields.metadata,
                digest: fields.digest,
                frozen_at: fields.frozen_at,
            })
        }
        "composition" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                #[serde(rename = "resource")]
                _resource: String,
                event_id: String,
                bytes: u64,
                digest: String,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(Blob::Composition {
                event_id: fields.event_id,
                bytes: fields.bytes,
                digest: fields.digest,
            })
        }
        resource => Err(serde_json::Error::unknown_variant(
            resource,
            &["tool_result", "artifact", "composition"],
        )),
    }
}

#[cfg(test)]
mod tests;
