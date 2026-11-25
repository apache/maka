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
    pub(super) fn check_pinned_model(
        &self,
        session: &str,
        basis: &CapturedRun,
    ) -> Result<(), String> {
        if let Some(memory) = &basis.memory {
            let model = basis.model.as_ref().ok_or("agent_memory_executor_unavailable: executor lacks a per-provider-send revocation check")?;
            let catalog = self.selected_tools(session, basis, model.editing_tools)?;
            let tokens = self.tool_catalog.fixed_schema_tokens(
                model,
                basis.tool_discovery,
                catalog.definitions(),
            );
            memory.check_admitted_window(model.input_limit, basis.behavior.as_ref(), tokens)?;
        }
        Ok(())
    }

    pub(super) fn memory_admission(
        &self,
        session: &str,
        configuration: &ResolvedConfiguration,
        user_run: bool,
        policy: &RuntimePolicySnapshot,
    ) -> maka_agent_facts::memory::MemoryAdmission {
        use maka_agent_facts::memory::MemoryAdmission;
        if !user_run
            || self.bot.is(session)
            || configuration.incognito
            || configuration.parent_session_id.is_some()
            || configuration.tools.is_some()
        {
            return MemoryAdmission::Excluded;
        }
        if !policy.policy.memory.enabled || !policy.policy.memory.agent_read_enabled {
            return MemoryAdmission::Disabled;
        }
        MemoryAdmission::Enabled
    }

    pub(super) async fn admit_memory(
        &self,
        session: &str,
        configuration: &ResolvedConfiguration,
        user_run: bool,
        policy: &RuntimePolicySnapshot,
    ) -> Result<
        (
            maka_agent_facts::memory::MemoryAdmission,
            Option<Arc<MemoryProjection>>,
        ),
        String,
    > {
        let admission = self.memory_admission(session, configuration, user_run, policy);
        let memory = if admission == maka_agent_facts::memory::MemoryAdmission::Enabled {
            self.capture_pinned(session, configuration, policy.revision)
                .await?
        } else {
            None
        };
        Ok((admission, memory))
    }

    pub(super) async fn capture_pinned(
        &self,
        session: &str,
        configuration: &ResolvedConfiguration,
        policy_revision: u64,
    ) -> Result<Option<Arc<MemoryProjection>>, String> {
        let capture = self
            .pin_capture(session, configuration, policy_revision)
            .await?;
        self.store
            .data_writer()
            .map_err(|e| e.to_string())?
            .query(capture)
            .await
            .map(|memory| memory.map(Arc::new))
            .map_err(|e| e.to_string())
    }

    pub(super) async fn pin_capture(
        &self,
        session: &str,
        configuration: &ResolvedConfiguration,
        policy_revision: u64,
    ) -> Result<stored::pinned::ProjectionCapture, String> {
        Ok(stored::pinned::ProjectionCapture {
            scopes: stored::pinned::Capture {
                project: self.project_memory_scope(session, configuration).await?,
                personal: self.memory_scope(MemoryScope::Personal).await?,
                at: now() as i64,
            },
            policy_revision,
        })
    }

    pub(crate) async fn loaded_memories(
        self: &Arc<Self>,
        input: LoadedMemoriesRead,
        scope: &Scope,
    ) -> Result<Vec<LoadedMemory>, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                owner.session(&input.session_id).await?;
                let source = owner
                    .durable
                    .session_history(owner.run_owner(), input.session_id)
                    .run_source(input.run_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let Some(reference) = source.spec.memory_projection else {
                    return Ok(Vec::new());
                };
                let projection: MemoryProjection = owner
                    .run_content(source.run, &reference)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(projection
                    .entries
                    .into_iter()
                    .map(|entry| entry.loaded)
                    .collect())
            })
        })
        .await
    }

    pub(crate) fn memory_data(
        &self,
        scope: &Scope,
    ) -> Result<maka_event_log::root_store::DataWriter, String> {
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
    pub(crate) async fn memory_source(
        self: &Arc<Self>,
        selection: MemorySourceSelection,
        scope: &Scope,
    ) -> Result<MemoryEvidenceReference, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let scope = owner
                    .memory_scope(MemoryScope::Project {
                        session_id: selection.session_id.clone(),
                    })
                    .await?;
                owner
                    .store
                    .data_writer()
                    .map_err(|e| e.to_string())?
                    .query(stored::CaptureEvidence { scope, selection })
                    .await
                    .map_err(|e| e.to_string())
            })
        })
        .await
    }
    pub(crate) async fn memory_evidence(
        self: &Arc<Self>,
        input: MemoryEvidenceRead,
        scope: &Scope,
    ) -> Result<MemoryEvidencePage, String> {
        management(scope)?;
        if !(1..=100).contains(&input.limit) {
            return Err("agent_memory_page_limit".into());
        }
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let scope = owner.memory_scope(input.scope).await?;
                let mut evidence = owner
                    .store
                    .data_writer()
                    .map_err(|e| e.to_string())?
                    .query(stored::Evidence {
                        scope,
                        id: input.id,
                        assertion: input.assertion,
                        after: input.after,
                        limit: input.limit + 1,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let next = if evidence.len() > input.limit as usize {
                    evidence.pop();
                    evidence.last().map(|e| e.id)
                } else {
                    None
                };
                Ok(MemoryEvidencePage { evidence, next })
            })
        })
        .await
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

    pub(super) async fn memory_scope(
        &self,
        requested: MemoryScope,
    ) -> Result<stored::Scope, String> {
        match requested {
            MemoryScope::Personal => Ok(stored::Scope {
                namespace: serde_json::to_string(&self.run_owner()).map_err(|e| e.to_string())?,
                location: "personal".into(),
                binding: None,
            }),
            MemoryScope::Project { session_id } => {
                let session = self.session(&session_id).await?;
                self.project_memory_scope(&session_id, &session.configuration)
                    .await
            }
        }
    }

    pub(super) async fn project_memory_scope(
        &self,
        session: &str,
        configuration: &ResolvedConfiguration,
    ) -> Result<stored::Scope, String> {
        let (path, _directory, observed) = workspace::open_workspace_observation(
            &self.workspace_roots,
            &configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        Ok(stored::Scope {
            namespace: serde_json::to_string(&self.run_owner()).map_err(|e| e.to_string())?,
            location: project_scope(&path, &observed).await?,
            binding: Some((session.into(), configuration.permission_basis())),
        })
    }

    pub(super) async fn memory_read_access(
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
            if session.configuration.incognito {
                return Err("agent_memory_incognito".into());
            }
            if !matches!(
                access.spec().backend,
                maka_agent_facts::durable::BackendSpec::Model { .. }
            ) {
                return Err("agent_memory_executor_unavailable".into());
            }
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
    pub(crate) async fn history_read_start(&self, call: &Scope) -> Result<Option<u64>, String> {
        if call.identity.agent().is_none() {
            return Ok(None);
        }
        self.memory_data(call)?
            .query(stored::reads::SearchVisibility)
            .await
            .map(Some)
            .map_err(|e| e.to_string())
    }
    pub(crate) async fn record_history_read(
        &self,
        call: &Scope,
        session: &str,
        before: Option<u64>,
    ) -> Result<Option<u64>, String> {
        self.record_history_sources(
            call,
            stored::reads::HistorySources::session(session),
            before,
        )
        .await
    }
    pub(crate) async fn record_history_sources(
        &self,
        call: &Scope,
        sources: stored::reads::HistorySources,
        before: Option<u64>,
    ) -> Result<Option<u64>, String> {
        if let Some(execution) = call.identity.agent() {
            return self
                .memory_data(call)?
                .write(stored::reads::RecordHistory {
                    sources,
                    before,
                    owner: self.run_owner(),
                    execution: execution.clone(),
                })
                .await
                .map(Some)
                .map_err(|e| e.to_string());
        }
        Ok(None)
    }
    pub(super) async fn record_memory_reads(
        &self,
        call: &Scope,
        scope: stored::Scope,
        facts: Vec<LoadedMemory>,
    ) -> Result<(), String> {
        if let Some(execution) = call.identity.agent()
            && !facts.is_empty()
        {
            self.memory_data(call)?
                .write(stored::reads::RecordFacts {
                    run: execution.run_id,
                    scope,
                    facts,
                })
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
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
                        scope: scope.clone(),
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
                if call.identity.agent().is_some() {
                    let facts = records
                        .iter()
                        .map(|r| LoadedMemory::from_record(&scope.location, r))
                        .collect();
                    owner.record_memory_reads(&call, scope, facts).await?;
                }
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
                let record = owner
                    .memory_data(&call)?
                    .query(stored::Read {
                        scope: scope.clone(),
                        id: input.id,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(r) = &record
                    && call.identity.agent().is_some()
                {
                    let fact = LoadedMemory::from_record(&scope.location, r);
                    owner.record_memory_reads(&call, scope, vec![fact]).await?;
                }
                Ok(record)
            })
        })
        .await
    }
    pub(crate) async fn pending_memories(
        self: &Arc<Self>,
        input: MemoriesRead,
        call: &Scope,
    ) -> Result<MemoryPage, String> {
        management(call)?;
        if !(1..=100).contains(&input.limit) {
            return Err("agent_memory_page_limit".into());
        }
        self.resource_work(call, move |owner, call| {
            Box::pin(async move {
                let scope = owner.memory_scope(input.scope).await?;
                let mut records = owner
                    .memory_data(&call)?
                    .query(stored::PendingPage(stored::Page {
                        scope,
                        after: input.after,
                        limit: input.limit + 1,
                    }))
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
    pub(crate) async fn change_memory(
        self: &Arc<Self>,
        input: MemoryChange,
        operation: &RecoveryRef,
        scope: &Scope,
        dispatch: maka_event_log::applications::operations::OperationDispatchScope,
    ) -> Result<NativeMutation<MemoryResult>, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, call| {
            Box::pin(async move {
                let request = ReconcileMemories {
                    scope: input.scope,
                    writes: vec![MemoryWrite {
                        edit: input.edit,
                        evidence: None,
                    }],
                    resolution: input.resolution,
                };
                match owner
                    .prepare_memory_resolution(request, &operation, &call, dispatch)
                    .await?
                {
                    Ok(commit) => {
                        let writer = owner.memory_data(&call)?;
                        let change = writer
                            .prepare_result(|_| Ok(stored::resolution::SingleCommit(commit)))
                            .map_err(|e| e.to_string())?;
                        Ok(NativeMutation::Computed { change })
                    }
                    Err(reason) => Ok(NativeMutation::Returned(MemoryResult::Retryable { reason })),
                }
            })
        })
        .await
    }
    pub(crate) async fn reconcile_memories(
        self: &Arc<Self>,
        input: ReconcileMemories,
        operation: &RecoveryRef,
        scope: &Scope,
        dispatch: maka_event_log::applications::operations::OperationDispatchScope,
    ) -> Result<NativeMutation<MemoryBatchResult>, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, call| {
            Box::pin(async move {
                match owner
                    .prepare_memory_resolution(input, &operation, &call, dispatch)
                    .await?
                {
                    Ok(commit) => {
                        let writer = owner.memory_data(&call)?;
                        let change = writer
                            .prepare_result(|_| Ok(commit))
                            .map_err(|e| e.to_string())?;
                        Ok(NativeMutation::Computed { change })
                    }
                    Err(reason) => Ok(NativeMutation::Returned(MemoryBatchResult::Retryable {
                        reason,
                    })),
                }
            })
        })
        .await
    }
    async fn prepare_memory_resolution(
        self: &Arc<Self>,
        input: ReconcileMemories,
        operation: &RecoveryRef,
        call: &Scope,
        dispatch: maka_event_log::applications::operations::OperationDispatchScope,
    ) -> Result<Result<stored::resolution::Commit, String>, String> {
        stored::resolution::validate(&input.writes).map_err(|e| e.to_string())?;
        let project = matches!(&input.scope, MemoryScope::Project { .. });
        let scope = self.memory_scope(input.scope).await?;
        let mut source_scopes = Vec::new();
        for write in &input.writes {
            let reference = write.evidence.as_ref().or(match &write.edit {
                MemoryEdit::AddEvidence { reference, .. } => Some(reference),
                _ => None,
            });
            if let Some(reference) = reference {
                let source = self.session(&reference.session_id).await?;
                if source.configuration.incognito {
                    return Err("agent_memory_incognito_source".into());
                }
                let origin = self
                    .memory_scope(MemoryScope::Project {
                        session_id: reference.session_id.clone(),
                    })
                    .await?;
                if project && scope.location != origin.location {
                    return Err("agent_memory_evidence_scope".into());
                }
                source_scopes.push(origin);
            }
        }
        if let Some(resolution) = &input.resolution {
            let session = self.scoped_session(call, &resolution.session_id).await?;
            if session.configuration.incognito {
                return Err("agent_memory_incognito".into());
            }
            source_scopes.push(
                self.memory_scope(MemoryScope::Project {
                    session_id: resolution.session_id.clone(),
                })
                .await?,
            );
        }
        let writer = self.memory_data(call)?;
        for attempt in 0..2 {
            let snapshot = writer
                .query(stored::resolution::Inspect {
                    scope: scope.clone(),
                    writes: input.writes.clone(),
                })
                .await
                .map_err(|e| e.to_string())?;
            let decisions = match snapshot.deterministic(&input.writes) {
                Some(decisions) => decisions,
                None => {
                    let Some(resolution) = input.resolution.clone() else {
                        return Ok(Err("semantic comparison requires resolution.sessionId and resolution.model".into()));
                    };
                    let prompt = serde_json::to_string(
                        &serde_json::json!({"writes":input.writes,"snapshot":snapshot}),
                    )
                    .map_err(|e| e.to_string())?;
                    if prompt.len() > 40000 {
                        return Ok(Err("memory semantic input budget exceeded".into()));
                    }
                    self.memory_judgments(
                        call,
                        resolution,
                        operation.clone(),
                        dispatch.clone(),
                        prompt,
                        attempt,
                    )
                    .await?
                }
            };
            let current = writer
                .query(stored::resolution::Inspect {
                    scope: scope.clone(),
                    writes: input.writes.clone(),
                })
                .await
                .map_err(|e| e.to_string())?;
            if current.revision != snapshot.revision {
                if attempt == 0 {
                    continue;
                }
                return Ok(Err(
                    "memory scope changed during both resolution attempts".into()
                ));
            }
            return Ok(Ok(stored::resolution::Commit {
                scope,
                source_scopes,
                writes: input.writes,
                snapshot,
                decisions,
                operation: operation.operation,
                at: i64::try_from(now()).map_err(|e| e.to_string())?,
            }));
        }
        unreachable!()
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
