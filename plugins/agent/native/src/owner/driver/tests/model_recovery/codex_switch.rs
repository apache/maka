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

fn observation(
    binding: &maka_agent_facts::execution::ModelBinding,
    model: &mut maka_agent_ports::provider::Model,
) -> maka_agent_facts::context::ModelRequestContext {
    let mut context = replay_observation(binding, model);
    model.info.capabilities.as_mut().unwrap().native_compaction = Some(true);
    let downshift = binding.connection_slug == "switch-downshift";
    if downshift {
        context.model_context_window = Some(8_000);
        context.context_window = Some(8_000);
        context.declared_window = Some(6_000);
    }
    context
        .codex
        .as_mut()
        .unwrap()
        .compatibility
        .as_mut()
        .unwrap()
        .comp_hash = if downshift {
        "llama3.2".into()
    } else {
        binding.model.clone()
    };
    context
}

fn response(request: &Value) -> (u16, Vec<Value>) {
    let compact = request["input"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["type"] == "compaction_trigger")
    });
    eprintln!("wire: model={} compact={compact}", request["model"]);
    let body = request.to_string();
    let large = body.contains("old-input-second") || body.contains("converted-second");
    if !compact && body.contains("old-input-stopped") && request["model"] == "llama3.2" {
        return (
            200,
            vec![
                json!({"type":"response.output_item.done","item":replay_reasoning()}),
                json!({"type":"response.output_item.done","item":{"type":"message","id":"partial","role":"assistant","content":[{"type":"output_text","text":"committed-before-stop"}]}}),
            ],
        );
    }
    if compact && body.contains("old-input-fallback") && request["model"] == "llama3.2" {
        return (
            400,
            vec![
                json!({"error":{"type":"invalid_request_error","message":"previous model unavailable"}}),
            ],
        );
    }
    let item = if compact {
        json!({"type":"compaction","id":"switch-cp","encrypted_content":format!("{}-{}", if large {"converted-second"} else if body.contains("converted-state") {"reconverted-state"} else {"converted-state"}, request["model"].as_str().unwrap())})
    } else {
        json!({"type":"message","id":"answer","role":"assistant","content":[{"type":"output_text","text":"done"}]})
    };
    let output_tokens = if compact && large && request["model"] == "llama3.2" {
        120_000
    } else {
        10
    };
    (
        200,
        vec![
            json!({"type":"response.output_item.done","item":item}),
            json!({"type":"response.completed","response":{"id":"switch-response","model":request["model"],"output":[item],"usage":{"input_tokens":100,"output_tokens":output_tokens}}}),
        ],
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_compacts_with_previous_model_before_target_input() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let mut rig = Rig::new().unwrap();
    let stop = CancellationToken::new();
    let listener =
        tokio::net::TcpListener::from_std(rig.model_listener.try_clone().unwrap()).unwrap();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let http_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let http_address = http_listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/v1/responses",
        axum::routing::post({
            let sent = sent.clone();
            move |request: axum::extract::Request| {
                let sent = sent.clone();
                async move {
                    let body = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                        .await
                        .unwrap();
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    sent.send(request.clone()).unwrap();
                    let (status, events) = response(&request);
                    let body = if status == 200 {
                        events
                            .iter()
                            .map(|event| format!("data: {event}\n\n"))
                            .collect::<String>()
                    } else {
                        events[0].to_string()
                    };
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        [("content-type", "text/event-stream")],
                        body,
                    )
                }
            }
        }),
    );
    let http_stop = stop.clone();
    let http_server = tokio::spawn(async move {
        axum::serve(http_listener, app)
            .with_graceful_shutdown(http_stop.cancelled_owned())
            .await
    });
    let shutdown = stop.clone();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let stream = tokio::select! { _ = shutdown.cancelled() => break, result = listener.accept() => result?.0 };
            let sent = sent.clone();
            let shutdown = shutdown.clone();
            connections.spawn(async move {
                let mut stream = stream;
                let mut method = [0u8; 4];
                tokio::select! { _ = shutdown.cancelled() => return Ok(()), result = stream.peek(&mut method) => { result?; } }
                if method[0] == b'P' {
                    let mut upstream = tokio::net::TcpStream::connect(http_address).await?;
                    tokio::select! { _ = shutdown.cancelled() => {}, result = tokio::io::copy_bidirectional(&mut stream, &mut upstream) => { result?; } }
                    return Ok(());
                }
                let mut socket = tokio::select! {
                    _ = shutdown.cancelled() => return Ok(()),
                    socket = tokio_tungstenite::accept_async(stream) => socket?,
                };
                loop {
                    let frame = tokio::select! { _ = shutdown.cancelled() => break, frame = socket.next() => frame };
                    let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) = frame else { break };
                    let request: Value = serde_json::from_str(&text)?;
                    sent.send(request.clone())?;
                    let (_, events) = response(&request);
                    for event in events {
                        socket.send(tokio_tungstenite::tungstenite::Message::text(event.to_string())).await?;
                    }
                }
                Ok::<_, Box<dyn Error + Send + Sync>>(())
            });
        }
        while let Some(result) = connections.join_next().await {
            result??;
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    });
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(180), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, format!("http://{}/v1", rig.model_listener.local_addr()?), true).await?;
        rig.attach_host(root(&base, false).await?, boot.deployment, boot.gateway, true, Some(observation)).await?;
        let client = rig.client.as_ref().ok_or("client missing")?;
        let mut selections = Vec::new();
        for (slug, model) in [("switch-source", "llama3.2"), ("switch-target", "llama3.1"), ("switch-downshift", "llama3.1")] {
            let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
            let connection = call(client, "settings", "create", json!({"expectedCatalogRevision":catalog["revision"],"connection":{"slug":slug,"name":slug,"provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},"configuration":{"baseUrl":format!("http://{}/v1", rig.model_listener.local_addr()?)},"enabled":true,"enabledModelIds":[model],"modelOverrides":{(model):{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}})).await?;
            let models = call(client, "agent", "models", json!({"kind":"start"})).await?;
            selections.push(models["choices"].as_array().ok_or("models missing")?.iter().find(|choice| choice["selection"]["connectionId"] == connection["connection"]["connectionId"]).ok_or("selection missing")?["selection"].clone());
        }
        for scenario in ["direct", "second", "fallback", "fork", "checkpoint-fork", "stopped"] {
            eprintln!("scenario: {scenario}");
            let mut session = {
                let created = call(client, "agent", "create", json!({"title":"Codex switch","automaticTitle":false,"labels":[],"workspace":{"kind":"directory","path":rig.directory.path().join("workspace")}})).await?;
                created["session"]["id"].as_str().ok_or("session missing")?.to_owned()
            };
            let mut stopped_request = None;
            let mut stopped_execution = None;
            let mut old_input = format!("old-input-{scenario}");
            if scenario == "stopped" { old_input.push_str(&" padding".repeat(8_000)); }
            for (index, message) in [old_input, format!("new-input-{scenario}")].into_iter().enumerate() {
                if scenario == "stopped" && index == 1 {
                    let original: &Value = stopped_execution.as_ref().unwrap();
                    let resumed = call(client, "agent", "continueRun", json!({"sessionId":session,"sourceRunId":original["runId"],"sourceHighWater":original["highWater"],"model":{"connectionId":selections[2]["connectionId"],"modelId":selections[2]["modelId"]}})).await?;
                    assert_eq!(resumed["kind"], "started", "{resumed}");
                    loop {
                        let work = call(client, "agent", "work", json!({"sessionId":session,"target":{"kind":"run","runId":resumed["execution"]["runId"]}})).await?;
                        match work["execution"]["state"]["kind"].as_str() {
                            Some("completed") => break,
                            Some("failed" | "cancelled") => return Err(format!("resume failed: {work}").into()),
                            _ => tokio::time::sleep(Duration::from_millis(20)).await,
                        }
                    }
                    continue;
                }
                let sent = call(client, "agent", "send", json!({"sessionId":session,"message":message,"backend":selections[index],"delivery":"queue"})).await?;
                if scenario == "stopped" && index == 0 {
                    stopped_request = Some(received.recv().await.ok_or("stopped A request missing")?);
                    let target = json!({"kind":"message","messageId":sent["messageId"]});
                    let work = call(client, "agent", "work", json!({"sessionId":session,"target":target})).await?;
                    let run = serde_json::from_value(work["execution"]["runId"].clone())?;
                    let owner = rig.captured.lock().unwrap().clone().ok_or("Native owner missing")?;
                    loop {
                        let observed = facts(&owner.durable, run).await?;
                        if ["opaque-original", "committed-before-stop"].iter().all(|text|
                            observed.iter().any(|fact| fact["fact"]["kind"] == "model_observed" && fact.to_string().contains(text))) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    call(client, "agent", "stop", json!({"sessionId":session,"runId":work["execution"]["runId"]})).await?;
                    loop {
                        let work = call(client, "agent", "work", json!({"sessionId":session,"target":target})).await?;
                        if work["execution"]["state"]["kind"] == "cancelled" { stopped_execution = Some(work["execution"].clone()); break; }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                } else {
                    if let result = tokio::time::timeout(Duration::from_secs(20), completed_message(client, &session, &sent["messageId"])).await
                        && !matches!(&result, Ok(Ok(_))) {
                        let work = call(client, "agent", "work", json!({"sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}})).await?;
                        let run = serde_json::from_value(work["execution"]["runId"].clone())?;
                        let owner = rig.captured.lock().unwrap().clone().ok_or("Native owner missing")?;
                        eprintln!("failed facts: {:?}", facts(&owner.durable, run).await?);
                        return Err(format!("message did not complete: {result:?}").into());
                    }
                }
                if scenario == "checkpoint-fork" && index == 0 {
                    let compact = call(client, "agent", "compact", json!({"sessionId":session,"model":selections[0]})).await?;
                    let target = json!({"kind":"run","runId":compact["execution"]["runId"]});
                    loop {
                        let work = call(client, "agent", "work", json!({"sessionId":session,"target":target})).await?;
                        match work["execution"]["state"]["kind"].as_str() {
                            Some("completed") => break,
                            Some("failed" | "cancelled") => return Err(format!("manual compaction failed: {work}").into()),
                            _ => tokio::time::sleep(Duration::from_millis(20)).await,
                        }
                    }
                }
                if matches!(scenario, "fork" | "checkpoint-fork") && index == 0 {
                    let owner = rig.captured.lock().unwrap().clone().ok_or("Native owner missing")?;
                    let revision = owner.session(&session).await?.revision;
                    let fork = call(client, "agent", "fork", json!({"sessionId":session,"expectedRevision":revision,"position":{"kind":"end"},"title":"Switch inherited context","labels":[]})).await?;
                    session = fork["session"]["id"].as_str().ok_or_else(|| format!("fork failed: {fork}"))?.to_owned();
                }
            }
            let first = match stopped_request { Some(request) => request, None => received.recv().await.ok_or("A request missing")? };
            if scenario == "checkpoint-fork" {
                let manual = received.recv().await.ok_or("manual compaction missing")?;
                assert_eq!(manual["model"], "llama3.2");
                assert!(manual.to_string().contains("compaction_trigger"));
            }
            let compact = received.recv().await.ok_or("A compaction missing")?;
            assert_eq!(first["model"], "llama3.2");
            assert_eq!(compact["model"], "llama3.2");
            assert!(compact.to_string().contains("compaction_trigger"));
            assert!(compact.to_string().contains(if scenario == "checkpoint-fork" {"converted-state"} else {"old-input"}));
            assert!(!compact.to_string().contains("new-input"));
            if scenario == "stopped" {
                assert!(compact["input"].as_array().unwrap().iter().any(|item| item["encrypted_content"] == "opaque-original"), "{compact}");
                assert!(compact.to_string().contains("committed-before-stop"));
            }
            if matches!(scenario, "second" | "fallback") {
                let second = received.recv().await.ok_or("B compaction missing")?;
                assert_eq!(second["model"], "llama3.1");
                assert!(second.to_string().contains("compaction_trigger"));
                assert!(!second.to_string().contains("new-input"));
                if scenario == "second" { assert!(second.to_string().contains("converted-second")); }
                else { assert!(second.to_string().contains("old-input-fallback")); }
            }
            let next = received.recv().await.ok_or("B request missing")?;
            assert_eq!(next["model"], "llama3.1");
            assert!(!next.to_string().contains("compaction_trigger"));
            let marker = match scenario {
                "second" => "converted-second-llama3.1",
                "fallback" => "converted-state-llama3.1",
                "checkpoint-fork" => "reconverted-state-llama3.2",
                _ => "converted-state-llama3.2",
            };
            let checkpoints: Vec<_> = next["input"].as_array().unwrap().iter()
                .filter(|item| item["type"] == "compaction")
                .map(|item| item["encrypted_content"].as_str().unwrap()).collect();
            assert_eq!(checkpoints, [marker], "{next}");
            if scenario == "stopped" {
                assert_eq!(next["input"].as_array().unwrap().last().unwrap()["type"], "compaction");
                assert!(!next.to_string().contains("committed-before-stop"));
            } else {
                assert!(next.to_string().contains("new-input"));
            }
            assert!(received.try_recv().is_err());
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    stop.cancel();
    let wire = server.await;
    let http = http_server.await;
    let cleanup = rig.finish().await;
    assert!(matches!(&outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(matches!(wire, Ok(Ok(()))), "{wire:?}");
    assert!(matches!(http, Ok(Ok(()))), "{http:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}
