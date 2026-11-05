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

/// Only OAR's declared installation operations; not an agent registry or login shim.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentOarSetup")]
pub struct Setup {
    #[schemars(length(min = 1))]
    pub runtime: String,
    pub action: Action,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentOarSetupAction")]
pub enum Action {
    Probe,
    Plan { line: Option<String> },
    Install { line: Option<String> },
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentOarSetupResult")]
pub struct SetupResult {
    pub runtime: String,
    /// The pinned OAR version's native result, including unsupported capabilities.
    pub result: serde_json::Value,
}

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
    configuration: Option<&crate::executor::OarConfiguration>,
) -> Vec<RuntimeOption> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RuntimeMetadata {
        id: String,
        name: String,
    }
    static RUNTIMES: std::sync::OnceLock<Vec<RuntimeMetadata>> = std::sync::OnceLock::new();
    let metadata = RUNTIMES.get_or_init(|| {
        serde_json::from_str(include_str!("../../oar-executor/runtimes.json"))
            .expect("bundled OAR runtime metadata")
    });
    let mut options: Vec<_> = metadata
        .iter()
        .map(|runtime| RuntimeOption {
            id: runtime.id.clone(),
            name: runtime.name.clone(),
            enabled: configuration.is_some_and(|configuration| {
                configuration.enabled && configuration.runtimes.get(&runtime.id) == Some(&true)
            }),
        })
        .collect();
    if let Some(configuration) = configuration {
        options.extend(
            configuration
                .runtimes
                .iter()
                .filter(|(id, _)| !metadata.iter().any(|runtime| &runtime.id == *id))
                .map(|(id, enabled)| RuntimeOption {
                    id: id.clone(),
                    name: id.clone(),
                    enabled: configuration.enabled && *enabled,
                }),
        );
    }
    options
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
    pub can_install: bool,
    pub install_lines: Vec<InstallLine>,
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

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExternalInstallLine")]
pub struct InstallLine {
    pub line: String,
    pub description: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_options_preserves_unknown_configured_ids_after_known_options() {
        let mut configuration: crate::executor::OarConfiguration = serde_json::from_value(json!({
            "executable":"/unused/custom-worker", "args":["--custom"],
            "runtimes":{"codex":true,"cluade":true,"custom-runtime":false}
        }))
        .unwrap();
        for enabled in [true, false] {
            configuration.enabled = enabled;
            let options = runtime_options(Some(&configuration));
            assert_eq!(
                serde_json::to_value(&options[options.len() - 2..]).unwrap(),
                json!([
                    {"id":"cluade","name":"cluade","enabled":enabled},
                    {"id":"custom-runtime","name":"custom-runtime","enabled":false}
                ])
            );
            let codex = options
                .iter()
                .filter(|runtime| runtime.id == "codex")
                .collect::<Vec<_>>();
            assert_eq!(
                serde_json::to_value(codex).unwrap(),
                json!([{"id":"codex","name":"Codex","enabled":enabled}])
            );
        }
    }
}
