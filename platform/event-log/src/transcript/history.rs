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
    read::{row_position, sql_number, sql_position},
    tool_metadata::read_on_worker as tool_metadata,
};
use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::Chunk;
use maka_agent_ports::session::history::Cursor;
use maka_agent_ports::session::history::ModelPartIdentity;
use maka_agent_ports::session::history::Page;
use maka_agent_ports::session::history::Position;
use maka_agent_ports::session::history::Role;
use maka_agent_ports::session::history::{HistoryField, HistoryView};
use rusqlite::OptionalExtension;

// Text windows and exact source reads retain material labels in their body.
pub(super) const BODY: &str = "COALESCE(CASE json_extract(payload, '$.type')
                    WHEN 'user' THEN (SELECT group_concat(line, char(10)) FROM (
                        SELECT COALESCE(json_extract(payload, '$.displayText'), json_extract(payload, '$.text'), '') AS line
                            WHERE COALESCE(json_extract(payload, '$.displayText'), json_extract(payload, '$.text'), '') != ''
                        UNION ALL
                        SELECT '↳ ' || json_extract(value, '$.name') || CASE
                            WHEN json_type(value, '$.bytes') IS NOT 'integer' THEN ''
                            WHEN json_extract(value, '$.bytes') < 1024 THEN ' · ' || json_extract(value, '$.bytes') || ' B'
                            WHEN json_extract(value, '$.bytes') < 1048576 THEN printf(' · %.1f KiB', json_extract(value, '$.bytes') / 1024.0)
                            ELSE printf(' · %.1f MiB', json_extract(value, '$.bytes') / 1048576.0) END
                            FROM json_each(payload, '$.attachments') WHERE json_type(value, '$.name') = 'text'
                        UNION ALL
                        SELECT '▱ ' || json_extract(value, '$.path')
                            FROM json_each(payload, '$.directoryReferences') WHERE json_type(value, '$.path') = 'text'))
                    WHEN 'assistant' THEN json_extract(payload, '$.text')
                    WHEN 'model_interruption' THEN json_extract(payload, '$.message')
                    WHEN 'turn_state' THEN CASE WHEN json_extract(payload, '$.status') = 'failed' THEN
                        COALESCE(NULLIF(json_extract(payload, '$.failureMessage'), ''), NULLIF(json_extract(payload, '$.errorClass'), ''), 'failed') END
                    WHEN 'tool_call' THEN COALESCE(json_extract(payload, '$.intent'), json_extract(payload, '$.args.intent'), '')
                    WHEN 'tool_result' THEN CASE json_extract(payload, '$.content.kind')
                        WHEN 'text' THEN json_extract(payload, '$.content.text')
                        WHEN 'json' THEN (SELECT group_concat(atom, char(10)) FROM json_tree(payload, '$.content.value') WHERE type = 'text')
                        WHEN 'operation' THEN (SELECT group_concat(atom, char(10)) FROM json_tree(payload, '$.content.reply.receipt.outcome.value') WHERE type = 'text')
                        ELSE '' END
                    ELSE '' END, '')";

// Conversation windows carry attachments separately. Directory references
// still need their labels because they have no structured history field.
const CONVERSATION_USER: &str = "COALESCE((SELECT group_concat(line, char(10)) FROM (
    SELECT COALESCE(json_extract(payload, '$.displayText'), json_extract(payload, '$.text'), '') AS line
        WHERE COALESCE(json_extract(payload, '$.displayText'), json_extract(payload, '$.text'), '') != ''
    UNION ALL
    SELECT '▱ ' || json_extract(value, '$.path')
        FROM json_each(payload, '$.directoryReferences') WHERE json_type(value, '$.path') = 'text')), '')";

impl EventLog {
    /// Exact ascending UTF-8 windows over immutable derived text. The byte and
    /// fragment budgets apply to the whole window, never to a silently clipped
    /// message. Before reads a prefix ending exclusively at its cursor; After
    /// starts inclusively. `max_json_bytes` targets the complete serialized page,
    /// including metadata and empty projection boundaries. The first complete
    /// fragment advances even when its metadata exceeds this target; subsequent
    /// fragments are packed within it. Cursor positions grant no access.
    pub async fn history_text(
        &self,
        session: &str,
        through: u64,
        position: Position,
        include_thinking: bool,
        limits: crate::transcript::HistoryLimits,
    ) -> Result<Page, StoreError> {
        self.history_view(
            session,
            through,
            position,
            include_thinking,
            HistoryView::Text,
            limits,
        )
        .await
    }

    pub async fn history_view(
        &self,
        session: &str,
        through: u64,
        position: Position,
        include_thinking: bool,
        view: HistoryView,
        limits: crate::transcript::HistoryLimits,
    ) -> Result<Page, StoreError> {
        crate::sessions::validate_id(session)?;
        self.history_view_owned(
            super::HistoryOwner::Session(session.to_owned()),
            through,
            position,
            include_thinking,
            view,
            limits,
        )
        .await
    }

    pub(crate) async fn history_view_owned(
        &self,
        owner: super::HistoryOwner,
        through: u64,
        position: Position,
        include_thinking: bool,
        view: HistoryView,
        limits: crate::transcript::HistoryLimits,
    ) -> Result<Page, StoreError> {
        let crate::transcript::HistoryLimits {
            max_bytes,
            max_chunks,
            max_json_bytes,
        } = limits;
        if max_bytes < 4 || max_chunks == Some(0) || max_json_bytes == 0 {
            return Err(invalid("invalid history window limits"));
        }
        let fence = through;
        sql_number(fence)?;
        // A serialized chunk occupies at least one byte. The delivery budget
        // therefore bounds rows even when a caller needs no item-count limit.
        let max_chunks = max_chunks.unwrap_or(max_json_bytes).min(max_json_bytes);
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure_owner(tx, owner.clone(), fence)?;
                    read_page(
                        tx,
                        &owner,
                        through,
                        position,
                        include_thinking,
                        view,
                        max_bytes,
                        max_chunks,
                        max_json_bytes,
                    )
                })
            })
            .await
    }
}

// bodycache::run owns transaction completion and maintenance for this page.
#[allow(clippy::too_many_arguments)]
fn read_page(
    tx: &rusqlite::Connection,
    owner: &super::HistoryOwner,
    through: u64,
    position: Position,
    include_thinking: bool,
    view: HistoryView,
    max_bytes: usize,
    max_chunks: usize,
    max_json_bytes: usize,
) -> Result<Page, StoreError> {
    let session = owner.key();
    let fence = through;
    let through_sql = sql_number(through)?;
    let mut final_outputs = std::collections::HashMap::new();
    let target = if let Position::Row { position, field } = position {
        if position.validate().is_err()
            || position.source_sequence > fence
            || (!include_thinking && field == HistoryField::Thinking)
        {
            return Err(invalid("history row exceeds its fence"));
        }
        materialize(tx, owner, position, view, through_sql)?;
        // Header lookup requires the actual field; a tool Body cannot
        // impersonate a Thinking field that was never recorded.
        header(tx, session, position, field, view, through_sql)?;
        Some((position, field))
    } else {
        None
    };
    let anchor = match position {
        Position::Before { cursor } | Position::After { cursor } => {
            if cursor.position.source_sequence > fence
                || (!include_thinking && cursor.field == HistoryField::Thinking)
            {
                return Err(invalid("history cursor exceeds its fence"));
            }
            sql_number(cursor.offset)?;
            materialize(tx, owner, cursor.position, view, through_sql)?;
            let row = header(
                tx,
                session,
                cursor.position,
                cursor.field,
                view,
                through_sql,
            )?;
            if cursor.offset > row.total {
                return Err(invalid("history offset exceeds message"));
            }
            let byte = if cursor.offset == row.total {
                Vec::new()
            } else {
                fragment(
                    tx,
                    session,
                    cursor,
                    1,
                    view == HistoryView::Conversation && row.role == "user",
                )?
            };
            if byte.first().is_some_and(|byte| byte & 0xc0 == 0x80) {
                return Err(invalid("history offset splits UTF-8"));
            }
            Some((cursor, row))
        }
        _ => None,
    };
    let (reverse, boundary, inclusive) = match position {
        Position::Start => (false, None, true),
        Position::Tail => (true, None, true),
        Position::Row { position, .. } => (false, Some(position), true),
        Position::Before { cursor } => (
            true,
            Some(cursor.position),
            cursor.offset > 0 || (include_thinking && cursor.field == HistoryField::Body),
        ),
        Position::After { cursor } => (
            false,
            Some(cursor.position),
            cursor.offset < anchor.as_ref().unwrap().1.total
                || cursor.field == HistoryField::Thinking,
        ),
        Position::Event { sequence } => {
            if sequence == 0 || sequence > through {
                return Err(invalid("history event exceeds its fence"));
            }
            (
                false,
                Some(RowPosition {
                    source_sequence: sequence,
                    item_index: 0,
                }),
                true,
            )
        }
    };
    let boundary_order = if let Some(boundary) = boundary {
        let pair: Option<(i64, i64)> = if let Position::Event { sequence } = position {
            tx.prepare_cached("SELECT order_sequence,order_item FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?2 ORDER BY order_sequence,order_item LIMIT 1")?.query_row( rusqlite::params![session, sql_number(sequence)?], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?
        } else {
            tx.prepare_cached(super::read::ORDER)?
                .query_row(
                    rusqlite::params![
                        session,
                        sql_position(boundary)?.0,
                        sql_position(boundary)?.1
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
        };
        Some(match pair {
            Some(pair) => pair,
            None if matches!(position, Position::Event { .. }) => sql_position(boundary)?,
            None => return Err(invalid("history cursor was not found")),
        })
    } else {
        None
    };
    let query = match (reverse, boundary_order.is_some(), inclusive) {
        (true, false, _) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 ORDER BY order_sequence DESC,order_item DESC LIMIT ?3"
        }
        (false, false, _) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 ORDER BY order_sequence,order_item LIMIT ?3"
        }
        (true, true, true) => {
            "SELECT source_sequence,item_index FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND (order_sequence,order_item)<=(?4,?5) ORDER BY order_sequence DESC,order_item DESC LIMIT ?3"
        }
        (true, true, false) => {
            "SELECT source_sequence,item_index FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND (order_sequence,order_item)<(?4,?5) ORDER BY order_sequence DESC,order_item DESC LIMIT ?3"
        }
        (false, true, true) => {
            "SELECT source_sequence,item_index FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 AND (order_sequence,order_item)>=(?4,?5) ORDER BY order_sequence,order_item LIMIT ?3"
        }
        (false, true, false) => {
            "SELECT source_sequence,item_index FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 AND (order_sequence,order_item)>(?4,?5) ORDER BY order_sequence,order_item LIMIT ?3"
        }
    };
    let rows = {
        let mut statement = tx.prepare_cached(query)?;
        let decode = |row: &rusqlite::Row<'_>| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?));
        let rows = if let Some((sequence, item)) = boundary_order {
            statement.query_map(
                rusqlite::params![
                    session,
                    through_sql,
                    (max_chunks + 1) as i64,
                    sequence,
                    item
                ],
                decode,
            )?
        } else {
            statement.query_map(
                rusqlite::params![session, through_sql, (max_chunks + 1) as i64],
                decode,
            )?
        };
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut chunks = Vec::new();
    let mut chunks_json_bytes = 0;
    let mut bytes = 0;
    let mut projected = 0;
    let mut left = None;
    let mut right = None;
    'rows: for locator in rows {
        if chunks.len() == max_chunks
            || bytes == max_bytes
            || (projected >= 1024 * 1024 && left.is_some())
        {
            break;
        }
        let locator = row_position(locator.0, locator.1)?;
        // Materialize only actually visited rows, never a long message's
        // following rows. One oversized first row still progresses.
        projected += materialize(tx, owner, locator, view, through_sql)?;
        let has_thinking: bool = include_thinking && tx.prepare_cached("SELECT has_thinking FROM transcript_directory WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3")?.query_row( rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1], |row| row.get(0))?;
        let mut fields = vec![HistoryField::Body];
        if include_thinking && has_thinking {
            fields.insert(0, HistoryField::Thinking);
        }
        if reverse {
            fields.reverse();
        }
        for field in fields {
            if chunks.len() == max_chunks || bytes == max_bytes {
                break 'rows;
            }
            if target == Some((locator, HistoryField::Body)) && field == HistoryField::Thinking {
                continue;
            }
            let row = header(tx, session, locator, field, view, through_sql)?;
            let exact_target = target == Some((locator, field));
            if let Some((cursor, _)) = &anchor
                && cursor.position == locator
            {
                let before = field == HistoryField::Thinking && cursor.field == HistoryField::Body;
                let after = field == HistoryField::Body && cursor.field == HistoryField::Thinking;
                if (reverse && after) || (!reverse && before) {
                    continue;
                }
                if field == cursor.field
                    && ((reverse && cursor.offset == 0) || (!reverse && cursor.offset == row.total))
                {
                    continue;
                }
            }
            let cursor_offset = anchor
                .as_ref()
                .filter(|(cursor, _)| cursor.position == locator && cursor.field == field)
                .map(|(cursor, _)| cursor.offset);
            let (mut start, end) = if reverse {
                let end = cursor_offset.unwrap_or(row.total);
                (end.saturating_sub((max_bytes - bytes) as u64), end)
            } else {
                let start = cursor_offset.unwrap_or(0);
                (start, row.total.min(start + (max_bytes - bytes) as u64))
            };
            let fragment = if row.total == 0 {
                Vec::new()
            } else {
                fragment(
                    tx,
                    session,
                    Cursor {
                        field,
                        position: locator,
                        offset: start,
                    },
                    end - start,
                    view == HistoryView::Conversation && row.role == "user",
                )?
            };
            let text = if reverse {
                let skip = fragment
                    .iter()
                    .take_while(|byte| **byte & 0xc0 == 0x80)
                    .count();
                start += skip as u64;
                std::str::from_utf8(&fragment[skip..])
                    .map_err(|_| invalid("invalid history UTF-8"))?
            } else {
                match std::str::from_utf8(&fragment) {
                    Ok(text) => text,
                    Err(error) if error.error_len().is_none() => {
                        std::str::from_utf8(&fragment[..error.valid_up_to()])
                            .map_err(|_| invalid("invalid history UTF-8"))?
                    }
                    Err(_) => return Err(invalid("invalid history UTF-8")),
                }
            };
            if text.is_empty() && row.total > 0 {
                break 'rows;
            }
            let end = start + text.len() as u64;
            let beginning = Cursor {
                field,
                position: locator,
                offset: start,
            };
            let ending = (
                Cursor {
                    field,
                    position: locator,
                    offset: end,
                },
                row.total,
            );
            let candidate_left = if reverse {
                Some(beginning)
            } else {
                left.or(Some(beginning))
            };
            let candidate_right = if reverse {
                right.or(Some(ending))
            } else {
                Some(ending)
            };
            let (attachments, has_references) = if start == 0 && row.role == "user" {
                let (encoded, has_references): (Option<String>, bool) = tx.prepare_cached("SELECT json_extract(payload, '$.attachments'),
                        COALESCE(json_array_length(payload, '$.quotes'), 0) > 0
                        OR COALESCE(json_array_length(payload, '$.directoryReferences'), 0) > 0
                        OR COALESCE(json_array_length(payload, '$.inlineReferences'), 0) > 0
                     FROM temp.transcript_rows WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3")?.query_row( rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1], |row| Ok((row.get(0)?, row.get(1)?,)))?;
                (
                    encoded
                        .map(|value| serde_json::from_str::<Vec<maka_agent_facts::attachment::AttachmentRef>>(&value))
                        .transpose()?
                        .unwrap_or_default(),
                    has_references,
                )
            } else {
                (Vec::new(), false)
            };
            let emit = (!row.hidden || exact_target)
                && (exact_target
                    || row.total != 0
                    || matches!(row.role.as_str(), "tool_call" | "tool_result")
                    || (view == HistoryView::Conversation && !attachments.is_empty())
                    || (view == HistoryView::Conversation && row.role == "context_compacted"));
            if emit {
                let role = match row.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    "tool_call" => Role::ToolCall,
                    "tool_result" => Role::ToolResult,
                    "context_compacted" => Role::Compaction,
                    "turn_state" | "model_interruption" => Role::Failure,
                    _ => return Err(invalid("invalid history text role")),
                };
                let tool = if matches!(role, Role::ToolCall | Role::ToolResult) {
                    Some(tool_metadata(tx, session, locator, through_sql)?)
                } else {
                    None
                };
                let timing = super::timing::read_on_worker(tx, session, &row.turn, through_sql)?;
                let compaction = if role == Role::Compaction {
                    let duration: i64 = tx.prepare_cached("SELECT json_extract(payload, '$.durationMs') FROM temp.transcript_rows WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3")?.query_row( rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1], |row| row.get(0))?;
                    Some(maka_agent_ports::session::history::Compaction {
                        duration_ms: sequence_number(duration)?,
                    })
                } else {
                    None
                };
                let (model, final_output) = if role == Role::Assistant {
                    let output = match final_outputs.entry(row.turn.clone()) {
                        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert(super::final_output::resolve_on_worker(
                                tx,
                                session,
                                &row.turn,
                                through_sql,
                            )?)
                        }
                    };
                    let metadata =
                        super::model::resolve_on_worker(tx, session, locator, through_sql)?;
                    let final_output = field == HistoryField::Body
                        && row.total > 0
                        && metadata
                            .producer
                            .as_ref()
                            .is_some_and(|producer| output.as_ref() == Some(producer));
                    (metadata.model, final_output)
                } else {
                    (None, false)
                };
                let part: Option<(String, i64)> = tx.prepare_cached("SELECT p.step_id, p.ordinal FROM model_part_records p
                     WHERE p.owner_session_id = (SELECT event_session FROM runtime_events WHERE sequence = ?1)
                       AND p.message_id = ?2 AND p.ordinal IS NOT NULL AND p.source_sequence <= ?3")?.query_row( rusqlite::params![sql_number(locator.source_sequence)?, &row.message, through_sql], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
                let model_part = part
                    .map(|(step_id, ordinal)| {
                        Ok::<_, StoreError>(ModelPartIdentity {
                            step_id,
                            ordinal: sequence_number(ordinal)?,
                        })
                    })
                    .transpose()?;
                let (order_sequence, order_item): (i64, i64) =
                    tx.prepare_cached(super::read::ORDER)?.query_row(
                        rusqlite::params![
                            session,
                            sql_position(locator)?.0,
                            sql_position(locator)?.1
                        ],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                let chunk = Chunk {
                    order: row_position(order_sequence, order_item)?,
                    model_part,
                    has_references,
                    field,
                    timing,
                    compaction,
                    origin: row.origin,
                    model,
                    final_output,
                    message_id: row.message,
                    turn_id: row.turn,
                    timestamp: row.timestamp,
                    role,
                    position: locator,
                    offset: start,
                    total_bytes: row.total,
                    text: text.to_owned(),
                    attachments,
                    tool,
                };
                chunks_json_bytes += serde_json::to_vec(&chunk)?.len();
                chunks.push(chunk);
            }
            // Bound the complete canonical delivery, including attachment
            // descriptors and JSON escaping. A rejected candidate does not
            // advance the source boundary or silently discard any metadata.
            let (before, after) = boundaries(
                tx,
                session,
                through_sql,
                include_thinking,
                candidate_left,
                candidate_right,
            )?;
            // The empty envelope includes []; each chunk adds its exact
            // encoded bytes, plus commas between elements. Cursor changes
            // still count even when this boundary emits no chunk.
            let envelope = Page::Ready {
                through,
                chunks: Vec::new(),
                before,
                after,
            };
            let fits = serde_json::to_vec(&envelope)?.len()
                + chunks_json_bytes
                + chunks.len().saturating_sub(1)
                <= max_json_bytes;
            if !fits && chunks.len() > usize::from(emit) {
                if emit {
                    chunks.pop();
                }
                break 'rows;
            }
            bytes += text.len();
            left = candidate_left;
            right = candidate_right;
            if (!reverse && end < row.total) || (reverse && start > 0) {
                break 'rows;
            }
        }
    }
    if reverse {
        chunks.reverse();
    }
    if left.is_none() {
        if let Some((cursor, row)) = anchor {
            left = Some(cursor);
            right = Some((cursor, row.total));
        } else if matches!(position, Position::Event { .. }) {
            let last: Option<(i64,i64)> = tx.prepare_cached("SELECT source_sequence,item_index FROM transcript_directory WHERE owner_key = ?1 AND source_sequence <= ?2 AND order_sequence <= ?2 ORDER BY order_sequence DESC,order_item DESC LIMIT 1")?.query_row( rusqlite::params![session, through_sql], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
            if let Some(locator) = last {
                let locator = row_position(locator.0, locator.1)?;
                materialize(tx, owner, locator, view, through_sql)?;
                let row = header(tx, session, locator, HistoryField::Body, view, through_sql)?;
                let cursor = Cursor {
                    field: HistoryField::Body,
                    position: locator,
                    offset: row.total,
                };
                left = Some(cursor);
                right = Some((cursor, row.total));
            }
        }
    }
    let (before, after) = boundaries(tx, session, through_sql, include_thinking, left, right)?;

    Ok(Page::Ready {
        through,
        chunks,
        before,
        after,
    })
}

fn boundaries(
    tx: &rusqlite::Connection,
    session: &str,
    through: i64,
    include_thinking: bool,
    left: Option<Cursor>,
    right: Option<(Cursor, u64)>,
) -> Result<(Option<Cursor>, Option<Cursor>), StoreError> {
    let before = match left {
        Some(cursor)
            if cursor.offset > 0
                || neighbor(tx, session, through, cursor, include_thinking, true)? =>
        {
            Some(cursor)
        }
        _ => None,
    };
    let after = match right {
        Some((cursor, total))
            if cursor.offset < total
                || neighbor(tx, session, through, cursor, include_thinking, false)? =>
        {
            Some(cursor)
        }
        _ => None,
    };
    Ok((before, after))
}

struct Header {
    origin: Option<maka_agent_facts::message::MessageOrigin>,
    message: String,
    turn: String,
    timestamp: u64,
    role: String,
    hidden: bool,
    total: u64,
}
fn header(
    tx: &rusqlite::Connection,
    session: &str,
    locator: RowPosition,
    field: HistoryField,
    view: HistoryView,
    through: i64,
) -> Result<Header, StoreError> {
    if view == HistoryView::Conversation
        && field == HistoryField::Body
        && let Some(row) = conversation_tool(tx, session, locator, through)?
    {
        return Ok(row);
    }
    let (message, turn, timestamp, role, total, origin) = tx.prepare_cached("SELECT source.message_id, source.turn_id, source.timestamp, source.role,
            CASE WHEN source.role = 'turn_state' AND source.state_status IS NOT 'failed' AND ?4 = 'body'
                THEN 0 ELSE length(cached.body) END,
            CASE WHEN source.role = 'user' THEN source.user_origin END
            FROM transcript_directory source LEFT JOIN temp.transcript_text cached
                ON cached.owner_key = source.owner_key AND cached.source_sequence = source.source_sequence
                AND cached.item_index = source.item_index AND cached.field = ?4
            WHERE source.owner_key = ?1 AND source.source_sequence = ?2 AND source.item_index = ?3
                AND (cached.field IS NOT NULL OR
                    (source.role = 'turn_state' AND source.state_status IS NOT 'failed' AND ?4 = 'body'))")?.query_row(
        rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1, field_name(field)],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, Option<String>>(5)?)),
    )?;
    let mut header = Header {
        origin: origin
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        message,
        turn,
        timestamp: sequence_number(timestamp)?,
        role,
        hidden: false,
        total: sequence_number(total)?,
    };
    if view == HistoryView::Conversation && field == HistoryField::Body && header.role == "user" {
        let query = format!(
            "SELECT length(CAST({CONVERSATION_USER} AS BLOB)) FROM temp.transcript_rows
            WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3"
        );
        header.total = sequence_number(tx.prepare_cached(query.as_str())?.query_row(
            rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1],
            |row| row.get(0),
        )?)?;
    }
    Ok(header)
}

fn fragment(
    tx: &rusqlite::Connection,
    session: &str,
    cursor: Cursor,
    bytes: u64,
    conversation_user: bool,
) -> Result<Vec<u8>, StoreError> {
    let query = if conversation_user {
        format!(
            "SELECT substr(CAST({CONVERSATION_USER} AS BLOB), ?4, ?5) FROM temp.transcript_rows
            WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3"
        )
    } else {
        "SELECT substr(body, ?4, ?5) FROM temp.transcript_text
            WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3 AND field = ?6"
            .into()
    };
    let mut statement = tx.prepare_cached(&query)?;
    let (sequence, item) = sql_position(cursor.position)?;
    let start = sql_number(cursor.offset)? + 1;
    let bytes = sql_number(bytes)?;
    let fragment = if conversation_user {
        statement.query_row(
            rusqlite::params![session, sequence, item, start, bytes],
            |row| row.get(0),
        )?
    } else {
        statement.query_row(
            rusqlite::params![
                session,
                sequence,
                item,
                start,
                bytes,
                field_name(cursor.field)
            ],
            |row| row.get(0),
        )?
    };
    Ok(fragment)
}

fn conversation_tool(
    tx: &rusqlite::Connection,
    session: &str,
    locator: RowPosition,
    through: i64,
) -> Result<Option<Header>, StoreError> {
    let row = tx.prepare_cached("SELECT row.message_id, row.turn_id, row.timestamp,
            row.role, row.tool_origin,
            COALESCE(row.tool_name, call.tool_name),
            COALESCE(row.is_error, 0)
        FROM transcript_directory row LEFT JOIN transcript_directory call
            ON call.owner_key = row.owner_key AND call.turn_id = row.turn_id
            AND call.message_id = row.tool_use_id
            AND call.role = 'tool_call' AND call.source_sequence <= ?4
        WHERE row.owner_key = ?1 AND row.source_sequence = ?2 AND row.item_index = ?3 AND row.source_sequence <= ?4
            AND row.role IN ('tool_call', 'tool_result')")?.query_row(
        rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1, through],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, bool>(6)?)),
    ).optional()?;
    let Some((message, turn, timestamp, role, origin, name, error)) = row else {
        return Ok(None);
    };
    let internal = !error
        && (matches!(
            (origin.as_deref(), name.as_deref()),
            (Some("provider"), Some("wait" | "tool_search"))
                | (Some("code_mode"), Some("code_cell" | "tool_search"))
        ));
    Ok(Some(Header {
        origin: None,
        message,
        turn,
        timestamp: sequence_number(timestamp)?,
        role,
        hidden: internal,
        total: 0,
    }))
}

fn neighbor(
    tx: &rusqlite::Connection,
    session: &str,
    through: i64,
    cursor: Cursor,
    include_thinking: bool,
    before: bool,
) -> Result<bool, StoreError> {
    if include_thinking {
        if !before && cursor.field == HistoryField::Thinking {
            return Ok(true);
        }
        if before && cursor.field == HistoryField::Body {
            let exists: bool = tx.prepare_cached("SELECT has_thinking FROM transcript_directory WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3")?.query_row( rusqlite::params![session, sql_position(cursor.position)?.0, sql_position(cursor.position)?.1], |row| row.get(0))?;
            if exists {
                return Ok(true);
            }
        }
    }
    let (sequence, item): (i64, i64) = tx.prepare_cached(super::read::ORDER)?.query_row(
        rusqlite::params![
            session,
            sql_position(cursor.position)?.0,
            sql_position(cursor.position)?.1
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let query = if before {
        "SELECT EXISTS(SELECT 1 FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND (order_sequence,order_item)<(?3,?4))"
    } else {
        "SELECT EXISTS(SELECT 1 FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 AND (order_sequence,order_item)>(?3,?4))"
    };
    Ok(tx
        .prepare_cached(query)?
        .query_row(rusqlite::params![session, through, sequence, item], |row| {
            row.get(0)
        })?)
}
fn materialize(
    tx: &rusqlite::Connection,
    owner: &super::HistoryOwner,
    locator: RowPosition,
    view: HistoryView,
    through: i64,
) -> Result<usize, StoreError> {
    let session = owner.key();
    if view == HistoryView::Conversation
        && conversation_tool(tx, session, locator, through)?.is_some()
    {
        return Ok(0);
    }
    // Non-failed turn states have no text under BODY. Their immutable directory
    // identity is sufficient for cursor progress; replaying their producer only
    // to cache an empty body repeats the completed invocation's evidence.
    let empty_state: bool = tx
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM transcript_directory
            WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3
                AND role = 'turn_state' AND state_status IS NOT 'failed')",
        )?
        .query_row(
            rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1],
            |row| row.get(0),
        )?;
    if empty_state {
        return Ok(0);
    }
    super::bodycache::ensure_for_owner_on_worker(tx, owner, locator)?;
    let source: Option<(i64, bool)> = tx.prepare_cached("SELECT total_bytes, EXISTS(SELECT 1 FROM temp.transcript_text cached WHERE cached.owner_key = source.owner_key AND cached.source_sequence = source.source_sequence AND cached.item_index = source.item_index AND cached.field = 'body')
            FROM temp.transcript_rows source WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3")?.query_row( rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    let Some((bytes, cached)) = source else {
        return Err(invalid("history row was not found"));
    };
    if cached {
        return Ok(0);
    }
    let query = format!(
        "INSERT INTO temp.transcript_text
            SELECT owner_key, source_sequence, item_index, 'body', json_extract(payload, '$.ts'), json_extract(payload, '$.type'),
                CAST({BODY} AS BLOB)
            FROM temp.transcript_rows WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3
            UNION ALL
            SELECT owner_key, source_sequence, item_index, 'thinking', json_extract(payload, '$.ts'), 'assistant',
                CAST(json_extract(payload, '$.thinking.text') AS BLOB)
            FROM temp.transcript_rows WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3
                AND json_extract(payload, '$.type') = 'assistant' AND json_type(payload, '$.thinking.text') = 'text'"
    );
    tx.execute(
        query.as_str(),
        rusqlite::params![session, sql_position(locator)?.0, sql_position(locator)?.1],
    )?;
    usize::try_from(sequence_number(bytes)?)
        .map_err(|_| invalid("history source exceeds address space"))
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn field_name(field: HistoryField) -> &'static str {
    match field {
        HistoryField::Body => "body",
        HistoryField::Thinking => "thinking",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    fn neighbor(
        tx: &Connection,
        session: &str,
        through: i64,
        cursor: Cursor,
        include_thinking: bool,
        before: bool,
    ) -> Result<bool, StoreError> {
        super::neighbor(tx, session, through, cursor, include_thinking, before)
    }

    fn conversation_tool(
        tx: &Connection,
        session: &str,
        locator: RowPosition,
        through: i64,
    ) -> Result<Option<Header>, StoreError> {
        super::conversation_tool(tx, session, locator, through)
    }

    #[test]
    fn conversation_retains_trace_parents_and_hides_transport_helpers() {
        let db = Connection::open_in_memory().unwrap();
        crate::transcript::bodycache::initialize(&db).unwrap();
        let rows = [
            json!({"type":"tool_call","origin":"provider","toolName":"exec"}),
            json!({"type":"tool_call","origin":"code_mode","toolName":"code_cell"}),
            json!({"type":"tool_call","origin":"imported","toolName":"exec"}),
            json!({"type":"tool_call","origin":"provider","toolName":"cua_repl"}),
            json!({"type":"tool_call","origin":"host_sdk","toolName":"cua_operation","parentToolCallId":"4"}),
            json!({"type":"tool_result","origin":"provider","toolUseId":"4","isError":false}),
            json!({"type":"tool_result","origin":"provider","toolUseId":"1","isError":true}),
        ];
        for (i, mut value) in rows.into_iter().enumerate() {
            value["ts"] = json!(1);
            db.execute("INSERT INTO transcript_directory (owner_key,source_sequence,item_index,message_id,turn_id,timestamp,role,has_thinking,tool_origin,tool_name,tool_use_id,is_error,context_eligible,order_sequence,order_item) SELECT 'a',?1,0,?2,'turn',1,json_extract(?3,'$.type'),0,json_extract(?3,'$.origin'),json_extract(?3,'$.toolName'),json_extract(?3,'$.toolUseId'),json_extract(?3,'$.isError'),json_extract(?3,'$.type') IN ('tool_call','tool_result'),?1,0", rusqlite::params![(i+1) as i64, (i+1).to_string(), serde_json::to_vec(&value).unwrap()])
                .unwrap();
        }
        for (locator, visible) in [
            (1, true),
            (2, false),
            (3, true),
            (4, true),
            (5, true),
            (6, true),
            (7, true),
        ] {
            let row = conversation_tool(
                &db,
                "a",
                RowPosition {
                    source_sequence: locator,
                    item_index: 0,
                },
                7,
            )
            .unwrap()
            .unwrap();
            assert_eq!(!row.hidden, visible, "locator {locator}");
            assert_eq!(row.total, 0);
        }
        // A parent without a child at the requested fence remains visible.
        assert_eq!(
            conversation_tool(
                &db,
                "a",
                RowPosition {
                    source_sequence: 4,
                    item_index: 0
                },
                4
            )
            .unwrap()
            .unwrap()
            .role,
            "tool_call"
        );
    }

    #[test]
    fn predecessor_seek_work_is_bounded_by_cursor_not_following_history() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        fn probe(db: &mut Connection, through: i64) -> usize {
            let steps = Arc::new(AtomicUsize::new(0));
            let observed = steps.clone();
            db.progress_handler(
                1,
                Some(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
            let found = neighbor(
                db,
                "a",
                through,
                Cursor {
                    position: RowPosition {
                        source_sequence: 1,
                        item_index: 0,
                    },
                    field: HistoryField::Body,
                    offset: 0,
                },
                false,
                true,
            );
            db.progress_handler(0, None::<fn() -> bool>).unwrap();
            assert!(!found.unwrap(), "the first row has no predecessor");
            steps.load(Ordering::Relaxed)
        }

        let mut db = Connection::open_in_memory().unwrap();
        crate::transcript::bodycache::initialize(&db).unwrap();
        let mut measurements = Vec::new();
        for (first, last) in [(1_i64, 64_i64), (65, 4096)] {
            // Use the production directory schema/indexes. Setup is outside the
            // handler; count only the real neighbor function, not a SQL copy.
            db.execute("WITH RECURSIVE n(value) AS (SELECT ?1 UNION ALL SELECT value+1 FROM n WHERE value<?2) INSERT INTO transcript_directory(owner_key,source_sequence,item_index,turn_id,message_id,timestamp,role,has_thinking,context_eligible,order_sequence,order_item) SELECT 'a',value,0,'turn',CAST(value AS TEXT),1,'user',0,1,value,0 FROM n", rusqlite::params![first, last])
                .unwrap();
            measurements.push(probe(&mut db, last));
        }
        let [small, large] = measurements.as_slice() else {
            unreachable!()
        };
        assert!(
            *small > 0 && *large > 0,
            "progress handler must observe work"
        );
        eprintln!("predecessor progress callbacks: 64={small}, 4096={large}");
        assert!(
            *large <= *small + 128,
            "same empty predecessor lookup grew with following rows: 64={small}, 4096={large}"
        );

        let first = Cursor {
            position: RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            field: HistoryField::Body,
            offset: 0,
        };
        assert!(neighbor(&db, "a", 4096, first, false, false).unwrap());
        assert!(
            !neighbor(&db, "a", 1, first, false, false).unwrap(),
            "a successor beyond the frozen fence must not appear"
        );
    }
}
