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

use super::host_load_stress::{
    sample_rss_kib, save_credential, seed_connections, seed_workspace_files, wait_run_terminal,
};
use super::*;
use maka_mock_ai::{
    ChaosConfig, ControlPlaneConfig, FinishReason, HttpErrorSpec, LatencyProfile, MockAiBuilder,
    ModelEntry, NormalizedRequest, RateLimitConfig, RateLimitScope, RecorderMode, RuntimeProfile,
    ScenarioPhase, ScenarioSchedule, TurnContext, TurnEvent, TurnPlan, Usage, WatchdogConfig,
    context_overflow_error,
};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

fn sample_open_fds(pid: u32) -> Option<usize> {
    let output = std::process::Command::new("lsof")
        .args(["-n", "-P", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let lines = String::from_utf8_lossy(&output.stdout).lines().count();
    Some(lines.saturating_sub(1))
}

fn dir_size_kib(path: &std::path::Path) -> u64 {
    let output = std::process::Command::new("du")
        .args(["-sk", &path.to_string_lossy()])
        .output();
    output
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())
        })
        .unwrap_or(0)
}

fn sample_child_procs(pid: u32) -> usize {
    let Ok(out) = std::process::Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
    else {
        return 0;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count()
}

async fn seed_codemode_connection(
    root: &std::path::Path,
    base_url: &str,
    language: &str,
) -> String {
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
    let created = store
        .create_connection(
            serde_json::from_value(json!({
                "expectedCatalogRevision": 0,
                "connection": {
                    "slug": "stress-codemode",
                    "name": "Stress Code Mode",
                    "provider": {
                        "packageId": "maka.providers",
                        "entryId": "maka.providers",
                        "scope": "profile",
                        "name": "openai-compatible"
                    },
                    "configuration": { "baseUrl": base_url },
                    "enabled": true,
                    "enabledModelIds": ["gpt-4.1"],
                    "modelOverrides": {
                        "gpt-4.1": {
                            "codeMode": true,
                            "codeModeLanguage": language,
                            "apiProtocol": "openai-chat-completions",
                            "contextWindow": 128_000,
                            "inputLimit": 128_000
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    store.shutdown().await.unwrap();
    let maka_agent_facts::configuration::CatalogMutationResult::Committed {
        connection: Some(conn),
        ..
    } = created
    else {
        panic!("failed to create codemode connection: {created:?}");
    };
    conn.connection_id
}

/// Scenario C: Code Mode (real V8 isolates) + Subagent Fan-Out Storm!
/// 10 concurrent parent sessions EACH run V8 Code Mode scripts that invoke tools.Read/tools.Shell
/// AND delegate to 2 real child subagent sessions (20 children, each ALSO running V8 Code Mode scripts!)
/// = 30 simultaneous real Maka sessions + 60+ V8 isolate executions against ONE real Maka Host!
#[tokio::test]
#[ignore = "live real-Host Code Mode V8 + subagent fan-out storm; run with -- --ignored --nocapture"]
async fn real_host_codemode_v8_and_subagent_fanout_storm() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;
    let workspace_str = sandbox.workspace.to_string_lossy().to_string();

    let children_completed = Arc::new(AtomicU64::new(0));
    let parents_completed = Arc::new(AtomicU64::new(0));

    let server = {
        let ws_path = workspace_str.clone();
        let child_done = children_completed.clone();
        let parent_done = parents_completed.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .control(ControlPlaneConfig {
                enable_admin_api: true,
                models: vec![ModelEntry::simple("gpt-4.1")],
                ..Default::default()
            })
            .latency_profile(LatencyProfile {
                base_ttft_ms: 8,
                ttft_jitter_cv: 0.25,
                tokens_per_sec: 2000.0,
                ..Default::default()
            })
            .watchdog(WatchdogConfig {
                enabled: true,
                max_session_prompt_bytes: Some(4 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
                let all = req.all_text();
                let usage = Usage::new(req.estimated_input_tokens.max(120), 64);

                if all.contains("SUBAGENT_TASK_") && !all.contains("PARENT_FANOUT_") {
                    if all.contains("CHILD_V8_STEP_DONE") {
                        child_done.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text("CHILD_OK_VERIFIED")
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    let fidx = (req.sequence as usize) % 5;
                    let child_code = format!(
                        r#"
                        const r = await tools.Read({{ path: "fixture_{fidx}.txt", offset: 0, limit: 12 }});
                        const s = await tools.Shell({{ command: "echo child-v8-ok", login: false }});
                        text("CHILD_V8_STEP_DONE:" + r.kind + ":" + s.kind);
                        "#
                    );
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_child_v8_{}", req.sequence),
                            "exec",
                            json!({ "code": child_code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                if all.contains("FANOUT_ALL_CHILDREN_DONE") {
                    parent_done.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("PARENT_FANOUT_COMPLETE 🚀")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                if let Some(pos) = all.find("FANOUT_TIMEOUT:") {
                    let snippet: String = all[pos..].chars().take(320).collect();
                    eprintln!("[SCEN C] parent script hit seq={} {snippet}", req.sequence);
                    return TurnPlan::new()
                        .push_text("PARENT_FANOUT_TIMEOUT")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                // Log unexpected tool results if the parent is called more than once (e.g. V8 error or running yield).
                if req.messages.len() > 2 {
                    let tail: String = all.chars().rev().take(400).collect::<String>().chars().rev().collect();
                    eprintln!("[SCEN C] repeated parent req seq={} msgs={} tail={tail:?}", req.sequence, req.messages.len());
                    if let Some(pos) = all.rfind("\"cell_id\":\"") {
                        let rest = &all[pos + 11..];
                        if let Some(end) = rest.find('"') {
                            let cid = &rest[..end];
                            if all[pos.saturating_sub(40)..pos].contains("running") {
                                return TurnPlan::new()
                                    .push_tool_call(
                                        format!("call_wait_{}", req.sequence),
                                        "wait",
                                        json!({ "cell_id": cid, "yield_time_ms": 60000 }),
                                    )
                                    .with_usage(usage)
                                    .finish(FinishReason::ToolCalls);
                            }
                        }
                    }
                    // Avoid infinite loop if V8 threw an error: report it clearly as final text.
                    return TurnPlan::new()
                        .push_text(format!("PARENT_V8_ERROR: {tail}"))
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                let parent_code = format!(
                    r#"
                    const ml = await tools.ModelList({{ request: {{ kind: "start" }} }});
                    const backend = ml.choices.find(c => c.selection.kind === "model").selection;
                    const ws = {ws};
                    const [c1, c2] = await Promise.all([
                      tools.SessionCreate({{ title: "Worker-1", labels: [], backend, workspace: {{ kind: "directory", path: ws }} }}),
                      tools.SessionCreate({{ title: "Worker-2", labels: [], backend, workspace: {{ kind: "directory", path: ws }} }}),
                    ]);
                    const ids = [c1.session.id, c2.session.id];
                    await Promise.all(ids.map((id, i) =>
                      tools.SessionSend({{ sessionId: id, message: "SUBAGENT_TASK_" + i + " run v8 check", onComplete: "none" }})
                    ));
                    const localRead = await tools.Read({{ path: "fixture_0.txt", offset: 0, limit: 8 }});
                    let lastSnap = "";
                    for (let attempt = 0; attempt < 30; attempt++) {{
                      const snaps = await Promise.all(ids.map(id => tools.SessionRead({{ sessionId: id, position: "tail" }})));
                      lastSnap = JSON.stringify(snaps[0]).slice(0, 260);
                      if (snaps.every(s => JSON.stringify(s).includes("CHILD_OK_VERIFIED"))) {{
                        text("FANOUT_ALL_CHILDREN_DONE:" + localRead.kind + ":attempts=" + attempt + ":" + ids.join(","));
                        exit();
                      }}
                      await new Promise(r => setTimeout(r, 300));
                    }}
                    text("FANOUT_TIMEOUT:" + ids.join(",") + " snap=" + lastSnap);
                    "#,
                    ws = serde_json::to_string(&ws_path).unwrap()
                );

                TurnPlan::new()
                    .push_tool_call(
                        format!("call_parent_v8_{}", req.sequence),
                        "exec",
                        json!({ "code": parent_code }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls)
            })
            .start()
            .await
            .unwrap()
    };

    let conn = seed_codemode_connection(&sandbox.root, &server.base_url(), "javascript").await;
    let mut host = Host::spawn(&sandbox).unwrap();
    let host_pid = host.pid().expect("host pid");
    let (mut client, socket_path) = host.ready().await.unwrap();
    save_credential(&client, &conn).await;

    let rss_before = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_before = sample_open_fds(host_pid).unwrap_or(0);

    const PARENTS: usize = 10;
    let mut parent_ids = Vec::with_capacity(PARENTS);
    for i in 0..PARENTS {
        let created = call(
            &client,
            "agent",
            "create",
            json!({
                "title": format!("CodeMode-Parent-{i}"),
                "automaticTitle": false,
                "labels": [],
                "workspace": { "kind": "directory", "path": sandbox.workspace },
                "backend": { "kind": "model", "connectionId": conn, "modelId": "gpt-4.1", "thinkingLevel": null }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(created["kind"], "created", "{created}");
        parent_ids.push(created["session"]["id"].as_str().unwrap().to_string());
    }

    let started = Instant::now();
    let peak_rss = Arc::new(AtomicU64::new(rss_before));
    let peak_fds = Arc::new(AtomicU64::new(fds_before as u64));
    let stop_sampler = CancellationToken::new();
    let sampler = {
        let peak_rss = peak_rss.clone();
        let peak_fds = peak_fds.clone();
        let tok = stop_sampler.clone();
        tokio::spawn(async move {
            while !tok.is_cancelled() {
                if let Some(r) = sample_rss_kib(host_pid) {
                    peak_rss.fetch_max(r, Ordering::Relaxed);
                }
                if let Some(f) = sample_open_fds(host_pid) {
                    peak_fds.fetch_max(f as u64, Ordering::Relaxed);
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        })
    };

    let mut tasks = JoinSet::new();
    for (idx, sid) in parent_ids.into_iter().enumerate() {
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
                    "message": format!("PARENT_FANOUT_{idx:02} Spawn 2 V8 subagents and verify."),
                    "delivery": "queue"
                }),
                Attachments::new(),
            )
            .await;
            let msg_id = sent["messageId"].as_str().unwrap().to_string();
            let term = wait_run_terminal(&cli, &sid, &msg_id, Duration::from_secs(180)).await;
            let state = term["execution"]["state"]["kind"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            (idx, sid, state, t0.elapsed(), term)
        });
    }

    let mut ok_count = 0usize;
    let mut failures = Vec::new();
    while let Some(res) = tasks.join_next().await {
        let (idx, sid, state, elapsed, term) = res.unwrap();
        if state == "completed" {
            ok_count += 1;
        } else {
            failures.push((idx, sid, state, elapsed.as_millis(), term));
        }
    }

    stop_sampler.cancel();
    let _ = sampler.await;
    let wall = started.elapsed();
    let rss_after = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_after = sample_open_fds(host_pid).unwrap_or(0);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let rss_idle = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_idle = sample_open_fds(host_pid).unwrap_or(0);
    let db_kib = dir_size_kib(&sandbox.root);
    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();

    eprintln!("================ SCENARIO C: CODEMODE V8 + SUBAGENT FANOUT REPORT ================");
    eprintln!(
        "Parents: {ok_count}/{PARENTS} completed (parent_done={}, children_done={}/{}) in {:.2}s",
        parents_completed.load(Ordering::Relaxed),
        children_completed.load(Ordering::Relaxed),
        PARENTS * 2,
        wall.as_secs_f64()
    );
    eprintln!(
        "Host RSS: before={:.1}MiB peak={:.1}MiB after={:.1}MiB idle+2s={:.1}MiB | DB={:.1}MiB",
        rss_before as f64 / 1024.0,
        peak_rss.load(Ordering::Relaxed) as f64 / 1024.0,
        rss_after as f64 / 1024.0,
        rss_idle as f64 / 1024.0,
        db_kib as f64 / 1024.0
    );
    eprintln!(
        "Open FDs: before={fds_before} peak={} after={fds_after} idle+2s={fds_idle}",
        peak_fds.load(Ordering::Relaxed)
    );
    eprintln!(
        "Model turns: total={} | TTFT p50={} p99={} | Turn p50={} p99={}",
        metrics.total_requests,
        metrics.ttft_ms.p50,
        metrics.ttft_ms.p99,
        metrics.turn_duration_ms.p50,
        metrics.turn_duration_ms.p99
    );
    eprintln!(
        "Watchdog violations: total={} by_kind={:?}",
        watchdog.total_violations, watchdog.by_kind
    );
    for v in watchdog.recent.iter().take(10) {
        eprintln!(
            "  VIOLATION [{:?}] sess={} detail={}",
            v.kind, v.session_key, v.detail
        );
    }
    for f in &failures {
        eprintln!("  FAILED PARENT: {f:?}");
    }
    eprintln!("==================================================================================");

    let _ = host.quit(&mut client).await;
    server.shutdown().await;
    assert!(
        failures.is_empty(),
        "Code Mode fan-out failures: {failures:?}"
    );
    assert_eq!(
        children_completed.load(Ordering::Relaxed),
        (PARENTS * 2) as u64
    );
    assert_eq!(parents_completed.load(Ordering::Relaxed), PARENTS as u64);
    assert_eq!(watchdog.total_violations, 0, "watchdog: {watchdog:?}");
}

/// Scenario D: 60-Session Mixed-Protocol Incident Wave + Active Steering & Stop/Restart Storm!
#[tokio::test]
#[ignore = "live real-Host 60-session incident wave + steering/cancel storm; run with -- --ignored --nocapture"]
async fn real_host_60_session_incident_wave_and_steering_cancel_storm() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;

    let step_map: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let steered_hits = Arc::new(AtomicU64::new(0));
    let drop_injected = Arc::new(AtomicU64::new(0));

    let schedule = ScenarioSchedule {
        phases: vec![
            ScenarioPhase {
                name: "warm-baseline".into(),
                at_secs: 0,
                profile: RuntimeProfile {
                    latency: LatencyProfile {
                        base_ttft_ms: 10,
                        tokens_per_sec: 1500.0,
                        ..Default::default()
                    },
                    chaos_override: Some(ChaosConfig::default()),
                    rate_limit_override: Some(RateLimitConfig {
                        enabled: true,
                        scope: RateLimitScope::Global,
                        max_concurrent: Some(24),
                        rpm: Some(10_000),
                        ..Default::default()
                    }),
                },
            },
            ScenarioPhase {
                name: "incident-degradation".into(),
                at_secs: 4,
                profile: RuntimeProfile {
                    latency: LatencyProfile {
                        base_ttft_ms: 70,
                        ttft_jitter_cv: 0.4,
                        concurrency_knee: 12,
                        ttft_congestion_factor: 1.5,
                        tokens_per_sec: 350.0,
                        micro_stall_prob: 0.04,
                        micro_stall_ms_range: (30, 90),
                        ..Default::default()
                    },
                    chaos_override: Some(ChaosConfig {
                        rate_limit_rate: 0.06,
                        rate_limit_retry_after_ms: 50,
                        server_error_rate: 0.04,
                        mid_stream_error_rate: 0.02,
                        drop_connection_rate: 0.02,
                        ..Default::default()
                    }),
                    rate_limit_override: Some(RateLimitConfig {
                        enabled: true,
                        scope: RateLimitScope::Global,
                        max_concurrent: Some(6),
                        rpm: Some(10_000),
                        ..Default::default()
                    }),
                },
            },
            ScenarioPhase {
                name: "recovery".into(),
                at_secs: 10,
                profile: RuntimeProfile {
                    latency: LatencyProfile {
                        base_ttft_ms: 10,
                        tokens_per_sec: 2000.0,
                        ..Default::default()
                    },
                    chaos_override: Some(ChaosConfig::default()),
                    rate_limit_override: Some(RateLimitConfig {
                        enabled: true,
                        scope: RateLimitScope::Global,
                        max_concurrent: Some(24),
                        rpm: Some(10_000),
                        ..Default::default()
                    }),
                },
            },
        ],
        repeat_cycle_secs: Some(12),
    };

    let server = {
        let steps = step_map.clone();
        let steered = steered_hits.clone();
        let drops = drop_injected.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .schedule(schedule)
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
                max_session_prompt_bytes: Some(4 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, ctx: &TurnContext| {
                let all = req.all_text();
                let usage = Usage::new(req.estimated_input_tokens.max(80), 40);

                if let Some(ref chaos) = ctx.chaos_override {
                    let mut h = req.sequence.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ ctx.session_turn;
                    h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                    let r = ((h & 0xFFFF) as f64) / 65536.0;
                    if r < chaos.rate_limit_rate {
                        return TurnPlan::http_error(
                            HttpErrorSpec::rate_limit(None, "wave 429")
                                .with_retry_after_ms(chaos.rate_limit_retry_after_ms),
                        );
                    }
                    if r < chaos.rate_limit_rate + chaos.server_error_rate {
                        return TurnPlan::http_error(HttpErrorSpec::new(
                            503,
                            "overloaded_error",
                            "wave 503",
                        ));
                    }
                    if r < chaos.rate_limit_rate + chaos.server_error_rate + chaos.drop_connection_rate
                    {
                        drops.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text("partial before drop ")
                            .push(TurnEvent::DropConnection);
                    }
                }

                if all.contains("POST_STOP_RECOVERY") {
                    return TurnPlan::new()
                        .push_text("Recovered cleanly after agent.stop!")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                if all.contains("STEER_REDIRECT") {
                    steered.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("Steer accepted cleanly!")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                if all.contains("TARGET_SLOW_RUN") {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_slow_{}", req.sequence),
                            "Shell",
                            json!({ "command": "sleep 0.4 && echo slow-done", "login": false }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                let logical_key = all
                    .split_whitespace()
                    .find(|w| w.starts_with("WAVE_SESS_"))
                    .unwrap_or(&req.session_key)
                    .to_string();
                let step = {
                    let mut m = steps.lock().unwrap();
                    let e = m.entry(logical_key.clone()).or_insert(0);
                    *e += 1;
                    *e
                };

                if step == 1 {
                    let fidx = (req.sequence as usize) % 5;
                    TurnPlan::new()
                        .push_tool_call(
                            format!("call_w1_{}", req.sequence),
                            "Read",
                            json!({ "path": format!("fixture_{fidx}.txt"), "offset": 0, "limit": 10 }),
                        )
                        .push_tool_call(
                            format!("call_w1b_{}", req.sequence),
                            "Shell",
                            json!({ "command": format!("echo wave-{logical_key}"), "login": false }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls)
                } else {
                    TurnPlan::new()
                        .push_text_chunked(format!("Wave session {logical_key} finished 🚀"), 12)
                        .with_usage(usage)
                        .finish(FinishReason::Stop)
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
    save_credential(&client, &conn_ws).await;
    save_credential(&client, &conn_ant).await;
    save_credential(&client, &conn_chat).await;

    let rss_before = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_before = sample_open_fds(host_pid).unwrap_or(0);

    const TOTAL: usize = 60;
    let mut specs = Vec::with_capacity(TOTAL);
    for i in 0..TOTAL {
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
                "title": format!("Wave60-{label}-{i}"),
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
        specs.push((
            i,
            created["session"]["id"].as_str().unwrap().to_string(),
            label,
        ));
    }

    let started = Instant::now();
    let peak_rss = Arc::new(AtomicU64::new(rss_before));
    let peak_fds = Arc::new(AtomicU64::new(fds_before as u64));
    let stop_sampler = CancellationToken::new();
    let sampler = {
        let peak_rss = peak_rss.clone();
        let peak_fds = peak_fds.clone();
        let tok = stop_sampler.clone();
        tokio::spawn(async move {
            while !tok.is_cancelled() {
                if let Some(r) = sample_rss_kib(host_pid) {
                    peak_rss.fetch_max(r, Ordering::Relaxed);
                }
                if let Some(f) = sample_open_fds(host_pid) {
                    peak_fds.fetch_max(f as u64, Ordering::Relaxed);
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        })
    };

    let mut tasks = JoinSet::new();
    for (idx, sid, label) in specs {
        let sock = socket_path.clone();
        tasks.spawn(async move {
            let cli = Client::connect(&sock, None).await.unwrap();
            let t0 = Instant::now();
            if idx < 12 {
                let sent1 = call(
                    &cli,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": format!("WAVE_SESS_{idx:02} TARGET_SLOW_RUN initial prompt"),
                        "delivery": "queue"
                    }),
                    Attachments::new(),
                )
                .await;
                let msg1 = sent1["messageId"].as_str().unwrap().to_string();
                tokio::time::sleep(Duration::from_millis(180 + (idx as u64 * 25))).await;
                let sent2 = call(
                    &cli,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": format!("WAVE_SESS_{idx:02} STEER_REDIRECT pivot now!"),
                        "delivery": "steer"
                    }),
                    Attachments::new(),
                )
                .await;
                let msg2 = sent2["messageId"].as_str().unwrap().to_string();
                let _ = wait_run_terminal(&cli, &sid, &msg1, Duration::from_secs(180)).await;
                let term2 = wait_run_terminal(&cli, &sid, &msg2, Duration::from_secs(180)).await;
                let state = term2["execution"]["state"]["kind"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                (idx, label, "steer", sid, state, t0.elapsed(), term2)
            } else if idx < 18 {
                let sent1 = call(
                    &cli,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": format!("WAVE_SESS_{idx:02} TARGET_SLOW_RUN cancel me"),
                        "delivery": "queue"
                    }),
                    Attachments::new(),
                )
                .await;
                let msg1 = sent1["messageId"].as_str().unwrap_or_else(|| panic!("no messageId in sent1={sent1}")).to_string();
                let run1 = if let Some(r) = sent1["runId"].as_str() {
                    r.to_string()
                } else {
                    let deadline = Instant::now() + Duration::from_secs(30);
                    loop {
                        let m = call(
                            &cli,
                            "agent",
                            "work",
                            json!({ "sessionId": sid, "target": { "kind": "message", "messageId": msg1 } }),
                            Attachments::new(),
                        )
                        .await;
                        if let Some(r) = m["execution"]["runId"].as_str() {
                            break r.to_string();
                        }
                        assert!(Instant::now() < deadline, "queued message never got runId: {m}");
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                };
                tokio::time::sleep(Duration::from_millis(200 + ((idx - 12) as u64 * 30))).await;
                let _ = call(
                    &cli,
                    "agent",
                    "stop",
                    json!({ "sessionId": sid, "runId": run1 }),
                    Attachments::new(),
                )
                .await;
                let _ = wait_run_terminal(&cli, &sid, &msg1, Duration::from_secs(60)).await;
                let sent2 = call(
                    &cli,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": format!("WAVE_SESS_{idx:02} POST_STOP_RECOVERY finish cleanly"),
                        "delivery": "queue"
                    }),
                    Attachments::new(),
                )
                .await;
                let msg2 = sent2["messageId"].as_str().unwrap().to_string();
                let term2 = wait_run_terminal(&cli, &sid, &msg2, Duration::from_secs(180)).await;
                let state = term2["execution"]["state"]["kind"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                (idx, label, "stop+restart", sid, state, t0.elapsed(), term2)
            } else {
                let sent = call(
                    &cli,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": format!("WAVE_SESS_{idx:02} execute wave workflow on {label}"),
                        "delivery": "queue"
                    }),
                    Attachments::new(),
                )
                .await;
                let msg_id = sent["messageId"].as_str().unwrap().to_string();
                let term = wait_run_terminal(&cli, &sid, &msg_id, Duration::from_secs(180)).await;
                let state = term["execution"]["state"]["kind"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                (idx, label, "normal", sid, state, t0.elapsed(), term)
            }
        });
    }

    let mut completed = 0usize;
    let mut non_completed = Vec::new();
    let mut max_ms = 0u128;
    while let Some(res) = tasks.join_next().await {
        let (idx, label, cohort, sid, state, elapsed, term) = res.unwrap();
        max_ms = max_ms.max(elapsed.as_millis());
        if state == "completed" {
            completed += 1;
        } else {
            non_completed.push((idx, label, cohort, sid, state, term));
        }
    }

    stop_sampler.cancel();
    let _ = sampler.await;
    let wall = started.elapsed();
    let rss_after = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_after = sample_open_fds(host_pid).unwrap_or(0);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let rss_idle = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_idle = sample_open_fds(host_pid).unwrap_or(0);
    let db_kib = dir_size_kib(&sandbox.root);
    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();

    eprintln!(
        "================ SCENARIO D: 60-SESSION INCIDENT WAVE + STEER/STOP REPORT ================"
    );
    eprintln!(
        "Sessions: {completed}/{TOTAL} completed in {:.2}s (max_session={max_ms}ms) | steered_hits={} drops_injected={}",
        wall.as_secs_f64(),
        steered_hits.load(Ordering::Relaxed),
        drop_injected.load(Ordering::Relaxed)
    );
    eprintln!(
        "Host RSS: before={:.1}MiB peak={:.1}MiB after={:.1}MiB idle+2s={:.1}MiB | DB={:.1}MiB",
        rss_before as f64 / 1024.0,
        peak_rss.load(Ordering::Relaxed) as f64 / 1024.0,
        rss_after as f64 / 1024.0,
        rss_idle as f64 / 1024.0,
        db_kib as f64 / 1024.0
    );
    eprintln!(
        "Open FDs: before={fds_before} peak={} after={fds_after} idle+2s={fds_idle}",
        peak_fds.load(Ordering::Relaxed)
    );
    eprintln!(
        "Model turns: total={} (ws={}, anthropic={}, chat={}) ws_upgrades={} rate_limits={} http_errors={} drops={} abandoned={}",
        metrics.total_requests,
        metrics.responses_ws_turns,
        metrics.anthropic_requests,
        metrics.chat_completions_requests,
        metrics.ws_upgrades,
        metrics.rate_limits_emitted,
        metrics.http_errors_emitted,
        metrics.connection_drops_emitted,
        metrics.abandoned_streams
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
    for f in &non_completed {
        eprintln!(
            "  FAILED SESSION: idx={} label={} cohort={} state={} term={}",
            f.0, f.1, f.2, f.4, f.5
        );
    }
    eprintln!(
        "=========================================================================================="
    );

    let _ = host.quit(&mut client).await;
    server.shutdown().await;
    assert!(
        non_completed.is_empty(),
        "60-session wave had {} non-completed sessions",
        non_completed.len()
    );
}

/// Scenario E: 40-Turn Cascading Multi-Compaction + Emergency Context Overflow (HTTP 400) +
/// max_output_tokens Truncation Torture on ONE ultra-long real Maka Host session!
#[tokio::test]
#[ignore = "live real-Host 40-turn cascading compaction + overflow torture; run with -- --ignored --nocapture"]
async fn real_host_40_turn_multi_compaction_and_overflow_torture() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;

    let compactions = Arc::new(AtomicU64::new(0));
    let overflows_injected = Arc::new(AtomicU64::new(0));
    let truncations_injected = Arc::new(AtomicU64::new(0));
    let overflow_armed = Arc::new(AtomicBool::new(true));
    let model_step = Arc::new(AtomicU64::new(0));
    let prompt_bytes_history: Arc<Mutex<Vec<(u64, usize)>>> = Arc::new(Mutex::new(Vec::new()));

    let server = {
        let comp = compactions.clone();
        let ov_cnt = overflows_injected.clone();
        let tr_cnt = truncations_injected.clone();
        let ov_armed = overflow_armed.clone();
        let step = model_step.clone();
        let hist = prompt_bytes_history.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .control(ControlPlaneConfig {
                enable_admin_api: true,
                models: vec![ModelEntry::simple("gpt-4.1-mini")],
                ..Default::default()
            })
            .watchdog(WatchdogConfig {
                enabled: true,
                max_session_prompt_bytes: Some(2 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
                let all = req.all_text();
                if all.contains("TORTURE_COMPACT_MARKER") {
                    let n = comp.fetch_add(1, Ordering::Relaxed) + 1;
                    if n == 2 {
                        ov_armed.store(true, Ordering::Relaxed);
                    }
                    return TurnPlan::new()
                        .push_text(format!(
                            "Compacted checkpoint #{n}: preserved critical state & recent findings."
                        ))
                        .with_usage(Usage::new(1500, 90))
                        .finish(FinishReason::Stop);
                }

                let s = step.fetch_add(1, Ordering::Relaxed) + 1;
                hist.lock().unwrap().push((s, req.prompt_bytes));

                // Extract current user turn number from the latest "TORTURE_TURN_XX" marker.
                let current_turn: usize = all
                    .rsplit("TORTURE_TURN_")
                    .next()
                    .and_then(|tail| tail.get(..2))
                    .and_then(|digits| digits.parse::<usize>().ok())
                    .unwrap_or(0);
                let step_done_tag = format!("STEP_DONE_T{current_turn:02}");
                let has_tool_result = all.contains(&step_done_tag);

                // Inject real HTTP 400 context_length_exceeded once prompt grows past 22 KiB
                // (re-armed after compaction #2) to test emergency overflow compaction recovery.
                if req.prompt_bytes > 22_000 && ov_armed.swap(false, Ordering::Relaxed) {
                    ov_cnt.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::http_error(context_overflow_error(
                        req.protocol,
                        req.prompt_bytes,
                        24_000,
                    ));
                }

                let reported_in = ((req.prompt_bytes as u64) * 2 / 3).clamp(3000, 23_500);
                let usage = Usage::new(reported_in, 160);

                if has_tool_result {
                    let finish = if current_turn == 10 || current_turn == 30 {
                        tr_cnt.fetch_add(1, Ordering::Relaxed);
                        FinishReason::Length
                    } else {
                        FinishReason::Stop
                    };
                    TurnPlan::new()
                        .push_text_chunked(
                            format!(
                                "Torture answer turn={current_turn} step={s} bytes={}. {}",
                                req.prompt_bytes,
                                "structured-report-segment-中文🚀 ".repeat(35)
                            ),
                            40,
                        )
                        .with_usage(usage)
                        .finish(finish)
                } else {
                    let cmd = format!(
                        "cat fixture_0.txt fixture_1.txt | head -c 4096 && echo '' && echo {step_done_tag}"
                    );
                    TurnPlan::new()
                        .push_tool_call(
                            format!("call_torture_{s}"),
                            "Shell",
                            json!({ "command": cmd, "login": false }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls)
                }
            })
            .start()
            .await
            .unwrap()
    };

    let (_conn_ws, _conn_ant, conn_chat) =
        seed_connections(&sandbox.root, &server.base_url()).await;
    let mut host = Host::spawn(&sandbox).unwrap();
    let host_pid = host.pid().expect("host pid");
    let (mut client, _sock) = host.ready().await.unwrap();
    save_credential(&client, &conn_chat).await;

    let rss_start = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_start = sample_open_fds(host_pid).unwrap_or(0);

    let created = call(
        &client,
        "agent",
        "create",
        json!({
            "title": "40-Turn Cascading Compaction Torture",
            "automaticTitle": false,
            "labels": [],
            "tools": ["Shell", "Read"],
            "workspace": { "kind": "directory", "path": sandbox.workspace },
            "backend": { "kind": "model", "connectionId": conn_chat, "modelId": "gpt-4.1-mini", "thinkingLevel": null }
        }),
        Attachments::new(),
    )
    .await;
    let sid = created["session"]["id"].as_str().unwrap().to_string();

    let cp_meta = call(
        &client,
        "agent",
        "compactionPrompt",
        json!({ "sessionId": sid }),
        Attachments::new(),
    )
    .await;
    let cp_set = call(
        &client,
        "agent",
        "setCompactionPrompt",
        json!({
            "sessionId": sid,
            "expectedRevision": cp_meta["revision"],
            "prompt": "TORTURE_COMPACT_MARKER Compact aggressively."
        }),
        Attachments::new(),
    )
    .await;
    assert_eq!(cp_set["kind"], "committed", "{cp_set}");

    let started = Instant::now();
    let mut latencies_ms = Vec::with_capacity(40);
    let mut non_completed_turns = Vec::new();
    let mut rss_mid = 0u64;

    for u in 1..=40usize {
        if u == 20 {
            rss_mid = sample_rss_kib(host_pid).unwrap_or(0);
        }
        let t0 = Instant::now();
        let sent = call(
            &client,
            "agent",
            "send",
            json!({
                "sessionId": sid,
                "message": format!("TORTURE_TURN_{u:02} (#{u}/40): execute diagnostic & summarize. {}", "payload-padding ".repeat(40)),
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
        let term = wait_run_terminal(&client, &sid, &msg_id, Duration::from_secs(90)).await;
        let state = term["execution"]["state"]["kind"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        latencies_ms.push(t0.elapsed().as_millis());
        let expected_state = if u == 10 || u == 30 {
            "failed"
        } else {
            "completed"
        };
        if state != expected_state {
            non_completed_turns.push((u, state, term));
            break;
        }
    }

    let wall = started.elapsed();
    let rss_end = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_end = sample_open_fds(host_pid).unwrap_or(0);
    let db_kib = dir_size_kib(&sandbox.root);
    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();
    let hist = prompt_bytes_history.lock().unwrap().clone();
    let max_bytes = hist.iter().map(|(_, b)| *b).max().unwrap_or(0);
    let final_bytes = hist.last().map(|(_, b)| *b).unwrap_or(0);
    let first5_avg = if latencies_ms.len() >= 5 {
        latencies_ms[..5].iter().sum::<u128>() / 5
    } else {
        0
    };
    let last5_avg = if latencies_ms.len() >= 5 {
        latencies_ms[latencies_ms.len() - 5..].iter().sum::<u128>() / 5
    } else {
        0
    };

    eprintln!(
        "================ SCENARIO E: 40-TURN MULTI-COMPACTION + OVERFLOW REPORT ================"
    );
    eprintln!(
        "Completed turns: {}/40 in {:.2}s | first5_avg={}ms last5_avg={}ms",
        latencies_ms.len() - non_completed_turns.len(),
        wall.as_secs_f64(),
        first5_avg,
        last5_avg
    );
    eprintln!(
        "Compactions fired: {} | Overflows injected (400): {} | Truncations (Length): {}",
        compactions.load(Ordering::Relaxed),
        overflows_injected.load(Ordering::Relaxed),
        truncations_injected.load(Ordering::Relaxed)
    );
    eprintln!(
        "Prompt bytes: max={max_bytes} final={final_bytes} | Model requests={}",
        metrics.total_requests
    );
    eprintln!(
        "Host RSS: start={:.1}MiB mid(t20)={:.1}MiB end(t40)={:.1}MiB | FDs: start={fds_start} end={fds_end} | DB={:.1}MiB",
        rss_start as f64 / 1024.0,
        rss_mid as f64 / 1024.0,
        rss_end as f64 / 1024.0,
        db_kib as f64 / 1024.0
    );
    eprintln!("Turn latencies (ms): {latencies_ms:?}");
    eprintln!(
        "Watchdog violations: total={} by_kind={:?}",
        watchdog.total_violations, watchdog.by_kind
    );
    for v in watchdog.recent.iter().take(10) {
        eprintln!(
            "  VIOLATION [{:?}] sess={} detail={}",
            v.kind, v.session_key, v.detail
        );
    }
    for f in &non_completed_turns {
        eprintln!("  FAILED TURN #{}: state={} term={}", f.0, f.1, f.2);
    }
    eprintln!(
        "========================================================================================"
    );

    let _ = host.quit(&mut client).await;
    server.shutdown().await;
    assert!(
        non_completed_turns.is_empty(),
        "40-turn torture failed on turn: {non_completed_turns:?}"
    );
    assert!(
        compactions.load(Ordering::Relaxed) >= 3,
        "expected >= 3 cascading compactions across 40 turns, got {}",
        compactions.load(Ordering::Relaxed)
    );
    assert_eq!(watchdog.total_violations, 0, "watchdog: {watchdog:?}");
}

/// Scenario F: Python Code Mode (real Monty child workers) + Subagent Fan-Out Storm!
/// 10 concurrent parent sessions EACH run Python Code Mode scripts (asyncio.gather + store/load)
/// that invoke tools.Read AND delegate to 2 real child subagent sessions (20 children, each ALSO
/// running Python Code Mode scripts with tools.Read + tools.Shell + store/load)
/// = 30 simultaneous real Maka sessions + 60+ Python Monty worker cells against ONE real Maka Host!
#[tokio::test]
#[ignore = "live real-Host Python Code Mode (Monty) + subagent fan-out storm; run with -- --ignored --nocapture"]
async fn real_host_codemode_python_and_subagent_fanout_storm() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;
    let workspace_str = sandbox.workspace.to_string_lossy().to_string();

    let children_completed = Arc::new(AtomicU64::new(0));
    let parents_completed = Arc::new(AtomicU64::new(0));

    let server = {
        let ws_path = workspace_str.clone();
        let child_done = children_completed.clone();
        let parent_done = parents_completed.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .control(ControlPlaneConfig {
                enable_admin_api: true,
                models: vec![ModelEntry::simple("gpt-4.1")],
                ..Default::default()
            })
            .latency_profile(LatencyProfile {
                base_ttft_ms: 8,
                ttft_jitter_cv: 0.25,
                tokens_per_sec: 2000.0,
                ..Default::default()
            })
            .watchdog(WatchdogConfig {
                enabled: true,
                max_session_prompt_bytes: Some(4 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
                let all = req.all_text();
                let usage = Usage::new(req.estimated_input_tokens.max(120), 64);

                if all.contains("PY_SUBAGENT_TASK_") && !all.contains("PY_PARENT_FANOUT_") {
                    if all.contains("PY_CHILD_STEP_DONE") {
                        child_done.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text("PY_CHILD_OK_VERIFIED")
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    let fidx = (req.sequence as usize) % 5;
                    let child_code = format!(
                        r#"import asyncio
r, s = await asyncio.gather(
    tools.Read(path="fixture_{fidx}.txt", offset=0, limit=12),
    tools.Shell(command="echo child-py-ok", login=False),
)
store("child_ok", True)
text("PY_CHILD_STEP_DONE:" + r["kind"] + ":" + s["kind"])
"#
                    );
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_py_child_{}", req.sequence),
                            "exec",
                            json!({ "code": child_code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                if all.contains("PY_PARENT_PERSIST_OK") {
                    parent_done.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("PY_PARENT_FANOUT_COMPLETE 🐍")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                if all.contains("PY_FANOUT_ALL_CHILDREN_DONE") {
                    // Run a second Python cell on the same parent to verify cross-cell store()/load().
                    let verify_code = r#"ids = load("py_children")
if not isinstance(ids, list) or len(ids) != 2:
    raise RuntimeError("store/load lost py_children: " + str(ids))
text("PY_PARENT_PERSIST_OK:" + ",".join(ids))
"#;
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_py_verify_{}", req.sequence),
                            "exec",
                            json!({ "code": verify_code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                if let Some(pos) = all.find("PY_FANOUT_TIMEOUT:") {
                    let snippet: String = all[pos..].chars().take(320).collect();
                    eprintln!("[SCEN F] python parent timeout seq={} {snippet}", req.sequence);
                    return TurnPlan::new()
                        .push_text("PY_PARENT_FANOUT_TIMEOUT")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                if req.messages.len() > 2 {
                    let tail: String = all.chars().rev().take(400).collect::<String>().chars().rev().collect();
                    eprintln!("[SCEN F] repeated py parent seq={} msgs={} tail={tail:?}", req.sequence, req.messages.len());
                    if let Some(pos) = all.rfind("\"cell_id\":\"") {
                        let rest = &all[pos + 11..];
                        if let Some(end) = rest.find('"') {
                            let cid = &rest[..end];
                            if all[pos.saturating_sub(40)..pos].contains("running") {
                                return TurnPlan::new()
                                    .push_tool_call(
                                        format!("call_py_wait_{}", req.sequence),
                                        "wait",
                                        json!({ "cell_id": cid, "yield_time_ms": 60000 }),
                                    )
                                    .with_usage(usage)
                                    .finish(FinishReason::ToolCalls);
                            }
                        }
                    }
                    return TurnPlan::new()
                        .push_text(format!("PY_PARENT_ERROR: {tail}"))
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                let parent_code = format!(
                    r#"import asyncio, json
ml = await tools.ModelList(request={{"kind": "start"}})
backend = [c["selection"] for c in ml["choices"] if c["selection"]["kind"] == "model"][0]
ws = {ws}
c1, c2 = await asyncio.gather(
    tools.SessionCreate(title="PyWorker-1", labels=[], backend=backend, workspace={{"kind": "directory", "path": ws}}),
    tools.SessionCreate(title="PyWorker-2", labels=[], backend=backend, workspace={{"kind": "directory", "path": ws}}),
)
ids = [c1["session"]["id"], c2["session"]["id"]]
await asyncio.gather(
    tools.SessionSend(sessionId=ids[0], message="PY_SUBAGENT_TASK_0 run python check", onComplete="none"),
    tools.SessionSend(sessionId=ids[1], message="PY_SUBAGENT_TASK_1 run python check", onComplete="none"),
)
local_read = await tools.Read(path="fixture_0.txt", offset=0, limit=8)
store("py_children", ids)
last_snap = ""
for attempt in range(35):
    snaps = await asyncio.gather(
        tools.SessionRead(sessionId=ids[0], position="tail"),
        tools.SessionRead(sessionId=ids[1], position="tail"),
    )
    last_snap = json.dumps(snaps[0])[:240]
    if all("PY_CHILD_OK_VERIFIED" in json.dumps(s) for s in snaps):
        text("PY_FANOUT_ALL_CHILDREN_DONE:" + local_read["kind"] + ":" + ",".join(ids))
        exit()
    await asyncio.sleep(0.3)
text("PY_FANOUT_TIMEOUT:" + ",".join(ids) + " snap=" + last_snap)
"#,
                    ws = serde_json::to_string(&ws_path).unwrap()
                );

                TurnPlan::new()
                    .push_tool_call(
                        format!("call_py_parent_{}", req.sequence),
                        "exec",
                        json!({ "code": parent_code }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls)
            })
            .start()
            .await
            .unwrap()
    };

    let conn = seed_codemode_connection(&sandbox.root, &server.base_url(), "python").await;
    let mut host = Host::spawn(&sandbox).unwrap();
    let host_pid = host.pid().expect("host pid");
    let (mut client, socket_path) = host.ready().await.unwrap();
    save_credential(&client, &conn).await;

    let rss_before = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_before = sample_open_fds(host_pid).unwrap_or(0);
    let kids_before = sample_child_procs(host_pid);

    const PARENTS: usize = 10;
    let mut parent_ids = Vec::with_capacity(PARENTS);
    for i in 0..PARENTS {
        let created = call(
            &client,
            "agent",
            "create",
            json!({
                "title": format!("PyCodeMode-Parent-{i}"),
                "automaticTitle": false,
                "labels": [],
                "workspace": { "kind": "directory", "path": sandbox.workspace },
                "backend": { "kind": "model", "connectionId": conn, "modelId": "gpt-4.1", "thinkingLevel": null }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(created["kind"], "created", "{created}");
        parent_ids.push(created["session"]["id"].as_str().unwrap().to_string());
    }

    let started = Instant::now();
    let peak_rss = Arc::new(AtomicU64::new(rss_before));
    let peak_fds = Arc::new(AtomicU64::new(fds_before as u64));
    let peak_kids = Arc::new(AtomicU64::new(kids_before as u64));
    let stop_sampler = CancellationToken::new();
    let sampler = {
        let peak_rss = peak_rss.clone();
        let peak_fds = peak_fds.clone();
        let peak_kids = peak_kids.clone();
        let tok = stop_sampler.clone();
        tokio::spawn(async move {
            while !tok.is_cancelled() {
                if let Some(r) = sample_rss_kib(host_pid) {
                    peak_rss.fetch_max(r, Ordering::Relaxed);
                }
                if let Some(f) = sample_open_fds(host_pid) {
                    peak_fds.fetch_max(f as u64, Ordering::Relaxed);
                }
                peak_kids.fetch_max(sample_child_procs(host_pid) as u64, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        })
    };

    let mut tasks = JoinSet::new();
    for (idx, sid) in parent_ids.into_iter().enumerate() {
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
                    "message": format!("PY_PARENT_FANOUT_{idx:02} Spawn 2 Python subagents and verify."),
                    "delivery": "queue"
                }),
                Attachments::new(),
            )
            .await;
            let msg_id = sent["messageId"].as_str().unwrap().to_string();
            let term = wait_run_terminal(&cli, &sid, &msg_id, Duration::from_secs(180)).await;
            let state = term["execution"]["state"]["kind"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            (idx, sid, state, t0.elapsed(), term)
        });
    }

    let mut ok_count = 0usize;
    let mut failures = Vec::new();
    while let Some(res) = tasks.join_next().await {
        let (idx, sid, state, elapsed, term) = res.unwrap();
        if state == "completed" {
            ok_count += 1;
        } else {
            failures.push((idx, sid, state, elapsed.as_millis(), term));
        }
    }

    stop_sampler.cancel();
    let _ = sampler.await;
    let wall = started.elapsed();
    let rss_after = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_after = sample_open_fds(host_pid).unwrap_or(0);
    let kids_after = sample_child_procs(host_pid);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let rss_idle = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_idle = sample_open_fds(host_pid).unwrap_or(0);
    let kids_idle = sample_child_procs(host_pid);
    let db_kib = dir_size_kib(&sandbox.root);

    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();
    let children_done = children_completed.load(Ordering::Relaxed);
    let parents_done = parents_completed.load(Ordering::Relaxed);

    eprintln!(
        "================ SCENARIO F: PYTHON CODEMODE (MONTY) + FANOUT REPORT ================"
    );
    eprintln!(
        "Parents: {ok_count}/{PARENTS} completed (parent_done={parents_done}, children_done={children_done}/{}) in {:.2}s",
        PARENTS * 2,
        wall.as_secs_f64()
    );
    eprintln!(
        "Host RSS: before={:.1}MiB peak={:.1}MiB after={:.1}MiB idle+2s={:.1}MiB | DB={:.1}MiB",
        rss_before as f64 / 1024.0,
        peak_rss.load(Ordering::Relaxed) as f64 / 1024.0,
        rss_after as f64 / 1024.0,
        rss_idle as f64 / 1024.0,
        db_kib as f64 / 1024.0
    );
    eprintln!(
        "Open FDs: before={fds_before} peak={} after={fds_after} idle+2s={fds_idle} | Child procs: before={kids_before} peak={} after={kids_after} idle+2s={kids_idle}",
        peak_fds.load(Ordering::Relaxed),
        peak_kids.load(Ordering::Relaxed)
    );
    eprintln!(
        "Model turns: total={} | TTFT p50={} p99={} | Turn p50={} p99={}",
        metrics.total_requests,
        metrics.ttft_ms.p50,
        metrics.ttft_ms.p99,
        metrics.turn_duration_ms.p50,
        metrics.turn_duration_ms.p99
    );
    eprintln!(
        "Watchdog violations: total={} by_kind={:?}",
        watchdog.total_violations, watchdog.by_kind
    );
    for v in watchdog.recent.iter().take(10) {
        eprintln!(
            "  VIOLATION [{:?}] sess={} detail={}",
            v.kind, v.session_key, v.detail
        );
    }
    for f in &failures {
        eprintln!(
            "  FAILURE parent#{} sid={} state={} elapsed={}ms term={}",
            f.0, f.1, f.2, f.3, f.4
        );
    }
    eprintln!(
        "====================================================================================="
    );

    let _ = host.quit(&mut client).await;
    server.shutdown().await;

    assert_eq!(
        ok_count, PARENTS,
        "Python Code Mode fanout failures: {failures:?}"
    );
    assert_eq!(parents_done, PARENTS as u64);
    assert_eq!(children_done, (PARENTS * 2) as u64);
    assert_eq!(
        kids_idle, kids_before,
        "leaked Monty/child processes after idle: before={kids_before} idle={kids_idle}"
    );
    assert_eq!(watchdog.total_violations, 0, "watchdog: {watchdog:?}");
}

async fn seed_dual_codemode_connections(
    root: &std::path::Path,
    base_url: &str,
) -> (String, String) {
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
    let mut ids = Vec::new();
    for (rev, (slug, name, lang)) in [
        ("stress-codemode-js", "Stress CodeMode JS", "javascript"),
        ("stress-codemode-py", "Stress CodeMode Python", "python"),
    ]
    .into_iter()
    .enumerate()
    {
        let created = store
            .create_connection(
                serde_json::from_value(json!({
                    "expectedCatalogRevision": rev,
                    "connection": {
                        "slug": slug,
                        "name": name,
                        "provider": {
                            "packageId": "maka.providers",
                            "entryId": "maka.providers",
                            "scope": "profile",
                            "name": "openai-compatible"
                        },
                        "configuration": { "baseUrl": base_url },
                        "enabled": true,
                        "enabledModelIds": ["gpt-4.1"],
                        "modelOverrides": {
                            "gpt-4.1": {
                                "codeMode": true,
                                "codeModeLanguage": lang,
                                "apiProtocol": "openai-chat-completions",
                                "contextWindow": 128_000,
                                "inputLimit": 128_000
                            }
                        }
                    }
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let maka_agent_facts::configuration::CatalogMutationResult::Committed {
            connection: Some(conn),
            ..
        } = created
        else {
            panic!("failed to create {slug}: {created:?}");
        };
        ids.push(conn.connection_id);
    }
    store.shutdown().await.unwrap();
    (ids.remove(0), ids.remove(0))
}

/// Scenario G: Adversarial JS (V8) + Python (Monty) Code Mode Torture!
/// 12 simultaneous sessions (6 JS V8 + 6 Python Monty) split across 3 hostile cohorts:
///   - OOM Bomb (2 JS + 2 Py): attempts unbounded allocation past the 64 MiB interpreter budget
///   - Mid-Sleep agent.stop Kill (2 JS + 2 Py): sleeps 30s inside V8/Monty, hard-stopped at 400ms
///   - Running-Cell wait(terminate=true) (2 JS + 2 Py): yields at 300ms then explicitly cancelled
/// Every cohort MUST survive without crashing/leaking Monty child processes or FDs, accept a
/// healthy post-adversarial follow-up turn, AND survive a full Host restart/reopen on the same root!
#[tokio::test]
#[ignore = "live real-Host JS+Python Code Mode OOM/kill/terminate/reopen torture; run with -- --ignored --nocapture"]
async fn real_host_codemode_js_and_python_adversarial_kill_oom_reopen_storm() {
    let sandbox = Sandbox::new().await.unwrap();
    seed_workspace_files(&sandbox.workspace).await;

    let oom_recovered = Arc::new(AtomicU64::new(0));
    let terminate_recovered = Arc::new(AtomicU64::new(0));

    let server = {
        let oom_rec = oom_recovered.clone();
        let term_rec = terminate_recovered.clone();
        MockAiBuilder::new()
            .recorder(RecorderMode::MetricsOnly)
            .control(ControlPlaneConfig {
                enable_admin_api: true,
                models: vec![ModelEntry::simple("gpt-4.1")],
                ..Default::default()
            })
            .watchdog(WatchdogConfig {
                enabled: true,
                max_session_prompt_bytes: Some(4 * 1024 * 1024),
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
                let all = req.all_text();
                let usage = Usage::new(req.estimated_input_tokens.max(100), 48);
                let is_py = all.contains("LANG_PYTHON");

                if all.contains("POST_REOPEN_PING") {
                    return TurnPlan::new()
                        .push_text("POST_REOPEN_ALIVE_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }

                if all.contains("HEALTH_FOLLOWUP_CHECK") {
                    if all.contains("FOLLOWUP_CELL_OK") {
                        return TurnPlan::new()
                            .push_text("FOLLOWUP_VERIFIED_OK")
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    let code = if is_py {
                        r#"r = await tools.Read(path="fixture_0.txt", offset=0, limit=4)
text("FOLLOWUP_CELL_OK:" + r["kind"])
"#
                    } else {
                        r#"const r = await tools.Read({ path: "fixture_0.txt", offset: 0, limit: 4 }); text("FOLLOWUP_CELL_OK:" + r.kind);"#
                    };
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_followup_{}", req.sequence),
                            "exec",
                            json!({ "code": code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                if all.contains("COHORT_OOM_BOMB") {
                    // On first call (only 1 user message, no tool result yet), launch the OOM bomb;
                    // on second call (after interpreter rejects/interrupts OOM), complete cleanly!
                    if req.messages.len() > 2 {
                        oom_rec.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text("OOM_CONTAINED_CLEANLY")
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    let code = if is_py {
                        r#"chunk = "x" * (1024 * 1024)
buf = []
for i in range(128):
    buf.append(chunk + str(i))
text("SHOULD_NOT_REACH")
"#
                    } else {
                        r#"const buf = []; for (let i = 0; i < 128; i++) buf.push("x".repeat(1024 * 1024) + i); text("SHOULD_NOT_REACH");"#
                    };
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_oom_{}", req.sequence),
                            "exec",
                            json!({ "code": code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                if all.contains("COHORT_STOP_KILL") {
                    let code = if is_py {
                        r#"import asyncio
await asyncio.sleep(30)
text("NEVER_FINISH")
"#
                    } else {
                        r#"await new Promise(r => setTimeout(r, 30000)); text("NEVER_FINISH");"#
                    };
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_sleep_{}", req.sequence),
                            "exec",
                            json!({ "code": code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                if all.contains("COHORT_YIELD_TERMINATE") {
                    if let Some(pos) = all.rfind("\"cell_id\":\"") {
                        let rest = &all[pos + 11..];
                        if let Some(end) = rest.find('"') {
                            let cid = &rest[..end];
                            // If the latest tool result is still "running", cancel it via wait(terminate=true).
                            if all[pos.saturating_sub(40)..pos].contains("running") && req.messages.len() <= 5 {
                                return TurnPlan::new()
                                    .push_tool_call(
                                        format!("call_term_{}", req.sequence),
                                        "wait",
                                        json!({ "cell_id": cid, "terminate": true, "yield_time_ms": 15000 }),
                                    )
                                    .with_usage(usage)
                                    .finish(FinishReason::ToolCalls);
                            }
                        }
                    }
                    if req.messages.len() > 2 {
                        term_rec.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text("CELL_TERMINATED_CLEANLY")
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    let code = if is_py {
                        r#"# @exec: {"yield_time_ms": 300}
import asyncio
await asyncio.sleep(30)
text("NEVER")
"#
                    } else {
                        r#"// @exec: {"yield_time_ms": 300}
await new Promise(r => setTimeout(r, 30000)); text("NEVER");"#
                    };
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("call_yield_{}", req.sequence),
                            "exec",
                            json!({ "code": code }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }

                TurnPlan::new()
                    .push_text("DEFAULT_OK")
                    .with_usage(usage)
                    .finish(FinishReason::Stop)
            })
            .start()
            .await
            .unwrap()
    };

    let (conn_js, conn_py) =
        seed_dual_codemode_connections(&sandbox.root, &server.base_url()).await;
    let mut host = Host::spawn(&sandbox).unwrap();
    let host_pid = host.pid().expect("host pid");
    let (mut client, socket_path) = host.ready().await.unwrap();
    save_credential(&client, &conn_js).await;
    save_credential(&client, &conn_py).await;

    let rss_before = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_before = sample_open_fds(host_pid).unwrap_or(0);
    let kids_before = sample_child_procs(host_pid);

    let mut sessions = Vec::new();
    for idx in 0..12usize {
        let is_py = idx % 2 == 1;
        let conn = if is_py { &conn_py } else { &conn_js };
        let cohort = match idx / 4 {
            0 => "OOM",
            1 => "STOP",
            _ => "TERM",
        };
        let created = call(
            &client,
            "agent",
            "create",
            json!({
                "title": format!("Adversarial-{cohort}-{}-{}", if is_py { "py" } else { "js" }, idx),
                "automaticTitle": false,
                "labels": [],
                "workspace": { "kind": "directory", "path": sandbox.workspace },
                "backend": { "kind": "model", "connectionId": conn, "modelId": "gpt-4.1", "thinkingLevel": null }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(created["kind"], "created", "{created}");
        sessions.push((
            idx,
            cohort,
            is_py,
            created["session"]["id"].as_str().unwrap().to_string(),
        ));
    }

    let started = Instant::now();
    let peak_rss = Arc::new(AtomicU64::new(rss_before));
    let peak_fds = Arc::new(AtomicU64::new(fds_before as u64));
    let peak_kids = Arc::new(AtomicU64::new(kids_before as u64));
    let stop_sampler = CancellationToken::new();
    let sampler = {
        let peak_rss = peak_rss.clone();
        let peak_fds = peak_fds.clone();
        let peak_kids = peak_kids.clone();
        let tok = stop_sampler.clone();
        tokio::spawn(async move {
            while !tok.is_cancelled() {
                if let Some(r) = sample_rss_kib(host_pid) {
                    peak_rss.fetch_max(r, Ordering::Relaxed);
                }
                if let Some(f) = sample_open_fds(host_pid) {
                    peak_fds.fetch_max(f as u64, Ordering::Relaxed);
                }
                peak_kids.fetch_max(sample_child_procs(host_pid) as u64, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        })
    };

    let mut tasks = JoinSet::new();
    for (idx, cohort, is_py, sid) in sessions.iter().cloned() {
        let sock = socket_path.clone();
        let lang_tag = if is_py { "LANG_PYTHON" } else { "LANG_JS" };
        tasks.spawn(async move {
            let cli = Client::connect(&sock, None).await.unwrap();
            let t0 = Instant::now();
            match cohort {
                "OOM" => {
                    let sent = call(
                        &cli,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("{lang_tag} COHORT_OOM_BOMB #{idx}"),
                            "delivery": "queue"
                        }),
                        Attachments::new(),
                    )
                    .await;
                    let msg = sent["messageId"].as_str().unwrap().to_string();
                    let term = wait_run_terminal(&cli, &sid, &msg, Duration::from_secs(90)).await;
                    let s1 = term["execution"]["state"]["kind"].as_str().unwrap_or("unknown").to_string();
                    let sent2 = call(
                        &cli,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("{lang_tag} HEALTH_FOLLOWUP_CHECK #{idx}"),
                            "delivery": "queue"
                        }),
                        Attachments::new(),
                    )
                    .await;
                    let msg2 = sent2["messageId"].as_str().unwrap().to_string();
                    let term2 = wait_run_terminal(&cli, &sid, &msg2, Duration::from_secs(90)).await;
                    let s2 = term2["execution"]["state"]["kind"].as_str().unwrap_or("unknown").to_string();
                    (idx, cohort, is_py, sid, s1, s2, t0.elapsed(), term2)
                }
                "STOP" => {
                    let sent = call(
                        &cli,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("{lang_tag} COHORT_STOP_KILL #{idx}"),
                            "delivery": "queue"
                        }),
                        Attachments::new(),
                    )
                    .await;
                    let msg = sent["messageId"].as_str().unwrap().to_string();
                    let run_id = if let Some(r) = sent["runId"].as_str() {
                        r.to_string()
                    } else {
                        loop {
                            let w = call(
                                &cli,
                                "agent",
                                "work",
                                json!({ "sessionId": sid, "target": { "kind": "message", "messageId": msg } }),
                                Attachments::new(),
                            )
                            .await;
                            if let Some(r) = w["execution"]["runId"].as_str() {
                                break r.to_string();
                            }
                            tokio::time::sleep(Duration::from_millis(25)).await;
                        }
                    };
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let _ = call(
                        &cli,
                        "agent",
                        "stop",
                        json!({ "sessionId": sid, "runId": run_id }),
                        Attachments::new(),
                    )
                    .await;
                    let term1 = wait_run_terminal(&cli, &sid, &msg, Duration::from_secs(60)).await;
                    let s1 = term1["execution"]["state"]["kind"].as_str().unwrap_or("unknown").to_string();
                    let sent2 = call(
                        &cli,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("{lang_tag} HEALTH_FOLLOWUP_CHECK #{idx}"),
                            "delivery": "queue"
                        }),
                        Attachments::new(),
                    )
                    .await;
                    let msg2 = sent2["messageId"].as_str().unwrap().to_string();
                    let term2 = wait_run_terminal(&cli, &sid, &msg2, Duration::from_secs(90)).await;
                    let s2 = term2["execution"]["state"]["kind"].as_str().unwrap_or("unknown").to_string();
                    (idx, cohort, is_py, sid, s1, s2, t0.elapsed(), term2)
                }
                _ => {
                    let sent = call(
                        &cli,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("{lang_tag} COHORT_YIELD_TERMINATE #{idx}"),
                            "delivery": "queue"
                        }),
                        Attachments::new(),
                    )
                    .await;
                    let msg = sent["messageId"].as_str().unwrap().to_string();
                    let term1 = wait_run_terminal(&cli, &sid, &msg, Duration::from_secs(90)).await;
                    let s1 = term1["execution"]["state"]["kind"].as_str().unwrap_or("unknown").to_string();
                    let sent2 = call(
                        &cli,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("{lang_tag} HEALTH_FOLLOWUP_CHECK #{idx}"),
                            "delivery": "queue"
                        }),
                        Attachments::new(),
                    )
                    .await;
                    let msg2 = sent2["messageId"].as_str().unwrap().to_string();
                    let term2 = wait_run_terminal(&cli, &sid, &msg2, Duration::from_secs(90)).await;
                    let s2 = term2["execution"]["state"]["kind"].as_str().unwrap_or("unknown").to_string();
                    (idx, cohort, is_py, sid, s1, s2, t0.elapsed(), term2)
                }
            }
        });
    }

    let mut followup_ok = 0usize;
    let mut bad = Vec::new();
    while let Some(res) = tasks.join_next().await {
        let (idx, cohort, is_py, sid, s1, s2, elapsed, term2) = res.unwrap();
        if s2 == "completed" {
            followup_ok += 1;
        } else {
            bad.push((idx, cohort, is_py, sid, s1, s2, elapsed.as_millis(), term2));
        }
    }

    stop_sampler.cancel();
    let _ = sampler.await;
    let wall = started.elapsed();
    let rss_after = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_after = sample_open_fds(host_pid).unwrap_or(0);
    let kids_after = sample_child_procs(host_pid);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let rss_idle = sample_rss_kib(host_pid).unwrap_or(0);
    let fds_idle = sample_open_fds(host_pid).unwrap_or(0);
    let kids_idle = sample_child_procs(host_pid);

    // Phase 2: Full Host quit + Reopen on the exact same Sandbox root, then verify both a JS and Python session still respond cleanly!
    host.quit(&mut client).await.unwrap();
    let mut host2 = Host::spawn(&sandbox).unwrap();
    let (mut client2, _sock2) = host2.ready().await.unwrap();
    let mut reopen_ok = 0usize;
    for (_, _, is_py, sid) in [
        sessions[0].clone(),
        sessions[5].clone(),
        sessions[11].clone(),
    ] {
        let lang_tag = if is_py { "LANG_PYTHON" } else { "LANG_JS" };
        let sent = call(
            &client2,
            "agent",
            "send",
            json!({
                "sessionId": sid,
                "message": format!("{lang_tag} POST_REOPEN_PING"),
                "delivery": "queue"
            }),
            Attachments::new(),
        )
        .await;
        let msg = sent["messageId"].as_str().unwrap().to_string();
        let term = wait_run_terminal(&client2, &sid, &msg, Duration::from_secs(60)).await;
        if term["execution"]["state"]["kind"] == "completed" {
            reopen_ok += 1;
        }
    }
    host2.quit(&mut client2).await.unwrap();

    let metrics = server.metrics();
    let watchdog = server.watchdog_snapshot();
    server.shutdown().await;

    eprintln!(
        "================ SCENARIO G: ADVERSARIAL JS+PY OOM/KILL/TERM/REOPEN REPORT ================"
    );
    eprintln!(
        "Follow-ups: {followup_ok}/12 completed | Reopen pings: {reopen_ok}/3 | OOM contained={} | wait(terminate)={} in {:.2}s",
        oom_recovered.load(Ordering::Relaxed),
        terminate_recovered.load(Ordering::Relaxed),
        wall.as_secs_f64()
    );
    eprintln!(
        "Host RSS: before={:.1}MiB peak={:.1}MiB after={:.1}MiB idle+2s={:.1}MiB",
        rss_before as f64 / 1024.0,
        peak_rss.load(Ordering::Relaxed) as f64 / 1024.0,
        rss_after as f64 / 1024.0,
        rss_idle as f64 / 1024.0
    );
    eprintln!(
        "Open FDs: before={fds_before} peak={} after={fds_after} idle+2s={fds_idle} | Child procs: before={kids_before} peak={} after={kids_after} idle+2s={kids_idle}",
        peak_fds.load(Ordering::Relaxed),
        peak_kids.load(Ordering::Relaxed)
    );
    eprintln!(
        "Model turns: total={} | Watchdog violations: total={} by_kind={:?}",
        metrics.total_requests, watchdog.total_violations, watchdog.by_kind
    );
    for b in &bad {
        eprintln!(
            "  BAD #{}: cohort={} py={} sid={} s1={} s2={} elapsed={}ms",
            b.0, b.1, b.2, b.3, b.4, b.5, b.6
        );
    }
    eprintln!(
        "==========================================================================================="
    );

    assert_eq!(followup_ok, 12, "adversarial follow-up failures: {bad:?}");
    assert_eq!(reopen_ok, 3, "post-reopen ping failed");
    assert_eq!(
        oom_recovered.load(Ordering::Relaxed),
        4,
        "all 4 OOM bombs (2 JS + 2 Py) must be contained"
    );
    assert_eq!(
        terminate_recovered.load(Ordering::Relaxed),
        4,
        "all 4 wait(terminate=true) must settle"
    );
    assert_eq!(
        kids_idle, kids_before,
        "leaked Monty/child processes after OOM/kill/terminate: before={kids_before} idle={kids_idle}"
    );
    assert_eq!(watchdog.total_violations, 0, "watchdog: {watchdog:?}");
}
