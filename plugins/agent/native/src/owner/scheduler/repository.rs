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
pub(in crate::owner) struct Saved {
    pub revision: u64,
    pub plan: Plan,
}
pub(in crate::owner) struct Catalog {
    pub revision: Option<u64>,
    pub plans: BTreeMap<String, Saved>,
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
impl Scheduler {
    pub(in crate::owner) async fn load(&self) -> Result<Catalog, String> {
        let record = self.storage.read("index".into()).await.map_err(reason)?;
        let revision = record.as_ref().map(|record| record.revision);
        let index: Index = record
            .and_then(|record| record.data.value().cloned())
            .map(serde_json::from_value)
            .transpose()
            .map_err(reason)?
            .unwrap_or(Index { ids: vec![] });
        let mut plans = BTreeMap::new();
        for id in index.ids {
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
            if plan.task.id != id
                || plans
                    .insert(
                        id,
                        Saved {
                            revision: record.revision,
                            plan,
                        },
                    )
                    .is_some()
            {
                return Err("scheduler_catalog_invalid".into());
            }
        }
        Ok(Catalog { revision, plans })
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
    pub(super) async fn commit(
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
            .plans
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if plan.is_some() {
            ids.insert(id.into());
        } else {
            ids.remove(id);
        }
        let expected = catalog.plans.get(id).map(|saved| saved.revision);
        let mut mutations = vec![
            Mutation {
                key: "index".into(),
                expected_revision: catalog.revision,
                data: value(&Index {
                    ids: ids.into_iter().collect(),
                })?,
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
        if let Some(receipt) = receipt {
            mutations.push(receipt);
        }
        let written = self.storage.batch(mutations).await.map_err(reason)?;
        catalog.revision = Some(written[0].revision);
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
