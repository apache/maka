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

//! Physical accounting; independent of conversation membership and current prices.

use crate::{
    context::ModelPurpose, durable::ExecutionIdentity, execution::ModelBinding, model::ModelUsage,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
mod activity;
mod summary;
mod tool;
pub use activity::{Activity, ActivityKind, ActivityStatus, Selection};
pub use summary::{
    Cost, Group, ModelSummary, ModelTotals, Pending, ProviderSummary, Summary, Tokens, ToolSummary,
    ToolTotals,
};
pub use tool::{ToolStatus, ToolUsage, ToolUsageResult, ToolUsageSource};

/// The selected model and contemporaneous public rate decision, sealed with the
/// immutable request. Missing usage or pricing is never equivalent to zero.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelEvidence {
    pub binding: ModelBinding,
    pub model_id: String,
    pub purpose: ModelPurpose,
    pub quote: Option<crate::pricing::Quote>,
}
impl ModelEvidence {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.model_id.is_empty()
            || self.model_id.chars().any(char::is_control)
            || self.binding.connection_id.is_empty()
            || self.binding.model.is_empty()
        {
            return Err("invalid original model accounting identity");
        }
        if let Some(quote) = &self.quote {
            quote.validate(&self.model_id)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "UsageOutcome")]
pub enum Outcome {
    Success,
    Error,
    Aborted,
    /// The admission ended without a recorded provider outcome.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "UsageAuxiliarySource")]
pub enum AuxiliarySource {
    /// One auxiliary request owned by an admitted native application mutation.
    ApplicationOperation {
        source: maka_plugin_core::deployment::DeploymentRef,
        namespace: maka_plugin_core::composition::InstanceId,
        operation: Uuid,
        fingerprint: String,
    },
    /// One Host-owned title request, authorized by the first committed user opening.
    /// It may finish after that execution ends and cannot execute tools.
    SessionTitle {
        execution: ExecutionIdentity,
    },
    Agent {
        execution: ExecutionIdentity,
        operation_id: String,
    },
    HostEffect {
        id: Uuid,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "UsageOrigin")]
pub enum Origin {
    Agent {
        execution: ExecutionIdentity,
        link: crate::durable::AgentStepLink,
        purpose: ModelPurpose,
    },
    Auxiliary {
        source: AuxiliarySource,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "UsageModelAttempt")]
pub struct ModelAttempt {
    pub request_id: String,
    pub origin: Origin,
    pub session_id: Option<String>,
    pub binding: Option<ModelBinding>,
    pub model_id: String,
    pub started_at: f64,
    pub completed_at: f64,
    pub outcome: Outcome,
    pub usage: ModelUsage,
    pub quote: Option<crate::pricing::Quote>,
    pub cost_usd: Option<f64>,
}

impl ModelAttempt {
    /// Wall-clock adjustments cannot produce negative reported latency.
    pub fn latency_ms(&self) -> f64 {
        (self.completed_at - self.started_at).max(0.0)
    }
}
