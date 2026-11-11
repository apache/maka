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
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum StoredProjection<P> {
    Output(OutputProjection),
    Inline(P),
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OutputProjection {
    FromOutput,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredReturn<O, P, T> {
    output: O,
    projection: StoredProjection<P>,
    is_error: bool,
    loaded_tools: T,
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

impl Serialize for ReturnedToolResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let projection = match &self.projection {
            DurableToolProjection::Json { value } if output_json(&self.output) == Some(value) => {
                StoredProjection::Output(OutputProjection::FromOutput)
            }
            projection => StoredProjection::Inline(projection),
        };
        StoredReturn {
            output: &self.output,
            projection,
            is_error: self.is_error,
            loaded_tools: &self.loaded_tools,
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
        } = StoredReturn::<ToolOutput, DurableToolProjection, BTreeSet<String>>::deserialize(
            deserializer,
        )?;
        let projection = match projection {
            StoredProjection::Output(_) => DurableToolProjection::Json {
                value: output_json(&output).cloned().ok_or_else(|| {
                    serde::de::Error::custom("shared projection requires a returned JSON value")
                })?,
            },
            StoredProjection::Inline(projection) => projection,
        };
        Ok(Self {
            output,
            projection,
            is_error,
            loaded_tools,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum StoredToolResult {
    Operation(Box<StoredOperationReturn>),
    Inline(ReturnedToolResult),
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
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellFinalEvidence {
    Completed { result: crate::durable::ContentRef },
    Interrupted { report: crate::durable::ContentRef },
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AcceptedToolResult {
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
