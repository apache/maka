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

use crate::model::read_regular;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Runtime {
    state: String,
    updated_at: Option<DateTime<Utc>>,
    capture_failures: u32,
}

/// Only consulted while a recorder owns admission and control is not paused.
/// Never return provider messages or recorded content through status.
pub fn capture_failed(home: &Path, now: DateTime<Utc>) -> bool {
    let path = home.join("runtime.json");
    // A new recorder may not have published its first heartbeat yet.
    if !path.exists() {
        return false;
    }
    let read = (|| -> crate::control::Result<Runtime> {
        let bytes = read_regular(&path, 4096)?;
        Ok(serde_json::from_slice(&bytes)?)
    })();
    let Ok(runtime) = read else {
        return true;
    };
    if runtime.state != "running" {
        return false;
    }
    runtime.capture_failures >= 3
        || runtime.updated_at.is_none_or(|updated| {
            let age = now.signed_duration_since(updated);
            age > chrono::Duration::seconds(20) || age < chrono::Duration::seconds(-5)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repeated_failures_and_recovery_follow_fresh_runtime_without_sticky_errors() {
        let home = crate::model::tests::Home::new();
        let now = crate::model::tests::now();
        let path = home.0.join("runtime.json");
        assert!(!capture_failed(&home.0, now));
        for (failures, failed) in [(0, false), (2, false), (3, true), (4, true), (0, false)] {
            std::fs::write(
                &path,
                json!({
                    "state": "running", "updatedAt": now, "captureFailures": failures,
                })
                .to_string(),
            )
            .unwrap();
            assert_eq!(capture_failed(&home.0, now), failed);
        }
        assert!(capture_failed(&home.0, now + chrono::Duration::seconds(21)));
        assert!(capture_failed(&home.0, now - chrono::Duration::seconds(6)));
    }

    #[test]
    fn malformed_health_is_not_healthy_and_stopped_runtime_is_not_current_capture() {
        let home = crate::model::tests::Home::new();
        let now = crate::model::tests::now();
        let path = home.0.join("runtime.json");
        for value in [
            "invalid",
            r#"{"state":"running","captureFailures":-1}"#,
            r#"{"state":"running","captureFailures":0}"#,
        ] {
            std::fs::write(&path, value).unwrap();
            assert!(capture_failed(&home.0, now));
        }
        std::fs::write(&path, "x".repeat(4097)).unwrap();
        assert!(capture_failed(&home.0, now));
        std::fs::write(&path, r#"{"state":"stopped","captureFailures":5}"#).unwrap();
        assert!(!capture_failed(&home.0, now));
    }
}
