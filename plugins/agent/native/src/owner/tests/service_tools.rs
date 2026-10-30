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
use maka_agent_facts::archive::outcome_projection;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_output::DurableToolProjection;
use maka_host_runtime::application::{Context, Handler, NativeOwner};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    runtime::Published,
};
use std::sync::atomic::{AtomicUsize, Ordering};

mod approval_park;
mod continuation_ancestry;

mod continuation_observations;

#[cfg(unix)]
mod storm;

fn counter_contract() -> Contract {
    let write = Method {
        progress: None,
        mode: MethodMode::Mutation,
        input: json!({"type":"object","properties":{"amount":{"type":"integer","minimum":1},"note":{"type":"string"}},"required":["amount"],"additionalProperties":false}).into(),
        output: json!({"type":"object","properties":{"effects":{"type":"integer"},"payload":{"type":"string"}},"required":["effects"],"additionalProperties":false}).into(),
        resources: BTreeMap::new(),
    };
    let read = Method {
        progress: None,
        mode: MethodMode::Query,
        ..write.clone()
    };
    Contract {
        name: "fixture.Counter".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([("write".into(), write), ("read".into(), read)]),
        },
    }
}
#[derive(Clone, Copy)]
enum Behavior {
    Returned,
    #[cfg(unix)]
    Echo,
    Unknown,
    CleanupFailed,
    LargeCleanupFailed,
    Blocked,
}
struct Counter {
    behavior: Behavior,
    effects: AtomicUsize,
    entered: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Counter {
    fn new(behavior: Behavior) -> Arc<Self> {
        Arc::new(Self {
            behavior,
            effects: AtomicUsize::new(0),
            entered: Arc::new(Semaphore::new(0)),
            cancelled: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        })
    }
}
impl Handler for Counter {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let count = if method == "read" {
            assert!(context.operation().is_none());
            self.effects.load(Ordering::SeqCst)
        } else {
            assert!(context.operation().is_some());
            self.effects
                .fetch_add(input["amount"].as_u64().unwrap() as usize, Ordering::SeqCst)
                + 1
        };
        let behavior = self.behavior;
        let entered = self.entered.clone();
        let cancelled = self.cancelled.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.add_permits(1);
            match behavior {
                Behavior::Returned => Ok(json!({"effects":count})),
                #[cfg(unix)]
                Behavior::Echo => {
                    Ok(json!({"effects":count,"payload":input["note"].as_str().unwrap_or("")}))
                }
                Behavior::Unknown => Err("lost reply after original effect".into()),
                Behavior::CleanupFailed | Behavior::LargeCleanupFailed => {
                    let mut ticket = context.scope().resources.reserve().unwrap();
                    ticket.start();
                    ticket.complete(Err("counter cleanup failed".into()));
                    if matches!(behavior, Behavior::LargeCleanupFailed) {
                        let value = json!({"effects":count,"payload":"x".repeat(1024*1024-128)});
                        assert!(serde_json::to_vec(&value).unwrap().len() <= 1024 * 1024);
                        Ok(value)
                    } else {
                        Ok(json!({"effects":count}))
                    }
                }
                Behavior::Blocked => {
                    context.scope().cancellation.cancelled().await;
                    cancelled.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    Ok(json!({"effects":count}))
                }
            }
        })
    }
}
impl NativeOwner for Counter {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
#[path = "service_tools/setup.rs"]
mod setup;
pub(super) use setup::Setup;

async fn tool_response(socket: &mut TcpStream) {
    tool_response_input(socket, json!({"amount":1})).await;
}
async fn tool_response_input(socket: &mut TcpStream, input: Value) {
    named_tool_response(socket, "Counter", input).await;
}
pub(super) async fn named_tool_response(socket: &mut TcpStream, name: &str, input: Value) {
    let delta = json!({"id":"tool-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"counter-call","type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"tool-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
pub(super) async fn facts(fixture: &Fixture, session: &str) -> Vec<Fact> {
    stored_facts(fixture, session)
        .await
        .into_iter()
        .map(|event| event.event.fact)
        .collect()
}

pub(super) async fn stored_facts(
    fixture: &Fixture,
    session: &str,
) -> Vec<maka_agent_facts::event::StoredEvent> {
    let store = fixture.session(session).await;
    let through = *store.subscribe_commits().unwrap().borrow();
    let mut after = 0;
    let mut events = Vec::new();
    loop {
        let page = store
            .session_events(session, after, through, 256, 4 * 1024 * 1024)
            .await
            .unwrap();
        events.extend(page.events);
        match page.next_after {
            Some(next) => after = next,
            None => return events,
        }
    }
}

async fn pending_approval(
    fixture: &Fixture,
    session: &str,
) -> maka_agent_facts::interaction::InteractionRecord {
    let mut commits = fixture.session(session).await.subscribe_commits().unwrap();
    loop {
        if let Some(record) = fixture
            .session(session)
            .await
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            assert!(matches!(
                record.request,
                maka_agent_facts::interaction::InteractionRequest::ServiceApproval { .. }
            ));
            return record;
        }
        commits.changed().await.unwrap();
    }
}

#[tokio::test]
async fn live_tool_input_replays_across_model_completion_approval_and_original_effect_settlement() {
    tokio::time::timeout(Duration::from_secs(30), async {
        async fn next_event(
            watch: &mut maka_host_runtime::application::Subscription,
            pending: &mut std::collections::VecDeque<Value>,
        ) -> Value {
            loop {
                if let Some(event) = pending.pop_front() {
                    return event;
                }
                let page = watch.recv().await.expect("original Agent watch closed");
                if let Some(events) = page["events"].as_array() {
                    pending.extend(events.iter().cloned());
                }
            }
        }

        async fn preview_input(
            watch: &mut maka_host_runtime::application::Subscription,
            pending: &mut std::collections::VecDeque<Value>,
            expected: &str,
        ) -> (String, String, u64) {
            let mut input = String::new();
            loop {
                let page = watch.recv().await.expect("live input preview closed");
                if let Some(events) = page["events"].as_array() {
                    pending.extend(events.iter().cloned());
                }
                if page["kind"] != "preview" || page["page"]["kind"] != "cut" { continue; }
                let page = &page["page"];
                for part in page["parts"].as_array().unwrap() {
                    if part["field"]["kind"] != "tool_input" { continue; }
                    assert_eq!(part["field"]["name"], "Counter");
                    assert_eq!(part["field"]["providerExecuted"], false);
                    assert_eq!(part["offset"], input.len());
                    input.push_str(part["text"].as_str().unwrap());
                    if input == expected {
                        return (part["field"]["toolUseId"].as_str().unwrap().to_owned(),
                            page["stepId"].as_str().unwrap().to_owned(), page["dependsOn"].as_u64().unwrap());
                    }
                }
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Blocked);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture.create("Observe original live tool input").await;
        let accepted = fixture.send(&session).await.unwrap();
        let mut watch = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "watch".into(),
                json!({"sessionId":session,"after":0}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let mut pending = std::collections::VecDeque::new();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let prefix = "{\"amount\":1";
        let first = format!(
            "data: {}\n\n",
            json!({"id":"live-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"counter-call","type":"function","function":{"name":"Counter","arguments":prefix}}]},"finish_reason":null}]})
        );
        let last = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"id":"live-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":null}]}),
            json!({"id":"live-tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
        );
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{first}",
                    first.len() + last.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let (tool_use_id, step_id, depends_on) = preview_input(&mut watch, &mut pending, prefix).await;
        let streaming = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(streaming["toolSeeds"], json!([]));
        assert!(streaming["through"].as_u64().unwrap() >= depends_on);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        drop(watch);
        let mut watch = fixture.app.client().subscribe(
            fixture.binding(2).await, "watch".into(),
            json!({"sessionId":session,"after":streaming["through"]}),
            scope(&fixture.issuer, true), Attachments::new().into(),
        ).await.unwrap();
        pending.clear();
        let (reconnected_tool, reconnected_step, _) = preview_input(&mut watch, &mut pending, prefix).await;
        assert_eq!(reconnected_tool, tool_use_id);
        assert_eq!(reconnected_step, step_id);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);

        socket.write_all(last.as_bytes()).await.unwrap();
        let approval = pending_approval(&fixture, &session).await;
        let maka_agent_facts::interaction::InteractionRequest::ServiceApproval {
            tool_use_id: approval_tool,
            ..
        } = &approval.request else { unreachable!() };
        assert_eq!(approval_tool, &tool_use_id);
        let recorded = facts(&fixture, &session).await;
        assert!(recorded.iter().any(|fact| matches!(fact,
            Fact::ModelRequested { step_id: id, item_acceptance: false, .. } if id == &step_id)));
        assert!(recorded.iter().any(|fact| matches!(fact,
            Fact::ModelCompleted { step_id: id, .. } if id == &step_id)));
        let waiting = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(waiting["run"]["state"], "waiting_for_user");
        let seeds = waiting["toolSeeds"].clone();
        assert_eq!(seeds.as_array().unwrap().len(), 1);
        assert_eq!(seeds[0]["toolUseId"], tool_use_id);
        assert!(seeds[0]["startSequence"].as_u64().unwrap() > 0);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        drop(watch);
        let mut watch = fixture.app.client().subscribe(
            fixture.binding(2).await, "watch".into(),
            json!({"sessionId":session,"after":seeds[0]["startSequence"].as_u64().unwrap() - 1}),
            scope(&fixture.issuer, true), Attachments::new().into(),
        ).await.unwrap();
        pending.clear();
        loop {
            let event = next_event(&mut watch, &mut pending).await;
            if event["fact"]["kind"] == "step_ended" {
                assert_eq!(event["fact"], json!({"kind":"step_ended","stepId":step_id,"completed":true}));
                break;
            }
        }
        let canonical = fixture.query("source", json!({"sessionId":session,"through":waiting["through"],
            "source":{"kind":"tool_use","toolUseId":tool_use_id},"field":"arguments","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(canonical["source"]["text"].as_str().unwrap()).unwrap(), json!({"amount":1}));
        let reconnected = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(reconnected["run"]["state"], "waiting_for_user");
        assert_eq!(reconnected["toolSeeds"], seeds);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);

        let answer = fixture.mutation(2, "respond", json!({"sessionId":session,
            "requestId":approval.request_id,"answer":{"kind":"service_approval","decision":"allow"}}),
            Uuid::new_v4()).await.unwrap();
        assert_eq!(answer["record"]["outcome"]["decision"], "allow");
        counter.entered.acquire().await.unwrap().forget();
        let dispatch = next_event(&mut watch, &mut pending).await;
        assert_eq!(dispatch["fact"], json!({"kind":"tool_dispatched","toolUseId":tool_use_id,
            "name":"Counter","title":null}));
        assert_eq!(fixture.query("observe", json!({"sessionId":session})).await.unwrap()["toolSeeds"], seeds);
        fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
            Uuid::new_v4()).await.unwrap();
        counter.cancelled.acquire().await.unwrap().forget();
        assert_eq!(fixture.owner.workers.len(), 1);
        counter.release.add_permits(1);
        let mut settled = None;
        loop {
            let event = next_event(&mut watch, &mut pending).await;
            match event["fact"]["kind"].as_str().unwrap() {
                "tool_settled" => settled = Some(event["fact"].clone()),
                "ended" => break,
                _ => {}
            }
        }
        assert_eq!(settled, Some(json!({"kind":"tool_settled","toolUseId":tool_use_id,"settlement":"returned"})));
        fixture.drained().await;
        assert_eq!(fixture.query("observe", json!({"sessionId":session})).await.unwrap()["toolSeeds"], json!([]));
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        drop(watch);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn service_confirmation_reviews_exact_large_arguments_and_never_replaces_grant_admission() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for (granted, query, decision) in [(true, false, "allow"), (true, false, "deny"), (false, false, "allow"), (true, true, "allow")] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let counter = Counter::new(Behavior::Returned);
            let mut setup = Setup::native(counter.clone(), granted).titled(maka_agent_facts::display::Text::localized("Review counter", "审核计数器", "審核計數器"));
            setup = setup.with_query(query);
            setup.confirmation = contract::ToolConfirmation::Required;
            let fixture = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup)).await;
            let session = fixture.create("Review exact service call").await;
            fixture.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            let input = json!({"amount":7,"note":"界🙂\n".repeat(5000)});
            tool_response_input(&mut socket, input.clone()).await;
            let record = pending_approval(&fixture, &session).await;
            assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
            assert_eq!(counter.entered.available_permits(), 0);
            let maka_agent_facts::interaction::InteractionRequest::ServiceApproval { through, ref tool_use_id, .. } = record.request else { unreachable!() };
            assert_eq!(fixture.query("observe", json!({"sessionId":session})).await.unwrap()["run"]["state"], "waiting_for_user");
            let pending = fixture.query("pendingInteractions", json!({"sessionId":session})).await.unwrap();
            assert_eq!(pending["entries"][0]["kind"], "service_approval");
            assert_eq!(pending["entries"][0]["toolUseId"], *tool_use_id);
            let mut position = json!({"kind":"start"});
            let mut complete = String::new();
            loop {
                let page = fixture.query("source", json!({"sessionId":session,"through":through,
                    "source":{"kind":"tool_use","toolUseId":tool_use_id},"field":"arguments","position":position})).await.unwrap();
                assert_eq!(page["kind"], "ready");
                assert_eq!(page["source"]["tool"]["toolUseId"], *tool_use_id);
                assert_eq!(page["source"]["tool"]["call"]["title"]["translations"]["zh-CN"], "审核计数器");
                assert_eq!(page["source"]["tool"]["call"]["pending"], true);
                assert!(page["source"]["tool"]["result"].is_null());
                let text = page["source"]["text"].as_str().unwrap();
                assert!(text.len() <= 8192);
                complete.push_str(text);
                let end = page["source"]["offset"].as_u64().unwrap() + text.len() as u64;
                if end == page["source"]["totalBytes"].as_u64().unwrap() { break; }
                position = json!({"kind":"after","offset":end});
            }
            assert_eq!(serde_json::from_str::<Value>(&complete).unwrap(), input);
            let other = fixture.create("Other service call owner").await;
            let wrong = fixture.mutation(2, "respond", json!({"sessionId":other,"requestId":record.request_id,
                "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
            assert_eq!(wrong["reason"], "unavailable");
            let wrong = fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":record.request_id,
                "answer":{"kind":"question","answers":["yes"]}}), Uuid::new_v4()).await.unwrap();
            assert_eq!(wrong["reason"], "invalid_answer");
            let operation = Uuid::new_v4();
            let answer = json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"service_approval","decision":decision}});
            let receipt = fixture.mutation(2, "respond", answer.clone(), operation).await.unwrap();
            assert_eq!(receipt["record"]["outcome"]["decision"], decision);
            assert_eq!(fixture.mutation(2, "respond", answer, operation).await.unwrap(), receipt);
            let opposite = if decision == "allow" { "deny" } else { "allow" };
            assert_eq!(fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":record.request_id,
                "answer":{"kind":"service_approval","decision":opposite}}), Uuid::new_v4()).await.unwrap(), receipt);
            let (mut resumed, _) = listener.accept().await.unwrap();
            request(&mut resumed).await;
            response(&mut resumed).await;
            fixture.drained().await;
            let admitted = granted && decision == "allow";
            assert_eq!(counter.entered.available_permits(), usize::from(admitted));
            assert_eq!(counter.effects.load(Ordering::SeqCst), if admitted && !query { 7 } else { 0 });
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn stop_closes_original_service_confirmation_without_an_effect_or_replay() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture.create("Stop service confirmation").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response(&mut socket).await;
        let record = pending_approval(&fixture, &session).await;
        fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":started["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        fixture.drained().await;
        let late = fixture
            .mutation(
                2,
                "respond",
                json!({"sessionId":session,"requestId":record.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(late["record"]["outcome"]["kind"], "closure");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        assert!(
            fixture
                .session(&session)
                .await
                .pending_interactions(&session)
                .await
                .unwrap()
                .is_empty()
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn installed_javascript_service_is_a_real_model_tool_with_business_projection_and_original_receipt()
 {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = request(&mut socket).await;
            assert_eq!(first["tools"].as_array().unwrap().len(), 1);
            assert_eq!(first["tools"][0]["function"]["name"], "Counter");
            assert_eq!(
                first["tools"][0]["function"]["parameters"]["required"],
                json!(["amount"])
            );
            tool_response(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let next = request(&mut socket).await;
            let result = next["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "tool")
                .unwrap();
            assert_eq!(result["tool_call_id"], "counter-call");
            assert_eq!(
                serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
                json!({"effects":1})
            );
            assert!(!next.to_string().contains("stateDomain"));
            response(&mut socket).await;
        });
        let fixture = Fixture::with_services(&base, None, None, Some(Setup::javascript())).await;
        let session = fixture.create("Actual service tool").await;
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        let observed = facts(&fixture, &session).await;
        server.await.unwrap();
        let facts = observed;
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::ToolDispatched { .. }))
                .count(),
            1
        );
        let outcome = facts
            .iter()
            .find_map(|fact| {
                if let Fact::ToolSettled { outcome, .. } = fact {
                    Some(outcome)
                } else {
                    None
                }
            })
            .unwrap();
        let ToolOutcome::Succeeded {
            model_projection, ..
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        assert_eq!(
            model_projection,
            &DurableToolProjection::Json {
                value: json!({"effects":1})
            }
        );
        let prefix = fixture
            .session(&(session))
            .await
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session {
                    id: session.clone(),
                },
                256,
                4 * 1024 * 1024,
            )
            .await
            .unwrap();
        let event = prefix
            .events
            .iter()
            .find(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
            .unwrap();
        let raw = fixture
            .session(&session)
            .await
            .resolve_tool_result(&session, &event.event.id)
            .await
            .unwrap();
        let text = serde_json::to_string(&raw).unwrap();
        assert!(text.contains("journal_v1"));
        assert!(text.contains("00000000-0000-0000-0000-000000000015"));
        assert!(matches!(
            raw,
            maka_agent_facts::tool_output::ToolOutput::Operation(_)
        ));
        let through = fixture.through(&session).await;

        use maka_agent_ports::session::history::Page;
        use maka_agent_ports::session::history::Position;
        use maka_agent_ports::session::history::SourceField;
        use maka_agent_ports::session::history::SourceFormat;
        use maka_agent_ports::session::history::SourcePosition;
        let Page::Ready { chunks, .. } = fixture
            .session(&session)
            .await
            .history_text(
                &session,
                through,
                Position::Start,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        let result = chunks
            .iter()
            .find(|chunk| chunk.role == maka_agent_ports::session::history::Role::ToolResult)
            .unwrap();
        assert!(
            result.text.is_empty(),
            "numeric business result must not display receipt strings"
        );
        for (field, expected) in [
            (
                SourceField::Result,
                serde_json::to_string(&json!({"effects":1})).unwrap(),
            ),
            (
                SourceField::Receipt,
                serde_json::to_string(&raw.to_json()).unwrap(),
            ),
        ] {
            for reverse in [false, true] {
                let mut position = if reverse {
                    SourcePosition::Tail
                } else {
                    SourcePosition::Start
                };
                let mut actual = String::new();
                loop {
                    let source = fixture
                        .session(&session)
                        .await
                        .history_source(
                            &session,
                            through,
                            maka_event_log::transcript::SourceSelection {
                                locator: result.position,
                                field,
                                path: None,
                            },
                            position,
                            13,
                        )
                        .await
                        .unwrap();
                    assert_eq!(source.format, SourceFormat::Json);
                    assert_eq!(
                        source.fields,
                        [SourceField::Body, SourceField::Result, SourceField::Receipt]
                    );
                    assert_eq!(source.total_bytes, expected.len() as u64);
                    if reverse {
                        actual.insert_str(0, &source.text);
                    } else {
                        actual.push_str(&source.text);
                    }
                    let end = source.offset + source.text.len() as u64;
                    if (reverse && source.offset == 0) || (!reverse && end == source.total_bytes) {
                        break;
                    }
                    position = if reverse {
                        SourcePosition::Before {
                            offset: source.offset,
                        }
                    } else {
                        SourcePosition::After { offset: end }
                    };
                }
                assert_eq!(actual, expected);
            }
        }
        let matches = fixture
            .session(&session)
            .await
            .search_transcript(
                &session,
                maka_event_log::transcript::search::TranscriptSearch {
                    through,
                    after: None,
                    query: "journal_v1".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: true,
                    max_matches: 64,
                },
            )
            .await
            .unwrap();
        assert!(
            matches.matches.is_empty(),
            "receipt metadata is not conversation search text"
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn unknown_service_outcome_has_typed_original_evidence_and_never_enters_model_diagnostic() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            tool_response(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let next = request(&mut socket).await;
            let text = next.to_string();
            assert!(text.contains("result is unknown"));
            assert!(!text.contains("journal_v1"));
            assert!(!text.contains("fixture.Counter"));
            response(&mut socket).await;
        });
        let counter = Counter::new(Behavior::Unknown);
        let fixture = Fixture::with_services(
            &base,
            None,
            None,
            Some(Setup::native(counter.clone(), true)),
        )
        .await;
        let session = fixture.create("Unknown original effect").await;
        let accepted = fixture.send(&session).await.unwrap();
        fixture.drained().await;
        let observed = facts(&fixture, &session).await;
        server.await.unwrap();
        let facts = observed;
        let (operation_id, outcome) = facts
            .iter()
            .find_map(|fact| match fact {
                Fact::ToolSettled {
                    operation_id,
                    outcome,
                } => Some((operation_id, outcome)),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact,
                    Fact::ToolDispatched { operation_id: recorded, .. } if recorded == operation_id
                ))
                .count(),
            1,
            "the original mutation has exactly one canonical T1"
        );
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact,
                    Fact::ToolSettled { operation_id: recorded, .. } if recorded == operation_id
                ))
                .count(),
            1,
            "the original mutation has exactly one canonical Unknown outcome"
        );
        let ToolOutcome::Unknown {
            operation: Some(operation),
            message,
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        assert_eq!(operation.reference.namespace, id(21));
        assert_eq!(operation.reference.method, "write");
        assert!(matches!(
            operation.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { .. },
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed
            }
        ));
        assert_eq!(
            outcome_projection(outcome).as_ref(),
            &DurableToolProjection::Text {
                text: message.clone()
            }
        );
        let recovered = fixture
            .store
            .operation(&operation.reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.reference, operation.reference);
        let Receipt::Recorded {
            outcome: original_outcome,
            cleanup: original_cleanup,
        } = &operation.receipt
        else {
            panic!("original mutation must retain its recorded receipt");
        };
        assert_eq!(&recovered.outcome, original_outcome);
        assert_eq!(&recovered.cleanup, original_cleanup);
        let client = fixture.app.client();
        let reader = client
            .bind(client.activation(&id(2)).unwrap(), "receipts".into())
            .await
            .unwrap()
            .remove(0);
        let read = client
            .start(
                reader,
                "read".into(),
                serde_json::to_value(&operation.reference).unwrap(),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        read.cleanup.unwrap();
        let observed: maka_plugin_core::operation::OperationReply =
            serde_json::from_value(read.result.unwrap()).unwrap();
        assert_eq!(
            &observed,
            operation.as_ref(),
            "the real receipt reader must preserve the producer's complete original evidence"
        );
        assert_eq!(
            counter.effects.load(Ordering::SeqCst),
            1,
            "receipt recovery cannot replay the original mutation"
        );
        let tool_use_id = maka_agent_facts::tool_call::tool_use_id(
            accepted["invocationId"].as_str().unwrap(),
            operation_id,
        );
        let mut watch = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "watch".into(),
                json!({"sessionId":session,"after":0}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let mut settlement = None;
        'delivery: loop {
            let page = watch
                .recv()
                .await
                .expect("unknown original outcome must remain readable");
            if let Some(events) = page["events"].as_array() {
                for event in events {
                    match event["fact"]["kind"].as_str().unwrap() {
                        "tool_settled" => settlement = Some(event["fact"].clone()),
                        "ended" => break 'delivery,
                        _ => {}
                    }
                }
            }
        }
        assert_eq!(
            settlement,
            Some(json!({"kind":"tool_settled","toolUseId":tool_use_id,"settlement":"unknown"}))
        );
        drop(watch);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn unlisted_native_tool_edge_never_executes_the_selected_provider() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            tool_response(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            response(&mut socket).await;
        });
        let counter = Counter::new(Behavior::Returned);
        let fixture = Fixture::with_services(
            &base,
            None,
            None,
            Some(Setup::native(counter.clone(), false)),
        )
        .await;
        let session = fixture.create("No implicit grant").await;
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        server.await.unwrap();
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        let actual = facts(&fixture, &session).await;
        assert!(actual.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Failed { .. },
                ..
            }
        )));
        assert!(!actual.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Unknown { .. },
                ..
            }
        )));
        assert!(!facts(&fixture, &session).await.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn stopping_real_agent_run_cancels_tool_but_retains_owner_until_physical_cleanup() {
    for code in [false, true] {
        tokio::time::timeout(Duration::from_secs(30), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                if code {
                    code_response(&mut socket, "text(await tools.Counter({amount:1}));").await;
                } else {
                    tool_response(&mut socket).await;
                }
            });
            let counter = Counter::new(Behavior::Blocked);
            let fixture = Fixture::with_services(
                &base,
                None,
                None,
                Some({
                    let mut setup = Setup::native(counter.clone(), true);
                    setup.nestable = code;
                    setup
                }),
            )
            .await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([(
                    "fixture-model".into(),
                    ModelOverride {
                        code_mode: Some(code),
                        ..Default::default()
                    },
                )]));
            })
            .await;
            let session = fixture.create("Stop original tool").await;
            let started = fixture.send(&session).await.unwrap();
            counter.entered.acquire().await.unwrap().forget();
            fixture
                .mutation(
                    2,
                    "stop",
                    json!({"sessionId":session,"invocationId":started["invocationId"]}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            counter.cancelled.acquire().await.unwrap().forget();
            assert_eq!(fixture.owner.workers.len(), 1);
            let other = fixture.create("Other session remains available").await;
            let admitted = fixture.send(&other).await.unwrap();
            fixture
                .mutation(
                    2,
                    "stop",
                    json!({"sessionId":other,"invocationId":admitted["invocationId"]}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            counter.release.add_permits(1);
            fixture.drained().await;
            server.await.unwrap();
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        })
        .await
        .unwrap();
    }
}
#[tokio::test]
async fn returned_effect_with_failed_cleanup_preserves_receipt_without_settling_execution() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for behavior in [Behavior::CleanupFailed, Behavior::LargeCleanupFailed] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                tool_response(&mut socket).await;
            });
            let counter = Counter::new(behavior);
            let fixture = Fixture::with_services(
                &base,
                None,
                None,
                Some(Setup::native(counter.clone(), true)),
            )
            .await;
            let session = fixture.create("Failed original cleanup").await;
            fixture.send(&session).await.unwrap();
            fixture.drained().await;
            let observed = fixture.facts_after_failed_shutdown(&session).await;
            server.await.unwrap();
            let facts = observed;
            assert!(
                !facts
                    .iter()
                    .any(|fact| matches!(fact, Fact::ToolSettled { .. }))
            );
            let observation = facts
                .iter()
                .find_map(|fact| {
                    if let Fact::ToolOperationObserved { observation, .. } = fact {
                        Some(observation)
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(observation.reference.namespace, id(21));
            if matches!(behavior, Behavior::LargeCleanupFailed) {
                assert!(serde_json::to_vec(observation).unwrap().len() > 1024 * 1024);
            }
            assert!(matches!(
                observation.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    cleanup: maka_plugin_core::operation::OperationCleanup::Failed { .. }
                }
            ));
            assert_eq!(fixture.owner.runs.lock().await.quarantined.len(), 1);
            assert!(fixture.app.shutdown().await.is_err());
            assert!(!fixture.app.client().snapshot().closed);
            fixture.config.shutdown().await.unwrap();
            // Failed cleanup does not authorize destruction of the original Root.
            eprintln!(
                "Retained failed-cleanup Root: {}",
                fixture._dir.keep().display()
            );
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn query_tool_uses_original_query_gate_and_projects_plain_business_json() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            tool_response(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let next = request(&mut socket).await;
            let result = next["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "tool")
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
                json!({"effects":0})
            );
            response(&mut socket).await;
        });
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup = setup.with_query(true);
        let fixture = Fixture::with_services(&base, None, None, Some(setup)).await;
        let session = fixture.create("Actual query tool").await;
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        server.await.unwrap();
        let prefix = fixture
            .session(&(session))
            .await
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session {
                    id: session.clone(),
                },
                256,
                4 * 1024 * 1024,
            )
            .await
            .unwrap();
        let event = prefix
            .events
            .iter()
            .find(|event| {
                matches!(
                    event.event.fact,
                    Fact::ToolSettled {
                        outcome: ToolOutcome::Succeeded { .. },
                        ..
                    }
                )
            })
            .unwrap();
        assert_eq!(
            fixture
                .session(&session)
                .await
                .resolve_tool_result(&session, &event.event.id)
                .await
                .unwrap(),
            maka_agent_facts::tool_output::ToolOutput::Json(json!({"effects":0}))
        );
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn unresponsive_native_tool_reaches_original_cleanup_budget_and_keeps_host_work_owned() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            tool_response(&mut socket).await;
        });
        let counter = Counter::new(Behavior::Blocked);
        let fixture = Fixture::with_services(
            &base,
            None,
            None,
            Some(Setup::native(counter.clone(), true)),
        )
        .await;
        let session = fixture.create("Unresponsive original tool").await;
        let started = fixture.send(&session).await.unwrap();
        counter.entered.acquire().await.unwrap().forget();
        fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":started["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        counter.cancelled.acquire().await.unwrap().forget();
        // Keep the physical original callback blocked beyond the real 5s budget.
        // Old observer-first code never drained here, even after that budget.
        tokio::time::timeout(Duration::from_secs(8), fixture.drained())
            .await
            .unwrap();
        assert_eq!(fixture.owner.runs.lock().await.quarantined.len(), 1);
        let snapshot = fixture.app.client().snapshot();
        assert!(
            snapshot
                .instances
                .iter()
                .any(|status| status.activation.instance() == &id(21) && status.calls > 0)
        );
        assert!(
            !fixture
                .facts_after_failed_shutdown(&session)
                .await
                .iter()
                .any(|fact| matches!(fact, Fact::ToolSettled { .. }))
        );
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        counter.release.add_permits(1);
        server.await.unwrap();
        assert!(fixture.app.shutdown().await.is_err());
        assert!(!fixture.app.client().snapshot().closed);
        fixture.config.shutdown().await.unwrap();
        eprintln!(
            "Retained unresponsive-tool Root: {}",
            fixture._dir.keep().display()
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn admitted_message_keeps_original_model_workspace_and_dispatcher_when_opening_fails() {
    let fixture = Fixture::with_services(
        "http://127.0.0.1:1/v1",
        None,
        None,
        Some(Setup::javascript()),
    )
    .await;
    let session = fixture.create("Pending original basis").await;
    let raw = rusqlite::Connection::open(fixture.session_database(&session)).unwrap();
    raw.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON event_log WHEN NEW.kind='invocation_opened' BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END;").unwrap();
    let operation = Uuid::new_v4();
    assert!(fixture.mutation(2, "send", json!({
        "sessionId":session,"message":"durable original", "model":fixture.selection().await
    }), operation).await.is_err());
    fixture.drained().await;
    let queued = fixture
        .session(&session)
        .await
        .pending_messages(&session)
        .await
        .unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].execution.owner, fixture.owner.prefix);
    let encoded = serde_json::to_string(&queued[0].execution.basis).unwrap();
    assert!(!encoded.contains("private-fixture-key"));
    let basis: MessageBasis = serde_json::from_str(&encoded).unwrap();
    assert_eq!(basis.model.unwrap().binding.model, "fixture-model");
    assert_eq!(
        basis.workspace,
        fixture
            .owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .workspace
    );
    assert!(!basis.fingerprint.is_empty());
    assert_eq!(basis.tools.len(), 1);
    assert!(basis.tools == fixture.owner.tool_basis);
    assert_eq!(
        fixture
            .store
            .pending_message_sessions(&fixture.owner.prefix, None)
            .await
            .unwrap(),
        [session]
    );
    assert!(
        fixture
            .store
            .pending_message_sessions("maka-runtime-host", None)
            .await
            .unwrap()
            .is_empty()
    );
    raw.execute_batch("DROP TRIGGER hold_opening").unwrap();
    drop(raw);
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn queue_promotion_steers_original_run_at_the_next_step_without_a_successor() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::with_services(&base, None, None, Some(Setup::javascript())).await;
        let session = fixture.create("Steer original run").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        let queued = fixture.mutation(2, "send", json!({"sessionId":session,"message":"steering instruction","model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let promoted = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queued["revision"],"edit":{"kind":"promote","messageId":queued["messageId"]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(promoted["kind"], "committed");
        assert_eq!(fixture.query("queue", json!({"sessionId":session})).await.unwrap()["entries"][0]["kind"], "steering");
        tool_response(&mut first).await;
        let (mut second, _) = listener.accept().await.unwrap();
        let next = request(&mut second).await;
        assert!(next["messages"].as_array().unwrap().iter().any(|message| message["content"] == "The user sent a message while you were working:\n<user_query>\nsteering instruction\n</user_query>"));
        assert_eq!(fixture.query("observe", json!({"sessionId":session})).await.unwrap()["run"]["invocationId"], started["invocationId"]);
        response(&mut second).await;
        fixture.drained().await;
        assert!(fixture.session(&session).await.pending_messages(&session).await.unwrap().is_empty());
        let work=fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await.unwrap();
        assert_eq!(work["kind"],"delivered");assert_eq!(work["shared"],true);
        assert_eq!(work["execution"]["invocationId"],started["invocationId"]);
        assert_eq!(work["answer"]["text"],"Elegant response");

        let recorded = facts(&fixture, &session).await;
        assert_eq!(recorded.iter().filter(|fact| matches!(fact, Fact::InvocationOpened { .. })).count(), 1);
        assert!(recorded.iter().any(|fact| matches!(fact, Fact::MessageSteered { .. })));
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

// The provider finishes its physical work after cancellation, independently of the observer.
struct PreparationProbe {
    entered: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    release: Arc<Semaphore>,
    cleanup_failed: bool,
}
impl Handler for PreparationProbe {
    fn call(
        &self,
        method: String,
        _: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        assert_eq!(method, "prepare");
        let mut ticket = context.scope().resources.reserve().unwrap();
        ticket.start();
        self.entered.add_permits(1);
        let failed = self.cleanup_failed;
        let cancelled = self.cancelled.clone();
        let release = self.release.clone();
        Box::pin(async move {
            context.scope().cancellation.cancelled().await;
            cancelled.add_permits(1);
            release.acquire().await.unwrap().forget();
            if failed {
                ticket.complete(Err("preparation cleanup failed".into()));
            } else {
                ticket.complete(Ok(()));
            }
            Err("preparation cancelled".into())
        })
    }
}
impl NativeOwner for PreparationProbe {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn skill_preparation_parent_scope_owns_work_after_observer_loss_and_cleanup_failure() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for failed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let probe = Arc::new(PreparationProbe {
                entered: Arc::new(Semaphore::new(0)),
                cancelled: Arc::new(Semaphore::new(0)),
                release: Arc::new(Semaphore::new(0)),
                cleanup_failed: failed,
            });
            let mut setup = Setup::skill_preparation(dir.path().into(), false);
            setup = setup.with_preparation(probe.clone(), probe.clone());
            let f = Fixture::with_services("http://127.0.0.1:9/v1", None, None, Some(setup)).await;
            let parent = scope(&f.issuer, true);
            let owner = f.owner.clone();
            let request = parent.clone();
            let observer = tokio::spawn(async move {
                owner
                    .prepare_skills("hello".into(), Language::En, None, &request, vec![])
                    .await
            });
            probe.entered.acquire().await.unwrap().forget();
            observer.abort();
            assert!(matches!(observer.await, Err(error) if error.is_cancelled()));
            let cleanup = tokio::spawn(async move { parent.finish().await });
            probe.cancelled.acquire().await.unwrap().forget();
            assert!(
                !cleanup.is_finished(),
                "original parent cannot settle while provider work remains"
            );
            probe.release.add_permits(1);
            assert_eq!(cleanup.await.unwrap().is_err(), failed);
            // The same physical cleanup failure also remains visible to the Host owner.
            assert_eq!(f.app.shutdown().await.is_err(), failed);
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn resume_replays_original_settlements_without_redispatching_effects() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for behavior in [Behavior::Returned, Behavior::Unknown] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let counter = Counter::new(behavior);
            let fixture = Fixture::with_services(
                &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
                Some(Setup::native(counter.clone(), true)),
            ).await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                    code_mode: Some(true), apply_patch: Some(true), ..Default::default()
                })]));
            }).await;
            let session = fixture.create("Resume settled tool").await;
            let sent = fixture.send(&session).await.unwrap();
            let (mut first, _) = listener.accept().await.unwrap();
            request(&mut first).await;
            tool_response(&mut first).await;
            let (mut next, _) = listener.accept().await.unwrap();
            request(&mut next).await;
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
            fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":sent["invocationId"]}), Uuid::new_v4()).await.unwrap();
            fixture.drained().await;
            let source = fixture.query("execution", json!({"sessionId":session,"invocationId":sent["invocationId"]})).await.unwrap();
            assert_eq!(source["execution"]["state"], "cancelled");
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                    code_mode: Some(false), apply_patch: Some(false), ..Default::default()
                })]));
            }).await;
            let resumed = fixture.mutation(2, "resume", json!({
                "sessionId":session, "sourceInvocationId":sent["invocationId"],
                "sourceHighWater":source["execution"]["highWater"], "model":fixture.selection().await
            }), Uuid::new_v4()).await.unwrap();
            assert_eq!(resumed["kind"], "started", "{resumed}");
            let (mut replay, _) = listener.accept().await.unwrap();
            let prompt = request(&mut replay).await;
            assert!(prompt["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "exec"), "resume retains the original Code Mode despite changed model settings");
            let result = prompt["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool").unwrap();
            if matches!(behavior, Behavior::Returned) {
                assert_eq!(serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap()["effects"], 1);
            } else {
                assert!(result["content"].as_str().unwrap().contains("result is unknown"));
            }
            response(&mut replay).await;
            fixture.drained().await;
            let observed = facts(&fixture, &session).await;
            assert!(observed.iter().filter_map(|fact| match fact {
                Fact::InvocationOpened { configuration: Some(configuration), .. } => Some(configuration),
                _ => None,
            }).all(|configuration| configuration.editing_tools == Some(maka_agent_facts::execution::EditingTools::ApplyPatch)), "resume retains original editing policy after overrides change");
            assert_eq!(observed.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { .. })).count(), 1);
            if matches!(behavior, Behavior::Unknown) {
                let reference = observed.iter().find_map(|fact| match fact {
                    Fact::ToolSettled { outcome: ToolOutcome::Unknown { operation: Some(operation), .. }, .. } => Some(&operation.reference),
                    _ => None,
                }).unwrap();
                let receipt = fixture.store.operation(reference).unwrap().operation_observation().await.unwrap().unwrap();
                assert!(matches!(receipt.outcome, OperationOutcome::Unknown { .. }));
            }
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1, "replay never redispatches original service mutation");
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn session_tool_selection_is_an_execution_ceiling_and_is_inherited() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(Setup::native(counter.clone(), true)),
        ).await;
        assert_eq!(fixture.query("tools", json!({})).await.unwrap()["names"], json!(["Counter"]));
        let mut input = fixture.create_input("Restricted worker").await;
        input["tools"] = json!([]);
        let created = fixture.mutation(2, "create", input, Uuid::new_v4()).await.unwrap();
        let session = created["session"]["id"].as_str().unwrap();
        assert_eq!(created["session"]["tools"], json!([]));
        let inherited = fixture.mutation(2, "create", json!({"title":"Inherited", "labels":[], "tools":["Counter"],
            "workspace":{"kind":"session","sessionId":session}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(inherited["session"]["tools"], json!([]));
        fixture.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let input = request(&mut socket).await;
        assert!(input["tools"].is_null() || input["tools"].as_array().unwrap().is_empty());
        tool_response(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert!(facts(&fixture, session).await.iter().any(|fact| matches!(fact, Fact::ToolRejected { name, reason: maka_agent_facts::tool_call::ToolRejection::Unavailable, .. } if name == "Counter")));
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn code_mode_calls_selected_native_services_with_original_grants_and_receipts() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for (nestable, granted) in [(true, true), (true, false), (false, true)] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let counter = Counter::new(Behavior::Returned);
            let mut setup = Setup::native(counter.clone(), granted);
            setup.nestable = nestable;
            let fixture = Fixture::with_services(&base, None, None, Some(setup)).await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                    code_mode: Some(true), ..Default::default()
                })]));
            }).await;
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let first = request(&mut socket).await;
                let names: Vec<_> = first["tools"].as_array().unwrap().iter().filter_map(|tool| tool["function"]["name"].as_str()).collect();
                assert!(names.contains(&"exec") && names.contains(&"wait"));
                assert_eq!(names.contains(&"Counter"), !nestable);
                let code = "const first = await tools.Counter({amount:1}); if (first.effects !== 1 || first.receipt !== undefined) throw Error('native result differs from declared schema'); text(first); const second = await tools.Counter({amount:1}); if (second.effects !== 2) throw Error('second effect missing'); text(second);";
                code_response(&mut socket, code).await;
                let (mut socket, _) = listener.accept().await.unwrap();
                let next = request(&mut socket).await;
                let result = next["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool").unwrap();
                assert_eq!(result["tool_call_id"], "code-call");
                if nestable && granted {
                    assert!(result["content"].as_str().unwrap().contains("effects"));
                }
                response(&mut socket).await;
            });
            let session = fixture.create("Code Mode native services").await;
            fixture.send(&session).await.unwrap();
            fixture.drained().await;
            server.await.unwrap();
            assert_eq!(counter.effects.load(Ordering::SeqCst), if nestable && granted { 2 } else { 0 });
            let recorded = facts(&fixture, &session).await;
            assert!(recorded.iter().any(|fact| matches!(fact, Fact::InvocationOpened { configuration: Some(configuration), .. } if configuration.tool_mode == ToolMode::CodeMode)));
            if nestable && granted {
                assert_eq!(recorded.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "Counter")).count(), 2);
                let operations: Vec<_> = recorded.iter().filter_map(|fact| match fact {
                    Fact::ToolDispatched { name, operation_id, .. } if name == "Counter" => Some(operation_id),
                    _ => None,
                }).collect();
                assert_ne!(operations[0], operations[1]);
                for expected in operations {
                    assert_eq!(recorded.iter().filter(|fact| matches!(fact,
                        Fact::ToolSettled { operation_id, outcome: ToolOutcome::Succeeded { .. } }
                        if operation_id == expected
                    )).count(), 1, "each nested service has its own successful durable settlement");
                    let prefix = fixture.session(&(session)).await.scoped_prefix(
                        maka_agent_facts::event::LogScope::Session { id: session.clone() },
                        256, 4 * 1024 * 1024,
                    ).await.unwrap();
                    let event = prefix.events.iter().find(|event| matches!(&event.event.fact,
                        Fact::ToolSettled { operation_id, .. } if operation_id == expected
                    )).unwrap();
                    assert!(matches!(fixture.session(&session).await.resolve_tool_result(&session, &event.event.id).await.unwrap(),
                        maka_agent_facts::tool_output::ToolOutput::Operation(_)
                    ), "Code Mode business projection must retain the original native receipt");
                }
            }
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

async fn code_response(socket: &mut TcpStream, code: &str) {
    let delta = json!({"id":"code-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"code-call","type":"function","function":{"name":"exec","arguments":json!({"code":code}).to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"code-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn code_mode_native_file_writes_obey_the_live_session_permission_boundary() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for writable in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let mut setup = Setup::files("write");
            setup.nestable = true;
            let fixture = Fixture::with_services(&base, None, None, Some(setup)).await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                    code_mode: Some(true), ..Default::default()
                })]));
            }).await;
            let session = fixture.create("Code Mode files").await;
            if !writable {
                files::change(&fixture, &session, "read_only", false, true).await;
            }
            fixture.send(&session).await.unwrap();

            let (mut first, _) = listener.accept().await.unwrap();
            let prompt = request(&mut first).await;

            assert!(prompt["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "exec"));
            code_response(&mut first, "text(await tools.WorkspaceFile({path:'code-mode.txt',content:'native Code Mode write'}));").await;

            let (mut next, _) = listener.accept().await.unwrap();
            let observed = request(&mut next).await;
            let tool = observed["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool").unwrap();
            assert_eq!(tool["tool_call_id"], "code-call");
            let target = fixture.workspace.join("code-mode.txt");
            assert_eq!(target.exists(), writable);
            if writable {
                assert_eq!(std::fs::read_to_string(target).unwrap(), "native Code Mode write");
            }
            assert!(fixture.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            response(&mut next).await;

            fixture.drained().await;

            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_retains_loaded_tools_between_turns_without_crossing_session_ceiling() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(Setup::native(counter.clone(), true)),
            |settings| settings.tool_discovery = true,
        ).await;
        let session = fixture.create("Discover native services").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let first = request(&mut socket).await;
        assert!(has_tool(&first, "tool_search"));
        assert!(!has_tool(&first, "Counter"));
        named_tool_response(&mut socket, "tool_search", json!({"query":"Counter"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let loaded = request(&mut socket).await;
        assert!(has_tool(&loaded, "Counter"));
        response(&mut socket).await;
        fixture.drained().await;

        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let warm = request(&mut socket).await;
        assert_eq!(warm["tools"], loaded["tools"]);
        tool_response(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        assert!(facts(&fixture, &session).await.iter().any(|fact| matches!(fact,
            Fact::InvocationOpened { configuration: Some(configuration), .. } if configuration.tool_discovery
        )));

        let other = fixture.create("Separate discovery").await;
        fixture.send(&other).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let isolated = request(&mut socket).await;
        assert!(has_tool(&isolated, "tool_search"));
        assert!(!has_tool(&isolated, "Counter"));
        response(&mut socket).await;
        fixture.drained().await;

        let mut input = fixture.create_input("Restricted discovery").await;
        input["tools"] = json!([]);
        let created = fixture.mutation(2, "create", input, Uuid::new_v4()).await.unwrap();
        let restricted = created["session"]["id"].as_str().unwrap();
        fixture.send(restricted).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let restricted_request = request(&mut socket).await;
        assert!(!has_tool(&restricted_request, "Counter"));
        tool_response(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1, "discovery cannot lift the session's tool ceiling");
        assert!(facts(&fixture, restricted).await.iter().any(|fact| matches!(fact,
            Fact::ToolRejected { name, reason: maka_agent_facts::tool_call::ToolRejection::Unavailable, .. } if name == "Counter"
        )));
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

fn has_tool(request: &Value, name: &str) -> bool {
    request["tools"]
        .as_array()
        .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == name))
}

#[tokio::test]
async fn code_mode_discovery_preserves_session_store_and_nested_callability_between_turns() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.nestable = true;
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(setup), |settings| settings.tool_discovery = true,
        ).await;
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(true), ..Default::default()
            })]));
        }).await;
        let session = fixture.create("Code store").await;
        let other = fixture.create("Isolated code store").await;
        for (target, code, expected_effects) in [
            (&session, "if (!ALL_TOOLS.some(t => t.name === 'Counter')) throw Error('missing deferred tool'); store('amount', 2); text(await tools.Counter({amount:load('amount')}));", 2),
            (&session, "if (load('amount') !== 2) throw Error('session store lost'); text(await tools.Counter({amount:load('amount')}));", 4),
            (&other, "if (load('amount') !== undefined) throw Error('session store leaked'); text('isolated');", 4),
        ] {
            fixture.send(target).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let prompt = request(&mut socket).await;
            assert!(has_tool(&prompt, "exec"));
            assert!(!has_tool(&prompt, "Counter"));
            code_response(&mut socket, code).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let next = request(&mut socket).await;
            let result = next["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "tool").unwrap();
            let content = result["content"].as_str().unwrap();
            assert!(content.contains(if expected_effects == 4 && target == &other { "isolated" } else { "effects" }), "{content}");
            assert_eq!(counter.effects.load(Ordering::SeqCst), expected_effects);
            response(&mut socket).await;
            fixture.drained().await;
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

fn file_editors(nestable: bool) -> Setup {
    let mut setup = Setup::file_editors();
    setup.nestable = nestable;
    setup
}

fn create_document(patch: bool, path: &str) -> (&'static str, Value) {
    if patch {
        (
            "PatchDocument",
            json!({"callId":"policy-fixture","operation":{"type":"create_file","path":path,"diff":"+editing policy\n"}}),
        )
    } else {
        (
            "ReplaceDocument",
            json!({"path":path,"content":"editing policy"}),
        )
    }
}

#[tokio::test]
async fn model_editing_policy_selects_bound_file_methods_independently_of_code_mode() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for (model, code, patch, writable) in [
            ("fixture-model", None, None, true),
            ("gpt-fixture", None, None, true),
            ("fixture-model", Some(false), Some(false), true),
            ("fixture-model", Some(false), Some(true), true),
            ("fixture-model", Some(true), Some(false), true),
            ("fixture-model", Some(true), Some(true), true),
            ("fixture-model", Some(true), Some(true), false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let expected_code = code.unwrap_or(model == "gpt-fixture");
            let expected_patch = patch.unwrap_or(model == "gpt-fixture");
            let fixture = Fixture::configured(
                &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
                Some(file_editors(true)), |settings| settings.tool_discovery = expected_code,
            ).await;
            selection::edit(&fixture, |changes| {
                changes.enabled_model_ids = Some(vec![model.into()]);
                changes.model_overrides = Patch::Set(BTreeMap::from([(model.into(), ModelOverride {
                    code_mode: code, apply_patch: patch, ..Default::default()
                })]));
            }).await;
            let session = fixture.create("Independent file editing policy").await;
            if !writable {
                files::change(&fixture, &session, "read_only", false, true).await;
            }
            let mut selection = fixture.selection().await;
            selection.model_id = model.into();
            fixture.mutation(2, "send", json!({"sessionId":session,"message":"Use the selected editor","model":selection}), Uuid::new_v4()).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let prompt = request(&mut socket).await;
            assert_eq!(has_tool(&prompt, "exec"), expected_code);
            let (name, input) = create_document(expected_patch, "policy.txt");
            if expected_code {
                let excluded = if expected_patch { "ReplaceDocument" } else { "PatchDocument" };
                let code = format!("if (ALL_TOOLS.some(t => t.name === '{excluded}')) throw Error('excluded editor leaked'); if (!ALL_TOOLS.some(t => t.name === 'InspectDocument')) throw Error('reader lost'); text(await tools.{name}({input}));");
                code_response(&mut socket, &code).await;
            } else {
                assert!(has_tool(&prompt, "InspectDocument"));
                assert_eq!(has_tool(&prompt, "ReplaceDocument"), !expected_patch);
                assert_eq!(has_tool(&prompt, "AdjustDocument"), !expected_patch);
                assert_eq!(has_tool(&prompt, "PatchDocument"), expected_patch);
                named_tool_response(&mut socket, name, input).await;
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            let target = fixture.workspace.join("policy.txt");
            assert_eq!(target.exists(), writable);
            if writable { assert_eq!(std::fs::read_to_string(target).unwrap(), "editing policy"); }
            response(&mut socket).await;
            fixture.drained().await;
            let expected = if expected_patch { maka_agent_facts::execution::EditingTools::ApplyPatch } else { maka_agent_facts::execution::EditingTools::Structured };
            assert!(facts(&fixture, &session).await.iter().any(|fact| matches!(fact,
                Fact::InvocationOpened { configuration: Some(configuration), .. } if configuration.editing_tools == Some(expected)
            )));
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn queued_file_editing_policy_is_frozen_and_new_messages_adopt_changed_overrides() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(file_editors(true)),
        ).await;
        let session = fixture.create("Queued editing policy").await;
        fixture.send(&session).await.unwrap();
        let (mut first, _) = listener.accept().await.unwrap();
        let original = request(&mut first).await;
        assert!(has_tool(&original, "ReplaceDocument"));
        fixture.send(&session).await.unwrap();
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(true), apply_patch: Some(true), ..Default::default()
            })]));
        }).await;
        response(&mut first).await;
        let (mut queued, _) = listener.accept().await.unwrap();
        let prompt = request(&mut queued).await;
        assert_eq!(prompt["tools"], original["tools"], "queued work keeps the admitted editor and tool protocol");
        let (name, input) = create_document(false, "queued-policy.txt");
        named_tool_response(&mut queued, name, input).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(std::fs::read_to_string(fixture.workspace.join("queued-policy.txt")).unwrap(), "editing policy");

        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let prompt = request(&mut socket).await;
        assert!(has_tool(&prompt, "exec"));
        let (name, input) = create_document(true, "new-policy.txt");
        code_response(&mut socket, &format!("if (ALL_TOOLS.some(t => t.name === 'ReplaceDocument')) throw Error('old editor leaked'); text(await tools.{name}({input}));")).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(std::fs::read_to_string(fixture.workspace.join("new-policy.txt")).unwrap(), "editing policy");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn code_mode_wait_observes_original_native_process_and_its_workspace_effect() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut setup = Setup::processes();
        setup.nestable = true;
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(setup), |settings| { settings.tool_discovery = true; },
        ).await;
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(true), ..Default::default()
            })]));
        }).await;
        let session = fixture.create("Wait for original native process").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        code_response(&mut socket, "// @exec: {\"yield_time_ms\":0}\nconst result = await tools.Execute({title:'验证后台进程',command:'printf started > process-started; while [ ! -f process-release ]; do sleep 0.02; done; printf native-code-mode > process-result; cat process-result',login:false,timeout_ms:30000}); if (result.kind !== 'completed' || result.value.status !== 'completed') throw Error(JSON.stringify(result)); text(result.value.output.stdout);").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let prompt = request(&mut socket).await;
        let message = prompt["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "tool").unwrap();
        let running: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
        assert_eq!(running["state"], "running", "{running}");
        let cell = running["cell_id"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            while !fixture.workspace.join("process-started").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        std::fs::write(fixture.workspace.join("process-release"), "release").unwrap();
        named_tool_response(&mut socket, "wait", json!({"cell_id":cell,"yield_time_ms":30000})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let completed = request(&mut socket).await;
        let message = completed["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "tool").unwrap();
        let text = message["content"].as_str().unwrap();
        let result: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(result["state"], "completed", "{result}");
        assert_eq!(result["result"]["ok"], true, "{result}");
        assert!(text.lines().skip(1).any(|line| line == "native-code-mode"), "{text}");
        assert_eq!(std::fs::read_to_string(fixture.workspace.join("process-result")).unwrap(), "native-code-mode");
        response(&mut socket).await;
        fixture.drained().await;
        let observed = facts(&fixture, &session).await;
        assert_eq!(observed.iter().filter(|fact| matches!(fact, Fact::ToolDispatched {name, ..} if name == "Execute")).count(), 1);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn code_mode_native_image_bytes_reach_the_vision_model() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut setup = Setup::files("readImage");
        setup.nestable = true;
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
            |settings| settings.tool_discovery = true,
        )
        .await;
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([(
                "fixture-model".into(),
                ModelOverride {
                    code_mode: Some(true),
                    vision: Some(true),
                    ..Default::default()
                },
            )]));
        })
        .await;
        let session = fixture.create("Nested native image").await;
        let bytes = images::gif(0);
        std::fs::write(fixture.workspace.join("nested.gif"), &bytes).unwrap();
        files::change(&fixture, &session, "read_only", false, false).await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        code_response(
            &mut socket,
            "image(await tools.WorkspaceFile({path:'nested.gif'}), 'original');",
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let prompt = request(&mut socket).await;
        assert_eq!(images::model_images(&prompt), vec![bytes]);
        response(&mut socket).await;
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn editing_policy_and_code_mode_survive_actual_host_restart_with_original_native_effect() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let setup = file_editors(true);
        let policy = setup.policy();
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(true), apply_patch: Some(false), ..Default::default()
            })]));
        }).await;
        let session = fixture.create("Restore admitted tool policies").await;
        let deployment = fixture.app.client().snapshot().effective.unwrap().deployment;
        let raw = rusqlite::Connection::open(fixture.session_database(&session)).unwrap();
        raw.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON event_log WHEN NEW.kind='invocation_opened' BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END;").unwrap();
        assert!(fixture.send(&session).await.is_err());
        assert_eq!(fixture.session(&session).await.pending_messages(&session).await.unwrap().len(), 1);
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(false), apply_patch: Some(true), ..Default::default()
            })]));
        }).await;
        fixture.app.shutdown().await.unwrap();
        raw.execute_batch("DROP TRIGGER hold_opening").unwrap();
        drop(raw);
        let mut native = NativeRegistry::default();
        provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        let restored = Application::start_from_store(
            fixture.store.clone(), deployment, native, fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), Some(policy))), Some(maka_host_js::factory(Default::default())),
        ).await.unwrap();
        restored.ready().await.unwrap();
        let next = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await;
        assert!(next.is_ok(), "restored admission did not reach model: {:?}", facts(&fixture, &session).await);
        let (mut socket, _) = next.unwrap().unwrap();
        let prompt = request(&mut socket).await;
        assert!(has_tool(&prompt, "exec"), "Host restart retains the admitted Code Mode");
        let (name, input) = create_document(false, "restored-policy.txt");
        code_response(&mut socket, &format!("if (ALL_TOOLS.some(t => t.name === 'PatchDocument')) throw Error('changed policy leaked'); text(await tools.{name}({input}));")).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_eq!(std::fs::read_to_string(fixture.workspace.join("restored-policy.txt")).unwrap(), "editing policy");
        let mut commits = fixture.session(&session).await.subscribe_commits().unwrap();
        response(&mut socket).await;
        loop {
            let recorded = facts(&fixture, &session).await;
            if recorded.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) {
                assert!(recorded.iter().any(|fact| matches!(fact, Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Completed })));
                assert_eq!(recorded.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "ReplaceDocument")).count(), 1);
                assert!(recorded.iter().any(|fact| matches!(fact, Fact::InvocationOpened { configuration: Some(configuration), .. } if configuration.editing_tools == Some(maka_agent_facts::execution::EditingTools::Structured))));
                break;
            }
            commits.changed().await.unwrap();
        }
        restored.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn queued_messages_resume_with_equivalent_native_service_targets_after_restart() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let home = tempfile::tempdir().unwrap();
        for setup in [Setup::questions(), Setup::forms(), Setup::processes(), Setup::web(),
            Setup::skills(home.path().to_owned()),
            Setup::skill_preparation(home.path().to_owned(), true).with_standard_sources(),
        ] {
            let name = setup.export().to_owned();
            let policy = setup.policy();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let fixture = Fixture::with_services(
                &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
            ).await;
            let session = fixture.create(&format!("Restore {name}")).await;
            let deployment = fixture.app.client().snapshot().effective.unwrap().deployment;
            let raw = rusqlite::Connection::open(fixture.session_database(&session)).unwrap();
            raw.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON event_log WHEN NEW.kind='invocation_opened' BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END;").unwrap();
            assert!(fixture.send(&session).await.is_err());
            assert_eq!(fixture.session(&session).await.pending_messages(&session).await.unwrap().len(), 1);
            fixture.app.shutdown().await.unwrap();
            raw.execute_batch("DROP TRIGGER hold_opening").unwrap();
            drop(raw);
            let mut native = NativeRegistry::default();
            provide_all(&mut native).unwrap();
            maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
            let restored = Application::start_from_store(
                fixture.store.clone(), deployment, native, fixture.issuer.clone(),
                Arc::new(Grant(fixture.issuer.clone(), Some(policy))), Some(maka_host_js::factory(Default::default())),
            ).await.unwrap();
            restored.ready().await.unwrap();
            let next = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await;
            assert!(next.is_ok(), "{name} refused equivalent targets: {:?}", facts(&fixture, &session).await);
            let (mut socket, _) = next.unwrap().unwrap();
            request(&mut socket).await;
            let mut commits = fixture.session(&session).await.subscribe_commits().unwrap();
            response(&mut socket).await;
            loop {
                let recorded = facts(&fixture, &session).await;
                if recorded.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) {
                    assert!(recorded.iter().any(|fact| matches!(fact, Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Completed })), "{name}: {recorded:?}");
                    assert_eq!(recorded.iter().filter(|fact| matches!(fact, Fact::InvocationOpened { .. })).count(), 1);
                    break;
                }
                commits.changed().await.unwrap();
            }
            restored.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

struct AdmissionPreparation {
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    messages: Arc<StdMutex<Vec<String>>>,
}
impl Handler for AdmissionPreparation {
    fn call(
        &self,
        method: String,
        input: Value,
        _: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        assert_eq!(method, "prepare");
        let message = input["input"]["message"].as_str().unwrap().to_owned();
        self.messages.lock().unwrap().push(message.clone());
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            if message == "first blocked" {
                entered.add_permits(1);
                release.acquire().await.unwrap().forget();
            }
            Ok(
                serde_json::to_value(maka_skills_api::contract::Preparation::Ready {
                    text: None,
                    record: maka_skills_api::contract::PreparationRecord {
                        revision: maka_agent_facts::artifact::content_digest(
                            b"admission preparation",
                        ),
                        metadata_prompt: String::new(),
                        invocation: Default::default(),
                    },
                    required_tools: Default::default(),
                })
                .unwrap(),
            )
        })
    }
}
impl NativeOwner for AdmissionPreparation {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn independent_session_admits_while_preparation_is_blocked_and_same_session_stays_ordered() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let dir = tempfile::tempdir().unwrap();
        let probe = Arc::new(AdmissionPreparation {
            entered: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            messages: Arc::new(StdMutex::new(Vec::new())),
        });
        let mut setup = Setup::skill_preparation(dir.path().into(), false);
        setup = setup.with_preparation(probe.clone(), probe.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let a = f.create("Blocked preparation").await;
        let b = f.create("Independent preparation").await;
        let selection = f.selection().await;
        let mut first = Box::pin(f.mutation(
            2,
            "send",
            json!({"sessionId":a,"message":"first blocked","model":selection}),
            Uuid::new_v4(),
        ));
        tokio::select! {
            value = &mut first => panic!("blocked preparation returned: {value:?}"),
            permit = probe.entered.acquire() => permit.unwrap().forget(),
        }
        assert!(f.owner.runs.clone().try_lock_owned().is_err());
        let mut same = Box::pin(f.mutation(
            2,
            "send",
            json!({"sessionId":a,"message":"same queued","model":selection}),
            Uuid::new_v4(),
        ));
        let independent = f.mutation(
            2,
            "send",
            json!({"sessionId":b,"message":"independent started","model":selection}),
            Uuid::new_v4(),
        );
        let independent = tokio::select! {
            value = &mut first => panic!("blocked preparation returned: {value:?}"),
            value = &mut same => panic!("same Session overtook its first message: {value:?}"),
            value = independent => value.unwrap(),
        };
        assert_eq!(independent["kind"], "started");
        assert_eq!(
            *probe.messages.lock().unwrap(),
            ["first blocked", "independent started"]
        );
        probe.release.add_permits(1);
        let first = first.await.unwrap();
        assert_eq!(first["kind"], "started");
        let queued = same.await.unwrap();
        assert_eq!(queued["kind"], "queued");
        assert_eq!(
            *probe.messages.lock().unwrap(),
            ["first blocked", "independent started", "same queued"]
        );
        let server = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                bodies.push(request(&mut socket).await);
                response(&mut socket).await;
            }
            bodies
        });
        f.drained().await;
        let bodies = server.await.unwrap();
        let mut last_inputs: Vec<_> = bodies
            .iter()
            .map(|body| {
                body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|item| item["role"] == "user")
                    .unwrap()["content"]
                    .as_str()
                    .unwrap()
            })
            .collect();
        last_inputs.sort_unstable();
        assert_eq!(
            last_inputs,
            ["first blocked", "independent started", "same queued"]
        );
        assert!(
            f.session(&a)
                .await
                .pending_messages(&a)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            f.session(&b)
                .await
                .pending_messages(&b)
                .await
                .unwrap()
                .is_empty()
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
