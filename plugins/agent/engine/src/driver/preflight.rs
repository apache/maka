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

use super::{DriverExit, accepted_content, exit};
use crate::{
    Engine, RunError,
    reconcile::{self, Action, Live},
};
use maka_agent_facts::durable::*;
use maka_agent_state::{
    ContentBlob, DriverClaim,
    fold::{RunView, tool_key},
};

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
            let mut source_blocker = None;
            if view.stopped
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
                    .is_some_and(|limit| view.tokens >= limit)
            {
                // Without ports, only canonical evidence can be drained. A Cell
                // needing physical observation remains explicitly unavailable.
                let live = Live {
                    observed: view.tools.values().map(|tool| tool.key.clone()).collect(),
                    looked_up: view.tools.values().map(|tool| tool.key.clone()).collect(),
                    publication_prepared: view
                        .external
                        .as_ref()
                        .and_then(|t| t.publication.as_ref())
                        .map(|p| std::iter::once(p.id).collect())
                        .unwrap_or_default(),
                    publication_looked_up: view
                        .external
                        .as_ref()
                        .and_then(|t| t.publication.as_ref())
                        .map(|p| p.items.values().map(|item| item.key).collect())
                        .unwrap_or_default(),
                    publication_observed: view
                        .external
                        .as_ref()
                        .and_then(|t| t.publication.as_ref())
                        .map(|p| p.items.values().map(|item| item.key).collect())
                        .unwrap_or_default(),
                    ..Live::default()
                };
                let (facts, contents) = match reconcile::next(&view, &live, at, None) {
                    Action::AbandonPublication(id)=>(vec![Fact::ExternalPublication{event:maka_agent_facts::external_publication::ExternalPublicationEvent::Abandoned{id}}],vec![]),
                    Action::CancelWait(wait) => (
                        vec![Fact::WaitCancelled {
                            wait,
                            diagnostic: "Run admission fence closed".into(),
                        }],
                        vec![],
                    ),
                    Action::Reject(tool, rejection) => {
                        let display = view.tools[&tool_key(&tool)].decision.as_ref()
                            .map(|decision| decision.display().clone()).unwrap_or_default();
                        (vec![Fact::ToolDecided {
                            tool,
                            decision: ToolDecision::Rejected { rejection, display },
                        }], vec![])
                    },
                    Action::Accept(key, outcome) => {
                        let tool = &view.tools[&tool_key(&key)];
                        let result = accepted_content(&view, tool, &outcome)?;
                        let mut facts = self.accept_cell_with_tool(&view, tool).await?;
                        facts.push(Fact::ToolResultAccepted {
                            tool: key,
                            result: result.reference().clone(),
                            outcome,
                        });
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
                        vec![Fact::RunTerminated {
                            terminal,
                            diagnostic: None,
                        }],
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
            if let Some(reason) = source_blocker {
                if !view.blockers.values().any(|blocker| {
                    blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                        && blocker.reason == reason
                }) {
                    facts.push(Fact::Blocked {
                        blocker: BlockerId::new(),
                        reason,
                    });
                }
            }
            if let Some(request) = view.stop_request {
                if view.stop_assessed != Some(request) {
                    facts.push(Fact::StopAssessed { request });
                }
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
