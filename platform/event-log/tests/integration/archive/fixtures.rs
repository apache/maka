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
pub(super) const SUMMARY: &str = "## Goal\nContinue the work.\n## Progress\nCompleted the first stage.\n## Next Steps\nVerify the remaining behavior.\n## Critical Context\nPreserve the durable execution facts.";
pub(super) fn event(id: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        },
        fact,
    ))
    .unwrap()
}
pub(super) async fn open(log: &EventLog, id: &str, compact: bool) {
    log.append(&event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: if compact {
                InvocationInput::ContextCompact {
                    request_fingerprint: id.into(),
                }
            } else {
                InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "question".into(),
                    request_fingerprint: None,
                }
            },
        },
    ))
    .await
    .unwrap();
}

pub(super) async fn end(log: &EventLog, id: &str) {
    log.append(&event(
        id,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap();
}
pub(super) fn request(id: &str, step: &str, source: Option<&ModelContextSource>) -> EventWrite {
    event(
        id,
        Fact::ModelRequested {
            source_capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: 0,
                prior_unknown: false,
            },
            context_breakdown: None,
            item_acceptance: false,
            step_id: step.into(),
            model_id: "test".into(),
            purpose: if source.is_some() {
                ModelPurpose::Summary
            } else {
                ModelPurpose::Main
            },
            context: None,
            source_scope: source.map_or_else(
                || LogScope::Session {
                    id: "session".into(),
                },
                |s| s.source_evidence.scope.clone(),
            ),
            source_high_water: source.map_or(0, |s| s.source_evidence.high_water),
            source_digest: source.map_or("fixture".into(), |s| s.source_evidence.digest.clone()),
            input_digest: "fixture".into(),
            route_identity: format!("sha256:{}", "a".repeat(64)),
            checkpoint_event_id: source
                .and_then(|s| s.baseline.as_ref().map(|b| b.event_id.clone())),
            effective_source_digest: source.map(|s| s.effective_source_digest.clone()),
        },
    )
}
pub(super) async fn tool(log: &EventLog, id: &str, step: &str, text: String) -> EventWrite {
    log.append(&request(id, step, None)).await.unwrap();
    let output = ModelCompletion {
        parts: vec![model_part(
            id,
            step,
            0,
            maka_agent_facts::model::ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: step.into(),
                    name: "Read".into(),
                    input: json!({"path":"file"}).into(),
                    provider_executed: false,
                    provider_options: None,
                },
            },
        )],
        finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
        usage: Default::default(),
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
    };
    log.append(&event(
        id,
        Fact::ModelCompleted {
            step_id: step.into(),
            output,
        },
    ))
    .await
    .unwrap();
    let operation = format!("{step}:{step}");
    log.append(&event(
        id,
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation.clone(),
            call: ToolCallIdentity::provider(step.into(), step.into()),
            name: "Read".into(),
            input: json!({"path":"file"}),
        },
    ))
    .await
    .unwrap();
    let identity = event(
        id,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .event()
    .invocation
    .clone();
    let (write, _) = EventWrite::tool_success(
        format!("result-{step}"),
        std::time::SystemTime::now(),
        identity,
        operation,
        ToolSuccess::from(json!(text)),
    )
    .unwrap();
    log.append(&write).await.unwrap();
    write
}
pub(super) fn archive(writer: &str, target: &EventWrite) -> EventWrite {
    let Fact::ToolSettled {
        operation_id,
        outcome,
    } = &target.event().fact
    else {
        panic!()
    };
    let projection = outcome_projection(outcome);
    event(
        writer,
        Fact::ToolResultArchived {
            placeholder: ArchivedPlaceholder::prepare(
                target.event().id.clone(),
                operation_id.split(':').next().unwrap().into(),
                "Read".into(),
                &projection,
            )
            .unwrap()
            .unwrap(),
        },
    )
}
pub(super) async fn summary_pair(
    log: &EventLog,
    id: &str,
    source: &ModelContextSource,
) -> Vec<EventWrite> {
    let summary_step = format!("{id}-summary");
    log.append(&request(id, &summary_step, Some(source)))
        .await
        .unwrap();
    let output = summary_completion(id, &summary_step, SUMMARY);
    log.append(&event(
        id,
        Fact::ModelCompleted {
            step_id: summary_step.clone(),
            output: output.clone(),
        },
    ))
    .await
    .unwrap();
    let checkpoint = event(
        id,
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode: CheckpointMode::Standalone,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest.clone(),
                previous_checkpoint_id: source.baseline.as_ref().map(|b| b.event_id.clone()),
                summary: TextSummary::from_parts(
                    output.finish_reason,
                    output.parts.iter().filter_map(|part| match part {
                        maka_agent_facts::model::recorded::CompletionPart::Own(record) => {
                            Some(record.part.as_ref())
                        }
                        _ => None,
                    }),
                )
                .unwrap(),
                summary_step_id: summary_step,
            },
        },
    );
    let terminal = event(
        id,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::ContextCompactFinished {
                outcome: CompactOutcome::Compacted {
                    checkpoint_id: checkpoint.event().id.clone(),
                },
            },
        },
    );
    vec![checkpoint, terminal]
}

pub(super) fn model_part(
    invocation: &str,
    step: &str,
    ordinal: u64,
    part: maka_agent_facts::model::ModelPart,
) -> maka_agent_facts::model::recorded::CompletionPart {
    use maka_agent_facts::model::{
        ModelPart,
        recorded::{CompletionPart, ModelPartRecord},
    };
    let message_id = match &part {
        ModelPart::ToolCall { call } => {
            maka_agent_facts::tool_call::tool_use_id(invocation, &format!("{step}:{}", call.id))
        }
        _ => uuid::Uuid::new_v4().to_string(),
    };
    CompletionPart::Own(ModelPartRecord {
        ordinal,
        message_id,
        started_at: std::time::SystemTime::now(),
        provider_part_id: None,
        part: std::sync::Arc::new(part),
    })
}

pub(super) fn summary_completion(invocation: &str, step: &str, text: &str) -> ModelCompletion {
    ModelCompletion {
        parts: vec![model_part(
            invocation,
            step,
            0,
            maka_agent_facts::model::ModelPart::Text {
                text_kind: maka_agent_facts::model::TextKind::Text,
                text: text.into(),
                provider_options: None,
            },
        )],
        finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
        usage: Default::default(),
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
    }
}
