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

//! Forever-Running O(1) Scaling & Steady-State Soak Suite (Scenario M).
//! Opt-in (`#[ignore]`), run in `--release`:
//!   cargo test --release -p maka-cli --test mainline_reopen real_host_forever_running_o1_soak -- --ignored --nocapture
//!
//! Designed to verify that Maka can run indefinitely without CPU, memory, latency, or storage
//! growing linearly with historical session load:
//!   - Phase 1: Zero-Survivor Pure Churn (14 waves x 28 heavy sessions, 100% deleted every wave)
//!   - Phase 2: Scale-Out Dormant Fleet (250 -> 1,000 -> 3,000 historical sessions = 12x jump,
//!     fixed hot-probe + idle CPU + watch churn swarm at each tier)
//!   - Phase 3: Immortal Session Scale-Deep (300 turns + ~60 compactions + 200-post Room)
//!   - Phase 4: Cold Reopen & SIGKILL Recovery under the full accumulated ~3,400+ session fleet

use super::host_load_stress::{sample_rss_kib, save_credential, seed_workspace_files};
use super::*;
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, MockAiBuilder, ModelEntry, NormalizedRequest, RecorderMode,
    TurnContext, TurnEvent, TurnPlan, Usage, WatchdogConfig,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// =============================================================================
// Telemetry & X-Ray Helpers
// =============================================================================

#[derive(Clone)]
struct SoakConnections {
    js: String,
    fast: String,
    tight: String,
}

async fn seed_soak_connections(root: &Path, base_url: &str) -> SoakConnections {
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
            "soak-js",
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
            "soak-fast",
            "gpt-4.1-mini",
            json!({
                "codeMode": false,
                "apiProtocol": "openai-chat-completions",
                "contextWindow": 128_000,
                "inputLimit": 128_000
            }),
        ),
        (
            "soak-tight",
            "gpt-4.1",
            json!({
                "codeMode": true,
                "codeModeLanguage": "javascript",
                "apiProtocol": "openai-chat-completions",
                "contextWindow": 14_000,
                "inputLimit": 14_000
            }),
        ),
    ];

    let mut ids = Vec::with_capacity(specs.len());
    for (slug, model_id, override_cfg) in specs {
        let catalog = store.catalog().await.unwrap();
        let mut overrides = serde_json::Map::new();
        overrides.insert(model_id.to_string(), override_cfg);
        let req = serde_json::from_value(json!({
            "expectedCatalogRevision": catalog.revision,
            "connection": {
                "slug": slug,
                "name": format!("Forever Soak {slug}"),
                "provider": {
                    "packageId": "maka.providers",
                    "entryId": "maka.providers",
                    "scope": "profile",
                    "name": "openai-compatible"
                },
                "configuration": { "baseUrl": base_url },
                "enabled": true,
                "enabledModelIds": [model_id],
                "modelOverrides": Value::Object(overrides)
            }
        }))
        .unwrap();
        let res = store.create_connection(req).await.unwrap();
        match res {
            maka_agent_facts::configuration::CatalogMutationResult::Committed {
                connection: Some(c),
                ..
            } => ids.push(c.connection_id),
            other => panic!("create connection {slug} failed: {other:?}"),
        }
    }
    store.shutdown().await.unwrap();
    SoakConnections {
        js: ids[0].clone(),
        fast: ids[1].clone(),
        tight: ids[2].clone(),
    }
}

async fn save_soak_credentials(client: &Client, conns: &SoakConnections) {
    for cid in [&conns.js, &conns.fast, &conns.tight] {
        save_credential(client, cid).await;
    }
}

fn backend_js(conns: &SoakConnections) -> Value {
    json!({"kind": "model", "connectionId": conns.js, "modelId": "gpt-4.1", "thinkingLevel": null})
}

fn backend_fast(conns: &SoakConnections) -> Value {
    json!({"kind": "model", "connectionId": conns.fast, "modelId": "gpt-4.1-mini", "thinkingLevel": null})
}

fn backend_tight(conns: &SoakConnections) -> Value {
    json!({"kind": "model", "connectionId": conns.tight, "modelId": "gpt-4.1", "thinkingLevel": null})
}

async fn soak_call(
    client: &Client,
    export: &str,
    method: &str,
    input: Value,
    timeout: Duration,
) -> std::result::Result<Value, String> {
    tokio::time::timeout(timeout, async {
        let mut c = client
            .call(export, method.into(), input, Attachments::new())
            .await
            .map_err(|e| format!("{export}/{method} call: {e}"))?;
        c.start()
            .await
            .map_err(|e| format!("{export}/{method} start: {e}"))?;
        let mut reply = c
            .receive()
            .await
            .map_err(|e| format!("{export}/{method} recv: {e}"))?;
        if let Reply::Prepared { .. } = reply {
            reply = c
                .confirm(json!({ "purpose": "forever-running-soak" }))
                .await
                .map_err(|e| format!("{export}/{method} confirm: {e}"))?;
        }
        match reply {
            Reply::Finished { result, .. } => {
                result.map_err(|e| format!("{export}/{method} finished err: {e}"))
            }
            Reply::Mutation { reply, .. } => match reply.receipt {
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    ..
                } => Ok(value),
                other => Err(format!("{export}/{method} mutation non-success: {other:?}")),
            },
            other => Err(format!("{export}/{method} unexpected reply: {other:?}")),
        }
    })
    .await
    .map_err(|_| format!("{export}/{method} timed out after {timeout:?}"))?
}

/// Samples total user+sys CPU time in milliseconds for `pid` via `ps -p <pid> -o time=`.
/// macOS outputs `MM:SS.cc` or `HH:MM:SS.cc`; Linux outputs `[DD-]HH:MM:SS`.
fn sample_cpu_ms(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "time="])
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let (days, rest) = if let Some((d, r)) = raw.split_once('-') {
        (d.parse::<u64>().ok()?, r)
    } else {
        (0, raw.as_str())
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (hours, mins, secs_str) = match parts.as_slice() {
        [m, s] => (0u64, m.parse::<u64>().ok()?, *s),
        [h, m, s] => (h.parse::<u64>().ok()?, m.parse::<u64>().ok()?, *s),
        _ => return None,
    };
    let (secs, sub_ms) = if let Some((s, frac)) = secs_str.split_once('.') {
        let s = s.parse::<u64>().ok()?;
        let frac_ms = match frac.len() {
            1 => frac.parse::<u64>().ok()? * 100,
            2 => frac.parse::<u64>().ok()? * 10,
            _ => frac[..3].parse::<u64>().ok()?,
        };
        (s, frac_ms)
    } else {
        (secs_str.parse::<u64>().ok()?, 0)
    };
    let total_secs = days * 86_400 + hours * 3_600 + mins * 60 + secs;
    Some(total_secs * 1_000 + sub_ms)
}

fn sample_open_fds(pid: u32) -> Option<usize> {
    let out = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let count = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.starts_with('f'))
        .count();
    Some(count)
}

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

#[derive(Default, Clone, Debug)]
struct StorageXray {
    main_db_path: Option<PathBuf>,
    counts_error: Option<String>,
    total_dir_bytes: u64,
    total_db_bytes: u64,
    total_wal_bytes: u64,
    runtime_wal_bytes: u64,
    runtime_shm_bytes: u64,
    non_db_bytes: u64,
    page_count: u64,
    freelist_count: u64,
    page_size: u64,
    table_counts: BTreeMap<String, u64>,
    top_dbstat: Vec<(String, u64)>,
}

fn sqlite_query_u64_checked(db: &Path, sql: &str) -> std::result::Result<u64, String> {
    let out = std::process::Command::new("sqlite3")
        .arg("-readonly")
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|e| format!("sqlite3 spawn failed on {}: {e}", db.display()))?;
    if !out.status.success() {
        return Err(format!(
            "sqlite3 exited {} on {}: {}",
            out.status,
            db.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    raw.trim()
        .parse::<u64>()
        .map_err(|e| format!("sqlite3 non-integer output {raw:?}: {e}"))
}

fn sqlite_query_u64(db: &Path, sql: &str) -> u64 {
    sqlite_query_u64_checked(db, sql).unwrap_or(0)
}

fn sample_storage_xray(root: &Path) -> StorageXray {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    let mut xray = StorageXray::default();
    let mut main_db: Option<PathBuf> = None;

    for path in files {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        xray.total_dir_bytes += size;
        if name.ends_with("-wal") {
            xray.total_wal_bytes += size;
            if name.contains("runtime-rust") {
                xray.runtime_wal_bytes += size;
            }
        } else if name.ends_with("-shm") {
            if name.contains("runtime-rust") {
                xray.runtime_shm_bytes += size;
            }
        } else if name.ends_with(".db") || name.ends_with(".sqlite") {
            xray.total_db_bytes += size;
            if name.contains("runtime-rust") || main_db.is_none() {
                main_db = Some(path);
            }
        } else {
            xray.non_db_bytes += size;
        }
    }

    if let Some(db) = main_db {
        xray.main_db_path = Some(db.clone());
        xray.page_count = sqlite_query_u64(&db, "PRAGMA page_count;");
        xray.freelist_count = sqlite_query_u64(&db, "PRAGMA freelist_count;");
        xray.page_size = sqlite_query_u64(&db, "PRAGMA page_size;");

        let tracked_tables = [
            "contents",
            "pending_content_releases",
            "application_operations",
            "host_effects",
            "session_control",
            "session_retirements",
            "session_removal_receipts",
            "shell_runs",
            "agent_facts",
            "agent_session_history",
            "agent_history_content_refs",
            "agent_request_specs",
            "agent_catalog_sessions",
            "agent_catalog_controls",
            "agent_recall_messages",
            "agent_usage_calls",
            "agent_room_messages",
            "agent_memories",
            "agent_runs",
            "agent_steps",
            "agent_tools",
            "agent_cells",
        ];
        let derived_keys = [
            "orphan_contents",
            "receipt_contents",
            "non_receipt_contents",
            "request_spec_raw_bytes",
        ];
        let mut count_queries: Vec<String> = tracked_tables
            .iter()
            .map(|t| format!("SELECT '{t}', (SELECT count(*) FROM {t})"))
            .collect();
        count_queries.push(
            "SELECT 'orphan_contents', (SELECT count(*) FROM contents WHERE id NOT IN (SELECT content_id FROM content_references))".into(),
        );
        count_queries.push(
            "SELECT 'receipt_contents', (SELECT count(DISTINCT outcome_content_id) FROM application_operations WHERE outcome_content_id IS NOT NULL)".into(),
        );
        count_queries.push(
            "SELECT 'non_receipt_contents', (SELECT count(*) FROM contents WHERE id NOT IN (SELECT outcome_content_id FROM application_operations WHERE outcome_content_id IS NOT NULL))".into(),
        );
        count_queries.push(
            "SELECT 'request_spec_raw_bytes', (SELECT COALESCE(SUM(COALESCE(c.logical_bytes, length(c.payload))), 0) FROM contents c WHERE c.id IN (SELECT content_id FROM agent_request_specs))".into(),
        );
        let sql_counts = count_queries.join(" UNION ALL ");
        match std::process::Command::new("sqlite3")
            .arg("-readonly")
            .arg(&db)
            .arg(format!("{sql_counts};"))
            .output()
        {
            Ok(out) if out.status.success() => {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    if let Some((t, c)) = line.split_once('|')
                        && let Ok(cnt) = c.trim().parse::<u64>()
                    {
                        xray.table_counts.insert(t.to_string(), cnt);
                    }
                }
                let missing: Vec<&str> = tracked_tables
                    .iter()
                    .chain(derived_keys.iter())
                    .copied()
                    .filter(|k| !xray.table_counts.contains_key(*k))
                    .collect();
                if !missing.is_empty() {
                    xray.counts_error = Some(format!(
                        "storage xray count query omitted expected keys: {missing:?}"
                    ));
                }
            }
            Ok(out) => {
                xray.counts_error = Some(format!(
                    "storage xray sqlite3 exited {}: {}",
                    out.status,
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            Err(err) => {
                xray.counts_error = Some(format!("storage xray sqlite3 spawn failed: {err}"));
            }
        }

        // dbstat is display-only telemetry and remains best-effort.
        if let Ok(out) = std::process::Command::new("sqlite3")
            .arg("-readonly")
            .arg(&db)
            .arg("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 12;")
            .output()
            && out.status.success()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some((name, bytes)) = line.split_once('|')
                    && let Ok(b) = bytes.trim().parse::<u64>()
                {
                    xray.top_dbstat.push((name.to_string(), b));
                }
            }
        }
    } else {
        xray.counts_error = Some(format!(
            "runtime-rust.sqlite not found under {}",
            root.display()
        ));
    }

    xray
}

fn xray_count(xray: &StorageXray, table: &str) -> u64 {
    xray.table_counts.get(table).copied().unwrap_or(0)
}

fn require_xray_count(xray: &StorageXray, key: &str) -> std::result::Result<u64, String> {
    if let Some(err) = &xray.counts_error {
        return Err(err.clone());
    }
    xray.table_counts
        .get(key)
        .copied()
        .ok_or_else(|| format!("storage xray missing required count key {key:?}"))
}

fn format_top_dbstat(xray: &StorageXray, limit: usize) -> String {
    xray.top_dbstat
        .iter()
        .take(limit)
        .map(|(n, b)| format!("{n}={:.2}MiB", *b as f64 / (1024.0 * 1024.0)))
        .collect::<Vec<_>>()
        .join(", ")
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
            .arg("PRAGMA integrity_check;")
            .output()
            .map_err(|e| format!("sqlite3 failed on {}: {e}", path.display()))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text != "ok" {
            return Err(format!(
                "integrity_check failed on {}: {text}",
                path.display()
            ));
        }
        checked += 1;
    }
    Ok(checked)
}

fn find_orphan_processes(marker: &str, sandbox_root: &Path) -> Vec<String> {
    let my_pid = std::process::id();
    let dir_str = sandbox_root.to_string_lossy().to_string();
    let Ok(out) = std::process::Command::new("ps")
        .args(["eww", "-eo", "pid=,command="])
        .output()
    else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.contains("ps eww -eo") {
            continue;
        }
        let pid: u32 = trimmed
            .split_whitespace()
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or(0);
        if pid == 0 || pid == my_pid {
            continue;
        }
        if trimmed.contains(marker) || trimmed.contains(&dir_str) {
            hits.push(trimmed.chars().take(240).collect());
        }
    }
    hits
}

#[derive(Default)]
struct LatencyHist {
    samples_ms: Mutex<Vec<u64>>,
}

impl LatencyHist {
    fn record(&self, d: Duration) {
        self.samples_ms
            .lock()
            .unwrap()
            .push(d.as_millis().min(u64::MAX as u128) as u64);
    }

    fn percentiles(&self) -> (usize, u64, u64, u64) {
        let mut v = self.samples_ms.lock().unwrap().clone();
        if v.is_empty() {
            return (0, 0, 0, 0);
        }
        v.sort_unstable();
        let n = v.len();
        let p50 = v[n / 2];
        let p95 = v[(n * 95 / 100).min(n - 1)];
        let max = v[n - 1];
        (n, p50, p95, max)
    }
}

async fn create_session_titled(
    client: &Client,
    workspace: &Path,
    backend: Value,
    title: &str,
) -> std::result::Result<String, String> {
    let created = soak_call(
        client,
        "agent",
        "create",
        json!({
            "title": title,
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

async fn create_room_titled(
    client: &Client,
    workspace: &Path,
    title: &str,
) -> std::result::Result<String, String> {
    let created = soak_call(
        client,
        "agent",
        "create",
        json!({
            "kind": "room",
            "title": title,
            "labels": [],
            "workspace": { "kind": "directory", "path": workspace }
        }),
        Duration::from_secs(30),
    )
    .await?;
    created["session"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("create room missing session.id: {created}"))
}

async fn wait_settled(
    client: &Client,
    session_id: &str,
    timeout: Duration,
) -> std::result::Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            let last = soak_call(
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
        if let Ok(obs) = soak_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": session_id }),
            Duration::from_secs(15),
        )
        .await
        {
            let activity = obs["session"]["activity"].as_str().unwrap_or("");
            let run = &obs["run"];
            let kind = if run.is_null() {
                "idle"
            } else {
                run["state"]
                    .as_str()
                    .or_else(|| run["state"]["kind"].as_str())
                    .unwrap_or("idle")
            };
            if (activity == "idle" || (activity == "waiting" && kind == "blocked"))
                && matches!(
                    kind,
                    "completed" | "failed" | "cancelled" | "blocked" | "idle"
                )
            {
                return Ok(kind.to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn wait_fresh_run_settled(
    client: &Client,
    session_id: &str,
    prev_run_id: Option<&str>,
    timeout: Duration,
) -> std::result::Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            let last = soak_call(
                client,
                "agent",
                "observe",
                json!({ "sessionId": session_id }),
                Duration::from_secs(10),
            )
            .await;
            return Err(format!(
                "session {session_id} fresh run did not settle within {timeout:?}; last={last:?}"
            ));
        }
        if let Ok(obs) = soak_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": session_id }),
            Duration::from_secs(15),
        )
        .await
        {
            let activity = obs["session"]["activity"].as_str().unwrap_or("");
            let queued_empty = obs["queued"]
                .as_array()
                .is_none_or(|items| items.is_empty());
            let run = &obs["run"];
            let latest_run_id = obs["latestRunId"]
                .as_str()
                .or_else(|| run["runId"].as_str());
            let advanced = latest_run_id.is_some() && latest_run_id != prev_run_id;
            if activity == "idle" && queued_empty && advanced {
                if run.is_null() {
                    return Ok("idle".into());
                }
                let kind = run["state"]
                    .as_str()
                    .or_else(|| run["state"]["kind"].as_str())
                    .unwrap_or("idle");
                if matches!(
                    kind,
                    "completed" | "failed" | "cancelled" | "blocked" | "idle"
                ) {
                    return Ok(kind.to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(35)).await;
    }
}

async fn remove_session_timed(client: &Client, sid: &str) -> std::result::Result<Duration, String> {
    let t0 = Instant::now();
    for attempt in 0..40usize {
        let obs = soak_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": sid }),
            Duration::from_secs(15),
        )
        .await?;
        if obs["session"]["activity"].as_str() == Some("working")
            && let Some(run_id) = obs["run"]["runId"].as_str()
        {
            let _ = soak_call(
                client,
                "agent",
                "stop",
                json!({ "sessionId": sid, "runId": run_id }),
                Duration::from_secs(10),
            )
            .await;
            let _ = wait_settled(client, sid, Duration::from_secs(20)).await;
        }
        let obs2 = soak_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": sid }),
            Duration::from_secs(15),
        )
        .await?;
        let rev = obs2["session"]["revision"]
            .as_u64()
            .ok_or_else(|| format!("missing revision for {sid}: {obs2}"))?;
        let res = soak_call(
            client,
            "agent",
            "changeSession",
            json!({ "sessionId": sid, "expectedRevision": rev, "action": "remove" }),
            Duration::from_secs(20),
        )
        .await?;
        if res["kind"] == "removed" {
            return Ok(t0.elapsed());
        }
        let retryable = (res["kind"] == "rejected" && res["reason"] == "busy")
            || res["kind"] == "revision_conflict";
        if retryable && attempt + 1 < 40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }
        return Err(format!("expected removed for {sid}, got {res}"));
    }
    Err(format!("exhausted retries removing {sid}"))
}

async fn archive_session(client: &Client, sid: &str) -> std::result::Result<(), String> {
    for attempt in 0..40usize {
        let obs = soak_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": sid }),
            Duration::from_secs(15),
        )
        .await?;
        let rev = obs["session"]["revision"]
            .as_u64()
            .ok_or_else(|| format!("missing revision for archive {sid}"))?;
        let res = soak_call(
            client,
            "agent",
            "changeSession",
            json!({ "sessionId": sid, "expectedRevision": rev, "action": "archive" }),
            Duration::from_secs(15),
        )
        .await?;
        if res["kind"] == "changed" {
            return Ok(());
        }
        let retryable = (res["kind"] == "rejected" && res["reason"] == "busy")
            || res["kind"] == "revision_conflict";
        if retryable && attempt + 1 < 40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }
        return Err(format!("expected changed on archive {sid}, got {res}"));
    }
    Err(format!("exhausted retries archiving {sid}"))
}

async fn list_all_active_ids(client: &Client) -> Vec<String> {
    let mut ids = Vec::new();
    let mut pos = json!({ "kind": "start" });
    for _ in 0..100 {
        let Ok(page) = soak_call(
            client,
            "agent",
            "list",
            json!({
                "kind": null,
                "filter": "all",
                "includeArchived": false,
                "rootsOnly": false,
                "position": pos
            }),
            Duration::from_secs(20),
        )
        .await
        else {
            break;
        };
        let Some(sessions) = page["sessions"].as_array() else {
            break;
        };
        if sessions.is_empty() {
            break;
        }
        for item in sessions {
            if let Some(id) = item["id"].as_str() {
                ids.push(id.to_string());
            }
        }
        if let (Some(rev), Some(next)) = (page["revision"].as_str(), page["after"].as_str()) {
            pos = json!({ "kind": "after", "revision": rev, "cursor": next });
        } else {
            break;
        }
    }
    ids
}

#[derive(Clone, Debug)]
struct HotProbeResult {
    hot_wall_ms: u64,
    hot_cpu_ms_per_turn: f64,
    hot_turn_p50: u64,
    hot_turn_p95: u64,
    list_roots_p95: u64,
    list_title_p95: u64,
    session_list_p95: u64,
    observe_p95: u64,
    search_p95: u64,
    usage_page_p95: u64,
    usage_summary_p95: u64,
    remove_p95: u64,
    idle_cpu_pct: f64,
    rss_mib: f64,
    fds: usize,
    xray: StorageXray,
}

struct HotProbeContext<'a> {
    client: &'a Arc<Client>,
    workspace: &'a Path,
    sandbox_root: &'a Path,
    host_pid: u32,
    conns: &'a SoakConnections,
    hot_sids: &'a [String],
    watch_pause: &'a Arc<AtomicBool>,
}

async fn run_fixed_hot_probe(
    ctx: &HotProbeContext<'_>,
    tier_label: &str,
    cold_sample_sids: &[String],
    search_token: &str,
) -> HotProbeResult {
    let client = ctx.client;
    let workspace = ctx.workspace;
    let sandbox_root = ctx.sandbox_root;
    let host_pid = ctx.host_pid;
    let conns = ctx.conns;
    let hot_sids = ctx.hot_sids;
    let watch_pause = ctx.watch_pause;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;

    // 1. 16 hot sessions execute a deterministic 2-turn tool workflow (Read + Write + final).
    let hot_hist = Arc::new(LatencyHist::default());
    let cpu_before = sample_cpu_ms(host_pid).unwrap_or(0);
    let hot_t0 = Instant::now();
    {
        let mut set = JoinSet::new();
        for (i, sid) in hot_sids.iter().enumerate() {
            let c = client.clone();
            let sid = sid.clone();
            let hist = hot_hist.clone();
            let label = tier_label.to_string();
            set.spawn(async move {
                let prev_run = soak_call(
                    &c,
                    "agent",
                    "observe",
                    json!({ "sessionId": sid }),
                    Duration::from_secs(10),
                )
                .await
                .ok()
                .and_then(|o| {
                    o["latestRunId"]
                        .as_str()
                        .or_else(|| o["run"]["runId"].as_str())
                        .map(str::to_owned)
                });
                let t0 = Instant::now();
                let res = soak_call(
                    &c,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": format!("SOAK_HOT_PROBE_{label}_{i} run tool round"),
                        "delivery": "queue"
                    }),
                    Duration::from_secs(30),
                )
                .await;
                assert!(res.is_ok(), "hot probe send failed ({label} #{i}): {res:?}");
                let st =
                    wait_fresh_run_settled(&c, &sid, prev_run.as_deref(), Duration::from_secs(45))
                        .await
                        .unwrap_or_else(|e| panic!("hot probe settle failed ({label} #{i}): {e}"));
                assert!(
                    st == "completed" || st == "idle",
                    "hot probe unexpected state {st}"
                );
                hist.record(t0.elapsed());
            });
        }
        while let Some(r) = set.join_next().await {
            r.unwrap();
        }
    }
    let hot_wall_ms = hot_t0.elapsed().as_millis() as u64;
    let cpu_after = sample_cpu_ms(host_pid).unwrap_or(cpu_before);
    let hot_cpu_ms = cpu_after.saturating_sub(cpu_before);
    let hot_cpu_ms_per_turn = hot_cpu_ms as f64 / hot_sids.len().max(1) as f64;
    let (_, hot_turn_p50, hot_turn_p95, _) = hot_hist.percentiles();

    // 2. Read/query probes (20 iterations each for UI catalog, observe, recall, usage).
    let list_roots_hist = LatencyHist::default();
    let list_title_hist = LatencyHist::default();
    let session_list_hist = LatencyHist::default();
    let observe_hist = LatencyHist::default();
    let search_hist = LatencyHist::default();
    let usage_page_hist = LatencyHist::default();
    let usage_summary_hist = LatencyHist::default();

    for i in 0..20usize {
        let t0 = Instant::now();
        let res = soak_call(
            client,
            "agent",
            "list",
            json!({
                "kind": null,
                "filter": "all",
                "includeArchived": false,
                "rootsOnly": true,
                "position": { "kind": "start" }
            }),
            Duration::from_secs(20),
        )
        .await;
        assert!(res.is_ok(), "agent/list rootsOnly failed: {res:?}");
        list_roots_hist.record(t0.elapsed());

        let t0 = Instant::now();
        let res = soak_call(
            client,
            "agent",
            "list",
            json!({
                "kind": null,
                "filter": "all",
                "includeArchived": true,
                "rootsOnly": false,
                "titleQuery": "FLEET_T",
                "position": { "kind": "start" }
            }),
            Duration::from_secs(20),
        )
        .await;
        assert!(res.is_ok(), "agent/list titleQuery failed: {res:?}");
        list_title_hist.record(t0.elapsed());

        let t0 = Instant::now();
        let res = soak_call(
            client,
            "agent",
            "sessionList",
            json!({ "limit": 50 }),
            Duration::from_secs(20),
        )
        .await;
        assert!(res.is_ok(), "agent/sessionList failed: {res:?}");
        session_list_hist.record(t0.elapsed());

        let target_sid = if i % 2 == 0 || cold_sample_sids.is_empty() {
            &hot_sids[i % hot_sids.len()]
        } else {
            &cold_sample_sids[i % cold_sample_sids.len()]
        };
        let t0 = Instant::now();
        let obs = soak_call(
            client,
            "agent",
            "observe",
            json!({ "sessionId": target_sid }),
            Duration::from_secs(20),
        )
        .await
        .expect("agent/observe failed");
        observe_hist.record(t0.elapsed());

        // Time cross-session global FTS5 recall across the full historical fleet.
        let t0 = Instant::now();
        let recall_ok = tokio::time::timeout(Duration::from_secs(20), async {
            let mut sub = client
                .call(
                    "agent",
                    "recall".into(),
                    json!({
                        "terms": [search_token],
                        "limit": 20,
                        "session_id": null,
                        "since": null,
                        "until": null
                    }),
                    Attachments::new(),
                )
                .await
                .map_err(|e| format!("recall open: {e}"))?;
            sub.start()
                .await
                .map_err(|e| format!("recall start: {e}"))?;
            match sub
                .receive()
                .await
                .map_err(|e| format!("recall recv: {e}"))?
            {
                Reply::Subscribed => {}
                other => return Err(format!("recall unexpected: {other:?}")),
            }
            loop {
                match sub.pull().await.map_err(|e| format!("recall pull: {e}"))? {
                    Reply::Item { .. } | Reply::Finished { result: Ok(_), .. } => return Ok(()),
                    Reply::Progress { .. } => continue,
                    other => return Err(format!("recall ended without item: {other:?}")),
                }
            }
        })
        .await
        .map_err(|_| "recall timed out".to_string())
        .and_then(|r| r);
        assert!(recall_ok.is_ok(), "agent/recall failed: {recall_ok:?}");
        search_hist.record(t0.elapsed());
        let _ = obs;
    }

    for _ in 0..10usize {
        let range = json!({
            "from": 0.0,
            "to": now_ms + 86_400_000.0,
            "sessionId": null,
            "through": null
        });
        let t0 = Instant::now();
        let res = soak_call(
            client,
            "settings",
            "usage",
            json!({
                "range": range,
                "selection": { "kind": null, "status": null, "search": "" },
                "cursor": null
            }),
            Duration::from_secs(20),
        )
        .await;
        assert!(res.is_ok(), "settings/usage failed: {res:?}");
        usage_page_hist.record(t0.elapsed());

        let t0 = Instant::now();
        let res = soak_call(
            client,
            "settings",
            "usageSummary",
            json!({
                "range": range,
                "group": "byModel",
                "cursor": null
            }),
            Duration::from_secs(20),
        )
        .await;
        assert!(res.is_ok(), "settings/usageSummary failed: {res:?}");
        usage_summary_hist.record(t0.elapsed());
    }

    // 3. Remove latency probe: 10 fresh sessions run 1 tool turn, then timed changeSession(remove).
    let remove_hist = LatencyHist::default();
    for i in 0..10usize {
        let sid = create_session_titled(
            client,
            workspace,
            backend_fast(conns),
            &format!("REMOVE_PROBE_{tier_label}_{i}"),
        )
        .await
        .expect("create remove-probe session");
        soak_call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": sid,
                "message": format!("SOAK_FAST_TOOL_{tier_label}_{i}"),
                "delivery": "queue"
            }),
            Duration::from_secs(20),
        )
        .await
        .expect("send remove-probe");
        let _ = wait_settled(client, &sid, Duration::from_secs(30))
            .await
            .expect("settle remove-probe");
        let dur = remove_session_timed(client, &sid)
            .await
            .expect("remove probe session");
        remove_hist.record(dur);
    }

    // 4. Quiet Idle CPU probe: pause watch swarm, let GC settle 0.8s, measure 3.0s quiet CPU%.
    watch_pause.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let idle_cpu0 = sample_cpu_ms(host_pid).unwrap_or(0);
    let idle_t0 = Instant::now();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let idle_wall_ms = idle_t0.elapsed().as_millis().max(1) as f64;
    let idle_cpu1 = sample_cpu_ms(host_pid).unwrap_or(idle_cpu0);
    let idle_cpu_pct = (idle_cpu1.saturating_sub(idle_cpu0) as f64 / idle_wall_ms) * 100.0;
    watch_pause.store(false, Ordering::SeqCst);

    let rss_mib = sample_rss_kib(host_pid).unwrap_or(0) as f64 / 1024.0;
    let fds = sample_open_fds(host_pid).unwrap_or(0);
    let xray = sample_storage_xray(sandbox_root);

    let result = HotProbeResult {
        hot_wall_ms,
        hot_cpu_ms_per_turn,
        hot_turn_p50,
        hot_turn_p95,
        list_roots_p95: list_roots_hist.percentiles().2,
        list_title_p95: list_title_hist.percentiles().2,
        session_list_p95: session_list_hist.percentiles().2,
        observe_p95: observe_hist.percentiles().2,
        search_p95: search_hist.percentiles().2,
        usage_page_p95: usage_page_hist.percentiles().2,
        usage_summary_p95: usage_summary_hist.percentiles().2,
        remove_p95: remove_hist.percentiles().2,
        idle_cpu_pct,
        rss_mib,
        fds,
        xray,
    };

    eprintln!(
        "[SCEN M][PROBE {tier_label}] hot_wall={}ms cpu/turn={:.1}ms turn(p50={} p95={}) | list_roots_p95={}ms list_title_p95={}ms sessList_p95={}ms obs_p95={}ms search_p95={}ms usage_p95={}ms usageSum_p95={}ms remove_p95={}ms | idle_cpu={:.2}% rss={:.1}MiB fds={} | db={:.1}MiB rwal={:.1}MiB rshm={:.2}MiB free={}pgs req_raw={:.2}MiB | contents={} ops={} effects={} ctrl={} ret={} rec={} facts={} usage={}",
        result.hot_wall_ms,
        result.hot_cpu_ms_per_turn,
        result.hot_turn_p50,
        result.hot_turn_p95,
        result.list_roots_p95,
        result.list_title_p95,
        result.session_list_p95,
        result.observe_p95,
        result.search_p95,
        result.usage_page_p95,
        result.usage_summary_p95,
        result.remove_p95,
        result.idle_cpu_pct,
        result.rss_mib,
        result.fds,
        result.xray.total_db_bytes as f64 / (1024.0 * 1024.0),
        result.xray.runtime_wal_bytes as f64 / (1024.0 * 1024.0),
        result.xray.runtime_shm_bytes as f64 / (1024.0 * 1024.0),
        result.xray.freelist_count,
        xray_count(&result.xray, "request_spec_raw_bytes") as f64 / (1024.0 * 1024.0),
        xray_count(&result.xray, "contents"),
        xray_count(&result.xray, "application_operations"),
        xray_count(&result.xray, "host_effects"),
        xray_count(&result.xray, "session_control"),
        xray_count(&result.xray, "session_retirements"),
        xray_count(&result.xray, "session_removal_receipts"),
        xray_count(&result.xray, "agent_facts"),
        xray_count(&result.xray, "agent_usage_calls"),
    );
    eprintln!(
        "[SCEN M][DBSTAT {tier_label}] {}",
        format_top_dbstat(&result.xray, 10)
    );

    result
}

// =============================================================================
// SCENARIO M: FOREVER-RUNNING O(1) SCALING & STEADY-STATE SOAK
// =============================================================================

#[ignore]
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
async fn real_host_forever_running_o1_soak() {
    let started = Instant::now();
    let sandbox = Sandbox::new().await.expect("create sandbox");
    seed_workspace_files(&sandbox.workspace).await;
    let marker = format!("MAKA_FOREVER_SOAK_{}", std::process::id());

    let total_reqs = Arc::new(AtomicU64::new(0));
    let compaction_reqs = Arc::new(AtomicUsize::new(0));
    let crash_sentinel_hits = Arc::new(AtomicUsize::new(0));
    let crash_sentinel_hold = Arc::new(AtomicBool::new(true));
    let reqs_cb = total_reqs.clone();
    let comp_cb = compaction_reqs.clone();
    let sentinel_hits_cb = crash_sentinel_hits.clone();
    let sentinel_hold_cb = crash_sentinel_hold.clone();
    let marker_cb = marker.clone();

    let mock = MockAiBuilder::new()
        .recorder(RecorderMode::MetricsOnly)
        .control(ControlPlaneConfig {
            enable_admin_api: true,
            models: vec![
                ModelEntry::simple("gpt-4.1"),
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
            let seq = reqs_cb.fetch_add(1, Ordering::Relaxed);
            let all = req.all_text();
            let last_user = req
                .messages
                .iter()
                .rev()
                .find(|m| matches!(m.role, maka_mock_ai::NormalizedRole::User))
                .map(|m| m.text.as_str())
                .unwrap_or_default();

            // Phase 4 crash-recovery sentinel: hold in-flight until SIGKILL, then answer cleanly on reopen.
            if last_user.contains("SOAK_P4_CRASH_SENTINEL") {
                sentinel_hits_cb.fetch_add(1, Ordering::Release);
                if sentinel_hold_cb.load(Ordering::Acquire) {
                    return TurnPlan::new()
                        .with_delay(Duration::from_secs(30))
                        .push_text("SOAK_P4_SENTINEL_UNEXPECTED_PREKILL")
                        .with_usage(Usage::new(200, 40))
                        .finish(FinishReason::Stop);
                }
                return TurnPlan::new()
                    .push_text("SOAK_P4_SENTINEL_RECOVERED")
                    .with_usage(Usage::new(200, 40))
                    .finish(FinishReason::Stop);
            }

            // Context compaction / summary turns: Maka sends summarization requests without tools.
            let is_compaction = req.tools.is_empty()
                || req
                    .system_text
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("compaction")
                || all.contains("Summarize the conversation");
            if is_compaction {
                let n = comp_cb.fetch_add(1, Ordering::Relaxed) + 1;
                return TurnPlan::new()
                    .push_text(format!(
                        "Compacted rolling checkpoint #{n}. Preserved active facts and workspace anchors."
                    ))
                    .with_usage(Usage::new(1_200, 120))
                    .finish(FinishReason::Stop);
            }

            // Phase 1 heavy V8 Code Mode churn: Read + Write + Shell + 48KiB archive output.
            if last_user.contains("SOAK_CHURN_JS_") {
                if req.messages.iter().rev().take(2).any(|m| m.text.contains("CHURN_JS_DONE"))
                    || req.messages.len() > 4
                {
                    return TurnPlan::new()
                        .push_text("SOAK_CHURN_JS_COMPLETE")
                        .with_usage(Usage::new(450, 80))
                        .finish(FinishReason::Stop);
                }
                let code = format!(
                    r#"
                    store("k", "v-{seq}");
                    const [r, w, s] = await Promise.all([
                        tools.Read({{ path: "fixture_0.txt", offset: 0, limit: 8 }}),
                        tools.Write({{ path: "churn_js_{seq}.txt", content: "payload-{seq}-" + "x".repeat(2048) }}),
                        tools.Shell({{ command: "sh -c 'echo churn-{seq}-{m}'", login: false }}),
                    ]);
                    text("CHURN_JS_DONE:" + load("k") + ":" + r.kind + ":" + w.kind + ":" + s.kind + ":" + "B".repeat(49152));
                    "#,
                    m = marker_cb
                );
                return TurnPlan::new()
                    .push_tool_call(
                        format!("exec_churn_{seq}"),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 20000 }),
                    )
                    .with_usage(Usage::new(500, 140))
                    .finish(FinishReason::ToolCalls);
            }

            // Phase 1 direct tools churn: Write + Read + Shell.
            if last_user.contains("SOAK_CHURN_TOOLS_") {
                if req.messages.len() <= 2 {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("w_churn_{seq}"),
                            "Write",
                            json!({ "path": format!("churn_t_{seq}.txt"), "content": "Z".repeat(8192) }),
                        )
                        .push_tool_call(
                            format!("r_churn_{seq}"),
                            "Read",
                            json!({ "path": "fixture_1.txt", "offset": 0, "limit": 12 }),
                        )
                        .push_tool_call(
                            format!("sh_churn_{seq}"),
                            "Shell",
                            json!({ "command": format!("sh -c 'echo tool-{seq}-{marker_cb}'"), "login": false }),
                        )
                        .with_usage(Usage::new(400, 120))
                        .finish(FinishReason::ToolCalls);
                }
                return TurnPlan::new()
                    .push_text(format!("SOAK_CHURN_TOOLS_OK seq={seq}"))
                    .with_usage(Usage::new(400, 60))
                    .finish(FinishReason::Stop);
            }

            // Phase 1 subagent churn: spawn 1 child via SessionCreate + SessionSend inside JS cell.
            if last_user.contains("SOAK_CHURN_SUB_") {
                if req.messages.len() > 3 || all.contains("CHURN_SUB_DONE") {
                    return TurnPlan::new()
                        .push_text("SOAK_CHURN_SUB_COMPLETE")
                        .with_usage(Usage::new(400, 70))
                        .finish(FinishReason::Stop);
                }
                let code = format!(
                    r#"
                    const created = await tools.SessionCreate({{ title: "SoakChild_{seq}" }});
                    const childId = created?.value?.session?.id || created?.session?.id || created?.id;
                    if (childId) {{
                        await tools.SessionSend({{
                            sessionId: childId,
                            message: "SOAK_FAST_TEXT child work {seq}",
                            onComplete: "none"
                        }});
                    }}
                    text("CHURN_SUB_DONE:" + String(childId));
                    "#
                );
                return TurnPlan::new()
                    .push_tool_call(
                        format!("exec_sub_{seq}"),
                        "exec",
                        json!({ "code": code, "yield_time_ms": 20000 }),
                    )
                    .with_usage(Usage::new(400, 120))
                    .finish(FinishReason::ToolCalls);
            }

            // Phase 1 chunked stream churn.
            if last_user.contains("SOAK_CHURN_STREAM_") {
                let mut plan = TurnPlan::new();
                plan.chunk_delay_ms = 2;
                plan.events.push(TurnEvent::Text {
                    text: format!(
                        "SOAK_STREAM_ACK seq={seq} {}",
                        "stream-chunk-payload-".repeat(40)
                    ),
                    chunk_chars: 32,
                    citations: vec![],
                });
                return plan.with_usage(Usage::new(350, 180)).finish(FinishReason::Stop);
            }

            // Phase 2 hot probe & fast tool sessions: 1 Read + 1 Write -> Done.
            if last_user.contains("SOAK_HOT_PROBE_") || last_user.contains("SOAK_FAST_TOOL_") {
                let tail_has_tool = req
                    .messages
                    .last()
                    .is_some_and(|m| matches!(m.role, maka_mock_ai::NormalizedRole::Tool));
                if !tail_has_tool {
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("r_probe_{seq}"),
                            "Read",
                            json!({ "path": "fixture_0.txt", "offset": 0, "limit": 6 }),
                        )
                        .with_usage(Usage::new(320, 80))
                        .finish(FinishReason::ToolCalls);
                }
                return TurnPlan::new()
                    .push_text(format!("SOAK_PROBE_DONE seq={seq} {}", last_user))
                    .with_usage(Usage::new(320, 60))
                    .finish(FinishReason::Stop);
            }

            // Phase 3 Immortal Session turns: report prompt-proportional token usage so proactive
            // compaction fires automatically every ~4-6 turns on the 14,000-token window!
            if last_user.contains("SOAK_IMMORTAL_TURN_") {
                let prompt_tokens = ((all.len() / 2) as u64).max(2_200);
                let tail_has_tool = req
                    .messages
                    .last()
                    .is_some_and(|m| matches!(m.role, maka_mock_ai::NormalizedRole::Tool));
                if !tail_has_tool {
                    if seq.is_multiple_of(3) {
                        let code = format!(
                            r#"
                            const r = await tools.Read({{ path: "fixture_2.txt", offset: 0, limit: 8 }});
                            notify("immortal_notice_{seq}");
                            text("IMMORTAL_CELL_OK_{seq}:" + r.kind + ":" + "M".repeat(2048));
                            "#
                        );
                        return TurnPlan::new()
                            .push_tool_call(
                                format!("imm_exec_{seq}"),
                                "exec",
                                json!({ "code": code, "yield_time_ms": 20000 }),
                            )
                            .with_usage(Usage::new(prompt_tokens, 400))
                            .finish(FinishReason::ToolCalls);
                    }
                    return TurnPlan::new()
                        .push_tool_call(
                            format!("imm_w_{seq}"),
                            "Write",
                            json!({ "path": "immortal_scratch.txt", "content": format!("turn-{seq}-{}", "Q".repeat(1024)) }),
                        )
                        .with_usage(Usage::new(prompt_tokens, 350))
                        .finish(FinishReason::ToolCalls);
                }
                return TurnPlan::new()
                    .push_text(format!(
                        "IMMORTAL_TURN_COMPLETE seq={seq} detail={}",
                        "durable-context-entry-".repeat(28)
                    ))
                    .with_usage(Usage::new(prompt_tokens + 600, 420))
                    .finish(FinishReason::Stop);
            }

            // Default fast fleet / child / room-mention turn: single fast completion with searchable token.
            TurnPlan::new()
                .push_text(format!("SOAK_ACK seq={seq} echo={last_user}"))
                .with_usage(Usage::new(260, 50))
                .finish(FinishReason::Stop)
        })
        .start()
        .await
        .expect("start mock-ai");

    let base_url = format!("{}/v1", mock.base_url());
    let conns = seed_soak_connections(&sandbox.root, &base_url).await;

    let mut host = Host::spawn(&sandbox).expect("spawn host");
    let (client, address) = host.ready().await.expect("host ready");
    let client = Arc::new(client);
    save_soak_credentials(&client, &conns).await;

    let host_pid = host.pid().expect("host pid");
    let base_fds = sample_open_fds(host_pid).unwrap_or(0);
    let base_rss_mib = sample_rss_kib(host_pid).unwrap_or(0) as f64 / 1024.0;
    eprintln!(
        "[SCEN M] Host started pid={host_pid} baseline rss={base_rss_mib:.1}MiB fds={base_fds}"
    );

    let mut violations: Vec<String> = Vec::new();

    // =========================================================================
    // PHASE 1: ZERO-SURVIVOR PURE CHURN STEADY-STATE (14 waves x 28 = 392)
    // =========================================================================
    eprintln!(
        "
[SCEN M] === PHASE 1: ZERO-SURVIVOR PURE CHURN (14 waves x 28 heavy sessions, 100% deleted) ==="
    );

    #[derive(Clone)]
    struct ChurnWaveMetric {
        rss_mib: f64,
        fds: usize,
        cpu_ms_per_sess: f64,
        remove_p95_ms: u64,
        xray: StorageXray,
    }
    let mut churn_metrics: Vec<ChurnWaveMetric> = Vec::with_capacity(14);
    let mut total_churn_deleted = 0usize;

    for wave in 1..=14usize {
        let cpu0 = sample_cpu_ms(host_pid).unwrap_or(0);
        let mut wave_sids: Vec<(usize, String)> = Vec::with_capacity(28);
        {
            let mut set = JoinSet::new();
            for i in 0..28usize {
                let c = client.clone();
                let ws = sandbox.workspace.clone();
                let be = if i < 14 {
                    backend_js(&conns)
                } else {
                    backend_fast(&conns)
                };
                set.spawn(async move {
                    let sid =
                        create_session_titled(&c, &ws, be, &format!("CHURN_W{wave:02}_{i:02}"))
                            .await
                            .expect("create churn session");
                    (i, sid)
                });
            }
            while let Some(r) = set.join_next().await {
                wave_sids.push(r.unwrap());
            }
        }
        wave_sids.sort_by_key(|(i, _)| *i);

        // Send mixed heavy workload to all 28 sessions concurrently.
        {
            let mut set = JoinSet::new();
            for (i, sid) in &wave_sids {
                let c = client.clone();
                let sid = sid.clone();
                let idx = *i;
                let msg = if idx < 8 {
                    format!("SOAK_CHURN_JS_W{wave}_{idx}")
                } else if idx < 14 {
                    format!("SOAK_CHURN_SUB_W{wave}_{idx}")
                } else if idx < 22 {
                    format!("SOAK_CHURN_TOOLS_W{wave}_{idx}")
                } else {
                    format!("SOAK_CHURN_STREAM_W{wave}_{idx}")
                };
                set.spawn(async move {
                    soak_call(
                        &c,
                        "agent",
                        "send",
                        json!({ "sessionId": sid, "message": msg, "delivery": "queue" }),
                        Duration::from_secs(30),
                    )
                    .await
                    .expect("churn send");
                    let st = wait_settled(&c, &sid, Duration::from_secs(45))
                        .await
                        .expect("churn settle");
                    assert!(st == "completed" || st == "idle", "churn state {st}");
                });
            }
            while let Some(r) = set.join_next().await {
                r.unwrap();
            }
        }

        // Delete 100% of active sessions (parents + any spawned children) in drain passes so 0 survive!
        let rem_hist = Arc::new(LatencyHist::default());
        for _pass in 0..8 {
            let active_to_delete = list_all_active_ids(&client).await;
            if active_to_delete.is_empty() {
                break;
            }
            let mut set = JoinSet::new();
            for sid in active_to_delete {
                let c = client.clone();
                let hist = rem_hist.clone();
                set.spawn(async move {
                    let d = remove_session_timed(&c, &sid)
                        .await
                        .unwrap_or_else(|e| panic!("zero-survivor remove failed for {sid}: {e}"));
                    hist.record(d);
                });
            }
            while let Some(r) = set.join_next().await {
                r.unwrap();
                total_churn_deleted += 1;
            }
        }
        let survivors = list_all_active_ids(&client).await;
        assert!(
            survivors.is_empty(),
            "Phase 1 wave {wave} expected 0 surviving active sessions, found {}",
            survivors.len()
        );

        // Give material.rs background GC & incremental_vacuum time to drain.
        tokio::time::sleep(Duration::from_millis(1200)).await;

        let cpu1 = sample_cpu_ms(host_pid).unwrap_or(cpu0);
        let cpu_ms_per_sess = cpu1.saturating_sub(cpu0) as f64 / 28.0;
        let rss_mib = sample_rss_kib(host_pid).unwrap_or(0) as f64 / 1024.0;
        let fds = sample_open_fds(host_pid).unwrap_or(0);
        let xray = sample_storage_xray(&sandbox.root);
        let remove_p95_ms = rem_hist.percentiles().2;

        eprintln!(
            "[SCEN M][P1 W{wave:02}/14] rss={rss_mib:.1}MiB fds={fds} cpu/sess={cpu_ms_per_sess:.1}ms rem_p95={remove_p95_ms}ms | db={:.2}MiB rwal={:.2}MiB rshm={:.2}MiB dir={:.2}MiB free={}pgs | pending_rel={} contents={} non_rcpt={} orphan={} ops={} effects={} facts={} cells={} cat_sess={} usage={}",
            xray.total_db_bytes as f64 / (1024.0 * 1024.0),
            xray.runtime_wal_bytes as f64 / (1024.0 * 1024.0),
            xray.runtime_shm_bytes as f64 / (1024.0 * 1024.0),
            xray.total_dir_bytes as f64 / (1024.0 * 1024.0),
            xray.freelist_count,
            xray_count(&xray, "pending_content_releases"),
            xray_count(&xray, "contents"),
            xray_count(&xray, "non_receipt_contents"),
            xray_count(&xray, "orphan_contents"),
            xray_count(&xray, "application_operations"),
            xray_count(&xray, "host_effects"),
            xray_count(&xray, "agent_facts"),
            xray_count(&xray, "agent_cells"),
            xray_count(&xray, "agent_catalog_sessions"),
            xray_count(&xray, "agent_usage_calls"),
        );
        if wave == 4 || wave == 9 || wave == 14 {
            eprintln!(
                "[SCEN M][P1 DBSTAT W{wave:02}] {}",
                format_top_dbstat(&xray, 10)
            );
        }

        churn_metrics.push(ChurnWaveMetric {
            rss_mib,
            fds,
            cpu_ms_per_sess,
            remove_p95_ms,
            xray,
        });
    }

    // Evaluate Phase 1 Zero-Survivor steady-state slopes (W4 vs W14).
    let w4 = &churn_metrics[3];
    let w14 = &churn_metrics[13];
    let db_w4 = (w4.xray.total_db_bytes + w4.xray.runtime_wal_bytes) as f64 / (1024.0 * 1024.0);
    let db_w14 = (w14.xray.total_db_bytes + w14.xray.runtime_wal_bytes) as f64 / (1024.0 * 1024.0);
    let contents_w4 = xray_count(&w4.xray, "contents").max(1);
    let contents_w14 = xray_count(&w14.xray, "contents");
    for (label, sample) in [("W4", &w4.xray), ("W14", &w14.xray)] {
        if let Some(err) = &sample.counts_error {
            violations.push(format!("P1 {label} storage xray sampling failed: {err}"));
        }
    }
    let non_receipt_w4 = require_xray_count(&w4.xray, "non_receipt_contents")
        .unwrap_or(0)
        .max(1);
    let non_receipt_w14 = require_xray_count(&w14.xray, "non_receipt_contents").unwrap_or(u64::MAX);
    let receipt_w14 = xray_count(&w14.xray, "receipt_contents");
    let orphan_w14 = require_xray_count(&w14.xray, "orphan_contents").unwrap_or(u64::MAX);
    let ops_w4 = xray_count(&w4.xray, "application_operations").max(1);
    let ops_w14 = xray_count(&w14.xray, "application_operations");
    let eff_w4 = require_xray_count(&w4.xray, "host_effects")
        .unwrap_or(0)
        .max(1);
    let eff_w14 = require_xray_count(&w14.xray, "host_effects").unwrap_or(u64::MAX);
    let facts_w14 = require_xray_count(&w14.xray, "agent_facts").unwrap_or(u64::MAX);
    let cells_w14 = require_xray_count(&w14.xray, "agent_cells").unwrap_or(u64::MAX);
    let cat_sess_w14 = require_xray_count(&w14.xray, "agent_catalog_sessions").unwrap_or(u64::MAX);
    let cat_ctrl_w14 = require_xray_count(&w14.xray, "agent_catalog_controls").unwrap_or(u64::MAX);

    eprintln!(
        "[SCEN M][P1 SUMMARY] total_deleted={total_churn_deleted} | W4->W14: rss {:.1}->{:.1}MiB | fds {}->{} | db+rwal {:.2}->{:.2}MiB ({:.2}x) | non_receipt_contents {}->{} ({:.2}x) orphan={} | receipt_contents={} (total_contents {}->{}, ops {}->{}) | effects {}->{} ({:.2}x) | domain_residual(facts={} cells={} cat_sess={} cat_ctrl={}) | cpu/sess {:.1}->{:.1}ms | rem_p95 {}->{}ms",
        w4.rss_mib,
        w14.rss_mib,
        w4.fds,
        w14.fds,
        db_w4,
        db_w14,
        db_w14 / db_w4.max(0.01),
        non_receipt_w4,
        non_receipt_w14,
        non_receipt_w14 as f64 / non_receipt_w4 as f64,
        orphan_w14,
        receipt_w14,
        contents_w4,
        contents_w14,
        ops_w4,
        ops_w14,
        eff_w4,
        eff_w14,
        eff_w14 as f64 / eff_w4 as f64,
        facts_w14,
        cells_w14,
        cat_sess_w14,
        cat_ctrl_w14,
        w4.cpu_ms_per_sess,
        w14.cpu_ms_per_sess,
        w4.remove_p95_ms,
        w14.remove_p95_ms,
    );

    if w14.rss_mib > w4.rss_mib * 1.35 + 64.0 {
        violations.push(format!(
            "P1 RSS drift on 0-survivor churn: W4={:.1}MiB -> W14={:.1}MiB",
            w4.rss_mib, w14.rss_mib
        ));
    }
    if w14.fds > w4.fds + 20 {
        violations.push(format!(
            "P1 FD leak on 0-survivor churn: W4={} -> W14={}",
            w4.fds, w14.fds
        ));
    }
    if db_w14 > db_w4 * 1.40 + 8.0 {
        violations.push(format!(
            "P1 Storage leak on 0-survivor churn (DB+WAL): W4={db_w4:.2}MiB -> W14={db_w14:.2}MiB ({:.2}x)",
            db_w14 / db_w4.max(0.01)
        ));
    }
    for (table, residual) in [
        ("agent_facts", facts_w14),
        (
            "agent_session_history",
            require_xray_count(&w14.xray, "agent_session_history").unwrap_or(u64::MAX),
        ),
        (
            "agent_history_content_refs",
            require_xray_count(&w14.xray, "agent_history_content_refs").unwrap_or(u64::MAX),
        ),
        (
            "agent_request_specs",
            require_xray_count(&w14.xray, "agent_request_specs").unwrap_or(u64::MAX),
        ),
        ("agent_cells", cells_w14),
        ("agent_catalog_sessions", cat_sess_w14),
        ("agent_catalog_controls", cat_ctrl_w14),
        ("orphan_contents", orphan_w14),
    ] {
        if residual != 0 {
            violations.push(format!(
                "P1 Residual rows in {table} after 100% session deletion: W14={residual}"
            ));
        }
    }
    if non_receipt_w14 as f64 > non_receipt_w4 as f64 * 1.40 + 50.0 {
        violations.push(format!(
            "P1 Unreclaimed non-receipt contents rows on 0-survivor churn: W4={non_receipt_w4} -> W14={non_receipt_w14} ({:.2}x)",
            non_receipt_w14 as f64 / non_receipt_w4 as f64
        ));
    }
    if eff_w14 as f64 > eff_w4 as f64 * 1.50 + 100.0 {
        violations.push(format!(
            "P1 Unbounded host_effects growth on 0-survivor churn: W4={eff_w4} -> W14={eff_w14} ({:.2}x)",
            eff_w14 as f64 / eff_w4 as f64
        ));
    }
    if w14.cpu_ms_per_sess > w4.cpu_ms_per_sess * 1.60 + 15.0 {
        violations.push(format!(
            "P1 CPU/session degradation on 0-survivor churn: W4={:.1}ms -> W14={:.1}ms",
            w4.cpu_ms_per_sess, w14.cpu_ms_per_sess
        ));
    }

    // Clean up churn scratch files so workspace stays tidy.
    if let Ok(rd) = std::fs::read_dir(&sandbox.workspace) {
        for e in rd.flatten() {
            if let Some(n) = e.file_name().to_str()
                && n.starts_with("churn_")
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }

    // =========================================================================
    // PHASE 2: SCALE-OUT DORMANT FLEET (250 -> 1,000 -> 3,000 = 12x JUMP)
    // =========================================================================
    eprintln!(
        "
[SCEN M] === PHASE 2: SCALE-OUT DORMANT FLEET (250 -> 1,000 -> 3,000 historical sessions) ==="
    );

    // Create 16 fixed hot probe sessions that stay live across all 3 tiers.
    let mut hot_sids = Vec::with_capacity(16);
    for i in 0..16usize {
        let sid = create_session_titled(
            &client,
            &sandbox.workspace,
            backend_fast(&conns),
            &format!("HOT_BENCH_{i:02}"),
        )
        .await
        .expect("create hot bench session");
        hot_sids.push(sid);
    }

    // Background slow/churning watch subscriber swarm (12 concurrent reconnect loops).
    let watch_cancel = CancellationToken::new();
    let watch_pause = Arc::new(AtomicBool::new(false));
    let watch_frames = Arc::new(AtomicU64::new(0));
    let watch_reconnects = Arc::new(AtomicU64::new(0));
    let mut watch_tasks = JoinSet::new();
    for w_idx in 0..12usize {
        let addr = address.clone();
        let cancel = watch_cancel.clone();
        let pause = watch_pause.clone();
        let frames = watch_frames.clone();
        let reconns = watch_reconnects.clone();
        let targets = hot_sids.clone();
        watch_tasks.spawn(async move {
            let mut cursor = w_idx;
            while !cancel.is_cancelled() {
                if pause.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                let sid = &targets[cursor % targets.len()];
                cursor += 1;
                let Ok(c) = Client::connect(&addr, None).await else {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    continue;
                };
                reconns.fetch_add(1, Ordering::Relaxed);
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
                // Deliberately act as a slow/churning subscriber: read up to 4 frames with 120ms delay, then drop.
                let deadline = Instant::now() + Duration::from_millis(600);
                let mut seen = 0usize;
                while Instant::now() < deadline
                    && seen < 4
                    && !cancel.is_cancelled()
                    && !pause.load(Ordering::SeqCst)
                {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(120)) => {
                            // Slow consumer tick
                        }
                        r = call.pull() => match r {
                            Ok(Reply::Item { .. } | Reply::Progress { .. }) => {
                                frames.fetch_add(1, Ordering::Relaxed);
                                seen += 1;
                            }
                            _ => break,
                        }
                    }
                }
            }
        });
    }

    let tiers = [250usize, 1_000usize, 3_000usize];
    let mut created_fleet_total = 0usize;
    let mut cold_sample_sids: Vec<String> = Vec::new();
    let mut tier_results: Vec<HotProbeResult> = Vec::with_capacity(3);

    for (tier_idx, &target_total) in tiers.iter().enumerate() {
        let to_add = target_total.saturating_sub(created_fleet_total);
        let tier_t0 = Instant::now();
        let sem = Arc::new(tokio::sync::Semaphore::new(48));
        let mut set = JoinSet::new();
        let search_tok = format!("FLEET_TOKEN_T{}", tier_idx + 1);

        for k in 0..to_add {
            let global_idx = created_fleet_total + k;
            let permit = sem.clone().acquire_owned().await.unwrap();
            let c = client.clone();
            let ws = sandbox.workspace.clone();
            let be = backend_fast(&conns);
            let tok = search_tok.clone();
            set.spawn(async move {
                let _permit = permit;
                // 10% Rooms, 90% Agent sessions (45% idle, 30% archived, 15% removed tombstones).
                let bucket = global_idx % 20;
                if bucket == 0 || bucket == 1 {
                    let room_id = create_room_titled(
                        &c,
                        &ws,
                        &format!("FLEET_T{}_ROOM_{global_idx:04}", tier_idx + 1),
                    )
                    .await
                    .expect("create fleet room");
                    for p in 0..2usize {
                        let _ = soak_call(
                            &c,
                            "agent",
                            "send",
                            json!({
                                "sessionId": room_id,
                                "message": format!("Room broadcast {tok} #{global_idx}-{p}"),
                                "mentions": []
                            }),
                            Duration::from_secs(20),
                        )
                        .await;
                    }
                    return Some(room_id);
                }

                let sid = create_session_titled(
                    &c,
                    &ws,
                    be,
                    &format!("FLEET_T{}_SESS_{global_idx:04}", tier_idx + 1),
                )
                .await
                .expect("create fleet session");

                // Every 4th session exercises a real Read tool (populating host_effects + ops + usage);
                // others run a fast 1-turn exchange populating facts + history + recall + usage.
                let prompt = if global_idx.is_multiple_of(4) {
                    format!("SOAK_FAST_TOOL_{tok}_{global_idx}")
                } else {
                    format!("SOAK_FLEET_TEXT {tok} record_{global_idx} archive_scale_test")
                };
                soak_call(
                    &c,
                    "agent",
                    "send",
                    json!({ "sessionId": sid, "message": prompt, "delivery": "queue" }),
                    Duration::from_secs(30),
                )
                .await
                .expect("fleet send");
                let st = wait_fresh_run_settled(&c, &sid, None, Duration::from_secs(45))
                    .await
                    .expect("fleet settle");
                assert!(st == "completed" || st == "idle", "fleet state {st}");

                if (11..=16).contains(&bucket) {
                    // 30% archived
                    archive_session(&c, &sid)
                        .await
                        .expect("archive fleet session");
                    None
                } else if bucket >= 17 {
                    // 15% removed tombstones
                    let _ = remove_session_timed(&c, &sid)
                        .await
                        .expect("remove fleet tombstone");
                    None
                } else {
                    // 45% live dormant idle
                    Some(sid)
                }
            });
        }
        while let Some(r) = set.join_next().await {
            if let Some(sid) = r.unwrap()
                && cold_sample_sids.len() < 40
            {
                cold_sample_sids.push(sid);
            }
        }
        created_fleet_total = target_total;

        // Seed 60 personal memories at each tier.
        {
            let mut mset = JoinSet::new();
            for m in 0..60usize {
                let c = client.clone();
                let tok = search_tok.clone();
                mset.spawn(async move {
                    let _ = soak_call(
                        &c,
                        "agent",
                        "changeMemory",
                        json!({
                            "scope": { "kind": "personal" },
                            "edit": {
                                "kind": "create",
                                "body": format!("Long-lived memory {tok} entry #{m} for forever-running soak")
                            }
                        }),
                        Duration::from_secs(20),
                    )
                    .await;
                });
            }
            while mset.join_next().await.is_some() {}
        }

        eprintln!(
            "[SCEN M][P2 TIER {}] seeded +{to_add} (total fleet={target_total}) in {:.1}s (watch_frames={} reconns={})",
            tier_idx + 1,
            tier_t0.elapsed().as_secs_f64(),
            watch_frames.load(Ordering::Relaxed),
            watch_reconnects.load(Ordering::Relaxed),
        );

        let probe_ctx = HotProbeContext {
            client: &client,
            workspace: &sandbox.workspace,
            sandbox_root: &sandbox.root,
            host_pid,
            conns: &conns,
            hot_sids: &hot_sids,
            watch_pause: &watch_pause,
        };
        let probe = run_fixed_hot_probe(
            &probe_ctx,
            &format!("T{}_{}", tier_idx + 1, target_total),
            &cold_sample_sids,
            &search_tok,
        )
        .await;
        tier_results.push(probe);
    }

    watch_cancel.cancel();
    while watch_tasks.join_next().await.is_some() {}

    // Evaluate Phase 2 Scale-Out O(1) ratios: Tier 1 (250) vs Tier 3 (3,000 = 12x).
    let t1 = &tier_results[0];
    let t3 = &tier_results[2];
    eprintln!(
        "[SCEN M][P2 SCALE 12x (250->3000)] cpu/turn {:.1}->{:.1}ms ({:.2}x) | turn_p95 {}->{}ms | list_roots {}->{}ms | list_title {}->{}ms | sessList {}->{}ms | obs {}->{}ms | search {}->{}ms | usage {}->{}ms | usageSum {}->{}ms | remove {}->{}ms | idle_cpu {:.2}%->{:.2}% | rss {:.1}->{:.1}MiB (+{:.1}MiB)",
        t1.hot_cpu_ms_per_turn,
        t3.hot_cpu_ms_per_turn,
        t3.hot_cpu_ms_per_turn / t1.hot_cpu_ms_per_turn.max(0.1),
        t1.hot_turn_p95,
        t3.hot_turn_p95,
        t1.list_roots_p95,
        t3.list_roots_p95,
        t1.list_title_p95,
        t3.list_title_p95,
        t1.session_list_p95,
        t3.session_list_p95,
        t1.observe_p95,
        t3.observe_p95,
        t1.search_p95,
        t3.search_p95,
        t1.usage_page_p95,
        t3.usage_page_p95,
        t1.usage_summary_p95,
        t3.usage_summary_p95,
        t1.remove_p95,
        t3.remove_p95,
        t1.idle_cpu_pct,
        t3.idle_cpu_pct,
        t1.rss_mib,
        t3.rss_mib,
        t3.rss_mib - t1.rss_mib,
    );

    let check_scale = |violations: &mut Vec<String>, name: &str, v1: u64, v3: u64| {
        let floor = v1.saturating_mul(25) / 10 + 30; // max 2.5x + 30ms jitter floor for 12x fleet jump
        if v3 > floor {
            violations.push(format!(
                "P2 12x fleet scaling regression in {name}: T1(250)={v1}ms -> T3(3000)={v3}ms ({:.2}x)",
                v3 as f64 / v1.max(1) as f64
            ));
        }
    };
    check_scale(
        &mut violations,
        "hot_turn_p95",
        t1.hot_turn_p95,
        t3.hot_turn_p95,
    );
    check_scale(
        &mut violations,
        "list_roots_p95",
        t1.list_roots_p95,
        t3.list_roots_p95,
    );
    check_scale(
        &mut violations,
        "list_title_p95",
        t1.list_title_p95,
        t3.list_title_p95,
    );
    check_scale(
        &mut violations,
        "session_list_p95",
        t1.session_list_p95,
        t3.session_list_p95,
    );
    check_scale(
        &mut violations,
        "observe_p95",
        t1.observe_p95,
        t3.observe_p95,
    );
    check_scale(&mut violations, "search_p95", t1.search_p95, t3.search_p95);
    check_scale(
        &mut violations,
        "usage_page_p95",
        t1.usage_page_p95,
        t3.usage_page_p95,
    );
    check_scale(
        &mut violations,
        "usage_summary_p95",
        t1.usage_summary_p95,
        t3.usage_summary_p95,
    );
    check_scale(&mut violations, "remove_p95", t1.remove_p95, t3.remove_p95);

    if t3.hot_cpu_ms_per_turn > t1.hot_cpu_ms_per_turn * 2.5 + 15.0 {
        violations.push(format!(
            "P2 12x fleet CPU/turn regression: T1={:.1}ms -> T3={:.1}ms",
            t1.hot_cpu_ms_per_turn, t3.hot_cpu_ms_per_turn
        ));
    }
    if t3.idle_cpu_pct > 3.5 {
        violations.push(format!(
            "P2 Idle CPU too high under 3,000 sessions: {:.2}%",
            t3.idle_cpu_pct
        ));
    }
    if t3.rss_mib - t1.rss_mib > 250.0 {
        violations.push(format!(
            "P2 RSS grew too steeply across +2,750 dormant sessions: {:.1} -> {:.1}MiB (+{:.1}MiB)",
            t1.rss_mib,
            t3.rss_mib,
            t3.rss_mib - t1.rss_mib
        ));
    }

    // =========================================================================
    // PHASE 3: IMMORTAL SESSION SCALE-DEEP (300 turns + ~60 compactions + 200-post Room)
    // =========================================================================
    eprintln!(
        "
[SCEN M] === PHASE 3: IMMORTAL SESSION (300 turns + rolling compactions + 200-post Room) ==="
    );

    let immortal_sid = create_session_titled(
        &client,
        &sandbox.workspace,
        backend_tight(&conns),
        "IMMORTAL_DAEMON_SESSION",
    )
    .await
    .expect("create immortal session");
    let immortal_room = create_room_titled(&client, &sandbox.workspace, "IMMORTAL_OPS_ROOM")
        .await
        .expect("create immortal room");
    let room_member = create_session_titled(
        &client,
        &sandbox.workspace,
        backend_fast(&conns),
        "IMMORTAL_ROOM_MEMBER",
    )
    .await
    .expect("create room member");

    #[derive(Clone)]
    struct ImmortalBlock {
        turn_p50: u64,
        turn_p95: u64,
        cpu_ms_per_turn: f64,
        obs_ms: u64,
        hist_ms: u64,
        delta_db_kib: i64,
        durable_compactions: u64,
        mock_summary_reqs: usize,
        rss_mib: f64,
    }
    let mut imm_blocks: Vec<ImmortalBlock> = Vec::with_capacity(6);
    let mut prev_xray = sample_storage_xray(&sandbox.root);

    for block in 0..6usize {
        let hist = LatencyHist::default();
        let cpu0 = sample_cpu_ms(host_pid).unwrap_or(0);

        for local_t in 0..50usize {
            let turn = block * 50 + local_t + 1;
            let prev_run = soak_call(
                &client,
                "agent",
                "observe",
                json!({ "sessionId": immortal_sid }),
                Duration::from_secs(10),
            )
            .await
            .ok()
            .and_then(|o| {
                o["latestRunId"]
                    .as_str()
                    .or_else(|| o["run"]["runId"].as_str())
                    .map(str::to_owned)
            });
            let t0 = Instant::now();
            soak_call(
                &client,
                "agent",
                "send",
                json!({
                    "sessionId": immortal_sid,
                    "message": format!("SOAK_IMMORTAL_TURN_{turn:03} execute persistent workflow step"),
                    "delivery": "queue"
                }),
                Duration::from_secs(30),
            )
            .await
            .unwrap_or_else(|e| panic!("immortal turn {turn} send failed: {e}"));
            let st = wait_fresh_run_settled(
                &client,
                &immortal_sid,
                prev_run.as_deref(),
                Duration::from_secs(45),
            )
            .await
            .unwrap_or_else(|e| panic!("immortal turn {turn} settle failed: {e}"));
            assert!(
                st == "completed" || st == "idle",
                "immortal turn {turn} unexpected state {st}"
            );
            hist.record(t0.elapsed());

            // Interleave Immortal Room posts (total ~200 posts across 300 turns).
            if local_t % 3 != 2 {
                let post_num = block * 34 + local_t;
                let mentions = if post_num % 15 == 0 {
                    json!([room_member])
                } else {
                    json!([])
                };
                let _ = soak_call(
                    &client,
                    "agent",
                    "send",
                    json!({
                        "sessionId": immortal_room,
                        "message": format!("IMMORTAL_ROOM_POST #{post_num} status update"),
                        "mentions": mentions
                    }),
                    Duration::from_secs(20),
                )
                .await;
            }
        }
        let _ = wait_settled(&client, &room_member, Duration::from_secs(30)).await;

        let cpu1 = sample_cpu_ms(host_pid).unwrap_or(cpu0);
        let cpu_ms_per_turn = cpu1.saturating_sub(cpu0) as f64 / 50.0;
        let (_, turn_p50, turn_p95, _) = hist.percentiles();

        let t_obs = Instant::now();
        soak_call(
            &client,
            "agent",
            "observe",
            json!({ "sessionId": immortal_sid }),
            Duration::from_secs(20),
        )
        .await
        .expect("immortal observe");
        let obs_ms = t_obs.elapsed().as_millis() as u64;

        let t_hist = Instant::now();
        soak_call(
            &client,
            "agent",
            "history",
            json!({ "sessionId": immortal_sid, "through": null, "position": { "kind": "tail" } }),
            Duration::from_secs(20),
        )
        .await
        .expect("immortal history tail");
        let hist_ms = t_hist.elapsed().as_millis() as u64;

        let cur_xray = sample_storage_xray(&sandbox.root);
        let delta_db_kib =
            (cur_xray.total_db_bytes as i64 - prev_xray.total_db_bytes as i64) / 1024;
        let delta_facts = xray_count(&cur_xray, "agent_facts") as i64
            - xray_count(&prev_xray, "agent_facts") as i64;
        let delta_contents =
            xray_count(&cur_xray, "contents") as i64 - xray_count(&prev_xray, "contents") as i64;
        let rss_mib = sample_rss_kib(host_pid).unwrap_or(0) as f64 / 1024.0;
        let mock_summary_reqs = compaction_reqs.load(Ordering::Relaxed);
        let escaped_immortal = immortal_sid.replace("'", "''");
        let durable_compactions = match cur_xray.main_db_path.as_deref() {
            Some(db) => match sqlite_query_u64_checked(
                db,
                &format!(
                    "SELECT count(*) FROM agent_session_history h JOIN agent_namespaces ns ON ns.id = h.namespace_id WHERE ns.session='{escaped_immortal}' AND h.kind='context_compacted';"
                ),
            ) {
                Ok(n) => n,
                Err(err) => {
                    violations.push(format!("P3 durable compaction count query failed: {err}"));
                    0
                }
            },
            None => {
                violations.push(
                    "P3 runtime-rust.sqlite missing when counting durable compactions".into(),
                );
                0
            }
        };

        eprintln!(
            "[SCEN M][P3 T{:03}] turn(p50={turn_p50}ms p95={turn_p95}ms) cpu/turn={cpu_ms_per_turn:.1}ms obs={obs_ms}ms hist_tail={hist_ms}ms | durable_compactions={durable_compactions} (mock_summary_reqs={mock_summary_reqs}) | +db={delta_db_kib}KiB +facts={delta_facts} +contents={delta_contents} | rss={rss_mib:.1}MiB",
            (block + 1) * 50
        );

        imm_blocks.push(ImmortalBlock {
            turn_p50,
            turn_p95,
            cpu_ms_per_turn,
            obs_ms,
            hist_ms,
            delta_db_kib,
            durable_compactions,
            mock_summary_reqs,
            rss_mib,
        });
        prev_xray = cur_xray;
    }

    let b1 = &imm_blocks[0];
    let b6 = &imm_blocks[5];
    eprintln!(
        "[SCEN M][P3 SUMMARY] T050->T300: turn_p50 {}->{}ms | turn_p95 {}->{}ms | cpu/turn {:.1}->{:.1}ms | obs {}->{}ms | hist_tail {}->{}ms | durable_compactions={} (mock_summary_reqs={}) | +db/50t {}->{}KiB | rss {:.1}->{:.1}MiB",
        b1.turn_p50,
        b6.turn_p50,
        b1.turn_p95,
        b6.turn_p95,
        b1.cpu_ms_per_turn,
        b6.cpu_ms_per_turn,
        b1.obs_ms,
        b6.obs_ms,
        b1.hist_ms,
        b6.hist_ms,
        b6.durable_compactions,
        b6.mock_summary_reqs,
        b1.delta_db_kib,
        b6.delta_db_kib,
        b1.rss_mib,
        b6.rss_mib,
    );

    if b6.durable_compactions < 20 {
        violations.push(format!(
            "P3 Immortal session expected >= 20 committed context_compacted facts across 300 turns, got {} (mock_summary_reqs={})",
            b6.durable_compactions, b6.mock_summary_reqs
        ));
    }
    if b6.turn_p95 > b1.turn_p95 * 2 + 40 {
        violations.push(format!(
            "P3 Immortal turn_p95 degraded over 300 turns: B1={}ms -> B6={}ms",
            b1.turn_p95, b6.turn_p95
        ));
    }
    if b6.cpu_ms_per_turn > b1.cpu_ms_per_turn * 2.0 + 15.0 {
        violations.push(format!(
            "P3 Immortal cpu/turn degraded over 300 turns: B1={:.1}ms -> B6={:.1}ms",
            b1.cpu_ms_per_turn, b6.cpu_ms_per_turn
        ));
    }
    if b6.obs_ms > b1.obs_ms * 2 + 25 {
        violations.push(format!(
            "P3 Immortal observe latency degraded: B1={}ms -> B6={}ms",
            b1.obs_ms, b6.obs_ms
        ));
    }
    if b6.hist_ms > b1.hist_ms * 2 + 25 {
        violations.push(format!(
            "P3 Immortal history(tail) latency degraded: B1={}ms -> B6={}ms",
            b1.hist_ms, b6.hist_ms
        ));
    }

    // =========================================================================
    // PHASE 4: COLD REOPEN & SIGKILL RECOVERY UNDER FULL ~3,400+ SESSION FLEET
    // =========================================================================
    eprintln!(
        "
[SCEN M] === PHASE 4: COLD REOPEN & SIGKILL RECOVERY UNDER FULL FLEET ==="
    );

    let mut owned_client = Arc::try_unwrap(client)
        .ok()
        .expect("single client ref before clean quit");
    host.quit(&mut owned_client)
        .await
        .expect("clean quit before cold reopen");

    let clean_t0 = Instant::now();
    host = Host::spawn(&sandbox).expect("spawn host after clean quit");
    let (re_client, _re_addr) = host.ready().await.expect("host ready after clean quit");
    let clean_reopen_ms = clean_t0.elapsed().as_millis() as u64;
    let re_client = Arc::new(re_client);
    let re_pid = host.pid().expect("reopened host pid");
    let re_rss_mib = sample_rss_kib(re_pid).unwrap_or(0) as f64 / 1024.0;
    let re_fds = sample_open_fds(re_pid).unwrap_or(0);

    // Post-reopen liveness & latency check on the 300-turn immortal session + catalog.
    let t_list = Instant::now();
    soak_call(
        &re_client,
        "agent",
        "list",
        json!({
            "kind": null,
            "filter": "all",
            "includeArchived": false,
            "rootsOnly": true,
            "position": { "kind": "start" }
        }),
        Duration::from_secs(20),
    )
    .await
    .expect("post-reopen list");
    let post_reopen_list_ms = t_list.elapsed().as_millis() as u64;

    let t_imm = Instant::now();
    soak_call(
        &re_client,
        "agent",
        "send",
        json!({
            "sessionId": immortal_sid,
            "message": "SOAK_IMMORTAL_TURN_301 post-reopen continuation",
            "delivery": "queue"
        }),
        Duration::from_secs(30),
    )
    .await
    .expect("post-reopen immortal send");
    let st = wait_settled(&re_client, &immortal_sid, Duration::from_secs(45))
        .await
        .expect("post-reopen immortal settle");
    assert!(
        st == "completed" || st == "idle",
        "post-reopen immortal {st}"
    );
    let post_reopen_imm_ms = t_imm.elapsed().as_millis() as u64;

    eprintln!(
        "[SCEN M][P4 CLEAN REOPEN] ready={clean_reopen_ms}ms rss={re_rss_mib:.1}MiB fds={re_fds} | first_list={post_reopen_list_ms}ms immortal_turn_301={post_reopen_imm_ms}ms"
    );

    // Crash-reopen mid-flight under the full ~3,400+ session fleet.
    // Anchor on one deterministic in-flight sentinel run on immortal_sid (held open
    // by the mock server until SIGKILL) while firing 12 concurrent hot-session sends
    // for realistic crash load.
    let pre_crash_run_id = soak_call(
        &re_client,
        "agent",
        "observe",
        json!({ "sessionId": immortal_sid }),
        Duration::from_secs(15),
    )
    .await
    .expect("pre-crash immortal observe")
    .get("latestRunId")
    .and_then(|v| v.as_str())
    .map(str::to_owned);

    let sentinel_send = soak_call(
        &re_client,
        "agent",
        "send",
        json!({
            "sessionId": immortal_sid,
            "message": "SOAK_P4_CRASH_SENTINEL hold in-flight until sigkill",
            "delivery": "queue"
        }),
        Duration::from_secs(20),
    )
    .await
    .expect("P4 crash sentinel send must be accepted");
    assert_eq!(
        sentinel_send.get("kind").and_then(|v| v.as_str()),
        Some("queued"),
        "P4 crash sentinel was not queued: {sentinel_send}"
    );

    let mut accepted_hot_crash_sends = 0usize;
    {
        let mut set = JoinSet::new();
        for sid in hot_sids.iter().take(12) {
            let c = re_client.clone();
            let sid = sid.clone();
            set.spawn(async move {
                soak_call(
                    &c,
                    "agent",
                    "send",
                    json!({
                        "sessionId": sid,
                        "message": "SOAK_HOT_PROBE_CRASH_WAVE execute before sigkill",
                        "delivery": "queue"
                    }),
                    Duration::from_secs(15),
                )
                .await
                .is_ok_and(|res| res.get("kind").and_then(|v| v.as_str()) == Some("queued"))
            });
        }
        while let Some(joined) = set.join_next().await {
            if joined.expect("crash-wave send task panicked") {
                accepted_hot_crash_sends += 1;
            }
        }
    }
    assert!(
        accepted_hot_crash_sends > 0,
        "P4 crash wave queued 0 concurrent hot-session sends"
    );

    // Wait until the sentinel run is durably admitted AND its model HTTP request is
    // genuinely in-flight at the mock server before sending SIGKILL.
    let sentinel_deadline = Instant::now() + Duration::from_secs(20);
    let sentinel_run_id = loop {
        assert!(
            Instant::now() <= sentinel_deadline,
            "P4 crash sentinel did not reach active in-flight model state before SIGKILL (mock_hits={})",
            crash_sentinel_hits.load(Ordering::Acquire)
        );
        let mock_inflight = crash_sentinel_hits.load(Ordering::Acquire) >= 1;
        if mock_inflight
            && let Ok(obs) = soak_call(
                &re_client,
                "agent",
                "observe",
                json!({ "sessionId": immortal_sid }),
                Duration::from_secs(10),
            )
            .await
        {
            let active = obs["session"]["activity"].as_str() == Some("working");
            let live_run = obs["run"]["runId"].as_str().map(str::to_owned);
            if active
                && let Some(run_id) = live_run
                && Some(run_id.as_str()) != pre_crash_run_id.as_deref()
            {
                break run_id;
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    };

    crash_sentinel_hold.store(false, Ordering::Release);
    host.sigkill().await.expect("SIGKILL host under full fleet");
    drop(re_client);
    tokio::time::sleep(Duration::from_millis(120)).await;

    let crash_t0 = Instant::now();
    host = Host::spawn(&sandbox).expect("spawn host after SIGKILL");
    let (crash_client, _) = host.ready().await.expect("host ready after SIGKILL");
    let crash_reopen_ms = crash_t0.elapsed().as_millis() as u64;
    let crash_client = Arc::new(crash_client);

    // Verify the exact crashed sentinel run recovered to a settled/blocked state
    // (never returning a stale pre-crash run).
    let recover_deadline = Instant::now() + Duration::from_secs(60);
    let sentinel_recovered_state = loop {
        assert!(
            Instant::now() <= recover_deadline,
            "P4 crashed sentinel run {sentinel_run_id} did not settle after SIGKILL reopen"
        );
        if let Ok(obs) = soak_call(
            &crash_client,
            "agent",
            "observe",
            json!({ "sessionId": immortal_sid }),
            Duration::from_secs(15),
        )
        .await
        {
            let activity = obs["session"]["activity"].as_str().unwrap_or("");
            let run = &obs["run"];
            let observed_run = run["runId"]
                .as_str()
                .or_else(|| obs["latestRunId"].as_str());
            let kind = if run.is_null() {
                "idle"
            } else {
                run["state"]
                    .as_str()
                    .or_else(|| run["state"]["kind"].as_str())
                    .unwrap_or("idle")
            };
            let settled = activity == "idle" || (activity == "waiting" && kind == "blocked");
            if settled && observed_run == Some(sentinel_run_id.as_str()) {
                assert!(
                    matches!(
                        kind,
                        "completed" | "idle" | "failed" | "cancelled" | "blocked"
                    ),
                    "unexpected post-crash sentinel state {kind}"
                );
                break kind.to_string();
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    for sid in hot_sids.iter().take(12) {
        let st = wait_settled(&crash_client, sid, Duration::from_secs(60))
            .await
            .unwrap_or_else(|e| panic!("post-SIGKILL settle failed for {sid}: {e}"));
        assert!(
            matches!(
                st.as_str(),
                "completed" | "idle" | "failed" | "cancelled" | "blocked"
            ),
            "unexpected post-crash state {st}"
        );
    }

    eprintln!(
        "[SCEN M][P4 CRASH SENTINEL] run={sentinel_run_id} state={sentinel_recovered_state} pre_kill_mock_hits={} hot_accepted={accepted_hot_crash_sends}/12",
        crash_sentinel_hits.load(Ordering::Acquire)
    );

    let final_xray = sample_storage_xray(&sandbox.root);
    let mut owned_crash_client = Arc::try_unwrap(crash_client)
        .ok()
        .expect("single crash_client ref before final quit");
    host.quit(&mut owned_crash_client)
        .await
        .expect("final clean quit");
    mock.shutdown().await;

    let integrity = verify_sqlite_integrity(&sandbox.root);
    let orphans = find_orphan_processes(&marker, &sandbox.root);

    eprintln!(
        "[SCEN M][P4 CRASH REOPEN] ready={crash_reopen_ms}ms | integrity={integrity:?} | orphans={}",
        orphans.len()
    );
    eprintln!(
        "[SCEN M][FINAL DBSTAT] db={:.1}MiB rwal={:.1}MiB rshm={:.2}MiB dir={:.1}MiB free={}pgs req_raw={:.2}MiB | {}",
        final_xray.total_db_bytes as f64 / (1024.0 * 1024.0),
        final_xray.runtime_wal_bytes as f64 / (1024.0 * 1024.0),
        final_xray.runtime_shm_bytes as f64 / (1024.0 * 1024.0),
        final_xray.total_dir_bytes as f64 / (1024.0 * 1024.0),
        final_xray.freelist_count,
        xray_count(&final_xray, "request_spec_raw_bytes") as f64 / (1024.0 * 1024.0),
        format_top_dbstat(&final_xray, 12),
    );
    eprintln!(
        "[SCEN M][FINAL COUNTS] contents={} (non_receipt={} orphan={}) ops={} effects={} ctrl={} ret={} rec={} shell={} facts={} hist={} refs={} cells={} cat_sess={} recall={} usage={} rooms={} mem={}",
        xray_count(&final_xray, "contents"),
        xray_count(&final_xray, "non_receipt_contents"),
        xray_count(&final_xray, "orphan_contents"),
        xray_count(&final_xray, "application_operations"),
        xray_count(&final_xray, "host_effects"),
        xray_count(&final_xray, "session_control"),
        xray_count(&final_xray, "session_retirements"),
        xray_count(&final_xray, "session_removal_receipts"),
        xray_count(&final_xray, "shell_runs"),
        xray_count(&final_xray, "agent_facts"),
        xray_count(&final_xray, "agent_session_history"),
        xray_count(&final_xray, "agent_history_content_refs"),
        xray_count(&final_xray, "agent_cells"),
        xray_count(&final_xray, "agent_catalog_sessions"),
        xray_count(&final_xray, "agent_recall_messages"),
        xray_count(&final_xray, "agent_usage_calls"),
        xray_count(&final_xray, "agent_room_messages"),
        xray_count(&final_xray, "agent_memories"),
    );

    if clean_reopen_ms > 5_000 {
        violations.push(format!(
            "P4 Clean cold reopen too slow under ~3,400 sessions: {clean_reopen_ms}ms"
        ));
    }
    if crash_reopen_ms > 10_000 {
        violations.push(format!(
            "P4 Crash reopen too slow under ~3,400 sessions: {crash_reopen_ms}ms"
        ));
    }
    if let Err(err) = integrity {
        violations.push(format!("P4 SQLite integrity failure: {err}"));
    }
    if !orphans.is_empty() {
        violations.push(format!(
            "P4 Orphan processes after quit: {} ({orphans:?})",
            orphans.len()
        ));
    }

    eprintln!(
        "
[SCEN M] FINISHED in {:.2}s | total_model_reqs={} | violations={}",
        started.elapsed().as_secs_f64(),
        total_reqs.load(Ordering::Relaxed),
        violations.len()
    );
    for (i, v) in violations.iter().enumerate() {
        eprintln!("  [VIOLATION #{}] {v}", i + 1);
    }

    assert!(
        violations.is_empty(),
        "Forever-running O(1) soak found {} scaling/leak violation(s):
  - {}",
        violations.len(),
        violations.join(
            "
  - "
        )
    );
}
