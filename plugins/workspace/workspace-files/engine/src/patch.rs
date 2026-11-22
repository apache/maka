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
use apply_patch::{PatchOperation, parse_create, parse_patch, parse_update};
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_util::sync::CancellationToken;

pub const PATCH_NAME: &str = "apply_patch";
pub const PATCH_DESCRIPTION: &str = "Apply a create_file, update_file or delete_file operation within the Session's write roots. Updates use contextual patches and preserve existing inode and line endings. Create is exclusive; parent directories must exist. Symlinks, parent (..) components and moves are unsupported. callId is opaque provider metadata, not execution authority.";

pub fn patch_schema() -> Value {
    schemars::schema_for!(NativeInput).into()
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeInput {
    #[schemars(length(min = 1))]
    call_id: String,
    operation: NativeOperation,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum NativeOperation {
    #[serde(rename = "create_file")]
    Create {
        #[schemars(length(min = 1))]
        path: String,
        diff: String,
    },
    #[serde(rename = "update_file")]
    Update {
        #[schemars(length(min = 1))]
        path: String,
        diff: String,
    },
    #[serde(rename = "delete_file")]
    Delete {
        #[schemars(length(min = 1))]
        path: String,
    },
}
enum BatchMode {
    Native,
    Envelope,
}
pub(crate) struct Batch {
    operations: Vec<PatchOperation>,
    mode: BatchMode,
}

impl Batch {
    pub(crate) fn paths(&self) -> impl Iterator<Item = &std::path::Path> {
        self.operations.iter().map(operation_path)
    }

    pub(crate) fn parse(input: Value) -> Result<Self, ToolError> {
        let batch = if let Value::String(patch) = input {
            Self {
                operations: parse_patch(&patch).map_err(patch_error)?,
                mode: BatchMode::Envelope,
            }
        } else {
            let NativeInput { call_id, operation } =
                serde_json::from_value(input).map_err(patch_error)?;
            if call_id.is_empty() {
                return Err(failed("apply_patch callId must be nonempty"));
            }
            let operation = match operation {
                NativeOperation::Create { path, diff } => PatchOperation::Add {
                    path: path.into(),
                    content: parse_create(&diff).map_err(patch_error)?,
                },
                NativeOperation::Update { path, diff } => PatchOperation::Update {
                    path: path.into(),
                    chunks: parse_update(&diff).map_err(patch_error)?,
                },
                NativeOperation::Delete { path } => PatchOperation::Delete { path: path.into() },
            };
            Self {
                operations: vec![operation],
                mode: BatchMode::Native,
            }
        };
        for operation in &batch.operations {
            let path = operation_path(operation)
                .to_str()
                .ok_or_else(|| failed("patch requires a UTF-8 path"))?;
            if path.is_empty() || path.contains('\0') || path.contains("://") {
                return Err(failed("patch requires filesystem paths"));
            }
        }
        Ok(batch)
    }
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
            Err(ToolError::Failed(error)) if matches!(batch.mode, BatchMode::Envelope) => {
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
    match batch.mode {
        BatchMode::Native => Ok(json!({"status":"completed"})),
        BatchMode::Envelope => {
            let output = format!(
                "Applied {} file operation{}.",
                applied.len(),
                if applied.len() == 1 { "" } else { "s" }
            );
            serde_json::to_value(BatchResult::Completed { applied, output }).map_err(patch_error)
        }
    }
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
