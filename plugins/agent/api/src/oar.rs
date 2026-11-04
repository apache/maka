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

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Only OAR's declared installation operations; not an agent registry or login shim.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentOarSetup")]
pub struct Setup {
    #[schemars(length(min = 1))]
    pub runtime: String,
    pub action: Action,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentOarSetupAction")]
pub enum Action {
    Probe,
    Plan { line: Option<String> },
    Install { line: Option<String> },
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentOarSetupResult")]
pub struct SetupResult {
    pub runtime: String,
    /// The pinned OAR version's native result, including unsupported capabilities.
    pub result: serde_json::Value,
}
