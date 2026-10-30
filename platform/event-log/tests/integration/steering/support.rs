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

pub use crate::support::transcript::transcript;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::DeliveredMessage;
use maka_event_log::EventLog;

pub async fn assert_provider_identity(log: &EventLog) {
    use maka_agent_facts::event::LogScope;
    use maka_agent_facts::model::{
        ModelFinishReason, ModelPart, ModelToolCall,
        recorded::{
            CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, RecordedPartRef,
        },
    };
    let claimed = "provider-result-claimed";
    log.append(&steering("b", claimed)).await.unwrap();
    let prefix = log
        .scoped_prefix(LogScope::Session { id: "b".into() }, 100, 1024 * 1024)
        .await
        .unwrap();
    log.append(&write(
        "b",
        Fact::ModelRequested {
            source_capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: 0,
                prior_unknown: false,
            },
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
    let call_record = ModelPartRecord {
        ordinal: 0,
        message_id: maka_agent_facts::tool_call::tool_use_id(
            &invocation("b").invocation_id,
            "provider-step:provider-call",
        ),
        started_at: std::time::UNIX_EPOCH,
        provider_part_id: None,
        part: std::sync::Arc::new(ModelPart::ToolCall { call: call.clone() }),
    };
    let original_call = write(
        "b",
        Fact::ModelObserved {
            step_id: "provider-step".into(),
            event: ModelObservation::Part(call_record),
        },
    );
    log.append(&original_call).await.unwrap();
    let mut result = ModelPartRecord {
        ordinal: 1,
        message_id: claimed.into(),
        started_at: std::time::UNIX_EPOCH,
        provider_part_id: None,
        part: std::sync::Arc::new(ModelPart::ToolResult {
            id: call.id,
            name: call.name,
            output: serde_json::json!({"ok":true}),
            is_error: false,
            provider_options: None,
        }),
    };
    let conflicting = write(
        "b",
        Fact::ModelObserved {
            step_id: "provider-step".into(),
            event: ModelObservation::Part(result.clone()),
        },
    );
    assert!(
        log.append(&conflicting).await.is_err(),
        "provider result cannot claim an existing client identity"
    );
    result.message_id = "provider-result-original".into();
    let original_result = write(
        "b",
        Fact::ModelObserved {
            step_id: "provider-step".into(),
            event: ModelObservation::Part(result.clone()),
        },
    );
    log.append(&original_result).await.unwrap();
    let completed = write(
        "b",
        Fact::ModelCompleted {
            step_id: "provider-step".into(),
            output: ModelCompletion {
                parts: vec![
                    CompletionPart::Ref(RecordedPartRef {
                        event_id: original_call.event().id.clone(),
                        ordinal: 0,
                    }),
                    CompletionPart::Ref(RecordedPartRef {
                        event_id: original_result.event().id.clone(),
                        ordinal: 1,
                    }),
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
    log.append(&completed).await.unwrap();
    assert!(
        log.append(&steering("b", &result.message_id))
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
