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

#[tokio::test]
async fn active_cuts_require_settled_effects_or_explicit_retry_safety() {
    for (provider, retryable, barrier, safe) in [
        (false, false, false, false),
        (false, true, false, true),
        (false, true, true, false),
        (true, false, false, false),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("provider.sqlite"))
            .await
            .unwrap();
        let anchor = opening("active");
        log.append(&anchor).await.unwrap();
        let source = log
            .read_model_context("session", Some("active"), 100, 8192)
            .await
            .unwrap();
        log.append(&request("active", "main", ModelPurpose::Main, &source))
            .await
            .unwrap();
        if provider {
            log.append(&event("active", Fact::ModelCompleted { step_id: "main".into(),
                output: serde_json::from_value(json!({
                    "parts":[{"kind":"tool_call","call":{"id":"remote","name":"search","input":{},"provider_executed":true}}],
                    "finish_reason":"stop","usage":{}
                })).unwrap()
            })).await.unwrap();
        } else {
            log.append(&event(
                "active",
                Fact::ModelObserved {
                    step_id: "main".into(),
                    event: ModelEvent::PartDelta {
                        id: "partial".into(),
                        text: "visible".into(),
                        provider_options: barrier.then(|| json!({"signature":"provider state"})),
                    },
                },
            ))
            .await
            .unwrap();
            log.append(&event(
                "active",
                Fact::ModelInterrupted {
                    step_id: "main".into(),
                    status: if retryable {
                        maka_runtime::event::ModelInterruption::RetryableFailure
                    } else {
                        maka_runtime::event::ModelInterruption::Failed
                    },
                },
            ))
            .await
            .unwrap();
        }
        let mode = CheckpointMode::MidTurn {
            anchor_event_id: anchor.event().id.clone(),
        };
        assert_eq!(
            log.prepare_context_compaction("session", Some("active"), 100, 8192, &mode)
                .await
                .is_ok(),
            safe,
            "a retryable classification cannot override observed replay barriers",
        );
        if provider {
            log.append(&event(
                "active",
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            ))
            .await
            .unwrap();
            assert!(
                log.read_model_context("session", None, 100, 8192)
                    .await
                    .is_err(),
                "closing an invocation does not settle a provider tool effect",
            );
        }
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn private_summary_failure_allows_main_progress_only_without_provider_effects() {
    for provider_effect in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("summary.sqlite"))
            .await
            .unwrap();
        let anchor = opening("active");
        log.append(&anchor).await.unwrap();
        let source = log
            .read_model_context("session", Some("active"), 100, 16384)
            .await
            .unwrap();
        log.append(&request("active", "main", ModelPurpose::Main, &source))
            .await
            .unwrap();
        log.append(&completion("active", "main", "completed work"))
            .await
            .unwrap();
        let mode = CheckpointMode::MidTurn {
            anchor_event_id: anchor.event().id.clone(),
        };
        let source = log
            .prepare_context_compaction("session", Some("active"), 100, 16384, &mode)
            .await
            .unwrap();
        log.append(&request(
            "active",
            "summary",
            ModelPurpose::Summary,
            &source,
        ))
        .await
        .unwrap();
        let observation = if provider_effect {
            ModelEvent::ToolCall(maka_runtime::model::ModelToolCall {
                id: "remote".into(),
                name: "search".into(),
                input: json!({}),
                provider_executed: true,
                provider_options: None,
            })
        } else {
            ModelEvent::PartDelta {
                id: "text".into(),
                text: "private partial text".into(),
                provider_options: None,
            }
        };
        log.append(&event(
            "active",
            Fact::ModelObserved {
                step_id: "summary".into(),
                event: observation,
            },
        ))
        .await
        .unwrap();
        log.append(&event(
            "active",
            Fact::ModelInterrupted {
                step_id: "summary".into(),
                status: maka_runtime::event::ModelInterruption::Failed,
            },
        ))
        .await
        .unwrap();
        let tail = log
            .read_model_context("session", Some("active"), 100, 16384)
            .await
            .unwrap();
        let next = log
            .append(&request("active", "next", ModelPurpose::Main, &tail))
            .await;
        assert_eq!(
            next.is_ok(),
            !provider_effect,
            "private summary is not permission to hide a remote effect"
        );
        if !provider_effect {
            log.append(&completion("active", "next", "new work"))
                .await
                .unwrap();
        }
        assert_eq!(
            log.prepare_context_compaction("session", Some("active"), 100, 32768, &mode)
                .await
                .is_ok(),
            !provider_effect
        );
        log.close().await.unwrap();
    }
}
