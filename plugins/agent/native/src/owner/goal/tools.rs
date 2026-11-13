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

pub(in crate::owner) const NAMES: &[&str] = &["CreateGoal", "GetGoal", "GoalStatus"];
const CREATE: &str = "Create a persistent Goal for this conversation ONLY when the user explicitly asks to create or set a Goal. Do not infer a Goal from ordinary tasks. Provide token_budget only if explicitly requested by the user. The current execution becomes its first iteration; unfinished active Goals automatically continue after a turn ends. Cannot replace an unfinished Goal.";
const READ: &str = "Read this conversation's Goal, current status, token consumption, remaining budget and elapsed time. Missing usage means consumption is a lower bound and remaining budget is unknown.";
const UPDATE: &str = "Record Goal progress or change status. Use GetGoal to read the current status and budget. achieved: objective actually accomplished, no work remains; include evidence. paused: ONLY on the user's explicit request; stop Goal work. blocked: the same blocking condition has recurred across at least three consecutive Goal turns and no meaningful progress is possible without user input or an external change. Do not block for an isolated failure, uncertainty, difficult work or a nearly exhausted budget. progress records a checkpoint and keeps pursuing. A resumed blocked Goal starts a fresh blockage audit. Cannot change budgets or resume a paused Goal.";
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
                .read(&context.execution.session_id)
                .await
                .map_err(invalid)?;
            let identity = observed.as_ref().map(|saved| saved.goal.id);
            let title = match &input {
                Input::Create(input) => maka_agent_facts::display::Text::single_line(
                    &input.objective,
                )
                .map(|objective| {
                    let objective = objective.fallback;
                    maka_agent_facts::display::Text::localized(
                        &format!("Create goal · {objective}"),
                        &format!("创建目标 · {objective}"),
                        &format!("建立目標 · {objective}"),
                    )
                }),
                _ => None,
            };
            let effect = PreparedEffect::new(move |cancellation| {
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
                        let session = &context.execution.session_id;
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
                                let id = Uuid::from_bytes(
                                    Sha256::digest(
                                        serde_json::to_vec(&(
                                            &context.execution,
                                            &context.operation_id,
                                            "CreateGoal",
                                        ))
                                        .map_err(failed)?,
                                    )[..16]
                                        .try_into()
                                        .expect("SHA-256 prefix"),
                                );
                                let view = captured
                                    .durable
                                    .frontier(root.run_id)
                                    .await
                                    .map_err(failed)?;
                                let session_config = captured
                                    .session(session)
                                    .await
                                    .map_err(failed)?
                                    .configuration;
                                if view.spec.permission_basis != session_config.permission_basis() {
                                    return Err(failed(
                                        "Conversation settings changed; create the Goal again",
                                    ));
                                }
                                if view.spec.allowed_tools.as_ref().is_some_and(|names| {
                                    !names.iter().any(|name| name == "GoalStatus")
                                }) {
                                    return Err(failed("goal_status_tool_unavailable"));
                                }
                                let maka_agent_facts::durable::BackendSpec::Model {
                                    binding,
                                    descriptor,
                                } = &view.spec.backend
                                else {
                                    return Err(failed("goal_model_required"));
                                };
                                let accepted = crate::model::AcceptedModel::from_backend(
                                    &view.spec.backend,
                                    &captured
                                        .durable
                                        .content(root.run_id, descriptor.clone())
                                        .await
                                        .map_err(failed)?,
                                )
                                .map_err(failed)?;
                                let grant = super::super::notifications::BackgroundApproval {
                                    target: ScheduledTarget {
                                        session_id: session.clone(),
                                        workspace: session_config.workspace,
                                        permissions: session_config.permissions,
                                        boundary_revision: session_config.boundary_revision,
                                        binding: session_config.binding,
                                    },
                                    model: ModelSelection {
                                        connection_id: binding.connection_id.clone(),
                                        model_id: binding.model.clone(),
                                    },
                                    thinking_level: accepted.thinking_level,
                                    accepted_model: accepted,
                                    language: view.spec.language,
                                };
                                let arm = Arm {
                                    language: grant.language,
                                    operation_id: id,
                                    objective: input.objective,
                                    grant,
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
                                        Some(Pending::Existing {
                                            run: root.run_id,
                                            managed: false,
                                        }),
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
            })
            .presented(format!("maka.agent.Builtin@1/{name}"));
            Ok(if let Some(title) = title {
                effect.titled(title)
            } else {
                effect
            })
        })
    }
}
impl Owner {
    async fn check_goal_context(
        &self,
        context: &ToolCallContext,
    ) -> Result<maka_agent_facts::durable::ExecutionIdentity, String> {
        if !self.settings.goals || self.session(&context.execution.session_id).await?.archived {
            return Err("goal_unavailable".into());
        }
        let view = self
            .durable
            .frontier(context.execution.run_id)
            .await
            .map_err(reason)?;
        if view.spec.session_id != context.execution.session_id
            || view.spec.turn_id != context.execution.turn_id
            || view.stopped
            || view.terminal.is_some()
        {
            return Err("goal_invocation_inactive".into());
        }
        Ok(context.execution.clone())
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
        maka_goal::goal::Error::Storage(maka_plugin_core::storage::StoreError::OutcomeUnknown(
            message,
        )) => ToolError::OutcomeUnknown(message),
        error => failed(error),
    }
}
