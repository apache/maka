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

use super::super::{
    Artifact, Command, Error, Progress, Request,
    owner::{Owner, identity},
};
use maka_plugins::contributions::Staged;
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolError, ToolHandler,
        ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_tool_catalog::plugins::{Binding, BindingProvider, BindingRequest, PluginTool};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Action {
    Propose,
    Progress,
    Cancel,
}
impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Propose => "SubmitPlan",
            Self::Progress => "update_plan",
            Self::Cancel => "cancel_plan",
        }
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Update {
    steps: Vec<Progress>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Cancel {
    reason: String,
}
enum Input {
    Propose(Artifact),
    Progress(Vec<Progress>),
    Cancel(String),
}
#[derive(Clone)]
struct Tool {
    owner: Arc<Owner>,
    action: Action,
}

pub(super) fn publish(owner: Arc<Owner>, staged: &mut Staged) -> Result<(), String> {
    for action in [Action::Propose, Action::Progress, Action::Cancel] {
        let handler = Arc::new(Tool {
            owner: owner.clone(),
            action,
        });
        let (description, input_schema) = match action {
            Action::Propose => (
                "Submit the finished Plan for user approval and end this planning Turn. This does not approve or start execution.",
                schemars::schema_for!(Artifact).into(),
            ),
            Action::Progress => (
                "Report progress for this exact approved Plan execution. Include every step, with at most one in_progress. Completion is recorded only after Host execution succeeds.",
                schemars::schema_for!(Update).into(),
            ),
            Action::Cancel => (
                "Request cancellation of this Plan when the user explicitly asks to abandon it. Ends this Turn; Host settles only the original execution.",
                schemars::schema_for!(Cancel).into(),
            ),
        };
        let tool = PluginTool::new(ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: action.name().into(),
                description: description.into(),
                input_schema,
            },
            nesting: ToolNesting::DirectOnly,
            semantics: match action {
                Action::Progress => ToolSemantics::ExclusiveStep,
                _ => ToolSemantics::FinishTurn,
            },
            handler: ToolHandler::Prepared(handler.clone()),
        })
        .map_err(super::message)?
        .with_binding(handler)
        .always_visible();
        staged.insert(action.name(), tool).map_err(super::message)?;
    }
    Ok(())
}

impl BindingProvider for Tool {
    fn bind(
        &self,
        request: BindingRequest,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Option<Binding>, ToolError>> + Send>> {
        let expected = match self.action {
            Action::Propose => super::PLANNING,
            _ => super::EXECUTION,
        };
        let matches = request
            .behavior
            .as_ref()
            .is_some_and(|behavior| behavior.as_str() == expected);
        let handler = self.clone();
        Box::pin(async move {
            if !matches {
                return Ok(None);
            }
            let snapshot = handler
                .owner
                .repository(&request.invocation.session_id)
                .map_err(failed)?
                .current()
                .await
                .map_err(failed)?;
            let context = match handler.action {
                Action::Propose => snapshot.proposal.as_ref().map(|proposal| {
                    json!({
                        "proposalId": proposal.id,
                        "revision": proposal.revision,
                        "status": proposal.status,
                        "plan": proposal.artifact,
                    })
                }),
                Action::Progress => snapshot.execution.as_ref().map(|execution| {
                    json!({
                        "executionId": execution.id,
                        "plan": execution.artifact,
                        "progress": execution.steps,
                        "cancellationRequested": execution.cancellation.is_some(),
                    })
                }),
                Action::Cancel => None,
            }
            .map(|context| format!("Current Plan state for this model step:\n{context}"));
            Ok(Some(Binding {
                provider_tools: Default::default(),
                handler: Some(Arc::new(handler)),
                context,
            }))
        })
    }
}

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
        let owner = self.owner.clone();
        let action = self.action;
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            if name != action.name() {
                return Err(ToolRejection::Unavailable);
            }
            let input = match action {
                Action::Propose => {
                    let artifact: Artifact = serde_json::from_value(input).map_err(invalid)?;
                    artifact.validate().map_err(invalid)?;
                    Input::Propose(artifact)
                }
                Action::Progress => Input::Progress(
                    serde_json::from_value::<Update>(input)
                        .map_err(invalid)?
                        .steps,
                ),
                Action::Cancel => Input::Cancel(
                    serde_json::from_value::<Cancel>(input)
                        .map_err(invalid)?
                        .reason,
                ),
            };
            Ok(PreparedEffect::new(move |_| {
                Box::pin(async move {
                    let call = maka_plugins::call::current().ok_or_else(|| {
                        ToolError::Failed("Expected an admitted Agent call".into())
                    })?;
                    if call.identity.agent() != Some(&context.invocation) {
                        return Err(ToolError::Failed("Plan invocation identity changed".into()));
                    }
                    let commands = owner.executions.acquire(call).await?;
                    let session = &context.invocation.session_id;
                    let (snapshot, command) = match input {
                        Input::Propose(artifact) => {
                            let activity = commands.activity(session.clone()).await?;
                            if !activity.execution.is_some_and(|current| {
                                current.invocation == context.invocation
                                    && current.behavior.is_some_and(|behavior| {
                                        behavior.as_str() == super::PLANNING
                                    })
                            }) {
                                return Err(ToolError::Failed(
                                    "SubmitPlan requires an active planning behavior".into(),
                                ));
                            }
                            let snapshot = owner
                                .repository(session)
                                .map_err(failed)?
                                .current()
                                .await
                                .map_err(failed)?;
                            (
                                snapshot,
                                Command::Propose {
                                    turn_id: context.invocation.turn_id.clone(),
                                    artifact,
                                },
                            )
                        }
                        Input::Progress(steps) => {
                            let (snapshot, receipt) = owner
                                .active(commands.as_ref(), &context.invocation)
                                .await
                                .map_err(failed)?;
                            let execution_id = snapshot.execution.as_ref().unwrap().id.clone();
                            (
                                snapshot,
                                Command::Progress {
                                    execution_id,
                                    invocation: receipt.invocation,
                                    steps,
                                },
                            )
                        }
                        Input::Cancel(reason) => {
                            let (snapshot, _) = owner
                                .active(commands.as_ref(), &context.invocation)
                                .await
                                .map_err(failed)?;
                            let execution_id = snapshot.execution.as_ref().unwrap().id.clone();
                            (
                                snapshot,
                                Command::Cancel {
                                    execution_id,
                                    reason,
                                    grant: None,
                                },
                            )
                        }
                    };
                    let request = Request {
                        operation_id: identity(&(
                            &context.invocation,
                            &context.operation_id,
                            &name,
                        ))
                        .map_err(failed)?,
                        expected_revision: snapshot.revision,
                        command,
                    };
                    let snapshot = owner.apply(session, &request).await.map_err(failed)?;
                    Ok(json!({
                        "revision": snapshot.revision,
                        "proposalId": snapshot.proposal.as_ref().map(|proposal| &proposal.id),
                        "executionId": snapshot.execution.as_ref().map(|execution| &execution.id),
                        "recorded": true,
                    })
                    .into())
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
fn failed(error: Error) -> ToolError {
    match error {
        Error::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(message))
        | Error::Execution(maka_plugins::execution::CommandError::OutcomeUnknown(message)) => {
            ToolError::OutcomeUnknown(message)
        }
        other => ToolError::Failed(other.to_string()),
    }
}
