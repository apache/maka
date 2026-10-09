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

//! Time formatting: the compact age a sidebar row shows, the day group a
//! row falls into, and the relative time a turn footer shows, in every
//! locale.
//!
//! All are pure: the caller passes "now" (and, for dates, the UTC offset),
//! so views read the clock and the time zone once per rebuild, never from
//! `render`, and tests pin them.

use chrono::{DateTime, Datelike as _, FixedOffset, Local, Offset as _, TimeZone, Timelike as _};

use crate::copy::{self, Locale, Text, plural};

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;
const DAY_MS: u64 = 24 * HOUR_MS;

const WEEK_MS: u64 = 7 * DAY_MS;

/// Unit, the first value that moves to the next unit, and the unit token.
/// Past the last bucket a row shows a date.
const AGE_BUCKETS: [(u64, u64, &str); 4] =
    [(MINUTE_MS, 60, "m"), (HOUR_MS, 24, "h"), (DAY_MS, 7, "d"), (WEEK_MS, 5, "w")];

/// The compact age of a timestamp for a sidebar row, short enough for its
/// fixed 40px lane in every locale: "now" (刚刚, 剛剛) for the first minute,
/// then "11m", "3h", "4d", "2w", each rounded to the nearest unit, and past
/// about a month the date: "Sep 3" ("9/3" in Chinese, whose "9月3日" can
/// outgrow the lane), or the year alone for an earlier year. `timestamp_ms`
/// is milliseconds since the Unix epoch; dates are counted in `now`'s time
/// zone. A timestamp in the future (clock skew) reads as now.
///
/// Maka Desktop's `formatSidebarTimestamp` (packages/core/src/relative-time.ts)
/// has the same shape with longer tokens ("46min", "1mo"); round 1 of the
/// design review shortened them so every age fits the lane.
pub fn compact_age<Tz: TimeZone>(locale: Locale, timestamp_ms: u64, now: &DateTime<Tz>) -> String {
    let now_ms = u64::try_from(now.timestamp_millis()).unwrap_or(0);
    let age = now_ms.saturating_sub(timestamp_ms);
    if age < MINUTE_MS {
        return copy::AGE_NOW.in_locale(locale).to_owned();
    }
    for (unit, limit, token) in AGE_BUCKETS {
        let value = (age as f64 / unit as f64).round() as u64;
        if value < limit {
            return format!("{value}{token}");
        }
    }
    short_date(locale, timestamp_ms, now)
}

/// The date of `timestamp_ms` in `now`'s zone, as short as a list lane
/// needs: month and day in `now`'s year ("Sep 3", "9/3"), else the year.
fn short_date<Tz: TimeZone>(locale: Locale, timestamp_ms: u64, now: &DateTime<Tz>) -> String {
    let Some(then) = i64::try_from(timestamp_ms)
        .ok()
        .and_then(|ms| now.timezone().timestamp_millis_opt(ms).earliest())
    else {
        return String::new();
    };
    if then.year() != now.year() {
        return then.year().to_string();
    }
    match locale {
        Locale::English => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            format!("{} {}", MONTHS[then.month0() as usize], then.day())
        }
        Locale::SimplifiedChinese | Locale::TraditionalChinese => {
            format!("{}/{}", then.month(), then.day())
        }
    }
}

/// How long ago a timestamp was, for a turn footer, as Maka's
/// `formatRelativeTimestamp` words it: "just now" for the first minute,
/// then rounded minutes, hours, and days ("5 minutes ago", "yesterday",
/// "3天前", "前天"), and past seven days the date and time in the zone
/// `offset_seconds` east of UTC ("Sep 18, 2026, 3:04 PM",
/// "2026年9月18日 15:04"). Milliseconds since the Unix epoch; a timestamp
/// in the future reads as just now.
pub fn relative_time(
    locale: Locale,
    timestamp_ms: u64,
    now_ms: u64,
    offset_seconds: i32,
) -> String {
    let age = now_ms.saturating_sub(timestamp_ms);
    if age < MINUTE_MS {
        return copy::AGE_JUST_NOW.in_locale(locale).to_owned();
    }
    if age > 7 * DAY_MS {
        return absolute_time(locale, timestamp_ms, offset_seconds);
    }
    let count = |text: Text, value: f64| text.fill(locale, &[("count", &value.to_string())]);
    let minutes = ((age as f64 / 1000.).round() / 60.).round();
    if minutes < 60. {
        let text = plural(minutes as u64, copy::AGO_MINUTES_ONE, copy::AGO_MINUTES_OTHER);
        return count(text, minutes);
    }
    let hours = (minutes / 60.).round();
    if hours < 24. {
        return count(plural(hours as u64, copy::AGO_HOURS_ONE, copy::AGO_HOURS_OTHER), hours);
    }
    match (hours / 24.).round() {
        1. => copy::AGO_YESTERDAY.in_locale(locale).to_owned(),
        2. => copy::AGO_TWO_DAYS.in_locale(locale).to_owned(),
        days => count(copy::AGO_DAYS, days),
    }
}

/// A timestamp for a list row with room for a phrase, as Maka's
/// `formatCompactTimestamp` words it: within seven days the relative time
/// ([`relative_time`]), else the date, "Sep 3" ("9月3日") in this year and
/// "Sep 3, 2025" ("2025年9月3日") before it, in the zone `offset_seconds`
/// east of UTC.
pub fn compact_timestamp(
    locale: Locale,
    timestamp_ms: u64,
    now_ms: u64,
    offset_seconds: i32,
) -> String {
    if now_ms.saturating_sub(timestamp_ms) <= 7 * DAY_MS {
        return relative_time(locale, timestamp_ms, now_ms, offset_seconds);
    }
    let zone = FixedOffset::east_opt(offset_seconds).unwrap_or_else(|| Local::now().offset().fix());
    let at =
        |ms: u64| i64::try_from(ms).ok().and_then(|ms| zone.timestamp_millis_opt(ms).earliest());
    let (Some(then), Some(now)) = (at(timestamp_ms), at(now_ms)) else {
        return String::new();
    };
    let (year, month, day) = (then.year(), then.month(), then.day());
    let this_year = year == now.year();
    match locale {
        Locale::English => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            let month = MONTHS[then.month0() as usize];
            if this_year { format!("{month} {day}") } else { format!("{month} {day}, {year}") }
        }
        Locale::SimplifiedChinese | Locale::TraditionalChinese => {
            if this_year {
                format!("{month}月{day}日")
            } else {
                format!("{year}年{month}月{day}日")
            }
        }
    }
}

/// Milliseconds since the Unix epoch of an ISO 8601 (RFC 3339) time such
/// as `2026-09-28T10:00:00.000Z`, the form the Host writes times in.
pub fn parse_iso_time(text: &str) -> Option<u64> {
    let time = DateTime::parse_from_rfc3339(text.trim()).ok()?;
    u64::try_from(time.timestamp_millis()).ok()
}

/// A timestamp as `Date.prototype.toISOString` writes it:
/// `2026-09-28T10:00:00.000Z`.
pub fn iso_time(timestamp_ms: u64) -> String {
    i64::try_from(timestamp_ms)
        .ok()
        .and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).earliest())
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// A timestamp's date and time as `Intl.DateTimeFormat` writes it with
/// `dateStyle: "medium", timeStyle: "short"`: "Sep 18, 2026, 3:04 PM",
/// "2026年9月18日 15:04", "2026年9月18日 下午3:04".
pub fn absolute_time(locale: Locale, timestamp_ms: u64, offset_seconds: i32) -> String {
    let zone = FixedOffset::east_opt(offset_seconds).unwrap_or_else(|| Local::now().offset().fix());
    let Some(time) =
        i64::try_from(timestamp_ms).ok().and_then(|ms| zone.timestamp_millis_opt(ms).earliest())
    else {
        return String::new();
    };
    let (pm, hour12) = time.hour12();
    let period = if pm { copy::TIME_PM } else { copy::TIME_AM }.in_locale(locale);
    let (year, month, day, minute) = (time.year(), time.month(), time.day(), time.minute());
    match locale {
        Locale::English => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            let month = MONTHS[time.month0() as usize];
            format!("{month} {day}, {year}, {hour12}:{minute:02} {period}")
        }
        Locale::SimplifiedChinese => {
            format!("{year}年{month}月{day}日 {:02}:{minute:02}", time.hour())
        }
        Locale::TraditionalChinese => {
            format!("{year}年{month}月{day}日 {period}{hour12}:{minute:02}")
        }
    }
}

/// A timestamp's date and time as `Date.prototype.toLocaleString` writes
/// it: "9/28/2026, 3:04:05 PM", "2026/9/28 15:04:05", "2026/9/28 下午3:04:05",
/// in the zone `offset_seconds` east of UTC.
pub fn locale_date_time(locale: Locale, timestamp_ms: u64, offset_seconds: i32) -> String {
    let zone = FixedOffset::east_opt(offset_seconds).unwrap_or_else(|| Local::now().offset().fix());
    let Some(time) =
        i64::try_from(timestamp_ms).ok().and_then(|ms| zone.timestamp_millis_opt(ms).earliest())
    else {
        return String::new();
    };
    let (pm, hour12) = time.hour12();
    let period = if pm { copy::TIME_PM } else { copy::TIME_AM }.in_locale(locale);
    let (year, month, day) = (time.year(), time.month(), time.day());
    let (minute, second) = (time.minute(), time.second());
    match locale {
        Locale::English => {
            format!("{month}/{day}/{year}, {hour12}:{minute:02}:{second:02} {period}")
        }
        Locale::SimplifiedChinese => {
            format!("{year}/{month}/{day} {:02}:{minute:02}:{second:02}", time.hour())
        }
        Locale::TraditionalChinese => {
            format!("{year}/{month}/{day} {period}{hour12}:{minute:02}:{second:02}")
        }
    }
}

/// The local time zone's offset from UTC now, in seconds east. Reads the
/// zone, so call it from an event or a rebuild, never from `render`.
pub fn local_utc_offset() -> i32 {
    Local::now().offset().fix().local_minus_utc()
}

/// The time group a list row falls into, newest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DayGroup {
    /// The same calendar day as now.
    Today,
    /// The calendar day before.
    Yesterday,
    /// Two to six calendar days ago.
    ThisWeek,
    /// Seven or more calendar days ago.
    Earlier,
}

impl DayGroup {
    /// Every group, in display order.
    pub const ALL: [Self; 4] = [Self::Today, Self::Yesterday, Self::ThisWeek, Self::Earlier];

    /// The group of `timestamp_ms` (milliseconds since the Unix epoch),
    /// counted in calendar days of `now`'s time zone. A timestamp in the
    /// future counts as today.
    pub fn of<Tz: TimeZone>(timestamp_ms: u64, now: &DateTime<Tz>) -> Self {
        let Some(then) = i64::try_from(timestamp_ms)
            .ok()
            .and_then(|ms| now.timezone().timestamp_millis_opt(ms).earliest())
        else {
            return Self::Earlier;
        };
        match (now.date_naive() - then.date_naive()).num_days() {
            ..=0 => Self::Today,
            1 => Self::Yesterday,
            2..=6 => Self::ThisWeek,
            _ => Self::Earlier,
        }
    }

    /// The group's heading.
    pub fn label(self) -> Text {
        match self {
            Self::Today => copy::GROUP_TODAY,
            Self::Yesterday => copy::GROUP_YESTERDAY,
            Self::ThisWeek => copy::GROUP_THIS_WEEK,
            Self::Earlier => copy::GROUP_EARLIER,
        }
    }

    /// A stable key for element ids and tests.
    pub fn key(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Yesterday => "yesterday",
            Self::ThisWeek => "this-week",
            Self::Earlier => "earlier",
        }
    }
}

#[cfg(test)]
mod iso_tests {
    use super::parse_iso_time;

    #[test]
    fn iso_times_read_as_milliseconds() {
        assert_eq!(parse_iso_time("1970-01-01T00:00:01.500Z"), Some(1_500));
        assert_eq!(
            parse_iso_time("2026-09-28T18:00:00+08:00"),
            parse_iso_time("2026-09-28T10:00:00Z")
        );
        assert_eq!(parse_iso_time("yesterday"), None);
    }
}

#[cfg(test)]
mod tests {
    use chrono::{FixedOffset, Utc};

    use super::*;

    const NOW: u64 = 1_790_000_000_000;

    /// `NOW` as a date in UTC.
    fn now() -> DateTime<Utc> {
        Utc.timestamp_millis_opt(NOW as i64).single().expect("now")
    }

    #[test]
    fn ages_are_compact_and_round_to_the_nearest_unit() {
        let compact_age = |age| compact_age(Locale::English, NOW - age, &now());
        let cases = [
            (0, "now"),
            (59_999, "now"),
            (60_000, "1m"),
            (11 * MINUTE_MS, "11m"),
            (59 * MINUTE_MS + 29_000, "59m"),
            (59 * MINUTE_MS + 31_000, "1h"),
            (3 * HOUR_MS, "3h"),
            (23 * HOUR_MS + 31 * MINUTE_MS, "1d"),
            (4 * DAY_MS, "4d"),
            (6 * DAY_MS + 13 * HOUR_MS, "1w"),
            (14 * DAY_MS, "2w"),
            (31 * DAY_MS, "4w"),
        ];
        for (age, expected) in cases {
            assert_eq!(compact_age(age), expected, "age {age} ms");
        }
    }

    #[test]
    fn past_a_month_a_row_shows_the_date_or_the_year() {
        let zone = FixedOffset::east_opt(8 * 3600).expect("offset");
        let now = zone.with_ymd_and_hms(2026, 9, 25, 10, 0, 0).single().expect("now");
        let at = |y, m, d| {
            zone.with_ymd_and_hms(y, m, d, 9, 0, 0).single().expect("time").timestamp_millis()
                as u64
        };
        assert_eq!(compact_age(Locale::English, at(2026, 8, 3), &now), "Aug 3");
        assert_eq!(compact_age(Locale::SimplifiedChinese, at(2026, 8, 3), &now), "8/3");
        assert_eq!(compact_age(Locale::TraditionalChinese, at(2026, 1, 30), &now), "1/30");
        assert_eq!(compact_age(Locale::English, at(2025, 12, 30), &now), "2025");
        // Every form stays short enough for the 40px lane.
        for locale in Locale::ALL {
            assert!(compact_age(locale, at(2026, 1, 30), &now).chars().count() <= 6);
        }
    }

    #[test]
    fn a_future_timestamp_reads_as_now() {
        assert_eq!(compact_age(Locale::English, NOW + DAY_MS, &now()), "now");
        assert_eq!(compact_age(Locale::SimplifiedChinese, NOW + DAY_MS, &now()), "刚刚");
        assert_eq!(compact_age(Locale::TraditionalChinese, NOW - 30_000, &now()), "剛剛");
        assert_eq!(compact_age(Locale::SimplifiedChinese, NOW - 46 * MINUTE_MS, &now()), "46m");
    }

    #[test]
    fn relative_times_round_to_the_nearest_unit_like_maka() {
        let ago = |locale, seconds: u64| relative_time(locale, NOW - seconds * 1000, NOW, 0);
        let en = Locale::English;
        assert_eq!(ago(en, 59), "just now");
        assert_eq!(ago(en, 60), "1 minute ago");
        assert_eq!(ago(en, 5 * 60 + 31), "6 minutes ago");
        assert_eq!(ago(en, 59 * 60 + 31), "1 hour ago");
        assert_eq!(ago(en, 3 * 3600), "3 hours ago");
        assert_eq!(ago(en, 30 * 3600), "yesterday");
        assert_eq!(ago(en, 2 * 86_400), "2 days ago");
        assert_eq!(ago(en, 3 * 86_400), "3 days ago");
        // As `Intl.RelativeTimeFormat("zh-CN" | "zh-TW", {numeric: "auto"})`.
        let (cn, tw) = (Locale::SimplifiedChinese, Locale::TraditionalChinese);
        assert_eq!(ago(cn, 59), "刚刚");
        assert_eq!(ago(cn, 3 * 60), "3分钟前");
        assert_eq!(ago(tw, 3 * 60), "3 分鐘前");
        assert_eq!(ago(cn, 3 * 3600), "3小时前");
        assert_eq!(ago(cn, 30 * 3600), "昨天");
        assert_eq!(ago(cn, 2 * 86_400), "前天");
        assert_eq!(ago(tw, 5 * 86_400), "5 天前");
    }

    #[test]
    fn past_a_week_the_date_and_time_show_in_each_locale() {
        // 2026-09-18 15:04 at UTC+8, as `Intl.DateTimeFormat` writes it.
        let zone = 8 * 3600;
        let then = FixedOffset::east_opt(zone)
            .and_then(|zone| zone.with_ymd_and_hms(2026, 9, 18, 15, 4, 0).single())
            .expect("time")
            .timestamp_millis() as u64;
        let now = then + 8 * DAY_MS;
        assert_eq!(relative_time(Locale::English, then, now, zone), "Sep 18, 2026, 3:04 PM");
        assert_eq!(
            relative_time(Locale::SimplifiedChinese, then, now, zone),
            "2026年9月18日 15:04"
        );
        assert_eq!(
            relative_time(Locale::TraditionalChinese, then, now, zone),
            "2026年9月18日 下午3:04"
        );
        let morning = then - 6 * 3_600_000 + 60_000;
        assert_eq!(absolute_time(Locale::SimplifiedChinese, morning, zone), "2026年9月18日 09:05");
        assert_eq!(
            absolute_time(Locale::TraditionalChinese, morning, zone),
            "2026年9月18日 上午9:05"
        );
    }

    #[test]
    fn groups_follow_calendar_days_in_the_local_zone() {
        // 2026-09-25 00:30 at UTC+8, which is still the 24th in UTC.
        let zone = FixedOffset::east_opt(8 * 3600).expect("offset");
        let now = zone.with_ymd_and_hms(2026, 9, 25, 0, 30, 0).single().expect("now");
        let ms = |y, m, d, h| {
            zone.with_ymd_and_hms(y, m, d, h, 0, 0).single().expect("time").timestamp_millis()
                as u64
        };
        assert_eq!(DayGroup::of(ms(2026, 9, 25, 0), &now), DayGroup::Today);
        assert_eq!(DayGroup::of(ms(2026, 9, 24, 23), &now), DayGroup::Yesterday);
        assert_eq!(DayGroup::of(ms(2026, 9, 24, 0), &now), DayGroup::Yesterday);
        assert_eq!(DayGroup::of(ms(2026, 9, 23, 12), &now), DayGroup::ThisWeek);
        assert_eq!(DayGroup::of(ms(2026, 9, 19, 12), &now), DayGroup::ThisWeek);
        assert_eq!(DayGroup::of(ms(2026, 9, 18, 12), &now), DayGroup::Earlier);
        assert_eq!(DayGroup::of(ms(2026, 9, 26, 12), &now), DayGroup::Today, "clock skew");
        // In UTC it is still the 24th, so 23:00 on the 24th at UTC+8 is today.
        let utc_now = now.with_timezone(&Utc);
        assert_eq!(DayGroup::of(ms(2026, 9, 24, 23), &utc_now), DayGroup::Today);
    }

    #[test]
    fn a_compact_timestamp_is_relative_within_a_week_then_a_date() {
        let zone = FixedOffset::east_opt(8 * 3600).expect("offset");
        let ms = |y, m, d| {
            zone.with_ymd_and_hms(y, m, d, 10, 0, 0).single().expect("time").timestamp_millis()
                as u64
        };
        let now = ms(2026, 9, 25);
        let offset = 8 * 3600;
        let en = |then| compact_timestamp(Locale::English, then, now, offset);
        let zh = |then| compact_timestamp(Locale::SimplifiedChinese, then, now, offset);
        assert_eq!(en(now - 3 * HOUR_MS), "3 hours ago");
        assert_eq!(en(ms(2026, 9, 18)), "7 days ago");
        assert_eq!(en(ms(2026, 9, 3)), "Sep 3");
        assert_eq!(zh(ms(2026, 9, 3)), "9月3日");
        assert_eq!(en(ms(2025, 12, 30)), "Dec 30, 2025");
        assert_eq!(zh(ms(2025, 12, 30)), "2025年12月30日");
    }

    #[test]
    fn a_date_and_time_reads_as_to_locale_string_writes_it() {
        let zone = FixedOffset::east_opt(8 * 3600).expect("offset");
        let at = zone.with_ymd_and_hms(2026, 9, 28, 15, 4, 5).single().expect("time");
        let ms = at.timestamp_millis() as u64;
        let offset = 8 * 3600;
        assert_eq!(locale_date_time(Locale::English, ms, offset), "9/28/2026, 3:04:05 PM");
        assert_eq!(locale_date_time(Locale::SimplifiedChinese, ms, offset), "2026/9/28 15:04:05");
        assert_eq!(
            locale_date_time(Locale::TraditionalChinese, ms, offset),
            "2026/9/28 下午3:04:05"
        );
    }

    #[test]
    fn an_iso_time_round_trips() {
        let text = "2026-09-28T10:00:00.123Z";
        assert_eq!(iso_time(parse_iso_time(text).expect("parse")), text);
    }

    #[test]
    fn groups_are_listed_in_display_order() {
        let mut sorted = DayGroup::ALL;
        sorted.sort();
        assert_eq!(sorted, DayGroup::ALL);
    }
}
