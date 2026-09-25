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
use maka_protocol::{Operation, session::decode_session_create_input};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::watch;

pub(super) struct Fixture {
    pub client: maka_client::Client,
    pub requests: Arc<AtomicUsize>,
    pub provider: tokio::task::JoinHandle<Value>,
    pub model: tokio::task::JoinHandle<()>,
}

pub(super) async fn start(root: &std::path::Path, workspace: &std::path::Path) -> Fixture {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let client = support::model_client(root, &url).await;
    let catalog = client
        .request(Operation::ConnectionCatalogQuery, json!({"kind":"start"}))
        .await
        .unwrap();
    let connection = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "connection")
        .unwrap();
    let updated = client.request(Operation::ConnectionCatalogUpdate, json!({
        "expected":{"connectionId":connection["connectionId"],"revision":connection["revision"]},
        "changes":{"name":"TUI fixture","configuration":{"baseUrl":url},"enabled":true,"enabledModelIds":["fixture-model"],
            "modelOverrides":{"fixture-model":{"contextWindow":128000,"codeMode":true}}}
    })).await.unwrap();
    assert_eq!(updated["kind"], "committed");
    client
        .create_session(
            decode_session_create_input(&json!({
                "sessionId":"tui-form","name":"Form keyboard fixture",
                "workspace":{"kind":"host_path","path":workspace},
                "modelTarget":{"kind":"default"},"sandboxMode":"danger-full-access"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let (answered, mut answer) = watch::channel(None::<Value>);
    let provider = provider(root, answered).await;
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let model = tokio::spawn(async move {
        for index in 1..10 {
            let (mut stream, body) = model_request(&listener).await;
            count.fetch_add(1, Ordering::SeqCst);
            let tool = |name, args: Value| {
                json!({"tool_calls":[{
                    "index":0,"id":format!("call-{index}"),"type":"function",
                    "function":{"name":name,"arguments":args.to_string()}
                }]})
            };
            let delta = match index {
                1 => {
                    assert!(
                        body["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|message| message["content"] == "Collect a form")
                    );
                    tool(
                        "exec",
                        json!({"code":"text(ALL_TOOLS.filter(t => t.name === \"mcp__tui_forms__collect\"));"}),
                    )
                }
                2 => tool(
                    "exec",
                    json!({"code":"text(await tools.mcp__tui_forms__collect({}));","yield_time_ms":1000}),
                ),
                _ => {
                    let result = answer
                        .wait_for(Option::is_some)
                        .await
                        .unwrap()
                        .clone()
                        .unwrap();
                    assert_eq!(
                        result,
                        json!({"action":"accept","values":{"name":"中文🦀","count":2.0,"enabled":false}})
                    );
                    let output = body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|message| message["role"] == "tool")
                        .unwrap()["content"]
                        .as_str()
                        .unwrap();
                    let last: Value = serde_json::from_str(output.lines().next().unwrap()).unwrap();
                    if last["state"] == "running" {
                        tool(
                            "wait",
                            json!({"cell_id":last["cell_id"],"yield_time_ms":1000}),
                        )
                    } else {
                        assert_eq!(last["state"], "completed", "{last}");
                        assert!(output.contains("中文🦀"), "{output}");
                        json!({"content":"Form received exactly once"})
                    }
                }
            };
            let done = delta.get("tool_calls").is_none();
            let frame = json!({"id":format!("form-{index}"),"object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":delta,"finish_reason":if done {"stop"} else {"tool_calls"}}]});
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            if done {
                return;
            }
        }
        panic!("form fixture exceeded its model request budget");
    });
    Fixture {
        client,
        requests,
        provider,
        model,
    }
}

/// A separate native capability producer owns the form; TUI only answers it.
async fn provider(
    root: &std::path::Path,
    answered: watch::Sender<Option<Value>>,
) -> tokio::task::JoinHandle<Value> {
    let discovery = maka_client::local::read_discovery(root).unwrap();
    let stream = maka_client::local::open_stream(&discovery.endpoint)
        .await
        .unwrap();
    let (mut reader, mut writer) =
        maka_transport::ndjson::split(stream, tokio_util::sync::CancellationToken::new());
    writer
        .write(
            &json!({"kind":"hello","clientInstanceId":"tui-form-producer",
        "protocolMin":0,"protocolMax":0,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,
        "compositionId":"maka.interactive"}),
        )
        .await
        .unwrap();
    let hello = reader.read().await.unwrap().unwrap();
    assert_eq!(hello["state"], "ready");
    assert_eq!(hello["rootId"], discovery.root_id);
    assert_eq!(hello["hostEpoch"], discovery.host_epoch);
    writer.write(&json!({"requestId":"publish","operation":"client.capability.replace","input":{
        "registrationId":"tui-form-producer","sessionId":"tui-form","offers":[{
            "offerId":"tui_forms","version":"1","affinity":"session","hostPathAccess":"none","label":"TUI forms",
            "tools":[{"serverId":"tui_forms","name":"collect","inputSchema":{"type":"object"}}]
        }]
    }})).await.unwrap();
    loop {
        let frame = reader.read().await.unwrap().unwrap();
        if frame["requestId"] == "publish" {
            assert_eq!(frame["ok"], true, "{frame}");
            break;
        }
        assert!(frame.get("requestId").is_none(), "{frame}");
    }
    tokio::spawn(async move {
        let mut invocation = None;
        let mut result = None;
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(30), reader.read())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let Some(kind) = frame["kind"]
                .as_str()
                .filter(|kind| maka_protocol::capability::is_host_frame_kind(kind))
            else {
                continue;
            };
            maka_protocol::capability::decode_host_frame(&frame).unwrap();
            match kind {
                "client.capability.call" => {
                    assert!(invocation.is_none(), "form called twice");
                    assert_eq!(frame["source"]["sessionId"], "tui-form");
                    assert_eq!(frame["toolName"], "collect");
                    invocation = Some(frame["invocationId"].clone());
                    writer.write(&json!({"kind":"client.capability.accepted","invocationId":invocation,"admissionEvidence":{"kind":"none"}})).await.unwrap();
                }
                "client.capability.admitted" => {
                    assert_eq!(Some(&frame["invocationId"]), invocation.as_ref());
                    writer.write(&json!({"kind":"client.capability.interaction_request","invocationId":invocation,"interactionId":"form",
                        "request":{"message":"Fill the isolated form","requester":{"name":"TUI form fixture"},"fields":[
                            {"name":"name","label":"Display name","kind":"string","required":true,"minLength":1,"maxLength":16},
                            {"name":"count","label":"Count","kind":"integer","required":true,"minimum":1,"maximum":3,"default":2},
                            {"name":"enabled","label":"Enabled","kind":"boolean","required":true,"default":false}
                        ]}})).await.unwrap();
                }
                "client.capability.interaction_result" => {
                    assert_eq!(Some(&frame["invocationId"]), invocation.as_ref());
                    assert_eq!(frame["interactionId"], "form");
                    assert!(result.is_none());
                    result = Some(frame["result"].clone());
                    answered.send(result.clone()).unwrap();
                    writer
                        .write(
                            &json!({"kind":"client.capability.result","invocationId":invocation,
                        "result":{"content":[{"type":"text","text":frame["result"].to_string()}]}}),
                        )
                        .await
                        .unwrap();
                }
                "client.capability.release" => {
                    assert_eq!(Some(&frame["invocationId"]), invocation.as_ref());
                    return result.expect("release after form outcome");
                }
                _ => panic!("unexpected capability frame {frame}"),
            }
        }
    })
}
