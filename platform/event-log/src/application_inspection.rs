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

//! Existing application inspection under the original Root and database leases.

use std::path::Path;

use sqlx::{
    SqliteConnection,
    sqlite::{SqliteConnectOptions, SqliteLockingMode},
};

use crate::{StoreError, connection::BoxFuture};

pub(super) fn options(path: &Path) -> Result<SqliteConnectOptions, StoreError> {
    // The caller holds both original leases before examining this representation.
    // Immutable would omit committed WAL facts, while an ordinary read-only WAL
    // open can modify SHM. Exclusive WAL indexing stays in connection-local memory.
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let wal_present = match Path::new(&wal).symlink_metadata() {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .query_planner_stability(true);
    Ok(if wal_present {
        // The native exclusive lock requires a write-capable descriptor. The
        // initializer enforces query_only before any database read.
        options
            .read_only(false)
            .locking_mode(SqliteLockingMode::Exclusive)
    } else {
        options.read_only(true).immutable(true)
    })
}

pub(super) fn initialize(
    connection: &mut SqliteConnection,
) -> BoxFuture<'_, Result<(), StoreError>> {
    Box::pin(async move {
        // Only locking_mode/foreign_keys memory settings precede this callback.
        // Suppress close checkpointing before query_only or any database read,
        // including when a later validation fails and startup closes the handle.
        {
            let mut handle = connection.lock_handle().await?;
            let mut enabled: std::ffi::c_int = 0;
            // SAFETY: SQLx excludes worker FFI while the guard holds the live
            // handle. SQLite writes one int to enabled; no pointer escapes.
            let result = unsafe {
                rusqlite::ffi::sqlite3_db_config(
                    handle.as_raw_handle().as_ptr(),
                    rusqlite::ffi::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                    1_i32,
                    &mut enabled as *mut std::ffi::c_int,
                )
            };
            if result != rusqlite::ffi::SQLITE_OK || enabled != 1 {
                return Err(StoreError::InvalidTransition(format!(
                    "application inspection could not disable close checkpoints (SQLite {result})"
                )));
            }
        }
        sqlx::query("PRAGMA query_only = ON")
            .execute(&mut *connection)
            .await?;
        let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
            .fetch_one(&mut *connection)
            .await?;
        if query_only != 1 {
            return Err(StoreError::InvalidTransition(
                "application inspection requires query-only SQL".into(),
            ));
        }
        let application_id: i64 = sqlx::query_scalar("PRAGMA application_id")
            .fetch_one(&mut *connection)
            .await?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut *connection)
            .await?;
        if application_id != 0x4d414b52 || version != 1 {
            return Err(StoreError::UnsupportedDatabase);
        }
        Ok(())
    })
}
