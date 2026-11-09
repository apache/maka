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

use super::{ConnectionAuthority, OpenOptions, OwnedConnection};
use crate::root::FileLease;
use rusqlite::Connection;
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::oneshot;

const DEADLINE: Duration = Duration::from_secs(10);

#[tokio::test]
async fn committed_write_hints_ignore_rollback_and_include_ddl() {
    use crate::writeback::{Notification, Prepared, Statement};

    struct Sql {
        ddl: bool,
        rollback: bool,
        changed: bool,
    }
    impl Statement for Sql {
        type Value = ();
        type Output = ();
        fn execute(self, db: &Connection) -> Result<Prepared<()>, crate::StoreError> {
            if self.ddl {
                db.execute_batch("CREATE TABLE committed_ddl(value INTEGER)")?;
            } else {
                db.execute("INSERT INTO results(value) VALUES(1)", [])?;
            }
            if self.rollback {
                return Err(crate::StoreError::InvalidTransition(
                    "reject after insert".into(),
                ));
            }
            Ok(Prepared {
                value: (),
                changed: self.changed,
                notification: Notification::METADATA,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &crate::StoreError) -> bool {
            false
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let owner = open(directory.path()).await;
    let mut changes = owner.subscribe_changes();
    changes.borrow_and_update();
    let commits = crate::commits::CommitHub::new(0).notice();
    assert!(
        owner
            .write(
                Sql {
                    ddl: false,
                    rollback: true,
                    changed: true
                },
                commits.clone()
            )
            .await
            .is_err()
    );
    assert!(!changes.has_changed().unwrap());
    owner
        .write(
            Sql {
                ddl: false,
                rollback: false,
                changed: false,
            },
            commits.clone(),
        )
        .await
        .unwrap();
    assert!(!changes.has_changed().unwrap());
    let rows = owner
        .read(|db| Ok(db.query_row("SELECT count(*) FROM results", [], |r| r.get::<_, i64>(0))?))
        .await
        .unwrap();
    assert_eq!(rows, 0);

    owner
        .write(
            Sql {
                ddl: true,
                rollback: false,
                changed: true,
            },
            commits.clone(),
        )
        .await
        .unwrap();
    assert!(changes.has_changed().unwrap());
    changes.borrow_and_update();
    owner
        .run(|db| {
            db.execute_batch("BEGIN; INSERT INTO results(value) VALUES(2)")?;
            Err::<(), _>(crate::StoreError::InvalidTransition("raw rejection".into()))
        })
        .await
        .unwrap_err();
    assert!(!changes.has_changed().unwrap());
    owner
        .write(
            Sql {
                ddl: false,
                rollback: false,
                changed: true,
            },
            commits,
        )
        .await
        .unwrap();
    assert!(changes.has_changed().unwrap());
    assert_eq!(
        owner
            .read(|db| Ok(
                db.query_row("SELECT sum(value) FROM results", [], |r| r.get::<_, i64>(0))?
            ))
            .await
            .unwrap(),
        1
    );
    owner.close().await.unwrap();
}

#[tokio::test]
async fn failed_startup_retains_the_original_cause_when_sql_close_is_unconfirmed() {
    let error = OwnedConnection::open(
        OpenOptions::temporary(),
        ConnectionAuthority::Temporary,
        |db| {
            let statement = db.prepare("SELECT 1")?;
            std::mem::forget(statement);
            Err(crate::StoreError::InvalidTransition(
                "initializer failed".into(),
            ))
        },
    )
    .await
    .err()
    .expect("both initialization and actual SQLite close fail");
    let crate::StoreError::StartupCleanupFailed { cause, cleanup } = error else {
        panic!("startup must preserve both failure causes");
    };
    assert!(
        matches!(*cause, crate::StoreError::InvalidTransition(reason) if reason == "initializer failed")
    );
    assert!(matches!(*cleanup, crate::StoreError::CloseFailed(_)));
}

async fn open(directory: &Path) -> OwnedConnection {
    OwnedConnection::open(
        OpenOptions::file(directory.join("actor.sqlite"))
            .create(true)
            .pragma("journal_mode", "WAL"),
        ConnectionAuthority::Writer {
            lease: Arc::new(FileLease::acquire(&directory.join("actor.lock")).unwrap()),
            root: None,
        },
        |db| {
            db.execute_batch("CREATE TABLE results(value INTEGER NOT NULL)")?;
            Ok(())
        },
    )
    .await
    .unwrap()
}

#[test]
#[expect(
    clippy::async_yields_async,
    reason = "The close receipt must outlive the caller runtime under test"
)]
fn accepted_write_survives_waiter_and_runtime_and_retains_lease_until_close() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (release, gate) = std::sync::mpsc::channel();
    let receipt = runtime.block_on(async {
        let owner = open(directory.path()).await;
        let (entered, started) = oneshot::channel();
        let mut write = Box::pin(owner.run(move |db| {
            db.execute_batch("BEGIN IMMEDIATE; INSERT INTO results VALUES (42)")?;
            entered.send(()).unwrap();
            gate.recv_timeout(DEADLINE).unwrap();
            db.execute_batch("COMMIT")?;
            Ok(())
        }));
        assert!(futures_util::poll!(&mut write).is_pending());
        tokio::time::timeout(DEADLINE, started)
            .await
            .unwrap()
            .unwrap();
        drop(write);
        owner.request_shutdown();
        owner.close_receipt()
    });
    drop(runtime);
    assert!(FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    release.send(()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(DEADLINE, receipt)
            .await
            .unwrap()
            .unwrap();
    });
    assert!(!FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    let db = Connection::open(directory.path().join("actor.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM results", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        42
    );
}

#[test]
#[expect(
    clippy::async_yields_async,
    reason = "The close receipt must outlive the caller runtime under test"
)]
fn accepted_typed_statement_survives_destruction_of_its_calling_runtime() {
    use crate::writeback::{Notification, Prepared, Statement};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Append {
        committed: Arc<AtomicUsize>,
    }
    impl Statement for Append {
        type Value = Arc<AtomicUsize>;
        type Output = ();
        fn execute(self, db: &Connection) -> Result<Prepared<Self::Value>, crate::StoreError> {
            db.execute("INSERT INTO results(value) VALUES (42)", [])?;
            Ok(Prepared {
                value: self.committed,
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(value: Self::Value) {
            value.fetch_add(1, Ordering::SeqCst);
        }
        fn isolated_rejection(_: &crate::StoreError) -> bool {
            false
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let committed = Arc::new(AtomicUsize::new(0));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (release, gate) = std::sync::mpsc::channel();
    let receipt = runtime.block_on(async {
        let owner = open(directory.path()).await;
        let (entered, started) = oneshot::channel();
        let mut holding_writer = Box::pin(owner.run(move |_| {
            entered.send(()).unwrap();
            gate.recv_timeout(DEADLINE).unwrap();
            Ok(())
        }));
        assert!(futures_util::poll!(&mut holding_writer).is_pending());
        tokio::time::timeout(DEADLINE, started)
            .await
            .unwrap()
            .unwrap();
        let mut append = Box::pin(owner.write(
            Append {
                committed: committed.clone(),
            },
            crate::commits::CommitHub::new(0).notice(),
        ));
        assert!(futures_util::poll!(&mut append).is_pending());
        assert_eq!(committed.load(Ordering::SeqCst), 0);
        drop(append);
        drop(holding_writer);
        owner.request_shutdown();
        owner.close_receipt()
    });
    drop(runtime);
    assert!(FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    assert_eq!(committed.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(DEADLINE, receipt)
            .await
            .unwrap()
            .unwrap();
    });
    assert_eq!(
        committed.load(Ordering::SeqCst),
        1,
        "the original typed conversion runs after confirmed commit despite losing its receiver"
    );
    assert!(!FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    let db = Connection::open(directory.path().join("actor.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM results", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        42
    );
}

#[tokio::test]
async fn cancelled_long_read_cleans_its_connection_and_leaves_writer_available() {
    let directory = tempfile::tempdir().unwrap();
    let owner = open(directory.path()).await;
    let (entered, started) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let (finished, cancelled) = oneshot::channel();
    // Keep the other readers occupied until the cancelled connection is reused.
    let mut parked = Vec::new();
    let mut parked_releases = Vec::new();
    for _ in 1..owner.reads.len() {
        let (entered, started) = oneshot::channel();
        let (release, gate) = std::sync::mpsc::channel();
        let mut job = Box::pin(owner.read(move |_| {
            entered.send(()).unwrap();
            gate.recv_timeout(DEADLINE).unwrap();
            Ok(())
        }));
        assert!(futures_util::poll!(&mut job).is_pending());
        tokio::time::timeout(DEADLINE, started)
            .await
            .unwrap()
            .unwrap();
        parked.push(job);
        parked_releases.push(release);
    }
    let mut read = Box::pin(owner.read_interruptible(move |db| {
        db.execute_batch("BEGIN; CREATE TEMP TABLE cancelled_probe(value INTEGER)")?;
        entered.send(()).unwrap();
        gate.recv_timeout(DEADLINE).unwrap();
        let result = db.query_row(
            "WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<1000000000) SELECT sum(value) FROM n",
            [],
            |row| row.get::<_, i64>(0),
        );
        finished.send(result.as_ref().err().and_then(rusqlite::Error::sqlite_error_code)).unwrap();
        Ok(result?)
    }));
    assert!(futures_util::poll!(&mut read).is_pending());
    tokio::time::timeout(DEADLINE, started)
        .await
        .unwrap()
        .unwrap();
    drop(read);
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(DEADLINE, cancelled)
            .await
            .unwrap()
            .unwrap(),
        Some(rusqlite::ErrorCode::OperationInterrupted)
    );
    let remaining = tokio::time::timeout(
        DEADLINE,
        owner.read(|db| {
            assert!(
                db.is_autocommit(),
                "cancelled read transaction was rolled back"
            );
            Ok(db.query_row(
                "SELECT count(*) FROM sqlite_temp_master WHERE name='cancelled_probe'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        remaining, 0,
        "cancelled transaction left no temporary table"
    );
    for release in parked_releases {
        release.send(()).unwrap();
    }
    for job in parked {
        tokio::time::timeout(DEADLINE, job).await.unwrap().unwrap();
    }
    owner
        .run(|db| {
            db.execute("INSERT INTO results VALUES (7)", [])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        owner
            .read(|db| Ok(
                db.query_row("SELECT value FROM results", [], |row| row.get::<_, i64>(0))?
            ))
            .await
            .unwrap(),
        7
    );
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_drains_accepted_read_that_still_needs_the_writer() {
    let directory = tempfile::tempdir().unwrap();
    let owner = open(directory.path()).await;
    let writer = owner.writer();
    let runtime = tokio::runtime::Handle::current();
    let (entered, started) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let mut read = Box::pin(owner.read(move |db| {
        entered.send(()).unwrap();
        gate.recv_timeout(DEADLINE).unwrap();
        runtime.block_on(writer.run(|db| {
            db.execute("INSERT INTO results VALUES (99)", [])?;
            Ok(())
        }))?;
        Ok(db.query_row("SELECT value FROM results", [], |row| row.get::<_, i64>(0))?)
    }));
    assert!(futures_util::poll!(&mut read).is_pending());
    tokio::time::timeout(DEADLINE, started)
        .await
        .unwrap()
        .unwrap();
    let mut shutdown = Box::pin(owner.shutdown());
    assert!(futures_util::poll!(&mut shutdown).is_pending());
    assert!(FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(DEADLINE, read).await.unwrap().unwrap(),
        99
    );
    tokio::time::timeout(DEADLINE, shutdown)
        .await
        .unwrap()
        .unwrap();
    assert!(!FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    let db = Connection::open(directory.path().join("actor.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM results", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        99
    );
}

#[tokio::test]
async fn prepared_run_keeps_its_place_before_later_plain_writes() {
    let directory = tempfile::tempdir().unwrap();
    let owner = open(directory.path()).await;
    owner
        .run(|db| {
            db.execute_batch("CREATE TABLE ordered_steps(step TEXT NOT NULL)")?;
            Ok(())
        })
        .await
        .unwrap();
    let (entered, started) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let mut prepared = Box::pin(owner.run_prepared(
        move || {
            entered.send(()).unwrap();
            gate.recv_timeout(DEADLINE).unwrap();
            Ok("prepared")
        },
        |db, step| {
            db.execute("INSERT INTO ordered_steps VALUES (?)", [step])?;
            Ok(())
        },
    ));
    assert!(futures_util::poll!(&mut prepared).is_pending());
    tokio::time::timeout(DEADLINE, started)
        .await
        .unwrap()
        .unwrap();
    let mut plain = Box::pin(owner.run(|db| {
        db.execute("INSERT INTO ordered_steps VALUES ('plain')", [])?;
        Ok(())
    }));
    assert!(futures_util::poll!(&mut plain).is_pending());
    release.send(()).unwrap();
    tokio::time::timeout(DEADLINE, prepared)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(DEADLINE, plain)
        .await
        .unwrap()
        .unwrap();
    let order = owner
        .read(|db| {
            let mut statement = db.prepare("SELECT step FROM ordered_steps ORDER BY rowid")?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(order, ["prepared", "plain"]);
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn prepared_run_checks_root_authority_after_preparation_finishes() {
    use crate::{
        StoreError,
        root::{ROOT_MARKER, RootNamespaces, RootOwner},
    };

    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let path = root.canonical_path().join("probe.sqlite");
    let marker = root.canonical_path().join(ROOT_MARKER);
    let owner = OwnedConnection::open(
        OpenOptions::file(&path).create(true),
        ConnectionAuthority::Root(root),
        |db| {
            db.execute_batch("CREATE TABLE results(value INTEGER NOT NULL)")?;
            Ok(())
        },
    )
    .await
    .unwrap();
    let (entered, started) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let mut prepared = Box::pin(owner.run_prepared(
        move || {
            entered.send(()).unwrap();
            gate.recv_timeout(DEADLINE).unwrap();
            Ok(42)
        },
        |db, value| {
            db.execute("INSERT INTO results VALUES (?)", [value])?;
            Ok(())
        },
    ));
    assert!(futures_util::poll!(&mut prepared).is_pending());
    tokio::time::timeout(DEADLINE, started)
        .await
        .unwrap()
        .unwrap();
    std::fs::remove_file(marker).unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        tokio::time::timeout(DEADLINE, prepared).await.unwrap(),
        Err(StoreError::Io(_))
    ));
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM results", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0,
        "preparation cannot preserve authority that disappeared before execution"
    );
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn short_reads_keep_using_the_idle_reader_while_another_read_is_held() {
    let directory = tempfile::tempdir().unwrap();
    let owner = open(directory.path()).await;
    let (entered, started) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let mut held = Box::pin(owner.read(move |db| {
        entered.send(()).unwrap();
        gate.recv_timeout(DEADLINE).unwrap();
        Ok(db.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?)
    }));
    assert!(futures_util::poll!(&mut held).is_pending());
    tokio::time::timeout(DEADLINE, started)
        .await
        .unwrap()
        .unwrap();
    for expected in [2, 3] {
        let actual = tokio::time::timeout(
            DEADLINE,
            owner.read(move |db| {
                Ok(db.query_row("SELECT ?", [expected], |row| row.get::<_, i64>(0))?)
            }),
        )
        .await
        .expect("short reads must complete before the held reader is released")
        .unwrap();
        assert_eq!(actual, expected);
    }
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(DEADLINE, held).await.unwrap().unwrap(),
        1
    );
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_rejects_a_read_waiting_for_a_reader_and_drains_accepted_reads() {
    let directory = tempfile::tempdir().unwrap();
    let owner = open(directory.path()).await;
    let (entered_first, started_first) = oneshot::channel();
    let (release_first, gate_first) = std::sync::mpsc::channel();
    let mut first = Box::pin(owner.read(move |db| {
        entered_first.send(()).unwrap();
        gate_first.recv_timeout(DEADLINE).unwrap();
        Ok(db.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?)
    }));
    assert!(futures_util::poll!(&mut first).is_pending());
    tokio::time::timeout(DEADLINE, started_first)
        .await
        .unwrap()
        .unwrap();
    let (entered_second, started_second) = oneshot::channel();
    let (release_second, gate_second) = std::sync::mpsc::channel();
    let mut second = Box::pin(owner.read(move |db| {
        entered_second.send(()).unwrap();
        gate_second.recv_timeout(DEADLINE).unwrap();
        Ok(db.query_row("SELECT 2", [], |row| row.get::<_, i64>(0))?)
    }));
    assert!(futures_util::poll!(&mut second).is_pending());
    tokio::time::timeout(DEADLINE, started_second)
        .await
        .unwrap()
        .unwrap();
    let mut waiting =
        Box::pin(owner.read(|db| Ok(db.query_row("SELECT 3", [], |row| row.get::<_, i64>(0))?)));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    let mut shutdown = Box::pin(owner.shutdown());
    assert!(futures_util::poll!(&mut shutdown).is_pending());
    assert!(matches!(
        tokio::time::timeout(DEADLINE, waiting).await.unwrap(),
        Err(crate::StoreError::ConnectionClosed)
    ));
    assert!(FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
    release_first.send(()).unwrap();
    release_second.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(DEADLINE, first)
            .await
            .unwrap()
            .unwrap(),
        1
    );
    assert_eq!(
        tokio::time::timeout(DEADLINE, second)
            .await
            .unwrap()
            .unwrap(),
        2
    );
    tokio::time::timeout(DEADLINE, shutdown)
        .await
        .unwrap()
        .unwrap();
    assert!(!FileLease::is_held(&directory.path().join("actor.lock")).unwrap());
}
