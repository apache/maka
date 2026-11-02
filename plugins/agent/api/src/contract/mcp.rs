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

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpRead")]
pub struct McpRead {
    pub session_id: String,
}

/// Displayed only to the user. Credentials are omitted, but their values remain
/// part of the revision that is explicitly confirmed.
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpServerView")]
pub struct McpServerView {
    pub name: String,
    pub launch: String,
    pub environment: Vec<String>,
    pub headers: Vec<String>,
    pub preapproved: bool,
    pub read_only_tools: Vec<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentMcpView")]
pub enum McpView {
    Absent,
    Configuration {
        path: String,
        revision: String,
        trusted: bool,
        servers: Vec<McpServerView>,
        disabled: Vec<String>,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpTrust")]
pub struct McpTrust {
    pub session_id: String,
    pub revision: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentMcpTrustResult")]
pub enum McpTrustResult {
    Trusted,
    Changed,
}
