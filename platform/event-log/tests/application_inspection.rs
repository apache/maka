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

use maka_event_log::{
    EventLog, RootStore, StoreError,
    root::{FileLease, ROOT_DATABASE, RootNamespaces, RootOwner},
};
use maka_plugin_core::{composition::Input, deployment::DeploymentRef};
use rusqlite::config::DbConfig;
use serde_json::{Value, json};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

#[derive(PartialEq)]
struct Member {
    directory: bool,
    bytes: Vec<u8>,
    #[cfg(unix)]
    mode: u32,
}
type Members = BTreeMap<PathBuf, Member>;

fn members(root: &Path) -> Members {
    fn visit(root: &Path, directory: &Path, found: &mut Members) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = entry.metadata().unwrap();
            assert!(!entry.file_type().unwrap().is_symlink());
            let directory = metadata.is_dir();
            assert!(directory || metadata.is_file());
            let member = Member {
                directory,
                bytes: if directory {
                    Vec::new()
                } else {
                    std::fs::read(&path).unwrap()
                },
                #[cfg(unix)]
                mode: {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode() & 0o7777
                },
            };
            found.insert(path.strip_prefix(root).unwrap().to_owned(), member);
            if directory {
                visit(root, &path, found);
            }
        }
    }
    let mut found = BTreeMap::new();
    visit(root, root, &mut found);
    found
}
fn unchanged(root: &Path, before: &Members) {
    let after = members(root);
    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>(),
        "inspection changed original Root members: {}",
        root.display()
    );
    for (path, member) in before {
        assert!(
            after.get(path) == Some(member),
            "inspection changed original bytes/type/permissions: {}",
            root.join(path).display()
        );
    }
}

struct Fixture {
    directory: Option<tempfile::TempDir>,
    root: PathBuf,
    namespaces: RootNamespaces,
    reference: DeploymentRef,
    configuration: Value,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Some(directory) = self.directory.take()
        {
            eprintln!(
                "retained application inspection case: {}",
                directory.keep().display()
            );
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        // Supported custom namespaces can be inside the saved Root. An inspection
        // must not manufacture or repair these directories/locks either.
        let namespaces = RootNamespaces {
            ownership: root.join("owners"),
            control: root.join("control"),
        };
        let owner = RootOwner::create(&root, &namespaces).unwrap();
        let writer = RootStore::open(Arc::new(owner)).await.unwrap();
        let input: Input = serde_json::from_value(json!({
            "instances":{}
        }))
        .unwrap();
        let reference = writer
            .commit_application(Uuid::new_v4(), 0, input, vec![], vec![])
            .await
            .unwrap();
        let configuration =
            json!({"original":"literal saved application selection","enabled":false});
        writer
            .select_committed_application_launch(reference.clone(), configuration.clone())
            .await
            .unwrap();
        writer
            .create_session(
                "kept-session",
                "kept-create",
                &json!({"title":"Original user state","flag":false}),
                7,
            )
            .await
            .unwrap();
        writer.close().await.unwrap();
        Self {
            directory: Some(directory),
            root,
            namespaces,
            reference,
            configuration,
        }
    }
    async fn retain_committed_wal(&mut self) {
        let owner = self.owner();
        let lease = FileLease::acquire_existing(&self.database_lease()).unwrap();
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(self.database()))
                .await
                .unwrap();
        {
            let mut locked = connection.lock_handle().await.unwrap();
            // SAFETY: the non-owning wrapper remains under SQLx's exclusive
            // handle guard and is dropped before another SQLx operation.
            let borrowed =
                unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }
                    .unwrap();
            assert!(
                borrowed
                    .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
                    .unwrap()
            );
            assert!(
                borrowed
                    .db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                    .unwrap()
            );
        }
        sqlx::query("PRAGMA wal_autocheckpoint=0")
            .execute(&mut connection)
            .await
            .unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(mode, "wal");
        let configuration = json!({"original":"latest retained WAL selection","enabled":false});
        let changed = sqlx::query(
            "UPDATE application_launch SET configuration=? WHERE singleton=1 AND deployment=?",
        )
        .bind(serde_json::to_string(&configuration).unwrap())
        .bind(self.reference.deployment.to_string())
        .execute(&mut connection)
        .await
        .unwrap();
        assert_eq!(changed.rows_affected(), 1);
        connection.close().await.unwrap();
        owner.validate_current().unwrap();
        lease.validate().unwrap();
        drop((lease, owner));
        self.configuration = configuration;
        assert!(
            std::fs::metadata(self.root.join(format!("{ROOT_DATABASE}-wal")))
                .unwrap()
                .len()
                > 32
        );
    }
    fn owner(&self) -> RootOwner {
        RootOwner::open_existing(&self.root, &self.namespaces).unwrap()
    }
    fn database(&self) -> PathBuf {
        self.root.join(ROOT_DATABASE)
    }
    fn database_lease(&self) -> PathBuf {
        self.root.join(format!("{ROOT_DATABASE}.writer.lock"))
    }
    fn reacquire(&self) {
        let owner = self.owner();
        assert_eq!(owner.root_id(), self.reference.state_domain);
        let lease = FileLease::acquire_existing(&self.database_lease()).unwrap();
        owner.validate_current().unwrap();
        lease.validate().unwrap();
        drop((lease, owner));
    }
}

#[tokio::test]
async fn inspection_retains_both_original_leases_and_rejects_public_mutation() {
    let mut f = Fixture::new().await;
    // Force the WAL-present inspection branch: its handle is read-write for
    // SQLite's heap WAL index, so only query_only can reject this mutation.
    f.retain_committed_wal().await;
    let before = members(&f.root);
    let inspector = EventLog::for_application_inspection(Arc::new(f.owner()))
        .await
        .unwrap();
    let source = inspector
        .load_application(f.reference.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(source.source()).unwrap(),
        json!({
            "reference":f.reference,"input":{"instances":{}},
            "remoteExports":[]
        })
    );
    drop(source);
    let launch = inspector.application_launch().await.unwrap().unwrap();
    assert_eq!(launch.deployment, f.reference.deployment);
    assert_eq!(launch.configuration, f.configuration);
    assert!(launch.pending.is_none());
    let error = inspector
        .compare_and_set_application_launch_configuration(
            f.reference.clone(),
            f.configuration.clone(),
            json!({"original":"forbidden replacement"}),
        )
        .await
        .unwrap_err();
    let StoreError::Sqlx(sqlx::Error::Database(error)) = error else {
        panic!("ordinary mutation must be rejected by SQLite query_only")
    };
    assert_eq!(error.code().as_deref(), Some("8"));
    assert_eq!(
        inspector
            .application_launch()
            .await
            .unwrap()
            .unwrap()
            .configuration,
        f.configuration
    );
    unchanged(&f.root, &before);

    let root_busy = RootOwner::open_existing(&f.root, &f.namespaces)
        .err()
        .expect("original Root admission must fail");
    assert_eq!(root_busy.kind(), std::io::ErrorKind::WouldBlock);
    assert!(matches!(
        EventLog::open(&f.database()).await,
        Err(StoreError::WriterBusy)
    ));
    unchanged(&f.root, &before);
    inspector.close().await.unwrap();
    unchanged(&f.root, &before);
    f.reacquire();
    unchanged(&f.root, &before);
}

#[tokio::test]
async fn inspection_missing_original_members_and_foreign_identity_never_initialize_or_repair() {
    let absent = tempfile::tempdir().unwrap();
    let path = absent.path().join("missing-root");
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let before = members(absent.path());
    let error = RootOwner::open_existing(&path, &namespaces)
        .err()
        .expect("missing Root admission must fail");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    unchanged(absent.path(), &before);

    let f = Fixture::new().await;
    for missing in [f.database(), f.database_lease()] {
        let saved = std::fs::read(&missing).unwrap();
        let permissions = std::fs::metadata(&missing).unwrap().permissions();
        std::fs::remove_file(&missing).unwrap();
        let before = members(&f.root);
        let error = match EventLog::for_application_inspection(Arc::new(f.owner())).await {
            Ok(inspector) => {
                inspector.close().await.unwrap();
                panic!(
                    "inspection accepted missing original member {}",
                    missing.display()
                )
            }
            Err(error) => error,
        };
        assert!(
            matches!(error,StoreError::Io(ref error) if error.kind()==std::io::ErrorKind::NotFound),
            "missing {}: {error}",
            missing.display()
        );
        unchanged(&f.root, &before);
        // Restore only this test's deliberate setup damage, after failed startup
        // has returned with its SQL owner closed. Never repair during inspection.
        std::fs::write(&missing, saved).unwrap();
        std::fs::set_permissions(&missing, permissions).unwrap();
        f.reacquire();
    }
    let control = f.namespaces.control.join(&f.reference.state_domain);
    std::fs::remove_dir(&control).unwrap();
    let before = members(&f.root);
    let error = RootOwner::open_existing(&f.root, &f.namespaces)
        .err()
        .expect("original Root admission must fail");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    unchanged(&f.root, &before);
    // Only the explicit writer acquisition restores the fixture's deliberate
    // damage, including platform-specific private ACLs on Windows.
    drop(RootOwner::open(&f.root, &f.namespaces).unwrap());
    f.reacquire();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &f.namespaces.ownership,
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let before = members(&f.root);
        assert!(
            RootOwner::open_existing(&f.root, &f.namespaces).is_err(),
            "existing-only inspection must not tighten unsafe coordination permissions"
        );
        unchanged(&f.root, &before);
        assert_eq!(
            std::fs::metadata(&f.namespaces.ownership)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        std::fs::set_permissions(
            &f.namespaces.ownership,
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
    // Deliberately foreign identity, changed under the original test-owned leases.
    let owner = f.owner();
    let lease = FileLease::acquire_existing(&f.database_lease()).unwrap();
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(f.database()))
            .await
            .unwrap();
    sqlx::query("PRAGMA application_id=12345")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    drop((lease, owner));
    let before = members(&f.root);
    let error = match EventLog::for_application_inspection(Arc::new(f.owner())).await {
        Ok(inspector) => {
            inspector.close().await.unwrap();
            panic!("foreign database accepted")
        }
        Err(error) => error,
    };
    assert!(matches!(error, StoreError::UnsupportedDatabase), "{error}");
    unchanged(&f.root, &before);
    f.reacquire();
    unchanged(&f.root, &before);
}
