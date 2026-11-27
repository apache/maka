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

//! Full-scenario forward-upgrade compatibility harness ("Time Capsule").
//!
//! Three execution modes:
//! - Default (no env vars): produces a fresh capsule with the current `maka`
//!   binary and immediately verifies cold upgrade, exhaustive deserialization,
//!   and live continuation against a copy of that capsule.
//! - Produce (`MAKA_COMPAT_PRODUCE_CAPSULE=<dir>`): runs the complex scenario
//!   using `MAKA_COMPAT_BIN` (or `CARGO_BIN_EXE_maka`) and seals the resulting
//!   State Root, isolated `$HOME`, portable checkpoint, and `capsule-manifest.json`
//!   into `<dir>`.
//! - Verify (`MAKA_COMPAT_VERIFY_CAPSULE=<dir>`): copies the historical capsule
//!   in `<dir>` into a temp directory, boots `MAKA_COMPAT_BIN` (or
//!   `CARGO_BIN_EXE_maka`) against the copied old State Root, and verifies:
//!     1. Cold startup and atomic schema/data migrations.
//!     2. Exhaustive read/deserialization sweep across every persisted domain.
//!     3. Live continuation (updating settings, continuing the old conversation
//!        with Code Mode reading pre-upgrade `SessionData`, posting to the old
//!        Room, Recall indexing, and clean SQLite integrity checks).
//!
//! Keep this scenario in sync whenever persisted tables, JSON payloads, or
//! core stateful features are added or changed.

#![cfg(unix)]

#[path = "support/execution_compat.rs"]
mod execution_compat;
#[path = "support/host.rs"]
mod host;

use futures_util::FutureExt;
use host::Host;
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_config::{ConfigurationStore, access::PeerId};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::{host::Client, transport::Reply};
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, MockAiBuilder, MockAiServer, ModelEntry, NormalizedRequest,
    Protocol, TurnContext, TurnPlan, Usage,
};
use maka_plugin_core::{
    contract::ResourceType,
    operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    ops::Range,
    os::unix::fs::PermissionsExt,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::process::Command;

const PRODUCE_ENV: &str = "MAKA_COMPAT_PRODUCE_CAPSULE";
const VERIFY_ENV: &str = "MAKA_COMPAT_VERIFY_CAPSULE";
const BIN_ENV: &str = "MAKA_COMPAT_BIN";
const ATTACHMENT_BYTES: &[u8] = "compat capsule attachment — 兼容性附件\n".as_bytes();
const COMPACTION_PROMPT: &str = "Preserve upgrade compatibility markers across restarts.";
const PRESET_NAME: &str = "Compat Reviewer";
const COMPAT_PEER_GRANT: &str = "compat-host-publication";
const COMPAT_PAIRING_HASH: [u8; 32] = [31; 32];
const COMPAT_MCP_OWNER: &str = "compat-mcp-owner";
const COMPAT_MCP_WORKSPACE: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMPAT_MCP_REVISION: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMPAT_MCP_NEXT_REVISION: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const COMPAT_RELAY_TOKEN: &str = "compat-test-relay-token";

async fn save_compat_relay(
    settings: &ConfigurationStore,
    auth: maka_config::remote_access::RelayAuthUpdate,
) {
    use maka_config::remote_access::{RemoteAccessUpdate, RemoteRelayUpdate};
    let config = settings
        .update_remote_access(
            RemoteAccessUpdate {
                enabled: false,
                relay_only: true,
                relays: vec![RemoteRelayUpdate {
                    endpoint: maka_remote_pairing::RelayEndpoint {
                        url: "https://relay.example.test/".into(),
                        quic_port: Some(8443),
                        cert_sha256: None,
                    },
                    ca_der_path: None,
                    auth,
                }],
            },
            1,
        )
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&config)
            .unwrap()
            .contains(COMPAT_RELAY_TOKEN)
    );
}

async fn seed_pairing_invite(settings: &ConfigurationStore) {
    settings
        .create_host_peer_pairing_invite(
            maka_config::access::NewHostPeerPairingInvite {
                invite_id: "compat-pairing-invite".into(),
                secret_hash: COMPAT_PAIRING_HASH,
                host_grant: COMPAT_PEER_GRANT.into(),
                label: Some("Compat device".into()),
                expires_at_ms: i64::MAX as u64,
                created_at: "2026-09-12T00:00:00Z".into(),
            },
            0,
        )
        .await
        .unwrap();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleManifest {
    format_version: u32,
    base_dir: String,
    maka_version: String,
    git_sha: Option<String>,
    nonce: String,
    connection_id: String,
    connection_slug: String,
    primary_session_id: String,
    #[serde(default)]
    keyed_message_id: Option<String>,
    forked_session_id: String,
    /// Capsules sealed before side questions existed have none.
    #[serde(default)]
    side_session_id: Option<String>,
    room_id: String,
    room_pre_message: String,
    preset_id: String,
    memory_id: String,
    memory_body: String,
    checkpoint_revision: Value,
    portable_archive: String,
    session_data_key: String,
    #[serde(default)]
    operation_ref: Option<Value>,
    #[serde(default)]
    script_task_id: Option<String>,
    #[serde(default)]
    execution_authority: Option<execution_compat::Capsule>,
    migrations: BTreeMap<String, Vec<i64>>,
    #[serde(default)]
    host_peer_id: Option<String>,
    #[serde(default)]
    host_pairing_invite: bool,
    #[serde(default)]
    project_mcp_trusted: bool,
    #[serde(default)]
    remote_relay_configured: bool,
}

struct FixtureSecret;
impl ReadResource for FixtureSecret {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        b"compat-fixture-secret".len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        b"compat-fixture-secret"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid fixture secret range".into())
    }
}

struct FixtureAttachment;
impl ReadResource for FixtureAttachment {
    fn resource_type(&self) -> ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }
    fn bytes(&self) -> usize {
        ATTACHMENT_BYTES.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        ATTACHMENT_BYTES
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid fixture attachment range".into())
    }
}

fn maka_binary() -> PathBuf {
    if let Some(path) = std::env::var_os(BIN_ENV) {
        return PathBuf::from(path);
    }
    PathBuf::from(
        std::env::var_os("CARGO_BIN_EXE_maka")
            .expect("set MAKA_COMPAT_BIN or run under Cargo/nextest with CARGO_BIN_EXE_maka"),
    )
}

struct EnvDirs {
    root: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

impl EnvDirs {
    fn in_base(base: &Path) -> Self {
        let root = base.join("root");
        let home = base.join("home");
        let workspace = home.join("workspace");
        Self {
            root,
            home,
            workspace,
        }
    }

    fn prepare(&self) {
        fs::create_dir_all(&self.workspace).unwrap();
        if let Some(parent) = self.root.parent() {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
}

fn build_command(bin: &Path, dirs: &EnvDirs) -> Command {
    host::command_for(bin, &dirs.home, &dirs.workspace)
}

async fn call_with_ref(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
    resources: Attachments,
) -> (Value, Option<Value>) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut call = client
            .call(endpoint, method.into(), input, resources)
            .await
            .unwrap_or_else(|e| panic!("{endpoint}.{method} call error: {e}"));
        call.start()
            .await
            .unwrap_or_else(|e| panic!("{endpoint}.{method} start error: {e}"));
        let mut reply = call
            .receive()
            .await
            .unwrap_or_else(|e| panic!("{endpoint}.{method} receive error: {e}"));
        if let Reply::Prepared { .. } = reply {
            reply = call
                .confirm(json!({"purpose":"upgrade-compat"}))
                .await
                .unwrap_or_else(|e| panic!("{endpoint}.{method} confirm error: {e}"));
        }
        reply
            .cleanup()
            .expect("terminal physical reply")
            .as_ref()
            .expect("call cleanup confirmed");
        match reply {
            Reply::Finished { result, .. } => (
                result.unwrap_or_else(|e| panic!("{endpoint}.{method} finished error: {e}")),
                None,
            ),
            Reply::Mutation { reply, .. } => {
                let reference = serde_json::to_value(&reply.reference).unwrap();
                match reply.receipt {
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Success { value },
                            },
                        cleanup,
                        ..
                    } => {
                        assert_eq!(cleanup, OperationCleanup::Confirmed);
                        (value, Some(reference))
                    }
                    other => panic!("unexpected {endpoint}.{method} mutation receipt: {other:?}"),
                }
            }
            other => panic!("unexpected {endpoint}.{method} reply: {other:?}"),
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timeout calling {endpoint}.{method}"))
}

async fn call(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
    attachments: Attachments,
) -> Value {
    call_with_ref(client, endpoint, method, input, attachments)
        .await
        .0
}

async fn wait_run_completed(client: &Client, session: &str, message_id: &str) -> Value {
    let target = json!({"kind": "message", "messageId": message_id});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let run_id = loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timeout waiting for run completion on {session}/{message_id}"
        );
        let w = call(
            client,
            "agent",
            "work",
            json!({"sessionId": session, "target": target}),
            Attachments::new(),
        )
        .await;
        if w["kind"] == "delivered" {
            let state = w["execution"]["state"]["kind"].as_str().unwrap();
            if state == "completed" {
                break w["execution"]["runId"].clone();
            }
            assert!(
                matches!(state, "admitted" | "running" | "waiting"),
                "unexpected run state while waiting for completion: {w}"
            );
        } else {
            assert_eq!(w["kind"], "pending", "unexpected work status: {w}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };

    let run_target = json!({"kind": "run", "runId": run_id});
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timeout waiting for workReadiness on {session}"
        );
        let readiness = call(
            client,
            "agent",
            "workReadiness",
            json!({"sessionId": session, "target": run_target}),
            Attachments::new(),
        )
        .await;
        match readiness["kind"].as_str().unwrap() {
            "ready" => return run_id,
            "pending" => tokio::time::sleep(Duration::from_millis(25)).await,
            other => panic!("unexpected workReadiness {other}: {readiness}"),
        }
    }
}

async fn wait_successful_script_check(client: &Client, task_id: &str) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut first_due = None;
        loop {
            let detail = call(
                client,
                "agent",
                "schedules",
                json!({"kind":"get","taskId":task_id}),
                Attachments::new(),
            )
            .await;
            let task = &detail["detail"]["task"];
            assert_eq!(task["status"], "active", "{detail}");
            assert_eq!(task["fireCount"], 0, "{detail}");
            assert!(task["lastError"].is_null(), "{detail}");
            let next = task["nextFireAt"].as_i64().unwrap();
            if next > *first_due.get_or_insert(next) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("script did not complete its next check");
}

async fn recall_search(client: &Client, term: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let mut call = client
            .call(
                "agent",
                "recall".into(),
                json!({"terms": [term]}),
                Attachments::new(),
            )
            .await
            .unwrap();
        call.start().await.unwrap();
        let subscribed = call.receive().await.unwrap();
        assert!(
            matches!(subscribed, Reply::Subscribed),
            "expected Subscribed, got {subscribed:?}"
        );
        let page = match call.pull().await.unwrap() {
            Reply::Item { value } => {
                let _ = call.cancel().await;
                value
            }
            Reply::Finished { result, cleanup } => {
                cleanup.expect("recall cleanup");
                result.unwrap()
            }
            other => panic!("unexpected recall pull reply for {term}: {other:?}"),
        };
        let has_hit = page["passages"].as_array().is_some_and(|a| !a.is_empty())
            || page["titles"].as_array().is_some_and(|a| !a.is_empty())
            || page["facts"].as_array().is_some_and(|a| !a.is_empty());
        if has_hit || tokio::time::Instant::now() >= deadline {
            return page;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[derive(Clone)]
enum MockMode {
    Produce {
        nonce: String,
        tool_called: Arc<AtomicBool>,
    },
    Verify {
        pre_nonce: String,
        post_nonce: String,
        session_data_key: String,
        tool_called: Arc<AtomicBool>,
        saw_pre_context: Arc<AtomicBool>,
        saw_session_data: Arc<AtomicBool>,
    },
}

fn handle_model_request(body: &Value, mode: &MockMode) -> TurnPlan {
    let messages = body["messages"].as_array().expect("messages array");
    let has_exec = body["tools"]
        .as_array()
        .is_some_and(|tools| tools.iter().any(|t| t["function"]["name"] == "exec"));

    if !has_exec {
        return TurnPlan::new()
            .with_response_id("compat")
            .push_text("auxiliary ok")
            .with_usage(Usage::new(120, 20))
            .finish(FinishReason::Stop);
    }

    match mode {
        MockMode::Produce { nonce, tool_called } => {
            let call_id = format!("compat-pre-{nonce}");
            if let Some(tool_msg) = messages
                .iter()
                .find(|m| m["role"] == "tool" && m["tool_call_id"] == call_id)
            {
                let content = tool_msg["content"].to_string();
                assert!(
                    content.contains(&format!("pre-cell-ok:{nonce}")),
                    "expected Code Mode output in produce turn, got: {content}"
                );
                return TurnPlan::new()
                    .with_response_id("compat")
                    .push_text(format!("Pre-upgrade turn complete {nonce}."))
                    .with_usage(Usage::new(120, 20))
                    .finish(FinishReason::Stop);
            }
            assert!(
                !tool_called.swap(true, Ordering::SeqCst),
                "produce turn must not invoke exec twice"
            );
            let code = format!(
                r#"
const sh = await tools.Shell({{ command: "printf 'compat-shell-{nonce}' > compat-effect.txt && cat compat-effect.txt" }});
if (sh.kind !== "completed" || sh.value.exitCode !== 0) throw new Error("Shell failed: " + JSON.stringify(sh));
await store("compat_capsule_state", {{ origin: "pre-upgrade", nonce: "{nonce}" }});
const loaded = await load("compat_capsule_state");
if (!loaded || loaded.nonce !== "{nonce}") throw new Error("SessionData roundtrip failed");
text("pre-cell-ok:{nonce}");
"#
            );
            TurnPlan::new()
                .with_response_id("compat")
                .push_tool_call(
                    call_id,
                    "exec",
                    json!({"code": code, "yield_time_ms": 15000, "max_output_tokens": 4000}),
                )
                .with_usage(Usage::new(120, 20))
                .finish(FinishReason::ToolCalls)
        }
        MockMode::Verify {
            pre_nonce,
            post_nonce,
            session_data_key,
            tool_called,
            saw_pre_context,
            saw_session_data,
        } => {
            let call_id = format!("compat-post-{post_nonce}");
            // Verify pre-upgrade conversation context strictly on the FIRST
            // post-upgrade request, before this mock emits any post-upgrade tool
            // call containing pre_nonce.
            if !tool_called.load(Ordering::SeqCst) {
                let has_pre_turn = messages.iter().any(|m| {
                    matches!(m["role"].as_str(), Some("user" | "assistant"))
                        && serde_json::to_string(&m["content"])
                            .unwrap_or_default()
                            .contains(pre_nonce)
                });
                if has_pre_turn {
                    saw_pre_context.store(true, Ordering::SeqCst);
                }
            }
            if let Some(tool_msg) = messages
                .iter()
                .find(|m| m["role"] == "tool" && m["tool_call_id"] == call_id)
            {
                let content = tool_msg["content"].to_string();
                assert!(
                    content.contains(&format!("post-session-data-ok:{pre_nonce}")),
                    "Code Mode failed to load pre-upgrade SessionData after upgrade: {content}"
                );
                saw_session_data.store(true, Ordering::SeqCst);
                return TurnPlan::new()
                    .with_response_id("compat")
                    .push_text(format!("Post-upgrade continuation complete {post_nonce}."))
                    .with_usage(Usage::new(120, 20))
                    .finish(FinishReason::Stop);
            }
            assert!(
                !tool_called.swap(true, Ordering::SeqCst),
                "verify turn must not invoke exec twice"
            );
            let code = format!(
                r#"
const prev = await load("{session_data_key}");
if (!prev || prev.nonce !== "{pre_nonce}") {{
  throw new Error("Missing or mismatched pre-upgrade SessionData: " + JSON.stringify(prev));
}}
await store("compat_post_upgrade", {{ ok: true, prevNonce: prev.nonce, postNonce: "{post_nonce}" }});
text("post-session-data-ok:" + prev.nonce);
"#
            );
            TurnPlan::new()
                .with_response_id("compat")
                .push_tool_call(
                    call_id,
                    "exec",
                    json!({"code": code, "yield_time_ms": 15000, "max_output_tokens": 4000}),
                )
                .with_usage(Usage::new(120, 20))
                .finish(FinishReason::ToolCalls)
        }
    }
}

async fn start_mock_server(mode: MockMode) -> MockAiServer {
    MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("gpt-4.1")],
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
            assert_eq!(req.protocol, Protocol::OpenaiChatCompletions);
            let auth = req
                .headers
                .get("authorization")
                .map(String::as_str)
                .unwrap_or("");
            assert_eq!(
                auth, "Bearer compat-fixture-secret",
                "persisted vault credential must be loaded and sent to provider"
            );
            handle_model_request(&req.raw_body, &mode)
        })
        .start()
        .await
        .unwrap()
}

fn collect_sqlite_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_sqlite_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("sqlite") {
            out.push(path);
        }
    }
}

fn verify_sqlite_integrity_and_migrations(root: &Path) -> BTreeMap<String, Vec<i64>> {
    let mut dbs = Vec::new();
    collect_sqlite_files(root, &mut dbs);
    dbs.sort();
    assert!(
        !dbs.is_empty(),
        "expected SQLite databases under State Root {}",
        root.display()
    );
    let mut ledgers = BTreeMap::new();
    for db_path in dbs {
        let conn = Connection::open(&db_path)
            .unwrap_or_else(|e| panic!("open SQLite {}: {e}", db_path.display()));
        maka_event_log::content::register_sql_functions(&conn)
            .unwrap_or_else(|e| panic!("register content UDFs {}: {e}", db_path.display()));
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap_or_else(|e| panic!("integrity_check {}: {e}", db_path.display()));
        assert_eq!(
            integrity,
            "ok",
            "SQLite integrity check failed for {}: {integrity}",
            db_path.display()
        );
        let has_ledger: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if has_ledger > 0 {
            let mut stmt = conn
                .prepare("SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version")
                .unwrap();
            let versions: Vec<i64> = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let rel = db_path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let has_runs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let has_encoding = maka_event_log::content::has_encoding_column(&conn).unwrap();
            if has_runs > 0 && versions.contains(&17) {
                use maka_agent_facts::external_publication::PublicationManifest;
                use maka_fs_tools::publication::{PublicationChange, SourceIdentity};
                let payload_expr = if has_encoding {
                    "maka_content_bytes(c.payload, c.encoding)"
                } else {
                    "c.payload"
                };
                let mut manifests = conn.prepare(&format!(
                    "SELECT p.publication,{payload_expr} FROM agent_external_publications p
                     LEFT JOIN contents c ON c.content_sha256=json_extract(p.body,'$.manifest.digest')
                     WHERE json_extract(p.body,'$.manifest') IS NOT NULL",
                )).unwrap();
                let mut rows = manifests.query([]).unwrap();
                while let Some(row) = rows.next().unwrap() {
                    let id: String = row.get(0).unwrap();
                    let bytes: Vec<u8> = row.get(1).expect("missing publication manifest");
                    let manifest: PublicationManifest<SourceIdentity, PublicationChange> =
                        serde_json::from_slice(&bytes).expect("invalid publication manifest");
                    assert_eq!(manifest.publication.to_string(), id);
                }
            }
            if has_runs > 0 && versions.contains(&53) {
                let mut streaks = conn
                    .prepare("SELECT run, retry_streak FROM agent_runs")
                    .unwrap();
                let rows = streaks
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .unwrap();
                for row in rows {
                    let (run, raw) = row.unwrap();
                    let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|e| {
                        panic!("invalid agent_runs.retry_streak JSON for run {run}: {raw} ({e})")
                    });
                    assert!(
                        matches!(
                            parsed.get("kind").and_then(Value::as_str),
                            Some(
                                "regular"
                                    | "fallback_transition_pending"
                                    | "after_fallback_transition"
                            )
                        ),
                        "unexpected agent_runs.retry_streak variant for run {run}: {parsed}"
                    );
                }
            }
            if versions.contains(&58) {
                let wrapped_recaps: i64 = conn
                    .query_row(
                        "SELECT count(*) FROM plugin_data
                         WHERE package_id='maka.session-recap' AND scope_id='profile'
                           AND json_type(value_json,'$.receipt')='object'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    wrapped_recaps, 0,
                    "migration 58 left wrapped recap receipts on {rel}"
                );
            }
            if has_runs > 0 && versions.contains(&57) {
                let body_text = if has_encoding {
                    "maka_content_text(b.payload, b.encoding)"
                } else {
                    "CAST(b.payload AS TEXT)"
                };
                let inconsistent: i64 = conn.query_row(
                    &format!(
                        "WITH pending AS (
                           SELECT session,request,coalesce(entry_json->>'$.request.spec.memoryAdmission','unknown') AS admission
                           FROM agent_queue_items WHERE state='pending'
                         ), last_edit AS (
                           SELECT p.session,p.request,max(e.revision) AS revision
                           FROM (SELECT DISTINCT session FROM pending) affected
                           CROSS JOIN agent_queue_events e ON e.session=affected.session
                           CROSS JOIN contents b ON b.id=e.body_content_id
                           CROSS JOIN pending p ON p.session=e.session AND p.request={body_text}->>'$.edit.request.id'
                           WHERE {body_text}->>'$.kind'='command' AND {body_text}->>'$.edit.kind' IN ('enqueue','update')
                           GROUP BY p.session,p.request
                         )
                         SELECT count(*) FROM pending p LEFT JOIN last_edit l USING(session,request)
                         LEFT JOIN agent_queue_events e ON e.session=l.session AND e.revision=l.revision
                         LEFT JOIN contents b ON b.id=e.body_content_id
                         WHERE l.revision IS NULL OR p.admission IS NOT coalesce(
                           e.memory_admission,{body_text}->>'$.edit.request.spec.memoryAdmission','unknown')"
                    ),
                    [],
                    |row| row.get(0),
                ).unwrap();
                assert_eq!(
                    inconsistent, 0,
                    "pending admission differs from queue history on {rel}"
                );
            }
            if has_runs > 0 && versions.contains(&55) {
                for view in [
                    "agent_memory_operation_field_source",
                    "agent_memory_termination_receipts",
                    "agent_memory_recall_outputs",
                ] {
                    let _: i64 = conn
                        .query_row(&format!("SELECT COUNT(*) FROM {view}"), [], |row| {
                            row.get(0)
                        })
                        .unwrap_or_else(|e| panic!("v55 view {view} failed on {rel}: {e}"));
                }
                let ns_join = if versions.contains(&62) {
                    "m.namespace_id=h.namespace_id"
                } else {
                    "m.owner=h.owner AND m.session=h.session"
                };
                let body_text = if has_encoding {
                    "maka_content_text(b.payload, b.encoding)"
                } else {
                    "CAST(b.payload AS TEXT)"
                };
                let missing_ended_unknown: i64 = conn
                    .query_row(
                        &format!(
                            "SELECT COUNT(*) FROM agent_session_history h
                             JOIN agent_facts f ON f.sequence=h.sequence
                             JOIN contents b ON b.id=f.body_content_id
                             WHERE h.kind='external_effect' AND h.tool_start=0 AND h.result_source=0
                               AND {body_text}->>'$.fact.event.kind'='observed'
                               AND {body_text}->>'$.fact.event.observation.receipt.outcome.kind'='unknown'
                               AND {body_text}->>'$.fact.event.observation.receipt.cleanup.kind'='confirmed'
                               AND NOT EXISTS (
                                 SELECT 1 FROM agent_recall_messages m
                                 WHERE {ns_join} AND m.sequence=h.sequence
                               )"
                        ),
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    missing_ended_unknown, 0,
                    "v55 must index every ended-unknown external observation on {rel}"
                );
            }
            if has_runs > 0 && versions.contains(&59) {
                for dropped in [
                    "agent_recall_message_order",
                    "agent_recall_scope_runs",
                    "agent_run_specs_history",
                    "agent_interaction_requests_session",
                    "agent_interaction_outcomes_session",
                    "agent_continuation_successors_run",
                ] {
                    let exists: bool = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)",
                            [dropped],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert!(!exists, "v59 must drop duplicate index {dropped} on {rel}");
                }
            }
            if has_runs > 0 && versions.contains(&60) {
                let has_folded: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agent_recall_messages') WHERE name='folded')",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(
                    !has_folded,
                    "v60 must drop agent_recall_messages.folded on {rel}"
                );
            }
            if has_runs > 0 && versions.contains(&61) {
                let has_legacy_table: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_recall_legacy_evidenced'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    has_legacy_table, 1,
                    "v61 must create agent_recall_legacy_evidenced on {rel}"
                );
                let ns_join = if versions.contains(&62) {
                    "h.namespace_id = d.namespace_id"
                } else {
                    "h.owner = d.owner AND h.session = d.session"
                };
                let body_text = if has_encoding {
                    "maka_content_text(c.payload, c.encoding)"
                } else {
                    "CAST(c.payload AS TEXT)"
                };
                let bookkeeping: i64 = conn
                    .query_row(
                        &format!(
                            "SELECT COUNT(*) FROM agent_recall_messages d
                             JOIN agent_session_history h
                               ON {ns_join} AND h.sequence = d.sequence
                             JOIN agent_facts f ON f.sequence = h.sequence
                             JOIN contents c ON c.id = f.body_content_id
                             WHERE h.kind = 'cell'
                               AND json_extract({body_text}, '$.fact.event.kind') IN (
                                 'vm_bound', 'loaded_tools_published', 'child_admitted',
                                 'child_approval_consumed', 'child_bound',
                                 'result_accepted', 'final_notification_queued', 'notification_consumed'
                               )
                               AND NOT EXISTS (
                                 SELECT 1 FROM agent_recall_legacy_evidenced e
                                 WHERE e.fact_id = h.fact_id
                               )"
                        ),
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    bookkeeping, 0,
                    "v61 must omit unreferenced pure cell bookkeeping rows from agent_recall_messages on {rel}"
                );
            }
            if has_runs > 0 && versions.contains(&62) {
                let ns_rows: i64 = conn
                    .query_row("SELECT COUNT(*) FROM agent_namespaces", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert!(ns_rows > 0, "v62 must populate agent_namespaces on {rel}");
                for table in [
                    "agent_session_history",
                    "agent_recall_messages",
                    "agent_usage_calls",
                ] {
                    let has_ns: bool = conn
                        .query_row(
                            &format!(
                                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='namespace_id')"
                            ),
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    let has_legacy: bool = conn
                        .query_row(
                            &format!(
                                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name IN ('owner','session'))"
                            ),
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert!(
                        has_ns && !has_legacy,
                        "v62 must replace (owner,session) with namespace_id on {table} in {rel}"
                    );
                }
                for dropped in [
                    "agent_session_history_run_fk",
                    "agent_session_history_result",
                    "agent_memory_run_termination",
                    "agent_usage_call_session_time",
                ] {
                    let present: bool = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                            [dropped],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert!(!present, "v62 must drop redundant index {dropped} on {rel}");
                }
            }
            if has_runs > 0 && versions.contains(&63) {
                for col in ["encoding", "logical_bytes"] {
                    let exists: bool = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('contents') WHERE name=?)",
                            [col],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert!(exists, "v63 must add contents.{col} on {rel}");
                }
                let invalid_rows: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM contents
                         WHERE encoding NOT IN (0, 1, 2, 3)
                            OR (encoding = 0 AND logical_bytes IS NOT NULL)
                            OR (encoding IN (1, 2, 3) AND (logical_bytes IS NULL OR logical_bytes < 0))",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let recomp_rows: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM content_recompression_state WHERE singleton = 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    recomp_rows, 1,
                    "v63 must initialize content_recompression_state on {rel}"
                );
                assert_eq!(
                    invalid_rows, 0,
                    "v63 contents encoding/logical_bytes invariant violated on {rel}"
                );
                let dict_decoded_ok: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM contents
                         WHERE encoding = 3
                           AND length(maka_content_bytes(payload, encoding)) = logical_bytes",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let dict_total: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM contents WHERE encoding = 3",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    dict_decoded_ok, dict_total,
                    "v63 dictionary-compressed (encoding=3) rows must decode to logical_bytes on {rel}"
                );
            }
            if has_runs > 0 && versions.contains(&64) {
                for view in [
                    "agent_history_tool_metadata_source",
                    "agent_memory_cell_accept_source",
                    "agent_memory_cell_code_source",
                    "agent_memory_cell_event_source",
                    "agent_memory_cell_publication_source",
                    "agent_memory_cell_return_source",
                    "agent_memory_failed_terminations",
                    "agent_memory_imported_tool_source",
                    "agent_memory_operation_field_source",
                    "agent_memory_recall_call_source",
                    "agent_memory_selected_readers",
                    "agent_memory_termination_receipts",
                ] {
                    let _: i64 = conn
                        .query_row(&format!("SELECT COUNT(*) FROM {view}"), [], |row| {
                            row.get(0)
                        })
                        .unwrap_or_else(|e| panic!("v64 view {view} failed on {rel}: {e}"));
                }
            }
            if has_runs > 0 && versions.contains(&65) {
                for (table, col, enc) in [
                    (
                        "application_operation_contracts",
                        "contract_json",
                        "contract_encoding",
                    ),
                    ("application_operations", "request_json", "request_encoding"),
                    (
                        "application_intents",
                        "reference_json",
                        "reference_encoding",
                    ),
                    ("application_intents", "recovery_json", "recovery_encoding"),
                ] {
                    let invalid_json: i64 = conn
                        .query_row(
                            &format!(
                                "SELECT COUNT(*) FROM {table}
                                 WHERE {enc} NOT IN (0, 1, 2, 3)
                                    OR NOT json_valid(maka_content_text({col}, {enc}))"
                            ),
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(
                        invalid_json, 0,
                        "v65 inline JSON decode invariant violated on {table}.{col} ({rel})"
                    );
                }
            }
            if has_runs > 0 && versions.contains(&66) {
                let invalid_cells: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM agent_cells
                         WHERE body_encoding NOT IN (0, 1, 2, 3)
                            OR NOT json_valid(maka_content_text(body, body_encoding))",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    invalid_cells, 0,
                    "v66 agent_cells decode invariant violated on {rel}"
                );
                for dropped in ["binding_json", "quote_json"] {
                    let exists: bool = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agent_usage_calls') WHERE name=?)",
                            [dropped],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert!(
                        !exists,
                        "v66 must replace agent_usage_calls.{dropped} with interned FK on {rel}"
                    );
                }
                let invalid_blobs: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM agent_usage_json_blobs WHERE NOT json_valid(body)",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    invalid_blobs, 0,
                    "v66 agent_usage_json_blobs JSON validity violated on {rel}"
                );
            }
            ledgers.insert(rel, versions);
        }
    }
    assert!(
        !ledgers.is_empty(),
        "expected at least one migration ledger under {}",
        root.display()
    );
    ledgers
}

struct QueuedBeforeUpgrade {
    db: PathBuf,
    session: String,
    request: String,
    at: i64,
}

fn capture_queued_before_upgrade(root: &Path, session: &str) -> QueuedBeforeUpgrade {
    let mut dbs = Vec::new();
    collect_sqlite_files(root, &mut dbs);
    let mut found = Vec::new();
    for db in dbs {
        let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        maka_event_log::content::register_sql_functions(&conn).unwrap();
        let has_queue: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_queue_events')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if !has_queue {
            continue;
        }
        let body_text = if maka_event_log::content::has_encoding_column(&conn).unwrap() {
            "maka_content_text(b.payload, b.encoding)"
        } else {
            "CAST(b.payload AS TEXT)"
        };
        let row: Option<(String, i64)> = conn
            .query_row(
                &format!(
                    "SELECT q.request, e.at FROM agent_queue_events e
                     JOIN contents b ON b.id=e.body_content_id
                     JOIN agent_queue_items q ON q.session=e.session
                       AND q.request=json_extract({body_text}, '$.edit.request.id')
                     WHERE e.session=? AND q.state='delivered'
                       AND json_extract({body_text}, '$.kind')='command'
                       AND json_extract({body_text}, '$.edit.kind')='enqueue'
                       AND json_extract({body_text}, '$.resume_after_interrupt') IS NULL
                     ORDER BY e.revision LIMIT 1"
                ),
                [session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap();
        if let Some((request, at)) = row {
            found.push(QueuedBeforeUpgrade {
                db,
                session: session.to_owned(),
                request,
                at,
            });
        }
    }
    assert_eq!(
        found.len(),
        1,
        "capsule must contain a delivered ordinary enqueue for {session}"
    );
    let item = found.pop().unwrap();
    assert_ne!(
        item.at, 0,
        "capsule enqueue time must detect a missing v54 backfill"
    );
    item
}

fn verify_queued_after_upgrade(item: &QueuedBeforeUpgrade) {
    let conn = Connection::open_with_flags(&item.db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (state, at, interrupted): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT state,enqueued_at,interrupted_run FROM agent_queue_items WHERE session=? AND request=?",
            params![item.session, item.request],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("pre-upgrade queued request missing after upgrade");
    assert_eq!(state, "delivered");
    assert_eq!(
        at, item.at,
        "enqueue time differs from the pre-upgrade canonical event"
    );
    assert_eq!(
        interrupted, None,
        "ordinary enqueue acquired interrupt provenance"
    );
}

// Only open settings directly with the real Root lease after the child exits.
async fn open_compat_settings(root: &Path) -> ConfigurationStore {
    let root = root.to_owned();
    let owner = tokio::task::spawn_blocking(move || {
        RootOwner::open_existing(&root, &RootNamespaces::for_current_account().unwrap()).unwrap()
    })
    .await
    .unwrap();
    ConfigurationStore::for_root(Arc::new(owner)).await.unwrap()
}

async fn produce_capsule(bin: &Path, capsule_dir: &Path) -> CapsuleManifest {
    fs::create_dir_all(capsule_dir).unwrap();
    let canonical_base = fs::canonicalize(capsule_dir).unwrap();
    let dirs = EnvDirs::in_base(&canonical_base);
    dirs.prepare();

    let version_out = build_command(bin, &dirs)
        .arg("--version")
        .output()
        .await
        .unwrap();
    assert!(version_out.status.success(), "maka --version failed");
    let maka_version = String::from_utf8_lossy(&version_out.stdout)
        .trim()
        .to_owned();

    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let server = start_mock_server(MockMode::Produce {
        nonce: nonce.clone(),
        tool_called: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let base_url = server.base_url();

    let mut host = Host::spawn_with(bin, &dirs.root, &dirs.home, &dirs.workspace)
        .unwrap_or_else(|e| panic!("spawn Host {}: {e}", bin.display()));
    let outcome = AssertUnwindSafe(async {
        let (mut client, _) = host.ready().await.expect("Host ready");

        // 1. Settings: provider connection, persisted vault credential, preferences.
        let catalog = call(
            &client,
            "settings",
            "connections",
            json!({"kind": "start"}),
            Attachments::new(),
        )
        .await;
        assert_eq!(catalog["kind"], "ready");
        let created_conn = call(
            &client,
            "settings",
            "create",
            json!({
                "expectedCatalogRevision": catalog["revision"],
                "connection": {
                    "slug": "compat-loopback",
                    "name": "Compat Loopback",
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
                            "apiProtocol": "openai-chat-completions"
                        }
                    }
                }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(created_conn["kind"], "committed", "{created_conn}");
        let connection_id = created_conn["connection"]["connectionId"]
            .as_str()
            .unwrap()
            .to_owned();

        let detail = call(
            &client,
            "settings",
            "connection",
            json!({"connectionId": connection_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(detail["kind"], "ready", "{detail}");
        let secret: Arc<dyn ReadResource> = Arc::new(FixtureSecret);
        let saved_cred = call(
            &client,
            "settings",
            "saveCredential",
            json!({"expected": detail["target"], "expectedCredential": null}),
            Attachments::from([("secret".into(), secret)]),
        )
        .await;
        assert_eq!(saved_cred["kind"], "saved", "{saved_cred}");

        let prefs = call(
            &client,
            "settings",
            "assistantPreferences",
            json!({}),
            Attachments::new(),
        )
        .await;
        let updated_prefs = call(
            &client,
            "settings",
            "updateAssistantPreferences",
            json!({
                "expectedRevision": prefs["revision"],
                "mutation": {
                    "kind": "compaction_prompt",
                    "prompt": COMPACTION_PROMPT
                }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(updated_prefs["kind"], "committed", "{updated_prefs}");

        // 2. Primary session: upload attachment, run Shell + Code Mode SessionData turn.
        let (created_session, operation_ref) = call_with_ref(
            &client,
            "agent",
            "create",
            json!({
                "title": format!("Compat Primary {nonce}"),
                "automaticTitle": false,
                "labels": ["compat"],
                "tools": ["Shell"],
                "workspace": {"kind": "directory", "path": dirs.workspace},
                "backend": {
                    "kind": "model",
                    "connectionId": connection_id,
                    "modelId": "gpt-4.1",
                    "thinkingLevel": null
                }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(created_session["kind"], "created", "{created_session}");
        let primary_session_id = created_session["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let payload: Arc<dyn ReadResource> = Arc::new(FixtureAttachment);
        let uploaded = call(
            &client,
            "agent",
            "uploadAttachment",
            json!({
                "sessionId": primary_session_id,
                "name": "compat.txt",
                "bytes": ATTACHMENT_BYTES.len(),
                "digest": maka_agent_facts::artifact::content_digest(ATTACHMENT_BYTES),
            }),
            Attachments::from([("file".into(), payload)]),
        )
        .await;
        assert_eq!(uploaded["kind"], "uploaded", "{uploaded}");
        let attachment_id = uploaded["attachment"]["id"].as_str().unwrap().to_owned();

        let sent = call(
            &client,
            "agent",
            "submitMessage",
            json!({
                "sessionId": primary_session_id,
                "message": format!("Run pre-upgrade verification {nonce}."),
                "attachments": [attachment_id],
                "idempotencyKey": nonce
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(sent["kind"], "queued", "{sent}");
        wait_run_completed(
            &client,
            &primary_session_id,
            sent["messageId"].as_str().unwrap(),
        )
        .await;
        assert_eq!(
            fs::read_to_string(dirs.workspace.join("compat-effect.txt")).unwrap(),
            format!("compat-shell-{nonce}")
        );

        // 3. Forked session (lineage / snapshot tables).
        let observed = call(
            &client,
            "agent",
            "observe",
            json!({"sessionId": primary_session_id}),
            Attachments::new(),
        )
        .await;
        let forked = call(
            &client,
            "agent",
            "fork",
            json!({
                "sessionId": primary_session_id,
                "expectedRevision": observed["session"]["revision"],
                "position": {"kind": "end"},
                "title": format!("Compat Fork {nonce}"),
                "labels": ["compat-fork"]
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(forked["kind"], "forked", "{forked}");
        let forked_session_id = forked["session"]["id"].as_str().unwrap().to_owned();

        // 3b. Side question (a fork whose lineage carries `side`).
        let observed = call(
            &client,
            "agent",
            "observe",
            json!({"sessionId": primary_session_id}),
            Attachments::new(),
        )
        .await;
        let side = call(
            &client,
            "agent",
            "fork",
            json!({
                "sessionId": primary_session_id,
                "expectedRevision": observed["session"]["revision"],
                "position": {"kind": "end"},
                "title": format!("Compat Side {nonce}"),
                "labels": [],
                "side": true
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(side["kind"], "forked", "{side}");
        assert_eq!(side["session"]["branch"]["side"], true, "{side}");
        let side_session_id = side["session"]["id"].as_str().unwrap().to_owned();

        // 4. Multi-participant Room + persisted message.
        let room = call(
            &client,
            "agent",
            "create",
            json!({
                "kind": "room",
                "title": format!("Compat Room {nonce}"),
                "labels": ["compat-room"],
                "workspace": {"kind": "session", "sessionId": primary_session_id}
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(room["kind"], "created", "{room}");
        let room_id = room["session"]["id"].as_str().unwrap().to_owned();
        let room_pre_message = format!("compat-room-pre-{nonce}");
        let room_post = call(
            &client,
            "agent",
            "send",
            json!({"sessionId": room_id, "message": room_pre_message}),
            Attachments::new(),
        )
        .await;
        assert_eq!(room_post["kind"], "posted", "{room_post}");

        // 5. Subagent Preset.
        let preset = call(
            &client,
            "agent",
            "createPreset",
            json!({
                "name": PRESET_NAME,
                "description": "Review upgrade compatibility capsules",
                "instruction": "Inspect persisted schema upgrades carefully.",
                "model": {
                    "connectionId": connection_id,
                    "modelId": "gpt-4.1"
                },
                "thinkingLevel": null
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(preset["kind"], "saved", "{preset}");
        let preset_id = preset["preset"]["id"].as_str().unwrap().to_owned();

        // 6. Personal Memory assertion + Recall index warmup.
        let memory_body = format!("Compat persisted memory assertion {nonce}");
        let memory = call(
            &client,
            "agent",
            "changeMemory",
            json!({
                "scope": {"kind": "personal"},
                "edit": {
                    "kind": "create",
                    "body": memory_body
                }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(memory["kind"], "saved", "{memory}");
        let memory_id = memory["id"].as_str().unwrap().to_owned();
        let _ = recall_search(&client, &nonce).await;

        // 7. Workspace Checkpoint + Portable archive export.
        let preview = call(
            &client,
            "agent",
            "previewHistoryCheckpoint",
            json!({"sessionId": primary_session_id}),
            Attachments::new(),
        )
        .await;
        let published = call(
            &client,
            "agent",
            "publishCheckpoint",
            json!({
                "sessionId": primary_session_id,
                "expectedRevision": Value::Null,
                "confirmedSubtreeDigest": preview["subtreeDigest"],
                "workspaceConsistency": "caller_confirmed_quiescent"
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(published["state"]["kind"], "published", "{published}");
        assert_eq!(published["cleanupPending"], false);
        let checkpoint_revision = published["state"]["head"]["revision"].clone();
        assert!(
            !checkpoint_revision.is_null(),
            "missing checkpoint revision: {published}"
        );

        let portable_archive_name = "portable-checkpoint.tar.gz".to_owned();
        let portable_archive = capsule_dir.join(&portable_archive_name);
        let export_out = build_command(bin, &dirs)
            .args(["checkpoint", "export", "--root"])
            .arg(&dirs.root)
            .args([
                "--session",
                &primary_session_id,
                "--revision",
                checkpoint_revision.as_str().unwrap(),
                "--output",
            ])
            .arg(&portable_archive)
            .output()
            .await
            .unwrap();
        assert!(
            export_out.status.success(),
            "checkpoint export failed: {}",
            String::from_utf8_lossy(&export_out.stderr)
        );
        let seed = dirs.workspace.join("compat-script-seed");
        tokio::fs::write(&seed, &nonce).await.unwrap();
        let session = &observed["session"];
        let script = call(&client, "agent", "schedule", json!({"kind":"create","input":{
            "timezone":"UTC","misfire":"skip","task":{"title":"Compat script cursor","intentBody":"Report a match",
                "schedule":{"kind":"script","everySeconds":1,"startAt":0,
                    "source":format!(r#"const prior = Deno.env.get("MAKA_AUTOMATION_STATE");
                        if (prior === undefined) console.log(JSON.stringify({{trigger:false,state:await Deno.readTextFile("compat-script-seed")}}));
                        else if (JSON.parse(prior) === "{nonce}") console.log(false);
                        else throw Error("Wrong persisted script cursor");"#)},
                "effect":{"kind":"session","target":{"sessionId":primary_session_id,
                    "workspace":session["workspace"],"permissions":session["permissions"],
                    "binding":session["binding"],"boundaryRevision":session["boundaryRevision"]},
                    "model":{"connectionId":connection_id,"modelId":"gpt-4.1"}}}
        }}), Attachments::new()).await;
        assert_eq!(script["kind"], "committed", "{script}");
        let script_task_id = script["taskId"].as_str().unwrap().to_owned();
        wait_successful_script_check(&client, &script_task_id).await;
        host.quit(&mut client).await.expect("Host quit");
        // Only the persisted cursor can satisfy the first check after upgrading.
        tokio::fs::remove_file(seed).await.unwrap();

        let execution_authority = Some(execution_compat::produce(capsule_dir).await);
        let host_peer_id = format!("compat-peer-{nonce}");
        let settings = open_compat_settings(&dirs.root).await;
        settings
            .grant_host_peer_access(
                PeerId::new(host_peer_id.clone()).unwrap(),
                COMPAT_PEER_GRANT.into(),
            )
            .await
            .unwrap();
        save_compat_relay(
            &settings,
            maka_config::remote_access::RelayAuthUpdate::Replace(COMPAT_RELAY_TOKEN.into()),
        )
        .await;
        seed_pairing_invite(&settings).await;
        settings
            .trust_project_mcp(
                COMPAT_MCP_OWNER.into(),
                COMPAT_MCP_WORKSPACE.into(),
                COMPAT_MCP_REVISION.into(),
            )
            .await
            .unwrap();
        settings.close().await.unwrap();
        let migrations = verify_sqlite_integrity_and_migrations(&dirs.root);
        CapsuleManifest {
            format_version: 1,
            base_dir: canonical_base.to_string_lossy().into_owned(),
            maka_version,
            git_sha: std::env::var("GITHUB_SHA").ok(),
            nonce,
            connection_id,
            connection_slug: "compat-loopback".into(),
            primary_session_id,
            keyed_message_id: Some(sent["messageId"].as_str().unwrap().to_owned()),
            forked_session_id,
            side_session_id: Some(side_session_id),
            room_id,
            room_pre_message,
            preset_id,
            memory_id,
            memory_body,
            checkpoint_revision,
            portable_archive: portable_archive_name,
            session_data_key: "compat_capsule_state".into(),
            operation_ref,
            script_task_id: Some(script_task_id),
            execution_authority,
            migrations,
            host_peer_id: Some(host_peer_id),
            host_pairing_invite: true,
            project_mcp_trusted: true,
            remote_relay_configured: true,
        }
    })
    .catch_unwind()
    .await;

    let cleanup = host.cleanup().await;
    let manifest = match outcome {
        Ok(m) => {
            server.shutdown().await;
            cleanup.expect("Host cleanup");
            m
        }
        Err(panic) => {
            let _ = server.shutdown_taking_panics().await;
            std::panic::resume_unwind(panic);
        }
    };
    fs::write(
        capsule_dir.join("hosts.json"),
        legacy_saved_hosts().to_string(),
    )
    .unwrap();
    fs::write(
        capsule_dir.join("capsule-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    manifest
}

fn legacy_saved_hosts() -> Value {
    json!([{
        "rootId": "compat-root",
        "hostName": "Compat Mac",
        "hostPeerId": "compat-peer",
        "relays": [{"url":"https://relay.example.com","quicPort":null,"certSha256":null}],
        "directEndpoints": ["hostLogs"],
    }])
}

fn verify_saved_host_upgrade(capsule_dir: &Path, work_dir: &Path) {
    use maka_remote_client::SavedHosts;

    // Mobile application support is separate from the Host root. Historical
    // capsules without this fixture still exercise the oldest client shape.
    let path = work_dir.join("hosts.json");
    let old = match fs::read(capsule_dir.join("hosts.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => legacy_saved_hosts(),
        Err(error) => panic!("read historical saved Hosts: {error}"),
    };
    fs::write(&path, old.to_string()).unwrap();
    let mut saved = SavedHosts::load(&path).unwrap();
    let mut host = saved.get("compat-root").unwrap().clone();
    assert_eq!(host.host_name(), "Compat Mac");
    assert_eq!(host.platform(), None);
    assert!(!host.reconnect_paused());
    host.set_host_name("Studio Mac").unwrap();
    host.set_reconnect_paused(true);
    saved.save(host).unwrap();

    let upgraded: Value = serde_json::from_reader(fs::File::open(&path).unwrap()).unwrap();
    let mut expected = old;
    expected[0]["hostName"] = json!("Studio Mac");
    expected[0]["reconnectPaused"] = json!(true);
    assert_eq!(upgraded, expected);

    let reopened = SavedHosts::load(path).unwrap();
    let host = reopened.get("compat-root").unwrap();
    assert_eq!(host.host_name(), "Studio Mac");
    assert_eq!(host.platform(), None);
    assert!(host.reconnect_paused());
}

async fn verify_capsule(bin: &Path, capsule_dir: &Path) {
    let manifest_raw = fs::read_to_string(capsule_dir.join("capsule-manifest.json"))
        .unwrap_or_else(|e| {
            panic!(
                "read capsule-manifest.json in {}: {e}",
                capsule_dir.display()
            )
        });
    let manifest: CapsuleManifest = serde_json::from_str(&manifest_raw).unwrap();
    assert_eq!(manifest.format_version, 1);

    // Upgrade the working capsule directory in-place (callers passing a saved
    // tarball extract a fresh copy at manifest.base_dir before calling verify,
    // matching a real user upgrading Maka at the same HOME and State Root path).
    let work_tmp = tempfile::tempdir().unwrap();
    verify_saved_host_upgrade(capsule_dir, work_tmp.path());
    let canonical_base = fs::canonicalize(capsule_dir).unwrap();
    let dirs = EnvDirs::in_base(&canonical_base);
    dirs.prepare();

    // Snapshot the old canonical event before the Host runs migration 54.
    let queued_before = capture_queued_before_upgrade(&dirs.root, &manifest.primary_session_id);

    let post_nonce = uuid::Uuid::new_v4().simple().to_string();
    let saw_pre_context = Arc::new(AtomicBool::new(false));
    let saw_session_data = Arc::new(AtomicBool::new(false));
    let server = start_mock_server(MockMode::Verify {
        pre_nonce: manifest.nonce.clone(),
        post_nonce: post_nonce.clone(),
        session_data_key: manifest.session_data_key.clone(),
        tool_called: Arc::new(AtomicBool::new(false)),
        saw_pre_context: saw_pre_context.clone(),
        saw_session_data: saw_session_data.clone(),
    })
    .await;
    let new_base_url = server.base_url();

    // Record pre-upgrade contents.id high-water marks so Stage 3 proves live continuation
    // newly inserted compressed contents rows (not merely re-pinning pre-existing digests).
    let pre_upgrade_max_content_id: BTreeMap<PathBuf, i64> = {
        let mut dbs = Vec::new();
        collect_sqlite_files(&dirs.root, &mut dbs);
        let mut marks = BTreeMap::new();
        for db in dbs {
            let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let has_contents: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='contents')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if has_contents {
                let max_id: i64 = conn
                    .query_row("SELECT COALESCE(MAX(id), 0) FROM contents", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                marks.insert(db, max_id);
            }
        }
        marks
    };

    // Stage 1: Cold startup & in-place schema/data migrations.
    let mut host = Host::spawn_with(bin, &dirs.root, &dirs.home, &dirs.workspace)
        .unwrap_or_else(|e| panic!("spawn Host {}: {e}", bin.display()));
    let outcome = AssertUnwindSafe(async {
        let (mut client, _) = host.ready().await.expect("Host ready");

        verify_queued_after_upgrade(&queued_before);
        let found = call(
            &client, "agent", "lookupSubmission",
            json!({"sessionId":manifest.primary_session_id, "idempotencyKey":manifest.nonce}),
            Attachments::new(),
        ).await;
        assert_eq!(found, json!(manifest.keyed_message_id));
        if let Some(original) = &manifest.keyed_message_id {
            let retried = call(
                &client, "agent", "submitMessage",
                json!({"sessionId":manifest.primary_session_id, "idempotencyKey":manifest.nonce,
                    "message":"Must not be inserted after upgrade."}),
                Attachments::new(),
            ).await;
            assert_eq!(retried, json!({"kind":"duplicate","messageId":original}));
        }

        // Stage 2: Exhaustive read/deserialization sweep across every persisted domain.
        if let Some(id) = &manifest.script_task_id {
            wait_successful_script_check(&client, id).await;
        }
        let catalog = call(
            &client,
            "settings",
            "connections",
            json!({"kind": "start"}),
            Attachments::new(),
        )
        .await;
        assert_eq!(catalog["kind"], "ready", "{catalog}");
        let detail = call(
            &client,
            "settings",
            "connection",
            json!({"connectionId": manifest.connection_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(detail["kind"], "ready", "{detail}");
        assert_eq!(detail["name"], "Compat Loopback", "{detail}");
        assert_eq!(detail["enabled"], true, "{detail}");
        assert!(
            serde_json::to_string(&catalog)
                .unwrap()
                .contains(&manifest.connection_slug),
            "connection catalog missing slug {}: {catalog}",
            manifest.connection_slug
        );

        let prefs = call(
            &client,
            "settings",
            "assistantPreferences",
            json!({}),
            Attachments::new(),
        )
        .await;
        assert_eq!(
            prefs["compactionPrompt"], COMPACTION_PROMPT,
            "assistantPreferences lost across upgrade: {prefs}"
        );

        // Sessions & full history deserialization.
        for session_id in [
            &manifest.primary_session_id,
            &manifest.forked_session_id,
            &manifest.room_id,
        ] {
            let obs = call(
                &client,
                "agent",
                "observe",
                json!({"sessionId": session_id}),
                Attachments::new(),
            )
            .await;
            assert_eq!(obs["session"]["id"], *session_id, "{obs}");
            let hist = call(
                &client,
                "agent",
                "history",
                json!({
                    "sessionId": session_id,
                    "position": {"kind": "tail"},
                    "includeThinking": true,
                    "view": "chat"
                }),
                Attachments::new(),
            )
            .await;
            let serialized = serde_json::to_string(&hist).unwrap();
            assert!(
                serialized.contains(&manifest.nonce),
                "pre-upgrade history missing nonce for {session_id}: {hist}"
            );
        }

        // A side question stays one: listed under its conversation, not among the others.
        if let Some(side_session_id) = &manifest.side_session_id {
            let ids = |page: &Value| {
                page["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|session| session["id"].as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            };
            let beside = call(
                &client,
                "agent",
                "list",
                json!({
                    "filter": "all",
                    "position": {"kind": "start"},
                    "scope": {"kind": "side_questions", "sessionId": manifest.primary_session_id}
                }),
                Attachments::new(),
            )
            .await;
            assert_eq!(ids(&beside), [side_session_id.clone()], "{beside}");
            let all = call(
                &client,
                "agent",
                "list",
                json!({"filter": "all", "position": {"kind": "start"}}),
                Attachments::new(),
            )
            .await;
            assert!(!ids(&all).contains(side_session_id), "{all}");
            assert!(ids(&all).contains(&manifest.forked_session_id), "{all}");
            let observed = call(
                &client,
                "agent",
                "observe",
                json!({"sessionId": side_session_id}),
                Attachments::new(),
            )
            .await;
            assert_eq!(observed["session"]["branch"]["side"], true, "{observed}");
        }

        // Presets sweep.
        let presets = call(&client, "agent", "presets", json!({}), Attachments::new()).await;
        let presets_json = serde_json::to_string(&presets).unwrap();
        assert!(
            presets_json.contains(&manifest.preset_id) && presets_json.contains(PRESET_NAME),
            "preset missing after upgrade: {presets}"
        );

        // Persisted operation receipt sweep (application_operations).
        if let Some(op_ref) = &manifest.operation_ref {
            let receipt = call(
                &client,
                "receipts",
                "read",
                op_ref.clone(),
                Attachments::new(),
            )
            .await;
            let receipt_json = serde_json::to_string(&receipt).unwrap();
            assert!(
                receipt_json.contains(&manifest.primary_session_id),
                "persisted application_operations receipt lost across upgrade: {receipt}"
            );
        }

        // Exact personal memory sweep by ID + body (independent of chat Recall passages).
        let memory = call(
            &client,
            "agent",
            "memory",
            json!({"scope": {"kind": "personal"}, "id": manifest.memory_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(
            memory["id"].as_str(),
            Some(manifest.memory_id.as_str()),
            "persisted personal memory id mismatch after upgrade: {memory}"
        );
        assert_eq!(
            memory["body"].as_str(),
            Some(manifest.memory_body.as_str()),
            "persisted personal memory body mismatch after upgrade: {memory}"
        );

        // Recall sweep.
        let pre_recall = recall_search(&client, &manifest.nonce).await;
        let pre_recall_json = serde_json::to_string(&pre_recall).unwrap();
        assert!(
            pre_recall_json.contains(&manifest.nonce),
            "recall did not find pre-upgrade content: {pre_recall}"
        );

        // Portable checkpoint open sweep.
        let open_dir = work_tmp.path().join("opened-checkpoint");
        let open_out = build_command(bin, &dirs)
            .args(["checkpoint", "open"])
            .arg(capsule_dir.join(&manifest.portable_archive))
            .arg("--output")
            .arg(&open_dir)
            .output()
            .await
            .unwrap();
        assert!(
            open_out.status.success(),
            "maka checkpoint open failed on old archive: {}",
            String::from_utf8_lossy(&open_out.stderr)
        );

        // Stage 3: Live continuation on upgraded State Root.
        let lang_updated = call(
            &client,
            "settings",
            "updateAssistantPreferences",
            json!({
                "expectedRevision": prefs["revision"],
                "mutation": {
                    "kind": "language",
                    "preference": "zh-HK"
                }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(lang_updated["kind"], "committed", "{lang_updated}");
        let prefs_after = call(
            &client,
            "settings",
            "assistantPreferences",
            json!({}),
            Attachments::new(),
        )
        .await;
        assert_eq!(prefs_after["language"], "zh-HK", "{prefs_after}");
        assert_eq!(prefs_after["resolvedLanguage"], "zh-HK", "{prefs_after}");

        let updated_conn = call(
            &client,
            "settings",
            "update",
            json!({
                "expected": {
                    "connectionId": detail["target"]["connectionId"],
                    "revision": detail["target"]["revision"]
                },
                "changes": {
                    "configuration": { "baseUrl": new_base_url }
                }
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(updated_conn["kind"], "committed", "{updated_conn}");

        let enabled = call(
            &client,
            "settings",
            "updateAssistantPreferences",
            json!({
                "expectedRevision": prefs_after["revision"],
                "mutation": {"kind": "memory", "value": {"enabled": true, "agentReadEnabled": true}}
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(enabled["kind"], "committed", "{enabled}");
        let pin = call(
            &client,
            "agent",
            "changeMemory",
            json!({
                "scope": {"kind": "personal"},
                "edit": {"kind": "set_always", "id": manifest.memory_id,
                    "expectedRevision": memory["revision"], "always": true}
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(pin["kind"], "saved", "{pin}");
        let pinned = call(
            &client,
            "agent",
            "memory",
            json!({"scope": {"kind": "personal"}, "id": manifest.memory_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(pinned["mode"], "user_always", "{pinned}");
        assert_eq!(pinned["assertion"], memory["assertion"]);
        assert_eq!(pinned["revision"], pin["revision"]);

        let observed = call(
            &client,
            "agent",
            "observe",
            json!({"sessionId": manifest.primary_session_id}),
            Attachments::new(),
        )
        .await;
        let original = call(
            &client,
            "agent",
            "loadedMemories",
            json!({"sessionId": manifest.primary_session_id, "runId": observed["latestRunId"].as_str().unwrap()}),
            Attachments::new(),
        )
        .await;
        assert_eq!(original, json!([]), "later pin changed historical Run admission");

        let followup = call(
            &client,
            "agent",
            "submitMessage",
            json!({
                "sessionId": manifest.primary_session_id,
                "message": format!("Continue upgraded session {post_nonce}."),
                "idempotencyKey": post_nonce
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(followup["kind"], "queued", "{followup}");
        let continuation_run_id = wait_run_completed(
            &client,
            &manifest.primary_session_id,
            followup["messageId"].as_str().unwrap(),
        )
        .await;
        let loaded = call(
            &client,
            "agent",
            "loadedMemories",
            json!({"sessionId": manifest.primary_session_id, "runId": continuation_run_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(loaded, json!([]), "tool-restricted session loaded a pin");
        let continuation_run_id = continuation_run_id
            .as_str()
            .expect("wait_run_completed must return continuation runId")
            .to_owned();
        assert!(
            saw_pre_context.load(Ordering::SeqCst),
            "post-upgrade model request did not retain pre-upgrade conversation context"
        );
        assert!(
            saw_session_data.load(Ordering::SeqCst),
            "post-upgrade Code Mode cell did not observe pre-upgrade SessionData"
        );

        let destination = dirs.workspace.join("post-upgrade-workspace");
        fs::create_dir_all(&destination).unwrap();
        let observed = call(
            &client,
            "agent",
            "observe",
            json!({"sessionId": manifest.primary_session_id}),
            Attachments::new(),
        )
        .await;
        let rebound = call(
            &client,
            "agent",
            "changeSessionWorkspace",
            json!({
                "sessionId": manifest.primary_session_id,
                "expectedRevision": observed["session"]["revision"],
                "path": destination,
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(rebound["kind"], "changed", "{rebound}");

        // Exercise real project MCP consent proposal + Settings decision on the upgraded Host.
        let mcp_dir = destination.join(".maka");
        fs::create_dir_all(&mcp_dir).unwrap();
        fs::write(
            mcp_dir.join("mcp.json"),
            r#"{"mcpServers":{"compat-demo":{"command":"echo","args":["ok"],"disabled":true}}}"#,
        )
        .unwrap();
        let rebound_observed = call(
            &client,
            "agent",
            "observe",
            json!({"sessionId": manifest.primary_session_id}),
            Attachments::new(),
        )
        .await;
        let project_view = call(
            &client,
            "agent",
            "projectMcp",
            json!({"sessionId": manifest.primary_session_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(project_view["kind"], "configuration", "{project_view}");
        assert_eq!(project_view["trusted"], false, "{project_view}");
        assert_eq!(project_view["declined"], false, "{project_view}");
        let project_revision = project_view["revision"].as_str().unwrap().to_owned();
        let saved_trust = call(
            &client,
            "agent",
            "setProjectMcpDecision",
            json!({
                "workspace": rebound_observed["session"]["workspace"],
                "revision": project_revision,
                "decision": "trusted",
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(saved_trust["kind"], "saved", "{saved_trust}");
        let trusted_view = call(
            &client,
            "agent",
            "projectMcp",
            json!({"sessionId": manifest.primary_session_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(trusted_view["trusted"], true, "{trusted_view}");
        assert_eq!(trusted_view["declined"], false, "{trusted_view}");
        let saved_decline = call(
            &client,
            "agent",
            "setProjectMcpDecision",
            json!({
                "workspace": rebound_observed["session"]["workspace"],
                "revision": project_revision,
                "decision": "declined",
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(saved_decline["kind"], "saved", "{saved_decline}");
        let declined_view = call(
            &client,
            "agent",
            "projectMcp",
            json!({"sessionId": manifest.primary_session_id}),
            Attachments::new(),
        )
        .await;
        assert_eq!(declined_view["trusted"], false, "{declined_view}");
        assert_eq!(declined_view["declined"], true, "{declined_view}");

        let room_post = call(
            &client,
            "agent",
            "send",
            json!({
                "sessionId": manifest.room_id,
                "message": format!("compat-room-post-{post_nonce}")
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(room_post["kind"], "posted", "{room_post}");

        let room_hist = call(
            &client,
            "agent",
            "history",
            json!({
                "sessionId": manifest.room_id,
                "position": {"kind": "tail"}
            }),
            Attachments::new(),
        )
        .await;
        let room_hist_str = serde_json::to_string(&room_hist).unwrap();
        assert!(
            room_hist_str.contains(&manifest.room_pre_message)
                && room_hist_str.contains(&format!("compat-room-post-{post_nonce}")),
            "upgraded Room history missing pre or post message: {room_hist}"
        );

        let post_recall = recall_search(&client, &post_nonce).await;
        assert!(
            serde_json::to_string(&post_recall)
                .unwrap()
                .contains(&post_nonce),
            "recall did not index post-upgrade continuation: {post_recall}"
        );

        host.quit(&mut client).await.expect("Host quit");

        // Verify the exact post-upgrade continuation run newly inserted PR 5 zstd-compressed
        // contents rows (id > pre_upgrade_max_content_id), wrote PR 6 out-of-line toolContracts,
        // and emitted PR 8 Layout v3 FrozenInput payloads after upgrading legacy v2 capsules.
        {
            let mut dbs = Vec::new();
            collect_sqlite_files(&dirs.root, &mut dbs);
            let mut matched_continuation_run = false;
            let mut saw_newly_inserted_compressed = false;
            let mut saw_compact_request_spec = false;
            let mut saw_layout_v3_request = false;
            for db in dbs {
                let conn =
                    Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                maka_event_log::content::register_sql_functions(&conn).unwrap();
                let has_req: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_request_specs')",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                if !has_req {
                    continue;
                }
                let has_run: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM agent_run_specs WHERE run = ?1)",
                        [&continuation_run_id],
                        |r| r.get(0),
                    )
                    .unwrap();
                if !has_run {
                    continue;
                }
                matched_continuation_run = true;
                let max_id_before = pre_upgrade_max_content_id.get(&db).copied().unwrap_or(0);
                let newly_compressed: i64 = conn
                    .query_row(
                        "SELECT COUNT(*)
                         FROM agent_content_pins p
                         JOIN contents c ON c.id = p.content_id
                         WHERE p.run = ?1
                           AND c.id > ?2
                           AND c.encoding IN (1, 2, 3)
                           AND c.logical_bytes IS NOT NULL",
                        rusqlite::params![&continuation_run_id, max_id_before],
                        |r| r.get(0),
                    )
                    .unwrap();
                if newly_compressed > 0 {
                    saw_newly_inserted_compressed = true;
                }
                let mut stmt = conn
                    .prepare(
                        "SELECT maka_content_text(c.payload, c.encoding)
                         FROM agent_request_specs r
                         JOIN contents c ON c.id = r.content_id
                         WHERE r.run = ?1",
                    )
                    .unwrap();
                let specs: Vec<String> = stmt
                    .query_map([&continuation_run_id], |r| r.get::<_, String>(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                assert!(
                    !specs.is_empty(),
                    "continuation run {continuation_run_id} must record at least one RequestSpec"
                );
                for raw in specs {
                    let parsed: Value = serde_json::from_str(&raw).unwrap();
                    if parsed
                        .get("toolContracts")
                        .and_then(|v| v.get("digest"))
                        .is_some()
                    {
                        saw_compact_request_spec = true;
                    }
                    let req_digest = parsed
                        .get("request")
                        .and_then(|v| v.get("digest"))
                        .and_then(Value::as_str)
                        .expect("RequestSpec.request.digest must be present");
                    let frozen_raw: String = conn
                        .query_row(
                            "SELECT maka_content_text(payload, encoding)
                             FROM contents
                             WHERE content_sha256 = ?1",
                            [req_digest],
                            |r| r.get(0),
                        )
                        .unwrap();
                    let frozen: Value = serde_json::from_str(&frozen_raw).unwrap();
                    let layout_version = frozen
                        .get("layout")
                        .and_then(|v| v.get("version"))
                        .and_then(Value::as_u64);
                    assert_eq!(
                        layout_version,
                        Some(3),
                        "post-upgrade continuation run {continuation_run_id} must emit Layout v3 FrozenInput"
                    );
                    saw_layout_v3_request = true;
                }
            }
            assert!(
                matched_continuation_run,
                "could not locate post-upgrade continuation run {continuation_run_id}"
            );
            assert!(
                saw_newly_inserted_compressed,
                "post-upgrade continuation run {continuation_run_id} must newly insert zstd-compressed contents blobs"
            );
            assert!(
                saw_compact_request_spec,
                "post-upgrade continuation run {continuation_run_id} must write out-of-line RequestSpec.toolContracts"
            );
            assert!(
                saw_layout_v3_request,
                "post-upgrade continuation run {continuation_run_id} must record at least one Layout v3 FrozenInput"
            );
        }

        // Cold startup preserves historical device rows but must prune
        // invitations for a publication this Host is not serving.
        let settings = open_compat_settings(&dirs.root).await;
        use maka_config::remote_access::RelayAuthUpdate;
        let config = settings.remote_access_config().await.unwrap();
        assert!(!config.enabled);
        if manifest.remote_relay_configured {
            assert!(config.relays[0].has_auth_token);
            assert_eq!(config.relays[0].endpoint.quic_port, Some(8443));
            let transport = settings.remote_transport().await.unwrap();
            assert!(transport.relays[0].auth_token.as_deref() == Some(COMPAT_RELAY_TOKEN));
        } else {
            assert!(config.relays.is_empty());
        }
        save_compat_relay(&settings, RelayAuthUpdate::Clear).await;
        assert!(!settings.remote_access_config().await.unwrap().relays[0].has_auth_token);

        let peer = PeerId::new(
            manifest
                .host_peer_id
                .clone()
                .unwrap_or_else(|| format!("compat-peer-{post_nonce}")),
        )
        .unwrap();
        let granted = settings
            .has_host_peer_access(peer.clone(), COMPAT_PEER_GRANT.into())
            .await
            .unwrap();
        assert_eq!(granted, manifest.host_peer_id.is_some());
        if granted {
            let devices = settings.list_host_peer_access().await.unwrap();
            let device = devices.iter().find(|device| device.peer_id == peer.as_str()).unwrap();
            assert!(device.label.is_empty() && device.created_at.is_empty());
            assert!(settings.revoke_host_peer_access(peer.clone()).await.unwrap());
        }
        let redeem = async |settings: &ConfigurationStore| {
                settings
                    .redeem_host_peer_pairing_invite(
                        COMPAT_PAIRING_HASH,
                        peer.clone(),
                        COMPAT_PEER_GRANT.into(),
                        None,
                    )
                    .await
                    .unwrap()
        };
        if manifest.host_pairing_invite {
            assert!(!redeem(&settings).await, "cold startup kept a foreign-grant invitation");
        }
        seed_pairing_invite(&settings).await;
        assert!(redeem(&settings).await);
        settings.close().await.unwrap();
        let settings = open_compat_settings(&dirs.root).await;
        assert!(!redeem(&settings).await, "reopen revived a consumed invitation");
        let devices = settings.list_host_peer_access().await.unwrap();
        let device = devices.iter().find(|device| device.peer_id == peer.as_str()).unwrap();
        assert_eq!(device.grant, COMPAT_PEER_GRANT);
        assert_eq!(device.label, "Compat device");
        assert!(!device.created_at.is_empty());
        assert_eq!(device.last_active_at.as_deref(), Some(device.created_at.as_str()));
        assert!(settings.revoke_host_peer_access(peer).await.unwrap());
        if manifest.project_mcp_trusted {
            assert_eq!(
                settings
                    .project_mcp_decision(
                        COMPAT_MCP_OWNER.into(),
                        COMPAT_MCP_WORKSPACE.into(),
                        COMPAT_MCP_REVISION.into(),
                    )
                    .await
                    .unwrap(),
                Some(maka_config::ProjectMcpDecision::Trusted)
            );
            assert!(
                settings
                    .advance_project_mcp_trust(
                        COMPAT_MCP_OWNER.into(),
                        COMPAT_MCP_WORKSPACE.into(),
                        COMPAT_MCP_REVISION.into(),
                        COMPAT_MCP_NEXT_REVISION.into(),
                    )
                    .await
                    .unwrap()
            );
            assert_eq!(
                settings
                    .project_mcp_decision(
                        COMPAT_MCP_OWNER.into(),
                        COMPAT_MCP_WORKSPACE.into(),
                        COMPAT_MCP_NEXT_REVISION.into(),
                    )
                    .await
                    .unwrap(),
                Some(maka_config::ProjectMcpDecision::Trusted)
            );
        }
        settings
            .decline_project_mcp(
                COMPAT_MCP_OWNER.into(),
                COMPAT_MCP_WORKSPACE.into(),
                COMPAT_MCP_REVISION.into(),
            )
            .await
            .unwrap();
        settings.close().await.unwrap();
        let settings = open_compat_settings(&dirs.root).await;
        assert_eq!(
            settings
                .project_mcp_decision(
                    COMPAT_MCP_OWNER.into(),
                    COMPAT_MCP_WORKSPACE.into(),
                    COMPAT_MCP_REVISION.into(),
                )
                .await
                .unwrap(),
            Some(maka_config::ProjectMcpDecision::Declined)
        );
        assert_eq!(
            settings
                .project_mcp_decision(
                    COMPAT_MCP_OWNER.into(),
                    COMPAT_MCP_WORKSPACE.into(),
                    COMPAT_MCP_NEXT_REVISION.into(),
                )
                .await
                .unwrap(),
            None
        );
        settings.close().await.unwrap();

        // Online checkpoint re-export & open sweep on the upgraded live Root
        // (proves checkpoint heads and objects survived upgrade, not only the pre-upgrade tarball).
        let live_export = work_tmp.path().join("upgraded-checkpoint.tar.gz");
        let live_export_out = build_command(bin, &dirs)
            .args(["checkpoint", "export", "--root"])
            .arg(&dirs.root)
            .args([
                "--session",
                &manifest.primary_session_id,
                "--revision",
                manifest.checkpoint_revision.as_str().unwrap(),
                "--output",
            ])
            .arg(&live_export)
            .output()
            .await
            .unwrap();
        assert!(
            live_export_out.status.success(),
            "maka checkpoint export failed on upgraded Root: {}",
            String::from_utf8_lossy(&live_export_out.stderr)
        );
        let live_open_dir = work_tmp.path().join("opened-upgraded-checkpoint");
        let live_open_out = build_command(bin, &dirs)
            .args(["checkpoint", "open"])
            .arg(&live_export)
            .arg("--output")
            .arg(&live_open_dir)
            .output()
            .await
            .unwrap();
        assert!(
            live_open_out.status.success(),
            "maka checkpoint open failed on post-upgrade export: {}",
            String::from_utf8_lossy(&live_open_out.stderr)
        );

        // Canonical event log CLI inspect sweep.
        let inspect_out = build_command(bin, &dirs)
            .args(["inspect", "--root"])
            .arg(&dirs.root)
            .args(["--session", &manifest.primary_session_id])
            .output()
            .await
            .unwrap();
        assert!(
            inspect_out.status.success(),
            "maka inspect failed on upgraded Root: {}",
            String::from_utf8_lossy(&inspect_out.stderr)
        );
        let inspected: Value = serde_json::from_slice(&inspect_out.stdout).unwrap();
        assert!(!inspected["facts"].as_array().unwrap().is_empty());

        if let Some(execution) = &manifest.execution_authority {
            execution_compat::verify(capsule_dir, execution).await;
        }

        // Post-upgrade SQLite integrity and monotonic migration check.
        let upgraded_migrations = verify_sqlite_integrity_and_migrations(&dirs.root);
        for (db, prev_versions) in &manifest.migrations {
            let now_versions = upgraded_migrations
                .get(db)
                .unwrap_or_else(|| panic!("database {db} missing after upgrade"));
            assert!(
                prev_versions.iter().all(|v| now_versions.contains(v)),
                "database {db} lost previously applied migrations: before={prev_versions:?}, after={now_versions:?}"
            );
        }
    })
    .catch_unwind()
    .await;

    let cleanup = host.cleanup().await;

    match outcome {
        Ok(()) => {
            server.shutdown().await;
            cleanup.expect("Host cleanup");
        }
        Err(panic) => {
            let _ = server.shutdown_taking_panics().await;
            std::panic::resume_unwind(panic);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgrade_compat_capsule_roundtrip() {
    let bin = maka_binary();
    if let Some(out_dir) = std::env::var_os(PRODUCE_ENV) {
        let manifest = produce_capsule(&bin, Path::new(&out_dir)).await;
        eprintln!(
            "Produced compat capsule ({}, {} DB ledger(s)) at {}",
            manifest.maka_version,
            manifest.migrations.len(),
            Path::new(&out_dir).display()
        );
        return;
    }
    if let Some(in_dir) = std::env::var_os(VERIFY_ENV) {
        verify_capsule(&bin, Path::new(&in_dir)).await;
        eprintln!(
            "Verified compat capsule at {} with {}",
            Path::new(&in_dir).display(),
            bin.display()
        );
        return;
    }

    // Default self-check mode: produce a capsule and verify upgrading a copy of it.
    let capsule_tmp = tempfile::tempdir().unwrap();
    let _manifest = produce_capsule(&bin, capsule_tmp.path()).await;
    verify_capsule(&bin, capsule_tmp.path()).await;
}
