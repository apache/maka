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

use super::LocatorPlan;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The selected Original client passes timeout options without schema parsing.
/// Preserve them for the wait boundary's actual numeric/default handling.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserWaitOperation {
    Locator {
        locator: LocatorPlan,
        state: Value,
        #[serde(default, rename = "timeoutMs")]
        timeout_ms: Option<Value>,
    },
    Url {
        url: Value,
        #[serde(default, rename = "waitUntil")]
        wait_until: Option<Value>,
        #[serde(default, rename = "timeoutMs")]
        timeout_ms: Option<Value>,
    },
    LoadState {
        #[serde(default)]
        state: Option<Value>,
        #[serde(default, rename = "timeoutMs")]
        timeout_ms: Option<Value>,
    },
    Timeout {
        #[serde(rename = "timeoutMs")]
        timeout_ms: Value,
    },
}
