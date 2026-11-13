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

use super::TaskPlan;
use crate::{
    Error,
    command::Update,
    schedule::Schedule,
    task::{Create, Creator, Outcome, Run, Status, TaskEffect},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Delivery {
    Reminder,
    Work(String),
}
impl TaskEffect for Delivery {
    fn validate(&self) -> Result<(), Error> {
        Ok(())
    }
    fn is_notification(&self) -> bool {
        matches!(self, Self::Reminder)
    }
}

// The numeric A is frozen owner metadata, not a Host permission or capability.
fn plan(effect: Delivery) -> TaskPlan<Delivery, u64> {
    TaskPlan::create(
        "task".into(),
        Create {
            title: "original".into(),
            intent_body: if matches!(effect, Delivery::Reminder) {
                String::new()
            } else {
                "original input".into()
            },
            schedule: Schedule::Interval {
                every_seconds: 1,
                start_at: 2_000,
            },
            effect,
            max_fires: Some(2),
            expires_at: Some(4_000),
        },
        Creator::User,
        "UTC".into(),
        1_000,
    )
    .unwrap()
}

fn outcome(id: String, at: i64) -> Run {
    Run {
        id,
        at,
        outcome: Outcome::Ok,
        message: "delivery settled".into(),
        session_id: None,
        run_id: None,
    }
}

#[test]
fn pending_delivery_keeps_original_input_and_owner_metadata_after_edit_serialization_and_expiry() {
    let mut original = plan(Delivery::Work("original work".into()));
    original.authorization = Some(7);
    let fire = original.claim(2_000).unwrap().unwrap().clone();
    let edited = original
        .update(
            Update {
                title: Some("edited".into()),
                intent_body: Some("edited input".into()),
                effect: Some(Delivery::Work("edited work".into())),
                ..Default::default()
            },
            2_010,
        )
        .unwrap();
    assert_eq!(
        edited.authorization, None,
        "editing a future effect invalidates its approval"
    );
    assert_eq!(
        edited.pending.as_ref(),
        Some(&fire),
        "an admitted delivery does not inherit edited input or authority"
    );

    let mut saved = serde_json::to_value(&edited).unwrap();
    // This field exists in pending Fire data already persisted by the product.
    saved["pending"]["deliveryStarted"] = serde_json::Value::Bool(false);
    let mut reopened: TaskPlan<Delivery, u64> = serde_json::from_value(saved).unwrap();
    reopened.validate().unwrap();
    reopened.recover(8_000).unwrap();
    assert_eq!(
        reopened.claim(8_000).unwrap(),
        Some(&fire),
        "expiry cannot erase an original delivery requiring reconciliation"
    );
    let before = reopened.clone();
    assert!(
        reopened
            .settle(outcome("different fire".into(), 8_010))
            .is_err()
    );
    assert_eq!(
        reopened, before,
        "a different delivery cannot settle or mutate the pending one"
    );
    reopened.settle(outcome(fire.id.clone(), 8_010)).unwrap();
    assert_eq!(reopened.task.fire_count, 1);
    assert_eq!(reopened.task.runs.len(), 1);
    assert_eq!(reopened.task.runs[0].id, fire.id);
    assert_eq!(reopened.task.status, Status::Expired);
    assert!(
        reopened.claim(9_000).unwrap().is_none(),
        "settling the old delivery cannot dispatch edited work after expiry"
    );
}

#[test]
fn reminder_pause_and_snooze_cancel_only_a_delivery_that_has_not_started() {
    let mut waiting = plan(Delivery::Reminder);
    let fire = waiting.claim(2_000).unwrap().unwrap().clone();
    let paused = waiting.pause(2_010);
    assert_eq!(paused.task.status, Status::Paused);
    assert!(paused.pending.is_none());
    let mut snoozed = waiting.snooze(500, 2_010).unwrap();
    assert!(snoozed.pending.is_none());
    assert!(snoozed.claim(2_509).unwrap().is_none());
    let replacement = snoozed.claim(2_510).unwrap().unwrap();
    assert_ne!(replacement.id, fire.id);
    assert_eq!(replacement.scheduled_at, 2_510);

    // Starting delivery is domain state, not evidence of provider completion.
    waiting.pending.as_mut().unwrap().delivery_started = true;
    let bytes = serde_json::to_vec(&waiting).unwrap();
    let restored: TaskPlan<Delivery, u64> = serde_json::from_slice(&bytes).unwrap();
    assert!(restored.snooze(500, 2_010).is_err());
    let mut paused = restored.pause(2_010);
    assert!(paused.pending.as_ref().unwrap().delivery_started);
    let original_delivery = paused.pending.clone();
    paused.recover(8_000).unwrap();
    assert_eq!(
        paused.claim(8_000).unwrap(),
        original_delivery.as_ref(),
        "pause still permits reconciliation of a started original delivery"
    );
}

#[test]
fn resume_obeys_misfire_policy_and_preserves_due_now() {
    for misfire in [super::Misfire::Latest, super::Misfire::Skip] {
        for resume_at in [2_000, 3_500] {
            let mut original = plan(Delivery::Work("work".into()));
            original.task.expires_at = None;
            original.misfire = misfire;
            let mut resumed = original.pause(1_500).resume(resume_at).unwrap();
            resumed.validate().unwrap();
            if misfire == super::Misfire::Latest || resume_at == 2_000 {
                let fire = resumed.claim(resume_at).unwrap().unwrap().clone();
                let expected = if resume_at == 2_000 { 2_000 } else { 3_000 };
                assert_eq!(fire.scheduled_at, expected);
                resumed.settle(outcome(fire.id, resume_at)).unwrap();
                assert!(resumed.claim(resume_at).unwrap().is_none());
            } else {
                assert_eq!(resumed.task.next_fire_at, Some(4_000));
                assert!(resumed.claim(resume_at).unwrap().is_none());
            }
        }
    }
}

#[test]
fn reopen_catches_up_only_the_latest_missed_occurrence() {
    let mut plan = plan(Delivery::Work("work".into()));
    plan.task.expires_at = None;
    plan.misfire = super::Misfire::Latest;
    plan.recover(3_500).unwrap();
    assert_eq!(plan.claim(3_500).unwrap().unwrap().scheduled_at, 3_000);
}

#[test]
fn overdue_once_can_resume_with_latest_but_not_skip() {
    let mut original = plan(Delivery::Work("work".into()));
    original.task.schedule = Schedule::Once { run_at: 2_000 };
    let paused = original.pause(1_500);
    assert!(paused.resume(3_000).is_err());
    let mut paused = paused;
    paused.misfire = super::Misfire::Latest;
    let mut resumed = paused.resume(3_000).unwrap();
    resumed.validate().unwrap();
    let fire = resumed.claim(3_000).unwrap().unwrap().clone();
    assert_eq!(fire.scheduled_at, 2_000);
    resumed.settle(outcome(fire.id, 3_000)).unwrap();
    assert_eq!(resumed.task.status, Status::Completed);
    assert!(resumed.claim(3_001).unwrap().is_none());
    assert_eq!(paused.resume(4_000).unwrap().task.status, Status::Expired);
}

#[test]
fn resume_keeps_the_original_pending_fire_for_reconciliation() {
    let mut original = plan(Delivery::Work("work".into()));
    let fire = original.claim(2_000).unwrap().unwrap().clone();
    let mut resumed = original.pause(2_100).resume(3_500).unwrap();
    assert_eq!(resumed.claim(3_500).unwrap(), Some(&fire));
}
