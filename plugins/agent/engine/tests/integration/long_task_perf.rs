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

//! Ignored engine-only benchmark; no Host admission or agent.send transport.
//! Run a release test binary with --ignored --exact long_task_perf::engine_long_history --nocapture.
//! MAKA_ENGINE_PERF_TURNS=250,1000 MAKA_ENGINE_PERF_REPETITIONS=5
//! MAKA_ENGINE_PERF_CHECKPOINT=1 adds a real compact Run before each timed Run.
//! MAKA_ENGINE_PERF_TOOL_EVERY=20 MAKA_ENGINE_PERF_TOOLS_PER_TURN=1 models sparse tools.
//! Set those to 1 and 8 for dense stress; MAKA_ENGINE_PERF_RESULT_BYTES=128 controls payloads.
//! Optional MAKA_ENGINE_PERF_FIXTURE_DIR=/tmp/maka-perf and MAKA_ENGINE_PERF_FIXTURE_TAG=<revision>
//! cache pristine bundles, imported into a fresh Root for every sample. Use separate tags/directories per build.
//! Checkpoint histories compact every 1000 turns; raw requests retain the HTTP fixture's 16 MiB limit.
use crate::support::store::SessionFixture;
use crate::support::{context as fixture, image_projection::identity};
use maka_agent_facts::{
    context::ModelPurpose,
    event::{EventWrite, Fact, InvocationOutcome, LogScope, RuntimeEvent},
    input::InvocationInput,
    model::{ModelEvent, ModelFinishReason, ModelUsage, TextKind},
    tool_call::ToolCallIdentity,
    tool_output::ToolOutput,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

fn setting(name: &str, default: usize) -> usize {
    std::env::var(name).map_or(default, |value| {
        value.parse().expect("positive integer setting")
    })
}

// Tool turns follow stale_pruning; ordinary turns persist validated streamed text.
// Commit actual body receipts before the closed turn; setup stays outside measurement.
async fn seed(
    log: &SessionFixture,
    range: std::ops::Range<usize>,
    result_bytes: usize,
    tool_every: usize,
    tools_per_turn: usize,
) -> (usize, usize) {
    let mut event_count = 0;
    let mut tool_results = 0;
    for turn in range {
        let invocation = identity(&format!("history-{turn}"));
        let step = format!("step-{turn}");
        let tool_count = if turn % tool_every == 0 {
            tools_per_turn
        } else {
            0
        };
        let calls: Vec<_> = (0..tool_count)
            .map(|call| {
                json!({
                    "kind":"tool_call", "call":{
                        "id":format!("call-{turn}-{call}"), "name":"Read",
                        "input":{"kind":"json","data":{"path":format!("file-{turn}-{call}")}}, "provider_executed":false
                    }
                })
            })
            .collect();
        let mut writes = Vec::new();
        for fact in [
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: format!("question-history-{turn}").into(),
                    request_fingerprint: None,
                },
            },
            Fact::ModelRequested {
                item_acceptance: tool_count == 0,
                purpose: ModelPurpose::Main,
                context: None,
                context_breakdown: None,
                checkpoint_event_id: None,
                effective_source_digest: None,
                step_id: step.clone(),
                model_id: "test".into(),
                source_scope: LogScope::Session {
                    id: "session".into(),
                },
                source_high_water: *log.subscribe_commits().borrow() + 1,
                source_digest: "legacy".into(),
                input_digest: "legacy".into(),
                route_identity: "legacy".into(),
            },
        ] {
            writes.push(EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap());
        }
        let mut writer =
            crate::support::model_records::writer(invocation.clone(), &step, tool_count == 0);
        let observations = if tool_count > 0 {
            let parts: Vec<maka_agent_facts::model::ModelPart> =
                serde_json::from_value(json!(calls)).unwrap();
            let mut events: Vec<_> = parts
                .into_iter()
                .map(|part| match part {
                    maka_agent_facts::model::ModelPart::ToolCall { call } => {
                        ModelEvent::ToolCall(call)
                    }
                    _ => unreachable!("fixture contains tool calls"),
                })
                .collect();
            events.push(ModelEvent::Finished {
                reason: ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
            });
            events
        } else {
            let mut events = vec![ModelEvent::PartStarted {
                id: "text".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            }];
            for _ in 0..13 {
                events.push(ModelEvent::PartDelta {
                    id: "text".into(),
                    text: "durable conversation text. ".into(),
                    provider_options: None,
                });
            }
            events.push(ModelEvent::PartFinished {
                id: "text".into(),
                provider_options: None,
            });
            events.push(ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
            });
            events
        };
        writes.extend(crate::support::model_records::observations(
            &mut writer,
            observations,
        ));
        let sequences = log.append_batch(&writes).await.unwrap();
        crate::support::model_records::receipts(&mut writer, &writes, &sequences);
        event_count += writes.len();
        writes.clear();
        let completed = writer.completed().unwrap();
        assert_eq!(completed.local_call_ids().len(), tool_count);
        let output = completed.completion();
        writes.push(
            EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::ModelCompleted {
                    step_id: step.clone(),
                    output,
                },
            ))
            .unwrap(),
        );
        for call in 0..tool_count {
            let call_id = format!("call-{turn}-{call}");
            let operation = format!("{step}:{call_id}");
            writes.push(
                EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::ToolDispatched {
                        presentation: None,
                        title: None,
                        operation_id: operation.clone(),
                        call: ToolCallIdentity::provider(step.clone(), call_id),
                        name: "Read".into(),
                        input: json!({"path":format!("file-{turn}-{call}")}),
                    },
                ))
                .unwrap(),
            );
            writes.push(
                EventWrite::tool_success(
                    format!("result-{turn}-{call}"),
                    SystemTime::now(),
                    invocation.clone(),
                    operation,
                    ToolOutput::Json(json!({"content":"x".repeat(result_bytes)})).into(),
                )
                .unwrap()
                .0,
            );
        }
        writes.push(
            EventWrite::plain(RuntimeEvent::new(
                invocation,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            ))
            .unwrap(),
        );
        event_count += writes.len();
        tool_results += tool_count;
        log.append_batch(&writes).await.unwrap();
    }
    (event_count, tool_results)
}

// Only fixture setup uses compaction; never include it in the measured Run.
async fn compact(worker: &maka_agent_engine::Engine, log: &SessionFixture, through_turn: usize) {
    println!(
        "{}",
        json!({"phase":"compact_start", "through_turn":through_turn})
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut socket).await;
        assert!(request["messages"].as_array().unwrap().len() > 1);
        fixture::respond(&mut socket, fixture::SUMMARY, "stop").await;
    });
    let before = *log.subscribe_commits().borrow();
    let invocation = tokio::time::timeout(
        Duration::from_secs(300),
        worker.run(
            log.store(),
            fixture::input(&base, &format!("compact-{through_turn}"), true),
            CancellationToken::new(),
        ),
    )
    .await
    .expect("compact timed out")
    .expect("compact failed");
    server.await.unwrap();
    let through = *log.subscribe_commits().borrow();
    let page = log
        .session_events("session", before, through, 512, 1024 * 1024)
        .await
        .unwrap();
    assert!(page.next_after.is_none(), "unexpectedly large compact Run");
    assert!(
        page.events
            .iter()
            .any(|event| event.event.invocation == invocation
                && matches!(event.event.fact, Fact::ContextCheckpointRecorded { .. }))
    );
    println!(
        "{}",
        json!({"phase":"compact_done", "through_turn":through_turn})
    );
}

async fn prepare(
    log: &Arc<SessionFixture>,
    turns: usize,
    result_bytes: usize,
    tool_every: usize,
    tools_per_turn: usize,
    checkpoint: bool,
) -> (usize, usize) {
    println!(
        "{}",
        json!({"phase":"seed_start", "history_turns":turns, "checkpoint":checkpoint})
    );
    let started = Instant::now();
    let worker = fixture::engine();
    let mut counts = (0, 0);
    for start in (0..turns).step_by(1000) {
        let end = (start + 1000).min(turns);
        let batch = seed(log, start..end, result_bytes, tool_every, tools_per_turn).await;
        counts.0 += batch.0;
        counts.1 += batch.1;
        if checkpoint {
            compact(&worker, log, end).await;
        }
        println!(
            "{}",
            json!({"phase":"seed_progress", "history_turns":end, "history_events":counts.0})
        );
    }
    worker.drain().await;
    println!(
        "{}",
        json!({"phase":"seed_done", "history_turns":turns, "setup_ms":started.elapsed().as_secs_f64()*1000.0})
    );
    counts
}

fn cache_directory() -> Option<PathBuf> {
    let directory = PathBuf::from(std::env::var_os("MAKA_ENGINE_PERF_FIXTURE_DIR")?);
    // Never accept an application-data location for benchmark fixture caches.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release performance harness: creates disposable long histories"]
#[allow(clippy::assertions_on_constants)] // Compile in debug; reject only execution.
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
    assert!(tool_every > 0 && tools_per_turn > 0);
    let checkpoint = setting("MAKA_ENGINE_PERF_CHECKPOINT", 0) == 1;
    assert!(repetitions > 0 && turns.iter().all(|turns| *turns > 0));
    let cache = cache_directory();
    let tag = cache.as_ref().map(|_| {
        std::env::var("MAKA_ENGINE_PERF_FIXTURE_TAG")
            .expect("cached fixtures require an explicit revision tag")
    });
    let source_fingerprint = hex::encode(Sha256::digest(include_bytes!("long_task_perf.rs")));
    for turns in turns {
        let settings = json!({"turns":turns, "result_bytes":result_bytes, "tool_every":tool_every,
            "tools_per_turn":tools_per_turn, "checkpoint":checkpoint, "fixture_tag":tag,
            "source_fingerprint":source_fingerprint, "compact_every":1000});
        let cache_paths = cache.as_ref().map(|directory| {
            let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&settings).unwrap()));
            let stem = format!(
                "engine-t{turns}-b{result_bytes}-e{tool_every}-n{tools_per_turn}-c{}-{fingerprint}",
                usize::from(checkpoint)
            );
            (
                directory.join(format!("{stem}.bundle")),
                directory.join(format!("{stem}.json")),
            )
        });
        if let Some((database, metadata)) = &cache_paths {
            if !database.exists() && !metadata.exists() {
                let staging = tempfile::tempdir_in(cache.as_ref().unwrap()).unwrap();
                let staging_database = staging.path().join("events.sqlite");
                let log = Arc::new(SessionFixture::open(&staging_database).await.unwrap());
                let (events, tools) = prepare(
                    &log,
                    turns,
                    result_bytes,
                    tool_every,
                    tools_per_turn,
                    checkpoint,
                )
                .await;
                let high_water = *log.subscribe_commits().borrow();
                log.write_bundle(database).await.unwrap();
                Arc::try_unwrap(log)
                    .ok()
                    .expect("fixture still has owners")
                    .close()
                    .await
                    .unwrap();
                let record = json!({"settings":settings, "history_events":events, "history_tool_results":tools, "high_water":high_water});
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(metadata)
                    .unwrap();
                file.write_all(serde_json::to_string(&record).unwrap().as_bytes())
                    .unwrap();
                file.sync_all().unwrap();
            }
            assert!(
                database.is_file() && metadata.is_file(),
                "incomplete fixture cache; use a fresh cache directory"
            );
            let record: Value = serde_json::from_slice(&std::fs::read(metadata).unwrap()).unwrap();
            assert_eq!(record["settings"], settings, "fixture settings mismatch");
        }
        for repetition in 0..repetitions {
            let directory = tempfile::tempdir().unwrap();
            let database = directory.path().join("events.sqlite");
            let cached = cache_paths.as_ref().map(|(_source, metadata)| {
                let record: Value =
                    serde_json::from_slice(&std::fs::read(metadata).unwrap()).unwrap();
                record
            });
            let open_started = Instant::now();
            let log = Arc::new(if let Some((source, _)) = &cache_paths {
                println!(
                    "{}",
                    json!({"phase":"fixture_import_start", "history_turns":turns, "repetition":repetition})
                );
                let fixture = SessionFixture::from_bundle(&database, source)
                    .await
                    .expect("fixture bundle import failed");
                println!(
                    "{}",
                    json!({"phase":"fixture_import_done", "history_turns":turns, "repetition":repetition})
                );
                fixture
            } else {
                SessionFixture::open(&database)
                    .await
                    .expect("fixture Root open/schema validation failed")
            });
            let store_open_ms = open_started.elapsed().as_secs_f64() * 1000.0;
            let (history_events, history_tool_results) = if let Some(record) = cached {
                assert_eq!(
                    *log.subscribe_commits().borrow(),
                    record["high_water"].as_u64().unwrap()
                );
                (
                    record["history_events"].as_u64().unwrap() as usize,
                    record["history_tool_results"].as_u64().unwrap() as usize,
                )
            } else {
                prepare(
                    &log,
                    turns,
                    result_bytes,
                    tool_every,
                    tools_per_turn,
                    checkpoint,
                )
                .await
            };
            let (last, _) = log
                .invocation_boundary("session", &format!("invocation-history-{}", turns - 1))
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                last.state.terminal_outcome(),
                Some(InvocationOutcome::Completed)
            ));
            let (database_bytes, database_wal_bytes) = log.storage_bytes();
            let worker = fixture::engine();
            let before = *log.subscribe_commits().borrow();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let input = fixture::input(&base, "measured", false);
            println!(
                "{}",
                json!({"phase":"measure_start", "history_turns":turns, "checkpoint":checkpoint, "repetition":repetition})
            );
            let started = Instant::now();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                let receipt_ms = started.elapsed().as_secs_f64() * 1000.0;
                let messages = request["messages"].to_string();
                assert!(messages.contains("question-measured"));
                if checkpoint {
                    assert!(messages.contains("summary-marker"));
                } else {
                    assert!(messages.contains("question-history-0"));
                    assert!(messages.contains(&format!("question-history-{}", turns - 1)));
                }
                let message_count = request["messages"].as_array().unwrap().len();
                let tool_message_count = request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|message| message["role"] == "tool")
                    .count();
                let bytes = serde_json::to_vec(&request).unwrap().len();
                fixture::respond(&mut socket, "benchmark-done", "stop").await;
                (
                    receipt_ms,
                    bytes,
                    messages.len(),
                    message_count,
                    tool_message_count,
                )
            });
            let invocation = tokio::time::timeout(
                Duration::from_secs(300),
                worker.run(log.store(), input, CancellationToken::new()),
            )
            .await
            .expect("engine Run timed out")
            .expect("engine Run failed");
            let completion_ms = started.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{}",
                json!({"phase":"measure_done", "history_turns":turns, "repetition":repetition})
            );
            let (receipt_ms, request_bytes, message_bytes, message_count, tool_message_count) =
                server.await.unwrap();
            worker.drain().await;
            // Verification deliberately outside measured interval. run() success alone is insufficient.
            let (boundary, _) = log
                .invocation_boundary("session", &invocation.invocation_id)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                boundary.state.terminal_outcome(),
                Some(InvocationOutcome::Completed)
            ));
            let through = *log.subscribe_commits().borrow();
            let page = log
                .session_events("session", before, through, 512, 1024 * 1024)
                .await
                .unwrap();
            assert!(page.next_after.is_none(), "unexpectedly large measured Run");
            assert!(page.events.iter().any(|event| {
                event.event.invocation == invocation
                    && match &event.event.fact {
                        Fact::ModelCompleted { output, .. } => serde_json::to_string(output)
                            .unwrap()
                            .contains("benchmark-done"),
                        _ => false,
                    }
            }));
            println!(
                "{}",
                json!({
                    "benchmark":"engine_long_history", "checkpoint":checkpoint,
                    "history_turns":turns, "history_events":history_events,
                    "history_tool_results":history_tool_results, "tool_every":tool_every, "tools_per_turn":tools_per_turn, "tool_result_content_bytes":result_bytes,
                    "repetition":repetition, "request_receipt_ms":receipt_ms,
                    "engine_completion_ms":completion_ms, "request_bytes":request_bytes,
                    "store_open_ms":store_open_ms, "database_bytes":database_bytes, "database_wal_bytes":database_wal_bytes, "fixture_cached":cache.is_some(),
                    "request_messages":message_count, "request_tool_messages":tool_message_count,
                    // A wire-size proxy, not model tokenizer output or fake server's fixed usage.
                    "message_bytes_div_3_proxy":message_bytes.div_ceil(3),
                    "outcome":"completed", "errors":0,
                })
            );
        }
    }
}
