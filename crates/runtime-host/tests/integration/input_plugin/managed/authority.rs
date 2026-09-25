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
use futures_util::{SinkExt, StreamExt};
use maka_config::{
    ConfigurationStore,
    access::{AccessCreateMode, AccessCredential, CredentialState},
};
use maka_runtime_host::server::websocket::WebSocketListener;
use sha2::{Digest, Sha256};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn managed_native_input_refreshes_the_authenticated_caller_before_effects() {
    tokio::time::timeout(Duration::from_secs(35), caller())
        .await
        .unwrap();
}
async fn caller() {
    let fixture = ClientFixture::new("maka-managed-caller-");
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    fixture::seed(&fixture, &model).await;
    let configuration = ConfigurationStore::for_root(Arc::new(fixture.owner()))
        .await
        .unwrap();
    let grants = [
        "turn.message.submit",
        "plugin.remote",
        "plugin.authorization",
        "session.create",
        "turn.start",
        "turn.stop",
        "session.transcript.page",
    ];
    let now = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    for (id, grants) in [("restricted", &grants[..1]), ("full", &grants[..])] {
        configuration
            .create_access_credential(
                AccessCredential {
                    credential_id: id.into(),
                    credential_hash: format!("{:x}", Sha256::digest(id.as_bytes())),
                    principal_id: id.into(),
                    principal_kind: maka_runtime::access::ManagedPrincipalKind::RemoteOwner,
                    grants: grants
                        .iter()
                        .copied()
                        .chain(["access.credential.finalize"])
                        .map(str::to_owned)
                        .collect(),
                    can_publish_client_capabilities: false,
                    can_use_host_paths: true,
                    created_at: "2026-09-25T00:00:00Z".into(),
                    state: CredentialState::Pending {
                        expires_at: now + 60_000,
                        bind_client_instance: true,
                    },
                    capability_owner: None,
                },
                AccessCreateMode::Prepare,
                None,
            )
            .await
            .unwrap();
        let finalized = configuration
            .finalize_access_credential(id.into(), format!("{id}-client"), None, now)
            .await
            .unwrap();
        assert!(finalized.value.reconnect_required);
    }
    let credentials = configuration.active_access_credentials().await.unwrap();
    assert_eq!(credentials.len(), 2);
    for credential in credentials {
        assert_eq!(
            credential.client_instance_id(),
            Some(format!("{}-client", credential.credential_id).as_str())
        );
    }
    // Release the setup store's RootOwner before the Host takes that one Root.
    configuration.close().await.unwrap();
    let (pauses, mut paused) = tokio::sync::mpsc::unbounded_channel();
    let manager = Manager::new(pauses);
    let host = Host::open_with_options(
        fixture.owner(),
        None,
        HostOptions {
            plugins: fixture::setup(&manager),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    #[cfg(unix)]
    let endpoint = fixture
        .workspace
        .parent()
        .unwrap()
        .join("managed-caller.sock");
    #[cfg(windows)]
    let endpoint = std::path::PathBuf::from(format!(
        r"\\.\pipe\maka-managed-caller-{}",
        uuid::Uuid::new_v4()
    ));
    let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
        .await
        .unwrap();
    let address = websocket.local_addr().unwrap();
    let stop = CancellationToken::new();
    let cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve_with_websocket(websocket, host.clone(), stop),
    );
    let mut peer = Peer::new(host.clone(), "caller-control").await;
    peer.wait_for_plugins().await;
    let (mut restricted, hello) = connect(address, "restricted").await;
    let rejected = rpc(
        &mut restricted,
        submit(
            &hello["hostEpoch"],
            "managed",
            "restricted",
            "cannot dispatch",
            "current_turn",
        ),
    )
    .await;
    assert_eq!(rejected["error"]["code"], "unauthorized", "{rejected}");
    restricted.close(None).await.unwrap();
    let (mut full, hello) = connect(address, "full").await;
    let started = peer
        .rpc(
            "turn.message.submit",
            submit(
                &hello["hostEpoch"],
                "managed",
                "active-owner-input",
                "keep the run active",
                "current_turn",
            ),
        )
        .await;
    let SubmitResult::TurnStarted { turn_id, .. } = submitted(&started) else {
        panic!("expected a local owner's active model run: {started}");
    };
    let active = requests.recv().await.unwrap();
    // CurrentTurn steering prepares against the active tools, without a new
    // Environment/client-tool binding that disconnection could invalidate.
    full.send(Message::text(
        json!({"requestId":"submit","operation":"turn.message.submit",
        "input":submit(&hello["hostEpoch"], "managed", "revoked", "pause", "current_turn")})
        .to_string(),
    ))
    .await
    .unwrap();
    let release = paused.recv().await.unwrap();
    let query = peer
        .rpc(
            "turn.message.execution.query",
            json!({"sessionId":"managed","messageIds":["revoked"]}),
        )
        .await;
    assert!(resolutions(&query).is_empty(), "{query}");
    let revoked = peer
        .rpc("access.credential.revoke", json!({"credentialId":"full"}))
        .await;
    assert_eq!(revoked["result"]["revoked"], true, "{revoked}");
    // Transport revocation closes delivery, while the real Host drains already
    // dispatched work. Prove the paused preparation survived that closure before
    // releasing it, so lack of effects cannot be explained by request cancellation.
    while let Some(Ok(message)) = full.next().await {
        if matches!(message, Message::Close(_)) {
            break;
        }
        if let Message::Text(text) = message {
            let frame: Value = serde_json::from_str(&text).unwrap();
            assert_ne!(
                frame["requestId"], "submit",
                "paused request unexpectedly completed: {frame}"
            );
        }
    }
    assert!(
        !release.is_closed(),
        "revocation must drain the admitted preparation"
    );
    let query = peer
        .rpc(
            "turn.message.execution.query",
            json!({"sessionId":"managed","messageIds":["revoked"]}),
        )
        .await;
    assert!(
        resolutions(&query).is_empty(),
        "revoked preparation settled before release: {query}"
    );
    release.send(()).unwrap();
    let query = loop {
        let query = peer
            .rpc(
                "turn.message.execution.query",
                json!({"sessionId":"managed","messageIds":["restricted","revoked"]}),
            )
            .await;
        if resolutions(&query).len() == 2 {
            break query;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(
        resolutions(&query),
        vec![
            ExecutionResolution::NotAdmitted {
                message_id: "restricted".into()
            },
            ExecutionResolution::NotAdmitted {
                message_id: "revoked".into()
            },
        ],
        "{query}"
    );
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    active
        .reply
        .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
        .unwrap();
    complete(&mut peer, "managed", &json!(turn_id)).await;
    assert_eq!(
        provider.requests.lock().unwrap().len(),
        1,
        "revoked input must not cause another model request"
    );
    peer.close().await;
    drop(cleanup);
    server.await.unwrap().unwrap();
    drop(host);
}
async fn connect(address: std::net::SocketAddr, id: &str) -> (Socket, Value) {
    let mut request = format!("ws://{address}/runtime-host")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {id}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(Message::text(
            json!({"kind":"hello","clientInstanceId":format!("{id}-client"),
        "protocolMin":0,"protocolMax":0,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,
        "compositionId":"maka.interactive"})
            .to_string(),
        ))
        .await
        .unwrap();
    let hello: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(hello["state"], "ready", "{hello}");
    (socket, hello)
}
async fn rpc(socket: &mut Socket, input: Value) -> Value {
    socket
        .send(Message::text(
            json!({"requestId":"submit","operation":"turn.message.submit","input":input})
                .to_string(),
        ))
        .await
        .unwrap();
    response(socket).await
}
async fn response(socket: &mut Socket) -> Value {
    loop {
        let frame = socket.next().await.unwrap().unwrap();
        let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        if value["requestId"] == "submit" {
            return value;
        }
    }
}
