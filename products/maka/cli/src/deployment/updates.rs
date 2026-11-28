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

use super::{Deployment, query, store};
use maka_event_log::{
    StoreError,
    migration::Migration,
    root::{FileLease, RootOwner},
};
use maka_host_runtime::HostError;
use rusqlite::{Connection, params};
use std::{path::Path, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pending {
    pub deployment: Deployment,
    pub roots: Option<Vec<maka_host_runtime::DirectoryRootSpec>>,
}

/// Pending intent never authorizes startup. The unchanged Active row does.
pub(super) async fn read(
    directory: &Path,
    lease: Arc<FileLease>,
) -> Result<(Deployment, Option<Pending>), HostError> {
    read_with(directory, lease, store::MIGRATIONS).await
}

async fn read_with(
    directory: &Path,
    lease: Arc<FileLease>,
    migrations: &'static [Migration],
) -> Result<(Deployment, Option<Pending>), HostError> {
    lease.validate()?;
    let store::Installation::Installed(active) =
        store::read_for_update_with(directory, &lease, migrations).await?
    else {
        return Err("Host deployment is absent or incomplete".into());
    };
    let pending = query::pending(directory, &active).await?;
    lease.validate()?;
    Ok((active, pending))
}

pub(super) async fn prepare(
    directory: &Path,
    lease: Arc<FileLease>,
    expected: Deployment,
    target: Pending,
) -> Result<(), HostError> {
    prepare_with(directory, lease, expected, target, store::MIGRATIONS).await
}

async fn prepare_with(
    directory: &Path,
    lease: Arc<FileLease>,
    expected: Deployment,
    target: Pending,
    migrations: &'static [Migration],
) -> Result<(), HostError> {
    validate_target(&expected, &target)?;
    let connection = store::open_update_writer(directory, lease, migrations).await?;
    let result = connection.run(move |connection| {
        let transaction = connection.transaction()?;
        // Never strand the old executor on a newer schema without a durable
        // pointer to the executable which can recover it. SQLite migrations
        // use nested savepoints inside this same transaction.
        store::migrate_with(&transaction, migrations)?;
        let (active, pending) = load(&transaction)?;
        if active != expected || pending.as_ref().is_some_and(|pending| pending != &target) {
            return Err(conflict());
        }
        transaction.execute("INSERT INTO deployment_update(singleton, target) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING", params![serde_json::to_string(&target)?])?;
        transaction.commit().map_err(StoreError::CommitUnknown)?;
        Ok(())
    }).await;
    let closed = connection.close().await;
    result?;
    closed?;
    Ok(())
}

pub(super) async fn commit(
    directory: &Path,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
    expected: Deployment,
    target: Pending,
) -> Result<(), HostError> {
    validate_target(&expected, &target)?;
    if owner.root_id() != expected.root_id || owner.canonical_path() != expected.root_path {
        return Err("update does not own the expected State Root".into());
    }
    // Keep both authorities in the worker through actual database close, including
    // a dropped caller, a failed COMMIT or a queued transaction rollback.
    let connection =
        store::open_deferred_writer(directory, lease, Some(owner), store::MIGRATIONS).await?;
    let result = connection
        .run(move |connection| {
            let transaction = connection.transaction()?;
            // Migrate inside the commit transaction so a conflict never leaves
            // the prior deployment on a newer schema it cannot open.
            store::migrate_with(&transaction, store::MIGRATIONS)?;
            let (active, pending) = load(&transaction)?;
            if active != expected || pending.as_ref() != Some(&target) {
                return Err(conflict());
            }
            transaction.execute(
                "UPDATE deployment SET configuration = ? WHERE singleton = 1",
                params![serde_json::to_string(&target.deployment)?],
            )?;
            transaction.execute("DELETE FROM deployment_update WHERE singleton = 1", [])?;
            transaction.commit().map_err(StoreError::CommitUnknown)?;
            Ok(())
        })
        .await;
    let closed = connection.close().await;
    result?;
    closed?;
    Ok(())
}

pub(super) fn validate_target(current: &Deployment, pending: &Pending) -> Result<(), StoreError> {
    let target = &pending.deployment;
    let mut expected = target.clone();
    expected.executable = current.executable.clone();
    expected.sha256 = current.sha256.clone();
    expected.mode = current.mode;
    expected.websocket = current.websocket;
    expected.project_directory_roots = current.project_directory_roots.clone();
    expected.config_revision = current.config_revision;
    if &expected != current
        || current.config_revision >= 9_007_199_254_740_991
        || target.config_revision != current.config_revision + 1
        || (target.sha256 == current.sha256
            && target.mode == current.mode
            && target.websocket == current.websocket
            && target.project_directory_roots == current.project_directory_roots
            && pending.roots.is_none())
        || serde_json::to_vec(pending)?.len() > 65_536
    {
        return Err(conflict());
    }
    Ok(())
}

pub(super) fn load(connection: &Connection) -> Result<(Deployment, Option<Pending>), StoreError> {
    let (active, pending): (String, Option<String>) = connection.query_row(
        "SELECT CASE WHEN length(CAST(configuration AS BLOB)) <= 65536 THEN configuration END, \
         (SELECT CASE WHEN length(CAST(target AS BLOB)) <= 65536 THEN target ELSE '' END FROM deployment_update WHERE singleton = 1) \
         FROM deployment WHERE singleton = 1"
    , [], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let active = serde_json::from_str(&active)?;
    let pending = pending
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    if let Some(target) = &pending {
        validate_target(&active, target)?;
    }
    Ok((active, pending))
}

fn conflict() -> StoreError {
    StoreError::InvalidTransition("deployment or pending update changed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::{Mode, package, policy};
    use maka_event_log::root::{self, RootNamespaces};

    #[tokio::test]
    async fn pending_intent_survives_reopen_and_cut_is_atomic_under_the_real_root_owner() {
        let temporary = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temporary.path().join("ownership"),
            control: temporary.path().join("control"),
        };
        let root_path = temporary.path().join("root");
        let owner = RootOwner::create(&root_path, &namespaces).unwrap();
        let directory = temporary.path().join("deployment");
        root::private_directory(&directory).unwrap();
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock")).unwrap());
        let current = Deployment {
            deployment_id: uuid::Uuid::new_v4(),
            config_revision: 1,
            root_id: owner.root_id().into(),
            root_path: owner.canonical_path().into(),
            executable: package::path(&directory, &"a".repeat(64)),
            sha256: "a".repeat(64),
            mode: Mode::OnDemand,
            websocket: "127.0.0.1:0".parse().unwrap(),
            project_directory_roots: None,
            admission: super::super::Admission::Active,
        };
        store::install(&directory, lease.clone(), Arc::new(owner), current.clone())
            .await
            .unwrap();
        let mut target = current.clone();
        target.config_revision += 1;
        let target = Pending {
            deployment: target,
            roots: Some(vec![]),
        };
        let writer = store::open_writer(&directory, lease.clone(), None)
            .await
            .unwrap();
        writer.run(|connection| {
            connection.execute_batch("CREATE TRIGGER reject_prepare BEFORE INSERT ON deployment_update BEGIN SELECT RAISE(ABORT, 'prepare failed'); END;")?;
            Ok(())
        }).await.unwrap();
        writer.close().await.unwrap();
        assert!(
            prepare(&directory, lease.clone(), current.clone(), target.clone())
                .await
                .is_err()
        );
        let writer = store::open_update_writer(&directory, lease.clone(), store::MIGRATIONS)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute_batch("DROP TRIGGER reject_prepare")?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();
        assert_eq!(
            read(&directory, lease.clone()).await.unwrap(),
            (current.clone(), None)
        );
        prepare(&directory, lease.clone(), current.clone(), target.clone())
            .await
            .unwrap();
        let manual = policy::read(&directory).await.unwrap();
        assert_eq!(manual.policy, policy::Policy::Manual);
        let automatic = policy::Record {
            policy: policy::Policy::Nightly,
            revision: 1,
            ..manual.clone()
        };
        policy::write(&directory, lease.clone(), &current, &manual, &automatic)
            .await
            .unwrap();
        assert_eq!(policy::read(&directory).await.unwrap(), automatic);
        assert!(
            policy::write(&directory, lease.clone(), &current, &manual, &automatic)
                .await
                .is_err()
        );
        assert!(policy::require_revision(&directory, 0).await.is_err());
        policy::require_revision(&directory, 1).await.unwrap();
        // A configuration-only target has the same executable, but still
        // requires the exact pending receipt and writer-held atomic cut.
        prepare(&directory, lease.clone(), current.clone(), target.clone())
            .await
            .unwrap();
        // Startup readers still see the sole authorized version while an
        // updater is absent. A different target cannot overwrite its intent.
        let store::Installation::Installed(active) = store::read(&directory).await.unwrap() else {
            panic!("pending intent must not change the startup reader contract");
        };
        assert_eq!(active, current);
        let mut other = target.clone();
        other.deployment.sha256 = "c".repeat(64);
        other.deployment.executable = package::path(&directory, &other.deployment.sha256);
        assert!(
            prepare(&directory, lease.clone(), current.clone(), other)
                .await
                .is_err()
        );
        assert_eq!(
            read(&directory, lease.clone()).await.unwrap(),
            (current.clone(), Some(target.clone()))
        );

        let writer = store::open_writer(&directory, lease.clone(), None)
            .await
            .unwrap();
        writer.run(|connection| {
            connection.execute_batch("CREATE TRIGGER reject_cut BEFORE DELETE ON deployment_update BEGIN SELECT RAISE(ABORT, 'cut failed'); END;")?;
            Ok(())
        }).await.unwrap();
        writer.close().await.unwrap();
        let owner = RootOwner::open(&root_path, &namespaces).unwrap();
        assert!(
            commit(
                &directory,
                lease.clone(),
                Arc::new(owner),
                current.clone(),
                target.clone()
            )
            .await
            .is_err()
        );
        assert_eq!(
            read(&directory, lease.clone()).await.unwrap(),
            (current.clone(), Some(target.clone()))
        );
        // Failed cut closed the SQL connection before returning writer authority.
        let owner = RootOwner::open(&root_path, &namespaces).unwrap();
        let writer = store::open_writer(&directory, lease.clone(), None)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute_batch("DROP TRIGGER reject_cut")?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();
        commit(
            &directory,
            lease.clone(),
            Arc::new(owner),
            current,
            target.clone(),
        )
        .await
        .unwrap();
        // Uninstall cancels pending intent atomically, but retains a tombstone.
        // Only explicit reinstallation can grant a fresh deployment identity.
        let target = target.deployment;
        let mut pending = Pending {
            deployment: target.clone(),
            roots: None,
        };
        pending.deployment.config_revision += 1;
        pending.deployment.sha256 = "d".repeat(64);
        pending.deployment.executable = package::path(&directory, &pending.deployment.sha256);
        prepare(&directory, lease.clone(), target.clone(), pending)
            .await
            .unwrap();
        let owner = Arc::new(RootOwner::open(&root_path, &namespaces).unwrap());
        let revoked = store::change(
            &directory,
            lease.clone(),
            owner.clone(),
            target.clone(),
            store::Change::Revoke,
        )
        .await
        .unwrap();
        assert_eq!(revoked.config_revision, 3);
        assert!(revoked.require_active().is_err());
        assert_eq!(
            policy::read(&directory).await.unwrap().policy,
            policy::Policy::Manual
        );
        assert!(policy::require_revision(&directory, 1).await.is_err());
        assert_eq!(
            read(&directory, lease.clone()).await.unwrap(),
            (revoked.clone(), None)
        );
        // A stale operator cannot overwrite the tombstone after a lost response.
        assert!(
            store::change(
                &directory,
                lease.clone(),
                owner.clone(),
                target.clone(),
                store::Change::Revoke
            )
            .await
            .is_err()
        );
        let mut reinstalled = target;
        reinstalled.deployment_id = uuid::Uuid::new_v4();
        reinstalled.config_revision = 1;
        let active = store::change(
            &directory,
            lease.clone(),
            owner.clone(),
            revoked,
            store::Change::Reinstall(reinstalled.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            read(&directory, lease.clone()).await.unwrap(),
            (active, None)
        );
        let writer = store::open_writer(&directory, lease.clone(), None)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute_batch(
                    "PRAGMA journal_mode=DELETE; UPDATE _sqlx_migrations SET checksum = X'00';",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();
        let path = directory.join("deployment.sqlite");
        let before = std::fs::read(&path).unwrap();
        assert!(store::read(&directory).await.is_err());
        assert!(store::open_writer(&directory, lease, None).await.is_err());
        assert_eq!(
            std::fs::read(path).unwrap(),
            before,
            "unsupported stores must not be rewritten"
        );
        drop(owner);
        drop(RootOwner::open(&root_path, &namespaces).unwrap());
    }

    #[tokio::test]
    async fn update_prepare_migrates_installed_v1_deployment_atomically_and_v1_scheduler_hands_off()
    {
        const V1_MIGRATION: Migration = Migration {
            version: 1,
            description: "deployment",
            sql: include_str!("../../migrations/deployment/0001_deployment.sql"),
            configure: None,
            data: None,
        };
        static V1: &[Migration] = &[V1_MIGRATION];
        static UPGRADED: &[Migration] = &[
            V1_MIGRATION,
            // Intentionally omit PRAGMA user_version = 2; store::migrate_with must update it.
            Migration::sql(
                2,
                "add_note",
                "ALTER TABLE deployment ADD COLUMN note TEXT;",
            ),
        ];

        let temporary = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temporary.path().join("ownership"),
            control: temporary.path().join("control"),
        };
        let root_path = temporary.path().join("root");
        let owner = RootOwner::create(&root_path, &namespaces).unwrap();
        let directory = temporary.path().join("deployment");
        root::private_directory(&directory).unwrap();
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock")).unwrap());
        let current = Deployment {
            deployment_id: uuid::Uuid::new_v4(),
            config_revision: 1,
            root_id: owner.root_id().into(),
            root_path: owner.canonical_path().into(),
            executable: package::path(&directory, &"a".repeat(64)),
            sha256: "a".repeat(64),
            mode: Mode::OnDemand,
            websocket: "127.0.0.1:0".parse().unwrap(),
            project_directory_roots: None,
            admission: super::super::Admission::Active,
        };
        store::install_with(
            &directory,
            lease.clone(),
            Arc::new(owner),
            current.clone(),
            V1,
        )
        .await
        .unwrap();

        let mut next = current.clone();
        next.config_revision += 1;
        next.sha256 = "b".repeat(64);
        next.executable = package::path(&directory, &next.sha256);
        let target = Pending {
            deployment: next,
            roots: None,
        };

        // Strict v2 reader rejects unmigrated v1; lease-held update readers accept it.
        assert!(store::read_with(&directory, UPGRADED, false).await.is_err());
        let store::Installation::Installed(before) =
            store::read_for_update_with(&directory, &lease, UPGRADED)
                .await
                .unwrap()
        else {
            panic!("update reader must accept verified v1 deployment");
        };
        assert_eq!(before, current);
        assert_eq!(
            read_with(&directory, lease.clone(), UPGRADED)
                .await
                .unwrap(),
            (current.clone(), None)
        );

        // If prepare fails while writing pending intent, both the v2 schema migration
        // and PRAGMA user_version must roll back so the v1 executor is not stranded.
        let writer = store::open_writer_with(&directory, lease.clone(), None, V1)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute_batch(
                    "CREATE TRIGGER reject_prepare BEFORE INSERT ON deployment_update BEGIN SELECT RAISE(ABORT, 'prepare failed'); END;",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();
        assert!(
            prepare_with(
                &directory,
                lease.clone(),
                current.clone(),
                target.clone(),
                UPGRADED,
            )
            .await
            .is_err()
        );
        let store::Installation::Installed(rolled_back) =
            store::read_with(&directory, V1, false).await.unwrap()
        else {
            panic!("failed prepare must leave the original v1 deployment readable");
        };
        assert_eq!(rolled_back, current);

        // Remove the trigger and run the real prepare path on v1 -> v2.
        let writer = store::open_writer_with(&directory, lease.clone(), None, V1)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute_batch("DROP TRIGGER reject_prepare")?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();

        prepare_with(
            &directory,
            lease.clone(),
            current.clone(),
            target.clone(),
            UPGRADED,
        )
        .await
        .unwrap();

        // After prepare commits, strict v2 store::read and updates::read both see active + pending.
        let store::Installation::Installed(after) =
            store::read_with(&directory, UPGRADED, false).await.unwrap()
        else {
            panic!("strict v2 reader must accept deployment migrated by prepare");
        };
        assert_eq!(after, current);
        assert_eq!(
            read_with(&directory, lease.clone(), UPGRADED)
                .await
                .unwrap(),
            (current.clone(), Some(target.clone()))
        );

        // If v2 returned ActiveTasks, the v1 scheduled auto-updater must still be able
        // to locate the validated v2 pending executable and hand off recovery instead of
        // failing on the newer schema, while v2 takes over strict local reconciliation.
        assert_eq!(
            policy::worker::resolve_dispatch_with(
                &directory,
                &current.root_id,
                &current.executable,
                V1,
            )
            .await
            .unwrap(),
            policy::worker::Dispatch::Handoff {
                executable: target.deployment.executable.clone(),
                root_id: current.root_id.clone(),
            }
        );
        assert_eq!(
            policy::worker::resolve_dispatch_with(
                &directory,
                &current.root_id,
                &target.deployment.executable,
                UPGRADED,
            )
            .await
            .unwrap(),
            policy::worker::Dispatch::Local {
                current: current.clone(),
                pending: Some(Box::new(target.clone())),
            }
        );

        // Handoff tolerates forward-added fields in v2+ pending JSON, but still rejects
        // stores whose known historical prefix checksum was tampered with.
        let writer = store::open_writer_with(&directory, lease.clone(), None, UPGRADED)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute(
                    "UPDATE deployment_update SET target = json_set(target, '$.futureFlag', json('true')) WHERE singleton = 1",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();
        assert_eq!(
            policy::worker::resolve_dispatch_with(
                &directory,
                &current.root_id,
                &current.executable,
                V1,
            )
            .await
            .unwrap(),
            policy::worker::Dispatch::Handoff {
                executable: target.deployment.executable,
                root_id: current.root_id.clone(),
            }
        );

        let writer = store::open_writer_with(&directory, lease, None, UPGRADED)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute_batch(
                    "UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 1;",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();
        assert!(
            policy::worker::resolve_dispatch_with(
                &directory,
                &current.root_id,
                &current.executable,
                V1,
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn v2_migration_resets_retired_rust_preview_policy_to_manual() {
        let v1: &'static [Migration] = &store::MIGRATIONS[..1];

        let temporary = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temporary.path().join("ownership"),
            control: temporary.path().join("control"),
        };
        let root_path = temporary.path().join("root");
        let owner = RootOwner::create(&root_path, &namespaces).unwrap();
        let directory = temporary.path().join("deployment");
        root::private_directory(&directory).unwrap();
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock")).unwrap());
        let current = Deployment {
            deployment_id: uuid::Uuid::new_v4(),
            config_revision: 1,
            root_id: owner.root_id().into(),
            root_path: owner.canonical_path().into(),
            executable: package::path(&directory, &"a".repeat(64)),
            sha256: "a".repeat(64),
            mode: Mode::OnDemand,
            websocket: "127.0.0.1:0".parse().unwrap(),
            project_directory_roots: None,
            admission: super::super::Admission::Active,
        };
        store::install_with(
            &directory,
            lease.clone(),
            Arc::new(owner),
            current.clone(),
            v1,
        )
        .await
        .unwrap();

        // Seed a persisted v1 row carrying the retired rust_preview policy.
        let writer = store::open_writer_with(&directory, lease.clone(), None, v1)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute(
                    "INSERT INTO deployment_update_policy(singleton, configuration) VALUES (1, ?)",
                    [r#"{"revision":3,"policy":"rust_preview","nextCheckMs":999999,"lastError":"stale"}"#],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();

        // Read-only compatible inspection sees v1 deployment without mutating schema version.
        assert!(store::read(&directory).await.is_err());
        let store::Installation::Installed(observed) =
            store::read_compatible(&directory).await.unwrap()
        else {
            panic!("expected v1 deployment via read_compatible");
        };
        assert_eq!(observed, current);
        let version_before: i64 = store::read_database(directory.join("deployment.sqlite"), |c| {
            Ok(c.query_row("PRAGMA user_version", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
        assert_eq!(version_before, 1);

        // Real update preparation upgrades v1 -> v2 atomically and resets retired policy.
        let mut next = current.clone();
        next.config_revision = 2;
        next.sha256 = "b".repeat(64);
        next.executable = package::path(&directory, &next.sha256);
        prepare(
            &directory,
            lease.clone(),
            current,
            Pending {
                deployment: next,
                roots: None,
            },
        )
        .await
        .unwrap();

        let migrated = policy::read(&directory).await.unwrap();
        assert_eq!(
            migrated,
            policy::Record {
                revision: 3,
                policy: policy::Policy::Manual,
                next_check_ms: 0,
                last_error: None,
            }
        );
    }

    #[tokio::test]
    async fn v1_revoked_reinstall_migrates_atomically_and_rolls_back_on_conflict() {
        let v1: &'static [Migration] = &store::MIGRATIONS[..1];

        let temporary = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temporary.path().join("ownership"),
            control: temporary.path().join("control"),
        };
        let root_path = temporary.path().join("root");
        let owner = Arc::new(RootOwner::create(&root_path, &namespaces).unwrap());
        let directory = temporary.path().join("deployment");
        root::private_directory(&directory).unwrap();
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock")).unwrap());
        let revoked = Deployment {
            deployment_id: uuid::Uuid::new_v4(),
            config_revision: 2,
            root_id: owner.root_id().into(),
            root_path: owner.canonical_path().into(),
            executable: package::path(&directory, &"a".repeat(64)),
            sha256: "a".repeat(64),
            mode: Mode::OnDemand,
            websocket: "127.0.0.1:0".parse().unwrap(),
            project_directory_roots: None,
            admission: super::super::Admission::Revoked,
        };
        store::install_with(
            &directory,
            lease.clone(),
            owner.clone(),
            revoked.clone(),
            v1,
        )
        .await
        .unwrap();

        let writer = store::open_writer_with(&directory, lease.clone(), None, v1)
            .await
            .unwrap();
        writer
            .run(|connection| {
                connection.execute(
                    "INSERT INTO deployment_update_policy(singleton, configuration) VALUES (1, ?)",
                    [r#"{"revision":4,"policy":"rust_preview","nextCheckMs":999999,"lastError":"stale"}"#],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        writer.close().await.unwrap();

        // Lease-held install read sees the v1 Revoked tombstone without mutating schema version.
        let store::Installation::Installed(observed) =
            store::read_for_update(&directory, &lease).await.unwrap()
        else {
            panic!("expected v1 revoked deployment");
        };
        assert_eq!(observed, revoked);

        let requested = Deployment {
            deployment_id: uuid::Uuid::new_v4(),
            config_revision: 1,
            root_id: owner.root_id().into(),
            root_path: owner.canonical_path().into(),
            executable: package::path(&directory, &"b".repeat(64)),
            sha256: "b".repeat(64),
            mode: Mode::OnDemand,
            websocket: "127.0.0.1:0".parse().unwrap(),
            project_directory_roots: None,
            admission: super::super::Admission::Active,
        };

        // A stale expected revision rolls back both the change and the v1 -> v2 migration.
        let mut stale_expected = revoked.clone();
        stale_expected.config_revision = 99;
        assert!(
            store::change(
                &directory,
                lease.clone(),
                owner.clone(),
                stale_expected,
                store::Change::Reinstall(requested.clone()),
            )
            .await
            .is_err()
        );
        let version_after_conflict: i64 =
            store::read_database(directory.join("deployment.sqlite"), |c| {
                Ok(c.query_row("PRAGMA user_version", [], |row| row.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(version_after_conflict, 1);

        // Matching expected revision atomically migrates v1 -> v2 and installs the active deployment.
        let installed = store::change(
            &directory,
            lease.clone(),
            owner,
            revoked,
            store::Change::Reinstall(requested.clone()),
        )
        .await
        .unwrap();
        assert_eq!(installed, requested);
        let store::Installation::Installed(active) = store::read(&directory).await.unwrap() else {
            panic!("expected strict v2 store::read to succeed after reinstall");
        };
        assert_eq!(active, requested);
        assert_eq!(
            policy::read(&directory).await.unwrap(),
            policy::Record {
                revision: 4,
                policy: policy::Policy::Manual,
                next_check_ms: 0,
                last_error: None,
            }
        );
    }

    #[tokio::test]
    async fn commit_rolls_back_migration_on_conflict() {
        let v1: &'static [Migration] = &store::MIGRATIONS[..1];

        let temporary = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temporary.path().join("ownership"),
            control: temporary.path().join("control"),
        };
        let root_path = temporary.path().join("root");
        let owner = Arc::new(RootOwner::create(&root_path, &namespaces).unwrap());
        let directory = temporary.path().join("deployment");
        root::private_directory(&directory).unwrap();
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock")).unwrap());
        let current = Deployment {
            deployment_id: uuid::Uuid::new_v4(),
            config_revision: 1,
            root_id: owner.root_id().into(),
            root_path: owner.canonical_path().into(),
            executable: package::path(&directory, &"a".repeat(64)),
            sha256: "a".repeat(64),
            mode: Mode::OnDemand,
            websocket: "127.0.0.1:0".parse().unwrap(),
            project_directory_roots: None,
            admission: super::super::Admission::Active,
        };
        store::install_with(
            &directory,
            lease.clone(),
            owner.clone(),
            current.clone(),
            v1,
        )
        .await
        .unwrap();

        let mut target = current.clone();
        target.config_revision = 2;
        target.sha256 = "b".repeat(64);
        target.executable = package::path(&directory, &target.sha256);

        // No pending row exists in deployment_update, so commit conflicts and must
        // roll back the v1 -> v2 schema migration atomically.
        assert!(
            commit(
                &directory,
                lease,
                owner,
                current,
                Pending {
                    deployment: target,
                    roots: None,
                },
            )
            .await
            .is_err()
        );
        let version: i64 = store::read_database(directory.join("deployment.sqlite"), |c| {
            Ok(c.query_row("PRAGMA user_version", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
        assert_eq!(version, 1);
    }
}
