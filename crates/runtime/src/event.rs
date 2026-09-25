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

pub use crate::event_write::{EventWrite, ProjectionArtifactWrite};
pub use crate::input::{InvocationInput, MessageInput};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::SystemTime;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invocation {
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    pub invocation_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Completed,
    Failed,
    Cancelled,
    /// Physical termination only; the logical Turn awaits its sealed successor.
    Paused,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InvocationOutcome {
    Completed,
    HandoffPaused {
        pause: crate::handoff::HandoffPause,
    },
    ContextCompactFinished {
        outcome: crate::context::CompactOutcome,
    },
    Failed {
        class: String,
        message: Option<String>,
    },
    Cancelled {
        source: String,
    },
}

impl InvocationOutcome {
    pub fn status(&self) -> TerminalStatus {
        match self {
            Self::Completed | Self::ContextCompactFinished { .. } => TerminalStatus::Completed,
            Self::Failed { .. } => TerminalStatus::Failed,
            Self::Cancelled { .. } => TerminalStatus::Cancelled,
            Self::HandoffPaused { .. } => TerminalStatus::Paused,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolOutcome {
    Succeeded {
        raw: crate::tool_output::RawToolResultRef,
        model_projection: crate::tool_output::DurableToolProjection,
        /// Generated material must survive with this fact; ordinary references
        /// may instead point to user-deletable uploads.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        artifacts: Vec<crate::artifact::ArtifactEvidence>,
    },
    Failed {
        message: String,
    },
    Unknown {
        message: String,
    },
}

/// Canonical facts, independent of the public wire projection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fact {
    /// Host-recorded foreign history. Header identities address imported rows;
    /// they do not admit a Run. There is no opening, dispatch or terminal event.
    MessageImported {
        source: crate::import::Source,
        record: Box<crate::import::Record>,
    },
    ExecutorStarted {
        binding: crate::executor::Binding,
        settings: crate::executor::Settings,
    },
    ExecutorObserved {
        output: crate::executor::Output,
    },
    ExecutorCompleted {
        text: String,
    },
    InvocationOpened {
        input: InvocationInput,
        /// Absent only for older/synthetic facts; never recover it from mutable metadata.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        configuration: Option<Box<crate::execution::InvocationConfiguration>>,
    },
    ModelRequested {
        step_id: String,
        model_id: String,
        source_scope: LogScope,
        source_high_water: u64,
        source_digest: String,
        input_digest: String,
        route_identity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_event_id: Option<String>,
        purpose: crate::context::ModelPurpose,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<crate::context::ModelRequestContext>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effective_source_digest: Option<String>,
    },
    MessageSteered {
        message: Box<crate::input::DeliveredMessage>,
    },
    ContextCheckpointRecorded {
        checkpoint: crate::context::ContextCheckpoint,
    },
    ToolResultArchived {
        placeholder: crate::archive::ArchivedPlaceholder,
    },
    /// Observations are durable before presentation, but are not accepted model
    /// history until the complete response passes semantic validation.
    ModelObserved {
        step_id: String,
        event: crate::model::ModelEvent,
    },
    ModelInterrupted {
        step_id: String,
        status: ModelInterruption,
    },
    ModelCompleted {
        step_id: String,
        output: crate::model::ModelStep,
    },
    ToolDispatched {
        operation_id: String,
        call: crate::tool_call::ToolCallIdentity,
        name: String,
        input: Value,
    },
    ToolSettled {
        operation_id: String,
        outcome: ToolOutcome,
    },
    /// Additional model output from a live Code Mode cell; never a settlement.
    ToolNotified {
        operation_id: String,
        text: String,
        model_text: String,
    },
    ToolRejected {
        operation_id: String,
        call: crate::tool_call::ToolCallIdentity,
        name: String,
        input: Value,
        reason: crate::tool_call::ToolRejection,
    },
    InvocationEnded {
        outcome: InvocationOutcome,
    },
}

impl Fact {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::MessageImported { .. } => "message_imported",
            Self::ExecutorStarted { .. } => "executor_started",
            Self::ExecutorObserved { .. } => "executor_observed",
            Self::ExecutorCompleted { .. } => "executor_completed",
            Self::InvocationOpened { .. } => "invocation_opened",
            Self::MessageSteered { .. } => "message_steered",
            Self::ModelRequested { .. } => "model_requested",
            Self::ContextCheckpointRecorded { .. } => "context_checkpoint_recorded",
            Self::ToolResultArchived { .. } => "tool_result_archived",
            Self::ModelObserved { .. } => "model_observed",
            Self::ModelInterrupted { .. } => "model_interrupted",
            Self::ModelCompleted { .. } => "model_completed",
            Self::ToolDispatched { .. } => "tool_dispatched",
            Self::ToolSettled { .. } => "tool_settled",
            Self::ToolNotified { .. } => "tool_notified",
            Self::ToolRejected { .. } => "tool_rejected",
            Self::InvocationEnded { .. } => "invocation_ended",
        }
    }

    pub fn operation_id(&self) -> Option<&str> {
        match self {
            Self::ToolDispatched { operation_id, .. }
            | Self::ToolSettled { operation_id, .. }
            | Self::ToolRejected { operation_id, .. } => Some(operation_id),
            Self::ModelRequested { step_id, .. }
            | Self::ModelCompleted { step_id, .. }
            | Self::ModelInterrupted { step_id, .. } => Some(step_id),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelInterruption {
    Cancelled,
    TimedOut,
    Failed,
    /// Trusted ingress classified a transient failure with no raw replay barrier.
    /// This records safety evidence, not an instruction to retry.
    RetryableFailure,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RuntimeEvent {
    pub id: String,
    /// Factual wall-clock capture, not an ordering authority. Persisted once;
    /// delivery and replay must never replace it with their current time.
    pub recorded_at: SystemTime,
    pub invocation: Invocation,
    pub fact: Fact,
}

impl RuntimeEvent {
    pub fn new(invocation: Invocation, fact: Fact) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            recorded_at: SystemTime::now(),
            invocation,
            fact,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct StoredEvent {
    pub sequence: u64,
    pub event: RuntimeEvent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LogScope {
    Root,
    Session {
        id: String,
    },
    /// The inherited Session base plus this Run and its canonical continuation ancestors.
    Lineage {
        session_id: String,
        run_id: String,
    },
}

/// Digest binds scope, high-water, sequence and exact stored bytes of a fixed
/// committed prefix. High-water is the last sequence in scope (zero if empty),
/// so unrelated session appends do not change a session prefix's evidence.
/// The storage implementation, not a mutable projection, supplies it.
#[derive(Debug, Serialize)]
pub struct LogPrefix {
    pub scope: LogScope,
    pub high_water: u64,
    pub digest: String,
    pub events: Vec<StoredEvent>,
}

#[derive(Debug, Serialize)]
pub struct InvocationProjection {
    pub terminal: Option<TerminalStatus>,
    pub uncertain_operations: Vec<String>,
    pub unfinished_model_steps: Vec<String>,
    pub unfinished_executor: bool,
}

impl LogPrefix {
    pub fn project_invocation(&self, invocation_id: &str) -> InvocationProjection {
        let mut terminal = None;
        let mut pending = std::collections::BTreeSet::new();
        let mut model_steps = std::collections::BTreeSet::new();
        let mut unfinished_executor = false;
        for stored in &self.events {
            if stored.event.invocation.invocation_id != invocation_id {
                continue;
            }
            match &stored.event.fact {
                Fact::ToolDispatched { operation_id, .. } => {
                    pending.insert(operation_id.clone());
                }
                Fact::ToolSettled { operation_id, .. } => {
                    pending.remove(operation_id);
                }
                Fact::ExecutorStarted { .. } => unfinished_executor = true,
                Fact::ExecutorCompleted { .. } => unfinished_executor = false,
                Fact::InvocationEnded { outcome } => {
                    terminal = Some(outcome.status());
                    if !matches!(outcome, InvocationOutcome::Failed { class, .. } if class == "outcome_unknown")
                    {
                        unfinished_executor = false;
                    }
                }
                Fact::MessageImported { .. }
                | Fact::InvocationOpened { .. }
                | Fact::MessageSteered { .. }
                | Fact::ContextCheckpointRecorded { .. }
                | Fact::ToolResultArchived { .. }
                | Fact::ExecutorObserved { .. }
                | Fact::ModelObserved { .. }
                | Fact::ToolRejected { .. } => {}
                Fact::ToolNotified { .. } => {}
                Fact::ModelRequested { step_id, .. } => {
                    model_steps.insert(step_id.clone());
                }
                Fact::ModelCompleted { step_id, .. } | Fact::ModelInterrupted { step_id, .. } => {
                    model_steps.remove(step_id);
                }
            }
        }
        InvocationProjection {
            terminal,
            uncertain_operations: pending.into_iter().collect(),
            unfinished_model_steps: model_steps.into_iter().collect(),
            unfinished_executor,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CommitError {
    /// This Session has stopped accepting work. No effect was admitted.
    #[error("session retired")]
    Retired,
    #[error("event rejected: {0}")]
    Rejected(String),
    #[error("event commit outcome unknown: {0}")]
    OutcomeUnknown(String),
}

/// A successful append proves durable commit. Replaying an id requires equal
/// content; an uncertain commit cannot be upgraded to success by assumption.
/// The store owns I/O scheduling. Once submitted, dropping the waiter is not
/// proof of rollback; the store must retain its writer authority through drain.
pub trait EventSink: Send + Sync + 'static {
    fn commit(self: std::sync::Arc<Self>, event: EventWrite) -> CommitFuture;
}

pub type CommitFuture = std::pin::Pin<Box<dyn Future<Output = Result<u64, CommitError>> + Send>>;
