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

/// Breakdown selected for a bounded summary page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "UsageGroup")]
pub enum Group {
    ByProvider,
    ByModel,
    ByTool,
}

/// Sum of reported counters, qualified by calls that omitted this counter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageTokens")]
pub struct Tokens {
    pub known: u64,
    pub missing: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageCost")]
pub struct Cost {
    pub known_usd: f64,
    /// Calls without a persisted valuation; includes unpriced calls.
    pub unvalued: u64,
    pub unpriced: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageModelTotals")]
pub struct ModelTotals {
    pub calls: u64,
    pub success: u64,
    pub error: u64,
    pub aborted: u64,
    pub unknown: u64,
    /// Sum of observed durations; unknown outcomes are excluded. Not wall-clock time.
    pub duration_ms: f64,
    pub input: Tokens,
    pub output: Tokens,
    pub cache_read: Tokens,
    pub cache_write: Tokens,
    pub reasoning: Tokens,
    pub cost: Cost,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageToolTotals")]
pub struct ToolTotals {
    /// Includes pre-dispatch refusals, which are counted separately below.
    pub calls: u64,
    pub success: u64,
    pub error: u64,
    pub unknown: u64,
    pub rejected: u64,
    /// Known success/error durations; refusals and unknown effects contribute no time.
    pub duration_ms: f64,
    /// Only known success/error settlements contribute to observed execution latency.
    pub mean_latency_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageSummary")]
pub struct Summary {
    pub models: ModelTotals,
    pub tools: ToolTotals,
    pub by_provider: Vec<ProviderSummary>,
    pub by_model: Vec<ModelSummary>,
    pub by_tool: Vec<ToolSummary>,
    /// Unsettled admissions within the time range at this fence, not completed calls.
    pub pending: Pending,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsagePending")]
pub struct Pending {
    pub models: u64,
    pub tools: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageProviderSummary")]
pub struct ProviderSummary {
    /// Unknown identity is not inferred from a transport protocol or current settings.
    pub provider_id: Option<String>,
    pub totals: ModelTotals,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageModelSummary")]
pub struct ModelSummary {
    pub model_id: String,
    pub totals: ModelTotals,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageToolSummary")]
pub struct ToolSummary {
    pub name: String,
    pub totals: ToolTotals,
}
