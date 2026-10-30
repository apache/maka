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

use super::{PreparedEffect, PreparedExecution, ToolError, ToolFuture};
use crate::event::{EventSink, EventWrite, Fact, Invocation, RuntimeEvent, ToolOutcome};
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
    invocation: Invocation,
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
    invocation: Invocation,
    operation_id: String,
    effect: PreparedEffect,
    cancellation: CancellationToken,
    publish_settlement: Option<SettlementPublisher>,
}

impl ToolJournal {
    pub fn new(sink: Arc<dyn EventSink>, invocation: Invocation) -> Self {
        Self { sink, invocation }
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
            invocation: self.invocation.clone(),
            operation_id,
            effect,
            cancellation,
            publish_settlement: Some(Box::new(publish)),
        }
        .execute(None)
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
            let execution = effect.take_execution();
            let completion = match execution {
                PreparedExecution::Inline(execute) => {
                    effect.set_execution(execute);
                    ToolContinuation::Executing(
                        AdmittedTool {
                            sink,
                            invocation,
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
                        invocation,
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
            invocation,
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

#[cfg(test)]
mod admission_tests {
    use super::*;
    use crate::{
        event::{CommitError, CommitFuture},
        tools::EffectAdmission,
    };
    use std::{
        future::poll_fn,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
        task::{Context, Poll, Waker},
    };

    #[derive(Default)]
    struct Sink {
        dispatch_ready: AtomicBool,
        reject_dispatch: bool,
        settled: AtomicBool,
        permission_revoked: bool,
        fail_flush: bool,
        committed: Mutex<Vec<EventWrite>>,
    }
    impl EventSink for Sink {
        fn commit(self: Arc<Self>, event: EventWrite) -> CommitFuture {
            Box::pin(async move {
                self.commit_with_prefix(&[], event)
                    .await
                    .map(|receipt| receipt.last_sequence)
            })
        }
        fn commit_with_prefix(
            self: Arc<Self>,
            prefix: &[EventWrite],
            last: EventWrite,
        ) -> crate::event::PrefixCommitFuture {
            let mut events = prefix.to_vec();
            events.push(last);
            Box::pin(async move {
                let dispatch = matches!(
                    &events.last().unwrap().event().fact,
                    Fact::ToolDispatched { .. }
                );
                if dispatch {
                    poll_fn(|_| {
                        if self.reject_dispatch {
                            Poll::Ready(Err(CommitError::OutcomeUnknown(
                                "original commit observer lost".into(),
                            )))
                        } else if self.permission_revoked {
                            Poll::Ready(Err(CommitError::PermissionRevoked))
                        } else if self.dispatch_ready.load(Ordering::SeqCst) {
                            Poll::Ready(Ok(()))
                        } else {
                            Poll::Pending
                        }
                    })
                    .await?;
                } else if self.fail_flush {
                    return Err(CommitError::Rejected("completion flush rejected".into()));
                }
                let mut committed = self.committed.lock().unwrap();
                let prefix_sequences = (0..events.len() - 1)
                    .map(|index| 1 + index as u64 * 3)
                    .collect();
                for event in events {
                    if matches!(&event.event().fact, Fact::ToolSettled { .. }) {
                        self.settled.store(true, Ordering::SeqCst);
                    }
                    committed.push(event);
                }
                Ok(crate::event::PrefixReceipt {
                    prefix_sequences,
                    last_sequence: if dispatch { 7 } else { 8 },
                })
            })
        }
    }
    fn journal(sink: Arc<Sink>) -> ToolJournal {
        ToolJournal::new(
            sink,
            Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
        )
    }

    fn completion(sink: &Arc<Sink>) -> EventWrite {
        EventWrite::plain(RuntimeEvent::new(
            journal(sink.clone()).invocation().clone(),
            Fact::ModelCompleted {
                step_id: "step".into(),
                output: crate::model::recorded::ModelCompletion {
                    parts: vec![crate::model::recorded::CompletionPart::Own(
                        crate::model::recorded::ModelPartRecord {
                            ordinal: 0,
                            message_id: "response".into(),
                            started_at: std::time::SystemTime::UNIX_EPOCH,
                            provider_part_id: Some("text".into()),
                            part: Arc::new(crate::model::ModelPart::Text {
                                text_kind: crate::model::TextKind::Text,
                                text: "complete accepted response".into(),
                                provider_options: None,
                            }),
                        },
                    )],
                    finish_reason: crate::model::ModelFinishReason::ToolCalls,
                    usage: Default::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ))
        .unwrap()
    }

    #[test]
    fn resumed_settlement_publisher_owns_original_t2_until_receipt_and_retains_guard() {
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let sink = Arc::new(Sink::default());
        let dropped = Arc::new(AtomicBool::new(false));
        let guard_dropped = dropped.clone();
        let original = Arc::new(Mutex::new(None::<EventWrite>));
        let published = original.clone();
        let (receipt_tx, receipt_rx) = tokio::sync::oneshot::channel();
        let effects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let executed = effects.clone();
        let effect = PreparedEffect::new(move |_| {
            Box::pin(async move {
                executed.fetch_add(1, Ordering::SeqCst);
                Ok(serde_json::json!({"resumed": true}).into())
            })
        })
        .guarded(move || Ok(Guard(guard_dropped)));
        let mut execution = journal(sink.clone()).resume_prepared_output(
            "original-operation".into(),
            17,
            CancellationToken::new(),
            effect,
            move |write| {
                *published.lock().unwrap() = Some(write);
                Box::pin(async move {
                    receipt_rx
                        .await
                        .map_err(|error| CommitError::OutcomeUnknown(error.to_string()))
                })
            },
        );
        let mut cx = Context::from_waker(Waker::noop());
        assert!(execution.as_mut().poll(&mut cx).is_pending());
        assert_eq!(effects.load(Ordering::SeqCst), 1);
        assert!(execution.as_mut().poll(&mut cx).is_pending());
        assert_eq!(
            effects.load(Ordering::SeqCst),
            1,
            "waiting for a T2 receipt never repeats the effect"
        );
        assert!(
            !dropped.load(Ordering::SeqCst),
            "admitted guard remains owned while original T2 has no receipt"
        );
        assert!(
            sink.committed.lock().unwrap().is_empty(),
            "resumed publication delegates the original T2 without publishing another T1"
        );
        let write = original
            .lock()
            .unwrap()
            .clone()
            .expect("publisher owns the original T2");
        assert_eq!(
            write.event().invocation,
            *journal(sink.clone()).invocation()
        );
        assert!(
            matches!(&write.event().fact, Fact::ToolSettled { operation_id, outcome: ToolOutcome::Succeeded { .. } } if operation_id == "original-operation")
        );
        let original_event = write.event().clone();
        receipt_tx.send(23).unwrap();
        let Poll::Ready(Ok(output)) = execution.as_mut().poll(&mut cx) else {
            panic!("confirmed original T2 releases resumed result")
        };
        assert_eq!(output.into_json(), serde_json::json!({"resumed": true}));
        assert_eq!(effects.load(Ordering::SeqCst), 1);
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(
            original.lock().unwrap().as_ref().unwrap().event(),
            &original_event,
            "publisher retains the exact original event identity and body"
        );
    }

    #[test]
    fn approval_wait_preserves_original_dispatch_and_settles_only_after_answer() {
        use crate::{
            interaction::{Decision, InteractionOutcome},
            native_approval::{DispatchReceipt, NativeApprovalPending},
            tools::EstablishedApproval,
        };
        for decision in [Decision::Allow, Decision::Deny] {
            let sink = Arc::new(Sink {
                dispatch_ready: AtomicBool::new(true),
                ..Default::default()
            });
            let started = Arc::new(AtomicBool::new(false));
            let execute_started = started.clone();
            let (answer_tx, mut answer_rx) = tokio::sync::oneshot::channel();
            let establish_sink = sink.clone();
            let invocation = journal(sink.clone()).invocation().clone();
            let effect = PreparedEffect::native_approval(
                move |_| {
                    Box::pin(async move {
                        let dispatch = establish_sink
                            .committed
                            .lock()
                            .unwrap()
                            .last()
                            .unwrap()
                            .event()
                            .clone();
                        assert!(matches!(dispatch.fact, Fact::ToolDispatched { .. }));
                        Ok(EstablishedApproval {
                            pending: NativeApprovalPending {
                                invocation,
                                operation_id: "operation".into(),
                                dispatch: DispatchReceipt {
                                    event_id: dispatch.id,
                                    sequence: 7,
                                },
                                interaction_id: "approval".into(),
                                native: serde_json::json!({}),
                            },
                            answer: Box::pin(async move {
                                (&mut answer_rx)
                                    .await
                                    .map_err(|error| ToolError::Failed(error.to_string()))
                            }),
                        })
                    })
                },
                move |_| {
                    Box::pin(async move {
                        execute_started.store(true, Ordering::SeqCst);
                        Ok(serde_json::json!({"executed": true}).into())
                    })
                },
            );
            let mut publication = journal(sink.clone()).publish_prepared_call(
                "operation".into(),
                ToolCallIdentity::provider("step".into(), "call".into()),
                "native".into(),
                serde_json::json!({}),
                vec![completion(&sink)],
                CancellationToken::new(),
                effect,
            );
            let mut cx = Context::from_waker(Waker::noop());
            let Poll::Ready(Ok(published)) = publication.as_mut().poll(&mut cx) else {
                panic!("establishment must finish without answer")
            };
            assert_eq!(published.prefix_sequences, vec![1]);
            let ToolContinuation::Approval(mut approval) = published.completion else {
                panic!("native approval must stay observable")
            };
            assert_eq!(approval.pending().dispatch.sequence, 7);
            assert!(Pin::new(&mut approval).poll(&mut cx).is_pending());
            assert!(!started.load(Ordering::SeqCst));
            assert!(!sink.settled.load(Ordering::SeqCst));
            answer_tx
                .send(InteractionOutcome::ServiceApprovalDecision {
                    decision,
                    committed_at: 1,
                })
                .unwrap();
            let Poll::Ready(mut executing) = Pin::new(&mut approval).poll(&mut cx) else {
                panic!("answer must produce original execution")
            };
            assert!(!started.load(Ordering::SeqCst));
            let Poll::Ready(result) = executing.as_mut().poll(&mut cx) else {
                panic!("original effect and settlement are ready")
            };
            assert_eq!(result.is_ok(), decision == Decision::Allow);
            assert_eq!(started.load(Ordering::SeqCst), decision == Decision::Allow);
            let committed = sink.committed.lock().unwrap();
            assert_eq!(
                committed
                    .iter()
                    .filter(|write| matches!(write.event().fact, Fact::ToolDispatched { .. }))
                    .count(),
                1
            );
            assert_eq!(
                committed
                    .iter()
                    .filter(|write| matches!(write.event().fact, Fact::ToolSettled { .. }))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn admission_ack_follows_real_t1_and_precedes_the_original_unsettled_effect() {
        let sink = Arc::new(Sink::default());
        let acknowledgments = Arc::new(Mutex::new(Vec::new()));
        let observed = acknowledgments.clone();
        let started = Arc::new(AtomicBool::new(false));
        let effect_started = started.clone();
        let released = Arc::new(AtomicBool::new(false));
        let effect_released = released.clone();
        let prior = completion(&sink);
        let expected_completion = prior.clone();
        let effect_sink = sink.clone();
        let effect = PreparedEffect::new(move |_| {
            Box::pin(async move {
                {
                    let committed = effect_sink.committed.lock().unwrap();
                    assert_eq!(committed[0].event(), expected_completion.event());
                    assert!(matches!(
                        committed[1].event().fact,
                        Fact::ToolDispatched { .. }
                    ));
                }
                effect_started.store(true, Ordering::SeqCst);
                poll_fn(|_| {
                    if effect_released.load(Ordering::SeqCst) {
                        Poll::Ready(Ok(serde_json::json!({"done":true}).into()))
                    } else {
                        Poll::Pending
                    }
                })
                .await
            })
        })
        .on_admission(move |admission| observed.lock().unwrap().push(admission));
        let mut call = journal(sink.clone()).invoke_prepared_output(
            "operation".into(),
            ToolCallIdentity::standalone("call".into()),
            "effect".into(),
            serde_json::json!({}),
            Some(prior),
            CancellationToken::new(),
            effect,
        );
        let mut context = Context::from_waker(Waker::noop());
        assert!(call.as_mut().poll(&mut context).is_pending());
        assert!(acknowledgments.lock().unwrap().is_empty());
        assert!(!started.load(Ordering::SeqCst));
        sink.dispatch_ready.store(true, Ordering::SeqCst);
        assert!(call.as_mut().poll(&mut context).is_pending());
        assert_eq!(
            *acknowledgments.lock().unwrap(),
            vec![EffectAdmission::Durable { sequence: 7 }]
        );
        assert!(started.load(Ordering::SeqCst));
        assert!(!sink.settled.load(Ordering::SeqCst));
        released.store(true, Ordering::SeqCst);
        assert!(matches!(
            call.as_mut().poll(&mut context),
            Poll::Ready(Ok(_))
        ));
        assert!(sink.settled.load(Ordering::SeqCst));
        assert_eq!(acknowledgments.lock().unwrap().len(), 1);
    }

    #[test]
    fn failed_or_abandoned_dispatch_acknowledges_no_native_start_without_claiming_rollback() {
        for reject in [false, true] {
            let sink = Arc::new(Sink {
                reject_dispatch: reject,
                ..Default::default()
            });
            let observed = Arc::new(Mutex::new(Vec::new()));
            let acknowledgments = observed.clone();
            let effect = PreparedEffect::new(|_| panic!("unadmitted effect must never execute"))
                .on_admission(move |admission| acknowledgments.lock().unwrap().push(admission));
            let mut call = journal(sink).invoke_prepared_output(
                "operation".into(),
                ToolCallIdentity::standalone("call".into()),
                "effect".into(),
                serde_json::json!({}),
                None,
                CancellationToken::new(),
                effect,
            );
            let mut context = Context::from_waker(Waker::noop());
            if reject {
                assert!(matches!(
                    call.as_mut().poll(&mut context),
                    Poll::Ready(Err(ToolError::Persistence(_)))
                ));
            } else {
                assert!(call.as_mut().poll(&mut context).is_pending());
            }
            drop(call);
            assert_eq!(*observed.lock().unwrap(), vec![EffectAdmission::NotStarted]);
        }
    }
    #[test]
    fn revoked_t1_preserves_completion_and_flush_failure_is_fatal() {
        for fail_flush in [false, true] {
            let sink = Arc::new(Sink {
                permission_revoked: true,
                fail_flush,
                ..Default::default()
            });
            let prior = completion(&sink);
            let expected = prior.clone();
            let mut call = journal(sink.clone()).invoke_prepared_output(
                "operation".into(),
                ToolCallIdentity::standalone("call".into()),
                "effect".into(),
                serde_json::json!({}),
                Some(prior),
                CancellationToken::new(),
                PreparedEffect::new(|_| panic!("revoked T1 must never start its effect")),
            );
            let mut context = Context::from_waker(Waker::noop());
            match call.as_mut().poll(&mut context) {
                Poll::Ready(Err(ToolError::Persistence(message))) if fail_flush => {
                    assert!(message.contains("permission grant is no longer current"));
                    assert!(message.contains("completion flush rejected"));
                }
                Poll::Ready(Err(ToolError::Failed(message))) if !fail_flush => {
                    assert_eq!(message, "permission grant is no longer current");
                    let committed = sink.committed.lock().unwrap();
                    assert_eq!(committed.len(), 1);
                    assert_eq!(committed[0].event(), expected.event());
                }
                _ => panic!("revoked T1 must preserve completion or report its failed flush"),
            }
        }
    }
}
