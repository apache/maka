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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_controls_remain_visible_with_tool_discovery() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let boot = bootstrap_with(
        &base,
        format!("http://{}/v1", listener.local_addr()?),
        |config| {
            config["bot"] = json!(true);
            config["scheduledTasks"] = json!(true);
            config["toolDiscovery"] = json!(true);
        },
    )
    .await?;
    let (requests, mut observed) = tokio::sync::mpsc::channel(1);
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |request: axum::extract::Request| {
            let requests = requests.clone();
            async move {
                let bytes = axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024)
                    .await
                    .unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                let (reply, response) = oneshot::channel::<String>();
                let _ = requests.send((request, reply)).await;
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
        let (request, respond) = observed.recv().await.ok_or("Bot request missing")?;
        assert!(has_tool(&request, "tool_search"));
        if !has_tool(&request, "SendUser") || !has_tool(&request, "sleep") {
            return Err(format!("first Bot request lacks its controls: {}", request["tools"]).into());
        }
        respond.send(tool_response("SendUser", json!({
            "messageId":"greeting","messages":[{"text":"Hello."}]
        }))).map_err(|_| "provider stopped before SendUser")?;

        let (request, respond) = observed.recv().await.ok_or("Bot follow-up missing")?;
        assert!(has_tool(&request, "sleep"));
        respond.send(tool_response("sleep", json!({}))).map_err(|_| "provider stopped before sleep")?;
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
        let (request, respond) = observed.recv().await.ok_or("ordinary request missing")?;
        assert!(!has_tool(&request, "SendUser") && !has_tool(&request, "sleep"));
        respond.send(completion(json!({"role":"assistant","content":"Hello."}), "stop"))
            .map_err(|_| "provider stopped before ordinary reply")?;
        quiescent_message(client, session, &sent["messageId"]).await?;
        Ok(())
    }).await;
    provider.abort();
    let errors = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    result??;
    assert!(errors.is_empty(), "cleanup: {errors:?}");
    Ok(())
}

fn has_tool(request: &Value, name: &str) -> bool {
    request["tools"]
        .as_array()
        .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == name))
}

fn tool_response(name: &str, input: Value) -> String {
    completion(
        json!({"role":"assistant","tool_calls":[{
            "index":0,"id":format!("call-{name}"),"type":"function",
            "function":{"name":name,"arguments":input.to_string()}
        }]}),
        "tool_calls",
    )
}

fn completion(delta: Value, finish: &str) -> String {
    let chunk = |delta, reason: Value| {
        json!({
            "id":"bot-controls","object":"chat.completion.chunk","created":1,"model":"llama3.2",
            "choices":[{"index":0,"delta":delta,"finish_reason":reason}]
        })
    };
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        chunk(delta, Value::Null),
        chunk(json!({}), json!(finish))
    )
}
