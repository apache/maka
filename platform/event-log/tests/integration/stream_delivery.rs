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

use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationOutcome, LogScope, RuntimeEvent},
    model::{
        ModelFinishReason, ModelPart, TextKind,
        recorded::{
            CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, RecordedPartRef,
        },
    },
};
use maka_event_log::{EventLog, observation::StreamFact};
use serde_json::json;
use std::sync::Arc;

fn event(session: &str, fact: Fact) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{session}"),
            run_id: format!("run-{session}"),
            invocation_id: format!("invocation-{session}"),
        },
        fact,
    )
}

fn opening() -> Fact {
    Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Message {
            source_messages: Vec::new(),
            content: "".into(),
            request_fingerprint: None,
        },
    }
}

fn request(item_acceptance: bool) -> Fact {
    Fact::ModelRequested {
        source_capture: maka_agent_facts::event::SourceCapture {
            publication_watermark: 0,
            prior_unknown: false,
        },
        context_breakdown: None,
        item_acceptance,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: "step".into(),
        model_id: "test".into(),
        source_scope: LogScope::Root,
        source_high_water: 0,
        source_digest: "fixture".into(),
        effective_source_digest: None,
        input_digest: "input".into(),
        route_identity: "route".into(),
    }
}

fn executor_start() -> Fact {
    Fact::ExecutorStarted {
        settings: Default::default(),
        binding: maka_agent_facts::executor::Binding {
            executor_id: "example".to_owned().try_into().unwrap(),
            package_id: "example".into(),
            entry_id: "example".into(),
            activation: "activation".into(),
        },
    }
}

fn delta(text: &str) -> Fact {
    Fact::ExecutorObserved {
        output: maka_agent_facts::executor::Output::OutputDelta { text: text.into() },
    }
}

#[tokio::test]
async fn committed_model_parts_keep_large_bodies_and_metadata_out_of_delivery() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let append = async |fact| {
        log.append(&EventWrite::plain(event("session", fact)).unwrap())
            .await
            .unwrap()
    };
    let opened = append(opening()).await;
    let requested = append(request(true)).await;
    let giant = "x".repeat(2 * 1024 * 1024);
    append(Fact::ModelObserved {
        step_id: "step".into(),
        event: ModelObservation::ProviderOptions {
            provider_part_id: Some("part".into()),
            options: Arc::new(json!({"opaque": giant})),
        },
    })
    .await;
    let record = ModelPartRecord {
        ordinal: 0,
        message_id: "original-message".into(),
        started_at: std::time::UNIX_EPOCH,
        provider_part_id: Some("part".into()),
        part: Arc::new(ModelPart::Text {
            text_kind: TextKind::Thinking,
            text: giant.clone().into(),
            provider_options: Some(Arc::new(json!({"opaque": giant}))),
        }),
    };
    let original = event(
        "session",
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::Part(record.clone()),
        },
    );
    let committed = log
        .append(&EventWrite::plain(original.clone()).unwrap())
        .await
        .unwrap();
    append(Fact::ModelObserved {
        step_id: "step".into(),
        event: ModelObservation::Finished {
            reason: ModelFinishReason::Stop,
            usage: Default::default(),
            provider_options: None,
        },
    })
    .await;
    let completed = append(Fact::ModelCompleted {
        step_id: "step".into(),
        output: ModelCompletion {
            parts: vec![CompletionPart::Ref(RecordedPartRef {
                event_id: original.id.clone(),
                ordinal: 0,
            })],
            finish_reason: ModelFinishReason::Stop,
            usage: Default::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    })
    .await;
    let terminal = append(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    })
    .await;
    let page = log
        .session_stream_events("session", 0, terminal, 512, 4096)
        .await
        .unwrap();
    assert_eq!(
        page.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        [opened, requested, committed, completed, terminal]
    );
    assert_eq!(page.events[2].id, original.id);
    assert_eq!(
        page.events[2].fact,
        StreamFact::ModelPartCommitted {
            step_id: "step".into(),
            message_id: record.message_id.clone(),
            ordinal: 0,
        }
    );
    assert!(matches!(
        page.events[3].fact,
        StreamFact::StepEnded {
            completed: true,
            failed: false,
            ..
        }
    ));
    assert_eq!(page.through_sequence, terminal);
    assert_eq!(page.next_after, None);
    assert!(serde_json::to_vec(&page.events).unwrap().len() < 4096);
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let reopened = log
        .session_stream_events("session", requested, terminal, 512, 4096)
        .await
        .unwrap();
    assert_eq!(reopened.events, page.events[2..]);
    let canonical = log
        .session_events("session", committed - 1, committed, 1, 4096)
        .await
        .unwrap();
    assert_eq!(canonical.events[0].event, original);
    assert!(
        log.session_stream_events("other", 0, terminal, 512, 4096)
            .await
            .unwrap()
            .events
            .is_empty()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn pages_obey_global_fences_and_never_skip_oversized_executor_deltas() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("events.sqlite"))
        .await
        .unwrap();
    let opened = log
        .append(
            &EventWrite::plain(
                (event(
                    "session",
                    Fact::InvocationOpened {
                        configuration: Some(Box::new(
                            maka_agent_facts::execution::InvocationConfiguration {
                                language: maka_agent_facts::language::Language::En,
                                compaction_prompt: None,
                                workspace_origin:
                                    maka_agent_facts::execution::WorkspaceOrigin::Selected,
                                approval_policy:
                                    maka_agent_facts::execution::ApprovalPolicy::OnRequest,
                                boundary_revision: 0,
                                cwd: temp.path().to_string_lossy().into_owned(),
                                workspace_binding: None,
                                workspace_identity: None,
                                model: None,
                                editing_tools: None,
                                tool_discovery: false,
                                tool_composition: None,
                                system_prompt: None,
                                thinking_level: None,
                                sandbox_mode:
                                    maka_agent_facts::execution::SandboxMode::WorkspaceWrite,
                                collaboration_mode:
                                    maka_agent_facts::execution::CollaborationMode::Agent,
                                orchestration_mode: Default::default(),
                                tool_mode: maka_agent_facts::execution::ToolMode::Direct,
                                code_language: Default::default(),
                            },
                        )),
                        input: maka_agent_facts::input::InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let requested = log
        .append(&EventWrite::plain((event("session", executor_start())).clone()).unwrap())
        .await
        .unwrap();
    let first = log
        .append(&EventWrite::plain((event("session", delta("😀"))).clone()).unwrap())
        .await
        .unwrap();
    let gap = log
        .append(
            &EventWrite::plain(
                (event(
                    "other",
                    Fact::InvocationOpened {
                        configuration: None,
                        input: maka_agent_facts::input::InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let large = log
        .append(&EventWrite::plain((event("session", delta(&"中".repeat(4096)))).clone()).unwrap())
        .await
        .unwrap();
    let last = log
        .append(&EventWrite::plain((event("session", delta("last"))).clone()).unwrap())
        .await
        .unwrap();
    let old = log
        .session_stream_events("session", opened, gap, 1, 1024)
        .await
        .unwrap();
    assert_eq!(old.events.len(), 1);
    assert_eq!(old.events[0].sequence, requested);
    assert!(matches!(old.events[0].fact, StreamFact::ExecutorStarted));
    assert_eq!(old.next_after, Some(requested));
    assert_eq!(old.through_sequence, gap);
    let limited = log
        .session_stream_events("session", opened, last, 512, 1024)
        .await
        .unwrap();
    assert_eq!(limited.events.len(), 2);
    assert_eq!(limited.next_after, Some(first));
    let soft = log
        .session_stream_events("session", first, last, 512, 1024)
        .await
        .unwrap();
    assert_eq!(soft.events.len(), 1);
    assert_eq!(soft.events[0].sequence, large);
    assert_eq!(
        soft.events[0].fact,
        StreamFact::ExecutorDelta {
            text_kind: TextKind::Text,
            text: "中".repeat(4096),
        }
    );
    assert_eq!(soft.next_after, Some(large));
    let next = log
        .session_stream_events("session", first, last, 1, 32 * 1024)
        .await
        .unwrap();
    assert_eq!(next.events[0].sequence, large);
    assert_eq!(next.next_after, Some(large));
    let tail = log
        .session_stream_events("session", large, last, 1, 1024)
        .await
        .unwrap();
    assert_eq!(tail.events[0].sequence, last);
    assert_eq!(
        tail.events[0].fact,
        StreamFact::ExecutorDelta {
            text_kind: TextKind::Text,
            text: "last".into(),
        }
    );
    assert_eq!(tail.next_after, None);
    for (after, through, count, bytes) in [
        (0, last + 1, 1, 1024),
        (last, 0, 1, 1024),
        (0, last, 0, 1024),
        (0, last, 513, 1024),
        (0, last, 1, 0),
    ] {
        assert!(
            log.session_stream_events("session", after, through, count, bytes)
                .await
                .is_err()
        );
    }
    log.close().await.unwrap();
}
