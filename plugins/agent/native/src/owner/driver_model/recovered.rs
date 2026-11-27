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
use crate::owner::driver::discovery::Observation;
use maka_agent_facts::cells::{CellChild, CellEvent, CellId, CellView};
use maka_agent_facts::durable::{
    AcceptedResult, ContentRef, FactId, ModelAttemptId, RunId, StepId, ToolKey,
};
use maka_agent_facts::model::ModelPart;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct RecordedInputs {
    pub discovery_last_results: BTreeMap<ModelAttemptId, FactId>,
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

enum Settlement<'a> {
    Failed,
    Provider(&'a serde_json::Value),
    Accepted(&'a ContentRef),
}

impl DriverModel {
    pub(in crate::owner) async fn refresh_discovery_progress(
        &self,
        view: &RunView,
    ) -> Result<(), RunError> {
        if self
            .discovery
            .as_ref()
            .is_some_and(|p| !p.lock().unwrap().recorded(view.revision))
        {
            let reader = self.history_reader(view.run).await?;
            self.recorded_inputs(&reader, view, 0, &BTreeMap::new())
                .await?;
        }
        Ok(())
    }

    async fn discovery_tool_observation(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        revision: u64,
        key: &ToolKey,
        settlement: Settlement<'_>,
    ) -> Result<Observation, RunError> {
        if matches!(settlement, Settlement::Failed) {
            return Ok(Observation::default());
        }
        let call = reader.tool_call(view.run, key).await?;
        let observation = Observation::success(
            &call.name,
            call.input.as_json(),
            std::path::Path::new(&view.spec.workspace),
        );
        if !observation.needs_evidence(&call.name) {
            return Ok(observation);
        }
        let output = match settlement {
            Settlement::Provider(value) => maka_model::prompt::ToolOutput::Json(value.clone()),
            Settlement::Accepted(reference) => {
                self.project_accepted(
                    reader,
                    view,
                    revision,
                    &BTreeMap::new(),
                    reader.decode(view.run, reference).await?,
                    false,
                    view.spec.language,
                )
                .await?
            }
            Settlement::Failed => unreachable!(),
        };
        tokio::task::spawn_blocking(move || observation.with_output(&call.name, &output))
            .await
            .map_err(|e| RunError::Internal(e.to_string()))
    }

    pub(in crate::owner) async fn discovery_rejection(
        &self,
        view: &RunView,
        tool: &maka_agent_state::fold::Tool,
    ) -> Result<Option<String>, RunError> {
        let Some(guard) = &self.discovery else {
            return Ok(None);
        };
        let step = view
            .attempts
            .get(&tool.key.attempt)
            .ok_or_else(|| RunError::InvalidInput("missing discovery tool attempt".into()))?
            .step;
        if guard.lock().unwrap().budget(step).is_none() {
            // A driver can resume at tool admission without having prepared the model step in this process.
            self.refresh_discovery_progress(view).await?;
        }
        let progress = guard.lock().unwrap();
        let budget = progress
            .budget(step)
            .ok_or_else(|| RunError::InvalidInput("missing discovery step budget".into()))?;
        Ok(progress.rejection(budget, &tool.call.name, view.spec.language))
    }

    pub(super) async fn recorded_inputs(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        covered_through: u64,
        aliases: &BTreeMap<String, crate::tools::HistoryReader>,
    ) -> Result<RecordedInputs, RunError> {
        let mut original = RecordedInputs::default();
        let discovery = self
            .discovery
            .as_ref()
            .filter(|_| view.run == self.execution.run_id);
        let mut provider_calls = BTreeSet::new();
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
                if let Some(guard) = discovery {
                    let observed = match &fact.fact {
                        Fact::ModelObserved {
                            attempt,
                            part: ModelPart::ToolCall { call },
                            ..
                        } if call.provider_executed => {
                            provider_calls.insert(ToolKey {
                                attempt: *attempt,
                                call: call.id.clone(),
                            });
                            None
                        }
                        Fact::ModelObserved {
                            attempt,
                            part:
                                ModelPart::ToolResult {
                                    id,
                                    output,
                                    is_error,
                                    ..
                                },
                            ..
                        } => Some((
                            ToolKey {
                                attempt: *attempt,
                                call: id.clone(),
                            },
                            if *is_error {
                                Settlement::Failed
                            } else {
                                Settlement::Provider(output)
                            },
                        )),
                        Fact::ToolResultAccepted {
                            tool,
                            result,
                            outcome,
                        } if !provider_calls.contains(tool) => Some((
                            tool.clone(),
                            if *outcome == AcceptedResult::Succeeded {
                                Settlement::Accepted(result)
                            } else {
                                Settlement::Failed
                            },
                        )),
                        _ => None,
                    };
                    if let Some((key, settlement)) = observed {
                        original.discovery_last_results.insert(key.attempt, fact.id);
                        if !guard.lock().unwrap().recorded(after) {
                            let observation = self
                                .discovery_tool_observation(reader, view, after, &key, settlement)
                                .await?;
                            guard.lock().unwrap().observe(
                                after,
                                observation,
                                Some(fact.id),
                                view.spec.language,
                            );
                        }
                    }
                }
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
                        // A retry may repeat an already known child return under a later fact revision.
                        let new_child_result = match event {
                            CellEvent::ChildResultRecorded { operation, .. }
                            | CellEvent::LocalChildReturned { operation, .. }
                                if discovery.is_some()
                                    && !cells
                                        .get(&cell)
                                        .and_then(|c| c.children.get(operation))
                                        .is_some_and(CellChild::known_success) =>
                            {
                                Some(operation)
                            }
                            _ => None,
                        };
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
                        if let Some(guard) = discovery
                            && !guard.lock().unwrap().recorded(after)
                            && let Some(operation) = new_child_result
                            && let Some(child) =
                                cells.get(&cell).and_then(|c| c.children.get(operation))
                            && child.known_success()
                        {
                            let observation = child_observation(reader, view, child).await?;
                            guard.lock().unwrap().observe(
                                after,
                                observation,
                                None,
                                view.spec.language,
                            );
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
                    if let Some(guard) = discovery {
                        guard.lock().unwrap().begin(after, step);
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
        if let Some(guard) = discovery {
            guard.lock().unwrap().mark_replayed(view.revision);
        }
        original.cells.append(&mut recovered);
        Ok(original)
    }
}

async fn child_observation(
    reader: &HistorySource<'_>,
    view: &RunView,
    child: &CellChild,
) -> Result<Observation, RunError> {
    let args = reader.decode(view.run, &child.input).await?;
    let mut observation = Observation::success(
        &child.name,
        Some(&args),
        std::path::Path::new(&view.spec.workspace),
    );
    if observation.needs_evidence(&child.name) {
        use maka_agent_facts::{
            artifact::ToolReturn, cells::StoredCellReturn, tool_output::ToolOutput,
        };
        let result = child
            .local_result
            .as_ref()
            .or(child.provider_result.as_ref())
            .expect("successful child");
        let returned: ToolReturn<StoredCellReturn> =
            reader.decode(view.run, &result.result).await?;
        returned
            .validate()
            .map_err(|e| RunError::InvalidInput(e.into()))?;
        let output = match returned.body {
            StoredCellReturn::Inline(body) => body.output,
            StoredCellReturn::Operation(body) => ToolOutput::Operation(Box::new(
                reader.operation_reply(view.run, &body.operation).await?,
            )),
        };
        observation = tokio::task::spawn_blocking(move || {
            output
                .into_code_value()
                .map(|value| observation.with_value(&value))
        })
        .await
        .map_err(|e| RunError::Internal(e.to_string()))?
        .map_err(RunError::InvalidInput)?;
    }
    Ok(observation)
}
