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
use maka_event_log::projects::{
    ProjectError, ProjectMutation, ProjectRecord, ProjectRegistration, ProjectRelinkGuard,
};
use maka_event_log::{
    StoreError,
    root_store::{DataWriter, ProjectWorkspacePlan},
    writeback::{Prepared, Statement},
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
fn stored(error: StoreError) -> Result<NativeMutation<ProjectResult>, String> {
    match error {
        StoreError::SessionBusy => Ok(NativeMutation::Returned(ProjectResult::Busy)),
        StoreError::Project(ProjectError::Changed) => {
            Ok(NativeMutation::Returned(ProjectResult::Changed))
        }
        StoreError::Project(_) => Ok(NativeMutation::Returned(ProjectResult::Unavailable)),
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
    async fn project_paths(&self, record: &ProjectRecord) -> Result<Vec<String>, String> {
        let mut locations = record.locations.iter().collect::<Vec<_>>();
        locations.sort_by(|a, b| {
            b.last_used_at
                .cmp(&a.last_used_at)
                .then_with(|| a.path.cmp(&b.path))
        });
        let mut paths = Vec::new();
        for location in locations {
            if workspace::observed(
                self.workspace_roots.clone(),
                &location.path,
                self.home.as_deref(),
                self.managed_worktrees.clone(),
            )
            .await?
            .is_none()
            {
                continue;
            }
            let Ok(physical) =
                filesystem::resolve_selected(std::path::Path::new(&location.path)).await
            else {
                continue;
            };
            if physical
                .identity()
                .is_ok_and(|identity| self.project_identity(&identity) == record.identity)
            {
                paths.push(location.path.clone());
            }
        }
        Ok(paths)
    }
    async fn project_summary(&self, record: &ProjectRecord) -> Result<Project, String> {
        let path = self.project_paths(record).await?.into_iter().next();
        Ok(Project {
            reference: reference(record),
            name: record.name.clone(),
            archived: record.archived_at.is_some(),
            available: path.is_some(),
            path,
        })
    }
    /// The directory at `path` as a Project registration, with the path as
    /// the Host captured it.
    async fn project_directory(
        &self,
        path: &str,
    ) -> Result<Option<(ProjectRegistration, String)>, String> {
        let Some(directory) = workspace::selected(
            self.workspace_roots.clone(),
            path,
            self.home.as_deref(),
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
            path,
            self.home.as_deref(),
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
                path: directory.path.clone(),
                is_worktree: matches!(
                    physical.kind,
                    filesystem::ProjectKind::Git {
                        is_worktree: true,
                        ..
                    }
                ),
            },
            directory.path,
        )))
    }
    pub async fn projects(&self, input: ProjectsRead) -> Result<ProjectsPage, String> {
        let records = self.project_records().await?;
        let result = match input {
            ProjectsRead::Directory { path } => {
                let Some((location, _)) = self.project_directory(&path).await? else {
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
        input: DirectoryPath,
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
                    &input.path,
                    owner.home.as_deref(),
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
        path: &str,
    ) -> Result<Option<PreparedProjectWorkspace>, String> {
        let Some((registration, path)) = self.project_directory(path).await? else {
            return Ok(None);
        };
        let writer = self
            .store
            .data_writer()
            .map_err(|error| error.to_string())?;
        let project = match self
            .store
            .plan_available_project(registration, now(), &writer)
            .await
        {
            Ok(project) => project,
            Err(StoreError::Project(_)) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let Some(mut workspace) = workspace::initialize(
            &self.workspace_roots,
            &path,
            self.home.as_deref(),
            &self.managed_worktrees,
            root.canonical_path(),
            root.control_directory(),
        )
        .await?
        else {
            return Ok(None);
        };
        workspace.project_id = Some(project.project_id());
        Ok(Some(PreparedProjectWorkspace { workspace, project }))
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
        path: &str,
    ) -> Result<Option<PreparedProjectWorkspace>, String> {
        let Some(record) = self.project_record(selected.id).await? else {
            return Ok(None);
        };
        if reference(&record) != selected || record.archived_at.is_some() {
            return Ok(None);
        }
        let Some((registration, path)) = self.project_directory(path).await? else {
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
        let writer = self
            .store
            .data_writer()
            .map_err(|error| error.to_string())?;
        let project = self
            .store
            .plan_selected_project(record, vec![registration.path], now(), &writer)
            .map_err(|error| error.to_string())?;
        let root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let Some(mut workspace) = workspace::initialize(
            &self.workspace_roots,
            &path,
            self.home.as_deref(),
            &self.managed_worktrees,
            root.canonical_path(),
            root.control_directory(),
        )
        .await?
        else {
            return Ok(None);
        };
        workspace.project_id = Some(project.project_id());
        Ok(Some(PreparedProjectWorkspace { workspace, project }))
    }

    fn computed_project<S, T, F>(
        &self,
        writer: &DataWriter,
        statement: S,
        availability: ProjectAvailability,
        caller: Option<maka_agent_state::CallerFence>,
        record: F,
    ) -> Result<NativeMutation<ProjectResult>, String>
    where
        S: Statement<Value = Result<T, ProjectError>>,
        T: std::marker::Send + 'static,
        F: FnOnce(T) -> ProjectRecord + std::marker::Send + 'static,
    {
        let root = self
            .store
            .owned_root()
            .map_err(|_| "project_root_unavailable")?;
        let change = writer
            .prepare_result(|_| {
                Ok(ProjectCompletion {
                    statement,
                    root,
                    availability,
                    caller,
                    record,
                })
            })
            .map_err(|error| error.to_string())?;
        Ok(NativeMutation::Computed { change })
    }

    pub async fn project(
        self: &Arc<Self>,
        input: ProjectChange,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<ProjectResult>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.prepare_project(input, &scope).await })
        })
        .await
    }

    async fn prepare_project(
        &self,
        input: ProjectChange,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<ProjectResult>, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
        }
        let writer = if let Some(execution) = scope.identity.agent() {
            let custody = scope.work_custody().ok_or("agent_work_unavailable")?;
            self.store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        } else {
            self.store.data_writer()
        }
        .map_err(|error| error.to_string())?;
        let caller = if let Some(execution) = scope.identity.agent() {
            let view = self
                .durable
                .with_data_writer(writer.clone())
                .map_err(|error| error.to_string())?
                .frontier(execution.run_id)
                .await
                .map_err(|error| error.to_string())?;
            if view.run != execution.run_id
                || view.spec.session_id != execution.session_id
                || !matches!(
                    view.spec.origin,
                    maka_agent_facts::durable::RunOrigin::Local
                )
                || view.stopped
                || view.terminal.is_some()
            {
                return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
            }
            Some(maka_agent_state::CallerFence {
                execution: execution.clone(),
                expected_basis: Some(view.spec.permission_basis),
            })
        } else {
            None
        };
        let archiving = matches!(&input, ProjectChange::Archive { .. });
        match input {
            ProjectChange::Register { path, expected } => {
                let Some((registration, _)) = self.project_directory(&path).await? else {
                    return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                };
                let current = self
                    .store
                    .project_by_identity(&registration.identity)
                    .await
                    .map_err(|error| error.to_string())?;
                if current.as_ref().map(reference) != expected {
                    return Ok(NativeMutation::Returned(ProjectResult::Changed));
                }
                let mut paths = match &current {
                    Some(record) => self.project_paths(record).await?,
                    None => Vec::new(),
                };
                paths.push(registration.path.clone());
                let availability = ProjectAvailability {
                    identity: registration.identity.clone(),
                    paths,
                };
                match self
                    .store
                    .prepare_register_project_if(registration, true, now(), current, &writer)
                    .await
                {
                    Ok(statement) => {
                        self.computed_project(&writer, statement, availability, caller, |record| {
                            record
                        })
                    }
                    Err(error) => stored(error),
                }
            }
            ProjectChange::Rename { project, name } => {
                if name.trim().is_empty() || name.chars().any(char::is_control) {
                    return Ok(NativeMutation::Returned(ProjectResult::Invalid));
                }
                let Some(current) = self.project_record(project.id).await? else {
                    return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                };
                if reference(&current) != project {
                    return Ok(NativeMutation::Returned(ProjectResult::Changed));
                }
                let availability = ProjectAvailability {
                    identity: current.identity.clone(),
                    paths: self.project_paths(&current).await?,
                };
                match self
                    .store
                    .prepare_mutate_project_if(
                        current,
                        ProjectMutation::Rename(name),
                        now(),
                        &writer,
                    )
                    .await
                {
                    Ok(statement) => {
                        self.computed_project(&writer, statement, availability, caller, |record| {
                            record
                        })
                    }
                    Err(error) => stored(error),
                }
            }
            ProjectChange::Archive { project } | ProjectChange::Restore { project } => {
                let Some(current) = self.project_record(project.id).await? else {
                    return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                };
                if reference(&current) != project {
                    return Ok(NativeMutation::Returned(ProjectResult::Changed));
                }
                let mutation = if archiving {
                    ProjectMutation::Archive
                } else {
                    ProjectMutation::Restore
                };
                let availability = ProjectAvailability {
                    identity: current.identity.clone(),
                    paths: self.project_paths(&current).await?,
                };
                match self
                    .store
                    .prepare_mutate_project_if(current, mutation, now(), &writer)
                    .await
                {
                    Ok(statement) => {
                        self.computed_project(&writer, statement, availability, caller, |record| {
                            record
                        })
                    }
                    Err(error) => stored(error),
                }
            }
            ProjectChange::Relocate {
                project,
                path,
                destination,
            } => {
                let Some(current) = self.project_record(project.id).await? else {
                    return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                };
                if reference(&current) != project {
                    return Ok(NativeMutation::Returned(ProjectResult::Changed));
                }
                let Some((registration, path)) = self.project_directory(&path).await? else {
                    return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                };
                let other = self
                    .store
                    .project_by_identity(&registration.identity)
                    .await
                    .map_err(|error| error.to_string())?;
                if other.as_ref().map(reference) != destination {
                    return Ok(NativeMutation::Returned(ProjectResult::Changed));
                }
                let mut workspaces = Vec::new();
                for path in std::iter::once(path.as_str()).chain(
                    current
                        .locations
                        .iter()
                        .chain(other.iter().flat_map(|project| &project.locations))
                        .map(|location| location.path.as_str()),
                ) {
                    let Some(directory) = workspace::selected(
                        self.workspace_roots.clone(),
                        path,
                        self.home.as_deref(),
                        self.managed_worktrees.clone(),
                    )
                    .await?
                    else {
                        return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                    };
                    let directory = workspace::open_directory(
                        &self.workspace_roots,
                        &directory,
                        &self.managed_worktrees,
                    )
                    .await?;
                    workspaces.push(
                        self.store
                            .workspace(directory)
                            .await
                            .map_err(|error| error.to_string())?,
                    );
                }
                let fence = match self.store.fence_workspaces(&workspaces).await {
                    Ok(fence) => fence,
                    Err(error) => return stored(error),
                };
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
                if runs
                    .controls
                    .values()
                    .any(|control| affected(&control.basis.workspace))
                {
                    return Ok(NativeMutation::Returned(ProjectResult::Busy));
                }
                let mut after = None;
                loop {
                    let pending = self
                        .durable
                        .queue()
                        .ready(self.run_owner(), after.clone(), 128)
                        .await
                        .map_err(|_| "agent_projects_unavailable")?;
                    if pending.is_empty() {
                        break;
                    }
                    let mut previous =
                        after
                            .as_ref()
                            .map(|cursor: &maka_agent_state::queue::ReadyCursor| {
                                cursor.session.as_str()
                            });
                    for entry in &pending {
                        let id = &entry.cursor.session;
                        if previous == Some(id.as_str()) {
                            continue;
                        }
                        if affected(&self.session(id).await?.configuration.workspace) {
                            return Ok(NativeMutation::Returned(ProjectResult::Busy));
                        }
                        previous = Some(id.as_str());
                    }
                    after = pending.last().map(|entry| entry.cursor.clone());
                }
                let root = self
                    .store
                    .owned_root()
                    .map_err(|_| "agent_root_unavailable")?;
                let Some(mut selected) = workspace::initialize(
                    &self.workspace_roots,
                    &path,
                    self.home.as_deref(),
                    &self.managed_worktrees,
                    root.canonical_path(),
                    root.control_directory(),
                )
                .await?
                else {
                    return Ok(NativeMutation::Returned(ProjectResult::Unavailable));
                };
                selected.project_id = Some(project.id);
                let mut paths = match &other {
                    Some(record) => self.project_paths(record).await?,
                    None => Vec::new(),
                };
                paths.push(registration.path.clone());
                let availability = ProjectAvailability {
                    identity: registration.identity.clone(),
                    paths,
                };
                match self
                    .store
                    .prepare_relink_project_if(
                        ProjectRelinkGuard {
                            source: current,
                            destination: other,
                            owner_scope: self.prefix.clone(),
                        },
                        &fence,
                        registration,
                        now(),
                        serde_json::to_value(selected).map_err(|_| "agent_project_invalid")?,
                        &writer,
                    )
                    .await
                {
                    Ok(statement) => self.computed_project(
                        &writer,
                        statement,
                        availability,
                        caller,
                        |result: maka_event_log::projects::ProjectRelink| result.project,
                    ),
                    Err(error) => stored(error),
                }
            }
        }
    }
}

pub(super) struct PreparedProjectWorkspace {
    pub(super) workspace: Workspace,
    pub(super) project: ProjectWorkspacePlan,
}

struct ProjectAvailability {
    identity: String,
    paths: Vec<String>,
}
impl ProjectAvailability {
    fn summary(&self, record: ProjectRecord) -> Project {
        let path = if record.identity == self.identity {
            record
                .locations
                .iter()
                .filter(|location| self.paths.contains(&location.path))
                .min_by(|a, b| {
                    b.last_used_at
                        .cmp(&a.last_used_at)
                        .then_with(|| a.path.cmp(&b.path))
                })
                .map(|location| location.path.clone())
        } else {
            None
        };
        Project {
            reference: reference(&record),
            name: record.name,
            archived: record.archived_at.is_some(),
            available: path.is_some(),
            path,
        }
    }
}

#[derive(Serialize)]
#[serde(transparent)]
struct ProjectCompletionValue {
    result: Value,
    #[serde(skip)]
    notify: Option<Arc<maka_event_log::root::RootOwner>>,
}

struct ProjectCompletion<S, F> {
    root: Arc<maka_event_log::root::RootOwner>,
    statement: S,
    availability: ProjectAvailability,
    caller: Option<maka_agent_state::CallerFence>,
    record: F,
}
impl<S, T, F> Statement for ProjectCompletion<S, F>
where
    S: Statement<Value = Result<T, ProjectError>>,
    T: std::marker::Send + 'static,
    F: FnOnce(T) -> ProjectRecord + std::marker::Send + 'static,
{
    type Value = ProjectCompletionValue;
    type Output = Value;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.statement.retain()
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            statement: self.statement.prepare()?,
            ..self
        })
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        if let Some(caller) = &self.caller {
            match caller.status(connection)? {
                maka_agent_state::CallerStatus::Current => {}
                maka_agent_state::CallerStatus::Unavailable
                | maka_agent_state::CallerStatus::AuthorizationChanged => {
                    return Ok(Prepared {
                        value: ProjectCompletionValue {
                            result: serde_json::to_value(ProjectResult::Unavailable)?,
                            notify: None,
                        },
                        changed: false,
                        notification: maka_event_log::writeback::Notification::NONE,
                    });
                }
            }
        }
        let prepared = self.statement.execute(connection)?;
        let result = match prepared.value {
            Ok(record) => ProjectResult::Committed {
                project: self.availability.summary((self.record)(record)),
            },
            Err(ProjectError::Changed) => ProjectResult::Changed,
            Err(_) => ProjectResult::Unavailable,
        };
        Ok(Prepared {
            value: ProjectCompletionValue {
                result: serde_json::to_value(result)?,
                notify: prepared.changed.then_some(self.root),
            },
            changed: prepared.changed,
            notification: prepared.notification,
        })
    }
    fn committed(value: Self::Value) -> Value {
        if let Some(root) = value.notify {
            root.capability_source_changed();
        }
        value.result
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
    }
}
