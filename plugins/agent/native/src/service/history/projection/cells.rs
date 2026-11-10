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

use super::*;
use maka_agent_facts::cells::{CellEvent, CellOwner, CellStatus};
use maka_agent_facts::tool_call::ToolSettlement;
use maka_agent_state::fold::RunView;
use maka_plugin_core::operation::{OperationOutcome, Receipt};

pub(super) fn project(
    item: &HistoryItem,
    turn: &str,
    address: &wire::HistoryRowAddress,
    event: &CellEvent,
    view: &RunView,
) -> Result<Row, String> {
    let mut row = base(item, turn, 0, Role::ToolResult, address)?;
    row.fields.push((
        SourceField::Receipt,
        Field::Json(serde_json::to_value(event).map_err(|error| error.to_string())?),
    ));
    let operation = match event {
        CellEvent::ChildPrepared { operation, .. }
        | CellEvent::ChildRejected { operation, .. }
        | CellEvent::LocalChildReturned { operation, .. }
        | CellEvent::ChildResultRecorded { operation, .. }
        | CellEvent::ChildObserved { operation, .. } => operation,
        _ => {
            let field = match event {
                CellEvent::Started { source, .. } => Some((SourceField::Body, source)),
                CellEvent::ChildApprovalRecorded { input, .. } => {
                    Some((SourceField::Arguments, input))
                }
                CellEvent::Completed { result, .. } => Some((SourceField::Result, result)),
                CellEvent::Interrupted { report, .. } => Some((SourceField::Result, report)),
                CellEvent::SessionValuePublished { value, .. } => {
                    Some((SourceField::Result, value))
                }
                CellEvent::NotificationQueued { content, .. } => Some((SourceField::Body, content)),
                _ => None,
            };
            if let Some((field, reference)) = field {
                row.fields.push((field, Field::Content(reference.clone())));
            }
            return Ok(row);
        }
    };
    let cell = view
        .cells
        .get(&event.cell())
        .ok_or("agent_history_cell_missing")?;
    let child = cell
        .children
        .get(operation)
        .ok_or("agent_history_cell_child_missing")?;
    let id = maka_agent_facts::tool_call::tool_use_id(
        item.recorded.run,
        &format!("cell:{}:{operation}", cell.id),
    );
    match event {
        CellEvent::ChildPrepared { input, name, .. } => {
            row.chunk.role = Role::ToolCall;
            tool(&mut row, id, Some(name.clone()), None);
            let call = row
                .chunk
                .tool
                .as_mut()
                .and_then(|tool| tool.call.as_mut())
                .expect("Cell child call");
            call.origin = wire::ToolCallOrigin::CodeMode;
            if let Some(display) = &child.display {
                super::apply_display(call, display);
            }
            if let CellOwner::Agent { link, call: parent } = &cell.owner {
                call.ancestor_tool_use_ids
                    .push(super::super::super::delivery::tool_id(
                        link.run,
                        &ToolKey {
                            attempt: link.attempt,
                            call: parent.clone(),
                        },
                    ));
            }
            call.dispatched = child.admitted;
            call.pending = view.terminal.is_none()
                && matches!(cell.status, CellStatus::Running)
                && child.local_result.is_none()
                && child.provider_result.is_none()
                && child.rejected.is_none()
                && child.reply.as_ref().is_none_or(|reply| {
                    matches!(
                        reply.receipt,
                        Receipt::NotRecorded
                            | Receipt::Unavailable { .. }
                            | Receipt::Recorded {
                                outcome: OperationOutcome::Unresolved,
                                ..
                            }
                    )
                });
            row.fields
                .push((SourceField::ToolName, Field::Text(name.clone().into())));
            row.fields
                .push((SourceField::Arguments, Field::Content(input.clone())));
        }
        CellEvent::LocalChildReturned {
            result,
            is_error,
            settlement,
            ..
        } => {
            returned(&mut row, id, *is_error, *settlement);
            row.fields
                .push((SourceField::Result, Field::Content(result.clone())));
        }
        CellEvent::ChildResultRecorded {
            result, is_error, ..
        } => {
            returned(
                &mut row,
                id,
                *is_error,
                child
                    .provider_result
                    .as_ref()
                    .ok_or("agent_history_cell_child_result_missing")?
                    .settlement,
            );
            row.fields
                .push((SourceField::Result, Field::Content(result.clone())));
        }
        CellEvent::ChildRejected { diagnostic, .. } => {
            returned(&mut row, id, true, ToolSettlement::Rejected);
            row.fields
                .push((SourceField::Result, Field::Text(diagnostic.clone().into())));
        }
        CellEvent::ChildObserved { reply, .. } => {
            let Some(settlement) = super::super::super::delivery::settlement(reply) else {
                return Ok(row);
            };
            returned(
                &mut row,
                id,
                settlement != ToolSettlement::Returned,
                settlement,
            );
        }
        _ => unreachable!("selected Cell child observation"),
    }
    Ok(row)
}
fn returned(row: &mut Row, id: String, is_error: bool, settlement: ToolSettlement) {
    tool(row, id, None, Some(is_error));
    row.chunk
        .tool
        .as_mut()
        .and_then(|tool| tool.result.as_mut())
        .expect("Cell child result")
        .settlement = Some(settlement);
}
