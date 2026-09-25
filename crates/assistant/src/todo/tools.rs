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

use super::{Document, Item, Repository, message};
use futures_util::future::BoxFuture;
use maka_plugins::contributions::Staged;
use maka_runtime::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolError, ToolHandler,
        ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_tool_catalog::plugins::PluginTool;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Action {
    Read,
    Write,
}
impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Read => "todo_read",
            Self::Write => "todo_write",
        }
    }
}
struct Tool {
    repository: Arc<Repository>,
    action: Action,
}

pub(super) fn publish(repository: Arc<Repository>, staged: &mut Staged) -> Result<(), String> {
    for action in [Action::Read, Action::Write] {
        let (description, input_schema) = match action {
            Action::Read => (
                "Read the complete current Session checklist. Completed items are model-reported progress, not verified execution evidence.",
                schemars::schema_for!(Read).into(),
            ),
            Action::Write => (
                "Atomically replace the complete current Session checklist; include every item to keep. At most 200 items, each 1–200 characters. Completed is model-reported progress, not verified execution evidence.",
                schemars::schema_for!(Write).into(),
            ),
        };
        staged
            .insert(
                action.name(),
                PluginTool::new(ToolRegistration {
                    definition: ToolDefinition {
                        freeform: None,
                        output_schema: None,
                        provider: None,
                        name: action.name().into(),
                        description: description.into(),
                        input_schema,
                    },
                    nesting: ToolNesting::Nestable,
                    semantics: ToolSemantics::Parallel,
                    handler: ToolHandler::Prepared(Arc::new(Tool {
                        repository: repository.clone(),
                        action,
                    })),
                })
                .map_err(message)?,
            )
            .map_err(message)?;
    }
    Ok(())
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Write {
    #[schemars(length(max = super::MAX_ITEMS))]
    todos: Vec<Item>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Read {}

impl ToolPreparer for Tool {
    fn names(&self) -> Vec<String> {
        vec![self.action.name().into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let repository = self.repository.clone();
        let action = self.action;
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            if name != action.name() {
                return Err(ToolRejection::Unavailable);
            }
            let replacement = match action {
                Action::Read => {
                    serde_json::from_value::<Read>(input).map_err(invalid)?;
                    None
                }
                Action::Write => {
                    let input: Write = serde_json::from_value(input).map_err(invalid)?;
                    Some(Document::normalize(input.todos).map_err(invalid)?)
                }
            };
            let session = context.invocation.session_id;
            // Pin the revision before dispatch. Concurrent replacement must fail,
            // never silently overwrite a document this call did not observe.
            let expected = repository
                .read(&session)
                .await
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?
                .revision;
            Ok(PreparedEffect::new(move |_| -> BoxFuture<'static, _> {
                Box::pin(async move {
                    let document = match replacement {
                        Some(document) => {
                            repository
                                .replace(&session, expected, &document)
                                .await
                                .map_err(storage)?;
                            document
                        }
                        None => repository.read(&session).await.map_err(failed)?.document,
                    };
                    let text = document.render();
                    Ok(ToolSuccess::projected(
                        ToolOutput::Json(serde_json::to_value(document).map_err(failed)?),
                        DurableToolProjection::Text { text },
                    ))
                })
            }))
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> ToolRejection {
    ToolRejection::InvalidInput {
        message: error.to_string(),
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn storage(error: maka_plugins::storage::StoreError) -> ToolError {
    match error {
        maka_plugins::storage::StoreError::OutcomeUnknown(message) => {
            ToolError::OutcomeUnknown(message)
        }
        other => failed(other),
    }
}
