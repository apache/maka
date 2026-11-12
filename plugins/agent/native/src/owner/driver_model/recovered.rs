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
use maka_agent_facts::durable::{AcceptedResult, FactId, ModelAttemptId, RunId, StepId};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct RecordedInputs {
    pub cells: BTreeMap<CellId, FrozenCellKnowledge>,
    pub steering: BTreeSet<(RunId, String)>,
    pub notifications: BTreeSet<(RunId, FactId)>,
    pub step_purposes: BTreeMap<StepId, ModelPurpose>,
    pub attempt_steps: BTreeMap<ModelAttemptId, StepId>,
}

impl DriverModel {
    pub(super) async fn recorded_inputs(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        covered_through: u64,
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
            for fact in page {
                if fact.revision > view.revision {
                    break 'history;
                }
                after = fact.revision;
                match &fact.fact {
                    Fact::Cell { event } => {
                        let cell = event.cell();
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
        original.cells.append(&mut recovered);
        Ok(original)
    }
}
