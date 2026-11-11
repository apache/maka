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

use super::super::notifications::BackgroundApproval;
use super::*;
use maka_agent_facts::durable::{Fact, Terminal, UnixMillis};
use maka_agent_state::{
    Change, Head,
    queue::{MessageResolution, QueueCommand, QueueEdit, RequestId},
};

impl Owner {
    pub(in crate::owner) fn start_goals(self: &Arc<Self>) {
        let owner = self.clone();
        self.producers.spawn(async move {
            let mut changes = owner.store.subscribe_changes();
            let mut run_changes = match owner.durable.subscribe() {
                Ok(changes) => changes,
                Err(error) => { eprintln!("Goal: {error}"); return; }
            };
            let mut previous_error = None;
            loop {
                changes.borrow_and_update();
                run_changes.borrow_and_update();
                let Some(producer) = owner.producer().await else {
                    return;
                };
                let (deadline, error) = match owner.tick_goals().await {
                    Ok((deadline, errors)) => (deadline, (!errors.is_empty()).then(|| errors.join("\n"))),
                    Err(error) => {
                        owner.goals.awake.store(true, Ordering::Release);
                        (None, Some(error))
                    }
                };
                if let Some(error) = &error
                    && previous_error.as_ref() != Some(error) { eprintln!("Goal: {error}"); }
                previous_error = error;
                drop(producer);
                tokio::select! {
                    biased;
                    () = owner.stop.cancelled() => return,
                    () = owner.goals.wake.notified() => {},
                    changed = changes.changed() => if changed.is_err() { return; },
                    changed = run_changes.changed() => if changed.is_err() { return; },
                    () = async {
                        if let Some(at) = deadline {
                            tokio::time::sleep(Duration::from_millis(at.saturating_sub(now()))).await;
                        } else { std::future::pending::<()>().await; }
                    } => {},
                }
            }
        });
    }
    async fn tick_goals(self: &Arc<Self>) -> Result<(Option<u64>, Vec<String>), String> {
        use maka_goal::goal::Scheduled;
        let _gate = self.goals.gate.lock().await;
        let index = self.goals.repository.schedule().await.map_err(reason)?;
        let waiting = index
            .sessions
            .values()
            .filter_map(|entry| match entry {
                Scheduled::Waiting { run, .. } => Some(*run),
                _ => None,
            })
            .collect();
        let finished = self
            .durable
            .finished_or_stopped(self.run_owner(), waiting)
            .await
            .map_err(reason)?;
        let mut errors = Vec::new();
        for (session, entry) in index.sessions {
            if self.stop.is_cancelled() {
                break;
            }
            let ready = match entry {
                Scheduled::Ready => true,
                Scheduled::Due { at } => at <= now(),
                Scheduled::Waiting { run, stop } => stop || finished.contains(&run),
            };
            if !ready {
                continue;
            }
            let result = match self.goals.repository.read(&session).await {
                Ok(Some(saved)) => self.tick_goal(saved).await,
                Ok(None) => Err("Goal schedule points to missing source".into()),
                Err(error) => Err(reason(error)),
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        let index = self.goals.repository.schedule().await.map_err(reason)?;
        self.goals.awake.store(
            !index.sessions.is_empty() || !errors.is_empty(),
            Ordering::Release,
        );
        Ok((
            index
                .sessions
                .values()
                .filter_map(|entry| match entry {
                    Scheduled::Due { at } if *at > now() => Some(*at),
                    _ => None,
                })
                .min(),
            errors,
        ))
    }
    async fn tick_goal(
        self: &Arc<Self>,
        mut saved: Saved<BackgroundApproval>,
    ) -> Result<(), String> {
        let session = saved.goal.session_id.clone();
        if let Some(pending) = saved.goal.pending.clone() {
            let (run, managed) = match pending {
                Pending::Existing { run, managed } => (run, managed),
                Pending::Dispatch { request } => {
                    let key = request.operation_id.clone();
                    let message_id = format!("m_{key}");
                    match self
                        .durable
                        .queue()
                        .resolve_message(session.clone(), message_id.clone())
                        .await
                        .map_err(reason)?
                    {
                        MessageResolution::Delivered { run, shared } => {
                            saved.goal.pending = Some(Pending::Existing {
                                run,
                                managed: !shared,
                            });
                            return self.goals.save(saved).await;
                        }
                        MessageResolution::Cancelled => {
                            saved
                                .goal
                                .settled(Terminal::Cancelled, self.goal_meter(&session).await)?;
                            return self.goals.save(saved).await;
                        }
                        MessageResolution::Pending => {
                            if saved.goal.status != Status::Active {
                                let _ordered = self.runs.ordered(&session).await;
                                let queue = self.durable.queue();
                                // Re-observe after obtaining the admission order, before retracting.
                                if matches!(
                                    queue
                                        .resolve_message(session.clone(), message_id)
                                        .await
                                        .map_err(reason)?,
                                    MessageResolution::Pending
                                ) {
                                    let current =
                                        queue.read(session.clone()).await.map_err(reason)?;
                                    queue
                                        .execute(
                                            session.clone(),
                                            QueueCommand {
                                                id: Default::default(),
                                                at: UnixMillis(now() as i64),
                                                expected_revision: current.revision,
                                                edit: QueueEdit::Retract {
                                                    request: RequestId(key),
                                                },
                                            },
                                            vec![],
                                        )
                                        .await
                                        .map_err(reason)?;
                                }
                            }
                            return Ok(());
                        }
                        MessageResolution::Missing => {
                            if saved.goal.status != Status::Active {
                                saved.goal.pending = None;
                                return self.goals.save(saved).await;
                            }
                            let grant = &saved.goal.arm.grant;
                            let basis = match self
                                .prepare_approved_background(
                                    grant,
                                    BackgroundKind::Goal(saved.goal.id),
                                )
                                .await
                            {
                                Ok(basis) => basis,
                                Err(error) => {
                                    tracing::info!(cause = %error, "Goal is awaiting updated conversation settings");
                                    saved.goal.pause_for_settings();
                                    saved.goal.pending = None;
                                    return self.goals.save(saved).await;
                                }
                            };
                            self.check_goal_tools(&basis)?;
                            let message = request.content;
                            let source = RootSourceMessage {
                                message: DeliveredMessage {
                                    origin: Some(maka_agent_facts::message::MessageOrigin::Goal {
                                        goal_id: saved.goal.id.to_string(),
                                        objective: saved.goal.arm.objective.clone(),
                                    }),
                                    message_id,
                                    submitted_content_digest: message
                                        .content_digest()
                                        .map_err(reason)?,
                                    content: message.clone(),
                                },
                                unprepared_content: message,
                                submitted_placement: Placement::CurrentTurn,
                                disposition: MessageDisposition::TurnStarted,
                                submitted_intent: None,
                            };
                            self.enqueue_background(
                                &session,
                                source,
                                &basis,
                                &key,
                                ["GoalStatus".to_owned()].into(),
                                maka_agent_state::queue::Placement::Followup,
                            )
                            .await?;
                            return Ok(());
                        }
                    }
                }
            };
            let view = self.durable.frontier(run).await.map_err(reason)?;
            if view.spec.session_id != session || view.spec.owner != self.run_owner() {
                return Err("goal_execution_identity_changed".into());
            }
            if let Some(terminal) = view.terminal.clone() {
                let retry_at = if terminal == Terminal::Failed {
                    failure_retry_at(&view)?
                } else {
                    None
                };
                saved
                    .goal
                    .settled(terminal, self.goal_meter(&session).await)?;
                if retry_at.is_some() {
                    saved.goal.retry_at = retry_at;
                }
                return self.goals.save(saved).await;
            }
            if view.stopped && saved.goal.status == Status::Active {
                saved.goal.status = Status::Paused;
                self.goals.save(saved).await?;
                return Ok(());
            }
            // The initial user Run is observed, not owned by Goal. Only a Goal-produced
            // request may be stopped by Goal control; sibling/user Runs are untouched.
            if managed
                && matches!(saved.goal.status, Status::Cancelled | Status::Paused)
                && !view.stopped
            {
                self.durable
                    .control(
                        run,
                        Head::from(&view),
                        vec![Change::new(
                            Fact::StopRequested {
                                diagnostic: "goal_control".into(),
                            },
                            UnixMillis(now() as i64),
                        )],
                        vec![],
                    )
                    .await
                    .map_err(reason)?;
                self.wake_notify.notify_one();
            }
            return Ok(());
        }
        if saved.goal.status != Status::Active || !self.goal_session_idle(&session).await? {
            return Ok(());
        }
        saved.goal.meter(self.goal_meter(&session).await?);
        if saved.goal.status == Status::Active {
            if let Err(error) = self
                .prepare_approved_background(
                    &saved.goal.arm.grant,
                    BackgroundKind::Goal(saved.goal.id),
                )
                .await
            {
                tracing::info!(cause = %error, "Goal is awaiting updated conversation settings");
                saved.goal.pause_for_settings();
                return self.goals.save(saved).await;
            }
            if !saved.goal.reserve().map_err(reason)? {
                return Ok(());
            }
        }
        self.goals.save(saved).await
    }
}

fn failure_retry_at(view: &maka_agent_state::fold::RunView) -> Result<Option<u64>, String> {
    let Some(closed) = view
        .current_attempt
        .and_then(|attempt| view.attempts.get(&attempt))
        .and_then(|attempt| attempt.closed.as_ref())
    else {
        return Ok(None);
    };
    let Some(failure) = closed
        .protocol
        .get("failure")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    let failure: maka_model::ModelError =
        serde_json::from_value(failure.clone()).map_err(reason)?;
    match failure {
        maka_model::ModelError::Provider(failure) => {
            failure.validate().map_err(reason)?;
            Ok(failure.retry_at_unix_ms())
        }
        _ => Ok(None),
    }
}
