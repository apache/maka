/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
use super::super::*;
use crate::{
    sessions::metadata::MetadataChange,
    writeback::{Notification, Prepared, Statement},
};

impl RootStore {
    pub async fn prepare_session_metadata<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(SessionRecord<T>, DataChange), StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        let statement = self
            .session_metadata_statement(id, expected, update, writer, statement)
            .await?;
        Ok((statement.change.record.clone(), writer.prepare(statement)))
    }

    pub async fn write_session_metadata_with<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<S::Output, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        let statement = self
            .session_metadata_statement(id, expected, update, writer, statement)
            .await?;
        writer.write(statement).await
    }

    async fn session_metadata_statement<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<SessionMetadataChange<T, S>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        if !self.data_writer()?.same_root(writer) {
            return Err(StoreError::InvalidTransition(
                "foreign Root data writer".into(),
            ));
        }
        let selected = self.session(id).await?;
        let (custody, change) = selected.metadata_change(id, expected, update).await?;
        Ok(SessionMetadataChange {
            change,
            statement,
            custody: Arc::new(custody),
        })
    }
}
struct SessionMetadataChange<T, S> {
    change: MetadataChange<T>,
    statement: S,
    custody: Arc<EventLog>,
}
impl<T: Send + 'static, S: Statement> Statement for SessionMetadataChange<T, S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut inputs = self.statement.retain();
        inputs.push(self.custody.clone());
        inputs
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.change.validate(connection)?;
        let (record, changed) = self.change.apply(connection)?;
        let domain = self.statement.execute(connection)?;
        let root = if changed {
            Notification::METADATA.with_sessions([record.id])
        } else {
            Notification::NONE
        };
        Ok(Prepared {
            value: domain.value,
            changed: changed || domain.changed,
            notification: domain.notification.combine(root),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error,
                StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionBusy
                    | StoreError::SessionRevisionConflict { .. }
                    | StoreError::InvalidTransition(_)
            )
    }
}

impl RootStore {
    pub async fn prepare_session_workspace_change<S, G>(
        &self,
        id: &str,
        expected: u64,
        workspace: S,
        guard: G,
        writer: &DataWriter,
    ) -> Result<DataChange, StoreError>
    where
        S: Statement<Value = maka_sandbox::workspace::BindingRef>,
        G: Statement,
    {
        self.validate_data_writer(writer)?;
        let revision = self.session(id).await?.revision_guard(writer, expected)?;
        // Shared Session pins protect the attachment until a reader has pinned
        // its binding. Changing the reference needs both exclusive gates.
        let pins = self
            .gates
            .try_write([
                gates::Key::Session(id.to_owned()),
                gates::Key::Work(id.to_owned()),
            ])?
            .ok_or(StoreError::SessionBusy)?;
        Ok(writer.prepare(SessionWorkspaceChange {
            custody: Arc::new(self.log.scoped(Arc::new(pins))),
            revision,
            workspace,
            guard,
        }))
    }
}

struct SessionWorkspaceChange<S, G> {
    custody: Arc<EventLog>,
    revision: SessionRevisionGuard,
    workspace: S,
    guard: G,
}

impl<S, G> Statement for SessionWorkspaceChange<S, G>
where
    S: Statement<Value = maka_sandbox::workspace::BindingRef>,
    G: Statement,
{
    type Value = G::Value;
    type Output = G::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD || G::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.workspace.retain();
        retained.extend(self.guard.retain());
        retained.push(self.custody.clone());
        retained
    }

    fn prepare(mut self) -> Result<Self, StoreError> {
        self.workspace = self.workspace.prepare()?;
        self.guard = self.guard.prepare()?;
        Ok(self)
    }

    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.revision.validate(connection)?;
        let guard = self.guard.execute(connection)?;
        let workspace = self.workspace.execute(connection)?;
        let id = self.revision.session_id();
        let change = crate::sessions::metadata::preview_metadata(
            connection,
            id,
            self.revision.expected,
            false,
            |configuration: &mut serde_json::Value| {
                let binding = serde_json::to_value(workspace.value)?;
                if configuration["workspace"] != binding {
                    let boundary = configuration["boundary_revision"]
                        .as_u64()
                        .and_then(|revision| revision.checked_add(1))
                        .filter(|revision| *revision <= 9_007_199_254_740_991)
                        .ok_or_else(|| {
                            StoreError::InvalidTransition(
                                "invalid permission boundary revision".into(),
                            )
                        })?;
                    configuration["workspace"] = binding;
                    configuration["boundary_revision"] = boundary.into();
                }
                Ok(())
            },
        )?;
        let (_, changed) = change.apply(connection)?;
        let notification = if changed {
            Notification::METADATA.with_sessions([id.to_owned()])
        } else {
            Notification::NONE
        };
        Ok(Prepared {
            value: guard.value,
            changed: changed || workspace.changed || guard.changed,
            notification: notification
                .combine(workspace.notification)
                .combine(guard.notification),
        })
    }

    fn committed(value: Self::Value) -> Self::Output {
        G::committed(value)
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || G::isolated_rejection(error)
            || matches!(
                error.underlying(),
                StoreError::SessionRevisionConflict { .. }
                    | StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionBusy
            )
    }
}
