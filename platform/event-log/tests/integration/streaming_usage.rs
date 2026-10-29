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
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::TextKind;
use maka_agent_facts::model::assembly::{AttemptBinding, AttemptWriter, PartReceipt};
use maka_agent_facts::model::recorded::{ModelObservation, RecordedPartRef};
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_event_log::EventLog;
use serde_json::json;
use std::sync::Arc;

fn event(fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "s".into(),
            turn_id: "t".into(),
            run_id: "r".into(),
            invocation_id: "i".into(),
        },
        fact,
    ))
    .unwrap()
}
async fn request(log: &EventLog, step: &str, items: bool) {
    let source = log
        .scoped_prefix(LogScope::Session { id: "s".into() }, 100, 128 * 1024)
        .await
        .unwrap();
    let composition = Arc::new(
        maka_agent_facts::composition::RequestComposition {
            system_prompt: None,
            dynamic_context: vec![],
            tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"tools"),
            tools: vec![],
            provider_options: None,
            max_output_tokens: None,
            sources: vec![],
        }
        .freeze()
        .unwrap(),
    );
    let write = event(Fact::ModelRequested {
        context_breakdown: None,
        item_acceptance: items,
        step_id: step.into(),
        model_id: "m".into(),
        source_scope: source.scope,
        source_high_water: source.high_water,
        source_digest: source.digest,
        input_digest: "input".into(),
        route_identity: "route".into(),
        checkpoint_event_id: None,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        effective_source_digest: None,
    });
    log.append(&write.with_composition(composition).unwrap())
        .await
        .unwrap();
}
fn writer(step: &str) -> AttemptWriter {
    AttemptWriter::new(
        AttemptBinding {
            invocation: Invocation {
                session_id: "s".into(),
                turn_id: "t".into(),
                run_id: "r".into(),
                invocation_id: "i".into(),
            },
            step_id: step.into(),
            purpose: maka_agent_facts::context::ModelPurpose::Main,
        },
        true,
    )
    .unwrap()
}
async fn observe(log: &EventLog, step: &str, builder: &mut AttemptWriter, observation: ModelEvent) {
    for observation in builder
        .push(observation, std::time::SystemTime::now())
        .unwrap()
    {
        let ordinal = match &observation {
            ModelObservation::Part(record) => Some(record.ordinal),
            _ => None,
        };
        let write = event(Fact::ModelObserved {
            step_id: step.into(),
            event: observation,
        });
        let sequence = log.append(&write).await.unwrap();
        if let Some(ordinal) = ordinal {
            builder.recorded(PartReceipt {
                part: RecordedPartRef {
                    event_id: write.event().id.clone(),
                    ordinal,
                },
                sequence,
            });
        } else {
            builder.fenced(sequence);
        }
    }
}
async fn complete(log: &EventLog, step: &str, mut builder: AttemptWriter, input: u64) {
    observe(
        log,
        step,
        &mut builder,
        ModelEvent::Finished {
            reason: ModelFinishReason::Stop,
            usage: ModelUsage {
                input_tokens: Some(input),
                output_tokens: Some(0),
                ..Default::default()
            },
            provider_options: None,
        },
    )
    .await;
    log.append(&event(Fact::ModelCompleted {
        step_id: step.into(),
        output: builder.completed().unwrap().completion(),
    }))
    .await
    .unwrap();
}
#[tokio::test]
async fn early_tool_results_and_retained_interrupted_items_invalidate_stale_usage() {
    for early_tool in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let log = EventLog::open(&dir.path().join("events.sqlite"))
            .await
            .unwrap();
        log.append(&event(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "question".into(),
                request_fingerprint: None,
                source_messages: vec![],
            },
        }))
        .await
        .unwrap();
        request(&log, "first", true).await;
        let mut builder = writer("first");
        if early_tool {
            observe(
                &log,
                "first",
                &mut builder,
                ModelEvent::ToolCall(ModelToolCall {
                    id: "call".into(),
                    name: "read".into(),
                    input: json!({}).into(),
                    provider_options: None,
                    provider_executed: false,
                }),
            )
            .await;
            log.append(&event(Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "first:call".into(),
                call: ToolCallIdentity::provider("first".into(), "call".into()),
                name: "read".into(),
                input: json!({}),
            }))
            .await
            .unwrap();
            log.append(&event(Fact::ToolSettled {
                operation_id: "first:call".into(),
                outcome: ToolOutcome::Failed {
                    message: "large model-visible result".repeat(100),
                },
            }))
            .await
            .unwrap();
        }
        complete(&log, "first", builder, 10).await;
        if !early_tool {
            assert_eq!(log.context_usage("s").await.unwrap().1.unwrap().tokens, 10);
            request(&log, "interrupted", true).await;
            let mut builder = writer("interrupted");
            for observation in [
                ModelEvent::PartStarted {
                    id: "text".into(),
                    text_kind: TextKind::Text,
                    provider_options: None,
                },
                ModelEvent::PartDelta {
                    id: "text".into(),
                    text: "retained text".repeat(100),
                    provider_options: None,
                },
                ModelEvent::PartFinished {
                    id: "text".into(),
                    provider_options: None,
                },
            ] {
                observe(&log, "interrupted", &mut builder, observation).await;
            }
            log.append(&event(Fact::ModelInterrupted {
                partial: builder.partial(),
                model_failure: None,
                diagnostic: None,
                step_id: "interrupted".into(),
                status: ModelInterruption::RetryableFailure,
            }))
            .await
            .unwrap();
        }
        assert_eq!(
            log.context_usage("s").await.unwrap().1,
            Some(maka_event_log::context::ContextUsage {
                tokens: 10,
                approximate: false,
                last_known: true,
            }),
            "unknown additions retain an explicitly last-known baseline"
        );
        request(&log, "fresh", true).await;
        complete(&log, "fresh", writer("fresh"), 200).await;
        assert_eq!(log.context_usage("s").await.unwrap().1.unwrap().tokens, 200);
        assert!(!log.context_usage("s").await.unwrap().1.unwrap().last_known);
        log.append(&event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .await
        .unwrap();
    }
}
