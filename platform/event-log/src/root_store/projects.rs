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

//! Project mutations serialize only the Root control plane. Relocation pins
//! affected bindings before inspecting independent Session revision indexes.
use super::*;
use crate::projects::{
    ProjectError, ProjectMutation, ProjectRecord, ProjectRegistration, ProjectRelink,
    ProjectRelinkGuard,
};
use crate::writeback::{Prepared, Statement};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::BTreeMap;

const MAX: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
struct BindingAdvance {
    id: uuid::Uuid,
    permission_epoch: u64,
    metadata_epoch: u64,
}

impl RootStore {
    pub async fn list_projects(&self) -> Result<Vec<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.log.list_projects().await
    }

    pub async fn projects_with_identity_prefix(
        &self,
        prefix: &str,
    ) -> Result<Vec<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.log.projects_with_identity_prefix(prefix).await
    }

    pub async fn get_project(&self, id: &str) -> Result<Option<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.log.get_project(id).await
    }

    pub async fn project_by_identity(
        &self,
        identity: &str,
    ) -> Result<Option<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.log.project_by_identity(identity).await
    }

    pub async fn register_project(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
    ) -> Result<ProjectRecord, StoreError> {
        self.project_writer()
            .await?
            .register_project(registration, prefer, now)
            .await
    }

    pub async fn register_project_if(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
        expected: Option<ProjectRecord>,
    ) -> Result<ProjectRecord, StoreError> {
        self.project_writer()
            .await?
            .register_project_if(registration, prefer, now, expected)
            .await
    }

    pub async fn register_available_project(
        &self,
        registration: ProjectRegistration,
        now: u64,
    ) -> Result<ProjectRecord, StoreError> {
        self.project_writer()
            .await?
            .register_available_project(registration, now)
            .await
    }

    pub async fn mutate_project(
        &self,
        id: &str,
        mutation: ProjectMutation,
        now: u64,
    ) -> Result<ProjectRecord, StoreError> {
        self.project_writer()
            .await?
            .mutate_project(id, mutation, now)
            .await
    }

    pub async fn mutate_project_if(
        &self,
        expected: ProjectRecord,
        mutation: ProjectMutation,
        now: u64,
    ) -> Result<ProjectRecord, StoreError> {
        self.project_writer()
            .await?
            .mutate_project_if(expected, mutation, now)
            .await
    }

    pub async fn touch_project(
        &self,
        id: &str,
        path: &str,
        now: u64,
    ) -> Result<ProjectRecord, StoreError> {
        self.project_writer()
            .await?
            .touch_project(id, path, now)
            .await
    }

    pub async fn relink_project(
        &self,
        id: &str,
        owner_scope: &str,
        fence: &WorkspaceFence,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
    ) -> Result<ProjectRelink, StoreError> {
        let (control, guard) = self
            .prepare_relink(id, owner_scope, &registration, None, fence)
            .await?;
        control
            .relink_project_if(guard, registration, now, selected_workspace)
            .await
    }

    /// Active physical execution returns Busy. Pins and the project mutation
    /// guard belong to accepted SQL until its real cleanup, even if this caller
    /// is cancelled after enqueueing the final control transaction.
    pub async fn relink_project_if(
        &self,
        guard: ProjectRelinkGuard,
        fence: &WorkspaceFence,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
    ) -> Result<ProjectRelink, StoreError> {
        let (control, guard) = self
            .prepare_relink(
                &guard.source.id,
                &guard.owner_scope,
                &registration,
                Some(&guard),
                fence,
            )
            .await?;
        control
            .relink_project_if(guard, registration, now, selected_workspace)
            .await
    }

    pub async fn prepare_register_project_if(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
        expected: Option<ProjectRecord>,
        writer: &DataWriter,
    ) -> Result<
        impl Statement<
            Value = Result<ProjectRecord, ProjectError>,
            Output = Result<ProjectRecord, ProjectError>,
        > + use<>,
        StoreError,
    > {
        self.validate_data_writer(writer)?;
        let statement = EventLog::prepare_project_registration(
            registration,
            prefer,
            now,
            expected,
            uuid::Uuid::new_v4(),
        )?;
        let control = self.project_writer().await?;
        Ok(ProjectStatement {
            statement,
            control: Arc::new(control),
        })
    }

    pub async fn prepare_mutate_project_if(
        &self,
        expected: ProjectRecord,
        mutation: ProjectMutation,
        now: u64,
        writer: &DataWriter,
    ) -> Result<
        impl Statement<
            Value = Result<ProjectRecord, ProjectError>,
            Output = Result<ProjectRecord, ProjectError>,
        > + use<>,
        StoreError,
    > {
        self.validate_data_writer(writer)?;
        let statement = EventLog::prepare_project_mutation(expected, mutation, now)?;
        let control = self.project_writer().await?;
        Ok(ProjectStatement {
            statement,
            control: Arc::new(control),
        })
    }

    pub async fn prepare_relink_project_if(
        &self,
        guard: ProjectRelinkGuard,
        fence: &WorkspaceFence,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
        writer: &DataWriter,
    ) -> Result<
        impl Statement<
            Value = Result<ProjectRelink, ProjectError>,
            Output = Result<ProjectRelink, ProjectError>,
        > + use<>,
        StoreError,
    > {
        self.validate_data_writer(writer)?;
        let (control, guard) = self
            .prepare_relink(
                &guard.source.id,
                &guard.owner_scope,
                &registration,
                Some(&guard),
                fence,
            )
            .await?;
        let statement =
            EventLog::prepare_project_relink(guard, registration, now, selected_workspace)?;
        Ok(ProjectStatement {
            statement,
            control: Arc::new(control),
        })
    }

    /// No project mutex is acquired: the final Session creation owns it once.
    pub async fn plan_available_project(
        &self,
        registration: ProjectRegistration,
        now: u64,
        writer: &DataWriter,
    ) -> Result<ProjectWorkspacePlan, StoreError> {
        self.require_open()?;
        self.validate_data_writer(writer)?;
        let control = Arc::new(writer.scoped()?);
        let expected = control.project_by_identity(&registration.identity).await?;
        if expected
            .as_ref()
            .is_some_and(|record| record.archived_at.is_some())
        {
            return Err(ProjectError::Archived.into());
        }
        let id = match &expected {
            Some(record) => uuid::Uuid::parse_str(&record.id)
                .map_err(|_| invalid("invalid stored project UUID"))?,
            None => uuid::Uuid::new_v4(),
        };
        let _validated = EventLog::prepare_available_project_registration(
            registration.clone(),
            now,
            expected.clone(),
            id,
        )?;
        Ok(ProjectWorkspacePlan {
            id,
            now,
            kind: WorkspaceProject::Register {
                registration,
                expected,
            },
            control,
        })
    }

    pub fn plan_selected_project(
        &self,
        record: ProjectRecord,
        path: String,
        now: u64,
        writer: &DataWriter,
    ) -> Result<ProjectWorkspacePlan, StoreError> {
        self.require_open()?;
        self.validate_data_writer(writer)?;
        let id = uuid::Uuid::parse_str(&record.id)
            .map_err(|_| invalid("invalid stored project UUID"))?;
        Ok(ProjectWorkspacePlan {
            id,
            now,
            kind: WorkspaceProject::Select {
                identity: record.identity,
                path,
            },
            control: Arc::new(writer.scoped()?),
        })
    }

    async fn project_writer(&self) -> Result<EventLog, StoreError> {
        self.require_open()?;
        let mutation = self.project_mutations.clone().lock_owned().await;
        self.require_open()?;
        Ok(self.log.scoped(Arc::new(mutation)))
    }

    async fn prepare_relink(
        &self,
        id: &str,
        owner_scope: &str,
        registration: &ProjectRegistration,
        expected: Option<&ProjectRelinkGuard>,
        fence: &WorkspaceFence,
    ) -> Result<(EventLog, ProjectRelinkGuard), StoreError> {
        if owner_scope.is_empty() {
            return Err(invalid("invalid project owner scope"));
        }
        fence.validate_owner(&self.log.owned_root()?)?;
        let control = self.project_writer().await?.scoped(Arc::new(fence.clone()));
        let source = control
            .get_project(id)
            .await?
            .ok_or(ProjectError::NotFound)?;
        let destination = if source.identity == registration.identity {
            Some(source.clone())
        } else {
            let identity = registration.identity.clone();
            let id: Option<String> = control
                .connection
                .read(move |connection| {
                    {
                        Ok(connection
                            .query_row(
                                "SELECT id FROM projects WHERE identity=?",
                                rusqlite::params![identity],
                                |row| row.get(0),
                            )
                            .optional()?)
                    }
                })
                .await?;
            match id {
                Some(id) => Some(
                    control
                        .get_project(&id)
                        .await?
                        .ok_or(ProjectError::NotFound)?,
                ),
                None => None,
            }
        };
        if expected.is_some_and(|expected| {
            expected.source != source || expected.destination != destination
        }) {
            return Err(ProjectError::Changed.into());
        }
        let guard = ProjectRelinkGuard {
            source,
            destination,
            owner_scope: owner_scope.to_owned(),
        };
        let changes = binding_advances(&control, &guard).await?;
        let exclusive = self
            .gates
            .try_write(changes.iter().map(|change| gates::Key::Binding(change.id)))?
            .ok_or(StoreError::SessionBusy)?;
        // The original scoped control handle retains the mutation mutex too.
        let custody: crate::connection::custody::Custody = Arc::new((exclusive, control));
        // Pinned members cannot change counters or attachments before commit.
        self.log
            .scoped(custody.clone())
            .connection
            .read(move |connection| {
                for change in &changes {
                    crate::workspace_bindings::require_headroom(
                        connection,
                        change.id,
                        change.permission_epoch,
                        change.metadata_epoch,
                    )?;
                }
                Ok(())
            })
            .await?;
        self.require_open()?;
        Ok((self.log.scoped(custody), guard))
    }
}

async fn binding_advances(
    control: &EventLog,
    guard: &ProjectRelinkGuard,
) -> Result<Vec<BindingAdvance>, StoreError> {
    let source = guard.source.clone();
    let absorbed = guard
        .destination
        .clone()
        .filter(|project| project.id != source.id);
    let scope = guard.owner_scope.clone();
    control.connection.read(move |connection| {
        let mut changes = BTreeMap::new();
        for (project, relocation) in std::iter::once((source, true)).chain(absorbed.map(|project| (project, false))) {
            for project_id in std::iter::once(project.id).chain(project.aliases) {
                let mut after = String::new();
                loop {
                    let rows: Vec<(String, i64, i64)> = connection.prepare_cached("SELECT id,permission_epoch,metadata_epoch FROM workspace_bindings
                         WHERE owner_scope=? AND json_extract(workspace_json,'$.projectId')=? AND id>?
                         ORDER BY id LIMIT 32")?.query_map(rusqlite::params![&scope, &project_id, &after], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect::<Result<Vec<_>, _>>()?;
                    if rows.is_empty() { break; }
                    for (id, permission, metadata) in rows {
                        after.clone_from(&id);
                        let id = uuid::Uuid::parse_str(&id).map_err(|_| invalid("invalid workspace binding ID"))?;
                        let change = BindingAdvance {
                            id,
                            permission_epoch: next_epoch(permission, u64::from(relocation))?,
                            metadata_epoch: next_epoch(metadata, 1)?,
                        };
                        if changes.insert(id, change).is_some() {
                            return Err(invalid("workspace binding has ambiguous project membership"));
                        }
                    }
                }
            }
        }
        Ok(changes.into_values().collect())
    }).await
}

fn next_epoch(current: i64, increment: u64) -> Result<u64, StoreError> {
    u64::try_from(current)
        .ok()
        .and_then(|current| current.checked_add(increment))
        .filter(|next| *next <= MAX)
        .ok_or_else(|| invalid("workspace epoch exhausted"))
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

/// Immutable Project candidate for the final Root Session transaction. The
/// final transaction checks that the candidate is still valid for attachment.
pub struct ProjectWorkspacePlan {
    id: uuid::Uuid,
    now: u64,
    kind: WorkspaceProject,
    control: Arc<EventLog>,
}
enum WorkspaceProject {
    Register {
        registration: ProjectRegistration,
        expected: Option<ProjectRecord>,
    },
    Select {
        identity: String,
        path: String,
    },
}
impl ProjectWorkspacePlan {
    pub fn project_id(&self) -> uuid::Uuid {
        self.id
    }
}
impl Statement for ProjectWorkspacePlan {
    type Value = Result<ProjectRecord, ProjectError>;
    type Output = Self::Value;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![self.control.clone()]
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.control.connection.require_same_writer(connection)?;
        self.control.owned_root()?;
        match self.kind {
            WorkspaceProject::Register {
                registration,
                expected,
            } => EventLog::prepare_available_project_registration(
                registration,
                self.now,
                expected,
                self.id,
            )?
            .execute(connection),
            WorkspaceProject::Select { identity, path } => {
                EventLog::prepare_project_selection(self.id, identity, path, self.now)?
                    .execute(connection)
            }
        }
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

struct ProjectStatement<S> {
    statement: S,
    control: Arc<EventLog>,
}
impl<S: Statement> Statement for ProjectStatement<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.statement.retain();
        retained.push(self.control.clone());
        retained
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            statement: self.statement.prepare()?,
            ..self
        })
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.control.connection.require_same_writer(connection)?;
        self.control.owned_root()?;
        self.statement.execute(connection)
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
    }
}
