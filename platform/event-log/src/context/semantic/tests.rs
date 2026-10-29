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
    event::{
        Fact, Invocation, LogScope, ModelInterruption, RuntimeEvent, StoredEvent, ToolOutcome,
    },
    input::InvocationInput,
    model::{
        ModelPart, ModelToolCall, TextKind,
        recorded::{ModelObservation, ModelPartRecord},
    },
    tool_call::{ToolCallIdentity, ToolOrigin},
    tool_output::{DurableToolProjection, RawToolResultRef},
};
use sqlx::{Connection, sqlite::SqliteConnectOptions};

async fn initialize(db: &mut SqliteConnection) {
    crate::sqlite_functions::register(db).await.unwrap();
    super::directory::register_fixture_function(db)
        .await
        .unwrap();
    // The production writer's admission boundary is outside this fixture. This
    // schema isolates the production semantic projector and explicit transaction.
    sqlx::raw_sql("CREATE TABLE event_log(sequence INTEGER PRIMARY KEY,invocation_id TEXT,event_json TEXT);
        CREATE VIEW runtime_events AS SELECT sequence,event_json FROM event_log;
        CREATE TABLE context_source_lineages(invocation_id TEXT PRIMARY KEY,parent_invocation_id TEXT);
        CREATE TABLE session_history_copies(session_id TEXT PRIMARY KEY,source_session_id TEXT,through_sequence INTEGER,observed_through INTEGER);
        CREATE TABLE session_history_members(session_id TEXT,sequence INTEGER,archive_sequence INTEGER,PRIMARY KEY(session_id,sequence));")
        .execute(&mut *db).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|_, name| {
        name.starts_with("context_semantic_")
    })))
    .execute(&mut *db)
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
    let stored = StoredEvent {
        sequence,
        event: event.clone(),
    };
    crate::connection::worker_query(&mut tx, move |worker| {
        Box::pin(async move { record(worker, &stored, &json).await })
    })
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn insert_member(db: &mut SqliteConnection, owner: &str, sequence: i64) {
    let owner = owner.to_owned();
    let mut tx = db.begin().await.unwrap();
    crate::connection::worker_query(&mut tx, move |worker| {
        Box::pin(async move {
            sqlx::query("INSERT INTO session_history_members VALUES(?,?,NULL)")
                .bind(&owner)
                .bind(sequence)
                .execute(&mut *worker)
                .await?;
            copy_member(worker, &owner, sequence, None).await
        })
    })
    .await
    .unwrap();
    tx.commit().await.unwrap();
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

fn observed(part: ModelPart) -> Fact {
    let event = ModelObservation::Part(ModelPartRecord {
        ordinal: 0,
        message_id: "message".into(),
        started_at: std::time::SystemTime::UNIX_EPOCH,
        provider_part_id: None,
        part: std::sync::Arc::new(part),
    });
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
        partial: None,
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
        observed(ModelPart::ToolCall {
            call: ModelToolCall {
                id: "call".into(),
                name: "exec".into(),
                input: serde_json::json!({}).into(),
                provider_options: None,
                provider_executed: false,
            },
        }),
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
async fn accepted_text_reads_canonical_part_without_extracted_body() {
    let mut db = database().await;
    opening(&mut db).await;
    let body = "中\"\n".repeat(40_000);
    append(
        &mut db,
        5,
        observed(ModelPart::Text {
            text_kind: TextKind::Thinking,
            text: body.clone().into(),
            provider_options: Some(serde_json::json!({"signature":{"first":1,"second":2}}).into()),
        }),
    )
    .await;
    append(&mut db, 6, interrupted("step")).await;
    let pieces: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_semantic_fragment_pieces WHERE source_sequence=5",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(pieces, 0);
    let storage: String = sqlx::query_scalar(
        "SELECT storage_kind FROM context_semantic_fragments WHERE source_sequence=5",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(storage, "canonical_model_part");
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
        matches!(&resolved[0].payload,Some(Payload::Part(ModelPart::Text { text,text_kind:TextKind::Thinking,provider_options:Some(options) })) if text.chunks().collect::<String>()==body && options.as_ref()==&serde_json::json!({"signature":{"first":1,"second":2}}))
    );
}

#[tokio::test]
async fn completion_refs_read_original_body_at_terminal_acceptance() {
    use maka_agent_facts::model::{
        ModelFinishReason, ModelUsage,
        recorded::{CompletionPart, ModelCompletion, RecordedPartRef},
    };
    let mut db = database().await;
    append(
        &mut db,
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
    let mut requested = request("step", 1);
    if let Fact::ModelRequested {
        item_acceptance, ..
    } = &mut requested
    {
        *item_acceptance = false;
    }
    append(&mut db, 2, requested).await;
    let evidence = append(
        &mut db,
        3,
        observed(ModelPart::ToolResult {
            id: "provider".into(),
            name: "search".into(),
            output: serde_json::json!({"body":"result"}),
            is_error: false,
            provider_options: None,
        }),
    )
    .await;
    assert_eq!(
        rows(&mut db, &selection(3), None, 10, None)
            .await
            .unwrap()
            .rows
            .len(),
        1
    );
    append(
        &mut db,
        4,
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelCompletion {
                parts: vec![
                    CompletionPart::Ref(RecordedPartRef {
                        event_id: evidence.id,
                        ordinal: 0,
                    }),
                    CompletionPart::Own(ModelPartRecord {
                        ordinal: 1,
                        message_id: "text".into(),
                        started_at: std::time::SystemTime::UNIX_EPOCH,
                        provider_part_id: None,
                        part: std::sync::Arc::new(ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: "answer".into(),
                            provider_options: None,
                        }),
                    }),
                ],
                finish_reason: ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    )
    .await;
    let page = rows(&mut db, &selection(4), None, 10, None).await.unwrap();
    let accepted: Vec<_> = page
        .rows
        .iter()
        .filter(|row| matches!(row.kind, SemanticKind::AssistantPart { .. }))
        .collect();
    assert_eq!(accepted.len(), 2);
    assert!(matches!(
        accepted[0].kind,
        SemanticKind::AssistantPart {
            accepted_at: 4,
            payload: PartPayload::Complete(RowPosition {
                source_sequence: 3,
                item_index: 0
            }),
            ..
        }
    ));
    assert_eq!(
        accepted[0].order,
        RowPosition {
            source_sequence: 4,
            item_index: 0
        }
    );
    assert_eq!(
        accepted[1].order,
        RowPosition {
            source_sequence: 4,
            item_index: 1
        }
    );
    let fragment_keys: Vec<(i64,i64)> = sqlx::query_as("SELECT source_sequence,source_index FROM context_semantic_fragments WHERE source_sequence>=3 ORDER BY source_sequence,source_index").fetch_all(&mut db).await.unwrap();
    assert_eq!(fragment_keys, vec![(3, 0), (4, 1)]);
    let pieces: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_semantic_fragment_pieces WHERE source_sequence>=3",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(pieces, 0);
    let resolved = resolve(&mut db, page.rows).await.unwrap();
    assert!(
        matches!(&resolved[1].payload, Some(Payload::Part(ModelPart::ToolResult { output, .. })) if output["body"] == "result")
    );
    assert!(
        matches!(&resolved[2].payload, Some(Payload::Part(ModelPart::Text { text, .. })) if text.to_string() == "answer")
    );
}

#[tokio::test]
async fn interrupted_partial_keeps_canonical_body_out_of_prompt_rows() {
    use maka_agent_facts::model::recorded::{CompletionPart, ModelPartial};
    let mut db = database().await;
    opening(&mut db).await;
    let mut terminal = interrupted("step");
    if let Fact::ModelInterrupted { partial, .. } = &mut terminal {
        *partial = Some(ModelPartial {
            parts: vec![CompletionPart::Own(ModelPartRecord {
                ordinal: 0,
                message_id: "partial".into(),
                started_at: std::time::SystemTime::UNIX_EPOCH,
                provider_part_id: Some("prose".into()),
                part: std::sync::Arc::new(ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: "visible partial".into(),
                    provider_options: None,
                }),
            })],
            tool_inputs: Vec::new(),
            response_id: None,
            model: None,
            timestamp: None,
        });
    }
    append(&mut db, 3, terminal).await;
    let page = rows(&mut db, &selection(3), None, 10, None).await.unwrap();
    assert_eq!(page.rows.len(), 1);
    assert!(matches!(page.rows[0].kind, SemanticKind::User { .. }));
    let partial = payload(
        &mut db,
        RowPosition {
            source_sequence: 3,
            item_index: 0,
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(partial, Payload::Part(ModelPart::Text { text, .. }) if text.to_string() == "visible partial")
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
                json_set(?3,'$.id.sourceSequence',n,'$.order.sourceSequence',n,'$.revision',n),semantic_directory(json_set(?3,'$.id.sourceSequence',n,'$.order.sourceSequence',n,'$.revision',n))
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
        // Exercise the production copy projector and its indexed lookups.
        insert_member(&mut db, child, through).await;
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
async fn tool_failure_unknown_and_hidden_success_keep_their_payload_boundaries() {
    for outcome in [
        ToolOutcome::Failed {
            message: "failed 中🦀".into(),
        },
        ToolOutcome::Unknown {
            message: "unknown 中🦀".into(),
            operation: None,
        },
    ] {
        let mut db = database().await;
        call(&mut db).await;
        append(&mut db, 5, interrupted("step")).await;
        let expected = match &outcome {
            ToolOutcome::Failed { message } | ToolOutcome::Unknown { message, .. } => {
                message.clone()
            }
            _ => unreachable!(),
        };
        append(
            &mut db,
            6,
            Fact::ToolSettled {
                operation_id: "step:call".into(),
                outcome,
            },
        )
        .await;
        let page = rows(&mut db, &selection(6), None, 20, None).await.unwrap();
        let resolved = resolve(&mut db, page.rows).await.unwrap();
        assert_eq!(
            resolved.last().unwrap().payload,
            Some(Payload::Text(expected))
        );
        assert!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM context_semantic_fragment_pieces WHERE source_sequence=6"
            )
            .fetch_one(&mut db)
            .await
            .unwrap()
                > 0
        );
        append(
            &mut db,
            7,
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "hidden".into(),
                call: ToolCallIdentity::standalone("hidden".into()),
                name: "hidden".into(),
                input: serde_json::json!({}),
            },
        )
        .await;
        append(
            &mut db,
            8,
            Fact::ToolSettled {
                operation_id: "hidden".into(),
                outcome: ToolOutcome::Succeeded {
                    raw: RawToolResultRef {
                        bytes: 1,
                        digest: "fixture".into(),
                    },
                    model_projection: DurableToolProjection::Text {
                        text: "hidden projection".into(),
                    },
                    artifacts: Vec::new(),
                },
            },
        )
        .await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM context_semantic_fragments WHERE source_sequence=8"
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            0,
            "hidden success has no semantic payload source"
        );
        let after = rows(&mut db, &selection(8), None, 20, None).await.unwrap();
        let after = resolve(&mut db, after.rows).await.unwrap();
        assert_eq!(after.len(), resolved.len());
        assert_eq!(
            after.last().unwrap().payload,
            resolved.last().unwrap().payload
        );
    }
}

#[tokio::test]
async fn archive_revisions_preserve_old_views_and_copied_payload_identity() {
    let mut db = database().await;
    call(&mut db).await;
    append(&mut db, 5, interrupted("step")).await;
    let projection = DurableToolProjection::Text {
        text: "中🦀\"\n\\ {\"model_projection\":\"decoy\"} ".repeat(2_000),
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
    let canonical = serde_json::to_string(&result).unwrap();
    assert!(canonical.len() > 32 * 1024);
    let stored_json: String =
        sqlx::query_scalar("SELECT event_json FROM event_log WHERE sequence=6")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(stored_json, canonical);
    let pieces: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_semantic_fragment_pieces WHERE source_sequence=6",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(
        pieces, 0,
        "successful projection must not duplicate its canonical body"
    );
    let frozen = selection(6);
    // Freeze a descendant before the parent archives the original result.
    sqlx::query("INSERT INTO session_history_copies VALUES('child','session',6,6)")
        .execute(&mut db)
        .await
        .unwrap();
    for sequence in 1..=6 {
        insert_member(&mut db, "child", sequence).await;
    }
    let placeholder = maka_agent_facts::archive::ArchivedPlaceholder::prepare(
        result.id,
        "call".into(),
        "exec".into(),
        &projection,
    )
    .unwrap()
    .unwrap();
    let archived_projection = placeholder.to_canonical_projection().unwrap();
    append(&mut db, 7, Fact::ToolResultArchived { placeholder }).await;
    let archived_pieces: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_semantic_fragment_pieces WHERE source_sequence=7",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert!(
        archived_pieces > 0,
        "archive placeholder has its own derived body"
    );
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
    for source_rows in [old.rows, copied.rows] {
        let resolved = resolve(&mut db, source_rows).await.unwrap();
        assert_eq!(
            resolved.last().unwrap().payload,
            Some(Payload::Tool(projection.clone()))
        );
    }
    let archived = resolve(&mut db, new.rows).await.unwrap();
    assert_eq!(
        archived.last().unwrap().payload,
        Some(Payload::Tool(archived_projection))
    );
    let changed = changes(&mut db, &current, 6, None, 20).await.unwrap();
    assert!(
        changed
            .changes
            .iter()
            .any(|change| change.order.source_sequence == 6)
    );
    gc::retire_owner(&mut db, "session").await.unwrap();
    let copied = rows(&mut db, &child, None, 20, None).await.unwrap();
    let retained = resolve(&mut db, copied.rows).await.unwrap();
    assert_eq!(
        retained.last().unwrap().payload,
        Some(Payload::Tool(projection))
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT event_json FROM event_log WHERE sequence=6")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        canonical
    );
    gc::retire_owner(&mut db, "child").await.unwrap();
    for sequence in [6, 7] {
        gc::collect_event(&mut db, sequence).await.unwrap();
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM context_semantic_fragments WHERE source_sequence IN (6,7)"
        )
        .fetch_one(&mut db)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn typed_children_keep_actual_ranges_and_follow_shared_source_lifetime() {
    use maka_agent_facts::history::semantic::directory::{
        ChildDirectory, PayloadDirectory, ToolDirectory, ToolPartDirectory,
    };
    use maka_agent_facts::tool_output::ProjectionPart;
    use sha2::{Digest, Sha256};
    let mut db = database().await;
    call(&mut db).await;
    append(&mut db, 5, interrupted("step")).await;
    let text = "中🦀\"\n\\".repeat(12_000);
    let event = append(
        &mut db,
        6,
        Fact::ToolSettled {
            operation_id: "step:call".into(),
            outcome: ToolOutcome::Succeeded {
                raw: RawToolResultRef {
                    bytes: 1,
                    digest: "fixture".into(),
                },
                model_projection: DurableToolProjection::Content {
                    parts: vec![
                        ProjectionPart::Text { text: text.clone() },
                        ProjectionPart::Text {
                            text: "tail".into(),
                        },
                    ],
                },
                artifacts: Vec::new(),
            },
        },
    )
    .await;
    let encoded = serde_json::to_vec(&event).unwrap();
    let (offset,bytes,header):(i64,i64,String)=sqlx::query_as("SELECT byte_offset,payload_bytes,directory_json FROM context_semantic_fragments WHERE source_sequence=6 AND source_index=0").fetch_one(&mut db).await.unwrap();
    assert!(matches!(
        serde_json::from_str::<PayloadDirectory>(&header).unwrap(),
        PayloadDirectory::Tool(ToolDirectory::Content { parts: 2 })
    ));
    let children:Vec<String>=sqlx::query_scalar("SELECT directory_json FROM context_semantic_directory_children WHERE source_sequence=6 AND source_index=0 AND list_kind='tool_parts' ORDER BY ordinal").fetch_all(&mut db).await.unwrap();
    let ChildDirectory::ToolPart(ToolPartDirectory::Text(span)) =
        serde_json::from_str(&children[0]).unwrap()
    else {
        panic!("text child")
    };
    let start = offset as usize + span.range.start as usize;
    let end = start + span.range.len as usize;
    assert!(span.range.start + span.range.len <= bytes as u64);
    assert_eq!(
        serde_json::from_slice::<String>(&encoded[start..end]).unwrap(),
        text
    );
    assert_eq!(span.measure.bytes, text.len() as u64);
    assert_eq!(
        span.measure.sha256,
        <[u8; 32]>::from(Sha256::digest(text.as_bytes()))
    );
    sqlx::query("INSERT INTO session_history_copies VALUES('child','session',6,6)")
        .execute(&mut db)
        .await
        .unwrap();
    for sequence in 1..=6 {
        insert_member(&mut db, "child", sequence).await;
    }
    gc::retire_owner(&mut db, "session").await.unwrap();
    let child = SemanticSelection {
        session: "child".into(),
        ..selection(6)
    };
    assert!(
        rows(&mut db, &child, None, 20, None)
            .await
            .unwrap()
            .rows
            .iter()
            .any(|row| row.id.source_sequence == 6)
    );
    let retained:Vec<String>=sqlx::query_scalar("SELECT directory_json FROM context_semantic_directory_children WHERE source_sequence=6 AND source_index=0 AND list_kind='tool_parts' ORDER BY ordinal").fetch_all(&mut db).await.unwrap();
    assert_eq!(retained, children);
    gc::retire_owner(&mut db, "child").await.unwrap();
    gc::collect_event(&mut db, 6).await.unwrap();
    assert!(!sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM context_semantic_directory_children WHERE source_sequence=6)").fetch_one(&mut db).await.unwrap());
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
        observed(ModelPart::Text {
            text: "body".into(),
            text_kind: TextKind::Text,
            provider_options: None,
        }),
    )
    .await;
    let unavailable: i64 = sqlx::query_scalar(
        "SELECT unavailable_at FROM context_semantic_heads WHERE session_id='session'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(unavailable, 3);
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
        insert_member(&mut db, "child", sequence).await;
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
        insert_member(&mut db, "child", sequence).await;
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
    assert!(
        matches!(result, Err(StoreError::Sqlx(sqlx::Error::Database(ref error)))
        if error.message() == "injected storage failure"),
        "fragment serialization must preserve the original storage error: {result:?}"
    );
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
                details.iter().any(|detail| detail.starts_with("SEARCH ")
                    && detail.contains("owner_session_id=? AND source_sequence>?")),
                "whole-window page must seek by source before ordering: {details:?}"
            );
        }
    }
}

#[tokio::test]
async fn imported_conversation_counts_as_new_compaction_history_but_covered_rows_do_not() {
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
                ..selection(3)
            }
        )
        .await
        .unwrap(),
        "covered user history and a ledger note do not create new conversation history"
    );
}

#[tokio::test]
async fn stable_changes_page_latest_revisions_from_the_current_source_cursor() {
    let mut db = database().await;
    let row = SemanticRow {
        id: RowPosition {
            source_sequence: 10,
            item_index: 0,
        },
        revision: 10,
        invocation: invocation(),
        order: RowPosition {
            source_sequence: 101,
            item_index: 0,
        },
        kind: SemanticKind::AssistantPart {
            step_id: "step".into(),
            model_id: "model".into(),
            route_identity: "route".into(),
            accepted_at: 10,
            index: 0,
            payload: PartPayload::Complete(RowPosition {
                source_sequence: 10,
                item_index: 0,
            }),
        },
    };
    sqlx::query(
        "WITH RECURSIVE items(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM items WHERE n<299),
        versions(v) AS (VALUES(1),(2),(3))
        INSERT INTO context_semantic_rows
        SELECT 'session',10,n,v*10,100+v,n,'invocation','invocation','part-'||n,
            CASE WHEN n=200 AND v=3 THEN 'user' ELSE 'assistant_part' END,
            0,v=3,1,0,json_set(?1,'$.id.itemIndex',n,'$.revision',v*10,
                '$.order.sourceSequence',100+v,'$.order.itemIndex',n),semantic_directory(json_set(?1,'$.id.itemIndex',n,'$.revision',v*10,'$.order.sourceSequence',100+v,'$.order.itemIndex',n))
        FROM items CROSS JOIN versions",
    )
    .bind(serde_json::to_string(&row).unwrap())
    .execute(&mut db)
    .await
    .unwrap();
    let plan = sqlx::query(sqlx::AssertSqlSafe(format!(
        "EXPLAIN QUERY PLAN {}",
        write::STABLE_CHANGES_SQL
    )))
    .bind("session")
    .bind("invocation")
    .bind(10i64)
    .bind(132i64)
    .bind(30i64)
    .bind(10i64)
    .bind(290i64)
    .bind(128i64)
    .fetch_all(&mut db)
    .await
    .unwrap();
    let details: Vec<String> = plan.iter().map(|row| row.get("detail")).collect();
    assert!(
        details
            .iter()
            .any(|detail| detail.starts_with("SEARCH r USING ")
                && detail.contains("owner_session_id=?")
                && detail.contains("(source_sequence,source_index,revision)>(?,?,?)")),
        "each page must seek the current revision cursor: {details:?}"
    );
    assert!(
        !details.iter().any(|detail| detail.contains("TEMP B-TREE")),
        "source-key order must use the index: {details:?}"
    );
    let mut previous = 0_i64;
    let mut work = Vec::new();
    for history in [128_i64, 16_384] {
        use std::sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        };
        sqlx::query("WITH RECURSIVE items(n) AS (VALUES(?1) UNION ALL SELECT n+1 FROM items WHERE n<?2)
            INSERT INTO context_semantic_rows SELECT 'session',9,n,1,9,n,'invocation','invocation','earlier-'||n,
                'assistant_part',0,0,1,0,json_set(?3,'$.id.sourceSequence',9,'$.id.itemIndex',n,'$.revision',1,'$.order.sourceSequence',9,'$.order.itemIndex',n),semantic_directory(json_set(?3,'$.id.sourceSequence',9,'$.id.itemIndex',n,'$.revision',1,'$.order.sourceSequence',9,'$.order.itemIndex',n))
            FROM items")
            .bind(previous+1).bind(history).bind(serde_json::to_string(&row).unwrap()).execute(&mut db).await.unwrap();
        let steps = Arc::new(AtomicU64::new(0));
        let observed = steps.clone();
        db.lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                observed.fetch_add(1, Ordering::Relaxed);
                true
            });
        let page = sqlx::query(write::STABLE_CHANGES_SQL)
            .bind("session")
            .bind("invocation")
            .bind(10_i64)
            .bind(132_i64)
            .bind(30_i64)
            .bind(10_i64)
            .bind(290_i64)
            .bind(128_i64)
            .fetch_all(&mut db)
            .await;
        db.lock_handle().await.unwrap().remove_progress_handler();
        let keys = page
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row.get::<i64, _>(0),
                    row.get::<i64, _>(1),
                    row.get::<i64, _>(2),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            (133..=261)
                .filter(|index| *index != 200)
                .map(|index| (10, index, 30))
                .collect::<Vec<_>>()
        );
        work.push(steps.load(Ordering::Relaxed));
        previous = history;
    }
    assert!(
        work[1] <= work[0] * 2,
        "fixed revision page scanned earlier source history: {work:?}"
    );
    let stored = StoredEvent {
        sequence: 1000,
        event: RuntimeEvent::new(invocation(), interrupted("step")),
    };
    crate::connection::worker_query(&mut db, move |worker| {
        Box::pin(async move {
            write::stable_changes(
                worker,
                &stored,
                Some(RowPosition {
                    source_sequence: 10,
                    item_index: 5,
                }),
                RowPosition {
                    source_sequence: 10,
                    item_index: 290,
                },
            )
            .await
        })
    })
    .await
    .unwrap();
    let changed: Vec<(i64,i64,i64,bool,bool)> = sqlx::query_as(
        "SELECT source_index,order_sequence,revision,inherited,deleted FROM context_semantic_changes ORDER BY change_id")
        .fetch_all(&mut db).await.unwrap();
    let expected: Vec<_> = (5..290)
        .filter(|index| *index != 200)
        .map(|index| (index, 103, 1000, true, false))
        .collect();
    assert_eq!(
        changed, expected,
        "cross-page projection uses each latest row once and preserves both source boundaries"
    );
}

#[tokio::test]
async fn reopening_notifications_pages_latest_sources_without_losing_pending_rows() {
    let mut db = database().await;
    opening(&mut db).await;
    let row = SemanticRow {
        id: RowPosition {
            source_sequence: 10,
            item_index: 0,
        },
        revision: 110,
        invocation: invocation(),
        order: RowPosition {
            source_sequence: 110,
            item_index: 0,
        },
        kind: SemanticKind::Notification {
            call_id: "call".into(),
            custom: false,
            payload: RowPosition {
                source_sequence: 10,
                item_index: 0,
            },
        },
    };
    sqlx::query(
        "WITH RECURSIVE items(n) AS (SELECT 10 UNION ALL SELECT n+1 FROM items WHERE n<309),
        versions(v) AS (VALUES(1),(2))
        INSERT INTO context_semantic_rows
        SELECT 'session',n,0,n+v*100,n+v*100,0,'invocation','invocation','notification-'||n,
            'notification',0,v=2,1,0,json_set(?1,'$.id.sourceSequence',n,'$.revision',n+v*100,
                '$.order.sourceSequence',n+v*100),semantic_directory(json_set(?1,'$.id.sourceSequence',n,'$.revision',n+v*100,'$.order.sourceSequence',n+v*100))
        FROM items CROSS JOIN versions",
    )
    .bind(serde_json::to_string(&row).unwrap())
    .execute(&mut db)
    .await
    .unwrap();
    append(&mut db, 1000, request("retry", 100)).await;
    let hidden: Vec<(i64,i64,bool)> = sqlx::query_as(
        "SELECT source_sequence,revision,visible FROM context_semantic_rows WHERE revision=1000 AND kind='notification' ORDER BY source_sequence")
        .fetch_all(&mut db).await.unwrap();
    let expected: Vec<_> = (101..310).map(|sequence| (sequence, 1000, false)).collect();
    assert_eq!(
        hidden, expected,
        "each notification beyond the request cut must reopen once across pages"
    );
    let previous: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_semantic_rows r WHERE r.kind='notification' AND r.source_sequence<=100 AND r.visible=1
            AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
                AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision)")
        .fetch_one(&mut db).await.unwrap();
    assert_eq!(
        previous, 91,
        "the inclusive observed source cut stays visible"
    );
    let frontier: String = sqlx::query_scalar(
        "SELECT frontier_json FROM context_semantic_frontiers WHERE invocation_id='invocation'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    let frontier: maka_agent_facts::history::semantic::Frontier =
        serde_json::from_str(&frontier).unwrap();
    let pending: Vec<_> = frontier
        .notifications
        .iter()
        .map(|pending| pending.row.id.source_sequence)
        .collect();
    assert_eq!(
        pending,
        (101..310).collect::<Vec<_>>(),
        "reopened locators survive all database pages"
    );
}

mod selected_rows {
    use super::*;
    fn user(source: u64, revision: u64, order: u64) -> SemanticRow {
        let id = RowPosition {
            source_sequence: source,
            item_index: 0,
        };
        SemanticRow {
            id,
            revision,
            invocation: invocation(),
            order: RowPosition {
                source_sequence: order,
                item_index: 0,
            },
            kind: SemanticKind::User {
                payload: id,
                steering: false,
            },
        }
    }

    async fn insert(db: &mut SqliteConnection, row: &SemanticRow) {
        let kind = match &row.kind {
            SemanticKind::User { .. } => "user",
            SemanticKind::ToolResult { .. } => "tool_result",
            SemanticKind::UnknownTool { .. } => "unknown_tool",
            SemanticKind::AssistantPart { .. } => "assistant_part",
            other => panic!("unsupported selected-row fixture kind: {other:?}"),
        };
        sqlx::query("INSERT INTO context_semantic_rows VALUES('session',?,0,?,?,0,?,?,'selected-row-fixture',?,0,0,1,0,?,?)")
            .bind(row.id.source_sequence as i64)
            .bind(row.revision as i64)
            .bind(row.order.source_sequence as i64)
            .bind(&row.invocation.invocation_id)
            .bind(&row.invocation.invocation_id)
            .bind(kind)
            .bind(serde_json::to_string(row).unwrap())
            .bind(serde_json::to_string(&super::super::directory::row(&serde_json::to_string(row).unwrap()).unwrap()).unwrap())
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn selected_rows_preserve_source_selection_and_revision_filters() {
        let mut db = database().await;
        insert(&mut db, &user(1, 1, 1)).await;
        insert(&mut db, &user(2, 2, 2)).await;
        let mut late = user(11, 11, 3);
        late.kind = SemanticKind::ToolResult {
            operation_id: "operation".into(),
            call_id: "call".into(),
            name: "exec".into(),
            custom: false,
            payload: late.id,
            is_error: false,
            archived: false,
        };
        insert(&mut db, &late).await;
        insert(&mut db, &user(12, 12, 20)).await;
        let mut unknown = user(13, 13, 20);
        unknown.kind = SemanticKind::UnknownTool {
            operation_id: "unknown".into(),
            call_id: "unknown".into(),
            name: "exec".into(),
            custom: false,
        };
        insert(&mut db, &unknown).await;
        insert(&mut db, &user(14, 14, 19)).await;
        insert(&mut db, &user(15, 15, 22)).await;
        insert(&mut db, &user(15, 18, 22)).await;
        sqlx::query(
            "UPDATE context_semantic_rows SET visible=0 WHERE source_sequence=14 OR revision=18",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("UPDATE context_semantic_rows SET archived=1 WHERE revision=18")
            .execute(&mut db)
            .await
            .unwrap();
        let mut assistant = user(16, 16, 23);
        assistant.invocation.invocation_id = "other".into();
        assistant.kind = SemanticKind::AssistantPart {
            step_id: "step".into(),
            model_id: "model".into(),
            route_identity: "route".into(),
            accepted_at: 16,
            index: 0,
            payload: PartPayload::Complete(assistant.id),
        };
        insert(&mut db, &assistant).await;
        insert(&mut db, &user(17, 17, 24)).await;

        let selected = SemanticSelection {
            after: 10,
            captured_through: 18,
            before: 19,
            ..selection(16)
        };
        // An eligible newer invisible archive hides its old visible revision.
        // A newer publication outside the capture must leave that old row visible.
        for (captured, before, unknown, replay, expected) in [
            (16, 19, false, false, vec![11, 12, 15, 16]),
            (18, 18, false, false, vec![11, 12, 15, 16]),
            (18, 19, false, false, vec![11, 12, 16]),
            (18, 19, true, false, vec![11, 12, 13, 16]),
            (18, 19, true, true, vec![11, 12, 13]),
        ] {
            let selected = SemanticSelection {
                captured_through: captured,
                before,
                prior_unknown: unknown,
                replay: replay.then(|| SemanticReplay {
                    base: 0,
                    current: "invocation".into(),
                    route: "route".into(),
                    model: "model".into(),
                }),
                ..selected.clone()
            };
            let candidates = rows(&mut db, &selected, None, 64, None).await.unwrap().rows;
            assert_eq!(
                candidates
                    .iter()
                    .map(|row| row.id.source_sequence)
                    .collect::<Vec<_>>(),
                expected,
                "capture={captured}, unknown={unknown}, replay={replay}"
            );
        }

        insert(&mut db, &user(18, 18, 25)).await;
        sqlx::query(
            "UPDATE context_semantic_rows SET row_json='invalid JSON' WHERE source_sequence=18",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(
            rows(&mut db, &selection(18), None, 64, None).await.is_err(),
            "selected-row decoding must preserve malformed projection errors"
        );
    }
}
