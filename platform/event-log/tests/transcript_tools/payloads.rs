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

use super::*;

async fn dispatch(log: &EventLog, step: &str) -> String {
    accepted(log, step, "Read").await;
    let operation = format!("{step}:reused-provider-id");
    log.append(&event(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: operation.clone(),
        call: ToolCallIdentity::provider(step.into(), "reused-provider-id".into()),
        name: "Read".into(),
        input: json!({}),
    }))
    .await
    .unwrap();
    operation
}

async fn open(log: &EventLog) {
    log.append(&event(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: Vec::new(),
            content: "read".into(),
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
}

#[tokio::test]
async fn ten_mib_raw_fragments_rebuild_after_restart_from_durable_facts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    open(&log).await;
    let operation = dispatch(&log, "read").await;
    let raw = json!({"kind":"text","text":"x".repeat(10 * 1024 * 1024)});
    let write = success(&operation, raw.clone());
    let through = log.append(&write).await.unwrap();
    let id = write.event().id.clone();
    drop(write);
    materialize_all(&log, through).await;
    assert!(log.prefix(100, 16 * 1024 * 1024).await.is_ok());
    let cache_id = id.clone();
    let original: Vec<u8> = crate::test_store::inspect(&log, move |db| {
        db.query_row(
            "SELECT payload FROM transcript_cache.rows WHERE message_id = ?",
            [&cache_id],
            |row| row.get(0),
        )
        .unwrap()
    })
    .await;
    let mut assembled = Vec::new();
    while assembled.len() < original.len() {
        let length = (original.len() - assembled.len()).min(512 * 1024);
        let fragment = log
            .transcript_fragment(
                "session",
                maka_agent_facts::history::RowPosition {
                    source_sequence: through,
                    item_index: 0,
                },
                assembled.len() as u64,
                length as u64,
            )
            .await
            .unwrap();
        assembled.extend(fragment);
    }
    assert_eq!(assembled, original);
    assert_eq!(
        serde_json::from_slice::<Value>(&assembled).unwrap()["content"]["value"],
        raw
    );
    crate::test_store::inspect(&log, move |db| {
        db.execute("DELETE FROM transcript_cache.rows", []).unwrap()
    })
    .await;
    crate::test_store::inspect(&log, move |db| {
        db.execute_batch("DELETE FROM transcript_cache.text; DELETE FROM transcript_cache.rows")
            .unwrap()
    })
    .await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.resolve_tool_result("session", &id)
            .await
            .unwrap()
            .to_json(),
        raw
    );
    materialize_all(&log, through).await;
    let rebuilt: Vec<u8> = crate::test_store::inspect(&log, move |db| {
        db.query_row(
            "SELECT payload FROM transcript_cache.rows WHERE message_id = ?",
            [&id],
            |row| row.get(0),
        )
        .unwrap()
    })
    .await;
    assert_eq!(rebuilt, original);
}

#[tokio::test]
async fn selected_boundary_does_not_hydrate_an_earlier_sibling_payload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    open(&log).await;
    let operation = dispatch(&log, "sibling").await;
    let sibling = success(&operation, json!({"text":"x".repeat(12 * 1024 * 1024)}));
    let previous = log.append(&sibling).await.unwrap();
    materialize_all(&log, previous).await;
    let db = Connection::open(&path).unwrap();
    db.execute(
        "DELETE FROM tool_result_payloads WHERE event_id = ?",
        [&sibling.event().id],
    )
    .unwrap();
    let operation = dispatch(&log, "target").await;
    let target = success(&operation, json!({"text":"target"}));
    let through = log.append(&target).await.unwrap();
    materialize_all(&log, through).await;
    assert!(
        log.resolve_tool_result("session", &sibling.event().id)
            .await
            .is_err()
    );
    let value: Vec<u8> = crate::test_store::inspect(&log, move |db| {
        db.query_row(
            "SELECT payload FROM transcript_cache.rows WHERE message_id = ?",
            [&target.event().id],
            |row| row.get(0),
        )
        .unwrap()
    })
    .await;
    assert_eq!(
        serde_json::from_slice::<Value>(&value).unwrap()["content"]["value"]["text"],
        "target"
    );
}

#[tokio::test]
async fn escaped_raw_and_complete_ui_row_survive_reopen_and_require_original_body() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    open(&log).await;
    let operation = dispatch(&log, "control").await;
    let raw = json!({"kind":"text","text":"\u{0000}".repeat(3 * 1024 * 1024)});
    let write = success(&operation, raw.clone());
    let through = log.append(&write).await.unwrap();
    materialize_all(&log, through).await;
    let cache_id = write.event().id.clone();
    let projected: Vec<u8> = crate::test_store::inspect(&log, move |db| {
        db.query_row(
            "SELECT payload FROM transcript_cache.rows WHERE message_id = ?",
            [&cache_id],
            |row| row.get(0),
        )
        .unwrap()
    })
    .await;
    let row: Value = serde_json::from_slice(&projected).unwrap();
    assert!(
        row["content"]["value"] == raw,
        "escaped raw must be projected completely"
    );
    crate::test_store::inspect(&log, move |db| {
        db.execute_batch("DELETE FROM transcript_cache.text; DELETE FROM transcript_cache.rows")
            .unwrap()
    })
    .await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert!(
        log.resolve_tool_result("session", &write.event().id)
            .await
            .unwrap()
            .to_json()
            == raw,
        "reopened raw result must retain its complete original value"
    );
    assert!(log.prefix(100, 32 * 1024 * 1024).await.is_ok());
    materialize_all(&log, through).await;
    let rebuilt: Vec<u8> = crate::test_store::inspect(&log, {
        let cache_id = write.event().id.clone();
        move |db| {
            db.query_row(
                "SELECT payload FROM transcript_cache.rows WHERE message_id = ?",
                [&cache_id],
                |row| row.get(0),
            )
            .unwrap()
        }
    })
    .await;
    assert!(
        rebuilt == projected,
        "reopened projection must retain exact escaped bytes"
    );
    // Remove the derived cache as well so the next read must hydrate original bytes.
    let db = Connection::open(&path).unwrap();
    db.execute(
        "DELETE FROM tool_result_payloads WHERE event_id = ?",
        [&write.event().id],
    )
    .unwrap();
    crate::test_store::inspect(&log, move |db| {
        db.execute_batch("DELETE FROM transcript_cache.text; DELETE FROM transcript_cache.rows")
            .unwrap()
    })
    .await;
    let error = crate::transcript_cache::materialize_all_rows(&log, "session", through)
        .await
        .expect_err(
            "missing original body must fail hydration despite formerly valid derived rows",
        );
    assert!(
        matches!(
            &error,
            maka_event_log::StoreError::InvalidTransition(message)
                if message == "missing or inconsistent durable tool payload"
        ),
        "unexpected hydration error: {error}"
    );
    assert!(
        log.resolve_tool_result("session", &write.event().id)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn multiple_large_results_keep_conversation_metadata_readable() {
    use maka_agent_ports::session::history::{HistoryView, Page, Position, Role};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large-history.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    open(&log).await;
    let mut ids = Vec::new();
    let mut through = 0;
    for index in 0..4 {
        let operation = dispatch(&log, &format!("read-{index}")).await;
        let result = success(&operation, json!({"text":"x".repeat(5 * 1024 * 1024)}));
        through = log.append(&result).await.unwrap();
        ids.push(result.event().id.clone());
    }
    assert_eq!(
        crate::test_store::inspect(&log, move |db| {
            db.query_row("SELECT count(*) FROM transcript_cache.rows", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
        })
        .await,
        0
    );

    let Page::Ready { chunks, .. } = log
        .history_view(
            "session",
            through,
            maka_event_log::transcript::HistoryWindow {
                position: Position::Start,
                include_thinking: false,
                view: HistoryView::Conversation,
                max_bytes: 128 * 1024,
                max_chunks: None,
                max_json_bytes: 1024 * 1024,
            },
        )
        .await
        .unwrap();
    let results: Vec<_> = chunks
        .iter()
        .filter(|chunk| chunk.role == Role::ToolResult)
        .collect();
    assert_eq!(results.len(), 4);
    assert_eq!(
        results
            .iter()
            .map(|chunk| chunk.message_id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert!(
        results
            .iter()
            .all(|chunk| chunk.tool.as_ref().unwrap().result.is_some() && chunk.text.is_empty())
    );
    assert_eq!(crate::test_store::inspect(&log, move |db| { db.query_row("SELECT count(*) FROM transcript_cache.rows body JOIN transcript_directory row USING(session_id,source_sequence,item_index) WHERE row.role IN ('tool_call','tool_result')",[],|row|row.get::<_,i64>(0)).unwrap() }).await,0,"conversation metadata must not hydrate large tool bodies");
    log.close().await.unwrap();
}
