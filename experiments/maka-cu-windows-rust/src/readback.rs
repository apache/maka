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

use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub status: &'static str,
    pub verification: &'static str,
    pub attempts: u32,
    pub elapsed_ms: u64,
    pub max_millis: u64,
    pub interval_millis: u64,
    pub source: &'static str,
}

// Accept only a read-only probe, never a mutator. COM calls can overrun the
// budget; an observation arriving after it must not be accepted as verified.
pub fn run(
    probe: impl FnMut() -> Result<bool, &'static str>,
    cancelled: impl Fn() -> bool,
) -> Report {
    let start = Instant::now();
    run_with_clock(
        probe,
        cancelled,
        || start.elapsed().as_millis() as u64,
        |ms| std::thread::sleep(std::time::Duration::from_millis(ms)),
    )
}

fn run_with_clock(
    mut probe: impl FnMut() -> Result<bool, &'static str>,
    cancelled: impl Fn() -> bool,
    clock: impl Fn() -> u64,
    mut sleep: impl FnMut(u64),
) -> Report {
    let start = clock();
    let mut attempts = 0;
    let reason = loop {
        if cancelled() {
            break "readback_cancelled_after_dispatch";
        }
        if clock().saturating_sub(start) >= 1000 {
            break "value_readback_timeout";
        }
        if attempts >= 21 {
            break "value_readback_attempt_limit";
        }
        attempts += 1;
        let sample = probe();
        if cancelled() {
            break "readback_cancelled_after_dispatch";
        }
        if clock().saturating_sub(start) >= 1000 {
            break "value_readback_timeout";
        }
        match sample {
            Ok(true) => break "value_readback_match",
            Err(reason) => break reason,
            Ok(false) => {}
        }
        sleep(50.min(1000_u64.saturating_sub(clock().saturating_sub(start))));
    };
    Report {
        status: if reason == "value_readback_match" {
            "verified"
        } else {
            "unknown"
        },
        verification: reason,
        attempts,
        elapsed_ms: clock().saturating_sub(start),
        max_millis: 1000,
        interval_millis: 50,
        source: "ValuePattern.CurrentValue",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn shared_readback_policy_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/value-readback-cases.json")).unwrap();
        for test in cases.as_array().unwrap() {
            let now = Cell::new(0_u64);
            let cancelled = Cell::new(test["cancelInitially"].as_bool().unwrap_or(false));
            let samples = test["samples"].as_array().unwrap();
            let mut index = 0;
            let result = run_with_clock(
                || {
                    let sample = &samples[index.min(samples.len() - 1)];
                    index += 1;
                    now.set(now.get() + sample["advanceMs"].as_u64().unwrap_or(0));
                    cancelled.set(cancelled.get() || sample["cancel"].as_bool().unwrap_or(false));
                    match sample["stopReason"].as_str() {
                        Some("readback_unavailable") => Err("readback_unavailable"),
                        Some("readback_identity_changed") => Err("readback_identity_changed"),
                        Some("readback_password_field_refused") => {
                            Err("readback_password_field_refused")
                        }
                        Some("readback_value_too_long") => Err("readback_value_too_long"),
                        Some(reason) => panic!("unsupported test reason {reason}"),
                        None => Ok(sample["match"].as_bool().unwrap_or(false)),
                    }
                },
                || cancelled.get(),
                || now.get(),
                |ms| {
                    if test["frozenClock"].as_bool() != Some(true) {
                        now.set(now.get() + ms);
                    }
                },
            );
            let actual = serde_json::to_value(result).unwrap();
            for field in ["status", "verification", "attempts", "elapsedMs"] {
                assert_eq!(
                    actual[field], test["expected"][field],
                    "{} / {field}",
                    test["name"]
                );
            }
            println!("PASS {}", test["name"]);
        }
    }
}
