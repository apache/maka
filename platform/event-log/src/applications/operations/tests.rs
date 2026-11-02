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

use maka_plugin_core::contract::{Interface, Method, MethodMode, Transport};
use std::collections::BTreeMap;

async fn request(store: &EventLog) -> OperationRequest {
    OperationRequest {
        source: store
            .commit_application(Uuid::new_v4(), 0, input(), vec![], vec![])
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
            claim
        }
        _ => panic!("exactly one dispatch may execute"),
    };
    let outcome = OperationOutcome::Returned {
        value: serde_json::json!({"changed":true}),
    };
    let cleanup = OperationCleanup::Failed {
        diagnostic: "actual resource remains open".into(),
    };
    let settled = store
        .finish_operation(&claim, outcome.clone(), cleanup.clone())
        .await
        .unwrap();
    assert_eq!(
        store
            .finish_operation(&claim, outcome, cleanup)
            .await
            .unwrap(),
        settled
    );
    assert!(matches!(
        store
            .finish_operation(
                &claim,
                OperationOutcome::Unknown {
                    diagnostic: "rewrite".into()
                },
                OperationCleanup::Confirmed
            )
            .await,
        Err(StoreError::EventConflict)
    ));
    let Dispatch::Existing(duplicate) = store.dispatch_operation(request).await.unwrap() else {
        panic!("no second claim")
    };
    assert_eq!(duplicate, settled);
    assert_eq!(
        store
            .operation_observation(&reference)
            .await
            .unwrap()
            .unwrap(),
        settled
    );
    store.close().await.unwrap();
}
#[tokio::test]
async fn dispatch_requires_original_source_and_settlement_requires_original_claim() {
    let (_dir, store) = store().await;
    let original = request(&store).await;
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
    let Dispatch::New(claim) = store.dispatch_operation(original).await.unwrap() else {
        panic!()
    };
    let (_other_dir, other) = crate::applications::tests::store().await;
    assert!(
        other
            .finish_operation(
                &claim,
                OperationOutcome::Returned { value: Value::Null },
                OperationCleanup::Confirmed
            )
            .await
            .is_err()
    );
    assert!(
        store
            .finish_operation(
                &claim,
                OperationOutcome::Unresolved,
                OperationCleanup::Confirmed
            )
            .await
            .is_err()
    );
    let outcome = OperationOutcome::Unknown {
        diagnostic: "original diagnostic 中\n".repeat(4000),
    };
    let settled = store
        .finish_operation(&claim, outcome.clone(), OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(settled.outcome, outcome);
    assert_eq!(
        store
            .operation_observation(&settled.reference)
            .await
            .unwrap()
            .unwrap(),
        settled
    );
    other.close().await.unwrap();
    store.close().await.unwrap();
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
    methods.get_mut("change").unwrap().input =
        serde_json::json!({"description": "x".repeat(100_000)}).into();
    let templates = OperationTemplate::for_contract(&original.contract).unwrap();
    let template = &templates["change"];
    original.input = serde_json::json!({
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
    let Dispatch::Existing(observation) = store.dispatch_operation(original.clone()).await.unwrap()
    else {
        panic!("original identity must deduplicate")
    };
    assert_eq!(observation.reference, *claim.reference());
    assert_eq!(observation.outcome, OperationOutcome::Unresolved);
    assert_eq!(observation.cleanup, OperationCleanup::Unconfirmed);
    let outcome = OperationOutcome::Returned {
        value: serde_json::json!({
            "text": "结果😀\n\"\\\t".repeat(100_000),
            "tail": {"complete": true, "original": "完整结果"},
        }),
    };
    assert!(serde_json::to_vec(&outcome).unwrap().len() > 1024 * 1024 + 128);
    let settled = store
        .finish_operation(&claim, outcome.clone(), OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(settled.reference, *claim.reference());
    assert_eq!(settled.outcome, outcome);
    assert_eq!(settled.cleanup, OperationCleanup::Confirmed);
    assert_eq!(
        store
            .finish_operation(&claim, outcome, OperationCleanup::Confirmed)
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
    original.input = serde_json::json!({"replacement": true});
    assert!(matches!(
        store
            .dispatch_prepared_operation(template.prepare(dynamic_request(&original)).unwrap())
            .await,
        Err(StoreError::EventConflict)
    ));
    assert_eq!(
        store
            .operation_observation(claim.reference())
            .await
            .unwrap(),
        Some(settled)
    );
    drop(claim);
    store.close().await.unwrap();
}
