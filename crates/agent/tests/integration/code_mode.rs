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

use crate::support::code_mode as fixture;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use maka_agent::Engine;
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_model::ModelExecutor;
use maka_runtime::event::{Fact, TerminalStatus, ToolOutcome};
use maka_runtime::tool_call::ToolOrigin;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Barrier;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scratch_store_survives_turns_and_is_released_with_the_session() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (index, code) in [
                "store('saved', 42);",
                "text(load('saved'));",
                "text(load('saved'));",
            ]
            .into_iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                fixture::read_request(&mut socket).await;
                crate::dynamic_tools::respond_tools(
                    &mut socket,
                    vec![crate::dynamic_tools::call(
                        "cell",
                        "exec",
                        json!({"code":code}),
                    )],
                    10,
                )
                .await;
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                let text = request["messages"].as_array().unwrap().last().unwrap()["content"]
                    .as_str()
                    .unwrap();
                if index > 0 {
                    assert_eq!(
                        text.lines().last().unwrap(),
                        if index == 1 { "42" } else { "undefined" }
                    );
                }
                fixture::respond(&mut socket, false).await;
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let engine = Engine::new(
            log.clone(),
            ModelExecutor::new(1, Duration::from_secs(5)).unwrap(),
            CodeExecutor::new(1, CellLimits::default()).unwrap(),
        );
        for index in 0..3 {
            if index == 2 {
                engine.release_code_store("session");
            }
            engine
                .run(
                    fixture::input(
                        &base,
                        &format!("store-{index}"),
                        Arc::new(fixture::Effects {
                            log: log.clone(),
                            count: Arc::new(AtomicUsize::new(0)),
                            together: Arc::new(Barrier::new(2)),
                        }),
                    ),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        }
        server.await.unwrap();
        engine.drain().await;
        drop(engine);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    })
    .await
    .expect("session store lifecycle must complete");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streamed_exec_journals_parallel_children_and_reopens_without_reexecution() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(fixture::read_request(&mut socket).await);
                fixture::respond(&mut socket, index == 0).await;
            }
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let count = Arc::new(AtomicUsize::new(0));
        let envelope = json!({
            "ok":true,"value":null,
            "toolCalls":[{"index":1,"name":"left"},{"index":2,"name":"right"}]
        });
        let before_reopen;
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(1, CellLimits::default()).unwrap(),
            );
            let input = fixture::input(
                &base,
                "first",
                Arc::new(fixture::Effects {
                    log: log.clone(),
                    count: count.clone(),
                    together: Arc::new(Barrier::new(2)),
                }),
            );
            let invocation = input.invocation.clone();
            assert_eq!(
                engine.run(input, CancellationToken::new()).await.unwrap(),
                invocation
            );
            engine.drain().await;
            let prefix = log.prefix(100, 128 * 1024).await.unwrap();
            assert_eq!(
                prefix.project_invocation("invocation-first").terminal,
                Some(TerminalStatus::Completed)
            );
            assert_eq!(count.load(Ordering::SeqCst), 2);
            assert!(
                prefix
                    .events
                    .iter()
                    .all(|event| event.event.invocation == invocation)
            );
            let dispatches: Vec<_> = prefix
                .events
                .iter()
                .enumerate()
                .filter_map(|(index, event)| {
                    if let Fact::ToolDispatched {
                        operation_id,
                        call,
                        name,
                        input,
                    } = &event.event.fact
                    {
                        Some((index, operation_id, call, name, input))
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(dispatches.len(), 4);
            let (parent_t1, parent_operation, parent_call, parent_name, parent_input) =
                dispatches[0];
            assert_eq!(parent_name, "exec");
            assert_eq!(parent_input, &json!({"code":fixture::CODE}));
            assert_eq!(parent_call.tool_call_id, "exec-provider");
            let ToolOrigin::Provider { step_id } = &parent_call.origin else {
                panic!("parent must retain provider identity");
            };
            assert_eq!(parent_operation, &format!("{step_id}:exec-provider"));
            let settlements: Vec<_> = prefix
                .events
                .iter()
                .enumerate()
                .filter_map(|(index, event)| {
                    if let Fact::ToolSettled {
                        operation_id,
                        outcome,
                    } = &event.event.fact
                    {
                        Some((index, operation_id, outcome))
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(settlements.len(), 4);
            let (parent_t2, _, parent_outcome) = settlements
                .iter()
                .copied()
                .find(|(_, operation, _)| *operation == parent_operation)
                .unwrap();
            assert!(matches!(parent_outcome, ToolOutcome::Succeeded { .. }));
            assert_eq!(
                log.resolve_tool_result("session", &prefix.events[parent_t2].event.id)
                    .await
                    .unwrap()
                    .into_json()["result"],
                envelope
            );
            let mut ids = HashSet::new();
            let (cell_t1, cell_operation, cell_call, _, _) = dispatches[1];
            assert_eq!(
                cell_call.origin,
                ToolOrigin::CodeCell {
                    parent_operation_id: parent_operation.clone(),
                    parent_tool_call_id: parent_call.tool_call_id.clone(),
                }
            );
            let cell_t2 = settlements
                .iter()
                .find(|(_, operation, _)| *operation == cell_operation)
                .unwrap()
                .0;
            for (t1, operation, call, name, input) in &dispatches {
                assert!(ids.insert(operation.as_str()));
                assert!(
                    ids.insert(call.tool_call_id.as_str()),
                    "operation IDs and call IDs are distinct"
                );
                if matches!(name.as_str(), "exec" | "code_cell") {
                    continue;
                }
                assert!(matches!(name.as_str(), "left" | "right"));
                assert_eq!(
                    call.origin,
                    ToolOrigin::CodeMode {
                        parent_operation_id: cell_operation.clone(),
                        parent_tool_call_id: cell_call.tool_call_id.clone(),
                    }
                );
                let (t2, _, outcome) = settlements
                    .iter()
                    .copied()
                    .find(|(_, settled, _)| settled == operation)
                    .unwrap();
                assert!(
                    parent_t1 < cell_t1
                        && cell_t1 < *t1
                        && *t1 < t2
                        && t2 < cell_t2
                        && cell_t2 < parent_t2
                );
                assert!(matches!(outcome, ToolOutcome::Succeeded { .. }));
                assert_eq!(
                    log.resolve_tool_result("session", &prefix.events[t2].event.id)
                        .await
                        .unwrap()
                        .into_json(),
                    **input
                );
            }
            // The concurrency barrier guarantees both children enter their effects
            // before either returns; their committed T1 facts must precede either T2.
            assert!(
                dispatches[1..]
                    .iter()
                    .all(|(t1, ..)| *t1 < settlements[0].0)
            );
            let next_request = prefix
                .events
                .iter()
                .enumerate()
                .filter_map(|(index, event)| {
                    matches!(event.event.fact, Fact::ModelRequested { .. }).then_some(index)
                })
                .nth(1)
                .unwrap();
            assert!(
                parent_t2 < next_request,
                "no model observes a result before T2"
            );
            before_reopen = prefix.events;
            drop(engine);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        }
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            assert_eq!(
                serde_json::to_value(log.prefix(100, 128 * 1024).await.unwrap().events).unwrap(),
                serde_json::to_value(&before_reopen).unwrap()
            );
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(1, CellLimits::default()).unwrap(),
            );
            engine
                .run(
                    fixture::input(
                        &base,
                        "next",
                        Arc::new(fixture::Effects {
                            log: log.clone(),
                            count: count.clone(),
                            together: Arc::new(Barrier::new(2)),
                        }),
                    ),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            engine.drain().await;
            assert_eq!(
                count.load(Ordering::SeqCst),
                2,
                "recovery must not repeat effects"
            );
            let prefix = log.prefix(200, 256 * 1024).await.unwrap();
            assert_eq!(
                serde_json::to_value(&prefix.events[..before_reopen.len()]).unwrap(),
                serde_json::to_value(&before_reopen).unwrap()
            );
            assert_eq!(
                prefix.project_invocation("invocation-next").terminal,
                Some(TerminalStatus::Completed)
            );
        }
        let requests = server.await.unwrap();
        for request in &requests {
            let functions: Vec<_> = request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| &tool["function"])
                .collect();
            let names: HashSet<_> = functions
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect();
            assert_eq!(names, HashSet::from(["exec", "wait"]));
            let description = functions[0]["description"].as_str().unwrap();
            assert!(description.contains("left(input:"));
            assert!(description.contains("right(input:"));
            let schema = &functions[0]["parameters"];
            assert_eq!(schema["properties"]["code"]["type"], "string");
            assert!(schema["properties"].get("yield_time_ms").is_some());
            assert_eq!(schema["required"], json!(["code"]));
            assert_eq!(schema["additionalProperties"], false);
        }
        assert_eq!(
            requests[0]["messages"],
            json!([{"role":"user","content":"question first"}])
        );
        let second = requests[1]["messages"].as_array().unwrap();
        assert_eq!(second.len(), 3, "nested tool messages must remain hidden");
        assert_eq!(second[1]["role"], "assistant");
        let calls = second[1]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "exec-provider");
        assert_eq!(calls[0]["function"]["name"], "exec");
        assert_eq!(
            serde_json::from_str::<Value>(calls[0]["function"]["arguments"].as_str().unwrap())
                .unwrap(),
            json!({"code":fixture::CODE})
        );
        assert_eq!(second[2]["role"], "tool");
        assert_eq!(second[2]["tool_call_id"], "exec-provider");
        assert_eq!(
            serde_json::from_str::<Value>(
                second[2]["content"]
                    .as_str()
                    .unwrap()
                    .lines()
                    .next()
                    .unwrap()
            )
            .unwrap()["result"],
            envelope
        );
        let reopened = requests[2]["messages"].as_array().unwrap();
        assert_eq!(reopened.len(), second.len() + 2);
        assert_eq!(
            &reopened[..second.len()],
            second,
            "past model input must be identical after reopening"
        );
        assert_eq!(
            reopened[second.len()],
            json!({"role":"assistant","content":"done"})
        );
        assert_eq!(
            reopened.last().unwrap(),
            &json!({"role":"user","content":"question next"})
        );
    })
    .await
    .expect("streamed Code Mode must finish; serial nested execution deadlocks the fixture");
}
