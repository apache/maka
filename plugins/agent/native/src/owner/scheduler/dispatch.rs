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
use maka_event_log::message_admissions::{PendingExecution, PendingMessageAdmission};
impl MessageBasis {
    pub(in crate::owner) fn validate_background_target(
        &self,
        session: &SessionRecord<ResolvedConfiguration>,
    ) -> Result<(), String> {
        if let Some(boundary) = &self.background
            && (session.archived
                || session.configuration.workspace != boundary.workspace
                || session.configuration.permissions != boundary.permissions
                || session.configuration.binding != boundary.binding
                || session.configuration.boundary_revision
                    != if session.id == boundary.session_id {
                        boundary.boundary_revision
                    } else {
                        0 // A scheduled new conversation freezes its creation boundary.
                    })
        {
            return Err("scheduler_authorization_changed".into());
        }
        Ok(())
    }
}
impl Owner {
    pub(in crate::owner) async fn validate_background(
        &self,
        basis: &MessageBasis,
    ) -> Result<(), String> {
        let Some(boundary) = &basis.background else {
            return Ok(());
        };
        if !match &basis.background_kind {
            BackgroundKind::Schedule => self.settings.scheduled_tasks,
            BackgroundKind::Goal(_) => self.settings.goals,
            BackgroundKind::Plan(_) => self.settings.plans,
        } {
            return Err(match &basis.background_kind {
                BackgroundKind::Schedule => "scheduler_disabled",
                BackgroundKind::Goal(_) => "goal_disabled",
                BackgroundKind::Plan(_) => "plan_disabled",
            }
            .into());
        }
        match &basis.background_kind {
            BackgroundKind::Goal(id) => {
                self.check_goal_background(&boundary.session_id, *id)
                    .await?
            }
            BackgroundKind::Plan(proposal) => {
                self.check_plan_background(&boundary.session_id, proposal, basis)
                    .await?
            }
            BackgroundKind::Schedule => {}
        }
        let source = self.session(&boundary.session_id).await?;
        if source.archived
            || source.configuration.workspace != boundary.workspace
            || source.configuration.permissions != boundary.permissions
            || source.configuration.boundary_revision != boundary.boundary_revision
            || source.configuration.binding != boundary.binding
        {
            return Err("scheduler_authorization_changed".into());
        }
        Ok(())
    }
    pub(super) async fn approve_schedule(&self, plan: &Plan) -> Result<Approval, String> {
        let (target, model, thinking) = match &plan.task.effect {
            ScheduledEffect::Reminder => return Ok(Approval::Reminder),
            ScheduledEffect::Session {
                target,
                model,
                thinking_level,
            }
            | ScheduledEffect::AgentRun {
                target,
                model,
                thinking_level,
            } => (target, model, thinking_level),
        };
        Ok(Approval::Execution {
            basis: Box::new(
                self.approve_background(target, model.clone(), *thinking, BackgroundKind::Schedule)
                    .await?,
            ),
        })
    }
    pub(in crate::owner) async fn approve_background(
        &self,
        target: &ScheduledTarget,
        model: ModelSelection,
        thinking: Option<ThinkingLevel>,
        kind: BackgroundKind,
    ) -> Result<MessageBasis, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Err("agent_closed".into());
        }
        let id = &target.session_id;
        if self.graph_selected(id).await? {
            return Err("graph_background_conflict".into());
        }
        let session = self.session(id).await?;
        if session.configuration.workspace != target.workspace
            || session.configuration.permissions != target.permissions
            || session.configuration.boundary_revision != target.boundary_revision
            || session.configuration.binding != target.binding
        {
            return Err("scheduler_authorization_changed".into());
        }
        if session.archived {
            return Err("agent_session_configuration_changed".into());
        }
        if session.configuration.collaboration_mode == CollaborationMode::Plan
            && !matches!(kind, BackgroundKind::Plan(_))
        {
            return Err("agent_planning_does_not_authorize_background_execution".into());
        }
        workspace::validate(
            &self.workspace_roots,
            &session.configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let (source, _) = crate::model::Source::select(
            self.configuration.clone(),
            self.catalog.clone(),
            self.credentials.clone(),
            model,
            thinking,
            id.clone(),
            self.revision.clone(),
        )
        .await
        .map_err(public_error)?;
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "agent_preferences_unavailable")?;
        let language = self.resolve_language(&snapshot);
        drop(runs);
        let mcp_revision = self
            .mcp_projects
            .capture(&session.configuration.workspace)
            .await?;
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let current = self.session(id).await?;
        if current.configuration != session.configuration || current.archived {
            return Err("scheduler_authorization_changed".into());
        }
        if self.graph_selected(id).await? {
            return Err("graph_background_conflict".into());
        }

        let selected_catalog = self.mcp_projects.catalog(mcp_revision.as_deref())?;
        let mut basis = MessageBasis {
            mcp_revision,
            language,
            compaction_prompt: Some(self.effective_compaction_prompt(
                session.configuration.compaction_prompt.as_deref(),
                &snapshot,
                language,
            )),
            graph: None,
            collaboration_mode: CollaborationMode::Agent,
            background_kind: kind,
            tool_discovery: self.settings.tool_discovery,
            allowed_tools: session.configuration.tools.clone(),
            background: Some(target.clone()),
            internal_tools: selected_catalog.definitions.clone(),
            internal_bindings: selected_catalog.bindings.clone(),
            behavior: self.bot_behavior(
                &target.session_id,
                self.capture_behavior(&session.configuration.workspace, &snapshot, language)
                    .await?,
                &snapshot,
                language,
            ),
            model: Some(source.accepted),
            executor: None,
            workspace: session.configuration.workspace,
            binding: session.configuration.binding,
            fingerprint: String::new(),
            tools: self.tool_basis.clone(),
        };
        self.prepare_plan_behavior(id, &mut basis).await?;
        Ok(basis)
    }
    pub(in crate::owner) fn start_schedules(self: &Arc<Self>) {
        if !self.settings.scheduled_tasks {
            return;
        }
        let owner = self.clone();
        self.producers.spawn(async move {
            let mut recover = true;
            let mut previous_error = None;
            let mut last_tick = now();
            loop {
                if owner.stop.is_cancelled() {
                    return;
                }
                let at = now();
                recover |= at.saturating_sub(last_tick) > 60_000;
                last_tick = at;
                let Some(producer) = owner.producer().await else {
                    return;
                };
                let delay = match owner.tick_schedules(recover).await {
                    Ok(delay) => {
                        recover = false;
                        previous_error = None;
                        delay
                    }
                    Err(error) => {
                        if previous_error.as_ref() != Some(&error) {
                            eprintln!("Scheduled tasks: {error}");
                        }
                        previous_error = Some(error);
                        Duration::from_secs(5)
                    }
                };
                drop(producer);
                tokio::select! {
                    () = owner.stop.cancelled() => return,
                    () = owner.scheduler.wake.notified() => {},
                    () = tokio::time::sleep(delay) => {},
                }
            }
        });
    }
    async fn tick_schedules(self: &Arc<Self>, recover: bool) -> Result<Duration, String> {
        let _gate = self.scheduler.gate.lock().await;
        let mut catalog = self.scheduler.load().await?;
        let mut delay = 30_000_i64;
        let mut dispatch_error = None;
        for id in catalog.plans.keys().cloned().collect::<Vec<_>>() {
            if self.stop.is_cancelled() {
                break;
            }
            let mut plan = catalog.plans[&id].plan.clone();
            let before = serde_json::to_value(&plan).map_err(reason)?;
            let at = now() as i64;
            if recover {
                plan.recover(at).map_err(reason)?;
            }
            if plan.authorization.is_some() {
                plan.claim(at).map_err(reason)?;
            }
            if serde_json::to_value(&plan).map_err(reason)? != before {
                self.scheduler
                    .commit(&mut catalog, &id, Some(plan.clone()), None)
                    .await?;
            }
            if let Some(fire) = plan.pending.clone() {
                // A reminder remains durable until the user acknowledges it.
                // No paint attempt or socket write is described as delivery.
                if !matches!(fire.effect, ScheduledEffect::Reminder) {
                    match self.dispatch_scheduled(&fire).await {
                        Ok(Some(run)) => {
                            plan.settle(run).map_err(reason)?;
                            self.scheduler
                                .commit(&mut catalog, &id, Some(plan.clone()), None)
                                .await?;
                        }
                        Ok(None) => delay = delay.min(1000),
                        Err(error) => {
                            // Keep this original fire for reconciliation without
                            // preventing independent tasks from making progress.
                            dispatch_error.get_or_insert(error);
                        }
                    }
                }
            } else if plan.task.status == Status::Active
                && let Some(next) = plan.task.next_fire_at
            {
                delay = delay.min(next.saturating_sub(at).max(100));
            }
        }
        if let Some(error) = dispatch_error {
            return Err(error);
        }
        Ok(Duration::from_millis(delay as u64))
    }
    async fn dispatch_scheduled(
        self: &Arc<Self>,
        fire: &maka_scheduler::plan::Fire<ScheduledEffect, Approval>,
    ) -> Result<Option<Run>, String> {
        let Some(Approval::Execution { basis }) = &fire.authorization else {
            return Ok(Some(settlement(
                fire,
                Outcome::Blocked,
                "Background approval unavailable",
                None,
                None,
            )));
        };
        let (source_session, new_session) = match &fire.effect {
            ScheduledEffect::Session { target, .. } => (&target.session_id, false),
            ScheduledEffect::AgentRun { target, .. } => (&target.session_id, true),
            ScheduledEffect::Reminder => unreachable!(),
        };
        let identity = hex::encode(Sha256::digest(fire.id.as_bytes()));
        let session_id = if new_session {
            format!("{}{}", self.prefix, &identity[..32])
        } else {
            source_session.clone()
        };
        let mut basis = (**basis).clone();
        basis.fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(fire).map_err(reason)?));
        let message: MessageInput = fire.intent.body().to_string().into();
        let delivered = RootSourceMessage {
            message: DeliveredMessage {
                origin: None,
                message_id: format!("m_{identity}"),
                submitted_content_digest: message.content_digest().map_err(reason)?,
                content: message.clone(),
            },
            unprepared_content: message,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        let admission = PendingMessageAdmission {
            execution: PendingExecution {
                owner: self.prefix.clone(),
                basis: serde_json::to_value(&basis).map_err(reason)?,
            },
            invocation: Invocation {
                session_id: session_id.clone(),
                turn_id: format!("t_{identity}"),
                run_id: format!("r_{identity}"),
                invocation_id: format!("i_{identity}"),
            },
            steering_invocation: None,
            source: delivered,
            required_tools: Default::default(),
            admitted_at: fire.scheduled_at as u64,
        };
        // Before preparing a new session, observe the original message. A revoked
        // approval cannot change the known result of an already admitted fire.
        let accepted = match self.store.session(&session_id).await {
            Ok(session) => {
                session
                    .root_message(&session_id, &admission.source.message.message_id)
                    .await
                    .map_err(reason)?
                    .is_some()
                    || session
                        .message_admission(&session_id, &admission.source.message.message_id)
                        .await
                        .map_err(reason)?
                        .is_some()
                    || session
                        .message_cancelled(&session_id, &admission.source.message.message_id)
                        .await
                        .map_err(reason)?
            }
            Err(maka_event_log::StoreError::SessionNotFound) => false,
            Err(error) => return Err(reason(error)),
        };
        if !accepted {
            if let Err(error) = self.validate_background(&basis).await {
                if matches!(
                    error.as_str(),
                    "scheduler_authorization_changed"
                        | "scheduler_disabled"
                        | "agent_session_unavailable"
                ) {
                    return Ok(Some(settlement(fire, Outcome::Blocked, &error, None, None)));
                }
                return Err(error);
            }
            if new_session {
                let boundary = basis
                    .background
                    .as_ref()
                    .ok_or("scheduler_approval_invalid")?;
                if self
                    .store
                    .get_session::<StoredSessionConfiguration>(&session_id)
                    .await
                    .map_err(reason)?
                    .is_none()
                {
                    let authority = self.session(&boundary.session_id).await?;
                    if authority.configuration.binding != boundary.binding {
                        return Err("scheduler_authorization_changed".into());
                    }
                    // Preserve the approved binding identity, including after two
                    // historical locations converge to the same selection.
                    let workspace = authority
                        .workspace_binding
                        .as_ref()
                        .ok_or("scheduler_authorization_changed")?
                        .reference();
                    self.store
                        .create_session(
                            &session_id,
                            &basis.fingerprint,
                            &StoredSessionConfiguration {
                                backend: None,
                                compaction_prompt: None,
                                collaboration_mode: CollaborationMode::Agent,
                                tools: basis.allowed_tools.clone(),
                                title: fire.title.clone(),
                                title_is_manual: true,
                                pinned: false,
                                labels: vec![],
                                workspace,
                                permissions: boundary.permissions.clone(),
                                boundary_revision: 0,
                            },
                            fire.scheduled_at as u64,
                        )
                        .await
                        .map_err(reason)?;
                }
            }
        }
        match self.admit_notification(&admission).await {
            Ok(true) => Ok(Some(settlement(
                fire,
                Outcome::Ok,
                "Message admitted",
                Some(session_id),
                Some(admission.invocation.run_id),
            ))),
            Ok(false) => Ok(None),
            Err(error)
                if matches!(
                    error.as_str(),
                    "scheduler_authorization_changed" | "scheduler_disabled"
                ) =>
            {
                Ok(Some(settlement(fire, Outcome::Blocked, &error, None, None)))
            }
            Err(error) => Err(error),
        }
    }
}
fn settlement(
    fire: &maka_scheduler::plan::Fire<ScheduledEffect, Approval>,
    outcome: Outcome,
    message: &str,
    session_id: Option<String>,
    run_id: Option<String>,
) -> Run {
    Run {
        id: fire.id.clone(),
        at: (now() as i64).max(fire.scheduled_at),
        outcome,
        message: message.to_owned(),
        session_id,
        run_id,
    }
}
