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
use maka_plugin_core::contract::ServiceTarget;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_controls_remain_visible_with_tool_discovery() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let mut provider = MockAiBuilder::new().interactive(1).start().await?;
    let boot = bootstrap_with(&base, provider.base_url(), |config| {
        config["bot"] = json!(true);
        config["scheduledTasks"] = json!(true);
        config["toolDiscovery"] = json!(true);
    })
    .await?;
    let mut observed = provider.take_interactive_rx().unwrap();
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(60), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"bot-controls","name":"Bot controls fixture",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
        })).await?;
        assert_eq!(connection["kind"], "committed", "{connection}");
        let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
        let bot = call(client, "agent", "openBot", json!({})).await?;
        let bot_id = bot["sessionId"].as_str().ok_or("Bot Session missing")?;
        let sent = call(client, "agent", "send", json!({
            "sessionId":bot_id,"message":"Reply with hello.","backend":backend
        })).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let respond = observed.recv().await.ok_or("Bot request missing")?;
        let request = respond.body();
        assert!(has_tool(request, "tool_search"));
        if !has_tool(request, "SendUser") || !has_tool(request, "sleep") {
            return Err(format!("first Bot request lacks its controls: {}", request["tools"]).into());
        }
        respond.send_plan(tool_response("SendUser", json!({
            "messageId":"greeting","messages":[{"text":"Hello."}]
        })));

        let respond = observed.recv().await.ok_or("Bot follow-up missing")?;
        let request = respond.body();
        assert!(has_tool(request, "sleep"));
        respond.send_plan(tool_response("sleep", json!({})));
        quiescent_message(client, bot_id, &sent["messageId"]).await?;
        assert!(observed.try_recv().is_err(), "sleep should finish without another model request");

        let outbox = call(client, "agent", "botOutbox", json!({"sessionId":bot_id})).await?;
        assert_eq!(outbox["through"], 1, "{outbox}");
        assert_eq!(outbox["messages"][0]["text"], "Hello.", "{outbox}");

        let ordinary = call(client, "agent", "create", json!({
            "title":"Ordinary session","automaticTitle":false,"labels":[],
            "workspace":{"kind":"directory","path":base.join("workspace")}
        })).await?;
        let session = ordinary["session"]["id"].as_str().ok_or("ordinary Session missing")?;
        let sent = call(client, "agent", "send", json!({
            "sessionId":session,"message":"Reply with hello.","backend":backend
        })).await?;
        let respond = observed.recv().await.ok_or("ordinary request missing")?;
        let request = respond.body();
        assert!(!has_tool(request, "SendUser") && !has_tool(request, "sleep"));
        respond.reply_text("Hello.");
        quiescent_message(client, session, &sent["messageId"]).await?;
        Ok(())
    }).await;
    provider.shutdown().await;
    let errors = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    result??;
    assert!(errors.is_empty(), "cleanup: {errors:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_delegation_preserves_preset_models_and_ordinary_inheritance() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let mut provider = MockAiBuilder::new().interactive(1).start().await?;
    let boot = bootstrap_with(&base, provider.base_url(), |config| {
        config["bot"] = json!(true);
        config["todo"] = json!(true);
        config["scheduledTasks"] = json!(true);
        config["toolDiscovery"] = json!(true);
    })
    .await?;
    let mut observed = provider.take_interactive_rx().unwrap();
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(120), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"bot-controls","name":"Bot controls fixture",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2","preset","switched","override"],
                "modelOverrides": (["llama3.2","preset","switched","override"].into_iter().map(|id|
                    (id.to_owned(), json!({"codeMode":id == "preset","apiProtocol":"openai-chat-completions","thinkingLevels":["high"]})))
                    .collect::<serde_json::Map<String,Value>>())}
        })).await?;
        assert_eq!(connection["kind"], "committed", "{connection}");
        let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
        let bot = call(client, "agent", "openBot", json!({})).await?;
        let bot_id = bot["sessionId"].as_str().ok_or("Bot Session missing")?;
        let sent = call(client, "agent", "send", json!({
            "sessionId":bot_id,"message":"Reply with hello.","backend":backend
        })).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let respond = observed.recv().await.ok_or("Bot request missing")?;
        let request = respond.body();
        assert!(has_tool(request, "tool_search"));
        if !has_tool(request, "SendUser") || !has_tool(request, "sleep") {
            return Err(format!("first Bot request lacks its controls: {}", request["tools"]).into());
        }
        let owner = rig.captured.lock().unwrap().clone().ok_or("Native owner missing")?;
        let role = "# Reviewer\nPreserve this role during Bot delegation.\n";
        let preset = call(client, "agent", "createPreset", json!({
            "name":"Bot reviewer","description":"Review delegated work","instruction":role,
            "model":{"connectionId":connection["connection"]["connectionId"],"modelId":"preset"},
            "thinkingLevel":"high"
        })).await?;
        assert_eq!(preset["kind"], "saved", "{preset}");
        let mut input = json!({"presetId":preset["preset"]["id"],"title":"Preset worker",
            "labels":[],"workspace":{"kind":"directory","path":base.join("workspace")}});
        let created = agent_call(&owner, bot_id, "create", input.clone()).await?;
        assert_eq!(created["kind"], "created", "{created}");
        let preset_session = created["session"]["id"].clone();
        input.as_object_mut().unwrap().remove("presetId");
        input["backend"] = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"preset"});
        let ordinary = agent_call(&owner, bot_id, "create", input).await?;
        assert_eq!(ordinary["kind"], "created", "{ordinary}");
        for (round, expected) in ["preset", "switched", "override", "switched", "llama3.2"].into_iter().enumerate() {
            let session = if round == 4 { &ordinary["session"]["id"] } else { &preset_session };
            let selected = |model| json!({"kind":"model","connectionId":connection["connection"]["connectionId"],
                "modelId":model,"thinkingLevel":"high"});
            if round == 1 {
                let changed = call(client, "agent", "selectBackend", json!({"sessionId":session,"backend":selected("switched")})).await?;
                assert_eq!(changed["kind"], "committed", "{changed}");
            }
            let mut input = json!({"sessionId":session,"message":format!("Delegated review {round}")});
            if round == 2 { input["backend"] = selected("override"); }
            let sent = agent_call(&owner, bot_id, "send", input).await?;
            assert_eq!(sent["kind"], "queued", "{sent}");
            let mut reply = observed.recv().await.ok_or("delegated request missing")?;
            if round == 0 {
                let mut progress = client.call("agent","watchWorkerProgress".into(),json!({"parentSessionId":bot_id}),Attachments::new()).await?;
                progress.start().await?;
                assert!(matches!(progress.receive().await?,Reply::Subscribed));
                let Reply::Item {value:frame} = progress.pull().await? else {return Err("missing active worker snapshot".into());};
                assert_eq!(frame["snapshot"],true);
                assert_eq!(frame["upsert"].as_array().unwrap().len(),1);
                assert_eq!(frame["upsert"][0]["sessionId"],*session);
                let id = session.as_str().unwrap();
                let access = owner.runs.state().await.controls[id].access.upgrade().unwrap();
                reply.send_plan(tool_response("exec", json!({
                    "code":"await yield_control(); await tools.todo_write({todos:[{status:'in_progress',content:'Inspecting results'}]}); await new Promise(resolve => setTimeout(resolve, 2000));",
                    "yield_time_ms":10000
                })));
                let yielded = observed.recv().await.ok_or("missing yielded cell")?;
                let result = yielded.body()["messages"].as_array().unwrap().iter().rev()
                    .find(|message| message["role"] == "tool").and_then(|message| message["content"].as_str())
                    .ok_or("missing cell result")?;
                let status: Value = serde_json::from_str(result.lines().next().ok_or("empty cell result")?)?;
                yielded.send_plan(tool_response("wait", json!({"cell_id":status["cell_id"], "yield_time_ms":10000})));
                let mut saw_todo = false;
                reply = loop {
                    tokio::select! {
                        biased;
                        frame = progress.pull() => {
                            let Reply::Item {value} = frame? else {return Err("missing worker progress".into());};
                            for row in value["upsert"].as_array().unwrap() {
                                assert!(!matches!(row["detail"].as_str(), Some("exec" | "wait")), "{row}");
                                saw_todo |= row["detail"] == "Inspecting results";
                            }
                        }
                        next = observed.recv() => break next.ok_or("missing tool follow-up")?,
                    }
                };
                assert!(saw_todo, "worker did not project its committed checklist");
                let target = ServiceTarget::Export {name:"agent".into()};
                let services = owner.services.select_method(&target,"watchWorkerProgress")?;
                let request = services.request_with_work(
                    maka_capabilities::call::Identity::Agent {execution:access.execution().clone(),operation_id:None},
                    CancellationToken::new(), access.custody().clone()
                )?;
                let mut denied = request.subscribe_target(&target,"watchWorkerProgress".into(),json!({"parentSessionId":bot_id}),Attachments::new())?.await?;
                assert!(denied.recv().await.is_none());
                let completion = denied.completion().await;
                assert!(completion.result.is_err());
                completion.cleanup?;
                request.finish().await?;
                progress.cancel().await?;
                progress.close().await?;
            }
            let request = reply.body();
            assert_eq!(request["model"], expected, "{request}");
            if round != 4 {
                assert_eq!(request["reasoning_effort"], "high", "{request}");
                let text = request["messages"].as_array().unwrap().iter()
                    .filter_map(|message| message["content"].as_str()).collect::<Vec<_>>().join("\n");
                assert_eq!(text.matches(role).count(), 1, "{request}");
            }
            reply.reply_text("Reviewed.");
            quiescent_message(client, session.as_str().unwrap(), &sent["messageId"]).await?;
        }
        drop(respond);
        Ok(())
    }).await;
    provider.shutdown().await;
    let errors = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    result??;
    assert!(errors.is_empty(), "cleanup: {errors:?}");
    Ok(())
}

pub(super) async fn agent_call(
    owner: &Owner,
    session: &str,
    method: &str,
    input: Value,
) -> TestResult<Value> {
    let access = owner
        .runs
        .state()
        .await
        .controls
        .get(session)
        .and_then(|control| control.access.upgrade())
        .ok_or("caller access missing")?;
    let target = ServiceTarget::Export {
        name: "agent".into(),
    };
    let services = owner.services.select_method(&target, method)?;
    let request = services.request_with_work(
        maka_capabilities::call::Identity::Agent {
            execution: access.execution().clone(),
            operation_id: None,
        },
        CancellationToken::new(),
        access.custody().clone(),
    )?;
    let completed = request
        .begin_mutation_target(
            &target,
            method.into(),
            input,
            Uuid::new_v4(),
            json!({"test":"agent-call"}),
            Attachments::new(),
        )?
        .await?
        .completion()
        .await;
    completed.cleanup?;
    request.finish().await?;
    match completed.reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value),
        receipt => Err(format!("agent call did not commit: {receipt:?}").into()),
    }
}

pub(super) fn has_tool(request: &Value, name: &str) -> bool {
    request["tools"]
        .as_array()
        .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == name))
}

pub(super) fn tool_response(name: &str, input: Value) -> TurnPlan {
    TurnPlan::new()
        .push_tool_call(format!("call-{name}"), name, input)
        .finish(FinishReason::ToolCalls)
}
