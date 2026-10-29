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
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::handoff::HandoffIntent;
use maka_agent_facts::handoff::HandoffPause;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelToolCall;

pub(super) fn execution() -> Box<maka_agent_facts::handoff::HandoffExecution> {
    use maka_agent_facts::handoff::HandoffExecution;
    use maka_agent_facts::handoff::HandoffTools;
    Box::new(HandoffExecution {
        replay: ReplayEvidence {
            version: REPLAY_VERSION,
            digest: digest('a'),
            route_identity: digest('b'),
        },
        context: None,
        provider_options: serde_json::json!({}),
        main_output_limit: None,
        supports_vision: false,
        tools: HandoffTools {
            catalog_digest: digest('c'),
            loaded: Default::default(),
        },
        compaction: maka_agent_facts::handoff::CompactionBudget::Available,
        replay_base: None,
    })
}

#[tokio::test]
async fn handoff_rejects_unresolved_provider_effects_but_accepts_effect_free_summary_failure() {
    for provider_effect in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("handoff.sqlite"))
            .await
            .unwrap();
        let prior = opening("prior", None);
        append(&log, &prior).await;
        close(&log, &prior).await;
        let source = opening("source", None);
        append(&log, &source).await;
        let context = if provider_effect {
            log.capture_model_context("session", Some("source"), 100_000, 64 * 1024 * 1024)
                .await
                .unwrap()
        } else {
            log.context_before_run(&source.invocation, 100, 65536)
                .await
                .unwrap()
        };
        append(
            &log,
            &RuntimeEvent::new(
                source.invocation.clone(),
                Fact::ModelRequested {
                    context_breakdown: None,
                    item_acceptance: false,
                    step_id: "step".into(),
                    model_id: "test".into(),
                    purpose: if provider_effect {
                        ModelPurpose::Main
                    } else {
                        ModelPurpose::Summary
                    },
                    context: None,
                    source_scope: context.source_evidence.scope,
                    source_high_water: context.source_evidence.high_water,
                    source_digest: context.source_evidence.digest,
                    effective_source_digest: Some(context.effective_source_digest),
                    input_digest: digest('a'),
                    route_identity: digest('b'),
                    checkpoint_event_id: None,
                },
            ),
        )
        .await;
        let seal = EventWrite::plain(RuntimeEvent::new(
            source.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: HandoffPause {
                        intent: HandoffIntent {
                            handoff_id: "handoff".into(),
                            host_epoch: "epoch".into(),
                            root_run_id: source.invocation.run_id.clone(),
                            successor_run_id: "successor-run".into(),
                            successor_invocation_id: "successor-invocation".into(),
                            claim_id: "claim".into(),
                        },
                        execution: execution(),
                    },
                },
            },
        ))
        .unwrap();
        assert!(
            log.append(&seal).await.is_err(),
            "an open request cannot be paused"
        );
        let observed = if provider_effect {
            ModelEvent::ToolCall(ModelToolCall {
                id: "remote".into(),
                name: "search".into(),
                input: serde_json::json!({}).into(),
                provider_options: None,
                provider_executed: true,
            })
        } else {
            ModelEvent::ResponseMetadata {
                id: Some("summary-response".into()),
                model: None,
                timestamp: None,
            }
        };
        append(
            &log,
            &RuntimeEvent::new(
                source.invocation.clone(),
                Fact::ModelObserved {
                    step_id: "step".into(),
                    event: observed,
                },
            ),
        )
        .await;
        append(
            &log,
            &RuntimeEvent::new(
                source.invocation.clone(),
                Fact::ModelInterrupted {
                    model_failure: None,
                    diagnostic: None,
                    step_id: "step".into(),
                    status: ModelInterruption::Failed,
                },
            ),
        )
        .await;
        let before = log.prefix(100, 65536).await.unwrap();
        assert_eq!(log.append(&seal).await.is_ok(), !provider_effect);
        if provider_effect {
            assert_eq!(
                log.prefix(100, 65536).await.unwrap().digest,
                before.digest,
                "interruption does not settle the observed provider effect"
            );
        }
        log.close().await.unwrap();
    }
}
