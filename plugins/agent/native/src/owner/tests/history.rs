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
use futures_util::{SinkExt, StreamExt};
use maka_agent_facts::{
    accounting::Outcome,
    context::{ModelClosureProtocol, ModelPurpose},
    durable::{BackendSpec, ModelAttemptId, StepId},
    history_snapshot::SnapshotId,
    model::{ModelPart, assembly::PreviewPart, recorded::PrivateModelPartial},
};
use maka_agent_ports::session::history as wire;
use maka_agent_state::session_history::snapshot::{CaptureRequest, Snapshot};
use std::time::Duration;

async fn facts(f: &Fixture, run: RunId) -> Vec<RecordedFact> {
    let mut result = Vec::new();
    let mut after = 0;
    loop {
        let page = f.owner.durable.history(run, after, 256).await.unwrap();
        let full = page.len() == 256;
        if let Some(last) = page.last() {
            after = last.revision;
        }
        result.extend(page);
        if !full {
            return result;
        }
    }
}
async fn wait_fact(f: &Fixture, run: RunId, predicate: impl Fn(&Fact) -> bool) {
    let mut changed = f.owner.durable.subscribe().unwrap();
    loop {
        changed.borrow_and_update();
        if facts(f, run)
            .await
            .iter()
            .any(|record| predicate(&record.fact))
        {
            return;
        }
        changed.changed().await.unwrap();
    }
}
async fn done(f: &Fixture, session: &str, run: RunId, terminal: Terminal) {
    wait_fact(f, run, |fact| matches!(fact, Fact::RunTerminated { .. })).await;
    f.drained().await;
    assert_eq!(
        f.owner.durable.frontier(run).await.unwrap().terminal,
        Some(terminal)
    );
    let readiness: maka_agent_api::contract::WorkReadiness = serde_json::from_value(
        f.query(
            "workReadiness",
            json!({"sessionId":session,"target":{"kind":"run","runId":run}}),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        readiness,
        maka_agent_api::contract::WorkReadiness::Ready
    ));
}
async fn pages(f: &Fixture, session: &str, through: Option<u64>) -> (u64, Vec<Value>) {
    let mut through = through;
    let mut position = json!({"kind":"start"});
    let mut result = Vec::new();
    loop {
        let page = f
            .query(
                "history",
                json!({"sessionId":session,"through":through,"position":position}),
            )
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready");
        let current = page["through"].as_u64().unwrap();
        if let Some(expected) = through {
            assert_eq!(current, expected);
        }
        through = Some(current);
        assert!(serde_json::to_vec(&page).unwrap().len() <= 60 * 1024);
        let after = page["after"].clone();
        result.push(page);
        if after.is_null() {
            return (current, result);
        }
        let next = json!({"kind":"after","cursor":after});
        assert_ne!(
            position, next,
            "a fixed-cut history continuation must progress"
        );
        position = next;
    }
}
fn chunks(pages: &[Value]) -> impl Iterator<Item = &Value> {
    pages
        .iter()
        .flat_map(|page| page["chunks"].as_array().unwrap().iter())
}
fn model_rows(pages: &[Value]) -> Vec<Value> {
    chunks(pages)
        .filter(|row| row.get("modelPart").is_some())
        .cloned()
        .collect()
}
async fn snapshot_at(f: &Fixture, session: &str, through: u64) -> Snapshot {
    let history = f.history(session);
    let cut = history.capture_at(through).await.unwrap();
    history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(Uuid::new_v4()).unwrap(),
                cut,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap()
}
async fn snapshot_pages(snapshot: &Snapshot) -> Vec<Value> {
    let mut result = Vec::new();
    let mut position = wire::Position::Start;
    loop {
        let page = crate::service::history::snapshot_page(
            snapshot,
            position,
            false,
            wire::HistoryView::Text,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let wire::Page::Ready { after, .. } = &page;
        let next = after.clone();
        result.push(serde_json::to_value(page).unwrap());
        match next {
            Some(cursor) => position = wire::Position::After { cursor },
            None => return result,
        }
    }
}
async fn original_attempt(f: &Fixture, run: RunId) -> (StepId, ModelAttemptId) {
    let view = f.owner.durable.frontier(run).await.unwrap();
    assert_eq!(view.attempts.len(), 1);
    let (&attempt, original) = view.attempts.iter().next().unwrap();
    let request = f.owner.durable.request(run, original.step).await.unwrap();
    assert_eq!(request.step, original.step);
    assert_eq!(request.accounting.purpose, ModelPurpose::Main);
    let BackendSpec::Model { binding, .. } = &view.spec.backend else {
        panic!("actual Native model Run")
    };
    assert_eq!(binding.model, "fixture-model");
    assert_eq!(&request.accounting.binding, binding);
    (original.step, attempt)
}
async fn profile(f: &Fixture, web: bool) {
    selection::edit(f, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            serde_json::from_value(
                json!({"codeMode":false,"capabilities":{"chat":true,"webSearch":web}}),
            )
            .unwrap(),
        )]))
    })
    .await;
}
type WebSocket = tokio_tungstenite::WebSocketStream<TcpStream>;
async fn event(socket: &mut WebSocket, value: Value) {
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            value.to_string().into(),
        ))
        .await
        .unwrap();
}
async fn preview_contains(f: &Fixture, session: &str, expected: &str) {
    let mut reader = loop {
        if let Some(reader) = f.owner.preview_reader(session).await {
            break reader;
        }
        tokio::task::yield_now().await;
    };
    loop {
        let cut = reader.borrow_and_update().clone();
        if cut.as_ref().is_some_and(|cut| cut.parts.iter().any(|part| matches!(part, PreviewPart::Text {text,..} if text.chunks().collect::<String>() == expected))) { return; }
        reader
            .changed()
            .await
            .expect("original preview remains observable");
    }
}
async fn open_message(socket: &mut WebSocket, id: &str, index: u64, text: &str) {
    event(socket, json!({"type":"response.output_item.added","output_index":index,"item":{"type":"message","id":id,"role":"assistant","content":[]}})).await;
    event(socket, json!({"type":"response.output_text.delta","item_id":id,"output_index":index,"content_index":0,"delta":text})).await;
}
async fn close_message(
    socket: &mut WebSocket,
    id: &str,
    index: u64,
    text: &str,
    annotations: Value,
) {
    event(socket, json!({"type":"response.output_item.done","output_index":index,"item":{"type":"message","id":id,"role":"assistant","content":[{"type":"output_text","text":text,"annotations":annotations}]}})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_history_preserves_each_attempt_reported_model_and_fixed_cut_after_cold_reopen() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f = Fixture::new(&base, None).await;
        profile(&f, false).await;
        let session = f.create("Native response metadata and stable history").await;
        let texts = [format!("{}FIRST_COMPLETE_SUFFIX🙂\0", "正文🙂\0\n".repeat(6000)), "second response without reported model\0🙂".into()];
        let mut identities = Vec::new();
        let mut old = None;
        for (index, reported) in [Some("provider-reported-revision-not-requested-alias"), None].into_iter().enumerate() {
            let queued = f.send(&session).await.unwrap();
            let run = f.delivered_run(&queued).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let outgoing = request(&mut socket).await;
            assert_eq!(outgoing["model"], "fixture-model");
            let id = format!("response-{index}");
            let mut chunk = json!({"id":id,"object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":texts[index]},"finish_reason":null}]});
            if let Some(model) = reported { chunk["model"] = json!(model); }
            let finish = json!({"id":id,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}});
            let body = format!("data: {chunk}\n\ndata: {finish}\n\ndata: [DONE]\n\n");
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            drop(socket);
            done(&f, &session, run, Terminal::Completed).await;
            let (step, attempt) = original_attempt(&f, run).await;
            identities.push((step, attempt));
            let view = f.owner.durable.frontier(run).await.unwrap();
            let closed = view.attempts[&attempt].closed.as_ref().unwrap();
            let closure: ModelClosureProtocol = serde_json::from_value(closed.protocol.clone()).unwrap();
            assert_eq!(closure.model.as_deref(), reported);
            assert_eq!(closure.response_id.as_deref(), Some(id.as_str()));
            assert!(closure.timestamp.is_some());
            assert_eq!(closed.usage.input_tokens, Some(11));
            assert_eq!(closed.usage.output_tokens, Some(7));
            let (through, current) = pages(&f, &session, None).await;
            let rows: Vec<_> = model_rows(&current).into_iter().filter(|row| row["runId"] == json!(run)).collect();
            assert!(!rows.is_empty());
            assert_eq!(rows.iter().map(|row| row["text"].as_str().unwrap()).collect::<String>(), texts[index]);
            assert!(rows.iter().all(|row| row["model"] == json!({"kind":"native","requestedModelId":"fixture-model","reportedModelId":reported})
                && row["modelPart"]["stepId"] == json!(step) && row["modelPart"]["attemptId"] == json!(attempt)));
            if index == 0 {
                assert!(rows.len() > 1, "the full Unicode/NUL response must traverse continuation pages");
                old = Some((through, current));
            } else {
                let (through, expected) = old.as_ref().unwrap();
                assert_eq!(&pages(&f, &session, Some(*through)).await.1, expected, "an old cut cannot read a later completion or latest model");
            }
        }
        assert_ne!(identities[0].0, identities[1].0);
        assert_ne!(identities[0].1, identities[1].1);
        let (latest, before) = pages(&f, &session, None).await;
        let bytes = serde_json::to_vec(&before).unwrap();
        let f = model_interruption::cold_reopen(f).await;
        assert_eq!(serde_json::to_vec(&pages(&f, &session, Some(latest)).await.1).unwrap(), bytes);
        let (through, expected) = old.unwrap();
        assert_eq!(pages(&f, &session, Some(through)).await.1, expected);
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_provider_parts_are_public_before_response_completion_but_not_private_preview() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f = Fixture::configured_provider(&base, None, None, Some(service_tools::Setup::web()), |_| {}, "openai-responses-compatible").await;
        profile(&f, true).await;
        let client = f.app.client();
        let binding = client.bind(client.activation(&id(1)).unwrap(), "service".into()).await.unwrap().remove(0);
        let prepared = client.prepare_mutation(binding, "save".into(), json!({"revision":null,"settings":{"enabled":true,"source":"model"}}), scope(&f.issuer, true), Uuid::new_v4(), Attachments::new().into()).await.unwrap();
        let reference = prepared.reference().clone();
        let receipt = client.mutate_owned(prepared, json!({"reference":reference})).await.unwrap().result().await;
        assert!(matches!(receipt.receipt, Receipt::Recorded {outcome:OperationOutcome::Returned {result:OperationResult::Success {..}},..}));
        let session = f.create("Accepted provider parts before Closed").await;
        let queued = f.send(&session).await.unwrap(); let run = f.delivered_run(&queued).await;
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let outgoing: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(outgoing["model"], "fixture-model");
        assert!(outgoing["tools"].as_array().unwrap().iter().any(|tool| tool["type"] == "web_search"));
        event(&mut socket, json!({"type":"response.created","response":{"id":"response-search","created_at":1,"model":"actual-reported-search-model"}})).await;
        event(&mut socket, json!({"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"search-1","status":"in_progress"}})).await;
        event(&mut socket, json!({"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"search-1","status":"completed","action":{"type":"search","query":"Maka"}}})).await;
        let accepted = "accepted answer🙂\0";
        open_message(&mut socket, "accepted", 1, accepted).await;
        close_message(&mut socket, "accepted", 1, accepted, json!([{"type":"url_citation","url":"https://example.com/maka","title":"Actual citation","start_index":0,"end_index":8}])).await;
        wait_fact(&f, run, |fact| matches!(fact, Fact::ModelObserved {index:3,..})).await;
        let private = "PRIVATE_UNACCEPTED_PREVIEW🙂\0";
        open_message(&mut socket, "pending", 2, private).await;
        preview_contains(&f, &session, private).await;
        let original: Vec<_> = facts(&f, run).await.into_iter().filter(|record| matches!(&record.fact, Fact::ModelObserved {..})).collect();
        assert_eq!(original.len(), 4);
        assert!(original.iter().any(|record| matches!(&record.fact, Fact::ModelObserved {part:ModelPart::Text {..},..})));
        assert!(original.iter().any(|record| matches!(&record.fact, Fact::ModelObserved {part:ModelPart::Source {source:maka_agent_facts::model::ModelSource::Url {..}},..})));
        assert!(original.iter().any(|record| matches!(&record.fact, Fact::ModelObserved {part:ModelPart::ToolCall {call},..} if call.provider_executed)));
        assert!(original.iter().any(|record| matches!(&record.fact, Fact::ModelObserved {part:ModelPart::ToolResult {id,..},..} if id == "search-1")));
        let (step, attempt) = original_attempt(&f, run).await;
        let view = f.owner.durable.frontier(run).await.unwrap();
        assert!(view.terminal.is_none() && view.attempts[&attempt].closed.is_none());
        assert!(!view.tools.values().any(|tool| tool.admitted), "provider-native search does not dispatch a Host tool");
        let (through, before) = pages(&f, &session, None).await;
        let rows = model_rows(&before); assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|row| row["modelPart"]["stepId"] == json!(step) && row["modelPart"]["attemptId"] == json!(attempt) && row["model"]["reportedModelId"].is_null()));
        assert!(rows.iter().any(|row| row["role"] == "tool_call"));
        assert!(rows.iter().any(|row| row["role"] == "tool_result"));
        assert!(rows.iter().any(|row| row["text"] == accepted));
        assert!(rows.iter().any(|row| row["text"].as_str().unwrap().contains("https://example.com/maka")));
        assert!(!serde_json::to_string(&before).unwrap().contains("PRIVATE_UNACCEPTED_PREVIEW"));
        let snapshot = snapshot_at(&f, &session, through).await;
        let frozen = snapshot_pages(&snapshot).await;
        assert_eq!(model_rows(&frozen).len(), 4);
        assert!(!serde_json::to_string(&frozen).unwrap().contains("PRIVATE_UNACCEPTED_PREVIEW"));
        // The pending text becomes public only after its own real acceptance.
        close_message(&mut socket, "pending", 2, private, json!([])).await;
        event(&mut socket, json!({"type":"response.completed","response":{"id":"response-search","output":[],"usage":{"input_tokens":2,"output_tokens":5}}})).await;
        drop(socket);
        done(&f, &session, run, Terminal::Completed).await;
        let now = facts(&f, run).await;
        for original in &original { assert_eq!(now.iter().filter(|record| record.id == original.id).count(), 1); assert_eq!(now.iter().find(|record| record.id == original.id).unwrap(), original); }
        assert_eq!(now.iter().filter(|record| matches!(&record.fact, Fact::ModelObserved {..})).count(), 5);
        assert_eq!(pages(&f, &session, Some(through)).await.1, before);
        assert_eq!(snapshot_pages(&snapshot).await, frozen);
        let current = pages(&f, &session, None).await.1;
        assert!(model_rows(&current).iter().all(|row| row["model"]["reportedModelId"] == "actual-reported-search-model"));
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_and_provider_failure_keep_unaccepted_text_private_in_history_and_snapshot() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for stop in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let f = Fixture::configured_provider(&base, None, None, None, |_| {}, "openai-responses-compatible").await;
            profile(&f, false).await;
            let session = f.create("Private text is not accepted by cancellation or failure").await;
            let queued = f.send(&session).await.unwrap(); let run = f.delivered_run(&queued).await;
            let (socket, _) = listener.accept().await.unwrap(); let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let _request: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            event(&mut socket, json!({"type":"response.created","response":{"id":"failed-response","created_at":1,"model":"true-private-reported-model"}})).await;
            open_message(&mut socket, "accepted", 0, "accepted before failure").await;
            close_message(&mut socket, "accepted", 0, "accepted before failure", json!([])).await;
            wait_fact(&f, run, |fact| matches!(fact, Fact::ModelObserved {index:0,..})).await;
            let private = "NEVER_ACCEPTED_PRIVATE_TEXT🙂\0";
            open_message(&mut socket, "unaccepted", 1, private).await;
            preview_contains(&f, &session, private).await;
            let (through, before) = pages(&f, &session, None).await;
            let snapshot = snapshot_at(&f, &session, through).await;
            let frozen = snapshot_pages(&snapshot).await;
            assert_eq!(model_rows(&before).len(), 1);
            assert!(!serde_json::to_string(&before).unwrap().contains("NEVER_ACCEPTED_PRIVATE_TEXT"));
            assert!(!serde_json::to_string(&frozen).unwrap().contains("NEVER_ACCEPTED_PRIVATE_TEXT"));
            if stop {
                assert_eq!(f.mutation(2, "stop", json!({"sessionId":session,"runId":run}), Uuid::new_v4()).await.unwrap()["requested"], true);
            } else {
                event(&mut socket, json!({"type":"response.failed","response":{"id":"failed-response","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"maximum context length exceeded after partial output"}}})).await;
            }
            drop(socket);
            done(&f, &session, run, if stop { Terminal::Cancelled } else { Terminal::Failed }).await;
            let records = facts(&f, run).await;
            assert_eq!(records.iter().filter(|record| matches!(&record.fact, Fact::ModelObserved {..})).count(), 1);
            assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ModelClosed {outcome:Outcome::Success,..})));
            let closures:Vec<_>=records.iter().filter_map(|record|match &record.fact{Fact::ModelClosed{outcome,protocol,..}=>Some((outcome,protocol)),_=>None}).collect();
            if stop{assert!(closures.is_empty(),"cancellation cannot manufacture an upstream Closed");}else{
                assert_eq!(closures.len(),1);assert_eq!(*closures[0].0,Outcome::Error);
                let failure:maka_agent_facts::context::ModelFailureProtocol=serde_json::from_value(closures[0].1.clone()).unwrap();
                assert!(matches!(failure.failure,maka_model::ModelError::ContextOverflow{observed_output:true}));
            }
            let (step, attempt) = original_attempt(&f, run).await;
            let partial = records.iter().find_map(|record| match &record.fact { Fact::ModelPrivatePartialCaptured {partial,..} => Some(partial), _ => None }).expect("original private cut remains owned and pinned in Root");
            let retained: PrivateModelPartial = serde_json::from_slice(&f.owner.durable.content(run, partial.clone()).await.unwrap()).unwrap();
            assert_eq!(retained.binding.step_id, step); assert_eq!(retained.binding.attempt_id, attempt);
            assert_eq!(retained.partial.model.as_deref(), Some("true-private-reported-model"));
            assert!(retained.partial.parts.iter().any(|part| matches!(part, maka_agent_facts::model::recorded::CompletionPart::Own(record) if matches!(record.part.as_ref(), ModelPart::Text {text,..} if text.chunks().collect::<String>() == private))));
            let (latest, current) = pages(&f, &session, None).await;
            assert!(!serde_json::to_string(&current).unwrap().contains("NEVER_ACCEPTED_PRIVATE_TEXT"));
            assert!(model_rows(&current).iter().all(|row| row["model"]["reportedModelId"].is_null()));
            let final_snapshot = snapshot_at(&f, &session, latest).await;
            assert!(!serde_json::to_string(&snapshot_pages(&final_snapshot).await).unwrap().contains("NEVER_ACCEPTED_PRIVATE_TEXT"));
            assert_eq!(pages(&f, &session, Some(through)).await.1, before);
            assert_eq!(snapshot_pages(&snapshot).await, frozen);
            f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
