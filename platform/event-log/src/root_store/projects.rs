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
use serde_json::Value;
use std::collections::BTreeMap;

const MAX: u64 = maka_agent_facts::interaction::MAX_SAFE_INTEGER;

#[derive(Clone, Copy)]
struct BindingAdvance {
    id: uuid::Uuid,
    permission_epoch: u64,
    metadata_epoch: u64,
}

impl RootStore {
    pub async fn list_projects(&self) -> Result<Vec<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.control.list_projects().await
    }

    pub async fn projects_with_identity_prefix(
        &self,
        prefix: &str,
    ) -> Result<Vec<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.control.projects_with_identity_prefix(prefix).await
    }

    pub async fn get_project(&self, id: &str) -> Result<Option<ProjectRecord>, StoreError> {
        self.require_open()?;
        self.control.get_project(id).await
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

    pub async fn select_project(
        &self,
        id: &str,
        available_paths: Vec<String>,
        now: u64,
    ) -> Result<(ProjectRecord, String), StoreError> {
        self.project_writer()
            .await?
            .select_project(id, available_paths, now)
            .await
    }

    pub async fn select_project_if(
        &self,
        expected: ProjectRecord,
        available_paths: Vec<String>,
        now: u64,
    ) -> Result<(ProjectRecord, String), StoreError> {
        self.project_writer()
            .await?
            .select_project_if(expected, available_paths, now)
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
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
    ) -> Result<ProjectRelink, StoreError> {
        let (control, guard) = self
            .prepare_relink(id, owner_scope, &registration, None)
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
            )
            .await?;
        control
            .relink_project_if(guard, registration, now, selected_workspace)
            .await
    }

    async fn project_writer(&self) -> Result<EventLog, StoreError> {
        self.require_open()?;
        let mutation = self.project_mutations.clone().lock_owned().await;
        self.require_open()?;
        Ok(self.control.scoped(Arc::new(mutation)))
    }

    async fn prepare_relink(
        &self,
        id: &str,
        owner_scope: &str,
        registration: &ProjectRegistration,
        expected: Option<&ProjectRelinkGuard>,
    ) -> Result<(EventLog, ProjectRelinkGuard), StoreError> {
        if owner_scope.is_empty() {
            return Err(invalid("invalid project owner scope"));
        }
        let control = self.project_writer().await?;
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
                    Box::pin(async move {
                        Ok(
                            sqlx::query_scalar("SELECT id FROM projects WHERE identity=?")
                                .bind(identity)
                                .fetch_optional(connection)
                                .await?,
                        )
                    })
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
        // Every partition contributes its two indexed maxima. No control write
        // happens unless all counters can advance; pinned members cannot change
        // an offset or acquire a new attachment between this check and commit.
        let changes: Arc<[BindingAdvance]> = changes.into();
        for partition in &self.partitions {
            let changes = changes.clone();
            partition
                .scoped(custody.clone())
                .connection
                .read(move |connection| {
                    Box::pin(async move {
                        for change in changes.iter() {
                            crate::workspace_bindings::require_headroom(
                                connection,
                                change.id,
                                change.permission_epoch,
                                change.metadata_epoch,
                            )
                            .await?;
                        }
                        Ok(())
                    })
                })
                .await?;
        }
        self.require_open()?;
        Ok((self.control.scoped(custody), guard))
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
    control.connection.read(move |connection| Box::pin(async move {
        let mut changes = BTreeMap::new();
        for (project, relocation) in std::iter::once((source, true)).chain(absorbed.map(|project| (project, false))) {
            for project_id in std::iter::once(project.id).chain(project.aliases) {
                let mut after = String::new();
                loop {
                    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
                        "SELECT id,permission_epoch,metadata_epoch FROM workspace_bindings
                         WHERE owner_scope=? AND json_extract(workspace_json,'$.projectId')=? AND id>?
                         ORDER BY id LIMIT 32",
                    ).bind(&scope).bind(&project_id).bind(&after).fetch_all(&mut *connection).await?;
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
    })).await
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

#[cfg(test)]
mod tests;
