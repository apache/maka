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
use crate::writeback::{Notification, Prepared, Statement};
use std::sync::atomic::AtomicBool;

pub(super) struct Retention(pub Arc<AtomicBool>);
impl Drop for Retention {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

// A test-only domain row exercises the generic writer, not Agent policy.
pub(super) struct Insert {
    value: &'static str,
    session: &'static str,
    retention: Option<Arc<Retention>>,
}
impl Insert {
    pub(super) fn for_session(value: &'static str, session: &'static str) -> Self {
        Self {
            value,
            session,
            retention: None,
        }
    }
}
impl Statement for Insert {
    type Value = u64;
    type Output = u64;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        self.retention
            .as_ref()
            .map(|value| vec![value.clone() as Arc<dyn Send + Sync>])
            .unwrap_or_default()
    }
    fn execute(self, db: &rusqlite::Connection) -> Result<Prepared<u64>, StoreError> {
        db.execute(
            "INSERT INTO writeback_probe(value) VALUES (?)",
            [self.value],
        )?;
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)",
            [self.session],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::SessionNotFound);
        }
        let sequence = db
            .last_insert_rowid()
            .try_into()
            .map_err(|_| StoreError::InvalidTransition("negative test sequence".into()))?;
        Ok(Prepared {
            value: sequence,
            changed: true,
            notification: Notification::sequence(sequence),
        })
    }
    fn committed(value: u64) -> u64 {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::SessionNotFound)
    }
}
pub(super) async fn gate(
    log: &Arc<EventLog>,
) -> (std::sync::mpsc::Sender<()>, tokio::task::JoinHandle<()>) {
    let (entered, reached) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let owner = log.clone();
    let task = tokio::spawn(async move {
        owner
            .connection
            .run(move |_| {
                entered.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(10)).unwrap();
                Ok(())
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
pub(super) async fn hook(log: &EventLog, mut callback: impl FnMut() -> bool + Send + 'static) {
    log.connection
        .run(move |db| {
            db.commit_hook(Some(move || !callback()))?;
            Ok(())
        })
        .await
        .unwrap();
}
pub(super) async fn forbid_rollback(log: &EventLog) {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    log.connection
        .run(|db| {
            db.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Transaction {
                    operation: TransactionOperation::Rollback,
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))?;
            Ok(())
        })
        .await
        .unwrap();
}
fn stored(log: &EventLog) -> Vec<String> {
    let db = rusqlite::Connection::open(
        log.owned_root()
            .unwrap()
            .canonical_path()
            .join(ROOT_DATABASE),
    )
    .unwrap();
    let mut statement = db
        .prepare("SELECT value FROM writeback_probe ORDER BY value")
        .unwrap();
    let values = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    values
}

#[tokio::test]
async fn late_domain_rejection_rolls_back_pending_and_retention_only_for_that_request() {
    let (_directory, log) = store().await;
    let released = Arc::new(AtomicBool::new(false));
    let retained = Arc::new(Retention(released.clone()));
    let commits = Arc::new(AtomicUsize::new(0));
    let observed = commits.clone();
    let (entered, reached) = oneshot::channel();
    let mut entered = Some(entered);
    let (release_commit, wait_commit) = std::sync::mpsc::channel();
    hook(&log, move || {
        observed.fetch_add(1, Ordering::SeqCst);
        entered.take().unwrap().send(()).unwrap();
        wait_commit.recv_timeout(Duration::from_secs(10)).unwrap();
        true
    })
    .await;
    let (release, blocked) = gate(&log).await;
    let mut a = Box::pin(
        log.connection
            .write(Insert::for_session("a", "a"), log.commits.notice()),
    );
    let mut rejected = Box::pin(log.connection.write(
        Insert {
            value: "rejected",
            session: "missing",
            retention: Some(retained.clone()),
        },
        log.commits.notice(),
    ));
    let mut b = Box::pin(
        log.connection
            .write(Insert::for_session("b", "b"), log.commits.notice()),
    );
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut rejected).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    drop(retained);
    let mut changes = log.subscribe_commits();
    changes.borrow_and_update();
    release.send(()).unwrap();
    blocked.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !released.load(Ordering::SeqCst),
        "the rejected input remains owned through outer settlement"
    );
    assert!(stored(&log).is_empty());
    assert!(!changes.has_changed().unwrap());
    assert!(futures_util::poll!(&mut a).is_pending());
    assert!(futures_util::poll!(&mut rejected).is_pending());
    assert!(futures_util::poll!(&mut b).is_pending());
    release_commit.send(()).unwrap();
    a.await.unwrap();
    assert!(matches!(rejected.await, Err(StoreError::SessionNotFound)));
    b.await.unwrap();
    assert_eq!(commits.load(Ordering::SeqCst), 1);
    assert_eq!(stored(&log), ["a", "b"]);
    assert!(released.load(Ordering::SeqCst));
    log.connection.shutdown().await.unwrap();
}

#[tokio::test]
async fn storage_failure_rolls_back_prepared_neighbors_and_preserves_cause() {
    for rollback_fails in [false, true] {
        let (_directory, log) = store().await;
        log.connection.run(|db| {
            db.execute_batch("CREATE TRIGGER statement_fault AFTER INSERT ON writeback_probe WHEN NEW.value='b' BEGIN SELECT RAISE(ABORT, 'statement storage fault'); END;")?;
            Ok(())
        }).await.unwrap();
        if rollback_fails {
            forbid_rollback(&log).await;
        }
        let (release, blocked) = gate(&log).await;
        let mut a = Box::pin(
            log.connection
                .write(Insert::for_session("a", "a"), log.commits.notice()),
        );
        let mut b = Box::pin(
            log.connection
                .write(Insert::for_session("b", "b"), log.commits.notice()),
        );
        assert!(futures_util::poll!(&mut a).is_pending());
        assert!(futures_util::poll!(&mut b).is_pending());
        let mut changes = log.subscribe_commits();
        changes.borrow_and_update();
        release.send(()).unwrap();
        blocked.await.unwrap();
        for error in [a.await.unwrap_err(), b.await.unwrap_err()] {
            if rollback_fails {
                assert!(
                    matches!(&error, StoreError::Shared(cause) if matches!(cause.as_ref(), StoreError::RollbackFailed { .. }))
                );
            }
            let StoreError::Sqlite(sql) = error.underlying() else {
                panic!("{error:?}");
            };
            assert_eq!(
                sql.sqlite_error().unwrap().extended_code,
                rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
            );
            assert!(sql.to_string().contains("statement storage fault"));
        }
        assert!(!changes.has_changed().unwrap());
        if !rollback_fails {
            log.connection
                .run(|db| {
                    db.execute_batch("DROP TRIGGER statement_fault")?;
                    Ok(())
                })
                .await
                .unwrap();
        }
        assert_eq!(log.connection.shutdown().await.is_err(), rollback_fails);
        assert!(stored(&log).is_empty());
        let owner = log.root_owner.as_ref().unwrap().clone();
        drop(log);
        let reopened = EventLog::for_root(owner).await.unwrap();
        let rows = reopened
            .connection
            .run(|db| {
                Ok(
                    db.query_row("SELECT count(*) FROM writeback_probe", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(rows, 0, "no prepared neighbor survived rollback/reopen");
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn singleton_rejection_rolls_back_and_keeps_writer_available() {
    let (_directory, log) = store().await;
    assert!(matches!(
        log.connection
            .write(
                Insert::for_session("rejected", "missing"),
                log.commits.notice()
            )
            .await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(stored(&log).is_empty());
    log.connection
        .write(Insert::for_session("accepted", "a"), log.commits.notice())
        .await
        .unwrap();
    assert_eq!(stored(&log), ["accepted"]);
    log.connection.shutdown().await.unwrap();
}
