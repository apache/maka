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
use maka_agent_state::queue::MessageResolution;
impl CapturedRun {
    pub(in crate::owner) fn validate_background_target(
        &self,
        session: &SessionRecord<ResolvedConfiguration>,
    ) -> Result<(), String> {
        if let Some(boundary) = &self.background
            && (session.archived
                || session.configuration.workspace != boundary.workspace
                || session.configuration.permissions
                    != if super::super::discovery::legacy_tools(self.allowed_tools.as_deref()) {
                        super::super::discovery::permissions()
                    } else {
                        boundary.permissions.clone()
                    }
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
        basis: &CapturedRun,
    ) -> Result<(), String> {
        let Some(boundary) = &basis.background else {
            return Ok(());
        };
        if !match &basis.background_kind {
            BackgroundKind::Schedule { .. } => self.settings.scheduled_tasks,
            BackgroundKind::Goal(_) => self.settings.goals,
            BackgroundKind::Interactive => false,
        } {
            return Err(match &basis.background_kind {
                BackgroundKind::Schedule { .. } => "scheduler_disabled",
                BackgroundKind::Goal(_) => "goal_disabled",
                BackgroundKind::Interactive => "background_kind_invalid",
            }
            .into());
        }
        if let BackgroundKind::Goal(id) = &basis.background_kind {
            self.check_goal_background(&boundary.session_id, *id)
                .await?
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
            | ScheduledEffect::Discovery {
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
        if matches!(plan.task.effect, ScheduledEffect::Discovery { .. })
            && (!self.settings.bot || !self.bot.is(&target.session_id))
        {
            return Err("discovery_requires_bot".into());
        }
        let basis = self
            .approve_background(
                target,
                model.clone(),
                *thinking,
                BackgroundKind::Schedule {
                    task_id: plan.task.id.clone(),
                },
            )
            .await?;
        let approval = super::super::notifications::BackgroundApproval {
            target: target.clone(),
            model: model.clone(),
            accepted_model: basis.model.clone().ok_or("scheduler_model_unavailable")?,
            thinking_level: *thinking,
            language: basis.language,
        };
        Ok(
            if matches!(plan.task.effect, ScheduledEffect::Discovery { .. }) {
                Approval::Discovery {
                    approval,
                    recall: self.settings.recall && self.tools.contains("Recall"),
                    session_tools: true,
                    authority: DiscoveryAuthority::User {
                        generation: uuid::Uuid::new_v4(),
                    },
                }
            } else {
                Approval::Execution { approval }
            },
        )
    }

    pub(in crate::owner) async fn approve_background(
        &self,
        target: &ScheduledTarget,
        model: ModelSelection,
        thinking: Option<ThinkingLevel>,
        kind: BackgroundKind,
    ) -> Result<CapturedRun, String> {
        if self.runs.state().await.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let id = &target.session_id;
        let session = self.mutable_session(id).await?;
        if session.archived
            || session.configuration.workspace != target.workspace
            || session.configuration.permissions != target.permissions
            || session.configuration.boundary_revision != target.boundary_revision
            || session.configuration.binding != target.binding
        {
            return Err("scheduler_authorization_changed".into());
        }
        let native = self
            .services
            .request(
                maka_capabilities::call::Identity::Native,
                self.stop.child_token(),
            )
            .map_err(reason)?;
        let captured = self
            .capture_current_run(
                id,
                Some(BackendPreference::Model {
                    connection_id: model.connection_id,
                    model_id: model.model_id,
                    thinking_level: thinking,
                }),
                String::new(),
                native.scope(),
            )
            .await;
        let cleanup = native.finish().await;
        let mut basis = match (captured, cleanup) {
            (Ok(basis), Ok(())) => basis,
            (Err(error), Ok(())) => return Err(error.into()),
            (result, Err(cleanup)) => {
                return Err(format!(
                    "{}; background preparation cleanup: {cleanup}",
                    result.err().map(String::from).unwrap_or_default()
                ));
            }
        };
        let current = self.mutable_session(id).await?;
        if current.archived || current.configuration != session.configuration {
            return Err("scheduler_authorization_changed".into());
        }
        basis.background = Some(target.clone());
        basis.background_kind = kind;
        basis.collaboration_mode = CollaborationMode::Agent;
        Ok(basis)
    }
    pub(in crate::owner) async fn prepare_approved_background(
        &self,
        approval: &super::super::notifications::BackgroundApproval,
        kind: BackgroundKind,
    ) -> Result<CapturedRun, String> {
        let mut basis = self
            .approve_background(
                &approval.target,
                approval.model.clone(),
                approval.thinking_level,
                kind,
            )
            .await?;
        let current = basis.model.as_ref().ok_or("scheduler_model_unavailable")?;
        if !approval.accepted_model.same_execution_route(current) {
            return Err("background_model_route_changed".into());
        }
        basis.model = Some(approval.accepted_model.clone());
        super::super::capture_budget::check_approval(&basis, approval)?;
        Ok(basis)
    }
    pub(in crate::owner) fn start_schedules(self: &Arc<Self>) {
        if !self.settings.scheduled_tasks && self.scheduler.investigation.read().unwrap().is_none()
        {
            return;
        }
        let owner = self.clone();
        self.producers.spawn(async move {
            let mut changes = owner.store.subscribe_changes();
            let mut run_changes = match owner.durable.subscribe() {
                Ok(changes) => changes,
                Err(error) => { eprintln!("Scheduled tasks: {error}"); return; }
            };
            let mut recover = true;
            let mut previous_error = None;
            let mut planned_wake: Option<i64> = None;
            loop {
                if owner.stop.is_cancelled() {
                    return;
                }
                changes.borrow_and_update();
                run_changes.borrow_and_update();
                let at = now() as i64;
                recover |= planned_wake.is_some_and(|due| at.saturating_sub(due) > 60_000);
                let Some(producer) = owner.producer().await else {
                    return;
                };
                let (delay, error) = match owner.tick_schedules(recover).await {
                    Ok(result) => { recover = false; result },
                    Err(error) => (None, Some(error)),
                };
                if let Some(error) = &error
                    && previous_error.as_ref() != Some(error) { eprintln!("Scheduled tasks: {error}"); }
                previous_error = error;
                planned_wake = delay;
                drop(producer);
                tokio::select! {
                    () = owner.stop.cancelled() => return,
                    () = owner.scheduler.wake.notified() => {},
                    changed = changes.changed() => if changed.is_err() { return; },
                    changed = run_changes.changed() => if changed.is_err() { return; },
                    () = async {
                        if let Some(at) = delay {
                            tokio::time::sleep(Duration::from_millis((at as u64).saturating_sub(now()))).await;
                        } else { std::future::pending::<()>().await; }
                    } => {},
                }
            }
        });
    }
    async fn tick_schedules(
        self: &Arc<Self>,
        recover: bool,
    ) -> Result<(Option<i64>, Option<String>), String> {
        let _gate = self.scheduler.gate.lock().await;
        let mut catalog = self.scheduler.load_ready(now() as i64).await?;
        let mut dispatch_error = None;
        for id in catalog.plans.keys().cloned().collect::<Vec<_>>() {
            if self.stop.is_cancelled() {
                break;
            }
            let mut plan = catalog.plans[&id].plan.clone();
            if !self.settings.scheduled_tasks
                && !plan
                    .pending
                    .as_ref()
                    .is_some_and(|f| matches!(f.effect, ScheduledEffect::Discovery { .. }))
            {
                continue;
            }
            let before = serde_json::to_value(&plan).map_err(reason)?;
            let at = now() as i64;
            if let Some(grant) = plan
                .authorization
                .as_ref()
                .and_then(Approval::followup_grant)
                && !self.scheduler.followup_is_current(grant).await?
            {
                plan = pause_plan(&plan, at);
                plan.authorization = None;
            }
            if recover && self.settings.scheduled_tasks {
                plan.recover(at).map_err(reason)?;
            }
            if self.settings.scheduled_tasks && plan.authorization.is_some() {
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
                    match self.dispatch_scheduled(&fire, &plan).await {
                        Ok(Some(run)) => {
                            plan.settle(run).map_err(reason)?;
                            self.scheduler
                                .commit(&mut catalog, &id, Some(plan.clone()), None)
                                .await?;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            // Keep this original fire for reconciliation without
                            // preventing independent tasks from making progress.
                            dispatch_error.get_or_insert(error);
                        }
                    }
                }
            }
        }
        Ok((
            catalog
                .ready
                .due
                .range((
                    std::ops::Bound::Excluded(now() as i64),
                    std::ops::Bound::Unbounded,
                ))
                .next()
                .map(|(at, _)| *at),
            dispatch_error,
        ))
    }
    async fn dispatch_scheduled(
        self: &Arc<Self>,
        fire: &maka_scheduler::plan::Fire<ScheduledEffect, Approval>,
        plan: &Plan,
    ) -> Result<Option<Run>, String> {
        let active = plan.task.status == Status::Active;
        if matches!(fire.effect, ScheduledEffect::Discovery { .. }) {
            return self
                .dispatch_discovery(fire, active, &plan.timezone, plan.task.runs.first())
                .await;
        }
        let Some(Approval::Execution { approval }) = &fire.authorization else {
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
            ScheduledEffect::Reminder | ScheduledEffect::Discovery { .. } => unreachable!(),
        };
        let identity = hex::encode(Sha256::digest(fire.id.as_bytes()));
        let session_id = if new_session {
            format!("{}{}", self.prefix, &identity[..32])
        } else {
            source_session.clone()
        };
        let message_id = format!("m_{identity}");
        match self
            .durable
            .queue()
            .resolve_message(session_id.clone(), message_id.clone())
            .await
            .map_err(reason)?
        {
            MessageResolution::Delivered { run, shared: false } => {
                return Ok(Some(settlement(
                    fire,
                    Outcome::Ok,
                    "Message admitted",
                    Some(session_id),
                    Some(run),
                )));
            }
            MessageResolution::Delivered { run, shared: true } => {
                return Ok(Some(settlement(
                    fire,
                    Outcome::Blocked,
                    "Background message was delivered as steering without independent budget admission",
                    Some(session_id),
                    Some(run),
                )));
            }
            MessageResolution::Pending => return Ok(None),
            MessageResolution::Cancelled => {
                return Ok(Some(settlement(
                    fire,
                    Outcome::Blocked,
                    "Message cancelled",
                    Some(session_id),
                    None,
                )));
            }
            MessageResolution::Missing => {}
        }
        let mut basis = match self
            .prepare_approved_background(
                approval,
                BackgroundKind::Schedule {
                    task_id: fire.task_id.clone(),
                },
            )
            .await
        {
            Ok(basis) => basis,
            Err(error)
                if matches!(
                    error.as_str(),
                    "scheduler_authorization_changed"
                        | "background_model_route_changed"
                        | "scheduler_disabled"
                        | "agent_session_unavailable"
                ) =>
            {
                return Ok(Some(settlement(fire, Outcome::Blocked, &error, None, None)));
            }
            Err(error) => return Err(error),
        };
        self.validate_background(&basis).await?;
        if new_session
            && self
                .store
                .get_session::<StoredSessionConfiguration>(&session_id)
                .await
                .map_err(reason)?
                .is_none()
        {
            let authority = self.session(source_session).await?;
            let workspace = authority
                .workspace_binding
                .as_ref()
                .ok_or("scheduler_authorization_changed")?
                .reference();
            let fingerprint =
                hex::encode(Sha256::digest(serde_json::to_vec(fire).map_err(reason)?));
            self.store
                .create_session(
                    &session_id,
                    &fingerprint,
                    &StoredSessionConfiguration {
                        parent_session_id: Some(source_session.clone()),
                        backend: None,
                        compaction_prompt: None,
                        applied_preset: None,
                        collaboration_mode: CollaborationMode::Agent,
                        tools: basis.allowed_tools.clone(),
                        title: fire.title.clone(),
                        title_is_manual: true,
                        pinned: false,
                        labels: vec![],
                        workspace,
                        permissions: approval.target.permissions.clone(),
                        boundary_revision: 0,
                    },
                    fire.scheduled_at as u64,
                )
                .await
                .map_err(reason)?;
        }
        // Catalog ownership is recaptured for the actual target Session, never restored
        // by deserializing the approval or a previous live preparation.
        if new_session {
            let current = self.mutable_session(&session_id).await?;
            let native = self
                .services
                .request(
                    maka_capabilities::call::Identity::Native,
                    self.stop.child_token(),
                )
                .map_err(reason)?;
            let captured = async {
                let floor = self
                    .capture_sandbox(&current.configuration, native.scope().sandbox_floor())
                    .await?;
                self.mcp_projects.capture(&basis.workspace, &floor).await
            }
            .await;
            native.finish().await?;
            let selected = captured?;
            let selected = self.mcp_projects.with_client(&session_id, selected)?;
            basis.mcp_revision = selected.revision.clone();
            basis.client_mcp = selected.client_mcp;
            basis.mcp_catalog = Some(selected.clone());
            basis.internal_tools = selected.definitions.clone();
            basis.internal_bindings = selected.bindings.clone();
        }
        let message: MessageInput = fire.intent.body().to_string().into();
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin: None,
                message_id,
                submitted_content_digest: message.content_digest().map_err(reason)?,
                content: message.clone(),
            },
            unprepared_content: message,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        self.enqueue_background(
            &session_id,
            source,
            &basis,
            &identity,
            Default::default(),
            maka_agent_state::queue::Placement::Followup,
        )
        .await?;
        // A queued fire is not yet a Run. The next pass reads the atomic queue consume.
        Ok(None)
    }
}
fn settlement(
    fire: &maka_scheduler::plan::Fire<ScheduledEffect, Approval>,
    outcome: Outcome,
    message: &str,
    session_id: Option<String>,
    run_id: Option<maka_agent_facts::durable::RunId>,
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
