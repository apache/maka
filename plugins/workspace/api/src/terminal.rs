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

use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use maka_plugin_core::terminal::TerminalSize;
use maka_plugin_core::terminal::input::InputAction;
pub use maka_presentation::shell::ResourceUpdate;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const EXPORT: &str = "terminal";
pub const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalList")]
pub struct List {
    pub session_id: String,
    #[serde(default)]
    #[schemars(range(max = 9007199254740991u64))]
    pub offset: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalTarget")]
pub struct Target {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub reference: String,
}
/// Exclusive cursor in this original target's native Data/Resize log. A Data
/// delivery can combine adjacent records; its sequence is the last consumed
/// native record. Any original cursor remains valid, including inside a batch.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalOutputRequest")]
pub struct OutputRequest {
    pub target: Target,
    #[serde(default)]
    #[schemars(range(max = 9007199254740991u64))]
    pub after: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "TerminalOutputUnavailable")]
pub enum OutputUnavailable {
    NotRetained,
}
/// Ephemeral output observation; Closed is not a process cleanup receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "TerminalOutputEvent")]
pub enum OutputEvent {
    Data {
        #[schemars(range(min = 1, max = 9007199254740991u64))]
        sequence: u64,
        size: TerminalSize,
        initial_size: TerminalSize,
        #[schemars(length(min = 1))]
        data_base64: String,
    },
    Resize {
        #[schemars(range(min = 1, max = 9007199254740991u64))]
        sequence: u64,
        size: TerminalSize,
        initial_size: TerminalSize,
    },
    Pending {
        #[schemars(range(max = 9007199254740991u64))]
        after: u64,
        size: TerminalSize,
        initial_size: TerminalSize,
    },
    Closed {
        #[schemars(range(max = 9007199254740991u64))]
        after: u64,
        size: TerminalSize,
        initial_size: TerminalSize,
    },
    Unavailable {
        reason: OutputUnavailable,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalStart")]
pub struct Start {
    pub session_id: String,
    /// Omit for an interactive shell; an explicit command runs with bounded pipes.
    pub command: Option<String>,
    pub size: Option<TerminalSize>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalController")]
pub struct Controller {
    pub target: Target,
    pub controller_id: Uuid,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalControl")]
pub struct Control {
    pub controller: Controller,
    #[schemars(range(min = 1, max = 9007199254740991u64))]
    pub sequence: u64,
    #[serde(default)]
    pub actions: Vec<InputAction>,
    pub size: Option<TerminalSize>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalPage")]
pub struct Page {
    pub resources: Vec<ResourceUpdate>,
    pub revision: String,
    pub total: u64,
    pub next_offset: Option<u64>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalLeaseUpdate")]
pub struct LeaseUpdate {
    pub controller_id: Uuid,
    pub next_sequence: Option<u64>,
    pub held: bool,
    pub resource: ResourceUpdate,
}
#[derive(Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalControlReceipt")]
pub struct ControlReceipt {
    pub controller_id: Uuid,
    pub sequence: u64,
    pub accepted_bytes: usize,
    pub resized: bool,
    pub resize_changed: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalReleased")]
pub struct Released {
    pub controller_id: Uuid,
    pub released: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TerminalStopped")]
pub struct Stopped {
    pub applied: bool,
    pub resource: ResourceUpdate,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "TerminalOutcome_{T}")]
pub enum Outcome<T> {
    Completed { value: T },
    Failed { message: String },
}
fn method<I: JsonSchema, O: JsonSchema>(mode: MethodMode) -> Method {
    Method {
        progress: None,
        mode,
        input: schemars::schema_for!(I).into(),
        output: schemars::schema_for!(Outcome<O>).into(),
        resources: BTreeMap::new(),
    }
}
use maka_plugin_core::terminal::display::Part;

pub fn contract() -> Contract {
    Contract {
        name: "maka.workspace.Terminal".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                ("list".into(), method::<List, Page>(MethodMode::Query)),
                (
                    "watchList".into(),
                    method::<List, Page>(MethodMode::Subscription),
                ),
                (
                    "read".into(),
                    method::<Target, ResourceUpdate>(MethodMode::Query),
                ),
                (
                    "watch".into(),
                    method::<Target, ResourceUpdate>(MethodMode::Subscription),
                ),
                (
                    "readDisplay".into(),
                    method::<Target, Part>(MethodMode::Subscription),
                ),
                (
                    "readOutput".into(),
                    method::<OutputRequest, OutputEvent>(MethodMode::Query),
                ),
                (
                    "watchOutput".into(),
                    method::<OutputRequest, OutputEvent>(MethodMode::Subscription),
                ),
                (
                    "start".into(),
                    method::<Start, ResourceUpdate>(MethodMode::Mutation),
                ),
                (
                    "stop".into(),
                    method::<Target, Stopped>(MethodMode::Mutation),
                ),
                (
                    "acquire".into(),
                    method::<Target, LeaseUpdate>(MethodMode::Subscription),
                ),
                (
                    "control".into(),
                    method::<Control, ControlReceipt>(MethodMode::Mutation),
                ),
                (
                    "release".into(),
                    method::<Controller, Released>(MethodMode::Mutation),
                ),
            ]),
        },
    }
}
