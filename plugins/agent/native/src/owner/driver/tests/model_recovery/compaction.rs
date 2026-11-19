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
use super::bot_tools::{completion, has_tool, observed_provider, tool_response};
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requested_compaction_resumes_from_checkpoint_with_optional_focus_and_model()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let boot = bootstrap_with(
        &base,
        format!("http://{}/v1", listener.local_addr()?),
        |config| {
            config["toolDiscovery"] = json!(true);
            config["todo"] = json!(true);
        },
    )
    .await?;
    let (mut observed, provider) = observed_provider(listener);
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(60), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"compact","name":"Compact fixture",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2","code-source","successor"],
                "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}, "code-source":{"codeMode":true,"apiProtocol":"openai-chat-completions"}, "successor":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
        })).await?;
        let owner = rig.captured.lock().unwrap().clone().ok_or("native owner missing")?;
        for (source, focused, switch, stop) in [
            ("llama3.2", false, false, false), ("code-source", false, false, false),
            ("llama3.2", true, false, false), ("llama3.2", false, true, false),
            ("code-source", true, true, false), ("llama3.2", true, true, true),
        ] {
            let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":source});
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
            let sent = call(client, "agent", "send", json!({
                "sessionId":session,"message":"Keep the open task.","backend":backend
            })).await?;
            let (main, reply) = observed.recv().await.ok_or("initial request missing")?;
            let code = source == "code-source";
            assert_eq!(has_tool(&main, "exec"), code);
            assert!(!has_tool(&main, "CompactContext"));
            let description = |name: &str| main["tools"].as_array().unwrap().iter()
                .find(|t| t["function"]["name"] == name).unwrap()["function"]["description"].as_str().unwrap();
            assert!(description("tool_search").contains("CompactContext"));
            assert_eq!(description("tool_search").contains("todo_read"), !code);
            if code {
                assert!(description("exec").contains("todo_read"));
                assert!(!description("exec").contains("CompactContext"));
            }
            reply.send(tool_response("tool_search", json!({"query":"CompactContext","limit":1})))
                .map_err(|_| "provider closed")?;
            let (loaded, reply) = observed.recv().await.ok_or("request after search missing")?;
            let receipt = loaded["messages"].as_array().unwrap().iter()
                .find(|m| m["tool_call_id"] == "call-tool_search").ok_or("search receipt missing")?;
            assert_eq!(serde_json::from_str::<Value>(receipt["content"].as_str().unwrap())?, json!({"activated":["CompactContext"]}));
            assert!(has_tool(&loaded, "CompactContext"));
            reply.send(completion(json!({"role":"assistant","tool_calls":[
                {"index":0,"id":"request-compact","type":"function","function":{"name":"CompactContext","arguments":args.to_string()}},
                {"index":1,"id":"lookup","type":"function","function":{"name":"tool_search","arguments":json!({"query":"todo_read"}).to_string()}}
            ]}), "tool_calls")).map_err(|_| "provider closed")?;

            let (summary, reply) = observed.recv().await.ok_or("summary request missing")?;
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
                let _ = reply.send(completion(json!({"role":"assistant","content":"Late checkpoint"}), "stop"));
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
            let text = |s| completion(json!({"role":"assistant","content":s}), "stop");
            reply.send(text("Checkpoint: the open task is ready.")).map_err(|_| "provider closed")?;

            let (resumed, reply) = observed.recv().await.ok_or("resumed request missing")?;
            assert!(resumed["messages"].to_string().contains("Checkpoint: the open task is ready."));
            let expected = if switch { "successor" } else { source };
            assert_eq!(resumed["model"], expected);
            assert!(!resumed["messages"].to_string().contains("Keep the release checksum."));
            reply.send(text("Done.")).map_err(|_| "provider closed")?;
            quiescent_message(client, session, &sent["messageId"]).await?;
            let follow = call(client, "agent", "send", json!({"sessionId":session, "message":"Which model is answering?", "delivery":"queue"})).await?;
            let (next, reply) = observed.recv().await.ok_or("follow-up missing")?;
            assert_eq!(next["model"], expected);
            assert!(owner.session(session).await?.configuration.compaction_prompt.is_none());
            reply.send(text("Still here.")).map_err(|_| "provider closed")?;
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
    provider.abort();
    let errors = rig.finish().await;
    result??;
    assert!(errors.is_empty(), "{errors:?}");
    Ok(())
}
