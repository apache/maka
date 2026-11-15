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
use super::bot_tools::completion;
use super::*;

fn search(id: &str) -> String {
    completion(
        json!({"role":"assistant","tool_calls":[{
            "index":0,"id":id,"type":"function",
            "function":{"name":"tool_search","arguments":json!({"query":id}).to_string()}
        }]}),
        "tool_calls",
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_history_reads_a_turns_steps_as_one_growing_group() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let boot = bootstrap_with(
        &base,
        format!("http://{}/v1", listener.local_addr()?),
        |config| config["toolDiscovery"] = json!(true),
    )
    .await?;
    let (requests, mut observed) = tokio::sync::mpsc::channel(1);
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move || {
            let requests = requests.clone();
            async move {
                let (reply, response) = oneshot::channel::<String>();
                let _ = requests.send(reply).await;
                (
                    [("content-type", "text/event-stream")],
                    response.await.unwrap_or_default(),
                )
            }
        }),
    );
    let provider = tokio::spawn(async move { axum::serve(listener, app).await });
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(60), async {
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"work-groups","name":"Work groups fixture",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
        })).await?;
        let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
        let created = call(client, "agent", "create", json!({
            "title":"Work groups","automaticTitle":false,"labels":[],
            "workspace":{"kind":"directory","path":base.join("workspace")}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("Session missing")?;
        let sent = call(client, "agent", "send", json!({
            "sessionId":session,"message":"Search twice.","backend":backend
        })).await?;
        let history = |through: Value, position: Value, view: &str| {
            call(client, "agent", "history", json!({
                "sessionId":session,"through":through,"position":position,"includeThinking":true,"view":view
            }))
        };
        let groups = |page: &Value| -> Vec<Value> {
            page["chunks"].as_array().unwrap().iter()
                .filter(|chunk| !chunk["work"].is_null()).cloned().collect()
        };

        observed.recv().await.ok_or("first request missing")?
            .send(search("first")).map_err(|_| "provider stopped")?;
        let respond = observed.recv().await.ok_or("second request missing")?;
        let tail = history(Value::Null, json!({"kind":"tail"}), "chat").await?;
        let [group] = &groups(&tail)[..] else { return Err(format!("{tail}").into()) };
        assert_eq!(group["work"]["tools"], 1, "{group}");
        assert_eq!(group["work"]["kinds"][0]["kind"], "tool", "{group}");
        assert!(tail["chunks"].as_array().unwrap().iter().all(|chunk| chunk["tool"].is_null()));

        respond.send(search("second")).map_err(|_| "provider stopped")?;
        let respond = observed.recv().await.ok_or("third request missing")?;
        let through = history(Value::Null, json!({"kind":"tail"}), "chat").await?["through"].clone();
        let next = history(through.clone(), json!({"kind":"after","cursor":group["work"]["end"]}), "chat").await?;
        let [grown] = &groups(&next)[..] else { return Err(format!("{next}").into()) };
        assert_eq!(grown["position"], group["position"]);
        assert_eq!(grown["work"]["tools"], 2, "{grown}");

        let steps = history(through, json!({"kind":"row","position":group["position"],"field":group["field"]}), "steps").await?;
        let mut ids: Vec<_> = steps["chunks"].as_array().unwrap().iter()
            .map(|chunk| chunk["tool"]["toolUseId"].as_str().map(str::to_owned))
            .collect::<Option<_>>().ok_or("a step is not a tool")?;
        ids.dedup();
        assert!(ids.len() == 2 && ids[0] != ids[1], "{steps}");
        assert!(steps["after"].is_null(), "{steps}");

        respond.send(completion(json!({"role":"assistant","content":"Done."}), "stop"))
            .map_err(|_| "provider stopped")?;
        quiescent_message(client, session, &sent["messageId"]).await?;
        Ok(())
    }).await;
    provider.abort();
    let errors = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    result??;
    assert!(errors.is_empty(), "cleanup: {errors:?}");
    Ok(())
}
