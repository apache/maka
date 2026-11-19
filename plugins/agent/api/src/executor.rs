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

use maka_agent_ports::executor::Outcome;
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub mod setup;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentServiceExecutor")]
pub struct ServiceExecutor {
    #[schemars(regex(pattern = "^[a-zA-Z][a-zA-Z0-9._:-]*$"))]
    pub name: String,
    #[schemars(length(min = 1))]
    pub import: String,
    /// Exact member of the explicitly bound import, never a discovery index.
    #[serde(default)]
    pub member: usize,
    #[serde(default)]
    pub setup: Option<setup::Binding>,
}
pub use maka_agent_facts::executor::Selection;
/// Explicit opt-in to the three CLIs' native full-access tools and permissions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExternalConfiguration")]
pub struct ExternalConfiguration {
    #[serde(default)]
    pub runtimes: NativeRuntimeSwitches,
    #[serde(default)]
    pub commands: NativeCommands,
}
impl ExternalConfiguration {
    pub fn enabled_runtimes(&self) -> impl Iterator<Item = NativeRuntime> + '_ {
        NativeRuntime::ALL
            .into_iter()
            .filter(|runtime| self.runtimes.enabled(*runtime))
    }
    pub fn command(&self, runtime: NativeRuntime) -> Option<&NativeCommand> {
        match runtime {
            NativeRuntime::Antigravity => self.commands.antigravity.as_ref(),
            NativeRuntime::Codex => self.commands.codex.as_ref(),
            NativeRuntime::Claude => self.commands.claude.as_ref(),
        }
    }
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentNativeRuntime")]
pub enum NativeRuntime {
    Antigravity,
    Codex,
    Claude,
}
impl NativeRuntime {
    pub const ALL: [Self; 3] = [Self::Antigravity, Self::Codex, Self::Claude];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Antigravity => "antigravity",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Antigravity => "Antigravity",
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
        }
    }
    pub fn executable(self) -> &'static str {
        match self {
            Self::Antigravity => "agy",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn reports_usage_limits(self) -> bool {
        matches!(self, Self::Antigravity)
    }
}
impl std::str::FromStr for NativeRuntime {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|runtime| runtime.as_str() == value)
            .ok_or_else(|| format!("unsupported native runtime: {value}"))
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentNativeRuntimeSwitches")]
pub struct NativeRuntimeSwitches {
    #[serde(default)]
    pub antigravity: bool,
    #[serde(default)]
    pub codex: bool,
    #[serde(default)]
    pub claude: bool,
}
impl NativeRuntimeSwitches {
    pub fn enabled(&self, runtime: NativeRuntime) -> bool {
        match runtime {
            NativeRuntime::Antigravity => self.antigravity,
            NativeRuntime::Codex => self.codex,
            NativeRuntime::Claude => self.claude,
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentNativeCommands")]
pub struct NativeCommands {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub antigravity: Option<NativeCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<NativeCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<NativeCommand>,
}
/// Ordinary launch overrides. Authentication remains in the native CLI login store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentNativeCommand")]
pub struct NativeCommand {
    #[schemars(length(min = 1))]
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// Observations and text; immutable attachments travel in the actual request resources.
/// No path, invocation or conversation key is authority.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ExecutorExecute")]
pub struct Execute {
    pub task_id: maka_agent_facts::durable::ExternalTaskId,
    #[serde(
        default,
        skip_serializing_if = "maka_agent_facts::language::Language::is_english"
    )]
    pub language: maka_agent_facts::language::Language,
    pub execution: maka_agent_facts::durable::ExecutionIdentity,
    #[schemars(length(min = 1))]
    pub conversation_key: String,
    pub message: String,
    #[schemars(length(min = 1))]
    pub cwd: String,
    pub instructions: Option<String>,
    pub settings: maka_agent_facts::executor::Settings,
}
/// A provider-owned append-only output record. `index` is zero based.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ExecutorIndexedOutput")]
pub struct IndexedOutput {
    pub index: u64,
    pub output: maka_agent_facts::executor::Output,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ExecutorTaskState")]
pub enum TaskState {
    Running,
    /// The original task may still exist. This never permits a new execute.
    Unknown {
        diagnostic: String,
    },
    Closed {
        outcome: Outcome,
    },
}

/// Read only the exact provider task. A cursor requests output from that index;
/// no cursor observes headers only, with no output reads. Never starts a job.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ExecutorObserve")]
pub struct Observe {
    pub task_id: maka_agent_facts::durable::ExternalTaskId,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub after_index: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "ExecutorTaskObservation")]
pub enum TaskObservation {
    /// Absence is not proof that the original job never ran.
    Missing,
    Found {
        task_id: maka_agent_facts::durable::ExternalTaskId,
        /// Exclusive item count represented by this page; zero for header-only observation.
        observed: u64,
        has_more: bool,
        #[schemars(length(max = 256))]
        outputs: Vec<IndexedOutput>,
        state: TaskState,
        cleanup: maka_plugin_core::operation::OperationCleanup,
    },
}

pub fn contract() -> Contract {
    Contract {
        name: "maka.agent.Executor".into(),
        version: 2,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "execute".into(),
                    Method {
                        progress: Some(schemars::schema_for!(IndexedOutput).into()),
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Execute).into(),
                        output: schemars::schema_for!(Outcome).into(),
                        resources: BTreeMap::from([(
                            "attachments".into(),
                            maka_plugin_core::contract::binary_resource_type().optional(),
                        )]),
                    },
                ),
                (
                    "observe".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Subscription,
                        input: schemars::schema_for!(Observe).into(),
                        output: schemars::schema_for!(TaskObservation).into(),
                        resources: BTreeMap::new(),
                    },
                ),
            ]),
        },
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentMetadata {
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    pub digest: String,
}
