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

static MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub(crate) async fn initialize_connection(
    connection: &mut SqliteConnection,
) -> Result<(), StoreError> {
    initialize_connection_with_control(connection, None).await
}

pub(crate) async fn initialize_connection_with_control(
    connection: &mut SqliteConnection,
    control: Option<&crate::connection::control::ReadOnlyControl>,
) -> Result<(), StoreError> {
    let application_id: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&mut *connection)
        .await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await?;
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_one(&mut *connection)
    .await?;
    if !((application_id == 0 && version == 0 && tables == 0)
        || (application_id == 0x4d414b52 && matches!(version, 0..=1)))
    {
        return Err(StoreError::UnsupportedDatabase);
    }
    let ledger: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations')",
    )
    .fetch_one(&mut *connection)
    .await?;
    // Version zero is only a genuinely empty or interrupted initial setup.
    // Existing data is never adopted by creating a new migration ledger.
    if (version == 0 && tables != i64::from(ledger)) || (version == 1 && !ledger) {
        return Err(StoreError::UnsupportedDatabase);
    }
    if ledger {
        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&mut *connection)
            .await?;
        if (version == 0) != (applied == 0) {
            return Err(StoreError::UnsupportedDatabase);
        }
    }
    // Root partitions cannot own caller journals. Reject before migrations or
    // derived-index initialization can write to this original database.
    if control.is_some() {
        let has_intents: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name='application_intents' AND type='table')",
        )
        .fetch_one(&mut *connection)
        .await?;
        if has_intents
            && sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM main.application_intents)",
            )
            .fetch_one(&mut *connection)
            .await?
        {
            return Err(StoreError::UnsupportedDatabase);
        }
    }
    // Blob offsets address the canonical serializer's UTF-8 bytes.
    if tables == 0 {
        sqlx::query("PRAGMA encoding = 'UTF-8'")
            .execute(&mut *connection)
            .await?;
    }
    let encoding: String = sqlx::query_scalar("PRAGMA main.encoding")
        .fetch_one(&mut *connection)
        .await?;
    if encoding != "UTF-8" {
        return Err(StoreError::UnsupportedDatabase);
    }
    // A fresh file needs pointer-map pages before SQLx creates its first table.
    // Reclamation can then return space in small steps without a full VACUUM.
    if tables == 0 {
        sqlx::query("PRAGMA auto_vacuum = INCREMENTAL")
            .execute(&mut *connection)
            .await?;
    }
    // Establish Rust identity before SQLx creates its migration ledger, so a
    // crash before migration 1 is distinguishable from an unrelated database.
    if application_id == 0 {
        sqlx::query("PRAGMA application_id = 1296124754")
            .execute(&mut *connection)
            .await?;
    }
    crate::sqlite_functions::register(connection).await?;
    MIGRATIONS.run_direct(None, &mut *connection, false).await?;
    sqlx::raw_sql(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA temp_store = FILE;",
    )
    .execute(&mut *connection)
    .await?;
    // Migrations create the standalone main table; derived Session reads must
    // resolve the root's live bindings before rebuilding any execution state.
    crate::connection::control::initialize_views(connection, control).await?;
    crate::message_sources::initialize(connection).await?;
    crate::sessions::initialize_execution(connection).await?;
    Ok(())
}

#[cfg(test)]
mod fixtures;
#[cfg(test)]
pub(crate) use fixtures::schema as fixture;

#[cfg(test)]
mod payload_migration_tests;
