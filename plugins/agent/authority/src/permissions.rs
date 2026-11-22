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

//! Canonical permission decisions shared by native workspace executors.
use crate::interaction_wait::{wait, withdraw};
use maka_agent_api::session::{ResolvedConfiguration, StoredSessionConfiguration};
use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::interaction::PermissionDecision;
use maka_agent_facts::interaction::PermissionRequest;
use maka_agent_facts::interaction::PermissionSource;
use maka_agent_facts::tools::ToolError;
use maka_event_log::{StoreError, sessions::SessionRecord};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

/// A live, native-issued Run capability. No identity or persisted approval can
/// construct this capability; native rechecks RunSpec intersected with current policy.
pub trait Access: maka_agent_ports::execution::Interactions {
    /// Request identity only: preparation has no Host source; a native caller
    /// exposes only the original captured from its actual bound Context.
    fn permission_request_original(
        &self,
    ) -> Result<Option<&maka_plugin_core::operation::RecoveryRef>, ToolError>;
    fn live_configuration(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<ResolvedConfiguration, ToolError>>;
    /// Observation only. Preparation once approvals are consumed by the original
    /// admission; Host grants are usable only within that active original scope.
    /// Each grant holds only the part that covers a request from `source`.
    fn permission_grants<'a>(
        &'a self,
        target: &'a maka_agent_facts::durable::AuthorizationObligation,
        basis: &'a maka_sandbox::workspace::PermissionBasis,
        source: PermissionSource,
    ) -> futures_util::future::BoxFuture<'a, Result<Vec<PermissionGrant>, ToolError>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionGrant {
    pub approval_id: Option<maka_agent_facts::durable::ApprovalId>,
    pub request_id: String,
    pub permissions: maka_sandbox::grant::Permissions,
    pub scope: maka_agent_facts::interaction::PermissionScope,
}

pub const REQUESTS_DISABLED: &str =
    "Workspace policy does not allow requesting additional permissions";

pub async fn request(
    access: &dyn Access,
    request: PermissionRequest,
    target: &maka_agent_facts::durable::AuthorizationObligation,
    cancellation: &CancellationToken,
) -> Result<PermissionGrant, ToolError> {
    let configuration = access.live_configuration().await?;
    if !configuration.permissions.request_permissions {
        return Err(failed(REQUESTS_DISABLED));
    }
    let source = request.source;
    let identity = (
        &access.execution().run_id,
        target,
        configuration.permission_basis(),
        &request,
    );
    let identity = match access.permission_request_original()? {
        None => serde_json::to_vec(&identity),
        Some(original) => serde_json::to_vec(&(identity, "host", original)),
    }
    .expect("authorization obligation identity");
    let record = InteractionRecord {
        execution: access.execution().clone(),
        request_id: format!("permissions_{}", hex::encode(Sha256::digest(identity))),
        created_at: crate::now(),
        request: InteractionRequest::Permissions {
            target: target.clone(),
            tool_use_id: match target {
                maka_agent_facts::durable::AuthorizationObligation::Tool { tool } => {
                    Some(maka_agent_facts::tool_call::tool_use_id(
                        access.execution().run_id,
                        &format!("{}:{}", tool.attempt, tool.call),
                    ))
                }
                maka_agent_facts::durable::AuthorizationObligation::Cell { .. } => None,
                maka_agent_facts::durable::AuthorizationObligation::External {
                    operation, ..
                } => Some(maka_agent_facts::tool_call::tool_use_id(
                    access.execution().run_id,
                    &operation.to_string(),
                )),
            },
            basis: configuration.permission_basis(),
            request,
        },
        outcome: None,
    };
    let observed = async {
        access
            .establish(&record)
            .await
            .map_err(|_| "permission publication unavailable")?;
        wait(access, &record, cancellation).await
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => match withdraw(access, &record).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => return Err(failed(error)),
            Err(cleanup) => return Err(ToolError::CleanupUnconfirmed(cleanup.into())),
        },
    };
    if cancellation.is_cancelled() {
        return Err(failed("Permission request cancelled"));
    }
    match outcome {
        InteractionOutcome::PermissionsDecision { decision, .. } => match decision {
            PermissionDecision::Allow { .. } => {}
            PermissionDecision::Deny => return Err(failed("Permission request was denied")),
        },
        InteractionOutcome::Closure {
            reason: ClosureReason::TimedOut,
            ..
        } => return Err(failed(ClosureReason::TIMED_OUT_MESSAGE)),
        InteractionOutcome::Closure { .. } => {
            return Err(failed("Permission request closed before a decision"));
        }
        _ => return Err(failed("Unexpected permission request outcome")),
    }
    access
        .permission_grants(target, &configuration.permission_basis(), source)
        .await
        .map_err(|_| failed("Permission observation unavailable"))?
        .into_iter()
        .find(|grant| grant.request_id == record.request_id)
        .ok_or_else(|| failed("Approved permissions are no longer current"))
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

pub async fn live(access: &dyn Access) -> Result<ResolvedConfiguration, ToolError> {
    access.live_configuration().await
}

/// Resolve only the binding snapshot read with this Session's canonical metadata.
/// A separate binding lookup would allow a relocation to split the observation.
pub fn resolve_session(
    session: SessionRecord<StoredSessionConfiguration>,
) -> Result<SessionRecord<ResolvedConfiguration>, StoreError> {
    let binding = session.workspace_binding.as_ref().ok_or_else(|| {
        StoreError::InvalidTransition("Session workspace binding is missing".into())
    })?;
    let workspace = serde_json::from_value(binding.workspace.clone())?;
    let configuration = session
        .configuration
        .clone()
        .resolve(workspace, binding.stamp())
        .map_err(|error| StoreError::InvalidTransition(error.into()))?;
    Ok(session.map_configuration(|_| configuration))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_agent_facts::durable::{ExecutionIdentity, ModelAttemptId, RunId, ToolKey};
    use maka_agent_facts::interaction::PermissionScope;
    use maka_agent_ports::execution::Interactions;
    use maka_sandbox::Network;
    use maka_sandbox::grant::Permissions;
    use maka_sandbox::workspace::PermissionBasis;
    use std::sync::Mutex;
    use tokio::sync::watch;
    use uuid::Uuid;

    struct FakeAccess {
        execution: ExecutionIdentity,
        request_permissions: bool,
        record: Mutex<Option<InteractionRecord>>,
        notify: watch::Sender<()>,
    }

    impl FakeAccess {
        fn new(request_permissions: bool) -> Self {
            let (notify, _) = watch::channel(());
            Self {
                execution: ExecutionIdentity {
                    session_id: "sess-1".into(),
                    turn_id: "turn-1".into(),
                    run_id: RunId::new(),
                },
                request_permissions,
                record: Mutex::new(None),
                notify,
            }
        }

        fn settle(&self, outcome: InteractionOutcome) {
            let mut slot = self.record.lock().expect("lock record");
            if let Some(rec) = slot.as_mut()
                && rec.outcome.is_none()
            {
                rec.outcome = Some(outcome);
            }
            let _ = self.notify.send(());
        }
    }

    impl Interactions for FakeAccess {
        fn execution(&self) -> &ExecutionIdentity {
            &self.execution
        }

        fn changes(&self) -> Result<watch::Receiver<()>, String> {
            Ok(self.notify.subscribe())
        }

        fn read<'a>(
            &'a self,
            request_id: &'a str,
        ) -> BoxFuture<'a, Result<Option<InteractionRecord>, String>> {
            Box::pin(async move {
                Ok(self
                    .record
                    .lock()
                    .expect("lock record")
                    .as_ref()
                    .filter(|r| r.request_id == request_id)
                    .cloned())
            })
        }

        fn establish<'a>(
            &'a self,
            record: &'a InteractionRecord,
        ) -> BoxFuture<'a, Result<InteractionRecord, String>> {
            Box::pin(async move {
                let mut slot = self.record.lock().expect("lock record");
                if let Some(existing) = slot.as_ref() {
                    return Ok(existing.clone());
                }
                *slot = Some(record.clone());
                let _ = self.notify.send(());
                Ok(record.clone())
            })
        }

        fn commit_outcome<'a>(
            &'a self,
            request_id: &'a str,
            outcome: InteractionOutcome,
        ) -> BoxFuture<'a, Result<InteractionRecord, String>> {
            Box::pin(async move {
                let mut slot = self.record.lock().expect("lock record");
                let rec = slot
                    .as_mut()
                    .filter(|r| r.request_id == request_id)
                    .ok_or_else(|| "missing interaction".to_owned())?;
                if rec.outcome.is_none() {
                    rec.outcome = Some(outcome);
                }
                let cloned = rec.clone();
                let _ = self.notify.send(());
                Ok(cloned)
            })
        }
    }

    impl Access for FakeAccess {
        fn permission_request_original(
            &self,
        ) -> Result<Option<&maka_plugin_core::operation::RecoveryRef>, ToolError> {
            Ok(None)
        }

        fn live_configuration(&self) -> BoxFuture<'_, Result<ResolvedConfiguration, ToolError>> {
            Box::pin(async move {
                Ok(serde_json::from_value(serde_json::json!({
                    "title": "Test",
                    "titleIsManual": false,
                    "labels": [],
                    "workspace": { "path": "/tmp" },
                    "binding": { "id": Uuid::from_u128(1), "permissionEpoch": 1 },
                    "permissions": {
                        "access": "workspace_write",
                        "requestPermissions": self.request_permissions
                    },
                    "boundary_revision": 1
                }))
                .expect("test configuration"))
            })
        }

        fn permission_grants<'a>(
            &'a self,
            _target: &'a maka_agent_facts::durable::AuthorizationObligation,
            _basis: &'a PermissionBasis,
            _source: PermissionSource,
        ) -> BoxFuture<'a, Result<Vec<PermissionGrant>, ToolError>> {
            Box::pin(async move {
                let slot = self.record.lock().expect("lock record");
                let grants = slot
                    .as_ref()
                    .and_then(|rec| match &rec.outcome {
                        Some(InteractionOutcome::PermissionsDecision {
                            decision: PermissionDecision::Allow { permissions, scope },
                            ..
                        }) => Some(PermissionGrant {
                            approval_id: None,
                            request_id: rec.request_id.clone(),
                            permissions: permissions.clone(),
                            scope: *scope,
                        }),
                        _ => None,
                    })
                    .into_iter()
                    .collect();
                Ok(grants)
            })
        }
    }

    fn sample_request() -> (
        PermissionRequest,
        maka_agent_facts::durable::AuthorizationObligation,
    ) {
        let req = PermissionRequest {
            reason: "Allow network access".into(),
            command: None,
            permissions: Permissions {
                filesystem: Vec::new(),
                network: Network::Allowed,
            },
            source: PermissionSource::Web,
        };
        let target = maka_agent_facts::durable::AuthorizationObligation::Tool {
            tool: ToolKey {
                attempt: ModelAttemptId::new(),
                call: "call-1".into(),
            },
        };
        (req, target)
    }

    async fn after_publish(
        on_publish: impl FnOnce(&FakeAccess, &CancellationToken),
    ) -> Result<PermissionGrant, ToolError> {
        let access = FakeAccess::new(true);
        let (req, target) = sample_request();
        let cancel = CancellationToken::new();
        let mut published = access.notify.subscribe();
        let driver = async {
            let ready = published
                .wait_for(|_| access.record.lock().expect("lock record").is_some())
                .await
                .is_ok();
            if ready {
                on_publish(&access, &cancel);
            }
            std::future::pending::<()>().await;
        };
        tokio::select! {
            result = request(&access, req, &target, &cancel) => result,
            _ = driver => unreachable!(),
        }
    }

    fn assert_failed(err: ToolError, expected: &str) {
        match err {
            ToolError::Failed(msg) => assert_eq!(msg, expected),
            other => panic!("expected ToolError::Failed({expected:?}), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn policy_disabled_rejects_without_publishing() {
        let access = FakeAccess::new(false);
        let (req, target) = sample_request();
        let cancel = CancellationToken::new();
        let err = request(&access, req, &target, &cancel).await.unwrap_err();
        assert_failed(err, REQUESTS_DISABLED);
        assert!(access.record.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn allow_decision_returns_grant() {
        let (req, _) = sample_request();
        let grant = after_publish(|access, _| {
            access.settle(InteractionOutcome::PermissionsDecision {
                decision: PermissionDecision::Allow {
                    permissions: req.permissions.clone(),
                    scope: PermissionScope::Once,
                },
                committed_at: 1,
            });
        })
        .await
        .expect("allow returns grant");
        assert_eq!(grant.permissions, req.permissions);
        assert_eq!(grant.scope, PermissionScope::Once);
    }

    #[tokio::test]
    async fn failure_outcomes_distinguish_deny_timeout_closure_cancel_and_unexpected() {
        let cases = [
            (
                InteractionOutcome::PermissionsDecision {
                    decision: PermissionDecision::Deny,
                    committed_at: 1,
                },
                "Permission request was denied",
            ),
            (
                InteractionOutcome::Closure {
                    reason: ClosureReason::TimedOut,
                    committed_at: 1,
                },
                ClosureReason::TIMED_OUT_MESSAGE,
            ),
            (
                InteractionOutcome::Closure {
                    reason: ClosureReason::RunStopped,
                    committed_at: 1,
                },
                "Permission request closed before a decision",
            ),
            (
                InteractionOutcome::SystemPermissionGranted { committed_at: 1 },
                "Unexpected permission request outcome",
            ),
        ];
        for (outcome, expected) in cases {
            let err = after_publish(|access, _| access.settle(outcome))
                .await
                .unwrap_err();
            assert_failed(err, expected);
        }

        let err = after_publish(|_, cancel| cancel.cancel())
            .await
            .unwrap_err();
        assert_failed(err, "Permission request cancelled");
    }
}
