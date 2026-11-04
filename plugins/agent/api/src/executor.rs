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

use maka_agent_ports::executor::Outcome;
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub mod setup;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentServiceExecutor")]
pub struct ServiceExecutor {
    #[schemars(regex(pattern = "^[a-zA-Z][a-zA-Z0-9._:-]*$"))]
    pub name: String,
    #[schemars(length(min = 1))]
    pub import: String,
    /// Exact member of the explicitly bound import, never a discovery index.
    #[serde(default)]
    pub member: usize,
    #[serde(default)]
    pub setup: Option<setup::Binding>,
}
pub use maka_agent_facts::executor::Selection;
/// Explicit opt-in to OAR's own default permissions and native agent tools.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentOarConfiguration")]
pub struct OarConfiguration {
    #[serde(default = "oar_enabled")]
    pub enabled: bool,
    /// Each runtime requires explicit opt-in, even when the legacy gate is enabled.
    #[serde(default)]
    pub runtimes: BTreeMap<String, bool>,
    /// Absent selects the worker shipped beside the Maka executable.
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

impl OarConfiguration {
    pub fn enabled_runtimes(&self) -> impl Iterator<Item = &str> {
        self.runtimes
            .iter()
            .filter(|(_, enabled)| self.enabled && **enabled)
            .map(|(id, _)| id.as_str())
    }
}

fn oar_enabled() -> bool {
    true
}

/// Observations and text; immutable attachments travel in the actual request resources.
/// No path, invocation or conversation key is authority.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ExecutorExecute")]
pub struct Execute {
    #[serde(
        default,
        skip_serializing_if = "maka_agent_facts::language::Language::is_english"
    )]
    pub language: maka_agent_facts::language::Language,
    pub invocation: maka_agent_facts::event::Invocation,
    #[schemars(length(min = 1))]
    pub conversation_key: String,
    pub message: String,
    #[schemars(length(min = 1))]
    pub cwd: String,
    pub instructions: Option<String>,
    pub settings: maka_agent_facts::executor::Settings,
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.agent.Executor".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "execute".into(),
                Method {
                    progress: Some(
                        schemars::schema_for!(maka_agent_facts::executor::Output).into(),
                    ),
                    mode: MethodMode::Mutation,
                    input: serde_json::to_value(schemars::schema_for!(Execute))
                        .expect("executor input")
                        .into(),
                    output: serde_json::to_value(schemars::schema_for!(Outcome))
                        .expect("executor output")
                        .into(),
                    resources: BTreeMap::from([(
                        "attachments".into(),
                        maka_plugin_core::contract::binary_resource_type().optional(),
                    )]),
                },
            )]),
        },
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentMetadata {
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    pub digest: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::language::Language;

    #[test]
    fn oar_runtime_opt_in_preserves_old_launch_settings_without_enabling_any_runtime() {
        let mut settings: OarConfiguration = serde_json::from_value(serde_json::json!({
            "executable":"/custom/worker", "args":["--custom"]
        }))
        .unwrap();
        assert!(settings.enabled);
        assert_eq!(settings.enabled_runtimes().count(), 0);
        settings.runtimes.insert("codex".into(), true);
        settings.runtimes.insert("claude".into(), false);
        assert_eq!(
            settings.enabled_runtimes().collect::<Vec<_>>(),
            vec!["codex"]
        );
        settings.enabled = false;
        assert_eq!(settings.enabled_runtimes().count(), 0);
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            serde_json::json!({
                "enabled":false, "runtimes":{"codex":true,"claude":false}, "executable":"/custom/worker", "args":["--custom"]
            })
        );
        let restored: OarConfiguration =
            serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
        assert!(!restored.enabled);
    }

    #[test]
    fn persisted_execute_uses_canonical_english_omission_and_exact_chinese_tags() {
        let original = serde_json::json!({
            "invocation":{"session_id":"session","turn_id":"turn","run_id":"run","invocation_id":"invocation"},
            "conversationKey":"conversation", "message":"Original 原文", "cwd":"/workspace",
            "instructions":null, "settings":{}
        });
        let mut input: Execute = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(input.language, Language::En);
        assert_eq!(serde_json::to_value(&input).unwrap(), original);
        for (language, tag) in [(Language::ZhCn, "zh-CN"), (Language::ZhTw, "zh-TW")] {
            input.language = language;
            let mut expected = original.clone();
            expected["language"] = tag.into();
            assert_eq!(serde_json::to_value(&input).unwrap(), expected);
        }
    }

    #[test]
    fn executor_contract_preserves_complete_fields_beyond_former_schema_bounds() {
        let original = serde_json::json!({
            "invocation":{"session_id":"session","turn_id":"turn","run_id":"run","invocation_id":"invocation"},
            "conversationKey":format!("conversation-{}-final", "route".repeat(100)),
            "message":format!("{}USER_FINAL_MARKER", "Original user message 原文\n".repeat(5_000)),
            "cwd":format!("/workspace/{}/final", "nested/".repeat(700)),
            "instructions":format!("{}INSTRUCTIONS_FINAL_MARKER", "External execution instructions\n".repeat(3_000)),
            "settings":{}
        });
        let Contract {
            interface: Interface::Service { methods },
            ..
        } = contract()
        else {
            panic!("executor service contract");
        };
        let validator = jsonschema::validator_for(&methods["execute"].input).unwrap();
        assert!(validator.is_valid(&original));
        let input: Execute = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(serde_json::to_value(input).unwrap(), original);
        for field in ["conversationKey", "cwd"] {
            let mut invalid = original.clone();
            invalid[field] = serde_json::json!("");
            assert!(!validator.is_valid(&invalid));
        }
    }
}
