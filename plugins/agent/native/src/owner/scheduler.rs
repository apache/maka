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
mod tools;
use super::*;
use maka_capabilities::storage::Data;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_capabilities::storage::Store;
use maka_scheduler::{
    plan::TaskPlan,
    task::{Creator, Outcome, Run, Status},
};
use repository::Saved;
use std::sync::{OnceLock, Weak};
use tokio::sync::Notify;
type Plan = TaskPlan<ScheduledEffect, Approval>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Approval {
    Reminder,
    Execution { basis: Box<MessageBasis> },
}
pub(crate) struct Scheduler {
    storage: Arc<maka_host_runtime::storage::Storage>,
    gate: Mutex<()>,
    wake: Notify,
    changed: tokio::sync::watch::Sender<u64>,
    link: OnceLock<Weak<Owner>>,
}
impl Scheduler {
    pub fn new(store: Arc<RootStore>, prefix: String) -> Self {
        Self {
            storage: Arc::new(maka_host_runtime::storage::Storage::new(
                store,
                prefix,
                Namespace::new(
                    "maka.agent.scheduler",
                    maka_plugin_core::scope::Scope::Profile,
                )
                .expect("scheduler namespace"),
            )),
            gate: Mutex::new(()),
            wake: Notify::new(),
            changed: tokio::sync::watch::channel(0).0,
            link: OnceLock::new(),
        }
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.link
            .set(Arc::downgrade(owner))
            .expect("scheduler bound once");
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
        if let ScheduleRead::Receipt { reference } = input {
            if reference.source.state_domain != self.data_source.state_domain
                || reference.source.deployment != self.data_source.deployment
                || reference.namespace != self.data_source.namespace
                || reference.export != crate::EXPORT
                || reference.method != "schedule"
            {
                return Err("scheduler_receipt_owner_invalid".into());
            }
            return Ok(Schedules::Receipt {
                result: scheduler.receipt(&reference).await?,
            });
        }
        let catalog = scheduler.load().await?;
        match input {
            ScheduleRead::List {
                cursor,
                expected_revision,
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
            ScheduleRead::Get { task_id } => Ok(Schedules::Task {
                detail: catalog
                    .plans
                    .get(&task_id)
                    .map(|saved| Box::new(saved.detail())),
            }),
            ScheduleRead::Receipt { .. } => unreachable!(),
        }
    }
    pub async fn schedule_change(
        self: &Arc<Self>,
        input: ScheduleChange,
        operation: maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<ScheduleResult, String> {
        // Management grants are explicit. Model tools have a separate proposal
        // path and cannot turn their own arguments into background approval.
        if scope.identity.agent().is_some() {
            return Err("scheduler_user_approval_required".into());
        }
        if !self.settings.scheduled_tasks {
            return Err("scheduler_disabled".into());
        }
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let owner = self.clone();
        let job = self.workers.spawn(async move {
            let _gate = owner.scheduler.gate.lock().await;
            if let Some(result) = owner.scheduler.receipt(&operation).await? {
                return Ok(result);
            }
            let mut catalog = owner.scheduler.load().await?;
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
            let expected = match &input {
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
            };
            let actual = catalog.plans.get(&id).map(|saved| saved.revision);
            let candidate = if expected != actual {
                Err(ScheduleResult::Conflict { actual })
            } else {
                owner
                    .schedule_candidate(&id, input, catalog.plans.get(&id))
                    .await
                    .map_err(|reason| ScheduleResult::Rejected { reason })
            };
            let result = match candidate {
                Ok(plan) => {
                    let revision = actual.unwrap_or(0) + 1;
                    let result = ScheduleResult::Committed {
                        task_id: id.clone(),
                        revision,
                    };
                    owner
                        .scheduler
                        .commit(
                            &mut catalog,
                            &id,
                            plan,
                            Some(repository::receipt_mutation(&operation, &result)?),
                        )
                        .await?;
                    result
                }
                Err(result) => {
                    owner.scheduler.remember(&operation, &result).await?;
                    result
                }
            };
            owner.scheduler.wake.notify_one();
            Ok(result)
        });
        drop(runs);
        job.await
            .map_err(|_| "scheduler_operation_unknown".to_string())?
    }
    async fn schedule_candidate(
        &self,
        id: &str,
        input: ScheduleChange,
        saved: Option<&Saved>,
    ) -> Result<Option<Plan>, String> {
        let at = now() as i64;
        let plan = || {
            saved
                .map(|saved| &saved.plan)
                .ok_or_else(|| "scheduler_task_missing".to_string())
        };
        let candidate = match input {
            ScheduleChange::Create { input } => {
                let mut plan =
                    Plan::create(id.into(), input.task, Creator::User, input.timezone, at)
                        .map_err(reason)?;
                plan.misfire = input.misfire;
                plan.authorization = Some(self.approve_schedule(&plan).await?);
                plan
            }
            ScheduleChange::Update { input, .. } => {
                let current = plan()?;
                if current.pending.is_some() {
                    return Err("scheduler_trigger_pending".into());
                }
                let mut base = current.clone();
                base.timezone = input.timezone;
                base.misfire = input.misfire;
                let mut next = base
                    .update(
                        maka_scheduler::command::Update {
                            title: Some(input.task.title),
                            intent_body: Some(input.task.intent_body),
                            schedule: Some(input.task.schedule),
                            effect: Some(input.task.effect),
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
                    .map_err(reason)?;
                next.authorization = Some(self.approve_schedule(&next).await?);
                next.validate().map_err(reason)?;
                next
            }
            ScheduleChange::Approve { .. } => {
                let mut next = plan()?.clone();
                if next.pending.is_some() {
                    return Err("scheduler_trigger_pending".into());
                }
                if !matches!(next.task.status, Status::Active | Status::Paused) {
                    return Err("scheduler_task_terminal".into());
                }
                next.authorization = Some(self.approve_schedule(&next).await?);
                if next.task.status == Status::Paused {
                    next = next.resume(at).map_err(reason)?;
                }
                next
            }
            ScheduleChange::Pause { .. } => plan()?.pause(at),
            ScheduleChange::Resume { .. } => {
                let mut next = plan()?.resume(at).map_err(reason)?;
                next.authorization = Some(self.approve_schedule(&next).await?);
                next
            }
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
            ScheduleChange::Snooze { delay_ms, .. } => {
                plan()?.snooze(delay_ms, at).map_err(reason)?
            }
            ScheduleChange::Acknowledge { fire_id, .. } => {
                let mut next = plan()?.clone();
                let pending = next
                    .pending
                    .as_ref()
                    .filter(|fire| {
                        fire.id == fire_id && matches!(fire.effect, ScheduledEffect::Reminder)
                    })
                    .ok_or("scheduler_reminder_changed")?;
                next.settle(Run {
                    id: fire_id,
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
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
