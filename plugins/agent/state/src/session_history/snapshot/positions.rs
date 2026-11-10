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
//! Immutable source row coordinates, copied once from actual source metadata.
use super::*;
use maka_agent_facts::{
    history_snapshot::{ImportedMessage, SnapshotPosition},
    model::TextKind,
};
use serde::Deserialize;

pub(super) fn capture(
    c: &Connection,
    scope: &HistoryNamespace,
    cut: &HistoryCut,
    builder: &mut capture::Builder<'_>,
) -> Result<(), StoreError> {
    if scope.session != cut.session {
        return Err(invalid("snapshot position cut belongs to another session"));
    }
    crate::recall::checked_source_cut(c, &scope.owner, cut)?;
    let mut statement=c.prepare_cached("SELECT d.sequence,d.ordinal,d.internal,d.run,h.admission_sequence,f.id FROM agent_recall_messages d INDEXED BY agent_recall_message_order JOIN agent_session_history h ON h.sequence=d.sequence AND h.owner=d.owner AND h.session=d.session AND h.run=d.run JOIN agent_facts f ON f.sequence=h.sequence AND f.run=h.run WHERE d.owner=? AND d.session=? AND d.sequence<=? ORDER BY d.sequence,d.ordinal")?;
    let mut rows = statement.query(params![
        serde_json::to_string(&scope.owner)?,
        scope.session,
        bind_u64(cut.through_sequence)?
    ])?;
    while let Some(row) = rows.next()? {
        builder.add(Entry::Position {
            row: SnapshotPosition::Canonical {
                run: super::super::sql::identity(row.get(3)?)?,
                sequence: read_u64(row, 0)?,
                admission_sequence: read_u64(row, 4)?,
                fact: super::super::sql::identity(row.get(5)?)?,
                item_index: read_u64(row, 1)?,
                internal: row.get(2)?,
            },
        })?;
    }
    Ok(())
}

pub(super) fn index(
    c: &Connection,
    snapshot: SnapshotId,
    row: &SnapshotPosition,
) -> Result<(), StoreError> {
    let (kind, major, minor, run, admission, fact, internal) = match row {
        SnapshotPosition::Canonical {
            run,
            sequence,
            admission_sequence,
            fact,
            item_index,
            internal,
        } => {
            if *admission_sequence == 0 || admission_sequence > sequence {
                return Err(invalid("invalid canonical snapshot row admission"));
            }
            (
                "canonical",
                *sequence,
                *item_index,
                Some(run.to_string()),
                Some(bind_u64(*admission_sequence)?),
                Some(fact.to_string()),
                *internal,
            )
        }
        SnapshotPosition::Imported {
            message_ordinal,
            part_ordinal,
            internal,
        } => (
            "imported",
            *message_ordinal,
            *part_ordinal,
            None,
            None,
            None,
            *internal,
        ),
    };
    c.execute("INSERT INTO agent_history_snapshot_positions(snapshot,kind,major,minor,run,admission_sequence,fact,internal) VALUES(?,?,?,?,?,?,?,?)",params![snapshot.to_string(),kind,bind_u64(major)?,bind_u64(minor)?,run,admission,fact,internal])?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ImportedKind {
    Input,
    Model,
    ToolReturn,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModelKind {
    Source,
    Text,
    ToolCall,
    ToolResult,
}
// Struct deserialization skips the large text/tool values directly. Internally
// tagged content enums would first buffer those values to discover their tags.
#[derive(Deserialize)]
struct PartMetadata {
    kind: ImportedKind,
    part: Option<ModelMetadata>,
}
#[derive(Deserialize)]
struct ModelMetadata {
    kind: ModelKind,
    text_kind: Option<TextKind>,
}

pub(super) fn imported(
    c: &Connection,
    snapshot: SnapshotId,
    message_ordinal: u64,
    message: &ImportedMessage,
    builder: &mut capture::Builder<'_>,
) -> Result<(), StoreError> {
    for (part_ordinal, reference) in message.parts.iter().enumerate() {
        reference.validate().map_err(invalid)?;
        let content:Option<i64>=c.query_row("SELECT b.id FROM contents b JOIN agent_history_snapshot_pins p ON p.content_id=b.id WHERE p.snapshot=? AND b.content_sha256=? AND length(b.payload)=?",params![snapshot.to_string(),reference.digest,bind_u64(reference.bytes)?],|row|row.get(0)).optional()?;
        let content = content
            .ok_or_else(|| invalid("imported position part has no actual supplied source bytes"))?;
        let metadata: PartMetadata =
            super::super::sql::read_blob(c, content, reference, |reader| {
                Ok(serde_json::from_reader(std::io::BufReader::new(reader))?)
            })?;
        let internal = match metadata.kind {
            ImportedKind::Model => {
                let part = metadata
                    .part
                    .ok_or_else(|| invalid("imported model part metadata is missing"))?;
                match part.kind {
                    ModelKind::Text => {
                        part.text_kind
                            .ok_or_else(|| invalid("imported text kind is missing"))?
                            == TextKind::Thinking
                    }
                    _ => false,
                }
            }
            _ => false,
        };
        builder.add(Entry::Position {
            row: SnapshotPosition::Imported {
                message_ordinal,
                part_ordinal: u64::try_from(part_ordinal)
                    .map_err(|_| invalid("imported part ordinal exceeds source range"))?,
                internal,
            },
        })?;
    }
    Ok(())
}

impl Snapshot {
    /// Inclusive source-coordinate keysets, in forward or reverse order. The
    /// admission floor applies only to Canonical sources, never to imported ids.
    pub async fn positions(
        &self,
        anchor: Option<(u64, u64)>,
        reverse: bool,
        include_internal: bool,
        min_admission: u64,
        limit: u32,
    ) -> Result<Vec<SnapshotPosition>, StoreError> {
        self.data
            .query(Positions {
                snapshot: self.clone(),
                anchor,
                anchor_must_exist: true,
                reverse,
                include_internal,
                min_admission,
                limit,
            })
            .await
    }
    /// A range seek only: the boundary is not a qualified source row or a grant.
    pub(in crate::session_history) async fn seek_positions(
        &self,
        anchor: Option<(u64, u64)>,
        reverse: bool,
        include_internal: bool,
        min_admission: u64,
        limit: u32,
    ) -> Result<Vec<SnapshotPosition>, StoreError> {
        self.data
            .query(Positions {
                snapshot: self.clone(),
                anchor,
                anchor_must_exist: false,
                reverse,
                include_internal,
                min_admission,
                limit,
            })
            .await
    }
}
struct Positions {
    snapshot: Snapshot,
    anchor: Option<(u64, u64)>,
    anchor_must_exist: bool,
    reverse: bool,
    include_internal: bool,
    min_admission: u64,
    limit: u32,
}
impl Query for Positions {
    type Output = Vec<SnapshotPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let limit = super::super::sql::limit(self.limit)?;
        let manifest = read::Header(self.snapshot.clone()).execute(c)?;
        let (kind, minimum, through) = match manifest.origin {
            Origin::Canonical { cut } => (
                "canonical",
                bind_u64(self.min_admission)?,
                bind_u64(cut.through_sequence)?,
            ),
            Origin::Imported { .. } => ("imported", -1, i64::MAX),
        };
        let anchor = self
            .anchor
            .map(|(major, minor)| Ok::<_, StoreError>((bind_u64(major)?, bind_u64(minor)?)))
            .transpose()?;
        if let Some((major, minor)) = anchor {
            let exists = !self.anchor_must_exist || c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_positions WHERE snapshot=? AND kind=? AND major=? AND minor=?)",params![self.snapshot.id.to_string(),kind,major,minor],|row|row.get::<_,bool>(0))?;
            if major > through || !exists {
                return Err(invalid(
                    "snapshot history anchor is not an original source row",
                ));
            }
        }
        if minimum >= through {
            return Ok(Vec::new());
        }
        let (comparison, order, edge, edge_value) = if self.reverse {
            ("<=", "DESC", "major>?", minimum)
        } else {
            (">=", "ASC", "major<=?", through)
        };
        let bound = match anchor {
            Some(anchor) if self.reverse || anchor.0 > minimum => anchor,
            _ if self.reverse => (through, i64::MAX),
            _ => (minimum + 1, 0),
        };
        let (index, visible) = if self.include_internal {
            ("", "")
        } else {
            (
                "INDEXED BY agent_history_snapshot_position_visible",
                "AND internal=0",
            )
        };
        let sql = format!(
            "SELECT major,minor,run,admission_sequence,fact,internal FROM agent_history_snapshot_positions {index} WHERE snapshot=? AND kind=? AND (major,minor){comparison}(?,?) AND {edge} AND (admission_sequence IS NULL OR admission_sequence>?) {visible} ORDER BY major {order},minor {order} LIMIT ?"
        );
        let mut statement = c.prepare_cached(&sql)?;
        let mut rows = statement.query(params![
            self.snapshot.id.to_string(),
            kind,
            bound.0,
            bound.1,
            edge_value,
            minimum,
            i64::from(limit)
        ])?;
        let mut positions = Vec::new();
        while let Some(row) = rows.next()? {
            positions.push(if kind == "canonical" {
                SnapshotPosition::Canonical {
                    run: super::super::sql::identity(row.get(2)?)?,
                    sequence: read_u64(row, 0)?,
                    admission_sequence: read_u64(row, 3)?,
                    fact: super::super::sql::identity(row.get(4)?)?,
                    item_index: read_u64(row, 1)?,
                    internal: row.get(5)?,
                }
            } else {
                SnapshotPosition::Imported {
                    message_ordinal: read_u64(row, 0)?,
                    part_ordinal: read_u64(row, 1)?,
                    internal: row.get(5)?,
                }
            });
        }
        Ok(positions)
    }
}
