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

use maka_agent_facts::accounting::Activity;
use maka_agent_facts::accounting::Selection;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::recorded::ModelCompletion;
use maka_event_log::{EventLog, usage::Query};
use std::{
    collections::BTreeSet,
    time::{Duration, UNIX_EPOCH},
};

#[tokio::test]
async fn accounting_pages_bound_bytes_without_dropping_records_or_reading_response_bodies() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("usage.sqlite"))
        .await
        .unwrap();
    log.append(&event(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            content: "not Usage data".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    // Long public model IDs reach the byte bound before the item bound.
    for i in 0..80 {
        log.append_batch(&[
            event(Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                step_id: format!("step-{i}"),
                model_id: format!("{i}-{}", "model".repeat(400)),
                purpose: ModelPurpose::Main,
                source_scope: LogScope::Session { id: "usage".into() },
                source_high_water: 0,
                source_digest: "source".into(),
                input_digest: "input".into(),
                route_identity: "route".into(),
                checkpoint_event_id: None,
                context: None,
                effective_source_digest: None,
            }),
            event(Fact::ModelCompleted {
                step_id: format!("step-{i}"),
                output: ModelCompletion {
                    model: None,
                    response_id: None,
                    timestamp: None,
                    parts: vec![model_part(
                        "invocation",
                        &format!("step-{i}"),
                        0,
                        maka_agent_facts::model::ModelPart::Text {
                            text_kind: maka_agent_facts::model::TextKind::Text,
                            text: "x".repeat(65536).into(),
                            provider_options: None,
                        },
                    )],
                    finish_reason: ModelFinishReason::Stop,
                    usage: ModelUsage {
                        input_tokens: Some(i),
                        ..Default::default()
                    },
                    provider_options: None,
                },
            }),
        ])
        .await
        .unwrap();
    }
    log.append(&event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    }))
    .await
    .unwrap();
    let mut query = Query {
        from: 10.25,
        to: 10.25,
        session_id: None,
        through: None,
    };
    let mut offset = 0;
    let mut seen = BTreeSet::new();
    loop {
        let page = log
            .usage_activity(query.clone(), Selection::default(), offset, 100)
            .await
            .unwrap();
        assert_eq!(page.total, 80);
        assert!(!page.attempts.is_empty() && page.attempts.len() < 80);
        assert!(serde_json::to_vec(&page.attempts).unwrap().len() <= 32 * 1024);
        for activity in page.attempts {
            let Activity::Model(attempt) = activity else {
                panic!("unexpected tool activity")
            };
            assert!(seen.insert(attempt.request_id));
            assert_eq!(attempt.session_id.as_deref(), Some("usage"));
        }
        query.through = Some(page.through);
        match page.next_offset {
            Some(next) => {
                assert!(next > offset);
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(seen.len(), 80);
    let complete = log.usage_summary(query.clone()).await.unwrap();
    assert_eq!(complete.through, query.through.unwrap());
    assert_eq!(complete.summary.models.calls, 80);
    assert_eq!(complete.summary.by_model.len(), 80);
    let expected_models: BTreeSet<_> = (0..80)
        .map(|i| format!("{i}-{}", "model".repeat(400)))
        .collect();
    let complete_models: BTreeSet<_> = complete
        .summary
        .by_model
        .iter()
        .map(|row| row.model_id.clone())
        .collect();
    assert_eq!(complete_models, expected_models);
    // Native Settings can page the same oversized breakdown without changing
    // its full totals or fence, and without losing any long model identity.
    let mut offset = 0;
    let mut models = BTreeSet::new();
    loop {
        let report = log
            .usage_summary_page(
                query.clone(),
                maka_agent_facts::accounting::Group::ByModel,
                offset,
            )
            .await
            .unwrap();
        assert_eq!(report.through, query.through.unwrap());
        assert_eq!(report.summary.models.calls, 80);
        assert!(serde_json::to_vec(&report.summary).unwrap().len() <= 48 * 1024);
        assert!(report.summary.by_model.len() <= 32);
        assert!(report.summary.by_provider.is_empty() && report.summary.by_tool.is_empty());
        for row in report.summary.by_model {
            assert!(models.insert(row.model_id));
        }
        match report.next_offset {
            Some(next) => {
                assert!(next > offset);
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(models, complete_models);
    log.close().await.unwrap();
}

fn event(fact: Fact) -> EventWrite {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "usage".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    );
    event.recorded_at = UNIX_EPOCH + Duration::from_micros(10250);
    EventWrite::plain(event).unwrap()
}

fn model_part(
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
