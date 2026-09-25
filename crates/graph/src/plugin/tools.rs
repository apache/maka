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

use crate::{decision::Decision, owner::Handle, schedule::Source};
use maka_plugins::contributions::Staged;
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{PreparationFuture, PreparedEffect, ToolCallContext, ToolError, ToolPreparer},
};
use maka_tool_catalog::{
    ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
    plugins::{Binding, BindingProvider, BindingRequest, PluginTool},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const NAMES: [&str; 5] = [
    "agent_swarm_status",
    "agent_list",
    "view_agent_graph",
    "update_agent_graph",
    "yield_agent_graph",
];
pub(super) fn register(staged: &mut Staged, manager: Arc<super::Manager>) -> Result<(), String> {
    let handler = Arc::new(Unbound);
    let binding: Arc<dyn BindingProvider> = Arc::new(GraphBinding(manager));
    for (name, description, input_schema, semantics) in [
        (
            "agent_swarm_status",
            "Read compact Swarm statuses and committed final-result IDs, never child logs or partial output. Counts cover all work; follow nextAfter with after to page items.",
            schemars::schema_for!(StatusInput).into(),
            ToolSemantics::Parallel,
        ),
        (
            "agent_list",
            "List agents, presets and executors for new Graph work. Copy an available entry's target verbatim into update_agent_graph work; do not infer IDs from display names. Agent targets inherit the parent's backend; presets choose their configured model; executor targets use the named plugin backend.",
            schemars::schema_for!(Empty).into(),
            ToolSemantics::Parallel,
        ),
        (
            "view_agent_graph",
            "Inspect Graph work, outcomes, waits and errors. Empty input returns a bounded preview. Use kind: epochs to discover history, then kind: snapshot with graphId and after/nextAfter to enumerate all work and final-result IDs. kind: work reads full instructions. To read a result, pass work_id and record_id; part: patch reads an immutable Git patch without merging. Follow nextOffset as a UTF-8 byte offset; graph_id selects history.",
            schemars::schema_for!(ViewInput).into(),
            ToolSemantics::Parallel,
        ),
        (
            "update_agent_graph",
            "Commit a Graph decision: add work, stop work/operators, or select final result records. New work runs in independent Host-owned Sessions; input IDs refer to durable records, not work IDs.",
            schemars::schema_for!(Decision).into(),
            ToolSemantics::ExclusiveStep,
        ),
        (
            "yield_agent_graph",
            "Finish this supervisor turn after its tool result is durable. The Graph will wake you when new results or failures arrive; already accepted work continues.",
            schemars::schema_for!(Empty).into(),
            ToolSemantics::FinishTurn,
        ),
    ] {
        let tool = PluginTool::new(ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: name.into(),
                description: description.into(),
                input_schema,
            },
            nesting: ToolNesting::DirectOnly,
            semantics,
            handler: ToolHandler::Prepared(handler.clone()),
        })
        .map_err(|error| error.to_string())?
        .with_binding(binding.clone());
        staged
            .insert(name, tool)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

struct Unbound;
impl ToolPreparer for Unbound {
    fn names(&self) -> Vec<String> {
        NAMES.iter().map(|name| (*name).into()).collect()
    }
    fn prepare(
        &self,
        _: String,
        _: Value,
        _: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        Box::pin(async { Err(ToolRejection::Unavailable) })
    }
}
struct GraphBinding(Arc<super::Manager>);
impl BindingProvider for GraphBinding {
    fn bind(
        &self,
        request: BindingRequest,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Option<Binding>, ToolError>> + Send>> {
        let manager = self.0.clone();
        Box::pin(async move {
            let slot = manager
                .roots
                .lock()
                .unwrap()
                .get(&request.invocation.session_id)
                .cloned();
            let Some(slot) = slot else { return Ok(None) };
            let root = slot.lock().await;
            let Some(root) = root.as_ref().filter(|root| !root.cancel.is_cancelled()) else {
                return Ok(None);
            };
            root.commands
                .session(request.invocation.session_id.clone())
                .await
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            Ok(Some(Binding {
                provider_tools: Default::default(),
                handler: Some(Arc::new(GraphTools(
                    root.handle.clone(),
                    root.operators.clone(),
                ))),
                context: None,
            }))
        })
    }
}

struct GraphTools(Handle, Arc<super::NativeOperators>);
enum Action {
    Status(StatusInput),
    Query(super::read::Query),
    Agents,
    View,
    Result(ResultQuery),
    Update(Decision),
    Yield,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
enum ViewInput {
    Query(super::read::Query),
    Result(ResultQuery),
    Snapshot(Empty),
}
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct StatusInput {
    after: Option<crate::WorkId>,
}
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ResultQuery {
    /// Read the answer (default) or the implementation workspace's immutable Git patch.
    #[serde(default)]
    part: super::read::result::Part,
    graph_id: Option<crate::GraphId>,
    work_id: crate::WorkId,
    #[schemars(length(min = 1, max = 256))]
    record_id: String,
    #[serde(default)]
    offset: usize,
}
impl ToolPreparer for GraphTools {
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
        let handle = self.0.clone();
        let operators = self.1.clone();
        Box::pin(async move {
            if context.invocation.session_id != handle.snapshot().snapshot.root_session_id {
                return Err(ToolRejection::Unavailable);
            }
            let action = match name.as_str() {
                "agent_swarm_status" if handle.snapshot().swarm.is_some() => {
                    Action::Status(serde_json::from_value(input).map_err(|error| {
                        ToolRejection::InvalidInput {
                            message: error.to_string(),
                        }
                    })?)
                }
                "agent_list" => Action::Agents,
                "view_agent_graph" => {
                    match serde_json::from_value::<ViewInput>(input).map_err(|error| {
                        ToolRejection::InvalidInput {
                            message: error.to_string(),
                        }
                    })? {
                        ViewInput::Snapshot(_) => Action::View,
                        ViewInput::Result(query) => Action::Result(query),
                        ViewInput::Query(query) => Action::Query(query),
                    }
                }
                "yield_agent_graph" => Action::Yield,
                "update_agent_graph" => {
                    Action::Update(serde_json::from_value(input).map_err(|error| {
                        ToolRejection::InvalidInput {
                            message: error.to_string(),
                        }
                    })?)
                }
                _ => return Err(ToolRejection::Unavailable),
            };
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(ToolError::Failed("call cancelled before execution".into()));
                    }
                    let value = match action {
                        Action::Status(input) => {
                            let view = handle.snapshot();
                            let swarm = view
                                .swarm
                                .as_ref()
                                .ok_or_else(|| ToolError::Failed("not a Swarm epoch".into()))?;
                            serde_json::to_value(swarm.page(input.after.as_ref()))
                                .map_err(|error| ToolError::Failed(error.to_string()))?
                        }
                        Action::Query(query) => {
                            let view = handle.snapshot();
                            serde_json::to_value(
                                super::read::query(
                                    super::read::Source {
                                        commands: operators.commands.as_ref(),
                                        storage: operators.storage.as_ref(),
                                        repository: &operators.repository,
                                    },
                                    &view.snapshot.root_session_id,
                                    query,
                                )
                                .await
                                .map_err(|error| ToolError::Failed(error.to_string()))?,
                            )
                            .map_err(|error| ToolError::Failed(error.to_string()))?
                        }
                        Action::Agents => serde_json::to_value(
                            operators
                                .definitions
                                .list()
                                .await
                                .map_err(ToolError::Failed)?,
                        )
                        .map_err(|e| ToolError::Failed(e.to_string()))?,
                        Action::View | Action::Yield => {
                            let view = handle.snapshot();
                            if let Some(swarm) = &view.swarm {
                                json!({"swarm":swarm.page(None),"error":view.error,"initializing":!view.initialized})
                            } else {
                                json!({"graph": view.snapshot, "error":view.error, "initializing":!view.initialized})
                            }
                        }
                        Action::Result(query) => {
                            let view = handle.snapshot();
                            let result = super::read::result::page(
                                super::read::Source {
                                    commands: operators.commands.as_ref(),
                                    storage: operators.storage.as_ref(),
                                    repository: &operators.repository,
                                },
                                &view.snapshot.root_session_id,
                                query.graph_id.as_ref().unwrap_or(&view.snapshot.graph_id),
                                &query.work_id,
                                &query.record_id,
                                query.offset,
                                query.part,
                            )
                            .await
                            .map_err(|e| ToolError::Failed(e.to_string()))?;
                            json!({"result":result})
                        }
                        Action::Update(decision) => {
                            let revision = handle
                                .update(
                                    decision,
                                    Source {
                                        invocation: context.invocation,
                                        operation_id: context.operation_id,
                                    },
                                )
                                .await
                                .map_err(graph_error)?;
                            json!({"committed":true,"revision":revision})
                        }
                    };
                    Ok(value.into())
                })
            }))
        })
    }
}

fn graph_error(error: crate::Error) -> ToolError {
    match error {
        crate::Error::OutcomeUnknown(message)
        | crate::Error::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(message))
        | crate::Error::Host(maka_plugins::execution::CommandError::OutcomeUnknown(message)) => {
            ToolError::OutcomeUnknown(message)
        }
        error => ToolError::Failed(error.to_string()),
    }
}
