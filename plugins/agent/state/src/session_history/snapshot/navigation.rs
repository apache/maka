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
//! Rebuildable navigation over this actual immutable Snapshot.
use super::catalog::{self, CatalogBuilder};
use super::*;
use crate::recall::{Field, Role};
use crate::session_history::source_tree::{HistoryDataSource, SourceTree};
use maka_agent_facts::{
    history_snapshot::{ImportedTurnOrdinal, SnapshotPosition},
    message::MessageOrigin,
};
use tokio_util::sync::CancellationToken;
mod produce;
mod query;
pub(in crate::session_history) use query::{FindInput, LocalFindPage, LocalFound, LocalLandmark};
const VERSION: i64 = 3;
const CHUNK_BYTES: usize = 32 * 1024;

pub(super) fn key(row: &SnapshotPosition) -> (&'static str, u64, u64) {
    match row {
        SnapshotPosition::Canonical {
            sequence,
            item_index,
            ..
        } => ("canonical", *sequence, *item_index),
        SnapshotPosition::Imported {
            message_ordinal,
            part_ordinal,
            ..
        } => ("imported", *message_ordinal, *part_ordinal),
    }
}
pub(super) fn check(stop: &CancellationToken) -> Result<(), StoreError> {
    if stop.is_cancelled() {
        return Err(invalid("source navigation cancelled"));
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub(super) enum AuthorRole {
    Canonical(Role),
    Imported(maka_agent_facts::history_snapshot::HistoricalRole),
}
pub(super) struct Metadata {
    pub turn: Option<String>,
    pub imported_turn: Option<ImportedTurnOrdinal>,
    pub role: AuthorRole,
    pub origin: Option<MessageOrigin>,
}
impl Snapshot {
    /// Cold rebuild only. No canonical doc/payload is created, and cancellation
    /// never exposes an incomplete index as an empty search result.
    pub async fn ensure_navigation(&self, stop: CancellationToken) -> Result<(), StoreError> {
        check(&stop)?;
        let tree = SourceTree::snapshot(self).await?;
        for section in tree.sections() {
            check(&stop)?;
            let HistoryDataSource::Snapshot(source) = &section.source else {
                return Err(invalid("immutable source tree contains a live source"));
            };
            source.ensure_leaf_navigation(stop.clone()).await?;
        }
        Ok(())
    }
    async fn ensure_leaf_navigation(&self, stop: CancellationToken) -> Result<(), StoreError> {
        if self.data.query(Ready(self.clone())).await? {
            return Ok(());
        }
        self.ensure_metrics_metadata(stop.clone()).await?;
        let mut after = None;
        let mut first = true;
        let mut producer = produce::Producer::new(self.clone(), stop.clone()).await?;
        loop {
            check(&stop)?;
            let rows = self.positions(after, false, true, 0, 256).await?;
            let full = rows.len() == 256;
            let mut last = after;
            for row in rows {
                let (_, major, minor) = key(&row);
                if !first && Some((major, minor)) == after {
                    continue;
                }
                producer.document(&row).await?;
                last = Some((major, minor));
            }
            if !full {
                break;
            }
            if last == after {
                return Err(invalid("navigation source positions made no progress"));
            }
            after = last;
            first = false;
        }
        check(&stop)?;
        self.data
            .write(Write {
                snapshot: self.clone(),
                edit: Edit::Complete {
                    catalog: producer.finish().await?,
                },
            })
            .await?;
        Ok(())
    }
}
struct Ready(Snapshot);
impl Query for Ready {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        read::Header(self.0.clone()).execute(c)?;
        Ok(c.query_row(
            "SELECT version FROM agent_history_snapshot_nav_heads WHERE snapshot=?",
            [self.0.id.to_string()],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
            == Some(VERSION)
            && catalog::is_ready(c, &self.0)?)
    }
}
pub(super) fn require_ready(c: &Connection, snapshot: &Snapshot) -> Result<Manifest, StoreError> {
    let manifest = read::Header(snapshot.clone()).execute(c)?;
    let ready = c
        .query_row(
            "SELECT version FROM agent_history_snapshot_nav_heads WHERE snapshot=?",
            [snapshot.id.to_string()],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    if ready != Some(VERSION) || !catalog::is_ready(c, snapshot)? {
        return Err(invalid(
            "snapshot navigation index is unavailable; rebuild required",
        ));
    }
    Ok(manifest)
}
enum Edit {
    Document {
        row: SnapshotPosition,
        metadata: Metadata,
    },
    Field {
        document: i64,
        ordinal: u64,
        field: Field,
        internal: bool,
    },
    Chunk {
        document: i64,
        field: u64,
        ordinal: u64,
        start: u64,
        body: String,
        grams: String,
    },
    FieldEnd {
        document: i64,
        ordinal: u64,
        bytes: u64,
    },
    DocumentEnd {
        document: i64,
        label: String,
    },
    Complete {
        catalog: CatalogBuilder,
    },
}
struct Write {
    snapshot: Snapshot,
    edit: Edit,
}
impl Statement for Write {
    type Value = i64;
    type Output = i64;
    fn execute(self, c: &Connection) -> Result<Prepared<i64>, StoreError> {
        read::Header(self.snapshot.clone()).execute(c)?;
        let value = match self.edit {
            Edit::Document { row, metadata } => {
                let (kind, major, minor) = key(&row);
                c.execute("INSERT INTO agent_history_snapshot_nav_documents(snapshot,kind,major,minor,turn,turn_ordinal,role,label,complete,origin_json) VALUES(?,?,?,?,?,?,?,'',0,?) ON CONFLICT(snapshot,kind,major,minor) DO NOTHING",params![self.snapshot.id.to_string(),kind,bind_u64(major)?,bind_u64(minor)?,metadata.turn,metadata.imported_turn.map(|v|bind_u64(v.0)).transpose()?,serde_json::to_string(&metadata.role)?,metadata.origin.map(|v|serde_json::to_string(&v)).transpose()?])?;
                c.query_row("SELECT id FROM agent_history_snapshot_nav_documents WHERE snapshot=? AND kind=? AND major=? AND minor=?",params![self.snapshot.id.to_string(),kind,bind_u64(major)?,bind_u64(minor)?],|r|r.get(0))?
            }
            Edit::Field {
                document,
                ordinal,
                field,
                internal,
            } => {
                owned_document(c, &self.snapshot, document)?;
                c.execute("INSERT INTO agent_history_snapshot_nav_fields(document,ordinal,field,internal,bytes) VALUES(?,?,?,?,0) ON CONFLICT(document,ordinal) DO NOTHING",params![document,bind_u64(ordinal)?,serde_json::to_string(&field)?,internal])?;
                document
            }
            Edit::Chunk {
                document,
                field,
                ordinal,
                start,
                body,
                grams,
            } => {
                owned_document(c, &self.snapshot, document)?;
                c.execute("INSERT INTO agent_history_snapshot_nav_chunks(document,field_ordinal,ordinal,start,body,grams) VALUES(?,?,?,?,?,?) ON CONFLICT(document,field_ordinal,ordinal) DO UPDATE SET start=excluded.start,body=excluded.body,grams=excluded.grams",params![document,bind_u64(field)?,bind_u64(ordinal)?,bind_u64(start)?,body,grams])?;
                document
            }
            Edit::FieldEnd {
                document,
                ordinal,
                bytes,
            } => {
                owned_document(c, &self.snapshot, document)?;
                c.execute("UPDATE agent_history_snapshot_nav_fields SET bytes=? WHERE document=? AND ordinal=?",params![bind_u64(bytes)?,document,bind_u64(ordinal)?])?;
                document
            }
            Edit::DocumentEnd { document, label } => {
                owned_document(c, &self.snapshot, document)?;
                c.execute(
                    "UPDATE agent_history_snapshot_nav_documents SET label=?,complete=1 WHERE id=?",
                    params![label, document],
                )?;
                document
            }
            Edit::Complete { catalog } => {
                let incomplete:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_positions p LEFT JOIN agent_history_snapshot_nav_documents d ON d.snapshot=p.snapshot AND d.kind=p.kind AND d.major=p.major AND d.minor=p.minor WHERE p.snapshot=? AND (d.id IS NULL OR d.complete=0))",[self.snapshot.id.to_string()],|r|r.get(0))?;
                if incomplete {
                    return Err(invalid(
                        "snapshot navigation source documents are incomplete",
                    ));
                }
                catalog.finish(c, &self.snapshot)?;
                c.execute("INSERT INTO agent_history_snapshot_nav_heads(snapshot,version) VALUES(?,?) ON CONFLICT(snapshot) DO UPDATE SET version=excluded.version",params![self.snapshot.id.to_string(),VERSION])?;
                0
            }
        };
        Ok(Prepared {
            value,
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: i64) -> i64 {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
fn owned_document(c: &Connection, snapshot: &Snapshot, document: i64) -> Result<(), StoreError> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_nav_documents WHERE snapshot=? AND id=?)",params![snapshot.id.to_string(),document],|r|r.get(0))?;
    if !exists {
        return Err(invalid("derived document belongs to another snapshot"));
    }
    Ok(())
}

pub(super) struct Document {
    snapshot: Snapshot,
    id: i64,
    next_field: u64,
    label: String,
    body_nonempty: bool,
    label_closed: bool,
    preview_requested: bool,
    preview: Option<String>,
    stop: CancellationToken,
}
impl Document {
    pub async fn new(
        snapshot: &Snapshot,
        row: &SnapshotPosition,
        metadata: Metadata,
        stop: &CancellationToken,
    ) -> Result<Self, StoreError> {
        check(stop)?;
        let id = snapshot
            .data
            .write(Write {
                snapshot: snapshot.clone(),
                edit: Edit::Document {
                    row: row.clone(),
                    metadata,
                },
            })
            .await?;
        Ok(Self {
            snapshot: snapshot.clone(),
            id,
            next_field: 0,
            label: String::new(),
            body_nonempty: false,
            label_closed: false,
            preview_requested: false,
            preview: None,
            stop: stop.clone(),
        })
    }
    fn label_bytes(&mut self, text: &str) {
        if !self.label_closed && self.label.len() < 96 {
            let end = text.floor_char_boundary((96 - self.label.len()).min(text.len()));
            self.label.push_str(&text[..end]);
            self.label_closed = end < text.len();
        }
        self.body_nonempty |= !text.is_empty();
    }
    pub async fn field(
        &mut self,
        field: Field,
        internal: bool,
    ) -> Result<FieldWriter<'_>, StoreError> {
        check(&self.stop)?;
        if !internal && self.body_nonempty {
            self.label_bytes("\n");
        }
        let ordinal = self.next_field;
        self.next_field = self
            .next_field
            .checked_add(1)
            .ok_or_else(|| invalid("document field ordinal exhausted"))?;
        self.snapshot
            .data
            .write(Write {
                snapshot: self.snapshot.clone(),
                edit: Edit::Field {
                    document: self.id,
                    ordinal,
                    field,
                    internal,
                },
            })
            .await?;
        Ok(FieldWriter {
            preview: field == Field::Body && !internal,
            internal,
            document: self,
            ordinal,
            chunk: 0,
            bytes: 0,
            buffer: Vec::with_capacity(CHUNK_BYTES + 4),
            tail: String::new(),
        })
    }
    pub async fn finish(self) -> Result<(), StoreError> {
        check(&self.stop)?;
        let label = self
            .label
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        self.snapshot
            .data
            .write(Write {
                snapshot: self.snapshot.clone(),
                edit: Edit::DocumentEnd {
                    document: self.id,
                    label,
                },
            })
            .await?;
        Ok(())
    }
}
pub(super) struct FieldWriter<'a> {
    document: &'a mut Document,
    ordinal: u64,
    chunk: u64,
    bytes: u64,
    buffer: Vec<u8>,
    tail: String,
    preview: bool,
    internal: bool,
}
impl FieldWriter<'_> {
    pub fn bytes(&self) -> u64 {
        self.bytes + self.buffer.len() as u64
    }
    pub async fn push(&mut self, mut bytes: &[u8]) -> Result<(), StoreError> {
        while !bytes.is_empty() {
            check(&self.document.stop)?;
            let count = (CHUNK_BYTES + 4 - self.buffer.len()).min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.buffer.len() >= CHUNK_BYTES {
                let valid = match std::str::from_utf8(&self.buffer) {
                    Ok(s) => s.floor_char_boundary(CHUNK_BYTES),
                    Err(e) if e.error_len().is_none() => {
                        std::str::from_utf8(&self.buffer[..e.valid_up_to()])
                            .expect("validated UTF-8 prefix")
                            .floor_char_boundary(CHUNK_BYTES.min(e.valid_up_to()))
                    }
                    Err(e) => return Err(invalid(format!("navigation field is not UTF-8: {e}"))),
                };
                if valid == 0 {
                    return Err(invalid("navigation UTF-8 chunk made no progress"));
                }
                self.flush(valid).await?;
            }
        }
        Ok(())
    }
    async fn flush(&mut self, length: usize) -> Result<(), StoreError> {
        let text =
            std::str::from_utf8(&self.buffer[..length]).map_err(|e| invalid(e.to_string()))?;
        if !self.internal {
            self.document.label_bytes(text);
        }
        if self.preview {
            if let Some(preview) = self.document.preview.as_mut() {
                let left = 160usize.saturating_sub(preview.chars().count());
                preview.extend(text.chars().take(left));
            }
        }
        let mut indexed = std::mem::take(&mut self.tail);
        indexed.push_str(text);
        self.tail = text
            .chars()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let grams = crate::recall::terms::grams(&indexed);
        self.document
            .snapshot
            .data
            .write(Write {
                snapshot: self.document.snapshot.clone(),
                edit: Edit::Chunk {
                    document: self.document.id,
                    field: self.ordinal,
                    ordinal: self.chunk,
                    start: self.bytes,
                    body: text.into(),
                    grams,
                },
            })
            .await?;
        self.bytes = self
            .bytes
            .checked_add(length as u64)
            .ok_or_else(|| invalid("document byte count overflow"))?;
        self.chunk += 1;
        self.buffer.drain(..length);
        Ok(())
    }
    pub async fn finish(mut self) -> Result<(), StoreError> {
        if !self.buffer.is_empty() {
            let n = self.buffer.len();
            self.flush(n).await?;
        }
        self.document
            .snapshot
            .data
            .write(Write {
                snapshot: self.document.snapshot.clone(),
                edit: Edit::FieldEnd {
                    document: self.document.id,
                    ordinal: self.ordinal,
                    bytes: self.bytes,
                },
            })
            .await?;
        Ok(())
    }
}
