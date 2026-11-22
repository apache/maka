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

//! Independent endpoint observation; it does not establish process ownership.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebProbe")]
pub struct Input {
    #[schemars(length(min = 1))]
    pub url: String,
}
impl Input {
    pub fn target(&self) -> Result<String, String> {
        let url = url::Url::parse(&self.url).map_err(|_| "Invalid health endpoint URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Use an HTTP(S) health URL without user credentials or fragment".into());
        }
        Ok(url.to_string())
    }
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "WebEndpoint")]
pub enum Endpoint {
    NotChecked,
    Unknown {
        target: String,
        error: String,
    },
    Checked {
        target: String,
        http_status: u16,
        elapsed_ms: u64,
        health: Readiness,
    },
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "WebReadiness")]
pub enum Readiness {
    Healthy,
    Unknown,
    Unhealthy,
}
