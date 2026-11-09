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
use crate::applications::tests::{input, store};
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{Configuration, Input, Node, PackageUse},
    contract::{Availability, Export, Interface, Method, MethodMode, Transport},
    package::{Declaration, EntryDeclaration, Implementation},
};
use serde_json::json;

fn declared_application(contract: &Contract, implementation: &str) -> (Input, Package) {
    let package = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "operations-provider",
            "application": Declaration {
                host: Some(EntryDeclaration {
                    implementation: Implementation::Native { implementation: implementation.into() },
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
    let mut selected = input();
    for (name, key) in [("provider", 42), ("other-consumer", 43)] {
        selected.instances.insert(
            name.into(),
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
        );
    }
    (selected, package)
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
    let (selected, package) = declared_application(&contract, "test.operations");
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
async fn concurrent_dispatch_has_one_claim_and_duplicate_preserves_original_cleanup() {
    let (_dir, store) = store().await;
    let request = request(&store).await;
    let reference = request.reference().unwrap();
    let (a, b) = tokio::join!(
        store.dispatch_operation(request.clone()),
        store.dispatch_operation(request.clone())
    );
    let claim = match (a.unwrap(), b.unwrap()) {
        (Dispatch::New(claim), Dispatch::Existing(observation))
        | (Dispatch::Existing(observation), Dispatch::New(claim)) => {
            assert_eq!(observation.outcome, OperationOutcome::Unresolved);
            assert_eq!(observation.cleanup, OperationCleanup::Unconfirmed);
            claim
        }
        _ => panic!("exactly one dispatch may execute"),
    };
    store.start_operation(&claim).unwrap();
    assert!(store.start_operation(&claim).is_err());
    let outcome = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"changed":true}),
        },
    };
    let returned = store
        .record_operation_outcome(&claim, outcome.clone())
        .await
        .unwrap();
    assert_eq!(returned.outcome, outcome);
    assert_eq!(returned.cleanup, OperationCleanup::Unconfirmed);
    let cleanup = OperationCleanup::Failed {
        diagnostic: "actual resource remains open".into(),
    };
    let settled = store
        .record_operation_cleanup(&claim, cleanup.clone())
        .await
        .unwrap();
    assert_eq!(
        store
            .record_operation_outcome(&claim, outcome)
            .await
            .unwrap(),
        settled
    );
    assert_eq!(
        store
            .record_operation_cleanup(&claim, cleanup.clone())
            .await
            .unwrap(),
        settled
    );
    assert!(matches!(
        store
            .record_operation_outcome(
                &claim,
                OperationOutcome::Returned {
                    result: OperationResult::Failure {
                        diagnostic: "cannot rewrite actual return".into()
                    },
                }
            )
            .await,
        Err(StoreError::EventConflict)
    ));
    assert_eq!(
        store
            .record_operation_outcome(
                &claim,
                OperationOutcome::Unknown {
                    diagnostic: "stale uncertainty".into()
                }
            )
            .await
            .unwrap(),
        settled,
        "uncertainty cannot erase an actual return"
    );
    let Dispatch::Existing(duplicate) = store.dispatch_operation(request.clone()).await.unwrap()
    else {
        panic!("no second claim")
    };
    assert_eq!(duplicate, settled);
    assert_eq!(
        store.operation_observation(&reference).await.unwrap(),
        Some(settled.clone())
    );
    let confirmed = store
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(confirmed.outcome, settled.outcome);
    assert_eq!(confirmed.cleanup, OperationCleanup::Confirmed);
    assert_eq!(
        store
            .record_operation_cleanup(&claim, cleanup)
            .await
            .unwrap(),
        confirmed
    );
    let Dispatch::Existing(duplicate) = store.dispatch_operation(request).await.unwrap() else {
        panic!("cleanup confirmation cannot reauthorize execution")
    };
    assert_eq!(duplicate, confirmed);
    store.close().await.unwrap();
}

#[tokio::test]
async fn failed_outcome_sql_keeps_unknown_but_does_not_prevent_original_cleanup_ack() {
    let (_dir, store) = store().await;
    let original = request(&store).await;
    let reference = original.reference().unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(original.clone()).await.unwrap() else {
        panic!("first dispatch owns execution")
    };
    store.start_operation(&claim).unwrap();
    let scope = claim.auxiliary_scope();
    let work = scope.acquire(&store, &reference).unwrap();
    let unknown = OperationOutcome::Unknown {
        diagnostic: "original return not yet durably recorded".into(),
    };
    store
        .record_operation_outcome(&claim, unknown.clone())
        .await
        .unwrap();
    let before = store
        .record_operation_cleanup(
            &claim,
            OperationCleanup::Failed {
                diagnostic: "original worker has not drained".into(),
            },
        )
        .await
        .unwrap();
    store.connection.run(|db| {
        db.execute_batch("CREATE TEMP TRIGGER original_outcome_failure BEFORE UPDATE OF outcome_json ON application_operations BEGIN SELECT RAISE(ABORT, 'original outcome SQL failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let returned = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"changed":true}),
        },
    };
    let error = store
        .record_operation_outcome(&claim, returned.clone())
        .await
        .unwrap_err();
    let StoreError::Sqlite(cause) = error.underlying() else {
        panic!("{error:?}")
    };
    assert_eq!(
        cause.sqlite_error().unwrap().extended_code,
        rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
    );
    assert!(cause.to_string().contains("original outcome SQL failure"));
    assert_eq!(
        store.operation_observation(&reference).await.unwrap(),
        Some(before)
    );
    assert!(matches!(
        store.record_operation_cleanup(&claim, OperationCleanup::Confirmed).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "original operation work has not drained"
    ));
    // Original worker completion, not the outcome SQL receipt, supplies the ACK.
    work.finish();
    let cleaned = store
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(cleaned.outcome, unknown);
    assert_eq!(cleaned.cleanup, OperationCleanup::Confirmed);
    assert!(scope.acquire(&store, &reference).is_err());
    store
        .connection
        .run(|db| {
            db.execute_batch("DROP TRIGGER original_outcome_failure")?;
            Ok(())
        })
        .await
        .unwrap();
    let late = store
        .record_operation_outcome(&claim, returned.clone())
        .await
        .unwrap();
    assert_eq!(late.outcome, returned);
    assert_eq!(late.cleanup, OperationCleanup::Confirmed);
    let Dispatch::Existing(duplicate) = store.dispatch_operation(original).await.unwrap() else {
        panic!("neither SQL failure nor late original evidence permits redispatch")
    };
    assert_eq!(duplicate, late);
    store.close().await.unwrap();
}

#[tokio::test]
async fn quarantined_original_work_cannot_be_confirmed_by_a_known_business_result() {
    let (_dir, store) = store().await;
    let original = request(&store).await;
    let reference = original.reference().unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(original).await.unwrap() else {
        panic!("new")
    };
    store.start_operation(&claim).unwrap();
    let scope = claim.auxiliary_scope();
    let work = scope.acquire(&store, &reference).unwrap();
    work.quarantine();
    work.finish();
    let returned = OperationOutcome::Returned {
        result: OperationResult::Failure {
            diagnostic: "handler returned a definite error".into(),
        },
    };
    store
        .record_operation_outcome(&claim, returned.clone())
        .await
        .unwrap();
    let failed = store
        .record_operation_cleanup(
            &claim,
            OperationCleanup::Failed {
                diagnostic: "physical original worker remains uncertain".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(failed.outcome, returned);
    assert!(matches!(
        store.record_operation_cleanup(&claim, OperationCleanup::Confirmed).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "original operation work has not drained"
    ));
    assert!(scope.acquire(&store, &reference).is_err());
    assert_eq!(
        store.operation_observation(&reference).await.unwrap(),
        Some(failed)
    );
    drop((work, scope, claim));
    store.close().await.unwrap();
}

#[tokio::test]
async fn dispatch_requires_original_source_and_settlement_requires_original_claim() {
    let (_dir, store) = store().await;
    let original = request(&store).await;
    let reference = original.reference().unwrap();
    let mut missing = original.clone();
    missing.source.revision += 1;
    assert!(store.dispatch_operation(missing.clone()).await.is_err());
    assert!(
        store
            .operation_observation(&missing.reference().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    let mut nil = original.clone();
    nil.operation = Uuid::nil();
    assert!(store.dispatch_operation(nil).await.is_err());
    let Dispatch::New(claim) = store.dispatch_operation(original.clone()).await.unwrap() else {
        panic!("new")
    };
    store.start_operation(&claim).unwrap();
    let (_other_dir, other) = crate::applications::tests::store().await;
    let foreign = request(&other).await;
    let Dispatch::New(foreign_claim) = other.dispatch_operation(foreign).await.unwrap() else {
        panic!("foreign Root has its own real claim")
    };
    other.start_operation(&foreign_claim).unwrap();
    assert!(
        other
            .record_operation_outcome(
                &claim,
                OperationOutcome::Unknown {
                    diagnostic: "foreign write".into()
                }
            )
            .await
            .is_err()
    );
    assert!(
        other
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .is_err()
    );
    other
        .record_operation_outcome(
            &foreign_claim,
            OperationOutcome::Unknown {
                diagnostic: "foreign original unresolved".into(),
            },
        )
        .await
        .unwrap();
    other
        .record_operation_cleanup(&foreign_claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert!(
        store
            .record_operation_outcome(&claim, OperationOutcome::Unresolved)
            .await
            .is_err()
    );
    assert!(
        store
            .record_operation_cleanup(&claim, OperationCleanup::Unconfirmed)
            .await
            .is_err()
    );
    let unknown = OperationOutcome::Unknown {
        diagnostic: "original diagnostic 中\n".repeat(4000),
    };
    let observed = store
        .record_operation_outcome(&claim, unknown.clone())
        .await
        .unwrap();
    assert_eq!(observed.outcome, unknown);
    assert_eq!(observed.cleanup, OperationCleanup::Unconfirmed);
    let cleaned = store
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(cleaned.outcome, unknown);
    let result = OperationResult::Failure {
        diagnostic: "late definite handler failure 中\n".repeat(4000),
    };
    let owner = store.root_owner.as_ref().unwrap().clone();
    drop(claim);
    other.close().await.unwrap();
    store.close().await.unwrap();

    let root = crate::RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let journal = root
        .provider_journal(original.source.clone(), original.namespace.clone())
        .await
        .unwrap();
    let recovered = journal.operation(&reference).await.unwrap();
    assert_eq!(recovered.observation().await.unwrap(), cleaned);
    let settled = recovered.record_returned(result.clone()).await.unwrap();
    assert_eq!(settled.cleanup, OperationCleanup::Confirmed);
    assert_eq!(
        settled.outcome,
        OperationOutcome::Returned {
            result: result.clone()
        }
    );
    assert_eq!(
        recovered.record_returned(result.clone()).await.unwrap(),
        settled
    );

    // Every negative retains a valid, actually declared direct namespace.
    let bound = root.operation(&reference).unwrap();
    let mut foreign_consumer = original.clone();
    foreign_consumer.consumer = InstanceId(vec![Uuid::from_u128(43)]);
    assert!(matches!(
        bound.dispatch_operation(foreign_consumer).await,
        Err(StoreError::EventConflict)
    ));
    assert!(matches!(
        journal.operation(&missing.reference().unwrap()).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "original provider source is missing"
    ));
    let mut wrong_contract = original.clone();
    wrong_contract.contract.version += 1;
    assert!(matches!(
        journal
            .operation(&wrong_contract.reference().unwrap())
            .await,
        Err(StoreError::EventConflict)
    ));

    let (selected, package) = declared_application(&original.contract, "test.different-provider");
    let changed = root
        .commit_application(
            original.source.deployment,
            original.source.revision,
            selected,
            vec![],
            vec![package],
        )
        .await
        .unwrap();
    let foreign_provider = root
        .provider_journal(changed, original.namespace.clone())
        .await
        .unwrap();
    assert!(matches!(
        foreign_provider.operation(&reference).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "original provider implementation differs"
    ));
    assert_eq!(
        journal
            .operation(&reference)
            .await
            .unwrap()
            .observation()
            .await
            .unwrap(),
        settled
    );
    assert!(matches!(
        recovered
            .record_returned(OperationResult::Success {
                value: json!("replacement")
            })
            .await,
        Err(StoreError::EventConflict)
    ));
    assert_eq!(recovered.observation().await.unwrap(), settled);
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn provider_prevention_is_immutable_and_cleanup_does_not_invent_business_knowledge() {
    let (_dir, store) = store().await;
    let original = request(&store).await;
    let reference = original.reference().unwrap();
    let Dispatch::New(claim) = store.dispatch_operation(original.clone()).await.unwrap() else {
        panic!("new")
    };
    store
        .record_operation_outcome(
            &claim,
            OperationOutcome::Unknown {
                diagnostic: "uncertain before provider fence".into(),
            },
        )
        .await
        .unwrap();
    let prevented = store.prevent_operation_before_start(&claim).await.unwrap();
    assert_eq!(
        prevented.outcome,
        OperationOutcome::NotExecuted {
            proof: NotExecutedProof::ProviderPreventedBeforeStart
        }
    );
    assert_eq!(prevented.cleanup, OperationCleanup::Unconfirmed);
    assert!(store.start_operation(&claim).is_err());
    assert_eq!(
        store.prevent_operation_before_start(&claim).await.unwrap(),
        prevented
    );
    assert!(
        store
            .record_operation_outcome(
                &claim,
                OperationOutcome::Returned {
                    result: OperationResult::Success { value: json!(null) },
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        store
            .record_operation_outcome(
                &claim,
                OperationOutcome::Unknown {
                    diagnostic: "stale uncertainty".into()
                }
            )
            .await
            .unwrap(),
        prevented
    );
    let cleaned = store
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(cleaned.outcome, prevented.outcome);
    let Dispatch::Existing(duplicate) = store.dispatch_operation(original.clone()).await.unwrap()
    else {
        panic!("prevented original must never execute")
    };
    assert_eq!(duplicate, cleaned);
    let owner = store.root_owner.as_ref().unwrap().clone();
    drop(claim);
    store.close().await.unwrap();
    let root = crate::RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let journal = root
        .provider_journal(original.source.clone(), original.namespace.clone())
        .await
        .unwrap();
    let recovered = journal.operation(&reference).await.unwrap();
    assert_eq!(recovered.observation().await.unwrap(), cleaned);
    assert!(matches!(
        recovered
            .record_returned(OperationResult::Failure {
                diagnostic: "cannot replace a durable provider no-start proof".into()
            })
            .await,
        Err(StoreError::EventConflict)
    ));
    assert_eq!(recovered.observation().await.unwrap(), cleaned);
    let Dispatch::Existing(duplicate) = root
        .operation(&reference)
        .unwrap()
        .dispatch_operation(original)
        .await
        .unwrap()
    else {
        panic!("reopened no-start proof cannot grant execution")
    };
    assert_eq!(duplicate, cleaned);
    root.shutdown().await.unwrap();
}

fn dynamic_request(request: &OperationRequest) -> OperationRequest<()> {
    OperationRequest {
        source: request.source.clone(),
        namespace: request.namespace.clone(),
        consumer: request.consumer.clone(),
        export: request.export.clone(),
        method: request.method.clone(),
        contract: (),
        operation: request.operation,
        input: request.input.clone(),
        capture: request.capture,
        origin: request.origin.clone(),
    }
}

#[tokio::test]
async fn compiled_operation_preserves_reference_capture_and_complete_original_dispatch() {
    let (_dir, store) = store().await;
    let mut original = request(&store).await;
    for required in [false, true] {
        if required {
            let Interface::Service { methods } = &mut original.contract.interface else {
                unreachable!()
            };
            methods.get_mut("change").unwrap().resources.insert(
                "secret".into(),
                maka_plugin_core::contract::ResourceType {
                    name: "example.Secret".into(),
                    version: 1,
                }
                .required(),
            );
        }
        let templates = OperationTemplate::for_contract(&original.contract).unwrap();
        let template = &templates["change"];
        for capture in [None, Some(Uuid::nil()), Some(Uuid::new_v4())] {
            original.capture = capture;
            let old = original.reference();
            let compiled = template.prepare(dynamic_request(&original));
            assert_eq!(old.is_ok(), compiled.is_ok());
            if let (Ok(reference), Ok(prepared)) = (old, compiled) {
                assert_eq!(&reference, prepared.reference());
            }
        }
        let mut wrong_method = dynamic_request(&original);
        wrong_method.method = "missing".into();
        assert!(template.prepare(wrong_method).is_err());
    }
    original.capture = Some(Uuid::new_v4());
    let Interface::Service { methods } = &mut original.contract.interface else {
        unreachable!()
    };
    methods.get_mut("change").unwrap().input = json!({"description": "x".repeat(100_000)}).into();
    let (selected, package) = declared_application(&original.contract, "test.operations");
    original.source = store
        .commit_application(
            original.source.deployment,
            original.source.revision,
            selected,
            vec![],
            vec![package],
        )
        .await
        .unwrap();
    let templates = OperationTemplate::for_contract(&original.contract).unwrap();
    let template = &templates["change"];
    original.input = json!({
        "text": "界😀\n\"\\\t".repeat(180_000),
        "tail": {"complete": true, "original": "末尾"},
    });
    assert!(serde_json::to_vec(&original.input).unwrap().len() > 2 * 1024 * 1024);
    let mut invalid_consumer = dynamic_request(&original);
    invalid_consumer.consumer = InstanceId(vec![Uuid::nil()]);
    assert!(template.prepare(invalid_consumer).is_err());
    let prepared = template.prepare(dynamic_request(&original)).unwrap();
    assert_eq!(prepared.reference(), &original.reference().unwrap());
    let Dispatch::New(claim) = store.dispatch_prepared_operation(prepared).await.unwrap() else {
        panic!("first claim")
    };
    store.start_operation(&claim).unwrap();
    let Dispatch::Existing(observation) = store.dispatch_operation(original.clone()).await.unwrap()
    else {
        panic!("original identity must deduplicate")
    };
    assert_eq!(observation.reference, *claim.reference());
    assert_eq!(observation.outcome, OperationOutcome::Unresolved);
    assert_eq!(observation.cleanup, OperationCleanup::Unconfirmed);
    let outcome = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({
                "text": "结果😀\n\"\\\t".repeat(100_000),
                "tail": {"complete": true, "original": "完整结果"},
            }),
        },
    };
    assert!(serde_json::to_vec(&outcome).unwrap().len() > 1024 * 1024 + 128);
    let returned = store
        .record_operation_outcome(&claim, outcome.clone())
        .await
        .unwrap();
    assert_eq!(returned.cleanup, OperationCleanup::Unconfirmed);
    let settled = store
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(settled.reference, *claim.reference());
    assert_eq!(settled.outcome, outcome);
    assert_eq!(settled.cleanup, OperationCleanup::Confirmed);
    assert_eq!(
        store
            .record_operation_outcome(&claim, outcome)
            .await
            .unwrap(),
        settled
    );
    assert_eq!(
        store
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap(),
        settled
    );
    let Dispatch::Existing(retried) = store.dispatch_operation(original.clone()).await.unwrap()
    else {
        panic!("settled original must not execute again")
    };
    assert_eq!(retried, settled);
    let Dispatch::Existing(retried) = store
        .dispatch_prepared_operation(template.prepare(dynamic_request(&original)).unwrap())
        .await
        .unwrap()
    else {
        panic!("settled prepared original must not execute again")
    };
    assert_eq!(retried, settled);
    assert_eq!(
        store
            .operation_observation(claim.reference())
            .await
            .unwrap(),
        Some(settled.clone())
    );
    let mut replacement = original.clone();
    replacement.input = json!({"replacement": true});
    assert!(matches!(
        store
            .dispatch_prepared_operation(template.prepare(dynamic_request(&replacement)).unwrap())
            .await,
        Err(StoreError::EventConflict)
    ));
    assert_eq!(
        store
            .operation_observation(claim.reference())
            .await
            .unwrap(),
        Some(settled.clone())
    );
    let owner = store.root_owner.as_ref().unwrap().clone();
    drop(claim);
    store.close().await.unwrap();
    let reopened = EventLog::for_root(owner).await.unwrap();
    assert_eq!(
        reopened
            .operation_observation(&settled.reference)
            .await
            .unwrap(),
        Some(settled.clone())
    );
    let Dispatch::Existing(retried) = reopened
        .dispatch_prepared_operation(template.prepare(dynamic_request(&original)).unwrap())
        .await
        .unwrap()
    else {
        panic!("losing the receipt and reopening cannot reissue execution")
    };
    assert_eq!(retried, settled);
    reopened.close().await.unwrap();
}
