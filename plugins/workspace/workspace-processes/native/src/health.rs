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
use maka_agent_facts::shell_result::{ShellOutput, ShellStatus};
use maka_capabilities::call::Attachments;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use maka_web_api::probe::{Endpoint, Input};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Process {
    status: ShellStatus,
    tracked: bool,
    started_at: u64,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    logs: Option<ShellOutput>,
}
impl Processes {
    pub(super) async fn health(
        &self,
        context: &Context,
        input: Value,
        tool: &ToolCallContext,
    ) -> Result<Value, ToolError> {
        let input: Health = serde_json::from_value(input).map_err(failed)?;
        let target = input
            .url
            .map(|url| Input { url }.target())
            .transpose()
            .map_err(failed)?;
        cancelled(&context.scope().cancellation)?;
        maka_agent_authority::permissions::live(
            &maka_agent_authority::permissions::execution(
                &self.store,
                &tool.invocation,
                tool.execution.as_deref(),
            )?,
            &tool.invocation,
        )
        .await?;
        let id = maka_host_runtime::shell::request::parse_ref(&input.reference)
            .ok_or_else(|| failed("Invalid process resource ref"))?;
        let record = self.read_model(tool, id).await?;
        let snapshot = if input.include_logs {
            maka_presentation::shell::local_observation(record).map(|update| update.result)
        } else {
            maka_presentation::shell::local_state((*record.record).clone())
        }
        .map_err(persistence)?;
        let process = Process {
            status: snapshot.status,
            tracked: true,
            started_at: snapshot.started_at,
            updated_at: snapshot.updated_at,
            completed_at: snapshot.completed_at,
            exit_code: snapshot.exit_code,
            failure_message: snapshot.failure_message,
            logs: snapshot.output,
        };
        let endpoint = match target {
            None => Endpoint::NotChecked,
            Some(target) => {
                let request = context.mutate(
                    "web",
                    0,
                    "probe".into(),
                    serde_json::json!({"url":target}),
                    uuid::Uuid::new_v4(),
                    Attachments::default(),
                );
                match request {
                    Err(_) => Endpoint::Unknown {
                        target,
                        error: "Endpoint service is unavailable or access was not authorized"
                            .into(),
                    },
                    Ok(request) => match request.await {
                        Err(_) => Endpoint::Unknown {
                            target,
                            error: "Endpoint service is unavailable or access was not authorized"
                                .into(),
                        },
                        Ok(reply) => match reply.receipt {
                            Receipt::Recorded {
                                outcome: OperationOutcome::Returned { value },
                                cleanup: OperationCleanup::Confirmed,
                            } => {
                                match serde_json::from_value::<maka_web_api::contract::ResultValue>(
                                    value,
                                )
                                .map_err(persistence)?
                                {
                                    maka_web_api::contract::ResultValue::Completed { value } => {
                                        serde_json::from_value(value).map_err(persistence)?
                                    }
                                    maka_web_api::contract::ResultValue::Failed { message } => {
                                        return Err(failed(message));
                                    }
                                }
                            }
                            Receipt::Recorded {
                                cleanup: OperationCleanup::Failed { diagnostic },
                                ..
                            } => return Err(ToolError::CleanupUnconfirmed(diagnostic)),
                            Receipt::Recorded {
                                cleanup: OperationCleanup::Unconfirmed,
                                ..
                            } => {
                                return Err(ToolError::CleanupUnconfirmed(
                                    "Health probe cleanup unconfirmed".into(),
                                ));
                            }
                            _ => return Err(ToolError::OutcomeUnknown(
                                "Health probe outcome unknown; read the original operation receipt"
                                    .into(),
                            )),
                        },
                    },
                }
            }
        };
        cancelled(&context.scope().cancellation)?;
        Ok(serde_json::json!({"process":process,"endpoint":endpoint}))
    }
}
