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

//! Live capabilities supplied by Native. Persisted specifications never mint these ports.
use crate::RunError;
use futures_util::{future::BoxFuture, stream::BoxStream};
use maka_agent_facts::durable::*;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_state::{
    ContentBlob,
    fold::{RunView, Tool},
};
use maka_plugin_core::operation::{OperationReply, RecoveryRef};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub enum Preparation {
    Initial,
    Summary,
    SummaryRepair {
        attempt: ModelAttemptId,
    },
    ContextOverflow {
        attempt: ModelAttemptId,
    },
    CompactionFallback {
        main: StepId,
        summary: ModelAttemptId,
    },
    CompactionDeferred {
        main: StepId,
        summary: ModelAttemptId,
    },
    AdoptCompaction(Box<CompactionAdoption>),
    AfterCompaction {
        attempt: ModelAttemptId,
    },
    Notifications {
        attempt: ModelAttemptId,
    },
    Steering {
        attempt: ModelAttemptId,
    },
    /// Adapter must validate the captured signature/cursor evidence before projection.
    Prefix {
        attempt: ModelAttemptId,
        proof: ContentRef,
    },
    ToolContinuation {
        attempt: ModelAttemptId,
    },
}
#[derive(Clone, Debug)]
pub struct CompactionAdoption {
    pub origin: maka_agent_facts::context::SummaryOrigin,
    pub checkpoint: FactId,
    pub baseline: ContentRef,
    pub material: maka_agent_facts::context::CompactedContext,
}
pub struct PreparedStep {
    pub notifications: Vec<maka_agent_state::cells::PendingNotification>,
    pub request: RequestSpec,
    pub contents: Vec<ContentBlob>,
    pub steering: Option<maka_agent_state::queue::Consume>,
}
pub struct RecoveryEvidence {
    pub recovery: AttemptRecovery,
    pub contents: Vec<ContentBlob>,
}
pub struct PreparedDecision {
    pub decision: ToolDecision,
    pub contents: Vec<ContentBlob>,
}
/// Only an exact authorized CallerIntent lookup can produce Absent. Receipt::NotRecorded cannot.
pub enum OriginalLookup {
    Found(RecoveryRef),
    Absent,
    Blocked(BlockerKind),
}
/// The original worker owns custody. Dropping this observation must not abandon effects.
pub type ModelConnection = BoxStream<'static, Result<ModelObservation, RunError>>;
pub enum ModelObservation {
    /// Source publisher already committed its original typed evidence.
    Recorded { fact: FactId },
}
#[expect(
    clippy::large_enum_variant,
    reason = "Validation returns its owned rejection or blocker directly to the original driver"
)]
pub enum ToolValidation {
    Allowed,
    Denied { rejection: ToolRejection },
    Blocked(BlockerKind),
}
#[expect(
    clippy::large_enum_variant,
    reason = "Dispatch transfers the original operation reply inline without a separate allocation per observation"
)]
pub enum DispatchOutcome {
    /// Original worker already committed its evidence, even if this observer was dropped.
    Recorded {
        fact: FactId,
    },
    Original(OperationReply),
    /// Positive proof from this actual Host admission, not a timeout or absent row.
    Prevented {
        rejection: ToolRejection,
    },
}
/// Each port is scoped to the *current* activation and its real authority ceiling.
/// Native fences replaced activations before returning a new driver claim. These
/// methods execute/observe the Engine's decision; they do not select another action.
pub trait DriverPorts: Send + Sync {
    fn model_admission(
        &self,
        _run: RunId,
        _attempt: ModelAttemptId,
        request: &RequestSpec,
    ) -> Result<serde_json::Value, RunError> {
        Ok(serde_json::json!({"request": request.request}))
    }
    fn external(&self) -> Option<Arc<dyn ExternalPorts>>;
    fn cells(&self) -> Option<Arc<dyn CellPorts>>;
    fn publication(&self) -> Option<Arc<dyn ExternalPublicationPorts>>;
    fn now(&self) -> UnixMillis;
    /// Keep semantic preparation, compression and manual-continuation integrity
    /// checks here. Return exact frozen adapter bytes and complete provenance.
    fn prepare_step<'a>(
        &'a self,
        view: &'a RunView,
        preparation: Preparation,
    ) -> BoxFuture<'a, Result<PreparedStep, RunError>>;
    /// Pure protocol assessment of original frozen input and canonical progress.
    /// Returning a proof never starts a generation or selects the next action.
    fn assess_recovery<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        request: RequestSpec,
    ) -> BoxFuture<'a, Result<RecoveryEvidence, RunError>>;
    /// Validate current authority and the original binding before recording a transport phase.
    /// This never changes the adapter lane or dispatches a request.
    fn validate_transport_selection<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        phase: maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ) -> BoxFuture<'a, Result<(), RunError>>;
    /// Called only after the Engine's durable model-admission fence commits.
    fn start_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        request: RequestSpec,
        bytes: Vec<u8>,
        witness: crate::ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>>;
    /// Observe the exact original response/job; never send a new generation request.
    fn observe_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        descriptor: ContentRef,
        after_index: u64,
        witness: crate::ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>>;
    fn decide_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<PreparedDecision, RunError>>;
    /// Recheck the current permission ceiling/resource availability immediately
    /// before fresh Host admission. Saved approval is not a restored grant.
    fn validate_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<ToolValidation, RunError>>;
    fn lookup_original(
        &self,
        run: RunId,
        key: ToolKey,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>>;
    /// Use a deterministic original operation identity for (run,key), retaining
    /// the exact decided input/resources. Never resolve a saved ref by new binding.
    fn dispatch_tool(
        &self,
        run: RunId,
        tool: Tool,
    ) -> BoxFuture<'_, Result<DispatchOutcome, RunError>>;
    fn observe_operation(
        &self,
        reference: RecoveryRef,
    ) -> BoxFuture<'_, Result<OperationReply, RunError>>;
    /// Requests cancellation; actual original receipts/cleanup remain independently observable.
    fn cancel_live(&self, run: RunId);
    /// Cancel only this original model source and await its real worker/cleanup acknowledgement.
    /// Other admitted tools and Cells retain their own lifetimes.
    fn cancel_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
    ) -> BoxFuture<'_, Result<(), RunError>>;
}
pub type Capabilities = Arc<dyn DriverPorts>;

/// One original admitted task's physical cleanup; no business or execution ports.
pub trait ModelCleanupPorts: Send + Sync {
    fn observe<'a>(
        &'a self,
        original: &'a maka_agent_state::ModelCleanupItem,
    ) -> BoxFuture<'a, Result<maka_plugin_core::operation::OperationCleanup, RunError>>;
    fn now(&self) -> UnixMillis;
}

pub trait ExternalCleanupSource: Send {
    /// First level, then actual source changes. Cancellation leaves issued work
    /// in this same source's custody for `close`, never a fresh observer/job.
    fn next(
        &mut self,
    ) -> BoxFuture<'_, Result<maka_plugin_core::operation::OperationCleanup, RunError>>;
    /// Withdraw only this observer. Keep its actual requests, watchers and leases
    /// until their own close fence; an unconfirmed close must remain owned/pending.
    fn close(self: Box<Self>) -> BoxFuture<'static, ()>;
}
pub trait ExternalCleanupPorts: Send + Sync {
    fn now(&self) -> UnixMillis;
    fn open(
        &self,
        original: maka_agent_state::CleanupFrontier,
    ) -> BoxFuture<'_, Result<Box<dyn ExternalCleanupSource>, RunError>>;
}

/// External executors have an original task, not an LLM ModelAttempt.
pub struct PreparedExternal {
    pub live_workspace: bool,
    pub descriptor: ContentBlob,
    pub contents: Vec<ContentBlob>,
}
pub type ExternalConnection = BoxStream<'static, Result<FactId, RunError>>;
#[derive(Clone)]
pub struct PendingExternalPublication {
    pub publication: ExternalPublicationId,
    pub source: ContentBlob,
}
pub struct PreparedExternalPublication {
    pub manifest: ContentBlob,
    pub item_count: u64,
    pub contents: Vec<ContentBlob>,
}
pub trait ExternalPublicationPorts: Send + Sync {
    fn prepare_publication<'a>(
        &'a self,
        view: &'a RunView,
        id: ExternalPublicationId,
    ) -> BoxFuture<'a, Result<PreparedExternalPublication, RunError>>;
    /// Check existing custody and live authority only; per-item physical
    /// resources are first created by `dispatch_publication_item`.
    fn validate_publication_item<'a>(
        &'a self,
        view: &'a RunView,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
    ) -> BoxFuture<'a, Result<maka_sandbox::workspace::PermissionBasis, RunError>>;
    fn dispatch_publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        witness: crate::PublicationWitness,
    ) -> BoxFuture<'_, Result<FactId, RunError>>;
    fn lookup_publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        witness: crate::PublicationWitness,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>>;
    fn observe_publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        reference: RecoveryRef,
        witness: crate::PublicationWitness,
    ) -> BoxFuture<'_, Result<FactId, RunError>>;
}
pub enum ExternalObservation {
    Bound {
        descriptor: ContentBlob,
    },
    Output(maka_agent_facts::executor::Output),
    Closed {
        outcome: Terminal,
        diagnostic: Option<String>,
        final_message: Option<ExternalFinalMessage>,
        publication: Option<PendingExternalPublication>,
    },
    Cleanup {
        cleanup: maka_plugin_core::operation::OperationCleanup,
    },
}
pub trait ExternalPorts: Send + Sync {
    /// Capture immutable non-secret input; no process/network job is started here.
    fn prepare_external<'a>(
        &'a self,
        view: &'a RunView,
        task: ExternalTaskId,
    ) -> BoxFuture<'a, Result<PreparedExternal, RunError>>;
    fn start_external(
        &self,
        run: RunId,
        task: ExternalTaskId,
        descriptor: ContentRef,
        witness: crate::ExternalWitness,
    ) -> BoxFuture<'_, Result<ExternalConnection, RunError>>;
    /// Query/reattach the exact old task. No new prompt, job or process may be sent.
    fn observe_external(
        &self,
        run: RunId,
        task: ExternalTaskId,
        descriptor: ContentRef,
        after_index: u64,
        witness: crate::ExternalWitness,
    ) -> BoxFuture<'_, Result<ExternalConnection, RunError>>;
}

/// Original VM custody, never a descriptor rehydrated into an executable grant.
pub enum CellObservation {
    Live,
    /// Native committed the original Cell facts. This is a wake hint, not a second producer.
    Recorded,
}
pub trait CellPorts: Send + Sync {
    fn observe_original_cell<'a>(
        &'a self,
        view: &'a RunView,
        cell: &'a maka_agent_facts::cells::CellView,
    ) -> BoxFuture<'a, Result<CellObservation, RunError>>;
}
