use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    elapsed_ms: u64,
    percent: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::cell::Cell;
    fn percent(v: &Value) -> f64 {
        match v.as_str() {
            Some("NaN") => f64::NAN,
            Some("Infinity") => f64::INFINITY,
            _ => v.as_f64().unwrap_or(0.0),
        }
    }
    #[test]
    fn shared_scroll_cases() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../maka-cu-windows/scroll-readback-cases.json"
        ))
        .unwrap();
        for t in cases["preflight"].as_array().unwrap() {
            assert_eq!(
                preflight(
                    percent(&t["percent"]),
                    t["scrollable"].as_bool().unwrap(),
                    t["amount"].as_str().unwrap()
                ),
                t["expected"].as_str()
            );
        }
        for t in cases["readback"].as_array().unwrap() {
            let now = Cell::new(0);
            let cancelled = Cell::new(t["cancelInitially"].as_bool().unwrap_or(false));
            let samples = t["samples"].as_array().unwrap();
            let mut index = 0;
            let r = run_with_clock(
                40.0,
                "vertical",
                t["amount"].as_str().unwrap_or("large_increment"),
                || {
                    let s = &samples[index.min(samples.len() - 1)];
                    index += 1;
                    now.set(now.get() + s["advanceMs"].as_u64().unwrap_or(0));
                    cancelled.set(cancelled.get() || s["cancel"].as_bool().unwrap_or(false));
                    match s["error"].as_str() {
                        Some("scroll_readback_unavailable") => Err("scroll_readback_unavailable"),
                        Some("readback_identity_changed") => Err("readback_identity_changed"),
                        Some("scroll_readback_axis_not_scrollable") => {
                            Err("scroll_readback_axis_not_scrollable")
                        }
                        Some(e) => panic!("unsupported test error {e}"),
                        None => Ok(percent(&s["percent"])),
                    }
                },
                || cancelled.get(),
                || now.get(),
                |ms| {
                    if t["frozenClock"].as_bool() != Some(true) {
                        now.set(now.get() + ms);
                    }
                },
            );
            assert_eq!(
                r.verification,
                t["reason"].as_str().unwrap(),
                "{}",
                t["name"]
            );
            assert_eq!(
                r.status,
                if r.verification == "scroll_position_readback_changed" {
                    "verified"
                } else {
                    "unknown"
                }
            );
            assert_eq!(r.attempts as u64, t["attempts"].as_u64().unwrap());
            assert_eq!(r.elapsed_ms, t["elapsedMs"].as_u64().unwrap());
            assert_eq!(r.samples.len(), r.attempts as usize);
            assert!(r
                .samples
                .iter()
                .all(|s| s.percent.is_none_or(f64::is_finite)));
            assert_eq!((r.max_millis, r.interval_millis), (1000, 50));
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub status: &'static str,
    pub verification: &'static str,
    attempts: u32,
    elapsed_ms: u64,
    max_millis: u64,
    interval_millis: u64,
    source: &'static str,
    direction: String,
    amount: String,
    before_percent: f64,
    samples: Vec<Sample>,
}

pub fn valid(percent: f64) -> bool {
    percent.is_finite() && (0.0..=100.0).contains(&percent)
}
fn increment(amount: &str) -> bool {
    matches!(amount, "small_increment" | "large_increment")
}
pub fn preflight(percent: f64, scrollable: bool, amount: &str) -> Option<&'static str> {
    if amount == "no_amount" {
        return Some("scroll_no_amount");
    }
    if !scrollable || percent == -1.0 {
        return Some("scroll_axis_not_scrollable");
    }
    if !valid(percent) {
        return Some("scroll_invalid_percent");
    }
    if if increment(amount) {
        percent == 100.0
    } else {
        percent == 0.0
    } {
        return Some("scroll_at_boundary");
    }
    None
}

pub fn run(
    before: f64,
    direction: &str,
    amount: &str,
    probe: impl FnMut() -> Result<f64, &'static str>,
    cancelled: impl Fn() -> bool,
) -> Report {
    let start = Instant::now();
    run_with_clock(
        before,
        direction,
        amount,
        probe,
        cancelled,
        || start.elapsed().as_millis() as u64,
        |ms| std::thread::sleep(std::time::Duration::from_millis(ms)),
    )
}

// Only read-only probes enter this loop. Reject matches returned beyond the budget.
fn run_with_clock(
    before: f64,
    direction: &str,
    amount: &str,
    mut probe: impl FnMut() -> Result<f64, &'static str>,
    cancelled: impl Fn() -> bool,
    clock: impl Fn() -> u64,
    mut sleep: impl FnMut(u64),
) -> Report {
    let start = clock();
    let mut attempts = 0;
    let mut samples = Vec::new();
    let reason = loop {
        if cancelled() {
            break "readback_cancelled_after_dispatch";
        }
        if clock().saturating_sub(start) >= 1000 {
            break "scroll_readback_timeout";
        }
        if attempts >= 21 {
            break "scroll_readback_attempt_limit";
        }
        attempts += 1;
        let sample = probe();
        samples.push(Sample {
            elapsed_ms: clock().saturating_sub(start),
            percent: sample.ok().filter(|v| v.is_finite()),
        });
        if cancelled() {
            break "readback_cancelled_after_dispatch";
        }
        if clock().saturating_sub(start) >= 1000 {
            break "scroll_readback_timeout";
        }
        match sample {
            Err(reason) => break reason,
            Ok(value) if !valid(value) => break "scroll_readback_invalid_percent",
            Ok(value) if value != before => {
                break if if increment(amount) {
                    value > before
                } else {
                    value < before
                } {
                    "scroll_position_readback_changed"
                } else {
                    "scroll_readback_wrong_direction"
                }
            }
            _ => {}
        }
        sleep(50.min(1000_u64.saturating_sub(clock().saturating_sub(start))));
    };
    Report {
        status: if reason == "scroll_position_readback_changed" {
            "verified"
        } else {
            "unknown"
        },
        verification: reason,
        attempts,
        elapsed_ms: clock().saturating_sub(start),
        max_millis: 1000,
        interval_millis: 50,
        source: if direction == "horizontal" {
            "ScrollPattern.CurrentHorizontalScrollPercent"
        } else {
            "ScrollPattern.CurrentVerticalScrollPercent"
        },
        direction: direction.into(),
        amount: amount.into(),
        before_percent: before,
        samples,
    }
}
