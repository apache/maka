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
use super::bot_tools::{agent_call, has_tool, tool_response};
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requested_compaction_resumes_from_checkpoint_with_optional_focus_and_model()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let mut provider = MockAiBuilder::new().interactive(1).start().await?;
    let boot = bootstrap_with(&base, provider.base_url(), |config| {
        config["toolDiscovery"] = json!(true);
        config["todo"] = json!(true);
        config["tools"] = json!(["write", "edit", "applyPatch"].map(|method| json!({
            "name":match method { "write" => "Write", "edit" => "Edit", _ => "ApplyPatch" },
            "description":method,"target":{"kind":"import","name":"files"},
            "method":method,"nestable":true,"result":"json","confirmation":"preapproved"
        })));
    })
    .await?;
    let mut observed = provider.take_interactive_rx().unwrap();
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(60), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"compact","name":"Compact fixture",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2","code-source","successor","low-only"],
                "modelOverrides":{"llama3.2":{"thinkingLevels":["high"],"codeMode":false,"apiProtocol":"openai-chat-completions"}, "code-source":{"thinkingLevels":["high"],"codeMode":true,"apiProtocol":"openai-chat-completions"}, "low-only":{"thinkingLevels":["low"]},"successor":{"applyPatch":true,"thinkingLevels":["high"],"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
        })).await?;
        let owner = rig.captured.lock().unwrap().clone().ok_or("native owner missing")?;
        for (source, focused, switch, stop) in [
            ("llama3.2", false, false, false), ("code-source", false, false, false),
            ("llama3.2", true, false, false), ("llama3.2", false, true, false),
            ("code-source", true, true, false), ("llama3.2", true, true, true),
        ] {
            let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":source,"thinkingLevel":"high"});
            let created = call(client, "agent", "create", json!({
                "title":"Compact","automaticTitle":false,"labels":[],
                "workspace":{"kind":"directory","path":base.join("workspace")}
            })).await?;
            let session = created["session"]["id"].as_str().ok_or("Session missing")?;
            let set = call(client, "agent", "selectBackend", json!({"sessionId":session,"backend":backend})).await?;
            assert_eq!(set["kind"], "committed");
            let mut args = json!({});
            if focused { args["prompt"] = json!("Keep the release checksum."); }
            if switch { args["resumeModel"] = json!({"connectionId":backend["connectionId"],"modelId":"successor"}); }
            let send = json!({"sessionId":session,"message":"Keep the open task.","backend":backend});
            let mut caller_session = None;
            let sent = if switch && !focused {
                let caller = call(client,"agent","create",json!({"title":"Caller","automaticTitle":false,"labels":[],
                    "workspace":{"kind":"directory","path":base.join("workspace")}})).await?;
                let caller = caller["session"]["id"].as_str().unwrap().to_owned();
                let parent = call(client,"agent","send",json!({"sessionId":caller,"message":"Delegate the check.","backend":backend})).await?;
                let parent_reply = observed.recv().await.ok_or("caller missing")?;
                let mut send = send;
                send["onComplete"] = json!("notify_caller");
                let delegated = agent_call(&owner, &caller, "send", send).await?;
                assert_eq!(delegated["completion"], "registered");
                parent_reply.reply_text("Waiting for the worker.");
                quiescent_message(client,&caller,&parent["messageId"]).await?;
                caller_session = Some(caller);
                delegated
            } else { call(client, "agent", "send", send).await? };
            let reply = observed.recv().await.ok_or("initial request missing")?;
            let main = reply.body();
            let code = source == "code-source";
            assert_eq!(has_tool(main, "exec"), code);
            assert!(!has_tool(main, "CompactContext"));
            let description = |name: &str| main["tools"].as_array().unwrap().iter()
                .find(|t| t["function"]["name"] == name).unwrap()["function"]["description"].as_str().unwrap();
            assert!(description("tool_search").contains("CompactContext"));
            assert_eq!(description("tool_search").contains("todo_read"), !code);
            if code {
                assert!(description("exec").contains("todo_read"));
                assert!(!description("exec").contains("CompactContext"));
            }
            let has_edit = |name: &str| if code { description("exec").contains(name) } else { has_tool(main, name) };
            assert!(has_edit("Write") && has_edit("Edit") && !has_edit("ApplyPatch"));
            reply.send_plan(tool_response("tool_search", json!({"query":"CompactContext","limit":1})));
            let reply = observed.recv().await.ok_or("request after search missing")?;
            let loaded = reply.body();
            let receipt = loaded["messages"].as_array().unwrap().iter()
                .find(|m| m["tool_call_id"] == "call-tool_search").ok_or("search receipt missing")?;
            assert_eq!(serde_json::from_str::<Value>(receipt["content"].as_str().unwrap())?, json!({"activated":["CompactContext"]}));
            assert!(has_tool(loaded, "CompactContext"));
            let reply = if stop {
                reply.send_plan(tool_response("CompactContext", json!({"resumeModel":{
                    "connectionId":backend["connectionId"],"modelId":"low-only"}})));
                let reply = observed.recv().await.ok_or("unsupported thinking level missing")?;
                let rejected = reply.body();
                assert!(rejected["messages"].to_string().contains("does not support this session's thinking level"), "{rejected}");
                assert_eq!(rejected["model"],source);
                reply
            } else { reply };
            reply.send_plan(TurnPlan::new().push_tool_call("request-compact", "CompactContext", args)
                .push_tool_call("lookup", "tool_search", json!({"query":"todo_read"})).finish(FinishReason::ToolCalls));

            let reply = observed.recv().await.ok_or("summary request missing")?;
            let summary = reply.body();
            assert!(summary["tools"].as_array().is_none_or(Vec::is_empty));
            let messages = summary["messages"].as_array().unwrap();
            assert_eq!(summary["model"], source);
            let settings = owner.session(session).await?.configuration;
            assert_eq!(serde_json::to_value(settings.backend)?["modelId"], source);
            assert!(settings.compaction_prompt.is_none());
            assert_eq!(messages.last().unwrap()["content"].to_string().contains("Keep the release checksum."), focused, "{summary}");
            for id in ["request-compact", "lookup"] {
                assert_eq!(messages.iter().filter(|m| m["role"] == "tool" && m["tool_call_id"] == id).count(), 1);
            }
            let lookup = messages.iter().find(|m| m["tool_call_id"] == "lookup").unwrap();
            let lookup: Value = serde_json::from_str(lookup["content"].as_str().unwrap())?;
            assert_eq!(lookup["activated"].as_array().unwrap().iter().any(|name| name == "todo_read"), !code);
            if stop {
                let work = call(client, "agent", "work", json!({"sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}})).await?;
                let run = &work["execution"]["runId"];
                call(client, "agent", "stop", json!({"sessionId":session,"runId":run})).await?;
                reply.reply_text("Late checkpoint");
                loop {
                    let work = call(client, "agent", "work", json!({"sessionId":session,"target":{"kind":"run","runId":run}})).await?;
                    match work["execution"]["state"]["kind"].as_str() {
                        Some("cancelled") => break,
                        Some("completed" | "failed") => return Err(format!("Stop did not win: {work}").into()),
                        _ => tokio::time::sleep(Duration::from_millis(20)).await,
                    }
                }
                assert_eq!(serde_json::to_value(owner.session(session).await?.configuration.backend)?["modelId"], source);
                assert!(owner.durable.session_history(owner.run_owner(), session.into()).successor(serde_json::from_value(run.clone())?).await?.is_none());
                continue;
            }
            let target = json!({"sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}});
            let original = call(client,"agent","work",target.clone()).await?;
            reply.reply_text("Checkpoint: the open task is ready.");

            let reply = observed.recv().await.ok_or("resumed request missing")?;
            let resumed = reply.body();
            assert!(resumed["messages"].to_string().contains("Checkpoint: the open task is ready."));
            let expected = if switch { "successor" } else { source };
            assert_eq!(resumed["model"], expected);
            let running = call(client,"agent","work",target.clone()).await?;
            assert_eq!(running["execution"]["runId"] != original["execution"]["runId"], switch);
            assert_eq!(running["execution"]["state"]["kind"], "running");
            let remembered = serde_json::to_value(owner.remembered_backend(session).await?)?;
            assert_eq!(remembered["modelId"],expected);
            assert_eq!(remembered["thinkingLevel"],"high");
            if switch {
                assert!(has_tool(resumed,"ApplyPatch") && !has_tool(resumed,"Write") && !has_tool(resumed,"Edit"));
                assert_eq!(serde_json::to_value(owner.session(session).await?.configuration.backend)?["thinkingLevel"],"high");
            }
            if caller_session.is_some() {
                owner.deliver_completions().await?;
                assert!(observed.try_recv().is_err(), "caller received an early completion");
            }
            assert!(!resumed["messages"].to_string().contains("Keep the release checksum."));
            let reply = if focused && !switch {
                // A second checkpoint in the same Run must resume without another user message.
                reply.reply_tool_call("find-again", "tool_search", json!({"query":"CompactContext"}));
                let reply = observed.recv().await.ok_or("second lookup missing")?;
                let loaded = reply.body();
                assert!(has_tool(loaded, "CompactContext"));
                reply.send_plan(tool_response("CompactContext", json!({})));
                let reply = observed.recv().await.ok_or("second summary missing")?;
                let summary = reply.body();
                assert!(summary["tools"].as_array().is_none_or(Vec::is_empty));
                reply.reply_text("Second checkpoint.");
                let reply = observed.recv().await.ok_or("second continuation missing")?;
                let next = reply.body();
                assert!(next["messages"].to_string().contains("Second checkpoint."));
                reply
            } else { reply };
            reply.reply_text("Done.");
            quiescent_message(client, session, &sent["messageId"]).await?;
            let finished = call(client,"agent","work",target).await?;
            assert_eq!(finished["execution"]["runId"], running["execution"]["runId"]);
            assert_eq!(finished["answer"]["text"], "Done.");
            if caller_session.is_some() {
                let parent_reply = observed.recv().await.ok_or("completion notice missing")?;
                let notice = parent_reply.body();
                let last = notice["messages"].as_array().unwrap().iter().rev().find(|m| m["role"]=="user").unwrap();
                assert!(last["content"].to_string().contains("Done."),"{last}");
                parent_reply.reply_text("Received.");
            }
            let follow = call(client, "agent", "send", json!({"sessionId":session, "message":"Which model is answering?", "delivery":"queue"})).await?;
            let reply = observed.recv().await.ok_or("follow-up missing")?;
            let next = reply.body();
            assert_eq!(next["model"], expected);
            assert!(owner.session(session).await?.configuration.compaction_prompt.is_none());
            reply.reply_text("Still here.");
            quiescent_message(client, session, &follow["messageId"]).await?;
            let page = call(client, "agent", "history", json!({
                "sessionId":session, "position":{"kind":"tail"}, "view":"conversation", "includeThinking":true
            })).await?;
            let rows = page["chunks"].as_array().unwrap();
            let checkpoint = rows.iter().find(|row| row["role"] == "compaction").ok_or("no checkpoint")?;
            let done = rows.iter().find(|row| row["text"] == "Done.").ok_or("no final answer")?;
            assert_eq!(checkpoint["runId"] != done["runId"], switch);
            assert_eq!(checkpoint["turnId"], done["turnId"]);
        }
        assert!(observed.try_recv().is_err());
        Ok(())
    }).await;
    provider.shutdown().await;
    let errors = rig.finish().await;
    result??;
    assert!(errors.is_empty(), "{errors:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_repair_recovers_from_rejected_tool_content_and_preserves_frozen_cut()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let mut provider = MockAiBuilder::new().interactive(1).start().await?;
    let boot = bootstrap_with(&base, provider.base_url(), |config| {
        config["tools"] = json!([{
            "name":"Write",
            "description":"write",
            "target":{"kind":"import","name":"files"},
            "method":"write",
            "nestable":true,
            "result":"json",
            "confirmation":"preapproved"
        }]);
    })
    .await?;
    let mut observed = provider.take_interactive_rx().unwrap();
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(60), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision": catalog["revision"],
            "connection": {
                "slug": "repair",
                "name": "Repair fixture",
                "provider": {"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration": {"baseUrl": boot.base_url},
                "enabled": true,
                "enabledModelIds": ["llama3.2"],
                "modelOverrides": {
                    "llama3.2": {
                        "codeMode": false,
                        "apiProtocol": "openai-chat-completions",
                        "contextWindow": 32000,
                        "inputLimit": 32000,
                        "maxOutputTokens": 4096
                    }
                }
            }
        })).await?;
        let backend = json!({
            "kind": "model",
            "connectionId": connection["connection"]["connectionId"],
            "modelId": "llama3.2",
            "thinkingLevel": null
        });
        let created = call(client, "agent", "create", json!({
            "title": "SummaryRepair",
            "automaticTitle": false,
            "labels": [],
            "workspace": {"kind":"directory","path": base.join("workspace")}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("Session missing")?;

        // Seed one completed turn so manual compaction has history to summarize.
        let first = call(client, "agent", "send", json!({
            "sessionId": session,
            "message": "Seed turn before compaction.",
            "backend": backend
        })).await?;
        let reply = observed.recv().await.ok_or("seed main missing")?;
        reply.reply_text("Seed done.");
        quiescent_message(client, session, &first["messageId"]).await?;

        // Trigger explicit compaction; first Summary attempt emits a tool call (RejectedToolContent).
        let compact = call(client, "agent", "compact", json!({
            "sessionId": session,
            "model": {
                "connectionId": backend["connectionId"],
                "modelId": "llama3.2"
            },
            "thinkingLevel": null,
            "prompt": "Summarize cleanly without tools."
        })).await?;
        assert_eq!(compact["kind"], "started");

        let req_output_limit = |req: &Value| {
            req["max_tokens"]
                .as_u64()
                .or_else(|| req["max_completion_tokens"].as_u64())
        };
        let summary_reply = observed.recv().await.ok_or("initial summary missing")?;
        let summary_req = summary_reply.body();
        assert!(summary_req["tools"].as_array().is_none_or(Vec::is_empty));
        assert_eq!(
            req_output_limit(summary_req),
            Some(4096),
            "initial summary must preserve frozen 4096 output cap instead of inflating to 8000: {summary_req}"
        );
        summary_reply
            .send_plan(tool_response("Write", json!({"path":"nope.txt","content":"bad"})));

        // Engine must issue a SummaryRepair request preserving both the original frozen cut and output budget.
        let repair_reply = observed.recv().await.ok_or("summary repair request missing")?;
        let repair_req = repair_reply.body();
        assert!(repair_req["tools"].as_array().is_none_or(Vec::is_empty));
        assert_eq!(
            req_output_limit(repair_req),
            Some(4096),
            "summary repair must preserve frozen 4096 output cap instead of inflating to 8000: {repair_req}"
        );
        repair_reply
            .reply_text("Repaired compaction checkpoint.");

        // Follow-up turn must succeed and include the repaired compaction summary.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let obs = call(client, "agent", "observe", json!({"sessionId": session})).await?;
            if obs["session"]["activity"].as_str() == Some("idle") && obs["compacting"].is_null() {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "compaction did not settle: {obs}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let page = call(client, "agent", "history", json!({
            "sessionId": session,
            "position": {"kind":"tail"},
            "view": "conversation",
            "includeThinking": false
        })).await?;
        assert!(
            page["chunks"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["role"] == "compaction")),
            "compaction checkpoint missing from history: {page}"
        );
        // Next turn must receive the repaired compaction summary in model input.
        let follow = call(client, "agent", "send", json!({
            "sessionId": session,
            "message": "Continue after repaired compaction.",
            "backend": backend,
            "delivery": "queue"
        })).await?;
        assert!(follow["kind"] == "accepted" || follow["kind"] == "queued", "follow-up send rejected: {follow}");
        let follow_reply = observed.recv().await.ok_or("follow-up missing")?;
        let follow_req = follow_reply.body();
        assert!(
            follow_req["messages"].to_string().contains("Repaired compaction checkpoint."),
            "follow-up request did not carry repaired summary: {follow_req}"
        );
        follow_reply.reply_text("Continued.");
        quiescent_message(client, session, &follow["messageId"]).await?;
        Ok(())
    }).await;
    provider.shutdown().await;
    let errors = rig.finish().await;
    result??;
    assert!(errors.is_empty(), "{errors:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cell_notifications_deduplicate_child_knowledge_per_step_cut() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let mut provider = MockAiBuilder::new().interactive(1).start().await?;
    let boot = bootstrap_with(&base, provider.base_url(), |config| {
        config["tools"] = json!([{
            "name":"Write",
            "description":"write",
            "target":{"kind":"import","name":"files"},
            "method":"write",
            "nestable":true,
            "result":"json",
            "confirmation":"preapproved"
        }]);
    })
    .await?;
    let mut observed = provider.take_interactive_rx().unwrap();
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(60), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision": catalog["revision"],
            "connection": {
                "slug": "notif-dedup",
                "name": "Notification dedup fixture",
                "provider": {"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration": {"baseUrl": boot.base_url},
                "enabled": true,
                "enabledModelIds": ["code-source"],
                "modelOverrides": {
                    "code-source": {
                        "codeMode": true,
                        "codeModeLanguage": "javascript",
                        "apiProtocol": "openai-chat-completions",
                        "contextWindow": 128000,
                        "inputLimit": 128000
                    }
                }
            }
        })).await?;
        let backend = json!({
            "kind": "model",
            "connectionId": connection["connection"]["connectionId"],
            "modelId": "code-source",
            "thinkingLevel": null
        });
        let created = call(client, "agent", "create", json!({
            "title": "NotifDedup",
            "automaticTitle": false,
            "labels": [],
            "workspace": {"kind":"directory","path": base.join("workspace")}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("Session missing")?;

        let sent = call(client, "agent", "send", json!({
            "sessionId": session,
            "message": "Emit 12 notifications after nested tools.",
            "backend": backend
        })).await?;
        let reply1 = observed.recv().await.ok_or("first request missing")?;
        let code = r#"
            await Promise.all([0,1,2,3].map(i => tools.Write({ path: "n" + i + ".txt", content: "v" + i })));
            for (let i = 0; i < 12; i++) notify("burst-note-" + i);
            text("cell-done");
        "#;
        reply1
            .send_plan(tool_response("exec", json!({ "code": code, "yield_time_ms": 15000 })));

        let reply2 = observed.recv().await.ok_or("second request missing")?;
        let req2 = reply2.body();
        let wire = req2["messages"].to_string();
        for i in 0..12 {
            assert!(
                wire.contains(&format!("burst-note-{i}")),
                "missing notification burst-note-{i} in step 2"
            );
        }
        let knowledge_count = wire.matches("[Host Cell child knowledge;").count();
        assert_eq!(
            knowledge_count, 1,
            "expected exactly 1 cell child knowledge block for 12 same-cell notifications, got {knowledge_count}"
        );

        // Run a follow-up tool call so step 3 replays step 2's FrozenNotifications
        // without racing against an asynchronous FinalNotificationQueued from a
        // background cell completing between step 2 and step 3.
        reply2
            .send_plan(tool_response("Write", json!({ "path": "step2.txt", "content": "ok" })));

        let reply3 = observed.recv().await.ok_or("third request missing")?;
        let req3 = reply3.body();
        let wire3 = req3["messages"].to_string();
        assert_eq!(
            wire3.matches("[Host Cell child knowledge;").count(),
            1,
            "replayed step must preserve single deduplicated cell child knowledge block"
        );
        reply3.reply_text("All 12 notes processed.");

        quiescent_message(client, session, &sent["messageId"]).await?;
        Ok(())
    }).await;
    provider.shutdown().await;
    let errors = rig.finish().await;
    result??;
    assert!(errors.is_empty(), "{errors:?}");
    Ok(())
}
