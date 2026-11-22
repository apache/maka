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
pub struct CheckpointPublisher {
    store: Arc<RootStore>,
    scope: Scope,
    prefix: String,
}

#[derive(Clone)]
pub struct Capture {
    pub session_id: String,
    pub expected_checkpoint_revision: Option<Revision>,
    pub confirmed_subtree_digest: String,
    pub workspace: Option<maka_event_log::checkpoints::WorkspaceCapture>,
}

struct CreateRequestFile;
impl maka_event_log::connection::Query for CreateRequestFile {
    type Output = std::fs::File;

    fn execute(self, _: &rusqlite::Connection) -> Result<Self::Output, StoreError> {
        Ok(maka_event_log::root_store::create_request_file()?)
    }
}

impl CheckpointPublisher {
    /// Called by trusted native assembly, never with model-authored scope.
    pub fn new(store: Arc<RootStore>, scope: Scope) -> Self {
        let prefix = maka_agent_authority::session_namespace(
            &scope.state_domain,
            scope.deployment,
            &scope.namespace,
        );
        Self {
            store,
            scope,
            prefix,
        }
    }

    pub(crate) async fn repository(&self, session: &str) -> Result<HistoryCheckpoints, StoreError> {
        if !crate::owner::owns_session(&self.prefix, session) {
            return Err(StoreError::SessionNotFound);
        }
        self.store
            .history_checkpoints(session, self.scope.clone())
            .await
    }

    pub(crate) async fn request_file(&self, session: &str) -> Result<std::fs::File, StoreError> {
        self.repository(session).await?;
        self.store.data_writer()?.query(CreateRequestFile).await
    }

    pub(crate) fn request(
        &self,
        capture: &Capture,
        operation: &RecoveryRef,
        history: &maka_event_log::checkpoints::HistorySnapshot,
    ) -> Result<PublicationRequest, StoreError> {
        self.validate_operation(capture, operation)?;
        use sha2::Digest;
        Ok(PublicationRequest {
            operation: operation.operation,
            fingerprint: hex::encode(sha2::Sha256::digest(serde_json::to_vec(operation)?)),
            expected_revision: capture.expected_checkpoint_revision,
            confirmed_subtree_digest: capture.confirmed_subtree_digest.clone(),
            history: history.clone(),
            workspace: capture.workspace.clone(),
        })
    }

    pub(crate) fn validate_request(
        &self,
        capture: &Capture,
        operation: &RecoveryRef,
    ) -> Result<(), StoreError> {
        if !crate::owner::owns_session(&self.prefix, &capture.session_id) {
            return Err(StoreError::SessionNotFound);
        }
        self.validate_operation(capture, operation)
    }

    pub(crate) fn load_request(
        &self,
        input: &maka_agent_api::contract::HistoryCheckpointRead,
        operation: &RecoveryRef,
    ) -> Result<maka_event_log::checkpoints::LoadOperation, StoreError> {
        operation
            .validate()
            .map_err(|e| StoreError::InvalidTransition(e.to_string()))?;
        if !crate::owner::owns_session(&self.prefix, &input.session_id)
            || operation.source.state_domain != self.scope.state_domain
            || operation.source.deployment != self.scope.deployment
            || operation.namespace != self.scope.namespace
            || operation.export != maka_agent_api::EXPORT
            || operation.method != "loadHistoryCheckpoint"
        {
            return Err(StoreError::InvalidTransition(
                "checkpoint load belongs to another authority".into(),
            ));
        }
        use sha2::Digest;
        Ok(maka_event_log::checkpoints::LoadOperation {
            operation: operation.operation,
            fingerprint: hex::encode(sha2::Sha256::digest(serde_json::to_vec(operation)?)),
            revision: Revision(input.revision),
        })
    }

    fn validate_operation(
        &self,
        capture: &Capture,
        operation: &RecoveryRef,
    ) -> Result<(), StoreError> {
        operation
            .validate()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        if operation.source.state_domain != self.scope.state_domain
            || operation.source.deployment != self.scope.deployment
            || operation.namespace != self.scope.namespace
            || operation.export != maka_agent_api::EXPORT
            || operation.method != "publishCheckpoint"
            || !crate::owner::owns_session(&self.prefix, &capture.session_id)
        {
            return Err(StoreError::InvalidTransition(
                "checkpoint operation belongs to another authority".into(),
            ));
        }
        Ok(())
    }

    pub async fn publish(
        &self,
        capture: Capture,
        operation: &RecoveryRef,
        material: maka_agent_state::session_history::snapshot::ExportedSnapshot,
        fence: Option<&maka_event_log::root_store::WorkspaceFence>,
    ) -> Result<Publication, StoreError> {
        self.validate_request(&capture, operation)?;
        let request = self.request(&capture, operation, &material.history)?;
        let repository = self.repository(&capture.session_id).await?;
        let request = repository
            .original_request(request.clone())
            .await?
            .unwrap_or(request);
        match fence {
            Some(fence) => {
                repository
                    .publish_fenced(request, material.file, fence)
                    .await
            }
            None => repository.publish(request, material.file).await,
        }
    }

    pub async fn receipt(
        &self,
        capture: Capture,
        operation: &RecoveryRef,
        history: &maka_event_log::checkpoints::HistorySnapshot,
    ) -> Result<Option<Publication>, StoreError> {
        self.validate_request(&capture, operation)?;
        let request = self.request(&capture, operation, history)?;
        let repository = self.repository(&capture.session_id).await?;
        match repository.original_request(request).await? {
            Some(original) => repository.receipt(original).await,
            None => Ok(None),
        }
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
