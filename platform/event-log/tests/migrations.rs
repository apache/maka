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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{EventLog, StoreError};
use rusqlite::Connection;
use serde_json::{Value, json};

async fn seed_session_and_event(log: &EventLog) -> RuntimeEvent {
    log.create_session("session", "request", &json!({"name":"kept"}), 10)
        .await
        .unwrap();
    let event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "kept".into(),
                request_fingerprint: None,
            },
        },
    );
    log.append(&EventWrite::plain((event).clone()).unwrap())
        .await
        .unwrap();
    event
}

fn migration_checksums(connection: &Connection) -> Vec<(i64, Vec<u8>)> {
    connection
        .prepare(
            "SELECT version, checksum FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[tokio::test]
async fn dropping_canonical_triggers_preserves_existing_projection_and_accepts_new_settlement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let opening = seed_session_and_event(&log).await;
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            opening.invocation.clone(),
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "tool".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("call".into()),
                name: "Read".into(),
                input: json!({}),
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    log.close().await.unwrap();
    let old = Connection::open(&path).unwrap();
    let checksum = migration_checksums(&old)
        .into_iter()
        .find(|(version, _)| *version == 1)
        .unwrap();
    let original: Vec<(i64, String)> = old
        .prepare("SELECT sequence,event_json FROM event_log ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // Restore precisely the version-one DDL and migration ledger around valid
    // committed data, rather than rewriting the historical migration checksum.
    let baseline = Connection::open_in_memory().unwrap();
    baseline
        .execute_batch(include_str!("../migrations/0001_runtime.sql"))
        .unwrap();
    let triggers:Vec<String>=baseline.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name IN ('context_obligations_append','context_execution_append') ORDER BY name").unwrap()
        .query_map([],|row|row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(triggers.len(), 2);
    old.execute_batch("BEGIN IMMEDIATE").unwrap();
    for trigger in triggers {
        old.execute_batch(&trigger).unwrap();
    }
    assert_eq!(
        old.execute("DELETE FROM _sqlx_migrations WHERE version=2", [])
            .unwrap(),
        1
    );
    old.execute_batch("COMMIT").unwrap();
    assert_eq!(
        old.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(old);

    let log = EventLog::open(&path).await.unwrap();
    let migrated = Connection::open(&path).unwrap();
    assert_eq!(
        migration_checksums(&migrated)
            .into_iter()
            .find(|(version, _)| *version == 1)
            .unwrap(),
        checksum
    );
    assert_eq!(
        migrated
            .query_row(
                "SELECT COUNT(*) FROM _sqlx_migrations WHERE version=2 AND success=1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(migrated.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND name IN ('context_obligations_append','context_execution_append')",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(migrated.query_row("SELECT COUNT(*) FROM context_obligations WHERE kind='tool' AND operation_id='tool'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    let after: Vec<(i64, String)> = migrated
        .prepare("SELECT sequence,event_json FROM event_log ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(after, original);
    drop(migrated);
    assert_eq!(
        log.append(
            &EventWrite::plain(RuntimeEvent::new(
                opening.invocation,
                Fact::ToolSettled {
                    operation_id: "tool".into(),
                    outcome: maka_agent_facts::event::ToolOutcome::Failed {
                        message: "known result".into()
                    },
                }
            ))
            .unwrap()
        )
        .await
        .unwrap(),
        3
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    reopened.close().await.unwrap();
    let final_db = Connection::open(&path).unwrap();
    assert_eq!(
        final_db
            .query_row(
                "SELECT COUNT(*) FROM context_obligations WHERE kind='tool'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(final_db.query_row("SELECT closed_at FROM context_execution_work WHERE kind='tool' AND operation_id='tool'",[],|row|row.get::<_,i64>(0)).unwrap(),3);
}

#[tokio::test]
async fn initialization_and_reopen_preserve_facts_payloads_and_schema_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let event = seed_session_and_event(&log).await;
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            event.invocation.clone(),
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "read".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("call".into()),
                name: "Read".into(),
                input: json!({}),
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    let (outcome, _) = EventWrite::tool_success(
        "result".into(),
        event.recorded_at,
        event.invocation.clone(),
        "read".into(),
        maka_agent_facts::tool_output::ToolOutput::Text("persistent output".into()).into(),
    )
    .unwrap();
    log.append(&outcome).await.unwrap();
    let before = serde_json::to_vec(&log.prefix(10, 16384).await.unwrap()).unwrap();
    let session = log.get_session::<Value>("session").await.unwrap();
    log.close().await.unwrap();
    let connection = Connection::open(&path).unwrap();
    let checksums = migration_checksums(&connection);
    assert!(!checksums.is_empty());
    assert!(checksums.iter().all(|(_, checksum)| checksum.len() == 48));
    let raw: Vec<u8> = connection
        .query_row(
            "SELECT payload FROM tool_result_payloads WHERE event_id = 'result'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Closing the owner drops optional bodies while preserving accepted work.
    assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('transcript_rows','transcript_text')", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
    drop(connection);
    let log = EventLog::open(&path).await.unwrap();
    let cache = Connection::open(&path).unwrap();
    assert_eq!(
        cache
            .query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('transcript_rows','transcript_text')", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let headers = log
        .transcript_headers(
            "session",
            &maka_event_log::transcript::TranscriptRead {
                through: 1,
                position: None,
                direction: maka_event_log::transcript::TranscriptDirection::Newer,
                limit: 256,
            },
        )
        .await
        .unwrap();
    assert!(
        cache
            .query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('transcript_rows','transcript_text')", [], |row| row
                .get::<_, i64>(0))
            .unwrap()
            == 0
    );
    assert!(
        !headers.is_empty(),
        "public reads reconstruct rows from canonical facts"
    );
    drop(cache);
    assert_eq!(
        serde_json::to_vec(&log.prefix(10, 16384).await.unwrap()).unwrap(),
        before
    );
    assert_eq!(
        log.probe_session_create::<Value>("session", "request")
            .await
            .unwrap(),
        session
    );
    assert_eq!(
        log.append(&EventWrite::plain(event).unwrap())
            .await
            .unwrap(),
        1
    );
    log.close().await.unwrap();
    let connection = Connection::open(&path).unwrap();
    assert_eq!(migration_checksums(&connection), checksums);
    assert_eq!(
        connection
            .query_row(
                "SELECT payload FROM tool_result_payloads WHERE event_id = 'result'",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .unwrap(),
        raw
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            },)
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn mismatched_and_unknown_migrations_fail_closed_without_touching_committed_events() {
    let temp = tempfile::tempdir().unwrap();
    for (case, corruption) in [
        "UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 1",
        "UPDATE _sqlx_migrations SET version = 99 WHERE version = 1",
        "DROP TABLE _sqlx_migrations",
        "DELETE FROM _sqlx_migrations",
        "PRAGMA user_version = 0",
    ]
    .into_iter()
    .enumerate()
    {
        let path = temp.path().join(format!("events-{case}.sqlite"));
        let log = EventLog::open(&path).await.unwrap();
        let event = seed_session_and_event(&log).await;
        log.close().await.unwrap();
        let connection = Connection::open(&path).unwrap();
        let session_before: String = connection.query_row(
            "SELECT json_array(id, fingerprint, revision, created_at, updated_at, archived, configuration) FROM session_control",
            [], |row| row.get(0)
        ).unwrap();
        connection.execute_batch(corruption).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode = DELETE")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();
        let error = EventLog::open(&path).await.err().expect("must reject");
        assert!(
            std::fs::read(&path).unwrap() == before,
            "rejected open mutated database ({corruption})"
        );
        if case == 1 {
            assert!(matches!(
                error,
                StoreError::Migration(sqlx::migrate::MigrateError::VersionMissing(99))
            ));
        } else if case == 0 {
            assert!(matches!(
                error,
                StoreError::Migration(sqlx::migrate::MigrateError::VersionMismatch(1))
            ));
        } else {
            assert!(matches!(error, StoreError::UnsupportedDatabase));
        }
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM runtime_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let stored_event: String = connection
            .query_row(
                "SELECT event_json FROM runtime_events WHERE sequence = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored_event).unwrap(),
            serde_json::to_value(&event).unwrap()
        );
        assert_eq!(connection.query_row(
            "SELECT json_array(id, fingerprint, revision, created_at, updated_at, archived, configuration) FROM session_control",
            [], |row| row.get::<_, String>(0)
        ).unwrap(), session_before);
    }

    let path = temp.path().join("foreign.sqlite");
    let foreign = Connection::open(&path).unwrap();
    foreign
        .execute_batch("CREATE TABLE user_data(value); INSERT INTO user_data VALUES('keep')")
        .unwrap();
    drop(foreign);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        EventLog::open(&path).await,
        Err(StoreError::UnsupportedDatabase)
    ));
    assert!(std::fs::read(&path).unwrap() == before);
    let foreign = Connection::open(&path).unwrap();
    assert_eq!(
        foreign
            .query_row("SELECT value FROM user_data", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert_eq!(
        foreign
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name = '_sqlx_migrations'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn interrupted_initial_migration_remains_openable_under_the_rust_application_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let connection = Connection::open(&path).unwrap();
    // SQLx creates its ledger before applying migration 1. A crash at that
    // boundary must not misclassify the database as foreign on the next open.
    connection
        .execute_batch(
            "PRAGMA application_id = 1296124754;
         CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY, description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL
         );",
        )
        .unwrap();
    drop(connection);
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.prefix(1, 1024).await.unwrap().high_water, 0);
    log.close().await.unwrap();
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!migration_checksums(&connection).is_empty());
}
