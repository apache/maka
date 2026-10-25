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
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::DeliveredMessage;
use maka_event_log::EventLog;
#[path = "transcript.rs"]
mod transcript;
pub use transcript::transcript;

pub async fn provider_completion(log: &EventLog, session: &str, event_id: &str) -> EventWrite {
    use maka_agent_facts::event::LogScope;
    use maka_agent_facts::model::ModelEvent;
    use maka_agent_facts::model::ModelFinishReason;
    use maka_agent_facts::model::ModelPart;
    use maka_agent_facts::model::ModelStep;
    use maka_agent_facts::model::ModelToolCall;
    let prefix = log
        .scoped_prefix(LogScope::Session { id: session.into() }, 100, 1024 * 1024)
        .await
        .unwrap();
    log.append(&write(
        session,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            step_id: "provider-step".into(),
            model_id: "test".into(),
            source_scope: prefix.scope,
            source_high_water: prefix.high_water,
            source_digest: prefix.digest,
            input_digest: "input".into(),
            route_identity: "route".into(),
            effective_source_digest: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
        },
    ))
    .await
    .unwrap();
    let call = ModelToolCall {
        id: "provider-call".into(),
        name: "remote".into(),
        input: serde_json::json!({}).into(),
        provider_options: None,
        provider_executed: true,
    };
    for event in [
        ModelEvent::ToolCall(call.clone()),
        ModelEvent::ProviderToolResult {
            id: call.id.clone(),
            name: call.name.clone(),
            output: serde_json::json!({"ok":true}),
            is_error: false,
            provider_options: None,
        },
    ] {
        log.append(&write(
            session,
            Fact::ModelObserved {
                step_id: "provider-step".into(),
                event,
            },
        ))
        .await
        .unwrap();
    }
    let mut event = RuntimeEvent::new(
        invocation(session),
        Fact::ModelCompleted {
            step_id: "provider-step".into(),
            output: ModelStep {
                parts: vec![
                    ModelPart::ToolCall { call: call.clone() },
                    ModelPart::ToolResult {
                        id: call.id,
                        name: call.name,
                        output: serde_json::json!({"ok":true}),
                        is_error: false,
                        provider_options: None,
                    },
                ],
                finish_reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    );
    event.id = event_id.into();
    EventWrite::plain(event).unwrap()
}

pub async fn assert_provider_identity(log: &EventLog) {
    use maka_agent_facts::tool_call::provider_result_id;
    let claimed = provider_result_id("provider-future", 1);
    log.append(&steering("b", &claimed)).await.unwrap();
    let completion = provider_completion(log, "b", "provider-future").await;
    assert!(
        log.append(&completion).await.is_err(),
        "provider result cannot claim an existing client identity"
    );
    let mut event = completion.event().clone();
    event.id = "provider-completed".into();
    log.append(&EventWrite::plain(event).unwrap())
        .await
        .unwrap();
    assert!(
        log.append(&steering("b", &provider_result_id("provider-completed", 1)))
            .await
            .is_err(),
        "client identity cannot claim an existing provider result"
    );
}

pub fn invocation(session: &str) -> Invocation {
    Invocation {
        session_id: session.into(),
        turn_id: format!("turn-{session}"),
        run_id: format!("run-{session}"),
        invocation_id: format!("invocation-{session}"),
    }
}
pub fn write(session: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(invocation(session), fact)).unwrap()
}
pub fn steering(session: &str, id: &str) -> EventWrite {
    let mut content = maka_agent_facts::input::MessageInput::from("same text");
    // Retain prepared model text and submitted display text as different projections.
    content.display_text = Some("visible correction".into());
    write(session, {
        let message = DeliveredMessage {
            origin: None,
            message_id: id.into(),
            content,
            submitted_content_digest: format!("sha256:{}", "a".repeat(64)),
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
}
