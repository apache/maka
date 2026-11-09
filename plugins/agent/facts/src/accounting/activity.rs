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

use super::{ModelAttempt, ToolUsage};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "attempt",
    rename_all = "snake_case",
    deny_unknown_fields
)]
#[schemars(rename = "UsageActivity")]
pub enum Activity {
    Model(ModelAttempt),
    Tool(ToolUsage),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "UsageActivityKind")]
pub enum ActivityKind {
    Model,
    Tool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "UsageActivityStatus")]
pub enum ActivityStatus {
    Success,
    Error,
    Aborted,
    Unknown,
    Rejected,
}

/// Filters only the activity list, never headline accounting for the range.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageSelection")]
pub struct Selection {
    pub kind: Option<ActivityKind>,
    pub status: Option<ActivityStatus>,
    #[serde(default)]
    pub search: String,
}
impl Selection {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.search.chars().any(char::is_control) {
            return Err("Usage search contains control characters");
        }
        Ok(())
    }
}
