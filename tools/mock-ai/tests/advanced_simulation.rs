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
    CompactionOutput, ControlPlaneConfig, ExchangeOutcome, LatencyProfile, MockAiBuilder,
    ProxyRecordConfig, RateLimitConfig, RateLimitScope, RecorderMode, ReplayConfig,
    ReplayMatchMode, RuntimeProfile, ScenarioPhase, ScenarioSchedule, SynthMode, ToolCallSpec,
    TurnEvent, TurnPlan, Usage, WatchdogConfig, WirePoisonConfig, WorkloadConfig,
    synthesize_tool_arguments,
};
use maka_provider_protocol::{
    anthropic, chat_completions,
    output::{Event as WireEvent, TextKind},
    responses,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
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

async fn post_json_headers(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
    body: &Value,
) -> reqwest::Response {
    let mut b = client.post(url).header("content-type", "application/json");
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    b.body(body.to_string()).send().await.unwrap()
}

async fn put_json(
    client: &reqwest::Client,
    url: &str,
    body: &impl serde::Serialize,
) -> reqwest::Response {
    client
        .put(url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(body).unwrap())
        .send()
        .await
        .unwrap()
}

async fn parse_json(resp: reqwest::Response) -> Value {
    let txt = resp.text().await.unwrap();
    serde_json::from_str(&txt).unwrap_or_else(|e| panic!("invalid JSON ({e}): {txt}"))
}

async fn benchmark_json(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = request.send().await.unwrap();
    let actual = response.status();
    let body = parse_json(response).await;
    assert_eq!(actual, status, "{body}");
    body
}

async fn register_benchmark(client: &reqwest::Client, origin: &str, scenario: &str) {
    benchmark_json(
        json_request(
            client,
            &format!("{origin}/admin/sessions"),
            &json!({
                "runId":"bench", "sessionId":"lane", "harness":"codex", "logicalLane":"lane",
                "scenario":scenario, "workspace":std::env::current_dir().unwrap(),
            }),
        ),
        201,
    )
    .await;
}

#[tokio::test]
async fn http_and_ws_decode_duration_is_independent_of_delta_count() {
    let payload = "a".repeat(800);
    let reply = payload.clone();
    let server = MockAiBuilder::new()
        .latency_profile(LatencyProfile {
            tokens_per_sec: 1_000.0,
            ..Default::default()
        })
        .handler_fn(move |request, _| {
            let chunk_chars = if request.last_user_text() == Some("fragmented") {
                4
            } else {
                800
            };
            TurnPlan::new().push_text_chunked(reply.clone(), chunk_chars)
        })
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let url = format!("{}/responses", server.base_url());
    let (mut ws, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();

    let mut sse_durations = Vec::new();
    let mut ws_durations = Vec::new();
    for (input, count) in [("single", 1), ("fragmented", 200)] {
        let start = Instant::now();
        let response = post_json(
            &client,
            &url,
            &json!({
                "model":"gpt-5", "input":input, "stream":true
            }),
        )
        .await;
        assert_eq!(response.status(), 200);
        let stream = response.text().await.unwrap();
        sse_durations.push(start.elapsed());
        let chunks: Vec<_> = stream
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|data| serde_json::from_str::<Value>(data).unwrap())
            .collect();
        assert_eq!(
            chunks
                .iter()
                .filter(|event| event["type"] == "response.output_text.delta")
                .count(),
            count
        );
        let completed = chunks.last().unwrap();
        assert_eq!(completed["type"], "response.completed");
        assert_eq!(
            completed["response"]["output"][0]["content"][0]["text"],
            payload
        );

        let start = Instant::now();
        ws.send(WsMessage::text(
            json!({
                "type":"response.create", "model":"gpt-5", "input":input
            })
            .to_string(),
        ))
        .await
        .unwrap();
        let (completion, deltas) = tokio::time::timeout(Duration::from_secs(3), async {
            let mut deltas = 0;
            loop {
                let event: Value =
                    serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                match event["type"].as_str() {
                    Some("response.output_text.delta") => deltas += 1,
                    Some("response.completed") => break (event, deltas),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        ws_durations.push(start.elapsed());
        assert_eq!(deltas, count);
        assert_eq!(
            completion["response"]["output"][0]["content"][0]["text"],
            payload
        );
    }
    for (transport, durations) in [("SSE", sse_durations), ("WS", ws_durations)] {
        assert!(
            durations
                .iter()
                .all(|elapsed| *elapsed >= Duration::from_millis(190)),
            "{transport} fell short of the 200ms decode budget: {durations:?}"
        );
        assert!(
            durations[0].abs_diff(durations[1]) < Duration::from_millis(100),
            "{transport} accumulated per-frame drift: {durations:?}"
        );
    }
    server.shutdown().await;
}

#[tokio::test]
async fn responses_retry_keeps_call_identity_across_transports_until_all_receipts_arrive() {
    use maka_mock_ai::scenario::{
        BenchmarkTrack, CanonicalAction, FaultBoundary, FaultKind, FixtureDef, ScenarioSpec,
        ScheduledFault,
    };

    let read = |path: &str, marker: &str| CanonicalAction::ReadFile {
        path: path.into(),
        expect_marker: marker.into(),
    };
    let mut spec = ScenarioSpec::new("retry", 42, "sources", BenchmarkTrack::Native)
        .with_fixture(
            "first",
            FixtureDef::File {
                path: "src/first.txt".into(),
                content: "first marker".into(),
            },
        )
        .with_fixture(
            "second",
            FixtureDef::File {
                path: "src/second.txt".into(),
                content: "second marker".into(),
            },
        )
        .with_step(
            "read-batch",
            CanonicalAction::ParallelBatch(vec![
                read("src/first.txt", "first marker"),
                read("src/second.txt", "second marker"),
            ]),
        )
        .with_step(
            "finish",
            CanonicalAction::FinalAnswer {
                text: "Both files read.".into(),
                expect_markers: vec!["Both files read.".into()],
            },
        );
    for (attempt, at, emit) in [
        (1, FaultBoundary::BeforeHeaders, FaultKind::Http429),
        (2, FaultBoundary::BeforeHeaders, FaultKind::Http503),
        (3, FaultBoundary::AfterFirstCompleteCall, FaultKind::Eof),
    ] {
        spec = spec.with_fault(ScheduledFault {
            step: "read-batch".into(),
            attempt,
            at,
            emit,
        });
    }
    let server = MockAiBuilder::new().scenario(spec).start().await.unwrap();
    let origin = server.origin_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    register_benchmark(&client, &origin, "retry").await;
    let path = "/s/bench/lane/v1/responses";
    let url = format!("{origin}{path}");
    let ws_url = format!("ws://{}{path}", server.addr());
    let mut turn = json!({
        "model":"gpt-4.1", "stream":true, "store":true, "input":"Read both sources.",
        "tools":[{"type":"function","name":"Read","parameters":{
            "type":"object","properties":{"path":{"type":"string"}},"required":["path"],
            "additionalProperties":false,
        }}],
    });
    let rejected = benchmark_json(json_request(&client, &url, &turn), 429).await;
    assert_eq!(rejected["error"]["type"], "rate_limit_error");

    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let mut create = turn.clone();
    create["type"] = json!("response.create");
    ws.send(WsMessage::text(create.to_string())).await.unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let overloaded: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(overloaded["type"], "error");
    assert_eq!(overloaded["status"], 503);
    drop(ws);

    let truncated = post_json(&client, &url, &turn)
        .await
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let mut sse = responses::sse::Sse::default();
    let mut decoder =
        responses::decode::Decoder::new(responses::ReasoningMode::PlaintextSummary, None);
    let mut partial = Vec::new();
    for &byte in &truncated {
        if let Some(event) = sse.push(byte).unwrap() {
            if event["type"] == "response.output_item.done" {
                partial.push(event["item"].clone());
            }
            decoder.push(event).unwrap();
        }
    }
    assert!(decoder.end().is_err(), "EOF incorrectly completed the turn");
    let [first] = partial.as_slice() else {
        panic!("expected the first complete call, got {partial:?}")
    };

    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    ws.send(WsMessage::text(create.to_string())).await.unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        let mut done = Vec::new();
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            let event: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            match event["type"].as_str().unwrap() {
                "response.output_item.done" => done.push(event["item"].clone()),
                "response.completed" => {
                    assert_eq!(event["response"]["output"], json!(done));
                    break event["response"].clone();
                }
                "error" | "response.failed" => panic!("WS retry failed: {event}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let [a, b] = completed["output"].as_array().unwrap().as_slice() else {
        panic!("expected both calls on retry: {completed}")
    };
    assert_eq!(first, a);
    assert_ne!(a["call_id"], b["call_id"]);
    for (call, path) in [(a, "src/first.txt"), (b, "src/second.txt")] {
        assert_eq!(call["name"], "Read");
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            json!({"path":path})
        );
    }
    ws.close(None).await.unwrap();

    turn["stream"] = json!(false);
    let replay = benchmark_json(json_request(&client, &url, &turn), 200).await;
    assert_eq!(replay["id"], completed["id"]);
    assert_eq!(replay["output"], completed["output"]);
    turn["previous_response_id"] = completed["id"].clone();
    turn["input"] =
        json!([{"type":"function_call_output", "call_id":b["call_id"], "output":"second marker"}]);
    let pending = benchmark_json(json_request(&client, &url, &turn), 200).await;
    assert_eq!(
        pending["output"],
        json!([a]),
        "acknowledging B must leave A outstanding"
    );

    turn["input"] =
        json!([{"type":"function_call_output", "call_id":a["call_id"], "output":"first marker"}]);
    let final_answer = benchmark_json(json_request(&client, &url, &turn), 200).await;
    assert_eq!(
        final_answer["output"][0]["content"][0]["text"],
        "Both files read."
    );
    let timeline = benchmark_json(client.get(format!("{origin}/admin/sessions/lane")), 200).await;
    let main: Vec<_> = timeline["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["purpose"] == "main")
        .collect();
    assert_eq!(main.len(), 7);
    for item in &main[..6] {
        assert_eq!(item["stepId"], "read-batch");
        assert_eq!(item["revision"], main[0]["revision"]);
    }
    assert_eq!(main[6]["stepId"], "finish");
    assert_eq!(main[5]["confirmedCallIds"], json!([b["call_id"]]));
    assert_eq!(main[6]["confirmedCallIds"], json!([a["call_id"]]));
    server.shutdown().await;
}

#[tokio::test]
async fn admin_attributes_overlapping_attempts_and_requires_final_export_before_reclaim() {
    let mut server = MockAiBuilder::new()
        .strict_benchmark(true)
        .rate_limit(RateLimitConfig {
            enabled: true,
            max_concurrent: Some(1),
            ..Default::default()
        })
        .interactive(1)
        .start()
        .await
        .unwrap();
    let origin = server.origin_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    register_benchmark(&client, &origin, "overlap").await;
    let url = format!("{origin}/s/bench/lane/v1/responses");
    let detail = format!("{origin}/admin/sessions/lane");
    let finalize = format!("{detail}/finalize");
    let reset = format!("{origin}/admin/reset");
    let main = tokio::spawn(benchmark_json(
        json_request(
            &client,
            &url,
            &json!({"model":"mock-model","input":"main request"}),
        ),
        200,
    ));
    let turn = tokio::time::timeout(Duration::from_secs(5), server.next_turn())
        .await
        .unwrap()
        .unwrap();
    let title = benchmark_json(
        json_request(
            &client,
            &url,
            &json!({"model":"mock-model","input":"title request"}),
        )
        .header("x-maka-bench-request-use", "title"),
        200,
    )
    .await;
    assert_eq!(title["output"][0]["content"][0]["text"], "Benchmark task");
    let in_flight = benchmark_json(client.post(&finalize), 409).await;
    assert_eq!(in_flight["error"], "session still has in-flight attempts");
    assert_eq!(client.delete(&detail).send().await.unwrap().status(), 409);
    turn.reply_text("main released");
    let main = main.await.unwrap();
    assert_eq!(main["output"][0]["content"][0]["text"], "main released");

    let protected = benchmark_json(client.post(&reset), 409).await;
    assert_eq!(
        protected["error"],
        "export and delete benchmark sessions before resetting"
    );
    let summary = benchmark_json(client.post(&finalize), 200).await;
    assert_eq!(summary["finalized"], true);
    assert_eq!(summary["attempts"], 2);
    let page = benchmark_json(client.get(format!("{detail}?limit=1")), 200).await;
    let next = &page["nextCursor"];
    assert_eq!(next, 1);
    let rest = benchmark_json(client.get(format!("{detail}?limit=1&after={next}")), 200).await;
    assert_eq!(rest["nextCursor"], 2);
    for page in [&page, &rest] {
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["cursor"], page["nextCursor"]);
    }
    let attempts = [&page["items"][0], &rest["items"][0]];
    let main = attempts
        .iter()
        .find(|item| item["purpose"] == "main")
        .unwrap();
    let title = attempts
        .iter()
        .find(|item| item["purpose"] == "title")
        .unwrap();
    let timestamp = |item: &Value, field: &str| item[field].as_u64().unwrap();
    assert!(timestamp(main, "headersReceivedNs") < timestamp(title, "headersReceivedNs"));
    assert!(timestamp(title, "lastFrameConsumedNs") < timestamp(main, "lastFrameConsumedNs"));
    let attribution = &page["attribution"];
    assert_eq!(attribution, &rest["attribution"]);
    assert_eq!(attribution["overlappingIntervalsCount"], 1);
    assert!(attribution["outsideMockWallNs"].as_u64().is_some());
    let by_purpose = &attribution["mockServiceSumByPurposeNs"];
    let main_ns = by_purpose["main"].as_u64().unwrap();
    let title_ns = by_purpose["title"].as_u64().unwrap();
    let sum = attribution["mockServiceSumNs"].as_u64().unwrap();
    let union = attribution["mockUnionNs"].as_u64().unwrap();
    assert_eq!(sum, main_ns + title_ns);
    assert_eq!(union, main_ns);
    assert!(union < sum);

    let cursor = &summary["cursor"];
    assert_eq!(client.delete(&detail).send().await.unwrap().status(), 400);
    assert_eq!(
        client
            .delete(format!("{detail}?cursor={cursor}&after={next}"))
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    assert_eq!(client.post(&reset).send().await.unwrap().status(), 409);
    let through = &rest["nextCursor"];
    let deleted = benchmark_json(
        client.delete(format!("{detail}?cursor={cursor}&after={through}")),
        200,
    )
    .await;
    assert_eq!(deleted, json!({"deleted":true}));
    assert_eq!(client.get(&detail).send().await.unwrap().status(), 404);
    let list = benchmark_json(
        client.get(format!("{origin}/admin/sessions?run=bench")),
        200,
    )
    .await;
    assert_eq!(list["items"], json!([]));
    assert_eq!(
        benchmark_json(client.post(&reset), 200).await,
        json!({"reset":true})
    );
    server.shutdown().await;
}

#[tokio::test]
async fn dynamic_ttft_tps_hot_tuning_and_ping_disconnect_hygiene() {
    let server = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            enable_admin_api: true,
            ..Default::default()
        })
        .rate_limit(RateLimitConfig {
            enabled: true,
            scope: RateLimitScope::Global,
            max_concurrent: Some(1),
            ..Default::default()
        })
        .handler_fn(|_, _| {
            TurnPlan::new()
                .push_text_chunked("hello world streaming tokens for pacing verification", 10)
                .with_usage(Usage::new(100, 16))
        })
        .start()
        .await
        .expect("start server");

    let client = reqwest::Client::new();

    // 1. Instant baseline
    let t0 = Instant::now();
    let resp = post_json(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "hi"}]
        }),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await.unwrap();
    let baseline_ms = t0.elapsed().as_millis();
    assert!(
        baseline_ms < 200,
        "instant baseline was unexpectedly slow: {baseline_ms}ms"
    );

    // 2. Hot-tune via PUT /admin/profile to inject 120ms TTFT + 250 TPS
    let slow_profile = RuntimeProfile {
        latency: LatencyProfile {
            base_ttft_ms: 120,
            tokens_per_sec: 250.0,
            ..Default::default()
        },
        chaos_override: None,
        rate_limit_override: None,
    };
    let put = put_json(
        &client,
        &format!("{}/admin/profile", server.origin_url()),
        &slow_profile,
    )
    .await;
    assert_eq!(put.status(), 200);

    let t1 = Instant::now();
    let resp2 = post_json(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "slow turn"}]
        }),
    )
    .await;
    assert_eq!(resp2.status(), 200);
    let _ = resp2.text().await.unwrap();
    assert!(
        t1.elapsed() >= Duration::from_millis(110),
        "expected hot-tuned TTFT >= 110ms, got {:?}",
        t1.elapsed()
    );

    // 3. Long TTFT with SSE ping: disconnect right after receiving first ping!
    // Must NOT record a bogus TTFT sample AND must immediately release max_concurrent=1 slot.
    let ping_profile = RuntimeProfile {
        latency: LatencyProfile {
            base_ttft_ms: 5_000,
            sse_ping_interval_ms: 25,
            ..Default::default()
        },
        chaos_override: None,
        rate_limit_override: None,
    };
    server.set_runtime_profile(Some(ping_profile));
    let before_ttft_count = server.metrics().ttft_ms.count;

    let mut ping_resp = post_json(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "abort on ping"}]
        }),
    )
    .await;
    assert_eq!(ping_resp.status(), 200);
    let first_chunk = ping_resp
        .chunk()
        .await
        .unwrap()
        .expect("expected SSE ping chunk");
    assert!(
        String::from_utf8_lossy(&first_chunk).contains(": keep-alive"),
        "expected keep-alive comment, got {:?}",
        String::from_utf8_lossy(&first_chunk)
    );
    drop(ping_resp);

    // Clear manual override back to instant and verify concurrency slot is released promptly.
    server.set_runtime_profile(None);
    let mut slot_recovered = false;
    for _ in 0..40 {
        let probe = post_json(
            &client,
            &format!("{}/chat/completions", server.base_url()),
            &json!({
                "model": "gpt-5",
                "stream": false,
                "messages": [{"role": "user", "content": "slot check"}]
            }),
        )
        .await;
        if probe.status() == 200 {
            slot_recovered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        slot_recovered,
        "concurrency slot was not released after ping disconnect"
    );

    // TTFT count should have increased by exactly 1 (for the successful slot check, NOT the aborted ping turn).
    let snap = server.metrics();
    assert_eq!(snap.ttft_ms.count, before_ttft_count + 1);
    assert!(snap.abandoned_streams >= 1);

    // Verify ScenarioSchedule phase resolution
    let sched = ScenarioSchedule {
        phases: vec![
            ScenarioPhase {
                name: "phase-a".into(),
                at_secs: 0,
                profile: RuntimeProfile::default(),
            },
            ScenarioPhase {
                name: "phase-b".into(),
                at_secs: 10,
                profile: RuntimeProfile::default(),
            },
        ],
        repeat_cycle_secs: Some(20),
    };
    assert_eq!(sched.active_phase(5).unwrap().name, "phase-a");
    assert_eq!(sched.active_phase(12).unwrap().name, "phase-b");
    assert_eq!(sched.active_phase(25).unwrap().name, "phase-a");

    server.shutdown().await;
}

#[tokio::test]
async fn stateful_rate_limiter_scopes_otpm_and_table_cap() {
    let server = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            enable_admin_api: true,
            ..Default::default()
        })
        .rate_limit(RateLimitConfig {
            enabled: true,
            scope: RateLimitScope::PerApiKey,
            rpm: Some(2),
            rpm_burst: Some(2),
            otpm: Some(10),
            max_buckets: 2,
            ..Default::default()
        })
        .handler_fn(|_, _| TurnPlan::text("ok").with_usage(Usage::new(10, 20)))
        .start()
        .await
        .expect("start server");

    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", server.base_url());

    // Key A turn 1 -> 200 with x-ratelimit headers; debits 20 output tokens against OTPM=10
    let r1 = post_json_headers(
        &client,
        &url,
        &[("authorization", "Bearer key-a")],
        &json!({"model": "gpt-5", "stream": false, "messages": [{"role": "user", "content": "1"}]}),
    )
    .await;
    assert_eq!(r1.status(), 200);
    assert_eq!(r1.headers().get("x-ratelimit-limit-requests").unwrap(), "2");
    assert_eq!(
        r1.headers().get("x-ratelimit-remaining-requests").unwrap(),
        "1"
    );

    // Key A turn 2 -> 429 due to OTPM post-turn debit, with retry-after-ms header
    let r2 = post_json_headers(
        &client,
        &url,
        &[("authorization", "Bearer key-a")],
        &json!({"model": "gpt-5", "stream": false, "messages": [{"role": "user", "content": "2"}]}),
    )
    .await;
    assert_eq!(r2.status(), 429);
    assert!(r2.headers().get("retry-after-ms").is_some());
    assert!(r2.headers().get("retry-after").is_some());

    // Key B is isolated -> 200
    let r3 = post_json_headers(
        &client,
        &url,
        &[("authorization", "Bearer key-b")],
        &json!({"model": "gpt-5", "stream": false, "messages": [{"role": "user", "content": "1"}]}),
    )
    .await;
    assert_eq!(r3.status(), 200);

    // Key C hits max_buckets=2 where Key A & Key B still have active token deficits -> 429 table full
    let r4 = post_json_headers(
        &client,
        &url,
        &[("authorization", "Bearer key-c")],
        &json!({"model": "gpt-5", "stream": false, "messages": [{"role": "user", "content": "1"}]}),
    )
    .await;
    assert_eq!(r4.status(), 429);
    let body4 = parse_json(r4).await;
    assert!(
        body4.to_string().contains("rate_limit_table_full"),
        "expected table full rejection, got {body4}"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn schema_synthesis_wire_poison_and_overflow_conform_to_real_decoders() {
    // 1. Verify JSON Schema synthesis respects required fields, enums, nested objects, and minItems=5
    let schema = json!({
        "type": "object",
        "required": ["file_path", "tags", "mode", "count"],
        "properties": {
            "file_path": { "type": "string" },
            "mode": { "type": "string", "enum": ["fast", "strict"] },
            "count": { "type": "integer", "minimum": 10, "maximum": 20 },
            "tags": {
                "type": "array",
                "minItems": 5,
                "items": { "type": "string" }
            }
        }
    });
    let mut rng = fastrand::Rng::with_seed(7);
    let valid = synthesize_tool_arguments(&schema, &mut rng, SynthMode::Valid);
    assert!(valid["file_path"].as_str().unwrap().contains(".rs"));
    assert!(matches!(valid["mode"].as_str(), Some("fast" | "strict")));
    let count = valid["count"].as_i64().unwrap();
    assert!((10..=20).contains(&count));
    assert_eq!(valid["tags"].as_array().unwrap().len(), 5);

    let missing = synthesize_tool_arguments(&schema, &mut rng, SynthMode::MissingRequired);
    assert!(missing.get("file_path").is_none());

    let malformed = synthesize_tool_arguments(&schema, &mut rng, SynthMode::MalformedJson);
    assert!(serde_json::from_str::<Value>(malformed.as_str().unwrap()).is_err());

    let huge = synthesize_tool_arguments(&schema, &mut rng, SynthMode::HugePayload(16 * 1024));
    assert!(huge.to_string().len() >= 16 * 1024);

    // 2. Wire-poisoned SSE (UTF-8 boundary split + CRLF + SSE comments) across all 3 protocols fed into REAL decoders!
    let poison = WirePoisonConfig {
        split_utf8_boundaries: true,
        crlf_line_endings: true,
        inject_sse_comments: true,
    };
    let expected_cjk = "中文边界测试🚀 UTF-8 multi-byte chunking! 你好世界✨";
    let server = MockAiBuilder::new()
        .handler_fn({
            let poison = poison.clone();
            move |req, _| {
                if req.last_user_text() == Some("malformed-anthropic") {
                    let mut tc = ToolCallSpec::new(
                        "toolu_bad",
                        "Write",
                        Value::String("{\"path\": \"broken".into()),
                    );
                    tc.chunk_chars = 5;
                    return TurnPlan::new()
                        .push(TurnEvent::ToolCall(tc))
                        .with_wire_poison(poison.clone());
                }
                TurnPlan::new()
                    .push_text_chunked(expected_cjk, 6)
                    .with_usage(Usage::new(50, 20))
                    .with_wire_poison(poison.clone())
            }
        })
        .start()
        .await
        .expect("start server");

    let client = reqwest::Client::new();

    // Chat Completions: push each raw HTTP chunk directly into real ChatCompletions Stream decoder
    let mut chat_resp = post_json(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &json!({"model": "gpt-5", "stream": true, "messages": [{"role": "user", "content": "hi"}]}),
    )
    .await;
    let mut dec = chat_completions::Stream::new("openai".into());
    let mut seq = 0usize;
    let mut next_id = || {
        seq += 1;
        format!("g_{seq}")
    };
    let mut chat_text = String::new();
    let mut chunk_count = 0usize;
    while let Some(chunk) = chat_resp.chunk().await.unwrap() {
        chunk_count += 1;
        for ev in dec.push(&chunk, &mut next_id).unwrap() {
            if let WireEvent::TextDelta {
                kind: TextKind::Text,
                text,
                ..
            } = ev
            {
                chat_text.push_str(&text);
            }
        }
    }
    for ev in dec.finish(&mut next_id).unwrap() {
        if let WireEvent::TextDelta {
            kind: TextKind::Text,
            text,
            ..
        } = ev
        {
            chat_text.push_str(&text);
        }
    }
    assert!(
        chunk_count > 5,
        "expected UTF-8 boundary split into many HTTP chunks, got {chunk_count}"
    );
    assert_eq!(chat_text, expected_cjk);

    // Responses HTTP with real responses::sse::Sse + responses::decode::Decoder
    let mut r_resp = post_json(
        &client,
        &format!("{}/responses", server.base_url()),
        &json!({"model": "gpt-5", "stream": true, "input": "hi"}),
    )
    .await;
    let mut sse = responses::sse::Sse::default();
    let mut r_dec =
        responses::decode::Decoder::new(responses::ReasoningMode::PlaintextSummary, None);
    let mut r_text = String::new();
    while let Some(chunk) = r_resp.chunk().await.unwrap() {
        for &b in chunk.as_ref() {
            if let Some(frame) = sse.push(b).unwrap() {
                for ev in r_dec.push(frame).unwrap() {
                    if let responses::Event::PartDelta { text, .. } = ev {
                        r_text.push_str(&text);
                    }
                }
            }
        }
    }
    assert_eq!(r_text, expected_cjk);

    // Anthropic Messages with real anthropic::stream::Stream
    let mut a_resp = post_json(
        &client,
        &format!("{}/messages", server.base_url()),
        &json!({"model": "claude-sonnet-4-6", "stream": true, "max_tokens": 256, "messages": [{"role": "user", "content": "hi"}]}),
    )
    .await;
    let mut a_dec = anthropic::stream::Stream::new(anthropic::response::Options::default());
    let mut a_text = String::new();
    while let Some(chunk) = a_resp.chunk().await.unwrap() {
        for ev in a_dec.push(&chunk, &mut next_id, |_| {}).unwrap() {
            if let WireEvent::TextDelta {
                kind: TextKind::Text,
                text,
                ..
            } = ev
            {
                a_text.push_str(&text);
            }
        }
    }
    for ev in a_dec.finish() {
        if let WireEvent::TextDelta {
            kind: TextKind::Text,
            text,
            ..
        } = ev
        {
            a_text.push_str(&text);
        }
    }
    assert_eq!(a_text, expected_cjk);

    // Anthropic MalformedJson reaches real decoder via input_json_delta.partial_json (surfaces decode error or raw partial)
    let mut bad_resp = post_json(
        &client,
        &format!("{}/messages", server.base_url()),
        &json!({"model": "claude-sonnet-4-6", "stream": true, "max_tokens": 256, "messages": [{"role": "user", "content": "malformed-anthropic"}]}),
    )
    .await;
    let mut raw_bad = String::new();
    let mut bad_dec = anthropic::stream::Stream::new(anthropic::response::Options::default());
    let mut decoded_bad_input: Option<String> = None;
    let mut saw_decode_err = false;
    while let Some(chunk) = bad_resp.chunk().await.unwrap() {
        raw_bad.push_str(&String::from_utf8_lossy(&chunk));
        match bad_dec.push(&chunk, &mut next_id, |_| {}) {
            Ok(evs) => {
                for ev in evs {
                    match ev {
                        WireEvent::Error(_) => saw_decode_err = true,
                        WireEvent::ToolCall(tc) => decoded_bad_input = Some(tc.input),
                        _ => {}
                    }
                }
            }
            Err(_) => saw_decode_err = true,
        }
    }
    for ev in bad_dec.finish() {
        match ev {
            WireEvent::Error(_) => saw_decode_err = true,
            WireEvent::ToolCall(tc) => decoded_bad_input = Some(tc.input),
            _ => {}
        }
    }
    assert!(raw_bad.contains("input_json_delta"), "raw={raw_bad}");
    assert!(
        saw_decode_err || decoded_bad_input.as_deref() == Some("{\"path\": \"broken"),
        "malformed JSON must reach real Anthropic decoder unsanitized (err={saw_decode_err}, input={decoded_bad_input:?})"
    );

    server.shutdown().await;

    // 3. Context overflow ceiling in WorkloadGenerator
    let overflow_srv = MockAiBuilder::new()
        .workload(WorkloadConfig {
            context_overflow_bytes: Some(256),
            ..Default::default()
        })
        .start()
        .await
        .unwrap();
    let big_prompt = "x".repeat(400);
    let ov_resp = post_json(
        &client,
        &format!("{}/messages", overflow_srv.base_url()),
        &json!({"model": "claude-sonnet-4-6", "stream": false, "max_tokens": 64, "messages": [{"role": "user", "content": big_prompt}]}),
    )
    .await;
    assert_eq!(ov_resp.status(), 400);
    let ov_body = parse_json(ov_resp).await;
    assert!(ov_body.to_string().contains("prompt is too long"));
    assert_eq!(overflow_srv.metrics().context_overflows_emitted, 1);
    overflow_srv.shutdown().await;
}

#[tokio::test]
async fn watchdog_violations_and_ws_single_baseline_strictness() {
    let server = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            enable_admin_api: true,
            ..Default::default()
        })
        .watchdog(WatchdogConfig {
            enabled: true,
            max_session_prompt_bytes: Some(500),
            ..Default::default()
        })
        .handler_fn(|req, ctx| {
            if req.has_compaction_trigger {
                return TurnPlan::new()
                    .push_compaction(CompactionOutput::new("enc_compacted_state"))
                    .with_response_id(format!("resp_c_{}", ctx.session_turn));
            }
            if ctx.session_turn == 1 && req.last_user_text() == Some("call-tool") {
                return TurnPlan::new().push_tool_call(
                    "call_known_1",
                    "Read",
                    json!({"path": "a.rs"}),
                );
            }
            TurnPlan::text(format!("ok-{}", ctx.session_turn))
                .with_response_id(format!("resp_{}", ctx.session_turn))
        })
        .start()
        .await
        .unwrap();

    let client = reqwest::Client::new();

    // 1. WS strict single-baseline test: Turn 1 -> resp_1, Turn 2 (prev=resp_1) -> resp_2, Turn 3 (stale prev=resp_1) -> REJECTED!
    let (mut ws, _) = tokio_tungstenite::connect_async(server.responses_ws_url())
        .await
        .unwrap();
    ws.send(WsMessage::text(
        json!({"type": "response.create", "model": "gpt-5", "store": false, "input": "t1"})
            .to_string(),
    ))
    .await
    .unwrap();
    while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
        if txt.contains("response.completed") {
            break;
        }
    }

    ws.send(WsMessage::text(
        json!({"type": "response.create", "model": "gpt-5", "store": false, "previous_response_id": "resp_1", "input": "t2"})
            .to_string(),
    ))
    .await
    .unwrap();
    while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
        if txt.contains("response.completed") {
            break;
        }
    }

    // Continuing from superseded resp_1 must fail!
    ws.send(WsMessage::text(
        json!({"type": "response.create", "model": "gpt-5", "store": false, "previous_response_id": "resp_1", "input": "stale"})
            .to_string(),
    ))
    .await
    .unwrap();
    let err_msg = ws.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(
        err_msg.contains("previous_response_not_found"),
        "expected superseded WS baseline rejection, got {err_msg}"
    );

    // 2. CompactionNotReplayed: trigger compaction via Codex session_id header, then omit compaction on next turn
    let _ = post_json_headers(
        &client,
        &format!("{}/responses", server.base_url()),
        &[("session_id", "sess-comp")],
        &json!({
            "model": "gpt-5",
            "stream": false,
            "input": [{"role": "user", "content": "hi"}, {"type": "compaction_trigger"}]
        }),
    )
    .await;
    let _ = post_json_headers(
        &client,
        &format!("{}/responses", server.base_url()),
        &[("session_id", "sess-comp")],
        &json!({
            "model": "gpt-5",
            "stream": false,
            "input": [{"role": "user", "content": "forgot compaction item"}]
        }),
    )
    .await;

    // 3. Duplicate + Unknown tool_result + UnboundedPromptGrowth
    let _ = post_json_headers(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &[("x-session-id", "sess-tools")],
        &json!({"model": "gpt-5", "stream": false, "messages": [{"role": "user", "content": "call-tool"}]}),
    )
    .await;
    let big = "z".repeat(600);
    let _ = post_json_headers(
        &client,
        &format!("{}/chat/completions", server.base_url()),
        &[("x-session-id", "sess-tools")],
        &json!({
            "model": "gpt-5",
            "stream": false,
            "messages": [
                {"role": "user", "content": big},
                {"role": "tool", "tool_call_id": "call_known_1", "content": "ok"},
                {"role": "tool", "tool_call_id": "call_known_1", "content": "dup"},
                {"role": "tool", "tool_call_id": "call_bogus", "content": "unknown"}
            ]
        }),
    )
    .await;

    let viols = parse_json(
        client
            .get(format!("{}/admin/violations", server.origin_url()))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let by_kind = viols["byKind"].as_object().unwrap();
    assert!(
        by_kind.get("invalid_previous_response_id").is_some(),
        "viols={viols}"
    );
    assert!(
        by_kind.get("compaction_not_replayed").is_some(),
        "viols={viols}"
    );
    assert!(
        by_kind.get("duplicate_tool_result").is_some(),
        "viols={viols}"
    );
    assert!(
        by_kind.get("unknown_tool_result").is_some(),
        "viols={viols}"
    );
    assert!(
        by_kind.get("unbounded_prompt_growth").is_some(),
        "viols={viols}"
    );

    let del = client
        .delete(format!("{}/admin/violations", server.origin_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 200);
    assert_eq!(server.watchdog_snapshot().total_violations, 0);

    server.shutdown().await;
}

#[tokio::test]
async fn per_model_histograms_and_prometheus_metrics() {
    let server = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            enable_admin_api: true,
            ..Default::default()
        })
        .handler_fn(|req, _| {
            if req.model == "slow-model" {
                TurnPlan::text("slow reply")
                    .with_ttft_ms(70)
                    .with_usage(Usage::new(100, 20))
            } else {
                TurnPlan::text("fast reply").with_usage(Usage::new(50, 10))
            }
        })
        .start()
        .await
        .unwrap();

    let client = reqwest::Client::new();
    for model in ["fast-model", "fast-model", "slow-model"] {
        let resp = post_json(
            &client,
            &format!("{}/chat/completions", server.base_url()),
            &json!({"model": model, "stream": true, "messages": [{"role": "user", "content": "ping"}]}),
        )
        .await;
        assert_eq!(resp.status(), 200);
        let _ = resp.text().await.unwrap();
    }

    let snap = server.metrics();
    let fast = snap
        .by_dimension
        .iter()
        .find(|d| d.model == "fast-model")
        .expect("fast-model dim");
    let slow = snap
        .by_dimension
        .iter()
        .find(|d| d.model == "slow-model")
        .expect("slow-model dim");
    assert_eq!(fast.requests, 2);
    assert_eq!(slow.requests, 1);
    assert!(
        slow.ttft_ms.p99 >= 50,
        "expected slow-model p99 >= 50ms, got {:?}",
        slow.ttft_ms
    );
    assert!(
        fast.ttft_ms.p99 < slow.ttft_ms.p99,
        "fast={:?} slow={:?}",
        fast.ttft_ms,
        slow.ttft_ms
    );

    let prom = client
        .get(format!("{}/metrics", server.origin_url()))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(prom.contains("mock_ai_ttft_ms_bucket{"));
    assert!(prom.contains(
        "mock_ai_dimension_ttft_ms_bucket{protocol=\"chat_completions\",model=\"slow-model\",status=\"200\""
    ));
    assert!(prom.contains("mock_ai_watchdog_violations_total"));

    server.shutdown().await;
}

#[tokio::test]
async fn prometheus_exports_unique_samples_for_mixed_statuses_on_one_model() {
    use maka_mock_ai::HttpErrorSpec;
    use std::collections::{BTreeMap, BTreeSet};

    let server = MockAiBuilder::new()
        .scripted([
            TurnPlan::text("ok"),
            TurnPlan::http_error(HttpErrorSpec::rate_limit(Some(1), "slow down")),
            TurnPlan::http_error(HttpErrorSpec::new(503, "overloaded_error", "busy")),
        ])
        .start()
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let endpoint = format!("{}/chat/completions", server.base_url());
    let request = json!({
        "model":"mixed-model","stream":true,"messages":[{"role":"user","content":"ping"}],
    });
    for expected in [200, 429, 503] {
        let response = post_json(&client, &endpoint, &request).await;
        let status = response.status();
        let body = response.text().await.unwrap();
        assert_eq!(status, expected, "{body}");
    }
    let exposition = client
        .get(format!("{}/metrics", server.origin_url()))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();

    let mut series = BTreeSet::new();
    let mut requests_by_status = BTreeMap::new();
    for line in exposition
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let (key, sample) = line.rsplit_once(' ').unwrap();
        let (name, mut labels) = key
            .split_once('{')
            .map_or((key, Vec::new()), |(name, labels)| {
                (name, labels.strip_suffix('}').unwrap().split(',').collect())
            });
        labels.sort_unstable();
        if name == "mock_ai_dimension_requests_total" && labels.contains(&r#"model="mixed-model""#)
        {
            let status = labels
                .iter()
                .find_map(|label| label.strip_prefix("status=\""))
                .unwrap();
            assert!(
                requests_by_status
                    .insert(status.trim_end_matches('"'), sample)
                    .is_none()
            );
        }
        assert!(
            series.insert((name, labels)),
            "duplicate Prometheus sample: {line}"
        );
    }
    assert_eq!(
        requests_by_status,
        BTreeMap::from([("200", "1"), ("429", "1"), ("503", "1")])
    );
    server.shutdown().await;
}

#[tokio::test]
async fn transparent_proxy_record_redaction_and_speed_scaled_replay() {
    // 1. Start upstream simulated provider
    let upstream = MockAiBuilder::new()
        .handler_fn(|req, _| {
            TurnPlan::new()
                .push_text_chunked(
                    format!(
                        "recorded upstream reply for {}",
                        req.last_user_text().unwrap_or("")
                    ),
                    12,
                )
                .with_chunk_delay_ms(10)
        })
        .start()
        .await
        .unwrap();

    let cassette_path = std::env::temp_dir().join(format!(
        "maka-mock-ai-cassette-{}.ndjson",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&cassette_path);

    // 2. Start transparent proxy recorder pointing at upstream
    let proxy = MockAiBuilder::new()
        .recorder(RecorderMode::MetricsOnly)
        .proxy_record(ProxyRecordConfig::new(
            upstream.origin_url(),
            &cassette_path,
        ))
        .unwrap()
        .start()
        .await
        .unwrap();

    let client = reqwest::Client::new();

    // Send HTTP SSE turn through proxy with secret headers
    let http_body = post_json_headers(
        &client,
        &format!("{}/chat/completions", proxy.base_url()),
        &[
            ("authorization", "Bearer sk-top-secret-token"),
            ("x-api-key", "ant-secret-key"),
        ],
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "hello-http"}]
        }),
    )
    .await
    .text()
    .await
    .unwrap();
    assert!(
        http_body.contains("recorded ups") && http_body.contains("hello-ht"),
        "http_body={http_body}"
    );

    // Send Responses WebSocket turn through proxy
    let (mut ws, _) = tokio_tungstenite::connect_async(proxy.responses_ws_url())
        .await
        .unwrap();
    ws.send(WsMessage::text(
        json!({"type": "response.create", "model": "gpt-5", "input": "hello-ws"}).to_string(),
    ))
    .await
    .unwrap();
    let mut ws_frames = String::new();
    while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
        ws_frames.push_str(&txt);
        if txt.contains("response.completed") {
            break;
        }
    }
    assert!(
        ws_frames.contains("recorded ups") && ws_frames.contains("ws"),
        "ws_frames={ws_frames}"
    );
    let _ = ws.close(None).await;

    proxy.shutdown().await;
    upstream.shutdown().await;

    // Verify secrets were redacted and outcomes are Completed
    let raw_cassette = std::fs::read_to_string(&cassette_path).unwrap();
    assert!(
        !raw_cassette.contains("sk-top-secret-token"),
        "auth header leaked into cassette!"
    );
    assert!(
        !raw_cassette.contains("ant-secret-key"),
        "x-api-key leaked into cassette!"
    );
    assert!(raw_cassette.contains("[REDACTED]"));

    let exchanges = maka_mock_ai::proxy::load_ndjson(&cassette_path).unwrap();
    assert_eq!(exchanges.len(), 2, "expected 1 HTTP + 1 WS exchange");
    assert!(
        exchanges
            .iter()
            .all(|e| e.outcome == ExchangeOutcome::Completed)
    );

    // 3. Start offline Replay server (upstream is DEAD) at 10x speed with Fingerprint matching
    let replayer = MockAiBuilder::new()
        .replay(
            ReplayConfig::new(&cassette_path)
                .with_speed(10.0)
                .with_match_mode(ReplayMatchMode::Fingerprint),
        )
        .unwrap()
        .start()
        .await
        .unwrap();

    // Replay HTTP turn offline
    let replayed_http = post_json(
        &client,
        &format!("{}/chat/completions", replayer.base_url()),
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "hello-http"}]
        }),
    )
    .await
    .text()
    .await
    .unwrap();
    assert_eq!(replayed_http, http_body);

    // Replay WS turn offline
    let (mut rws, _) = tokio_tungstenite::connect_async(replayer.responses_ws_url())
        .await
        .unwrap();
    rws.send(WsMessage::text(
        json!({"type": "response.create", "model": "gpt-5", "input": "hello-ws"}).to_string(),
    ))
    .await
    .unwrap();
    let mut replayed_ws = String::new();
    while let Some(Ok(WsMessage::Text(txt))) = rws.next().await {
        replayed_ws.push_str(&txt);
        if txt.contains("response.completed") {
            break;
        }
    }
    assert_eq!(replayed_ws, ws_frames);
    assert_eq!(replayer.metrics().replay_hits, 2);

    replayer.shutdown().await;
    let _ = std::fs::remove_file(&cassette_path);
}

// RFC-5280 compliant test-only ECDSA P-256 CA + serverAuth leaf cert (SAN=DNS:localhost,IP:127.0.0.1, 2020-2099).
const TEST_TLS_CA_PEM: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIBfTCCASSgAwIBAgIUXWjaMTk/3wvD/6Avm6tpE8kIQhAwCgYIKoZIzj0EAwIw\n\
HDEaMBgGA1UEAwwRTWFrYSBNb2NrIFRlc3QgQ0EwIBcNMjAwMTAxMDAwMDAwWhgP\n\
MjA5OTAxMDEwMDAwMDBaMBwxGjAYBgNVBAMMEU1ha2EgTW9jayBUZXN0IENBMFkw\n\
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELwJllC3q9Cr6oz7M3vYFtw79baTs8pxS\n\
D95aqv0IcfmCINtSjGcYCL7GGPCeo8k0VGT77DbOLEabYOiBzFvpGKNCMEAwDwYD\n\
VR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFCminpf0idUW\n\
9oW6xN6eEp/MS1rWMAoGCCqGSM49BAMCA0cAMEQCIEHu3fNIv8t+Gdbqh/T0AJPp\n\
UNjdd/OIRHIxgE8u2k6CAiA162S4lsk8pkeHQ3B6Nmwc7j/P+VJvFfftEEOcaUD5\n\
AA==\n\
-----END CERTIFICATE-----\n";

const TEST_TLS_CERT_PEM: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIBhTCCASugAwIBAgIUMY86krJzb/j02Kio9Tz09Bzi3r0wCgYIKoZIzj0EAwIw\n\
HDEaMBgGA1UEAwwRTWFrYSBNb2NrIFRlc3QgQ0EwIBcNMjAwMTAxMDAwMDAwWhgP\n\
MjA5OTAxMDEwMDAwMDBaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49\n\
AgEGCCqGSM49AwEHA0IABNBqG8tkQweSkCf7291/SnjWIDcaWOZZtPmBYHNAAq4n\n\
Sdq6JiT+w2XFCSRgtA0d5x12oqj8KXJevEqWZXgKoHajUTBPMAwGA1UdEwEB/wQC\n\
MAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBoGA1UdEQQT\n\
MBGCCWxvY2FsaG9zdIcEfwAAATAKBggqhkjOPQQDAgNIADBFAiEA1Bh1yfoUHZhK\n\
tyNTrWCX/Ia4U1ooqoTke6awHurWfFQCIFPI22XUBLVahCy3PSMMH8vFE02BEbUJ\n\
aE839nvrvnWk\n\
-----END CERTIFICATE-----\n";

const TEST_TLS_KEY_PEM: &[u8] = b"-----BEGIN EC PRIVATE KEY-----\n\
MHcCAQEEIAHKeDz9cTM5qpaUMvQ90lGKa1ZwT4ayZBTGLHSSt8uwoAoGCCqGSM49\n\
AwEHoUQDQgAE0Goby2RDB5KQJ/vb3X9KeNYgNxpY5lm0+YFgc0ACridJ2romJP7D\n\
ZcUJJGC0DR3nHXaiqPwpcl68SpZleAqgdg==\n\
-----END EC PRIVATE KEY-----\n";

#[tokio::test]
async fn tls_https_and_wss_proxy_record_and_offline_replay() {
    let tls_cfg =
        maka_mock_ai::TlsServerConfig::from_pem_bytes(TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM)
            .expect("parse test TLS cert/key");

    // 1. Upstream MockAiServer serving HTTPS + WSS
    let upstream = MockAiBuilder::new()
        .tls(tls_cfg.clone())
        .handler_fn(|req, _| {
            TurnPlan::text(format!(
                "tls-upstream-ok:{}",
                req.last_user_text().unwrap_or("")
            ))
        })
        .start()
        .await
        .expect("start TLS upstream");
    assert!(upstream.is_tls());
    assert!(upstream.origin_url().starts_with("https://"));
    assert!(upstream.responses_ws_url().starts_with("wss://"));

    // 2. Proxy-Record server also serving HTTPS + WSS and forwarding to TLS upstream with CA verification
    let cassette_path = std::env::temp_dir().join(format!(
        "maka-mock-ai-tls-cassette-{}.ndjson",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&cassette_path);

    let proxy = MockAiBuilder::new()
        .tls(tls_cfg)
        .recorder(RecorderMode::MetricsOnly)
        .proxy_record(
            ProxyRecordConfig::new(upstream.origin_url(), &cassette_path)
                .with_upstream_ca_pem(TEST_TLS_CA_PEM),
        )
        .unwrap()
        .start()
        .await
        .expect("start TLS proxy");

    // 2a. HTTPS SSE turn through TLS proxy -> TLS upstream
    let ca_certs = reqwest::Certificate::from_pem_bundle(TEST_TLS_CA_PEM).unwrap();
    let https_client = reqwest::Client::builder()
        .tls_certs_only(ca_certs)
        .build()
        .unwrap();
    let https_body = post_json_headers(
        &https_client,
        &format!("{}/chat/completions", proxy.base_url()),
        &[("authorization", "Bearer tls-secret-token")],
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "https-ping"}]
        }),
    )
    .await
    .text()
    .await
    .unwrap();
    assert!(
        https_body.contains("tls-upstream-ok:https-ping"),
        "https_body={https_body}"
    );

    // 2b. WSS turn through TLS proxy -> TLS upstream using our own build_tls_connector + connect_ws_upstream
    let connector = maka_mock_ai::build_tls_connector(Some(TEST_TLS_CA_PEM)).unwrap();
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let ws_req = proxy.responses_ws_url().into_client_request().unwrap();
    let mut wss = maka_mock_ai::connect_ws_upstream(ws_req, &connector)
        .await
        .expect("connect wss to proxy");
    wss.send(WsMessage::text(
        json!({"type": "response.create", "model": "gpt-5", "input": "wss-ping"}).to_string(),
    ))
    .await
    .unwrap();
    let mut wss_frames = String::new();
    while let Some(Ok(WsMessage::Text(txt))) = wss.next().await {
        wss_frames.push_str(&txt);
        if txt.contains("response.completed") {
            break;
        }
    }
    assert!(
        wss_frames.contains("tls-upstream-ok:wss-ping"),
        "wss_frames={wss_frames}"
    );
    let _ = wss.close(None).await;

    proxy.shutdown().await;
    upstream.shutdown().await;

    // Verify secrets redacted and both HTTPS + WSS exchanges recorded cleanly
    let raw = std::fs::read_to_string(&cassette_path).unwrap();
    assert!(!raw.contains("tls-secret-token"));
    let exchanges = maka_mock_ai::proxy::load_ndjson(&cassette_path).unwrap();
    assert_eq!(exchanges.len(), 2);
    assert!(
        exchanges
            .iter()
            .all(|e| e.outcome == ExchangeOutcome::Completed)
    );

    // 3. Offline replay verifies recorded TLS traffic replays identically without upstream
    let replayer = MockAiBuilder::new()
        .replay(
            ReplayConfig::new(&cassette_path)
                .with_speed(0.0)
                .with_match_mode(ReplayMatchMode::Fingerprint),
        )
        .unwrap()
        .start()
        .await
        .unwrap();
    let plain_client = reqwest::Client::new();
    let replayed = post_json(
        &plain_client,
        &format!("{}/chat/completions", replayer.base_url()),
        &json!({
            "model": "gpt-5",
            "stream": true,
            "messages": [{"role": "user", "content": "https-ping"}]
        }),
    )
    .await
    .text()
    .await
    .unwrap();
    assert_eq!(replayed, https_body);

    replayer.shutdown().await;
    let _ = std::fs::remove_file(&cassette_path);
}

#[tokio::test]
async fn astra_audit_regressions() {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // 1. Adversarial nested array schema (64^4 = 16M nodes if unbounded) stays fast & bounded
    let nested_schema = json!({
        "type": "array",
        "minItems": 64,
        "items": {
            "type": "array",
            "minItems": 64,
            "items": {
                "type": "array",
                "minItems": 64,
                "items": { "type": "string" }
            }
        }
    });
    let t_synth = Instant::now();
    let mut rng = fastrand::Rng::with_seed(99);
    let strict_err =
        maka_mock_ai::try_synthesize_tool_arguments(&nested_schema, &mut rng, SynthMode::Valid);
    assert!(
        strict_err.is_err(),
        "strict synth must reject schema exceeding node budget"
    );
    let synth = synthesize_tool_arguments(&nested_schema, &mut rng, SynthMode::Valid);
    assert!(
        t_synth.elapsed() < Duration::from_millis(200),
        "nested schema synth took too long: {:?}",
        t_synth.elapsed()
    );
    assert!(synth.to_string().len() < 64 * 1024);

    // 2. Proxy does NOT follow 302 redirects with real Location header (prevents x-api-key leak!)
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let trap_hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trap_addr = trap_listener.local_addr().unwrap();
    let trap_hits_clone = trap_hits.clone();
    let trap_task = tokio::spawn(async move {
        if let Ok((mut s, _)) = trap_listener.accept().await {
            trap_hits_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = [0u8; 512];
            let _ = s.read(&mut buf).await;
            let _ = s
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await;
        }
    });

    let redir_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redir_addr = redir_listener.local_addr().unwrap();
    let location = format!("http://{trap_addr}/steal");
    let location_resp = format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let redir_task = tokio::spawn(async move {
        if let Ok((mut s, _)) = redir_listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s.write_all(location_resp.as_bytes()).await;
        }
    });

    let redir_cassette =
        std::env::temp_dir().join(format!("maka-mock-ai-redir-{}.ndjson", std::process::id()));
    let _ = std::fs::remove_file(&redir_cassette);
    let redir_proxy = MockAiBuilder::new()
        .proxy_record(ProxyRecordConfig::new(
            format!("http://{redir_addr}"),
            &redir_cassette,
        ))
        .unwrap()
        .start()
        .await
        .unwrap();
    let r302 = post_json_headers(
        &client,
        &format!("{}/messages", redir_proxy.base_url()),
        &[("x-api-key", "secret-anthropic-key")],
        &json!({"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "hi"}]}),
    )
    .await;
    assert_eq!(r302.status(), 302);
    assert_eq!(
        r302.headers().get("location").and_then(|v| v.to_str().ok()),
        Some(location.as_str())
    );
    assert_eq!(
        trap_hits.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "proxy must never follow redirects and leak x-api-key"
    );
    redir_proxy.shutdown().await;
    redir_task.abort();
    trap_task.abort();
    let _ = std::fs::remove_file(&redir_cassette);

    // 3. TTFT is recorded on FIRST semantic send, NOT inflated by low TPS post-chunk sleeps
    let tps_srv = MockAiBuilder::new()
        .latency_profile(LatencyProfile {
            base_ttft_ms: 0,
            tokens_per_sec: 40.0,
            ..Default::default()
        })
        .handler_fn(|_, _| {
            TurnPlan::new()
                .push_text_chunked("0123456789abcdef0123456789abcdef01234567", 8)
                .with_usage(Usage::new(20, 12))
        })
        .start()
        .await
        .unwrap();
    let resp = post_json(
        &client,
        &format!("{}/chat/completions", tps_srv.base_url()),
        &json!({"model": "gpt-5", "stream": true, "messages": [{"role": "user", "content": "slow tps"}]}),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await.unwrap();
    let m = tps_srv.metrics();
    assert!(
        m.turn_duration_ms.max >= 100,
        "expected turn duration >= 100ms at 40 TPS, got {:?}",
        m.turn_duration_ms
    );
    assert!(
        m.ttft_ms.max < 80,
        "TTFT must not include post-chunk TPS sleeps, got {:?}",
        m.ttft_ms
    );
    tps_srv.shutdown().await;

    // 4. Interactive HTTP stream holds max_concurrent=1 lease until finished
    let mut inter_srv = MockAiBuilder::new()
        .interactive(4)
        .rate_limit(RateLimitConfig {
            enabled: true,
            scope: RateLimitScope::Global,
            max_concurrent: Some(1),
            ..Default::default()
        })
        .start()
        .await
        .unwrap();
    let inter_url = format!("{}/chat/completions", inter_srv.base_url());
    let c1 = client.clone();
    let u1 = inter_url.clone();
    let req1_task = tokio::spawn(async move {
        let mut r = post_json(
            &c1,
            &u1,
            &json!({"model": "gpt-5", "stream": true, "messages": [{"role": "user", "content": "one"}]}),
        )
        .await;
        assert_eq!(r.status(), 200);
        let _ = r.chunk().await.unwrap();
        let _ = r.text().await.unwrap();
    });
    let h1 = inter_srv.next_turn().await.unwrap();
    assert!(h1.delta("partial-1 ").await);
    // Give HTTP response headers a moment to commit while stream stays open
    tokio::time::sleep(Duration::from_millis(25)).await;
    // Second concurrent request MUST get 429 while interactive turn 1 is still streaming!
    let r2 = post_json(
        &client,
        &inter_url,
        &json!({"model": "gpt-5", "stream": true, "messages": [{"role": "user", "content": "two"}]}),
    )
    .await;
    assert_eq!(
        r2.status(),
        429,
        "interactive stream must hold concurrency lease"
    );
    h1.finish().await;
    req1_task.await.unwrap();
    inter_srv.shutdown().await;

    // 5. Watchdog does NOT record pending tool_call_id if client disconnected during TTFT before tool_call was sent
    let wd_srv = MockAiBuilder::new()
        .latency_profile(LatencyProfile {
            base_ttft_ms: 5_000,
            sse_ping_interval_ms: 20,
            ..Default::default()
        })
        .watchdog(WatchdogConfig {
            enabled: true,
            check_missing_tool_results: true,
            ..Default::default()
        })
        .handler_fn(|_, ctx| {
            if ctx.session_turn == 1 {
                TurnPlan::new().push_tool_call("call_unsent", "Read", json!({"path": "a.rs"}))
            } else {
                TurnPlan::text("clean")
            }
        })
        .start()
        .await
        .unwrap();
    let mut aborted_resp = post_json_headers(
        &client,
        &format!("{}/chat/completions", wd_srv.base_url()),
        &[("x-session-id", "sess-abort-wd")],
        &json!({"model": "gpt-5", "stream": true, "messages": [{"role": "user", "content": "t1"}]}),
    )
    .await;
    let _ = aborted_resp.chunk().await.unwrap(); // receives ping
    drop(aborted_resp);
    tokio::time::sleep(Duration::from_millis(40)).await;
    wd_srv.set_runtime_profile(Some(RuntimeProfile::default()));
    let ok_resp = post_json_headers(
        &client,
        &format!("{}/chat/completions", wd_srv.base_url()),
        &[("x-session-id", "sess-abort-wd")],
        &json!({"model": "gpt-5", "stream": false, "messages": [{"role": "user", "content": "t2"}]}),
    )
    .await;
    assert_eq!(ok_resp.status(), 200);
    let viols = wd_srv.watchdog_snapshot();
    assert!(
        !viols
            .by_kind
            .contains_key(&maka_mock_ai::ViolationKind::MissingToolResult),
        "must not flag MissingToolResult for unsent tool call: {viols:?}"
    );
    wd_srv.shutdown().await;

    // 6. Multi-turn Responses HTTP cassette replays turn 2 with previous_response_id cleanly under strict mode
    let chain_up = MockAiBuilder::new()
        .handler_fn(|_, ctx| {
            TurnPlan::text(format!("chain-reply-{}", ctx.session_turn))
                .with_response_id(format!("resp_chain_{}", ctx.session_turn))
        })
        .start()
        .await
        .unwrap();
    let chain_cassette =
        std::env::temp_dir().join(format!("maka-mock-ai-chain-{}.ndjson", std::process::id()));
    let _ = std::fs::remove_file(&chain_cassette);
    let chain_proxy = MockAiBuilder::new()
        .proxy_record(ProxyRecordConfig::new(
            chain_up.origin_url(),
            &chain_cassette,
        ))
        .unwrap()
        .start()
        .await
        .unwrap();
    let p1 = post_json(
        &client,
        &format!("{}/responses", chain_proxy.base_url()),
        &json!({"model": "gpt-5", "stream": false, "store": true, "input": "turn1"}),
    )
    .await;
    assert_eq!(p1.status(), 200);
    let p1_json = parse_json(p1).await;
    let prev_id = p1_json["id"].as_str().unwrap().to_string();
    let proxied_parent = format!("{}/responses/{prev_id}", chain_proxy.base_url());
    assert_eq!(
        benchmark_json(client.get(&proxied_parent), 200).await,
        p1_json
    );
    let p2 = post_json(
        &client,
        &format!("{}/responses", chain_proxy.base_url()),
        &json!({"model": "gpt-5", "stream": false, "store": true, "previous_response_id": prev_id, "input": "turn2"}),
    )
    .await;
    assert_eq!(p2.status(), 200);
    let p2_text = p2.text().await.unwrap();
    let deleted = benchmark_json(client.delete(&proxied_parent), 200).await;
    assert_eq!(deleted["deleted"], true);
    chain_proxy.shutdown().await;
    chain_up.shutdown().await;

    for strict in [false, true] {
        let mut replay = ReplayConfig::new(&chain_cassette)
            .with_speed(0.0)
            .with_match_mode(ReplayMatchMode::Sequential);
        replay.strict_replay = strict;
        let chain_replayer = MockAiBuilder::new()
            .replay(replay)
            .unwrap()
            .start()
            .await
            .unwrap();
        let url = format!("{}/responses", chain_replayer.base_url());
        let replayed_parent = format!("{url}/{prev_id}");
        let rp1 = benchmark_json(
            json_request(
                &client,
                &url,
                &json!({"model": "gpt-5", "stream": false, "store": true, "input": "turn1"}),
            ),
            200,
        )
        .await;
        assert_eq!(rp1, p1_json);
        assert_eq!(
            benchmark_json(client.get(&replayed_parent), 200).await,
            p1_json
        );
        let rp_bad = post_json(
            &client,
            &url,
            &json!({"model": "gpt-5", "stream": false, "store": true, "previous_response_id": "resp_wrong_id", "input": "turn2"}),
        ).await;
        assert_eq!(rp_bad.status(), if strict { 422 } else { 400 });
        let rp2 = post_json(
            &client,
            &url,
            &json!({"model": "gpt-5", "stream": false, "store": true, "previous_response_id": prev_id, "input": "turn2"}),
        ).await;
        assert_eq!(rp2.status(), 200);
        assert_eq!(rp2.text().await.unwrap(), p2_text);
        assert_eq!(
            benchmark_json(client.delete(&replayed_parent), 200).await,
            deleted
        );
        assert_eq!(chain_replayer.metrics().replay_hits, 4);
        chain_replayer.shutdown().await;
    }
    let _ = std::fs::remove_file(&chain_cassette);
}
