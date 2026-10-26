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
use maka_agent_facts::{
    event::{Fact, ToolOutcome},
    interaction::{InteractionRecord, InteractionRequest},
    tool_output::DurableToolProjection,
};

async fn pending(
    fixture: &Fixture,
    session: &str,
    step: &std::cell::Cell<&'static str>,
) -> InteractionRecord {
    let mut commits = fixture.session(session).await.subscribe_commits().unwrap();
    loop {
        commits.borrow_and_update();
        step.set("pending.query");
        if let Some(record) = fixture
            .session(session)
            .await
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            step.set("pending.returned");
            return record;
        }
        step.set("pending.commit_wait");
        commits.changed().await.unwrap();
        step.set("pending.commit_wait.returned");
    }
}
async fn answer(
    f: &Fixture,
    record: &InteractionRecord,
    allow: bool,
    step: &std::cell::Cell<&'static str>,
) {
    step.set("answer.mutation");
    let result = f.mutation(2, "respond", json!({"sessionId":record.session_id,"requestId":record.request_id,"answer":{"kind":"client_capability","decision":if allow { "allow" } else { "deny" }}}), Uuid::new_v4()).await.unwrap();
    step.set("answer.assertion");
    assert_eq!(result["kind"], "recorded", "{result}");
    step.set("answer.returned");
}
async fn start(
    listener: &TcpListener,
    f: &Fixture,
    session: &str,
    method: &str,
    input: Value,
    expected_state: &str,
    step: &std::cell::Cell<&'static str>,
) -> String {
    step.set("start.send");
    let receipt = f.send(session).await.unwrap();
    let invocation = receipt["invocationId"].as_str().unwrap().to_owned();
    step.set("provider.accept");
    let (mut socket, _) = listener.accept().await.unwrap();
    step.set("provider.request");
    let sent = request(&mut socket).await;
    step.set("start.descriptor_assertions");
    let tools = sent["tools"].as_array().unwrap();
    let tool = tools
        .iter()
        .find(|tool| tool["function"]["name"] == method)
        .expect("actual model tool descriptor");
    assert!(
        tool["function"]["description"]
            .as_str()
            .unwrap()
            .contains(expected_state),
        "{tool}"
    );
    step.set("start.tool_response");
    service_tools::named_tool_response(&mut socket, method, input).await;
    step.set("start.returned");
    invocation
}
async fn finish(
    listener: &TcpListener,
    f: &Fixture,
    step: &std::cell::Cell<&'static str>,
) -> Value {
    step.set("provider.accept");
    let (mut socket, _) = listener.accept().await.unwrap();
    step.set("provider.request");
    let sent = request(&mut socket).await;
    step.set("finish.response");
    response(&mut socket).await;
    step.set("finish.drain");
    f.drained().await;
    step.set("finish.returned");
    sent
}
fn tool_text(sent: &Value) -> String {
    sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .to_string()
}

#[tokio::test]
async fn computer_product_tools_preserve_approval_repl_media_and_revocation() {
    let scenario = std::cell::Cell::new("initial");
    let step = std::cell::Cell::new("initial");
    let revocation_trace = std::cell::RefCell::new(Value::Null);
    tokio::time::timeout(Duration::from_secs(90), async {
        scenario.set("listener.bind");
        step.set("direct.await");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        scenario.set("fixture.setup");
        step.set("direct.await");
        let f = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(service_tools::Setup::computer())).await;
        scenario.set("vision.enable");
        step.set("direct.await");
        images::enable_vision(&f).await;
        scenario.set("session.create");
        step.set("direct.await");
        let session = f.create("Computer").await;
        scenario.set("other_session.create");
        step.set("direct.await");
        let other = f.create("Other Computer").await;
        scenario.set("denied.start");
        step.set("direct.await");
        start(&listener, &f, &session, "cua_repl", json!({"code":"globalThis.deniedEffect = true;"}), "fresh", &step).await;
        scenario.set("denied.pending");
        step.set("direct.await");
        let denied = pending(&f, &session, &step).await;
        scenario.set("denied.pending.returned");
        step.set("returned_or_assertions");
        assert!(matches!(&denied.request, InteractionRequest::ClientCapability { target, basis: Some(basis), .. } if target == &maka_workspace_api::computer::target() && basis.boundary_revision == 0));
        scenario.set("denied.answer");
        step.set("direct.await");
        answer(&f, &denied, false, &step).await;
        scenario.set("denied.finish_assertion");
        step.set("direct.await");
        assert!(tool_text(&finish(&listener, &f, &step).await).contains("not granted"));
        scenario.set("denied.grant_assertion");
        step.set("direct.await");
        assert!(f.session(&session).await.client_capability_grant(&session, &maka_workspace_api::computer::target()).await.unwrap().is_none());
        scenario.set("denied.grant_assertion.returned");
        step.set("returned_or_assertions");
        // Real native facade operations stay journaled under the original parent;
        // browser inventory with no configured browser never touches a user app.
        // A >1 MiB image crosses the ordinary service through a durable artifact,
        // without raising the Host JSON ceiling or losing the exact image bytes.
        let png: Vec<u8> = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM7cAAAAASUVORK5CYII=").unwrap()
        };
        let mut expected = vec![0; 1100 * 1024]; expected[..png.len()].copy_from_slice(&png);
        let code = format!("if (globalThis.deniedEffect) throw Error('denied cell ran'); globalThis.counter = 41; await cua.listBrowsers(); const screenshot = new Uint8Array(1100*1024); screenshot.set({}); await nodeRepl.emitImage({{bytes:screenshot,mimeType:'image/png'}}); nodeRepl.write('computer-effect-41');", serde_json::to_string(&png).unwrap());
        scenario.set("media.start");
        step.set("direct.await");
        start(&listener, &f, &session, "cua_repl", json!({"code":code,"title":"Inspect selected browsers"}), "fresh", &step).await;
        scenario.set("media.pending");
        step.set("direct.await");
        let allowed = pending(&f, &session, &step).await;
        scenario.set("media.answer");
        step.set("direct.await");
        answer(&f, &allowed, true, &step).await;
        scenario.set("media.finish");
        step.set("direct.await");
        let sent = finish(&listener, &f, &step).await;
        scenario.set("media.finish.returned");
        step.set("returned_or_assertions");
        assert!(sent.to_string().contains("computer-effect-41"), "Computer effect output was not projected");
        assert_eq!(images::model_images(&sent), vec![expected.clone()]);
        scenario.set("media.observe");
        step.set("direct.await");
        let observed = f.query("observe", json!({"sessionId":session})).await.unwrap();
        scenario.set("media.observe.returned");
        step.set("returned_or_assertions");
        let through = observed["through"].as_u64().unwrap();
        scenario.set("media.facts");
        step.set("direct.await");
        let events = service_tools::facts(&f, &session).await;
        scenario.set("media.facts.returned");
        step.set("returned_or_assertions");
        assert!(events.iter().any(|event| matches!(event, Fact::ToolDispatched { name, call, .. } if name == "cua_operation" && matches!(&call.origin, maka_agent_facts::tool_call::ToolOrigin::HostSdk { parent_operation_id: Some(_), .. }))));
        assert!(events.iter().any(|event| matches!(event, Fact::ToolDispatched { name, title: Some(title), .. } if name == "cua_repl" && title.fallback == "Inspect selected browsers")));
        assert!(events.iter().any(|event| matches!(event, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { model_projection: DurableToolProjection::Content { parts }, .. }, .. } if parts.iter().any(|part| part.media().is_some()))));
        assert!(through > 0);
        scenario.set("counter.start");
        step.set("direct.await");
        start(&listener, &f, &session, "cua_repl", json!({"code":"nodeRepl.write(++globalThis.counter);"}), "ready", &step).await;
        scenario.set("counter.finish_assertion");
        step.set("direct.await");
        assert!(tool_text(&finish(&listener, &f, &step).await).contains("42"));
        scenario.set("counter.pending_assertion");
        step.set("direct.await");
        assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        scenario.set("counter.pending_assertion.returned");
        step.set("returned_or_assertions");
        // Grants and VM globals never leak into another Session.
        scenario.set("other.start");
        step.set("direct.await");
        start(&listener, &f, &other, "cua_repl", json!({"code":"nodeRepl.write(typeof globalThis.counter);"}), "fresh", &step).await;
        scenario.set("other.pending_then_answer");
        step.set("direct.await");
        answer(&f, &pending(&f, &other, &step).await, true, &step).await;
        scenario.set("other.finish_assertion");
        step.set("direct.await");
        assert!(tool_text(&finish(&listener, &f, &step).await).contains("undefined"));
        scenario.set("other.finish_assertion.returned");
        step.set("returned_or_assertions");
        // Revocation stops the cell; reset joins the VM before replacing it.
        scenario.set("revocation.start");
        step.set("direct.await");
        let revocation_invocation = start(&listener, &f, &session, "cua_repl", json!({"code":"await cua.listBrowsers(); nodeRepl.write('waiting'); await new Promise(() => {});","timeout_ms":120000}), "ready", &step).await;
        scenario.set("revocation.start.returned");
        step.set("returned_or_assertions");
        let mut commits = f.session(&session).await.subscribe_commits().unwrap();
        loop {
            let observed_commit = *commits.borrow_and_update();
            scenario.set("revocation.dispatch_facts");
            step.set("direct.await");
            let stored = service_tools::stored_facts(&f, &session).await;
            let events: Vec<_> = stored.iter()
                .filter(|event| event.event.invocation.invocation_id == revocation_invocation)
                .collect();
            scenario.set("revocation.dispatch_facts.returned");
            step.set("returned_or_assertions");
            *revocation_trace.borrow_mut() = json!({
                "factCount": events.len(),
                "invocationId": revocation_invocation,
                "observedCommit": observed_commit,
                "lastSequence": stored.last().map(|event| event.sequence),
                "lastFacts": events.iter().rev().take(32).rev().map(|stored| {
                    let event = &stored.event.fact;
                    let mut row = match event {
                        Fact::ToolDispatched { operation_id, call, name, input, .. } => json!({
                            "kind":event.kind(), "operationId":operation_id, "call":call,
                            "name":name, "method":input.get("method"),
                            "revocationCell":name == "cua_repl" && input["code"] == "await cua.listBrowsers(); nodeRepl.write('waiting'); await new Promise(() => {});"
                        }),
                        Fact::ToolSettled { operation_id, outcome } => json!({
                            "kind":event.kind(), "operationId":operation_id,
                            "outcome":match outcome {
                                ToolOutcome::Succeeded { .. } => json!({"kind":"succeeded"}),
                                ToolOutcome::Failed { message } => json!({"kind":"failed", "message":message.chars().take(1024).collect::<String>()}),
                                ToolOutcome::Unknown { message, .. } => json!({"kind":"unknown", "message":message.chars().take(1024).collect::<String>()}),
                            }
                        }),
                        Fact::ToolRejected { operation_id, name, reason, .. } => json!({
                            "kind":event.kind(), "operationId":operation_id, "name":name,
                            "reason":reason.to_string().chars().take(1024).collect::<String>(),
                        }),
                        Fact::InvocationEnded { outcome } => json!({
                            "kind":event.kind(), "status":outcome.status(),
                        }),
                        Fact::ModelInterrupted { step_id, status, diagnostic, .. } => json!({
                            "kind":event.kind(), "stepId":step_id, "status":status,
                            "diagnostic":diagnostic.as_ref().map(|text| text.chars().take(1024).collect::<String>()),
                        }),
                        _ => json!({"kind":event.kind(), "operationId":event.operation_id()}),
                    };
                    row["sequence"] = json!(stored.sequence);
                    row
                }).collect::<Vec<_>>()
            });
            if let Some(operation) = events.iter().find_map(|event| match &event.event.fact {
                Fact::ToolDispatched { operation_id, name, input, .. }
                    if name == "cua_repl" && input["code"] == "await cua.listBrowsers(); nodeRepl.write('waiting'); await new Promise(() => {});" => Some(operation_id),
                _ => None,
            }) {
                if events.iter().any(|event| matches!(&event.event.fact,
                    Fact::ToolDispatched { input, name, call, .. }
                        if name == "cua_operation" && input["method"] == "listBrowsers"
                            && matches!(&call.origin, maka_agent_facts::tool_call::ToolOrigin::HostSdk {
                                parent_operation_id: Some(parent), ..
                            } if parent == operation))) { break; }
                assert!(!events.iter().any(|event| matches!(&event.event.fact, Fact::ToolSettled { operation_id, .. } if operation_id == operation)),
                    "revocation cell settled before its expected child dispatch: {}", revocation_trace.borrow());
            }
            assert!(!events.iter().any(|event| matches!(&event.event.fact,
                Fact::ToolRejected { name, .. } if name == "cua_repl")
                || matches!(&event.event.fact, Fact::ModelInterrupted { .. } | Fact::InvocationEnded { .. })),
                "current invocation ended before its expected child dispatch: {}", revocation_trace.borrow());
            scenario.set("revocation.commit_wait");
            step.set("direct.await");
            commits.changed().await.unwrap();
            scenario.set("revocation.commit_wait.returned");
            step.set("returned_or_assertions");
        }
        scenario.set("revocation.policy_change");
        step.set("direct.await");
        assert_eq!(files::change(&f, &session, "workspace_write", true, true).await["kind"], "committed");
        scenario.set("revocation.finish");
        step.set("direct.await");
        let cancelled = finish(&listener, &f, &step).await;
        scenario.set("revocation.finish.returned");
        step.set("returned_or_assertions");
        let stopped = tool_text(&cancelled);
        assert!(stopped.contains("changed") || stopped.contains("revoked") || stopped.contains("cancelled"), "{stopped}");
        assert!(stopped.contains("reset_required"), "{stopped}");
        scenario.set("reset.start");
        step.set("direct.await");
        start(&listener, &f, &session, "cua_reset", json!({}), "reset_required", &step).await;
        scenario.set("reset.finish_assertion");
        step.set("direct.await");
        assert!(tool_text(&finish(&listener, &f, &step).await).contains("reset"));
        scenario.set("renewal.start");
        step.set("direct.await");
        start(&listener, &f, &session, "cua_repl", json!({"code":"nodeRepl.write(typeof globalThis.counter);"}), "fresh", &step).await;
        scenario.set("renewal.pending");
        step.set("direct.await");
        let renewal = pending(&f, &session, &step).await;
        scenario.set("renewal.pending.returned");
        step.set("returned_or_assertions");
        assert!(matches!(renewal.request, InteractionRequest::ClientCapability { basis: Some(basis), .. } if basis.boundary_revision == 1));
        scenario.set("renewal.answer");
        step.set("direct.await");
        answer(&f, &renewal, true, &step).await;
        scenario.set("renewal.finish_assertion");
        step.set("direct.await");
        assert!(tool_text(&finish(&listener, &f, &step).await).contains("undefined"));
        scenario.set("app.shutdown");
        step.set("direct.await");
        f.app.shutdown().await.unwrap();
        scenario.set("config.shutdown");
        step.set("direct.await");
        f.config.shutdown().await.unwrap();
        scenario.set("config.shutdown.returned");
        step.set("returned_or_assertions");
    }).await.inspect_err(|_| eprintln!("Computer test timed out: scenario={} helper={} revocation={}", scenario.get(), step.get(), revocation_trace.borrow())).unwrap();
}
