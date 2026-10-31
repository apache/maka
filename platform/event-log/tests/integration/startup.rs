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
use maka_event_log::{
    EventLog, RootStore, StoreError,
    root::{FileLease, ROOT_DATABASE, RootNamespaces, RootOwner},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::Arc;

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
async fn catalog_migration_preserves_existing_history_and_backfills_cached_activity() {
    use sqlx::Connection as _;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("before-catalog-activity.sqlite");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut database = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    sqlx::query("PRAGMA application_id = 1296124754")
        .execute(&mut database)
        .await
        .unwrap();
    sqlx::migrate!("./migrations")
        .run_direct(Some(10), &mut database, false)
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration) VALUES
        ('a-empty','empty',1,100,9999,0,'{"title":"empty"}'),
        ('z-active','active',1,10,10,0,'{"title":"active"}'),
        ('pinned','pinned',1,1,1,0,'{"title":"pinned","pinned":true}'),
        ('b-tie','b',1,50,50,0,'{"title":"b"}'),
        ('c-tie','c',1,50,50,0,'{"title":"c"}');"#,
    ).execute(&mut database).await.unwrap();
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "z-active".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "existing message".into(),
                request_fingerprint: None,
            },
        },
    );
    event.recorded_at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(500);
    sqlx::query(
        "INSERT INTO event_log(event_id,invocation_id,kind,event_json,event_session)
        VALUES(?,'invocation','invocation_opened',?,'z-active')",
    )
    .bind(&event.id)
    .bind(serde_json::to_string(&event).unwrap())
    .execute(&mut database)
    .await
    .unwrap();
    sqlx::query("INSERT INTO catalog_messages VALUES(1,0,'z-active',500,'existing message',?)")
        .bind(&event.id)
        .execute(&mut database)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog_message_watermark VALUES(1,1)")
        .execute(&mut database)
        .await
        .unwrap();
    database.close().await.unwrap();
    let old_checksums = migration_checksums(&Connection::open(&path).unwrap());

    for _ in 0..2 {
        let log = EventLog::open(&path).await.unwrap();
        let page = log.list_sessions::<Value>(None, None, 10).await.unwrap();
        assert_eq!(
            page.sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["pinned", "z-active", "a-empty", "b-tie", "c-tie"]
        );
        assert_eq!(
            page.sessions[1]
                .last_message
                .as_ref()
                .unwrap()
                .preview
                .as_deref(),
            Some("existing message")
        );
        assert_eq!(log.prefix(10, 16384).await.unwrap().events[0].event, event);
        log.close().await.unwrap();
    }
    let checksums = migration_checksums(&Connection::open(&path).unwrap());
    assert_eq!(&checksums[..old_checksums.len()], old_checksums);
    assert_eq!(checksums.last().unwrap().0, 12);
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
async fn initialization_and_high_water_failures_close_the_actual_sql_owner_before_returning() {
    for high_water in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
        let store = RootStore::open(owner).await.unwrap();
        store.close().await.unwrap();
        let database = root.join(ROOT_DATABASE);
        let raw = rusqlite::Connection::open(&database).unwrap();
        if high_water {
            // Deliberately corrupt canonical storage outside RuntimeEvent ingress.
            // Current projection ownership is application-level; no append UDF
            // trigger must be disabled or restored around this fault fixture.
            raw.execute_batch("PRAGMA ignore_check_constraints=ON; INSERT INTO event_log(sequence,event_id,kind,event_json) VALUES(-1,'invalid','diagnostic','{}');").unwrap();
        } else {
            raw.execute_batch("PRAGMA application_id=123;").unwrap();
        }
        raw.close().unwrap();
        let owner = Arc::new(RootOwner::open(&root, &namespaces).unwrap());
        let original = Arc::downgrade(&owner);
        let error = RootStore::open(owner).await.err().unwrap();
        if high_water {
            assert!(
                matches!(error, StoreError::InvalidTransition(reason) if reason == "negative ledger sequence")
            );
        } else {
            assert!(matches!(error, StoreError::UnsupportedDatabase));
        }
        assert!(
            original.upgrade().is_none(),
            "the real worker and startup owner must release their Root"
        );
        let mut lock = database.as_os_str().to_os_string();
        lock.push(".writer.lock");
        drop(FileLease::acquire(std::path::Path::new(&lock)).unwrap());
        drop(RootOwner::open(&root, &namespaces).unwrap());
    }
}

#[tokio::test]
async fn startup_recovers_model_and_call_cuts_across_multiple_pages_in_opening_order() {
    use maka_agent_facts::{
        context::ModelPurpose,
        event::{ModelInterruption, ToolOutcome},
        model::{
            ModelPart, ModelToolCall,
            recorded::{ModelObservation, ModelPartRecord},
        },
        tool_call::{ToolCallIdentity, ToolRejection},
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for n in 0..257 {
        let invocation = Invocation {
            session_id: format!("s-{n}"),
            turn_id: format!("t-{n}"),
            run_id: format!("r-{n}"),
            invocation_id: format!("i-{n}"),
        };
        let write = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
        log.append(&write(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "recover".into(),
                request_fingerprint: None,
            },
        }))
        .await
        .unwrap();
        if n < 4 {
            let step = format!("step-{n}");
            let call = format!("call-{n}");
            let operation = format!("{step}:{call}");
            let source = log.prefix(32, 64 * 1024).await.unwrap();
            log.append(&write(Fact::ModelRequested {
                source_capture: maka_agent_facts::event::SourceCapture {
                    publication_watermark: source.high_water,
                    prior_unknown: false,
                },
                context_breakdown: None,
                item_acceptance: true,
                purpose: ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: step.clone(),
                model_id: "model".into(),
                source_scope: source.scope,
                source_high_water: source.high_water,
                source_digest: source.digest,
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            }))
            .await
            .unwrap();
            if n > 0 {
                log.append(&write(Fact::ModelObserved {
                    step_id: step.clone(),
                    event: ModelObservation::Part(ModelPartRecord {
                        ordinal: 0,
                        message_id: maka_agent_facts::tool_call::tool_use_id(
                            &invocation.invocation_id,
                            &operation,
                        ),
                        started_at: std::time::UNIX_EPOCH,
                        provider_part_id: None,
                        part: Arc::new(ModelPart::ToolCall {
                            call: ModelToolCall {
                                id: call.clone(),
                                name: "write_file".into(),
                                input: json!({"path":"effect.txt"}).into(),
                                provider_options: None,
                                provider_executed: false,
                            },
                        }),
                    }),
                }))
                .await
                .unwrap();
            }
            if n > 1 {
                log.append(&write(Fact::ToolDispatched {
                    presentation: None,
                    title: None,
                    operation_id: operation.clone(),
                    call: ToolCallIdentity::provider(step.clone(), call.clone()),
                    name: "write_file".into(),
                    input: json!({"path":"effect.txt"}),
                }))
                .await
                .unwrap();
            }
            if n == 3 {
                log.append(&write(Fact::ToolSettled {
                    operation_id: operation.clone(),
                    outcome: ToolOutcome::Failed {
                        message: "known failure".into(),
                    },
                }))
                .await
                .unwrap();
            }
        }
    }
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let first = log.unfinished_invocations(0, 256).await.unwrap();
    assert_eq!(first.invocations.len(), 256);
    assert_eq!(
        maka_event_log::recovery::recover_invocations(&log)
            .await
            .unwrap(),
        257
    );
    let prefix = log.prefix(529, 1024 * 1024).await.unwrap();
    let ended = prefix
        .events
        .iter()
        .filter_map(|stored| {
            matches!(stored.event.fact, Fact::InvocationEnded { .. })
                .then_some(stored.event.invocation.invocation_id.as_str())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        ended,
        (0..257).map(|n| format!("i-{n}")).collect::<Vec<_>>()
    );
    assert_eq!(
        prefix
            .events
            .iter()
            .filter(|stored| matches!(stored.event.fact, Fact::InvocationOpened { .. }))
            .count(),
        257
    );
    for n in 0..4 {
        let id = format!("i-{n}");
        let step = format!("step-{n}");
        let operation = format!("{step}:call-{n}");
        let facts = prefix
            .events
            .iter()
            .filter(|stored| stored.event.invocation.invocation_id == id)
            .map(|stored| &stored.event.fact)
            .collect::<Vec<_>>();
        assert!(facts.iter().any(|fact| matches!(fact,
            Fact::ModelInterrupted { step_id, status: ModelInterruption::Failed, .. } if step_id == &step)));
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::ToolRejected {
            operation_id, reason: ToolRejection::Cancelled, .. } if operation_id == &operation))
                .count(),
            usize::from(n == 1)
        );
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::ToolDispatched { .. }))
                .count(),
            usize::from(n > 1)
        );
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::ToolSettled { .. }))
                .count(),
            usize::from(n == 3)
        );
        assert!(matches!(facts.last().unwrap(), Fact::InvocationEnded {
            outcome: maka_agent_facts::event::InvocationOutcome::Failed { class, .. }
        } if class == if n == 2 { "outcome_unknown" } else { "host_interrupted" }));
        let state = prefix.project_invocation(&id);
        assert!(state.unfinished_model_steps.is_empty());
        assert_eq!(
            state.uncertain_operations,
            if n == 2 { vec![operation] } else { vec![] }
        );
    }
    assert!(
        log.unfinished_invocations(first.through_sequence, 256)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert_eq!(
        maka_event_log::recovery::recover_invocations(&log)
            .await
            .unwrap(),
        0
    );
    log.close().await.unwrap();
}
