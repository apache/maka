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
use super::{Owner, RunAccess, driver_cells, now};
use maka_agent_engine::Engine;
use maka_agent_engine::{DriverExit, RunError};
use maka_agent_facts::{
    cells::CellId,
    durable::{BackendSpec, ExecutionIdentity, RunId, UnixMillis},
    external_effects::ExternalEffectKey,
    message::MessageOrigin,
    tool_call::ToolOrigin,
};
use maka_agent_state::{DriverClaim, Store, external_effects::MissingReturn, fold::RunView};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) fn is_recovery_message(
    message: &maka_agent_facts::input::DeliveredMessage,
    session: &str,
) -> bool {
    matches!(&message.origin, Some(MessageOrigin::Session { execution })
        if execution.session_id == session && message.message_id == format!("m_{}", recovery_request_id(execution.run_id)))
}

pub(super) fn recovery_request_id(run: RunId) -> String {
    format!("recover-external-{run}")
}

impl RunAccess {
    pub(super) async fn missing_tool_returns<'a>(
        &'a self,
        state: &Store,
    ) -> Result<&'a [MissingReturn], RunError> {
        // Session Runs are admitted in order. The original receipts themselves may still advance.
        Ok(self
            .missing_returns
            .get_or_try_init(|| state.missing_external_returns(self.spec()))
            .await?
            .as_slice())
    }
}

pub(super) async fn context(
    state: &Store,
    session: &str,
    calls: &[MissingReturn],
) -> Result<String, RunError> {
    let mut results = Vec::new();
    for &MissingReturn {
        run,
        key,
        cell: cell_id,
    } in calls
    {
        let descriptor = state.external_effect_descriptor(run, key).await?;
        let cell = state.cells().read(session, cell_id).await?;
        let mut result = serde_json::json!({
            "callId": descriptor.operation_id, "tool":descriptor.name, "result":"outcome_unknown"
        });
        if let Some(cell) = cell {
            result["cellId"] = serde_json::json!(cell.id);
            result["children"] = Value::Array(cell.children.iter().map(|(operation, child)| {
                serde_json::json!({"callId":operation, "tool":child.name, "title":child.display.as_ref().map(|d| &d.title),
                    "result":if child.known() {"recorded"} else if child.admitted {"outcome_unknown"} else {"not_dispatched"},
                    "operation":child.reference.as_ref().map(|r| r.operation)})
            }).collect());
            if matches!(
                cell.status,
                maka_agent_facts::cells::CellStatus::Completed { .. }
            ) {
                result["result"] = serde_json::json!("cell_completed");
            }
        }
        results.push(result);
    }
    Ok(format!(
        "[Host tool recovery] {}\nThese calls have already been admitted. Their effects may still be running. Do not repeat them. Inspect the current state to continue. For completed cells use wait with the original cellId to read the result.",
        Value::Array(results)
    ))
}

pub(super) async fn previous_shell(
    state: &Store,
    access: &RunAccess,
    command: &str,
) -> Result<Option<Uuid>, RunError> {
    for &MissingReturn { cell: cell_id, .. } in access.missing_tool_returns(state).await? {
        let cells = state.cells();
        let Some(cell) = cells.read(&access.execution().session_id, cell_id).await? else {
            continue;
        };
        for (call_id, child) in &cell.children {
            if child.name != "Shell" || !child.admitted || child.known() {
                continue;
            }
            let original = cells
                .content(&access.execution().session_id, cell_id, child.input.clone())
                .await?;
            let args: Value = serde_json::from_slice(&original).map_err(RunError::Json)?;
            if args.get("command").and_then(Value::as_str) == Some(command) {
                return Ok(Some(*call_id));
            }
        }
    }
    Ok(None)
}

impl Owner {
    pub(super) async fn interrupt_lost_bridge(
        &self,
        state: &Store,
        claim: &DriverClaim,
        initial: &RunView,
        cells: Option<&driver_cells::RunCells>,
    ) -> Result<Option<DriverExit>, RunError> {
        if !matches!(&initial.spec.backend, BackendSpec::Executor { selection, .. }
            if selection.executor == "external" && selection.settings.runtime.as_deref() == Some("antigravity"))
        {
            return Ok(None);
        }
        let Some(task) = initial.external.as_ref().filter(|task| {
            task.live_workspace
                && task.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed
                && task.binding.is_some()
                && task.publication.is_none()
        }) else {
            return Ok(None);
        };
        let mut calls = BTreeMap::new();
        for (&operation, effect) in &task.effects {
            if !effect.pending() {
                continue;
            }
            if !effect.admitted || effect.returned.is_some() {
                return Ok(None);
            }
            let key = ExternalEffectKey {
                task: task.task,
                operation,
            };
            let descriptor = state.external_effect_descriptor(initial.run, key).await?;
            if !matches!(&descriptor.origin, ToolOrigin::External { activation, .. } if activation != &self.revision.activation)
                || effect.reference.is_some()
            {
                return Ok(None);
            }
            let cell = match descriptor.name.as_str() {
                "exec" => CellId::for_external(initial.run, key),
                "wait" => match descriptor
                    .input
                    .get("cell_id")
                    .and_then(Value::as_str)
                    .and_then(|id| id.parse::<Uuid>().ok())
                    .and_then(|id| CellId::try_from(id).ok())
                {
                    Some(cell) => cell,
                    None => return Ok(None),
                },
                _ => return Ok(None),
            };
            if let Some(cells) = cells {
                match cells.read_current(cell).await {
                    Ok(_) | Err(maka_agent_facts::tools::ToolError::OutcomeUnknown(_)) => {}
                    Err(error) => return Err(RunError::Tool(error)),
                }
            }
            calls.insert(operation, cell);
        }
        if calls.is_empty() {
            return Ok(None);
        }
        let engine = Engine::new(state.clone());
        loop {
            let view = state.frontier(initial.run).await?;
            if view.terminal.is_some() {
                return Ok(None);
            }
            let task = view.external.as_ref().expect("admitted external task");
            if !view.can_interrupt_host_calls(&calls)
                || calls.keys().any(|key| {
                    task.effects
                        .get(key)
                        .is_none_or(|effect| effect.returned.is_some())
                })
            {
                return Ok(None);
            }
            if !view.stopped
                && !view.cancelled_by_risk
                && !view.finish_requested()
                && matches!(
                    view.spec.trigger,
                    maka_agent_facts::durable::Trigger::Message { .. }
                )
            {
                let source = ExecutionIdentity {
                    session_id: view.spec.session_id.clone(),
                    turn_id: view.spec.turn_id.clone(),
                    run_id: view.run,
                };
                let queued = async {
                    let route = self.return_route(&source).await?;
                    self.prepare_notification(&source, &route, &recovery_request_id(view.run),
                        |_| "Continue the interrupted turn. Inspect the original tool results and current state before taking further action.".into(),
                        MessageOrigin::Session { execution:source.clone() }
                    ).await
                }.await;
                if let Err(error) = queued {
                    if state.frontier(initial.run).await?.stopped {
                        continue;
                    }
                    return Err(RunError::InvalidInput(error));
                }
            }
            if let Some(exit) = engine
                .interrupt_external_returns(
                    claim,
                    &view,
                    task.task,
                    &calls,
                    UnixMillis(now() as i64),
                )
                .await?
            {
                return Ok(Some(exit));
            }
        }
    }
}
