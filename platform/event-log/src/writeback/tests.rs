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

use crate::{
    EventLog, StoreError,
    applications::operations::{Dispatch, OperationRequest},
    message_admissions::PendingMessageAdmission,
    root::{ROOT_DATABASE, RootNamespaces, RootOwner},
};
use maka_agent_facts::event::{CommitError, EventWrite, Fact, InvocationInput, RuntimeEvent};
use maka_capabilities::call::Identity;
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{Configuration, Input, InstanceId, Node, PackageUse},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome},
    package::{Declaration, EntryDeclaration, Implementation},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;
use uuid::Uuid;
mod admissions;
mod control;
use admissions::{admission, forbid_rollback, gate, hook};

async fn store() -> (tempfile::TempDir, Arc<EventLog>) {
    let dir = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let log = Arc::new(EventLog::for_root(owner).await.unwrap());
    for id in ["a", "b"] {
        log.create_session(id, id, &json!({}), 0).await.unwrap();
    }
    (dir, log)
}
fn opening(admission: &PendingMessageAdmission) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        admission.invocation.clone(),
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: admission.source.message.content.clone(),
                source_messages: vec![admission.source.clone()],
                request_fingerprint: None,
            },
        },
    ))
    .unwrap()
}
fn counts(log: &EventLog) -> (i64, i64, i64, i64) {
    let db = rusqlite::Connection::open(
        log.owned_root()
            .unwrap()
            .canonical_path()
            .join(ROOT_DATABASE),
    )
    .unwrap();
    db.query_row("SELECT (SELECT count(*) FROM application_intents), (SELECT count(*) FROM application_operations), (SELECT count(*) FROM message_admissions), (SELECT count(*) FROM event_log)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
}
async fn source(store: &EventLog, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"caller","application":Declaration {host: Some(EntryDeclaration { implementation:Implementation::Native {implementation:"test.caller".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::new()}), ui: None,composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                ui: None,
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
async fn request(store: &EventLog) -> OperationRequest {
    OperationRequest {
        source: store
            .commit_application(
                Uuid::new_v4(),
                0,
                maka_plugin_core::composition::Input {
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
async fn mixed_receipts_share_full_commit_without_early_claims_or_notifications() {
    let (_dir, log) = store().await;
    let caller = source(&log, Uuid::new_v4(), 0).await;
    let snapshot = log
        .load_application_at(&caller)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    let operation = request(&log).await;
    let reference = operation.reference().unwrap();
    let Dispatch::New(prior) = log.dispatch_operation(request(&log).await).await.unwrap() else {
        panic!("prior claim")
    };
    let returned = OperationOutcome::Returned { value: json!(true) };
    let pending = admission("a");
    let opened = [opening(&admission("b"))];
    let baseline = counts(&log);
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let (entered, reached) = oneshot::channel();
    let mut entered = Some(entered);
    let (release_commit, commit_gate) = std::sync::mpsc::channel();
    hook(&log, move || {
        seen.fetch_add(1, Ordering::SeqCst);
        entered.take().unwrap().send(()).unwrap();
        commit_gate.recv_timeout(Duration::from_secs(10)).unwrap();
        true
    })
    .await;
    let (release, gate) = gate(&log).await;
    let mut intent = Box::pin(log.record_application_intent_from(
        &snapshot,
        consumer(),
        reference.clone(),
        json!(null),
    ));
    let mut dispatch = Box::pin(log.dispatch_operation(operation.clone()));
    let mut missing = Box::pin(log.admit_message(admission("missing")));
    let mut duplicate = Box::pin(log.dispatch_operation(operation.clone()));
    let mut admission = Box::pin(log.admit_message(pending.clone()));
    let mut append = Box::pin(log.append_batch(&opened));
    let mut settlement =
        Box::pin(log.finish_operation(&prior, returned.clone(), OperationCleanup::Confirmed));
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    assert!(futures_util::poll!(&mut missing).is_pending());
    assert!(futures_util::poll!(&mut duplicate).is_pending());
    assert!(futures_util::poll!(&mut admission).is_pending());
    assert!(futures_util::poll!(&mut append).is_pending());
    assert!(futures_util::poll!(&mut settlement).is_pending());
    let mut commits = log.subscribe_commits();
    commits.borrow_and_update();
    release.send(()).unwrap();
    gate.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    assert!(!commits.has_changed().unwrap());
    assert_eq!(counts(&log), baseline);
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    assert!(futures_util::poll!(&mut duplicate).is_pending());
    assert!(futures_util::poll!(&mut admission).is_pending());
    assert!(futures_util::poll!(&mut append).is_pending());
    assert!(futures_util::poll!(&mut settlement).is_pending());
    release_commit.send(()).unwrap();
    assert_eq!(intent.await.unwrap().intent().reference, reference);
    assert!(matches!(dispatch.await, Ok(Dispatch::New(_))));
    assert!(matches!(missing.await, Err(StoreError::SessionNotFound)));
    assert!(matches!(duplicate.await, Ok(Dispatch::Existing(_))));
    assert_eq!(admission.await.unwrap(), pending);
    let sequence = append.await.unwrap()[0];
    assert_eq!(settlement.await.unwrap().outcome, returned);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        *commits.borrow(),
        sequence,
        "metadata never overwrites the event sequence"
    );
    assert_eq!(
        counts(&log),
        (
            baseline.0 + 1,
            baseline.1 + 1,
            baseline.2 + 1,
            baseline.3 + 1
        )
    );
    // No-op metadata hints are independent of durable changes.
    hook(&log, || panic!("replay cannot commit durable changes")).await;
    commits.borrow_and_update();
    log.record_application_intent_from(&snapshot, consumer(), reference, json!(null))
        .await
        .unwrap();
    assert!(commits.has_changed().unwrap());
    commits.borrow_and_update();
    log.finish_operation(&prior, returned, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert!(commits.has_changed().unwrap());
    commits.borrow_and_update();
    assert!(matches!(
        log.dispatch_operation(operation).await,
        Ok(Dispatch::Existing(_))
    ));
    assert!(!commits.has_changed().unwrap());
    log.connection.shutdown().await.unwrap();
}

#[tokio::test]
async fn mixed_sql_failure_preserves_diagnostics_and_never_releases_effect_claims() {
    for rollback_fails in [false, true] {
        let (_dir, log) = store().await;
        let caller = source(&log, Uuid::new_v4(), 0).await;
        let snapshot = log
            .load_application_at(&caller)
            .await
            .unwrap()
            .unwrap()
            .snapshot();
        let operation = request(&log).await;
        let reference = operation.reference().unwrap();
        let baseline = counts(&log);
        log.connection.run(|db| Box::pin(async move {
            sqlx::raw_sql("CREATE TEMP TRIGGER mixed_fault AFTER INSERT ON message_admissions WHEN NEW.session_id='a' BEGIN SELECT RAISE(ABORT, 'mixed storage fault'); END;").execute(db).await?;
            Ok(())
        })).await.unwrap();
        if rollback_fails {
            forbid_rollback(&log).await;
        }
        let (release, gate) = gate(&log).await;
        let mut intent = Box::pin(log.record_application_intent_from(
            &snapshot,
            consumer(),
            reference,
            json!(null),
        ));
        let mut dispatch = Box::pin(log.dispatch_operation(operation.clone()));
        let mut missing = Box::pin(log.admit_message(admission("missing")));
        let mut duplicate = Box::pin(log.dispatch_operation(operation));
        let mut poison = Box::pin(log.admit_message(admission("a")));
        let opened = [opening(&admission("b"))];
        let mut unstarted = Box::pin(log.append_batch(&opened));
        assert!(futures_util::poll!(&mut intent).is_pending());
        assert!(futures_util::poll!(&mut dispatch).is_pending());
        assert!(futures_util::poll!(&mut missing).is_pending());
        assert!(futures_util::poll!(&mut duplicate).is_pending());
        assert!(futures_util::poll!(&mut poison).is_pending());
        assert!(futures_util::poll!(&mut unstarted).is_pending());
        let mut commits = log.subscribe_commits();
        commits.borrow_and_update();
        release.send(()).unwrap();
        gate.await.unwrap();
        let failures = [
            intent.await.err().unwrap(),
            dispatch.await.err().unwrap(),
            duplicate.await.err().unwrap(),
            poison.await.err().unwrap(),
        ];
        for failure in failures {
            let sql = match failure {
                StoreError::Sqlx(sql) if !rollback_fails => sql,
                StoreError::CommitUnknown(sql) if rollback_fails => sql,
                other => panic!("{other:?}"),
            };
            let database = sql.as_database_error().unwrap();
            assert_eq!(
                database.code().unwrap(),
                rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER.to_string()
            );
            assert!(database.as_error().source().is_some());
            assert!(sql.to_string().contains("mixed storage fault"));
        }
        assert!(
            matches!(missing.await, Err(StoreError::SessionNotFound)),
            "proved isolation survives outer uncertainty"
        );
        assert!(matches!(unstarted.await, Err(CommitError::Rejected(_))));
        assert!(!commits.has_changed().unwrap());
        log.connection.shutdown().await.unwrap();
        assert_eq!(counts(&log), baseline);
    }
}

#[tokio::test]
async fn mixed_deferred_commit_failure_releases_no_claim_but_acknowledged_cleanup_keeps_recovery() {
    let (_dir, log) = store().await;
    let caller = source(&log, Uuid::new_v4(), 0).await;
    let snapshot = log
        .load_application_at(&caller)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    let operation = request(&log).await;
    let reference = operation.reference().unwrap();
    let baseline = counts(&log);
    log.connection.run(|db| Box::pin(async move {
        sqlx::raw_sql("CREATE TABLE commit_probe (deployment TEXT, revision INTEGER, FOREIGN KEY(deployment,revision) REFERENCES application_sources(deployment,revision) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_mixed_commit AFTER INSERT ON application_intents BEGIN INSERT INTO commit_probe VALUES ('missing',1); END;").execute(db).await?;
        Ok(())
    })).await.unwrap();
    let (release, gate) = gate(&log).await;
    let mut intent = Box::pin(log.record_application_intent_from(
        &snapshot,
        consumer(),
        reference.clone(),
        json!(null),
    ));
    let mut dispatch = Box::pin(log.dispatch_operation(operation.clone()));
    let mut missing = Box::pin(log.admit_message(admission("missing")));
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    assert!(futures_util::poll!(&mut missing).is_pending());
    let mut recovery = Box::pin(log.operation_observation(&reference));
    assert!(futures_util::poll!(&mut recovery).is_pending());
    let mut commits = log.subscribe_commits();
    commits.borrow_and_update();
    release.send(()).unwrap();
    gate.await.unwrap();
    assert!(matches!(intent.await, Err(StoreError::CommitUnknown(_))));
    assert!(matches!(dispatch.await, Err(StoreError::CommitUnknown(_))));
    assert!(matches!(missing.await, Err(StoreError::SessionNotFound)));
    assert!(recovery.await.unwrap().is_none());
    assert!(!commits.has_changed().unwrap());
    assert_eq!(counts(&log), baseline);
    // Observations after the failure use the same owner, with no remaining
    // transaction or speculative row. A distinct later operation can proceed.
    log.connection
        .run(|db| {
            Box::pin(async move {
                assert!(!sqlx::Connection::is_in_transaction(db));
                sqlx::query("DROP TRIGGER fail_mixed_commit")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let mut later = operation;
    later.operation = Uuid::new_v4();
    assert!(matches!(
        log.dispatch_operation(later).await,
        Ok(Dispatch::New(_))
    ));
    log.connection.shutdown().await.unwrap();
}

#[tokio::test]
async fn mixed_authority_failure_preserves_io_kind_and_closes_before_reusing_writer() {
    let (dir, log) = store().await;
    let caller = source(&log, Uuid::new_v4(), 0).await;
    let snapshot = log
        .load_application_at(&caller)
        .await
        .unwrap()
        .unwrap()
        .snapshot();
    let operation = request(&log).await;
    let root = log.owned_root().unwrap().canonical_path().to_owned();
    let displaced = dir.path().join("displaced-root");
    let moved = displaced.clone();
    log.connection
        .run(move |db| {
            Box::pin(async move {
                db.lock_handle().await?.set_update_hook(move |update| {
                    if update.table == "application_intents" {
                        std::fs::rename(&root, &moved).unwrap();
                    }
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    let (release, gate) = gate(&log).await;
    let mut intent = Box::pin(log.record_application_intent_from(
        &snapshot,
        consumer(),
        operation.reference().unwrap(),
        json!(null),
    ));
    let mut admission = Box::pin(log.admit_message(admission("a")));
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut admission).is_pending());
    let mut control = Box::pin(log.connection.run(|_| {
        Box::pin(async {
            panic!("lost authority cannot run next control");
            #[allow(unreachable_code)]
            Ok(())
        })
    }));
    assert!(futures_util::poll!(&mut control).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    for error in [intent.await.err().unwrap(), admission.await.err().unwrap()] {
        let StoreError::Io(error) = error else {
            panic!("{error:?}")
        };
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(error.get_ref().is_some());
    }
    assert!(matches!(control.await, Err(StoreError::OperationUnknown)));
    log.connection.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(displaced.join(ROOT_DATABASE)).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM application_intents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM message_admissions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
