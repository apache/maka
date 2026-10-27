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
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "ComputerEvaluate")]
#[serde(deny_unknown_fields)]
pub struct Evaluate {
    pub code: String,
    /// Execution budget. Trusted consent and macOS/Windows native waits pause it.
    /// Ordinary asynchronous waits remain charged. Interrupted REPLs require reset.
    #[serde(default = "default_timeout")]
    #[schemars(range(min = 1))]
    pub timeout_ms: u64,
    /// Short, user-facing description of this call, in the user’s language.
    pub title: Option<String>,
}
fn default_timeout() -> u64 {
    30_000
}

pub fn validate(name: &str, input: &Value) -> Result<(), String> {
    match name {
        "cua_repl" => {
            let input: Evaluate =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            if input.timeout_ms == 0
                || std::time::Instant::now()
                    .checked_add(std::time::Duration::from_millis(input.timeout_ms))
                    .is_none()
            {
                return Err("Cua timeout_ms must be positive and representable".into());
            }
            Ok(())
        }
        "cua_reset" if input.as_object().is_some_and(|v| v.is_empty()) => Ok(()),
        _ => Err("unknown Computer Use tool or invalid input".into()),
    }
}

pub const IMPLEMENTATION: &str = "maka.workspace.computer";
pub const EXPORT: &str = "computer";

#[derive(Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerConfiguration")]
pub struct Configuration {
    #[serde(default)]
    pub desktop: maka_capabilities::computer::Desktop,
    #[serde(default)]
    pub browsers: Vec<maka_capabilities::computer::BrowserConnection>,
    /// Explicit opt-in to recording computer output audio.
    #[serde(default)]
    pub audio: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "ComputerReplState")]
pub enum ReplState {
    Fresh,
    Ready,
    ResetRequired,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ComputerResult")]
pub enum ResultValue {
    /// Immutable output in this original invocation's Session/Turn. The explicit
    /// Agent output projection consumes it; the identifier is not a read grant.
    Completed {
        artifact: String,
        state: ReplState,
    },
    Failed {
        message: String,
        state: ReplState,
    },
}

pub fn target() -> maka_agent_facts::interaction::GrantTarget {
    use maka_agent_facts::interaction::{GrantCapability, GrantScope, GrantTarget};
    GrantTarget {
        provider_id: "maka_workspace_computer".into(),
        contract_id: "maka_workspace_computer_v1".into(),
        server_id: "maka_workspace_computer".into(),
        tool_name: "cua_repl".into(),
        capability: GrantCapability::ComputerUse,
        scope: GrantScope::Capability {},
    }
}

pub fn audio_target() -> maka_agent_facts::interaction::GrantTarget {
    maka_agent_facts::interaction::GrantTarget {
        capability: maka_agent_facts::interaction::GrantCapability::ComputerAudio,
        ..target()
    }
}

pub fn is_browser_target(candidate: &maka_agent_facts::interaction::GrantTarget) -> bool {
    use maka_agent_facts::interaction::{GrantCapability, GrantScope};
    if candidate.validate().is_err()
        || candidate.capability != GrantCapability::Browser
        || !matches!(candidate.scope, GrantScope::BrowserOrigin { .. })
    {
        return false;
    }
    let mut expected = target();
    expected.capability = GrantCapability::Browser;
    expected.scope = candidate.scope.clone();
    candidate == &expected
}

pub fn configuration_schema() -> Value {
    schemars::schema_for!(Configuration).into()
}
pub fn contract() -> Contract {
    let empty = serde_json::json!({"type":"object","properties":{},"additionalProperties":false});
    Contract {
        name: "maka.workspace.Computer".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "evaluate".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Evaluate).into(),
                        output: schemars::schema_for!(ResultValue).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "reset".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: empty.clone().into(),
                        output: schemars::schema_for!(ResultValue).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "state".into(),
                    Method {
                        mode: MethodMode::Query,
                        input: empty.into(),
                        output: schemars::schema_for!(ReplState).into(),
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
        configuration_schema(),
        [(EXPORT, contract())],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::interaction::{GrantCapability, GrantScope};

    #[test]
    fn browser_consent_requires_the_original_computer_producer_and_canonical_origin() {
        let mut browser = target();
        browser.capability = GrantCapability::Browser;
        browser.scope = GrantScope::BrowserOrigin {
            origin: "https://example.com".into(),
        };
        assert!(is_browser_target(&browser));
        for field in ["provider", "contract", "server", "tool"] {
            let mut foreign = browser.clone();
            match field {
                "provider" => foreign.provider_id = "foreign".into(),
                "contract" => foreign.contract_id = "foreign".into(),
                "server" => foreign.server_id = "foreign".into(),
                "tool" => foreign.tool_name = "foreign".into(),
                _ => unreachable!(),
            }
            assert!(!is_browser_target(&foreign));
        }
        browser.scope = GrantScope::BrowserOrigin {
            origin: "https://example.com/private".into(),
        };
        assert!(!is_browser_target(&browser));
        assert!(!is_browser_target(&target()));
        assert!(!is_browser_target(&audio_target()));
    }
}
