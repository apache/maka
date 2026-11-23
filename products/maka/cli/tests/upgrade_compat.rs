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

#[path = "support/host.rs"]
mod host;

use futures_util::FutureExt;
use host::Host;
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::{host::Client, transport::Reply};
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, MockAiBuilder, MockAiServer, ModelEntry, NormalizedRequest,
    Protocol, TurnContext, TurnPlan, Usage,
};
use maka_plugin_core::{
    contract::ResourceType,
    operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt},
};
use rusqlite::Connection;
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
    forked_session_id: String,
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
    migrations: BTreeMap<String, Vec<i64>>,
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
            "send",
            json!({
                "sessionId": primary_session_id,
                "message": format!("Run pre-upgrade verification {nonce}."),
                "attachments": [attachment_id],
                "delivery": "queue"
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

        host.quit(&mut client).await.expect("Host quit");

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
            forked_session_id,
            room_id,
            room_pre_message,
            preset_id,
            memory_id,
            memory_body,
            checkpoint_revision,
            portable_archive: portable_archive_name,
            session_data_key: "compat_capsule_state".into(),
            operation_ref,
            migrations,
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
            let _ = server.take_panics();
            server.shutdown().await;
            std::panic::resume_unwind(panic);
        }
    };
    fs::write(
        capsule_dir.join("capsule-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    manifest
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
    let canonical_base = fs::canonicalize(capsule_dir).unwrap();
    let dirs = EnvDirs::in_base(&canonical_base);
    dirs.prepare();

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

    // Stage 1: Cold startup & in-place schema/data migrations.
    let mut host = Host::spawn_with(bin, &dirs.root, &dirs.home, &dirs.workspace)
        .unwrap_or_else(|e| panic!("spawn Host {}: {e}", bin.display()));
    let outcome = AssertUnwindSafe(async {
        let (mut client, _) = host.ready().await.expect("Host ready");

        // Stage 2: Exhaustive read/deserialization sweep across every persisted domain.
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

        let followup = call(
            &client,
            "agent",
            "send",
            json!({
                "sessionId": manifest.primary_session_id,
                "message": format!("Continue upgraded session {post_nonce}."),
                "delivery": "queue"
            }),
            Attachments::new(),
        )
        .await;
        assert_eq!(followup["kind"], "queued", "{followup}");
        wait_run_completed(
            &client,
            &manifest.primary_session_id,
            followup["messageId"].as_str().unwrap(),
        )
        .await;
        assert!(
            saw_pre_context.load(Ordering::SeqCst),
            "post-upgrade model request did not retain pre-upgrade conversation context"
        );
        assert!(
            saw_session_data.load(Ordering::SeqCst),
            "post-upgrade Code Mode cell did not observe pre-upgrade SessionData"
        );

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
            let _ = server.take_panics();
            server.shutdown().await;
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
