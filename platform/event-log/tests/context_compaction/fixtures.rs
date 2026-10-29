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

pub(super) const SUMMARY: &str =
    "Custom summary without required sections. Continue with these details:...";

fn identity(id: &str) -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: id.into(),
        run_id: id.into(),
        invocation_id: id.into(),
    }
}
pub(super) fn event(id: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(identity(id), fact)).unwrap()
}
pub(super) fn step(text: &str) -> ModelStep {
    serde_json::from_value(
        json!({"parts":[{"kind":"text","text_kind":"text","text":text}],
        "finish_reason":"stop","usage":{}}),
    )
    .unwrap()
}
pub(super) fn request(id: &str, source: &ModelContextSource) -> EventWrite {
    event(
        id,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: Some(source.effective_source_digest.clone()),
            purpose: maka_agent_facts::context::ModelPurpose::Summary,
            context: None,
            step_id: format!("{id}-summary"),
            model_id: "test".into(),
            source_scope: source.source_evidence.scope.clone(),
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest.clone(),
            input_digest: "input".into(),
            route_identity: format!("sha256:{}", "a".repeat(64)),
            checkpoint_event_id: source.baseline.as_ref().map(|b| b.event_id.clone()),
        },
    )
}
pub(super) async fn closed(
    log: &EventLog,
    id: &str,
    body_bytes: usize,
    observations: usize,
) -> String {
    log.append(&event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "question".into(),
                request_fingerprint: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        id,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            step_id: format!("{id}:step"),
            model_id: "test".into(),
            source_scope: LogScope::Session {
                id: "session".into(),
            },
            source_high_water: 0,
            source_digest: "fixture".into(),
            input_digest: "fixture".into(),
            route_identity: "fixture".into(),
            checkpoint_event_id: None,
        },
    ))
    .await
    .unwrap();
    let observations: Vec<_> = (0..observations)
        .map(|_| {
            event(
                id,
                Fact::ModelObserved {
                    step_id: format!("{id}:step"),
                    event: ModelEvent::PartDelta {
                        id: "text".into(),
                        text: "part".into(),
                        provider_options: None,
                    },
                },
            )
        })
        .collect();
    let first = observations[0].event().id.clone();
    log.append_batch(&observations).await.unwrap();
    log.append_batch(&[
        event(
            id,
            Fact::ModelCompleted {
                step_id: format!("{id}:step"),
                output: step(&"x".repeat(body_bytes)),
            },
        ),
        event(
            id,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    ])
    .await
    .unwrap();
    first
}
pub(super) async fn prepared(log: &EventLog, id: &str) -> Vec<EventWrite> {
    prepare_trace(log, id, 0, false).await
}

pub(super) async fn prepare_trace(
    log: &EventLog,
    id: &str,
    observations: usize,
    fail: bool,
) -> Vec<EventWrite> {
    log.append(&event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::ContextCompact {
                request_fingerprint: id.into(),
            },
        },
    ))
    .await
    .unwrap();
    let source = log
        .capture_compaction_context(
            "session",
            Some(id),
            &maka_agent_facts::context::CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let output = step(SUMMARY);
    let summary = TextSummary::from_model_step(&output).unwrap();
    log.append(&request(id, &source)).await.unwrap();
    let trace: Vec<_> = (0..observations)
        .map(|_| {
            event(
                id,
                Fact::ModelObserved {
                    step_id: format!("{id}-summary"),
                    event: ModelEvent::ResponseMetadata {
                        id: Some("summary-response".into()),
                        model: None,
                        timestamp: None,
                    },
                },
            )
        })
        .collect();
    log.append_batch(&trace).await.unwrap();
    if fail {
        log.append_batch(&[
            event(
                id,
                Fact::ModelInterrupted {
                    model_failure: None,
                    diagnostic: None,
                    step_id: format!("{id}-summary"),
                    status: maka_agent_facts::event::ModelInterruption::Failed,
                },
            ),
            event(
                id,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Failed {
                        model_failure: None,
                        class: "summary_failed".into(),
                        message: None,
                    },
                },
            ),
        ])
        .await
        .unwrap();
        return Vec::new();
    }
    log.append_batch(&[event(
        id,
        Fact::ModelCompleted {
            step_id: format!("{id}-summary"),
            output,
        },
    )])
    .await
    .unwrap();
    let checkpoint = event(
        id,
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode: maka_agent_facts::context::CheckpointMode::Standalone,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest,
                previous_checkpoint_id: source.baseline.map(|b| b.event_id),
                summary,
                summary_step_id: format!("{id}-summary"),
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
