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

//! Durable allocation precedes checkout; an accepted allocation never follows a new HEAD.
use super::*;
use maka_capabilities::call::Scope;
use maka_fs_tools::worktree::{Binding, Worktrees};
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Allocation {
    session: String,
    fingerprint: String,
    /// The source directory as the Host captured it when allocating.
    path: String,
    identity: maka_sandbox::workspace::DirectoryIdentity,
    binding: Binding,
}

// Cancellation requests interruption, then waits for physical filesystem work.
// The outer native worker retains the original resource ticket throughout.
pub(super) async fn blocking<T: std::marker::Send + 'static>(
    scope: &Scope,
    stop: &CancellationToken,
    work: impl FnOnce(Arc<AtomicBool>) -> Result<T, String> + std::marker::Send + 'static,
) -> Result<T, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let mut worker = tokio::task::spawn_blocking(move || work(flag));
    tokio::select! {
        result = &mut worker => result.map_err(|_| "agent_worktree_unknown".to_owned())?,
        _ = scope.cancellation.cancelled() => {
            cancel.store(true, Ordering::Relaxed);
            worker.await.map_err(|_| "agent_worktree_unknown".to_owned())?
        }
        _ = stop.cancelled() => {
            cancel.store(true, Ordering::Relaxed);
            worker.await.map_err(|_| "agent_worktree_unknown".to_owned())?
        }
    }
}
impl Owner {
    pub(super) async fn isolated_workspace(
        &self,
        path: &str,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &Scope,
    ) -> Result<Option<Workspace>, String> {
        if !self.settings.isolated_workspaces
            || self.settings.permissions.access == WorkspaceAccess::ReadOnly
        {
            return Ok(None);
        }
        let session = self.operation_id(operation);
        let key = format!("{session}:worktree");
        let namespace = Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
            .expect("native Agent namespace");
        let original = self
            .store
            .plugin_data(&namespace, &key)
            .await
            .map_err(|_| "agent_worktree_unavailable")?;
        let allocation: Allocation = match original.map(|record| record.data) {
            Some(Data::Present(value)) => {
                serde_json::from_value(value).map_err(|_| "agent_worktree_unavailable")?
            }
            Some(Data::Deleted) => return Ok(None),
            None => {
                let Some(source) = workspace::selected(
                    self.workspace_roots.clone(),
                    path,
                    self.home.as_deref(),
                    self.managed_worktrees.clone(),
                )
                .await?
                else {
                    return Ok(None);
                };
                let managed = self.managed_worktrees.clone();
                let id = hex::encode(Sha256::digest(
                    serde_json::to_vec(&(
                        self.store
                            .owned_root()
                            .map_err(|_| "agent_worktree_unavailable")?
                            .canonical_path(),
                        &session,
                    ))
                    .expect("worktree identity"),
                ));
                let binding = blocking(scope, &self.stop, move |cancel| {
                    Ok(Worktrees::open(&managed)
                        .and_then(|worktrees| {
                            worktrees.plan(std::path::Path::new(&source.path), &id, cancel)
                        })
                        .ok())
                })
                .await?;
                if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
                    return Err("agent_worktree_cancelled".into());
                }
                let Some(binding) = binding else {
                    return Ok(None);
                };
                let Some(observed) = workspace::selected(
                    self.workspace_roots.clone(),
                    path,
                    self.home.as_deref(),
                    self.managed_worktrees.clone(),
                )
                .await?
                else {
                    return Ok(None);
                };
                if std::path::Path::new(&observed.path) != binding.source()
                    || binding.source_identity() != &observed.identity
                {
                    return Ok(None);
                }
                let allocation = Allocation {
                    session: session.clone(),
                    fingerprint: operation.fingerprint.clone(),
                    path: observed.path,
                    identity: observed.identity,
                    binding,
                };
                match self
                    .store
                    .plugin_data_batch(
                        &namespace,
                        vec![Mutation {
                            key: key.clone(),
                            expected_revision: None,
                            data: Data::Present(
                                serde_json::to_value(&allocation).expect("allocation"),
                            ),
                        }],
                    )
                    .await
                {
                    Ok(_) => allocation,
                    Err(maka_event_log::StoreError::RevisionConflict { .. }) => {
                        let record = self
                            .store
                            .plugin_data(&namespace, &key)
                            .await
                            .map_err(|_| "agent_worktree_unknown")?
                            .ok_or("agent_worktree_unknown")?;
                        let Data::Present(value) = record.data else {
                            return Err("agent_worktree_unknown".into());
                        };
                        serde_json::from_value(value).map_err(|_| "agent_worktree_unknown")?
                    }
                    Err(_) => return Err("agent_worktree_unknown".into()),
                }
            }
        };
        let Some(source) = workspace::selected(
            self.workspace_roots.clone(),
            path,
            self.home.as_deref(),
            self.managed_worktrees.clone(),
        )
        .await?
        else {
            return Ok(None);
        };
        if allocation.session != session
            || allocation.fingerprint != operation.fingerprint
            || allocation.path != source.path
            || allocation.identity != source.identity
        {
            return Err("agent_worktree_allocation_conflict".into());
        }
        if std::path::Path::new(&source.path) != allocation.binding.source()
            || allocation.binding.source_identity() != &allocation.identity
        {
            return Ok(None);
        }
        let managed = self.managed_worktrees.clone();
        let binding = allocation.binding.clone();
        blocking(scope, &self.stop, move |cancel| {
            Worktrees::open(&managed)
                .and_then(|worktrees| worktrees.ensure(&binding, &cancel))
                .map_err(|_| "agent_worktree_materialization_unknown".into())
        })
        .await?;
        let path = allocation.binding.directory().to_owned();
        let (path, directory_identity) =
            maka_fs_tools::directory::capture(&path).map_err(|_| "agent_worktree_unavailable")?;
        let root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let directory = maka_fs_tools::directory::open(&path, &directory_identity)
            .map_err(|_| "agent_worktree_unavailable")?;
        let identity = maka_fs_tools::workspace::ensure_directory_identity(
            path.clone(),
            directory,
            root.canonical_path().to_owned(),
            root.control_directory().to_owned(),
            Some(allocation.binding.clone()),
        )
        .await
        .map_err(|_| "agent_worktree_initialization_unknown")?;
        let selected = Workspace {
            project_id: None,
            path: maka_fs_tools::workspace::project::host_path(&path)
                .map_err(|_| "agent_worktree_unavailable")?
                .to_owned(),
            directory_identity,
            identity,
            worktree: Some(Box::new(allocation.binding)),
        };
        workspace::validate(&self.workspace_roots, &selected, &self.managed_worktrees).await?;
        Ok(Some(selected))
    }
}
