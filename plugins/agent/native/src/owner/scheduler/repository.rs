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
use maka_event_log::{
    StoreError,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    ids: Vec<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadyIndex {
    pub pending: std::collections::BTreeSet<String>,
    pub due: BTreeMap<i64, std::collections::BTreeSet<String>>,
}
fn due_at(plan: &Plan) -> Option<i64> {
    if plan.task.status != Status::Active || plan.authorization.is_none() {
        return None;
    }
    let next = if plan.pending.is_none() {
        plan.task.next_fire_at
    } else {
        None
    };
    next.into_iter().chain(plan.task.expires_at).min()
}
impl ReadyIndex {
    fn update(&mut self, id: &str, old: Option<&Plan>, new: Option<&Plan>) {
        self.pending.remove(id);
        if let Some(at) = old.and_then(due_at)
            && let Some(ids) = self.due.get_mut(&at)
        {
            ids.remove(id);
            if ids.is_empty() {
                self.due.remove(&at);
            }
        }
        if let Some(plan) = new {
            if plan
                .pending
                .as_ref()
                .is_some_and(|fire| !matches!(fire.effect, ScheduledEffect::Reminder))
            {
                self.pending.insert(id.to_owned());
            }
            if let Some(at) = due_at(plan) {
                self.due.entry(at).or_default().insert(id.to_owned());
            }
        }
    }
}
pub(in crate::owner) struct Saved {
    pub revision: u64,
    pub plan: Plan,
}
pub(in crate::owner) struct Catalog {
    pub revision: Option<u64>,
    pub plans: BTreeMap<String, Saved>,
    ids: Vec<String>,
    ready_revision: Option<u64>,
    pub(super) ready: ReadyIndex,
}
fn task_key(id: &str) -> String {
    format!("task:{id}")
}
fn value<T: Serialize>(value: &T) -> Result<Data, String> {
    serde_json::to_value(value)
        .map(Data::Present)
        .map_err(reason)
}
fn schedule_budget(
    record: maka_plugin_core::storage::Record,
    id: &str,
    message_id: &str,
) -> Result<
    (
        super::super::capture_budget::ScheduleBudget,
        Option<FollowupGrant>,
    ),
    String,
> {
    let plan: Plan = serde_json::from_value(
        record
            .data
            .value()
            .cloned()
            .ok_or("scheduler_task_deleted")?,
    )
    .map_err(reason)?;
    plan.validate().map_err(reason)?;
    if plan.task.id != id
        || plan.task.status != maka_scheduler::task::Status::Active
        || plan.task.expires_at.is_some_and(|at| now() as i64 >= at)
    {
        return Err("scheduler_authorization_changed".into());
    }
    let Some(Approval::Execution { approval } | Approval::Discovery { approval, .. }) =
        &plan.authorization
    else {
        return Err("scheduler_user_approval_required".into());
    };
    let fire = plan
        .pending
        .as_ref()
        .ok_or("scheduler_original_fire_missing")?;
    if matches!(
        fire.authorization,
        Some(Approval::CancelledDiscovery { .. })
    ) {
        return Err("discovery_cancelled".into());
    }
    let original_message = format!("m_{}", hex::encode(Sha256::digest(fire.id.as_bytes())));
    if original_message != message_id {
        return Err("scheduler_original_fire_changed".into());
    }
    Ok((
        super::super::capture_budget::ScheduleBudget {
            task_id: id.into(),
            message_id: message_id.into(),
            revision: record.revision,
            fire_id: fire.id.clone(),
            expires_at: plan
                .task
                .expires_at
                .map(maka_agent_facts::durable::UnixMillis),
            approval: approval.clone(),
        },
        fire.authorization
            .as_ref()
            .and_then(Approval::followup_grant)
            .cloned(),
    ))
}
impl Scheduler {
    pub(in crate::owner) async fn capture_budget(
        &self,
        id: &str,
        message_id: &str,
    ) -> Result<super::super::capture_budget::ScheduleBudget, String> {
        let record = self
            .storage
            .read(task_key(id))
            .await
            .map_err(reason)?
            .ok_or("scheduler_task_missing")?;
        schedule_budget(record, id, message_id).map(|(budget, _)| budget)
    }
    pub(in crate::owner) fn budget_storage(&self) -> Arc<maka_host_runtime::storage::Storage> {
        #[cfg(not(test))]
        {
            self.storage.clone()
        }
        #[cfg(test)]
        {
            self.storage.inner()
        }
    }
    pub(in crate::owner) fn budget_in_transaction(
        storage: &maka_host_runtime::storage::Storage,
        connection: &rusqlite::Connection,
        id: &str,
        message_id: &str,
        writer: &maka_event_log::root_store::DataWriter,
    ) -> Result<super::super::capture_budget::ScheduleBudget, maka_event_log::StoreError> {
        let record = storage
            .read_in_transaction(connection, &task_key(id), writer)?
            .ok_or_else(|| {
                maka_event_log::StoreError::InvalidTransition("scheduler_task_missing".into())
            })?;
        let (budget, parent) =
            schedule_budget(record, id, message_id).map_err(StoreError::InvalidTransition)?;
        if let Some(parent) = parent {
            // Admission can race with pausing the parent after the worker was queued.
            let saved = storage
                .read_in_transaction(connection, &task_key(&parent.task_id), writer)?
                .map(|record| decode_saved(record, &parent.task_id))
                .transpose()?
                .flatten();
            if !saved.is_some_and(|saved| parent.is_current(&saved.plan, now() as i64)) {
                return Err(StoreError::InvalidTransition("discovery_cancelled".into()));
            }
        }
        Ok(budget)
    }
    pub(in crate::owner) async fn load(&self) -> Result<Catalog, String> {
        self.load_selected(None).await
    }
    pub(super) async fn load_ready(&self, at: i64) -> Result<Catalog, String> {
        self.load_selected(Some(at)).await
    }
    async fn load_selected(&self, at: Option<i64>) -> Result<Catalog, String> {
        let record = self.storage.read("index".into()).await.map_err(reason)?;
        let revision = record.as_ref().map(|record| record.revision);
        let index: Index = record
            .and_then(|record| record.data.value().cloned())
            .map(serde_json::from_value)
            .transpose()
            .map_err(reason)?
            .unwrap_or(Index { ids: vec![] });
        let saved_ready = self.storage.read("ready".into()).await.map_err(reason)?;
        let ready_revision = saved_ready.as_ref().map(|record| record.revision);
        let ready_value = saved_ready.as_ref().and_then(|record| record.data.value());
        let rebuild = ready_value.is_none();
        let mut ready: ReadyIndex = ready_value
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(reason)?
            .unwrap_or_default();
        let selected: std::collections::BTreeSet<String> = if let Some(at) = at.filter(|_| !rebuild)
        {
            ready
                .pending
                .iter()
                .cloned()
                .chain(
                    ready
                        .due
                        .range(..=at)
                        .flat_map(|(_, ids)| ids.iter().cloned()),
                )
                .collect()
        } else {
            index.ids.iter().cloned().collect()
        };
        let mut plans = BTreeMap::new();
        for id in selected {
            let record = self
                .storage
                .read(task_key(&id))
                .await
                .map_err(reason)?
                .ok_or("scheduler_task_missing")?;
            let plan: Plan = serde_json::from_value(
                record
                    .data
                    .value()
                    .cloned()
                    .ok_or("scheduler_task_deleted")?,
            )
            .map_err(reason)?;
            plan.validate().map_err(reason)?;
            if plan.task.id != id {
                return Err("scheduler_catalog_invalid".into());
            }
            if rebuild {
                ready.update(&id, None, Some(&plan));
            }
            plans.insert(
                id,
                Saved {
                    revision: record.revision,
                    plan,
                },
            );
        }
        let mut catalog = Catalog {
            revision,
            plans,
            ids: index.ids,
            ready_revision,
            ready,
        };
        if at.is_some() && rebuild {
            let written = self
                .storage
                .batch(vec![Mutation {
                    key: "ready".into(),
                    expected_revision: catalog.ready_revision,
                    data: value(&catalog.ready)?,
                }])
                .await
                .map_err(reason)?;
            catalog.ready_revision = Some(written[0].revision);
        }
        Ok(catalog)
    }
    pub(in crate::owner) async fn change_basis(&self, id: &str) -> Result<Option<Saved>, String> {
        let record = self.storage.read(task_key(id)).await.map_err(reason)?;
        record
            .map(|record| decode_saved(record, id))
            .transpose()
            .map(Option::flatten)
            .map_err(reason)
    }
    pub(in crate::owner) async fn commit(
        &self,
        catalog: &mut Catalog,
        id: &str,
        plan: Option<Plan>,
        receipt: Option<Mutation>,
    ) -> Result<(), String> {
        let (mut mutations, ids, ready) = prepare_commit(catalog, id, plan.as_ref())?;
        if let Some(receipt) = receipt {
            mutations.push(receipt);
        }
        let written = self.storage.batch(mutations).await.map_err(reason)?;
        catalog.revision = Some(written[0].revision);
        catalog.ids = ids;
        catalog.ready_revision = Some(written[2].revision);
        catalog.ready = ready;
        self.changed.send_replace(written[0].revision);
        if let Some(plan) = plan {
            catalog.plans.insert(
                id.into(),
                Saved {
                    revision: written[1].revision,
                    plan,
                },
            );
        } else {
            catalog.plans.remove(id);
        }
        Ok(())
    }
}
fn prepare_commit(
    catalog: &Catalog,
    id: &str,
    plan: Option<&Plan>,
) -> Result<(Vec<Mutation>, Vec<String>, ReadyIndex), String> {
    if let Some(plan) = plan {
        plan.validate().map_err(reason)?;
    }
    let mut ids = catalog
        .ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if plan.is_some() {
        ids.insert(id.into());
    } else {
        ids.remove(id);
    }
    let expected = catalog.plans.get(id).map(|saved| saved.revision);
    let mut ready = catalog.ready.clone();
    ready.update(id, catalog.plans.get(id).map(|saved| &saved.plan), plan);
    let ids: Vec<_> = ids.into_iter().collect();
    let mut mutations = vec![
        Mutation {
            key: "index".into(),
            expected_revision: catalog.revision,
            data: value(&Index { ids: ids.clone() })?,
        },
        Mutation {
            key: task_key(id),
            expected_revision: expected,
            data: plan.map(value).transpose()?.unwrap_or(Data::Deleted),
        },
    ];
    mutations.push(Mutation {
        key: "ready".into(),
        expected_revision: catalog.ready_revision,
        data: value(&ready)?,
    });

    Ok((mutations, ids, ready))
}

fn decode_saved(
    record: maka_plugin_core::storage::Record,
    id: &str,
) -> Result<Option<Saved>, StoreError> {
    let Some(value) = record.data.value() else {
        return Ok(None);
    };
    let plan: Plan = serde_json::from_value(value.clone())?;
    plan.validate()
        .map_err(|error| StoreError::InvalidTransition(reason(error)))?;
    if plan.task.id != id {
        return Err(StoreError::InvalidTransition(
            "scheduler_catalog_invalid".into(),
        ));
    }
    Ok(Some(Saved {
        revision: record.revision,
        plan,
    }))
}

pub(super) struct ScheduleMutation {
    pub(super) scheduler: Arc<Scheduler>,
    pub(super) gate: Arc<tokio::sync::OwnedMutexGuard<()>>,
    pub(super) writer: DataWriter,
    pub(super) input: ScheduleChange,
    pub(super) id: String,
    pub(super) approval: Result<Option<PreparedScheduleApproval>, String>,
}
impl ScheduleMutation {
    fn read(
        &self,
        connection: &rusqlite::Connection,
        id: &str,
    ) -> Result<Option<Saved>, StoreError> {
        self.scheduler
            .storage
            .read_in_transaction(connection, &task_key(id), &self.writer)?
            .map(|record| decode_saved(record, id))
            .transpose()
            .map(Option::flatten)
    }
    fn catalog(
        &self,
        connection: &rusqlite::Connection,
        saved: Option<Saved>,
    ) -> Result<Catalog, StoreError> {
        let record =
            self.scheduler
                .storage
                .read_in_transaction(connection, "index", &self.writer)?;
        let revision = record.as_ref().map(|record| record.revision);
        let index: Index = record
            .and_then(|record| record.data.value().cloned())
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or(Index { ids: vec![] });
        let record =
            self.scheduler
                .storage
                .read_in_transaction(connection, "ready", &self.writer)?;
        let ready_revision = record.as_ref().map(|record| record.revision);
        let mut plans = BTreeMap::new();
        if let Some(saved) = saved {
            plans.insert(self.id.clone(), saved);
        }
        let ready = if let Some(value) = record.as_ref().and_then(|record| record.data.value()) {
            serde_json::from_value(value.clone())?
        } else {
            let mut ready = ReadyIndex::default();
            for id in &index.ids {
                if !plans.contains_key(id) {
                    let saved = self.read(connection, id)?.ok_or_else(|| {
                        StoreError::InvalidTransition("scheduler_task_missing".into())
                    })?;
                    plans.insert(id.clone(), saved);
                }
                ready.update(id, None, plans.get(id).map(|saved| &saved.plan));
            }
            ready
        };
        Ok(Catalog {
            revision,
            plans,
            ids: index.ids,
            ready_revision,
            ready,
        })
    }
    fn apply(
        &self,
        connection: &rusqlite::Connection,
        saved: Option<Saved>,
    ) -> Result<(ScheduleResult, Vec<Mutation>), StoreError> {
        let actual = saved.as_ref().map(|saved| saved.revision);
        if expected_revision(&self.input) != actual {
            return Ok((ScheduleResult::Conflict { actual }, vec![]));
        }
        let rejected = |reason: String| (ScheduleResult::Rejected { reason }, vec![]);
        let mut plan = match schedule_candidate(&self.id, &self.input, saved.as_ref(), now() as i64)
        {
            Ok(plan) => plan,
            Err(error) => return Ok(rejected(error)),
        };
        if needs_approval(&self.input) {
            let approval = match &self.approval {
                Ok(Some(approval)) => approval,
                Err(error) => return Ok(rejected(error.clone())),
                Ok(None) => return Ok(rejected("scheduler_authorization_changed".into())),
            };
            let Some(plan) = plan.as_mut() else {
                return Err(StoreError::InvalidTransition(
                    "scheduler_approval_missing".into(),
                ));
            };
            if plan.task.effect != approval.effect {
                return Ok(rejected("scheduler_authorization_changed".into()));
            }
            if let Some(metadata) = &approval.metadata {
                match metadata.validate(connection) {
                    Ok(()) => {}
                    Err(
                        StoreError::SessionRevisionConflict { .. }
                        | StoreError::SessionNotFound
                        | StoreError::SessionRetired,
                    ) => return Ok(rejected("scheduler_authorization_changed".into())),
                    Err(error) => return Err(error),
                }
            }
            plan.authorization = Some(approval.authorization.clone());
        }
        let catalog = self.catalog(connection, saved)?;
        let (mutations, _, _) = prepare_commit(&catalog, &self.id, plan.as_ref())
            .map_err(StoreError::InvalidTransition)?;
        Ok((
            ScheduleResult::Committed {
                task_id: self.id.clone(),
                revision: actual.unwrap_or(0) + 1,
            },
            mutations,
        ))
    }
}
#[derive(Serialize)]
#[serde(transparent)]
pub(super) struct ScheduleCompletion {
    result: ScheduleResult,
    #[serde(skip)]
    scheduler: Arc<Scheduler>,
    #[serde(skip)]
    index_revision: Option<u64>,
}
impl Statement for ScheduleMutation {
    type Value = ScheduleCompletion;
    type Output = ScheduleResult;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        vec![self.gate.clone()]
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<ScheduleCompletion>, StoreError> {
        let saved = self.read(connection, &self.id)?;
        let (result, mutations) = self.apply(connection, saved)?;
        let (changed, notification, index_revision) = if mutations.is_empty() {
            (false, Notification::NONE, None)
        } else {
            let prepared = self
                .scheduler
                .storage
                .prepare_statement(mutations, &self.writer)?
                .execute(connection)?;
            (
                prepared.changed,
                prepared.notification,
                Some(prepared.value[0].revision),
            )
        };
        Ok(Prepared {
            value: ScheduleCompletion {
                result,
                scheduler: self.scheduler,
                index_revision,
            },
            changed,
            notification,
        })
    }
    fn committed(value: ScheduleCompletion) -> ScheduleResult {
        if let Some(revision) = value.index_revision {
            value.scheduler.changed.send_replace(revision);
            value.scheduler.wake.notify_one();
        }
        value.result
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error.underlying(),
            StoreError::StatementRejected { .. }
                | StoreError::RevisionConflict { .. }
                | StoreError::InvalidTransition(_)
                | StoreError::SessionNotFound
                | StoreError::EventConflict
        )
    }
}
impl Saved {
    pub fn summary(&self) -> ScheduledSummary {
        ScheduledSummary {
            id: self.plan.task.id.clone(),
            revision: self.revision,
            title: self.plan.task.title.clone(),
            status: self.plan.task.status,
            approved: self.plan.authorization.is_some(),
            background_followup: matches!(self.plan.task.created_by, Creator::Agent { .. })
                && matches!(self.plan.task.schedule, TaskSchedule::Once { .. })
                && matches!(self.plan.task.effect, ScheduledEffect::Discovery { .. })
                && (self.plan.authorization.is_some()
                    || matches!(self.plan.task.status, Status::Completed | Status::Expired)),
            next_fire_at: self.plan.task.next_fire_at,
            pending_fire: self.plan.pending.as_ref().map(|fire| fire.id.clone()),
            reminder: matches!(self.plan.task.effect, ScheduledEffect::Reminder),
            last_error: self.plan.task.last_error.clone(),
        }
    }
    pub fn detail(&self) -> ScheduledDetail {
        ScheduledDetail {
            investigation: None,
            revision: self.revision,
            task: self.plan.task.clone(),
            timezone: self.plan.timezone.clone(),
            misfire: self.plan.misfire,
            approved: self.plan.authorization.is_some(),
            pending_fire: self.plan.pending.as_ref().map(|fire| fire.id.clone()),
        }
    }
}
