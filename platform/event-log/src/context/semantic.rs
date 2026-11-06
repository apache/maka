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

//! Indexed semantic metadata with extracted pieces or canonical projection spans.
mod captured;
mod directory;
pub(crate) mod gc;
pub(crate) mod migration;
pub use captured::{
    ArtifactCapture, ArtifactIdentityValidity, ArtifactLookup, ArtifactLookupResult,
    CapturedDirectoryRow, CapturedLocalResource, CapturedRow, CapturedSource, ChildPage,
    DirectoryPage, PayloadEncoding, PayloadSource, SourceChunk, SourceDomain, SourcePage,
    SourcePosition, close_request_file, create_request_file,
};
mod source;
mod write;
pub(crate) use write::{copy_member, record};

use crate::{EventLog, StoreError};
use maka_agent_facts::history::{
    RowPosition,
    semantic::{PartPayload, Payload, PayloadKey, ResolvedRow, SemanticKind, SemanticRow},
};
use serde::{Deserialize, Serialize};
use source::SemanticPayloadSource;
use sqlx::{Connection, Row, SqliteConnection};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticSelection {
    pub session: String,
    /// The authenticated selection's immutable {base,run} descriptor.
    pub lineage: Option<String>,
    pub after: u64,
    pub through: u64,
    /// Exclusive visibility boundary for archives owned by this Session.
    pub before: u64,
    /// Physical publication watermark, distinct from the selected source cut.
    pub captured_through: u64,
    pub replay: Option<SemanticReplay>,
    pub prior_unknown: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticReplay {
    pub base: u64,
    pub current: String,
    pub route: String,
    pub model: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticCursor {
    pub order: RowPosition,
    pub id: RowPosition,
}

#[derive(Clone, Debug)]
pub struct SemanticPage {
    pub rows: Vec<SemanticRow>,
    pub next: Option<SemanticCursor>,
}

fn invalid(reason: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}

fn page_limit(limit: usize) -> Result<i64, StoreError> {
    if limit == 0 {
        return Err(invalid("semantic page limit must be positive"));
    }
    Ok(limit.min(1024) as i64)
}

/// The source cut excludes unaccepted items and unreleased notifications.
/// Archives may be published later than that cut, but are frozen by both the
/// captured publication watermark and the archive selection boundary.
fn eligible(alias: &str) -> String {
    let source =
        super::selection::Selection::lineage_contains(&format!("{alias}.invocation_id"), "?6");
    let publication = super::selection::Selection::lineage_contains(
        &format!("{alias}.revision_invocation"),
        "?6",
    );
    format!(
        "{alias}.revision<=?4 AND (
        ({alias}.archived=0 AND {alias}.revision<=?3)
        OR ({alias}.archived=1 AND ({alias}.inherited=1 OR {alias}.revision<?5)))
        AND (?6 IS NULL OR {alias}.source_sequence<=json_extract(?6,'$.base')
             OR {source})
        AND ({alias}.archived=0 OR {alias}.inherited=1 OR ?6 IS NULL
             OR {alias}.revision<=json_extract(?6,'$.base')
             OR {publication})"
    )
}

fn replay_predicate(alias: &str, parameter: &str) -> String {
    format!(
        "({parameter} IS NULL OR {alias}.kind!='assistant_part'
        OR {alias}.source_sequence<=json_extract({parameter},'$.base')
        OR {alias}.invocation_id=json_extract({parameter},'$.current')
        OR EXISTS(SELECT 1 FROM context_semantic_cuts cut
            WHERE cut.owner_session_id=?1 AND cut.invocation_id={alias}.invocation_id
              AND ({alias}.source_sequence,{alias}.source_index)<(cut.cut_sequence,cut.cut_index)
              AND cut.revision=(SELECT revision FROM context_semantic_cuts latest
                WHERE latest.owner_session_id=?1 AND latest.invocation_id=cut.invocation_id AND latest.revision<=MIN(?3,?4)
                ORDER BY revision DESC LIMIT 1)))"
    )
}

pub(crate) async fn available(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<(), StoreError> {
    available_at(connection, session, i64::MAX as u64).await
}

pub(crate) async fn available_at(
    connection: &mut SqliteConnection,
    session: &str,
    captured: u64,
) -> Result<(), StoreError> {
    let reason:Option<String> = sqlx::query_scalar("SELECT unavailable_reason FROM context_semantic_heads WHERE session_id=? AND unavailable_at<=?")
        .bind(session).bind(captured as i64).fetch_optional(connection).await?;
    if let Some(reason) = reason {
        return Err(invalid(format!(
            "semantic projection unavailable: {reason}"
        )));
    }
    Ok(())
}

pub(crate) async fn rows(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    cursor: Option<SemanticCursor>,
    limit: usize,
    group: Option<u64>,
) -> Result<SemanticPage, StoreError> {
    available_at(connection, &selection.session, selection.captured_through).await?;
    let limit = page_limit(limit)?;
    let zero = RowPosition {
        source_sequence: 0,
        item_index: 0,
    };
    let point = cursor.unwrap_or(SemanticCursor {
        order: zero,
        id: zero,
    });
    let query = rows_query(group.is_some());
    let records: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .bind(&selection.session)
        .bind(selection.after as i64)
        .bind(selection.through as i64)
        .bind(selection.captured_through as i64)
        .bind(selection.before.min(i64::MAX as u64) as i64)
        .bind(&selection.lineage)
        .bind(point.order.source_sequence as i64)
        .bind(point.order.item_index as i64)
        .bind(point.id.source_sequence as i64)
        .bind(point.id.item_index as i64)
        .bind(group.map(|value| value as i64))
        .bind(limit + 1)
        .bind(
            selection
                .replay
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .bind(selection.prior_unknown)
        .fetch_all(connection)
        .await?;
    let more = records.len() > limit as usize;
    let rows: Vec<SemanticRow> = records
        .into_iter()
        .take(limit as usize)
        .map(|json| serde_json::from_str(&json))
        .collect::<Result<_, _>>()?;
    let next = more
        .then(|| {
            rows.last().map(|row| SemanticCursor {
                order: row.order,
                id: row.id,
            })
        })
        .flatten();
    Ok(SemanticPage { rows, next })
}

fn rows_query(group: bool) -> String {
    // Keep exact group reads as direct ordered-index seeks.
    let group_filter = if group {
        "r.order_sequence=?11"
    } else {
        "?11 IS NULL"
    };
    // A source window can contain rows ordered before its source cutoff (for
    // example a late tool result). Seek each source range first, then sort only
    // that window.
    let (window, from) = if group {
        (
            String::new(),
            "context_semantic_rows r INDEXED BY context_semantic_row_order",
        )
    } else {
        (
            "WITH window AS MATERIALIZED (
            SELECT * FROM context_semantic_rows WHERE owner_session_id=?1
              AND source_sequence>?2 AND source_sequence<=?3
        ) "
            .to_owned(),
            "window r",
        )
    };
    format!(
        "{window}SELECT r.row_json FROM {from}
        WHERE r.owner_session_id=?1 AND r.source_sequence>?2 AND r.source_sequence<=?3
          AND {} AND r.visible=1 AND {} AND (?14=1 OR (r.kind!='unknown_tool' AND r.unknown_only=0))
          AND (r.order_sequence,r.order_index,r.source_sequence,r.source_index)>(?7,?8,?9,?10)
          AND {group_filter}
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n
            WHERE n.owner_session_id=r.owner_session_id AND n.source_sequence=r.source_sequence
              AND n.source_index=r.source_index AND n.revision>r.revision AND {})
        ORDER BY r.order_sequence,r.order_index,r.source_sequence,r.source_index LIMIT ?12",
        eligible("r"),
        replay_predicate("r", "?13"),
        eligible("n")
    )
}

pub(crate) async fn meaningful_history(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
) -> Result<bool, StoreError> {
    let query=format!("SELECT EXISTS(SELECT 1 FROM context_semantic_rows r WHERE r.owner_session_id=?1
        AND r.source_sequence>?2 AND r.source_sequence<=?3 AND r.kind IN ('user','assistant_part','imported_user','imported_assistant')
        AND {} AND {} AND r.visible=1
        AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
            AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision AND {}))",
        eligible("r"),replay_predicate("r","?7"),eligible("n"));
    sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .bind(&selection.session)
        .bind(selection.after as i64)
        .bind(selection.through as i64)
        .bind(selection.captured_through as i64)
        .bind(selection.before.min(i64::MAX as u64) as i64)
        .bind(&selection.lineage)
        .bind(
            selection
                .replay
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .fetch_one(connection)
        .await
        .map_err(StoreError::from)
}

async fn payload(
    connection: &mut SqliteConnection,
    key: PayloadKey,
) -> Result<Payload, StoreError> {
    let sequence = i64::try_from(key.source_sequence)
        .map_err(|_| invalid("semantic payload sequence exceeds SQLite range"))?;
    let index = i64::try_from(key.item_index)
        .map_err(|_| invalid("semantic payload index exceeds SQLite range"))?;
    crate::connection::worker_query(connection, move |worker| {
        Box::pin(async move {
            use futures_util::TryStreamExt;
            // One indexed seek handles Pieces and source metadata together. Canonical
            // fragments have no pieces, so their LEFT JOIN produces one metadata row.
            let mut records = sqlx::query(
                "SELECT f.storage_kind,f.byte_offset,f.byte_len,p.bytes
            FROM context_semantic_fragments f LEFT JOIN context_semantic_fragment_pieces p
              ON p.source_sequence=f.source_sequence AND p.source_index=f.source_index
            WHERE f.source_sequence=? AND f.source_index=? ORDER BY p.piece_index",
            )
            .bind(sequence)
            .bind(index)
            .fetch(&mut *worker);
            let first = records
                .try_next()
                .await?
                .ok_or_else(|| invalid("semantic payload is missing"))?;
            let source = SemanticPayloadSource::from_metadata(
                sequence,
                index,
                first.try_get("storage_kind")?,
                first.try_get("byte_offset")?,
                first.try_get("byte_len")?,
            )?;
            match source {
                SemanticPayloadSource::CanonicalModelPart(span) => {
                    if first.try_get::<Option<Vec<u8>>, _>("bytes")?.is_some() {
                        return Err(invalid("canonical semantic payload has extracted pieces"));
                    }
                    drop(records);
                    span.read(worker)
                }
                SemanticPayloadSource::CanonicalToolProjection(span) => {
                    if first.try_get::<Option<Vec<u8>>, _>("bytes")?.is_some() {
                        return Err(invalid("canonical semantic payload has extracted pieces"));
                    }
                    drop(records);
                    span.read(worker)
                }
                SemanticPayloadSource::Pieces => {
                    let mut bytes: Vec<u8> = first
                        .try_get::<Option<Vec<u8>>, _>("bytes")?
                        .ok_or_else(|| invalid("semantic payload is missing"))?;
                    while let Some(piece) = records.try_next().await? {
                        let piece: Vec<u8> = piece.try_get("bytes")?;
                        bytes.extend_from_slice(&piece);
                    }
                    Ok(serde_json::from_slice(&bytes)?)
                }
            }
        })
    })
    .await
}

pub(crate) async fn resolve(
    connection: &mut SqliteConnection,
    rows: Vec<SemanticRow>,
) -> Result<Vec<ResolvedRow>, StoreError> {
    let mut resolved = Vec::with_capacity(rows.len());
    for row in rows {
        let value = match &row.kind {
            SemanticKind::UnknownTool { .. } => None,
            SemanticKind::AssistantPart {
                payload: PartPayload::Complete(key),
                ..
            }
            | SemanticKind::User { payload: key, .. }
            | SemanticKind::ImportedUser { payload: key }
            | SemanticKind::ImportedAssistant { payload: key }
            | SemanticKind::ExecutorText { payload: key }
            | SemanticKind::ToolResult { payload: key, .. }
            | SemanticKind::Notification { payload: key, .. } => {
                Some(payload(connection, *key).await?)
            }
        };
        resolved.push(ResolvedRow {
            row,
            payload: value,
        });
    }
    Ok(resolved)
}

impl EventLog {
    pub async fn context_semantic_rows(
        &self,
        selection: &SemanticSelection,
        cursor: Option<SemanticCursor>,
        limit: usize,
    ) -> Result<SemanticPage, StoreError> {
        self.validate_root()?;
        let selection = selection.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move { rows(connection, &selection, cursor, limit, None).await })
            })
            .await
    }

    pub async fn context_semantic_group_rows(
        &self,
        selection: &SemanticSelection,
        group: u64,
        cursor: Option<SemanticCursor>,
        limit: usize,
    ) -> Result<SemanticPage, StoreError> {
        self.validate_root()?;
        let selection = selection.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(
                    async move { rows(connection, &selection, cursor, limit, Some(group)).await },
                )
            })
            .await
    }

    /// Explicit materialization boundary for one selected group.
    pub async fn context_semantic_resolve(
        &self,
        rows: &[SemanticRow],
    ) -> Result<Vec<ResolvedRow>, StoreError> {
        self.validate_root()?;
        let rows = rows.to_vec();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    let resolved = resolve(&mut transaction, rows).await?;
                    transaction.commit().await?;
                    Ok(resolved)
                })
            })
            .await
    }

    pub async fn context_semantic_stable_cut(
        &self,
        owner: &str,
        invocation: &str,
        through: u64,
    ) -> Result<Option<RowPosition>, StoreError> {
        self.validate_root()?;
        let invocation = invocation.to_owned();
        let owner = owner.to_owned();
        self.connection.read_interruptible(move |connection|Box::pin(async move {
            let cut:Option<(i64,i64)>=sqlx::query_as("SELECT cut_sequence,cut_index FROM context_semantic_cuts WHERE owner_session_id=? AND invocation_id=? AND revision<=? ORDER BY revision DESC LIMIT 1")
                .bind(owner).bind(invocation).bind(through as i64).fetch_optional(connection).await?;
            cut.map(|(sequence,index)|Ok(RowPosition { source_sequence:crate::sequence_number(sequence)?,item_index:crate::sequence_number(index)? })).transpose()
        })).await
    }
}
