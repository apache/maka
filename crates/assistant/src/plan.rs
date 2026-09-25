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

//! Plan intent and model-reported progress. Neither is Host execution authority.
mod artifact;
mod owner;
pub mod plugin;
pub mod repository;
mod transition;
pub use artifact::{Artifact, Complexity, Step};

use maka_plugins::execution::{Receipt, Submit};
use maka_runtime::{event::Invocation, execution::BehaviorId};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid Plan input: {0}")]
    Invalid(String),
    #[error("Plan changed or operation identity was reused")]
    Conflict,
    #[error("Plan storage is invalid: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Storage(#[from] maka_plugins::storage::StoreError),
    #[error(transparent)]
    Execution(#[from] maka_plugins::execution::CommandError),
    #[error(transparent)]
    Capability(#[from] maka_plugins::Error),
    #[error(transparent)]
    Tool(#[from] maka_runtime::tools::ToolError),
}

/// An exact operation is replayable even after subsequent state changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub expected_revision: u64,
    pub command: Command,
}

/// The caller must obtain the appropriate public Remote or invocation capability
/// before invoking these domain operations. Deserializing a command grants none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Propose {
        turn_id: String,
        artifact: Artifact,
    },
    Revise {
        proposal_id: String,
    },
    Abandon {
        proposal_id: String,
    },
    Approve {
        proposal_id: String,
        proposal_revision: u64,
        behavior: BehaviorId,
        grant: maka_plugins::authorization::Id,
    },
    Dispatch {
        execution_id: String,
    },
    Defer {
        execution_id: String,
    },
    Reconcile {
        execution_id: String,
        grant: maka_plugins::authorization::Id,
    },
    Accept {
        execution_id: String,
        receipt: Receipt,
    },
    /// Only a definitive Host rejection; an ambiguous reply leaves admission pending.
    Reject {
        execution_id: String,
        request_digest: String,
        reason: String,
    },
    Progress {
        execution_id: String,
        invocation: Invocation,
        steps: Vec<Progress>,
    },
    Interrupt {
        execution_id: String,
        invocation: Invocation,
        reason: String,
    },
    Resume {
        execution_id: String,
        grant: maka_plugins::authorization::Id,
    },
    Cancel {
        execution_id: String,
        reason: String,
        grant: Option<maka_plugins::authorization::Id>,
    },
    Settle {
        execution_id: String,
        invocation: Invocation,
        outcome: Settlement,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Settlement {
    Completed,
    Interrupted { reason: String },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub proposal: Option<Proposal>,
    pub execution: Option<Execution>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub id: String,
    pub plan_id: String,
    pub revision: u64,
    pub turn_id: String,
    pub artifact: Artifact,
    pub status: ProposalStatus,
    pub supersedes: Option<String>,
    pub source_execution_id: Option<String>,
    pub submitted_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    PendingApproval,
    RevisionRequested,
    Abandoned,
    Approved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Execution {
    pub id: String,
    pub proposal_id: String,
    pub artifact: Artifact,
    pub steps: Vec<Progress>,
    /// Frozen before calling Host. Recover the exact operation, never a new attempt.
    pub request: Submit,
    pub grant: maka_plugins::authorization::Id,
    pub dispatched: bool,
    pub cancellation: Option<String>,
    pub phase: Phase,
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Phase {
    AwaitingAdmission,
    Active {
        receipt: Receipt,
    },
    Interrupted {
        receipt: Option<Receipt>,
        reason: String,
    },
    Completed {
        receipt: Receipt,
    },
    Cancelled {
        receipt: Option<Receipt>,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Progress {
    pub id: String,
    pub status: StepStatus,
    pub note: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    Skipped,
}

fn invalid(message: impl ToString) -> Error {
    Error::Invalid(message.to_string())
}

fn identifier(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid(
            "identity must contain 1–128 ASCII letters, digits, '_' or '-'",
        ));
    }
    Ok(())
}

fn text(value: &str, limit: usize) -> Result<(), Error> {
    if value.trim().is_empty() || value.len() > limit || value.contains('\0') {
        return Err(invalid("text is empty, too large, or contains NUL"));
    }
    Ok(())
}
