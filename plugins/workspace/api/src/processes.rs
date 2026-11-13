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

use maka_host_runtime::shell::request::Execute;
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use maka_sandbox::{Network, filesystem::Policy};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const IMPLEMENTATION: &str = "maka.workspace.processes";
pub const EXPORT: &str = "processes";

/// Immutable installation ceiling selected by trusted native composition.
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkspaceProcessConfiguration")]
pub struct Configuration {
    /// Allow the selected native Session's verified owned worktree, within its
    /// own access policy. Other Host-private paths remain denied.
    #[serde(default)]
    pub isolated_workspaces: bool,
    pub filesystem: Policy,
    pub network: Network,
    /// Trusted CLI supporting the original platform sandbox bootstrap.
    pub helper: Option<PathBuf>,
    /// Explicit directory for application setup processes. Launch still needs
    /// its own grant and uses only the installation filesystem/network ceiling.
    #[serde(default)]
    pub setup_directory: Option<PathBuf>,
    /// Trusted Agent Session owner in this Root/deployment. This selects a data
    /// namespace only; Terminal endpoints still require their own explicit grants.
    #[serde(default)]
    pub session_owner: Option<maka_plugin_core::composition::InstanceId>,
}
pub fn configuration_schema() -> Value {
    schemars::schema_for!(Configuration).into()
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkspaceProcessResult")]
pub enum ProcessResult {
    PermissionDenied {
        #[serde(rename = "executionState")]
        execution_state: crate::NotStarted,
        denial: Box<maka_agent_facts::tools::PermissionDenial>,
    },
    Completed {
        value: Value,
    },
    Failed {
        message: String,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    #[serde(rename = "ref")]
    pub reference: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkspaceProcessHealth")]
pub struct Health {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub include_logs: bool,
    pub url: Option<String>,
}
pub fn contract() -> Contract {
    let methods = [
        (
            "execute",
            MethodMode::Mutation,
            schemars::schema_for!(Execute).into(),
        ),
        (
            "read",
            MethodMode::Query,
            schemars::schema_for!(Reference).into(),
        ),
        (
            "health",
            MethodMode::Mutation,
            schemars::schema_for!(Health).into(),
        ),
        (
            "writeStdin",
            MethodMode::Mutation,
            maka_host_runtime::shell::stdin::schema(),
        ),
        (
            "stop",
            MethodMode::Mutation,
            schemars::schema_for!(Reference).into(),
        ),
    ]
    .into_iter()
    .map(|(name, mode, input)| {
        (
            name.into(),
            Method {
                progress: None,
                mode,
                input: input.into(),
                output: schemars::schema_for!(ProcessResult).into(),
                resources: BTreeMap::new(),
            },
        )
    })
    .collect();
    Contract {
        name: "maka.workspace.Processes".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service { methods },
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        configuration_schema(),
        [
            (EXPORT, contract()),
            (crate::terminal::EXPORT, crate::terminal::contract()),
        ],
    )
}
