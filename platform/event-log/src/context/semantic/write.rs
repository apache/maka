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

//! Same-transaction projection hooks. Only a classified reducer failure can
//! leave a canonical fact committed with an unavailable projection; SQL/IO and
//! serialization errors always propagate to the existing transaction boundary.
use crate::StoreError;
use maka_agent_facts::{
    event::{Fact, RuntimeEvent, StoredEvent},
    history::{
        RowPosition,
        semantic::{
            self, Fragment, Frontier, Payload, PendingNotification, SemanticKind, SemanticRow,
        },
    },
};
use rusqlite::{Connection, OptionalExtension, functions::FunctionFlags, params};
use serde::{Serialize, de::DeserializeOwned};
use std::io::Write;

const PIECE_BYTES: usize = 32 * 1024;

fn json<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value)
        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
}
fn decode<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
}
fn invalid(reason: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(reason.into())
}

struct Pieces<'a> {
    db: &'a Connection,
    key: RowPosition,
    index: i64,
    buffer: Vec<u8>,
}
impl Pieces<'_> {
    fn store(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.db
            .execute(
                "INSERT INTO context_semantic_fragment_pieces VALUES(?,?,?,?)",
                params![
                    self.key.source_sequence as i64,
                    self.key.item_index as i64,
                    self.index,
                    &self.buffer
                ],
            )
            .map_err(std::io::Error::other)?;
        self.index += 1;
        self.buffer.clear();
        Ok(())
    }
}
impl Write for Pieces<'_> {
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

fn fragment(db: &Connection, fragment: &Fragment) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO context_semantic_fragments VALUES(?,?,?,?)",
        params![
            fragment.key.source_sequence as i64,
            fragment.key.item_index as i64,
            fragment.part.source_sequence as i64,
            fragment.part.item_index as i64,
        ],
    )?;
    let mut pieces = Pieces {
        db,
        key: fragment.key,
        index: 0,
        buffer: Vec::with_capacity(PIECE_BYTES),
    };
    serde_json::to_writer(&mut pieces, &fragment.payload)
        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
    pieces
        .flush()
        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
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

fn change(
    db: &Connection,
    owner: &str,
    row: &SemanticRow,
    order: RowPosition,
    revision_invocation: &str,
    inherited: bool,
    deleted: bool,
) -> rusqlite::Result<()> {
    db.execute("INSERT INTO context_semantic_changes(owner_session_id,revision,source_sequence,source_index,order_sequence,order_index,invocation_id,revision_invocation,archived,inherited,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params![owner,row.revision as i64,row.id.source_sequence as i64,row.id.item_index as i64,order.source_sequence as i64,order.item_index as i64,
            &row.invocation.invocation_id,revision_invocation,archived(row),inherited,deleted])?;
    Ok(())
}

fn save_row(
    db: &Connection,
    owner: &str,
    row: &SemanticRow,
    event_id: &str,
    revision_invocation: &str,
    inherited: bool,
    visible: bool,
) -> rusqlite::Result<()> {
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
}

struct RowState {
    inherited: bool,
    visible: bool,
    unknown_only: bool,
}

fn save_row_mode(
    db: &Connection,
    owner: &str,
    row: &SemanticRow,
    event_id: &str,
    revision_invocation: &str,
    state: RowState,
) -> rusqlite::Result<()> {
    let RowState {
        inherited,
        visible,
        unknown_only,
    } = state;
    let old:Option<(i64,i64,i64)>=db.query_row("SELECT revision,order_sequence,order_index FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? ORDER BY revision DESC LIMIT 1",
        params![owner,row.id.source_sequence as i64,row.id.item_index as i64],|record|Ok((record.get(0)?,record.get(1)?,record.get(2)?))).optional()?;
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
        )?;
    }
    db.execute(
        "INSERT INTO context_semantic_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            owner,
            row.id.source_sequence as i64,
            row.id.item_index as i64,
            row.revision as i64,
            row.order.source_sequence as i64,
            row.order.item_index as i64,
            &row.invocation.invocation_id,
            revision_invocation,
            event_id,
            kind(row),
            archived(row),
            inherited,
            visible,
            unknown_only,
            json(row)?,
        ],
    )?;
    change(
        db,
        owner,
        row,
        row.order,
        revision_invocation,
        inherited,
        !visible,
    )
}

fn stable_changes(
    db: &Connection,
    stored: &StoredEvent,
    previous: Option<RowPosition>,
    next: RowPosition,
) -> rusqlite::Result<()> {
    let previous = previous.unwrap_or(RowPosition {
        source_sequence: 0,
        item_index: 0,
    });
    if previous >= next {
        return Ok(());
    }
    let owner = &stored.event.invocation.session_id;
    let mut query=db.prepare("SELECT r.row_json,r.inherited FROM context_semantic_rows r
        WHERE r.owner_session_id=?1 AND r.invocation_id=?2 AND r.kind='assistant_part'
          AND (r.source_sequence,r.source_index)>=(?3,?4) AND (r.source_sequence,r.source_index)<(?5,?6)
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision)")?;
    let records = query.query_map(
        params![
            owner,
            &stored.event.invocation.invocation_id,
            previous.source_sequence as i64,
            previous.item_index as i64,
            next.source_sequence as i64,
            next.item_index as i64
        ],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
    )?;
    for record in records {
        let (json, inherited) = record?;
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
        )?;
    }
    Ok(())
}

fn unknown_dispatch(
    db: &Connection,
    stored: &StoredEvent,
    frontier: &Frontier,
) -> rusqlite::Result<()> {
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
}

fn close_unknown(
    db: &Connection,
    stored: &StoredEvent,
    dispatched: Option<u64>,
) -> rusqlite::Result<()> {
    let Some(dispatched) = dispatched else {
        return Ok(());
    };
    let owner = &stored.event.invocation.session_id;
    let prior:Option<(String,String)>=db.query_row("SELECT row_json,event_id FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=0 AND kind='unknown_tool' ORDER BY revision DESC LIMIT 1",
        params![owner,dispatched as i64],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
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
        )?;
    }
    Ok(())
}

fn pending_unknown_notifications(
    db: &Connection,
    stored: &StoredEvent,
    frontier: &Frontier,
) -> rusqlite::Result<()> {
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
        let prior:Option<(bool,i64)>=db.query_row("SELECT visible,revision FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? ORDER BY revision DESC LIMIT 1",
            params![owner,pending.row.id.source_sequence as i64,pending.row.id.item_index as i64],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
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
        )?;
    }
    Ok(())
}

fn unavailable(
    db: &Connection,
    session: &str,
    sequence: i64,
    reason: &str,
) -> rusqlite::Result<()> {
    db.execute("INSERT INTO context_semantic_heads(session_id,through_sequence,unavailable_at,unavailable_reason) VALUES(?,0,?,?) ON CONFLICT(session_id) DO UPDATE SET unavailable_at=COALESCE(unavailable_at,excluded.unavailable_at),unavailable_reason=COALESCE(unavailable_reason,excluded.unavailable_reason)",params![session,sequence,reason])?;
    Ok(())
}

fn failed(db: &Connection, session: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT unavailable_reason FROM context_semantic_heads WHERE session_id=? AND unavailable_at IS NOT NULL",[session],|row|row.get(0)).optional()
}

/// Restore released notification locators when a new logical request proves it
/// did not see them. Only the affected indexed source range is touched.
fn reopen_notifications(
    db: &Connection,
    stored: &StoredEvent,
    frontier: &mut Frontier,
) -> rusqlite::Result<Vec<(SemanticRow, String, bool)>> {
    let Fact::ModelRequested {
        source_high_water,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        ..
    } = &stored.event.fact
    else {
        return Ok(Vec::new());
    };
    let mut query=db.prepare("SELECT r.row_json,r.event_id,r.inherited FROM context_semantic_rows r
        WHERE r.owner_session_id=?1 AND r.invocation_id=?2 AND r.kind='notification'
          AND r.source_sequence>?3 AND r.source_sequence<?4 AND r.visible=1
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
              AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision)
        ORDER BY r.source_sequence,r.source_index")?;
    let records = query.query_map(
        params![
            &stored.event.invocation.session_id,
            &stored.event.invocation.invocation_id,
            *source_high_water as i64,
            stored.sequence as i64
        ],
        |record| {
            Ok((
                record.get::<_, String>(0)?,
                record.get::<_, String>(1)?,
                record.get::<_, bool>(2)?,
            ))
        },
    )?;
    let mut hidden = Vec::new();
    for record in records {
        let (json, event_id, inherited) = record?;
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
    Ok(hidden)
}

fn archive(
    db: &Connection,
    stored: &StoredEvent,
    placeholder: &maka_agent_facts::archive::ArchivedPlaceholder,
) -> rusqlite::Result<()> {
    let owner = &stored.event.invocation.session_id;
    let target:Option<(String,String,bool)>=db.query_row("SELECT row_json,event_id,inherited FROM context_semantic_rows WHERE owner_session_id=? AND event_id=? AND kind='tool_result' ORDER BY revision DESC LIMIT 1",
        params![owner,&placeholder.identity.runtime_event_id],|record|Ok((record.get(0)?,record.get(1)?,record.get(2)?))).optional()?;
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
            payload: Payload::Tool(projection),
        },
    )?;
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
}

fn record(db: &Connection, sequence: i64, event_json: &str) -> rusqlite::Result<()> {
    let event: RuntimeEvent = decode(event_json)?;
    let stored = StoredEvent {
        sequence: sequence
            .try_into()
            .map_err(|_| invalid("invalid semantic sequence"))?,
        event,
    };
    let owner = &stored.event.invocation.session_id;
    hydrate_copy(db, owner)?;
    if failed(db, owner)?.is_some() {
        return Ok(());
    }
    let previous:Option<(i64,String)>=db.query_row("SELECT through_sequence,frontier_json FROM context_semantic_frontiers WHERE invocation_id=?",[&stored.event.invocation.invocation_id],|record|Ok((record.get(0)?,record.get(1)?))).optional()?;
    let mut frontier = match previous {
        Some((through, json)) => {
            if through >= sequence {
                return Err(invalid("semantic append is not monotonic"));
            }
            decode(&json)?
        }
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
    let hidden = reopen_notifications(db, &stored, &mut frontier)?;
    let transition = match semantic::reduce(&mut frontier, &stored) {
        Ok(transition) => transition,
        Err(reason) => {
            unavailable(db, owner, sequence, reason)?;
            return Ok(());
        }
    };
    for fragment_value in &transition.fragments {
        fragment(db, fragment_value)?;
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
        )?;
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
        )?;
    }
    unknown_dispatch(db, &stored, &frontier)?;
    close_unknown(db, &stored, settled_dispatch)?;
    pending_unknown_notifications(db, &stored, &frontier)?;
    if let Some(cut) = transition.stable_cut {
        db.execute(
            "INSERT INTO context_semantic_cuts VALUES(?,?,?,?,?)",
            params![
                owner,
                &stored.event.invocation.invocation_id,
                sequence,
                cut.source_sequence as i64,
                cut.item_index as i64
            ],
        )?;
        stable_changes(db, &stored, previous_cut, cut)?;
    }
    if let Some(checkpoint) = transition.checkpoint {
        db.execute(
            "INSERT INTO context_semantic_checkpoints VALUES(?,?,?,?,?)",
            params![
                owner,
                sequence,
                &stored.event.id,
                &stored.event.invocation.invocation_id,
                json(&checkpoint)?
            ],
        )?;
    }
    if let Some(placeholder) = transition.archive {
        archive(db, &stored, &placeholder)?;
    }
    db.execute("INSERT INTO context_semantic_frontiers VALUES(?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET through_sequence=excluded.through_sequence,frontier_json=excluded.frontier_json",
        params![&stored.event.invocation.invocation_id,owner,sequence,json(&frontier)?])?;
    db.execute("INSERT INTO context_semantic_heads(session_id,through_sequence) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET through_sequence=excluded.through_sequence",params![owner,sequence])?;
    Ok(())
}

fn hydrate_copy(db: &Connection, owner: &str) -> rusqlite::Result<()> {
    let done: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM context_semantic_copies WHERE session_id=?)",
        [owner],
        |row| row.get(0),
    )?;
    if done {
        return Ok(());
    }
    let source: Option<String> = db
        .query_row(
            "SELECT source_session_id FROM session_history_copies WHERE session_id=?",
            [owner],
            |row| row.get(0),
        )
        .optional()?;
    let Some(source) = source else {
        return Ok(());
    };
    // The admitted Session-copy graph is acyclic. Mark before recursion so a
    // corrupt graph cannot recurse without bound during explicit derivation.
    db.execute("INSERT INTO context_semantic_copies VALUES(?)", [owner])?;
    hydrate_copy(db, &source)?;
    let mut after = 0i64;
    loop {
        let mut statement=db.prepare("SELECT sequence,archive_sequence FROM session_history_members WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128")?;
        let records: Vec<(i64, Option<i64>)> = statement
            .query_map(params![owner, after], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        if records.is_empty() {
            break;
        }
        for (sequence, archive_sequence) in records {
            copy_member(db, owner, sequence, archive_sequence)?;
            after = sequence;
        }
    }
    Ok(())
}

fn copy_member(
    db: &Connection,
    owner: &str,
    sequence: i64,
    archive_sequence: Option<i64>,
) -> rusqlite::Result<()> {
    let (source,through,observed):(String,i64,i64)=db.query_row("SELECT source_session_id,through_sequence,observed_through FROM session_history_copies WHERE session_id=?",[owner],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
    hydrate_copy(db, &source)?;
    let failure:Option<String>=db.query_row("SELECT unavailable_reason FROM context_semantic_heads WHERE session_id=? AND unavailable_at<=?",params![&source,observed],|row|row.get(0)).optional()?;
    if let Some(reason) = failure {
        unavailable(db, owner, sequence, &reason)?;
        return Ok(());
    }
    let mut query=db.prepare("SELECT r.row_json,r.event_id,r.revision_invocation,r.visible,r.unknown_only FROM context_semantic_rows r
        WHERE r.owner_session_id=?1 AND r.source_sequence=?2 AND r.revision<=?3
          AND ((r.archived=0 AND r.revision<=?4 AND ?5 IS NULL) OR (r.archived=1 AND r.revision=?5))
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index
            AND n.revision>r.revision AND n.revision<=?3
            AND ((n.archived=0 AND n.revision<=?4 AND ?5 IS NULL) OR (n.archived=1 AND n.revision=?5)))")?;
    let records: Vec<(String, String, String, bool, bool)> = query
        .query_map(
            params![source, sequence, observed, through, archive_sequence],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
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
        )?;
    }
    db.execute("INSERT OR IGNORE INTO context_semantic_cuts(owner_session_id,invocation_id,revision,cut_sequence,cut_index) SELECT ?1,invocation_id,revision,cut_sequence,cut_index FROM context_semantic_cuts WHERE owner_session_id=?2 AND revision=?3",params![owner,source,sequence])?;
    db.execute("INSERT INTO context_semantic_heads(session_id,through_sequence) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)",params![owner,sequence])?;
    db.execute(
        "INSERT OR IGNORE INTO context_semantic_copies(session_id) VALUES(?)",
        [owner],
    )?;
    Ok(())
}

pub(crate) fn register(db: &Connection) -> Result<(), StoreError> {
    db.create_scalar_function(
        "context_semantic_record",
        2,
        FunctionFlags::SQLITE_UTF8,
        |context| {
            let sequence: i64 = context.get(0)?;
            let json = context.get_raw(1).as_str()?;
            let db = unsafe { context.get_connection() }?;
            record(&db, sequence, json)?;
            Ok(0)
        },
    )?;
    db.create_scalar_function(
        "context_semantic_copy",
        3,
        FunctionFlags::SQLITE_UTF8,
        |context| {
            let owner: String = context.get(0)?;
            let sequence: i64 = context.get(1)?;
            let archive_sequence: Option<i64> = context.get(2)?;
            let db = unsafe { context.get_connection() }?;
            copy_member(&db, &owner, sequence, archive_sequence)?;
            Ok(0)
        },
    )?;
    Ok(())
}
