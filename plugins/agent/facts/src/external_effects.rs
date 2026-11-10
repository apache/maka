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
    Returned {
        key: ExternalEffectKey,
        output: ContentRef,
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalReturn {
    Output {
        is_error: bool,
        projection: crate::tool_output::DurableToolProjection,
        output: crate::tool_output::ToolOutput,
    },
    Failure {
        settlement: crate::tool_call::ToolSettlement,
        diagnostic: String,
    },
}
