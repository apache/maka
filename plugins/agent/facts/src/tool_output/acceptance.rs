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
use super::{DurableToolProjection, ToolOutput};
use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Native has already committed any referenced projection artifacts before publishing this value.
#[derive(Clone, Debug, PartialEq)]
pub struct ReturnedToolResult {
    pub output: ToolOutput,
    pub projection: DurableToolProjection,
    pub is_error: bool,
    pub loaded_tools: BTreeSet<String>,
    pub display_budget_chars: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StoredProjection<P> {
    Output(OutputProjection),
    Inline(P),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutputProjection {
    FromOutput,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredReturn<O, P, T> {
    output: O,
    projection: StoredProjection<P>,
    is_error: bool,
    loaded_tools: T,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_budget_chars: Option<usize>,
}

fn output_json(output: &ToolOutput) -> Option<&serde_json::Value> {
    match output {
        ToolOutput::Json(value) => Some(value),
        ToolOutput::Operation(reply) => match &reply.receipt {
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value },
                    },
                ..
            } => Some(value),
            _ => None,
        },
        _ => None,
    }
}

/// Deterministic text projection for a text-only `CellObservation::Completed`,
/// matching `CodeCells::project_observation`. Returns `None` for non-completed
/// observations or observations containing image/media outputs.
pub fn completed_cell_text_projection(
    observation: &crate::cells::CellObservation,
) -> Option<String> {
    let crate::cells::CellObservation::Completed {
        cell_id,
        content,
        result,
    } = observation
    else {
        return None;
    };
    #[derive(Serialize)]
    struct CompletedSummary<'a> {
        state: &'static str,
        cell_id: crate::cells::CellId,
        result: &'a serde_json::Value,
    }
    let mut out = serde_json::to_string(&CompletedSummary {
        state: "completed",
        cell_id: *cell_id,
        result,
    })
    .ok()?;
    for item in content {
        let crate::cells::CellOutput::Text { text } = item else {
            return None;
        };
        out.push('\n');
        out.push_str(text);
    }
    Some(out)
}

fn inline_cell_text(output: &ToolOutput) -> Option<String> {
    let ToolOutput::Cell(reply) = output else {
        return None;
    };
    if reply.observation.is_null() {
        return None;
    }
    let obs: crate::cells::CellObservation =
        serde_json::from_value(reply.observation.clone()).ok()?;
    completed_cell_text_projection(&obs)
}

pub(crate) fn store_projection<'a>(
    output: &ToolOutput,
    projection: &'a DurableToolProjection,
) -> StoredProjection<&'a DurableToolProjection> {
    match projection {
        DurableToolProjection::Json { value } if output_json(output) == Some(value) => {
            StoredProjection::Output(OutputProjection::FromOutput)
        }
        DurableToolProjection::Text { text }
            if matches!(output, ToolOutput::Text(s) if s == text)
                || inline_cell_text(output).as_deref() == Some(text.as_str()) =>
        {
            StoredProjection::Output(OutputProjection::FromOutput)
        }
        projection => StoredProjection::Inline(projection),
    }
}

pub(crate) fn resolve_projection<E: serde::de::Error>(
    output: &ToolOutput,
    projection: StoredProjection<DurableToolProjection>,
) -> Result<DurableToolProjection, E> {
    match projection {
        StoredProjection::Output(_) => {
            if let ToolOutput::Text(text) = output {
                return Ok(DurableToolProjection::Text { text: text.clone() });
            }
            if let Some(text) = inline_cell_text(output) {
                return Ok(DurableToolProjection::Text { text });
            }
            Ok(DurableToolProjection::Json {
                value: output_json(output).cloned().ok_or_else(|| {
                    E::custom(
                        "shared projection requires a returned JSON, text, or hydrated cell value",
                    )
                })?,
            })
        }
        StoredProjection::Inline(projection) => Ok(projection),
    }
}

impl Serialize for ReturnedToolResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let projection = store_projection(&self.output, &self.projection);
        StoredReturn {
            output: &self.output,
            projection,
            is_error: self.is_error,
            loaded_tools: &self.loaded_tools,
            display_budget_chars: self.display_budget_chars,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ReturnedToolResult {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let StoredReturn {
            output,
            projection,
            is_error,
            loaded_tools,
            display_budget_chars,
        } = StoredReturn::<ToolOutput, DurableToolProjection, BTreeSet<String>>::deserialize(
            deserializer,
        )?;
        let projection = resolve_projection(&output, projection)?;
        Ok(Self {
            output,
            projection,
            is_error,
            loaded_tools,
            display_budget_chars,
        })
    }
}

/// Wire form for a `CellReplyState::Completed` local tool return whose inline
/// `observation` was stripped to `null` and whose text projection equals
/// `completed_cell_text_projection` of the referenced `CellObservation`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredCellCompletedReturn {
    pub output: ToolOutput,
    pub projection: OutputProjection,
    pub is_error: bool,
    pub loaded_tools: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_budget_chars: Option<usize>,
}

impl StoredCellCompletedReturn {
    pub fn result_ref(&self) -> Option<&crate::durable::ContentRef> {
        let ToolOutput::Cell(reply) = &self.output else {
            return None;
        };
        match &reply.state {
            crate::cells::CellReplyState::Completed { result } => Some(result),
            _ => None,
        }
    }

    pub fn resolve(
        self,
        observation: &crate::cells::CellObservation,
    ) -> Result<ReturnedToolResult, &'static str> {
        let text = completed_cell_text_projection(observation)
            .ok_or("shared cell projection requires a text-only completed cell observation")?;
        Ok(ReturnedToolResult {
            output: self.output,
            projection: DurableToolProjection::Text { text },
            is_error: self.is_error,
            loaded_tools: self.loaded_tools,
            display_budget_chars: self.display_budget_chars,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum StoredToolResult {
    Operation(Box<StoredOperationReturn>),
    Inline(Box<ReturnedToolResult>),
    CellCompleted(Box<StoredCellCompletedReturn>),
}

impl StoredToolResult {
    /// Build a `StoredToolResult` for a local tool return, sharing `projection` via
    /// `{"kind":"from_output"}` when a completed cell's pre-strip observation projects
    /// deterministically to `projection`.
    pub fn from_local(
        output: ToolOutput,
        pre_strip_cell_observation: Option<&serde_json::Value>,
        projection: DurableToolProjection,
        is_error: bool,
        loaded_tools: BTreeSet<String>,
        display_budget_chars: Option<usize>,
    ) -> Self {
        if let ToolOutput::Cell(ref reply) = output
            && reply.observation.is_null()
            && matches!(reply.state, crate::cells::CellReplyState::Completed { .. })
            && let DurableToolProjection::Text { ref text } = projection
            && let Some(obs_val) = pre_strip_cell_observation
            && let Ok(obs) =
                serde_json::from_value::<crate::cells::CellObservation>(obs_val.clone())
            && completed_cell_text_projection(&obs).as_deref() == Some(text.as_str())
        {
            return Self::CellCompleted(Box::new(StoredCellCompletedReturn {
                output,
                projection: OutputProjection::FromOutput,
                is_error,
                loaded_tools,
                display_budget_chars,
            }));
        }
        Self::Inline(Box::new(ReturnedToolResult {
            output,
            projection,
            is_error,
            loaded_tools,
            display_budget_chars,
        }))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredOperationReturn {
    pub operation: crate::operation::RecordedOperationReply,
    pub projection: OperationProjection,
    pub is_error: bool,
    pub loaded_tools: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationProjection {
    Result,
    Receipt,
    Inline { projection: DurableToolProjection },
}

impl OperationProjection {
    pub fn record(
        reply: &maka_plugin_core::operation::OperationReply,
        projection: DurableToolProjection,
    ) -> Result<Self, serde_json::Error> {
        if let DurableToolProjection::Json { value } = &projection {
            if let Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value: returned },
                    },
                ..
            } = &reply.receipt
                && value == returned
            {
                return Ok(Self::Result);
            }
            if value.get("reference").is_some()
                && value.get("receipt").is_some()
                && value == &serde_json::to_value(reply)?
            {
                return Ok(Self::Receipt);
            }
        }
        Ok(Self::Inline { projection })
    }
    pub fn resolve(
        self,
        reply: &maka_plugin_core::operation::OperationReply,
    ) -> Result<DurableToolProjection, &'static str> {
        Ok(match self {
            OperationProjection::Result => {
                let Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    ..
                } = &reply.receipt
                else {
                    return Err("shared projection has no original success value");
                };
                DurableToolProjection::Json {
                    value: value.clone(),
                }
            }
            OperationProjection::Receipt => DurableToolProjection::Json {
                value: serde_json::to_value(reply)
                    .map_err(|_| "original operation receipt is not JSON")?,
            },
            OperationProjection::Inline { projection } => projection,
        })
    }
}

impl StoredOperationReturn {
    pub fn resolve(
        self,
        reply: maka_plugin_core::operation::OperationReply,
    ) -> Result<ReturnedToolResult, &'static str> {
        let projection = self.projection.resolve(&reply)?;
        Ok(ReturnedToolResult {
            output: ToolOutput::Operation(Box::new(reply)),
            projection,
            is_error: self.is_error,
            loaded_tools: self.loaded_tools,
            display_budget_chars: None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellFinalEvidence {
    Completed { result: crate::durable::ContentRef },
    Interrupted { report: crate::durable::ContentRef },
}

/// Extract the diagnostic from a Host operation reply whose physical execution
/// ended (cleanup confirmed) even though its external outcome remained unknown.
pub fn ended_unknown_diagnostic(
    reply: &maka_plugin_core::operation::OperationReply,
) -> Option<&str> {
    match &reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Unknown { diagnostic },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        } => Some(diagnostic.as_str()),
        _ => None,
    }
}

/// Format an ended tool call whose external outcome could not be confirmed.
pub fn ended_unknown_message(diagnostic: &str) -> String {
    format!(
        "The call ended, but its result is unknown: {}. It may or may not have taken effect. Check the current state before deciding what to do next; do not simply repeat the call.",
        diagnostic.trim_end_matches('.')
    )
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AcceptedToolResult {
    ProviderOutcomeUnknown,
    OutcomeUnknown {
        diagnostic: String,
    },
    RecoveredCell {
        cell: crate::cells::CellId,
        evidence: CellFinalEvidence,
    },
    Local {
        result: crate::durable::ContentRef,
    },
    Host {
        result: crate::durable::ContentRef,
    },
    ObservedOperation {
        reply: crate::operation::RecordedOperationReply,
    },
    Operation {
        reply: maka_plugin_core::operation::OperationReply,
        result: Option<crate::durable::ContentRef>,
    },
    Provider {
        output: serde_json::Value,
        is_error: bool,
        provider_options: Option<serde_json::Value>,
    },
    Rejected {
        diagnostic: String,
    },
    RiskAdjudicated {
        blocker: crate::durable::BlockerId,
        decision: crate::durable::RiskDecision,
    },
}
