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

//! Same-transaction semantic projection. Only a classified reducer failure can
//! leave a canonical fact committed with an unavailable projection; SQL/IO and
//! serialization errors always propagate to the existing transaction boundary.
use super::source::{CanonicalToolProjectionSpan, SemanticPayloadSource};
use crate::StoreError;
use futures_util::FutureExt;
use maka_agent_facts::{
    event::{Fact, StoredEvent},
    history::{
        RowPosition,
        semantic::{
            self, Fragment, FragmentSource, Frontier, Payload, PendingNotification, SemanticKind,
            SemanticRow,
        },
    },
    tool_output::DurableToolProjection,
};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::sqlite::SqliteWorkerConnection;
use std::io::Write;

const PIECE_BYTES: usize = 32 * 1024;

fn json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T, StoreError> {
    Ok(serde_json::from_str(value)?)
}
fn invalid(reason: impl Into<String>) -> StoreError {
    StoreError::Sqlite(rusqlite::Error::InvalidParameterName(reason.into()))
}

struct Pieces<'db, 'conn> {
    db: &'db mut SqliteWorkerConnection<'conn>,
    key: RowPosition,
    index: i64,
    buffer: Vec<u8>,
    failure: Option<StoreError>,
}

impl Pieces<'_, '_> {
    fn store(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        // Worker-local executor futures are immediately ready and never enqueue work.
        let result = sqlx::query("INSERT INTO context_semantic_fragment_pieces VALUES(?,?,?,?)")
            .bind(self.key.source_sequence as i64)
            .bind(self.key.item_index as i64)
            .bind(self.index)
            .bind(self.buffer.as_slice())
            .execute(&mut *self.db)
            .now_or_never()
            .expect("SQLite worker-local execution is immediately ready");
        if let Err(error) = result {
            self.failure = Some(error.into());
            return Err(std::io::Error::other("semantic fragment storage failed"));
        }
        self.index += 1;
        self.buffer.clear();
        Ok(())
    }
}

impl Write for Pieces<'_, '_> {
    fn write(&mut self, mut bytes: &[u8]) -> std::io::Result<usize> {
        let written = bytes.len();
        while !bytes.is_empty() {
            let take = bytes.len().min(PIECE_BYTES - self.buffer.len());
            self.buffer.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.buffer.len() == PIECE_BYTES {
                self.store()?;
            }
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.store()
    }
}

async fn fragment(
    db: &mut SqliteWorkerConnection<'_>,
    fragment: &Fragment,
    canonical: Option<(&str, &DurableToolProjection)>,
) -> Result<(), StoreError> {
    let (source, normalized_projection) = match &fragment.source {
        FragmentSource::Payload(_) => (SemanticPayloadSource::Pieces, None),
        FragmentSource::CanonicalToolProjection => {
            if fragment.key.item_index != 0 {
                return Err(invalid(
                    "canonical Tool projection has a nonzero fragment index",
                ));
            }
            let (json, projection) = canonical
                .ok_or_else(|| invalid("canonical Tool projection lacks its typed source"))?;
            let span = CanonicalToolProjectionSpan::locate(fragment.key.source_sequence, json)?;
            if span.matches_projection(json, projection)? {
                (SemanticPayloadSource::CanonicalToolProjection(span), None)
            } else {
                (SemanticPayloadSource::Pieces, Some(projection))
            }
        }
    };
    let (storage_kind, offset, len) = match source {
        SemanticPayloadSource::Pieces => ("pieces", None, None),
        SemanticPayloadSource::CanonicalToolProjection(span) => (
            "canonical_tool_projection",
            Some(span.offset()),
            Some(span.len()),
        ),
    };
    sqlx::query("INSERT INTO context_semantic_fragments VALUES(?,?,?,?,?,?,?)")
        .bind(fragment.key.source_sequence as i64)
        .bind(fragment.key.item_index as i64)
        .bind(fragment.part.source_sequence as i64)
        .bind(fragment.part.item_index as i64)
        .bind(storage_kind)
        .bind(offset)
        .bind(len)
        .execute(&mut *db)
        .await?;
    if matches!(&fragment.source, FragmentSource::CanonicalToolProjection)
        && normalized_projection.is_none()
    {
        return Ok(());
    }
    #[derive(Serialize)]
    enum BorrowedPayload<'a> {
        Tool(&'a DurableToolProjection),
    }
    let mut pieces = Pieces {
        db,
        key: fragment.key,
        index: 0,
        buffer: Vec::with_capacity(PIECE_BYTES),
        failure: None,
    };
    let serialized = match (&fragment.source, normalized_projection) {
        (FragmentSource::Payload(payload), _) => serde_json::to_writer(&mut pieces, payload),
        (FragmentSource::CanonicalToolProjection, Some(projection)) => {
            serde_json::to_writer(&mut pieces, &BorrowedPayload::Tool(projection))
        }
        (FragmentSource::CanonicalToolProjection, None) => return Ok(()),
    };
    if let Some(error) = pieces.failure.take() {
        return Err(error);
    }
    serialized?;
    let flushed = pieces.flush();
    if let Some(error) = pieces.failure {
        return Err(error);
    }
    flushed?;
    Ok(())
}

fn kind(row: &SemanticRow) -> &'static str {
    match row.kind {
        SemanticKind::User { .. } => "user",
        SemanticKind::ImportedUser { .. } => "imported_user",
        SemanticKind::ImportedAssistant { .. } => "imported_assistant",
        SemanticKind::ExecutorText { .. } => "executor_text",
        SemanticKind::AssistantPart { .. } => "assistant_part",
        SemanticKind::ToolResult { .. } => "tool_result",
        SemanticKind::Notification { .. } => "notification",
        SemanticKind::UnknownTool { .. } => "unknown_tool",
    }
}
fn archived(row: &SemanticRow) -> bool {
    matches!(row.kind, SemanticKind::ToolResult { archived: true, .. })
}

async fn change(
    db: &mut SqliteWorkerConnection<'_>,
    owner: &str,
    row: &SemanticRow,
    order: RowPosition,
    revision_invocation: &str,
    inherited: bool,
    deleted: bool,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO context_semantic_changes(owner_session_id,revision,source_sequence,source_index,order_sequence,order_index,invocation_id,revision_invocation,archived,inherited,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(owner)
        .bind(row.revision as i64)
        .bind(row.id.source_sequence as i64)
        .bind(row.id.item_index as i64)
        .bind(order.source_sequence as i64)
        .bind(order.item_index as i64)
        .bind(&row.invocation.invocation_id)
        .bind(revision_invocation)
        .bind(archived(row))
        .bind(inherited)
        .bind(deleted)
        .execute(&mut *db).await?;
    Ok(())
}

async fn save_row(
    db: &mut SqliteWorkerConnection<'_>,
    owner: &str,
    row: &SemanticRow,
    event_id: &str,
    revision_invocation: &str,
    inherited: bool,
    visible: bool,
) -> Result<(), StoreError> {
    save_row_mode(
        db,
        owner,
        row,
        event_id,
        revision_invocation,
        RowState {
            inherited,
            visible,
            unknown_only: matches!(row.kind, SemanticKind::UnknownTool { .. }),
        },
    )
    .await
}

struct RowState {
    inherited: bool,
    visible: bool,
    unknown_only: bool,
}

async fn save_row_mode(
    db: &mut SqliteWorkerConnection<'_>,
    owner: &str,
    row: &SemanticRow,
    event_id: &str,
    revision_invocation: &str,
    state: RowState,
) -> Result<(), StoreError> {
    let RowState {
        inherited,
        visible,
        unknown_only,
    } = state;
    let old:Option<(i64,i64,i64)>=sqlx::query_as("SELECT revision,order_sequence,order_index FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? ORDER BY revision DESC LIMIT 1")
        .bind(owner)
        .bind(row.id.source_sequence as i64)
        .bind(row.id.item_index as i64)
        .fetch_optional(&mut *db).await?;
    if old.is_some_and(|old| old.0 == row.revision as i64) {
        return Ok(());
    }
    if let Some((_, sequence, index)) = old
        && (sequence, index)
            != (
                row.order.source_sequence as i64,
                row.order.item_index as i64,
            )
    {
        change(
            db,
            owner,
            row,
            RowPosition {
                source_sequence: sequence as u64,
                item_index: index as u64,
            },
            revision_invocation,
            inherited,
            true,
        )
        .await?;
    }
    sqlx::query("INSERT INTO context_semantic_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(owner)
        .bind(row.id.source_sequence as i64)
        .bind(row.id.item_index as i64)
        .bind(row.revision as i64)
        .bind(row.order.source_sequence as i64)
        .bind(row.order.item_index as i64)
        .bind(&row.invocation.invocation_id)
        .bind(revision_invocation)
        .bind(event_id)
        .bind(kind(row))
        .bind(archived(row))
        .bind(inherited)
        .bind(visible)
        .bind(unknown_only)
        .bind(json(row)?)
        .execute(&mut *db)
        .await?;
    change(
        db,
        owner,
        row,
        row.order,
        revision_invocation,
        inherited,
        !visible,
    )
    .await
}

// Match the existing copy-hydration metadata batch; this bounds intermediate
// query rows without limiting the number of projected changes.
const METADATA_PAGE_ROWS: i64 = 128;

pub(super) const STABLE_CHANGES_SQL: &str = "SELECT r.source_sequence,r.source_index,r.revision,r.row_json,r.inherited
    FROM context_semantic_rows r
    WHERE r.owner_session_id=?1 AND r.invocation_id=?2 AND r.kind='assistant_part'
      AND (r.source_sequence,r.source_index,r.revision)>(?3,?4,?5)
      AND (r.source_sequence,r.source_index)<(?6,?7)
      AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
          AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision)
    ORDER BY r.source_sequence,r.source_index,r.revision LIMIT ?8";

pub(super) async fn stable_changes(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    previous: Option<RowPosition>,
    next: RowPosition,
) -> Result<(), StoreError> {
    let previous = previous.unwrap_or(RowPosition {
        source_sequence: 0,
        item_index: 0,
    });
    if previous >= next {
        return Ok(());
    }
    let owner = &stored.event.invocation.session_id;
    // Revisions are nonnegative, so -1 includes the initial source position.
    let mut cursor = (
        previous.source_sequence as i64,
        previous.item_index as i64,
        -1,
    );
    loop {
        let records: Vec<(i64, i64, i64, String, bool)> = sqlx::query_as(STABLE_CHANGES_SQL)
            .bind(owner)
            .bind(&stored.event.invocation.invocation_id)
            .bind(cursor.0)
            .bind(cursor.1)
            .bind(cursor.2)
            .bind(next.source_sequence as i64)
            .bind(next.item_index as i64)
            .bind(METADATA_PAGE_ROWS)
            .fetch_all(&mut *db)
            .await?;
        if records.is_empty() {
            break;
        }
        for (sequence, index, revision, json, inherited) in records {
            cursor = (sequence, index, revision);
            let mut row: SemanticRow = decode(&json)?;
            row.revision = stored.sequence;
            change(
                db,
                owner,
                &row,
                row.order,
                &stored.event.invocation.invocation_id,
                inherited,
                false,
            )
            .await?;
        }
    }
    Ok(())
}

async fn unknown_dispatch(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    frontier: &Frontier,
) -> Result<(), StoreError> {
    let Fact::ToolDispatched { operation_id, .. } = &stored.event.fact else {
        return Ok(());
    };
    let Some(call) = frontier.calls.get(operation_id) else {
        return Ok(());
    };
    let point = RowPosition {
        source_sequence: stored.sequence,
        item_index: 0,
    };
    let row = SemanticRow {
        id: point,
        revision: stored.sequence,
        invocation: stored.event.invocation.clone(),
        order: point,
        kind: SemanticKind::UnknownTool {
            operation_id: operation_id.clone(),
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            custom: call.custom,
        },
    };
    save_row(
        db,
        &stored.event.invocation.session_id,
        &row,
        &stored.event.id,
        &stored.event.invocation.invocation_id,
        false,
        true,
    )
    .await
}

async fn close_unknown(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    dispatched: Option<u64>,
) -> Result<(), StoreError> {
    let Some(dispatched) = dispatched else {
        return Ok(());
    };
    let owner = &stored.event.invocation.session_id;
    let prior:Option<(String,String)>=sqlx::query_as("SELECT row_json,event_id FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=0 AND kind='unknown_tool' ORDER BY revision DESC LIMIT 1")
        .bind(owner)
        .bind(dispatched as i64)
        .fetch_optional(&mut *db).await?;
    if let Some((json, event_id)) = prior {
        let mut row: SemanticRow = decode(&json)?;
        row.revision = stored.sequence;
        save_row(
            db,
            owner,
            &row,
            &event_id,
            &stored.event.invocation.invocation_id,
            false,
            false,
        )
        .await?;
    }
    Ok(())
}

async fn pending_unknown_notifications(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    frontier: &Frontier,
) -> Result<(), StoreError> {
    if !matches!(
        stored.event.fact,
        Fact::ToolNotified { .. }
            | Fact::ModelRequested { .. }
            | Fact::ModelCompleted { .. }
            | Fact::ModelInterrupted { .. }
            | Fact::InvocationEnded { .. }
    ) {
        return Ok(());
    }
    let owner = &stored.event.invocation.session_id;
    let mut ordinal = 1;
    for pending in &frontier.notifications {
        let prior:Option<(bool,i64)>=sqlx::query_as("SELECT visible,revision FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? ORDER BY revision DESC LIMIT 1")
        .bind(owner)
        .bind(pending.row.id.source_sequence as i64)
        .bind(pending.row.id.item_index as i64)
        .fetch_optional(&mut *db).await?;
        let visible = pending.blocked_by.is_empty();
        if prior.is_some_and(|(was_visible, revision)| {
            was_visible == visible || revision == stored.sequence as i64
        }) {
            continue;
        }
        if !visible && prior.is_none() {
            continue;
        }
        let mut row = pending.row.clone();
        row.revision = stored.sequence;
        row.order = RowPosition {
            source_sequence: stored.sequence,
            item_index: ordinal,
        };
        ordinal += 1;
        save_row_mode(
            db,
            owner,
            &row,
            &stored.event.id,
            &stored.event.invocation.invocation_id,
            RowState {
                inherited: false,
                visible,
                unknown_only: true,
            },
        )
        .await?;
    }
    Ok(())
}

async fn unavailable(
    db: &mut SqliteWorkerConnection<'_>,
    session: &str,
    sequence: i64,
    reason: &str,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO context_semantic_heads(session_id,unavailable_at,unavailable_reason) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET unavailable_at=COALESCE(unavailable_at,excluded.unavailable_at),unavailable_reason=COALESCE(unavailable_reason,excluded.unavailable_reason)")
        .bind(session)
        .bind(sequence)
        .bind(reason)
        .execute(&mut *db).await?;
    Ok(())
}

/// Restore released notification locators when a new logical request proves it
/// did not see them. Only the affected indexed source range is touched.
async fn reopen_notifications(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    frontier: &mut Frontier,
) -> Result<Vec<(SemanticRow, String, bool)>, StoreError> {
    let Fact::ModelRequested {
        source_high_water,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        ..
    } = &stored.event.fact
    else {
        return Ok(Vec::new());
    };
    let mut hidden = Vec::new();
    let mut cursor = (*source_high_water as i64, i64::MAX, i64::MAX);
    loop {
        let records: Vec<(i64, i64, i64, String, String, bool)> = sqlx::query_as("SELECT r.source_sequence,r.source_index,r.revision,r.row_json,r.event_id,r.inherited FROM context_semantic_rows r
            WHERE r.owner_session_id=?1 AND r.invocation_id=?2 AND r.kind='notification'
              AND (r.source_sequence,r.source_index,r.revision)>(?3,?4,?5)
              AND r.source_sequence<?6 AND r.visible=1
              AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
                  AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision)
            ORDER BY r.source_sequence,r.source_index,r.revision LIMIT ?7")
            .bind(&stored.event.invocation.session_id)
            .bind(&stored.event.invocation.invocation_id)
            .bind(cursor.0).bind(cursor.1).bind(cursor.2)
            .bind(stored.sequence as i64)
            .bind(METADATA_PAGE_ROWS)
            .fetch_all(&mut *db).await?;
        if records.is_empty() {
            break;
        }
        for (sequence, index, revision, json, event_id, inherited) in records {
            cursor = (sequence, index, revision);
            let mut row: SemanticRow = decode(&json)?;
            if frontier
                .notifications
                .iter()
                .any(|pending| pending.row.id == row.id)
            {
                continue;
            }
            let blocked_by = frontier
                .requests
                .iter()
                .filter(|(_, request)| request.main && request.source < row.id.source_sequence)
                .map(|(id, _)| id.clone())
                .collect();
            frontier.notifications.push(PendingNotification {
                row: row.clone(),
                blocked_by,
            });
            row.revision = stored.sequence;
            hidden.push((row, event_id, inherited));
        }
    }
    Ok(hidden)
}

async fn archive(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    placeholder: &maka_agent_facts::archive::ArchivedPlaceholder,
) -> Result<(), StoreError> {
    let owner = &stored.event.invocation.session_id;
    let target:Option<(String,String,bool)>=sqlx::query_as("SELECT row_json,event_id,inherited FROM context_semantic_rows WHERE owner_session_id=? AND event_id=? AND kind='tool_result' ORDER BY revision DESC LIMIT 1")
        .bind(owner)
        .bind(&placeholder.identity.runtime_event_id)
        .fetch_optional(&mut *db).await?;
    let Some((json, event_id, inherited)) = target else {
        return Err(invalid("semantic archive target is missing"));
    };
    let mut row: SemanticRow = decode(&json)?;
    let SemanticKind::ToolResult {
        payload, archived, ..
    } = &mut row.kind
    else {
        return Err(invalid("semantic archive target is not a tool result"));
    };
    let key = RowPosition {
        source_sequence: stored.sequence,
        item_index: 0,
    };
    let projection = placeholder.to_canonical_projection().map_err(invalid)?;
    fragment(
        db,
        &Fragment {
            key,
            part: key,
            source: FragmentSource::Payload(Box::new(Payload::Tool(projection))),
        },
        None,
    )
    .await?;
    *payload = key;
    *archived = true;
    row.revision = stored.sequence;
    // A local archive is subject to this Session's own lineage/before boundary,
    // even when its original result was inherited from a frozen copy.
    let _ = inherited;
    save_row(
        db,
        owner,
        &row,
        &event_id,
        &stored.event.invocation.invocation_id,
        false,
        true,
    )
    .await
}

pub(crate) async fn record(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    canonical_json: &str,
) -> Result<(), StoreError> {
    let sequence = stored.sequence as i64;
    let owner = &stored.event.invocation.session_id;
    let mut availability: Option<Option<i64>> =
        sqlx::query_scalar("SELECT unavailable_at FROM context_semantic_heads WHERE session_id=?")
            .bind(owner)
            .fetch_optional(&mut *db)
            .await?;
    if !matches!(availability, Some(None)) {
        hydrate_copy(db, owner).await?;
        availability = sqlx::query_scalar(
            "SELECT unavailable_at FROM context_semantic_heads WHERE session_id=?",
        )
        .bind(owner)
        .fetch_optional(&mut *db)
        .await?;
    }
    if availability.flatten().is_some() {
        return Ok(());
    }
    let previous: Option<String> = sqlx::query_scalar(
        "SELECT frontier_json FROM context_semantic_frontiers WHERE invocation_id=?",
    )
    .bind(&stored.event.invocation.invocation_id)
    .fetch_optional(&mut *db)
    .await?;
    let mut frontier = match &previous {
        Some(json) => decode(json)?,
        None => Frontier::default(),
    };
    let previous_cut = frontier.stable_cut;
    let settled_dispatch = match &stored.event.fact {
        Fact::ToolSettled { operation_id, .. } => frontier
            .calls
            .get(operation_id)
            .and_then(|call| call.dispatched_at),
        _ => None,
    };
    let hidden = reopen_notifications(db, stored, &mut frontier).await?;
    let transition = match semantic::reduce(&mut frontier, stored) {
        Ok(transition) => transition,
        Err(reason) => {
            unavailable(db, owner, sequence, reason).await?;
            return Ok(());
        }
    };
    let canonical_projection = match &stored.event.fact {
        Fact::ToolSettled {
            outcome:
                maka_agent_facts::event::ToolOutcome::Succeeded {
                    model_projection, ..
                },
            ..
        } => Some((canonical_json, model_projection)),
        _ => None,
    };
    for fragment_value in &transition.fragments {
        fragment(db, fragment_value, canonical_projection).await?;
    }
    for (row, event_id, inherited) in hidden {
        save_row(
            db,
            owner,
            &row,
            &event_id,
            &stored.event.invocation.invocation_id,
            inherited,
            false,
        )
        .await?;
    }
    for row in &transition.rows {
        save_row(
            db,
            owner,
            row,
            &stored.event.id,
            &stored.event.invocation.invocation_id,
            false,
            true,
        )
        .await?;
    }
    unknown_dispatch(db, stored, &frontier).await?;
    close_unknown(db, stored, settled_dispatch).await?;
    pending_unknown_notifications(db, stored, &frontier).await?;
    if let Some(cut) = transition.stable_cut {
        sqlx::query("INSERT INTO context_semantic_cuts VALUES(?,?,?,?,?)")
            .bind(owner)
            .bind(&stored.event.invocation.invocation_id)
            .bind(sequence)
            .bind(cut.source_sequence as i64)
            .bind(cut.item_index as i64)
            .execute(&mut *db)
            .await?;
        stable_changes(db, stored, previous_cut, cut).await?;
    }
    if let Some(checkpoint) = transition.checkpoint {
        sqlx::query("INSERT INTO context_semantic_checkpoints VALUES(?,?,?,?,?)")
            .bind(owner)
            .bind(sequence)
            .bind(&stored.event.id)
            .bind(&stored.event.invocation.invocation_id)
            .bind(json(&checkpoint)?)
            .execute(&mut *db)
            .await?;
    }
    if let Some(placeholder) = transition.archive {
        archive(db, stored, &placeholder).await?;
    }
    let frontier_json = json(&frontier)?;
    if previous.as_deref() != Some(frontier_json.as_str()) {
        sqlx::query("INSERT INTO context_semantic_frontiers VALUES(?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET through_sequence=excluded.through_sequence,frontier_json=excluded.frontier_json")
        .bind(&stored.event.invocation.invocation_id)
        .bind(owner)
        .bind(sequence)
        .bind(frontier_json)
        .execute(&mut *db).await?;
    }
    if availability.is_none() {
        sqlx::query("INSERT INTO context_semantic_heads(session_id) VALUES(?)")
            .bind(owner)
            .execute(&mut *db)
            .await?;
    }
    Ok(())
}

async fn hydrate_copy(db: &mut SqliteWorkerConnection<'_>, owner: &str) -> Result<(), StoreError> {
    let done: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_semantic_copies WHERE session_id=?)",
    )
    .bind(owner)
    .fetch_one(&mut *db)
    .await?;
    if done {
        return Ok(());
    }
    let source: Option<String> = sqlx::query_scalar(
        "SELECT source_session_id FROM session_history_copies WHERE session_id=?",
    )
    .bind(owner)
    .fetch_optional(&mut *db)
    .await?;
    let Some(source) = source else {
        return Ok(());
    };
    // The admitted Session-copy graph is acyclic. Mark before recursion so a
    // corrupt graph cannot recurse without bound during explicit derivation.
    sqlx::query("INSERT INTO context_semantic_copies VALUES(?)")
        .bind(owner)
        .execute(&mut *db)
        .await?;
    Box::pin(hydrate_copy(db, &source)).await?;
    let mut after = 0i64;
    loop {
        let records: Vec<(i64, Option<i64>)> = sqlx::query_as("SELECT sequence,archive_sequence FROM session_history_members WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128")
            .bind(owner)
            .bind(after)
            .fetch_all(&mut *db).await?;
        if records.is_empty() {
            break;
        }
        for (sequence, archive_sequence) in records {
            copy_member(db, owner, sequence, archive_sequence).await?;
            after = sequence;
        }
    }
    sqlx::query("INSERT INTO context_semantic_heads(session_id) VALUES(?) ON CONFLICT(session_id) DO NOTHING")
        .bind(owner)
        .execute(&mut *db)
        .await?;
    Ok(())
}

pub(crate) async fn copy_member(
    db: &mut SqliteWorkerConnection<'_>,
    owner: &str,
    sequence: i64,
    archive_sequence: Option<i64>,
) -> Result<(), StoreError> {
    let (source,through,observed):(String,i64,i64)=sqlx::query_as("SELECT source_session_id,through_sequence,observed_through FROM session_history_copies WHERE session_id=?")
        .bind(owner)
        .fetch_one(&mut *db).await?;
    Box::pin(hydrate_copy(db, &source)).await?;
    let failure:Option<String>=sqlx::query_scalar("SELECT unavailable_reason FROM context_semantic_heads WHERE session_id=? AND unavailable_at<=?")
        .bind(&source)
        .bind(observed)
        .fetch_optional(&mut *db).await?;
    if let Some(reason) = failure {
        unavailable(db, owner, sequence, &reason).await?;
        return Ok(());
    }
    let records: Vec<(String, String, String, bool, bool)> = sqlx::query_as("SELECT r.row_json,r.event_id,r.revision_invocation,r.visible,r.unknown_only FROM context_semantic_rows r
        WHERE r.owner_session_id=?1 AND r.source_sequence=?2 AND r.revision<=?3
          AND ((r.archived=0 AND r.revision<=?4 AND ?5 IS NULL) OR (r.archived=1 AND r.revision=?5))
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index
            AND n.revision>r.revision AND n.revision<=?3
            AND ((n.archived=0 AND n.revision<=?4 AND ?5 IS NULL) OR (n.archived=1 AND n.revision=?5)))")
        .bind(&source)
        .bind(sequence)
        .bind(observed)
        .bind(through)
        .bind(archive_sequence)
        .fetch_all(&mut *db).await?;
    for (json, event_id, revision_invocation, visible, unknown_only) in records {
        let row: SemanticRow = decode(&json)?;
        save_row_mode(
            db,
            owner,
            &row,
            &event_id,
            &revision_invocation,
            RowState {
                inherited: true,
                visible,
                unknown_only,
            },
        )
        .await?;
    }
    sqlx::query("INSERT OR IGNORE INTO context_semantic_cuts(owner_session_id,invocation_id,revision,cut_sequence,cut_index) SELECT ?1,invocation_id,revision,cut_sequence,cut_index FROM context_semantic_cuts WHERE owner_session_id=?2 AND revision=?3")
        .bind(owner)
        .bind(&source)
        .bind(sequence)
        .execute(&mut *db).await?;
    let completed =
        sqlx::query("INSERT OR IGNORE INTO context_semantic_copies(session_id) VALUES(?)")
            .bind(owner)
            .execute(&mut *db)
            .await?;
    if completed.rows_affected() != 0 {
        sqlx::query("INSERT INTO context_semantic_heads(session_id) VALUES(?) ON CONFLICT(session_id) DO NOTHING")
            .bind(owner)
            .execute(&mut *db)
            .await?;
    }
    Ok(())
}
