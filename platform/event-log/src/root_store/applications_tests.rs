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
use crate::applications::intents::CallerIntent;
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{
        Configuration, Environment, ExecutionLocation, Input, InstanceId, Node, PackageUse,
    },
    contract::{Contract, Interface, Method, MethodMode, Transport},
    deployment::DeploymentRef,
    operation::{RecoveryContract, RecoveryProtocol, RecoveryRef},
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation},
};
use serde_json::json;
use std::{collections::BTreeMap, path::Path, sync::mpsc, time::Duration};
use tokio::sync::oneshot;
use uuid::Uuid;

fn namespaces(path: &Path) -> root::RootNamespaces {
    root::RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    }
}

fn owner(path: &Path) -> Arc<root::RootOwner> {
    Arc::new(root::RootOwner::create(&path.join("root"), &namespaces(path)).unwrap())
}

fn consumer(key: u128) -> InstanceId {
    InstanceId(vec![Uuid::from_u128(key)])
}

async fn source(store: &RootStore, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "caller",
            "application": Declaration {
                entries: BTreeMap::from([(
                    EntryTarget::Host,
                    EntryDeclaration {
                        scene: None,
                        implementation: Implementation::Native { implementation: "test.caller".into() },
                        configuration: json!({"type":"object"}).into(),
                        imports: BTreeMap::new(),
                        exports: BTreeMap::new(),
                    },
                )]),
                composition: None,
            },
        }))
        .unwrap(),
    )]))
    .unwrap();
    let instances = [42, 43]
        .into_iter()
        .map(|key| {
            (
                format!("caller-{key}"),
                Node {
                    key: Uuid::from_u128(key),
                    package: package.application_ref().into(),
                    use_package: PackageUse::Entry,
                    configuration: Configuration::default(),
                    parameters: Configuration::default(),
                    bindings: BTreeMap::new(),
                    disabled: false,
                    overrides: vec![],
                },
            )
        })
        .collect();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Host,
                    presentation: None,
                },
                instances,
                recovery: None,
                launch: None,
            },
            vec![],
            vec![package],
        )
        .await
        .unwrap()
}

fn reference(operation: u128) -> RecoveryRef {
    RecoveryRef {
        source: DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(900),
            revision: 1,
        },
        namespace: consumer(11),
        export: "Service".into(),
        method: "change".into(),
        operation: Uuid::from_u128(operation),
        fingerprint: format!("sha256-{}", "b".repeat(64)),
        contract: RecoveryContract::for_method(
            &Contract {
                name: "test.Change".into(),
                version: 1,
                transport: Transport::Remote,
                interface: Interface::Service {
                    methods: BTreeMap::from([(
                        "change".into(),
                        Method {
                            progress: None,
                            mode: MethodMode::Mutation,
                            input: json!({}).into(),
                            output: json!({}).into(),
                            resources: BTreeMap::new(),
                        },
                    )]),
                },
            },
            "change",
        )
        .unwrap(),
        recovery: RecoveryProtocol::JournalV1,
    }
}

#[tokio::test]
async fn caller_history_filters_interleaved_control_cursors_and_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone()).await.unwrap();
    let first = source(&store, Uuid::from_u128(101), 0).await;
    let other = source(&store, Uuid::from_u128(102), 0).await;
    let snapshot = store
        .load_application_at(&first)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    let mut expected: Vec<CallerIntent> = Vec::new();
    for (caller, key, operation) in [
        (&first, 42, 1),
        (&other, 42, 2),
        (&first, 43, 3),
        (&first, 42, 4),
    ] {
        let recorded = if operation == 4 {
            store
                .record_application_intent_from(
                    &snapshot,
                    consumer(key),
                    reference(operation),
                    json!({"draft":operation}),
                )
                .await
        } else {
            store
                .record_application_intent(
                    caller.clone(),
                    consumer(key),
                    reference(operation),
                    json!({"draft":operation}),
                )
                .await
        }
        .unwrap();
        expected.push(recorded.intent().clone());
    }
    assert_eq!(
        expected.iter().map(|row| row.cursor).collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    let revised = source(&store, first.deployment, 1).await;
    assert_eq!(revised.revision, 2);
    let retry = store
        .record_application_intent(revised, consumer(42), reference(1), json!({"draft":1}))
        .await
        .unwrap();
    assert_eq!(retry.intent(), &expected[0]);
    assert_eq!(retry.intent().caller, first);
    drop(retry);
    assert!(matches!(
        store
            .record_application_intent_from(
                &snapshot,
                consumer(42),
                reference(1),
                json!({"changed":true})
            )
            .await,
        Err(StoreError::EventConflict)
    ));
    let mut changed = reference(1);
    changed.fingerprint = format!("sha256-{}", "c".repeat(64));
    assert!(matches!(
        store
            .record_application_intent(first.clone(), consumer(42), changed, json!({"draft":1}))
            .await,
        Err(StoreError::EventConflict)
    ));
    assert!(matches!(
        store
            .record_application_intent_from(&snapshot, consumer(99), reference(5), json!(null))
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert_eq!(
        store
            .application_intent(first.deployment, consumer(42), reference(1).operation)
            .await
            .unwrap(),
        Some(expected[0].clone())
    );
    assert_eq!(
        store
            .application_intents(first.deployment, consumer(42), 0, 1)
            .await
            .unwrap(),
        [expected[0].clone()]
    );
    assert_eq!(
        store
            .application_intents(first.deployment, consumer(42), expected[1].cursor, 128)
            .await
            .unwrap(),
        [expected[3].clone()]
    );
    assert_eq!(
        store
            .application_deployment_intents(first.deployment, expected[1].cursor, 128)
            .await
            .unwrap(),
        [expected[2].clone(), expected[3].clone()]
    );
    assert_eq!(
        store
            .application_intents(other.deployment, consumer(42), expected[0].cursor, 128)
            .await
            .unwrap(),
        [expected[1].clone()]
    );
    store.close().await.unwrap();
    let reopened = RootStore::open(owner).await.unwrap();
    assert_eq!(
        reopened
            .application_deployment_intents(first.deployment, 0, 1)
            .await
            .unwrap(),
        [expected[0].clone()]
    );
    assert_eq!(
        reopened
            .application_deployment_intents(first.deployment, expected[0].cursor, 128)
            .await
            .unwrap(),
        [expected[2].clone(), expected[3].clone()]
    );
    assert_eq!(
        reopened
            .application_intents(first.deployment, consumer(43), 0, 128)
            .await
            .unwrap(),
        [expected[2].clone()]
    );
    assert_eq!(
        reopened
            .application_intent(other.deployment, consumer(42), reference(2).operation)
            .await
            .unwrap(),
        Some(expected[1].clone())
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn execution_caller_journal_refusal_preserves_original_data() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone()).await.unwrap();
    let caller = source(&store, Uuid::from_u128(201), 0).await;
    let snapshot = store
        .load_application_at(&caller)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    let index = partition_for(b"application", &caller.deployment.to_string());
    let old = store.partitions[index]
        .record_application_intent_from(
            &snapshot,
            consumer(42),
            reference(10),
            json!({"original":true}),
        )
        .await
        .unwrap()
        .intent()
        .clone();
    store.close().await.unwrap();
    let control_path = owner.canonical_path().join(root::ROOT_DATABASE);
    let paths: Vec<_> = std::iter::once(control_path)
        .chain((0..PARTITION_COUNT).map(|index| {
            owner
                .canonical_path()
                .join("runtime-partitions")
                .join(format!("{index:02}.sqlite"))
        }))
        .collect();
    let partition_bytes = std::fs::read(&paths[index + 1]).unwrap();
    #[cfg(unix)]
    let identities: Vec<_> = {
        use std::os::unix::fs::MetadataExt;
        paths
            .iter()
            .map(|path| std::fs::metadata(path).unwrap().ino())
            .collect()
    };
    let source_sql = "SELECT revision,input_json,remote_exports_json FROM application_sources WHERE deployment=?";
    let original_source: (i64, String, String) = {
        let control = rusqlite::Connection::open(&paths[0]).unwrap();
        let layout: (i64, i64) = control
            .query_row(
                "SELECT version,partitions FROM root_store_layout WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(layout, (1, 8));
        control
            .query_row(source_sql, [caller.deployment.to_string()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
    };
    assert!(matches!(
        RootStore::open(owner.clone()).await,
        Err(StoreError::UnsupportedDatabase)
    ));
    for path in &paths {
        assert!(path.is_file(), "{}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        for (path, identity) in paths.iter().zip(identities) {
            assert_eq!(
                std::fs::metadata(path).unwrap().ino(),
                identity,
                "{}",
                path.display()
            );
        }
    }
    assert_eq!(std::fs::read(&paths[index + 1]).unwrap(), partition_bytes);
    let control = rusqlite::Connection::open(&paths[0]).unwrap();
    let layout: (i64, i64) = control
        .query_row(
            "SELECT version,partitions FROM root_store_layout WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(layout, (1, 8));
    let retained_source: (i64, String, String) = control
        .query_row(source_sql, [caller.deployment.to_string()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(retained_source, original_source);
    let journal = rusqlite::Connection::open(&paths[index + 1]).unwrap();
    let retained: (i64, String, String) = journal
        .query_row(
            "SELECT cursor,reference_json,recovery_json FROM application_intents",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(retained.0, old.cursor as i64);
    assert_eq!(
        serde_json::from_str::<RecoveryRef>(&retained.1).unwrap(),
        old.reference
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&retained.2).unwrap(),
        old.recovery
    );
}

#[tokio::test]
async fn caller_control_commit_outlives_waiter_and_shutdown_drains_original_owners() {
    use futures_util::FutureExt;
    let directory = tempfile::tempdir().unwrap();
    let original = owner(directory.path());
    let weak = Arc::downgrade(&original);
    let store = Arc::new(RootStore::open(original).await.unwrap());
    let caller = source(&store, Uuid::from_u128(301), 0).await;
    let snapshot = store
        .load_application_at(&caller)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    let old_target = partition_for(b"application", &caller.deployment.to_string());
    let partition = store.partitions[old_target].clone();
    let (entered, started) = oneshot::channel();
    let (release_partition, released) = oneshot::channel();
    let blocked = tokio::spawn(async move {
        partition
            .connection
            .run(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    Ok(())
                })
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let accepted = tokio::time::timeout(
        Duration::from_secs(10),
        store.record_application_intent_from(
            &snapshot,
            consumer(42),
            reference(20),
            json!({"independent":true}),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .intent()
    .clone();
    tokio::time::timeout(Duration::from_secs(10), async {
        assert_eq!(
            store
                .application_intent(caller.deployment, consumer(42), reference(20).operation)
                .await
                .unwrap(),
            Some(accepted.clone())
        );
        assert_eq!(
            store
                .application_intents(caller.deployment, consumer(42), 0, 128)
                .await
                .unwrap()
                .as_slice(),
            std::slice::from_ref(&accepted)
        );
        assert_eq!(
            store
                .application_deployment_intents(caller.deployment, 0, 128)
                .await
                .unwrap(),
            [accepted]
        );
    })
    .await
    .unwrap();

    let (entered_commit, commit_started) = mpsc::channel();
    let (release_commit, commit_gate) = mpsc::channel();
    store
        .control
        .connection
        .run(move |connection| {
            Box::pin(async move {
                let mut entered = Some(entered_commit);
                connection.lock_handle().await?.set_commit_hook(move || {
                    if let Some(entered) = entered.take() {
                        entered.send(()).unwrap();
                        commit_gate.recv_timeout(Duration::from_secs(30)).unwrap();
                    }
                    true
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    let writing = store.clone();
    let waiter = tokio::spawn(async move {
        writing
            .record_application_intent_from(
                &snapshot,
                consumer(42),
                reference(21),
                json!({"cancelled":true}),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        while commit_started.try_recv().is_err() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        !waiter.is_finished(),
        "no receipt escapes before the actual commit"
    );
    waiter.abort();
    assert!(matches!(waiter.await, Err(error) if error.is_cancelled()));
    let receipt = store.lifecycle.as_ref().unwrap().receipt();
    store.request_shutdown();
    drop(store);
    release_partition.send(()).unwrap();
    blocked.await.unwrap().unwrap();
    assert!(
        receipt.clone().now_or_never().is_none(),
        "shutdown must await the accepted control commit after its waiter is gone"
    );
    assert!(
        weak.upgrade().is_some(),
        "the accepted SQL retains the original Root"
    );
    assert!(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path())
        )
        .is_err()
    );
    release_commit.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), receipt)
        .await
        .unwrap()
        .unwrap();
    assert!(weak.upgrade().is_none());
    let reopened_owner = Arc::new(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .unwrap(),
    );
    let reopened = RootStore::open(reopened_owner).await.unwrap();
    let committed = reopened
        .application_intent(caller.deployment, consumer(42), reference(21).operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(committed.caller, caller);
    assert_eq!(committed.reference, reference(21));
    assert_eq!(committed.recovery, json!({"cancelled":true}));
    reopened.close().await.unwrap();
}
