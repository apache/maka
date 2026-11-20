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
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt};
use maka_plugin_core::shell_result::{ShellOutput, ShellStatus};
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
        access: &dyn NativeCallAccess,
    ) -> Result<Value, ToolError> {
        let tool = access.call();
        let input: Health = serde_json::from_value(input).map_err(failed)?;
        let target = input
            .url
            .map(|url| Input { url }.target())
            .transpose()
            .map_err(failed)?;
        cancelled(&context.scope().cancellation)?;
        access.current().await?;
        let id = maka_host_runtime::shell::request::require_ref(&input.reference)?;
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
            Some(target) => probe_endpoint(context, tool, id, target).await?,
        };
        cancelled(&context.scope().cancellation)?;
        Ok(serde_json::json!({"process":process,"endpoint":endpoint}))
    }
}

async fn probe_endpoint(
    context: &Context,
    tool: &ToolCallContext,
    id: &str,
    target: String,
) -> Result<Endpoint, ToolError> {
    let probe_input = serde_json::json!({"url": target});
    let recovery = serde_json::json!({
        "kind": "process_health_probe",
        "version": 1,
        "correlation": {
            "execution": tool.execution,
            "operationId": tool.operation_id,
            "toolUseId": tool.tool_use_id(),
            "caller": context.scope().identity,
            "processId": id,
        },
        "target": {"kind": "import", "name": "web", "member": 0},
        "method": "probe",
        "input": probe_input,
        "resources": {
            "descriptors": {},
            "reacquisition": {"kind": "none"},
        },
    });
    let probe = maka_web::probe::ProcessProbe::new(context, &target)?;

    let admission = context
        .begin_local_mutation(
            "web",
            0,
            "probe".into(),
            probe_input,
            uuid::Uuid::new_v4(),
            recovery,
            probe,
        )
        .await;
    let mutation = match admission {
        Ok(mutation) => mutation,
        Err(_) => {
            return Ok(Endpoint::Unknown {
                target,
                error: "Endpoint service is unavailable or access was not authorized".into(),
            });
        }
    };
    let completion = mutation.completion().await;
    completion.cleanup.map_err(ToolError::CleanupUnconfirmed)?;
    match completion.reply.receipt {
        Receipt::Recorded {
            cleanup: OperationCleanup::Failed { diagnostic },
            ..
        } => Err(ToolError::CleanupUnconfirmed(diagnostic)),
        Receipt::Recorded {
            cleanup: OperationCleanup::Unconfirmed,
            ..
        } => Err(ToolError::CleanupUnconfirmed(
            "Health probe cleanup unconfirmed".into(),
        )),
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { result },
            ..
        } => match result {
            OperationResult::Failure { diagnostic } => Err(failed(diagnostic)),
            OperationResult::Success { value } => {
                match serde_json::from_value::<maka_web_api::contract::ResultValue>(value)
                    .map_err(persistence)?
                {
                    maka_web_api::contract::ResultValue::Completed { value } => {
                        serde_json::from_value(value).map_err(persistence)
                    }
                    maka_web_api::contract::ResultValue::Failed { message } => Err(failed(message)),
                }
            }
        },
        Receipt::Recorded {
            outcome: OperationOutcome::NotExecuted { .. },
            ..
        } => Err(failed("Health probe was prevented before execution")),
        _ => Err(ToolError::OutcomeUnknown(
            "Health probe outcome unknown; read the original operation receipt".into(),
        )),
    }
}
