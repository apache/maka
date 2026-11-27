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
use super::*;
use crate::recall::Field;
use crate::store::invalid;
use maka_agent_facts::history::HistoryRowAddress;
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;

pub(super) enum BodySource<'a> {
    Blob {
        blob: rusqlite::blob::Blob<'a>,
        offset: usize,
        len: usize,
    },
    Bytes(Vec<u8>),
}

impl BodySource<'_> {
    pub(super) fn len(&self) -> usize {
        match self {
            Self::Blob { len, .. } => *len,
            Self::Bytes(bytes) => bytes.len(),
        }
    }

    pub(super) fn read_at_exact(&self, buf: &mut [u8], offset: usize) -> Result<(), StoreError> {
        match self {
            Self::Blob {
                blob,
                offset: base,
                len,
            } => {
                let end = offset
                    .checked_add(buf.len())
                    .ok_or_else(|| invalid("evidence excerpt offset overflow"))?;
                if end > *len {
                    return Err(invalid("evidence excerpt exceeds indexed slice"));
                }
                blob.read_at_exact(buf, base + offset)?;
                Ok(())
            }
            Self::Bytes(bytes) => {
                let end = offset
                    .checked_add(buf.len())
                    .ok_or_else(|| invalid("evidence excerpt offset overflow"))?;
                let slice = bytes
                    .get(offset..end)
                    .ok_or_else(|| invalid("evidence excerpt exceeds reconstructed body"))?;
                buf.copy_from_slice(slice);
                Ok(())
            }
        }
    }
}

pub(super) struct IndexedBody<'a> {
    pub(super) body: BodySource<'a>,
    pub(super) fields: Vec<crate::recall::FieldSpan>,
}

impl<'a> IndexedBody<'a> {
    pub(super) fn load(
        c: &'a Connection,
        owner: &RunOwner,
        fact: FactId,
        item_index: u64,
    ) -> Result<Option<Self>, StoreError> {
        let owner_json = serde_json::to_string(owner)?;
        let mut stmt = c.prepare_cached(
            "SELECT d.id,d.fields_json,h.session,h.sequence,d.body_ref_sequence,d.body_ref_start,d.body_ref_end
             FROM agent_session_history h
             CROSS JOIN agent_recall_messages d ON d.owner=h.owner AND d.session=h.session AND d.sequence=h.sequence
             WHERE h.fact_id=?1 AND h.owner=?2 AND d.ordinal=?3",
        )?;
        let source = stmt
            .query_row(
                params![
                    fact.to_string(),
                    owner_json,
                    super::sql::bind_u64(item_index)?
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        super::sql::read_u64(row, 3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, fields_json, session, sequence, ref_seq, ref_start, ref_end)) = source else {
            return Ok(None);
        };
        let fields: Vec<crate::recall::FieldSpan> = serde_json::from_str(&fields_json)?;
        let body = match (ref_seq, ref_start, ref_end) {
            (None, _, _) => {
                let blob = c.blob_open("main", "agent_recall_messages", "body", id, true)?;
                let len = blob.len();
                BodySource::Blob {
                    blob,
                    offset: 0,
                    len,
                }
            }
            (Some(ref_seq), Some(start), Some(end)) => {
                let start =
                    usize::try_from(start).map_err(|_| invalid("negative body_ref_start"))?;
                let end = usize::try_from(end).map_err(|_| invalid("negative body_ref_end"))?;
                let len = end
                    .checked_sub(start)
                    .ok_or_else(|| invalid("corrupt body_ref span"))?;
                let target_id = crate::recall::index::resolve_body_ref_target_id(
                    c,
                    &owner_json,
                    &session,
                    ref_seq,
                )?;
                let blob = c.blob_open("main", "agent_recall_messages", "body", target_id, true)?;
                if start.checked_add(len).is_none_or(|e| e > blob.len()) {
                    return Err(invalid("body_ref slice exceeds target body length"));
                }
                BodySource::Blob {
                    blob,
                    offset: start,
                    len,
                }
            }
            (Some(ref_seq), None, ref_end) => {
                let text = crate::recall::index::resolve_body_ref(
                    c,
                    &owner_json,
                    &session,
                    sequence,
                    ref_seq,
                    None,
                    ref_end,
                )?;
                BodySource::Bytes(text.into_bytes())
            }
            (Some(_), Some(_), None) => {
                return Err(invalid("corrupt body_ref missing end offset"));
            }
        };
        Ok(Some(Self { body, fields }))
    }
}

#[derive(Clone, Copy)]
pub enum ProjectedField {
    /// The producer and display select the same last field of this kind.
    Last(Field),
    /// The display decodes a JSON string and the index includes its quotes.
    JsonString(Field),
    /// Find an unambiguous field by its complete byte representation.
    Complete(Field),
}

impl ProjectedField {
    pub fn json_value(field: Field, is_string: bool) -> Self {
        if is_string {
            Self::JsonString(field)
        } else {
            Self::Last(field)
        }
    }

    pub fn excerpt(
        self,
        position: &HistoryRowAddress,
        offset: u64,
        total_bytes: u64,
        text: &str,
    ) -> Option<ProjectedExcerpt> {
        if matches!(self, Self::Complete(_)) && (offset != 0 || total_bytes != text.len() as u64) {
            return None;
        }
        Some(ProjectedExcerpt {
            position: position.clone(),
            field: self,
            offset,
            total_bytes,
            text: text.to_owned(),
        })
    }
}

pub struct ProjectedExcerpt {
    position: HistoryRowAddress,
    field: ProjectedField,
    offset: u64,
    total_bytes: u64,
    text: String,
}

impl IndexedBody<'_> {
    fn excerpt_start(&self, excerpt: &ProjectedExcerpt) -> Result<Option<u64>, StoreError> {
        // A JSON string with exactly two extra bytes has no escapes in its payload.
        let (field, last_only, quotes) = match excerpt.field {
            ProjectedField::Last(field) => (field, true, 0),
            ProjectedField::JsonString(field) => (field, true, 1),
            ProjectedField::Complete(field) => (field, false, 0),
        };
        let mut original = vec![0; excerpt.text.len()];
        let mut found = None;
        for span in self.fields.iter().rev().filter(|s| s.field == field) {
            if !span.internal
                && span.end <= self.body.len()
                && span.end.checked_sub(span.start).map(|n| n as u64)
                    == excerpt.total_bytes.checked_add(2 * quotes)
                && excerpt.offset.saturating_add(excerpt.text.len() as u64) <= excerpt.total_bytes
            {
                let start = span.start + quotes as usize;
                self.body
                    .read_at_exact(&mut original, start + excerpt.offset as usize)?;
                if original == excerpt.text.as_bytes() {
                    if found.is_some() {
                        return Ok(None);
                    }
                    found = Some(start as u64);
                }
            }
            if last_only {
                break;
            }
        }
        Ok(found)
    }
}

struct ExcerptOffsets(RunOwner, Vec<ProjectedExcerpt>);

impl SessionHistory {
    pub async fn excerpt_offsets(
        &self,
        excerpts: Vec<ProjectedExcerpt>,
    ) -> Result<BTreeMap<HistoryRowAddress, u64>, StoreError> {
        if excerpts.is_empty() {
            return Ok(BTreeMap::new());
        }
        self.data
            .query(ExcerptOffsets(self.namespace.owner.clone(), excerpts))
            .await
    }
}

impl Query for ExcerptOffsets {
    type Output = BTreeMap<HistoryRowAddress, u64>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut offsets = BTreeMap::new();
        for excerpt in self.1 {
            let (fact, index) = match excerpt.position {
                HistoryRowAddress::Live {
                    fact, item_index, ..
                }
                | HistoryRowAddress::Snapshot {
                    fact, item_index, ..
                } => (fact, item_index),
                HistoryRowAddress::Imported { .. } => continue,
            };
            if let Some(body) = IndexedBody::load(c, &self.0, fact, index)?
                && let Some(start) = body.excerpt_start(&excerpt)?
            {
                offsets.insert(excerpt.position, start);
            }
        }
        Ok(offsets)
    }
}

#[cfg(test)]
#[test]
fn complete_results_require_a_unique_byte_match_but_frontend_selected_text_can_be_paged()
-> Result<(), StoreError> {
    use crate::recall::FieldSpan;
    let c = Connection::open_in_memory()?;
    c.execute_batch("CREATE TABLE docs(body TEXT); INSERT INTO docs VALUES ('west east west');")?;
    let blob = c.blob_open("main", "docs", "body", 1, true)?;
    let len = blob.len();
    let body = IndexedBody {
        body: BodySource::Blob {
            blob,
            offset: 0,
            len,
        },
        fields: [0, 5, 10]
            .map(|start| FieldSpan {
                field: Field::Result,
                start,
                end: start + 4,
                internal: false,
            })
            .to_vec(),
    };
    let mut excerpt = ProjectedExcerpt {
        position: HistoryRowAddress::Live {
            sequence: 1,
            fact: FactId::new(),
            item_index: 0,
        },
        field: ProjectedField::Complete(Field::Result),
        offset: 0,
        total_bytes: 4,
        text: "east".into(),
    };
    assert_eq!(body.excerpt_start(&excerpt)?, Some(5));
    excerpt.text = "west".into();
    assert_eq!(body.excerpt_start(&excerpt)?, None);
    excerpt.field = ProjectedField::Last(Field::Result);
    excerpt.offset = 1;
    excerpt.text = "es".into();
    assert_eq!(body.excerpt_start(&excerpt)?, Some(10));
    Ok(())
}

#[cfg(test)]
#[test]
fn quoted_json_windows_preserve_byte_coordinates_only_without_escapes() -> Result<(), StoreError> {
    use crate::recall::FieldSpan;
    let c = Connection::open_in_memory()?;
    c.execute_batch("CREATE TABLE docs(body TEXT)")?;
    let position = HistoryRowAddress::Live {
        sequence: 1,
        fact: FactId::new(),
        item_index: 0,
    };
    for (text, expected) in [("ab中文cd", Some(5)), ("ab中文\ncd", None)] {
        let encoded = serde_json::to_string(text)?;
        c.execute(
            "INSERT OR REPLACE INTO docs(rowid,body) VALUES(1,?1)",
            [format!("tool{encoded}")],
        )?;
        let blob = c.blob_open("main", "docs", "body", 1, true)?;
        let len = blob.len();
        let indexed = IndexedBody {
            body: BodySource::Blob {
                blob,
                offset: 0,
                len,
            },
            fields: vec![FieldSpan {
                field: Field::Arguments,
                start: 4,
                end: 4 + encoded.len(),
                internal: false,
            }],
        };
        let excerpt = ProjectedField::JsonString(Field::Arguments)
            .excerpt(&position, 2, text.len() as u64, "中文")
            .unwrap();
        assert_eq!(indexed.excerpt_start(&excerpt)?, expected);
    }
    Ok(())
}
