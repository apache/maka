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
use crate::support::execution_drain as support;
use maka_event_log::{
    EventLog,
    root::{ROOT_DATABASE, RootOwner},
};
use maka_runtime::event::{Fact, InvocationOutcome};
use maka_runtime_host::server::{Host, local::LocalListener};
use maka_transport::{MessageReader, MessageWriter, TransportError};
use serde_json::{Value, json};
use sqlx::Connection;
use std::{sync::Arc, time::Duration};
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
    entered: CancellationToken,
    release: CancellationToken,
}
impl MessageWriter for Writer {
    async fn write(&mut self, value: &Value) -> Result<(), TransportError> {
        if value["requestId"] == "turn.start" {
            self.entered.cancel();
            self.release.cancelled().await;
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
    json!({"kind":"hello","clientInstanceId":"execution-drain-test",        "protocolMin":0,"protocolMax":0,
        "compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,"compositionId":"maka.interactive"})
}
fn request(operation: &str, input: Value) -> Value {
    json!({"requestId":operation,"operation":operation,"input":input})
}
async fn receive(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn response(reader: &mut impl MessageReader) -> Value {
    loop {
        let value = reader.read().await.unwrap().unwrap();
        if value.get("requestId").is_some() {
            return value;
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreground_background_and_closure_commit_failures_drain_host() {
    for failed_kind in [
        "invocation_opened",
        "model_requested",
        "interaction_closure",
    ] {
        let (directory, ns, root, provider, host) = support::fixture().await;
        // The INSERT succeeds; a deferred foreign key fails only at COMMIT.
        let mut database = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new().filename(root.join(ROOT_DATABASE)),
        )
        .await
        .unwrap();
        sqlx::raw_sql("CREATE TABLE drain_parent (id INTEGER PRIMARY KEY);
            CREATE TABLE drain_child (id INTEGER REFERENCES drain_parent(id) DEFERRABLE INITIALLY DEFERRED);")
            .execute(&mut database).await.unwrap();
        let trigger = if failed_kind == "interaction_closure" {
            support::fail_closure(&mut database).await;
            "SELECT 1;"
        } else if failed_kind == "invocation_opened" {
            "CREATE TRIGGER drain_commit_failure AFTER INSERT ON event_log
             WHEN NEW.kind = 'invocation_opened' BEGIN INSERT INTO drain_child VALUES (1); END;"
        } else {
            "CREATE TRIGGER drain_commit_failure AFTER INSERT ON event_log
             WHEN NEW.kind = 'model_requested' BEGIN INSERT INTO drain_child VALUES (1); END;"
        };
        sqlx::raw_sql(trigger).execute(&mut database).await.unwrap();
        database.close().await.unwrap();
        let socket_path = directory.path().join("h.sock");
        let server = tokio::spawn(
            LocalListener::bind(&socket_path)
                .unwrap()
                .serve(host.clone(), CancellationToken::new()),
        );
        let socket = tokio::net::UnixStream::connect(&socket_path).await.unwrap();
        let (mut live_reader, mut live_writer) =
            maka_transport::ndjson::split(socket, CancellationToken::new());
        live_writer.write(&hello()).await.unwrap();
        live_reader.read().await.unwrap().unwrap();
        let entered = CancellationToken::new();
        let release = CancellationToken::new();
        let (requests, reader) = mpsc::unbounded_channel();
        let (frames, mut responses) = mpsc::unbounded_channel();
        let connection = tokio::spawn(host.clone().local_owner_connection(
            Reader(reader),
            Writer {
                frames,
                entered: entered.clone(),
                release: release.clone(),
            },
        ));
        requests.send(hello()).unwrap();
        assert_eq!(receive(&mut responses).await["state"], "ready");
        requests
            .send(request(
                "turn.start",
                json!({
                    "sessionId":"session","turnId":"turn","content":{"text":"no provider effects"}
                }),
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), entered.cancelled())
            .await
            .unwrap();
        if failed_kind == "interaction_closure" {
            // A pending approval now correctly pauses before the first model
            // request. Explicit stop reaches finalization without answering it
            // or letting the model run merely to provoke the closure fault.
            live_writer
                .write(&request(
                    "turn.query",
                    json!({
                        "sessionId":"session", "turnId":"turn"
                    }),
                ))
                .await
                .unwrap();
            let turn = response(&mut live_reader).await;
            assert_eq!(turn["result"]["status"], "waiting_for_user", "{turn}");
            assert_eq!(
                provider.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            live_writer
                .write(&request(
                    "turn.stop",
                    json!({
                        "sessionId":"session", "turnId":"turn", "runId":turn["result"]["runId"]
                    }),
                ))
                .await
                .unwrap();
            let stopped = response(&mut live_reader).await;
            assert_eq!(stopped["error"]["code"], "internal_failure", "{stopped}");
            assert!(
                stopped["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("injected ordinary closure failure")
            );
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                live_writer
                    .write(&request("host.status", json!({})))
                    .await
                    .unwrap();
                let status = response(&mut live_reader).await;
                if status["result"]["state"] == "draining" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            !server.is_finished(),
            "{failed_kind}: admitted turn.start must flush before listener exits"
        );
        live_writer
            .write(&request(
                "session.lifecycle.set",
                json!({"sessionId":"session","state":"archived"}),
            ))
            .await
            .unwrap();
        assert_eq!(
            response(&mut live_reader).await["error"]["code"],
            "host_draining"
        );
        release.cancel();
        // Domain replies may interleave with committed catalog notices.
        let response = loop {
            let frame = receive(&mut responses).await;
            if frame["requestId"] == "turn.start" {
                break frame;
            }
            assert!(
                matches!(
                    frame["kind"].as_str(),
                    Some(
                        "session.catalog.changed"
                            | "plugin.client.changed"
                            | "plugin.terminal.changed"
                            | "plugin.platform.changed"
                            | "model.provider.catalog.changed"
                    )
                ),
                "{frame}"
            );
        };
        if failed_kind == "invocation_opened" {
            // A failed COMMIT cannot prove rejection to a submitting Client.
            assert_eq!(response["error"]["code"], "outcome_unknown");
        } else {
            assert_eq!(response["result"]["kind"], "started", "{response}");
        }
        drop(requests);
        connection.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(host);
        let owner = RootOwner::open(&root, &ns).unwrap();
        let log = EventLog::open(&root.join(ROOT_DATABASE)).await.unwrap();
        let before = log.prefix(100, 1024 * 1024).await.unwrap().events;
        if failed_kind == "invocation_opened" {
            assert!(before.is_empty());
        } else if failed_kind == "interaction_closure" {
            assert_eq!(before.len(), 1);
            assert!(matches!(
                before[0].event.fact,
                Fact::InvocationOpened { .. }
            ));
            let pending = log.interaction("approval").await.unwrap().unwrap();
            assert!(pending.outcome.is_none());
            let maka_runtime::interaction::InteractionRequest::ClientCapability { target, .. } =
                pending.request
            else {
                panic!("expected capability approval");
            };
            assert!(
                log.client_capability_grant("session", &target)
                    .await
                    .unwrap()
                    .is_none()
            );
        } else {
            assert_eq!(before.len(), 2);
            assert!(matches!(
                before[0].event.fact,
                Fact::InvocationOpened { .. }
            ));
            assert!(matches!(&before[1].event.fact, Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed { class, .. }
            } if class == "event_commit"));
        }
        log.shutdown().await.unwrap();
        if failed_kind == "interaction_closure" {
            let mut database = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new().filename(root.join(ROOT_DATABASE)),
            )
            .await
            .unwrap();
            sqlx::raw_sql("DROP TRIGGER fail_closure")
                .execute(&mut database)
                .await
                .unwrap();
            database.close().await.unwrap();
        }
        // Startup preserves the failed terminal facts without retrying the model.
        let reopened = Host::open(owner).await.unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        LocalListener::bind(&socket_path)
            .unwrap()
            .serve(reopened, cancellation)
            .await
            .unwrap();
        let log = EventLog::for_root(Arc::new(RootOwner::open(&root, &ns).unwrap()))
            .await
            .unwrap();
        let after = log.prefix(100, 1024 * 1024).await.unwrap().events;
        assert_eq!(
            serde_json::to_vec(&after[..before.len()]).unwrap(),
            serde_json::to_vec(&before).unwrap()
        );
        if failed_kind == "interaction_closure" {
            assert_eq!(after.len(), before.len() + 1);
            assert!(matches!(
                after.last().unwrap().event.fact,
                Fact::InvocationEnded { .. }
            ));
            assert!(matches!(
                log.interaction("approval").await.unwrap().unwrap().outcome,
                Some(maka_runtime::interaction::InteractionOutcome::Closure {
                    reason: maka_runtime::interaction::ClosureReason::HostRestarted,
                    ..
                })
            ));
        } else {
            assert_eq!(after.len(), before.len());
        }
        log.shutdown().await.unwrap();
        assert_eq!(
            provider.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "{failed_kind}: no unexpected provider call or startup replay"
        );
    }
}
