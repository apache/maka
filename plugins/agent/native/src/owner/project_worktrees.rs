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
use maka_capabilities::call::Scope;
use maka_event_log::{StoreError, root::RootOwner};
use maka_fs_tools::{git, workspace::project::host_path, worktree::project};
use maka_plugin_core::storage::{Data, Mutation, Namespace, Scan};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

const UNAVAILABLE: &str = "agent_project_worktrees_unavailable";
const UNKNOWN: &str = "agent_project_worktree_outcome_unknown";

impl Owner {
    pub async fn project_worktrees(
        self: &Arc<Self>,
        input: ProjectWorktreesRead,
        scope: &Scope,
    ) -> Result<ProjectWorktrees, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.read_project_worktrees(input, &scope).await })
        })
        .await
    }

    async fn read_project_worktrees(
        &self,
        input: ProjectWorktreesRead,
        scope: &Scope,
    ) -> Result<ProjectWorktrees, String> {
        let state = self.store.owned_root().map_err(|_| UNAVAILABLE)?;
        let Some(source) = self
            .checkout_location(Path::new(&input.path), &state)
            .await?
        else {
            return Ok(ProjectWorktrees::Unavailable);
        };
        let path = PathBuf::from(&source.path);
        let discovered = worktrees::blocking(scope, &self.stop, move |_| {
            Ok(project::Repository::discover(&path))
        })
        .await?;
        let repository = match discovered {
            Ok(Some(repository)) => repository,
            Ok(None) => return Ok(ProjectWorktrees::NotGit),
            Err(_) => return Ok(ProjectWorktrees::Unavailable),
        };
        if !self
            .checkout_repository_allowed(&repository, &state)
            .await?
        {
            return Ok(ProjectWorktrees::Unavailable);
        }
        let prefix = self.checkout_prefix(&repository);
        let state_dir = state.canonical_path().to_owned();
        let root = host_path(&repository.root)
            .map_err(|_| UNAVAILABLE)?
            .to_owned();
        let private_root = state.canonical_path().to_owned();
        let (branches, uncommitted_files) = worktrees::blocking(scope, &self.stop, move |cancel| {
            let path = Path::new(&source.path);
            let branches = repository
                .branches(path, &cancel)
                .map_err(|_| UNAVAILABLE)?;
            let changed = git::status(path, &source.identity, &private_root, None, cancel)
                .ok()
                .flatten()
                .map(|status| {
                    status
                        .entries
                        .into_iter()
                        .map(|entry| entry.path.bytes_base64)
                        .collect::<HashSet<_>>()
                        .len() as u64
                });
            Ok((branches, changed))
        })
        .await?;
        let mut entries = Vec::new();
        let namespace = checkout_namespace();
        let mut after = None;
        loop {
            let page = self
                .store
                .plugin_data_live_scan(
                    &namespace,
                    Scan {
                        prefix: prefix.clone(),
                        after,
                    },
                )
                .await
                .map_err(|_| UNAVAILABLE)?;
            let allocations: Vec<_> = page
                .entries
                .into_iter()
                .map(|entry| decode_allocation(entry.record.data))
                .collect::<Result<_, _>>()?;
            let state_dir = state_dir.clone();
            let batch = worktrees::blocking(scope, &self.stop, move |cancel| {
                let mut batch = Vec::new();
                for allocation in allocations {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                        return Err(UNAVAILABLE.into());
                    }
                    if let Ok(Some(branch)) = allocation.inspect(&state_dir) {
                        batch.push(checkout_summary(allocation, branch)?);
                    }
                }
                Ok(batch)
            })
            .await?;
            for entry in batch {
                if self
                    .checkout_location(Path::new(&entry.path), &state)
                    .await?
                    .is_some()
                {
                    entries.push(entry);
                }
            }
            match page.next_after {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
        Ok(ProjectWorktrees::Git {
            root,
            head_branch: branches.head,
            default_base: branches.default_base,
            branches: branches.entries,
            uncommitted_files,
            worktrees: entries,
        })
    }

    pub async fn checkout_project_branch(
        self: &Arc<Self>,
        input: ProjectBranchCheckout,
        scope: &Scope,
    ) -> Result<ProjectBranchCheckedOut, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.checkout_local_branch(input, &scope).await })
        })
        .await
    }

    async fn checkout_local_branch(
        &self,
        input: ProjectBranchCheckout,
        scope: &Scope,
    ) -> Result<ProjectBranchCheckedOut, String> {
        let unavailable = ProjectBranchCheckedOut::Failed {
            reason: ProjectBranchFailure::Unavailable,
        };
        let state = self.store.owned_root().map_err(|_| UNAVAILABLE)?;
        let Some(source) = self
            .checkout_location(Path::new(&input.path), &state)
            .await?
        else {
            return Ok(unavailable);
        };
        let path = PathBuf::from(&source.path);
        let discovered = worktrees::blocking(scope, &self.stop, move |_| {
            Ok(project::Repository::discover(&path))
        })
        .await?;
        let Ok(Some(repository)) = discovered else {
            return Ok(unavailable);
        };
        if repository.root != Path::new(&source.path)
            || !self
                .checkout_repository_allowed(&repository, &state)
                .await?
        {
            return Ok(unavailable);
        }
        let directory =
            workspace::open_directory(&self.workspace_roots, &source, &self.managed_worktrees)
                .await?;
        let workspace = self
            .store
            .workspace(directory)
            .await
            .map_err(|_| UNAVAILABLE)?;
        let fence = match self.store.fence_workspace(&workspace).await {
            Ok(fence) => fence,
            Err(StoreError::SessionBusy) => {
                return Ok(ProjectBranchCheckedOut::Failed {
                    reason: ProjectBranchFailure::WorkspaceBusy,
                });
            }
            Err(error) => return Err(error.to_string()),
        };
        let roots = self.workspace_roots.clone();
        worktrees::blocking(scope, &self.stop, move |cancel| {
            let _fence = fence;
            state.validate_current().map_err(|_| UNAVAILABLE)?;
            if ![&repository.root, &repository.common_dir]
                .into_iter()
                .all(|path| roots.iter().any(|root| root.validate(path).is_ok()))
            {
                return Ok(unavailable);
            }
            Ok(
                match repository.checkout_branch(
                    &source.identity,
                    &input.branch,
                    input.create,
                    &cancel,
                ) {
                    Ok(()) => ProjectBranchCheckedOut::CheckedOut,
                    Err(error) => ProjectBranchCheckedOut::Failed {
                        reason: branch_failure(error),
                    },
                },
            )
        })
        .await
    }

    pub async fn create_project_worktree(
        self: &Arc<Self>,
        input: ProjectWorktreeCreate,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &Scope,
    ) -> Result<ProjectWorktreeCreated, String> {
        let original = self.operation_id(operation);
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let result = owner
                    .prepare_project_worktree(input, original, &scope)
                    .await;
                Ok(match result {
                    Ok(worktree) => ProjectWorktreeCreated::Created { worktree },
                    Err(error) => checkout_failure(error),
                })
            })
        })
        .await
    }

    async fn prepare_project_worktree(
        &self,
        input: ProjectWorktreeCreate,
        original: String,
        scope: &Scope,
    ) -> Result<ProjectWorktree, CreateError> {
        let state = self.store.owned_root().map_err(|_| CreateError::Unknown)?;
        let source = self
            .checkout_location(Path::new(&input.path), &state)
            .await
            .map_err(|_| CreateError::Unavailable)?
            .ok_or(CreateError::Unavailable)?;
        let source_path = PathBuf::from(&source.path);
        let inspected_path = source_path.clone();
        let repository = worktrees::blocking(scope, &self.stop, move |_| {
            Ok(project::Repository::discover(&inspected_path))
        })
        .await?
        .map_err(CreateError::Git)?
        .ok_or(CreateError::Unavailable)?;
        if !self
            .checkout_repository_allowed(&repository, &state)
            .await?
        {
            return Err(CreateError::LocationNotAllowed);
        }
        let parent = self
            .checkout_location(repository.destination_parent()?, &state)
            .await?
            .ok_or(CreateError::LocationNotAllowed)?;

        // Identical intents recover the original allocation across client operations.
        let prefix = self.checkout_prefix(&repository);
        let intent = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&input.name, &input.branch)).expect("worktree intent"),
        ));
        let key = format!("{prefix}{intent}");
        let namespace = checkout_namespace();
        let allocation = match self.store.plugin_data(&namespace, &key).await? {
            Some(record) => decode_allocation(record.data)?,
            None => {
                let id = hex::encode(Sha256::digest(
                    serde_json::to_vec(&(&prefix, &original)).expect("worktree identity"),
                ));
                let planned_repository = repository.clone();
                let name = input.name.clone();
                let branch = input.branch.clone();
                let base_ref = input.base_ref.clone();
                let include_changes = input.include_changes;
                let snapshot_path = source_path.clone();
                let private_root = state.canonical_path().to_owned();
                let allocation = worktrees::blocking(scope, &self.stop, move |cancel| {
                    let base = if include_changes {
                        project::Base::LocalFiles {
                            reference: base_ref,
                            source: &snapshot_path,
                            identity: &source.identity,
                            private_root: &private_root,
                            cancel: &cancel,
                        }
                    } else {
                        project::Base::Commit(base_ref)
                    };
                    Ok(planned_repository.plan(id, name, branch, base))
                })
                .await??;
                let change = Mutation {
                    key: key.clone(),
                    expected_revision: None,
                    data: Data::Present(
                        serde_json::to_value(&allocation).map_err(|_| CreateError::Unknown)?,
                    ),
                };
                match self.store.plugin_data_batch(&namespace, vec![change]).await {
                    Ok(_) => allocation,
                    Err(StoreError::RevisionConflict { .. }) => {
                        let record = self
                            .store
                            .plugin_data(&namespace, &key)
                            .await?
                            .ok_or(CreateError::Unknown)?;
                        decode_allocation(record.data)?
                    }
                    Err(_) => return Err(CreateError::Unknown),
                }
            }
        };
        if !allocation.matches(
            &repository,
            &input.name,
            &input.branch,
            &input.base_ref,
            input.include_changes.then_some(source_path.as_path()),
        ) {
            return Err(CreateError::IntentConflict);
        }

        let state_dir = state.canonical_path().to_owned();
        let current_state = state.clone();
        let roots = self.workspace_roots.clone();
        let entry = worktrees::blocking(scope, &self.stop, move |cancel| {
            current_state.validate_current().map_err(|_| UNKNOWN)?;
            let still_allowed = [
                &repository.root,
                &repository.common_dir,
                &PathBuf::from(&parent.path),
            ]
            .into_iter()
            .all(|path| roots.iter().any(|root| root.validate(path).is_ok()));
            if !still_allowed {
                return Ok(Err(CreateError::LocationNotAllowed));
            }
            let result = allocation
                .ensure(&state_dir, &parent.identity, cancel)
                .map_err(CreateError::Git)
                .and_then(|branch| checkout_summary(allocation, branch).map_err(CreateError::from));
            Ok(result)
        })
        .await??;
        if self
            .checkout_location(Path::new(&entry.path), &state)
            .await?
            .is_none()
        {
            return Err(CreateError::LocationNotAllowed);
        }
        Ok(entry)
    }

    fn checkout_prefix(&self, repository: &project::Repository) -> String {
        let digest = Sha256::digest(
            serde_json::to_vec(&(&self.prefix, repository)).expect("project worktree scope"),
        );
        format!("project-worktrees:{}:", hex::encode(digest))
    }

    async fn checkout_repository_allowed(
        &self,
        repository: &project::Repository,
        state: &RootOwner,
    ) -> Result<bool, String> {
        Ok(self
            .checkout_location(&repository.root, state)
            .await?
            .is_some()
            && self
                .checkout_location(&repository.common_dir, state)
                .await?
                .is_some())
    }

    async fn checkout_location(
        &self,
        path: &Path,
        state: &RootOwner,
    ) -> Result<Option<workspace::Located>, String> {
        let path = host_path(path).map_err(|_| UNAVAILABLE)?;
        let selected = workspace::observed(
            self.workspace_roots.clone(),
            path,
            self.home.as_deref(),
            self.managed_worktrees.clone(),
        )
        .await?;
        Ok(selected.filter(|location| {
            let path = Path::new(&location.path);
            !path.starts_with(state.canonical_path())
                && !path.starts_with(state.control_directory())
        }))
    }
}

fn checkout_namespace() -> Namespace {
    Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
        .expect("Agent namespace")
}

fn decode_allocation(data: Data) -> Result<project::Allocation, String> {
    match data {
        Data::Present(value) => serde_json::from_value(value).map_err(|_| UNKNOWN.into()),
        Data::Deleted => Err(UNKNOWN.into()),
    }
}

fn checkout_summary(
    allocation: project::Allocation,
    branch: Option<String>,
) -> Result<ProjectWorktree, String> {
    Ok(ProjectWorktree {
        id: allocation.id,
        name: allocation.name,
        branch,
        path: host_path(&allocation.directory)
            .map_err(|_| UNAVAILABLE)?
            .to_owned(),
    })
}

enum CreateError {
    Git(project::Error),
    IntentConflict,
    LocationNotAllowed,
    Unavailable,
    Unknown,
}
impl From<project::Error> for CreateError {
    fn from(error: project::Error) -> Self {
        Self::Git(error)
    }
}
impl From<String> for CreateError {
    fn from(_: String) -> Self {
        Self::Unknown
    }
}
impl From<StoreError> for CreateError {
    fn from(_: StoreError) -> Self {
        Self::Unknown
    }
}

fn checkout_failure(error: CreateError) -> ProjectWorktreeCreated {
    use ProjectWorktreeFailure as Reason;
    use project::Error as Git;
    let (reason, message) = match error {
        CreateError::Git(Git::InvalidName) => (
            Reason::InvalidName,
            "Choose a name that can be used as a folder name.",
        ),
        CreateError::Git(Git::InvalidBranch) => {
            (Reason::InvalidBranch, "Enter a valid Git branch name.")
        }
        CreateError::Git(Git::BaseUnavailable) => {
            (Reason::BaseUnavailable, "Choose an available base branch.")
        }
        CreateError::Git(Git::BranchConflict) | CreateError::IntentConflict => (
            Reason::BranchConflict,
            "This branch is already in use. Choose another branch name.",
        ),
        CreateError::Git(Git::DirectoryConflict) => (
            Reason::DirectoryConflict,
            "This directory is already in use. Choose another worktree name.",
        ),
        CreateError::Git(Git::SnapshotUnavailable) => (
            Reason::SnapshotUnavailable,
            "Could not copy the current files. Check the local branch and resolve any Git conflicts.",
        ),
        CreateError::Git(Git::GitRequired) => (
            Reason::GitRequired,
            "Install Git to start a worktree with local changes.",
        ),
        CreateError::LocationNotAllowed => (
            Reason::LocationNotAllowed,
            "Add the folder containing this repository to Workspace Locations, then try again.",
        ),
        CreateError::Unavailable | CreateError::Git(Git::Unavailable) => (
            Reason::Unavailable,
            "Open the project's Git checkout and check that its worktree directory is available.",
        ),
        CreateError::Git(Git::Unsupported) => (
            Reason::Unsupported,
            "Use a checkout and base branch without sparse checkout, submodules, relative worktree paths, or external filters.",
        ),
        CreateError::Git(Git::Io(error)) => {
            tracing::warn!(%error, "Project worktree creation did not complete");
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                (
                    Reason::Unavailable,
                    "Check write access to the repository and its parent folder, then try again.",
                )
            } else {
                (
                    Reason::Unknown,
                    "Check the repository and retry with the same worktree name and branch.",
                )
            }
        }
        CreateError::Unknown => (
            Reason::Unknown,
            "Retry with the same worktree name and branch.",
        ),
    };
    ProjectWorktreeCreated::Failed {
        reason,
        message: message.into(),
    }
}

fn branch_failure(error: project::BranchError) -> ProjectBranchFailure {
    use ProjectBranchFailure as Reason;
    use project::{BranchError as Branch, Error as Git};
    match error {
        Branch::AlreadyExists => Reason::AlreadyExists,
        Branch::CheckedOutElsewhere => Reason::CheckedOutElsewhere,
        Branch::OverwritesChanges => Reason::OverwritesChanges,
        Branch::Project(Git::InvalidBranch) => Reason::InvalidBranch,
        Branch::Project(Git::BaseUnavailable) => Reason::BranchUnavailable,
        Branch::Project(Git::GitRequired) => Reason::GitRequired,
        Branch::Project(Git::Unsupported) => Reason::Unsupported,
        Branch::Project(error) => {
            tracing::warn!(?error, "Could not check out the project branch");
            Reason::Unavailable
        }
    }
}
