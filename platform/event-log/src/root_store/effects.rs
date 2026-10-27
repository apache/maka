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

//! Selected Session custody for a one-shot Host browser lease-child service.
use super::{EventLog, SessionStore, StoreError};
use crate::effects::{Outcome, Record, Request, browser_lease_session};
use maka_capabilities::storage::Namespace;
use uuid::Uuid;

/// Original durable T1 with the accepted Session's existing SQL lifetime pin.
/// Dropping it cannot record success; exclusive recovery keeps an unknown outcome.
#[must_use = "an admitted browser service must retain its original receipt through settlement"]
pub struct BrowserLeaseChildReceipt {
    log: EventLog,
    id: Uuid,
}
impl std::fmt::Debug for BrowserLeaseChildReceipt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserLeaseChildReceipt")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
impl BrowserLeaseChildReceipt {
    /// Actual durable Host effect identity created at admission.
    pub fn id(&self) -> Uuid {
        self.id
    }
    /// Record one actual service outcome on the same admitted Session writer.
    ///
    /// # Errors
    /// Returns storage/commit errors, including conflict with an already settled
    /// or recovery-marked unknown outcome. No effect or settlement is replayed.
    pub async fn settle(self, outcome: Outcome) -> Result<(), StoreError> {
        self.log.settle_host_effect(self.id, outcome, None).await
    }
}
impl SessionStore {
    /// Durably admit a browser source-lease child service before its first effect.
    /// Observation fields grant no permission; the Host checks the live lease.
    ///
    /// # Errors
    /// Rejects another Session, wrong source/owner/operation/boundary, retired
    /// Session custody, and unconfirmed durable admission.
    pub async fn begin_browser_lease_child(
        &self,
        request: Request,
    ) -> Result<BrowserLeaseChildReceipt, StoreError> {
        self.check_session(browser_lease_session(&request)?)?;
        let log = self.scoped().await?;
        let id = log.begin_host_effect(request).await?;
        Ok(BrowserLeaseChildReceipt { log, id })
    }

    /// Read this selected Session's original browser service receipt only.
    ///
    /// # Errors
    /// Returns storage errors or rejects a foreign/non-browser receipt even if
    /// it shares the same package namespace or physical writer partition.
    pub async fn browser_lease_child_effect(
        &self,
        namespace: Namespace,
        id: Uuid,
    ) -> Result<Option<Record>, StoreError> {
        let log = self.scoped().await?;
        let Some(record) = log.host_effect(namespace, id).await? else {
            return Ok(None);
        };
        self.check_session(browser_lease_session(&record.request)?)?;
        Ok(Some(record))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RootStore,
        effects::{NativeOwner, Operation, Owner},
        root::{RootNamespaces, RootOwner},
    };
    use maka_agent_facts::execution::{
        ApprovalPolicy, SandboxMode, WorkspaceIdentity, WorkspaceOrigin,
    };
    use maka_capabilities::{
        authorization::{Boundary, SessionBoundary},
        call::Identity,
    };
    use maka_plugin_core::{composition::Input, deployment::DeploymentRef, scope::Scope};
    use serde_json::json;
    use std::{collections::BTreeMap, sync::Arc, time::Duration};

    async fn fixture() -> (tempfile::TempDir, RootStore, SessionStore, DeploymentRef) {
        let directory = tempfile::tempdir().unwrap();
        let root = RootStore::open(Arc::new(
            RootOwner::create(
                &directory.path().join("root"),
                &RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        ))
        .await
        .unwrap();
        let source = root
            .commit_application(
                Uuid::new_v4(),
                0,
                Input {
                    instances: BTreeMap::new(),
                },
                Vec::new(),
                Vec::new(),
            )
            .await
            .unwrap();
        let session = root
            .create_session("browser-session", "browser-session", &json!({}), 1)
            .await
            .unwrap();
        (directory, root, session, source)
    }

    fn request(session: &str, source: &DeploymentRef) -> Request {
        Request {
            source: Identity::BrowserLease {
                session_id: session.into(),
                turn_id: "current-turn".into(),
            },
            owner: Owner::Native(NativeOwner {
                package_id: "fixture.browser".into(),
                entry_id: "native-entry".into(),
                scope: Scope::Profile,
                source: source.clone(),
                epoch: Uuid::new_v4(),
            }),
            boundary: Boundary::Session {
                boundary: SessionBoundary {
                    workspace_origin: WorkspaceOrigin::Selected,
                    session_id: session.into(),
                    boundary_revision: 0,
                    sandbox_mode: SandboxMode::ReadOnly,
                    approval_policy: ApprovalPolicy::OnRequest,
                    cwd: "/task-owned-browser-fixture".into(),
                },
                workspace_identity: WorkspaceIdentity::from_marker_id(
                    "3da1ec9d-9280-4db2-8aa6-fcb0f5cf62a1",
                )
                .unwrap(),
            },
            operation: Operation::BrowserLeaseChild {
                browser_id: "browser".into(),
                generation: "generation".into(),
                opener_claim_id: "actual-captured-claim-fixture".into(),
                opener_tab_id: 17,
                url: "https://example.test/child".into(),
            },
        }
    }
    fn namespace() -> Namespace {
        Namespace::new("fixture.browser", Scope::Profile).unwrap()
    }

    #[tokio::test]
    async fn browser_service_t1_is_readable_before_effect_and_settles_only_once() {
        let (_directory, root, session, source) = fixture().await;
        let receipt = session
            .begin_browser_lease_child(request(session.id(), &source))
            .await
            .unwrap();
        let id = receipt.id();
        let observed = session
            .browser_lease_child_effect(namespace(), id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            observed.outcome.is_none(),
            "durable T1 must precede service dispatch"
        );
        assert!(
            matches!(observed.request.source, Identity::BrowserLease { ref session_id, ref turn_id }
            if session_id == session.id() && turn_id == "current-turn")
        );
        assert!(
            matches!(
                root.recover_host_effects().await,
                Err(StoreError::SessionBusy)
            ),
            "the admitted receipt must retain the real selected Session SQL pin"
        );
        receipt
            .settle(Outcome::Completed {
                value: json!({"serviceResult":"recorded"}),
            })
            .await
            .unwrap();
        let observed = session
            .browser_lease_child_effect(namespace(), id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            observed.outcome,
            Some(Outcome::Completed {
                value: json!({"serviceResult":"recorded"})
            })
        );
        let log = session.scoped().await.unwrap();
        assert!(matches!(
            log.settle_host_effect(
                id,
                Outcome::Failed {
                    message: "duplicate late settlement".into()
                },
                None
            )
            .await,
            Err(StoreError::EventConflict)
        ));
        drop(log);
        root.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn actual_root_recovery_fences_a_late_browser_service_outcome() {
        let (_directory, root, session, source) = fixture().await;
        let receipt = session
            .begin_browser_lease_child(request(session.id(), &source))
            .await
            .unwrap();
        let id = receipt.id();
        drop(receipt); // Lost service custody records no successful T2.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match root.recover_host_effects().await {
                    Err(StoreError::SessionBusy) => tokio::task::yield_now().await,
                    result => break result.unwrap(),
                }
            }
        })
        .await
        .unwrap();
        let observed = session
            .browser_lease_child_effect(namespace(), id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(observed.outcome, Some(Outcome::Unknown { .. })));
        let log = session.scoped().await.unwrap();
        assert!(
            matches!(
                log.settle_host_effect(id, Outcome::Completed { value: json!(true) }, None)
                    .await,
                Err(StoreError::EventConflict)
            ),
            "late success must not overwrite real recovery Unknown"
        );
        drop(log);
        root.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn browser_service_rejects_foreign_session_boundary_and_unbound_log() {
        let (_directory, root, session, source) = fixture().await;
        let other = root
            .create_session("other-session", "other-session", &json!({}), 1)
            .await
            .unwrap();
        assert!(matches!(
            other
                .begin_browser_lease_child(request(session.id(), &source))
                .await,
            Err(StoreError::InvalidTransition(_))
        ));
        let mut foreign_boundary = request(session.id(), &source);
        if let Boundary::Session { boundary, .. } = &mut foreign_boundary.boundary {
            boundary.session_id = other.id().into();
        }
        assert!(matches!(
            session.begin_browser_lease_child(foreign_boundary).await,
            Err(StoreError::InvalidTransition(_))
        ));
        let unbound = session.owner().unwrap();
        assert!(
            matches!(
                unbound
                    .begin_host_effect(request(session.id(), &source))
                    .await,
                Err(StoreError::InvalidTransition(_))
            ),
            "browser service must not bypass the selected Session gateway"
        );
        root.shutdown().await.unwrap();
    }
}
