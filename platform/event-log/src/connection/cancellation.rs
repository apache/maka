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
use std::time::Duration;

const LONG_QUERY: &str = "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT sum(x) FROM n";

#[tokio::test]
async fn manual_preflight_waits_for_read_capacity_without_blocking_writes() {
    let directory = tempfile::tempdir().unwrap();
    let log = crate::EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let through = *log.subscribe_commits().borrow();
    let readers = log.connection.readers.acquire().await.unwrap();
    let mut check = Box::pin(log.check_manual_message_history("session"));
    assert!(futures_util::poll!(&mut check).is_pending());
    tokio::time::timeout(
        Duration::from_secs(5),
        log.create_session("session", "manual", &serde_json::json!({"saved":true}), 1),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(futures_util::poll!(&mut check).is_pending());
    drop(check);
    drop(readers);
    assert!(!log.check_manual_message_history("session").await.unwrap());
    assert_eq!(
        log.get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .map(|record| record.configuration),
        Some(serde_json::json!({"saved":true}))
    );
    assert_eq!(*log.subscribe_commits().borrow(), through);
    log.close().await.unwrap();
}

async fn owner(directory: &std::path::Path) -> Arc<OwnedConnection> {
    let lease = Arc::new(crate::root::FileLease::acquire(&directory.join("writer.lock")).unwrap());
    Arc::new(OwnedConnection::open(
        SqliteConnectOptions::new().filename(directory.join("cancel.sqlite")).create_if_missing(true),
        ConnectionAuthority::Writer { lease, root: None },
        |connection| Box::pin(async move {
            sqlx::raw_sql("PRAGMA journal_mode=WAL; CREATE TABLE facts(value INTEGER); INSERT INTO facts VALUES(1);").execute(connection).await?;
            Ok(())
        }),
    ).await.unwrap())
}

// Exercise both cancellation between statements and inside a nested SQL UDF.
// Both readers must be reclaimed, retain their connection settings, and leave
// their old transactions before observing the writer's subsequent commit.
#[tokio::test]
async fn cancelled_reads_reclaim_both_slots_and_rollback_before_reuse() {
    for nested in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let owner = owner(directory.path()).await;
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let mut callers = Vec::new();
        let mut completions = Vec::new();
        let mut udf_releases = Vec::new();
        for role in [ReaderRole::Read, ReaderRole::Observation] {
            let reader = owner.clone();
            let entered = entered.clone();
            let release = release.clone();
            let (udf_release, udf_gate) = std::sync::mpsc::channel();
            udf_releases.push(udf_release);
            let (done, completed) = oneshot::channel();
            completions.push(completed);
            callers.push(tokio::spawn(async move {
                reader
                    .read_job(role, move |connection| {
                        Box::pin(async move {
                            sqlx::query("PRAGMA cache_size=-1234")
                                .execute(&mut *connection)
                                .await?;
                            if nested {
                                let mut locked = connection.lock_handle().await?;
                                // SAFETY: SQLx excludes all worker calls during registration;
                                // the borrowed wrapper does not own or close the handle.
                                let borrowed = unsafe {
                                    rusqlite::Connection::from_handle(
                                        locked.as_raw_handle().as_ptr(),
                                    )
                                }?;
                                let entered = entered.clone();
                                borrowed.create_scalar_function(
                                    "nested_read",
                                    0,
                                    rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                                    move |context| {
                                        entered.add_permits(1);
                                        udf_gate.recv_timeout(Duration::from_secs(10)).unwrap();
                                        // SAFETY: synchronous read-only use within this SQLite callback.
                                        let connection = unsafe { context.get_connection() }?;
                                        let result = connection.query_row(LONG_QUERY, [], |row| row.get::<_, i64>(0));
                                        assert!(matches!(&result, Err(rusqlite::Error::SqliteFailure(error, _)) if error.extended_code == 9));
                                        result
                                    },
                                )?;
                            }
                            let mut tx = connection.begin().await?;
                            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM facts")
                                .fetch_one(&mut *tx)
                                .await?;
                            assert_eq!(count, 1);
                            if !nested {
                                entered.add_permits(1);
                                release.acquire().await.unwrap().forget();
                            }
                            let result = sqlx::query_scalar::<_, i64>(if nested {
                                "SELECT nested_read()"
                            } else {
                                LONG_QUERY
                            })
                            .fetch_one(&mut *tx)
                            .await;
                            let error = result.as_ref().unwrap_err().as_database_error().unwrap();
                            assert_eq!(error.code().as_deref(), Some(if nested { "1" } else { "9" }));
                            assert_eq!(error.message(), "interrupted");
                            let _ = done.send(());
                            result?;
                            tx.commit().await?;
                            Ok(())
                        })
                    }, true)
                    .await
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), entered.acquire_many(2))
            .await
            .unwrap()
            .unwrap()
            .forget();
        for caller in callers {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
        }
        // Writer remains independent while both readers are paused in snapshots.
        owner
            .run(|connection| {
                Box::pin(async move {
                    sqlx::query("INSERT INTO facts VALUES(2)")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        release.add_permits(2);
        for gate in udf_releases {
            let _ = gate.send(());
        }
        for done in completions {
            tokio::time::timeout(Duration::from_secs(5), done)
                .await
                .unwrap()
                .unwrap();
        }
        let occupied = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let mut readers = Vec::new();
        for role in [ReaderRole::Read, ReaderRole::Observation] {
            let owner = owner.clone();
            let occupied = occupied.clone();
            let release = release.clone();
            readers.push(tokio::spawn(async move {
                owner
                    .read_job(
                        role,
                        move |connection| {
                            Box::pin(async move {
                                let marker: i64 = sqlx::query_scalar("PRAGMA cache_size")
                                    .fetch_one(&mut *connection)
                                    .await?;
                                let mut tx = connection.begin().await?;
                                let count: i64 = sqlx::query_scalar("SELECT count(*) FROM facts")
                                    .fetch_one(&mut *tx)
                                    .await?;
                                occupied.add_permits(1);
                                release.acquire().await.unwrap().forget();
                                tx.commit().await?;
                                Ok((marker, count))
                            })
                        },
                        true,
                    )
                    .await
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), occupied.acquire_many(2))
            .await
            .unwrap()
            .unwrap()
            .forget();
        release.add_permits(2);
        for reader in readers {
            assert_eq!(reader.await.unwrap().unwrap(), (-1234, 2));
        }
        owner.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn cancelled_read_still_drains_before_shutdown_releases_authority() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path()).await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let reader = owner.clone();
    let entered_job = entered.clone();
    let release_job = release.clone();
    let caller = tokio::spawn(async move {
        reader
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    sqlx::query("SELECT * FROM facts").execute(&mut *tx).await?;
                    entered_job.add_permits(1);
                    release_job.acquire().await.unwrap().forget();
                    let result = sqlx::query_scalar::<_, i64>(LONG_QUERY)
                        .fetch_one(&mut *tx)
                        .await;
                    assert!(matches!(&result, Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("9")));
                    Ok(())
                })
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let closing = owner.clone();
    let shutdown = tokio::spawn(async move { closing.shutdown().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), owner.closed.clone())
            .await
            .is_err()
    );
    assert!(crate::root::FileLease::acquire(&directory.path().join("writer.lock")).is_err());
    release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(crate::root::FileLease::acquire(&directory.path().join("writer.lock")).is_ok());
}
