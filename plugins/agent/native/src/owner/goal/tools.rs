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
use maka_goal::goal::{Report, ReportKind};
use maka_tools::request::{BindingFuture, BindingRequest, BoundTool, RequestBinding};

pub(in crate::owner) const NAMES: &[&str] = &["CreateGoal", "GetGoal", "GoalStatus"];
const CREATE: &str = "Create a persistent Goal for this conversation ONLY when the user explicitly asks to create or set a Goal. Do not infer a Goal from ordinary tasks. Provide token_budget only if explicitly requested by the user. The current execution becomes its first iteration; unfinished active Goals automatically continue after a turn ends. Cannot replace an unfinished Goal.";
const READ: &str = "Read this conversation's Goal, current status, token consumption, remaining budget and elapsed time. Missing usage means consumption is a lower bound and remaining budget is unknown.";
const UPDATE: &str = "Record Goal progress or change status. achieved: objective actually accomplished, no work remains; include evidence. paused: ONLY on the user's explicit request; stop Goal work. blocked: the same blocking condition has recurred across at least three consecutive Goal turns and no meaningful progress is possible without user input or an external change. Do not block for an isolated failure, uncertainty, difficult work or a nearly exhausted budget. progress records a checkpoint and keeps pursuing. A resumed blocked Goal starts a fresh blockage audit. Cannot change budgets or resume a paused Goal.";
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Create {
    objective: String,
    token_budget: Option<u64>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Read {}
enum Input {
    Create(Create),
    Read,
    Report(Report),
}
fn description(name: &str) -> &'static str {
    match name {
        "CreateGoal" => CREATE,
        "GetGoal" => READ,
        _ => UPDATE,
    }
}
impl Goals {
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        NAMES
            .iter()
            .map(|&name| ToolRegistration {
                definition: ToolDefinition {
                    provider: None,
                    name: name.into(),
                    description: description(name).into(),
                    input_schema: match name {
                        "CreateGoal" => serde_json::to_value(schemars::schema_for!(Create)),
                        "GetGoal" => serde_json::to_value(schemars::schema_for!(Read)),
                        _ => serde_json::to_value(schemars::schema_for!(Report)),
                    }
                    .expect("Goal tool schema"),
                    output_schema: None,
                    freeform: None,
                },
                nesting: ToolNesting::Nestable,
                semantics: if name == "GetGoal" {
                    ToolSemantics::Parallel
                } else {
                    ToolSemantics::ExclusiveStep
                },
                handler: ToolHandler::Prepared(self.clone()),
            })
            .collect()
    }
}
impl RequestBinding for Goals {
    fn bind(&self, request: BindingRequest) -> BindingFuture {
        let owner = self.owner.get().and_then(Weak::upgrade);
        Box::pin(async move {
            let owner = owner.ok_or_else(|| failed("Goal unavailable"))?;
            let state = match owner
                .goal(GoalRead {
                    session_id: request.invocation.session_id.clone(),
                })
                .await
            {
                Ok(current) => serde_json::to_string(&current).map_err(failed)?,
                Err(error) => {
                    tracing::warn!(cause = %error, "Goal state unavailable for model request");
                    "Goal state is temporarily unavailable. GetGoal can retry the read; other work can continue.".into()
                }
            };
            request
                .tools
                .into_iter()
                .map(|name| {
                    let description = if name == "GoalStatus" {
                        format!("{UPDATE}\nCurrent Goal for this model step:\n{state}")
                    } else {
                        description(&name).into()
                    };
                    Ok((
                        name,
                        BoundTool::Described {
                            handler: owner.goals.clone(),
                            description,
                        },
                    ))
                })
                .collect()
        })
    }
}
impl ToolPreparer for Goals {
    fn names(&self) -> Vec<String> {
        NAMES.iter().map(|name| (*name).into()).collect()
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
                "CreateGoal" => Input::Create(serde_json::from_value(input).map_err(invalid)?),
                "GetGoal" => {
                    let _: Read = serde_json::from_value(input).map_err(invalid)?;
                    Input::Read
                }
                "GoalStatus" => {
                    let report: Report = serde_json::from_value(input).map_err(invalid)?;
                    if report.note.trim().is_empty() {
                        return Err(invalid("Provide a checkpoint or completion evidence"));
                    }
                    Input::Report(report)
                }
                _ => return Err(ToolRejection::Unavailable),
            };
            owner.check_goal_context(&context).await.map_err(invalid)?;
            let observed = owner
                .goals
                .repository
                .read(&context.invocation.session_id)
                .await
                .map_err(invalid)?;
            let identity = observed.as_ref().map(|saved| saved.goal.id);
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(failed("Goal call cancelled"));
                    }
                    let captured = owner.clone();
                    let job = owner.workers.spawn(async move {
                        let _gate = captured.goals.gate.lock().await;
                        let root = captured
                            .check_goal_context(&context)
                            .await
                            .map_err(failed)?;
                        let session = &context.invocation.session_id;
                        let saved = captured
                            .goals
                            .repository
                            .read(session)
                            .await
                            .map_err(failed)?;
                        if !matches!(input, Input::Read)
                            && saved.as_ref().map(|saved| saved.goal.id) != identity
                        {
                            return Err(failed(
                                "Goal changed before tool execution; read the current Goal",
                            ));
                        }
                        match input {
                            Input::Read => {}
                            Input::Create(input) => {
                                captured.goal_privacy().await.map_err(failed)?;
                                let id = Uuid::from_bytes(
                                    Sha256::digest(
                                        serde_json::to_vec(&(
                                            &context.invocation,
                                            &context.operation_id,
                                            "CreateGoal",
                                        ))
                                        .map_err(failed)?,
                                    )[..16]
                                        .try_into()
                                        .expect("SHA-256 prefix"),
                                );
                                let configuration = captured
                                    .tool_store(&context)
                                    .map_err(failed)?
                                    .invocation_configuration(&context.invocation)
                                    .await
                                    .map_err(failed)?
                                    .ok_or_else(|| failed("Goal invocation unavailable"))?;
                                let session_config = captured
                                    .session(session)
                                    .await
                                    .map_err(failed)?
                                    .configuration;
                                if configuration.boundary_revision
                                    != session_config.boundary_revision
                                {
                                    return Err(failed(
                                        "Conversation settings changed; create the Goal again",
                                    ));
                                }
                                let mut basis = captured
                                    .runs
                                    .lock()
                                    .await
                                    .controls
                                    .get(session)
                                    .filter(|control| control.invocation.turn_id == root.turn_id)
                                    .ok_or_else(|| failed("Goal execution is no longer active"))?
                                    .basis
                                    .as_ref()
                                    .clone();
                                captured.check_goal_tools(&basis).map_err(failed)?;
                                basis.background = Some(ScheduledTarget {
                                    session_id: session.clone(),
                                    workspace: basis.workspace.clone(),
                                    permissions: session_config.permissions,
                                    boundary_revision: configuration.boundary_revision,
                                    binding: basis.binding,
                                });
                                basis.background_kind = BackgroundKind::Goal(id);
                                basis.collaboration_mode = CollaborationMode::Agent;
                                let arm = Arm {
                                    language: basis.language,
                                    operation_id: id,
                                    objective: input.objective,
                                    grant: basis,
                                    token_budget: input.token_budget,
                                    start: true,
                                };
                                captured
                                    .goals
                                    .repository
                                    .arm_with(
                                        session,
                                        arm,
                                        captured.goal_meter(session).await.map_err(failed)?,
                                        Some(Pending::Existing { invocation: root }),
                                        vec![],
                                    )
                                    .await
                                    .map_err(storage_failure)?;
                                captured.goals.written();
                            }
                            Input::Report(report) => {
                                let mut saved =
                                    saved.ok_or_else(|| failed("No Goal in this conversation"))?;
                                if saved.goal.status.terminal() {
                                    return Err(failed("Goal has already ended"));
                                }
                                if matches!(report.status, ReportKind::Progress)
                                    && saved.goal.status != Status::Active
                                {
                                    return Err(failed("Only the user can resume this Goal"));
                                }
                                if observed.as_ref().map(|saved| saved.revision)
                                    != Some(saved.revision)
                                {
                                    return Err(failed(
                                        "Goal changed before status update; read it again",
                                    ));
                                }
                                saved.goal.report(report);
                                captured
                                    .goals
                                    .repository
                                    .save(saved)
                                    .await
                                    .map_err(storage_failure)?;
                                captured.goals.written();
                            }
                        }
                        let view = captured
                            .goal(GoalRead {
                                session_id: session.clone(),
                            })
                            .await
                            .map_err(failed)?;
                        Ok(ToolOutput::Json(serde_json::to_value(view).map_err(failed)?).into())
                    });
                    job.await
                        .map_err(|error| ToolError::OutcomeUnknown(error.to_string()))?
                })
            }))
        })
    }
}
impl Owner {
    async fn check_goal_context(&self, context: &ToolCallContext) -> Result<Invocation, String> {
        if !self.settings.goals
            || self
                .tool_store(context)?
                .get::<StoredSessionConfiguration>()
                .await
                .map_err(reason)?
                .ok_or("agent_session_unavailable")?
                .archived
        {
            return Err("goal_unavailable".into());
        }
        let boundary = self
            .tool_store(context)?
            .invocation_boundary(
                &context.invocation.session_id,
                &context.invocation.invocation_id,
            )
            .await
            .map_err(reason)?
            .ok_or("goal_invocation_unavailable")?
            .0;
        if boundary.invocation != context.invocation
            || matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            )
        {
            return Err("goal_invocation_inactive".into());
        }
        Ok(boundary.root_invocation().clone())
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

fn storage_failure(error: maka_goal::goal::Error) -> ToolError {
    match error {
        maka_goal::goal::Error::Storage(
            maka_capabilities::storage::StoreError::OutcomeUnknown(message),
        ) => ToolError::OutcomeUnknown(message),
        error => failed(error),
    }
}
