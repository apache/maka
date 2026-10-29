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
use maka_agent_facts::model::{
    ModelPart, ModelToolCall,
    recorded::{CompletionPart, ModelPartial, RecordedPartRef},
};

fn provider_call() -> ModelPart {
    ModelPart::ToolCall {
        call: ModelToolCall {
            id: "same-call".into(),
            name: "remote-search".into(),
            input: json!({}).into(),
            provider_options: None,
            provider_executed: true,
        },
    }
}

fn provider_result() -> ModelPart {
    ModelPart::ToolResult {
        id: "same-call".into(),
        name: "remote-search".into(),
        output: json!({"done":true}),
        is_error: false,
        provider_options: None,
    }
}

async fn observe(log: &EventLog, step: &str, ordinal: u64, part: ModelPart) -> RecordedPartRef {
    let write = event(
        "old",
        Fact::ModelObserved {
            step_id: step.into(),
            event: ModelObservation::Part(fixtures::record("old", step, ordinal, part)),
        },
    );
    log.append(&write).await.unwrap();
    RecordedPartRef {
        event_id: write.event().id.clone(),
        ordinal,
    }
}

#[tokio::test]
async fn interrupted_history_preserves_provider_effect_uncertainty_without_rejecting_known_partial()
{
    for case in ["missing", "settled", "text", "other-step"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.append(&opening("old")).await.unwrap();
        if case == "other-step" {
            let source = log
                .capture_model_context("session", Some("old"), 100_000, 64 * 1024 * 1024)
                .await
                .unwrap();
            log.append(&request("old", "prior", ModelPurpose::Main, &source))
                .await
                .unwrap();
            let call = observe(&log, "prior", 0, provider_call()).await;
            let result = observe(&log, "prior", 1, provider_result()).await;
            let mut output = fixtures::model_output(
                "old",
                "prior",
                json!({"parts":[], "finish_reason":"stop", "usage":{}}),
            );
            output.parts = vec![CompletionPart::Ref(call), CompletionPart::Ref(result)];
            log.append(&event(
                "old",
                Fact::ModelCompleted {
                    step_id: "prior".into(),
                    output,
                },
            ))
            .await
            .unwrap();
        }
        let source = log
            .capture_model_context("session", Some("old"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        log.append(&request("old", "interrupted", ModelPurpose::Main, &source))
            .await
            .unwrap();
        let parts = if case == "text" {
            vec![CompletionPart::Own(fixtures::record(
                "old",
                "interrupted",
                0,
                ModelPart::Text {
                    text_kind: maka_agent_facts::model::TextKind::Text,
                    text: "known partial".into(),
                    provider_options: None,
                },
            ))]
        } else {
            let mut parts = vec![CompletionPart::Ref(
                observe(&log, "interrupted", 0, provider_call()).await,
            )];
            if case == "settled" {
                parts.push(CompletionPart::Ref(
                    observe(&log, "interrupted", 1, provider_result()).await,
                ));
            }
            parts
        };
        log.append_batch(&[
            event(
                "old",
                Fact::ModelInterrupted {
                    partial: Some(ModelPartial {
                        parts,
                        tool_inputs: Vec::new(),
                        response_id: None,
                        model: None,
                        timestamp: None,
                    }),
                    model_failure: None,
                    diagnostic: None,
                    step_id: "interrupted".into(),
                    status: maka_agent_facts::event::ModelInterruption::Failed,
                },
            ),
            event(
                "old",
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Failed {
                        model_failure: None,
                        class: "stream_failed".into(),
                        message: None,
                    },
                },
            ),
        ])
        .await
        .unwrap();
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        let allowed = matches!(case, "settled" | "text");
        let read = log
            .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
            .await;
        assert_eq!(read.is_ok(), allowed, "{case}: {read:?}");
        let prepared = log
            .capture_compaction_context(
                "session",
                None,
                &CheckpointMode::Standalone,
                100_000,
                64 * 1024 * 1024,
            )
            .await;
        assert_eq!(prepared.is_ok(), allowed, "{case}: {prepared:?}");
        if !allowed {
            assert!(
                prepared
                    .unwrap_err()
                    .to_string()
                    .contains("provider tool effect")
            );
        }
        log.close().await.unwrap();
    }
}
