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
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_event_log::EventLog;
use rusqlite::Connection;
use serde_json::{Value, json};

mod source_cases;
mod support;
use support::{invocation, steering, transcript, write};

#[tokio::test]
async fn steering_is_exact_once_session_scoped_and_atomic_with_rebuildable_user_projections() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for session in ["a", "b"] {
        log.create_session(session, "create", &json!({}), 1)
            .await
            .unwrap();
        log.append(&write(
            session,
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "same text".into(),
                    request_fingerprint: None,
                },
            },
        ))
        .await
        .unwrap();
    }
    let source = log.prefix(100, 1024 * 1024).await.unwrap();
    log.append(&write(
        "a",
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            step_id: "step".into(),
            model_id: "test".into(),
            source_scope: source.scope,
            source_high_water: source.high_water,
            source_digest: source.digest,
            input_digest: "input".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            effective_source_digest: None,
        },
    ))
    .await
    .unwrap();
    let accepted = steering("a", "same-client-id");
    assert!(
        log.append(&accepted).await.is_err(),
        "active request is not a steering boundary"
    );
    let call = ModelToolCall {
        id: "call".into(),
        name: "effect".into(),
        input: json!({}).into(),
        provider_executed: false,
        provider_options: None,
    };
    log.append(&write(
        "a",
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::ToolCall(call.clone()),
        },
    ))
    .await
    .unwrap();
    log.append(&write(
        "a",
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
    .await
    .unwrap();
    assert!(
        log.append(&accepted).await.is_err(),
        "an undispatched provider call must settle first"
    );
    log.append(&write(
        "a",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:call".into(),
            call: ToolCallIdentity {
                tool_call_id: "call".into(),
                origin: ToolOrigin::Provider {
                    step_id: "step".into(),
                },
            },
            name: "effect".into(),
            input: json!({}),
        },
    ))
    .await
    .unwrap();
    assert!(
        log.append(&accepted).await.is_err(),
        "dispatch alone does not settle an effect"
    );
    log.append(&write(
        "a",
        Fact::ToolSettled {
            operation_id: "step:call".into(),
            outcome: maka_agent_facts::event::ToolOutcome::Failed {
                message: "known failure".into(),
            },
        },
    ))
    .await
    .unwrap();
    for collision in [
        source.events[0].event.id.clone(),
        maka_agent_facts::tool_call::tool_use_id("invocation-a", "step:call"),
    ] {
        assert!(
            log.append(&steering("a", &collision)).await.is_err(),
            "visible identities cannot be reused as client message identities"
        );
    }
    let before = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_steering_projection BEFORE INSERT ON catalog_messages
        WHEN NEW.message_id = 'same-client-id'
        BEGIN SELECT RAISE(ABORT, 'injected catalog failure'); END;",
    )
    .unwrap();
    assert!(
        log.append_batch(&[steering("a", "rolled-back"), accepted.clone()])
            .await
            .is_err()
    );
    assert!(
        log.steering_message("a", "rolled-back")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.steering_message("a", "same-client-id")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        before
    );
    db.execute_batch("DROP TRIGGER reject_steering_projection")
        .unwrap();
    let sequence = log.append(&accepted).await.unwrap();
    assert_eq!(log.append(&accepted).await.unwrap(), sequence);
    assert!(log.append(&steering("a", "same-client-id")).await.is_err());
    let proof = log
        .steering_message("a", "same-client-id")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proof.sequence, sequence);
    assert_eq!(&proof.event, accepted.event());
    let mut collision = RuntimeEvent::new(
        invocation("a"),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    collision.id = "same-client-id".into();
    assert!(
        log.append(&EventWrite::plain(collision).unwrap())
            .await
            .is_err(),
        "a future Host message cannot reuse the accepted client identity"
    );
    // No acknowledgement of the old opening can mask this new durable visible tail.
    let record = log
        .set_session_read_marker::<Value>("a", "same-client-id")
        .await
        .unwrap();
    assert_eq!(
        record.read_state.last_read_message_id.as_deref(),
        Some("same-client-id")
    );
    support::assert_provider_identity(&log).await;
    log.append(&steering("b", "same-client-id")).await.unwrap();
    let a = transcript(&log, "a").await;
    let b = transcript(&log, "b").await;
    for rows in [&a, &b] {
        let row = rows
            .iter()
            .find(|row| row["id"] == "same-client-id")
            .unwrap();
        assert_eq!(row["text"], "same text");
        assert_eq!(row["displayText"], "visible correction");
    }
    log.append(&write(
        "a",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap();
    assert_eq!(
        log.append(&accepted).await.unwrap(),
        sequence,
        "exact replay survives the seal"
    );
    assert!(log.append(&steering("a", "too-late")).await.is_err());
    let a = transcript(&log, "a").await;
    let before = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    log.close().await.unwrap();
    // Both read models are disposable; the log is the only message-delivery proof.
    db.execute_batch(
        "
        DELETE FROM catalog_messages; DELETE FROM catalog_message_watermark;",
    )
    .unwrap();
    drop(db);
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        before
    );
    assert_eq!(transcript(&log, "a").await, a);
    assert_eq!(transcript(&log, "b").await, b);
    assert_eq!(
        log.steering_message("a", "same-client-id")
            .await
            .unwrap()
            .unwrap()
            .event,
        proof.event
    );
    let db = Connection::open(&path).unwrap();
    let preview: String = db.query_row(
        "SELECT preview FROM catalog_messages WHERE session_id = 'a' AND message_id = 'same-client-id'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(preview, "visible correction");
    drop(db);
    log.close().await.unwrap();
}
