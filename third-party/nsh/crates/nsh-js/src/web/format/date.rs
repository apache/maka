//! Date and time formatting (`Intl.DateTimeFormat`, `Date.prototype.
//! toLocale{,Date,Time}String`): the Gregorian calendar, the fields asked
//! for in the locale's order, 12- or 24-hour times. Times are local (the
//! offset QuickJS's `Date` uses), UTC, or a fixed offset: there is no time
//! zone database.

use super::{
    Part,
    locale::{Dates, Field, english_names},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Text {
    Long,
    Short,
    Narrow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Num {
    Numeric,
    TwoDigit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Month {
    Num(Num),
    Text(Text),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HourCycle {
    H11,
    H12,
    H23,
    H24,
}

impl HourCycle {
    pub(crate) fn name(self) -> &'static str {
        match self {
            HourCycle::H11 => "h11",
            HourCycle::H12 => "h12",
            HourCycle::H23 => "h23",
            HourCycle::H24 => "h24",
        }
    }
}

/// The time zone times are written in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Zone {
    Local,
    Utc,
    /// Minutes east of UTC.
    Offset(i32),
}

/// Resolved options: the fields to write.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub(crate) struct Format {
    pub(crate) weekday: Option<Text>,
    pub(crate) year: Option<Num>,
    pub(crate) month: Option<Month>,
    pub(crate) day: Option<Num>,
    pub(crate) hour: Option<Num>,
    pub(crate) minute: Option<Num>,
    pub(crate) second: Option<Num>,
    /// Digits of the second's fraction (0–3).
    pub(crate) fraction: u8,
    /// `None`: the locale's.
    pub(crate) hour_cycle: Option<HourCycle>,
    pub(crate) zone_name: bool,
}

impl Format {
    /// The hour cycle used: asked for, or the locale's.
    pub(crate) fn cycle(&self, dates: &Dates) -> HourCycle {
        self.hour_cycle.unwrap_or(if dates.hour12 {
            HourCycle::H12
        } else {
            HourCycle::H23
        })
    }
}

/// A day of the proleptic Gregorian calendar and a time of day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Civil {
    year: i64,
    month: u32,
    day: u32,
    /// 0 = Sunday.
    weekday: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millisecond: u32,
}

fn civil(ms: f64) -> Civil {
    let ms = ms.floor() as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000) as u32;
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    Civil {
        year,
        month,
        day,
        weekday: (days + 4).rem_euclid(7) as u32,
        hour: in_day / 3_600_000,
        minute: in_day / 60_000 % 60,
        second: in_day / 1000 % 60,
        millisecond: in_day % 1000,
    }
}

fn pad2(n: impl Into<i64>) -> String {
    format!("{:02}", n.into())
}

fn num(n: impl Into<i64>, style: Num) -> String {
    match style {
        Num::Numeric => n.into().to_string(),
        Num::TwoDigit => pad2(n.into().rem_euclid(100)),
    }
}

/// The name of a zone's offset (`UTC`, `GMT+8`, `GMT-5:30`).
fn zone_name(zone: Zone, offset: i32) -> String {
    if zone == Zone::Utc {
        return "UTC".to_owned();
    }
    if offset == 0 {
        return "GMT".to_owned();
    }
    let sign = if offset < 0 { '-' } else { '+' };
    let (h, m) = (offset.abs() / 60, offset.abs() % 60);
    if m == 0 {
        format!("GMT{sign}{h}")
    } else {
        format!("GMT{sign}{h}:{m:02}")
    }
}

/// The parts of the time `ms` (milliseconds since the epoch), written
/// `offset` minutes east of UTC (the zone's offset at that time).
pub(crate) fn format(ms: f64, offset: i32, zone: Zone, f: &Format, dates: &Dates) -> Vec<Part> {
    let c = civil(ms + f64::from(offset) * 60_000.0);
    let mut parts = Vec::new();
    let date = date_parts(&c, f, dates);
    let time = time_parts(&c, f, dates, zone, offset);
    let has_date = !date.is_empty();
    parts.extend(date);
    if has_date && !time.is_empty() {
        literal(&mut parts, &dates.date_time_sep);
    }
    parts.extend(time);
    parts
}

fn literal(parts: &mut Vec<Part>, text: &str) {
    if text.is_empty() {
        return;
    }
    match parts.last_mut() {
        Some(last) if last.kind == "literal" => last.value.push_str(text),
        _ => parts.push(Part {
            kind: "literal",
            value: text.to_owned(),
        }),
    }
}

fn field(parts: &mut Vec<Part>, kind: &'static str, value: String) {
    parts.push(Part { kind, value });
}

/// The first character of `name`, past a CJK weekday's prefix (`周五`:
/// `五`).
fn narrow(name: &str) -> String {
    let name = name
        .trim_start_matches("星期")
        .trim_start_matches('周')
        .trim_start_matches('週')
        .trim_matches(['(', ')']);
    name.chars().next().map(String::from).unwrap_or_default()
}

fn date_parts(c: &Civil, f: &Format, dates: &Dates) -> Vec<Part> {
    // Languages without names here borrow English ones.
    let names = dates.names.as_ref().unwrap_or_else(|| english_names());
    let mut parts = Vec::new();
    let text_month = matches!(f.month, Some(Month::Text(_)));
    let template = match (text_month, &dates.text) {
        (true, Some(text)) => match (f.month, &dates.text_long) {
            (Some(Month::Text(Text::Long)), Some(long)) => long,
            _ => text,
        },
        _ => &dates.numeric,
    };
    // Chinese, Japanese and Korean separators are units (`年`): kept after
    // the last field too.
    let attach = dates.cjk;
    let fields: Vec<(Field, &str)> = template
        .iter()
        .filter(|(field, _)| match field {
            Field::Year => f.year.is_some(),
            Field::Month => f.month.is_some(),
            Field::Day => f.day.is_some(),
        })
        .map(|(field, sep)| (*field, sep.as_str()))
        .collect();
    for (i, (kind, sep)) in fields.iter().enumerate() {
        match kind {
            Field::Year => {
                let style = f.year.unwrap_or(Num::Numeric);
                field(&mut parts, "year", num(c.year, style));
            }
            Field::Month => {
                let value = match f.month {
                    Some(Month::Text(_)) if dates.cjk => c.month.to_string(),
                    // Without names: written as a number.
                    Some(Month::Text(_)) if dates.text.is_none() => c.month.to_string(),
                    Some(Month::Text(Text::Long)) => names.months[c.month as usize - 1].to_owned(),
                    Some(Month::Text(Text::Short)) => {
                        names.months_short[c.month as usize - 1].to_owned()
                    }
                    Some(Month::Text(Text::Narrow)) => {
                        narrow(&names.months_short[c.month as usize - 1]).to_uppercase()
                    }
                    Some(Month::Num(style)) => num(c.month, style),
                    None => String::new(),
                };
                field(&mut parts, "month", value);
            }
            Field::Day => {
                let style = f.day.unwrap_or(Num::Numeric);
                field(&mut parts, "day", num(c.day, style));
            }
        }
        if attach || i + 1 < fields.len() {
            literal(&mut parts, sep);
        }
    }
    if attach {
        // `2026/10/` (year and month), `2026년 10월 `: the separator goes.
        if let Some(last) = parts.last_mut().filter(|p| p.kind == "literal") {
            let trimmed = last.value.trim_end_matches([' ', '/', '-', ',']).to_owned();
            if trimmed.is_empty() {
                parts.pop();
            } else {
                last.value = trimmed;
            }
        }
    }
    if let Some(style) = f.weekday {
        let i = c.weekday as usize;
        let name = match style {
            Text::Long => names.weekdays[i].to_owned(),
            Text::Short => names.weekdays_short[i].to_owned(),
            Text::Narrow => narrow(&names.weekdays_short[i]),
        };
        // A short weekday standing alone loses the parentheses it has in a
        // date (`金`, `(金)`).
        let name = if parts.is_empty() {
            name.trim_matches(['(', ')']).to_owned()
        } else {
            name
        };
        let weekday = Part {
            kind: "weekday",
            value: name,
        };
        if parts.is_empty() {
            parts.push(weekday);
        } else if dates.weekday_first {
            let mut out = vec![weekday];
            literal(&mut out, &dates.weekday_sep);
            out.append(&mut parts);
            parts = out;
        } else {
            literal(&mut parts, &dates.weekday_sep);
            parts.push(weekday);
        }
    }
    parts
}

fn time_parts(c: &Civil, f: &Format, dates: &Dates, zone: Zone, offset: i32) -> Vec<Part> {
    let mut parts = Vec::new();
    let cycle = f.cycle(dates);
    let twelve = matches!(cycle, HourCycle::H11 | HourCycle::H12);
    let mut clock = Vec::new();
    if let Some(style) = f.hour {
        let h = c.hour;
        let value = match cycle {
            HourCycle::H23 => h,
            HourCycle::H24 if h == 0 => 24,
            HourCycle::H24 => h,
            HourCycle::H12 if h.is_multiple_of(12) => 12,
            HourCycle::H12 => h % 12,
            HourCycle::H11 => h % 12,
        };
        let pad = style == Num::TwoDigit || (!twelve && dates.pad_hour24 && f.minute.is_some());
        field(
            &mut clock,
            "hour",
            if pad { pad2(value) } else { value.to_string() },
        );
    }
    if let Some(style) = f.minute {
        if !clock.is_empty() {
            literal(&mut clock, ":");
        }
        let value = if f.hour.is_some() {
            pad2(c.minute)
        } else {
            num(c.minute, style)
        };
        field(&mut clock, "minute", value);
    }
    if let Some(style) = f.second {
        if !clock.is_empty() {
            literal(&mut clock, ":");
        }
        let value = if f.minute.is_some() {
            pad2(c.second)
        } else {
            num(c.second, style)
        };
        field(&mut clock, "second", value);
    }
    if f.fraction > 0 {
        if !clock.is_empty() {
            literal(&mut clock, ".");
        }
        let digits = format!("{:03}", c.millisecond);
        field(
            &mut clock,
            "fractionalSecond",
            digits[..usize::from(f.fraction.min(3))].to_owned(),
        );
    }
    if clock.is_empty() {
        if f.zone_name {
            field(&mut parts, "timeZoneName", zone_name(zone, offset));
        }
        return parts;
    }
    let alone = f.hour.is_some() && f.minute.is_none() && f.second.is_none();
    if twelve && f.hour.is_some() {
        let period = Part {
            kind: "dayPeriod",
            value: if c.hour < 12 { &dates.am } else { &dates.pm }.clone(),
        };
        if dates.period_first {
            parts.push(period);
            literal(&mut parts, &dates.period_space);
            parts.extend(clock);
            if alone {
                literal(&mut parts, dates.hour_suffix.trim_start());
            }
        } else {
            parts.extend(clock);
            literal(&mut parts, &dates.period_space);
            parts.push(period);
        }
    } else {
        parts.extend(clock);
        if alone {
            literal(&mut parts, &dates.hour_suffix);
        }
    }
    if f.zone_name {
        literal(&mut parts, " ");
        field(&mut parts, "timeZoneName", zone_name(zone, offset));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::format::locale::resolve;

    /// 2026-10-16 (a Friday) 15:04:05.678 UTC.
    const T: f64 = 1_792_163_045_678.0;

    fn fmt(tag: &str, f: Format) -> String {
        let locale = resolve(&[tag.to_owned()], "en-US");
        format(T, 0, Zone::Utc, &f, &locale.dates)
            .into_iter()
            .map(|p| p.value)
            .collect()
    }

    const DATE: Format = Format {
        weekday: None,
        year: Some(Num::Numeric),
        month: Some(Month::Num(Num::Numeric)),
        day: Some(Num::Numeric),
        hour: None,
        minute: None,
        second: None,
        fraction: 0,
        hour_cycle: None,
        zone_name: false,
    };

    const TIME: Format = Format {
        weekday: None,
        year: None,
        month: None,
        day: None,
        hour: Some(Num::Numeric),
        minute: Some(Num::Numeric),
        second: Some(Num::Numeric),
        fraction: 0,
        hour_cycle: None,
        zone_name: false,
    };

    #[test]
    fn days_follow_the_gregorian_calendar() {
        let c = civil(T);
        assert_eq!((c.year, c.month, c.day, c.weekday), (2026, 10, 16, 5));
        assert_eq!((c.hour, c.minute, c.second, c.millisecond), (15, 4, 5, 678));
        let epoch = civil(0.0);
        assert_eq!(
            (epoch.year, epoch.month, epoch.day, epoch.weekday),
            (1970, 1, 1, 4)
        );
        let before = civil(-1.0);
        assert_eq!(
            (before.year, before.month, before.day, before.hour),
            (1969, 12, 31, 23)
        );
        let leap = civil(951_782_400_000.0);
        assert_eq!((leap.year, leap.month, leap.day), (2000, 2, 29));
    }

    #[test]
    fn numeric_dates_in_the_locales_order() {
        assert_eq!(fmt("en-US", DATE), "10/16/2026");
        assert_eq!(fmt("en-GB", DATE), "16/10/2026");
        assert_eq!(fmt("de-DE", DATE), "16.10.2026");
        assert_eq!(fmt("ja-JP", DATE), "2026/10/16");
        assert_eq!(fmt("ko-KR", DATE), "2026. 10. 16.");
        assert_eq!(fmt("sv-SE", DATE), "2026-10-16");
        let month_day = Format { year: None, ..DATE };
        assert_eq!(fmt("en-US", month_day), "10/16");
        let two = Format {
            year: Some(Num::TwoDigit),
            month: Some(Month::Num(Num::TwoDigit)),
            day: Some(Num::TwoDigit),
            ..DATE
        };
        assert_eq!(fmt("en-US", two), "10/16/26");
    }

    #[test]
    fn dates_with_names() {
        let long = Format {
            weekday: Some(Text::Long),
            month: Some(Month::Text(Text::Long)),
            ..DATE
        };
        assert_eq!(fmt("en-US", long), "Friday, October 16, 2026");
        assert_eq!(fmt("de-DE", long), "Freitag, 16. Oktober 2026");
        assert_eq!(fmt("fr-FR", long), "vendredi 16 octobre 2026");
        assert_eq!(fmt("es-ES", long), "viernes, 16 de octubre de 2026");
        assert_eq!(fmt("zh-CN", long), "2026年10月16日星期五");
        assert_eq!(fmt("ja-JP", long), "2026年10月16日金曜日");
        assert_eq!(fmt("ko-KR", long), "2026년 10월 16일 금요일");
        let short = Format {
            month: Some(Month::Text(Text::Short)),
            ..DATE
        };
        assert_eq!(fmt("en-US", short), "Oct 16, 2026");
        assert_eq!(fmt("en-GB", short), "16 Oct 2026");
        let month_year = Format { day: None, ..short };
        assert_eq!(fmt("en-US", month_year), "Oct 2026");
        assert_eq!(
            fmt(
                "zh-CN",
                Format {
                    day: None,
                    ..month_year
                }
            ),
            "2026年10月"
        );
        let weekday = Format {
            weekday: Some(Text::Short),
            ..Format::default()
        };
        assert_eq!(fmt("en-US", weekday), "Fri");
        assert_eq!(fmt("ja-JP", weekday), "金");
    }

    #[test]
    fn times_in_12_and_24_hours() {
        assert_eq!(fmt("en-US", TIME), "3:04:05 PM");
        assert_eq!(fmt("en-GB", TIME), "15:04:05");
        assert_eq!(fmt("de-DE", TIME), "15:04:05");
        assert_eq!(fmt("ko-KR", TIME), "오후 3:04:05");
        assert_eq!(fmt("ja-JP", TIME), "15:04:05");
        assert_eq!(fmt("es-MX", TIME), "3:04:05\u{a0}p.\u{a0}m.");
        let h23 = Format {
            hour_cycle: Some(HourCycle::H23),
            ..TIME
        };
        assert_eq!(fmt("en-US", h23), "15:04:05");
        let h12 = Format {
            hour_cycle: Some(HourCycle::H12),
            hour: Some(Num::TwoDigit),
            second: None,
            ..TIME
        };
        assert_eq!(fmt("de-DE", h12), "03:04 PM");
        assert_eq!(fmt("zh-CN", h12), "下午03:04");
        let hour = Format {
            minute: None,
            second: None,
            ..TIME
        };
        assert_eq!(fmt("en-US", hour), "3 PM");
        assert_eq!(fmt("de-DE", hour), "15 Uhr");
        let fraction = Format {
            fraction: 2,
            hour_cycle: Some(HourCycle::H23),
            ..TIME
        };
        assert_eq!(fmt("en-US", fraction), "15:04:05.67");
        let zone = Format {
            zone_name: true,
            ..TIME
        };
        assert_eq!(fmt("en-US", zone), "3:04:05 PM UTC");
        let both = Format {
            hour: TIME.hour,
            minute: TIME.minute,
            second: TIME.second,
            ..DATE
        };
        assert_eq!(fmt("en-US", both), "10/16/2026, 3:04:05 PM");
        assert_eq!(fmt("ja-JP", both), "2026/10/16 15:04:05");
        assert_eq!(fmt("ko-KR", both), "2026. 10. 16. 오후 3:04:05");
    }

    #[test]
    fn offsets_shift_the_fields() {
        let locale = resolve(&["en-GB".to_owned()], "en-US");
        let text: String = format(
            T,
            8 * 60,
            Zone::Offset(480),
            &Format {
                zone_name: true,
                ..TIME
            },
            &locale.dates,
        )
        .into_iter()
        .map(|p| p.value)
        .collect();
        assert_eq!(text, "23:04:05 GMT+8");
    }
}
