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
use serde_json::{Value, json};
use sqlx::Connection;

// Exercise the production migration and safety reader against minimal ledger
// storage. The bodies contain exactly the fields those queries consume; ingress
// validation itself is covered by the canonical append/import tests.
const LEDGER: &str = "CREATE TABLE event_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    invocation_id TEXT,
    kind TEXT NOT NULL,
    operation_id TEXT,
    event_json TEXT,
    event_session TEXT GENERATED ALWAYS AS (json_extract(event_json,'$.invocation.session_id')) STORED
);
CREATE VIEW runtime_events AS SELECT * FROM event_log WHERE invocation_id IS NOT NULL AND event_json IS NOT NULL;
CREATE INDEX invocation_sequence ON event_log(invocation_id, sequence);
CREATE UNIQUE INDEX operation_fact ON event_log(operation_id,kind) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX invocation_boundary ON event_log(invocation_id,kind) WHERE kind='invocation_opened' OR kind='invocation_ended';
CREATE INDEX model_observed_step ON event_log(invocation_id, CAST(json_extract(event_json,'$.fact.step_id') AS TEXT), sequence)
    WHERE kind='model_observed';";
const MIGRATION: &str = include_str!("../../../migrations/0042_context_obligations.sql");
const EXECUTION_MIGRATION: &str = include_str!("../../../migrations/0053_execution_intervals.sql");

async fn database() -> SqliteConnection {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut db).await.unwrap();
    sqlx::raw_sql(MIGRATION).execute(&mut db).await.unwrap();
    sqlx::raw_sql(EXECUTION_MIGRATION)
        .execute(&mut db)
        .await
        .unwrap();
    db
}

#[path = "execution.rs"]
mod execution;

async fn append(db: &mut SqliteConnection, kind: &str, op: Option<&str>, fact: Value) -> u64 {
    let count: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0)+1 FROM event_log")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    let body = json!({"invocation":{"session_id":"session"},"fact":fact});
    sqlx::query("INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json) VALUES(?,'invocation',?,?,?)")
        .bind(format!("event-{count}")).bind(kind).bind(op).bind(body.to_string())
        .execute(db).await.unwrap().last_insert_rowid() as u64
}

async fn ended(db: &mut SqliteConnection, class: &str) -> u64 {
    append(
        db,
        "invocation_ended",
        None,
        json!({"outcome":{"class":class}}),
    )
    .await
}

#[tokio::test]
async fn unknown_end_keeps_tool_obligation_and_late_settlement_does_not_fix_old_cut() {
    let mut db = database().await;
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(&mut db, "tool_dispatched", Some("cell"), json!({})).await;
    let unknown_cut = ended(&mut db, "outcome_unknown").await;
    assert!(matches!(
        require_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    assert!(
        require_manual_message_safe(&mut db, "session", None)
            .await
            .unwrap()
    );
    append(
        &mut db,
        "tool_settled",
        Some("cell"),
        json!({"outcome":{"kind":"succeeded"}}),
    )
    .await;
    require_safe(&mut db, "session", None).await.unwrap();
    assert!(
        !require_manual_message_safe(&mut db, "session", None)
            .await
            .unwrap()
    );
    assert!(matches!(
        require_safe_through(&mut db, "session", None, unknown_cut).await,
        Err(StoreError::HistoryUnsettled)
    ));
    require_safe_through_policy(&mut db, "session", None, unknown_cut, true)
        .await
        .unwrap();
}

#[tokio::test]
async fn ordinary_end_does_not_make_live_tool_or_model_work_safe() {
    let mut db = database().await;
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(&mut db, "tool_dispatched", Some("tool"), json!({})).await;
    append(
        &mut db,
        "model_requested",
        Some("step"),
        json!({"step_id":"step"}),
    )
    .await;
    ended(&mut db, "failed").await;
    assert!(matches!(
        require_manual_message_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    append(
        &mut db,
        "tool_settled",
        Some("tool"),
        json!({"outcome":{"kind":"failed"}}),
    )
    .await;
    assert!(matches!(
        require_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    append(
        &mut db,
        "model_interrupted",
        Some("step"),
        json!({"step_id":"step"}),
    )
    .await;
    require_safe(&mut db, "session", None).await.unwrap();
}

#[tokio::test]
async fn accepted_call_dispatch_and_completion_do_not_duplicate_obligations() {
    let mut db = database().await;
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(
        &mut db,
        "model_requested",
        Some("step"),
        json!({"step_id":"step","item_acceptance":true}),
    )
    .await;
    let call = json!({"id":"call","name":"tool","provider_executed":false});
    append(
        &mut db,
        "model_observed",
        None,
        json!({"step_id":"step","event":{"kind":"tool_call","data":call}}),
    )
    .await;
    append(&mut db, "tool_dispatched", Some("step:call"), json!({})).await;
    append(
        &mut db,
        "tool_settled",
        Some("step:call"),
        json!({"outcome":{"kind":"succeeded"}}),
    )
    .await;
    append(
        &mut db,
        "model_completed",
        Some("step"),
        json!({"step_id":"step","output":{"parts":[{"kind":"tool_call","call":call}]}}),
    )
    .await;
    ended(&mut db, "succeeded").await;
    require_safe(&mut db, "session", None).await.unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_obligations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn interrupted_provider_effect_requires_matching_result_before_interrupt() {
    for result in [None, Some("wrong"), Some("provider")] {
        let mut db = database().await;
        append(&mut db, "invocation_opened", None, json!({})).await;
        append(
            &mut db,
            "model_requested",
            Some("step"),
            json!({"step_id":"step"}),
        )
        .await;
        append(&mut db,"model_observed",None,json!({"step_id":"step","event":{"kind":"tool_call","data":{"id":"call","name":"provider","provider_executed":true}}})).await;
        if let Some(name) = result {
            append(&mut db,"model_observed",None,json!({"step_id":"step","event":{"kind":"provider_tool_result","data":{"id":"call","name":name}}})).await;
        }
        append(
            &mut db,
            "model_interrupted",
            Some("step"),
            json!({"step_id":"step"}),
        )
        .await;
        ended(&mut db, "outcome_unknown").await;
        let safety = require_manual_message_safe(&mut db, "session", None).await;
        if result == Some("provider") {
            assert!(!safety.unwrap());
        } else {
            assert!(matches!(
                safety,
                Err(StoreError::HistoryProviderEffectUnresolved)
            ));
        }
    }
}

#[tokio::test]
async fn obligations_are_transactional_and_survive_reopen_with_migration_backfill() {
    let directory = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(directory.path().join("safety.db"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut db).await.unwrap();
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(&mut db, "tool_dispatched", Some("tool"), json!({})).await;
    ended(&mut db, "outcome_unknown").await;
    // Older admitted facts get one migration backfill, then ordinary indexed reads.
    sqlx::raw_sql(MIGRATION).execute(&mut db).await.unwrap();
    {
        let mut tx = db.begin().await.unwrap();
        append(
            &mut tx,
            "tool_settled",
            Some("tool"),
            json!({"outcome":{"kind":"succeeded"}}),
        )
        .await;
        require_safe(&mut tx, "session", None).await.unwrap();
        tx.rollback().await.unwrap();
    }
    db.close().await.unwrap();
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    assert!(matches!(
        require_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    assert!(
        require_manual_message_safe(&mut db, "session", None)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn completion_without_matching_provider_result_blocks_manual_message_too() {
    for include_result in [false, true] {
        let mut db = database().await;
        append(&mut db, "invocation_opened", None, json!({})).await;
        append(
            &mut db,
            "model_requested",
            Some("step"),
            json!({"step_id":"step"}),
        )
        .await;
        let mut parts = vec![
            json!({"kind":"tool_call","call":{"id":"call","name":"provider","provider_executed":true}}),
        ];
        if include_result {
            parts.push(json!({"kind":"tool_result","id":"call","name":"provider"}));
        }
        append(
            &mut db,
            "model_completed",
            Some("step"),
            json!({"step_id":"step","output":{"parts":parts}}),
        )
        .await;
        ended(&mut db, "outcome_unknown").await;
        let safety = require_manual_message_safe(&mut db, "session", None).await;
        if include_result {
            assert!(!safety.unwrap());
        } else {
            assert!(matches!(safety, Err(StoreError::HistoryUnsettled)));
        }
    }
}
