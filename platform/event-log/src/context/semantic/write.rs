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
use super::source::{CanonicalModelPartSpan, CanonicalToolProjectionSpan, SemanticPayloadSource};
use crate::StoreError;
use maka_agent_facts::{
    event::{Fact, StoredEvent},
    history::{
        RowPosition,
        semantic::{
            self, Fragment, FragmentSource, Frontier, Payload, PendingNotification, SemanticKind,
            SemanticRow,
        },
    },
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, de::DeserializeOwned};
use std::borrow::Cow;
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

struct Pieces<'db> {
    statement: rusqlite::CachedStatement<'db>,
    key: RowPosition,
    index: i64,
    buffer: Vec<u8>,
    failure: Option<StoreError>,
}

impl Pieces<'_> {
    fn store(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let result = self.statement.execute(rusqlite::params![
            self.key.source_sequence as i64,
            self.key.item_index as i64,
            self.index,
            self.buffer.as_slice()
        ]);
        if let Err(error) = result {
            self.failure = Some(error.into());
            return Err(std::io::Error::other("semantic fragment storage failed"));
        }
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

fn fragment(
    db: &Connection,
    fragment: &Fragment,
    prepared: Option<&super::prepared::Fragment>,
) -> Result<(), StoreError> {
    let source = match &fragment.source {
        FragmentSource::Payload(_) => SemanticPayloadSource::Pieces,
        FragmentSource::CanonicalModelPart { ordinal } => {
            if fragment.key.item_index != *ordinal {
                return Err(invalid("canonical model ordinal differs from fragment"));
            }
            match &prepared
                .ok_or_else(|| invalid("canonical model part lacks its prepared source"))?
                .source
            {
                super::prepared::Source::CanonicalModel { offset, len } => {
                    SemanticPayloadSource::CanonicalModelPart(
                        CanonicalModelPartSpan::from_metadata(
                            fragment.key.source_sequence as i64,
                            *offset,
                            *len,
                        )?,
                    )
                }
                _ => {
                    return Err(invalid(
                        "canonical model part has a different prepared source",
                    ));
                }
            }
        }
        FragmentSource::CanonicalToolProjection => {
            if fragment.key.item_index != 0 {
                return Err(invalid(
                    "canonical Tool projection has a nonzero fragment index",
                ));
            }
            match &prepared
                .ok_or_else(|| invalid("canonical Tool projection lacks its prepared source"))?
                .source
            {
                super::prepared::Source::CanonicalTool { offset, len } => {
                    SemanticPayloadSource::CanonicalToolProjection(
                        CanonicalToolProjectionSpan::from_metadata(
                            fragment.key.source_sequence as i64,
                            *offset,
                            *len,
                        )?,
                    )
                }
                super::prepared::Source::Pieces(_) => SemanticPayloadSource::Pieces,
                super::prepared::Source::CanonicalModel { .. } => {
                    return Err(invalid(
                        "canonical Tool projection has a different prepared source",
                    ));
                }
            }
        }
    };
    let (storage_kind, offset, len) = match source {
        SemanticPayloadSource::Pieces => ("pieces", None, None),
        SemanticPayloadSource::CanonicalModelPart(span) => (
            "canonical_model_part",
            Some(span.offset()),
            Some(span.len()),
        ),
        SemanticPayloadSource::CanonicalToolProjection(span) => (
            "canonical_tool_projection",
            Some(span.offset()),
            Some(span.len()),
        ),
    };
    if matches!(source, SemanticPayloadSource::Pieces) {
        let mut pieces = Pieces {
            statement: db
                .prepare_cached("INSERT INTO context_semantic_fragment_pieces VALUES(?,?,?,?)")?,
            key: fragment.key,
            index: 0,
            buffer: Vec::with_capacity(PIECE_BYTES),
            failure: None,
        };
        let serialized: Result<(), StoreError> = match &fragment.source {
            FragmentSource::Payload(payload) => {
                serde_json::to_writer(&mut pieces, payload).map_err(StoreError::from)
            }
            FragmentSource::CanonicalToolProjection => match prepared.map(|value| &value.source) {
                Some(super::prepared::Source::Pieces(bytes)) => {
                    pieces.write_all(bytes).map_err(StoreError::from)
                }
                _ => return Err(invalid("piece projection lacks its prepared bytes")),
            },
            FragmentSource::CanonicalModelPart { .. } => {
                return Err(invalid("canonical model part cannot use extracted pieces"));
            }
        };
        if let Some(error) = pieces.failure.take() {
            return Err(error);
        }
        serialized?;
        let flushed = pieces.flush();
        if let Some(error) = pieces.failure.take() {
            return Err(error);
        }
        flushed?;
    }
    let (directory_bytes, payload_bytes) = match prepared {
        Some(prepared) => {
            let (directory, bytes) = prepared.bind(db, fragment.key)?;
            (Cow::Borrowed(directory), bytes)
        }
        None => {
            let (directory, bytes) = super::directory::prepare_fragment(db, fragment.key, source)?;
            (
                Cow::Owned(super::directory::codec::encode(&directory)?),
                i64::try_from(bytes).map_err(|_| invalid("payload length exceeds SQLite range"))?,
            )
        }
    };
    db.execute("INSERT INTO context_semantic_fragments(source_sequence,source_index,storage_kind,byte_offset,byte_len,directory_bytes,payload_bytes) VALUES(?,?,?,?,?,?,?)", rusqlite::params![fragment.key.source_sequence as i64, fragment.key.item_index as i64, storage_kind, offset, len, directory_bytes.as_ref(), payload_bytes])?;

    Ok(())
}

fn kind(row: &SemanticRow) -> &'static str {
    match row.kind {
        SemanticKind::User { .. } => "user",
        SemanticKind::ImportedUser { .. } => "imported_user",
        SemanticKind::ImportedAssistant { .. } => "imported_assistant",
        SemanticKind::ExecutorText { .. } => "executor_text",
        SemanticKind::AssistantPart { .. } => "assistant_part",
        SemanticKind::ToolResult {
            kind: maka_agent_facts::model::prompt_source::source::ToolResultKind::Notification,
            ..
        } => "notification",
        SemanticKind::ToolResult { .. } => "tool_result",
        SemanticKind::Notification { .. } => "notification",
        SemanticKind::UnknownTool { .. } => "unknown_tool",
    }
}
fn archived(row: &SemanticRow) -> bool {
    matches!(row.kind, SemanticKind::ToolResult { archived: true, .. })
}

fn save_row(
    db: &Connection,
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
) -> Result<(), StoreError> {
    let RowState {
        inherited,
        visible,
        unknown_only,
    } = state;
    let old:Option<i64>=db.prepare_cached("SELECT revision FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? ORDER BY revision DESC LIMIT 1")?.query_row(rusqlite::params![owner, row.id.source_sequence as i64, row.id.item_index as i64], |row| row.get(0)).optional()?;
    if old == Some(row.revision as i64) {
        return Ok(());
    }
    let encoded_row = json(row)?;
    let row_directory = super::directory::row(&encoded_row)?;
    db.execute("INSERT INTO context_semantic_rows(owner_session_id,source_sequence,source_index,revision,order_sequence,order_index,invocation_id,revision_invocation,event_id,kind,archived,inherited,visible,unknown_only,row_json,directory_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rusqlite::params![owner, row.id.source_sequence as i64, row.id.item_index as i64, row.revision as i64, row.order.source_sequence as i64, row.order.item_index as i64, &row.invocation.invocation_id, revision_invocation, event_id, kind(row), archived(row), inherited, visible, unknown_only, encoded_row, super::directory::codec::encode(&row_directory)?])?;
    Ok(())
}

// Match the existing copy-hydration metadata batch; this bounds intermediate
// query rows without limiting the number of reopened notifications.
const METADATA_PAGE_ROWS: i64 = 128;

fn unknown_dispatch(
    db: &Connection,
    stored: &StoredEvent,
    frontier: &Frontier,
) -> Result<(), StoreError> {
    let operation_id = match &stored.event.fact {
        Fact::ToolDispatched { operation_id, .. } | Fact::ToolYielded { operation_id } => {
            operation_id
        }
        _ => return Ok(()),
    };
    let Some(call) = frontier.calls.get(operation_id) else {
        return Ok(());
    };
    let point = RowPosition {
        source_sequence: call
            .dispatched_at
            .ok_or_else(|| invalid("unknown tool lacks dispatch"))?,
        item_index: 0,
    };
    let row = SemanticRow {
        id: point,
        revision: stored.sequence,
        invocation: stored.event.invocation.clone(),
        order: RowPosition {
            source_sequence: stored.sequence,
            item_index: u64::from(call.yielded),
        },
        kind: SemanticKind::UnknownTool {
            operation_id: operation_id.clone(),
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            custom: call.custom,
            kind: if call.yielded {
                maka_agent_facts::model::prompt_source::source::ToolResultKind::Notification
            } else {
                maka_agent_facts::model::prompt_source::source::ToolResultKind::Output
            },
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
) -> Result<(), StoreError> {
    let Some(dispatched) = dispatched else {
        return Ok(());
    };
    let owner = &stored.event.invocation.session_id;
    let prior:Option<(String,String)>=db.prepare_cached("SELECT row_json,event_id FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=0 AND kind='unknown_tool' ORDER BY revision DESC LIMIT 1")?.query_row(rusqlite::params![owner, dispatched as i64], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
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
) -> Result<(), StoreError> {
    if !matches!(
        stored.event.fact,
        Fact::ToolSettled { .. }
            | Fact::ToolNotified { .. }
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
        let prior:Option<(bool,i64)>=db.prepare_cached("SELECT visible,revision FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? ORDER BY revision DESC LIMIT 1")?.query_row(rusqlite::params![owner, pending.row.id.source_sequence as i64, pending.row.id.item_index as i64], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
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
) -> Result<(), StoreError> {
    db.execute("INSERT INTO context_semantic_heads(session_id,unavailable_at,unavailable_reason) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET unavailable_at=COALESCE(unavailable_at,excluded.unavailable_at),unavailable_reason=COALESCE(unavailable_reason,excluded.unavailable_reason)", rusqlite::params![session, sequence, reason])?;
    Ok(())
}

/// Restore released notification locators when a new logical request proves it
/// did not see them. Only the affected indexed source range is touched.
fn reopen_notifications(
    db: &Connection,
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
        let records: Vec<(i64, i64, i64, String, String, bool)> = db.prepare_cached("SELECT r.source_sequence,r.source_index,r.revision,r.row_json,r.event_id,r.inherited FROM context_semantic_rows r
            WHERE r.owner_session_id=?1 AND r.invocation_id=?2 AND r.kind='notification'
              AND (r.source_sequence,r.source_index,r.revision)>(?3,?4,?5)
              AND r.source_sequence<?6 AND r.visible=1
              AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
                  AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision)
            ORDER BY r.source_sequence,r.source_index,r.revision LIMIT ?7")?.query_map(rusqlite::params![&stored.event.invocation.session_id, &stored.event.invocation.invocation_id, cursor.0, cursor.1, cursor.2, stored.sequence as i64, METADATA_PAGE_ROWS], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,)))?.collect::<Result<Vec<_>, _>>()?;
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

fn archive(
    db: &Connection,
    stored: &StoredEvent,
    placeholder: &maka_agent_facts::archive::ArchivedPlaceholder,
) -> Result<(), StoreError> {
    let owner = &stored.event.invocation.session_id;
    let target:Option<(String,String,bool)>=db.prepare_cached("SELECT row_json,event_id,inherited FROM context_semantic_rows WHERE owner_session_id=? AND event_id=? AND kind='tool_result' ORDER BY revision DESC LIMIT 1")?.query_row(rusqlite::params![owner, &placeholder.identity.runtime_event_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?;
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
            source: FragmentSource::Payload(Box::new(Payload::Tool(projection))),
        },
        None,
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

pub(crate) fn record_prepared(
    db: &Connection,
    stored: &StoredEvent,
    prepared: Result<super::Prepared, StoreError>,
) -> Result<(), StoreError> {
    let sequence = stored.sequence as i64;
    let owner = &stored.event.invocation.session_id;
    let mut availability: Option<Option<i64>> = db
        .prepare_cached("SELECT unavailable_at FROM context_semantic_heads WHERE session_id=?")?
        .query_row(rusqlite::params![owner], |row| row.get(0))
        .optional()?;
    if !matches!(availability, Some(None)) {
        hydrate_copy(db, owner)?;
        availability = db
            .prepare_cached("SELECT unavailable_at FROM context_semantic_heads WHERE session_id=?")?
            .query_row(rusqlite::params![owner], |row| row.get(0))
            .optional()?;
    }
    if availability.flatten().is_some() {
        return Ok(());
    }
    let previous: Option<String> = db
        .prepare_cached(
            "SELECT frontier_json FROM context_semantic_frontiers WHERE invocation_id=?",
        )?
        .query_row(
            rusqlite::params![&stored.event.invocation.invocation_id],
            |row| row.get(0),
        )
        .optional()?;
    let mut frontier = match &previous {
        Some(json) => decode(json)?,
        None => Frontier::default(),
    };
    let settled_dispatch = match &stored.event.fact {
        Fact::ToolSettled { operation_id, .. } => frontier
            .calls
            .get(operation_id)
            .and_then(|call| call.dispatched_at),
        _ => None,
    };
    let hidden = reopen_notifications(db, stored, &mut frontier)?;
    let mut transition = match semantic::reduce(&mut frontier, stored) {
        Ok(transition) => transition,
        Err(reason) => {
            unavailable(db, owner, sequence, reason)?;
            return Ok(());
        }
    };
    if let Fact::ExecutorObserved {
        output: maka_agent_facts::executor::Output::MessageEnd { message_id },
    } = &stored.event.fact
    {
        let start: Option<i64> = db
            .prepare_cached(
                "SELECT sequence FROM event_log INDEXED BY executor_output_kinds
             WHERE kind='executor_observed' AND invocation_id=?1
               AND json_extract(event_header,'$.fact.output.type')='message_start'
               AND json_extract(event_header,'$.fact.output.messageId')=?2
               AND sequence<=?3
             ORDER BY sequence LIMIT 1",
            )?
            .query_row(
                rusqlite::params![&stored.event.invocation.invocation_id, message_id, sequence],
                |row| row.get(0),
            )
            .optional()?;
        let start = crate::sequence_number(
            start.ok_or_else(|| invalid("executor message lacks canonical start"))?,
        )?;
        let mut text = String::new();
        let mut statement = db.prepare_cached(
            "SELECT json_extract(event_header,'$.fact.output.text')
             FROM event_log INDEXED BY executor_output_kinds
             WHERE kind='executor_observed' AND invocation_id=?1
               AND json_extract(event_header,'$.fact.output.type')='output_delta'
               AND json_extract(event_header,'$.fact.output.messageId')=?2
               AND sequence<=?3
             ORDER BY sequence",
        )?;
        let mut observations = statement.query(rusqlite::params![
            &stored.event.invocation.invocation_id,
            message_id,
            sequence,
        ])?;
        while let Some(row) = observations.next()? {
            let delta: Option<String> = row.get(0)?;
            text.push_str(
                delta
                    .as_deref()
                    .ok_or_else(|| invalid("executor body delta lacks text"))?,
            );
        }
        semantic::append_executor_message(&mut transition, stored, start, text);
    }
    let prepared = prepared?;
    for fragment_value in &transition.fragments {
        let directory = match &fragment_value.source {
            FragmentSource::CanonicalToolProjection => prepared.tool.as_ref(),
            FragmentSource::CanonicalModelPart { ordinal } => prepared.model_parts.get(ordinal),
            FragmentSource::Payload(_) => None,
        };
        fragment(db, fragment_value, directory)?;
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
    unknown_dispatch(db, stored, &frontier)?;
    close_unknown(db, stored, settled_dispatch)?;
    pending_unknown_notifications(db, stored, &frontier)?;
    if let Some(cut) = transition.stable_cut {
        db.execute(
            "INSERT INTO context_semantic_cuts VALUES(?,?,?,?,?)",
            rusqlite::params![
                owner,
                &stored.event.invocation.invocation_id,
                sequence,
                cut.source_sequence as i64,
                cut.item_index as i64
            ],
        )?;
    }
    if let Some(placeholder) = transition.archive {
        archive(db, stored, &placeholder)?;
    }
    let frontier_json = json(&frontier)?;
    if previous.as_deref() != Some(frontier_json.as_str()) {
        db.execute("INSERT INTO context_semantic_frontiers VALUES(?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET through_sequence=excluded.through_sequence,frontier_json=excluded.frontier_json", rusqlite::params![&stored.event.invocation.invocation_id, owner, sequence, frontier_json])?;
    }
    if availability.is_none() {
        db.execute(
            "INSERT INTO context_semantic_heads(session_id) VALUES(?)",
            rusqlite::params![owner],
        )?;
    }
    Ok(())
}

fn hydrate_copy(db: &Connection, owner: &str) -> Result<(), StoreError> {
    let done: bool = db
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM context_semantic_copies WHERE session_id=?)")?
        .query_row(rusqlite::params![owner], |row| row.get(0))?;
    if done {
        return Ok(());
    }
    let source: Option<String> = db
        .prepare_cached("SELECT source_session_id FROM session_history_copies WHERE session_id=?")?
        .query_row(rusqlite::params![owner], |row| row.get(0))
        .optional()?;
    let Some(source) = source else {
        return Ok(());
    };
    // The admitted Session-copy graph is acyclic. Mark before recursion so a
    // corrupt graph cannot recurse without bound during explicit derivation.
    db.execute(
        "INSERT INTO context_semantic_copies VALUES(?)",
        rusqlite::params![owner],
    )?;
    hydrate_copy(db, &source)?;
    let mut after = 0i64;
    loop {
        let records: Vec<(i64, Option<i64>)> = db.prepare_cached("SELECT sequence,archive_sequence FROM session_history_members WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128")?.query_map(rusqlite::params![owner, after], |row| Ok((row.get(0)?, row.get(1)?,)))?.collect::<Result<Vec<_>, _>>()?;
        if records.is_empty() {
            break;
        }
        for (sequence, archive_sequence) in records {
            copy_member(db, owner, sequence, archive_sequence)?;
            after = sequence;
        }
    }
    db.execute("INSERT INTO context_semantic_heads(session_id) VALUES(?) ON CONFLICT(session_id) DO NOTHING", rusqlite::params![owner])?;
    Ok(())
}

pub(crate) fn copy_member(
    db: &Connection,
    owner: &str,
    sequence: i64,
    archive_sequence: Option<i64>,
) -> Result<(), StoreError> {
    let (source,through,observed):(String,i64,i64)=db.prepare_cached("SELECT source_session_id,through_sequence,observed_through FROM session_history_copies WHERE session_id=?")?.query_row(rusqlite::params![owner], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?;
    hydrate_copy(db, &source)?;
    let failure:Option<String>=db.prepare_cached("SELECT unavailable_reason FROM context_semantic_heads WHERE session_id=? AND unavailable_at<=?")?.query_row(rusqlite::params![&source, observed], |row| row.get(0)).optional()?;
    if let Some(reason) = failure {
        unavailable(db, owner, sequence, &reason)?;
        return Ok(());
    }
    let records: Vec<(String, String, String, bool, bool)> = db.prepare_cached("SELECT r.row_json,r.event_id,r.revision_invocation,r.visible,r.unknown_only FROM context_semantic_rows r
        WHERE r.owner_session_id=?1 AND r.source_sequence=?2 AND r.revision<=?3
          AND ((r.archived=0 AND r.revision<=?4 AND ?5 IS NULL) OR (r.archived=1 AND r.revision=?5))
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index
            AND n.revision>r.revision AND n.revision<=?3
            AND ((n.archived=0 AND n.revision<=?4 AND ?5 IS NULL) OR (n.archived=1 AND n.revision=?5)))")?.query_map(rusqlite::params![&source, sequence, observed, through, archive_sequence], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,)))?.collect::<Result<Vec<_>, _>>()?;
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
    db.execute("INSERT OR IGNORE INTO context_semantic_cuts(owner_session_id,invocation_id,revision,cut_sequence,cut_index) SELECT ?1,invocation_id,revision,cut_sequence,cut_index FROM context_semantic_cuts WHERE owner_session_id=?2 AND revision=?3", rusqlite::params![owner, &source, sequence])?;
    let completed = db.execute(
        "INSERT OR IGNORE INTO context_semantic_copies(session_id) VALUES(?)",
        rusqlite::params![owner],
    )?;
    if completed != 0 {
        db.execute("INSERT INTO context_semantic_heads(session_id) VALUES(?) ON CONFLICT(session_id) DO NOTHING", rusqlite::params![owner])?;
    }
    Ok(())
}
