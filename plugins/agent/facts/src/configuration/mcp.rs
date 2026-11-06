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
use std::collections::BTreeMap;

/// Explicit trust for an external MCP server; tool annotations never expand it.
/// Installation changes require reactivation; client subscriptions own their scope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "McpServerConfiguration")]
pub struct ServerConfiguration {
    /// Stable namespace, using ASCII letters, digits, underscores and hyphens.
    pub name: String,
    pub transport: Transport,
    /// Omitted selects all tools discovered from this explicitly trusted server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// Explicitly permit these remote tools in read-only workspaces.
    /// The server's readOnlyHint is descriptive and cannot grant this access.
    #[serde(default)]
    pub read_only_tools: Vec<String>,
    /// Skip per-call confirmation only when the installer explicitly grants it.
    #[serde(default)]
    pub preapproved: bool,
    #[serde(default = "startup_timeout")]
    pub startup_timeout_ms: u64,
    #[serde(default = "call_timeout")]
    pub call_timeout_ms: u64,
}
impl ServerConfiguration {
    /// Start with per-call confirmation and no grant to execute in read-only workspaces.
    pub fn new(name: String, transport: Transport) -> Self {
        Self {
            name,
            transport,
            tools: None,
            read_only_tools: Vec::new(),
            preapproved: false,
            startup_timeout_ms: startup_timeout(),
            call_timeout_ms: call_timeout(),
        }
    }
}
fn startup_timeout() -> u64 {
    10_000
}
fn call_timeout() -> u64 {
    120_000
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "McpTransport")]
pub enum Transport {
    /// Explicitly trusted process. Runs outside the session filesystem sandbox.
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        /// Absolute working directory, independent of model-controlled arguments.
        cwd: String,
        #[serde(default)]
        env: BTreeMap<String, String>,
        /// Environment variable names explicitly forwarded from the Host.
        #[serde(default)]
        pass_env: Vec<String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        /// Header name to Host environment variable; keeps tokens out of config.
        #[serde(default)]
        header_env: BTreeMap<String, String>,
    },
}
