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

use sqlx::SqliteConnection;

use crate::StoreError;

/// Startup only, before installing application hooks. rusqlite supplies its
/// safe scalar-function trampoline; SQLx retains sole connection ownership and
/// executes the SQL. No borrowed wrapper or statement may escape this scope.
pub(crate) async fn register(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    let mut locked = connection.lock_handle().await?;
    // SAFETY: SQLx's guard prevents every worker FFI call while this borrowed
    // non-owning handle exists. Both crates share libsqlite3-sys's sqlite3 type
    // (no cast); from_handle does not close the underlying connection. Only
    // Send + 'static UDFs are registered, and no await occurs before wrapper
    // drop. SQLite owns their closures until replacement or connection close.
    let borrowed = unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }?;
    let registered = crate::sessions::register_functions(&borrowed)
        .and_then(|()| crate::message_identity::register(&borrowed))
        .and_then(|()| crate::transcript::navigation::register(&borrowed))
        .and_then(|()| crate::context::evidence::register(&borrowed));
    // rusqlite 0.39 removes hooks only for an owned connection; this borrowed
    // wrapper leaves SQLx's connection and hooks intact.
    drop(borrowed);
    registered
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;
    use std::time::{Duration, UNIX_EPOCH};

    async fn planner_stability(connection: &mut SqliteConnection) -> bool {
        let mut handle = connection.lock_handle().await.unwrap();
        // SAFETY: the guard excludes worker calls and the borrowed wrapper drops
        // before releasing it. Configuration observation changes no state.
        let borrowed =
            unsafe { rusqlite::Connection::from_handle(handle.as_raw_handle().as_ptr()) }.unwrap();
        borrowed
            .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG)
            .unwrap()
    }

    async fn reprepares(connection: &mut SqliteConnection, query: &str) -> i32 {
        let mut handle = connection.lock_handle().await.unwrap();
        // SAFETY: the guard exclusively owns every inspected statement; SQL and
        // nonreset status are read before moving on. No native pointer escapes.
        unsafe {
            let mut statement = rusqlite::ffi::sqlite3_next_stmt(
                handle.as_raw_handle().as_ptr(),
                std::ptr::null_mut(),
            );
            while !statement.is_null() {
                let sql = rusqlite::ffi::sqlite3_sql(statement);
                if !sql.is_null() && std::ffi::CStr::from_ptr(sql).to_bytes() == query.as_bytes() {
                    return rusqlite::ffi::sqlite3_stmt_status(
                        statement,
                        rusqlite::ffi::SQLITE_STMTSTATUS_REPREPARE,
                        0,
                    );
                }
                statement =
                    rusqlite::ffi::sqlite3_next_stmt(handle.as_raw_handle().as_ptr(), statement);
            }
        }
        panic!("expected query in original statement cache: {query}")
    }

    #[tokio::test]
    async fn planner_stability_is_opt_in_and_pool_replacements_inherit_it() {
        let mut default = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        register(&mut default).await.unwrap();
        assert!(
            !planner_stability(&mut default).await,
            "function registration must not silently change planner policy"
        );
        default.close().await.unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .query_planner_stability(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        for _ in 0..2 {
            let mut connection = pool.acquire().await.unwrap();
            assert!(planner_stability(&mut connection).await);
            connection.close().await.unwrap();
        }
        pool.close().await;
        let mut clone = SqliteConnection::connect_with(&options).await.unwrap();
        assert!(planner_stability(&mut clone).await);
        clone.close().await.unwrap();
    }

    #[tokio::test]
    async fn sqlx_uses_registered_functions_after_borrowed_wrapper_drops() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        register(&mut connection).await.unwrap();
        let prefix = format!("\u{feff}\t{} trailing", "😀".repeat(100));
        let preview: String = sqlx::query_scalar("SELECT catalog_preview(?)")
            .bind(prefix)
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(preview, format!("{}…", "😀".repeat(95)));
        let preview: String = sqlx::query_scalar("SELECT catalog_preview(?)")
            .bind("\u{feff} \tA\u{85} B ")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(preview, "A\u{85} B");
        let empty: Option<String> = sqlx::query_scalar("SELECT catalog_preview(NULL)")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(empty, None);
        let time = serde_json::to_string(&(UNIX_EPOCH + Duration::from_micros(1_234_567))).unwrap();
        let millis: i64 = sqlx::query_scalar("SELECT catalog_time(?)")
            .bind(time)
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(millis, 1234);
        assert!(
            sqlx::query_scalar::<_, i64>("SELECT catalog_time('{}')")
                .fetch_one(&mut connection)
                .await
                .is_err()
        );
        connection.close().await.unwrap();
    }

    #[tokio::test]
    async fn fixed_plans_release_bound_payloads_and_still_follow_schema_changes() {
        let mut connection = SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .in_memory(true)
                .query_planner_stability(true),
        )
        .await
        .unwrap();
        register(&mut connection).await.unwrap();
        const SQL: &str = "SELECT length(?1)";
        let bytes = 4 * 1024 * 1024;
        let length: i64 = sqlx::query_scalar(SQL)
            .bind("x".repeat(bytes))
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(length, bytes as i64);
        {
            let mut handle = connection.lock_handle().await.unwrap();
            // SAFETY: the guard owns all statement access; expanded SQL is freed
            // before releasing it and no database-owned pointer escapes.
            unsafe {
                let db = handle.as_raw_handle().as_ptr();
                let borrowed = rusqlite::Connection::from_handle(db).unwrap();
                assert!(
                    borrowed
                        .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG)
                        .unwrap()
                );
                let mut statement = rusqlite::ffi::sqlite3_next_stmt(db, std::ptr::null_mut());
                while !statement.is_null() {
                    let sql = rusqlite::ffi::sqlite3_sql(statement);
                    if !sql.is_null() && std::ffi::CStr::from_ptr(sql).to_bytes() == SQL.as_bytes()
                    {
                        let expanded = rusqlite::ffi::sqlite3_expanded_sql(statement);
                        assert!(!expanded.is_null());
                        let released =
                            std::ffi::CStr::from_ptr(expanded).to_bytes() == b"SELECT length(NULL)";
                        rusqlite::ffi::sqlite3_free(expanded.cast());
                        assert!(
                            released,
                            "completed statements must release their bound payloads"
                        );
                        break;
                    }
                    statement = rusqlite::ffi::sqlite3_next_stmt(db, statement);
                }
                assert!(
                    !statement.is_null(),
                    "query must remain cached after clearing its payload"
                );
            }
        }
        sqlx::raw_sql("CREATE TABLE records(value INTEGER); INSERT INTO records VALUES(7);")
            .execute(&mut connection)
            .await
            .unwrap();
        const RECORDS: &str = "SELECT value FROM records ORDER BY value";
        let first: Vec<i64> = sqlx::query_scalar(RECORDS)
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(first, [7]);
        let before = reprepares(&mut connection, RECORDS).await;
        sqlx::raw_sql(
            "ALTER TABLE records ADD COLUMN extra TEXT; INSERT INTO records(value) VALUES(9);",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let second: Vec<i64> = sqlx::query_scalar(RECORDS)
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(second, [7, 9]);
        assert!(
            reprepares(&mut connection, RECORDS).await > before,
            "schema changes must still invalidate the cached plan"
        );
        connection.close().await.unwrap();
    }
}
