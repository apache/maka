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

use super::{Manager, error};
use crate::decision::Decision;
use maka_plugins::contributions::Staged;
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{PreparationFuture, PreparedEffect, ToolCallContext, ToolError, ToolPreparer},
};
use maka_tool_catalog::{
    ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
    plugins::{Binding, BindingProvider, BindingRequest, PluginTool},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const NAME: &str = "workhub_tasks";
pub(super) fn publish(staged: &mut Staged, manager: Arc<Manager>) -> Result<(), String> {
    let tools = Arc::new(Tasks(manager));
    let tool = PluginTool::new(ToolRegistration {
        definition: ToolDefinition {
            provider: None,
            name: NAME.into(),
            description: "Coordinate approved work. Discover candidates before choosing an existing task; visibility does not grant execution access. Route preserves original user input and attachments. Returned operationId identifies this exact assignment; use it to inspect, stop, resume or correct it. Never infer completion from admission. Stop and correction cannot stop unrelated or shared execution.".into(),
            input_schema: schema(),
        },
        nesting: ToolNesting::DirectOnly,
        semantics: ToolSemantics::ExclusiveStep,
        handler: ToolHandler::Prepared(tools.clone()),
    }).map_err(error)?.with_binding(tools).always_visible();
    staged.insert(NAME, tool).map_err(error)
}
struct Tasks(Arc<Manager>);
impl BindingProvider for Tasks {
    fn bind(
        &self,
        request: BindingRequest,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Option<Binding>, ToolError>> + Send>> {
        let manager = self.0.clone();
        Box::pin(async move {
            if manager
                .coordinator
                .session_id()
                .await
                .map_err(failure)?
                .as_deref()
                != Some(&request.invocation.session_id)
            {
                return Ok(None);
            }
            Ok(Some(Binding {
                provider_tools: Default::default(),
                handler: Some(Arc::new(Tasks(manager))),
                context: None,
            }))
        })
    }
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
enum Input {
    Read(Read),
    Decision(Decision),
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Read {
    Candidates,
    Assignments {
        #[schemars(length(min = 1, max = 256))]
        after: Option<String>,
    },
    Inspect {
        #[schemars(length(min = 1, max = 256))]
        assignment_id: String,
        /// Use answer.next to continue reading the same execution's terminal answer.
        cursor: Option<maka_plugins::execution::AnswerCursor>,
    },
}
impl ToolPreparer for Tasks {
    fn names(&self) -> Vec<String> {
        vec![NAME.into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let manager = self.0.clone();
        Box::pin(async move {
            if name != NAME
                || manager
                    .coordinator
                    .session_id()
                    .await
                    .map_err(|e| ToolRejection::InvalidInput {
                        message: e.to_string(),
                    })?
                    .as_deref()
                    != Some(&context.invocation.session_id)
            {
                return Err(ToolRejection::Unavailable);
            }
            let input: Input =
                serde_json::from_value(input).map_err(|e| ToolRejection::InvalidInput {
                    message: e.to_string(),
                })?;
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(ToolError::Failed("Call cancelled before execution".into()));
                    }
                    let operation =
                        crate::repository::digest(&context.tool_use_id()).map_err(failure)?;
                    let result = match input {
                        Input::Read(Read::Candidates) => {
                            serde_json::to_value(manager.candidates().await.map_err(failure)?)
                                .map_err(failed)
                        }
                        Input::Read(Read::Assignments { after }) => serde_json::to_value(
                            manager.assignments.list(after).await.map_err(failure)?,
                        )
                        .map_err(failed),
                        Input::Read(Read::Inspect {
                            assignment_id,
                            cursor,
                        }) => serde_json::to_value(
                            manager
                                .assignments
                                .query(&assignment_id, cursor)
                                .await
                                .map_err(failure)?,
                        )
                        .map_err(failed),
                        Input::Decision(decision) => manager
                            .decide(
                                operation.clone(),
                                context.invocation,
                                decision,
                                cancellation,
                            )
                            .await
                            .map_err(failure),
                    };
                    manager.wake.notify_one();
                    Ok(json!({"operationId": operation, "result": result?}).into())
                })
            }))
        })
    }
}
fn failure(error: crate::Error) -> ToolError {
    match error {
        crate::Error::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(message))
        | crate::Error::Execution(maka_plugins::execution::CommandError::OutcomeUnknown(message)) => {
            ToolError::OutcomeUnknown(message)
        }
        error => failed(error),
    }
}
fn failed(error: impl ToString) -> ToolError {
    ToolError::Failed(error.to_string())
}

fn schema() -> Value {
    schemars::schema_for!(Input).into()
}
