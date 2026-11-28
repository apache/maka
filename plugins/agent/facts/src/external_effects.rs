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

//! Canonical evidence for real Host calls made by an external executor task.
use crate::{
    durable::{ApprovalId, ContentRef, ExecutionIdentity, ExternalTaskId, ResourceRecovery},
    tools::ToolDefinition,
};
use maka_plugin_core::operation::{OperationCleanup, OperationReply, RecoveryRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalEffectKey {
    pub task: ExternalTaskId,
    pub operation: Uuid,
}

/// Frozen before catalog preparation or human approval. These are the original
/// call bytes and resource observations, never a reconstructed model tool call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalEffectDescriptor {
    pub schema_version: u32,
    pub protocol: String,
    pub execution: ExecutionIdentity,
    pub key: ExternalEffectKey,
    pub origin: crate::tool_call::ToolOrigin,
    pub operation_id: String,
    pub name: String,
    pub input: Value,
    pub definition: ToolDefinition,
    pub catalog_digest: String,
    pub resources: Vec<ResourceRecovery>,
}

/// Tool definition representation on [StoredExternalEffectDescriptor].
///
/// Historical descriptors carried inline `definition`; new descriptors carry a
/// content-addressed `definitionRef`. Encoding this as an enum makes missing or
/// dual definitions unrepresentable after deserialization.
#[derive(Clone, Debug, PartialEq)]
pub enum StoredToolDefinition {
    Inline(Box<ToolDefinition>),
    Ref(ContentRef),
}

impl StoredToolDefinition {
    pub fn content_ref(&self) -> Option<&ContentRef> {
        match self {
            Self::Inline(_) => None,
            Self::Ref(reference) => Some(reference),
        }
    }
}

/// On-disk wire form of [ExternalEffectDescriptor]. New descriptors store
/// `definitionRef` pointing to a content-addressed [ToolDefinition] blob so
/// repeated external calls share one copy; historical rows carry inline
/// `definition`.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredExternalEffectDescriptor {
    pub schema_version: u32,
    pub protocol: String,
    pub execution: ExecutionIdentity,
    pub key: ExternalEffectKey,
    pub origin: crate::tool_call::ToolOrigin,
    pub operation_id: String,
    pub name: String,
    pub input: Value,
    pub definition: StoredToolDefinition,
    pub catalog_digest: String,
    pub resources: Vec<ResourceRecovery>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BorrowedStoredExternalEffectDescriptor<'a> {
    schema_version: u32,
    protocol: &'a str,
    execution: &'a ExecutionIdentity,
    key: ExternalEffectKey,
    origin: &'a crate::tool_call::ToolOrigin,
    operation_id: &'a str,
    name: &'a str,
    input: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    definition: Option<&'a ToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    definition_ref: Option<&'a ContentRef>,
    catalog_digest: &'a str,
    resources: &'a [ResourceRecovery],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireStoredExternalEffectDescriptor {
    schema_version: u32,
    protocol: String,
    execution: ExecutionIdentity,
    key: ExternalEffectKey,
    origin: crate::tool_call::ToolOrigin,
    operation_id: String,
    name: String,
    input: Value,
    #[serde(default)]
    definition: Option<ToolDefinition>,
    #[serde(default)]
    definition_ref: Option<ContentRef>,
    catalog_digest: String,
    resources: Vec<ResourceRecovery>,
}

impl Serialize for StoredExternalEffectDescriptor {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (definition, definition_ref) = match &self.definition {
            StoredToolDefinition::Inline(def) => (Some(def.as_ref()), None),
            StoredToolDefinition::Ref(reference) => (None, Some(reference)),
        };
        BorrowedStoredExternalEffectDescriptor {
            schema_version: self.schema_version,
            protocol: &self.protocol,
            execution: &self.execution,
            key: self.key,
            origin: &self.origin,
            operation_id: &self.operation_id,
            name: &self.name,
            input: &self.input,
            definition,
            definition_ref,
            catalog_digest: &self.catalog_digest,
            resources: &self.resources,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StoredExternalEffectDescriptor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = WireStoredExternalEffectDescriptor::deserialize(deserializer)?;
        let definition = match (wire.definition, wire.definition_ref) {
            (Some(def), None) => StoredToolDefinition::Inline(Box::new(def)),
            (None, Some(reference)) => StoredToolDefinition::Ref(reference),
            (Some(_), Some(_)) => {
                return Err(serde::de::Error::custom(
                    "external Host descriptor cannot carry both inline definition and definitionRef",
                ));
            }
            (None, None) => {
                return Err(serde::de::Error::custom(
                    "external Host descriptor is missing its tool definition",
                ));
            }
        };
        Ok(Self {
            schema_version: wire.schema_version,
            protocol: wire.protocol,
            execution: wire.execution,
            key: wire.key,
            origin: wire.origin,
            operation_id: wire.operation_id,
            name: wire.name,
            input: wire.input,
            definition,
            catalog_digest: wire.catalog_digest,
            resources: wire.resources,
        })
    }
}

impl StoredExternalEffectDescriptor {
    pub fn with_definition_ref(
        descriptor: &ExternalEffectDescriptor,
        definition_ref: ContentRef,
    ) -> Self {
        Self {
            schema_version: descriptor.schema_version,
            protocol: descriptor.protocol.clone(),
            execution: descriptor.execution.clone(),
            key: descriptor.key,
            origin: descriptor.origin.clone(),
            operation_id: descriptor.operation_id.clone(),
            name: descriptor.name.clone(),
            input: descriptor.input.clone(),
            definition: StoredToolDefinition::Ref(definition_ref),
            catalog_digest: descriptor.catalog_digest.clone(),
            resources: descriptor.resources.clone(),
        }
    }

    pub fn resolve<E>(
        self,
        load_definition: impl FnOnce(&ContentRef) -> Result<ToolDefinition, E>,
    ) -> Result<ExternalEffectDescriptor, E> {
        let definition = match self.definition {
            StoredToolDefinition::Inline(definition) => *definition,
            StoredToolDefinition::Ref(reference) => load_definition(&reference)?,
        };
        Ok(ExternalEffectDescriptor {
            schema_version: self.schema_version,
            protocol: self.protocol,
            execution: self.execution,
            key: self.key,
            origin: self.origin,
            operation_id: self.operation_id,
            name: self.name,
            input: self.input,
            definition,
            catalog_digest: self.catalog_digest,
            resources: self.resources,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalEffectEvent {
    Prepared {
        key: ExternalEffectKey,
        descriptor: ContentRef,
    },
    DisplayRecorded {
        key: ExternalEffectKey,
        display: crate::durable::ToolDisplay,
    },
    Rejected {
        key: ExternalEffectKey,
        rejection_kind: crate::tool_call::RejectionKind,
        diagnostic: String,
    },
    /// This event is also the exact once-approval consumption, when present.
    Admitted {
        key: ExternalEffectKey,
        approval: Option<ApprovalId>,
    },
    Bound {
        key: ExternalEffectKey,
        reference: RecoveryRef,
    },
    Observed {
        key: ExternalEffectKey,
        observation: OperationReply,
    },
    /// The MCP transport closed after admission, before a return was recorded.
    ReturnUnavailable {
        key: ExternalEffectKey,
        cell: crate::cells::CellId,
    },
    Returned {
        key: ExternalEffectKey,
        output: ContentRef,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        finish_turn: bool,
    },
    CleanupObserved {
        key: ExternalEffectKey,
        cleanup: OperationCleanup,
    },
}

impl ExternalEffectEvent {
    pub fn key(&self) -> ExternalEffectKey {
        match self {
            Self::Prepared { key, .. }
            | Self::DisplayRecorded { key, .. }
            | Self::Rejected { key, .. }
            | Self::Admitted { key, .. }
            | Self::ReturnUnavailable { key, .. }
            | Self::Bound { key, .. }
            | Self::Observed { key, .. }
            | Self::Returned { key, .. }
            | Self::CleanupObserved { key, .. } => *key,
        }
    }

    pub fn content_refs(&self) -> Vec<&ContentRef> {
        match self {
            Self::Prepared { descriptor, .. } => vec![descriptor],
            Self::Returned { output, .. } => vec![output],
            _ => vec![],
        }
    }

    pub fn is_admission(&self) -> bool {
        matches!(self, Self::Prepared { .. } | Self::Admitted { .. })
    }

    pub fn is_late(&self) -> bool {
        !self.is_admission()
    }
}

/// The full native return, not a model summary or a reconstruction of executor output.
#[derive(Clone, Debug, PartialEq)]
pub enum ExternalReturn {
    Output {
        is_error: bool,
        projection: crate::tool_output::DurableToolProjection,
        output: crate::tool_output::ToolOutput,
        artifacts: Vec<crate::artifact::PublishedArtifact>,
        display_budget_chars: Option<usize>,
    },
    Failure {
        settlement: crate::tool_call::ToolSettlement,
        diagnostic: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum BorrowedExternalReturn<'a> {
    Output {
        is_error: bool,
        projection:
            crate::tool_output::StoredProjection<&'a crate::tool_output::DurableToolProjection>,
        output: &'a crate::tool_output::ToolOutput,
        #[serde(skip_serializing_if = "slice_is_empty")]
        artifacts: &'a [crate::artifact::PublishedArtifact],
        #[serde(skip_serializing_if = "Option::is_none")]
        display_budget_chars: Option<usize>,
    },
    Failure {
        settlement: crate::tool_call::ToolSettlement,
        diagnostic: &'a str,
    },
}

fn slice_is_empty<T>(items: &&[T]) -> bool {
    items.is_empty()
}

/// Wire representation of `ExternalReturn` that can carry `{"kind":"from_output"}`
/// alongside a stripped `CellReplyState::Completed` (`observation: null`) without
/// requiring a database connection during deserialization.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StoredExternalReturn {
    Output {
        is_error: bool,
        projection: crate::tool_output::StoredProjection<crate::tool_output::DurableToolProjection>,
        output: crate::tool_output::ToolOutput,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        artifacts: Vec<crate::artifact::PublishedArtifact>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_budget_chars: Option<usize>,
    },
    Failure {
        settlement: crate::tool_call::ToolSettlement,
        diagnostic: String,
    },
}

impl StoredExternalReturn {
    /// Build a compact persisted wire return from an unstripped `ToolOutput`.
    /// Strips `CellReply.observation` to `null` on `Completed` cells only in the
    /// returned wire value, and encodes matching JSON/text/cell projections as
    /// `{"kind":"from_output"}`.
    pub fn from_output(
        output: &crate::tool_output::ToolOutput,
        is_error: bool,
        projection: &crate::tool_output::DurableToolProjection,
        artifacts: Vec<crate::artifact::PublishedArtifact>,
        display_budget_chars: Option<usize>,
    ) -> Self {
        let stored_projection = match crate::tool_output::store_projection(output, projection) {
            crate::tool_output::StoredProjection::Output(o) => {
                crate::tool_output::StoredProjection::Output(o)
            }
            crate::tool_output::StoredProjection::Inline(p) => {
                crate::tool_output::StoredProjection::Inline(p.clone())
            }
        };
        let mut wire_output = output.clone();
        if let crate::tool_output::ToolOutput::Cell(reply) = &mut wire_output
            && matches!(reply.state, crate::cells::CellReplyState::Completed { .. })
        {
            reply.observation = Value::Null;
        }
        Self::Output {
            is_error,
            projection: stored_projection,
            output: wire_output,
            artifacts,
            display_budget_chars,
        }
    }

    /// If this return stripped a `Completed` cell observation, returns its `ContentRef`.
    pub fn completed_cell_result(&self) -> Option<&ContentRef> {
        let Self::Output {
            output: crate::tool_output::ToolOutput::Cell(reply),
            ..
        } = self
        else {
            return None;
        };
        if !reply.observation.is_null() {
            return None;
        }
        match &reply.state {
            crate::cells::CellReplyState::Completed { result } => Some(result),
            _ => None,
        }
    }

    /// Hydrate a stored wire return back into a full `ExternalReturn`, restoring both
    /// `CellReply.observation` and any `FromOutput` projection when `cell_observation`
    /// bytes are provided for a stripped `Completed` cell.
    pub fn resolve(self, cell_observation: Option<&[u8]>) -> Result<ExternalReturn, String> {
        match self {
            Self::Failure {
                settlement,
                diagnostic,
            } => Ok(ExternalReturn::Failure {
                settlement,
                diagnostic,
            }),
            Self::Output {
                is_error,
                projection,
                mut output,
                artifacts,
                display_budget_chars,
            } => {
                if let crate::tool_output::ToolOutput::Cell(reply) = &mut output
                    && reply.observation.is_null()
                    && matches!(reply.state, crate::cells::CellReplyState::Completed { .. })
                    && let Some(bytes) = cell_observation
                {
                    reply.observation = serde_json::from_slice(bytes)
                        .map_err(|e| format!("invalid completed cell observation: {e}"))?;
                }
                let projection = crate::tool_output::resolve_projection::<serde::de::value::Error>(
                    &output, projection,
                )
                .map_err(|e| e.to_string())?;
                Ok(ExternalReturn::Output {
                    is_error,
                    projection,
                    output,
                    artifacts,
                    display_budget_chars,
                })
            }
        }
    }
}

impl Serialize for ExternalReturn {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Output {
                is_error,
                projection,
                output,
                artifacts,
                display_budget_chars,
            } => BorrowedExternalReturn::Output {
                is_error: *is_error,
                projection: crate::tool_output::store_projection(output, projection),
                output,
                artifacts: artifacts.as_slice(),
                display_budget_chars: *display_budget_chars,
            }
            .serialize(serializer),
            Self::Failure {
                settlement,
                diagnostic,
            } => BorrowedExternalReturn::Failure {
                settlement: *settlement,
                diagnostic: diagnostic.as_str(),
            }
            .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ExternalReturn {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match StoredExternalReturn::deserialize(deserializer)? {
            StoredExternalReturn::Output {
                is_error,
                projection,
                output,
                artifacts,
                display_budget_chars,
            } => Ok(Self::Output {
                is_error,
                projection: crate::tool_output::resolve_projection(&output, projection)?,
                output,
                artifacts,
                display_budget_chars,
            }),
            StoredExternalReturn::Failure {
                settlement,
                diagnostic,
            } => Ok(Self::Failure {
                settlement,
                diagnostic,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable::{RunId, SCHEMA_VERSION},
        tool_call::ToolOrigin,
        tool_output::{DurableToolProjection, ToolOutput},
    };
    use serde_json::json;

    fn sample_descriptor() -> ExternalEffectDescriptor {
        let task = ExternalTaskId::new();
        let operation = Uuid::new_v4();
        ExternalEffectDescriptor {
            schema_version: SCHEMA_VERSION,
            protocol: "maka.external-host-effect.v1".into(),
            execution: ExecutionIdentity {
                session_id: "s-test".into(),
                run_id: RunId::new(),
                turn_id: "turn-1".into(),
            },
            key: ExternalEffectKey { task, operation },
            origin: ToolOrigin::External {
                task,
                operation,
                package_id: "pkg".into(),
                entry_id: "entry".into(),
                activation: "act".into(),
            },
            operation_id: format!("external:{task}:{operation}"),
            name: "exec".into(),
            input: json!({"code": "text(1)"}),
            definition: ToolDefinition {
                name: "exec".into(),
                description: "Execute JS".into(),
                input_schema: json!({"type": "object"}),
                provider: None,
                freeform: None,
                output_schema: None,
            },
            catalog_digest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(),
            resources: vec![],
        }
    }

    #[test]
    fn stored_descriptor_packs_definition_ref_and_reads_legacy_inline() {
        let descriptor = sample_descriptor();
        let def_ref = ContentRef {
            digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                .into(),
            bytes: 128,
        };
        let stored =
            StoredExternalEffectDescriptor::with_definition_ref(&descriptor, def_ref.clone());
        let wire = serde_json::to_value(&stored).unwrap();
        assert!(wire.get("definition").is_none());
        assert_eq!(wire["definitionRef"]["digest"], def_ref.digest);

        let decoded: StoredExternalEffectDescriptor = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            decoded.definition,
            StoredToolDefinition::Ref(def_ref.clone())
        );
        let resolved = decoded
            .resolve(|r| {
                assert_eq!(r, &def_ref);
                Ok::<_, &'static str>(descriptor.definition.clone())
            })
            .unwrap();
        assert_eq!(resolved, descriptor);

        // Legacy inline descriptor still decodes cleanly.
        let legacy_wire = serde_json::to_value(&descriptor).unwrap();
        let legacy: StoredExternalEffectDescriptor = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(
            legacy.definition,
            StoredToolDefinition::Inline(Box::new(descriptor.definition.clone()))
        );
        let legacy_resolved = legacy
            .resolve(|_| Err("should not load ref for legacy inline"))
            .unwrap();
        assert_eq!(legacy_resolved, descriptor);

        // Invalid wire states (both set or neither set) are rejected at deserialization.
        let mut both = wire.clone();
        both["definition"] = serde_json::to_value(&descriptor.definition).unwrap();
        assert!(serde_json::from_value::<StoredExternalEffectDescriptor>(both).is_err());

        let mut neither = wire;
        neither.as_object_mut().unwrap().remove("definitionRef");
        assert!(serde_json::from_value::<StoredExternalEffectDescriptor>(neither).is_err());
    }

    #[test]
    fn external_return_shares_matching_json_projection_and_reads_legacy_inline() {
        let value = json!({"ok": true, "rows": [1, 2]});
        let returned = ExternalReturn::Output {
            is_error: false,
            projection: DurableToolProjection::Json {
                value: value.clone(),
            },
            output: ToolOutput::Json(value.clone()),
            artifacts: vec![],
            display_budget_chars: Some(4096),
        };
        let wire = serde_json::to_value(&returned).unwrap();
        assert_eq!(wire["projection"], json!({"kind": "from_output"}));
        assert!(wire.get("artifacts").is_none());

        let roundtrip: ExternalReturn = serde_json::from_value(wire).unwrap();
        assert_eq!(roundtrip, returned);

        let legacy = json!({
            "kind": "output",
            "is_error": false,
            "projection": { "kind": "json", "value": value },
            "output": { "format": "json", "value": value },
            "display_budget_chars": 4096
        });
        let from_legacy: ExternalReturn = serde_json::from_value(legacy).unwrap();
        assert_eq!(from_legacy, returned);
    }
}
