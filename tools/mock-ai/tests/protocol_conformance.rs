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
    Citation, CompactionOutput, ControlPlaneConfig, FinishReason, MidStreamErrorSpec,
    MockAiBuilder, NativeToolEvent, ToolCallSpec, TurnEvent, TurnPlan, Usage, WebSearchResult,
};
use maka_provider_protocol::{
    anthropic, chat_completions,
    output::{Event as WireEvent, Stop, TextKind},
    responses,
};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> reqwest::Response {
    json_request(client, url, body).send().await.unwrap()
}

fn json_request(client: &reqwest::Client, url: &str, body: &Value) -> reqwest::RequestBuilder {
    client
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string())
}

async fn json_status(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = request.send().await.unwrap();
    let actual = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(actual, status, "{body}");
    serde_json::from_str(&body).unwrap()
}

fn sse_events(body: &str) -> impl Iterator<Item = Value> + '_ {
    body.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .map(|data| serde_json::from_str(data).unwrap())
}

#[tokio::test]
async fn deleting_a_parent_after_child_stream_start_keeps_the_completed_child_resumable() {
    let mut server = MockAiBuilder::new()
        .strict_benchmark(true)
        .interactive(1)
        .start()
        .await
        .unwrap();
    let origin = server.origin_url();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    json_status(
        json_request(
            &client,
            &format!("{origin}/admin/sessions"),
            &json!({
                "runId": "run", "sessionId": "owner", "logicalLane": "owner",
                "harness": "codex", "scenario": "lineage",
            }),
        ),
        201,
    )
    .await;
    let url = format!("{origin}/s/run/owner/v1/responses");
    let parent = tokio::spawn(json_status(
        json_request(&client, &url, &json!({"input":"first", "store":true})),
        200,
    ));
    server
        .next_turn()
        .await
        .unwrap()
        .send_plan(TurnPlan::text("parent").with_response_id("parent"));
    assert_eq!(parent.await.unwrap()["id"], "parent");

    let child = tokio::spawn(
        json_request(
            &client,
            &url,
            &json!({
                "input":"next", "stream":true, "store":true, "previous_response_id":"parent",
            }),
        )
        .send(),
    );
    let turn = server.next_turn().await.unwrap();
    turn.set_response_id("child");
    assert!(turn.send(TurnEvent::StreamStart).await);
    let mut child = child.await.unwrap().unwrap();
    assert_eq!(child.status(), 200);
    let mut opening = Vec::new();
    while !opening.ends_with(b"\n\n") {
        opening.extend(child.chunk().await.unwrap().unwrap());
    }
    let event = sse_events(std::str::from_utf8(&opening).unwrap())
        .next()
        .unwrap();
    assert_eq!(event["type"], "response.created");
    assert_eq!(event["response"]["id"], "child");

    assert_eq!(
        json_status(client.delete(format!("{url}/parent")), 200).await["deleted"],
        true
    );
    assert!(turn.delta("child reply").await);
    turn.finish().await;
    let stream = child.text().await.unwrap();
    let completed = sse_events(&stream)
        .find(|event| event["type"] == "response.completed")
        .unwrap();
    let saved = json_status(client.get(format!("{url}/child")), 200).await;
    assert_eq!(saved, completed["response"]);

    let resumed = tokio::spawn(json_status(
        json_request(
            &client,
            &url,
            &json!({
                "input":"continue", "previous_response_id":"child",
            }),
        ),
        200,
    ));
    server
        .next_turn()
        .await
        .unwrap()
        .reply_text("resumed child");
    assert_eq!(
        resumed.await.unwrap()["output"][0]["content"][0]["text"],
        "resumed child"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn reset_excludes_faults_from_in_flight_http_and_ws_turns() {
    use std::time::Duration;

    let mut server = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            enable_admin_api: true,
            ..Default::default()
        })
        .interactive(2)
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let response = tokio::spawn(
        json_request(
            &client,
            &format!("{}/responses", server.base_url()),
            &json!({"input": "HTTP", "stream":true}),
        )
        .send(),
    );
    let http = server.next_turn().await.unwrap();
    assert!(http.send(TurnEvent::StreamStart).await);
    let mut response = response.await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.chunk().await.unwrap().is_some());

    let (mut socket, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    socket
        .send(WsMessage::text(
            json!({"type":"response.create", "input":"WS"}).to_string(),
        ))
        .await
        .unwrap();
    let ws = server.next_turn().await.unwrap();
    assert!(ws.send(TurnEvent::StreamStart).await);
    let open = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let event: Value = serde_json::from_str(open.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "response.created");
    assert_eq!(
        json_status(
            client.post(format!("{}/admin/reset", server.origin_url())),
            200
        )
        .await,
        json!({"reset":true})
    );

    http.drop_connection().await;
    ws.mid_stream_error(MidStreamErrorSpec {
        error_type: "server_error".into(),
        code: Some("old_generation_fault".into()),
        message: "injected WS failure".into(),
        retryable: None,
    })
    .await;
    assert!(response.text().await.is_err());
    let failure = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let event: Value = serde_json::from_str(failure.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "response.failed");
    assert_eq!(event["response"]["error"]["code"], "old_generation_fault");
    let metrics = server.metrics();
    assert_eq!(metrics.connection_drops_emitted, 0);
    assert_eq!(metrics.mid_stream_errors_emitted, 0);
    server.shutdown().await;
}

#[tokio::test]
async fn scoped_control_routes_enforce_response_ownership_and_storage() {
    let server = MockAiBuilder::new()
        .strict_benchmark(true)
        .scripted([TurnPlan::text("saved"), TurnPlan::text("transient")])
        .start()
        .await
        .unwrap();
    let origin = server.origin_url();
    let client = reqwest::Client::new();
    for session in ["owner", "other"] {
        json_status(
            json_request(
                &client,
                &format!("{origin}/admin/sessions"),
                &json!({
                    "runId": "run", "sessionId": session, "logicalLane": session,
                    "harness": "codex", "scenario": "control",
                }),
            ),
            201,
        )
        .await;
    }
    let scope = format!("{origin}/s/run/owner");
    for path in ["/admin/health", "/metrics"] {
        let error = json_status(client.get(format!("{scope}{path}")), 403).await;
        assert!(
            error["error"]
                .as_str()
                .unwrap()
                .contains("unavailable under session scope")
        );
    }
    let model = json_status(client.get(format!("{scope}/v1/models/gpt-4.1")), 200).await;
    assert_eq!(model["id"], "gpt-4.1");
    assert_eq!(model["object"], "model");
    assert_eq!(
        json_status(
            json_request(
                &client,
                &format!("{scope}/v1/messages/count_tokens"),
                &json!({
                    "model": "claude-sonnet-4-5", "system": "sys",
                    "messages": [{"role": "user", "content": "hello"}],
                })
            ),
            200
        )
        .await,
        json!({"input_tokens":4})
    );

    let responses = format!("{scope}/v1/responses");
    let saved = json_status(
        json_request(
            &client,
            &responses,
            &json!({
                "model": "gpt-4.1", "input": "first", "store": true,
            }),
        ),
        200,
    )
    .await;
    assert_eq!(saved["output"][0]["content"][0]["text"], "saved");
    let retained =
        json!({"type":"message", "role":"user", "content":[{"type":"input_text","text":"first"}]});
    let compact = json_status(
        json_request(
            &client,
            &format!("{responses}/compact"),
            &json!({
                "model":"gpt-4.1", "previous_response_id":saved["id"], "input":[retained],
            }),
        ),
        200,
    )
    .await;
    assert_eq!(compact["object"], "response.compaction");
    assert_eq!(compact["output"][0], retained);
    let checkpoint = &compact["output"][1];
    assert_eq!(checkpoint["type"], "compaction");
    assert_eq!(
        checkpoint["encrypted_content"],
        format!("mock:{}", checkpoint["id"].as_str().unwrap())
    );

    let transient = json_status(json_request(&client, &responses, &json!({
        "model":"gpt-4.1", "previous_response_id":compact["id"], "input":[checkpoint], "store":false,
    })), 200).await;
    assert_eq!(transient["output"][0]["content"][0]["text"], "transient");
    let id = saved["id"].as_str().unwrap();
    let own_url = format!("{responses}/{id}");
    let foreign_url = format!("{origin}/s/run/other/v1/responses/{id}");
    assert_eq!(
        client
            .get(format!("{responses}/{}", transient["id"].as_str().unwrap()))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(client.get(&foreign_url).send().await.unwrap().status(), 404);
    assert_eq!(
        client.delete(&foreign_url).send().await.unwrap().status(),
        404
    );
    assert_eq!(json_status(client.get(&own_url), 200).await, saved);
    assert_eq!(
        json_status(client.delete(&own_url), 200).await,
        json!({"id":id, "object":"response.deleted", "deleted":true})
    );
    assert_eq!(client.get(&own_url).send().await.unwrap().status(), 404);
    server.shutdown().await;
}

#[tokio::test]
async fn chat_sse_usage_and_reasoning_follow_independent_wire_options() {
    use maka_mock_ai::ProviderDialectProfile::{DeepSeekChat, StandardOpenAi};

    let client = reqwest::Client::new();
    for (dialect, expected_reasoning) in [(StandardOpenAi, ""), (DeepSeekChat, "draft 🦀")] {
        let plan = TurnPlan::new()
            .push_reasoning("draft 🦀")
            .push_text_chunked("answer", 2)
            .with_usage(Usage::new(7, 2))
            .finish(FinishReason::Stop);
        let server = MockAiBuilder::new()
            .provider_dialect(dialect)
            .scripted([plan.clone(), plan])
            .start()
            .await
            .unwrap();
        for include_usage in [true, false] {
            let response = post_json(&client, &format!("{}/chat/completions", server.base_url()), &json!({
                "model":"gpt-4.1", "stream":true, "stream_options":{"include_usage":include_usage},
                "messages":[{"role":"user", "content":"answer this"}],
            })).await.error_for_status().unwrap().text().await.unwrap();
            assert!(response.ends_with("data: [DONE]\n\n"));
            let mut chunks: Vec<_> = sse_events(&response).collect();
            if include_usage {
                let tail = chunks.pop().unwrap();
                assert_eq!(tail["choices"], json!([]));
                assert_eq!(
                    tail["usage"],
                    json!({"prompt_tokens":7,"completion_tokens":2,"total_tokens":9})
                );
            }
            assert_eq!(
                chunks.last().unwrap()["choices"][0]["finish_reason"],
                "stop"
            );
            let mut reasoning = String::new();
            let mut text = String::new();
            for chunk in chunks {
                assert_eq!(chunk.get("usage"), include_usage.then_some(&Value::Null));
                assert_eq!(chunk["choices"].as_array().unwrap().len(), 1);
                let delta = &chunk["choices"][0]["delta"];
                if expected_reasoning.is_empty() {
                    assert!(delta.get("reasoning_content").is_none());
                }
                reasoning.extend(delta["reasoning_content"].as_str());
                text.extend(delta["content"].as_str());
            }
            assert_eq!(reasoning, expected_reasoning);
            assert_eq!(text, "answer");
        }
        server.shutdown().await;
    }
}

#[tokio::test]
async fn responses_text_and_refusal_fold_to_json_and_stored_response() {
    let plan = TurnPlan::new()
        .with_response_id("resp_mixed")
        .push_text_chunked("Visible 🦀", 2)
        .push(TurnEvent::Refusal {
            text: "Cannot share that.".into(),
        })
        .push_text_chunked("Try this.", 3)
        .with_usage(Usage::new(17, 8))
        .finish(FinishReason::Stop);
    let server = MockAiBuilder::new()
        .scripted([plan.clone(), plan])
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/responses", server.base_url());
    let mut request = json!({"model":"gpt-4.1","input":"mixed reply","stream":true,"store":true});
    let body = post_json(&client, &url, &request)
        .await
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    let mut sequence = None;
    let mut parts = Vec::<Value>::new();
    let mut done_indexes = Vec::new();
    let mut folded = None;
    let mut completed = None;
    for event in sse_events(&body) {
        let next = event["sequence_number"].as_u64().unwrap();
        assert!(sequence.is_none_or(|previous| previous < next));
        sequence = Some(next);
        match event["type"].as_str().unwrap() {
            "response.output_item.added" => {
                assert_eq!(event["output_index"], 0);
                assert_eq!(event["item"]["status"], "in_progress");
                assert_eq!(event["item"]["content"], json!([]));
                assert!(folded.replace(event["item"].clone()).is_none());
            }
            "response.content_part.added" => {
                assert_eq!(event["output_index"], 0);
                assert_eq!(event["content_index"], parts.len());
                parts.push(event["part"].clone());
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                assert_eq!(event["output_index"], 0);
                let index = event["content_index"].as_u64().unwrap() as usize;
                let (kind, field) = if event["type"] == "response.output_text.delta" {
                    ("output_text", "text")
                } else {
                    ("refusal", "refusal")
                };
                let part = &mut parts[index];
                assert_eq!(part["type"], kind);
                part[field] = json!(format!(
                    "{}{}",
                    part[field].as_str().unwrap(),
                    event["delta"].as_str().unwrap()
                ));
            }
            "response.content_part.done" => {
                assert_eq!(event["output_index"], 0);
                let index = event["content_index"].as_u64().unwrap() as usize;
                assert_eq!(event["part"], parts[index]);
                done_indexes.push(index);
            }
            "response.output_item.done" => {
                assert_eq!(event["output_index"], 0);
                let item = folded.as_mut().unwrap();
                item["content"] = json!(parts);
                item["status"] = json!("completed");
                assert_eq!(&event["item"], item);
            }
            "response.completed" => assert!(completed.replace(event["response"].clone()).is_none()),
            _ => {}
        }
    }
    assert_eq!(done_indexes, [0, 1, 2]);
    assert_eq!(
        parts,
        [
            json!({"type":"output_text","text":"Visible 🦀","annotations":[]}),
            json!({"type":"refusal","refusal":"Cannot share that."}),
            json!({"type":"output_text","text":"Try this.","annotations":[]}),
        ]
    );
    let completed = completed.unwrap();
    assert_eq!(completed["output"], json!([folded.unwrap()]));
    assert_eq!(completed["usage"]["total_tokens"], 25);
    let stored = json_status(client.get(format!("{url}/resp_mixed")), 200).await;
    assert_eq!(completed, stored);

    request["stream"] = json!(false);
    let mut standalone = json_status(json_request(&client, &url, &request), 200).await;
    // Independent requests can start on different wall-clock seconds.
    assert!(standalone["created_at"].as_u64().is_some());
    standalone["created_at"] = completed["created_at"].clone();
    assert_eq!(completed, standalone);
    server.shutdown().await;
}

#[tokio::test]
async fn anthropic_ping_signed_thinking_and_compaction_survive_stream_and_replay() {
    let server = MockAiBuilder::new()
        .handler_fn(|request, _| {
            if request.last_user_text() == Some("resume") {
                let prior = &request.raw_body["messages"][1]["content"];
                if prior
                    == &json!([
                        {"type":"thinking", "thinking":"check 🦀", "signature":"opaque-signature"},
                        {"type":"compaction", "content":"checkpoint summary"},
                    ])
                {
                    return TurnPlan::text("resumed from checkpoint");
                }
                return TurnPlan::http_error(maka_mock_ai::HttpErrorSpec::new(
                    422,
                    "invalid_request_error",
                    "signed checkpoint was not replayed",
                ));
            }
            TurnPlan::new()
                .push(TurnEvent::Ping)
                .push(TurnEvent::Reasoning {
                    text: "check 🦀".into(),
                    chunk_chars: 2,
                    signature: Some("opaque-signature".into()),
                    encrypted_content: None,
                })
                .push_compaction(
                    CompactionOutput::new("checkpoint summary")
                        .with_pause(request.options.anthropic_pause_after_compaction),
                )
                .push_text("continued in the same response")
                .finish(FinishReason::Stop)
        })
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/messages", server.base_url());
    let mut request = json!({
        "model":"claude-sonnet-4-5", "max_tokens":512, "stream":true,
        "context_management":{"edits":[{"type":"compact_20260112"}]},
        "messages":[{"role":"user","content":"compact history"}],
    });
    for (pause, stop, expected_text) in [
        (true, "compaction", "checkpoint summary"),
        (
            false,
            "end_turn",
            "checkpoint summarycontinued in the same response",
        ),
    ] {
        request["context_management"]["edits"][0]["pause_after_compaction"] = json!(pause);
        let raw = post_json(&client, &url, &request)
            .await
            .error_for_status()
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let wire = std::str::from_utf8(&raw).unwrap();
        assert!(
            wire.split("\n\n")
                .any(|frame| frame == "event: ping\ndata: {\"type\":\"ping\"}")
        );
        let mut decoder = anthropic::stream::Stream::new(anthropic::response::Options::default());
        let mut sequence = 0;
        let mut next_id = || {
            sequence += 1;
            format!("part_{sequence}")
        };
        let mut events = decoder.push(&raw, &mut next_id, |_| {}).unwrap();
        events.extend(decoder.finish());
        let mut thinking = String::new();
        let mut signature = None;
        let mut text = String::new();
        let mut finish = None;
        for event in events {
            match event {
                WireEvent::TextDelta {
                    kind: TextKind::Reasoning,
                    text,
                    extensions,
                    ..
                } => {
                    thinking.push_str(&text);
                    if let Some(extensions) = extensions {
                        let signed = extensions["anthropic"]["signature"].as_str().unwrap();
                        assert!(signature.replace(signed.to_owned()).is_none());
                    }
                }
                WireEvent::TextDelta {
                    kind: TextKind::Text,
                    text: delta,
                    ..
                } => text.push_str(&delta),
                WireEvent::Finish(event) => assert!(finish.replace(event.raw_reason).is_none()),
                WireEvent::Error(error) => panic!("Anthropic decoder rejected the stream: {error}"),
                _ => {}
            }
        }
        assert_eq!(finish.flatten().as_deref(), Some(stop));
        assert_eq!(text, expected_text);
        assert_eq!(thinking, "check 🦀");
        assert_eq!(signature.as_deref(), Some("opaque-signature"));
        if pause {
            let resumed = json_status(
                json_request(
                    &client,
                    &url,
                    &json!({
                        "model":"claude-sonnet-4-5", "max_tokens":512,
                        "messages":[
                            {"role":"user","content":"compact history"},
                            {"role":"assistant","content":[
                                {"type":"thinking","thinking":thinking,"signature":signature},
                                {"type":"compaction","content":text},
                            ]},
                            {"role":"user","content":"resume"},
                        ],
                    }),
                ),
                200,
            )
            .await;
            assert_eq!(resumed["content"][0]["text"], "resumed from checkpoint");
        }
    }
    server.shutdown().await;
}

#[tokio::test]
async fn responses_replays_a_namespaced_mcp_call_until_its_receipt() {
    use maka_mock_ai::scenario::{BenchmarkTrack, CanonicalAction, FixtureDef, ScenarioSpec};

    let spec = ScenarioSpec::new("mcp-read", 17, "note", BenchmarkTrack::SharedMcp)
        .with_fixture(
            "note",
            FixtureDef::File {
                path: "note.txt".into(),
                content: "fixture marker\n".into(),
            },
        )
        .with_step(
            "read",
            CanonicalAction::ReadFile {
                path: "note.txt".into(),
                expect_marker: "fixture marker".into(),
            },
        )
        .with_step(
            "done",
            CanonicalAction::FinalAnswer {
                text: "Read verified.".into(),
                expect_markers: vec!["Read verified.".into()],
            },
        );
    let server = MockAiBuilder::new().scenario(spec).start().await.unwrap();
    let origin = server.origin_url();
    let client = reqwest::Client::new();
    json_status(
        json_request(
            &client,
            &format!("{origin}/admin/sessions"),
            &json!({
                "runId": "run", "sessionId": "lane", "logicalLane": "lane", "harness": "codex",
                "scenario": "mcp-read", "workspace": std::env::current_dir().unwrap(),
            }),
        ),
        201,
    )
    .await;
    let url = format!("{origin}/s/run/lane/v1/responses");
    let read = json!({
        "type": "function", "name": "bench_read_file", "defer_loading": true,
        "parameters": {
            "type": "object", "properties": { "path": { "type": "string" } },
            "required": ["path"], "additionalProperties": false,
        }
    });
    let namespace = |name: &str| json!({"type": "namespace", "name": name, "tools": [read]});
    let user = json!({"role": "user", "content": "Read the note."});
    let mut request = json!({
        "input": [user], "tools": [namespace("mcp__bench")], "stream": true, "store": true,
    });
    let sse = post_json(&client, &url, &request)
        .await
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    let events: Vec<_> = sse_events(&sse).collect();
    let event = |kind| events.iter().find(|event| event["type"] == kind).unwrap();
    let completed = &event("response.completed")["response"];
    let done = &event("response.output_item.done")["item"];
    assert_eq!(completed["output"], json!([done]));
    assert_eq!(done["type"], "function_call");
    assert_eq!(done["name"], "bench_read_file");
    assert_eq!(done["namespace"], "mcp__bench");
    assert_eq!(done["arguments"], r#"{"path":"note.txt"}"#);
    let mut added = done.clone();
    added["status"] = json!("in_progress");
    added["arguments"] = json!("");
    assert_eq!(event("response.output_item.added")["item"], added);
    let id = completed["id"].as_str().unwrap();
    let stored = json_status(client.get(format!("{url}/{id}")), 200).await;
    assert_eq!(stored["output"], completed["output"]);

    request["stream"] = json!(false);
    request["tools"] = json!([namespace("other"), read]);
    let rejected = json_status(json_request(&client, &url, &request), 422).await;
    assert_eq!(
        rejected["error"]["message"],
        r#"unsupported bench_read_file: ["replay requires one matching tool declaration"]"#
    );
    request["tools"]
        .as_array_mut()
        .unwrap()
        .push(namespace("mcp__bench"));
    let replay = json_status(json_request(&client, &url, &request), 200).await;
    assert_eq!(replay["id"], id);
    assert_eq!(replay["output"], completed["output"]);

    request["input"] = json!([
        user, done, {
            "type": "function_call_output", "call_id": done["call_id"], "output": "fixture marker\n",
        }
    ]);
    let next = json_status(json_request(&client, &url, &request), 200).await;
    assert_ne!(next["id"], id);
    assert_eq!(next["output"][0]["content"][0]["text"], "Read verified.");
    server.shutdown().await;
}

#[tokio::test]
async fn harness_titles_take_the_side_path_and_user_title_requests_complete_the_scenario() {
    use maka_mock_ai::scenario::{
        BenchmarkTrack, CanonicalAction, FaultKind, ScenarioSpec, ScheduledFault,
    };

    let spec = ScenarioSpec::new("user-title", 7, "article", BenchmarkTrack::Native)
        .with_step(
            "answer",
            CanonicalAction::FinalAnswer {
                text: "潮汐之后".into(),
                expect_markers: vec!["潮汐之后".into()],
            },
        )
        .with_fault(ScheduledFault {
            step: "answer".into(),
            attempt: 1,
            at: Default::default(),
            emit: FaultKind::Http429,
        });
    let server = MockAiBuilder::new().scenario(spec).start().await.unwrap();
    let origin = server.origin_url();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    for harness in ["opencode", "claude-code"] {
        json_status(
            json_request(
                &client,
                &format!("{origin}/admin/sessions"),
                &json!({
                    "runId":"run","sessionId":harness,"logicalLane":harness,"harness":harness,
                    "scenario":"user-title","workspace":std::env::current_dir().unwrap(),
                }),
            ),
            201,
        )
        .await;
        let (path, system, side_text, text_pointer) = if harness == "opencode" {
            (
                "chat/completions",
                "You are a title generator. You output ONLY a thread title.",
                "Benchmark task",
                "/choices/0/message/content",
            )
        } else {
            (
                "messages",
                "Generate a concise, sentence-case title (3-7 words). Return JSON with a single \"title\" field.",
                r#"{"title":"Benchmark task"}"#,
                "/content/0/text",
            )
        };
        let url = format!("{origin}/s/run/{harness}/v1/{path}");
        let user = json!({"role":"user","content":"帮这篇文章起个标题"});
        let main = json!({"model":"mock-model","max_tokens":256,"messages":[user]});
        let mut side = main.clone();
        if harness == "opencode" {
            side["messages"]
                .as_array_mut()
                .unwrap()
                .insert(0, json!({"role":"system","content":system}));
        } else {
            side["system"] = json!(system);
        }
        let title = json_status(json_request(&client, &url, &side), 200).await;
        assert_eq!(title.pointer(text_pointer).unwrap(), side_text);
        let rejected = json_status(json_request(&client, &url, &main), 429).await;
        assert_eq!(rejected["error"]["type"], "rate_limit_error");
        let answer = json_status(json_request(&client, &url, &main), 200).await;
        assert_eq!(answer.pointer(text_pointer).unwrap(), "潮汐之后");
        let detail = format!("{origin}/admin/sessions/{harness}");
        let summary = json_status(
            json_request(
                &client,
                &format!("{detail}/finalize"),
                &json!({
                    "responseId":answer["id"], "observedMarkers":["潮汐之后"],
                }),
            ),
            200,
        )
        .await;
        assert_eq!(summary["finalized"], true);
        let timeline = json_status(client.get(&detail), 200).await;
        let purposes: Vec<_> = timeline["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["purpose"].as_str().unwrap())
            .collect();
        assert_eq!(purposes, ["title", "main", "main"]);
    }
    server.shutdown().await;
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
