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

mod input;

use super::Service;
use input::Input;
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{PreparationFuture, PreparedEffect, ToolCallContext, ToolError, ToolPreparer},
};
use maka_tool_catalog::{
    ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics, plugins::PluginTool,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const NAME: &str = "ScheduledTask";
pub(super) fn register(service: Service) -> Result<PluginTool, String> {
    PluginTool::new(ToolRegistration {
        definition: ToolDefinition {
            freeform: None, output_schema: None, provider: None,
            name: NAME.into(),
            description: "Create and manage scheduled tasks (定时任务) owned by this conversation. Creating or resuming a task requires the user to approve background access in the Scheduler UI first; tool execution cannot grant unattended access. All tasks also appear in Desktop. session_resume (default) continues this conversation; agent_run uses a frozen model/workspace/policy template for a fresh session; notify_local sends a local notification. Times are Unix milliseconds; omitted startAt means now, cron uses the configured IANA timezone. Missed unclaimed triggers are skipped by default. list returns compact summaries; management cannot change another conversation's tasks.".into(),
            input_schema: input::schema(),
        },
        nesting: ToolNesting::DirectOnly,
        semantics: ToolSemantics::ExclusiveStep,
        handler: ToolHandler::Prepared(Arc::new(Tools { service })),
    }).map_err(|error| error.to_string())
}
struct Tools {
    service: Service,
}
impl ToolPreparer for Tools {
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
        let service = self.service.clone();
        Box::pin(async move {
            if name != NAME {
                return Err(ToolRejection::Unavailable);
            }
            let input: Input =
                serde_json::from_value(input).map_err(|error| ToolRejection::InvalidInput {
                    message: error.to_string(),
                })?;
            Ok(PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    if cancel.is_cancelled() {
                        return Err(ToolError::Failed("call cancelled before execution".into()));
                    }
                    let _lease = service.context.admit().map_err(failed)?;
                    if matches!(input, Input::List {}) {
                        let view = service.handle.snapshot();
                        if !view.ready {
                            return Err(ToolError::Failed("scheduler is recovering".into()));
                        }
                        let tasks: Vec<_> = view.tasks.values().filter(|task| matches!(
                        &task.created_by, crate::task::Creator::Agent { session_id } if *session_id == context.invocation.session_id
                    )).map(|task| json!({
                        "id":task.id,"title":task.title,"status":task.status,"nextFireAt":task.next_fire_at,
                        "fireCount":task.fire_count,"lastError":task.last_error,
                    })).collect();
                        return Ok(json!({"tasks":tasks}).into());
                    }
                    let mutation = input
                        .mutation(service.backend.as_ref(), &context.invocation)
                        .await
                        .map_err(tool_error)?;
                    let result = service
                        .mutate(
                            mutation,
                            crate::authorization::Origin::Agent(
                                maka_plugins::call::current()
                                    .ok_or_else(|| failed("missing Agent authority"))?,
                            ),
                        )
                        .await
                        .map_err(tool_error)?;
                    let output = match result {
                        crate::command::MutationResult::Task { task } => json!({
                            "id":task.id,"title":task.title,"status":task.status,"nextFireAt":task.next_fire_at,
                        }),
                        crate::command::MutationResult::Deleted { task_id } => {
                            json!({"deleted":task_id})
                        }
                        crate::command::MutationResult::Created { .. } => {
                            return Err(failed("unexpected creation receipt for a tool mutation"));
                        }
                    };
                    Ok(output.into())
                })
            }))
        })
    }
}
fn failed(error: impl ToString) -> ToolError {
    ToolError::Failed(error.to_string())
}

fn tool_error(error: crate::Error) -> ToolError {
    match error {
        crate::Error::OutcomeUnknown
        | crate::Error::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(_))
        | crate::Error::Authority(maka_plugins::execution::CommandError::OutcomeUnknown(_)) => {
            ToolError::OutcomeUnknown(error.to_string())
        }
        crate::Error::Resource(error) => error,
        error => failed(error),
    }
}
