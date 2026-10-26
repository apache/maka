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

//! Cross-partition immutable attachment copy with bounded streaming custody.
use super::*;
use maka_agent_facts::attachment::{AttachmentRef, StorageRef};
use maka_agent_ports::execution::CopyAttachment;
use maka_capabilities::storage::Namespace;

impl RootStore {
    pub async fn copy_plugin_attachment(
        &self,
        namespace: &Namespace,
        request: CopyAttachment,
    ) -> Result<AttachmentRef, StoreError> {
        self.copy_attachment(namespace, request, None).await
    }

    /// Reuse the target's actual physical execution instead of re-entering its
    /// binding admission. Serialized Session identities cannot supply custody.
    pub async fn copy_plugin_attachment_to_execution(
        &self,
        target: &SessionStore,
        namespace: &Namespace,
        request: CopyAttachment,
    ) -> Result<AttachmentRef, StoreError> {
        self.copy_attachment(namespace, request, Some(target)).await
    }

    /// Read a source attachment while retaining an existing target execution's
    /// binding pin. This returns data, never a foreign Session capability.
    pub async fn execution_attachment(
        &self,
        target: &SessionStore,
        source_session: &str,
        artifact: &str,
    ) -> Result<crate::artifacts::ArtifactEntry, StoreError> {
        self.require_open()?;
        let (source, _, _) = self
            .pin_session_pair(source_session, target.id(), Some(target))
            .await?;
        source.get_artifact(source_session, artifact).await
    }

    async fn copy_attachment(
        &self,
        namespace: &Namespace,
        request: CopyAttachment,
        execution: Option<&SessionStore>,
    ) -> Result<AttachmentRef, StoreError> {
        self.require_open()?;
        request
            .validate()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        let StorageRef::SessionFile { session_id, .. } = &request.attachment.storage_ref else {
            return Err(StoreError::InvalidTransition(
                "Attachment source is not a Session Artifact".into(),
            ));
        };
        let (source, target, same_partition) = self
            .pin_session_pair(session_id, &request.target_session_id, execution)
            .await?;
        if same_partition {
            target.copy_plugin_attachment(namespace, request).await
        } else {
            target
                .copy_attachment_from_partition(source, namespace, request)
                .await
        }
    }

    pub(super) async fn pin_session_pair(
        &self,
        session_id: &str,
        target_session: &str,
        execution: Option<&SessionStore>,
    ) -> Result<(EventLog, EventLog, bool), StoreError> {
        let execution_custody = if let Some(target) = execution {
            if !Arc::ptr_eq(&self.gates, &target.gates) {
                return Err(StoreError::InvalidTransition(
                    "foreign Root execution custody".into(),
                ));
            }
            target.check_session(target_session)?;
            target.owner()?;
            Some(
                target
                    .execution
                    .as_ref()
                    .ok_or_else(|| {
                        StoreError::InvalidTransition("Session has no active execution".into())
                    })?
                    .custody()?,
            )
        } else {
            None
        };
        let source = self.session(session_id).await?.owner()?;
        let target = self.session(target_session).await?.owner()?;
        let sessions = Arc::new(
            self.gates
                .read([
                    gates::Key::Session(session_id.to_owned()),
                    gates::Key::Session(target_session.to_owned()),
                ])
                .await?,
        );
        let mut bindings = Vec::new();
        let mut target_binding = None;
        for (owner, session) in [
            (&source, session_id.to_owned()),
            (&target, target_session.to_owned()),
        ] {
            let is_target = session == target_session;
            let binding = owner
                .scoped(Arc::new((sessions.clone(), execution_custody.clone())))
                .connection
                .read(move |connection| {
                    Box::pin(async move {
                        let configuration: Option<String> = sqlx::query_scalar(
                            "SELECT configuration FROM session_control WHERE id=?",
                        )
                        .bind(session)
                        .fetch_optional(connection)
                        .await?;
                        crate::workspace_bindings::attached(&serde_json::from_str(
                            &configuration.ok_or(StoreError::SessionNotFound)?,
                        )?)
                    })
                })
                .await?;
            if is_target {
                target_binding = binding.as_ref().map(|binding| binding.id);
            }
            bindings.extend(binding.map(|binding| binding.id));
        }
        // The captured Work guard keeps this target attachment stable. A source
        // on the same binding is covered by that exact original binding guard.
        let bindings = self
            .gates
            .read(
                bindings
                    .into_iter()
                    .filter(|id| execution_custody.is_none() || Some(*id) != target_binding)
                    .map(gates::Key::Binding),
            )
            .await?;
        let custody: crate::connection::custody::Custody =
            Arc::new((sessions, bindings, execution_custody));
        self.require_open()?;
        let same_partition = Arc::ptr_eq(&source, &target);
        Ok((
            source.scoped(custody.clone()),
            target.scoped(custody),
            same_partition,
        ))
    }
}

#[cfg(test)]
mod tests;
