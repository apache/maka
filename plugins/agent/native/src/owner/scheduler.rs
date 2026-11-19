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

//! Task timing owns durable plans; Agent remains the only execution owner.
mod dispatch;
mod repository;
mod scripts;
mod tools;
use super::*;
use maka_host_runtime::storage::Storage;
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::Store;
use maka_scheduler::{
    plan::{PauseSource, TaskPlan},
    task::{Creator, Outcome, Run, Status},
};
use repository::Saved;
use std::sync::{OnceLock, Weak};
use tokio::sync::Notify;
type Plan = TaskPlan<ScheduledEffect, Approval>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[expect(
    clippy::large_enum_variant,
    reason = "Scheduler approval transfers its original record inline without an allocation per observation"
)]
pub(in crate::owner) enum Approval {
    Execution {
        approval: BackgroundGrant,
    },
    Discovery {
        approval: super::notifications::BackgroundApproval,
        tools: DiscoveryToolGrant,
        authority: DiscoveryAuthority,
    },
    CancelledDiscovery {
        approval: super::notifications::BackgroundApproval,
        tools: DiscoveryToolGrant,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::owner) struct DiscoveryToolGrant {
    pub(super) profile: DiscoveryWorkerTools,
    pub(super) names: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::owner) enum DiscoveryAuthority {
    User { generation: uuid::Uuid },
    Followup { grant: FollowupGrant },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::owner) struct FollowupGrant {
    task_id: String,
    generation: uuid::Uuid,
}

impl FollowupGrant {
    fn is_current(&self, plan: &Plan, at: i64) -> bool {
        plan.task.status == Status::Active
            && plan.task.expires_at.is_none_or(|expires| at < expires)
            && matches!(
                &plan.authorization,
                Some(Approval::Discovery {
                    authority: DiscoveryAuthority::User { generation },
                    ..
                }) if *generation == self.generation
            )
    }
}

impl Approval {
    pub(in crate::owner) fn discovery_generation(&self) -> Option<uuid::Uuid> {
        match self {
            Self::Discovery {
                authority: DiscoveryAuthority::User { generation },
                ..
            } => Some(*generation),
            _ => None,
        }
    }

    fn sandbox_ceiling(&self) -> Option<&maka_sandbox::Sandbox> {
        match self {
            Self::Execution { approval } => approval.sandbox_ceiling(),
            Self::Discovery { approval, .. } | Self::CancelledDiscovery { approval, .. } => {
                approval.sandbox_ceiling.as_ref()
            }
        }
    }

    pub(in crate::owner) fn followup_grant(&self) -> Option<&FollowupGrant> {
        match self {
            Self::Discovery {
                authority: DiscoveryAuthority::Followup { grant },
                ..
            } => Some(grant),
            _ => None,
        }
    }
}

fn pause_plan(plan: &Plan, at: i64, source: Option<PauseSource>) -> Plan {
    let mut paused = plan.pause(at);
    if matches!(paused.task.effect, ScheduledEffect::Discovery { .. })
        && paused.task.status == Status::Paused
        && (plan.task.status == Status::Active || source == Some(PauseSource::User))
    {
        paused.pause_source = source;
    }
    if plan.task.status == Status::Active
        && let Some(Approval::Discovery {
            authority: DiscoveryAuthority::User { generation },
            ..
        }) = &mut paused.authorization
    {
        // A later resume must not restore any follow-ups from the old approval.
        *generation = uuid::Uuid::new_v4();
    }
    if let Some(fire) = &mut paused.pending
        && matches!(fire.effect, ScheduledEffect::Discovery { .. })
    {
        fire.authorization = fire.authorization.take().map(|a| match a {
            Approval::Discovery {
                approval, tools, ..
            } => Approval::CancelledDiscovery { approval, tools },
            other => other,
        });
    }
    paused
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
#[expect(
    clippy::large_enum_variant,
    reason = "Schedule records store their backend inline"
)]
pub(super) enum BackgroundGrant {
    Model(super::notifications::BackgroundApproval),
    Executor(ExecutorApproval),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExecutorApproval {
    pub(super) language: Language,
    pub(super) target: ScheduledTarget,
    pub(super) selection: maka_agent_facts::executor::Selection,
    pub(super) sandbox_ceiling: Option<maka_sandbox::Sandbox>,
}

impl BackgroundGrant {
    pub(super) fn target(&self) -> &ScheduledTarget {
        match self {
            Self::Model(approval) => &approval.target,
            Self::Executor(approval) => &approval.target,
        }
    }

    pub(super) fn language(&self) -> Language {
        match self {
            Self::Model(approval) => approval.language,
            Self::Executor(approval) => approval.language,
        }
    }

    pub(super) fn same_route(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Model(left), Self::Model(right)) => {
                left.model == right.model
                    && left
                        .accepted_model
                        .same_execution_route(&right.accepted_model)
            }
            (Self::Executor(left), Self::Executor(right)) => left.selection == right.selection,
            _ => false,
        }
    }

    fn sandbox_ceiling(&self) -> Option<&maka_sandbox::Sandbox> {
        match self {
            Self::Model(approval) => approval.sandbox_ceiling.as_ref(),
            Self::Executor(approval) => approval.sandbox_ceiling.as_ref(),
        }
    }
}

pub(super) struct ActiveInvestigation {
    pub(super) worker: String,
    pub(super) profile: DiscoveryWorkerTools,
}

pub(crate) struct Scheduler {
    pub(super) storage: Arc<Storage>,
    pub(in crate::owner) gate: Arc<Mutex<()>>,
    pub(super) wake: Notify,
    changed: tokio::sync::watch::Sender<u64>,
    pub(super) link: OnceLock<Weak<Owner>>,
    pub(super) investigation: std::sync::RwLock<Option<ActiveInvestigation>>,
}
impl Scheduler {
    pub(in crate::owner) async fn followup_is_current(
        &self,
        grant: &FollowupGrant,
    ) -> Result<bool, String> {
        Ok(self
            .change_basis(&grant.task_id)
            .await?
            .is_some_and(|saved| grant.is_current(&saved.plan, now() as i64)))
    }

    pub(super) fn notify_status_changed(&self) {
        self.changed.send_modify(|_| {});
    }
    pub fn new(store: Arc<RootStore>, prefix: String) -> Self {
        Self {
            storage: Arc::new(Storage::new(
                store,
                prefix,
                Namespace::new(
                    "maka.agent.scheduler",
                    maka_plugin_core::scope::Scope::Profile,
                )
                .expect("scheduler namespace"),
            )),
            gate: Arc::new(Mutex::new(())),
            wake: Notify::new(),
            changed: tokio::sync::watch::channel(0).0,
            link: OnceLock::new(),
            investigation: std::sync::RwLock::new(None),
        }
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.link
            .set(Arc::downgrade(owner))
            .expect("scheduler bound once");
    }
    pub(super) fn investigation_profile(&self, session: &str) -> Option<DiscoveryWorkerTools> {
        self.investigation
            .read()
            .unwrap()
            .as_ref()
            .filter(|active| active.worker == session)
            .map(|active| active.profile)
    }
    pub fn execution_changed(&self) {
        self.wake.notify_one();
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
}
impl Owner {
    fn discovery_tool_groups(&self, names: &[String]) -> DiscoveryToolSelection {
        names
            .iter()
            .filter(|name| name.as_str() != super::discovery::COMPLETE)
            .map(|name| (name.clone(), self.discovery_tool_group(name)))
            .collect()
    }

    pub fn schedule_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.scheduler.changed.subscribe()
    }
    pub async fn schedules(&self, input: ScheduleRead) -> Result<Schedules, String> {
        let scheduler = &self.scheduler;
        if let ScheduleRead::PreviewDiscovery { effect, task_id } = input {
            let ScheduledEffect::Discovery {
                target,
                model,
                thinking_level,
                worker_tools,
                ..
            } = effect
            else {
                return Err("scheduler_discovery_plan_required".into());
            };
            if !self.settings.bot
                || !self.settings.scheduled_tasks
                || !self.bot.is(&target.session_id)
            {
                return Err("discovery_requires_bot".into());
            }
            let saved = match &task_id {
                Some(id) => scheduler.change_basis(id).await?,
                None => None,
            };
            let floor = saved
                .as_ref()
                .and_then(|saved| saved.plan.authorization.as_ref())
                .and_then(Approval::sandbox_ceiling);
            let basis = self
                .approve_background(
                    &target,
                    model,
                    thinking_level,
                    BackgroundKind::Schedule {
                        task_id: task_id.unwrap_or_default(),
                    },
                    floor,
                )
                .await?;
            let tools = self
                .discovery_tool_grant(&basis, &target, worker_tools, None)
                .await?;
            let groups = self.discovery_tool_groups(&tools.names);
            let approved_names = saved.and_then(|saved| match saved.plan.authorization {
                Some(Approval::Discovery {
                    approval, tools, ..
                }) if approval.target.session_id == target.session_id
                    && tools.profile == worker_tools =>
                {
                    Some(tools.names)
                }
                _ => None,
            });
            return Ok(Schedules::DiscoveryTools {
                names: tools.names,
                groups,
                approved_names,
            });
        }
        let _gate = scheduler.gate.lock().await;
        let catalog = scheduler.load().await?;
        let discovery_session = match &input {
            ScheduleRead::Discovery { session_id, .. } => {
                self.session(session_id).await?;
                Some(session_id.clone())
            }
            _ => None,
        };
        match input {
            ScheduleRead::PreviewDiscovery { .. } => {
                unreachable!("handled before acquiring the schedule lock")
            }
            ScheduleRead::List {
                cursor,
                expected_revision,
            }
            | ScheduleRead::Discovery {
                cursor,
                expected_revision,
                ..
            } => {
                let revision = catalog.revision.unwrap_or(0);
                if expected_revision.is_some_and(|expected| expected != revision) {
                    return Ok(Schedules::Changed { revision });
                }
                if cursor.is_some() && expected_revision.is_none() {
                    return Err("scheduler_cursor_invalid".into());
                }
                let mut tasks = Vec::new();
                let mut next_cursor = None;
                for (id, saved) in &catalog.plans {
                    let matches_view = match &saved.plan.task.effect {
                        ScheduledEffect::Discovery { target, .. } => {
                            discovery_session.as_ref() == Some(&target.session_id)
                        }
                        _ => discovery_session.is_none(),
                    };
                    if !matches_view {
                        continue;
                    }
                    if cursor.as_ref().is_some_and(|after| id <= after) {
                        continue;
                    }
                    if tasks.len() == 20 {
                        next_cursor = tasks.last().map(|row: &ScheduledSummary| row.id.clone());
                        break;
                    }
                    tasks.push(saved.summary());
                }
                Ok(Schedules::Page {
                    revision,
                    tasks,
                    next_cursor,
                })
            }
            ScheduleRead::Get { task_id } => {
                let mut detail = catalog
                    .plans
                    .get(&task_id)
                    .map(|saved| Box::new(saved.detail()));
                if let Some(detail) = &mut detail {
                    detail.investigation = self.scheduler.discovery_status(&task_id).await?;
                }
                Ok(Schedules::Task { detail })
            }
        }
    }
    pub async fn schedule_change(
        self: &Arc<Self>,
        input: ScheduleChange,
        operation: maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<ScheduleResult>, String> {
        if scope.identity.agent().is_some() {
            return Err("scheduler_use_tool".into());
        }
        if !self.settings.scheduled_tasks {
            return Err("scheduler_disabled".into());
        }
        {
            let runs = self.runs.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return Err("agent_closed".into());
            }
        }
        let owner = self.clone();
        let job = self.workers.spawn(async move {
            let id = match &input {
                ScheduleChange::Create { .. } => format!("task-{}", owner.operation_id(&operation)),
                ScheduleChange::Update { task_id, .. }
                | ScheduleChange::Approve { task_id, .. }
                | ScheduleChange::Pause { task_id, .. }
                | ScheduleChange::Resume { task_id, .. }
                | ScheduleChange::TriggerNow { task_id, .. }
                | ScheduleChange::ClearHistory { task_id, .. }
                | ScheduleChange::Delete { task_id, .. } => task_id.clone(),
            };
            let writer = owner.store.data_writer().map_err(reason)?;
            let approval = if needs_approval(&input) {
                let saved = owner.scheduler.change_basis(&id).await?;
                match schedule_candidate(&id, &input, saved.as_ref(), now() as i64) {
                    Ok(Some(plan)) => owner
                        .capture_schedule_approval(&plan, saved.as_ref(), &input, &writer)
                        .await
                        .map(Some),
                    Ok(None) => Err("scheduler_approval_missing".into()),
                    Err(error) => Err(error),
                }
            } else {
                Ok(None)
            };
            let gate = Arc::new(owner.scheduler.gate.clone().lock_owned().await);
            let change = writer
                .prepare_result(|writer| {
                    Ok(repository::ScheduleMutation {
                        scheduler: owner.scheduler.clone(),
                        gate,
                        writer,
                        input,
                        id,
                        approval,
                    })
                })
                .map_err(reason)?;
            Ok(NativeMutation::Computed { change })
        });
        job.await
            .map_err(|_| "scheduler_operation_unknown".to_string())?
    }
    async fn capture_schedule_approval(
        &self,
        plan: &Plan,
        saved: Option<&Saved>,
        change: &ScheduleChange,
        writer: &maka_event_log::root_store::DataWriter,
    ) -> Result<PreparedBackgroundGrant, String> {
        let previous = saved.and_then(|saved| saved.plan.authorization.as_ref());
        let sandbox_ceiling = previous.and_then(Approval::sandbox_ceiling);
        let expected_tools = match change {
            ScheduleChange::Create { input }
            | ScheduleChange::Update { input, .. }
            | ScheduleChange::Approve {
                input: Some(input), ..
            } => input.approved_tools.as_deref(),
            _ => None,
        };
        let is_discovery = matches!(plan.task.effect, ScheduledEffect::Discovery { .. });
        if is_discovery && matches!(plan.task.schedule, TaskSchedule::Script { .. }) {
            return Err("discovery_requires_time_schedule".into());
        }
        let retain = is_discovery
            && !matches!(change, ScheduleChange::Approve { input: Some(_), .. })
            && saved.is_some_and(|saved| saved.plan.task.effect == plan.task.effect)
            && expected_tools.is_none_or(|names| {
                matches!(previous, Some(Approval::Discovery { tools, .. }) if tools.names == names)
            });
        let authorization = if let Some(previous @ Approval::Discovery { approval, .. }) =
            previous.filter(|_| retain)
        {
            if let Some(grant) = previous.followup_grant()
                && !self.scheduler.followup_is_current(grant).await?
            {
                return Err("scheduler_user_approval_required".into());
            }
            self.prepare_approved_background(
                approval,
                BackgroundKind::Schedule {
                    task_id: plan.task.id.clone(),
                },
            )
            .await?;
            previous.clone()
        } else {
            if is_discovery && matches!(change, ScheduleChange::Resume { .. }) {
                return Err("scheduler_user_approval_required".into());
            }
            let authorized = self.approve_schedule(plan, sandbox_ceiling).await?;
            if let Approval::Discovery { tools, .. } = &authorized {
                match expected_tools {
                    Some(expected) if expected != tools.names.as_slice() => {
                        return Err("scheduler_discovery_tools_changed".into());
                    }
                    None if tools.profile == DiscoveryWorkerTools::Session
                        || plan.task.effect.selected_discovery_tools().is_some() =>
                    {
                        return Err("scheduler_discovery_tools_confirmation_required".into());
                    }
                    _ => {}
                }
            }
            authorized
        };
        let target = match &authorization {
            Approval::Execution { approval } => approval.target(),
            Approval::Discovery { approval, .. }
            | Approval::CancelledDiscovery { approval, .. } => &approval.target,
        };
        let current = self.mutable_session(&target.session_id).await?;
        if current.archived
            || current.configuration.workspace != target.workspace
            || current.configuration.permissions != target.permissions
            || current.configuration.boundary_revision != target.boundary_revision
            || current.configuration.binding != target.binding
        {
            return Err("scheduler_authorization_changed".into());
        }
        let metadata = Some(
            self.store
                .session(&target.session_id)
                .await
                .map_err(reason)?
                .revision_guard(writer, current.revision)
                .map_err(reason)?,
        );
        Ok(PreparedBackgroundGrant {
            authorization,
            metadata,
            effect: plan.task.effect.clone(),
        })
    }
}

struct PreparedBackgroundGrant {
    authorization: Approval,
    metadata: Option<maka_event_log::root_store::SessionRevisionGuard>,
    effect: ScheduledEffect,
}
fn expected_revision(input: &ScheduleChange) -> Option<u64> {
    match input {
        ScheduleChange::Create { .. } => None,
        ScheduleChange::Update { revision, .. }
        | ScheduleChange::Approve { revision, .. }
        | ScheduleChange::Pause { revision, .. }
        | ScheduleChange::Resume { revision, .. }
        | ScheduleChange::TriggerNow { revision, .. }
        | ScheduleChange::ClearHistory { revision, .. }
        | ScheduleChange::Delete { revision, .. } => Some(*revision),
    }
}
fn needs_approval(input: &ScheduleChange) -> bool {
    matches!(
        input,
        ScheduleChange::Create { .. }
            | ScheduleChange::Update { .. }
            | ScheduleChange::Approve { .. }
            | ScheduleChange::Resume { .. }
    )
}
fn schedule_candidate(
    id: &str,
    input: &ScheduleChange,
    saved: Option<&Saved>,
    at: i64,
) -> Result<Option<Plan>, String> {
    let plan = || {
        saved
            .map(|saved| &saved.plan)
            .ok_or_else(|| "scheduler_task_missing".to_string())
    };
    let candidate = match input {
        ScheduleChange::Create { input } => {
            let mut plan = Plan::create(
                id.into(),
                input.task.clone(),
                Creator::User,
                input.timezone.clone(),
                at,
            )
            .map_err(reason)?;
            plan.misfire = input.misfire;
            plan
        }
        ScheduleChange::Update { input, .. } => update_schedule(plan()?, input, at)?,
        ScheduleChange::Approve { input, .. } => {
            let current = plan()?;
            let mut next = if let Some(input) = input {
                if !matches!((&current.task.effect, &input.task.effect),
                    (ScheduledEffect::Discovery { target: old, .. }, ScheduledEffect::Discovery { target: new, .. })
                    if old.session_id == new.session_id)
                {
                    return Err("scheduler_discovery_plan_required".into());
                }
                update_schedule(current, input, at)?
            } else {
                current.clone()
            };
            if next.pending.is_some() {
                return Err("scheduler_trigger_pending".into());
            }
            if !matches!(next.task.status, Status::Active | Status::Paused) {
                return Err("scheduler_task_terminal".into());
            }
            if next.task.status == Status::Paused {
                next = next.resume(at).map_err(reason)?;
            }
            if next.task.last_error.as_deref() == Some("scheduler_authorization_changed") {
                next.task.last_error = None;
            }
            next
        }
        ScheduleChange::Pause { .. } => pause_plan(plan()?, at, Some(PauseSource::User)),
        ScheduleChange::Resume { .. } => plan()?.resume(at).map_err(reason)?,
        ScheduleChange::TriggerNow { .. } => {
            let mut next = plan()?.clone();
            if next.task.status != Status::Active || next.pending.is_some() {
                return Err("scheduler_task_not_ready".into());
            }
            if next.authorization.is_none() {
                return Err("scheduler_execution_unavailable".into());
            }
            next.task.next_fire_at = Some(at);
            next.claim(at).map_err(reason)?;
            next
        }
        ScheduleChange::ClearHistory { .. } => plan()?.clear_history(at),
        ScheduleChange::Delete { .. } => {
            if plan()?.pending.is_some() {
                return Err("scheduler_trigger_pending".into());
            }
            return Ok(None);
        }
    };
    candidate.validate().map_err(reason)?;
    Ok(Some(candidate))
}
fn update_schedule(current: &Plan, input: &ScheduledInput, at: i64) -> Result<Plan, String> {
    if current.pending.is_some() {
        return Err("scheduler_trigger_pending".into());
    }
    let mut base = current.clone();
    base.timezone = input.timezone.clone();
    base.misfire = input.misfire;

    base.update(
        maka_scheduler::command::Update {
            title: Some(input.task.title.clone()),
            intent_body: Some(input.task.intent_body.clone()),
            schedule: (current.task.schedule != input.task.schedule
                || current.timezone != input.timezone)
                .then(|| input.task.schedule.clone()),
            effect: Some(input.task.effect.clone()),
            max_fires: input.task.max_fires.map_or(
                maka_agent_facts::configuration::Patch::Clear,
                maka_agent_facts::configuration::Patch::Set,
            ),
            expires_at: input.task.expires_at.map_or(
                maka_agent_facts::configuration::Patch::Clear,
                maka_agent_facts::configuration::Patch::Set,
            ),
        },
        at,
    )
    .map_err(reason)
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
