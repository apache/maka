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

#[tokio::test]
async fn interactive_non_streaming_meta_filtered_and_ws_stall_disconnect() {
    use maka_mock_ai::{CustomResponse, HttpErrorSpec};
    use std::sync::Arc;
    use std::time::Duration;

    // 1) Filtered interactive mode + custom_route overriding /v1/models + control_plane_requests
    let mut server = MockAiBuilder::new()
        .custom_route(Arc::new(|method, path, headers, _body| {
            if method == "GET" && path == "/v1/custom" {
                Some(CustomResponse::text(200, "custom-body").with_header(
                    "x-custom-tag",
                    headers.get("x-in").cloned().unwrap_or_default(),
                ))
            } else {
                None
            }
        }))
        .interactive_filtered(8, |req, _| {
            if req.last_user_text() == Some("warmup") {
                Some(TurnPlan::text("auto-warmup"))
            } else {
                None
            }
        })
        .start()
        .await
        .unwrap();

    let client = reqwest::Client::new();

    // Control plane request recording (GET /v1/models with custom header)
    let models_resp = client
        .get(format!("{}/models", server.base_url()))
        .header("x-magpie-drawers", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(models_resp.status(), 200);
    let custom_resp = client
        .get(format!("{}/custom", server.base_url()))
        .header("x-in", "ok")
        .send()
        .await
        .unwrap();
    assert_eq!(custom_resp.status(), 200);
    assert_eq!(custom_resp.headers()["x-custom-tag"], "ok");
    assert_eq!(custom_resp.text().await.unwrap(), "custom-body");
    let cp = server.control_plane_requests();
    assert_eq!(cp.len(), 2);
    assert_eq!(
        cp[0].headers.get("x-magpie-drawers").map(String::as_str),
        Some("1")
    );

    // Filtered auxiliary turn is handled automatically without entering interactive queue
    let warmup = post_json(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &json!({ "model": "gpt-4.1", "stream": false, "messages": [{ "role": "user", "content": "warmup" }] }),
    )
    .await;
    assert_eq!(warmup.status(), 200);
    assert!(warmup.text().await.unwrap().contains("auto-warmup"));

    // Interactive non-streaming JSON + full TurnPlan metadata via send_plan (response_id, headers, on_close)
    let non_stream_req = tokio::spawn({
        let client = client.clone();
        let url = format!("{}/chat/completions", server.base_url());
        async move {
            post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": false, "messages": [{ "role": "user", "content": "json-turn" }] }),
            )
            .await
        }
    });
    let h = server.next_turn().await.unwrap();
    let plan_closed = tokio_util::sync::CancellationToken::new();
    h.send_plan(
        TurnPlan::text("json-ok")
            .with_response_id("custom-id-1")
            .with_header("x-mock-turn", "yes")
            .with_on_close(plan_closed.clone()),
    );
    let r = non_stream_req.await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["x-mock-turn"], "yes");
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(body["id"], "custom-id-1");
    assert_eq!(body["choices"][0]["message"]["content"], "json-ok");
    tokio::time::timeout(Duration::from_secs(2), plan_closed.cancelled())
        .await
        .expect("send_plan must preserve plan.on_close signal");

    // send_plan preserves leading Delay + plain-text HTTP error semantics identically to TurnDecision::Plan
    let err_req = tokio::spawn({
        let client = client.clone();
        let url = format!("{}/chat/completions", server.base_url());
        async move {
            post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "plain-err" }] }),
            )
            .await
        }
    });
    let h_err = server.next_turn().await.unwrap();
    let err_closed = tokio_util::sync::CancellationToken::new();
    h_err.send_plan(
        TurnPlan::new()
            .with_delay(Duration::from_millis(5))
            .push(TurnEvent::HttpError(HttpErrorSpec::plain(
                429,
                "unknown INCLUDE_USAGE",
            )))
            .with_on_close(err_closed.clone()),
    );
    let r_err = err_req.await.unwrap();
    assert_eq!(r_err.status(), 429);
    assert_eq!(r_err.headers()["content-type"], "text/plain");
    assert_eq!(r_err.text().await.unwrap(), "unknown INCLUDE_USAGE");
    tokio::time::timeout(Duration::from_secs(2), err_closed.cancelled())
        .await
        .expect("send_plan error must still fire plan.on_close");

    // Interactive WebSocket: Stall unblocks on next event, and client close wakes wait_closed()
    let (mut ws, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    ws.send(WsMessage::text(
        json!({ "type": "response.create", "model": "gpt-4.1", "store": false, "input": "ws-stall" }).to_string(),
    ))
    .await
    .unwrap();
    let h_ws = server.next_turn().await.unwrap();
    assert!(h_ws.send(TurnEvent::StreamStart).await);
    assert!(h_ws.reasoning_encrypted("thought", "enc-1").await);
    assert!(h_ws.flush_item().await);
    h_ws.stall().await;

    // Drain response.created and reasoning output_item.done BEFORE unstalling (bounded by timeout).
    let mut saw_created = false;
    let mut saw_reasoning_done = false;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !saw_reasoning_done {
            let Some(Ok(WsMessage::Text(txt))) = ws.next().await else {
                panic!("unexpected ws eof before reasoning done");
            };
            let v: Value = serde_json::from_str(&txt).unwrap();
            if v["type"] == "response.created" {
                saw_created = true;
            }
            if v["type"] == "response.output_item.done"
                && v["item"]["type"] == "reasoning"
                && v["item"]["encrypted_content"] == "enc-1"
            {
                saw_reasoning_done = true;
            }
        }
    })
    .await
    .expect("timed out waiting for pre-stall reasoning done");
    assert!(saw_created);
    assert!(saw_reasoning_done);

    // Unstall interactive WS by sending a new event + finish, verifying delta arrives BEFORE completed!
    assert!(h_ws.delta("resumed").await);
    h_ws.finish().await;
    let mut saw_resumed_delta = false;
    let mut saw_completed = false;
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
            let v: Value = serde_json::from_str(&txt).unwrap();
            if v["type"] == "response.output_text.delta" && v["delta"] == "resumed" {
                assert!(!saw_completed, "delta arrived after completion");
                saw_resumed_delta = true;
            }
            if v["type"] == "response.completed" {
                saw_completed = true;
                break;
            }
        }
    })
    .await
    .expect("timed out waiting for resumed WS delta and completion");
    assert!(saw_resumed_delta, "resumed text delta missing");
    assert!(saw_completed);

    // Turn 2 on same WS: send_plan(TurnPlan::stall()) consumes TurnHandle, yet must keep stalling until client closes!
    ws.send(WsMessage::text(
        json!({ "type": "response.create", "model": "gpt-4.1", "store": false, "input": "ws-send-plan-stall" }).to_string(),
    ))
    .await
    .unwrap();
    let h_plan_stall = server.next_turn().await.unwrap();
    let closed_sig = h_plan_stall.closed_signal();
    h_plan_stall.send_plan(TurnPlan::stall());
    assert!(
        tokio::time::timeout(Duration::from_millis(80), ws.next())
            .await
            .is_err(),
        "send_plan(TurnPlan::stall()) must keep WS open after TurnHandle is dropped"
    );
    drop(ws);
    tokio::time::timeout(Duration::from_secs(2), closed_sig.cancelled())
        .await
        .expect("WS client disconnect must wake send_plan(TurnPlan::stall()) close signal");

    // HTTP client disconnect BEFORE first reply must wake TurnHandle::wait_closed() via RAII guard!
    let dropped_http = tokio::spawn({
        let client = client.clone();
        let url = format!("{}/chat/completions", server.base_url());
        async move {
            let _ = post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "http-drop-before-reply" }] }),
            )
            .await;
        }
    });
    let h_http_drop = server.next_turn().await.unwrap();
    dropped_http.abort();
    let _ = dropped_http.await;
    tokio::time::timeout(Duration::from_secs(2), h_http_drop.wait_closed())
        .await
        .expect("HTTP client disconnect before first reply must wake TurnHandle::wait_closed()");

    // Turn 3 on a new WS: client closes while TurnHandle is idle -> wait_closed() must wake promptly!
    let (mut ws2, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    ws2.send(WsMessage::text(
        json!({ "type": "response.create", "model": "gpt-4.1", "store": false, "input": "ws-close" }).to_string(),
    ))
    .await
    .unwrap();
    let h_close = server.next_turn().await.unwrap();
    drop(ws2);
    tokio::time::timeout(Duration::from_secs(2), h_close.wait_closed())
        .await
        .expect("WS client disconnect must wake TurnHandle::wait_closed()");

    // Queued send_plan(stall().with_on_close(sig)) immediately followed by shutdown() must
    // fire BOTH handle.closed_signal() and plan.on_close even if recv() never dequeues the plan!
    let http_shutdown_req = tokio::spawn({
        let client = client.clone();
        let url = format!("{}/chat/completions", server.base_url());
        async move {
            let _ = post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "http-queued-shutdown" }] }),
            )
            .await;
        }
    });
    let h_http_shutdown = server.next_turn().await.unwrap();
    let http_handle_sig = h_http_shutdown.closed_signal();
    let http_plan_sig = tokio_util::sync::CancellationToken::new();

    let (mut ws3, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    ws3.send(WsMessage::text(
        json!({ "type": "response.create", "model": "gpt-4.1", "store": false, "input": "ws-shutdown" }).to_string(),
    ))
    .await
    .unwrap();
    let h_ws_shutdown = server.next_turn().await.unwrap();
    let ws_handle_sig = h_ws_shutdown.closed_signal();
    let ws_plan_sig = tokio_util::sync::CancellationToken::new();

    h_http_shutdown.send_plan(TurnPlan::stall().with_on_close(http_plan_sig.clone()));
    h_ws_shutdown.send_plan(TurnPlan::stall().with_on_close(ws_plan_sig.clone()));
    server.shutdown().await;

    for (label, sig) in [
        ("http handle", http_handle_sig),
        ("http plan.on_close", http_plan_sig),
        ("ws handle", ws_handle_sig),
        ("ws plan.on_close", ws_plan_sig),
    ] {
        tokio::time::timeout(Duration::from_secs(2), sig.cancelled())
            .await
            .unwrap_or_else(|_| panic!("shutdown() must trigger {label} close signal"));
    }
    http_shutdown_req.abort();
    let _ = http_shutdown_req.await;
    drop(ws3);
}

#[tokio::test]
async fn handler_panics_are_captured_and_surfaced() {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    let server = MockAiBuilder::new()
        .handler_fn(|_, _| {
            panic!("expected test assertion failure");
        })
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let _ = client
        .post(format!("{}/chat/completions", server.base_url()))
        .header("content-type", "application/json")
        .body(json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "boom" }] }).to_string())
        .send()
        .await;
    // Verify the actual shutdown() propagation path relied on by integration harnesses.
    let err = AssertUnwindSafe(server.shutdown())
        .catch_unwind()
        .await
        .expect_err("shutdown() must propagate handler panics");
    let msg = err
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| err.downcast_ref::<&str>().copied())
        .unwrap_or("<non-string panic>");
    assert!(
        msg.contains("expected test assertion failure"),
        "unexpected shutdown panic message: {msg}"
    );
}

#[tokio::test]
async fn intermediate_web_search_started_sse_comment_and_ring_control_budget() {
    let plan = TurnPlan::new()
        .push_sse_comment("pending")
        .push(TurnEvent::NativeTool(NativeToolEvent::WebSearchStarted {
            id: "ws_1".into(),
            query: "rust".into(),
        }))
        .push(TurnEvent::TruncateEof);
    let server = MockAiBuilder::new()
        .recorder(maka_mock_ai::RecorderMode::Ring {
            capacity: 1,
            max_bytes: 180,
        })
        .scripted([plan])
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::new();

    let resp = post_json(
        &client,
        &format!("{}/responses", server.base_url()),
        &json!({ "model": "gpt-5", "stream": true, "input": "search" }),
    )
    .await;
    assert_eq!(server.recorded_requests().len(), 1);

    // Oversized control request header must be rejected without evicting existing model history.
    let models_resp = client
        .get(format!("{}/models", server.base_url()))
        .header("x-oversized", "a".repeat(350))
        .send()
        .await
        .unwrap();
    assert_eq!(models_resp.status(), 200);
    assert!(
        server.control_plane_requests().is_empty(),
        "Ring max_bytes must also bound control-plane request entries"
    );
    assert_eq!(
        server.recorded_requests().len(),
        1,
        "an oversized entry that cannot fit must not evict existing ring entries"
    );
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(body.starts_with(": pending\n\n"), "{body}");

    let events: Vec<Value> = body
        .split("\n\n")
        .filter_map(|frame| {
            frame
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .and_then(|json| serde_json::from_str::<Value>(json).ok())
        })
        .collect();
    let search_added = events
        .iter()
        .find(|ev| ev["type"] == "response.output_item.added")
        .unwrap_or_else(|| panic!("missing response.output_item.added in {events:?}"));
    assert_eq!(search_added["item"]["type"], "web_search_call");
    assert_eq!(search_added["item"]["id"], "ws_1");
    assert_eq!(search_added["item"]["status"], "in_progress");
    assert!(
        !events
            .iter()
            .any(|ev| ev["type"] == "response.output_item.done"
                || ev["type"] == "response.completed"),
        "truncated stream must not emit completion events: {events:?}"
    );
    server.shutdown().await;
}
