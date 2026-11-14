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

use crate::{Error, invalid};
use jiff::{Timestamp, civil::Date, tz::TimeZone};

/// The product's five numeric cron fields: lists, ranges, steps, Sunday 0 or 7.
/// Bits avoid allocating sets while evaluating recurring plans.
pub(crate) struct Cron {
    minute: Field,
    hour: Field,
    day: Field,
    month: Field,
    weekday: Field,
}
struct Field {
    bits: u64,
    wildcard: bool,
}
impl Field {
    fn parse(input: &str, min: u8, max: u8, sunday: bool) -> Result<Self, Error> {
        let mut result = Self {
            bits: 0,
            wildcard: false,
        };
        let integer = |text: &str, low: u8, high: u8| {
            if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid("cron fields must be numeric"));
            }
            text.parse::<u8>()
                .ok()
                .filter(|value| (low..=high).contains(value))
                .ok_or_else(|| invalid("cron field is out of range"))
        };
        for item in input.split(',') {
            let (base, step) = match item.split_once('/') {
                Some((base, step)) => (base, Some(integer(step, 1, max - min + 1)?)),
                None => (item, None),
            };
            let (start, end) = if base == "*" {
                result.wildcard = true;
                (min, max)
            } else if let Some((start, end)) = base.split_once('-') {
                (integer(start, min, max)?, integer(end, min, max)?)
            } else {
                let start = integer(base, min, max)?;
                (start, if step.is_some() { max } else { start })
            };
            if start > end {
                return Err(invalid("cron range is reversed"));
            }
            for value in (start..=end).step_by(usize::from(step.unwrap_or(1))) {
                let value = if sunday && value == 7 { 0 } else { value };
                result.bits |= 1 << value;
            }
        }
        Ok(result)
    }
    fn contains(&self, value: i8) -> bool {
        self.bits & (1 << value) != 0
    }
    fn values(&self) -> impl Iterator<Item = i8> + '_ {
        (0..60).filter(|value| self.contains(*value))
    }
}
impl Cron {
    pub fn parse(expression: &str) -> Result<Self, Error> {
        let fields: Vec<_> = expression.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = fields.as_slice() else {
            return Err(invalid("cron requires five fields"));
        };
        let cron = Self {
            minute: Field::parse(minute, 0, 59, false)?,
            hour: Field::parse(hour, 0, 23, false)?,
            day: Field::parse(day, 1, 31, false)?,
            month: Field::parse(month, 1, 12, false)?,
            weekday: Field::parse(weekday, 0, 7, true)?,
        };
        if cron.weekday.wildcard
            && !cron.day.wildcard
            && !cron.month.values().any(|month| {
                let max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month as usize - 1];
                cron.day.values().any(|day| day <= max)
            })
        {
            return Err(invalid("cron has no possible calendar date"));
        }
        Ok(cron)
    }
    fn matches_date(&self, date: Date) -> bool {
        if !self.month.contains(date.month()) {
            return false;
        }
        let day = self.day.contains(date.day());
        let weekday = self
            .weekday
            .contains(date.weekday().to_sunday_zero_offset());
        if !self.day.wildcard && !self.weekday.wildcard {
            day || weekday
        } else {
            day && weekday
        }
    }
    pub fn next(&self, after: i64, not_before: i64, zone: &TimeZone) -> Result<Option<i64>, Error> {
        let Some(lower) = after.checked_add(1).map(|next| next.max(not_before)) else {
            return Ok(None);
        };
        if lower > Timestamp::MAX.as_millisecond() {
            return Ok(None);
        }
        let first = Timestamp::from_millisecond(lower)?
            .to_zoned(zone.clone())
            .date();
        // Iterate the finite representable Gregorian calendar, jumping over
        // unselected months. Sparse dates (including century leap years) do not
        // impose an elapsed-time horizon or require scanning individual minutes.
        for year in first.year()..=Date::MAX.year() {
            for month in self.month.values() {
                if year == first.year() && month < first.month() {
                    continue;
                }
                let month_start = Date::new(year, month, 1)?;
                for day in 1..=month_start.days_in_month() {
                    let date = Date::new(year, month, day)?;
                    if date < first || !self.matches_date(date) {
                        continue;
                    }
                    if let Some(next) = self.on_date(date, zone, |at| at >= lower, i64::min)? {
                        return Ok(Some(next));
                    }
                }
            }
        }
        Ok(None)
    }

    pub fn latest(&self, at: i64, not_before: i64, zone: &TimeZone) -> Result<Option<i64>, Error> {
        if at < not_before {
            return Ok(None);
        }
        let first = Timestamp::from_millisecond(not_before)?
            .to_zoned(zone.clone())
            .date();
        let last = Timestamp::from_millisecond(at)?
            .to_zoned(zone.clone())
            .date();
        for year in (first.year()..=last.year()).rev() {
            for month in (1..=12).rev().filter(|month| self.month.contains(*month)) {
                if (year == first.year() && month < first.month())
                    || (year == last.year() && month > last.month())
                {
                    continue;
                }
                let month_start = Date::new(year, month, 1)?;
                for day in (1..=month_start.days_in_month()).rev() {
                    let date = Date::new(year, month, day)?;
                    if date < first || date > last || !self.matches_date(date) {
                        continue;
                    }
                    let in_range = |candidate| (not_before..=at).contains(&candidate);
                    if let Some(latest) = self.on_date(date, zone, in_range, i64::max)? {
                        return Ok(Some(latest));
                    }
                }
            }
        }
        Ok(None)
    }

    fn on_date(
        &self,
        date: Date,
        zone: &TimeZone,
        in_range: impl Fn(i64) -> bool,
        select: impl Fn(i64, i64) -> i64,
    ) -> Result<Option<i64>, Error> {
        let mut selected = None;
        for hour in self.hour.values() {
            for minute in self.minute.values() {
                let local = date.at(hour, minute, 0, 0);
                let ambiguous = zone.to_ambiguous_zoned(local);
                // Gaps have no matching wall time; folds have two real occurrences.
                for resolved in [ambiguous.clone().earlier()?, ambiguous.later()?] {
                    let at = resolved.timestamp().as_millisecond();
                    if resolved.datetime() == local && in_range(at) {
                        selected = Some(selected.map_or(at, |previous| select(previous, at)));
                    }
                }
            }
        }
        Ok(selected)
    }
}
