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
use agent_client_protocol::schema::ProtocolVersion;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf},
    sync::mpsc,
};

const SECRET: &str = "LODY_CLIENT_MCP_EPHEMERAL_SECRET";
const SERVER: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../plugins/agent/mcp/tests/server.mjs"
));

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v1_stdio_mcp_is_approved_session_scoped_and_replaced_on_load() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(
        Duration::from_secs(40),
        scenario(fixture, ProtocolVersion::V1, Transport::Stdio),
    )
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_http_mcp_keeps_headers_ephemeral_and_reconnects_on_resume() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(
        Duration::from_secs(40),
        scenario(fixture, ProtocolVersion::V2, Transport::Http),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v1_http_mcp_accepts_lody_headers_and_reconnects_on_load() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(
        Duration::from_secs(40),
        scenario(fixture, ProtocolVersion::V1, Transport::Http),
    )
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_stdio_mcp_is_replaced_on_resume_and_reaped_on_disconnect() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(
        Duration::from_secs(40),
        scenario(fixture, ProtocolVersion::V2, Transport::Stdio),
    )
    .await
    .unwrap();
}
#[derive(Clone, Copy)]
enum Transport {
    Stdio,
    Http,
}

async fn scenario(mut fixture: support::Fixture, version: ProtocolVersion, transport: Transport) {
    let node = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(node.status.success());
    let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let script = fixture._root.path().join("mcp-server.mjs");
    tokio::fs::write(&script, SERVER).await.unwrap();
    let record = fixture._root.path().join("mcp-record.jsonl");
    let mut http = None;
    let mut server = if matches!(transport, Transport::Stdio) {
        json!({"name":"lody","command":node,"args":[script,"environment",record],"env":[{"name":"MCP_EXPLICIT","value":SECRET}]})
    } else {
        let mut child = tokio::process::Command::new(&node)
            .arg(&script)
            .arg("http")
            .arg(&record)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let url_file = record.with_extension("jsonl.url");
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        let url = loop {
            match tokio::fs::read_to_string(&url_file).await {
                Ok(url) => break url,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("MCP HTTP fixture: {error}"),
            }
            tokio::select! { _ = tick.tick() => {}, result = child.wait() => panic!("MCP HTTP fixture exited: {result:?}") }
        };
        http = Some(child);
        json!({"type":"http","name":"lody","url":url,"headers":[{"name":"Authorization","value":SECRET}]})
    };
    if matches!(transport, Transport::Stdio) && version == ProtocolVersion::V2 {
        server["type"] = json!("stdio");
    }
    let (client, agent) = tokio::io::duplex(64 * 1024);
    let (read, write) = tokio::io::split(agent);
    let serving = tokio::spawn(async move {
        maka_acp::serve(
            fixture.client,
            read,
            write,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("ACP server failed: {error}"));
    });
    let (read, write) = tokio::io::split(client);
    let mut wire = Wire {
        input: BufReader::new(read).lines(),
        output: write,
        id: 0,
        permissions: 0,
        last_method: String::new(),
    };
    let init = if version == ProtocolVersion::V1 {
        json!({"protocolVersion":1,"clientCapabilities":{}})
    } else {
        json!({"protocolVersion":2,"info":{"name":"lody-compatible","version":"1"},"capabilities":{}})
    };
    let initialized = wire.call("initialize", init).await;
    if version == ProtocolVersion::V1 {
        assert_eq!(
            initialized["agentCapabilities"]["mcpCapabilities"]["http"],
            true
        );
    } else {
        assert!(initialized["capabilities"]["session"]["mcp"]["stdio"].is_object());
        assert!(initialized["capabilities"]["session"]["mcp"]["http"].is_object());
    }
    let created = wire
        .call(
            "session/new",
            json!({"cwd":fixture.workspace,"mcpServers":[server.clone()]}),
        )
        .await;
    let session = created["sessionId"].as_str().unwrap().to_owned();
    let mut config =
        json!({"sessionId":session,"configId":"sandbox_mode","value":"workspace_write"});
    if version == ProtocolVersion::V2 {
        config["type"] = json!("id");
    }
    wire.call("session/set_config_option", config).await;
    let separate = wire
        .call(
            "session/new",
            json!({"cwd":fixture.workspace,"mcpServers":[]}),
        )
        .await;
    let separate = separate["sessionId"].as_str().unwrap();
    turn(
        &mut wire,
        &mut fixture.model_requests,
        separate,
        version,
        false,
    )
    .await;
    turn(
        &mut wire,
        &mut fixture.model_requests,
        &session,
        version,
        true,
    )
    .await;
    assert_eq!(
        wire.permissions, 1,
        "client MCP must use the ordinary Host approval path"
    );
    let before = records(&record).await;
    let first_pid = before[0]["pid"].as_i64().unwrap();
    let calls: Vec<_> = before
        .iter()
        .filter(|event| event["method"] == "tools/call")
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["params"]["arguments"]["marker"],
        "LODY_MCP_CONNECTED"
    );
    if matches!(transport, Transport::Stdio) {
        assert!(
            before
                .iter()
                .any(|event| event["environment"]["explicit"] == SECRET)
        );
    } else {
        assert!(before.iter().any(|event| event["authorization"] == SECRET));
    }
    let method = if version == ProtocolVersion::V1 {
        "session/load"
    } else {
        "session/resume"
    };
    wire.call(
        method,
        json!({"sessionId":session,"cwd":fixture.workspace,"mcpServers":[server]}),
    )
    .await;
    if matches!(transport, Transport::Stdio) {
        assert_stopped(first_pid);
        assert_eq!(
            records(&record)
                .await
                .iter()
                .filter(|event| event["pid"].is_number())
                .count(),
            2
        );
    } else {
        assert_eq!(
            records(&record)
                .await
                .iter()
                .filter(|event| event["method"] == "initialize")
                .count(),
            2
        );
    }
    assert_not_persisted(fixture._root.path()).await;
    drop(wire);
    serving.await.unwrap();
    if matches!(transport, Transport::Stdio) {
        for event in records(&record).await {
            if let Some(pid) = event["pid"].as_i64() {
                assert_stopped(pid);
            }
        }
    }
    if let Some(mut http) = http {
        http.kill().await.unwrap();
    }
    fixture.native.close().await.unwrap();
    fixture.stop.cancel();
    fixture.server.await.unwrap().unwrap();
}

async fn turn(
    wire: &mut Wire,
    requests: &mut mpsc::Receiver<ModelRequest>,
    session: &str,
    version: ProtocolVersion,
    tools: bool,
) {
    let id = wire.send("session/prompt", json!({"sessionId":session,"prompt":[{"type":"text","text":"Check the MCP connection."}]})).await;
    let mut steps = 0;
    let mut complete = false;
    while !complete {
        tokio::select! {
            request = requests.recv() => {
                let request = request.unwrap();
                let available = |name| request.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == name);
                let last_tool = || request.body["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "tool").unwrap()["content"].to_string();
                let call = if steps == 0 {
                    assert!(available("tool_search"), "the real product must retain discovery");
                    Some(("tool_search",json!({"query":"mcp__lody__echo"})))
                } else if steps == 1 {
                    assert_eq!(last_tool().contains("mcp__lody__echo"),tools,"client MCP must belong to this session only");
                    if tools {
                        if available("mcp__lody__echo") { Some(("mcp__lody__echo",json!({"marker":"LODY_MCP_CONNECTED"}))) }
                        else {
                            assert!(available("exec"),"discovered MCP must be callable directly or through Code Mode");
                            Some(("exec",json!({"code":"const r = await tools.mcp__lody__echo({marker:'LODY_MCP_CONNECTED'}); text(r.structuredContent);"})))
                        }
                    } else { None }
                } else {
                    assert!(last_tool().contains("LODY_MCP_CONNECTED"),"model must receive the real MCP result: {}",request.body);
                    None
                };
                let choice = if let Some((name,arguments)) = call {
                    json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("mcp-call-{steps}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":"tool_calls"})
                } else { json!({"index":0,"delta":{"content":"MCP connected."},"finish_reason":"stop"}) };
                request.reply.send(choice).unwrap();
                steps += 1;
            }
            value = wire.read() => {
                if value["id"] == id && value.get("method").is_none() {
                    assert!(value.get("error").is_none(),"{value}");
                    if version == ProtocolVersion::V1 { assert_eq!(value["result"]["stopReason"],"end_turn"); complete = true; }
                    else { assert!(value["result"]["messageId"].is_string()); }
                } else {
                    if version == ProtocolVersion::V2 && value["params"]["update"]["sessionUpdate"] == "state_update" && value["params"]["update"]["stopReason"] == "end_turn" { complete = true; }
                    wire.handle(value).await;
                }
            }
        }
    }
    assert_eq!(steps, if tools { 3 } else { 2 });
}
struct Wire {
    input: Lines<BufReader<ReadHalf<DuplexStream>>>,
    output: WriteHalf<DuplexStream>,
    id: u64,
    permissions: usize,
    last_method: String,
}
impl Wire {
    async fn write(&mut self, value: Value) {
        self.output
            .write_all(serde_json::to_string(&value).unwrap().as_bytes())
            .await
            .unwrap();
        self.output.write_all(b"\n").await.unwrap();
        self.output.flush().await.unwrap();
    }
    async fn send(&mut self, method: &str, params: Value) -> u64 {
        self.id += 1;
        self.last_method = method.to_owned();
        self.write(json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))
            .await;
        self.id
    }
    async fn read(&mut self) -> Value {
        let line =
            self.input.next_line().await.unwrap().unwrap_or_else(|| {
                panic!("ACP closed during {} (id {})", self.last_method, self.id)
            });
        serde_json::from_str(&line).unwrap()
    }
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        loop {
            let value = self.read().await;
            if value["id"] == id && value.get("method").is_none() {
                assert!(value.get("error").is_none(), "{method}: {value}");
                return value["result"].clone();
            }
            self.handle(value).await;
        }
    }
    async fn handle(&mut self, value: Value) {
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            if value.get("id").is_some() {
                assert_eq!(method, "session/request_permission");
                let option = value["params"]["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|option| option["kind"] == "allow_once")
                    .unwrap();
                self.permissions += 1;
                self.write(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":option["optionId"]}}})).await;
            } else {
                assert_eq!(method, "session/update");
            }
        } else {
            panic!("unexpected ACP frame: {value}");
        }
    }
}
async fn records(path: &Path) -> Vec<Value> {
    tokio::fs::read_to_string(path)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn assert_stopped(pid: i64) {
    #[cfg(unix)]
    {
        // SAFETY: signal zero only checks the captured fixture PID; no pointers are passed.
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "MCP child {pid} survived confirmed cleanup"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    #[cfg(not(unix))]
    let _ = pid;
}
async fn assert_not_persisted(root: &Path) {
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        let mut entries = tokio::fs::read_dir(directory).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            if entry.file_type().await.unwrap().is_dir() {
                pending.push(entry.path());
            } else if entry.file_name().to_string_lossy().contains(".sqlite") {
                let bytes = tokio::fs::read(entry.path()).await.unwrap();
                assert!(
                    !bytes
                        .windows(SECRET.len())
                        .any(|window| window == SECRET.as_bytes()),
                    "client MCP secret was persisted to {}",
                    entry.path().display()
                );
            }
        }
    }
}
