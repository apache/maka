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

//! The create and edit form's values, as Desktop's
//! packages/ui/src/scheduled-task-form-dialog.tsx keeps them, and the pure
//! parts of scheduled-task-helpers.ts behind it: the seeds a form opens
//! with (blank, a template, an edit, a duplicate), the quick time presets,
//! the validation messages, and the schedule and effect a submission sends.
//!
//! The task time is a local date and a local `HH:mm`, minute precision, as
//! Desktop's `YYYY-MM-DDTHH:mm` value is; the caller passes the time zone.

use chrono::{DateTime, Datelike as _, Duration, NaiveDate, NaiveTime, TimeZone, Timelike as _};
use host_protocol::{
    SCHEDULED_TASK_TITLE_MAX_CHARS, ScheduledTask, ScheduledTaskBotPlatform,
    ScheduledTaskCalendarRecurrence, ScheduledTaskDraft, ScheduledTaskEffect, ScheduledTaskNotify,
    ScheduledTaskPatch, ScheduledTaskSchedule,
};
use shared::copy::automations as copy;
use shared::copy::{Locale, Text};

use crate::cron::is_valid_cron;

/// The cron expression a blank form offers.
pub const DEFAULT_CRON: &str = "0 9 * * 1-5";

/// The form's Repeat (`ScheduledTaskRecurrence`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Recurrence {
    None,
    Daily,
    Weekly,
    Monthly,
    Cron,
    /// An Agent's fixed interval: shown, never chosen or changed.
    Interval,
}

impl Recurrence {
    /// What a person can choose (`recurrenceOptions`).
    pub const CHOOSABLE: [Self; 5] =
        [Self::None, Self::Daily, Self::Weekly, Self::Monthly, Self::Cron];

    pub fn label(self) -> Text {
        match self {
            Self::None => copy::REPEAT_NONE,
            Self::Daily => copy::RECURRENCE_DAILY,
            Self::Weekly => copy::RECURRENCE_WEEKLY,
            Self::Monthly => copy::RECURRENCE_MONTHLY,
            Self::Cron => copy::REPEAT_CRON,
            Self::Interval => copy::REPEAT_INTERVAL,
        }
    }

    /// `scheduledTaskRecurrenceValue`.
    fn of(schedule: &ScheduledTaskSchedule) -> Self {
        match schedule {
            ScheduledTaskSchedule::Interval { .. } => Self::Interval,
            ScheduledTaskSchedule::Cron { .. } => Self::Cron,
            ScheduledTaskSchedule::Calendar { recurrence, .. } => match recurrence {
                ScheduledTaskCalendarRecurrence::Weekly => Self::Weekly,
                ScheduledTaskCalendarRecurrence::Monthly => Self::Monthly,
                _ => Self::Daily,
            },
            _ => Self::None,
        }
    }
}

/// The form's Method (`ScheduledTaskDeliveryMethod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Local,
    Bot,
    /// An Agent task's effect: shown, never chosen or changed.
    AgentRun,
}

impl Method {
    /// What a person can choose (`deliveryOptions`).
    pub const CHOOSABLE: [Self; 2] = [Self::Local, Self::Bot];

    pub fn label(self) -> Text {
        match self {
            Self::Local => copy::DELIVERY_LOCAL,
            Self::Bot => copy::CHANNEL_BOT,
            Self::AgentRun => copy::DELIVERY_AGENT,
        }
    }
}

/// A quick task time (`presets`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Preset {
    TenMinutes,
    OneHour,
    TomorrowMorning,
    NextMonday,
}

impl Preset {
    pub const ALL: [Self; 4] =
        [Self::TenMinutes, Self::OneHour, Self::TomorrowMorning, Self::NextMonday];

    pub fn key(self) -> &'static str {
        match self {
            Self::TenMinutes => "ten-minutes",
            Self::OneHour => "one-hour",
            Self::TomorrowMorning => "tomorrow-morning",
            Self::NextMonday => "next-monday",
        }
    }

    pub fn label(self) -> Text {
        match self {
            Self::TenMinutes => copy::PRESET_TEN_MINUTES,
            Self::OneHour => copy::PRESET_ONE_HOUR,
            Self::TomorrowMorning => copy::PRESET_TOMORROW,
            Self::NextMonday => copy::PRESET_NEXT_MONDAY,
        }
    }

    /// `scheduledTaskPresetRunAt`: "next Monday" is never today, and the
    /// morning presets are 09:00 sharp.
    pub fn run_at<Tz: TimeZone>(self, now: &DateTime<Tz>) -> DateTime<Tz> {
        match self {
            Self::TenMinutes => now.clone() + Duration::minutes(10),
            Self::OneHour => now.clone() + Duration::hours(1),
            Self::TomorrowMorning => at_nine(now, 1),
            Self::NextMonday => {
                let day = now.weekday().num_days_from_sunday() as i64;
                let ahead = match (8 - day) % 7 {
                    0 => 7,
                    days => days,
                };
                at_nine(now, ahead)
            }
        }
    }
}

/// 09:00 local, `days` after `now`'s date.
fn at_nine<Tz: TimeZone>(now: &DateTime<Tz>, days: i64) -> DateTime<Tz> {
    let date = now.date_naive() + Duration::days(days);
    local(&now.timezone(), date, NaiveTime::from_hms_opt(9, 0, 0).unwrap_or_default())
        .unwrap_or_else(|| now.clone())
}

/// `date` at `time` in `zone`; the earlier one where a clock change
/// repeats it, `None` where it skips it.
fn local<Tz: TimeZone>(zone: &Tz, date: NaiveDate, time: NaiveTime) -> Option<DateTime<Tz>> {
    zone.from_local_datetime(&date.and_time(time)).earliest()
}

/// One of Desktop's example templates (`ScheduledTaskExampleTemplate`):
/// a cron task with its next run's weekday (Sunday 0), hour, and minute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Template {
    pub id: &'static str,
    pub title: Text,
    pub note: Text,
    pub when: Text,
    pub cron: &'static str,
    weekday: Option<u32>,
    hour: u32,
    minute: u32,
}

/// Desktop's four templates, in its order.
pub const TEMPLATES: [Template; 4] = [
    Template {
        id: "daily-download-cleanup",
        title: copy::TEMPLATE_DOWNLOADS,
        note: copy::TEMPLATE_DOWNLOADS_NOTE,
        when: copy::TEMPLATE_DOWNLOADS_WHEN,
        cron: "30 18 * * *",
        weekday: None,
        hour: 18,
        minute: 30,
    },
    Template {
        id: "midday-reset",
        title: copy::TEMPLATE_MIDDAY,
        note: copy::TEMPLATE_MIDDAY_NOTE,
        when: copy::TEMPLATE_MIDDAY_WHEN,
        cron: "30 12 * * 1-5",
        weekday: None,
        hour: 12,
        minute: 30,
    },
    Template {
        id: "weekend-todo-review",
        title: copy::TEMPLATE_WEEKEND,
        note: copy::TEMPLATE_WEEKEND_NOTE,
        when: copy::TEMPLATE_WEEKEND_WHEN,
        cron: "0 20 * * 0",
        weekday: Some(0),
        hour: 20,
        minute: 0,
    },
    Template {
        id: "daily-news-brief",
        title: copy::TEMPLATE_NEWS,
        note: copy::TEMPLATE_NEWS_NOTE,
        when: copy::TEMPLATE_NEWS_WHEN,
        cron: "30 9 * * *",
        weekday: None,
        hour: 9,
        minute: 30,
    },
];

impl Template {
    /// `scheduledTaskTemplateNextRunAt`: the next time the template's
    /// schedule comes round, never now or earlier.
    pub fn next_run_at<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> DateTime<Tz> {
        let time = NaiveTime::from_hms_opt(self.hour, self.minute, 0).unwrap_or_default();
        let mut date = now.date_naive();
        if let Some(weekday) = self.weekday {
            let today = now.weekday().num_days_from_sunday();
            date += Duration::days(((weekday + 7 - today) % 7) as i64);
        }
        let at = local(&now.timezone(), date, time).unwrap_or_else(|| now.clone());
        if at <= *now {
            let step = if self.weekday.is_some() { 7 } else { 1 };
            return local(&now.timezone(), date + Duration::days(step), time)
                .unwrap_or_else(|| now.clone());
        }
        at
    }
}

/// A local task time, minute precision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub date: NaiveDate,
    pub hour: u32,
    pub minute: u32,
}

impl LocalTime {
    /// `toScheduledTaskLocalDateTimeValue`: the minute `at` falls in.
    pub fn of<Tz: TimeZone>(at: &DateTime<Tz>) -> Self {
        Self { date: at.date_naive(), hour: at.hour(), minute: at.minute() }
    }

    /// `HH:mm`.
    pub fn clock(self) -> String {
        format!("{:02}:{:02}", self.hour, self.minute)
    }
}

/// `HH:mm` or `H:mm` as typed into the time field.
pub fn parse_clock(text: &str) -> Option<(u32, u32)> {
    let (hour, minute) = text.trim().split_once(':')?;
    if hour.is_empty() || hour.len() > 2 || minute.len() != 2 {
        return None;
    }
    let digits = |part: &str| part.chars().all(|c| c.is_ascii_digit());
    if !digits(hour) || !digits(minute) {
        return None;
    }
    let (hour, minute) = (hour.parse().ok()?, minute.parse().ok()?);
    (hour < 24 && minute < 60).then_some((hour, minute))
}

/// Milliseconds since the Unix epoch of `date` at `clock` in `zone`
/// (`Date.parse(runAtLocal)`); `None` for a clock that does not parse or a
/// local time the zone skips.
pub fn run_at_ms<Tz: TimeZone>(zone: &Tz, date: Option<NaiveDate>, clock: &str) -> Option<i64> {
    let (hour, minute) = parse_clock(clock)?;
    let time = NaiveTime::from_hms_opt(hour, minute, 0)?;
    local(zone, date?, time).map(|at| at.timestamp_millis())
}

/// What a form opens with (`ScheduledTaskFormSeed`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct FormSeed {
    /// The task an edit changes; `None` creates one.
    pub editing: Option<String>,
    pub title: String,
    pub note: String,
    pub run_at: LocalTime,
    pub recurrence: Recurrence,
    pub cron: String,
    pub method: Method,
    pub platform: ScheduledTaskBotPlatform,
    pub chat_id: String,
    /// The task's schedule, kept when an edit leaves the time and repeat
    /// as they were.
    original_schedule: Option<ScheduledTaskSchedule>,
    /// An Agent's interval, which the form keeps instead of making the task
    /// one-time.
    locked_schedule: Option<ScheduledTaskSchedule>,
    /// An Agent task's effect, frozen at creation: never rewritten as a
    /// notification.
    locked_effect: Option<ScheduledTaskEffect>,
}

impl FormSeed {
    /// `createScheduledTaskFormSeed`: an hour from now, one time, a local
    /// notification.
    pub fn blank<Tz: TimeZone>(now: &DateTime<Tz>) -> Self {
        Self {
            editing: None,
            title: String::new(),
            note: String::new(),
            run_at: LocalTime::of(&(now.clone() + Duration::hours(1))),
            recurrence: Recurrence::None,
            cron: DEFAULT_CRON.to_owned(),
            method: Method::Local,
            platform: ScheduledTaskBotPlatform::Telegram,
            chat_id: String::new(),
            original_schedule: None,
            locked_schedule: None,
            locked_effect: None,
        }
    }

    /// `scheduledTaskTemplateSeed`.
    pub fn template<Tz: TimeZone>(template: &Template, now: &DateTime<Tz>, locale: Locale) -> Self {
        Self {
            title: template.title.in_locale(locale).to_owned(),
            note: template.note.in_locale(locale).to_owned(),
            recurrence: Recurrence::Cron,
            cron: template.cron.to_owned(),
            run_at: LocalTime::of(&template.next_run_at(now)),
            ..Self::blank(now)
        }
    }

    /// `scheduledTaskEditSeed`.
    pub fn edit<Tz: TimeZone>(task: &ScheduledTask, now: &DateTime<Tz>) -> Self {
        let run_at = editable_run_at(task, now.timestamp_millis());
        let run_at = now
            .timezone()
            .timestamp_millis_opt(run_at)
            .earliest()
            .map_or_else(|| LocalTime::of(now), |at| LocalTime::of(&at));
        let (method, platform, chat_id) = match &task.effect {
            ScheduledTaskEffect::Notify(ScheduledTaskNotify::Bot { platform, chat_id }) => {
                (Method::Bot, platform.clone(), chat_id.clone())
            }
            ScheduledTaskEffect::Notify(_) => {
                (Method::Local, ScheduledTaskBotPlatform::Telegram, String::new())
            }
            _ => (Method::AgentRun, ScheduledTaskBotPlatform::Telegram, String::new()),
        };
        Self {
            editing: Some(task.id.clone()),
            title: task.title.clone(),
            note: task.intent.body.clone(),
            run_at,
            recurrence: Recurrence::of(&task.schedule),
            cron: match &task.schedule {
                ScheduledTaskSchedule::Cron { expression, .. } => expression.clone(),
                _ => DEFAULT_CRON.to_owned(),
            },
            method,
            platform,
            chat_id,
            original_schedule: Some(task.schedule.clone()),
            locked_schedule: matches!(task.schedule, ScheduledTaskSchedule::Interval { .. })
                .then(|| task.schedule.clone()),
            locked_effect: task.effect.is_agent().then(|| task.effect.clone()),
        }
    }

    /// `scheduledTaskDuplicateSeed`: an edit's values under a copy's title,
    /// creating a new task.
    pub fn duplicate<Tz: TimeZone>(
        task: &ScheduledTask,
        now: &DateTime<Tz>,
        locale: Locale,
    ) -> Self {
        Self { editing: None, title: duplicate_title(&task.title, locale), ..Self::edit(task, now) }
    }

    pub fn is_editing(&self) -> bool {
        self.editing.is_some()
    }
}

/// `scheduledTaskEditableRunAt`: the next fire while it is ahead, else the
/// schedule's own time while that is, else an hour from now.
fn editable_run_at(task: &ScheduledTask, now_ms: i64) -> i64 {
    if let Some(next) = task.next_fire_at.map(|at| at as i64).filter(|at| *at > now_ms) {
        return next;
    }
    let scheduled = match &task.schedule {
        ScheduledTaskSchedule::Once { run_at } => *run_at as i64,
        ScheduledTaskSchedule::Calendar { anchor_at, .. } => *anchor_at as i64,
        ScheduledTaskSchedule::Interval { start_at, .. }
        | ScheduledTaskSchedule::Cron { start_at, .. } => *start_at as i64,
        _ => 0,
    };
    if scheduled > now_ms { scheduled } else { now_ms + 60 * 60 * 1000 }
}

/// `duplicateScheduledTaskTitle`: " copy" once, within the title limit.
pub fn duplicate_title(title: &str, locale: Locale) -> String {
    let suffix = copy::DUPLICATE_SUFFIX.in_locale(locale);
    if title.ends_with(suffix) {
        return title.to_owned();
    }
    format!("{title}{suffix}").chars().take(SCHEDULED_TASK_TITLE_MAX_CHARS).collect()
}

/// The field a validation message belongs to (`ScheduledTaskValidationField`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Field {
    Title,
    Time,
    Cron,
    ChatId,
}

/// The form's values at one moment, as the submission reads them.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct FormValues {
    pub title: String,
    pub note: String,
    /// The task time as shown, `None` when the date or the clock does not
    /// parse.
    pub run_at: Option<LocalTime>,
    /// The same instant, `None` also for a local time the zone skips.
    pub run_at_ms: Option<i64>,
    pub recurrence: Recurrence,
    pub cron: String,
    pub method: Method,
    pub platform: ScheduledTaskBotPlatform,
    pub chat_id: String,
}

impl FormValues {
    /// The form's values as `seed` opens it, in `zone`.
    pub fn of_seed<Tz: TimeZone>(seed: &FormSeed, zone: &Tz) -> Self {
        Self {
            title: seed.title.clone(),
            note: seed.note.clone(),
            run_at: Some(seed.run_at),
            run_at_ms: run_at_ms(zone, Some(seed.run_at.date), &seed.run_at.clock()),
            recurrence: seed.recurrence,
            cron: seed.cron.clone(),
            method: seed.method,
            platform: seed.platform.clone(),
            chat_id: seed.chat_id.clone(),
        }
    }

    /// Sets the task time from the date picker's date and the time field's
    /// text, read in `zone`.
    pub fn set_run_at<Tz: TimeZone>(&mut self, zone: &Tz, date: Option<NaiveDate>, clock: &str) {
        self.run_at = date.zip(parse_clock(clock)).map(|(date, (hour, minute))| LocalTime {
            date,
            hour,
            minute,
        });
        self.run_at_ms = run_at_ms(zone, date, clock);
    }
}

/// `scheduledTaskFormValidation`: the first thing wrong, in the order
/// Desktop checks: the title, the time (valid, then in the future), the
/// cron expression, the chat id.
pub fn validate(values: &FormValues, now_ms: i64) -> Option<(Field, Text)> {
    if values.title.trim().is_empty() {
        return Some((Field::Title, copy::INVALID_TITLE));
    }
    let Some(run_at) = values.run_at_ms else {
        return Some((Field::Time, copy::INVALID_TIME));
    };
    if run_at <= now_ms {
        return Some((Field::Time, copy::PAST_TIME));
    }
    if values.recurrence == Recurrence::Cron && !is_valid_cron(&values.cron) {
        return Some((Field::Cron, copy::INVALID_CRON));
    }
    if values.method == Method::Bot && values.chat_id.trim().is_empty() {
        return Some((Field::ChatId, copy::INVALID_CHAT_ID));
    }
    None
}

/// What a submission sends.
#[derive(Debug, Clone, PartialEq)]
pub enum Submission {
    Create(ScheduledTaskDraft),
    Update { task_id: String, patch: ScheduledTaskPatch },
}

/// The submission of `values` for a form opened with `seed`, or `None`
/// while the form cannot be sent (`canCreate` and the `submit` guard): it
/// fails validation, an Agent's effect or interval would be lost, or the
/// schedule cannot be built.
pub fn submission(seed: &FormSeed, values: &FormValues, now_ms: i64) -> Option<Submission> {
    if validate(values, now_ms).is_some() {
        return None;
    }
    let effect = match values.method {
        Method::AgentRun => seed.locked_effect.clone()?,
        Method::Bot => ScheduledTaskEffect::bot(values.platform.clone(), values.chat_id.trim()),
        Method::Local => ScheduledTaskEffect::local(),
    };
    let schedule = schedule(seed, values)?;
    let (title, note) = (values.title.trim().to_owned(), values.note.trim().to_owned());
    match &seed.editing {
        Some(task_id) => {
            // A slug-only Agent template (before Connection ids) is kept as
            // it is; its title, notes, and schedule stay editable.
            let legacy = matches!(
                &seed.locked_effect,
                Some(ScheduledTaskEffect::AgentRun { execution })
                    if execution.llm_connection_id.is_none()
            );
            let mut patch = ScheduledTaskPatch::default().title(title).intent_body(note);
            if let Some(schedule) = schedule {
                patch = patch.schedule(schedule);
            }
            if !legacy {
                patch = patch.effect(effect);
            }
            Some(Submission::Update { task_id: task_id.clone(), patch })
        }
        None => Some(Submission::Create(ScheduledTaskDraft::new(title, note, schedule?, effect))),
    }
}

/// `scheduledTaskScheduleFromForm`: `Some(None)` when an edit leaves the
/// time and the repeat rule as they were (the task keeps its schedule),
/// `None` when there is none to build (an interval without the Agent's).
fn schedule(seed: &FormSeed, values: &FormValues) -> Option<Option<ScheduledTaskSchedule>> {
    let run_at = u64::try_from(values.run_at_ms?).ok()?;
    if seed.editing.is_some()
        && seed.original_schedule.is_some()
        && values.run_at == Some(seed.run_at)
        && values.recurrence == seed.recurrence
        && (values.recurrence != Recurrence::Cron || values.cron.trim() == seed.cron.trim())
    {
        return Some(None);
    }
    Some(Some(match values.recurrence {
        Recurrence::Interval => seed.locked_schedule.clone()?,
        Recurrence::None => ScheduledTaskSchedule::Once { run_at },
        Recurrence::Cron => ScheduledTaskSchedule::Cron {
            expression: values.cron.trim().to_owned(),
            start_at: run_at,
        },
        Recurrence::Daily => calendar(ScheduledTaskCalendarRecurrence::Daily, run_at),
        Recurrence::Weekly => calendar(ScheduledTaskCalendarRecurrence::Weekly, run_at),
        Recurrence::Monthly => calendar(ScheduledTaskCalendarRecurrence::Monthly, run_at),
    }))
}

fn calendar(recurrence: ScheduledTaskCalendarRecurrence, anchor_at: u64) -> ScheduledTaskSchedule {
    ScheduledTaskSchedule::Calendar { recurrence, anchor_at }
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;
    use serde_json::json;

    use super::*;

    fn zone() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).expect("zone")
    }

    /// Monday 2026-09-28 14:05:30 in UTC+8.
    fn now() -> DateTime<FixedOffset> {
        zone().with_ymd_and_hms(2026, 9, 28, 14, 5, 30).single().expect("now")
    }

    fn task(overrides: serde_json::Value) -> ScheduledTask {
        let mut task = json!({
            "id": "t1", "title": "Stand-up", "intent": {"kind": "text", "body": "Notes"},
            "schedule": {"kind": "cron", "expression": "0 9 * * 1-5", "startAt": 1},
            "effect": {"kind": "notify", "channel": "bot", "platform": "slack", "chatId": "C1"},
            "status": "active", "nextFireAt": 1_900_000_000_000_u64, "lastFireAt": null,
            "fireCount": 0, "maxFires": null, "expiresAt": null, "createdBy": {"kind": "user"},
            "createdAt": 1, "updatedAt": 1, "runs": [], "lastError": null
        });
        if let (Some(task), serde_json::Value::Object(overrides)) =
            (task.as_object_mut(), overrides)
        {
            task.extend(overrides);
        }
        serde_json::from_value(task).expect("task")
    }

    fn at(date: (i32, u32, u32), hour: u32, minute: u32) -> DateTime<FixedOffset> {
        zone().with_ymd_and_hms(date.0, date.1, date.2, hour, minute, 0).single().expect("at")
    }

    #[test]
    fn presets_land_where_their_labels_say() {
        let now = now();
        assert_eq!(Preset::TenMinutes.run_at(&now), now + Duration::minutes(10));
        assert_eq!(Preset::OneHour.run_at(&now), now + Duration::hours(1));
        assert_eq!(Preset::TomorrowMorning.run_at(&now), at((2026, 9, 29), 9, 0));
        // It is Monday: next Monday is a week away, never today.
        assert_eq!(Preset::NextMonday.run_at(&now), at((2026, 10, 5), 9, 0));
        let sunday = at((2026, 10, 4), 22, 0);
        assert_eq!(Preset::NextMonday.run_at(&sunday), at((2026, 10, 5), 9, 0));
    }

    #[test]
    fn templates_seed_their_next_run() {
        let now = now();
        let [downloads, midday, weekend, _] = TEMPLATES;
        assert_eq!(downloads.next_run_at(&now), at((2026, 9, 28), 18, 30), "later today");
        assert_eq!(midday.next_run_at(&now), at((2026, 9, 29), 12, 30), "12:30 has passed");
        assert_eq!(weekend.next_run_at(&now), at((2026, 10, 4), 20, 0), "the coming Sunday");
        let seed = FormSeed::template(&weekend, &now, Locale::English);
        assert_eq!(
            (seed.title.as_str(), seed.recurrence),
            ("Weekend task review", Recurrence::Cron)
        );
        assert_eq!(seed.cron, "0 20 * * 0");
        assert_eq!(seed.run_at.clock(), "20:00");
    }

    #[test]
    fn validation_reports_the_first_problem_in_desktops_order() {
        let now = now();
        let seed = FormSeed::blank(&now);
        let mut values = FormValues::of_seed(&seed, &zone());
        let now_ms = now.timestamp_millis();
        assert_eq!(validate(&values, now_ms), Some((Field::Title, copy::INVALID_TITLE)));
        values.title = "Stand-up".into();
        assert_eq!(validate(&values, now_ms), None);
        values.set_run_at(&zone(), Some(now.date_naive()), "25:00");
        assert_eq!(validate(&values, now_ms), Some((Field::Time, copy::INVALID_TIME)));
        values.set_run_at(&zone(), Some(now.date_naive()), "09:00");
        assert_eq!(validate(&values, now_ms), Some((Field::Time, copy::PAST_TIME)));
        values.set_run_at(&zone(), Some(now.date_naive()), "23:59");
        values.recurrence = Recurrence::Cron;
        values.cron = "0 9 * *".into();
        assert_eq!(validate(&values, now_ms), Some((Field::Cron, copy::INVALID_CRON)));
        values.cron = "0 9 * * 1-5".into();
        values.method = Method::Bot;
        values.chat_id = "  ".into();
        assert_eq!(validate(&values, now_ms), Some((Field::ChatId, copy::INVALID_CHAT_ID)));
        values.chat_id = " 42 ".into();
        let Some(Submission::Create(draft)) = submission(&seed, &values, now_ms) else {
            panic!("a create");
        };
        assert_eq!(
            draft.effect,
            ScheduledTaskEffect::bot(ScheduledTaskBotPlatform::Telegram, "42")
        );
        assert_eq!(
            draft.schedule,
            ScheduledTaskSchedule::Cron {
                expression: "0 9 * * 1-5".into(),
                start_at: at((2026, 9, 28), 23, 59).timestamp_millis() as u64,
            }
        );
    }

    #[test]
    fn an_edit_keeps_the_schedule_it_did_not_change() {
        let now = now();
        let task = task(json!({}));
        let seed = FormSeed::edit(&task, &now);
        assert_eq!((seed.method, seed.chat_id.as_str()), (Method::Bot, "C1"));
        let mut values = FormValues::of_seed(&seed, &zone());
        values.title = "Stand-up notes".into();
        let Some(Submission::Update { task_id, patch }) =
            submission(&seed, &values, now.timestamp_millis())
        else {
            panic!("an update");
        };
        assert_eq!(task_id, "t1");
        assert_eq!(patch.schedule, None, "the time and repeat are as they were");
        assert_eq!(patch.title.as_deref(), Some("Stand-up notes"));
        values.recurrence = Recurrence::Weekly;
        let Some(Submission::Update { patch, .. }) =
            submission(&seed, &values, now.timestamp_millis())
        else {
            panic!("an update");
        };
        assert!(matches!(
            patch.schedule,
            Some(ScheduledTaskSchedule::Calendar {
                recurrence: ScheduledTaskCalendarRecurrence::Weekly,
                ..
            })
        ));
    }

    #[test]
    fn an_agent_task_keeps_its_effect_and_interval() {
        let now = now();
        let agent = task(json!({
            "schedule": {"kind": "interval", "everySeconds": 600, "startAt": 1},
            "effect": {"kind": "session_resume", "sessionId": "s1"}
        }));
        let seed = FormSeed::edit(&agent, &now);
        assert_eq!((seed.method, seed.recurrence), (Method::AgentRun, Recurrence::Interval));
        let mut values = FormValues::of_seed(&seed, &zone());
        values.set_run_at(&zone(), Some(now.date_naive()), "23:00");
        let Some(Submission::Update { patch, .. }) =
            submission(&seed, &values, now.timestamp_millis())
        else {
            panic!("an update");
        };
        assert_eq!(patch.schedule, Some(agent.schedule.clone()), "the Agent's interval");
        assert_eq!(patch.effect, Some(agent.effect.clone()));
        let duplicate = FormSeed::duplicate(&agent, &now, Locale::English);
        assert_eq!((duplicate.editing, duplicate.title.as_str()), (None, "Stand-up copy"));
        assert_eq!(duplicate_title("Stand-up copy", Locale::English), "Stand-up copy");
    }

    #[test]
    fn a_clock_is_hours_and_minutes() {
        assert_eq!(parse_clock("9:05"), Some((9, 5)));
        assert_eq!(parse_clock(" 23:59 "), Some((23, 59)));
        for bad in ["", "9", "24:00", "12:60", "12:5", "ab:cd", "123:00"] {
            assert_eq!(parse_clock(bad), None, "{bad:?}");
        }
    }
}
