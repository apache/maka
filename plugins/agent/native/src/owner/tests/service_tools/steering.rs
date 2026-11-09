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

use super::*;

#[tokio::test]
async fn steering_advances_before_the_original_effect_finishes_and_delivers_its_real_result() {
    for code in [false, true] {
        tokio::time::timeout(Duration::from_secs(60), async {
            let (mut logs, _capture) = log_capture();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let counter = Counter::new(Behavior::Held);
            let mut setup = Setup::native(counter.clone(), true);
            setup.nestable = code;
            let fixture = Fixture::with_services(&base, None, None, Some(setup)).await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                    code_mode: Some(code), ..Default::default()
                })]));
            }).await;
            let session = fixture.create("Steer a long tool").await;
            let original = fixture.send(&session).await.unwrap();
            let original_run = fixture.delivered_run(&original).await;
            let (mut first, _) = listener.accept().await.unwrap();
            request(&mut first).await;
            if code {
                code_response(&mut first, "// @exec: {\"yield_time_ms\": 3600000}\ntext(await tools.Counter({amount:1})); text('late result marker');").await;
            } else {
                tool_response(&mut first).await;
            }
            counter.entered.acquire().await.unwrap().forget();
            let started = std::time::Instant::now();
            let steered = fixture.mutation(2, "send", json!({
                "sessionId":session, "message":"Use the new direction", "expectedRunId":original_run
            }), Uuid::new_v4()).await.unwrap();
            assert_eq!(steered["kind"], "queued");
            let admitted = started.elapsed();
            let (mut second, _) = listener.accept().await.unwrap();
            let next = request(&mut second).await;
            eprintln!("steering code={code}: admission={admitted:?}, next_request={:?}", started.elapsed());
            assert!(next["messages"].as_array().unwrap().iter().any(|message| message["role"] == "user" && message.to_string().contains("Use the new direction")));
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
            assert_eq!(counter.cancelled.available_permits(), 0);
            let current = fixture.owner.runs.state().await.controls[&session].execution.run_id;
            let recorded = facts(&fixture, &session).await;
            assert_eq!(current, original_run, "{:?}\n{}", recorded.iter().filter(|fact| matches!(fact, Fact::RunTerminated { .. } | Fact::ModelInterrupted { .. })).collect::<Vec<_>>(), log_text(&mut logs));
            let mut changes = fixture.owner.durable.subscribe().unwrap();
            counter.release.add_permits(1);
            loop {
                let recorded = facts(&fixture, &session).await;
                let completed = if code {
                    let child_done = recorded.iter().any(|fact| {
                        let Fact::Cell { event: maka_agent_facts::cells::CellEvent::ChildPrepared { cell, operation, name, .. } } = fact else { return false; };
                        name == "Counter" && recorded.iter().any(|fact| matches!(fact,
                            Fact::Cell { event: maka_agent_facts::cells::CellEvent::ChildResultRecorded { cell: original_cell, operation: original, is_error: false, .. } }
                            if original_cell == cell && original == operation))
                    });
                    child_done && recorded.iter().any(|fact| matches!(fact,
                        Fact::LocalToolReturned { tool, is_error: false, .. } if tool.call == "code-call"))
                } else {
                    recorded.iter().any(|fact| matches!(fact,
                        Fact::HostToolResultRecorded { tool, is_error: false, .. } if tool.call == "counter-call"))
                };
                if completed { break; }
                changes.changed().await.unwrap();
            }
            response(&mut second).await;
            let (mut third, _) = listener.accept().await.unwrap();
            let final_request = request(&mut third).await;
            let messages = final_request["messages"].as_array().unwrap();
            let call = if code { "code-call" } else { "counter-call" };
            assert_eq!(messages.iter().filter(|message| message["role"] == "tool" && message["tool_call_id"] == call).count(), 1, "a late result must not add a second provider output");
            assert!(messages.iter().any(|message| message["role"] == "user" && message.to_string().contains("Notification") && message.to_string().contains(if code { "late result marker" } else { "effects" })), "the actual result must reach the model: {final_request}");
            response(&mut third).await;
            fixture.drained().await;
            let recorded = facts(&fixture, &session).await;
            if code {
                let children: Vec<_> = recorded.iter().filter_map(|fact| match fact {
                    Fact::Cell { event: maka_agent_facts::cells::CellEvent::ChildPrepared { cell, operation, name, .. } } if name == "Counter" => Some((cell, operation)),
                    _ => None,
                }).collect();
                assert_eq!(children.len(), 1);
                let (cell, operation) = children[0];
                assert_eq!(recorded.iter().filter(|fact| matches!(fact,
                    Fact::Cell { event: maka_agent_facts::cells::CellEvent::ChildAdmitted { cell: original_cell, operation: original } }
                    if original_cell == cell && original == operation)).count(), 1);
            } else {
                assert_eq!(recorded.iter().filter(|fact| matches!(fact,
                    Fact::ToolAdmitted { tool } if tool.call == "counter-call")).count(), 1);
            }
            assert!(matches!(fixture.owner.durable.queue().resolve_message(session.clone(), steered["messageId"].as_str().unwrap().to_owned()).await.unwrap(),
                maka_agent_state::queue::MessageResolution::Delivered { run, shared: true } if run == original_run));
            let view = fixture.owner.durable.frontier(original_run).await.unwrap();
            let mut original_steering = false;
            for step in view.steps.keys() {
                let request = fixture.owner.durable.request(original_run, *step).await.unwrap();
                for reference in request.steering {
                    let source: maka_agent_facts::message::RootSourceMessage = serde_json::from_slice(
                        &fixture.owner.durable.content(original_run, reference).await.unwrap()).unwrap();
                    original_steering |= source.message.message_id == steered["messageId"].as_str().unwrap();
                }
            }
            assert!(original_steering, "the original Run's immutable request must capture the actual steered message");
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
}

#[tokio::test]
async fn default_send_preempts_sampling_in_both_modes_and_stop_fences_a_delayed_send() {
    for code in [false, true] {
        tokio::time::timeout(Duration::from_secs(60), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let fixture = Fixture::new(&base, None).await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                    code_mode: Some(code), ..Default::default()
                })]));
            }).await;
            let session = fixture.create("Steer sampling").await;
            let original = fixture.send(&session).await.unwrap();
            let original_run = fixture.delivered_run(&original).await;
            let (mut first, _) = listener.accept().await.unwrap();
            request(&mut first).await;
            let mut changes = fixture.owner.durable.subscribe().unwrap();
            let part = format!("data: {}\n\n", json!({"id":"partial-response","choices":[{"index":0,"delta":{"content":"The original answer is being written"},"finish_reason":null}]}));
            let original_attempt = fixture.owner.durable.frontier(original_run).await.unwrap().current_attempt.unwrap();
            first.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{part}\r\n", part.len()).as_bytes()).await.unwrap();
            loop {
                if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::ModelObserved { .. })) { break; }
                changes.changed().await.unwrap();
            }
            fixture.mutation(2, "send", json!({"sessionId":session,"message":"Change direction","expectedRunId":original_run}), Uuid::new_v4()).await.unwrap();
            let (mut next, _) = listener.accept().await.unwrap();
            let request = request(&mut next).await;
            assert!(request["messages"].to_string().contains("Change direction"));
            assert!(facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::ModelInterrupted { attempt, .. } if *attempt == original_attempt)));
            fixture.mutation(2, "stop", json!({"sessionId":session,"runId":original_run}), Uuid::new_v4()).await.unwrap();
            fixture.drained().await;
            let delayed = fixture.mutation(2, "send", json!({"sessionId":session,"message":"This was sent before Stop","expectedRunId":original_run}), Uuid::new_v4()).await.unwrap();
            assert_eq!(delayed["kind"], "rejected");
            assert_eq!(delayed["reason"], "turn_stopped");
            assert!(fixture.owner.durable.queue().read(session.clone()).await.unwrap().entries.is_empty());
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
}
