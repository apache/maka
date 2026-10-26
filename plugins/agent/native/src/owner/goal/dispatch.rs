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
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::language::Language;
use maka_event_log::{
    message_admissions::{PendingExecution, PendingMessageAdmission},
    turns::InvocationState,
};

pub(super) fn identity(request: &maka_agent_ports::execution::Submit) -> Invocation {
    let id = hex::encode(Sha256::digest(request.operation_id.as_bytes()));
    Invocation {
        session_id: request.session_id.clone(),
        turn_id: format!("t_{id}"),
        run_id: format!("r_{id}"),
        invocation_id: format!("i_{id}"),
    }
}
fn admission(
    goal: &maka_goal::goal::Goal<MessageBasis>,
) -> Result<PendingMessageAdmission, String> {
    let pending = goal.pending.as_ref().ok_or("goal_iteration_missing")?;
    let invocation = identity(&pending.request);
    let mut basis = goal.arm.grant.clone();
    basis.fingerprint = hex::encode(Sha256::digest(
        serde_json::to_vec(&pending.request).map_err(reason)?,
    ));
    let message = pending.request.content.clone();
    Ok(PendingMessageAdmission {
        execution: PendingExecution {
            owner: String::new(),
            basis: serde_json::to_value(basis).map_err(reason)?,
        },
        source: RootSourceMessage {
            message: DeliveredMessage {
                origin: None,
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
        // Logical Goal identity has no wall-clock dependency; retries are byte-identical.
        admitted_at: 0,
    })
}
impl Owner {
    pub(in crate::owner) fn start_goals(self: &Arc<Self>) {
        let owner = self.clone();
        self.producers.spawn(async move {
            let mut changes = owner.store.subscribe_changes();
            let mut previous_error = None;
            loop {
                changes.borrow_and_update();
                let Some(producer) = owner.producer().await else {
                    return;
                };
                let monitor = match owner.tick_goals().await {
                    Ok(monitor) => {
                        previous_error = None;
                        monitor
                    }
                    Err(error) => {
                        owner.goals.awake.store(true, Ordering::Release);
                        if previous_error.as_ref() != Some(&error) {
                            eprintln!("Goal: {error}");
                        }
                        previous_error = Some(error);
                        true
                    }
                };
                drop(producer);
                tokio::select! {
                    biased;
                    () = owner.stop.cancelled() => return,
                    () = owner.goals.wake.notified() => {},
                    changed = changes.changed(), if monitor => if changed.is_err() { return; },
                    () = tokio::time::sleep(Duration::from_secs(5)), if monitor => {},
                }
            }
        });
    }
    async fn tick_goals(self: &Arc<Self>) -> Result<bool, String> {
        let _gate = self.goals.gate.lock().await;
        for saved in self.goals.repository.sessions().await.map_err(reason)? {
            if self.stop.is_cancelled() {
                break;
            }
            self.tick_goal(saved).await?;
        }
        let monitored = self.goals.repository.sessions().await.map_err(reason)?;
        // Publish while the same gate still excludes Goal mutations. Otherwise
        // an idle tick could overwrite a just-created Goal's retirement hint.
        self.goals.awake.store(
            monitored.iter().any(|saved| saved.goal.keeps_host_awake()),
            Ordering::Release,
        );
        Ok(!monitored.is_empty())
    }
    async fn tick_goal(self: &Arc<Self>, mut saved: Saved<MessageBasis>) -> Result<(), String> {
        let session = saved.goal.session_id.clone();
        if let Some(pending) = &saved.goal.pending {
            let original = identity(&pending.request);
            let boundary = self
                .store
                .session(&session)
                .await
                .map_err(|error| error.to_string())?
                .turn_boundary(&session, &original.turn_id)
                .await
                .map_err(reason)?;
            if let Some(boundary) = boundary {
                if boundary.root_invocation() != &original {
                    return Err("goal_execution_identity_changed".into());
                }
                // A terminal event does not certify physical cleanup. The original
                // worker must release its control before the Goal can advance.
                let runs = self.runs.lock().await;
                if let Some(control) = runs
                    .controls
                    .get(&session)
                    .filter(|control| control.invocation.turn_id == original.turn_id)
                {
                    if matches!(
                        saved.goal.status,
                        Status::Cancelled | Status::CancellationUnknown
                    ) {
                        control.cancellation.cancel();
                    }
                    return Ok(());
                }
                drop(runs);
                match boundary.state {
                    InvocationState::Ended {
                        outcome: InvocationOutcome::HandoffPaused { .. },
                        ..
                    } => {
                        saved.goal.handoff_paused();
                    }
                    InvocationState::Ended { outcome, .. } => {
                        saved.goal.settled(outcome, self.goal_meter(&session).await);
                    }
                    _ => return Ok(()),
                }
                return self.goals.save(saved).await;
            }
            let mut request = admission(&saved.goal)?;
            request.execution.owner = self.prefix.clone();
            let message = &request.source.message.message_id;
            if self
                .store
                .session(&session)
                .await
                .map_err(|error| error.to_string())?
                .message_cancelled(&session, message)
                .await
                .map_err(reason)?
            {
                saved.goal.settled(
                    InvocationOutcome::Cancelled {
                        source: "goal_message_cancelled".into(),
                    },
                    self.goal_meter(&session).await,
                );
                return self.goals.save(saved).await;
            }
            let accepted = self
                .store
                .session(&session)
                .await
                .map_err(|error| error.to_string())?
                .message_admission(&session, message)
                .await
                .map_err(reason)?
                .is_some();
            if matches!(
                saved.goal.status,
                Status::Cancelled | Status::CancellationUnknown
            ) {
                if accepted {
                    // Its immutable queued input is rejected by the normal Agent
                    // preparation check, even after a restart. No sibling is stopped.
                    self.admit_notification(&request).await?;
                } else {
                    // This same gate excludes all Goal dispatches; the SQL read
                    // observed no accepted original request after prior writes settled.
                    saved.goal.pending = None;
                    saved.goal.status = Status::Cancelled;
                    saved.goal.note = (match saved.goal.arm.language {
                        Language::En => "Cancelled before execution admission",
                        Language::ZhCn => "执行接纳前已取消",
                        Language::ZhTw => "執行接納前已取消",
                    })
                    .into();
                    self.goals.save(saved).await?;
                }
                return Ok(());
            }
            if !accepted && saved.goal.status != Status::Active {
                return Ok(());
            }
            if !accepted {
                if let Err(reason) = self.validate_background(&saved.goal.arm.grant).await {
                    saved.goal.status = Status::Blocked;
                    saved.goal.authority_blocked = true;
                    saved.goal.note = reason;
                    // No accepted execution exists and this gate excludes dispatch.
                    saved.goal.pending = None;
                    return self.goals.save(saved).await;
                }
                if !saved.goal.pending.as_ref().expect("pending").dispatched {
                    saved.goal.pending.as_mut().expect("pending").dispatched = true;
                    self.goals.save(saved.clone()).await?;
                }
            }
            self.admit_notification(&request).await?;
            return Ok(());
        }
        if saved.goal.status != Status::Active {
            return Ok(());
        }
        if let Err(reason) = self.validate_background(&saved.goal.arm.grant).await {
            saved.goal.status = Status::Blocked;
            saved.goal.authority_blocked = true;
            saved.goal.note = reason;
            return self.goals.save(saved).await;
        }
        if !self.goal_session_idle(&session).await? {
            return Ok(());
        }
        saved.goal.meter(self.goal_meter(&session).await?);
        if saved.goal.status == Status::Active {
            saved.goal.reserve().map_err(reason)?;
        }
        self.goals.save(saved).await
    }
}
