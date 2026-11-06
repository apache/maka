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
use crate::browser_access::tests::Fixture;
use maka_agent_api::contract::{WorkspaceAccess, WorkspacePermissions};
use maka_agent_facts::interaction::{
    ClosureReason,
    SystemPermissionGrant::{Accessibility, ScreenRecording},
};
use maka_capabilities::call::{Identity, Issuer};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::mpsc;

const REQUIRED: &[SystemPermissionGrant] = &[Accessibility, ScreenRecording];

#[derive(Clone)]
struct Probe {
    missing: Arc<Mutex<Vec<SystemPermissionGrant>>>,
    checked: mpsc::UnboundedSender<Vec<SystemPermissionGrant>>,
    failure: Arc<Mutex<Option<String>>>,
}
impl PermissionReader for Probe {
    fn missing(
        &self,
        required: &[SystemPermissionGrant],
    ) -> Result<Vec<SystemPermissionGrant>, String> {
        if let Some(error) = self.failure.lock().unwrap().take() {
            return Err(error);
        }
        let missing = self.missing.lock().unwrap();
        let observed: Vec<_> = required
            .iter()
            .copied()
            .filter(|grant| missing.contains(grant))
            .collect();
        self.checked.send(observed.clone()).unwrap();
        Ok(observed)
    }
    fn application(&self) -> (String, Option<std::path::PathBuf>) {
        ("Permission fixture".into(), None)
    }
}

enum Scenario {
    Granted,
    Cancelled,
    AccessibilityRevoked,
    ObservationFailed,
}

async fn exercise(scenario: Scenario) {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let f = Fixture::with_permissions(
            true,
            WorkspacePermissions {
                access: WorkspaceAccess::WorkspaceWrite,
                request_permissions: true,
            },
        )
        .await;
        let prepared = f.store.execution_scope(Some(f.basis())).await.unwrap();
        let (parent, effects) = prepared
            .accept_invocation(f.invocation.clone(), CancellationToken::new())
            .unwrap();
        let source = parent.store();
        let cancellation = CancellationToken::new();
        let call = Issuer::default()
            .issue_with_execution(
                Identity::Agent {
                    invocation: f.invocation.clone(),
                    operation_id: Some("original-repl".into()),
                },
                (),
                cancellation.clone(),
                source.execution_custody().unwrap(),
            )
            .unwrap();
        let (checked, mut checks) = mpsc::unbounded_channel();
        let reader = Probe {
            missing: Arc::new(Mutex::new(vec![ScreenRecording])),
            checked,
            failure: Arc::new(Mutex::new(None)),
        };
        let dispatches = Arc::new(AtomicUsize::new(0));
        let mut commits = source
            .subscribe_session_commits(&f.invocation.session_id)
            .unwrap();
        let owner = f.owner.clone();
        let task_reader = reader.clone();
        let task_cancel = cancellation.clone();
        let task_dispatches = dispatches.clone();
        let basis = f.basis();
        let original = tokio::spawn(async move {
            let cell = maka_code_runtime::CellContext::new(
                maka_code_runtime::CellStore::temporary().unwrap(),
                vec![],
            )
            .unwrap();
            ensure_with_reader(
                &owner,
                &call,
                basis,
                REQUIRED,
                "original-get-app",
                &task_cancel,
                &cell,
                task_reader,
            )
            .await?;
            // The original caller's continuation, not an OS effect or a second call.
            task_dispatches.fetch_add(1, Ordering::SeqCst);
            Ok::<_, ToolError>(())
        });
        let record = loop {
            if let Some(record) = source
                .pending_interactions(&f.invocation.session_id)
                .await
                .unwrap()
                .into_iter()
                .next()
            {
                break record;
            }
            commits.changed().await.unwrap();
        };
        assert_eq!(checks.recv().await.unwrap(), vec![ScreenRecording]);
        let InteractionRequest::SystemPermission { grants, .. } = &record.request else {
            panic!("system permission required");
        };
        assert_eq!(grants, REQUIRED);
        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        assert!(!original.is_finished());
        let expected_id = format!(
            "system_permission_{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(&f.invocation, "original-repl", "original-get-app", REQUIRED))
                    .unwrap()
            ))
        );
        assert_eq!(record.request_id, expected_id);
        match scenario {
            Scenario::Granted => {
                reader.missing.lock().unwrap().clear();
            }
            Scenario::Cancelled => cancellation.cancel(),
            Scenario::ObservationFailed => {
                *reader.failure.lock().unwrap() = Some("fresh status transport failed".into());
            }
            Scenario::AccessibilityRevoked => {
                *reader.missing.lock().unwrap() = vec![Accessibility];
                while checks.recv().await.unwrap() != vec![Accessibility] {}
                // The UI queries the published grants: a newly missing AX grant
                // must be visible there while the same producer still waits.
                assert_eq!(reader.missing(grants).unwrap(), vec![Accessibility]);
                assert!(
                    source
                        .interaction(&record.request_id)
                        .await
                        .unwrap()
                        .unwrap()
                        .outcome
                        .is_none()
                );
                assert_eq!(dispatches.load(Ordering::SeqCst), 0);
                reader.missing.lock().unwrap().clear();
            }
        }
        let result = original.await.unwrap();
        let outcome = source
            .interaction(&record.request_id)
            .await
            .unwrap()
            .unwrap()
            .outcome
            .unwrap();
        match scenario {
            Scenario::ObservationFailed => {
                assert!(matches!(result, Err(ToolError::Failed(error)) if error == "fresh status transport failed"));
                assert_eq!(dispatches.load(Ordering::SeqCst), 0);
                assert!(matches!(outcome, InteractionOutcome::Closure { reason: ClosureReason::ProducerCancelled, .. }));
            }
            Scenario::Cancelled => {
                assert!(result.is_err());
                assert_eq!(dispatches.load(Ordering::SeqCst), 0);
                assert!(matches!(
                    outcome,
                    InteractionOutcome::Closure {
                        reason: ClosureReason::ProducerCancelled,
                        ..
                    }
                ));
            }
            Scenario::Granted | Scenario::AccessibilityRevoked => {
                result.unwrap();
                assert_eq!(dispatches.load(Ordering::SeqCst), 1);
                assert!(matches!(
                    outcome,
                    InteractionOutcome::SystemPermissionGranted { .. }
                ));
            }
        }
        assert!(
            source
                .pending_interactions(&f.invocation.session_id)
                .await
                .unwrap()
                .is_empty()
        );
        effects.settle().await.unwrap();
        parent.finish();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn original_wait_continues_once_when_permissions_become_effective() {
    exercise(Scenario::Granted).await;
}
#[tokio::test]
async fn cancellation_closes_the_request_without_dispatching_the_continuation() {
    exercise(Scenario::Cancelled).await;
}
#[tokio::test]
async fn a_newly_missing_required_grant_remains_visible_to_the_ui_and_blocks_the_same_wait() {
    exercise(Scenario::AccessibilityRevoked).await;
}

#[tokio::test]
async fn a_transient_reader_failure_keeps_its_error_and_does_not_dispatch() {
    exercise(Scenario::ObservationFailed).await;
}
