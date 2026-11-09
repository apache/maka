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

//! Ignored release harness, measurement version 2: public Native SDK admission,
//! queue delivery, preparation, HTTP and the same Run's canonical terminal.
//! The retired Engine::run engine-only timings are not comparable to these timings.
//! Run with --release --ignored --exact long_task_perf::engine_long_history --nocapture.
//! Defaults: TURNS=250,1000 REPETITIONS=5 TOOL_EVERY=20 TOOLS_PER_TURN=1 RESULT_BYTES=128.
//! All settings use MAKA_ENGINE_PERF_. Dense stress uses TOOL_EVERY=1 TOOLS_PER_TURN=8.
//! CHECKPOINT=1 runs actual SDK compact outside measurement (at most 1000 seed turns).
//! FIXTURE_DIR and explicit FIXTURE_TAG cache versioned CLI transcript bundles in
//! temporary storage, not the retired EventLog/Root bundle format. Every sample
//! imports into a fresh Root. Setup, import and compact are outside measurement.
use crate::support::{
    context::{SUMMARY, respond},
    native::NativeFixture,
};
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, CompactResult, SendResult},
};
use maka_agent_facts::{
    durable::{BackendSpec, Fact, RunId, RunOrigin, Terminal},
    model::ModelPart,
};
use maka_agent_state::queue::MessageResolution;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    net::{TcpListener, TcpStream},
};

const CACHE_FORMAT: &str = "native-sdk-perf-cli-jsonl-v1";
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

fn setting(name: &str, default: usize) -> usize {
    std::env::var(name).map_or(default, |value| {
        value.parse().expect("positive integer setting")
    })
}

fn cache_directory() -> Option<PathBuf> {
    let directory = PathBuf::from(std::env::var_os("MAKA_ENGINE_PERF_FIXTURE_DIR")?);
    let allowed = [std::env::temp_dir(), PathBuf::from("/tmp")];
    assert!(
        allowed.iter().any(|root| directory.starts_with(root)),
        "fixture directory must be under a temporary directory"
    );
    std::fs::create_dir_all(&directory).unwrap();
    let directory = directory.canonicalize().unwrap();
    assert!(
        allowed
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| directory.starts_with(root)),
        "fixture directory symlink escapes temporary storage"
    );
    Some(directory)
}

fn fingerprint(path: &Path) -> String {
    let mut file = File::open(path).unwrap();
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    hex::encode(digest.finalize())
}

// Foreign records are inert input to the real CLI importer, never local Run facts.
fn seed(
    path: &Path,
    turns: usize,
    result_bytes: usize,
    tool_every: usize,
    tools_per_turn: usize,
) -> Value {
    let mut file = BufWriter::new(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap(),
    );
    let mut raw_records = 0usize;
    let mut write = |row: Value| {
        serde_json::to_writer(&mut file, &row).unwrap();
        file.write_all(b"\n").unwrap();
        raw_records += 1;
    };
    write(
        json!({"type":"session_meta","payload":{"id":"perf-foreign-history","cwd":"/foreign/perf","model_provider":"foreign-fixture"}}),
    );
    let mut messages = 0usize;
    let mut tools = 0usize;
    for turn in 0..turns {
        write(
            json!({"type":"turn_context","payload":{"turn_id":format!("history-{turn}"),"model":"foreign-test"}}),
        );
        write(
            json!({"type":"event_msg","payload":{"type":"user_message","message":format!("question-history-{turn}")}}),
        );
        messages += 1;
        if turn % tool_every == 0 {
            for call in 0..tools_per_turn {
                let id = format!("call-{turn}-{call}");
                write(
                    json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":"Read","arguments":json!({"path":format!("file-{turn}-{call}")}).to_string()}}),
                );
                write(
                    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":{"content":"x".repeat(result_bytes)}}}),
                );
                messages += 2;
                tools += 1;
            }
        } else {
            write(
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"durable conversation text. ".repeat(13)}}),
            );
            messages += 1;
        }
    }
    file.flush().unwrap();
    file.get_ref().sync_all().unwrap();
    json!({"history_raw_records":raw_records,"history_imported_messages":messages,"history_tool_results":tools})
}

fn configuration(workspace: &Path, source: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en","tools":[],"automaticTitles":false,
        "workspaceRoots":[{"label":"Disposable workspace","path":workspace}],
        "importRoots":[{"label":"Pristine CLI fixture","path":source}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
    }))
    .unwrap()
}

async fn imported(f: &NativeFixture, workspace: &Path, counts: &Value) -> (String, RunId) {
    let roots = f
        .query("importDirectories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let sources = f.mutation_value("import", json!({"kind":"save_source","revision":0,"id":null,"name":"Pristine long history","location":{"kind":"codex","path":roots["roots"][0]["path"]}})).await.unwrap();
    assert_eq!(sources["kind"], "sources");
    let source = json!({"id":sources["sources"][0]["id"],"revision":sources["revision"]});
    let catalog = f.query("imports", json!({"kind":"catalog","source":source,"query":{"text":"","includeArchived":false,"cursor":null}})).await.unwrap();
    let entries = catalog["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let preview = f.query("imports", json!({"kind":"preview","source":source,"entry":{"sessionId":entries[0]["id"],"path":entries[0]["path"]},"digest":null,"after":0})).await.unwrap();
    assert_eq!(preview["kind"], "preview");
    assert_eq!(
        preview["preview"]["records"],
        counts["history_imported_messages"]
    );
    let destinations = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let workspace = workspace.canonicalize().unwrap();
    let target = destinations["roots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|root| root["path"].as_str() == workspace.to_str())
        .expect("configured disposable destination root");
    let copied = f.mutation_value("import", json!({"kind":"copy","selection":preview["preview"]["selection"],"path":target["path"],"title":"Long-task fixture"})).await.unwrap();
    assert_eq!(copied["kind"], "imported");
    let session = copied["session"]["id"].as_str().unwrap().to_owned();
    let runs = f.state.runs(session.clone(), None, 16).await.unwrap();
    assert_eq!(runs.len(), 1);
    let marker = f.state.frontier(runs[0]).await.unwrap();
    assert!(matches!(marker.spec.backend, BackendSpec::Historical {}));
    assert!(matches!(marker.spec.origin, RunOrigin::Imported { .. }));
    assert_eq!(marker.terminal, Some(Terminal::Completed));
    assert!(
        marker.attempts.is_empty() && marker.tools.is_empty(),
        "foreign history cannot execute"
    );
    assert!(
        f.state
            .queue()
            .read(session.clone())
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    (session, marker.run)
}

async fn delivered(f: &NativeFixture, session: &str, sent: SendResult) -> RunId {
    let SendResult::Queued { message_id, .. } = sent else {
        panic!("SDK send must return the original Queued receipt")
    };
    let mut changes = f.state.subscribe().unwrap();
    loop {
        changes.borrow_and_update();
        match f
            .state
            .queue()
            .resolve_message(session.into(), message_id.clone())
            .await
            .unwrap()
        {
            MessageResolution::Delivered { run, shared: false } => return run,
            MessageResolution::Pending => changes.changed().await.unwrap(),
            other => panic!("original message was not delivered exactly once: {other:?}"),
        }
    }
}

async fn line(socket: &mut TcpStream, limit: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n") {
        assert!(bytes.len() < limit);
        bytes.push(socket.read_u8().await.unwrap());
    }
    bytes
}

async fn read_request(socket: &mut TcpStream) -> Value {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        assert!(header.len() < 64 * 1024);
        header.push(socket.read_u8().await.unwrap());
    }
    let header = String::from_utf8(header).unwrap();
    assert!(header.starts_with("POST /v1/chat/completions "));
    let chunked = header.lines().any(|line| {
        line.split_once(':').is_some_and(|(key, value)| {
            key.eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
        })
    });
    let mut body = Vec::new();
    if chunked {
        loop {
            let size = line(socket, 1024).await;
            let size = usize::from_str_radix(
                std::str::from_utf8(&size)
                    .unwrap()
                    .trim()
                    .split(';')
                    .next()
                    .unwrap(),
                16,
            )
            .unwrap();
            assert!(
                size <= MAX_REQUEST_BYTES - body.len(),
                "request exceeds 16 MiB fixture limit"
            );
            if size == 0 {
                assert_eq!(line(socket, 2).await, b"\r\n");
                break;
            }
            let start = body.len();
            body.resize(start + size, 0);
            socket.read_exact(&mut body[start..]).await.unwrap();
            assert_eq!(line(socket, 2).await, b"\r\n");
        }
    } else {
        let size: usize = header
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(key, value)| {
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
            })
            .expect("HTTP request length");
        assert!(
            size <= MAX_REQUEST_BYTES,
            "request exceeds 16 MiB fixture limit"
        );
        body.resize(size, 0);
        socket.read_exact(&mut body).await.unwrap();
    }
    serde_json::from_slice(&body).unwrap()
}

async fn facts(f: &NativeFixture, run: RunId) -> Vec<maka_agent_facts::durable::RecordedFact> {
    let mut after = 0;
    let mut result = Vec::new();
    loop {
        let page = f.state.history(run, after, 256).await.unwrap();
        let full = page.len() == 256;
        if let Some(last) = page.last() {
            after = last.revision;
        }
        result.extend(page);
        if !full {
            return result;
        }
    }
}

async fn compact(
    f: &NativeFixture,
    session: &str,
    model: &ModelSelection,
    listener: &TcpListener,
    through_turn: usize,
) {
    println!(
        "{}",
        json!({"phase":"compact_start","through_turn":through_turn})
    );
    let (summary, ()) = tokio::join!(
        async {
            let value = f
                .mutation_value("compact", json!({"sessionId":session,"model":model}))
                .await
                .unwrap();
            let CompactResult::Started { execution } = serde_json::from_value(value).unwrap()
            else {
                panic!("actual SDK compact did not start")
            };
            f.wait_terminal(execution.run_id).await.unwrap()
        },
        async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            assert!(request["messages"].as_array().unwrap().len() > 1);
            respond(&mut socket, SUMMARY, "stop").await;
        }
    );
    assert_eq!(summary.terminal, Some(Terminal::Completed));
    assert!(summary.baseline.is_some());
    assert!(
        facts(f, summary.run)
            .await
            .iter()
            .any(|recorded| matches!(recorded.fact, Fact::ContextCompacted { .. }))
    );
    println!(
        "{}",
        json!({"phase":"compact_done","through_turn":through_turn})
    );
}

fn storage_bytes(path: &Path) -> (u64, u64) {
    let database = path.join("root").join(maka_event_log::root::ROOT_DATABASE);
    let bytes = std::fs::metadata(&database).unwrap().len();
    let wal = PathBuf::from(format!("{}-wal", database.to_str().unwrap()));
    let wal_bytes = match std::fs::metadata(wal) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => panic!("Root WAL metadata: {error}"),
    };
    assert!(bytes > 0);
    (bytes, wal_bytes)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release performance harness: creates disposable long histories"]
#[allow(clippy::assertions_on_constants)]
async fn engine_long_history() {
    assert!(
        !cfg!(debug_assertions),
        "run this performance harness with --release"
    );
    let turns: Vec<usize> = std::env::var("MAKA_ENGINE_PERF_TURNS")
        .unwrap_or_else(|_| "250,1000".into())
        .split(',')
        .map(|value| value.trim().parse().expect("comma-separated turn counts"))
        .collect();
    let repetitions = setting("MAKA_ENGINE_PERF_REPETITIONS", 5);
    let result_bytes = setting("MAKA_ENGINE_PERF_RESULT_BYTES", 128);
    let tool_every = setting("MAKA_ENGINE_PERF_TOOL_EVERY", 20);
    let tools_per_turn = setting("MAKA_ENGINE_PERF_TOOLS_PER_TURN", 1);
    let checkpoint = setting("MAKA_ENGINE_PERF_CHECKPOINT", 0) == 1;
    assert!(tool_every > 0 && tools_per_turn > 0);
    assert!(repetitions > 0 && !turns.is_empty() && turns.iter().all(|turns| *turns > 0));
    let cache = cache_directory();
    let tag = cache.as_ref().map(|_| {
        std::env::var("MAKA_ENGINE_PERF_FIXTURE_TAG")
            .expect("cached fixtures require an explicit revision tag")
    });
    let source_fingerprint = hex::encode(Sha256::digest(include_bytes!("long_task_perf.rs")));
    println!(
        "{}",
        json!({"phase":"case_map","measurementVersion":2,
        "retired":["engine-only Engine::run timings","legacy EventLog cache bundles","legacy seeded runtime event count"],
        "active":"public Native SDK send to HTTP and same canonical Run terminal; includes Host admission and queue",
        "unavailable":"checkpoint=true with turns>1000: public CLI copy cannot append to the same compacted session; no synthetic checkpoint chain"})
    );
    for turns in turns {
        assert!(
            !checkpoint || turns <= 1000,
            "multi-checkpoint imported seed is unavailable; do not substitute only the final checkpoint"
        );
        let settings = json!({"turns":turns,"result_bytes":result_bytes,"tool_every":tool_every,"tools_per_turn":tools_per_turn,"checkpoint":checkpoint,"fixture_tag":tag,"source_fingerprint":source_fingerprint,"compact_every":1000,"cache_format":CACHE_FORMAT,"measurementVersion":2});
        let cached = cache.as_ref().map(|directory| {
            let key = hex::encode(Sha256::digest(serde_json::to_vec(&settings).unwrap()));
            let bundle = directory.join(format!("native-sdk-{key}.bundle"));
            let metadata = directory.join(format!("native-sdk-{key}.json"));
            if !bundle.exists() && !metadata.exists() {
                let counts = seed(&bundle, turns, result_bytes, tool_every, tools_per_turn);
                let record = json!({"format":CACHE_FORMAT,"settings":settings,"counts":counts,"sha256":fingerprint(&bundle)});
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&metadata).unwrap();
                serde_json::to_writer(&mut file, &record).unwrap(); file.sync_all().unwrap();
            }
            assert!(bundle.is_file() && metadata.is_file(), "incomplete fixture cache; use a fresh cache directory");
            let record: Value = serde_json::from_reader(File::open(metadata).unwrap()).unwrap();
            assert_eq!(record["format"], CACHE_FORMAT);
            assert_eq!(record["settings"], settings, "fixture settings mismatch");
            assert_eq!(record["sha256"].as_str().unwrap(), fingerprint(&bundle));
            (bundle, record["counts"].clone())
        });
        for repetition in 0..repetitions {
            let directory = tempfile::tempdir().unwrap();
            let workspace = directory.path().join("workspace");
            let source = directory.path().join("foreign");
            let transcript = source.join("sessions/2026/rollout-perf.jsonl");
            std::fs::create_dir(&workspace).unwrap();
            std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
            println!(
                "{}",
                json!({"phase":"seed_start","history_turns":turns,"checkpoint":checkpoint})
            );
            let setup = Instant::now();
            let counts = if let Some((bundle, counts)) = &cached {
                std::fs::copy(bundle, &transcript).unwrap();
                counts.clone()
            } else {
                seed(&transcript, turns, result_bytes, tool_every, tools_per_turn)
            };
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let opened = Instant::now();
            let f = NativeFixture::open(directory.path(), configuration(&workspace, &source))
                .await
                .unwrap();
            let store_open_ms = opened.elapsed().as_secs_f64() * 1000.0;
            let model = f.configure_model(&base, "test", "fixture").await.unwrap();
            println!(
                "{}",
                json!({"phase":"fixture_import_start","history_turns":turns,"repetition":repetition})
            );
            let (session, marker) = imported(&f, &workspace, &counts).await;
            println!(
                "{}",
                json!({"phase":"fixture_import_done","history_turns":turns,"repetition":repetition})
            );
            if checkpoint {
                tokio::time::timeout(
                    Duration::from_secs(300),
                    compact(&f, &session, &model, &listener, turns),
                )
                .await
                .expect("compact timed out");
            }
            println!(
                "{}",
                json!({"phase":"seed_done","history_turns":turns,"setup_ms":setup.elapsed().as_secs_f64()*1000.0})
            );
            let history_canonical_facts = facts(&f, marker).await.len();
            let (database_bytes, database_wal_bytes) = storage_bytes(directory.path());
            println!(
                "{}",
                json!({"phase":"measure_start","history_turns":turns,"checkpoint":checkpoint,"repetition":repetition})
            );
            // This interval intentionally includes the real SDK and queue, unlike version 1.
            let started = Instant::now();
            let ((run, terminal), wire) = tokio::time::timeout(Duration::from_secs(300), async {
                tokio::join!(
                    async {
                        let sent = f
                            .send(
                                &session,
                                "question-measured",
                                Some(BackendPreference::Model {
                                    connection_id: model.connection_id.clone(),
                                    model_id: model.model_id.clone(),
                                    thinking_level: None,
                                }),
                            )
                            .await
                            .unwrap();
                        let run = delivered(&f, &session, sent).await;
                        let terminal = f.wait_terminal(run).await.unwrap();
                        (run, terminal)
                    },
                    async {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let request = read_request(&mut socket).await;
                        let receipt_ms = started.elapsed().as_secs_f64() * 1000.0;
                        let messages = request["messages"].to_string();
                        assert!(messages.contains("question-measured"));
                        if checkpoint {
                            assert!(messages.contains("summary-marker"));
                        } else {
                            assert!(messages.contains("question-history-0"));
                            assert!(messages.contains(&format!("question-history-{}", turns - 1)));
                        }
                        let rows = request["messages"].as_array().unwrap();
                        let tools = rows
                            .iter()
                            .filter(|message| message["role"] == "tool")
                            .count();
                        let bytes = serde_json::to_vec(&request).unwrap().len();
                        assert!(bytes <= MAX_REQUEST_BYTES);
                        if !checkpoint {
                            assert_eq!(
                                tools as u64,
                                counts["history_tool_results"].as_u64().unwrap()
                            );
                        }
                        respond(&mut socket, "benchmark-done", "stop").await;
                        (receipt_ms, bytes, messages.len(), rows.len(), tools)
                    }
                )
            })
            .await
            .expect("Native SDK Run timed out");
            let completion_ms = started.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{}",
                json!({"phase":"measure_done","history_turns":turns,"repetition":repetition})
            );
            assert_eq!(terminal.run, run);
            assert_eq!(terminal.terminal, Some(Terminal::Completed));
            assert_eq!(
                terminal.attempts.len(),
                1,
                "only one measured model request"
            );
            let recorded = facts(&f, run).await;
            assert!(recorded.len() <= 512, "unexpectedly large measured Run");
            assert!(
                serde_json::to_vec(&recorded).unwrap().len() <= 1024 * 1024,
                "measured canonical page exceeds 1 MiB"
            );
            assert!(recorded.iter().any(|recorded| matches!(&recorded.fact, Fact::ModelObserved { part:ModelPart::Text { text, .. }, .. } if text.chunks().collect::<String>().contains("benchmark-done"))));
            assert!(
                tokio::time::timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err(),
                "measured request must not be replayed"
            );
            let (receipt_ms, request_bytes, message_bytes, message_count, tool_message_count) =
                wire;
            println!(
                "{}",
                json!({
                    "benchmark":"native_sdk_long_history","measurementVersion":2,"checkpoint":checkpoint,
                    "timing_scope":"Native SDK send, Host admission, queue delivery through same Run terminal",
                    "history_turns":turns,"history_raw_records":counts["history_raw_records"],"history_imported_messages":counts["history_imported_messages"],"history_canonical_facts":history_canonical_facts,
                    "history_tool_results":counts["history_tool_results"],"tool_every":tool_every,"tools_per_turn":tools_per_turn,"tool_result_content_bytes":result_bytes,
                    "repetition":repetition,"native_sdk_request_receipt_ms":receipt_ms,"native_sdk_completion_ms":completion_ms,"request_bytes":request_bytes,
                    "store_open_ms":store_open_ms,"database_bytes":database_bytes,"database_wal_bytes":database_wal_bytes,"fixture_cached":cached.is_some(),"fixture_cache_format":CACHE_FORMAT,
                    "request_messages":message_count,"request_tool_messages":tool_message_count,
                    "message_bytes_div_3_proxy":message_bytes.div_ceil(3),"outcome":"completed","errors":0,
                })
            );
            f.shutdown().await.unwrap();
        }
    }
}
