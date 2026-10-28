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

//! Opt-in release acceptance probes. H is canonical turns per Session, W is
//! concurrent work. One Root and Engine survive every checkpoint; no raw
//! database copies or replacement writer.
//! Sampling and fixture construction are outside reported operation intervals.
//! JSON rows are streamed, never accumulated into a history-sized load-driver Vec.
mod sampling;

use crate::support::{context as fixture, store::RootFixture};
use futures_util::future::join_all;
use maka_agent_engine::{Engine, RunInput, RunWork};
use maka_agent_facts::{
    context::{CompactOutcome, ModelPurpose, ModelRequestContext},
    event::{EventWrite, Fact, Invocation, InvocationOutcome, LogScope, RuntimeEvent},
    model::{ModelEvent, ModelFinishReason, ModelUsage, TextKind, assembly::StepBuilder},
};
use maka_event_log::{
    SessionStore,
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use sampling::{Echo, StepGate};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::{Barrier, oneshot},
};
use tokio_util::sync::CancellationToken;

fn number(name: &str, default: usize) -> usize {
    std::env::var(name).map_or(default, |v| v.parse().expect("integer setting"))
}
fn correctness_smoke() -> bool {
    std::env::var("MAKA_LONGEVITY_SMOKE").ok().as_deref() == Some("1")
}
fn sqlite_stats() -> bool {
    std::env::var("MAKA_LONGEVITY_SQLITE_STATS").ok().as_deref() == Some("1")
}
fn retain_fixture() -> bool {
    std::env::var("MAKA_LONGEVITY_RETAIN_FIXTURE")
        .ok()
        .as_deref()
        == Some("1")
}
fn source_fences(stores: &[SessionStore]) -> BTreeMap<String, u64> {
    stores
        .iter()
        .map(|store| (store.id().to_owned(), high_water(store)))
        .collect()
}
fn source_fingerprint() -> String {
    hex::encode(Sha256::digest(include_bytes!("session_longevity.rs")))
}
fn sampling_fingerprint() -> String {
    hex::encode(Sha256::digest(include_bytes!(
        "session_longevity/sampling.rs"
    )))
}
fn emit(value: Value) {
    println!("MAKA_SESSION_LONGEVITY {value}");
}
fn identity(session: &str, kind: &str, id: impl std::fmt::Display) -> String {
    format!("{session}__{kind}__{id}")
}
fn input(base: &str, session: &str, id: &str, compact: bool) -> RunInput {
    let mut input = fixture::input(base, &identity(session, "request", id), compact);
    // Journals are shared by Sessions mapped to the same fixed partition.
    // Keep every identity explicit instead of inheriting fixture-wide defaults.
    input.invocation = Invocation {
        session_id: session.into(),
        turn_id: identity(session, "turn", id),
        run_id: identity(session, "run", id),
        invocation_id: identity(session, "invocation", id),
    };
    input
}
fn high_water(store: &SessionStore) -> u64 {
    *store.subscribe_commits().unwrap().borrow()
}

// Valid streamed, closed historical turns, committed in bounded batches. This
// models canonical history without paying one synthetic HTTP roundtrip per turn.
async fn seed(store: &SessionStore, start: usize, end: usize) {
    for start in (start..end).step_by(16) {
        let before = high_water(store);
        let mut writes = Vec::with_capacity(128);
        for turn in start..(start + 16).min(end) {
            let invocation = Invocation {
                session_id: store.id().into(),
                turn_id: identity(store.id(), "seed-turn", turn),
                run_id: identity(store.id(), "seed-run", turn),
                invocation_id: identity(store.id(), "seed-invocation", turn),
            };
            let step = identity(store.id(), "seed-step", turn);
            let part = identity(store.id(), "seed-part", turn);
            let source_high_water = before + writes.len() as u64 + 1;
            let observed = [
                ModelEvent::PartStarted {
                    id: part.clone(),
                    text_kind: TextKind::Text,
                    provider_options: None,
                },
                ModelEvent::PartDelta {
                    id: part.clone(),
                    text: format!("answer-{turn}-{}", "x".repeat(128)),
                    provider_options: None,
                },
                ModelEvent::PartFinished {
                    id: part.clone(),
                    provider_options: None,
                },
                ModelEvent::Finished {
                    reason: ModelFinishReason::Stop,
                    usage: ModelUsage::default(),
                    provider_options: None,
                },
            ];
            let mut builder = StepBuilder::default();
            let mut facts = vec![
                Fact::InvocationOpened {
                    configuration: None,
                    input: maka_agent_facts::input::InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: format!("question-history-{turn}").into(),
                        request_fingerprint: None,
                    },
                },
                Fact::ModelRequested {
                    item_acceptance: true,
                    purpose: ModelPurpose::Main,
                    context: None,
                    context_breakdown: None,
                    checkpoint_event_id: None,
                    effective_source_digest: None,
                    step_id: step.clone(),
                    model_id: "test".into(),
                    source_scope: LogScope::Session {
                        id: store.id().into(),
                    },
                    source_high_water,
                    source_digest: "legacy".into(),
                    input_digest: "legacy".into(),
                    route_identity: "legacy".into(),
                },
            ];
            for event in observed {
                builder.push(event.clone()).unwrap();
                facts.push(Fact::ModelObserved {
                    step_id: step.clone(),
                    event,
                });
            }
            facts.push(Fact::ModelCompleted {
                step_id: step,
                output: builder.finish().unwrap(),
            });
            facts.push(Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            });
            for fact in facts {
                writes
                    .push(EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap());
            }
        }
        store.append_batch(&writes).await.unwrap();
    }
}

// Fixture scheduling follows the durable route. Sessions sharing a writer
// remain sequential so seed() can predict each ModelRequested source fence.
fn seed_routes(root: &Path, stores: &[SessionStore]) -> BTreeMap<i64, Vec<usize>> {
    let db = rusqlite::Connection::open_with_flags(
        root.join(maka_event_log::root::ROOT_DATABASE),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    db.busy_timeout(Duration::from_secs(2)).unwrap();
    let mut groups = BTreeMap::<i64, Vec<usize>>::new();
    for (index, store) in stores.iter().enumerate() {
        let partition: i64 = db
            .query_row(
                "SELECT partition FROM session_routes WHERE session_id=?1 AND ready=1 AND visible=1",
                [store.id()],
                |row| row.get(0),
            )
            .unwrap();
        assert!((0..8).contains(&partition));
        groups.entry(partition).or_default().push(index);
    }
    groups
}
async fn seed_partitioned(
    stores: &[SessionStore],
    routes: &BTreeMap<i64, Vec<usize>>,
    start: usize,
    end: usize,
) {
    join_all(routes.values().map(|indices| async move {
        for &index in indices {
            seed(&stores[index], start, end).await;
        }
    }))
    .await;
}

fn files(path: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            files(&entry.path(), out);
        } else if entry.file_type().unwrap().is_file() {
            out.push(entry.path());
        }
    }
}
fn scalar(db: &rusqlite::Connection, sql: &str) -> u64 {
    u64::try_from(db.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap()).unwrap()
}
fn table_exists(db: &rusqlite::Connection, table: &str) -> bool {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [table],
        |row| row.get(0),
    )
    .unwrap()
}
// External read-only connections are test observers, never the production SQL
// owners. Exact counts can scan metadata: they are deliberately outside timing.
fn snapshot(root: &Path) -> Value {
    let started = Instant::now();
    let mut paths = Vec::new();
    files(root, &mut paths);
    let mut totals = BTreeMap::<String, u64>::new();
    for path in paths {
        let name = path.file_name().unwrap().to_string_lossy();
        let kind = "canonical";
        if name.ends_with(".sqlite") || name.ends_with(".sqlite-wal") {
            let suffix = if name.ends_with("-wal") {
                "wal_bytes"
            } else {
                "db_bytes"
            };
            *totals.entry(format!("{kind}_{suffix}")).or_default() +=
                path.metadata().unwrap().len();
        }
        if !name.ends_with(".sqlite") {
            continue;
        }
        let db = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        db.busy_timeout(Duration::from_secs(2)).unwrap();
        *totals.entry(format!("{kind}_databases")).or_default() += 1;
        let page_size = scalar(&db, "PRAGMA page_size");
        *totals.entry(format!("{kind}_free_bytes")).or_default() +=
            page_size * scalar(&db, "PRAGMA freelist_count");
        if table_exists(&db, "event_log") {
            *totals.entry("canonical_events".into()).or_default() +=
                scalar(&db, "SELECT COUNT(*) FROM event_log");
        }
    }
    let rss = if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find(|l| l.starts_with("VmRSS:"))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .map(|kb| kb * 1024)
    } else {
        std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(|kb| kb * 1024)
    };
    let fd_count = std::fs::read_dir(if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    })
    .ok()
    .map(|i| i.count());
    json!({"rss_bytes":rss,"fd_count":fd_count,"storage":totals,
        "sampling_ms":started.elapsed().as_secs_f64()*1000.0,"sql_queue_backlog":null})
}
async fn sample(root: &Path, phase: &str, h: usize, w: usize) -> Value {
    let root = root.to_owned();
    let metrics = tokio::task::spawn_blocking(move || snapshot(&root))
        .await
        .unwrap();
    emit(json!({"phase":phase,"progress":h,"work_concurrency":w,"metrics":metrics}));
    metrics
}

async fn wave(engine: &Engine, stores: &[SessionStore], id: &str, compact: bool, measured: bool) {
    let ready = Arc::new(Barrier::new(stores.len()));
    let entered = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    join_all(stores.iter().enumerate().map(|(index,store)| {
        let ready = ready.clone();
        let entered = entered.clone();
        let active = active.clone();
        let peak = peak.clone();
        async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1",listener.local_addr().unwrap());
            let before = high_water(store);
            let (started_tx, started_rx) = oneshot::channel::<Instant>();
            let response_id = identity(store.id(), "wave-response", id);
            let sample_id = id.to_owned();
            let server = tokio::spawn(async move {
                let started = started_rx.await.unwrap();
                let (mut socket,_) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                let receipt = started.elapsed().as_secs_f64()*1000.0;
                let bytes = serde_json::to_vec(&request).unwrap().len();
                assert!(bytes<2*1024*1024,"fixed-window request exceeded 2 MiB");
                // The model deadline is already running. A provider must not
                // wait for unrelated Sessions to finish preparing their input.
                let response_start = started.elapsed().as_secs_f64()*1000.0;
                respond(&mut socket,&response_id,if compact { fixture::SUMMARY } else { "longevity-completed" },"stop").await;
                let response_done = started.elapsed().as_secs_f64()*1000.0;
                if compact {
                    emit(json!({"phase":"provider_reply","sample":sample_id,"session_index":index,
                        "request_receipt_ms":receipt,"response_start_ms":response_start,"response_done_ms":response_done}));
                }
                (receipt,bytes,response_start,response_done)
            });
            ready.wait().await;
            let started = Instant::now();
            entered.fetch_add(1, Ordering::SeqCst);
            let live = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(live, Ordering::SeqCst);
            started_tx.send(started).unwrap();
            let invocation = engine.run(store.clone(),input(&base,store.id(),id,compact),CancellationToken::new()).await.unwrap();
            let completed = started.elapsed().as_secs_f64()*1000.0;
            active.fetch_sub(1, Ordering::SeqCst);
            let (receipt,bytes,response_start,response_done) = server.await.unwrap();
            // Fact proof, after operation timing.
            let (_,_) = store.invocation_boundary(store.id(),&invocation.invocation_id).await.unwrap().unwrap();
            let page = store.session_events(store.id(),before,high_water(store),128,1024*1024).await.unwrap();
            let completed_fact = page.events.iter().any(|event| {
                event.event.invocation == invocation && match &event.event.fact {
                    Fact::InvocationEnded { outcome: InvocationOutcome::Completed } => !compact,
                    Fact::InvocationEnded { outcome: InvocationOutcome::ContextCompactFinished {
                        outcome: CompactOutcome::Compacted { .. }
                    }} => compact,
                    _ => false,
                }
            });
            assert!(completed_fact, "missing successful invocation: {invocation:?}; before={before}; events={:?}", page.events);
            if compact { assert!(page.events.iter().any(|event|matches!(event.event.fact,Fact::ContextCheckpointRecorded{..}))); }
            if measured { emit(json!({"phase":"measured_run","session_index":index,"sample":id,"request_receipt_ms":receipt,
                "completion_ms":completed,"request_bytes":bytes,"provider_response_start_ms":response_start,
                "provider_response_done_ms":response_done,"completed":1,"errors":0})); }
        }
    })).await;
    assert_eq!(entered.load(Ordering::SeqCst), stores.len());
    assert_eq!(peak.load(Ordering::SeqCst), stores.len());
    assert_eq!(active.load(Ordering::SeqCst), 0);
    emit(
        json!({"phase":"wave_verified","sample":id,"compact":compact,"measured":measured,
        "entered":entered.load(Ordering::SeqCst),"peak_active_runs":peak.load(Ordering::SeqCst),
        "completed":stores.len(),"errors":0}),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "release acceptance: fixed W, cumulative H in one Root/Engine"]
#[allow(clippy::assertions_on_constants)]
async fn fixed_window_history() {
    let smoke = correctness_smoke();
    assert!(
        smoke || !cfg!(debug_assertions),
        "use --release or explicit MAKA_LONGEVITY_SMOKE=1"
    );
    let w = number("MAKA_LONGEVITY_W", 4);
    let repetitions = number("MAKA_LONGEVITY_REPETITIONS", 32);
    let checkpoints: Vec<usize> = std::env::var("MAKA_LONGEVITY_H")
        .unwrap_or("1000,5000,10000".into())
        .split(',')
        .map(|x| x.parse().unwrap())
        .collect();
    assert!(
        w > 0
            && repetitions > 0
            && !checkpoints.is_empty()
            && checkpoints.windows(2).all(|v| v[0] < v[1])
    );
    if smoke {
        assert!(
            w <= 8 && repetitions <= 2 && checkpoints.iter().all(|h| *h <= 16),
            "correctness smoke must remain a tiny workload"
        );
    }
    let retain = retain_fixture();
    let mut dir = tempfile::tempdir().unwrap();
    // Preserve failed work too, but only a successful close is reusable data.
    dir.disable_cleanup(retain);
    let path = dir.path().join("events.sqlite");
    let root_path = path.with_extension("root");
    let root = RootFixture::open(&path).await.unwrap();
    let engine = fixture::engine();
    let mut stores = Vec::with_capacity(w);
    for i in 0..w {
        stores.push(
            root.create_session(&format!("session-{i}"), "longevity", &json!({}), 1)
                .await
                .unwrap(),
        );
    }
    let seed_routes = seed_routes(&root_path, &stores);
    let mut previous = 0;
    emit(
        json!({"phase":"configuration","harness_sha256":source_fingerprint(),"sampling_sha256":sampling_fingerprint(),"scenario":"fixed_window_history","correctness_smoke":smoke,"root":root_path,"fixture_directory":dir.path(),"retain_fixture":retain,"fixture_state":"incomplete","provider_synchronization":"before_engine_run","w":w,"h":checkpoints,"repetitions":repetitions,"seed_batch_turns":16,"seed_partition_groups":seed_routes,"compact_every":1000}),
    );
    for h in checkpoints {
        let setup = Instant::now();
        for start in (previous..h).step_by(1000) {
            let end = (start + 1000).min(h);
            // All partition groups finish before compaction or measured work.
            seed_partitioned(&stores, &seed_routes, start, end).await;
            wave(&engine, &stores, &format!("compact-{end}"), true, false).await;
        }
        emit(
            json!({"phase":"setup_done","history_turns_per_session":h,"setup_ms":setup.elapsed().as_secs_f64()*1000.0,
                "source_fences":source_fences(&stores)}),
        );
        sample(&root_path, "idle_sample", h, w).await;
        for r in 0..repetitions {
            wave(&engine, &stores, &format!("measure-{h}-{r}"), false, true).await;
        }
        let metrics = sample(&root_path, "idle_sample", h, w).await;
        assert_eq!(metrics["storage"]["canonical_databases"], 9);
        assert!(
            metrics["storage"]["canonical_events"].as_u64().unwrap() >= 8 * h as u64 * w as u64
        );
        if retain {
            emit(
                json!({"phase":"fixture_checkpoint","history_turns_per_session":h,"position":"after_measurement",
                "source_fences":source_fences(&stores)}),
            );
        }
        previous = h;
    }
    sample(&root_path, "idle_sample", previous, w).await;
    engine.drain().await;
    let final_fences = source_fences(&stores);
    drop(stores);
    root.shutdown().await.unwrap();
    drop(root);
    if retain {
        emit(
            json!({"phase":"fixture_retained","scenario":"fixed_window_history","fixture_directory":dir.path(),
            "root":root_path,"state":"clean_closed","includes":"seed_compaction_and_measured_events",
            "w":w,"history_turns_per_session":previous,"repetitions":repetitions,
            "source_fences":final_fences,"partition_groups":seed_routes}),
        );
    }
    emit(json!({"phase":"complete","scenario":"fixed_window_history","errors":0}));
}
async fn stream_reply(socket: &mut TcpStream, first: Value, last: Value) {
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
async fn respond(socket: &mut TcpStream, id: &str, text: &str, reason: &str) {
    let first = json!({"id":id,"object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let last = json!({"id":id,"object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":20,"completion_tokens":50,"total_tokens":70}});
    stream_reply(socket, first, last).await;
}
async fn tool_reply(socket: &mut TcpStream, session: &str, step: usize) {
    let response_id = identity(session, "same-run-tool-response", step);
    let call_id = identity(session, "same-run-call", step);
    let first = json!({"id":response_id,"object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":call_id,"type":"function","function":{"name":"echo","arguments":json!({"step":step}).to_string()}}]},"finish_reason":null}]});
    let last = json!({"id":response_id,"object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
    stream_reply(socket, first, last).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "release acceptance: one long tool Run per Session with real automatic compaction"]
#[allow(clippy::assertions_on_constants)]
async fn same_run_steps() {
    let smoke = correctness_smoke();
    assert!(
        smoke || !cfg!(debug_assertions),
        "use --release or explicit MAKA_LONGEVITY_SMOKE=1"
    );
    let w = number("MAKA_LONGEVITY_W", 4);
    let steps = number("MAKA_LONGEVITY_STEPS", 1000);
    assert!(w > 0 && steps > 0);
    if smoke {
        assert!(
            w <= 2 && steps <= 4,
            "correctness smoke must remain a tiny workload"
        );
    }
    let retain = retain_fixture();
    let mut dir = tempfile::tempdir().unwrap();
    dir.disable_cleanup(retain);
    let path = dir.path().join("events.sqlite");
    let root_path = path.with_extension("root");
    let root = RootFixture::open(&path).await.unwrap();
    let engine = fixture::engine();
    let effects = Arc::new(AtomicUsize::new(0));
    let start_gate = Arc::new(Barrier::new(w));
    let sqlite_stats = sqlite_stats();
    let sample_gate = if sqlite_stats {
        StepGate::with_sqlite_owner(root_path.clone(), w, root.store())
    } else {
        StepGate::new(root_path.clone(), w)
    };
    let mut stores = Vec::new();
    for i in 0..w {
        stores.push(
            root.create_session(&format!("session-{i}"), "steps", &json!({}), 1)
                .await
                .unwrap(),
        );
    }
    let partition_groups = seed_routes(&root_path, &stores);
    emit(
        json!({"phase":"configuration","harness_sha256":source_fingerprint(),"sampling_sha256":sampling_fingerprint(),"scenario":"same_run_steps","correctness_smoke":smoke,"sqlite_stats":sqlite_stats,"root":root_path,"fixture_directory":dir.path(),"retain_fixture":retain,"fixture_state":"incomplete","provider_synchronization":"before_engine_run","sampling_boundary":"tool_after_model_completion","partition_groups":partition_groups,"w":w,"steps":steps}),
    );
    join_all(stores.iter().enumerate().map(|(index,store)| {
        let start_gate=start_gate.clone();let sample_gate=sample_gate.clone();let effects=effects.clone();let engine=&engine;
        async move {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let session_id=store.id().to_owned();
            let (started_tx,started_rx)=oneshot::channel::<Instant>();
            let server_gate=sample_gate.clone();
            let server=tokio::spawn(async move {
                let mut main=0;let mut summaries=0;let mut previous=started_rx.await.unwrap();let mut previous_pause=0;
                loop {
                    let (mut socket,_)=listener.accept().await.unwrap();let request=fixture::read_request(&mut socket).await;
                    let raw=previous.elapsed();
                    let bytes=serde_json::to_vec(&request).unwrap().len();
                    let summary=request["messages"].to_string().contains(maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En).lines().next().unwrap());
                    assert!(bytes<2*1024*1024,"same-Run request escaped working-window bound");
                    if summary { summaries+=1;respond(&mut socket,&identity(&session_id,"same-run-summary-response",summaries),fixture::SUMMARY,"stop").await; }
                    else {
                        // A main request follows its prior Echo settlement, so
                        // that Session's pause counter is stable at receipt.
                        let pause=Duration::from_nanos(server_gate.paused_nanos(index).checked_sub(previous_pause).unwrap());
                        let receipt=raw.checked_sub(pause).expect("fixture pause must be inside the measured interval");
                        emit(json!({"phase":"step","session_index":index,"step":main,"request_receipt_ms":receipt.as_secs_f64()*1000.0,
                            "raw_request_interval_ms":raw.as_secs_f64()*1000.0,"fixture_sampling_pause_ms":pause.as_secs_f64()*1000.0,
                            "request_bytes":bytes,"summaries_served":summaries}));
                        if main==steps { respond(&mut socket,&identity(&session_id,"same-run-final-response",steps),"longevity-completed","stop").await;break; }
                        // Establish both baselines before sending a response
                        // that can cause Echo to enter the sampling gate.
                        previous=Instant::now();previous_pause=server_gate.paused_nanos(index);
                        tool_reply(&mut socket,&session_id,main).await;main+=1;
                    }
                }
                assert!(summaries>0,"automatic compaction was not exercised");(main,summaries)
            });
            let mut run=input(&base,store.id(),"same-run",false);
            run.context=Some(ModelRequestContext{provider_id:"openai".into(),context_window:Some(4096),model_context_window:Some(200_000),declared_window:Some(7)});
            run.configuration.system_prompt=Some(maka_agent_facts::execution::SystemPrompt{sources:Vec::new(),text:"main prompt pressure ".repeat(600),policy_revision:1});
            let RunWork::Message{tools,..}=&mut run.work else{unreachable!()};
            *tools=ToolCatalog::new([ToolRegistration{definition:ToolDefinition{name:"echo".into(),description:"bounded echo".into(),input_schema:json!({"type":"object"}),output_schema:None,freeform:None,provider:None},nesting:ToolNesting::Nestable,semantics:ToolSemantics::Parallel,handler:ToolHandler::Immediate(Arc::new(Echo{effects,gate:sample_gate,index}))}]).unwrap();
            start_gate.wait().await;
            started_tx.send(Instant::now()).unwrap();
            let invocation=tokio::time::timeout(Duration::from_secs(7200),engine.run(store.clone(),run,CancellationToken::new())).await.unwrap().unwrap();
            let (main,summaries)=server.await.unwrap();
            let boundary=store.invocation_boundary(store.id(),&invocation.invocation_id).await.unwrap().unwrap().0;
            assert!(matches!(boundary.state.terminal_outcome(),Some(InvocationOutcome::Completed)));
            let view=store.read_model_view(store.id(),None).await.unwrap();assert!(view.baseline.is_some(),"served summaries never became canonical checkpoints");
            let mut after=0;let through=high_water(store);let mut dispatches=0;let mut resolved=0;let mut checkpoints=0;let mut main_requests=0;
            loop {
                let page=store.session_events(store.id(),after,through,128,1024*1024).await.unwrap();
                for event in page.events {
                    assert_eq!(event.event.invocation,invocation);
                    match event.event.fact {
                        Fact::ToolDispatched{..}=>dispatches+=1,
                        Fact::ToolSettled{..}=>resolved+=1,
                        Fact::ContextCheckpointRecorded{..}=>checkpoints+=1,
                        Fact::ModelRequested{purpose:ModelPurpose::Main,..}=>main_requests+=1,
                        _=>{},
                    }
                }
                match page.next_after {Some(next)=>after=next,None=>break}
            }
            assert_eq!((dispatches,resolved,main_requests),(steps,steps,steps+1));
            assert!(checkpoints>0 && checkpoints<=summaries);
            emit(json!({"phase":"run_verified","session_index":index,"tool_steps":main,"summaries":summaries,"canonical_checkpoints":checkpoints,"canonical_tool_dispatches":dispatches,"canonical_tool_resolutions":resolved,"main_requests":main_requests,"errors":0}));
        }
    })).await;
    assert_eq!(effects.load(Ordering::Relaxed), w * steps);
    sample(&root_path, "runs_completed_sample", steps, w).await;
    engine.drain().await;
    let final_fences = source_fences(&stores);
    drop(stores);
    root.shutdown().await.unwrap();
    drop(root);
    if retain {
        emit(
            json!({"phase":"fixture_retained","scenario":"same_run_steps","fixture_directory":dir.path(),
            "root":root_path,"state":"clean_closed","includes":"tool_run_and_compaction_events",
            "w":w,"steps":steps,"source_fences":final_fences,"partition_groups":partition_groups}),
        );
    }
    emit(
        json!({"phase":"complete","scenario":"same_run_steps","verified_tool_effects":w*steps,"errors":0}),
    );
}

#[tokio::test]
#[ignore = "explicit retained fixture validation after its producer process exits"]
async fn retained_fixture_reopens() {
    let record = std::env::var("MAKA_LONGEVITY_RETAINED_RECORD").unwrap();
    let record: Value = serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
    assert_eq!(record["state"], "clean_closed");
    let directory = PathBuf::from(record["fixture_directory"].as_str().unwrap());
    let fences: BTreeMap<String, u64> =
        serde_json::from_value(record["source_fences"].clone()).unwrap();
    assert!(!fences.is_empty());
    // Reopen the original inode through normal ownership and Session routing.
    // A copied marker or a merely readable SQLite file does not satisfy this.
    let root_path = directory.join("events.root");
    assert_eq!(PathBuf::from(record["root"].as_str().unwrap()), root_path);
    assert!(root_path.is_dir(), "retained Root must already exist");
    let namespaces = RootNamespaces {
        ownership: directory.join("events.ownership"),
        control: directory.join("events.control"),
    };
    let owner = RootOwner::open(&root_path, &namespaces).unwrap();
    let root = RootStore::open(Arc::new(owner)).await.unwrap();
    for (id, through) in &fences {
        let store = root.session(id).await.unwrap();
        assert_eq!(high_water(&store), *through);
        let page = store
            .session_events(id, 0, *through, 1, 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].event.invocation.session_id, *id);
        let view = store.read_model_view(id, None).await.unwrap();
        assert_eq!(view.selection.session, *id);
        assert!(view.selection.captured_through <= *through);
    }
    root.shutdown().await.unwrap();
    drop(root);
    emit(
        json!({"phase":"retained_fixture_verified","fixture_directory":directory,
        "sessions":fences.len(),"source_fences":fences,"errors":0}),
    );
}
