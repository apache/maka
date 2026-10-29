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

//! Real Host + native owner + native provider load, with no billable model.
use super::*;
use futures_util::future::join_all;
use std::time::Instant;

fn distribution(mut samples: Vec<f64>) -> Value {
    samples.sort_by(f64::total_cmp);
    let at = |q: f64| samples[((samples.len() - 1) as f64 * q).ceil() as usize];
    json!({"samples": samples.len(), "p50": at(0.5), "p95": at(0.95), "p99": at(0.99), "max": at(1.0)})
}

fn usage() -> (f64, u64) {
    // Process-wide counters include the local server; no external load generator
    // is hidden from CPU or peak-memory accounting.
    let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) },
        0
    );
    let value = unsafe { value.assume_init() };
    let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.0;
    let peak = value.ru_maxrss as u64;
    #[cfg(not(target_os = "macos"))]
    let peak = peak * 1024;
    (seconds(value.ru_utime) + seconds(value.ru_stime), peak)
}

// An opt-in profiler rendezvous, outside the performance measurement protocol.
// The driver snapshots this process, then writes one byte to resume the phase.
fn memory_checkpoint(phase: &str) {
    if std::env::var_os("MAKA_SCALE_MEMORY_PROFILE").is_none() {
        return;
    }
    eprintln!("MAKA_AGENT_MEMORY {phase}");
    std::io::Read::read_exact(&mut std::io::stdin(), &mut [0]).unwrap();
}

// Product callers capture bindings once per activation. Rebinding and hashing
// the full contract per probe would measure the load driver instead of agents.
struct Load<'a> {
    fixture: &'a Fixture,
    binding: Binding,
    model: ModelSelection,
}
impl Load<'_> {
    async fn mutation(&self, method: &str, input: Value) -> Value {
        let client = self.fixture.app.client();
        let prepared = client
            .prepare_mutation(
                self.binding.clone(),
                method.into(),
                input,
                scope(&self.fixture.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        match client
            .mutate_owned(prepared)
            .await
            .unwrap()
            .result()
            .await
            .receipt
        {
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { value },
                ..
            } => value,
            _ => panic!("load mutation did not return a committed result"),
        }
    }
    async fn send(&self, session: &str) -> Value {
        self.send_message(session, "Hello").await
    }
    async fn send_message(&self, session: &str, message: &str) -> Value {
        self.mutation(
            "send",
            json!({"sessionId":session,"message":message,"model":self.model}),
        )
        .await
    }
    async fn query(&self, method: &str, input: Value) -> Value {
        self.fixture
            .app
            .client()
            .start(
                self.binding.clone(),
                method.into(),
                input,
                scope(&self.fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
    }
}

async fn cancellation_wave(load: &Load<'_>, listener: TcpListener, sessions: &[String]) -> Value {
    let fixture = load.fixture;
    let count = sessions.len();
    let (entered, mut arrivals) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let entered = entered.clone();
            workers.spawn(async move {
                request(&mut socket).await;
                entered.send(()).unwrap();
                let mut byte = [0];
                match socket.read(&mut byte).await {
                    Ok(0) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        ) => {}
                    other => panic!("cancelled HTTP stream remained open: {other:?}"),
                }
            });
        }
        while let Some(result) = workers.join_next().await {
            result.unwrap();
        }
        listener
    });
    let sends = join_all(sessions.iter().map(|session| load.send(session))).await;
    for _ in 0..count {
        arrivals.recv().await.unwrap();
    }
    memory_checkpoint("cancellation_active");
    let start = Instant::now();
    let stops = join_all(
        sessions
            .iter()
            .zip(sends)
            .map(|(session, sent)| async move {
                let stopped = load
                    .mutation(
                        "stop",
                        json!({"sessionId":session,"invocationId":sent["invocationId"]}),
                    )
                    .await;
                assert_eq!(stopped["requested"], true);
                (session, sent)
            }),
    )
    .await;
    let listener = server.await.unwrap();
    fixture.drained().await;
    let cancel_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert!(fixture.owner.runs.lock().await.controls.is_empty());
    memory_checkpoint("cancellation_settled");
    for (session, sent) in stops {
        let state = load
            .query(
                "execution",
                json!({"sessionId":session,"invocationId":sent["invocationId"]}),
            )
            .await;
        assert_eq!(state["execution"]["state"], "cancelled");
    }
    // Recovery checks shared execution capacity with a fresh conversation.
    // Long prior output can legitimately trigger a separate summary model,
    // which this single-response HTTP fixture does not implement.
    let input = fixture.create_input("Recovery").await;
    let session = load.mutation("create", input).await["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let recovered = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket, "Recovered after cancellation").await;
    });
    let start = Instant::now();
    let sent = load.send(&session).await;
    recovered.await.unwrap();
    fixture.drained().await;
    let recovery_ms = start.elapsed().as_secs_f64() * 1000.0;
    let observed = load.query("observe", json!({"sessionId":session})).await;
    assert_eq!(observed["session"]["activity"], "idle");
    let execution = load
        .query(
            "execution",
            json!({"sessionId":session,"invocationId":sent["invocationId"]}),
        )
        .await;
    assert_eq!(execution["execution"]["state"], "completed");
    let history = load
        .query(
            "history",
            json!({"sessionId":session,"position":{"kind":"start"}}),
        )
        .await;
    let text: String = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|chunk| chunk["role"] == "assistant")
        .map(|chunk| chunk["text"].as_str().unwrap())
        .collect();
    assert_eq!(text, "Recovered after cancellation");
    json!({"cancelled": count, "closed_http_connections": count, "cancel_and_settle_ms":cancel_ms, "recovery_ms":recovery_ms})
}

async fn run(count: usize, deltas: usize, prompt: String, delta: String) -> Value {
    let prompt: Arc<str> = prompt.into();
    let delta: Arc<str> = delta.into();
    let expected = delta.repeat(deltas);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let fixture = Fixture::new(&base, None).await;
    let load = Load {
        fixture: &fixture,
        binding: fixture.binding(2).await,
        model: fixture.selection().await,
    };
    let create_input = fixture.create_input("Scale").await;
    memory_checkpoint("host_ready");
    let creation = Instant::now();
    let sessions = join_all((0..count).map(|i| {
        let load = &load;
        let mut input = create_input.clone();
        input["title"] = json!(format!("Scale {i}"));
        async move {
            load.mutation("create", input).await["session"]["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
    }))
    .await;
    let creation_ms = creation.elapsed().as_secs_f64() * 1000.0;
    memory_checkpoint("sessions_ready");
    let release = CancellationToken::new();
    let (arrived, mut arrivals) = tokio::sync::mpsc::unbounded_channel();
    let start = Instant::now();
    let cpu_start = usage().0;
    let server_release = release.clone();
    let server_prompt = prompt.clone();
    let server_delta = delta.clone();
    let server = tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let release = server_release.clone();
            let arrived = arrived.clone();
            let prompt = server_prompt.clone();
            let delta = server_delta.clone();
            workers.spawn(async move {
                let body = request(&mut socket).await;
                assert_eq!(body["model"], "fixture-model");
                assert!(body["messages"].as_array().unwrap().iter().any(|m| m["content"].as_str() == Some(prompt.as_ref())));
                drop(body);
                arrived.send(start.elapsed().as_secs_f64() * 1000.0).unwrap();
                // Every HTTP request must be live before any response begins.
                release.cancelled().await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                for _ in 0..deltas {
                    let delta = json!({"id":"scale", "choices":[{"index":0,"delta":{"content":delta.as_ref()},"finish_reason":null}]});
                    socket.write_all(format!("data: {delta}\n\n").as_bytes()).await.unwrap();
                    // Pacing defines workload, not test synchronization.
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                socket.write_all(b"data: {\"id\":\"scale\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").await.unwrap();
            });
        }
        while let Some(result) = workers.join_next().await {
            result.unwrap();
        }
        listener
    });
    let admissions = join_all(sessions.iter().map(|session| {
        let load = &load;
        let prompt = &prompt;
        async move {
            let reply = load.send_message(session, prompt).await;
            assert_eq!(reply["kind"], "started");
            start.elapsed().as_secs_f64() * 1000.0
        }
    }))
    .await;
    let mut requests = Vec::with_capacity(count);
    for _ in 0..count {
        requests.push(
            tokio::time::timeout(Duration::from_secs(60), arrivals.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "only {} of {count} model HTTP requests entered",
                        requests.len()
                    )
                })
                .unwrap(),
        );
    }
    assert_eq!(fixture.owner.runs.lock().await.controls.len(), count);
    let all_active_ms = start.elapsed().as_secs_f64() * 1000.0;
    memory_checkpoint("all_active");
    release.cancel();
    let streaming = Instant::now();
    let mut probes = Vec::new();
    // A foreground control query while all agents generate and journal output.
    loop {
        let probe = Instant::now();
        load.query("observe", json!({"sessionId":sessions[0]}))
            .await;
        probes.push(probe.elapsed().as_secs_f64() * 1000.0);
        if fixture.owner.workers.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let streaming_ms = streaming.elapsed().as_secs_f64() * 1000.0;
    let listener = server.await.unwrap();
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let cpu_end = usage().0;
    assert!(fixture.owner.runs.lock().await.controls.is_empty());
    memory_checkpoint("output_settled");
    for session in &sessions {
        let observed = load.query("observe", json!({"sessionId":session})).await;
        assert_eq!(observed["session"]["activity"], "idle");
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
                    assert!(
                        expected.get(offset..end) == Some(text),
                        "durable output differs for {session} at byte {offset}"
                    );
                    offset = end;
                }
            }
            if page["after"].is_null() {
                break;
            }
            input["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        assert_eq!(
            offset,
            expected.len(),
            "complete durable output for {session}"
        );
    }
    let cancellation = cancellation_wave(&load, listener, &sessions).await;
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
    memory_checkpoint("shutdown");
    drop(load);
    drop(fixture);
    memory_checkpoint("dropped");
    let peak_rss_bytes = usage().1;
    json!({"agents":count,"overlapping_model_requests":requests.len(),"completed":count,"errors":0,
        "cancellation":cancellation,"deltas_per_agent":deltas,"prompt_bytes_per_agent":prompt.len(),"output_bytes_per_agent":expected.len(),"verified_output_bytes":count*expected.len(),
        "create_sessions_ms":creation_ms,"all_active_ms":all_active_ms,
        "admission_ms":distribution(admissions),"model_arrival_ms":distribution(requests),
        "foreground_query_ms":distribution(probes),"stream_and_settle_ms":streaming_ms,
        "elapsed_ms":elapsed_ms,"cpu_seconds":cpu_end-cpu_start,"peak_rss_bytes":peak_rss_bytes,
        "provider_emissions_per_second":count as f64*deltas as f64/(streaming_ms/1000.0)})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn independent_agents_enter_model_together_and_preserve_output() {
    tokio::time::timeout(
        Duration::from_secs(60),
        run(3, 4, "Hello".into(), "token ".into()),
    )
    .await
    .unwrap();
}

/// Run release builds, one case per process. See scripts/agent-scale.py.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit real-Host load benchmark"]
async fn real_host_agent_scale() {
    let count = std::env::var("MAKA_SCALE_AGENTS")
        .unwrap_or_else(|_| "10".into())
        .parse()
        .unwrap();
    let deltas = std::env::var("MAKA_SCALE_DELTAS")
        .unwrap_or_else(|_| "32".into())
        .parse()
        .unwrap();
    assert!(count > 0 && deltas > 0);
    let sized = |name: &str, default: &str, character: &str| {
        std::env::var(name).map_or_else(
            |_| default.to_owned(),
            |value| character.repeat(value.parse::<usize>().unwrap()),
        )
    };
    let prompt = sized("MAKA_SCALE_PROMPT_BYTES", "Hello", "p");
    let delta = sized("MAKA_SCALE_DELTA_BYTES", "token ", "t");
    let result = tokio::time::timeout(Duration::from_secs(600), run(count, deltas, prompt, delta))
        .await
        .unwrap();
    println!("MAKA_AGENT_SCALE {result}");
}

mod flowing;

pub(in crate::owner::tests) mod compaction;

pub(in crate::owner::tests) mod image_upload;
