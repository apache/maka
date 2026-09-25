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
use maka_protocol::{
    Operation, configuration::ConnectionCatalogQueryInput, session::decode_session_create_input,
};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn host_inherits_proxy_for_model_discovery_and_tui_turn_without_manual_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let proxy = format!(
        "http://proxy-user:proxy-secret@{}",
        listener.local_addr().unwrap()
    );
    let mut host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
    let mut command = Command::new(env!("CARGO_BIN_EXE_maka"));
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "REQUEST_METHOD",
    ] {
        command.env_remove(name);
    }
    host.child = Some(
        command
            .args(["host", "serve", "--root"])
            .arg(&host.root)
            .env("http_proxy", proxy)
            .env("https_proxy", "http://127.0.0.1:9")
            .env("NO_PROXY", "localhost,127.0.0.1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    host.wait_for_registration();
    let (client, server) = runtime.block_on(async {
        let client = support::model_client(&host.root, "http://models.maka.invalid/v1").await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"proxy-fixture", "name":"Environment proxy fixture",
            "workspace":{"kind":"host_path","path":directory.path()}, "sandboxMode":"read-only",
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let server = tokio::spawn(async move {
            for path in ["models", "chat/completions"] {
                let (mut stream, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept()).await.unwrap().unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    assert!(head.len() < 16 * 1024);
                    head.push(stream.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap().to_lowercase();
                assert!(head.starts_with(&format!("{} http://models.maka.invalid/v1/{path} ", if path == "models" { "get" } else { "post" })));
                assert!(head.contains("proxy-authorization: basic "));
                assert!(head.contains("authorization: bearer dummy-local-fixture"));
                if path == "models" {
                    support::json_response(stream, "200 OK", json!({"data":[{"id":"fixture-model"}]})).await;
                } else {
                    let length = head.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse::<usize>().unwrap();
                    let mut body = vec![0; length];
                    stream.read_exact(&mut body).await.unwrap();
                    assert!(String::from_utf8(body).unwrap().contains("hello through inherited proxy"));
                    let frame = json!({"id":"proxy-fixture","object":"chat.completion.chunk","model":"fixture-model",
                        "choices":[{"index":0,"delta":{"content":"Inherited proxy works"},"finish_reason":"stop"}]});
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
                }
            }
        });
        let page = client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        let id = &page["items"].as_array().unwrap().iter().find(|item| item["kind"] == "connection").unwrap()["connectionId"];
        let result = client.request(Operation::ConnectionModelsFetch, json!({"connectionId":id})).await.unwrap();
        assert_eq!(result["kind"], "committed");
        (client, server)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Environment proxy");
    tui.click_text("Environment proxy");
    tui.wait_for("Message…");
    tui.send(b"hello through inherited proxy\r");
    tui.wait_for("Inherited proxy works");
    runtime.block_on(server).unwrap();
    assert!(!String::from_utf8_lossy(&tui.output).contains("proxy-secret"));
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
