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
use maka_agent_facts::cells::{
    CellEvent, CellId, CellNotification, CellNotificationBody, CellReplyState, CellStatus,
};
use maka_agent_facts::tool_output::{ReturnedToolResult, ToolOutput};
impl Engine {
    pub(super) async fn launch_cell(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        ports: &Arc<dyn DriverPorts>,
        live: &mut Live,
        work: &mut Work,
        cell: CellId,
    ) -> Result<(), RunError> {
        live.cells_observed.insert(cell);
        let Some(capability) = ports.cells() else {
            return self
                .block(
                    claim,
                    view,
                    BlockerKind::CodeCellRecoveryUnavailable {
                        cell: cell.as_uuid().to_string(),
                    },
                    ports.now(),
                )
                .await;
        };
        live.work.insert(WorkKey::Cell(cell));
        let snapshot = view.clone();
        work.push(
            async move {
                let result = capability
                    .observe_original_cell(&snapshot, &snapshot.cells[&cell])
                    .await;
                Completion::Cell { cell, result }
            }
            .boxed(),
        );
        Ok(())
    }
    pub(super) async fn complete_cell(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        live: &mut Live,
        cell: CellId,
        result: Result<CellObservation, RunError>,
        now: UnixMillis,
        retiring: bool,
    ) -> Result<(), RunError> {
        live.work.remove(&WorkKey::Cell(cell));
        match result {
            Ok(CellObservation::Live) => {}
            Ok(CellObservation::Recorded) => {
                if view
                    .cells
                    .get(&cell)
                    .is_some_and(|cell| matches!(cell.status, CellStatus::Running))
                {
                    return Err(RunError::Internal(
                        "Cell source acknowledged settlement without canonical evidence".into(),
                    ));
                }
            }
            Err(error) => {
                if retiring {
                    tracing::warn!(cause=%error,"retired original Cell observation failed");
                    return Ok(());
                }
                let reason = match error {
                    RunError::Blocked(reason) => reason,
                    error => {
                        tracing::error!(cause=%error,"original Cell could not be observed");
                        BlockerKind::CodeCellRecoveryUnavailable {
                            cell: cell.as_uuid().to_string(),
                        }
                    }
                };
                self.block(claim, view, reason, now).await?;
            }
        }
        Ok(())
    }
    pub(super) async fn accept_cell_with_tool(
        &self,
        view: &RunView,
        tool: &Tool,
    ) -> Result<Vec<Fact>, RunError> {
        if view.stopped {
            return Ok(vec![]);
        }
        let result = tool
            .local_returned
            .as_ref()
            .map(|returned| &returned.result)
            .or_else(|| tool.host_returned.as_ref().map(|returned| &returned.result));
        let Some(result) = result else {
            return Ok(vec![]);
        };
        let bytes = self.store.content(view.run, result.clone()).await?;
        let original: maka_agent_facts::artifact::ToolReturn<ReturnedToolResult> =
            serde_json::from_slice(&bytes).map_err(StoreError::from)?;
        let ToolOutput::Cell(reply) = &original.body.output else {
            return Ok(vec![]);
        };
        let CellReplyState::Completed { result } = &reply.state else {
            return Ok(vec![]);
        };
        let stored;
        let cell = if let Some(cell) = view.cells.get(&reply.cell) {
            cell
        } else {
            stored = self
                .store
                .cells()
                .read(&view.spec.session_id, reply.cell)
                .await?
                .ok_or_else(|| {
                    RunError::InvalidInput("Cell reply is outside the current Session".into())
                })?;
            if let CellStatus::Completed {
                result: expected, ..
            } = &stored.status
            {
                if expected == result {
                    return Ok(vec![]);
                }
            }
            return Err(RunError::InvalidInput(
                "Cell reply is not its original final result".into(),
            ));
        };
        match &cell.status {
            CellStatus::Completed {
                result: expected,
                accepted,
                ..
            } if expected == result => {
                if *accepted {
                    Ok(vec![])
                } else {
                    Ok(maka_agent_state::cells::acceptance(cell)?)
                }
            }
            _ => Err(RunError::InvalidInput(
                "Cell reply is not its original completed result".into(),
            )),
        }
    }
    pub(super) async fn accept_cell_final(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        cell: CellId,
        now: UnixMillis,
    ) -> Result<(), RunError> {
        let original = &view.cells[&cell];
        let CellStatus::Completed { result, .. } = &original.status else {
            return Err(RunError::Internal(
                "Cell final acceptance requires normal completion".into(),
            ));
        };
        let mut facts = maka_agent_state::cells::acceptance(original)?;
        let content = ContentBlob::json(&CellNotification {
            schema_version: 1,
            body: CellNotificationBody::Completed {
                result: result.clone(),
            },
        })?;
        facts.push(Fact::Cell {
            event: CellEvent::FinalNotificationQueued {
                cell,
                notification: FactId::new(),
                content: content.reference().clone(),
            },
        });
        self.publish(Some(claim), view, facts, vec![content], now)
            .await?;
        Ok(())
    }
    pub(super) async fn report_cell_interruption(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        cell: CellId,
        now: UnixMillis,
    ) -> Result<(), RunError> {
        let CellStatus::Interrupted { report } = &view.cells[&cell].status else {
            return Err(RunError::Internal(
                "Cell interruption report requires original evidence".into(),
            ));
        };
        let content = ContentBlob::json(&CellNotification {
            schema_version: 1,
            body: CellNotificationBody::Interrupted {
                report: report.clone(),
            },
        })?;
        self.publish(
            Some(claim),
            view,
            vec![Fact::Cell {
                event: CellEvent::FinalNotificationQueued {
                    cell,
                    notification: FactId::new(),
                    content: content.reference().clone(),
                },
            }],
            vec![content],
            now,
        )
        .await?;
        Ok(())
    }
}
