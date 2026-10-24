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
use maka_agent_facts::input::DeliveredMessage;
use maka_agent_facts::message::MessageDisposition;
use maka_agent_facts::message::Placement;
use maka_agent_facts::message::RootSourceMessage;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::TextKind;
use maka_event_log::{
    message_resolution::{MessageExecution, MessageResolution},
    observation::StreamFact,
    transcript::{TranscriptDirection, TranscriptRead},
};
use serde_json::{Value, json};

pub(super) async fn seal(
    log: &EventLog,
    source: &RuntimeEvent,
) -> (maka_agent_facts::handoff::HandoffPause, SessionBase) {
    use maka_agent_facts::handoff::HandoffIntent;
    use maka_agent_facts::handoff::HandoffPause;
    let Fact::InvocationOpened { input, .. } = &source.fact else {
        unreachable!()
    };
    let base = if let Some(claim) = input.inherited_claim() {
        claim.base.clone()
    } else {
        let context = log
            .context_before_run(&source.invocation, 100, 65536)
            .await
            .unwrap();
        SessionBase {
            high_water: context.source_evidence.high_water,
            digest: context.source_evidence.digest,
        }
    };
    let root = match input {
        InvocationInput::Handoff { pause, .. } => &pause.intent.root_run_id,
        _ => &source.invocation.run_id,
    };
    let next = format!("{}-next", source.invocation.run_id);
    let pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: next.clone(),
            host_epoch: "host".into(),
            root_run_id: root.clone(),
            successor_run_id: next.clone(),
            successor_invocation_id: format!("invocation-{next}"),
            claim_id: next,
        },
        execution: super::handoff::execution(),
    };
    append(
        log,
        &RuntimeEvent::new(
            source.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        ),
    )
    .await;
    (pause, base)
}

async fn successor(log: &EventLog, source: &RuntimeEvent) -> RuntimeEvent {
    let (pause, base) = seal(log, source).await;
    let Fact::InvocationOpened { configuration, .. } = &source.fact else {
        unreachable!()
    };
    let claim = claim(log, &pause.intent.claim_id, source, base).await;
    let next = RuntimeEvent::new(
        pause.intent.successor(&source.invocation),
        Fact::InvocationOpened {
            configuration: configuration.clone(),
            input: InvocationInput::Handoff {
                claim: Box::new(claim),
                pause: Box::new(pause),
            },
        },
    );
    append(log, &next).await;
    next
}

#[tokio::test]
async fn handoff_output_keeps_one_public_identity_and_all_physical_evidence_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let mut root = opening("root", None);
    let Fact::InvocationOpened {
        input:
            InvocationInput::Message {
                content,
                source_messages,
                ..
            },
        ..
    } = &mut root.fact
    else {
        unreachable!()
    };
    source_messages.push(RootSourceMessage {
        unprepared_content: content.clone(),
        message: DeliveredMessage {
            origin: None,
            message_id: "user-message".into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
        },
        submitted_placement: Placement::NextTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    });
    append(&log, &root).await;
    let mut current = root.clone();
    for text in ["first answer", "second answer"] {
        current = successor(&log, &current).await;
        let step_id = format!("step-{}", current.invocation.run_id);
        if text == "first answer" {
            let content = maka_agent_facts::input::MessageInput::from("additional direction");
            append(
                &log,
                &RuntimeEvent::new(
                    current.invocation.clone(),
                    Fact::MessageSteered {
                        source: None,
                        message: Box::new(DeliveredMessage {
                            origin: None,
                            message_id: "steered-message".into(),
                            submitted_content_digest: content.content_digest().unwrap(),
                            content,
                        }),
                    },
                ),
            )
            .await;
        }
        let context = log
            .capture_model_context(
                "session",
                Some(&current.invocation.invocation_id),
                100_000,
                64 * 1024 * 1024,
            )
            .await
            .unwrap();
        append(
            &log,
            &RuntimeEvent::new(
                current.invocation.clone(),
                Fact::ModelRequested {
                    context_breakdown: None,
                    item_acceptance: false,
                    purpose: maka_agent_facts::context::ModelPurpose::Main,
                    context: None,
                    checkpoint_event_id: None,
                    step_id: step_id.clone(),
                    model_id: "test".into(),
                    source_scope: context.source_evidence.scope,
                    source_high_water: context.source_evidence.high_water,
                    source_digest: context.source_evidence.digest,
                    effective_source_digest: Some(context.effective_source_digest),
                    input_digest: digest('a'),
                    route_identity: digest('b'),
                },
            ),
        )
        .await;
        for event in [
            ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
            ModelEvent::PartDelta {
                id: "part".into(),
                text: text.into(),
                provider_options: None,
            },
            ModelEvent::PartFinished {
                id: "part".into(),
                provider_options: None,
            },
        ] {
            append(
                &log,
                &RuntimeEvent::new(
                    current.invocation.clone(),
                    Fact::ModelObserved {
                        step_id: step_id.clone(),
                        event,
                    },
                ),
            )
            .await;
        }
        append(
            &log,
            &RuntimeEvent::new(
                current.invocation.clone(),
                Fact::ModelCompleted {
                    step_id,
                    output: ModelStep {
                        parts: vec![ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: text.into(),
                            provider_options: None,
                        }],
                        finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                        usage: Default::default(),
                        provider_options: None,
                        response_id: None,
                        model: None,
                        timestamp: None,
                    },
                },
            ),
        )
        .await;
    }
    let terminal = append(
        &log,
        &RuntimeEvent::new(
            current.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            },
        ),
    )
    .await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let session = log.get_session::<Value>("session").await.unwrap().unwrap();
    assert_eq!(
        session.last_message.unwrap().preview.as_deref(),
        Some("second answer")
    );
    assert_eq!(
        log.latest_continuation_candidate("session").await.unwrap(),
        Some(current.invocation.run_id.clone())
    );
    assert_eq!(
        log.message_resolutions("session", &["user-message".into()])
            .await
            .unwrap(),
        vec![MessageResolution::Owned {
            message_id: "user-message".into(),
            invocation: root.invocation.clone()
        },]
    );
    let MessageExecution::Owned(owner) = log
        .message_execution("session", "user-message")
        .await
        .unwrap()
    else {
        panic!("exclusive owner lost");
    };
    assert_eq!(
        owner.invocation, current.invocation,
        "control must follow the physical owner"
    );
    let mut after = 0;
    let mut texts = Vec::new();
    loop {
        let page = log
            .session_stream_events("session", after, terminal, 2, 4096)
            .await
            .unwrap();
        for event in page.events {
            assert_eq!(event.root_run_id, root.invocation.run_id);
            if let StreamFact::PartDelta { text, .. } = event.fact {
                assert_ne!(event.invocation.run_id, root.invocation.run_id);
                texts.push(text);
            }
        }
        let Some(next) = page.next_after else {
            break;
        };
        assert!(next > after);
        after = next;
    }
    assert_eq!(texts, ["first answer", "second answer"]);
    let rows = transcript(&log, "session").await;
    for text in ["root", "first answer", "second answer"] {
        assert_eq!(
            rows.iter().filter(|row| row["text"] == text).count(),
            1,
            "{text} must appear once"
        );
    }
    assert_eq!(
        rows.iter()
            .filter(|row| row["type"] == "turn_state" && row["status"] != "running")
            .count(),
        1,
        "physical pauses do not end the logical Turn"
    );
    assert_eq!(
        log.navigation_fence("session").await.unwrap(),
        Some(terminal)
    );
    assert_eq!(
        log.navigation_landmarks("session", terminal, 64, None,)
            .await
            .unwrap()
            .len(),
        1
    );
    log.close().await.unwrap();
}

async fn transcript(log: &EventLog, session: &str) -> Vec<Value> {
    let through = *log.subscribe_commits().borrow();

    let headers = log
        .transcript_headers(
            session,
            &TranscriptRead {
                through,
                position: None,
                direction: TranscriptDirection::Newer,
                limit: 100,
            },
        )
        .await
        .unwrap();
    let mut rows = Vec::new();
    for row in headers {
        rows.push(
            serde_json::from_slice(
                &log.transcript_fragment(session, row.position, 0, row.total_bytes)
                    .await
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    rows
}
