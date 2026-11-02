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
use maka_agent_facts::{event::InvocationOutcome, message::MessageOrigin};
use maka_agent_ports::execution::{Receipt, Submit};
use maka_assistant::plan::{Execution, Settlement};
use maka_event_log::{
    message_admissions::{PendingExecution, PendingMessageAdmission},
    turns::InvocationState,
};

pub(super) fn invocation(request: &Submit) -> Invocation {
    let id = hex::encode(Sha256::digest(request.operation_id.as_bytes()));
    Invocation {
        session_id: request.session_id.clone(),
        turn_id: format!("t_{id}"),
        run_id: format!("r_{id}"),
        invocation_id: format!("i_{id}"),
    }
}
fn admission(
    owner: &str,
    execution: &Execution<MessageBasis>,
) -> Result<PendingMessageAdmission, String> {
    let invocation = invocation(&execution.request);
    let message = execution.request.content.clone();
    let mut basis = execution.grant.clone();
    basis.fingerprint = identity(&execution.request)?;
    Ok(PendingMessageAdmission {
        execution: PendingExecution {
            owner: owner.into(),
            basis: serde_json::to_value(basis).map_err(reason)?,
        },
        source: RootSourceMessage {
            message: DeliveredMessage {
                origin: Some(MessageOrigin::Plan {
                    execution_id: execution.id.clone(),
                    title: execution.artifact.title.clone(),
                }),
                message_id: invocation.invocation_id.replacen("i_", "m_", 1),
                submitted_content_digest: message.content_digest().map_err(reason)?,
                content: message.clone(),
            },
            unprepared_content: message,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        },
        invocation,
        steering_invocation: None,
        required_tools: Default::default(),
        admitted_at: 0,
    })
}
pub(super) fn receipt(execution: &Execution<MessageBasis>) -> Result<Receipt, String> {
    let invocation = invocation(&execution.request);
    Ok(Receipt {
        message_id: invocation.invocation_id.replacen("i_", "m_", 1),
        invocation,
        content_digest: execution.request.digest().map_err(reason)?,
    })
}
fn active(snapshot: &Snapshot<MessageBasis>) -> bool {
    snapshot.execution.as_ref().is_some_and(|execution| {
        matches!(
            execution.phase,
            Phase::AwaitingAdmission | Phase::Active { .. }
        )
    })
}
impl Owner {
    pub(in crate::owner) fn start_plans(self: &Arc<Self>) {
        let owner = self.clone();
        self.producers.spawn(async move {
            let mut changes = owner.store.subscribe_changes();
            let mut previous_error = None;
            loop {
                changes.borrow_and_update();
                let Some(producer) = owner.producer().await else {
                    return;
                };
                let monitor = match owner.tick_plans().await {
                    Ok(monitor) => {
                        previous_error = None;
                        monitor
                    }
                    Err(error) => {
                        owner.plans.awake.store(true, Ordering::Release);
                        if previous_error.as_ref() != Some(&error) {
                            eprintln!("Plan: {error}");
                        }
                        previous_error = Some(error);
                        true
                    }
                };
                drop(producer);
                tokio::select! {
                    biased;
                    () = owner.stop.cancelled() => return,
                    () = owner.plans.wake.notified() => {},
                    changed = changes.changed(), if monitor => if changed.is_err() { return; },
                    () = tokio::time::sleep(Duration::from_secs(5)), if monitor => {},
                }
            }
        });
    }
    async fn tick_plans(self: &Arc<Self>) -> Result<bool, String> {
        let _gate = self.plans.gate.lock().await;
        let sessions = Repository::<MessageBasis>::sessions(self.plans.storage.as_ref(), ENTRY)
            .await
            .map_err(reason)?;
        let mut monitor = false;
        for session in sessions {
            if self.stop.is_cancelled() {
                break;
            }
            let repo = self.plans.repository(&session)?;
            let snapshot = repo.current().await.map_err(reason)?;
            if active(&snapshot) {
                self.tick_plan(&session, snapshot).await?;
            }
            monitor |= active(&repo.current().await.map_err(reason)?);
        }
        self.plans.awake.store(monitor, Ordering::Release);
        Ok(monitor)
    }
    async fn tick_plan(
        self: &Arc<Self>,
        session: &str,
        mut snapshot: Snapshot<MessageBasis>,
    ) -> Result<(), String> {
        let execution = snapshot
            .execution
            .as_ref()
            .ok_or("plan_execution_missing")?;
        let original = invocation(&execution.request);
        let request = admission(&self.prefix, execution)?;
        if let Some(boundary) = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .turn_boundary(session, &original.turn_id)
            .await
            .map_err(reason)?
        {
            if boundary.root_invocation() != &original {
                return Err("plan_execution_identity_changed".into());
            }
            if matches!(execution.phase, Phase::AwaitingAdmission) {
                snapshot = self
                    .plans
                    .advance(
                        session,
                        &snapshot,
                        Command::Accept {
                            execution_id: execution.id.clone(),
                            receipt: receipt(execution)?,
                        },
                    )
                    .await?;
            }
            let execution = snapshot
                .execution
                .as_ref()
                .ok_or("plan_execution_missing")?;
            let runs = self.runs.lock().await;
            if let Some(control) = runs
                .controls
                .get(session)
                .filter(|control| control.invocation.turn_id == original.turn_id)
            {
                if execution.cancellation.is_some() {
                    control.cancellation.cancel();
                }
                // Logical completion never outruns the original worker's physical cleanup.
                return Ok(());
            }
            drop(runs);
            let InvocationState::Ended { outcome, .. } = boundary.state else {
                return Ok(());
            };
            let outcome = match outcome {
                InvocationOutcome::Completed => Settlement::Completed,
                InvocationOutcome::Failed { class, message, .. } => Settlement::Interrupted { reason: bounded(&message.unwrap_or(class)) },
                InvocationOutcome::Cancelled { source } => Settlement::Interrupted { reason: bounded(&format!("Execution cancelled: {source}")) },
                InvocationOutcome::HandoffPaused { .. } => Settlement::Interrupted { reason: "Original execution is paused; resume the Session before approving another attempt".into() },
                _ => Settlement::Interrupted { reason: "Execution ended without Plan completion".into() },
            };
            self.plans
                .advance(
                    session,
                    &snapshot,
                    Command::Settle {
                        execution_id: execution.id.clone(),
                        invocation: original,
                        outcome,
                    },
                )
                .await?;
            return Ok(());
        }
        if matches!(execution.phase, Phase::Active { .. }) {
            return Err("plan_original_execution_unavailable".into());
        }
        let message = &request.source.message.message_id;
        let cancelled = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .message_cancelled(session, message)
            .await
            .map_err(reason)?;
        let accepted = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .message_admission(session, message)
            .await
            .map_err(reason)?
            .is_some();
        if cancelled || (execution.cancellation.is_some() && !accepted) {
            // All dispatches share this gate; the original admission has settled and is absent.
            self.plans
                .advance(
                    session,
                    &snapshot,
                    Command::Reject {
                        execution_id: execution.id.clone(),
                        request_digest: execution.request.digest().map_err(reason)?,
                        reason: "Original Plan message cancelled before execution".into(),
                    },
                )
                .await?;
            return Ok(());
        }
        if !accepted {
            if let Err(error) = self.validate_background(&execution.grant).await {
                self.plans
                    .advance(
                        session,
                        &snapshot,
                        Command::Reject {
                            execution_id: execution.id.clone(),
                            request_digest: execution.request.digest().map_err(reason)?,
                            reason: bounded(&error),
                        },
                    )
                    .await?;
                return Ok(());
            }
            if !execution.dispatched {
                self.plans
                    .advance(
                        session,
                        &snapshot,
                        Command::Dispatch {
                            execution_id: execution.id.clone(),
                        },
                    )
                    .await?;
            }
        }
        // Accepted cancelled inputs are drained by the original queue's normal preparation check.
        self.admit_notification(&request).await?;
        Ok(())
    }
}
fn bounded(value: &str) -> String {
    let value = value.replace('\0', "");
    let value = value[..value.floor_char_boundary(value.len().min(1024))].trim();
    if value.is_empty() {
        "Plan execution interrupted".into()
    } else {
        value.into()
    }
}
