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

use rusqlite::Connection as SqliteConnection;

use crate::StoreError;

/// Base Root schema; products compose this with their domain migrations.
pub const ROOT_MIGRATIONS: &[crate::migration::Migration] = &[
    crate::migration::Migration {
        version: 1,
        description: "runtime",
        sql: include_str!("../migrations/0001_runtime.sql"),
    },
    crate::migration::Migration {
        version: 23,
        description: "plugin_data_live",
        sql: include_str!("../migrations/0023_plugin_data_live.sql"),
    },
];

pub(crate) fn initialize_connection(
    connection: &SqliteConnection,
    catalog: &[crate::migration::Migration],
) -> Result<(), StoreError> {
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", rusqlite::params![], |row| {
            row.get(0)
        })?;
    let version: i64 =
        connection.query_row("PRAGMA user_version", rusqlite::params![], |row| row.get(0))?;
    let tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        rusqlite::params![],
        |row| row.get(0),
    )?;
    if !((application_id == 0 && version == 0 && tables == 0)
        || (application_id == 0x4d414b52 && matches!(version, 0..=1)))
    {
        return Err(StoreError::UnsupportedDatabase);
    }
    let ledger: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations')", rusqlite::params![], |row| row.get(0))?;
    // Version zero is only a genuinely empty or interrupted initial setup.
    // Existing data is never adopted by creating a new migration ledger.
    if (version == 0 && tables != i64::from(ledger)) || (version == 1 && !ledger) {
        return Err(StoreError::UnsupportedDatabase);
    }
    if ledger {
        let applied: i64 = connection.query_row(
            "SELECT COUNT(*) FROM _sqlx_migrations",
            rusqlite::params![],
            |row| row.get(0),
        )?;
        if (version == 0) != (applied == 0) {
            return Err(StoreError::UnsupportedDatabase);
        }
    }
    // Blob offsets address the canonical serializer's UTF-8 bytes.
    if tables == 0 {
        connection.execute("PRAGMA encoding = 'UTF-8'", rusqlite::params![])?;
    }
    let encoding: String =
        connection.query_row("PRAGMA main.encoding", rusqlite::params![], |row| {
            row.get(0)
        })?;
    if encoding != "UTF-8" {
        return Err(StoreError::UnsupportedDatabase);
    }
    // A fresh file needs pointer-map pages before the migration runner creates its first table.
    // Reclamation can then return space in small steps without a full VACUUM.
    if tables == 0 {
        connection.execute("PRAGMA auto_vacuum = INCREMENTAL", rusqlite::params![])?;
    }
    // Establish Rust identity before the migration runner creates its migration ledger, so a
    // crash before migration 1 is distinguishable from an unrelated database.
    if application_id == 0 {
        connection.execute_batch("PRAGMA application_id = 1296124754")?;
    }
    crate::migration::run(connection, catalog)?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA temp_store = FILE;",
    )?;
    Ok(())
}
