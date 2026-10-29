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
use base64::Engine;
use maka_agent_facts::{
    event::{Fact, LogScope, StoredEvent, ToolOutcome},
    interaction::{InteractionRecord, InteractionRequest},
    tool_output::DurableToolProjection,
};
use maka_app_client::Client;
use maka_capabilities::call::Attachments;

async fn create(client: &Client, title: &str) -> String {
    let roots = client
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    support::mutate(client, "create", json!({"title":title,"labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await["session"]["id"].as_str().unwrap().into()
}

async fn send(fixture: &Fixture, client: &Client, session: &str, message: &str) -> Value {
    support::mutate(
        client,
        "send",
        json!({"sessionId":session,"message":message,"model":fixture.selection}),
    )
    .await
}

async fn mutation(
    client: &Client,
    method: &str,
    input: Value,
    operation: Uuid,
) -> Result<Value, String> {
    let mutation = client
        .mutation(
            operation,
            "agent",
            method,
            input,
            Attachments::new(),
            None,
            Value::Null,
        )
        .await?;
    mutation.prepare().await?;
    let reply = mutation.confirm().await?;
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            ..
        } => Ok(value),
        other => panic!("unexpected actual Host receipt: {other:?}"),
    }
}

async fn pending(fixture: &Fixture, session: &str) -> InteractionRecord {
    let store = fixture.store.session(session).await.unwrap();
    let mut commits = store.subscribe_commits().unwrap();
    loop {
        commits.borrow_and_update();
        if let Some(record) = store
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            return record;
        }
        commits.changed().await.unwrap();
    }
}

async fn answer(client: &Client, record: &InteractionRecord, allow: bool) {
    let result = support::mutate(client, "respond", json!({"sessionId":record.session_id,"requestId":record.request_id,"answer":{"kind":"client_capability","decision":if allow {"allow"} else {"deny"}}})).await;
    assert_eq!(result["kind"], "recorded", "{result}");
}

async fn start(
    fixture: &mut Fixture,
    client: &Client,
    session: &str,
    method: &str,
    input: Value,
    expected_state: &str,
) -> String {
    let receipt = send(fixture, client, session, "Hello").await;
    let invocation = receipt["invocationId"].as_str().unwrap().to_owned();
    let request = fixture.next_request().await;
    let tool = request.body["tools"]
        .as_array()
        .unwrap()
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
    request.tool(method, input).await;
    invocation
}

async fn finish(fixture: &mut Fixture, client: &Client, session: &str) -> Value {
    let request = fixture.next_request().await;
    let sent = request.body.clone();
    request.finish().await;
    fixture.idle(client, session).await;
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

async fn stored_facts(fixture: &Fixture, session: &str) -> Vec<StoredEvent> {
    fixture
        .store
        .session(session)
        .await
        .unwrap()
        .scoped_prefix(
            LogScope::Session { id: session.into() },
            usize::MAX,
            usize::MAX,
        )
        .await
        .unwrap()
        .events
}

async fn facts(fixture: &Fixture, session: &str) -> Vec<Fact> {
    stored_facts(fixture, session)
        .await
        .into_iter()
        .map(|event| event.event.fact)
        .collect()
}

fn model_images(sent: &Value) -> Vec<Vec<u8>> {
    sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "image_url")
        .map(|part| {
            let url = part["image_url"]["url"].as_str().unwrap();
            base64::engine::general_purpose::STANDARD
                .decode(
                    url.strip_prefix("data:image/")
                        .and_then(|image| image.split_once(";base64,").map(|(_, data)| data))
                        .expect("actual image model input"),
                )
                .unwrap()
        })
        .collect()
}

async fn revoke(client: &Client, session: &str) -> Value {
    let current = client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap()["session"]
        .clone();
    support::mutate(client, "metadata", json!({"sessionId":session,"expectedRevision":current["revision"],"title":current["title"],"labels":current["labels"],"permissions":{"settings":{"access":"workspace_write","requestPermissions":true},"revokeGrants":true}})).await
}

async fn resume_input(fixture: &Fixture, source: &Value) -> Value {
    json!({"sessionId":source["sessionId"],"sourceInvocationId":source["invocationId"],"sourceHighWater":source["highWater"],"model":fixture.selection})
}

#[tokio::test]
async fn computer_product_tools_preserve_approval_repl_media_and_revocation() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut f = Fixture::configured(support::Options { services: support::Services::ComputerTools, ..Default::default() }).await;
        let client = f.client().await;
        let session = f.session.clone();
        let other = create(&client, "Other Computer").await;
        start(&mut f, &client, &session, "cua_repl", json!({"code":"globalThis.deniedEffect = true;"}), "fresh").await;
        let denied = pending(&f, &session).await;
        assert!(matches!(&denied.request, InteractionRequest::ClientCapability { target, basis: Some(basis), .. } if target == &maka_workspace_api::computer::target() && basis.boundary_revision == 0));
        answer(&client, &denied, false).await;
        assert!(tool_text(&finish(&mut f, &client, &session).await).contains("not granted"));
        assert!(f.store.session(&session).await.unwrap().client_capability_grant(&session, &maka_workspace_api::computer::target()).await.unwrap().is_none());

        // Real native facade operations stay journaled under the original parent;
        // browser inventory with no configured browser never touches a user app.
        // A >1 MiB image crosses the ordinary service through a durable artifact,
        // without raising the Host JSON ceiling or losing the exact image bytes.
        let png: Vec<u8> = {
            base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM7cAAAAASUVORK5CYII=").unwrap()
        };
        let mut expected = vec![0; 1100 * 1024]; expected[..png.len()].copy_from_slice(&png);
        let code = format!("if (globalThis.deniedEffect) throw Error('denied cell ran'); globalThis.counter = 41; await cua.listBrowsers(); const screenshot = new Uint8Array(1100*1024); screenshot.set({}); await nodeRepl.emitImage({{bytes:screenshot,mimeType:'image/png'}}); nodeRepl.write('computer-effect-41');", serde_json::to_string(&png).unwrap());
        start(&mut f, &client, &session, "cua_repl", json!({"code":code,"title":"Inspect selected browsers"}), "fresh").await;
        let allowed = pending(&f, &session).await;
        answer(&client, &allowed, true).await;
        let sent = finish(&mut f, &client, &session).await;
        assert!(sent.to_string().contains("computer-effect-41"), "Computer effect output was not projected");
        assert_eq!(model_images(&sent), vec![expected.clone()]);
        let observed = client.query("agent", "observe", json!({"sessionId":session})).await.unwrap();
        let through = observed["through"].as_u64().unwrap();
        let events = facts(&f, &session).await;
        let media_epoch = events.iter().find_map(|event| match event {
            Fact::ToolDispatched { operation_id: child, name, call, .. } if name == "cua_operation" => match &call.origin {
                maka_agent_facts::tool_call::ToolOrigin::HostSdk {
                    parent: Some(maka_agent_facts::tool_call::HostSdkParent::EvaluationObserver { operation_id: parent, epoch }), ..
                } if parent != child && !epoch.is_empty() && events.iter().any(|event| matches!(event,
                    Fact::ToolDispatched { operation_id, name, title: Some(title), .. }
                        if operation_id == parent && name == "cua_repl" && title.fallback == "Inspect selected browsers"
                )) => Some(epoch.clone()),
                _ => None,
            },
            _ => None,
        }).expect("native media call must retain its exact evaluation parent and VM epoch");
        assert!(events.iter().any(|event| matches!(event, Fact::ToolDispatched { name, title: Some(title), .. } if name == "cua_repl" && title.fallback == "Inspect selected browsers")));
        assert!(events.iter().any(|event| matches!(event, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { model_projection: DurableToolProjection::Content { parts }, .. }, .. } if parts.iter().any(|part| part.media().is_some()))));
        assert!(through > 0);
        start(&mut f, &client, &session, "cua_repl", json!({"code":"nodeRepl.write(++globalThis.counter);"}), "ready").await;
        assert!(tool_text(&finish(&mut f, &client, &session).await).contains("42"));
        assert!(f.store.session(&session).await.unwrap().pending_interactions(&session).await.unwrap().is_empty());

        // Grants and VM globals never leak into another Session.

        start(&mut f, &client, &other, "cua_repl", json!({"code":"nodeRepl.write(typeof globalThis.counter);"}), "fresh").await;
        answer(&client, &pending(&f, &other).await, true).await;
        assert!(tool_text(&finish(&mut f, &client, &other).await).contains("undefined"));

        // Revocation stops the cell; reset joins the VM before replacing it.

        let revocation_invocation = start(&mut f, &client, &session, "cua_repl", json!({"code":"await cua.listBrowsers(); nodeRepl.write('waiting'); await new Promise(() => {});","timeout_ms":120000}), "ready").await;
        let mut commits = f.store.session(&session).await.unwrap().subscribe_commits().unwrap();
        loop {
            commits.borrow_and_update();
            let stored = stored_facts(&f, &session).await;
            let events: Vec<_> = stored.iter()
                .filter(|event| event.event.invocation.invocation_id == revocation_invocation)
                .collect();
            if let Some(operation) = events.iter().find_map(|event| match &event.event.fact {
                Fact::ToolDispatched { operation_id, name, input, .. }
                    if name == "cua_repl" && input["code"] == "await cua.listBrowsers(); nodeRepl.write('waiting'); await new Promise(() => {});" => Some(operation_id),
                _ => None,
            }) {
                if events.iter().any(|event| matches!(&event.event.fact,
                    Fact::ToolDispatched { input, name, call, .. }
                        if name == "cua_operation" && input["method"] == "listBrowsers"
                            && matches!(&call.origin, maka_agent_facts::tool_call::ToolOrigin::HostSdk {
                                parent: Some(maka_agent_facts::tool_call::HostSdkParent::EvaluationObserver { operation_id: parent, epoch }), ..
                            } if parent == operation && epoch == &media_epoch))) { break; }
                assert!(!events.iter().any(|event| matches!(&event.event.fact, Fact::ToolSettled { operation_id, .. } if operation_id == operation)),
                    "revocation cell settled before its expected child dispatch: {:?}", events);
            }
            assert!(!events.iter().any(|event| matches!(&event.event.fact,
                Fact::ToolRejected { name, .. } if name == "cua_repl")
                || matches!(&event.event.fact, Fact::ModelInterrupted { .. } | Fact::InvocationEnded { .. })),
                "current invocation ended before its expected child dispatch: {:?}", events);
            commits.changed().await.unwrap();
        }
        assert_eq!(revoke(&client, &session).await["kind"], "committed");
        let cancelled = finish(&mut f, &client, &session).await;
        let stopped: String = serde_json::from_str(&tool_text(&cancelled))
            .expect("revocation must return a textual tool result");
        assert!(stopped.contains("changed") || stopped.contains("revoked") || stopped.contains("cancelled"), "{stopped}");
        assert_eq!(stopped.lines().last(), Some(r#"REPL state: "fresh""#), "{stopped}");
        start(&mut f, &client, &session, "cua_reset", json!({}), "fresh").await;
        assert!(tool_text(&finish(&mut f, &client, &session).await).contains("reset"));
        start(&mut f, &client, &session, "cua_repl", json!({"code":"nodeRepl.write(typeof globalThis.counter);"}), "fresh").await;
        let renewal = pending(&f, &session).await;
        assert!(matches!(renewal.request, InteractionRequest::ClientCapability { basis: Some(basis), .. } if basis.boundary_revision == 1));
        answer(&client, &renewal, true).await;
        assert!(tool_text(&finish(&mut f, &client, &session).await).contains("undefined"));
        client.close().await.unwrap();
        f.finish().await;
    }).await.expect("real Computer approval, media and revocation workflow timed out");
}

fn assert_computer_state(request: &Value, expected: &str) {
    let tool = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "cua_repl")
        .expect("real Computer tool descriptor");
    assert!(
        tool["function"]["description"]
            .as_str()
            .unwrap()
            .contains(&format!("Current REPL state: {expected}.")),
        "{tool}"
    );
}

async fn assert_computer_output(fixture: &Fixture, session: &str, expected: &str) {
    let facts = facts(fixture, session).await;
    let outcome = facts
        .iter()
        .rev()
        .find_map(|fact| match fact {
            Fact::ToolSettled { outcome, .. } => Some(outcome),
            _ => None,
        })
        .expect("actual Computer settlement");
    let ToolOutcome::Succeeded {
        model_projection: DurableToolProjection::Text { text },
        ..
    } = outcome
    else {
        panic!("expected successful Computer text output: {outcome:?}");
    };
    assert_eq!(text, &format!("{expected}\nREPL state: \"ready\""));
}

async fn computer_resume_replays_original_input_without_duplicate_effects(stop: bool) {
    const SECRET: &str = "SECRET_MAIN_PROVIDER_BODY_SENTINEL";
    const DETAIL: &str = "tool choice is unsupported for this model";

    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::configured(support::Options { services: support::Services::ComputerTools, ..Default::default() }).await;
        let client = fixture.client().await;
        let session = fixture.session.clone();

        // Establish a real approved Computer VM before interrupting another run.
        send(&fixture, &client, &session, "Hello").await;
        let request = fixture.next_request().await;
        assert_computer_state(&request.body, "fresh");
        request.tool(
            "cua_repl",
            json!({"code":"globalThis.resumeCounter = 40; nodeRepl.write(globalThis.resumeCounter);"}),
        )
        .await;
        let mut commits = fixture.store.session(&session).await.unwrap().subscribe_commits().unwrap();
        let approval = loop {
            commits.borrow_and_update();
            if let Some(record) = fixture.store.session(&session).await.unwrap().pending_interactions(&session)
                .await
                .unwrap()
                .into_iter()
                .next()
            {
                break record;
            }
            commits.changed().await.unwrap();
        };
        assert!(matches!(&approval.request, InteractionRequest::ClientCapability { target, .. } if target == &maka_workspace_api::computer::target()));
        assert_eq!(mutation(&client, "respond", json!({"sessionId":session,"requestId":approval.request_id,"answer":{"kind":"client_capability","decision":"allow"}}), Uuid::new_v4()).await.unwrap()["kind"], "recorded");
        let request = fixture.next_request().await;
        assert_computer_output(&fixture, &session, "40").await;
        request.finish().await;
        fixture.idle(&client, &session).await;

        let sent = send(&fixture, &client, &session, "Hello").await;
        let request = fixture.next_request().await;
        assert_computer_state(&request.body, "ready");
        if stop {
            assert_eq!(mutation(&client, "stop", json!({"sessionId":session,"invocationId":sent["invocationId"]}), Uuid::new_v4()).await.unwrap()["requested"], true);
            drop(request);
        } else {
            request.http_error(json!({"error":{"message":DETAIL,"type":"invalid_request_error","code":"invalid_request"},"private":SECRET})).await;
        }
        fixture.idle(&client, &session).await;
        let source = client.query("agent", "execution", json!({"sessionId":session,"invocationId":sent["invocationId"]})).await.unwrap()["execution"].clone();
        assert_eq!(source["state"], if stop { "cancelled" } else { "failed" }, "{source}");
        let failed_invocation=fixture.store.session(&session).await.unwrap().invocation_boundary(&session,sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0.invocation;
        if !stop {
            let history = client.query("agent", "history", json!({"sessionId":session,"position":{"kind":"tail"}})).await.unwrap();
            let failures: Vec<_> = history["chunks"].as_array().unwrap().iter().filter(|chunk| chunk["role"] == "failure").collect();
            assert!(!failures.is_empty(), "the existing conversation history must expose the rejected request");
            for failure in failures {
                assert!(failure["text"].as_str().unwrap().contains(DETAIL), "{failure}");
            }
            assert!(!history.to_string().contains(SECRET));
        }
        let diagnostics=client.query("agent", "diagnostics",json!({"sessionId":session,"position":{"kind":"latest"}})).await;

        // A later message must not replace the selected source's original input.
        mutation(&client, "send", json!({"sessionId":session,"message":"Later unrelated Computer request","model":fixture.selection.clone()}), Uuid::new_v4()).await.unwrap();
        let request = fixture.next_request().await;
        request.finish().await;
        fixture.idle(&client, &session).await;

        let input = resume_input(&fixture, &source).await;
        let operation = Uuid::new_v4();
        let resumed = mutation(&client, "resume", input.clone(), operation).await.unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        assert_ne!(resumed["execution"]["invocationId"], source["invocationId"]);
        let request = fixture.next_request().await;
        let replay = &request.body;
        assert_computer_state(replay, "ready");
        let last_user = replay["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "user").unwrap();
        assert_eq!(last_user["content"], "Hello");
        assert!(!replay.to_string().contains("Later unrelated Computer request"));
        request.tool("cua_repl", json!({"code":"nodeRepl.write(++globalThis.resumeCounter);"})).await;
        let request = fixture.next_request().await;
        assert_computer_output(&fixture, &session, "41").await;
        request.finish().await;
        fixture.idle(&client, &session).await;
        let completed = client.query("agent", "execution", json!({"sessionId":session,"invocationId":resumed["execution"]["invocationId"]})).await.unwrap();
        assert_eq!(completed["execution"]["state"], "completed");
        let recovered = client.recover(operation).await.unwrap();
        let Receipt::Recorded {
            outcome: OperationOutcome::Returned { value }, ..
        } = recovered.receipt else {
            panic!("original resume receipt is unavailable");
        };
        assert_eq!(value, resumed, "recovery must return the original resume result");
        assert_eq!(mutation(&client, "resume", input, Uuid::new_v4()).await.unwrap(), json!({"kind":"parked","reason":"already_continued"}));
        assert_eq!(client.query("agent", "execution", json!({"sessionId":session,"invocationId":source["invocationId"]})).await.unwrap()["execution"], source);
        let facts = facts(&fixture, &session).await;
        assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, input, .. } if name == "cua_repl" && input["code"] == "nodeRepl.write(++globalThis.resumeCounter);")).count(), 1);

        // Read the real VM again: duplicate resume must not have incremented it.
        send(&fixture, &client, &session, "Hello").await;
        let request = fixture.next_request().await;
        assert_computer_state(&request.body, "ready");
        request.tool("cua_repl", json!({"code":"nodeRepl.write(globalThis.resumeCounter);"})).await;
        let request = fixture.next_request().await;
        assert_computer_output(&fixture, &session, "41").await;
        request.finish().await;
        fixture.idle(&client, &session).await;
        assert!(fixture.store.session(&session).await.unwrap().pending_interactions(&session).await.unwrap().is_empty());
        client.close().await.unwrap();
        fixture.finish().await;
        if !stop {
            let diagnostics=diagnostics.expect("actual main HTTP failure must be readable through public diagnostics");
            let entries=diagnostics["entries"].as_array().unwrap();
            assert_eq!(entries.len(),2,"both original model-step and terminal execution evidence must be visible");
            for entry in entries {
                assert!(entry["sequence"].as_u64().is_some_and(|sequence|sequence>0));
                assert!(entry["eventId"].as_str().is_some_and(|id|!id.is_empty()));
                assert!(entry["recordedAt"].as_f64().is_some());
                assert_eq!(entry["detail"]["invocation"],serde_json::to_value(&failed_invocation).unwrap());
                assert_eq!(entry["detail"]["modelFailure"],json!({"kind":"http","status":400}));
            }
            let execution=entries.iter().find(|entry|entry["detail"]["kind"] == "execution").unwrap();
            assert_eq!(execution["detail"]["reason"],"model_http");
            let step=entries.iter().find(|entry|entry["detail"]["kind"] == "model_step").unwrap();
            assert_eq!(step["detail"]["status"],"failed");
            let interrupted=facts.iter().find(|fact|matches!(fact,Fact::ModelInterrupted {..})).unwrap();
            let ended=facts.iter().find(|fact|matches!(fact,Fact::InvocationEnded {outcome:maka_agent_facts::event::InvocationOutcome::Failed {..}})).unwrap();
            assert_eq!(serde_json::to_value(interrupted).unwrap()["model_failure"],json!({"kind":"http","status":400}));
            assert_eq!(serde_json::to_value(ended).unwrap()["outcome"]["model_failure"],json!({"kind":"http","status":400}));
            assert!(serde_json::to_value(interrupted).unwrap()["diagnostic"].as_str().unwrap().contains(DETAIL));
            assert!(serde_json::to_value(ended).unwrap()["outcome"]["message"].as_str().unwrap().contains(DETAIL));
            assert!(!serde_json::to_string(&facts).unwrap().contains(SECRET));
            assert!(!diagnostics.to_string().contains(SECRET),"safe diagnostics must not expose provider response bodies");
        }
    }).await.unwrap();
}

#[tokio::test]
async fn computer_resume_stopped_replays_original_input_without_duplicate_effects() {
    computer_resume_replays_original_input_without_duplicate_effects(true).await;
}

#[tokio::test]
async fn computer_resume_model_failure_replays_original_input_without_duplicate_effects() {
    computer_resume_replays_original_input_without_duplicate_effects(false).await;
}
