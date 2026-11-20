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
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, HttpErrorSpec, LatencyProfile, MidStreamErrorSpec,
    MockAiBuilder, ModelEntry, NormalizedRequest, Protocol, RateLimitConfig, RateLimitScope,
    RecorderMode, ToolCallSpec, TurnContext, TurnEvent, TurnPlan, Usage, WatchdogConfig,
    WirePoisonConfig,
};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

pub(super) fn sample_rss_kib(pid: u32) -> Option<u64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

pub(super) async fn seed_workspace_files(workspace: &std::path::Path) {
    for i in 0..5 {
        let mut content = format!("# Synthetic workspace fixture {i}\n");
        for line in 0..40 {
            content.push_str(&format!(
                "line_{line:02}: maka real-host stress fixture payload 中文测试🚀 block={i}\n"
            ));
        }
        tokio::fs::write(workspace.join(format!("fixture_{i}.txt")), content)
            .await
            .unwrap();
    }
}

pub(super) async fn seed_connections(
    root: &std::path::Path,
    base_url: &str,
) -> (String, String, String) {
    let root_owned = root.to_path_buf();
    let owner = tokio::task::spawn_blocking(move || {
        maka_event_log::root::RootOwner::create(
            &root_owned,
            &maka_event_log::root::RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap()
    })
    .await
    .unwrap();
    let store = maka_config::ConfigurationStore::for_root(Arc::new(owner))
        .await
        .unwrap();

    let mut rev = 0u64;
    let create_conn = |slug: &str, provider: &str, model: &str, overrides: Value, r: u64| {
        json!({
            "expectedCatalogRevision": r,
            "connection": {
                "slug": slug,
                "name": format!("Stress {slug}"),
                "provider": {
                    "packageId": "maka.providers",
                    "entryId": "maka.providers",
                    "scope": "profile",
                    "name": provider
                },
                "configuration": { "baseUrl": base_url },
                "enabled": true,
                "enabledModelIds": [model],
                "modelOverrides": { (model): overrides }
            }
        })
    };

    let mut ids = Vec::new();
    let specs = [
        (
            "stress-responses",
            "openai",
            "gpt-4.1",
            json!({ "codeMode": false, "apiProtocol": "openai-responses", "contextWindow": 128_000, "inputLimit": 128_000 }),
        ),
        (
            "stress-anthropic",
            "anthropic",
            "claude-sonnet-4-5",
            json!({ "codeMode": false, "apiProtocol": "anthropic-messages", "contextWindow": 128_000, "inputLimit": 128_000 }),
        ),
        (
            "stress-chat",
            "openai-compatible",
            "gpt-4.1-mini",
            json!({ "codeMode": false, "apiProtocol": "openai-chat-completions", "contextWindow": 24_000, "inputLimit": 24_000 }),
        ),
    ];

    for (slug, provider, model, overrides) in specs {
        let created = store
            .create_connection(
                serde_json::from_value(create_conn(slug, provider, model, overrides, rev)).unwrap(),
            )
            .await
            .unwrap();
        let maka_agent_facts::configuration::CatalogMutationResult::Committed {
            connection: Some(conn),
            catalog_revision,
            ..
        } = created
        else {
            panic!("failed to create connection {slug}: {created:?}");
        };
        rev = catalog_revision;
        ids.push(conn.connection_id);
    }

    store.shutdown().await.unwrap();
    (ids[0].clone(), ids[1].clone(), ids[2].clone())
}

pub(super) async fn save_credential(client: &Client, connection_id: &str) {
    let detail = call(
        client,
        "settings",
        "connection",
        json!({ "connectionId": connection_id }),
        Attachments::new(),
    )
    .await;
    let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
    let saved = call(
        client,
        "settings",
        "saveCredential",
        json!({ "expected": detail["target"], "expectedCredential": null }),
        Attachments::from([("secret".into(), secret)]),
    )
    .await;
    assert_eq!(saved["kind"], "saved", "{saved}");
}

pub(super) async fn wait_run_terminal(
    client: &Client,
    session: &str,
    message_id: &str,
    timeout: Duration,
) -> Value {
    tokio::time::timeout(timeout, async {
        loop {
            let w = call(
                client,
                "agent",
                "work",
                json!({ "sessionId": session, "target": { "kind": "message", "messageId": message_id } }),
                Attachments::new(),
            )
            .await;
            if w["kind"] == "delivered" {
                let state = w["execution"]["state"]["kind"].as_str().unwrap_or("");
                if !matches!(state, "admitted" | "running" | "waiting") {
                    return w;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for session={session} msg={message_id}"))
}

/// Scenario A: 24 concurrent real Maka Host sessions across OpenAI Responses WS, Anthropic SSE,
/// and Chat Completions SSE with real tool execution (Read + Shell), wire-poisoned UTF-8/CRLF SSE,
/// physics TTFT/TPS + congestion knee, stateful max_concurrent=16 rate-limiting, and chaos faults.
#[tokio::test]
#[ignore = "live real-Host high-concurrency stress test; run with -- --ignored --nocapture"]
async fn real_host_high_concurrency_mixed_protocols_with_chaos() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;

    let chaos_429_injected = Arc::new(AtomicU64::new(0));
    let chaos_503_injected = Arc::new(AtomicU64::new(0));
    let chaos_mid_injected = Arc::new(AtomicU64::new(0));
    let bad_tool_injected = Arc::new(AtomicU64::new(0));
    let step_counters: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    let server = {
        let c429 = chaos_429_injected.clone();
        let c503 = chaos_503_injected.clone();
        let cmid = chaos_mid_injected.clone();
        let cbad = bad_tool_injected.clone();
        let steps = step_counters.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .control(ControlPlaneConfig {
                enable_admin_api: true,
                models: vec![
                    ModelEntry::simple("gpt-4.1"),
                    ModelEntry::simple("claude-sonnet-4-5"),
                    ModelEntry::simple("gpt-4.1-mini"),
                ],
                ..Default::default()
            })
            .latency_profile(LatencyProfile {
                base_ttft_ms: 12,
                ttft_jitter_cv: 0.35,
                concurrency_knee: 12,
                ttft_congestion_factor: 1.2,
                tps_congestion_factor: 0.4,
                tokens_per_sec: 1200.0,
                tps_jitter_cv: 0.2,
                micro_stall_prob: 0.02,
                micro_stall_ms_range: (15, 50),
                ..Default::default()
            })
            .rate_limit(RateLimitConfig {
                enabled: true,
                scope: RateLimitScope::Global,
                max_concurrent: Some(16),
                rpm: Some(6000),
                ..Default::default()
            })
            .watchdog(WatchdogConfig {
                enabled: true,
                max_session_prompt_bytes: Some(4 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, ctx: &TurnContext| {
                let mut h = req
                    .sequence
                    .wrapping_mul(0x9E37_79B9_7F4A_7C15)
                    ^ ctx.session_turn.wrapping_mul(0xBF58_476D_1CE4_E5B9);
                h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                h = (h ^ (h >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                h ^= h >> 31;
                let roll = ((h & 0xFFFF) as f64) / 65536.0;
                let roll2 = (((h >> 16) & 0xFFFF) as f64) / 65536.0;
                let poison = WirePoisonConfig {
                    split_utf8_boundaries: req.protocol != Protocol::OpenaiResponsesWs,
                    crlf_line_endings: req.protocol != Protocol::OpenaiResponsesWs,
                    inject_sse_comments: req.protocol != Protocol::OpenaiResponsesWs,
                };
                if ctx.session_turn > 1 && roll < 0.03 {
                    c429.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::http_error(
                        HttpErrorSpec::rate_limit(None, "stress synthetic 429")
                            .with_retry_after_ms(40),
                    );
                }
                if ctx.session_turn > 1 && roll < 0.05 {
                    c503.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::http_error(HttpErrorSpec::new(
                        503,
                        "overloaded_error",
                        "stress synthetic 503",
                    ));
                }
                if ctx.session_turn > 1 && roll < 0.07 {
                    cmid.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("partial before retryable mid-stream fault ")
                        .push(TurnEvent::MidStreamError(MidStreamErrorSpec {
                            error_type: "server_error".into(),
                            code: Some("stream_interrupted".into()),
                            message: "stress synthetic mid-stream fault".into(),
                            retryable: Some(true),
                        }));
                }

                // Derive logical session id from user message tag STRESS_SESS_XX
                let all = req.all_text();
                let logical_key = all
                    .split_whitespace()
                    .find(|w| w.starts_with("STRESS_SESS_"))
                    .unwrap_or(&req.session_key)
                    .to_string();
                let step = {
                    let mut map = steps.lock().unwrap();
                    let e = map.entry(logical_key.clone()).or_insert(0);
                    *e += 1;
                    *e
                };

                if req.tools.is_empty() {
                    return TurnPlan::text("Concise stress summary checkpoint.")
                        .with_usage(Usage::new(req.estimated_input_tokens.max(50), 20))
                        .with_wire_poison(poison);
                }

                let usage = Usage::new(req.estimated_input_tokens.max(80), 48).with_cache_read(
                    if step > 1 {
                        req.estimated_input_tokens / 2
                    } else {
                        0
                    },
                );

                match step {
                    1 => {
                        let fidx = (req.sequence as usize) % 5;
                        let c1 = ToolCallSpec::new(
                            format!("call_{}_s1_a", req.sequence),
                            "Read",
                            json!({ "path": format!("fixture_{fidx}.txt"), "offset": 0, "limit": 15 }),
                        )
                        .with_chunk_chars(12);
                        let c2 = ToolCallSpec::new(
                            format!("call_{}_s1_b", req.sequence),
                            "Shell",
                            json!({ "command": format!("echo ok-{logical_key}-s1"), "login": false }),
                        )
                        .with_chunk_chars(12);
                        TurnPlan::new()
                            .push_reasoning(
                                "Checking workspace fixture and running quick shell check.",
                            )
                            .push(TurnEvent::ToolCall(c1))
                            .push(TurnEvent::ToolCall(c2))
                            .with_usage(usage)
                            .with_wire_poison(poison)
                            .finish(FinishReason::ToolCalls)
                    }
                    2 => {
                        if roll2 < 0.25 {
                            cbad.fetch_add(1, Ordering::Relaxed);
                            let bad = ToolCallSpec::new(
                                format!("call_{}_s2_bad", req.sequence),
                                "Read",
                                json!({ "offset": "not_an_integer" }),
                            );
                            TurnPlan::new()
                                .push(TurnEvent::ToolCall(bad))
                                .with_usage(usage)
                                .with_wire_poison(poison)
                                .finish(FinishReason::ToolCalls)
                        } else {
                            let c = ToolCallSpec::new(
                                format!("call_{}_s2_ok", req.sequence),
                                "Shell",
                                json!({ "command": format!("wc -l fixture_0.txt && echo done-{logical_key}"), "login": false }),
                            )
                            .with_chunk_chars(14);
                            TurnPlan::new()
                                .push(TurnEvent::ToolCall(c))
                                .with_usage(usage)
                                .with_wire_poison(poison)
                                .finish(FinishReason::ToolCalls)
                        }
                    }
                    3 => {
                        let c = ToolCallSpec::new(
                            format!("call_{}_s3", req.sequence),
                            "Read",
                            json!({ "path": "fixture_1.txt", "offset": 5, "limit": 10 }),
                        );
                        TurnPlan::new()
                            .push(TurnEvent::ToolCall(c))
                            .with_usage(usage)
                            .with_wire_poison(poison)
                            .finish(FinishReason::ToolCalls)
                    }
                    _ => TurnPlan::new()
                        .push_reasoning("Synthesizing final verified result across tool outputs.")
                        .push_text_chunked(
                            format!(
                                "完成压测会话 {logical_key} 🚀 (protocol={:?}, steps={step})",
                                req.protocol
                            ),
                            11,
                        )
                        .with_usage(usage)
                        .with_wire_poison(poison)
                        .finish(FinishReason::Stop),
                }
            })
            .start()
            .await
            .unwrap()
    };

    let (conn_ws, conn_ant, conn_chat) = seed_connections(&sandbox.root, &server.base_url()).await;
    let mut host = Host::spawn(&sandbox).unwrap();
    let host_pid = host.pid().expect("host pid");
    let (mut client, socket_path) = host.ready().await.unwrap();
    let rss_before = sample_rss_kib(host_pid).unwrap_or(0);

    save_credential(&client, &conn_ws).await;
    save_credential(&client, &conn_ant).await;
    save_credential(&client, &conn_chat).await;

    const SESSIONS: usize = 24;
    let mut session_specs = Vec::with_capacity(SESSIONS);
    for i in 0..SESSIONS {
        let (conn, model, label) = match i % 3 {
            0 => (&conn_ws, "gpt-4.1", "responses-ws"),
            1 => (&conn_ant, "claude-sonnet-4-5", "anthropic-sse"),
            _ => (&conn_chat, "gpt-4.1-mini", "chat-sse"),
        };
        let created = call(
            &client,
            "agent",
            "create",
            json!({
                "title": format!("Stress-{label}-{i}"),
                "automaticTitle": false,
                "labels": [],
                "tools": ["Read", "Shell"],
                "workspace": { "kind": "directory", "path": sandbox.workspace },
                "backend": { "kind": "model", "connectionId": conn, "modelId": model, "thinkingLevel": null }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(created["kind"], "created", "{created}");
        let sid = created["session"]["id"].as_str().unwrap().to_string();
        session_specs.push((i, sid, label));
    }

    let started = Instant::now();
    let mut tasks = JoinSet::new();
    let peak_rss = Arc::new(AtomicU64::new(rss_before));
    let peak_rss_sampler = peak_rss.clone();
    let sampler_stop = CancellationToken::new();
    let sampler_token = sampler_stop.clone();
    let rss_task = tokio::spawn(async move {
        while !sampler_token.is_cancelled() {
            if let Some(rss) = sample_rss_kib(host_pid) {
                peak_rss_sampler.fetch_max(rss, Ordering::Relaxed);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    for (idx, sid, label) in session_specs {
        let sock = socket_path.clone();
        tasks.spawn(async move {
            let cli = Client::connect(&sock, None).await.unwrap();
            let t0 = Instant::now();
            let sent = call(
                &cli,
                "agent",
                "send",
                json!({
                    "sessionId": sid,
                    "message": format!("STRESS_SESS_{idx:02} Execute multi-tool workflow on {label}."),
                    "delivery": "queue"
                }),
                Attachments::new(),
            )
            .await;
            assert!(
                matches!(sent["kind"].as_str(), Some("started" | "queued")),
                "send failed for {sid}: {sent}"
            );
            let msg_id = sent["messageId"].as_str().unwrap().to_string();
            let terminal = wait_run_terminal(&cli, &sid, &msg_id, Duration::from_secs(120)).await;
            let state = terminal["execution"]["state"]["kind"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            (idx, label, sid, state, t0.elapsed(), terminal)
        });
    }

    let mut completed = 0usize;
    let mut non_completed = Vec::new();
    let mut max_session_ms = 0u128;
    while let Some(res) = tasks.join_next().await {
        let (idx, label, sid, state, elapsed, terminal) = res.unwrap();
        max_session_ms = max_session_ms.max(elapsed.as_millis());
        if state == "completed" {
            completed += 1;
        } else {
            non_completed.push((idx, label, sid, state, terminal));
        }
    }

    sampler_stop.cancel();
    let _ = rss_task.await;
    let wall = started.elapsed();
    let rss_after = sample_rss_kib(host_pid).unwrap_or(0);
    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();

    eprintln!("================ REAL MAKA HOST CONCURRENCY STRESS REPORT ================");
    eprintln!(
        "Sessions: {completed}/{SESSIONS} completed in {:.2}s (max_session={max_session_ms}ms)",
        wall.as_secs_f64()
    );
    eprintln!(
        "Host RSS: before={:.1}MiB peak={:.1}MiB after={:.1}MiB",
        rss_before as f64 / 1024.0,
        peak_rss.load(Ordering::Relaxed) as f64 / 1024.0,
        rss_after as f64 / 1024.0
    );
    eprintln!(
        "Model turns: total={} (ws={}, anthropic={}, chat={}) ws_upgrades={}",
        metrics.total_requests,
        metrics.responses_ws_turns,
        metrics.anthropic_requests,
        metrics.chat_completions_requests,
        metrics.ws_upgrades
    );
    eprintln!(
        "Faults/Backpressure: rate_limits={} (chaos_429={}, chaos_503={}, chaos_mid={}, bad_tools={})",
        metrics.rate_limits_emitted,
        chaos_429_injected.load(Ordering::Relaxed),
        chaos_503_injected.load(Ordering::Relaxed),
        chaos_mid_injected.load(Ordering::Relaxed),
        bad_tool_injected.load(Ordering::Relaxed)
    );
    eprintln!(
        "TTFT ms: p50={} p95={} p99={} max={} | Turn ms: p50={} p95={} p99={} max={}",
        metrics.ttft_ms.p50,
        metrics.ttft_ms.p95,
        metrics.ttft_ms.p99,
        metrics.ttft_ms.max,
        metrics.turn_duration_ms.p50,
        metrics.turn_duration_ms.p95,
        metrics.turn_duration_ms.p99,
        metrics.turn_duration_ms.max
    );
    eprintln!(
        "Watchdog violations: total={} by_kind={:?}",
        watchdog.total_violations, watchdog.by_kind
    );
    for v in watchdog.recent.iter().take(10) {
        eprintln!(
            "  VIOLATION [{:?}] proto={:?} sess={} detail={}",
            v.kind, v.protocol, v.session_key, v.detail
        );
    }
    for (idx, label, sid, state, terminal) in &non_completed {
        eprintln!("  FAILED SESSION #{idx} ({label}, {sid}): state={state} terminal={terminal}");
    }
    eprintln!("==========================================================================");

    let _ = host.quit(&mut client).await;
    server.shutdown().await;

    assert!(
        non_completed.is_empty(),
        "some real Maka Host sessions failed under concurrent load: {non_completed:?}"
    );
    assert_eq!(completed, SESSIONS);
}

/// Scenario B: Ultra-long real Maka Host sessions —
/// 1) 18 consecutive multi-tool user turns on a 24k context-window Chat Completions session triggering
///    multiple real client-side compactions;
/// 2) 15 consecutive multi-tool user turns on an OpenAI Responses WebSocket session verifying
///    connection reuse and strict single-baseline previous_response_id continuity.
#[tokio::test]
#[ignore = "live real-Host ultra-long-session + compaction stress test; run with -- --ignored --nocapture"]
async fn real_host_ultra_long_session_and_compaction_stress() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;

    let compaction_summaries = Arc::new(AtomicU64::new(0));
    let chat_prompt_bytes_log: Arc<Mutex<Vec<(u64, usize)>>> = Arc::new(Mutex::new(Vec::new()));
    let chat_turn_step: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
    let ws_turn_step: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

    let server = {
        let comp_cnt = compaction_summaries.clone();
        let prompt_log = chat_prompt_bytes_log.clone();
        let chat_step = chat_turn_step.clone();
        let ws_step = ws_turn_step.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .control(ControlPlaneConfig {
                enable_admin_api: true,
                models: vec![
                    ModelEntry::simple("gpt-4.1"),
                    ModelEntry::simple("claude-sonnet-4-5"),
                    ModelEntry::simple("gpt-4.1-mini"),
                ],
                ..Default::default()
            })
            .watchdog(WatchdogConfig {
                enabled: true,
                max_session_prompt_bytes: Some(2 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
                let all = req.all_text();
                if all.contains("STRESS_COMPACTION_MARKER") {
                    comp_cnt.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text(
                            "Compacted checkpoint: retained verified workspace state and recent tool findings.",
                        )
                        .with_usage(Usage::new(1200, 80))
                        .finish(FinishReason::Stop);
                }

                if req.protocol == Protocol::OpenaiChatCompletions {
                    let s = chat_step.fetch_add(1, Ordering::Relaxed) + 1;
                    prompt_log.lock().unwrap().push((s, req.prompt_bytes));
                    let reported_in = ((req.prompt_bytes as u64) / 2).clamp(2000, 23_000);
                    let usage = Usage::new(reported_in, 120);
                    if s.is_multiple_of(2) {
                        TurnPlan::new()
                            .push_text_chunked(
                                format!(
                                    "Long-session answer at model_call={s} (prompt_bytes={}). {}",
                                    req.prompt_bytes,
                                    "detail-payload ".repeat(24)
                                ),
                                32,
                            )
                            .with_usage(usage)
                            .finish(FinishReason::Stop)
                    } else {
                        let cmd = format!(
                            "head -c 1200 fixture_0.txt && echo '' && echo TOOL_LOG_STEP_{s}"
                        );
                        TurnPlan::new()
                            .push_tool_call(
                                format!("call_long_{s}"),
                                "Shell",
                                json!({ "command": cmd, "login": false }),
                            )
                            .with_usage(usage)
                            .finish(FinishReason::ToolCalls)
                    }
                } else {
                    let s = ws_step.fetch_add(1, Ordering::Relaxed) + 1;
                    let usage = Usage::new(req.estimated_input_tokens.max(100), 60).with_cache_read(
                        if s > 1 {
                            req.estimated_input_tokens / 2
                        } else {
                            0
                        },
                    );
                    if s.is_multiple_of(2) {
                        TurnPlan::new()
                            .with_response_id(format!("resp_long_ws_{s}"))
                            .push_text_chunked(format!("WS long answer step={s}"), 16)
                            .with_usage(usage)
                            .finish(FinishReason::Stop)
                    } else {
                        let fidx = (s as usize) % 5;
                        TurnPlan::new()
                            .with_response_id(format!("resp_long_ws_{s}"))
                            .push_tool_call(
                                format!("call_ws_{s}"),
                                "Read",
                                json!({ "path": format!("fixture_{fidx}.txt"), "offset": 0, "limit": 10 }),
                            )
                            .with_usage(usage)
                            .finish(FinishReason::ToolCalls)
                    }
                }
            })
            .start()
            .await
            .unwrap()
    };

    let (conn_ws, _conn_ant, conn_chat) = seed_connections(&sandbox.root, &server.base_url()).await;
    let mut host = Host::spawn(&sandbox).unwrap();
    let host_pid = host.pid().expect("host pid");
    let (mut client, _socket_path) = host.ready().await.unwrap();
    let rss_start = sample_rss_kib(host_pid).unwrap_or(0);

    save_credential(&client, &conn_ws).await;
    save_credential(&client, &conn_chat).await;

    // --- Part 1: 18 consecutive multi-tool user turns on Chat Completions with real compaction ---
    let created = call(
        &client,
        "agent",
        "create",
        json!({
            "title": "Ultra-Long Compaction Session",
            "automaticTitle": false,
            "labels": [],
            "tools": ["Shell", "Read"],
            "workspace": { "kind": "directory", "path": sandbox.workspace },
            "backend": { "kind": "model", "connectionId": conn_chat, "modelId": "gpt-4.1-mini", "thinkingLevel": null }
        }),
        Attachments::new(),
    )
    .await;
    let long_sid = created["session"]["id"].as_str().unwrap().to_string();

    let cp_meta = call(
        &client,
        "agent",
        "compactionPrompt",
        json!({ "sessionId": long_sid }),
        Attachments::new(),
    )
    .await;
    let cp_set = call(
        &client,
        "agent",
        "setCompactionPrompt",
        json!({
            "sessionId": long_sid,
            "expectedRevision": cp_meta["revision"],
            "prompt": "STRESS_COMPACTION_MARKER Summarize history concisely."
        }),
        Attachments::new(),
    )
    .await;
    assert_eq!(cp_set["kind"], "committed", "{cp_set}");

    let mut chat_turn_latencies_ms = Vec::new();
    for u in 1..=18 {
        let t0 = Instant::now();
        let sent = call(
            &client,
            "agent",
            "send",
            json!({
                "sessionId": long_sid,
                "message": format!("User turn #{u}: inspect step {u} and log structured findings. {}", "context-padding ".repeat(30)),
                "delivery": "queue"
            }),
            Attachments::new(),
        )
        .await;
        assert!(
            matches!(sent["kind"].as_str(), Some("started" | "queued")),
            "{sent}"
        );
        let msg_id = sent["messageId"].as_str().unwrap().to_string();
        let term = wait_run_terminal(&client, &long_sid, &msg_id, Duration::from_secs(60)).await;
        assert_eq!(
            term["execution"]["state"]["kind"], "completed",
            "long chat turn #{u} failed: {term}"
        );
        chat_turn_latencies_ms.push(t0.elapsed().as_millis());
    }

    // --- Part 2: 15 consecutive multi-tool user turns on OpenAI Responses WebSocket ---
    let created_ws = call(
        &client,
        "agent",
        "create",
        json!({
            "title": "Ultra-Long Responses WS Session",
            "automaticTitle": false,
            "labels": [],
            "tools": ["Read", "Shell"],
            "workspace": { "kind": "directory", "path": sandbox.workspace },
            "backend": { "kind": "model", "connectionId": conn_ws, "modelId": "gpt-4.1", "thinkingLevel": null }
        }),
        Attachments::new(),
    )
    .await;
    let ws_sid = created_ws["session"]["id"].as_str().unwrap().to_string();
    let mut ws_turn_latencies_ms = Vec::new();
    for u in 1..=15 {
        let t0 = Instant::now();
        let sent = call(
            &client,
            "agent",
            "send",
            json!({
                "sessionId": ws_sid,
                "message": format!("WS turn #{u}: check fixture and respond."),
                "delivery": "queue"
            }),
            Attachments::new(),
        )
        .await;
        assert!(
            matches!(sent["kind"].as_str(), Some("started" | "queued")),
            "{sent}"
        );
        let msg_id = sent["messageId"].as_str().unwrap().to_string();
        let term = wait_run_terminal(&client, &ws_sid, &msg_id, Duration::from_secs(60)).await;
        assert_eq!(
            term["execution"]["state"]["kind"], "completed",
            "long ws turn #{u} failed: {term}"
        );
        ws_turn_latencies_ms.push(t0.elapsed().as_millis());
    }

    let rss_end = sample_rss_kib(host_pid).unwrap_or(0);
    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();
    let compactions = compaction_summaries.load(Ordering::Relaxed);
    let prompt_traj = chat_prompt_bytes_log.lock().unwrap().clone();
    let max_prompt_bytes = prompt_traj.iter().map(|(_, b)| *b).max().unwrap_or(0);
    let final_prompt_bytes = prompt_traj.last().map(|(_, b)| *b).unwrap_or(0);

    eprintln!("================ REAL MAKA HOST LONG-SESSION STRESS REPORT ================");
    eprintln!(
        "Host RSS: start={:.1}MiB end={:.1}MiB (delta={:+.1}MiB)",
        rss_start as f64 / 1024.0,
        rss_end as f64 / 1024.0,
        (rss_end as f64 - rss_start as f64) / 1024.0
    );
    eprintln!(
        "Chat long session (18 user turns): compactions_fired={compactions} max_prompt_bytes={max_prompt_bytes} final_prompt_bytes={final_prompt_bytes}"
    );
    eprintln!("Chat prompt trajectory: {prompt_traj:?}");
    eprintln!("Chat turn latencies (ms): {chat_turn_latencies_ms:?}");
    eprintln!(
        "WS long session (15 user turns): ws_turns={} ws_upgrades={}",
        metrics.responses_ws_turns, metrics.ws_upgrades
    );
    eprintln!("WS turn latencies (ms): {ws_turn_latencies_ms:?}");
    eprintln!(
        "Watchdog violations: total={} by_kind={:?}",
        watchdog.total_violations, watchdog.by_kind
    );
    for v in watchdog.recent.iter().take(10) {
        eprintln!(
            "  VIOLATION [{:?}] proto={:?} sess={} detail={}",
            v.kind, v.protocol, v.session_key, v.detail
        );
    }
    eprintln!("===========================================================================");

    let _ = host.quit(&mut client).await;
    server.shutdown().await;

    assert!(
        compactions >= 1,
        "expected real client-side compaction to fire at least once during 18-turn 24k-window session"
    );
    // ResponsesLane scopes one WS connection per user Run (15 runs x 2 model turns = 30 turns over 15 sockets).
    assert_eq!(
        metrics.ws_upgrades, 15,
        "expected 1 WS connection per Run reused across both tool+answer steps (ws_turns={})",
        metrics.responses_ws_turns
    );
    assert_eq!(
        watchdog.total_violations, 0,
        "unexpected protocol invariant violations during long session: {watchdog:?}"
    );
}
