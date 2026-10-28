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
use maka_agent_facts::model::ModelToolCall;

fn provider_call() -> ModelEvent {
    ModelEvent::ToolCall(ModelToolCall {
        id: "same-call".into(),
        name: "remote-search".into(),
        input: json!({}).into(),
        provider_options: None,
        provider_executed: true,
    })
}

fn provider_result() -> ModelEvent {
    ModelEvent::ProviderToolResult {
        id: "same-call".into(),
        name: "remote-search".into(),
        output: json!({"done":true}),
        is_error: false,
        provider_options: None,
    }
}

async fn observe(log: &EventLog, step: &str, observed: ModelEvent) {
    log.append(&event(
        "old",
        Fact::ModelObserved {
            step_id: step.into(),
            event: observed,
        },
    ))
    .await
    .unwrap();
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
            observe(&log, "prior", provider_call()).await;
            observe(&log, "prior", provider_result()).await;
            log.append(&event("old", Fact::ModelCompleted { step_id:"prior".into(),
                output:serde_json::from_value(json!({
                    "parts":[
                        {"kind":"tool_call","call":{"id":"same-call","name":"remote-search","input":{"kind":"json","data":{}},"provider_executed":true}},
                        {"kind":"tool_result","id":"same-call","name":"remote-search","output":{"done":true},"is_error":false}
                    ],"finish_reason":"stop","usage":{}
                })).unwrap()
            })).await.unwrap();
        }
        let source = log
            .capture_model_context("session", Some("old"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        log.append(&request("old", "interrupted", ModelPurpose::Main, &source))
            .await
            .unwrap();
        if case == "text" {
            observe(
                &log,
                "interrupted",
                ModelEvent::PartDelta {
                    id: "partial".into(),
                    text: "known partial".into(),
                    provider_options: None,
                },
            )
            .await;
        } else {
            observe(&log, "interrupted", provider_call()).await;
            if case == "settled" {
                observe(&log, "interrupted", provider_result()).await;
            }
        }
        log.append_batch(&[
            event(
                "old",
                Fact::ModelInterrupted {
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
