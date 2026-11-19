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

async fn lost_reply(
    rig: &Rig,
    method: &str,
    input: Value,
) -> TestResult<(maka_plugin_core::operation::RecoveryRef, Value)> {
    let mut pending = rig
        .client
        .as_ref()
        .unwrap()
        .call("agent", method.into(), input, Attachments::new())
        .await?;
    pending.start().await?;
    assert!(matches!(pending.receive().await?, Reply::Prepared { .. }));
    // Discard the committed reply; recovery must use the original journal.
    let _ = pending.confirm(json!({"test":"preset-lost-reply"})).await?;
    let reference = pending
        .reference()
        .ok_or("missing recovery reference")?
        .clone();
    pending.close().await?;
    let observation = rig
        .store
        .as_ref()
        .unwrap()
        .operation(&reference)?
        .operation_observation()
        .await?
        .ok_or("missing operation")?;
    let OperationOutcome::Returned {
        result: OperationResult::Success { value },
    } = observation.outcome
    else {
        return Err(format!("unexpected observation: {observation:?}").into());
    };
    Ok((reference, value))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_management_survives_conflicts_lost_replies_and_restart() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(120),
        exercise(&mut rig),
    ))
    .catch_unwind()
    .await;

    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

async fn exercise(rig: &mut Rig) -> TestResult<()> {
    let base = rig.directory.path().to_path_buf();
    let boot = bootstrap(&base, "http://127.0.0.1:1/v1".into(), false).await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    assert_eq!(
        call(client, "agent", "presets", json!({})).await?,
        json!([])
    );
    let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
    let connection=call(client,"settings","create",json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"presets","name":"Presets",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
            "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions","thinkingLevels":["high"]}}}
        })).await?;
    assert_eq!(connection["kind"], "committed");
    let model =
        json!({"connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
    let instruction = "  # Role\n\n- Preserve **Markdown**\n中文\n";
    let create = json!({"name":"  Reviewer  ","description":"Review changes","instruction":instruction,"model":model,"thinkingLevel":"high"});
    assert_eq!(
        call(
            client,
            "agent",
            "createPreset",
            json!({"name":" ","description":"review","model":model})
        )
        .await?["kind"],
        "invalidInput"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "createPreset",
            json!({"name":"bad","description":" ","model":model})
        )
        .await?["kind"],
        "invalidInput"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "createPreset",
            json!({"name":"bad","description":"review","model":model,"thinkingLevel":"ultra"})
        )
        .await?["kind"],
        "thinkingLevelUnavailable"
    );
    let (created_ref, created) = lost_reply(rig, "createPreset", create.clone()).await?;
    assert_eq!(created["kind"], "saved");
    let id = created["preset"]["id"].clone();
    assert_eq!(created["preset"]["name"], "Reviewer");
    assert_eq!(created["preset"]["instruction"], instruction);
    let list = call(client, "agent", "presets", json!({})).await?;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert!(list[0].get("instruction").is_none());
    assert_eq!(list[0]["availability"]["kind"], "available");
    let mut concurrent = create.clone();
    concurrent["name"] = json!("Writer");
    concurrent["instruction"] = json!("");
    let (a, b) = tokio::join!(
        call(client, "agent", "createPreset", concurrent.clone()),
        call(client, "agent", "createPreset", concurrent)
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("nameConflict")) | (Some("nameConflict"), Some("saved"))
    ));
    let other = if a["kind"] == "saved" { a } else { b };
    let other_id = other["preset"]["id"].clone();
    let (a, b) = tokio::join!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":id,"expectedRevision":1,"name":"Shared"})
        ),
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":other_id,"expectedRevision":1,"name":"Shared"})
        )
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("nameConflict")) | (Some("nameConflict"), Some("saved"))
    ));
    let detail = call(client, "agent", "preset", json!({"id":id})).await?;
    let revision = detail["preset"]["revision"].as_u64().unwrap();
    let (updated_ref, updated) = lost_reply(
        rig,
        "updatePreset",
        json!({"id":id,"expectedRevision":revision,"enabled":false}),
    )
    .await?;
    assert_eq!(updated["preset"]["instruction"], instruction);
    assert_eq!(updated["preset"]["model"], model);
    assert_eq!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":id,"expectedRevision":revision,"instruction":"lost"})
        )
        .await?["kind"],
        "conflict"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "deletePreset",
            json!({"id":id,"expectedRevision":revision})
        )
        .await?["kind"],
        "conflict"
    );
    assert_eq!(
        call(client, "agent", "preset", json!({"id":id})).await?["availability"]["kind"],
        "disabled"
    );
    assert_eq!(updated["preset"]["thinkingLevel"], "high");
    let other_detail = call(client, "agent", "preset", json!({"id":other_id})).await?;
    let other_revision = other_detail["preset"]["revision"].as_u64().unwrap();
    let (a, b) = tokio::join!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":other_id,"expectedRevision":other_revision,"thinkingLevel":{"kind":"default"}})
        ),
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":other_id,"expectedRevision":other_revision,"description":"Concurrent edit"})
        )
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("conflict")) | (Some("conflict"), Some("saved"))
    ));
    let reset=call(client,"agent","updatePreset",json!({"id":other_id,"expectedRevision":other_revision+1,"thinkingLevel":{"kind":"default"}})).await?;
    assert_eq!(reset["kind"], "saved");
    assert_eq!(reset["preset"]["thinkingLevel"], Value::Null);
    let saved_instruction = call(
        client,
        "agent",
        "updatePreset",
        json!({
            "id": other_id, "expectedRevision": other_revision + 2, "instruction": instruction
        }),
    )
    .await?;
    assert_eq!(saved_instruction["kind"], "saved");
    // Removing the connection must not prevent ordinary configuration repairs.
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    owner.configuration.remove_connection(serde_json::from_value(json!({"expected":{"connectionId":connection["connection"]["connectionId"],"revision":connection["connection"]["revision"]}}))?).await.map_err(|e|e.to_string())?;
    let changed=call(client,"agent","updatePreset",json!({"id":id,"expectedRevision":revision+1,"instruction":"","thinkingLevel":null,"enabled":true})).await?;
    assert_eq!(changed["kind"], "saved");
    assert_eq!(changed["preset"]["instruction"], "");
    assert_eq!(
        call(client, "agent", "preset", json!({"id":id})).await?["availability"]["kind"],
        "modelUnavailable"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":id,"expectedRevision":revision+2,"model":model})
        )
        .await?["kind"],
        "modelUnavailable"
    );
    drop(owner);
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let detail = call(client, "agent", "preset", json!({"id":id})).await?;
    assert_eq!(detail["preset"], changed["preset"]);
    assert_eq!(
        call(client, "agent", "preset", json!({"id": other_id})).await?["preset"]["instruction"],
        instruction
    );
    for (reference, expected) in [(created_ref, created), (updated_ref, updated)] {
        let observed = rig
            .store
            .as_ref()
            .unwrap()
            .operation(&reference)?
            .operation_observation()
            .await?
            .unwrap();
        assert_eq!(
            observed.outcome,
            OperationOutcome::Returned {
                result: OperationResult::Success { value: expected }
            }
        );
    }
    assert_eq!(
        call(client, "agent", "presets", json!({}))
            .await?
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(
            client,
            "agent",
            "deletePreset",
            json!({"id":id,"expectedRevision":revision+2})
        )
        .await?["kind"],
        "deleted"
    );
    assert_eq!(
        call(client, "agent", "preset", json!({"id":id})).await?,
        Value::Null
    );
    assert_eq!(
        call(
            client,
            "agent",
            "deletePreset",
            json!({"id":id,"expectedRevision":revision+2})
        )
        .await?["kind"],
        "notFound"
    );
    Ok::<_, Box<dyn Error + Send + Sync>>(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_execution_uses_durable_role_and_explicit_model_selection() {
    let mut rig = Rig::new().unwrap();
    let stop = CancellationToken::new();
    let (requests, mut upstream) = tokio::sync::mpsc::unbounded_channel();
    let fail_model = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut wire = None;
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = rig.directory.path().to_path_buf();
        // No optional assistant configuration: the role must still reach the model.
        let boot = bootstrap(&base, format!("http://{}/v1", listener.local_addr()?), true).await?;
        wire = Some(tokio::spawn(execution_provider(listener, requests, fail_model.clone(), stop.clone())));
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"execution","name":"Execution",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2","alternate"],
                "modelOverrides":{"llama3.2":{"apiProtocol":"openai-chat-completions","codeMode":false},
                    "alternate":{"apiProtocol":"openai-chat-completions","codeMode":false}}}
        })).await?;
        let connection_id = connection["connection"]["connectionId"].clone();
        let model = json!({"connectionId":connection_id,"modelId":"llama3.2"});
        let role = "# Reviewer\n\nOnly analyze; preserve **this role**. 中文\n";
        let preset = call(client,"agent","createPreset",json!({"name":"Reviewer","description":"Review","instruction":"obsolete","model":model})).await?;
        let id = preset["preset"]["id"].clone();
        call(client,"agent","presets",json!({})).await?;
        assert_eq!(call(client,"agent","updatePreset",json!({"id":id,"expectedRevision":1,"instruction":role})).await?["kind"],"saved");
        let input = json!({"presetId":id,"title":"Preset execution","labels":[],"workspace":{"kind":"directory","path":base.join("workspace")}});
        let mut conflict = input.clone();
        conflict["backend"] = json!({"kind":"model","connectionId":connection_id,"modelId":"alternate"});
        assert_eq!(call(client,"agent","create",conflict).await?["reason"],"preset_backend_conflict");
        let (reference, created) = lost_reply(&rig,"create",input.clone()).await?;
        assert_eq!(created["kind"],"created", "{created}");
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let applied = created["session"]["appliedPreset"].clone();
        assert_eq!(applied["instruction"],role);
        assert_eq!(applied["revision"],2);
        assert_eq!(created["session"]["backend"]["modelId"],"llama3.2");
        assert!(created["session"].get("tools").is_none());
        assert_eq!(call(client,"agent","updatePreset",json!({"id":id,"expectedRevision":2,"enabled":false,"instruction":"replacement"})).await?["kind"],"saved");
        assert_eq!(call(client,"agent","create",input.clone()).await?["reason"],"preset_disabled");
        assert_eq!(call(client,"agent","deletePreset",json!({"id":id,"expectedRevision":3})).await?["kind"],"deleted");
        assert_eq!(call(client,"agent","create",input).await?["reason"],"preset_not_found");
        for round in 0..4 {
            if round == 2 {
                assert!(rig.finish().await.is_empty());
                rig.client = None; rig.host = None; rig.store = None;
                rig.captured.lock().unwrap().take();
                rig.stop_serving = CancellationToken::new();
                attach(&mut rig,&boot).await?;
                let observation = rig.store.as_ref().unwrap().operation(&reference)?.operation_observation().await?.unwrap();
                assert_eq!(observation.outcome,OperationOutcome::Returned { result: OperationResult::Success { value: created.clone() }});
            }
            let client = rig.client.as_ref().unwrap();
            if round == 1 {
                let compacted = call(client,"agent","compact",json!({"sessionId":session,"model":model})).await?;
                assert_eq!(compacted["kind"],"started","{compacted}");
                loop {
                    let observed = call(client,"agent","observe",json!({"sessionId":session})).await?;
                    if observed["compacting"].is_null() { break; }
                    tokio::task::yield_now().await;
                }
                let summary: Value = serde_json::from_slice(&upstream.recv().await.ok_or("missing compaction request")?)?;
                assert!(summary["messages"].to_string().contains("Reviewer"));
            }
            let input = json!({"sessionId":session,"message":format!("Review task {round}"),"attachments":[],"delivery":"queue"});
            if round == 2 {
                let selected = call(client,"agent","selectBackend",json!({"sessionId":session,"backend":{"kind":"model","connectionId":connection_id,"modelId":"alternate"}})).await?;
                assert_eq!(selected["kind"],"committed","{selected}");
            }
            let sent = call(client,"agent","send",input).await?;
            assert_eq!(sent["kind"],"queued", "{sent}");
            loop {
                let work=call(client,"agent","work",json!({"sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}})).await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some("completed") => break,
                    Some("failed" | "cancelled") => panic!("{work}"),
                    _ => tokio::task::yield_now().await,
                }
            };
            let request: Value = serde_json::from_slice(&upstream.recv().await.ok_or("missing model request")?)?;
            assert_eq!(request["model"], if round < 2 { "llama3.2" } else { "alternate" });
            let messages = request["messages"].as_array().unwrap();
            let text = messages.iter().map(|m|m["content"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n");
            assert_eq!(text.matches(role).count(),1,"{request}");
            assert!(text.contains(&format!("Review task {round}")));
            assert!(!text.contains("replacement"));
            assert!(request["tools"].as_array().is_some_and(|t|!t.is_empty()));
            let stored = rig.store.as_ref().unwrap().get_session::<maka_agent_api::session::StoredSessionConfiguration>(&session).await?.unwrap();
            assert_eq!(serde_json::to_value(stored.configuration.applied_preset)?, applied);
            if round == 3 {
                fail_model.store(true, Ordering::SeqCst);
                let failed = call(client,"agent","send",json!({"sessionId":session,"message":"Interrupted task","attachments":[],"delivery":"queue"})).await?;
                let execution = loop {
                    let work=call(client,"agent","work",json!({"sessionId":session,"target":{"kind":"message","messageId":failed["messageId"]}})).await?;
                    if work["execution"]["state"]["kind"] == "failed" { break work["execution"].clone(); }
                    tokio::task::yield_now().await;
                };
                fail_model.store(false, Ordering::SeqCst);
                while upstream.try_recv().is_ok() {}
                let continued = call(client,"agent","continueRun",json!({"sessionId":session,
                    "sourceRunId":execution["runId"],"sourceHighWater":execution["highWater"],
                    "model":{"connectionId":connection_id,"modelId":"alternate"}})).await?;
                assert_eq!(continued["kind"],"started","{continued}");
                loop {
                    let current=call(client,"agent","execution",json!({"sessionId":session,"runId":continued["execution"]["runId"]})).await?;
                    match current["execution"]["state"]["kind"].as_str() {
                        Some("completed") => break,
                        Some("failed" | "cancelled") => panic!("{current}"),
                        _ => tokio::task::yield_now().await,
                    }
                }
                let request: Value = serde_json::from_slice(&upstream.recv().await.ok_or("missing continuation request")?)?;
                let text = request["messages"].as_array().unwrap().iter().map(|m|m["content"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n");
                assert_eq!(text.matches(role).count(),1,"{request}");
            }

        }
        Ok::<_,Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    stop.cancel();
    if let Some(wire) = wire {
        wire.await.unwrap().unwrap();
    }
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

async fn execution_provider(
    listener: tokio::net::TcpListener,
    requests: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    fail: Arc<std::sync::atomic::AtomicBool>,
    stop: CancellationToken,
) -> TestResult<()> {
    let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move |body: axum::body::Bytes| {
        let requests = requests.clone();
        let fail = fail.clone();
        async move {
            requests.send(body.to_vec()).unwrap();
            if fail.load(Ordering::SeqCst) {
                return (axum::http::StatusCode::BAD_REQUEST, [("content-type","application/json")],
                    json!({"error":{"message":"Injected model failure","type":"invalid_request_error"}}).to_string());
            }
            let body = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"id":"preset","object":"chat.completion.chunk","model":"llama3.2","choices":[{"index":0,"delta":{"role":"assistant","content":"Review complete."},"finish_reason":null}]}),
                json!({"id":"preset","object":"chat.completion.chunk","model":"llama3.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}));
            (axum::http::StatusCode::OK, [("content-type","text/event-stream")], body)
        }
    }));
    axum::serve(listener, app)
        .with_graceful_shutdown(stop.cancelled_owned())
        .await?;
    Ok(())
}
