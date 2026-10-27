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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tool_call::ToolRejection;
use maka_event_log::EventLog;
use maka_presentation::tool_message_id;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[path = "payloads.rs"]
mod payloads;

fn event(fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    ))
    .unwrap()
}
fn success(operation: &str, output: Value) -> EventWrite {
    let template = event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    });
    let template = template.event();
    EventWrite::tool_success(
        template.id.clone(),
        template.recorded_at,
        template.invocation.clone(),
        operation.into(),
        output.into(),
    )
    .unwrap()
    .0
}
async fn accepted(log: &EventLog, step: &str, name: &str) -> u64 {
    let call = ModelToolCall {
        id: "reused-provider-id".into(),
        name: name.into(),
        input: json!({}).into(),
        provider_options: None,
        provider_executed: false,
    };
    let facts = [
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: step.into(),
            model_id: "fixture".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "".into(),
            effective_source_digest: None,
            input_digest: "".into(),
            route_identity: "".into(),
        },
        Fact::ModelObserved {
            step_id: step.into(),
            event: ModelEvent::ToolCall(call.clone()),
        },
        Fact::ModelCompleted {
            step_id: step.into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ];
    *log.append_batch(&facts.map(event))
        .await
        .unwrap()
        .last()
        .unwrap()
}
fn rows(db: &Connection) -> Vec<(maka_agent_facts::history::RowPosition, Vec<u8>, String)> {
    db.prepare("SELECT source_sequence, item_index, payload, digest FROM temp.transcript_rows ORDER BY source_sequence, item_index")
        .unwrap()
        .query_map([], |row| Ok((maka_agent_facts::history::RowPosition { source_sequence: row.get::<_, i64>(0)? as u64, item_index: row.get::<_, i64>(1)? as u64 }, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
async fn materialize_all(log: &EventLog, fence: u64) {
    crate::transcript_cache::materialize_all_rows(log, "session", fence)
        .await
        .unwrap();
}

#[tokio::test]
async fn tool_boundaries_page_independently_and_rebuild_exact_ids_without_reading_sibling_results()
{
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.append(&event(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: Vec::new(),
            content: "read".into(),
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    let accepted_fence = accepted(&log, "first", "exec").await;
    let parent = "first:reused-provider-id";
    log.append(&event(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: parent.into(),
        call: ToolCallIdentity::provider("first".into(), "reused-provider-id".into()),
        name: "exec".into(),
        input: json!({}),
    }))
    .await
    .unwrap();
    for index in 0..3 {
        let operation = format!("child-{index}");
        log.append(&event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation.clone(),
            call: ToolCallIdentity {
                tool_call_id: format!("nested-{index}"),
                origin: ToolOrigin::CodeMode {
                    parent_operation_id: parent.into(),
                    parent_tool_call_id: "reused-provider-id".into(),
                },
            },
            name: "Read".into(),
            input: json!({"path":format!("file-{index}")}),
        }))
        .await
        .unwrap();
        // Three siblings exceed the 16 MiB evidence budget together. Each tool
        // boundary needs only its own result, parent T1 and accepted model step.
        log.append(&success(
            &operation,
            json!({"content":"x".repeat(6 * 1024 * 1024)}),
        ))
        .await
        .unwrap();
    }
    log.append(&success(
        parent,
        json!({"ok":true,"value":null,"toolCalls":[]}),
    ))
    .await
    .unwrap();
    accepted(&log, "second", "Read").await;
    let refusal = event(Fact::ToolRejected {
        operation_id: "second:reused-provider-id".into(),
        call: ToolCallIdentity::provider("second".into(), "reused-provider-id".into()),
        name: "Read".into(),
        input: json!({}).into(),
        reason: ToolRejection::InvalidInput {
            message: "path required".into(),
        },
    });
    log.append(&refusal).await.unwrap();
    let through = log
        .append(&event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .await
        .unwrap();
    let notices = log.subscribe_commits();
    // A historical fence sees the planned provider call, but no later dispatch,
    // nested call, result or rejection from the already-existing future suffix.
    materialize_all(&log, accepted_fence).await;
    let first = crate::test_store::inspect_cache(&log, rows).await;
    assert_eq!(first.len(), 3);
    let parent_id = tool_message_id("invocation", parent);
    let planned: Value = serde_json::from_slice(&first[2].1).unwrap();
    assert_eq!(planned["type"], "tool_call");
    assert_eq!(planned["id"], parent_id);
    assert!(
        planned.get("stepId").is_none(),
        "pure-tool steps need no fake assistant anchor"
    );
    materialize_all(&log, through).await;
    assert!(
        !notices.has_changed().unwrap(),
        "derived cache must not publish execution commits"
    );
    let original = crate::test_store::inspect_cache(&log, rows).await;
    assert_eq!(&original[..3], first.as_slice());
    assert_eq!(original.len(), 17);
    let values: Vec<Value> = original
        .iter()
        .map(|(_, bytes, digest)| {
            assert_eq!(
                digest,
                &format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
            );
            serde_json::from_slice(bytes).unwrap()
        })
        .filter(|row: &Value| row["status"] != "running" && row["type"] != "tool_activity")
        .collect();
    for index in 0..3 {
        let call = &values[2 + index * 2];
        let result = &values[3 + index * 2];
        let id = tool_message_id("invocation", &format!("child-{index}"));
        assert_eq!(call["id"], id);
        assert_eq!(result["toolUseId"], id);
        for value in [call, result] {
            assert_eq!(value["origin"], "code_mode");
            assert_eq!(value["modelVisibility"], "hidden");
            assert_eq!(value["parentToolCallId"], parent_id);
            assert_eq!(value["parentOperationId"], parent);
        }
        assert_eq!(result["isError"], false);
        assert_eq!(result["content"]["kind"], "json");
        assert_eq!(
            result["content"]["value"]["content"]
                .as_str()
                .unwrap()
                .len(),
            6 * 1024 * 1024
        );
    }
    let second_id = tool_message_id("invocation", "second:reused-provider-id");
    assert_ne!(
        second_id, parent_id,
        "raw provider ID reuse must not alias UI rows"
    );
    assert_eq!(values[8]["toolUseId"], parent_id);
    assert_eq!(values[9]["id"], second_id);
    assert_eq!(values[10]["toolUseId"], second_id);
    assert_eq!(values[10]["id"], refusal.event().id);
    assert_eq!(values[10]["isError"], true);
    assert_eq!(values[10]["content"]["kind"], "text");
    assert!(
        values[10]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("path required")
    );
    assert_eq!(values[11]["status"], "completed");
    // Search scans only bounded disposable-index batches, including large
    // nested results; visible trace parents and errors remain searchable.
    for (query, include_internal, expected) in [
        ("xxxx", false, 3),
        ("toolCalls", false, 1),
        ("toolCalls", true, 1),
        ("path required", false, 1),
    ] {
        let mut after = None;
        let mut sequences = Vec::new();
        let mut batches = 0;
        loop {
            let result = log
                .search_transcript(
                    "session",
                    maka_event_log::transcript::search::TranscriptSearch {
                        through,
                        after,
                        query: query.into(),
                        case_sensitive: true,
                        whole_word: false,
                        include_internal,
                        max_matches: 64,
                    },
                )
                .await
                .unwrap();
            batches += 1;
            for found in result.matches {
                let (sequence, preview) = (found.position, found.preview);
                assert!(preview.len() <= 384 && preview.contains(query));
                assert!(sequences.last().is_none_or(|last| sequence > *last));
                sequences.push(sequence);
            }
            let Some(next) = result.next_after else {
                break;
            };
            assert!(after.is_none_or(|after| next > after) && batches < 8);
            after = Some(next);
        }
        assert_eq!(sequences.len(), expected, "{query}");
        assert!(batches >= 2, "18 MiB of siblings must not fit in one scan");
    }
    assert!(
        !notices.has_changed().unwrap(),
        "search emits no execution commits"
    );
    let prefix = log.prefix(128, 32 * 1024 * 1024).await.unwrap();
    let mut full = maka_presentation::InvocationView::new();
    let mut expected = Vec::new();
    for stored in &prefix.events {
        let raw = if matches!(
            stored.event.fact,
            Fact::ToolSettled {
                outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
                ..
            }
        ) {
            Some(
                log.resolve_tool_result("session", &stored.event.id)
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        for row in full.push_with_tool_output(stored, raw.as_ref()).unwrap() {
            expected.push((row.position, serde_json::to_vec(&row.message).unwrap()));
        }
    }
    assert_eq!(
        original
            .iter()
            .map(|(position, payload, _)| (*position, payload.clone()))
            .collect::<Vec<_>>(),
        expected,
        "own-boundary projection must exactly match full invocation replay"
    );
    let canonical = prefix.digest;
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
            .unwrap()
    })
    .await;
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    materialize_all(&reopened, through).await;
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, rows).await,
        original,
        "replaying earlier call evidence must be idempotent"
    );
    assert_eq!(
        reopened.prefix(128, 32 * 1024 * 1024).await.unwrap().digest,
        canonical
    );
    crate::test_store::inspect_cache(&reopened, move |db| {
        db.execute("DELETE FROM temp.transcript_rows", []).unwrap()
    })
    .await;
    crate::test_store::inspect_cache(&reopened, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
            .unwrap()
    })
    .await;
    materialize_all(&reopened, through).await;
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, rows).await,
        original,
        "the complete index is disposable"
    );
}
