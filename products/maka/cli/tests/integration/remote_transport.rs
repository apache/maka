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

use crate::host_support as host;

use maka_host_runtime::{
    application::{host::Client, transport::Reply},
    logs::HostLogPage,
};
use maka_remote_pairing::{DeviceIdentity, SignedPairingTicket};
use maka_remote_transport::{PeerEndpoint, Relay};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    net::unix::pipe::{Receiver, Sender},
    process::{Child, Command},
    time::timeout,
};

const TOKEN: &str = "process-test-bearer";

async fn spawn_ready(mut command: Command, stderr: Stdio) -> (Child, Value) {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    assert_ne!(
        stdout.read_line(&mut ready).await.unwrap(),
        0,
        "process exited before ready"
    );
    let ready: Value = serde_json::from_str(&ready).unwrap();
    assert_eq!(ready["kind"], "ready");
    (child, ready)
}

async fn host_sas(stderr: &mut BufReader<impl AsyncRead + Unpin>, peer_id: &str) -> String {
    let mut line = String::new();
    loop {
        line.clear();
        assert_ne!(
            stderr.read_line(&mut line).await.unwrap(),
            0,
            "Host exited before reporting its pairing SAS"
        );
        if let Ok(event) = serde_json::from_str::<Value>(&line)
            && event["kind"] == "peerSas"
            && event["peerId"] == peer_id
        {
            return event["sas"].as_str().unwrap().to_owned();
        }
    }
}

fn fill_stderr_pipe(mut writer: io::PipeWriter) {
    // The clone and the Host's operator stderr share the write-side flags.
    // Fill without ever blocking here, then restore blocking I/O for the Host.
    let nonblocking = Sender::from_owned_fd(writer.try_clone().unwrap().into()).unwrap();
    for chunk in [&[b'x'; 4096][..], b"x"] {
        loop {
            match writer.write(chunk) {
                Ok(0) => panic!("could not fill stderr pipe"),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("fill stderr pipe: {error}"),
            }
        }
    }
    drop(nonblocking.into_blocking_fd().unwrap());
}

async fn stop(mut child: Child) {
    let pid = child.id().unwrap().try_into().unwrap();
    // SAFETY: the child has not been reaped, so the PID still names our child.
    let result = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(
        result,
        0,
        "SIGTERM failed: {}",
        std::io::Error::last_os_error()
    );
    let exit = child.wait().await.unwrap();
    assert!(exit.success(), "{exit}");
}

async fn output(mut cmd: Command) -> Value {
    let result = cmd.kill_on_drop(true).output().await.unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}

async fn read_logs(client: &mut Client) {
    while client
        .catalogue()
        .describe("hostLogs")
        .unwrap()
        .registration_epoch
        .is_none()
    {
        assert!(client.catalogue().startup_error().is_none());
        client.refresh().await.unwrap();
        tokio::task::yield_now().await;
    }

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
    let _: HostLogPage = serde_json::from_value(result.unwrap()).unwrap();
}

#[tokio::test]
async fn self_hosted_relay_cli_pairs_reconnects_with_full_stderr_and_revokes_a_device() {
    // Includes cold product startup and two separate finite CLI invocations.
    timeout(Duration::from_secs(60), async {
        let sandbox = host::Sandbox::new().await.unwrap();
        let executable = crate::maka_executable();
        let command = || host::command_for(&executable, &sandbox.home, &sandbox.workspace);

        let cert_der = sandbox.directory.path().join("relay.der");
        let mut relay = command();
        relay
            .env("TEST_RELAY_TOKEN", TOKEN)
            .args([
                "relay",
                "--https",
                "127.0.0.1:0",
                "--quic",
                "127.0.0.1:0",
                "--self-signed",
                "--tls-san",
                "127.0.0.1",
                "--auth-token-env",
                "TEST_RELAY_TOKEN",
                "--cert-der-out",
            ])
            .arg(&cert_der);
        let (relay, ready) = spawn_ready(relay, Stdio::inherit()).await;
        assert!(!tokio::fs::read(&cert_der).await.unwrap().is_empty());
        let relay_url = format!("https://{}", ready["httpsAddr"].as_str().unwrap());
        let quic = ready["quicAddr"]
            .as_str()
            .unwrap()
            .parse::<std::net::SocketAddr>()
            .unwrap()
            .port()
            .to_string();
        let pin = ready["certSha256"].as_str().unwrap();

        let mut serve = command();
        serve
            .env("TEST_RELAY_TOKEN", TOKEN)
            .args([
                "host",
                "serve",
                "--relay",
                &relay_url,
                "--relay-quic-port",
                &quic,
                "--relay-cert-sha256",
                pin,
                "--relay-auth-token-env",
                "TEST_RELAY_TOKEN",
                "--relay-only",
                "--root",
            ])
            .arg(&sandbox.root);
        let (pipe_reader, pipe_writer) = io::pipe().unwrap();
        let mut stderr = BufReader::new(Receiver::from_owned_fd(pipe_reader.into()).unwrap());
        let (server, ready) = spawn_ready(serve, pipe_writer.try_clone().unwrap().into()).await;
        assert_eq!(ready["relays"][0]["url"], relay_url);
        assert!(!ready.to_string().contains(TOKEN));

        let mut prepare = command();
        prepare
            .args([
                "host",
                "access",
                "invite",
                "--host-name",
                "Remote test Host",
                "--root",
            ])
            .arg(&sandbox.root);
        let invite = output(prepare).await;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap();
        let ticket =
            SignedPairingTicket::parse_and_verify_uri(invite["uri"].as_str().unwrap(), now)
                .unwrap();
        assert_eq!(
            ticket.payload().host_peer_id,
            ready["peerId"].as_str().unwrap()
        );
        assert_eq!(
            serde_json::to_value(&ticket.payload().relays).unwrap(),
            ready["relays"]
        );

        let device = DeviceIdentity::generate().unwrap();
        let relay_config =
            Relay::new(&ticket.payload().relays[0], None, Some(TOKEN.into())).unwrap();
        let endpoint = PeerEndpoint::bind(&device, &[relay_config], true)
            .await
            .unwrap();
        let connection = endpoint.connect_ticket(&ticket).await.unwrap();
        let host_sas = host_sas(&mut stderr, &device.public_key().to_string()).await;
        assert_eq!(host_sas, connection.export_sas().unwrap());
        let receipt = connection
            .redeem_pairing(&ticket, Some("CLI fixture".into()))
            .await
            .unwrap();
        let mut client = connection.connect_client().await.unwrap();
        assert!(!connection.path_summary().unwrap().direct);
        read_logs(&mut client).await;
        client.close().await.unwrap();
        connection.close();

        // Keep the read end open without consuming any further stderr.
        // The next authentication attempts to report SAS to a full pipe.
        fill_stderr_pipe(pipe_writer);
        let connection = endpoint.connect_ticket(&ticket).await.unwrap();
        let mut client = connection.connect_client().await.unwrap();
        read_logs(&mut client).await;

        let mut peers = command();
        peers
            .args(["host", "access", "peers", "--root"])
            .arg(&sandbox.root);
        let listed = output(peers).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["peerId"], receipt.peer_id);

        let mut revoke = command();
        revoke
            .args([
                "host",
                "access",
                "revoke",
                "--peer-id",
                &receipt.peer_id,
                "--root",
            ])
            .arg(&sandbox.root);
        assert_eq!(output(revoke).await, json!({"revoked": true}));
        assert!(
            connection
                .closed()
                .await
                .to_string()
                .contains("peer access revoked")
        );
        assert!(client.refresh().await.is_err());
        endpoint.close().await;
        stop(server).await;
        drop(stderr);
        stop(relay).await;
    })
    .await
    .expect("CLI remote transport test did not finish");
}

#[tokio::test]
async fn host_discovery_waits_for_the_connected_home_relay() {
    use iroh_relay::server::{
        Access, AccessControl, ClientRequest, RelayConfig, Server, ServerConfig,
    };
    use maka_host_runtime::application::host::discovery;
    use std::sync::Arc;
    use tokio::{net::TcpSocket, sync::Notify};

    #[derive(Debug, Default)]
    struct RegistrationGate {
        attempted: Notify,
        allow: Notify,
    }

    impl AccessControl for RegistrationGate {
        async fn on_connect(&self, _: &ClientRequest) -> Access {
            self.attempted.notify_one();
            self.allow.notified().await;
            Access::Allow
        }
    }

    timeout(Duration::from_secs(45), async {
        let sandbox = host::Sandbox::new().await.unwrap();
        let executable = crate::maka_executable();
        let dead = TcpSocket::new_v4().unwrap();
        dead.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let dead_url = format!("http://{}", dead.local_addr().unwrap());
        let gate = Arc::new(RegistrationGate::default());
        let mut relay = RelayConfig::new("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap());
        relay.access = gate.clone();
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        let relay = Server::spawn(config).await.unwrap();
        let good_url = format!("http://{}", relay.http_addr().unwrap());
        let mut serve = host::command_for(&executable, &sandbox.home, &sandbox.workspace);
        serve
            .args([
                "host",
                "serve",
                "--relay",
                &dead_url,
                "--relay",
                &good_url,
                "--relay-only",
                "--root",
            ])
            .arg(&sandbox.root);
        let check_registration = async {
            gate.attempted.notified().await;
            assert_eq!(
                discovery::read(&sandbox.root).unwrap_err().kind(),
                io::ErrorKind::NotFound,
                "Host published discovery before completing relay registration"
            );
            gate.allow.notify_one();
        };
        let ((child, ready), ()) =
            tokio::join!(spawn_ready(serve, Stdio::inherit()), check_registration);
        assert_eq!(
            ready["relays"],
            json!([{ "url": good_url, "quicPort": null, "certSha256": null }])
        );
        assert_eq!(
            discovery::read(&sandbox.root)
                .unwrap()
                .endpoint
                .to_str()
                .unwrap(),
            ready["socketPath"].as_str().unwrap()
        );
        stop(child).await;
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("Host did not become discoverable after relay registration");
}

#[tokio::test]
async fn saved_remote_transport_applies_live_and_starts_after_restart() {
    use iroh_relay::server::{RelayConfig, Server, ServerConfig};
    use maka_host_runtime::application::host::{
        PeerPairingOptions,
        remote_access::{ConnectionStatus, RelayAuthUpdate, RemoteAccessUpdate, RemoteRelayUpdate},
    };
    use maka_remote_pairing::RelayEndpoint;
    use std::path::PathBuf;

    timeout(Duration::from_secs(90), async {
        let sandbox = host::Sandbox::new().await.unwrap();
        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new(([127, 0, 0, 1], 0)));
        let relay = Server::spawn(config).await.unwrap();
        let url = format!("http://{}/", relay.http_addr().unwrap());
        let launch = || {
            let mut cmd =
                host::command_for(&crate::maka_executable(), &sandbox.home, &sandbox.workspace);
            cmd.args(["host", "serve", "--root"]).arg(&sandbox.root);
            cmd
        };
        let target = |ready: Value| {
            (
                PathBuf::from(ready["socketPath"].as_str().unwrap()),
                ready["hostEpoch"].as_str().unwrap().parse().unwrap(),
            )
        };
        let update = |enabled| RemoteAccessUpdate {
            enabled,
            relay_only: true,
            relays: vec![RemoteRelayUpdate {
                endpoint: RelayEndpoint {
                    url: url.clone(),
                    quic_port: None,
                    cert_sha256: None,
                },
                ca_der_path: None,
                auth: RelayAuthUpdate::Keep,
            }],
        };
        let (server, ready) = spawn_ready(launch(), Stdio::inherit()).await;
        let (socket, epoch) = target(ready);
        let status = Client::remote_access_status(&socket, epoch, None)
            .await
            .unwrap();
        assert!(matches!(status.status, ConnectionStatus::Disabled));
        assert!(!status.config.enabled);

        Client::update_remote_access(&socket, epoch, update(true))
            .await
            .unwrap();
        loop {
            let status = Client::remote_access_status(&socket, epoch, None)
                .await
                .unwrap();
            assert!(status.error.is_none(), "{:?}", status.error);
            if matches!(status.status, ConnectionStatus::Connected) {
                assert_eq!(status.connected_relays, [url.as_str()]);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let invite = Client::prepare_peer_pairing(
            &socket,
            epoch,
            PeerPairingOptions {
                host_name: "Desktop test".into(),
                label: None,
                ttl_secs: None,
            },
        )
        .await
        .unwrap();
        let invite_pending = || async {
            Client::remote_access_status(&socket, epoch, Some(&invite.invite_id))
                .await
                .unwrap()
                .invite_pending
        };
        assert_eq!(invite_pending().await, Some(true));
        let ticket = SignedPairingTicket::parse_and_verify_uri(&invite.uri, 0).unwrap();
        let device = DeviceIdentity::generate().unwrap();
        let route = Relay::new(&invite.relays[0], None, None).unwrap();
        let endpoint = PeerEndpoint::bind(&device, &[route], true).await.unwrap();
        let connected = endpoint.connect_ticket(&ticket).await.unwrap();
        loop {
            let status = Client::remote_access_status(&socket, epoch, None)
                .await
                .unwrap();
            if let Some(notice) = status.sas {
                assert_eq!(notice.peer_id, device.public_key().to_string());
                assert_eq!(notice.sas, connected.export_sas().unwrap());
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        connected
            .redeem_pairing(&ticket, Some("Phone".into()))
            .await
            .unwrap();
        assert_eq!(invite_pending().await, Some(false));
        let peers = Client::list_peer_access(&socket, epoch).await.unwrap();
        assert_eq!(peers[0].label, "Phone");
        assert!(peers[0].last_active_at.is_some());

        Client::update_remote_access(&socket, epoch, update(false))
            .await
            .unwrap();
        let status = Client::remote_access_status(&socket, epoch, None)
            .await
            .unwrap();
        assert!(matches!(status.status, ConnectionStatus::Disabled));
        assert!(status.connected_relays.is_empty() && status.sas.is_none());
        connected.closed().await;
        endpoint.close().await;
        Client::update_remote_access(&socket, epoch, update(true))
            .await
            .unwrap();
        stop(server).await;

        let (restarted, ready) = spawn_ready(launch(), Stdio::inherit()).await;
        let (socket, epoch) = target(ready);
        loop {
            let status = Client::remote_access_status(&socket, epoch, None)
                .await
                .unwrap();
            assert!(status.config.enabled);
            assert!(status.error.is_none(), "{:?}", status.error);
            if matches!(status.status, ConnectionStatus::Connected) {
                assert_eq!(
                    Client::list_peer_access(&socket, epoch)
                        .await
                        .unwrap()
                        .len(),
                    1
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        stop(restarted).await;
        relay.shutdown().await.unwrap();
    })
    .await
    .expect("saved remote transport did not complete");
}

#[tokio::test]
async fn saved_remote_transport_does_not_expose_upstream_header_text() {
    use http_body_util::Empty;
    use hyper::{
        Request, Response,
        body::{Bytes, Incoming},
        server::conn::http1,
        service::service_fn,
    };
    use hyper_util::rt::TokioIo;
    use maka_host_runtime::application::host::remote_access::{
        RelayAuthUpdate, RemoteAccessUpdate, RemoteRelayUpdate,
    };
    use maka_remote_pairing::RelayEndpoint;
    use std::{convert::Infallible, path::Path};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
    use tokio_util::sync::CancellationToken;

    const REFLECTED: &str = "server-reflected-secret-from-response";
    timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop_relay = CancellationToken::new();
        let relay = tokio::spawn({
            let stop = stop_relay.clone();
            async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    let stream = tokio::select! {
                        () = stop.cancelled() => break,
                        next = listener.accept() => next.unwrap().0,
                    };
                    let service = service_fn(|request: Request<Incoming>| async move {
                        let response = if request.uri().path() == "/relay" {
                            let key = &request.headers()["sec-websocket-key"];
                            Response::builder()
                                .status(101)
                                .header("upgrade", "websocket")
                                .header("connection", "upgrade")
                                .header("sec-websocket-accept", derive_accept_key(key.as_bytes()))
                                .header("sec-websocket-protocol", REFLECTED)
                        } else {
                            assert_eq!(request.uri().path(), "/ping");
                            Response::builder().status(200)
                        };
                        Ok::<_, Infallible>(response.body(Empty::<Bytes>::new()).unwrap())
                    });
                    connections.spawn(async move {
                        http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await
                            .unwrap();
                    });
                }
                connections.shutdown().await;
            }
        });
        let sandbox = host::Sandbox::new().await.unwrap();
        let mut serve =
            host::command_for(&crate::maka_executable(), &sandbox.home, &sandbox.workspace);
        serve.args(["host", "serve", "--root"]).arg(&sandbox.root);
        let (mut server, ready) = spawn_ready(serve, Stdio::piped()).await;
        let mut stderr = BufReader::new(server.stderr.take().unwrap());
        let diagnostics = loop {
            let mut line = String::new();
            assert_ne!(
                stderr.read_line(&mut line).await.unwrap(),
                0,
                "Host diagnostics path missing"
            );
            if let Some(path) = line.trim_end().strip_prefix("Host diagnostics: ") {
                break std::path::PathBuf::from(path);
            }
        };
        let socket = Path::new(ready["socketPath"].as_str().unwrap());
        let epoch = ready["hostEpoch"].as_str().unwrap().parse().unwrap();
        Client::update_remote_access(
            socket,
            epoch,
            RemoteAccessUpdate {
                enabled: true,
                relay_only: true,
                relays: vec![RemoteRelayUpdate {
                    endpoint: RelayEndpoint {
                        url,
                        quic_port: None,
                        cert_sha256: None,
                    },
                    ca_der_path: None,
                    auth: RelayAuthUpdate::Keep,
                }],
            },
        )
        .await
        .unwrap();
        let error = loop {
            if let Some(error) = Client::remote_access_status(socket, epoch, None)
                .await
                .unwrap()
                .error
            {
                break error;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        assert_eq!(
            error,
            "relay connection failed; check connectivity and TLS trust"
        );
        assert!(!error.contains(REFLECTED));
        stop(server).await;
        let logs = tokio::fs::read(diagnostics).await.unwrap();
        assert!(!String::from_utf8_lossy(&logs).contains(REFLECTED));
        stop_relay.cancel();
        relay.await.unwrap();
    })
    .await
    .expect("sanitized registration failure did not reach Host status");
}

#[tokio::test]
async fn peer_stream_reaches_ingress_while_activity_writer_is_locked() {
    use iroh_relay::server::{RelayConfig, Server, ServerConfig};
    use maka_remote_pairing::RelayEndpoint;
    use maka_remote_transport::host::HostPeerTransport;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_util::sync::CancellationToken;

    timeout(Duration::from_secs(20), async {
        let sandbox = host::Sandbox::new().await.unwrap();
        let host = super::peer_access::open_host(&sandbox).await;
        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new(([127, 0, 0, 1], 0)));
        let server = Server::spawn(config).await.unwrap();
        let route = RelayEndpoint {
            url: format!("http://{}", server.http_addr().unwrap()),
            quic_port: None,
            cert_sha256: None,
        };
        let relay = Relay::new(&route, None, None).unwrap();
        let transport = HostPeerTransport::bind(&host, &[relay], true)
            .await
            .unwrap();
        transport.wait_for_relay().await.unwrap();
        let device = DeviceIdentity::generate().unwrap();
        let endpoint =
            PeerEndpoint::bind(&device, &[Relay::new(&route, None, None).unwrap()], true)
                .await
                .unwrap();
        let lock =
            rusqlite::Connection::open(sandbox.root.join("configuration-rust.sqlite")).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        let (send, mut ingress) = HostPeerTransport::ingress();
        let cancel = CancellationToken::new();
        let serving = tokio::spawn(transport.serve(send, cancel.clone(), |_, _| {}));
        let peer = endpoint
            .connect(&host.device_identity().public_key())
            .await
            .unwrap();
        let mut stream = peer.open_bi().await.unwrap();
        stream.write_all(b"hello").await.unwrap();
        let incoming = async {
            let stream = ingress.recv().await.unwrap();
            let mut bytes = [0; 5];
            stream.stream.take(5).read_exact(&mut bytes).await.unwrap();
            bytes
        };
        let received = timeout(Duration::from_secs(1), incoming).await;
        lock.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            received.expect("peer ingress waited for the SQLite writer"),
            *b"hello"
        );
        cancel.cancel();
        serving.await.unwrap().unwrap();
        endpoint.close().await;
        server.shutdown().await.unwrap();
    })
    .await
    .expect("locked-writer admission test timed out");
}
