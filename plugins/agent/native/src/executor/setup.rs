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
use maka_host_runtime::application::Context;

use maka_agent_api::executor::setup::{Input, Outcome};
impl Executors {
    pub(crate) async fn setup(&self, input: Input, context: Context) -> Result<Value, String> {
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
        let request = backend.services.request(
            Identity::Remote {
                request_id: operation,
            },
            context.scope().cancellation.clone(),
        )?;
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|e| e.to_string())?;
        ticket.start();
        let result =
            async {
                let mut mutation = request
                    .begin_mutation(
                        &setup.import,
                        setup.member,
                        "setup".into(),
                        serde_json::to_value(input.action).map_err(|e| e.to_string())?,
                        operation,
                        maka_capabilities::call::Attachments::default(),
                    )?
                    .await?;
                while let Some(value) = mutation.recv().await {
                    context.emit(value).await?;
                }
                let completed = mutation.completion().await;
                completed.cleanup?;
                match completed.reply.receipt {
                    Receipt::Recorded {
                        outcome: OperationOutcome::Returned { value },
                        cleanup: OperationCleanup::Confirmed,
                    } => Ok(value),
                    Receipt::Recorded {
                        outcome: OperationOutcome::Unknown { diagnostic },
                        cleanup: OperationCleanup::Confirmed,
                    } => serde_json::to_value(Outcome::Unresolved { diagnostic })
                        .map_err(|e| e.to_string()),
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
        result
    }
}
