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
use maka_plugin_core::composition::InstanceId;
use std::sync::Arc;

pub(super) fn input() -> Input {
    Input {
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

#[tokio::test]
async fn malformed_typed_source_is_rejected_when_loading() {
    let (_dir, store) = store().await;
    let id = Uuid::new_v4();
    store
        .commit_application(id, 0, input(), vec![], vec![])
        .await
        .unwrap();
    store.connection.run(move |conn| Box::pin(async move {
        sqlx::query("UPDATE application_sources SET input_json = json_object('instances', 'invalid') WHERE deployment = ?")
            .bind(id.to_string()).execute(conn).await?;
        Ok(())
    })).await.unwrap();
    let error = store.load_application(id).await.err().unwrap().to_string();
    assert!(error.contains("invalid type"), "{error}");
    store.close().await.unwrap();
}

#[tokio::test]
async fn requires_real_state_root_and_non_nil_identity() {
    let dir = tempfile::tempdir().unwrap();
    let unowned = EventLog::open(&dir.path().join("test.sqlite"))
        .await
        .unwrap();
    assert!(
        unowned
            .commit_application(Uuid::new_v4(), 0, input(), vec![], vec![])
            .await
            .is_err()
    );
    unowned.close().await.unwrap();
    let (_dir, owned) = store().await;
    assert!(
        owned
            .commit_application(Uuid::nil(), 0, input(), vec![], vec![])
            .await
            .is_err()
    );
    assert!(
        owned
            .commit_application(
                Uuid::new_v4(),
                9_007_199_254_740_991,
                input(),
                vec![],
                vec![]
            )
            .await
            .is_err()
    );
    owned.close().await.unwrap();
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
async fn duplicate_package_selection_and_missing_exact_revision_commit_nothing() {
    let (_dir, store) = store().await;
    let id = Uuid::new_v4();
    let package = package("export default {};");
    let error = store
        .commit_application(
            id,
            0,
            selected(&package),
            vec![],
            vec![package.clone(), package.clone()],
        )
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains("duplicate application package revision"),
        "{error}"
    );
    assert!(store.load_application(id).await.unwrap().is_none());
    assert!(
        store
            .commit_application(id, 0, selected(&package), vec![], vec![])
            .await
            .is_err()
    );
    assert!(store.load_application(id).await.unwrap().is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn application_packages_have_no_aggregate_byte_limit() {
    let (_dir, store) = store().await;
    let id = Uuid::new_v4();
    let mut source = input();
    let mut packages = Vec::new();
    for index in 0..17u128 {
        let package = package(
            &char::from(b'a' + index as u8)
                .to_string()
                .repeat(8 * 1024 * 1024),
        );
        let mut node = selected(&package).instances.remove("view").unwrap();
        node.key = Uuid::from_u128(index + 1);
        source.instances.insert(format!("plugin{index}"), node);
        packages.push(package);
    }
    let reference = store
        .commit_application(id, 0, source, vec![], packages)
        .await
        .unwrap();
    let loaded = store.load_application(id).await.unwrap().unwrap();
    assert_eq!(loaded.source.reference, reference);
    assert_eq!(loaded.packages.len(), 17);
    assert!(
        loaded
            .packages
            .iter()
            .map(|package| package.files().values().map(Vec::len).sum::<usize>())
            .sum::<usize>()
            > 128 * 1024 * 1024
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
async fn prepared_commit_preserves_exact_source_and_cas() {
    let (_directory, store) = store().await;
    let selected_package = package("export const value = 'selected';");
    let extra_package = package("export const value = 'unused';");
    let original = selected(&selected_package);
    let prepared = prepare_applications(
        &[(&original, &[])],
        &[selected_package.clone(), extra_package],
    )
    .unwrap()
    .pop()
    .unwrap();
    assert_eq!(prepared.packages().len(), 1);
    assert_eq!(prepared.packages()[0].files(), selected_package.files());
    let id = Uuid::new_v4();
    let committed = store
        .commit_prepared_application(id, 0, prepared)
        .await
        .unwrap();
    committed.check_store(&store).unwrap();
    assert_eq!(committed.source().reference.revision, 1);
    assert_eq!(
        serde_json::to_value(&committed.source().input).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    let persisted = store.load_application(id).await.unwrap().unwrap();
    assert_eq!(persisted.source().reference, committed.source().reference);
    assert_eq!(
        persisted.packages()[0].files(),
        committed.packages()[0].files()
    );
    assert_eq!(
        persisted.plan().instances().len(),
        committed.plan().instances().len()
    );
    let stale = PreparedApplication::new(original, vec![], vec![selected_package]).unwrap();
    assert!(matches!(
        store.commit_prepared_application(id, 0, stale).await,
        Err(StoreError::RevisionConflict { .. })
    ));
    assert_eq!(
        store
            .read_application_metadata(id)
            .await
            .unwrap()
            .unwrap()
            .source
            .reference
            .revision,
        1
    );
    store.drain().await;
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

#[tokio::test]
async fn selected_shared_package_pool_preserves_complete_source_and_original_selection() {
    let (_directory, store) = store().await;
    let first = package("export default 'first';");
    let second = package("export default 'second';");
    let mut source = selected(&first);
    source
        .instances
        .get_mut("view")
        .unwrap()
        .configuration
        .values
        .insert(
            "padding".into(),
            serde_json::json!("甲🙂z".repeat((2 * 1024 * 1024 + 128 * 1024) / 8)),
        );
    validate_application(&source, &[], std::slice::from_ref(&first)).unwrap();
    let pool = vec![first.clone(), second.clone()];
    // Ordinary preparation retains all explicitly supplied packages, while the
    // shared-pool path below selects only the packages used by each source.
    let complete = PreparedApplication::new(source.clone(), vec![], pool.clone()).unwrap();
    assert_eq!(complete.packages().len(), 2);
    let other = selected(&second);
    let mut prepared = prepare_applications(&[(&source, &[]), (&other, &[])], &pool).unwrap();
    assert_eq!(prepared[0].packages().len(), 1);
    assert_eq!(
        prepared[0].packages()[0].application_ref(),
        first.application_ref()
    );
    assert_eq!(
        prepared[1].packages()[0].application_ref(),
        second.application_ref()
    );
    let id = Uuid::new_v4();
    let committed = store
        .commit_prepared_application(id, 0, prepared.remove(0))
        .await
        .unwrap();
    let loaded = store.load_application(id).await.unwrap().unwrap();
    assert_eq!(loaded.source().reference, committed.source().reference);
    assert!(
        loaded.source().input == source,
        "complete source changed during commit"
    );
    assert_eq!(loaded.packages().len(), 1);
    // Recovery decodes all immutable bytes again and retains each source's
    // original package selection from the shared pool.
    let recovered_pool: Vec<_> = pool
        .iter()
        .map(|package| Package::from_bundle(&package.to_bundle()).unwrap())
        .collect();
    let recovered =
        prepare_applications(&[(&source, &[]), (&other, &[])], &recovered_pool).unwrap();
    assert!(
        recovered[0].input() == &source,
        "recovery lost the complete original source"
    );
    assert_eq!(
        recovered[0].packages()[0].files(),
        loaded.packages()[0].files()
    );
    assert_eq!(
        store
            .read_application_metadata(id)
            .await
            .unwrap()
            .unwrap()
            .source
            .reference
            .revision,
        1
    );
    store.drain().await;
}

#[tokio::test]
async fn complete_source_over_two_mib_survives_commit_and_original_root_reopen() {
    let (directory, store) = store().await;
    let package = package("export default {}; // complete source");
    let mut expected = selected(&package);
    let padding = "甲🙂z".repeat(3 * 1024 * 1024 / 8);
    expected
        .instances
        .get_mut("view")
        .unwrap()
        .configuration
        .values
        .insert("padding".into(), serde_json::json!(padding));
    let deployment = Uuid::new_v4();
    let committed = store
        .commit_application(
            deployment,
            0,
            expected.clone(),
            vec![],
            vec![package.clone()],
        )
        .await;
    store.shutdown().await.unwrap();
    drop(store);
    // Close the original owner before checking the commit and acquiring a new lease.
    assert!(
        committed.is_ok(),
        "complete source commit failed: {committed:?}"
    );
    let original = committed.unwrap();
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let reopened = EventLog::for_root(Arc::new(
        RootOwner::open(&directory.path().join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    let loaded = reopened.load_application_at(&original).await;
    let metadata = reopened.read_application_metadata_at(&original).await;
    let stale = reopened
        .commit_application(
            deployment,
            0,
            expected.clone(),
            vec![],
            vec![package.clone()],
        )
        .await;
    let mut foreign = original.clone();
    foreign.state_domain = "0".repeat(64);
    let foreign_rejected = reopened.load_application_at(&foreign).await.is_err();
    reopened.shutdown().await.unwrap();

    assert_eq!(original.deployment, deployment);
    assert_eq!(original.revision, 1);
    let loaded = loaded.unwrap().unwrap();
    assert_eq!(loaded.source().reference, original);
    assert!(
        loaded.source().input == expected,
        "reopened source lost original configuration bytes"
    );
    assert!(loaded.source().remote_exports.is_empty());
    assert_eq!(loaded.packages()[0].files(), package.files());
    assert_eq!(loaded.plan().instances().len(), 1);
    assert!(
        loaded.plan().instances()[&InstanceId(vec![Uuid::from_u128(1)])].configuration["padding"]
            == serde_json::json!(padding),
        "reopened plan lost complete configuration"
    );
    let metadata = metadata.unwrap().unwrap();
    assert_eq!(metadata.source.reference, original);
    assert!(
        metadata.source.input == expected,
        "metadata read lost original configuration bytes"
    );
    assert!(matches!(stale, Err(StoreError::RevisionConflict { .. })));
    assert!(foreign_rejected);
}
