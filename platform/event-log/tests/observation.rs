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
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::TextKind;
use maka_event_log::{EventLog, turns::InvocationState};
use serde_json::{Value, json};

#[tokio::test]
async fn fenced_bootstrap_and_bounded_catchup_survive_coalescing_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let mut wake = log.subscribe_commits();
    let fresh = log
        .observe_session::<Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert!(fresh.root_turn.is_none());
    assert!(fresh.active_streams.is_empty());
    assert_eq!(fresh.through_sequence, 0);
    log.create_session("idle", "idle-create", &json!({}), 1)
        .await
        .unwrap();
    let targets = ["session".into(), "idle".into()];
    let versions = log.observation_versions(&targets).await.unwrap();
    assert_eq!(
        versions["session"],
        maka_event_log::observation::ObservationVersion {
            metadata: 1,
            queue: 0,
            event: 0,
            root_control_revision: 0,
        }
    );
    let first = Invocation {
        session_id: "session".into(),
        turn_id: "first".into(),
        run_id: "run-first".into(),
        invocation_id: "invocation-first".into(),
    };
    let opening = RuntimeEvent::new(
        first.clone(),
        Fact::InvocationOpened {
            configuration: None,
            input: maka_agent_facts::input::InvocationInput::Message {
                source_messages: Vec::new(),
                content: "one".into(),
                request_fingerprint: None,
            },
        },
    );
    let terminal = RuntimeEvent::new(
        first,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    log.append_batch(
        &([opening.clone(), terminal.clone()])
            .iter()
            .cloned()
            .map(EventWrite::plain)
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
    )
    .await
    .unwrap();
    let fence = log
        .observe_session::<Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fence.session.revision, 3);
    assert!(fence.active_streams.is_empty());
    assert!(matches!(
        fence.root_turn.unwrap().state,
        InvocationState::Ended { .. }
    ));
    let mut second = opening.clone();
    second.id = "second-event".into();
    second.invocation.turn_id = "second".into();
    second.invocation.run_id = "run-second".into();
    second.invocation.invocation_id = "invocation-second".into();
    log.append(&EventWrite::plain((second).clone()).unwrap())
        .await
        .unwrap();
    let mut other = second;
    other.id = "other-event".into();
    other.invocation.session_id = "other".into();
    other.invocation.invocation_id = "invocation-other".into();
    log.append(&EventWrite::plain((other).clone()).unwrap())
        .await
        .unwrap();
    // Several commits collapse to one hint. The stored cursor still covers all facts.
    assert_eq!(*wake.borrow_and_update(), 4);
    let advanced = log.observation_versions(&targets).await.unwrap();
    assert_eq!(
        advanced["idle"], versions["idle"],
        "unrelated commits do not invalidate an idle observer"
    );
    assert_eq!(
        advanced["session"].event, 3,
        "observer versions track their Session, not the global fence"
    );
    log.append(&EventWrite::plain((opening).clone()).unwrap())
        .await
        .unwrap();
    assert!(
        !wake.has_changed().unwrap(),
        "exact replay is not a new delivery"
    );
    let one = log
        .session_events(
            "session",
            fresh.through_sequence,
            fence.through_sequence,
            1,
            2048,
        )
        .await
        .unwrap();
    assert_eq!(one.events[0].event, opening);
    assert_eq!(one.next_after, Some(1));
    let two = log
        .session_events(
            "session",
            one.next_after.unwrap(),
            fence.through_sequence,
            1,
            2048,
        )
        .await
        .unwrap();
    assert_eq!(two.events[0].event, terminal);
    assert!(
        two.next_after.is_none(),
        "later commits cannot enter the old fence"
    );
    let soft = log.session_events("session", 0, 4, 1, 1).await.unwrap();
    assert_eq!(soft.events.len(), 1);
    assert_eq!(soft.events[0].event, opening);
    assert_eq!(soft.next_after, Some(soft.events[0].sequence));
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let resumed = log
        .observe_session::<Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resumed.through_sequence, 4);
    assert_eq!(resumed.root_turn.unwrap().invocation.turn_id, "second");
    let catchup = log
        .session_events(
            "session",
            fence.through_sequence,
            resumed.through_sequence,
            8,
            4096,
        )
        .await
        .unwrap();
    assert_eq!(catchup.events.len(), 1);
    assert_eq!(catchup.events[0].sequence, 3);
    assert!(catchup.next_after.is_none());
}

#[tokio::test]
async fn active_stream_seeds_preserve_complete_fenced_state_and_survive_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("streams.sqlite");
    let mut log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| RuntimeEvent::new(invocation.clone(), fact);
    log.append(
        &EventWrite::plain(
            (event(Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "".into(),
                    request_fingerprint: None,
                },
            }))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let observed = |step: &str, observation| {
        event(Fact::ModelObserved {
            step_id: step.into(),
            event: observation,
        })
    };
    let start = |step: &str, id: &str| {
        observed(
            step,
            ModelEvent::PartStarted {
                id: id.into(),
                text_kind: TextKind::Thinking,
                provider_options: None,
            },
        )
    };
    let delta = |step: &str, text: &str| {
        observed(
            step,
            ModelEvent::PartDelta {
                id: "same".into(),
                text: text.into(),
                provider_options: None,
            },
        )
    };
    for step in ["interrupted", "current"] {
        log.append(
            &EventWrite::plain(
                (event(Fact::ModelRequested {
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
                }))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    }
    log.append(&EventWrite::plain((start("interrupted", "same")).clone()).unwrap())
        .await
        .unwrap();
    log.append(&EventWrite::plain((delta("interrupted", "excluded")).clone()).unwrap())
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(
            (event(Fact::ModelInterrupted {
                model_failure: None,
                diagnostic: None,
                step_id: "interrupted".into(),
                status: ModelInterruption::Cancelled,
            }))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    log.append(&EventWrite::plain((start("current", "finished")).clone()).unwrap())
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(
            (observed(
                "current",
                ModelEvent::PartFinished {
                    id: "finished".into(),
                    provider_options: None,
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let opening = start("current", "same");
    log.append(&EventWrite::plain((opening).clone()).unwrap())
        .await
        .unwrap();
    log.append(&EventWrite::plain((delta("current", "a😀")).clone()).unwrap())
        .await
        .unwrap();
    let fence = log
        .observe_session::<Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fence.active_streams.len(), 2);
    let seed = fence
        .active_streams
        .iter()
        .find(|seed| seed.part_id == "same")
        .unwrap();
    assert_eq!(seed.message_id, opening.id);
    assert_eq!(seed.step_id, "current");
    assert_eq!(seed.part_id, "same");
    assert_eq!(seed.text_kind, TextKind::Thinking);
    assert!(seed.start_sequence < fence.through_sequence);
    log.append(&EventWrite::plain((delta("current", "🎉")).clone()).unwrap())
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(event(Fact::ModelObserved {
            step_id: "current".into(),
            event: ModelEvent::PartFinished {
                id: "same".into(),
                provider_options: None,
            },
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    log.close().await.unwrap();
    log = EventLog::open(&path).await.unwrap();
    let reopened = log
        .observe_session::<Value>("session")
        .await
        .unwrap()
        .unwrap();
    let reopened_seed = reopened
        .active_streams
        .iter()
        .find(|stream| stream.part_id == "same")
        .unwrap();
    assert_eq!(reopened_seed.message_id, seed.message_id);
    assert_eq!(
        reopened_seed.start_sequence, seed.start_sequence,
        "later commits retain the same replay start"
    );
    let catchup = log
        .session_events(
            "session",
            fence.through_sequence,
            reopened.through_sequence,
            8,
            4096,
        )
        .await
        .unwrap();
    assert_eq!(catchup.events.len(), 2);
    assert_eq!(
        reopened.active_streams.len(),
        2,
        "closed part still awaits the request verdict"
    );
    let mut expected = reopened.active_streams.clone();
    let mut builder = maka_agent_facts::model::assembly::StepBuilder::for_step("current").unwrap();
    for index in 0..128 {
        let id = format!("extra-{index}");
        builder
            .push(ModelEvent::PartStarted {
                id: id.clone(),
                text_kind: TextKind::Thinking,
                provider_options: None,
            })
            .unwrap();
        let opening = start("current", &id);
        let sequence = log
            .append(&EventWrite::plain(opening.clone()).unwrap())
            .await
            .unwrap();
        expected.push(maka_event_log::observation::AssistantStreamSeed {
            start_sequence: sequence,
            step_id: "current".into(),
            part_id: id,
            message_id: opening.id,
            text_kind: TextKind::Thinking,
        });
    }
    let complete = log.observe_session::<Value>("session").await;
    log.close().await.unwrap();
    log = EventLog::open(&path).await.unwrap();
    let complete_reopened = log.observe_session::<Value>("session").await;
    log.close().await.unwrap();
    let complete = complete.unwrap().unwrap();
    let complete_reopened = complete_reopened.unwrap().unwrap();
    assert_eq!(complete.active_streams, expected);
    assert_eq!(complete_reopened.active_streams, expected);
    assert_eq!(
        complete.through_sequence,
        complete_reopened.through_sequence
    );
    log = EventLog::open(&path).await.unwrap();
    log.append(
        &EventWrite::plain(
            (event(Fact::ModelCompleted {
                step_id: "current".into(),
                output: ModelStep {
                    parts: vec![],
                    finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                    usage: Default::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            }))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        log.observe_session::<Value>("session")
            .await
            .unwrap()
            .unwrap()
            .active_streams
            .is_empty()
    );
    log.append(
        &EventWrite::plain(
            (event(Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            }))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        log.observe_session::<Value>("session")
            .await
            .unwrap()
            .unwrap()
            .active_streams
            .is_empty()
    );
}

#[tokio::test]
async fn stream_seed_identities_preserve_complete_original_bytes_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("seed-identities.sqlite");
    for (index, ids) in [
        (0, vec!["😀".repeat(4096)]),
        (1, vec!["😀".repeat(16500)]),
        (2, vec!["a".repeat(33000), "b".repeat(33000)]),
    ] {
        let log = EventLog::open(&path).await.unwrap();
        let session = format!("budget-{index}");
        let step = format!("current-{index}");
        log.create_session(&session, &format!("create-{index}"), &json!({}), 1)
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: session.clone(),
            turn_id: format!("turn-{index}"),
            run_id: format!("run-{index}"),
            invocation_id: format!("invocation-{index}"),
        };
        let event = |fact| RuntimeEvent::new(invocation.clone(), fact);
        log.append(
            &EventWrite::plain(event(Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Message {
                    source_messages: vec![],
                    content: "".into(),
                    request_fingerprint: None,
                },
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        log.append(
            &EventWrite::plain(event(Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: step.clone(),
                model_id: "test".into(),
                source_scope: LogScope::Root,
                source_high_water: 0,
                source_digest: "fixture".into(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let mut builder = maka_agent_facts::model::assembly::StepBuilder::for_step(&step).unwrap();
        let mut expected = Vec::new();
        for id in &ids {
            let start = ModelEvent::PartStarted {
                id: id.clone(),
                text_kind: TextKind::Text,
                provider_options: None,
            };
            builder.push(start.clone()).unwrap();
            let opening = event(Fact::ModelObserved {
                step_id: step.clone(),
                event: start,
            });
            let sequence = log
                .append(&EventWrite::plain(opening.clone()).unwrap())
                .await
                .unwrap();
            expected.push(maka_event_log::observation::AssistantStreamSeed {
                start_sequence: sequence,
                step_id: step.clone(),
                part_id: id.clone(),
                message_id: opening.id,
                text_kind: TextKind::Text,
            });
        }
        let observation = log.observe_session::<Value>(&session).await;
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        let reopened = log.observe_session::<Value>(&session).await;
        log.append(
            &EventWrite::plain(event(Fact::ModelInterrupted {
                model_failure: None,
                diagnostic: None,
                step_id: step.clone(),
                status: ModelInterruption::Cancelled,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let ended = log.observe_session::<Value>(&session).await;
        log.close().await.unwrap();
        let observation = observation.unwrap().unwrap();
        let reopened = reopened.unwrap().unwrap();
        assert_eq!(observation.active_streams, expected);
        assert_eq!(reopened.active_streams, expected);
        assert_eq!(observation.through_sequence, reopened.through_sequence);
        assert!(ended.unwrap().unwrap().active_streams.is_empty());
    }
}

async fn complete_active_tool_replay_round_trip(ids: Vec<String>) {
    use maka_agent_facts::model::assembly::StepBuilder;
    use maka_event_log::observation::ToolStreamSeed;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("active-tools.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Message {
            source_messages: vec![],
            content: "original".into(),
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    log.append(&event(Fact::ModelRequested {
        context_breakdown: None,
        item_acceptance: false,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: "step".into(),
        model_id: "model".into(),
        source_scope: LogScope::Root,
        source_high_water: 0,
        source_digest: "source".into(),
        effective_source_digest: None,
        input_digest: "input".into(),
        route_identity: "route".into(),
    }))
    .await
    .unwrap();
    let mut builder = StepBuilder::for_step("step").unwrap();
    let mut expected = Vec::new();
    for id in ids {
        let start = ModelEvent::ToolInputStarted {
            id: id.clone(),
            name: "echo".into(),
            provider_executed: true,
        };
        builder.push(start.clone()).unwrap();
        let sequence = log
            .append(&event(Fact::ModelObserved {
                step_id: "step".into(),
                event: start,
            }))
            .await
            .unwrap();
        expected.push(ToolStreamSeed {
            tool_use_id: maka_agent_facts::tool_call::tool_use_id(
                "invocation",
                &format!("step:{id}"),
            ),
            start_sequence: sequence,
        });
    }
    let first = log.observe_session::<Value>("session").await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reopened = log.observe_session::<Value>("session").await;
    log.append(&event(Fact::ModelInterrupted {
        model_failure: None,
        diagnostic: None,
        step_id: "step".into(),
        status: ModelInterruption::Cancelled,
    }))
    .await
    .unwrap();
    let ended = log.observe_session::<Value>("session").await;
    log.close().await.unwrap();
    let first = first.unwrap().unwrap();
    let reopened = reopened.unwrap().unwrap();
    assert_eq!(first.active_tools, expected);
    assert_eq!(reopened.active_tools, expected);
    assert_eq!(reopened.through_sequence, first.through_sequence);
    assert_eq!(reopened.root_turn.unwrap().invocation, invocation);
    assert_eq!(ended.unwrap().unwrap().active_tools.len(), 0);
}

#[tokio::test]
async fn active_tool_replay_preserves_129_original_tiny_identities_after_reopen() {
    complete_active_tool_replay_round_trip((0..129).map(|index| format!("call-{index}")).collect())
        .await;
}

#[tokio::test]
async fn active_tool_replay_preserves_complete_identity_bytes_beyond_64k() {
    complete_active_tool_replay_round_trip(
        (0..17)
            .map(|index| format!("{index:02}-{}", "x".repeat(4000)))
            .collect(),
    )
    .await;
}
