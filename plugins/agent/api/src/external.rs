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

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentExternalAgentsRead")]
pub struct ExternalAgentsRead {
    #[serde(default)]
    pub inspect: bool,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExternalAgents")]
pub struct ExternalAgents {
    pub target: ConfigurationTarget,
    pub configured: bool,
    pub runtimes: Vec<RuntimeOption>,
    pub state: ExternalAgentsState,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExternalRuntimeOption")]
pub struct RuntimeOption {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

pub fn runtime_options(
    configuration: Option<&crate::executor::ExternalConfiguration>,
) -> Vec<RuntimeOption> {
    crate::executor::NativeRuntime::ALL
        .into_iter()
        .map(|runtime| RuntimeOption {
            id: runtime.as_str().into(),
            name: runtime.name().into(),
            enabled: configuration
                .is_some_and(|configuration| configuration.runtimes.enabled(runtime)),
        })
        .collect()
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExternalAgentsTarget")]
pub struct ConfigurationTarget {
    pub source: crate::contract::DataSource,
    pub path: Vec<String>,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentExternalAgentsState")]
pub enum ExternalAgentsState {
    Disabled,
    Enabled,
    WorkspaceRequired,
    Unavailable { message: String },
    Ready { runtimes: Vec<RuntimeRecord> },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExternalRuntime")]
pub struct RuntimeRecord {
    pub id: String,
    pub name: String,
    pub installation: Installation,
    pub authentication: Authentication,
    pub models: Models,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentExternalInstallation")]
pub enum Installation {
    Available {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    NotFound,
    Unsupported {
        detail: String,
    },
    Error {
        detail: String,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentExternalAuthentication")]
pub enum Authentication {
    Authenticated {
        source: String,
    },
    Unauthenticated {
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Unsupported,
    Unknown {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        configured: Option<Vec<String>>,
    },
    Error {
        detail: String,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentExternalModels")]
pub enum Models {
    Ready {
        count: usize,
    },
    Unauthenticated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Unsupported {
        detail: String,
    },
    Unavailable,
    Error {
        detail: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_supported_native_runtimes_are_offered_and_require_opt_in() {
        let mut configuration: crate::executor::ExternalConfiguration =
            serde_json::from_value(serde_json::json!({"runtimes":{"codex":true}})).unwrap();
        let options = runtime_options(Some(&configuration));
        let ids: std::collections::BTreeSet<_> =
            options.iter().map(|runtime| runtime.id.as_str()).collect();
        assert_eq!(
            ids,
            std::collections::BTreeSet::from(["antigravity", "codex", "claude"])
        );
        assert_eq!(
            options
                .iter()
                .filter(|runtime| runtime.enabled)
                .map(|runtime| runtime.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex"]
        );
        configuration.runtimes.codex = false;
        assert!(
            runtime_options(Some(&configuration))
                .iter()
                .all(|runtime| !runtime.enabled)
        );
        assert!(runtime_options(None).iter().all(|runtime| !runtime.enabled));
    }
}
