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

use super::{provider::ModelRequest, support};
use maka_agent_facts::configuration::ModelOverride;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf},
    sync::mpsc,
};

const SERVER: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../plugins/agent/mcp/tests/server.mjs"
));

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v1_stdio_mcp_calls_require_approval_and_stay_in_their_session() {
    let fixture = support::Fixture::with_model_override(ModelOverride {
        code_mode: Some(true),
        ..Default::default()
    })
    .await;
    tokio::time::timeout(Duration::from_secs(40), mcp(fixture, 1))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_http_mcp_calls_require_approval_and_stay_in_their_session() {
    let fixture = support::Fixture::with_model_override(ModelOverride {
        code_mode: Some(true),
        ..Default::default()
    })
    .await;
    tokio::time::timeout(Duration::from_secs(40), mcp(fixture, 2))
        .await
        .unwrap();
}

async fn mcp(mut fixture: support::Fixture, version: u64) {
    let script = fixture._root.path().join("server.mjs");
    tokio::fs::write(&script, SERVER).await.unwrap();
    let record = fixture._root.path().join("calls.jsonl");
    let node = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let mut http = None;
    let server = if version == 1 {
        json!({"name":"fixture","command":node,"args":[script,"environment",record],
            "env":[{"name":"MCP_EXPLICIT","value":"session-token"}]})
    } else {
        let mut child = tokio::process::Command::new(&node)
            .arg(&script)
            .arg("http")
            .arg(&record)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        let url = loop {
            match tokio::fs::read_to_string(record.with_extension("jsonl.url")).await {
                Ok(url) => break url,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("{error}"),
            }
            tokio::select! {
                _ = tick.tick() => {}
                result = child.wait() => panic!("HTTP fixture exited: {result:?}"),
            }
        };
        http = Some(child);
        json!({"type":"http","name":"fixture","url":url,
            "headers":[{"name":"Authorization","value":"Bearer session-token"}]})
    };
    let (mut wire, serving) = Wire::open(fixture.client, version).await;
    let mut invalid = server.clone();
    invalid["type"] = json!("unsupported");
    let rejected = wire
        .send(
            "session/new",
            json!({"cwd":fixture.workspace,"mcpServers":[invalid]}),
        )
        .await;
    let error = wire.read().await;
    assert_eq!(error["id"], rejected);
    assert_eq!(error["error"]["code"], -32602);
    let created = wire
        .call(
            "session/new",
            json!({"cwd":fixture.workspace,"mcpServers":[server]}),
        )
        .await;
    let session = created["sessionId"].as_str().unwrap();
    let separate = wire
        .call(
            "session/new",
            json!({"cwd":fixture.workspace,"mcpServers":[]}),
        )
        .await;
    let separate = separate["sessionId"].as_str().unwrap();
    for id in [session, separate] {
        let mut config =
            json!({"sessionId":id,"configId":"sandbox_mode","value":"workspace_write"});
        if version == 2 {
            config["type"] = json!("id");
        }
        wire.call("session/set_config_option", config).await;
    }

    turn(
        &mut wire,
        &mut fixture.model_requests,
        session,
        version,
        Some("session-a"),
    )
    .await;
    turn(
        &mut wire,
        &mut fixture.model_requests,
        separate,
        version,
        None,
    )
    .await;
    wire.updates.clear();
    wire.call(
        if version == 1 {
            "session/load"
        } else {
            "session/resume"
        },
        json!({"sessionId":session,"cwd":fixture.workspace,"mcpServers":[]}),
    )
    .await;
    if version == 1 {
        let text: String = wire
            .updates
            .iter()
            .filter(|update| update["sessionUpdate"] == "agent_message_chunk")
            .map(|update| update["content"]["text"].as_str().unwrap())
            .collect();
        assert_eq!(text, "MCP result received.");
    }
    turn(
        &mut wire,
        &mut fixture.model_requests,
        session,
        version,
        None,
    )
    .await;
    let events: Vec<Value> = tokio::fs::read_to_string(&record)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let calls: Vec<_> = events
        .iter()
        .filter(|event| event["method"] == "tools/call")
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["params"]["name"], "echo");
    assert_eq!(
        calls[0]["params"]["arguments"],
        json!({"marker":"session-a"})
    );
    if version == 1 {
        assert_eq!(
            events
                .iter()
                .find_map(|event| event.pointer("/environment/explicit"))
                .unwrap(),
            "session-token"
        );
    } else {
        assert!(
            events
                .iter()
                .any(|event| event["authorization"] == "Bearer session-token")
        );
    }
    drop(wire);
    serving.await.unwrap().unwrap();
    if let Some(mut child) = http {
        child.kill().await.unwrap();
    }
    fixture.native.close().await.unwrap();
    fixture.stop.cancel();
    fixture.server.await.unwrap().unwrap();
}

async fn turn(
    wire: &mut Wire,
    requests: &mut mpsc::Receiver<ModelRequest>,
    session: &str,
    version: u64,
    marker: Option<&str>,
) {
    let id = wire
        .send(
            "session/prompt",
            json!({"sessionId":session,"prompt":[{"type":"text","text":"Use the session tool."}]}),
        )
        .await;
    let mut steps = 0;
    let mut approvals = 0;
    loop {
        tokio::select! {
            request = requests.recv() => {
                let request = request.unwrap();
                let tool_result = || request.body["messages"].as_array().unwrap().iter()
                    .rev().find(|message| message["role"] == "tool").unwrap()["content"].as_str().unwrap();
                let call = match steps {
                    0 => {
                        assert!(request.body["tools"].as_array().unwrap().iter()
                            .any(|tool| tool["function"]["name"] == "exec"));
                        let code = match marker {
                            Some(marker) => format!("const r = await tools.mcp__fixture__echo({{marker:{}}}); text(r.structuredContent);", json!(marker)),
                            None => "try { await tools.mcp__fixture__echo({marker:'forbidden'}); text({unavailable:false}); } catch { text({unavailable:true}); }".into(),
                        };
                        Some(("exec", json!({"code":code})))
                    }
                    1 => {
                        let result: Value = serde_json::from_str(tool_result().lines().last().unwrap()).unwrap();
                        let expected = match marker {
                            Some(marker) => json!({"marker":marker}),
                            None => json!({"unavailable":true}),
                        };
                        assert_eq!(result, expected);
                        None
                    }
                    _ => panic!("unexpected model request: {}", request.body),
                };
                let reply = match call {
                    Some((name, arguments)) => json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("call-{steps}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":"tool_calls"}),
                    None => json!({"index":0,"delta":{"content":"MCP result received."},"finish_reason":"stop"}),
                };
                request.reply.send(reply).unwrap();
                steps += 1;
            }
            frame = wire.read() => {
                if frame["method"] == "session/request_permission" {
                    approvals += 1;
                    assert!(marker.is_some(), "a separate session requested the MCP tool");
                    let option = frame["params"]["options"].as_array().unwrap().iter()
                        .find(|option| option["kind"] == "allow_once").unwrap();
                    wire.write(json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":{"outcome":"selected","optionId":option["optionId"]}}})).await;
                } else if frame["id"] == id && frame.get("method").is_none() {
                    assert!(frame.get("error").is_none(), "{frame}");
                    if version == 1 {
                        assert_eq!(frame["result"]["stopReason"], "end_turn");
                        break;
                    }
                    assert!(frame["result"]["messageId"].is_string());
                } else {
                    wire.update(&frame);
                    if version == 2 && frame["params"]["update"]["stopReason"] == "end_turn" { break; }
                }
            }
        }
    }
    assert_eq!(steps, 2);
    assert_eq!(approvals, usize::from(marker.is_some()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v1_cancel_settles_the_run_and_rejects_a_second_prompt() {
    let mut fixture = support::Fixture::open().await;
    tokio::time::timeout(Duration::from_secs(40), async {
        let (mut wire, serving) = Wire::open(fixture.client, 1).await;
        let session = fixture.session.clone();
        wire.call("session/load", json!({"sessionId":session,"cwd":fixture.workspace,"mcpServers":[]})).await;
        let id = wire.send("session/prompt", json!({"sessionId":session,"prompt":[{"type":"text","text":"Wait for cancellation."}]})).await;
        let request = tokio::select! {
            request = fixture.model_requests.recv() => request.unwrap(),
            frame = wire.read() => {
                assert_eq!(frame["method"], "session/update", "v1 prompt completed before the model: {frame}");
                fixture.model_requests.recv().await.unwrap()
            }
        };
        let run = support::query(&fixture.native, "agent", "observe", json!({"sessionId":session})).await;
        wire.write(json!({"jsonrpc":"2.0","id":100,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"Must not be inserted."}]}})).await;
        loop {
            let frame = wire.read().await;
            if frame["id"] == 100 {
                assert_eq!(frame["error"]["code"], -32602);
                break;
            }
            wire.update(&frame);
        }
        wire.write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}})).await;
        loop {
            let frame = wire.read().await;
            if frame["id"] == id {
                assert_eq!(frame["result"], json!({"stopReason":"cancelled"}));
                break;
            }
            wire.update(&frame);
        }
        let execution = support::query(&fixture.native,"agent","execution",json!({"sessionId":session,"invocationId":run["run"]["invocationId"]})).await;
        assert_eq!(execution["execution"]["state"], "cancelled");
        let history = support::canonical(&fixture.native, &session).await;
        let users: Vec<_> = history.iter().filter(|row| row.role == maka_agent_ports::session::history::Role::User).map(|row| row.text.as_str()).collect();
        assert_eq!(users, ["Wait for cancellation."]);
        drop(request);
        wire.call("session/load", json!({"sessionId":session,"cwd":fixture.workspace,"mcpServers":[]})).await;
        drop(wire);
        serving.await.unwrap().unwrap();
        fixture.native.close().await.unwrap();
        fixture.stop.cancel();
        fixture.server.await.unwrap().unwrap();
    }).await.unwrap();
}

struct Wire {
    input: Lines<BufReader<ReadHalf<DuplexStream>>>,
    output: WriteHalf<DuplexStream>,
    id: u64,
    updates: Vec<Value>,
}

impl Wire {
    async fn open(
        client: maka_host_runtime::application::host::Client,
        version: u64,
    ) -> (Self, tokio::task::JoinHandle<Result<(), maka_acp::Error>>) {
        let (client_io, agent) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(agent);
        let serving = tokio::spawn(maka_acp::serve(
            client,
            read,
            write,
            tokio_util::sync::CancellationToken::new(),
        ));
        let (read, output) = tokio::io::split(client_io);
        let mut wire = Self {
            input: BufReader::new(read).lines(),
            output,
            id: 0,
            updates: Vec::new(),
        };
        let init = if version == 1 {
            json!({"protocolVersion":1,"clientCapabilities":{}})
        } else {
            json!({"protocolVersion":2,"info":{"name":"protocol-test","version":"1"},"capabilities":{}})
        };
        assert_eq!(
            wire.call("initialize", init).await["protocolVersion"],
            version
        );
        (wire, serving)
    }
    async fn write(&mut self, value: Value) {
        self.output
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
        self.output.flush().await.unwrap();
    }
    async fn send(&mut self, method: &str, params: Value) -> u64 {
        self.id += 1;
        self.write(json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))
            .await;
        self.id
    }
    async fn read(&mut self) -> Value {
        serde_json::from_str(
            &self
                .input
                .next_line()
                .await
                .unwrap()
                .expect("ACP closed before completion"),
        )
        .unwrap()
    }
    fn update(&mut self, frame: &Value) {
        assert_eq!(frame["method"], "session/update", "{frame}");
        self.updates.push(frame["params"]["update"].clone());
    }
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        loop {
            let frame = self.read().await;
            if frame["id"] == id && frame.get("method").is_none() {
                assert!(frame.get("error").is_none(), "{method}: {frame}");
                return frame["result"].clone();
            }
            self.update(&frame);
        }
    }
}
