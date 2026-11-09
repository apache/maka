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

#[cfg(test)]
use super::Plan;
use super::TaskPlan;
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
            if next.task.next_fire_at.is_none_or(|at| at <= now) && next.pending.is_none() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{Creator, Effect, Outcome, Run};

    #[test]
    fn old_tasks_can_reschedule_and_pending_calls_keep_their_intent_across_edits() {
        let plan = Plan::create(
            "task".into(),
            Create {
                title: "Original".into(),
                intent_body: "Work".into(),
                schedule: Schedule::Interval {
                    every_seconds: 10,
                    start_at: 1000,
                },
                effect: Effect::SessionResume {
                    session_id: "session".into(),
                },
                max_fires: None,
                expires_at: None,
            },
            Creator::User,
            "UTC".into(),
            1000,
        )
        .unwrap();
        // A reschedule uses real wall time even before recorded creation time.
        let mut rewound = plan
            .update(
                Update {
                    schedule: Some(Schedule::Once { run_at: 750 }),
                    ..Default::default()
                },
                500,
            )
            .unwrap();
        assert_eq!(rewound.task.updated_at, 1000);
        let mut recovered = rewound.clone();
        recovered.recover(800).unwrap();
        recovered.validate().unwrap();
        assert_eq!(recovered.task.updated_at, 1000);
        let fire = rewound.claim(750).unwrap().unwrap().clone();
        assert_eq!(fire.scheduled_at, 750);
        assert_eq!(rewound.task.updated_at, 1000);
        let mut restored: Plan =
            serde_json::from_value(serde_json::to_value(&rewound).unwrap()).unwrap();
        restored.validate().unwrap();
        assert_eq!(restored.pending.as_ref(), Some(&fire));
        restored.pending.as_mut().unwrap().scheduled_at = -1;
        assert!(restored.validate().is_err());
        let now = 2 * 366 * 24 * 60 * 60 * 1000;
        let mut next = plan
            .update(
                Update {
                    schedule: Some(Schedule::Once { run_at: now + 1000 }),
                    ..Update::default()
                },
                now,
            )
            .unwrap();
        next.validate().unwrap();
        // Unrelated later edits must not revalidate against the original creation time.
        next = next
            .update(
                Update {
                    title: Some("Rescheduled".into()),
                    ..Update::default()
                },
                now,
            )
            .unwrap();
        let fire = next.claim(now + 1000).unwrap().unwrap().clone();
        next = next
            .update(
                Update {
                    title: Some("New title".into()),
                    schedule: Some(Schedule::Interval {
                        every_seconds: 10,
                        start_at: now,
                    }),
                    ..Update::default()
                },
                now + 1000,
            )
            .unwrap()
            .pause(now + 1000);
        assert_eq!(next.pending.as_ref(), Some(&fire));
        next.settle(Run {
            id: fire.id,
            at: now + 2000,
            outcome: Outcome::Ok,
            message: "admitted".into(),
            session_id: Some("session".into()),
            run_id: Some(maka_agent_facts::durable::RunId::default()),
        })
        .unwrap();
        assert_eq!(next.task.status, Status::Paused);
        assert_eq!(next.task.fire_count, 1);
        next = next
            .resume(now + 3000)
            .unwrap()
            .snooze(1000, now + 3000)
            .unwrap();
        assert_eq!(next.task.next_fire_at, Some(now + 11_000));
        assert!(next.snooze(0, now + 3000).is_err());
        let cleared = next.clear_history(now + 4000);
        assert!(cleared.task.runs.is_empty());
        assert_eq!(cleared.task.fire_count, 1);
    }
}
