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

//! Model decisions commit through the graph repository and original WorkHub tasks.
use super::*;
use maka_graph::{
    decision::Decision,
    schedule::{HistoricalInput, Source, Stop, Target as GraphTarget},
};
use maka_tool_catalog::input::ToolRequest;

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Routing {
    Worker {
        worker: String,
        title: String,
        workspace: crate::contract::DirectorySelection,
        #[serde(default)]
        isolated_workspace: bool,
        tools: Option<Vec<String>>,
        model: Option<crate::ModelSelection>,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
        executor: Option<maka_agent_api::executor::Selection>,
    },
    Preset {
        preset: String,
        title: String,
        workspace: crate::contract::DirectorySelection,
    },
    Operator {
        work_id: WorkId,
    },
}
impl Routing {
    fn target(&self, schedule: &Schedule) -> Result<GraphTarget, String> {
        Ok(match self {
            Self::Worker {
                worker,
                executor: Some(executor),
                ..
            } => GraphTarget::Executor {
                executor_id: format!("{worker}:{}", executor.executor),
            },
            Self::Worker { worker, .. } => GraphTarget::Agent {
                agent_id: worker.clone(),
            },
            Self::Preset { preset, .. } => GraphTarget::Preset {
                preset_id: preset.clone(),
            },
            Self::Operator { work_id } => GraphTarget::Operator {
                operator_id: match &schedule
                    .work
                    .get(work_id)
                    .ok_or("graph_operator_missing")?
                    .work
                    .target
                {
                    GraphTarget::Operator { operator_id } => operator_id.clone(),
                    _ => maka_graph::coordinator::operator_id_for(&schedule.epoch, work_id),
                },
            },
        })
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewWork {
    target: Routing,
    #[schemars(length(min = 1))]
    instruction: String,
    #[serde(default)]
    input_ids: Vec<String>,
    #[serde(default)]
    selected_result_inputs: Vec<HistoricalInput>,
    replaces: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum UpdateInput {
    AddWork {
        #[schemars(length(min = 1))]
        work: Vec<NewWork>,
    },
    Stop {
        #[schemars(length(min = 1))]
        targets: Vec<Stop>,
    },
    Finish {
        #[schemars(length(min = 1))]
        result_ids: Vec<String>,
        reason: String,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ReadInput {
    Status {
        graph_id: Option<GraphId>,
        after: Option<WorkId>,
    },
    Work {
        graph_id: GraphId,
        work_id: WorkId,
    },
    Result {
        graph_id: GraphId,
        work_id: WorkId,
        result_id: String,
        offset: u64,
    },
    History {
        before: Option<u64>,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum CatalogInput {
    Workers,
    Presets,
    Tools {
        worker: String,
    },
    Executors {
        worker: String,
    },
    Directories {
        worker: String,
        location: crate::contract::Directories,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub(in crate::workhub::tasks) fn registrations(link: Link) -> Vec<ToolRegistration> {
    let handler = Arc::new(GraphTool(link));
    [
        ("agent_list", "List explicitly bound workers, presets, worker tools, executors and published directory selections. Workers includes the supervisor's current versioned model selection; workers validate copied selections. Graph targets use these exact published choices.", schemars::schema_for!(ToolRequest<CatalogInput>).into(), ToolSemantics::Parallel),
        ("view_agent_graph", "Read this conversation's current graph or immutable earlier epochs. Status returns at most 16 work items; continue with after. Work returns the complete instruction and input references. Result reads the original immutable terminal result; continue with nextOffset. History returns earlier epochs. Admission is not completion.", schemars::schema_for!(ToolRequest<ReadInput>).into(), ToolSemantics::Parallel),
        ("update_agent_graph", "Add, replace or stop graph work, or finish with actual terminal result IDs. Worker targets must use explicit published workspace and model or executor choices. Presets freeze their original settings. Operator targets continue an earlier work's original session only after it settles. inputIds await current graph results; selectedResultInputs must reference selected final results of earlier finished epochs. Finish selects terminal results, including failures, and ends this epoch. After a missing reply, inspect the original graph work; a replacement is a separate explicit decision.", schemars::schema_for!(ToolRequest<UpdateInput>).into(), ToolSemantics::ExclusiveStep),
        ("yield_agent_graph", "End this supervisor turn and await durable worker outcomes. Graph resumes on durable outcomes. Swarm resumes on attention or when the whole active batch settles, not each successful sibling.", schemars::schema_for!(Empty).into(), ToolSemantics::FinishTurn),
        ("agent_swarm_status", "Read this conversation's swarm status and current work. Use view_agent_graph for additional work/result/history pages.", schemars::schema_for!(Empty).into(), ToolSemantics::Parallel),
    ].into_iter().map(|(name, description, input_schema, semantics)| ToolRegistration {
        definition: ToolDefinition { provider: None, name: name.into(), description: description.into(), input_schema, output_schema: None, freeform: None },
        nesting: ToolNesting::DirectOnly, semantics,
        handler: ToolHandler::Prepared(handler.clone()),
    }).collect()
}
struct GraphTool(Link);
impl ToolPreparer for GraphTool {
    fn names(&self) -> Vec<String> {
        NAMES.iter().map(|name| (*name).into()).collect()
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let hub = self.0.get().and_then(Weak::upgrade);
        Box::pin(async move {
            let hub = hub
                .filter(|_| NAMES.contains(&name.as_str()))
                .ok_or(ToolRejection::Unavailable)?;
            let epoch = hub
                .agent
                .0
                .graph_invocation(&context.invocation)
                .await
                .map_err(|_| ToolRejection::Unavailable)?;
            hub.coordinator_source(&context)
                .await
                .map_err(|_| ToolRejection::Unavailable)?;
            Ok(PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    hub.graph_tool(&name, input, context, epoch, cancel)
                        .await
                        .map(Into::into)
                        .map_err(|error| {
                            if hub.tasks.cleanup_failed() {
                                ToolError::CleanupUnconfirmed(error)
                            } else {
                                ToolError::OutcomeUnknown(error)
                            }
                        })
                })
            }))
        })
    }
}
impl Hub {
    async fn graph_tool(
        &self,
        name: &str,
        input: Value,
        context: ToolCallContext,
        epoch: Epoch,
        stop: CancellationToken,
    ) -> Result<Value, String> {
        if stop.is_cancelled() || self.tasks.cleanup_failed() {
            return Err("graph_closed".into());
        }
        let graphs = &self.tasks.graphs;
        match name {
            "agent_list" => {
                let input = match serde_json::from_value::<ToolRequest<CatalogInput>>(input)
                    .map_err(error)?
                    .request
                {
                    CatalogInput::Workers => {
                        let model = self.agent.0.graph_model_choice(&context.invocation).await?;
                        let mut value = self.tasks_input(Input::Workers, context, stop).await?;
                        value["supervisorModel"] = model;
                        return Ok(value);
                    }
                    CatalogInput::Presets => Input::Presets,
                    CatalogInput::Tools { worker } => Input::Tools { worker },
                    CatalogInput::Executors { worker } => Input::Executors { worker },
                    CatalogInput::Directories { worker, location } => {
                        Input::Directories { worker, location }
                    }
                };
                self.tasks_input(input, context, stop).await
            }
            "view_agent_graph" => {
                match serde_json::from_value::<ToolRequest<ReadInput>>(input)
                    .map_err(error)?
                    .request
                {
                    ReadInput::Status { graph_id, after } => serde_json::to_value(
                        graphs
                            .view(
                                self,
                                api::Read {
                                    session_id: epoch.root_session_id,
                                    graph_id,
                                    after,
                                },
                                stop,
                            )
                            .await?,
                    )
                    .map_err(error),
                    ReadInput::Work { graph_id, work_id } => serde_json::to_value(
                        graphs
                            .repository()?
                            .work(&epoch.root_session_id, &graph_id, &work_id)
                            .await
                            .map_err(error)?
                            .ok_or("graph_work_missing")?,
                    )
                    .map_err(error),
                    ReadInput::Result {
                        graph_id,
                        work_id,
                        result_id,
                        offset,
                    } => serde_json::to_value(
                        graphs
                            .result(
                                self,
                                api::ResultRead {
                                    session_id: epoch.root_session_id,
                                    graph_id,
                                    work_id,
                                    result_id,
                                    offset,
                                },
                                stop,
                            )
                            .await?,
                    )
                    .map_err(error),
                    ReadInput::History { before } => {
                        let page = graphs
                            .repository()?
                            .epochs(&epoch.root_session_id, before)
                            .await
                            .map_err(error)?;
                        serde_json::to_value(api::History {
                            epochs: page.epochs,
                            current_epoch: page.current_epoch,
                            next_before: page.next_before,
                        })
                        .map_err(error)
                    }
                }
            }
            "agent_swarm_status" | "yield_agent_graph" => {
                serde_json::from_value::<Empty>(input).map_err(error)?;
                if name == "agent_swarm_status" && epoch.mode != maka_graph::Mode::Swarm {
                    return Err("graph_swarm_required".into());
                }
                serde_json::to_value(
                    graphs
                        .view(
                            self,
                            api::Read {
                                session_id: epoch.root_session_id,
                                graph_id: Some(epoch.graph_id),
                                after: None,
                            },
                            stop,
                        )
                        .await?,
                )
                .map_err(error)
            }
            "update_agent_graph" => {
                self.graph_decide(
                    serde_json::from_value::<ToolRequest<UpdateInput>>(input)
                        .map_err(error)?
                        .request,
                    context,
                    epoch,
                    stop,
                )
                .await
            }
            _ => Err("graph_tool_unavailable".into()),
        }
    }
    async fn graph_decide(
        &self,
        input: UpdateInput,
        context: ToolCallContext,
        epoch: Epoch,
        stop: CancellationToken,
    ) -> Result<Value, String> {
        let graphs = &self.tasks.graphs;
        let _gate = graphs.gate.lock().await;
        let control = graphs
            .repository()?
            .control(&epoch.root_session_id, &epoch.graph_id)
            .await
            .map_err(error)?;
        let mut schedule = graphs.schedule(&control).await?;
        let mut routes = vec![];
        let decision = match input {
            UpdateInput::AddWork { work } => {
                let mut definitions = vec![];
                for work in work {
                    definitions.push(maka_graph::decision::NewWork {
                        target: work.target.target(&schedule)?,
                        instruction: work.instruction,
                        input_ids: work.input_ids,
                        selected_result_inputs: work.selected_result_inputs,
                        replaces: work.replaces,
                    });
                    routes.push(work.target);
                }
                Decision::AddWork { work: definitions }
            }
            UpdateInput::Stop { targets } => Decision::Stop { targets },
            UpdateInput::Finish { result_ids, reason } => Decision::Finish { result_ids, reason },
        };
        let update = decision
            .update(
                epoch.graph_id.clone(),
                Source {
                    invocation: context.invocation.clone(),
                    operation_id: context.operation_id.clone(),
                },
            )
            .map_err(error)?;
        if let Some(original) = graphs
            .repository()?
            .recorded_update(&update)
            .await
            .map_err(error)?
        {
            for (work, route) in original.update.add_work.iter().zip(&routes) {
                let task = self
                    .assignment(&graph_task_id(&epoch.graph_id, &work.work_id))
                    .await?;
                if task.graph.as_ref().map(|g| &g.route)
                    != Some(&serde_json::to_value(route).map_err(error)?)
                {
                    return Err("graph_route_replay_conflict".into());
                }
            }
            return serde_json::to_value(original).map_err(error);
        }
        if self.agent.0.graph_invocation(&context.invocation).await? != epoch {
            return Err("graph_epoch_changed".into());
        }
        let observed = graphs.observations(self, &schedule, stop.clone()).await?;
        if let Some(finish) = &update.finish
            && finish.result_ids.iter().any(|id| {
                !observed
                    .iter()
                    .any(|item| item.result_id.as_ref() == Some(id))
            })
        {
            return Err("graph_final_result_missing".into());
        }
        let candidate = maka_graph::schedule::CommittedUpdate {
            update: update.clone(),
            revision: schedule.revision + 1,
            committed_at: maka_agent_authority::now(),
        };
        schedule.apply(&candidate).map_err(error)?;
        let authority = self.agent.0.graph_target(&context.invocation).await?;
        let mut mutations = vec![];
        let mut summaries = vec![];
        for (work, routing) in update.add_work.iter().zip(routes) {
            let route_value = serde_json::to_value(&routing).map_err(error)?;
            let route = self
                .graph_route(routing, &work.instruction, &epoch, &observed)
                .await?;
            let id = graph_task_id(&epoch.graph_id, &work.work_id);
            let (assignment, title) = self
                .prepare_assignment(
                    &context,
                    &id,
                    route,
                    Some(TaskSource {
                        graph_id: epoch.graph_id.clone(),
                        work_id: work.work_id.clone(),
                        authority: authority.clone(),
                        route: route_value,
                    }),
                )
                .await?;
            summaries.push((id.clone(), assignment.worker.clone(), title));
            mutations.push(Mutation {
                key: self.task_key(&id)?,
                expected_revision: None,
                data: Data::Present(serde_json::to_value(assignment).map_err(error)?),
            });
        }
        if stop.is_cancelled() {
            return Err("graph_cancelled".into());
        }
        let accepted_at = maka_agent_authority::now();
        if !summaries.is_empty() {
            mutations.extend(self.task_catalog().acceptance_mutations(
                &context,
                summaries,
                accepted_at,
            )?);
        }
        graphs.written();
        let committed = graphs
            .repository()?
            .commit_update_with(update, control.schedule_revision, accepted_at, mutations)
            .await
            .map_err(error)?;
        serde_json::to_value(committed).map_err(error)
    }
    async fn graph_route(
        &self,
        routing: Routing,
        instruction: &str,
        epoch: &Epoch,
        observed: &[Observed],
    ) -> Result<Route, String> {
        let (worker, target, model, thinking_level, executor) = match routing {
            Routing::Worker {
                worker,
                title,
                workspace,
                isolated_workspace,
                tools,
                model,
                thinking_level,
                executor,
            } => (
                worker,
                Target::New {
                    title,
                    workspace,
                    isolated_workspace,
                    tools,
                },
                model,
                thinking_level,
                executor,
            ),
            Routing::Preset {
                preset,
                title,
                workspace,
            } => {
                let (preset, model) = self.resolve_preset(&preset).await?;
                (
                    preset.worker,
                    Target::New {
                        title,
                        workspace,
                        isolated_workspace: preset.isolated_workspace,
                        tools: Some(preset.tools),
                    },
                    Some(model),
                    preset.thinking_level,
                    None,
                )
            }
            Routing::Operator { work_id } => {
                if !observed.iter().any(|item| {
                    item.work_id == work_id && item.quiescent && item.result_id.is_some()
                }) {
                    return Err("graph_operator_busy".into());
                }
                let id = graph_task_id(&epoch.graph_id, &work_id);
                let assignment = self.assignment(&id).await?;
                let delivery = self
                    .delivery(&id, &assignment)
                    .await?
                    .ok_or("graph_operator_unavailable")?;
                let model = serde_json::from_value(
                    assignment
                        .input
                        .get("model")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(error)?;
                let thinking_level = serde_json::from_value(
                    assignment
                        .input
                        .get("thinkingLevel")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(error)?;
                let executor = serde_json::from_value(
                    assignment
                        .input
                        .get("executor")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(error)?;
                (
                    assignment.worker,
                    Target::Existing {
                        session_id: delivery.session_id,
                    },
                    model,
                    thinking_level,
                    executor,
                )
            }
        };
        Ok(Route {
            dependencies: vec![],
            worker,
            target,
            note: instruction.into(),
            model,
            thinking_level,
            executor,
        })
    }
}
