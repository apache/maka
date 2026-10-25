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

//! Release-only history/cancellation probe over explicitly selected disposable
//! long_task_perf fixture bundles. Preparation and warm reads are separate.
use crate::support::context as fixture;
use crate::support::store::SessionFixture;
use maka_agent_engine::{RunError, RunWork};
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_ports::session::history::{Page, Position};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

async fn tail(log: &SessionFixture, through: u64, turns: u64) -> (f64, usize) {
    let started = Instant::now();
    let page = log
        .history_view(
            "session",
            through,
            maka_event_log::transcript::HistoryWindow {
                position: Position::Tail,
                include_thinking: false,
                view: maka_agent_ports::session::history::HistoryView::Text,
                max_bytes: 16 * 1024,
                max_chunks: Some(32),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let Page::Ready { chunks, .. } = page;
    assert!(!chunks.is_empty());
    assert!(chunks.iter().any(|chunk| {
        chunk
            .text
            .contains(&format!("question-history-{}", turns - 1))
    }));
    (elapsed, chunks.len())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release responsiveness probe over disposable long-history fixtures"]
#[allow(clippy::assertions_on_constants)]
async fn long_history_responsiveness() {
    assert!(!cfg!(debug_assertions), "run with --release");
    let paths = std::env::var("MAKA_RESPONSIVENESS_FIXTURES")
        .expect("explicit comma-separated fixture bundles required");
    let repetitions: usize = std::env::var("MAKA_RESPONSIVENESS_REPETITIONS")
        .unwrap_or("5".into())
        .parse()
        .unwrap();
    assert!(repetitions > 0);
    for source in paths.split(',').map(PathBuf::from) {
        let source = source.canonicalize().unwrap();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        assert!(
            source.starts_with(&temp)
                || source.starts_with(PathBuf::from("/tmp").canonicalize().unwrap())
        );
        let metadata: Value =
            serde_json::from_slice(&std::fs::read(source.with_extension("json")).unwrap()).unwrap();
        let turns = metadata["settings"]["turns"].as_u64().unwrap();
        assert_eq!(metadata["settings"]["checkpoint"], true);
        let prepared_directory = tempfile::tempdir().unwrap();
        let prepared = prepared_directory.path().join("prepared.sqlite");
        let log = SessionFixture::from_bundle(&prepared, &source)
            .await
            .unwrap();
        let through = *log.subscribe_commits().borrow();
        let (first_page_ms, chunks) = tail(&log, through, turns).await;
        println!(
            "{}",
            json!({"benchmark":"long_history_window", "history_turns":turns,
            "first_page_ms":first_page_ms, "chunks":chunks, "errors":0})
        );
        log.close().await.unwrap();
        for phase in [
            "before_admission_10ms",
            "before_manual_admission_10ms",
            "after_admission_10ms",
            "model",
        ] {
            for repetition in 0..repetitions {
                let directory = tempfile::tempdir().unwrap();
                let database = directory.path().join("events.sqlite");
                let log = Arc::new(
                    SessionFixture::from_bundle(&database, &source)
                        .await
                        .unwrap(),
                );
                let worker = fixture::engine();
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/v1", listener.local_addr().unwrap());
                let requests = Arc::new(AtomicUsize::new(0));
                let observed = requests.clone();
                let (ready, received) = tokio::sync::oneshot::channel();
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    fixture::read_request(&mut socket).await;
                    observed.fetch_add(1, Ordering::Relaxed);
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    let _ = ready.send(());
                    let mut bytes = Vec::new();
                    let _ = socket.read_to_end(&mut bytes).await;
                });
                let started = Instant::now();
                if phase.starts_with("before_") {
                    let cancellation = CancellationToken::new();
                    let token = cancellation.clone();
                    let engine = worker.clone();
                    let mut input = fixture::input(&base, "responsive", false);
                    let invocation = input.invocation.clone();
                    if let RunWork::Message {
                        allow_prior_unknown,
                        ..
                    } = &mut input.work
                    {
                        *allow_prior_unknown = phase == "before_manual_admission_10ms";
                    } else {
                        panic!("expected message fixture");
                    }
                    let running_store = log.store();
                    let mut starting =
                        tokio::spawn(
                            async move { engine.start(running_store, input, token).await },
                        );
                    // The timed stimulus is valid only while admission is pending.
                    tokio::select! {
                        biased;
                        _ = &mut starting => panic!("fixture admitted before cancellation stimulus"),
                        _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                    }
                    let cancel_at_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let history = tail(&log, through, turns);
                    let stop = async {
                        let started = Instant::now();
                        cancellation.cancel();
                        let result = tokio::time::timeout(Duration::from_secs(300), starting)
                            .await
                            .unwrap()
                            .unwrap();
                        let stop_ms = started.elapsed().as_secs_f64() * 1000.0;
                        assert!(matches!(result, Err(RunError::Cancelled)));
                        stop_ms
                    };
                    let ((history_ms, chunks), stop_ms) = tokio::join!(history, stop);
                    worker.drain().await;
                    server.abort();
                    let _ = server.await;
                    assert!(
                        log.invocation_boundary("session", &invocation.invocation_id)
                            .await
                            .unwrap()
                            .is_none()
                    );
                    assert_eq!(*log.subscribe_commits().borrow(), through);
                    assert_eq!(requests.load(Ordering::Relaxed), 0);
                    println!(
                        "{}",
                        json!({"benchmark":"long_history_responsiveness", "history_turns":turns,
                        "phase":phase, "repetition":repetition, "cancel_at_ms":cancel_at_ms,
                        "stop_ms":stop_ms, "concurrent_history_ms":history_ms, "chunks":chunks,
                        "model_requests":0, "outcome":"cancelled", "errors":0})
                    );
                    drop(worker);
                    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
                    continue;
                }
                let running = worker
                    .start(
                        log.store(),
                        fixture::input(&base, "responsive", false),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                let invocation = running.invocation().clone();
                if phase == "model" {
                    tokio::time::timeout(Duration::from_secs(300), received)
                        .await
                        .unwrap()
                        .unwrap();
                } else {
                    // Deliberate timed cancellation stimulus, not a readiness sleep.
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let cancel_at_ms = started.elapsed().as_secs_f64() * 1000.0;
                let history = tail(&log, through, turns);
                let cancellation = async move {
                    let started = Instant::now();
                    running.cancel();
                    let completion =
                        tokio::time::timeout(Duration::from_secs(300), running.completion())
                            .await
                            .unwrap();
                    let stop_ms = started.elapsed().as_secs_f64() * 1000.0;
                    assert!(matches!(
                        completion.result,
                        Err(RunError::Cancelled)
                            | Err(RunError::Model(maka_model::ModelError::Cancelled))
                    ));
                    assert!(completion.cleanup.is_ok());
                    stop_ms
                };
                let ((history_ms, chunks), stop_ms) = tokio::join!(history, cancellation);
                worker.drain().await;
                server.abort();
                let _ = server.await;
                let (boundary, _) = log
                    .invocation_boundary("session", &invocation.invocation_id)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(matches!(
                    boundary.state.terminal_outcome(),
                    Some(InvocationOutcome::Cancelled { .. })
                ));
                println!(
                    "{}",
                    json!({"benchmark":"long_history_responsiveness", "history_turns":turns,
                    "phase":phase, "repetition":repetition, "cancel_at_ms":cancel_at_ms,
                    "stop_ms":stop_ms, "concurrent_history_ms":history_ms, "chunks":chunks,
                    "model_requests":requests.load(Ordering::Relaxed), "outcome":"cancelled", "errors":0})
                );
                drop(worker);
                Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
            }
        }
    }
}
