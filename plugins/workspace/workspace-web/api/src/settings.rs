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

use serde::{Deserialize, Serialize};
pub const KEY: &str = "tavily";

#[derive(
    Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema,
)]
#[schemars(rename = "WebSource")]
#[serde(rename_all = "snake_case")]
pub enum Source {
    #[default]
    Model,
    Tavily,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[schemars(rename = "WebSettings")]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub source: Source,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            source: Source::Model,
        }
    }
}
#[derive(Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebSnapshot")]
pub struct Snapshot {
    pub revision: Option<u64>,
    pub settings: Settings,
    pub credential: Credential,
}
#[derive(Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebCredential")]
pub struct Credential {
    pub revision: Option<u64>,
    pub configured: bool,
    pub check: Option<Check>,
}
#[derive(Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebCheck")]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub credential_revision: u64,
    pub outcome: CheckOutcome,
}
#[derive(Clone, Copy, Deserialize, Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebCheckOutcome")]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Valid,
    InvalidCredentials,
    RateLimited,
    NetworkError,
    Timeout,
}
