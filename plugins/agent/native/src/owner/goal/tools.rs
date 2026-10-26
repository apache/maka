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
use maka_goal::goal::Report;

impl Goals {
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        vec![ToolRegistration {
            definition: ToolDefinition {
                provider: None, name: "GoalStatus".into(),
                description: "Record progress or change the current user-approved Goal status: achieved requires evidence, waiting requires user input, impossible requires a reason. Takes effect after this iteration completes normally; cannot create or authorize Goals.".into(),
                input_schema: serde_json::to_value(schemars::schema_for!(Report)).expect("goal report schema"),
                output_schema: None, freeform: None,
            },
            nesting: ToolNesting::Nestable, semantics: ToolSemantics::ExclusiveStep,
            handler: ToolHandler::Prepared(self.clone()),
        }]
    }
}
impl ToolPreparer for Goals {
    fn names(&self) -> Vec<String> {
        vec!["GoalStatus".into()]
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
            if name != "GoalStatus" {
                return Err(ToolRejection::Unavailable);
            }
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            let report: Report = serde_json::from_value(input).map_err(invalid)?;
            if report.note.trim().is_empty() {
                return Err(invalid("Provide a nonempty checkpoint or evidence"));
            }
            let observed = owner
                .check_goal_invocation(&context)
                .await
                .map_err(|message| ToolRejection::PreparationFailed { message })?;
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(failed("Goal report cancelled"));
                    }
                    let runs = owner.runs.lock().await;
                    if runs.closing {
                        return Err(failed("Goal unavailable"));
                    }
                    let captured = owner.clone();
                    let job = owner.workers.spawn(async move {
                        let _gate = captured.goals.gate.lock().await;
                        let mut saved = captured
                            .check_goal_invocation(&context)
                            .await
                            .map_err(failed)?;
                        if saved.goal.id != observed.goal.id || saved.revision != observed.revision
                        {
                            return Err(failed("Goal changed before report"));
                        }
                        saved.goal.report = Some(report.clone());
                        captured.goals.repository.save(saved).await.map_err(
                            |error| match error {
                                maka_goal::goal::Error::Storage(
                                    maka_capabilities::storage::StoreError::OutcomeUnknown(message),
                                ) => ToolError::OutcomeUnknown(message),
                                error => failed(error),
                            },
                        )?;
                        captured.goals.written();
                        Ok(
                            ToolOutput::Json(serde_json::json!({"recorded":true,"report":report}))
                                .into(),
                        )
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
    async fn check_goal_invocation(
        &self,
        context: &ToolCallContext,
    ) -> Result<Saved<MessageBasis>, String> {
        if !self.settings.goals
            || self
                .tool_store(context)?
                .get::<StoredSessionConfiguration>()
                .await
                .map_err(|error| error.to_string())?
                .ok_or("agent_session_unavailable")?
                .archived
        {
            return Err("goal_unavailable".into());
        }
        let saved = self
            .goals
            .repository
            .read(&context.invocation.session_id)
            .await
            .map_err(reason)?
            .ok_or("goal_missing")?;
        if saved.goal.status != Status::Active {
            return Err("goal_inactive".into());
        }
        let pending = saved
            .goal
            .pending
            .as_ref()
            .ok_or("goal_iteration_missing")?;
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
            || boundary.root_invocation() != &dispatch::identity(&pending.request)
            || matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            )
        {
            return Err("goal_invocation_not_owned".into());
        }
        Ok(saved)
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
