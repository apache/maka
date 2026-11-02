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

use maka_capabilities::http;

pub(super) fn at(head: &http::Head) -> Option<u64> {
    parse(head, jiff::Timestamp::now().as_millisecond())
}

fn parse(head: &http::Head, now_ms: i64) -> Option<u64> {
    let header = |name: &str| {
        head.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .and_then(|(_, value)| std::str::from_utf8(value).ok())
    };
    let positive = |delay: f64| {
        (delay.is_finite() && delay >= 0.0)
            .then_some((now_ms.max(0) as u64).saturating_add(delay.ceil() as u64))
    };
    header("retry-after-ms")
        .and_then(|value| value.parse().ok())
        .and_then(positive)
        .or_else(|| {
            let value = header("retry-after")?;
            if let Ok(seconds) = value.parse::<f64>() {
                positive(seconds * 1000.0)
            } else {
                let reset_ms = jiff::fmt::rfc2822::parse(value)
                    .ok()?
                    .timestamp()
                    .as_millisecond();
                u64::try_from(reset_ms).ok()
            }
        })
}
