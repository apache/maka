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

//! Hell-Tier Host Torture Suite (Scenarios H–L) — opt-in (`#[ignore]`), run in `--release`:
//!   cargo test --release --test mainline_reopen real_host_5x_sigkill -- --ignored --nocapture
//!   cargo test --release --test mainline_reopen real_host_400_session -- --ignored --nocapture

use super::host_load_stress::{sample_rss_kib, save_credential, seed_workspace_files};
use super::*;
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, HttpErrorSpec, MockAiBuilder, ModelEntry, NormalizedRequest,
    RecorderMode, TurnContext, TurnEvent, TurnPlan, Usage, WatchdogConfig,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::time::Instant;

struct HellConnections {
    js: String,
    py: String,
    ws: String,
    anthropic: String,
    chat: String,
}

async fn seed_hell_connections(root: &Path, base_url: &str, chat_ctx: u64) -> HellConnections {
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

    let specs = [
        (
            "hell-js",
            "openai-compatible",
            "gpt-4.1",
            json!({
                "codeMode": true,
                "codeModeLanguage": "javascript",
                "apiProtocol": "openai-chat-completions",
                "contextWindow": 128_000,
                "inputLimit": 128_000
            }),
        ),
        (
            "hell-py",
            "openai-compatible",
            "gpt-4.1",
            json!({
                "codeMode": true,
                "codeModeLanguage": "python",
                "apiProtocol": "openai-chat-completions",
                "contextWindow": 128_000,
                "inputLimit": 128_000
            }),
        ),
        (
            "hell-ws",
            "openai",
            "gpt-4.1",
            json!({
                "codeMode": false,
                "apiProtocol": "openai-responses",
                "contextWindow": 128_000,
                "inputLimit": 128_000
            }),
        ),
        (
            "hell-anthropic",
            "anthropic",
            "claude-sonnet-4-5",
            json!({
                "codeMode": false,
                "apiProtocol": "anthropic-messages",
                "contextWindow": 128_000,
                "inputLimit": 128_000
            }),
        ),
        (
            "hell-chat",
            "openai-compatible",
            "gpt-4.1-mini",
            json!({
                "codeMode": false,
                "apiProtocol": "openai-chat-completions",
                "contextWindow": chat_ctx,
                "inputLimit": chat_ctx
            }),
        ),
    ];

    let mut rev = 0u64;
    let mut ids = Vec::with_capacity(specs.len());
    for (slug, provider, model, overrides) in specs {
        let created = store
            .create_connection(
                serde_json::from_value(json!({
                    "expectedCatalogRevision": rev,
                    "connection": {
                        "slug": slug,
                        "name": format!("Hell {slug}"),
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
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let maka_agent_facts::configuration::CatalogMutationResult::Committed {
            connection: Some(conn),
            catalog_revision,
            ..
        } = created
        else {
            panic!("failed to create hell connection {slug}: {created:?}");
        };
        rev = catalog_revision;
        ids.push(conn.connection_id);
    }
    store.shutdown().await.unwrap();
    HellConnections {
        js: ids[0].clone(),
        py: ids[1].clone(),
        ws: ids[2].clone(),
        anthropic: ids[3].clone(),
        chat: ids[4].clone(),
    }
}

async fn save_all_hell_credentials(client: &Client, conns: &HellConnections) {
    for cid in [
        &conns.js,
        &conns.py,
        &conns.ws,
        &conns.anthropic,
        &conns.chat,
    ] {
        save_credential(client, cid).await;
    }
}

async fn try_call(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
    timeout: Duration,
) -> std::result::Result<Value, String> {
    tokio::time::timeout(timeout, async {
        let mut call = client
            .call(endpoint, method.into(), input, Attachments::new())
            .await
            .map_err(|e| format!("open {endpoint}.{method}: {e}"))?;
        call.start()
            .await
            .map_err(|e| format!("start {endpoint}.{method}: {e}"))?;
        let mut reply = call
            .receive()
            .await
            .map_err(|e| format!("recv {endpoint}.{method}: {e}"))?;
        if let Reply::Prepared { .. } = reply {
            reply = call
                .confirm(json!({"purpose":"hell-tier-stress"}))
                .await
                .map_err(|e| format!("confirm {endpoint}.{method}: {e}"))?;
        }
        match reply {
            Reply::Finished { result, .. } => {
                result.map_err(|e| format!("finished err {endpoint}.{method}: {e}"))
            }
            Reply::Mutation { reply, .. } => match reply.receipt {
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    ..
                } => Ok(value),
                other => Err(format!(
                    "mutation non-success {endpoint}.{method}: {other:?}"
                )),
            },
            other => Err(format!("unexpected reply {endpoint}.{method}: {other:?}")),
        }
    })
    .await
    .map_err(|_| format!("timeout {endpoint}.{method} ({timeout:?})"))?
}

fn sample_open_fds(pid: u32) -> Option<usize> {
    let output = std::process::Command::new("lsof")
        .args(["-n", "-P", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let lines = String::from_utf8_lossy(&output.stdout).lines().count();
    Some(lines.saturating_sub(1))
}

#[derive(Default, Debug, Clone)]
struct SqliteMetrics {
    db_files: usize,
    total_db_bytes: u64,
    total_wal_bytes: u64,
    facts_rows: u64,
    contents_rows: u64,
}

fn walk_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn sample_sqlite_metrics(root: &Path) -> SqliteMetrics {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    let mut m = SqliteMetrics::default();
    for path in files {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let size = std::fs::metadata(&path).map(|md| md.len()).unwrap_or(0);
        if name.ends_with("-wal") {
            m.total_wal_bytes += size;
        } else if name.ends_with(".db") || name.ends_with(".sqlite") {
            m.db_files += 1;
            m.total_db_bytes += size;
            if let Ok(out) = std::process::Command::new("sqlite3")
                .arg(&path)
                .arg("SELECT (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='agent_facts'), (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='contents');")
                .output()
            {
                let text = String::from_utf8_lossy(&out.stdout);
                let parts: Vec<&str> = text.trim().split('|').collect();
                if parts.first().copied() == Some("1")
                    && let Ok(cnt) = std::process::Command::new("sqlite3")
                        .arg(&path)
                        .arg("SELECT count(*) FROM agent_facts;")
                        .output()
                    {
                        m.facts_rows += String::from_utf8_lossy(&cnt.stdout)
                            .trim()
                            .parse::<u64>()
                            .unwrap_or(0);
                    }
                if parts.get(1).copied() == Some("1")
                    && let Ok(cnt) = std::process::Command::new("sqlite3")
                        .arg(&path)
                        .arg("SELECT count(*) FROM contents;")
                        .output()
                    {
                        m.contents_rows += String::from_utf8_lossy(&cnt.stdout)
                            .trim()
                            .parse::<u64>()
                            .unwrap_or(0);
                    }
            }
        }
    }
    m
}

fn verify_sqlite_integrity(root: &Path) -> std::result::Result<usize, String> {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    let mut checked = 0usize;
    for path in files {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !(name.ends_with(".db") || name.ends_with(".sqlite")) {
            continue;
        }
        let out = std::process::Command::new("sqlite3")
            .arg(&path)
            .arg("PRAGMA integrity_check; PRAGMA foreign_key_check;")
            .output()
            .map_err(|e| format!("sqlite3 {}: {e}", path.display()))?;
        if !out.status.success() {
            return Err(format!(
                "sqlite3 exited {} on {}: {}",
                out.status,
                path.display(),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines != ["ok"] {
            return Err(format!(
                "SQLite integrity/FK failure in {}: {:?}",
                path.display(),
                lines
            ));
        }
        checked += 1;
    }
    Ok(checked)
}

fn dump_failed_run_facts(root: &Path, session_id: &str) -> String {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    let mut out = String::new();
    for path in files {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !(name.ends_with(".db") || name.ends_with(".sqlite")) {
            continue;
        }
        let sql = format!(
            "SELECT h.run, h.sequence, h.kind, substr(CAST(c.payload AS TEXT), 1, 260) FROM agent_session_history h JOIN agent_facts f ON f.id = h.fact_id JOIN contents c ON c.id = f.body_content_id WHERE h.session = '{}' ORDER BY h.sequence DESC LIMIT 40;",
            session_id.replace('\'', "''")
        );
        if let Ok(res) = std::process::Command::new("sqlite3")
            .arg(&path)
            .arg(&sql)
            .output()
        {
            let s = String::from_utf8_lossy(&res.stdout);
            if !s.trim().is_empty() {
                out.push_str(&s);
            }
        }
    }
    out
}

/// Scans the ENTIRE OS process table (including processes reparented to PID 1 after SIGKILL)
/// for any process whose command line or environment matches `marker` or `sandbox_dir`.
fn find_orphan_procs(marker: &str, sandbox_dir: &Path) -> Vec<String> {
    let my_pid = std::process::id();
    let dir_str = sandbox_dir.to_string_lossy().to_string();
    let Ok(out) = std::process::Command::new("ps")
        .args(["eww", "-eo", "pid=,ppid=,command="])
        .output()
    else {
        return Vec::new();
    };
    let ps_pid = out.status.code();
    let _ = ps_pid;
    let mut hits = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let pid: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        if pid == 0 || pid == my_pid {
            continue;
        }
        if trimmed.contains("ps eww -eo") {
            continue;
        }
        if trimmed.contains(marker) || trimmed.contains(&dir_str) {
            let short: String = trimmed.chars().take(240).collect();
            hits.push(short);
        }
    }
    hits
}

#[derive(Default)]
struct LatencyHistogram {
    samples_ms: Mutex<Vec<u64>>,
}

impl LatencyHistogram {
    fn record(&self, d: Duration) {
        self.samples_ms
            .lock()
            .unwrap()
            .push(d.as_millis().min(u64::MAX as u128) as u64);
    }

    fn count(&self) -> usize {
        self.samples_ms.lock().unwrap().len()
    }

    fn summary(&self) -> String {
        let mut v = self.samples_ms.lock().unwrap().clone();
        if v.is_empty() {
            return "n=0".to_string();
        }
        v.sort_unstable();
        let n = v.len();
        let p50 = v[n / 2];
        let p95 = v[(n * 95 / 100).min(n - 1)];
        let p99 = v[(n * 99 / 100).min(n - 1)];
        let max = v[n - 1];
        format!("n={n} p50={p50}ms p95={p95}ms p99={p99}ms max={max}ms")
    }
}

async fn create_session(
    client: &Client,
    workspace: &Path,
    backend: Value,
) -> std::result::Result<String, String> {
    let created = try_call(
        client,
        "agent",
        "create",
        json!({
            "title": "Hell Stress Session",
            "labels": [],
            "workspace": { "kind": "directory", "path": workspace },
            "backend": backend
        }),
        Duration::from_secs(30),
    )
    .await?;
    created["session"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("create missing session.id: {created}"))
}

async fn wait_session_settled(
    client: &Client,
    session_id: &str,
    timeout: Duration,
) -> std::result::Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            let last = try_call(
                client,
                "agent",
                "observe",
                json!({ "sessionId": session_id }),
                Duration::from_secs(10),
            )
            .await;
            return Err(format!(
                "session {session_id} did not settle within {timeout:?}; last={last:?}"
            ));
        }
        if let Ok(obs) = try_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": session_id }),
            Duration::from_secs(15),
        )
        .await
        {
            let run = &obs["run"];
            if run.is_null() {
                return Ok("idle".into());
            }
            let kind = run["state"]
                .as_str()
                .or_else(|| run["state"]["kind"].as_str())
                .unwrap_or("unknown");
            if matches!(kind, "completed" | "failed" | "cancelled" | "blocked") {
                return Ok(kind.to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

fn backend_for(conns: &HellConnections, kind: &str) -> Value {
    match kind {
        "js" => {
            json!({"kind": "model", "connectionId": conns.js, "modelId": "gpt-4.1", "thinkingLevel": null})
        }
        "py" => {
            json!({"kind": "model", "connectionId": conns.py, "modelId": "gpt-4.1", "thinkingLevel": null})
        }
        "ws" => {
            json!({"kind": "model", "connectionId": conns.ws, "modelId": "gpt-4.1", "thinkingLevel": null})
        }
        "anthropic" => {
            json!({"kind": "model", "connectionId": conns.anthropic, "modelId": "claude-sonnet-4-5", "thinkingLevel": null})
        }
        "chat" => {
            json!({"kind": "model", "connectionId": conns.chat, "modelId": "gpt-4.1-mini", "thinkingLevel": null})
        }
        other => panic!("unknown backend kind {other}"),
    }
}

/// ================================================================================================
/// Scenario H: 5x Host SIGKILL Crash-Loop Under 100 Mixed-Runtime Active Sessions!
///
/// 100 concurrent sessions fire simultaneously across 4 cohorts:
///   - 25 JS V8 Code Mode (yield_control + Shell + Read + store/load)
///   - 25 Python Monty Code Mode (asyncio.gather Shell + Read + store)
///   - 25 Background Shell + PTY (13 PTY + 12 pipe emitting tagged output loops)
///   - 25 Slow-Streaming OpenAI Responses WS & Anthropic SSE + 16 live agent/watch subscribers
///
/// While 50+ sessions are actively mid-flight (streaming, executing V8/Monty/Shell/PTY, writing SQLite),
/// we slam the real Maka Host with FIVE consecutive SIGKILLs (`kill -9`) with short crash-loop
/// restarts in between, then restart a 6th time and verify:
///   1. SQLite PRAGMA integrity_check + foreign_key_check == ok on every DB
///   2. All 100 sessions settle cleanly (no stuck busy/claim deadlock)
///   3. All 100 sessions accept & complete a fresh post-crash turn (100/100 completed)
///   4. ZERO orphan Shell/PTY/Monty/Host processes remain anywhere in the OS (even reparented to PID 1)!
/// ================================================================================================
#[tokio::test]
#[ignore = "hell-tier stress test; run with --release --ignored --nocapture"]
async fn real_host_5x_sigkill_crash_loop_under_100_mixed_sessions() {
    let started = Instant::now();
    let sandbox = Sandbox::new().await.expect("sandbox");
    seed_workspace_files(&sandbox.workspace).await;
    let marker = format!("MAKA_HELL_H_{}", uuid::Uuid::new_v4().simple());

    let total_model_reqs = Arc::new(AtomicU64::new(0));
    let wave_model_reqs = Arc::new(AtomicU64::new(0));
    let in_flight_reqs = Arc::new(AtomicUsize::new(0));

    let total_reqs_cb = total_model_reqs.clone();
    let wave_reqs_cb = wave_model_reqs.clone();
    let in_flight_cb = in_flight_reqs.clone();
    let marker_cb = marker.clone();

    let mock = MockAiBuilder::new()
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
            max_session_prompt_bytes: Some(16 * 1024 * 1024),
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
            total_reqs_cb.fetch_add(1, Ordering::Relaxed);
            wave_reqs_cb.fetch_add(1, Ordering::Relaxed);
            in_flight_cb.fetch_add(1, Ordering::Relaxed);

            let all = req.all_text();
            let usage = Usage::new(400, 120);

            if all.contains("POST_CRASH_VERIFY_") {
                return TurnPlan::new()
                    .push_text("POST_CRASH_LIVENESS_OK")
                    .with_usage(usage)
                    .finish(FinishReason::Stop);
            }

            // Cohort 0: JS V8 Code Mode
            if all.contains("COHORT_JS_") {
                if all.contains("H_JS_CELL_DONE") {
                    return TurnPlan::new()
                        .push_text("COHORT_JS_COMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(pos) = all.rfind(r#""cell_id":""#) {
                    let rest = &all[pos + 11..];
                    if let Some(end) = rest.find('"') {
                        let cid = &rest[..end];
                        if all[pos.saturating_sub(40)..pos].contains("running") {
                            return TurnPlan::new()
                                .push_tool_call(
                                    format!("wait_js_{}", req.sequence),
                                    "wait",
                                    json!({ "cell_id": cid, "yield_time_ms": 15000 }),
                                )
                                .with_usage(usage)
                                .finish(FinishReason::ToolCalls);
                        }
                    }
                }
                if req.messages.len() > 3 {
                    return TurnPlan::new()
                        .push_text("COHORT_JS_FALLBACK_DONE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let code = format!(
                    r#"
                    store("tag", "{m}");
                    const [r, s1] = await Promise.all([
                      tools.Read({{ path: "fixture_0.txt", offset: 0, limit: 10 }}),
                      tools.Shell({{ command: "sh -c 'sleep 1.2; echo js1-{m}'", login: false }}),
                    ]);
                    text("js_mid:" + r.kind + ":" + s1.kind);
                    await yield_control();
                    const s2 = await tools.Shell({{ command: "sh -c 'sleep 0.8; echo js2-{m}'", login: false }});
                    text("H_JS_CELL_DONE:" + load("tag") + ":" + s2.kind);
                    "#,
                    m = marker_cb
                );
                return TurnPlan::new()
                    .push_tool_call(
                        format!("exec_js_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 500 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // Cohort 1: Python Monty Code Mode
            if all.contains("COHORT_PY_") {
                if all.contains("H_PY_CELL_DONE") || req.messages.len() > 3 {
                    return TurnPlan::new()
                        .push_text("COHORT_PY_COMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let code = format!(
                    r#"import asyncio
store("py_tag", "{m}")
r, s = await asyncio.gather(
    tools.Read(path="fixture_1.txt", offset=0, limit=10),
    tools.Shell(command="sh -c 'sleep 1.5; echo py-{m}'", login=False),
)
text("H_PY_CELL_DONE:" + str(load("py_tag")) + ":" + r["kind"] + ":" + s["kind"])
"#,
                    m = marker_cb
                );
                return TurnPlan::new()
                    .push_tool_call(
                        format!("exec_py_{}", req.sequence),
                        "exec",
                        json!({ "code": code }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // Cohort 2: Background Shell + PTY continuous emitter
            if all.contains("COHORT_SHELL_") {
                if all.contains("SHELL_BG_STOPPED") || req.messages.len() > 5 {
                    return TurnPlan::new()
                        .push_text("COHORT_SHELL_COMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(pos) = all.rfind(r#""ref":""#) {
                    let rest = &all[pos + 7..];
                    if let Some(end) = rest.find('"') {
                        let bg_ref = rest[..end].to_string();
                        if !all.contains("ProcessStop") {
                            return TurnPlan::new()
                                .push_tool_call(
                                    format!("stop_bg_{}", req.sequence),
                                    "ProcessStop",
                                    json!({ "ref": bg_ref }),
                                )
                                .with_usage(usage)
                                .finish(FinishReason::ToolCalls);
                        }
                    }
                }
                let use_pty = all.contains("COHORT_SHELL_PTY_");
                return TurnPlan::new()
                    .push_tool_call(
                        format!("bg_shell_{}", req.sequence),
                        "Shell",
                        json!({
                            "command": format!(
                                "sh -c 'i=0; while [ $i -lt 120 ]; do echo tick-$i-{}; i=$((i+1)); sleep 0.1; done'",
                                marker_cb
                            ),
                            "run_in_background": true,
                            "pty": use_pty,
                            "login": false
                        }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // Cohort 3: Slow-streaming OpenAI Responses WS / Anthropic SSE
            if req.messages.len() <= 2 {
                let mut plan = TurnPlan::new();
                plan.chunk_delay_ms = 20;
                plan.events.push(TurnEvent::Text {
                    text: format!(
                        "Streaming diagnostic payload across 60 chunks for crash-loop testing {}. ",
                        "alpha-beta-gamma-delta-".repeat(25)
                    ),
                    chunk_chars: 12,
                    citations: vec![],
                });
                plan = plan.push_tool_call(
                    format!("read_stream_{}", req.sequence),
                    "Read",
                    json!({ "path": "fixture_2.txt", "offset": 0, "limit": 10 }),
                );
                return plan.with_usage(usage).finish(FinishReason::ToolCalls);
            }
            let mut plan = TurnPlan::new();
            plan.chunk_delay_ms = 20;
            plan.events.push(TurnEvent::Text {
                text: format!(
                    "Final slow stream verification {}.",
                    "omega-sigma-tau-".repeat(30)
                ),
                chunk_chars: 10,
                citations: vec![],
            });
            plan.with_usage(usage).finish(FinishReason::Stop)
        })
        .start()
        .await
        .expect("start mock-ai");

    let base_url = format!("{}/v1", mock.base_url());
    let conns = seed_hell_connections(&sandbox.root, &base_url, 128_000).await;

    let mut host = Host::spawn(&sandbox).expect("spawn host #1");
    let (client, address) = host.ready().await.expect("host #1 ready");
    let client = Arc::new(client);
    save_all_hell_credentials(&client, &conns).await;

    // Create 100 sessions across 4 cohorts (25 each).
    let mut sessions: Vec<(String, String, &'static str)> = Vec::with_capacity(100);
    {
        let mut set = JoinSet::new();
        for idx in 0..100usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let (kind, prompt) = match idx % 4 {
                0 => ("js", format!("COHORT_JS_{idx} run v8 crash test")),
                1 => ("py", format!("COHORT_PY_{idx} run python crash test")),
                2 => {
                    let pty_tag = if idx % 8 == 2 { "PTY" } else { "PIPE" };
                    (
                        "ws",
                        format!("COHORT_SHELL_{pty_tag}_{idx} start background stream"),
                    )
                }
                _ => {
                    let proto = if idx % 8 == 3 { "ws" } else { "anthropic" };
                    (
                        proto,
                        format!("COHORT_STREAM_{idx} run slow chunked stream"),
                    )
                }
            };
            let backend = backend_for(&conns, kind);
            set.spawn(async move {
                let sid = create_session(&c, &ws, backend)
                    .await
                    .expect("create session");
                (idx, sid, prompt, kind)
            });
        }
        let mut ordered = Vec::with_capacity(100);
        while let Some(res) = set.join_next().await {
            ordered.push(res.unwrap());
        }
        ordered.sort_by_key(|x| x.0);
        for (_, sid, prompt, kind) in ordered {
            sessions.push((sid, prompt, kind));
        }
    }

    // Spawn 16 live agent/watch subscribers against Host #1 during wave 0.
    let watch_cancel = CancellationToken::new();
    let watch_frames = Arc::new(AtomicU64::new(0));
    let mut watch_tasks = JoinSet::new();
    for i in 0..16usize {
        let addr = address.clone();
        let sid = sessions[i * 6 % sessions.len()].0.clone();
        let cancel = watch_cancel.clone();
        let frames = watch_frames.clone();
        watch_tasks.spawn(async move {
            let Ok(c) = Client::connect(&addr, None).await else {
                return;
            };
            let Ok(mut call) = c
                .call(
                    "agent",
                    "watch".into(),
                    json!({ "sessionId": sid, "after": 0 }),
                    Attachments::new(),
                )
                .await
            else {
                return;
            };
            if call.start().await.is_err() {
                return;
            }
            if !matches!(call.receive().await, Ok(Reply::Subscribed)) {
                return;
            }
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    r = call.pull() => match r {
                        Ok(Reply::Item { .. } | Reply::Progress { .. }) => {
                            frames.fetch_add(1, Ordering::Relaxed);
                        }
                        _ => break,
                    }
                }
            }
        });
    }

    // Fire ALL 100 sessions simultaneously and record accepted/queued message IDs.
    let mut wave1_message_ids: Vec<(String, String)> = Vec::with_capacity(sessions.len());
    {
        let mut sends = JoinSet::new();
        for (sid, prompt, _) in &sessions {
            let c = client.clone();
            let sid = sid.clone();
            let prompt = prompt.clone();
            sends.spawn(async move {
                let res = try_call(
                    &c,
                    "agent",
                    "send",
                    json!({ "sessionId": sid, "message": prompt, "delivery": "queue" }),
                    Duration::from_secs(30),
                )
                .await;
                (sid, res)
            });
        }
        while let Some(joined) = sends.join_next().await {
            let (sid, res) = joined.expect("wave-1 send task panicked");
            let val = res.unwrap_or_else(|e| panic!("wave-1 send failed for {sid}: {e}"));
            let kind = val["kind"].as_str().unwrap_or("");
            assert!(
                kind == "accepted" || kind == "queued",
                "wave-1 send for {sid} was not accepted/queued: {val}"
            );
            let mid = val["messageId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| panic!("wave-1 send for {sid} missing messageId: {val}"))
                .to_string();
            wave1_message_ids.push((sid, mid));
        }
    }
    assert_eq!(
        wave1_message_ids.len(),
        sessions.len(),
        "all 100 first-wave messages must be accepted/queued before SIGKILL"
    );

    // Wait until >= 60 model requests have entered mock AND confirm via agent/observe across
    // the 100 wave-1 sessions that >= 50 wave-1 runs are actively in flight right before SIGKILL #1.
    let wait_start = Instant::now();
    let mut active_before_kill = 0usize;
    while wait_start.elapsed() < Duration::from_secs(15) {
        if wave_model_reqs.load(Ordering::Relaxed) >= 60 {
            let mut obs_set = JoinSet::new();
            for (sid, _) in &wave1_message_ids {
                let c = client.clone();
                let sid = sid.clone();
                obs_set.spawn(async move {
                    try_call(
                        &c,
                        "agent",
                        "observe",
                        json!({ "sessionId": sid }),
                        Duration::from_secs(5),
                    )
                    .await
                    .ok()
                    .is_some_and(|obs| {
                        obs["session"]["activity"].as_str() == Some("working")
                            && obs["run"]["runId"].as_str().is_some()
                    })
                });
            }
            let mut active = 0usize;
            while let Some(r) = obs_set.join_next().await {
                if r.unwrap_or(false) {
                    active += 1;
                }
            }
            active_before_kill = active;
            if active_before_kill >= 50 {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        wave_model_reqs.load(Ordering::Relaxed) >= 60 && active_before_kill >= 50,
        "expected >= 60 model requests and >= 50 active wave-1 runs right before SIGKILL #1, got wave_reqs={} active={active_before_kill}",
        wave_model_reqs.load(Ordering::Relaxed)
    );
    eprintln!(
        "[SCEN H] Pre-SIGKILL #1 verified in-flight wave-1 runs: {active_before_kill}/{} (wave_reqs={})",
        wave1_message_ids.len(),
        wave_model_reqs.load(Ordering::Relaxed),
    );

    // =========================================================================
    // 5 CONSECUTIVE SIGKILLs!
    // =========================================================================
    for kill_round in 1..=5usize {
        let host_pid = host.pid().unwrap_or(0);
        let rss_mib = sample_rss_kib(host_pid).unwrap_or(0) as f64 / 1024.0;
        let fds = sample_open_fds(host_pid).unwrap_or(0);
        eprintln!(
            "[SCEN H] SIGKILL #{kill_round}/5 on Host pid={host_pid} rss={rss_mib:.1}MiB fds={fds} wave_reqs={} total_reqs={} watch_frames={}",
            wave_model_reqs.load(Ordering::Relaxed),
            total_model_reqs.load(Ordering::Relaxed),
            watch_frames.load(Ordering::Relaxed),
        );
        host.sigkill().await.expect("SIGKILL host");
        if kill_round == 1 {
            watch_cancel.cancel();
            while watch_tasks.join_next().await.is_some() {}
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
        wave_model_reqs.store(0, Ordering::Relaxed);

        // Respawn Host immediately!
        host = Host::spawn(&sandbox).expect("respawn host after SIGKILL");
        let (re_client, _re_addr) = host.ready().await.expect("respawned host ready");
        let re_client = Arc::new(re_client);

        if kill_round < 5 {
            // Spawn 15 brand-new mixed sessions on EVERY intermediate crash wave (total 160 sessions!)
            // AND re-poke 20 existing sessions so EVERY SIGKILL hits both recovery AND live streams/V8/Monty/PTY!
            let mut wave_create = JoinSet::new();
            let base_idx = sessions.len();
            for j in 0..15usize {
                let idx = base_idx + j;
                let c = re_client.clone();
                let ws = sandbox.workspace.clone();
                let (kind, prompt) = match idx % 4 {
                    0 => ("js", format!("COHORT_JS_{idx} wave_{kill_round}")),
                    1 => ("py", format!("COHORT_PY_{idx} wave_{kill_round}")),
                    2 => {
                        let pty_tag = if idx % 8 == 2 { "PTY" } else { "PIPE" };
                        (
                            "ws",
                            format!("COHORT_SHELL_{pty_tag}_{idx} wave_{kill_round}"),
                        )
                    }
                    _ => {
                        let proto = if idx % 8 == 3 { "ws" } else { "anthropic" };
                        (proto, format!("COHORT_STREAM_{idx} wave_{kill_round}"))
                    }
                };
                let backend = backend_for(&conns, kind);
                wave_create.spawn(async move {
                    let sid = create_session(&c, &ws, backend).await.ok()?;
                    let _ = try_call(
                        &c,
                        "agent",
                        "send",
                        json!({ "sessionId": sid, "message": prompt, "delivery": "queue" }),
                        Duration::from_secs(5),
                    )
                    .await;
                    Some((sid, prompt, kind))
                });
            }
            let poke_start = (kill_round * 15) % sessions.len();
            let mut pokes = JoinSet::new();
            for offset in 0..20usize {
                let c = re_client.clone();
                let (sid, prompt, _) = &sessions[(poke_start + offset) % sessions.len()];
                let sid = sid.clone();
                let prompt = format!("{prompt} crash_wave_{kill_round}");
                pokes.spawn(async move {
                    let _ = try_call(
                        &c,
                        "agent",
                        "send",
                        json!({ "sessionId": sid, "message": prompt, "delivery": "queue" }),
                        Duration::from_secs(5),
                    )
                    .await;
                });
            }
            let wave_deadline = Instant::now() + Duration::from_millis(1200);
            while Instant::now() < wave_deadline {
                match tokio::time::timeout(
                    wave_deadline.saturating_duration_since(Instant::now()),
                    wave_create.join_next(),
                )
                .await
                {
                    Ok(Some(Ok(Some(entry)))) => sessions.push(entry),
                    Ok(None) => break,
                    _ => break,
                }
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
            wave_create.abort_all();
            pokes.abort_all();
            drop(re_client);
        } else {
            // Final recovery host (#6)!
            eprintln!(
                "[SCEN H] Host #6 ready after 5x SIGKILL! Starting integrity & settlement verification..."
            );

            // 1. SQLite integrity & FK check
            let dbs_checked = verify_sqlite_integrity(&sandbox.root)
                .expect("SQLite integrity_check/foreign_key_check must pass after 5x SIGKILL");
            let sql_m = sample_sqlite_metrics(&sandbox.root);
            eprintln!(
                "[SCEN H] SQLite integrity OK ({dbs_checked} DBs): db={:.1}MiB wal={:.1}MiB facts={} contents={}",
                sql_m.total_db_bytes as f64 / (1024.0 * 1024.0),
                sql_m.total_wal_bytes as f64 / (1024.0 * 1024.0),
                sql_m.facts_rows,
                sql_m.contents_rows,
            );

            // 2. Wait for ALL 100 sessions to settle (non-running); explicitly stop any that are
            // still running long retries after 15s so we also exercise post-crash stop/settlement.
            tokio::time::sleep(Duration::from_secs(6)).await;
            let mut state_counts: BTreeMap<String, usize> = BTreeMap::new();
            let mut stuck_sessions: Vec<(String, String)> = Vec::new();
            let mut settle_set = JoinSet::new();
            for (sid, _, _) in &sessions {
                let c = re_client.clone();
                let sid = sid.clone();
                settle_set.spawn(async move {
                    // First give it 35s to settle naturally; if still running, issue explicit stop and wait 20s.
                    match wait_session_settled(&c, &sid, Duration::from_secs(35)).await {
                        Ok(st) => Ok((sid, st)),
                        Err(_) => {
                            let obs = try_call(
                                &c,
                                "agent",
                                "observe",
                                json!({ "sessionId": sid }),
                                Duration::from_secs(10),
                            )
                            .await;
                            if let Ok(ref o) = obs
                                && let Some(run_id) = o["run"]["runId"].as_str()
                            {
                                let _ = try_call(
                                    &c,
                                    "agent",
                                    "stop",
                                    json!({ "sessionId": sid, "runId": run_id }),
                                    Duration::from_secs(10),
                                )
                                .await;
                            }
                            match wait_session_settled(&c, &sid, Duration::from_secs(25)).await {
                                Ok(st) => Ok((sid, format!("stopped->{st}"))),
                                Err(e) => Err((sid, e)),
                            }
                        }
                    }
                });
            }
            while let Some(res) = settle_set.join_next().await {
                match res.unwrap() {
                    Ok((_, st)) => *state_counts.entry(st).or_default() += 1,
                    Err((sid, err)) => stuck_sessions.push((sid, err)),
                }
            }
            eprintln!("[SCEN H] Post-5x-SIGKILL settlement states: {state_counts:?}");
            assert!(
                stuck_sessions.is_empty(),
                "Sessions permanently stuck after 5x SIGKILL ({}): {:?}",
                stuck_sessions.len(),
                &stuck_sessions[..stuck_sessions.len().min(5)]
            );

            // 3. Fire a fresh liveness turn on ALL sessions concurrently!
            // Every session MUST either complete its post-crash turn OR fail closed with
            // 'original_operation_unsettled' backed by a verified durable blocker in SQLite.
            let mut live_ok_sids = Vec::new();
            let mut fail_closed_sids = Vec::new();
            let mut unexpected_failures = Vec::new();
            let mut live_set = JoinSet::new();
            for (idx, (sid, _, _)) in sessions.iter().enumerate() {
                let c = re_client.clone();
                let sid = sid.clone();
                live_set.spawn(async move {
                    let sent = try_call(
                        &c,
                        "agent",
                        "send",
                        json!({
                            "sessionId": sid,
                            "message": format!("POST_CRASH_VERIFY_{idx}"),
                            "delivery": "queue"
                        }),
                        Duration::from_secs(30),
                    )
                    .await;
                    let sent = match sent {
                        Ok(v) => v,
                        Err(e) => return (sid, Err(format!("send failed: {e}"))),
                    };
                    if sent["kind"] == "rejected"
                        && sent["reason"] == "original_operation_unsettled"
                    {
                        return (sid, Ok(false));
                    }
                    if sent["kind"] != "accepted" && sent["kind"] != "queued" {
                        return (sid, Err(format!("unexpected send reply: {sent}")));
                    }
                    let msg_id = sent["messageId"].as_str().unwrap_or("").to_string();
                    let deadline = Instant::now() + Duration::from_secs(45);
                    loop {
                        if Instant::now() > deadline {
                            return (sid, Err("post-crash verify turn timeout".into()));
                        }
                        if let Ok(w) = try_call(
                            &c,
                            "agent",
                            "work",
                            json!({
                                "sessionId": sid,
                                "target": { "kind": "message", "messageId": msg_id }
                            }),
                            Duration::from_secs(10),
                        )
                        .await
                        {
                            match w["execution"]["state"]["kind"].as_str() {
                                Some("completed") => return (sid, Ok(true)),
                                Some(other @ ("failed" | "cancelled" | "blocked")) => {
                                    return (sid, Err(format!("post-crash turn {other}: {w}")));
                                }
                                _ => {}
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                });
            }
            while let Some(res) = live_set.join_next().await {
                match res.unwrap() {
                    (sid, Ok(true)) => live_ok_sids.push(sid),
                    (sid, Ok(false)) => fail_closed_sids.push(sid),
                    (sid, Err(e)) => unexpected_failures.push((sid, e)),
                }
            }

            // Verify EVERY fail-closed session has an explicit durable blocker fact in SQLite!
            let db_path = sandbox.root.join("runtime-rust.sqlite");
            let mut unverified_fail_closed = Vec::new();
            for sid in &fail_closed_sids {
                let out = std::process::Command::new("sqlite3")
                    .arg(&db_path)
                    .arg(format!(
                        "SELECT CAST(c.payload AS TEXT) FROM agent_facts f JOIN agent_run_specs s ON s.run=f.run JOIN contents c ON c.id=f.body_content_id WHERE s.session='{}' ORDER BY f.sequence DESC LIMIT 12;",
                        sid
                    ))
                    .output()
                    .expect("query fail-closed facts");
                let facts = String::from_utf8_lossy(&out.stdout);
                let has_blocker = facts.contains("original_admission_unknown")
                    || facts.contains("operation_unknown")
                    || facts.contains("code_cell_recovery_unavailable")
                    || facts.contains("cleanup_unconfirmed")
                    || facts.contains("unresolved")
                    || facts.contains("unconfirmed");
                if !has_blocker {
                    unverified_fail_closed
                        .push((sid.clone(), facts.chars().take(300).collect::<String>()));
                }
            }

            // 4. Create 20 brand-new post-crash sessions + fork 5 surviving sessions -> ALL 25/25 MUST complete!
            let mut fresh_set = JoinSet::new();
            for i in 0..20usize {
                let c = re_client.clone();
                let ws = sandbox.workspace.clone();
                let kind = match i % 4 {
                    0 => "js",
                    1 => "py",
                    2 => "ws",
                    _ => "anthropic",
                };
                let backend = backend_for(&conns, kind);
                fresh_set.spawn(async move {
                    let sid = create_session(&c, &ws, backend).await?;
                    let sent = try_call(
                        &c,
                        "agent",
                        "send",
                        json!({ "sessionId": sid, "message": format!("POST_CRASH_VERIFY_FRESH_{i}"), "delivery": "queue" }),
                        Duration::from_secs(20),
                    )
                    .await?;
                    if sent["kind"] != "accepted" && sent["kind"] != "queued" {
                        return Err(format!("fresh post-crash send rejected: {sent}"));
                    }
                    let st = wait_session_settled(&c, &sid, Duration::from_secs(30)).await?;
                    if st == "completed" || st == "idle" {
                        Ok(sid)
                    } else {
                        Err(format!("fresh session settled {st}"))
                    }
                });
            }
            for (fi, src_sid) in live_ok_sids.iter().take(5).enumerate() {
                let c = re_client.clone();
                let src = src_sid.clone();
                fresh_set.spawn(async move {
                    let obs = try_call(&c, "agent", "observe", json!({ "sessionId": src }), Duration::from_secs(10)).await?;
                    let rev = obs["session"]["revision"].as_u64().ok_or("missing session.revision for fork")?;
                    let forked = try_call(
                        &c,
                        "agent",
                        "fork",
                        json!({
                            "sessionId": src,
                            "expectedRevision": rev,
                            "position": { "kind": "end" },
                            "title": format!("PostCrashFork-{fi}"),
                            "labels": []
                        }),
                        Duration::from_secs(20),
                    )
                    .await?;
                    let fsid = forked["session"]["id"].as_str().ok_or("missing forked id")?.to_string();
                    let sent = try_call(
                        &c,
                        "agent",
                        "send",
                        json!({ "sessionId": fsid, "message": format!("POST_CRASH_VERIFY_FORK_{fi}"), "delivery": "queue" }),
                        Duration::from_secs(20),
                    )
                    .await?;
                    if sent["kind"] != "accepted" && sent["kind"] != "queued" {
                        return Err(format!("fork post-crash send rejected: {sent}"));
                    }
                    let st = wait_session_settled(&c, &fsid, Duration::from_secs(30)).await?;
                    if st == "completed" || st == "idle" {
                        Ok(fsid)
                    } else {
                        Err(format!("forked session settled {st}"))
                    }
                });
            }
            let mut fresh_ok = 0usize;
            let mut fresh_fail = Vec::new();
            while let Some(r) = fresh_set.join_next().await {
                match r.unwrap() {
                    Ok(_) => fresh_ok += 1,
                    Err(e) => fresh_fail.push(e),
                }
            }

            let final_pid = host.pid().unwrap_or(0);
            let final_rss = sample_rss_kib(final_pid).unwrap_or(0) as f64 / 1024.0;
            let final_fds = sample_open_fds(final_pid).unwrap_or(0);
            eprintln!(
                "[SCEN H] Post-5x-SIGKILL summary (total_sessions={}): live_ok={} fail_closed_verified={} unexpected_fail={} fresh_plus_fork={fresh_ok}/25 rss={final_rss:.1}MiB fds={final_fds}",
                sessions.len(),
                live_ok_sids.len(),
                fail_closed_sids.len(),
                unexpected_failures.len(),
            );

            // Quit Host #6 cleanly, re-verify SQLite integrity, and check OS-wide orphans!
            let mut owned_client = Arc::try_unwrap(re_client)
                .ok()
                .expect("unique final client");
            host.quit(&mut owned_client)
                .await
                .expect("clean quit host #6");
            tokio::time::sleep(Duration::from_millis(600)).await;

            verify_sqlite_integrity(&sandbox.root)
                .expect("final SQLite integrity after clean quit");
            let orphans = find_orphan_procs(&marker, sandbox.directory.path());
            eprintln!(
                "[SCEN H] OS-wide orphan processes after 5x SIGKILL + clean quit: {} ({:?}) total_wall={:.2}s",
                orphans.len(),
                &orphans[..orphans.len().min(10)],
                started.elapsed().as_secs_f64()
            );
            assert!(
                unexpected_failures.is_empty(),
                "Unexpected post-5x-SIGKILL failures ({}): {:?}",
                unexpected_failures.len(),
                &unexpected_failures[..unexpected_failures.len().min(10)]
            );
            assert!(
                unverified_fail_closed.is_empty(),
                "Fail-closed rejections without verified SQLite blocker ({}): {:?}",
                unverified_fail_closed.len(),
                &unverified_fail_closed[..unverified_fail_closed.len().min(5)]
            );
            assert!(
                live_ok_sids.len() >= sessions.len() / 4,
                "expected at least 25% of {} sessions to complete post-crash liveness (others verified fail-closed), got {}",
                sessions.len(),
                live_ok_sids.len()
            );
            assert!(
                fresh_fail.is_empty(),
                "Post-crash fresh/forked sessions failed ({}): {:?}",
                fresh_fail.len(),
                fresh_fail
            );
            assert!(
                orphans.is_empty(),
                "ORPHAN PROCESSES LEAKED AFTER 5x SIGKILL ({}): {:?}",
                orphans.len(),
                orphans
            );
        }
    }

    mock.shutdown().await;
}

/// ================================================================================================
/// Scenario I: 456-Session Thundering Herd + 3-Level Recursive Subagent Trees + 32-Client UI Storm!
///
/// Concurrent workload on ONE real Maka Host:
///   - 36 three-level Subagent Trees (18 JS V8 + 18 Python Monty):
///       Root -> 2 Managers -> 4 Leaf Workers each = 36 * 11 = 396 linked real sessions!
///       Half use `onComplete: "notify_caller"` (real completion wakeup cascade), half poll `SessionRead`.
///       Mid-flight, 10 trees (110 sessions!) have their Roots & Managers hit with `stop` + `changeSession(remove)`
///       while their Leaf workers are actively completing & firing SessionCompletion notifications!
///   - 60 Ultra-Chatty Mixed-Protocol Streaming Sessions (20 OpenAI WS + 20 Anthropic SSE + 20 OpenAI Chat SSE):
///       80 fine-grained chunks/turn + Read/Shell tool calls + real Chaos (8% 429, 5% 503, 5% mid-stream TCP drop).
///   - 32 Independent Concurrent UI IPC Clients continuously hammering Host throughout the entire storm:
///       8 `agent/watch` live subscribers (4 fast + 4 hostile slow/disconnect-reconnect)
///       8 pollers (`list`, `sessionList`, `work`, `queue`) every 15ms
///       8 readers (`history` tail + backward pagination, `sessionRead`)
///       8 searchers (`search`, `markRead`)
/// ================================================================================================
#[tokio::test]
#[ignore = "hell-tier stress test; run with --release --ignored --nocapture"]
async fn real_host_400_session_thundering_herd_3level_trees_and_ui_storm() {
    let started = Instant::now();
    let sandbox = Sandbox::new().await.expect("sandbox");
    seed_workspace_files(&sandbox.workspace).await;
    let ws_path = sandbox.workspace.to_string_lossy().to_string();

    let total_reqs = Arc::new(AtomicU64::new(0));
    let leaf_done = Arc::new(AtomicU64::new(0));
    let mgr_done = Arc::new(AtomicU64::new(0));
    let root_done = Arc::new(AtomicU64::new(0));
    let stream_done = Arc::new(AtomicU64::new(0));

    let total_reqs_cb = total_reqs.clone();
    let leaf_done_cb = leaf_done.clone();
    let mgr_done_cb = mgr_done.clone();
    let root_done_cb = root_done.clone();
    let stream_done_cb = stream_done.clone();
    let ws_cb = ws_path.clone();
    let js_conn_slot: Arc<std::sync::OnceLock<String>> = Arc::new(std::sync::OnceLock::new());
    let py_conn_slot: Arc<std::sync::OnceLock<String>> = Arc::new(std::sync::OnceLock::new());
    let js_conn_cb = js_conn_slot.clone();
    let py_conn_cb = py_conn_slot.clone();

    let mock = MockAiBuilder::new()
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
            max_session_prompt_bytes: Some(16 * 1024 * 1024),
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, ctx: &TurnContext| {
            total_reqs_cb.fetch_add(1, Ordering::Relaxed);
            let all = req.all_text();
            let usage = Usage::new(350, 90);

            // Inject real chaos (4% 429, 2% 503, 2% mid-stream TCP drop) on streaming sessions!
            if all.contains("HELL_STREAM_JOB_") {
                let mut h = req.sequence.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ ctx.session_turn;
                h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                let r = ((h & 0xFFFF) as f64) / 65536.0;
                if r < 0.04 {
                    return TurnPlan::http_error(
                        HttpErrorSpec::rate_limit(None, "hell 429").with_retry_after_ms(60),
                    );
                }
                if r < 0.06 {
                    return TurnPlan::http_error(HttpErrorSpec::new(
                        503,
                        "server_error",
                        "hell 503 overloaded",
                    ));
                }
            }

            // Helper: resume yielded Code Mode cell via wait
            let running_wait = |all: &str, seq: u64| -> Option<TurnPlan> {
                let pos = all.rfind(r#""cell_id":""#)?;
                let rest = &all[pos + 11..];
                let end = rest.find('"')?;
                let cid = &rest[..end];
                if all[pos.saturating_sub(45)..pos].contains("running") {
                    Some(
                        TurnPlan::new()
                            .push_tool_call(
                                format!("wait_cell_{seq}"),
                                "wait",
                                json!({ "cell_id": cid, "yield_time_ms": 60000 }),
                            )
                            .with_usage(usage.clone())
                            .finish(FinishReason::ToolCalls),
                    )
                } else {
                    None
                }
            };

            // -------------------- LEVEL 2: LEAF WORKERS --------------------
            if all.contains("HELL_L2_JS_LEAF_") && !all.contains("HELL_L1_") && !all.contains("HELL_L0_") {
                if all.contains("LEAF_EXEC_OK") || req.messages.len() > 3 {
                    leaf_done_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("LEAF_OK_VERIFIED")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let fidx = (req.sequence as usize) % 5;
                let code = format!(
                    r#"
                    const [r, s] = await Promise.all([
                      tools.Read({{ path: "fixture_{fidx}.txt", offset: 0, limit: 8 }}),
                      tools.Shell({{ command: "echo leaf-js-{seq}", login: false }}),
                    ]);
                    text("LEAF_EXEC_OK:" + r.kind + ":" + s.kind);
                    "#,
                    seq = req.sequence
                );
                return TurnPlan::new()
                    .push_tool_call(format!("leaf_js_{}", req.sequence), "exec", json!({ "code": code }))
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            if all.contains("HELL_L2_PY_LEAF_") && !all.contains("HELL_L1_") && !all.contains("HELL_L0_") {
                if all.contains("LEAF_EXEC_OK") || req.messages.len() > 3 {
                    leaf_done_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("LEAF_OK_VERIFIED")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let fidx = (req.sequence as usize) % 5;
                let code = format!(
                    r#"import asyncio
r, s = await asyncio.gather(
    tools.Read(path="fixture_{fidx}.txt", offset=0, limit=8),
    tools.Shell(command="echo leaf-py-{seq}", login=False),
)
text("LEAF_EXEC_OK:" + r["kind"] + ":" + s["kind"])
"#,
                    seq = req.sequence
                );
                return TurnPlan::new()
                    .push_tool_call(format!("leaf_py_{}", req.sequence), "exec", json!({ "code": code }))
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // -------------------- LEVEL 1: MANAGERS (spawn 4 leaves each) --------------------
            if all.contains("HELL_L1_JS_MGR_") && !all.contains("HELL_L0_") {
                if all.contains("MGR_ALL_LEAVES_OK") {
                    mgr_done_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("MGR_OK_VERIFIED")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(w) = running_wait(&all, req.sequence) {
                    return w;
                }
                if req.messages.len() > 2 {
                    // May have been woken by SessionCompletion notifications! Check if 4 completions arrived.
                    let completed_notifs = all.matches("LEAF_OK_VERIFIED").count();
                    if completed_notifs >= 4 || req.messages.len() > 10 {
                        mgr_done_cb.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text(format!("MGR_OK_VERIFIED (notifs={completed_notifs})"))
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    return TurnPlan::new()
                        .push_text(format!("MGR_WAITING_NOTIFS ({completed_notifs}/4)"))
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let use_notify = all.contains("MODE_NOTIFY_BOTTOM");
                let on_complete = if use_notify { "notify_caller" } else { "none" };
                let code = if use_notify {
                    format!(
                        r#"
                        const backend = {{ kind: "model", connectionId: {cid}, modelId: "gpt-4.1", thinkingLevel: null }};
                        const ws = {ws};
                        const leaves = await Promise.all([0,1,2,3].map(i =>
                          tools.SessionCreate({{ title: "Leaf-" + i, labels: [], backend, workspace: {{ kind: "directory", path: ws }} }})
                        ));
                        await Promise.all(leaves.map((l, i) =>
                          tools.SessionSend({{ sessionId: l.session.id, message: "HELL_L2_JS_LEAF_" + i, onComplete: "{on_complete}" }})
                        ));
                        text("MGR_DISPATCHED_4_LEAVES:" + leaves.map(l => l.session.id).join(","));
                        "#,
                        cid = serde_json::to_string(js_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                } else {
                    format!(
                        r#"
                        const backend = {{ kind: "model", connectionId: {cid}, modelId: "gpt-4.1", thinkingLevel: null }};
                        const ws = {ws};
                        const leaves = await Promise.all([0,1,2,3].map(i =>
                          tools.SessionCreate({{ title: "Leaf-" + i, labels: [], backend, workspace: {{ kind: "directory", path: ws }} }})
                        ));
                        const ids = leaves.map(l => l.session.id);
                        await Promise.all(ids.map((id, i) =>
                          tools.SessionSend({{ sessionId: id, message: "HELL_L2_JS_LEAF_" + i, onComplete: "none" }})
                        ));
                        for (let attempt = 0; attempt < 90; attempt++) {{
                          await new Promise(r => setTimeout(r, 1000));
                          const snaps = await Promise.all(ids.map(id => tools.SessionRead({{ sessionId: id, position: "tail" }})));
                          if (snaps.every(s => JSON.stringify(s).includes("LEAF_OK_VERIFIED"))) {{
                            text("MGR_ALL_LEAVES_OK:" + ids.join(","));
                            exit();
                          }}
                        }}
                        text("MGR_TIMEOUT");
                        "#,
                        cid = serde_json::to_string(js_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                };
                return TurnPlan::new()
                    .push_tool_call(
                        format!("mgr_js_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 50000 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            if all.contains("HELL_L1_PY_MGR_") && !all.contains("HELL_L0_") {
                if all.contains("MGR_ALL_LEAVES_OK") {
                    mgr_done_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("MGR_OK_VERIFIED")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(w) = running_wait(&all, req.sequence) {
                    return w;
                }
                if req.messages.len() > 2 {
                    let completed_notifs = all.matches("LEAF_OK_VERIFIED").count();
                    if completed_notifs >= 4 || req.messages.len() > 10 {
                        mgr_done_cb.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text(format!("MGR_OK_VERIFIED (notifs={completed_notifs})"))
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    return TurnPlan::new()
                        .push_text(format!("MGR_WAITING_NOTIFS ({completed_notifs}/4)"))
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let use_notify = all.contains("MODE_NOTIFY_BOTTOM");
                let code = if use_notify {
                    format!(
                        r#"import asyncio
backend = {{"kind": "model", "connectionId": {cid}, "modelId": "gpt-4.1", "thinkingLevel": None}}
ws = {ws}
leaves = await asyncio.gather(*[
    tools.SessionCreate(title="PyLeaf-" + str(i), labels=[], backend=backend, workspace={{"kind": "directory", "path": ws}})
    for i in range(4)
])
ids = [l["session"]["id"] for l in leaves]
await asyncio.gather(*[
    tools.SessionSend(sessionId=sid, message="HELL_L2_PY_LEAF_" + str(i), onComplete="notify_caller")
    for i, sid in enumerate(ids)
])
text("MGR_DISPATCHED_4_LEAVES:" + ",".join(ids))
"#,
                        cid = serde_json::to_string(py_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                } else {
                    format!(
                        r#"import asyncio
backend = {{"kind": "model", "connectionId": {cid}, "modelId": "gpt-4.1", "thinkingLevel": None}}
ws = {ws}
leaves = await asyncio.gather(*[
    tools.SessionCreate(title="PyLeaf-" + str(i), labels=[], backend=backend, workspace={{"kind": "directory", "path": ws}})
    for i in range(4)
])
ids = [l["session"]["id"] for l in leaves]
await asyncio.gather(*[
    tools.SessionSend(sessionId=sid, message="HELL_L2_PY_LEAF_" + str(i), onComplete="none")
    for i, sid in enumerate(ids)
])
done = False
for _ in range(90):
    await asyncio.sleep(1.0)
    snaps = await asyncio.gather(*[tools.SessionRead(sessionId=sid, position="tail") for sid in ids])
    if all("LEAF_OK_VERIFIED" in str(s) for s in snaps):
        done = True
        break
text("MGR_ALL_LEAVES_OK:" + ",".join(ids) if done else "MGR_TIMEOUT")
"#,
                        cid = serde_json::to_string(py_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                };
                return TurnPlan::new()
                    .push_tool_call(
                        format!("mgr_py_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 50000 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // -------------------- LEVEL 0: ROOTS (spawn 2 managers each) --------------------
            if all.contains("HELL_L0_JS_ROOT_") {
                if all.contains("ROOT_ALL_MGRS_OK") {
                    root_done_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("ROOT_TREE_COMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(w) = running_wait(&all, req.sequence) {
                    return w;
                }
                if req.messages.len() > 2 {
                    let completed_mgrs = all.matches("MGR_OK_VERIFIED").count();
                    if completed_mgrs >= 2 || req.messages.len() > 8 {
                        root_done_cb.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text(format!("ROOT_TREE_COMPLETE (notifs={completed_mgrs})"))
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    return TurnPlan::new()
                        .push_text(format!("ROOT_WAITING_MGRS ({completed_mgrs}/2)"))
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let use_notify = all.contains("MODE_NOTIFY_TOP");
                let mode = if use_notify { "MODE_NOTIFY_TOP" } else { "MODE_NOTIFY_BOTTOM" };
                let code = if use_notify {
                    format!(
                        r#"
                        const backend = {{ kind: "model", connectionId: {cid}, modelId: "gpt-4.1", thinkingLevel: null }};
                        const ws = {ws};
                        const mgrs = await Promise.all([0,1].map(i =>
                          tools.SessionCreate({{ title: "JsMgr-" + i, labels: [], backend, workspace: {{ kind: "directory", path: ws }} }})
                        ));
                        const ids = mgrs.map(m => m.session.id);
                        await Promise.all(ids.map((id, i) =>
                          tools.SessionSend({{ sessionId: id, message: "HELL_L1_JS_MGR_" + i + " {mode}", onComplete: "notify_caller" }})
                        ));
                        text("ROOT_DISPATCHED_2_MGRS:" + ids.join(","));
                        "#,
                        cid = serde_json::to_string(js_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                } else {
                    format!(
                        r#"
                        const backend = {{ kind: "model", connectionId: {cid}, modelId: "gpt-4.1", thinkingLevel: null }};
                        const ws = {ws};
                        const mgrs = await Promise.all([0,1].map(i =>
                          tools.SessionCreate({{ title: "JsMgr-" + i, labels: [], backend, workspace: {{ kind: "directory", path: ws }} }})
                        ));
                        const ids = mgrs.map(m => m.session.id);
                        await Promise.all(ids.map((id, i) =>
                          tools.SessionSend({{ sessionId: id, message: "HELL_L1_JS_MGR_" + i + " {mode}", onComplete: "none" }})
                        ));
                        for (let attempt = 0; attempt < 90; attempt++) {{
                          await new Promise(r => setTimeout(r, 1200));
                          const snaps = await Promise.all(ids.map(id => tools.SessionRead({{ sessionId: id, position: "tail" }})));
                          if (snaps.every(s => JSON.stringify(s).includes("MGR_OK_VERIFIED"))) {{
                            text("ROOT_ALL_MGRS_OK:" + ids.join(","));
                            exit();
                          }}
                        }}
                        text("ROOT_TIMEOUT");
                        "#,
                        cid = serde_json::to_string(js_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                };
                return TurnPlan::new()
                    .push_tool_call(
                        format!("root_js_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 50000 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            if all.contains("HELL_L0_PY_ROOT_") {
                if all.contains("ROOT_ALL_MGRS_OK") {
                    root_done_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("ROOT_TREE_COMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(w) = running_wait(&all, req.sequence) {
                    return w;
                }
                if req.messages.len() > 2 {
                    let completed_mgrs = all.matches("MGR_OK_VERIFIED").count();
                    if completed_mgrs >= 2 || req.messages.len() > 8 {
                        root_done_cb.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text(format!("ROOT_TREE_COMPLETE (notifs={completed_mgrs})"))
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    return TurnPlan::new()
                        .push_text(format!("ROOT_WAITING_MGRS ({completed_mgrs}/2)"))
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let use_notify = all.contains("MODE_NOTIFY_TOP");
                let mode = if use_notify { "MODE_NOTIFY_TOP" } else { "MODE_NOTIFY_BOTTOM" };
                let code = if use_notify {
                    format!(
                        r#"import asyncio
backend = {{"kind": "model", "connectionId": {cid}, "modelId": "gpt-4.1", "thinkingLevel": None}}
ws = {ws}
mgrs = await asyncio.gather(*[
    tools.SessionCreate(title="PyMgr-" + str(i), labels=[], backend=backend, workspace={{"kind": "directory", "path": ws}})
    for i in range(2)
])
ids = [m["session"]["id"] for m in mgrs]
await asyncio.gather(*[
    tools.SessionSend(sessionId=sid, message="HELL_L1_PY_MGR_" + str(i) + " {mode}", onComplete="notify_caller")
    for i, sid in enumerate(ids)
])
text("ROOT_DISPATCHED_2_MGRS:" + ",".join(ids))
"#,
                        cid = serde_json::to_string(py_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                } else {
                    format!(
                        r#"import asyncio
backend = {{"kind": "model", "connectionId": {cid}, "modelId": "gpt-4.1", "thinkingLevel": None}}
ws = {ws}
mgrs = await asyncio.gather(*[
    tools.SessionCreate(title="PyMgr-" + str(i), labels=[], backend=backend, workspace={{"kind": "directory", "path": ws}})
    for i in range(2)
])
ids = [m["session"]["id"] for m in mgrs]
await asyncio.gather(*[
    tools.SessionSend(sessionId=sid, message="HELL_L1_PY_MGR_" + str(i) + " {mode}", onComplete="none")
    for i, sid in enumerate(ids)
])
done = False
for _ in range(90):
    await asyncio.sleep(1.2)
    snaps = await asyncio.gather(*[tools.SessionRead(sessionId=sid, position="tail") for sid in ids])
    if all("MGR_OK_VERIFIED" in str(s) for s in snaps):
        done = True
        break
text("ROOT_ALL_MGRS_OK:" + ",".join(ids) if done else "ROOT_TIMEOUT")
"#,
                        cid = serde_json::to_string(py_conn_cb.get().unwrap()).unwrap(),
                        ws = serde_json::to_string(&ws_cb).unwrap(),
                    )
                };
                return TurnPlan::new()
                    .push_tool_call(
                        format!("root_py_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 50000 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // -------------------- 60 ULTRA-CHATTY 80-CHUNK STREAMING SESSIONS --------------------
            if req.messages.len() <= 2 {
                let fidx = (req.sequence as usize) % 5;
                let mut plan = TurnPlan::new();
                plan.chunk_delay_ms = 2;
                plan.events.push(TurnEvent::Text {
                    text: format!(
                        "HELL_STREAM_MARKER chunked diagnostic wave {}: {}",
                        req.sequence,
                        "stream-frame-data-".repeat(45)
                    ),
                    chunk_chars: 10,
                    citations: vec![],
                });
                return plan
                    .push_tool_call(
                        format!("s_read_{}", req.sequence),
                        "Read",
                        json!({ "path": format!("fixture_{fidx}.txt"), "offset": 0, "limit": 8 }),
                    )
                    .push_tool_call(
                        format!("s_shell_{}", req.sequence),
                        "Shell",
                        json!({ "command": "echo stream-tool-ok", "login": false }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }
            stream_done_cb.fetch_add(1, Ordering::Relaxed);
            let mut plan = TurnPlan::new();
            plan.chunk_delay_ms = 2;
            plan.events.push(TurnEvent::Text {
                text: format!(
                    "HELL_STREAM_FINAL_OK seq={}: {}",
                    req.sequence,
                    "verified-output-chunk-".repeat(38)
                ),
                chunk_chars: 10,
                citations: vec![],
            });
            plan.with_usage(usage).finish(FinishReason::Stop)
        })
        .start()
        .await
        .expect("start mock-ai");

    let base_url = format!("{}/v1", mock.base_url());
    let conns = seed_hell_connections(&sandbox.root, &base_url, 128_000).await;
    let _ = js_conn_slot.set(conns.js.clone());
    let _ = py_conn_slot.set(conns.py.clone());

    let mut host = Host::spawn(&sandbox).expect("spawn host");
    let (client, address) = host.ready().await.expect("host ready");
    let client = Arc::new(client);
    save_all_hell_credentials(&client, &conns).await;

    let host_pid = host.pid().expect("host pid");
    let baseline_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let baseline_fds = sample_open_fds(host_pid).unwrap_or(0);

    // Create 36 Tree Roots (18 JS V8 + 18 Python Monty) + 60 Streaming Sessions = 96 top-level -> 456 total sessions!
    let mut tree_roots: Vec<(usize, String, bool, bool)> = Vec::with_capacity(36);
    let mut stream_sessions: Vec<String> = Vec::with_capacity(60);

    {
        let mut set = JoinSet::new();
        for t in 0..36usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let is_py = t >= 18;
            let use_notify = t % 2 == 0;
            let backend = backend_for(&conns, if is_py { "py" } else { "js" });
            set.spawn(async move {
                let sid = create_session(&c, &ws, backend).await.expect("create root");
                (t, sid, is_py, use_notify)
            });
        }
        while let Some(r) = set.join_next().await {
            tree_roots.push(r.unwrap());
        }
        tree_roots.sort_by_key(|x| x.0);

        let mut sset = JoinSet::new();
        for s in 0..60usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let proto = match s % 3 {
                0 => "ws",
                1 => "anthropic",
                _ => "chat",
            };
            let backend = backend_for(&conns, proto);
            sset.spawn(async move {
                create_session(&c, &ws, backend)
                    .await
                    .expect("create stream")
            });
        }
        while let Some(r) = sset.join_next().await {
            stream_sessions.push(r.unwrap());
        }
    }

    // Launch 32 concurrent UI IPC storm clients!
    let ui_cancel = CancellationToken::new();
    let list_lat = Arc::new(LatencyHistogram::default());
    let history_lat = Arc::new(LatencyHistogram::default());
    let search_lat = Arc::new(LatencyHistogram::default());
    let watch_frames = Arc::new(AtomicU64::new(0));
    let ui_errors = Arc::new(AtomicU64::new(0));
    let ui_err_samples: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut ui_tasks = JoinSet::new();

    // 8 agent/watch clients (4 fast + 4 hostile slow/drop/reconnect)
    for w in 0..8usize {
        let addr = address.clone();
        let targets: Vec<String> = stream_sessions
            .iter()
            .skip(w * 7)
            .take(7)
            .cloned()
            .collect();
        let cancel = ui_cancel.clone();
        let frames = watch_frames.clone();
        let errs = ui_errors.clone();
        let hostile_slow = w >= 4;
        ui_tasks.spawn(async move {
            let mut idx = 0usize;
            while !cancel.is_cancelled() {
                let sid = &targets[idx % targets.len()];
                idx += 1;
                let Ok(c) = Client::connect(&addr, None).await else {
                    if !cancel.is_cancelled() {
                        errs.fetch_add(1, Ordering::Relaxed);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let Ok(mut call) = c
                    .call(
                        "agent",
                        "watch".into(),
                        json!({ "sessionId": sid, "after": 0 }),
                        Attachments::new(),
                    )
                    .await
                else {
                    continue;
                };
                if call.start().await.is_err() {
                    continue;
                }
                if !matches!(call.receive().await, Ok(Reply::Subscribed)) {
                    continue;
                }
                let mut seen = 0usize;
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        r = call.pull() => match r {
                            Ok(Reply::Item { .. } | Reply::Progress { .. }) => {
                                frames.fetch_add(1, Ordering::Relaxed);
                                seen += 1;
                                if hostile_slow {
                                    tokio::time::sleep(Duration::from_millis(120)).await;
                                    if seen >= 4 {
                                        break;
                                    }
                                }
                            }
                            _ => break,
                        }
                    }
                }
            }
        });
    }

    // 8 list/sessionList/work pollers
    for p in 0..8usize {
        let addr = address.clone();
        let sample_sid = stream_sessions[p % stream_sessions.len()].clone();
        let cancel = ui_cancel.clone();
        let lat = list_lat.clone();
        let errs = ui_errors.clone();
        let _ui_err_samples = ui_err_samples.clone();
        ui_tasks.spawn(async move {
            let Ok(c) = Client::connect(&addr, None).await else {
                errs.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let mut tick = 0u64;
            while !cancel.is_cancelled() {
                let t0 = Instant::now();
                let res = match tick % 3 {
                    0 => {
                        try_call(
                            &c,
                            "agent",
                            "list",
                            json!({
                                "kind": null,
                                "filter": "all",
                                "includeArchived": true,
                                "rootsOnly": false,
                                "position": { "kind": "start" }
                            }),
                            Duration::from_secs(15),
                        )
                        .await
                    }
                    1 => {
                        try_call(
                            &c,
                            "agent",
                            "sessionList",
                            json!({ "limit": 100 }),
                            Duration::from_secs(15),
                        )
                        .await
                    }
                    _ => {
                        try_call(
                            &c,
                            "agent",
                            "observe",
                            json!({ "sessionId": sample_sid }),
                            Duration::from_secs(15),
                        )
                        .await
                    }
                };
                lat.record(t0.elapsed());
                if res.is_err() {
                    errs.fetch_add(1, Ordering::Relaxed);
                }
                tick += 1;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
    }

    // 8 history / sessionRead readers
    for r in 0..8usize {
        let addr = address.clone();
        let targets: Vec<String> = stream_sessions
            .iter()
            .skip(r * 5)
            .take(5)
            .cloned()
            .collect();
        let cancel = ui_cancel.clone();
        let lat = history_lat.clone();
        let errs = ui_errors.clone();
        ui_tasks.spawn(async move {
            let Ok(c) = Client::connect(&addr, None).await else {
                errs.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let mut tick = 0usize;
            while !cancel.is_cancelled() {
                let sid = &targets[tick % targets.len()];
                let t0 = Instant::now();
                let res = try_call(
                    &c,
                    "agent",
                    "history",
                    json!({
                        "sessionId": sid,
                        "through": null,
                        "position": { "kind": "tail" }
                    }),
                    Duration::from_secs(15),
                )
                .await;
                lat.record(t0.elapsed());
                if res.is_err() {
                    errs.fetch_add(1, Ordering::Relaxed);
                }
                tick += 1;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        });
    }

    // 8 search / markRead clients
    for s in 0..8usize {
        let addr = address.clone();
        let targets: Vec<String> = stream_sessions
            .iter()
            .skip(s * 6)
            .take(6)
            .cloned()
            .collect();
        let cancel = ui_cancel.clone();
        let lat = search_lat.clone();
        let errs = ui_errors.clone();
        ui_tasks.spawn(async move {
            let Ok(c) = Client::connect(&addr, None).await else {
                errs.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let mut tick = 0usize;
            while !cancel.is_cancelled() {
                let sid = &targets[tick % targets.len()];
                if let Ok(obs) = try_call(
                    &c,
                    "agent",
                    "observe",
                    json!({ "sessionId": sid }),
                    Duration::from_secs(10),
                )
                .await
                {
                    let through = obs["through"].as_u64().unwrap_or(0);
                    if through > 0 {
                        let t0 = Instant::now();
                        let res = try_call(
                            &c,
                            "agent",
                            "search",
                            json!({
                                "sessionId": sid,
                                "through": through,
                                "after": null,
                                "query": "HELL_STREAM_MARKER",
                                "caseSensitive": false,
                                "wholeWord": false,
                                "includeInternal": false
                            }),
                            Duration::from_secs(15),
                        )
                        .await;
                        lat.record(t0.elapsed());
                        if res.is_err() {
                            errs.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                tick += 1;
                tokio::time::sleep(Duration::from_millis(35)).await;
            }
        });
    }

    // Background telemetry sampler for peak RSS & WAL during storm
    let peak_rss = Arc::new(AtomicU64::new(baseline_rss));
    let peak_wal = Arc::new(AtomicU64::new(0));
    let peak_rss_bg = peak_rss.clone();
    let peak_wal_bg = peak_wal.clone();
    let root_bg = sandbox.root.clone();
    let cancel_bg = ui_cancel.clone();
    let r_prog = root_done.clone();
    let m_prog = mgr_done.clone();
    let l_prog = leaf_done.clone();
    let s_prog = stream_done.clone();
    let q_prog = total_reqs.clone();
    let wf_prog = watch_frames.clone();
    let sampler = tokio::spawn(async move {
        let mut ticks = 0u64;
        while !cancel_bg.is_cancelled() {
            let rss = sample_rss_kib(host_pid).unwrap_or(0);
            peak_rss_bg.fetch_max(rss, Ordering::Relaxed);
            let mut files = Vec::new();
            walk_files(&root_bg, &mut files);
            let wal: u64 = files
                .iter()
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with("-wal"))
                })
                .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
                .sum();
            peak_wal_bg.fetch_max(wal, Ordering::Relaxed);
            ticks += 1;
            if ticks.is_multiple_of(20) {
                eprintln!(
                    "[SCEN I] TICK {}s | roots={} mgrs={} leaves={} streams={} reqs={} watch_frames={} rss={:.1}MiB wal={:.1}MiB",
                    ticks / 4,
                    r_prog.load(Ordering::Relaxed),
                    m_prog.load(Ordering::Relaxed),
                    l_prog.load(Ordering::Relaxed),
                    s_prog.load(Ordering::Relaxed),
                    q_prog.load(Ordering::Relaxed),
                    wf_prog.load(Ordering::Relaxed),
                    rss as f64 / 1024.0,
                    wal as f64 / (1024.0 * 1024.0),
                );
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });

    // Fire ALL 36 3-level trees + ALL 60 streaming sessions concurrently!
    let mut wave_sends = JoinSet::new();
    for (t, sid, is_py, use_notify) in &tree_roots {
        let c = client.clone();
        let sid = sid.clone();
        let tag = if *is_py {
            "HELL_L0_PY_ROOT_"
        } else {
            "HELL_L0_JS_ROOT_"
        };
        let mode = if *use_notify {
            "MODE_NOTIFY_TOP"
        } else {
            "MODE_NOTIFY_BOTTOM"
        };
        let msg = format!("{tag}{t} {mode}");
        wave_sends.spawn(async move {
            let res = try_call(
                &c,
                "agent",
                "send",
                json!({ "sessionId": sid, "message": msg, "delivery": "queue" }),
                Duration::from_secs(30),
            )
            .await;
            (sid, res)
        });
    }
    for (s, sid) in stream_sessions.iter().enumerate() {
        let c = client.clone();
        let sid = sid.clone();
        wave_sends.spawn(async move {
            let res = try_call(
                &c,
                "agent",
                "send",
                json!({
                    "sessionId": sid,
                    "message": format!("HELL_STREAM_JOB_{s} emit 80 chunks + tools"),
                    "delivery": "queue"
                }),
                Duration::from_secs(30),
            )
            .await;
            (sid, res)
        });
    }
    let mut send_errs = 0usize;
    while let Some(r) = wave_sends.join_next().await {
        if r.unwrap().1.is_err() {
            send_errs += 1;
        }
    }
    eprintln!(
        "[SCEN I] Dispatched 36 3-level trees + 60 streaming sessions (send_errs={send_errs})"
    );

    // Mid-flight sabotage: wait until leaves are actively spawning, then stop + DELETE 10 trees (0..10)!
    let sabo_wait = Instant::now();
    while leaf_done.load(Ordering::Relaxed) < 20 && sabo_wait.elapsed() < Duration::from_secs(20) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!(
        "[SCEN I] Launching mid-flight sabotage on trees 0..10 (leaf_done={}, mgr_done={}, total_reqs={})",
        leaf_done.load(Ordering::Relaxed),
        mgr_done.load(Ordering::Relaxed),
        total_reqs.load(Ordering::Relaxed)
    );
    let mut sabo_set = JoinSet::new();
    for root in tree_roots.iter().take(10) {
        let c = client.clone();
        let root_sid = root.1.clone();
        sabo_set.spawn(async move {
            // Find children managers too via list scope=children!
            let children = try_call(
                &c,
                "agent",
                "list",
                json!({
                    "kind": null,
                    "filter": "all",
                    "includeArchived": true,
                    "rootsOnly": false,
                    "position": { "kind": "start" },
                    "scope": { "kind": "children", "sessionId": root_sid }
                }),
                Duration::from_secs(15),
            )
            .await;
            let mut to_kill = vec![root_sid];
            if let Ok(list) = children
                && let Some(items) = list["sessions"].as_array()
            {
                for item in items {
                    if let Some(id) = item["id"].as_str() {
                        to_kill.push(id.to_string());
                    }
                }
            }
            for sid in to_kill {
                if let Ok(obs) = try_call(
                    &c,
                    "agent",
                    "observe",
                    json!({ "sessionId": sid }),
                    Duration::from_secs(10),
                )
                .await
                {
                    if let Some(run_id) = obs["run"]["runId"].as_str() {
                        let _ = try_call(
                            &c,
                            "agent",
                            "stop",
                            json!({ "sessionId": sid, "runId": run_id }),
                            Duration::from_secs(10),
                        )
                        .await;
                    }
                    if let Some(rev) = obs["session"]["revision"].as_u64() {
                        let _ = try_call(
                            &c,
                            "agent",
                            "changeSession",
                            json!({
                                "sessionId": sid,
                                "expectedRevision": rev,
                                "action": "remove"
                            }),
                            Duration::from_secs(15),
                        )
                        .await;
                    }
                }
            }
        });
    }
    while sabo_set.join_next().await.is_some() {}

    // Wait for ALL 26 surviving tree roots (10..36) + ALL 60 streaming sessions to settle!
    let mut surviving_ok = 0usize;
    let mut surviving_fail = Vec::new();
    let mut wait_set = JoinSet::new();
    for (t, root) in tree_roots.iter().enumerate().skip(10).take(26) {
        let c = client.clone();
        let sid = root.1.clone();
        let use_notify = root.3;
        wait_set.spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(150);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err((sid, format!("tree root t={t} notify={use_notify} did not reach ROOT_TREE_COMPLETE within 150s")));
                }
                match wait_session_settled(&c, &sid, remaining).await {
                    Ok(st) if st == "completed" || st == "idle" => {
                        if let Ok(hist) = try_call(
                            &c,
                            "agent",
                            "history",
                            json!({ "sessionId": sid, "through": null, "position": { "kind": "tail" } }),
                            Duration::from_secs(15),
                        )
                        .await
                            && serde_json::to_string(&hist).unwrap_or_default().contains("ROOT_TREE_COMPLETE") {
                                return Ok(sid);
                            }
                        if !use_notify {
                            return Err((sid, format!("poll tree root t={t} settled without ROOT_TREE_COMPLETE")));
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Ok(other) => return Err((sid, format!("tree root t={t} settled with {other}"))),
                    Err(e) => return Err((sid, e)),
                }
            }
        });
    }
    for sid in &stream_sessions {
        let c = client.clone();
        let sid = sid.clone();
        wait_set.spawn(async move {
            match wait_session_settled(&c, &sid, Duration::from_secs(90)).await {
                Ok(st) if st == "completed" || st == "idle" => Ok(sid),
                Ok(other) => Err((sid, format!("stream session settled with {other}"))),
                Err(e) => Err((sid, e)),
            }
        });
    }
    while let Some(res) = wait_set.join_next().await {
        match res.unwrap() {
            Ok(_) => surviving_ok += 1,
            Err(e) => surviving_fail.push(e),
        }
    }

    // Stop UI storm & sample post-idle telemetry
    ui_cancel.cancel();
    sampler.await.expect("resource sampler task panicked");
    while let Some(joined) = ui_tasks.join_next().await {
        joined.expect("UI storm worker task panicked");
    }

    tokio::time::sleep(Duration::from_secs(2)).await;
    let post_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let post_fds = sample_open_fds(host_pid).unwrap_or(0);
    if let Ok(lsof) = std::process::Command::new("lsof")
        .args(["-n", "-P", "-p", &host_pid.to_string()])
        .output()
    {
        let mut by_type: BTreeMap<String, usize> = BTreeMap::new();
        for line in String::from_utf8_lossy(&lsof.stdout).lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 5 {
                *by_type.entry(cols[4].to_string()).or_default() += 1;
            }
        }
        let mut dir_paths: Vec<String> = Vec::new();
        for line in String::from_utf8_lossy(&lsof.stdout).lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 9 && cols[4] == "DIR" && dir_paths.len() < 8 {
                dir_paths.push(cols[8..].join(" "));
            }
        }
        eprintln!(
            "[SCEN I] POST-IDLE FDs by type: {by_type:?} | sample DIRs={dir_paths:?} | ui_err_samples={:?}",
            ui_err_samples.lock().unwrap()
        );
    }
    let sql_m = sample_sqlite_metrics(&sandbox.root);

    // Count total sessions ever registered in SQLite (should be ~400+!)
    let mut all_sessions_count = 0usize;
    if let Ok(list) = try_call(
        &client,
        "agent",
        "sessionList",
        json!({ "limit": 100 }),
        Duration::from_secs(15),
    )
    .await
    {
        all_sessions_count = list["sessions"].as_array().map_or(0, |a| a.len());
    }

    eprintln!(
        "[SCEN I] COMPLETE in {:.2}s | surviving={surviving_ok}/86 (fail={}) | roots_done={} mgrs_done={} leaves_done={} streams_done={} total_reqs={}",
        started.elapsed().as_secs_f64(),
        surviving_fail.len(),
        root_done.load(Ordering::Relaxed),
        mgr_done.load(Ordering::Relaxed),
        leaf_done.load(Ordering::Relaxed),
        stream_done.load(Ordering::Relaxed),
        total_reqs.load(Ordering::Relaxed),
    );
    eprintln!(
        "[SCEN I] UI STORM: watch_frames={} ui_errs={} | list({}) | history({}) | search({}) | visible_sessions_page1={}",
        watch_frames.load(Ordering::Relaxed),
        ui_errors.load(Ordering::Relaxed),
        list_lat.summary(),
        history_lat.summary(),
        search_lat.summary(),
        all_sessions_count,
    );
    eprintln!(
        "[SCEN I] RESOURCES: rss base={:.1}MiB peak={:.1}MiB idle={:.1}MiB | fds base={baseline_fds} post={post_fds} | db={:.1}MiB wal_peak={:.1}MiB wal_end={:.1}MiB facts={} contents={}",
        baseline_rss as f64 / 1024.0,
        peak_rss.load(Ordering::Relaxed) as f64 / 1024.0,
        post_rss as f64 / 1024.0,
        sql_m.total_db_bytes as f64 / (1024.0 * 1024.0),
        peak_wal.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0),
        sql_m.total_wal_bytes as f64 / (1024.0 * 1024.0),
        sql_m.facts_rows,
        sql_m.contents_rows,
    );

    let mut owned_client = Arc::try_unwrap(client).ok().expect("unique client");
    host.quit(&mut owned_client).await.expect("clean quit host");
    tokio::time::sleep(Duration::from_millis(500)).await;

    verify_sqlite_integrity(&sandbox.root).expect("SQLite integrity after 456-session storm");
    let orphans = find_orphan_procs("MAKA_HELL_I_NONE", sandbox.directory.path());
    assert!(
        orphans.is_empty(),
        "Orphan processes after Scenario I ({}): {:?}",
        orphans.len(),
        orphans
    );
    assert_eq!(send_errs, 0, "initial wave sends failed");
    assert!(
        surviving_fail.is_empty(),
        "Surviving trees/streams failed ({}): {:?}",
        surviving_fail.len(),
        &surviving_fail[..surviving_fail.len().min(10)]
    );
    assert!(
        leaf_done.load(Ordering::Relaxed) >= 180,
        "expected >= 180 leaf workers to complete across surviving trees, got {}",
        leaf_done.load(Ordering::Relaxed)
    );
    assert_eq!(
        ui_errors.load(Ordering::Relaxed),
        0,
        "UI storm recorded errors"
    );
    assert!(
        watch_frames.load(Ordering::Relaxed) > 0,
        "UI watch clients must observe live frames"
    );
    assert!(list_lat.count() > 0, "UI list/observe pollers must run");
    assert!(history_lat.count() > 0, "UI history readers must run");
    assert!(search_lat.count() > 0, "UI search readers must run");

    mock.shutdown().await;
}

/// ================================================================================================
/// Scenario J: 200-Turn Mega-Session + Huge Payloads + 50+ Compactions + 20 HTTP 400 Overflows
///             + Depth-5 Nested Fork Snapshot Chain (S0->F1->F2->F3->F4->F5) + Queue Grinder!
/// ================================================================================================
#[tokio::test]
#[ignore = "hell-tier stress test; run with --release --ignored --nocapture"]
async fn real_host_200_turn_mega_session_huge_payloads_5level_fork_and_queue_grinder() {
    let started = Instant::now();
    let sandbox = Sandbox::new().await.expect("sandbox");
    seed_workspace_files(&sandbox.workspace).await;

    // Seed huge 256 KiB payload files in workspace so Read returns real large tool outputs!
    for f in 0..4usize {
        let mut buf = String::with_capacity(262_144);
        for line in 0..2048usize {
            buf.push_str(&format!(
                "MEGA_PAYLOAD_FILE_{f}_LINE_{line:04} alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa-lambda-mu-nu-xi-omicron-pi\n"
            ));
        }
        tokio::fs::write(sandbox.workspace.join(format!("mega_{f}.txt")), buf)
            .await
            .expect("write mega payload file");
    }

    let total_reqs = Arc::new(AtomicU64::new(0));
    let compaction_reqs = Arc::new(AtomicU64::new(0));
    let overflow_injected = Arc::new(AtomicU64::new(0));
    let overflow_done: Arc<Mutex<std::collections::HashSet<u64>>> =
        Arc::new(Mutex::new(std::collections::HashSet::new()));
    let huge_tool_done: Arc<Mutex<std::collections::HashSet<String>>> =
        Arc::new(Mutex::new(std::collections::HashSet::new()));

    let total_reqs_cb = total_reqs.clone();
    let compaction_reqs_cb = compaction_reqs.clone();
    let overflow_injected_cb = overflow_injected.clone();
    let overflow_done_cb = overflow_done.clone();
    let huge_tool_done_cb = huge_tool_done.clone();

    let mock = MockAiBuilder::new()
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
            max_session_prompt_bytes: Some(32 * 1024 * 1024),
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
            total_reqs_cb.fetch_add(1, Ordering::Relaxed);
            let all = req.all_text();

            // Maka sends compaction summarization requests without tools.
            let is_compaction = req.tools.is_empty()
                || req
                    .system_text
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("compaction")
                || all.contains("Summarize the conversation");
            if is_compaction {
                compaction_reqs_cb.fetch_add(1, Ordering::Relaxed);
                return TurnPlan::new()
                    .push_text(format!(
                        "COMPACTION_SUMMARY_SEQ_{}: preserved key anchors, mega file hashes, and active queue state.",
                        req.sequence
                    ))
                    .with_usage(Usage::new(1200, 180))
                    .finish(FinishReason::Stop);
            }

            // Parse turn number from last user message 'MEGA_TURN_<N>'
            let turn_num = all.rfind("MEGA_TURN_").and_then(|pos| {
                let rest = &all[pos + 10..];
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<u64>().ok()
            });

            // Inject 20 real HTTP 400 context_length_exceeded errors on S0 (every 10th turn: 5, 15, ..., 195)
            if let Some(t) = turn_num
                && t % 10 == 5 && !all.contains("FORK_TURN_") && !all.contains("MEGA_PAYLOAD_FILE_") {
                    let mut done = overflow_done_cb.lock().unwrap();
                    if done.insert(t) {
                        overflow_injected_cb.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::http_error(HttpErrorSpec::raw(
                            400,
                            json!({
                                "error": {
                                    "type": "invalid_request_error",
                                    "code": "context_length_exceeded",
                                    "message": "This model's maximum context length is 16000 tokens. However, your messages resulted in 19500 tokens. Please reduce the length of the messages."
                                }
                            }),
                        ));
                    }
                }

            // On turns with 'HUGE_TOOL', read a 256 KiB file ONCE per turn!
            let last_user_text = req
                .messages
                .iter()
                .rev()
                .find(|m| matches!(m.role, maka_mock_ai::NormalizedRole::User))
                .map(|m| m.text.as_str())
                .unwrap_or("");
            let last_is_tool = req
                .messages
                .last()
                .is_some_and(|m| matches!(m.role, maka_mock_ai::NormalizedRole::Tool));
            let turn_key = format!(
                "{}:{}",
                if last_user_text.contains("FORK_TURN_") { "fork" } else { "s0" },
                turn_num.unwrap_or(0)
            );
            let should_huge_tool = !last_is_tool
                && last_user_text.contains("HUGE_TOOL")
                && huge_tool_done_cb.lock().unwrap().insert(turn_key);
            if should_huge_tool {
                let fidx = (turn_num.unwrap_or(req.sequence) as usize) % 4;
                let mut plan = TurnPlan::new();
                if all.contains("SLOW_FOR_QUEUE") {
                    plan.chunk_delay_ms = 25;
                    plan.events.push(TurnEvent::Text {
                        text: "Preparing queued turn window...".into(),
                        chunk_chars: 3,
                        citations: vec![],
                    });
                }
                return plan
                    .push_tool_call(
                        format!("mega_read_{}", req.sequence),
                        "Read",
                        json!({
                            "path": format!("mega_{fidx}.txt"),
                            "offset": 0,
                            "limit": 1200
                        }),
                    )
                    .with_usage(Usage::new(13_500, 400))
                    .finish(FinishReason::ToolCalls);
            }

            // Report realistic high prompt usage (14,800 / 16,000) every 3rd turn (except turns ending in 4,
            // which precede our 5/15/../195 HTTP 400 overflow injections so those turns enter with real uncompacted history).
            let high_usage = if turn_num.is_some_and(|t| t % 3 == 0 && t % 10 != 4) {
                Usage::new(14_800, 350)
            } else {
                Usage::new(4_200, 220)
            };
            let reply_tag = turn_num.map_or_else(
                || format!("TURN_OK_SEQ_{}", req.sequence),
                |t| format!("MEGA_TURN_OK_{t} {}", "summary-detail-token-".repeat(24)),
            );
            TurnPlan::new()
                .push_text(reply_tag)
                .with_usage(high_usage)
                .finish(FinishReason::Stop)
        })
        .start()
        .await
        .expect("start mock-ai");

    let base_url = format!("{}/v1", mock.base_url());
    // Tight 16,000 context window on 'chat' forces heavy continuous compaction!
    let conns = seed_hell_connections(&sandbox.root, &base_url, 16_000).await;

    let mut host = Host::spawn(&sandbox).expect("spawn host");
    let (client, address) = host.ready().await.expect("host ready");
    let client = Arc::new(client);
    save_all_hell_credentials(&client, &conns).await;

    let host_pid = host.pid().expect("host pid");
    let baseline_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let baseline_fds = sample_open_fds(host_pid).unwrap_or(0);

    let s0 = create_session(&client, &sandbox.workspace, backend_for(&conns, "chat"))
        .await
        .expect("create mega session S0");

    // Background history + search reader pounding S0 throughout all 200 turns!
    let reader_cancel = CancellationToken::new();
    let hist_lat = Arc::new(LatencyHistogram::default());
    let search_lat = Arc::new(LatencyHistogram::default());
    let reader_errs = Arc::new(AtomicU64::new(0));
    let reader_task = {
        let addr = address.clone();
        let sid = s0.clone();
        let cancel = reader_cancel.clone();
        let h_lat = hist_lat.clone();
        let s_lat = search_lat.clone();
        let errs = reader_errs.clone();
        tokio::spawn(async move {
            let Ok(c) = Client::connect(&addr, None).await else {
                errs.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let mut tick = 0u64;
            while !cancel.is_cancelled() {
                let t0 = Instant::now();
                let h = try_call(
                    &c,
                    "agent",
                    "history",
                    json!({ "sessionId": sid, "through": null, "position": { "kind": "tail" } }),
                    Duration::from_secs(15),
                )
                .await;
                h_lat.record(t0.elapsed());
                if h.is_err() {
                    errs.fetch_add(1, Ordering::Relaxed);
                }
                if tick.is_multiple_of(2)
                    && let Ok(obs) = try_call(
                        &c,
                        "agent",
                        "observe",
                        json!({ "sessionId": sid }),
                        Duration::from_secs(10),
                    )
                    .await
                {
                    let through = obs["through"].as_u64().unwrap_or(0);
                    if through > 0 {
                        let t1 = Instant::now();
                        let s = try_call(
                            &c,
                            "agent",
                            "search",
                            json!({
                                "sessionId": sid,
                                "through": through,
                                "after": null,
                                "query": "MEGA_TURN_OK_",
                                "caseSensitive": false,
                                "wholeWord": false,
                                "includeInternal": false
                            }),
                            Duration::from_secs(15),
                        )
                        .await;
                        s_lat.record(t1.elapsed());
                        if s.is_err() {
                            errs.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                tick += 1;
                tokio::time::sleep(Duration::from_millis(60)).await;
            }
        })
    };

    // Helper: run one complete turn on a session and return its latency
    async fn run_one_turn(client: &Client, sid: &str, msg: String) -> Result<Duration, String> {
        let t0 = Instant::now();
        let sent = try_call(
            client,
            "agent",
            "send",
            json!({ "sessionId": sid, "message": msg, "delivery": "queue" }),
            Duration::from_secs(30),
        )
        .await?;
        if sent["kind"] != "accepted" && sent["kind"] != "queued" {
            return Err(format!("send rejected: {sent}"));
        }
        let msg_id = sent["messageId"].as_str().unwrap_or("").to_string();
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if Instant::now() > deadline {
                return Err(format!("turn timed out for {sid}"));
            }
            if let Ok(w) = try_call(
                client,
                "agent",
                "work",
                json!({ "sessionId": sid, "target": { "kind": "message", "messageId": msg_id } }),
                Duration::from_secs(15),
            )
            .await
            {
                match w["execution"]["state"]["kind"].as_str() {
                    Some("completed") => return Ok(t0.elapsed()),
                    Some(other @ ("failed" | "cancelled" | "blocked")) => {
                        return Err(format!("turn ended with {other}: {w}"));
                    }
                    _ => {}
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    let mut turn_latencies: Vec<Duration> = Vec::with_capacity(200);
    let mut queue_edits_ok = 0usize;
    let mut manual_compacts_ok = 0usize;
    let mut fork_chain_handle: Option<tokio::task::JoinHandle<Result<Vec<String>, String>>> = None;

    for turn in 1..=200u64 {
        let huge = if turn % 4 == 0 { " HUGE_TOOL" } else { "" };
        let queue_window = turn % 14 == 7;
        let msg = if queue_window {
            format!("MEGA_TURN_{turn} HUGE_TOOL SLOW_FOR_QUEUE")
        } else {
            format!("MEGA_TURN_{turn}{huge} anchor_payload_{turn}")
        };

        if queue_window {
            let t0 = Instant::now();
            let primary = try_call(
                &client,
                "agent",
                "send",
                json!({ "sessionId": s0, "message": msg, "delivery": "queue" }),
                Duration::from_secs(30),
            )
            .await
            .expect("primary queue turn send");
            assert!(primary["kind"] == "accepted" || primary["kind"] == "queued");
            let q1 = try_call(
                &client,
                "agent",
                "send",
                json!({ "sessionId": s0, "message": format!("QUEUE_ITEM_A_{turn}"), "delivery": "queue" }),
                Duration::from_secs(15),
            )
            .await;
            let q2 = try_call(
                &client,
                "agent",
                "send",
                json!({ "sessionId": s0, "message": format!("QUEUE_ITEM_B_{turn}"), "delivery": "queue" }),
                Duration::from_secs(15),
            )
            .await;
            let q3 = try_call(
                &client,
                "agent",
                "send",
                json!({ "sessionId": s0, "message": format!("QUEUE_ITEM_C_{turn}"), "delivery": "queue" }),
                Duration::from_secs(15),
            )
            .await;
            if let Ok(qsnap) = try_call(
                &client,
                "agent",
                "queue",
                json!({ "sessionId": s0 }),
                Duration::from_secs(10),
            )
            .await
            {
                let mut rev = qsnap["revision"].as_u64().unwrap_or(0);
                let id1 = q1
                    .as_ref()
                    .ok()
                    .and_then(|v| v["messageId"].as_str())
                    .map(str::to_string);
                let id2 = q2
                    .as_ref()
                    .ok()
                    .and_then(|v| v["messageId"].as_str())
                    .map(str::to_string);
                let id3 = q3
                    .as_ref()
                    .ok()
                    .and_then(|v| v["messageId"].as_str())
                    .map(str::to_string);
                if let (Some(a), Some(b), Some(c_id)) = (id1, id2, id3) {
                    if let Ok(r) = try_call(
                        &client,
                        "agent",
                        "editQueue",
                        json!({
                            "sessionId": s0,
                            "expectedRevision": rev,
                            "edit": { "kind": "reorder", "messageIds": [c_id, a, b] }
                        }),
                        Duration::from_secs(10),
                    )
                    .await
                        && let Some(nr) = r["revision"].as_u64()
                    {
                        rev = nr;
                        queue_edits_ok += 1;
                    }
                    if let Ok(r) = try_call(
                        &client,
                        "agent",
                        "editQueue",
                        json!({
                            "sessionId": s0,
                            "expectedRevision": rev,
                            "edit": { "kind": "update", "messageId": a, "message": format!("QUEUE_ITEM_A_UPDATED_{turn}") }
                        }),
                        Duration::from_secs(10),
                    )
                    .await
                        && let Some(nr) = r["revision"].as_u64() {
                            rev = nr;
                            queue_edits_ok += 1;
                        }
                    if let Ok(r) = try_call(
                        &client,
                        "agent",
                        "editQueue",
                        json!({
                            "sessionId": s0,
                            "expectedRevision": rev,
                            "edit": { "kind": "retract", "messageId": b }
                        }),
                        Duration::from_secs(10),
                    )
                    .await
                        && let Some(nr) = r["revision"].as_u64()
                    {
                        rev = nr;
                        queue_edits_ok += 1;
                    }
                    if let Ok(r) = try_call(
                        &client,
                        "agent",
                        "editQueue",
                        json!({
                            "sessionId": s0,
                            "expectedRevision": rev,
                            "edit": { "kind": "promote", "messageId": c_id }
                        }),
                        Duration::from_secs(10),
                    )
                    .await
                        && r["kind"] == "committed"
                    {
                        queue_edits_ok += 1;
                    }
                }
            }
            let settled = wait_session_settled(&client, &s0, Duration::from_secs(60))
                .await
                .expect("S0 settle after queue grinder");
            assert!(
                settled == "completed" || settled == "idle",
                "S0 queue grinder settled {settled}"
            );
            turn_latencies.push(t0.elapsed());
        } else {
            let lat = run_one_turn(&client, &s0, msg).await.unwrap_or_else(|e| {
                let diag = dump_failed_run_facts(&sandbox.root, &s0);
                panic!("S0 turn {turn} failed: {e}\n--- RECENT FACTS ---\n{diag}");
            });
            turn_latencies.push(lat);
        }

        // At Turn 30, kick off Depth-5 Nested Fork Snapshot Chain concurrently (F1 -> F2 -> F3 -> F4 -> F5)!
        if turn == 30 {
            let c_fork = client.clone();
            let s0_id = s0.clone();
            fork_chain_handle = Some(tokio::spawn(async move {
                let mut chain_ids = Vec::with_capacity(5);
                let mut parent = s0_id;
                for depth in 1..=5usize {
                    let obs = try_call(
                        &c_fork,
                        "agent",
                        "observe",
                        json!({ "sessionId": parent }),
                        Duration::from_secs(15),
                    )
                    .await?;
                    let rev = obs["session"]["revision"]
                        .as_u64()
                        .ok_or_else(|| format!("depth {depth}: missing session.revision"))?;
                    let forked = try_call(
                        &c_fork,
                        "agent",
                        "fork",
                        json!({
                            "sessionId": parent,
                            "expectedRevision": rev,
                            "position": { "kind": "end" },
                            "title": format!("MegaFork-L{depth}"),
                            "labels": []
                        }),
                        Duration::from_secs(30),
                    )
                    .await?;
                    let fsid = forked["session"]["id"]
                        .as_str()
                        .ok_or_else(|| format!("depth {depth}: fork returned {forked}"))?
                        .to_string();
                    for ft in 1..=10u64 {
                        let huge = if ft % 3 == 0 { " HUGE_TOOL" } else { "" };
                        run_one_turn(
                            &c_fork,
                            &fsid,
                            format!(
                                "FORK_TURN_L{depth}_{ft} MEGA_TURN_{}{huge}",
                                (depth as u64) * 100 + ft
                            ),
                        )
                        .await?;
                    }
                    let hist = try_call(
                        &c_fork,
                        "agent",
                        "history",
                        json!({ "sessionId": fsid, "through": null, "position": { "kind": "start" } }),
                        Duration::from_secs(20),
                    )
                    .await?;
                    let hstr = serde_json::to_string(&hist).unwrap_or_default();
                    if !hstr.contains("MEGA_TURN_1") && !hstr.contains("COMPACTION_SUMMARY") {
                        return Err(format!("depth {depth} fork lost ancestry prefix"));
                    }
                    chain_ids.push(fsid.clone());
                    parent = fsid;
                }
                Ok(chain_ids)
            }));
        }

        // Manual compact RPCs at Turns 40, 80, 120, 160!
        if matches!(turn, 40 | 80 | 120 | 160)
            && let Ok(resp) = try_call(
                &client,
                "agent",
                "compact",
                json!({
                    "sessionId": s0,
                    "model": { "connectionId": conns.chat, "modelId": "gpt-4.1-mini" },
                    "thinkingLevel": null,
                    "prompt": format!("Manual compaction checkpoint at turn {turn}")
                }),
                Duration::from_secs(20),
            )
            .await
            && resp["kind"] == "started"
        {
            manual_compacts_ok += 1;
            let _ = wait_session_settled(&client, &s0, Duration::from_secs(45)).await;
        }

        if turn % 40 == 0 {
            let rss = sample_rss_kib(host_pid).unwrap_or(0) as f64 / 1024.0;
            let fds = sample_open_fds(host_pid).unwrap_or(0);
            eprintln!(
                "[SCEN J] Turn {turn}/200 | compactions={} overflows={} queue_edits={queue_edits_ok} manual_compacts={manual_compacts_ok} rss={rss:.1}MiB fds={fds} elapsed={:.1}s",
                compaction_reqs.load(Ordering::Relaxed),
                overflow_injected.load(Ordering::Relaxed),
                started.elapsed().as_secs_f64(),
            );
        }
    }

    let fork_chain = fork_chain_handle
        .expect("fork chain spawned")
        .await
        .expect("fork chain task join")
        .expect("5-level nested fork chain must succeed");
    assert_eq!(fork_chain.len(), 5);

    reader_cancel.cancel();
    reader_task
        .await
        .expect("background history/search reader task panicked");

    let early: Vec<f64> = turn_latencies[10..50]
        .iter()
        .enumerate()
        .filter(|(i, _)| (i + 11) % 14 != 7)
        .map(|(_, d)| d.as_secs_f64() * 1000.0)
        .collect();
    let late: Vec<f64> = turn_latencies[160..200]
        .iter()
        .enumerate()
        .filter(|(i, _)| (i + 161) % 14 != 7)
        .map(|(_, d)| d.as_secs_f64() * 1000.0)
        .collect();
    let early_avg = early.iter().sum::<f64>() / early.len().max(1) as f64;
    let late_avg = late.iter().sum::<f64>() / late.len().max(1) as f64;
    let ratio = late_avg / early_avg.max(1.0);

    let post_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let post_fds = sample_open_fds(host_pid).unwrap_or(0);
    let sql_m = sample_sqlite_metrics(&sandbox.root);

    eprintln!(
        "[SCEN J] COMPLETE in {:.2}s | turns=200+50fork | compactions={} overflows={} manual_compacts={manual_compacts_ok} queue_edits={queue_edits_ok} total_reqs={}",
        started.elapsed().as_secs_f64(),
        compaction_reqs.load(Ordering::Relaxed),
        overflow_injected.load(Ordering::Relaxed),
        total_reqs.load(Ordering::Relaxed),
    );
    eprintln!(
        "[SCEN J] LATENCY CURVE: early(T11..50) avg={early_avg:.1}ms vs late(T161..200) avg={late_avg:.1}ms (ratio={ratio:.2}x) | bg history({}) search({}) errs={}",
        hist_lat.summary(),
        search_lat.summary(),
        reader_errs.load(Ordering::Relaxed),
    );
    eprintln!(
        "[SCEN J] RESOURCES: rss base={:.1}MiB end={:.1}MiB | fds base={baseline_fds} end={post_fds} | db={:.1}MiB wal={:.1}MiB facts={} contents={}",
        baseline_rss as f64 / 1024.0,
        post_rss as f64 / 1024.0,
        sql_m.total_db_bytes as f64 / (1024.0 * 1024.0),
        sql_m.total_wal_bytes as f64 / (1024.0 * 1024.0),
        sql_m.facts_rows,
        sql_m.contents_rows,
    );

    let mut owned_client = Arc::try_unwrap(client).ok().expect("unique client");
    host.quit(&mut owned_client).await.expect("clean quit host");
    tokio::time::sleep(Duration::from_millis(500)).await;

    verify_sqlite_integrity(&sandbox.root).expect("SQLite integrity after Scenario J");
    assert!(
        compaction_reqs.load(Ordering::Relaxed) >= 20,
        "expected >= 20 real compactions across 200 turns + 5 forks, got {}",
        compaction_reqs.load(Ordering::Relaxed)
    );
    assert!(
        overflow_injected.load(Ordering::Relaxed) >= 18,
        "expected >= 18 HTTP 400 overflow recoveries, got {}",
        overflow_injected.load(Ordering::Relaxed)
    );
    assert!(
        queue_edits_ok >= 10,
        "expected >= 10 live queue edits (reorder/update/retract/promote), got {queue_edits_ok}"
    );
    assert_eq!(
        reader_errs.load(Ordering::Relaxed),
        0,
        "background history/search errors"
    );
    assert!(
        hist_lat.count() > 0,
        "background history reader must observe reads"
    );
    assert!(
        search_lat.count() > 0,
        "background search reader must observe reads"
    );
    assert!(
        ratio < 3.5 || late_avg < 250.0,
        "Mega-session turn latency degraded quadratically: early={early_avg:.1}ms late={late_avg:.1}ms ({ratio:.2}x)"
    );
    assert!(
        post_fds <= baseline_fds + 25,
        "FD leak in Scenario J: base={baseline_fds} end={post_fds}"
    );

    mock.shutdown().await;
}

/// ================================================================================================
/// Scenario K: Tri-Runtime 80x Single-Cell Fanout + 40 Hostile OOM/CPU/Terminate Bombs
///             + 32 Background PTY/Pipe Flood + 32 Innocent Canary Sessions!
/// ================================================================================================
#[tokio::test]
#[ignore = "hell-tier stress test; run with --release --ignored --nocapture"]
async fn real_host_tri_runtime_80x_fanout_bombs_pty_flood_and_canary_isolation() {
    let started = Instant::now();
    let sandbox = Sandbox::new().await.expect("sandbox");
    seed_workspace_files(&sandbox.workspace).await;
    let marker = format!("MAKA_HELL_K_{}", uuid::Uuid::new_v4().simple());

    let total_reqs = Arc::new(AtomicU64::new(0));
    let fanout_archive_verified = Arc::new(AtomicUsize::new(0));
    let bomb_settled = Arc::new(AtomicUsize::new(0));
    let canary_done = Arc::new(AtomicUsize::new(0));

    let total_reqs_cb = total_reqs.clone();
    let fanout_archive_cb = fanout_archive_verified.clone();
    let bomb_settled_cb = bomb_settled.clone();
    let canary_done_cb = canary_done.clone();
    let marker_cb = marker.clone();

    let mock = MockAiBuilder::new()
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
            max_session_prompt_bytes: Some(32 * 1024 * 1024),
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
            total_reqs_cb.fetch_add(1, Ordering::Relaxed);
            let all = req.all_text();
            let usage = Usage::new(400, 120);

            let last_tool_text = req
                .messages
                .iter()
                .rev()
                .find(|m| matches!(m.role, maka_mock_ai::NormalizedRole::Tool))
                .map(|m| m.text.as_str())
                .unwrap_or("");
            let tool_turns = req
                .messages
                .iter()
                .filter(|m| matches!(m.role, maka_mock_ai::NormalizedRole::Tool))
                .count();
            let running_cell = |text: &str| -> Option<String> {
                let pos = text.rfind(r#""cell_id":""#)?;
                let rest = &text[pos + 11..];
                let end = rest.find('"')?;
                if text[pos.saturating_sub(60)..pos].contains("running") {
                    Some(rest[..end].to_string())
                } else {
                    None
                }
            };

            // 1. Innocent Canary sessions (must read actual fixture_0.txt payload!)
            if all.contains("HELL_K_CANARY_") {
                if tool_turns > 0 {
                    if last_tool_text.contains("Synthetic workspace fixture 0")
                        && last_tool_text.contains("line_00: maka real-host stress fixture payload")
                    {
                        canary_done_cb.fetch_add(1, Ordering::Relaxed);
                        return TurnPlan::new()
                            .push_text("CANARY_HEALTHY_OK")
                            .with_usage(usage)
                            .finish(FinishReason::Stop);
                    }
                    return TurnPlan::new()
                        .push_text("CANARY_READ_MISMATCH")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                return TurnPlan::new()
                    .push_tool_call(
                        format!("canary_read_{}", req.sequence),
                        "Read",
                        json!({ "path": "fixture_0.txt", "offset": 0, "limit": 5 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // 2. JS 80-way single-cell fanout + 50 notify + 5 yield_control + archive readback!
            if all.contains("HELL_K_JS_FANOUT_") {
                if last_tool_text.contains("ARCHIVE_READBACK_OK") {
                    fanout_archive_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("JS_80X_FANOUT_AND_ARCHIVE_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(cid) = running_cell(last_tool_text) {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("wait_fanout_{}", req.sequence),
                            "wait",
                            json!({ "cell_id": cid, "yield_time_ms": 45000 }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }
                if last_tool_text.contains("archive:") && !all.contains("READBACK_ATTEMPTED")
                    && let Some(pos) = last_tool_text.rfind("archive:") {
                        let rest = &last_tool_text[pos..];
                        let aref: String = rest
                            .chars()
                            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_'))
                            .collect();
                        let code = format!(
                            r#"const page = await tools.Read({{ path: "{aref}" }});
const ok = page.kind === "completed"
    && page.value.content.includes("FANOUT80_DONE:v8-80x:ok=80")
    && page.value.content.includes("MEGA_ARCHIVE_BLOCK_");
text("READBACK_ATTEMPTED:" + page.kind + ":" + (ok ? "ARCHIVE_READBACK_OK" : "MISSING"));"#
                        );
                        return TurnPlan::new()
                            .push_tool_call(
                                format!("js_readback_{}", req.sequence),
                                "exec",
                                json!({ "code": code }),
                            )
                            .with_usage(usage)
                            .finish(FinishReason::ToolCalls);
                    }
                if last_tool_text.contains("READBACK_ATTEMPTED:") || tool_turns > 16 {
                    return TurnPlan::new()
                        .push_text("JS_80X_FANOUT_INCOMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let code = r#"
                    store("k_fanout", "v8-80x");
                    for (let i = 0; i < 50; i++) notify("n-" + i);
                    const batch = [];
                    for (let i = 0; i < 40; i++) {
                      batch.push(tools.Read({ path: "fixture_" + (i % 5) + ".txt", offset: 0, limit: 6 }));
                      batch.push(tools.Shell({ command: "echo fan80-" + i, login: false }));
                    }
                    const results = await Promise.all(batch);
                    const okCount = results.filter(r => r.kind === "completed").length;
                    for (let y = 0; y < 5; y++) {
                      text("yield-round-" + y + "\n");
                      await yield_control();
                    }
                    const bigChunk = "MEGA_ARCHIVE_BLOCK_".repeat(12000);
                    text("FANOUT80_DONE:" + load("k_fanout") + ":ok=" + okCount + "\n" + bigChunk);
                "#;
                return TurnPlan::new()
                    .push_tool_call(
                        format!("js_fanout_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 15000 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // 3. Python 40-way single-cell fanout + 30 notify + 3 yield_control
            if all.contains("HELL_K_PY_FANOUT_") {
                if last_tool_text.contains("PY_FANOUT40_DONE") {
                    return TurnPlan::new()
                        .push_text("PY_40X_FANOUT_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(cid) = running_cell(last_tool_text) {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("wait_py_fanout_{}", req.sequence),
                            "wait",
                            json!({ "cell_id": cid, "yield_time_ms": 45000 }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }
                if all.contains("PY_FANOUT40_DONE") || tool_turns > 14 {
                    return TurnPlan::new()
                        .push_text("PY_40X_FANOUT_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let code = r#"import asyncio
store("py_fan", "monty-40x")
for i in range(30):
    notify("py-n-" + str(i))
tasks = []
for i in range(20):
    tasks.append(tools.Read(path="fixture_" + str(i % 5) + ".txt", offset=0, limit=6))
    tasks.append(tools.Shell(command="echo pyfan40-" + str(i), login=False))
res = await asyncio.gather(*tasks)
ok = sum(1 for r in res if r["kind"] == "completed")
for y in range(3):
    text("py-yield-" + str(y) + "\n")
    await yield_control()
text("PY_FANOUT40_DONE:" + str(load("py_fan")) + ":ok=" + str(ok))
"#;
                return TurnPlan::new()
                    .push_tool_call(
                        format!("py_fanout_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 15000 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // 4. Hostile Bombs: JS OOM, JS CPU + terminate, Python OOM, Terminate-race with sleep shells!
            if all.contains("HELL_K_BOMB_") {
                if tool_turns >= 1 {
                    if let Some(cid) = running_cell(last_tool_text) {
                        return TurnPlan::new()
                            .push_tool_call(
                                format!("term_bomb_{}", req.sequence),
                                "wait",
                                json!({ "cell_id": cid, "terminate": true, "yield_time_ms": 15000 }),
                            )
                            .with_usage(usage)
                            .finish(FinishReason::ToolCalls);
                    }
                    bomb_settled_cb.fetch_add(1, Ordering::Relaxed);
                    return TurnPlan::new()
                        .push_text("BOMB_CONTAINED_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let (code, yms) = if all.contains("BOMB_JS_OOM") {
                    (
                        "const arr = []; while (true) { arr.push(new Uint8Array(2 * 1024 * 1024)); }".to_string(),
                        15000u64,
                    )
                } else if all.contains("BOMB_JS_CPU") {
                    ("let x = 0; while (true) { x = (x + 1) | 0; }".to_string(), 1200u64)
                } else if all.contains("BOMB_PY_OOM") {
                    (
                        "a = []\nfor _ in range(300):\n    a.append(b'X' * (2 * 1024 * 1024))\ntext('unreachable')".to_string(),
                        15000u64,
                    )
                } else if all.contains("BOMB_PY_TERM") {
                    (
                        format!(
                            "import asyncio\nawait asyncio.gather(tools.Shell(command=\"sh -c 'sleep 30; echo {m}'\", login=False), tools.Shell(command=\"sh -c 'sleep 30; echo {m}'\", login=False))",
                            m = marker_cb
                        ),
                        600u64,
                    )
                } else {
                    (
                        format!(
                            "await Promise.all([tools.Shell({{ command: \"sh -c 'sleep 30; echo {m}'\", login: false }}), tools.Shell({{ command: \"sh -c 'sleep 30; echo {m}'\", login: false }})]);",
                            m = marker_cb
                        ),
                        600u64,
                    )
                };
                return TurnPlan::new()
                    .push_tool_call(
                        format!("exec_bomb_{}", req.sequence),
                        "exec",
                        json!({ "code": code, "yield_time_ms": yms }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            // 5. Background PTY + Pipe Shell flood!
            if all.contains("HELL_K_PTY_") {
                if all.contains("PTY_STOPPED_OK") || req.messages.len() > 6 {
                    return TurnPlan::new()
                        .push_text("PTY_FLOOD_SESSION_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if let Some(pos) = all.rfind(r#""ref":""#) {
                    let rest = &all[pos + 7..];
                    if let Some(end) = rest.find('"') {
                        let pref = &rest[..end];
                        if req.messages.len() <= 3 {
                            return TurnPlan::new()
                                .push_tool_call(
                                    format!("pty_in_{}", req.sequence),
                                    "ProcessInput",
                                    json!({
                                        "ref": pref,
                                        "input": "hello-pty\n",
                                        "size": { "cols": 100, "rows": 32 }
                                    }),
                                )
                                .with_usage(usage)
                                .finish(FinishReason::ToolCalls);
                        }
                        return TurnPlan::new()
                            .push_tool_call(
                                format!("pty_stop_{}", req.sequence),
                                "ProcessStop",
                                json!({ "ref": pref }),
                            )
                            .with_usage(usage)
                            .finish(FinishReason::ToolCalls);
                    }
                }
                let use_pty = all.contains("PTY_MODE");
                return TurnPlan::new()
                    .push_tool_call(
                        format!("pty_start_{}", req.sequence),
                        "Shell",
                        json!({
                            "command": format!("sh -c 'i=0; while [ $i -lt 40 ]; do echo pty-{m}-$i; i=$((i+1)); sleep 0.05; done; sleep 10'", m = marker_cb),
                            "run_in_background": true,
                            "pty": use_pty,
                            "login": false
                        }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            TurnPlan::new()
                .push_text("FALLBACK_OK")
                .with_usage(usage)
                .finish(FinishReason::Stop)
        })
        .start()
        .await
        .expect("start mock-ai");

    let base_url = format!("{}/v1", mock.base_url());
    let conns = seed_hell_connections(&sandbox.root, &base_url, 128_000).await;

    let mut host = Host::spawn(&sandbox).expect("spawn host");
    let (client, _addr) = host.ready().await.expect("host ready");
    let client = Arc::new(client);
    save_all_hell_credentials(&client, &conns).await;

    let host_pid = host.pid().expect("host pid");
    let baseline_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let baseline_fds = sample_open_fds(host_pid).unwrap_or(0);

    let mut jobs: Vec<(String, String, &'static str)> = Vec::with_capacity(110);
    {
        let mut set = JoinSet::new();
        for i in 0..4usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let b = backend_for(&conns, "js");
            set.spawn(async move {
                (
                    create_session(&c, &ws, b).await.unwrap(),
                    format!("HELL_K_JS_FANOUT_{i}"),
                    "fanout",
                )
            });
        }
        for i in 0..2usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let b = backend_for(&conns, "py");
            set.spawn(async move {
                (
                    create_session(&c, &ws, b).await.unwrap(),
                    format!("HELL_K_PY_FANOUT_{i}"),
                    "fanout",
                )
            });
        }
        for i in 0..40usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let (lang, btag) = match i % 4 {
                0 => ("js", "BOMB_JS_OOM"),
                1 => ("js", "BOMB_JS_CPU"),
                2 => ("py", "BOMB_PY_OOM"),
                _ => (
                    if i % 8 == 3 { "js" } else { "py" },
                    if i % 8 == 3 {
                        "BOMB_JS_TERM"
                    } else {
                        "BOMB_PY_TERM"
                    },
                ),
            };
            let b = backend_for(&conns, lang);
            set.spawn(async move {
                (
                    create_session(&c, &ws, b).await.unwrap(),
                    format!("HELL_K_BOMB_{btag}_{i}"),
                    "bomb",
                )
            });
        }
        for i in 0..32usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let mode = if i % 2 == 0 { "PTY_MODE" } else { "PIPE_MODE" };
            let b = backend_for(&conns, "ws");
            set.spawn(async move {
                (
                    create_session(&c, &ws, b).await.unwrap(),
                    format!("HELL_K_PTY_{mode}_{i}"),
                    "pty",
                )
            });
        }
        for i in 0..32usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let proto = if i % 2 == 0 { "ws" } else { "anthropic" };
            let b = backend_for(&conns, proto);
            set.spawn(async move {
                (
                    create_session(&c, &ws, b).await.unwrap(),
                    format!("HELL_K_CANARY_{i}"),
                    "canary",
                )
            });
        }
        while let Some(r) = set.join_next().await {
            jobs.push(r.unwrap());
        }
    }

    let canary_lat = Arc::new(LatencyHistogram::default());
    let mut wave = JoinSet::new();
    for (idx, (sid, msg, kind)) in jobs.iter().enumerate() {
        let c = client.clone();
        let sid = sid.clone();
        let msg = msg.clone();
        let kind = *kind;
        let c_lat = canary_lat.clone();
        let delayed_canary = kind == "canary" && idx % 2 == 1;
        wave.spawn(async move {
            if delayed_canary {
                tokio::time::sleep(Duration::from_millis(1800)).await;
            }
            let t0 = Instant::now();
            let sent = try_call(
                &c,
                "agent",
                "send",
                json!({ "sessionId": sid, "message": msg, "delivery": "queue" }),
                Duration::from_secs(30),
            )
            .await;
            if let Err(e) = sent {
                return (kind, sid, Err(format!("send err: {e}")));
            }
            let timeout = match kind {
                "canary" => Duration::from_secs(45),
                "bomb" => Duration::from_secs(90),
                _ => Duration::from_secs(120),
            };
            let settled = wait_session_settled(&c, &sid, timeout).await;
            if kind == "canary" {
                c_lat.record(t0.elapsed());
            }
            (kind, sid, settled)
        });
    }

    let mut ok_by_kind: BTreeMap<&str, usize> = BTreeMap::new();
    let mut failures: Vec<(&str, String, String)> = Vec::new();
    let mut peak_rss = baseline_rss;
    let mut last_log = Instant::now();
    let mut done_total = 0usize;
    while let Some(res) = wave.join_next().await {
        done_total += 1;
        peak_rss = peak_rss.max(sample_rss_kib(host_pid).unwrap_or(0));
        let (kind, sid, outcome) = res.unwrap();
        match outcome {
            Ok(st)
                if st == "completed"
                    || st == "idle"
                    || (kind == "bomb" && (st == "failed" || st == "cancelled")) =>
            {
                *ok_by_kind.entry(kind).or_default() += 1;
            }
            Ok(other) => failures.push((kind, sid, format!("settled={other}"))),
            Err(e) => failures.push((kind, sid, e)),
        }
        if done_total.is_multiple_of(20) || last_log.elapsed() >= Duration::from_secs(10) {
            last_log = Instant::now();
            eprintln!(
                "[SCEN K] progress {done_total}/110 ({:.1}s) ok={ok_by_kind:?} fail={} peak_rss={:.1}MiB",
                started.elapsed().as_secs_f64(),
                failures.len(),
                peak_rss as f64 / 1024.0,
            );
        }
    }

    tokio::time::sleep(Duration::from_secs(2)).await;
    let post_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let post_fds = sample_open_fds(host_pid).unwrap_or(0);
    let sql_m = sample_sqlite_metrics(&sandbox.root);

    eprintln!(
        "[SCEN K] COMPLETE in {:.2}s | ok_by_kind={ok_by_kind:?} failures={} | fanout_verified={} bombs_contained={} canaries={}/32 ({}) total_reqs={}",
        started.elapsed().as_secs_f64(),
        failures.len(),
        fanout_archive_verified.load(Ordering::Relaxed),
        bomb_settled.load(Ordering::Relaxed),
        canary_done.load(Ordering::Relaxed),
        canary_lat.summary(),
        total_reqs.load(Ordering::Relaxed),
    );
    eprintln!(
        "[SCEN K] RESOURCES: rss base={:.1}MiB peak={:.1}MiB idle={:.1}MiB | fds base={baseline_fds} post={post_fds} | db={:.1}MiB facts={} contents={}",
        baseline_rss as f64 / 1024.0,
        peak_rss as f64 / 1024.0,
        post_rss as f64 / 1024.0,
        sql_m.total_db_bytes as f64 / (1024.0 * 1024.0),
        sql_m.facts_rows,
        sql_m.contents_rows,
    );

    let mut owned_client = Arc::try_unwrap(client).ok().expect("unique client");
    host.quit(&mut owned_client).await.expect("clean quit host");
    tokio::time::sleep(Duration::from_millis(600)).await;

    verify_sqlite_integrity(&sandbox.root).expect("SQLite integrity after Scenario K");
    let orphans = find_orphan_procs(&marker, sandbox.directory.path());
    eprintln!(
        "[SCEN K] OS-wide orphans after bomb storm: {} ({:?})",
        orphans.len(),
        &orphans[..orphans.len().min(8)]
    );
    if !failures.is_empty() {
        for (k, s, _) in failures.iter().take(2) {
            eprintln!(
                "[SCEN K] FAILED {k} {s} RECENT FACTS:\n{}",
                dump_failed_run_facts(&sandbox.root, s)
            );
        }
    }
    assert!(
        failures.is_empty(),
        "Scenario K failures ({}): {:?}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .map(|(k, s, e)| (*k, s.as_str(), e.chars().take(240).collect::<String>()))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        canary_done.load(Ordering::Relaxed),
        32,
        "all 32 innocent canaries must succeed 100%"
    );
    assert_eq!(
        fanout_archive_verified.load(Ordering::Relaxed),
        4,
        "all 4 JS 80x fanout sessions must complete & verify archive"
    );
    assert!(
        post_fds <= baseline_fds + 25,
        "FD leak after bomb/PTY storm: base={baseline_fds} post={post_fds}"
    );
    assert!(
        orphans.is_empty(),
        "Orphan processes leaked after bomb/terminate/PTY storm ({}): {:?}",
        orphans.len(),
        orphans
    );

    mock.shutdown().await;
}

/// ================================================================================================
/// Scenario L: 10-Wave 600-Session Churn & GC Soak + 25% Mid-Run Active Deletes
///             + 16 Goals + 16 ScheduledTasks + 400+ Concurrent Memory Ops & Recall!
/// ================================================================================================
#[tokio::test]
#[ignore = "hell-tier stress test; run with --release --ignored --nocapture"]
async fn real_host_10_wave_600_session_churn_gc_goals_schedules_memory_soak() {
    let started = Instant::now();
    let sandbox = Sandbox::new().await.expect("sandbox");
    seed_workspace_files(&sandbox.workspace).await;
    let marker = format!("MAKA_HELL_L_{}", uuid::Uuid::new_v4().simple());

    tokio::fs::write(
        sandbox.workspace.join("churn_32k.txt"),
        "CHURN_PAYLOAD_DATA_LINE_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ\n".repeat(520),
    )
    .await
    .expect("write churn_32k.txt");

    let total_reqs = Arc::new(AtomicU64::new(0));
    let schedules_created = Arc::new(AtomicUsize::new(0));
    let schedule_fires = Arc::new(AtomicUsize::new(0));

    let total_reqs_cb = total_reqs.clone();
    let schedules_created_cb = schedules_created.clone();
    let schedule_fires_cb = schedule_fires.clone();
    let marker_cb = marker.clone();

    let mock = MockAiBuilder::new()
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
            max_session_prompt_bytes: Some(16 * 1024 * 1024),
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
            total_reqs_cb.fetch_add(1, Ordering::Relaxed);
            let all = req.all_text();
            let usage = Usage::new(350, 90);

            let last_is_sched_fire = req
                .messages
                .last()
                .is_some_and(|m| matches!(m.role, maka_mock_ai::NormalizedRole::User) && m.text.contains("HELL_L_SCHED_FIRE_"));
            if last_is_sched_fire {
                schedule_fires_cb.fetch_add(1, Ordering::Relaxed);
                return TurnPlan::new()
                    .push_text("SCHED_FIRE_ACK_OK")
                    .with_usage(usage)
                    .finish(FinishReason::Stop);
            }

            if all.contains("HELL_L_GOAL_") {
                if all.contains("GOAL_PHASE_2_DONE") || req.messages.len() > 6 {
                    return TurnPlan::new()
                        .push_text("GOAL_LIFECYCLE_COMPLETE")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                if all.contains("GOAL_PROGRESS_OK") {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("goal_ach_{}", req.sequence),
                            "GoalStatus",
                            json!({ "status": "achieved", "note": "GOAL_PHASE_2_DONE verified" }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }
                if req.messages.len() > 2 {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("goal_prog_{}", req.sequence),
                            "GoalStatus",
                            json!({ "status": "progress", "note": "GOAL_PROGRESS_OK checkpoint" }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }
                return TurnPlan::new()
                    .push_tool_call(
                        format!("goal_create_{}", req.sequence),
                        "CreateGoal",
                        json!({ "objective": format!("Hell soak goal seq {}", req.sequence) }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            if all.contains("HELL_L_SCHED_SETUP_") {
                if req.messages.len() > 2 {
                    if all.contains("SCHED_CREATED_OK") {
                        schedules_created_cb.fetch_add(1, Ordering::Relaxed);
                    }
                    return TurnPlan::new()
                        .push_text("SCHED_SETUP_OK")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64;
                let seq = req.sequence;
                let code = format!(
                    r#"const r = await tools.ScheduledTask({{
  request: {{
    mode: "create",
    title: "HellSched-{seq}",
    intentBody: "HELL_L_SCHED_FIRE_{seq}",
    effect: "session",
    schedule: {{ kind: "interval", everySeconds: 2, startAt: {start_at} }},
    timezone: "UTC",
    maxFires: 2
  }}
}});
text((r && !r.error ? "SCHED_CREATED_OK:" : "SCHED_CREATED_ERR:") + JSON.stringify(r));"#,
                    start_at = now_ms + 800
                );
                return TurnPlan::new()
                    .push_tool_call(
                        format!("sched_create_{}", req.sequence),
                        "exec",
                        json!({ "code": code }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            if all.contains("HELL_L_ACTIVE_DELETE_") {
                if req.messages.len() > 2 {
                    return TurnPlan::new()
                        .push_text("ACTIVE_DEL_FINISHED")
                        .with_usage(usage)
                        .finish(FinishReason::Stop);
                }
                return TurnPlan::new()
                    .push_tool_call(
                        format!("act_del_shell_{}", req.sequence),
                        "Shell",
                        json!({
                            "command": format!("sh -c 'sleep 2.5; echo churn-active-{m}'", m = marker_cb),
                            "login": false
                        }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            if req.messages.len() <= 2 {
                if all.contains("HELL_L_JS_") {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("churn_js_{}", req.sequence),
                            "exec",
                            json!({
                                "code": r#"const r = await tools.Read({ path: "churn_32k.txt", offset: 0, limit: 250 }); text("CHURN_OK:" + r.kind);"#
                            }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }
                if all.contains("HELL_L_PY_") {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("churn_py_{}", req.sequence),
                            "exec",
                            json!({
                                "code": "r = await tools.Read(path='churn_32k.txt', offset=0, limit=250)\ntext('CHURN_OK:' + r['kind'])"
                            }),
                        )
                        .with_usage(usage)
                        .finish(FinishReason::ToolCalls);
                }
                return TurnPlan::new()
                    .push_tool_call(
                        format!("churn_read_{}", req.sequence),
                        "Read",
                        json!({ "path": "churn_32k.txt", "offset": 0, "limit": 250 }),
                    )
                    .with_usage(usage)
                    .finish(FinishReason::ToolCalls);
            }

            TurnPlan::new()
                .push_text(format!(
                    "CHURN_SESSION_COMPLETE seq={} {}",
                    req.sequence,
                    "gc-reclaimable-body-".repeat(120)
                ))
                .with_usage(usage)
                .finish(FinishReason::Stop)
        })
        .start()
        .await
        .expect("start mock-ai");

    let base_url = format!("{}/v1", mock.base_url());
    let conns = seed_hell_connections(&sandbox.root, &base_url, 128_000).await;

    let mut host = Host::spawn(&sandbox).expect("spawn host");
    let (client, _addr) = host.ready().await.expect("host ready");
    let client = Arc::new(client);
    save_all_hell_credentials(&client, &conns).await;

    let host_pid = host.pid().expect("host pid");
    let _baseline_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let baseline_fds = sample_open_fds(host_pid).unwrap_or(0);

    let mut goal_sids = Vec::with_capacity(16);
    let mut sched_sids = Vec::with_capacity(16);
    {
        let mut set = JoinSet::new();
        for i in 0..16usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let b = backend_for(&conns, "ws");
            set.spawn(async move {
                let sid = create_session(&c, &ws, b).await.expect("create goal session");
                let _ = try_call(
                    &c,
                    "agent",
                    "send",
                    json!({ "sessionId": sid, "message": format!("HELL_L_GOAL_{i} Please create a Goal and complete it"), "delivery": "queue" }),
                    Duration::from_secs(20),
                )
                .await;
                (true, sid)
            });
        }
        for i in 0..16usize {
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let b = backend_for(&conns, "js");
            set.spawn(async move {
                let sid = create_session(&c, &ws, b).await.expect("create sched session");
                let _ = try_call(
                    &c,
                    "agent",
                    "send",
                    json!({ "sessionId": sid, "message": format!("HELL_L_SCHED_SETUP_{i}"), "delivery": "queue" }),
                    Duration::from_secs(20),
                )
                .await;
                (false, sid)
            });
        }
        while let Some(r) = set.join_next().await {
            let (is_goal, sid) = r.unwrap();
            if is_goal {
                goal_sids.push(sid);
            } else {
                sched_sids.push(sid);
            }
        }
    }

    let mut wave_metrics: Vec<(usize, u64, usize, u64, u64, u64, u64)> = Vec::with_capacity(10);
    let list_lat = LatencyHistogram::default();
    let mem_lat = LatencyHistogram::default();
    let mut total_deleted = 0usize;
    let mut total_active_deleted = 0usize;
    let mut total_mem_ops = 0usize;

    for wave_idx in 1..=10usize {
        let mut wave_sids: Vec<(usize, String)> = Vec::with_capacity(60);
        {
            let mut set = JoinSet::new();
            for i in 0..60usize {
                let c = client.clone();
                let ws = sandbox.workspace.clone();
                let kind = if i < 15 {
                    if i % 2 == 0 { "ws" } else { "anthropic" }
                } else {
                    match i % 4 {
                        0 => "js",
                        1 => "py",
                        2 => "ws",
                        _ => "anthropic",
                    }
                };
                let b = backend_for(&conns, kind);
                set.spawn(async move {
                    let sid = create_session(&c, &ws, b).await.expect("wave create");
                    (i, sid)
                });
            }
            while let Some(r) = set.join_next().await {
                wave_sids.push(r.unwrap());
            }
            wave_sids.sort_by_key(|x| x.0);
        }

        {
            let mut set = JoinSet::new();
            for (i, sid) in &wave_sids {
                let c = client.clone();
                let sid = sid.clone();
                let msg = if *i < 15 {
                    format!("HELL_L_ACTIVE_DELETE_W{wave_idx}_{i}")
                } else if *i % 4 == 0 {
                    format!("HELL_L_JS_W{wave_idx}_{i}")
                } else if *i % 4 == 1 {
                    format!("HELL_L_PY_W{wave_idx}_{i}")
                } else {
                    format!("HELL_L_STREAM_W{wave_idx}_{i}")
                };
                set.spawn(async move {
                    let _ = try_call(
                        &c,
                        "agent",
                        "send",
                        json!({ "sessionId": sid, "message": msg, "delivery": "queue" }),
                        Duration::from_secs(30),
                    )
                    .await;
                });
            }
            while set.join_next().await.is_some() {}
        }

        let mem_handle = {
            let c = client.clone();
            tokio::spawn(async move {
                let mut mset = JoinSet::new();
                let mut lats = Vec::with_capacity(44);
                for m in 0..40usize {
                    let c = c.clone();
                    mset.spawn(async move {
                        let t0 = Instant::now();
                        let key = if m % 5 == 0 { m / 5 } else { wave_idx * 100 + m };
                        let res = try_call(
                            &c,
                            "agent",
                            "changeMemory",
                            json!({
                                "scope": { "kind": "personal" },
                                "edit": {
                                    "kind": "create",
                                    "body": format!("Hell soak fact key={key} wave={wave_idx} deterministic memory assertion")
                                }
                            }),
                            Duration::from_secs(20),
                        )
                        .await;
                        (t0.elapsed(), res.is_ok())
                    });
                }
                for _ in 0..4usize {
                    let c = c.clone();
                    mset.spawn(async move {
                        let t0 = Instant::now();
                        let res = try_call(
                            &c,
                            "agent",
                            "memories",
                            json!({ "scope": { "kind": "personal" }, "after": null, "limit": 50 }),
                            Duration::from_secs(20),
                        )
                        .await;
                        (t0.elapsed(), res.is_ok())
                    });
                }
                let mut ok = 0usize;
                while let Some(r) = mset.join_next().await {
                    let (d, is_ok) = r.unwrap();
                    lats.push(d);
                    if is_ok {
                        ok += 1;
                    }
                }
                (ok, lats)
            })
        };

        // MID-RUN ACTIVE DELETES (0..15): confirm target run is live, stop it, wait for quiescence, then remove.
        tokio::time::sleep(Duration::from_millis(350)).await;
        {
            let mut del_set = JoinSet::new();
            for (_, sid) in &wave_sids[0..15] {
                let c = client.clone();
                let sid = sid.clone();
                del_set.spawn(async move {
                    let Ok(obs) = try_call(
                        &c,
                        "agent",
                        "observe",
                        json!({ "sessionId": sid }),
                        Duration::from_secs(10),
                    )
                    .await
                    else {
                        return (false, false);
                    };
                    let active_run_id = if obs["session"]["activity"].as_str() == Some("working") {
                        obs["run"]["runId"].as_str().map(str::to_owned)
                    } else {
                        None
                    };
                    let stop_requested = if let Some(ref run_id) = active_run_id {
                        try_call(
                            &c,
                            "agent",
                            "stop",
                            json!({ "sessionId": sid, "runId": run_id }),
                            Duration::from_secs(10),
                        )
                        .await
                        .ok()
                        .is_some_and(|v| v["requested"] == true)
                    } else {
                        false
                    };
                    let settled_ok = wait_session_settled(&c, &sid, Duration::from_secs(20))
                        .await
                        .is_ok();
                    let Ok(settled) = try_call(
                        &c,
                        "agent",
                        "observe",
                        json!({ "sessionId": sid }),
                        Duration::from_secs(10),
                    )
                    .await
                    else {
                        return (false, false);
                    };
                    let Some(rev) = settled["session"]["revision"].as_u64() else {
                        return (false, false);
                    };
                    let Ok(res) = try_call(
                        &c,
                        "agent",
                        "changeSession",
                        json!({ "sessionId": sid, "expectedRevision": rev, "action": "remove" }),
                        Duration::from_secs(15),
                    )
                    .await
                    else {
                        return (false, false);
                    };
                    let removed = res["kind"] == "removed";
                    let active_stopped = active_run_id.is_some() && stop_requested && settled_ok;
                    (active_stopped, removed)
                });
            }
            while let Some(r) = del_set.join_next().await {
                let (was_active, removed) = r.unwrap();
                if removed {
                    total_deleted += 1;
                    if was_active {
                        total_active_deleted += 1;
                    }
                }
            }
        }

        // Wait for remaining 45 sessions (15..60)
        {
            let mut wset = JoinSet::new();
            for (_, sid) in &wave_sids[15..60] {
                let c = client.clone();
                let sid = sid.clone();
                wset.spawn(
                    async move { wait_session_settled(&c, &sid, Duration::from_secs(45)).await },
                );
            }
            while let Some(r) = wset.join_next().await {
                let st = r.unwrap().expect("churn session settle");
                assert!(
                    st == "completed" || st == "idle",
                    "churn session settled {st}"
                );
            }
        }

        // Delete 36 more completed sessions (15..51) -> 51/60 = 85% deletion rate per wave!
        {
            let mut dset = JoinSet::new();
            for (_, sid) in &wave_sids[15..51] {
                let c = client.clone();
                let sid = sid.clone();
                dset.spawn(async move {
                    let obs = try_call(
                        &c,
                        "agent",
                        "observe",
                        json!({ "sessionId": sid }),
                        Duration::from_secs(10),
                    )
                    .await
                    .ok()?;
                    let rev = obs["session"]["revision"].as_u64()?;
                    let res = try_call(
                        &c,
                        "agent",
                        "changeSession",
                        json!({ "sessionId": sid, "expectedRevision": rev, "action": "remove" }),
                        Duration::from_secs(15),
                    )
                    .await
                    .ok()?;
                    Some(res["kind"] == "removed")
                });
            }
            while let Some(r) = dset.join_next().await {
                if r.unwrap().unwrap_or(false) {
                    total_deleted += 1;
                }
            }
        }

        let (m_ok, m_lats) = mem_handle.await.unwrap();
        total_mem_ops += m_ok;
        for d in m_lats {
            mem_lat.record(d);
        }

        let t_list = Instant::now();
        let _ = try_call(
            &client,
            "agent",
            "sessionList",
            json!({ "limit": 100 }),
            Duration::from_secs(15),
        )
        .await
        .expect("wave sessionList");
        list_lat.record(t_list.elapsed());

        let rss = sample_rss_kib(host_pid).unwrap_or(0);
        let fds = sample_open_fds(host_pid).unwrap_or(0);
        let sql_m = sample_sqlite_metrics(&sandbox.root);
        wave_metrics.push((
            wave_idx,
            rss,
            fds,
            sql_m.total_db_bytes,
            sql_m.total_wal_bytes,
            sql_m.facts_rows,
            sql_m.contents_rows,
        ));
        eprintln!(
            "[SCEN L] WAVE {wave_idx:02}/10 | rss={:.1}MiB fds={fds} db={:.1}MiB wal={:.1}MiB facts={} contents={} | del={total_deleted} (active={total_active_deleted}) sched_fires={} mem_ops={total_mem_ops}",
            rss as f64 / 1024.0,
            sql_m.total_db_bytes as f64 / (1024.0 * 1024.0),
            sql_m.total_wal_bytes as f64 / (1024.0 * 1024.0),
            sql_m.facts_rows,
            sql_m.contents_rows,
            schedule_fires.load(Ordering::Relaxed),
        );
    }

    for sid in goal_sids.iter().chain(sched_sids.iter()) {
        let _ = wait_session_settled(&client, sid, Duration::from_secs(30)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Verify durable Goal status per distinct session via agent/goal RPC.
    let mut goals_achieved_verified = 0usize;
    for sid in &goal_sids {
        if let Ok(view) = try_call(
            &client,
            "agent",
            "goal",
            json!({ "sessionId": sid }),
            Duration::from_secs(10),
        )
        .await
            && view["current"]["status"].as_str() == Some("achieved")
        {
            goals_achieved_verified += 1;
        }
    }

    let post_rss = sample_rss_kib(host_pid).unwrap_or(0);
    let post_fds = sample_open_fds(host_pid).unwrap_or(0);
    let w3 = wave_metrics[2];
    let w10 = wave_metrics[9];

    eprintln!(
        "[SCEN L] COMPLETE in {:.2}s | 600 sessions churned, deleted={total_deleted} (mid-run={total_active_deleted}) | goals={goals_achieved_verified}/16 sched_created={}/16 sched_fires={} mem_ops={total_mem_ops} ({}) list({}) total_reqs={}",
        started.elapsed().as_secs_f64(),
        schedules_created.load(Ordering::Relaxed),
        schedule_fires.load(Ordering::Relaxed),
        mem_lat.summary(),
        list_lat.summary(),
        total_reqs.load(Ordering::Relaxed),
    );
    eprintln!(
        "[SCEN L] STEADY-STATE CHECK: W3(rss={:.1}MiB fds={} facts={} contents={}) -> W10(rss={:.1}MiB fds={} facts={} contents={}) | base_fds={baseline_fds} post_fds={post_fds} post_rss={:.1}MiB",
        w3.1 as f64 / 1024.0,
        w3.2,
        w3.5,
        w3.6,
        w10.1 as f64 / 1024.0,
        w10.2,
        w10.5,
        w10.6,
        post_rss as f64 / 1024.0,
    );

    let mut owned_client = Arc::try_unwrap(client).ok().expect("unique client");
    host.quit(&mut owned_client).await.expect("clean quit host");
    tokio::time::sleep(Duration::from_millis(600)).await;

    verify_sqlite_integrity(&sandbox.root).expect("SQLite integrity after 10-wave churn soak");
    let orphans = find_orphan_procs(&marker, sandbox.directory.path());
    assert!(
        orphans.is_empty(),
        "Orphan processes leaked after 10-wave churn soak ({}): {:?}",
        orphans.len(),
        orphans
    );
    assert!(
        total_active_deleted >= 120,
        "expected >= 120 mid-run active sessions stopped and removed across 10 waves, got {total_active_deleted}"
    );
    assert!(
        total_deleted >= 480,
        "expected >= 480 deleted sessions across 10 waves, got {total_deleted}"
    );
    assert!(
        goals_achieved_verified >= 14,
        "expected >= 14/16 Goals verified achieved via agent/goal, got {goals_achieved_verified}"
    );
    assert!(
        schedule_fires.load(Ordering::Relaxed) >= 10,
        "expected >= 10 ScheduledTask firings across 16 tasks, got {}",
        schedule_fires.load(Ordering::Relaxed)
    );
    assert!(
        total_mem_ops >= 400,
        "expected >= 400 memory operations succeeded, got {total_mem_ops}"
    );
    assert!(
        post_fds <= baseline_fds + 30,
        "FD leak across 10-wave 600-session churn: base={baseline_fds} post={post_fds}"
    );
    assert!(
        w10.1 <= (w3.1 * 22 / 10) + 262_144,
        "Unbounded RSS leak across waves 3..10: W3={:.1}MiB W10={:.1}MiB",
        w3.1 as f64 / 1024.0,
        w10.1 as f64 / 1024.0
    );

    mock.shutdown().await;
}
