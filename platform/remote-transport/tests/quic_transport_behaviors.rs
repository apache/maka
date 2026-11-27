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

use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    host::{
        Client, Configuration, Host, LifecycleMode, Options, PeerId, PeerPairingOptions, VERSION,
        protocol::{Opening, Request, Response},
    },
    logs,
    transport::{GATEWAY, Reply, wire},
};
use maka_packages::Package;
use maka_remote_pairing::{DeviceIdentity, RelayEndpoint, SignedPairingTicket};
use maka_remote_transport::{
    PeerEndpoint, Relay,
    host::HostPeerTransport,
    server::{RelayServer, RelayTls},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
    time::timeout,
};
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
    let gateway = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{"hostLogs":{"contract":contract,"cardinality":{"kind":"one"}}}
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    let source = store.commit_application(
        deployment, 0,
        serde_json::from_value(json!({"instances":{
            "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
            "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                "bindings":{"hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}]}}
        }})).unwrap(),
        vec![], vec![logs, gateway],
    ).await.unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read","watch"],"recovery":false}}
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
        Default::default(),
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

async fn https_relay() -> (RelayServer, RelayEndpoint, RelayTls) {
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
    (relay, endpoint, tls)
}

async fn read_logs(client: &Client) {
    let mut call = client
        .call(
            "hostLogs",
            "read".into(),
            json!({"position":{"kind":"tail"}}),
            Default::default(),
        )
        .await
        .unwrap();
    call.start().await.unwrap();
    let Reply::Finished { result, cleanup } = call.receive().await.unwrap() else {
        panic!("HostLogs.read did not finish");
    };
    cleanup.unwrap();
    let page: maka_host_runtime::logs::HostLogPage =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(page, maka_host_runtime::logs::HostLogPage::Missing);
}

#[tokio::test]
async fn relay_requires_the_configured_bearer() {
    timeout(DEADLINE, async {
        let (server, route, tls) = https_relay().await;
        // The relay's HTTPS certificate can also be trusted via explicit DER.
        let route = RelayEndpoint {
            cert_sha256: None,
            ..route
        };
        for token in [None, Some("not-the-bearer"), Some(TOKEN)] {
            let relay = Relay::new(
                &route,
                Some(tls.certificate_der().to_vec()),
                token.map(str::to_owned),
            )
            .unwrap();
            let device = DeviceIdentity::generate().unwrap();
            let endpoint = PeerEndpoint::bind(&device, &[relay], true).await.unwrap();
            let result = endpoint.wait_for_relay().await;
            if token == Some(TOKEN) {
                result.unwrap();
            } else {
                let error = result.unwrap_err();
                assert!(
                    error.to_string().contains("invalid relay Bearer token"),
                    "{error}"
                );
            }
            endpoint.close().await;
        }
        server.shutdown().await.unwrap();
    })
    .await
    .expect("relay auth test did not finish");
}

#[tokio::test]
async fn dialing_classifies_rejection_by_every_configured_relay() {
    use maka_remote_transport::RelayAuthRejected;
    use tokio::{
        io::{AsyncBufReadExt, BufReader},
        net::TcpListener,
    };

    timeout(DEADLINE * 2, async {
        let (first, first_route, tls) = https_relay().await;
        let addr = "127.0.0.1:0".parse().unwrap();
        let second = RelayServer::bind(None, Some(addr), Some(addr), Some(&tls), Some(TOKEN))
            .await
            .unwrap();
        let second_route = RelayEndpoint {
            url: format!("https://{}", second.https_addr().unwrap()),
            quic_port: Some(second.quic_addr().unwrap().port()),
            cert_sha256: second.cert_sha256().map(hex::encode),
        };

        // Real upgrades guard the WebSocket error downcast against upstream drift.
        // A proxy can require auth just at /relay or for every request, leaving
        // iroh with no home relay.
        let mut proxies = Vec::new();
        let mut http_routes = Vec::new();
        for (probe_ok, status) in [(true, "401 Unauthorized"), (false, "401 Unauthorized"), (false, "403 Forbidden")] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            http_routes.push(RelayEndpoint {
                url: format!("http://{}", listener.local_addr().unwrap()),
                cert_sha256: None,
                quic_port: None,
            });
            proxies.push(tokio::spawn(async move {
                let mut requests = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        Some(result) = requests.join_next() => result.unwrap(),
                        result = listener.accept() => {
                            let (stream, _) = result.unwrap();
                            requests.spawn(async move {
                                let mut stream = BufReader::new(stream);
                                let mut line = String::new();
                                if stream.read_line(&mut line).await.unwrap() == 0 {
                                    return;
                                }
                                let upgrade = line.starts_with("GET /relay ");
                                loop {
                                    line.clear();
                                    if stream.read_line(&mut line).await.unwrap() == 0 {
                                        return;
                                    }
                                    if line == "\r\n" {
                                        break;
                                    }
                                }
                                let status = if upgrade || !probe_ok { status } else { "200 OK" };
                                let response = format!(
                                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                );
                                // iroh may cancel a probe once it selects a route.
                                if let Err(error) = stream.get_mut().write_all(response.as_bytes()).await {
                                    assert!(matches!(error.kind(),
                                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset));
                                }
                            });
                        }
                    }
                }
            }));
        }

        for (case, routes) in [
            ("two relay handshake denials", vec![&first_route, &second_route]),
            ("probe 200, upgrade 401", vec![&http_routes[0]]),
            ("probe 401, upgrade 401", vec![&http_routes[1]]),
            ("probe 403, upgrade 403", vec![&http_routes[2]]),
            ("mixed 401 and 403", vec![&http_routes[0], &http_routes[2]]),
        ] {
            let routes: Vec<_> = routes.iter().map(|route| Relay::new(route, None, None).unwrap()).collect();
            let client = DeviceIdentity::generate().unwrap();
            let target = DeviceIdentity::generate().unwrap().public_key();
            let endpoint = PeerEndpoint::bind(&client, &routes, false).await.unwrap();
            let Err(error) = timeout(Duration::from_secs(6), endpoint.connect(&target)).await
                .unwrap_or_else(|_| panic!("{case}: no auth rejection before deadline; check iroh-relay's upgrade error chain")) else {
                panic!("{case}: unauthorized relay admitted client");
            };
            assert!(error.is::<RelayAuthRejected>(), "{case}: {error:#}");
            endpoint.close().await;
        }

        for proxy in proxies {
            proxy.abort();
        }
        first.shutdown().await.unwrap();
        second.shutdown().await.unwrap();
    })
    .await
    .expect("all relay authorization failures must be reported without a QUIC dial timeout");
}

#[tokio::test]
async fn pairing_rpc_multiplexing_reconnect_and_revocation_over_self_hosted_relay() {
    timeout(DEADLINE, async {
        let (relay, route, _) = https_relay().await;
        let configured = || [Relay::new(&route, None, Some(TOKEN.into())).unwrap()];
        let (_dir, host) = logs_host().await;
        let host_key = host.device_identity().public_key();
        let transport = HostPeerTransport::bind(&host, &configured(), false)
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

        let device = DeviceIdentity::generate().unwrap();
        let peer_id = PeerId::new(device.public_key().to_string()).unwrap();
        // Advertise a QAD port that receives UDP but never answers. A cold
        // dialing endpoint must not wait for iroh's 3 s net-report deadline.
        let blackhole = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let client_route = RelayEndpoint {
            quic_port: Some(blackhole.local_addr().unwrap().port()),
            ..route.clone()
        };
        let client_relay = Relay::new(&client_route, None, Some(TOKEN.into())).unwrap();
        let endpoint = PeerEndpoint::bind(&device, &[client_relay], false)
            .await
            .unwrap();
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
        let ticket = SignedPairingTicket::parse_and_verify_uri(&invite.uri, now).unwrap();
        let connection = timeout(
            Duration::from_millis(2500),
            endpoint.connect_ticket(&ticket),
        )
        .await
        .expect("dial waited for unanswered UDP address discovery")
        .unwrap();
        assert!(!connection.path_summary().unwrap().direct);
        let (accepted_id, sas) = accepted.recv().await.unwrap();
        assert_eq!(accepted_id, peer_id);
        assert_eq!(sas.len(), 6);
        assert_eq!(sas, connection.export_sas().unwrap());
        assert!(connection.connect_client().await.is_err());

        let receipt = connection.redeem_pairing(&ticket, None).await.unwrap();
        assert_eq!(receipt.peer_id, peer_id.as_str());
        let mut client = connection.connect_client().await.unwrap();
        tokio::join!(read_logs(&client), read_logs(&client), read_logs(&client));
        assert!(connection.redeem_pairing(&ticket, None).await.is_err());
        assert!(matches!(
            accepted.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        let mut anchor = connection.open_bi().await.unwrap();
        wire::write(
            &mut anchor,
            &Opening {
                version: VERSION,
                epoch: Some(host.epoch()),
                client_instance: None,
                request: Request::Connect,
            },
        )
        .await
        .unwrap();
        let Response::Connected(connected) = wire::Reader::new(&mut anchor).read().await.unwrap()
        else {
            panic!("Host did not admit paired device");
        };
        let outsider = DeviceIdentity::generate().unwrap();
        let outside_endpoint = PeerEndpoint::bind(&outsider, &configured(), true)
            .await
            .unwrap();
        let unauthorised = outside_endpoint.connect(&host_key).await.unwrap();
        assert_eq!(
            accepted.recv().await.unwrap().0.as_str(),
            outsider.public_key().to_string()
        );
        let mut stream = unauthorised.open_bi().await.unwrap();
        wire::write(
            &mut stream,
            &Opening {
                version: VERSION,
                epoch: Some(host.epoch()),
                client_instance: None,
                request: Request::Call {
                    session: connected.session,
                },
            },
        )
        .await
        .unwrap();
        stream.shutdown().await.unwrap();
        // A real session's HostLogs channel is fenced before any RPC prelude.
        assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
        outside_endpoint.close().await;

        client.close().await.unwrap();
        connection.close();
        endpoint.close().await;
        let replacement = PeerEndpoint::bind(&device, &configured(), true)
            .await
            .unwrap();
        let connection = replacement.connect(&host_key).await.unwrap();
        assert!(!connection.path_summary().unwrap().direct);
        assert_eq!(accepted.recv().await.unwrap().0, peer_id);
        let mut client = connection.connect_client().await.unwrap();
        read_logs(&client).await;
        let second = replacement.connect(&host_key).await.unwrap();
        assert_eq!(accepted.recv().await.unwrap().0, peer_id);
        let mut second_client = second.connect_client().await.unwrap();
        assert!(host.revoke_peer_access(peer_id).await.unwrap());
        for conn in [&connection, &second] {
            assert!(
                conn.closed()
                    .await
                    .to_string()
                    .contains("peer access revoked")
            );
            assert!(conn.open_bi().await.is_err());
        }
        assert!(client.refresh().await.is_err());
        assert!(second_client.refresh().await.is_err());
        let reconnected = replacement.connect(&host_key).await.unwrap();
        assert!(reconnected.connect_client().await.is_err());

        cancel.cancel();
        peer_server.await.unwrap().unwrap();
        host_server.await.unwrap().unwrap();
        replacement.close().await;
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("end-to-end peer transport test did not finish");
}

#[tokio::test]
async fn full_host_refuses_new_connections_until_a_slot_is_released() {
    exercise_connection_limit(false).await;
}

#[tokio::test]
async fn unpaired_connection_expires_and_releases_its_slot() {
    exercise_connection_limit(true).await;
}

async fn exercise_connection_limit(expire: bool) {
    timeout(DEADLINE, async {
        let (relay, route, _) = https_relay().await;
        let configured = || [Relay::new(&route, None, Some(TOKEN.into())).unwrap()];
        let (_dir, host) = logs_host().await;
        let host_key = host.device_identity().public_key();
        let pairing_timeout = if expire {
            Duration::from_secs(1)
        } else {
            DEADLINE
        };
        let transport = HostPeerTransport::bind(&host, &configured(), true)
            .await
            .unwrap()
            .with_connection_limits(1.try_into().unwrap(), pairing_timeout);
        transport.wait_for_relay().await.unwrap();
        let (sender, _ingress) = HostPeerTransport::ingress();
        let cancel = CancellationToken::new();
        let (observed, mut accepted) = mpsc::unbounded_channel();
        let server = tokio::spawn(transport.serve(sender, cancel.clone(), move |id, _| {
            observed.send(id.clone()).unwrap();
        }));
        let first = DeviceIdentity::generate().unwrap();
        let second = DeviceIdentity::generate().unwrap();
        let first_endpoint = PeerEndpoint::bind(&first, &configured(), true)
            .await
            .unwrap();
        let second_endpoint = PeerEndpoint::bind(&second, &configured(), true)
            .await
            .unwrap();
        let connection = first_endpoint.connect(&host_key).await.unwrap();
        assert_eq!(
            accepted.recv().await.unwrap().as_str(),
            first.public_key().to_string()
        );
        if expire {
            assert!(
                connection
                    .closed()
                    .await
                    .to_string()
                    .contains("peer pairing window expired")
            );
        } else {
            let Err(error) = second_endpoint.connect(&host_key).await else {
                panic!("Host accepted a second connection with only one slot");
            };
            assert!(
                error.to_string().to_lowercase().contains("refused"),
                "{error:#}"
            );
            first_endpoint.close().await;
        }

        // A close acknowledged by the dialer can precede the accept loop
        // reaping the completed connection task.
        let replacement = loop {
            match second_endpoint.connect(&host_key).await {
                Ok(connection) => break connection,
                Err(error) if error.to_string().to_lowercase().contains("refused") => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("unexpected dial error: {error:#}"),
            }
        };
        assert_eq!(
            accepted.recv().await.unwrap().as_str(),
            second.public_key().to_string()
        );
        replacement.close();
        cancel.cancel();
        server.await.unwrap().unwrap();
        first_endpoint.close().await;
        second_endpoint.close().await;
        host.shutdown().await.unwrap();
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("Host failed to reclaim a connection slot");
}

#[tokio::test]
async fn only_the_connected_home_relay_is_published_and_disconnection_withdraws_it() {
    timeout(DEADLINE, async {
        // Reserve a non-listening TCP port for the unreachable candidate.
        let dead = tokio::net::TcpSocket::new_v4().unwrap();
        dead.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let relay = RelayServer::bind(Some("127.0.0.1:0".parse().unwrap()), None, None, None, None)
            .await
            .unwrap();
        let route = |addr| RelayEndpoint {
            url: format!("http://{addr}"),
            cert_sha256: None,
            quic_port: None,
        };
        let good = route(relay.http_addr().unwrap());
        let routes = [route(dead.local_addr().unwrap()), good.clone()]
            .map(|route| Relay::new(&route, None, None).unwrap());
        let (_dir, host) = logs_host().await;
        let transport = HostPeerTransport::bind(&host, &routes, true).await.unwrap();
        let urls = |routes: Vec<RelayEndpoint>| {
            routes
                .into_iter()
                .map(|route| route.url)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            urls(transport.wait_for_relay().await.unwrap()),
            [good.url.as_str()]
        );
        assert_eq!(urls(host.native_relays()), [good.url]);
        let cancel = CancellationToken::new();
        let (sender, _ingress) = HostPeerTransport::ingress();
        let server = tokio::spawn(transport.serve(sender, cancel.clone(), |_, _| {}));

        relay.shutdown().await.unwrap();
        while !host.native_relays().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cancel.cancel();
        server.await.unwrap().unwrap();
        host.shutdown().await.unwrap();
    })
    .await
    .expect("the Host did not track the live home relay");
}

#[tokio::test]
async fn lagged_revocation_receiver_closes_even_unrelated_connections() {
    timeout(DEADLINE, async {
        let (relay, route, _) = https_relay().await;
        let routes = [Relay::new(&route, None, Some(TOKEN.into())).unwrap()];
        let (_dir, host) = logs_host().await;
        let transport = HostPeerTransport::bind(&host, &routes, true).await.unwrap();
        transport.wait_for_relay().await.unwrap();
        let (sender, _ingress) = HostPeerTransport::ingress();
        let cancel = CancellationToken::new();
        let (notify, observed) = tokio::sync::oneshot::channel();
        let mut notify = Some(notify);
        let serve = transport.serve(sender, cancel.clone(), move |_, _| {
            notify.take().unwrap().send(()).unwrap();
        });
        tokio::pin!(serve);
        let identity = DeviceIdentity::generate().unwrap();
        let peer = PeerId::new(identity.public_key().to_string()).unwrap();
        host.grant_peer_access(peer).await.unwrap();
        let client = PeerEndpoint::bind(&identity, &routes, true).await.unwrap();
        let connect = async {
            let connection = client
                .connect(&host.device_identity().public_key())
                .await
                .unwrap();
            observed.await.unwrap();
            connection
        };
        let connection = tokio::select! {
            conn = connect => conn,
            result = &mut serve => panic!("Host transport stopped during dial: {result:?}"),
        };

        // Hold the transport supervisor at its current poll point until a
        // witness subscription proves the real Host's broadcast has overflowed.
        let unrelated =
            PeerId::new(DeviceIdentity::generate().unwrap().public_key().to_string()).unwrap();
        let mut witness = host.subscribe_revoked_peers();
        // Host's broadcast retains 64 events; one more forces Lagged.
        for _ in 0..65 {
            host.grant_peer_access(unrelated.clone()).await.unwrap();
            assert!(host.revoke_peer_access(unrelated.clone()).await.unwrap());
        }
        assert!(matches!(
            witness.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
        ));
        let closed = tokio::select! {
            reason = connection.closed() => reason,
            result = &mut serve => panic!("Host transport stopped during revocation: {result:?}"),
        };
        assert!(
            closed
                .to_string()
                .contains("peer revocation receiver lagged")
        );

        cancel.cancel();
        serve.await.unwrap();
        client.close().await;
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("revocation lag test did not finish");
}

#[tokio::test]
async fn http_and_https_listeners_share_the_same_relay() {
    timeout(DEADLINE, async {
        let tls = RelayTls::self_signed(vec!["127.0.0.1".into()]).unwrap();
        let addr = "127.0.0.1:0".parse().unwrap();
        let relay = RelayServer::bind(Some(addr), Some(addr), None, Some(&tls), None)
            .await
            .unwrap();
        let route = |url, cert_sha256| {
            Relay::new(
                &RelayEndpoint {
                    url,
                    cert_sha256,
                    quic_port: None,
                },
                None,
                None,
            )
            .unwrap()
        };
        let https = route(
            format!("https://{}", relay.https_addr().unwrap()),
            relay.cert_sha256().map(hex::encode),
        );
        let http = route(format!("http://{}", relay.http_addr().unwrap()), None);

        let (_dir, host) = logs_host().await;
        let transport = HostPeerTransport::bind(&host, &[https], true)
            .await
            .unwrap();
        transport.wait_for_relay().await.unwrap();
        let (sender, mut ingress) = HostPeerTransport::ingress();
        let cancel = CancellationToken::new();
        let server = tokio::spawn(transport.serve(sender, cancel.clone(), |_, _| {}));
        let client = PeerEndpoint::bind(&DeviceIdentity::generate().unwrap(), &[http], true)
            .await
            .unwrap();
        let conn = client
            .connect(&host.device_identity().public_key())
            .await
            .unwrap();
        assert!(!conn.path_summary().unwrap().direct);

        let mut stream = conn.open_bi().await.unwrap();
        stream.write_all(b"request").await.unwrap();
        stream.shutdown().await.unwrap();
        let mut server_stream = ingress.recv().await.unwrap().stream;
        let mut request = Vec::new();
        server_stream.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"request");
        server_stream.write_all(b"response").await.unwrap();
        server_stream.shutdown().await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        assert_eq!(response, b"response");

        cancel.cancel();
        server.await.unwrap().unwrap();
        client.close().await;
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("HTTP and HTTPS did not relay between their respective clients");
}

#[tokio::test]
async fn startup_skips_an_auth_rejected_home_relay_before_serving_rpc() {
    use iroh_relay::server::{
        Access, AccessControl, ClientRequest, RelayConfig, Server, ServerConfig,
    };
    use tokio::{net::TcpSocket, sync::Notify};

    #[derive(Debug)]
    struct Reject {
        attempted: Arc<Notify>,
        other_ready: CancellationToken,
    }

    impl AccessControl for Reject {
        async fn on_connect(&self, _: &ClientRequest) -> Access {
            self.attempted.notify_one();
            self.other_ready.cancelled().await;
            Access::Deny {
                reason: Some("test relay rejects registration".into()),
            }
        }
    }

    timeout(DEADLINE, async {
        let attempted = Arc::new(Notify::new());
        let other_ready = CancellationToken::new();
        let mut bad_config =
            RelayConfig::new("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap());
        bad_config.access = Arc::new(Reject {
            attempted: attempted.clone(),
            other_ready: other_ready.clone(),
        });
        let mut config = ServerConfig::default();
        config.relay = Some(bad_config);
        let bad = Server::spawn(config).await.unwrap();

        // Reserve the second port without listening. This makes the rejecting
        // relay the only reachable candidate until its registration is tried.
        let reserved = TcpSocket::new_v4().unwrap();
        reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let good_addr = reserved.local_addr().unwrap();
        let route = |addr| {
            Relay::new(
                &RelayEndpoint {
                    url: format!("http://{addr}"),
                    cert_sha256: None,
                    quic_port: None,
                },
                None,
                None,
            )
            .unwrap()
        };

        let (_dir, host) = logs_host().await;
        let transport = HostPeerTransport::bind(
            &host,
            &[route(bad.http_addr().unwrap()), route(good_addr)],
            true,
        )
        .await
        .unwrap();
        let bring_up_other = async {
            attempted.notified().await;
            drop(reserved);
            let good = RelayServer::bind(Some(good_addr), None, None, None, None)
                .await
                .unwrap();
            other_ready.cancel();
            good
        };
        let (ready, good) = tokio::join!(transport.wait_for_relay(), bring_up_other);
        assert_eq!(
            serde_json::to_value(ready.unwrap()).unwrap(),
            json!([{ "url": format!("http://{good_addr}"), "quicPort": null, "certSha256": null }])
        );

        let cancel = CancellationToken::new();
        let (sender, ingress) = HostPeerTransport::ingress();
        let peer_server = tokio::spawn(transport.serve(sender, cancel.clone(), |_, _| {}));
        let host_server = tokio::spawn({
            let host = host.clone();
            let cancel = cancel.clone();
            async move { host.serve_peer_streams(ingress, cancel).await }
        });
        let device = DeviceIdentity::generate().unwrap();
        host.grant_peer_access(PeerId::new(device.public_key().to_string()).unwrap())
            .await
            .unwrap();
        let endpoint = PeerEndpoint::bind(&device, &[route(good_addr)], true)
            .await
            .unwrap();
        let connection = endpoint
            .connect(&host.device_identity().public_key())
            .await
            .unwrap();
        let mut client = connection.connect_client().await.unwrap();
        read_logs(&client).await;
        client.close().await.unwrap();
        endpoint.close().await;
        cancel.cancel();
        peer_server.await.unwrap().unwrap();
        host_server.await.unwrap().unwrap();
        good.shutdown().await.unwrap();
        bad.shutdown().await.unwrap();
    })
    .await
    .expect("multi-relay Host startup did not fail over");
}

#[tokio::test]
async fn ipv6_http_relay_registers_but_https_literal_is_rejected_at_configuration() {
    timeout(DEADLINE, async {
        let relay = RelayServer::bind(Some("[::1]:0".parse().unwrap()), None, None, None, None)
            .await
            .unwrap();
        let config = RelayEndpoint {
            url: format!("http://{}", relay.http_addr().unwrap()),
            quic_port: None,
            cert_sha256: None,
        };
        let client = PeerEndpoint::bind(
            &DeviceIdentity::generate().unwrap(),
            &[Relay::new(&config, None, None).unwrap()],
            true,
        )
        .await
        .unwrap();
        client.wait_for_relay().await.unwrap();
        client.close().await;
        let https = RelayEndpoint {
            url: config.url.replacen("http:", "https:", 1),
            ..config
        };
        let Err(error) = Relay::new(&https, None, None) else {
            panic!("HTTPS IPv6 literal must fail before dialing");
        };
        assert!(matches!(
            error.downcast_ref(),
            Some(maka_remote_pairing::PairingError::HttpsRelayIpv6)
        ));
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("IPv6 HTTP relay registration timed out");
}
