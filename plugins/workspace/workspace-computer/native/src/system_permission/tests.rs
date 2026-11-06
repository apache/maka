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
use std::sync::Mutex;
use tokio::sync::mpsc;

const REQUIRED: &[SystemPermissionGrant] = &[Accessibility, ScreenRecording];

#[derive(Clone)]
struct Probe {
    missing: Arc<Mutex<Vec<SystemPermissionGrant>>>,
    checked: mpsc::UnboundedSender<Vec<SystemPermissionGrant>>,
}
impl PermissionReader for Probe {
    fn missing(
        &self,
        required: &[SystemPermissionGrant],
    ) -> Result<Vec<SystemPermissionGrant>, String> {
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

async fn original_wait(cancel: bool) {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let f = Fixture::with_permissions(true, WorkspacePermissions {
            access: WorkspaceAccess::WorkspaceWrite, request_permissions: true,
        }).await;
        let prepared = f.store.execution_scope(Some(f.basis())).await.unwrap();
        let (parent, effects) = prepared.accept_invocation(f.invocation.clone(), CancellationToken::new()).unwrap();
        let source = parent.store();
        let cancellation = CancellationToken::new();
        let call = Issuer::default().issue_with_execution(Identity::Agent {
            invocation: f.invocation.clone(), operation_id: Some("original-repl".into()),
        }, (), cancellation.clone(), source.execution_custody().unwrap()).unwrap();
        let (checked, mut checks) = mpsc::unbounded_channel();
        let reader = Probe { missing: Arc::new(Mutex::new(vec![ScreenRecording])), checked };
        let mut commits = source.subscribe_session_commits(&f.invocation.session_id).unwrap();
        let owner = f.owner.clone();
        let task_reader = reader.clone();
        let task_cancel = cancellation.clone();
        let basis = f.basis();
        let original = tokio::spawn(async move {
            let cell = maka_code_runtime::CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
            ensure_with_reader(&owner, &call, basis, REQUIRED, "original-get-app", &task_cancel, &cell, task_reader).await?;
            Ok::<_, ToolError>("original call resumed")
        });
        let record = loop {
            if let Some(record) = source.pending_interactions(&f.invocation.session_id).await.unwrap().into_iter().next() { break record; }
            commits.changed().await.unwrap();
        };
        assert_eq!(checks.recv().await.unwrap(), vec![ScreenRecording]);
        let InteractionRequest::SystemPermission { grants, .. } = &record.request else { panic!("system permission required"); };
        assert_eq!(grants, REQUIRED);
        if cancel {
            cancellation.cancel();
            assert!(matches!(original.await.unwrap(), Err(ToolError::Failed(reason)) if reason == "System permission request cancelled"));
        } else {
            *reader.missing.lock().unwrap() = vec![Accessibility];
            while checks.recv().await.unwrap() != vec![Accessibility] {}
            assert!(!original.is_finished(), "the same call must still wait for the newly missing AX grant");
            assert!(source.interaction(&record.request_id).await.unwrap().unwrap().outcome.is_none());
            reader.missing.lock().unwrap().clear();
            assert_eq!(original.await.unwrap().unwrap(), "original call resumed");
        }
        let outcome = source.interaction(&record.request_id).await.unwrap().unwrap().outcome.unwrap();
        if cancel {
            assert!(matches!(outcome, InteractionOutcome::Closure { reason: ClosureReason::ProducerCancelled, .. }));
        } else {
            assert!(matches!(outcome, InteractionOutcome::SystemPermissionGranted { .. }));
        }
        effects.settle().await.unwrap();
        parent.finish();
    }).await.unwrap();
}

#[tokio::test]
async fn system_permission_original_call_waits_for_every_required_grant() {
    original_wait(false).await;
}

#[tokio::test]
async fn system_permission_cancellation_closes_without_resuming_the_original_call() {
    original_wait(true).await;
}
