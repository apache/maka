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

//! Observations of original actors, attached databases and live prepared statements.
use super::{OwnedConnection, ReadEnvelope, ReadJob, SqliteConnection, StoreError, worker_query};
use futures_util::FutureExt;
use serde::Serialize;
use sqlx::Connection;
use std::panic::AssertUnwindSafe;
use tokio::sync::{mpsc, oneshot};

/// One live prepared statement, without bound values. SQLite's raw signed
/// 32-bit counters can wrap; observations never reset or widen them.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SqliteStatementStats {
    /// Ephemeral identity; meaningful only while this original statement lives.
    pub statement_id: usize,
    pub sql: Option<String>,
    pub runs: i32,
    pub vm_steps: i32,
    pub reprepares: i32,
}

#[derive(Debug, Serialize)]
pub struct SqliteResourceStats {
    /// Ephemeral identity for comparing observations within this process only.
    pub connection_id: usize,
    pub cached_statements: usize,
    pub cache_bytes: i32,
    pub schema_bytes: i32,
    pub statement_bytes: i32,
    pub lookaside_slots: i32,
    pub cache_hits: i32,
    pub cache_misses: i32,
    pub cache_spills: i32,
    pub statements: Vec<SqliteStatementStats>,
}

#[derive(Debug, Serialize)]
pub struct ConnectionResourceStats {
    pub writer: SqliteResourceStats,
    /// Physical reader slots in order; uninitialized connections remain absent.
    pub readers: [Option<SqliteResourceStats>; 2],
}

async fn observe(connection: &mut SqliteConnection) -> Result<SqliteResourceStats, StoreError> {
    let cached_statements = connection.cached_statements_size();
    worker_query(connection, move |worker| {
        Box::pin(async move {
            let handle = worker.as_raw_handle();
            let status = |operation| -> Result<i32, StoreError> {
                let (mut current, mut high_water) = (0, 0);
                // SAFETY: the original SQLite worker exclusively owns this open handle.
                // SQLite writes only these local integers; reset=0 leaves counters intact.
                let code = unsafe {
                    rusqlite::ffi::sqlite3_db_status(
                        handle.as_ptr(),
                        operation,
                        &mut current,
                        &mut high_water,
                        0,
                    )
                };
                if code != rusqlite::ffi::SQLITE_OK {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(code),
                        None,
                    )
                    .into());
                }
                Ok(current)
            };
            let mut statements = Vec::new();
            let mut statement = std::ptr::null_mut();
            // SAFETY: this worker exclusively owns the open connection and its
            // statements. SQL bytes are copied before advancing; no SQLite-backed
            // pointer escapes. Every statement status uses reset=0.
            unsafe {
                loop {
                    statement = rusqlite::ffi::sqlite3_next_stmt(handle.as_ptr(), statement);
                    if statement.is_null() {
                        break;
                    }
                    let sql = rusqlite::ffi::sqlite3_sql(statement);
                    statements.push(SqliteStatementStats {
                        statement_id: statement as usize,
                        sql: (!sql.is_null())
                            .then(|| std::ffi::CStr::from_ptr(sql).to_string_lossy().into_owned()),
                        runs: rusqlite::ffi::sqlite3_stmt_status(
                            statement,
                            rusqlite::ffi::SQLITE_STMTSTATUS_RUN,
                            0,
                        ),
                        vm_steps: rusqlite::ffi::sqlite3_stmt_status(
                            statement,
                            rusqlite::ffi::SQLITE_STMTSTATUS_VM_STEP,
                            0,
                        ),
                        reprepares: rusqlite::ffi::sqlite3_stmt_status(
                            statement,
                            rusqlite::ffi::SQLITE_STMTSTATUS_REPREPARE,
                            0,
                        ),
                    });
                }
            }
            Ok(SqliteResourceStats {
                connection_id: handle.as_ptr() as usize,
                cached_statements,
                cache_bytes: status(rusqlite::ffi::SQLITE_DBSTATUS_CACHE_USED)?,
                schema_bytes: status(rusqlite::ffi::SQLITE_DBSTATUS_SCHEMA_USED)?,
                statement_bytes: status(rusqlite::ffi::SQLITE_DBSTATUS_STMT_USED)?,
                lookaside_slots: status(rusqlite::ffi::SQLITE_DBSTATUS_LOOKASIDE_USED)?,
                cache_hits: status(rusqlite::ffi::SQLITE_DBSTATUS_CACHE_HIT)?,
                cache_misses: status(rusqlite::ffi::SQLITE_DBSTATUS_CACHE_MISS)?,
                cache_spills: status(rusqlite::ffi::SQLITE_DBSTATUS_CACHE_SPILL)?,
                statements,
            })
        })
    })
    .await
}

impl OwnedConnection {
    /// Observe writer and both reader slots without opening unused connections.
    /// Byte counts include every database attached to each connection.
    pub async fn resource_stats(&self) -> Result<ConnectionResourceStats, StoreError> {
        let reader = |jobs: mpsc::Sender<ReadEnvelope>,
                      admission: std::sync::Arc<tokio::sync::Semaphore>| async move {
            let permit = admission
                .acquire_owned()
                .await
                .map_err(|_| StoreError::ConnectionClosed)?;
            let (reply, result) = oneshot::channel();
            jobs.send(ReadEnvelope {
                custody: self.custody.clone(),
                job: ReadJob::Observe(Box::new(move |_, connection| {
                    Box::pin(async move {
                        let _permit = permit;
                        let stats = AssertUnwindSafe(async {
                            match connection {
                                Ok(Some(connection)) => observe(connection).await.map(Some),
                                Ok(None) => Ok(None),
                                Err(error) => Err(error),
                            }
                        })
                        .catch_unwind()
                        .await;
                        let reusable = !matches!(
                            &stats,
                            Err(_) | Ok(Err(StoreError::Sqlx(sqlx::Error::WorkerCrashed)))
                        );
                        let _ = reply.send(stats.unwrap_or(Err(StoreError::OperationUnknown)));
                        reusable
                    })
                })),
            })
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
            result.await.map_err(|_| StoreError::OperationUnknown)?
        };
        let (pure, observation, writer) = tokio::try_join!(
            reader(self.read_jobs.clone(), self.readers.clone()),
            reader(self.observation_jobs.clone(), self.observations.clone()),
            self.run(|connection| Box::pin(observe(connection))),
        )?;
        let readers = [pure, observation];
        Ok(ConnectionResourceStats { writer, readers })
    }
}
