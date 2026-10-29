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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::recorded::ModelCompletion;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolRejection;
use maka_event_log::EventLog;
use serde_json::json;

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}

fn event(fact: Fact) -> RuntimeEvent {
    RuntimeEvent::new(invocation(), fact)
}

fn success(operation: &str, value: i64) -> EventWrite {
    EventWrite::tool_success(
        format!("{operation}-outcome"),
        std::time::SystemTime::now(),
        invocation(),
        operation.into(),
        json!(value).into(),
    )
    .unwrap()
    .0
}

async fn accepted(log: &EventLog, step: &str) {
    let prefix = log.prefix(100, 100_000).await.unwrap();
    log.append_batch(
        &([
            event(Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: step.into(),
                model_id: "model".into(),
                source_scope: LogScope::Root,
                source_high_water: prefix.high_water,
                source_digest: prefix.digest,
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            }),
            event(Fact::ModelCompleted {
                step_id: step.into(),
                output: ModelCompletion {
                    parts: vec![model_part(
                        "invocation",
                        step,
                        0,
                        ModelPart::ToolCall {
                            call: ModelToolCall {
                                id: "call-1".into(),
                                name: "tool".into(),
                                input: json!({}).into(),
                                provider_options: None,
                                provider_executed: false,
                            },
                        },
                    )],
                    finish_reason: ModelFinishReason::ToolCalls,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            }),
        ])
        .iter()
        .cloned()
        .map(EventWrite::plain)
        .collect::<Result<Vec<_>, _>>()
        .unwrap(),
    )
    .await
    .unwrap();
}

fn dispatched(step: &str) -> RuntimeEvent {
    event(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: format!("{step}:call-1"),
        call: ToolCallIdentity::provider(step.into(), "call-1".into()),
        name: "tool".into(),
        input: json!({}),
    })
}

#[tokio::test]
async fn provider_ids_can_repeat_across_steps_including_recovery_refusals() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.append(
        &EventWrite::plain(
            (event(Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "continue".into(),
                    request_fingerprint: None,
                },
            }))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    for step in ["step-a", "step-b"] {
        accepted(&log, step).await;
        log.append_batch(&[
            EventWrite::plain(dispatched(step)).unwrap(),
            success(&format!("{step}:call-1"), 1),
        ])
        .await
        .unwrap();
        assert!(
            log.append(&EventWrite::plain((dispatched(step)).clone()).unwrap())
                .await
                .is_err()
        );
    }
    // Reopening between acceptance and refusal must still permit recovery to
    // close this step, despite earlier steps using the same provider ID.
    accepted(&log, "step-c").await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let recovery = log
        .invocation_recovery(&invocation(), 10, 16_384)
        .await
        .unwrap();
    assert!(recovery.uncertain_operations.is_empty());
    assert_eq!(recovery.undispatched_calls.len(), 1);
    let pending = &recovery.undispatched_calls[0];
    assert_eq!(pending.operation_id, "step-c:call-1");
    let refused = event(Fact::ToolRejected {
        operation_id: pending.operation_id.clone(),
        call: pending.identity.clone(),
        name: pending.name.clone(),
        input: pending.input.clone(),
        reason: ToolRejection::Cancelled,
    });
    log.append(&EventWrite::plain((refused).clone()).unwrap())
        .await
        .unwrap();
    assert!(
        log.append(&EventWrite::plain((dispatched("step-c")).clone()).unwrap())
            .await
            .is_err()
    );
    let mut duplicate = refused.clone();
    duplicate.id = "new-event-same-call".into();
    assert!(
        log.append(&EventWrite::plain((duplicate).clone()).unwrap())
            .await
            .is_err()
    );

    accepted(&log, "step-d").await;
    let mut next_refused = refused.clone();
    next_refused.id = "new-event-next-step".into();
    if let Fact::ToolRejected {
        operation_id, call, ..
    } = &mut next_refused.fact
    {
        *operation_id = "step-d:call-1".into();
        *call = ToolCallIdentity::provider("step-d".into(), "call-1".into());
    }
    log.append(&EventWrite::plain((next_refused).clone()).unwrap())
        .await
        .unwrap();
    accepted(&log, "step-e").await;
    let last_dispatch = dispatched("step-e");
    log.append(&EventWrite::plain((last_dispatch).clone()).unwrap())
        .await
        .unwrap();
    // Cross-origin collisions remain forbidden, even under a new operation ID.
    let mut hidden = dispatched("step-e");
    if let Fact::ToolDispatched {
        operation_id, call, ..
    } = &mut hidden.fact
    {
        *operation_id = "standalone-operation".into();
        *call = ToolCallIdentity::standalone("call-1".into());
    }
    assert!(
        log.append(&EventWrite::plain((hidden).clone()).unwrap())
            .await
            .is_err()
    );
    log.append_batch(&[
        success("step-e:call-1", 2),
        EventWrite::plain(event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .unwrap(),
    ])
    .await
    .unwrap();
    let prefix = log.prefix(100, 100_000).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let recovered = log
        .invocation_recovery(&invocation(), 10, 16_384)
        .await
        .unwrap();
    assert!(recovered.undispatched_calls.is_empty());
    assert!(recovered.uncertain_operations.is_empty());
    let commits = log.subscribe_commits();
    log.append_batch(
        &([refused, next_refused, last_dispatch])
            .iter()
            .cloned()
            .map(EventWrite::plain)
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(!commits.has_changed().unwrap());
    assert_eq!(
        log.prefix(100, 100_000).await.unwrap().digest,
        prefix.digest
    );
    log.close().await.unwrap();
}

fn model_part(
    invocation: &str,
    step: &str,
    ordinal: u64,
    part: maka_agent_facts::model::ModelPart,
) -> maka_agent_facts::model::recorded::CompletionPart {
    use maka_agent_facts::model::{
        ModelPart,
        recorded::{CompletionPart, ModelPartRecord},
    };
    let message_id = match &part {
        ModelPart::ToolCall { call } => {
            maka_agent_facts::tool_call::tool_use_id(invocation, &format!("{step}:{}", call.id))
        }
        _ => uuid::Uuid::new_v4().to_string(),
    };
    CompletionPart::Own(ModelPartRecord {
        ordinal,
        message_id,
        started_at: std::time::SystemTime::now(),
        provider_part_id: None,
        part: std::sync::Arc::new(part),
    })
}

#[tokio::test]
async fn recorded_provider_parts_keep_original_bodies_and_reject_cross_step_refs_atomically() {
    use maka_agent_facts::{
        context::ModelPurpose,
        history::semantic::{SemanticKind, SemanticRow},
        model::{
            ModelEvent,
            assembly::{AttemptBinding, AttemptWriter, PartReceipt},
            prompt_source::source::{Allocate, ByteSource, ChargedBuffer, SourceBudget},
            recorded::{CompletionPart, ModelObservation, RecordedPartRef},
        },
    };
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    use std::sync::Arc;
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum.max(7)], ())) })
        }
    }
    async fn read(source: Arc<dyn ByteSource>) -> Vec<u8> {
        let mut cursor = source.open(Arc::new(Budget));
        let mut bytes = Vec::new();
        loop {
            let chunk = cursor
                .read_chunk(ChargedBuffer::new(vec![0; 7], ()))
                .await
                .unwrap();
            bytes.extend_from_slice(&chunk.buffer.as_ref()[..chunk.bytes_read]);
            if chunk.eof {
                return bytes;
            }
        }
    }
    for item_acceptance in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("root");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        };
        let root = RootStore::open(Arc::new(RootOwner::create(&path, &namespaces).unwrap()))
            .await
            .unwrap();
        root.create_session("session", "fixture", &json!({}), 1)
            .await
            .unwrap();
        let session = root.session("session").await.unwrap();
        let execution = session.execution_scope(None).await.unwrap().accept();
        let log = execution.store();
        log.append(
            &EventWrite::plain(event(Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: vec![],
                    content: "continue".into(),
                    request_fingerprint: None,
                },
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let prefix = log
            .scoped_prefix(
                LogScope::Session {
                    id: "session".into(),
                },
                100,
                100_000,
            )
            .await
            .unwrap();
        let requested = |step: &str| {
            EventWrite::plain(event(Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance,
                purpose: ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: step.into(),
                model_id: "model".into(),
                source_scope: prefix.scope.clone(),
                source_high_water: prefix.high_water,
                source_digest: prefix.digest.clone(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            }))
            .unwrap()
        };
        let sequence = log.append(&requested("first")).await.unwrap();
        let call = ModelToolCall {
            id: "call-1".into(),
            name: "tool".into(),
            input: json!({"query":"中\n"}).into(),
            provider_options: None,
            provider_executed: true,
        };
        let result = json!({"body":"canonical result 中\n"});
        let expected = [
            ModelPart::ToolCall { call: call.clone() },
            ModelPart::ToolResult {
                id: call.id.clone(),
                name: call.name.clone(),
                output: result.clone(),
                is_error: false,
                provider_options: None,
            },
        ];
        let mut writer = AttemptWriter::new(
            AttemptBinding {
                invocation: invocation(),
                step_id: "first".into(),
                purpose: ModelPurpose::Main,
            },
            item_acceptance,
        )
        .unwrap();
        writer.fenced(sequence);
        let mut originals = Vec::new();
        for ingress in [
            ModelEvent::ToolCall(call.clone()),
            ModelEvent::ProviderToolResult {
                id: call.id.clone(),
                name: call.name.clone(),
                output: result,
                is_error: false,
                provider_options: None,
            },
            ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(3),
                    output_tokens: Some(5),
                    ..Default::default()
                },
                provider_options: None,
            },
        ] {
            let writes: Vec<_> = writer
                .push(ingress, std::time::SystemTime::now())
                .unwrap()
                .into_iter()
                .map(|observation| {
                    EventWrite::plain(event(Fact::ModelObserved {
                        step_id: "first".into(),
                        event: observation,
                    }))
                    .unwrap()
                })
                .collect();
            let sequences = log.append_batch(&writes).await.unwrap();
            for (write, sequence) in writes.into_iter().zip(sequences) {
                if let Fact::ModelObserved {
                    event: ModelObservation::Part(record),
                    ..
                } = &write.event().fact
                {
                    assert_eq!(
                        record.provider_part_id.as_deref(),
                        Some("call-1"),
                        "the real matching call/result share a provider ID"
                    );
                    writer.recorded(PartReceipt {
                        part: RecordedPartRef {
                            event_id: write.event().id.clone(),
                            ordinal: record.ordinal,
                        },
                        sequence,
                    });
                    originals.push(write);
                } else {
                    writer.fenced(sequence);
                }
            }
        }
        assert!(writer.completed().unwrap().local_call_ids().is_empty());
        let output = writer.completed().unwrap().completion();
        assert_eq!(output.usage.input_tokens, Some(3));
        assert_eq!(output.usage.output_tokens, Some(5));
        assert_eq!(output.parts.len(), 2);
        for (ordinal, part) in output.parts.iter().enumerate() {
            let CompletionPart::Ref(reference) = part else {
                panic!("terminal must reference the actual original provider body");
            };
            assert_eq!(reference.ordinal, ordinal as u64);
            assert_eq!(reference.event_id, originals[ordinal].event().id);
        }
        let completed = |step: &str, output: ModelCompletion| {
            EventWrite::plain(event(Fact::ModelCompleted {
                step_id: step.into(),
                output,
            }))
            .unwrap()
        };
        log.append(&completed("first", output.clone()))
            .await
            .unwrap();
        let mut local_dispatch = dispatched("first");
        if let Fact::ToolDispatched { input, .. } = &mut local_dispatch.fact {
            *input = call.input.as_json().unwrap().clone();
        }
        assert!(
            log.append(&EventWrite::plain(local_dispatch).unwrap())
                .await
                .is_err(),
            "matching provider-executed arguments still cannot grant local dispatch"
        );
        log.append(&requested("second")).await.unwrap();
        let empty_output = ModelCompletion {
            parts: vec![],
            ..output.clone()
        };
        let second_finished = EventWrite::plain(event(Fact::ModelObserved {
            step_id: "second".into(),
            event: ModelObservation::Finished {
                reason: output.finish_reason,
                usage: output.usage.clone(),
                provider_options: output.provider_options.clone(),
            },
        }))
        .unwrap();
        let before = log
            .scoped_prefix(prefix.scope.clone(), 100, 100_000)
            .await
            .unwrap();
        let metadata = EventWrite::plain(event(Fact::ModelObserved {
            step_id: "second".into(),
            event: ModelObservation::ResponseMetadata {
                id: Some("must-roll-back".into()),
                model: None,
                timestamp: None,
            },
        }))
        .unwrap();
        let rejected = log
            .append_batch(&[
                metadata,
                second_finished.clone(),
                completed("second", output),
            ])
            .await
            .expect_err("another step cannot borrow original part references");
        assert!(
            matches!(rejected, maka_agent_facts::event::CommitError::Rejected(ref message)
            if message.contains("reference does not name this invocation's original step part")),
            "a valid terminal witness must reach the actual reference boundary: {rejected}"
        );
        let after = log
            .scoped_prefix(prefix.scope.clone(), 100, 100_000)
            .await
            .unwrap();
        assert_eq!(
            (after.high_water, after.digest),
            (before.high_water, before.digest)
        );
        log.append_batch(&[
            second_finished,
            completed("second", empty_output),
            EventWrite::plain(event(Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            }))
            .unwrap(),
        ])
        .await
        .unwrap();
        let view = log.read_model_view("session", None).await.unwrap();
        let captured = log.capture_source(view.selection).await.unwrap();
        let mut cursor = None;
        let mut visible = Vec::new();
        loop {
            let mut page = captured
                .metadata_page(cursor, ChargedBuffer::new(vec![0; 4096], ()))
                .await
                .unwrap();
            for index in 0..page.len() {
                let row = page.row(index).unwrap();
                let metadata: SemanticRow = serde_json::from_slice(
                    &read(
                        captured
                            .byte_source(&captured.metadata_source(&row).unwrap())
                            .unwrap(),
                    )
                    .await,
                )
                .unwrap();
                if matches!(metadata.kind, SemanticKind::AssistantPart { ref step_id, .. } if step_id == "first")
                {
                    let source = captured.describe_payload(&row).unwrap().unwrap();
                    visible.push(
                        serde_json::from_slice::<ModelPart>(
                            &read(captured.byte_source(&source).unwrap()).await,
                        )
                        .unwrap(),
                    );
                }
            }
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            visible, expected,
            "semantic replay retains call/result order and full bodies in both modes"
        );
        drop(captured);
        drop(log);
        execution.finish();
        root.close().await.unwrap();
        let root = RootStore::open(Arc::new(RootOwner::open(&path, &namespaces).unwrap()))
            .await
            .unwrap();
        let log = root.session("session").await.unwrap();
        let recovered = log.scoped_prefix(prefix.scope, 100, 100_000).await.unwrap();
        assert!(
            !recovered
                .events
                .iter()
                .any(|stored| matches!(stored.event.fact, Fact::ToolDispatched { .. }))
        );
        for (expected, original) in expected.iter().zip(&originals) {
            let stored = recovered
                .events
                .iter()
                .find(|stored| stored.event.id == original.event().id)
                .unwrap();
            let Fact::ModelObserved {
                event: ModelObservation::Part(record),
                ..
            } = &stored.event.fact
            else {
                panic!("original canonical part missing");
            };
            assert_eq!(record.provider_part_id.as_deref(), Some("call-1"));
            assert_eq!(record.part.as_ref(), expected);
        }
        root.close().await.unwrap();
    }
}
