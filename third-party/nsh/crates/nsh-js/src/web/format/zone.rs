//! Named time zones the app ships (nsh.json `timeZones`): their rules from
//! the IANA Time Zone Database, as `nsh-i18n` writes them into the bundle
//! (`nsh_i18n::zones`), registered per VM before the app runs
//! ([`Zones::add`]). A zone's offset at a time comes from its transitions,
//! and past the last of them from its POSIX TZ rule (TZif's footer).

use serde::Deserialize;
use serde_json::Value;

/// A VM's named zones.
#[derive(Default)]
pub(crate) struct Zones {
    zones: Vec<NamedZone>,
}

impl Zones {
    /// Registers `zones` (`nsh_i18n::zones`' JSON), replacing a zone of the
    /// same name. A zone that does not read is left out with a warning.
    pub(crate) fn add(&mut self, zones: Vec<Value>) {
        for value in zones {
            match NamedZone::read(value) {
                Ok(zone) => match self.zones.iter_mut().find(|z| z.name == zone.name) {
                    Some(old) => *old = zone,
                    None => self.zones.push(zone),
                },
                Err(e) => log::warn!("time zone data: {e}"),
            }
        }
    }

    /// The zone named `name` (any case), by index.
    pub(crate) fn find(&self, name: &str) -> Option<u16> {
        self.zones
            .iter()
            .position(|z| z.name.eq_ignore_ascii_case(name))
            .and_then(|i| u16::try_from(i).ok())
    }

    pub(crate) fn get(&self, index: u16) -> &NamedZone {
        &self.zones[usize::from(index)]
    }
}

#[derive(Deserialize)]
struct Data {
    name: String,
    types: Vec<(i32, String)>,
    transitions: Vec<(i64, u8)>,
    rule: Option<String>,
}

/// A zone of the database.
#[derive(Debug)]
pub(crate) struct NamedZone {
    /// As the database writes it (`America/New_York`).
    pub(crate) name: String,
    /// Offsets (seconds east of UTC) and their abbreviations.
    types: Vec<(i32, String)>,
    /// From when (seconds since the epoch) a type applies, in order.
    transitions: Vec<(i64, u8)>,
    /// After the last transition.
    rule: Option<Rule>,
}

impl NamedZone {
    fn read(value: Value) -> Result<NamedZone, String> {
        let data = Data::deserialize(value).map_err(|e| e.to_string())?;
        let name = data.name;
        if data.types.is_empty()
            || data
                .transitions
                .iter()
                .any(|(_, t)| usize::from(*t) >= data.types.len())
        {
            return Err(format!("`{name}`: a transition to a type it does not have"));
        }
        let rule = match data.rule {
            Some(text) => {
                Some(Rule::parse(&text).ok_or_else(|| format!("`{name}`: rule `{text}`"))?)
            }
            None => None,
        };
        Ok(NamedZone {
            name,
            types: data.types,
            transitions: data.transitions,
            rule,
        })
    }

    /// The offset (seconds east of UTC) and its abbreviation at `ms`
    /// (milliseconds since the epoch).
    pub(crate) fn at(&self, ms: f64) -> (i32, &str) {
        let seconds = (ms / 1000.0).floor() as i64;
        let after = self.transitions.partition_point(|(at, _)| *at <= seconds);
        if after == self.transitions.len()
            && let Some(rule) = &self.rule
        {
            return rule.at(seconds);
        }
        let ty = match after {
            0 => 0,
            n => usize::from(self.transitions[n - 1].1),
        };
        let (offset, abbr) = &self.types[ty];
        (*offset, abbr)
    }
}

/// A POSIX TZ rule (`EST5EDT,M3.2.0,M11.1.0`): standard time, and
/// daylight saving time between two days of each year.
#[derive(Debug, PartialEq)]
struct Rule {
    std: (String, i32),
    dst: Option<Dst>,
}

#[derive(Debug, PartialEq)]
struct Dst {
    /// The abbreviation and offset (seconds east).
    zone: (String, i32),
    /// The day and the time of day (seconds, standard time) it starts.
    start: (Day, i64),
    /// The day and the time of day (seconds, daylight time) it ends.
    end: (Day, i64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Day {
    /// `Jn`: day 1–365, February 29 never counted.
    Julian(u16),
    /// `n`: day 0–365, February 29 counted.
    Zero(u16),
    /// `Mm.w.d`: the `w`th (5: last) weekday `d` (0: Sunday) of month `m`.
    Month(u8, u8, u8),
}

impl Rule {
    fn parse(text: &str) -> Option<Rule> {
        let mut s = text;
        let std_name = name(&mut s)?;
        let std = -offset(&mut s)?;
        if s.is_empty() {
            return Some(Rule {
                std: (std_name, std),
                dst: None,
            });
        }
        let dst_name = name(&mut s)?;
        let dst = if s.starts_with(',') || s.is_empty() {
            std + 3600
        } else {
            -offset(&mut s)?
        };
        // Without dates, POSIX leaves them to the implementation; the
        // database always writes them, and US rules are the usual default.
        let (start, end) = if s.is_empty() {
            ((Day::Month(3, 2, 0), 7200), (Day::Month(11, 1, 0), 7200))
        } else {
            s = s.strip_prefix(',')?;
            let start = transition(&mut s)?;
            s = s.strip_prefix(',')?;
            (start, transition(&mut s)?)
        };
        s.is_empty().then_some(Rule {
            std: (std_name, std),
            dst: Some(Dst {
                zone: (dst_name, dst),
                start,
                end,
            }),
        })
    }

    fn at(&self, seconds: i64) -> (i32, &str) {
        let std = (self.std.1, self.std.0.as_str());
        let Some(dst) = &self.dst else {
            return std;
        };
        let year = year_of(seconds + i64::from(self.std.1));
        let start = day_of(dst.start.0, year) * 86_400 + dst.start.1 - i64::from(self.std.1);
        let end = day_of(dst.end.0, year) * 86_400 + dst.end.1 - i64::from(dst.zone.1);
        let daylight = if start < end {
            start <= seconds && seconds < end
        } else {
            !(end <= seconds && seconds < start)
        };
        if daylight {
            (dst.zone.1, dst.zone.0.as_str())
        } else {
            std
        }
    }
}

/// An abbreviation: letters (`EST`), or anything between `<` and `>`
/// (`<+1030>`).
fn name(s: &mut &str) -> Option<String> {
    let (name, rest) = if let Some(quoted) = s.strip_prefix('<') {
        let end = quoted.find('>')?;
        (&quoted[..end], &quoted[end + 1..])
    } else {
        let end = s
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(s.len());
        (&s[..end], &s[end..])
    };
    *s = rest;
    (name.len() >= 3).then(|| name.to_owned())
}

/// `[+-]hh[:mm[:ss]]` in seconds (as written: west of UTC for an offset).
fn offset(s: &mut &str) -> Option<i32> {
    let sign = match s.as_bytes().first()? {
        b'-' => -1,
        b'+' => 1,
        _ => 1,
    };
    *s = s.strip_prefix(['+', '-']).unwrap_or(*s);
    let mut total = 0;
    for (i, scale) in [3600, 60, 1].into_iter().enumerate() {
        if i > 0 {
            match s.strip_prefix(':') {
                Some(rest) => *s = rest,
                None => break,
            }
        }
        let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
        if end == 0 {
            return None;
        }
        total += s[..end].parse::<i32>().ok()? * scale;
        *s = &s[end..];
    }
    Some(sign * total)
}

/// A day and an optional `/time` (02:00 without it).
fn transition(s: &mut &str) -> Option<(Day, i64)> {
    let day = if let Some(rest) = s.strip_prefix('M') {
        let mut parts = [0u8; 3];
        let mut rest = rest;
        for (i, part) in parts.iter_mut().enumerate() {
            if i > 0 {
                rest = rest.strip_prefix('.')?;
            }
            let end = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            *part = rest[..end].parse().ok()?;
            rest = &rest[end..];
        }
        *s = rest;
        let [m, w, d] = parts;
        if !(1..=12).contains(&m) || !(1..=5).contains(&w) || d > 6 {
            return None;
        }
        Day::Month(m, w, d)
    } else {
        let julian = s.starts_with('J');
        let rest = s.strip_prefix('J').unwrap_or(*s);
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        let n: u16 = rest[..end].parse().ok()?;
        *s = &rest[end..];
        if julian {
            if !(1..=365).contains(&n) {
                return None;
            }
            Day::Julian(n)
        } else {
            if n > 365 {
                return None;
            }
            Day::Zero(n)
        }
    };
    let time = match s.strip_prefix('/') {
        Some(rest) => {
            *s = rest;
            i64::from(offset(s)?)
        }
        None => 7200,
    };
    Some((day, time))
}

/// Days since the epoch of a day of the proleptic Gregorian calendar
/// (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// The year of `seconds` since the epoch.
fn year_of(seconds: i64) -> i64 {
    let days = seconds.div_euclid(86_400);
    let mut year = 1970 + days.div_euclid(365);
    while days_from_civil(year, 1, 1) > days {
        year -= 1;
    }
    while days_from_civil(year + 1, 1, 1) <= days {
        year += 1;
    }
    year
}

/// Days since the epoch of `day` in `year`.
fn day_of(day: Day, year: i64) -> i64 {
    let jan1 = days_from_civil(year, 1, 1);
    match day {
        Day::Julian(n) => {
            let n = i64::from(n);
            jan1 + n - 1 + i64::from(is_leap(year) && n >= 60)
        }
        Day::Zero(n) => jan1 + i64::from(n),
        Day::Month(m, w, d) => {
            let first = days_from_civil(year, u32::from(m), 1);
            // 0 = Sunday; the epoch was a Thursday.
            let weekday = (first + 4).rem_euclid(7);
            let mut date = first + (i64::from(d) - weekday).rem_euclid(7) + (i64::from(w) - 1) * 7;
            let next = if m == 12 {
                days_from_civil(year + 1, 1, 1)
            } else {
                days_from_civil(year, u32::from(m) + 1, 1)
            };
            while date >= next {
                date -= 7;
            }
            date
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_parse() {
        let rule = Rule::parse("EST5EDT,M3.2.0,M11.1.0").unwrap();
        assert_eq!(rule.std, ("EST".into(), -18_000));
        let dst = rule.dst.unwrap();
        assert_eq!(dst.zone, ("EDT".into(), -14_400));
        assert_eq!(dst.start, (Day::Month(3, 2, 0), 7200));
        assert_eq!(dst.end, (Day::Month(11, 1, 0), 7200));
        let howe = Rule::parse("<+1030>-10:30<+11>-11,M10.1.0,M4.1.0").unwrap();
        assert_eq!(howe.std, ("+1030".into(), 37_800));
        assert_eq!(howe.dst.unwrap().zone, ("+11".into(), 39_600));
        assert_eq!(Rule::parse("IST-5:30").unwrap().std, ("IST".into(), 19_800));
        let nuuk = Rule::parse("<-02>2<-01>,M3.5.0/-1,M10.5.0/0").unwrap();
        assert_eq!(nuuk.dst.unwrap().start, (Day::Month(3, 5, 0), -3600));
        assert_eq!(
            Rule::parse("<+00>0<+02>-2,J60/24,J300/2")
                .unwrap()
                .dst
                .unwrap()
                .start,
            (Day::Julian(60), 86_400)
        );
        assert!(Rule::parse("E5").is_none());
        assert!(Rule::parse("EST5EDT,M13.1.0,M11.1.0").is_none());
    }

    #[test]
    fn days_follow_the_calendar() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(year_of(-1), 1969);
        assert_eq!(year_of(951_782_400), 2000);
        // The second Sunday of March 2026 is the 8th, the last of October
        // the 25th.
        assert_eq!(
            day_of(Day::Month(3, 2, 0), 2026),
            days_from_civil(2026, 3, 8)
        );
        assert_eq!(
            day_of(Day::Month(10, 5, 0), 2026),
            days_from_civil(2026, 10, 25)
        );
        assert_eq!(day_of(Day::Julian(60), 2024), days_from_civil(2024, 3, 1));
        assert_eq!(day_of(Day::Zero(59), 2024), days_from_civil(2024, 2, 29));
    }
}
