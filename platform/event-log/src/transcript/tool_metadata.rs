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

use super::read::sql_position;
use crate::StoreError;
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::Tool;
use sqlx::SqliteConnection;
use sqlx::sqlite::SqliteWorkerConnection;

// Materialize the one-row owner and keep it before each indexed lookup.
// Reordering these joins can scan the Session's payloads or entire tool indexes.
const METADATA_SQL: &str = "WITH RECURSIVE owner AS MATERIALIZED (
            SELECT session_id, turn_id, source_sequence, item_index, message_id,
                role AS kind,
                CASE role WHEN 'tool_call' THEN message_id
                    ELSE tool_use_id END AS tool_id,
                tool_name AS name,
                settlement AS settlement,
                is_error AS error,
                content_kind IS 'image' AS image
            FROM transcript_directory WHERE session_id = ?1 AND source_sequence = ?2 AND item_index = ?3 AND source_sequence <= ?4
        ), call_row AS (
            SELECT row.source_sequence, row.item_index, row.tool_name AS name,
                row.tool_origin AS origin,
                row.parent_tool_call_id AS parent_call,
                row.parent_operation_id AS parent_operation
            FROM owner CROSS JOIN transcript_directory row ON row.session_id = owner.session_id
                AND row.message_id = owner.tool_id AND row.turn_id = owner.turn_id
            WHERE row.source_sequence <= ?4 AND row.role = 'tool_call'
                AND row.has_args = 1
        ), ancestors(message_id, source_sequence, item_index, parent_id, depth) AS (
            SELECT parent.message_id, parent.source_sequence, parent.item_index,
                CASE WHEN parent.tool_origin IN ('host_sdk', 'code_mode')
                    THEN parent.parent_tool_call_id END, 1
            FROM owner CROSS JOIN call_row CROSS JOIN transcript_directory parent
                ON parent.session_id = owner.session_id AND parent.turn_id = owner.turn_id
                AND parent.message_id = call_row.parent_call
            WHERE (parent.source_sequence, parent.item_index) < (call_row.source_sequence, call_row.item_index) AND parent.role = 'tool_call'
                AND call_row.origin IN ('host_sdk', 'code_mode')
            UNION ALL
            SELECT parent.message_id, parent.source_sequence, parent.item_index,
                CASE WHEN parent.tool_origin IN ('host_sdk', 'code_mode')
                    THEN parent.parent_tool_call_id END, ancestors.depth + 1
            FROM ancestors CROSS JOIN owner CROSS JOIN transcript_directory parent
                ON parent.session_id = owner.session_id AND parent.turn_id = owner.turn_id
                AND parent.message_id = ancestors.parent_id
            WHERE (parent.source_sequence, parent.item_index) < (ancestors.source_sequence, ancestors.item_index) AND parent.role = 'tool_call'
        ), activity AS MATERIALIZED (
            SELECT row.source_sequence, row.item_index, row.tool_name AS name,
                row.tool_title AS title,
                row.presentation AS presentation
            FROM owner CROSS JOIN transcript_directory row ON row.session_id = owner.session_id
                AND row.turn_id = owner.turn_id AND row.tool_use_id = owner.tool_id
            WHERE row.source_sequence <= ?4 AND row.role = 'tool_activity'
            ORDER BY row.source_sequence, row.item_index LIMIT 2
        ), call AS (
            SELECT call_row.*, json_object('position', json_object('sourceSequence', call_row.source_sequence, 'itemIndex', call_row.item_index), 'name', call_row.name,
                'ancestorToolUseIds', json((SELECT json_group_array(message_id) FROM (SELECT message_id FROM ancestors ORDER BY depth))),
                'dispatched', json(CASE WHEN (SELECT count(*) FROM activity) = 1
                    AND EXISTS(SELECT 1 FROM activity WHERE (activity.source_sequence, activity.item_index) > (call_row.source_sequence, call_row.item_index) AND activity.name = call_row.name)
                    THEN 'true' ELSE 'false' END),
                'presentation', (SELECT presentation FROM activity WHERE (SELECT count(*) FROM activity) = 1
                    AND (activity.source_sequence, activity.item_index) > (call_row.source_sequence, call_row.item_index) AND activity.name = call_row.name),
                'title', json((SELECT title FROM activity WHERE (SELECT count(*) FROM activity) = 1
                    AND (activity.source_sequence, activity.item_index) > (call_row.source_sequence, call_row.item_index) AND activity.name = call_row.name)),
                'pending', json(CASE WHEN call_row.origin IN ('provider', 'host_sdk', 'code_mode')
                    AND (SELECT row.state_status FROM owner CROSS JOIN transcript_directory row
                        ON row.session_id = owner.session_id AND row.turn_id = owner.turn_id
                        WHERE row.source_sequence <= ?4 AND row.role = 'turn_state'
                        ORDER BY row.source_sequence DESC, row.item_index DESC LIMIT 1) = 'running'
                    THEN 'true' ELSE 'false' END)) AS reference FROM call_row
        ), results AS MATERIALIZED (
            SELECT row.source_sequence, row.item_index, row.tool_origin AS origin,
                row.parent_tool_call_id AS parent_call,
                row.parent_operation_id AS parent_operation,
                row.result_valid AS valid,
                row.settlement AS settlement,
                row.is_error AS error,
                row.content_kind IS 'image' AS image
            FROM owner CROSS JOIN transcript_directory row ON row.session_id = owner.session_id
                AND row.turn_id = owner.turn_id AND row.tool_use_id = owner.tool_id
            WHERE row.source_sequence <= ?4 AND row.role = 'tool_result'
            ORDER BY row.source_sequence, row.item_index LIMIT 2
        ), pair AS (
            SELECT call.reference AS call_ref,
                json_object('position', json_object('sourceSequence', results.source_sequence, 'itemIndex', results.item_index), 'settlement', results.settlement,
                    'isError', json(CASE results.error WHEN 1 THEN 'true' ELSE 'false' END),
                    'image', json(CASE results.image WHEN 1 THEN 'true' ELSE 'false' END)) AS result_ref
            FROM call, results WHERE (SELECT count(*) FROM results) = 1
                AND results.valid
                AND (call.source_sequence, call.item_index) < (results.source_sequence, results.item_index)
                AND call.origin IN ('imported', 'provider', 'host_sdk', 'code_mode')
                AND call.origin = results.origin
                AND call.parent_call IS results.parent_call
                AND call.parent_operation IS results.parent_operation
        ), metadata AS (
            SELECT json_object('toolUseId', tool_id,
                'call', json(CASE kind WHEN 'tool_call' THEN COALESCE((SELECT reference FROM call),
                    json_object('position', json_object('sourceSequence', source_sequence, 'itemIndex', item_index), 'name', name, 'ancestorToolUseIds', json_array(), 'title', NULL, 'presentation', NULL, 'pending', json('false'), 'dispatched', json('false')))
                    ELSE (SELECT call_ref FROM pair) END),
                'result', json(CASE kind WHEN 'tool_result' THEN json_object('position', json_object('sourceSequence', source_sequence, 'itemIndex', item_index), 'settlement', settlement,
                    'isError', json(CASE error WHEN 1 THEN 'true' ELSE 'false' END),
                    'image', json(CASE image WHEN 1 THEN 'true' ELSE 'false' END))
                    ELSE (SELECT result_ref FROM pair) END)) AS value FROM owner
        ) SELECT value FROM metadata";

/// Read scalar metadata only. The unique call key and the bounded result index
/// lookup avoid loading payloads or scanning an entire Turn for each fragment.
/// Pairing is evaluated at the supplied fence, never against future outcomes.
pub(super) async fn read(
    tx: &mut SqliteConnection,
    session: &str,
    position: RowPosition,
    through: i64,
) -> Result<Tool, StoreError> {
    let session = session.to_owned();
    crate::connection::worker_query(tx, move |worker| {
        Box::pin(async move { read_on_worker(worker, &session, position, through).await })
    })
    .await
}

pub(super) async fn read_on_worker(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    position: RowPosition,
    through: i64,
) -> Result<Tool, StoreError> {
    let (source_sequence, item_index) = sql_position(position)?;
    let encoded: String = sqlx::query_scalar(METADATA_SQL)
        .bind(session)
        .bind(source_sequence)
        .bind(item_index)
        .bind(through)
        .fetch_one(tx)
        .await?;
    let mut tool: Tool = serde_json::from_str(&encoded)?;
    if let Some(call) = &mut tool.call
        && call
            .title
            .as_ref()
            .is_some_and(|title| title.validate().is_err())
    {
        call.title = None;
    }
    if let Some(call) = &mut tool.call
        && call
            .presentation
            .as_ref()
            .is_some_and(|key| maka_agent_facts::display::validate_presentation(key).is_err())
    {
        call.presentation = None;
    }
    Ok(tool)
}
