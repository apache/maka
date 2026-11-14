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
use futures_util::{StreamExt, stream::FuturesUnordered};
use maka_agent_facts::durable::{FactId, UnixMillis};
use maka_agent_state::queue::{MessageResolution, QueueCommand, QueueEdit, RequestId};
use tokio::time::Instant;

#[derive(Default)]
struct ScriptChecks {
    running: BTreeSet<String>,
    jobs: FuturesUnordered<BoxFuture<'static, scripts::Check>>,
    completed: Option<scripts::Check>,
}

impl ScriptChecks {
    fn start(
        &mut self,
        owner: &Arc<Owner>,
        id: String,
        revision: u64,
        source: String,
        approval: BackgroundGrant,
    ) {
        self.running.insert(id.clone());
        let check_owner = owner.clone();
        let job = owner
            .producers
            .spawn(async move { check_owner.check_automation(approval, source).await });
        self.jobs.push(Box::pin(async move {
            let result = match job.await {
                Ok(result) => result,
                Err(error) => Err(reason(error)),
            };
            scripts::Check {
                id,
                revision,
                result,
            }
        }));
    }
}
impl CapturedRun {
    fn is_discovery(&self) -> bool {
        self.allowed_tools
            .as_ref()
            .is_some_and(|t| t.iter().any(|n| n == super::super::discovery::COMPLETE))
    }
    pub(in crate::owner) fn validate_background_target(
        &self,
        session: &SessionRecord<ResolvedConfiguration>,
    ) -> Result<(), String> {
        if let Some(boundary) = &self.background
            && (session.archived
                || session.configuration.workspace != boundary.workspace
                || session.configuration.permissions
                    != if self.is_discovery() {
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
    pub(super) async fn approve_schedule(
        &self,
        plan: &Plan,
        sandbox_ceiling: Option<&maka_sandbox::Sandbox>,
    ) -> Result<Approval, String> {
        let (target, model, thinking) = match &plan.task.effect {
            ScheduledEffect::Session {
                target,
                model,
                thinking_level,
                ..
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
            ScheduledEffect::ExecutorSession { target, selection } => {
                let approval = ExecutorApproval {
                    language: self.native_language,
                    target: target.clone(),
                    selection: selection.clone(),
                    sandbox_ceiling: sandbox_ceiling.cloned(),
                };
                self.prepare_scheduled_background(
                    &BackgroundGrant::Executor(approval.clone()),
                    &plan.task.id,
                )
                .await?;
                return Ok(Approval::Execution {
                    approval: BackgroundGrant::Executor(approval),
                });
            }
        };
        if matches!(plan.task.effect, ScheduledEffect::Discovery { .. }) {
            if !self.settings.bot || !self.bot.is(&target.session_id) {
                return Err("discovery_requires_bot".into());
            }
            if matches!(plan.task.schedule, TaskSchedule::Script { .. }) {
                return Err("discovery_requires_time_schedule".into());
            }
        }
        let basis = self
            .approve_background(
                target,
                model.clone(),
                *thinking,
                BackgroundKind::Schedule {
                    task_id: plan.task.id.clone(),
                },
                sandbox_ceiling,
            )
            .await?;
        let approval = super::super::notifications::BackgroundApproval {
            target: target.clone(),
            model: model.clone(),
            accepted_model: basis.model.clone().ok_or("scheduler_model_unavailable")?,
            thinking_level: *thinking,
            language: basis.language,
            sandbox_ceiling: basis.background_sandbox_ceiling,
        };
        Ok(
            if matches!(plan.task.effect, ScheduledEffect::Discovery { .. }) {
                Approval::Discovery {
                    approval,
                    recall: self.settings.recall && self.tools.contains("Recall"),
                }
            } else {
                Approval::Execution {
                    approval: BackgroundGrant::Model(approval),
                }
            },
        )
    }

    pub(in crate::owner) async fn approve_background(
        &self,
        target: &ScheduledTarget,
        model: ModelSelection,
        thinking: Option<ThinkingLevel>,
        kind: BackgroundKind,
        sandbox_ceiling: Option<&maka_sandbox::Sandbox>,
    ) -> Result<CapturedRun, String> {
        self.capture_background_backend(
            target,
            BackendPreference::Model {
                connection_id: model.connection_id,
                model_id: model.model_id,
                thinking_level: thinking,
            },
            kind,
            sandbox_ceiling,
        )
        .await
    }
    async fn capture_background_backend(
        &self,
        target: &ScheduledTarget,
        backend: BackendPreference,
        kind: BackgroundKind,
        sandbox_ceiling: Option<&maka_sandbox::Sandbox>,
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
        let native = match sandbox_ceiling {
            Some(ceiling) => native.with_sandbox_floor(ceiling)?,
            None => native,
        };
        let captured = self
            .capture_current_run(id, Some(backend), String::new(), native.scope())
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
        basis.background_sandbox_ceiling = sandbox_ceiling.cloned();
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
                approval.sandbox_ceiling.as_ref(),
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
    pub(super) async fn prepare_scheduled_background(
        &self,
        approval: &BackgroundGrant,
        task_id: &str,
    ) -> Result<CapturedRun, String> {
        let kind = BackgroundKind::Schedule {
            task_id: task_id.into(),
        };
        self.prepare_background(approval, kind).await
    }
    pub(in crate::owner) async fn prepare_background(
        &self,
        approval: &BackgroundGrant,
        kind: BackgroundKind,
    ) -> Result<CapturedRun, String> {
        match approval {
            BackgroundGrant::Model(approval) => {
                self.prepare_approved_background(approval, kind).await
            }
            BackgroundGrant::Executor(approval) => {
                if approval.selection.executor != "external" {
                    return Err("scheduler_executor_unavailable".into());
                }
                let backend = BackendPreference::Executor {
                    selection: approval.selection.clone(),
                };
                self.capture_background_backend(
                    &approval.target,
                    backend,
                    kind,
                    approval.sandbox_ceiling.as_ref(),
                )
                .await
            }
        }
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
            let mut retries = BTreeMap::new();
            let mut storage_retry = None;
            let mut scripts = ScriptChecks::default();
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
                if storage_retry.is_none_or(|retry: Retry| retry.ready(Instant::now())) {
                    let error = match owner.tick_schedules(recover, &mut retries, &mut scripts).await {
                        Ok((next, error)) => {
                            planned_wake = next;
                            recover = false;
                            storage_retry = None;
                            error
                        }
                        Err(error) => {
                            storage_retry = Some(Retry::after_failure(storage_retry, Instant::now()));
                            Some(error)
                        }
                    };
                    if let Some(error) = &error
                        && previous_error.as_ref() != Some(error) { eprintln!("Scheduled tasks: {error}"); }
                    previous_error = error;
                }
                let retry_at = if let Some(retry) = storage_retry {
                    Some(retry.at)
                } else {
                    retries.values().map(|retry| retry.retry.at).min()
                };
                drop(producer);
                tokio::select! {
                    () = owner.stop.cancelled() => return,
                    () = owner.scheduler.wake.notified() => {},
                    checked = scripts.jobs.next(), if !scripts.jobs.is_empty() && scripts.completed.is_none() => {
                        scripts.completed = checked;
                    },
                    changed = changes.changed() => if changed.is_err() { return; },
                    changed = run_changes.changed() => if changed.is_err() { return; },
                    () = async {
                        if let Some(at) = planned_wake.filter(|_| storage_retry.is_none()) {
                            tokio::time::sleep(Duration::from_millis((at as u64).saturating_sub(now()))).await;
                        } else { std::future::pending::<()>().await; }
                    } => {},
                    () = async {
                        if let Some(at) = retry_at {
                            tokio::time::sleep_until(at).await;
                        } else { std::future::pending::<()>().await; }
                    } => {},
                }
            }
        });
    }
    async fn tick_schedules(
        self: &Arc<Self>,
        recover: bool,
        retries: &mut BTreeMap<String, FireRetry>,
        scripts: &mut ScriptChecks,
    ) -> Result<(Option<i64>, Option<String>), String> {
        let _gate = self.scheduler.gate.lock().await;
        let loaded_at = now() as i64;
        let mut catalog = self.scheduler.load_ready(loaded_at).await?;
        let mut dispatch_error = None;
        if let Some(checked) = &scripts.completed {
            if let Some(saved) = catalog.plans.get(&checked.id)
                && saved.revision == checked.revision
            {
                let mut plan = saved.plan.clone();
                plan.record_condition(loaded_at, checked.result.clone())
                    .map_err(reason)?;
                self.scheduler
                    .commit(&mut catalog, &checked.id, Some(plan), None)
                    .await?;
            }
            scripts.running.remove(&checked.id);
            scripts.completed = None;
        }
        for id in catalog.plans.keys().cloned().collect::<Vec<_>>() {
            if self.stop.is_cancelled() {
                break;
            }
            let saved = &catalog.plans[&id];
            let plan = &saved.plan;
            if !self.settings.scheduled_tasks
                && !plan
                    .pending
                    .as_ref()
                    .is_some_and(|f| matches!(f.effect, ScheduledEffect::Discovery { .. }))
            {
                continue;
            }
            let retry = plan
                .pending
                .as_ref()
                .and_then(|fire| retries.get(&id).and_then(|retry| retry.for_fire(&fire.id)));
            if retry.is_some_and(|retry| !retry.ready(Instant::now())) {
                continue;
            }
            if self.settings.scheduled_tasks
                && plan.task.status == Status::Active
                && plan.pending.is_none()
                && let TaskSchedule::Script { source, .. } = &plan.task.schedule
                && let Some(Approval::Execution { approval }) = &plan.authorization
                && plan.task.expires_at.is_none_or(|at| at > loaded_at)
                && plan.task.next_fire_at.is_some_and(|at| at <= loaded_at)
            {
                if !scripts.running.contains(&id) {
                    scripts.start(self, id, saved.revision, source.clone(), approval.clone());
                }
                continue;
            }
            let mut plan = plan.clone();
            let before = serde_json::to_value(&plan).map_err(reason)?;
            let at = now() as i64;
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
            let Some(fire) = plan.pending.as_ref() else {
                continue;
            };
            let expired = plan.task.expires_at.is_some_and(|expires| at >= expires);
            match self
                .dispatch_scheduled(fire, plan.task.status == Status::Active, expired)
                .await
            {
                Ok(Some(run)) => {
                    plan.settle(run).map_err(reason)?;
                    self.scheduler
                        .commit(&mut catalog, &id, Some(plan), None)
                        .await?;
                    retries.remove(&id);
                }
                Ok(None) => {
                    retries.remove(&id);
                }
                Err(error) => {
                    retries.insert(
                        id,
                        FireRetry {
                            fire_id: fire.id.clone(),
                            retry: Retry::after_failure(retry, Instant::now()),
                        },
                    );
                    dispatch_error.get_or_insert(error);
                }
            }
        }
        retries.retain(|id, _| catalog.ready.pending.contains(id));
        Ok((catalog.ready.next_after(loaded_at), dispatch_error))
    }
    async fn dispatch_scheduled(
        self: &Arc<Self>,
        fire: &maka_scheduler::plan::Fire<ScheduledEffect, Approval>,
        active: bool,
        expired: bool,
    ) -> Result<Option<Run>, String> {
        if matches!(fire.effect, ScheduledEffect::Discovery { .. }) {
            return self.dispatch_discovery(fire, active && !expired).await;
        }
        let Some(Approval::Execution { approval }) = &fire.authorization else {
            return Ok(Some(settlement(
                fire,
                Outcome::Blocked,
                "Automation execution configuration is unavailable",
                None,
                None,
            )));
        };
        let source_session = &fire.effect.target().session_id;
        let new_session = matches!(fire.effect, ScheduledEffect::AgentRun { .. });
        let steer = matches!(
            fire.effect,
            ScheduledEffect::Session {
                delivery: AutomationDelivery::Steering,
                ..
            }
        );
        let identity = hex::encode(Sha256::digest(fire.id.as_bytes()));
        let session_id = if new_session {
            format!("{}{}", self.prefix, &identity[..32])
        } else {
            source_session.clone()
        };
        let message_id = format!("m_{identity}");
        let queue = self.durable.queue();
        let blocked = |reason| {
            settlement(
                fire,
                Outcome::Blocked,
                reason,
                Some(session_id.clone()),
                None,
            )
        };
        match queue
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
                    Outcome::Ok,
                    "Message delivered as steering",
                    Some(session_id),
                    Some(run),
                )));
            }
            MessageResolution::Pending if expired => {
                let _ordered = self.runs.ordered(&session_id).await;
                let current = queue.read(session_id.clone()).await.map_err(reason)?;
                let request = RequestId(identity.clone());
                if current
                    .entries
                    .iter()
                    .any(|entry| entry.request.id == request)
                {
                    queue
                        .execute(
                            session_id.clone(),
                            QueueCommand {
                                id: FactId::try_from(Uuid::new_v4()).map_err(reason)?,
                                at: UnixMillis(now() as i64),
                                expected_revision: current.revision,
                                edit: QueueEdit::Retract { request },
                            },
                            vec![],
                        )
                        .await
                        .map_err(reason)?;
                    return Ok(Some(blocked("Automation expired before delivery")));
                }
                // Delivery may have won the race. Reconcile the actual outcome.
                return Ok(None);
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
            MessageResolution::Missing if expired => {
                return Ok(Some(blocked("Automation expired before delivery")));
            }
            MessageResolution::Missing => {}
        }
        let mut basis = match self
            .prepare_scheduled_background(approval, &fire.task_id)
            .await
        {
            Ok(basis) => basis,
            Err(error)
                if matches!(
                    error.as_str(),
                    "scheduler_authorization_changed"
                        | "background_model_route_changed"
                        | "scheduler_disabled"
                        | "scheduler_executor_unavailable"
                        | "agent_executor_unavailable"
                        | "agent_executor_runtime_required"
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
                        permissions: approval.target().permissions.clone(),
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
            let native = match &basis.background_sandbox_ceiling {
                Some(ceiling) => native.with_sandbox_floor(ceiling)?,
                None => native,
            };
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
                origin: Some(MessageOrigin::Automation {
                    automation_id: fire.task_id.clone(),
                    title: fire.title.clone(),
                }),
                message_id,
                submitted_content_digest: message.content_digest().map_err(reason)?,
                content: message.clone(),
            },
            unprepared_content: message,
            submitted_placement: if steer {
                Placement::CurrentTurn
            } else {
                Placement::NextTurn
            },
            disposition: if steer {
                MessageDisposition::TurnStarted
            } else {
                MessageDisposition::Followup
            },
            submitted_intent: None,
        };
        self.enqueue_background(
            &session_id,
            source,
            &basis,
            &identity,
            Default::default(),
            maka_agent_state::queue::Placement::Followup,
            steer,
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

struct FireRetry {
    fire_id: String,
    retry: Retry,
}

impl FireRetry {
    fn for_fire(&self, id: &str) -> Option<Retry> {
        (self.fire_id == id).then_some(self.retry)
    }
}

#[derive(Clone, Copy)]
struct Retry {
    at: Instant,
    delay: Duration,
}

impl Retry {
    fn ready(self, now: Instant) -> bool {
        self.at <= now
    }

    fn after_failure(previous: Option<Self>, now: Instant) -> Self {
        let delay = previous.map_or(Duration::from_secs(1), |retry| {
            (retry.delay * 2).min(Duration::from_secs(30))
        });
        Self {
            at: now + delay,
            delay,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_wakes_leave_only_the_failed_fire_waiting() {
        let now = Instant::now();
        let failure = FireRetry {
            fire_id: "failed".into(),
            retry: Retry::after_failure(None, now),
        };
        for elapsed in [0, 250, 999, 1_000] {
            let at = now + Duration::from_millis(elapsed);
            let may_dispatch = |id| failure.for_fire(id).is_none_or(|retry| retry.ready(at));
            assert!(may_dispatch("independent"));
            assert_eq!(may_dispatch("failed"), elapsed == 1_000);
        }
        let retry = Retry::after_failure(Some(failure.retry), failure.retry.at);
        assert!(!retry.ready(now + Duration::from_millis(2_999)));
        assert!(retry.ready(now + Duration::from_secs(3)));
    }
}
