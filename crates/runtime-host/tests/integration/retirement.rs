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

use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_runtime_host::server::{Host, local::LocalListener};
use maka_transport::{MessageReader, MessageWriter, TransportError};
use serde_json::{Value, json};
use std::time::Duration;
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
        if value["requestId"] == "retire"
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
    json!({"kind":"hello", "clientInstanceId":"retirement",         "protocolMin":0, "protocolMax":0, "compositionId":"maka.interactive",
        "compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH})
}

async fn receive(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = frames.recv().await.expect("Host reply channel closed");
            if frame.get("requestId").is_some()
                || matches!(
                    frame["kind"].as_str(),
                    Some("accepted" | "rejected" | "draining")
                )
            {
                return frame;
            }
        }
    })
    .await
    .unwrap()
}

async fn attach(
    host: &std::sync::Arc<Host>,
) -> (
    mpsc::UnboundedSender<Value>,
    Value,
    tokio::task::JoinHandle<Result<(), maka_runtime_host::server::HostError>>,
) {
    let (requests, reader) = mpsc::unbounded_channel();
    let (frames, mut responses) = mpsc::unbounded_channel();
    let task = tokio::spawn(host.clone().local_owner_connection(
        Reader(reader),
        Writer {
            frames,
            gate: None,
            fail: false,
        },
    ));
    requests.send(hello()).unwrap();
    let handshake = receive(&mut responses).await;
    assert_eq!(handshake["kind"], "accepted");
    // Keep the writer open until the request side leaves.
    tokio::spawn(async move { while responses.recv().await.is_some() {} });
    (requests, handshake, task)
}

async fn short_connections_reset_idle_expiry(host: &std::sync::Arc<Host>) {
    let connect = || async {
        let (requests, reader) = mpsc::unbounded_channel();
        let (frames, mut responses) = mpsc::unbounded_channel();
        requests.send(hello()).unwrap();
        drop(requests);
        host.clone()
            .local_owner_connection(
                Reader(reader),
                Writer {
                    frames,
                    gate: None,
                    fail: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(receive(&mut responses).await["kind"], "accepted");
    };
    connect().await;
    let expiry = host.wait_until_idle(Duration::from_secs(10), Duration::from_millis(50));
    tokio::pin!(expiry);
    assert!(futures_util::poll!(&mut expiry).is_pending());
    // This future is deliberately not spawned: the complete second connection
    // occurs between its polls, irrespective of scheduler speed. Sleeping only
    // ages the old deadline and its 100ms timer; it does not guess connection state.
    connect().await;
    tokio::time::sleep(Duration::from_millis(110)).await;
    assert!(futures_util::poll!(&mut expiry).is_pending());
    tokio::time::timeout(Duration::from_secs(5), expiry)
        .await
        .expect("idle Host did not expire after the renewed grace period");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retirement_fences_admission_and_keeps_root_until_receipt_flushed_or_abandoned() {
    for fail in [false, true] {
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in("/tmp")
                .unwrap()
        };
        #[cfg(windows)]
        let directory = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let root = directory.path().join("root");
        let owner = RootOwner::create(&root, &namespaces).unwrap();
        // Listener startup can fail after Host recovery has started. Dropping
        // that unused Host must release its idle worker and root authority.
        drop(Host::open(owner).await.unwrap());
        let owner = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(owner) = RootOwner::open(&root, &namespaces) {
                    break owner;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("unused Host retained the root");
        let host = Host::open(owner).await.unwrap();
        if !fail {
            short_connections_reset_idle_expiry(&host).await;
        }
        #[cfg(unix)]
        let endpoint = directory.path().join("h.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-test-{}", uuid::Uuid::new_v4()));
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), CancellationToken::new()),
        );
        let entered = CancellationToken::new();
        let release = CancellationToken::new();
        let (requests, reader) = mpsc::unbounded_channel();
        let (frames, mut responses) = mpsc::unbounded_channel();
        let connection = tokio::spawn(host.clone().local_owner_connection(
            Reader(reader),
            Writer {
                frames,
                gate: Some((entered.clone(), release.clone())),
                fail,
            },
        ));
        requests.send(hello()).unwrap();
        let handshake = receive(&mut responses).await;
        assert_eq!(handshake["state"], "ready");
        let (desktop, desktop_identity, desktop_task) = attach(&host).await;
        let (unrelated, _, unrelated_task) = attach(&host).await;
        let mut input = json!({"expectedHostEpoch":handshake["hostEpoch"],
            "allowInterruptActiveTasks":false, "allowCooperativeHandoff":true,
            "handoffConnectionId":desktop_identity["connectionId"]});
        requests
            .send(json!({"requestId":"blocked", "operation":"host.upgrade.prepare", "input":input}))
            .unwrap();
        assert_eq!(
            receive(&mut responses).await["result"]["kind"],
            "active_tasks"
        );
        let idle_client = if fail {
            Some((unrelated, unrelated_task))
        } else {
            drop(unrelated);
            unrelated_task.await.unwrap().unwrap();
            None
        };
        input["handoffConnectionId"] = uuid::Uuid::new_v4().to_string().into();
        requests
            .send(json!({"requestId":"stale", "operation":"host.upgrade.prepare", "input":input}))
            .unwrap();
        assert_eq!(
            receive(&mut responses).await["error"]["code"],
            "operation_conflict"
        );
        input["handoffConnectionId"] = desktop_identity["connectionId"].clone();
        if fail {
            // Scheduled updates may reconnect idle clients without pretending
            // they own those clients' handoff IDs or permission to interrupt work.
            input.as_object_mut().unwrap().remove("handoffConnectionId");
            input["allowIdleConnections"] = true.into();
        }
        requests
            .send(
                json!({"requestId":"retire", "operation":"host.upgrade.prepare",
            "input":input}),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), entered.cancelled())
            .await
            .unwrap();
        assert!(!server.is_finished(), "retirement receipt is still owned");
        loop {
            match responses.try_recv() {
                // Catalog invalidations may arrive during retirement. They are
                // not the gated request receipt whose ownership is under test.
                Ok(frame) => assert!(
                    frame.get("requestId").is_none(),
                    "unflushed receipt: {frame}"
                ),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    panic!("receipt writer closed before flush")
                }
            }
        }
        assert!(RootOwner::open(&root, &namespaces).is_err());

        let (other_requests, reader) = mpsc::unbounded_channel();
        let (frames, mut responses_after_fence) = mpsc::unbounded_channel();
        let other = tokio::spawn(host.clone().local_owner_connection(
            Reader(reader),
            Writer {
                frames,
                gate: None,
                fail: false,
            },
        ));
        other_requests.send(hello()).unwrap();
        assert_eq!(
            receive(&mut responses_after_fence).await["kind"],
            "draining"
        );
        other.await.unwrap().unwrap();
        drop(other_requests);

        release.cancel();
        if !fail {
            let receipt = receive(&mut responses).await;
            assert_eq!(
                receipt["result"],
                json!({"kind":"prepared", "pid":std::process::id()})
            );
        }
        drop(requests);
        assert_eq!(connection.await.unwrap().is_err(), fail);
        drop(desktop);
        desktop_task.await.unwrap().unwrap();
        if let Some((client, task)) = idle_client {
            drop(client);
            task.await.unwrap().unwrap();
        }
        drop(host);
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(RootOwner::open(&root, &namespaces).unwrap());
    }
}
