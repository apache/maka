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

use maka_agent_facts::event::{Fact, InvocationOutcome};
use maka_agent_facts::model::{ModelEvent, TextKind};
use maka_event_log::recovery::recover_invocations as recover;
use maka_event_log::{EventLog, StoreError};

use crate::support::recovery;
use recovery::{append, invocation, opening, request};

#[tokio::test]
async fn recovery_excludes_large_stream_history_and_validates_execution_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    {
        let log = EventLog::open(&path).await.unwrap();
        opening(&log).await;
        recovery::item_request(&log).await;
        let mut writer = crate::support::model_records::writer(invocation(), "step", true);
        let writes = crate::support::model_records::observations(
            &mut writer,
            [
                ModelEvent::PartStarted {
                    id: "part".into(),
                    text_kind: TextKind::Text,
                    provider_options: None,
                },
                ModelEvent::PartDelta {
                    id: "part".into(),
                    text: "x".repeat(8 * 1024 * 1024),
                    provider_options: None,
                },
                ModelEvent::PartFinished {
                    id: "part".into(),
                    provider_options: None,
                },
            ],
        );
        let sequences = log.append_batch(&writes).await.unwrap();
        crate::support::model_records::receipts(&mut writer, &writes, &sequences);
        log.close().await.unwrap();
    }
    let log = EventLog::open(&path).await.unwrap();
    let mut foreign = invocation();
    foreign.session_id = "unrelated".into();
    assert!(
        matches!(
            log.invocation_recovery(&foreign).await,
            Err(StoreError::InvalidTransition(_))
        ),
        "an invocation ID cannot substitute another Session"
    );
    assert!(matches!(
        log.unfinished_invocations(0, 0).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert_eq!(
        log.unfinished_invocations(0, 1).await.unwrap().invocations,
        vec![invocation()]
    );
    assert_eq!(recover(&log).await.unwrap(), 1);
    assert!(
        log.unfinished_invocations(0, 1)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert!(
        matches!(log.turn_boundary("session", "turn").await.unwrap().unwrap().state,
        maka_event_log::turns::InvocationState::Ended { outcome: InvocationOutcome::Failed { class, .. }, .. }
        if class == "host_interrupted")
    );
    let prefix = log.prefix(10, 9 * 1024 * 1024).await.unwrap();
    assert_eq!(prefix.events.len(), 5);
    assert!(
        prefix
            .project_invocation("invocation")
            .unfinished_model_steps
            .is_empty()
    );
}

#[tokio::test]
async fn recovery_reads_all_pending_calls_and_large_original_arguments() {
    use maka_agent_facts::model::{ModelFinishReason, ModelPart, ModelToolCall};
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    opening(&log).await;
    request(&log).await;
    let parts = (0..10_002).map(|index| ModelPart::ToolCall {
        call: ModelToolCall {
            id: format!("call-{index}"),
            name: "read".into(),
            input: serde_json::json!({"value": if index == 0 { "x".repeat(8 * 1024 * 1024 + 1) } else { "tail".into() }}).into(),
            provider_options: None,
            provider_executed: false,
        },
    }).collect();
    append(
        &log,
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: crate::support::model_records::completion(
                invocation(),
                "step",
                parts,
                ModelFinishReason::ToolCalls,
            ),
        },
    )
    .await;
    append(
        &log,
        Fact::ToolDispatched {
            operation_id: "step:call-10001".into(),
            presentation: None,
            title: None,
            call: maka_agent_facts::tool_call::ToolCallIdentity {
                tool_call_id: "call-10001".into(),
                origin: maka_agent_facts::tool_call::ToolOrigin::Provider {
                    step_id: "step".into(),
                },
            },
            name: "read".into(),
            input: serde_json::json!({"value":"tail"}),
        },
    )
    .await;
    append(
        &log,
        Fact::ToolSettled {
            operation_id: "step:call-10001".into(),
            outcome: maka_agent_facts::event::ToolOutcome::Failed {
                message: "already settled".into(),
            },
        },
    )
    .await;
    let state = log.invocation_recovery(&invocation()).await.unwrap();
    assert_eq!(state.undispatched_calls.len(), 10_001);
    let first = state
        .undispatched_calls
        .iter()
        .find(|call| call.operation_id == "step:call-0")
        .unwrap();
    assert_eq!(
        first.input.as_json().unwrap()["value"]
            .as_str()
            .unwrap()
            .len(),
        8 * 1024 * 1024 + 1
    );
    assert!(
        state
            .undispatched_calls
            .iter()
            .any(|call| call.operation_id == "step:call-10000")
    );
    log.close().await.unwrap();
}
