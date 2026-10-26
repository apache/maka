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
use crate::{EventLog, StoreError, connection::ReadEnvelope};
use sqlx::Connection;
use std::{
    sync::{
        Weak,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{RwLock, Semaphore, oneshot};

async fn store() -> (tempfile::TempDir, EventLog, Weak<crate::root::RootOwner>) {
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(
        crate::root::RootOwner::create(
            &directory.path().join("root"),
            &crate::root::RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let original = Arc::downgrade(&root);
    let log = EventLog::for_root(root).await.unwrap();
    (directory, log, original)
}

async fn scoped(log: &EventLog, gate: &Arc<RwLock<()>>) -> EventLog {
    log.scoped(Arc::new(gate.clone().read_owned().await))
}

async fn reached(receiver: oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .unwrap()
        .unwrap();
}

async fn barrier(log: &EventLog) {
    log.connection
        .run(|_| Box::pin(async { Ok(()) }))
        .await
        .unwrap();
}

struct CloseGate {
    entered: Option<oneshot::Sender<()>>,
    release: std::sync::mpsc::Receiver<()>,
}
impl Drop for CloseGate {
    fn drop(&mut self) {
        self.entered.take().unwrap().send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(10)).unwrap();
    }
}
fn close_gate() -> (
    CloseGate,
    oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (entered, reached) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    (
        CloseGate {
            entered: Some(entered),
            release: gate,
        },
        reached,
        release,
    )
}

#[tokio::test]
async fn cancelled_observer_keeps_binding_pin_until_real_sql_commit() {
    let (_directory, log, _) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let scoped = scoped(&log, &gate).await;
    let (entered, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let caller = tokio::spawn(async move {
        scoped
            .connection
            .run(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin().await?;
                    sqlx::query("CREATE TABLE custody_fact(value INTEGER)")
                        .execute(&mut *tx)
                        .await?;
                    entered.send(()).unwrap();
                    wait.await.unwrap();
                    tx.commit().await?;
                    Ok(())
                })
            })
            .await
    });
    reached(ready).await;
    caller.abort();
    let _ = caller.await;
    assert!(gate.clone().try_write_owned().is_err());
    release.send(()).unwrap();
    barrier(&log).await;
    assert!(gate.clone().try_write_owned().is_ok());
    log.close().await.unwrap();
}

fn admission(session: &str) -> crate::message_admissions::PendingMessageAdmission {
    use maka_agent_facts::{
        event::Invocation,
        input::DeliveredMessage,
        message::{MessageDisposition, Placement, RootSourceMessage},
    };
    crate::message_admissions::PendingMessageAdmission {
        execution: crate::message_admissions::PendingExecution {
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

#[tokio::test]
async fn every_batch_member_keeps_pin_through_commit_or_rollback_and_pending_boundary() {
    for rollback in [false, true] {
        let (_directory, log, _) = store().await;
        for session in ["a", "b"] {
            log.create_session(session, session, &serde_json::json!({}), 0)
                .await
                .unwrap();
        }
        let (entered, hook_ready) = oneshot::channel();
        let (release_hook, hook_gate) = std::sync::mpsc::channel();
        let commits = Arc::new(AtomicUsize::new(0));
        let commit_count = commits.clone();
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    let mut handle = db.lock_handle().await?;
                    let mut entered = Some(entered);
                    if rollback {
                        handle.set_commit_hook(move || {
                            commit_count.fetch_add(1, Ordering::SeqCst);
                            false
                        });
                        handle.set_rollback_hook(move || {
                            entered.take().unwrap().send(()).unwrap();
                            hook_gate.recv_timeout(Duration::from_secs(10)).unwrap();
                        });
                    } else {
                        handle.set_commit_hook(move || {
                            commit_count.fetch_add(1, Ordering::SeqCst);
                            entered.take().unwrap().send(()).unwrap();
                            hook_gate.recv_timeout(Duration::from_secs(10)).unwrap();
                            true
                        });
                    }
                    Ok(())
                })
            })
            .await
            .unwrap();
        let (blocked, blocker_ready) = oneshot::channel();
        let (release_blocker, blocker_gate) = oneshot::channel();
        let mut blocker = Box::pin(log.connection.run(move |_| {
            Box::pin(async move {
                blocked.send(()).unwrap();
                blocker_gate.await.unwrap();
                Ok(())
            })
        }));
        assert!(futures_util::poll!(&mut blocker).is_pending());
        reached(blocker_ready).await;
        let first_gate = Arc::new(RwLock::new(()));
        let second_gate = Arc::new(RwLock::new(()));
        let boundary_gate = Arc::new(RwLock::new(()));
        let first = scoped(&log, &first_gate).await;
        let second = scoped(&log, &second_gate).await;
        let boundary = scoped(&log, &boundary_gate).await;
        let mut first = Box::pin(async move { first.admit_message(admission("a")).await });
        let mut second = Box::pin(async move { second.admit_message(admission("b")).await });
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut second).is_pending());
        let (entered_boundary, boundary_ready) = oneshot::channel();
        let (release_boundary, boundary_wait) = oneshot::channel();
        let mut boundary = Box::pin(async move {
            boundary
                .connection
                .run(move |_| {
                    Box::pin(async move {
                        entered_boundary.send(()).unwrap();
                        boundary_wait.await.unwrap();
                        Ok(())
                    })
                })
                .await
        });
        assert!(futures_util::poll!(&mut boundary).is_pending());
        drop(first);
        drop(second);
        drop(boundary);
        release_blocker.send(()).unwrap();
        blocker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), hook_ready)
            .await
            .expect("hook timeout")
            .unwrap_or_else(|error| panic!("hook closed rollback={rollback}: {error}"));
        for gate in [&first_gate, &second_gate, &boundary_gate] {
            assert!(gate.clone().try_write_owned().is_err());
        }
        assert_eq!(
            commits.load(Ordering::SeqCst),
            1,
            "both writes must share one physical transaction"
        );
        release_hook.send(()).unwrap();
        if rollback {
            // SQLite's commit-hook rejection already rolled back. The existing
            // writeback protocol may conservatively retire this owner when its
            // subsequent explicit rollback has no active transaction to clean.
            log.connection.shutdown().await.unwrap();
            assert!(boundary_ready.await.is_err());
            for gate in [&first_gate, &second_gate, &boundary_gate] {
                assert!(gate.clone().try_write_owned().is_ok());
            }
            let db = rusqlite::Connection::open(
                log.owned_root()
                    .unwrap()
                    .canonical_path()
                    .join(crate::root::ROOT_DATABASE),
            )
            .unwrap();
            let count: i64 = db
                .query_row("SELECT COUNT(*) FROM message_admissions", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
            continue;
        }
        tokio::time::timeout(Duration::from_secs(5), boundary_ready)
            .await
            .expect("boundary timeout")
            .unwrap_or_else(|error| panic!("boundary closed rollback={rollback}: {error}"));
        assert!(first_gate.clone().try_write_owned().is_ok());
        assert!(second_gate.clone().try_write_owned().is_ok());
        assert!(
            boundary_gate.clone().try_write_owned().is_err(),
            "pending Run boundary keeps its own envelope"
        );
        release_boundary.send(()).unwrap();
        barrier(&log).await;
        assert!(boundary_gate.clone().try_write_owned().is_ok());
        let count = log
            .connection
            .run(|db| {
                Box::pin(async move {
                    Ok(
                        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM message_admissions")
                            .fetch_one(db)
                            .await?,
                    )
                })
            })
            .await
            .unwrap();
        assert_eq!(count, 2);
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn noninterruptible_reader_with_open_transaction_closes_before_releasing_pin_or_reuse() {
    let (_directory, log, _) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let scoped = scoped(&log, &gate).await;
    let (closing, close_ready, release) = close_gate();
    scoped
        .connection
        .read(move |db| {
            Box::pin(async move {
                sqlx::raw_sql("PRAGMA cache_size=-123456; BEGIN; SELECT COUNT(*) FROM event_log;")
                    .execute(&mut *db)
                    .await?;
                db.lock_handle().await?.set_progress_handler(1, move || {
                    let _retained = &closing;
                    true
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(scoped);
    reached(close_ready).await;
    assert!(gate.clone().try_write_owned().is_err());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), gate.clone().write_owned())
        .await
        .unwrap();
    // Occupy both actors to ensure the retired connection cannot be reused.
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let mut reads = Vec::new();
    for _ in 0..2 {
        let entered = entered.clone();
        let release = release.clone();
        let log = log.scoped(Arc::new(()));
        reads.push(tokio::spawn(async move {
            log.connection
                .read(move |db| {
                    Box::pin(async move {
                        assert!(super::super::is_autocommit(db).await);
                        let marker: i64 = sqlx::query_scalar("PRAGMA cache_size")
                            .fetch_one(db)
                            .await?;
                        assert_ne!(marker, -123456);
                        entered.add_permits(1);
                        release.acquire().await.unwrap().forget();
                        Ok(())
                    })
                })
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), entered.acquire_many(2))
        .await
        .unwrap()
        .unwrap()
        .forget();
    release.add_permits(2);
    for read in reads {
        read.await.unwrap().unwrap();
    }
    log.close().await.unwrap();
}

#[tokio::test]
async fn writer_panic_keeps_active_pin_until_real_close_but_discards_unexecuted_pin() {
    let (_directory, log, original) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let active_scope = scoped(&log, &gate).await;
    let queued_gate = Arc::new(RwLock::new(()));
    let queued = scoped(&log, &queued_gate).await;
    let (closing, close_ready, release_close) = close_gate();
    let (entered, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let mut active = Box::pin(async move {
        let active_scope = active_scope;
        active_scope
            .connection
            .run::<()>(move |db| {
                Box::pin(async move {
                    sqlx::query("BEGIN").execute(&mut *db).await?;
                    db.lock_handle().await?.set_progress_handler(1, move || {
                        let _retained = &closing;
                        true
                    });
                    entered.send(()).unwrap();
                    wait.await.unwrap();
                    panic!("writer callback unwound");
                })
            })
            .await
    });
    assert!(futures_util::poll!(&mut active).is_pending());
    reached(ready).await;
    let mut queued = Box::pin(async move {
        let queued = queued;
        queued
            .connection
            .run::<()>(|_| Box::pin(async { panic!("unexecuted queued job") }))
            .await
    });
    assert!(futures_util::poll!(&mut queued).is_pending());
    drop(queued);
    drop(active);
    let receipt = log.connection.close_receipt();
    drop(log);
    release.send(()).unwrap();
    reached(close_ready).await;
    assert!(gate.clone().try_write_owned().is_err());
    assert!(original.upgrade().is_some());
    assert!(queued_gate.clone().try_write_owned().is_ok());
    release_close.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), receipt)
        .await
        .unwrap()
        .unwrap();
    assert!(gate.clone().try_write_owned().is_ok());
    assert!(original.upgrade().is_none());
}

struct PanickingDrop;
impl Drop for PanickingDrop {
    fn drop(&mut self) {
        panic!("actual SQLite callback destructor failed");
    }
}

#[tokio::test]
async fn reader_close_failure_retains_pin_and_original_root_after_observer_finishes() {
    let (_directory, log, original) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let scoped = scoped(&log, &gate).await;
    scoped
        .connection
        .read(move |db| {
            Box::pin(async move {
                sqlx::query("BEGIN").execute(&mut *db).await?;
                let retained = PanickingDrop;
                db.lock_handle().await?.set_progress_handler(1, move || {
                    let _retained = &retained;
                    true
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(scoped);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), log.connection.shutdown())
            .await
            .unwrap(),
        Err(StoreError::CloseFailed(_))
    ));
    drop(log);
    assert!(gate.clone().try_write_owned().is_err());
    assert!(original.upgrade().is_some());
}

#[tokio::test]
async fn reader_task_panic_retains_envelope_outside_join_error() {
    let (_directory, log, original) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let custody: Custody = Arc::new(gate.clone().read_owned().await);
    log.connection
        .read_jobs
        .send(ReadEnvelope {
            custody: Some(custody),
            job: Box::new(|_| {
                Box::pin(async { panic!("reader actor job escaped callback boundary") })
            }),
        })
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), log.connection.shutdown())
            .await
            .unwrap(),
        Err(StoreError::CloseFailed(_))
    ));
    drop(log);
    assert!(gate.clone().try_write_owned().is_err());
    assert!(original.upgrade().is_some());
}

#[tokio::test]
async fn reader_writer_observation_inherits_custody_after_reader_finishes() {
    let (_directory, log, _) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let scoped = scoped(&log, &gate).await;
    let writer = scoped.connection.writer();
    let reader_gate = Arc::new(RwLock::new(()));
    let reader = scoped.scoped(Arc::new(reader_gate.clone().read_owned().await));
    let (blocked, blocker_ready) = oneshot::channel();
    let (release_blocker, blocker_gate) = oneshot::channel();
    let mut blocker = Box::pin(log.connection.run(move |_| {
        Box::pin(async move {
            blocked.send(()).unwrap();
            blocker_gate.await.unwrap();
            Ok(())
        })
    }));
    assert!(futures_util::poll!(&mut blocker).is_pending());
    reached(blocker_ready).await;
    let (entered, observation_ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    reader
        .connection
        .read(move |_| {
            Box::pin(async move {
                let mut observation = Box::pin(writer.run(move |_| {
                    Box::pin(async move {
                        entered.send(()).unwrap();
                        wait.await.unwrap();
                        Ok(())
                    })
                }));
                assert!(futures_util::poll!(&mut observation).is_pending());
                // This observer ends, but its accepted writer job retains the same pin.
                drop(observation);
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(reader);
    drop(scoped);
    // The read reply precedes cleanup; only the reader owns this extra pin.
    tokio::time::timeout(Duration::from_secs(5), reader_gate.write_owned())
        .await
        .expect("reader cleanup must release its independent pin");
    release_blocker.send(()).unwrap();
    blocker.await.unwrap();
    reached(observation_ready).await;
    assert!(gate.clone().try_write_owned().is_err());
    release.send(()).unwrap();
    barrier(&log).await;
    assert!(gate.clone().try_write_owned().is_ok());
    log.close().await.unwrap();
}

#[tokio::test]
async fn writer_with_unclosed_transaction_retires_before_releasing_pin() {
    let (_directory, log, _) = store().await;
    let gate = Arc::new(RwLock::new(()));
    let scoped = scoped(&log, &gate).await;
    let (closing, close_ready, release) = close_gate();
    scoped
        .connection
        .run(move |db| {
            Box::pin(async move {
                sqlx::query("BEGIN IMMEDIATE").execute(&mut *db).await?;
                db.lock_handle().await?.set_progress_handler(1, move || {
                    let _retained = &closing;
                    true
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(scoped);
    reached(close_ready).await;
    assert!(gate.clone().try_write_owned().is_err());
    assert!(matches!(
        log.connection
            .run::<()>(|_| Box::pin(async { panic!("dirty writer must not be reused") }))
            .await,
        Err(StoreError::ConnectionClosed)
    ));
    release.send(()).unwrap();
    log.connection.shutdown().await.unwrap();
    assert!(gate.clone().try_write_owned().is_ok());
}
