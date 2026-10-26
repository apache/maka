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
use maka_agent_facts::{tool_call::ToolRejection, tool_output::ToolOutput, tools::*};
use maka_assistant::plan::{Artifact, Progress};
use maka_tools::request::{BindingFuture, BindingRequest, BoundTool, RequestBinding};

const SUBMIT: &str = "Submit the finished Plan for user approval and end this planning Turn. This does not approve or start execution.";
const UPDATE: &str = "Report progress for this exact approved Plan execution. Include every step using its exact ID, with at most one in_progress. Completion is recorded only after execution succeeds.";
const CANCEL: &str = "Request cancellation of this Plan when the user explicitly asks to abandon it. Ends this Turn; only the original Plan execution is stopped.";
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
impl Plans {
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        [
            (
                "SubmitPlan",
                SUBMIT,
                serde_json::to_value(schemars::schema_for!(Artifact)).expect("Plan schema"),
            ),
            (
                "update_plan",
                UPDATE,
                serde_json::to_value(schemars::schema_for!(Update)).expect("Plan schema"),
            ),
            (
                "cancel_plan",
                CANCEL,
                serde_json::to_value(schemars::schema_for!(Cancel)).expect("Plan schema"),
            ),
        ]
        .into_iter()
        .map(|(name, description, input_schema)| ToolRegistration {
            definition: ToolDefinition {
                provider: None,
                name: name.into(),
                description: description.into(),
                input_schema,
                output_schema: None,
                freeform: None,
            },
            nesting: if name == "update_plan" {
                ToolNesting::Nestable
            } else {
                ToolNesting::DirectOnly
            },
            semantics: if name == "update_plan" {
                ToolSemantics::ExclusiveStep
            } else {
                ToolSemantics::FinishTurn
            },
            handler: ToolHandler::Prepared(self.clone()),
        })
        .collect()
    }
}
impl RequestBinding for Plans {
    fn bind(&self, request: BindingRequest) -> BindingFuture {
        let owner = self.owner.get().and_then(Weak::upgrade);
        Box::pin(async move {
            let owner = owner.ok_or_else(|| failed("Plan unavailable"))?;
            if request.cancellation.is_cancelled() {
                return Err(failed("Plan cancelled"));
            }
            let snapshot = owner
                .plans
                .repository(&request.invocation.session_id)
                .map_err(failed)?
                .current()
                .await
                .map_err(failed)?;
            request.tools.into_iter().map(|name| {
                let description = match name.as_str() {
                    "SubmitPlan" => SUBMIT.into(),
                    "cancel_plan" => CANCEL.into(),
                    _ => format!("{UPDATE}\nCurrent Plan state for this model step:\n{}", serde_json::to_string(&snapshot.execution.as_ref().map(|execution| serde_json::json!({
                        "executionId":execution.id, "proposalId":execution.proposal_id, "progress":execution.steps,
                        "cancellationRequested":execution.cancellation.is_some()
                    }))).map_err(failed)?),
                };
                Ok((name, BoundTool::Described { handler: owner.plans.clone(), description }))
            }).collect()
        })
    }
}
impl ToolPreparer for Plans {
    fn names(&self) -> Vec<String> {
        ["SubmitPlan", "update_plan", "cancel_plan"]
            .map(str::to_owned)
            .into()
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.owner.get().and_then(Weak::upgrade);
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            let input = match name.as_str() {
                "SubmitPlan" => {
                    let artifact: Artifact = serde_json::from_value(input).map_err(invalid)?;
                    artifact.validate().map_err(invalid)?;
                    Input::Propose(artifact)
                }
                "update_plan" => Input::Progress(
                    serde_json::from_value::<Update>(input)
                        .map_err(invalid)?
                        .steps,
                ),
                "cancel_plan" => Input::Cancel(
                    serde_json::from_value::<Cancel>(input)
                        .map_err(invalid)?
                        .reason,
                ),
                _ => return Err(ToolRejection::Unavailable),
            };
            let observed = {
                let _gate = owner.plans.gate.lock().await;
                owner
                    .check_plan_invocation(&context, matches!(input, Input::Propose(_)))
                    .await
                    .map_err(|message| ToolRejection::PreparationFailed { message })?
            };
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(failed("Plan call cancelled"));
                    }
                    let runs = owner.runs.lock().await;
                    if runs.closing {
                        return Err(failed("Plan unavailable"));
                    }
                    let captured = owner.clone();
                    let job = owner.workers.spawn(async move {
                        let _gate = captured.plans.gate.lock().await;
                        let snapshot = captured
                            .check_plan_invocation(&context, matches!(input, Input::Propose(_)))
                            .await
                            .map_err(failed)?;
                        if snapshot.revision != observed.revision {
                            return Err(failed("Plan changed before tool execution"));
                        }
                        let command = match input {
                            Input::Propose(artifact) => Command::Propose {
                                turn_id: context.invocation.turn_id.clone(),
                                artifact,
                            },
                            Input::Progress(steps) => {
                                let execution = snapshot
                                    .execution
                                    .as_ref()
                                    .ok_or_else(|| failed("Plan execution missing"))?;
                                Command::Progress {
                                    execution_id: execution.id.clone(),
                                    invocation: dispatch::invocation(&execution.request),
                                    steps,
                                }
                            }
                            Input::Cancel(reason) => Command::Cancel {
                                execution_id: snapshot
                                    .execution
                                    .as_ref()
                                    .ok_or_else(|| failed("Plan execution missing"))?
                                    .id
                                    .clone(),
                                reason,
                                grant: None,
                            },
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
                        let next = captured
                            .plans
                            .repository(&context.invocation.session_id)
                            .map_err(failed)?
                            .apply(&request, now())
                            .await
                            .map_err(|error| match error {
                                Error::Storage(
                                    maka_capabilities::storage::StoreError::OutcomeUnknown(message),
                                ) => ToolError::OutcomeUnknown(message),
                                error => failed(error),
                            })?;
                        captured.plans.written();
                        Ok(ToolOutput::Json(
                            serde_json::json!({"recorded":true,"revision":next.revision}),
                        )
                        .into())
                    });
                    drop(runs);
                    job.await
                        .map_err(|error| ToolError::OutcomeUnknown(error.to_string()))?
                })
            }))
        })
    }
}
impl Owner {
    async fn check_plan_invocation(
        &self,
        context: &ToolCallContext,
        planning: bool,
    ) -> Result<Snapshot<MessageBasis>, String> {
        if !self.settings.plans
            || self
                .tool_store(context)?
                .get::<StoredSessionConfiguration>()
                .await
                .map_err(|error| error.to_string())?
                .ok_or("agent_session_unavailable")?
                .archived
        {
            return Err("plan_unavailable".into());
        }
        let boundary = self
            .tool_store(context)?
            .invocation_boundary(
                &context.invocation.session_id,
                &context.invocation.invocation_id,
            )
            .await
            .map_err(reason)?
            .ok_or("plan_invocation_unavailable")?
            .0;
        if boundary.invocation != context.invocation
            || matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            )
        {
            return Err("plan_invocation_inactive".into());
        }
        let configuration = self
            .tool_store(context)?
            .invocation_configuration(&context.invocation)
            .await
            .map_err(reason)?
            .ok_or("plan_invocation_unavailable")?;
        let session = &context.invocation.session_id;
        let snapshot = self
            .plans
            .repository(session)?
            .current()
            .await
            .map_err(reason)?;
        if planning {
            if configuration.collaboration_mode != CollaborationMode::Plan {
                return Err("plan_requires_planning_mode".into());
            }
            return Ok(snapshot);
        }
        let execution = snapshot
            .execution
            .as_ref()
            .ok_or("plan_execution_missing")?;
        if configuration.orchestration_mode.as_str() != EXECUTION
            || boundary.root_invocation() != &dispatch::invocation(&execution.request)
            || execution.cancellation.is_some()
            || !matches!(
                execution.phase,
                Phase::AwaitingAdmission | Phase::Active { .. }
            )
        {
            return Err("plan_invocation_not_owned".into());
        }
        if matches!(execution.phase, Phase::AwaitingAdmission) {
            self.plans
                .advance(
                    session,
                    &snapshot,
                    Command::Accept {
                        execution_id: execution.id.clone(),
                        receipt: dispatch::receipt(execution)?,
                    },
                )
                .await
        } else {
            Ok(snapshot)
        }
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
