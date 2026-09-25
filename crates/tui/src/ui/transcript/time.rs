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

use chrono::{DateTime, Datelike, Local};

/// Host-recorded milliseconds; never synthesize a timestamp for a live delta.
pub(super) fn label(millis: Option<u64>) -> Option<String> {
    let at = DateTime::from_timestamp_millis(i64::try_from(millis?).ok()?)?.with_timezone(&Local);
    Some(format(at, Local::now()))
}
fn format(at: DateTime<Local>, now: DateTime<Local>) -> String {
    let pattern = if at.date_naive() == now.date_naive() {
        "%H:%M"
    } else if at.year() == now.year() {
        "%m-%d %H:%M"
    } else {
        "%Y-%m-%d %H:%M"
    };
    at.format(pattern).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    #[test]
    fn absent_invalid_and_cross_date_times_are_not_misrepresented() {
        assert_eq!(label(None), None);
        assert_eq!(label(Some(u64::MAX)), None);
        let now = Local.with_ymd_and_hms(2026, 9, 22, 12, 0, 0).unwrap();
        assert_eq!(format(now, now), "12:00");
        assert_eq!(format(now - Duration::days(1), now), "09-21 12:00");
        assert!(format(now - Duration::days(365), now).starts_with("2025-"));
    }
}
