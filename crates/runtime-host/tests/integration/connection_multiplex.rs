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

#![cfg(unix)]

use crate::support::execution_fixture;
use maka_event_log::root::RootOwner;
use maka_runtime_host::server::local::LocalListener;
use maka_transport::{MessageReader, MessageWriter, TransportError};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Reader {
    frames: mpsc::UnboundedReceiver<Value>,
    eof: CancellationToken,
}
impl MessageReader for Reader {
    async fn read(&mut self) -> Result<Option<Value>, TransportError> {
        let frame = self.frames.recv().await;
        if frame.is_none() {
            self.eof.cancel();
        }
        Ok(frame)
    }
}
struct Writer {
    frames: mpsc::UnboundedSender<Value>,
    blocked: CancellationToken,
    eof: CancellationToken,
}
impl MessageWriter for Writer {
    async fn write(&mut self, value: &Value) -> Result<(), TransportError> {
        if value["requestId"] == "host.status" {
            self.blocked.cancel();
            self.eof.cancelled().await;
        }
        self.frames
            .send(value.clone())
            .map_err(|_| TransportError::Closed)
    }
    async fn close_after_flush(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}
fn request(operation: &str, input: Value) -> Value {
    json!({"requestId":operation,"operation":operation,"input":input})
}
async fn receive(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .expect("connection closed before its admitted reply")
}
async fn response(frames: &mut mpsc::UnboundedReceiver<Value>, id: &str) -> Value {
    loop {
        let frame = receive(frames).await;
        if frame["requestId"] == id {
            return frame;
        }
        assert!(frame.get("requestId").is_none(), "{frame}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_rpc_allows_same_connection_status_and_flushes_after_input_eof() {
    let (directory, ns, root, provider, host) = execution_fixture::fixture().await;
    let eof = CancellationToken::new();
    let arrived = CancellationToken::new();
    let provider = tokio::net::TcpListener::from_std(provider).unwrap();
    let provider_task = tokio::spawn({
        let (eof, arrived) = (eof.clone(), arrived.clone());
        async move {
            let (socket, _) = provider.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            assert_eq!(line, "POST /v1/chat/completions HTTP/1.1\r\n");
            let mut length = None;
            loop {
                line.clear();
                assert!(socket.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut body = vec![0; length.unwrap()];
            socket.read_exact(&mut body).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["model"],
                "fixture-model"
            );
            arrived.cancel();
            // No timer completes the HTTP request: the host must read through
            // the pending RPC to EOF before the provider can return.
            tokio::time::timeout(Duration::from_secs(5), eof.cancelled())
                .await
                .unwrap();
            socket
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            socket.get_mut().shutdown().await.unwrap();
        }
    });
    let (requests, frames) = mpsc::unbounded_channel();
    let (writer, mut replies) = mpsc::unbounded_channel();
    let blocked = CancellationToken::new();
    let writer = Writer {
        frames: writer,
        blocked: blocked.clone(),
        eof: eof.clone(),
    };
    let connection = tokio::spawn(
        host.clone()
            .local_owner_connection(Reader { frames, eof }, writer),
    );
    requests
        .send(
            json!({"kind":"hello","clientInstanceId":"half-close-test",        "protocolMin":0,"protocolMax":0,
        "compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,"compositionId":"maka.interactive"}),
        )
        .unwrap();
    assert_eq!(receive(&mut replies).await["state"], "ready");
    // Buffered immediate replies must give the joined writer a turn, including
    // the protocol's 65th liveness slot. No peer pacing hides queue starvation.
    for index in 0..65 {
        requests
            .send(json!({"requestId":format!("burst-{index}"),
            "operation":"host.status","input":{}}))
            .unwrap();
    }
    let mut seen = std::collections::HashSet::new();
    while seen.len() < 65 {
        let frame = receive(&mut replies).await;
        if matches!(
            frame["kind"].as_str(),
            Some(
                "plugin.client.changed"
                    | "session.catalog.changed"
                    | "plugin.terminal.changed"
                    | "plugin.platform.changed"
                    | "model.provider.catalog.changed"
            )
        ) {
            continue;
        }
        assert_eq!(frame["result"]["state"], "ready", "{frame}");
        assert!(seen.insert(frame["requestId"].as_str().unwrap().to_owned()));
    }
    requests
        .send(request("connection.catalog.query", json!({"kind":"start"})))
        .unwrap();
    let catalog = response(&mut replies, "connection.catalog.query").await;
    let id = &catalog["result"]["items"][0]["connectionId"];
    assert!(id.is_string(), "{catalog}");
    requests
        .send(request(
            "connection.test.run",
            json!({"connectionId":id,"modelId":null}),
        ))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), arrived.cancelled())
        .await
        .unwrap();
    requests.send(request("host.status", json!({}))).unwrap();
    tokio::time::timeout(Duration::from_secs(5), blocked.cancelled())
        .await
        .unwrap();
    // The writer has entered real transport backpressure. Reading EOF must
    // still progress; it releases both this write and the held HTTP request.
    drop(requests);
    assert_eq!(
        response(&mut replies, "host.status").await["result"]["state"],
        "ready"
    );
    let completed = response(&mut replies, "connection.test.run").await;
    assert_eq!(completed["result"]["kind"], "committed", "{completed}");
    assert_eq!(completed["result"]["test"]["kind"], "verified");
    tokio::time::timeout(Duration::from_secs(5), connection)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    provider_task.await.unwrap();
    assert!(replies.recv().await.is_none());
    // Wait for the existing Host shutdown path, including both database owners;
    // dropping the last sender alone does not acknowledge their thread cleanup.
    let shutdown = CancellationToken::new();
    shutdown.cancel();
    LocalListener::bind(&directory.path().join("h.sock"))
        .unwrap()
        .serve(host, shutdown)
        .await
        .unwrap();
    let _owner = RootOwner::open(&root, &ns).unwrap();
}
