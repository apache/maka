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
use maka_agent_facts::event::CommitError;
use maka_agent_facts::{
    event::{Fact, Invocation, InvocationInput, LogScope, RuntimeEvent},
    model::{
        ModelFinishReason, ModelPart, TextKind,
        recorded::{
            CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, ModelPartial,
            RecordedPartRef,
        },
    },
};
use std::sync::{Arc, atomic::Ordering};
use std::{sync::atomic::AtomicUsize, time::Duration};
use tokio::sync::oneshot;

fn event(id: &str, fact: Fact) -> EventWrite {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    );
    event.id = id.into();
    EventWrite::plain(event).unwrap()
}

fn metadata(id: &str, text: &str) -> EventWrite {
    event(
        id,
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::ProviderOptions {
                provider_part_id: Some("provider-part".into()),
                options: Arc::new(serde_json::json!({"evidence": text})),
            },
        },
    )
}

fn finished(id: &str) -> EventWrite {
    event(
        id,
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::Finished {
                reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
            },
        },
    )
}

fn text_record(id: &str, text: &str) -> ModelPartRecord {
    ModelPartRecord {
        ordinal: 0,
        message_id: format!("{id}-text"),
        started_at: std::time::UNIX_EPOCH,
        provider_part_id: Some("provider-part".into()),
        part: Arc::new(ModelPart::Text {
            text_kind: TextKind::Text,
            text: text.into(),
            provider_options: None,
        }),
    }
}

fn completion(id: &str, text: &str) -> EventWrite {
    completed_parts(id, vec![CompletionPart::Own(text_record(id, text))])
}

fn completed_parts(id: &str, parts: Vec<CompletionPart>) -> EventWrite {
    event(
        id,
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelCompletion {
                compaction: None,
                parts,
                finish_reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    )
}

async fn open(path: &std::path::Path) -> Arc<EventLog> {
    let log = Arc::new(EventLog::open(path).await.unwrap());
    log.append_batch(&[
        event(
            "opened",
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: vec![],
                    content: "user".into(),
                    request_fingerprint: None,
                },
            },
        ),
        event(
            "requested",
            Fact::ModelRequested {
                source_capture: maka_agent_facts::event::SourceCapture {
                    publication_watermark: 0,
                    prior_unknown: false,
                },
                context_breakdown: None,
                item_acceptance: true,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "model".into(),
                source_scope: LogScope::Root,
                source_high_water: 0,
                source_digest: "source".into(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            },
        ),
        event(
            "metadata",
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelObservation::ResponseMetadata {
                    id: Some("response".into()),
                    model: None,
                    timestamp: None,
                },
            },
        ),
    ])
    .await
    .unwrap();
    log
}

async fn gate(log: &Arc<EventLog>) -> (oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let (entered, reached) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let log = log.clone();
    let job = tokio::spawn(async move {
        log.connection
            .run(move |_| {
                entered.send(()).unwrap();
                gate.blocking_recv().unwrap();
                Ok(())
            })
            .await
            .unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    (release, job)
}

async fn hook(log: &EventLog, mut callback: impl FnMut() -> bool + Send + 'static) {
    log.connection
        .run(move |db| {
            db.commit_hook(Some(move || !callback())).unwrap();
            Ok(())
        })
        .await
        .unwrap();
}

fn ids(path: &std::path::Path) -> Vec<String> {
    let db = rusqlite::Connection::open(path).unwrap();
    db.prepare("SELECT event_id FROM runtime_events ORDER BY sequence")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[tokio::test]
async fn neighbors_share_commit_and_isolate_bad_batch_and_conflicting_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    hook(&log, move || {
        observed.fetch_add(1, Ordering::SeqCst);
        true
    })
    .await;
    let before_failures = log.connection.writer().failures();
    let (release, gate) = gate(&log).await;
    let first = [metadata("first", "one")];
    let bad = [
        metadata("rolled-back", "bad prefix"),
        event(
            "bad-tail",
            Fact::ModelObserved {
                step_id: "missing".into(),
                event: ModelObservation::ResponseMetadata {
                    id: Some("bad tail".into()),
                    model: None,
                    timestamp: None,
                },
            },
        ),
    ];
    let conflict = [metadata("first", "different")];
    let last = [metadata("last", "two")];
    let mut a = Box::pin(log.append_batch(&first));
    let mut b = Box::pin(log.append_batch(&bad));
    let mut replay = Box::pin(log.append_batch(&first));
    let mut c = Box::pin(log.append_batch(&conflict));
    let mut d = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    assert!(futures_util::poll!(&mut replay).is_pending());
    assert!(futures_util::poll!(&mut c).is_pending());
    assert!(futures_util::poll!(&mut d).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    assert_eq!(a.await.unwrap(), [4]);
    assert!(matches!(b.await, Err(CommitError::Rejected(_))));
    assert_eq!(replay.await.unwrap(), [4]);
    assert!(matches!(c.await, Err(CommitError::Rejected(_))));
    assert_eq!(d.await.unwrap(), [5]);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(log.connection.writer().failures() - before_failures, 2);
    assert_eq!(
        ids(&path),
        ["opened", "requested", "metadata", "first", "last"]
    );
    assert_projection_positions(&path);
    let mut commits = log.subscribe_commits();
    commits.borrow_and_update();
    assert_eq!(log.append_batch(&first).await.unwrap(), [4]);
    assert!(!commits.has_changed().unwrap());
    assert_eq!(*commits.borrow(), 5);
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "replay has no durable write"
    );
    log.connection.shutdown().await.unwrap();
}

#[tokio::test]
async fn queued_model_boundaries_share_commit_and_keep_checkpoint_proof_rejection() {
    for interrupted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = open(&path).await;
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let (entered, reached) = oneshot::channel();
        let mut entered = Some(entered);
        let (release_commit, commit_gate) = std::sync::mpsc::channel();
        hook(&log, move || {
            observed.fetch_add(1, Ordering::SeqCst);
            if let Some(entered) = entered.take() {
                entered.send(()).unwrap();
                commit_gate.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            true
        })
        .await;
        let (release, blocked) = gate(&log).await;
        let first = [
            event(
                "observed",
                Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelObservation::Part(text_record("observed", "one")),
                },
            ),
            finished("finished"),
        ];
        let reference = RecordedPartRef {
            event_id: "observed".into(),
            ordinal: 0,
        };
        let invalid_reference = completed_parts(
            "invalid-reference",
            vec![CompletionPart::Ref(RecordedPartRef {
                event_id: "observed".into(),
                ordinal: 1,
            })],
        );
        let late = event(
            "late-checkpoint",
            Fact::ModelRequested {
                source_capture: maka_agent_facts::event::SourceCapture {
                    publication_watermark: 0,
                    prior_unknown: false,
                },
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: Some("missing-checkpoint".into()),
                step_id: "late-step".into(),
                model_id: "model".into(),
                source_scope: LogScope::Session {
                    id: "session".into(),
                },
                source_high_water: 0,
                source_digest: "source".into(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            },
        );
        let boundary = if interrupted {
            event(
                "boundary",
                Fact::ModelInterrupted {
                    partial: Some(ModelPartial {
                        parts: vec![CompletionPart::Ref(reference.clone())],
                        tool_inputs: Vec::new(),
                        response_id: None,
                        model: None,
                        timestamp: None,
                    }),
                    step_id: "step".into(),
                    status: maka_agent_facts::event::ModelInterruption::Failed,
                    diagnostic: None,
                    model_failure: None,
                },
            )
        } else {
            completed_parts("boundary", vec![CompletionPart::Ref(reference)])
        };
        let mut first = Box::pin(log.append_batch(&first));
        let mut late = Box::pin(log.append(&late));
        let mut invalid_reference = Box::pin(log.append(&invalid_reference));
        let mut boundary = Box::pin(log.append(&boundary));
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut late).is_pending());
        assert!(futures_util::poll!(&mut invalid_reference).is_pending());
        assert!(futures_util::poll!(&mut boundary).is_pending());
        let mut commits = log.subscribe_commits();
        commits.borrow_and_update();
        release.send(()).unwrap();
        blocked.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), reached)
            .await
            .unwrap()
            .unwrap();
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut late).is_pending());
        assert!(futures_util::poll!(&mut invalid_reference).is_pending());
        assert!(futures_util::poll!(&mut boundary).is_pending());
        assert!(!commits.has_changed().unwrap());
        assert_eq!(ids(&path), ["opened", "requested", "metadata"]);
        release_commit.send(()).unwrap();
        assert_eq!(first.await.unwrap(), [4, 5]);
        assert!(
            matches!(late.await, Err(CommitError::Rejected(reason)) if reason.contains("missing request baseline"))
        );
        assert!(matches!(
            invalid_reference.await,
            Err(CommitError::Rejected(_))
        ));
        assert_eq!(boundary.await.unwrap(), 6);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(
            ids(&path),
            [
                "opened",
                "requested",
                "metadata",
                "observed",
                "finished",
                "boundary"
            ]
        );
        assert_projection_positions(&path);
        log.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn savepoint_failures_roll_back_the_group_and_allow_later_operations() {
    unsafe extern "C" fn deny_savepoint(
        mode: *mut std::ffi::c_void,
        action: std::ffi::c_int,
        operation: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
    ) -> std::ffi::c_int {
        if action == rusqlite::ffi::SQLITE_SAVEPOINT && !operation.is_null() {
            // SAFETY: SQLite supplies a callback-local NUL-terminated operation.
            let operation = unsafe { std::ffi::CStr::from_ptr(operation) }.to_bytes();
            let denied = if mode as usize == 1 {
                b"RELEASE".as_slice()
            } else {
                b"ROLLBACK".as_slice()
            };
            if operation == denied {
                return rusqlite::ffi::SQLITE_DENY;
            }
        }
        rusqlite::ffi::SQLITE_OK
    }
    for mode in [1_usize, 2] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = open(&path).await;
        log.connection
            .run(move |db| {
                {
                    // SAFETY: static callback; mode is an integer tag, never dereferenced.
                    // The exclusive handle is borrowed only for installing SQLite's authorizer.
                    assert_eq!(
                        unsafe {
                            rusqlite::ffi::sqlite3_set_authorizer(
                                db.handle(),
                                Some(deny_savepoint),
                                mode as *mut std::ffi::c_void,
                            )
                        },
                        rusqlite::ffi::SQLITE_OK
                    );
                    Ok(())
                }
            })
            .await
            .unwrap();
        let (release, gate) = gate(&log).await;
        let first = [metadata("first", "one")];
        let bad = [
            metadata("rolled-back", "prefix"),
            metadata("metadata", "conflict"),
        ];
        let last = [metadata("last", "two")];
        let mut a = Box::pin(log.append_batch(&first));
        let mut b = Box::pin(log.append_batch(&bad));
        let mut c = Box::pin(log.append_batch(&last));
        assert!(futures_util::poll!(&mut a).is_pending());
        assert!(futures_util::poll!(&mut b).is_pending());
        assert!(futures_util::poll!(&mut c).is_pending());
        let mut control = Box::pin(log.connection.run::<()>(|db| {
            // SAFETY: this original connection owns the callback; removing it
            // prevents the injected authorizer from affecting the recovery write.
            let result = unsafe {
                rusqlite::ffi::sqlite3_set_authorizer(db.handle(), None, std::ptr::null_mut())
            };
            assert_eq!(result, rusqlite::ffi::SQLITE_OK);
            Ok(())
        }));
        assert!(futures_util::poll!(&mut control).is_pending());
        release.send(()).unwrap();
        gate.await.unwrap();
        for result in [a.await, b.await, c.await] {
            assert!(
                matches!(result, Err(CommitError::Rejected(_))),
                "outer rollback confirmed: {result:?}"
            );
        }
        control.await.unwrap();
        assert_eq!(ids(&path), ["opened", "requested", "metadata"]);
        assert_eq!(log.append_batch(&first).await.unwrap(), [4]);
        log.shutdown().await.unwrap();
        assert_eq!(ids(&path), ["opened", "requested", "metadata", "first"]);
    }
}

#[tokio::test]
async fn sqlite_automatic_rollback_rejects_the_group_and_allows_later_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    log.connection.run(|db| {
        db.execute_batch("CREATE TEMP TRIGGER rollback_observation BEFORE INSERT ON event_log
            WHEN NEW.event_id='poison' BEGIN SELECT RAISE(ROLLBACK, 'injected storage failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let (release, gate) = gate(&log).await;
    let first = [metadata("first", "one")];
    let poison = [metadata("poison", "two")];
    let last = [metadata("last", "three")];
    let mut a = Box::pin(log.append_batch(&first));
    let mut b = Box::pin(log.append_batch(&poison));
    let mut c = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    assert!(futures_util::poll!(&mut c).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    for result in [a.await, b.await, c.await] {
        assert!(
            matches!(result, Err(CommitError::Rejected(_))),
            "automatic rollback confirmed: {result:?}"
        );
    }
    assert_eq!(ids(&path), ["opened", "requested", "metadata"]);
    assert_eq!(log.append_batch(&first).await.unwrap(), [4]);
    assert_eq!(log.append_batch(&last).await.unwrap(), [5]);
    log.connection.shutdown().await.unwrap();
    assert_eq!(
        ids(&path),
        ["opened", "requested", "metadata", "first", "last"]
    );
}

#[tokio::test]
async fn projection_sql_fault_preserves_database_codes_and_rolls_back_all_neighbors() {
    let tool_poison = || {
        event(
            "poison",
            Fact::ToolDispatched {
                operation_id: "poison".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("call".into()),
                name: "Read".into(),
                input: serde_json::json!({}),
                presentation: None,
                title: None,
            },
        )
    };
    for (trigger, poison_event) in [
        (
            "CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON context_source_prefixes
         WHEN NEW.sequence=5 AND NEW.kind='session'
         BEGIN SELECT RAISE(ABORT,'projection storage fault'); END;",
            metadata("poison", "two"),
        ),
        (
            "CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON context_source_prefixes
         WHEN NEW.sequence=5 AND NEW.kind='invocation'
         BEGIN SELECT RAISE(ABORT,'projection storage fault'); END;",
            metadata("poison", "two"),
        ),
        (
            "CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON context_obligations
         WHEN NEW.kind='tool' AND NEW.operation_id='poison'
         BEGIN SELECT RAISE(ABORT,'projection storage fault'); END;",
            tool_poison(),
        ),
        (
            "CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON context_execution_work
         WHEN NEW.kind='tool' AND NEW.operation_id='poison'
         BEGIN SELECT RAISE(ABORT,'projection storage fault'); END;",
            tool_poison(),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = open(&path).await;
        log.connection
            .run(move |db| {
                db.execute_batch(trigger)?;
                Ok(())
            })
            .await
            .unwrap();
        let (release, blocked) = gate(&log).await;
        // Inspect the same typed receipts before EventSink intentionally maps
        // storage errors into its string-bearing CommitError API.
        let first_event = metadata("first", "one");
        let mut first = Box::pin(log.connection.write(
            WriteAppend::from_events(std::slice::from_ref(&first_event)).unwrap(),
            log.commits.session("session"),
        ));
        let mut poison = Box::pin(log.connection.write(
            WriteAppend::from_events(&[poison_event]).unwrap(),
            log.commits.session("session"),
        ));
        let mut last = Box::pin(log.connection.write(
            WriteAppend::from_events(&[completion("completed", "one")]).unwrap(),
            log.commits.session("session"),
        ));
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut poison).is_pending());
        assert!(futures_util::poll!(&mut last).is_pending());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let mut control = Box::pin(log.connection.run(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        assert!(futures_util::poll!(&mut control).is_pending());
        let mut commits = log.subscribe_commits();
        commits.borrow_and_update();
        release.send(()).unwrap();
        blocked.await.unwrap();
        for result in [first.await, poison.await, last.await] {
            let error = result.unwrap_err();
            let StoreError::Sqlite(error) = error.underlying() else {
                panic!("projection must retain SQLite database error")
            };
            let rusqlite::Error::SqliteFailure(code, message) = error else {
                panic!("expected SQLite failure")
            };
            assert_eq!(code.code, rusqlite::ErrorCode::ConstraintViolation);
            assert_eq!(message.as_deref(), Some("projection storage fault"));
        }
        control.await.unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "confirmed rollback must permit the pending control"
        );
        assert!(!commits.has_changed().unwrap());
        assert_eq!(ids(&path), ["opened", "requested", "metadata"]);
        assert_projection_positions(&path);
        assert_eq!(
            log.append_batch(std::slice::from_ref(&first_event))
                .await
                .unwrap(),
            [4]
        );
        log.shutdown().await.unwrap();
        assert_eq!(ids(&path), ["opened", "requested", "metadata", "first"]);
        assert_projection_positions(&path);
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(
            reopened
                .append_batch(std::slice::from_ref(&first_event))
                .await
                .unwrap(),
            [4]
        );
        reopened.close().await.unwrap();
        assert_projection_positions(&path);
    }
}

fn assert_projection_positions(path: &std::path::Path) {
    let db = rusqlite::Connection::open(path).unwrap();
    let canonical: Vec<i64> = db
        .prepare("SELECT sequence FROM runtime_events ORDER BY sequence")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for kind in ["session", "invocation"] {
        let projected: Vec<i64> = db
            .prepare("SELECT sequence FROM context_source_prefixes WHERE kind=? ORDER BY sequence")
            .unwrap()
            .query_map([kind], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            projected, canonical,
            "{kind} projection retained rolled-back event"
        );
    }
    for table in [
        "context_obligations",
        "context_execution_work",
        "context_independent_tools",
    ] {
        let sql = format!(
            "SELECT COUNT(*) FROM {table} WHERE opened_at>(SELECT COALESCE(MAX(sequence),0) FROM event_log)"
        );
        assert_eq!(
            db.query_row(&sql, [], |row| row.get::<_, i64>(0)).unwrap(),
            0,
            "{table} retained an uncommitted boundary"
        );
    }
    assert_eq!(db.query_row("SELECT COUNT(*) FROM context_safety_heads WHERE through_sequence>(SELECT COALESCE(MAX(sequence),0) FROM event_log)",[],|row|row.get::<_,i64>(0)).unwrap(),0);
}

#[tokio::test]
async fn derived_tool_part_admission_work_is_independent_of_settled_history() {
    use maka_agent_facts::{model::ModelToolCall, tool_call::ToolCallIdentity};

    async fn admission_work(history: usize) -> usize {
        let dir = tempfile::tempdir().unwrap();
        let log = open(&dir.path().join("events.sqlite")).await;
        for index in 0..history {
            let operation = format!("settled-{index}");
            let dispatched = event(
                &format!("dispatch-{index}"),
                Fact::ToolDispatched {
                    presentation: None,
                    title: None,
                    operation_id: operation.clone(),
                    call: ToolCallIdentity::standalone(operation.clone()),
                    name: "Read".into(),
                    input: serde_json::json!({}),
                },
            );
            let settled = EventWrite::tool_success(
                format!("settlement-{index}"),
                std::time::UNIX_EPOCH,
                dispatched.event().invocation.clone(),
                operation,
                maka_agent_facts::tool_output::ToolOutput::Text("done".into()).into(),
            )
            .unwrap()
            .0;
            log.append_batch(&[dispatched, settled]).await.unwrap();
        }
        let message = maka_agent_facts::tool_call::tool_use_id("invocation", "step:fresh");
        let candidate = event(
            "fresh-part",
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelObservation::Part(ModelPartRecord {
                    ordinal: 0,
                    message_id: message,
                    started_at: std::time::UNIX_EPOCH,
                    provider_part_id: None,
                    part: Arc::new(ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: "fresh".into(),
                            name: "Read".into(),
                            input: serde_json::json!({}).into(),
                            provider_executed: false,
                            provider_options: None,
                        },
                    }),
                }),
            },
        );
        let candidate_event = candidate.event().clone();
        let work = log
            .connection
            .run(move |db| {
                {
                    // Install inside this operation: the connection's cancellation
                    // handler is installed before it invokes this callback.
                    let steps = Arc::new(AtomicUsize::new(0));
                    let counter = steps.clone();
                    db.progress_handler(
                        1,
                        Some(move || {
                            counter.fetch_add(1, Ordering::Relaxed);
                            false
                        }),
                    )
                    .unwrap();
                    let result = crate::model_items::validate(db, &candidate_event);
                    db.progress_handler(0, None::<fn() -> bool>).unwrap();
                    result?;
                    Ok(steps.load(Ordering::Relaxed))
                }
            })
            .await
            .unwrap();
        // The measured boundary must agree with real canonical admission.
        log.append(&candidate).await.unwrap();
        let mut wrong = candidate.event().clone();
        wrong.id = "wrong-derived-part".into();
        if let Fact::ModelObserved {
            event: ModelObservation::Part(record),
            ..
        } = &mut wrong.fact
        {
            record.ordinal = 1;
            record.message_id = maka_agent_facts::tool_call::tool_use_id("other", "step:fresh");
        }
        assert!(matches!(
            log.append(&EventWrite::plain(wrong).unwrap()).await,
            Err(CommitError::Rejected(reason))
                if reason.contains("tool part identity differs from its original call")
        ));
        log.shutdown().await.unwrap();
        work
    }

    let short = admission_work(20).await;
    let long = admission_work(220).await;
    eprintln!("derived tool admission SQLite work: {short} -> {long} VM steps");
    assert!(short > 0, "the operation's SQLite work was not measured");
    assert!(
        long <= short * 2,
        "derived tool admission revisited settled history: {short} -> {long} VM steps"
    );
}

#[tokio::test]
async fn partial_tool_input_admission_checks_its_derived_identity() {
    use maka_agent_facts::{
        event::ModelInterruption,
        model::recorded::{ToolInputPhase, ToolInputView},
    };
    let dir = tempfile::tempdir().unwrap();
    let log = open(&dir.path().join("events.sqlite")).await;
    let mut input = ToolInputView {
        id: "partial".into(),
        message_id: maka_agent_facts::tool_call::tool_use_id("other", "step:partial"),
        started_at: std::time::UNIX_EPOCH,
        name: "Read".into(),
        provider_executed: false,
        text: "{\"path\":".into(),
        phase: ToolInputPhase::Open,
    };
    let interrupted = |input| {
        event(
            "partial-interrupted",
            Fact::ModelInterrupted {
                step_id: "step".into(),
                status: ModelInterruption::Failed,
                diagnostic: None,
                model_failure: None,
                partial: Some(ModelPartial {
                    parts: Vec::new(),
                    tool_inputs: vec![input],
                    response_id: None,
                    model: None,
                    timestamp: None,
                }),
            },
        )
    };
    assert!(matches!(log.append(&interrupted(input.clone())).await,
        Err(CommitError::Rejected(reason)) if reason.contains("tool-input identity differs from its original call")));
    input.message_id = maka_agent_facts::tool_call::tool_use_id("invocation", "step:partial");
    log.append(&interrupted(input)).await.unwrap();
    log.shutdown().await.unwrap();
}
