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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use sqlx::{Connection, Row};

    fn position(source_sequence: u64) -> RowPosition {
        RowPosition {
            source_sequence,
            item_index: 0,
        }
    }

    async fn database() -> SqliteConnection {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        let schema = crate::schema::fixture(|_, name| {
            name.starts_with("transcript_directory")
                || name.starts_with("transcript_failures")
                || name.starts_with("directory_")
        });
        sqlx::raw_sql(sqlx::AssertSqlSafe(schema.as_str()))
            .execute(&mut db)
            .await
            .unwrap();
        db
    }
    fn call() -> Value {
        json!({"type":"tool_call","toolName":"Read","args":{"path":"example.rs"},"origin":"provider"})
    }
    fn result() -> Value {
        json!({"type":"tool_result","toolUseId":"call","origin":"provider","isError":false,"content":{"kind":"text","text":"body"}})
    }
    async fn insert(
        db: &mut SqliteConnection,
        session: &str,
        turn: &str,
        sequence: i64,
        id: &str,
        value: Value,
    ) {
        sqlx::query("INSERT INTO transcript_directory (source_sequence,item_index,session_id,turn_id,message_id,timestamp,role,has_thinking,tool_use_id,tool_name,tool_origin,parent_tool_call_id,parent_operation_id,has_args,result_valid,settlement,is_error,content_kind,tool_title,presentation,state_status)
            SELECT ?1,0,?2,?3,?4,0,json_extract(?5,'$.type'),0,
            CASE json_extract(?5,'$.type') WHEN 'tool_call' THEN ?4 ELSE json_extract(?5,'$.toolUseId') END,
            json_extract(?5,'$.toolName'),json_extract(?5,'$.origin'),json_extract(?5,'$.parentToolCallId'),json_extract(?5,'$.parentOperationId'),
            json_type(?5,'$.args') IS NOT NULL,json_type(?5,'$.isError') IN ('true','false') AND json_type(?5,'$.content')='object',
            json_extract(?5,'$.settlement'),json_extract(?5,'$.isError'),json_extract(?5,'$.content.kind'),json_extract(?5,'$.title'),json_extract(?5,'$.presentation'),json_extract(?5,'$.status')")
            .bind(sequence).bind(session).bind(turn).bind(id).bind(serde_json::to_vec(&value).unwrap()).execute(db).await.unwrap();
    }
    #[tokio::test]
    async fn trace_parent_is_an_earlier_native_call_in_the_same_turn() {
        for (origin, parent_session, parent_turn, parent_sequence, expected) in [
            ("code_mode", "a", "turn", 1, Some("parent")),
            ("host_sdk", "a", "turn", 1, Some("parent")),
            ("imported", "a", "turn", 1, None),
            ("provider", "a", "turn", 1, None),
            ("code_mode", "other", "turn", 1, None),
            ("code_mode", "a", "other", 1, None),
            ("code_mode", "a", "turn", 3, None),
        ] {
            let mut db = database().await;
            insert(
                &mut db,
                parent_session,
                parent_turn,
                parent_sequence,
                "parent",
                call(),
            )
            .await;
            let mut child = call();
            child["origin"] = json!(origin);
            child["parentToolCallId"] = json!("parent");
            child["parentOperationId"] = json!("parent-operation");
            insert(&mut db, "a", "turn", 2, "child", child).await;
            let metadata = read(&mut db, "a", position(2), 2).await.unwrap();
            assert_eq!(
                metadata.call.unwrap().ancestor_tool_use_ids,
                expected.into_iter().map(str::to_owned).collect::<Vec<_>>()
            );
        }
    }

    #[tokio::test]
    async fn trace_ancestors_retain_the_chain_through_internal_cells() {
        let mut db = database().await;
        insert(&mut db, "a", "turn", 1, "exec", call()).await;
        for sequence in 2..=34 {
            let id = format!("cell-{sequence}");
            let parent = if sequence == 2 {
                "exec".into()
            } else {
                format!("cell-{}", sequence - 1)
            };
            let mut child = call();
            child["origin"] = json!(if sequence % 2 == 0 {
                "code_mode"
            } else {
                "host_sdk"
            });
            child["parentToolCallId"] = json!(parent);
            child["parentOperationId"] = json!(format!("operation-{parent}"));
            insert(&mut db, "a", "turn", sequence, &id, child).await;
        }
        let metadata = read(&mut db, "a", position(34), 34).await.unwrap();
        let expected = (2..34)
            .rev()
            .map(|sequence| format!("cell-{sequence}"))
            .chain(std::iter::once("exec".into()))
            .collect::<Vec<_>>();
        assert_eq!(metadata.call.unwrap().ancestor_tool_use_ids, expected);
    }

    #[tokio::test]
    async fn paired_references_are_unique_ordered_scoped_and_fenced() {
        let mut db = database().await;
        insert(&mut db, "a", "turn", 1, "call", call()).await;
        insert(&mut db, "a", "turn", 2, "result", result()).await;
        insert(&mut db, "other", "turn", 1, "call", call()).await;
        insert(&mut db, "other", "turn", 2, "result", result()).await;
        let before = read(&mut db, "a", position(1), 1).await.unwrap();
        assert!(before.call.is_some() && before.result.is_none());
        let paired = read(&mut db, "a", position(1), 2).await.unwrap();
        assert_eq!(paired.call.as_ref().unwrap().position, position(1));
        assert_eq!(paired.result.as_ref().unwrap().position, position(2));
        assert_eq!(paired, read(&mut db, "a", position(2), 2).await.unwrap());
        insert(&mut db, "a", "foreign-turn", 3, "foreign-result", result()).await;
        assert!(
            read(&mut db, "a", position(3), 3)
                .await
                .unwrap()
                .call
                .is_none()
        );
        assert_eq!(paired, read(&mut db, "a", position(1), 3).await.unwrap());
        insert(&mut db, "a", "turn", 4, "duplicate", result()).await;
        assert_eq!(paired, read(&mut db, "a", position(1), 3).await.unwrap());
        assert!(
            read(&mut db, "a", position(1), 4)
                .await
                .unwrap()
                .result
                .is_none()
        );
        for sequence in [2, 4] {
            let orphan = read(&mut db, "a", position(sequence), 4).await.unwrap();
            assert!(orphan.call.is_none());
            assert_eq!(orphan.result.unwrap().position, position(sequence));
        }
        assert_eq!(paired, read(&mut db, "a", position(1), 2).await.unwrap());
        let plan = format!("EXPLAIN QUERY PLAN {METADATA_SQL}");
        let rows = sqlx::query(sqlx::AssertSqlSafe(plan.as_str()))
            .bind("a")
            .bind(1i64)
            .bind(0i64)
            .bind(4i64)
            .fetch_all(&mut db)
            .await
            .unwrap();
        let plan = rows
            .iter()
            .map(|row| row.get::<String, _>(3))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(plan.contains("USING INDEX directory_results"), "{plan}");
    }
    #[tokio::test]
    async fn same_fact_ordinals_pair_beyond_the_old_slot_boundary() {
        let mut db = database().await;
        insert(&mut db, "a", "turn", 1, "call", call()).await;
        insert(
            &mut db,
            "a",
            "turn",
            2,
            "activity",
            json!({"type":"tool_activity","toolUseId":"call","toolName":"Read"}),
        )
        .await;
        insert(&mut db, "a", "turn", 3, "result", result()).await;
        sqlx::query(
            "UPDATE transcript_directory SET item_index = source_sequence + 254, source_sequence = 9",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let call_position = RowPosition {
            source_sequence: 9,
            item_index: 255,
        };
        let result_position = RowPosition {
            source_sequence: 9,
            item_index: 257,
        };
        let paired = read(&mut db, "a", call_position, 9).await.unwrap();
        assert_eq!(paired.call.as_ref().unwrap().position, call_position);
        assert!(paired.call.as_ref().unwrap().dispatched);
        assert_eq!(paired.result.as_ref().unwrap().position, result_position);
        assert_eq!(
            paired,
            read(&mut db, "a", result_position, 9).await.unwrap()
        );
    }

    #[tokio::test]
    async fn mismatched_parentage_origin_future_schema_and_reversed_rows_remain_unpaired() {
        for case in 0..7 {
            let mut db = database().await;
            let mut call = call();
            let mut result = result();
            match case {
                0 => result["origin"] = json!("code_mode"),
                1 => result["parentToolCallId"] = json!("different"),
                2 => result["parentOperationId"] = json!("different"),
                3 => {
                    call["origin"] = json!("future");
                    result["origin"] = json!("future");
                }
                4 => result["isError"] = json!("false"),
                5 => result["content"] = json!("malformed"),
                _ => (),
            }
            let (call_sequence, result_sequence) = if case == 6 { (2, 1) } else { (1, 2) };
            insert(&mut db, "a", "turn", call_sequence, "call", call).await;
            insert(&mut db, "a", "turn", result_sequence, "result", result).await;
            let call = read(&mut db, "a", position(call_sequence as u64), 2)
                .await
                .unwrap();
            let result = read(&mut db, "a", position(result_sequence as u64), 2)
                .await
                .unwrap();
            assert!(call.result.is_none(), "case {case}");
            assert!(result.call.is_none(), "case {case}");
            assert_eq!(call.call.unwrap().position, position(call_sequence as u64));
            assert_eq!(
                result.result.unwrap().position,
                position(result_sequence as u64)
            );
        }
    }
    #[tokio::test]
    async fn unpaired_result_does_not_evaluate_the_call_activity_title() {
        let mut db = database().await;
        insert(&mut db, "a", "turn", 1, "call", call()).await;
        insert(
            &mut db,
            "a",
            "turn",
            2,
            "activity",
            json!({"type":"tool_activity","toolUseId":"call","toolName":"Read","title":"not JSON"}),
        )
        .await;
        let mut outcome = result();
        outcome["origin"] = json!("future");
        insert(&mut db, "a", "turn", 3, "result", outcome).await;
        let metadata = read(&mut db, "a", position(3), 3).await.unwrap();
        assert!(metadata.call.is_none());
        assert_eq!(metadata.result.unwrap().position, position(3));
    }
    #[tokio::test]
    async fn activity_titles_and_open_turns_are_scoped_bounded_and_fenced() {
        let mut db = database().await;
        insert(
            &mut db,
            "a",
            "turn",
            1,
            "start",
            json!({"type":"turn_state","status":"running"}),
        )
        .await;
        insert(&mut db, "a", "turn", 2, "call", call()).await;
        let title = json!({"fallback":"Inspect file", "translations":{"zh-CN":"查看文件"}});
        let activity = json!({"type":"tool_activity","toolUseId":"call","toolName":"Read","title":title,"presentation":"maka.workspace.Files@1/readText"});
        insert(&mut db, "a", "turn", 3, "activity", activity.clone()).await;
        insert(&mut db, "a", "turn", 4, "result", result()).await;
        insert(
            &mut db,
            "a",
            "turn",
            5,
            "end",
            json!({"type":"turn_state","status":"completed"}),
        )
        .await;
        insert(
            &mut db,
            "a",
            "other-turn",
            6,
            "other-end",
            json!({"type":"turn_state","status":"running"}),
        )
        .await;
        insert(
            &mut db,
            "other",
            "turn",
            6,
            "other-end",
            json!({"type":"turn_state","status":"running"}),
        )
        .await;
        let before = read(&mut db, "a", position(2), 2).await.unwrap();
        assert!(before.call.as_ref().unwrap().pending);
        assert!(!before.call.as_ref().unwrap().dispatched);
        assert!(before.call.as_ref().unwrap().presentation.is_none());
        assert!(before.call.unwrap().title.is_none());
        let open = read(&mut db, "a", position(2), 3).await.unwrap();
        assert!(open.call.as_ref().unwrap().pending && open.result.is_none());
        assert!(open.call.as_ref().unwrap().dispatched);
        assert_eq!(
            open.call.as_ref().unwrap().presentation.as_deref(),
            Some("maka.workspace.Files@1/readText")
        );
        assert_eq!(
            open.call
                .as_ref()
                .unwrap()
                .title
                .as_ref()
                .unwrap()
                .resolve("zh-CN"),
            "查看文件"
        );
        assert_eq!(open, read(&mut db, "a", position(2), 3).await.unwrap());
        let closed = read(&mut db, "a", position(2), 6).await.unwrap();
        assert!(!closed.call.as_ref().unwrap().pending);
        assert_eq!(closed, read(&mut db, "a", position(4), 6).await.unwrap());
        insert(&mut db, "a", "turn", 7, "duplicate", activity).await;
        assert!(
            !read(&mut db, "a", position(2), 7)
                .await
                .unwrap()
                .call
                .unwrap()
                .dispatched
        );

        assert!(
            read(&mut db, "a", position(2), 7)
                .await
                .unwrap()
                .call
                .unwrap()
                .presentation
                .is_none()
        );
        assert!(
            read(&mut db, "a", position(2), 7)
                .await
                .unwrap()
                .call
                .unwrap()
                .title
                .is_none()
        );
        assert_eq!(closed, read(&mut db, "a", position(2), 6).await.unwrap());
        let query = format!("EXPLAIN QUERY PLAN {METADATA_SQL}");
        let plan = sqlx::query(sqlx::AssertSqlSafe(query.as_str()))
            .bind("a")
            .bind(2i64)
            .bind(0i64)
            .bind(7i64)
            .fetch_all(&mut db)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>(3))
            .collect::<Vec<_>>()
            .join("\n");
        for (index, keys) in [
            (
                "directory_activity",
                "session_id=? AND turn_id=? AND tool_use_id=? AND source_sequence<?",
            ),
            (
                "directory_state",
                "session_id=? AND turn_id=? AND source_sequence<?",
            ),
            (
                "directory_results",
                "session_id=? AND turn_id=? AND tool_use_id=? AND source_sequence<?",
            ),
        ] {
            assert!(
                plan.contains(&format!("USING INDEX {index} ({keys})")),
                "{plan}"
            );
        }
        let unique_call_key =
            "USING INDEX sqlite_autoindex_transcript_directory_2 (session_id=? AND message_id=?)";
        assert!(
            plan.contains(&format!("SEARCH row {unique_call_key}")),
            "{plan}"
        );
        let parents = plan
            .lines()
            .filter(|line| line.starts_with("SEARCH parent "))
            .collect::<Vec<_>>();
        assert!(
            !parents.is_empty() && parents.iter().all(|line| line.contains(unique_call_key)),
            "{plan}"
        );
    }

    #[tokio::test]
    async fn imported_missing_and_mismatched_activity_do_not_claim_active_execution() {
        for case in 0..7 {
            let mut db = database().await;
            let mut call = call();
            if case == 0 {
                call["origin"] = json!("imported");
            }
            let mut title = json!({"fallback":"Inspect", "translations":{}});
            if case == 5 {
                title["fallback"] = json!("bad\ntext");
            }
            if case == 6 {
                title["fallback"] = json!("x".repeat(257));
            }
            let activity = json!({"type":"tool_activity", "toolUseId":"call", "toolName": if case == 4 {"Other"} else {"Read"}, "title":title});
            if case == 0 {
                insert(
                    &mut db,
                    "a",
                    "turn",
                    1,
                    "start",
                    json!({"type":"turn_state","status":"running"}),
                )
                .await;
            }
            insert(&mut db, "a", "turn", 3, "call", call).await;
            insert(
                &mut db,
                if case == 1 { "other" } else { "a" },
                if case == 2 { "other" } else { "turn" },
                if case == 3 { 2 } else { 4 },
                "activity",
                activity,
            )
            .await;
            let tool = read(&mut db, "a", position(3), 4).await.unwrap();
            let call = tool.call.unwrap();
            assert!(!call.pending, "case {case}");
            if case == 6 {
                assert_eq!(call.title.as_ref().unwrap().fallback, "x".repeat(257));
            } else if case != 0 {
                assert!(call.title.is_none(), "case {case}");
            }
            assert!(tool.result.is_none());
        }
    }
}
