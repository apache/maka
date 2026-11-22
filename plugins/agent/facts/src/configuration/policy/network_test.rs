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

use super::NetworkProxy;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub network_proxy: Option<NetworkProxy>,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub url: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub ok: bool,
    pub latency_ms: u64,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub status: Option<u16>,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub ip: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub country_code: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub country_flag: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::configuration::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub error: Option<String>,
}

impl Output {
    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::default()
        }
    }
}
