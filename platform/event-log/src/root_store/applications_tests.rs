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
    composition::{Configuration, Input, InstanceId, Node, PackageUse},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    deployment::DeploymentRef,
    operation::{RecoveryContract, RecoveryProtocol, RecoveryRef},
    package::{Declaration, EntryDeclaration, Implementation},
};
use serde_json::json;
use std::{collections::BTreeMap, path::Path};

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
                host: Some(EntryDeclaration { implementation: Implementation::Native { implementation: "test.caller".into() },
                        configuration: json!({"type":"object"}).into(),
                        imports: BTreeMap::new(),
                        exports: BTreeMap::new(),
                    }), ui: None,
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
                    use_package: PackageUse::Host,
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
                ui: None,
                instances,
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
