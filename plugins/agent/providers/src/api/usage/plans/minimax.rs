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

use super::{WEEK, duration, epoch, invalid};
use maka_agent_ports::provider::{Error, UsageLimit, UsageQuantity};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct Reply {
    base_resp: Status,
    #[serde(default)]
    model_remains: Vec<Bucket>,
}

#[derive(Deserialize)]
struct Status {
    status_code: u32,
}

#[derive(Deserialize)]
struct Bucket {
    model_name: String,
    start_time: Option<u64>,
    end_time: Option<u64>,
    current_interval_remaining_percent: Option<f64>,
    current_interval_status: Option<u8>,
    current_interval_total_count: Option<f64>,
    current_interval_usage_count: Option<f64>,
    weekly_start_time: Option<u64>,
    weekly_end_time: Option<u64>,
    current_weekly_remaining_percent: Option<f64>,
    current_weekly_status: Option<u8>,
    current_weekly_total_count: Option<f64>,
    current_weekly_usage_count: Option<f64>,
}

struct Interval {
    start: Option<u64>,
    end: Option<u64>,
    left: Option<f64>,
    status: Option<u8>,
    total: Option<f64>,
    count: Option<f64>,
}

impl Interval {
    fn quota(self, name: &str, default_duration: Option<u32>) -> Option<UsageLimit> {
        if self.status == Some(3) {
            return None;
        }
        let exhausted = self.status == Some(2);
        let used_percent = if exhausted {
            100.0
        } else {
            100.0 - self.left?.clamp(0.0, 100.0)
        };
        let start = self.start.and_then(epoch);
        let resets_at = self.end.and_then(epoch);
        let seconds = start
            .zip(resets_at)
            .and_then(|(start, end)| u32::try_from(end.checked_sub(start)?).ok())
            .filter(|n| *n > 0)
            .or(default_duration);
        let quantity = self.total.zip(self.count).and_then(|(limit, count)| {
            if limit <= 0.0 || !(0.0..=limit).contains(&count) {
                return None;
            }
            // This field has reported both usage and remaining counts. Only show a
            // quantity when its interpretation agrees with the reported percentage.
            let used = if exhausted {
                limit
            } else {
                let error = |value: f64| (value / limit * 100.0 - used_percent).abs();
                [count, limit - count]
                    .into_iter()
                    .min_by(|a, b| error(*a).total_cmp(&error(*b)))
                    .filter(|value| error(*value) <= 1.0)?
            };
            Some(UsageQuantity {
                used,
                limit,
                unit: name.eq_ignore_ascii_case("video").then(|| "videos".into()),
            })
        });
        Some(UsageLimit::Window {
            label: (!name.eq_ignore_ascii_case("general")).then(|| name.into()),
            period: seconds.map(duration),
            resets_at,
            used_percent,
            quantity,
        })
    }
}

pub(super) fn limits(reply: Reply) -> Result<Vec<UsageLimit>, Error> {
    match reply.base_resp.status_code {
        0 => {}
        1004 => return Err(Error::AuthenticationRequired),
        _ => return Err(invalid("MiniMax usage")),
    }
    let mut limits = Vec::new();
    for bucket in reply.model_remains {
        let name = bucket.model_name.trim();
        if name.is_empty() {
            continue;
        }
        limits.extend(
            Interval {
                start: bucket.start_time,
                end: bucket.end_time,
                left: bucket.current_interval_remaining_percent,
                status: bucket.current_interval_status,
                total: bucket.current_interval_total_count,
                count: bucket.current_interval_usage_count,
            }
            .quota(name, None),
        );
        limits.extend(
            Interval {
                start: bucket.weekly_start_time,
                end: bucket.weekly_end_time,
                left: bucket.current_weekly_remaining_percent,
                status: bucket.current_weekly_status,
                total: bucket.current_weekly_total_count,
                count: bucket.current_weekly_usage_count,
            }
            .quota(name, Some(WEEK)),
        );
    }
    Ok(limits)
}
