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
    model::{ModelEvent, TextKind},
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

fn delta(id: &str, text: &str) -> EventWrite {
    event(
        id,
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::PartDelta {
                id: "part".into(),
                text: text.into(),
                provider_options: None,
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
                context_breakdown: None,
                item_acceptance: false,
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
            "part",
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartStarted {
                    id: "part".into(),
                    text_kind: TextKind::Text,
                    provider_options: None,
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
                Box::pin(async move {
                    entered.send(()).unwrap();
                    gate.await.unwrap();
                    Ok(())
                })
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

async fn hook(log: &EventLog, callback: impl FnMut() -> bool + Send + 'static) {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                db.lock_handle().await?.set_commit_hook(callback);
                Ok(())
            })
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
    let first = [delta("first", "one")];
    let bad = [
        delta("rolled-back", "bad prefix"),
        event(
            "bad-tail",
            Fact::ModelObserved {
                step_id: "missing".into(),
                event: ModelEvent::PartDelta {
                    id: "part".into(),
                    text: "bad tail".into(),
                    provider_options: None,
                },
            },
        ),
    ];
    let conflict = [delta("first", "different")];
    let last = [delta("last", "two")];
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
    assert_eq!(ids(&path), ["opened", "requested", "part", "first", "last"]);
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
async fn commit_failure_preserves_domain_rejection_and_stops_pending_control() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    hook(&log, || false).await;
    let (release, gate) = gate(&log).await;
    let first = [delta("first", "one")];
    let bad = [delta("part", "conflicting original")];
    let last = [delta("last", "two")];
    let mut a = Box::pin(log.append_batch(&first));
    let mut b = Box::pin(log.append_batch(&bad));
    let mut c = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    assert!(futures_util::poll!(&mut c).is_pending());
    let ran = Arc::new(AtomicUsize::new(0));
    let called = ran.clone();
    let mut control = Box::pin(log.connection.run(move |_| {
        Box::pin(async move {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }));
    assert!(futures_util::poll!(&mut control).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    assert!(matches!(a.await, Err(CommitError::OutcomeUnknown(_))));
    assert!(matches!(b.await, Err(CommitError::Rejected(_))));
    assert!(matches!(c.await, Err(CommitError::OutcomeUnknown(_))));
    assert!(matches!(control.await, Err(StoreError::OperationUnknown)));
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    log.connection.shutdown().await.unwrap();
    assert_eq!(ids(&path), ["opened", "requested", "part"]);
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(reopened.append_batch(&first).await.unwrap(), [4]);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn receipts_wait_for_commit_and_dropped_waiter_is_drained_on_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    let (entered, reached) = oneshot::channel();
    let mut entered = Some(entered);
    let (release_commit, commit_gate) = std::sync::mpsc::channel();
    hook(&log, move || {
        entered.take().unwrap().send(()).unwrap();
        commit_gate.recv_timeout(Duration::from_secs(10)).unwrap();
        true
    })
    .await;
    let (release, gate) = gate(&log).await;
    let first = [delta("first", "one")];
    let last = [delta("last", "two")];
    let mut a = Box::pin(log.append_batch(&first));
    let mut b = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    let mut commits = log.subscribe_commits();
    commits.borrow_and_update();
    release.send(()).unwrap();
    gate.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    assert!(!commits.has_changed().unwrap());
    assert_eq!(ids(&path), ["opened", "requested", "part"]);
    drop(a);
    let mut close = Box::pin(log.connection.shutdown());
    assert!(futures_util::poll!(&mut close).is_pending());
    release_commit.send(()).unwrap();
    assert_eq!(b.await.unwrap(), [5]);
    close.await.unwrap();
    assert_eq!(ids(&path), ["opened", "requested", "part", "first", "last"]);
}

#[tokio::test]
async fn generic_control_keeps_its_original_position_between_observation_groups() {
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
    let (release, gate) = gate(&log).await;
    let first = [delta("first", "one")];
    let last = [delta("last", "two")];
    let mut a = Box::pin(log.append_batch(&first));
    assert!(futures_util::poll!(&mut a).is_pending());
    let mut control = Box::pin(log.connection.run(|db| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar::<_, i64>("SELECT max(sequence) FROM runtime_events")
                    .fetch_one(db)
                    .await?,
            )
        })
    }));
    assert!(futures_util::poll!(&mut control).is_pending());
    let mut b = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut b).is_pending());
    let mut close = Box::pin(log.connection.shutdown());
    assert!(futures_util::poll!(&mut close).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    assert_eq!(a.await.unwrap(), [4]);
    assert_eq!(control.await.unwrap(), 4);
    assert_eq!(b.await.unwrap(), [5]);
    close.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_eq!(ids(&path), ["opened", "requested", "part", "first", "last"]);
}

#[tokio::test]
async fn savepoint_failures_abort_the_group_and_close_without_running_control() {
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
                Box::pin(async move {
                    let mut handle = db.lock_handle().await?;
                    // SAFETY: static callback; mode is an integer tag, never dereferenced.
                    // The exclusive handle is borrowed only for installing SQLite's authorizer.
                    assert_eq!(
                        unsafe {
                            rusqlite::ffi::sqlite3_set_authorizer(
                                handle.as_raw_handle().as_mut(),
                                Some(deny_savepoint),
                                mode as *mut std::ffi::c_void,
                            )
                        },
                        rusqlite::ffi::SQLITE_OK
                    );
                    Ok(())
                })
            })
            .await
            .unwrap();
        let (release, gate) = gate(&log).await;
        let first = [delta("first", "one")];
        let bad = [delta("rolled-back", "prefix"), delta("part", "conflict")];
        let last = [delta("last", "two")];
        let mut a = Box::pin(log.append_batch(&first));
        let mut b = Box::pin(log.append_batch(&bad));
        let mut c = Box::pin(log.append_batch(&last));
        assert!(futures_util::poll!(&mut a).is_pending());
        assert!(futures_util::poll!(&mut b).is_pending());
        assert!(futures_util::poll!(&mut c).is_pending());
        let mut control = Box::pin(log.connection.run::<()>(|_| {
            Box::pin(async {
                panic!("failed savepoint must retire the owner before pending control")
            })
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
        assert!(matches!(control.await, Err(StoreError::OperationUnknown)));
        log.connection.shutdown().await.unwrap();
        assert_eq!(ids(&path), ["opened", "requested", "part"]);
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(reopened.append_batch(&first).await.unwrap(), [4]);
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn sqlite_automatic_rollback_is_not_falsely_reported_as_confirmed_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    log.connection.run(|db| Box::pin(async move {
        sqlx::raw_sql("CREATE TEMP TRIGGER rollback_observation BEFORE INSERT ON event_log
            WHEN NEW.event_id='poison' BEGIN SELECT RAISE(ROLLBACK, 'injected storage failure'); END;")
            .execute(db).await?;
        Ok(())
    })).await.unwrap();
    let (release, gate) = gate(&log).await;
    let first = [delta("first", "one")];
    let poison = [delta("poison", "two")];
    let last = [delta("last", "three")];
    let mut a = Box::pin(log.append_batch(&first));
    let mut b = Box::pin(log.append_batch(&poison));
    let mut c = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    assert!(futures_util::poll!(&mut c).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    assert!(matches!(a.await, Err(CommitError::OutcomeUnknown(_))));
    assert!(matches!(b.await, Err(CommitError::OutcomeUnknown(_))));
    assert!(
        matches!(c.await, Err(CommitError::Rejected(_))),
        "unstarted request has no uncertain write"
    );
    log.connection.shutdown().await.unwrap();
    assert_eq!(ids(&path), ["opened", "requested", "part"]);
}

#[tokio::test]
async fn authority_lost_during_last_request_rolls_back_before_commit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    let lock = dir.path().join("events.sqlite.writer.lock");
    let displaced = dir.path().join("displaced.lock");
    log.connection
        .run(move |db| {
            Box::pin(async move {
                db.lock_handle().await?.set_update_hook(move |update| {
                    if update.table == "event_log" && update.rowid == 5 {
                        std::fs::rename(&lock, &displaced).unwrap();
                    }
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    let (release, gate) = gate(&log).await;
    let first = [delta("first", "one")];
    let last = [delta("last", "two")];
    let mut a = Box::pin(log.append_batch(&first));
    let mut b = Box::pin(log.append_batch(&last));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    assert!(matches!(a.await, Err(CommitError::Rejected(_))));
    assert!(matches!(b.await, Err(CommitError::Rejected(_))));
    log.connection.shutdown().await.unwrap();
    assert_eq!(ids(&path), ["opened", "requested", "part"]);
}

#[tokio::test]
async fn session_observers_follow_confirmed_fast_and_checked_commits_only() {
    let directory = tempfile::tempdir().unwrap();
    let log = open(&directory.path().join("events.sqlite")).await;
    let mut own = log.subscribe_session_commits("session");
    let other = log.subscribe_session_commits("other");
    let write = delta("observed", "one");
    let sequence = log.append(&write).await.unwrap();
    assert_eq!(*own.borrow_and_update(), sequence);
    assert!(!other.has_changed().unwrap());
    assert_eq!(log.append(&write).await.unwrap(), sequence);
    assert!(
        !own.has_changed().unwrap(),
        "exact replay does not invalidate state"
    );
    assert!(log.append(&delta("observed", "conflict")).await.is_err());
    assert!(
        !own.has_changed().unwrap(),
        "rejected input is not a change"
    );
    let terminal = event(
        "interrupt",
        Fact::ModelInterrupted {
            model_failure: None,
            step_id: "step".into(),
            status: maka_agent_facts::event::ModelInterruption::Failed,
            diagnostic: None,
        },
    );
    let sequence = log.append(&terminal).await.unwrap();
    assert!(own.has_changed().unwrap());
    assert_eq!(*own.borrow_and_update(), sequence);
    assert!(!other.has_changed().unwrap());
    log.shutdown().await.unwrap();
}

#[tokio::test]
async fn projection_sql_fault_preserves_database_codes_and_rolls_back_all_neighbors() {
    for trigger in [
        "CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON context_source_prefixes
         WHEN NEW.sequence=5 AND NEW.kind='session'
         BEGIN SELECT RAISE(ABORT,'projection storage fault'); END;",
        "CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON context_source_prefixes
         WHEN NEW.sequence=5 AND NEW.kind='invocation'
         BEGIN SELECT RAISE(ABORT,'projection storage fault'); END;",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = open(&path).await;
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    sqlx::raw_sql(trigger).execute(db).await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let (release, blocked) = gate(&log).await;
        // Inspect the same typed receipts before EventSink intentionally maps
        // storage errors into its string-bearing CommitError API.
        let mut first = Box::pin(log.connection.write(
            WriteAppend::from_events(&[delta("first", "one")]).unwrap(),
            log.commits.session("session"),
        ));
        let mut poison = Box::pin(log.connection.write(
            WriteAppend::from_events(&[delta("poison", "two")]).unwrap(),
            log.commits.session("session"),
        ));
        let mut last = Box::pin(log.connection.write(
            WriteAppend::from_events(&[delta("last", "three")]).unwrap(),
            log.commits.session("session"),
        ));
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut poison).is_pending());
        assert!(futures_util::poll!(&mut last).is_pending());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let mut control = Box::pin(log.connection.run(move |_| {
            Box::pin(async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }));
        assert!(futures_util::poll!(&mut control).is_pending());
        let mut commits = log.subscribe_commits();
        commits.borrow_and_update();
        release.send(()).unwrap();
        blocked.await.unwrap();
        for result in [first.await, poison.await, last.await] {
            let StoreError::Sqlx(error) = result.unwrap_err() else {
                panic!("projection must retain SQLx database family")
            };
            let database = error
                .as_database_error()
                .expect("database error survived shared receipt");
            let original = database
                .as_error()
                .source()
                .and_then(|cause| cause.downcast_ref::<sqlx::sqlite::SqliteError>())
                .expect("shared failure retains the original SQLite error");
            assert_eq!(database.code(), sqlx::error::DatabaseError::code(original));
            assert_eq!(database.message(), "projection storage fault");
        }
        assert!(matches!(control.await, Err(StoreError::OperationUnknown)));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "failed observation owner must retire before pending control"
        );
        assert!(!commits.has_changed().unwrap());
        log.connection.shutdown().await.unwrap();
        assert_eq!(ids(&path), ["opened", "requested", "part"]);
        assert_projection_positions(&path);
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(
            reopened
                .append_batch(&[delta("first", "one")])
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
}

#[tokio::test]
async fn observation_identity_checks_each_invocation_field_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    log.shutdown().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    for field in ["session", "turn", "run", "invocation"] {
        let write = delta(&format!("bad-{field}"), "rejected");
        let mut event = write.event().clone();
        match field {
            "session" => event.invocation.session_id = "changed".into(),
            "turn" => event.invocation.turn_id = "changed".into(),
            "run" => event.invocation.run_id = "changed".into(),
            "invocation" => event.invocation.invocation_id = "changed".into(),
            _ => unreachable!(),
        }
        assert!(
            log.append(&EventWrite::plain(event).unwrap())
                .await
                .is_err(),
            "{field}"
        );
    }
    assert_eq!(log.append(&delta("valid", "accepted")).await.unwrap(), 4);
    log.close().await.unwrap();
    assert_eq!(ids(&path), ["opened", "requested", "part", "valid"]);
}

async fn cached_statement(log: &EventLog, prefix: &'static [u8]) -> (usize, i32, i32) {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut handle = db.lock_handle().await?;
                let mut current = std::ptr::null_mut();
                // SAFETY: the locked original connection owns every inspected statement;
                // SQL and status are read before releasing the exclusive handle.
                unsafe {
                    loop {
                        current = rusqlite::ffi::sqlite3_next_stmt(
                            handle.as_raw_handle().as_ptr(),
                            current,
                        );
                        if current.is_null() {
                            panic!(
                                "directory eligibility must remain in the writer's statement cache"
                            );
                        }
                        let sql = rusqlite::ffi::sqlite3_sql(current);
                        if !sql.is_null()
                            && std::ffi::CStr::from_ptr(sql).to_bytes().starts_with(prefix)
                        {
                            return Ok((
                                current as usize,
                                rusqlite::ffi::sqlite3_stmt_status(
                                    current,
                                    rusqlite::ffi::SQLITE_STMTSTATUS_RUN,
                                    0,
                                ),
                                rusqlite::ffi::sqlite3_stmt_status(
                                    current,
                                    rusqlite::ffi::SQLITE_STMTSTATUS_REPREPARE,
                                    0,
                                ),
                            ));
                        }
                    }
                }
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn deltas_skip_directory_work_and_boundaries_reuse_the_writer_statement() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(&dir.path().join("events.sqlite")).await;
    const DIRECTORY: &[u8] = b"SELECT e.invocation_id, CASE WHEN e.kind = 'model_observed'";
    const INGRESS: &[u8] =
        b"INSERT INTO event_log (event_id, invocation_id, kind, operation_id, event_json)";
    let before = cached_statement(&log, DIRECTORY).await;
    let ingress_before = cached_statement(&log, INGRESS).await;
    for index in 0..128 {
        log.append(&delta(&format!("delta-{index}"), "x"))
            .await
            .unwrap();
    }
    assert_eq!(
        cached_statement(&log, DIRECTORY).await,
        before,
        "ordinary deltas must not run or reprepare transcript eligibility"
    );
    log.append(&event(
        "interrupted",
        Fact::ModelInterrupted {
            step_id: "step".into(),
            status: maka_agent_facts::event::ModelInterruption::Cancelled,
            diagnostic: None,
            model_failure: None,
        },
    ))
    .await
    .unwrap();
    assert_eq!(
        cached_statement(&log, DIRECTORY).await,
        (before.0, before.1 + 1, before.2)
    );
    let text: String = log
        .connection
        .read(|db| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT preview FROM catalog_messages WHERE message_id='part'",
                )
                .fetch_one(db)
                .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(text, format!("{}…", "x".repeat(95)));
    let ingress_after = cached_statement(&log, INGRESS).await;
    assert_eq!(
        ingress_after.2, ingress_before.2,
        "changing stream identities must not recompile cached ingress"
    );
    let events = log.prefix(256, 1024 * 1024).await.unwrap();
    let deltas: Vec<_> = events
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ModelObserved {
                event: ModelEvent::PartDelta { text, .. },
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, vec!["x"; 128]);
    log.shutdown().await.unwrap();
}

#[tokio::test]
async fn tool_receipts_share_commit_without_losing_payload_or_rejection_boundaries() {
    use maka_agent_facts::{
        event::ToolOutcome, tool_call::ToolCallIdentity, tool_output::ToolOutput,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    hook(&log, move || {
        counter.fetch_add(1, Ordering::SeqCst);
        true
    })
    .await;
    let dispatch = event(
        "dispatch",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "tool".into(),
            call: ToolCallIdentity::standalone("call".into()),
            name: "Read".into(),
            input: serde_json::json!({}),
        },
    );
    let output = ToolOutput::Text("durable tool response".into());
    let settlement = EventWrite::tool_success(
        "settlement".into(),
        std::time::UNIX_EPOCH,
        dispatch.event().invocation.clone(),
        "tool".into(),
        output.clone().into(),
    )
    .unwrap()
    .0;
    let invalid = event(
        "invalid",
        Fact::ToolSettled {
            operation_id: "missing".into(),
            outcome: ToolOutcome::Failed {
                message: "no dispatch".into(),
            },
        },
    );
    let (release, blocked) = gate(&log).await;
    let mut admitted = Box::pin(log.append(&dispatch));
    let mut rejected = Box::pin(log.append(&invalid));
    let mut settled = Box::pin(log.append(&settlement));
    assert!(futures_util::poll!(&mut admitted).is_pending());
    assert!(futures_util::poll!(&mut rejected).is_pending());
    assert!(futures_util::poll!(&mut settled).is_pending());
    release.send(()).unwrap();
    blocked.await.unwrap();
    assert_eq!(admitted.await.unwrap(), 4);
    assert!(matches!(rejected.await, Err(CommitError::Rejected(_))));
    assert_eq!(settled.await.unwrap(), 5);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    log.shutdown().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .resolve_tool_result("session", "settlement")
            .await
            .unwrap(),
        output
    );
    assert_eq!(reopened.append(&settlement).await.unwrap(), 5);
    reopened.close().await.unwrap();
    assert_eq!(
        ids(&path),
        ["opened", "requested", "part", "dispatch", "settlement"]
    );
}

#[tokio::test]
async fn streamed_source_prefixes_reuse_prepared_queries_without_hidden_prepares() {
    static PREFIX_PREPARES: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "C" fn count_prefix_compiles(
        _: *mut std::ffi::c_void,
        action: std::ffi::c_int,
        table: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
    ) -> std::ffi::c_int {
        // SAFETY: SQLite supplies callback-local, NUL-terminated table names.
        if matches!(
            action,
            rusqlite::ffi::SQLITE_READ | rusqlite::ffi::SQLITE_INSERT
        ) && !table.is_null()
            && unsafe { std::ffi::CStr::from_ptr(table) }.to_bytes() == b"context_source_prefixes"
        {
            PREFIX_PREPARES.fetch_add(1, Ordering::Relaxed);
        }
        rusqlite::ffi::SQLITE_OK
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = open(&path).await;
    log.connection
        .run(|connection| {
            Box::pin(async move {
                let mut handle = connection.lock_handle().await?;
                // SAFETY: this original handle is exclusively locked. The callback uses
                // only static code/counter state, with no borrowed context to retain.
                let code = unsafe {
                    rusqlite::ffi::sqlite3_set_authorizer(
                        handle.as_raw_handle().as_ptr(),
                        Some(count_prefix_compiles),
                        std::ptr::null_mut(),
                    )
                };
                assert_eq!(code, rusqlite::ffi::SQLITE_OK);
                Ok(())
            })
        })
        .await
        .unwrap();
    log.append(&delta("warm", "warm")).await.unwrap();
    const NATIVE: &[u8] = b"SELECT sequence,hash,ordinal FROM context_source_prefixes WHERE kind=? AND owner=? AND sequence<=? ORDER BY sequence DESC LIMIT 1";
    const INSERT: &[u8] = b"INSERT INTO context_source_prefixes VALUES(?,?,?,?,?)";
    let read_before = cached_statement(&log, NATIVE).await;
    let write_before = cached_statement(&log, INSERT).await;
    PREFIX_PREPARES.store(0, Ordering::Relaxed);
    for index in 0..128 {
        log.append(&delta(&format!("prefix-{index}"), "原文"))
            .await
            .unwrap();
    }
    let read_after = cached_statement(&log, NATIVE).await;
    let write_after = cached_statement(&log, INSERT).await;
    assert_eq!(
        PREFIX_PREPARES.load(Ordering::Relaxed),
        0,
        "streamed prefixes must not compile temporary or cached SQL after warming"
    );
    for (before, after) in [(read_before, read_after), (write_before, write_after)] {
        assert_eq!(after.0, before.0);
        assert_eq!(after.1 - before.1, 2 * 128);
        assert_eq!(after.2, before.2);
    }
    log.connection
        .run(|connection| {
            Box::pin(async move {
                let mut handle = connection.lock_handle().await?;
                // SAFETY: the original locked connection owns this authorizer; clearing
                // it leaves no callback state or SQLite pointer in the test.
                let code = unsafe {
                    rusqlite::ffi::sqlite3_set_authorizer(
                        handle.as_raw_handle().as_ptr(),
                        None,
                        std::ptr::null_mut(),
                    )
                };
                assert_eq!(code, rusqlite::ffi::SQLITE_OK);
                Ok(())
            })
        })
        .await
        .unwrap();
    log.shutdown().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let events = reopened.prefix(256, 1024 * 1024).await.unwrap();
    let text: Vec<_> = events
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ModelObserved {
                event: ModelEvent::PartDelta { text, .. },
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        text,
        std::iter::once("warm")
            .chain(std::iter::repeat_n("原文", 128))
            .collect::<Vec<_>>()
    );
    reopened.close().await.unwrap();
}
