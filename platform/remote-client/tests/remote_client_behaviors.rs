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

#![cfg(not(target_os = "ios"))]

use futures_util::{SinkExt, StreamExt};
use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        host::{
            Configuration, Host, LifecycleMode, Options, Pairing, websocket::WebSocketListener,
        },
        logs,
        transport::GATEWAY,
    },
    ipc::LocalListener,
};
use maka_packages::Package;
use maka_remote_client::{
    MAX_CONTROL_FRAME_BYTES, MAX_WS_MESSAGE_BYTES, PairingTicketV1, RemoteCallEvent,
    RemoteClientError, RemoteHostClient, SavedHostProfile, SavedHostStore, tcp_endpoint_opener,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct LiveTestHost {
    _dir: tempfile::TempDir,
    ws_addr: SocketAddr,
    pairing: Pairing,
    epoch: Uuid,
    stop: CancellationToken,
    server: JoinHandle<Result<(), String>>,
}

impl LiveTestHost {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        private_directory(dir.path()).unwrap();
        let root = Arc::new(
            RootOwner::create(
                &dir.path().join("root"),
                &RootNamespaces {
                    ownership: dir.path().join("ownership"),
                    control: dir.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
        let contract = logs::contract();
        let pkg = |id: &str, host: Value| {
            Package::new(BTreeMap::from([(
                "maka.extension.json".into(),
                serde_json::to_vec(&json!({
                    "schemaVersion": 1,
                    "id": id,
                    "application": { "host": host }
                }))
                .unwrap(),
            )]))
            .unwrap()
        };
        let logs_pkg = pkg(
            "test.logs",
            json!({
                "implementation": { "kind": "native", "implementation": logs::HOST_LOGS },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "HostLogs": { "contract": contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway",
            json!({
                "implementation": { "kind": "native", "implementation": GATEWAY },
                "configuration": { "type": "object" },
                "exports": {},
                "imports": { "hostLogs": { "contract": contract, "cardinality": { "kind": "one" } } }
            }),
        );
        let consumer = Uuid::new_v4();
        let deployment = Uuid::new_v4();
        store
            .commit_application(
                deployment,
                0,
                serde_json::from_value(json!({
                    "instances": {
                        "logs": {
                            "key": Uuid::new_v4(),
                            "package": { "source": "pinned", "package": logs_pkg.application_ref() },
                            "usePackage": "host"
                        },
                        "gateway": {
                            "key": consumer,
                            "package": { "source": "pinned", "package": gateway_pkg.application_ref() },
                            "usePackage": "host",
                            "bindings": {
                                "hostLogs": [{ "kind": "instance", "path": ["logs"], "export": "HostLogs" }]
                            }
                        }
                    }
                }))
                .unwrap(),
                vec![],
                vec![logs_pkg, gateway_pkg],
            )
            .await
            .unwrap();
        let configuration = Configuration::PublicHost {
            endpoints: serde_json::from_value(json!({
                "hostLogs": {
                    "consumer": [consumer],
                    "import": "hostLogs",
                    "grant": { "methods": ["read"], "recovery": false }
                }
            }))
            .unwrap(),
            native: Default::default(),
            product_methods: Default::default(),
        };
        let host = Host::open_with_options(
            store,
            deployment,
            Default::default(),
            None,
            configuration,
            Options {
                lifecycle_mode: LifecycleMode::Ephemeral,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let pairing = host
            .prepare_access("ios-remote-client".into())
            .await
            .unwrap();
        let epoch = host.epoch();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket = std::path::PathBuf::from(format!(r"\\.\pipe\maka-rc-test-{}", Uuid::new_v4()));
        let local = LocalListener::bind(&socket).unwrap();
        let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
            .await
            .unwrap();
        let ws_addr = websocket.local_addr().unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn({
            let stop = stop.clone();
            async move { host.serve(local, Some(websocket), stop).await }
        });
        Self {
            _dir: dir,
            ws_addr,
            pairing,
            epoch,
            stop,
            server,
        }
    }

    async fn shutdown(self) {
        self.stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.server).await;
    }
}

#[tokio::test]
async fn pairing_ticket_finalize_connect_admit_and_call_real_host_over_websocket() {
    let live = LiveTestHost::start().await;
    let endpoint_url = format!("ws://{}", live.ws_addr);
    let now_ms = 1_795_300_000_000u64;

    // 1. Encode & decode PairingTicketV1 URI, verify symmetric 6-digit SAS.
    let ticket = PairingTicketV1::new(
        live.pairing.root_id.clone(),
        "Mac Studio Live",
        "peer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vec![endpoint_url.clone()],
        live.pairing.credential.clone(),
        "nonce-ios-live-01",
        now_ms + 300_000,
    )
    .unwrap();
    let uri = ticket.encode_uri().unwrap();
    let decoded = PairingTicketV1::decode_uri(&uri, now_ms + 1_000).unwrap();
    let ios_peer_id = "peer_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let sas = decoded.short_auth_code(ios_peer_id).unwrap();
    assert_eq!(sas.len(), 6);
    assert!(sas.bytes().all(|b| b.is_ascii_digit()));

    // 2. Finalize one-time pairing credential on live Host and save profile.
    let opener = tcp_endpoint_opener(&decoded.endpoints()[0]).unwrap();
    let client_id: Arc<str> = format!("ios-{}", Uuid::new_v4()).into();
    RemoteHostClient::finalize_access(opener.clone(), decoded.pairing_token(), &client_id)
        .await
        .expect("finalize_access must succeed against real Host");

    let store_dir = tempfile::tempdir().unwrap();
    let mut store = SavedHostStore::load_or_create(store_dir.path().join("hosts.json")).unwrap();
    let profile = SavedHostProfile::new(
        decoded.root_id(),
        decoded.host_name(),
        decoded.peer_id(),
        decoded.endpoints().to_vec(),
        live.pairing.credential_id.clone(),
        Some(now_ms + 2_000),
        false,
    )
    .unwrap();
    store.upsert_paired_host(profile.clone()).unwrap();
    assert_eq!(
        store.get(profile.root_id()).unwrap().root_id(),
        live.pairing.root_id
    );

    // 3. Connect and admit real Host with matching root_id.
    let bearer: Arc<str> = decoded.pairing_token().to_owned().into();
    let conn = RemoteHostClient::connect(opener, bearer, profile.root_id(), client_id)
        .await
        .expect("connect must admit matching real Host");
    assert_eq!(conn.epoch(), live.epoch);
    assert_eq!(conn.root_id(), live.pairing.root_id);
    assert!(conn.endpoint_names().contains(&"hostLogs".to_owned()));

    // 4. Execute a real RPC call on the admitted Host endpoint.
    let events = conn
        .call(
            "hostLogs",
            "read",
            json!({ "position": { "kind": "tail" } }),
        )
        .await
        .expect("real hostLogs.read call must succeed over WebSocket");
    assert!(
        matches!(events.last(), Some(RemoteCallEvent::Finished(_))),
        "expected terminal Finished event, got: {events:?}"
    );

    // 5. Detach cleanly without stopping the Host.
    conn.close()
        .await
        .expect("remote close must succeed cleanly");
    live.shutdown().await;
}

#[tokio::test]
async fn connect_rejects_mismatched_root_id_fail_closed() {
    let live = LiveTestHost::start().await;
    let opener = tcp_endpoint_opener(&format!("ws://{}", live.ws_addr)).unwrap();
    let client_id: Arc<str> = format!("ios-{}", Uuid::new_v4()).into();

    RemoteHostClient::finalize_access(opener.clone(), &live.pairing.credential, &client_id)
        .await
        .unwrap();

    let wrong_root = "0000000000000000000000000000000000000000000000000000000000000000";
    let err = RemoteHostClient::connect(
        opener,
        live.pairing.credential.clone().into(),
        wrong_root,
        client_id,
    )
    .await
    .err()
    .expect("mismatched root_id must fail closed");

    match err {
        RemoteClientError::RootIdMismatch { expected, actual } => {
            assert_eq!(expected, wrong_root);
            assert_eq!(actual, live.pairing.root_id);
        }
        other => panic!("expected RootIdMismatch, got {other:?}"),
    }

    live.shutdown().await;
}

#[tokio::test]
async fn connect_rejects_invalid_bearer_and_unsupported_endpoint_scheme() {
    let live = LiveTestHost::start().await;
    let opener = tcp_endpoint_opener(&format!("ws://{}", live.ws_addr)).unwrap();
    let err = RemoteHostClient::connect(
        opener,
        "definitely-not-a-valid-bearer".into(),
        &live.pairing.root_id,
        "ios-bad-auth".into(),
    )
    .await
    .err()
    .expect("invalid bearer must be rejected");
    assert!(
        matches!(err, RemoteClientError::AuthRejected(_)),
        "expected AuthRejected, got {err:?}"
    );

    let scheme_err = tcp_endpoint_opener("http://127.0.0.1:9000")
        .err()
        .expect("non-ws scheme must be rejected");
    assert!(matches!(
        scheme_err,
        RemoteClientError::InvalidEndpoint { .. }
    ));

    live.shutdown().await;
}

async fn spawn_raw_ws_responder(payloads: Vec<Vec<u8>>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let mut cfg = WebSocketConfig::default();
        cfg.max_message_size = None;
        cfg.max_frame_size = None;
        let Ok(mut ws) = tokio_tungstenite::accept_async_with_config(tcp, Some(cfg)).await else {
            return;
        };
        // Consume the client's Opening binary frame first.
        let _ = ws.next().await;
        for chunk in payloads {
            if ws.send(Message::Binary(chunk.into())).await.is_err() {
                return;
            }
        }
        let _ = ws.close(None).await;
    });
    addr
}

#[tokio::test]
async fn rejects_oversized_websocket_message_before_unbounded_buffering() {
    let oversized = vec![0x41u8; MAX_WS_MESSAGE_BYTES + 1];
    let addr = spawn_raw_ws_responder(vec![oversized]).await;
    let opener = tcp_endpoint_opener(&format!("ws://{addr}")).unwrap();
    let err = RemoteHostClient::connect(
        opener,
        "dummy-token".into(),
        "root-any",
        "ios-oversized-test".into(),
    )
    .await
    .err()
    .expect("oversized WebSocket message must be rejected");
    assert!(
        matches!(err, RemoteClientError::Io(_)),
        "expected tungstenite capacity Io error, got {err:?}"
    );
}

#[tokio::test]
async fn rejects_invalid_frame_lengths_and_truncated_frames() {
    // 1. Zero-length frame prefix
    let addr_zero = spawn_raw_ws_responder(vec![0u32.to_be_bytes().to_vec()]).await;
    let err_zero = RemoteHostClient::connect(
        tcp_endpoint_opener(&format!("ws://{addr_zero}")).unwrap(),
        "dummy-token".into(),
        "root-any",
        "ios-zero-len".into(),
    )
    .await
    .err()
    .expect("zero-length frame must fail");
    assert!(
        matches!(err_zero, RemoteClientError::Protocol(_)),
        "expected Protocol error for zero-length frame, got {err_zero:?}"
    );

    // 2. Declared length exceeding MAX_CONTROL_FRAME_BYTES
    let too_big = ((MAX_CONTROL_FRAME_BYTES as u32) + 1)
        .to_be_bytes()
        .to_vec();
    let addr_big = spawn_raw_ws_responder(vec![too_big]).await;
    let err_big = RemoteHostClient::connect(
        tcp_endpoint_opener(&format!("ws://{addr_big}")).unwrap(),
        "dummy-token".into(),
        "root-any",
        "ios-big-len".into(),
    )
    .await
    .err()
    .expect("oversized declared frame length must fail");
    assert!(
        matches!(err_big, RemoteClientError::Protocol(_)),
        "expected Protocol error for oversized frame length, got {err_big:?}"
    );

    // 3. Truncated frame (header declares 100 bytes, peer sends 10 bytes and closes)
    let mut truncated = 100u32.to_be_bytes().to_vec();
    truncated.extend_from_slice(b"0123456789");
    let addr_trunc = spawn_raw_ws_responder(vec![truncated]).await;
    let err_trunc = RemoteHostClient::connect(
        tcp_endpoint_opener(&format!("ws://{addr_trunc}")).unwrap(),
        "dummy-token".into(),
        "root-any",
        "ios-trunc".into(),
    )
    .await
    .err()
    .expect("truncated frame must fail with UnexpectedEof");
    match err_trunc {
        RemoteClientError::Io(io_err) => {
            assert_eq!(io_err.kind(), std::io::ErrorKind::UnexpectedEof);
        }
        other => panic!("expected UnexpectedEof Io error, got {other:?}"),
    }
}

#[tokio::test]
async fn real_host_query_mutation_confirm_and_cancellable_subscription_end_to_end() {
    use futures_util::future::BoxFuture;
    use maka_host_runtime::application::{
        Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation,
        NativeRegistry,
    };
    use maka_plugin_core::{
        contract::{Contract, Interface, Method, MethodMode, Transport},
        runtime::Published,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    let server_sub_cancelled = Arc::new(AtomicBool::new(false));
    let cancel_observed = Arc::new(Notify::new());

    struct DemoHandler {
        cancelled: Arc<AtomicBool>,
        cancel_observed: Arc<Notify>,
    }

    impl Handler for DemoHandler {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> BoxFuture<'static, HandlerResult> {
            let cancelled = self.cancelled.clone();
            let cancel_observed = self.cancel_observed.clone();
            Box::pin(async move {
                match method.as_str() {
                    "ping" => Ok(HandlerValue::Json(json!({
                        "pong": input.get("tag").cloned().unwrap_or(Value::Null)
                    }))),
                    "commit" => {
                        if input.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                            Ok(HandlerValue::Json(json!({
                                "applied": input.get("msg").cloned().unwrap_or(Value::Null)
                            })))
                        } else {
                            let reason = input
                                .get("msg")
                                .and_then(Value::as_str)
                                .unwrap_or("rejected")
                                .to_owned();
                            Err(HandlerError::from(reason))
                        }
                    }
                    "stream" => {
                        for idx in 1..=2u64 {
                            context
                                .emit(json!({ "seq": idx }))
                                .await
                                .map_err(|err| HandlerError::from(err.to_string()))?;
                        }
                        context.scope().cancellation.cancelled().await;
                        cancelled.store(true, Ordering::SeqCst);
                        cancel_observed.notify_waiters();
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    other => Err(HandlerError::from(format!("unknown method {other}"))),
                }
            })
        }
    }

    let any_schema = json!({"type": "object"});
    let mk_method = |mode: MethodMode| Method {
        progress: None,
        mode,
        input: any_schema.clone().into(),
        output: any_schema.clone().into(),
        resources: BTreeMap::new(),
    };
    let demo_contract = Contract {
        name: "test.demo.Service".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                ("ping".into(), mk_method(MethodMode::Query)),
                ("commit".into(), mk_method(MethodMode::Mutation)),
                ("stream".into(), mk_method(MethodMode::Subscription)),
            ]),
        },
    };

    let dir = tempfile::tempdir().unwrap();
    private_directory(dir.path()).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("ownership"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
    let pkg = |id: &str, host: Value| {
        Package::new(BTreeMap::from([(
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "id": id,
                "application": { "host": host }
            }))
            .unwrap(),
        )]))
        .unwrap()
    };
    let demo_pkg = pkg(
        "test.demo",
        json!({
            "implementation": { "kind": "native", "implementation": "test.demo.impl" },
            "configuration": { "type": "object" },
            "imports": {},
            "exports": { "Demo": { "contract": demo_contract, "availability": "required" } }
        }),
    );
    let gateway_pkg = pkg(
        "test.gateway",
        json!({
            "implementation": { "kind": "native", "implementation": GATEWAY },
            "configuration": { "type": "object" },
            "exports": {},
            "imports": { "demo": { "contract": demo_contract, "cardinality": { "kind": "one" } } }
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    store
        .commit_application(
            deployment,
            0,
            serde_json::from_value(json!({
                "instances": {
                    "demo": {
                        "key": Uuid::new_v4(),
                        "package": { "source": "pinned", "package": demo_pkg.application_ref() },
                        "usePackage": "host"
                    },
                    "gateway": {
                        "key": consumer,
                        "package": { "source": "pinned", "package": gateway_pkg.application_ref() },
                        "usePackage": "host",
                        "bindings": {
                            "demo": [{ "kind": "instance", "path": ["demo"], "export": "Demo" }]
                        }
                    }
                }
            }))
            .unwrap(),
            vec![],
            vec![demo_pkg, gateway_pkg],
        )
        .await
        .unwrap();

    let mut native = NativeRegistry::default();
    let contract_for_native = demo_contract.clone();
    let cancelled_for_native = server_sub_cancelled.clone();
    let notify_for_native = cancel_observed.clone();
    native
        .insert(
            "test.demo.impl".into(),
            Arc::new(move |_ctx, _cfg| {
                let contract = contract_for_native.clone();
                let cancelled = cancelled_for_native.clone();
                let cancel_observed = notify_for_native.clone();
                Box::pin(async move {
                    NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            "Demo".into(),
                            Published {
                                contract,
                                value: Arc::new(DemoHandler {
                                    cancelled,
                                    cancel_observed,
                                }) as Arc<dyn Handler>,
                            },
                        )])),
                        owner: Arc::new(()),
                    }
                })
            }),
        )
        .unwrap();

    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "demo": {
                "consumer": [consumer],
                "import": "demo",
                "grant": { "methods": ["ping", "commit", "stream"], "recovery": false }
            }
        }))
        .unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    let host = Host::open_with_options(
        store,
        deployment,
        native,
        None,
        configuration,
        Options {
            lifecycle_mode: LifecycleMode::Ephemeral,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let pairing = host.prepare_access("ios-demo-client".into()).await.unwrap();
    #[cfg(unix)]
    let socket = dir.path().join("host.sock");
    #[cfg(windows)]
    let socket = std::path::PathBuf::from(format!(r"\.pipemaka-rc-demo-{}", Uuid::new_v4()));
    let local = LocalListener::bind(&socket).unwrap();
    let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
        .await
        .unwrap();
    let ws_addr = websocket.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn({
        let stop = stop.clone();
        async move { host.serve(local, Some(websocket), stop).await }
    });

    let opener = tcp_endpoint_opener(&format!("ws://{ws_addr}")).unwrap();
    RemoteHostClient::finalize_access(opener.clone(), &pairing.credential, "ios-demo-client")
        .await
        .unwrap();
    let conn = RemoteHostClient::connect(
        opener,
        pairing.credential.into(),
        &pairing.root_id,
        "ios-demo-client".into(),
    )
    .await
    .unwrap();

    // 1. Query
    let pong = conn
        .query("demo", "ping", json!({ "tag": "v8" }))
        .await
        .unwrap();
    assert_eq!(pong, json!({ "pong": "v8" }));

    // 2. Mutation success (Prepared -> Confirm -> Mutation -> Recorded -> Success)
    let committed = conn
        .mutate("demo", "commit", json!({ "ok": true, "msg": "accepted" }))
        .await
        .unwrap();
    assert_eq!(committed, json!({ "applied": "accepted" }));

    // 3. Mutation business failure must surface diagnostic, not swallow
    let fail_err = conn
        .mutate(
            "demo",
            "commit",
            json!({ "ok": false, "msg": "denied-by-policy" }),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&fail_err, RemoteClientError::HostRejected(msg) if msg.contains("denied-by-policy")),
        "expected HostRejected with diagnostic, got {fail_err:?}"
    );

    // 4. Calling query-only call() on a mutation fails explicitly
    let misuse = conn
        .call("demo", "commit", json!({ "ok": true, "msg": "x" }))
        .await
        .unwrap_err();
    assert!(matches!(misuse, RemoteClientError::Protocol(_)));

    // 5. Subscription pulls two real items, then cancels cleanly while blocked on 3rd pull
    let mut sub = conn.subscribe("demo", "stream", json!({})).await.unwrap();
    assert_eq!(sub.next().await.unwrap(), Some(json!({ "seq": 1 })));
    assert_eq!(sub.next().await.unwrap(), Some(json!({ "seq": 2 })));

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let pull_task = tokio::spawn(async move { sub.next_or_cancel(&mut stop_rx).await });
    tokio::time::sleep(Duration::from_millis(80)).await;
    stop_tx.send(true).unwrap();

    let pulled = tokio::time::timeout(Duration::from_secs(3), pull_task)
        .await
        .expect("mid-pull cancellation must return promptly")
        .unwrap()
        .unwrap();
    assert_eq!(pulled, None);

    tokio::time::timeout(Duration::from_secs(3), async {
        while !server_sub_cancelled.load(Ordering::SeqCst) {
            cancel_observed.notified().await;
        }
    })
    .await
    .expect("Host subscription handler must observe cancellation promptly");

    conn.close().await.unwrap();
    stop.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
}

#[tokio::test]
async fn subscription_cancel_surfaces_drain_timeout_and_write_failure() {
    use std::sync::atomic::{AtomicBool, Ordering};

    async fn write_ws_frame(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        value: &Value,
    ) {
        let body = serde_json::to_vec(value).unwrap();
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&body);
        ws.send(Message::Binary(frame.into())).await.unwrap();
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let epoch = Uuid::new_v4();
    let session = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    let reg_epoch = Uuid::new_v4();
    let consumer = Uuid::new_v4();
    let root_id = "root-cancel-test";
    let hold_open = Arc::new(tokio::sync::Notify::new());
    let hold_server = hold_open.clone();

    let server_task = tokio::spawn(async move {
        // 1. Anchor connection
        let (tcp1, _) = listener.accept().await.unwrap();
        let mut ws1 = tokio_tungstenite::accept_async(tcp1).await.unwrap();
        let _ = ws1.next().await; // Opening Connect
        write_ws_frame(
            &mut ws1,
            &json!({
                "kind": "connected",
                "value": {
                    "version": 1,
                    "epoch": epoch,
                    "session": session,
                    "source": { "stateDomain": root_id, "deployment": deployment, "revision": 1 },
                    "consumers": { "demo": [consumer] },
                    "catalogue": { "endpoints": { "demo": { "registration_epoch": reg_epoch } } }
                }
            }),
        )
        .await;

        // 2. Call channel 1 (stalls on Cancel -> triggers TimedOut)
        let (tcp2, _) = listener.accept().await.unwrap();
        let mut ws2 = tokio_tungstenite::accept_async(tcp2).await.unwrap();
        let _ = ws2.next().await; // Opening Call
        write_ws_frame(&mut ws2, &json!({ "kind": "accepted" })).await;
        let _ = ws2.next().await; // Open + descriptors
        write_ws_frame(&mut ws2, &json!({ "kind": "ready" })).await;
        write_ws_frame(&mut ws2, &json!({ "kind": "subscribed" })).await;

        // 3. Call channel 2 (for write-failure test)
        let (tcp3, _) = listener.accept().await.unwrap();
        let mut ws3 = tokio_tungstenite::accept_async(tcp3).await.unwrap();
        let _ = ws3.next().await; // Opening Call
        write_ws_frame(&mut ws3, &json!({ "kind": "accepted" })).await;
        let _ = ws3.next().await; // Open + descriptors
        write_ws_frame(&mut ws3, &json!({ "kind": "ready" })).await;
        write_ws_frame(&mut ws3, &json!({ "kind": "subscribed" })).await;

        hold_server.notified().await;
        drop((ws1, ws2, ws3));
    });

    let fail_writes = Arc::new(AtomicBool::new(false));
    struct ToggleFailWriteStream {
        inner: maka_remote_client::BoxedStream,
        fail_writes: Arc<AtomicBool>,
    }
    impl tokio::io::AsyncRead for ToggleFailWriteStream {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }
    impl tokio::io::AsyncWrite for ToggleFailWriteStream {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated cancel write failure",
                )));
            }
            std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
        }
        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated cancel flush failure",
                )));
            }
            std::pin::Pin::new(&mut self.inner).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    let base_opener = tcp_endpoint_opener(&format!("ws://{addr}")).unwrap();
    let opener: maka_remote_client::OpenStream = {
        let fail_writes = fail_writes.clone();
        Arc::new(move || {
            let base = base_opener.clone();
            let fail_writes = fail_writes.clone();
            Box::pin(async move {
                let inner = base().await?;
                Ok(Box::new(ToggleFailWriteStream { inner, fail_writes })
                    as maka_remote_client::BoxedStream)
            })
        })
    };

    let conn = RemoteHostClient::connect(opener, "tok".into(), root_id, "ios-cancel-test".into())
        .await
        .unwrap();

    // Case 1: Server stalls after Cancel -> cancel_with_timeout MUST return TimedOut, not Ok(())!
    let sub1 = conn.subscribe("demo", "stream", json!({})).await.unwrap();
    let timeout_err = sub1
        .cancel_with_timeout(Duration::from_millis(120))
        .await
        .expect_err("stalled server after Cancel must return TimedOut error");
    match timeout_err {
        RemoteClientError::Io(io_err) => {
            assert_eq!(io_err.kind(), std::io::ErrorKind::TimedOut);
        }
        other => panic!("expected TimedOut Io error, got {other:?}"),
    }

    // Case 2: Cancel write fails -> cancel() MUST surface the write error, not swallow it!
    let sub2 = conn.subscribe("demo", "stream", json!({})).await.unwrap();
    fail_writes.store(true, Ordering::SeqCst);
    let write_err = sub2
        .cancel_with_timeout(Duration::from_millis(120))
        .await
        .expect_err("failed Cancel write must surface error");
    assert!(
        matches!(&write_err, RemoteClientError::Io(e) if e.kind() == std::io::ErrorKind::BrokenPipe || e.to_string().contains("cancel")),
        "expected BrokenPipe/write error, got {write_err:?}"
    );

    hold_open.notify_waiters();
    let _ = server_task.await;
}
