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
pub const IMPLEMENTATION: &str = "maka.agent.acp";
pub const EXPORT: &str = "executor";
pub const SETUP: &str = "setup";
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AcpExecutorConfiguration")]
pub struct Configuration {
    pub agent: maka_external_agent::Agent,
    /// Requested launch access, still subject to installation limits and consent.
    pub permissions: Option<maka_sandbox::grant::Permissions>,
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        schemars::schema_for!(Configuration).into(),
        [
            (EXPORT, crate::executor::contract()),
            (SETUP, crate::executor::setup::contract()),
        ],
    )
}
