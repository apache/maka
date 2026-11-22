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
use std::time::Duration;
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

async fn read_json(resp: reqwest::Response) -> Value {
    let bytes = resp.bytes().await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
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
