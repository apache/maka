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
use crate::{
    OpenPurpose, ROOT_MIGRATIONS,
    root::{ROOT_DATABASE, RootNamespaces},
};
use maka_plugin_core::{
    composition::Input,
    contract::{Method, MethodMode, Transport},
};
use serde_json::json;
use std::path::Path;
enum Business {
    Schema,
    Insert {
        operation: Uuid,
        value: i64,
        reject: bool,
    },
}
impl crate::writeback::Statement for Business {
    type Value = ();
    type Output = ();
    fn execute(
        self,
        connection: &Connection,
    ) -> Result<crate::writeback::Prepared<()>, StoreError> {
        match self {
            Self::Schema => {
                connection.execute_batch("CREATE TABLE receipt_boundary_business(operation TEXT PRIMARY KEY, value INTEGER NOT NULL)")?;
            }
            Self::Insert {
                operation,
                value,
                reject,
            } => {
                connection.execute(
                    "INSERT INTO receipt_boundary_business(operation,value) VALUES (?,?)",
                    params![operation.to_string(), value],
                )?;
                if reject {
                    return Err(StoreError::InvalidTransition(
                        "business rejected after its first SQL write".into(),
                    ));
                }
            }
        }
        Ok(crate::writeback::Prepared {
            value: (),
            changed: true,
            notification: crate::writeback::Notification::METADATA,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::InvalidTransition(_))
    }
}

async fn business(log: &EventLog, operation: Uuid) -> Option<i64> {
    log.connection
        .read(move |connection| {
            connection
                .query_row(
                    "SELECT value FROM receipt_boundary_business WHERE operation=?",
                    [operation.to_string()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(StoreError::from)
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn same_root_business_statement_and_returned_receipt_commit_or_rollback_together() {
    let directory = tempfile::tempdir().unwrap();
    let log = open(directory.path(), true).await;
    log.connection
        .write(Business::Schema, log.commits.notice())
        .await
        .unwrap();

    let rejected = admit(&log, request(&log).await).await;
    log.start_operation(&rejected).unwrap();
    let rejected_ref = rejected.reference().clone();
    let result = log
        .commit_statement(
            &rejected,
            Business::Insert {
                operation: rejected_ref.operation,
                value: 11,
                reject: true,
            },
            OperationResult::Success {
                value: json!({"value":11}),
            },
        )
        .await;
    assert!(
        matches!(result, Err(StoreError::InvalidTransition(ref diagnostic)) if diagnostic == "business rejected after its first SQL write"),
        "the business rejection after its first write must be preserved: {result:?}"
    );
    assert_eq!(business(&log, rejected_ref.operation).await, None);
    let rolled_back = log
        .operation_observation(&rejected_ref)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        rolled_back.outcome,
        OperationOutcome::Unresolved,
        "the failed transaction must not leave a Returned receipt"
    );
    log.record_operation_cleanup(&rejected, OperationCleanup::Confirmed)
        .await
        .unwrap();

    let accepted = admit(&log, request(&log).await).await;
    log.start_operation(&accepted).unwrap();
    let accepted_ref = accepted.reference().clone();
    let committed = log
        .commit_statement(
            &accepted,
            Business::Insert {
                operation: accepted_ref.operation,
                value: 17,
                reject: false,
            },
            OperationResult::Success {
                value: json!({"value":17}),
            },
        )
        .await
        .unwrap();
    assert_eq!(business(&log, accepted_ref.operation).await, Some(17));
    assert_eq!(committed.outcome, returned(17));
    assert_eq!(committed.cleanup, OperationCleanup::Unconfirmed);
    let repeated = log
        .commit_statement(
            &accepted,
            Business::Insert {
                operation: accepted_ref.operation,
                value: 99,
                reject: false,
            },
            OperationResult::Success {
                value: json!({"value":17}),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        repeated, committed,
        "a retry reads the committed receipt without executing another business statement"
    );
    assert_eq!(business(&log, accepted_ref.operation).await, Some(17));
    let settled = log
        .record_operation_cleanup(&accepted, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop((rejected, accepted));
    log.close().await.unwrap();

    let reopened = open(directory.path(), false).await;
    assert_eq!(business(&reopened, rejected_ref.operation).await, None);
    assert_eq!(
        reopened
            .operation_observation(&rejected_ref)
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Unresolved
    );
    assert_eq!(business(&reopened, accepted_ref.operation).await, Some(17));
    assert_eq!(
        reopened.operation_observation(&accepted_ref).await.unwrap(),
        Some(settled)
    );
    reopened.close().await.unwrap();
}

async fn open(base: &Path, create: bool) -> EventLog {
    let namespaces = RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    };
    let owner = Arc::new(if create {
        RootOwner::create(&base.join("root"), &namespaces).unwrap()
    } else {
        RootOwner::open(&base.join("root"), &namespaces).unwrap()
    });
    EventLog::open_owned(
        &owner.canonical_path().join(ROOT_DATABASE),
        Some(owner.clone()),
        OpenPurpose::Execution,
        ROOT_MIGRATIONS,
    )
    .await
    .unwrap()
}

async fn request(log: &EventLog) -> OperationRequest {
    let source = log
        .commit_application(
            Uuid::new_v4(),
            0,
            Input {
                base: None,
                instances: BTreeMap::new(),
                ui: None,
            },
            vec![],
            vec![],
        )
        .await
        .unwrap();
    OperationRequest {
        source,
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer: InstanceId(vec![Uuid::new_v4()]),
        export: "ledger".into(),
        method: "write".into(),
        contract: Contract {
            name: "test.ReceiptLedger".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "write".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type":"object"}).into(),
                        output: json!({}).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        operation: Uuid::new_v4(),
        input: json!({"value":1}),
        capture: None,
        origin: json!({"kind":"storage-boundary-test"}),
    }
}

async fn admit(log: &EventLog, request: OperationRequest) -> DispatchClaim {
    match log.dispatch_operation(request).await.unwrap() {
        Dispatch::New(claim) => claim,
        Dispatch::Existing(_) => panic!("fresh original operation must have one dispatch claim"),
    }
}

fn returned(value: u64) -> OperationOutcome {
    OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"value":value}),
        },
    }
}

#[tokio::test]
async fn known_result_cannot_release_live_work_and_unknown_accepts_only_late_original_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let log = open(directory.path(), true).await;
    let original = request(&log).await;
    let claim = admit(&log, original.clone()).await;
    log.start_operation(&claim).unwrap();
    let reference = claim.reference().clone();
    let scope = claim.auxiliary_scope();
    let work = scope.acquire(&log, &reference).unwrap();
    let known = log
        .record_operation_outcome(&claim, returned(1))
        .await
        .unwrap();
    assert_eq!(known.outcome, returned(1));
    assert_eq!(known.cleanup, OperationCleanup::Unconfirmed);
    assert!(
        log.record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .is_err(),
        "a known result must not authorize releasing original live work"
    );
    assert!(
        scope.acquire(&log, &reference).is_err(),
        "terminal result closes admission of new original work"
    );
    let failed = log
        .record_operation_cleanup(
            &claim,
            OperationCleanup::Failed {
                diagnostic: "original cleanup is still pending".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(failed.outcome, known.outcome);
    assert!(matches!(failed.cleanup, OperationCleanup::Failed { .. }));
    drop(work);
    let settled = log
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(settled.outcome, known.outcome);
    assert_eq!(settled.cleanup, OperationCleanup::Confirmed);
    assert_eq!(
        log.record_operation_outcome(&claim, returned(1))
            .await
            .unwrap(),
        settled
    );
    assert!(matches!(
        log.record_operation_outcome(&claim, returned(2)).await,
        Err(StoreError::EventConflict)
    ));
    let mut conflicting = original.clone();
    conflicting.input = json!({"value":2});
    assert!(matches!(
        log.dispatch_operation(conflicting).await,
        Err(StoreError::EventConflict)
    ));
    match log.dispatch_operation(original).await.unwrap() {
        Dispatch::Existing(observation) => assert_eq!(observation, settled),
        Dispatch::New(_) => panic!("known original receipt must not grant another dispatch"),
    }

    let second = request(&log).await;
    let late = admit(&log, second).await;
    log.start_operation(&late).unwrap();
    let late_reference = late.reference().clone();
    log.record_operation_outcome(
        &late,
        OperationOutcome::Unknown {
            diagnostic: "delivery lost".into(),
        },
    )
    .await
    .unwrap();
    let unknown = log
        .record_operation_cleanup(&late, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert!(matches!(unknown.outcome, OperationOutcome::Unknown { .. }));
    assert_eq!(unknown.cleanup, OperationCleanup::Confirmed);
    let resolved = log
        .record_operation_outcome(&late, returned(7))
        .await
        .unwrap();
    assert_eq!(resolved.outcome, returned(7));
    assert_eq!(resolved.cleanup, OperationCleanup::Confirmed);
    assert!(
        matches!(unknown.outcome, OperationOutcome::Unknown { .. }),
        "late evidence does not rewrite a previously consumed observation"
    );
    drop((scope, claim, late));
    log.close().await.unwrap();

    let reopened = open(directory.path(), false).await;
    assert_eq!(
        reopened.operation_observation(&reference).await.unwrap(),
        Some(settled)
    );
    assert_eq!(
        reopened
            .operation_observation(&late_reference)
            .await
            .unwrap(),
        Some(resolved)
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn provider_prevention_is_an_actual_no_start_fence_not_a_missing_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let log = open(directory.path(), true).await;
    let original = request(&log).await;
    let absent = original.reference().unwrap();
    assert_eq!(log.operation_observation(&absent).await.unwrap(), None);
    let claim = admit(&log, original.clone()).await;
    let prevented = log.prevent_operation_before_start(&claim).await.unwrap();
    assert_eq!(
        prevented.outcome,
        OperationOutcome::NotExecuted {
            proof: NotExecutedProof::ProviderPreventedBeforeStart
        }
    );
    assert!(
        log.start_operation(&claim).is_err(),
        "no delayed original handler can start after provider prevention"
    );
    assert!(matches!(
        log.record_provider_returned(
            claim.reference(),
            OperationResult::Success {
                value: json!({"value":1})
            }
        )
        .await,
        Err(StoreError::EventConflict)
    ));
    let settled = log
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    assert_eq!(settled.outcome, prevented.outcome);
    drop(claim);
    log.close().await.unwrap();
    let reopened = open(directory.path(), false).await;
    match reopened.dispatch_operation(original).await.unwrap() {
        Dispatch::Existing(observation) => assert_eq!(observation, settled),
        Dispatch::New(_) => panic!("the durable provider no-start fence must survive reopening"),
    }
    reopened.close().await.unwrap();
}
