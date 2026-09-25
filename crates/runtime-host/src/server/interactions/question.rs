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

use super::Interactions;
use maka_protocol::{
    OperationError, OperationErrorCode as Code, interaction::project_question_request,
};
use maka_runtime::{
    interaction::{InteractionOutcome, InteractionQuestion},
    tool_call::ToolRejection,
    tools::ToolError,
};
use maka_tools::{
    PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolHandler, ToolNesting,
    ToolPreparer, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const NAME: &str = "AskUserQuestion";

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct QuestionInput {
    #[schemars(length(min = 1, max = 3))]
    questions: Vec<InteractionQuestion>,
}

impl Interactions {
    pub(crate) fn question_tool(self: &Arc<Self>) -> ToolRegistration {
        ToolRegistration {
            definition: ToolDefinition {
                freeform: None, output_schema: None, provider: None,
                name: NAME.into(),
                description: "Ask 1–3 bounded multiple-choice questions whose answers are required to continue the current turn. Use ordinary assistant text for open-ended follow-up.".into(),
                input_schema: schemars::schema_for!(QuestionInput).into(),
            },
            nesting: ToolNesting::DirectOnly,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(self.clone()),
        }
    }
}

impl ToolPreparer for Interactions {
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
        let owner = self.clone();
        Box::pin(async move {
            if name != NAME {
                return Err(ToolRejection::Unavailable);
            }
            let request = project_question_request(&context.tool_use_id(), &input["questions"])
                .map_err(|error| ToolRejection::InvalidInput {
                    message: error.to_string(),
                })?;
            // Canonical fields are display-projected; the tool result preserves
            // the model's original question text, paired with the canonical answers.
            let QuestionInput { questions } = serde_json::from_value::<QuestionInput>(input)
                .map_err(|error| ToolRejection::InvalidInput {
                    message: error.to_string(),
                })?;
            let effect: PreparedEffect = PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    let record = owner
                        .admit_request(context, request, &cancellation)
                        .await
                        .map_err(tool_error)?;
                    let outcome = owner
                        .wait_for_outcome(&record.request_id, &cancellation)
                        .await
                        .map_err(tool_error)?;
                    if cancellation.is_cancelled() {
                        return Err(ToolError::Failed("Question was cancelled".into()));
                    }
                    match outcome {
                        InteractionOutcome::QuestionAnswer { answers, .. } => {
                            let answers: Vec<_> = questions.into_iter().zip(answers)
                                .map(|(question, answer)| json!({"question":question.question,"answer":answer})).collect();
                            Ok(json!({"answers":answers}).into())
                        }
                        InteractionOutcome::Closure { reason, .. } => {
                            Err(ToolError::Failed(format!("Question closed: {reason:?}")))
                        }
                        InteractionOutcome::FormAnswer { .. }
                        | InteractionOutcome::PermissionsDecision { .. }
                        | InteractionOutcome::ClientCapabilityDecision { .. } => {
                            owner.shutdown.cancel();
                            Err(ToolError::Persistence(
                                "Canonical Question outcome changed kind".into(),
                            ))
                        }
                    }
                })
            });
            Ok(effect)
        })
    }
}

fn tool_error(error: OperationError) -> ToolError {
    if error.code == Code::InternalFailure {
        ToolError::Persistence(error.message)
    } else {
        ToolError::Failed(error.message)
    }
}
