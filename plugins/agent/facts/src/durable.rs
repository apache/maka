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

//! Stable logical execution facts. No persisted value is a live execution grant.
use crate::operation::RecordedOperationReply;
use crate::{
    composition::RequestComposition,
    execution::{CollaborationMode, ModelBinding},
    executor,
    language::Language,
    model::{ModelPart, ModelUsage},
};
use maka_plugin_core::operation::RecoveryRef;
use maka_sandbox::workspace::PermissionBasis;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const SCHEMA_VERSION: u32 = 1;
macro_rules! identity {
    ($($name:ident),+ $(,)?) => {$ (
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, schemars::JsonSchema)]
        #[serde(try_from = "Uuid", into = "Uuid")]
        pub struct $name(Uuid);
        impl $name {
            pub fn new() -> Self { Self(Uuid::new_v4()) }
            pub fn as_uuid(self) -> Uuid { self.0 }
        }
        impl Default for $name { fn default() -> Self { Self::new() } }
        impl TryFrom<Uuid> for $name {
            type Error = &'static str;
            fn try_from(value: Uuid) -> Result<Self, Self::Error> {
                if value.is_nil() { Err("nil durable identity") } else { Ok(Self(value)) }
            }
        }
        impl From<$name> for Uuid { fn from(value: $name) -> Self { value.0 } }
        impl std::fmt::Display for $name {
            fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { self.0.fmt(out) }
        }
    )+};
}
identity!(
    ExternalTaskId,
    ExternalPublicationId,
    RunId,
    StepId,
    ModelAttemptId,
    FactId,
    ApprovalId,
    BlockerId,
    WaitId
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionIdentity {
    pub session_id: String,
    pub turn_id: String,
    pub run_id: RunId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStepLink {
    pub run: RunId,
    pub step: StepId,
    pub attempt: ModelAttemptId,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunOwner {
    pub deployment: Uuid,
    pub namespace: maka_plugin_core::composition::InstanceId,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(transparent)]
pub struct UnixMillis(pub i64);

#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentRef {
    pub digest: String,
    pub bytes: u64,
}
impl ContentRef {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !crate::archive::valid_projection_digest(&self.digest) || self.bytes > i64::MAX as u64 {
            return Err("invalid durable content reference");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunOrigin {
    Local,
    Imported {
        source: ContentRef,
    },
    Forked {
        source_run: RunId,
        source: ContentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Trigger {
    Message { message_id: String },
    Schedule { schedule_id: String },
    Goal { goal_id: Uuid },
    Continuation { source: RunId },
    ContextCompact,
    HistorySource,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BackendSpec {
    Historical {},
    Model {
        binding: ModelBinding,
        descriptor: ContentRef,
    },
    Executor {
        selection: executor::Selection,
        descriptor: ContentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSpec {
    pub schema_version: u32,
    pub session_id: String,
    pub owner: RunOwner,
    /// Presentation grouping only; never a recovery or execution identity.
    pub turn_id: String,
    pub origin: RunOrigin,
    pub trigger: Trigger,
    pub workspace: String,
    pub permission_basis: PermissionBasis,
    pub permission_ceiling: maka_sandbox::Permissions,
    pub backend: BackendSpec,
    pub collaboration: CollaborationMode,
    pub language: Language,
    pub tool_discovery: bool,
    pub allowed_tools: Option<Vec<String>>,
    pub mcp_revision: Option<String>,
    pub compaction_prompt: Option<ContentRef>,
    pub system_prompt: ContentRef,
    pub tool_selection: ContentRef,
    pub input: ContentRef,
    pub budget: Budget,
    pub budget_basis: Option<ContentRef>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub tokens: Option<u64>,
    pub retries: u32,
    pub deadline: Option<UnixMillis>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdjudicationBasis {
    pub blocker: BlockerId,
    pub evidence: ContentRef,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSpec {
    pub schema_version: u32,
    pub step: StepId,
    pub composition: RequestComposition,
    pub summary_repair_of: Option<ModelAttemptId>,
    pub compaction_recovery: Option<ModelAttemptId>,
    pub source_capture: ContentRef,
    pub source_digest: String,
    pub effective_source_digest: String,
    pub provenance: ContentRef,
    pub projection: Option<ContentRef>,
    pub adjudications: Vec<AdjudicationBasis>,
    pub steering: Vec<ContentRef>,
    /// Exact adapter-owned request bytes, not a digest-only replay recipe.
    pub request: ContentRef,
    pub protocol: String,
    pub protocol_version: u32,
    pub recovery_contract: ContentRef,
    pub request_contents: Vec<ContentRef>,
    pub accounting: crate::accounting::ModelEvidence,
}
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolKey {
    pub attempt: ModelAttemptId,
    pub call: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorizationObligation {
    External {
        task: ExternalTaskId,
        operation: Uuid,
    },
    Tool {
        tool: ToolKey,
    },
    Cell {
        cell: crate::cells::CellId,
        operation: Uuid,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceRecovery {
    Reference { descriptor: ContentRef },
    Unavailable { diagnostic: String },
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDisplay {
    pub title: Option<String>,
    pub presentation: Option<String>,
}
impl ToolDisplay {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(title) = &self.title {
            crate::display::Text::plain(title).validate()?;
        }
        if let Some(presentation) = &self.presentation {
            crate::display::validate_presentation(presentation)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolDecision {
    Approved {
        input: ContentRef,
        resources: Vec<ResourceRecovery>,
        approval: Option<ApprovalId>,
        display: ToolDisplay,
        semantics: crate::tools::ToolSemantics,
    },
    Rejected {
        rejection: crate::tool_call::ToolRejection,
        display: ToolDisplay,
    },
}
impl ToolDecision {
    pub fn display(&self) -> &ToolDisplay {
        match self {
            Self::Approved { display, .. } | Self::Rejected { display, .. } => display,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AcceptedResult {
    CellRecovered { cell: crate::cells::CellId },
    Succeeded,
    Failed,
    Rejected,
    RiskAdjudicated { blocker: BlockerId },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BlockerKind {
    ExternalPublicationUnavailable {
        publication: ExternalPublicationId,
        diagnostic: String,
    },
    ExternalPublicationItem {
        key: crate::external_publication::ExternalPublicationKey,
        reason: crate::external_publication::ExternalPublicationBlocker,
    },
    CurrentAuthorityUnavailable {
        stage: AuthorityStage,
        diagnostic: String,
    },
    ExternalEffectUnknown {
        task: ExternalTaskId,
        operation: Uuid,
    },
    OperationUnknown {
        tool: ToolKey,
        reference: RecoveryRef,
    },
    ProviderEffectUnknown {
        attempt: ModelAttemptId,
        call: String,
    },
    OriginalAdmissionUnknown {
        tool: ToolKey,
    },
    CodeCellRecoveryUnavailable {
        cell: String,
    },
    UnsupportedProtocol {
        protocol: String,
        version: u32,
    },
    ToolCleanupUnconfirmed {
        tool: ToolKey,
        diagnostic: String,
    },
    ModelCleanupUnconfirmed {
        attempt: ModelAttemptId,
        diagnostic: String,
    },
    CleanupUnconfirmed {
        reference: RecoveryRef,
    },
    ResourcesUnavailable {
        tool: ToolKey,
    },
    ExternalTaskUnobservable {
        descriptor: ContentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RiskDecision {
    RecordExternalObservation { evidence: ContentRef },
    AuthorizeReplan { evidence: ContentRef },
    CancelBlockedRun { diagnostic: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WaitReason {
    Cell { cell: crate::cells::CellId },
    External { task: ExternalTaskId },
    ProviderBackoff { attempt: ModelAttemptId },
    Model { attempt: ModelAttemptId },
    Approval { approval: ApprovalId },
    Retry { attempt: ModelAttemptId },
    Operation { tool: ToolKey },
    Child { run: RunId },
    Blocker { blocker: BlockerId },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Terminal {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AttemptRecovery {
    ContextOverflow {
        observed_output: bool,
    },
    ObserveOriginal {
        descriptor: ContentRef,
    },
    FrozenRetrySafe {
        not_before: Option<UnixMillis>,
    },
    ProjectPrefixSafe {
        prefix: ContentRef,
        not_before: Option<UnixMillis>,
    },
    Blocked {
        diagnostic: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalFinalMessage {
    pub message_id: String,
    pub end: FactId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Fact {
    SessionTitleFailed {
        cause: crate::diagnostics::TitleFailureCause,
    },
    StopAssessed {
        request: FactId,
    },
    BlockerResolved {
        blocker: BlockerId,
        evidence: ContentRef,
    },
    ModelCleanupObserved {
        attempt: ModelAttemptId,
        cleanup: maka_plugin_core::operation::OperationCleanup,
    },
    ExternalSteering {
        event: crate::external_steering::ExternalSteeringEvent,
    },
    ExternalEffect {
        event: crate::external_effects::ExternalEffectEvent,
    },
    ExternalPublication {
        event: crate::external_publication::ExternalPublicationEvent,
    },
    ToolsLoaded {
        tool: ToolKey,
        names: std::collections::BTreeSet<String>,
    },
    HostToolResultRecorded {
        tool: ToolKey,
        reference: RecoveryRef,
        result: ContentRef,
        is_error: bool,
    },
    ContextCompacted {
        baseline: ContentRef,
    },
    Cell {
        event: crate::cells::CellEvent,
    },
    ExternalTaskPrepared {
        task: ExternalTaskId,
        descriptor: ContentRef,
    },
    ExternalTaskAdmitted {
        task: ExternalTaskId,
    },
    ExternalTaskBound {
        task: ExternalTaskId,
        descriptor: ContentRef,
    },
    ExternalTaskObserved {
        task: ExternalTaskId,
        index: u64,
        output: executor::Output,
    },
    ExternalTaskClosed {
        task: ExternalTaskId,
        outcome: Terminal,
        diagnostic: Option<String>,
        final_message: Option<ExternalFinalMessage>,
    },
    ExternalTaskCleanupObserved {
        task: ExternalTaskId,
        cleanup: maka_plugin_core::operation::OperationCleanup,
    },
    ExternalTaskCleanupDeferred {
        task: ExternalTaskId,
        not_before: UnixMillis,
        diagnostic: String,
    },
    RunAdmitted {
        spec: ContentRef,
    },
    StepPrepared {
        step: StepId,
        request: ContentRef,
        adjudications: Vec<BlockerId>,
    },
    ModelAttemptPrepared {
        attempt: ModelAttemptId,
        step: StepId,
    },
    ModelAttemptAdmitted {
        attempt: ModelAttemptId,
        upstream: Value,
    },
    ModelTransportSelected {
        attempt: ModelAttemptId,
        phase: crate::model::retry_transport::RetryTransportPhase,
    },
    ModelPrivatePartialCaptured {
        attempt: ModelAttemptId,
        partial: ContentRef,
    },
    ModelSourceFailureCaptured {
        attempt: ModelAttemptId,
        failure: ContentRef,
    },
    /// Complete semantic item. A ToolCall creates a hard obligation immediately.
    ModelObserved {
        attempt: ModelAttemptId,
        index: u64,
        part: ModelPart,
        continuation: Option<ContentRef>,
    },
    AttemptRecoveryRecorded {
        attempt: ModelAttemptId,
        recovery: AttemptRecovery,
    },
    ModelInterrupted {
        attempt: ModelAttemptId,
        diagnostic: String,
    },
    ModelClosed {
        attempt: ModelAttemptId,
        outcome: crate::accounting::Outcome,
        diagnostic: Option<String>,
        usage: ModelUsage,
        protocol: Value,
    },
    ToolDecided {
        tool: ToolKey,
        decision: ToolDecision,
    },
    ToolOriginalBound {
        tool: ToolKey,
        reference: RecoveryRef,
    },
    ToolAdmitted {
        tool: ToolKey,
    },
    ToolPreventedBeforeHostAdmission {
        tool: ToolKey,
        rejection: crate::tool_call::ToolRejection,
    },
    LocalToolReturned {
        tool: ToolKey,
        settlement: crate::tool_call::ToolSettlement,
        result: ContentRef,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cell_observation: Option<ContentRef>,
    },
    ToolResultAccepted {
        tool: ToolKey,
        result: ContentRef,
        outcome: AcceptedResult,
    },
    /// Original late facts never rewrite consumed context or a provider outcome.
    OperationObserved {
        tool: ToolKey,
        reply: RecordedOperationReply,
    },
    StopRequested {
        diagnostic: String,
    },
    ApprovalRecorded {
        approval: ApprovalId,
        tool: ToolKey,
        input_digest: String,
        expires_at: Option<UnixMillis>,
    },
    ApprovalRefused {
        approval: ApprovalId,
        tool: ToolKey,
        outcome: crate::interaction::InteractionOutcome,
    },
    ApprovalConsumed {
        approval: ApprovalId,
        tool: ToolKey,
    },
    RetryCharged {
        attempt: ModelAttemptId,
        phase: crate::model::retry_transport::RetryTransportPhase,
        due_at: UnixMillis,
        diagnostic: String,
    },
    BudgetCharged {
        tokens: u64,
    },
    Blocked {
        blocker: BlockerId,
        reason: BlockerKind,
    },
    RiskAdjudicated {
        blocker: BlockerId,
        decision: RiskDecision,
        scope: RiskActionScope,
    },
    WaitRegistered {
        wait: WaitId,
        reason: WaitReason,
        due_at: Option<UnixMillis>,
    },
    WaitCancelled {
        wait: WaitId,
        diagnostic: String,
    },
    WaitSatisfied {
        wait: WaitId,
        evidence: ContentRef,
    },
    RunTerminated {
        terminal: Terminal,
        diagnostic: Option<String>,
    },
}
impl Fact {
    /// New actions require a current driver and unrevoked control frontier.
    pub fn is_admission(&self) -> bool {
        if let Self::ExternalSteering { event } = self {
            return event.is_admission();
        }
        if let Self::ExternalEffect { event } = self {
            return event.is_admission();
        }
        if let Self::ExternalPublication { event } = self {
            return event.is_admission();
        }
        if let Self::Cell { event } = self {
            return event.is_admission();
        }
        matches!(
            self,
            Self::ExternalTaskPrepared { .. }
                | Self::ExternalTaskAdmitted { .. }
                | Self::StepPrepared { .. }
                | Self::ModelAttemptPrepared { .. }
                | Self::ModelAttemptAdmitted { .. }
                | Self::ModelTransportSelected { .. }
                | Self::ToolAdmitted { .. }
                | Self::ToolDecided {
                    decision: ToolDecision::Approved { .. },
                    ..
                }
                | Self::RetryCharged { .. }
                | Self::ApprovalConsumed { .. }
        )
    }
    pub fn is_late(&self) -> bool {
        if let Self::ExternalSteering { event } = self {
            return event.is_late();
        }
        if let Self::ExternalEffect { event } = self {
            return event.is_late();
        }
        if let Self::ExternalPublication { event } = self {
            return event.is_late();
        }
        if let Self::Cell { event } = self {
            return event.is_late();
        }
        matches!(
            self,
            Self::SessionTitleFailed { .. }
                | Self::ExternalTaskBound { .. }
                | Self::ExternalTaskObserved { .. }
                | Self::ExternalTaskClosed { .. }
                | Self::ExternalTaskCleanupObserved { .. }
                | Self::OperationObserved { .. }
                | Self::ToolOriginalBound { .. }
                | Self::ToolPreventedBeforeHostAdmission { .. }
                | Self::LocalToolReturned { .. }
                | Self::HostToolResultRecorded { .. }
                | Self::ModelObserved { .. }
                | Self::ModelClosed { .. }
                | Self::ModelPrivatePartialCaptured { .. }
                | Self::ModelSourceFailureCaptured { .. }
                | Self::ModelCleanupObserved { .. }
                | Self::BudgetCharged { .. }
        )
    }
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        if let Self::ExternalSteering { event } = self {
            return event.content_refs();
        }
        if let Self::ExternalEffect { event } = self {
            return event.content_refs();
        }
        if let Self::ExternalPublication { event } = self {
            return event.content_refs();
        }
        match self {
            Self::Cell { event } => event.content_refs(),
            Self::ExternalTaskPrepared { descriptor, .. }
            | Self::ExternalTaskBound { descriptor, .. } => vec![descriptor],
            Self::ContextCompacted { baseline } => vec![baseline],
            Self::RunAdmitted { spec } => vec![spec],
            Self::StepPrepared { request, .. } => vec![request],
            Self::ModelObserved { continuation, .. } => continuation.iter().collect(),
            Self::ModelPrivatePartialCaptured { partial, .. } => vec![partial],
            Self::ModelSourceFailureCaptured { failure, .. } => vec![failure],
            Self::ToolDecided {
                decision:
                    ToolDecision::Approved {
                        input, resources, ..
                    },
                ..
            } => {
                let mut refs = vec![input];
                refs.extend(resources.iter().filter_map(|resource| match resource {
                    ResourceRecovery::Reference { descriptor } => Some(descriptor),
                    _ => None,
                }));
                refs
            }
            Self::LocalToolReturned {
                result,
                cell_observation,
                ..
            } => std::iter::once(result)
                .chain(cell_observation.iter())
                .collect(),
            Self::OperationObserved { reply, .. } => crate::operation::result_reference(reply)
                .into_iter()
                .collect(),
            Self::ToolResultAccepted { result, .. }
            | Self::HostToolResultRecorded { result, .. } => {
                vec![result]
            }
            Self::AttemptRecoveryRecorded {
                recovery:
                    AttemptRecovery::ObserveOriginal { descriptor }
                    | AttemptRecovery::ProjectPrefixSafe {
                        prefix: descriptor, ..
                    },
                ..
            } => vec![descriptor],
            Self::Blocked {
                reason: BlockerKind::ExternalTaskUnobservable { descriptor },
                ..
            } => vec![descriptor],
            Self::RiskAdjudicated {
                decision:
                    RiskDecision::RecordExternalObservation { evidence }
                    | RiskDecision::AuthorizeReplan { evidence },
                ..
            }
            | Self::WaitSatisfied { evidence, .. }
            | Self::BlockerResolved { evidence, .. } => vec![evidence],
            _ => vec![],
        }
    }
}
impl RunSpec {
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        let mut refs = vec![&self.system_prompt, &self.tool_selection, &self.input];
        match &self.backend {
            BackendSpec::Model { descriptor, .. } | BackendSpec::Executor { descriptor, .. } => {
                refs.push(descriptor)
            }
            BackendSpec::Historical {} => {}
        }
        refs.extend(self.budget_basis.iter());
        refs.extend(self.compaction_prompt.iter());
        match &self.origin {
            RunOrigin::Imported { source } | RunOrigin::Forked { source, .. } => refs.push(source),
            RunOrigin::Local => {}
        }
        refs
    }
}
impl RequestSpec {
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        {
            let mut refs = vec![
                &self.source_capture,
                &self.provenance,
                &self.request,
                &self.recovery_contract,
            ];
            refs.extend(self.projection.iter());
            refs.extend(self.adjudications.iter().map(|basis| &basis.evidence));
            refs.extend(self.steering.iter());
            refs.extend(self.request_contents.iter());
            refs
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedFact {
    pub schema_version: u32,
    pub id: FactId,
    pub run: RunId,
    pub revision: u64,
    pub at: UnixMillis,
    pub fact: Fact,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RiskActionKind {
    RecordExternalObservation,
    AuthorizeReplan,
    CancelBlockedRun,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RiskActionScope {
    Tool {
        tool: ToolKey,
    },
    ModelReplan {
        attempt: ModelAttemptId,
        base_step: StepId,
    },
    RunCancellation,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OfferedRiskAction {
    pub kind: RiskActionKind,
    pub scope: RiskActionScope,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopedRiskDecision {
    pub decision: RiskDecision,
    pub scope: RiskActionScope,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityStage {
    CurrentSession,
    WorkspaceScope,
    ToolBindings,
    BackendScope,
    InputCodec,
}
