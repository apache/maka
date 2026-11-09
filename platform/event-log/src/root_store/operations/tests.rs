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
use crate::applications::operations::OperationRequest;
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{Configuration, Input, InstanceId, Node, PackageUse},
    contract::{Availability, Contract, Export, Interface, Method, MethodMode, Transport},
    package::{Declaration, EntryDeclaration, Implementation},
};
use serde_json::json;
use std::{collections::BTreeMap, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn open() -> (tempfile::TempDir, RootStore) {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = root::RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let owner = Arc::new(root::RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
    let store = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    (dir, store)
}

async fn request(store: &EventLog) -> OperationRequest {
    let contract = Contract {
        name: "changes".into(),
        version: 1,
        transport: Transport::Local,
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
    };
    let package = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "operation-work-provider",
            "application": Declaration {
                host: Some(EntryDeclaration {
                    implementation: Implementation::Native { implementation: "test.operation-work".into() },
                    configuration: json!({"type":"object"}).into(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::from([("service".into(), Export {
                        contract: contract.clone(),
                        availability: Availability::Required,
                    })]),
                }),
                ui: None,
                composition: None,
            }
        })).unwrap(),
    )])).unwrap();
    let selected = Input {
        base: None,
        ui: None,
        instances: BTreeMap::from([(
            "provider".into(),
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
    };
    OperationRequest {
        source: store
            .commit_application(Uuid::new_v4(), 0, selected, vec![], vec![package])
            .await
            .unwrap(),
        namespace: InstanceId(vec![Uuid::from_u128(42)]),
        consumer: InstanceId(vec![Uuid::from_u128(42)]),
        export: "service".into(),
        method: "change".into(),
        operation: Uuid::new_v4(),
        contract,
        input: json!({"outer":{"z":1,"a":2},"text":"original"}),
        capture: None,
        origin: json!({"requestId":Uuid::new_v4()}),
    }
}

#[tokio::test]
async fn cross_session_operation_work_retains_original_session_and_dispatch_scope() {
    let (_dir, root) = open().await;
    let session = root
        .create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    root.create_session("foreign", "foreign", &json!({}), 1)
        .await
        .unwrap();
    let original = request(&root.log).await;
    let reference = original.reference().unwrap();
    let store = root.operation(&reference).unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(original).await.unwrap() else {
        panic!("new")
    };
    store.start_operation(&claim).unwrap();
    let scope = claim.auxiliary_scope();
    let (lease, _effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let custody = lease.store().work_custody().unwrap();
    let drained = root
        .observe_work_settlement(custody.as_ref(), "session")
        .unwrap();
    assert_eq!(
        root.session_for_work(custody.as_ref(), "session")
            .unwrap()
            .id(),
        "session"
    );
    assert!(matches!(
        root.session_for_work(custody.as_ref(), "foreign"),
        Err(StoreError::InvalidTransition(reason)) if reason == "foreign Session handle"
    ));
    let other_request = request(&root.log).await;
    let other_store = root.operation(&other_request.reference().unwrap()).unwrap();
    let Dispatch::New(other_claim) = other_store.dispatch_operation(other_request).await.unwrap()
    else {
        panic!("other actual scope")
    };
    let other_scope = other_claim.auxiliary_scope();
    assert!(matches!(
        store
            .acquire_work(
                &other_scope,
                root.fork_work(custody.as_ref(), "session").unwrap()
            )
            .await,
        Err(StoreError::EventConflict)
    ));
    other_store
        .prevent_operation_before_start(&other_claim)
        .await
        .unwrap();
    other_store
        .record_operation_cleanup(&other_claim, OperationCleanup::Confirmed)
        .await
        .unwrap();

    let (_other_dir, other_root) = open().await;
    let foreign_session = other_root
        .create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let (foreign_lease, _foreign_effects) = foreign_session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let foreign_custody = foreign_lease.store().work_custody().unwrap();
    let foreign_drained = other_root
        .observe_work_settlement(foreign_custody.as_ref(), "session")
        .unwrap();
    assert!(matches!(
        store.acquire_work(&scope, foreign_lease).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "foreign Session work"
    ));
    tokio::time::timeout(Duration::from_secs(10), foreign_drained.wait())
        .await
        .unwrap()
        .unwrap();
    other_root.close().await.unwrap();

    let work = store.acquire_work(&scope, lease).await.unwrap();
    assert!(
        root.gates
            .try_write([gates::Key::Work("session".into())])
            .unwrap()
            .is_none()
    );
    let returned = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"original":"handler returned"}),
        },
    };
    let known = store
        .record_operation_outcome(&claim, returned.clone())
        .await
        .unwrap();
    assert_eq!(known.outcome, returned);
    assert_eq!(known.cleanup, OperationCleanup::Unconfirmed);
    assert!(matches!(
        store.record_operation_cleanup(&claim, OperationCleanup::Confirmed).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "original operation work has not drained"
    ));
    assert!(
        root.gates
            .try_write([gates::Key::Work("session".into())])
            .unwrap()
            .is_none()
    );
    let selected = root.session_for_work(custody.as_ref(), "session").unwrap();
    let actor_log = selected.scoped().await.unwrap();
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let actor = tokio::spawn(async move {
        actor_log
            .connection
            .run(move |db| {
                let exists: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_control WHERE id='session')",
                    [],
                    |row| row.get(0),
                )?;
                assert!(exists);
                entered.send(()).unwrap();
                released.blocking_recv().unwrap();
                Ok(())
            })
            .await
    });
    reached.await.unwrap();
    work.finish_after_cleanup();
    assert!(
        futures_util::poll!(std::pin::pin!(drained.wait())).is_pending(),
        "original SQL actor still owns its accepted Session guards"
    );
    assert!(
        root.gates
            .try_write([gates::Key::Work("session".into())])
            .unwrap()
            .is_none()
    );
    release.send(()).unwrap();
    actor.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(10), drained.wait())
        .await
        .unwrap()
        .unwrap();
    let exclusive = tokio::time::timeout(
        Duration::from_secs(10),
        root.gates.write([gates::Key::Work("session".into())]),
    )
    .await
    .unwrap()
    .unwrap();
    drop(exclusive);
    let completed = store
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(completed.outcome, returned);
    assert_eq!(completed.cleanup, OperationCleanup::Confirmed);
    let (late, _late_effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    assert!(matches!(
        store.acquire_work(&scope, late).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "original operation dispatch is not running"
    ));
    assert_eq!(
        store.operation_observation().await.unwrap(),
        Some(completed)
    );
    drop((scope, claim, other_scope, other_claim));
    root.close().await.unwrap();
}

#[tokio::test]
async fn failed_cleanup_receipt_never_releases_root_authority() {
    let (dir, root) = open().await;
    let original = request(&root.log).await;
    let store = root.operation(&original.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(original).await.unwrap() else {
        panic!("new")
    };
    store.start_operation(&claim).unwrap();
    let unknown = OperationOutcome::Unknown {
        diagnostic: "actual resource remains open".into(),
    };
    store
        .record_operation_outcome(&claim, unknown.clone())
        .await
        .unwrap();
    let failed = store
        .record_operation_cleanup(
            &claim,
            OperationCleanup::Failed {
                diagnostic: "actual resource remains open".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(failed.outcome, unknown);
    assert!(matches!(failed.cleanup, OperationCleanup::Failed { .. }));
    assert!(
        root.create_session("healthy", "healthy", &json!({}), 1)
            .await
            .is_ok()
    );
    // Losing the original unconfirmed owner is not a physical cleanup ACK.
    drop(claim);
    assert!(matches!(
        root.close().await,
        Err(StoreError::CloseFailed(_))
    ));
    let namespaces = root::RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    assert!(root::RootOwner::open(&dir.path().join("root"), &namespaces).is_err());
}

#[tokio::test]
async fn receipt_write_failure_preserves_confirmed_cleanup_and_pending_recovery() {
    for commit_failure in [false, true] {
        let (dir, root) = open().await;
        let original = request(&root.log).await;
        let reference = original.reference().unwrap();
        let store = root.operation(&reference).unwrap();
        let Dispatch::New(claim) = store.dispatch_operation(original.clone()).await.unwrap() else {
            panic!("new")
        };
        store.start_operation(&claim).unwrap();
        let scope = claim.auxiliary_scope();
        store.owner().unwrap().connection.run(move |connection| {
            if commit_failure {
                connection.execute_batch("CREATE TABLE settlement_parent(id INTEGER PRIMARY KEY); CREATE TABLE settlement_probe(id INTEGER REFERENCES settlement_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER reject_settlement_commit AFTER UPDATE OF outcome_json, cleanup_json ON application_operations BEGIN INSERT INTO settlement_probe VALUES(1); END;")?;
            } else {
                connection.execute_batch("CREATE TEMP TRIGGER reject_settlement BEFORE UPDATE OF outcome_json, cleanup_json ON application_operations BEGIN SELECT RAISE(ABORT,'known settlement rollback'); END;")?;
            }
            Ok(())
        }).await.unwrap();
        let result = OperationResult::Success {
            value: json!({"original":"actual returned value"}),
        };
        let failure = store
            .record_operation_outcome(
                &claim,
                OperationOutcome::Returned {
                    result: result.clone(),
                },
            )
            .await
            .unwrap_err();
        if commit_failure {
            assert!(matches!(failure.underlying(), StoreError::CommitUnknown(_)));
        } else {
            let StoreError::Sqlite(cause) = failure.underlying() else {
                panic!("{failure:?}")
            };
            assert_eq!(
                cause.sqlite_error().unwrap().extended_code,
                rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
            );
            assert!(cause.to_string().contains("known settlement rollback"));
        }
        store
            .owner()
            .unwrap()
            .connection
            .run(move |connection| {
                assert!(connection.is_autocommit());
                if commit_failure {
                    let rows: i64 = connection.query_row(
                        "SELECT count(*) FROM settlement_probe",
                        [],
                        |row| row.get(0),
                    )?;
                    assert_eq!(rows, 0);
                }
                Ok(())
            })
            .await
            .unwrap();
        let before_ack = store.operation_observation().await.unwrap().unwrap();
        assert_eq!(before_ack.outcome, OperationOutcome::Unresolved);
        assert_eq!(before_ack.cleanup, OperationCleanup::Unconfirmed);
        // The original provider has actually drained. Failure to persist that
        // ACK must not invent a durable ACK or retain already-finished custody.
        let cleanup_failure = store
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap_err();
        if commit_failure {
            assert!(matches!(
                cleanup_failure.underlying(),
                StoreError::CommitUnknown(_)
            ));
        } else {
            let StoreError::Sqlite(cause) = cleanup_failure.underlying() else {
                panic!("{cleanup_failure:?}")
            };
            assert_eq!(
                cause.sqlite_error().unwrap().extended_code,
                rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
            );
            assert!(cause.to_string().contains("known settlement rollback"));
        }
        let cleaned = store.operation_observation().await.unwrap().unwrap();
        assert_eq!(cleaned, before_ack);
        store
            .owner()
            .unwrap()
            .connection
            .run(move |connection| {
                assert!(connection.is_autocommit());
                if commit_failure {
                    assert_eq!(
                        connection.query_row(
                            "SELECT count(*) FROM settlement_probe",
                            [],
                            |row| row.get::<_, i64>(0)
                        )?,
                        0
                    );
                }
                Ok(())
            })
            .await
            .unwrap();
        let Dispatch::Existing(duplicate) =
            store.dispatch_operation(original.clone()).await.unwrap()
        else {
            panic!("receipt loss is not permission to retry")
        };
        assert_eq!(duplicate, cleaned);
        assert!(scope.acquire(&store.owner().unwrap(), &reference).is_err());
        root.close().await.unwrap();
        let namespaces = root::RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let reopened = RootStore::open(
            Arc::new(root::RootOwner::open(&dir.path().join("root"), &namespaces).unwrap()),
            crate::ROOT_MIGRATIONS,
        )
        .await
        .unwrap();
        let recovered = reopened.operation(&reference).unwrap();
        assert_eq!(
            recovered.operation_observation().await.unwrap(),
            Some(cleaned.clone())
        );
        assert!(
            recovered
                .record_operation_outcome(
                    &claim,
                    OperationOutcome::Returned {
                        result: result.clone()
                    }
                )
                .await
                .is_err(),
            "an inert claim from a closed Root cannot be revived on a new owner"
        );
        let journal = reopened
            .provider_journal(original.source, original.namespace)
            .await
            .unwrap();
        let provider = journal.operation(&reference).await.unwrap();
        let acknowledged = provider
            .record_cleanup(OperationCleanup::Confirmed)
            .await
            .unwrap();
        assert_eq!(acknowledged.outcome, OperationOutcome::Unresolved);
        assert_eq!(acknowledged.cleanup, OperationCleanup::Confirmed);
        let known = provider.record_returned(result.clone()).await.unwrap();
        assert_eq!(known.outcome, OperationOutcome::Returned { result });
        assert_eq!(known.cleanup, OperationCleanup::Confirmed);
        reopened.close().await.unwrap();
        drop((scope, claim));
    }
}

#[tokio::test]
async fn cancelled_receipt_observer_keeps_sql_custody_without_inventing_provider_failure() {
    let (dir, root) = open().await;
    let original = request(&root.log).await;
    let reference = original.reference().unwrap();
    let store = root.operation(&reference).unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(original).await.unwrap() else {
        panic!("new")
    };
    store.start_operation(&claim).unwrap();
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let owner = store.owner().unwrap();
    let blocked = tokio::spawn(async move {
        owner
            .connection
            .run(move |_| {
                entered.send(()).unwrap();
                released.blocking_recv().unwrap();
                Ok(())
            })
            .await
    });
    reached.await.unwrap();
    let outcome = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"original":"provider cause 中\n", "changed":true}),
        },
    };
    let mut result_receipt = Box::pin(store.record_operation_outcome(&claim, outcome.clone()));
    let mut cleanup_receipt =
        Box::pin(store.record_operation_cleanup(&claim, OperationCleanup::Confirmed));
    assert!(futures_util::poll!(&mut result_receipt).is_pending());
    assert!(futures_util::poll!(&mut cleanup_receipt).is_pending());
    drop((result_receipt, cleanup_receipt));
    drop(claim);
    let before = store.operation_observation().await.unwrap().unwrap();
    assert_eq!(before.outcome, OperationOutcome::Unresolved);
    assert_eq!(before.cleanup, OperationCleanup::Unconfirmed);
    let namespaces = root::RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let mut closing = Box::pin(root.shutdown());
    assert!(
        futures_util::poll!(&mut closing).is_pending(),
        "original SQL actor is still busy"
    );
    assert!(root::RootOwner::open(&dir.path().join("root"), &namespaces).is_err());
    release.send(()).unwrap();
    blocked.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(10), closing)
        .await
        .unwrap()
        .unwrap();
    root.close().await.unwrap();
    let reopened = RootStore::open(
        Arc::new(root::RootOwner::open(&dir.path().join("root"), &namespaces).unwrap()),
        crate::ROOT_MIGRATIONS,
    )
    .await
    .unwrap();
    let recovered = reopened
        .operation(&reference)
        .unwrap()
        .operation_observation()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.reference, reference);
    assert_eq!(
        recovered.outcome, outcome,
        "losing observers must not substitute a provider failure or Unknown"
    );
    assert_eq!(recovered.cleanup, OperationCleanup::Confirmed);
    reopened.close().await.unwrap();
}
