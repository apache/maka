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
use crate::applications::tests::store;
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Configuration, Input, Node, PackageUse},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::RecoveryProtocol,
    package::{Declaration, EntryDeclaration, Implementation},
};
use serde_json::json;
use std::collections::BTreeMap;

fn reference() -> RecoveryRef {
    RecoveryRef {
        source: DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(900),
            revision: 1,
        },
        namespace: InstanceId(vec![Uuid::from_u128(11)]),
        export: "Service".into(),
        method: "change".into(),
        operation: Uuid::new_v4(),
        fingerprint: format!("sha256-{}", "b".repeat(64)),
        contract: maka_plugin_core::operation::RecoveryContract::for_method(
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
async fn source(store: &EventLog, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"caller","application":Declaration {host: Some(EntryDeclaration { implementation:Implementation::Native {implementation:"test.caller".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::new()}), ui: None,composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                instances: BTreeMap::from([(
                    "caller".into(),
                    Node {
                        key: Uuid::from_u128(42),
                        package: package.application_ref().into(),
                        use_package: PackageUse::Host,
                        configuration: Configuration::default(),
                        parameters: Configuration::default(),
                        bindings: BTreeMap::new(),
                        disabled: false,
                        overrides: vec![],
                    },
                )]),
            },
            vec![],
            vec![package],
        )
        .await
        .unwrap()
}
fn consumer() -> InstanceId {
    InstanceId(vec![Uuid::from_u128(42)])
}
#[tokio::test]
async fn caller_history_keeps_first_source_and_original_owner_across_revisions_and_conflicts() {
    let (_dir, store) = store().await;
    let deployment = Uuid::new_v4();
    let first = source(&store, deployment, 0).await;
    let original = reference();
    let recovery =
        json!({"format":"draft@1","owner":"native-editor","revision":4,"attachments":["file"]});
    let (a, b) = tokio::join!(
        store.record_application_intent(
            first.clone(),
            consumer(),
            original.clone(),
            recovery.clone()
        ),
        store.record_application_intent(
            first.clone(),
            consumer(),
            original.clone(),
            recovery.clone()
        )
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.intent(), b.intent());
    assert_eq!(a.intent().reference, original);
    assert_eq!(a.intent().recovery, recovery);
    let confirmation = a.intent().confirmation();
    confirmation.validate().unwrap();
    assert_eq!(confirmation.reference, original);
    assert!(
        serde_json::to_value(&confirmation)
            .unwrap()
            .get("recovery")
            .is_none()
    );
    assert!(
        serde_json::from_value::<CallerConfirmation>(serde_json::to_value(a.intent()).unwrap())
            .is_err(),
        "local history metadata is not part of a peer attestation"
    );
    assert!(
        store.operation_observation(&original).await.is_err(),
        "caller Root is not the original business journal"
    );
    let second = source(&store, deployment, 1).await;
    let again = store
        .record_application_intent(second, consumer(), original.clone(), recovery.clone())
        .await
        .unwrap();
    assert_eq!(again.intent().caller, first);
    assert_eq!(
        store
            .application_intent(deployment, consumer(), original.operation)
            .await
            .unwrap(),
        Some(a.intent().clone()),
        "exact read keeps the first caller source after updates"
    );
    assert!(
        store
            .application_intent(Uuid::new_v4(), consumer(), original.operation)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .application_intent(
                deployment,
                InstanceId(vec![Uuid::new_v4()]),
                original.operation
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .application_intent(deployment, consumer(), Uuid::new_v4())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .application_intent(deployment, consumer(), Uuid::nil())
            .await
            .is_err()
    );
    assert!(
        matches!(
            store
                .record_application_intent(
                    first.clone(),
                    consumer(),
                    original.clone(),
                    json!({"revision":5})
                )
                .await,
            Err(StoreError::EventConflict)
        ),
        "the original correlation cannot be replaced or silently ignored"
    );
    let mut rebound = original.clone();
    rebound.source.state_domain = "c".repeat(64);
    assert!(matches!(
        store
            .record_application_intent(first.clone(), consumer(), rebound, recovery.clone())
            .await,
        Err(StoreError::EventConflict)
    ));
    let other = reference();
    let other = store
        .record_application_intent(first.clone(), consumer(), other, recovery.clone())
        .await
        .unwrap();
    let page = store
        .application_intents(deployment, consumer(), 0, 1)
        .await
        .unwrap();
    assert_eq!(page, [a.intent().clone()]);
    let next = store
        .application_intents(deployment, consumer(), page[0].cursor, 128)
        .await
        .unwrap();
    assert_eq!(next, [other.intent().clone()]);
    assert!(
        store
            .application_intents(deployment, consumer(), other.intent().cursor, 128)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .application_intents(deployment, consumer(), 0, 129)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn caller_requires_owned_exact_source_and_actual_executable_namespace() {
    let (_dir, store) = store().await;
    let first = source(&store, Uuid::new_v4(), 0).await;
    let mut foreign = first.clone();
    foreign.state_domain = "e".repeat(64);
    assert!(
        store
            .record_application_intent(foreign, consumer(), reference(), serde_json::Value::Null)
            .await
            .is_err()
    );
    let mut missing = first.clone();
    missing.revision = 2;
    assert!(
        store
            .record_application_intent(missing, consumer(), reference(), serde_json::Value::Null)
            .await
            .is_err()
    );
    assert!(
        store
            .record_application_intent(
                first.clone(),
                InstanceId(vec![Uuid::from_u128(43)]),
                reference(),
                serde_json::Value::Null
            )
            .await
            .is_err()
    );
    assert!(
        store
            .record_application_intent(
                first,
                InstanceId(vec![]),
                reference(),
                serde_json::Value::Null
            )
            .await
            .is_err()
    );
    assert!(
        store
            .application_intents(Uuid::new_v4(), consumer(), 0, 128)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn corrupted_history_is_never_overwritten_as_a_fresh_intent() {
    let (_dir, store) = store().await;
    let deployment = Uuid::new_v4();
    let caller = source(&store, deployment, 0).await;
    let original = reference();
    let token = store
        .record_application_intent(
            caller.clone(),
            consumer(),
            original.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let cursor = token.intent().cursor;
    drop(token);
    let operation = original.operation.to_string();
    store
        .connection
        .run(move |connection| {
            Box::pin(async move {
                sqlx::query("UPDATE application_intents SET operation=? WHERE cursor=?")
                    .bind(format!("{operation}\0extra"))
                    .bind(cursor as i64)
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        store
            .application_intents(deployment, consumer(), 0, 128)
            .await
            .is_err()
    );
    let operation = original.operation.to_string();
    store
        .connection
        .run(move |connection| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE application_intents SET operation=?, reference_json=? WHERE cursor=?",
                )
                .bind(operation)
                .bind("{}")
                .bind(cursor as i64)
                .execute(&mut *connection)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        store
            .application_intents(deployment, consumer(), 0, 128)
            .await
            .is_err()
    );
    assert!(
        store
            .record_application_intent(caller, consumer(), original, serde_json::Value::Null)
            .await
            .is_err()
    );
    let rows: i64 = store
        .connection
        .run(|connection| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT COUNT(*) FROM application_intents")
                        .fetch_one(connection)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[tokio::test]
async fn caller_commit_error_produces_no_dispatch_token() {
    let (_dir, store) = store().await;
    let deployment = Uuid::new_v4();
    let caller = source(&store, deployment, 0).await;
    store.connection.run(|connection| Box::pin(async move {
        sqlx::raw_sql("CREATE TABLE caller_commit_probe (deployment TEXT, revision INTEGER, FOREIGN KEY(deployment,revision) REFERENCES application_sources(deployment,revision) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_caller_commit AFTER INSERT ON application_intents BEGIN INSERT INTO caller_commit_probe VALUES ('missing',1); END;")
            .execute(connection).await?;
        Ok(())
    })).await.unwrap();
    assert!(matches!(
        store
            .record_application_intent(caller, consumer(), reference(), serde_json::Value::Null)
            .await,
        Err(StoreError::CommitUnknown(_))
    ));
    assert!(
        store
            .application_intents(deployment, consumer(), 0, 128)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn history_pages_bound_the_complete_encoded_array_without_skipping_the_next_cursor() {
    let (_dir, store) = store().await;
    let deployment = Uuid::new_v4();
    let caller = source(&store, deployment, 0).await;
    let mut expected = Vec::new();
    for _ in 0..70 {
        let original = reference();
        let token = store
            .record_application_intent(
                caller.clone(),
                consumer(),
                original,
                json!({"metadata":"x".repeat(30_000)}),
            )
            .await
            .unwrap();
        expected.push(token.intent().clone());
    }
    assert!(serde_json::to_vec(&expected[..35]).unwrap().len() > MAX_PAGE);
    let mut all = Vec::new();
    let mut after = 0;
    let mut lengths = Vec::new();
    loop {
        let page = store
            .application_intents(deployment, consumer(), after, 128)
            .await
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_PAGE);
        if page.is_empty() {
            break;
        }
        assert!(page[0].cursor > after);
        after = page.last().unwrap().cursor;
        lengths.push(page.len());
        all.extend(page);
    }
    assert_eq!(lengths.len(), 3);
    assert!(lengths.iter().all(|length| *length < 35));
    assert_eq!(all, expected);
}

#[tokio::test]
async fn complete_recovery_metadata_retries_immutably_and_oversized_singletons_advance() {
    let (_dir, store) = store().await;
    let deployment = Uuid::new_v4();
    let caller = source(&store, deployment, 0).await;
    let recovery = json!({"original":"original recovery 中\n".repeat(MAX_PAGE / 10)});
    let original = reference();
    let token = store
        .record_application_intent(
            caller.clone(),
            consumer(),
            original.clone(),
            recovery.clone(),
        )
        .await
        .unwrap();
    let expected = token.intent().clone();
    assert_eq!(expected.recovery, recovery);
    let retry = store
        .record_application_intent(
            caller.clone(),
            consumer(),
            original.clone(),
            recovery.clone(),
        )
        .await
        .unwrap();
    assert_eq!(retry.intent(), &expected);
    assert!(matches!(
        store
            .record_application_intent(
                caller.clone(),
                consumer(),
                original,
                json!({"replacement":true})
            )
            .await,
        Err(StoreError::EventConflict)
    ));
    let second = store
        .record_application_intent(
            caller,
            consumer(),
            reference(),
            json!({"second":"original"}),
        )
        .await
        .unwrap()
        .intent()
        .clone();
    let first_page = store
        .application_intents(deployment, consumer(), 0, 128)
        .await
        .unwrap();
    assert_eq!(first_page, vec![expected.clone()]);
    let second_page = store
        .application_intents(deployment, consumer(), expected.cursor, 128)
        .await
        .unwrap();
    assert_eq!(second_page, vec![second.clone()]);
    assert!(
        store
            .application_intents(deployment, consumer(), second.cursor, 128)
            .await
            .unwrap()
            .is_empty()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn original_source_snapshot_keeps_its_checked_instances_without_reloading_package_bytes() {
    let (_dir, store) = store().await;
    let store = Arc::new(store);
    let deployment = Uuid::new_v4();
    let first = source(&store, deployment, 0).await;
    let loaded = store.load_application_at(&first).await.unwrap().unwrap();
    loaded.check_store(&store).unwrap();
    assert!(loaded.plan().instances().contains_key(&consumer()));
    let snapshot = loaded.snapshot();
    // Consuming a checked snapshot permits editing source, never its old plan or proof.
    let (mut edited, _, plan, original) = loaded.into_parts();
    edited.reference.deployment = Uuid::new_v4();
    edited.input.instances.get_mut("caller").unwrap().key = Uuid::from_u128(43);
    assert_eq!(original.reference(), &first);
    assert!(plan.instances().contains_key(&consumer()));
    assert!(
        !plan
            .instances()
            .contains_key(&InstanceId(vec![Uuid::from_u128(43)]))
    );
    assert!(
        store
            .record_application_intent_from(
                &snapshot,
                InstanceId(vec![Uuid::from_u128(43)]),
                reference(),
                json!(null)
            )
            .await
            .is_err()
    );
    let mut current = store.load_application_at(&first).await.unwrap().unwrap();
    current
        .source
        .input
        .instances
        .get_mut("caller")
        .unwrap()
        .disabled = true;
    let structure = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion": 1, "id": "structure", "application": {"composition": {"children": {}}}
        }))
        .unwrap(),
    )]))
    .unwrap();
    let mut node = current.source.input.instances["caller"].clone();
    node.key = Uuid::from_u128(99);
    node.disabled = false;
    node.package = structure.application_ref().into();
    node.use_package = PackageUse::Composition;
    current
        .source
        .input
        .instances
        .insert("structure".into(), node);
    current.packages.push(structure);
    let second = store
        .commit_application(
            deployment,
            1,
            current.source.input,
            vec![],
            current.packages,
        )
        .await
        .unwrap();
    let disabled = store
        .load_application_at(&second)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    assert!(
        store
            .record_application_intent_from(&disabled, consumer(), reference(), json!(null))
            .await
            .is_err()
    );
    assert!(
        store
            .record_application_intent_from(
                &disabled,
                InstanceId(vec![Uuid::from_u128(99)]),
                reference(),
                json!(null)
            )
            .await
            .is_err(),
        "structural instances cannot be callers"
    );
    let (_other_dir, other) = crate::applications::tests::store().await;
    assert!(
        other
            .record_application_intent_from(&snapshot, consumer(), reference(), json!(null))
            .await
            .is_err()
    );
    // An already-running original executor retains the immutable bytes it
    // validated. A new activation still refuses corrupted stored packages.
    store
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE application_package_files SET payload = X'00'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(store.load_application_at(&first).await.is_err());
    let original = reference();
    let recorded = store
        .record_application_intent_from(&snapshot, consumer(), original.clone(), json!({"draft":1}))
        .await
        .unwrap();
    assert_eq!(recorded.intent().caller, first);
    assert_eq!(recorded.intent().reference, original);
    assert!(matches!(
        store
            .record_application_intent_from(&snapshot, consumer(), original, json!({"draft":2}))
            .await,
        Err(StoreError::EventConflict)
    ));
}

#[tokio::test]
async fn source_snapshot_does_not_retain_or_authenticate_a_reopened_root_lease() {
    use crate::root::{RootNamespaces, RootOwner};
    let (dir, store) = store().await;
    let first = source(&store, Uuid::new_v4(), 0).await;
    let snapshot = store
        .load_application_at(&first)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    store.shutdown().await.unwrap();
    drop(store);
    let root = Arc::new(
        RootOwner::open(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let reopened = EventLog::for_root(root).await.unwrap();
    assert!(
        reopened
            .record_application_intent_from(&snapshot, consumer(), reference(), json!(null))
            .await
            .is_err()
    );
    let fresh = reopened
        .load_application_at(&first)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    reopened
        .record_application_intent_from(&fresh, consumer(), reference(), json!(null))
        .await
        .unwrap();
    reopened.shutdown().await.unwrap();
}
