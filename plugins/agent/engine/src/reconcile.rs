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

//! The only next-action policy. State folds facts; Native executes capabilities.
use crate::ports::{Preparation, ReplanInput};
use maka_agent_facts::operation::RecordedReceipt;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::{
    cells::{CellId, CellOwner, CellStatus},
    context::{ModelClosureProtocol, SummaryResult},
    durable::*,
    external_publication::{
        ExternalPublicationBlocker, ExternalPublicationKey, ExternalPublicationOutcome,
    },
};
use maka_agent_state::fold::RunView;
use maka_plugin_core::operation::{OperationOutcome, Receipt};
use serde::Deserialize;
use std::collections::BTreeSet;

#[cfg(test)]
pub(crate) mod tests;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum WorkKey {
    Prepare,
    CancelModel(ModelAttemptId),
    External,
    Publication(ExternalPublicationId),
    Cell(CellId),
    Model(ModelAttemptId),
    Tool(ToolKey),
}
pub(crate) struct ModelLevel {
    pub input: maka_agent_facts::input::RunInput,
    pub request: Option<RequestSpec>,
    pub baseline: Option<maka_agent_facts::context::CompactedContext>,
    pub compaction: CompactionLevel,
    pub failure: Option<maka_agent_facts::context::ModelFailureProtocol>,
    pub fallback_available: bool,
}
pub(crate) enum CleanupAction {
    Done,
    Wait(UnixMillis),
    Observe,
}
pub(crate) fn cleanup_next(
    view: &maka_agent_state::CleanupFrontier,
    now: UnixMillis,
) -> CleanupAction {
    if view.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed {
        return CleanupAction::Done;
    }
    match view.not_before {
        Some(at) if at > now => CleanupAction::Wait(at),
        _ => CleanupAction::Observe,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompactionLevel {
    None,
    Fresh {
        prepare: bool,
    },
    Summary {
        main: Option<StepId>,
        adopt: bool,
        native: bool,
    },
    Candidate {
        summary: ModelAttemptId,
        adopt: bool,
    },
    Adopted {
        summary: ModelAttemptId,
    },
}

fn closure_protocol(
    closed: &maka_agent_state::fold::ModelClosure,
) -> Result<ModelClosureProtocol, Box<BlockerKind>> {
    ModelClosureProtocol::deserialize(&closed.protocol).map_err(|error| {
        Box::new(BlockerKind::UnsupportedProtocol {
            protocol: format!("model-closure: {error}"),
            version: 1,
        })
    })
}

pub(crate) fn tool_incomplete(view: &RunView, key: &ToolKey) -> Result<bool, Box<BlockerKind>> {
    let closed = view
        .attempts
        .get(&key.attempt)
        .and_then(|attempt| attempt.closed.as_ref())
        .filter(|closed| {
            closed.diagnostic.is_none()
                && closed.outcome == maka_agent_facts::accounting::Outcome::Success
        });
    match closed {
        Some(closed) => Ok(closure_protocol(closed)?.finish_reason
            == maka_agent_facts::model::ModelFinishReason::Length),
        None => Ok(false),
    }
}

fn summary_effects(view: &RunView) -> Option<Action> {
    if view.cancelled_by_risk {
        return None;
    }
    let id = view.current_attempt?;
    let closed = view.attempts.get(&id)?.closed.as_ref()?;
    if closed
        .protocol
        .get("summary")
        .is_none_or(serde_json::Value::is_null)
    {
        return None;
    }
    let protocol = match closure_protocol(closed) {
        Ok(protocol) => protocol,
        Err(reason) => {
            return Some(
                if view
                    .blockers
                    .values()
                    .any(|blocker| blocker.reason == *reason && active(blocker))
                {
                    Action::Idle
                } else {
                    Action::Block(*reason)
                },
            );
        }
    };
    let Some(SummaryResult::ProviderEffectsUnknown { calls }) = protocol.summary else {
        return None;
    };
    for call in calls {
        let reason = BlockerKind::ProviderEffectUnknown { attempt: id, call };
        if !view
            .blockers
            .values()
            .any(|blocker| blocker.reason == reason)
        {
            return Some(Action::Block(reason));
        }
    }
    Some(Action::Idle)
}
#[derive(Default)]
pub(crate) struct Live {
    pub work: BTreeSet<WorkKey>,
    /// At most one read per physical activation. Further observations are due waits.
    pub observed: BTreeSet<ToolKey>,
    pub looked_up: BTreeSet<ToolKey>,
    pub models_observed: BTreeSet<ModelAttemptId>,
    pub models_cancelled: BTreeSet<ModelAttemptId>,
    pub external_observed: bool,
    pub cells_observed: BTreeSet<CellId>,
    pub stop_request: Option<FactId>,
    pub publication_prepared: BTreeSet<ExternalPublicationId>,
    pub publication_looked_up: BTreeSet<ExternalPublicationKey>,
    pub publication_observed: BTreeSet<ExternalPublicationKey>,
}
pub(crate) enum Action {
    Prepare(Preparation),
    ObserveCell(CellId),
    AcceptCellFinal(CellId),
    ReportCellInterruption(CellId),
    Compact(ModelAttemptId),
    PreparePublication(ExternalPublicationId),
    ValidatePublication(ExternalPublicationKey),
    LookupPublication(ExternalPublicationKey),
    ObservePublication(
        ExternalPublicationKey,
        maka_plugin_core::operation::RecoveryRef,
    ),
    AbandonPublication(ExternalPublicationId),
    PrepareExternal(ExternalTaskId),
    StartExternal(ExternalTaskId),
    ObserveExternal(ExternalTaskId, ContentRef),
    Attempt(StepId),
    Start(ModelAttemptId),
    Assess(ModelAttemptId),
    ObserveModel(ModelAttemptId, ContentRef),
    Interrupt(ModelAttemptId, String),
    CancelModel(ModelAttemptId),
    Decide(ToolKey),
    Lookup(ToolKey),
    Observe(ToolKey),
    Reject(ToolKey, ToolRejection),
    Accept(ToolKey, AcceptedResult),
    ChargeRetry(
        ModelAttemptId,
        maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ),
    SelectTransport(
        ModelAttemptId,
        maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ),
    Block(BlockerKind),
    Wait(WaitReason, Option<UnixMillis>),
    Satisfy(WaitId),
    CancelWait(WaitId),
    Terminate(Terminal),
    Idle,
}
fn waiting(view: &RunView, reason: &WaitReason, due: Option<UnixMillis>, now: UnixMillis) -> bool {
    view.waits.values().any(|wait| {
        wait.reason == *reason
            && wait.satisfied.is_none()
            && wait.cancelled.is_none()
            && match (wait.due_at, due) {
                (None, None) => true,
                (Some(old), Some(_)) => old > now,
                _ => false,
            }
    })
}
fn wait(view: &RunView, reason: WaitReason, due: Option<UnixMillis>, now: UnixMillis) -> Action {
    if waiting(view, &reason, due, now) {
        Action::Idle
    } else {
        Action::Wait(reason, due)
    }
}
fn unresolved(view: &RunView) -> bool {
    view.blockers
        .values()
        .any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
}
fn active(blocker: &maka_agent_state::fold::Blocker) -> bool {
    blocker.decision.is_none() && blocker.resolved_by.is_none()
}
fn known(receipt: &Option<RecordedReceipt>) -> bool {
    matches!(
        receipt,
        Some(Receipt::Recorded {
            outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
            ..
        })
    )
}
fn cell_context_recovered(tool: &maka_agent_state::fold::Tool) -> bool {
    tool.accepted
        .as_ref()
        .is_some_and(|accepted| matches!(accepted.outcome, AcceptedResult::CellRecovered { .. }))
}

fn outcome(tool: &maka_agent_state::fold::Tool) -> Option<AcceptedResult> {
    if let Some(local) = &tool.local_returned {
        if local.settlement == maka_agent_facts::tool_call::ToolSettlement::Unknown {
            return None;
        }
        return Some(if local.is_error {
            AcceptedResult::Failed
        } else {
            AcceptedResult::Succeeded
        });
    }
    if let Some(provider) = &tool.provider_result {
        return Some(if provider.is_error {
            AcceptedResult::Failed
        } else {
            AcceptedResult::Succeeded
        });
    }
    match &tool.receipt {
        Some(Receipt::Recorded {
            outcome: OperationOutcome::Returned { result },
            ..
        }) => Some(if result.is_error() {
            AcceptedResult::Failed
        } else {
            AcceptedResult::Succeeded
        }),
        Some(Receipt::Recorded {
            outcome: OperationOutcome::NotExecuted { .. },
            ..
        }) => Some(AcceptedResult::Rejected),
        _ if tool.prohibited_before_host.is_some()
            || matches!(tool.decision, Some(ToolDecision::Rejected { .. })) =>
        {
            Some(AcceptedResult::Rejected)
        }
        _ => None,
    }
}
impl Live {
    pub(crate) fn only_cleanup(&self, view: &RunView) -> bool {
        self.work.iter().all(|key| match key {
            WorkKey::Model(id) => view.attempts.get(id).is_some_and(|a| a.closed.is_some()),
            WorkKey::External => view
                .external
                .as_ref()
                .is_some_and(|task| task.closed.is_some()),
            WorkKey::Tool(key) => view
                .tools
                .get(&maka_agent_state::fold::tool_key(key))
                .is_some_and(|tool| tool.accepted.is_some() && outcome(tool).is_some()),
            WorkKey::Cell(id) => view
                .cells
                .get(id)
                .is_some_and(|cell| !matches!(cell.status, CellStatus::Running)),
            WorkKey::Publication(id) => view
                .external
                .as_ref()
                .and_then(|task| task.publication.as_ref())
                .is_some_and(|publication| {
                    publication.id == *id
                        && (publication.applied()
                            || (!publication.items.is_empty()
                                && publication.items.values().all(|item| item.known())))
                }),
            WorkKey::Prepare | WorkKey::CancelModel(_) => false,
        })
    }
}
fn adjudicated_tool(view: &RunView, tool: &maka_agent_state::fold::Tool) -> Option<BlockerId> {
    view.blockers.iter().find_map(|(id, b)| {
        let decision = b.decision.as_ref()?;
        if matches!(decision.scope, RiskActionScope::RunCancellation) {
            return Some(*id);
        }
        let covers = match &b.reason {
            BlockerKind::OperationUnknown {
                tool: key,
                reference,
            } => key == &tool.key && tool.original.as_ref() == Some(reference),
            BlockerKind::OriginalAdmissionUnknown { tool: key }
            | BlockerKind::ResourcesUnavailable { tool: key } => key == &tool.key,
            BlockerKind::ProviderEffectUnknown { attempt, call } => {
                *attempt == tool.key.attempt && call == &tool.key.call
            }
            BlockerKind::CleanupUnconfirmed { reference } => {
                tool.original.as_ref() == Some(reference)
            }
            _ => false,
        };
        covers.then_some(*id)
    })
}
fn cell_action(view: &RunView, live: &Live, fenced: bool) -> Option<Action> {
    for cell in view.cells.values() {
        let running = matches!(cell.status, CellStatus::Running);
        let reason = BlockerKind::CodeCellRecoveryUnavailable {
            cell: cell.id.as_uuid().to_string(),
        };
        let acknowledged = view.cancelled_by_risk
            || view.blockers.values().any(|b| {
                b.decision
                    .as_ref()
                    .is_some_and(|d| matches!(d.scope, RiskActionScope::RunCancellation))
                    || (b.reason == reason && b.decision.is_some())
            });
        if running
            && !(fenced && acknowledged)
            && !live.cells_observed.contains(&cell.id)
            && !live.work.contains(&WorkKey::Cell(cell.id))
        {
            return Some(Action::ObserveCell(cell.id));
        }
        if running && live.work.contains(&WorkKey::Cell(cell.id)) {
            return Some(Action::Idle);
        }
        if fenced && running && !acknowledged && cell.vm_uncertainty.is_none() {
            return Some(Action::Idle);
        }
        let interrupted = matches!(cell.status, CellStatus::Interrupted { .. });
        let unknown = cell.vm_uncertainty.is_some()
            || cell.children.values().any(|child| {
                child.local_result.as_ref().is_some_and(|r| {
                    r.settlement == maka_agent_facts::tool_call::ToolSettlement::Unknown
                }) || matches!(
                    child.reply.as_ref().map(|r| &r.receipt),
                    Some(
                        Receipt::NotRecorded
                            | Receipt::Unavailable { .. }
                            | Receipt::Recorded {
                                outcome: OperationOutcome::Unknown { .. },
                                ..
                            }
                    )
                )
            })
            || (interrupted && cell.children.values().any(|child| !child.known()));
        let blocked = if fenced {
            unknown || cell.children.values().any(|child| !child.known())
        } else {
            cell.blocks_effect_admission() || unknown
        };
        if blocked && !acknowledged {
            return Some(
                if view
                    .blockers
                    .values()
                    .any(|b| b.reason == reason && active(b))
                {
                    Action::Idle
                } else {
                    Action::Block(reason)
                },
            );
        }
        let synchronous_pending = match &cell.owner {
            CellOwner::Agent { link, .. } => view.tools.values().any(|tool| {
                tool.key.attempt == link.attempt
                    && (live.work.contains(&WorkKey::Tool(tool.key.clone()))
                        || (tool.accepted.is_none() && tool.local_returned.is_some()))
            }),
            CellOwner::Standalone { .. } => false,
        };
        if !fenced && !synchronous_pending {
            if matches!(
                cell.status,
                CellStatus::Completed {
                    accepted: false,
                    ..
                }
            ) {
                return Some(Action::AcceptCellFinal(cell.id));
            }
            if interrupted
                && cell.children.values().all(|child| child.known())
                && cell.final_notification.is_none()
            {
                return Some(Action::ReportCellInterruption(cell.id));
            }
        }
    }
    None
}
fn publication_action(view: &RunView, live: &Live, stopped: bool) -> Option<Action> {
    let publication = view.external.as_ref()?.publication.as_ref()?;
    if view.cancelled_by_risk || publication.applied() {
        return None;
    }
    let blocked = |reason: BlockerKind| {
        if view
            .blockers
            .values()
            .any(|b| b.reason == reason && active(b))
        {
            Action::Idle
        } else {
            Action::Block(reason)
        }
    };
    let busy = live.work.contains(&WorkKey::Publication(publication.id));
    for item in publication.items.values() {
        if item.known() {
            continue;
        }
        if busy {
            return Some(Action::Idle);
        }
        if let Some(reference) = &item.original {
            if !live.publication_observed.contains(&item.key) {
                return Some(Action::ObservePublication(item.key, reference.clone()));
            }
        } else if !live.publication_looked_up.contains(&item.key) {
            return Some(Action::LookupPublication(item.key));
        }
        return Some(blocked(BlockerKind::ExternalPublicationItem {
            key: item.key,
            reason: ExternalPublicationBlocker::Unknown,
        }));
    }
    if stopped {
        return (!publication.abandoned).then_some(Action::AbandonPublication(publication.id));
    }
    if publication.abandoned {
        return None;
    }
    for item in publication.items.values() {
        let reason = match item.outcome {
            Some(ExternalPublicationOutcome::Conflict) => {
                Some(ExternalPublicationBlocker::Conflict)
            }
            Some(ExternalPublicationOutcome::Unsupported) => {
                Some(ExternalPublicationBlocker::Unsupported)
            }
            Some(
                ExternalPublicationOutcome::Failed
                | ExternalPublicationOutcome::NotExecuted
                | ExternalPublicationOutcome::Prevented,
            ) => Some(ExternalPublicationBlocker::Failed),
            Some(ExternalPublicationOutcome::NotAttempted) => {
                Some(ExternalPublicationBlocker::NotAttempted)
            }
            _ => None,
        };
        if let Some(reason) = reason {
            return Some(blocked(BlockerKind::ExternalPublicationItem {
                key: item.key,
                reason,
            }));
        }
        if item.known() && item.cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed
        {
            if busy {
                return Some(Action::Idle);
            }
            if let Some(reference) = &item.original
                && !live.publication_observed.contains(&item.key)
            {
                return Some(Action::ObservePublication(item.key, reference.clone()));
            }
            return Some(blocked(BlockerKind::ExternalPublicationItem {
                key: item.key,
                reason: ExternalPublicationBlocker::CleanupUnconfirmed,
            }));
        }
    }
    if busy {
        return Some(Action::Idle);
    }
    if publication.manifest.is_none() {
        if !live.publication_prepared.contains(&publication.id) {
            return Some(Action::PreparePublication(publication.id));
        }
        return Some(Action::Idle);
    }
    if unresolved(view) {
        return None;
    }
    if publication
        .item_count
        .is_some_and(|count| publication.settled < count)
    {
        return Some(Action::ValidatePublication(ExternalPublicationKey {
            publication: publication.id,
            index: publication.settled,
        }));
    }
    None
}
pub(crate) fn budget_exhausted(view: &RunView) -> bool {
    view.spec
        .budget
        .tokens
        .is_some_and(|limit| view.tokens >= limit)
}

// Only the canonical final reply may settle at the limit; next() still requires cleanup ACKs.
pub(crate) fn complete_at_budget(view: &RunView, request: &RequestSpec, now: UnixMillis) -> bool {
    budget_exhausted(view) && final_model_response(view, request, now)
}

pub(crate) fn final_model_response(view: &RunView, request: &RequestSpec, now: UnixMillis) -> bool {
    final_reply(view, request, now)
        && !view.waits.values().any(|wait| {
            wait.satisfied.is_none()
                && wait.cancelled.is_none()
                && matches!(wait.reason, WaitReason::Child { .. })
        })
}

pub(crate) fn model_settlement_action(
    view: &RunView,
    request: &RequestSpec,
    now: UnixMillis,
) -> Option<Action> {
    let final_response = final_model_response(view, request, now);
    if final_response || (budget_exhausted(view) && final_reply(view, request, now)) {
        Some(next(view, &Live::default(), now, None, final_response))
    } else {
        None
    }
}

fn final_reply(view: &RunView, request: &RequestSpec, now: UnixMillis) -> bool {
    if view.stopped
        || view.cancelled_by_risk
        || view.spec.budget.deadline.is_some_and(|at| now >= at)
        || !matches!(view.spec.backend, BackendSpec::Model { .. })
        || matches!(view.spec.trigger, Trigger::ContextCompact)
        || !view.replans.is_empty()
        || view.blockers.values().any(|blocker| {
            active(blocker)
                && !matches!(
                    &blocker.reason,
                    BlockerKind::CurrentAuthorityUnavailable { .. }
                )
        })
        || view.current_step != Some(request.step)
        || request.accounting.purpose != maka_agent_facts::context::ModelPurpose::Main
        || view.tools.values().any(|tool| tool.accepted.is_none())
        || view
            .cells
            .values()
            .any(|cell| cell.pending() || !cell.notifications.is_empty())
    {
        return false;
    }
    let Some(attempt) = view.current_attempt.and_then(|id| view.attempts.get(&id)) else {
        return false;
    };
    attempt.step == request.step
        && attempt.admission.is_some()
        && !attempt.has_tools
        && attempt.closed.as_ref().is_some_and(|closed| {
            closed.outcome == maka_agent_facts::accounting::Outcome::Success
                && closed.diagnostic.is_none()
                && matches!(closure_protocol(closed), Ok(protocol)
                    if protocol.finish_reason == maka_agent_facts::model::ModelFinishReason::Stop)
        })
}

pub(crate) fn next(
    view: &RunView,
    live: &Live,
    now: UnixMillis,
    model: Option<&ModelLevel>,
    complete_at_budget: bool,
) -> Action {
    let action = next_action(view, live, now, model, complete_at_budget);
    if !matches!(action, Action::Terminate(Terminal::Completed)) {
        return action;
    }
    if live
        .work
        .iter()
        .any(|work| matches!(work, WorkKey::CancelModel(_)))
    {
        return Action::Idle;
    }
    if let Some((attempt, original)) = view.attempts.iter().find(|(_, attempt)| {
        attempt.admission.is_some()
            && attempt.cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed
    }) {
        if original.closed.is_none() && original.interrupted.is_none() {
            return Action::Idle;
        }
        return wait(view, WaitReason::Model { attempt: *attempt }, None, now);
    }
    if let Some(cell) = view
        .cells
        .values()
        .find(|cell| !cell.physical_cleanup_confirmed())
    {
        return wait(view, WaitReason::Cell { cell: cell.id }, None, now);
    }
    if let Some(tool) = view.tools.values().find(|tool| {
        tool.original.is_some()
            && !matches!(
                &tool.receipt,
                Some(Receipt::Recorded {
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
                    ..
                })
            )
    }) {
        if !live.observed.contains(&tool.key)
            && !live.work.contains(&WorkKey::Tool(tool.key.clone()))
        {
            return Action::Observe(tool.key.clone());
        }
        return wait(
            view,
            WaitReason::Operation {
                tool: tool.key.clone(),
            },
            None,
            now,
        );
    }
    action
}

fn next_action(
    view: &RunView,
    live: &Live,
    now: UnixMillis,
    model: Option<&ModelLevel>,
    complete_at_budget: bool,
) -> Action {
    if view.terminal.is_some() || matches!(view.spec.backend, BackendSpec::Historical {}) {
        return Action::Idle;
    }
    let deadline = view.spec.budget.deadline.is_some_and(|at| now >= at);
    let exhausted = budget_exhausted(view);
    let finish = view.finish_requested() || complete_at_budget;
    let interrupted_fence =
        view.stopped || view.cancelled_by_risk || deadline || (exhausted && !complete_at_budget);
    let fenced = interrupted_fence || finish;
    for (id, pending) in &view.waits {
        if pending.satisfied.is_some() || pending.cancelled.is_some() {
            continue;
        }
        if interrupted_fence
            || (finish
                && !matches!(
                    pending.reason,
                    WaitReason::Model { .. }
                        | WaitReason::Cell { .. }
                        | WaitReason::Operation { .. }
                ))
        {
            if exhausted
                && !view.stopped
                && !view.cancelled_by_risk
                && !deadline
                && matches!(pending.reason, WaitReason::Child { .. })
            {
                continue;
            }
            return Action::CancelWait(*id);
        }
        let ready = pending.due_at.is_some_and(|due| now >= due) || match &pending.reason {
            WaitReason::Approval { approval } => {
                view.approvals.contains_key(approval)
                    || view.tools.values().any(|tool| {
                        tool.approval_refusal.as_ref().is_some_and(|refusal| refusal.approval == *approval)
                    })
                    || !view.tools.values().any(|tool| tool.accepted.is_none() && matches!(&tool.decision,Some(ToolDecision::Approved { approval:Some(id),.. }) if id == approval))
            },
            WaitReason::Operation { tool } => view.tools.get(&maka_agent_state::fold::tool_key(tool)).is_none_or(|tool| {
                let confirmed = matches!(&tool.receipt, Some(Receipt::Recorded {
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed, ..
                }));
                if pending.due_at.is_some() {
                    return known(&tool.receipt) && (!finish || confirmed);
                }
                let accepted_risk = matches!(&tool.receipt, Some(Receipt::Recorded {
                    outcome: OperationOutcome::Unknown { .. }, ..
                })) && tool.accepted.as_ref().is_some_and(|accepted| {
                    let AcceptedResult::RiskAdjudicated { blocker } = &accepted.outcome else { return false; };
                    view.blockers.get(blocker).and_then(|blocker| blocker.decision.as_ref())
                        .is_some_and(|decision| !matches!(&decision.scope, RiskActionScope::RunCancellation))
                });
                confirmed && (known(&tool.receipt) || accepted_risk)
            }),
            WaitReason::Blocker { blocker } => view.blockers.get(blocker).is_none_or(|blocker| !active(blocker)),
            WaitReason::Model { attempt } => view.attempts.get(attempt).is_some_and(|attempt| {
                if pending.due_at.is_none() {
                    attempt.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed
                } else {
                    attempt.closed.is_some() || attempt.interrupted.is_some()
                }
            }),
            WaitReason::Cell { cell } => view.cells.get(cell).is_none_or(|cell| {
                if pending.due_at.is_some() && !finish { !matches!(cell.status, CellStatus::Running) }
                else { cell.physical_cleanup_confirmed() }
            }),
            WaitReason::External { task } => view.external.as_ref().is_some_and(|external| external.task == *task && external.closed.is_some()),
            WaitReason::Retry { .. } | WaitReason::ProviderBackoff { .. } | WaitReason::Child { .. } => false,
        };
        if ready {
            return Action::Satisfy(*id);
        }
    }
    for tool in view.tools.values() {
        if tool.accepted.is_some() {
            continue;
        }
        if tool.admitted && tool.original.is_none() && !tool.call.provider_executed
            && let Some(cell)=view.cells.values().find(|cell|matches!(&cell.owner,CellOwner::Agent{link,call}if link.run==view.run&&link.attempt==tool.key.attempt&&call==&tool.key.call)&&!matches!(cell.status,CellStatus::Running)&&cell.children.values().all(|child|child.known())&&!cell.blocks_effect_admission())
                && tool.local_returned.as_ref().is_none_or(|r|r.settlement==maka_agent_facts::tool_call::ToolSettlement::Unknown){return Action::Accept(tool.key.clone(),AcceptedResult::CellRecovered{cell:cell.id});}
        if let Some(result) = outcome(tool) {
            return Action::Accept(tool.key.clone(), result);
        }
        if let Some(blocker) = adjudicated_tool(view, tool) {
            return Action::Accept(
                tool.key.clone(),
                AcceptedResult::RiskAdjudicated { blocker },
            );
        }
    }
    if fenced {
        if finish
            && !interrupted_fence
            && !complete_at_budget
            && let Some((attempt, _)) = view.attempts.iter().find(|(id, attempt)| {
                attempt.admission.is_some()
                    && live.work.contains(&WorkKey::Model(**id))
                    && !live.models_cancelled.contains(*id)
            })
        {
            return Action::CancelModel(*attempt);
        }
        for tool in view.tools.values() {
            if tool.accepted.is_none()
                && !tool.admitted
                && tool.original.is_none()
                && !tool.call.provider_executed
            {
                return Action::Reject(tool.key.clone(), ToolRejection::Cancelled);
            }
        }
        for (id, attempt) in view
            .attempts
            .iter()
            .filter(|(id, a)| a.closed.is_none() && !live.work.contains(&WorkKey::Model(**id)))
        {
            if !view.cancelled_by_risk
                && let Some(AttemptRecovery::ObserveOriginal { descriptor }) = &attempt.recovery
            {
                if !live.models_observed.contains(id) {
                    return Action::ObserveModel(*id, descriptor.clone());
                }
                return if unresolved(view) {
                    Action::Idle
                } else {
                    Action::Block(BlockerKind::UnsupportedProtocol {
                        protocol:
                            "original model observation ended without a terminal upstream receipt"
                                .into(),
                        version: 1,
                    })
                };
            }
            if attempt.interrupted.is_none() {
                return Action::Interrupt(
                    *id,
                    "Run stopped before original upstream completion".into(),
                );
            }
        }
        for tool in view.tools.values() {
            if live.work.contains(&WorkKey::Tool(tool.key.clone())) {
                continue;
            }
            if tool.original.is_some()
                && !known(&tool.receipt)
                && !live.observed.contains(&tool.key)
            {
                return Action::Observe(tool.key.clone());
            }
            if tool.admitted
                && !cell_context_recovered(tool)
                && !live.looked_up.contains(&tool.key)
                && tool.original.is_none()
                && tool.local_returned.as_ref().is_none_or(|r| {
                    r.settlement == maka_agent_facts::tool_call::ToolSettlement::Unknown
                })
            {
                return Action::Lookup(tool.key.clone());
            }
        }
        if let Some(action) = publication_action(view, live, true) {
            return action;
        }
        if finish
            && !interrupted_fence
            && let Some(action) = cell_action(view, live, false)
        {
            return action;
        }
        let only_cleanup = live.only_cleanup(view);
        if !live.work.is_empty() && (!only_cleanup || (finish && !complete_at_budget)) {
            return Action::Idle;
        }
        if let Some(action) = cell_action(view, live, interrupted_fence) {
            return action;
        }
        for tool in view.tools.values() {
            if (view.cancelled_by_risk && tool.accepted.is_some())
                || adjudicated_tool(view, tool).is_some()
            {
                continue;
            }
            let reason = if tool.call.provider_executed && tool.provider_result.is_none() {
                Some(BlockerKind::ProviderEffectUnknown {
                    attempt: tool.key.attempt,
                    call: tool.key.call.clone(),
                })
            } else if let Some(reference) = &tool.original {
                if !known(&tool.receipt) {
                    Some(BlockerKind::OperationUnknown {
                        tool: tool.key.clone(),
                        reference: reference.clone(),
                    })
                } else {
                    None
                }
            } else if tool.admitted
                && !cell_context_recovered(tool)
                && tool.prohibited_before_host.is_none()
                && tool.local_returned.as_ref().is_none_or(|r| {
                    r.settlement == maka_agent_facts::tool_call::ToolSettlement::Unknown
                })
            {
                Some(BlockerKind::OriginalAdmissionUnknown {
                    tool: tool.key.clone(),
                })
            } else {
                None
            };
            if let Some(reason) = reason {
                return if view
                    .blockers
                    .values()
                    .any(|b| b.reason == reason && active(b))
                {
                    Action::Idle
                } else {
                    Action::Block(reason)
                };
            }
        }
        if let Some(action) = summary_effects(view) {
            return action;
        }
        if let Some(task) = &view.external
            && task.admitted
            && task.closed.is_none()
            && !view.cancelled_by_risk
        {
            if view.stopped
                && task.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed
            {
                if unresolved(view) {
                    return Action::Idle;
                }
                if let Some((&operation, _)) =
                    task.effects.iter().find(|(_, effect)| effect.pending())
                {
                    return Action::Block(BlockerKind::ExternalEffectUnknown {
                        task: task.task,
                        operation,
                    });
                }
                return Action::Terminate(Terminal::Cancelled);
            }
            let descriptor = task
                .binding
                .clone()
                .unwrap_or_else(|| task.descriptor.clone());
            if !live.external_observed && !(view.stopped && task.binding.is_none()) {
                return Action::ObserveExternal(task.task, descriptor);
            }
            if unresolved(view)
                || (view.stopped
                    && task.cleanup == maka_plugin_core::operation::OperationCleanup::Unconfirmed)
            {
                return Action::Idle;
            }
            let reason = BlockerKind::ExternalTaskUnobservable { descriptor };
            return if view
                .blockers
                .values()
                .any(|b| b.reason == reason && active(b))
            {
                Action::Idle
            } else {
                Action::Block(reason)
            };
        }
        return Action::Terminate(if view.stopped || view.cancelled_by_risk {
            Terminal::Cancelled
        } else if finish && !deadline && (!exhausted || complete_at_budget) {
            Terminal::Completed
        } else {
            Terminal::Failed
        });
    }
    if let Some(action) = publication_action(view, live, false) {
        return action;
    }
    for tool in view.tools.values() {
        let Some(reference) = &tool.original else {
            continue;
        };
        if known(&tool.receipt)
            && matches!(&tool.receipt,Some(Receipt::Recorded{cleanup,..}) if *cleanup!=maka_plugin_core::operation::OperationCleanup::Confirmed)
        {
            let covered = view.blockers.values().any(|b| {
                b.decision
                    .as_ref()
                    .is_some_and(|d| !matches!(d.decision, RiskDecision::CancelBlockedRun { .. }))
                    && match &b.reason {
                        BlockerKind::OperationUnknown {
                            tool: key,
                            reference: old,
                        } => key == &tool.key && old == reference,
                        BlockerKind::CleanupUnconfirmed { reference: old } => old == reference,
                        _ => false,
                    }
            });
            if !covered {
                let reason = BlockerKind::CleanupUnconfirmed {
                    reference: reference.clone(),
                };
                if !view
                    .blockers
                    .values()
                    .any(|b| b.reason == reason && active(b))
                {
                    return Action::Block(reason);
                }
            }
        }
    }
    if let Some(action) = cell_action(view, live, false) {
        return action;
    }
    let mut pending_effect = false;
    for tool in view.tools.values() {
        if live.work.contains(&WorkKey::Tool(tool.key.clone())) {
            continue;
        }
        if tool.accepted.is_none()
            && let Some(result) = outcome(tool)
        {
            return Action::Accept(tool.key.clone(), result);
        }
        if let Some(reference) = &tool.original {
            let adjudicated = view.blockers.values().any(|blocker| blocker.decision.is_some() && matches!(&blocker.reason, BlockerKind::OperationUnknown { tool:key,reference:original } if key == &tool.key && original == reference));
            if !known(&tool.receipt) && !adjudicated {
                pending_effect = true;
                let reason = BlockerKind::OperationUnknown {
                    tool: tool.key.clone(),
                    reference: reference.clone(),
                };
                if view
                    .blockers
                    .values()
                    .any(|blocker| blocker.reason == reason && active(blocker))
                {
                    continue;
                }
                if !live.observed.contains(&tool.key)
                    && !matches!(
                        tool.receipt,
                        Some(Receipt::Recorded {
                            outcome: OperationOutcome::Unknown { .. },
                            ..
                        })
                    )
                {
                    return Action::Observe(tool.key.clone());
                }
                return Action::Block(reason);
            }
        }
        if tool.accepted.is_some() {
            continue;
        }
        if let Some(blocker) = adjudicated_tool(view, tool) {
            return Action::Accept(
                tool.key.clone(),
                AcceptedResult::RiskAdjudicated { blocker },
            );
        }
        if tool.call.provider_executed {
            if view
                .attempts
                .get(&tool.key.attempt)
                .is_some_and(|attempt| attempt.closed.is_some() || attempt.interrupted.is_some())
            {
                let reason = BlockerKind::ProviderEffectUnknown {
                    attempt: tool.key.attempt,
                    call: tool.key.call.clone(),
                };
                if !view
                    .blockers
                    .values()
                    .any(|blocker| blocker.reason == reason && active(blocker))
                {
                    return Action::Block(reason);
                }
            }
            continue;
        }
        if tool.admitted {
            if !live.looked_up.contains(&tool.key) {
                return Action::Lookup(tool.key.clone());
            }
            if tool.local_returned.as_ref().is_some_and(|r| {
                r.settlement == maka_agent_facts::tool_call::ToolSettlement::Unknown
            }) {
                let reason = BlockerKind::OriginalAdmissionUnknown {
                    tool: tool.key.clone(),
                };
                if !view
                    .blockers
                    .values()
                    .any(|b| b.reason == reason && active(b))
                {
                    return Action::Block(reason);
                }
            }
            continue;
        }
        if model.is_some_and(|model| {
            model.request.as_ref().is_some_and(|request| {
                request.accounting.purpose == maka_agent_facts::context::ModelPurpose::Summary
                    && view
                        .attempts
                        .get(&tool.key.attempt)
                        .is_some_and(|attempt| attempt.step == request.step)
            })
        }) {
            return Action::Reject(
                tool.key.clone(),
                ToolRejection::PolicyDenied {
                    message: "Summary model requests cannot execute tools".into(),
                },
            );
        }
        if let Some(refusal) = &tool.approval_refusal {
            let rejection = match &refusal.outcome {
                maka_agent_facts::interaction::InteractionOutcome::Closure {
                    reason: maka_agent_facts::interaction::ClosureReason::Steered,
                    ..
                } => ToolRejection::Superseded,
                maka_agent_facts::interaction::InteractionOutcome::Closure { .. } => {
                    ToolRejection::Cancelled
                }
                _ => ToolRejection::PolicyDenied {
                    message: "The original tool approval was refused".into(),
                },
            };
            return Action::Reject(tool.key.clone(), rejection);
        }
        if view.current_attempt != Some(tool.key.attempt)
            && view
                .attempts
                .get(&tool.key.attempt)
                .is_some_and(|attempt| attempt.interrupted.is_some())
        {
            return Action::Reject(tool.key.clone(), ToolRejection::Superseded);
        }
        if unresolved(view) {
            continue;
        }
        if model.is_some_and(|model| {
            model.request.as_ref().is_some_and(|request| {
                request.accounting.purpose == maka_agent_facts::context::ModelPurpose::Main
                    && view
                        .attempts
                        .get(&tool.key.attempt)
                        .is_some_and(|attempt| attempt.step == request.step)
            })
        }) {
            match tool_incomplete(view, &tool.key) {
                Ok(true) => {
                    return Action::Reject(
                        tool.key.clone(),
                        ToolRejection::PreparationFailed {
                            message: "model output was incomplete".into(),
                        },
                    );
                }
                Ok(false) => {}
                Err(reason) => return Action::Block(*reason),
            }
        }
        match &tool.decision {
            None => return Action::Decide(tool.key.clone()),
            Some(ToolDecision::Approved {
                resources,
                approval,
                ..
            }) => {
                if resources
                    .iter()
                    .any(|resource| matches!(resource, ResourceRecovery::Unavailable { .. }))
                {
                    return Action::Block(BlockerKind::ResourcesUnavailable {
                        tool: tool.key.clone(),
                    });
                }
                if let Some(id) = approval {
                    match view.approvals.get(id) {
                        None => {
                            let action =
                                wait(view, WaitReason::Approval { approval: *id }, None, now);
                            if !matches!(action, Action::Idle) {
                                return action;
                            }
                            continue;
                        }
                        Some(grant) if grant.expires_at.is_some_and(|expiry| now >= expiry) => {
                            return Action::Reject(
                                tool.key.clone(),
                                ToolRejection::PolicyDenied {
                                    message: "Approval expired before admission".into(),
                                },
                            );
                        }
                        _ => {}
                    }
                }
                return Action::Lookup(tool.key.clone());
            }
            Some(ToolDecision::Rejected { .. }) => unreachable!(),
        }
    }
    if pending_effect {
        return Action::Idle;
    }
    if let Some(action) = summary_effects(view) {
        return action;
    }
    if !view.replans.is_empty()
        && view.tools.values().all(|tool| tool.accepted.is_some())
        && live.only_cleanup(view)
    {
        if let Some((id, _)) = view
            .current_attempt
            .and_then(|id| view.attempts.get(&id).map(|a| (id, a)))
            .filter(|(_, a)| a.closed.is_none() && a.interrupted.is_none())
        {
            return Action::Interrupt(
                id,
                "Explicit human replan replaced the interrupted logical attempt".into(),
            );
        }
        if let Some((_, first)) = view.replans.iter().next() {
            let RiskActionScope::ModelReplan { attempt, base_step } = &first.scope else {
                unreachable!("only frozen ModelReplan scopes enter model replan frontier")
            };
            let adjudications = view
                .replans
                .iter()
                .filter(|(_, entry)| match &entry.scope {
                    RiskActionScope::ModelReplan {
                        base_step: base, ..
                    } => base == base_step,
                    _ => false,
                })
                .map(|(blocker, entry)| {
                    let evidence = match &entry.decision {
                        RiskDecision::RecordExternalObservation { evidence }
                        | RiskDecision::AuthorizeReplan { evidence } => evidence.clone(),
                        RiskDecision::CancelBlockedRun { .. } => {
                            unreachable!("cancellation never selects a model replan")
                        }
                    };
                    ReplanInput {
                        basis: AdjudicationBasis {
                            blocker: *blocker,
                            evidence,
                        },
                        decision: entry.decision.clone(),
                    }
                })
                .collect();
            return Action::Prepare(Preparation::Replan {
                attempt: Some(*attempt),
                adjudications,
            });
        }
    }
    if unresolved(view) {
        return Action::Idle;
    }
    if view.waits.values().any(|pending| {
        pending.satisfied.is_none()
            && pending.cancelled.is_none()
            && matches!(pending.reason, WaitReason::Child { .. })
    }) {
        return Action::Idle;
    }
    if matches!(view.spec.backend, BackendSpec::Executor { .. }) {
        return external(view, live, now, false);
    }
    if live.work.contains(&WorkKey::Prepare) {
        return Action::Idle;
    }
    if let Some(CompactionLevel::Adopted { summary }) = model.map(|model| model.compaction) {
        return Action::Prepare(Preparation::AfterCompaction { attempt: summary });
    }
    let current = view
        .current_attempt
        .and_then(|id| view.attempts.get(&id).map(|a| (id, a)));
    let Some(step) = view.current_step else {
        return Action::Prepare(
            if model.is_some_and(|m| {
                matches!(
                    m.input,
                    maka_agent_facts::input::RunInput::ContextCompact { .. }
                )
            }) {
                Preparation::Summary
            } else {
                Preparation::Initial
            },
        );
    };
    if current.is_none_or(|(_, a)| a.step != step) {
        if let Some((attempt, original)) = current
            && original.admission.is_some()
            && original.cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed
        {
            return wait(view, WaitReason::Model { attempt }, None, now);
        }
        match model.map(|model| model.compaction) {
            Some(CompactionLevel::Fresh { prepare: true }) => {
                return Action::Prepare(Preparation::Summary);
            }
            Some(CompactionLevel::Candidate {
                summary,
                adopt: true,
            }) => return Action::Compact(summary),
            _ => {}
        }
        return Action::Attempt(step);
    }
    let Some((id, attempt)) = current else {
        return Action::Idle;
    };
    if live.work.contains(&WorkKey::Model(id)) && attempt.closed.is_none() {
        return Action::Idle;
    }
    if attempt.admission.is_none() && attempt.closed.is_none() && attempt.interrupted.is_none() {
        return Action::Start(id);
    }
    if attempt.recovery.is_none()
        && attempt.closed.as_ref().is_none_or(|closed| {
            closed.diagnostic.is_some()
                || closed.outcome != maka_agent_facts::accounting::Outcome::Success
        })
    {
        return Action::Assess(id);
    }
    if attempt.closed.is_none() && attempt.interrupted.is_none() {
        if let Some(AttemptRecovery::ObserveOriginal { descriptor }) = &attempt.recovery {
            if !live.models_observed.contains(&id) {
                return Action::ObserveModel(id, descriptor.clone());
            }
            return Action::Block(BlockerKind::UnsupportedProtocol {
                protocol: "original model observation ended without a terminal upstream receipt"
                    .into(),
                version: 1,
            });
        }
        return Action::Interrupt(
            id,
            "Original transport ended; upstream completion is not known".into(),
        );
    }
    if view.tools.values().any(|tool| tool.accepted.is_none()) {
        return Action::Idle;
    }
    if attempt.closed.as_ref().is_some_and(|closed| {
        closed.diagnostic.is_none()
            && closed.outcome == maka_agent_facts::accounting::Outcome::Success
    }) {
        if let Some(model) = model.filter(|m| {
            m.request.as_ref().is_some_and(|r| {
                r.accounting.purpose == maka_agent_facts::context::ModelPurpose::Summary
            })
        }) {
            let protocol =
                match closure_protocol(attempt.closed.as_ref().expect("known source closure")) {
                    Ok(protocol) => protocol,
                    Err(reason) => return Action::Block(*reason),
                };
            if matches!(&protocol.summary, Some(SummaryResult::RejectedToolContent))
                && model
                    .request
                    .as_ref()
                    .is_some_and(|request| request.summary_repair_of.is_none())
            {
                return Action::Prepare(Preparation::SummaryRepair { attempt: id });
            }
            let rejected = protocol.finish_reason
                != maka_agent_facts::model::ModelFinishReason::Stop
                || (matches!(
                    model.compaction,
                    CompactionLevel::Summary { native: true, .. }
                ) && protocol.compaction.is_none())
                || match protocol.summary.as_ref() {
                    Some(SummaryResult::RejectedToolContent | SummaryResult::Incomplete) => true,
                    Some(SummaryResult::Text { summary }) => summary.text.trim().is_empty(),
                    _ => false,
                };
            if rejected
                && let CompactionLevel::Summary {
                    main: Some(main), ..
                } = model.compaction
            {
                return Action::Prepare(Preparation::CompactionFallback { main, summary: id });
            }
            if model
                .baseline
                .as_ref()
                .is_none_or(|b| b.checkpoint.summary_step_id != attempt.step)
            {
                if !rejected
                    && let CompactionLevel::Summary {
                        main: Some(main),
                        adopt: false,
                        ..
                    } = model.compaction
                {
                    return Action::Prepare(Preparation::CompactionDeferred { main, summary: id });
                }
                return Action::Compact(id);
            }
            return if matches!(
                model.input,
                maka_agent_facts::input::RunInput::ContextCompact { .. }
            ) {
                Action::Terminate(Terminal::Completed)
            } else {
                Action::Prepare(Preparation::AfterCompaction { attempt: id })
            };
        }
        let protocol =
            match closure_protocol(attempt.closed.as_ref().expect("known source closure")) {
                Ok(protocol) => protocol,
                Err(reason) => return Action::Block(*reason),
            };
        if protocol.finish_reason == maka_agent_facts::model::ModelFinishReason::Length {
            return Action::Terminate(Terminal::Failed);
        }
        if view
            .cells
            .values()
            .any(|cell| !cell.notifications.is_empty())
        {
            return Action::Prepare(Preparation::Notifications { attempt: id });
        }
        if let Some(cell) = view
            .cells
            .values()
            .find(|cell| matches!(cell.status, CellStatus::Running))
            && !attempt.has_tools
        {
            return wait(view, WaitReason::Cell { cell: cell.id }, None, now);
        }
        return if attempt.has_tools {
            Action::Prepare(Preparation::ToolContinuation { attempt: id })
        } else {
            Action::Terminate(Terminal::Completed)
        };
    }
    if let Some(CompactionLevel::Summary {
        main: Some(main), ..
    }) = model.map(|model| model.compaction)
        && !attempt.semantic
        && !attempt.has_tools
        && let Some(closed) = attempt
            .closed
            .as_ref()
            .filter(|closed| closed.outcome == maka_agent_facts::accounting::Outcome::Error)
    {
        let failure = match closed
            .protocol
            .get("failure")
            .filter(|value| !value.is_null())
        {
            Some(value) => match serde_json::from_value::<maka_model::ModelError>(value.clone()) {
                Ok(failure) => Some(failure),
                Err(error) => {
                    return Action::Block(BlockerKind::UnsupportedProtocol {
                        protocol: format!("model-failure: {error}"),
                        version: 1,
                    });
                }
            },
            None => None,
        };
        let known_safe_failure = match failure.as_ref() {
            Some(maka_model::ModelError::ContextOverflow {
                observed_output: false,
            }) => true,
            Some(maka_model::ModelError::Provider(failure)) => {
                !failure.retryable() && failure.replay_safe()
            }
            _ => false,
        };
        if known_safe_failure {
            return Action::Prepare(Preparation::CompactionFallback { main, summary: id });
        }
    }
    match &attempt.recovery {
        Some(AttemptRecovery::ContextOverflow { observed_output }) => {
            if !observed_output
                && let Some(CompactionLevel::Candidate { summary, .. }) =
                    model.map(|model| model.compaction)
            {
                return Action::Compact(summary);
            }
            if !observed_output
                && model.is_some_and(|model| {
                    model.request.as_ref().is_some_and(|request| {
                        request.accounting.purpose == maka_agent_facts::context::ModelPurpose::Main
                            && matches!(model.compaction, CompactionLevel::Fresh { .. })
                    })
                })
            {
                Action::Prepare(Preparation::ContextOverflow { attempt: id })
            } else {
                Action::Terminate(Terminal::Failed)
            }
        }
        Some(AttemptRecovery::ObserveOriginal { descriptor }) => {
            if !live.models_observed.contains(&id) {
                Action::ObserveModel(id, descriptor.clone())
            } else {
                Action::Block(BlockerKind::UnsupportedProtocol {
                    protocol: "original model observation unavailable".into(),
                    version: 1,
                })
            }
        }
        Some(AttemptRecovery::FrozenRetrySafe { .. }) if !attempt.semantic => {
            if attempt.retry.is_none() {
                let phase = if model.is_some_and(|model| {
                    model.request.as_ref().is_some_and(|request| {
                        request.accounting.purpose
                            == maka_agent_facts::context::ModelPurpose::Summary
                    })
                }) {
                    maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary
                } else {
                    view.retry_phase
                };
                let limit = u64::from(view.spec.budget.retries)
                    + u64::from(phase == maka_agent_facts::model::retry_transport::RetryTransportPhase::Fallback);
                return if u64::from(view.retries_for(phase)) < limit {
                    Action::ChargeRetry(id, phase)
                } else if phase == maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary
                    && model.is_some_and(|model| {
                        model.request.as_ref().is_some_and(|request| request.accounting.purpose == maka_agent_facts::context::ModelPurpose::Main)
                            && model.fallback_available
                            && matches!(model.failure.as_ref().map(|evidence| &evidence.failure),
                                Some(maka_model::ModelError::Provider(failure)) if failure.retryable() && failure.replay_safe())
                    })
                    && !attempt.has_tools
                {
                    if attempt.admission.is_none() || attempt.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed {
                        Action::SelectTransport(id, maka_agent_facts::model::retry_transport::RetryTransportPhase::Fallback)
                    } else {
                        wait(view, WaitReason::Model { attempt: id }, None, now)
                    }
                } else {
                    Action::Terminate(Terminal::Failed)
                };
            }
            let due = attempt.retry.as_ref().expect("charged retry").due_at;
            if now < due {
                wait(view, WaitReason::Retry { attempt: id }, Some(due), now)
            } else if attempt.admission.is_some()
                && attempt.cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed
            {
                wait(view, WaitReason::Model { attempt: id }, None, now)
            } else {
                Action::Attempt(attempt.step)
            }
        }
        Some(AttemptRecovery::ProjectPrefixSafe { prefix, not_before }) => {
            if let Some(due) = not_before.filter(|due| *due > now) {
                return wait(
                    view,
                    WaitReason::ProviderBackoff { attempt: id },
                    Some(due),
                    now,
                );
            }
            Action::Prepare(Preparation::Prefix {
                attempt: id,
                proof: prefix.clone(),
            })
        }
        _ if attempt.source_failure.is_some()
            || attempt.closed.as_ref().is_some_and(|closed| {
                closed.outcome == maka_agent_facts::accounting::Outcome::Error
            }) =>
        {
            Action::Terminate(Terminal::Failed)
        }
        _ => Action::Block(BlockerKind::UnsupportedProtocol {
            protocol: "adapter supplied no safe interrupted-attempt recovery evidence".into(),
            version: 1,
        }),
    }
}

fn external(view: &RunView, live: &Live, _now: UnixMillis, _fenced: bool) -> Action {
    if let Some(closed) = view.external.as_ref().and_then(|task| task.closed.as_ref()) {
        return Action::Terminate(closed.outcome.clone());
    }
    if live.work.contains(&WorkKey::External) {
        return Action::Idle;
    }
    let Some(task) = &view.external else {
        return Action::PrepareExternal(ExternalTaskId::new());
    };
    if !task.admitted {
        return Action::StartExternal(task.task);
    }
    let descriptor = task
        .binding
        .clone()
        .unwrap_or_else(|| task.descriptor.clone());
    if !live.external_observed {
        return Action::ObserveExternal(task.task, descriptor);
    }
    Action::Block(BlockerKind::ExternalTaskUnobservable { descriptor })
}
