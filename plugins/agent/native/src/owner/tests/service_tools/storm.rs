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

//! Real service result fanout and compaction share one controlled provider.

use super::*;
use maka_agent_facts::{event::InvocationOutcome, model::ModelUsage};
use std::time::Instant;

const FINAL: &str = "all service results confirmed";

#[derive(Clone, Copy)]
struct Case {
    calls: usize,
    bytes: usize,
    javascript: bool,
    query: bool,
}

impl Case {
    fn environment(query: bool) -> Self {
        let number = |name, fallback| {
            std::env::var(name).map_or(fallback, |value| value.parse::<usize>().unwrap())
        };
        let backend = std::env::var("MAKA_TOOL_STORM_BACKEND").unwrap_or("native".into());
        assert!(matches!(backend.as_str(), "native" | "javascript"));
        Self {
            calls: number("MAKA_TOOL_STORM_CALLS", 8),
            bytes: number("MAKA_TOOL_STORM_PAYLOAD_BYTES", 128),
            javascript: backend == "javascript",
            query,
        }
    }
}

fn payload(index: usize, bytes: usize) -> String {
    (0..bytes)
        .map(|offset| char::from(b'a' + ((index + offset) % 26) as u8))
        .collect()
}

async fn reply(socket: &mut TcpStream, calls: std::ops::Range<usize>, bytes: usize, text: &str) {
    let mut body = String::new();
    for (slot, index) in calls.enumerate() {
        let event = json!({"id":"service-model","choices":[{"index":0,"delta":{"tool_calls":[{
            "index":slot,"id":format!("service-{index}"),"type":"function","function":{
                "name":"Counter","arguments":json!({"amount":1,"note":payload(index,bytes)}).to_string()
            }
        }]},"finish_reason":null}]});
        body.push_str(&format!("data: {event}\n\n"));
    }
    if !text.is_empty() {
        body.push_str(&format!("data: {}\n\n", json!({"id":"service-model","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})));
    }
    body.push_str(&format!("data: {}\n\ndata: [DONE]\n\n", json!({"id":"service-model","choices":[{"index":0,"delta":{},"finish_reason":if text.is_empty(){"tool_calls"}else{"stop"}}],"usage":{"prompt_tokens":7,"completion_tokens":11,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":3}}})));
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

async fn run(case: Case) -> Value {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let counter = Counter::new(Behavior::Echo);
    let mut setup = if case.javascript {
        Setup::javascript()
    } else {
        Setup::native(counter.clone(), true)
    };
    setup = setup.with_echo().with_query(case.query);
    let fixture = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(setup),
    )
    .await;
    let session = fixture.create("Service result fanout").await;
    let summary_prompt = fixture
        .query("compactionPrompt", json!({"sessionId":session}))
        .await
        .unwrap()["compactionPrompt"]
        .as_str()
        .unwrap()
        .to_owned();
    let (finished, mut finish) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut issued = 0;
        let mut summaries = 0;
        let mut final_seen = false;
        loop {
            let (mut socket, _) = tokio::select! {
                accepted = listener.accept() => accepted.unwrap(),
                _ = &mut finish => return summaries,
            };
            let body = request(&mut socket).await;
            let last = body["messages"].as_array().unwrap().last().unwrap();
            if last["role"] == "user" && last["content"] == summary_prompt {
                summaries += 1;
                reply(&mut socket, 0..0, 0, "earlier service results summarized").await;
            } else {
                assert!(has_tool(&body, "Counter"), "unexpected request purpose");
                assert!(!final_seen, "Main continued after its final response");
                if issued < case.calls {
                    let end = if case.query { case.calls } else { issued + 1 };
                    reply(&mut socket, issued..end, case.bytes, "").await;
                    issued = end;
                } else {
                    reply(&mut socket, 0..0, 0, FINAL).await;
                    final_seen = true;
                }
            }
        }
    });
    let start = Instant::now();
    let sent = fixture.send(&session).await.unwrap();
    fixture.drained().await;
    finished.send(()).unwrap();
    let summaries = server.await.unwrap();
    let recorded = facts(&fixture, &session).await;
    let expected: BTreeMap<_, _> = recorded
        .iter()
        .filter_map(|fact| match fact {
            Fact::ToolDispatched {
                operation_id, call, ..
            } => {
                let index = call
                    .tool_call_id
                    .strip_prefix("service-")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                Some((
                    maka_agent_facts::tool_call::tool_use_id(
                        sent["invocationId"].as_str().unwrap(),
                        operation_id,
                    ),
                    payload(index, case.bytes),
                ))
            }
            _ => None,
        })
        .collect();
    assert_eq!(expected.len(), case.calls);
    assert_eq!(
        recorded
            .iter()
            .filter(|fact| matches!(
                fact,
                Fact::ToolSettled {
                    outcome: ToolOutcome::Succeeded { .. },
                    ..
                }
            ))
            .count(),
        case.calls
    );
    assert!(recorded.iter().any(|fact| matches!(
        fact,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed
        }
    )));
    for fact in &recorded {
        if let Fact::ModelCompleted { output, .. } = fact {
            assert_eq!(
                output.usage,
                ModelUsage {
                    input_tokens: Some(7),
                    output_tokens: Some(11),
                    cache_read_tokens: Some(2),
                    cache_write_tokens: None,
                    reasoning_tokens: Some(3),
                }
            );
        }
    }
    let checkpoints = recorded
        .iter()
        .filter(|fact| matches!(fact, Fact::ContextCheckpointRecorded { .. }))
        .count();
    assert_eq!(checkpoints, summaries);

    let through = fixture.through(&session).await;
    let mut input = json!({"sessionId":session,"through":through,"position":{"kind":"start"}});
    let mut results: BTreeMap<String, String> = BTreeMap::new();
    let mut calls = BTreeSet::new();
    let mut assistant = String::new();
    loop {
        let page = fixture.query("history", input.clone()).await.unwrap();
        assert_eq!(page["kind"], "ready");
        assert_eq!(page["through"], through);
        for chunk in page["chunks"].as_array().unwrap() {
            if chunk["field"] != "body" {
                continue;
            }
            match chunk["role"].as_str().unwrap() {
                "tool_call" => {
                    let tool = &chunk["tool"];
                    let id = tool["toolUseId"].as_str().unwrap();
                    assert!(expected.contains_key(id));
                    calls.insert(id.to_owned());
                    assert_eq!(tool["call"]["pending"], false);
                    assert_eq!(tool["call"]["dispatched"], true);
                    assert!(!tool["result"].is_null());
                }
                "tool_result" => {
                    let id = chunk["tool"]["toolUseId"].as_str().unwrap();
                    let accumulated = results.entry(id.to_owned()).or_default();
                    assert_eq!(chunk["offset"], accumulated.len());
                    assert_eq!(chunk["totalBytes"], expected[id].len());
                    accumulated.push_str(chunk["text"].as_str().unwrap());
                }
                "assistant" => assistant.push_str(chunk["text"].as_str().unwrap()),
                _ => {}
            }
        }
        if page["after"].is_null() {
            break;
        }
        input["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    assert_eq!(calls.len(), case.calls);
    assert_eq!(results, expected);
    assert_eq!(assistant, FINAL);
    if !case.javascript {
        assert_eq!(counter.entered.available_permits(), case.calls);
        assert_eq!(
            counter.effects.load(Ordering::SeqCst),
            if case.query { 0 } else { case.calls }
        );
    }
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
    json!({"calls":case.calls,"payload_bytes":case.bytes,"query":case.query,
        "backend":if case.javascript{"javascript"}else{"native"},"summary_requests":summaries,
        "wall_ms":start.elapsed().as_secs_f64()*1000.0})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn public_history_preserves_fanout_results_and_usage_across_pages() {
    // Cross the 128-result metadata page boundary with one controlled fanout.
    let result = run(Case {
        calls: 129,
        bytes: 128,
        javascript: false,
        query: true,
    })
    .await;
    assert_eq!(result["summary_requests"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn original_query_results_survive_automatic_compaction() {
    let result = run(Case {
        calls: 8,
        bytes: 65_536,
        javascript: false,
        query: true,
    })
    .await;
    assert!(result["summary_requests"].as_u64().unwrap() > 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn original_mutation_results_survive_repeated_compaction() {
    let result = run(Case {
        calls: 16,
        bytes: 65_536,
        javascript: false,
        query: false,
    })
    .await;
    assert!(result["summary_requests"].as_u64().unwrap() > 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit sequential service workload"]
async fn real_service_tool_storm() {
    println!(
        "MAKA_AGENT_TOOL_STORM {}",
        run(Case::environment(false)).await
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit service query fanout workload"]
async fn real_service_query_fanout() {
    println!(
        "MAKA_AGENT_TOOL_STORM {}",
        run(Case::environment(true)).await
    );
}
