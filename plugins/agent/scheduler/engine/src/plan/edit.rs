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

use super::{Misfire, TaskPlan};
use crate::{
    Error,
    command::Update,
    invalid,
    schedule::Schedule,
    task::{Create, Intent, Status, TaskEffect},
};
use jiff::tz::TimeZone;
use maka_agent_facts::configuration::Patch;

impl<E: TaskEffect, A: Clone> TaskPlan<E, A> {
    /// Work on a candidate: a rejected edit never mutates the loaded authority.
    pub fn update(&self, patch: Update<E>, now: i64) -> Result<Self, Error> {
        if !matches!(self.task.status, Status::Active | Status::Paused) {
            return Err(invalid("terminal task cannot be edited"));
        }
        let mut next = self.clone();
        let reschedule = patch.schedule.is_some();
        if let Some(title) = patch.title {
            next.task.title = title.trim().into();
        }
        if let Some(body) = patch.intent_body {
            next.task.intent = Intent::Text {
                body: body.trim().into(),
            };
        }
        if let Some(schedule) = patch.schedule {
            next.task.schedule = schedule;
        }
        if let Some(effect) = patch.effect {
            next.task.effect = effect;
            next.authorization = None;
        }
        apply(patch.max_fires, &mut next.task.max_fires);
        apply(patch.expires_at, &mut next.task.expires_at);
        // An unchanged one-shot schedule can be pending; only new schedules
        // require a future runAt. Frozen pending Fire bytes remain unchanged.
        let input = Create {
            title: next.task.title.clone(),
            intent_body: next.task.intent.body().into(),
            schedule: next.task.schedule.clone(),
            effect: next.task.effect.clone(),
            max_fires: next.task.max_fires,
            expires_at: next.task.expires_at,
        };
        if reschedule {
            input.validate(now)?;
        } else {
            input.validate_fields()?;
        }
        if next.task.expires_at.is_some_and(|expires| expires <= now) {
            return Err(invalid("expiry must be a future timestamp"));
        }
        if next
            .task
            .max_fires
            .is_some_and(|max| max <= next.task.fire_count)
        {
            return Err(invalid("maxFires does not exceed the current fire count"));
        }
        if reschedule
            || (next.task.next_fire_at.is_none_or(|at| at <= now) && next.pending.is_none())
        {
            next.task.next_fire_at = if next.task.status == Status::Active {
                Some(
                    next.task
                        .schedule
                        .next_after(now, &TimeZone::get(&next.timezone)?)?
                        .ok_or_else(|| invalid("schedule has no remaining trigger"))?,
                )
            } else {
                None
            };
        }
        next.check_expiry()?;
        next.task.updated_at = next.task.updated_at.max(now);
        next.validate()?;
        Ok(next)
    }
    pub fn pause(&self, now: i64) -> Self {
        let mut next = self.clone();
        next.cancel_waiting_notification();
        if next.task.status == Status::Active {
            next.task.status = Status::Paused;
            next.task.updated_at = next.task.updated_at.max(now);
        }
        next
    }
    pub fn resume(&self, now: i64) -> Result<Self, Error> {
        if self.task.status != Status::Paused {
            return Err(invalid("only paused tasks can resume"));
        }
        if self
            .task
            .max_fires
            .is_some_and(|max| self.task.fire_count >= max)
            || (matches!(self.task.schedule, Schedule::Once { .. }) && self.task.fire_count > 0)
        {
            return Err(invalid("task fire budget exhausted"));
        }
        let mut next = self.clone();
        if next.task.expires_at.is_some_and(|expires| now >= expires) {
            next.task.status = Status::Expired;
            next.task.next_fire_at = None;
        } else {
            next.task.status = Status::Active;
            if next.pending.is_none()
                && (next.task.next_fire_at.is_none()
                    || (next.misfire == Misfire::Skip
                        && next.task.next_fire_at.is_some_and(|at| at < now)))
            {
                next.task.next_fire_at = Some(
                    next.task
                        .schedule
                        .next_after(now, &TimeZone::get(&next.timezone)?)?
                        .ok_or_else(|| invalid("schedule has no remaining trigger"))?,
                );
            }
            next.check_expiry()?;
        }
        next.task.updated_at = next.task.updated_at.max(now);
        Ok(next)
    }
    pub fn snooze(&self, delay_ms: i64, now: i64) -> Result<Self, Error> {
        if delay_ms <= 0 {
            return Err(invalid("snooze must be positive"));
        }
        if self.task.status != Status::Active
            || (self.pending.is_some() && !self.waiting_notification())
        {
            return Err(invalid("only unclaimed active tasks can be snoozed"));
        }
        let at = self
            .task
            .next_fire_at
            .ok_or_else(|| invalid("task has no trigger"))?
            .max(now);
        let mut next = self.clone();
        next.cancel_waiting_notification();
        next.task.next_fire_at = Some(
            at.checked_add(delay_ms)
                .ok_or_else(|| invalid("time overflow"))?,
        );
        if let Some(at) = next.task.next_fire_at {
            crate::schedule::timestamp(at)?;
        }
        next.task.updated_at = next.task.updated_at.max(now);
        next.check_expiry()?;
        Ok(next)
    }
    pub fn clear_history(&self, now: i64) -> Self {
        let mut next = self.clone();
        next.task.runs.clear();
        next.task.last_error = None;
        next.task.updated_at = next.task.updated_at.max(now);
        next
    }
    fn check_expiry(&self) -> Result<(), Error> {
        if let (Some(next), Some(expires)) = (self.task.next_fire_at, self.task.expires_at)
            && next >= expires
        {
            return Err(invalid("next trigger is beyond task expiry"));
        }
        Ok(())
    }
}
fn apply<T>(patch: Patch<T>, field: &mut Option<T>) {
    match patch {
        Patch::Keep => {}
        Patch::Clear => *field = None,
        Patch::Set(value) => *field = Some(value),
    }
}
