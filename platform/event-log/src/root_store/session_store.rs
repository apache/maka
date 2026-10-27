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

//! Explicit session operations. Custody is acquired before dispatch and retained
//! by the SQL job; no partition log or SQL callback is exposed to callers.
use super::SessionStore;
use crate::archive::{PruneCandidates, PruneCursor};
use crate::artifacts::{ArtifactChunk, ArtifactEntry, ArtifactReadScope, ImageChunk};
use crate::context::prepared::*;
use crate::context::semantic::SemanticSelection;
use crate::context::{ContextReport, ContextUsage, ContextView, LatestMainContext, SourceEvidence};
use crate::interactions::{InteractionCommit, PermissionGrant};
use crate::message_admissions::PendingMessageAdmission;
use crate::message_interrupts::{InterruptCommand, InterruptReceipt};
use crate::message_queue::{MessageQueue, QueueCommand, QueueEdit, QueueReceipt};
use crate::message_sources::RootMessageProof;
use crate::observation::{
    MessageObservation, SessionObservation, SessionProjection, StreamEventPage, WorkOrigin,
};
use crate::run_source::RunSource;
use crate::sessions::{SessionMutation, SessionRecord};
use crate::shell_runs::ShellResourcePage;
use crate::transcript::search::{TranscriptSearch, TranscriptSearchBatch};
use crate::turns::TurnBoundary;
use crate::{SessionSubscription, StoreError};
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::composition::RequestComposition;
use maka_agent_facts::context::{CheckpointMode, PreparedContextBreakdown};
use maka_agent_facts::continuation::RunBoundary;
use maka_agent_facts::event::{
    CommitError, CommitFuture, EventSink, EventWrite, Invocation, StoredEvent,
};
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::history::media::MediaManifest;
use maka_agent_facts::history::semantic::ResolvedRow;
use maka_agent_facts::interaction::{
    ClosureReason, GrantTarget, InteractionOutcome, InteractionRecord, SessionGrant,
};
use maka_agent_facts::model::prompt::Message;
use maka_agent_facts::model::prompt_source::{WireFormat, WireGroup};
use maka_agent_facts::read::ResourceAddress;
use maka_agent_facts::shell_run::{ShellPatch, ShellRun};
use maka_agent_facts::workspace::PermissionBasis;
use maka_agent_ports::session::history::{
    HistorySource, HistoryView, Page, Position, SourcePosition,
};
use serde::de::DeserializeOwned;
use uuid::Uuid;

impl SessionStore {
    pub async fn list_artifacts(
        &self,
        session: &str,
        offset: u64,
        limit: usize,
    ) -> Result<crate::artifacts::ArtifactPage, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .list_artifacts(session, offset, limit)
            .await
    }

    pub async fn editable_message(
        &self,
        session: &str,
        turn: &str,
        message: &str,
    ) -> Result<Option<maka_agent_facts::message::EditableMessage>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .editable_message(session, turn, message)
            .await
    }

    pub async fn capture_lineage_context(
        &self,
        source: &RunBoundary,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<crate::context::ModelContextSource, StoreError> {
        self.check_session(&source.invocation.session_id)?;
        self.scoped()
            .await?
            .capture_lineage_context(source, max_events, max_bytes)
            .await
    }

    pub async fn commit_pending_steering(
        &self,
        invocation: &Invocation,
    ) -> Result<usize, CommitError> {
        self.check_session(&invocation.session_id)
            .map_err(commit_error)?;
        self.scoped()
            .await
            .map_err(commit_error)?
            .commit_pending_steering(invocation)
            .await
    }

    pub async fn continuation_for_source(
        &self,
        source: &RunBoundary,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.check_session(&source.invocation.session_id)?;
        self.scoped().await?.continuation_for_source(source).await
    }

    pub async fn diagnostics_page(
        &self,
        session: &str,
        through: Option<u64>,
        before: Option<u64>,
        max_entries: usize,
        max_bytes: usize,
    ) -> Result<crate::diagnostics::Page, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .diagnostics_page(session, through, before, max_entries, max_bytes)
            .await
    }

    pub async fn latest_diagnostic_sequence(
        &self,
        session: &str,
        through: u64,
    ) -> Result<Option<u64>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .latest_diagnostic_sequence(session, through)
            .await
    }

    pub async fn admit_message(
        &self,
        admission: PendingMessageAdmission,
    ) -> Result<PendingMessageAdmission, StoreError> {
        self.check_session(&admission.invocation.session_id)?;
        self.check_session(&admission.steering_target().session_id)?;
        self.scoped().await?.admit_message(admission).await
    }

    pub async fn message_admission(
        &self,
        session: &str,
        message: &str,
    ) -> Result<Option<PendingMessageAdmission>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .message_admission(session, message)
            .await
    }

    pub async fn check_handoff(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        pause: &maka_agent_facts::handoff::HandoffPause,
    ) -> Result<(), StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped().await?.check_handoff(invocation, pause).await
    }

    pub async fn run_source(
        &self,
        session: &str,
        run: &str,
        up_to: Option<u64>,
    ) -> Result<Option<RunSource>, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.run_source(session, run, up_to).await
    }

    pub async fn get_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        self.check_session(id)?;
        self.scoped().await?.get_session(id).await
    }

    pub async fn session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.session_projection(session_id).await
    }

    /// Read the canonical partition-wide sequence under this Session's custody.
    pub async fn committed_sequence(&self) -> Result<u64, StoreError> {
        self.scoped().await?.committed_sequence().await
    }

    pub async fn observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.observe_session(session_id).await
    }

    pub async fn tool_dispatch_fence(
        &self,
        context: &maka_agent_facts::tools::ToolCallContext,
        name: &str,
        input: &serde_json::Value,
    ) -> Result<u64, StoreError> {
        self.check_session(&context.invocation.session_id)?;
        self.scoped()
            .await?
            .tool_dispatch_fence(context, name, input)
            .await
    }

    pub async fn resolve_read_resource(
        &self,
        session: &str,
        address: ResourceAddress,
    ) -> Result<Option<ResourceAddress>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .resolve_read_resource(session, address)
            .await
    }

    pub async fn establish_run_interaction(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        request: &InteractionRecord,
    ) -> Result<InteractionCommit, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.check_session(&request.session_id)?;
        self.scoped()
            .await?
            .establish_run_interaction(invocation, request)
            .await
    }

    pub async fn commit_interaction_outcome(
        &self,
        request_id: &str,
        outcome: InteractionOutcome,
    ) -> Result<InteractionCommit, StoreError> {
        self.scoped()
            .await?
            .commit_interaction_outcome(request_id, outcome)
            .await
    }

    pub async fn interaction(
        &self,
        request_id: &str,
    ) -> Result<Option<InteractionRecord>, StoreError> {
        self.scoped().await?.interaction(request_id).await
    }

    pub async fn pending_interactions(
        &self,
        session_id: &str,
    ) -> Result<Vec<InteractionRecord>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.pending_interactions(session_id).await
    }

    pub async fn client_capability_grant(
        &self,
        session_id: &str,
        target: &GrantTarget,
    ) -> Result<Option<SessionGrant>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .client_capability_grant(session_id, target)
            .await
    }

    pub async fn completed_request_composition(
        &self,
        session: &str,
        sequence: u64,
    ) -> Result<Option<RequestComposition>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .completed_request_composition(session, sequence)
            .await
    }

    pub async fn commit_artifact(
        &self,
        artifact: Artifact,
        bytes: impl AsRef<[u8]> + Send + 'static,
    ) -> Result<Artifact, StoreError> {
        self.check_session(&artifact.session_id)?;
        self.scoped().await?.commit_artifact(artifact, bytes).await
    }

    pub async fn interrupt_message_queue(
        &self,
        command: &InterruptCommand,
        expected_revision: u64,
        owner: Option<&Invocation>,
    ) -> Result<InterruptReceipt, StoreError> {
        self.check_session(&command.session_id)?;
        if let Some(owner) = owner {
            self.check_session(&owner.session_id)?;
        }
        self.scoped()
            .await?
            .interrupt_message_queue(command, expected_revision, owner)
            .await
    }

    pub async fn append_batch(&self, events: &[EventWrite]) -> Result<Vec<u64>, CommitError> {
        for event in events {
            self.check_session(&event.event().invocation.session_id)
                .map_err(commit_error)?;
        }
        self.scoped()
            .await
            .map_err(commit_error)?
            .append_batch(events)
            .await
    }

    pub async fn append_capability_dispatch(
        &self,
        event: &EventWrite,
        target: &maka_agent_facts::interaction::GrantTarget,
        basis: &maka_agent_facts::workspace::PermissionBasis,
    ) -> Result<u64, CommitError> {
        self.check_session(&event.event().invocation.session_id)
            .map_err(commit_error)?;
        self.scoped()
            .await
            .map_err(commit_error)?
            .append_capability_dispatch(event, target, basis)
            .await
    }

    pub async fn append(&self, event: &EventWrite) -> Result<u64, CommitError> {
        self.check_session(&event.event().invocation.session_id)
            .map_err(commit_error)?;
        self.scoped()
            .await
            .map_err(commit_error)?
            .append(event)
            .await
    }

    pub async fn latest_message_opening(
        &self,
        session_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .latest_message_opening(session_id)
            .await
    }

    pub async fn root_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Option<RootMessageProof>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .root_message(session_id, message_id)
            .await
    }

    pub async fn continuation_receipt(
        &self,
        invocation_id: &str,
    ) -> Result<
        Option<(
            Invocation,
            maka_agent_facts::continuation::RunBoundary,
            String,
        )>,
        StoreError,
    > {
        self.scoped()
            .await?
            .continuation_receipt(invocation_id)
            .await
    }

    pub async fn invocation_boundary(
        &self,
        session_id: &str,
        invocation_id: &str,
    ) -> Result<Option<(TurnBoundary, u64)>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .invocation_boundary(session_id, invocation_id)
            .await
    }

    pub async fn latest_turn_boundary(
        &self,
        session_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.latest_turn_boundary(session_id).await
    }

    pub async fn invocation_configuration(
        &self,
        invocation: &Invocation,
    ) -> Result<Option<maka_agent_facts::execution::InvocationConfiguration>, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped()
            .await?
            .invocation_configuration(invocation)
            .await
    }

    pub async fn turn_boundary(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .turn_boundary(session_id, turn_id)
            .await
    }

    pub async fn has_unsettled_shells(&self, session: &str) -> Result<bool, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.has_unsettled_shells(session).await
    }

    pub async fn patch_shell_run(
        &self,
        session_id: &str,
        id: &str,
        patch: ShellPatch,
    ) -> Result<ShellRun, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .patch_shell_run(session_id, id, patch)
            .await
    }

    pub async fn read_shell_run(
        &self,
        session_id: &str,
        id: &str,
    ) -> Result<Option<ShellRun>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.read_shell_run(session_id, id).await
    }

    pub async fn message_queue_revision(&self, session: &str) -> Result<u64, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.message_queue_revision(session).await
    }

    pub async fn message_queue(&self, session: &str) -> Result<MessageQueue, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.message_queue(session).await
    }

    pub async fn edit_message_queue(
        &self,
        session: &str,
        expected_revision: u64,
        edit: QueueEdit,
        command: QueueCommand,
    ) -> Result<QueueReceipt, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .edit_message_queue(session, expected_revision, edit, command)
            .await
    }

    pub async fn message_cancelled(
        &self,
        session: &str,
        message: &str,
    ) -> Result<bool, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .message_cancelled(session, message)
            .await
    }

    pub async fn close_run_interactions(
        &self,
        invocation: &Invocation,
        reason: ClosureReason,
        now: u64,
    ) -> Result<usize, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped()
            .await?
            .close_run_interactions(invocation, reason, now)
            .await
    }

    pub async fn permission_grants(
        &self,
        invocation: &Invocation,
        tool_use_id: Option<&str>,
        basis: &PermissionBasis,
    ) -> Result<Vec<PermissionGrant>, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped()
            .await?
            .permission_grants(invocation, tool_use_id, basis)
            .await
    }

    pub async fn resolve_history_artifact(
        &self,
        session: &str,
        source_session: &str,
        source_artifact: &str,
    ) -> Result<Option<StorageRef>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .resolve_history_artifact(session, source_session, source_artifact)
            .await
    }

    pub async fn with_artifact<T: Send + 'static>(
        &self,
        scope: ArtifactReadScope<'_>,
        artifact_id: &str,
        read: impl FnOnce(&Artifact, &mut dyn std::io::Read) -> T + Send + 'static,
    ) -> Result<Option<T>, StoreError> {
        match &scope {
            ArtifactReadScope::Session(session) => self.check_session(session)?,
            ArtifactReadScope::Execution(invocation) => {
                self.check_session(&invocation.session_id)?
            }
        }
        self.scoped()
            .await?
            .with_artifact(scope, artifact_id, read)
            .await
    }

    pub async fn get_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactEntry, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .get_artifact(session_id, artifact_id)
            .await
    }

    pub async fn read_artifact_chunk(
        &self,
        session_id: &str,
        artifact_id: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Option<ArtifactChunk>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .read_artifact_chunk(session_id, artifact_id, offset, limit)
            .await
    }

    pub async fn prepare_model_view(
        &self,
        selection: SemanticSelection,
        policy: &str,
    ) -> Result<PreparedBuild, StoreError> {
        self.check_session(&selection.session)?;
        self.scoped()
            .await?
            .prepare_model_view(selection, policy)
            .await
    }

    pub async fn prepared_dirty_groups(
        &self,
        build: &PreparedBuild,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PreparedGroup>, StoreError> {
        self.scoped()
            .await?
            .prepared_dirty_groups(build, after, limit)
            .await
    }

    pub async fn prepared_group_rows(
        &self,
        build: &PreparedBuild,
        group: &PreparedGroup,
    ) -> Result<Vec<ResolvedRow>, StoreError> {
        self.scoped().await?.prepared_group_rows(build, group).await
    }

    pub async fn finish_prepared(&self, build: &PreparedBuild) -> Result<PreparedView, StoreError> {
        self.scoped().await?.finish_prepared(build).await
    }

    pub async fn prepared_semantic_page(
        &self,
        view: &PreparedView,
        cursor: usize,
        limit: usize,
    ) -> Result<PreparedSemanticPage, StoreError> {
        self.scoped()
            .await?
            .prepared_semantic_page(view, cursor, limit)
            .await
    }

    pub async fn prepared_view_group_rows(
        &self,
        view: &PreparedView,
        group: &PreparedGroup,
    ) -> Result<Vec<ResolvedRow>, StoreError> {
        self.scoped()
            .await?
            .prepared_view_group_rows(view, group)
            .await
    }

    pub async fn context_report(
        &self,
        session: &str,
        through: Option<u64>,
    ) -> Result<ContextReport, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.context_report(session, through).await
    }

    pub async fn context_usage(
        &self,
        session: &str,
    ) -> Result<(LatestMainContext, Option<ContextUsage>), StoreError> {
        self.check_session(session)?;
        self.scoped().await?.context_usage(session).await
    }

    pub async fn check_manual_message_history(&self, session: &str) -> Result<bool, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .check_manual_message_history(session)
            .await
    }

    pub async fn read_model_view(
        &self,
        session: &str,
        current: Option<&str>,
    ) -> Result<ContextView, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.read_model_view(session, current).await
    }

    pub async fn read_manual_message_view(
        &self,
        session: &str,
        current: &str,
    ) -> Result<ContextView, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .read_manual_message_view(session, current)
            .await
    }

    pub async fn prepare_compaction_view(
        &self,
        session: &str,
        current: Option<&str>,
        mode: &CheckpointMode,
    ) -> Result<ContextView, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .prepare_compaction_view(session, current, mode)
            .await
    }

    pub async fn read_lineage_view(&self, source: &RunBoundary) -> Result<ContextView, StoreError> {
        self.check_session(&source.invocation.session_id)?;
        self.scoped().await?.read_lineage_view(source).await
    }

    pub async fn source_before_run(
        &self,
        invocation: &Invocation,
    ) -> Result<SourceEvidence, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped().await?.source_before_run(invocation).await
    }

    pub async fn prepare_prune_candidates(
        &self,
        session: &str,
        current: Option<&str>,
        max_candidates: usize,
        max_bytes: usize,
        cursor: Option<&PruneCursor>,
    ) -> Result<PruneCandidates, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .prepare_prune_candidates(session, current, max_candidates, max_bytes, cursor)
            .await
    }

    pub async fn read_tool_result(
        &self,
        session: &str,
        event_id: &str,
    ) -> Result<Option<crate::archive::ToolResultResource>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .read_tool_result(session, event_id)
            .await
    }

    pub async fn uploaded_image(
        &self,
        session: &str,
        id: &str,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .uploaded_image(session, id, offset, limit)
            .await
    }

    pub async fn attachment_image(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
        attachment_index: u32,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .attachment_image(session, through, position, attachment_index, offset, limit)
            .await
    }

    pub async fn tool_image(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .tool_image(session, through, position, offset, limit)
            .await
    }

    pub async fn tool_source_position(
        &self,
        session: &str,
        through: u64,
        tool_use_id: &str,
    ) -> Result<RowPosition, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .tool_source_position(session, through, tool_use_id)
            .await
    }

    pub async fn history_source(
        &self,
        session: &str,
        through: u64,
        selection: crate::transcript::SourceSelection,
        position: SourcePosition,
        max_bytes: usize,
    ) -> Result<HistorySource, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .history_source(session, through, selection, position, max_bytes)
            .await
    }

    pub async fn history_text(
        &self,
        session: &str,
        through: u64,
        position: Position,
        include_thinking: bool,
        limits: crate::transcript::HistoryLimits,
    ) -> Result<Page, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .history_text(session, through, position, include_thinking, limits)
            .await
    }

    pub async fn history_view(
        &self,
        session: &str,
        through: u64,
        position: Position,
        include_thinking: bool,
        view: HistoryView,
        limits: crate::transcript::HistoryLimits,
    ) -> Result<Page, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .history_view(session, through, position, include_thinking, view, limits)
            .await
    }

    pub async fn history_prompt(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
    ) -> Result<Option<maka_agent_ports::session::history::Prompt>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .history_prompt(session, through, position)
            .await
    }

    pub async fn navigation_landmarks(
        &self,
        session: &str,
        through: u64,
        limit: usize,
        turn: Option<&str>,
    ) -> Result<Vec<maka_presentation::navigation::TurnLandmark>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .navigation_landmarks(session, through, limit, turn)
            .await
    }

    pub async fn search_transcript(
        &self,
        session: &str,
        input: TranscriptSearch,
    ) -> Result<TranscriptSearchBatch, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.search_transcript(session, input).await
    }

    pub async fn change_session_archived<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        expected: Option<u64>,
        archived: bool,
        now: u64,
    ) -> Result<SessionMutation<T>, StoreError> {
        self.check_session(id)?;
        self.exclusive_metadata(true)
            .await?
            .change_session_archived(id, expected, archived, now)
            .await
    }

    pub async fn session_manager(
        &self,
        session_id: &str,
    ) -> Result<Option<maka_capabilities::storage::Namespace>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.session_manager(session_id).await
    }

    pub async fn admit_session_process_for(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        id: Uuid,
        basis: &maka_agent_facts::workspace::PermissionBasis,
    ) -> Result<(), StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped()
            .await?
            .admit_session_process_for(invocation, id, basis)
            .await
    }

    pub async fn clean_session_process(&self, id: Uuid) -> Result<(), StoreError> {
        self.scoped().await?.clean_session_process(id).await
    }

    pub async fn query_shell_catalog(
        &self,
        session: &str,
        provider_prefix: &str,
        offset: u64,
    ) -> Result<ShellResourcePage, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .query_shell_catalog(session, provider_prefix, offset)
            .await
    }

    pub async fn work_observation(
        &self,
        session: &str,
        origin: WorkOrigin,
        offset: u64,
        answer_invocation: Option<&str>,
    ) -> Result<MessageObservation, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .work_observation(session, origin, offset, answer_invocation)
            .await
    }

    pub async fn session_stream_events(
        &self,
        session_id: &str,
        after: u64,
        through: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<StreamEventPage, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .session_stream_events(session_id, after, through, max_events, max_bytes)
            .await
    }

    pub async fn prepared_prior_mcp_ids(
        &self,
        view: &PreparedView,
        group: &PreparedGroup,
        wanted: &[String],
    ) -> Result<Vec<String>, StoreError> {
        self.scoped()
            .await?
            .prepared_prior_mcp_ids(view, group, wanted)
            .await
    }

    pub async fn put_prepared_group(
        &self,
        build: &PreparedBuild,
        group: &PreparedGroup,
        messages: Vec<Message>,
        breakdown: PreparedContextBreakdown,
        manifest: MediaManifest,
    ) -> Result<(), StoreError> {
        self.scoped()
            .await?
            .put_prepared_group(build, group, messages, breakdown, manifest)
            .await
    }

    pub async fn prepared_group_snapshot(
        &self,
        view: &PreparedView,
        group: &PreparedGroup,
    ) -> Result<MediaManifest, StoreError> {
        self.scoped()
            .await?
            .prepared_group_snapshot(view, group)
            .await
    }

    pub async fn prepare_wire_view(
        &self,
        view: &PreparedView,
        format: WireFormat,
        codec: &str,
    ) -> Result<PreparedWireBuild, StoreError> {
        self.scoped()
            .await?
            .prepare_wire_view(view, format, codec)
            .await
    }

    pub async fn prepared_wire_dirty_groups(
        &self,
        build: &PreparedWireBuild,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PreparedGroup>, StoreError> {
        self.scoped()
            .await?
            .prepared_wire_dirty_groups(build, after, limit)
            .await
    }

    pub async fn put_prepared_wire_group(
        &self,
        build: &PreparedWireBuild,
        group: &PreparedGroup,
        wire: WireGroup,
    ) -> Result<(), StoreError> {
        self.scoped()
            .await?
            .put_prepared_wire_group(build, group, wire)
            .await
    }

    pub async fn finish_prepared_wire(
        &self,
        build: &PreparedWireBuild,
    ) -> Result<PreparedWireView, StoreError> {
        self.scoped().await?.finish_prepared_wire(build).await
    }

    pub async fn prepared_wire_page(
        &self,
        view: &PreparedWireView,
        cursor: PreparedWireCursor,
        limit: usize,
    ) -> Result<PreparedWirePage, StoreError> {
        self.scoped()
            .await?
            .prepared_wire_page(view, cursor, limit)
            .await
    }

    pub async fn prepared_wire_metadata_page(
        &self,
        view: &PreparedWireView,
        cursor: PreparedWireCursor,
        limit: usize,
    ) -> Result<PreparedWireMetadataPage, StoreError> {
        self.scoped()
            .await?
            .prepared_wire_metadata_page(view, cursor, limit)
            .await
    }

    pub async fn prepared_wire_prefix_identity(
        &self,
        view: &PreparedWireView,
        count: usize,
    ) -> Result<Option<String>, StoreError> {
        self.scoped()
            .await?
            .prepared_wire_prefix_identity(view, count)
            .await
    }

    pub fn subscribe_session_commits(
        &self,
        session: &str,
    ) -> Result<SessionSubscription, StoreError> {
        self.check_session(session)?;
        self.subscribe_commits()
    }
}

impl EventSink for SessionStore {
    fn execution_custody(
        self: std::sync::Arc<Self>,
    ) -> Option<std::sync::Arc<dyn maka_agent_facts::tools::ExecutionCustody>> {
        SessionStore::execution_custody(&self).ok()
    }
    fn commit(self: std::sync::Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move { self.append(&event).await })
    }
}

fn commit_error(error: StoreError) -> CommitError {
    match error {
        StoreError::CommitUnknown(error) => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::SessionRetired => CommitError::Retired,
        StoreError::PermissionRevoked => CommitError::PermissionRevoked,
        other => CommitError::Rejected(other.to_string()),
    }
}

#[cfg(test)]
mod tests;

impl SessionStore {
    fn check_log_scope(&self, scope: &maka_agent_facts::event::LogScope) -> Result<(), StoreError> {
        use maka_agent_facts::event::LogScope;
        match scope {
            LogScope::Session { id } | LogScope::Lineage { session_id: id, .. } => {
                self.check_session(id)
            }
            LogScope::Root => Err(StoreError::InvalidTransition(
                "Session handle cannot read Root scope".into(),
            )),
        }
    }

    pub async fn scoped_prefix(
        &self,
        scope: maka_agent_facts::event::LogScope,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<maka_agent_facts::event::LogPrefix, StoreError> {
        self.check_log_scope(&scope)?;
        self.scoped()
            .await?
            .scoped_prefix(scope, max_events, max_bytes)
            .await
    }
    pub async fn capture_model_context(
        &self,
        session: &str,
        current: Option<&str>,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<crate::context::ModelContextSource, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .capture_model_context(session, current, max_events, max_bytes)
            .await
    }
    pub async fn read_frozen_model_context(
        &self,
        expected: &SourceEvidence,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<crate::context::ModelContextSource, StoreError> {
        self.check_log_scope(&expected.scope)?;
        self.scoped()
            .await?
            .read_frozen_model_context(expected, max_events, max_bytes)
            .await
    }
    pub async fn request_composition(
        &self,
        session: &str,
        event_id: &str,
    ) -> Result<Option<RequestComposition>, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .request_composition(session, event_id)
            .await
    }
    pub async fn resolve_tool_result(
        &self,
        session_id: &str,
        event_id: &str,
    ) -> Result<maka_agent_facts::tool_output::ToolOutput, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .resolve_tool_result(session_id, event_id)
            .await
    }
    pub async fn session_events(
        &self,
        session_id: &str,
        after: u64,
        through: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<crate::observation::EventPage, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .session_events(session_id, after, through, max_events, max_bytes)
            .await
    }
    pub async fn delete_user_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<crate::artifacts::ArtifactDeletion, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .delete_user_artifact(session_id, artifact_id)
            .await
    }
    pub async fn establish_interaction(
        &self,
        request: &InteractionRecord,
    ) -> Result<InteractionCommit, StoreError> {
        self.check_session(&request.session_id)?;
        self.scoped().await?.establish_interaction(request).await
    }
    pub async fn pending_messages(
        &self,
        session: &str,
    ) -> Result<Vec<PendingMessageAdmission>, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.pending_messages(session).await
    }
    pub async fn steering_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.check_session(session_id)?;
        self.scoped()
            .await?
            .steering_message(session_id, message_id)
            .await
    }
    pub async fn invocation_recovery(
        &self,
        invocation: &Invocation,
        max_operations: usize,
        max_bytes: usize,
    ) -> Result<crate::recovery::InvocationRecovery, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped()
            .await?
            .invocation_recovery(invocation, max_operations, max_bytes)
            .await
    }
}

impl SessionStore {
    /// Session-local unfinished work; the Session predicate precedes SQL LIMIT.
    pub async fn unfinished_invocations(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<crate::recovery::UnfinishedInvocations, StoreError> {
        self.scoped()
            .await?
            .unfinished_invocations(after_sequence, limit)
            .await
    }
}

impl SessionStore {
    pub async fn create_shell_run(&self, record: ShellRun) -> Result<ShellRun, StoreError> {
        self.check_session(&record.session_id)?;
        self.scoped().await?.create_shell_run(record).await
    }
}

impl SessionStore {
    pub async fn begin_auxiliary_model(
        &self,
        source: crate::usage::AuxiliarySource,
        language: maka_agent_facts::language::Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
    ) -> Result<Uuid, StoreError> {
        match &source {
            crate::usage::AuxiliarySource::SessionTitle { invocation }
            | crate::usage::AuxiliarySource::Agent { invocation, .. } => {
                self.check_session(&invocation.session_id)?
            }
            _ => {
                return Err(StoreError::InvalidTransition(
                    "Session auxiliary model requires Session-owned source".into(),
                ));
            }
        }
        self.scoped()
            .await?
            .begin_auxiliary_model(source, language, quote)
            .await
    }

    pub async fn observe_auxiliary_model(
        &self,
        id: Uuid,
        usage: maka_agent_facts::model::ModelUsage,
    ) -> Result<(), StoreError> {
        self.scoped()
            .await?
            .observe_auxiliary_model(id, usage)
            .await
    }

    pub async fn settle_auxiliary_model(
        &self,
        id: Uuid,
        outcome: crate::usage::Outcome,
    ) -> Result<(), StoreError> {
        self.scoped()
            .await?
            .settle_auxiliary_model(id, outcome)
            .await
    }
}

impl SessionStore {
    pub async fn admit_queued_message(
        &self,
        epoch: &str,
        expected_revision: u64,
        admission: PendingMessageAdmission,
    ) -> Result<crate::message_admissions::MessageSubmitReceipt, StoreError> {
        self.check_session(&admission.invocation.session_id)?;
        self.check_session(&admission.steering_target().session_id)?;
        self.scoped()
            .await?
            .admit_queued_message(epoch, expected_revision, admission)
            .await
    }
    pub async fn first_message_opening(
        &self,
        session_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.check_session(session_id)?;
        self.scoped().await?.first_message_opening(session_id).await
    }
    pub async fn record_title_failure(
        &self,
        invocation: Invocation,
        cause: maka_agent_facts::diagnostics::TitleFailureCause,
    ) -> Result<u64, StoreError> {
        self.check_session(&invocation.session_id)?;
        self.scoped()
            .await?
            .record_title_failure(invocation, cause)
            .await
    }
}
