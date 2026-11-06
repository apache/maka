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

//! Sequence-independent semantic directories prepared alongside canonical bytes.

use super::{
    directory::{
        codec,
        scan::{self, PayloadRoot},
    },
    invalid, source,
};
use crate::StoreError;
use maka_agent_facts::{
    event::{Fact, RuntimeEvent, ToolOutcome},
    history::{RowPosition, semantic::directory::ListKind},
    tool_output::DurableToolProjection,
};
use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::BTreeMap;

pub(crate) struct Prepared {
    pub(super) tool: Option<Fragment>,
    pub(super) model_parts: BTreeMap<u64, Fragment>,
}

pub(super) struct Fragment {
    pub(super) source: Source,
    directory: Directory,
}

pub(super) enum Source {
    CanonicalTool { offset: i64, len: i64 },
    CanonicalModel { offset: i64, len: i64 },
    Pieces(Vec<u8>),
}

struct Directory {
    root: Vec<u8>,
    bytes: i64,
    children: Vec<(ListKind, i64, Vec<u8>)>,
}

impl Prepared {
    pub(crate) fn new(event: &RuntimeEvent, json: &str) -> Result<Self, StoreError> {
        let mut prepared = Self {
            tool: None,
            model_parts: BTreeMap::new(),
        };
        match &event.fact {
            Fact::ToolSettled {
                outcome:
                    ToolOutcome::Succeeded {
                        model_projection, ..
                    },
                ..
            } => {
                let token = source::CanonicalToolProjectionSpan::token(json)?;
                let (offset, len) = span(json, token)?;
                prepared.tool = Some(
                    if source::serialized_matches(token.as_bytes(), model_projection)? {
                        Fragment {
                            source: Source::CanonicalTool { offset, len },
                            directory: Directory::new(
                                token.as_bytes(),
                                PayloadRoot::ToolProjection,
                            )?,
                        }
                    } else {
                        #[derive(Serialize)]
                        enum BorrowedPayload<'a> {
                            Tool(&'a DurableToolProjection),
                        }
                        let bytes = serde_json::to_vec(&BorrowedPayload::Tool(model_projection))?;
                        let directory = Directory::new(&bytes, PayloadRoot::Payload)?;
                        Fragment {
                            source: Source::Pieces(bytes),
                            directory,
                        }
                    },
                );
            }
            Fact::ModelObserved { .. }
            | Fact::ModelCompleted { .. }
            | Fact::ModelInterrupted { .. } => {
                for (ordinal, token) in source::model_part_tokens(json)? {
                    let (offset, len) = span(json, token)?;
                    prepared.model_parts.insert(
                        ordinal,
                        Fragment {
                            source: Source::CanonicalModel { offset, len },
                            directory: Directory::new(token.as_bytes(), PayloadRoot::ModelPart)?,
                        },
                    );
                }
            }
            _ => {}
        }
        Ok(prepared)
    }
}

fn span(json: &str, token: &str) -> Result<(i64, i64), StoreError> {
    let offset = (token.as_ptr() as usize)
        .checked_sub(json.as_ptr() as usize)
        .ok_or_else(|| invalid("prepared semantic token does not borrow its event"))?;
    offset
        .checked_add(token.len())
        .filter(|end| *end <= json.len())
        .ok_or_else(|| invalid("prepared semantic token is outside its event"))?;
    Ok((
        i64::try_from(offset).map_err(|_| invalid("semantic token offset exceeds SQLite range"))?,
        i64::try_from(token.len())
            .map_err(|_| invalid("semantic token length exceeds SQLite range"))?,
    ))
}

impl Directory {
    fn new(bytes: &[u8], root: PayloadRoot) -> Result<Self, StoreError> {
        let mut children = Vec::new();
        let mut reader = bytes;
        let (directory, bytes) = scan::payload(&mut reader, root, |kind, ordinal, child| {
            children.push((
                kind,
                i64::try_from(ordinal)
                    .map_err(|_| invalid("directory ordinal exceeds SQLite range"))?,
                codec::encode(&child)?,
            ));
            Ok(())
        })?;
        Ok(Self {
            root: codec::encode(&directory)?,
            bytes: i64::try_from(bytes)
                .map_err(|_| invalid("payload length exceeds SQLite range"))?,
            children,
        })
    }
}

impl Fragment {
    pub(super) fn bind(
        &self,
        db: &Connection,
        key: RowPosition,
    ) -> Result<(&[u8], i64), StoreError> {
        let mut insert = db.prepare_cached("INSERT INTO context_semantic_directory_children(source_sequence,source_index,list_kind,ordinal,directory_bytes) VALUES(?,?,?,?,?)")?;
        for (kind, ordinal, directory) in &self.directory.children {
            insert.execute(params![
                key.source_sequence as i64,
                key.item_index as i64,
                kind.as_str(),
                ordinal,
                directory
            ])?;
        }
        Ok((&self.directory.root, self.directory.bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        event::Invocation,
        history::semantic::directory::{
            ChildDirectory, PartDirectory, PayloadDirectory, TextSpan, ToolDirectory,
            ToolPartDirectory,
        },
        model::{
            ModelPart, TextKind,
            recorded::{ModelObservation, ModelPartRecord},
        },
        tool_output::{ProjectionPart, RawToolResultRef},
    };
    use sha2::{Digest, Sha256};
    use std::{sync::Arc, time::UNIX_EPOCH};

    fn event(fact: Fact) -> RuntimeEvent {
        RuntimeEvent::new(
            Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            fact,
        )
    }
    fn check_text(bytes: &[u8], span: TextSpan, expected: &str) {
        let token = &bytes[span.range.start as usize..(span.range.start + span.range.len) as usize];
        assert_eq!(serde_json::from_slice::<String>(token).unwrap(), expected);
        assert_eq!(span.measure.bytes, expected.len() as u64);
        assert_eq!(
            span.measure.sha256,
            <[u8; 32]>::from(Sha256::digest(expected.as_bytes()))
        );
    }

    #[test]
    fn tool_directories_follow_final_encoding_and_bind_the_assigned_sequence() {
        let text = "one\n☃";
        let projection = DurableToolProjection::Content {
            parts: vec![ProjectionPart::Text { text: text.into() }],
        };
        let event = event(Fact::ToolSettled {
            operation_id: "operation".into(),
            outcome: ToolOutcome::Succeeded {
                raw: RawToolResultRef {
                    bytes: 0,
                    digest: "fixture".into(),
                },
                model_projection: projection.clone(),
                artifacts: vec![],
                is_error: false,
            },
        });
        let canonical = serde_json::to_string(&event).unwrap();
        for normalized in [false, true] {
            let json = if normalized {
                canonical.replace("one\\n☃", "one\\u000a\\u2603")
            } else {
                canonical.clone()
            };
            let prepared = Prepared::new(&event, &json).unwrap();
            let fragment = prepared.tool.unwrap();
            let bytes = match &fragment.source {
                Source::CanonicalTool { offset, len } => {
                    &json.as_bytes()[*offset as usize..(*offset + *len) as usize]
                }
                Source::Pieces(bytes) => bytes.as_slice(),
                Source::CanonicalModel { .. } => panic!("tool requires a tool source"),
            };
            assert!(matches!(
                codec::decode::<PayloadDirectory>(&fragment.directory.root).unwrap(),
                PayloadDirectory::Tool(ToolDirectory::Content { parts: 1 })
            ));
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch("CREATE TABLE context_semantic_directory_children(source_sequence INTEGER, source_index INTEGER, list_kind TEXT, ordinal INTEGER, directory_bytes BLOB)").unwrap();
            for sequence in [41, 99] {
                fragment
                    .bind(
                        &db,
                        RowPosition {
                            source_sequence: sequence,
                            item_index: 0,
                        },
                    )
                    .unwrap();
                let child: Vec<u8> = db.query_row("SELECT directory_bytes FROM context_semantic_directory_children WHERE source_sequence=? AND source_index=0 AND list_kind='tool_parts' AND ordinal=0", [sequence as i64], |row| row.get(0)).unwrap();
                let ChildDirectory::ToolPart(ToolPartDirectory::Text(span)) =
                    codec::decode(&child).unwrap()
                else {
                    panic!("expected text child")
                };
                check_text(bytes, span, text);
            }
        }
    }

    #[test]
    fn model_part_directory_ranges_preserve_the_original_token_encoding() {
        let text = "one\n☃";
        let event = event(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::Part(ModelPartRecord {
                ordinal: 7,
                message_id: "message".into(),
                started_at: UNIX_EPOCH,
                provider_part_id: None,
                part: Arc::new(ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: text.into(),
                    provider_options: None,
                }),
            }),
        });
        let json = serde_json::to_string(&event)
            .unwrap()
            .replace("one\\n☃", "one\\u000a\\u2603");
        let prepared = Prepared::new(&event, &json).unwrap();
        let fragment = &prepared.model_parts[&7];
        let Source::CanonicalModel { offset, len } = fragment.source else {
            panic!("model part requires its original token")
        };
        let bytes = &json.as_bytes()[offset as usize..(offset + len) as usize];
        let PayloadDirectory::Part(PartDirectory::Text { text: span, .. }) =
            codec::decode(&fragment.directory.root).unwrap()
        else {
            panic!("expected text part")
        };
        check_text(bytes, span, text);
        assert!(
            std::str::from_utf8(bytes)
                .unwrap()
                .contains("\\u000a\\u2603")
        );
    }
}
