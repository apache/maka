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

use super::*;

impl Snapshot {
    pub(super) fn apply(
        &mut self,
        command: &Command,
        operation: &str,
        session: &str,
        now: u64,
    ) -> Result<(), Error> {
        match command {
            Command::Propose { turn_id, artifact } => {
                identifier(turn_id)?;
                artifact.validate()?;
                if self.execution.as_ref().is_some_and(|e| {
                    matches!(e.phase, Phase::AwaitingAdmission | Phase::Active { .. })
                }) {
                    return Err(Error::Conflict);
                }
                let prior = self.proposal.as_ref().filter(|p| {
                    p.status != ProposalStatus::Approved
                        || self.execution.as_ref().is_some_and(|e| {
                            e.proposal_id == p.id && matches!(e.phase, Phase::Interrupted { .. })
                        })
                });
                let id = format!("proposal_{operation}");
                let revision = match prior {
                    None => 1,
                    Some(p) => p
                        .revision
                        .checked_add(1)
                        .filter(|n| *n < 1 << 53)
                        .ok_or_else(|| invalid("Plan proposal revision exhausted"))?,
                };
                self.proposal = Some(Proposal {
                    plan_id: prior.map_or_else(|| id.clone(), |p| p.plan_id.clone()),
                    revision,
                    supersedes: prior.map(|p| p.id.clone()),
                    source_execution_id: self
                        .execution
                        .as_ref()
                        .filter(|e| matches!(e.phase, Phase::Interrupted { .. }))
                        .map(|e| e.id.clone()),
                    id,
                    turn_id: turn_id.clone(),
                    artifact: artifact.clone(),
                    status: ProposalStatus::PendingApproval,
                    submitted_at: now,
                });
            }
            Command::Revise { proposal_id } | Command::Abandon { proposal_id } => {
                let proposal = self
                    .proposal
                    .as_mut()
                    .filter(|p| &p.id == proposal_id)
                    .ok_or(Error::Conflict)?;
                if !matches!(
                    proposal.status,
                    ProposalStatus::PendingApproval | ProposalStatus::RevisionRequested
                ) {
                    return Err(Error::Conflict);
                }
                proposal.status = if matches!(command, Command::Revise { .. }) {
                    ProposalStatus::RevisionRequested
                } else {
                    ProposalStatus::Abandoned
                };
            }
            Command::Approve {
                proposal_id,
                proposal_revision,
                behavior,
                grant,
            } => {
                let proposal = self
                    .proposal
                    .as_mut()
                    .filter(|p| {
                        &p.id == proposal_id
                            && p.revision == *proposal_revision
                            && p.status == ProposalStatus::PendingApproval
                    })
                    .ok_or(Error::Conflict)?;
                if self.execution.as_ref().is_some_and(|e| {
                    matches!(e.phase, Phase::AwaitingAdmission | Phase::Active { .. })
                }) {
                    return Err(Error::Conflict);
                }
                if let Some(source) = &proposal.source_execution_id
                    && !self.execution.as_ref().is_some_and(|e| {
                        &e.id == source && matches!(e.phase, Phase::Interrupted { .. })
                    })
                {
                    return Err(Error::Conflict);
                }
                let mut execution = Execution {
                    id: format!("execution_{operation}"),
                    proposal_id: proposal.id.clone(),
                    artifact: proposal.artifact.clone(),
                    steps: proposal
                        .artifact
                        .steps
                        .iter()
                        .map(|step| Progress {
                            id: step.id.clone(),
                            status: StepStatus::Pending,
                            note: None,
                        })
                        .collect(),
                    request: Submit {
                        operation_id: format!("plan_{operation}"),
                        session_id: session.into(),
                        content: "".into(),
                        orchestration_mode: Some(behavior.clone()),
                    },
                    phase: Phase::AwaitingAdmission,
                    grant: *grant,
                    dispatched: false,
                    cancellation: None,
                    updated_at: now,
                };
                execution.freeze_request()?;
                proposal.status = ProposalStatus::Approved;
                self.execution = Some(execution);
            }
            Command::Resume {
                execution_id,
                grant,
            } => {
                let execution = self.execution(execution_id)?;
                if !matches!(execution.phase, Phase::Interrupted { .. }) {
                    return Err(Error::Conflict);
                }
                if self.proposal.as_ref().is_some_and(|p| {
                    p.id != execution.proposal_id && p.status != ProposalStatus::Abandoned
                }) {
                    return Err(Error::Conflict);
                }
                let execution = self.execution.as_mut().unwrap();
                execution.request.operation_id = format!("plan_{operation}");
                execution.freeze_request()?;
                execution.phase = Phase::AwaitingAdmission;
                execution.grant = *grant;
                execution.dispatched = false;
                execution.cancellation = None;
                execution.updated_at = now;
            }
            Command::Dispatch { execution_id } => {
                let execution = self.execution_mut(execution_id)?;
                if !matches!(execution.phase, Phase::AwaitingAdmission)
                    || execution.dispatched
                    || execution.cancellation.is_some()
                {
                    return Err(Error::Conflict);
                }
                execution.dispatched = true;
                execution.updated_at = now;
            }
            Command::Reconcile {
                execution_id,
                grant,
            } => {
                let execution = self.execution_mut(execution_id)?;
                if !matches!(
                    execution.phase,
                    Phase::AwaitingAdmission | Phase::Active { .. }
                ) {
                    return Err(Error::Conflict);
                }
                execution.grant = *grant;
                execution.updated_at = now;
            }
            Command::Defer { execution_id } => {
                let execution = self.execution_mut(execution_id)?;
                if !matches!(execution.phase, Phase::AwaitingAdmission) {
                    return Err(Error::Conflict);
                }
                execution.dispatched = false;
                if let Some(reason) = &execution.cancellation {
                    execution.phase = Phase::Cancelled {
                        receipt: None,
                        reason: reason.clone(),
                    };
                }
                execution.updated_at = now;
            }
            Command::Accept {
                execution_id,
                receipt,
            } => {
                let execution = self.execution_mut(execution_id)?;
                if !matches!(execution.phase, Phase::AwaitingAdmission)
                    || receipt.invocation.session_id != session
                    || receipt.content_digest != execution.request.digest().map_err(invalid)?
                {
                    return Err(Error::Conflict);
                }
                for id in [
                    &receipt.invocation.turn_id,
                    &receipt.invocation.run_id,
                    &receipt.invocation.invocation_id,
                    &receipt.message_id,
                ] {
                    identifier(id)?;
                }
                execution.phase = Phase::Active {
                    receipt: receipt.clone(),
                };
                execution.updated_at = now;
            }
            Command::Reject {
                execution_id,
                request_digest,
                reason,
            } => {
                text(reason, 1024)?;
                let execution = self.execution_mut(execution_id)?;
                if !matches!(execution.phase, Phase::AwaitingAdmission)
                    || &execution.request.digest().map_err(invalid)? != request_digest
                {
                    return Err(Error::Conflict);
                }
                execution.phase = match &execution.cancellation {
                    Some(reason) => Phase::Cancelled {
                        receipt: None,
                        reason: reason.clone(),
                    },
                    None => Phase::Interrupted {
                        receipt: None,
                        reason: reason.clone(),
                    },
                };
                execution.updated_at = now;
            }
            Command::Progress {
                execution_id,
                invocation,
                steps,
            } => {
                let execution = self.execution_mut(execution_id)?;
                execution.active(invocation)?;
                if execution.cancellation.is_some() {
                    return Err(Error::Conflict);
                }
                execution.artifact.progress(steps)?;
                execution.steps = steps.clone();
                execution.updated_at = now;
            }
            Command::Interrupt {
                execution_id,
                invocation,
                reason,
            } => {
                text(reason, 1024)?;
                let execution = self.execution_mut(execution_id)?;
                let receipt = execution.active(invocation)?.clone();
                execution.phase = Phase::Interrupted {
                    receipt: Some(receipt),
                    reason: reason.clone(),
                };
                execution.updated_at = now;
            }
            Command::Cancel {
                execution_id,
                reason,
                grant,
            } => {
                text(reason, 1024)?;
                let execution = self.execution_mut(execution_id)?;
                match &execution.phase {
                    Phase::Interrupted { receipt, .. } => {
                        execution.phase = Phase::Cancelled {
                            receipt: receipt.clone(),
                            reason: reason.clone(),
                        };
                    }
                    Phase::AwaitingAdmission if !execution.dispatched => {
                        execution.phase = Phase::Cancelled {
                            receipt: None,
                            reason: reason.clone(),
                        };
                    }
                    Phase::AwaitingAdmission | Phase::Active { .. } => {}
                    _ => return Err(Error::Conflict),
                };
                execution.cancellation = Some(reason.clone());
                if let Some(grant) = grant {
                    execution.grant = *grant;
                }
                execution.updated_at = now;
                if let Some(proposal) = &mut self.proposal
                    && proposal.source_execution_id.as_ref() == Some(execution_id)
                    && proposal.status == ProposalStatus::PendingApproval
                {
                    proposal.status = ProposalStatus::RevisionRequested;
                }
            }
            Command::Settle {
                execution_id,
                invocation,
                outcome,
            } => {
                let execution = self.execution_mut(execution_id)?;
                let receipt = execution.active(invocation)?.clone();
                execution.phase = if let Some(reason) = &execution.cancellation {
                    Phase::Cancelled {
                        receipt: Some(receipt),
                        reason: reason.clone(),
                    }
                } else {
                    match outcome {
                        Settlement::Completed
                            if execution.steps.iter().all(|step| {
                                matches!(step.status, StepStatus::Completed | StepStatus::Skipped)
                            }) =>
                        {
                            Phase::Completed { receipt }
                        }
                        Settlement::Completed => Phase::Interrupted {
                            receipt: Some(receipt),
                            reason:
                                "Host execution ended before every Plan step was reported complete"
                                    .into(),
                        },
                        Settlement::Interrupted { reason } => {
                            text(reason, 1024)?;
                            Phase::Interrupted {
                                receipt: Some(receipt),
                                reason: reason.clone(),
                            }
                        }
                    }
                };
                execution.updated_at = now;
            }
        }
        Ok(())
    }

    fn execution(&self, id: &str) -> Result<&Execution, Error> {
        self.execution
            .as_ref()
            .filter(|e| e.id == id)
            .ok_or(Error::Conflict)
    }
    fn execution_mut(&mut self, id: &str) -> Result<&mut Execution, Error> {
        self.execution
            .as_mut()
            .filter(|e| e.id == id)
            .ok_or(Error::Conflict)
    }
}

impl Execution {
    fn active(&self, invocation: &Invocation) -> Result<&Receipt, Error> {
        match &self.phase {
            Phase::Active { receipt } if &receipt.invocation == invocation => Ok(receipt),
            _ => Err(Error::Conflict),
        }
    }
    fn freeze_request(&mut self) -> Result<(), Error> {
        // IDs and current progress are durable model input, not UI-only metadata.
        self.request.content = format!(
            "Execute the user-approved plan. Report progress using these exact step IDs.\n{}",
            serde_json::to_string(&serde_json::json!({
                "executionId": self.id, "proposalId": self.proposal_id,
                "plan": self.artifact, "progress": self.steps,
            }))
            .map_err(invalid)?,
        )
        .into();
        self.request.validate().map_err(invalid)
    }
}
