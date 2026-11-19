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
use super::bot_tools::{completion, observed_provider};
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requested_compaction_resumes_from_checkpoint_in_the_same_run() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let boot = bootstrap_with(
        &base,
        format!("http://{}/v1", listener.local_addr()?),
        |config| config["toolDiscovery"] = json!(true),
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
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
        })).await?;
        let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
        let created = call(client, "agent", "create", json!({
            "title":"Compact","automaticTitle":false,"labels":[],
            "workspace":{"kind":"directory","path":base.join("workspace")}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("Session missing")?;
        let sent = call(client, "agent", "send", json!({
            "sessionId":session,"message":"Keep the open task.","backend":backend
        })).await?;
        let (main, reply) = observed.recv().await.ok_or("initial request missing")?;
        assert!(main["tools"].as_array().unwrap().iter().any(|tool|
            tool["function"]["name"] == "CompactContext"));
        reply.send(completion(json!({"role":"assistant","tool_calls":[
            {"index":0,"id":"request-compact","type":"function","function":{"name":"CompactContext","arguments":"{}"}},
            {"index":1,"id":"lookup","type":"function","function":{"name":"tool_search","arguments":json!({"query":"read a file"}).to_string()}}
        ]}), "tool_calls")).map_err(|_| "provider closed")?;

        let (summary, reply) = observed.recv().await.ok_or("summary request missing")?;
        assert!(summary["tools"].as_array().is_none_or(Vec::is_empty));
        let messages = summary["messages"].as_array().unwrap();
        for id in ["request-compact", "lookup"] {
            assert_eq!(messages.iter().filter(|m| m["role"] == "tool" && m["tool_call_id"] == id).count(), 1);
        }
        let text = |s| completion(json!({"role":"assistant","content":s}), "stop");
        reply.send(text("Checkpoint: the open task is ready.")).map_err(|_| "provider closed")?;

        let (resumed, reply) = observed.recv().await.ok_or("resumed request missing")?;
        assert!(resumed["messages"].to_string().contains("Checkpoint: the open task is ready."));
        reply.send(text("Done.")).map_err(|_| "provider closed")?;
        quiescent_message(client, session, &sent["messageId"]).await?;
        let page = call(client, "agent", "history", json!({
            "sessionId":session, "position":{"kind":"tail"}, "view":"conversation", "includeThinking":true
        })).await?;
        let rows = page["chunks"].as_array().unwrap();
        let checkpoint = rows.iter().find(|row| row["role"] == "compaction").ok_or("no checkpoint")?;
        let done = rows.iter().find(|row| row["text"] == "Done.").ok_or("no final answer")?;
        assert_eq!(checkpoint["runId"], done["runId"]);
        assert!(observed.try_recv().is_err());
        Ok(())
    }).await;
    provider.abort();
    let errors = rig.finish().await;
    result??;
    assert!(errors.is_empty(), "{errors:?}");
    Ok(())
}
