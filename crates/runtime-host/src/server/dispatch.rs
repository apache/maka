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

use super::{
    Host, HostError, access, capabilities, configuration, context, operations, sessions, turns,
};
use maka_protocol::turn;
use maka_protocol::{Operation, OperationRegistry, Outcome};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

enum Change {
    None,
    Session,
    Configuration,
}

impl Host {
    pub(super) async fn dispatch(
        self: &std::sync::Arc<Self>,
        operation: Operation,
        input: Value,
        connection_id: uuid::Uuid,
        authority: &super::authority::Authority,
        client_instance_id: &str,
    ) -> Result<Outcome, HostError> {
        if maka_protocol::plugin::supports(operation) {
            let input = maka_protocol::plugin::decode_input(operation, &input)?;
            if let maka_protocol::plugin::Input::Authorization(input) = input {
                return Ok(
                    match super::plugin_authorization::execute(
                        self,
                        authority,
                        client_instance_id,
                        *input,
                    )
                    .await
                    {
                        Ok(result) => Outcome::success(serde_json::to_value(result)?),
                        Err(error) => Outcome::failure(error),
                    },
                );
            }
            if let maka_protocol::plugin::Input::Remote(request) = input {
                return Ok(
                    match super::plugin_remote::execute(
                        self,
                        connection_id,
                        client_instance_id,
                        authority,
                        *request,
                    )
                    .await
                    {
                        Ok(result) => Outcome::success(serde_json::to_value(result)?),
                        Err(error) => Outcome::failure(error),
                    },
                );
            }
            return Ok(match self.plugins.execute(input).await {
                Ok(result) => Outcome::success(result),
                Err(error) => Outcome::failure(error),
            });
        }
        if operation == Operation::HostWake {
            self.plugins.wake_background_work();
            return Ok(Outcome::success(serde_json::json!({})));
        }
        if maka_protocol::pricing::supports(operation) {
            return super::pricing::execute(self, operation, &input).await;
        }
        if operation == Operation::HostUpgradePrepare {
            return match self
                .prepare_retirement(
                    maka_protocol::host::decode_retirement_input(&input)?,
                    connection_id,
                )
                .await
            {
                Ok(result) => Ok(Outcome::success(serde_json::to_value(result)?)),
                Err(error) => Ok(Outcome::failure(error)),
            };
        }
        if maka_protocol::oauth::supports(operation) {
            return super::oauth::execute(self, connection_id, operation, &input).await;
        }
        if maka_protocol::navigation::supports(operation) {
            return super::navigation::execute(self, operation, &input).await;
        }
        if operation == Operation::SessionExecutionBoundaryQuery {
            return super::execution_boundary::execute(self, &input).await;
        }
        if maka_protocol::sandbox_setup::supports(operation) {
            return super::sandbox_setup::execute(self, operation).await;
        }
        if super::onboarding::supports(operation) {
            return super::onboarding::execute(self, operation, &input).await;
        }
        if super::projects::supports(operation) {
            return super::projects::execute(self, operation, &input).await;
        }
        if super::messages::supports(operation) {
            return super::messages::execute(
                self,
                connection_id,
                super::plugin_authorization::principal(authority, client_instance_id),
                operation,
                &input,
            )
            .await;
        }
        if super::resources::supports(operation) {
            return super::resources::execute(self, connection_id, operation, &input).await;
        }
        if context::supports(operation) {
            return context::execute(self, operation, &input).await;
        }
        if maka_protocol::artifact::supports(operation) {
            return super::artifacts::execute(self, connection_id, operation, &input).await;
        }
        if super::interactions::supports(operation) {
            return super::interactions::execute(self, operation, &input).await;
        }
        if capabilities::supports(operation) {
            return capabilities::execute(self, connection_id, operation, &input).await;
        }
        if access::supports(operation) {
            return match access::execute(self, operation, &input, authority, client_instance_id)
                .await
            {
                Ok(output) => Ok(Outcome::success(access::decode_output(
                    operation,
                    &serde_json::to_value(output)?,
                )?)),
                Err(error) => Ok(Outcome::failure(error)),
            };
        }
        if operation == Operation::HostStatus {
            return Ok(Outcome::success(serde_json::to_value(
                self.status(&self.activity()),
            )?));
        }
        if operation == Operation::HostDiagnosticsQuery {
            return Ok(Outcome::success(serde_json::to_value(self.diagnostics()?)?));
        }
        if turns::supports(operation) {
            let result = match operation {
                Operation::TurnStart => {
                    let input = turn::decode_turn_start_input(&input)?;
                    let result = self
                        .executions
                        .start(input.clone(), connection_id, self.root_id())
                        .await;
                    if let Ok(output) = &result {
                        turn::assert_start_output_for_input(&input, output)?;
                    }
                    result.map(serde_json::to_value)
                }
                Operation::TurnBatchStart => {
                    let input = turn::decode_turn_batch_start_input(&input)?;
                    let result = self
                        .executions
                        .start_batch(input.clone(), connection_id, self.root_id())
                        .await;
                    if let Ok(output) = &result {
                        turn::assert_batch_start_output_for_input(&input, output)?;
                    }
                    result.map(serde_json::to_value)
                }
                Operation::TurnResumeQuery => {
                    let input = turn::decode_turn_resume_query_input(&input)?;
                    let result = self
                        .executions
                        .resume_query(input.clone(), connection_id)
                        .await;
                    if let Ok(output) = &result {
                        turn::assert_resume_query_output_for_input(&input, output)?;
                    }
                    result.map(serde_json::to_value)
                }
                Operation::TurnResumeStart => {
                    let input = turn::decode_turn_resume_start_input(&input)?;
                    let result = self
                        .executions
                        .resume_start(input.clone(), connection_id)
                        .await;
                    if let Ok(output) = &result {
                        turn::assert_resume_start_output_for_input(&input, output)?;
                    }
                    result.map(serde_json::to_value)
                }
                Operation::TurnQuery => self
                    .executions
                    .query(turn::decode_turn_query_input(&input)?)
                    .await
                    .map(serde_json::to_value),
                Operation::TurnStop => self
                    .executions
                    .stop(turn::decode_turn_stop_input(&input)?)
                    .await
                    .map(serde_json::to_value),
                _ => unreachable!("validated Turn operation"),
            };
            return match result {
                Ok(value) => Ok(Outcome::success(turns::decode_output(operation, &value?)?)),
                Err(error) => Ok(Outcome::failure(error)),
            };
        }
        let session_id = input
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let result = if sessions::supports(operation) {
            sessions::execute(self, operation, &input)
                .await
                .and_then(|output| {
                    let change = if output.refresh_catalog() {
                        Change::Session
                    } else {
                        Change::None
                    };
                    let value = serde_json::to_value(output).map_err(|error| {
                        maka_protocol::OperationError {
                            code: maka_protocol::OperationErrorCode::InternalFailure,
                            message: error.to_string(),
                        }
                    })?;
                    Ok((value, change))
                })
        } else {
            configuration::execute(self, operation, &input)
                .await
                .and_then(|output| {
                    let change = if output.committed() {
                        Change::Configuration
                    } else {
                        Change::None
                    };
                    let value = serde_json::to_value(output).map_err(|error| {
                        maka_protocol::OperationError {
                            code: maka_protocol::OperationErrorCode::InternalFailure,
                            message: error.to_string(),
                        }
                    })?;
                    Ok((value, change))
                })
        };
        match result {
            Ok((value, change)) => {
                operations::Operations.decode_output(operation, &value)?;
                match change {
                    Change::Session => {
                        if let Some(session_id) = session_id {
                            self.session_catalog.publish_session(&session_id).await?;
                        }
                    }
                    Change::Configuration => {
                        self.executions.request_handoff_recovery();
                        let revision = self.change_revision.fetch_add(1, Ordering::SeqCst) + 1;
                        let _ = self
                            .changes
                            .send(json!({"kind": "configuration.changed", "revision": revision}));
                    }
                    Change::None => {}
                }
                Ok(Outcome::success(value))
            }
            Err(error) => Ok(Outcome::failure(error)),
        }
    }
}
