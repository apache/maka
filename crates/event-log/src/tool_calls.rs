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

use maka_runtime::event::{Fact, RuntimeEvent};
use maka_runtime::model::ModelToolCall;
use maka_runtime::tool_call::ToolOrigin;
use sqlx::SqliteConnection;

use crate::StoreError;

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn identity(value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 4096 {
        return Err(invalid("tool identity must contain 1 to 4096 UTF-8 bytes"));
    }
    Ok(())
}

/// Runs after exact replay detection, inside the append transaction. SQL reads
/// the committed facts and earlier facts in this batch, never a mutable cache.
pub(crate) async fn validate(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let invocation = &event.invocation.invocation_id;
    match &event.fact {
        Fact::ToolNotified {
            operation_id,
            text,
            model_text,
        } => {
            identity(operation_id)?;
            if text.trim().is_empty()
                || text.len() > 128 * 1024
                || model_text.trim().is_empty()
                || model_text.len() > 128 * 1024
            {
                return Err(invalid("invalid Code Mode notification"));
            }
            let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events d
                WHERE d.invocation_id=? AND d.operation_id=? AND d.kind='tool_dispatched'
                  AND json_extract(d.event_json,'$.fact.call.origin.kind')='code_cell'
                  AND NOT EXISTS(SELECT 1 FROM runtime_events s WHERE s.invocation_id=d.invocation_id
                    AND s.operation_id=d.operation_id AND s.kind='tool_settled'))")
                .bind(invocation).bind(operation_id).fetch_one(&mut *tx).await?;
            if !live {
                return Err(invalid("notification requires a live Code Mode cell"));
            }
        }
        Fact::ToolDispatched {
            operation_id,
            call,
            name,
            input,
        }
        | Fact::ToolRejected {
            operation_id,
            call,
            name,
            input,
            ..
        } => {
            identity(operation_id)?;
            identity(&call.tool_call_id)?;
            // Provider IDs belong to a logical step. Host-generated IDs remain
            // fresh across the invocation, including collisions across origins.
            let provider_step = match &call.origin {
                ToolOrigin::Provider { step_id } => Some(step_id.as_str()),
                ToolOrigin::CodeMode { .. }
                | ToolOrigin::CodeCell { .. }
                | ToolOrigin::HostSdk { .. }
                | ToolOrigin::Standalone => None,
            };
            let duplicate: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM runtime_events
                 WHERE kind IN ('tool_dispatched', 'tool_rejected')
                 AND (operation_id = ?1 OR (invocation_id = ?2
                     AND json_extract(event_json, '$.fact.call.tool_call_id') = ?3
                     AND (?4 IS NULL
                         OR json_extract(event_json, '$.fact.call.origin.kind') IS NOT 'provider'
                         OR json_extract(event_json, '$.fact.call.origin.step_id') IS ?4))))",
            )
            .bind(operation_id)
            .bind(invocation)
            .bind(&call.tool_call_id)
            .bind(provider_step)
            .fetch_one(&mut *tx)
            .await?;
            if duplicate {
                return Err(invalid(
                    "tool operation or call identity already dispatched or rejected",
                ));
            }
            match &call.origin {
                ToolOrigin::Standalone => {}
                ToolOrigin::HostSdk {
                    package_id,
                    entry_id,
                    activation,
                    parent_operation_id,
                } => {
                    for value in [package_id, entry_id, activation] {
                        identity(value)?;
                    }
                    if let Some(parent) = parent_operation_id {
                        identity(parent)?;
                    }
                    let active: bool = if let Some(parent) = parent_operation_id {
                        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events AS parent
                            WHERE parent.invocation_id = ? AND parent.operation_id = ? AND parent.kind = 'tool_dispatched'
                            AND NOT EXISTS(SELECT 1 FROM runtime_events AS settled WHERE settled.operation_id = parent.operation_id
                                AND settled.kind = 'tool_settled'))")
                            .bind(invocation).bind(parent).fetch_one(&mut *tx).await?
                    } else {
                        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1 AND kind = 'executor_started')
                            AND NOT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1 AND kind = 'executor_completed')")
                            .bind(invocation).fetch_one(&mut *tx).await?
                    };
                    if !active {
                        return Err(invalid(
                            "Host SDK operation requires an active parent call or executor",
                        ));
                    }
                }
                ToolOrigin::CodeMode {
                    parent_operation_id,
                    parent_tool_call_id,
                }
                | ToolOrigin::CodeCell {
                    parent_operation_id,
                    parent_tool_call_id,
                } => {
                    identity(parent_operation_id)?;
                    identity(parent_tool_call_id)?;
                    let parent: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM runtime_events AS parent
                         WHERE parent.invocation_id = ? AND parent.operation_id = ?
                         AND parent.kind = 'tool_dispatched'
                         AND json_extract(parent.event_json, '$.fact.call.tool_call_id') = ?
                         AND NOT EXISTS(SELECT 1 FROM runtime_events AS settled
                             WHERE settled.invocation_id = parent.invocation_id
                             AND settled.operation_id = parent.operation_id
                             AND settled.kind = 'tool_settled'))",
                    )
                    .bind(invocation)
                    .bind(parent_operation_id)
                    .bind(parent_tool_call_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !parent {
                        return Err(invalid(
                            "nested tool requires matching unsettled parent in invocation",
                        ));
                    }
                }
                ToolOrigin::Provider { step_id } => {
                    identity(step_id)?;
                    if *operation_id != format!("{step_id}:{}", call.tool_call_id) {
                        return Err(invalid(
                            "provider tool operation identity does not match step and call",
                        ));
                    }
                    // Project only the selected call, not the full model output.
                    let accepted: Option<String> = sqlx::query_scalar(
                        "SELECT json_extract(part.value, '$.call')
                         FROM runtime_events AS model, json_each(model.event_json, '$.fact.output.parts') AS part
                         WHERE model.invocation_id = ? AND model.operation_id = ?
                         AND model.kind = 'model_completed'
                         AND json_extract(part.value, '$.kind') = 'tool_call'
                         AND json_extract(part.value, '$.call.id') = ?
                         AND json_extract(part.value, '$.call.provider_executed') = 0",
                    ).bind(invocation).bind(step_id).bind(&call.tool_call_id)
                        .fetch_optional(&mut *tx).await?;
                    let Some(accepted) = accepted else {
                        return Err(invalid(
                            "provider tool requires an accepted local model call",
                        ));
                    };
                    let accepted: ModelToolCall = serde_json::from_str(&accepted)?;
                    if accepted.name != *name || accepted.input != *input {
                        return Err(invalid("provider tool differs from accepted name or input"));
                    }
                }
            }
        }
        Fact::ToolSettled { operation_id, .. } => {
            let pending: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM runtime_events AS child
                 WHERE child.invocation_id = ? AND child.kind = 'tool_dispatched'
                 AND json_extract(child.event_json, '$.fact.call.origin.kind') IN ('code_mode', 'host_sdk')
                 AND json_extract(child.event_json, '$.fact.call.origin.parent_operation_id') = ?
                 AND NOT EXISTS(SELECT 1 FROM runtime_events AS settled
                     WHERE settled.invocation_id = child.invocation_id
                     AND settled.operation_id = child.operation_id AND settled.kind = 'tool_settled'))",
            ).bind(invocation).bind(operation_id).fetch_one(&mut *tx).await?;
            if pending {
                return Err(invalid("parent tool cannot settle before its children"));
            }
        }
        _ => {}
    }
    Ok(())
}
