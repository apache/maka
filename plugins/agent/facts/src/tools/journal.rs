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
    pub completion: ToolFuture<T>,
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
                completion: Box::pin(async move { Err(ToolError::Failed(message)) }),
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
                completion: Box::pin(async move { completion.await.map(ToolOutput::into_json) }),
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
                        completion: Box::pin(async move { Err(failure) }),
                    });
                }
                Err(error) => return Err(ToolError::Persistence(error.to_string())),
            };
            drop(prefix);
            let prefix_sequences = sequence.prefix_sequences;
            effect.admitted(sequence.last_sequence);
            let completion: ToolFuture<ToolOutput> = Box::pin(async move {
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
                            format!(
                                "{message}; original service observation could not be persisted"
                            )
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
            });
            Ok(PublishedTool {
                prefix_sequences,
                completion,
            })
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
    fn publication_returns_actual_prefix_sequences_before_starting_the_effect() {
        let sink = Arc::new(Sink {
            dispatch_ready: AtomicBool::new(true),
            ..Default::default()
        });
        let started = Arc::new(AtomicBool::new(false));
        let effect_started = started.clone();
        let prefix = vec![completion(&sink), completion(&sink)];
        let mut publication = journal(sink.clone()).publish_prepared_output(
            "operation".into(),
            ToolCallIdentity::standalone("call".into()),
            "effect".into(),
            serde_json::json!({}),
            prefix,
            CancellationToken::new(),
            PreparedEffect::new(move |_| {
                Box::pin(async move {
                    effect_started.store(true, Ordering::SeqCst);
                    Ok(serde_json::json!({"done": true}).into())
                })
            }),
        );
        let mut context = Context::from_waker(Waker::noop());
        let Poll::Ready(Ok(mut published)) = publication.as_mut().poll(&mut context) else {
            panic!("ready T1 must publish without waiting for its effect");
        };
        assert_eq!(published.prefix_sequences, vec![1, 4]);
        assert!(!started.load(Ordering::SeqCst));
        assert!(!sink.settled.load(Ordering::SeqCst));
        assert!(matches!(
            published.completion.as_mut().poll(&mut context),
            Poll::Ready(Ok(_))
        ));
        assert!(started.load(Ordering::SeqCst));
        assert!(sink.settled.load(Ordering::SeqCst));
    }

    #[test]
    fn revoked_publication_reports_the_independent_prefix_receipt_without_dispatch() {
        let sink = Arc::new(Sink {
            permission_revoked: true,
            ..Default::default()
        });
        let mut publication = journal(sink.clone()).publish_prepared_output(
            "operation".into(),
            ToolCallIdentity::standalone("call".into()),
            "effect".into(),
            serde_json::json!({}),
            vec![completion(&sink), completion(&sink)],
            CancellationToken::new(),
            PreparedEffect::new(|_| panic!("revoked effect must remain unstarted")),
        );
        let mut context = Context::from_waker(Waker::noop());
        let Poll::Ready(Ok(mut published)) = publication.as_mut().poll(&mut context) else {
            panic!("known refusal must return its independent prefix receipt");
        };
        assert_eq!(published.prefix_sequences, vec![1, 8]);
        assert!(
            sink.committed
                .lock()
                .unwrap()
                .iter()
                .all(|write| !matches!(write.event().fact, Fact::ToolDispatched { .. }))
        );
        assert!(matches!(
            published.completion.as_mut().poll(&mut context),
            Poll::Ready(Err(ToolError::Failed(_)))
        ));
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
    fn preparation_rejection_preserves_the_complete_accepted_response() {
        let sink = Arc::new(Sink::default());
        let prior = completion(&sink);
        let expected = prior.clone();
        let mut rejected = journal(sink.clone()).reject(
            "operation".into(),
            ToolCallIdentity::standalone("call".into()),
            "effect".into(),
            serde_json::json!({}).into(),
            Some(prior),
            ToolRejection::Cancelled,
        );
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(
            rejected.as_mut().poll(&mut context),
            Poll::Ready(Err(ToolError::Failed(_)))
        ));
        let committed = sink.committed.lock().unwrap();
        assert_eq!(committed.len(), 2);
        assert_eq!(committed[0].event(), expected.event());
        assert!(matches!(
            &committed[1].event().fact,
            Fact::ToolRejected {
                reason: ToolRejection::Cancelled,
                ..
            }
        ));
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
