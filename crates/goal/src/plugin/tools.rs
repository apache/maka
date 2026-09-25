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

use crate::{goal::Report, owner::Owner};
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolError, ToolHandler,
        ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_tool_catalog::plugins::PluginTool;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
pub(super) fn register(owner: Arc<Owner>) -> Result<PluginTool, String> {
    PluginTool::new(ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "GoalStatus".into(),
            description: "Report progress, achieved (with evidence), waiting for user input, \
                or impossible for the current Goal-owned execution. Reports apply only after \
                this execution completes normally. Do not claim success without verification. \
                This tool cannot create a Goal or grant background authority."
                .into(),
            input_schema: schemars::schema_for!(Report).into(),
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::ExclusiveStep,
        handler: ToolHandler::Prepared(Arc::new(Tool(owner))),
    })
    .map(|tool| tool.always_visible())
    .map_err(|error| error.to_string())
}
struct Tool(Arc<Owner>);
impl ToolPreparer for Tool {
    fn names(&self) -> Vec<String> {
        vec!["GoalStatus".into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        _: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.0.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            if name != "GoalStatus" {
                return Err(ToolRejection::Unavailable);
            }
            let report: Report =
                serde_json::from_value(input).map_err(|e| ToolRejection::InvalidInput {
                    message: e.to_string(),
                })?;
            Ok(PreparedEffect::new(move |_| {
                Box::pin(async move {
                    let call = maka_plugins::call::current().ok_or_else(|| {
                        ToolError::Failed("Expected an admitted Agent call".into())
                    })?;
                    let invocation = call
                        .identity
                        .agent()
                        .ok_or_else(|| ToolError::Failed("Expected an Agent invocation".into()))?;
                    let result = owner
                        .report(invocation, report)
                        .await
                        .map_err(|e| match e {
                            crate::goal::Error::Storage(
                                maka_plugins::storage::StoreError::OutcomeUnknown(_),
                            ) => ToolError::OutcomeUnknown(e.to_string()),
                            _ => ToolError::Failed(e.to_string()),
                        })?;
                    Ok(serde_json::json!({"goalId":result.id,"recorded":true,"appliesAfterSuccessfulCompletion":true}).into())
                })
            }))
        })
    }
}
