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

use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    Context, Handler, HandlerResult, NativeActivation, NativeRegistry,
    host::{Configuration, Host, LifecycleMode, Options, PeerId, PeerPairingOptions},
    logs,
    transport::GATEWAY,
};
use maka_packages::Package;
use maka_plugin_core::{contract::Contract, runtime::Published};
use maka_remote_client::{
    Attachments, DeviceIdentity, PendingPairing, ReadResource, RelayAuthorization,
    RemoteHostConnection, SavedHosts,
};
use maka_remote_pairing::{RelayEndpoint, SignedPairingTicket};
use maka_remote_transport::{
    Relay,
    host::HostPeerTransport,
    server::{RelayServer, RelayTls},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, time::timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn package(id: &str, host: Value) -> Package {
    Package::new(BTreeMap::from([(
        "maka.extension.json".into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":id,"application":{"host":host}}))
            .unwrap(),
    )]))
    .unwrap()
}

const PROBE: &str = "test.remote.probe";
const LARGE_UPLOAD: usize = 33 * 1024 * 1024;

fn probe_secret() -> String {
    // Force the first 64 KiB chunk boundary into the middle of a scalar.
    format!("{}🔒密文", "x".repeat(64 * 1024 - 1))
}

struct Probe;

impl Handler for Probe {
    fn call(
        &self,
        _method: String,
        input: Value,
        context: Context,
    ) -> futures_util::future::BoxFuture<'static, HandlerResult> {
        Box::pin(async move {
            let key_id = input["keyId"].as_str().ok_or("missing key ID")?;
            if input != json!({"keyId": key_id}) {
                return Err("unexpected JSON input".into());
            }
            let resource = context
                .attachments()
                .get("secret")
                .ok_or("missing attachment")?;
            let valid = match key_id {
                "test-key" => resource.read(0..resource.bytes())? == probe_secret().as_bytes(),
                "empty" => resource.bytes() == 0 && resource.read(0..0)?.is_empty(),
                "large" => {
                    resource.bytes() == LARGE_UPLOAD
                        && resource.read(0..1)? == b"x"
                        && resource.read(resource.bytes() - 1..resource.bytes())? == b"x"
                }
                _ => return Err("unexpected JSON input".into()),
            };
            if !valid {
                return Err("wrong attachment bytes".into());
            }
            context.emit(json!({"step": "received"})).await?;
            context.emit(json!({"step": "saved"})).await?;
            Ok(json!({"saved": true}).into())
        })
    }
}

async fn logs_host() -> (tempfile::TempDir, Arc<Host>) {
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
    let logs = package(
        "test.logs",
        json!({
            "implementation":{"kind":"native","implementation":logs::HOST_LOGS},
            "configuration":{"type":"object"},"imports":{},
            "exports":{"HostLogs":{"contract":contract,"availability":"required"}}
        }),
    );
    let probe_contract: Contract = serde_json::from_value(json!({
        "name":"maka.test.RemoteProbe", "version":1, "transport":"remote",
        "interface":{"kind":"service","methods":{"commit":{
            "mode":"mutation", "input":{"type":"object"}, "output":{"type":"object"},
            "progress":{"type":"object"},
            "resources":{"secret":{"type":{"name":"maka.text.utf8","version":1},"optional":false}}
        }}}
    }))
    .unwrap();
    let probe = package(
        PROBE,
        json!({
            "implementation":{"kind":"native","implementation":PROBE},
            "configuration":{"type":"object"},"imports":{},
            "exports":{"Probe":{"contract":probe_contract,"availability":"required"}}
        }),
    );
    let gateway = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{
                "hostLogs":{"contract":contract,"cardinality":{"kind":"one"}},
                "probe":{"contract":probe_contract,"cardinality":{"kind":"one"}}
            }
        }),
    );
    let mut native = NativeRegistry::default();
    native
        .insert(
            PROBE.into(),
            Arc::new(move |_, _| {
                let contract = probe_contract.clone();
                Box::pin(async move {
                    NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            "Probe".into(),
                            Published {
                                contract,
                                value: Arc::new(Probe) as Arc<dyn Handler>,
                            },
                        )])),
                        owner: Arc::new(()),
                    }
                })
            }),
        )
        .unwrap();
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    let source = store.commit_application(
        deployment, 0,
        serde_json::from_value(json!({"instances":{
            "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
            "probe":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":probe.application_ref()},"usePackage":"host"},
            "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                "bindings":{
                "hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}],
                "probe":[{"kind":"instance","path":["probe"],"export":"Probe"}]
            }}
        }})).unwrap(),
        vec![], vec![logs, probe, gateway],
    ).await.unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read","watch"],"recovery":false}},
            "probe":{"consumer":[consumer],"import":"probe","grant":{"methods":["commit"],"recovery":false}}
        })).unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    store
        .select_committed_application_launch(source, serde_json::to_value(&configuration).unwrap())
        .await
        .unwrap();
    let host = Host::open_with_options(
        store.clone(),
        deployment,
        native,
        None,
        configuration.clone(),
        Options {
            lifecycle_mode: LifecycleMode::Ephemeral,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    (dir, host)
}

const TOKEN: &str = "test-relay-bearer";
const DEADLINE: Duration = Duration::from_secs(15);

async fn https_relay() -> (RelayServer, RelayEndpoint) {
    let tls = RelayTls::self_signed(vec!["127.0.0.1".into()]).unwrap();
    let addr = "127.0.0.1:0".parse().unwrap();
    let relay = RelayServer::bind(None, Some(addr), Some(addr), Some(&tls), Some(TOKEN))
        .await
        .unwrap();
    let endpoint = RelayEndpoint {
        url: format!("https://{}", relay.https_addr().unwrap()),
        quic_port: Some(relay.quic_addr().unwrap().port()),
        cert_sha256: relay.cert_sha256().map(hex::encode),
    };
    (relay, endpoint)
}

async fn read_logs(client: &RemoteHostConnection) {
    let page = client
        .query("hostLogs", "read", json!({"position":{"kind":"tail"}}))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_value::<maka_host_runtime::logs::HostLogPage>(page).unwrap(),
        maka_host_runtime::logs::HostLogPage::Missing,
    );
}

#[tokio::test]
async fn confirmed_sas_redeems_once_and_admits_concurrent_calls_until_revoked() {
    timeout(DEADLINE, async {
        let (relay, route) = https_relay().await;
        let (dir, host) = logs_host().await;
        let relay_config = Relay::new(&route, None, Some(TOKEN.into())).unwrap();
        let transport = HostPeerTransport::bind(&host, &[relay_config], false)
            .await
            .unwrap();
        transport.wait_for_relay().await.unwrap();
        let (sender, ingress) = HostPeerTransport::ingress();
        let cancel = CancellationToken::new();
        let (observed, mut accepted) = mpsc::unbounded_channel();
        let peer_server = tokio::spawn(transport.serve(sender, cancel.clone(), move |id, sas| {
            observed.send((id.clone(), sas)).unwrap();
        }));
        let host_server = tokio::spawn({
            let host = host.clone();
            let cancel = cancel.clone();
            async move { host.serve_peer_streams(ingress, cancel).await }
        });

        let identity_path = dir.path().join("device.ed25519");
        let identity = DeviceIdentity::load_or_create(&identity_path).unwrap();
        let peer_id = PeerId::new(identity.public_key().to_string()).unwrap();
        let invite = host
            .prepare_peer_pairing(PeerPairingOptions {
                host_name: "Logs fixture".into(),
                label: None,
                ttl_secs: None,
            })
            .await
            .unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap();
        let auth = || {
            Some(RelayAuthorization {
                relay_url: &route.url,
                bearer: TOKEN,
            })
        };
        let profiles = dir.path().join("hosts.json");
        let mut saved = SavedHosts::load(&profiles).unwrap();

        let wrong = PendingPairing::begin(&identity, &invite.uri, now, auth(), &saved)
            .await
            .unwrap();
        accepted.recv().await.unwrap();
        assert!(wrong.confirm("not the SAS", None).await.is_err());
        assert!(!profiles.exists());
        assert!(host.list_peer_access().await.unwrap().is_empty());

        let pending = PendingPairing::begin(&identity, &invite.uri, now, auth(), &saved)
            .await
            .unwrap();
        let (observed_id, sas) = accepted.recv().await.unwrap();
        assert_eq!(observed_id, peer_id);
        assert_eq!(pending.sas(), sas);
        assert_eq!(sas.len(), 6);
        assert!(!pending.path_summary().unwrap().direct);

        let (profile, client) = pending.confirm(&sas, None).await.unwrap();
        let mut progress = Vec::new();
        let saved_value = client
            .mutate_with(
                "probe",
                "commit",
                json!({"keyId":"test-key"}),
                Attachments::from([("secret".into(), ReadResource::utf8(probe_secret()))]),
                |value| progress.push(value),
            )
            .await
            .unwrap();
        assert_eq!(
            progress,
            [json!({"step":"received"}), json!({"step":"saved"})]
        );
        assert_eq!(saved_value, json!({"saved":true}));

        let empty = client
            .mutate_with(
                "probe",
                "commit",
                json!({"keyId":"empty"}),
                Attachments::from([("secret".into(), ReadResource::utf8(String::new()))]),
                |_| {},
            )
            .await
            .unwrap();
        assert_eq!(empty, json!({"saved":true}));

        let mut watch = client
            .subscribe("hostLogs", "watch", json!({"position":{"kind":"tail"}}))
            .await
            .unwrap();
        tokio::join!(read_logs(&client), read_logs(&client));
        assert_eq!(
            serde_json::from_value::<maka_host_runtime::logs::HostLogPage>(
                watch.next().await.unwrap().unwrap()
            )
            .unwrap(),
            maka_host_runtime::logs::HostLogPage::Missing,
        );
        watch.cancel().await.unwrap();
        assert!(matches!(
            accepted.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        saved.save(profile).unwrap();
        let data = std::fs::read_to_string(&profiles).unwrap();
        let ticket = SignedPairingTicket::parse_and_verify_uri(&invite.uri, now).unwrap();
        assert!(!data.contains(&ticket.payload().invite_secret));
        assert!(!data.contains(TOKEN));
        #[cfg(unix)]
        for path in [&profiles, &identity_path] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let replay = PendingPairing::begin(&identity, &invite.uri, now, auth(), &saved)
            .await
            .unwrap();
        let (_, sas) = accepted.recv().await.unwrap();
        assert!(matches!(
            replay.confirm(&sas, None).await,
            Err(maka_remote_client::RemoteClientError::HostRejected(_))
        ));
        client.close().await.unwrap();

        let saved = SavedHosts::load(profiles).unwrap();
        let profile = saved.get(&invite.root_id).unwrap();
        let identity = DeviceIdentity::load_or_create(&identity_path).unwrap();
        let mut reconnected = profile.reconnect(&identity, auth()).await.unwrap();
        assert_eq!(accepted.recv().await.unwrap().0, peer_id);
        read_logs(&reconnected).await;
        assert!(host.revoke_peer_access(peer_id).await.unwrap());
        let reason = reconnected.disconnected().await.unwrap_err();
        assert!(
            reason.to_string().contains("peer access revoked"),
            "{reason}"
        );
        assert!(
            reconnected
                .query("hostLogs", "read", json!({"position":{"kind":"tail"}}))
                .await
                .is_err()
        );
        assert!(profile.reconnect(&identity, auth()).await.is_err());

        cancel.cancel();
        peer_server.await.unwrap().unwrap();
        host_server.await.unwrap().unwrap();
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("remote client test timed out");
}

#[tokio::test]
async fn cancelling_mid_upload_releases_host_attachment_budget() {
    use futures_util::{SinkExt, StreamExt};
    use maka_host_runtime::{
        application::host::{
            Channel, Client,
            websocket::{WebSocketListener, channel_opener},
        },
        ipc::LocalListener,
    };
    use maka_remote_transport::{TlsTrust, websocket::WebSocketEndpoint};
    use tokio::{
        io::{AsyncWriteExt, copy_bidirectional},
        net::{TcpListener, TcpStream},
        sync::oneshot,
    };
    use tokio_tungstenite::accept_async;

    timeout(DEADLINE, async {
        let (dir, host) = logs_host().await;
        #[cfg(unix)]
        let local = dir.path().join("upload.sock");
        #[cfg(windows)]
        let local = std::path::PathBuf::from(format!(r"\\.\pipe\maka-upload-{}", Uuid::new_v4()));
        let local = LocalListener::bind(&local).unwrap();
        let ws = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
            .await
            .unwrap();
        let addr = ws.local_addr().unwrap();
        let pairing = host.prepare_access("upload-fixture".into()).await.unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn({
            let stop = stop.clone();
            async move { host.serve(local, Some(ws), stop).await }
        });
        let bearer: Arc<str> = pairing.credential.into();
        let instance: Arc<str> = Uuid::new_v4().to_string().into();
        Client::finalize_access(
            channel_opener(
                Arc::new(move || {
                    Box::pin(
                        async move { Ok(Box::new(TcpStream::connect(addr).await?) as Channel) },
                    )
                }),
                bearer.clone(),
            ),
            instance.clone(),
            None,
        )
        .await
        .unwrap();

        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/runtime-host", proxy.local_addr().unwrap());
        let (forwarded, first_chunk) = oneshot::channel();
        let proxy_task = tokio::spawn({
            let bearer = bearer.clone();
            async move {
                let (mut anchor, _) = proxy.accept().await.unwrap();
                let anchor_proxy = tokio::spawn(async move {
                    let mut host = TcpStream::connect(addr).await.unwrap();
                    let _ = copy_bidirectional(&mut anchor, &mut host).await;
                });
                let (socket, _) = proxy.accept().await.unwrap();
                let mut client = accept_async(socket).await.unwrap();
                let endpoint =
                    WebSocketEndpoint::new(&format!("ws://{addr}/runtime-host"), TlsTrust::System)
                        .unwrap();
                let mut upstream = endpoint.open(Some(&bearer)).await.unwrap();
                // Opening, call, descriptors (each is a length frame plus a JSON frame).
                for messages in [2, 4] {
                    for _ in 0..messages {
                        upstream
                            .send(client.next().await.unwrap().unwrap())
                            .await
                            .unwrap();
                    }
                    for _ in 0..2 {
                        client
                            .send(upstream.next().await.unwrap().unwrap())
                            .await
                            .unwrap();
                    }
                }
                let length = client.next().await.unwrap().unwrap();
                let body = client.next().await.unwrap().unwrap();
                assert_eq!(
                    length.clone().into_data().as_ref(),
                    &65536_u32.to_be_bytes()
                );
                assert_eq!(body.len(), 65536);
                upstream.send(length).await.unwrap();
                upstream.send(body).await.unwrap();
                forwarded.send(()).unwrap();
                // Hold the rest of the upload here until the mutation's socket
                // actually closes. The proxy must not initiate that disconnect.
                if let Err(error) = tokio::io::copy(client.get_mut(), &mut tokio::io::sink()).await
                {
                    assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
                }
                drop(client);
                upstream.get_mut().shutdown().await.unwrap();
                assert!(!matches!(upstream.next().await, Some(Ok(_))));
                drop(upstream);

                let (mut retry, _) = proxy.accept().await.unwrap();
                let mut host = TcpStream::connect(addr).await.unwrap();
                let result = copy_bidirectional(&mut retry, &mut host).await;
                if let Err(error) = result {
                    assert!(matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
                    ));
                }
                anchor_proxy.abort();
            }
        });
        let client = RemoteHostConnection::connect_websocket(
            &endpoint,
            TlsTrust::System,
            bearer,
            &pairing.root_id,
            instance,
        )
        .await
        .unwrap();
        let upload = || {
            client.mutate_with(
                "probe",
                "commit",
                json!({"keyId":"large"}),
                Attachments::from([(
                    "secret".into(),
                    ReadResource::utf8("x".repeat(LARGE_UPLOAD)),
                )]),
                |_| {},
            )
        };
        {
            let pending = upload();
            tokio::pin!(pending);
            tokio::select! {
                result = &mut pending => panic!("upload completed before cancellation: {result:?}"),
                result = first_chunk => result.unwrap(),
            }
        }

        // Each upload reserves more than half of the Host's attachment window.
        // A leaked reservation would reject this retry before another upload starts.
        assert_eq!(upload().await.unwrap(), json!({"saved":true}));
        drop(client);
        stop.cancel();
        server.await.unwrap().unwrap();
        proxy_task.await.unwrap();
    })
    .await
    .expect("upload cancellation timed out");
}

#[tokio::test]
async fn websocket_bearer_admission_uses_tls_and_the_endpoint_server_name() {
    use maka_host_runtime::{
        application::host::{
            Channel, Client,
            websocket::{WebSocketListener, channel_opener},
        },
        ipc::LocalListener,
    };
    use maka_remote_client::TlsTrust;
    use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
    use tokio::{
        io::copy_bidirectional,
        net::{TcpListener, TcpStream},
    };
    use tokio_rustls::TlsAcceptor;

    timeout(DEADLINE, async {
        let (_dir, host) = logs_host().await;
        #[cfg(unix)]
        let socket = _dir.path().join("ws-host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-client-test-{}", Uuid::new_v4()));
        let error = host
            .prepare_peer_pairing(PeerPairingOptions {
                host_name: "Logs fixture".into(),
                label: None,
                ttl_secs: None,
            })
            .await
            .err()
            .expect("a WebSocket Bearer is not a native pairing route");
        assert!(error.contains("no active native relay routes"));

        let local = LocalListener::bind(&socket).unwrap();
        let upstream = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
            .await
            .unwrap();
        let addr = upstream.local_addr().unwrap();
        let pairing = host
            .prepare_access("wss-client-fixture".into())
            .await
            .unwrap();
        let cancel = CancellationToken::new();
        let server = tokio::spawn({
            let cancel = cancel.clone();
            async move { host.serve(local, Some(upstream), cancel).await }
        });
        let bearer: Arc<str> = pairing.credential.into();
        let instance: Arc<str> = Uuid::new_v4().to_string().into();
        // Fixture activation of a legacy Bearer, not signed ticket redemption.
        Client::finalize_access(
            channel_opener(
                Arc::new(move || {
                    Box::pin(
                        async move { Ok(Box::new(TcpStream::connect(addr).await?) as Channel) },
                    )
                }),
                bearer.clone(),
            ),
            instance.clone(),
            None,
        )
        .await
        .unwrap();

        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let der = cert.cert.der().clone();
        let config = ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![der.clone()],
            PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
        )
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "wss://localhost:{}/runtime-host",
            listener.local_addr().unwrap().port()
        );
        let proxy = tokio::spawn(async move {
            let mut streams = tokio::task::JoinSet::new();
            // Reject the untrusted connection before opening the upstream.
            let (stream, _) = listener.accept().await.unwrap();
            assert!(acceptor.accept(stream).await.is_err());
            for _ in 0..2 {
                // anchor and one RPC
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = acceptor.accept(stream).await.unwrap();
                assert_eq!(stream.get_ref().1.server_name(), Some("localhost"));
                streams.spawn(async move {
                    let mut upstream = TcpStream::connect(addr).await.unwrap();
                    // Host streams can drop after a terminal application frame without
                    // closing the underlying TLS tunnel. Terminal frames are asserted by
                    // the caller; copy errors other than peer disconnect still fail.
                    if let Err(error) = copy_bidirectional(&mut stream, &mut upstream).await {
                        assert!(
                            matches!(
                                error.kind(),
                                std::io::ErrorKind::UnexpectedEof
                                    | std::io::ErrorKind::ConnectionReset
                            ),
                            "{error}"
                        );
                    }
                });
            }
            streams.join_all().await;
        });

        assert!(
            RemoteHostConnection::connect_websocket(
                &endpoint,
                TlsTrust::System,
                bearer.clone(),
                &pairing.root_id,
                instance.clone(),
            )
            .await
            .is_err()
        );
        let client = RemoteHostConnection::connect_websocket(
            &endpoint,
            TlsTrust::CaDer(der.to_vec()),
            bearer,
            &pairing.root_id,
            instance,
        )
        .await
        .unwrap();
        read_logs(&client).await;
        client.close().await.unwrap();
        cancel.cancel();
        server.await.unwrap().unwrap();
        proxy.await.unwrap();
    })
    .await
    .expect("WSS Host test timed out");
}
