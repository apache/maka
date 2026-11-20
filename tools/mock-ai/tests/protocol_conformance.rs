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

//! Feeds real HTTP SSE and WebSocket output from `MockAiServer` directly into
//! Maka's production `maka_provider_protocol` decoders to guarantee wire fidelity.

use futures_util::{SinkExt, StreamExt};
use maka_mock_ai::{
    Citation, CompactionOutput, FinishReason, MockAiBuilder, NativeToolEvent, ToolCallSpec,
    TurnEvent, TurnPlan, Usage, WebSearchResult,
};
use maka_provider_protocol::{
    anthropic, chat_completions,
    output::{Event as WireEvent, Stop, TextKind},
    responses,
};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> reqwest::Response {
    client
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn chat_completions_sse_conforms_to_maka_decoder() {
    let plan = TurnPlan::new()
        .push(TurnEvent::Reasoning {
            text: "plan step 1 and 2".into(),
            chunk_chars: 5,
            signature: None,
            encrypted_content: None,
        })
        .push_text_chunked("Calling two tools in parallel.", 7)
        .push(
            ToolCallSpec::new("call_a", "Read", json!({ "path": "Cargo.toml" }))
                .with_chunk_chars(6),
        )
        .push(
            ToolCallSpec::new("call_b", "Shell", json!({ "command": "echo hi" }))
                .with_chunk_chars(5),
        )
        .with_usage(
            Usage::new(1000, 120)
                .with_cache_read(400)
                .with_cache_creation(100)
                .with_reasoning(40),
        )
        .finish(FinishReason::ToolCalls);

    let server = MockAiBuilder::new().scripted([plan]).start().await.unwrap();
    let client = reqwest::Client::new();
    let resp = post_json(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &json!({
            "model": "gpt-4.1",
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [{ "role": "user", "content": "check repo" }],
        }),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let raw_sse = resp.bytes().await.unwrap();

    let mut decoder =
        chat_completions::Stream::new("openai".into()).with_reasoning_observations(true);
    let mut seq = 0usize;
    let mut next_id = || {
        seq += 1;
        format!("gen_{seq}")
    };
    let mut events = decoder.push(&raw_sse, &mut next_id).unwrap();
    events.extend(decoder.finish(&mut next_id).unwrap());

    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    let mut finish = None;

    for ev in events {
        match ev {
            WireEvent::TextDelta {
                kind: TextKind::Text,
                text: t,
                ..
            } => text.push_str(&t),
            WireEvent::TextDelta {
                kind: TextKind::Reasoning,
                text: r,
                ..
            } => reasoning.push_str(&r),
            WireEvent::ToolCall(call) => tool_calls.push((call.id, call.name, call.input)),
            WireEvent::Finish(f) => finish = Some(f),
            WireEvent::Error(e) => panic!("unexpected chat_completions decode error: {e}"),
            _ => {}
        }
    }

    assert_eq!(reasoning, "plan step 1 and 2");
    assert_eq!(text, "Calling two tools in parallel.");
    assert_eq!(tool_calls.len(), 2);
    assert_eq!(tool_calls[0].0, "call_a");
    assert_eq!(tool_calls[0].1, "Read");
    assert_eq!(tool_calls[1].0, "call_b");
    assert_eq!(tool_calls[1].1, "Shell");

    let finish = finish.expect("finish event");
    assert_eq!(finish.reason, Stop::ToolCalls);
    let usage = finish.usage.expect("usage");
    assert_eq!(usage.input, Some(1000));
    assert_eq!(usage.cache_read, Some(400));
    assert_eq!(usage.cache_write, Some(100));
    assert_eq!(usage.output, Some(120));
    assert_eq!(usage.reasoning, Some(40));
    assert_eq!(usage.text, Some(80));
}

#[tokio::test]
async fn responses_http_sse_and_ws_conform_to_maka_decoder_including_compaction_and_store() {
    let turn1 = TurnPlan::new()
        .with_response_id("resp_turn_1")
        .push(TurnEvent::Reasoning {
            text: "thinking through search".into(),
            chunk_chars: 6,
            signature: None,
            encrypted_content: Some("enc_rs_1".into()),
        })
        .push(TurnEvent::NativeTool(NativeToolEvent::WebSearch {
            id: "ws_1".into(),
            query: "maka protocol".into(),
            results: vec![WebSearchResult {
                url: "https://example.org/docs".into(),
                title: "Docs".into(),
                encrypted_content: None,
            }],
        }))
        .push(TurnEvent::Text {
            text: "Found it.".into(),
            chunk_chars: 3,
            citations: vec![Citation {
                url: "https://example.org/docs".into(),
                title: Some("Docs".into()),
                cited_text: None,
            }],
        })
        .push(
            ToolCallSpec::new("call_distinct", "exec", json!({ "code": "text(1);" }))
                .with_chunk_chars(4),
        )
        .with_usage(Usage::new(500, 90).with_cache_read(200).with_reasoning(30))
        .finish(FinishReason::ToolCalls);

    let turn2_compaction = TurnPlan::new()
        .with_response_id("resp_compact_2")
        .push_compaction(CompactionOutput::new("enc_checkpoint_payload").with_id("cmp_1"))
        .with_usage(Usage::new(2000, 50))
        .finish(FinishReason::Compaction);

    let server = MockAiBuilder::new()
        .scripted([turn1, turn2_compaction])
        .start()
        .await
        .unwrap();

    // 1) HTTP SSE with store: true
    let client = reqwest::Client::new();
    let resp = post_json(
        &client,
        &format!("{}/responses", server.base_url()),
        &json!({
            "model": "gpt-4.1",
            "stream": true,
            "store": true,
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "hello" }] }],
        }),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let raw_sse = resp.bytes().await.unwrap();

    let mut sse = responses::sse::Sse::default();
    let mut decoder = responses::decode::Decoder::new(
        responses::ReasoningMode::PlaintextSummary,
        Some("web_search".into()),
    );
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut part_kinds = std::collections::HashMap::new();
    let mut tool_ids = Vec::new();
    let mut saw_search = false;
    let mut saw_finish = false;

    for &b in &raw_sse {
        if let Some(frame) = sse.push(b).unwrap() {
            let evs = decoder.push(frame).unwrap();
            for ev in evs {
                match ev {
                    responses::Event::PartStarted { id, kind, .. } => {
                        part_kinds.insert(id, kind);
                    }
                    responses::Event::PartDelta { id, text: t, .. } => match part_kinds.get(&id) {
                        Some(TextKind::Reasoning) => reasoning.push_str(&t),
                        _ => text.push_str(&t),
                    },
                    responses::Event::ToolCall {
                        id,
                        name,
                        provider_executed,
                        ..
                    } => {
                        if provider_executed && name == "web_search" {
                            saw_search = true;
                        } else {
                            tool_ids.push((id, name));
                        }
                    }
                    responses::Event::Finished { usage, .. } => {
                        saw_finish = true;
                        assert_eq!(usage.input, Some(500));
                        assert_eq!(usage.cache_read, Some(200));
                        assert_eq!(usage.output, Some(90));
                        assert_eq!(usage.reasoning, Some(30));
                    }
                    _ => {}
                }
            }
        }
    }
    decoder.end().unwrap();
    assert_eq!(reasoning, "thinking through search");
    assert_eq!(text, "Found it.");
    assert!(saw_search);
    assert!(saw_finish);
    assert_eq!(tool_ids, vec![("call_distinct".into(), "exec".into())]);

    // Stored response is retrievable via GET /v1/responses/{id}
    let fetched_bytes = client
        .get(format!("{}/responses/resp_turn_1", server.base_url()))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let fetched: Value = serde_json::from_slice(&fetched_bytes).unwrap();
    assert_eq!(fetched["id"], "resp_turn_1");
    assert_eq!(fetched["status"], "completed");
    // Verify item_id != call_id on wire
    let fn_item = fetched["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "function_call")
        .unwrap();
    assert_ne!(fn_item["id"], fn_item["call_id"]);

    // 2) WebSocket native compaction turn (with compaction_trigger)
    let (mut ws, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    ws.send(WsMessage::text(
        json!({
            "type": "response.create",
            "model": "gpt-4.1",
            "store": false,
            "previous_response_id": "resp_turn_1",
            "input": [{ "type": "compaction_trigger" }],
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let mut done_item = None;
    let mut completed_output_item = None;
    while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
        let ev: Value = serde_json::from_str(&txt).unwrap();
        match ev["type"].as_str().unwrap_or("") {
            "response.output_item.done" if ev["item"]["type"] == "compaction" => {
                done_item = Some(ev["item"].clone());
            }
            "response.completed" => {
                completed_output_item = Some(ev["response"]["output"][0].clone());
                assert_eq!(ev["response"]["id"], "resp_compact_2");
                break;
            }
            _ => {}
        }
    }
    assert!(done_item.is_some());
    assert_eq!(done_item, completed_output_item);
    assert_eq!(
        done_item.unwrap()["encrypted_content"],
        "enc_checkpoint_payload"
    );

    // 3) New WS connection MUST reject continuing a `store: false` response ID from another connection!
    let (mut ws2, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    ws2.send(WsMessage::text(
        json!({
            "type": "response.create",
            "model": "gpt-4.1",
            "store": false,
            "previous_response_id": "resp_compact_2",
            "input": "try illegal cross-connection continuation",
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let err_msg = ws2.next().await.unwrap().unwrap().into_text().unwrap();
    let err_val: Value = serde_json::from_str(&err_msg).unwrap();
    assert_eq!(err_val["type"], "error");
    assert_eq!(err_val["error"]["code"], "previous_response_not_found");
}

#[tokio::test]
async fn anthropic_messages_sse_and_compaction_conform_to_maka_decoder() {
    let turn1 = TurnPlan::new()
        .push(TurnEvent::Reasoning {
            text: "deep thought".into(),
            chunk_chars: 4,
            signature: Some("sig_anth_1".into()),
            encrypted_content: None,
        })
        .push(TurnEvent::RedactedThinking {
            data: "opaque_redacted".into(),
        })
        .push(TurnEvent::NativeTool(NativeToolEvent::WebSearch {
            id: "srv_search_1".into(),
            query: "anthropic streaming".into(),
            results: vec![WebSearchResult {
                url: "https://docs.anthropic.com".into(),
                title: "Anthropic Docs".into(),
                encrypted_content: Some("enc_doc".into()),
            }],
        }))
        .push(TurnEvent::Text {
            text: "Here is the answer.".into(),
            chunk_chars: 5,
            citations: vec![Citation {
                url: "https://docs.anthropic.com".into(),
                title: Some("Anthropic Docs".into()),
                cited_text: Some("streaming spec".into()),
            }],
        })
        .push(ToolCallSpec::new("toolu_1", "Read", json!({ "path": "lib.rs" })).with_chunk_chars(4))
        .with_usage(
            Usage::new(800, 150)
                .with_cache_read(300)
                .with_cache_creation(200),
        )
        .finish(FinishReason::ToolCalls);

    let turn2_compaction = TurnPlan::new()
        .push_compaction(CompactionOutput::new("Compacted Anthropic summary.").with_pause(true))
        .with_usage(Usage::new(1500, 45))
        .finish(FinishReason::Compaction);

    let server = MockAiBuilder::new()
        .scripted([turn1, turn2_compaction])
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::new();

    // Turn 1: complex thinking + search + text + citation + tool_use
    let raw1 = post_json(
        &client,
        &format!("{}/messages", server.base_url()),
        &json!({
            "model": "claude-sonnet-4-5",
            "stream": true,
            "max_tokens": 1024,
            "messages": [{ "role": "user", "content": "search and read" }],
        }),
    )
    .await
    .bytes()
    .await
    .unwrap();

    let mut decoder = anthropic::stream::Stream::new(anthropic::response::Options::default());
    let mut seq = 0usize;
    let mut next_id = || {
        seq += 1;
        format!("src_{seq}")
    };
    let mut events = decoder.push(&raw1, &mut next_id, |_| {}).unwrap();
    events.extend(decoder.finish());

    let mut text = String::new();
    let mut thinking = String::new();
    let mut saw_tool = false;
    let mut saw_finish = false;

    for ev in events {
        match ev {
            WireEvent::TextDelta {
                kind: TextKind::Text,
                text: t,
                ..
            } => text.push_str(&t),
            WireEvent::TextDelta {
                kind: TextKind::Reasoning,
                text: r,
                ..
            } => thinking.push_str(&r),
            WireEvent::ToolCall(call) if call.id == "toolu_1" => {
                saw_tool = true;
                assert_eq!(call.name, "Read");
            }
            WireEvent::Finish(f) => {
                saw_finish = true;
                assert_eq!(f.reason, Stop::ToolCalls);
                let usage = f.usage.expect("anthropic usage");
                assert_eq!(usage.input, Some(800));
                assert_eq!(usage.cache_read, Some(300));
                assert_eq!(usage.cache_write, Some(200));
                assert_eq!(usage.output, Some(150));
            }
            WireEvent::Error(e) => panic!("unexpected anthropic decode error: {e}"),
            _ => {}
        }
    }
    assert_eq!(thinking, "deep thought");
    assert_eq!(text, "Here is the answer.");
    assert!(saw_tool);
    assert!(saw_finish);

    // Turn 2: Anthropic native compaction block via compaction_delta
    let raw2 = client
        .post(format!("{}/messages", server.base_url()))
        .header("content-type", "application/json")
        .header("anthropic-beta", "compact-2026-09-04")
        .body(
            json!({
                "model": "claude-sonnet-4-5",
                "stream": true,
                "max_tokens": 1024,
                "context_management": { "edits": [{ "type": "compact_20260112" }] },
                "messages": [{ "role": "user", "content": "continue long thread" }],
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();

    let mut dec2 = anthropic::stream::Stream::new(anthropic::response::Options::default());
    let mut evs2 = dec2.push(&raw2, &mut next_id, |_| {}).unwrap();
    evs2.extend(dec2.finish());

    let mut compaction_text = String::new();
    let mut finish2 = None;
    for ev in evs2 {
        match ev {
            WireEvent::TextDelta { text: t, .. } => compaction_text.push_str(&t),
            WireEvent::Finish(f) => finish2 = Some(f),
            WireEvent::Error(e) => panic!("unexpected anthropic compaction error: {e}"),
            _ => {}
        }
    }
    assert_eq!(compaction_text, "Compacted Anthropic summary.");
    let finish2 = finish2.expect("compaction finish");
    assert_eq!(finish2.raw_reason.as_deref(), Some("compaction"));
    assert_eq!(finish2.usage.as_ref().and_then(|u| u.output), Some(45));
}
