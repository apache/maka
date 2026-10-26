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

use crate::{
    Error,
    authorization::Origin,
    command::{Mutation, MutationResult},
    delivery::Dispatcher,
    invalid,
    plan::Plan,
    repository::{Catalog, Repository},
    task::Status,
};
use sha2::{Digest, Sha256};

/// Serializes business edits; only successful CAS acknowledgements replace memory.
pub struct Controller {
    pub(crate) repository: Repository,
    pub(crate) catalog: Catalog,
    timezone: String,
}
impl Controller {
    pub fn view(&self, previous: &crate::view::View) -> crate::view::View {
        crate::view::View::committed(&self.catalog, previous)
    }
    pub async fn open(repository: Repository, timezone: String, now: i64) -> Result<Self, Error> {
        jiff::tz::TimeZone::get(&timezone)?;
        let catalog = repository.load().await?;
        let mut owner = Self {
            repository,
            catalog,
            timezone,
        };
        owner.recover(now).await?;
        Ok(owner)
    }
    pub async fn reload(&mut self) -> Result<(), Error> {
        self.catalog = self.repository.load().await?;
        Ok(())
    }
    pub async fn recover(&mut self, now: i64) -> Result<(), Error> {
        let ids = self.catalog.plans.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let saved = &self.catalog.plans[&id].plan;
            let mut next = saved.clone();
            next.recover(now)?;
            if &next != saved {
                self.repository.save(&mut self.catalog, next).await?;
            }
        }
        Ok(())
    }
    pub async fn mutate(
        &mut self,
        request: Mutation,
        origin: Origin,
        now: i64,
        dispatcher: &dyn Dispatcher,
    ) -> Result<MutationResult, Error> {
        self.mutate_at_revision(request, origin, None, now, dispatcher)
            .await
    }
    pub(crate) async fn mutate_at_revision(
        &mut self,
        request: Mutation,
        origin: Origin,
        expected_revision: Option<u64>,
        now: i64,
        dispatcher: &dyn Dispatcher,
    ) -> Result<MutationResult, Error> {
        // This check runs in the owner queue, before authorization or persistence.
        if let Some(expected) = expected_revision {
            let id = request
                .task_id()
                .ok_or_else(|| invalid("create has no task revision"))?;
            if self.catalog.plans.get(id).map(|saved| saved.revision) != Some(expected) {
                return Err(Error::RevisionConflict);
            }
        }
        if let Some(invocation) = origin.agent()? {
            let id = request.task_id();
            if let Some(id) = id
                && !matches!(&self.plan(id)?.task.created_by,
                    crate::task::Creator::Agent { session_id } if *session_id == invocation.session_id)
            {
                return Err(invalid("an agent may manage only its own scheduled tasks"));
            }
        }
        let authorize = matches!(&request, Mutation::Create { .. })
            || matches!(&request, Mutation::Update { patch, .. } if patch.effect.is_some());
        let mut next = match request {
            Mutation::Create { input } => Plan::create(
                format!("task-{}", uuid::Uuid::new_v4()),
                input,
                origin.creator()?,
                self.timezone.clone(),
                now,
            )?,
            Mutation::CreateOnce {
                operation_id,
                input,
            } => {
                return self
                    .create_once(operation_id, input, origin, now, dispatcher)
                    .await;
            }
            Mutation::Update { task_id, patch } => self.plan(&task_id)?.update(patch, now)?,
            Mutation::Pause { task_id } => self.plan(&task_id)?.pause(now),
            Mutation::Resume { task_id } => self.plan(&task_id)?.resume(now)?,
            Mutation::ClearHistory { task_id } => self.plan(&task_id)?.clear_history(now),
            Mutation::Snooze { task_id, delay_ms } => self.plan(&task_id)?.snooze(delay_ms, now)?,
            Mutation::TriggerNow { task_id } => {
                let mut next = self.plan(&task_id)?.clone();
                if next.task.status != Status::Active {
                    return Err(invalid("only active tasks can trigger"));
                }
                if next.pending.is_none() {
                    next.task.next_fire_at = Some(now);
                    next.claim(now)?;
                }
                next
            }
            Mutation::Delete { task_id } => {
                self.repository.remove(&mut self.catalog, &task_id).await?;
                return Ok(MutationResult::Deleted { task_id });
            }
        };
        if authorize {
            next.authorization = Some(
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    dispatcher.authorize(origin, next.task.effect.clone()),
                )
                .await
                .map_err(|_| Error::Unavailable("authorization deadline exceeded".into()))??,
            );
        }
        let result = MutationResult::Task {
            task: Box::new(next.task.clone()),
        };
        self.repository.save(&mut self.catalog, next).await?;
        Ok(result)
    }
    /// Reports an immutable creation fact, not the task's current existence or state.
    pub async fn creation(&self, operation_id: uuid::Uuid) -> Result<Option<String>, Error> {
        Ok(self
            .repository
            .creation(operation_id)
            .await?
            .map(|receipt| receipt.task_id))
    }
    async fn create_once(
        &mut self,
        operation_id: uuid::Uuid,
        input: crate::task::Create,
        origin: Origin,
        now: i64,
        dispatcher: &dyn Dispatcher,
    ) -> Result<MutationResult, Error> {
        let creator = origin.creator()?;
        let fingerprint = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&input, &creator, &self.timezone))
                .map_err(|error| invalid(error.to_string()))?,
        ));
        // A committed retry is a read, even after expiry or grant revocation.
        // It must not authorize again or recreate a task that was subsequently deleted.
        if let Some(receipt) = self.repository.creation(operation_id).await? {
            if receipt.fingerprint != fingerprint {
                return Err(Error::CreationConflict);
            }
            return Ok(MutationResult::Created {
                operation_id,
                task_id: receipt.task_id,
            });
        }
        let task_id = format!("task-{operation_id}");
        let mut plan = Plan::create(task_id.clone(), input, creator, self.timezone.clone(), now)?;
        plan.authorization = Some(
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                dispatcher.authorize(origin, plan.task.effect.clone()),
            )
            .await
            .map_err(|_| Error::Unavailable("authorization deadline exceeded".into()))??,
        );
        self.repository
            .save_with_creation(
                &mut self.catalog,
                plan,
                Some(crate::repository::Creation {
                    operation_id,
                    fingerprint,
                    task_id: task_id.clone(),
                }),
            )
            .await?;
        Ok(MutationResult::Created {
            operation_id,
            task_id,
        })
    }
    fn plan(&self, id: &str) -> Result<&Plan, Error> {
        self.catalog
            .plans
            .get(id)
            .map(|saved| &saved.plan)
            .ok_or(Error::NotFound)
    }
}
