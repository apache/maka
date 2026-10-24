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
    context::ModelPurpose,
    event::{Fact, Invocation, LogScope, ModelInterruption, RuntimeEvent, ToolOutcome},
    input::InvocationInput,
    model::{ModelEvent, ModelPart, ModelToolCall, TextKind},
    tool_call::{ToolCallIdentity, ToolOrigin},
    tool_output::{DurableToolProjection, RawToolResultRef},
};
use sqlx::{Connection, sqlite::SqliteConnectOptions};

async fn register_functions(db: &mut SqliteConnection) {
    let mut handle = db.lock_handle().await.unwrap();
    let borrowed =
        unsafe { rusqlite::Connection::from_handle(handle.as_raw_handle().as_ptr()) }.unwrap();
    register(&borrowed).unwrap();
    crate::context::evidence::register(&borrowed).unwrap();
}

async fn initialize(db: &mut SqliteConnection) {
    register_functions(db).await;
    // The production writer's admission boundary is outside this fixture. This
    // schema isolates the production semantic projector and explicit transaction.
    sqlx::raw_sql("CREATE TABLE event_log(sequence INTEGER PRIMARY KEY,invocation_id TEXT,event_json TEXT);
        CREATE VIEW runtime_events AS SELECT sequence,event_json FROM event_log;
        CREATE TABLE context_source_lineages(invocation_id TEXT PRIMARY KEY,parent_invocation_id TEXT);
        CREATE TABLE session_history_copies(session_id TEXT PRIMARY KEY,source_session_id TEXT,through_sequence INTEGER,observed_through INTEGER);
        CREATE TABLE session_history_members(session_id TEXT,sequence INTEGER,archive_sequence INTEGER,PRIMARY KEY(session_id,sequence));")
        .execute(&mut *db).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0041_context_semantic.sql"
    ))
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0051_semantic_lookup_indexes.sql"
    ))
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query("DROP TRIGGER context_semantic_append")
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query("ATTACH ':memory:' AS prepared_cache")
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../prepared/schema.sql"))
        .execute(db)
        .await
        .unwrap();
}

async fn database() -> SqliteConnection {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    initialize(&mut db).await;
    db
}

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}

// Raw SQL alone no longer owns projection rollback. Even the isolated reducer
// fixture publishes canonical+semantic changes only through an enclosing TX.
async fn append_event(
    db: &mut SqliteConnection,
    sequence: u64,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let json = serde_json::to_string(event)?;
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO event_log VALUES(?,?,?)")
        .bind(sequence as i64)
        .bind(&event.invocation.invocation_id)
        .bind(&json)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT context_semantic_record(?,?)")
        .bind(sequence as i64)
        .bind(&json)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn append(db: &mut SqliteConnection, sequence: u64, fact: Fact) -> RuntimeEvent {
    let event = RuntimeEvent::new(invocation(), fact);
    append_event(db, sequence, &event).await.unwrap();
    event
}

fn selection(through: u64) -> SemanticSelection {
    SemanticSelection {
        session: "session".into(),
        lineage: None,
        after: 0,
        anchor_sequence: None,
        through,
        before: through + 1,
        captured_through: through,
        replay: None,
        prior_unknown: false,
    }
}

fn request(step: &str, source: u64) -> Fact {
    Fact::ModelRequested {
        item_acceptance: true,
        step_id: step.into(),
        model_id: "model".into(),
        source_scope: LogScope::Session {
            id: "session".into(),
        },
        source_high_water: source,
        source_digest: "fixture".into(),
        input_digest: "fixture".into(),
        route_identity: "route".into(),
        checkpoint_event_id: None,
        purpose: ModelPurpose::Main,
        context: None,
        context_breakdown: None,
        effective_source_digest: None,
    }
}

fn observed(event: ModelEvent) -> Fact {
    Fact::ModelObserved {
        step_id: "step".into(),
        event,
    }
}
fn interrupted(step: &str) -> Fact {
    Fact::ModelInterrupted {
        step_id: step.into(),
        status: ModelInterruption::Cancelled,
        diagnostic: None,
        model_failure: None,
    }
}

async fn opening(db: &mut SqliteConnection) {
    append(
        db,
        1,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "question".into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    )
    .await;
    append(db, 2, request("step", 1)).await;
}

async fn call(db: &mut SqliteConnection) {
    opening(db).await;
    append(
        db,
        3,
        observed(ModelEvent::ToolCall(ModelToolCall {
            id: "call".into(),
            name: "exec".into(),
            input: serde_json::json!({}).into(),
            provider_options: None,
            provider_executed: false,
        })),
    )
    .await;
    append(
        db,
        4,
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()),
            name: "exec".into(),
            input: serde_json::json!({}),
        },
    )
    .await;
}

#[tokio::test]
async fn accepted_text_uses_bounded_pieces_and_reads_no_canonical_payload() {
    let mut db = database().await;
    opening(&mut db).await;
    append(
        &mut db,
        3,
        observed(ModelEvent::PartStarted {
            id: "text".into(),
            text_kind: TextKind::Thinking,
            provider_options: Some(serde_json::json!({"signature":{"first":1}})),
        }),
    )
    .await;
    let body = "中\"\n".repeat(40_000);
    append(
        &mut db,
        4,
        observed(ModelEvent::PartDelta {
            id: "text".into(),
            text: body.clone(),
            provider_options: Some(serde_json::json!({"signature":{"second":2}})),
        }),
    )
    .await;
    append(
        &mut db,
        5,
        observed(ModelEvent::PartFinished {
            id: "text".into(),
            provider_options: None,
        }),
    )
    .await;
    append(&mut db, 6, interrupted("step")).await;
    let largest: i64 =
        sqlx::query_scalar("SELECT MAX(length(bytes)) FROM context_semantic_fragment_pieces")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert!(largest <= 32 * 1024);
    // This explicitly proves the new read boundary; it is not a supported
    // external database editing API or an integrity-detection contract.
    sqlx::query("UPDATE event_log SET event_json=NULL")
        .execute(&mut db)
        .await
        .unwrap();
    let first = rows(&mut db, &selection(6), None, 1, None).await.unwrap();
    assert_eq!(first.rows.len(), 1);
    let second = rows(&mut db, &selection(6), first.next, 1, None)
        .await
        .unwrap();
    assert_eq!(
        second.rows[0].order,
        RowPosition {
            source_sequence: 2,
            item_index: 0
        }
    );
    let resolved = resolve(&mut db, second.rows).await.unwrap();
    assert!(
        matches!(&resolved[0].payload,Some(Payload::Part(ModelPart::Text { text,text_kind:TextKind::Thinking,provider_options:Some(options) })) if text==&body && options==&serde_json::json!({"signature":{"first":1,"second":2}}))
    );
}

#[tokio::test]
async fn stale_source_request_moves_notification_without_changing_frozen_view() {
    let mut db = database().await;
    call(&mut db).await;
    append(
        &mut db,
        5,
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "cell".into(),
            call: ToolCallIdentity {
                tool_call_id: "cell".into(),
                origin: ToolOrigin::CodeCell {
                    parent_operation_id: "step:call".into(),
                    parent_tool_call_id: "call".into(),
                },
            },
            name: "cell".into(),
            input: serde_json::json!({}),
        },
    )
    .await;
    append(
        &mut db,
        6,
        Fact::ToolSettled {
            operation_id: "step:call".into(),
            outcome: ToolOutcome::Failed {
                message: "failed".into(),
            },
        },
    )
    .await;
    append(&mut db, 7, interrupted("step")).await;
    append(
        &mut db,
        8,
        Fact::ToolNotified {
            operation_id: "cell".into(),
            text: "late".into(),
            model_text: "late".into(),
        },
    )
    .await;
    let frozen = selection(8);
    let prior = rows(&mut db, &frozen, None, 20, None).await.unwrap();
    assert!(matches!(
        prior.rows.last().unwrap().kind,
        SemanticKind::Notification { .. }
    ));
    assert_eq!(prior.rows.last().unwrap().order.source_sequence, 8);
    append(&mut db, 9, request("retry", 7)).await;
    assert!(
        !rows(&mut db, &selection(9), None, 20, None)
            .await
            .unwrap()
            .rows
            .iter()
            .any(|row| matches!(row.kind, SemanticKind::Notification { .. }))
    );
    append(&mut db, 10, interrupted("retry")).await;
    assert_eq!(
        rows(&mut db, &frozen, None, 20, None).await.unwrap().rows,
        prior.rows
    );
    let current = rows(&mut db, &selection(10), None, 20, None).await.unwrap();
    let notice = current.rows.last().unwrap();
    assert!(matches!(notice.kind, SemanticKind::Notification { .. }));
    assert_eq!(notice.id.source_sequence, 8);
    assert_eq!(notice.order.source_sequence, 10);
    let changed = changes(&mut db, &selection(10), 8, None, 20).await.unwrap();
    assert!(
        changed
            .changes
            .iter()
            .any(|change| change.order.source_sequence == 8 && change.deleted)
    );
    assert!(
        changed
            .changes
            .iter()
            .any(|change| change.order.source_sequence == 10 && !change.deleted)
    );
}

#[tokio::test]
async fn copying_one_source_does_not_scan_other_semantic_revisions() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    let mut db = database().await;
    opening(&mut db).await;
    let template: String = sqlx::query_scalar(
        "SELECT row_json FROM context_semantic_rows WHERE owner_session_id='session' AND source_sequence=1",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    let mut previous = 1_i64;
    let mut counts = Vec::new();
    for (child, through) in [("small-copy", 128_i64), ("large-copy", 16_384)] {
        // Populate the isolated semantic projection with distinct positions,
        // retaining a shared, valid payload from the opening above.
        sqlx::query(
            "WITH RECURSIVE numbers(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
            INSERT INTO context_semantic_rows
            SELECT 'session',n,0,n,n,0,'invocation','invocation','event-'||n,'user',0,0,1,0,
                json_set(?3,'$.id.sourceSequence',n,'$.order.sourceSequence',n,'$.revision',n)
            FROM numbers",
        )
        .bind(previous + 1)
        .bind(through)
        .bind(&template)
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO session_history_copies VALUES(?,'session',?,?)")
            .bind(child)
            .bind(through)
            .bind(through)
            .execute(&mut db)
            .await
            .unwrap();
        let steps = Arc::new(AtomicU64::new(0));
        let counter = steps.clone();
        db.lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                counter.fetch_add(1, Ordering::Relaxed);
                true
            });
        // Exercise the production copy trigger and reducer, including nested
        // queries, rather than a duplicate of the lookup SQL under test.
        sqlx::query("INSERT INTO session_history_members VALUES(?,?,NULL)")
            .bind(child)
            .bind(through)
            .execute(&mut db)
            .await
            .unwrap();
        db.lock_handle().await.unwrap().remove_progress_handler();
        counts.push(steps.load(Ordering::Relaxed));
        let copied = rows(
            &mut db,
            &SemanticSelection {
                session: child.into(),
                ..selection(through as u64)
            },
            None,
            20,
            None,
        )
        .await
        .unwrap();
        assert_eq!(copied.rows.len(), 1);
        assert_eq!(
            copied.rows[0].id,
            RowPosition {
                source_sequence: through as u64,
                item_index: 0,
            }
        );
        assert_eq!(copied.rows[0].revision, through as u64);
        previous = through;
    }
    eprintln!(
        "single-source copy VM steps: H=128 {}, H=16384 {}",
        counts[0], counts[1]
    );
    assert!(
        counts[1] <= counts[0] * 2,
        "copy scanned unrelated semantic history: {} -> {}",
        counts[0],
        counts[1]
    );
}

#[tokio::test]
async fn archive_revisions_preserve_old_views_and_copied_payload_identity() {
    let mut db = database().await;
    call(&mut db).await;
    append(&mut db, 5, interrupted("step")).await;
    let projection = DurableToolProjection::Text {
        text: "original large result".repeat(800),
    };
    let result = append(
        &mut db,
        6,
        Fact::ToolSettled {
            operation_id: "step:call".into(),
            outcome: ToolOutcome::Succeeded {
                raw: RawToolResultRef {
                    bytes: 1,
                    digest: "fixture".into(),
                },
                model_projection: projection.clone(),
                artifacts: Vec::new(),
            },
        },
    )
    .await;
    let frozen = selection(6);
    // Freeze a descendant before the parent archives the original result.
    sqlx::query("INSERT INTO session_history_copies VALUES('child','session',6,6)")
        .execute(&mut db)
        .await
        .unwrap();
    for sequence in 1..=6 {
        sqlx::query("INSERT INTO session_history_members VALUES('child',?,NULL)")
            .bind(sequence)
            .execute(&mut db)
            .await
            .unwrap();
    }
    let placeholder = maka_agent_facts::archive::ArchivedPlaceholder::prepare(
        result.id,
        "call".into(),
        "exec".into(),
        &projection,
    )
    .unwrap()
    .unwrap();
    append(&mut db, 7, Fact::ToolResultArchived { placeholder }).await;
    let current = SemanticSelection {
        captured_through: 7,
        before: 8,
        ..frozen.clone()
    };
    let old = rows(&mut db, &frozen, None, 20, None).await.unwrap();
    let new = rows(&mut db, &current, None, 20, None).await.unwrap();
    assert!(matches!(
        old.rows.last().unwrap().kind,
        SemanticKind::ToolResult {
            archived: false,
            ..
        }
    ));
    assert!(matches!(
        new.rows.last().unwrap().kind,
        SemanticKind::ToolResult { archived: true, .. }
    ));
    assert_eq!(old.rows.last().unwrap().id, new.rows.last().unwrap().id);
    assert_eq!(
        old.rows.last().unwrap().order,
        new.rows.last().unwrap().order
    );
    let child = SemanticSelection {
        session: "child".into(),
        ..current.clone()
    };
    let copied = rows(&mut db, &child, None, 20, None).await.unwrap();
    assert!(matches!(
        copied.rows.last().unwrap().kind,
        SemanticKind::ToolResult {
            archived: false,
            ..
        }
    ));
    let resolved = resolve(&mut db, copied.rows).await.unwrap();
    assert_eq!(
        resolved.last().unwrap().payload,
        Some(Payload::Tool(projection))
    );
    let changed = changes(&mut db, &current, 6, None, 20).await.unwrap();
    assert!(
        changed
            .changes
            .iter()
            .any(|change| change.order.source_sequence == 6)
    );
}

#[tokio::test]
async fn later_tool_settlement_dirties_the_previously_suppressed_assistant_group() {
    let mut db = database().await;
    call(&mut db).await;
    let replay = SemanticReplay {
        base: 0,
        current: "child".into(),
        route: "route".into(),
        model: "model".into(),
    };
    let prior = SemanticSelection {
        replay: Some(replay.clone()),
        ..selection(4)
    };
    assert!(
        !rows(&mut db, &prior, None, 20, None)
            .await
            .unwrap()
            .rows
            .iter()
            .any(|row| matches!(row.kind, SemanticKind::AssistantPart { .. }))
    );
    let unknown = SemanticSelection {
        prior_unknown: true,
        ..selection(4)
    };
    assert!(
        rows(&mut db, &unknown, None, 20, None)
            .await
            .unwrap()
            .rows
            .iter()
            .any(|row| matches!(row.kind, SemanticKind::UnknownTool { .. }))
    );
    append(&mut db, 5, interrupted("step")).await;
    append(
        &mut db,
        6,
        Fact::ToolSettled {
            operation_id: "step:call".into(),
            outcome: ToolOutcome::Failed {
                message: "failed".into(),
            },
        },
    )
    .await;
    let next = SemanticSelection {
        replay: Some(replay),
        prior_unknown: true,
        ..selection(6)
    };
    let current = rows(&mut db, &next, None, 20, None).await.unwrap();
    assert!(
        current
            .rows
            .iter()
            .any(|row| matches!(row.kind, SemanticKind::AssistantPart { .. }))
    );
    assert!(
        !current
            .rows
            .iter()
            .any(|row| matches!(row.kind, SemanticKind::UnknownTool { .. }))
    );
    assert!(
        changes(&mut db, &next, 4, None, 20)
            .await
            .unwrap()
            .changes
            .iter()
            .any(|change| change.order.source_sequence == 2)
    );
    assert!(
        rows(&mut db, &unknown, None, 20, None)
            .await
            .unwrap()
            .rows
            .iter()
            .any(|row| matches!(row.kind, SemanticKind::UnknownTool { .. })),
        "old captured pending view stays pending after settlement"
    );
}

#[tokio::test]
async fn classified_reducer_failure_preserves_fact_and_rejects_current_projection_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(directory.path().join("semantic.sqlite"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    initialize(&mut db).await;
    opening(&mut db).await;
    let frozen = selection(2);
    // Simulate loss of disposable frontier state, while the admitted canonical
    // opening/request remain intact. The next valid observation must survive.
    sqlx::query("DELETE FROM context_semantic_frontiers")
        .execute(&mut db)
        .await
        .unwrap();
    append(
        &mut db,
        3,
        observed(ModelEvent::PartStarted {
            id: "text".into(),
            text_kind: TextKind::Text,
            provider_options: None,
        }),
    )
    .await;
    let state:(i64,i64)=sqlx::query_as("SELECT through_sequence,unavailable_at FROM context_semantic_heads WHERE session_id='session'").fetch_one(&mut db).await.unwrap();
    assert_eq!(state, (2, 3));
    assert!(rows(&mut db, &selection(3), None, 20, None).await.is_err());
    assert_eq!(
        rows(&mut db, &frozen, None, 20, None)
            .await
            .unwrap()
            .rows
            .len(),
        1
    );
    sqlx::query("INSERT INTO session_history_copies VALUES('child','session',2,2)")
        .execute(&mut db)
        .await
        .unwrap();
    for sequence in 1..=2 {
        sqlx::query("INSERT INTO session_history_members VALUES('child',?,NULL)")
            .bind(sequence)
            .execute(&mut db)
            .await
            .unwrap();
    }
    let child = SemanticSelection {
        session: "child".into(),
        captured_through: 3,
        ..frozen.clone()
    };
    assert_eq!(
        rows(&mut db, &child, None, 20, None)
            .await
            .unwrap()
            .rows
            .len(),
        1,
        "a source failure after the pinned copy cut cannot poison it"
    );
    db.close().await.unwrap();
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    let retained: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM event_log WHERE sequence=3 AND event_json IS NOT NULL)",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert!(retained);
    assert!(available(&mut db, "session").await.is_err());
}

#[tokio::test]
async fn owner_retirement_keeps_copied_fragments_until_source_collection() {
    let mut db = database().await;
    opening(&mut db).await;
    sqlx::query("INSERT INTO session_history_copies VALUES('child','session',2,2)")
        .execute(&mut db)
        .await
        .unwrap();
    for sequence in 1..=2 {
        sqlx::query("INSERT INTO session_history_members VALUES('child',?,NULL)")
            .bind(sequence)
            .execute(&mut db)
            .await
            .unwrap();
    }
    gc::retire_owner(&mut db, "session").await.unwrap();
    assert!(rows(&mut db, &selection(2), None, 20, None).await.is_err());
    let child = SemanticSelection {
        session: "child".into(),
        ..selection(2)
    };
    let copied = rows(&mut db, &child, None, 20, None).await.unwrap();
    let resolved = resolve(&mut db, copied.rows).await.unwrap();
    assert!(
        matches!(&resolved[0].payload,Some(Payload::User(content)) if content.text=="question")
    );
    // The canonical collector calls collect_event only after its existing
    // reverse-owner traversal proves the child has also relinquished material.
    gc::retire_owner(&mut db, "child").await.unwrap();
    gc::collect_event(&mut db, 1).await.unwrap();
    let remains: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_semantic_fragment_pieces WHERE source_sequence=1)",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert!(!remains);
}

#[tokio::test]
async fn prepared_gc_keeps_shared_roots_and_drains_dead_wire_bodies_in_bounded_jobs() {
    let mut db = database().await;
    let registry = crate::context::prepared::lifetime::PreparedRegistry::new();
    for (id, session) in [("parent", "session"), ("child", "child")] {
        sqlx::query("INSERT INTO context_prepared_builds(id,identity,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,root,complete) VALUES(?1,?1,?1,?2,1,1,2,0,'node',1)")
            .bind(id).bind(serde_json::json!({"session":session}).to_string()).execute(&mut db).await.unwrap();
        sqlx::query(
            "INSERT INTO context_prepared_heads(session_id,build_id,touched) VALUES(?,?,0)",
        )
        .bind(session)
        .bind(id)
        .execute(&mut db)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO context_prepared_nodes VALUES('node',?)")
        .bind(serde_json::json!({"left":null,"right":null,"content":"group"}).to_string())
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO context_prepared_groups VALUES('group',?)")
        .bind(serde_json::json!({"wire_id":"wire"}).to_string())
        .execute(&mut db)
        .await
        .unwrap();
    for index in 0..260 {
        sqlx::query("INSERT INTO context_prepared_chunks VALUES('wire',?,0,0,1,NULL,?)")
            .bind(index)
            .bind(vec![42u8])
            .execute(&mut db)
            .await
            .unwrap();
    }
    crate::context::prepared::gc::retire_owner(&mut db, "session")
        .await
        .unwrap();
    assert!(
        !crate::context::prepared::gc::maintain(&mut db, &registry)
            .await
            .unwrap()
    );
    let retained: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_chunks")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(retained, 260);
    crate::context::prepared::gc::retire_owner(&mut db, "child")
        .await
        .unwrap();
    assert!(
        crate::context::prepared::gc::maintain(&mut db, &registry)
            .await
            .unwrap()
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_chunks")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(remaining, 132);
    while crate::context::prepared::gc::maintain(&mut db, &registry)
        .await
        .unwrap()
    {}
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_chunks)")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn storage_failure_rolls_back_the_explicit_transaction_instead_of_marking_projection_available()
 {
    let mut db = database().await;
    sqlx::raw_sql("CREATE TRIGGER reject_piece BEFORE INSERT ON context_semantic_fragment_pieces BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").execute(&mut db).await.unwrap();
    let event = RuntimeEvent::new(
        invocation(),
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "question".into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    );
    let result = append_event(&mut db, 1, &event).await;
    assert!(result.is_err());
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM event_log)")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert!(!exists);
    let heads: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_semantic_heads)")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert!(!heads);
}

#[tokio::test]
async fn group_and_page_queries_seek_the_order_index_instead_of_rescanning_the_owner() {
    let mut db = database().await;
    for group in [Some(7_600i64), None] {
        let explain = format!("EXPLAIN QUERY PLAN {}", rows_query(group.is_some()));
        let plan = sqlx::query(sqlx::AssertSqlSafe(explain))
            .bind("session")
            .bind(0i64)
            .bind(10_000i64)
            .bind(10_000i64)
            .bind(10_001i64)
            .bind(None::<String>)
            .bind(7_599i64)
            .bind(0i64)
            .bind(7_599i64)
            .bind(0i64)
            .bind(group)
            .bind(257i64)
            .bind(None::<i64>)
            .bind(None::<String>)
            .bind(false)
            .fetch_all(&mut db)
            .await
            .unwrap();
        let details = plan
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>();
        if group.is_some() {
            assert!(
                details.iter().any(|detail| detail
                    .starts_with("SEARCH r USING INDEX context_semantic_row_order")
                    && detail.contains("owner_session_id=? AND order_sequence=?")),
                "known group must seek by owner and group: {details:?}"
            );
        } else {
            assert!(
                details.iter().any(|detail| detail.contains("PRIMARY KEY")
                    && detail.contains("owner_session_id=? AND source_sequence>?")),
                "whole-window page must seek by source before ordering: {details:?}"
            );
        }
    }
}

#[tokio::test]
async fn imported_conversation_counts_as_new_compaction_history_but_the_anchor_does_not() {
    use maka_agent_facts::import::{Content, Record, Source};
    let mut db = database().await;
    for (sequence, content) in [
        (
            1,
            Content::User {
                text: "imported question".into(),
            },
        ),
        (
            2,
            Content::Assistant {
                text: "imported answer".into(),
                model: None,
                thinking: None,
            },
        ),
        (
            3,
            Content::Note {
                text: "ledger-only note".into(),
            },
        ),
    ] {
        append(
            &mut db,
            sequence,
            Fact::MessageImported {
                source: Source {
                    adapter: "fixture".into(),
                    session_id: "foreign".into(),
                },
                record: Box::new(Record {
                    source_message_id: format!("message-{sequence}"),
                    source_turn_id: "foreign-turn".into(),
                    timestamp: None,
                    content,
                }),
            },
        )
        .await;
    }
    assert!(
        meaningful_history(&mut db, &selection(1)).await.unwrap(),
        "imported user can trigger first native compaction"
    );
    assert!(
        meaningful_history(
            &mut db,
            &SemanticSelection {
                after: 1,
                ..selection(2)
            }
        )
        .await
        .unwrap(),
        "new imported assistant material also advances compaction"
    );
    assert!(
        !meaningful_history(
            &mut db,
            &SemanticSelection {
                after: 2,
                anchor_sequence: Some(1),
                ..selection(3)
            }
        )
        .await
        .unwrap(),
        "an already covered user anchor and a ledger note do not create new conversation history"
    );
}
