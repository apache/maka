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
use maka_capabilities::call::Identity;
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface, Method, MethodMode, Transport},
};
use std::collections::BTreeMap;
use uuid::Uuid;
async fn open() -> (tempfile::TempDir, RootStore) {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = root::RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let owner = Arc::new(root::RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
    let store = RootStore::open(owner).await.unwrap();
    (dir, store)
}
async fn request(store: &EventLog) -> OperationRequest {
    OperationRequest {
        source: store
            .commit_application(
                Uuid::new_v4(),
                0,
                maka_plugin_core::composition::Input {
                    base: None,
                    ui: None,
                    instances: BTreeMap::new(),
                },
                vec![],
                vec![],
            )
            .await
            .unwrap(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer: InstanceId(vec![Uuid::new_v4()]),
        export: "service".into(),
        method: "change".into(),
        operation: Uuid::new_v4(),
        contract: Contract {
            name: "changes".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "change".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: serde_json::json!({}).into(),
                        output: serde_json::json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        input: serde_json::json!({"outer":{"z":1,"a":2},"text":"original"}),
        capture: None,
        origin: Identity::Remote {
            request_id: Uuid::new_v4(),
        },
    }
}

#[tokio::test]
async fn cross_session_auxiliary_retains_session_and_source_atomicity() {
    let (_dir, root) = open().await;
    let session = root
        .create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let request = request(&root.log).await;
    let store = root.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(request).await.unwrap() else {
        panic!("new");
    };
    let scope = claim.auxiliary_scope();
    let lease = session.execution_scope(None).await.unwrap().accept();
    let auxiliary = store
        .begin_auxiliary_operation_model(
            &scope,
            lease,
            maka_agent_facts::execution::ModelBinding {
                connection_id: "connection".into(),
                connection_slug: "named".into(),
                model: "chosen".into(),
            },
            maka_agent_facts::language::Language::En,
            None,
        )
        .await
        .unwrap();
    let count: i64 = store
        .owner()
        .unwrap()
        .connection
        .read(|conn| {
            {
                Ok(conn.query_row(
                    "SELECT count(*) FROM event_log WHERE kind='auxiliary_model_started'",
                    rusqlite::params![],
                    |row| row.get(0),
                )?)
            }
        })
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert!(
        root.gates
            .try_write([gates::Key::Work("session".into())])
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .finish_operation(
                &claim,
                OperationOutcome::Returned {
                    value: serde_json::json!(true)
                },
                OperationCleanup::Confirmed
            )
            .await
            .is_err()
    );
    let foreign = store
        .owner()
        .unwrap()
        .scoped(Arc::new(()))
        .bind_session("foreign".into());
    assert!(
        foreign
            .observe_auxiliary_model(auxiliary.id(), Default::default())
            .await
            .is_err()
    );
    assert!(
        foreign
            .settle_auxiliary_model(auxiliary.id(), crate::usage::Outcome::Success)
            .await
            .is_err()
    );
    auxiliary
        .observe(maka_agent_facts::model::ModelUsage {
            input_tokens: Some(77),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut changes = session.subscribe_commits().unwrap();
    changes.borrow_and_update();
    auxiliary
        .settle(crate::usage::Outcome::Success)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let meter = root.session_usage_totals("session").await.unwrap();
    assert_eq!(meter.input.known, 77);
    assert_eq!(meter.input.missing, 0);
    assert_eq!(meter.output.missing, 1);
    let duplicate_lease = session.execution_scope(None).await.unwrap().accept();
    assert!(
        store
            .begin_auxiliary_operation_model(
                &scope,
                duplicate_lease,
                maka_agent_facts::execution::ModelBinding {
                    connection_id: "connection".into(),
                    connection_slug: "named".into(),
                    model: "chosen".into()
                },
                maka_agent_facts::language::Language::En,
                None
            )
            .await
            .is_err()
    );
    // SQL replies precede the actor releasing its retained physical custody.
    // The Session becomes retireable only after that original actor drains.
    let drained = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        root.gates.write([gates::Key::Work("session".into())]),
    )
    .await
    .unwrap()
    .unwrap();
    drop(drained);
    store
        .finish_operation(
            &claim,
            OperationOutcome::Returned {
                value: serde_json::json!(true),
            },
            OperationCleanup::Confirmed,
        )
        .await
        .unwrap();
    drop(scope);
    drop(claim);
    root.close().await.unwrap();
}

#[tokio::test]
async fn failed_cleanup_receipt_never_releases_root_authority() {
    let (dir, root) = open().await;
    let request = request(&root.log).await;
    let store = root.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(request).await.unwrap() else {
        panic!("new");
    };
    store
        .finish_operation(
            &claim,
            OperationOutcome::Unknown {
                diagnostic: "actual resource remains open".into(),
            },
            OperationCleanup::Failed {
                diagnostic: "actual resource remains open".into(),
            },
        )
        .await
        .unwrap();
    let receipt = store.operation_observation().await.unwrap().unwrap();
    assert!(matches!(receipt.outcome, OperationOutcome::Unknown { .. }));
    assert!(matches!(receipt.cleanup, OperationCleanup::Failed { .. }));
    assert!(
        root.create_session("healthy", "healthy", &serde_json::json!({}), 1)
            .await
            .is_ok()
    );
    drop(claim);
    assert!(root.close().await.is_err());
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
        let request = request(&root.log).await;
        let reference = request.reference().unwrap();
        let store = root.operation(&reference).unwrap();
        let Dispatch::New(claim) = store.dispatch_operation(request.clone()).await.unwrap() else {
            panic!("new");
        };
        let scope = claim.auxiliary_scope();
        store.owner().unwrap().connection.run(move |connection| {
            if commit_failure {
                connection.execute_batch("CREATE TABLE settlement_parent(id INTEGER PRIMARY KEY); CREATE TABLE settlement_probe(id INTEGER REFERENCES settlement_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER reject_settlement_commit AFTER UPDATE OF outcome_json ON application_operations BEGIN INSERT INTO settlement_probe VALUES(1); END;")?;
            } else {
                connection.execute_batch("CREATE TEMP TRIGGER reject_settlement BEFORE UPDATE OF outcome_json ON application_operations BEGIN SELECT RAISE(ABORT,'known settlement rollback'); END;")?;
            }
            Ok(())
        }).await.unwrap();
        let failure = store
            .finish_operation(
                &claim,
                OperationOutcome::Returned {
                    value: serde_json::json!(true),
                },
                OperationCleanup::Confirmed,
            )
            .await
            .unwrap_err();
        if commit_failure {
            assert!(matches!(failure.underlying(), StoreError::CommitUnknown(_)));
        } else {
            assert!(matches!(failure.underlying(), StoreError::Sqlite(_)));
        }
        // The same SQL owner acknowledged rollback; provider cleanup knowledge
        // does not depend on whether the original receipt committed.
        store
            .owner()
            .unwrap()
            .connection
            .run(move |connection| {
                assert!(connection.is_autocommit());
                if commit_failure {
                    let rows: i64 = connection.query_row(
                        "SELECT count(*) FROM settlement_probe",
                        rusqlite::params![],
                        |row| row.get(0),
                    )?;
                    assert_eq!(rows, 0);
                }
                Ok(())
            })
            .await
            .unwrap();
        let observed = root
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed.outcome, OperationOutcome::Unresolved);
        assert_eq!(observed.cleanup, OperationCleanup::Unconfirmed);
        assert!(matches!(
            store.dispatch_operation(request).await.unwrap(),
            Dispatch::Existing(_)
        ));
        assert!(scope.acquire(&store.owner().unwrap(), &reference).is_err());
        // Keeping the inert original claim/scope cannot retain a finished Root.
        root.close().await.unwrap();
        let namespaces = root::RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let reopened = RootStore::open(Arc::new(
            root::RootOwner::open(&dir.path().join("root"), &namespaces).unwrap(),
        ))
        .await
        .unwrap();
        let recovered = reopened
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.outcome, OperationOutcome::Unresolved);
        reopened.close().await.unwrap();
        drop(scope);
        drop(claim);
    }
}

#[tokio::test]
async fn cancelled_receipt_observer_keeps_sql_custody_without_inventing_provider_failure() {
    let (dir, root) = open().await;
    let request = request(&root.log).await;
    let reference = request.reference().unwrap();
    let store = root.operation(&reference).unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(request).await.unwrap() else {
        panic!("new");
    };
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
    let mut finishing = Box::pin(store.finish_operation(
        &claim,
        OperationOutcome::Returned {
            value: serde_json::json!(true),
        },
        OperationCleanup::Confirmed,
    ));
    assert!(futures_util::poll!(&mut finishing).is_pending());
    drop(finishing);
    drop(claim);
    let mut closing = Box::pin(root.shutdown());
    assert!(
        futures_util::poll!(&mut closing).is_pending(),
        "original SQL actor is still busy"
    );
    release.send(()).unwrap();
    blocked.await.unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), closing)
        .await
        .unwrap()
        .unwrap();
    root.close().await.unwrap();
    let namespaces = root::RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let reopened = RootStore::open(Arc::new(
        root::RootOwner::open(&dir.path().join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    let recovered = reopened
        .operation(&reference)
        .unwrap()
        .operation_observation()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.cleanup, OperationCleanup::Confirmed);
    reopened.close().await.unwrap();
}
