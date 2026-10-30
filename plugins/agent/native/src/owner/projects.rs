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
use crate::contract::{
    Project, ProjectChange, ProjectCursor, ProjectLocation, ProjectRef, ProjectResult,
    ProjectsPage, ProjectsRead,
};
use maka_event_log::StoreError;
use maka_event_log::projects::{
    ProjectError, ProjectMutation, ProjectRecord, ProjectRegistration, ProjectRelinkGuard,
};
use maka_fs_tools::workspace::project as filesystem;

fn digest(value: &impl Serialize) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("project observation"),
    ))
}
fn reference(record: &ProjectRecord) -> ProjectRef {
    ProjectRef {
        id: Uuid::parse_str(&record.id).expect("stored project UUID"),
        revision: digest(record),
    }
}
fn stored(error: StoreError) -> Result<ProjectResult, String> {
    match error {
        StoreError::Project(ProjectError::Changed) => Ok(ProjectResult::Changed),
        StoreError::Project(_) => Ok(ProjectResult::Unavailable),
        _ => Err("agent_project_commit_unknown".into()),
    }
}

impl Owner {
    fn project_prefix(&self) -> String {
        format!("{}project:", self.prefix)
    }
    fn project_identity(&self, physical: &str) -> String {
        format!(
            "{}{}",
            self.project_prefix(),
            hex::encode(Sha256::digest(physical.as_bytes()))
        )
    }
    async fn project_records(&self) -> Result<Vec<ProjectRecord>, String> {
        self.store
            .projects_with_identity_prefix(&self.project_prefix())
            .await
            .map_err(|_| "agent_projects_unavailable".into())
    }
    async fn project_record(&self, id: Uuid) -> Result<Option<ProjectRecord>, String> {
        Ok(self
            .store
            .get_project(&id.to_string())
            .await
            .map_err(|_| "agent_projects_unavailable")?
            .filter(|record| record.identity.starts_with(&self.project_prefix())))
    }
    async fn project_paths(
        &self,
        record: &ProjectRecord,
    ) -> Result<Vec<(String, DirectorySelection)>, String> {
        let mut locations = record.locations.iter().collect::<Vec<_>>();
        locations.sort_by(|a, b| {
            b.last_used_at
                .cmp(&a.last_used_at)
                .then_with(|| a.path.cmp(&b.path))
        });
        let mut paths = Vec::new();
        for location in locations {
            let Some(selection) = workspace::selection_at(
                self.workspace_roots.clone(),
                location.path.clone(),
                self.managed_worktrees.clone(),
            )
            .await?
            else {
                continue;
            };
            let Ok(physical) =
                filesystem::resolve_selected(std::path::Path::new(&location.path)).await
            else {
                continue;
            };
            if physical
                .identity()
                .is_ok_and(|identity| self.project_identity(&identity) == record.identity)
            {
                paths.push((location.path.clone(), selection));
            }
        }
        Ok(paths)
    }
    async fn project_summary(&self, record: &ProjectRecord) -> Result<Project, String> {
        let location = self.project_paths(record).await?.into_iter().next();
        let (path, selection) = match location {
            Some((path, selection)) => (Some(path), Some(selection)),
            None => (None, None),
        };
        Ok(Project {
            reference: reference(record),
            name: record.name.clone(),
            archived: record.archived_at.is_some(),
            available: path.is_some(),
            selection,
            path,
        })
    }
    async fn project_directory(
        &self,
        selection: DirectorySelection,
    ) -> Result<Option<(ProjectRegistration, DirectorySelection)>, String> {
        let Some(directory) = workspace::selected(
            self.workspace_roots.clone(),
            selection.clone(),
            self.managed_worktrees.clone(),
        )
        .await?
        else {
            return Ok(None);
        };
        let Ok(physical) =
            filesystem::resolve_selected(std::path::Path::new(&directory.path)).await
        else {
            return Ok(None);
        };
        let Ok(identity) = physical.identity() else {
            return Ok(None);
        };
        // The directory picker observation is still the basis after Git inspection.
        if workspace::selected(
            self.workspace_roots.clone(),
            selection.clone(),
            self.managed_worktrees.clone(),
        )
        .await?
        .is_none()
        {
            return Ok(None);
        }
        Ok(Some((
            ProjectRegistration {
                identity: self.project_identity(&identity),
                name: physical.name,
                path: directory.path,
                is_worktree: matches!(
                    physical.kind,
                    filesystem::ProjectKind::Git {
                        is_worktree: true,
                        ..
                    }
                ),
            },
            selection,
        )))
    }
    pub async fn projects(&self, input: ProjectsRead) -> Result<ProjectsPage, String> {
        let records = self.project_records().await?;
        let result = match input {
            ProjectsRead::Directory { selection } => {
                let Some((location, selection)) = self.project_directory(selection).await? else {
                    return Ok(ProjectsPage::Unavailable);
                };
                let project = match records
                    .iter()
                    .find(|record| record.identity == location.identity)
                {
                    Some(record) => Some(self.project_summary(record).await?),
                    None => None,
                };
                ProjectsPage::Directory {
                    location: ProjectLocation {
                        selection,
                        path: location.path,
                        name: location.name,
                        project,
                    },
                }
            }
            ProjectsRead::List { cursor } => {
                let revision = digest(&records);
                let start = if let Some(cursor) = cursor {
                    if cursor.revision != revision {
                        return Ok(ProjectsPage::Changed);
                    }
                    let Some(index) = records
                        .iter()
                        .position(|record| record.id == cursor.after.to_string())
                    else {
                        return Ok(ProjectsPage::Changed);
                    };
                    index + 1
                } else {
                    0
                };
                let mut projects = Vec::new();
                for record in records.iter().skip(start).take(16) {
                    projects.push(self.project_summary(record).await?);
                }
                loop {
                    let next = (start + projects.len() < records.len()).then(|| ProjectCursor {
                        revision: revision.clone(),
                        after: projects.last().expect("nonempty project page").reference.id,
                    });
                    let page = ProjectsPage::Projects {
                        revision: revision.clone(),
                        projects: projects.clone(),
                        next,
                    };
                    if workspace::fits(&page) || projects.len() <= 1 {
                        return Ok(page);
                    }
                    projects.pop();
                }
            }
        };
        Ok(result)
    }

    pub(crate) async fn select_workspace(
        self: &Arc<Self>,
        selection: DirectorySelection,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<Option<Workspace>, String> {
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                let root = owner
                    .store
                    .owned_root()
                    .map_err(|error| error.to_string())?;
                workspace::initialize(
                    &owner.workspace_roots,
                    selection,
                    &owner.managed_worktrees,
                    root.canonical_path(),
                    root.control_directory(),
                )
                .await
            })
        })
        .await
    }

    pub(super) async fn create_project_workspace(
        &self,
        selection: DirectorySelection,
    ) -> Result<Option<Workspace>, String> {
        let Some((registration, selection)) = self.project_directory(selection).await? else {
            return Ok(None);
        };
        let record = match self
            .store
            .register_available_project(registration, now())
            .await
        {
            Ok(record) => record,
            Err(StoreError::Project(_)) => return Ok(None),
            Err(_) => return Err("agent_project_registration_unknown".into()),
        };
        let root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let Some(mut workspace) = workspace::initialize(
            &self.workspace_roots,
            selection,
            &self.managed_worktrees,
            root.canonical_path(),
            root.control_directory(),
        )
        .await?
        else {
            return Ok(None);
        };
        workspace.project_id =
            Some(Uuid::parse_str(&record.id).map_err(|_| "agent_project_unavailable")?);
        Ok(Some(workspace))
    }

    pub(super) async fn project_accepts_session(
        &self,
        workspace: &Workspace,
    ) -> Result<bool, String> {
        match workspace.project_id {
            None => Ok(true),
            Some(id) => Ok(self
                .project_record(id)
                .await?
                .is_some_and(|record| record.archived_at.is_none())),
        }
    }

    /// The caller holds the same admission gate as create/send/queue/metadata.
    pub(super) async fn select_project(
        &self,
        selected: ProjectRef,
        selection: DirectorySelection,
    ) -> Result<Option<Workspace>, String> {
        let Some(record) = self.project_record(selected.id).await? else {
            return Ok(None);
        };
        if reference(&record) != selected || record.archived_at.is_some() {
            return Ok(None);
        }
        let Some((registration, selection)) = self.project_directory(selection).await? else {
            return Ok(None);
        };
        if registration.identity != record.identity
            || !record
                .locations
                .iter()
                .any(|location| location.path == registration.path)
        {
            return Ok(None);
        }
        let record = match self
            .store
            .select_project_if(record, vec![registration.path], now())
            .await
        {
            Ok((record, _)) => record,
            Err(StoreError::Project(_)) => return Ok(None),
            Err(_) => return Err("agent_project_selection_unknown".into()),
        };
        let root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let Some(mut workspace) = workspace::initialize(
            &self.workspace_roots,
            selection,
            &self.managed_worktrees,
            root.canonical_path(),
            root.control_directory(),
        )
        .await?
        else {
            return Ok(None);
        };
        workspace.project_id =
            Some(Uuid::parse_str(&record.id).map_err(|_| "agent_project_unavailable")?);
        Ok(Some(workspace))
    }

    pub async fn project(&self, input: ProjectChange) -> Result<ProjectResult, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(ProjectResult::Unavailable);
        }
        let archiving = matches!(&input, ProjectChange::Archive { .. });
        let result = match input {
            ProjectChange::Register {
                selection,
                expected,
            } => {
                let Some((registration, _)) = self.project_directory(selection).await? else {
                    return Ok(ProjectResult::Unavailable);
                };
                let current = self
                    .project_records()
                    .await?
                    .into_iter()
                    .find(|record| record.identity == registration.identity);
                if current.as_ref().map(reference) != expected {
                    return Ok(ProjectResult::Changed);
                }
                self.store
                    .register_project_if(registration, true, now(), current)
                    .await
            }
            ProjectChange::Rename { project, name } => {
                if name.trim().is_empty() || name.chars().any(char::is_control) {
                    return Ok(ProjectResult::Invalid);
                }
                let Some(current) = self.project_record(project.id).await? else {
                    return Ok(ProjectResult::Unavailable);
                };
                if reference(&current) != project {
                    return Ok(ProjectResult::Changed);
                }
                self.store
                    .mutate_project_if(current, ProjectMutation::Rename(name), now())
                    .await
            }
            ProjectChange::Archive { project } | ProjectChange::Restore { project } => {
                let Some(current) = self.project_record(project.id).await? else {
                    return Ok(ProjectResult::Unavailable);
                };
                if reference(&current) != project {
                    return Ok(ProjectResult::Changed);
                }
                let mutation = if archiving {
                    ProjectMutation::Archive
                } else {
                    ProjectMutation::Restore
                };
                self.store.mutate_project_if(current, mutation, now()).await
            }
            ProjectChange::Relocate {
                project,
                selection,
                destination,
            } => {
                let Some(current) = self.project_record(project.id).await? else {
                    return Ok(ProjectResult::Unavailable);
                };
                if reference(&current) != project {
                    return Ok(ProjectResult::Changed);
                }
                let Some((registration, selection)) = self.project_directory(selection).await?
                else {
                    return Ok(ProjectResult::Unavailable);
                };
                let other = self
                    .project_records()
                    .await?
                    .into_iter()
                    .find(|record| record.identity == registration.identity);
                if other.as_ref().map(reference) != destination {
                    return Ok(ProjectResult::Changed);
                }
                let ids = std::iter::once(current.id.clone())
                    .chain(current.aliases.iter().cloned())
                    .chain(other.iter().flat_map(|record| {
                        std::iter::once(record.id.clone()).chain(record.aliases.iter().cloned())
                    }))
                    .collect::<std::collections::BTreeSet<_>>();
                let affected = |workspace: &Workspace| {
                    workspace
                        .project_id
                        .is_some_and(|id| ids.contains(&id.to_string()))
                };
                if !runs.quarantined.is_empty()
                    || runs
                        .controls
                        .values()
                        .any(|control| affected(&control.basis.workspace))
                {
                    return Ok(ProjectResult::Busy);
                }
                let mut after = None;
                loop {
                    let pending = self
                        .store
                        .pending_message_sessions(&self.prefix, after.as_deref())
                        .await
                        .map_err(|_| "agent_projects_unavailable")?;
                    if pending.is_empty() {
                        break;
                    }
                    for id in &pending {
                        if affected(&self.session(id).await?.configuration.workspace) {
                            return Ok(ProjectResult::Busy);
                        }
                    }
                    after = pending.last().cloned();
                }
                let root = self
                    .store
                    .owned_root()
                    .map_err(|_| "agent_root_unavailable")?;
                let Some(mut selected) = workspace::initialize(
                    &self.workspace_roots,
                    selection,
                    &self.managed_worktrees,
                    root.canonical_path(),
                    root.control_directory(),
                )
                .await?
                else {
                    return Ok(ProjectResult::Unavailable);
                };
                selected.project_id = Some(project.id);
                self.store
                    .relink_project_if(
                        ProjectRelinkGuard {
                            source: current,
                            destination: other,
                            owner_scope: self.prefix.clone(),
                        },
                        registration,
                        now(),
                        serde_json::to_value(selected).map_err(|_| "agent_project_invalid")?,
                    )
                    .await
                    .map(|result| result.project)
            }
        };
        match result {
            Ok(record) => Ok(ProjectResult::Committed {
                project: self.project_summary(&record).await?,
            }),
            Err(error) => stored(error),
        }
    }
}
