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

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::tool_call::{HostSdkParent, ToolOrigin};
use sqlx::SqliteConnection;

use crate::StoreError;

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn identity(value: &str) -> Result<(), StoreError> {
    if value.is_empty() {
        return Err(invalid("tool identity must be nonempty"));
    }
    Ok(())
}

impl crate::EventLog {
    /// The immutable T1 whose input the original prepared effect will execute.
    /// This is evidence for a confirmation, not effect admission or authorization.
    pub async fn tool_dispatch_receipt(
        &self,
        context: &maka_agent_facts::tools::ToolCallContext,
        name: &str,
        input: &serde_json::Value,
    ) -> Result<maka_agent_facts::native_approval::DispatchReceipt, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&context.invocation.session_id)?;
        let context = context.clone();
        let name = name.to_owned();
        let input = input.clone();
        self.connection.read(move |db|Box::pin(async move {
            let (sequence,json):(i64,String)=sqlx::query_as("SELECT sequence,event_json FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind='tool_dispatched'").bind(&context.invocation.invocation_id).bind(&context.operation_id).fetch_optional(db).await?.ok_or_else(||invalid("service confirmation requires durable dispatch"))?;
            let event:RuntimeEvent=serde_json::from_str(&json)?;
            if event.invocation!=context.invocation || !matches!(&event.fact,Fact::ToolDispatched{name:original,input:original_input,..} if *original==name && *original_input==input) {return Err(invalid("service confirmation differs from durable dispatch"))}
            Ok(maka_agent_facts::native_approval::DispatchReceipt{event_id:event.id,sequence:crate::sequence_number(sequence)?})
        })).await
    }
    pub async fn tool_dispatch_fence(
        &self,
        context: &maka_agent_facts::tools::ToolCallContext,
        name: &str,
        input: &serde_json::Value,
    ) -> Result<u64, StoreError> {
        self.validate_root()?;
        let context = context.clone();
        let name = name.to_owned();
        let input = input.clone();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let (sequence, encoded): (i64, String) = sqlx::query_as(
                        "SELECT sequence, event_json FROM runtime_events
                 WHERE invocation_id = ? AND operation_id = ? AND kind = 'tool_dispatched'",
                    )
                    .bind(&context.invocation.invocation_id)
                    .bind(&context.operation_id)
                    .fetch_optional(&mut *connection)
                    .await?
                    .ok_or_else(|| invalid("service confirmation requires durable dispatch"))?;
                    let event: RuntimeEvent = serde_json::from_str(&encoded)?;
                    if event.invocation != context.invocation
                        || !matches!(event.fact,
                Fact::ToolDispatched { name: original_name, input: original_input, .. }
                if original_name == name && original_input == input)
                    {
                        return Err(invalid(
                            "service confirmation differs from durable dispatch",
                        ));
                    }
                    crate::sequence_number(sequence)
                })
            })
            .await
    }
}

/// Runs after exact replay detection, inside the append transaction. SQL reads
/// the committed facts and earlier facts in this batch, never a mutable cache.
pub(crate) async fn validate(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let invocation = &event.invocation.invocation_id;
    match &event.fact {
        Fact::ToolOperationObserved { operation_id, .. } => {
            identity(operation_id)?;
            let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events d
                WHERE d.invocation_id=? AND d.operation_id=? AND d.kind='tool_dispatched'
                  AND NOT EXISTS(SELECT 1 FROM runtime_events s WHERE s.invocation_id=d.invocation_id
                    AND s.operation_id=d.operation_id AND s.kind='tool_settled'))")
                .bind(invocation).bind(operation_id).fetch_one(&mut *tx).await?;
            if !live {
                return Err(invalid(
                    "service observation requires a dispatched unsettled tool",
                ));
            }
        }
        Fact::ToolNotified {
            operation_id,
            text,
            model_text,
        } => {
            identity(operation_id)?;
            if text.trim().is_empty() || model_text.trim().is_empty() {
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
            ..
        }
        | Fact::ToolRejected {
            operation_id,
            call,
            name,
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
            let duplicate: bool = if let Some(step) = provider_step {
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM runtime_events
                       WHERE operation_id=?1 AND kind IN ('tool_dispatched','tool_rejected'))
                     OR EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=?2
                       AND kind IN ('tool_dispatched','tool_rejected')
                       AND json_extract(event_json,'$.fact.call.tool_call_id')=?3
                       AND CASE WHEN json_extract(event_json,'$.fact.call.origin.kind')='provider'
                         THEN json_extract(event_json,'$.fact.call.origin.step_id') END IS NULL)
                     OR EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=?2
                       AND kind IN ('tool_dispatched','tool_rejected')
                       AND json_extract(event_json,'$.fact.call.tool_call_id')=?3
                       AND CASE WHEN json_extract(event_json,'$.fact.call.origin.kind')='provider'
                         THEN json_extract(event_json,'$.fact.call.origin.step_id') END=?4)",
                )
                .bind(operation_id)
                .bind(invocation)
                .bind(&call.tool_call_id)
                .bind(step)
                .fetch_one(&mut *tx)
                .await?
            } else {
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM runtime_events
                       WHERE operation_id=?1 AND kind IN ('tool_dispatched','tool_rejected'))
                     OR EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=?2
                       AND kind IN ('tool_dispatched','tool_rejected')
                       AND json_extract(event_json,'$.fact.call.tool_call_id')=?3)",
                )
                .bind(operation_id)
                .bind(invocation)
                .bind(&call.tool_call_id)
                .fetch_one(&mut *tx)
                .await?
            };
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
                    parent,
                } => {
                    for value in [package_id, entry_id, activation] {
                        identity(value)?;
                    }
                    if let Some(parent) = parent {
                        identity(parent.operation_id())?;
                        if let HostSdkParent::EvaluationObserver { epoch, .. } = parent {
                            identity(epoch)?;
                        }
                    }
                    let active: bool = if let Some(parent) = parent {
                        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events AS parent
                            WHERE parent.invocation_id = ? AND parent.operation_id = ? AND parent.kind = 'tool_dispatched'
                            AND NOT EXISTS(SELECT 1 FROM runtime_events AS settled WHERE settled.invocation_id = parent.invocation_id
                                AND settled.operation_id = parent.operation_id
                                AND settled.kind = 'tool_settled'))")
                            .bind(invocation).bind(parent.operation_id()).fetch_one(&mut *tx).await?
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
                    let accepted = crate::model_items::accepted_call(
                        tx,
                        invocation,
                        step_id,
                        &call.tool_call_id,
                    )
                    .await?
                    .ok_or_else(|| {
                        invalid("provider tool requires an accepted local model call")
                    })?;
                    let same_input = match &event.fact {
                        Fact::ToolDispatched { input, .. } => matches!(
                            &accepted.input,
                            maka_agent_facts::model::ToolInput::Json(value) if value == input
                        ),
                        Fact::ToolRejected { input, .. } => accepted.input == *input,
                        _ => unreachable!("tool admission fact"),
                    };
                    if accepted.name != *name || !same_input {
                        return Err(invalid("provider tool differs from accepted name or input"));
                    }
                }
            }
        }
        Fact::ToolSettled { operation_id, .. } => {
            let pending: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM context_obligations live
                 CROSS JOIN runtime_events child ON child.sequence=live.opened_at
                 WHERE live.invocation_id = ?1 AND live.kind='tool'
                 AND ((json_extract(child.event_json, '$.fact.call.origin.kind') = 'code_mode'
                   AND json_extract(child.event_json, '$.fact.call.origin.parent_operation_id') = ?2)
                   OR (json_extract(child.event_json, '$.fact.call.origin.kind') = 'host_sdk'
                     AND json_extract(child.event_json, '$.fact.call.origin.parent_relationship.kind') IS NOT 'evaluation_observer'
                     AND json_extract(child.event_json, '$.fact.call.origin.parent_operation_id') = ?2)))",
            ).bind(invocation).bind(operation_id).fetch_one(&mut *tx).await?;
            if pending {
                return Err(invalid("parent tool cannot settle before its children"));
            }
        }
        _ => {}
    }
    Ok(())
}
