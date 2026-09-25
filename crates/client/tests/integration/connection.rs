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

use maka_client::{Client, ClientError, RequestFailure};
use maka_protocol::{COMPATIBILITY_EPOCH, COMPOSITION_ID, Operation, host::Operations};
use maka_transport::ndjson;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{DuplexStream, ReadHalf, WriteHalf};
use tokio_util::sync::CancellationToken;

type Reader = ndjson::NdjsonReader<ReadHalf<DuplexStream>>;
type Writer = ndjson::NdjsonWriter<WriteHalf<DuplexStream>>;
const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EPOCH: &str = "epoch-test";

fn accepted() -> Value {
    json!({
        "kind":"accepted", "rootId":ROOT, "hostEpoch":EPOCH, "connectionId":"connection-test",
        "selectedProtocol":0, "compatibilityEpoch":COMPATIBILITY_EPOCH,
        "compositionId":COMPOSITION_ID, "compositionRevision":"test", "state":"ready"
    })
}
async fn pair() -> (
    Client,
    tokio::sync::mpsc::Receiver<maka_client::Notification>,
    Reader,
    Writer,
) {
    pair_with(Operations).await
}
pub(super) async fn pair_with(
    registry: impl maka_protocol::OperationRegistry + Send + Sync + 'static,
) -> (
    Client,
    tokio::sync::mpsc::Receiver<maka_client::Notification>,
    Reader,
    Writer,
) {
    let (local, remote) = tokio::io::duplex(1024 * 1024);
    let (mut reader, mut writer) = ndjson::split(remote, CancellationToken::new());
    let server = tokio::spawn(async move {
        let hello = reader.read().await.unwrap().unwrap();
        assert_eq!(hello["compositionId"], COMPOSITION_ID);
        writer.write(&accepted()).await.unwrap();
        (reader, writer)
    });
    let (client, notifications) = Client::connect(local, ROOT, EPOCH, registry).await.unwrap();
    let (reader, writer) = server.await.unwrap();
    (client, notifications, reader, writer)
}
fn reply(request: &Value) -> Value {
    json!({"requestId":request["requestId"], "operation":request["operation"], "ok":true, "result":{}})
}

#[tokio::test]
async fn unsolicited_frames_and_reversed_responses_reach_their_consumers() {
    let (client, mut notifications, mut reader, mut writer) = pair().await;
    let first = tokio::spawn({
        let client = client.clone();
        async move { client.request(Operation::HostWake, json!({})).await }
    });
    let second = tokio::spawn({
        let client = client.clone();
        async move { client.request(Operation::HostWake, json!({})).await }
    });
    let a = reader.read().await.unwrap().unwrap();
    let b = reader.read().await.unwrap().unwrap();
    let kinds = [
        "configuration.changed",
        "model.provider.catalog.changed",
        "plugin.platform.changed",
    ];
    for kind in kinds {
        writer
            .write(&json!({"kind":kind,"revision":5}))
            .await
            .unwrap();
    }
    writer.write(&reply(&b)).await.unwrap();
    writer.write(&reply(&a)).await.unwrap();
    assert_eq!(first.await.unwrap().unwrap(), json!({}));
    assert_eq!(second.await.unwrap().unwrap(), json!({}));
    for kind in kinds {
        let maka_client::Notification::Catalog(notice) = notifications.recv().await.unwrap() else {
            panic!("expected catalog invalidation");
        };
        assert_eq!(notice.kind, kind);
        assert_eq!(notice.revision, 5);
    }
}

#[tokio::test]
async fn timed_out_reply_is_retired_without_poisoning_next_request() {
    let (client, _notifications, mut reader, mut writer) = pair().await;
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .request_with_timeout(Operation::HostWake, json!({}), Duration::from_millis(30))
                .await
        }
    });
    let a = reader.read().await.unwrap().unwrap();
    assert!(matches!(
        first.await.unwrap(),
        Err(RequestFailure::Unknown(ClientError::Timeout))
    ));
    writer.write(&reply(&a)).await.unwrap();
    let second = tokio::spawn({
        let client = client.clone();
        async move { client.request(Operation::HostWake, json!({})).await }
    });
    let b = reader.read().await.unwrap().unwrap();
    writer.write(&reply(&b)).await.unwrap();
    assert!(second.await.unwrap().is_ok());
}

#[tokio::test]
async fn explicit_failure_is_not_an_unknown_outcome() {
    let (client, _notifications, mut reader, mut writer) = pair().await;
    let request = tokio::spawn({
        let client = client.clone();
        async move { client.request(Operation::HostWake, json!({})).await }
    });
    let frame = reader.read().await.unwrap().unwrap();
    writer
        .write(&json!({
            "requestId":frame["requestId"], "operation":frame["operation"], "ok":false,
            "error":{"code":"host_draining","message":"Host draining"}
        }))
        .await
        .unwrap();
    assert!(matches!(
        request.await.unwrap(),
        Err(RequestFailure::Rejected(_))
    ));
}

#[tokio::test]
async fn disconnect_fails_inflight_without_retry() {
    let (client, _notifications, mut reader, writer) = pair().await;
    let request = tokio::spawn({
        let client = client.clone();
        async move { client.request(Operation::HostWake, json!({})).await }
    });
    reader.read().await.unwrap().unwrap();
    drop(reader);
    drop(writer);
    assert!(matches!(
        request.await.unwrap(),
        Err(RequestFailure::Unknown(_))
    ));
}

#[tokio::test]
async fn unmatched_or_wrong_operation_response_closes_connection() {
    for mismatched_operation in [false, true] {
        let (client, _notifications, mut reader, mut writer) = pair().await;
        let request = tokio::spawn({
            let client = client.clone();
            async move { client.request(Operation::HostWake, json!({})).await }
        });
        let frame = reader.read().await.unwrap().unwrap();
        let mut response = reply(&frame);
        if mismatched_operation {
            response["operation"] = json!("host.upgrade.prepare");
            response["result"] = json!({"kind":"active_tasks"});
        } else {
            response["requestId"] = json!("unrelated");
        }
        writer.write(&response).await.unwrap();
        assert!(matches!(
            request.await.unwrap(),
            Err(RequestFailure::Unknown(_))
        ));
        assert!(matches!(client.closed().await, ClientError::Protocol(_)));
    }
}

#[tokio::test]
async fn incompatible_identity_is_rejected_before_requests() {
    let (local, remote) = tokio::io::duplex(8192);
    let server = tokio::spawn(async move {
        let (mut reader, mut writer) = ndjson::split(remote, CancellationToken::new());
        reader.read().await.unwrap();
        writer.write(&accepted()).await.unwrap();
    });
    let result = Client::connect(local, ROOT, "stale-epoch", Operations).await;
    assert!(matches!(result, Err(ClientError::Incompatible)));
    server.await.unwrap();
}

#[tokio::test]
async fn slow_notification_consumer_fails_explicitly() {
    let (client, _notifications, _reader, mut writer) = pair().await;
    for revision in 0..33 {
        writer
            .write(&json!({"kind":"configuration.changed","revision":revision}))
            .await
            .unwrap();
    }
    let error = tokio::time::timeout(Duration::from_secs(2), client.closed())
        .await
        .unwrap();
    assert!(error.to_string().contains("too slow"));
}

#[tokio::test]
async fn dropping_last_handle_stops_reader() {
    let (client, _notifications, mut reader, _writer) = pair().await;
    drop(client);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), reader.read())
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn invalid_input_never_reaches_host() {
    let (client, _notifications, mut reader, _writer) = pair().await;
    let result = client
        .request(Operation::HostWake, json!({"unexpected":true}))
        .await;
    assert!(matches!(result, Err(RequestFailure::NotDispatched(_))));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), reader.read())
            .await
            .is_err()
    );
}
