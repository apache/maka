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

//! Client-facing shell state. It is a projection, never the operational authority.
mod project;
pub use maka_plugin_core::shell_result::*;
pub use project::{local_metadata, local_observation, local_state, local_update};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const SNAPSHOT_MAX_BYTES: usize = 48 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceUpdate {
    pub session_id: String,
    pub ownership: Ownership,
    pub correlation: serde_json::Value,
    pub visibility: maka_plugin_core::shell_run::ShellVisibility,
    pub result: ShellSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Ownership {
    Local,
    SourceOwned {
        source_session_id: String,
        owner_session_id: String,
    },
    SourceUnavailable {
        source_session_id: String,
    },
}
