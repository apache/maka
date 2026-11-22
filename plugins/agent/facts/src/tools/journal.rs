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

use crate::durable::ExecutionIdentity;

use super::{PreparedEffect, PreparedExecution, ToolError, ToolFuture};
use crate::event::{EventSink, EventWrite, Fact, RuntimeEvent, ToolOutcome};
use crate::tool_call::{ToolCallIdentity, ToolRejection};
use crate::tool_output::{ToolOutput, ToolSuccess};
use serde_json::Value;
use std::sync::Arc;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tokio_util::sync::CancellationToken;

/// Execution facts without an executor or a second admission authority.
/// Prepared calls can own one-shot effects instead of pretending to be repeatable.
/// A prior completion shares T1 or rejection; the caller retains its recovery
/// owner until all calls drain, flushing it before returning a fatal error.
#[derive(Clone)]
pub struct ToolJournal {
    sink: Arc<dyn EventSink>,
    execution: ExecutionIdentity,
}

/// Publication receipt and the unstarted effect/settlement continuation.
pub struct PublishedTool<T> {
    pub prefix_sequences: Vec<u64>,
    pub completion: ToolContinuation<T>,
}

/// An acknowledged dispatch owns either execution or an observable approval wait.
pub enum ToolContinuation<T = ToolOutput> {
    Executing(ToolFuture<T>),
    Approval(Box<ApprovalContinuation<T>>),
}

impl<T: Send + 'static> ToolContinuation<T> {
    pub fn into_future(self) -> ToolFuture<T> {
        Box::pin(self)
    }

    pub fn map<U: Send + 'static>(
        self,
        convert: impl FnOnce(T) -> U + Send + 'static,
    ) -> ToolContinuation<U> {
        match self {
            Self::Executing(future) => {
                ToolContinuation::Executing(Box::pin(async move { future.await.map(convert) }))
            }
            Self::Approval(approval) => {
                let ApprovalContinuation {
                    pending,
                    answer,
                    admitted,
                    convert: previous,
                } = *approval;
                ToolContinuation::Approval(Box::new(ApprovalContinuation {
                    pending,
                    answer,
                    admitted,
                    convert: Some(Box::new(move |output| {
                        convert(previous.expect("approval conversion is consumed once")(
                            output,
                        ))
                    })),
                }))
            }
        }
    }
}

impl<T: Send + 'static> Future for ToolContinuation<T> {
    type Output = Result<T, ToolError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        loop {
            match this {
                Self::Executing(future) => return future.as_mut().poll(cx),
                Self::Approval(approval) => match Pin::new(approval.as_mut()).poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(future) => *this = Self::Executing(future),
                },
            }
        }
    }
}

/// The original one-shot execution and T2 owner, retained until answer or confirmed park.
pub struct ApprovalContinuation<T = ToolOutput> {
    pending: crate::native_approval::NativeApprovalPending,
    answer: super::ApprovalAnswerFuture,
    admitted: Option<AdmittedTool>,
    convert: Option<Box<dyn FnOnce(ToolOutput) -> T + Send>>,
}

impl<T> ApprovalContinuation<T> {
    pub fn pending(&self) -> &crate::native_approval::NativeApprovalPending {
        &self.pending
    }
}

impl<T: Send + 'static> Future for ApprovalContinuation<T> {
    type Output = ToolFuture<T>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let answer = match this.answer.as_mut().poll(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(answer) => answer,
        };
        let admitted = this.admitted.take().expect("approval is consumed once");
        let result = match answer {
            Ok(crate::interaction::InteractionOutcome::ServiceApprovalDecision {
                decision: crate::interaction::Decision::Allow,
                ..
            }) => None,
            Ok(crate::interaction::InteractionOutcome::Closure {
                reason: crate::interaction::ClosureReason::Steered,
                ..
            }) => Some(ToolError::Failed(
                "Not executed: superseded by new user input".into(),
            )),
            Ok(
                crate::interaction::InteractionOutcome::ServiceApprovalDecision { .. }
                | crate::interaction::InteractionOutcome::Closure { .. },
            ) => Some(ToolError::Failed("service call was not approved".into())),
            Ok(_) => Some(ToolError::Failed(
                "service confirmation outcome invalid".into(),
            )),
            Err(error) => Some(error),
        };
        let convert = this
            .convert
            .take()
            .expect("approval conversion is consumed once");
        Poll::Ready(Box::pin(async move {
            admitted.execute(result).await.map(convert)
        }))
    }
}

type SettlementPublisher = Box<dyn FnOnce(EventWrite) -> crate::event::CommitFuture + Send>;

/// Settlement half of the original journal; this owner never writes another T1.
pub struct AdmittedTool {
    sink: Arc<dyn EventSink>,
    execution: ExecutionIdentity,
    operation_id: String,
    effect: PreparedEffect,
    cancellation: CancellationToken,
    publish_settlement: Option<SettlementPublisher>,
}

impl ToolJournal {
    pub fn new(sink: Arc<dyn EventSink>, execution: ExecutionIdentity) -> Self {
        Self { sink, execution }
    }
    /// Settle a durably admitted original operation under fresh execution custody.
    /// The caller verifies the checkpoint and start fence before supplying its effect.
    /// The publisher retains this exact T2 until durable acknowledgment; an uncertain
    /// append must remain owned there rather than return a disposable failure.
    pub fn resume_prepared_output(
        &self,
        operation_id: String,
        dispatch_sequence: u64,
        cancellation: CancellationToken,
        mut effect: PreparedEffect,
        publish: impl FnOnce(EventWrite) -> crate::event::CommitFuture + Send + 'static,
    ) -> ToolFuture<ToolOutput> {
        effect.admitted(dispatch_sequence);
        AdmittedTool {
            sink: self.sink.clone(),
            execution: self.execution.clone(),
            operation_id,
            effect,
            cancellation,
            publish_settlement: Some(Box::new(publish)),
        }
        .execute(None)
    }

    pub fn work_custody(&self) -> Option<Arc<dyn maka_plugin_core::work::WorkCustody>> {
        self.sink.clone().work_custody()
    }
    pub fn context(&self, operation_id: String, call: ToolCallIdentity) -> super::ToolCallContext {
        super::ToolCallContext {
            execution: self.execution.clone(),
            operation_id,
            call,
            custody: self.work_custody(),
        }
    }
    pub fn execution(&self) -> &ExecutionIdentity {
        &self.execution
    }
    pub async fn notify(
        &self,
        operation_id: String,
        text: String,
        model_text: String,
    ) -> Result<u64, ToolError> {
        let write = EventWrite::plain(RuntimeEvent::new(
            self.execution.clone(),
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
        prior: Option<EventWrite>,
        reason: ToolRejection,
    ) -> ToolFuture {
        let publication = self.publish_rejection(
            operation_id,
            call,
            name,
            input,
            prior.into_iter().collect(),
            reason,
        );
        Box::pin(async move { publication.await?.completion.await })
    }

    pub fn publish_rejection(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: crate::model::ToolInput,
        prefix: Vec<EventWrite>,
        reason: ToolRejection,
    ) -> ToolFuture<PublishedTool<Value>> {
        let sink = self.sink.clone();
        let execution = self.execution.clone();
        Box::pin(async move {
            let message = reason.to_string();
            let event = RuntimeEvent::new(
                execution,
                Fact::ToolRejected {
                    operation_id,
                    call,
                    name,
                    input,
                    reason,
                },
            );
            let receipt = sink
                .commit_with_prefix(
                    &prefix,
                    EventWrite::plain(event)
                        .map_err(|error| ToolError::Persistence(error.to_string()))?,
                )
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?;
            Ok(PublishedTool {
                prefix_sequences: receipt.prefix_sequences,
                completion: ToolContinuation::Executing(Box::pin(async move {
                    Err(ToolError::Failed(message))
                })),
            })
        })
    }

    /// Journal a one-shot effect whose preparation and policy checks have
    /// already succeeded. Captured admission guards are dropped if T1 fails
    /// or cancellation prevents execution; the closure is never retried.
    #[expect(
        clippy::too_many_arguments,
        reason = "the accepted model fact must remain explicit at the T1 boundary"
    )]
    pub fn invoke_call_with<T: Into<ToolSuccess> + Send + 'static>(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        prior: Option<EventWrite>,
        cancellation: CancellationToken,
        effect: impl FnOnce(CancellationToken) -> ToolFuture<T> + Send + 'static,
    ) -> ToolFuture {
        self.invoke_prepared_call(
            operation_id,
            call,
            name,
            input,
            prior,
            cancellation,
            PreparedEffect::new(move |cancellation| {
                Box::pin(async move { effect(cancellation).await.map(Into::into) })
            }),
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the accepted model fact must remain explicit at the T1 boundary"
    )]
    pub fn invoke_prepared_call(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        prior: Option<EventWrite>,
        cancellation: CancellationToken,
        effect: PreparedEffect,
    ) -> ToolFuture {
        let output = self.invoke_prepared_output(
            operation_id,
            call,
            name,
            input,
            prior,
            cancellation,
            effect,
        );
        Box::pin(async move { output.await.map(ToolOutput::into_json) })
    }

    /// Native consumers keep the typed result; encoding is only for persistence
    /// and wire adapters, not an unnecessary serialize/deserialize round trip.
    #[expect(
        clippy::too_many_arguments,
        reason = "the accepted model fact must remain explicit at the T1 boundary"
    )]
    pub fn invoke_prepared_output(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        prior: Option<EventWrite>,
        cancellation: CancellationToken,
        effect: PreparedEffect,
    ) -> ToolFuture<ToolOutput> {
        let publication = self.publish_prepared_output(
            operation_id,
            call,
            name,
            input,
            prior.into_iter().collect(),
            cancellation,
            effect,
        );
        Box::pin(async move { publication.await?.completion.await })
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "publication keeps the dispatch identity explicit"
    )]
    pub fn publish_prepared_call(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        prefix: Vec<EventWrite>,
        cancellation: CancellationToken,
        effect: PreparedEffect,
    ) -> ToolFuture<PublishedTool<Value>> {
        let publication = self.publish_prepared_output(
            operation_id,
            call,
            name,
            input,
            prefix,
            cancellation,
            effect,
        );
        Box::pin(async move {
            let PublishedTool {
                prefix_sequences,
                completion,
            } = publication.await?;
            Ok(PublishedTool {
                prefix_sequences,
                completion: completion.map(ToolOutput::into_json),
            })
        })
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "publication keeps the dispatch identity explicit"
    )]
    pub fn publish_prepared_output(
        &self,
        operation_id: String,
        call: ToolCallIdentity,
        name: String,
        input: Value,
        prefix: Vec<EventWrite>,
        cancellation: CancellationToken,
        mut effect: PreparedEffect,
    ) -> ToolFuture<PublishedTool<ToolOutput>> {
        let sink = self.sink.clone();
        let execution = self.execution.clone();
        Box::pin(async move {
            let dispatch = RuntimeEvent::new(
                execution.clone(),
                Fact::ToolDispatched {
                    title: effect.title.clone(),
                    presentation: effect.presentation.clone(),
                    operation_id: operation_id.clone(),
                    call,
                    name,
                    input,
                },
            );
            let receipt = sink
                .clone()
                .commit_with_prefix(
                    &prefix,
                    EventWrite::plain(dispatch)
                        .map_err(|error| ToolError::Persistence(error.to_string()))?,
                )
                .await;
            let sequence = match receipt {
                Ok(receipt) => receipt,
                Err(
                    error @ (crate::event::CommitError::Retired
                    | crate::event::CommitError::PermissionRevoked
                    | crate::event::CommitError::NativeTurnInterrupted),
                ) => {
                    let prefix_sequences = if let Some((last, rest)) = prefix.split_last() {
                        let receipt = sink
                            .clone()
                            .commit_with_prefix(rest, last.clone())
                            .await
                            .map_err(|flush| {
                                ToolError::Persistence(format!(
                                    "{error}; completion flush failed: {flush}"
                                ))
                            })?;
                        let mut sequences = receipt.prefix_sequences;
                        sequences.push(receipt.last_sequence);
                        sequences
                    } else {
                        Vec::new()
                    };
                    let failure = ToolError::Failed(match error {
                        crate::event::CommitError::Retired => {
                            "session retired before effect".into()
                        }
                        crate::event::CommitError::PermissionRevoked => {
                            "permission grant is no longer current".into()
                        }
                        crate::event::CommitError::NativeTurnInterrupted => {
                            "native Computer Use is stopped for this logical Turn".into()
                        }
                        _ => error.to_string(),
                    });
                    return Ok(PublishedTool {
                        prefix_sequences,
                        completion: ToolContinuation::Executing(Box::pin(
                            async move { Err(failure) },
                        )),
                    });
                }
                Err(error) => return Err(ToolError::Persistence(error.to_string())),
            };
            drop(prefix);
            let prefix_sequences = sequence.prefix_sequences;
            effect.admitted(sequence.last_sequence);
            let prepared = effect.take_execution();
            let completion = match prepared {
                PreparedExecution::Inline(execute) => {
                    effect.set_execution(execute);
                    ToolContinuation::Executing(
                        AdmittedTool {
                            sink,
                            execution,
                            operation_id,
                            effect,
                            cancellation,
                            publish_settlement: None,
                        }
                        .execute(None),
                    )
                }
                PreparedExecution::NativeApproval(prepared) => {
                    effect.set_execution(prepared.execute);
                    let established = if cancellation.is_cancelled() {
                        Err(ToolError::Failed("cancelled before effect".into()))
                    } else if let Err(error) = effect.admit() {
                        Err(error)
                    } else {
                        (prepared.establish)(cancellation.clone()).await
                    };
                    let admitted = AdmittedTool {
                        sink,
                        execution,
                        operation_id,
                        effect,
                        cancellation,
                        publish_settlement: None,
                    };
                    match established {
                        Ok(established) => {
                            ToolContinuation::Approval(Box::new(ApprovalContinuation {
                                pending: established.pending,
                                answer: established.answer,
                                admitted: Some(admitted),
                                convert: Some(Box::new(std::convert::identity)),
                            }))
                        }
                        Err(error) => ToolContinuation::Executing(admitted.execute(Some(error))),
                    }
                }
            };
            Ok(PublishedTool {
                prefix_sequences,
                completion,
            })
        })
    }
}

impl AdmittedTool {
    fn execute(self, failure: Option<ToolError>) -> ToolFuture<ToolOutput> {
        let Self {
            sink,
            execution,
            operation_id,
            mut effect,
            cancellation,
            publish_settlement,
        } = self;
        Box::pin(async move {
            let result = if let Some(error) = failure {
                Err(error)
            } else if cancellation.is_cancelled() {
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
                    execution,
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
                    EventWrite::tool_success(id, recorded_at, execution, operation_id, value)
                        .map(|(write, output)| (write, Ok(output)))
                }
                Err(
                    error @ (ToolError::Failed(_)
                    | ToolError::Native(_)
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
                        ToolError::Native(error) => ToolOutcome::Failed {
                            message: error.message.clone(),
                        },
                        _ => ToolOutcome::Failed {
                            message: error.to_string(),
                        },
                    };
                    EventWrite::plain(RuntimeEvent {
                        id,
                        recorded_at,
                        execution,
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
            let publication = match publish_settlement {
                Some(publish) => publish(write),
                None => sink.commit(write),
            };
            publication
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?;
            drop(effect);
            result
        })
    }
}
