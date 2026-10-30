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

use super::*;
use crate::root::{RootNamespaces, RootOwner};

use std::sync::Arc;

pub(super) fn input() -> Input {
    Input {
        ui: None,
        instances: BTreeMap::new(),
    }
}
pub(super) async fn store() -> (tempfile::TempDir, EventLog) {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let owner = Arc::new(RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
    let store = EventLog::for_root(owner).await.unwrap();
    (dir, store)
}

fn package(marker: &str) -> Package {
    use maka_plugin_core::package::{Declaration, EntryDeclaration, Implementation, Realm};
    let declaration = Declaration {
        host: Some(EntryDeclaration {
            implementation: Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            configuration: serde_json::json!({"type":"object"}).into(),
            imports: BTreeMap::new(),
            exports: BTreeMap::new(),
        }),
        ui: None,
        composition: None,
    };
    Package::new(BTreeMap::from([
        (
            maka_packages::MANIFEST_FILE.into(),
            serde_json::to_vec(
                &serde_json::json!({"schemaVersion":1,"id":"sample","application":declaration}),
            )
            .unwrap(),
        ),
        ("host.mjs".into(), marker.as_bytes().to_vec()),
    ]))
    .unwrap()
}
fn selected(package: &Package) -> Input {
    use maka_plugin_core::composition::{Configuration, Node, PackageUse};
    let mut input = input();
    input.instances.insert(
        "view".into(),
        Node {
            key: Uuid::from_u128(1),
            package: package.application_ref().into(),
            use_package: PackageUse::Host,
            configuration: Configuration::default(),
            parameters: Configuration::default(),
            bindings: BTreeMap::new(),
            disabled: false,
            overrides: vec![],
        },
    );
    input
}

#[tokio::test]
async fn immutable_bytes_preserve_every_committed_source_revision() {
    let (_dir, store) = store().await;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    assert!(store.load_application(a).await.unwrap().is_none());
    let old = package("export default {}; // original");
    let new = package("export default {}; // replacement");
    let original = store
        .commit_application(a, 0, selected(&old), vec![], vec![old.clone()])
        .await
        .unwrap();
    store
        .commit_application(b, 0, selected(&old), vec![], vec![old.clone()])
        .await
        .unwrap();
    store
        .commit_application(a, 1, selected(&new), vec![], vec![new.clone()])
        .await
        .unwrap();
    assert_eq!(
        store.load_application(b).await.unwrap().unwrap().packages[0].files(),
        old.files()
    );
    assert_eq!(
        store.load_application(a).await.unwrap().unwrap().packages[0].files(),
        new.files()
    );
    store
        .commit_application(b, 1, input(), vec![], vec![])
        .await
        .unwrap();
    let count = store
        .connection
        .run(|conn| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM application_packages")
                        .fetch_one(conn)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        store
            .load_application_at(&original)
            .await
            .unwrap()
            .unwrap()
            .packages[0]
            .files(),
        old.files()
    );
    let mut absent = original.clone();
    absent.revision = 3;
    assert!(store.load_application_at(&absent).await.unwrap().is_none());
    let mut foreign = original;
    foreign.state_domain = "0".repeat(64);
    assert!(store.load_application_at(&foreign).await.is_err());
    store.close().await.unwrap();
}

#[tokio::test]
async fn corrupted_exact_bytes_cannot_be_loaded_or_silently_overwritten() {
    let (_dir, store) = store().await;
    let id = Uuid::new_v4();
    let package = package("export default {};");
    store
        .commit_application(id, 0, selected(&package), vec![], vec![package.clone()])
        .await
        .unwrap();
    store
        .connection
        .run(|conn| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE application_package_files SET payload = X'00' WHERE path = 'host.mjs'",
                )
                .execute(conn)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        store
            .load_application(id)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("digest mismatch")
    );
    assert!(
        store
            .commit_application(id, 1, selected(&package), vec![], vec![package])
            .await
            .is_err()
    );
    let revision = store
        .connection
        .run(move |conn| {
            Box::pin(async move {
                Ok(sqlx::query_scalar::<_, i64>(
                    "SELECT revision FROM application_deployments WHERE id = ?",
                )
                .bind(id.to_string())
                .fetch_one(conn)
                .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(revision, 1);
    store.close().await.unwrap();
}

#[tokio::test]
async fn stored_package_paths_types_and_immutable_digests_are_checked() {
    for corruption in [
        "UPDATE application_package_files SET path = '../escape' WHERE path='host.mjs'",
        "UPDATE application_package_files SET payload = zeroblob(8388609) WHERE path='host.mjs'",
        "UPDATE application_package_files SET payload = 'x' || char(0) || printf('%.*c', 8388609, 'z') WHERE path='host.mjs'",
    ] {
        let (_dir, store) = store().await;
        let id = Uuid::new_v4();
        let package = package("export default {};");
        store
            .commit_application(id, 0, selected(&package), vec![], vec![package])
            .await
            .unwrap();
        store
            .connection
            .run(move |conn| {
                Box::pin(async move {
                    sqlx::query(corruption).execute(conn).await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let error = store.load_application(id).await.err().unwrap().to_string();
        if corruption.contains("char(0)") {
            assert!(error.contains("payload must be a BLOB"), "{error}");
        } else if corruption.contains("zeroblob") {
            assert!(error.contains("digest mismatch"), "{error}");
        } else {
            assert!(error.contains("invalid package path"), "{error}");
        }
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn concurrent_cas_has_one_commit_and_reopen_keeps_original_domain() {
    let (dir, store) = store().await;
    let id = Uuid::new_v4();
    let (a, b) = tokio::join!(
        store.commit_application(id, 0, input(), vec![], vec![]),
        store.commit_application(id, 0, input(), vec![], vec![])
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let source = a.or(b).unwrap();
    assert_eq!(
        source.state_domain,
        store.root_owner.as_ref().unwrap().root_id()
    );
    store.close().await.unwrap();
    let namespaces = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let owner = Arc::new(RootOwner::open(&dir.path().join("root"), &namespaces).unwrap());
    let store = EventLog::for_root(owner).await.unwrap();
    assert_eq!(
        store
            .load_application(id)
            .await
            .unwrap()
            .unwrap()
            .source
            .reference,
        source
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn metadata_snapshot_never_materializes_package_payloads() {
    let (_dir, store) = store().await;
    let package = package(&"x".repeat(8 * 1024 * 1024));
    let reference = package.application_ref();
    let deployment = Uuid::new_v4();
    let source = store
        .commit_application(deployment, 0, selected(&package), vec![], vec![package])
        .await
        .unwrap();
    let metadata = store
        .read_application_metadata(deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata.source.reference, source);
    assert_eq!(metadata.packages, vec![reference]);
    let mut empty = metadata.source.input.clone();
    empty.instances.clear();
    let next = store
        .commit_application(deployment, 1, empty, vec![], vec![])
        .await
        .unwrap();
    assert!(
        store
            .read_application_metadata_at(&next)
            .await
            .unwrap()
            .unwrap()
            .packages
            .is_empty()
    );
    let original = serde_json::to_vec(&metadata).unwrap();
    assert!(original.len() < 4096);
    // A payload that cannot be loaded still must not enter metadata reads. This
    // tests the physical DAO boundary, not a profiler estimate or source string.
    store.connection.run(|connection| Box::pin(async move {
        sqlx::query("UPDATE application_package_files SET payload = zeroblob(8388609) WHERE path='host.mjs'").execute(connection).await?;
        Ok(())
    })).await.unwrap();
    assert_eq!(
        serde_json::to_vec(
            &store
                .read_application_metadata_at(&source)
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        original
    );
    assert!(store.load_application_at(&source).await.is_err());
    assert_eq!(
        store
            .load_application(deployment)
            .await
            .unwrap()
            .unwrap()
            .source
            .reference,
        next
    );
    assert!(store.read_application_metadata(Uuid::nil()).await.is_err());
    assert!(
        store
            .read_application_metadata(Uuid::new_v4())
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn checked_deployment_cannot_cross_root_owners() {
    let (_first_dir, first) = store().await;
    let (_other_dir, other) = store().await;
    let id = Uuid::new_v4();
    first
        .commit_application(id, 0, input(), vec![], vec![])
        .await
        .unwrap();
    let loaded = first.load_application(id).await.unwrap().unwrap();
    loaded.check_store(&first).unwrap();
    assert!(loaded.check_store(&other).is_err());
    first.drain().await;
    drop(first);
    assert!(
        loaded
            .check_store(&other)
            .unwrap_err()
            .to_string()
            .contains("original source Root has closed")
    );
    other.drain().await;
}

#[tokio::test]
async fn prepared_commit_snapshot_cannot_cross_reopened_root_lease() {
    let (directory, original) = store().await;
    let id = Uuid::new_v4();
    let prepared = PreparedApplication::new(input(), vec![], vec![]).unwrap();
    let loaded = original
        .commit_prepared_application(id, 0, prepared)
        .await
        .unwrap();
    loaded.check_store(&original).unwrap();
    original.drain().await;
    drop(original);
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let reopened = EventLog::for_root(Arc::new(
        RootOwner::open(&directory.path().join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    assert_eq!(
        reopened.owned_root().unwrap().root_id(),
        loaded.source().reference.state_domain
    );
    assert!(loaded.check_store(&reopened).is_err());
    reopened
        .load_application(id)
        .await
        .unwrap()
        .unwrap()
        .check_store(&reopened)
        .unwrap();
    reopened.drain().await;
}
