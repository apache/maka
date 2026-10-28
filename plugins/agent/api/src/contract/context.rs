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

pub use maka_agent_facts::context::{ContextBucket, ContextCounts, PreparedContextBreakdown};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentContextRead")]
pub struct ContextRead {
    pub session_id: String,
    /// Null captures the committed head; a supplied fence must not exceed it.
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<u64>",
        range(max = 9_007_199_254_740_991u64)
    )]
    pub through: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentContextReport")]
pub struct ContextReport {
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ContextRequest>")]
    /// Latest Main request made by this Session, excluding copied source requests.
    pub request: Option<ContextRequest>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentContextRequest")]
pub struct ContextRequest {
    pub invocation_id: String,
    pub step_id: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub sequence: u64,
    #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
    /// Original request timestamp in milliseconds since the Unix epoch.
    pub recorded_at: f64,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    /// Original input history fence, before this request was recorded.
    pub source_through: u64,
    pub model_id: String,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<u64>",
        range(min = 1, max = 9_007_199_254_740_991u64)
    )]
    pub context_window: Option<u64>,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<u64>",
        range(min = 1, max = 9_007_199_254_740_991u64)
    )]
    pub input_limit: Option<u64>,
    pub state: ContextRequestState,
    /// Original Host prepared-input measurements, not provider wire sizes or exact tokenization.
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<PreparedContextBreakdown>")]
    pub breakdown: Option<PreparedContextBreakdown>,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<u64>",
        range(max = 9_007_199_254_740_991u64)
    )]
    /// Provider-reported input tokens from this exact completed step, if available.
    pub reported_input_tokens: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentContextRequestState")]
pub enum ContextRequestState {
    Requested,
    Completed,
    Interrupted,
}

impl ContextReport {
    pub fn validate(&self) -> Result<(), &'static str> {
        const MAX: u64 = maka_agent_facts::interaction::MAX_SAFE_INTEGER;
        if self.through > MAX {
            return Err("agent_context_output_unavailable");
        }
        if let Some(request) = &self.request {
            if request.sequence == 0
                || request.sequence > self.through
                || request.source_through > MAX
                || !request.recorded_at.is_finite()
                || !(0.0..=MAX as f64).contains(&request.recorded_at)
                || [request.context_window, request.input_limit]
                    .into_iter()
                    .flatten()
                    .any(|value| value == 0 || value > MAX)
                || request
                    .reported_input_tokens
                    .is_some_and(|value| value > MAX)
            {
                return Err("agent_context_output_unavailable");
            }
            if let Some(breakdown) = &request.breakdown {
                breakdown
                    .validate()
                    .map_err(|_| "agent_context_output_unavailable")?;
            }
        }
        Ok(())
    }
}
