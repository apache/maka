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

//! Immutable patch bytes and their original canonical capture provenance.
use super::*;
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource, workspace_patch_id},
    durable::{ExecutionIdentity, RunId, RunOwner},
};
use maka_agent_state::{
    ContentBlob,
    artifacts::{SessionArtifactWrite, SessionScope},
    session_history::HistoryCut,
};
use maka_capabilities::call::Scope;
use maka_event_log::sessions::{CatalogFilter, CatalogScope, SessionPosition};
use maka_plugin_core::operation::RecoveryRef;

#[derive(Clone, Debug, PartialEq, Serialize)]
struct PatchMember {
    session: String,
    metadata_revision: u64,
    configuration_digest: String,
    cut: HistoryCut,
    latest: Option<ExecutionIdentity>,
}
#[derive(Serialize)]
struct PatchOrigin {
    kind: &'static str,
    schema_version: u32,
    owner: RunOwner,
    producer: ExecutionIdentity,
    operation: RecoveryRef,
    workspace: Workspace,
    permission_basis: maka_sandbox::workspace::PermissionBasis,
    members: Vec<PatchMember>,
}
#[derive(Deserialize)]
struct PatchHeader {
    kind: String,
    schema_version: u32,
    owner: RunOwner,
    producer: ExecutionIdentity,
    workspace: Workspace,
    #[serde(rename = "members")]
    _members: serde::de::IgnoredAny,
}
fn patch_id(session: &str, run: RunId) -> String {
    workspace_patch_id(session, &run.to_string())
}
fn identity(execution: &Execution) -> ExecutionIdentity {
    ExecutionIdentity {
        session_id: execution.session_id.clone(),
        turn_id: execution.turn_id.clone(),
        run_id: execution.run_id,
    }
}
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
    async fn patch_record(&self, execution: &Execution) -> Result<Option<WorkspacePatch>, String> {
        let scope = SessionScope {
            owner: self.run_owner(),
            session: execution.session_id.clone(),
        };
        let id = patch_id(&execution.session_id, execution.run_id);
        let expected = identity(execution);
        let owner = scope.owner.clone();
        let stored = self
            .durable
            .artifacts()
            .with_provenance(scope.clone(), id.clone(), move |record, reader| {
                let header: PatchHeader = serde_json::from_reader(std::io::BufReader::new(reader))
                    .map_err(|error| format!("agent_patch_provenance_invalid: {error}"))?;
                if header.kind != "workspace_patch"
                    || header.schema_version != 1
                    || header.owner != owner
                    || header.producer != expected
                    || record.source != ArtifactSource::SubagentWriteback
                    || record.session_id != expected.session_id
                    || record.turn_id != expected.turn_id
                    || record.id != patch_id(&expected.session_id, expected.run_id)
                {
                    return Err("agent_patch_conflict".into());
                }
                let binding = header
                    .workspace
                    .worktree
                    .as_ref()
                    .ok_or("agent_patch_provenance_invalid")?;
                Ok::<_, String>(descriptor(record.clone(), binding.base_commit()))
            })
            .await
            .map_err(|error| error.to_string())?;
        match stored {
            Some(result) => result.map(Some),
            None => {
                if self
                    .durable
                    .artifacts()
                    .get(scope, id)
                    .await
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    Err("agent_patch_original_provenance_unavailable".into())
                } else {
                    Ok(None)
                }
            }
        }
    }
    pub async fn read_patch(&self, input: PatchRead, scope: &Scope) -> Result<PatchPage, String> {
        self.scoped_session(scope, &input.execution.session_id)
            .await?;
        let ExecutionResult::Found { execution } = self.execution(input.execution).await? else {
            return Ok(PatchPage::Unavailable);
        };
        let Some(patch) = self.patch_record(&execution).await? else {
            return Ok(PatchPage::Unavailable);
        };
        let chunk = self
            .durable
            .artifacts()
            .chunk(
                SessionScope {
                    owner: self.run_owner(),
                    session: patch.session_id.clone(),
                },
                patch.artifact_id.clone(),
                input.offset,
                8192,
            )
            .await
            .map_err(|error| error.to_string())?
            .ok_or("agent_patch_unavailable")?;
        let text = patch_text(&chunk.bytes)?;
        let end = input.offset + text.len() as u64;
        self.scoped_session(scope, &patch.session_id).await?;
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
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<PatchResult>, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.capture_patch(input, operation, &scope).await })
        })
        .await
    }
    async fn capture_patch(
        &self,
        input: ExecutionRead,
        operation: RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<PatchResult>, String> {
        let returned = |value| Ok(NativeMutation::Returned(value));
        let session = self.scoped_session(scope, &input.session_id).await?;
        let Some(view) = self.session_run(&input.session_id, input.run_id).await? else {
            return returned(PatchResult::Unavailable);
        };
        let execution = execution::project(&view);
        if let Some(patch) = self.patch_record(&execution).await? {
            return returned(PatchResult::Ready { patch });
        }
        let original = session.configuration;
        let workspace = original.workspace.clone();
        if view.spec.workspace != workspace.path
            || view.spec.permission_basis.binding.id != original.binding.id
        {
            return returned(PatchResult::Changed);
        }
        let Some(binding) = workspace.worktree.clone() else {
            return returned(PatchResult::Unavailable);
        };
        if !ended(&execution.state) {
            return returned(PatchResult::Busy);
        }
        self.check_patch_workspace(scope, &session.id, &original)
            .await?;
        let Some(fence) = self.patch_fence(&workspace.path).await? else {
            return returned(PatchResult::Busy);
        };
        if fence
            .iter()
            .find(|member| member.session == session.id)
            .and_then(|member| member.latest.as_ref())
            .is_none_or(|latest| latest != &identity(&execution))
        {
            return returned(PatchResult::Changed);
        }
        let capture = binding.clone();
        let root = self.managed_worktrees.clone();
        let bytes = worktrees::blocking(scope, &self.stop, move |cancel| {
            maka_fs_tools::worktree::Worktrees::open(&root)
                .and_then(|worktrees| worktrees.capture_patch(&capture, cancel))
                .map_err(|error| format!("agent_patch_capture_unavailable: {error}"))
        })
        .await?;
        self.check_patch_workspace(scope, &session.id, &original)
            .await?;
        if self.patch_fence(&workspace.path).await?.as_ref() != Some(&fence) {
            return returned(PatchResult::Changed);
        }
        if let Some(patch) = self.patch_record(&execution).await? {
            return returned(PatchResult::Ready { patch });
        }
        let record = Artifact {
            id: patch_id(&execution.session_id, execution.run_id),
            session_id: execution.session_id.clone(),
            turn_id: execution.turn_id.clone(),
            created_at: now(),
            name: "workspace.patch".into(),
            kind: ArtifactKind::Diff,
            size_bytes: bytes.len() as u64,
            mime_type: Some("text/x-diff".into()),
            source: ArtifactSource::SubagentWriteback,
            summary: Some(format!("Changes relative to {}", binding.base_commit())),
        };
        let origin = PatchOrigin {
            kind: "workspace_patch",
            schema_version: 1,
            owner: self.run_owner(),
            producer: identity(&execution),
            operation: operation.clone(),
            workspace,
            permission_basis: original.permission_basis(),
            members: fence,
        };
        let provenance = tokio::task::spawn_blocking(move || ContentBlob::json(&origin))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let patch = descriptor(record.clone(), binding.base_commit());
        let change = self
            .durable
            .artifacts()
            .prepare_register(SessionArtifactWrite::new(
                SessionScope {
                    owner: self.run_owner(),
                    session: execution.session_id,
                },
                self.operation_id(&operation),
                record,
                bytes,
                provenance,
            ));
        Ok(NativeMutation::Commit {
            value: PatchResult::Ready { patch },
            change,
        })
    }
    async fn check_patch_workspace(
        &self,
        scope: &Scope,
        session: &str,
        original: &ResolvedConfiguration,
    ) -> Result<(), String> {
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_patch_cancelled".into());
        }
        let current = self.scoped_session(scope, session).await?.configuration;
        if current.workspace != original.workspace
            || current.permission_basis() != original.permission_basis()
        {
            return Err("agent_patch_workspace_changed".into());
        }
        workspace::validate(
            &self.workspace_roots,
            &current.workspace,
            &self.managed_worktrees,
        )
        .await
    }
    async fn patch_fence(&self, path: &str) -> Result<Option<Vec<PatchMember>>, String> {
        let selection = CatalogScope::Workspace(path.into());
        let filter = CatalogFilter {
            roots_only: false,
            archived_only: false,
            include_archived: true,
        };
        let mut revision = None;
        let mut after: Option<String> = None;
        let mut members = Vec::new();
        loop {
            // Generic Root metadata locates the actual binding; Agent facts stay in State.
            let page = self
                .store
                .scoped_sessions::<Value>(
                    selection.clone(),
                    revision.as_deref(),
                    after
                        .as_deref()
                        .map_or(SessionPosition::Start, SessionPosition::After),
                    filter,
                )
                .await
                .map_err(|error| error.to_string())?;
            revision = Some(page.revision);
            for member in page.sessions {
                let busy = {
                    let runs = self.runs.state().await;
                    runs.closing || runs.busy(&member.id)
                };
                if !self.owns(&member.id) || busy {
                    return Ok(None);
                }
                let status = self
                    .canonical_catalog()?
                    .record(&member.id)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("agent_patch_member_unavailable")?
                    .status;
                if status.working || status.unknown_effects || status.cleanup_pending {
                    return Ok(None);
                }
                if self
                    .store
                    .session(&member.id)
                    .await
                    .map_err(|error| error.to_string())?
                    .has_unsettled_shells(&member.id)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    return Ok(None);
                }
                let history = self
                    .durable
                    .session_history(self.run_owner(), member.id.clone());
                let cut = history.capture().await.map_err(|error| error.to_string())?;
                let latest = history
                    .latest(&cut)
                    .await
                    .map_err(|error| error.to_string())?
                    .map(|source| source.execution());
                members.push(PatchMember {
                    session: member.id,
                    metadata_revision: member.revision,
                    configuration_digest: member.configuration_digest,
                    cut,
                    latest,
                });
            }
            let Some(cursor) = page.next_cursor else {
                break;
            };
            after = Some(cursor);
        }
        if self
            .store
            .catalog_revision(selection, filter)
            .await
            .map_err(|error| error.to_string())?
            != revision.ok_or("agent_patch_catalog_unavailable")?
        {
            return Ok(None);
        }
        members.sort_by(|left, right| left.session.cmp(&right.session));
        Ok(Some(members))
    }
}
fn patch_text(bytes: &[u8]) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_owned()),
        Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => {
            Ok(std::str::from_utf8(&bytes[..error.valid_up_to()])
                .expect("valid UTF-8 prefix")
                .to_owned())
        }
        Err(_) => Err("agent_patch_offset_invalid".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_patch_pages_keep_unread_suffix_and_reject_interior_offsets() {
        let original = format!("{}附件末尾", "x".repeat(8191));
        let first = patch_text(&original.as_bytes()[..8192]).unwrap();
        let tail = patch_text(&original.as_bytes()[first.len()..]).unwrap();
        assert_eq!(format!("{first}{tail}"), original);
        assert_eq!(
            patch_text(&original.as_bytes()[8192..]).unwrap_err(),
            "agent_patch_offset_invalid"
        );
    }
}
