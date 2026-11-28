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

use futures_util::{SinkExt, StreamExt};
use maka_mock_ai::{
    AuthPolicy, ControlPlaneConfig, FinishReason, HttpErrorSpec, MockAiBuilder, MockServerConfig,
    ModelEntry, RecorderMode, ServerTuning, TurnPlan, WorkloadConfig, builder_from_config,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::Duration;
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

async fn read_json(resp: reqwest::Response) -> Value {
    let bytes = resp.bytes().await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[derive(Clone, Copy)]
enum LaneWire {
    Responses,
    Messages,
    Chat,
}

impl LaneWire {
    fn path(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Messages => "messages",
            Self::Chat => "chat/completions",
        }
    }

    fn function(self, name: &str, required: &[&str]) -> Value {
        let properties: serde_json::Map<_, _> = required
            .iter()
            .map(|&key| (key.to_owned(), json!({"type":"string"})))
            .collect();
        let schema = json!({
            "type":"object", "properties":properties, "required":required,
            "additionalProperties":false,
        });
        match self {
            Self::Responses => json!({"type":"function","name":name,"parameters":schema}),
            Self::Messages => json!({"name":name,"input_schema":schema}),
            Self::Chat => json!({"type":"function","function":{"name":name,"parameters":schema}}),
        }
    }

    fn tool_call(self, reply: &Value) -> (&Value, &Value, Value) {
        match self {
            Self::Responses => {
                let item = &reply["output"][0];
                let args = if item["type"] == "custom_tool_call" {
                    item["input"].clone()
                } else {
                    assert_eq!(item["type"], "function_call");
                    serde_json::from_str(item["arguments"].as_str().unwrap()).unwrap()
                };
                assert_eq!(reply["output"].as_array().unwrap().len(), 1);
                (&item["call_id"], &item["name"], args)
            }
            Self::Messages => {
                let blocks = reply["content"].as_array().unwrap();
                assert_eq!(blocks.len(), 1);
                let item = &blocks[0];
                assert_eq!(item["type"], "tool_use");
                (&item["id"], &item["name"], item["input"].clone())
            }
            Self::Chat => {
                let calls = reply["choices"][0]["message"]["tool_calls"]
                    .as_array()
                    .unwrap();
                assert_eq!(calls.len(), 1);
                let item = &calls[0];
                assert_eq!(item["type"], "function");
                (
                    &item["id"],
                    &item["function"]["name"],
                    serde_json::from_str(item["function"]["arguments"].as_str().unwrap()).unwrap(),
                )
            }
        }
    }

    fn acknowledge(self, request: &mut Value, reply: &Value, id: &Value, output: &str) {
        match self {
            Self::Responses => {
                let kind = if reply["output"][0]["type"] == "custom_tool_call" {
                    "custom_tool_call_output"
                } else {
                    "function_call_output"
                };
                request["previous_response_id"] = reply["id"].clone();
                request["input"] = json!([{"type":kind,"call_id":id,"output":output}]);
            }
            Self::Messages => request["messages"].as_array_mut().unwrap().extend([
                json!({"role":"assistant","content":reply["content"]}),
                json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":output}]}),
            ]),
            Self::Chat => request["messages"].as_array_mut().unwrap().extend([
                reply["choices"][0]["message"].clone(),
                json!({"role":"tool","tool_call_id":id,"content":output}),
            ]),
        }
    }

    fn text(self, reply: &Value) -> &Value {
        match self {
            Self::Responses => &reply["output"][0]["content"][0]["text"],
            Self::Messages => &reply["content"][0]["text"],
            Self::Chat => &reply["choices"][0]["message"]["content"],
        }
    }
}

#[derive(Clone, Copy)]
enum LaneHarness {
    Maka,
    Claude,
    Codex,
    Dim,
    Kimi,
    Shared,
}

impl LaneHarness {
    fn fixture(self) -> (&'static str, LaneWire, [&'static str; 3], Vec<Value>) {
        use LaneWire::{Chat, Messages, Responses};
        let patch = |name, grammar| {
            json!({"type":"custom","name":name,"format":{
                "type":"grammar","syntax":"lark","definition":grammar,
            }})
        };
        let (harness, wire, names, params): (_, _, _, [&[&str]; 3]) = match self {
            Self::Maka => {
                let exec = patch(
                    "exec",
                    r"start: pragma_source | plain_source
plain_source: SOURCE
PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
SOURCE: /[\s\S]+/",
                );
                return ("maka", Responses, ["exec"; 3], vec![exec]);
            }
            Self::Codex => {
                let apply_patch = patch(
                    "apply_patch",
                    "start: \"*** Begin Patch\" hunk \"*** End Patch\"",
                );
                return (
                    "codex",
                    Responses,
                    ["exec_command", "apply_patch", "exec_command"],
                    vec![Responses.function("exec_command", &["cmd"]), apply_patch],
                );
            }
            Self::Claude => (
                "claude-code",
                Messages,
                ["Read", "Edit", "Bash"],
                [
                    &["file_path"],
                    &["file_path", "old_string", "new_string"],
                    &["command", "description"],
                ],
            ),
            Self::Dim => (
                "dim",
                Chat,
                ["read", "edit", "exec"],
                [&["path"], &["path", "oldText", "newText"], &["command"]],
            ),
            Self::Kimi => (
                "kimi",
                Chat,
                ["Read", "Edit", "Shell"],
                [
                    &["path"],
                    &["path", "old_string", "new_string"],
                    &["command"],
                ],
            ),
            Self::Shared => (
                "shared-mcp",
                Responses,
                [
                    "mcp__bench__read_file",
                    "mcp__bench__edit_file",
                    "mcp__bench__exec_shell",
                ],
                [
                    &["path"],
                    &["path", "old_string", "new_string"],
                    &["command"],
                ],
            ),
        };
        let tools = names
            .into_iter()
            .zip(params)
            .map(|(name, required)| wire.function(name, required))
            .collect();
        (harness, wire, names, tools)
    }

    fn check_args(self, round: usize, args: &Value, workspace: &std::path::Path) {
        let expected = match (self, round) {
            (Self::Maka, _) => {
                let (tool, ref expected) = [
                    ("Read", json!({"path":"fixture.txt"})),
                    (
                        "Edit",
                        json!({"path":"fixture.txt","old_string":"marker","new_string":"changed"}),
                    ),
                    (
                        "Shell",
                        json!({"command":"printf checked","title":"verify"}),
                    ),
                ][round];
                let source = args.as_str().unwrap();
                let (_, input) = source.split_once(&format!("tools.{tool}(")).unwrap();
                let (input, _) = input.split_once(')').unwrap();
                assert_eq!(&serde_json::from_str::<Value>(input).unwrap(), expected);
                return;
            }
            (Self::Codex, 0) => json!({"cmd":"cat -- 'fixture.txt'"}),
            (Self::Codex, 1) => json!(
                "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-marker\n+changed\n*** End Patch"
            ),
            (Self::Codex, 2) => json!({"cmd":"printf checked"}),
            (Self::Claude, 0) => json!({"file_path":workspace.join("fixture.txt")}),
            (Self::Claude, 1) => {
                json!({"file_path":workspace.join("fixture.txt"),"old_string":"marker","new_string":"changed"})
            }
            (Self::Claude, 2) => json!({"command":"printf checked","description":"verify"}),
            (Self::Dim, 1) => {
                json!({"path":"fixture.txt","oldText":"marker","newText":"changed"})
            }
            (_, 0) => json!({"path":"fixture.txt"}),
            (_, 1) => json!({"path":"fixture.txt","old_string":"marker","new_string":"changed"}),
            (_, 2) => json!({"command":"printf checked"}),
            _ => unreachable!("three tool rounds"),
        };
        assert_eq!(*args, expected);
    }
}

async fn checked_json(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = request.send().await.unwrap();
    let actual = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(actual, status, "{body}");
    serde_json::from_str(&body).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sixty_four_scoped_lanes_finish_equal_tool_chains_with_bounded_recording() {
    use maka_mock_ai::WatchdogConfig;
    use maka_mock_ai::scenario::{BenchmarkTrack, CanonicalAction, FixtureDef, ScenarioSpec};
    use std::sync::Arc;
    use tokio::sync::Barrier;

    const LANES: usize = 64;
    const RING_ENTRIES: usize = 8;
    const ENTRY_LIMIT_BYTES: usize = 128 * 1024;
    const BYTE_LIMIT_BYTES: usize = 16 * 1024;
    const LONG_OUTPUT_BYTES: usize = 10 * 1024;
    let scenario = |track| {
        ScenarioSpec::new("tool-chain", 17, "fixture", track)
            .with_fixture(
                "file",
                FixtureDef::File {
                    path: "fixture.txt".into(),
                    content: "marker\n".into(),
                },
            )
            .with_fixture(
                "verify",
                FixtureDef::Command {
                    command: "printf checked".into(),
                },
            )
            .with_step(
                "read",
                CanonicalAction::ReadFile {
                    path: "fixture.txt".into(),
                    expect_marker: "marker".into(),
                },
            )
            .with_step(
                "edit",
                CanonicalAction::EditFile {
                    path: "fixture.txt".into(),
                    old: "marker".into(),
                    new: "changed".into(),
                },
            )
            .with_step(
                "verify",
                CanonicalAction::Shell {
                    command_id: "verify".into(),
                    command: "printf checked".into(),
                },
            )
            .with_step(
                "finish",
                CanonicalAction::FinalAnswer {
                    text: "Fixture verified.".into(),
                    expect_markers: vec!["Fixture verified.".into()],
                },
            )
    };
    let start = |track, max_bytes| {
        MockAiBuilder::new()
            .scenario(scenario(track))
            .recorder(RecorderMode::Ring {
                capacity: RING_ENTRIES,
                max_bytes,
            })
            .watchdog(WatchdogConfig {
                check_missing_tool_results: true,
                ..Default::default()
            })
            .start()
    };
    let native = start(BenchmarkTrack::Native, ENTRY_LIMIT_BYTES)
        .await
        .unwrap();
    let shared = start(BenchmarkTrack::SharedMcp, BYTE_LIMIT_BYTES)
        .await
        .unwrap();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let workspace = std::env::current_dir().unwrap();
    let launch = Arc::new(Barrier::new(LANES));
    let mut tasks = tokio::task::JoinSet::new();
    let harnesses = [
        LaneHarness::Maka,
        LaneHarness::Claude,
        LaneHarness::Codex,
        LaneHarness::Dim,
        LaneHarness::Kimi,
        LaneHarness::Shared,
    ];
    for lane in 0..LANES {
        let harness = harnesses[lane % harnesses.len()];
        let origin = if matches!(harness, LaneHarness::Shared) {
            shared.origin_url()
        } else {
            native.origin_url()
        };
        let session = format!("lane-{lane:02}");
        let (name, wire, names, tools) = harness.fixture();
        checked_json(
            json_request(
                &client,
                &format!("{origin}/admin/sessions"),
                &json!({
                    "runId":"stress","sessionId":session,"logicalLane":session,"harness":name,
                    "scenario":"tool-chain","workspace":workspace,
                }),
            ),
            201,
        )
        .await;
        let (client, workspace, launch) = (client.clone(), workspace.clone(), launch.clone());
        tasks.spawn(async move {
            let url = format!("{origin}/s/stress/{session}/v1/{}", wire.path());
            let first = "Read, edit and verify the fixture.";
            let mut request = match wire {
                LaneWire::Responses => json!({"model":"mock-model","input":first,"tools":tools}),
                _ => json!({"model":"mock-model","max_tokens":512,
                    "messages":[{"role":"user","content":first}],"tools":tools}),
            };
            let mut side = request.clone();
            side.as_object_mut().unwrap().remove("tools");
            launch.wait().await;
            let (mut reply, title) = tokio::join!(
                checked_json(json_request(&client, &url, &request), 200),
                checked_json(
                    json_request(&client, &url, &side).header("x-maka-bench-request-use", "title"),
                    200
                ),
            );
            let expected = if matches!(wire, LaneWire::Messages) {
                r#"{"title":"Benchmark task"}"#
            } else {
                "Benchmark task"
            };
            assert_eq!(wire.text(&title), expected);
            let mut call_ids = Vec::new();
            let mut response_ids = Vec::new();
            let shell_output = format!("checked\n{}", "x".repeat(LONG_OUTPUT_BYTES));
            for (round, (name, output)) in names
                .into_iter()
                .zip(["marker\n", "edited", &shell_output])
                .enumerate()
            {
                response_ids.push(reply["id"].as_str().unwrap().to_owned());
                let (id, actual, args) = wire.tool_call(&reply);
                assert_eq!(actual, name, "{session} round {round}");
                harness.check_args(round, &args, &workspace);
                call_ids.push(id.as_str().unwrap().to_owned());
                let code_output;
                let output = if matches!(harness, LaneHarness::Maka) {
                    code_output = json!([{"slot":0,"result":output}]).to_string();
                    &code_output
                } else {
                    output
                };
                wire.acknowledge(&mut request, &reply, id, output);
                reply = checked_json(json_request(&client, &url, &request), 200).await;
            }
            assert_eq!(wire.text(&reply), "Fixture verified.");
            response_ids.push(reply["id"].as_str().unwrap().to_owned());
            let summary = checked_json(
                json_request(
                    &client,
                    &format!("{origin}/admin/sessions/{session}/finalize"),
                    &json!({
                        "responseId":reply["id"],"observedMarkers":["Fixture verified."],
                    }),
                ),
                200,
            )
            .await;
            assert_eq!(summary["sessionId"], session);
            assert_eq!(summary["attempts"], 5);
            (session, call_ids, response_ids)
        });
    }
    let mut completed = HashSet::new();
    let mut calls = HashSet::new();
    let mut responses = HashSet::new();
    while let Some(task) = tasks.join_next().await {
        let (session, call_ids, response_ids) = task.unwrap();
        for id in call_ids {
            assert!(calls.insert(id.clone()), "call ID collision: {id}");
        }
        for id in response_ids {
            assert!(responses.insert(id.clone()), "response ID collision: {id}");
        }
        assert!(completed.insert(session));
    }
    assert_eq!(
        (completed.len(), calls.len(), responses.len()),
        (LANES, LANES * 3, LANES * 4)
    );

    let mut exported = HashSet::new();
    let mut attempts = 0;
    for (server, max_bytes) in [(native, ENTRY_LIMIT_BYTES), (shared, BYTE_LIMIT_BYTES)] {
        let origin = server.origin_url();
        let mut cursor = 0;
        loop {
            let page = checked_json(
                client.get(format!(
                    "{origin}/admin/sessions?run=stress&limit=7&cursor={cursor}"
                )),
                200,
            )
            .await;
            let items = page["items"].as_array().unwrap();
            assert!(!items.is_empty() && items.len() <= 7);
            for item in items {
                let next = item["cursor"].as_u64().unwrap();
                assert!(cursor < next);
                cursor = next;
                assert!(exported.insert(item["sessionId"].as_str().unwrap().to_owned()));
                assert_eq!(item["finalized"], true);
                assert_eq!(item["attempts"], 5);
                assert_eq!(item["retained"], 5);
                assert_eq!(item["dropped"], 0);
                attempts += item["attempts"].as_u64().unwrap();
            }
            if page["nextCursor"].is_null() {
                break;
            }
            assert_eq!(page["nextCursor"], cursor);
        }
        let watchdog = checked_json(client.get(format!("{origin}/admin/violations")), 200).await;
        assert_eq!(watchdog["totalViolations"], 0, "{watchdog}");
        let history = checked_json(client.get(format!("{origin}/admin/requests")), 200).await;
        let entries = history.as_array().unwrap();
        let retained_bytes = entries
            .iter()
            .map(|entry| {
                entry["rawBody"]
                    .to_string()
                    .len()
                    .max(entry["promptBytes"].as_u64().unwrap() as usize)
            })
            .collect::<Vec<_>>();
        assert!(
            retained_bytes.iter().sum::<usize>() <= max_bytes,
            "{retained_bytes:?}"
        );
        if max_bytes == ENTRY_LIMIT_BYTES {
            assert_eq!(entries.len(), RING_ENTRIES);
        } else {
            assert!(entries.len() < RING_ENTRIES, "{retained_bytes:?}");
            assert_eq!(
                retained_bytes
                    .iter()
                    .filter(|&&bytes| bytes >= LONG_OUTPUT_BYTES)
                    .count(),
                1
            );
        }
        server.shutdown().await;
    }
    assert_eq!(exported, completed);
    assert_eq!(attempts, LANES as u64 * 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn high_concurrency_deterministic_workload_with_metrics_only() {
    let config = WorkloadConfig::stress_preset(1337);
    let server = MockAiBuilder::new()
        .workload(config)
        .recorder(RecorderMode::MetricsOnly)
        .start()
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let base = server.base_url();
    let ws_url = server.responses_ws_url();

    // 120 concurrent HTTP sessions x 3 turns + 40 concurrent WS sessions x 3 turns = 480 turns.
    // Limit simultaneous initial TCP SYN bursts to 64 so macOS's default kern.ipc.somaxconn=128
    // does not RST handshakes before the accept loop drains them.
    let connect_gate = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..120usize {
        let client = client.clone();
        let base = base.clone();
        let gate = connect_gate.clone();
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await.unwrap();
            let sid = format!("http-session-{i}");
            let (endpoint, body_fn): (&str, fn(&str, usize) -> Value) = match i % 3 {
                0 => ("/chat/completions", |s, t| {
                    json!({
                        "model": "gpt-4.1",
                        "stream": true,
                        "messages": [{ "role": "user", "content": format!("{s} turn {t}") }],
                        "tools": [{ "type": "function", "function": { "name": "exec", "parameters": {} } }],
                    })
                }),
                1 => ("/responses", |s, t| {
                    json!({
                        "model": "gpt-4.1",
                        "stream": true,
                        "input": [{ "role": "user", "content": [{ "type": "input_text", "text": format!("{s} turn {t}") }] }],
                        "tools": [{ "type": "function", "name": "Read" }],
                    })
                }),
                _ => ("/messages", |s, t| {
                    json!({
                        "model": "claude-sonnet-4-5",
                        "stream": true,
                        "max_tokens": 512,
                        "messages": [{ "role": "user", "content": format!("{s} turn {t}") }],
                        "tools": [{ "name": "Shell", "input_schema": {} }],
                    })
                }),
            };
            for turn in 1..=3 {
                let resp = client
                    .post(format!("{base}{endpoint}"))
                    .header("content-type", "application/json")
                    .header("x-maka-session-id", &sid)
                    .body(body_fn(&sid, turn).to_string())
                    .send()
                    .await
                    .unwrap();
                assert_eq!(resp.status(), 200);
                let bytes = resp.bytes().await.unwrap();
                assert!(!bytes.is_empty());
            }
        });
    }

    for i in 0..40usize {
        let ws_url = ws_url.clone();
        let gate = connect_gate.clone();
        tasks.spawn(async move {
            let (mut ws, _) = {
                let _permit = gate.acquire_owned().await.unwrap();
                tokio_tungstenite::connect_async(&ws_url).await.unwrap()
            };
            let mut prev_id: Option<String> = None;
            for turn in 1..=3 {
                let mut req = json!({
                    "type": "response.create",
                    "model": "gpt-4.1",
                    "store": false,
                    "input": format!("ws-session-{i} turn {turn}"),
                    "tools": [{ "type": "function", "name": "exec" }],
                });
                if let Some(prev) = &prev_id {
                    req["previous_response_id"] = json!(prev);
                }
                ws.send(WsMessage::text(req.to_string())).await.unwrap();
                let mut completed_id = None;
                while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
                    let ev: Value = serde_json::from_str(&txt).unwrap();
                    if ev["type"] == "response.completed" {
                        completed_id = ev["response"]["id"].as_str().map(str::to_owned);
                        break;
                    }
                }
                prev_id = Some(completed_id.expect("ws response.completed id"));
            }
            let _ = ws.close(None).await;
        });
    }

    while let Some(res) = tasks.join_next().await {
        res.unwrap();
    }

    let metrics = server.metrics();
    assert_eq!(metrics.total_requests, 480);
    assert_eq!(metrics.chat_completions_requests, 120);
    assert_eq!(metrics.responses_http_requests, 120);
    assert_eq!(metrics.anthropic_requests, 120);
    assert_eq!(metrics.responses_ws_turns, 120);
    assert_eq!(metrics.ws_upgrades, 40);
    assert!(server.recorded_requests().is_empty());

    server.shutdown().await;
}

#[tokio::test]
async fn interactive_turn_handle_barriers_errors_and_connection_drop() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", server.base_url());

    // 1) Pre-stream HTTP 429 with retry-after-ms
    let req1 = tokio::spawn({
        let client = client.clone();
        let url = url.clone();
        async move {
            post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "one" }] }),
            )
            .await
        }
    });
    let turn1 = server.next_turn().await.unwrap();
    assert_eq!(turn1.request.last_user_text(), Some("one"));
    turn1
        .http_error(HttpErrorSpec::rate_limit(Some(1), "slow down").with_retry_after_ms(250))
        .await;
    let resp1 = req1.await.unwrap();
    assert_eq!(resp1.status(), 429);
    assert_eq!(resp1.headers()["retry-after-ms"], "250");
    assert_eq!(resp1.headers()["retry-after"], "1");

    // 2) Interactive mid-stream barrier + clean finish
    let req2 = tokio::spawn({
        let client = client.clone();
        let url = url.clone();
        async move {
            post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "two" }] }),
            )
            .await
            .text()
            .await
            .unwrap()
        }
    });
    let turn2 = server.next_turn().await.unwrap();
    assert!(turn2.delta("first ").await);
    assert!(turn2.delta("second").await);
    turn2.finish_with(FinishReason::Stop).await;
    let body2 = req2.await.unwrap();
    assert!(body2.contains("first "));
    assert!(body2.contains("second"));
    assert!(body2.contains("[DONE]"));

    // 3) DropConnection causes a genuine HTTP body read error (NOT clean EOF)
    let req3 = tokio::spawn({
        let client = client.clone();
        let url = url.clone();
        async move {
            let resp = post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "three" }] }),
            )
            .await;
            assert_eq!(resp.status(), 200);
            resp.bytes().await
        }
    });
    let turn3 = server.next_turn().await.unwrap();
    assert!(turn3.delta("partial").await);
    turn3.drop_connection().await;
    let res3 = req3.await.unwrap();
    assert!(
        res3.is_err(),
        "DropConnection must cause transport read error, got: {res3:?}"
    );

    // 4) TruncateEof ends HTTP body cleanly without [DONE]
    let req4 = tokio::spawn({
        let client = client.clone();
        let url = url.clone();
        async move {
            post_json(
                &client,
                &url,
                &json!({ "model": "gpt-4.1", "stream": true, "messages": [{ "role": "user", "content": "four" }] }),
            )
            .await
            .text()
            .await
            .unwrap()
        }
    });
    let turn4 = server.next_turn().await.unwrap();
    assert!(turn4.delta("halfway").await);
    turn4.truncate_eof().await;
    let body4 = req4.await.unwrap();
    assert!(body4.contains("halfway"));
    assert!(!body4.contains("[DONE]"));
}

#[tokio::test]
async fn yaml_rules_admin_api_control_plane_and_auth() {
    let yaml = r#"
auth:
  kind: api_key
  token: secret-test-key
control:
  enableAdminApi: true
  modelsPageSize: 2
  models:
    - id: model-a
      name: Model A
      contextLength: 131072
      maxCompletionTokens: 4096
    - id: model-b
      name: Model B
    - id: model-c
      name: Model C
  relayTokenUsage:
    code: true
    data:
      total_granted: 100.0
      total_used: 25.0
      total_available: 75.0
rules:
  - id: oneshot-429
    maxHits: 1
    match:
      textContains: weather
    reply:
      events:
        - type: http_error
          status: 429
          errorType: rate_limit_error
          message: try again
          retryAfterMs: 10
  - id: weather-ok
    match:
      model: "claude-*"
      textContains: weather
    reply:
      events:
        - type: text
          text: "Sunny for {{model}} on turn {{session_turn}}"
        - type: finish
          reason: stop
defaultReply:
  events:
    - type: text
      text: "Fallback {{last_user_text}}"
    - type: finish
      reason: stop
"#;

    let cfg = MockServerConfig::from_yaml_str(yaml).unwrap();
    let server = builder_from_config(cfg).unwrap().start().await.unwrap();
    let client = reqwest::Client::new();

    // Missing auth -> 401
    let unauth = client
        .get(format!("{}/models", server.base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);

    // Cursor-paginated /v1/models
    let page1 = read_json(
        client
            .get(format!("{}/models", server.base_url()))
            .bearer_auth("secret-test-key")
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(page1["data"].as_array().unwrap().len(), 2);
    assert_eq!(page1["has_more"], true);
    assert_eq!(page1["last_id"], "model-b");

    let page2 = read_json(
        client
            .get(format!("{}/models?after=model-b", server.base_url()))
            .bearer_auth("secret-test-key")
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(page2["data"].as_array().unwrap().len(), 1);
    assert_eq!(page2["data"][0]["id"], "model-c");
    assert_eq!(page2["has_more"], false);

    // Codex discovery envelope
    let codex_models = read_json(
        client
            .get(format!("{}/models?client_version=1.0.0", server.base_url()))
            .bearer_auth("secret-test-key")
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(codex_models["models"][0]["slug"], "model-a");

    // Relay usage endpoint
    let usage = read_json(
        client
            .get(format!("{}/api/usage/token/", server.origin_url()))
            .bearer_auth("secret-test-key")
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(usage["data"]["total_available"], 75.0);

    // First weather request hits oneshot-429
    let r1 = client
        .post(format!("{}/messages", server.base_url()))
        .header("content-type", "application/json")
        .header("x-api-key", "secret-test-key")
        .body(
            json!({
                "model": "claude-sonnet-4-5",
                "stream": false,
                "max_tokens": 64,
                "messages": [{ "role": "user", "content": "how is the weather?" }],
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(r1.status(), 429);

    // Second weather request falls through to weather-ok with template interpolation
    let r2 = read_json(
        client
            .post(format!("{}/messages", server.base_url()))
            .header("content-type", "application/json")
            .header("x-api-key", "secret-test-key")
            .body(
                json!({
                    "model": "claude-sonnet-4-5",
                    "stream": false,
                    "max_tokens": 64,
                    "messages": [{ "role": "user", "content": "how is the weather?" }],
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        r2["content"][0]["text"],
        "Sunny for claude-sonnet-4-5 on turn 2"
    );

    // Admin metrics + reset
    let metrics = read_json(
        client
            .get(format!("{}/admin/metrics", server.origin_url()))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(metrics["rateLimitsEmitted"], 1);
    assert_eq!(metrics["anthropicRequests"], 2);

    let reset = client
        .post(format!("{}/admin/reset", server.origin_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(reset.status(), 200);
    assert_eq!(server.metrics().total_requests, 0);
}

#[tokio::test]
async fn websocket_upgrade_rejection_and_stall_cancellation() {
    let tuning = ServerTuning {
        reject_websocket_upgrade_status: Some(426),
        ..Default::default()
    };
    let server = MockAiBuilder::new()
        .tuning(tuning)
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("gpt-4.1")],
            ..Default::default()
        })
        .auth(AuthPolicy::AllowAll)
        .scripted([TurnPlan::stall()])
        .start()
        .await
        .unwrap();

    let ws_err = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap_err();
    assert!(
        ws_err.to_string().contains("426"),
        "expected HTTP 426 rejection, got: {ws_err}"
    );

    let client = reqwest::Client::new();
    let resp = post_json(
        &client,
        &format!("{}/responses", server.base_url()),
        &json!({ "model": "gpt-4.1", "stream": true, "input": "hang" }),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let timed = tokio::time::timeout(Duration::from_millis(120), resp.bytes()).await;
    assert!(timed.is_err(), "stall must not emit bytes or close stream");
    assert_eq!(server.metrics().stalls_entered, 1);

    server.shutdown().await;
}
