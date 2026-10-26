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

use super::{PreparedEffect, ToolError, ToolFuture};
use crate::event::{EventSink, EventWrite, Fact, Invocation, RuntimeEvent, ToolOutcome};
use crate::tool_call::{ToolCallIdentity, ToolRejection};
use crate::tool_output::{ToolOutput, ToolSuccess};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Execution facts without an executor or a second admission authority.
/// Prepared calls can own one-shot effects instead of pretending to be repeatable.
#[derive(Clone)]
pub struct ToolJournal {
    sink: Arc<dyn EventSink>,
    invocation: Invocation,
}
impl ToolJournal {
    pub fn new(sink: Arc<dyn EventSink>, invocation: Invocation) -> Self {
        Self { sink, invocation }
    }
    pub fn execution_custody(&self) -> Option<Arc<dyn super::ExecutionCustody>> {
        self.sink.clone().execution_custody()
    }
    pub fn context(&self, operation_id: String) -> super::ToolCallContext {
        super::ToolCallContext {
            invocation: self.invocation.clone(),
            operation_id,
            execution: self.execution_custody(),
        }
    }
    pub fn invocation(&self) -> &Invocation {
        &self.invocation
    }
    pub async fn notify(
        &self,
        operation_id: String,
        text: String,
        model_text: String,
    ) -> Result<u64, ToolError> {
        let write = EventWrite::plain(RuntimeEvent::new(
            self.invocation.clone(),
            Fact::ToolNotified {
                operation_id,
                text,
                model_text,
            },
        ))
        .map_err(|error| ToolError::Persistence(error.to_string()))?;
        self.sink
            .clone()
            .commit(write)
            .await
            .map_err(|error| ToolError::Persistence(error.to_string()))
    }
    pub fn reject(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: crate::model::ToolInput,
        reason: ToolRejection,
    ) -> ToolFuture {
        let sink = self.sink.clone();
        let invocation = self.invocation.clone();
        Box::pin(async move {
            let message = reason.to_string();
            let event = RuntimeEvent::new(
                invocation,
                Fact::ToolRejected {
                    operation_id,
                    call,
                    name,
                    input,
                    reason,
                },
            );
            sink.commit(
                EventWrite::plain(event)
                    .map_err(|error| ToolError::Persistence(error.to_string()))?,
            )
            .await
            .map_err(|error| ToolError::Persistence(error.to_string()))?;
            Err(ToolError::Failed(message))
        })
    }

    /// Journal a one-shot effect whose preparation and policy checks have
    /// already succeeded. Captured admission guards are dropped if T1 fails
    /// or cancellation prevents execution; the closure is never retried.
    pub fn invoke_call_with<T: Into<ToolSuccess> + Send + 'static>(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        cancellation: CancellationToken,
        effect: impl FnOnce(CancellationToken) -> ToolFuture<T> + Send + 'static,
    ) -> ToolFuture {
        self.invoke_prepared_call(
            operation_id,
            call,
            name,
            input,
            cancellation,
            PreparedEffect::new(move |cancellation| {
                Box::pin(async move { effect(cancellation).await.map(Into::into) })
            }),
        )
    }

    pub fn invoke_prepared_call(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        cancellation: CancellationToken,
        effect: PreparedEffect,
    ) -> ToolFuture {
        let output =
            self.invoke_prepared_output(operation_id, call, name, input, cancellation, effect);
        Box::pin(async move { output.await.map(ToolOutput::into_json) })
    }

    /// Native consumers keep the typed result; encoding is only for persistence
    /// and wire adapters, not an unnecessary serialize/deserialize round trip.
    pub fn invoke_prepared_output(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        cancellation: CancellationToken,
        mut effect: PreparedEffect,
    ) -> ToolFuture<ToolOutput> {
        let sink = self.sink.clone();
        let invocation = self.invocation.clone();
        Box::pin(async move {
            let dispatch = RuntimeEvent::new(
                invocation.clone(),
                Fact::ToolDispatched {
                    title: effect.title.clone(),
                    presentation: effect.presentation.clone(),
                    operation_id: operation_id.clone(),
                    call,
                    name,
                    input,
                },
            );
            sink.clone()
                .commit(
                    EventWrite::plain(dispatch)
                        .map_err(|error| ToolError::Persistence(error.to_string()))?,
                )
                .await
                .map_err(|error| match error {
                    crate::event::CommitError::Retired => {
                        ToolError::Failed("session retired before effect".into())
                    }
                    crate::event::CommitError::PermissionRevoked => {
                        ToolError::Failed("permission grant is no longer current".into())
                    }
                    other => ToolError::Persistence(other.to_string()),
                })?;

            let result = if cancellation.is_cancelled() {
                Err(ToolError::Failed("cancelled before effect".into()))
            } else {
                effect.start(cancellation).await
            };
            let id = RuntimeEvent::new_id();
            let recorded_at = std::time::SystemTime::now();
            if let Err(ToolError::OperationCleanupUnconfirmed {
                message,
                observation,
            }) = result
            {
                let write = EventWrite::plain(RuntimeEvent {
                    id,
                    recorded_at,
                    invocation,
                    fact: Fact::ToolOperationObserved {
                        operation_id,
                        observation,
                    },
                });
                // Recording an observation never releases the real cleanup fence.
                let recorded = match write {
                    Ok(write) => sink
                        .commit(write)
                        .await
                        .map(|_| ())
                        .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                };
                return Err(ToolError::CleanupUnconfirmed(match recorded {
                    Ok(()) => message,
                    Err(_) => {
                        format!("{message}; original service observation could not be persisted")
                    }
                }));
            }
            let (write, result) = match result {
                Ok(value) => {
                    EventWrite::tool_success(id, recorded_at, invocation, operation_id, value)
                        .map(|(write, output)| (write, Ok(output)))
                }
                Err(
                    error @ (ToolError::Failed(_)
                    | ToolError::Io { .. }
                    | ToolError::OutcomeUnknown(_)
                    | ToolError::OperationUnknown { .. }),
                ) => {
                    let outcome = match &error {
                        ToolError::OutcomeUnknown(message) => ToolOutcome::Unknown {
                            message: message.clone(),
                            operation: None,
                        },
                        ToolError::OperationUnknown {
                            message,
                            observation,
                        } => ToolOutcome::Unknown {
                            message: message.clone(),
                            operation: Some(observation.clone()),
                        },
                        ToolError::Failed(message) => ToolOutcome::Failed {
                            message: message.clone(),
                        },
                        _ => ToolOutcome::Failed {
                            message: error.to_string(),
                        },
                    };
                    EventWrite::plain(RuntimeEvent {
                        id,
                        recorded_at,
                        invocation,
                        fact: Fact::ToolSettled {
                            operation_id,
                            outcome,
                        },
                    })
                    .map(|write| (write, Err(error)))
                }
                // Missing durable outcome remains uncertain on reconstruction.
                Err(error) => return Err(error),
            }
            .map_err(|error| ToolError::Persistence(error.to_string()))?;
            sink.commit(write)
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?;
            drop(effect);
            result
        })
    }
}
