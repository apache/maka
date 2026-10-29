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

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::TextKind;
use maka_agent_facts::model::recorded::{
    CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, RecordedPartRef,
};
use serde_json::json;
use std::time::{Duration, UNIX_EPOCH};
pub(super) fn opening() -> Fact {
    Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: Vec::new(),
            content: "read".into(),
            request_fingerprint: None,
        },
    }
}
pub(super) fn step(facts: &mut Vec<Fact>, id: &str, text: bool, native: bool) {
    facts.push(Fact::ModelRequested {
        context_breakdown: None,
        item_acceptance: false,
        effective_source_digest: None,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: id.into(),
        model_id: "model".into(),
        source_scope: LogScope::Session {
            id: "session".into(),
        },
        source_high_water: 1,
        source_digest: "source".into(),
        input_digest: "input".into(),
        route_identity: "route".into(),
    });
    let mut parts = Vec::new();
    if text {
        parts.push(ModelPart::Text {
            text_kind: TextKind::Text,
            text: "Reading".into(),
            provider_options: None,
        });
    }
    let call = ModelToolCall {
        id: "raw".into(),
        name: "exec".into(),
        input: json!({"code":"Read()"}).into(),
        provider_options: Some(json!({"vendor":{"signature":"proof"}})),
        provider_executed: native,
    };
    parts.push(ModelPart::ToolCall { call });
    if native {
        parts.push(ModelPart::ToolResult {
            id: "raw".into(),
            name: "exec".into(),
            output: json!({"native":true}),
            is_error: false,
            provider_options: None,
        });
    }
    let parts = parts
        .into_iter()
        .enumerate()
        .map(|(ordinal, part)| {
            let message_id = match &part {
                ModelPart::ToolCall { call } => {
                    maka_presentation::tool_message_id("invocation", &format!("{id}:{}", call.id))
                }
                _ => format!("{id}:part:{ordinal}"),
            };
            let record = ModelPartRecord {
                ordinal: ordinal as u64,
                message_id,
                started_at: UNIX_EPOCH + Duration::from_millis(1000 + facts.len() as u64),
                provider_part_id: None,
                part: std::sync::Arc::new(part),
            };
            if native && !matches!(record.part.as_ref(), ModelPart::Text { .. }) {
                let event_id = format!("event_{}", facts.len());
                facts.push(Fact::ModelObserved {
                    step_id: id.into(),
                    event: ModelObservation::Part(record.clone()),
                });
                CompletionPart::Ref(RecordedPartRef {
                    event_id,
                    ordinal: record.ordinal,
                })
            } else {
                CompletionPart::Own(record)
            }
        })
        .collect();
    facts.push(Fact::ModelCompleted {
        step_id: id.into(),
        output: ModelCompletion {
            parts,
            finish_reason: ModelFinishReason::ToolCalls,
            usage: Default::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    });
}
pub(super) fn stored(facts: Vec<Fact>) -> Vec<StoredEvent> {
    facts
        .into_iter()
        .enumerate()
        .map(|(index, fact)| {
            let mut event = RuntimeEvent::new(
                Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                fact,
            );
            event.id = format!("event_{index}");
            event.recorded_at = UNIX_EPOCH + Duration::from_millis(1000 + index as u64);
            StoredEvent {
                sequence: index as u64 + 1,
                event,
            }
        })
        .collect()
}
