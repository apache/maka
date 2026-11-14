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

use crate::{Error, cron::Cron, invalid};
use jiff::{Timestamp, ToSpan, civil::Date, tz::TimeZone};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Recurrence {
    Daily,
    Weekly,
    Monthly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Schedule {
    Script {
        source: String,
        #[serde(default = "script_interval")]
        every_seconds: u32,
        start_at: i64,
    },
    Once {
        run_at: i64,
    },
    Interval {
        every_seconds: u32,
        start_at: i64,
    },
    Calendar {
        recurrence: Recurrence,
        anchor_at: i64,
    },
    Cron {
        expression: String,
        start_at: i64,
    },
}
fn script_interval() -> u32 {
    60
}

impl Schedule {
    pub fn validate(&self) -> Result<(), Error> {
        if let Self::Script { source, .. } = self {
            crate::task::text(source)?;
        }
        let anchor = match self {
            Self::Once { run_at } => *run_at,
            Self::Script {
                every_seconds,
                start_at,
                ..
            }
            | Self::Interval {
                every_seconds,
                start_at,
            } => {
                if *every_seconds == 0 {
                    return Err(invalid("interval must be positive"));
                }
                *start_at
            }
            Self::Calendar { anchor_at, .. } => *anchor_at,
            Self::Cron {
                expression,
                start_at,
            } => {
                Cron::parse(expression)?;
                *start_at
            }
        };
        timestamp(anchor)?;
        Ok(())
    }

    /// Strictly after the supplied instant within the representable calendar.
    /// The plan's owner supplies its persisted timezone, never a mutable ambient
    /// timezone on each tick. Missed-fire policy is separate from this calculation.
    pub fn next_after(&self, after: i64, zone: &TimeZone) -> Result<Option<i64>, Error> {
        self.validate()?;
        timestamp(after)?;
        let next = match self {
            Self::Once { run_at } => Some(*run_at),
            Self::Script {
                every_seconds,
                start_at,
                ..
            }
            | Self::Interval {
                every_seconds,
                start_at,
            } => {
                let step = i64::from(*every_seconds) * 1000;
                if *start_at > after {
                    Some(*start_at)
                } else {
                    ((after - start_at) / step + 1)
                        .checked_mul(step)
                        .and_then(|elapsed| start_at.checked_add(elapsed))
                }
            }
            Self::Calendar {
                recurrence,
                anchor_at,
            } => {
                if *anchor_at > after {
                    Some(*anchor_at)
                } else {
                    calendar(*recurrence, *anchor_at, after, zone, false)?
                }
            }
            Self::Cron {
                expression,
                start_at,
            } => Cron::parse(expression)?.next(after, *start_at, zone)?,
        };
        Ok(next.filter(|next| *next > after && timestamp(*next).is_ok()))
    }

    /// The latest occurrence at or before the supplied instant.
    pub(crate) fn latest_at(&self, at: i64, zone: &TimeZone) -> Result<Option<i64>, Error> {
        self.validate()?;
        timestamp(at)?;
        let latest = match self {
            Self::Once { run_at } => Some(*run_at),
            Self::Script {
                every_seconds,
                start_at,
                ..
            }
            | Self::Interval {
                every_seconds,
                start_at,
            } if *start_at <= at => {
                let step = i64::from(*every_seconds) * 1000;
                Some(at - (at - start_at) % step)
            }
            Self::Script { .. } | Self::Interval { .. } => None,
            Self::Calendar {
                recurrence,
                anchor_at,
            } if *anchor_at <= at => {
                calendar(*recurrence, *anchor_at, at, zone, true)?.filter(|at| *at >= *anchor_at)
            }
            Self::Calendar { .. } => None,
            Self::Cron {
                expression,
                start_at,
            } => Cron::parse(expression)?.latest(at, *start_at, zone)?,
        };
        Ok(latest.filter(|latest| *latest <= at && timestamp(*latest).is_ok()))
    }
}
pub(crate) fn timestamp(milliseconds: i64) -> Result<Timestamp, Error> {
    if milliseconds < 0 {
        return Err(invalid("timestamp must not be negative"));
    }
    Ok(Timestamp::from_millisecond(milliseconds)?)
}
fn calendar(
    recurrence: Recurrence,
    anchor: i64,
    after: i64,
    zone: &TimeZone,
    backward: bool,
) -> Result<Option<i64>, Error> {
    let anchor = timestamp(anchor)?.to_zoned(zone.clone());
    let current = timestamp(after)?.to_zoned(zone.clone());
    let date = current.date();
    let direction = if backward { -1 } else { 1 };
    let mut offset = 0;
    loop {
        let candidate = match recurrence {
            Recurrence::Daily => match date.checked_add(offset.days()) {
                Ok(date) => date,
                Err(_) => return Ok(None),
            },
            Recurrence::Weekly => {
                let difference = anchor.weekday().to_monday_zero_offset()
                    - date.weekday().to_monday_zero_offset();
                let days = (difference * direction).rem_euclid(7) * direction;
                match date.checked_add((i64::from(days) + offset * 7).days()) {
                    Ok(date) => date,
                    Err(_) => return Ok(None),
                }
            }
            Recurrence::Monthly => {
                let month =
                    match Date::new(date.year(), date.month(), 1)?.checked_add(offset.months()) {
                        Ok(month) => month,
                        Err(_) => return Ok(None),
                    };
                Date::new(
                    month.year(),
                    month.month(),
                    anchor.day().min(month.days_in_month()),
                )?
            }
        };
        // Calendar recurrence fires once per local date. Compatible selects the
        // earlier fold and moves a nonexistent clock time forward across a gap.
        let at = zone
            .to_ambiguous_zoned(candidate.to_datetime(anchor.time()))
            .compatible()?
            .timestamp()
            .as_millisecond();
        if if backward { at <= after } else { at > after } {
            return Ok(Some(at));
        }
        offset += i64::from(direction);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: &str) -> i64 {
        value.parse::<Timestamp>().unwrap().as_millisecond()
    }
    #[test]
    fn cron_preserves_real_fold_occurrences_skips_gaps_and_matches_calendar_rules() {
        let ny = TimeZone::get("America/New_York").unwrap();
        let cron = |expression: &str| Schedule::Cron {
            expression: expression.into(),
            start_at: 0,
        };
        let first = cron("30 1 * * *")
            .next_after(ms("2026-11-01T05:00:00Z"), &ny)
            .unwrap()
            .unwrap();
        assert_eq!(first, ms("2026-11-01T05:30:00Z"));
        assert_eq!(
            cron("30 1 * * *").next_after(first, &ny).unwrap(),
            Some(ms("2026-11-01T06:30:00Z"))
        );
        assert_eq!(
            cron("30 2 * * *")
                .next_after(ms("2026-03-08T06:59:00Z"), &ny)
                .unwrap(),
            Some(ms("2026-03-09T06:30:00Z"))
        );
        assert_eq!(
            cron("30 1 * * *")
                .latest_at(ms("2026-11-01T06:45:00Z"), &ny)
                .unwrap(),
            Some(ms("2026-11-01T06:30:00Z"))
        );
        let utc = TimeZone::UTC;
        assert_eq!(
            cron("0 0 13 * 1")
                .next_after(ms("2026-09-13T00:00:00Z"), &utc)
                .unwrap(),
            Some(ms("2026-09-14T00:00:00Z"))
        );
        assert_eq!(
            cron("0 0 * * 7")
                .next_after(ms("2026-09-14T00:00:00Z"), &utc)
                .unwrap(),
            Some(ms("2026-09-20T00:00:00Z"))
        );
        assert_eq!(
            cron("*/15 9-17 * * 1-5")
                .next_after(ms("2026-09-18T17:45:00Z"), &utc)
                .unwrap(),
            Some(ms("2026-09-21T09:00:00Z"))
        );
        for invalid in [
            "0 0 31 2 *",
            "*/0 * * * *",
            "60 * * * *",
            "0 4-1 * * *",
            "0 0 * * MON",
            "0 0 * *",
        ] {
            assert!(cron(invalid).validate().is_err(), "{invalid}");
        }
    }
    #[test]
    fn sparse_cron_preserves_next_leap_day_beyond_one_year() {
        let schedule = Schedule::Cron {
            expression: "0 0 29 2 *".into(),
            start_at: ms("2025-01-01T00:00:00Z"),
        };
        schedule.validate().unwrap();
        assert_eq!(
            schedule
                .next_after(ms("2025-03-01T00:00:00Z"), &TimeZone::UTC)
                .unwrap(),
            Some(ms("2028-02-29T00:00:00Z"))
        );
    }

    #[test]
    fn calendar_keeps_anchor_after_month_clamping_and_dst_without_interval_drift() {
        let ny = TimeZone::get("America/New_York").unwrap();
        let monthly = Schedule::Calendar {
            recurrence: Recurrence::Monthly,
            anchor_at: ms("2026-01-31T14:00:00Z"),
        };
        let february = monthly
            .next_after(ms("2026-01-31T14:00:00Z"), &ny)
            .unwrap()
            .unwrap();
        assert_eq!(february, ms("2026-02-28T14:00:00Z"));
        assert_eq!(
            monthly.next_after(february, &ny).unwrap(),
            Some(ms("2026-03-31T13:00:00Z"))
        );
        assert_eq!(
            monthly.latest_at(ms("2026-03-30T12:00:00Z"), &ny).unwrap(),
            Some(february)
        );
        let daily = Schedule::Calendar {
            recurrence: Recurrence::Daily,
            anchor_at: ms("2026-03-07T07:30:00Z"),
        };
        let gap = daily
            .next_after(ms("2026-03-07T07:30:00Z"), &ny)
            .unwrap()
            .unwrap();
        assert_eq!(gap, ms("2026-03-08T07:30:00Z"));
        assert_eq!(
            daily.next_after(gap, &ny).unwrap(),
            Some(ms("2026-03-09T06:30:00Z"))
        );
        let interval = Schedule::Interval {
            every_seconds: 10,
            start_at: 1000,
        };
        assert_eq!(interval.next_after(35_999, &ny).unwrap(), Some(41_000));
        assert_eq!(
            Schedule::Once { run_at: 1000 }
                .next_after(1000, &ny)
                .unwrap(),
            None
        );
    }
}
