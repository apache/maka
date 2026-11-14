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

mod edit;

#[cfg(test)]
mod tests;

use crate::{
    Error, invalid,
    task::{Create, Creator, Intent, Outcome, Run, Status, Task, TaskEffect},
};
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Misfire {
    #[default]
    Skip,
    Latest,
}

/// Persist before submitting to Host. A retry uses these frozen bytes and ID,
/// never the task's potentially edited title, effect or instruction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(bound(deserialize = "E: Deserialize<'de>, A: Deserialize<'de>"))]
pub struct Fire<E, A> {
    pub id: String,
    pub task_id: String,
    pub scheduled_at: i64,
    pub title: String,
    pub intent: Intent,
    pub effect: E,
    #[serde(default)]
    pub authorization: Option<A>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(bound(deserialize = "E: Deserialize<'de>, A: Deserialize<'de>"))]
pub struct TaskPlan<E, A> {
    pub task: Task<E>,
    pub edit_revision: u64,
    pub timezone: String,
    pub misfire: Misfire,
    pub pending: Option<Fire<E, A>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    condition_matched: bool,
    #[serde(default)]
    pub authorization: Option<A>,
}
impl<E: TaskEffect, A: Clone> TaskPlan<E, A> {
    pub fn validate(&self) -> Result<(), Error> {
        crate::task::text(&self.task.id)?;
        if self
            .task
            .id
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        {
            return Err(invalid("invalid task identity"));
        }
        TimeZone::get(&self.timezone)?;
        Create {
            title: self.task.title.clone(),
            intent_body: self.task.intent.body().into(),
            schedule: self.task.schedule.clone(),
            effect: self.task.effect.clone(),
            max_fires: self.task.max_fires,
            expires_at: self.task.expires_at,
        }
        .validate_fields()?;
        if self.task.created_at < 0
            || self.task.updated_at < self.task.created_at
            || (self.task.status == Status::Active && self.task.next_fire_at.is_none())
        {
            return Err(invalid("invalid persisted task state"));
        }
        // Wall time can move backward after creation; the frozen trigger keeps
        // its actual scheduled time, independent of monotonic task metadata.
        if let Some(fire) = &self.pending {
            crate::task::text(&fire.id)?;
            fire.effect.validate()?;
            if fire.task_id != self.task.id || fire.scheduled_at < 0 {
                return Err(invalid("invalid persisted trigger"));
            }
        }
        Ok(())
    }

    pub fn create(
        id: String,
        input: Create<E>,
        creator: Creator,
        timezone: String,
        now: i64,
    ) -> Result<Self, Error> {
        crate::task::text(&id)?;
        if let Creator::Agent { session_id } = &creator {
            crate::task::text(session_id)?;
        }
        input.validate(now)?;
        let zone = TimeZone::get(&timezone)?;
        let next = input
            .schedule
            .next_after(now, &zone)?
            .ok_or_else(|| invalid("schedule has no remaining trigger"))?;
        if input.expires_at.is_some_and(|expires| next >= expires) {
            return Err(invalid("schedule first fires after expiry"));
        }
        Ok(Self {
            task: Task {
                id,
                title: input.title.trim().into(),
                intent: Intent::Text {
                    body: input.intent_body.trim().into(),
                },
                schedule: input.schedule,
                effect: input.effect,
                status: Status::Active,
                next_fire_at: Some(next),
                last_fire_at: None,
                fire_count: 0,
                max_fires: input.max_fires,
                expires_at: input.expires_at,
                created_by: creator,
                created_at: now,
                updated_at: now,
                runs: vec![],
                last_error: None,
            },
            edit_revision: 1,
            timezone,
            misfire: Misfire::Skip,
            pending: None,
            condition_matched: false,
            authorization: None,
        })
    }
    /// Reopening or enabling skips missed triggers unless catch-up was selected.
    /// A previously committed pending fire must still be reconciled: it may
    /// already have been accepted by Host.
    pub fn recover(&mut self, now: i64) -> Result<(), Error> {
        if self.pending.is_some() || self.task.status != Status::Active {
            return Ok(());
        }
        let before = (self.task.status, self.task.next_fire_at);
        if self.task.expires_at.is_some_and(|expires| now >= expires) {
            self.task.status = Status::Expired;
            self.task.next_fire_at = None;
        } else if self.task.next_fire_at.is_some_and(|at| at < now) {
            match self.misfire {
                Misfire::Skip => self.advance(now)?,
                Misfire::Latest => self.catch_up(now)?,
            }
        }
        if before != (self.task.status, self.task.next_fire_at) {
            self.task.updated_at = self.task.updated_at.max(now);
        }
        Ok(())
    }
    fn catch_up(&mut self, now: i64) -> Result<(), Error> {
        if let Some(next) = self.task.next_fire_at.filter(|at| *at < now) {
            let latest = self
                .task
                .schedule
                .latest_at(now, &TimeZone::get(&self.timezone)?)?;
            self.task.next_fire_at = Some(latest.map_or(next, |at| at.max(next)));
        }
        Ok(())
    }
    /// Returns the same intent while settlement is pending. The repository must
    /// commit the changed Plan before the caller may dispatch the Fire.
    pub fn claim(&mut self, now: i64) -> Result<Option<&Fire<E, A>>, Error> {
        if self.pending.is_some() {
            return Ok(self.pending.as_ref());
        }
        if self.task.status != Status::Active {
            return Ok(None);
        }
        if self.task.expires_at.is_some_and(|expires| now >= expires) {
            self.task.status = Status::Expired;
            self.task.next_fire_at = None;
            self.task.updated_at = self.task.updated_at.max(now);
            return Ok(None);
        }
        let Some(at) = self.task.next_fire_at.filter(|at| *at <= now) else {
            return Ok(None);
        };
        self.pending = Some(Fire {
            id: format!("fire-{}", uuid::Uuid::new_v4()),
            task_id: self.task.id.clone(),
            scheduled_at: at,
            title: self.task.title.clone(),
            intent: self.task.intent.clone(),
            effect: self.task.effect.clone(),
            authorization: self.authorization.clone(),
        });
        self.task.updated_at = self.task.updated_at.max(now);
        Ok(self.pending.as_ref())
    }
    /// Apply a check to its observed due occurrence. A true condition must clear
    /// before it can create another fire. An error does not rearm it.
    pub fn record_condition(
        &mut self,
        now: i64,
        result: Result<bool, String>,
    ) -> Result<(), Error> {
        if self.task.status != Status::Active || self.pending.is_some() {
            return Ok(());
        }
        if self.task.expires_at.is_some_and(|expires| now >= expires) {
            return self.advance(now);
        }
        match result {
            Ok(matched) => {
                self.task.last_error = None;
                let triggered = matched && !self.condition_matched;
                self.condition_matched = matched;
                if triggered {
                    self.claim(now)?;
                    return Ok(());
                }
            }
            Err(error) => self.task.last_error = Some(error),
        }
        self.task.updated_at = self.task.updated_at.max(now);
        self.advance(now)
    }

    pub fn settle(&mut self, run: Run) -> Result<(), Error> {
        let mut next = self.clone();
        next.settle_inner(run)?;
        *self = next;
        Ok(())
    }

    fn settle_inner(&mut self, run: Run) -> Result<(), Error> {
        let fire = self
            .pending
            .as_ref()
            .ok_or_else(|| invalid("no pending trigger"))?;
        if run.id != fire.id || run.at < fire.scheduled_at {
            return Err(invalid("run does not settle the pending trigger"));
        }
        let paused = self.task.status == Status::Paused;
        self.task.last_fire_at = Some(run.at);
        self.task.updated_at = run.at;
        self.task.fire_count = self
            .task
            .fire_count
            .checked_add(1)
            .ok_or_else(|| invalid("fire count exhausted"))?;
        self.task.last_error = (run.outcome != Outcome::Ok).then(|| run.message.clone());
        self.task.runs.insert(0, run);
        self.pending = None;
        self.advance(self.task.updated_at)?;
        if paused && self.task.status == Status::Active {
            self.task.status = Status::Paused;
        }
        Ok(())
    }
    fn advance(&mut self, after: i64) -> Result<(), Error> {
        let next = self
            .task
            .schedule
            .next_after(after, &TimeZone::get(&self.timezone)?)?;
        let expired = self
            .task
            .expires_at
            .is_some_and(|expires| after >= expires || next.is_some_and(|at| at >= expires));
        let completed = next.is_none()
            || (matches!(self.task.schedule, crate::schedule::Schedule::Once { .. })
                && self.task.fire_count > 0)
            || self
                .task
                .max_fires
                .is_some_and(|max| self.task.fire_count >= max);
        self.task.status = if expired {
            Status::Expired
        } else if completed {
            Status::Completed
        } else {
            Status::Active
        };
        self.task.next_fire_at = (self.task.status == Status::Active)
            .then_some(next)
            .flatten();
        Ok(())
    }
}
