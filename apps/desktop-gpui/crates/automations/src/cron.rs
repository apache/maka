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

//! The one cron grammar scheduled tasks use, as the form checks it before
//! a task is sent: `compileCronExpression` in
//! packages/core/src/cron-expression.ts, without the search for the next
//! occurrence, which is the Host's.
//!
//! Five numeric fields separated by single spaces (minute, hour, day of
//! month, month, day of week); each a list of `*`, a number, or a range,
//! each optionally stepped (`*/15`, `1-5/2`, `9/3`). Sunday is 0 or 7.

/// A field's name and bounds (`FIELD_SPECS`).
struct Field {
    min: u32,
    max: u32,
}

const MINUTE: Field = Field { min: 0, max: 59 };
const HOUR: Field = Field { min: 0, max: 23 };
const DAY_OF_MONTH: Field = Field { min: 1, max: 31 };
const MONTH: Field = Field { min: 1, max: 12 };
const DAY_OF_WEEK: Field = Field { min: 0, max: 7 };

/// The most days each month can have (`MAX_DAYS_IN_MONTH`).
const MAX_DAYS_IN_MONTH: [u32; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// A parsed field: whether it was `*` somewhere, and the values it takes.
struct Parsed {
    wildcard: bool,
    values: Vec<u32>,
}

/// Whether `expression` is a cron expression the Host compiles.
pub fn is_valid_cron(expression: &str) -> bool {
    let parts: Vec<&str> = expression.split(' ').collect();
    let [minute, hour, day_of_month, month, day_of_week] = parts.as_slice() else {
        return false;
    };
    let (Some(_), Some(_), Some(day_of_month), Some(month), Some(day_of_week)) = (
        parse_field(minute, &MINUTE),
        parse_field(hour, &HOUR),
        parse_field(day_of_month, &DAY_OF_MONTH),
        parse_field(month, &MONTH),
        parse_field(day_of_week, &DAY_OF_WEEK),
    ) else {
        return false;
    };
    !impossible_date(&day_of_month, &month, &day_of_week)
}

/// `parseCronField`.
fn parse_field(input: &str, field: &Field) -> Option<Parsed> {
    if input.is_empty() || !input.chars().all(|c| c.is_ascii_digit() || "*,/-".contains(c)) {
        return None;
    }
    let mut values = Vec::new();
    let mut wildcard = false;
    for item in input.split(',') {
        if item.is_empty() {
            return None;
        }
        let parts: Vec<&str> = item.split('/').collect();
        if parts.len() > 2 {
            return None;
        }
        let base = parts[0];
        let step = match parts.get(1) {
            Some(step) => integer(step, 1, field.max - field.min + 1)?,
            None => 1,
        };
        let (start, end) = if base == "*" {
            wildcard = true;
            (field.min, field.max)
        } else if base.contains('-') {
            let range: Vec<&str> = base.split('-').collect();
            let [start, end] = range.as_slice() else {
                return None;
            };
            let (start, end) =
                (integer(start, field.min, field.max)?, integer(end, field.min, field.max)?);
            if start > end {
                return None;
            }
            (start, end)
        } else {
            let value = integer(base, field.min, field.max)?;
            (value, if parts.len() == 2 { field.max } else { value })
        };
        let mut candidate = start;
        while candidate <= end {
            // Sunday is 0 or 7.
            let value = if field.max == 7 && candidate == 7 { 0 } else { candidate };
            if !values.contains(&value) {
                values.push(value);
            }
            candidate += step;
        }
    }
    (!values.is_empty()).then_some(Parsed { wildcard, values })
}

/// `parseCronInteger`: digits only, within `min..=max`.
fn integer(input: &str, min: u32, max: u32) -> Option<u32> {
    if input.is_empty() || !input.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: u32 = input.parse().ok()?;
    (min..=max).contains(&value).then_some(value)
}

/// `hasImpossibleCalendarDate`: a day of the month no listed month has,
/// with no weekday to fall back on.
fn impossible_date(day_of_month: &Parsed, month: &Parsed, day_of_week: &Parsed) -> bool {
    if day_of_month.wildcard || month.wildcard || !day_of_week.wildcard {
        return false;
    }
    let max_days = month
        .values
        .iter()
        .map(|month| MAX_DAYS_IN_MONTH.get(*month as usize - 1).copied().unwrap_or(0))
        .max()
        .unwrap_or(0);
    day_of_month.values.iter().min().is_some_and(|day| *day > max_days)
}

#[cfg(test)]
mod tests {
    use super::is_valid_cron;

    #[test]
    fn the_desktop_examples_and_templates_compile() {
        for expression in [
            "0 9 * * 1-5",
            "30 18 * * *",
            "30 12 * * 1-5",
            "0 20 * * 0",
            "30 9 * * *",
            "0 20 * * 7",
        ] {
            assert!(is_valid_cron(expression), "{expression}");
        }
        assert!(is_valid_cron("*/15 0-23/2 1,15 */3 *"));
        assert!(is_valid_cron("5/10 * * * *"));
    }

    #[test]
    fn what_the_grammar_refuses() {
        for expression in [
            "",
            "0 9 * *",
            "0 9 * * * *",
            "0  9 * * *",
            "0 9 * * MON",
            "60 9 * * *",
            "0 24 * * *",
            "0 9 0 * *",
            "0 9 * 13 *",
            "0 9 * * 8",
            "0 9 5-1 * *",
            "0 9 1,,2 * *",
            "*/0 * * * *",
            "0 9 * * 1/2/3",
            "0 9 1-2-3 * *",
            // February never has a 30th.
            "0 9 30 2 *",
        ] {
            assert!(!is_valid_cron(expression), "{expression:?}");
        }
        // With a weekday the 30th of February can still match Mondays.
        assert!(is_valid_cron("0 9 30 2 1"));
    }
}
