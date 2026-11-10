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

use maka_agent_facts::durable::*;
use maka_agent_state::fold::RunView;

#[derive(Debug, thiserror::Error)]
pub enum RiskActionError {
    #[error("Run is not a locally executable nonterminal source")]
    NotExecutable,
    #[error("blocker is absent or already resolved")]
    NotActive,
    #[error("this backend cannot safely apply the requested risk action")]
    UnsupportedAction,
}
fn scope(
    view: &RunView,
    blocker: BlockerId,
    kind: &RiskActionKind,
) -> Result<RiskActionScope, RiskActionError> {
    if view.terminal.is_some() || !matches!(view.spec.origin, RunOrigin::Local) {
        return Err(RiskActionError::NotExecutable);
    }
    let original = view
        .blockers
        .get(&blocker)
        .filter(|b| b.decision.is_none() && b.resolved_by.is_none())
        .ok_or(RiskActionError::NotActive)?;
    if matches!(kind, RiskActionKind::CancelBlockedRun) {
        return Ok(RiskActionScope::RunCancellation);
    }
    if matches!(view.spec.backend, BackendSpec::Executor { .. }) {
        return Err(RiskActionError::UnsupportedAction);
    }
    let model_scope = || {
        if view.stopped || view.cancelled_by_risk {
            return Err(RiskActionError::UnsupportedAction);
        }
        let (id, attempt) = view
            .current_attempt
            .and_then(|id| view.attempts.get(&id).map(|a| (id, a)))
            .ok_or(RiskActionError::UnsupportedAction)?;
        Ok(RiskActionScope::ModelReplan {
            attempt: id,
            base_step: attempt.step,
        })
    };
    let tool_scope = |tool: ToolKey| {
        let needs_manual = view
            .current_attempt
            .and_then(|id| view.attempts.get(&id))
            .is_some_and(|a| {
                !a.closed
                    .as_ref()
                    .is_some_and(|closed| closed.diagnostic.is_none())
                    && !matches!(a.recovery, Some(AttemptRecovery::ProjectPrefixSafe { .. }))
            });
        if matches!(kind, RiskActionKind::AuthorizeReplan) && needs_manual {
            model_scope()
        } else {
            Ok(RiskActionScope::Tool { tool })
        }
    };
    match &original.reason {
        BlockerKind::OperationUnknown { tool, .. }
        | BlockerKind::OriginalAdmissionUnknown { tool }
        | BlockerKind::ResourcesUnavailable { tool } => tool_scope(tool.clone()),
        BlockerKind::ProviderEffectUnknown { attempt, call } => {
            let key = ToolKey {
                attempt: *attempt,
                call: call.clone(),
            };
            if !view
                .tools
                .contains_key(&maka_agent_state::fold::tool_key(&key))
            {
                return Err(RiskActionError::UnsupportedAction);
            }
            tool_scope(key)
        }
        BlockerKind::UnsupportedProtocol { .. } | BlockerKind::CleanupUnconfirmed { .. } => {
            model_scope()
        }
        BlockerKind::ExternalPublicationUnavailable { .. }
        | BlockerKind::ExternalPublicationItem { .. }
        | BlockerKind::CodeCellRecoveryUnavailable { .. }
        | BlockerKind::ExternalTaskUnobservable { .. }
        | BlockerKind::ExternalEffectUnknown { .. }
        | BlockerKind::ToolCleanupUnconfirmed { .. }
        | BlockerKind::ModelCleanupUnconfirmed { .. }
        | BlockerKind::CurrentAuthorityUnavailable { .. } => {
            Err(RiskActionError::UnsupportedAction)
        }
    }
}
pub fn risk_action_scope(
    view: &RunView,
    blocker: BlockerId,
    decision: &RiskDecision,
) -> Result<RiskActionScope, RiskActionError> {
    let kind = match decision {
        RiskDecision::RecordExternalObservation { .. } => RiskActionKind::RecordExternalObservation,
        RiskDecision::AuthorizeReplan { .. } => RiskActionKind::AuthorizeReplan,
        RiskDecision::CancelBlockedRun { .. } => RiskActionKind::CancelBlockedRun,
    };
    scope(view, blocker, &kind)
}

pub fn validate_risk_action(
    view: &RunView,
    blocker: BlockerId,
    decision: &RiskDecision,
) -> Result<(), RiskActionError> {
    risk_action_scope(view, blocker, decision).map(|_| ())
}
pub fn offered_risk_actions(view: &RunView, blocker: BlockerId) -> Vec<OfferedRiskAction> {
    [
        RiskActionKind::RecordExternalObservation,
        RiskActionKind::AuthorizeReplan,
        RiskActionKind::CancelBlockedRun,
    ]
    .into_iter()
    .filter_map(|kind| {
        scope(view, blocker, &kind)
            .ok()
            .map(|scope| OfferedRiskAction { kind, scope })
    })
    .collect()
}
