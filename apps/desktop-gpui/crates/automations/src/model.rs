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

//! What the page says about a task and how it orders them, after Desktop's
//! packages/ui/src/scheduled-task-helpers.ts and scheduled-task-status.ts.
//! All pure: the caller passes "now" and the time zone, read once per
//! rebuild, never from `render`.

use std::cmp::Ordering;

use chrono::{DateTime, Datelike as _, TimeZone, Timelike as _};
use host_protocol::{
    ScheduledTask, ScheduledTaskBotPlatform, ScheduledTaskCalendarRecurrence, ScheduledTaskEffect,
    ScheduledTaskNotify, ScheduledTaskRunOutcome, ScheduledTaskSchedule, ScheduledTaskStatus,
};
use shared::copy::automations as copy;
use shared::copy::{self as shell_copy, Locale, Text};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

/// Parts of one line joined as Desktop joins them (`' · '`), the same in
/// every language.
pub fn dotted(parts: &[&str]) -> String {
    parts.join(shared::copy::conversation::FOOTER_SEPARATOR.en())
}

/// What a state means (Desktop's `StatusSemantic`), which picks its dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Semantic {
    /// Live, as a reminder waiting to fire: the accent dot.
    Active,
    /// Waiting on a person, or skipped on purpose: the warning dot.
    Attention,
    /// Broken: the destructive dot.
    Error,
    /// A settled fact: the quiet dot.
    Neutral,
}

/// After `scheduledTaskStatusSemantic`: completed is spent, everything
/// else is live, but paused is a settled choice, not a warning: the
/// warning dot is kept for a fire waiting on Maka Desktop (review round 9;
/// Desktop gives paused the attention tone).
pub fn status_semantic(status: &ScheduledTaskStatus) -> Semantic {
    match status {
        ScheduledTaskStatus::Paused | ScheduledTaskStatus::Completed => Semantic::Neutral,
        _ => Semantic::Active,
    }
}

/// `scheduledTaskRunStatusSemantic`: a run that fired is a record, not a
/// health signal.
pub fn run_semantic(outcome: &ScheduledTaskRunOutcome) -> Semantic {
    match outcome {
        ScheduledTaskRunOutcome::Blocked => Semantic::Attention,
        ScheduledTaskRunOutcome::Failed => Semantic::Error,
        _ => Semantic::Active,
    }
}

pub fn status_label(status: &ScheduledTaskStatus) -> Text {
    match status {
        ScheduledTaskStatus::Paused => copy::STATUS_PAUSED,
        ScheduledTaskStatus::Completed => copy::STATUS_COMPLETED,
        ScheduledTaskStatus::Expired => copy::STATUS_EXPIRED,
        _ => copy::STATUS_ACTIVE,
    }
}

pub fn run_label(outcome: &ScheduledTaskRunOutcome) -> Text {
    match outcome {
        ScheduledTaskRunOutcome::Blocked => copy::RUN_BLOCKED,
        ScheduledTaskRunOutcome::Failed => copy::RUN_FAILED,
        _ => copy::RUN_OK,
    }
}

/// Whether the task is over: completed or expired.
pub fn is_terminal(task: &ScheduledTask) -> bool {
    matches!(task.status, ScheduledTaskStatus::Completed | ScheduledTaskStatus::Expired)
}

/// Whether the task's delivery is one Maka Desktop's native effect service
/// performs (a local notification or a bot message).
pub fn delivered_by_desktop(task: &ScheduledTask) -> bool {
    matches!(task.effect, ScheduledTaskEffect::Notify(_))
}

/// Whether the task is due and its fire waits for a delivery service no
/// client here provides: an active notification task whose next fire has
/// passed, which the Host holds (`waiting_for_provider`) instead of
/// settling. `waiting` is a fire this client knows is held, from a Trigger
/// now the Host could not deliver.
pub fn awaits_desktop(task: &ScheduledTask, waiting: bool, now_ms: i64) -> bool {
    if !delivered_by_desktop(task) || task.status != ScheduledTaskStatus::Active {
        return false;
    }
    waiting || task.next_fire_at.is_some_and(|at| (at as i64) <= now_ms)
}

/// `formatScheduledTaskRecurrence`.
pub fn recurrence_label(task: &ScheduledTask, locale: Locale) -> String {
    match &task.schedule {
        ScheduledTaskSchedule::Once { .. } => copy::RECURRENCE_ONCE.in_locale(locale).to_owned(),
        ScheduledTaskSchedule::Cron { expression, .. } => copy::recurrence_cron(locale, expression),
        ScheduledTaskSchedule::Calendar { recurrence, .. } => {
            calendar_label(recurrence).in_locale(locale).to_owned()
        }
        ScheduledTaskSchedule::Interval { every_seconds, .. } => {
            copy::recurrence_interval(locale, *every_seconds)
        }
        _ => copy::UNSCHEDULED.in_locale(locale).to_owned(),
    }
}

pub fn calendar_label(recurrence: &ScheduledTaskCalendarRecurrence) -> Text {
    match recurrence {
        ScheduledTaskCalendarRecurrence::Weekly => copy::RECURRENCE_WEEKLY,
        ScheduledTaskCalendarRecurrence::Monthly => copy::RECURRENCE_MONTHLY,
        _ => copy::RECURRENCE_DAILY,
    }
}

/// `botDisplayLabel`: a platform's name; one this client does not know
/// reads as the Host gave it.
pub fn platform_label(platform: &ScheduledTaskBotPlatform, locale: Locale) -> String {
    let text = match platform {
        ScheduledTaskBotPlatform::Telegram => copy::BOT_TELEGRAM,
        ScheduledTaskBotPlatform::Wechat => copy::BOT_WECHAT,
        ScheduledTaskBotPlatform::Discord => copy::BOT_DISCORD,
        ScheduledTaskBotPlatform::Dingtalk => copy::BOT_DINGTALK,
        ScheduledTaskBotPlatform::Qq => copy::BOT_QQ,
        ScheduledTaskBotPlatform::Slack => copy::BOT_SLACK,
        other => return other.as_str().to_owned(),
    };
    text.in_locale(locale).to_owned()
}

/// `formatScheduledTaskDeliveryProviderList`: "Telegram / 微信 / …".
pub fn delivery_providers(locale: Locale) -> String {
    ScheduledTaskBotPlatform::DELIVERY
        .iter()
        .map(|platform| platform_label(platform, locale))
        .collect::<Vec<_>>()
        .join(" / ")
}

/// `formatScheduledTaskDeliveryTargetLabel`.
pub fn delivery_label(effect: &ScheduledTaskEffect, locale: Locale) -> String {
    match effect {
        ScheduledTaskEffect::Notify(ScheduledTaskNotify::Local) => {
            copy::DELIVERY_LOCAL.in_locale(locale).to_owned()
        }
        ScheduledTaskEffect::Notify(ScheduledTaskNotify::Bot { platform, chat_id }) => {
            dotted(&[&platform_label(platform, locale), chat_id])
        }
        _ => copy::DELIVERY_AGENT.in_locale(locale).to_owned(),
    }
}

/// `formatTaskTime`: month, day, hour, and minute as `Intl.DateTimeFormat`
/// writes them with two digits each: "09/28, 02:30 PM", "09/28 14:30",
/// "09/28 下午02:30".
pub fn task_time<Tz: TimeZone>(timestamp_ms: u64, zone: &Tz, locale: Locale) -> String {
    let Some(time) =
        i64::try_from(timestamp_ms).ok().and_then(|ms| zone.timestamp_millis_opt(ms).earliest())
    else {
        return String::new();
    };
    let (month, day, minute) = (time.month(), time.day(), time.minute());
    let (pm, hour12) = time.hour12();
    let period = if pm { shell_copy::TIME_PM } else { shell_copy::TIME_AM }.in_locale(locale);
    match locale {
        Locale::English => format!("{month:02}/{day:02}, {hour12:02}:{minute:02} {period}"),
        Locale::SimplifiedChinese => format!("{month:02}/{day:02} {:02}:{minute:02}", time.hour()),
        Locale::TraditionalChinese => {
            format!("{month:02}/{day:02} {period}{hour12:02}:{minute:02}")
        }
    }
}

/// `formatTaskCountdown`: how long until `timestamp_ms`, in minute, hour,
/// day, week, or month buckets.
pub fn countdown(timestamp_ms: u64, now_ms: i64, locale: Locale) -> String {
    let diff = timestamp_ms as i64 - now_ms;
    if diff <= -MINUTE_MS {
        return copy::COUNTDOWN_OVERDUE.in_locale(locale).to_owned();
    }
    if diff < MINUTE_MS {
        return copy::COUNTDOWN_SOON.in_locale(locale).to_owned();
    }
    let minutes = (diff as f64 / MINUTE_MS as f64).round() as u64;
    if minutes < 60 {
        return copy::countdown(
            locale,
            minutes,
            copy::COUNTDOWN_MINUTES_ONE,
            copy::COUNTDOWN_MINUTES_OTHER,
        );
    }
    let hours = (minutes as f64 / 60.).round() as u64;
    if hours < 24 {
        return copy::countdown(
            locale,
            hours,
            copy::COUNTDOWN_HOURS_ONE,
            copy::COUNTDOWN_HOURS_OTHER,
        );
    }
    let days = (hours as f64 / 24.).round() as u64;
    if days == 1 {
        return copy::COUNTDOWN_TOMORROW.in_locale(locale).to_owned();
    }
    if days < 7 {
        return copy::COUNTDOWN_DAYS.fill(locale, &[("count", &days.to_string())]);
    }
    if days < 30 {
        let weeks = (days as f64 / 7.).round() as u64;
        return copy::countdown(
            locale,
            weeks,
            copy::COUNTDOWN_WEEKS_ONE,
            copy::COUNTDOWN_WEEKS_OTHER,
        );
    }
    let months = (days as f64 / 30.).round() as u64;
    copy::countdown(locale, months, copy::COUNTDOWN_MONTHS_ONE, copy::COUNTDOWN_MONTHS_OTHER)
}

/// The list's sort (`ScheduledTaskSort`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum TaskSort {
    #[default]
    CreatedDesc,
    NextRunAsc,
    UpdatedDesc,
}

impl TaskSort {
    pub const ALL: [Self; 3] = [Self::CreatedDesc, Self::NextRunAsc, Self::UpdatedDesc];

    pub fn label(self) -> Text {
        match self {
            Self::CreatedDesc => copy::SORT_CREATED,
            Self::NextRunAsc => copy::SORT_NEXT_RUN,
            Self::UpdatedDesc => copy::SORT_UPDATED,
        }
    }
}

/// The status filter (`ScheduledTaskListFilter`): active and paused
/// together, all, or one status.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum TaskFilter {
    Current,
    #[default]
    All,
    Active,
    Paused,
    Completed,
    Expired,
}

impl TaskFilter {
    pub const ALL: [Self; 6] =
        [Self::Current, Self::All, Self::Active, Self::Paused, Self::Completed, Self::Expired];

    pub fn label(self) -> Text {
        match self {
            Self::Current => copy::FILTER_CURRENT,
            Self::All => copy::FILTER_ALL,
            Self::Active => copy::STATUS_ACTIVE,
            Self::Paused => copy::STATUS_PAUSED,
            Self::Completed => copy::STATUS_COMPLETED,
            Self::Expired => copy::STATUS_EXPIRED,
        }
    }

    pub fn keeps(self, task: &ScheduledTask) -> bool {
        match self {
            Self::All => true,
            Self::Current => {
                matches!(task.status, ScheduledTaskStatus::Active | ScheduledTaskStatus::Paused)
            }
            Self::Active => task.status == ScheduledTaskStatus::Active,
            Self::Paused => task.status == ScheduledTaskStatus::Paused,
            Self::Completed => task.status == ScheduledTaskStatus::Completed,
            Self::Expired => task.status == ScheduledTaskStatus::Expired,
        }
    }
}

/// The run history's range (`ScheduledTaskRunRange`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum RunRange {
    Day,
    #[default]
    Week,
    Month,
    All,
}

impl RunRange {
    pub const ALL: [Self; 4] = [Self::Day, Self::Week, Self::Month, Self::All];

    pub fn label(self) -> Text {
        match self {
            Self::Day => copy::RANGE_DAY,
            Self::Week => copy::RANGE_WEEK,
            Self::Month => copy::RANGE_MONTH,
            Self::All => copy::RANGE_ALL,
        }
    }

    /// `scheduledTaskRunRangeStart`: the earliest run shown, `None` for all
    /// of them. Today starts at local midnight.
    pub fn start<Tz: TimeZone>(self, now: &DateTime<Tz>) -> Option<i64> {
        let now_ms = now.timestamp_millis();
        match self {
            Self::All => None,
            Self::Day => {
                let midnight = now.date_naive().and_hms_opt(0, 0, 0)?;
                let start = now.timezone().from_local_datetime(&midnight).earliest()?;
                Some(start.timestamp_millis())
            }
            Self::Week => Some(now_ms - 7 * DAY_MS),
            Self::Month => Some(now_ms - 30 * DAY_MS),
        }
    }
}

/// `scheduledTaskStatusDisplayRank`.
fn display_rank(task: &ScheduledTask) -> u8 {
    match task.status {
        ScheduledTaskStatus::Active => 0,
        ScheduledTaskStatus::Paused => 1,
        ScheduledTaskStatus::Completed => 2,
        _ => 3,
    }
}

/// `compareScheduledTaskForDisplay`: active by next run, completed by last
/// run (newest first), otherwise by title.
fn compare_for_display(a: &ScheduledTask, b: &ScheduledTask) -> Ordering {
    let rank = display_rank(a).cmp(&display_rank(b));
    if rank != Ordering::Equal {
        return rank;
    }
    match (&a.status, &b.status) {
        (ScheduledTaskStatus::Active, ScheduledTaskStatus::Active) => {
            a.next_fire_at.unwrap_or(u64::MAX).cmp(&b.next_fire_at.unwrap_or(u64::MAX))
        }
        (ScheduledTaskStatus::Completed, ScheduledTaskStatus::Completed) => {
            let last = |task: &ScheduledTask| task.runs.first().map_or(0, |run| run.at);
            last(b).cmp(&last(a))
        }
        _ => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
    }
}

/// `compareScheduledTaskBySort`.
pub fn compare(a: &ScheduledTask, b: &ScheduledTask, sort: TaskSort) -> Ordering {
    match sort {
        TaskSort::CreatedDesc => {
            b.created_at.cmp(&a.created_at).then_with(|| compare_for_display(a, b))
        }
        TaskSort::UpdatedDesc => {
            b.updated_at.cmp(&a.updated_at).then_with(|| compare_for_display(a, b))
        }
        TaskSort::NextRunAsc => compare_for_display(a, b),
    }
}

/// `normalizeScheduledTaskSearchQuery`.
pub fn normalize_query(query: &str) -> String {
    query.trim().to_lowercase()
}

/// `scheduledTaskMatchesSearch` over `scheduledTaskSearchText`: the title,
/// notes, status, repeat rule, delivery, and every run.
pub fn matches_search(task: &ScheduledTask, query: &str, locale: Locale) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut text = vec![
        task.title.clone(),
        task.intent.body.clone(),
        task.status.as_str().to_owned(),
        recurrence_label(task, locale),
        delivery_label(&task.effect, locale),
    ];
    for run in &task.runs {
        text.push(format!("{} {}", run_label(&run.outcome).in_locale(locale), run.message));
    }
    text.join("\n").to_lowercase().contains(query)
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;
    use serde_json::json;

    use super::*;

    #[test]
    fn the_status_vocabulary_keeps_the_warning_for_what_waits_on_someone() {
        assert_eq!(status_semantic(&ScheduledTaskStatus::Active), Semantic::Active);
        assert_eq!(status_semantic(&ScheduledTaskStatus::Paused), Semantic::Neutral);
        assert_eq!(status_semantic(&ScheduledTaskStatus::Completed), Semantic::Neutral);
        assert_eq!(run_semantic(&ScheduledTaskRunOutcome::Failed), Semantic::Error);
    }

    fn task(overrides: serde_json::Value) -> ScheduledTask {
        let mut task = json!({
            "id": "t", "title": "Stand-up", "intent": {"kind": "text", "body": "Prepare notes"},
            "schedule": {"kind": "once", "runAt": 1}, "effect": {"kind": "notify", "channel": "local"},
            "status": "active", "nextFireAt": 1, "lastFireAt": null, "fireCount": 0,
            "maxFires": null, "expiresAt": null, "createdBy": {"kind": "user"},
            "createdAt": 1, "updatedAt": 1, "runs": [], "lastError": null
        });
        if let (Some(task), serde_json::Value::Object(overrides)) =
            (task.as_object_mut(), overrides)
        {
            task.extend(overrides);
        }
        serde_json::from_value(task).expect("task")
    }

    #[test]
    fn a_task_time_reads_as_intl_writes_it() {
        let zone = FixedOffset::east_opt(8 * 3600).expect("zone");
        // 2026-09-28 14:05 in UTC+8.
        let at = 1_790_575_500_000;
        assert_eq!(task_time(at, &zone, Locale::English), "09/28, 02:05 PM");
        assert_eq!(task_time(at, &zone, Locale::SimplifiedChinese), "09/28 14:05");
        assert_eq!(task_time(at, &zone, Locale::TraditionalChinese), "09/28 下午02:05");
    }

    #[test]
    fn a_countdown_picks_its_bucket() {
        let now = 1_000_000_000_000_i64;
        let at = |offset: i64| (now + offset) as u64;
        let en = Locale::English;
        assert_eq!(countdown(at(-2 * MINUTE_MS), now, en), "Overdue");
        assert_eq!(countdown(at(30_000), now, en), "Soon");
        assert_eq!(countdown(at(MINUTE_MS), now, en), "in 1 minute");
        assert_eq!(countdown(at(10 * MINUTE_MS), now, en), "in 10 minutes");
        assert_eq!(countdown(at(3 * 60 * MINUTE_MS), now, en), "in 3 hours");
        assert_eq!(countdown(at(DAY_MS), now, en), "Tomorrow");
        assert_eq!(countdown(at(3 * DAY_MS), now, en), "in 3 days");
        assert_eq!(countdown(at(14 * DAY_MS), now, en), "in 2 weeks");
        assert_eq!(countdown(at(60 * DAY_MS), now, en), "in 2 months");
        assert_eq!(countdown(at(10 * MINUTE_MS), now, Locale::SimplifiedChinese), "10 分钟后");
    }

    #[test]
    fn a_notification_task_past_its_fire_awaits_desktop() {
        let due = task(json!({"nextFireAt": 5}));
        assert!(awaits_desktop(&due, false, 10));
        assert!(!awaits_desktop(&due, false, 4), "not due yet");
        assert!(awaits_desktop(&due, true, 4), "a held Trigger now");
        let paused = task(json!({"status": "paused", "nextFireAt": 5}));
        assert!(!awaits_desktop(&paused, true, 10));
        let agent = task(json!({"effect": {"kind": "session_resume", "sessionId": "s"},
                                "nextFireAt": 5}));
        assert!(!awaits_desktop(&agent, false, 10), "the Host runs Agent tasks itself");
    }

    #[test]
    fn labels_follow_desktop() {
        let en = Locale::English;
        let cron = task(json!({"schedule": {"kind": "cron", "expression": "0 9 * * 1-5",
                                            "startAt": 1}}));
        assert_eq!(recurrence_label(&cron, en), "Cron: 0 9 * * 1-5");
        assert_eq!(recurrence_label(&cron, Locale::SimplifiedChinese), "Cron：0 9 * * 1-5");
        let bot = task(json!({"effect": {"kind": "notify", "channel": "bot",
                                         "platform": "wechat", "chatId": "42"}}));
        assert_eq!(delivery_label(&bot.effect, en), "微信 · 42");
        assert_eq!(delivery_providers(en), "Telegram / 微信 / Discord / 钉钉 / QQ / Slack");
        let agent = task(json!({"effect": {"kind": "session_resume", "sessionId": "s"}}));
        assert_eq!(delivery_label(&agent.effect, en), "Run via the Agent");
    }

    #[test]
    fn the_list_sorts_and_filters_as_desktop_does() {
        let a = task(json!({"id": "a", "title": "A", "createdAt": 1, "updatedAt": 9,
                            "nextFireAt": 50}));
        let b = task(json!({"id": "b", "title": "B", "createdAt": 2, "updatedAt": 3,
                            "nextFireAt": 20}));
        let c = task(json!({"id": "c", "title": "C", "createdAt": 3, "updatedAt": 1,
                            "status": "completed", "nextFireAt": null}));
        let order = |sort: TaskSort| {
            let mut tasks = [&a, &b, &c];
            tasks.sort_by(|x, y| compare(x, y, sort));
            tasks.map(|task| task.id.as_str())
        };
        assert_eq!(order(TaskSort::CreatedDesc), ["c", "b", "a"]);
        assert_eq!(order(TaskSort::UpdatedDesc), ["a", "b", "c"]);
        assert_eq!(order(TaskSort::NextRunAsc), ["b", "a", "c"], "active by next run first");
        assert!(TaskFilter::Current.keeps(&a) && !TaskFilter::Current.keeps(&c));
        assert!(TaskFilter::Completed.keeps(&c));
        assert!(matches_search(&a, &normalize_query("  PREPARE "), Locale::English));
        assert!(matches_search(&a, "local notification", Locale::English), "the delivery");
        assert!(!matches_search(&a, "weekly", Locale::English));
    }
}
