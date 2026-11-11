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

//! Deterministic logical projections. Neither receipts nor projections grant execution.
use std::collections::BTreeMap;

use maka_agent_facts::{
    durable::*,
    model::{ModelPart, ModelToolCall, ModelUsage, retry_transport::RetryTransportPhase},
    operation::{RecordedOutcome as OperationOutcome, RecordedReceipt as Receipt},
    tools::ToolSemantics,
};
use maka_event_log::StoreError;
use maka_plugin_core::operation::{OperationCleanup, RecoveryRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod external;
pub use external::{ExternalClosure, ExternalTask};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunView {
    pub run: RunId,
    pub spec: RunSpec,
    pub spec_ref: Option<ContentRef>,
    pub revision: u64,
    pub control_version: u64,
    pub stopped: bool,
    pub cancelled_by_risk: bool,
    pub replans: BTreeMap<BlockerId, ScopedRiskDecision>,
    pub stop_request: Option<FactId>,
    pub stop_assessed: Option<FactId>,
    pub baseline: Option<ContentRef>,
    pub external: Option<ExternalTask>,
    pub cells: BTreeMap<maka_agent_facts::cells::CellId, maka_agent_facts::cells::CellView>,
    pub terminal: Option<Terminal>,
    pub tokens: u64,
    pub retries: u32,
    pub retry_phase: RetryTransportPhase,
    pub(crate) finish_requested: bool,
    pub retry_due_at: Option<UnixMillis>,
    pub retry_pending: Option<ModelAttemptId>,
    pub current_step: Option<StepId>,
    pub current_attempt: Option<ModelAttemptId>,
    pub steps: BTreeMap<StepId, ContentRef>,
    pub attempts: BTreeMap<ModelAttemptId, Attempt>,
    pub tools: BTreeMap<String, Tool>,
    pub waits: BTreeMap<WaitId, Wait>,
    pub blockers: BTreeMap<BlockerId, Blocker>,
    pub approvals: BTreeMap<ApprovalId, Approval>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub cleanup: OperationCleanup,
    pub step: StepId,
    pub admission: Option<ModelAdmission>,
    pub observed: u64,
    pub semantic: bool,
    pub has_tools: bool,
    pub recovery: Option<AttemptRecovery>,
    pub closed: Option<ModelClosure>,
    pub interrupted: Option<String>,
    pub retry: Option<Retry>,
    pub private_partial: Option<ContentRef>,
    pub source_failure: Option<ContentRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelAdmission {
    pub upstream: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelClosure {
    pub outcome: maka_agent_facts::accounting::Outcome,
    pub diagnostic: Option<String>,
    pub usage: ModelUsage,
    pub protocol: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retry {
    pub phase: RetryTransportPhase,
    pub due_at: UnixMillis,
    pub diagnostic: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tool {
    pub key: ToolKey,
    pub call: ModelToolCall,
    pub decision: Option<ToolDecision>,
    pub approval_refusal: Option<ApprovalRefusal>,
    pub original: Option<RecoveryRef>,
    pub receipt: Option<Receipt>,
    pub provider_result: Option<ProviderResult>,
    pub local_returned: Option<LocalReturn>,
    pub host_returned: Option<HostReturn>,
    pub prohibited_before_host: Option<maka_agent_facts::tool_call::ToolRejection>,
    pub admitted: bool,
    pub accepted: Option<ToolAcceptance>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRefusal {
    pub approval: ApprovalId,
    pub outcome: maka_agent_facts::interaction::InteractionOutcome,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderResult {
    pub output: Value,
    pub is_error: bool,
    pub provider_options: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalReturn {
    pub settlement: maka_agent_facts::tool_call::ToolSettlement,
    pub result: ContentRef,
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostReturn {
    pub reference: RecoveryRef,
    pub result: ContentRef,
    pub is_error: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAcceptance {
    pub result: ContentRef,
    pub outcome: AcceptedResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wait {
    pub reason: WaitReason,
    pub due_at: Option<UnixMillis>,
    pub satisfied: Option<ContentRef>,
    pub cancelled: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Blocker {
    pub reason: BlockerKind,
    pub decision: Option<ScopedRiskDecision>,
    pub resolved_by: Option<FactId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub tool: ToolKey,
    pub input_digest: String,
    pub expires_at: Option<UnixMillis>,
    pub consumed: bool,
}

/// The fixed-width UUID prefix makes this injective even when call IDs contain colons.
pub fn tool_key(key: &ToolKey) -> String {
    format!("{}:{}", key.attempt, key.call)
}

fn require(condition: bool, message: &str) -> Result<(), StoreError> {
    if condition {
        Ok(())
    } else {
        Err(StoreError::InvalidTransition(message.into()))
    }
}

impl RunView {
    /// Starts before revision one: the first canonical fact must be RunAdmitted.
    pub fn admitted(run: RunId, spec: RunSpec) -> Result<Self, StoreError> {
        require(
            spec.schema_version == SCHEMA_VERSION,
            "unsupported run schema",
        )?;
        require(
            !matches!(spec.backend, BackendSpec::Historical {})
                || !matches!(spec.origin, RunOrigin::Local),
            "historical source cannot be a local executable run",
        )?;
        require(
            !matches!(spec.trigger, Trigger::HistorySource)
                || (!matches!(spec.origin, RunOrigin::Local)
                    && matches!(spec.backend, BackendSpec::Historical {})),
            "historical source trigger requires a non-local non-executable source installation",
        )?;
        require(!spec.owner.deployment.is_nil(), "nil run owner deployment")?;
        spec.owner
            .namespace
            .validate()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        for reference in spec.content_refs() {
            reference
                .validate()
                .map_err(|error| StoreError::InvalidTransition(error.into()))?;
        }
        Ok(Self {
            run,
            spec,
            spec_ref: None,
            revision: 0,
            control_version: 0,
            stopped: false,
            cancelled_by_risk: false,
            replans: BTreeMap::new(),
            stop_request: None,
            stop_assessed: None,
            baseline: None,
            external: None,
            cells: BTreeMap::new(),
            terminal: None,
            tokens: 0,
            retries: 0,
            retry_phase: RetryTransportPhase::Primary,
            finish_requested: false,
            retry_due_at: None,
            retry_pending: None,
            current_step: None,
            current_attempt: None,
            steps: BTreeMap::new(),
            attempts: BTreeMap::new(),
            tools: BTreeMap::new(),
            waits: BTreeMap::new(),
            blockers: BTreeMap::new(),
            approvals: BTreeMap::new(),
        })
    }

    pub fn retries_for(&self, phase: RetryTransportPhase) -> u32 {
        self.attempts
            .values()
            .filter(|attempt| {
                attempt
                    .retry
                    .as_ref()
                    .is_some_and(|retry| retry.phase == phase)
            })
            .count() as u32
    }
    pub fn finish_requested(&self) -> bool {
        self.finish_requested
    }

    fn attempt(&self, id: &ModelAttemptId) -> Result<&Attempt, StoreError> {
        self.attempts
            .get(id)
            .ok_or_else(|| StoreError::InvalidTransition("unknown model attempt".into()))
    }

    fn tool(&self, key: &ToolKey) -> Result<&Tool, StoreError> {
        self.tools
            .get(&tool_key(key))
            .ok_or_else(|| StoreError::InvalidTransition("unknown hard tool obligation".into()))
    }

    fn retry_safe(&self) -> Result<(), StoreError> {
        let Some(pending) = self.retry_pending else {
            return Ok(());
        };
        let failed = self.attempt(&pending)?;
        match &failed.recovery {
            Some(AttemptRecovery::FrozenRetrySafe { .. }) => require(
                !failed.semantic && self.current_step == Some(failed.step),
                "frozen retry requires no semantic output and the original prepared step",
            ),

            _ => Err(StoreError::InvalidTransition(
                "failed attempt has no evidence permitting fresh recovery admission".into(),
            )),
        }
    }

    pub fn recovery_cell(&self, id: &str) -> Option<&maka_agent_facts::cells::CellView> {
        let id = id.parse::<uuid::Uuid>().ok()?.try_into().ok()?;
        self.cells.get(&id)
    }

    pub(crate) fn original_cell_id(&self, tool: &Tool) -> Option<maka_agent_facts::cells::CellId> {
        if !tool.admitted || tool.original.is_some() || tool.call.provider_executed {
            return None;
        }
        let attempt = self.attempts.get(&tool.key.attempt)?;
        Some(maka_agent_facts::cells::CellId::for_agent(
            AgentStepLink {
                run: self.run,
                step: attempt.step,
                attempt: tool.key.attempt,
            },
            &tool.key.call,
        ))
    }

    pub fn original_cell(&self, tool: &Tool) -> Option<&maka_agent_facts::cells::CellView> {
        self.cells.get(&self.original_cell_id(tool)?)
    }

    pub(crate) fn tool_unsettled(&self, tool: &Tool) -> bool {
        tool_unsettled(tool)
            && self
                .original_cell(tool)
                .is_none_or(|cell| cell.has_unsettled_effects())
    }

    pub fn waiting_for_authority(&self) -> bool {
        self.blockers.values().any(|blocker| {
            blocker.decision.is_none()
                && blocker.resolved_by.is_none()
                && matches!(
                    blocker.reason,
                    BlockerKind::CurrentAuthorityUnavailable { .. }
                )
        })
    }

    pub fn recovery_failures(&self) -> impl Iterator<Item = &BlockerKind> {
        self.blockers.iter().filter_map(|(id, blocker)| {
            (self.replans.contains_key(id)
                || (blocker.decision.is_none()
                    && blocker.resolved_by.is_none()
                    && !matches!(
                        blocker.reason,
                        BlockerKind::CurrentAuthorityUnavailable { .. }
                    )))
            .then_some(&blocker.reason)
        })
    }

    pub fn recovery_failure(&self) -> Option<&BlockerKind> {
        self.recovery_failures().next()
    }

    pub fn blocks_followup(&self) -> bool {
        (self.terminal == Some(Terminal::Failed) || self.cancelled_by_risk)
            && self.has_unsettled_recovery()
    }

    pub fn has_unsettled_recovery(&self) -> bool {
        self.recovery_failures().any(|reason| {
            if let BlockerKind::OriginalAdmissionUnknown { tool } = reason {
                return self
                    .tools
                    .get(&tool_key(tool))
                    .is_none_or(|tool| self.tool_unsettled(tool));
            }
            if let BlockerKind::CodeCellRecoveryUnavailable { cell } = reason {
                return self
                    .recovery_cell(cell)
                    .is_none_or(|cell| cell.has_unsettled_effects());
            }
            !matches!(
                reason,
                BlockerKind::UnsupportedProtocol { .. }
                    | BlockerKind::ResourcesUnavailable { .. }
                    | BlockerKind::ExternalPublicationUnavailable { .. }
                    | BlockerKind::ExternalPublicationItem { .. }
            )
        }) || self.tools.values().any(|tool| self.tool_unsettled(tool))
            || self.attempts.values().any(attempt_unsettled)
            || self.cells.values().any(|cell| cell.has_unsettled_effects())
            || self.external.as_ref().is_some_and(|task| {
                task.admitted
                    && (task.closed.is_none()
                        || task.cleanup != OperationCleanup::Confirmed
                        || task.effects.values().any(|effect| effect.pending())
                        || task.publication.as_ref().is_some_and(|publication| {
                            !publication.quiescent() || publication.unknown()
                        }))
            })
    }

    pub fn check_effect_admission(&self) -> Result<(), StoreError> {
        require(
            matches!(self.spec.origin, RunOrigin::Local),
            "imported run cannot admit native effects",
        )?;
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| {
                StoreError::InvalidTransition(format!(
                    "current admission time is unavailable: {error}"
                ))
            })?;
        let at = UnixMillis(i64::try_from(elapsed.as_millis()).map_err(|_| {
            StoreError::InvalidTransition(
                "current admission time exceeds epoch milliseconds".into(),
            )
        })?);
        self.check_effect_admission_at(at)
    }
    pub(crate) fn check_effect_admission_at(&self, at: UnixMillis) -> Result<(), StoreError> {
        require(
            !self.finish_requested(),
            "successful finish tool fenced fresh Run admission",
        )?;
        require(
            self.spec
                .budget
                .deadline
                .is_none_or(|deadline| at < deadline),
            "run deadline reached",
        )?;
        require(
            !self.stopped && self.terminal.is_none(),
            "closed or stopped run cannot admit effects",
        )?;
        require(
            self.blockers
                .values()
                .all(|blocker| blocker.decision.is_some() || blocker.resolved_by.is_some()),
            "run has an active blocker",
        )?;
        require(
            self.tools.values().all(|tool| {
                let unknown = local_effect_unknown(tool)
                    || matches!(
                        tool.receipt,
                        Some(
                            Receipt::NotRecorded
                                | Receipt::Unavailable { .. }
                                | Receipt::Recorded {
                                    outcome: OperationOutcome::Unknown { .. },
                                    ..
                                }
                                | Receipt::Recorded {
                                    outcome: OperationOutcome::Unresolved,
                                    cleanup: OperationCleanup::Failed { .. }
                                }
                        )
                    );
                let uncertain =
                    unknown || tool.receipt.as_ref().is_some_and(receipt_blocks_effects);
                !uncertain
                    || self.blockers.values().any(|blocker| {
                        let original_risk = matches!(
                            blocker.reason,
                            BlockerKind::OperationUnknown { .. }
                                | BlockerKind::OriginalAdmissionUnknown { .. }
                                | BlockerKind::ProviderEffectUnknown { .. }
                        );
                        let cleanup_risk =
                            matches!(blocker.reason, BlockerKind::CleanupUnconfirmed { .. });
                        blocker.decision.as_ref().is_some_and(|decision| {
                            !matches!(decision.decision, RiskDecision::CancelBlockedRun { .. })
                        }) && blocker_covers(&blocker.reason, tool)
                            && if unknown {
                                original_risk
                            } else {
                                original_risk || cleanup_risk
                            }
                    })
            }),
            "original tool outcome or cleanup is explicitly unresolved",
        )?;
        require(
            self.cells
                .values()
                .all(|cell| !cell.blocks_effect_admission()),
            "Cell has unresolved original effects or cleanup",
        )?;
        require(
            self.external.as_ref().is_none_or(|task| {
                task.effects.values().all(|effect| {
                    !effect
                        .observation
                        .as_ref()
                        .is_some_and(|reply| receipt_blocks_effects(&reply.receipt))
                        && !matches!(effect.cleanup, OperationCleanup::Failed { .. })
                        && !(effect.known() && effect.cleanup != OperationCleanup::Confirmed)
                })
            }),
            "external task has unresolved original effects or cleanup",
        )
    }

    fn effects_accounted(&self) -> Result<(), StoreError> {
        require(
            self.tools.values().all(|tool| {
                !original_effect_unknown(tool)
                    || self.blockers.values().any(|blocker| {
                        blocker.decision.as_ref().is_some_and(|decision| {
                            matches!(decision.scope, RiskActionScope::RunCancellation)
                        }) || (blocker.decision.is_some()
                            && matches!(
                                blocker.reason,
                                BlockerKind::OperationUnknown { .. }
                                    | BlockerKind::OriginalAdmissionUnknown { .. }
                            )
                            && blocker_covers(&blocker.reason, tool))
                    })
            }),
            "original Host effect is unresolved and has no explicit risk adjudication",
        )
    }

    fn fresh_model(
        &self,
        at: UnixMillis,
        except: Option<ModelAttemptId>,
    ) -> Result<(), StoreError> {
        self.effects_accounted()?;
        require(
            self.attempts.iter().all(|(id, attempt)| {
                Some(*id) == except
                    || attempt.admission.is_none()
                    || attempt.cleanup == OperationCleanup::Confirmed
            }),
            "fresh model requires actual original model cleanup acknowledgements",
        )?;
        require(
            self.replans.is_empty(),
            "a frozen human model replan must be consumed by its new Step",
        )?;
        require(
            self.spec
                .budget
                .deadline
                .is_none_or(|deadline| at < deadline),
            "run deadline reached",
        )?;
        require(
            self.spec
                .budget
                .tokens
                .is_none_or(|limit| self.tokens < limit),
            "run token budget exhausted",
        )?;
        require(
            self.blockers
                .values()
                .all(|blocker| blocker.decision.is_some() || blocker.resolved_by.is_some()),
            "run has an active blocker",
        )?;
        require(
            self.tools.values().all(|tool| tool.accepted.is_some()),
            "unaccepted hard tool obligation",
        )?;
        require(
            self.attempts.iter().all(|(id, attempt)| {
                Some(*id) == except || attempt.closed.is_some() || attempt.interrupted.is_some()
            }),
            "another model attempt is open",
        )?;
        self.retry_safe()?;
        require(
            self.retry_pending.is_none() || self.retry_due_at.is_some(),
            "failed attempt retry has not been charged",
        )?;
        require(
            self.retry_due_at.is_none_or(|due| at >= due),
            "retry is not due",
        )
    }

    /// Store deduplicates FactId before invoking this method. An error leaves this view unchanged.
    /// Sparse callers load all open obligations and every object referenced by the batch.
    pub fn apply(&mut self, recorded: &RecordedFact) -> Result<(), StoreError> {
        require(
            recorded.schema_version == SCHEMA_VERSION,
            "unsupported fact schema",
        )?;
        require(recorded.run == self.run, "fact belongs to another run")?;
        require(
            self.revision.checked_add(1) == Some(recorded.revision),
            "noncontiguous fact revision",
        )?;
        let fact = &recorded.fact;
        require(
            self.revision != 0 || matches!(fact, Fact::RunAdmitted { .. }),
            "first fact must admit the run",
        )?;
        require(
            self.terminal.is_none()
                || fact.is_late()
                || matches!(
                    fact,
                    Fact::BlockerResolved { .. } | Fact::ExternalTaskCleanupDeferred { .. }
                ),
            "terminal run accepts only original late evidence",
        )?;
        require(
            !self.stopped || !fact.is_admission(),
            "stopped run cannot admit work",
        )?;
        if fact.is_admission() {
            self.check_effect_admission_at(recorded.at)?;
            require(
                self.spec
                    .budget
                    .deadline
                    .is_none_or(|deadline| recorded.at < deadline),
                "run deadline reached",
            )?;
        }
        for reference in fact.content_refs() {
            reference
                .validate()
                .map_err(|error| StoreError::InvalidTransition(error.into()))?;
        }
        let changes_control = matches!(
            fact,
            Fact::StopRequested { .. }
                | Fact::ApprovalRecorded { .. }
                | Fact::ApprovalRefused { .. }
                | Fact::ApprovalConsumed { .. }
                | Fact::RiskAdjudicated { .. }
                | Fact::BlockerResolved { .. }
        );
        if self.stop_request.is_some()
            && (fact.is_late()
                || changes_control
                || matches!(
                    fact,
                    Fact::ModelInterrupted { .. }
                        | Fact::ToolResultAccepted { .. }
                        | Fact::WaitCancelled { .. }
                        | Fact::ExternalPublication { event: maka_agent_facts::external_publication::ExternalPublicationEvent::Abandoned { .. } }
                ))
        {
            self.stop_assessed = None;
        }
        let next_control = if changes_control {
            self.control_version
                .checked_add(1)
                .ok_or_else(|| StoreError::InvalidTransition("control version overflow".into()))?
        } else {
            self.control_version
        };

        match fact {
            Fact::Cell { event } => {
                use maka_agent_facts::cells::{CellEvent, CellOwner, CellView};
                if matches!(event, CellEvent::ChildAdmitted { .. }) {
                    require(
                        !self.finish_requested(),
                        "successful finish fenced fresh Cell child admission",
                    )?;
                }
                if let CellEvent::Started { owner, .. } = event {
                    require(
                        matches!(owner,CellOwner::Agent{link,..} if link.run==self.run && Some(link.step)==self.current_step && Some(link.attempt)==self.current_attempt),
                        "Agent Cell must belong to the current real Step/Attempt",
                    )?;
                    if let CellOwner::Agent { link, call } = owner {
                        let parent = ToolKey {
                            attempt: link.attempt,
                            call: call.clone(),
                        };
                        require(
                            self.tool(&parent)?.admitted,
                            "Agent Cell requires its exact parent Tool T1",
                        )?;
                    }
                    if self.cells.contains_key(&event.cell()) {
                        return Err(StoreError::EventConflict);
                    }
                    self.cells.insert(
                        event.cell(),
                        CellView::started(event).map_err(crate::cells::transition_error)?,
                    );
                } else {
                    self.cells
                        .get_mut(&event.cell())
                        .ok_or_else(|| StoreError::InvalidTransition("unknown Agent Cell".into()))?
                        .apply(event)
                        .map_err(crate::cells::transition_error)?;
                }
                if let CellEvent::ChildResultRecorded { operation, .. }
                | CellEvent::LocalChildReturned { operation, .. } = event
                {
                    let child = self
                        .cells
                        .get(&event.cell())
                        .and_then(|cell| cell.children.get(operation))
                        .ok_or_else(|| {
                            StoreError::InvalidTransition(
                                "finish evidence has no original Cell child".into(),
                            )
                        })?;
                    self.finish_requested |=
                        child.semantics == ToolSemantics::FinishTurn && child.known_success();
                }
            }
            Fact::ExternalTaskPrepared { .. }
            | Fact::ExternalTaskAdmitted { .. }
            | Fact::ExternalTaskBound { .. }
            | Fact::ExternalTaskObserved { .. }
            | Fact::ExternalTaskClosed { .. }
            | Fact::ExternalTaskCleanupObserved { .. }
            | Fact::ExternalTaskCleanupDeferred { .. } => self.apply_external(recorded)?,
            Fact::ContextCompacted { baseline } => {
                require(
                    !self.stopped
                        && self
                            .blockers
                            .values()
                            .all(|b| b.decision.is_some() || b.resolved_by.is_some())
                        && self.tools.values().all(|t| t.accepted.is_some())
                        && self
                            .attempts
                            .values()
                            .all(|a| a.closed.is_some() || a.interrupted.is_some()),
                    "context compaction requires a closed unblocked frontier",
                )?;
                self.baseline = Some(baseline.clone());
            }
            Fact::RunAdmitted { spec } => {
                require(
                    self.revision == 0 && self.spec_ref.is_none(),
                    "run already admitted",
                )?;
                self.spec_ref = Some(spec.clone());
            }
            Fact::StepPrepared {
                step,
                request,
                adjudications,
            } => {
                require(
                    matches!(self.spec.backend, BackendSpec::Model { .. }),
                    "model Step requires a model backend",
                )?;
                if let Some(existing) = self.steps.get(step)
                    && (existing != request || self.current_step != Some(*step))
                {
                    return Err(StoreError::EventConflict);
                }
                let selected: std::collections::BTreeSet<_> =
                    adjudications.iter().copied().collect();
                require(
                    selected.len() == adjudications.len(),
                    "duplicate replan adjudication",
                )?;
                let active: std::collections::BTreeSet<_> = self
                    .replans
                    .iter()
                    .filter_map(|(id, decision)| match decision.scope {
                        RiskActionScope::ModelReplan { base_step, .. }
                            if Some(base_step) == self.current_step =>
                        {
                            Some(*id)
                        }
                        _ => None,
                    })
                    .collect();
                require(
                    selected == active,
                    "new Step must consume exactly the active same-base replan decisions",
                )?;
                let manual = !selected.is_empty();
                if manual {
                    require(
                        self.current_step != Some(*step),
                        "human replan must prepare a new Step",
                    )?;
                    require(
                        self.tools.values().all(|tool| tool.accepted.is_some()),
                        "human replan still has hard context obligations",
                    )?;
                }
                let mut prefix = false;
                if let Some(pending) = self.retry_pending {
                    let failed = self.attempt(&pending)?;
                    if *step != failed.step && !manual {
                        require(
                            matches!(
                                failed.recovery,
                                Some(AttemptRecovery::ProjectPrefixSafe { .. })
                                    | Some(AttemptRecovery::ContextOverflow {
                                        observed_output: false
                                    })
                            ) && (failed.closed.is_some() || failed.interrupted.is_some()),
                            "new recovery step requires safe prefix, no-output context overflow or explicit human adjudication",
                        )?;
                        require(
                            self.tools.values().all(|tool| tool.accepted.is_some()),
                            "prefix still has unaccepted hard tool obligations",
                        )?;
                        if matches!(
                            failed.recovery,
                            Some(AttemptRecovery::ContextOverflow {
                                observed_output: false
                            })
                        ) {
                            require(
                                !failed.semantic && !failed.has_tools,
                                "no-output context overflow contradicts recorded model output",
                            )?;
                        }
                        if let Some(AttemptRecovery::ProjectPrefixSafe {
                            not_before: Some(bound),
                            ..
                        }) = &failed.recovery
                        {
                            require(recorded.at >= *bound, "prefix is under provider backoff")?;
                        }
                        prefix = true;
                    }
                }
                self.steps.entry(*step).or_insert_with(|| request.clone());
                self.current_step = Some(*step);
                if manual || prefix {
                    self.retry_pending = None;
                    self.retry_due_at = None;
                }
                for blocker in adjudications {
                    self.replans.remove(blocker);
                }
            }
            Fact::ModelAttemptPrepared { attempt, step } => {
                require(
                    self.current_step == Some(*step),
                    "model attempt must reference the current prepared step",
                )?;
                require(
                    self.steps.contains_key(step),
                    "model attempt has no prepared request",
                )?;
                require(
                    !self.attempts.contains_key(attempt),
                    "model attempt identity already exists",
                )?;
                if let Some(previous) = self.current_attempt {
                    require(
                        self.attempt(&previous)?.step != *step
                            || self.retry_pending == Some(previous),
                        "prepared step already has a model attempt; reuse requires explicit safe retry",
                    )?;
                }
                self.fresh_model(recorded.at, None)?;
                self.attempts.insert(
                    *attempt,
                    Attempt {
                        cleanup: OperationCleanup::Unconfirmed,
                        step: *step,
                        admission: None,
                        observed: 0,
                        semantic: false,
                        has_tools: false,
                        recovery: None,
                        closed: None,
                        interrupted: None,
                        retry: None,
                        private_partial: None,
                        source_failure: None,
                    },
                );
                self.current_attempt = Some(*attempt);
            }
            Fact::ModelTransportSelected { attempt, phase } => {
                let current = self.attempt(attempt)?;
                require(
                    self.current_attempt == Some(*attempt)
                        && self.current_step == Some(current.step),
                    "transport selection must name the current actual Main attempt",
                )?;
                require(
                    self.retry_phase == RetryTransportPhase::Primary
                        && *phase == RetryTransportPhase::Fallback,
                    "model transport can move from Primary to Fallback only once",
                )?;
                require(
                    current.admission.is_some()
                        && current.retry.is_none()
                        && !current.semantic
                        && !current.has_tools
                        && matches!(
                            current.recovery,
                            Some(AttemptRecovery::FrozenRetrySafe { .. })
                        )
                        && (current.closed.is_some() || current.interrupted.is_some())
                        && (!current.closed.as_ref().is_some_and(|closed| {
                            closed.outcome == maka_agent_facts::accounting::Outcome::Unknown
                        }) || current.source_failure.is_some()),
                    "transport fallback lacks original safe failed Main evidence",
                )?;
                require(
                    self.retry_pending == Some(*attempt)
                        && self.retries_for(RetryTransportPhase::Primary)
                            >= self.spec.budget.retries,
                    "transport fallback requires exhausted original Primary retry budget",
                )?;
                require(
                    self.replans.is_empty()
                        && self.tools.values().all(|tool| tool.accepted.is_some())
                        && self.attempts.values().all(|attempt| {
                            attempt.closed.is_some() || attempt.interrupted.is_some()
                        }),
                    "transport fallback requires the original closed fresh frontier",
                )?;
                self.effects_accounted()?;
                self.retry_safe()?;
                self.retry_phase = *phase;
            }
            Fact::ModelSourceFailureCaptured { attempt, failure } => {
                failure
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.into()))?;
                let current = self.attempts.get_mut(attempt).ok_or_else(|| {
                    StoreError::InvalidTransition(
                        "source failure has no original model attempt".into(),
                    )
                })?;
                if current.closed.as_ref().is_some_and(|closed| {
                    closed.outcome == maka_agent_facts::accounting::Outcome::Error
                        || closed
                            .protocol
                            .get("failure")
                            .is_some_and(|value| !value.is_null())
                }) {
                    return Err(StoreError::EventConflict);
                }
                if let Some(existing) = &current.source_failure {
                    if existing != failure {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    current.source_failure = Some(failure.clone());
                }
            }
            Fact::ModelPrivatePartialCaptured { attempt, partial } => {
                partial
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.into()))?;
                let current = self.attempts.get_mut(attempt).ok_or_else(|| {
                    StoreError::InvalidTransition(
                        "private partial has no original model attempt".into(),
                    )
                })?;
                if let Some(existing) = &current.private_partial {
                    if existing != partial {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    current.private_partial = Some(partial.clone());
                }
            }
            Fact::ModelAttemptAdmitted { attempt, upstream } => {
                let current = self.attempt(attempt)?;
                require(
                    self.current_step == Some(current.step),
                    "model admission does not reference the current step",
                )?;
                require(
                    current.admission.is_none() && current.closed.is_none(),
                    "model attempt is not awaiting admission",
                )?;
                self.fresh_model(recorded.at, Some(*attempt))?;
                self.attempts
                    .get_mut(attempt)
                    .expect("validated attempt")
                    .admission = Some(ModelAdmission {
                    upstream: upstream.clone(),
                });
                self.retry_due_at = None;
                self.retry_pending = None;
            }
            Fact::ModelObserved {
                attempt,
                index,
                part,
                ..
            } => {
                let current = self.attempt(attempt)?;
                require(
                    current.admission.is_some() && current.closed.is_none(),
                    "model observation has no open original attempt",
                )?;
                if *index < current.observed {
                    return Err(StoreError::EventConflict);
                }
                require(*index == current.observed, "noncontiguous model part index")?;
                let observed = current.observed.checked_add(1).ok_or_else(|| {
                    StoreError::InvalidTransition("model part index overflow".into())
                })?;
                let semantic = match part {
                    ModelPart::Source { .. } => false,
                    ModelPart::Text { text, .. } => !text.is_empty(),
                    ModelPart::ToolCall { call } => {
                        let key = ToolKey {
                            attempt: *attempt,
                            call: call.id.clone(),
                        };
                        require(!key.call.is_empty(), "empty tool call identity")?;
                        let index = tool_key(&key);
                        if let Some(existing) = self.tools.get(&index) {
                            if existing.call != *call {
                                return Err(StoreError::EventConflict);
                            }
                        } else {
                            self.tools.insert(
                                index,
                                Tool {
                                    key,
                                    call: call.clone(),
                                    decision: None,
                                    approval_refusal: None,
                                    original: None,
                                    receipt: None,
                                    provider_result: None,
                                    local_returned: None,
                                    host_returned: None,
                                    prohibited_before_host: None,
                                    admitted: false,
                                    accepted: None,
                                },
                            );
                        }
                        true
                    }
                    ModelPart::ToolResult {
                        id,
                        name,
                        output,
                        is_error,
                        provider_options,
                    } => {
                        let key = ToolKey {
                            attempt: *attempt,
                            call: id.clone(),
                        };
                        let current = self.tool(&key)?;
                        require(
                            current.call.provider_executed && current.call.name == *name,
                            "provider result does not match an original provider-executed tool call",
                        )?;
                        let result = ProviderResult {
                            output: output.clone(),
                            is_error: *is_error,
                            provider_options: provider_options.clone(),
                        };
                        if let Some(existing) = &current.provider_result
                            && existing != &result
                        {
                            return Err(StoreError::EventConflict);
                        }
                        self.tools
                            .get_mut(&tool_key(&key))
                            .expect("validated tool")
                            .provider_result = Some(result);
                        for blocker in self.blockers.values_mut() {
                            if blocker.decision.is_none()
                                && blocker.resolved_by.is_none()
                                && matches!(&blocker.reason, BlockerKind::ProviderEffectUnknown { attempt: original, call } if *original == *attempt && call == id)
                            {
                                blocker.resolved_by = Some(recorded.id);
                            }
                        }
                        true
                    }
                };
                let current = self.attempts.get_mut(attempt).expect("validated attempt");
                current.observed = observed;
                current.semantic |= semantic;
                current.has_tools |= matches!(part, ModelPart::ToolCall { .. });
            }
            Fact::ModelCleanupObserved { attempt, cleanup } => {
                let current = self.attempts.get_mut(attempt).ok_or_else(|| {
                    StoreError::InvalidTransition("cleanup has no original model attempt".into())
                })?;
                require(
                    current.admission.is_some(),
                    "cleanup requires the original model admission",
                )?;
                current.cleanup = match (&current.cleanup, cleanup) {
                    (OperationCleanup::Confirmed, _) => OperationCleanup::Confirmed,
                    (_, OperationCleanup::Unconfirmed) => current.cleanup.clone(),
                    _ => cleanup.clone(),
                };
                if current.cleanup == OperationCleanup::Confirmed {
                    for blocker in self.blockers.values_mut() {
                        if blocker.decision.is_none()
                            && blocker.resolved_by.is_none()
                            && matches!(&blocker.reason, BlockerKind::ModelCleanupUnconfirmed { attempt: id, .. } if id == attempt)
                        {
                            blocker.resolved_by = Some(recorded.id);
                        }
                    }
                }
            }
            Fact::ModelInterrupted {
                attempt,
                diagnostic,
            } => {
                require(
                    self.current_attempt == Some(*attempt),
                    "interruption belongs to a retired model attempt",
                )?;
                let current = self.attempts.get_mut(attempt).ok_or_else(|| {
                    StoreError::InvalidTransition("unknown interrupted attempt".into())
                })?;
                if let Some(existing) = &current.interrupted {
                    if existing != diagnostic {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    current.interrupted = Some(diagnostic.clone());
                }
                self.retry_pending = Some(*attempt);
            }
            Fact::AttemptRecoveryRecorded { attempt, recovery } => {
                require(
                    self.current_attempt == Some(*attempt),
                    "assessment belongs to a retired model attempt",
                )?;
                let current = self.attempt(attempt)?;
                require(
                    current.admission.is_some(),
                    "recovery evidence has no original admitted model attempt",
                )?;
                if let AttemptRecovery::ContextOverflow { observed_output } = recovery {
                    require(
                        current.interrupted.is_some(),
                        "context overflow requires an original interrupted model attempt",
                    )?;
                    if !observed_output {
                        require(
                            !current.semantic && !current.has_tools,
                            "no-output context overflow contradicts recorded model output",
                        )?;
                    }
                }
                let recovery = join_recovery(current.recovery.as_ref(), recovery)?;
                self.attempts
                    .get_mut(attempt)
                    .expect("validated attempt")
                    .recovery = Some(recovery);
            }
            Fact::ModelClosed {
                attempt,
                outcome,
                diagnostic,
                usage,
                protocol,
            } => {
                let current = self.attempt(attempt)?;
                let original_step = current.step;
                if current.source_failure.is_some()
                    && (*outcome == maka_agent_facts::accounting::Outcome::Error
                        || protocol
                            .get("failure")
                            .is_some_and(|value| !value.is_null()))
                {
                    return Err(StoreError::EventConflict);
                }
                let closure = ModelClosure {
                    outcome: *outcome,
                    diagnostic: diagnostic.clone(),
                    usage: usage.clone(),
                    protocol: protocol.clone(),
                };
                require(
                    current.admission.is_some() || diagnostic.is_some(),
                    "unadmitted model attempt needs a cancellation diagnostic",
                )?;
                if let Some(existing) = &current.closed {
                    if existing != &closure {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.attempts
                        .get_mut(attempt)
                        .expect("validated attempt")
                        .closed = Some(closure);
                    if diagnostic.is_some()
                        && self.current_attempt == Some(*attempt)
                        && self.current_step == Some(original_step)
                    {
                        self.retry_pending = Some(*attempt);
                    }
                }
            }
            Fact::ToolDecided { tool, decision } => {
                decision
                    .display()
                    .validate()
                    .map_err(|reason| StoreError::InvalidTransition(reason.into()))?;
                let current = self.tool(tool)?;
                require(
                    !current.admitted && current.accepted.is_none(),
                    "tool decision is already committed to execution or context",
                )?;
                if let (Some(refusal), ToolDecision::Approved { approval, .. }) =
                    (&current.approval_refusal, decision)
                {
                    require(
                        *approval == Some(refusal.approval),
                        "refused tool decision changed its original approval",
                    )?;
                }
                if let Some(existing) = &current.decision {
                    require(
                        existing.display() == decision.display(),
                        "frozen tool display cannot change during re-decision",
                    )?;
                    // Pre-dispatch approval can become rejection when Stop or expiry prevents dispatch.
                    if existing != decision
                        && (!matches!(decision, ToolDecision::Rejected { .. })
                            || matches!(existing, ToolDecision::Rejected { .. }))
                    {
                        return Err(StoreError::EventConflict);
                    }
                }
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .decision = Some(decision.clone());
            }
            Fact::ToolOriginalBound { tool, reference } => {
                reference
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                let current = self.tool(tool)?;
                require(
                    matches!(current.decision, Some(ToolDecision::Approved { .. })),
                    "original operation requires an approved tool",
                )?;
                require(
                    current.admitted && current.prohibited_before_host.is_none(),
                    "original lookup requires an admitted tool without prevention proof",
                )?;
                if let Some(original) = &current.original
                    && original != reference
                {
                    return Err(StoreError::EventConflict);
                }
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .original = Some(reference.clone());
                for blocker in self.blockers.values_mut() {
                    if blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                        && matches!(&blocker.reason, BlockerKind::OriginalAdmissionUnknown { tool: key } if key == tool)
                    {
                        blocker.resolved_by = Some(recorded.id);
                    }
                }
            }
            Fact::ToolAdmitted { tool } => {
                require(
                    self.current_attempt == Some(tool.attempt),
                    "retired model attempt cannot dispatch a new tool",
                )?;
                self.effects_accounted()?;
                let current = self.tool(tool)?;
                require(
                    !current.admitted && current.accepted.is_none(),
                    "tool already admitted or accepted",
                )?;
                require(
                    current.approval_refusal.is_none(),
                    "refused tool cannot be admitted",
                )?;
                require(
                    !current.call.provider_executed,
                    "provider-executed tool cannot be locally dispatched",
                )?;
                let Some(ToolDecision::Approved {
                    input,
                    resources,
                    approval,
                    ..
                }) = &current.decision
                else {
                    return Err(StoreError::InvalidTransition("tool is not approved".into()));
                };
                require(
                    resources
                        .iter()
                        .all(|resource| matches!(resource, ResourceRecovery::Reference { .. })),
                    "tool resources are unavailable",
                )?;
                if let Some(id) = approval {
                    let grant = self.approvals.get(id).ok_or_else(|| {
                        StoreError::InvalidTransition("tool approval missing".into())
                    })?;
                    require(
                        grant.consumed && grant.tool == *tool && grant.input_digest == input.digest,
                        "tool approval was not consumed for this input",
                    )?;
                    require(
                        grant.expires_at.is_none_or(|expiry| recorded.at < expiry),
                        "tool approval expired",
                    )?;
                }
                require(
                    self.blockers
                        .values()
                        .all(|blocker| blocker.decision.is_some() || blocker.resolved_by.is_some()),
                    "run has an active blocker",
                )?;
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .admitted = true;
            }
            Fact::ExternalSteering { event } => crate::external_steering::apply(self, event)?,
            Fact::ExternalEffect { event } => {
                let key = event.key();
                crate::external_effects::apply(self, event)?;
                if self
                    .external
                    .as_ref()
                    .and_then(|task| task.effects.get(&key.operation))
                    .is_some_and(|effect| !effect.pending())
                {
                    for blocker in self.blockers.values_mut() {
                        if blocker.decision.is_none()
                            && blocker.resolved_by.is_none()
                            && matches!(&blocker.reason, BlockerKind::ExternalEffectUnknown { task, operation }
                                if *task == key.task && *operation == key.operation)
                        {
                            blocker.resolved_by = Some(recorded.id);
                        }
                    }
                }
            }
            Fact::ExternalPublication { event } => {
                crate::external_publication::apply(self, event, recorded.at)?;
                for blocker in crate::external_publication::resolved_blockers(self, event) {
                    self.blockers
                        .get_mut(&blocker)
                        .expect("validated publication blocker")
                        .resolved_by = Some(recorded.id);
                }
            }
            Fact::ToolsLoaded { .. } => {}
            Fact::SessionTitleFailed { cause } => {
                cause
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
            }
            Fact::HostToolResultRecorded {
                tool,
                reference,
                result,
                is_error,
            } => {
                let current = self.tool(tool)?;
                require(
                    current.original.as_ref() == Some(reference),
                    "Host tool return differs from original operation",
                )?;
                let returned = HostReturn {
                    reference: reference.clone(),
                    result: result.clone(),
                    is_error: *is_error,
                };
                if let Some(previous) = &current.host_returned {
                    if previous != &returned {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.tools
                        .get_mut(&tool_key(tool))
                        .expect("validated tool")
                        .host_returned = Some(returned);
                }
            }
            Fact::LocalToolReturned {
                tool,
                settlement,
                result,
                is_error,
                ..
            } => {
                let current = self.tool(tool)?;
                require(
                    current.admitted
                        && !current.call.provider_executed
                        && current.prohibited_before_host.is_none(),
                    "local return requires an original admitted non-provider tool without prevention proof",
                )?;
                let returned = LocalReturn {
                    settlement: *settlement,
                    result: result.clone(),
                    is_error: *is_error,
                };
                if let Some(existing) = &current.local_returned
                    && existing != &returned
                    && (existing.settlement != maka_agent_facts::tool_call::ToolSettlement::Unknown
                        || returned.settlement
                            == maka_agent_facts::tool_call::ToolSettlement::Unknown)
                {
                    return Err(StoreError::EventConflict);
                }
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .local_returned = Some(returned);
                if *settlement != maka_agent_facts::tool_call::ToolSettlement::Unknown {
                    for blocker in self.blockers.values_mut() {
                        if blocker.decision.is_none()
                            && blocker.resolved_by.is_none()
                            && matches!(&blocker.reason,BlockerKind::OriginalAdmissionUnknown{tool:key} if key==tool)
                        {
                            blocker.resolved_by = Some(recorded.id);
                        }
                    }
                }
            }
            Fact::ToolResultAccepted {
                tool,
                result,
                outcome,
            } => {
                let current = self.tool(tool)?;
                let acceptance = ToolAcceptance {
                    result: result.clone(),
                    outcome: outcome.clone(),
                };
                let local = current.local_returned.as_ref().filter(|returned| {
                    returned.settlement != maka_agent_facts::tool_call::ToolSettlement::Unknown
                });
                if let Some(existing) = &current.accepted {
                    if existing != &acceptance {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    let valid = match outcome {
                        AcceptedResult::Succeeded => {
                            local.is_some_and(|returned| !returned.is_error)
                                || (current.host_returned.as_ref().is_some_and(|returned|!returned.is_error) && current.receipt.as_ref().is_some_and(|receipt|matches!(receipt,Receipt::Recorded{outcome,..} if known(outcome))))
                                || current
                                    .provider_result
                                    .as_ref()
                                    .is_some_and(|result| !result.is_error)
                                || matches!(
                                    &current.receipt,
                                    Some(Receipt::Recorded {
                                        outcome: OperationOutcome::Returned {
                                            result
                                        },
                                        ..
                                    }) if !result.is_error()
                                )
                        }
                        AcceptedResult::Failed => {
                            local.is_some_and(|returned| returned.is_error)
                                || (current.host_returned.as_ref().is_some_and(|returned|returned.is_error) && current.receipt.as_ref().is_some_and(|receipt|matches!(receipt,Receipt::Recorded{outcome,..} if known(outcome))))
                                || current
                                    .provider_result
                                    .as_ref()
                                    .is_some_and(|result| result.is_error)
                                || matches!(
                                    &current.receipt,
                                    Some(Receipt::Recorded {
                                        outcome: OperationOutcome::Returned {
                                            result
                                        },
                                        ..
                                    }) if result.is_error()
                                )
                        }
                        AcceptedResult::Rejected => {
                            current.prohibited_before_host.is_some()
                                || (!current.admitted
                                    && !current.call.provider_executed
                                    && matches!(
                                        current.decision,
                                        Some(ToolDecision::Rejected { .. })
                                    )
                                    && !matches!(
                                        &current.receipt,
                                        Some(Receipt::Recorded {
                                            outcome: OperationOutcome::Returned { .. },
                                            ..
                                        })
                                    ))
                                || matches!(
                                    &current.receipt,
                                    Some(Receipt::Recorded {
                                        outcome: OperationOutcome::NotExecuted { .. },
                                        ..
                                    })
                                )
                        }
                        AcceptedResult::CellRecovered{cell}=>{
                            current.admitted && !current.call.provider_executed && current.original.is_none()
                                && self.cells.get(cell).is_some_and(|state|{
                                    matches!(&state.owner,maka_agent_facts::cells::CellOwner::Agent{link,call} if link.run==self.run &&link.attempt==tool.attempt && *call==tool.call &&self.attempts.get(&link.attempt).is_some_and(|attempt|attempt.step==link.step))
                                    && matches!(state.status,maka_agent_facts::cells::CellStatus::Completed{..}|maka_agent_facts::cells::CellStatus::Interrupted{..})
                                    && state.children.values().all(|child|child.known()) &&!state.blocks_effect_admission()
                                })
                        }
                        AcceptedResult::RiskAdjudicated { blocker } => {
                            self.blockers.get(blocker).is_some_and(|blocker| {
                                blocker.decision.as_ref().is_some_and(|scoped|matches!(scoped.scope,RiskActionScope::RunCancellation))
                                    || (blocker.decision.is_some() && blocker_covers(&blocker.reason,current))
                            })
                        }
                    };
                    require(
                        valid,
                        "accepted tool result lacks matching original evidence or explicit risk adjudication",
                    )?;
                    self.tools
                        .get_mut(&tool_key(tool))
                        .expect("validated tool")
                        .accepted = Some(acceptance);
                }
                let finish_semantics = matches!(
                    &self.tool(tool)?.decision,
                    Some(ToolDecision::Approved {
                        semantics: ToolSemantics::FinishTurn,
                        ..
                    })
                );
                let success = matches!(outcome, AcceptedResult::Succeeded)
                    || matches!(outcome, AcceptedResult::CellRecovered { cell } if self.cells.get(cell).is_some_and(|cell|matches!(cell.status,maka_agent_facts::cells::CellStatus::Completed{..})));
                self.finish_requested |= finish_semantics && success;
                if let AcceptedResult::CellRecovered { cell } = outcome {
                    for blocker in self.blockers.values_mut() {
                        if blocker.decision.is_none()
                            && blocker.resolved_by.is_none()
                            && (matches!(&blocker.reason,BlockerKind::OriginalAdmissionUnknown{tool:original} if original==tool)
                                || matches!(&blocker.reason,BlockerKind::CodeCellRecoveryUnavailable{cell:original} if original==&cell.to_string()))
                        {
                            blocker.resolved_by = Some(recorded.id);
                        }
                    }
                }
            }
            Fact::OperationObserved { tool, reply } => {
                let current = self.tool(tool)?;
                require(
                    current.original.as_ref() == Some(&reply.reference),
                    "operation reply does not match the exact original reference",
                )?;
                let receipt = join_receipt(current.receipt.as_ref(), &reply.receipt)?;
                for blocker in self.blockers.values_mut() {
                    if blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                        && resolves_blocker(&blocker.reason, tool, &reply.reference, &receipt)
                    {
                        blocker.resolved_by = Some(recorded.id);
                    }
                }
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .receipt = Some(receipt);
            }
            Fact::ToolPreventedBeforeHostAdmission { tool, rejection } => {
                let current = self.tool(tool)?;
                require(
                    current.admitted && current.original.is_none() && current.receipt.is_none(),
                    "prevention proof requires the original logical admission without a Host reference or receipt",
                )?;
                if let Some(existing) = &current.prohibited_before_host
                    && existing != rejection
                {
                    return Err(StoreError::EventConflict);
                }
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .prohibited_before_host = Some(rejection.clone());
                for blocker in self.blockers.values_mut() {
                    if blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                        && matches!(&blocker.reason, BlockerKind::OriginalAdmissionUnknown { tool: key } if key == tool)
                    {
                        blocker.resolved_by = Some(recorded.id);
                    }
                }
            }
            Fact::StopRequested { .. } => {
                self.stopped = true;
                self.stop_request = Some(recorded.id);
                self.stop_assessed = None;
                self.resolve_external_observation(recorded.id);
            }
            Fact::StopAssessed { request } => {
                require(
                    self.stopped && self.stop_request == Some(*request),
                    "stop assessment does not name the current StopRequested fact",
                )?;
                require(
                    self.stop_assessed != Some(*request),
                    "stop request is already assessed at this evidence cut",
                )?;
                self.stop_assessed = Some(*request);
            }
            Fact::ApprovalRecorded {
                approval,
                tool,
                input_digest,
                expires_at,
            } => {
                let current = self.tool(tool)?;
                require(
                    !current.admitted && current.accepted.is_none(),
                    "cannot approve a dispatched or accepted tool",
                )?;
                require(!self.stopped, "cannot approve work after stop")?;
                require(
                    current.approval_refusal.is_none(),
                    "refused tool cannot receive an approval grant",
                )?;
                if let Some(ToolDecision::Approved { input, .. }) = &current.decision {
                    require(
                        input.digest == *input_digest,
                        "approval input digest differs from decided input",
                    )?;
                }
                require(
                    expires_at.is_none_or(|expiry| recorded.at < expiry),
                    "approval already expired",
                )?;
                let grant = Approval {
                    tool: tool.clone(),
                    input_digest: input_digest.clone(),
                    expires_at: *expires_at,
                    consumed: false,
                };
                if self.approvals.contains_key(approval) {
                    return Err(StoreError::EventConflict);
                }
                self.approvals.insert(*approval, grant);
            }
            Fact::ApprovalRefused {
                approval,
                tool,
                outcome,
            } => {
                require(
                    !self.stopped && self.spec.origin == RunOrigin::Local,
                    "approval refusal requires a live local run",
                )?;
                require(
                    outcome.is_approval_refusal(),
                    "approval refusal is not a negative approval outcome",
                )?;
                require(
                    i64::try_from(outcome.committed_at()).ok() == Some(recorded.at.0),
                    "approval refusal differs from original answer timestamp",
                )?;
                let current = self.tool(tool)?;
                require(
                    !current.admitted
                        && current.accepted.is_none()
                        && current.prohibited_before_host.is_none(),
                    "approval refusal target is no longer pending",
                )?;
                if let Some(decision) = &current.decision {
                    require(
                        matches!(decision, ToolDecision::Approved { approval:Some(original), .. } if original==approval),
                        "approval refusal does not name the original approval",
                    )?;
                }
                require(
                    !self.approvals.contains_key(approval),
                    "approval already has a positive grant",
                )?;
                if current.approval_refusal.is_some() {
                    return Err(StoreError::EventConflict);
                }
                self.tools
                    .get_mut(&tool_key(tool))
                    .expect("validated tool")
                    .approval_refusal = Some(ApprovalRefusal {
                    approval: *approval,
                    outcome: outcome.clone(),
                });
            }
            Fact::ApprovalConsumed { approval, tool } => {
                let grant = self
                    .approvals
                    .get(approval)
                    .ok_or_else(|| StoreError::InvalidTransition("unknown approval".into()))?;
                require(
                    !grant.consumed && grant.tool == *tool,
                    "approval already consumed or bound to another tool",
                )?;
                require(
                    grant.expires_at.is_none_or(|expiry| recorded.at < expiry),
                    "approval expired",
                )?;
                let current = self.tool(tool)?;
                require(
                    !current.admitted && current.accepted.is_none(),
                    "approval cannot be consumed after dispatch or acceptance",
                )?;
                require(
                    current.approval_refusal.is_none(),
                    "refused tool cannot consume an approval",
                )?;
                require(
                    matches!(&current.decision, Some(ToolDecision::Approved { input, approval: Some(id), .. })
                    if id == approval && input.digest == grant.input_digest),
                    "approval is not bound to the decided tool input",
                )?;
                self.approvals
                    .get_mut(approval)
                    .expect("validated approval")
                    .consumed = true;
            }
            Fact::RetryCharged {
                attempt,
                phase,
                due_at,
                diagnostic,
            } => {
                let current = self.attempt(attempt)?;
                require(
                    self.retry_pending == Some(*attempt),
                    "retry does not belong to the pending failed attempt",
                )?;
                self.retry_safe()?;
                require(
                    *phase == RetryTransportPhase::Primary
                        || self.retry_phase == RetryTransportPhase::Fallback,
                    "Fallback retry has no canonical transport selection",
                )?;
                require(
                    current.interrupted.is_some()
                        || current
                            .closed
                            .as_ref()
                            .is_some_and(|closure| closure.diagnostic.is_some()),
                    "retry requires a failed closed model attempt",
                )?;
                require(
                    current.retry.is_none(),
                    "model attempt retry already charged",
                )?;
                require(
                    u64::from(self.retries_for(*phase))
                        < u64::from(self.spec.budget.retries)
                            + u64::from(*phase == RetryTransportPhase::Fallback),
                    "original transport phase retry budget exhausted",
                )?;
                if let Some(AttemptRecovery::FrozenRetrySafe {
                    not_before: Some(not_before),
                }) = &current.recovery
                {
                    require(
                        *due_at >= *not_before,
                        "retry backoff precedes the provider lower bound",
                    )?;
                }
                let retries = self.retries.checked_add(1).ok_or_else(|| {
                    StoreError::InvalidTransition("retry counter overflow".into())
                })?;
                self.attempts
                    .get_mut(attempt)
                    .expect("validated attempt")
                    .retry = Some(Retry {
                    phase: *phase,
                    due_at: *due_at,
                    diagnostic: diagnostic.clone(),
                });
                self.retries = retries;
                self.retry_due_at = Some(
                    self.retry_due_at
                        .map_or(*due_at, |previous| previous.max(*due_at)),
                );
            }
            Fact::BudgetCharged { tokens } => {
                self.tokens = self.tokens.checked_add(*tokens).ok_or_else(|| {
                    StoreError::InvalidTransition("token counter overflow".into())
                })?;
            }
            Fact::Blocked { blocker, reason } => {
                self.validate_blocker(reason)?;
                if let Some(existing) = self.blockers.get(blocker) {
                    if existing.reason != *reason {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.blockers.insert(
                        *blocker,
                        Blocker {
                            reason: reason.clone(),
                            decision: None,
                            resolved_by: None,
                        },
                    );
                }
            }
            Fact::BlockerResolved { blocker, .. } => {
                let current = self.blockers.get(blocker).ok_or_else(|| {
                    StoreError::InvalidTransition("unknown resolved blocker".into())
                })?;
                require(current.resolved_by.is_none(), "blocker is already resolved")?;
                self.blockers
                    .get_mut(blocker)
                    .expect("validated blocker")
                    .resolved_by = Some(recorded.id);
            }
            Fact::RiskAdjudicated {
                blocker,
                decision,
                scope,
            } => {
                let current = self
                    .blockers
                    .get(blocker)
                    .ok_or_else(|| StoreError::InvalidTransition("unknown risk blocker".into()))?;
                if current.decision.is_some() || current.resolved_by.is_some() {
                    return Err(StoreError::EventConflict);
                }
                if let BlockerKind::ProviderEffectUnknown { attempt, call } = &current.reason
                    && !self.tools.contains_key(&tool_key(&ToolKey {
                        attempt: *attempt,
                        call: call.clone(),
                    }))
                {
                    require(
                        matches!(scope, RiskActionScope::RunCancellation),
                        "private summary provider effects require whole-run cancellation",
                    )?;
                }
                if matches!(
                    current.reason,
                    BlockerKind::ToolCleanupUnconfirmed { .. }
                        | BlockerKind::ModelCleanupUnconfirmed { .. }
                ) {
                    require(
                        matches!(scope, RiskActionScope::RunCancellation),
                        "unconfirmed local tool cleanup permits only whole-run cancellation",
                    )?;
                }
                match scope {
                    RiskActionScope::RunCancellation => require(
                        matches!(decision, RiskDecision::CancelBlockedRun { .. }),
                        "run cancellation scope requires cancellation",
                    )?,
                    RiskActionScope::Tool { tool } => {
                        require(
                            !matches!(decision, RiskDecision::CancelBlockedRun { .. }),
                            "cancellation must use run scope",
                        )?;
                        require(
                            blocker_covers(&current.reason, self.tool(tool)?),
                            "risk scope names a different tool obligation",
                        )?;
                    }
                    RiskActionScope::ModelReplan { attempt, base_step } => {
                        require(
                            !matches!(decision, RiskDecision::CancelBlockedRun { .. }),
                            "cancellation must use run scope",
                        )?;
                        require(
                            self.current_step == Some(*base_step)
                                && self.current_attempt == Some(*attempt)
                                && self.attempt(attempt)?.step == *base_step,
                            "risk scope does not name the current actual model base",
                        )?;
                    }
                }
                let scoped = ScopedRiskDecision {
                    decision: decision.clone(),
                    scope: scope.clone(),
                };
                self.blockers
                    .get_mut(blocker)
                    .expect("validated blocker")
                    .decision = Some(scoped.clone());
                if matches!(scope, RiskActionScope::RunCancellation) {
                    self.stopped = true;
                    self.cancelled_by_risk = true;
                } else if matches!(scope, RiskActionScope::ModelReplan { .. }) {
                    self.replans.insert(*blocker, scoped);
                }
            }
            Fact::WaitRegistered {
                wait,
                reason,
                due_at,
            } => {
                self.validate_wait(reason, *due_at)?;
                if let Some(existing) = self.waits.get(wait) {
                    if existing.reason != *reason || existing.due_at != *due_at {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.waits.insert(
                        *wait,
                        Wait {
                            reason: reason.clone(),
                            due_at: *due_at,
                            satisfied: None,
                            cancelled: None,
                        },
                    );
                }
            }
            Fact::WaitCancelled { wait, diagnostic } => {
                let current = self.waits.get_mut(wait).ok_or_else(|| {
                    StoreError::InvalidTransition("unknown cancelled wait".into())
                })?;
                if let Some(existing) = &current.cancelled {
                    if existing != diagnostic {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    current.cancelled = Some(diagnostic.clone());
                }
            }
            Fact::WaitSatisfied { wait, evidence } => {
                let current = self
                    .waits
                    .get(wait)
                    .ok_or_else(|| StoreError::InvalidTransition("unknown wait".into()))?;
                if let Some(existing) = &current.satisfied {
                    if existing != evidence {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.waits.get_mut(wait).expect("validated wait").satisfied =
                        Some(evidence.clone());
                }
            }
            Fact::RunTerminated { terminal, .. } => {
                require(
                    !self.cancelled_by_risk || matches!(terminal, Terminal::Cancelled),
                    "risk cancellation is a sticky logical fence",
                )?;
                // An unsuccessful Run may close logically while original receipts
                // and cleanup remain outstanding and observable in its history.
                let recovery_failed =
                    *terminal == Terminal::Failed && self.recovery_failure().is_some();
                let legacy_cancelled = *terminal == Terminal::Cancelled && self.cancelled_by_risk;
                require(
                    recovery_failed || self.external_terminal_allowed(terminal),
                    "external task is not closed or explicitly risk-cancelled",
                )?;
                require(
                    recovery_failed
                        || crate::external_publication::terminal_allowed(self, terminal),
                    "external publication has unfinished original obligations",
                )?;
                require(
                    recovery_failed
                        || legacy_cancelled
                        || self.tools.values().all(|tool| tool.accepted.is_some()),
                    "run still has unaccepted hard tool obligations",
                )?;
                require(
                    recovery_failed
                        || legacy_cancelled
                        || self.attempts.values().all(|attempt| {
                            attempt.closed.is_some() || attempt.interrupted.is_some()
                        }),
                    "run still has open model attempts",
                )?;
                require(
                    !matches!(terminal, Terminal::Completed) || !self.stopped,
                    "stopped run cannot complete successfully",
                )?;
                if matches!(terminal, Terminal::Completed) {
                    require(
                        self.attempts.values().all(|attempt| {
                            attempt.admission.is_none()
                                || attempt.cleanup == OperationCleanup::Confirmed
                        }),
                        "successful completion requires actual model cleanup acknowledgements",
                    )?;
                    require(
                        self.cells.values().all(|cell| !cell.pending()),
                        "run has pending Cell obligations",
                    )?;
                    require(
                        self.tools.values().all(|tool| {
                            tool.original.is_none()
                                || matches!(
                                    &tool.receipt,
                                    Some(Receipt::Recorded {
                                        cleanup: OperationCleanup::Confirmed,
                                        ..
                                    })
                                )
                        }),
                        "successful completion requires actual original tool cleanup acknowledgements",
                    )?;
                }
                self.terminal = Some(terminal.clone());
            }
        }
        self.revision = recorded.revision;
        self.control_version = next_control;
        Ok(())
    }

    pub(crate) fn validate_blocker_resolution(&self, blocker: BlockerId) -> Result<(), StoreError> {
        let current = self
            .blockers
            .get(&blocker)
            .ok_or_else(|| StoreError::InvalidTransition("unknown resolved blocker".into()))?;
        let resolvable = match &current.reason {
            BlockerKind::CurrentAuthorityUnavailable { .. } => true,
            BlockerKind::CodeCellRecoveryUnavailable { cell } => self
                .recovery_cell(cell)
                .is_some_and(|cell| !cell.has_unsettled_effects()),
            _ => false,
        };
        require(
            resolvable,
            "this blocker requires an observation from its original source",
        )
    }

    fn validate_blocker(&self, reason: &BlockerKind) -> Result<(), StoreError> {
        match reason {
            BlockerKind::CurrentAuthorityUnavailable { .. } => Ok(()),
            BlockerKind::ExternalPublicationUnavailable { publication, .. } => {
                crate::external_publication::validate_unavailable(self, *publication)
            }
            BlockerKind::ExternalPublicationItem { key, reason } => {
                crate::external_publication::validate_item_blocker(self, key, *reason)
            }
            BlockerKind::ExternalEffectUnknown { task, operation } => require(
                self.external.as_ref().is_some_and(|external| {
                    external.task == *task
                        && external
                            .effects
                            .get(operation)
                            .is_some_and(|effect| effect.pending())
                }),
                "external effect blocker names no pending actual effect",
            ),
            BlockerKind::OperationUnknown { tool, reference } => {
                let current = self.tool(tool)?;
                require(
                    current.original.as_ref() == Some(reference),
                    "blocker does not name the original tool operation",
                )?;
                require(
                    !matches!(&current.receipt, Some(Receipt::Recorded { outcome, .. }) if known(outcome)),
                    "original operation outcome is already known",
                )
            }
            BlockerKind::ProviderEffectUnknown { attempt, call } => {
                let key = ToolKey {
                    attempt: *attempt,
                    call: call.clone(),
                };
                if let Some(tool) = self.tools.get(&tool_key(&key)) {
                    require(
                        tool.call.provider_executed && tool.provider_result.is_none(),
                        "provider effect blocker requires an unresolved provider-executed call",
                    )
                } else {
                    let closure = self.attempt(attempt)?.closed.as_ref().ok_or_else(|| {
                        StoreError::InvalidTransition(
                            "private provider effect has no original closure evidence".into(),
                        )
                    })?;
                    let protocol: maka_agent_facts::context::ModelClosureProtocol =
                        serde_json::from_value(closure.protocol.clone())?;
                    require(
                        matches!(protocol.summary,
                        Some(maka_agent_facts::context::SummaryResult::ProviderEffectsUnknown { calls }) if calls.contains(call)),
                        "private provider effect is absent from the original typed summary closure",
                    )
                }
            }
            BlockerKind::OriginalAdmissionUnknown { tool } => {
                let current = self.tool(tool)?;
                require(
                    current.admitted
                        && current.original.is_none()
                        && current.prohibited_before_host.is_none()
                        && current.local_returned.as_ref().is_none_or(|returned| {
                            returned.settlement
                                == maka_agent_facts::tool_call::ToolSettlement::Unknown
                        }),
                    "original admission blocker requires an admitted tool without known local return, original lookup or prevention proof",
                )
            }
            BlockerKind::CodeCellRecoveryUnavailable { cell } => {
                require(!cell.is_empty(), "empty code cell identity")
            }
            BlockerKind::ResourcesUnavailable { tool } => {
                self.tool(tool)?;
                Ok(())
            }
            BlockerKind::ToolCleanupUnconfirmed { tool, diagnostic } => {
                require(
                    self.tool(tool)?.admitted,
                    "tool cleanup blocker requires the original Tool T1",
                )?;
                require(
                    !diagnostic.trim().is_empty(),
                    "empty tool cleanup diagnostic",
                )
            }
            BlockerKind::ModelCleanupUnconfirmed {
                attempt,
                diagnostic,
            } => {
                let original = self.attempt(attempt)?;
                require(
                    original.admission.is_some() && original.cleanup != OperationCleanup::Confirmed,
                    "model cleanup blocker requires an unconfirmed original admission",
                )?;
                require(
                    !diagnostic.trim().is_empty(),
                    "empty model cleanup diagnostic",
                )
            }
            BlockerKind::CleanupUnconfirmed { reference } => {
                let current = self
                    .tools
                    .values()
                    .find(|tool| tool.original.as_ref() == Some(reference))
                    .ok_or_else(|| {
                        StoreError::InvalidTransition(
                            "cleanup blocker has no original tool operation".into(),
                        )
                    })?;
                require(
                    !matches!(
                        &current.receipt,
                        Some(Receipt::Recorded {
                            cleanup: OperationCleanup::Confirmed,
                            ..
                        })
                    ),
                    "original cleanup is already confirmed",
                )
            }
            BlockerKind::ExternalTaskUnobservable { .. } => require(
                self.external.as_ref().is_none_or(|task| {
                    task.closed.is_none()
                        && !(self.stopped && task.cleanup == OperationCleanup::Confirmed)
                }),
                "settled external observation cannot become unobservable",
            ),
            BlockerKind::UnsupportedProtocol { .. } => Ok(()),
        }
    }

    fn validate_wait(
        &self,
        reason: &WaitReason,
        due_at: Option<UnixMillis>,
    ) -> Result<(), StoreError> {
        match reason {
            WaitReason::Cell { cell } => {
                require(self.cells.contains_key(cell), "wait names no actual Cell")
            }
            WaitReason::External { task } => require(
                self.external.as_ref().is_some_and(|current| {
                    current.task == *task
                        && current.admitted
                        && current.binding.is_some()
                        && current.closed.is_none()
                }) && due_at.is_some(),
                "external wait requires an observable open original task",
            ),
            WaitReason::ProviderBackoff { attempt } => {
                let current = self.attempt(attempt)?;
                let Some(AttemptRecovery::ProjectPrefixSafe {
                    not_before: Some(not_before),
                    ..
                }) = &current.recovery
                else {
                    return Err(StoreError::InvalidTransition(
                        "provider backoff requires a captured safe-prefix lower bound".into(),
                    ));
                };
                require(
                    (current.closed.is_some() || current.interrupted.is_some())
                        && due_at.is_some_and(|due| due >= *not_before),
                    "provider backoff wait precedes its captured lower bound",
                )
            }
            WaitReason::Model { attempt } => {
                let current = self.attempt(attempt)?;
                let waiting = if due_at.is_some() {
                    current.closed.is_none()
                        && current.interrupted.is_none()
                        && matches!(
                            current.recovery,
                            Some(AttemptRecovery::ObserveOriginal { .. })
                        )
                } else {
                    (current.closed.is_some() || current.interrupted.is_some())
                        && current.cleanup != OperationCleanup::Confirmed
                };
                require(
                    current.admission.is_some() && waiting,
                    "model wait requires an open observable original with deadline or unconfirmed admitted cleanup",
                )
            }
            WaitReason::Approval { approval } => require(
                self.approvals
                    .get(approval)
                    .is_none_or(|approval| !approval.consumed),
                "wait references an already consumed approval",
            ),
            WaitReason::Retry { attempt } => {
                let retry = self.attempt(attempt)?.retry.as_ref().ok_or_else(|| {
                    StoreError::InvalidTransition("wait references an uncharged retry".into())
                })?;
                require(
                    due_at == Some(retry.due_at),
                    "retry wait deadline differs from charged backoff",
                )
            }
            WaitReason::Operation { tool } => {
                self.tool(tool)?;
                Ok(())
            }
            WaitReason::Child { run } => require(*run != self.run, "run cannot wait on itself"),
            WaitReason::Blocker { blocker } => require(
                self.blockers.contains_key(blocker),
                "wait references an unknown blocker",
            ),
        }
    }
}

pub(crate) fn blocker_covers(reason: &BlockerKind, tool: &Tool) -> bool {
    match reason {
        BlockerKind::OperationUnknown {
            tool: key,
            reference,
        } => *key == tool.key && tool.original.as_ref() == Some(reference),
        BlockerKind::ProviderEffectUnknown { attempt, call } => {
            *attempt == tool.key.attempt && *call == tool.key.call
        }
        BlockerKind::ResourcesUnavailable { tool: key }
        | BlockerKind::OriginalAdmissionUnknown { tool: key }
        | BlockerKind::ToolCleanupUnconfirmed { tool: key, .. } => *key == tool.key,
        BlockerKind::CleanupUnconfirmed { reference } => tool.original.as_ref() == Some(reference),
        BlockerKind::CurrentAuthorityUnavailable { .. }
        | BlockerKind::ModelCleanupUnconfirmed { .. }
        | BlockerKind::ExternalEffectUnknown { .. }
        | BlockerKind::ExternalPublicationUnavailable { .. }
        | BlockerKind::ExternalPublicationItem { .. }
        | BlockerKind::UnsupportedProtocol { .. }
        | BlockerKind::ExternalTaskUnobservable { .. }
        | BlockerKind::CodeCellRecoveryUnavailable { .. } => false,
    }
}

fn resolves_blocker(
    reason: &BlockerKind,
    tool: &ToolKey,
    reference: &RecoveryRef,
    receipt: &Receipt,
) -> bool {
    match (reason, receipt) {
        (
            BlockerKind::OriginalAdmissionUnknown { tool: original },
            Receipt::Recorded { outcome, .. },
        ) => original == tool && known(outcome),
        (
            BlockerKind::OperationUnknown {
                reference: original,
                ..
            },
            Receipt::Recorded { outcome, .. },
        ) => original == reference && known(outcome),
        (
            BlockerKind::CleanupUnconfirmed {
                reference: original,
            },
            Receipt::Recorded {
                cleanup: OperationCleanup::Confirmed,
                ..
            },
        ) => original == reference,
        (
            BlockerKind::ToolCleanupUnconfirmed { tool: original, .. },
            Receipt::Recorded {
                cleanup: OperationCleanup::Confirmed,
                ..
            },
        ) => original == tool,
        _ => false,
    }
}

fn known<R>(outcome: &maka_plugin_core::operation::OperationOutcome<R>) -> bool {
    use maka_plugin_core::operation::OperationOutcome;
    matches!(
        outcome,
        OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. }
    )
}

/// Outcome and cleanup are independent monotone components; human decisions never enter this join.
fn join_receipt(previous: Option<&Receipt>, incoming: &Receipt) -> Result<Receipt, StoreError> {
    let Some(previous) = previous else {
        return Ok(incoming.clone());
    };
    match (previous, incoming) {
        (
            Receipt::Recorded {
                outcome: old,
                cleanup: old_cleanup,
            },
            Receipt::Recorded {
                outcome: new,
                cleanup: new_cleanup,
            },
        ) => {
            if known(old) && known(new) {
                let equal = match (old, new) {
                    (
                        OperationOutcome::Returned { result: a },
                        OperationOutcome::Returned { result: b },
                    ) => a.same_result(b)?,
                    (a, b) => a == b,
                };
                if !equal {
                    return Err(StoreError::EventConflict);
                }
            }
            let keep_known = known(old)
                && !matches!(
                    new,
                    OperationOutcome::Returned {
                        result: maka_agent_facts::operation::RecordedOperationResult::Referenced { .. },
                    }
                );
            let outcome = if keep_known
                || matches!(new, OperationOutcome::Unresolved)
                || matches!(
                    (old, new),
                    (
                        OperationOutcome::Unknown { .. },
                        OperationOutcome::Unknown { .. }
                    )
                ) {
                old.clone()
            } else {
                new.clone()
            };
            let cleanup = match (old_cleanup, new_cleanup) {
                (OperationCleanup::Confirmed, _) | (_, OperationCleanup::Confirmed) => {
                    OperationCleanup::Confirmed
                }
                (OperationCleanup::Failed { .. }, _) => old_cleanup.clone(),
                (_, OperationCleanup::Failed { .. }) => new_cleanup.clone(),
                _ => OperationCleanup::Unconfirmed,
            };
            Ok(Receipt::Recorded { outcome, cleanup })
        }
        (Receipt::Recorded { .. }, _) | (Receipt::NotRecorded, Receipt::Unavailable { .. }) => {
            Ok(previous.clone())
        }
        (_, Receipt::Recorded { .. } | Receipt::NotRecorded) => Ok(incoming.clone()),
        (Receipt::Unavailable { .. }, Receipt::Unavailable { .. }) => Ok(previous.clone()),
    }
}

fn join_recovery(
    previous: Option<&AttemptRecovery>,
    incoming: &AttemptRecovery,
) -> Result<AttemptRecovery, StoreError> {
    match previous {
        None | Some(AttemptRecovery::Blocked { .. }) => Ok(incoming.clone()),
        Some(previous)
            if matches!(incoming, AttemptRecovery::Blocked { .. }) || previous == incoming =>
        {
            Ok(previous.clone())
        }
        Some(_) => Err(StoreError::EventConflict),
    }
}

pub(crate) fn original_effect_unknown(tool: &Tool) -> bool {
    local_effect_unknown(tool)
        || tool.original.is_some()
            && !matches!(
                &tool.receipt,
                Some(Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. }
                        | OperationOutcome::NotExecuted { .. },
                    ..
                })
            )
}
pub(crate) fn attempt_unsettled(attempt: &Attempt) -> bool {
    attempt.admission.is_some()
        && (attempt.cleanup != OperationCleanup::Confirmed
            || (attempt.closed.is_none()
                && matches!(
                    attempt.recovery,
                    Some(AttemptRecovery::ObserveOriginal { .. })
                )))
}

fn tool_unsettled(tool: &Tool) -> bool {
    let cleanup = tool.original.is_some()
        && !matches!(
            &tool.receipt,
            Some(Receipt::Recorded {
                cleanup: OperationCleanup::Confirmed,
                ..
            })
        );
    let unknown_admission = tool.admitted
        && tool.original.is_none()
        && tool.prohibited_before_host.is_none()
        && tool.local_returned.is_none()
        && !cell_context_recovered(tool);
    original_effect_unknown(tool)
        || cleanup
        || unknown_admission
        || (tool.call.provider_executed && tool.provider_result.is_none())
}
pub(crate) fn tool_pending(tool: &Tool) -> bool {
    tool.accepted.is_none() || tool_unsettled(tool)
}

fn receipt_blocks_effects<R>(receipt: &maka_plugin_core::operation::Receipt<R>) -> bool {
    use maka_plugin_core::operation::{OperationOutcome, Receipt};
    match receipt {
        Receipt::NotRecorded | Receipt::Unavailable { .. } => true,
        Receipt::Recorded { outcome, cleanup } => {
            matches!(outcome, OperationOutcome::Unknown { .. })
                || matches!(cleanup, OperationCleanup::Failed { .. })
                || (known(outcome) && *cleanup != OperationCleanup::Confirmed)
        }
    }
}

fn cell_context_recovered(tool: &Tool) -> bool {
    tool.accepted
        .as_ref()
        .is_some_and(|accepted| matches!(accepted.outcome, AcceptedResult::CellRecovered { .. }))
}
fn local_effect_unknown(tool: &Tool) -> bool {
    !cell_context_recovered(tool)
        && !matches!(&tool.receipt, Some(Receipt::Recorded { outcome, .. }) if known(outcome))
        && tool.local_returned.as_ref().is_some_and(|result| {
            result.settlement == maka_agent_facts::tool_call::ToolSettlement::Unknown
        })
}
