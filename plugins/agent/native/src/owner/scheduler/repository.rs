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
use maka_plugin_core::operation::RecoveryRef;
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
        if let Some(at) = old.and_then(due_at) {
            if let Some(ids) = self.due.get_mut(&at) {
                ids.remove(id);
                if ids.is_empty() {
                    self.due.remove(&at);
                }
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
    pub ready: ReadyIndex,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    reference: RecoveryRef,
    result: ScheduleResult,
}
fn receipt_key(operation: &RecoveryRef) -> String {
    format!(
        "receipt:{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(operation).expect("operation reference")
        ))
    )
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
) -> Result<super::super::capture_budget::ScheduleBudget, String> {
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
    let Some(Approval::Execution { approval }) = &plan.authorization else {
        return Err("scheduler_user_approval_required".into());
    };
    let fire = plan
        .pending
        .as_ref()
        .ok_or("scheduler_original_fire_missing")?;
    let original_message = format!("m_{}", hex::encode(Sha256::digest(fire.id.as_bytes())));
    if original_message != message_id {
        return Err("scheduler_original_fire_changed".into());
    }
    Ok(super::super::capture_budget::ScheduleBudget {
        task_id: id.into(),
        message_id: message_id.into(),
        revision: record.revision,
        fire_id: fire.id.clone(),
        expires_at: plan
            .task
            .expires_at
            .map(maka_agent_facts::durable::UnixMillis),
        approval: approval.clone(),
    })
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
        schedule_budget(record, id, message_id)
    }
    pub(in crate::owner) fn budget_storage(&self) -> Arc<maka_host_runtime::storage::Storage> {
        self.storage.clone()
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
        schedule_budget(record, id, message_id)
            .map_err(maka_event_log::StoreError::InvalidTransition)
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
    pub(super) async fn receipt(
        &self,
        reference: &RecoveryRef,
    ) -> Result<Option<ScheduleResult>, String> {
        let record = self
            .storage
            .read(receipt_key(reference))
            .await
            .map_err(reason)?;
        let Some(record) = record else {
            return Ok(None);
        };
        let receipt: Receipt = serde_json::from_value(
            record
                .data
                .value()
                .cloned()
                .ok_or("scheduler_receipt_invalid")?,
        )
        .map_err(reason)?;
        if receipt.reference != *reference {
            return Err("scheduler_receipt_conflict".into());
        }
        Ok(Some(receipt.result))
    }
    pub(super) async fn remember(
        &self,
        reference: &RecoveryRef,
        result: &ScheduleResult,
    ) -> Result<(), String> {
        self.storage
            .batch(vec![receipt_mutation(reference, result)?])
            .await
            .map_err(reason)?;
        Ok(())
    }
    pub(in crate::owner) async fn commit(
        &self,
        catalog: &mut Catalog,
        id: &str,
        plan: Option<Plan>,
        receipt: Option<Mutation>,
    ) -> Result<(), String> {
        if let Some(plan) = &plan {
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
        ready.update(
            id,
            catalog.plans.get(id).map(|saved| &saved.plan),
            plan.as_ref(),
        );
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
                data: plan
                    .as_ref()
                    .map(value)
                    .transpose()?
                    .unwrap_or(Data::Deleted),
            },
        ];
        mutations.push(Mutation {
            key: "ready".into(),
            expected_revision: catalog.ready_revision,
            data: value(&ready)?,
        });
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
pub(super) fn receipt_mutation(
    reference: &RecoveryRef,
    result: &ScheduleResult,
) -> Result<Mutation, String> {
    Ok(Mutation {
        key: receipt_key(reference),
        expected_revision: None,
        data: value(&Receipt {
            reference: reference.clone(),
            result: result.clone(),
        })?,
    })
}
impl Saved {
    pub fn summary(&self) -> ScheduledSummary {
        ScheduledSummary {
            id: self.plan.task.id.clone(),
            revision: self.revision,
            title: self.plan.task.title.clone(),
            status: self.plan.task.status,
            approved: self.plan.authorization.is_some(),
            next_fire_at: self.plan.task.next_fire_at,
            pending_fire: self.plan.pending.as_ref().map(|fire| fire.id.clone()),
            reminder: matches!(self.plan.task.effect, ScheduledEffect::Reminder),
            last_error: self.plan.task.last_error.clone(),
        }
    }
    pub fn detail(&self) -> ScheduledDetail {
        ScheduledDetail {
            revision: self.revision,
            task: self.plan.task.clone(),
            timezone: self.plan.timezone.clone(),
            misfire: self.plan.misfire,
            approved: self.plan.authorization.is_some(),
            pending_fire: self.plan.pending.as_ref().map(|fire| fire.id.clone()),
        }
    }
}
