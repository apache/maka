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

//! Original immutable patch artifacts, captured only after every workspace writer settles.
use super::*;
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::artifact::workspace_patch_id;
use maka_capabilities::call::Scope;

fn ended(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed | ExecutionState::Failed | ExecutionState::Cancelled
    )
}
fn descriptor(record: Artifact, base: &str) -> WorkspacePatch {
    WorkspacePatch {
        artifact_id: record.id,
        session_id: record.session_id,
        turn_id: record.turn_id,
        base_commit: base.into(),
        bytes: record.size_bytes,
    }
}
impl Owner {
    async fn patch_record(
        &self,
        execution: &Execution,
        base: &str,
    ) -> Result<Option<WorkspacePatch>, String> {
        let id = workspace_patch_id(&execution.session_id, &execution.turn_id);
        let record = self
            .store
            .session(&execution.session_id)
            .await
            .map_err(|error| error.to_string())?
            .get_artifact(&execution.session_id, &id)
            .await
            .map_err(|_| "agent_patch_unavailable")?
            .record;
        record
            .map(|record| {
                if record.source != ArtifactSource::SubagentWriteback
                    || record.turn_id != execution.turn_id
                {
                    return Err("agent_patch_conflict".into());
                }
                Ok(descriptor(record, base))
            })
            .transpose()
    }
    pub async fn read_patch(&self, input: PatchRead) -> Result<PatchPage, String> {
        let session = self.session(&input.execution.session_id).await?;
        let Some(binding) = session.configuration.workspace.worktree else {
            return Ok(PatchPage::Unavailable);
        };
        let ExecutionResult::Found { execution } = self.execution(input.execution).await? else {
            return Ok(PatchPage::Unavailable);
        };
        let Some(patch) = self.patch_record(&execution, binding.base_commit()).await? else {
            return Ok(PatchPage::Unavailable);
        };
        let chunk = self
            .store
            .session(&patch.session_id)
            .await
            .map_err(|error| error.to_string())?
            .read_artifact_chunk(&patch.session_id, &patch.artifact_id, input.offset, 8192)
            .await
            .map_err(|_| "agent_patch_unavailable")?
            .ok_or("agent_patch_unavailable")?;
        let text = match std::str::from_utf8(&chunk.bytes) {
            Ok(text) => text,
            Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => {
                std::str::from_utf8(&chunk.bytes[..error.valid_up_to()])
                    .map_err(|_| "agent_patch_unavailable")?
            }
            Err(_) => return Err("agent_patch_offset_invalid".into()),
        }
        .to_owned();
        let end = input.offset + text.len() as u64;
        Ok(PatchPage::Ready {
            patch,
            offset: input.offset,
            next: (end < chunk.total_bytes).then_some(end),
            text,
        })
    }
    pub async fn snapshot_patch(
        self: &Arc<Self>,
        input: ExecutionRead,
        scope: &Scope,
    ) -> Result<PatchResult, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.capture_patch(input, &scope).await })
        })
        .await
    }
    async fn capture_patch(
        &self,
        input: ExecutionRead,
        scope: &Scope,
    ) -> Result<PatchResult, String> {
        let runs = self.runs.lock().await;
        let session = self.session(&input.session_id).await?;
        let workspace = session.configuration.workspace;
        let Some(binding) = workspace.worktree.clone() else {
            return Ok(PatchResult::Unavailable);
        };
        let ExecutionResult::Found { execution } = self.execution(input).await? else {
            return Ok(PatchResult::Unavailable);
        };
        if let Some(patch) = self.patch_record(&execution, binding.base_commit()).await? {
            return Ok(PatchResult::Ready { patch });
        }
        if runs.closing || !ended(&execution.state) {
            return Ok(PatchResult::Busy);
        }
        if self
            .store
            .session(&session.id)
            .await
            .map_err(|error| error.to_string())?
            .latest_turn_boundary(&session.id)
            .await
            .map_err(|_| "agent_patch_unavailable")?
            .is_none_or(|current| current.invocation.invocation_id != execution.invocation_id)
        {
            return Ok(PatchResult::Changed);
        }
        workspace::validate(&self.workspace_roots, &workspace, &self.managed_worktrees).await?;
        let Some(fence) = self.patch_fence(&workspace.path, &runs).await? else {
            return Ok(PatchResult::Busy);
        };
        drop(runs);
        let capture = binding.clone();
        let root = self.managed_worktrees.clone();
        let bytes = worktrees::blocking(scope, &self.stop, move |cancel| {
            maka_fs_tools::worktree::Worktrees::open(&root)
                .and_then(|worktrees| worktrees.capture_patch(&capture, cancel))
                .map_err(|_| "agent_patch_capture_unavailable".into())
        })
        .await?;
        let runs = self.runs.lock().await;
        if runs.closing || scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_patch_cancelled".into());
        }
        if let Some(patch) = self.patch_record(&execution, binding.base_commit()).await? {
            return Ok(PatchResult::Ready { patch });
        }
        if self.patch_fence(&workspace.path, &runs).await?.as_ref() != Some(&fence) {
            return Ok(PatchResult::Changed);
        }
        let record = Artifact {
            id: workspace_patch_id(&execution.session_id, &execution.turn_id),
            session_id: execution.session_id,
            turn_id: execution.turn_id,
            created_at: now(),
            name: "workspace.patch".into(),
            kind: ArtifactKind::Diff,
            size_bytes: bytes.len() as u64,
            mime_type: Some("text/x-diff".into()),
            source: ArtifactSource::SubagentWriteback,
            summary: Some(format!("Changes relative to {}", binding.base_commit())),
        };
        let record = self
            .store
            .session(&record.session_id)
            .await
            .map_err(|error| error.to_string())?
            .commit_artifact(record, bytes)
            .await
            .map_err(|_| "agent_patch_commit_unknown")?;
        Ok(PatchResult::Ready {
            patch: descriptor(record, binding.base_commit()),
        })
    }
    async fn patch_fence(
        &self,
        path: &str,
        runs: &Runs,
    ) -> Result<Option<maka_event_log::workspace::WorkspaceFence>, String> {
        let fence = self
            .store
            .workspace_fence(path)
            .await
            .map_err(|_| "agent_patch_unavailable")?;
        if fence.0.is_empty() {
            return Ok(None);
        }
        for member in &fence.0 {
            if !self.owns(&member.session_id)
                || member.orphaned_shells
                || runs.busy(&member.session_id)
                || self
                    .store
                    .session(&member.session_id)
                    .await
                    .map_err(|error| error.to_string())?
                    .has_unsettled_shells(&member.session_id)
                    .await
                    .map_err(|_| "agent_patch_unavailable")?
            {
                return Ok(None);
            }
            if let Some(latest) = self
                .store
                .session(&member.session_id)
                .await
                .map_err(|error| error.to_string())?
                .latest_turn_boundary(&member.session_id)
                .await
                .map_err(|_| "agent_patch_unavailable")?
                && latest.state.terminal_outcome().is_none()
            {
                return Ok(None);
            }
        }
        Ok(Some(fence))
    }
}
