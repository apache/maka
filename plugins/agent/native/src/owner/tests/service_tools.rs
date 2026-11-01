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
    ComputerClosed,
    Unknown,
    CleanupFailed,
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
        if matches!(self.behavior, Behavior::ComputerClosed) {
            return Box::pin(async { Err("computer_closed".into()) });
        }
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
                Behavior::ComputerClosed => {
                    unreachable!("unavailable Computer returns before effects")
                }
                Behavior::Unknown => Err("lost reply after original effect".into()),
                Behavior::CleanupFailed => {
                    let mut ticket = context.scope().resources.reserve().unwrap();
                    ticket.start();
                    ticket.complete(Err("counter cleanup failed".into()));
                    Ok(json!({"effects":count}))
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

pub(super) async fn pending_approval(
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
async fn ordinary_conversation_survives_an_unavailable_computer_service() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::with_services(
            &base,
            None,
            None,
            Some(Setup::computer(Counter::new(Behavior::ComputerClosed))),
        )
        .await;
        let session = fixture.create("Continue without browser").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(
            sent["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "Counter")
        );
        response_with_text(&mut socket, "We can continue discussing the task.").await;
        fixture.drained().await;
        let facts = facts(&fixture, &session).await;
        assert!(facts.iter().any(|fact| matches!(
            fact,
            Fact::InvocationEnded {
                outcome: maka_agent_facts::event::InvocationOutcome::Completed
            }
        )));
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
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

// The provider finishes its physical work after cancellation, independently of the observer.
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

#[tokio::test]
async fn failed_tool_cleanup_keeps_original_custody_while_the_agent_and_application_continue() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let counter = Counter::new(Behavior::CleanupFailed);
        let fixture = Fixture::with_services(
            &base,
            None,
            None,
            Some(Setup::native(counter.clone(), true)),
        )
        .await;
        let session = fixture.create("Failed original cleanup").await;
        fixture.send(&session).await.unwrap();
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
            json!({"effects":1})
        );
        response_with_text(
            &mut socket,
            "The operation completed. I can continue with the task.",
        )
        .await;
        fixture.drained().await;
        let recorded = facts(&fixture, &session).await;
        let stored = stored_facts(&fixture, &session).await;
        let settled = stored
            .iter()
            .find(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
            .unwrap();
        let raw = fixture
            .session(&session)
            .await
            .resolve_tool_result(&session, &settled.event.id)
            .await
            .unwrap();
        let maka_agent_facts::tool_output::ToolOutput::Operation(observation) = raw else {
            panic!("original operation receipt must be retained")
        };
        assert!(matches!(
            observation.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { .. },
                cleanup: maka_plugin_core::operation::OperationCleanup::Failed { .. }
            }
        ));
        assert!(recorded.iter().any(|fact| matches!(
            fact,
            Fact::InvocationEnded {
                outcome: maka_agent_facts::event::InvocationOutcome::Completed
            }
        )));
        assert!(fixture.owner.runs.lock().await.retained_cleanup.is_empty());
        assert!(!fixture.owner.stop.is_cancelled());

        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket, "This conversation is still available.").await;
        fixture.drained().await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        fixture.create("Other conversations still work").await;
        // Original custody and the failed cleanup receipt are retained even
        // though the caller can continue using the application.
        assert!(fixture.app.shutdown().await.is_err());
        assert!(!fixture.app.client().snapshot().closed);
        fixture.config.shutdown().await.unwrap();
        eprintln!(
            "Retained failed-cleanup Root: {}",
            fixture._dir.keep().display()
        );
    })
    .await
    .unwrap();
}
