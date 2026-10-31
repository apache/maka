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

//! Trusted internal publication coordinator. No wire method or model tool is
//! registered here; the service adapter must supply original Host admission.
use maka_event_log::{
    RootStore, StoreError,
    checkpoints::{Head, Publication, PublicationRequest, Revision, Scope},
    root_store::{Checkout, HistoryCheckpoints},
};
use maka_plugin_core::operation::RecoveryRef;
use std::sync::Arc;

#[derive(Clone)]
pub struct HistoryCheckpointPublisher {
    store: Arc<RootStore>,
    scope: Scope,
    prefix: String,
}

#[derive(Clone)]
pub struct Capture {
    pub session_id: String,
    pub expected_checkpoint_revision: Option<Revision>,
    pub confirmed_subtree_digest: String,
}

impl HistoryCheckpointPublisher {
    /// Called by trusted native assembly, never with model-authored scope.
    pub fn new(store: Arc<RootStore>, scope: Scope, coordinator: bool) -> Self {
        let prefix = maka_agent_authority::session_namespace(
            &scope.state_domain,
            scope.deployment,
            &scope.namespace,
            coordinator,
        );
        Self {
            store,
            scope,
            prefix,
        }
    }

    async fn repository(&self, session: &str) -> Result<HistoryCheckpoints, StoreError> {
        if !crate::owner::owns_session(&self.prefix, session) {
            return Err(StoreError::SessionNotFound);
        }
        self.store
            .history_checkpoints(session, self.scope.clone())
            .await
    }

    fn request(
        &self,
        capture: &Capture,
        operation: &RecoveryRef,
    ) -> Result<PublicationRequest, StoreError> {
        operation
            .validate()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        if operation.source.state_domain != self.scope.state_domain
            || operation.source.deployment != self.scope.deployment
            || operation.namespace != self.scope.namespace
            || operation.export != maka_agent_api::EXPORT
            || operation.method != "publishHistoryCheckpoint"
        {
            return Err(StoreError::InvalidTransition(
                "checkpoint operation belongs to another authority".into(),
            ));
        }
        use sha2::Digest;
        Ok(PublicationRequest {
            operation: operation.operation,
            fingerprint: hex::encode(sha2::Sha256::digest(serde_json::to_vec(operation)?)),
            expected_revision: capture.expected_checkpoint_revision,
            confirmed_subtree_digest: capture.confirmed_subtree_digest.clone(),
        })
    }

    pub async fn publish(
        &self,
        capture: Capture,
        operation: &RecoveryRef,
    ) -> Result<Publication, StoreError> {
        let request = self.request(&capture, operation)?;
        self.repository(&capture.session_id)
            .await?
            .publish(request)
            .await
    }

    pub async fn receipt(
        &self,
        capture: Capture,
        operation: &RecoveryRef,
    ) -> Result<Option<Publication>, StoreError> {
        let request = self.request(&capture, operation)?;
        self.repository(&capture.session_id)
            .await?
            .receipt(request)
            .await
    }

    pub async fn read_head(&self, session: &str) -> Result<Option<Head>, StoreError> {
        self.repository(session).await?.read_head().await
    }

    pub async fn checkout_exact(
        &self,
        session: &str,
        revision: Revision,
    ) -> Result<Checkout, StoreError> {
        self.repository(session)
            .await?
            .checkout_exact(revision)
            .await
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use maka_plugin_core::{
        composition::InstanceId,
        contract::Transport,
        deployment::DeploymentRef,
        operation::{RecoveryContract, RecoveryProtocol},
    };
    use uuid::Uuid;

    #[tokio::test]
    async fn trusted_publisher_uses_original_operation_and_enforces_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let root = Arc::new(
            maka_event_log::root::RootOwner::create(
                &directory.path().join("root"),
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(root).await.unwrap());
        let scope = Scope {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(1),
            namespace: InstanceId(vec![Uuid::from_u128(2)]),
        };
        let publisher = HistoryCheckpointPublisher::new(store.clone(), scope.clone(), false);
        let id = format!("{}{}", publisher.prefix, "1".repeat(32));
        store
            .create_session(&id, "create", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let input = Capture {
            session_id: id.clone(),
            expected_checkpoint_revision: None,
            confirmed_subtree_digest: store.preview_bundle(&id).await.unwrap().subtree_digest,
        };
        let operation = RecoveryRef {
            source: DeploymentRef {
                state_domain: scope.state_domain,
                deployment: scope.deployment,
                revision: 1,
            },
            namespace: scope.namespace,
            export: maka_agent_api::EXPORT.into(),
            method: "publishHistoryCheckpoint".into(),
            operation: Uuid::from_u128(3),
            fingerprint: format!("sha256-{}", "b".repeat(64)),
            contract: RecoveryContract {
                name: "agent".into(),
                version: 1,
                transport: Transport::Local,
                digest: format!("sha256-{}", "c".repeat(64)),
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        let value = publisher.publish(input.clone(), &operation).await.unwrap();
        assert!(matches!(
            value.state,
            maka_event_log::checkpoints::PublicationState::Published { .. }
        ));
        assert_eq!(
            publisher.publish(input.clone(), &operation).await.unwrap(),
            value
        );
        assert_eq!(
            publisher.receipt(input.clone(), &operation).await.unwrap(),
            Some(value)
        );
        let mut foreign = operation.clone();
        foreign.namespace.0.push(Uuid::from_u128(4));
        assert!(publisher.publish(input.clone(), &foreign).await.is_err());
        let mut conflicting = operation;
        conflicting.fingerprint = format!("sha256-{}", "d".repeat(64));
        assert!(publisher.publish(input, &conflicting).await.is_err());
        assert!(publisher.read_head("unowned").await.is_err());
        drop(publisher);
        Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    }
}
