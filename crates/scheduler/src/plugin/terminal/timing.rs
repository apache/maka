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

use super::{Action, Error, Page, Text, Value, display, empty, field, invalid};
use crate::{
    schedule::{Recurrence, Schedule},
    task::{Status, Task},
};
use jiff::{Timestamp, tz::TimeZone};
use std::collections::BTreeMap;

const FORMAT: &str = "%Y-%m-%d %H:%M %:z";

pub(super) fn title(schedule: &Schedule) -> Text {
    match schedule {
        Schedule::Once { .. } => Text::localized("Once", "单次", "單次"),
        Schedule::Interval { .. } => Text::localized("Interval", "固定间隔", "固定間隔"),
        Schedule::Calendar { recurrence, .. } => match recurrence {
            Recurrence::Daily => Text::localized("Daily", "每天", "每天"),
            Recurrence::Weekly => Text::localized("Weekly", "每周", "每週"),
            Recurrence::Monthly => Text::localized("Monthly", "每月", "每月"),
        },
        Schedule::Cron { .. } => Text::plain("Cron"),
    }
}
fn anchor(schedule: &Schedule) -> i64 {
    match schedule {
        Schedule::Once { run_at } => *run_at,
        Schedule::Interval { start_at, .. } | Schedule::Cron { start_at, .. } => *start_at,
        Schedule::Calendar { anchor_at, .. } => *anchor_at,
    }
}
fn date(at: i64, timezone: &str) -> Result<String, Error> {
    Ok(Timestamp::from_millisecond(at)
        .map_err(invalid)?
        .to_zoned(TimeZone::get(timezone).map_err(invalid)?)
        .strftime(FORMAT)
        .to_string())
}
pub(super) fn page(task: &Task, revision: u64, timezone: &str) -> Result<Page, Error> {
    let mut page = empty(title(&task.schedule), revision);
    page.body = format!("{}\n{}", display(&task.title, 512, false), timezone);
    page.fields = fields(&task.schedule, timezone)?;
    let enabled = matches!(task.status, Status::Active | Status::Paused);
    for field in &mut page.fields {
        field.enabled = enabled;
    }
    page.actions.push(Action {
        id: "save_schedule".into(),
        label: Text::localized("Save", "保存", "儲存"),
        enabled,
        fields: page.fields.iter().map(|field| field.id.clone()).collect(),
        recovery: None,
        confirm: None,
    });
    Ok(page)
}
pub(super) fn fields(
    schedule: &Schedule,
    timezone: &str,
) -> Result<Vec<maka_plugins::terminal_ui::page::Field>, Error> {
    let mut fields = vec![field(
        "at",
        Text::localized(
            "Start · UTC offset",
            "开始时间 · 时区偏移",
            "開始時間 · 時區偏移",
        ),
        date(anchor(schedule), timezone)?,
        64,
        false,
    )];
    match schedule {
        Schedule::Interval { every_seconds, .. } => fields.push(field(
            "seconds",
            Text::localized("Every (seconds)", "间隔（秒）", "間隔（秒）"),
            every_seconds.to_string(),
            16,
            false,
        )),
        Schedule::Cron { expression, .. } => fields.push(field(
            "expression",
            Text::localized("Cron expression", "Cron 表达式", "Cron 表達式"),
            expression.clone(),
            256,
            false,
        )),
        _ => {}
    }
    Ok(fields)
}
pub(super) fn update(
    original: &Schedule,
    timezone: &str,
    mut fields: BTreeMap<String, Value>,
) -> Result<Schedule, Error> {
    let input = take(&mut fields, "at")?;
    let previous = anchor(original);
    // Minute-level presentation must not round an unchanged persisted anchor.
    let at = if input == date(previous, timezone)? {
        previous
    } else {
        Timestamp::strptime(FORMAT, &input)
            .map_err(invalid)?
            .as_millisecond()
    };
    let schedule = match original {
        Schedule::Once { .. } => Schedule::Once { run_at: at },
        Schedule::Interval { .. } => Schedule::Interval {
            every_seconds: take(&mut fields, "seconds")?.parse().map_err(invalid)?,
            start_at: at,
        },
        Schedule::Calendar { recurrence, .. } => Schedule::Calendar {
            recurrence: *recurrence,
            anchor_at: at,
        },
        Schedule::Cron { .. } => Schedule::Cron {
            expression: take(&mut fields, "expression")?,
            start_at: at,
        },
    };
    if !fields.is_empty() {
        return Err(invalid("Unexpected schedule fields"));
    }
    schedule.validate().map_err(invalid)?;
    Ok(schedule)
}
fn take(fields: &mut BTreeMap<String, Value>, key: &str) -> Result<String, Error> {
    fields
        .remove(key)
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| invalid("Missing schedule field"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        plan::Plan,
        task::{Create, Creator, Effect, Notification},
    };
    use maka_plugins::terminal_ui::page::Control;

    #[test]
    fn timing_forms_round_trip_precise_anchors_and_validate_explicit_offsets_and_recurrence() {
        let at = Timestamp::strptime(FORMAT, "2026-11-01 01:30 -04:00")
            .unwrap()
            .as_millisecond()
            + 12_345;
        let schedules = [
            Schedule::Once { run_at: at },
            Schedule::Interval {
                every_seconds: 90,
                start_at: at,
            },
            Schedule::Calendar {
                recurrence: Recurrence::Daily,
                anchor_at: at,
            },
            Schedule::Calendar {
                recurrence: Recurrence::Weekly,
                anchor_at: at,
            },
            Schedule::Calendar {
                recurrence: Recurrence::Monthly,
                anchor_at: at,
            },
            Schedule::Cron {
                expression: "30 1 * * *".into(),
                start_at: at,
            },
        ];
        for schedule in schedules {
            let task = Plan::create(
                "one".into(),
                Create {
                    title: "Review".into(),
                    intent_body: "Read".into(),
                    schedule: schedule.clone(),
                    effect: Effect::Notify(Notification::Local),
                    max_fires: None,
                    expires_at: None,
                },
                Creator::User,
                "America/New_York".into(),
                at - 3_600_000,
            )
            .unwrap()
            .task;
            let page = page(&task, 7, "America/New_York").unwrap();
            page.clone().view("en").validate().unwrap();
            let mut fields = page
                .fields
                .into_iter()
                .map(|field| {
                    let Control::Text { value, .. } = field.control else {
                        panic!("text")
                    };
                    (field.id, Value::String(value))
                })
                .collect::<BTreeMap<_, _>>();
            assert_eq!(
                update(&schedule, "America/New_York", fields.clone()).unwrap(),
                schedule
            );
            fields.insert("at".into(), Value::String("2026-11-01 01:30 -05:00".into()));
            let edited = update(&schedule, "America/New_York", fields.clone()).unwrap();
            assert_eq!(
                anchor(&edited),
                at + 3_600_000 - 12_345,
                "fold offset remains explicit"
            );
            fields.insert("at".into(), Value::String("2026-11-01 01:30".into()));
            assert!(update(&schedule, "America/New_York", fields).is_err());
        }
        let interval = Schedule::Interval {
            every_seconds: 90,
            start_at: at,
        };
        let values = |seconds: &str| {
            BTreeMap::from([
                ("at".into(), Value::String(date(at, "UTC").unwrap())),
                ("seconds".into(), Value::String(seconds.into())),
            ])
        };
        assert!(update(&interval, "UTC", values("9")).is_err());
        let mut forged = values("90");
        forged.insert("effect".into(), Value::String("agent_run".into()));
        assert!(update(&interval, "UTC", forged).is_err());
    }
}
