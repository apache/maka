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
use sha2::{Digest, Sha256};
use std::borrow::Cow;

/// Stable Host tool-use identity shared by client callbacks and presentation.
/// Provider IDs remain step-scoped model evidence and may not be wire-safe.
pub fn tool_use_id(invocation_id: &str, operation_id: &str) -> String {
    let bytes =
        serde_json::to_vec(&["maka.tool-presentation.v1", invocation_id, operation_id]).unwrap();
    format!("tool_{}", hex::encode(Sha256::digest(bytes)))
}

pub fn provider_result_id(event_id: &str, part_index: usize) -> String {
    format!("{event_id}_tool_result_{part_index}")
}

pub fn metered_usage_id(event_id: &str) -> String {
    format!("{event_id}:usage")
}

pub fn parse_metered_usage_id(id: &str) -> Option<&str> {
    id.strip_suffix(":usage")
}

pub fn parse_provider_result_id(id: &str) -> Option<(&str, usize)> {
    let (event, index) = id.rsplit_once("_tool_result_")?;
    let index: usize = index.parse().ok()?;
    (provider_result_id(event, index) == id).then_some((event, index))
}

/// Recorded Host settlement for presentation; returned is not business success.
/// Foreign/provider results do not establish this Host evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolSettlement {
    Returned,
    Failed,
    Unknown,
    Rejected,
}

/// Refusal category without input-derived explanation text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RejectionKind {
    Unavailable,
    InvalidInput,
    PolicyDenied,
    PreparationFailed,
    ExclusiveConflict,
    Cancelled,
}

/// A known refusal before durable dispatch: no tool effect was admitted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolRejection {
    #[error("tool is unavailable")]
    Unavailable,
    #[error("invalid tool input: {message}")]
    InvalidInput { message: String },
    #[error("tool policy denied: {message}")]
    PolicyDenied { message: String },
    #[error("tool preparation failed: {message}")]
    PreparationFailed { message: String },
    #[error("tool conflicts with exclusive step execution")]
    ExclusiveConflict,
    #[error("tool cancelled before dispatch; tool was not executed")]
    Cancelled,
}

/// A Tool Call is distinct from its durable host operation. Origin determines
/// model visibility; it is not an independent flag that can contradict ancestry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ToolCallIdentity {
    pub tool_call_id: String,
    pub origin: ToolOrigin,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolOrigin {
    Provider {
        step_id: String,
    },
    CodeMode {
        parent_operation_id: String,
        parent_tool_call_id: String,
    },
    /// An independently running cell accepted by an exec control call.
    /// Its parent may settle once startup/observation completes; its own nested
    /// tool effects must still drain before the cell's canonical settlement.
    CodeCell {
        parent_operation_id: String,
        parent_tool_call_id: String,
    },
    Standalone,
    /// Explicit Host SDK work, never dispatch inferred from executor observations.
    HostSdk {
        package_id: String,
        entry_id: String,
        activation: String,
        parent: Option<HostSdkParent>,
    },
}

// Nested effects retain their original canonical encoding. Only an observer
// adds relationship evidence; existing journal bytes and proofs stay intact.
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ToolOrigin")]
enum WireToolOrigin<'a> {
    Provider {
        step_id: Cow<'a, str>,
    },
    CodeMode {
        parent_operation_id: Cow<'a, str>,
        parent_tool_call_id: Cow<'a, str>,
    },
    CodeCell {
        parent_operation_id: Cow<'a, str>,
        parent_tool_call_id: Cow<'a, str>,
    },
    Standalone,
    HostSdk {
        package_id: Cow<'a, str>,
        entry_id: Cow<'a, str>,
        activation: Cow<'a, str>,
        parent_operation_id: Option<Cow<'a, str>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_relationship: Option<HostSdkRelationship<'a>>,
    },
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum HostSdkRelationship<'a> {
    EvaluationObserver { epoch: Cow<'a, str> },
}

impl Serialize for ToolOrigin {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let origin = match self {
            Self::Provider { step_id } => WireToolOrigin::Provider {
                step_id: Cow::Borrowed(step_id),
            },
            Self::CodeMode {
                parent_operation_id,
                parent_tool_call_id,
            } => WireToolOrigin::CodeMode {
                parent_operation_id: Cow::Borrowed(parent_operation_id),
                parent_tool_call_id: Cow::Borrowed(parent_tool_call_id),
            },
            Self::CodeCell {
                parent_operation_id,
                parent_tool_call_id,
            } => WireToolOrigin::CodeCell {
                parent_operation_id: Cow::Borrowed(parent_operation_id),
                parent_tool_call_id: Cow::Borrowed(parent_tool_call_id),
            },
            Self::Standalone => WireToolOrigin::Standalone,
            Self::HostSdk {
                package_id,
                entry_id,
                activation,
                parent,
            } => WireToolOrigin::HostSdk {
                package_id: Cow::Borrowed(package_id),
                entry_id: Cow::Borrowed(entry_id),
                activation: Cow::Borrowed(activation),
                parent_operation_id: parent
                    .as_ref()
                    .map(|parent| Cow::Borrowed(parent.operation_id())),
                parent_relationship: match parent {
                    Some(HostSdkParent::EvaluationObserver { epoch, .. }) => {
                        Some(HostSdkRelationship::EvaluationObserver {
                            epoch: Cow::Borrowed(epoch),
                        })
                    }
                    _ => None,
                },
            },
        };
        origin.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ToolOrigin {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match WireToolOrigin::deserialize(deserializer)? {
            WireToolOrigin::Provider { step_id } => Self::Provider {
                step_id: step_id.into_owned(),
            },
            WireToolOrigin::CodeMode {
                parent_operation_id,
                parent_tool_call_id,
            } => Self::CodeMode {
                parent_operation_id: parent_operation_id.into_owned(),
                parent_tool_call_id: parent_tool_call_id.into_owned(),
            },
            WireToolOrigin::CodeCell {
                parent_operation_id,
                parent_tool_call_id,
            } => Self::CodeCell {
                parent_operation_id: parent_operation_id.into_owned(),
                parent_tool_call_id: parent_tool_call_id.into_owned(),
            },
            WireToolOrigin::Standalone => Self::Standalone,
            WireToolOrigin::HostSdk {
                package_id,
                entry_id,
                activation,
                parent_operation_id,
                parent_relationship,
            } => {
                let parent = match (parent_operation_id, parent_relationship) {
                    (None, None) => None,
                    (Some(operation_id), None) => Some(HostSdkParent::NestedEffect {
                        operation_id: operation_id.into_owned(),
                    }),
                    (
                        Some(operation_id),
                        Some(HostSdkRelationship::EvaluationObserver { epoch }),
                    ) => Some(HostSdkParent::EvaluationObserver {
                        operation_id: operation_id.into_owned(),
                        epoch: epoch.into_owned(),
                    }),
                    (None, Some(_)) => {
                        return Err(serde::de::Error::custom(
                            "Host SDK relationship requires a parent operation",
                        ));
                    }
                };
                Self::HostSdk {
                    package_id: package_id.into_owned(),
                    entry_id: entry_id.into_owned(),
                    activation: activation.into_owned(),
                    parent,
                }
            }
        })
    }
}

impl schemars::JsonSchema for ToolOrigin {
    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("ToolOrigin")
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <WireToolOrigin<'_> as schemars::JsonSchema>::json_schema(generator)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostSdkParent {
    NestedEffect {
        operation_id: String,
    },
    /// The parent observes an independently owned effect admitted in this epoch.
    /// Its settlement does not establish the effect's physical completion.
    EvaluationObserver {
        operation_id: String,
        epoch: String,
    },
}

impl HostSdkParent {
    pub fn operation_id(&self) -> &str {
        match self {
            Self::NestedEffect { operation_id } | Self::EvaluationObserver { operation_id, .. } => {
                operation_id
            }
        }
    }
}

impl ToolCallIdentity {
    pub fn provider(step_id: String, tool_call_id: String) -> Self {
        Self {
            tool_call_id,
            origin: ToolOrigin::Provider { step_id },
        }
    }

    pub fn standalone(tool_call_id: String) -> Self {
        Self {
            tool_call_id,
            origin: ToolOrigin::Standalone,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_sdk_ancestry_preserves_canonical_encoding_and_adds_observer_evidence() {
        let origin = ToolOrigin::HostSdk {
            package_id: "workspace.computer".into(),
            entry_id: "computer".into(),
            activation: "activation".into(),
            parent: Some(HostSdkParent::EvaluationObserver {
                operation_id: "evaluation".into(),
                epoch: "eb6a8d42-32e5-46d4-a1f7-bd11767a8c3f".into(),
            }),
        };
        assert_eq!(
            serde_json::to_value(&origin).unwrap(),
            json!({
                "kind":"host_sdk", "package_id":"workspace.computer",
                "entry_id":"computer", "activation":"activation",
                "parent_operation_id":"evaluation", "parent_relationship":{"kind":"evaluation_observer",
                    "epoch":"eb6a8d42-32e5-46d4-a1f7-bd11767a8c3f"}
            })
        );
        assert_eq!(
            serde_json::from_value::<ToolOrigin>(serde_json::to_value(&origin).unwrap()).unwrap(),
            origin
        );
        for (parent, expected) in [
            (
                None,
                r#"{"kind":"host_sdk","package_id":"workspace.computer","entry_id":"computer","activation":"activation","parent_operation_id":null}"#,
            ),
            (
                Some(HostSdkParent::NestedEffect {
                    operation_id: "evaluation".into(),
                }),
                r#"{"kind":"host_sdk","package_id":"workspace.computer","entry_id":"computer","activation":"activation","parent_operation_id":"evaluation"}"#,
            ),
        ] {
            let origin = ToolOrigin::HostSdk {
                package_id: "workspace.computer".into(),
                entry_id: "computer".into(),
                activation: "activation".into(),
                parent,
            };
            assert_eq!(serde_json::to_string(&origin).unwrap(), expected);
            assert_eq!(
                serde_json::from_str::<ToolOrigin>(expected).unwrap(),
                origin
            );
        }
        assert!(serde_json::from_value::<ToolOrigin>(json!({
            "kind":"host_sdk", "package_id":"workspace.computer", "entry_id":"computer", "activation":"activation",
            "parent_operation_id":null, "parent_relationship":{"kind":"evaluation_observer", "epoch":"orphan"}
        })).is_err());
        assert!(
            serde_json::from_value::<HostSdkParent>(json!({
                "kind":"nested_effect", "operation_id":"evaluation", "epoch":"stale"
            }))
            .is_err()
        );
    }
}
