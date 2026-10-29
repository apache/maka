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
use maka_agent_facts::event::RuntimeEvent;
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

async fn complete_active_tool_replay_round_trip(ids: Vec<String>) {
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
    let mut expected = Vec::new();
    let mut operations = Vec::new();
    for id in ids {
        let operation = format!("step:{id}");
        let sequence = log
            .append(&event(Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: operation.clone(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(id),
                name: "echo".into(),
                input: json!({}),
            }))
            .await
            .unwrap();
        expected.push(ToolStreamSeed {
            tool_use_id: maka_agent_facts::tool_call::tool_use_id("invocation", &operation),
            start_sequence: sequence,
        });
        operations.push(operation);
    }
    let first = log.observe_session::<Value>("session").await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reopened = log.observe_session::<Value>("session").await;
    for operation_id in operations {
        log.append(&event(Fact::ToolSettled {
            operation_id,
            outcome: maka_agent_facts::event::ToolOutcome::Failed {
                message: "fixture finished".into(),
            },
        }))
        .await
        .unwrap();
    }
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
