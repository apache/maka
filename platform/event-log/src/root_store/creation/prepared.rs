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
use crate::workspace_bindings::{WorkspaceBinding, WriteAttachment};
use crate::writeback::{Notification, Prepared, Statement};
use maka_sandbox::workspace::BindingRef;

impl RootStore {
    /// Capture data candidates only. A new binding is not published or usable
    /// authority until this statement validates it in the final transaction.
    pub async fn prepare_creation_workspace<W: Serialize>(
        &self,
        owner_scope: &str,
        workspace: &W,
        project: Option<crate::root_store::ProjectWorkspacePlan>,
        writer: &DataWriter,
    ) -> Result<
        (
            WorkspaceBinding,
            impl Statement<Value = BindingRef, Output = BindingRef> + use<W>,
        ),
        StoreError,
    > {
        self.capture_creation_workspace(owner_scope, workspace, project, writer)
            .await
    }

    async fn capture_creation_workspace<W: Serialize>(
        &self,
        owner_scope: &str,
        workspace: &W,
        project: Option<crate::root_store::ProjectWorkspacePlan>,
        writer: &DataWriter,
    ) -> Result<(WorkspaceBinding, CreationWorkspace), StoreError> {
        self.require_open()?;
        self.validate_data_writer(writer)?;
        let mutation = self.project_mutations.clone().lock_owned().await;
        self.require_open()?;
        let attachment = WriteAttachment::new(owner_scope, serde_json::to_value(workspace)?)?;
        let (attachment, candidate, existing) = self
            .log
            .connection
            .read(move |connection| {
                let (candidate, existing) = attachment.candidate(connection)?;
                Ok((attachment, candidate, existing))
            })
            .await?;
        let custody = Arc::new(self.log.scoped(Arc::new(mutation)));
        let statement = CreationWorkspace {
            attachment,
            expected: candidate.reference(),
            existing,
            project,
            custody,
        };
        Ok((candidate, statement))
    }

    /// Ordinary creation keeps its original semantics, without plugin origin.
    pub async fn prepare_session_creation<W, F>(
        &self,
        request: SessionCreationRequest<'_, W>,
        writer: &DataWriter,
        configuration: F,
    ) -> Result<impl Statement<Value = SessionRecord, Output = SessionRecord> + use<W, F>, StoreError>
    where
        W: Serialize,
        F: FnOnce(BindingRef) -> Result<Value, StoreError> + Send + 'static,
    {
        self.require_open()?;
        self.validate_data_writer(writer)?;
        let SessionCreationRequest {
            id,
            fingerprint,
            owner_scope,
            workspace,
            project,
            now,
        } = request;
        crate::sessions::validate_id(id)?;
        crate::sessions::validate_time(now)?;
        if fingerprint.is_empty() {
            return Err(StoreError::InvalidTransition(
                "invalid session fingerprint".into(),
            ));
        }
        let (candidate, workspace) = self
            .capture_creation_workspace(owner_scope, workspace, project, writer)
            .await?;
        let creation = self
            .gates
            .write([gates::Key::Creation(id.to_owned())])
            .await?;
        let additional = if workspace.existing {
            vec![candidate.reference()]
        } else {
            Vec::new()
        };
        let custody = Arc::new(
            pin_sessions(self.log.clone(), &self.gates, &[id.to_owned()], &additional)
                .await?
                .scoped(Arc::new(creation)),
        );
        Ok(SessionCreation {
            id: id.into(),
            fingerprint: fingerprint.into(),
            now,
            workspace,
            configuration,
            custody,
        })
    }
}

struct CreationWorkspace {
    attachment: WriteAttachment,
    expected: BindingRef,
    existing: bool,
    project: Option<crate::root_store::ProjectWorkspacePlan>,
    custody: Arc<EventLog>,
}
impl Statement for CreationWorkspace {
    type Value = BindingRef;
    type Output = BindingRef;
    const PREPARE_OFF_THREAD: bool = crate::root_store::ProjectWorkspacePlan::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained: Vec<Arc<dyn Send + Sync>> = vec![self.custody.clone()];
        if let Some(project) = &self.project {
            retained.extend(project.retain());
        }
        retained
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.project = self.project.map(Statement::prepare).transpose()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<BindingRef>, StoreError> {
        self.custody.connection.require_same_writer(connection)?;
        let (project_changed, project_notification) = if let Some(project) = self.project {
            let expected = project.project_id().to_string();
            let project = project.execute(connection)?;
            let record = project
                .value
                .map_err(|error| StoreError::StatementRejected {
                    diagnostic: error.to_string(),
                    cause: Arc::new(StoreError::Project(error)),
                })?;
            if record.id != expected {
                return Err(rejected_binding("prepared project identity changed"));
            }
            (project.changed, project.notification)
        } else {
            (false, Notification::NONE)
        };
        let attachment = self.attachment.execute(connection)?;
        if attachment.value != self.expected {
            return Err(rejected_binding("prepared workspace binding changed"));
        }
        Ok(Prepared {
            value: attachment.value,
            changed: project_changed || attachment.changed,
            notification: project_notification.combine(attachment.notification),
        })
    }
    fn committed(value: BindingRef) -> BindingRef {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error.underlying(), StoreError::StatementRejected { .. })
    }
}
fn rejected_binding(diagnostic: &str) -> StoreError {
    StoreError::StatementRejected {
        diagnostic: diagnostic.into(),
        cause: Arc::new(StoreError::InvalidTransition(diagnostic.into())),
    }
}

struct SessionCreation<F> {
    id: String,
    fingerprint: String,
    now: u64,
    workspace: CreationWorkspace,
    configuration: F,
    custody: Arc<EventLog>,
}
impl<F> Statement for SessionCreation<F>
where
    F: FnOnce(BindingRef) -> Result<Value, StoreError> + Send + 'static,
{
    type Value = SessionRecord;
    type Output = SessionRecord;
    const PREPARE_OFF_THREAD: bool = CreationWorkspace::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.workspace.retain();
        retained.push(self.custody.clone());
        retained
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.workspace = self.workspace.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<SessionRecord>, StoreError> {
        self.custody.connection.require_same_writer(connection)?;
        let workspace = self.workspace.execute(connection)?;
        let configuration = (self.configuration)(workspace.value)?;
        validate_configuration(&configuration)?;
        let creation = WriteCreation {
            id: self.id.clone(),
            fingerprint: self.fingerprint,
            configuration,
            now: self.now,
        }
        .execute(connection)?;
        let record = crate::sessions::read(connection, &self.id)?.ok_or(
            StoreError::SessionCreationRejected(CreationRejection::Retired),
        )?;
        Ok(Prepared {
            value: record,
            changed: workspace.changed || creation.changed,
            notification: workspace
                .notification
                .combine(creation.notification)
                .combine(Notification::METADATA.with_sessions([self.id])),
        })
    }
    fn committed(value: SessionRecord) -> SessionRecord {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        CreationWorkspace::isolated_rejection(error) || WriteCreation::isolated_rejection(error)
    }
}
