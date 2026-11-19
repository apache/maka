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
use maka_host_runtime::application::{Context, HandlerValue};
use maka_plugin_core::operation::OperationResult;

use maka_agent_api::executor::setup::{Input, Outcome};
impl Executors {
    pub(crate) async fn setup(
        &self,
        input: Input,
        context: &Context,
        authority: Arc<maka_agent_authority::setup::ActualSetupContext>,
    ) -> Result<HandlerValue, String> {
        if !matches!(context.scope().identity, Identity::Remote { .. }) {
            return Err("executor_setup_requires_application_request".into());
        }
        let operation = context
            .operation()
            .ok_or("executor_setup_requires_mutation")?
            .operation;
        let backend = self
            .0
            .get(&input.executor)
            .ok_or("agent_executor_unavailable")?;
        let Implementation::Service(backend) = &backend.implementation else {
            return Err("agent_executor_setup_unavailable".into());
        };
        let setup = backend
            .setup
            .as_ref()
            .ok_or("agent_executor_setup_unavailable")?;
        let request = backend
            .services
            .request_with_context(
                Identity::Remote {
                    request_id: operation,
                },
                context.scope().cancellation.clone(),
                authority.clone(),
            )?
            .with_sandbox_floor(context.scope().sandbox_floor())?;
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|e| e.to_string())?;
        ticket.start();
        let result =
            async {
                let action = serde_json::to_value(input.action).map_err(|e| e.to_string())?;
                let resources = maka_host_runtime::application::CallResources::default();
                let recovery = serde_json::json!({
                    "kind": "agent_executor_setup",
                    "version": 1,
                    "correlation": {
                        "caller": context.scope().identity,
                        "operation": context.operation(),
                        "executor": input.executor,
                    },
                    "target": {"kind": "import", "name": setup.import, "member": setup.member},
                    "method": "setup",
                    "input": action,
                    "resources": {
                        "descriptors": resources.descriptors()?,
                        "reacquisition": {"kind": "none"},
                    },
                });
                let mut mutation = request
                    .begin_mutation(
                        &setup.import,
                        setup.member,
                        "setup".into(),
                        action,
                        operation,
                        recovery,
                        resources,
                    )?
                    .await?;
                while let Some(value) = mutation.recv().await {
                    context.emit(value).await?;
                }
                let completed = mutation.completion().await;
                completed.cleanup?;
                match completed.reply.receipt {
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Success { value },
                            },
                        cleanup: OperationCleanup::Confirmed,
                    } => Ok(value),
                    Receipt::Recorded {
                        outcome: OperationOutcome::Unknown { diagnostic },
                        cleanup: OperationCleanup::Confirmed,
                    } => serde_json::to_value(Outcome::Unresolved { diagnostic })
                        .map_err(|e| e.to_string()),
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Failure { diagnostic },
                            },
                        cleanup: OperationCleanup::Confirmed,
                    } => Err(diagnostic),
                    Receipt::Recorded {
                        outcome: OperationOutcome::NotExecuted { .. },
                        cleanup: OperationCleanup::Confirmed,
                    } => Err("Original setup operation was prevented before execution".into()),
                    Receipt::Recorded {
                        cleanup: OperationCleanup::Unconfirmed | OperationCleanup::Failed { .. },
                        ..
                    } => Err("Original setup cleanup is unconfirmed".into()),
                    _ => serde_json::to_value(Outcome::Unresolved {
                        diagnostic:
                            "Original setup outcome is unconfirmed; do not repeat authentication"
                                .into(),
                    })
                    .map_err(|e| e.to_string()),
                }
            }
            .await;
        let cleanup = request.finish().await;
        ticket.complete(cleanup.clone());
        cleanup?;
        let value = result?;
        let outcome: Outcome = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if !matches!(outcome, Outcome::Authenticated) {
            return Ok(value.into());
        }
        match authority.0.prepare_profile(context).await {
            Ok(Some(state)) => Ok(HandlerValue::Commit { value, state }),
            Ok(None) => serde_json::to_value(Outcome::Unresolved {
                diagnostic: "Authentication was acknowledged, but no original credential profile was staged; do not repeat authentication automatically".into(),
            })
            .map(Into::into)
            .map_err(|e| e.to_string()),
            Err(error) => serde_json::to_value(Outcome::Unresolved {
                diagnostic: format!("Authentication was acknowledged, but credential-profile persistence is unresolved: {error}; do not repeat authentication automatically"),
            })
            .map(Into::into)
            .map_err(|e| e.to_string()),
        }
    }
}
