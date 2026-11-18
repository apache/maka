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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work_groups_page_cleanly_across_skipped_leading_steps() -> TestResult<()> {
    use maka_agent_facts::{
        artifact::ToolReturn,
        model::TextKind,
        tool_output::{AcceptedToolResult, DurableToolProjection, ToolOutput},
    };

    let mut rig = Rig::new()?;
    let result: Result<TestResult<()>, _> = tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let observe = |attempt, index, text_kind, text: &str| {
            rig.append(
                vec![Fact::ModelObserved {
                    attempt,
                    index,
                    part: ModelPart::Text {
                        text_kind,
                        text: text.into(),
                        provider_options: None,
                    },
                    continuation: None,
                }],
                vec![],
            )
        };
        let accept = |tool: ToolKey| {
            let rig = &rig;
            async move {
                let out = ContentBlob::json(&ToolReturn {
                    schema_version: SCHEMA_VERSION,
                    artifacts: vec![],
                    body: ReturnedToolResult {
                        output: ToolOutput::Text("ok".into()),
                        projection: DurableToolProjection::Text { text: "ok".into() },
                        is_error: false,
                        loaded_tools: Default::default(),
                    },
                })?;
                let acc = ContentBlob::json(&AcceptedToolResult::Local {
                    result: out.reference().clone(),
                })?;
                rig.append(
                    vec![
                        Fact::LocalToolReturned {
                            tool: tool.clone(),
                            settlement: ToolSettlement::Returned,
                            result: out.reference().clone(),
                            is_error: false,
                            cell_observation: None,
                        },
                        Fact::ToolResultAccepted {
                            tool,
                            result: acc.reference().clone(),
                            outcome: AcceptedResult::Succeeded,
                        },
                    ],
                    vec![out, acc],
                )
                .await
            }
        };

        let a1 = rig.attempt().await?;
        observe(a1, 0, TextKind::Thinking, " \n").await?;
        let (t1, _) = rig
            .tool(a1, "tool_search", "call-1", json!({"query":"1"}))
            .await?;
        observe(a1, 2, TextKind::Text, "Checking second.").await?;
        rig.finish_model_request(a1, None).await?;
        accept(t1).await?;

        let a2 = rig.attempt().await?;
        let (t2, _) = rig
            .tool(a2, "tool_search", "call-2", json!({"query":"2"}))
            .await?;
        observe(a2, 1, TextKind::Text, "Done.").await?;
        rig.finish_model_request(a2, None).await?;
        accept(t2).await?;

        let client = rig.client.as_ref().unwrap();
        let history = |through: Value, position: Value, view: &str| {
            call(
                client,
                "agent",
                "history",
                json!({
                    "sessionId": session, "through": through, "position": position,
                    "includeThinking": true, "view": view,
                }),
            )
        };
        let tail = history(Value::Null, json!({"kind":"tail"}), "chat").await?;
        let through = tail["through"].clone();
        let chunks = tail["chunks"].as_array().ok_or("missing chunks")?;
        let (g1, g2) = (&chunks[1], &chunks[3]);
        assert_ne!(
            g1["work"]["firstToolUseId"], g2["work"]["firstToolUseId"],
            "{tail}"
        );

        let before_g1 = history(
            through.clone(),
            json!({
                "kind": "before",
                "cursor": {"position": g1["position"], "field": g1["field"], "offset": 0},
            }),
            "chat",
        )
        .await?;
        assert_eq!(
            before_g1["chunks"].as_array().unwrap().len(),
            1,
            "{before_g1}"
        );
        assert!(before_g1["before"].is_null(), "{before_g1}");

        let before_g2 = history(
            through,
            json!({
                "kind": "before",
                "cursor": {"position": g2["position"], "field": g2["field"], "offset": 0},
            }),
            "chat",
        )
        .await?;
        assert_eq!(
            before_g2["chunks"].as_array().unwrap().len(),
            3,
            "{before_g2}"
        );
        assert_eq!(
            before_g2["chunks"][1]["position"], g1["position"],
            "{before_g2}"
        );
        Ok(())
    })
    .await;
    let errors = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    result??;
    assert!(errors.is_empty(), "cleanup: {errors:?}");
    Ok(())
}
