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
        input: SessionRead,
        scope: &Scope,
    ) -> Result<Option<GitStatus>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .read_git(
                        &input.session_id,
                        &scope,
                        |workspace, private_root, cancel| {
                            maka_fs_tools::git::status(
                                Path::new(&workspace.path),
                                &workspace.directory_identity,
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
                owner
                    .read_git(
                        &input.session_id,
                        &scope,
                        move |workspace, private_root, cancel| {
                            maka_fs_tools::git::diff(
                                Path::new(&workspace.path),
                                &workspace.directory_identity,
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

    async fn read_git<T: std::marker::Send + 'static>(
        &self,
        session_id: &str,
        scope: &Scope,
        read: impl FnOnce(&Workspace, &Path, Arc<AtomicBool>) -> io::Result<T>
        + std::marker::Send
        + 'static,
    ) -> Result<T, String> {
        let original = self.session(session_id).await?.configuration;
        workspace::validate(
            &self.workspace_roots,
            &original.workspace,
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
        let selected = original.workspace.clone();
        let session = session_id.to_owned();
        let result = worktrees::blocking(scope, &self.stop, move |cancel| {
            read(&selected, &private_root, cancel).map_err(|error| {
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
        workspace::validate(
            &self.workspace_roots,
            &original.workspace,
            &self.managed_worktrees,
        )
        .await?;
        result
    }
}

// The backend sanitizes errors; keep only its closed vocabulary at this boundary.
fn git_failure(error: &io::Error) -> &'static str {
    match error.to_string().as_str() {
        "git_invalid_path" => "agent_git_invalid_path",
        "git_unsupported" => "agent_git_unsupported",
        "git_private" => "agent_git_private",
        "git_cancelled" => "agent_git_cancelled",
        "git_changed" => "agent_git_changed",
        "git_unavailable" => "agent_git_unavailable",
        _ => "agent_git_unavailable",
    }
}
