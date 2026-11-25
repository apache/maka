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

use crate::{failed, mutation::Mutation, scoped::Authority, write::WriteCoordinator};
use apply_patch::{PatchOperation, parse_patch};
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_util::sync::CancellationToken;

pub const PATCH_NAME: &str = "apply_patch";
pub const PATCH_DESCRIPTION: &str = "Apply a patch to create, update, or delete one or more files within the Session's write roots. Pass `patch` wrapped in `*** Begin Patch` and `*** End Patch`, with sections `*** Add File: <path>` (prefix every line with `+`), `*** Update File: <path>` (contextual `@@` hunks using ` `, `-`, `+` line prefixes; optional `*** End of File`), and `*** Delete File: <path>`. Updates preserve existing inode and line endings. Adding is exclusive; parent directories must exist. Symlinks, parent (..) components and moves are unsupported.";

pub fn patch_schema() -> Value {
    schemars::schema_for!(PatchInput).into()
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct PatchInput {
    /// Patch text wrapped in `*** Begin Patch` ... `*** End Patch`.
    #[schemars(length(min = 1))]
    patch: String,
}

pub(crate) struct Batch {
    operations: Vec<PatchOperation>,
}

impl Batch {
    pub(crate) fn paths(&self) -> impl Iterator<Item = &std::path::Path> {
        self.operations.iter().map(operation_path)
    }

    fn parse_envelope(patch: &str) -> Result<Self, ToolError> {
        let operations = parse_patch(patch).map_err(patch_error)?;
        for operation in &operations {
            if operation_path(operation)
                .to_str()
                .is_none_or(|path| path.contains("://"))
            {
                return Err(failed("patch requires filesystem paths"));
            }
        }
        Ok(Self { operations })
    }

    pub(crate) fn parse(input: Value) -> Result<Self, ToolError> {
        let PatchInput { patch } = serde_json::from_value(input).map_err(patch_error)?;
        Self::parse_envelope(&patch)
    }
}

/// Parse a patch envelope with the authoritative parser and return distinct target paths in order.
pub fn patch_paths(patch: &str) -> Result<Vec<String>, ToolError> {
    let batch = Batch::parse_envelope(patch)?;
    let mut paths = Vec::new();
    for path in batch.paths() {
        if let Some(path) = path.to_str()
            && !paths.iter().any(|seen| seen == path)
        {
            paths.push(path.to_owned());
        }
    }
    Ok(paths)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum OperationKind {
    #[serde(rename = "create_file")]
    Create,
    #[serde(rename = "update_file")]
    Update,
    #[serde(rename = "delete_file")]
    Delete,
}
#[derive(Clone, Serialize)]
struct AppliedOperation {
    #[serde(rename = "type")]
    kind: OperationKind,
    path: String,
}
impl AppliedOperation {
    fn from_operation(operation: &PatchOperation) -> Self {
        let kind = match operation {
            PatchOperation::Add { .. } => OperationKind::Create,
            PatchOperation::Update { .. } => OperationKind::Update,
            PatchOperation::Delete { .. } => OperationKind::Delete,
        };
        Self {
            kind,
            path: operation_path(operation).to_string_lossy().into_owned(),
        }
    }
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BatchResult {
    Completed {
        applied: Vec<AppliedOperation>,
        output: String,
    },
    Failed {
        applied: Vec<AppliedOperation>,
        #[serde(flatten)]
        boundary: FailureBoundary,
        error: String,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum FailureBoundary {
    Failed(AppliedOperation),
    StoppedBefore(AppliedOperation),
}

pub(crate) fn run(
    authority: &Authority,
    coordinator: &WriteCoordinator,
    batch: Batch,
    cancellation: &CancellationToken,
    started: &AtomicBool,
) -> Result<Value, ToolError> {
    let mut applied = Vec::new();
    for operation in batch.operations {
        let fact = AppliedOperation::from_operation(&operation);
        let (result, boundary) = if cancellation.is_cancelled() {
            (
                Err(failed("apply_patch cancelled before operation")),
                FailureBoundary::StoppedBefore(fact.clone()),
            )
        } else {
            (
                apply_one(authority, coordinator, operation, cancellation, started),
                FailureBoundary::Failed(fact.clone()),
            )
        };
        match result {
            Ok(()) => applied.push(fact),
            Err(ToolError::Failed(error) | ToolError::Io { message: error, .. })
                if !applied.is_empty() =>
            {
                return serde_json::to_value(BatchResult::Failed {
                    applied,
                    boundary,
                    error,
                })
                .map_err(patch_error);
            }
            Err(error) => return Err(error),
        }
    }
    let output = format!(
        "Applied {} file operation{}.",
        applied.len(),
        if applied.len() == 1 { "" } else { "s" }
    );
    serde_json::to_value(BatchResult::Completed { applied, output }).map_err(patch_error)
}

fn apply_one(
    authority: &Authority,
    coordinator: &WriteCoordinator,
    operation: PatchOperation,
    cancellation: &CancellationToken,
    started: &AtomicBool,
) -> Result<(), ToolError> {
    use crate::write_target::Target;
    let path = operation_path(&operation);
    let output_path = authority.write_display_path(path)?;
    let mut target = Target::capture(
        authority,
        path,
        if matches!(operation, PatchOperation::Update { .. }) {
            crate::write_target::ReadMode::Required
        } else {
            crate::write_target::ReadMode::None
        },
    )?;
    let _guard = coordinator
        .mutation
        .lock()
        .map_err(|_| failed("Write coordinator poisoned"))?;
    crate::write::check_cancelled(cancellation)?;
    let local_started = AtomicBool::new(false);
    let mutation = match operation {
        PatchOperation::Delete { .. } => {
            target.require_existing()?;
            // A panic after entering a mutation boundary is conservatively
            // unknown, even if prior operations completed successfully.
            started.store(true, Ordering::SeqCst);
            return target.delete(cancellation, &local_started);
        }
        PatchOperation::Add { content, .. } => {
            target.require_missing()?;
            Mutation::complete_write(output_path.clone(), content)
        }
        PatchOperation::Update { chunks, .. } => {
            target.require_existing()?;
            Mutation::PatchUpdate {
                path: output_path.clone(),
                chunks,
            }
        }
    };
    let (content, _) = target.prepare(mutation, &output_path, cancellation)?;
    started.store(true, Ordering::SeqCst);
    target.apply(content.as_bytes(), cancellation, &local_started)
}

fn operation_path(operation: &PatchOperation) -> &std::path::Path {
    match operation {
        PatchOperation::Add { path, .. }
        | PatchOperation::Delete { path }
        | PatchOperation::Update { path, .. } => path,
    }
}
fn patch_error(error: impl std::fmt::Display) -> ToolError {
    failed(error.to_string())
}
