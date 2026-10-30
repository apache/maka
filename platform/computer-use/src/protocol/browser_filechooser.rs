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

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "native-desktop")]
use std::time::Duration;

/// Chooser schema validation precedes browser dispatch. Explicit null is not a
/// missing timeout; very large finite integral JS numbers still clamp to 3s.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserFileChooserOptions {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub timeout_ms: Option<Value>,
}
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
#[cfg(feature = "native-desktop")]
impl BrowserFileChooserOptions {
    pub(crate) fn timeout(&self) -> Result<Duration, maka_agent_facts::tools::ToolError> {
        let millis = match &self.timeout_ms {
            None => 3000.0,
            Some(value) => value
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.0 && n.fract() == 0.0)
                .ok_or_else(|| {
                    maka_agent_facts::tools::ToolError::Failed(
                        "file chooser timeoutMs must be a positive integer".into(),
                    )
                })?,
        };
        Ok(Duration::from_secs_f64(millis.min(3000.0) / 1000.0))
    }
}
