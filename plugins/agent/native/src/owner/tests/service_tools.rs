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
use maka_agent_facts::durable::{Fact, Terminal};
use maka_agent_facts::execution::ToolMode;
use maka_agent_facts::tool_output::DurableToolProjection;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeOwner,
};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    runtime::Published,
};
use std::sync::atomic::{AtomicUsize, Ordering};

mod approval_park;
mod steering;

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
pub(in crate::owner::tests) enum Behavior {
    Returned,
    ComputerClosed,
    Unknown,
    CleanupFailed,
    Blocked,
    Held,
}
pub(in crate::owner::tests) struct Counter {
    behavior: Behavior,
    pub(in crate::owner::tests) effects: AtomicUsize,
    pub(in crate::owner::tests) entered: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    pub(in crate::owner::tests) release: Arc<Semaphore>,
}
impl Counter {
    pub(in crate::owner::tests) fn new(behavior: Behavior) -> Arc<Self> {
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
    ) -> BoxFuture<'static, HandlerResult> {
        if matches!(self.behavior, Behavior::ComputerClosed) {
            return Box::pin(async { Err(HandlerError::from("computer_closed")) });
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
                Behavior::Returned => Ok(HandlerValue::Json(json!({"effects":count}))),
                Behavior::ComputerClosed => {
                    unreachable!("unavailable Computer returns before effects")
                }
                Behavior::Unknown => Err(HandlerError::Unknown {
                    diagnostic: "lost reply after original effect".into(),
                }),
                Behavior::CleanupFailed => {
                    let mut ticket = context.scope().resources.reserve().unwrap();
                    ticket.start();
                    ticket.complete(Err("counter cleanup failed".into()));
                    Ok(HandlerValue::Json(json!({"effects":count})))
                }
                Behavior::Held => {
                    release.acquire().await.unwrap().forget();
                    assert!(
                        !context.scope().cancellation.is_cancelled(),
                        "steering must retain the original tool execution"
                    );
                    Ok(HandlerValue::Json(json!({"effects":count})))
                }
                Behavior::Blocked => {
                    context.scope().cancellation.cancelled().await;
                    cancelled.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    Ok(HandlerValue::Json(json!({"effects":count})))
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
// This contract exercises native consent only; it does not navigate a real browser.
fn browser_consent_contract() -> Contract {
    Contract {
        name: "fixture.Browser".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service { methods: BTreeMap::from([("navigate".into(), Method {
            progress: None,
            mode: MethodMode::Mutation,
            input: json!({"type":"object","properties":{"url":{"type":"string","enum":["https://example.com"]}},"required":["url"],"additionalProperties":false}).into(),
            output: json!({"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":false}).into(),
            resources: BTreeMap::new(),
        })]) },
    }
}

struct BrowserConsent;
impl Handler for BrowserConsent {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "navigate");
        Box::pin(async move {
            use maka_agent_authority::{computer::NativeCallContext, interaction_wait};
            use maka_agent_facts::interaction::{
                Decision, GrantCapability, GrantScope, InteractionOutcome, InteractionRecord,
                InteractionRequest,
            };
            let capsule = context
                .native_context::<NativeCallContext>()
                .ok_or_else(|| {
                    HandlerError::from("Browser fixture requires its native caller capsule")
                })?;
            let access = capsule.access();
            access
                .bind_original(&context)
                .await
                .map_err(|error| HandlerError::Unknown {
                    diagnostic: error.to_string(),
                })?;
            let configuration = access
                .current()
                .await
                .map_err(|error| HandlerError::from(error.to_string()))?;
            let origin = input["url"].as_str().expect("validated fixture origin URL");
            let mut ticket = context
                .scope()
                .resources
                .reserve()
                .map_err(|error| HandlerError::from(error.to_string()))?;
            ticket.start();
            let mut records = Vec::with_capacity(6);
            let observed = async {
                for (name, capability) in [
                    ("page", GrantCapability::Browser),
                    ("download", GrantCapability::BrowserDownload),
                    ("upload", GrantCapability::BrowserUpload),
                ] {
                    for original in [true, false] {
                        let mut target = maka_workspace_api::computer::target();
                        target.capability = capability;
                        target.scope = GrantScope::BrowserOrigin {
                            origin: origin.to_owned(),
                        };
                        if !original {
                            target.provider_id = "foreign_browser_provider".into();
                        }
                        let record = InteractionRecord {
                            execution: access.call().execution.clone(),
                            request_id: format!(
                                "{}:{name}_browser_{}",
                                access.call().tool_use_id(),
                                if original { "original" } else { "foreign" }
                            ),
                            created_at: now(),
                            request: InteractionRequest::ClientCapability {
                                tool_use_id: access.call().tool_use_id(),
                                target,
                                basis: Some(configuration.permission_basis()),
                            },
                            outcome: None,
                        };
                        records.push(record);
                        access
                            .establish(records.last().expect("original request"))
                            .await?;
                    }
                }
                for record in records.iter().step_by(2) {
                    let outcome =
                        interaction_wait::wait(access, record, &context.scope().cancellation)
                            .await?;
                    if !matches!(
                        outcome,
                        InteractionOutcome::ClientCapabilityDecision {
                            decision: Decision::Allow,
                            ..
                        }
                    ) {
                        return Err("Browser consent fixture was cancelled or denied".to_owned());
                    }
                }
                // Negative observations remain pending until the real caller issues Stop.
                context.scope().cancellation.cancelled().await;
                Ok::<(), String>(())
            }
            .await;
            let mut cleanup = None;
            for record in &records {
                if let Err(error) = interaction_wait::withdraw(access, record).await {
                    cleanup.get_or_insert(error);
                }
            }
            if let Some(error) = cleanup {
                ticket.complete(Err(error.into()));
                return Err(HandlerError::Unknown {
                    diagnostic: error.into(),
                });
            }
            ticket.complete(Ok(()));
            observed.map_err(HandlerError::from)?;
            Err(HandlerError::from(
                "Browser consent fixture stopped without navigation",
            ))
        })
    }
}
impl NativeOwner for BrowserConsent {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn client_consent_does_not_follow_a_rebound_workspace_with_equal_numeric_epochs() {
    use maka_agent_authority::computer::NativeCallContext;
    use maka_agent_facts::interaction::{InteractionRecord, InteractionRequest};
    use maka_agent_ports::execution::Interactions as _;

    struct Capture(tokio::sync::mpsc::UnboundedSender<Arc<NativeCallContext>>);
    impl Handler for Capture {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> BoxFuture<'static, HandlerResult> {
            self.0
                .send(context.native_context::<NativeCallContext>().unwrap())
                .unwrap_or_else(|_| panic!("actual caller receiver closed"));
            BrowserConsent.call(method, input, context)
        }
    }
    impl NativeOwner for Capture {
        fn close(&self) -> BoxFuture<'static, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }
    async fn page_request(fixture: &Fixture, session: &str) -> InteractionRecord {
        let store = fixture.owner.durable.interactions();
        let mut changes = store.subscribe().unwrap();
        loop {
            changes.borrow_and_update();
            let records = store.pending(session).await.unwrap().records;
            if records.len() == 6 {
                return records
                    .into_iter()
                    .find(|record| record.request_id.ends_with(":page_browser_original"))
                    .unwrap();
            }
            changes.changed().await.unwrap();
        }
    }
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (sent, mut captured) = tokio::sync::mpsc::unbounded_channel();
        let handler = Arc::new(Capture(sent));
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(Setup::browser_consent().with_handler(handler.clone(), handler)),
        ).await;
        let session = fixture.create("Original workspace consent").await;
        let other_path = fixture.workspace.join("second-workspace");
        std::fs::create_dir(&other_path).unwrap();
        let other = fixture.mutation(2, "create", json!({"title":"Second workspace","labels":[],"workspace":{"kind":"directory","path":other_path}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(other["kind"], "created");
        let other_session = other["session"]["id"].as_str().unwrap();
        let second = fixture.store.get_session::<maka_agent_api::session::StoredSessionConfiguration>(other_session).await.unwrap().unwrap().configuration.workspace;
        let store = fixture.owner.durable.interactions();

        let queued = fixture.send(&session).await.unwrap();
        let first_run = fixture.delivered_run(&queued).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        named_tool_response(&mut socket, "Navigate", json!({"url":"https://example.com"})).await;
        drop(socket);
        let old = captured.recv().await.unwrap();
        let first_request = page_request(&fixture, &session).await;
        let old_basis = old.access().current().await.unwrap().permission_basis();
        assert_eq!(old_basis.boundary_revision, 0);
        assert_eq!(old_basis.binding.permission_epoch, 0);
        let InteractionRequest::ClientCapability { target, basis, .. } = &first_request.request else { panic!("actual native client request") };
        assert_eq!(*basis, Some(old_basis));
        let target = target.clone();
        let allowed = fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":first_request.request_id,"answer":{"kind":"client_capability","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(allowed["kind"], "recorded");
        assert_eq!(store.client_capability_grant(&session, &target).await.unwrap().unwrap().basis, Some(old_basis));
        assert!(old.access().current().await.is_ok());

        let current = fixture.store.get_session::<maka_agent_api::session::StoredSessionConfiguration>(&session).await.unwrap().unwrap();
        assert_ne!(old_basis.binding.id, second.id);
        assert_eq!(second.permission_epoch_at_attach, 0);
        fixture.store.update_session_metadata::<maka_agent_api::session::StoredSessionConfiguration, _>(&session, current.revision, move |configuration| {
            configuration.workspace = second;
            Ok(())
        }).await.unwrap();
        let rebound = fixture.owner.session(&session).await.unwrap().configuration.permission_basis();
        assert_eq!(rebound.boundary_revision, 0);
        assert_eq!(rebound.binding.permission_epoch, 0);
        assert_ne!(rebound.binding.id, old_basis.binding.id);
        assert!(store.client_capability_grant(&session, &target).await.unwrap().is_none());
        assert!(old.access().current().await.err().unwrap().to_string().contains("workspace binding changed"));
        let mut stale = first_request.clone();
        stale.request_id.push_str("-stale");
        stale.outcome = None;
        assert!(old.access().establish(&stale).await.unwrap_err().contains("workspace binding changed"));
        assert!(store.read(&session, &stale.request_id).await.unwrap().is_none());
        fixture.mutation(2, "stop", json!({"sessionId":session,"runId":first_run}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;

        let queued = fixture.send(&session).await.unwrap();
        let second_run = fixture.delivered_run(&queued).await;
        assert_ne!(first_run, second_run);
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        named_tool_response(&mut socket, "Navigate", json!({"url":"https://example.com"})).await;
        drop(socket);
        let new = captured.recv().await.unwrap();
        let second_request = page_request(&fixture, &session).await;
        assert_eq!(new.access().current().await.unwrap().permission_basis(), rebound);
        let mut old_basis_request = second_request.clone();
        old_basis_request.request_id.push_str("-old-basis");
        let InteractionRequest::ClientCapability { basis, .. } = &mut old_basis_request.request else { panic!("actual native client request") };
        *basis = Some(old_basis);
        assert!(new.access().establish(&old_basis_request).await.is_err());
        assert!(store.read(&session, &old_basis_request.request_id).await.unwrap().is_none());
        let allowed = fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":second_request.request_id,"answer":{"kind":"client_capability","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(allowed["kind"], "recorded");
        assert_eq!(store.client_capability_grant(&session, &target).await.unwrap().unwrap().basis, Some(rebound));
        assert!(old.access().current().await.is_err());
        assert!(old.access().establish(&stale).await.is_err());
        assert!(new.access().current().await.is_ok());
        assert!(new.access().establish(&old_basis_request).await.is_err());
        let facts = fixture.history_items(&session).await;
        assert_eq!(facts.iter().filter(|item| item.recorded.run == second_run && matches!(item.recorded.fact, Fact::ToolAdmitted { .. })).count(), 1);
        fixture.mutation(2, "stop", json!({"sessionId":session,"runId":second_run}), Uuid::new_v4()).await.unwrap();
        drop(old);
        drop(new);
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.expect("workspace-bound native consent timed out");
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
    fixture
        .recorded_facts(session)
        .await
        .into_iter()
        .map(|recorded| recorded.fact)
        .collect()
}

pub(super) async fn stored_facts(
    fixture: &Fixture,
    session: &str,
) -> Vec<maka_agent_state::session_history::HistoryItem> {
    fixture.history_items(session).await
}

pub(super) async fn tool_return(
    fixture: &Fixture,
    session: &str,
    item: &maka_agent_state::session_history::HistoryItem,
) -> maka_agent_facts::artifact::ToolReturn<maka_agent_facts::tool_output::ReturnedToolResult> {
    let reference = match &item.recorded.fact {
        Fact::HostToolResultRecorded { result, .. } | Fact::LocalToolReturned { result, .. } => {
            result
        }
        other => panic!("expected original producer T2, found {other:?}"),
    };
    serde_json::from_slice(
        &fixture
            .history(session)
            .content(item.recorded.run, reference)
            .await
            .unwrap(),
    )
    .unwrap()
}

pub(super) async fn pending_approval(
    fixture: &Fixture,
    session: &str,
) -> maka_agent_facts::interaction::InteractionRecord {
    let interactions = fixture.owner.durable.interactions();
    let mut commits = fixture.owner.durable.subscribe().unwrap();
    loop {
        commits.borrow_and_update();
        if let Some(record) = interactions
            .pending(session)
            .await
            .unwrap()
            .records
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
            Fact::RunTerminated {
                terminal: Terminal::Completed,
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
        let run = fixture.delivered_run(&accepted).await;
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
        let step = recorded.iter().find_map(|fact| match fact {
            Fact::StepPrepared { step, .. } if step.to_string() == step_id => Some(*step),
            _ => None,
        }).unwrap();
        let request = fixture.owner.durable.request(run, step).await.unwrap();
        let frozen: Value = serde_json::from_slice(&fixture.owner.durable.content(run, request.request).await.unwrap()).unwrap();
        assert_eq!(frozen["itemAcceptance"], false);
        let attempt = recorded.iter().find_map(|fact| match fact {
            Fact::ModelAttemptPrepared { attempt, step: original } if *original == step => Some(*attempt),
            _ => None,
        }).unwrap();
        assert!(recorded.iter().any(|fact| matches!(fact, Fact::ModelClosed { attempt: original, .. } if *original == attempt)));
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
                assert_eq!(event["fact"], json!({"kind":"step_ended","stepId":step_id,"attemptId":attempt,"completed":true}));
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
        fixture.mutation(2, "stop", json!({"sessionId":session,"runId":run}),
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
                .filter(|fact| matches!(fact, Fact::ToolAdmitted { .. }))
                .count(),
            1
        );
        let stored = stored_facts(&fixture, &session).await;
        let event = stored
            .iter()
            .find(|item| matches!(item.recorded.fact, Fact::HostToolResultRecorded { .. }))
            .unwrap();
        let returned = tool_return(&fixture, &session, event).await;
        assert!(!returned.body.is_error);
        assert_eq!(
            returned.body.projection,
            DurableToolProjection::Json {
                value: json!({"effects":1})
            }
        );
        let raw = returned.body.output;
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
        struct ArtifactBytes(String);
        impl maka_event_log::connection::Query for ArtifactBytes {
            type Output = Option<Vec<u8>>;
            fn execute(self, connection: &rusqlite::Connection) -> Result<Self::Output, maka_event_log::StoreError> {
                maka_event_log::content::read(connection, &self.0)
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (model_entered, entered) = tokio::sync::oneshot::channel();
        let (release_model, model_released) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            model_entered.send(()).unwrap();
            model_released.await.unwrap();
            tool_response(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let next = request(&mut socket).await;
            let text = next.to_string();
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
        let run = fixture.delivered_run(&accepted).await;
        entered.await.unwrap();
        let initial = fixture.recorded_facts(&session).await;
        let admitted = initial.iter().find(|recorded| recorded.run == run && matches!(recorded.fact, Fact::RunAdmitted { .. })).unwrap();
        let Fact::RunAdmitted { spec } = &admitted.fact else { unreachable!() };
        let spec_bytes = fixture.owner.durable.content(run, spec.clone()).await.unwrap();
        let original_spec: maka_agent_facts::durable::RunSpec = serde_json::from_slice(&spec_bytes).unwrap();
        let mut retained_contents = vec![(spec.clone(), spec_bytes)];
        let mut original_requests = Vec::new();
        for recorded in &initial {
            if let Fact::StepPrepared { step, request, .. } = &recorded.fact
                && recorded.run == run
            {
                let bytes = fixture.owner.durable.content(run, request.clone()).await.unwrap();
                original_requests.push((*step, fixture.owner.durable.request(run, *step).await.unwrap()));
                retained_contents.push((request.clone(), bytes));
            }
        }
        assert!(!original_requests.is_empty(), "capture the real first prepared request before its tool response");
        release_model.send(()).unwrap();
        fixture.drained().await;
        let blocked = fixture.owner.durable.frontier(run).await.unwrap();
        let (blocker, _) = blocked.blockers.iter().find(|(_, blocker)| matches!(blocker.reason,
            maka_agent_facts::durable::BlockerKind::OperationUnknown { .. })).unwrap();
        let original_reference = blocked.tools.values().find_map(|tool| tool.original.clone()).unwrap();
        let original_sdk = fixture.store.operation(&original_reference).unwrap().operation_observation().await.unwrap().unwrap();
        let original_intent = fixture.store.application_intent(original_spec.owner.deployment,
            original_spec.owner.namespace.clone(), original_reference.operation).await.unwrap().unwrap();
        assert_eq!(original_intent.reference, original_reference);
        assert_eq!(original_intent.consumer, original_spec.owner.namespace);
        assert_eq!(original_intent.caller.deployment, original_spec.owner.deployment);
        assert_eq!(blocked.attempts.len(), 1, "unknown effects must not automatically start another model attempt");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        let revision = fixture.store.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().revision;
        let removed = fixture.mutation(2, "changeSession", json!({
            "sessionId":session,"expectedRevision":revision,"action":"remove"
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(removed, json!({"kind":"rejected","reason":"busy"}));
        fixture.mutation(2, "adjudicateRisk", json!({
            "sessionId":session, "runId":run, "expectedHighWater":blocked.revision,
            "blockerId":blocker, "decision":{"kind":"authorize_replan", "evidence":{
                "kind":"text", "text":"Continue planning without repeating the uncertain original mutation."
            }}
        }), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        let facts = facts(&fixture, &session).await;
        server.await.unwrap();
        let (tool, operation) = facts.iter().find_map(|fact| match fact {
            Fact::OperationObserved { tool, reply } if matches!(reply.receipt,
                Receipt::Recorded { outcome: OperationOutcome::Unknown { .. }, .. }) => Some((tool, reply)),
            _ => None,
        }).unwrap();
        assert_eq!(facts.iter().filter(|fact| matches!(fact,
            Fact::ToolAdmitted { tool: original } if original == tool)).count(), 1,
            "the original mutation has exactly one canonical T1");
        assert_eq!(facts.iter().filter(|fact| matches!(fact,
            Fact::OperationObserved { tool: original, reply } if original == tool && matches!(reply.receipt,
                Receipt::Recorded { outcome: OperationOutcome::Unknown { .. }, .. }))).count(), 1,
            "the original mutation has exactly one canonical Unknown outcome");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        assert_eq!(operation.reference.namespace, id(21));
        assert_eq!(operation.reference.method, "write");
        assert!(matches!(operation.receipt, Receipt::Recorded {
            outcome: OperationOutcome::Unknown { .. },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed
        }));
        let accepted = facts.iter().find_map(|fact| match fact {
            Fact::ToolResultAccepted { tool: original, result,
                outcome: maka_agent_facts::durable::AcceptedResult::RiskAdjudicated { .. } } if original == tool => Some(result),
            _ => None,
        }).unwrap();
        let accepted_bytes = fixture.owner.durable.content(run, accepted.clone()).await.unwrap();
        retained_contents.push((accepted.clone(), accepted_bytes.clone()));
        let accepted: maka_agent_facts::tool_output::AcceptedToolResult = serde_json::from_slice(&accepted_bytes).unwrap();
        assert!(matches!(accepted, maka_agent_facts::tool_output::AcceptedToolResult::RiskAdjudicated {
            decision: maka_agent_facts::durable::RiskDecision::AuthorizeReplan { .. }, ..
        }), "continuation is explicit risk acceptance, never a fabricated known tool return");
        assert_eq!(operation.reference, original_reference);
        assert_eq!(fixture.store.operation(&original_reference).unwrap().operation_observation().await.unwrap(), Some(original_sdk.clone()));
        let discarded = fixture.create("Disposable independent artifact owner").await;
        let discarded_scope = maka_agent_state::artifacts::SessionScope {
            owner: original_spec.owner.clone(), session: discarded.clone(),
        };
        let root_reader = fixture.store.data_writer().unwrap();
        for (index, (reference, bytes)) in retained_contents.iter().enumerate() {
            let logical = format!("independent-owner-{run}-{index}");
            let scope = discarded_scope.clone();
            let artifact = maka_agent_facts::artifact::Artifact {
                id: maka_agent_facts::artifact::upload_artifact_id(&discarded, &logical),
                session_id: discarded.clone(), turn_id: original_spec.turn_id.clone(),
                created_at: admitted.at.0.try_into().unwrap(), name: format!("retained-original-{index}.json"),
                kind: maka_agent_facts::artifact::ArtifactKind::File, size_bytes: bytes.len() as u64,
                mime_type: Some("application/json".into()), source: maka_agent_facts::artifact::ArtifactSource::UserUpload,
                summary: Some(reference.digest.clone()),
            };
            let published = fixture.owner.durable.artifacts().upload(maka_agent_state::artifacts::Upload::new(
                scope.clone(), logical.clone(), logical, artifact, bytes.clone()
            )).await.unwrap();
            assert_eq!(&published.payload, reference, "the independent artifact owns the same actual bytes/hash");
            let observed = fixture.owner.durable.artifacts().with_content(scope, published.artifact.id, |_, reader| {
                let mut bytes = Vec::new(); reader.read_to_end(&mut bytes).unwrap(); bytes
            }).await.unwrap().unwrap();
            assert_eq!(&observed, bytes);
            assert_eq!(fixture.owner.durable.content(run, reference.clone()).await.unwrap(), *bytes);
        }
        let only_bytes = format!("artifact-only bytes owned solely by {discarded}").into_bytes();
        let only_logical = format!("artifact-only-{run}");
        let only = fixture.owner.durable.artifacts().upload(maka_agent_state::artifacts::Upload::new(
            discarded_scope.clone(), only_logical.clone(), only_logical.clone(),
            maka_agent_facts::artifact::Artifact {
                id: maka_agent_facts::artifact::upload_artifact_id(&discarded, &only_logical),
                session_id: discarded.clone(), turn_id: original_spec.turn_id.clone(),
                created_at: admitted.at.0.try_into().unwrap(), name: "artifact-only.txt".into(),
                kind: maka_agent_facts::artifact::ArtifactKind::File, size_bytes: only_bytes.len() as u64,
                mime_type: Some("text/plain".into()), source: maka_agent_facts::artifact::ArtifactSource::UserUpload,
                summary: None,
            }, only_bytes.clone()
        )).await.unwrap();
        assert_eq!(root_reader.query(ArtifactBytes(only.payload.digest.clone())).await.unwrap(), Some(only_bytes));
        let revision = fixture.store.get_session::<StoredSessionConfiguration>(&discarded).await.unwrap().unwrap().revision;
        let removed = fixture.mutation(2, "changeSession", json!({
            "sessionId":discarded,"expectedRevision":revision,"action":"remove"
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(removed["kind"], "removed");
        fixture.drained().await;
        assert!(fixture.store.get_session::<StoredSessionConfiguration>(&discarded).await.unwrap().is_none());
        assert!(fixture.owner.durable.artifacts().get(discarded_scope, only.artifact.id).await.unwrap().is_none());
        assert!(root_reader.query(ArtifactBytes(only.payload.digest)).await.unwrap().is_none(),
            "actual quiescent Session removal must collect payload bytes with no remaining owner");
        for (reference, bytes) in &retained_contents {
            assert_eq!(root_reader.query(ArtifactBytes(reference.digest.clone())).await.unwrap().as_ref(), Some(bytes),
                "releasing the independent artifact owner cannot collect the original Agent material");
            assert_eq!(fixture.owner.durable.content(run, reference.clone()).await.unwrap(), *bytes);
        }
        for (step, request) in &original_requests {
            assert_eq!(&fixture.owner.durable.request(run, *step).await.unwrap(), request);
        }
        assert_eq!(fixture.store.application_intent(original_spec.owner.deployment,
            original_spec.owner.namespace.clone(), original_reference.operation).await.unwrap(), Some(original_intent));
        assert_eq!(fixture.store.operation(&original_reference).unwrap().operation_observation().await.unwrap(), Some(original_sdk));
        let tool_use_id = maka_agent_facts::tool_call::tool_use_id(run, &maka_agent_state::fold::tool_key(tool));
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
            let original_run = fixture.delivered_run(&started).await;
            counter.entered.acquire().await.unwrap().forget();
            fixture
                .mutation(
                    2,
                    "stop",
                    json!({"sessionId":session,"runId":original_run}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            counter.cancelled.acquire().await.unwrap().forget();
            assert_eq!(fixture.owner.workers.len(), 1);
            let other = fixture.create("Other session remains available").await;
            let admitted = fixture.send(&other).await.unwrap();
            let other_run = fixture.delivered_run(&admitted).await;
            fixture
                .mutation(
                    2,
                    "stop",
                    json!({"sessionId":other,"runId":other_run}),
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
async fn model_list_calls_real_agent_directory_without_an_independent_native_grant() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::configured(&base, None, None, None, |configuration| {
            configuration.tools = vec![contract::ServiceTool {
                target: maka_host_runtime::application::ServiceTarget::Export {
                    name: EXPORT.into(),
                },
                method: "models".into(),
                name: "ModelList".into(),
                description: "Search the model directory".into(),
                result: contract::ToolResult::Json,
                confirmation: contract::ToolConfirmation::Preapproved,
                nestable: false,
                input: Default::default(),
                presentation: None,
                title: None,
            }];
        })
        .await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            assert_eq!(sent["tools"][0]["function"]["name"], "ModelList");
            named_tool_response(
                &mut socket,
                "ModelList",
                json!({"request":{"kind":"start","query":"never-match-model-list-fixture"}}),
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let next = request(&mut socket).await;
            let result = next["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "tool")
                .unwrap();
            let page: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
            assert_eq!(page["kind"], "ready", "{page}");
            assert_eq!(page["choices"], json!([]));
            assert_eq!(page["next"], Value::Null);
            response(&mut socket).await;
        });
        let session = fixture.create("Actual ModelList call").await;
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        server.await.unwrap();
        let settled = facts(&fixture, &session).await;
        assert!(settled.iter().any(|fact| matches!(
            fact,
            Fact::ToolResultAccepted {
                outcome: maka_agent_facts::durable::AcceptedResult::Succeeded,
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
        let mut setup = Setup::native(counter.clone(), false);
        setup = setup.with_query(true);
        let fixture = Fixture::with_services(&base, None, None, Some(setup)).await;
        let session = fixture
            .create("Query tool without a duplicate native grant")
            .await;
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        server.await.unwrap();
        let stored = stored_facts(&fixture, &session).await;
        let event = stored
            .iter()
            .find(|item| {
                matches!(
                    item.recorded.fact,
                    Fact::LocalToolReturned {
                        is_error: false,
                        ..
                    }
                )
            })
            .unwrap();
        assert_eq!(
            tool_return(&fixture, &session, event).await.body.output,
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
async fn code_mode_uses_selected_methods_without_duplicate_grants_and_keeps_original_receipts() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for nestable in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let counter = Counter::new(Behavior::Returned);
            let mut setup = Setup::native(counter.clone(), false);
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
                if nestable {
                    assert!(result["content"].as_str().unwrap().contains("effects"));
                }
                response(&mut socket).await;
            });
            let session = fixture.create("Code Mode native services").await;
            fixture.send(&session).await.unwrap();
            fixture.drained().await;
            server.await.unwrap();
            assert_eq!(counter.effects.load(Ordering::SeqCst), if nestable { 2 } else { 0 });
            let recorded = fixture.recorded_facts(&session).await;
            let source = fixture.latest_run(&session).await;
            let maka_agent_facts::durable::BackendSpec::Model { descriptor, .. } = &source.spec.backend else { panic!("actual model backend"); };
            let bytes = fixture.owner.durable.content(source.run, descriptor.clone()).await.unwrap();
            let accepted = crate::model::AcceptedModel::from_backend(&source.spec.backend, &bytes).unwrap();
            assert_eq!(accepted.tool_mode, ToolMode::CodeMode);
            if nestable {
                use maka_agent_facts::{cells::{CellEvent, CellOwner, CellReturnedResult}, durable::Fact, artifact::ToolReturn};
                let children: Vec<_> = recorded.iter().filter_map(|recorded| match &recorded.fact {
                    Fact::Cell { event: CellEvent::ChildPrepared { cell, operation, name, .. } } if name == "Counter" => Some((*cell, *operation)),
                    _ => None,
                }).collect();
                assert_eq!(children.len(), 2);
                assert_ne!(children[0].1, children[1].1);
                for (cell, operation) in children {
                    assert!(recorded.iter().any(|fact| matches!(&fact.fact, Fact::Cell{event:CellEvent::Started{cell:id,owner:CellOwner::Agent{link,call},..}} if *id==cell && link.run==source.run && call=="code-call")), "child has its actual admitted parent call");
                    assert_eq!(recorded.iter().filter(|fact| matches!(&fact.fact, Fact::Cell { event: CellEvent::ChildAdmitted { operation: id, .. } } if *id==operation)).count(), 1);
                    let returns: Vec<_> = recorded.iter().filter_map(|recorded| match &recorded.fact {
                        Fact::Cell { event: CellEvent::ChildResultRecorded { operation:id, result, is_error:false, .. } } if *id==operation => Some((recorded.run,result)),
                        _ => None,
                    }).collect();
                    assert_eq!(returns.len(), 1, "each nested service has one durable successful result");
                    let (run, reference) = returns[0];
                    let bytes=fixture.owner.durable.content(run,reference.clone()).await.unwrap();
                    let result:ToolReturn<CellReturnedResult>=serde_json::from_slice(&bytes).unwrap();
                    result.validate().unwrap();
                    let maka_agent_facts::tool_output::ToolOutput::Operation(reply)=result.body.output else {panic!("original native receipt must survive business projection")};
                    assert!(recorded.iter().any(|fact|matches!(&fact.fact,Fact::Cell{event:CellEvent::ChildObserved{operation:id,reply:original,..}} if *id==operation && original==reply.as_ref())));
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
            let cells=maka_agent_state::cells::CellsStore::new(fixture.store.data_writer().unwrap());
            let stored=cells.value(target,"amount").await.unwrap();
            if target==&other {assert!(stored.is_none());assert!(!cells.loaded(target).await.unwrap().contains("Counter"));}
            else {assert_eq!(serde_json::from_slice::<Value>(&stored.unwrap()).unwrap(),json!(2));assert!(cells.loaded(target).await.unwrap().contains("Counter"));}
            cells.rebuild_session(target).await.unwrap();
            assert_eq!(cells.value(target,"amount").await.unwrap().map(|bytes|serde_json::from_slice::<Value>(&bytes).unwrap()),if target==&other {None}else{Some(json!(2))});
            assert_eq!(cells.loaded(target).await.unwrap().contains("Counter"),target!=&other);

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
                Some(file_editors(true)), |settings| settings.tool_discovery = true,
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
            fixture.mutation(2, "send", json!({"sessionId":session,"message":"Use the selected editor","backend":model_backend(&selection)}), Uuid::new_v4()).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let prompt = request(&mut socket).await;
            assert_eq!(has_tool(&prompt, "exec"), expected_code);
            let (name, input) = create_document(expected_patch, "policy.txt");
            if expected_code {
                let excluded = if expected_patch { "ReplaceDocument" } else { "PatchDocument" };
                let code = format!("if (ALL_TOOLS.some(t => t.name === '{excluded}')) throw Error('excluded editor leaked'); if (!ALL_TOOLS.some(t => t.name === 'InspectDocument')) throw Error('reader lost'); text(await tools.{name}({input}));");
                code_response(&mut socket, &code).await;
            } else {
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
            let run = fixture.latest_run(&session).await;
            let maka_agent_facts::durable::BackendSpec::Model { descriptor, .. } = &run.spec.backend else { panic!("expected actual model backend"); };
            let bytes = fixture.owner.durable.content(run.run, descriptor.clone()).await.unwrap();
            let accepted = crate::model::AcceptedModel::from_backend(&run.spec.backend, &bytes).unwrap();
            assert_eq!(accepted.editing_tools, Some(expected));
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
    fn call(&self, method: String, input: Value, _: Context) -> BoxFuture<'static, HandlerResult> {
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
            Ok(HandlerValue::Json(
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
            ))
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
            json!({"sessionId":a,"message":"first blocked","backend":model_backend(&selection)}),
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
            json!({"sessionId":a,"message":"same queued","delivery":"queue","backend":model_backend(&selection)}),
            Uuid::new_v4(),
        ));
        let independent = f.mutation(
            2,
            "send",
            json!({"sessionId":b,"message":"independent started","backend":model_backend(&selection)}),
            Uuid::new_v4(),
        );
        let independent = tokio::select! {
            value = &mut first => panic!("blocked preparation returned: {value:?}"),
            value = &mut same => panic!("same Session overtook its first message: {value:?}"),
            value = independent => value.unwrap(),
        };
        assert_eq!(independent["kind"], "queued");
        assert_eq!(
            *probe.messages.lock().unwrap(),
            ["first blocked", "independent started"]
        );
        probe.release.add_permits(1);
        let first = first.await.unwrap();
        assert_eq!(first["kind"], "queued");
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
        assert!(f.owner.durable.queue().read(a.clone()).await.unwrap().entries.is_empty());
        assert!(f.owner.durable.queue().read(b.clone()).await.unwrap().entries.is_empty());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_tool_cleanup_keeps_original_custody_while_the_agent_and_application_continue() {
    tokio::time::timeout(Duration::from_secs(30), async {
        struct ArtifactBytes(String);
        impl maka_event_log::connection::Query for ArtifactBytes {
            type Output = Option<Vec<u8>>;
            fn execute(self, connection: &rusqlite::Connection) -> Result<Self::Output, maka_event_log::StoreError> {
                maka_event_log::content::read(connection, &self.0)
            }
        }
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
        let started = fixture.send(&session).await.unwrap();
        let run = fixture.delivered_run(&started).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let initial = fixture.recorded_facts(&session).await;
        let admitted = initial.iter().find(|recorded| recorded.run == run && matches!(recorded.fact, Fact::RunAdmitted { .. })).unwrap();
        let Fact::RunAdmitted { spec } = &admitted.fact else { unreachable!() };
        let spec_bytes = fixture.owner.durable.content(run, spec.clone()).await.unwrap();
        let original_spec: maka_agent_facts::durable::RunSpec = serde_json::from_slice(&spec_bytes).unwrap();
        let mut retained_contents = vec![(spec.clone(), spec_bytes)];
        let mut original_requests = Vec::new();
        for recorded in &initial {
            if let Fact::StepPrepared { step, request, .. } = &recorded.fact
                && recorded.run == run
            {
                let bytes = fixture.owner.durable.content(run, request.clone()).await.unwrap();
                original_requests.push((*step, fixture.owner.durable.request(run, *step).await.unwrap()));
                retained_contents.push((request.clone(), bytes));
            }
        }
        assert!(!original_requests.is_empty(), "capture the real first prepared request before its tool response");
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
        let settled = stored.iter().find(|item| matches!(item.recorded.fact, Fact::HostToolResultRecorded { .. })).unwrap();
        let Fact::HostToolResultRecorded { result, .. } = &settled.recorded.fact else { unreachable!() };
        retained_contents.push((result.clone(), fixture.owner.durable.content(run, result.clone()).await.unwrap()));
        let raw = tool_return(&fixture, &session, settled).await.body.output;
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
        let original_reference = observation.reference.clone();
        let original_sdk = fixture.store.operation(&original_reference).unwrap().operation_observation().await.unwrap().unwrap();
        let original_intent = fixture.store.application_intent(original_spec.owner.deployment,
            original_spec.owner.namespace.clone(), original_reference.operation).await.unwrap().unwrap();
        assert_eq!(original_intent.reference, original_reference);
        assert_eq!(original_intent.consumer, original_spec.owner.namespace);
        assert_eq!(original_intent.caller.deployment, original_spec.owner.deployment);
        assert_eq!(original_sdk.reference, original_reference);
        assert_eq!(Receipt::Recorded { outcome: original_sdk.outcome.clone(), cleanup: original_sdk.cleanup.clone() }, observation.receipt);
        assert!(recorded.iter().any(|fact| matches!(
            fact,
            Fact::RunTerminated { terminal: Terminal::Completed, .. }
        )));
        assert_eq!(fixture.owner.runs.state().await.retained_cleanup[&session].len(), 1,
            "the original failed physical cleanup has no positive completion source");
        let discarded = fixture.create("Disposable independent artifact owner").await;
        let discarded_scope = maka_agent_state::artifacts::SessionScope {
            owner: original_spec.owner.clone(), session: discarded.clone(),
        };
        let root_reader = fixture.store.data_writer().unwrap();
        for (index, (reference, bytes)) in retained_contents.iter().enumerate() {
            let logical = format!("independent-owner-{run}-{index}");
            let scope = discarded_scope.clone();
            let artifact = maka_agent_facts::artifact::Artifact {
                id: maka_agent_facts::artifact::upload_artifact_id(&discarded, &logical),
                session_id: discarded.clone(), turn_id: original_spec.turn_id.clone(),
                created_at: admitted.at.0.try_into().unwrap(), name: format!("retained-original-{index}.json"),
                kind: maka_agent_facts::artifact::ArtifactKind::File, size_bytes: bytes.len() as u64,
                mime_type: Some("application/json".into()), source: maka_agent_facts::artifact::ArtifactSource::UserUpload,
                summary: Some(reference.digest.clone()),
            };
            let published = fixture.owner.durable.artifacts().upload(maka_agent_state::artifacts::Upload::new(
                scope.clone(), logical.clone(), logical, artifact, bytes.clone()
            )).await.unwrap();
            assert_eq!(&published.payload, reference, "the independent artifact owns the same actual bytes/hash");
            let observed = fixture.owner.durable.artifacts().with_content(scope, published.artifact.id, |_, reader| {
                let mut bytes = Vec::new(); reader.read_to_end(&mut bytes).unwrap(); bytes
            }).await.unwrap().unwrap();
            assert_eq!(&observed, bytes);
            assert_eq!(fixture.owner.durable.content(run, reference.clone()).await.unwrap(), *bytes);
        }
        let only_bytes = format!("artifact-only bytes owned solely by {discarded}").into_bytes();
        let only_logical = format!("artifact-only-{run}");
        let only = fixture.owner.durable.artifacts().upload(maka_agent_state::artifacts::Upload::new(
            discarded_scope.clone(), only_logical.clone(), only_logical.clone(),
            maka_agent_facts::artifact::Artifact {
                id: maka_agent_facts::artifact::upload_artifact_id(&discarded, &only_logical),
                session_id: discarded.clone(), turn_id: original_spec.turn_id.clone(),
                created_at: admitted.at.0.try_into().unwrap(), name: "artifact-only.txt".into(),
                kind: maka_agent_facts::artifact::ArtifactKind::File, size_bytes: only_bytes.len() as u64,
                mime_type: Some("text/plain".into()), source: maka_agent_facts::artifact::ArtifactSource::UserUpload,
                summary: None,
            }, only_bytes.clone()
        )).await.unwrap();
        assert_eq!(root_reader.query(ArtifactBytes(only.payload.digest.clone())).await.unwrap(), Some(only_bytes));
        let revision = fixture.store.get_session::<StoredSessionConfiguration>(&discarded).await.unwrap().unwrap().revision;
        let removed = fixture.mutation(2, "changeSession", json!({
            "sessionId":discarded,"expectedRevision":revision,"action":"remove"
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(removed["kind"], "removed");
        fixture.drained().await;
        assert!(fixture.store.get_session::<StoredSessionConfiguration>(&discarded).await.unwrap().is_none());
        assert!(fixture.owner.durable.artifacts().get(discarded_scope, only.artifact.id).await.unwrap().is_none());
        assert!(root_reader.query(ArtifactBytes(only.payload.digest)).await.unwrap().is_none(),
            "actual quiescent Session removal must collect payload bytes with no remaining owner");
        for (reference, bytes) in &retained_contents {
            assert_eq!(root_reader.query(ArtifactBytes(reference.digest.clone())).await.unwrap().as_ref(), Some(bytes),
                "releasing the independent artifact owner cannot collect the original Agent material");
            assert_eq!(fixture.owner.durable.content(run, reference.clone()).await.unwrap(), *bytes);
        }
        let revision = fixture.store.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().revision;
        let removed = fixture.mutation(2, "changeSession", json!({
            "sessionId":session,"expectedRevision":revision,"action":"remove"
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(removed, json!({"kind":"rejected","reason":"busy"}));
        assert!(matches!(fixture.store.finish_session_retirement(&session).await,
            Err(maka_event_log::StoreError::SessionBusy)));

        assert!(!fixture.owner.stop.is_cancelled());

        let queued = fixture.send(&session).await.unwrap();
        assert_eq!(queued["kind"], "queued");
        assert!(matches!(fixture.owner.durable.queue().resolve_message(session.clone(), queued["messageId"].as_str().unwrap().to_owned()).await.unwrap(),
            maka_agent_state::queue::MessageResolution::Pending), "a new Run cannot reuse an unconfirmed physical Session scope");
        let other = fixture.create("Other conversations still work").await;
        fixture.send(&other).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket, "This independent conversation is still available.").await;
        fixture.drained().await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.owner.runs.state().await.retained_cleanup[&session].len(), 1);
        for (reference, bytes) in &retained_contents {
            assert_eq!(fixture.owner.durable.content(run, reference.clone()).await.unwrap(), *bytes);
        }
        for (step, request) in &original_requests {
            assert_eq!(&fixture.owner.durable.request(run, *step).await.unwrap(), request);
        }
        assert_eq!(fixture.store.application_intent(original_spec.owner.deployment,
            original_spec.owner.namespace.clone(), original_reference.operation).await.unwrap(), Some(original_intent));
        assert_eq!(fixture.store.operation(&original_reference).unwrap().operation_observation().await.unwrap(), Some(original_sdk));
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
