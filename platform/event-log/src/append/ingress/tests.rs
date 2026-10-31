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
use crate::EventLog;
use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationOutcome, LogScope, ModelInterruption},
    input::InvocationInput,
    model::{
        ModelPart, ModelToolCall,
        recorded::{ModelObservation, ModelPartRecord},
    },
    tool_call::ToolCallIdentity,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
};
use sqlx::Connection;

fn opening(id: &str) -> RuntimeEvent {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "question".into(),
                request_fingerprint: None,
            },
        },
    );
    event.id = id.into();
    event
}
fn closed(id: &str) -> Vec<EventWrite> {
    let opened = opening(id);
    let ended = RuntimeEvent::new(
        opened.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    vec![
        EventWrite::plain(opened).unwrap(),
        EventWrite::plain(ended).unwrap(),
    ]
}
fn counts(path: &std::path::Path) -> Vec<i64> {
    let db = rusqlite::Connection::open(path).unwrap();
    [
        "event_log",
        "context_source_prefixes",
        "context_source_lineages",
        "context_semantic_heads",
        "context_semantic_frontiers",
        "context_semantic_rows",
        "context_semantic_fragments",
        "model_part_records",
        "context_obligations",
        "context_safety_heads",
        "context_execution_steps",
        "context_execution_work",
        "context_independent_tools",
    ]
    .iter()
    .map(|table| {
        db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    })
    .collect()
}

#[tokio::test]
async fn autocommit_is_rejected_before_any_canonical_insert() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let error = log
        .connection
        .run(|db| {
            Box::pin(async move {
                let event = opening("unowned");
                insert(
                    db,
                    &event,
                    serde_json::to_string(&event)?,
                    Position::Admitted,
                )
                .await
            })
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("requires an existing transaction")
    );
    log.close().await.unwrap();
    assert_eq!(counts(&path), vec![0; 13]);
}

#[tokio::test]
async fn projection_faults_roll_back_canonical_and_prior_batch_events_before_reopen() {
    for (name, trigger) in [
        (
            "source",
            "CREATE TEMP TRIGGER ingress_fault BEFORE INSERT ON context_source_prefixes WHEN NEW.kind='session' AND NEW.owner='session' AND NEW.sequence=3 BEGIN SELECT RAISE(ABORT,'source fault'); END;",
        ),
        (
            "obligation",
            "CREATE TEMP TRIGGER ingress_fault BEFORE INSERT ON context_obligations WHEN NEW.kind='invocation' AND NEW.opened_at=3 BEGIN SELECT RAISE(ABORT,'obligation fault'); END;",
        ),
        (
            "semantic",
            "CREATE TEMP TRIGGER ingress_fault BEFORE INSERT ON context_semantic_fragment_pieces WHEN NEW.source_sequence=3 BEGIN SELECT RAISE(ABORT,'semantic fault'); END;",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    sqlx::raw_sql(trigger).execute(db).await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let mut events = closed("first");
        events.extend(closed("second"));
        assert!(log.append_batch(&events).await.is_err(), "{name}");
        log.close().await.unwrap();
        assert_eq!(counts(&path), vec![0; 13], "{name}");
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(reopened.append_batch(&events).await.unwrap(), [1, 2, 3, 4]);
        reopened.close().await.unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM context_source_prefixes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            8
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM context_semantic_frontiers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}

fn visible_tool_prefix() -> Vec<EventWrite> {
    let opened = opening("tool-invocation");
    let invocation = opened.invocation.clone();
    let facts = [
        Fact::ModelRequested {
            source_capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: 0,
                prior_unknown: false,
            },
            item_acceptance: true,
            step_id: "step".into(),
            model_id: "model".into(),
            source_scope: LogScope::Session {
                id: "session".into(),
            },
            source_high_water: 1,
            source_digest: "fixture".into(),
            input_digest: "fixture".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            context_breakdown: None,
            effective_source_digest: None,
        },
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::Part(ModelPartRecord {
                ordinal: 0,
                message_id: maka_agent_facts::tool_call::tool_use_id(
                    "tool-invocation",
                    "step:call",
                ),
                started_at: std::time::UNIX_EPOCH,
                provider_part_id: None,
                part: std::sync::Arc::new(ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: "call".into(),
                        name: "exec".into(),
                        input:
                            serde_json::json!({"model_projection": "decoy before projection 中🦀"})
                                .into(),
                        provider_options: None,
                        provider_executed: false,
                    },
                }),
            }),
        },
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()),
            name: "exec".into(),
            input: serde_json::json!({"model_projection": "decoy before projection 中🦀"}),
        },
        Fact::ModelInterrupted {
            step_id: "step".into(),
            status: ModelInterruption::Cancelled,
            diagnostic: None,
            model_failure: None,
            partial: None,
        },
    ];
    let mut events = vec![EventWrite::plain(opened).unwrap()];
    events.extend(
        facts
            .into_iter()
            .map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()),
    );
    events
}

fn tool_selection(through: u64) -> crate::context::semantic::SemanticSelection {
    crate::context::semantic::SemanticSelection {
        session: "session".into(),
        lineage: None,
        after: 0,
        through,
        before: through + 1,
        captured_through: through,
        replay: None,
        prior_unknown: false,
    }
}

#[tokio::test]
async fn canonical_tool_spans_preserve_projection_raw_and_replay_after_reopen_and_import() {
    use maka_agent_facts::history::semantic::Payload;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let mut events = visible_tool_prefix();
    let projection = DurableToolProjection::Text {
        text: "中🦀\"\n\\ {\"model_projection\":\"not the source\"} ".repeat(2_000),
    };
    let output =
        ToolOutput::Text("raw evidence differs from model_projection 中🦀 ".repeat(16_000));
    let (settled, _) = EventWrite::tool_success(
        "settled".into(),
        std::time::UNIX_EPOCH,
        events[0].event().invocation.clone(),
        "step:call".into(),
        ToolSuccess::projected(output.clone(), projection.clone()),
    )
    .unwrap();
    let expected_json = serde_json::to_string(settled.event()).unwrap();
    events.push(settled.clone());
    assert_eq!(log.append_batch(&events).await.unwrap(), [1, 2, 3, 4, 5, 6]);
    assert_eq!(
        log.append(&settled).await.unwrap(),
        6,
        "retry must retain the original source"
    );
    let (conflict, _) = EventWrite::tool_success(
        "settled".into(),
        std::time::UNIX_EPOCH,
        settled.event().invocation.clone(),
        "step:call".into(),
        ToolSuccess::projected(
            output.clone(),
            DurableToolProjection::Text {
                text: "conflict".into(),
            },
        ),
    )
    .unwrap();
    assert!(
        log.append(&conflict).await.is_err(),
        "conflicting retry cannot replace the canonical source"
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let page = reopened
        .context_semantic_rows(&tool_selection(6), None, 20)
        .await
        .unwrap();
    let resolved = reopened.context_semantic_resolve(&page.rows).await.unwrap();
    assert_eq!(
        resolved.last().unwrap().payload,
        Some(Payload::Tool(projection.clone()))
    );
    assert_eq!(
        reopened
            .resolve_tool_result("session", "settled")
            .await
            .unwrap(),
        output
    );
    let replay = reopened.prefix(20, 4 * 1024 * 1024).await.unwrap();
    assert_eq!(replay.events.len(), events.len());
    for (stored, expected) in replay.events.iter().zip(&events) {
        assert_eq!(stored.event, *expected.event());
    }
    let canonical: String = reopened
        .connection
        .read_interruptible(|db| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT event_json FROM event_log WHERE sequence=6")
                        .fetch_one(db)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(canonical, expected_json);
    reopened.close().await.unwrap();

    let imported = EventLog::open(&dir.path().join("imported.sqlite"))
        .await
        .unwrap();
    let rewritten: Vec<_> = events
        .iter()
        .map(|write| {
            let event = write.event().clone();
            let json = serde_json::to_string_pretty(&event).unwrap();
            (event, json)
        })
        .collect();
    let imported_json = rewritten.last().unwrap().1.clone();
    assert_ne!(
        imported_json, expected_json,
        "import fixture rewrites the actual JSON bytes"
    );
    imported
        .connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin().await?;
                for (index, (event, json)) in rewritten.into_iter().enumerate() {
                    insert(
                        &mut tx,
                        &event,
                        json,
                        Position::Imported(Some(41 + index as u64)),
                    )
                    .await?;
                }
                tx.commit().await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    imported.close().await.unwrap();
    let imported = EventLog::open(&dir.path().join("imported.sqlite"))
        .await
        .unwrap();
    let page = imported
        .context_semantic_rows(&tool_selection(46), None, 20)
        .await
        .unwrap();
    let resolved = imported.context_semantic_resolve(&page.rows).await.unwrap();
    assert_eq!(
        resolved.last().unwrap().payload,
        Some(Payload::Tool(projection))
    );
    let stored_json: String = imported
        .connection
        .read_interruptible(|db| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT event_json FROM event_log WHERE sequence=46")
                        .fetch_one(db)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(stored_json, imported_json);
    imported.close().await.unwrap();
}

#[tokio::test]
async fn canonical_open_rejects_utf16_and_retains_utf8() {
    let dir = tempfile::tempdir().unwrap();
    for (encoding, pragma) in [
        ("UTF-8", "PRAGMA encoding='UTF-8'"),
        ("UTF-16le", "PRAGMA encoding='UTF-16le'"),
        ("UTF-16be", "PRAGMA encoding='UTF-16be'"),
    ] {
        let path = dir.path().join(format!("{encoding}.sqlite"));
        let mut db = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::query(pragma).execute(&mut db).await.unwrap();
        sqlx::query("PRAGMA application_id=1296124754")
            .execute(&mut db)
            .await
            .unwrap();
        crate::sqlite_functions::register(&mut db).await.unwrap();
        crate::sqlite_functions::register_migrations(&mut db)
            .await
            .unwrap();
        sqlx::migrate!("./migrations")
            .run_direct(None, &mut db, false)
            .await
            .unwrap();
        db.close().await.unwrap();
        match EventLog::open(&path).await {
            Ok(log) => {
                assert_eq!(
                    encoding, "UTF-8",
                    "non-UTF8 canonical DB must be rejected before admission"
                );
                assert_eq!(log.append_batch(&closed("utf8")).await.unwrap(), [1, 2]);
                log.close().await.unwrap();
            }
            Err(error) => {
                assert_ne!(encoding, "UTF-8");
                assert!(
                    matches!(error, StoreError::UnsupportedDatabase),
                    "{error:?}"
                );
            }
        }
    }
}
