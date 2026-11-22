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

use super::{
    DriverModel, Fact, FrozenCellKnowledge, HistorySource, ModelPurpose, RunError, RunView,
};
use maka_agent_facts::cells::{CellEvent, CellId, CellView};
use maka_agent_facts::durable::{AcceptedResult, FactId, ModelAttemptId, RunId, StepId, ToolKey};
use maka_agent_facts::model::ModelPart;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct RecordedInputs {
    pub unfinished_provider_calls: BTreeSet<ToolKey>,
    pub cells: BTreeMap<CellId, FrozenCellKnowledge>,
    pub restricted_cells: RestrictedCells,
    pub steering: BTreeSet<(RunId, String)>,
    pub notifications: BTreeSet<(RunId, FactId)>,
    pub step_purposes: BTreeMap<StepId, ModelPurpose>,
    pub attempt_steps: BTreeMap<ModelAttemptId, StepId>,
}

#[derive(Default)]
pub(super) struct RestrictedCells {
    first_revision: BTreeMap<CellId, u64>,
    pub notifications: BTreeSet<FactId>,
    pub returns: BTreeSet<String>,
}

impl RestrictedCells {
    pub fn includes(&self, cell: CellId, through: u64) -> bool {
        self.first_revision
            .get(&cell)
            .is_some_and(|rev| *rev <= through)
    }
}

impl DriverModel {
    pub(super) async fn recorded_inputs(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        covered_through: u64,
        aliases: &BTreeMap<String, crate::tools::HistoryReader>,
    ) -> Result<RecordedInputs, RunError> {
        let mut original = RecordedInputs::default();
        let mut cells = BTreeMap::<CellId, CellView>::new();
        let mut recovered = BTreeMap::new();
        let mut after = 0;
        'history: loop {
            let page = reader.history(view.run, after, 256).await?;
            if page.is_empty() {
                break;
            }
            let restricted = if view.run != self.execution.run_id {
                let facts = page
                    .iter()
                    .take_while(|f| f.revision <= view.revision)
                    .filter(|f| {
                        matches!(
                            f.fact,
                            Fact::LocalToolReturned { .. }
                                | Fact::Cell {
                                    event: CellEvent::ChildPrepared { .. }
                                        | CellEvent::ChildRejected { .. }
                                        | CellEvent::ChildApprovalRecorded { .. }
                                        | CellEvent::ChildObserved { .. }
                                        | CellEvent::ChildResultRecorded { .. }
                                        | CellEvent::LocalChildReturned { .. }
                                        | CellEvent::Completed { .. }
                                        | CellEvent::Interrupted { .. }
                                        | CellEvent::NotificationQueued { .. }
                                        | CellEvent::FinalNotificationQueued { .. }
                                }
                        )
                    })
                    .map(|f| f.id)
                    .collect();
                self.history.restricted_archives(facts).await?
            } else {
                Default::default()
            };
            for fact in page {
                if fact.revision > view.revision {
                    break 'history;
                }
                after = fact.revision;
                match &fact.fact {
                    Fact::ModelObserved {
                        attempt,
                        part: ModelPart::ToolCall { call },
                        ..
                    } if call.provider_executed => {
                        original.unfinished_provider_calls.insert(ToolKey {
                            attempt: *attempt,
                            call: call.id.clone(),
                        });
                    }
                    Fact::ModelObserved {
                        attempt,
                        part: ModelPart::ToolResult { id, .. },
                        ..
                    } => {
                        original.unfinished_provider_calls.remove(&ToolKey {
                            attempt: *attempt,
                            call: id.clone(),
                        });
                    }
                    Fact::Cell { event } => {
                        let cell = event.cell();
                        if view.run != self.execution.run_id
                            && let CellEvent::ChildPrepared { name, input, .. } = event
                            && super::replay::sensitive_child(
                                reader, view.run, name, input, aliases,
                            )
                            .await?
                        {
                            original
                                .restricted_cells
                                .first_revision
                                .entry(cell)
                                .or_insert(after);
                        }
                        if restricted.get(&fact.id)
                            == Some(&maka_agent_state::memory::recall::ArchiveRestriction::Source)
                        {
                            match event {
                                CellEvent::NotificationQueued { notification, .. }
                                | CellEvent::FinalNotificationQueued { notification, .. } => {
                                    original
                                        .restricted_cells
                                        .notifications
                                        .insert(*notification);
                                }
                                _ => {
                                    original
                                        .restricted_cells
                                        .first_revision
                                        .entry(cell)
                                        .or_insert(fact.revision);
                                }
                            }
                        }
                        if recovered.contains_key(&cell) || original.cells.contains_key(&cell) {
                            continue;
                        }
                        if matches!(event, CellEvent::Started { .. }) {
                            let source = CellView::started(event).map_err(|error| {
                                RunError::ReconciliationRequired(error.to_string())
                            })?;
                            cells.insert(cell, source);
                        } else {
                            cells
                                .get_mut(&cell)
                                .ok_or_else(|| {
                                    RunError::ReconciliationRequired(
                                        "Cell knowledge lost its original start".into(),
                                    )
                                })?
                                .apply(event)
                                .map_err(|error| {
                                    RunError::ReconciliationRequired(error.to_string())
                                })?;
                        }
                    }
                    Fact::LocalToolReturned { tool, .. } if view.run != self.execution.run_id => {
                        let key = maka_agent_state::fold::tool_key(tool);
                        if let Some(original_tool) = view.tools.get(&key) {
                            let observed = if original_tool.call.name == "wait" {
                                original_tool
                                    .call
                                    .input
                                    .as_json()
                                    .and_then(|args| args.get("cell_id"))
                                    .and_then(|id| id.as_str())
                                    .and_then(|id| id.parse::<uuid::Uuid>().ok())
                                    .and_then(|id| CellId::try_from(id).ok())
                            } else {
                                view.original_cell(original_tool).map(|cell| cell.id)
                            };
                            if restricted.contains_key(&fact.id)
                                || observed.is_some_and(|cell| {
                                    original.restricted_cells.includes(cell, after)
                                })
                            {
                                original.restricted_cells.returns.insert(key);
                            }
                        }
                    }
                    Fact::ToolResultAccepted {
                        outcome: AcceptedResult::CellRecovered { cell },
                        ..
                    } => {
                        if let std::collections::btree_map::Entry::Vacant(entry) =
                            recovered.entry(*cell)
                            && !original.cells.contains_key(cell)
                        {
                            let source = cells.remove(cell).ok_or_else(|| {
                                RunError::ReconciliationRequired(
                                    "Cell knowledge is absent from the original tool acceptance"
                                        .into(),
                                )
                            })?;
                            // Later cleanup can advance the Run without changing this accepted result.
                            entry.insert(FrozenCellKnowledge {
                                cell: *cell,
                                through: fact.revision,
                                children: source.children,
                            });
                        }
                    }
                    _ => {}
                }
                if let Fact::ModelAttemptPrepared { attempt, step } = &fact.fact {
                    original.attempt_steps.insert(*attempt, *step);
                }
                if let Fact::StepPrepared { step, .. } = fact.fact {
                    let request = reader.request(view.run, step).await?;
                    original
                        .step_purposes
                        .insert(step, request.accounting.purpose);
                    if request.accounting.purpose != ModelPurpose::Main {
                        continue;
                    }
                    let frozen = self.frozen_input(reader, view.run, &request).await?;
                    if fact.revision <= covered_through {
                        for reference in &request.steering {
                            let source: maka_agent_facts::message::RootSourceMessage =
                                reader.decode(view.run, reference).await?;
                            original
                                .steering
                                .insert((view.run, source.message.message_id));
                        }
                        original.notifications.extend(
                            frozen
                                .notifications
                                .iter()
                                .map(|notice| (view.run, notice.id)),
                        );
                    }
                    for knowledge in frozen.recovered_cells {
                        // A consumed observation never acquires later child knowledge.
                        recovered.remove(&knowledge.cell);
                        original.cells.entry(knowledge.cell).or_insert(knowledge);
                    }
                }
            }
        }
        if view.terminal.is_some() {
            for (cell, source) in cells {
                if !original.cells.contains_key(&cell)
                    && !recovered.contains_key(&cell)
                    && !source.has_unsettled_effects()
                    && matches!(
                        source.status,
                        maka_agent_facts::cells::CellStatus::Completed { .. }
                            | maka_agent_facts::cells::CellStatus::Interrupted { .. }
                    )
                {
                    recovered.insert(
                        cell,
                        FrozenCellKnowledge {
                            cell,
                            through: view.revision,
                            children: source.children,
                        },
                    );
                }
            }
        }
        original.cells.append(&mut recovered);
        Ok(original)
    }
}
