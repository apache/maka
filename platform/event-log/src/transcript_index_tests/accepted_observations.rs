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
    ModelFinishReason, ModelSource, ModelToolCall, recorded::RecordedPartRef,
};
use serde_json::json;

async fn observed(log: &EventLog, accepted: bool) -> (u64, ModelCompletion) {
    log.create_session("a", "create", &json!({}), 1)
        .await
        .unwrap();
    log.append(&event("a", opening())).await.unwrap();
    let source = log.prefix(16, 16384).await.unwrap();
    let mut requested = request("a");
    let Fact::ModelRequested {
        item_acceptance,
        source_scope,
        source_high_water,
        source_digest,
        ..
    } = &mut requested
    else {
        unreachable!()
    };
    *item_acceptance = accepted;
    *source_scope = source.scope;
    *source_high_water = source.high_water;
    *source_digest = source.digest;
    let mut through = log.append(&event("a", requested)).await.unwrap();
    let mut parts = Vec::new();
    for (ordinal, part) in [
        ModelPart::Text {
            text_kind: TextKind::Text,
            text: "accepted中😀".into(),
            provider_options: None,
        },
        ModelPart::Source {
            source: ModelSource::Url {
                id: "ref".into(),
                url: "https://example.test/ref".into(),
                title: Some("Ref".into()),
                provider_options: None,
            },
        },
        ModelPart::ToolCall {
            call: ModelToolCall {
                id: "provider".into(),
                name: "Remote".into(),
                input: json!({"q":"literal"}).into(),
                provider_options: None,
                provider_executed: true,
            },
        },
        ModelPart::ToolResult {
            id: "provider".into(),
            name: "Remote".into(),
            output: json!({"answer":"provider中😀"}),
            is_error: false,
            provider_options: None,
        },
    ]
    .into_iter()
    .enumerate()
    {
        let record = record("step-a", ordinal as u64, part);
        if accepted || ordinal >= 2 {
            let write = event("a", observe("a", ModelObservation::Part(record)));
            through = log.append(&write).await.unwrap();
            parts.push(CompletionPart::Ref(RecordedPartRef {
                event_id: write.event().id.clone(),
                ordinal: ordinal as u64,
            }));
        } else {
            parts.push(CompletionPart::Own(record));
        }
    }
    (
        through,
        ModelCompletion {
            parts,
            finish_reason: ModelFinishReason::Stop,
            usage: ModelUsage::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    )
}

async fn visible(log: &EventLog, through: u64) -> Vec<Value> {
    crate::transcript_cache::materialize_all_rows(log, "a", through)
        .await
        .unwrap();
    crate::test_store::inspect_cache(log, |db| rows(db, "a"))
        .await
        .into_iter()
        .skip(2)
        .map(|row| serde_json::from_slice(&row.1).unwrap())
        .collect()
}

fn assert_parts(parts: &[Value]) {
    assert_eq!(
        parts
            .iter()
            .map(|part| part["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["assistant", "assistant", "tool_call", "tool_result"]
    );
    assert_eq!(parts[0]["text"], "accepted中😀");
    assert_eq!(parts[1]["text"], "Source: Ref\nhttps://example.test/ref");
    assert_eq!(parts[2]["args"], json!({"q":"literal"}));
    assert_eq!(
        parts[3]["content"]["value"],
        json!({"answer":"provider中😀"})
    );
}

#[tokio::test]
async fn accepted_parts_are_visible_before_seal_and_unaccepted_parts_wait_for_completion() {
    for accepted in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("items.sqlite"))
            .await
            .unwrap();
        let (before_seal, output) = observed(&log, accepted).await;
        let before = visible(&log, before_seal).await;
        if accepted {
            assert_parts(&before);
        } else {
            assert!(before.is_empty());
        }
        let sealed = log
            .append(&event(
                "a",
                Fact::ModelCompleted {
                    step_id: "step-a".into(),
                    output,
                },
            ))
            .await
            .unwrap();
        assert_parts(&visible(&log, sealed).await);
        assert_eq!(visible(&log, before_seal).await, before);
        log.close().await.unwrap();
    }
}
