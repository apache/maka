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
use maka_agent_facts::{
    history::semantic::{Frontier, RecordedKind, SemanticRow, directory::TextSpan},
    model::prompt_source::source::ToolResultKind,
};
use serde_json::json;
use sqlx::Connection;

fn text(json: &str, span: TextSpan) -> String {
    serde_json::from_str(
        &json[span.range.start as usize..(span.range.start + span.range.len) as usize],
    )
    .unwrap()
}

#[tokio::test]
async fn old_tool_rows_and_copies_remain_readable_after_steering_upgrade_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(directory.path().join("version14.sqlite"))
        .create_if_missing(true)
        .foreign_keys(true);
    let mut db = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    sqlx::query("PRAGMA application_id=1296124754")
        .execute(&mut db)
        .await
        .unwrap();
    crate::sqlite_functions::register(&mut db).await.unwrap();
    crate::sqlite_functions::register_migrations(&mut db)
        .await
        .unwrap();
    let all = sqlx::migrate!("./migrations");
    let previous = sqlx::migrate::Migrator {
        migrations: all
            .iter()
            .filter(|migration| migration.version <= 14)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    previous.run_direct(None, &mut db, false).await.unwrap();
    crate::sqlite_functions::unregister_migrations(&mut db)
        .await
        .unwrap();
    let invocation =
        json!({"session_id":"source","turn_id":"turn","run_id":"run","invocation_id":"invocation"});
    for (sequence, variant, kind) in [
        (1, "ToolResult", "tool_result"),
        (2, "UnknownTool", "unknown_tool"),
    ] {
        let mut fields =
            json!({"operation_id":"step:call","call_id":"call雪","name":"Counter","custom":false});
        if variant == "ToolResult" {
            fields["payload"] = json!({"sourceSequence":1,"itemIndex":0});
            fields["is_error"] = json!(false);
            fields["archived"] = json!(false);
        }
        let mut row = json!({"id":{"sourceSequence":sequence,"itemIndex":0},"revision":sequence,
            "invocation":invocation,"order":{"sourceSequence":sequence,"itemIndex":0},"kind":{(variant):fields}});
        let old_json = serde_json::to_string(&row).unwrap();
        row["kind"][variant]["kind"] = json!("output");
        let mut descriptor = super::super::directory::row(&row.to_string()).unwrap();
        match &mut descriptor {
            RowDirectory::ToolResult { call_id, name, .. }
            | RowDirectory::UnknownTool { call_id, name, .. } => {
                call_id.range.start = old_json.find("\"call雪\"").unwrap() as u64;
                name.range.start = old_json.find("\"Counter\"").unwrap() as u64;
            }
            _ => unreachable!(),
        }
        let mut old_descriptor = codec::encode(&descriptor).unwrap();
        // Both old postcard variants ended before the newly appended kind.
        assert_eq!(old_descriptor.pop(), Some(0));
        for owner in ["source", "copy"] {
            sqlx::query("INSERT INTO context_semantic_rows(owner_session_id,source_sequence,source_index,revision,order_sequence,order_index,invocation_id,revision_invocation,event_id,kind,archived,inherited,visible,unknown_only,row_json,directory_bytes) VALUES(?,?,0,?,?,0,'invocation','invocation','event',?,0,?,1,?,?,?)")
                .bind(owner).bind(sequence).bind(sequence).bind(sequence).bind(kind).bind(owner == "copy").bind(variant == "UnknownTool").bind(&old_json).bind(&old_descriptor).execute(&mut db).await.unwrap();
        }
    }
    let call = json!({"call_id":"call","name":"Counter","custom":false,"dispatched_at":1});
    let frontier = json!({"opening":"Conversation","calls":{"step:call":call},"cells":{},"notifications":[],
    "stable_cut":{"sourceSequence":1,"itemIndex":0},"requests":{"step":{"sequence":1,"source":0,
    "model_id":"model","route_identity":"route","main":true,"item_acceptance":true,"recorded":{
        "0":{"event_id":"event","key":{"sourceSequence":1,"itemIndex":0},"kind":{"Call":call}},
        "1":{"event_id":"event","key":{"sourceSequence":1,"itemIndex":1},"kind":{"Call":null}}
    }}}});
    sqlx::query("INSERT INTO context_semantic_frontiers VALUES('invocation','source',2,?)")
        .bind(frontier.to_string())
        .execute(&mut db)
        .await
        .unwrap();
    crate::schema::initialize_connection(&mut db).await.unwrap();
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as("SELECT row_json,directory_bytes FROM context_semantic_rows ORDER BY owner_session_id,source_sequence").fetch_all(&mut db).await.unwrap();
    assert_eq!(rows.len(), 4);
    for (json, bytes) in &rows {
        let _: SemanticRow = serde_json::from_str(json).unwrap();
        let (call_id, name, kind) = match codec::decode::<RowDirectory>(bytes).unwrap() {
            RowDirectory::ToolResult {
                call_id,
                name,
                kind,
                ..
            }
            | RowDirectory::UnknownTool {
                call_id,
                name,
                kind,
                ..
            } => (call_id, name, kind),
            other => panic!("unexpected migrated directory: {other:?}"),
        };
        assert_eq!(kind, ToolResultKind::Output);
        assert_eq!(text(json, call_id), "call雪");
        assert_eq!(text(json, name), "Counter");
    }
    let encoded: String =
        sqlx::query_scalar("SELECT frontier_json FROM context_semantic_frontiers")
            .fetch_one(&mut db)
            .await
            .unwrap();
    let decoded: Frontier = serde_json::from_str(&encoded).unwrap();
    assert!(!decoded.calls["step:call"].yielded);
    assert!(
        matches!(&decoded.requests["step"].recorded[&0].kind, RecordedKind::Call(Some(call)) if !call.yielded)
    );
    assert!(matches!(
        decoded.requests["step"].recorded[&1].kind,
        RecordedKind::Call(None)
    ));
    let functions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_function_list WHERE name LIKE 'maka_steering_%'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(functions, 0);
    db.close().await.unwrap();
    let mut reopened = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    crate::schema::initialize_connection(&mut reopened)
        .await
        .unwrap();
    let repeated: Vec<(String, Vec<u8>)> = sqlx::query_as("SELECT row_json,directory_bytes FROM context_semantic_rows ORDER BY owner_session_id,source_sequence").fetch_all(&mut reopened).await.unwrap();
    assert_eq!(repeated, rows);
    let repeated: String =
        sqlx::query_scalar("SELECT frontier_json FROM context_semantic_frontiers")
            .fetch_one(&mut reopened)
            .await
            .unwrap();
    assert_eq!(repeated, encoded);
    reopened.close().await.unwrap();
}

#[test]
fn pre_binary_tool_directories_upgrade_at_the_original_migration_boundary() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    register(&db).unwrap();
    let row = json!({"UnknownTool":{"call_id":{"range":{"start":5,"len":6},"measure":{"bytes":4,"sha256":vec![0;32]}},"name":{"range":{"start":20,"len":7},"measure":{"bytes":5,"sha256":vec![1;32]}},"custom":false}});
    let encoded: Vec<u8> = db
        .query_row("SELECT maka_directory_row(?)", [row.to_string()], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(matches!(
        codec::decode::<RowDirectory>(&encoded).unwrap(),
        RowDirectory::UnknownTool {
            kind: ToolResultKind::Output,
            ..
        }
    ));
    unregister(&db).unwrap();
}
