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
use sqlx::{Row, sqlite::SqliteWorkerConnection};

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
        let crate::transcript::HistoryLimits {
            max_bytes,
            max_chunks,
            max_json_bytes,
        } = limits;
        self.validate_root()?;
        if !(4..=128 * 1024).contains(&max_bytes)
            || max_chunks == Some(0)
            || !(1024..=1024 * 1024).contains(&max_json_bytes)
        {
            return Err(invalid("invalid history window limits"));
        }
        crate::sessions::validate_id(session)?;
        let fence = through;
        sql_number(fence)?;
        // A serialized chunk occupies at least one byte. The delivery budget
        // therefore bounds rows even when a caller needs no item-count limit.
        let max_chunks = max_chunks.unwrap_or(max_json_bytes).min(max_json_bytes);
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    Box::pin(async move {
                        super::directory::ensure(tx, &session, fence).await?;
                        crate::connection::worker_query(tx, move |worker| {
                            Box::pin(async move {
                                read_page(
                                    worker,
                                    &session,
                                    through,
                                    position,
                                    include_thinking,
                                    view,
                                    max_bytes,
                                    max_chunks,
                                    max_json_bytes,
                                )
                                .await
                            })
                        })
                        .await
                    })
                })
            })
            .await
    }
}

// Execute one bounded page with the original SQLx statement cache and row
// decoders. bodycache::run still owns transaction completion and maintenance.
#[allow(clippy::too_many_arguments)]
async fn read_page(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    through: u64,
    position: Position,
    include_thinking: bool,
    view: HistoryView,
    max_bytes: usize,
    max_chunks: usize,
    max_json_bytes: usize,
) -> Result<Page, StoreError> {
    let fence = through;
    let through_sql = sql_number(through)?;
    let mut final_outputs = std::collections::HashMap::new();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)")
            .bind(session)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(invalid("Session no longer exists"));
    }
    let target = if let Position::Row { position, field } = position {
        if position.validate().is_err()
            || position.source_sequence > fence
            || (!include_thinking && field == HistoryField::Thinking)
        {
            return Err(invalid("history row exceeds its fence"));
        }
        materialize(tx, session, position, view, through_sql).await?;
        // Header lookup requires the actual field; a tool Body cannot
        // impersonate a Thinking field that was never recorded.
        header(tx, session, position, field, view, through_sql).await?;
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
            materialize(tx, session, cursor.position, view, through_sql).await?;
            let row = header(
                tx,
                session,
                cursor.position,
                cursor.field,
                view,
                through_sql,
            )
            .await?;
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
                )
                .await?
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
    let query = match (reverse, boundary.is_some(), inclusive) {
        (true, false, _) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence DESC,item_index DESC LIMIT ?3"
        }
        (false, false, _) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence,item_index LIMIT ?3"
        }
        (true, true, true) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND (source_sequence,item_index)<=(?3,?4) ORDER BY source_sequence DESC,item_index DESC LIMIT ?2"
        }
        (true, true, false) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND (source_sequence,item_index)<(?3,?4) ORDER BY source_sequence DESC,item_index DESC LIMIT ?2"
        }
        (false, true, true) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 AND (source_sequence,item_index)>=(?4,?5) ORDER BY source_sequence,item_index LIMIT ?3"
        }
        (false, true, false) => {
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 AND (source_sequence,item_index)>(?4,?5) ORDER BY source_sequence,item_index LIMIT ?3"
        }
    };
    let mut query = sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(query)).bind(session);
    // A validated reverse anchor already implies the raw fence. Keep the
    // cursor pair as the sole upper bound so SQLite seeks directly to it.
    if !(reverse && boundary.is_some()) {
        query = query.bind(through_sql);
    }
    query = query.bind((max_chunks + 1) as i64);
    if let Some(boundary) = boundary {
        let (source, item) = sql_position(boundary)?;
        query = query.bind(source).bind(item);
    }
    let rows = query.fetch_all(&mut *tx).await?;
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
        projected += materialize(tx, session, locator, view, through_sql).await?;
        let has_thinking: bool = include_thinking && sqlx::query_scalar(
        "SELECT has_thinking FROM transcript_directory WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
    ).bind(session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).fetch_one(&mut *tx).await?;
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
            let row = header(tx, session, locator, field, view, through_sql).await?;
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
                )
                .await?
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
                let (encoded, has_references): (Option<String>, bool) = sqlx::query_as(
                    "SELECT json_extract(payload, '$.attachments'),
                        COALESCE(json_array_length(payload, '$.quotes'), 0) > 0
                        OR COALESCE(json_array_length(payload, '$.directoryReferences'), 0) > 0
                        OR COALESCE(json_array_length(payload, '$.inlineReferences'), 0) > 0
                     FROM temp.transcript_rows WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
                ).bind(session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).fetch_one(&mut *tx).await?;
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
                    Some(tool_metadata(tx, session, locator, through_sql).await?)
                } else {
                    None
                };
                let timing =
                    super::timing::read_on_worker(tx, session, &row.turn, through_sql).await?;
                let compaction = if role == Role::Compaction {
                    let duration: i64 = sqlx::query_scalar(
                "SELECT json_extract(payload, '$.durationMs') FROM temp.transcript_rows WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
            ).bind(session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).fetch_one(&mut *tx).await?;
                    Some(maka_agent_ports::session::history::Compaction {
                        duration_ms: sequence_number(duration)?,
                    })
                } else {
                    None
                };
                let (model, final_output) = if role == Role::Assistant {
                    let output = match final_outputs.entry(row.turn.clone()) {
                        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                        std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                            super::final_output::resolve_on_worker(
                                tx,
                                session,
                                &row.turn,
                                through_sql,
                            )
                            .await?,
                        ),
                    };
                    let metadata =
                        super::model::resolve_on_worker(tx, session, locator, through_sql).await?;
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
                let part: Option<(String, i64)> = sqlx::query_as(
                    "SELECT p.step_id, p.ordinal FROM model_part_records p
                     WHERE p.owner_session_id = (SELECT event_session FROM runtime_events WHERE sequence = ?1)
                       AND p.message_id = ?2 AND p.ordinal IS NOT NULL AND p.source_sequence <= ?3",
                ).bind(sql_number(locator.source_sequence)?).bind(&row.message).bind(through_sql)
                    .fetch_optional(&mut *tx).await?;
                let model_part = part
                    .map(|(step_id, ordinal)| {
                        Ok::<_, StoreError>(ModelPartIdentity {
                            step_id,
                            ordinal: sequence_number(ordinal)?,
                        })
                    })
                    .transpose()?;
                let chunk = Chunk {
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
            )
            .await?;
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
            let last: Option<(i64,i64)> = sqlx::query_as(
            "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id = ?1 AND source_sequence <= ?2 ORDER BY source_sequence DESC,item_index DESC LIMIT 1"
        ).bind(session).bind(through_sql).fetch_optional(&mut *tx).await?;
            if let Some(locator) = last {
                let locator = row_position(locator.0, locator.1)?;
                materialize(tx, session, locator, view, through_sql).await?;
                let row =
                    header(tx, session, locator, HistoryField::Body, view, through_sql).await?;
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
    let (before, after) =
        boundaries(tx, session, through_sql, include_thinking, left, right).await?;

    Ok(Page::Ready {
        through,
        chunks,
        before,
        after,
    })
}

async fn boundaries(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    through: i64,
    include_thinking: bool,
    left: Option<Cursor>,
    right: Option<(Cursor, u64)>,
) -> Result<(Option<Cursor>, Option<Cursor>), StoreError> {
    let before = match left {
        Some(cursor)
            if cursor.offset > 0
                || neighbor(tx, session, through, cursor, include_thinking, true).await? =>
        {
            Some(cursor)
        }
        _ => None,
    };
    let after = match right {
        Some((cursor, total))
            if cursor.offset < total
                || neighbor(tx, session, through, cursor, include_thinking, false).await? =>
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
async fn header(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    locator: RowPosition,
    field: HistoryField,
    view: HistoryView,
    through: i64,
) -> Result<Header, StoreError> {
    if view == HistoryView::Conversation
        && field == HistoryField::Body
        && let Some(row) = conversation_tool(tx, session, locator, through).await?
    {
        return Ok(row);
    }
    let row = sqlx::query(
        "SELECT source.message_id, source.turn_id, source.timestamp, source.role,
            CASE WHEN source.role = 'turn_state' AND source.state_status IS NOT 'failed' AND ?4 = 'body'
                THEN 0 ELSE length(cached.body) END,
            CASE WHEN source.role = 'user' THEN source.user_origin END
            FROM transcript_directory source LEFT JOIN temp.transcript_text cached
                ON cached.session_id = source.session_id AND cached.source_sequence = source.source_sequence
                AND cached.item_index = source.item_index AND cached.field = ?4
            WHERE source.session_id = ?1 AND source.source_sequence = ?2 AND source.item_index = ?3
                AND (cached.field IS NOT NULL OR
                    (source.role = 'turn_state' AND source.state_status IS NOT 'failed' AND ?4 = 'body'))"
    ).bind(session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).bind(field_name(field)).fetch_one(&mut *tx).await?;
    let mut header = Header {
        origin: row
            .try_get::<Option<String>, _>(5)?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        message: row.try_get(0)?,
        turn: row.try_get(1)?,
        timestamp: sequence_number(row.try_get(2)?)?,
        role: row.try_get(3)?,
        hidden: false,
        total: sequence_number(row.try_get(4)?)?,
    };
    if view == HistoryView::Conversation && field == HistoryField::Body && header.role == "user" {
        let query = format!(
            "SELECT length(CAST({CONVERSATION_USER} AS BLOB)) FROM temp.transcript_rows
            WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
        );
        header.total = sequence_number(
            sqlx::query_scalar(sqlx::AssertSqlSafe(query.as_str()))
                .bind(session)
                .bind(sql_position(locator)?.0)
                .bind(sql_position(locator)?.1)
                .fetch_one(tx)
                .await?,
        )?;
    }
    Ok(header)
}

async fn fragment(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    cursor: Cursor,
    bytes: u64,
    conversation_user: bool,
) -> Result<Vec<u8>, StoreError> {
    let query = if conversation_user {
        format!(
            "SELECT substr(CAST({CONVERSATION_USER} AS BLOB), ?4, ?5) FROM temp.transcript_rows
            WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
        )
    } else {
        "SELECT substr(body, ?4, ?5) FROM temp.transcript_text
            WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3 AND field = ?6"
            .into()
    };
    let mut query = sqlx::query_scalar(sqlx::AssertSqlSafe(query.as_str()))
        .bind(session)
        .bind(sql_position(cursor.position)?.0)
        .bind(sql_position(cursor.position)?.1)
        .bind(sql_number(cursor.offset)? + 1)
        .bind(sql_number(bytes)?);
    if !conversation_user {
        query = query.bind(field_name(cursor.field));
    }
    Ok(query.fetch_one(tx).await?)
}

async fn conversation_tool(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    locator: RowPosition,
    through: i64,
) -> Result<Option<Header>, StoreError> {
    let row = sqlx::query(
        "SELECT row.message_id, row.turn_id, row.timestamp,
            row.role, row.tool_origin,
            COALESCE(row.tool_name, call.tool_name),
            COALESCE(row.is_error, 0)
        FROM transcript_directory row LEFT JOIN transcript_directory call
            ON call.session_id = row.session_id AND call.turn_id = row.turn_id
            AND call.message_id = row.tool_use_id
            AND call.role = 'tool_call' AND call.source_sequence <= ?4
        WHERE row.session_id = ?1 AND row.source_sequence = ?2 AND row.item_index = ?3 AND row.source_sequence <= ?4
            AND row.role IN ('tool_call', 'tool_result')"
    ).bind(session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).bind(through).fetch_optional(tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let origin: Option<String> = row.try_get(4)?;
    let name: Option<String> = row.try_get(5)?;
    let error: bool = row.try_get(6)?;
    let internal = !error
        && (matches!(
            (origin.as_deref(), name.as_deref()),
            (Some("provider"), Some("wait" | "tool_search"))
                | (Some("code_mode"), Some("code_cell" | "tool_search"))
        ));
    Ok(Some(Header {
        origin: None,
        message: row.try_get(0)?,
        turn: row.try_get(1)?,
        timestamp: sequence_number(row.try_get(2)?)?,
        role: row.try_get(3)?,
        hidden: internal,
        total: 0,
    }))
}

async fn neighbor(
    tx: &mut SqliteWorkerConnection<'_>,
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
            let exists: bool = sqlx::query_scalar(
                "SELECT has_thinking FROM transcript_directory WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
            ).bind(session).bind(sql_position(cursor.position)?.0).bind(sql_position(cursor.position)?.1).fetch_one(&mut *tx).await?;
            if exists {
                return Ok(true);
            }
        }
    }
    // A predecessor of a validated cursor is already within its fence. Keep
    // the pair as the sole upper bound, as in reverse anchored pagination.
    let query = if before {
        "SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE session_id = ?1 AND (source_sequence,item_index) < (?2,?3))"
    } else {
        "SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE session_id = ?1 AND source_sequence <= ?2 AND (source_sequence,item_index) > (?3,?4))"
    };
    let mut query = sqlx::query_scalar(sqlx::AssertSqlSafe(query)).bind(session);
    if !before {
        query = query.bind(through);
    }
    Ok(query
        .bind(sql_position(cursor.position)?.0)
        .bind(sql_position(cursor.position)?.1)
        .fetch_one(tx)
        .await?)
}
async fn materialize(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    locator: RowPosition,
    view: HistoryView,
    through: i64,
) -> Result<usize, StoreError> {
    if view == HistoryView::Conversation
        && conversation_tool(tx, session, locator, through)
            .await?
            .is_some()
    {
        return Ok(0);
    }
    // Non-failed turn states have no text under BODY. Their immutable directory
    // identity is sufficient for cursor progress; replaying their producer only
    // to cache an empty body repeats the completed invocation's evidence.
    let empty_state: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM transcript_directory
            WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3
                AND role = 'turn_state' AND state_status IS NOT 'failed')",
    )
    .bind(session)
    .bind(sql_position(locator)?.0)
    .bind(sql_position(locator)?.1)
    .fetch_one(&mut *tx)
    .await?;
    if empty_state {
        return Ok(0);
    }
    super::bodycache::ensure_on_worker(tx, session, locator).await?;
    let source: Option<(i64, bool)> = sqlx::query_as(
        "SELECT total_bytes, EXISTS(SELECT 1 FROM temp.transcript_text cached WHERE cached.session_id = source.session_id AND cached.source_sequence = source.source_sequence AND cached.item_index = source.item_index AND cached.field = 'body')
            FROM temp.transcript_rows source WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3"
    ).bind(session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).fetch_optional(&mut *tx).await?;
    let Some((bytes, cached)) = source else {
        return Err(invalid("history row was not found"));
    };
    if cached {
        return Ok(0);
    }
    let query = format!(
        "INSERT INTO temp.transcript_text
            SELECT session_id, source_sequence, item_index, 'body', json_extract(payload, '$.ts'), json_extract(payload, '$.type'),
                CAST({BODY} AS BLOB)
            FROM temp.transcript_rows WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3
            UNION ALL
            SELECT session_id, source_sequence, item_index, 'thinking', json_extract(payload, '$.ts'), 'assistant',
                CAST(json_extract(payload, '$.thinking.text') AS BLOB)
            FROM temp.transcript_rows WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3
                AND json_extract(payload, '$.type') = 'assistant' AND json_type(payload, '$.thinking.text') = 'text'"
    );
    sqlx::query(sqlx::AssertSqlSafe(query.as_str()))
        .bind(session)
        .bind(sql_position(locator)?.0)
        .bind(sql_position(locator)?.1)
        .execute(tx)
        .await?;
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
    use serde_json::json;
    use sqlx::{Connection, SqliteConnection};
    async fn neighbor(
        tx: &mut SqliteConnection,
        session: &str,
        through: i64,
        cursor: Cursor,
        include_thinking: bool,
        before: bool,
    ) -> Result<bool, StoreError> {
        let session = session.to_owned();
        crate::connection::worker_query(tx, move |worker| {
            Box::pin(async move {
                super::neighbor(worker, &session, through, cursor, include_thinking, before).await
            })
        })
        .await
    }

    async fn conversation_tool(
        tx: &mut SqliteConnection,
        session: &str,
        locator: RowPosition,
        through: i64,
    ) -> Result<Option<Header>, StoreError> {
        let session = session.to_owned();
        crate::connection::worker_query(tx, move |worker| {
            Box::pin(
                async move { super::conversation_tool(worker, &session, locator, through).await },
            )
        })
        .await
    }

    #[tokio::test]
    async fn conversation_retains_trace_parents_and_hides_transport_helpers() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        crate::transcript::bodycache::initialize(&mut db)
            .await
            .unwrap();
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
            sqlx::query("INSERT INTO transcript_directory (session_id,source_sequence,item_index,message_id,turn_id,timestamp,role,has_thinking,tool_origin,tool_name,tool_use_id,is_error,context_eligible) SELECT 'a',?1,0,?2,'turn',1,json_extract(?3,'$.type'),0,json_extract(?3,'$.origin'),json_extract(?3,'$.toolName'),json_extract(?3,'$.toolUseId'),json_extract(?3,'$.isError'),json_extract(?3,'$.type') IN ('tool_call','tool_result')")
                .bind((i+1) as i64).bind((i+1).to_string()).bind(serde_json::to_vec(&value).unwrap())
                .execute(&mut db)
                .await
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
                &mut db,
                "a",
                RowPosition {
                    source_sequence: locator,
                    item_index: 0,
                },
                7,
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(!row.hidden, visible, "locator {locator}");
            assert_eq!(row.total, 0);
        }
        // A parent without a child at the requested fence remains visible.
        assert_eq!(
            conversation_tool(
                &mut db,
                "a",
                RowPosition {
                    source_sequence: 4,
                    item_index: 0
                },
                4
            )
            .await
            .unwrap()
            .unwrap()
            .role,
            "tool_call"
        );
    }

    #[tokio::test]
    async fn predecessor_seek_work_is_bounded_by_cursor_not_following_history() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        async fn probe(db: &mut SqliteConnection, through: i64) -> usize {
            let steps = Arc::new(AtomicUsize::new(0));
            let observed = steps.clone();
            db.lock_handle()
                .await
                .unwrap()
                .set_progress_handler(1, move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    true
                });
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
            )
            .await;
            db.lock_handle().await.unwrap().remove_progress_handler();
            assert!(!found.unwrap(), "the first row has no predecessor");
            steps.load(Ordering::Relaxed)
        }

        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        crate::transcript::bodycache::initialize(&mut db)
            .await
            .unwrap();
        let mut measurements = Vec::new();
        for (first, last) in [(1_i64, 64_i64), (65, 4096)] {
            // Use the production directory schema/indexes. Setup is outside the
            // handler; count only the real neighbor function, not a SQL copy.
            sqlx::query("WITH RECURSIVE n(value) AS (SELECT ?1 UNION ALL SELECT value+1 FROM n WHERE value<?2) INSERT INTO transcript_directory(session_id,source_sequence,item_index,turn_id,message_id,timestamp,role,has_thinking,context_eligible) SELECT 'a',value,0,'turn',CAST(value AS TEXT),1,'user',0,1 FROM n")
                .bind(first)
                .bind(last)
                .execute(&mut db)
                .await
                .unwrap();
            measurements.push(probe(&mut db, last).await);
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
        assert!(
            neighbor(&mut db, "a", 4096, first, false, false)
                .await
                .unwrap()
        );
        assert!(
            !neighbor(&mut db, "a", 1, first, false, false)
                .await
                .unwrap(),
            "a successor beyond the frozen fence must not appear"
        );
    }
}
