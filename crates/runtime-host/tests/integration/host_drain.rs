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

use maka_event_log::{
    EventLog,
    root::{ROOT_DATABASE, RootNamespaces, RootOwner},
};
use maka_protocol::session::SandboxMode;
use maka_runtime_host::server::{Host, local::LocalListener};
use maka_runtime_host::session::{PreparedSession, SessionModel};
use maka_transport::{MessageReader, MessageWriter, TransportError};
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Reader(mpsc::UnboundedReceiver<Value>);
impl MessageReader for Reader {
    async fn read(&mut self) -> Result<Option<Value>, TransportError> {
        Ok(self.0.recv().await)
    }
}
struct Writer {
    frames: mpsc::UnboundedSender<Value>,
    gate: Option<(CancellationToken, CancellationToken)>,
    fail: bool,
}
impl MessageWriter for Writer {
    async fn write(&mut self, value: &Value) -> Result<(), TransportError> {
        if matches!(
            value["kind"].as_str(),
            Some(
                "plugin.client.changed"
                    | "plugin.terminal.changed"
                    | "model.provider.catalog.changed"
            )
        ) {
            return Ok(());
        }
        if value.get("requestId").is_some()
            && let Some((entered, release)) = &self.gate
        {
            entered.cancel();
            release.cancelled().await;
            if self.fail {
                return Err(TransportError::Closed);
            }
        }
        self.frames
            .send(value.clone())
            .map_err(|_| TransportError::Closed)
    }
    async fn close_after_flush(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}
fn hello() -> Value {
    json!({"kind":"hello", "clientInstanceId":"drain-test",         "protocolMin":0, "protocolMax":0,
        "compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH, "compositionId":"maka.interactive"})
}
fn request(operation: &str, input: Value) -> Value {
    json!({"requestId":operation, "operation":operation, "input":input})
}
async fn receive(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .unwrap()
}

async fn receive_response(reader: &mut impl MessageReader) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = reader.read().await.unwrap().unwrap();
            if !matches!(
                frame["kind"].as_str(),
                Some(
                    "plugin.client.changed"
                        | "plugin.terminal.changed"
                        | "model.provider.catalog.changed"
                )
            ) {
                return frame;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_commit_gates_admission_until_response_flush_then_releases_root() {
    exercise(false, Fault::Session).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_commit_failed_response_still_drains_and_releases_root() {
    exercise(true, Fault::Session).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_mutation_commit_unknown_drains_before_root_release_and_recovers() {
    for fail_write in [false, true] {
        exercise(fail_write, Fault::Catalog).await;
    }
}

#[path = "host_drain/fault.rs"]
mod fault;
use fault::Fault;

async fn exercise(fail_write: bool, fault: Fault) {
    let directory = tempfile::Builder::new()
        .prefix("maka-drain-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in("/tmp")
        .unwrap();
    let ns = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let root = directory.path().join("root");
    let owner = RootOwner::create(&root, &ns).unwrap();
    let log = EventLog::open(&root.join(ROOT_DATABASE)).await.unwrap();
    let prepared = PreparedSession::new(
        serde_json::from_value(json!({
            "sessionId":"session", "workspace":{"kind":"host_path","path":"/tmp"},
            "modelTarget":{"kind":"default"}
        }))
        .unwrap(),
    )
    .unwrap();
    let configuration = prepared.bind(
        maka_protocol::session::WorkspaceProjection {
            target: maka_protocol::session::WorkspaceTarget::HostPath {
                path: "/tmp".into(),
            },
            host_cwd: "/tmp".into(),
        },
        SessionModel {
            connection_id: "connection".into(),
            connection_slug: "connection".into(),
            model: "model".into(),
        },
        SandboxMode::ReadOnly,
    );
    log.create_session("session", "fingerprint", &configuration, 1)
        .await
        .unwrap();
    log.shutdown().await.unwrap();
    drop(log);
    let host = Host::open(owner).await.unwrap();
    let (operation, input, error_code) = fault::inject(&root, fault).await;

    let socket_path = directory.path().join("h.sock");
    let listener = LocalListener::bind(&socket_path).unwrap();
    let mut server = tokio::spawn(listener.serve(host.clone(), CancellationToken::new()));
    let socket = tokio::net::UnixStream::connect(&socket_path).await.unwrap();
    let (mut live_reader, mut live_writer) =
        maka_transport::ndjson::split(socket, CancellationToken::new());
    live_writer.write(&hello()).await.unwrap();
    live_reader.read().await.unwrap().unwrap();
    // This ordinary request is already admitted when the later fatal request
    // starts. Its independent flush must remain resident through host drain.
    let prior_entered = CancellationToken::new();
    let prior_release = CancellationToken::new();
    let (prior_requests, reader) = mpsc::unbounded_channel();
    let (frames, mut prior_responses) = mpsc::unbounded_channel();
    let prior = tokio::spawn(host.clone().local_owner_connection(
        Reader(reader),
        Writer {
            frames,
            gate: Some((prior_entered.clone(), prior_release.clone())),
            fail: false,
        },
    ));
    prior_requests.send(hello()).unwrap();
    receive(&mut prior_responses).await;
    prior_requests
        .send(request("host.status", json!({})))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), prior_entered.cancelled())
        .await
        .unwrap();
    let entered = CancellationToken::new();
    let release = CancellationToken::new();
    let (requests, reader) = mpsc::unbounded_channel();
    let (frames, mut responses) = mpsc::unbounded_channel();
    let connection = tokio::spawn(host.clone().local_owner_connection(
        Reader(reader),
        Writer {
            frames,
            gate: Some((entered.clone(), release.clone())),
            fail: fail_write,
        },
    ));
    requests.send(hello()).unwrap();
    assert_eq!(receive(&mut responses).await["state"], "ready");
    requests.send(request(operation, input)).unwrap();
    tokio::time::timeout(Duration::from_secs(5), entered.cancelled())
        .await
        .unwrap();
    assert!(
        !server.is_finished(),
        "listener must preserve fatal response write"
    );
    assert!(
        responses.try_recv().is_err(),
        "fatal response has not flushed"
    );
    assert!(
        RootOwner::open(&root, &ns).is_err(),
        "root remains leased before fatal flush"
    );

    let (other_requests, reader) = mpsc::unbounded_channel();
    let (frames, mut other_responses) = mpsc::unbounded_channel();
    let other = tokio::spawn(host.clone().local_owner_connection(
        Reader(reader),
        Writer {
            frames,
            gate: None,
            fail: false,
        },
    ));
    other_requests.send(hello()).unwrap();
    assert_eq!(receive(&mut other_responses).await["kind"], "draining");
    drop(other_requests);
    other.await.unwrap().unwrap();
    // Drain refuses new connections, while previously accepted clients can
    // still observe status and receive explicit rejection of new effects.
    for (operation, input) in [
        (
            "session.lifecycle.set",
            json!({"sessionId":"session","state":"archived"}),
        ),
        (
            "subscription.open",
            json!({"sessionId":"session","transcript":{"kind":"none"}}),
        ),
        (
            "turn.start",
            json!({"sessionId":"session","turnId":"turn","content":{"text":"no effects"}}),
        ),
    ] {
        live_writer.write(&request(operation, input)).await.unwrap();
        let response = receive_response(&mut live_reader).await;
        assert_eq!(response["error"]["code"], "host_draining");
    }
    release.cancel();
    if !fail_write {
        let response = receive(&mut responses).await;
        assert_eq!(response["error"]["code"], error_code);
        assert!(
            response.get("result").is_none(),
            "uncommitted projection must not escape"
        );
        if matches!(fault, Fault::Catalog) {
            assert!(
                response["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("unknown")
            );
        }
    }
    // Close this direct test client's input after its response; the other
    // admitted writer must still hold the root.
    drop(requests);
    assert_eq!(connection.await.unwrap().is_err(), fail_write);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut server)
            .await
            .is_err(),
        "fatal flush cannot retire another admitted response"
    );
    assert!(
        RootOwner::open(&root, &ns).is_err(),
        "prior response still owns residency"
    );
    // Check the listener's actual transport cancellation, not only the direct
    // connection writer: existing sockets stay usable until residency ends.
    live_writer
        .write(&request("host.status", json!({})))
        .await
        .unwrap();
    let status = receive_response(&mut live_reader).await;
    assert_eq!(status["result"]["state"], "draining");
    prior_release.cancel();
    assert_eq!(
        receive(&mut prior_responses).await["result"]["state"],
        "ready"
    );
    drop(prior_requests);
    prior.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(host);
    fault::assert_recovered(&root, &ns, fault).await;
}
