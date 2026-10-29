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

//! Same Host, repeated retirement, and byte-budget queues without an all-HTTP barrier.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn prompt(index: usize, mixed: bool) -> String {
    let prefix = format!("flow:{index} ");
    let size = if mixed {
        [1024, 8192, 65536, 262144][index % 4]
    } else {
        32
    };
    format!("{prefix}{}", "p".repeat(size - prefix.len()))
}
fn delta(index: usize, mixed: bool) -> String {
    let size = if mixed {
        [16, 256, 2048, 8192][index % 4]
    } else {
        6
    };
    char::from(b'a' + (index % 26) as u8)
        .to_string()
        .repeat(size)
}
#[derive(Default)]
struct Overlap {
    active: AtomicUsize,
    peak: AtomicUsize,
}
struct Active(Arc<Overlap>);
impl Active {
    fn enter(overlap: Arc<Overlap>) -> Self {
        let active = overlap.active.fetch_add(1, Ordering::Relaxed) + 1;
        overlap.peak.fetch_max(active, Ordering::Relaxed);
        Self(overlap)
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}
async fn create(load: &Load<'_>, count: usize) -> Vec<String> {
    let input = load.fixture.create_input("Memory wave").await;
    join_all((0..count).map(|_| {
        let input = input.clone();
        async move {
            load.mutation("create", input).await["session"]["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
    }))
    .await
}
async fn send_all(load: &Load<'_>, sessions: &[String], mixed: bool) -> Vec<Value> {
    use futures_util::{StreamExt, stream};
    // Bound request-body uploads to the Host ingress window. Each Started
    // receipt releases that ingress ownership; all agents remain active while
    // their model responses are held, without a model concurrency limit.
    stream::iter(sessions.iter().enumerate())
        .map(|(index, session)| async move {
            let sent = load.send_message(session, &prompt(index, mixed)).await;
            assert_eq!(sent["kind"], "started");
            sent
        })
        .buffered(32)
        .collect()
        .await
}
async fn remove(load: &Load<'_>, sessions: &[String]) {
    for session in sessions {
        let observed = load.query("observe", json!({"sessionId":session})).await;
        let removed = load
            .mutation(
                "changeSession",
                json!({"sessionId":session,
            "expectedRevision":observed["session"]["revision"],"action":"remove"}),
            )
            .await;
        assert_eq!(removed["kind"], "removed");
    }
    load.fixture.drained().await;
}
async fn verify(load: &Load<'_>, session: &str, sent: &Value, expected: &str) {
    let execution = load
        .query(
            "execution",
            json!({"sessionId":session,"invocationId":sent["invocationId"]}),
        )
        .await;
    assert_eq!(execution["execution"]["state"], "completed");
    let mut input = json!({"sessionId":session,"position":{"kind":"start"}});
    let mut offset = 0;
    loop {
        let page = load.query("history", input.clone()).await;
        if let Some(through) = input.get("through") {
            assert_eq!(through, &page["through"]);
        }
        input["through"] = page["through"].clone();
        assert_eq!(page["kind"], "ready");
        for chunk in page["chunks"].as_array().unwrap() {
            if chunk["role"] == "assistant" {
                let text = chunk["text"].as_str().unwrap();
                let end = offset + text.len();
                assert_eq!(
                    expected.get(offset..end),
                    Some(text),
                    "durable output for {session}"
                );
                offset = end;
            }
        }
        if page["after"].is_null() {
            break;
        }
        input["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    assert_eq!(offset, expected.len());
}
async fn wave(
    load: &Load<'_>,
    listener: TcpListener,
    count: usize,
    deltas: usize,
    mixed: bool,
    index: usize,
) -> (TcpListener, Value) {
    let sessions = create(load, count).await;
    let release = CancellationToken::new();
    let overlap = Arc::new(Overlap::default());
    let observed_overlap = overlap.clone();
    let server_release = release.clone();
    let start = Instant::now();
    let cpu = usage().0;
    let server = tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let release = server_release.clone();
            let overlap = observed_overlap.clone();
            workers.spawn(async move {
                let body = request(&mut socket).await;
                let text = body["messages"].as_array().unwrap().iter()
                    .find_map(|message| message["content"].as_str().filter(|text| text.starts_with("flow:"))).unwrap();
                let index: usize = text[5..].split_once(' ').unwrap().0.parse().unwrap();
                assert_eq!(text, prompt(index, mixed));
                drop(body);
                let _active = Active::enter(overlap);
                release.cancelled().await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                let chunk = json!({"id":"flow", "choices":[{"index":0,"delta":{"content":delta(index,mixed)},"finish_reason":null}]});
                let chunk = format!("data: {chunk}\n\n");
                for _ in 0..deltas {
                    socket.write_all(chunk.as_bytes()).await.unwrap();
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                socket.write_all(b"data: {\"id\":\"flow\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").await.unwrap();
            });
        }
        while let Some(result) = workers.join_next().await {
            result.unwrap();
        }
        listener
    });
    let sends = send_all(load, &sessions, mixed).await;
    assert_eq!(load.fixture.owner.runs.lock().await.controls.len(), count);
    let admission_ms = start.elapsed().as_secs_f64() * 1000.0;
    memory_checkpoint(&format!("wave_{index}_all_admitted"));
    release.cancel();
    let streaming = Instant::now();
    let mut probes = Vec::new();
    loop {
        let probe = Instant::now();
        load.query("observe", json!({"sessionId":sessions[0]}))
            .await;
        probes.push(probe.elapsed().as_secs_f64() * 1000.0);
        if load.fixture.owner.workers.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let listener = server.await.unwrap();
    let streaming_ms = streaming.elapsed().as_secs_f64() * 1000.0;
    let cpu_seconds = usage().0 - cpu;
    memory_checkpoint(&format!("wave_{index}_output_settled"));
    let mut verified_bytes = 0;
    for (index, (session, sent)) in sessions.iter().zip(&sends).enumerate() {
        let expected = delta(index, mixed).repeat(deltas);
        verify(load, session, sent, &expected).await;
        verified_bytes += expected.len();
    }
    remove(load, &sessions).await;
    // Fixed idle observation window, not synchronization for correctness.
    tokio::time::sleep(Duration::from_secs(1)).await;
    memory_checkpoint(&format!("wave_{index}_retired_idle"));
    assert_eq!(overlap.active.load(Ordering::Relaxed), 0);
    (
        listener,
        json!({"wave":index,"agents":count,"completed":count,"errors":0,"verified_output_bytes":verified_bytes,
        "peak_http_overlap":overlap.peak.load(Ordering::Relaxed),"all_admitted_ms":admission_ms,
        "stream_and_settle_ms":streaming_ms,"cpu_seconds":cpu_seconds,"foreground_query_ms":distribution(probes)}),
    )
}
async fn cancel_queued(
    load: &Load<'_>,
    listener: TcpListener,
    count: usize,
    mixed: bool,
) -> (TcpListener, Value) {
    let sessions = create(load, count).await;
    let stop_accepting = CancellationToken::new();
    let server_stop = stop_accepting.clone();
    let (arrived, mut arrivals) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        let mut opened = 0;
        loop {
            let accepted = tokio::select! {
                biased;
                accepted = listener.accept() => accepted.unwrap(),
                _ = server_stop.cancelled() => break,
            };
            let (mut socket, _) = accepted;
            opened += 1;
            arrived.send(()).unwrap();
            workers.spawn(async move {
                let result = tokio::io::copy(&mut socket, &mut tokio::io::sink()).await;
                if let Err(error) = result {
                    assert!(matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ));
                }
            });
        }
        while let Some(result) = workers.join_next().await {
            result.unwrap();
        }
        (listener, opened)
    });
    let sends = send_all(load, &sessions, mixed).await;
    arrivals.recv().await.unwrap();
    memory_checkpoint("cancellation_active");
    let start = Instant::now();
    join_all(
        sessions
            .iter()
            .zip(&sends)
            .map(|(session, sent)| async move {
                let stopped = load
                    .mutation(
                        "stop",
                        json!({"sessionId":session,"invocationId":sent["invocationId"]}),
                    )
                    .await;
                assert_eq!(stopped["requested"], true);
            }),
    )
    .await;
    load.fixture.drained().await;
    stop_accepting.cancel();
    let (listener, opened) = server.await.unwrap();
    assert!((1..=count).contains(&opened));
    for (session, sent) in sessions.iter().zip(&sends) {
        let state = load
            .query(
                "execution",
                json!({"sessionId":session,"invocationId":sent["invocationId"]}),
            )
            .await;
        if state["execution"]["state"] != "cancelled" {
            let boundary = load
                .fixture
                .session(session)
                .await
                .invocation_boundary(session, sent["invocationId"].as_str().unwrap())
                .await
                .map(|boundary| {
                    boundary.map(|(boundary, through)| {
                        (boundary.state.terminal_outcome().cloned(), through)
                    })
                });
            panic!(
                "expected cancelled for session {session}, invocation {}: public {state}, durable {boundary:?}",
                sent["invocationId"]
            );
        }
    }
    let cancel_ms = start.elapsed().as_secs_f64() * 1000.0;
    memory_checkpoint("cancellation_settled");
    remove(load, &sessions).await;
    let recovery = create(load, 1).await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket, "Recovered after cancellation").await;
        listener
    });
    let start = Instant::now();
    let sent = load.send(&recovery[0]).await;
    let listener = server.await.unwrap();
    load.fixture.drained().await;
    verify(load, &recovery[0], &sent, "Recovered after cancellation").await;
    let recovery_ms = start.elapsed().as_secs_f64() * 1000.0;
    remove(load, &recovery).await;
    (
        listener,
        json!({"cancelled":count,"closed_http_connections":opened,"cancel_and_settle_ms":cancel_ms,"recovery_ms":recovery_ms}),
    )
}
async fn run_flowing(count: usize, deltas: usize, waves: usize, mixed: bool) -> Value {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let fixture = Fixture::new(&base, None).await;
    let load = Load {
        fixture: &fixture,
        binding: fixture.binding(2).await,
        model: fixture.selection().await,
    };
    memory_checkpoint("host_ready");
    let mut listener = listener;
    let mut rows = Vec::new();
    for index in 1..=waves {
        let (next, row) = wave(&load, listener, count, deltas, mixed, index).await;
        listener = next;
        rows.push(row);
    }
    let (listener, cancellation) = cancel_queued(&load, listener, count, mixed).await;
    drop(listener);
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
    memory_checkpoint("shutdown");
    drop(load);
    drop(fixture);
    memory_checkpoint("dropped");
    json!({"agents":count,"scenario":"flowing","mixed_sizes":mixed,"waves":rows,"cancellation":cancellation,"errors":0,"peak_rss_bytes":usage().1})
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repeated_waves_retire_sessions_and_recover_after_queued_cancellation() {
    tokio::time::timeout(Duration::from_secs(60), run_flowing(4, 4, 2, true))
        .await
        .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit repeated real-Host memory benchmark"]
async fn real_host_agent_memory() {
    let count = std::env::var("MAKA_SCALE_AGENTS")
        .unwrap_or_else(|_| "100".into())
        .parse()
        .unwrap();
    let deltas = std::env::var("MAKA_SCALE_DELTAS")
        .unwrap_or_else(|_| "32".into())
        .parse()
        .unwrap();
    let waves = std::env::var("MAKA_SCALE_WAVES")
        .unwrap_or_else(|_| "5".into())
        .parse()
        .unwrap();
    let mixed = std::env::var_os("MAKA_SCALE_MIXED").is_some();
    assert!(count > 0 && deltas > 0 && waves > 0);
    let result = tokio::time::timeout(
        Duration::from_secs(600 * waves as u64),
        run_flowing(count, deltas, waves, mixed),
    )
    .await
    .unwrap();
    println!("MAKA_AGENT_SCALE {result}");
}
