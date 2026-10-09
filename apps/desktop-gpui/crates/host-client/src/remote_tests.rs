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

//! Remote transports against scripted fakes: a WebSocket Host on a loopback
//! port (tungstenite's blocking server on a thread) and a fake `ssh`
//! (`tests/fixtures/fake-ssh.sh`).
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use async_tungstenite::tungstenite::Message;
use async_tungstenite::tungstenite::http::StatusCode;
use futures_lite::future::block_on;
use host_protocol::{
    AccessCredential, FrameError, OperatorCommand, OperatorPlatform, RemoteTransport,
    SessionCatalogQuery, SessionCatalogQueryInput, SessionCatalogQueryResult, SshTransport,
};
use serde_json::{Value, json};

use crate::ssh::{self, ActivationError, SshError, SshFailure};
use crate::test_support::{ScriptedWebSocketHost as WsHost, free_listener};
use crate::tests::{hello, status_result};
use crate::{
    ConnectError, ConnectOptions, Connected, Connection, ConnectionError, ConnectionEvent,
    HostEvent, PairingError, ReconnectPolicy, RemoteConnectError, RemoteConnectOptions,
    RemoteConnector, RemoteHostProfile, Supervised, WebSocketError, connect_remote,
    pair_remote_host, supervise,
};

const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";
const CREDENTIAL: &str = "mrha_test-credential";
const FAKE_SSH: &str = include_str!("../tests/fixtures/fake-ssh.sh");

fn credential() -> AccessCredential {
    AccessCredential::new(CREDENTIAL).expect("credential")
}

fn plaintext_profile(port: u16) -> RemoteHostProfile {
    let transport =
        RemoteTransport::plaintext(&format!("ws://127.0.0.1:{port}/runtime-host")).expect("url");
    RemoteHostProfile::new("box", "Box", ROOT_ID, transport).expect("profile")
}

fn options() -> RemoteConnectOptions {
    RemoteConnectOptions::default().with_timeout(Duration::from_secs(5))
}

fn empty_page() -> Value {
    json!({
        "kind": "page",
        "revision": format!("sha256:{}", "0".repeat(64)),
        "sessions": [],
        "nextCursor": null
    })
}

/// Runs `connected`'s pump on a thread, lists sessions, and shuts down.
fn list_sessions(connected: Connected) -> SessionCatalogQueryResult {
    let Connected { connection, pump, .. } = connected;
    let pump = thread::spawn(move || block_on(pump));
    let catalog =
        block_on(connection.request::<SessionCatalogQuery>(&SessionCatalogQueryInput::ListStart));
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
    catalog.expect("session catalog")
}

#[test]
fn a_websocket_host_speaks_one_message_per_frame_with_a_bearer_credential() {
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut host = WsHost::accept(&listener, None).expect("upgrade");
        let hello = host.accept_hello();
        let request = host.answer(empty_page());
        host.drain();
        (host.path().to_owned(), host.headers().clone(), hello, request)
    });
    let connected =
        block_on(connect_remote(&plaintext_profile(port), &credential(), hello(), &options()))
            .expect("connected");
    assert_eq!(connected.connection.root_id(), ROOT_ID);
    assert!(matches!(
        list_sessions(connected),
        SessionCatalogQueryResult::Page { sessions, .. } if sessions.is_empty()
    ));

    let (path, headers, hello, request) = host.join().expect("host thread");
    assert_eq!(path, "/runtime-host");
    assert_eq!(headers["authorization"], format!("Bearer {CREDENTIAL}"));
    assert!(headers.get("origin").is_none(), "no Origin header");
    assert!(headers.get("sec-websocket-extensions").is_none(), "no permessage-deflate offer");
    assert_eq!(hello["kind"], "hello");
    assert_eq!(hello["clientInstanceId"], "test-client");
    assert_eq!(request["operation"], "session.catalog.query");
}

#[test]
fn a_refused_upgrade_says_whether_the_credential_was_the_reason() {
    for (status, permanent) in [(StatusCode::UNAUTHORIZED, true), (StatusCode::NOT_FOUND, false)] {
        let (listener, port) = free_listener();
        let host = thread::spawn(move || WsHost::accept(&listener, Some(status)).is_none());
        let error =
            block_on(connect_remote(&plaintext_profile(port), &credential(), hello(), &options()))
                .expect_err("refused");
        match (&error, status) {
            (
                RemoteConnectError::Connect(ConnectError::WebSocket(
                    WebSocketError::AuthenticationFailed,
                )),
                StatusCode::UNAUTHORIZED,
            ) => {}
            (
                RemoteConnectError::Connect(ConnectError::WebSocket(
                    WebSocketError::UpgradeRefused(404),
                )),
                StatusCode::NOT_FOUND,
            ) => {}
            other => panic!("unexpected {other:?} for {status}"),
        }
        assert_eq!(error.is_permanent(), permanent, "{status}");
        host.join().expect("host thread");
    }
}

#[test]
fn a_host_serving_another_state_root_is_refused() {
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut host = WsHost::accept(&listener, None).expect("upgrade");
        host.accept_hello();
        host.drain();
    });
    let transport =
        RemoteTransport::plaintext(&format!("ws://127.0.0.1:{port}/runtime-host")).expect("url");
    let profile =
        RemoteHostProfile::new("box", "Box", &"f".repeat(64), transport).expect("profile");
    let error = block_on(connect_remote(&profile, &credential(), hello(), &options()))
        .expect_err("refused");
    assert!(
        matches!(error, RemoteConnectError::Connect(ConnectError::RootMismatch { .. })),
        "{error:?}"
    );
    assert!(error.is_permanent());
    host.join().expect("host thread");
}

#[test]
fn oversized_and_binary_messages_end_the_connection() {
    let big = "x".repeat(host_protocol::MAX_MESSAGE_BYTES);
    for message in
        [Message::text(format!("{{\"a\":\"{big}\"}}")), Message::binary(vec![b'{', b'}'])]
    {
        let binary = message.is_binary();
        let (listener, port) = free_listener();
        let host = thread::spawn(move || {
            let mut host = WsHost::accept(&listener, None).expect("upgrade");
            host.accept_hello();
            host.send(message);
            host.drain();
        });
        let Connected { pump, connection, .. } =
            block_on(connect_remote(&plaintext_profile(port), &credential(), hello(), &options()))
                .expect("connected");
        let ended = block_on(pump);
        if binary {
            assert!(matches!(ended, Err(ConnectionError::Protocol(_))), "{ended:?}");
        } else {
            assert!(
                matches!(ended, Err(ConnectionError::Frame(FrameError::TooLarge))),
                "{ended:?}"
            );
        }
        assert!(connection.is_closed());
        host.join().expect("host thread");
    }
}

#[test]
fn a_direct_peer_profile_is_refused_as_unsupported() {
    let transport: RemoteTransport = serde_json::from_value(json!({
        "kind": "libp2p-direct",
        "reachability": {
            "lease": {
                "version": 1,
                "peerId": "12D3KooWGzBbDJhbY2Y4nB1hCKdk9oS8Z2xCmT4pj3uqvG1X3oYu",
                "revision": 1,
                "issuedAt": 1,
                "expiresAt": 2,
                "directRoutes": ["/ip4/192.168.1.20/udp/4001/quic-v1"],
                "coordinationRoutes": []
            },
            "publicKey": "CAESIC0",
            "signature": "c2lnbmF0dXJl"
        }
    }))
    .expect("transport");
    let profile = RemoteHostProfile::new("peer", "Peer", ROOT_ID, transport).expect("profile");
    let error = block_on(connect_remote(&profile, &credential(), hello(), &options()))
        .expect_err("refused");
    assert!(matches!(error, RemoteConnectError::UnsupportedTransport(_)), "{error:?}");
    assert!(error.is_permanent());
    assert!(error.to_string().contains("Direct peer"), "{error}");
}

#[test]
fn pairing_reconnects_when_the_host_asks_and_retries_an_unknown_outcome() {
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        // An outcome the Host could not confirm: pair again on a new
        // connection.
        let mut first = WsHost::accept(&listener, None).expect("upgrade");
        first.play_pairing(Err("commit_outcome_unknown"));
        first.drain();
        // Finalized; this connection keeps the pending authority.
        let mut second = WsHost::accept(&listener, None).expect("upgrade");
        second.play_pairing(Ok(json!({"reconnectRequired": true})));
        second.drain();
        // The active credential: ready, then an ordinary request.
        let mut third = WsHost::accept(&listener, None).expect("upgrade");
        third.accept_hello();
        third.answer(status_result());
        let request = third.answer(empty_page());
        third.drain();
        request
    });
    let connected = block_on(pair_remote_host(
        &plaintext_profile(port),
        &credential(),
        hello(),
        &options(),
        Duration::from_secs(10),
    ))
    .expect("paired");
    assert!(matches!(list_sessions(connected), SessionCatalogQueryResult::Page { .. }));
    assert_eq!(host.join().expect("host thread")["operation"], "session.catalog.query");
}

#[test]
fn pairing_without_a_reconnect_keeps_its_connection_and_a_refusal_is_final() {
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut host = WsHost::accept(&listener, None).expect("upgrade");
        host.play_pairing(Ok(json!({"reconnectRequired": false})));
        let request = host.answer(empty_page());
        host.drain();
        request
    });
    let connected = block_on(pair_remote_host(
        &plaintext_profile(port),
        &credential(),
        hello(),
        &options(),
        Duration::from_secs(10),
    ))
    .expect("paired");
    assert!(matches!(list_sessions(connected), SessionCatalogQueryResult::Page { .. }));
    host.join().expect("host thread");

    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut host = WsHost::accept(&listener, None).expect("upgrade");
        host.play_pairing(Err("invalid_request"));
        host.drain();
    });
    let error = block_on(pair_remote_host(
        &plaintext_profile(port),
        &credential(),
        hello(),
        &options(),
        Duration::from_secs(10),
    ))
    .expect_err("refused");
    assert!(matches!(error, PairingError::Finalize(_)), "{error:?}");
    host.join().expect("host thread");
}

/// A scratch directory holding the fake `ssh` and the files that script it.
struct FakeSsh(PathBuf);

impl FakeSsh {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir()
            .join(format!("host-client-ssh-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("scratch");
        let program = dir.join("ssh");
        fs::write(&program, FAKE_SSH).expect("fake ssh");
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).expect("mode");
        Self(dir)
    }

    fn program(&self) -> PathBuf {
        self.0.join("ssh")
    }

    fn set(&self, file: &str, contents: &str) {
        fs::write(self.0.join(file), contents).expect("script file");
    }

    fn launches(&self) -> Vec<String> {
        fs::read_to_string(self.0.join("launches"))
            .map(|text| text.lines().map(str::to_owned).collect())
            .unwrap_or_default()
    }

    /// The local port of the latest tunnel launch, once there is one.
    fn wait_for_tunnel(&self) -> u16 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(line) = self.launches().iter().rev().find(|line| line.contains(" -L ")) {
                let forward = line.split(" -L ").nth(1).and_then(|rest| rest.split(' ').next());
                let port = forward.and_then(|spec| spec.split(':').nth(1));
                return port.and_then(|port| port.parse().ok()).expect("tunnel port");
            }
            assert!(Instant::now() < deadline, "no tunnel was started");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn pid(&self) -> Option<String> {
        fs::read_to_string(self.0.join("pid")).ok().map(|pid| pid.trim().to_owned())
    }
}

impl Drop for FakeSsh {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

fn process_is_alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Waits for `condition`, or panics after a few seconds.
fn eventually(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn ssh_profile(remote_port: u16) -> RemoteHostProfile {
    let transport =
        SshTransport::forward("me@box", Some(2222), remote_port, "/runtime-host").expect("ssh");
    RemoteHostProfile::new("box", "Box", ROOT_ID, RemoteTransport::Ssh(transport)).expect("profile")
}

#[test]
fn an_ssh_forward_carries_the_websocket_and_stops_with_the_connection() {
    let fake = FakeSsh::new("forward");
    let options = options().with_ssh_program(fake.program());
    let connecting = thread::spawn(move || {
        block_on(connect_remote(&ssh_profile(7000), &credential(), hello(), &options))
    });
    // Stand where the forward would lead, then let the fake report it.
    let local_port = fake.wait_for_tunnel();
    let listener = TcpListener::bind(("127.0.0.1", local_port)).expect("the forward's port");
    let host = thread::spawn(move || {
        let mut host = WsHost::accept(&listener, None).expect("upgrade");
        host.accept_hello();
        host.answer(empty_page());
        host.drain();
        host.path().to_owned()
    });
    fake.set("go", "");
    let connected = connecting.join().expect("connect thread").expect("connected");
    let pid = fake.pid().expect("tunnel pid");
    assert!(process_is_alive(&pid));
    assert!(matches!(list_sessions(connected), SessionCatalogQueryResult::Page { .. }));
    assert_eq!(host.join().expect("host thread"), "/runtime-host");
    eventually("ssh stops with the connection", || !process_is_alive(&pid));

    let launches = fake.launches();
    assert!(launches[0].starts_with("-G "), "{launches:?}");
    let tunnel = &launches[1];
    for part in [
        "-N -T",
        "-o BatchMode=yes",
        "-o ExitOnForwardFailure=yes",
        &format!("-L 127.0.0.1:{local_port}:127.0.0.1:7000"),
        "-p 2222 me@box",
    ] {
        assert!(tunnel.contains(part), "{tunnel} lacks {part}");
    }
    let log_dir = tunnel.split("-E ").nth(1).and_then(|rest| rest.split(' ').next()).map(Path::new);
    let log_dir = log_dir.and_then(Path::parent).expect("log path");
    assert!(!log_dir.exists(), "the tunnel's log is removed");
}

#[test]
fn the_connection_ends_when_ssh_exits() {
    let fake = FakeSsh::new("exit");
    fake.set("go", "");
    let options = options().with_ssh_program(fake.program());
    // Take the port the forward reports before connecting through it.
    let connecting = thread::spawn(move || {
        block_on(connect_remote(&ssh_profile(7000), &credential(), hello(), &options))
    });
    let local_port = fake.wait_for_tunnel();
    let listener = TcpListener::bind(("127.0.0.1", local_port)).expect("the forward's port");
    let host = thread::spawn(move || {
        let mut host = WsHost::accept(&listener, None).expect("upgrade");
        host.accept_hello();
        host
    });
    // Holding the connection keeps the pump from ending on its own.
    let Connected { pump, connection, .. } =
        connecting.join().expect("connect thread").expect("connected");
    let pid = fake.pid().expect("tunnel pid");
    std::process::Command::new("kill").args(["-9", &pid]).status().expect("kill");
    let ended = block_on(pump);
    assert!(matches!(ended, Err(ConnectionError::TunnelEnded(_))), "{ended:?}");
    assert!(connection.is_closed());
    drop(host.join().expect("host thread"));
}

#[test]
fn ssh_failures_name_their_cause() {
    for (mode, failure) in
        [("hostkey", SshFailure::HostKeyNotVerified), ("auth", SshFailure::AuthenticationFailed)]
    {
        let fake = FakeSsh::new(mode);
        fake.set("mode", mode);
        let error =
            block_on(ssh::open_tunnel(&fake.program(), "me@box", None, 7000, "/runtime-host"))
                .expect_err("refused");
        match error {
            SshError::Failed { failure: actual, ref outcome, .. } => {
                assert_eq!(actual, failure, "{mode}");
                assert_eq!(outcome, "exited with code 255");
            }
            other => panic!("unexpected {other:?} for {mode}"),
        }
    }

    let fake = FakeSsh::new("configured");
    fake.set("config", "user me\nlocalforward 127.0.0.1:5432 localhost:5432\n");
    assert!(matches!(
        block_on(ssh::open_tunnel(&fake.program(), "me@box", None, 7000, "/runtime-host")),
        Err(SshError::ForwardingConfigured { .. })
    ));

    let missing = Path::new("/nonexistent/ssh");
    assert!(matches!(
        block_on(ssh::open_tunnel(missing, "me@box", None, 7000, "/runtime-host")),
        Err(SshError::Spawn { .. })
    ));
}

#[test]
fn a_taken_local_port_is_retried_with_another() {
    let fake = FakeSsh::new("conflict");
    fake.set("mode", "conflict-once");
    fake.set("go", "");
    let (tunnel, url) =
        block_on(ssh::open_tunnel(&fake.program(), "me@box", None, 7000, "/runtime-host"))
            .expect("the second attempt forwards");
    let tunnels: Vec<_> =
        fake.launches().into_iter().filter(|line| line.contains(" -L ")).collect();
    assert_eq!(tunnels.len(), 2, "{tunnels:?}");
    assert!(url.as_str().starts_with("ws://127.0.0.1:"));
    assert!(url.as_str().ends_with("/runtime-host"));
    block_on(tunnel.close());
}

fn activation_frame(value: &Value) -> String {
    use base64::Engine as _;
    let json = serde_json::to_vec(value).expect("encode");
    format!(
        "{}{}\n",
        host_protocol::ACTIVATION_FRAME_PREFIX,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    )
}

fn activation_result(root_id: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": "result",
        "deploymentId": "9c0a3a5e-1f5d-4b8e-9d3c-0e6f7a1bb912",
        "configRevision": 3,
        "rootId": root_id,
        "hostEpoch": "epoch-1",
        "pid": 4242,
        "protocolVersion": 0,
        "endpoint": {"host": "127.0.0.1", "port": 48123, "websocketPath": "/runtime-host"}
    })
}

#[test]
fn an_operator_activation_reports_the_endpoint_or_why_not() {
    let operator =
        OperatorCommand::node(OperatorPlatform::Posix, "/opt/node", "/opt/maka/operator.mjs")
            .expect("operator");
    let activate = |fake: &FakeSsh| {
        block_on(ssh::activate_operator(&fake.program(), "me@box", Some(2222), &operator, ROOT_ID))
    };

    let fake = FakeSsh::new("activate");
    fake.set("activation", &activation_frame(&activation_result(ROOT_ID)));
    let result = activate(&fake).expect("activated");
    assert_eq!(result.endpoint.port, 48123);
    assert_eq!(result.endpoint.websocket_path, "/runtime-host");
    let launch = &fake.launches()[0];
    assert!(launch.starts_with("-T -o BatchMode=yes"), "{launch}");
    assert!(launch.contains("-o RemoteCommand=none"), "{launch}");
    assert!(
        launch.ends_with(&format!(
            "-p 2222 me@box exec '/opt/node' '/opt/maka/operator.mjs' 'activate' '--framed' '--root-id' '{ROOT_ID}'"
        )),
        "{launch}"
    );

    let cases: Vec<(&str, String, &str, &str)> = vec![
        (
            "refused",
            activation_frame(&json!({
                "schemaVersion": 1,
                "kind": "error",
                "error": {"code": "root_mismatch", "message": "The managed root does not match"}
            })),
            "",
            "1",
        ),
        ("other-root", activation_frame(&activation_result(&"f".repeat(64))), "", "0"),
        ("two-lines", format!("noise\n{}", activation_frame(&activation_result(ROOT_ID))), "", "0"),
        ("no-frame", String::new(), "", "3"),
        ("ssh-failed", String::new(), "me@box: Permission denied (publickey).\n", "255"),
    ];
    for (name, stdout, stderr, exit) in cases {
        let fake = FakeSsh::new(name);
        fake.set("activation", &stdout);
        fake.set("activation-stderr", stderr);
        fake.set("activation-exit", exit);
        let error = activate(&fake).expect_err(name);
        let expected = match name {
            "refused" => {
                matches!(&error, SshError::Activation(ActivationError::Refused { code, .. }) if code == "root_mismatch")
            }
            "other-root" => matches!(error, SshError::Activation(ActivationError::Inconsistent)),
            "two-lines" => matches!(error, SshError::Activation(ActivationError::Malformed)),
            "no-frame" => matches!(error, SshError::Activation(ActivationError::Exited(3))),
            _ => {
                matches!(error, SshError::Failed { failure: SshFailure::AuthenticationFailed, .. })
            }
        };
        assert!(expected, "{name}: {error:?}");
    }
}

#[test]
fn a_websocket_connect_to_a_closed_port_is_unreachable() {
    let (listener, port) = free_listener();
    drop(listener);
    let error = block_on(Connection::connect_websocket(
        plaintext_profile(port).transport_url(),
        &credential(),
        hello(),
        ConnectOptions::default().with_timeout(Duration::from_secs(5)),
    ))
    .expect_err("refused");
    assert!(
        matches!(error, ConnectError::WebSocket(WebSocketError::Unreachable { .. })),
        "{error:?}"
    );
    assert!(!error.is_permanent());
}

impl RemoteHostProfile {
    /// The WebSocket URL of a TLS or plaintext profile.
    fn transport_url(&self) -> &host_protocol::RemoteHostUrl {
        match self.transport() {
            RemoteTransport::Tls(url) | RemoteTransport::Plaintext(url) => url,
            other => panic!("no URL for {other:?}"),
        }
    }
}

/// The stack of a thread GPUI's background executor polls tasks on: on
/// macOS a Grand Central Dispatch worker, which gets 512 KiB.
const WORKER_STACK: usize = 512 * 1024;

/// Runs `work` on a thread with a dispatch worker's stack. Overflowing it
/// aborts the test binary, as it aborted the app.
fn on_worker_stack<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    thread::Builder::new()
        .name("worker-stack".to_owned())
        .stack_size(WORKER_STACK)
        .spawn(work)
        .expect("thread")
        .join()
        .expect("the work finished")
}

/// A TLS profile for a port that takes the TCP connection and hangs up,
/// so an attempt goes as deep as the TLS handshake and fails there.
fn hanging_up_tls_profile() -> RemoteHostProfile {
    let (listener, port) = free_listener();
    thread::spawn(move || {
        for stream in listener.incoming() {
            drop(stream);
        }
    });
    let transport =
        RemoteTransport::tls(&format!("wss://127.0.0.1:{port}/runtime-host")).expect("url");
    RemoteHostProfile::new("box", "Box", ROOT_ID, transport).expect("profile")
}

#[test]
fn a_remote_attempt_and_a_pairing_fit_a_dispatch_workers_stack() {
    let profile = hanging_up_tls_profile();
    let connector = RemoteConnector::new(profile.clone(), credential(), hello()).options(options());
    let Supervised { handle, run, events, .. } = supervise(connector, ReconnectPolicy::default());
    let supervisor = thread::Builder::new()
        .name("supervisor".to_owned())
        .stack_size(WORKER_STACK)
        .spawn(move || block_on(run))
        .expect("supervisor thread");
    let failed = block_on(async {
        loop {
            match events.recv().await.expect("events") {
                HostEvent::Connection(ConnectionEvent::AttemptFailed { reason, .. }) => {
                    break reason;
                }
                _ => continue,
            }
        }
    });
    assert!(!failed.is_empty());
    handle.shutdown();
    supervisor.join().expect("the supervisor ended without overflowing its stack");

    let paired = on_worker_stack(move || {
        block_on(pair_remote_host(
            &profile,
            &credential(),
            hello(),
            &options(),
            Duration::from_secs(5),
        ))
        .map(|_| ())
    });
    assert!(matches!(paired, Err(PairingError::Connect(_))), "{paired:?}");
}
