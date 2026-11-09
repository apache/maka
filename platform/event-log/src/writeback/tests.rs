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
    root::{ROOT_DATABASE, RootNamespaces, RootOwner},
};
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{Configuration, Input, InstanceId, Node, PackageUse},
    contract::{Availability, Contract, Export, Interface, Method, MethodMode, Transport},
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome, OperationResult},
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
mod control;
mod statements;
use statements::{Insert, forbid_rollback, gate, hook};

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
    log.connection.run(|db| {
        db.execute_batch("CREATE TABLE writeback_probe(sequence INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL)")?;
        Ok(())
    }).await.unwrap();
    (dir, log)
}
fn counts(log: &EventLog) -> (i64, i64, i64) {
    let db = rusqlite::Connection::open(
        log.owned_root()
            .unwrap()
            .canonical_path()
            .join(ROOT_DATABASE),
    )
    .unwrap();
    db.query_row("SELECT (SELECT count(*) FROM application_intents), (SELECT count(*) FROM application_operations), (SELECT count(*) FROM writeback_probe)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
}
async fn source(store: &EventLog, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"caller","application":Declaration {host: Some(EntryDeclaration { implementation:Implementation::Native {implementation:"test.caller".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::from([("service".into(), Export { contract: contract(), availability: Availability::Required })])}), ui: None,composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                base: None,
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
fn contract() -> Contract {
    Contract {
        name: "writeback.changes".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "change".into(),
                Method {
                    mode: MethodMode::Mutation,
                    input: json!({"type":"object"}).into(),
                    output: json!({}).into(),
                    resources: BTreeMap::new(),
                    progress: None,
                },
            )]),
        },
    }
}
async fn request(store: &EventLog) -> OperationRequest {
    OperationRequest {
        source: source(store, Uuid::new_v4(), 0).await,
        namespace: consumer(),
        consumer: consumer(),
        export: "service".into(),
        method: "change".into(),
        operation: Uuid::new_v4(),
        contract: contract(),
        input: json!({"outer":{"z":1,"a":2},"text":"original"}),
        capture: None,
        origin: json!({"requestId":Uuid::new_v4()}),
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
    log.start_operation(&prior).unwrap();
    let returned = OperationOutcome::Returned {
        result: OperationResult::Success { value: json!(true) },
    };
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
    let mut missing = Box::pin(log.connection.write(
        Insert::for_session("missing", "missing"),
        log.commits.notice(),
    ));
    let mut duplicate = Box::pin(log.dispatch_operation(operation.clone()));
    let mut append = Box::pin(
        log.connection
            .write(Insert::for_session("accepted", "a"), log.commits.notice()),
    );
    let mut settlement = Box::pin(log.record_operation_outcome(&prior, returned.clone()));
    let mut cleanup = Box::pin(log.record_operation_cleanup(&prior, OperationCleanup::Confirmed));
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    assert!(futures_util::poll!(&mut missing).is_pending());
    assert!(futures_util::poll!(&mut duplicate).is_pending());
    assert!(futures_util::poll!(&mut append).is_pending());
    assert!(futures_util::poll!(&mut settlement).is_pending());
    assert!(futures_util::poll!(&mut cleanup).is_pending());
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
    assert!(futures_util::poll!(&mut append).is_pending());
    assert!(futures_util::poll!(&mut settlement).is_pending());
    assert!(futures_util::poll!(&mut cleanup).is_pending());
    release_commit.send(()).unwrap();
    assert_eq!(intent.await.unwrap().intent().reference, reference);
    assert!(matches!(dispatch.await, Ok(Dispatch::New(_))));
    assert!(matches!(missing.await, Err(StoreError::SessionNotFound)));
    assert!(matches!(duplicate.await, Ok(Dispatch::Existing(_))));
    let sequence = append.await.unwrap();
    assert_eq!(settlement.await.unwrap().outcome, returned);
    assert_eq!(cleanup.await.unwrap().cleanup, OperationCleanup::Confirmed);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        *commits.borrow(),
        sequence,
        "metadata never overwrites the committed domain sequence"
    );
    assert_eq!(
        counts(&log),
        (baseline.0 + 1, baseline.1 + 1, baseline.2 + 1)
    );
    // No-op metadata hints are independent of durable changes.
    let replay_commits = Arc::new(AtomicUsize::new(0));
    let observed = replay_commits.clone();
    hook(&log, move || {
        observed.fetch_add(1, Ordering::SeqCst);
        true
    })
    .await;
    commits.borrow_and_update();
    log.record_application_intent_from(&snapshot, consumer(), reference, json!(null))
        .await
        .unwrap();
    assert!(commits.has_changed().unwrap());
    commits.borrow_and_update();
    log.record_operation_outcome(&prior, returned)
        .await
        .unwrap();
    assert!(commits.has_changed().unwrap());
    commits.borrow_and_update();
    assert!(matches!(
        log.dispatch_operation(operation).await,
        Ok(Dispatch::Existing(_))
    ));
    assert!(!commits.has_changed().unwrap());
    assert_eq!(replay_commits.load(Ordering::SeqCst), 0);
    let next_request = request(&log).await;
    let prior_request = request(&log).await;
    let prior_reference = prior_request.reference().unwrap();
    let Dispatch::New(prior) = log.dispatch_operation(prior_request).await.unwrap() else {
        panic!("original retiring worker claim");
    };
    log.start_operation(&prior).unwrap();
    let before_retirement = counts(&log);
    let (release, blocked) = statements::gate(&log).await;
    let outcome = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"retiring":"original T2"}),
        },
    };
    let mut accepted_t0 = Box::pin(log.dispatch_operation(next_request));
    let mut accepted_t2 = Box::pin(log.record_operation_outcome(&prior, outcome.clone()));
    let mut accepted_cleanup =
        Box::pin(log.record_operation_cleanup(&prior, OperationCleanup::Confirmed));
    assert!(futures_util::poll!(&mut accepted_t0).is_pending());
    assert!(futures_util::poll!(&mut accepted_t2).is_pending());
    assert!(futures_util::poll!(&mut accepted_cleanup).is_pending());
    log.connection.request_shutdown();
    assert!(matches!(
        log.connection
            .write(Insert::for_session("too-late", "a"), log.commits.notice())
            .await,
        Err(StoreError::ConnectionClosed)
    ));
    release.send(()).unwrap();
    blocked.await.unwrap();
    assert!(matches!(accepted_t0.await, Ok(Dispatch::New(_))));
    assert_eq!(accepted_t2.await.unwrap().outcome, outcome);
    assert_eq!(
        accepted_cleanup.await.unwrap().cleanup,
        OperationCleanup::Confirmed
    );
    let root_owner = log.root_owner.as_ref().unwrap().clone();
    log.connection.shutdown().await.unwrap();
    assert_eq!(
        counts(&log),
        (
            before_retirement.0,
            before_retirement.1 + 1,
            before_retirement.2
        )
    );
    let reopened = EventLog::for_root(root_owner).await.unwrap();
    let original = reopened
        .operation_observation(&prior_reference)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.reference, prior_reference);
    assert_eq!(original.outcome, outcome);
    assert_eq!(original.cleanup, OperationCleanup::Confirmed);
    reopened.close().await.unwrap();
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
        log.connection.run(|db| {
            db.execute_batch("CREATE TEMP TRIGGER mixed_fault AFTER INSERT ON writeback_probe WHEN NEW.value='poison' BEGIN SELECT RAISE(ABORT, 'mixed storage fault'); END;")?;
            Ok(())
        }).await.unwrap();
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
        let mut missing = Box::pin(log.connection.write(
            Insert::for_session("missing", "missing"),
            log.commits.notice(),
        ));
        let mut duplicate = Box::pin(log.dispatch_operation(operation));
        let mut poison = Box::pin(
            log.connection
                .write(Insert::for_session("poison", "a"), log.commits.notice()),
        );
        let mut unstarted = Box::pin(
            log.connection
                .write(Insert::for_session("unstarted", "b"), log.commits.notice()),
        );
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
            unstarted.await.err().unwrap(),
        ];
        for failure in failures {
            if rollback_fails {
                assert!(
                    matches!(&failure, StoreError::Shared(cause) if matches!(cause.as_ref(), StoreError::RollbackFailed { .. }))
                );
            }
            let StoreError::Sqlite(sql) = failure.underlying() else {
                panic!("{failure:?}");
            };
            assert_eq!(
                sql.sqlite_error().unwrap().extended_code,
                rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
            );
            assert!(sql.to_string().contains("mixed storage fault"));
        }
        assert!(
            matches!(missing.await, Err(StoreError::SessionNotFound)),
            "proved isolation survives outer uncertainty"
        );
        assert!(!commits.has_changed().unwrap());
        let closed = log.connection.shutdown().await;
        assert_eq!(closed.is_err(), rollback_fails);
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
    log.connection.run(|db| {
        db.execute_batch("CREATE TABLE commit_probe (deployment TEXT, revision INTEGER, FOREIGN KEY(deployment,revision) REFERENCES application_sources(deployment,revision) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_mixed_commit AFTER INSERT ON application_intents BEGIN INSERT INTO commit_probe VALUES ('missing',1); END;")?;
        Ok(())
    }).await.unwrap();
    let (release, gate) = gate(&log).await;
    let mut intent = Box::pin(log.record_application_intent_from(
        &snapshot,
        consumer(),
        reference.clone(),
        json!(null),
    ));
    let mut dispatch = Box::pin(log.dispatch_operation(operation.clone()));
    let mut missing = Box::pin(log.connection.write(
        Insert::for_session("missing", "missing"),
        log.commits.notice(),
    ));
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    assert!(futures_util::poll!(&mut missing).is_pending());
    let mut commits = log.subscribe_commits();
    commits.borrow_and_update();
    release.send(()).unwrap();
    gate.await.unwrap();
    assert!(matches!(
        intent.await.err().unwrap().underlying(),
        StoreError::CommitUnknown(_)
    ));
    assert!(matches!(
        dispatch.await.err().unwrap().underlying(),
        StoreError::CommitUnknown(_)
    ));
    assert!(matches!(missing.await, Err(StoreError::SessionNotFound)));
    assert!(
        log.operation_observation(&reference)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!commits.has_changed().unwrap());
    assert_eq!(counts(&log), baseline);
    // Observations after the failure use the same owner, with no remaining
    // transaction or speculative row. A distinct later operation can proceed.
    log.connection
        .run(|db| {
            assert!(db.is_autocommit());
            db.execute("DROP TRIGGER fail_mixed_commit", [])?;
            Ok(())
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
            db.update_hook(Some(move |_, _: &str, table: &str, _| {
                if table == "application_intents" {
                    std::fs::rename(&root, &moved).unwrap();
                }
            }))?;
            Ok(())
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
    let mut append = Box::pin(
        log.connection
            .write(Insert::for_session("authority", "a"), log.commits.notice()),
    );
    assert!(futures_util::poll!(&mut intent).is_pending());
    assert!(futures_util::poll!(&mut append).is_pending());
    let mut control = Box::pin(log.connection.run(|_| {
        panic!("lost authority cannot run next control");
        #[allow(unreachable_code)]
        Ok(())
    }));
    assert!(futures_util::poll!(&mut control).is_pending());
    release.send(()).unwrap();
    gate.await.unwrap();
    for error in [intent.await.err().unwrap(), append.await.err().unwrap()] {
        let StoreError::Io(error) = error.underlying() else {
            panic!("{error:?}")
        };
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
    assert!(matches!(
        control.await,
        Err(StoreError::OperationUnknown | StoreError::ConnectionClosed)
    ));
    assert!(log.connection.shutdown().await.is_err());
    let db = rusqlite::Connection::open(displaced.join(ROOT_DATABASE)).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM application_intents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM writeback_probe", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
