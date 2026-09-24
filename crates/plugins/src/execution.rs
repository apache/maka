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

use crate::{Error, name};
use maka_runtime::{event::Invocation, input::MessageInput};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
mod attachment;
pub use attachment::CopyAttachment;
mod interaction;
mod message;
pub use message::{
    AnswerCursor, Enqueue, Excerpt, InteractionKind, MessageObservation, MessageReceipt,
    MessageResult, MessageState, PendingInteraction, SessionMessage,
};
mod removal;
mod root;
pub use interaction::{OfferInteraction, Prompt};
pub use removal::{RemovalReceipt, RemoveSession, RemovedSession};
pub use root::{CreateRoot, RootApproval, RootTemplate, Settings as RootSettings};

/// Persisted constraints, not a bearer capability. Only an explicit Host grant
/// binds them to a live plugin instance; current boundaries are still checked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBoundary {
    pub workspace_origin: maka_runtime::execution::WorkspaceOrigin,
    pub session_id: String,
    pub boundary_revision: u64,
    pub sandbox_mode: maka_runtime::execution::SandboxMode,
    pub approval_policy: maka_runtime::execution::ApprovalPolicy,
    pub cwd: String,
}
impl SessionBoundary {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.session_id)?;
        if self.boundary_revision >= (1 << 53)
            || self.cwd.is_empty()
            || self.cwd.len() > 32 * 1024
            || self.cwd.contains('\0')
        {
            return Err(Error::Invalid("invalid Session execution boundary".into()));
        }
        Ok(())
    }
}

/// Business identity belongs to the package/scope namespace, never an activation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submit {
    pub operation_id: String,
    pub session_id: String,
    pub content: MessageInput,
    /// This execution only; never changes the Session's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_mode: Option<maka_runtime::execution::BehaviorId>,
}

impl Submit {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.operation_id)?;
        name(&self.session_id)?;
        if self.content.text_bytes() > 64 * 1024 {
            return Err(Error::Invalid("execution message exceeds 64 KiB".into()));
        }
        maka_runtime::message::validate_sources(&self.content, &[])
            .map_err(|reason| Error::Invalid(reason.into()))
    }

    pub fn digest(&self) -> Result<String, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }
}

/// Resume one sealed physical Run. The operation identity is package/scope-local;
/// an exact retry returns the same continuation, never the Session's new tip.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resume {
    pub operation_id: String,
    pub source: Invocation,
}
impl Resume {
    pub fn validate(&self) -> Result<(), Error> {
        for value in [
            &self.operation_id,
            &self.source.session_id,
            &self.source.turn_id,
            &self.source.run_id,
            &self.source.invocation_id,
        ] {
            name(value)?;
        }
        Ok(())
    }
}

/// Acceptance is not completion. Outcomes remain in the Host's canonical log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub invocation: Invocation,
    pub message_id: String,
    pub content_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateChild {
    pub operation_id: String,
    pub parent_session_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<maka_runtime::execution::SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_tools: Option<std::collections::BTreeSet<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<ChildWorkspace>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildWorkspace {
    Inherit,
    IsolatedGit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    Model {
        model: maka_runtime::execution::ModelBinding,
        thinking_level: Option<maka_runtime::execution::ThinkingLevel>,
    },
    Executor {
        executor_id: maka_runtime::executor::ExecutorId,
        #[serde(default)]
        settings: maka_runtime::executor::Settings,
    },
}
impl Target {
    pub fn validate(&self) -> Result<(), Error> {
        if let Self::Model { model, .. } = self {
            name(&model.connection_id)?;
            name(&model.connection_slug)?;
            name(&model.model)?;
        }
        if let Self::Executor { settings, .. } = self {
            settings
                .validate()
                .map_err(|error| Error::Invalid(error.into()))?;
        }
        Ok(())
    }
}

impl CreateChild {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.operation_id)?;
        name(&self.parent_session_id)?;
        if self.name.trim().is_empty()
            || self.name.len() > 256
            || self.name.chars().any(char::is_control)
        {
            return Err(Error::Invalid("invalid child Session name".into()));
        }
        if self
            .instructions
            .as_ref()
            .is_some_and(|text| text.len() > 16 * 1024)
            || self
                .bound_tools
                .as_ref()
                .is_some_and(|tools| tools.len() > 128)
        {
            return Err(Error::Invalid(
                "child Session surface exceeds its budget".into(),
            ));
        }
        if let Some(tools) = &self.bound_tools {
            for tool in tools {
                name(tool)?;
            }
        }
        if let Some(target) = &self.target {
            target.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildSession {
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePatch {
    pub artifact_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub bytes: u64,
    pub base_commit: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Progress {
    Pending,
    Running,
    WaitingForUser,
    Paused,
    Ended {
        outcome: maka_runtime::event::InvocationOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub receipt: Receipt,
    pub progress: Progress,
    /// Exact log fence from the same snapshot as progress; use it for event pages.
    pub through_sequence: u64,
    /// Canonical terminal record from this same observation, absent while unfinished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_event_id: Option<String>,
    /// Stable identity of the current blocking interaction set or handoff pause.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<maka_runtime::event::StoredEvent>,
    pub through_sequence: u64,
    pub next_after: Option<u64>,
}

/// Registered extension names visible to this Session, narrowed by its tool ceiling.
/// An advertisement is neither a frozen model request nor permission to call it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCapabilities {
    pub tools: std::collections::BTreeSet<String>,
    pub executors: Vec<maka_runtime::executor::ExecutorId>,
}

/// The latest logical execution is an observation, not a durable business identity. Capture
/// the invocation when recording a control intent; never retarget a retry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub execution: Option<CurrentExecution>,
    /// Includes queued work and cleanup, not just a live model request.
    pub busy: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentExecution {
    /// May already be terminal; it remains a safe identity for exact control.
    pub invocation: Invocation,
    /// Frozen behavior, not the current Session default.
    pub behavior: Option<maka_runtime::execution::BehaviorId>,
    pub progress: Progress,
}

/// A bounded read of an artifact belonging to the accepted operation's Turn.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadArtifact {
    pub operation_id: String,
    pub artifact_id: String,
    pub offset: u64,
    pub limit: usize,
}
impl ReadArtifact {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.operation_id)?;
        name(&self.artifact_id)?;
        if self.offset >= (1 << 53) || !(1..=64 * 1024).contains(&self.limit) {
            return Err(Error::Invalid("invalid execution artifact window".into()));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactChunk {
    pub bytes: Vec<u8>,
    pub total_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("plugin execution authority is retired or revoked")]
    Revoked,
    #[error("execution request is not authorized")]
    Denied,
    #[error("operation identity belongs to different content")]
    Conflict,
    #[error("execution operation was not accepted")]
    NotFound,
    #[error("Host is draining")]
    Draining,
    #[error("Session is busy")]
    Busy,
    #[error("execution acceptance outcome is unknown: {0}")]
    OutcomeUnknown(String),
    #[error("invalid execution request: {0}")]
    Invalid(String),
    #[error("execution capability is unavailable: {0}")]
    Unavailable(String),
    #[error("Host execution failed: {0}")]
    Host(String),
}

impl From<CommandError> for maka_runtime::tools::ToolError {
    fn from(error: CommandError) -> Self {
        match error {
            CommandError::Denied | CommandError::Revoked => Self::Io {
                kind: std::io::ErrorKind::PermissionDenied,
                message: error.to_string(),
            },
            CommandError::OutcomeUnknown(message) => Self::OutcomeUnknown(message),
            other => Self::Failed(other.to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configure {
    pub session_id: String,
    pub expected_revision: u64,
    pub target: Target,
}
impl Configure {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.session_id)?;
        if self.expected_revision >= 1 << 53 {
            return Err(Error::Invalid("invalid Session revision".into()));
        }
        self.target.validate()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Configured {
    Committed {
        session: Box<crate::session::View>,
    },
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
}

/// A Host-authorized, instance-bound interface. Plugins cannot supply another
/// namespace or activation with a command; Host binds both when granting it.
pub trait Access: Send + Sync {
    /// Restore a Host-recorded consent reference, never plugin-supplied boundary data.
    fn restore(
        &self,
        id: crate::authorization::Id,
    ) -> futures_util::future::BoxFuture<'_, Result<std::sync::Arc<dyn Commands>, CommandError>>;
    /// Borrow a real Host call's execution authority. Entry placement and a
    /// caller-supplied Session identity never authorize execution on their own.
    fn acquire(
        &self,
        call: crate::call::Scope,
    ) -> futures_util::future::BoxFuture<'_, Result<std::sync::Arc<dyn Commands>, CommandError>>;
}

/// Durable decision when abandoning an owned revision draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevisionDisposition {
    Abandoned,
    Retained,
}

/// An acquired execution capability retains its captured permission ceiling.
pub trait Commands: Send + Sync + std::any::Any {
    /// Remove an authorized revision family; every directly removed member must
    /// be covered. Accepted work settles independently of the caller's lifetime.
    fn remove_session(
        &self,
        request: RemoveSession,
    ) -> futures_util::future::BoxFuture<'_, Result<RemovedSession, CommandError>>;
    /// Read only an accepted removal. No catalog record or active execution is
    /// required; current plugin identity and access are still checked.
    fn removal_receipt(
        &self,
        session_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<RemovalReceipt>, CommandError>>;
    /// Advisory count; removal recomputes and authorizes the plan at commit.
    fn preview_removal(
        &self,
        session_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<u64, CommandError>>;
    /// Copy an immutable attachment between two Host-issued capabilities. Both
    /// endpoints are reauthorized; a source Session ID alone grants nothing.
    fn copy_attachment(
        &self,
        source: std::sync::Arc<dyn Commands>,
        request: CopyAttachment,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<maka_runtime::attachment::AttachmentRef, CommandError>,
    >;

    /// Immutable user input that opened this logical execution. Handoff successors
    /// resolve the same root; unrelated Runs are never substituted. Non-message
    /// inputs return None. This is a read, not authority to forward attachments.
    fn input(
        &self,
        invocation: Invocation,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<MessageInput>, CommandError>>;

    fn resume(
        &self,
        request: Resume,
    ) -> futures_util::future::BoxFuture<'_, Result<Invocation, CommandError>>;
    /// Replace an idle Session's model/Executor selection without changing its
    /// workspace, behavior or permission ceiling. Revision mismatch is explicit.
    /// Every committed choice advances the revision, including identical values.
    fn configure(
        &self,
        input: Configure,
    ) -> futures_util::future::BoxFuture<'_, Result<Configured, CommandError>>;
    /// Inspect an exact message in an authorized Session, including non-plugin input.
    /// Absence is not proof of cancellation or delivery.
    fn read_message(
        &self,
        message: SessionMessage,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<MessageState>, CommandError>>;
    fn enqueue(
        &self,
        request: Enqueue,
    ) -> futures_util::future::BoxFuture<'_, Result<MessageReceipt, CommandError>>;
    fn message(&self, operation_id: String) -> futures_util::future::BoxFuture<'_, MessageResult>;
    fn retract(&self, operation_id: String) -> futures_util::future::BoxFuture<'_, MessageResult>;
    /// Exact retries reuse the canonical offer, including its outcome after the Run ended.
    fn offer_interaction(
        &self,
        request: OfferInteraction,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<maka_runtime::interaction::InteractionRecord, CommandError>,
    >;
    /// Only this package/scope's offers, within currently authorized Sessions.
    fn interaction(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<Option<maka_runtime::interaction::InteractionRecord>, CommandError>,
    >;
    /// Cancellation stops observation, never withdraws an accepted offer.
    fn wait_interaction(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<maka_runtime::interaction::InteractionOutcome, CommandError>,
    >;
    /// Withdraw an offer without replacing an answer or other canonical terminal outcome.
    fn close_interaction(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<maka_runtime::interaction::InteractionRecord, CommandError>,
    >;

    /// Current configuration of an authorized Session; not a grant or an
    /// unrestricted catalog. Returns no plugin-owned domain state.
    fn session(
        &self,
        session_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<crate::session::View, CommandError>>;
    fn capabilities(
        &self,
        session_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<SessionCapabilities, CommandError>>;
    fn activity(
        &self,
        session_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Activity, CommandError>>;
    /// Stop the captured logical execution, including its handoff successors.
    /// Completion confirms the stop request, not that all cleanup has finished.
    /// Repeating it never stops a later Turn in the same Session.
    fn stop(
        &self,
        invocation: Invocation,
    ) -> futures_util::future::BoxFuture<'_, Result<(), CommandError>>;
    /// Check current instance and Session boundaries without submitting work.
    fn validate_authority(&self) -> futures_util::future::BoxFuture<'_, Result<(), CommandError>>;
    fn create_root(
        &self,
        request: CreateRoot,
    ) -> futures_util::future::BoxFuture<'_, Result<ChildSession, CommandError>>;
    fn import_session(
        &self,
        command: crate::session::import::Command,
    ) -> futures_util::future::BoxFuture<'_, Result<crate::session::import::Receipt, CommandError>>;
    /// Recover a root created by this namespace without replaying its creation settings.
    /// Rechecks the current workspace and source ceilings. Absence is only an
    /// observation: a concurrent creation may still commit with this operation ID.
    fn restore_root(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<ChildSession>, CommandError>>;
    /// Abandon an unused revision created by this namespace. Accepted work
    /// retains it; repeating an abandonment returns the durable decision.
    fn abandon_revision(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<RevisionDisposition, CommandError>>;
    /// Host-captured constraints suitable for persisting with a business intent.
    fn boundaries(&self) -> Result<Vec<SessionBoundary>, CommandError>;
    /// Export a settled child workspace once; exact retries return its immutable Artifact.
    fn workspace_patch(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<WorkspacePatch>, CommandError>>;
    /// Missing artifacts and artifacts from another Turn are both absent.
    fn artifact(
        &self,
        request: ReadArtifact,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<ArtifactChunk>, CommandError>>;
    fn event(
        &self,
        operation_id: String,
        event_id: String,
        through: u64,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<Option<maka_runtime::event::StoredEvent>, CommandError>,
    >;
    /// Invalidation only. The canonical query remains authoritative.
    fn changes(&self) -> Result<tokio::sync::watch::Receiver<u64>, CommandError>;
    fn events(
        &self,
        operation_id: String,
        after: u64,
        through: u64,
    ) -> futures_util::future::BoxFuture<'_, Result<EventPage, CommandError>>;
    /// Recover access to an existing child using its original creation request.
    /// Never creates a Session or workspace; current parent/child ceilings still apply.
    fn restore_child(
        &self,
        request: CreateChild,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<ChildSession>, CommandError>>;
    fn create_child(
        &self,
        request: CreateChild,
    ) -> futures_util::future::BoxFuture<'_, Result<ChildSession, CommandError>>;
    fn submit(
        &self,
        request: Submit,
    ) -> futures_util::future::BoxFuture<'_, Result<Receipt, CommandError>>;
    fn query(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Observation, CommandError>>;
    fn cancel(
        &self,
        operation_id: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Observation, CommandError>>;
}
