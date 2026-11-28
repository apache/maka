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

//! Synchronous schema migrations with the existing SQLite migration ledger.

use crate::StoreError;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha384};
use std::{collections::BTreeMap, time::Instant};

pub type ConfigureConnection = fn(&Connection) -> Result<(), StoreError>;
pub type MigrateData = fn(&Connection) -> Result<(), StoreError>;

/// An immutable schema migration and its ledger identity.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Version stored in the migration ledger.
    pub version: i64,
    /// Human-readable ledger description.
    pub description: &'static str,
    /// SQL whose exact bytes determine the migration checksum.
    pub sql: &'static str,
    /// Prepare each writer inside the migration savepoint before ledger validation.
    pub configure: Option<ConfigureConnection>,
    /// Optional in-place Rust data rewrite executed inside the migration savepoint
    /// right after `sql`, before the ledger entry is recorded.
    pub data: Option<MigrateData>,
}

impl Migration {
    pub const fn sql(version: i64, description: &'static str, sql: &'static str) -> Self {
        Self {
            version,
            description,
            sql,
            configure: None,
            data: None,
        }
    }

    pub const fn with_configure(mut self, configure: ConfigureConnection) -> Self {
        self.configure = Some(configure);
        self
    }

    pub const fn with_data(mut self, data: MigrateData) -> Self {
        self.data = Some(data);
        self
    }
}

/// Compute the SHA384 checksum recorded by the migration ledger.
pub fn checksum(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.as_bytes()).to_vec()
}

/// Validate the ledger and apply pending migrations atomically.
///
/// The savepoint composes with an existing transaction without committing it.
///
/// # Errors
/// Returns an error for dirty, unknown, or changed applied migrations, or when
/// SQLite cannot execute or record a migration.
pub fn run(connection: &Connection, migrations: &[Migration]) -> Result<(), StoreError> {
    connection.execute_batch("SAVEPOINT maka_schema_migrations")?;
    let result = apply(connection, migrations).and_then(|()| {
        connection.execute_batch("RELEASE maka_schema_migrations")?;
        Ok(())
    });
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            connection
                .execute_batch("ROLLBACK TO maka_schema_migrations; RELEASE maka_schema_migrations")
                .map_err(|rollback| {
                    StoreError::Migration(format!(
                        "{error}; rolling back migrations failed: {rollback}"
                    ))
                })?;
            Err(error)
        }
    }
}

fn apply(connection: &Connection, migrations: &[Migration]) -> Result<(), StoreError> {
    for configure in migrations.iter().filter_map(|m| m.configure) {
        configure(connection)?;
    }
    let mut ordered = migrations.to_vec();
    ordered.sort_by_key(|migration| migration.version);
    for pair in ordered.windows(2) {
        if pair[0].version == pair[1].version {
            return Err(StoreError::Migration(format!(
                "duplicate migration version {}",
                pair[0].version
            )));
        }
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )?;
    let dirty: Option<i64> = connection
        .prepare_cached(
            "SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1",
        )?
        .query_row([], |row| row.get(0))
        .optional()?;
    if let Some(version) = dirty {
        return Err(StoreError::Migration(format!(
            "migration {version} is partially applied"
        )));
    }
    let applied = connection
        .prepare_cached("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    for version in applied.keys() {
        if ordered
            .binary_search_by_key(version, |migration| migration.version)
            .is_err()
        {
            return Err(StoreError::Migration(format!(
                "applied migration {version} is missing from the available migrations"
            )));
        }
    }
    for migration in &ordered {
        let checksum = checksum(migration.sql);
        if let Some(previous) = applied.get(&migration.version) {
            if *previous != checksum {
                return Err(StoreError::Migration(format!(
                    "migration {} was previously applied with a different checksum",
                    migration.version
                )));
            }
            continue;
        }
        let started = Instant::now();
        connection.execute_batch(migration.sql)?;
        if let Some(data) = migration.data {
            data(connection)?;
        }
        let execution_time = started.elapsed().as_nanos() as i64;
        connection.execute(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (?1, ?2, TRUE, ?3, ?4)",
            params![
                migration.version,
                migration.description,
                checksum,
                execution_time
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{Transaction, TransactionBehavior};

    const BASE: Migration = Migration {
        version: 1,
        description: "base",
        sql: "CREATE TABLE migrated(value INTEGER);",
        configure: None,
        data: None,
    };

    fn migrated_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        run(&connection, &[BASE]).unwrap();
        connection
    }

    #[test]
    fn applies_migrations_in_version_order_and_rejects_duplicates() {
        let connection = Connection::open_in_memory().unwrap();
        let out_of_order = [
            Migration::sql(3, "third", "INSERT INTO log VALUES (3);"),
            Migration::sql(
                1,
                "first",
                "CREATE TABLE log(v INTEGER); INSERT INTO log VALUES (1);",
            ),
            Migration::sql(2, "second", "INSERT INTO log VALUES (2);"),
        ];
        run(&connection, &out_of_order).unwrap();
        let values: Vec<i64> = connection
            .prepare("SELECT v FROM log ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(values, [1, 2, 3]);

        let dup = [
            Migration::sql(1, "a", "SELECT 1;"),
            Migration::sql(1, "b", "SELECT 1;"),
        ];
        let err = run(&Connection::open_in_memory().unwrap(), &dup).unwrap_err();
        assert!(matches!(err, StoreError::Migration(_)), "{err:?}");
    }

    #[test]
    fn applies_pending_migrations_once() {
        let connection = migrated_database();
        let migrations = [
            BASE,
            Migration {
                version: 2,
                description: "populate",
                sql: "INSERT INTO migrated VALUES (7);",
                configure: None,
                data: None,
            },
        ];
        run(&connection, &migrations).unwrap();
        run(&connection, &migrations).unwrap();
        let values: Vec<i64> = connection
            .prepare("SELECT value FROM migrated")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(values, [7]);
    }

    #[test]
    fn rejects_dirty_unknown_and_changed_applied_migrations() {
        for (change, reason) in [
            (
                "UPDATE _sqlx_migrations SET success=FALSE",
                "partially applied",
            ),
            ("UPDATE _sqlx_migrations SET version=99", "missing"),
            ("UPDATE _sqlx_migrations SET checksum=X'00'", "checksum"),
        ] {
            let connection = migrated_database();
            connection.execute_batch(change).unwrap();
            let error = run(&connection, &[BASE]).unwrap_err();
            assert!(
                matches!(&error, StoreError::Migration(message) if message.contains(reason)),
                "{change}: {error}"
            );
            assert!(connection.is_autocommit(), "{change}: savepoint left open");
        }
    }

    #[test]
    fn successful_migrations_remain_in_the_callers_transaction() {
        let connection = Connection::open_in_memory().unwrap();
        let transaction =
            Transaction::new_unchecked(&connection, TransactionBehavior::Deferred).unwrap();
        run(&transaction, &[BASE]).unwrap();
        assert!(!connection.is_autocommit());
        transaction.rollback().unwrap();
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('migrated','_sqlx_migrations')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            tables, 0,
            "schema and ledger must follow the parent rollback"
        );
    }

    #[test]
    fn failed_migration_rolls_back_schema_and_ledger_without_aborting_the_caller() {
        let connection = Connection::open_in_memory().unwrap();
        let transaction =
            Transaction::new_unchecked(&connection, TransactionBehavior::Deferred).unwrap();
        transaction
            .execute_batch("CREATE TABLE caller(value INTEGER); INSERT INTO caller VALUES(9)")
            .unwrap();
        let error = run(
            &transaction,
            &[
                BASE,
                Migration {
                    version: 2,
                    description: "broken",
                    sql: "INSERT INTO migrated VALUES(7); INSERT INTO absent VALUES(8);",
                    configure: None,
                    data: None,
                },
            ],
        )
        .unwrap_err();
        assert!(matches!(error, StoreError::Sqlite(_)), "{error}");
        let tables: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('migrated','_sqlx_migrations')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            tables, 0,
            "failed migrations must leave no schema or ledger"
        );
        transaction.commit().unwrap();
        let value: i64 = connection
            .query_row("SELECT value FROM caller", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, 9, "migration rollback must preserve caller writes");
    }

    #[test]
    fn data_migration_rewrites_existing_rows_in_place_and_records_ledger() {
        let connection = Connection::open_in_memory().unwrap();
        let v1 = Migration::sql(
            1,
            "payloads",
            "CREATE TABLE payloads(id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
        );
        run(&connection, &[v1]).unwrap();
        connection
            .execute(
                r#"INSERT INTO payloads(id, body) VALUES (1, '{"legacy_name":"alpha"}')"#,
                [],
            )
            .unwrap();

        fn rewrite_payloads(connection: &Connection) -> Result<(), StoreError> {
            let rows: Vec<(i64, String)> = {
                let mut stmt = connection.prepare("SELECT id, body FROM payloads")?;
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<_, _>>()?
            };
            for (id, body) in rows {
                let mut value: serde_json::Value = serde_json::from_str(&body)?;
                if let Some(name) = value.as_object_mut().and_then(|m| m.remove("legacy_name")) {
                    value["name"] = name;
                }
                connection.execute(
                    "UPDATE payloads SET body = ?1 WHERE id = ?2",
                    params![serde_json::to_string(&value)?, id],
                )?;
            }
            Ok(())
        }

        let v2 = Migration::sql(
            2,
            "rename payload field",
            "-- rewrite payloads.body legacy_name -> name in place",
        )
        .with_data(rewrite_payloads);
        run(&connection, &[v1, v2]).unwrap();
        // Re-running is idempotent and does not invoke the data hook twice.
        run(&connection, &[v1, v2]).unwrap();

        let body: String = connection
            .query_row("SELECT body FROM payloads WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value, serde_json::json!({"name": "alpha"}));
    }

    #[test]
    fn failed_data_migration_rolls_back_sql_and_data_atomically() {
        let connection = Connection::open_in_memory().unwrap();
        run(&connection, &[BASE]).unwrap();
        connection
            .execute("INSERT INTO migrated VALUES (1)", [])
            .unwrap();

        fn failing_rewrite(connection: &Connection) -> Result<(), StoreError> {
            connection.execute("UPDATE migrated SET value = 99", [])?;
            Err(StoreError::Migration("corrupt payload".into()))
        }

        let v2 = Migration::sql(
            2,
            "rewrite fails",
            "ALTER TABLE migrated ADD COLUMN tag TEXT;",
        )
        .with_data(failing_rewrite);
        let error = run(&connection, &[BASE, v2]).unwrap_err();
        assert!(matches!(error, StoreError::Migration(ref m) if m.contains("corrupt payload")));

        let value: i64 = connection
            .query_row("SELECT value FROM migrated", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, 1, "failed data hook must roll back row mutations");
        let has_tag: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('migrated') WHERE name = 'tag'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_tag, 0, "failed data hook must roll back SQL DDL");
        let ledger_v2: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            ledger_v2, 0,
            "failed data hook must not record ledger entry"
        );
    }
}
