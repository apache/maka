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

//! Session history ownership is independent of execution identity.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyState {
    Preparing,
    Committed,
    Abandoned,
}
impl CopyState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Committed => "committed",
            Self::Abandoned => "abandoned",
        }
    }
}
impl std::str::FromStr for CopyState {
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "preparing" => Ok(Self::Preparing),
            "committed" => Ok(Self::Committed),
            "abandoned" => Ok(Self::Abandoned),
            _ => Err("invalid Session copy state"),
        }
    }
}

/// A complete logical Turn boundary within the source session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentForkPosition")]
pub enum ForkPosition {
    /// Capture an empty history prefix.
    Start,
    /// Capture all current history, including later compaction facts.
    End,
    /// Include the complete target Turn.
    ThroughTurn {
        #[schemars(length(min = 1))]
        turn_id: String,
    },
    /// Exclude the complete target Turn, including its submitted inputs.
    BeforeTurn {
        #[schemars(length(min = 1))]
        turn_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CopyPurpose {
    Branch {
        position: ForkPosition,
        side_conversation: bool,
    },
    EmptySideConversation,
    Revision {
        turn_id: String,
    },
}

/// The complete stable operation identity, not just its resolved history cut.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyRequest {
    pub source_session_id: String,
    pub target_session_id: String,
    pub expected_source_revision: u64,
    pub purpose: CopyPurpose,
}

/// Durable copy identity and lifecycle, including a target that was abandoned.
/// Reading this receipt neither adopts the target nor grants execution authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyReceipt {
    pub request: CopyRequest,
    pub state: CopyState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BranchOrigin {
    pub parent_session_id: String,
    pub position: ForkPosition,
}

/// Flattened provenance remains readable after the source catalog is removed.
/// No parent lookup grants execution, workspace or plugin management authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Lineage {
    Branch {
        origin: BranchOrigin,
    },
    Revision {
        root_session_id: String,
        parent_session_id: String,
        turn_id: String,
        index: u64,
        branch: Option<BranchOrigin>,
    },
}

impl Lineage {
    pub fn branch(&self) -> Option<&BranchOrigin> {
        match self {
            Self::Branch { origin } => Some(origin),
            Self::Revision { branch, .. } => branch.as_ref(),
        }
    }
}
