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

use crate::{ConfigError, Result};
use maka_event_log::migration::{self, Migration};
use maka_event_log::{
    StoreError,
    connection::{ConnectionAuthority, OpenOptions as ConnectionOptions, OwnedConnection},
    root::RootOwner,
};
use rusqlite::Connection;
#[cfg(not(windows))]
use std::fs::OpenOptions;
use std::sync::Arc;

static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "configuration",
        sql: include_str!("../migrations/0001_configuration.sql"),
    },
    Migration {
        version: 2,
        description: "message predictions",
        sql: include_str!("../migrations/0002_message_predictions.sql"),
    },
];

pub(crate) fn unsigned(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(|_| ConfigError::Invalid("negative database revision".into()))
}

pub(super) async fn open(owner: Arc<RootOwner>) -> Result<OwnedConnection> {
    let path = owner.canonical_path().join("configuration-rust.sqlite");
    #[cfg(not(windows))]
    let file = {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        options.open(&path)?
    };
    #[cfg(windows)]
    let file = {
        use maka_event_log::root::windows::{
            create_private_file, file_identity, open_nofollow, validate_private,
        };
        let file = match create_private_file(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                open_nofollow(&path, true)?
            }
            Err(error) => return Err(error.into()),
        };
        validate_private(&file)?;
        if !file.metadata()?.is_file() || file_identity(&file)?.links != 1 {
            return Err(ConfigError::Invalid(
                "credential database must be private and singly linked".into(),
            ));
        }
        file
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(ConfigError::Invalid(
                "credential database must be private and singly linked".into(),
            ));
        }
    }
    owner.validate_current()?;
    let connection = OwnedConnection::open(
        ConnectionOptions::file(path),
        ConnectionAuthority::Root(owner),
        |connection| initialize(connection),
    )
    .await?;
    drop(file);
    Ok(connection)
}

fn initialize(connection: &Connection) -> std::result::Result<(), StoreError> {
    // Native plugin owners may open this Root concurrently. Hold the actual
    // database writer transaction across schema inspection and migration.
    let tx =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    initialize_schema(&tx)?;
    tx.commit()?;
    // Bounded configuration transactions do not need to change the persistent
    // journal mode. Switching to WAL here would race another opening writer.
    connection.execute_batch("PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;")?;
    crate::pricing::initialize(connection)?;
    Ok(())
}

fn initialize_schema(connection: &Connection) -> std::result::Result<(), StoreError> {
    let application_id: i64 = connection
        .prepare_cached("PRAGMA application_id")?
        .query_row(rusqlite::params![], |row| row.get(0))?;
    let version: i64 = connection
        .prepare_cached("PRAGMA user_version")?
        .query_row(rusqlite::params![], |row| row.get(0))?;
    let tables: i64 = connection
        .prepare_cached(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?
        .query_row(rusqlite::params![], |row| row.get(0))?;
    if !((application_id == 0 && version == 0 && tables == 0)
        || (application_id == 0x4d414b43 && matches!(version, 0..=1)))
    {
        return Err(StoreError::UnsupportedDatabase);
    }
    let ledger: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations')")?.query_row(rusqlite::params![], |row| row.get(0))?;
    if (version == 0 && tables != i64::from(ledger)) || (version == 1 && !ledger) {
        return Err(StoreError::UnsupportedDatabase);
    }
    if ledger {
        let applied: i64 = connection
            .prepare_cached("SELECT COUNT(*) FROM _sqlx_migrations")?
            .query_row(rusqlite::params![], |row| row.get(0))?;
        if (version == 0) != (applied == 0) {
            return Err(StoreError::UnsupportedDatabase);
        }
    }
    // Stamp identity before creating the ledger so interrupted setup can retry.
    if application_id == 0 {
        connection.execute("PRAGMA application_id = 1296124739", rusqlite::params![])?;
    }
    migration::run(connection, MIGRATIONS)?;
    Ok(())
}
