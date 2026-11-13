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
#[cfg(test)]
mod storage_fault;
mod tools;
use super::*;
#[cfg(not(test))]
use maka_host_runtime::storage::Storage;
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::Store;
use maka_scheduler::{
    plan::TaskPlan,
    task::{Creator, Outcome, Run, Status},
};
use repository::Saved;
use std::sync::{OnceLock, Weak};
#[cfg(test)]
use storage_fault::Storage;
use tokio::sync::Notify;
type Plan = TaskPlan<ScheduledEffect, Approval>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[expect(
    clippy::large_enum_variant,
    reason = "Scheduler approval transfers its original record inline without an allocation per observation"
)]
pub(in crate::owner) enum Approval {
    Reminder,
    Execution {
        approval: super::notifications::BackgroundApproval,
    },
    Discovery {
        approval: super::notifications::BackgroundApproval,
        recall: bool,
        // Existing approvals covered only the original read-only tool set.
        #[serde(default)]
        session_tools: bool,
        #[serde(default)]
        authority: DiscoveryAuthority,
    },
    CancelledDiscovery {
        approval: super::notifications::BackgroundApproval,
        recall: bool,
        #[serde(default)]
        session_tools: bool,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::owner) enum DiscoveryAuthority {
    User { generation: uuid::Uuid },
    Followup { grant: FollowupGrant },
}

impl Default for DiscoveryAuthority {
    fn default() -> Self {
        // Plans approved before follow-ups were supported keep their approval.
        Self::User {
            generation: uuid::Uuid::nil(),
        }
    }
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

fn pause_plan(plan: &Plan, at: i64) -> Plan {
    let mut paused = plan.pause(at);
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
                approval,
                recall,
                session_tools,
                ..
            } => Approval::CancelledDiscovery {
                approval,
                recall,
                session_tools,
            },
            other => other,
        });
    }
    paused
}
pub(crate) struct Scheduler {
    pub(super) storage: Arc<Storage>,
    pub(in crate::owner) gate: Arc<Mutex<()>>,
    pub(super) wake: Notify,
    changed: tokio::sync::watch::Sender<u64>,
    pub(super) link: OnceLock<Weak<Owner>>,
    pub(super) investigation: std::sync::RwLock<Option<String>>,
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
    pub fn execution_changed(&self) {
        self.wake.notify_one();
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
}
impl Owner {
    pub fn schedule_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.scheduler.changed.subscribe()
    }
    pub async fn schedule_alerts(&self) -> Result<ScheduleAlerts, String> {
        let _gate = self.scheduler.gate.lock().await;
        let catalog = self.scheduler.load().await?;
        let mut reminders = Vec::new();
        let mut pending = 0;
        for saved in catalog.plans.values() {
            if let Some(fire) = &saved.plan.pending
                && matches!(fire.effect, ScheduledEffect::Reminder)
            {
                pending += 1;
                if reminders.len() < 8 {
                    reminders.push(ScheduledReminder {
                        task_id: fire.task_id.clone(),
                        fire_id: fire.id.clone(),
                        title: fire.title.clone(),
                        body: fire.intent.body().chars().take(512).collect(),
                    });
                }
            }
        }
        Ok(ScheduleAlerts { pending, reminders })
    }
    pub async fn schedules(&self, input: ScheduleRead) -> Result<Schedules, String> {
        let scheduler = &self.scheduler;
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
                    if discovery_session.as_ref().is_some_and(|session| !matches!(
                        &saved.plan.task.effect, ScheduledEffect::Discovery { target, .. } if &target.session_id == session
                    )) { continue; }
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
            return Err("scheduler_user_approval_required".into());
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
                | ScheduleChange::Snooze { task_id, .. }
                | ScheduleChange::Acknowledge { task_id, .. }
                | ScheduleChange::ClearHistory { task_id, .. }
                | ScheduleChange::Delete { task_id, .. } => task_id.clone(),
            };
            let writer = owner.store.data_writer().map_err(reason)?;
            let approval = if needs_approval(&input) {
                let saved = owner.scheduler.change_basis(&id).await?;
                match schedule_candidate(&id, &input, saved.as_ref(), now() as i64) {
                    Ok(Some(plan)) => owner
                        .capture_schedule_approval(&plan, &writer)
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
        writer: &maka_event_log::root_store::DataWriter,
    ) -> Result<PreparedScheduleApproval, String> {
        let authorization = self.approve_schedule(plan).await?;
        let metadata = match &authorization {
            Approval::Reminder => None,
            Approval::Execution { approval }
            | Approval::Discovery { approval, .. }
            | Approval::CancelledDiscovery { approval, .. } => {
                let target = &approval.target;
                let current = self.mutable_session(&target.session_id).await?;
                if current.archived
                    || current.configuration.workspace != target.workspace
                    || current.configuration.permissions != target.permissions
                    || current.configuration.boundary_revision != target.boundary_revision
                    || current.configuration.binding != target.binding
                {
                    return Err("scheduler_authorization_changed".into());
                }
                Some(
                    self.store
                        .session(&target.session_id)
                        .await
                        .map_err(reason)?
                        .revision_guard(writer, current.revision)
                        .map_err(reason)?,
                )
            }
        };
        Ok(PreparedScheduleApproval {
            authorization,
            metadata,
            effect: plan.task.effect.clone(),
        })
    }
}

struct PreparedScheduleApproval {
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
        | ScheduleChange::Snooze { revision, .. }
        | ScheduleChange::Acknowledge { revision, .. }
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
        ScheduleChange::Update { input, .. } => {
            let current = plan()?;
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
                    schedule: Some(input.task.schedule.clone()),
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
            .map_err(reason)?
        }
        ScheduleChange::Approve { .. } => {
            let mut next = plan()?.clone();
            if next.pending.is_some() {
                return Err("scheduler_trigger_pending".into());
            }
            if !matches!(next.task.status, Status::Active | Status::Paused) {
                return Err("scheduler_task_terminal".into());
            }
            if next.task.status == Status::Paused {
                next = next.resume(at).map_err(reason)?;
            }
            next
        }
        ScheduleChange::Pause { .. } => pause_plan(plan()?, at),
        ScheduleChange::Resume { .. } => plan()?.resume(at).map_err(reason)?,
        ScheduleChange::TriggerNow { .. } => {
            let mut next = plan()?.clone();
            if next.task.status != Status::Active || next.pending.is_some() {
                return Err("scheduler_task_not_ready".into());
            }
            if next.authorization.is_none() {
                return Err("scheduler_user_approval_required".into());
            }
            next.task.next_fire_at = Some(at);
            next.claim(at).map_err(reason)?;
            next
        }
        ScheduleChange::Snooze { delay_ms, .. } => plan()?.snooze(*delay_ms, at).map_err(reason)?,
        ScheduleChange::Acknowledge { fire_id, .. } => {
            let mut next = plan()?.clone();
            let pending = next
                .pending
                .as_ref()
                .filter(|fire| {
                    fire.id == *fire_id && matches!(fire.effect, ScheduledEffect::Reminder)
                })
                .ok_or("scheduler_reminder_changed")?;
            next.settle(Run {
                id: fire_id.clone(),
                at: at.max(pending.scheduled_at),
                outcome: Outcome::Ok,
                message: "Reminder acknowledged".into(),
                session_id: None,
                run_id: None,
            })
            .map_err(reason)?;
            next
        }
        ScheduleChange::ClearHistory { .. } => plan()?.clear_history(at),
        ScheduleChange::Delete { .. } => {
            if plan()?
                .pending
                .as_ref()
                .is_some_and(|fire| !matches!(fire.effect, ScheduledEffect::Reminder))
            {
                return Err("scheduler_trigger_pending".into());
            }
            return Ok(None);
        }
    };
    candidate.validate().map_err(reason)?;
    Ok(Some(candidate))
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
