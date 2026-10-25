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
use crate::{
    applications::tests::store,
    root::{RootNamespaces, RootOwner},
};
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Configuration, Environment, Input, Node, PackageUse, PresentationTarget},
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation},
};
use serde_json::json;
use std::collections::BTreeMap;
use uuid::Uuid;

async fn source(store: &EventLog, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"ui.checkpoint","application":Declaration {entries:BTreeMap::from([(EntryTarget::Tui,EntryDeclaration {scene:None,implementation:Implementation::Native {implementation:"test.checkpoint".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::new()})]),composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Ui,
                    presentation: Some(PresentationTarget::Tui),
                },
                instances: BTreeMap::from([(
                    "editor".into(),
                    Node {
                        key: Uuid::from_u128(42),
                        package: package.application_ref().into(),
                        use_package: PackageUse::Entry,
                        configuration: Configuration::default(),
                        parameters: Configuration::default(),
                        bindings: BTreeMap::new(),
                        disabled: false,
                        overrides: vec![],
                    },
                )]),
                recovery: None,
                launch: None,
            },
            vec![],
            vec![package],
        )
        .await
        .unwrap()
}
fn instance() -> InstanceId {
    InstanceId(vec![Uuid::from_u128(42)])
}

#[tokio::test]
async fn original_ui_namespace_survives_source_changes_and_root_reopen_without_cross_owner_writes()
{
    let (dir, store) = store().await;
    let store = Arc::new(store);
    let deployment = Uuid::new_v4();
    let original = source(&store, deployment, 0).await;
    let checkpoints = store.ui_checkpoints(&original, &instance()).await.unwrap();
    let data = json!({"domain":"host-a", "namespace":"agent-a"});
    let metadata =
        json!({"owner":"native-a", "revision":9, "selection":[1,3], "attachments":["artifact-a"]});
    let revision = checkpoints
        .write(
            "conversation",
            None,
            "editor@1",
            &data,
            &metadata,
            "甲👩‍💻z".as_bytes().to_vec(),
        )
        .await
        .unwrap();
    assert_eq!(revision, 1);
    let saved = checkpoints
        .read("conversation", |_| Ok(()))
        .await
        .unwrap()
        .unwrap();
    let updated = source(&store, deployment, 1).await;
    let replacement = store.ui_checkpoints(&updated, &instance()).await.unwrap();
    assert_eq!(
        replacement.read("conversation", |_| Ok(())).await.unwrap(),
        Some(saved.clone())
    );
    let other = source(&store, Uuid::new_v4(), 0).await;
    assert!(
        store
            .ui_checkpoints(&other, &instance())
            .await
            .unwrap()
            .read("conversation", |_| Ok(()))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .ui_checkpoints(&original, &InstanceId(vec![Uuid::new_v4()]))
            .await
            .is_err()
    );
    let mut foreign = original.clone();
    foreign.state_domain = "a".repeat(64);
    assert!(store.ui_checkpoints(&foreign, &instance()).await.is_err());
    for (format, data) in [
        ("editor@2", data.clone()),
        ("editor@1", json!({"domain":"host-b"})),
    ] {
        assert!(
            replacement
                .write("conversation", Some(1), format, &data, &metadata, vec![])
                .await
                .is_err()
        );
        assert_eq!(
            replacement.read("conversation", |_| Ok(())).await.unwrap(),
            Some(saved.clone())
        );
    }
    drop(checkpoints);
    drop(replacement);
    store.shutdown().await.unwrap();
    drop(store);
    let namespaces = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let root = Arc::new(RootOwner::open(&dir.path().join("root"), &namespaces).unwrap());
    let reopened = Arc::new(EventLog::for_root(root).await.unwrap());
    let checkpoints = reopened
        .ui_checkpoints(&updated, &instance())
        .await
        .unwrap();
    assert_eq!(
        checkpoints.read("conversation", |_| Ok(())).await.unwrap(),
        Some(saved)
    );
    drop(checkpoints);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn concurrent_mounts_cannot_replace_a_saved_or_cleared_original_checkpoint() {
    let (_dir, store) = store().await;
    let store = Arc::new(store);
    let source = source(&store, Uuid::new_v4(), 0).await;
    let first = store.ui_checkpoints(&source, &instance()).await.unwrap();
    let second = store.ui_checkpoints(&source, &instance()).await.unwrap();
    let (a, b) = tokio::join!(
        first.write(
            "draft",
            None,
            "v1",
            &Value::Null,
            &Value::Null,
            b"one".to_vec()
        ),
        second.write(
            "draft",
            None,
            "v1",
            &Value::Null,
            &Value::Null,
            b"two".to_vec()
        )
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert!(matches!(
        a.as_ref().err().or(b.as_ref().err()).unwrap(),
        StoreError::RevisionConflict { .. }
    ));
    let (current, ()) = first.read("draft", |_| Ok(())).await.unwrap().unwrap();
    first
        .write(
            "draft",
            Some(current.revision),
            "v1",
            &Value::Null,
            &Value::Null,
            vec![],
        )
        .await
        .unwrap();
    assert!(
        second
            .write(
                "draft",
                None,
                "v1",
                &Value::Null,
                &Value::Null,
                b"resurrection".to_vec()
            )
            .await
            .is_err()
    );
    assert!(
        second
            .write(
                "draft",
                Some(current.revision),
                "v1",
                &Value::Null,
                &Value::Null,
                b"stale".to_vec()
            )
            .await
            .is_err()
    );
    assert!(
        first
            .read("draft", |_| Ok(()))
            .await
            .unwrap()
            .unwrap()
            .0
            .content
            .is_empty()
    );
}

#[tokio::test]
async fn whole_checkpoint_above_former_content_and_namespace_limits_survives_reopen() {
    let (dir, store) = store().await;
    let store = Arc::new(store);
    let original = source(&store, Uuid::new_v4(), 0).await;
    let checkpoints = store.ui_checkpoints(&original, &instance()).await.unwrap();
    // Eight UTF-8 bytes per unit: this tests whole text beyond both old limits.
    let body = "甲🙂z".repeat(41 * 1024 * 1024 / 8).into_bytes();
    let data = json!({"domain":"original-host", "namespace":"original-agent"});
    let metadata = json!({"owner":"original-editor", "selection":[1,3]});
    let written = checkpoints
        .write(
            "large-draft",
            None,
            "editor@1",
            &data,
            &metadata,
            body.clone(),
        )
        .await;
    drop(checkpoints);
    store.shutdown().await.unwrap();
    drop(store);

    // On the original implementation, still settle the owner before asserting
    // admission. Reopen only after a successful write so refusal stays bounded.
    let saved = if written.is_ok() {
        let namespaces = RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let root = Arc::new(RootOwner::open(&dir.path().join("root"), &namespaces).unwrap());
        let reopened = Arc::new(EventLog::for_root(root).await.unwrap());
        let checkpoints = reopened
            .ui_checkpoints(&original, &instance())
            .await
            .unwrap();
        let saved = checkpoints.read("large-draft", |_| Ok(())).await;
        drop(checkpoints);
        reopened.shutdown().await.unwrap();
        saved
    } else {
        Ok(None)
    };

    assert!(
        written.is_ok(),
        "whole checkpoint write failed: {written:?}"
    );
    assert_eq!(written.unwrap(), 1);
    let (saved, ()) = saved
        .expect("whole checkpoint read failed")
        .expect("saved checkpoint missing");
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.format, "editor@1");
    assert_eq!(saved.data_source, data);
    assert_eq!(saved.metadata, metadata);
    assert!(
        saved.content == body,
        "whole checkpoint bytes differ: got {}, expected {}",
        saved.content.len(),
        body.len()
    );
}

struct ReadCharge {
    bytes: usize,
    live: Arc<std::sync::atomic::AtomicUsize>,
}
impl ReadCharge {
    fn new(bytes: usize, live: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        live.fetch_add(bytes, std::sync::atomic::Ordering::SeqCst);
        Self { bytes, live }
    }
}
impl Drop for ReadCharge {
    fn drop(&mut self) {
        self.live
            .fetch_sub(self.bytes, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tokio::test]
async fn admission_rejection_and_invalid_headers_release_original_read_ownership() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (_dir, store) = store().await;
    let store = Arc::new(store);
    let source = source(&store, Uuid::new_v4(), 0).await;
    let checkpoints = store.ui_checkpoints(&source, &instance()).await.unwrap();
    assert!(
        checkpoints
            .read("absent", |_| -> Result<(), StoreError> {
                panic!("absent checkpoint must not request admission")
            })
            .await
            .unwrap()
            .is_none()
    );
    let body = "甲🙂z".repeat(2048).into_bytes();
    checkpoints
        .write(
            "draft",
            None,
            "v1",
            &Value::Null,
            &Value::Null,
            body.clone(),
        )
        .await
        .unwrap();
    let complete_metadata = json!("\n".repeat(40 * 1024));
    checkpoints
        .write(
            "metadata",
            None,
            "v1",
            &Value::Null,
            &complete_metadata,
            vec![],
        )
        .await
        .unwrap();
    let (metadata_record, metadata_charge) =
        checkpoints.read("metadata", Ok).await.unwrap().unwrap();
    assert_eq!(metadata_record.metadata, complete_metadata);
    assert_eq!(metadata_charge, 2 + 4 + complete_metadata.to_string().len());
    let requested = Arc::new(AtomicUsize::new(0));
    let request = requested.clone();
    let rejected = checkpoints
        .read("draft", move |bytes| -> Result<(), StoreError> {
            request.store(bytes, Ordering::SeqCst);
            Err(invalid("test allocation admission rejected"))
        })
        .await;
    assert_eq!(requested.load(Ordering::SeqCst), body.len() + 10);
    assert!(
        rejected
            .err()
            .unwrap()
            .to_string()
            .contains("test allocation admission rejected")
    );

    let live = Arc::new(AtomicUsize::new(0));
    let charge = live.clone();
    let loaded = checkpoints
        .read("draft", move |bytes| Ok(ReadCharge::new(bytes, charge)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.0.content, body);
    assert_eq!(live.load(Ordering::SeqCst), body.len() + 10);
    drop(loaded);
    assert_eq!(live.load(Ordering::SeqCst), 0);

    // Malformed headers are still rejected after successful admission,
    // and each error returns the original allocation token.
    for (query, value, diagnostic) in [
        (
            "UPDATE application_ui_checkpoints SET format=?, data_source_json='null', metadata_json='null', revision=1 WHERE key='draft'",
            String::new(),
            "invalid UI checkpoint format",
        ),
        (
            "UPDATE application_ui_checkpoints SET format='v1', data_source_json=?, metadata_json='null', revision=1 WHERE key='draft'",
            "{".into(),
            "invalid UI checkpoint source",
        ),
        (
            "UPDATE application_ui_checkpoints SET format='v1', data_source_json='null', metadata_json=?, revision=1 WHERE key='draft'",
            "{".into(),
            "invalid UI checkpoint metadata",
        ),
        (
            "UPDATE application_ui_checkpoints SET format='v1', data_source_json='null', metadata_json='null', revision=? WHERE key='draft'",
            "9007199254740992".into(),
            "invalid UI checkpoint revision",
        ),
    ] {
        store
            .connection
            .run(move |connection| {
                Box::pin(async move {
                    // This fixture deliberately corrupts stored headers. Keep normal
                    // SQL constraints enabled for the subsequent public read.
                    sqlx::query("PRAGMA ignore_check_constraints=ON")
                        .execute(&mut *connection)
                        .await?;
                    let updated = sqlx::query(query)
                        .bind(value)
                        .execute(&mut *connection)
                        .await;
                    sqlx::query("PRAGMA ignore_check_constraints=OFF")
                        .execute(&mut *connection)
                        .await?;
                    updated?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let charge = live.clone();
        let result = checkpoints
            .read("draft", move |bytes| Ok(ReadCharge::new(bytes, charge)))
            .await;
        assert!(result.err().unwrap().to_string().contains(diagnostic));
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
    drop(checkpoints);
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn admission_and_payload_share_original_snapshot_during_a_real_concurrent_write() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (dir, store) = store().await;
    let store = Arc::new(store);
    let source = source(&store, Uuid::new_v4(), 0).await;
    let checkpoints = store.ui_checkpoints(&source, &instance()).await.unwrap();
    let original = "甲🙂z".as_bytes().to_vec();
    let replacement = "larger replacement 甲🙂z".repeat(8).into_bytes();
    checkpoints
        .write(
            "draft",
            None,
            "v1",
            &Value::Null,
            &Value::Null,
            original.clone(),
        )
        .await
        .unwrap();
    // WAL lets a second connection commit while the original read transaction
    // holds its snapshot. The callback executes exactly between length and fetch.
    store
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("PRAGMA journal_mode=WAL")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let database = dir.path().join("root").join(crate::root::ROOT_DATABASE);
    let changed = replacement.clone();
    let live = Arc::new(AtomicUsize::new(0));
    let charge = live.clone();
    let loaded = checkpoints
        .read("draft", move |bytes| {
            let writer = rusqlite::Connection::open(database)?;
            writer.execute(
                "UPDATE application_ui_checkpoints SET content=?, revision=2 WHERE key='draft'",
                [changed],
            )?;
            Ok(ReadCharge::new(bytes, charge))
        })
        .await
        .unwrap()
        .unwrap();
    let next = checkpoints.read("draft", Ok).await.unwrap().unwrap();
    let original_revision = loaded.0.revision;
    let original_bytes_match = loaded.0.content == original;
    let original_charge = loaded.1.bytes;
    let original_live = live.load(Ordering::SeqCst);
    drop(loaded);
    let released = live.load(Ordering::SeqCst);
    let revision = checkpoints
        .write("draft", Some(2), "v1", &Value::Null, &Value::Null, vec![])
        .await
        .unwrap();
    let empty = checkpoints.read("draft", Ok).await.unwrap().unwrap();
    drop(checkpoints);
    store.shutdown().await.unwrap();

    assert_eq!(original_revision, 1);
    assert!(original_bytes_match);
    assert_eq!(original_charge, original.len() + 10);
    assert_eq!(original_live, original.len() + 10);
    assert_eq!(released, 0);
    assert_eq!(next.0.revision, 2);
    assert_eq!(next.0.content, replacement);
    assert_eq!(next.1, next.0.content.len() + 10);
    assert_eq!(revision, 3);
    assert_eq!(empty.0.revision, 3);
    assert!(empty.0.content.is_empty());
    assert_eq!(empty.1, 10);
}

async fn root_source(store: &crate::RootStore, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"ui.checkpoint","application":Declaration {entries:BTreeMap::from([(EntryTarget::Tui,EntryDeclaration {scene:None,implementation:Implementation::Native {implementation:"test.checkpoint".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::new()})]),composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Ui,
                    presentation: Some(PresentationTarget::Tui),
                },
                instances: BTreeMap::from([(
                    "editor".into(),
                    Node {
                        key: Uuid::from_u128(42),
                        package: package.application_ref().into(),
                        use_package: PackageUse::Entry,
                        configuration: Configuration::default(),
                        parameters: Configuration::default(),
                        bindings: BTreeMap::new(),
                        disabled: false,
                        overrides: vec![],
                    },
                )]),
                recovery: None,
                launch: None,
            },
            vec![],
            vec![package],
        )
        .await
        .unwrap()
}
#[tokio::test]
async fn idle_root_checkpoint_and_deployment_watch_release_original_authority() {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: dir.path().join("ownership"),
        control: dir.path().join("control"),
    };
    let path = dir.path().join("root");
    let owner = Arc::new(RootOwner::create(&path, &namespaces).unwrap());
    let root = Arc::new(crate::RootStore::open(owner).await.unwrap());
    let reference = root_source(&root, Uuid::new_v4(), 0).await;
    let checkpoints = root.ui_checkpoints(&reference, &instance()).await.unwrap();
    let mut changes = root.subscribe_application(reference).unwrap();
    checkpoints
        .write("open", None, "v1", &json!({}), &json!({}), vec![1, 2, 3])
        .await
        .unwrap();
    assert_eq!(
        checkpoints
            .read("open", |_| Ok(()))
            .await
            .unwrap()
            .unwrap()
            .0
            .content,
        vec![1, 2, 3]
    );
    root.shutdown().await.unwrap();
    assert!(matches!(
        checkpoints.read("open", |_| Ok(())).await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        changes.next().await,
        Err(StoreError::ConnectionClosed)
    ));
    drop(root);
    let reopened = RootOwner::open(&path, &namespaces).unwrap();
    drop((reopened, checkpoints, changes));
}
