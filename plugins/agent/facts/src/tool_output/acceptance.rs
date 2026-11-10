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
/// Native has already committed any referenced projection artifacts before publishing this value.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReturnedToolResult {
    pub output: crate::tool_output::ToolOutput,
    pub projection: crate::tool_output::DurableToolProjection,
    pub is_error: bool,
    pub loaded_tools: std::collections::BTreeSet<String>,
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
