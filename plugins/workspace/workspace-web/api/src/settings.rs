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
use std::collections::BTreeMap;

#[derive(
    Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema,
)]
#[schemars(rename = "WebSource")]
#[serde(rename_all = "snake_case")]
pub enum Source {
    #[default]
    Model,
    #[serde(alias = "tavily")]
    Custom,
}

#[derive(Clone, Default, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WebBackend")]
pub enum Backend {
    #[default]
    Tavily,
    Brave,
    Exa,
    Serper,
    Custom {
        endpoint: Endpoint,
    },
}

impl Backend {
    pub fn preset_id(&self) -> Option<&'static str> {
        match self {
            Self::Tavily => Some("tavily"),
            Self::Brave => Some("brave"),
            Self::Exa => Some("exa"),
            Self::Serper => Some("serper"),
            Self::Custom { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WebSearchEndpoint")]
pub struct Endpoint {
    pub url: String,
    pub method: Method,
    pub query: Parameter,
    pub limit: Option<Parameter>,
    pub url_parameters: BTreeMap<String, String>,
    pub body: serde_json::Map<String, serde_json::Value>,
    pub auth: Option<Auth>,
    pub results: ResultsMapping,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "WebSearchMethod")]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "WebParameterLocation")]
pub enum ParameterLocation {
    Query,
    Body,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebParameter")]
pub struct Parameter {
    pub location: ParameterLocation,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "WebAuthLocation")]
pub enum AuthLocation {
    Header,
    Query,
    Body,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebAuth")]
pub struct Auth {
    pub location: AuthLocation,
    pub name: String,
    pub prefix: String,
}

/// JSON pointers, with an empty list pointer selecting the response root.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebResultMapping")]
pub struct ResultsMapping {
    pub list: String,
    pub title: Option<String>,
    pub url: String,
    pub snippet: Option<String>,
}

#[derive(Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebSearchPreset")]
pub struct Preset {
    pub id: &'static str,
    pub endpoint: Endpoint,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[schemars(rename = "WebSettings")]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub source: Source,
    #[serde(default)]
    pub backend: Backend,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            source: Source::Model,
            backend: Backend::default(),
        }
    }
}
#[derive(Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebSnapshot")]
pub struct Snapshot {
    pub revision: Option<u64>,
    pub settings: Settings,
    pub credential: Credential,
    pub presets: &'static [Preset],
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
    pub credential_revision: Option<u64>,
    #[serde(default)]
    pub settings_revision: Option<u64>,
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
