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
use maka_agent_state::memory as stored;
use maka_capabilities::call::{Identity, Scope};
use maka_plugin_core::operation::RecoveryRef;

fn management(scope: &Scope) -> Result<(), String> {
    if !matches!(scope.identity, Identity::Native | Identity::Remote { .. }) {
        return Err("agent_memory_user_management_required".into());
    }
    Ok(())
}

async fn project_scope(
    path: &std::path::Path,
    observed: &maka_fs_tools::directory::Observation,
) -> Result<String, String> {
    let resolved = maka_fs_tools::workspace::project::resolve_selected(path)
        .await
        .map_err(|e| e.to_string())?;
    if resolved.path != path || &resolved.observation != observed {
        return Err("agent_memory_workspace_changed".into());
    }
    resolved.identity().map_err(|e| e.to_string())
}

impl Owner {
    fn memory_data(&self, scope: &Scope) -> Result<maka_event_log::root_store::DataWriter, String> {
        if let Some(execution) = scope.identity.agent() {
            self.store.data_writer_for_work(
                scope
                    .work_custody()
                    .ok_or("agent_work_unavailable")?
                    .as_ref(),
                &execution.session_id,
            )
        } else {
            self.store.data_writer()
        }
        .map_err(|e| e.to_string())
    }
    pub(crate) async fn memory_history(
        self: &Arc<Self>,
        input: MemoryHistoryRead,
        scope: &Scope,
    ) -> Result<MemoryHistoryPage, String> {
        management(scope)?;
        if !(1..=100).contains(&input.limit) {
            return Err("agent_memory_page_limit".into());
        }
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let scope = owner.memory_scope(input.scope).await?;
                let mut versions = owner
                    .store
                    .data_writer()
                    .map_err(|e| e.to_string())?
                    .query(stored::History {
                        scope,
                        id: input.id,
                        after: input.after,
                        limit: input.limit + 1,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let next = if versions.len() > input.limit as usize {
                    versions.pop();
                    versions.last().map(|r| r.revision)
                } else {
                    None
                };
                Ok(MemoryHistoryPage { versions, next })
            })
        })
        .await
    }

    async fn memory_scope(&self, requested: MemoryScope) -> Result<stored::Scope, String> {
        let mut binding = None;
        let location = match requested {
            MemoryScope::Personal => "personal".into(),
            MemoryScope::Project { session_id } => {
                let session = self.session(&session_id).await?;
                binding = Some((session_id, session.configuration.permission_basis()));
                let workspace = &session.configuration.workspace;
                let (path, _directory, observed) = workspace::open_workspace_observation(
                    &self.workspace_roots,
                    workspace,
                    &self.managed_worktrees,
                )
                .await?;
                project_scope(&path, &observed).await?
            }
        };
        Ok(stored::Scope {
            namespace: serde_json::to_string(&self.run_owner()).map_err(|e| e.to_string())?,
            location,
            binding,
        })
    }
    async fn memory_read_access(
        &self,
        scope: &Scope,
        requested: &MemoryScope,
    ) -> Result<(), String> {
        if let Some(execution) = scope.identity.agent() {
            let access = self.access_for_scope(scope).await?;
            if matches!(requested,MemoryScope::Project{session_id} if session_id!=&execution.session_id)
            {
                return Err("agent_memory_scope_denied".into());
            }
            let policy = self
                .configuration
                .runtime_policy()
                .await
                .map_err(|e| e.to_string())?
                .policy
                .memory;
            if !policy.enabled || !policy.agent_read_enabled {
                return Err("agent_memory_read_disabled".into());
            }
            let session = self.session(&execution.session_id).await?;
            if session.configuration.parent_session_id.is_some()
                || session.configuration.tools.is_some()
                || !matches!(
                    access.spec().origin,
                    maka_agent_facts::durable::RunOrigin::Local
                )
            {
                return Err("agent_memory_model_read_not_admitted".into());
            }
            return Ok(());
        }
        management(scope)
    }
    pub(crate) async fn memories(
        self: &Arc<Self>,
        input: MemoriesRead,
        scope: &Scope,
    ) -> Result<MemoryPage, String> {
        self.memory_read_access(scope, &input.scope).await?;
        if !(1..=100).contains(&input.limit) {
            return Err("agent_memory_page_limit".into());
        }
        self.resource_work(scope, move |owner, call| {
            Box::pin(async move {
                owner.memory_read_access(&call, &input.scope).await?;
                let scope = owner.memory_scope(input.scope).await?;
                let mut records = owner
                    .memory_data(&call)?
                    .query(stored::Page {
                        scope,
                        after: input.after,
                        limit: input.limit + 1,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let next = if records.len() > input.limit as usize {
                    records.pop();
                    records.last().map(|r| r.id.clone())
                } else {
                    None
                };
                Ok(MemoryPage { records, next })
            })
        })
        .await
    }
    pub(crate) async fn memory(
        self: &Arc<Self>,
        input: MemoryRead,
        scope: &Scope,
    ) -> Result<Option<MemoryRecord>, String> {
        self.memory_read_access(scope, &input.scope).await?;
        self.resource_work(scope, move |owner, call| {
            Box::pin(async move {
                owner.memory_read_access(&call, &input.scope).await?;
                let scope = owner.memory_scope(input.scope).await?;
                owner
                    .memory_data(&call)?
                    .query(stored::Read {
                        scope,
                        id: input.id,
                    })
                    .await
                    .map_err(|e| e.to_string())
            })
        })
        .await
    }
    pub(crate) async fn change_memory(
        self: &Arc<Self>,
        input: MemoryChange,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<MemoryResult>, String> {
        management(scope)?;
        let operation = operation.operation;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let scope = owner.memory_scope(input.scope).await?;
                let writer = owner.store.data_writer().map_err(|e| e.to_string())?;
                let change = writer
                    .prepare_result(|_| {
                        Ok(stored::UserChange {
                            scope,
                            edit: input.edit,
                            operation,
                            at: i64::try_from(now()).map_err(|e| {
                                maka_event_log::StoreError::InvalidTransition(e.to_string())
                            })?,
                        })
                    })
                    .map_err(|e| e.to_string())?;
                Ok(NativeMutation::Computed { change })
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::project_scope;

    #[tokio::test]
    async fn project_scope_rejects_directory_replacement_after_authorization() {
        let base = tempfile::tempdir().unwrap();
        let path = base.path().join("selected");
        std::fs::create_dir(&path).unwrap();
        let (path, _held, observed) = maka_fs_tools::directory::capture_directory(&path).unwrap();
        assert!(project_scope(&path, &observed).await.is_ok());
        std::fs::rename(&path, base.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(
            project_scope(&path, &observed).await.unwrap_err(),
            "agent_memory_workspace_changed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_scope_rejects_redirection_after_authorization() {
        let base = tempfile::tempdir().unwrap();
        let path = base.path().join("selected");
        let other = base.path().join("other-project");
        std::fs::create_dir(&path).unwrap();
        std::fs::create_dir(&other).unwrap();
        let (path, _held, observed) = maka_fs_tools::directory::capture_directory(&path).unwrap();
        std::fs::rename(&path, base.path().join("original")).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert_eq!(
            project_scope(&path, &observed).await.unwrap_err(),
            "agent_memory_workspace_changed"
        );
    }
}
