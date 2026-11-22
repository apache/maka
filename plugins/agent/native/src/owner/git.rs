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

//! Current Git observations use the original Session's workspace authority.
use super::*;
use maka_capabilities::call::Scope;
use std::{io, path::Path, sync::atomic::AtomicBool};
impl Owner {
    pub async fn git_status(
        self: &Arc<Self>,
        input: GitSessionRead,
        scope: &Scope,
    ) -> Result<Option<GitStatus>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .read_git_in_worktree(
                        &input.session_id,
                        input.worktree_path.as_deref(),
                        &scope,
                        |workspace, observed, private_root, cancel| {
                            maka_fs_tools::git::status(
                                Path::new(&workspace.path),
                                observed,
                                private_root,
                                workspace.worktree.as_deref(),
                                cancel,
                            )
                        },
                    )
                    .await
            })
        })
        .await
    }

    pub async fn git_diff(
        self: &Arc<Self>,
        input: GitDiffRead,
        scope: &Scope,
    ) -> Result<Option<GitDiff>, String> {
        input
            .path
            .validate()
            .map_err(|_| "agent_git_input_invalid")?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let wt = input.worktree_path.clone();
                owner
                    .read_git_in_worktree(
                        &input.session_id,
                        wt.as_deref(),
                        &scope,
                        move |workspace, observed, private_root, cancel| {
                            maka_fs_tools::git::diff(
                                Path::new(&workspace.path),
                                observed,
                                private_root,
                                workspace.worktree.as_deref(),
                                input.area,
                                &input.path,
                                cancel,
                            )
                        },
                    )
                    .await
            })
        })
        .await
    }

    pub async fn git_workspace_diff(
        self: &Arc<Self>,
        input: GitWorkspaceDiffRead,
        scope: &Scope,
    ) -> Result<Option<GitWorkspaceDiff>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let wt = input.worktree_path.clone();
                owner
                    .read_git_in_worktree(
                        &input.session_id,
                        wt.as_deref(),
                        &scope,
                        move |workspace, observed, private_root, cancel| {
                            maka_fs_tools::git::workspace_diff(
                                Path::new(&workspace.path),
                                observed,
                                private_root,
                                workspace.worktree.as_deref(),
                                input.area,
                                cancel,
                            )
                        },
                    )
                    .await
            })
        })
        .await
    }

    pub async fn git_revisions(
        self: &Arc<Self>,
        input: GitSessionRead,
        scope: &Scope,
    ) -> Result<Option<GitRevisions>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let mut rev = owner
                    .read_git_in_worktree(
                        &input.session_id,
                        input.worktree_path.as_deref(),
                        &scope,
                        |workspace, observed, private_root, cancel| {
                            maka_fs_tools::git::revisions(
                                Path::new(&workspace.path),
                                observed,
                                private_root,
                                workspace.worktree.as_deref(),
                                cancel,
                            )
                        },
                    )
                    .await?;
                let session_ws = owner
                    .session(&input.session_id)
                    .await?
                    .configuration
                    .workspace;
                let session_canonical = workspace::open_workspace_observation(
                    &owner.workspace_roots,
                    &session_ws,
                    &owner.managed_worktrees,
                )
                .await
                .ok()
                .map(|(resolved_path, _, _)| resolved_path);
                if let Some(ref mut r) = rev {
                    let mut allowed = Vec::with_capacity(r.worktrees.len());
                    for mut wt in r.worktrees.drain(..) {
                        if let Some(ref sr) = session_canonical {
                            wt.is_current = std::fs::canonicalize(&wt.path).ok().as_deref()
                                == Some(sr.as_path());
                        }
                        if wt.is_current {
                            allowed.push(wt);
                            continue;
                        }
                        let probe = Workspace {
                            path: wt.path.clone(),
                            worktree: None,
                            project_id: None,
                        };
                        if workspace::open_workspace_observation(
                            &owner.workspace_roots,
                            &probe,
                            &owner.managed_worktrees,
                        )
                        .await
                        .is_ok()
                        {
                            allowed.push(wt);
                        }
                    }
                    r.worktrees = allowed;
                }
                Ok(rev)
            })
        })
        .await
    }

    pub async fn git_compare(
        self: &Arc<Self>,
        input: GitCompareRead,
        scope: &Scope,
    ) -> Result<Option<GitCompare>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let wt = input.worktree_path.clone();
                owner
                    .read_git_in_worktree(
                        &input.session_id,
                        wt.as_deref(),
                        &scope,
                        move |workspace, observed, private_root, cancel| {
                            maka_fs_tools::git::compare(
                                Path::new(&workspace.path),
                                observed,
                                private_root,
                                workspace.worktree.as_deref(),
                                &input.spec,
                                input.include_patch,
                                cancel,
                            )
                        },
                    )
                    .await
            })
        })
        .await
    }

    pub async fn git_compare_diff(
        self: &Arc<Self>,
        input: GitCompareDiffRead,
        scope: &Scope,
    ) -> Result<Option<GitDiff>, String> {
        input
            .path
            .validate()
            .map_err(|_| "agent_git_input_invalid")?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let wt = input.worktree_path.clone();
                owner
                    .read_git_in_worktree(
                        &input.session_id,
                        wt.as_deref(),
                        &scope,
                        move |workspace, observed, private_root, cancel| {
                            maka_fs_tools::git::compare_diff(
                                Path::new(&workspace.path),
                                observed,
                                private_root,
                                workspace.worktree.as_deref(),
                                &input.spec,
                                &input.path,
                                cancel,
                            )
                        },
                    )
                    .await
            })
        })
        .await
    }

    pub(super) async fn read_git<T: std::marker::Send + 'static>(
        &self,
        session_id: &str,
        scope: &Scope,
        read: impl FnOnce(
            &Workspace,
            &maka_fs_tools::directory::Observation,
            &Path,
            Arc<AtomicBool>,
        ) -> io::Result<T>
        + std::marker::Send
        + 'static,
    ) -> Result<T, String> {
        self.read_git_in_worktree(session_id, None, scope, read)
            .await
    }

    pub(super) async fn read_git_in_worktree<T: std::marker::Send + 'static>(
        &self,
        session_id: &str,
        worktree_path: Option<&str>,
        scope: &Scope,
        read: impl FnOnce(
            &Workspace,
            &maka_fs_tools::directory::Observation,
            &Path,
            Arc<AtomicBool>,
        ) -> io::Result<T>
        + std::marker::Send
        + 'static,
    ) -> Result<T, String> {
        let original = self.session(session_id).await?.configuration;
        let override_ws = worktree_path
            .map(str::trim)
            .filter(|p| !p.is_empty() && *p != original.workspace.path)
            .map(|p| Workspace {
                path: p.to_owned(),
                worktree: None,
                project_id: None,
            });
        let effective_ws = override_ws.as_ref().unwrap_or(&original.workspace).clone();
        let (_, _, observed) = workspace::open_workspace_observation(
            &self.workspace_roots,
            &effective_ws,
            &self.managed_worktrees,
        )
        .await?;
        let current = self.session(session_id).await?.configuration;
        if current.workspace != original.workspace
            || current.permission_basis() != original.permission_basis()
        {
            return Err("agent_git_changed".into());
        }
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_git_cancelled".into());
        }
        let private_root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?
            .canonical_path()
            .to_owned();
        let base_path = original.workspace.path.clone();
        let check_same_repo = override_ws.is_some();
        let selected = effective_ws.clone();
        let session = session_id.to_owned();
        let observed_for_read = observed.clone();
        let result = worktrees::blocking(scope, &self.stop, move |cancel| {
            if check_same_repo
                && !maka_fs_tools::git::same_repository(Path::new(&base_path), Path::new(&selected.path))
            {
                return Err("agent_git_worktree_not_in_repository".to_owned());
            }
            read(&selected, &observed_for_read, &private_root, cancel).map_err(|error| {
                let cause = git_failure(&error);
                if cause != "agent_git_cancelled" {
                    tracing::warn!(stage = "git_read", cause, session_id = %session,
                        io_kind = ?error.kind(), os_code = error.raw_os_error(), "Workspace Git query failed");
                }
                cause.to_owned()
            })
        }).await;
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_git_cancelled".into());
        }
        let current = self.session(session_id).await?.configuration;
        if current.workspace != original.workspace
            || current.permission_basis() != original.permission_basis()
        {
            return Err("agent_git_changed".into());
        }
        let (_, _, after) = workspace::open_workspace_observation(
            &self.workspace_roots,
            &effective_ws,
            &self.managed_worktrees,
        )
        .await?;
        if after != observed {
            return Err("agent_git_changed".into());
        }
        result
    }
}

// The backend sanitizes errors; keep only its closed vocabulary at this boundary.
fn git_failure(error: &io::Error) -> &'static str {
    match error.to_string().as_str() {
        "git_invalid_path" => "agent_git_invalid_path",
        "git_invalid_revision" => "agent_git_invalid_revision",
        "git_revision_not_found" => "agent_git_revision_not_found",
        "git_unsupported" => "agent_git_unsupported",
        "git_private" => "agent_git_private",
        "git_cancelled" => "agent_git_cancelled",
        "git_changed" => "agent_git_changed",
        "git_unavailable" => "agent_git_unavailable",
        _ => "agent_git_unavailable",
    }
}
