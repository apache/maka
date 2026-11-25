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

use super::{ScriptOutcome, ScriptPayload, StateUpdate, TaskPlan};
use crate::{
    Error,
    command::Update,
    schedule::{IntervalCadence, Schedule},
    task::{Create, Creator, Outcome, Run, Status, TaskEffect},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Delivery {
    Work(String),
}
impl TaskEffect for Delivery {
    fn validate(&self) -> Result<(), Error> {
        Ok(())
    }
}

// The numeric A is frozen owner metadata, not a Host permission or capability.
fn plan(effect: Delivery) -> TaskPlan<Delivery, u64> {
    TaskPlan::create(
        "task".into(),
        Create {
            title: "original".into(),
            intent_body: "original input".into(),
            schedule: Schedule::Interval {
                every_seconds: 1,
                start_at: 2_000,
                cadence: IntervalCadence::Fixed,
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

fn script_plan(every_seconds: u32) -> TaskPlan<Delivery, u64> {
    TaskPlan::create(
        "script".into(),
        Create {
            title: "Check".into(),
            intent_body: "Report".into(),
            schedule: Schedule::Script {
                source: "console.log(true)".into(),
                every_seconds,
                start_at: 2_000,
            },
            effect: Delivery::Work("report".into()),
            max_fires: None,
            expires_at: None,
        },
        Creator::User,
        "UTC".into(),
        1_000,
    )
    .unwrap()
}

#[test]
fn legacy_pending_boolean_fire_roundtrips_and_rearms_only_after_false() {
    let legacy = json!({
        "task": {"id":"script","title":"Check","intent":{"kind":"text","body":"Report"},
            "schedule":{"kind":"script","source":"console.log(true)","everySeconds":1,"startAt":2000},
            "effect":{"Work":"report"},"status":"active","nextFireAt":2000,"lastFireAt":null,
            "fireCount":0,"maxFires":null,"expiresAt":null,"createdBy":{"kind":"user"},
            "createdAt":1000,"updatedAt":2000,"runs":[],"lastError":null},
        "editRevision":1,"timezone":"UTC","misfire":"skip","authorization":null,"conditionMatched":true,
        "pending":{"id":"original","taskId":"script","scheduledAt":2000,"title":"Check",
            "intent":{"kind":"text","body":"Report"},"effect":{"Work":"report"},"authorization":null}
    });
    let mut plan: TaskPlan<Delivery, u64> = serde_json::from_value(legacy.clone()).unwrap();
    plan.validate().unwrap();
    assert_eq!(serde_json::to_value(&plan).unwrap(), legacy);
    plan.settle(outcome("original".into(), 2_000)).unwrap();
    for (at, check, fire) in [
        (3_000, true, false),
        (4_000, false, false),
        (5_000, true, true),
    ] {
        plan.record_condition(at, Ok(check.into())).unwrap();
        assert_eq!(plan.pending.is_some(), fire);
    }
}

#[test]
fn keyed_fires_freeze_payload_and_remember_the_last_key_across_false_checks() {
    let mut plan = script_plan(1);
    for (triggered, key, fire) in [
        (true, "e1", true),
        (true, "e1", false),
        (true, "e2", true),
        (false, "ignored", false),
        (true, "e2", false),
    ] {
        let at = plan.task.next_fire_at.unwrap();
        let payload = ScriptPayload {
            dedupe_key: Some(key.into()),
            summary: Some("evidence".into()),
            data: Some(json!(null)),
        };
        plan.record_condition(
            at,
            Ok(ScriptOutcome {
                triggered,
                payload: Some(payload.clone()),
                state_update: StateUpdate::Set(json!(key).to_string()),
            }),
        )
        .unwrap();
        plan = serde_json::from_value(serde_json::to_value(&plan).unwrap()).unwrap();
        assert_eq!(plan.script_state(), Some(json!(key).to_string().as_str()));
        assert_eq!(plan.pending.is_some(), fire);
        if let Some(pending) = &plan.pending {
            assert_eq!(pending.trigger_payload.as_ref(), Some(&payload));
            plan.settle(outcome(pending.id.clone(), at)).unwrap();
        }
    }
    assert_eq!(plan.task.fire_count, 2);
    assert_eq!(plan.last_dedupe_key.as_deref(), Some("e2"));
}

#[test]
fn nonmatching_checks_can_set_keep_and_clear_state() {
    let mut plan = script_plan(1);
    for (update, expected) in [
        (StateUpdate::Set("42".into()), Some("42")),
        (StateUpdate::Unchanged, Some("42")),
        (StateUpdate::Clear, None),
    ] {
        plan.record_condition(
            plan.task.next_fire_at.unwrap(),
            Ok(ScriptOutcome {
                state_update: update,
                ..false.into()
            }),
        )
        .unwrap();
        assert_eq!(plan.script_state(), expected);
        assert!(plan.pending.is_none());
    }
}

#[test]
fn script_errors_back_off_from_completion_and_success_restores_the_schedule() {
    let mut plan = script_plan(60);
    let mut at = 2_123;
    for (n, delay) in [60, 120, 240, 480, 960, 1800, 1800].into_iter().enumerate() {
        plan.record_condition(at, Err("unavailable".into()))
            .unwrap();
        plan = serde_json::from_value(serde_json::to_value(&plan).unwrap()).unwrap();
        assert_eq!(plan.consecutive_errors, n as u32 + 1);
        assert_eq!(plan.task.last_error.as_deref(), Some("unavailable"));
        at += delay * 1000;
        assert_eq!(plan.task.next_fire_at, Some(at));
    }
    plan.record_condition(at, Ok(false.into())).unwrap();
    assert_eq!(plan.consecutive_errors, 0);
    assert_eq!(plan.task.last_error, None);
    assert_eq!(plan.task.next_fire_at, Some(at - 123 + 60_000));

    let mut fast = script_plan(1);
    let mut at = 2_050;
    for delay in [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1800, 1800] {
        fast.record_condition(at, Err("unavailable".into()))
            .unwrap();
        at += delay * 1000;
        assert_eq!(fast.task.next_fire_at, Some(at));
    }
    fast.record_condition(at, Ok(false.into())).unwrap();
    assert_eq!(fast.consecutive_errors, 0);
    assert_eq!(fast.task.next_fire_at, Some(at - 50 + 1_000));

    let mut long = script_plan(3600);
    long.record_condition(2_000, Err("offline".into())).unwrap();
    assert_eq!(long.task.next_fire_at, Some(3_602_000));
    long.task.expires_at = Some(7_202_000);
    long.record_condition(3_602_000, Err("offline".into()))
        .unwrap();
    assert_eq!(
        (long.task.status, long.task.next_fire_at),
        (Status::Expired, None)
    );
}

#[test]
fn editing_script_source_rearms_checks_and_resets_backoff() {
    let mut plan = script_plan(1);
    plan.record_condition(
        2_000,
        Ok(ScriptOutcome {
            payload: Some(ScriptPayload {
                dedupe_key: Some("seen".into()),
                ..Default::default()
            }),
            state_update: StateUpdate::Set("1".into()),
            ..true.into()
        }),
    )
    .unwrap();
    plan.settle(outcome(plan.pending.as_ref().unwrap().id.clone(), 2_000))
        .unwrap();
    plan.record_condition(3_000, Err("failed".into())).unwrap();
    let mut edited = plan
        .update(
            Update {
                schedule: Some(Schedule::Script {
                    source: "console.log(false)".into(),
                    every_seconds: 1,
                    start_at: 2_000,
                }),
                ..Default::default()
            },
            3_100,
        )
        .unwrap();
    assert_eq!(
        (
            edited.consecutive_errors,
            edited.last_dedupe_key.as_deref(),
            edited.script_state()
        ),
        (0, None, Some("1"))
    );
    let interval = edited
        .update(
            Update {
                schedule: Some(Schedule::Interval {
                    every_seconds: 60,
                    start_at: 4_000,
                    cadence: Default::default(),
                }),
                ..Default::default()
            },
            3_200,
        )
        .unwrap();
    assert_eq!(interval.script_state(), None);
    let back_to_script = interval
        .update(
            Update {
                schedule: Some(Schedule::Script {
                    source: "console.log(true)".into(),
                    every_seconds: 1,
                    start_at: 4_000,
                }),
                ..Default::default()
            },
            3_300,
        )
        .unwrap();
    assert_eq!(back_to_script.script_state(), None);

    edited.record_condition(4_000, Ok(true.into())).unwrap();
    assert!(edited.pending.is_some());
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

    let saved = serde_json::to_value(&edited).unwrap();
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

#[test]
fn discovery_events_preserve_the_broad_deadline_across_settlement_and_restart() {
    use super::FireSource;
    const MIN: i64 = 60_000;
    for source in [FireSource::FileChange, FireSource::Watch] {
        let mut plan = plan(Delivery::Work("discovery".into()));
        plan.task.schedule = Schedule::Interval {
            every_seconds: 1800,
            start_at: 30 * MIN,
            cadence: IntervalCadence::AfterCompletion,
        };
        plan.task.next_fire_at = Some(30 * MIN);
        plan.task.expires_at = None;
        plan.task.max_fires = None;
        let fire = plan
            .claim_preserving_schedule(29 * MIN, source)
            .unwrap()
            .unwrap()
            .clone();
        assert_eq!(
            (fire.scheduled_at, fire.preserved_next_fire_at),
            (29 * MIN, Some(30 * MIN))
        );
        let mut reopened: TaskPlan<Delivery, u64> =
            serde_json::from_value(serde_json::to_value(plan).unwrap()).unwrap();
        for (end, max, status) in [
            (Some(31 * MIN), None, Status::Expired),
            (None, Some(1), Status::Completed),
        ] {
            let mut limited = reopened.clone();
            limited.task.expires_at = end;
            limited.task.max_fires = max;
            limited.settle(outcome(fire.id.clone(), 32 * MIN)).unwrap();
            assert_eq!(
                (limited.task.status, limited.task.next_fire_at),
                (status, None)
            );
        }
        reopened.settle(outcome(fire.id, 32 * MIN)).unwrap();
        assert_eq!(reopened.task.next_fire_at, Some(30 * MIN));
        assert!(
            reopened
                .claim_preserving_schedule(32 * MIN, source)
                .unwrap()
                .is_none()
        );
        let broad = reopened.claim(32 * MIN).unwrap().unwrap().clone();
        assert_eq!(
            (broad.source, broad.scheduled_at),
            (FireSource::Schedule, 30 * MIN)
        );
        reopened.settle(outcome(broad.id, 33 * MIN)).unwrap();
        assert_eq!(reopened.task.next_fire_at, Some(63 * MIN));
    }
}

#[test]
fn completion_interval_counts_from_settlement_and_survives_edit_and_reopen() {
    let mut plan = plan(Delivery::Work("work".into()));
    plan.task.expires_at = None;
    plan.misfire = super::Misfire::Latest;
    let mut plan = plan
        .update(
            Update {
                schedule: Some(Schedule::Interval {
                    every_seconds: 1,
                    start_at: 2_000,
                    cadence: IntervalCadence::AfterCompletion,
                }),
                ..Default::default()
            },
            1_500,
        )
        .unwrap();

    let fire = plan.claim(2_000).unwrap().unwrap().clone();
    assert_eq!(plan.claim(5_000).unwrap(), Some(&fire));
    plan.settle(outcome(fire.id, 5_250)).unwrap();
    assert_eq!(plan.task.next_fire_at, Some(6_250));
    assert!(plan.claim(6_249).unwrap().is_none());

    let edited = plan
        .pause(5_500)
        .update(
            Update {
                schedule: Some(Schedule::Interval {
                    every_seconds: 2,
                    start_at: 7_600,
                    cadence: IntervalCadence::AfterCompletion,
                }),
                ..Default::default()
            },
            5_600,
        )
        .unwrap();
    let mut reopened: TaskPlan<Delivery, u64> =
        serde_json::from_value(serde_json::to_value(edited).unwrap()).unwrap();
    reopened = reopened.resume(7_000).unwrap();
    assert!(reopened.claim(7_249).unwrap().is_none());
    reopened.recover(9_000).unwrap();
    assert_eq!(reopened.claim(9_000).unwrap().unwrap().scheduled_at, 7_250);
}
