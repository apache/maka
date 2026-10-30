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

use crate::{EventLog, message_admissions::PendingExecution};
use crate::{StoreError, message_admissions::PendingMessageAdmission};
use maka_agent_facts::{
    event::Invocation,
    input::DeliveredMessage,
    message::{MessageDisposition, Placement, RootSourceMessage},
};
use std::sync::{Arc, atomic::Ordering};
use std::{sync::atomic::AtomicUsize, time::Duration};
use tokio::sync::oneshot;

pub(super) fn admission(session: &str) -> PendingMessageAdmission {
    PendingMessageAdmission {
        execution: PendingExecution {
            owner: "host".into(),
            basis: serde_json::Value::Null,
        },
        invocation: Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{session}"),
            run_id: format!("run-{session}"),
            invocation_id: format!("invocation-{session}"),
        },
        steering_invocation: None,
        required_tools: Default::default(),
        admitted_at: 1,
        source: RootSourceMessage {
            unprepared_content: "hello".into(),
            message: DeliveredMessage {
                origin: None,
                message_id: format!("message-{session}"),
                content: "hello".into(),
                submitted_content_digest: format!("sha256:{}", "a".repeat(64)),
            },
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        },
    }
}
async fn open(path: &std::path::Path) -> Arc<EventLog> {
    let log = Arc::new(EventLog::open(path).await.unwrap());
    for session in ["a", "b"] {
        log.create_session(session, session, &serde_json::json!({}), 0)
            .await
            .unwrap();
    }
    log
}
pub(super) async fn gate(
    log: &Arc<EventLog>,
) -> (oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let (entered, reached) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let log = log.clone();
    let task = tokio::spawn(async move {
        log.connection
            .run(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    wait.await.unwrap();
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
    (release, task)
}
pub(super) async fn hook(log: &EventLog, callback: impl FnMut() -> bool + Send + 'static) {
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
fn stored(path: &std::path::Path) -> Vec<String> {
    rusqlite::Connection::open(path)
        .unwrap()
        .prepare("SELECT session_id FROM message_admissions ORDER BY session_id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[tokio::test]
async fn late_domain_rejection_rolls_back_pending_and_retention_only_for_that_request() {
    use maka_agent_facts::{
        event::{EventWrite, Fact, InvocationInput, InvocationOutcome, RuntimeEvent},
        session::{CopyPurpose, CopyState},
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    let seed = admission("a");
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: seed.source.message.content.clone(),
                source_messages: vec![seed.source.clone()],
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(seed.invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    let source = log
        .get_session::<serde_json::Value>("a")
        .await
        .unwrap()
        .unwrap();
    let copied = log
        .copy_session(
            crate::sessions::SessionCopy {
                source_session_id: "a".into(),
                target_session_id: "c".into(),
                expected_source_revision: source.revision,
                purpose: CopyPurpose::Revision {
                    turn_id: seed.invocation.turn_id,
                },
            },
            &serde_json::json!({}),
            0,
        )
        .await
        .unwrap();
    let crate::sessions::SessionCopyResult::Committed(copied) = copied else {
        panic!("copy conflict")
    };
    assert_eq!(copied.copy_state, Some(CopyState::Preparing));
    let exhausted = maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER;
    log.connection
        .run(move |db| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO message_queue_state(session_id, revision) VALUES ('c', ?)",
                )
                .bind(exhausted as i64)
                .execute(db)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    hook(&log, move || {
        seen.fetch_add(1, Ordering::SeqCst);
        true
    })
    .await;
    let (release, gate) = gate(&log).await;
    let mut next = admission("a");
    next.source.message.message_id = "next-message-a".into();
    next.invocation.turn_id = "next-turn-a".into();
    next.invocation.run_id = "next-run-a".into();
    next.invocation.invocation_id = "next-invocation-a".into();
    let mut a = Box::pin(log.admit_message(next.clone()));
    let mut c = Box::pin(log.admit_message(admission("c")));
    let mut b = Box::pin(log.admit_message(admission("b")));
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut c).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    assert_eq!(a.await.unwrap(), next);
    assert!(
        matches!(c.await, Err(StoreError::InvalidTransition(message)) if message == "message queue revision exhausted")
    );
    assert_eq!(b.await.unwrap(), admission("b"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(stored(&path), ["a", "b"]);
    assert_eq!(log.message_queue_revision("c").await.unwrap(), exhausted);
    let rejected = log
        .get_session::<serde_json::Value>("c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rejected.copy_state, Some(CopyState::Preparing));
    assert_eq!(rejected.revision, copied.revision);
    log.connection.shutdown().await.unwrap();
}

#[tokio::test]
async fn storage_failure_rolls_back_prepared_neighbors_and_preserves_cause() {
    for rollback_fails in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = open(&path).await;
        log.connection.run(|db| Box::pin(async move {
        sqlx::raw_sql("CREATE TRIGGER admission_fault AFTER INSERT ON message_admissions WHEN NEW.session_id='b' BEGIN SELECT RAISE(ABORT, 'admission storage fault'); END;").execute(db).await?;
        Ok(())
    })).await.unwrap();
        if rollback_fails {
            forbid_rollback(&log).await;
        }
        let (release, gate) = gate(&log).await;
        let mut a = Box::pin(log.admit_message(admission("a")));
        let mut b = Box::pin(log.admit_message(admission("b")));
        assert!(futures_util::poll!(&mut a).is_pending());
        assert!(futures_util::poll!(&mut b).is_pending());
        let mut read = Box::pin(log.pending_messages("a"));
        assert!(futures_util::poll!(&mut read).is_pending());
        release.send(()).unwrap();
        gate.await.unwrap();
        for error in [a.await.unwrap_err(), b.await.unwrap_err()] {
            let error = match error {
                StoreError::Sqlx(error) if !rollback_fails => error,
                StoreError::CommitUnknown(error) if rollback_fails => error,
                error => panic!("{error:?}"),
            };
            if rollback_fails {
                assert!(error.to_string().contains("rollback unconfirmed"));
            }
            let database = error.as_database_error().unwrap();
            assert_eq!(
                database.code().unwrap(),
                rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER.to_string()
            );
            assert!(database.as_error().source().is_some());
            assert!(error.to_string().contains("admission storage fault"));
        }
        if rollback_fails {
            assert!(matches!(read.await, Err(StoreError::OperationUnknown)));
        } else {
            assert!(read.await.unwrap().is_empty());
        }
        log.connection.shutdown().await.unwrap();
        assert!(stored(&path).is_empty());
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(reopened.message_queue_revision("a").await.unwrap(), 0);
        assert_eq!(reopened.message_queue_revision("b").await.unwrap(), 0);
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn singleton_rejection_requires_confirmed_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open(&path).await;
    forbid_rollback(&log).await;
    let error = log.admit_message(admission("missing")).await.unwrap_err();
    assert!(matches!(error, StoreError::CommitUnknown(_)), "{error:?}");
    log.connection.shutdown().await.unwrap();
    assert!(stored(&path).is_empty());
}

pub(super) async fn forbid_rollback(log: &EventLog) {
    unsafe extern "C" fn deny_rollback(
        _: *mut std::ffi::c_void,
        action: std::ffi::c_int,
        operation: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
    ) -> std::ffi::c_int {
        if action == rusqlite::ffi::SQLITE_TRANSACTION && !operation.is_null() {
            // SAFETY: SQLite supplies a callback-local NUL-terminated operation.
            if unsafe { std::ffi::CStr::from_ptr(operation) }.to_bytes() == b"ROLLBACK" {
                return rusqlite::ffi::SQLITE_DENY;
            }
        }
        rusqlite::ffi::SQLITE_OK
    }
    log.connection
        .run(|db| {
            Box::pin(async move {
                let mut handle = db.lock_handle().await?;
                // SAFETY: callback is static, no context is dereferenced; the handle is exclusive.
                assert_eq!(
                    unsafe {
                        rusqlite::ffi::sqlite3_set_authorizer(
                            handle.as_raw_handle().as_mut(),
                            Some(deny_rollback),
                            std::ptr::null_mut(),
                        )
                    },
                    rusqlite::ffi::SQLITE_OK
                );
                Ok(())
            })
        })
        .await
        .unwrap();
}
