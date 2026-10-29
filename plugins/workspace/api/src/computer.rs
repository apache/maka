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
    /// Optional browser preparation allowed by Maka Host policy.
    ///
    /// This policy is captured for one activation. Updated configuration applies
    /// to new admissions after the replacement is ready; accepted work drains
    /// under its captured policy. Commit/adoption acknowledges desired input only.
    /// Old header removal and native cleanup require their own completion.
    #[serde(default)]
    pub browser_preparation: BrowserPreparation,
}

/// Maka Host policy for requesting or adopting optional browser preparations.
/// The raw fields are independently configurable. Effective Maka popup adoption
/// and relay use `popup || !request_headers.is_empty()` so headers can reach the
/// first request.
///
/// | `popup` | `request_headers` | Effective Maka popup adoption/relay |
/// | --- | --- | --- |
/// | `false` | empty | `false` |
/// | `true` | empty | `true` |
/// | `false` | nonempty | `true` |
/// | `true` | nonempty | `true` |
///
/// Defaults request neither preparation; they do not report native hook state.
/// Original full preparation may still run fixed preparers enabled natively.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerBrowserPreparation")]
pub struct BrowserPreparation {
    /// Raw Maka opt-in for popup adoption and relay.
    ///
    /// Nonempty `request_headers` also enables effective Maka popup adoption and
    /// relay, even when this raw flag is `false`.
    ///
    /// `false` or omitting an enable call does not confirm that Original page
    /// hooks are off. No native popup-state query or disable RPC is established.
    pub popup: bool,
    /// Request headers passed to the native browser preparation boundary.
    ///
    /// A nonempty list also enables effective Maka popup adoption and relay so
    /// headers can reach the first request.
    ///
    /// An empty list alone does not confirm that existing native hooks are off.
    /// An explicitly submitted empty list needs an actual disable acknowledgement;
    /// leaving the default empty list unsubmitted provides no such confirmation.
    pub request_headers: Vec<BrowserPreparationHeader>,
}

/// A request header selected by Maka Host browser preparation policy.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerBrowserPreparationHeader")]
pub struct BrowserPreparationHeader {
    /// Header name validated by the native browser provider.
    pub name: String,
    /// Header value validated by the native browser provider.
    pub value: String,
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
    is_browser_origin_target(
        candidate,
        maka_agent_facts::interaction::GrantCapability::Browser,
    )
}

/// Match independent browsing-history consent for the actual selected profile.
pub fn is_browser_history_target(candidate: &maka_agent_facts::interaction::GrantTarget) -> bool {
    use maka_agent_facts::interaction::{GrantCapability, GrantScope};
    let mut expected = target();
    expected.capability = GrantCapability::BrowserHistory;
    expected.scope = candidate.scope.clone();
    candidate == &expected
        && matches!(&candidate.scope,
        GrantScope::BrowserProfile { browser_id, generation }
            if !browser_id.is_empty() && !generation.is_empty())
        && candidate.validate().is_ok()
}

/// Recognize file download consent from the original Computer Use producer.
pub fn is_browser_download_target(candidate: &maka_agent_facts::interaction::GrantTarget) -> bool {
    is_browser_origin_target(
        candidate,
        maka_agent_facts::interaction::GrantCapability::BrowserDownload,
    )
}

/// Recognize file upload consent from the original Computer Use producer.
pub fn is_browser_upload_target(candidate: &maka_agent_facts::interaction::GrantTarget) -> bool {
    is_browser_origin_target(
        candidate,
        maka_agent_facts::interaction::GrantCapability::BrowserUpload,
    )
}

fn is_browser_origin_target(
    candidate: &maka_agent_facts::interaction::GrantTarget,
    capability: maka_agent_facts::interaction::GrantCapability,
) -> bool {
    use maka_agent_facts::interaction::GrantScope;
    if candidate.validate().is_err()
        || candidate.capability != capability
        || !matches!(candidate.scope, GrantScope::BrowserOrigin { .. })
    {
        return false;
    }
    let mut expected = target();
    expected.capability = capability;
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
    fn browser_preparation_defaults_disable_both_host_preparations() {
        let expected = serde_json::json!({"popup": false, "requestHeaders": []});
        assert_eq!(
            serde_json::to_value(Configuration::default().browser_preparation)
                .expect("default browser preparation serializes"),
            expected,
        );
        for input in [
            serde_json::json!({}),
            serde_json::json!({"browserPreparation": {}}),
            serde_json::json!({"browserPreparation": {"popup": false}}),
            serde_json::json!({"browserPreparation": {"requestHeaders": []}}),
        ] {
            let configuration: Configuration = serde_json::from_value(input.clone())
                .expect("omitted browser preparation controls use Host policy defaults");
            assert_eq!(
                serde_json::to_value(configuration.browser_preparation)
                    .expect("browser preparation serializes"),
                expected,
                "input {input}",
            );
        }
    }

    #[test]
    fn browser_preparation_controls_are_independent() {
        for popup in [false, true] {
            for request_headers in [
                serde_json::json!([]),
                serde_json::json!([{"name": "X-Maka-Test", "value": "retained value"}]),
            ] {
                let expected = serde_json::json!({
                    "popup": popup,
                    "requestHeaders": request_headers,
                });
                let configuration: Configuration = serde_json::from_value(serde_json::json!({
                    "browserPreparation": expected.clone(),
                }))
                .expect("popup and request headers can be configured independently");
                assert_eq!(
                    serde_json::to_value(configuration.browser_preparation)
                        .expect("browser preparation serializes"),
                    expected,
                    "popup and request headers must survive deserialization independently",
                );
            }
        }
    }

    #[test]
    fn browser_preparation_rejects_unknown_fields() {
        for input in [
            serde_json::json!({"browserPreparation": {"unexpected": true}}),
            serde_json::json!({"browserPreparation": {"requestHeaders": [{
                "name": "X-Maka-Test", "value": "value", "unexpected": true,
            }]}}),
        ] {
            assert!(
                serde_json::from_value::<Configuration>(input.clone()).is_err(),
                "unknown browser preparation field accepted: {input}",
            );
        }
    }

    #[test]
    fn browser_preparation_schema_exposes_typed_optional_controls() {
        let schema = configuration_schema();
        assert_eq!(
            schema["properties"]["browserPreparation"]["$ref"],
            "#/$defs/ComputerBrowserPreparation",
        );
        assert_eq!(
            schema["properties"]["browserPreparation"]["default"],
            serde_json::json!({"popup": false, "requestHeaders": []}),
        );
        let preparation = &schema["$defs"]["ComputerBrowserPreparation"];
        assert_eq!(preparation["additionalProperties"], false);
        assert_eq!(preparation["properties"]["popup"]["type"], "boolean");
        assert_eq!(preparation["properties"]["popup"]["default"], false);
        assert_eq!(preparation["properties"]["requestHeaders"]["type"], "array");
        assert_eq!(
            preparation["properties"]["requestHeaders"]["default"],
            serde_json::json!([]),
        );
        assert_eq!(
            preparation["properties"]["requestHeaders"]["items"]["$ref"],
            "#/$defs/ComputerBrowserPreparationHeader",
        );
        assert!(
            preparation
                .get("required")
                .is_none_or(|required| required.as_array().is_some_and(Vec::is_empty)),
            "browser preparation controls must remain optional",
        );
        let header = &schema["$defs"]["ComputerBrowserPreparationHeader"];
        assert_eq!(header["additionalProperties"], false);
        assert_eq!(header["properties"]["name"]["type"], "string");
        assert_eq!(header["properties"]["value"]["type"], "string");
        assert_eq!(header["required"], serde_json::json!(["name", "value"]));
    }

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

    #[test]
    fn browser_download_consent_is_independent_and_requires_the_exact_producer() {
        let mut download = target();
        download.capability = GrantCapability::BrowserDownload;
        download.scope = GrantScope::BrowserOrigin {
            origin: "https://download.example".into(),
        };
        assert!(is_browser_download_target(&download));
        assert!(!is_browser_target(&download));
        let mut read = download.clone();
        read.capability = GrantCapability::Browser;
        assert!(is_browser_target(&read));
        assert!(!is_browser_download_target(&read));
        for field in ["provider", "contract", "server", "tool"] {
            let mut foreign = download.clone();
            match field {
                "provider" => foreign.provider_id = "foreign".into(),
                "contract" => foreign.contract_id = "foreign".into(),
                "server" => foreign.server_id = "foreign".into(),
                "tool" => foreign.tool_name = "foreign".into(),
                _ => unreachable!(),
            }
            assert!(!is_browser_download_target(&foreign));
        }
        download.scope = GrantScope::Capability {};
        assert!(!is_browser_download_target(&download));
    }
}

#[cfg(test)]
mod browser_history_target_tests {
    use super::*;
    use maka_agent_facts::interaction::{GrantCapability, GrantScope};
    #[test]
    fn history_consent_cannot_alias_site_or_capability_consent() {
        let mut history = target();
        history.capability = GrantCapability::BrowserHistory;
        history.scope = GrantScope::BrowserProfile {
            browser_id: "maka:instance".to_owned(),
            generation: "generation".to_owned(),
        };
        assert!(is_browser_history_target(&history));
        assert!(!is_browser_target(&history));
        assert!(!is_browser_download_target(&history));
        let mut foreign = history.clone();
        foreign.scope = GrantScope::BrowserOrigin {
            origin: "https://example.test".to_owned(),
        };
        assert!(!is_browser_history_target(&foreign));
        foreign.scope = GrantScope::Capability {};
        assert!(!is_browser_history_target(&foreign));
        foreign = history.clone();
        foreign.tool_name = "other_tool".to_owned();
        assert!(!is_browser_history_target(&foreign));
        let mut next_profile = history.clone();
        next_profile.scope = GrantScope::BrowserProfile {
            browser_id: "maka:instance".to_owned(),
            generation: "other-generation".to_owned(),
        };
        assert_ne!(history, next_profile);
    }
}
