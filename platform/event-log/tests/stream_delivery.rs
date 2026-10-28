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
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::TextKind;
use maka_event_log::{EventLog, observation::StreamFact};
use serde_json::json;

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

fn observed(step: &str, observation: ModelEvent) -> Fact {
    Fact::ModelObserved {
        step_id: step.into(),
        event: observation,
    }
}

fn request(step: &str) -> Fact {
    Fact::ModelRequested {
        context_breakdown: None,
        item_acceptance: false,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: step.into(),
        model_id: "test".into(),
        source_scope: LogScope::Root,
        source_high_water: 0,
        source_digest: "fixture".into(),
        effective_source_digest: None,
        input_digest: "input".into(),
        route_identity: "route".into(),
    }
}

fn delta(text: &str) -> Fact {
    observed(
        "second",
        ModelEvent::PartDelta {
            id: "part".into(),
            text: text.into(),
            provider_options: None,
        },
    )
}

#[tokio::test]
async fn tool_input_delivery_counts_escaped_text_and_full_provider_identity() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("events.sqlite"))
        .await
        .unwrap();
    let append = async |fact| {
        log.append(&EventWrite::plain(event("session", fact)).unwrap())
            .await
            .unwrap()
    };
    append(Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Message {
            source_messages: Vec::new(),
            content: "".into(),
            request_fingerprint: None,
        },
    })
    .await;
    append(request("step")).await;
    // This is the full 4096-byte step:call budget. The original provider ID
    // remains opaque, including characters that expand sixfold in JSON.
    let call = "\u{1}".repeat(4091);
    let start = append(observed(
        "step",
        ModelEvent::ToolInputStarted {
            id: call.clone(),
            name: "Counter".into(),
            provider_executed: false,
        },
    ))
    .await;
    let text = "\0".repeat(1365);
    assert_eq!(serde_json::to_string(&text).unwrap().len(), 8192);
    let through = append(observed(
        "step",
        ModelEvent::ToolInputDelta {
            id: call.clone(),
            text: text.clone(),
        },
    ))
    .await;
    let page = log
        .session_stream_events("session", start, through, 32, 48 * 1024)
        .await
        .unwrap();
    assert_eq!(page.events.len(), 1);
    assert_eq!(
        page.events[0].fact,
        StreamFact::ToolInputDelta {
            step_id: "step".into(),
            tool_call_id: call,
            text,
        }
    );
    assert!(serde_json::to_vec(&page.events[0]).unwrap().len() <= 48 * 1024);
    assert_eq!(page.next_after, None);
}

#[tokio::test]
async fn giant_bodies_and_metadata_do_not_block_stream_delivery() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("events.sqlite"))
        .await
        .unwrap();
    let append = async |fact| {
        log.append(&EventWrite::plain((event("session", fact)).clone()).unwrap())
            .await
            .unwrap()
    };
    let opened = append(Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Message {
            source_messages: Vec::new(),
            content: "".into(),
            request_fingerprint: None,
        },
    })
    .await;
    let first_request = append(request("first")).await;
    let giant = "x".repeat(2 * 1024 * 1024);
    let completed = append(Fact::ModelCompleted {
        step_id: "first".into(),
        output: ModelStep {
            parts: vec![ModelPart::Text {
                text_kind: TextKind::Text,
                text: giant.clone(),
                provider_options: Some(json!({"large": giant})),
            }],
            finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
            usage: Default::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    })
    .await;
    let steered = append({
        let message = maka_agent_facts::input::DeliveredMessage {
            origin: None,
            message_id: "steering".into(),
            content: "s".repeat(64 * 1024).into(),
            submitted_content_digest: format!("sha256:{}", "b".repeat(64)),
        };
        let mut unprepared_content = message.content.clone();
        unprepared_content.preparation.clear();
        Fact::MessageSteered {
            source: Box::new(maka_agent_facts::message::RootSourceMessage {
                message: message.clone(),
                unprepared_content,
                submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                disposition: maka_agent_facts::message::MessageDisposition::Steering,
                submitted_intent: None,
            }),
            message: Box::new(message),
        }
    })
    .await;
    let second_request = append(request("second")).await;
    append(observed(
        "second",
        ModelEvent::ProviderToolResult {
            id: "unknown-provider-tool".into(),
            name: "provider-internal".into(),
            output: json!({"large": giant}),
            is_error: false,
            provider_options: None,
        },
    ))
    .await;
    let start = event(
        "session",
        observed(
            "second",
            ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Thinking,
                provider_options: Some(json!({"large": giant})),
            },
        ),
    );
    let started = log
        .append(&EventWrite::plain((start).clone()).unwrap())
        .await
        .unwrap();
    let delta_sequence = append(observed(
        "second",
        ModelEvent::PartDelta {
            id: "part".into(),
            text: "a😀\n\"中".into(),
            provider_options: Some(json!({"large": giant})),
        },
    ))
    .await;
    let finished = append(observed(
        "second",
        ModelEvent::PartFinished {
            id: "part".into(),
            provider_options: Some(json!({"large": giant})),
        },
    ))
    .await;
    let interrupted = append(Fact::ModelInterrupted {
        model_failure: None,
        diagnostic: None,
        step_id: "second".into(),
        status: maka_agent_facts::event::ModelInterruption::Failed,
    })
    .await;
    let terminal = append(Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed {
            model_failure: None,
            class: "provider".into(),
            message: None,
        },
    })
    .await;
    let page = log
        .session_stream_events("session", 0, terminal, 512, 4096)
        .await
        .unwrap();
    assert_eq!(
        page.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        [
            opened,
            first_request,
            completed,
            steered,
            second_request,
            started,
            delta_sequence,
            finished,
            interrupted,
            terminal
        ]
    );
    assert_eq!(page.events[5].id, start.id);
    assert_eq!(page.events[5].invocation, start.invocation);
    assert_eq!(
        page.events[6].fact,
        StreamFact::PartDelta {
            step_id: "second".into(),
            part_id: "part".into(),
            text: "a😀\n\"中".into()
        }
    );
    assert!(matches!(page.events[0].fact, StreamFact::InvocationOpened));
    assert!(matches!(page.events[1].fact, StreamFact::ContextChanged));
    assert!(matches!(page.events[4].fact, StreamFact::ContextChanged));
    assert!(matches!(page.events[2].fact, StreamFact::StepEnded { .. }));
    assert!(matches!(
        page.events[7].fact,
        StreamFact::PartFinished { .. }
    ));
    assert!(matches!(page.events[3].fact, StreamFact::MessageSteered));
    assert!(matches!(
        page.events[9].fact,
        StreamFact::InvocationEnded { .. }
    ));
    assert_eq!(page.through_sequence, terminal);
    assert_eq!(page.next_after, None);
    assert!(matches!(&page.events[8].fact,
        StreamFact::StepEnded { failed: true, interrupted, .. }
        if interrupted == std::slice::from_ref(&start.id)));
    assert!(matches!(&page.events[9].fact,
        StreamFact::InvocationEnded { failed: true, interrupted }
        if interrupted.is_empty()));
    // The derived interruption identities belong to the delivery byte budget.
    let bytes = serde_json::to_vec(&page.events[8]).unwrap().len();
    let soft = log
        .session_stream_events("session", finished, interrupted, 1, bytes - 1)
        .await
        .unwrap();
    assert_eq!(soft.events, page.events[8..9]);
    assert_eq!(soft.next_after, None);
    let exact = log
        .session_stream_events("session", finished, interrupted, 1, bytes)
        .await
        .unwrap();
    assert_eq!(exact.events, page.events[8..9]);
    assert_eq!(exact.next_after, None);
}

#[tokio::test]
async fn pages_obey_global_fences_and_never_skip_oversized_deltas() {
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
    let requested = log
        .append(&EventWrite::plain((event("session", request("second"))).clone()).unwrap())
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
    assert!(matches!(old.events[0].fact, StreamFact::ContextChanged));
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
}

#[tokio::test]
async fn soft_first_stream_and_raw_events_preserve_complete_fenced_records() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("singleton.sqlite"))
        .await
        .unwrap();
    let append = async |fact| {
        log.append(&EventWrite::plain(event("session", fact)).unwrap())
            .await
            .unwrap()
    };
    append(Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Message {
            source_messages: Vec::new(),
            content: "".into(),
            request_fingerprint: None,
        },
    })
    .await;
    append(request("second")).await;
    let mut start = event(
        "session",
        observed(
            "second",
            ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        ),
    );
    start.id = "original-start-".repeat(5000);
    let started = log
        .append(&EventWrite::plain(start.clone()).unwrap())
        .await
        .unwrap();
    let text = "完整😀\"".repeat(8000);
    let delta = event("session", delta(&text));
    let delta_sequence = log
        .append(&EventWrite::plain(delta.clone()).unwrap())
        .await
        .unwrap();
    let finished = append(observed(
        "second",
        ModelEvent::PartFinished {
            id: "part".into(),
            provider_options: None,
        },
    ))
    .await;
    let interrupted = append(Fact::ModelInterrupted {
        model_failure: None,
        diagnostic: None,
        step_id: "second".into(),
        status: maka_agent_facts::event::ModelInterruption::Failed,
    })
    .await;
    append(Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed {
            model_failure: None,
            class: "provider".into(),
            message: None,
        },
    })
    .await;
    let projected = log
        .session_stream_events("session", started, interrupted, 32, 48 * 1024)
        .await;
    let enriched = log
        .session_stream_events("session", finished, interrupted, 32, 48 * 1024)
        .await;
    let raw = log
        .session_events("session", started, interrupted, 32, 48 * 1024)
        .await;
    let foreign = log
        .session_stream_events("other", started, interrupted, 32, 48 * 1024)
        .await;
    let beyond = log
        .session_stream_events("session", 0, interrupted + 100, 32, 48 * 1024)
        .await;
    log.close().await.unwrap();
    let projected = projected.expect("first complete projected delta must progress");
    assert_eq!(projected.events.len(), 1);
    assert_eq!(projected.events[0].sequence, delta_sequence);
    assert!(
        matches!(&projected.events[0].fact, StreamFact::PartDelta { text: actual, .. } if actual==&text)
    );
    assert_eq!(projected.next_after, Some(delta_sequence));
    assert_eq!(projected.through_sequence, interrupted);
    let enriched = enriched.expect("first enriched boundary must keep every interruption ID");
    assert_eq!(enriched.events.len(), 1);
    assert!(
        matches!(&enriched.events[0].fact, StreamFact::StepEnded { interrupted: ids, .. } if ids==std::slice::from_ref(&start.id))
    );
    assert_eq!(enriched.events[0].sequence, interrupted);
    assert_eq!(enriched.next_after, None);
    let raw = raw.expect("first complete original event must progress");
    assert_eq!(raw.events.len(), 1);
    assert_eq!(raw.events[0].event, delta);
    assert_eq!(raw.next_after, Some(delta_sequence));
    assert_eq!(raw.through_sequence, interrupted);
    assert!(foreign.unwrap().events.is_empty());
    assert!(beyond.is_err());
}
