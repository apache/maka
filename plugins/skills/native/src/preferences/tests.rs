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
use crate::tests::scope;

async fn root_store(path: &std::path::Path) -> Arc<RootStore> {
    use maka_event_log::root::{RootNamespaces, RootOwner};
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let root_path = path.join("root");
    let owner = if root_path.exists() {
        RootOwner::open(&root_path, &namespaces).unwrap()
    } else {
        RootOwner::create(&root_path, &namespaces).unwrap()
    };
    Arc::new(
        RootStore::open(Arc::new(owner), maka_event_log::ROOT_MIGRATIONS)
            .await
            .unwrap(),
    )
}

use maka_event_log::applications::operations::{Dispatch, DispatchClaim, OperationRequest};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationResult};

async fn original(log: &RootStore, input: &SetPreference, call: &Scope) -> DispatchClaim {
    use maka_packages::{MANIFEST_FILE, Package};
    use maka_plugin_core::{
        composition::{Configuration, Input, InstanceId, Node, PackageUse, Target},
        contract::{Availability, Cardinality, Export, Import},
        package::{Declaration, EntryDeclaration, Implementation},
    };
    let provider = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "id": "test.skills.preferences.provider",
            "application": Declaration {
                host: Some(EntryDeclaration {
                    implementation: Implementation::Native { implementation: IMPLEMENTATION.into() },
                    configuration: serde_json::json!({"type":"object"}).into(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::from([(maka_skills_api::EXPORT.into(), Export {
                        contract: contract(), availability: Availability::Required,
                    })]),
                }), ui: None, composition: None,
            },
        })).unwrap(),
    )])).unwrap();
    let consumer = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "id": "test.skills.preferences.consumer",
            "application": Declaration {
                host: Some(EntryDeclaration {
                    implementation: Implementation::Native { implementation: "test.skills.preferences.consumer".into() },
                    configuration: serde_json::json!({"type":"object"}).into(),
                    imports: BTreeMap::from([("library".into(), Import {
                        contract: contract(), cardinality: Cardinality::One,
                    })]),
                    exports: BTreeMap::new(),
                }), ui: None, composition: None,
            },
        })).unwrap(),
    )])).unwrap();
    let provider_key = uuid::Uuid::new_v4();
    let consumer_key = uuid::Uuid::new_v4();
    let provider_id = InstanceId(vec![provider_key]);
    let consumer_id = InstanceId(vec![consumer_key]);
    let source = log
        .commit_application(
            uuid::Uuid::new_v4(),
            0,
            Input {
                base: None,
                ui: None,
                instances: BTreeMap::from([
                    (
                        "provider".into(),
                        Node {
                            key: provider_key,
                            package: provider.application_ref().into(),
                            use_package: PackageUse::Host,
                            configuration: Configuration::default(),
                            parameters: Configuration::default(),
                            bindings: BTreeMap::new(),
                            disabled: false,
                            overrides: vec![],
                        },
                    ),
                    (
                        "consumer".into(),
                        Node {
                            key: consumer_key,
                            package: consumer.application_ref().into(),
                            use_package: PackageUse::Host,
                            configuration: Configuration::default(),
                            parameters: Configuration::default(),
                            bindings: BTreeMap::from([(
                                "library".into(),
                                vec![Target::Instance {
                                    path: vec!["provider".into()],
                                    export: maka_skills_api::EXPORT.into(),
                                }],
                            )]),
                            disabled: false,
                            overrides: vec![],
                        },
                    ),
                ]),
            },
            vec![],
            vec![provider, consumer],
        )
        .await
        .unwrap();
    let loaded = log.load_application_at(&source).await.unwrap().unwrap();
    assert!(loaded.plan().instances().contains_key(&provider_id));
    assert!(loaded.plan().instances().contains_key(&consumer_id));
    let request = OperationRequest {
        source,
        namespace: provider_id,
        consumer: consumer_id,
        export: maka_skills_api::EXPORT.into(),
        method: "setPreference".into(),
        contract: contract(),
        operation: uuid::Uuid::new_v4(),
        input: serde_json::to_value(input).unwrap(),
        capture: None,
        origin: serde_json::to_value(&call.identity).unwrap(),
    };
    let journal = log.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = journal.dispatch_operation(request).await.unwrap() else {
        panic!("expected the actual original preference operation");
    };
    journal.start_operation(&claim).unwrap();
    claim
}
fn validate(value: &Value) -> Result<(), StoreError> {
    let maka_plugin_core::contract::Interface::Service { methods } = contract().interface else {
        unreachable!("actual skills service contract");
    };
    maka_plugin_core::validator(&methods["setPreference"].output)
        .unwrap()
        .validate(value)
        .map_err(|error| StoreError::InvalidTransition(error.to_string()))
}
pub(crate) async fn apply(
    store: &Store,
    input: SetPreference,
    call: &Scope,
) -> Result<PreferenceResult, String> {
    let claim = original(&store.log, &input, call).await;
    let observation = store
        .set(input, call)?
        .commit_result(&claim, validate)
        .await
        .map_err(|error| error.to_string())?;
    let OperationOutcome::Returned {
        result: OperationResult::Success { value },
    } = observation.outcome
    else {
        panic!("expected original preference business receipt");
    };
    store
        .log
        .operation(claim.reference())
        .unwrap()
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn change(revision: u64, enabled: bool, pinned: bool) -> SetPreference {
    SetPreference {
        reference: "source:local:review".into(),
        revision,
        preference: maka_skills::Preference { enabled, pinned },
    }
}
#[tokio::test]
async fn concurrent_cas_persists_the_winner_and_separates_owners() {
    let dir = tempfile::tempdir().unwrap();
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let other = Store::new(log.clone(), "two_".into());
    let call = scope();
    assert_eq!(store.read(&call).await.unwrap().revision, 0);
    let (a, b) = tokio::join!(
        apply(&store, change(0, false, false), &call),
        apply(&store, change(0, true, true), &call)
    );
    assert!(matches!(
        (&a, &b),
        (
            Ok(PreferenceResult::Applied { revision: 1 }),
            Ok(PreferenceResult::Changed)
        ) | (
            Ok(PreferenceResult::Changed),
            Ok(PreferenceResult::Applied { revision: 1 })
        )
    ));
    let expected = store.read(&call).await.unwrap().entries;
    assert_eq!(expected.len(), 1);
    assert!(other.read(&call).await.unwrap().entries.is_empty());
    call.finish().await.unwrap();
    log.shutdown().await.unwrap();
    drop((store, other, log));
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let call = scope();
    assert_eq!(store.read(&call).await.unwrap().entries, expected);
    assert!(matches!(
        apply(&store, change(1, true, false), &call).await.unwrap(),
        PreferenceResult::Applied { revision: 2 }
    ));
    let current = store.read(&call).await.unwrap();
    assert_eq!(current.revision, 2);
    assert!(current.entries.is_empty());
    assert!(matches!(
        apply(&store, change(0, false, false), &call).await.unwrap(),
        PreferenceResult::Changed
    ));
    call.finish().await.unwrap();
    log.shutdown().await.unwrap();
}
#[tokio::test]
async fn dropping_observer_cannot_finish_the_original_call_before_its_store_work() {
    let dir = tempfile::tempdir().unwrap();
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let call = scope();
    let (started, running) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let worker_store = store.clone();
    let worker_scope = call.clone();
    let observer = tokio::spawn(async move {
        worker_store.run(&worker_scope, move |store, _| Box::pin(async move {
            started.send(()).unwrap();
            held.await.unwrap();
            store.log.plugin_data_batch(&namespace(), vec![Mutation {
                key: store.key, expected_revision: None,
                data: Data::Present(serde_json::json!({"source:local:review":{"enabled":false,"pinned":true}})),
            }]).await.map_err(|_| "test write failed".to_owned())
        })).await
    });
    running.await.unwrap();
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    assert!(
        !call.resources.seal().unwrap(),
        "the detached observer cannot settle live SQL custody"
    );
    release.send(()).unwrap();
    call.finish().await.unwrap();
    let current = store.read(&scope()).await.unwrap();
    assert_eq!(current.revision, 1);
    assert!(!current.entries["source:local:review"].enabled);
    log.shutdown().await.unwrap();
}

#[tokio::test]
async fn preference_and_original_returned_are_one_transaction_and_known_replay_does_not_write_again()
 {
    struct ReturnFault(bool);
    impl Statement for ReturnFault {
        type Value = ();
        type Output = ();
        fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<()>, StoreError> {
            if self.0 {
                connection.execute_batch("CREATE TEMP TRIGGER reject_preference_return BEFORE UPDATE OF outcome_json ON application_operations BEGIN SELECT RAISE(ABORT, 'original Returned write rejected'); END;")?;
            } else {
                connection.execute_batch("DROP TRIGGER reject_preference_return;")?;
            }
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let log = root_store(directory.path()).await;
    let store = Store::new(log.clone(), "atomic_".into());
    let call = scope();
    let input = change(0, false, true);
    let claim = original(&log, &input, &call).await;
    let journal = log.operation(claim.reference()).unwrap();
    let prepared = store.set(input, &call).unwrap();
    assert_eq!(
        store.read(&call).await.unwrap().revision,
        0,
        "preparing cannot self-commit preferences"
    );
    log.data_writer()
        .unwrap()
        .write(ReturnFault(true))
        .await
        .unwrap();
    let refused = prepared.commit_result(&claim, validate).await;
    assert!(
        refused.is_err(),
        "the original Returned write must actually reject"
    );
    let unchanged = store.read(&call).await.unwrap();
    assert_eq!(unchanged.revision, 0);
    assert!(unchanged.entries.is_empty());
    assert!(matches!(
        journal
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Unresolved
    ));
    log.data_writer()
        .unwrap()
        .write(ReturnFault(false))
        .await
        .unwrap();
    let first = store
        .set(change(0, false, true), &call)
        .unwrap()
        .commit_result(&claim, validate)
        .await
        .unwrap();
    assert!(
        matches!(&first.outcome, OperationOutcome::Returned { result: OperationResult::Success { value } }
        if value == &serde_json::json!({"kind":"applied","revision":1}))
    );
    let replay = store
        .set(change(1, true, false), &call)
        .unwrap()
        .commit_result(&claim, validate)
        .await
        .unwrap();
    assert_eq!(replay, first);
    let attempted_downgrade = journal
        .record_operation_outcome(
            &claim,
            OperationOutcome::Unknown {
                diagnostic: "late transport uncertainty cannot erase the same-S result".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(attempted_downgrade.outcome, first.outcome);
    let current = store.read(&call).await.unwrap();
    assert_eq!(current.revision, 1);
    assert!(!current.entries["source:local:review"].enabled);
    assert!(current.entries["source:local:review"].pinned);
    journal
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();

    let input = change(1, true, false);
    let rejected_claim = original(&log, &input, &call).await;
    let invalid_output = store
        .set(input, &call)
        .unwrap()
        .commit_result(&rejected_claim, |value| {
            jsonschema::validator_for(&serde_json::json!({"type":"null"}))
                .unwrap()
                .validate(value)
                .map_err(|error| StoreError::InvalidTransition(error.to_string()))
        })
        .await;
    assert!(
        invalid_output.is_err(),
        "actual output validation precedes COMMIT"
    );
    assert_eq!(store.read(&call).await.unwrap().revision, 1);
    assert!(store.read(&call).await.unwrap().entries["source:local:review"].pinned);
    let rejected_journal = log.operation(rejected_claim.reference()).unwrap();
    assert!(matches!(
        rejected_journal
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Unresolved
    ));
    rejected_journal
        .record_operation_outcome(
            &rejected_claim,
            OperationOutcome::Returned {
                result: OperationResult::Failure {
                    diagnostic: "actual output rejected".into(),
                },
            },
        )
        .await
        .unwrap();
    rejected_journal
        .record_operation_cleanup(&rejected_claim, OperationCleanup::Confirmed)
        .await
        .unwrap();

    let input = change(1, true, false);
    let unknown_claim = original(&log, &input, &call).await;
    let unknown_journal = log.operation(unknown_claim.reference()).unwrap();
    let unknown = OperationOutcome::Unknown {
        diagnostic: "original result is unknown".into(),
    };
    unknown_journal
        .record_operation_outcome(&unknown_claim, unknown.clone())
        .await
        .unwrap();
    assert!(
        store
            .set(input, &call)
            .unwrap()
            .commit_result(&unknown_claim, validate)
            .await
            .is_err(),
        "Unknown is not permission to execute the domain statement again"
    );
    assert_eq!(store.read(&call).await.unwrap().revision, 1);
    assert_eq!(
        unknown_journal
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        unknown
    );
    let writer = log.data_writer().unwrap();
    let store_current = store.read(&call).await.unwrap();
    let fixed_mutation = || Mutation {
        key: store.key.clone(),
        expected_revision: Some(1),
        data: Data::Present(serde_json::to_value(&store_current.entries).unwrap()),
    };
    let (records, late) = log
        .prepare_plugin_data_batch(&namespace(), vec![fixed_mutation()], &writer)
        .unwrap();
    let fixed_result = OperationResult::Success {
        value: serde_json::json!({"kind":"applied","revision":records[0].revision}),
    };
    let resolved = late
        .commit(&unknown_claim, fixed_result.clone())
        .await
        .unwrap();
    assert_eq!(
        resolved.outcome,
        OperationOutcome::Returned {
            result: fixed_result.clone()
        }
    );
    let (_, duplicate) = log
        .prepare_plugin_data_batch(&namespace(), vec![fixed_mutation()], &writer)
        .unwrap();
    assert_eq!(
        duplicate
            .commit(&unknown_claim, fixed_result)
            .await
            .unwrap(),
        resolved
    );
    assert_eq!(store.read(&call).await.unwrap().revision, 2);
    unknown_journal
        .record_operation_cleanup(&unknown_claim, OperationCleanup::Confirmed)
        .await
        .unwrap();

    let foreign_directory = tempfile::tempdir().unwrap();
    let foreign_log = root_store(foreign_directory.path()).await;
    let foreign = Store::new(foreign_log.clone(), "atomic_".into());
    assert!(
        foreign
            .set(change(0, true, true), &call)
            .unwrap()
            .commit_result(&claim, validate)
            .await
            .is_err()
    );
    assert_eq!(foreign.read(&call).await.unwrap().revision, 0);
    assert_eq!(store.read(&call).await.unwrap().revision, 2);
    foreign_log.shutdown().await.unwrap();
    call.finish().await.unwrap();
    log.shutdown().await.unwrap();
}
