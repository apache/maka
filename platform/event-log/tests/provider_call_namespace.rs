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
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
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
                output: ModelStep {
                    parts: vec![ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: "call-1".into(),
                            name: "tool".into(),
                            input: json!({}).into(),
                            provider_options: None,
                            provider_executed: false,
                        },
                    }],
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
    let recovery = log.invocation_recovery(&invocation()).await.unwrap();
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
    let recovered = log.invocation_recovery(&invocation()).await.unwrap();
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
