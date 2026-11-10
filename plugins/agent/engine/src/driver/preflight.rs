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

use super::{DriverExit, exit, termination_facts};
use crate::{
    Engine, RunError,
    reconcile::{self, Action, Live},
};
use maka_agent_facts::durable::*;
use maka_agent_state::{
    ContentBlob, DriverClaim,
    fold::{RunView, tool_key},
};
#[cfg(test)]
use maka_plugin_core::operation::{OperationCleanup, Receipt};

fn portless_reconciliation(view: &RunView, at: UnixMillis, complete_at_budget: bool) -> Action {
    let live = Live {
        observed: if complete_at_budget {
            Default::default()
        } else {
            view.tools.values().map(|tool| tool.key.clone()).collect()
        },
        looked_up: view.tools.values().map(|tool| tool.key.clone()).collect(),
        publication_prepared: view
            .external
            .as_ref()
            .and_then(|task| task.publication.as_ref())
            .map(|publication| std::iter::once(publication.id).collect())
            .unwrap_or_default(),
        publication_looked_up: view
            .external
            .as_ref()
            .and_then(|task| task.publication.as_ref())
            .map(|publication| publication.items.values().map(|item| item.key).collect())
            .unwrap_or_default(),
        publication_observed: view
            .external
            .as_ref()
            .and_then(|task| task.publication.as_ref())
            .map(|publication| publication.items.values().map(|item| item.key).collect())
            .unwrap_or_default(),
        ..Live::default()
    };
    reconcile::next(view, &live, at, None, complete_at_budget)
}

impl Engine {
    /// Record unavailable current authority without inventing a logical failure
    /// or a replacement capability from the persisted Run specification.
    pub async fn current_authority_unavailable(
        &self,
        claim: DriverClaim,
        stage: AuthorityStage,
        diagnostic: String,
        at: UnixMillis,
    ) -> Result<DriverExit, RunError> {
        loop {
            let view = self.store.frontier(claim.run()).await?;
            if view.terminal.is_some() {
                return Ok(exit(&view));
            }
            if self.recover_legacy_compaction(&claim, &view, at).await?
                || self.resolve_recovered_cells(&claim, &view, at).await?
            {
                continue;
            }
            let recovery = if view.cancelled_by_risk {
                None
            } else {
                reconcile::recovery_action(&view, &Live::default())
            };
            let probe_original = match recovery {
                Some(Action::Accept(key, outcome)) => {
                    let (facts, result) = self.tool_acceptance(&view, key, outcome).await?;
                    self.publish(Some(&claim), &view, facts, vec![result], at)
                        .await?;
                    continue;
                }
                action => action.is_some(),
            };
            if view.recovery_failure().is_some() && !view.cancelled_by_risk && !probe_original {
                self.publish(
                    Some(&claim),
                    &view,
                    termination_facts(&view, Terminal::Failed, None),
                    vec![],
                    at,
                )
                .await?;
                continue;
            }
            let mut source_blocker = None;
            if !probe_original
                && (view.stopped
                    || view.cancelled_by_risk
                    || view
                        .spec
                        .budget
                        .deadline
                        .is_some_and(|deadline| at >= deadline)
                    || view
                        .spec
                        .budget
                        .tokens
                        .is_some_and(|limit| view.tokens >= limit))
            {
                // Without ports, only canonical evidence can be drained. A Cell
                // needing physical observation remains explicitly unavailable.
                let complete_at_budget = self.complete_at_budget(&view, at).await?;
                let action = portless_reconciliation(&view, at, complete_at_budget);
                let (facts, contents) = match action {
                    Action::AbandonPublication(id)=>(vec![Fact::ExternalPublication{event:maka_agent_facts::external_publication::ExternalPublicationEvent::Abandoned{id}}],vec![]),
                    Action::CancelWait(wait) => (
                        vec![Fact::WaitCancelled {
                            wait,
                            diagnostic: "Run admission fence closed".into(),
                        }],
                        vec![],
                    ),
                    Action::Satisfy(wait) => {
                        let evidence = ContentBlob::json(
                            &serde_json::json!({"run": view.run, "revision": view.revision, "at": at}),
                        )?;
                        (vec![Fact::WaitSatisfied {
                            wait,
                            evidence: evidence.reference().clone(),
                        }], vec![evidence])
                    }
                    Action::Reject(tool, rejection) => {
                        let display = view.tools[&tool_key(&tool)].decision.as_ref()
                            .map(|decision| decision.display().clone()).unwrap_or_default();
                        (vec![Fact::ToolDecided {
                            tool,
                            decision: ToolDecision::Rejected { rejection, display },
                        }], vec![])
                    },
                    Action::Accept(key, outcome) => {
                        let (facts, result) = self.tool_acceptance(&view, key, outcome).await?;
                        (facts, vec![result])
                    }
                    Action::Interrupt(attempt, diagnostic) => (
                        vec![Fact::ModelInterrupted {
                            attempt,
                            diagnostic,
                        }],
                        vec![],
                    ),
                    Action::Terminate(terminal) => (
                        termination_facts(&view, terminal, None),
                        vec![],
                    ),
                    Action::Block(reason) => {
                        source_blocker = Some(reason);
                        (vec![], vec![])
                    }
                    Action::ObserveCell(cell) => {
                        source_blocker = Some(BlockerKind::CodeCellRecoveryUnavailable {
                            cell: cell.to_string(),
                        });
                        (vec![], vec![])
                    }
                    _ => (vec![], vec![]),
                };
                if !facts.is_empty() {
                    self.publish(Some(&claim), &view, facts, contents, at)
                        .await?;
                    continue;
                }
            }

            let mut facts = Vec::new();
            if !view.blockers.values().any(|blocker| {
                blocker.decision.is_none()
                    && blocker.resolved_by.is_none()
                    && matches!(
                        &blocker.reason,
                        BlockerKind::CurrentAuthorityUnavailable { stage: existing, .. }
                            if existing == &stage
                    )
            }) {
                facts.push(Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason: BlockerKind::CurrentAuthorityUnavailable {
                        stage: stage.clone(),
                        diagnostic: diagnostic.clone(),
                    },
                });
            }
            if let Some(reason) = source_blocker
                && !view.blockers.values().any(|blocker| {
                    blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                        && blocker.reason == reason
                })
            {
                facts.push(Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason,
                });
            }
            if let Some(request) = view.stop_request
                && view.stop_assessed != Some(request)
            {
                facts.push(Fact::StopAssessed { request });
            }
            if facts.is_empty() {
                return Ok(exit(&view));
            }
            if self.publish(Some(&claim), &view, facts, vec![], at).await? {
                return Ok(exit(&self.store.frontier(claim.run()).await?));
            }
        }
    }

    /// Called by `drive` only after Native supplied the actual live DriverPorts.
    pub(super) async fn resolve_authority(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        at: UnixMillis,
    ) -> Result<bool, RunError> {
        let mut facts = Vec::new();
        let mut contents = Vec::new();
        for (id, blocker) in &view.blockers {
            if blocker.decision.is_some() || blocker.resolved_by.is_some() {
                continue;
            }
            if let BlockerKind::CurrentAuthorityUnavailable { stage, .. } = &blocker.reason {
                let evidence = ContentBlob::json(&serde_json::json!({
                    "kind": "live_native_driver_ports",
                    "stage": stage,
                }))?;
                facts.push(Fact::BlockerResolved {
                    blocker: *id,
                    evidence: evidence.reference().clone(),
                });
                contents.push(evidence);
            }
        }
        if facts.is_empty() {
            return Ok(false);
        }
        self.publish(Some(claim), view, facts, contents, at).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconcile::tests::{apply_policy_fact, budget_closure, model_closure, policy_view};
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    use maka_plugin_core::operation::{
        OperationOutcome, OperationReply, RecoveryContract, RecoveryProtocol, RecoveryRef,
    };

    #[test]
    fn portless_budget_completion_does_not_claim_to_have_observed_original_tool_cleanup() {
        let mut view = policy_view(Some(110));
        let source = view.spec.input.clone();
        let spec = ContentBlob::json(&view.spec).unwrap();
        apply_policy_fact(
            &mut view,
            Fact::RunAdmitted {
                spec: spec.reference().clone(),
            },
        );
        let (mut view, _, prior) = model_closure(
            view,
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Success,
            true,
        );
        let tool = ToolKey {
            attempt: prior,
            call: "continuation".into(),
        };
        apply_policy_fact(
            &mut view,
            Fact::ToolDecided {
                tool: tool.clone(),
                decision: ToolDecision::Approved {
                    input: source.clone(),
                    resources: Vec::new(),
                    approval: None,
                    display: Default::default(),
                    semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                },
            },
        );
        apply_policy_fact(&mut view, Fact::ToolAdmitted { tool: tool.clone() });
        let reference = RecoveryRef {
            source: maka_plugin_core::deployment::DeploymentRef {
                state_domain: "a".repeat(64),
                deployment: view.spec.owner.deployment,
                revision: 1,
            },
            namespace: view.spec.owner.namespace.clone(),
            export: "history".into(),
            method: "write".into(),
            operation: uuid::Uuid::new_v4(),
            fingerprint: format!("sha256-{}", source.digest.strip_prefix("sha256:").unwrap()),
            contract: RecoveryContract {
                name: "history".into(),
                version: 1,
                transport: maka_plugin_core::contract::Transport::Local,
                digest: format!("sha256-{}", source.digest.strip_prefix("sha256:").unwrap()),
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        apply_policy_fact(
            &mut view,
            Fact::ToolOriginalBound {
                tool: tool.clone(),
                reference: reference.clone(),
            },
        );
        apply_policy_fact(
            &mut view,
            Fact::OperationObserved {
                tool: tool.clone(),
                reply: OperationReply {
                    reference: reference.clone(),
                    receipt: Receipt::Recorded {
                        outcome: OperationOutcome::Unknown {
                            diagnostic: "policy uncertainty".into(),
                        },
                        cleanup: OperationCleanup::Unconfirmed,
                    },
                },
            },
        );
        let blocker = BlockerId::new();
        apply_policy_fact(
            &mut view,
            Fact::Blocked {
                blocker,
                reason: BlockerKind::OperationUnknown {
                    tool: tool.clone(),
                    reference: reference.clone(),
                },
            },
        );
        apply_policy_fact(
            &mut view,
            Fact::RiskAdjudicated {
                blocker,
                decision: RiskDecision::RecordExternalObservation {
                    evidence: source.clone(),
                },
                scope: RiskActionScope::Tool { tool: tool.clone() },
            },
        );
        apply_policy_fact(
            &mut view,
            Fact::ToolResultAccepted {
                tool: tool.clone(),
                result: source.clone(),
                outcome: AcceptedResult::RiskAdjudicated { blocker },
            },
        );
        apply_policy_fact(
            &mut view,
            Fact::OperationObserved {
                tool: tool.clone(),
                reply: OperationReply {
                    reference,
                    receipt: Receipt::Recorded {
                        outcome: OperationOutcome::Returned {
                            result: maka_agent_facts::operation::RecordedOperationResult::Success {
                                value: serde_json::Value::Null,
                            },
                        },
                        cleanup: OperationCleanup::Unconfirmed,
                    },
                },
            },
        );
        apply_policy_fact(
            &mut view,
            Fact::ModelCleanupObserved {
                attempt: prior,
                cleanup: OperationCleanup::Confirmed,
            },
        );
        let (mut view, request, current) = model_closure(
            view,
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Success,
            false,
        );
        apply_policy_fact(&mut view, Fact::BudgetCharged { tokens: 110 });
        apply_policy_fact(
            &mut view,
            Fact::ModelCleanupObserved {
                attempt: current,
                cleanup: OperationCleanup::Confirmed,
            },
        );
        let now = UnixMillis(1);
        let complete = reconcile::complete_at_budget(&view, &request, now);
        assert!(complete);
        // This is the exact Live construction consumed by current_authority_unavailable.
        let action = portless_reconciliation(&view, now, complete);
        assert!(matches!(action, Action::Observe(key) if key == tool));
    }

    #[test]
    fn original_model_cleanup_policy_wait_requires_its_late_canonical_ack() {
        let (mut view, request, attempt) = budget_closure(
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Success,
            false,
        );
        let authority = BlockerId::new();
        apply_policy_fact(
            &mut view,
            Fact::Blocked {
                blocker: authority,
                reason: BlockerKind::CurrentAuthorityUnavailable {
                    stage: AuthorityStage::CurrentSession,
                    diagnostic: "policy unavailable".into(),
                },
            },
        );
        let now = UnixMillis(1);
        let complete = reconcile::complete_at_budget(&view, &request, now);
        assert!(complete);
        let action = portless_reconciliation(&view, now, complete);
        let Action::Wait(reason @ WaitReason::Model { .. }, None) = action else {
            panic!("policy still requires the original source's cleanup proof");
        };
        let wait = WaitId::new();
        apply_policy_fact(
            &mut view,
            Fact::WaitRegistered {
                wait,
                reason,
                due_at: None,
            },
        );
        let complete = reconcile::complete_at_budget(&view, &request, now);
        assert!(complete);
        assert!(matches!(
            portless_reconciliation(&view, now, complete),
            Action::Idle
        ));
        apply_policy_fact(
            &mut view,
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
        );
        assert!(
            matches!(portless_reconciliation(&view, now, reconcile::complete_at_budget(&view, &request, now)), Action::Satisfy(id) if id == wait)
        );
        let evidence = view.spec.input.clone();
        apply_policy_fact(&mut view, Fact::WaitSatisfied { wait, evidence });
        assert!(matches!(
            portless_reconciliation(
                &view,
                now,
                reconcile::complete_at_budget(&view, &request, now)
            ),
            Action::Terminate(Terminal::Completed)
        ));
    }
}
