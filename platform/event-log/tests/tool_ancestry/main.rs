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
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::tool_call::HostSdkParent;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_event_log::EventLog;
use serde_json::json;

mod host_sdk;

fn event(invocation: &str, fact: Fact) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: invocation.into(),
            turn_id: invocation.into(),
            run_id: invocation.into(),
            invocation_id: invocation.into(),
        },
        fact,
    )
}

fn opening(invocation: &str) -> RuntimeEvent {
    event(
        invocation,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Code { source: "".into() },
        },
    )
}

fn dispatch(operation: &str, call: &str, origin: ToolOrigin) -> Fact {
    Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: operation.into(),
        call: ToolCallIdentity {
            tool_call_id: call.into(),
            origin,
        },
        name: "composite".into(),
        input: json!({"a":1,"b":2}),
    }
}

fn nested(parent: &str, call: &str) -> ToolOrigin {
    ToolOrigin::CodeMode {
        parent_operation_id: parent.into(),
        parent_tool_call_id: call.into(),
    }
}

fn settle(operation: &str, outcome: ToolOutcome) -> Fact {
    Fact::ToolSettled {
        operation_id: operation.into(),
        outcome,
    }
}

fn success(invocation: &str, operation: &str, value: serde_json::Value) -> EventWrite {
    let event = opening(invocation);
    EventWrite::tool_success(
        event.id,
        event.recorded_at,
        event.invocation,
        operation.into(),
        value.into(),
    )
    .unwrap()
    .0
}

#[tokio::test]
async fn nested_ancestry_drain_and_replay_preserve_unknown_operations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let parent = event(
        "one",
        dispatch("parent", "parent-call", ToolOrigin::Standalone),
    );
    log.append_batch(
        &([opening("one"), opening("two"), parent.clone()])
            .iter()
            .cloned()
            .map(EventWrite::plain)
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
    )
    .await
    .unwrap();
    let child_call = "x".repeat(4097);
    let child = event(
        "one",
        dispatch("child", &child_call, nested("parent", "parent-call")),
    );
    let commits = log.subscribe_commits();
    for bad in [
        event(
            "two",
            dispatch("foreign", "foreign-call", nested("parent", "parent-call")),
        ),
        event(
            "one",
            dispatch("bad-parent", "bad-call", nested("parent", "wrong-call")),
        ),
        event(
            "one",
            dispatch(
                "missing-parent",
                "bad-call",
                nested("missing", "parent-call"),
            ),
        ),
        event("one", dispatch("empty", "", ToolOrigin::Standalone)),
    ] {
        assert!(
            log.append(&EventWrite::plain((bad).clone()).unwrap())
                .await
                .is_err()
        );
    }
    assert!(!commits.has_changed().unwrap());
    log.append(&EventWrite::plain((child).clone()).unwrap())
        .await
        .unwrap();
    let parent_done = event(
        "one",
        settle(
            "parent",
            ToolOutcome::Failed {
                message: "cancelled".into(),
            },
        ),
    );
    for outcome in [
        success("one", "parent", json!(null)),
        EventWrite::plain(parent_done.clone()).unwrap(),
    ] {
        assert!(log.append(&outcome).await.is_err());
    }
    assert!(
        log.append(
            &EventWrite::plain(
                (event(
                    "one",
                    dispatch("duplicate", &child_call, nested("parent", "parent-call"))
                ))
                .clone()
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    let prefix = log.prefix(100, 100_000).await.unwrap();
    assert_eq!(
        prefix.project_invocation("one").uncertain_operations,
        vec!["child", "parent"]
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.prefix(100, 100_000).await.unwrap().digest,
        prefix.digest
    );
    assert!(
        log.append(&EventWrite::plain((parent_done).clone()).unwrap())
            .await
            .is_err()
    );
    let child_done = event(
        "one",
        settle(
            "child",
            ToolOutcome::Failed {
                message: "cancelled".into(),
            },
        ),
    );
    let seqs = log
        .append_batch(
            &([child_done.clone(), parent_done.clone()])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(seqs[1], seqs[0] + 1);
    assert!(
        log.append(
            &EventWrite::plain(
                (event(
                    "one",
                    dispatch("late", "late-call", nested("parent", "parent-call"))
                ))
                .clone()
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    let commits = log.subscribe_commits();
    // Replayed T1 remains valid even after its parent has settled.
    assert_eq!(
        log.append_batch(
            &([parent, child, child_done, parent_done])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        )
        .await
        .unwrap(),
        vec![3, 4, 5, 6]
    );
    assert!(!commits.has_changed().unwrap());
    assert!(
        log.prefix(100, 100_000)
            .await
            .unwrap()
            .project_invocation("one")
            .uncertain_operations
            .is_empty()
    );

    let batch = [
        EventWrite::plain(event("two", dispatch("p2", "pc2", ToolOrigin::Standalone))).unwrap(),
        EventWrite::plain(event("two", dispatch("c2", "cc2", nested("p2", "pc2")))).unwrap(),
        success("two", "c2", json!(1)),
        success("two", "p2", json!(2)),
    ];
    assert_eq!(log.append_batch(&batch).await.unwrap(), vec![7, 8, 9, 10]);
}

#[tokio::test]
async fn provider_dispatch_requires_the_exact_accepted_local_call() {
    let dir = tempfile::tempdir().unwrap();
    let log = EventLog::open(&dir.path().join("events.sqlite"))
        .await
        .unwrap();
    let request = event(
        "one",
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "model".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "".into(),
            effective_source_digest: None,
            input_digest: "".into(),
            route_identity: "".into(),
        },
    );
    log.append_batch(
        &([
            event(
                "one",
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content: "use a tool".into(),
                        request_fingerprint: None,
                        source_messages: Vec::new(),
                    },
                },
            ),
            opening("two"),
            request,
        ])
        .iter()
        .cloned()
        .map(EventWrite::plain)
        .collect::<Result<Vec<_>, _>>()
        .unwrap(),
    )
    .await
    .unwrap();
    let provider = || ToolOrigin::Provider {
        step_id: "step".into(),
    };
    let good = event("one", dispatch("step:call", "call", provider()));
    assert!(
        log.append(&EventWrite::plain((good).clone()).unwrap())
            .await
            .is_err()
    );
    let completed = event(
        "one",
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: [false, true]
                    .into_iter()
                    .map(|native| ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: if native { "native" } else { "call" }.into(),
                            name: "composite".into(),
                            input: serde_json::from_str::<serde_json::Value>("{\"b\":2,\"a\":1}")
                                .unwrap()
                                .into(),
                            provider_options: None,
                            provider_executed: native,
                        },
                    })
                    .collect(),
                finish_reason: ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    );
    let mut wrong_name = good.clone();
    if let Fact::ToolDispatched { name, .. } = &mut wrong_name.fact {
        *name = "other".into();
    }
    let mut wrong_input = good.clone();
    if let Fact::ToolDispatched { input, .. } = &mut wrong_input.fact {
        *input = json!({"a":2,"b":2});
    }
    // A batch rollback does not leave the accepted response behind.
    assert!(
        log.append_batch(
            &([completed.clone(), wrong_name.clone()])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        )
        .await
        .is_err()
    );
    assert!(
        log.append(&EventWrite::plain((good).clone()).unwrap())
            .await
            .is_err()
    );
    log.append(&EventWrite::plain((completed).clone()).unwrap())
        .await
        .unwrap();
    for bad in [
        wrong_name,
        wrong_input,
        event("two", dispatch("step:call", "call", provider())),
        event("one", dispatch("wrong-operation", "call", provider())),
        event("one", dispatch("step:native", "native", provider())),
        event("one", dispatch("step:missing", "missing", provider())),
    ] {
        assert!(
            log.append(&EventWrite::plain((bad).clone()).unwrap())
                .await
                .is_err()
        );
    }
    log.append(&EventWrite::plain((good).clone()).unwrap())
        .await
        .unwrap();
    assert!(
        log.append(
            &EventWrite::plain(
                (event("one", dispatch("other", "call", ToolOrigin::Standalone))).clone()
            )
            .unwrap()
        )
        .await
        .is_err()
    );
}
