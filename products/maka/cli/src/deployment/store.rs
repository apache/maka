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

use super::{Admission, Deployment, RootId, package};
use maka_event_log::{
    StoreError,
    connection::{ConnectionAuthority, OpenOptions, OwnedConnection},
    migration::Migration,
    root::{FileLease, RootOwner},
};
use maka_host_runtime::HostError;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

const DATABASE: &str = "deployment.sqlite";
const APPLICATION_ID: i64 = 0x4d414b44;

pub(super) static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "deployment",
        sql: include_str!("../../migrations/deployment/0001_deployment.sql"),
        configure: None,
        data: None,
    },
    Migration {
        version: 2,
        description: "retire_rust_preview_policy",
        sql: include_str!("../../migrations/deployment/0002_retire_rust_preview_policy.sql"),
        configure: None,
        data: None,
    },
];

pub(super) enum Installation {
    Missing,
    Incomplete,
    Installed(Deployment),
}

/// Minimal stable descriptor used by an older scheduled updater to hand off
/// recovery to a newer executable after `updates::prepare` migrated the schema.
#[derive(Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HandoffRecord {
    pub root_id: String,
    pub executable: PathBuf,
    pub sha256: String,
    pub admission: Admission,
}

impl HandoffRecord {
    fn validate(&self, directory: &Path) -> Result<(), HostError> {
        if self.root_id.parse::<RootId>().is_err()
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.executable != package::path(directory, &self.sha256)
        {
            return Err("deployment does not match its native root or package".into());
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoffPending {
    deployment: HandoffRecord,
}

pub(super) enum Handoff {
    /// Store matches this binary's exact schema.
    Current(Installation),
    /// Store belongs to a newer Maka deployment schema (`user_version > latest`).
    /// Callers may only hand off to the validated target executable and must
    /// never open a writer against this newer schema.
    Newer {
        active: HandoffRecord,
        pending: Option<HandoffRecord>,
    },
}

fn database_file(directory: &Path) -> Result<Option<PathBuf>, HostError> {
    let path = directory.join(DATABASE);
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if !metadata.is_file() => Err("invalid deployment database".into()),
        Ok(_) => Ok(Some(path)),
    }
}

fn read_connection(
    connection: &Connection,
    migrations: &[Migration],
    allow_pending_migrations: bool,
) -> Result<Installation, HostError> {
    validate_schema_with(connection, migrations, allow_pending_migrations)?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 0 {
        return Ok(Installation::Incomplete);
    }
    let value: Option<String> = connection
        .query_row(
            "SELECT CASE WHEN length(CAST(configuration AS BLOB)) <= 65536 THEN configuration END FROM deployment WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(value) = value else {
        return Ok(Installation::Incomplete);
    };
    Ok(Installation::Installed(serde_json::from_str(&value)?))
}

/// Strict read requiring the complete current migration ledger.
/// Used by admission, service startup, and policy configuration.
pub(super) async fn read(directory: &Path) -> Result<Installation, HostError> {
    read_with(directory, MIGRATIONS, false).await
}

/// Strictly read-only inspection that accepts a verified historical migration
/// prefix without opening a writer or mutating `deployment.sqlite`.
pub(super) async fn read_compatible(directory: &Path) -> Result<Installation, HostError> {
    read_with(directory, MIGRATIONS, true).await
}

/// Read under an active executor lease during update/reconcile so a verified
/// historical schema prefix can reach `updates::prepare`'s atomic migration.
pub(super) async fn read_for_update(
    directory: &Path,
    lease: &FileLease,
) -> Result<Installation, HostError> {
    read_for_update_with(directory, lease, MIGRATIONS).await
}

pub(super) async fn read_for_update_with(
    directory: &Path,
    lease: &FileLease,
    migrations: &'static [Migration],
) -> Result<Installation, HostError> {
    lease.validate()?;
    let installation = read_with(directory, migrations, true).await?;
    lease.validate()?;
    Ok(installation)
}

pub(super) async fn read_with(
    directory: &Path,
    migrations: &'static [Migration],
    allow_pending_migrations: bool,
) -> Result<Installation, HostError> {
    let Some(path) = database_file(directory)? else {
        return Ok(Installation::Missing);
    };
    read_database(path, move |connection| {
        read_connection(connection, migrations, allow_pending_migrations)
    })
    .await
}

/// Read for the scheduled auto-update dispatcher. When a newer executable has
/// already migrated the store (for example after returning `ActiveTasks`),
/// locate its validated executable so the older scheduler can hand off instead
/// of failing on the newer schema.
pub(super) async fn read_handoff(directory: &Path) -> Result<Handoff, HostError> {
    read_handoff_with(directory, MIGRATIONS).await
}

pub(super) async fn read_handoff_with(
    directory: &Path,
    migrations: &'static [Migration],
) -> Result<Handoff, HostError> {
    let Some(path) = database_file(directory)? else {
        return Ok(Handoff::Current(Installation::Missing));
    };
    let directory = directory.to_path_buf();
    read_database(path, move |connection| {
        let application: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let latest_version = migrations.last().map(|m| m.version).unwrap_or(0);
        if application == APPLICATION_ID && version > latest_version {
            let (ledger, applied) = applied_migrations(connection)?;
            let prefix_ok = ledger
                && applied.len() >= migrations.len()
                && matches_prefix(&applied[..migrations.len()], migrations)
                && applied.iter().all(|row| row.success)
                && applied.last().is_some_and(|row| row.version == version);
            if !prefix_ok {
                return Err(StoreError::InvalidTransition(
                    "unsupported deployment schema".into(),
                )
                .into());
            }
            let active: Option<String> = connection
                .query_row(
                    "SELECT CASE WHEN length(CAST(configuration AS BLOB)) <= 65536 THEN configuration END FROM deployment WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(active) = active else {
                return Ok(Handoff::Current(Installation::Incomplete));
            };
            let active: HandoffRecord = serde_json::from_str(&active)?;
            active.validate(&directory)?;
            let pending: Option<String> = connection
                .query_row(
                    "SELECT CASE WHEN length(CAST(target AS BLOB)) <= 65536 THEN target ELSE '' END FROM deployment_update WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let pending = match pending {
                Some(value) => {
                    let parsed: HandoffPending = serde_json::from_str(&value)?;
                    parsed.deployment.validate(&directory)?;
                    if parsed.deployment.root_id != active.root_id {
                        return Err("pending deployment root identity differs".into());
                    }
                    Some(parsed.deployment)
                }
                None => None,
            };
            return Ok(Handoff::Newer { active, pending });
        }
        Ok(Handoff::Current(read_connection(
            connection, migrations, false,
        )?))
    })
    .await
}

pub(super) async fn read_database<T: Send + 'static>(
    path: std::path::PathBuf,
    read: impl FnOnce(&mut Connection) -> Result<T, HostError> + Send + 'static,
) -> Result<T, HostError> {
    tokio::task::spawn_blocking(move || {
        let mut connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let result = read(&mut connection);
        let closed = connection.close().map_err(|(_, error)| error);
        let value = result?;
        closed?;
        Ok(value)
    })
    .await?
}

pub(super) async fn install(
    directory: &Path,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
    deployment: Deployment,
) -> Result<Deployment, HostError> {
    install_with(directory, lease, owner, deployment, MIGRATIONS).await
}

pub(super) async fn install_with(
    directory: &Path,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
    deployment: Deployment,
    migrations: &'static [Migration],
) -> Result<Deployment, HostError> {
    let connection = open(directory, lease, None, true, migrations).await?;
    let result = connection
        .run(move |connection| {
            // The accepted database job owns Root until its actual commit, even if
            // the install caller disappears while awaiting the acknowledgement.
            owner.validate_current()?;
            let body = serde_json::to_string(&deployment)?;
            connection.execute(
                "INSERT INTO deployment(singleton, configuration) VALUES (1, ?)",
                params![body],
            )?;
            drop(owner);
            Ok(deployment)
        })
        .await;
    let closed = connection.close().await;
    let deployment = result?;
    closed?;
    Ok(deployment)
}

pub(super) async fn open_writer(
    directory: &Path,
    lease: Arc<FileLease>,
    root: Option<Arc<RootOwner>>,
) -> Result<OwnedConnection, HostError> {
    open(directory, lease, root, true, MIGRATIONS).await
}

#[cfg(test)]
pub(super) async fn open_writer_with(
    directory: &Path,
    lease: Arc<FileLease>,
    root: Option<Arc<RootOwner>>,
    migrations: &'static [Migration],
) -> Result<OwnedConnection, HostError> {
    open(directory, lease, root, true, migrations).await
}

pub(super) async fn open_update_writer(
    directory: &Path,
    lease: Arc<FileLease>,
    migrations: &'static [Migration],
) -> Result<OwnedConnection, HostError> {
    open(directory, lease, None, false, migrations).await
}

/// Opens a writer without migrating on open so the caller can run `migrate_with`
/// inside its own atomic takeover transaction (rolling back migration on conflict).
pub(super) async fn open_deferred_writer(
    directory: &Path,
    lease: Arc<FileLease>,
    root: Option<Arc<RootOwner>>,
    migrations: &'static [Migration],
) -> Result<OwnedConnection, HostError> {
    open(directory, lease, root, false, migrations).await
}

async fn open(
    directory: &Path,
    lease: Arc<FileLease>,
    root: Option<Arc<RootOwner>>,
    migrate_on_open: bool,
    migrations: &'static [Migration],
) -> Result<OwnedConnection, HostError> {
    let path = directory.join(DATABASE);
    let file = private_file(&path)?;
    file.sync_all()?;
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(OwnedConnection::open(
        OpenOptions::file(path),
        ConnectionAuthority::Writer { lease, root },
        move |connection| {
            initialize_with(connection, migrations)?;
            if migrate_on_open {
                migrate_with(connection, migrations)?;
            }
            Ok(())
        },
    )
    .await?)
}

pub(super) enum Change {
    Revoke,
    Reinstall(Deployment),
}

/// Revocation and reinstallation are authority changes, not code updates.
/// The connection retains Root through actual COMMIT/rollback and close.
pub(super) async fn change(
    directory: &Path,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
    expected: Deployment,
    change: Change,
) -> Result<Deployment, HostError> {
    use super::Admission;
    if owner.root_id() != expected.root_id || owner.canonical_path() != expected.root_path {
        return Err("deployment change does not own the expected State Root".into());
    }
    let target = match change {
        Change::Revoke => {
            expected.require_active()?;
            if expected.config_revision >= 9_007_199_254_740_991 {
                return Err("deployment revision is exhausted".into());
            }
            let mut target = expected.clone();
            target.config_revision += 1;
            target.admission = Admission::Revoked;
            target
        }
        Change::Reinstall(target) => {
            if expected.admission != Admission::Revoked
                || target.admission != Admission::Active
                || target.root_id != expected.root_id
                || target.root_path != expected.root_path
                || target.deployment_id == expected.deployment_id
                || target.config_revision != 1
            {
                return Err("invalid deployment reinstallation".into());
            }
            target
        }
    };
    let connection = open(directory, lease, Some(owner), false, MIGRATIONS).await?;
    let result = connection
        .run(move |connection| {
            let transaction = connection.transaction()?;
            // Migrate inside the takeover transaction so a conflict or failure
            // rolls back the schema upgrade too instead of stranding the prior
            // deployment on a newer schema.
            migrate_with(&transaction, MIGRATIONS)?;
            let (active, _) = super::updates::load(&transaction)?;
            if active != expected {
                return Err(StoreError::InvalidTransition("deployment changed".into()));
            }
            transaction.execute("UPDATE deployment SET configuration = ? WHERE singleton = 1", params![serde_json::to_string(&target)?])?;
            transaction.execute("DELETE FROM deployment_update WHERE singleton = 1", [])?;
            // A revoked or replaced deployment cannot inherit an automatic
            // update grant. Retain the row so cleanup retries know a
            // scheduler may still exist.
            transaction.execute("UPDATE deployment_update_policy SET configuration = json_set(configuration, '$.policy', 'manual', '$.nextCheckMs', 0, '$.lastError', NULL) WHERE singleton = 1", [])?;
            transaction.commit().map_err(StoreError::CommitUnknown)?;
            Ok(target)
        })
        .await;
    let closed = connection.close().await;
    let target = result?;
    closed?;
    Ok(target)
}

fn private_file(path: &Path) -> Result<File, HostError> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?
    };
    #[cfg(windows)]
    let file = {
        use maka_event_log::root::windows::{create_private_file, open_nofollow, validate_private};
        let file = match create_private_file(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                open_nofollow(path, true)?
            }
            Err(error) => return Err(error.into()),
        };
        validate_private(&file)?;
        file
    };
    if !file.metadata()?.is_file() {
        return Err("deployment database is not a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("deployment database is not private and singly linked".into());
        }
    }
    #[cfg(windows)]
    if maka_event_log::root::windows::file_identity(&file)?.links != 1 {
        return Err("deployment database is hard-linked".into());
    }
    Ok(file)
}

fn initialize_with(
    connection: &mut Connection,
    migrations: &[Migration],
) -> Result<(), StoreError> {
    validate_schema_with(connection, migrations, true)?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA application_id=1296124740;",
    )?;
    Ok(())
}

/// Reject unsupported stores before a writer changes journaling or creates metadata.
/// Writers (and lease-held update readers) accept a verified historical prefix;
/// strict readers and post-migration checks require the complete current ledger
/// with `PRAGMA user_version` matching the latest applied migration.
fn validate_schema_with(
    connection: &Connection,
    migrations: &[Migration],
    allow_pending_migrations: bool,
) -> Result<(), StoreError> {
    let application: i64 = connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let latest_version = migrations.last().map(|m| m.version).unwrap_or(0);
    let tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if !((application == 0 && version == 0 && tables == 0)
        || (application == APPLICATION_ID && (0..=latest_version).contains(&version)))
    {
        return Err(StoreError::InvalidTransition(
            "unsupported deployment database".into(),
        ));
    }
    let (ledger, applied) = applied_migrations(connection)?;
    let valid = if version == 0 {
        tables == i64::from(ledger) && applied.is_empty()
    } else {
        let len_ok = if allow_pending_migrations {
            !applied.is_empty() && applied.len() <= migrations.len()
        } else {
            applied.len() == migrations.len()
        };
        len_ok
            && applied.last().is_some_and(|row| row.version == version)
            && matches_prefix(&applied, migrations)
    };
    if !valid {
        return Err(StoreError::InvalidTransition(
            "unsupported deployment schema".into(),
        ));
    }
    Ok(())
}

struct AppliedMigration {
    version: i64,
    success: bool,
    checksum: Vec<u8>,
}

fn applied_migrations(
    connection: &Connection,
) -> Result<(bool, Vec<AppliedMigration>), StoreError> {
    let ledger: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_sqlx_migrations')",
        [],
        |row| row.get(0),
    )?;
    let applied = if ledger {
        connection
            .prepare("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")?
            .query_map([], |row| {
                Ok(AppliedMigration {
                    version: row.get(0)?,
                    success: row.get(1)?,
                    checksum: row.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?
    } else {
        Vec::new()
    };
    Ok((ledger, applied))
}

fn matches_prefix(applied: &[AppliedMigration], migrations: &[Migration]) -> bool {
    applied
        .iter()
        .zip(migrations.iter())
        .all(|(row, expected)| {
            row.version == expected.version
                && row.success
                && row.checksum.as_slice()
                    == maka_event_log::migration::checksum(expected.sql).as_slice()
        })
}

pub(super) fn migrate_with(
    connection: &Connection,
    migrations: &[Migration],
) -> Result<(), StoreError> {
    connection.execute_batch("SAVEPOINT maka_deployment_migrate")?;
    let result = (|| {
        maka_event_log::migration::run(connection, migrations)?;
        if let Some(latest) = migrations.last() {
            let version = i32::try_from(latest.version).map_err(|_| {
                StoreError::Migration(format!(
                    "deployment migration version {} out of PRAGMA user_version range",
                    latest.version
                ))
            })?;
            connection.execute_batch(&format!("PRAGMA user_version = {version};"))?;
        }
        validate_schema_with(connection, migrations, false)?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            connection.execute_batch("RELEASE maka_deployment_migrate")?;
            Ok(())
        }
        Err(error) => {
            connection
                .execute_batch(
                    "ROLLBACK TO maka_deployment_migrate; RELEASE maka_deployment_migrate",
                )
                .map_err(|rollback| {
                    StoreError::Migration(format!(
                        "{error}; rolling back deployment migrations failed: {rollback}"
                    ))
                })?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_updates_user_version_and_rejects_drifted_or_future_versions() {
        let v1 = [MIGRATIONS[0]];
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_with(&mut connection, &v1).unwrap();
        migrate_with(&connection, &v1).unwrap();
        validate_schema_with(&connection, &v1, false).unwrap();

        // v2 intentionally omits PRAGMA user_version: migrate_with must advance it atomically.
        let v2 = Migration::sql(
            2,
            "add_note",
            "ALTER TABLE deployment ADD COLUMN note TEXT;",
        );
        let upgraded = [v1[0], v2];

        assert!(validate_schema_with(&connection, &upgraded, false).is_err());
        validate_schema_with(&connection, &upgraded, true).unwrap();
        migrate_with(&connection, &upgraded).unwrap();
        validate_schema_with(&connection, &upgraded, false).unwrap();
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(user_version, 2);

        // Drift between PRAGMA user_version and _sqlx_migrations is rejected in both modes.
        connection
            .execute_batch("PRAGMA user_version = 1;")
            .unwrap();
        assert!(validate_schema_with(&connection, &upgraded, false).is_err());
        assert!(validate_schema_with(&connection, &upgraded, true).is_err());

        // Unknown future user_version is rejected.
        connection
            .execute_batch("PRAGMA user_version = 3;")
            .unwrap();
        assert!(validate_schema_with(&connection, &upgraded, true).is_err());
    }
}
