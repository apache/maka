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
pub fn tool_use_id(run_id: crate::durable::RunId, operation_id: &str) -> String {
    let bytes = serde_json::to_vec(&("maka.tool-presentation.v2", run_id, operation_id)).unwrap();
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
    Superseded,
    Unavailable,
    InvalidInput,
    PolicyDenied,
    PreparationFailed,
    ExclusiveConflict,
    Cancelled,
}

/// An explicit refusal before effect admission, not an inference from a missing T1.
#[derive(
    Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error, schemars::JsonSchema,
)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolRejection {
    #[error("not executed: superseded by new user input")]
    Superseded,
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

impl ToolRejection {
    pub fn kind(&self) -> RejectionKind {
        match self {
            Self::Superseded => RejectionKind::Superseded,
            Self::Unavailable => RejectionKind::Unavailable,
            Self::InvalidInput { .. } => RejectionKind::InvalidInput,
            Self::PolicyDenied { .. } => RejectionKind::PolicyDenied,
            Self::PreparationFailed { .. } => RejectionKind::PreparationFailed,
            Self::ExclusiveConflict => RejectionKind::ExclusiveConflict,
            Self::Cancelled => RejectionKind::Cancelled,
        }
    }
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
        link: crate::durable::AgentStepLink,
    },
    CodeMode {
        cell: crate::cells::CellId,
        owner: crate::cells::CellOwner,
        parent_operation_id: String,
        parent_tool_call_id: String,
    },
    /// An independently running cell accepted by an exec control call.
    /// Its parent may settle once startup/observation completes; its own nested
    /// tool effects must still drain before the cell's canonical settlement.
    CodeCell {
        cell: crate::cells::CellId,
        owner: crate::cells::CellOwner,
        parent_operation_id: String,
        parent_tool_call_id: String,
    },
    Standalone,
    /// An actual Host SDK child of the original external task, not provider output.
    External {
        task: crate::durable::ExternalTaskId,
        operation: uuid::Uuid,
        package_id: String,
        entry_id: String,
        activation: String,
    },
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
        link: crate::durable::AgentStepLink,
    },
    CodeMode {
        cell: crate::cells::CellId,
        owner: crate::cells::CellOwner,
        parent_operation_id: Cow<'a, str>,
        parent_tool_call_id: Cow<'a, str>,
    },
    CodeCell {
        cell: crate::cells::CellId,
        owner: crate::cells::CellOwner,
        parent_operation_id: Cow<'a, str>,
        parent_tool_call_id: Cow<'a, str>,
    },
    Standalone,
    External {
        task: crate::durable::ExternalTaskId,
        operation: uuid::Uuid,
        package_id: Cow<'a, str>,
        entry_id: Cow<'a, str>,
        activation: Cow<'a, str>,
    },
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
            Self::Provider { link } => WireToolOrigin::Provider { link: *link },
            Self::CodeMode {
                cell,
                owner,
                parent_operation_id,
                parent_tool_call_id,
            } => WireToolOrigin::CodeMode {
                cell: *cell,
                owner: owner.clone(),
                parent_operation_id: Cow::Borrowed(parent_operation_id),
                parent_tool_call_id: Cow::Borrowed(parent_tool_call_id),
            },
            Self::CodeCell {
                cell,
                owner,
                parent_operation_id,
                parent_tool_call_id,
            } => WireToolOrigin::CodeCell {
                cell: *cell,
                owner: owner.clone(),
                parent_operation_id: Cow::Borrowed(parent_operation_id),
                parent_tool_call_id: Cow::Borrowed(parent_tool_call_id),
            },
            Self::Standalone => WireToolOrigin::Standalone,
            Self::External {
                task,
                operation,
                package_id,
                entry_id,
                activation,
            } => WireToolOrigin::External {
                task: *task,
                operation: *operation,
                package_id: Cow::Borrowed(package_id),
                entry_id: Cow::Borrowed(entry_id),
                activation: Cow::Borrowed(activation),
            },
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
            WireToolOrigin::Provider { link } => Self::Provider { link },
            WireToolOrigin::CodeMode {
                cell,
                owner,
                parent_operation_id,
                parent_tool_call_id,
            } => Self::CodeMode {
                cell,
                owner,
                parent_operation_id: parent_operation_id.into_owned(),
                parent_tool_call_id: parent_tool_call_id.into_owned(),
            },
            WireToolOrigin::CodeCell {
                cell,
                owner,
                parent_operation_id,
                parent_tool_call_id,
            } => Self::CodeCell {
                cell,
                owner,
                parent_operation_id: parent_operation_id.into_owned(),
                parent_tool_call_id: parent_tool_call_id.into_owned(),
            },
            WireToolOrigin::Standalone => Self::Standalone,
            WireToolOrigin::External {
                task,
                operation,
                package_id,
                entry_id,
                activation,
            } => Self::External {
                task,
                operation,
                package_id: package_id.into_owned(),
                entry_id: entry_id.into_owned(),
                activation: activation.into_owned(),
            },
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
    pub fn provider_key(&self) -> Option<crate::durable::ToolKey> {
        match &self.origin {
            ToolOrigin::Provider { link } => Some(crate::durable::ToolKey {
                attempt: link.attempt,
                call: self.tool_call_id.clone(),
            }),
            _ => None,
        }
    }

    pub fn provider(link: crate::durable::AgentStepLink, tool_call_id: String) -> Self {
        Self {
            tool_call_id,
            origin: ToolOrigin::Provider { link },
        }
    }

    pub fn standalone(tool_call_id: String) -> Self {
        Self {
            tool_call_id,
            origin: ToolOrigin::Standalone,
        }
    }
}
