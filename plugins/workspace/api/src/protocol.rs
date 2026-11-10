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
use maka_plugin_core::operation::{OperationCleanup, RecoveryRef};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const IMPLEMENTATION: &str = "maka.workspace.protocol-processes";
pub const EXPORT: &str = "protocol";
pub const CHUNK_BYTES: usize = 8192;

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessLaunch")]
pub struct Launch {
    #[schemars(length(min = 1))]
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessRun")]
pub struct Run {
    #[schemars(length(min = 1))]
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub additional_permissions: Option<maka_sandbox::grant::Permissions>,
    #[schemars(length(min = 1))]
    pub justification: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessInput")]
pub struct Input {
    pub id: Uuid,
    pub additional_permissions: Option<maka_sandbox::grant::Permissions>,
    #[schemars(length(min = 1))]
    pub justification: Option<String>,
    /// Null closes stdin. Empty data is a successful zero-byte write.
    #[schemars(length(max = CHUNK_BYTES))]
    pub bytes: Option<Vec<u8>>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessClose")]
pub struct Close {
    pub id: Uuid,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessObserve")]
pub struct Observe {
    pub original: RecoveryRef,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessObservation")]
pub struct Observation {
    pub original: RecoveryRef,
    pub id: Uuid,
    pub cleanup: OperationCleanup,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessProgress")]
pub enum Progress {
    Started {
        id: Uuid,
        /// Original protected private-task resource address, not launch authority.
        resource_ref: String,
    },
    Output {
        stream: Stream,
        #[schemars(length(max = CHUNK_BYTES))]
        bytes: Vec<u8>,
    },
}
#[derive(Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "ProtocolProcessStream")]
pub enum Stream {
    Stdout,
    Stderr,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessCompletion")]
pub enum Completion {
    Exited {
        code: Option<i32>,
        success: bool,
        stopped: bool,
        error: Option<String>,
    },
    Failed {
        message: String,
    },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "ProtocolProcessWritten")]
pub struct Written {
    pub bytes: usize,
    pub closed: bool,
}

pub fn contract() -> Contract {
    Contract {
        name: "maka.workspace.ProtocolProcesses".into(),
        version: 2,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "observe".into(),
                    Method {
                        mode: MethodMode::Subscription,
                        input: schemars::schema_for!(Observe).into(),
                        output: schemars::schema_for!(Observation).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "close".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Close).into(),
                        output: schemars::schema_for!(Written).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "launch".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Launch).into(),
                        output: schemars::schema_for!(Completion).into(),
                        progress: Some(schemars::schema_for!(Progress).into()),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "run".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Run).into(),
                        output: schemars::schema_for!(Completion).into(),
                        progress: Some(schemars::schema_for!(Progress).into()),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "input".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Input).into(),
                        output: schemars::schema_for!(Written).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                ),
            ]),
        },
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        crate::processes::configuration_schema(),
        [(EXPORT, contract())],
    )
}
