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

//! Records raw frames from a real Runtime Host as golden fixtures for
//! `host-protocol`'s and `transcript-model`'s tests.
//!
//! ```sh
//! cargo run -p host-client --example capture_fixtures -- \
//!     --root .dev-root --out crates/host-protocol/fixtures \
//!     [--create-session /private/tmp/maka-gpui-fixture-workspace] \
//!     [--sequences /private/tmp/maka-gpui-fixture-workspace [--only NAME[,NAME…]]] \
//!     [--connection-slug SLUG --model MODEL_ID] \
//!     [--onboarding BASE_URL [--onboarding-key KEY]] \
//!     [--task-actions /private/tmp/maka-gpui-fixture-workspace] \
//!     [--long-history /private/tmp/maka-gpui-fixture-workspace]
//! ```
//!
//! `--connection-slug` and `--model` must be given together; they select an
//! explicit `modelTarget` (looked up from `connection.catalog.query` by
//! `slug`) instead of the catalog default, for Hosts whose default connection
//! cannot answer.
//!
//! It speaks the protocol over its own socket with only the framing codec,
//! not `Connection`, so each fixture is exactly the frame the Host sent
//! (pretty-printed, key order preserved). `--create-session` first creates one
//! Session in that directory so the catalog fixture holds a real projection;
//! use it only against a development State Root.
//!
//! `--sequences` runs Turn scenarios, each in a new Session in that
//! directory, and writes `sequences/<name>.jsonl`: every frame of the
//! scenario in wire order, one compact JSON object per line, client requests
//! included. The scenario answers permission prompts, stops Turns, and reads
//! the durable transcript after every `subscription.transcript_advanced` the
//! way the Desktop does. A scenario whose Turn does not end the way the
//! scenario expects is reported and not written. See [`SCENARIOS`].
//!
//! `--onboarding` records the connection effects the settings dialog's
//! Connections section uses against an OpenAI-compatible endpoint (a local
//! Ollama at `http://127.0.0.1:11434/v1` works, key `ollama`):
//! `connection.onboarding.verify` (verified, and rejected with `slug_taken`),
//! `connection.onboarding.save`, `connection.catalog.update` (a rename, and a
//! stale revision), `connection.catalog.set-default-target` (committed at the
//! current default, and a revision conflict), and `connection.catalog.remove`
//! of the saved connection, so the catalog ends as it started.
//!
//! `--task-actions` records the commands of the sidebar's task menu and
//! the project picker on a scratch Session it creates in that directory:
//! `session.metadata.update` (a rename, then a stale revision),
//! `session.lifecycle.set` (archived), `session.remove.preview`, and
//! `session.remove` (a stale revision, then the removal, so the catalog
//! ends as it started), plus `project.catalog.mutate` `register` of the
//! directory (idempotent for a registered one) and `project.catalog.query`
//! in the `locations` view.
//!
//! `--sequences <dir> --only-sequence <name>` records that one scenario and
//! writes only `sequences/<name>.jsonl`, leaving every other fixture
//! untouched; `reasoning` needs a model that streams reasoning,
//! `message_queue` records `turn.message.submit` and the `queue.*` commands
//! (see [`record_message_queue`]), and `attachment_ingest` records
//! `artifact.ingest` (see [`record_attachment_ingest`]).
//!
//! `--long-history` is a mode of its own: it writes only
//! `sequences/long_history.jsonl` and leaves every other fixture untouched.
//! It creates a Session in that directory and runs [`LONG_HISTORY_TURNS`]
//! Turns with long prompts on one connection, so the durable transcript
//! outgrows the 16 KiB tail `subscription.open` returns. Then, recording on a
//! second connection, it opens the Session with that tail and reads older
//! pages of [`LONG_HISTORY_PAGE_BYTES`] with each page's cursor until the
//! Host reports the start (`nextCursor: null`), as the Desktop's
//! `readOlderPage` does (apps/desktop/src/main/desktop-transcript-replica.ts).
//! The pages are smaller than a prompt row on purpose, so rows split across
//! pages.
//!
//! Every run also records `runtime.policy.query` and `runtime.policy.mutate`
//! (the chat defaults written back unchanged, then a revision conflict). The key travels only in
//! requests, which are not written.
//!
//! Fixtures contain Host epochs, connection ids, and the socket path. They
//! must never contain credentials; the tool refuses to write a frame that
//! mentions a credential-looking key or an `sk-` token, and masks the
//! `****abcd` key suffixes provider error messages quote (same length, so
//! transcript byte counts stay valid).
//!
//! A development tool: it uses blocking std I/O throughout.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use host_client::{discover_host, random_client_instance_id};
use host_protocol::{
    ClientHello, ConnectionCatalogItem, ConnectionCatalogQueryInput, ConnectionCatalogQueryResult,
    FrameDecoder, RUNTIME_HOST_COMPATIBILITY_EPOCH, RequestFrame, decode_frame_json, encode_frame,
};
use serde_json::{Value, json};

const IO_TIMEOUT: Duration = Duration::from_secs(15);
/// Budget for one scenario, from `turn.start` to the settled transcript.
const SCENARIO_TIMEOUT: Duration = Duration::from_secs(180);
/// Quiet time after a scenario settles, to catch trailing frames.
const SETTLE_QUIET: Duration = Duration::from_millis(1500);
const TRANSCRIPT_TAIL_BYTES: u64 = 16 * 1024;
const TRANSCRIPT_PAGE_BYTES: u64 = 512 * 1024;
/// Turns of the `--long-history` Session.
const LONG_HISTORY_TURNS: usize = 5;
/// Numbered lines in each `--long-history` prompt: about 5 KiB of text, so
/// five Turns outgrow the 16 KiB tail.
const LONG_HISTORY_PROMPT_LINES: usize = 64;
/// `maxBytes` of each older page `--long-history` reads.
const LONG_HISTORY_PAGE_BYTES: u64 = 4 * 1024;
/// Budget for one `--long-history` Turn.
const LONG_HISTORY_TURN_TIMEOUT: Duration = Duration::from_secs(300);

fn main() -> Result<()> {
    let args = Args::parse()?;
    let host = futures_lite::future::block_on(discover_host(&args.root))
        .context("no running Runtime Host for --root")?;
    let endpoint = host.registration.endpoint.clone();
    let mut fixtures = BTreeMap::new();

    let registration_bytes = fs::read(host.control_directory.join(host_client::REGISTRATION_FILE))?;
    fixtures.insert("registration.json", serde_json::from_slice(&registration_bytes)?);

    // An accepted connection.
    let mut wire = Wire::connect(&endpoint)?;
    let hello = serde_json::to_value(ClientHello::new(random_client_instance_id()))?;
    wire.send(&hello)?;
    fixtures.insert("hello.json", hello);
    let accepted = wire.next_frame()?;
    ensure!(accepted["kind"] == "accepted", "handshake was not accepted: {accepted}");
    fixtures.insert("accepted.json", accepted);

    let (status, _) = wire.request("host.status", json!({}))?;
    fixtures.insert("host_status.response.json", status);

    let model_target = resolve_model_target(&mut wire, &args)?;

    if let (Some(name), Some(workspace)) = (&args.only_sequence, &args.sequences)
        && (name == MESSAGE_QUEUE || name == ATTACHMENT_INGEST)
    {
        let mut frames = if name == MESSAGE_QUEUE {
            record_message_queue(&endpoint, workspace, &model_target)?
        } else {
            record_attachment_ingest(&endpoint, workspace, &model_target)?
        };
        let directory = args.out.join("sequences");
        fs::create_dir_all(&directory)?;
        let mut text = String::new();
        for frame in &mut frames {
            sanitize(name, frame)?;
            text.push_str(&serde_json::to_string(frame)?);
            text.push('\n');
        }
        let path = directory.join(format!("{name}.jsonl"));
        fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        println!("wrote {}", path.display());
        return Ok(());
    }

    if let (Some(name), Some(workspace)) = (&args.only_sequence, &args.sequences) {
        let scenario = SCENARIOS
            .iter()
            .find(|scenario| scenario.name == name)
            .with_context(|| format!("unknown scenario {name:?}"))?;
        fs::create_dir_all(workspace)?;
        let mut outcome = run_scenario(&endpoint, workspace, scenario, &model_target)?;
        if let Err(reason) = scenario.check(&outcome) {
            bail!("scenario {name} not written: {reason}");
        }
        println!("scenario {name}: {} (session {})", outcome.summary(), outcome.session_id);
        let directory = args.out.join("sequences");
        fs::create_dir_all(&directory)?;
        let mut text = String::new();
        for frame in &mut outcome.frames {
            sanitize(name, frame)?;
            text.push_str(&serde_json::to_string(frame)?);
            text.push('\n');
        }
        let path = directory.join(format!("{name}.jsonl"));
        fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        println!("wrote {}", path.display());
        return Ok(());
    }

    if let Some(workspace) = &args.long_history {
        let mut frames = record_long_history(&endpoint, workspace, &model_target)?;
        let directory = args.out.join("sequences");
        fs::create_dir_all(&directory)?;
        let mut text = String::new();
        for frame in &mut frames {
            sanitize("long_history", frame)?;
            text.push_str(&serde_json::to_string(frame)?);
            text.push('\n');
        }
        let path = directory.join("long_history.jsonl");
        fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        println!("wrote {}", path.display());
        return Ok(());
    }

    if let Some(workspace) = &args.create_session {
        fs::create_dir_all(workspace)?;
        let session_id = format!("fixture-{}", uuid_simple());
        let (created, pushes) = wire.request(
            "session.create",
            json!({
                "sessionId": session_id,
                "workspace": {"kind": "host_path", "path": workspace},
                "modelTarget": model_target,
                "name": "Fixture session"
            }),
        )?;
        ensure!(created["ok"] == true, "session.create failed: {created}");
        fixtures.insert("session_create.response.json", created);
        let (get, _) =
            wire.request("session.catalog.query", json!({"kind": "get", "sessionId": session_id}))?;
        fixtures.insert("session_catalog_query.get.response.json", get);
        let changed =
            match pushes.into_iter().find(|frame| frame["kind"] == "session.catalog.changed") {
                Some(frame) => Some(frame),
                None => wire.next_push_within(Duration::from_secs(2))?,
            };
        if let Some(changed) = changed {
            fixtures.insert("session_catalog_changed.push.json", changed);
        }
    }

    let (page, _) = wire.request("session.catalog.query", json!({"kind": "list_start"}))?;
    fixtures.insert("session_catalog_query.page.response.json", page);
    let (connections, _) = wire.request("connection.catalog.query", json!({"kind": "start"}))?;
    fixtures.insert("connection_catalog_query.response.json", connections);
    let (projects, _) =
        wire.request("project.catalog.query", json!({"kind": "list_start", "view": "summary"}))?;
    fixtures.insert("project_catalog_query.response.json", projects);
    record_runtime_policy(&mut wire, &mut fixtures)?;

    if let Some(base_url) = &args.onboarding {
        record_onboarding(&mut wire, base_url, &args.onboarding_key, &mut fixtures)?;
    }
    if let Some(workspace) = &args.task_actions {
        record_task_actions(&mut wire, workspace, &model_target, &mut fixtures)?;
    }

    // A hello from the previous epoch shows the incompatible answer.
    let mut stale = Wire::connect(&endpoint)?;
    let mut stale_hello = serde_json::to_value(ClientHello::new(random_client_instance_id()))?;
    stale_hello["compatibilityEpoch"] = json!(RUNTIME_HOST_COMPATIBILITY_EPOCH - 1);
    stale.send(&stale_hello)?;
    let incompatible = stale.next_frame()?;
    ensure!(incompatible["kind"] == "incompatible", "expected incompatible: {incompatible}");
    fixtures.insert("incompatible.json", incompatible);

    let mut sequences = BTreeMap::new();
    let mut recorded_sessions = Vec::new();
    let mut failures = Vec::new();
    if let Some(workspace) = &args.sequences {
        fs::create_dir_all(workspace)?;
        for scenario in SCENARIOS.iter().filter(|scenario| args.selects(scenario.name)) {
            println!("scenario {} …", scenario.name);
            let outcome = run_scenario(&endpoint, workspace, scenario, &model_target)
                .with_context(|| format!("scenario {}", scenario.name))?;
            match scenario.check(&outcome) {
                Ok(()) => {
                    println!("scenario {}: {}", scenario.name, outcome.summary());
                    recorded_sessions.push(outcome.session_id);
                    sequences.insert(scenario.name, outcome.frames);
                }
                Err(reason) => {
                    eprintln!("scenario {} not written: {reason}", scenario.name);
                    failures.push(scenario.name);
                }
            }
        }
        // The `subscription.open` fixture: a Session with a finished Turn, so
        // the answer carries a non-empty transcript tail.
        if let Some(session_id) = recorded_sessions.first() {
            let (open, _) = wire.request(
                "subscription.open",
                json!({"sessionId": session_id,
                       "transcript": {"kind": "tail", "maxBytes": TRANSCRIPT_TAIL_BYTES}}),
            )?;
            ensure!(open["ok"] == true, "subscription.open failed: {open}");
            let subscription_id = open["result"]["subscriptionId"].clone();
            fixtures.insert("subscription_open.response.json", open);
            wire.request("subscription.close", json!({"subscriptionId": subscription_id}))?;
        }
    }

    fs::create_dir_all(&args.out)?;
    for (name, value) in &mut fixtures {
        sanitize(name, value)?;
        let path = args.out.join(name);
        let mut text = serde_json::to_string_pretty(value)?;
        text.push('\n');
        fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        println!("wrote {}", path.display());
    }
    if !sequences.is_empty() {
        let directory = args.out.join("sequences");
        fs::create_dir_all(&directory)?;
        for (name, frames) in &mut sequences {
            let mut text = String::new();
            for frame in frames.iter_mut() {
                sanitize(name, frame)?;
                text.push_str(&serde_json::to_string(frame)?);
                text.push('\n');
            }
            let path = directory.join(format!("{name}.jsonl"));
            fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
            println!("wrote {}", path.display());
        }
    }
    ensure!(failures.is_empty(), "scenarios not recorded: {}", failures.join(", "));
    Ok(())
}

/// When to send `turn.stop`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum StopAt {
    Never,
    /// Right after `turn.start` answers, before any output.
    AfterStart,
    /// When the first assistant text delta arrives.
    FirstDelta,
}

/// How the scenario's Turn must end for the recording to be kept.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
    Completed,
    CompletedAfterPermission,
    CancelledAfterOutput,
    Cancelled,
    Failed,
    /// Completed with at least one reasoning (`thinking`) delta.
    CompletedWithReasoning,
}

struct Scenario {
    name: &'static str,
    prompt: &'static str,
    permission_mode: &'static str,
    stop: StopAt,
    expect: Expect,
}

/// The recorded scenarios. The first three are the Phase 1 acceptance
/// sequences and need a working model connection; the last two also record
/// against a connection that cannot answer.
const SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "plain_text",
        prompt: "Reply with exactly this sentence and nothing else: Hello from the fixture.",
        permission_mode: "ask",
        stop: StopAt::Never,
        expect: Expect::Completed,
    },
    Scenario {
        name: "permission_allow",
        prompt: "You must call the Bash tool now with the command \
                 `mkdir -p ~/maka-gpui-outside-probe && date > \
                 ~/maka-gpui-outside-probe/probe.txt`. Do not answer from memory \
                 and do not describe what you would do: emit the tool call first. After the \
                 tool result arrives, reply with one sentence saying whether it succeeded.",
        permission_mode: "ask",
        stop: StopAt::Never,
        expect: Expect::CompletedAfterPermission,
    },
    Scenario {
        name: "stop_mid_stream",
        prompt: "Count from 1 to 300, one number per line, with no other text.",
        permission_mode: "ask",
        stop: StopAt::FirstDelta,
        expect: Expect::CancelledAfterOutput,
    },
    Scenario {
        name: "stop_after_start",
        prompt: "Count from 1 to 300, one number per line, with no other text.",
        permission_mode: "ask",
        stop: StopAt::AfterStart,
        expect: Expect::Cancelled,
    },
    Scenario {
        name: "failed_turn",
        prompt: "Reply with exactly the word: hello",
        permission_mode: "ask",
        stop: StopAt::Never,
        expect: Expect::Failed,
    },
    // Needs a model that streams reasoning, for example `qwen3:0.6b` on a
    // local Ollama (`--connection-slug ollama-local --model qwen3:0.6b`).
    Scenario {
        name: "reasoning",
        prompt: "Is 391 a prime number? Think it through, then answer in one sentence.",
        permission_mode: "ask",
        stop: StopAt::Never,
        expect: Expect::CompletedWithReasoning,
    },
];

const DEFAULT_SCENARIOS: &[&str] = &["plain_text", "permission_allow", "stop_mid_stream"];

impl Scenario {
    fn check(&self, outcome: &Outcome) -> Result<(), String> {
        let status = outcome.terminal_status.as_deref().unwrap_or("none");
        let ok = match self.expect {
            Expect::Completed => status == "completed",
            Expect::CompletedAfterPermission => status == "completed" && outcome.answered > 0,
            Expect::CancelledAfterOutput => status == "cancelled" && outcome.deltas > 0,
            Expect::Cancelled => status == "cancelled",
            Expect::Failed => status == "failed",
            Expect::CompletedWithReasoning => status == "completed" && outcome.thinking_deltas > 0,
        };
        if ok { Ok(()) } else { Err(format!("the Turn ended {}", outcome.summary())) }
    }
}

struct Outcome {
    session_id: String,
    frames: Vec<Value>,
    terminal_status: Option<String>,
    failure_class: Option<String>,
    answered: usize,
    deltas: usize,
    thinking_deltas: usize,
}

impl Outcome {
    fn summary(&self) -> String {
        format!(
            "{}{} after {} text deltas, {} reasoning deltas, and {} answered prompts ({} frames)",
            self.terminal_status.as_deref().unwrap_or("without a terminal status"),
            self.failure_class.as_ref().map(|class| format!(" ({class})")).unwrap_or_default(),
            self.deltas,
            self.thinking_deltas,
            self.answered,
            self.frames.len()
        )
    }
}

/// The `--only-sequence` name of [`record_message_queue`].
const MESSAGE_QUEUE: &str = "message_queue";
/// The `--only-sequence` name of [`record_attachment_ingest`].
const ATTACHMENT_INGEST: &str = "attachment_ingest";

/// `--only-sequence attachment_ingest`: uploads a small text file into a new
/// Session with `artifact.ingest` as the Desktop's `ingestAttachment` does
/// (`begin` with size and SHA-256, `chunk` from the offset the Host names,
/// `commit`), then begins the same bytes again under a new upload id (the
/// Host opens a new upload rather than answering `committed`), and opens and
/// aborts a third upload. No Turn runs.
fn record_attachment_ingest(
    endpoint: &str,
    workspace: &Path,
    model_target: &Value,
) -> Result<Vec<Value>> {
    const CONTENT: &[u8] = b"The launch code for the garden gate is PAPAYA-42.\n";
    fs::create_dir_all(workspace)?;
    let mut wire = Wire::connect(endpoint)?;
    wire.send(&serde_json::to_value(ClientHello::new(random_client_instance_id()))?)?;
    let accepted = wire.next_frame()?;
    ensure!(accepted["kind"] == "accepted", "handshake was not accepted: {accepted}");
    wire.recording = Some(Vec::new());
    let session_id = format!("fixture-{}", uuid_simple());
    let (created, _) = wire.request(
        "session.create",
        json!({
            "sessionId": session_id,
            "workspace": {"kind": "host_path", "path": workspace},
            "modelTarget": model_target,
            "name": "Fixture attachment"
        }),
    )?;
    ensure!(created["ok"] == true, "session.create failed: {created}");
    let begin = |upload_id: &str, content: &[u8]| -> Result<Value> {
        Ok(serde_json::to_value(host_protocol::ArtifactIngestInput::begin(
            &session_id,
            upload_id,
            "gate-note.txt",
            "application/octet-stream",
            content,
        ))?)
    };
    let upload_id = uuid_simple();
    let (opened, _) = wire.request("artifact.ingest", begin(&upload_id, CONTENT)?)?;
    ensure!(opened["result"]["kind"] == "upload_opened", "begin did not open: {opened}");
    let mut offset = opened["result"]["nextOffset"].as_u64().context("nextOffset")?;
    while let Some(chunk) =
        host_protocol::ArtifactIngestInput::chunk(&session_id, &upload_id, CONTENT, offset)
    {
        let (accepted, _) = wire.request("artifact.ingest", serde_json::to_value(chunk)?)?;
        ensure!(accepted["result"]["kind"] == "chunk_accepted", "chunk refused: {accepted}");
        offset = accepted["result"]["nextOffset"].as_u64().context("nextOffset")?;
    }
    let commit = host_protocol::ArtifactIngestInput::commit(&session_id, &upload_id);
    let (committed, _) = wire.request("artifact.ingest", serde_json::to_value(commit)?)?;
    ensure!(committed["result"]["kind"] == "committed", "commit failed: {committed}");
    // The same bytes again, under a new upload.
    let (again, _) = wire.request("artifact.ingest", begin(&uuid_simple(), CONTENT)?)?;
    ensure!(again["ok"] == true, "the second begin failed: {again}");
    // An upload opened, then aborted.
    let aborted_id = uuid_simple();
    let (opened, _) = wire.request("artifact.ingest", begin(&aborted_id, b"never sent")?)?;
    ensure!(opened["ok"] == true, "the third begin failed: {opened}");
    let abort = host_protocol::ArtifactIngestInput::abort(&session_id, &aborted_id);
    let (aborted, _) = wire.request("artifact.ingest", serde_json::to_value(abort)?)?;
    ensure!(aborted["ok"] == true, "abort failed: {aborted}");
    println!("attachment ingest: session {session_id}");
    Ok(wire.recording.take().unwrap_or_default())
}

/// `--only-sequence message_queue`: the message queue as the Desktop drives
/// it (`turn.message.submit` with `next_turn`, then the `queue.*` commands).
/// One message starts a Turn; while it runs three more are queued as
/// follow-ups; the third is edited (`queue.entry.update`), the order is
/// changed (`queue.entries.reorder`), the third is promoted to steering
/// (`queue.entry.promote`), and the fourth is retracted
/// (`queue.entry.retract`), so the second runs as the next Turn. The
/// recording ends once the Session is idle with an empty queue and the
/// durable transcript is read to its watermark.
fn record_message_queue(
    endpoint: &str,
    workspace: &Path,
    model_target: &Value,
) -> Result<Vec<Value>> {
    fs::create_dir_all(workspace)?;
    let mut wire = Wire::connect(endpoint)?;
    wire.send(&serde_json::to_value(ClientHello::new(random_client_instance_id()))?)?;
    let accepted = wire.next_frame()?;
    ensure!(accepted["kind"] == "accepted", "handshake was not accepted: {accepted}");
    let host_epoch = accepted["hostEpoch"].as_str().context("hostEpoch")?.to_owned();
    wire.recording = Some(Vec::new());
    let session_id = format!("fixture-{}", uuid_simple());
    let (created, _) = wire.request(
        "session.create",
        json!({
            "sessionId": session_id,
            "workspace": {"kind": "host_path", "path": workspace},
            "modelTarget": model_target,
            "name": "Fixture message queue",
            "permissionMode": "ask"
        }),
    )?;
    ensure!(created["ok"] == true, "session.create failed: {created}");
    let (open, _) = wire.request(
        "subscription.open",
        json!({"sessionId": session_id,
               "transcript": {"kind": "tail", "maxBytes": TRANSCRIPT_TAIL_BYTES}}),
    )?;
    ensure!(open["ok"] == true, "subscription.open failed: {open}");
    let subscription_id = open["result"]["subscriptionId"].as_str().context("id")?.to_owned();
    let mut durable_through = open["result"]["transcript"]["durable"]["throughSequence"].as_u64();
    let (ready, _) =
        wire.request("subscription.ready", json!({"subscriptionId": subscription_id}))?;
    ensure!(ready["ok"] == true, "subscription.ready failed: {ready}");

    let submit = |message_id: &str, text: &str| {
        json!({
            "originHostEpoch": host_epoch, "sessionId": session_id, "messageId": message_id,
            "content": {"text": text}, "placement": "next_turn"
        })
    };
    let (first, second, third, fourth) =
        (uuid_simple(), uuid_simple(), uuid_simple(), uuid_simple());
    let mut pending: BTreeMap<String, String> = BTreeMap::new();
    fn send(
        wire: &mut Wire,
        pending: &mut BTreeMap<String, String>,
        operation: &str,
        input: Value,
    ) -> Result<()> {
        let id = wire.send_request(operation, input)?;
        pending.insert(id, operation.to_owned());
        Ok(())
    }
    send(
        &mut wire,
        &mut pending,
        "turn.message.submit",
        submit(&first, "Count from 1 to 60, one number per line, with no other text."),
    )?;
    // The script, one step per Host answer or projection.
    let mut step = 0;
    let mut entries: Option<(String, String, String)> = None;
    let mut queue_revision = 0;
    let mut watermark: Option<u64> = None;
    let mut page_in_flight = false;
    let mut idle_with_empty_queue = false;
    let deadline = Instant::now() + SCENARIO_TIMEOUT * 2;
    loop {
        let settled = step >= 6
            && idle_with_empty_queue
            && pending.is_empty()
            && watermark.is_none_or(|target| durable_through.is_some_and(|d| d >= target));
        ensure!(Instant::now() < deadline, "the message queue did not settle (step {step})");
        let wait = if settled { SETTLE_QUIET * 2 } else { Duration::from_secs(5) };
        let Some(frame) = wire.next_frame_within(wait)? else {
            if settled {
                break;
            }
            continue;
        };
        if let Some(request_id) = frame.get("requestId").and_then(Value::as_str) {
            let Some(operation) = pending.remove(request_id) else { continue };
            ensure!(frame["ok"] == true, "{operation} failed: {frame}");
            let result = &frame["result"];
            match operation.as_str() {
                "session.transcript.page" => {
                    page_in_flight = false;
                    let target = result["throughSequence"].as_u64();
                    if let Some(cursor) = result["nextCursor"].as_str() {
                        send(
                            &mut wire,
                            &mut pending,
                            "session.transcript.page",
                            json!({
                                "subscriptionId": subscription_id, "direction": "newer",
                                "throughSequence": target, "cursor": cursor,
                                "anchorSequence": null, "maxBytes": TRANSCRIPT_PAGE_BYTES
                            }),
                        )?;
                        page_in_flight = true;
                    } else {
                        durable_through = target.or(durable_through);
                    }
                }
                "turn.message.submit" if step == 0 => {
                    ensure!(result["disposition"] == "turn_started", "not started: {frame}");
                    step = 1;
                }
                "turn.message.submit" => {
                    ensure!(result["disposition"] == "followup", "not queued: {frame}");
                }
                "queue.entry.update" => {
                    let (second_entry, third_entry, fourth_entry) =
                        entries.clone().context("entries")?;
                    // A reorder names the revision it was made at (epoch
                    // 197): the one the update left.
                    queue_revision = result["queueRevision"].as_u64().context("queueRevision")?;
                    send(
                        &mut wire,
                        &mut pending,
                        "queue.entries.reorder",
                        json!({
                            "originHostEpoch": host_epoch, "sessionId": session_id,
                            "reorderId": uuid_simple(),
                            "expectedQueueRevision": queue_revision,
                            "entryIds": [third_entry, second_entry, fourth_entry]
                        }),
                    )?;
                    step = 4;
                }
                "queue.entries.reorder" => {
                    let (_, third_entry, _) = entries.clone().context("entries")?;
                    send(
                        &mut wire,
                        &mut pending,
                        "queue.entry.promote",
                        json!({
                            "originHostEpoch": host_epoch, "sessionId": session_id,
                            "entryId": third_entry, "promoteId": uuid_simple()
                        }),
                    )?;
                    step = 5;
                }
                "queue.entry.promote" => {
                    let (_, _, fourth_entry) = entries.clone().context("entries")?;
                    send(
                        &mut wire,
                        &mut pending,
                        "queue.entry.retract",
                        json!({
                            "originHostEpoch": host_epoch, "sessionId": session_id,
                            "entryId": fourth_entry, "retractId": uuid_simple()
                        }),
                    )?;
                    step = 6;
                }
                _ => {}
            }
        } else {
            match frame.get("kind").and_then(Value::as_str) {
                Some("subscription.session_projection") => {
                    let snapshot = &frame["snapshot"];
                    let root_running = snapshot["rootTurn"]["status"]
                        .as_str()
                        .is_some_and(|status| matches!(status, "running" | "admitted" | "created"));
                    let queue = &snapshot["queue"];
                    queue_revision = queue["queueRevision"].as_u64().unwrap_or(queue_revision);
                    let empty = queue["steering"].as_array().is_none_or(Vec::is_empty)
                        && queue["followup"].as_array().is_none_or(Vec::is_empty);
                    idle_with_empty_queue = !root_running && empty;
                    if step == 1 && root_running {
                        send(
                            &mut wire,
                            &mut pending,
                            "turn.message.submit",
                            submit(&second, "Reply with the single word: second."),
                        )?;
                        send(
                            &mut wire,
                            &mut pending,
                            "turn.message.submit",
                            submit(&third, "Reply with the single word: third."),
                        )?;
                        send(
                            &mut wire,
                            &mut pending,
                            "turn.message.submit",
                            submit(&fourth, "Reply with the single word: fourth."),
                        )?;
                        step = 2;
                    }
                    let followup = queue["followup"].as_array().cloned().unwrap_or_default();
                    let entry_of = |message_id: &str| {
                        followup
                            .iter()
                            .find(|entry| entry["messageId"] == message_id)
                            .and_then(|entry| entry["entryId"].as_str().map(str::to_owned))
                    };
                    if step == 2
                        && let (Some(second_entry), Some(third_entry), Some(fourth_entry)) =
                            (entry_of(&second), entry_of(&third), entry_of(&fourth))
                    {
                        entries = Some((second_entry, third_entry.clone(), fourth_entry));
                        send(
                            &mut wire,
                            &mut pending,
                            "queue.entry.update",
                            json!({
                                "originHostEpoch": host_epoch, "sessionId": session_id,
                                "entryId": third_entry, "updateId": uuid_simple(),
                                "expectedQueueRevision": queue_revision,
                                "text": "Reply with the single word: third (edited)."
                            }),
                        )?;
                        step = 3;
                    }
                }
                Some("subscription.transcript_advanced") => {
                    watermark = frame["throughSequence"].as_u64();
                }
                Some("subscription.closed") => bail!("the Host closed the subscription: {frame}"),
                _ => {}
            }
        }
        if !page_in_flight
            && let Some(target) = watermark
            && durable_through.is_none_or(|through| through < target)
        {
            send(
                &mut wire,
                &mut pending,
                "session.transcript.page",
                json!({
                    "subscriptionId": subscription_id, "direction": "newer",
                    "throughSequence": target, "cursor": null,
                    "anchorSequence": durable_through, "maxBytes": TRANSCRIPT_PAGE_BYTES
                }),
            )?;
            page_in_flight = true;
        }
    }
    let (closed, _) =
        wire.request("subscription.close", json!({"subscriptionId": subscription_id}))?;
    ensure!(closed["ok"] == true, "subscription.close failed: {closed}");
    println!("message queue: session {session_id}");
    Ok(wire.recording.take().unwrap_or_default())
}

/// Runs one scenario on a fresh connection and Session.
fn run_scenario(
    endpoint: &str,
    workspace: &Path,
    scenario: &Scenario,
    model_target: &Value,
) -> Result<Outcome> {
    let mut wire = Wire::connect(endpoint)?;
    wire.send(&serde_json::to_value(ClientHello::new(random_client_instance_id()))?)?;
    let accepted = wire.next_frame()?;
    ensure!(accepted["kind"] == "accepted", "handshake was not accepted: {accepted}");
    wire.recording = Some(Vec::new());

    let session_id = format!("fixture-{}", uuid_simple());
    let (created, _) = wire.request(
        "session.create",
        json!({
            "sessionId": session_id,
            "workspace": {"kind": "host_path", "path": workspace},
            "modelTarget": model_target,
            "name": format!("Fixture {}", scenario.name),
            "permissionMode": scenario.permission_mode
        }),
    )?;
    ensure!(created["ok"] == true, "session.create failed: {created}");
    let (open, _) = wire.request(
        "subscription.open",
        json!({"sessionId": session_id,
               "transcript": {"kind": "tail", "maxBytes": TRANSCRIPT_TAIL_BYTES}}),
    )?;
    ensure!(open["ok"] == true, "subscription.open failed: {open}");
    let subscription_id = open["result"]["subscriptionId"]
        .as_str()
        .context("subscription.open result has no subscriptionId")?
        .to_owned();
    let mut durable_through = open["result"]["transcript"]["durable"]["throughSequence"].as_u64();
    let (ready, _) =
        wire.request("subscription.ready", json!({"subscriptionId": subscription_id}))?;
    ensure!(ready["ok"] == true, "subscription.ready failed: {ready}");

    let turn_id = format!("fixture-turn-{}", uuid_simple());
    let mut pending: BTreeMap<String, &'static str> = BTreeMap::new();
    pending.insert(
        wire.send_request(
            "turn.start",
            json!({"sessionId": session_id, "turnId": turn_id,
                   "content": {"text": scenario.prompt},
                   // Small local models can loop on tool calls; bound the Turn so a
                   // recording never runs away.
                   "maxSteps": 8}),
        )?,
        "turn.start",
    );

    let mut run_id: Option<String> = None;
    let mut stop_sent = false;
    let mut answered_ids: Vec<String> = Vec::new();
    let mut deltas = 0;
    let mut thinking_deltas = 0;
    let mut terminal: Option<(String, Option<String>)> = None;
    let mut durable_terminal = false;
    let mut watermark: Option<u64> = None;
    let mut page_in_flight = false;
    let deadline = Instant::now() + SCENARIO_TIMEOUT;

    loop {
        let settled = terminal.is_some() && durable_terminal && pending.is_empty();
        let wait = if settled { SETTLE_QUIET } else { Duration::from_secs(5) };
        ensure!(Instant::now() < deadline, "scenario did not settle in {SCENARIO_TIMEOUT:?}");
        let Some(frame) = wire.next_frame_within(wait)? else {
            if settled {
                break;
            }
            continue;
        };
        if let Some(request_id) = frame.get("requestId").and_then(Value::as_str) {
            let Some(operation) = pending.remove(request_id) else { continue };
            ensure!(frame["ok"] == true, "{operation} failed: {frame}");
            let result = &frame["result"];
            match operation {
                "turn.start" => {
                    ensure!(result["kind"] == "started", "turn.start did not start: {frame}");
                    run_id = result["turn"]["runId"].as_str().map(str::to_owned);
                    if scenario.stop == StopAt::AfterStart {
                        let stop = stop_request(&session_id, &turn_id, run_id.as_deref())?;
                        pending.insert(wire.send_request("turn.stop", stop)?, "turn.stop");
                        stop_sent = true;
                    }
                }
                "session.transcript.page" => {
                    page_in_flight = false;
                    durable_terminal |= page_has_terminal_state(result, &turn_id)?;
                    let target = result["throughSequence"].as_u64();
                    if let Some(cursor) = result["nextCursor"].as_str() {
                        let input = json!({
                            "subscriptionId": subscription_id, "direction": "newer",
                            "throughSequence": target, "cursor": cursor,
                            "anchorSequence": null, "maxBytes": TRANSCRIPT_PAGE_BYTES
                        });
                        pending.insert(
                            wire.send_request("session.transcript.page", input)?,
                            "session.transcript.page",
                        );
                        page_in_flight = true;
                    } else {
                        durable_through = target.or(durable_through);
                    }
                }
                _ => {}
            }
        } else {
            match frame.get("kind").and_then(Value::as_str) {
                Some("subscription.session_delta") => {
                    if frame["delta"]["kind"] == "thinking" && frame["delta"]["text"] != "" {
                        thinking_deltas += 1;
                    }
                    if frame["delta"]["kind"] == "text" && frame["delta"]["text"] != "" {
                        deltas += 1;
                        if scenario.stop == StopAt::FirstDelta && !stop_sent {
                            let stop = stop_request(&session_id, &turn_id, run_id.as_deref())?;
                            pending.insert(wire.send_request("turn.stop", stop)?, "turn.stop");
                            stop_sent = true;
                        }
                    }
                }
                Some("subscription.session_projection") => {
                    let snapshot = &frame["snapshot"];
                    for interaction in
                        snapshot["interactions"]["pending"].as_array().into_iter().flatten()
                    {
                        let Some(id) = interaction["interactionId"].as_str() else { continue };
                        if answered_ids.iter().any(|answered| answered == id) {
                            continue;
                        }
                        // `ask` mode compiles to a workspace-write profile, so the prompt a
                        // real Turn raises is usually `sandbox_boundary` (leaving the
                        // workspace), not `permission`. Allow either.
                        let answer_body = match interaction["request"]["kind"].as_str() {
                            Some("permission") => json!({"kind": "permission", "decision": "allow",
                                                         "rememberForTurn": false}),
                            Some("sandbox_boundary") => {
                                json!({"kind": "sandbox_boundary", "decision": "allow"})
                            }
                            _ => continue,
                        };
                        answered_ids.push(id.to_owned());
                        let answer = json!({
                            "sessionId": session_id, "interactionId": id,
                            "answer": answer_body
                        });
                        pending.insert(
                            wire.send_request("interaction.answer", answer)?,
                            "interaction.answer",
                        );
                    }
                    let root = &snapshot["rootTurn"];
                    if root["turnId"] == turn_id.as_str() {
                        if run_id.is_none() {
                            run_id = root["runId"].as_str().map(str::to_owned);
                        }
                        let status = root["status"].as_str().unwrap_or_default();
                        if matches!(status, "completed" | "failed" | "cancelled") {
                            terminal = Some((
                                status.to_owned(),
                                root["failureClass"].as_str().map(str::to_owned),
                            ));
                        }
                    }
                }
                Some("subscription.transcript_advanced") => {
                    watermark = frame["throughSequence"].as_u64();
                }
                Some("subscription.closed") => bail!("the Host closed the subscription: {frame}"),
                _ => {}
            }
        }
        // Catch the durable transcript up to the announced watermark.
        if !page_in_flight
            && let Some(target) = watermark
            && durable_through.is_none_or(|through| through < target)
        {
            let input = json!({
                "subscriptionId": subscription_id, "direction": "newer",
                "throughSequence": target, "cursor": null,
                "anchorSequence": durable_through, "maxBytes": TRANSCRIPT_PAGE_BYTES
            });
            pending.insert(
                wire.send_request("session.transcript.page", input)?,
                "session.transcript.page",
            );
            page_in_flight = true;
        }
    }
    let (closed, _) =
        wire.request("subscription.close", json!({"subscriptionId": subscription_id}))?;
    ensure!(closed["ok"] == true, "subscription.close failed: {closed}");

    let (terminal_status, failure_class) = match terminal {
        Some((status, class)) => (Some(status), class),
        None => (None, None),
    };
    Ok(Outcome {
        session_id,
        frames: wire.recording.take().unwrap_or_default(),
        terminal_status,
        failure_class,
        answered: answered_ids.len(),
        deltas,
        thinking_deltas,
    })
}

/// `--long-history`: runs [`LONG_HISTORY_TURNS`] Turns with long prompts in a
/// new Session (not recorded), then records reopening it with the 16 KiB tail
/// and reading older pages until the start.
fn record_long_history(
    endpoint: &str,
    workspace: &Path,
    model_target: &Value,
) -> Result<Vec<Value>> {
    fs::create_dir_all(workspace)?;
    let mut wire = Wire::connect(endpoint)?;
    wire.send(&serde_json::to_value(ClientHello::new(random_client_instance_id()))?)?;
    let accepted = wire.next_frame()?;
    ensure!(accepted["kind"] == "accepted", "handshake was not accepted: {accepted}");
    let session_id = format!("fixture-{}", uuid_simple());
    let (created, _) = wire.request(
        "session.create",
        json!({
            "sessionId": session_id,
            "workspace": {"kind": "host_path", "path": workspace},
            "modelTarget": model_target,
            "name": "Fixture long history",
            "permissionMode": "ask"
        }),
    )?;
    ensure!(created["ok"] == true, "session.create failed: {created}");
    let (open, _) = wire.request(
        "subscription.open",
        json!({"sessionId": session_id, "transcript": {"kind": "none"}}),
    )?;
    ensure!(open["ok"] == true, "subscription.open failed: {open}");
    let subscription_id = open["result"]["subscriptionId"].clone();
    let (ready, _) =
        wire.request("subscription.ready", json!({"subscriptionId": subscription_id}))?;
    ensure!(ready["ok"] == true, "subscription.ready failed: {ready}");
    for part in 1..=LONG_HISTORY_TURNS {
        let turn_id = format!("fixture-turn-{}", uuid_simple());
        let notes: String = (1..=LONG_HISTORY_PROMPT_LINES)
            .map(|line| {
                format!(
                    "{part}.{line}. Part {part} note {line}: the transcript keeps every row \
                     durable, and older rows arrive page by page.\n"
                )
            })
            .collect();
        let prompt = format!(
            "These are the notes of part {part}.\n\n{notes}\nReply with one short sentence \
             that names part {part}. Do not use any tools."
        );
        println!("long history: turn {part} of {LONG_HISTORY_TURNS} …");
        let request = wire.send_request(
            "turn.start",
            json!({"sessionId": session_id, "turnId": turn_id,
                   "content": {"text": prompt}, "maxSteps": 4}),
        )?;
        let deadline = Instant::now() + LONG_HISTORY_TURN_TIMEOUT;
        let mut status: Option<String> = None;
        while status.is_none() {
            ensure!(Instant::now() < deadline, "turn {part} did not end in time");
            let Some(frame) = wire.next_frame_within(Duration::from_secs(5))? else { continue };
            if frame.get("requestId").and_then(Value::as_str) == Some(request.as_str()) {
                ensure!(frame["ok"] == true, "turn.start failed: {frame}");
            }
            if frame["kind"] == "subscription.session_projection" {
                let root = &frame["snapshot"]["rootTurn"];
                let ended = root["status"]
                    .as_str()
                    .filter(|status| matches!(*status, "completed" | "failed" | "cancelled"));
                if root["turnId"] == turn_id.as_str()
                    && let Some(ended) = ended
                {
                    status = Some(ended.to_owned());
                }
            }
        }
        ensure!(status.as_deref() == Some("completed"), "turn {part} ended {status:?}");
        // Let the terminal rows land before the next Turn starts.
        while wire.next_frame_within(SETTLE_QUIET)?.is_some() {}
    }
    wire.request("subscription.close", json!({"subscriptionId": subscription_id}))?;

    // The recording: reopen with the tail and read older pages to the start.
    let mut wire = Wire::connect(endpoint)?;
    wire.send(&serde_json::to_value(ClientHello::new(random_client_instance_id()))?)?;
    let accepted = wire.next_frame()?;
    ensure!(accepted["kind"] == "accepted", "handshake was not accepted: {accepted}");
    wire.recording = Some(Vec::new());
    let (open, _) = wire.request(
        "subscription.open",
        json!({"sessionId": session_id,
               "transcript": {"kind": "tail", "maxBytes": TRANSCRIPT_TAIL_BYTES}}),
    )?;
    ensure!(open["ok"] == true, "subscription.open failed: {open}");
    let subscription_id = open["result"]["subscriptionId"].clone();
    let tail = &open["result"]["transcript"]["durable"];
    let through = tail["throughSequence"].clone();
    let mut cursor = tail["nextCursor"].clone();
    ensure!(!cursor.is_null(), "the Session fits the tail; nothing older to page");
    let (ready, _) =
        wire.request("subscription.ready", json!({"subscriptionId": subscription_id}))?;
    ensure!(ready["ok"] == true, "subscription.ready failed: {ready}");
    let mut pages = 0;
    while !cursor.is_null() {
        let (page, _) = wire.request(
            "session.transcript.page",
            json!({
                "subscriptionId": subscription_id, "direction": "older",
                "throughSequence": through, "cursor": cursor,
                "anchorSequence": null, "maxBytes": LONG_HISTORY_PAGE_BYTES
            }),
        )?;
        ensure!(page["ok"] == true, "session.transcript.page failed: {page}");
        cursor = page["result"]["nextCursor"].clone();
        pages += 1;
        ensure!(pages < 64, "the older pages did not reach the start");
    }
    while wire.next_frame_within(SETTLE_QUIET)?.is_some() {}
    let (closed, _) =
        wire.request("subscription.close", json!({"subscriptionId": subscription_id}))?;
    ensure!(closed["ok"] == true, "subscription.close failed: {closed}");
    println!("long history: session {session_id}, {pages} older pages");
    Ok(wire.recording.take().unwrap_or_default())
}

fn stop_request(session_id: &str, turn_id: &str, run_id: Option<&str>) -> Result<Value> {
    let run_id = run_id.context("turn.stop needs the run id")?;
    Ok(json!({"sessionId": session_id, "turnId": turn_id, "runId": run_id}))
}

/// The `modelTarget` to put in `session.create`: the catalog default unless
/// `--connection-slug`/`--model` selected an explicit connection.
fn resolve_model_target(wire: &mut Wire, args: &Args) -> Result<Value> {
    match (&args.connection_slug, &args.model) {
        (None, None) => Ok(json!({"kind": "default"})),
        (Some(slug), Some(model)) => {
            let connection_id = find_connection_id(wire, slug)?;
            Ok(json!({
                "kind": "explicit",
                "connectionId": connection_id,
                "connectionSlug": slug,
                "model": model,
            }))
        }
        _ => bail!("--connection-slug and --model must be given together"),
    }
}

/// Pages `connection.catalog.query` looking for the connection whose `slug`
/// matches, and returns its `connectionId`.
fn find_connection_id(wire: &mut Wire, slug: &str) -> Result<String> {
    let mut input = ConnectionCatalogQueryInput::Start;
    let mut available = Vec::new();
    // A `RevisionChanged` restart is unusual but not unbounded; give up
    // rather than loop forever against a catalog that keeps changing.
    for _ in 0..20 {
        let (response, _) =
            wire.request("connection.catalog.query", serde_json::to_value(&input)?)?;
        ensure!(response["ok"] == true, "connection.catalog.query failed: {response}");
        let result: ConnectionCatalogQueryResult =
            serde_json::from_value(response["result"].clone())
                .context("decoding connection.catalog.query result")?;
        match result {
            ConnectionCatalogQueryResult::Page { revision, items, next_cursor, .. } => {
                for item in &items {
                    if let ConnectionCatalogItem::Connection(header) = item {
                        if header.slug == slug {
                            return Ok(header.connection_id.clone());
                        }
                        available.push(header.slug.clone());
                    }
                }
                match next_cursor {
                    Some(cursor) => {
                        input = ConnectionCatalogQueryInput::Continue { revision, cursor }
                    }
                    None => {
                        bail!(
                            "no connection with slug {slug:?}; available slugs: {}",
                            available.join(", ")
                        );
                    }
                }
            }
            ConnectionCatalogQueryResult::RevisionChanged { .. } => {
                input = ConnectionCatalogQueryInput::Start;
                available.clear();
            }
            ConnectionCatalogQueryResult::Unknown => {
                bail!("connection.catalog.query returned an unrecognized result kind");
            }
            _ => bail!("connection.catalog.query returned an unrecognized result kind"),
        }
    }
    bail!("connection.catalog.query kept changing revision while looking for slug {slug:?}");
}

/// Records `runtime.policy.query` and `runtime.policy.mutate`: the chat
/// defaults are written back unchanged, then once more at the stale revision
/// for the conflict answer. The policy ends as it began.
fn record_runtime_policy(
    wire: &mut Wire,
    fixtures: &mut BTreeMap<&'static str, Value>,
) -> Result<()> {
    let (policy, _) = wire.request("runtime.policy.query", json!({}))?;
    ensure!(policy["ok"] == true, "runtime.policy.query failed: {policy}");
    let revision = policy["result"]["revision"].as_u64().context("policy revision")?;
    let chat_defaults = policy["result"]["policy"]["chatDefaults"].clone();
    fixtures.insert("runtime_policy_query.response.json", policy);
    let mutation = |revision: u64| {
        json!({"expectedRevision": revision,
               "operation": {"kind": "set_chat_defaults", "value": chat_defaults}})
    };
    let (committed, _) = wire.request("runtime.policy.mutate", mutation(revision))?;
    ensure!(
        committed["result"]["kind"] == "committed",
        "runtime.policy.mutate did not commit: {committed}"
    );
    fixtures.insert("runtime_policy_mutate.response.json", committed);
    let (conflict, _) = wire.request("runtime.policy.mutate", mutation(revision))?;
    ensure!(
        conflict["result"]["kind"] == "revision_conflict",
        "a stale runtime.policy.mutate did not conflict: {conflict}"
    );
    fixtures.insert("runtime_policy_mutate.conflict.response.json", conflict);
    Ok(())
}

/// Records the task menu's and the project picker's commands on a scratch
/// Session, which it removes again.
fn record_task_actions(
    wire: &mut Wire,
    workspace: &Path,
    model_target: &Value,
    fixtures: &mut BTreeMap<&'static str, Value>,
) -> Result<()> {
    fs::create_dir_all(workspace)?;
    let session_id = format!("fixture-{}", uuid_simple());
    let (created, _) = wire.request(
        "session.create",
        json!({
            "sessionId": session_id,
            "workspace": {"kind": "host_path", "path": workspace},
            "modelTarget": model_target,
            "name": "Fixture actions"
        }),
    )?;
    ensure!(created["ok"] == true, "session.create failed: {created}");
    let revision = |response: &Value| -> Result<u64> {
        response["result"]["session"]["revision"]
            .as_u64()
            .or_else(|| response["result"]["revision"].as_u64())
            .context("a session revision")
    };
    let first = revision(&created)?;
    let (renamed, _) = wire.request(
        "session.metadata.update",
        json!({"sessionId": session_id, "expectedRevision": first,
               "patch": {"name": "Fixture actions renamed"}}),
    )?;
    ensure!(renamed["result"]["kind"] == "committed", "the rename did not commit: {renamed}");
    let current = revision(&renamed)?;
    fixtures.insert("session_metadata_update.response.json", renamed);
    let (conflict, _) = wire.request(
        "session.metadata.update",
        json!({"sessionId": session_id, "expectedRevision": first,
               "patch": {"isFlagged": true}}),
    )?;
    ensure!(
        conflict["result"]["kind"] == "revision_conflict",
        "a stale session.metadata.update did not conflict: {conflict}"
    );
    fixtures.insert("session_metadata_update.conflict.response.json", conflict);
    let (archived, _) = wire
        .request("session.lifecycle.set", json!({"sessionId": session_id, "state": "archived"}))?;
    ensure!(archived["result"]["isArchived"] == true, "archiving failed: {archived}");
    let current = archived["result"]["revision"].as_u64().unwrap_or(current);
    fixtures.insert("session_lifecycle_set.response.json", archived);
    let (preview, _) = wire.request("session.remove.preview", json!({"sessionId": session_id}))?;
    ensure!(preview["ok"] == true, "session.remove.preview failed: {preview}");
    fixtures.insert("session_remove_preview.response.json", preview);
    let (stale, _) = wire
        .request("session.remove", json!({"sessionId": session_id, "expectedRevision": first}))?;
    ensure!(
        stale["result"]["kind"] == "revision_conflict",
        "a stale session.remove did not conflict: {stale}"
    );
    fixtures.insert("session_remove.conflict.response.json", stale);
    let (removed, _) = wire
        .request("session.remove", json!({"sessionId": session_id, "expectedRevision": current}))?;
    ensure!(removed["result"]["kind"] == "removed", "session.remove failed: {removed}");
    fixtures.insert("session_remove.response.json", removed);

    let (registered, _) = wire.request(
        "project.catalog.mutate",
        json!({"kind": "register", "path": workspace, "prefer": true}),
    )?;
    ensure!(registered["ok"] == true, "project.catalog.mutate register failed: {registered}");
    fixtures.insert("project_catalog_mutate.register.response.json", registered);
    let (locations, _) =
        wire.request("project.catalog.query", json!({"kind": "list_start", "view": "locations"}))?;
    ensure!(locations["ok"] == true, "project.catalog.query failed: {locations}");
    fixtures.insert("project_catalog_query.locations.response.json", locations);
    Ok(())
}

/// Records the connection effects of the "Add connection" form and the
/// connection settings, then removes the connection it added.
fn record_onboarding(
    wire: &mut Wire,
    base_url: &str,
    api_key: &str,
    fixtures: &mut BTreeMap<&'static str, Value>,
) -> Result<()> {
    let catalog = |wire: &mut Wire| -> Result<Value> {
        let (response, _) = wire.request("connection.catalog.query", json!({"kind": "start"}))?;
        ensure!(response["ok"] == true, "connection.catalog.query failed: {response}");
        Ok(response["result"].clone())
    };
    let before = catalog(wire)?;
    let taken = before["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["kind"] == "connection"))
        .and_then(|header| header["slug"].as_str())
        .map(str::to_owned);
    let slug = format!("fixture-onboarding-{}", &uuid_simple()[..8]);
    let target = |slug: &str| {
        json!({"kind": "create", "providerType": "custom", "slug": slug,
               "defaultApiProtocol": "openai-chat"})
    };

    let (verified, _) = wire.request(
        "connection.onboarding.verify",
        json!({"target": target(&slug), "apiKey": api_key, "baseUrl": base_url}),
    )?;
    ensure!(
        verified["result"]["kind"] == "verified",
        "connection.onboarding.verify did not verify: {verified}"
    );
    let first_model = verified["result"]["models"][0]["id"]
        .as_str()
        .context("verification found no model")?
        .to_owned();
    fixtures.insert("connection_onboarding_verify.response.json", verified);
    if let Some(taken) = taken {
        let (rejected, _) = wire.request(
            "connection.onboarding.verify",
            json!({"target": target(&taken), "apiKey": api_key, "baseUrl": base_url}),
        )?;
        ensure!(
            rejected["result"]["reason"] == "slug_taken",
            "a taken slug was not rejected: {rejected}"
        );
        fixtures.insert("connection_onboarding_verify.rejected.response.json", rejected);
    }

    let (saved, _) = wire.request(
        "connection.onboarding.save",
        json!({"target": target(&slug), "apiKey": api_key, "baseUrl": base_url,
               "enabledModelIds": [first_model]}),
    )?;
    ensure!(saved["result"]["kind"] == "saved", "connection.onboarding.save failed: {saved}");
    let connection = saved["result"]["connection"].clone();
    fixtures.insert("connection_onboarding_save.response.json", saved);

    // Renaming it with the same models, base URL, and state is an update
    // that changes only the name; then the same update at the old revision
    // is stale.
    let update = |revision: &Value| {
        json!({"expected": {"connectionId": connection["connectionId"], "revision": revision},
               "changes": {"name": format!("{slug} (renamed)"), "baseUrl": base_url,
                           "enabled": true, "enabledModelIds": [first_model]}})
    };
    let (updated, _) =
        wire.request("connection.catalog.update", update(&connection["revision"]))?;
    ensure!(
        updated["result"]["kind"] == "committed",
        "connection.catalog.update did not commit: {updated}"
    );
    let connection = json!({
        "connectionId": connection["connectionId"],
        "revision": updated["result"]["connection"]["revision"],
    });
    fixtures.insert("connection_catalog_update.response.json", updated);
    let (stale, _) = wire.request("connection.catalog.update", update(&json!(1)))?;
    ensure!(
        stale["result"]["kind"] == "connection_stale",
        "a stale connection.catalog.update was not refused: {stale}"
    );
    fixtures.insert("connection_catalog_update.stale.response.json", stale);

    let current = catalog(wire)?;
    let revision = current["revision"].as_u64().context("catalog revision")?;
    let (committed, _) = wire.request(
        "connection.catalog.set-default-target",
        json!({"expectedCatalogRevision": revision, "target": current["defaultTarget"]}),
    )?;
    ensure!(
        committed["result"]["kind"] == "committed",
        "set-default-target did not commit: {committed}"
    );
    fixtures.insert("connection_catalog_set_default_target.response.json", committed);
    let (conflict, _) = wire.request(
        "connection.catalog.set-default-target",
        json!({"expectedCatalogRevision": revision.saturating_sub(1).max(1),
               "target": current["defaultTarget"]}),
    )?;
    fixtures.insert("connection_catalog_set_default_target.conflict.response.json", conflict);

    let (removed, _) = wire.request(
        "connection.catalog.remove",
        json!({"expected": {"connectionId": connection["connectionId"],
                            "revision": connection["revision"]}}),
    )?;
    ensure!(
        removed["result"]["kind"] == "committed",
        "connection.catalog.remove failed: {removed}"
    );
    fixtures.insert("connection_catalog_remove.response.json", removed);
    println!("onboarding: added and removed {slug}");
    Ok(())
}

/// Whether a transcript page holds the terminal `turn_state` row of `turn_id`.
fn page_has_terminal_state(page: &Value, turn_id: &str) -> Result<bool> {
    for fragment in page["fragments"].as_array().into_iter().flatten() {
        let data = fragment["data"].as_str().context("fragment without data")?;
        let bytes = base64_decode(data).context("fragment data is not base64")?;
        // A row split across fragments is never the short turn_state row we
        // look for; only whole rows are parsed.
        if fragment["byteOffset"] != 0
            || fragment["totalBytes"].as_u64() != Some(bytes.len() as u64)
        {
            continue;
        }
        let row: Value = serde_json::from_slice(&bytes)?;
        if row["type"] == "turn_state" && row["turnId"] == turn_id && row["status"] != "running" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A blocking frame transport over the Host's Unix socket.
struct Wire {
    stream: UnixStream,
    decoder: FrameDecoder,
    ready: Vec<String>,
    /// When set, every frame sent or received, in order.
    recording: Option<Vec<Value>>,
}

impl Wire {
    fn connect(endpoint: &str) -> Result<Self> {
        let stream =
            UnixStream::connect(endpoint).with_context(|| format!("connecting {endpoint}"))?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        Ok(Self { stream, decoder: FrameDecoder::new(), ready: Vec::new(), recording: None })
    }

    fn send(&mut self, value: &Value) -> Result<()> {
        self.stream.write_all(&encode_frame(value)?)?;
        if let Some(recording) = &mut self.recording {
            recording.push(value.clone());
        }
        Ok(())
    }

    fn next_frame(&mut self) -> Result<Value> {
        loop {
            if !self.ready.is_empty() {
                let text = self.ready.remove(0);
                let frame = decode_frame_json(&text)?;
                if let Some(recording) = &mut self.recording {
                    recording.push(frame.clone());
                }
                return Ok(frame);
            }
            let mut buffer = [0u8; 64 * 1024];
            let read = self.stream.read(&mut buffer)?;
            if read == 0 {
                self.decoder.finish()?;
                bail!("the Host closed the connection");
            }
            self.ready.extend(self.decoder.push(&buffer[..read])?);
        }
    }

    /// Sends a request and returns its id.
    fn send_request(&mut self, operation: &str, input: Value) -> Result<String> {
        let request_id = uuid_simple();
        let frame = RequestFrame::new(request_id.clone(), operation, input);
        self.send(&serde_json::to_value(frame)?)?;
        Ok(request_id)
    }

    /// Sends a request and returns its response plus any pushes seen first.
    fn request(&mut self, operation: &str, input: Value) -> Result<(Value, Vec<Value>)> {
        let request_id = self.send_request(operation, input)?;
        let mut pushes = Vec::new();
        loop {
            let frame = self.next_frame()?;
            if frame.get("requestId").and_then(Value::as_str) == Some(request_id.as_str()) {
                return Ok((frame, pushes));
            }
            pushes.push(frame);
        }
    }

    fn next_push_within(&mut self, wait: Duration) -> Result<Option<Value>> {
        self.next_frame_within(wait)
    }

    /// The next frame, or `None` if none arrives within `wait`.
    fn next_frame_within(&mut self, wait: Duration) -> Result<Option<Value>> {
        self.stream.set_read_timeout(Some(wait))?;
        let frame = match self.next_frame() {
            Ok(frame) => Some(frame),
            Err(error) => match error.downcast_ref::<std::io::Error>() {
                Some(io)
                    if matches!(
                        io.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    None
                }
                _ => return Err(error),
            },
        };
        self.stream.set_read_timeout(Some(IO_TIMEOUT))?;
        Ok(frame)
    }
}

/// Refuses credentials and masks quoted key suffixes, in place.
fn sanitize(name: &str, value: &mut Value) -> Result<()> {
    refuse_credentials(name, value)?;
    mask_strings(name, value)
}

/// Fails if any object key in `value` looks like it carries a secret.
fn refuse_credentials(name: &str, value: &Value) -> Result<()> {
    const SUSPICIOUS: [&str; 5] = ["secret", "apikey", "token", "password", "credential"];
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let lowered = key.to_ascii_lowercase().replace(['_', '-'], "");
                if SUSPICIOUS.iter().any(|word| lowered.contains(word)) {
                    bail!("{name} contains a credential-looking key {key:?}; not writing it");
                }
                refuse_credentials(name, child)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                refuse_credentials(name, child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Masks key suffixes in every string, and in the decoded bytes of
/// transcript fragments, which a text search of the fixture cannot see.
fn mask_strings(name: &str, value: &mut Value) -> Result<()> {
    match value {
        Value::String(text) => {
            let mut bytes = std::mem::take(text).into_bytes();
            check_and_mask(name, &mut bytes)?;
            *text = String::from_utf8(bytes)?;
        }
        Value::Object(object) => {
            let is_fragment =
                object.contains_key("byteOffset") && object.contains_key("totalBytes");
            // A digest would no longer match masked bytes.
            let digest_is_null = object.get("payloadDigest").is_none_or(Value::is_null);
            for (key, child) in object.iter_mut() {
                if is_fragment && key == "data" {
                    let Some(data) = child.as_str() else { continue };
                    let mut bytes = base64_decode(data).context("fragment data is not base64")?;
                    if check_and_mask(name, &mut bytes)? {
                        ensure!(
                            digest_is_null,
                            "{name}: cannot mask a transcript fragment that carries a digest"
                        );
                        *child = Value::from(base64_encode(&bytes));
                    }
                } else {
                    mask_strings(name, child)?;
                }
            }
        }
        Value::Array(items) => {
            for child in items {
                mask_strings(name, child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Refuses `sk-` tokens and replaces the characters after `****` (as in
/// `Your api key: ****32fc`) with `x`. Returns whether anything changed.
fn check_and_mask(name: &str, bytes: &mut [u8]) -> Result<bool> {
    if let Some(at) = bytes.windows(3).position(|window| window == b"sk-")
        && bytes.get(at + 3..at + 11).is_some_and(|rest| rest.iter().all(u8::is_ascii_alphanumeric))
    {
        bail!("{name} contains an sk- token; not writing it");
    }
    let mut changed = false;
    let mut index = 0;
    while let Some(offset) = bytes[index..].windows(4).position(|window| window == b"****") {
        let mut cursor = index + offset + 4;
        while cursor < bytes.len() && bytes[cursor].is_ascii_alphanumeric() {
            if bytes[cursor] != b'x' {
                bytes[cursor] = b'x';
                changed = true;
            }
            cursor += 1;
        }
        index = cursor;
    }
    Ok(changed)
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (position, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if position <= chunk.len() {
                out.push(BASE64_ALPHABET[((n >> shift) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        let mut padding = 0;
        for &byte in chunk {
            let value = match byte {
                b'=' => {
                    padding += 1;
                    0
                }
                _ if padding > 0 => return None,
                _ => BASE64_ALPHABET.iter().position(|&symbol| symbol == byte)? as u32,
            };
            n = (n << 6) | value;
        }
        let decoded = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&decoded[..3 - padding.min(2)]);
    }
    Some(out)
}

fn uuid_simple() -> String {
    random_client_instance_id().as_str().replace('-', "")
}

struct Args {
    root: PathBuf,
    out: PathBuf,
    create_session: Option<PathBuf>,
    sequences: Option<PathBuf>,
    only: Option<Vec<String>>,
    connection_slug: Option<String>,
    model: Option<String>,
    onboarding: Option<String>,
    onboarding_key: String,
    task_actions: Option<PathBuf>,
    long_history: Option<PathBuf>,
    only_sequence: Option<String>,
}

impl Args {
    fn parse() -> Result<Self> {
        let usage = "usage: capture_fixtures --root <state-root> --out <dir> \
                     [--create-session <workspace-dir>] [--sequences <workspace-dir> [--only a,b]] \
                     [--connection-slug <slug> --model <model-id>] \
                     [--onboarding <base-url> [--onboarding-key <key>]] \
                     [--task-actions <workspace-dir>] [--long-history <workspace-dir>] \
                     [--sequences <workspace-dir> --only-sequence <name>]";
        let mut root = None;
        let mut out = None;
        let mut create_session = None;
        let mut sequences = None;
        let mut only = None;
        let mut connection_slug = None;
        let mut model = None;
        let mut onboarding = None;
        let mut onboarding_key = "ollama".to_owned();
        let mut task_actions = None;
        let mut long_history = None;
        let mut only_sequence = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            let mut value = || args.next().context(usage);
            match arg.as_str() {
                "--root" => root = Some(PathBuf::from(value()?)),
                "--out" => out = Some(PathBuf::from(value()?)),
                "--create-session" => create_session = Some(PathBuf::from(value()?)),
                "--sequences" => sequences = Some(PathBuf::from(value()?)),
                "--only" => {
                    only = Some(value()?.split(',').map(str::to_owned).collect::<Vec<_>>());
                }
                "--connection-slug" => connection_slug = Some(value()?),
                "--model" => model = Some(value()?),
                "--onboarding" => onboarding = Some(value()?),
                "--onboarding-key" => onboarding_key = value()?,
                "--task-actions" => task_actions = Some(PathBuf::from(value()?)),
                "--long-history" => long_history = Some(PathBuf::from(value()?)),
                "--only-sequence" => only_sequence = Some(value()?),
                _ => bail!("unknown argument {arg:?}\n{usage}"),
            }
        }
        for path in
            [&create_session, &sequences, &task_actions, &long_history].into_iter().flatten()
        {
            ensure!(Path::new(path).is_absolute(), "workspace directories must be absolute");
        }
        if let Some(names) = &only {
            for name in names {
                ensure!(
                    SCENARIOS.iter().any(|scenario| scenario.name == name),
                    "unknown scenario {name:?}; known: {}",
                    SCENARIOS.iter().map(|scenario| scenario.name).collect::<Vec<_>>().join(", ")
                );
            }
        }
        ensure!(
            only_sequence.is_none() || sequences.is_some(),
            "--only-sequence needs --sequences <workspace-dir>\n{usage}"
        );
        ensure!(
            connection_slug.is_some() == model.is_some(),
            "--connection-slug and --model must be given together\n{usage}"
        );
        Ok(Self {
            root: root.context(usage)?,
            out: out.context(usage)?,
            create_session,
            sequences,
            only,
            connection_slug,
            model,
            onboarding,
            onboarding_key,
            task_actions,
            long_history,
            only_sequence,
        })
    }

    fn selects(&self, name: &str) -> bool {
        match &self.only {
            Some(names) => names.iter().any(|selected| selected == name),
            None => DEFAULT_SCENARIOS.contains(&name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        for text in ["", "a", "ab", "abc", "abcd", "{\"type\":\"user\"}"] {
            let encoded = base64_encode(text.as_bytes());
            assert_eq!(base64_decode(&encoded).as_deref(), Some(text.as_bytes()));
        }
        assert_eq!(base64_encode(b"ab"), "YWI=");
    }

    #[test]
    fn masking_keeps_length() {
        let mut bytes = b"Your api key: ****32fc is invalid".to_vec();
        assert!(check_and_mask("t", &mut bytes).expect("mask"));
        assert_eq!(bytes, b"Your api key: ****xxxx is invalid");
        assert!(check_and_mask("t", &mut b"sk-abcdef123456".to_vec()).is_err());
    }
}
