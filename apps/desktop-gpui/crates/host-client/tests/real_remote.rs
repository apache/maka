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

//! Serves a real Runtime Host from the Maka checkout with a loopback
//! WebSocket listener on a fresh State Root under `target/tmp`, then reaches
//! it the way a remote client does: a refused credential, a pending pairing
//! credential that can do nothing but finalize, pairing, the session list,
//! and a supervised connection from a saved profile.
//!
//! ```sh
//! MAKA_REPO=~/code/maka-pin cargo test -p host-client --test real_remote -- --ignored --nocapture
//! ```
//!
//! Ignored by default, and a no-op without `MAKA_REPO`: it needs a built
//! checkout (`docs/dev-host.md`) and a Node discovered as the app discovers
//! it (`MAKA_NODE`, `node` on `PATH`, nvm). The Host runs
//! `runtime-host serve --websocket-port <free port>`, the listener
//! `server/websocket-listener.ts` starts; the pending credential comes from
//! `access.credential.prepare` over the local socket and its delivery file,
//! as `maka runtime-host access` obtains one. Provider keys are removed from
//! the Host's environment. Afterwards the Host is stopped by its pid and the
//! scratch root, its control directory, and its owner lock are deleted.
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use futures_lite::future::block_on;
use host_client::{
    ConnectError, ConnectOptions, Connected, Connection, ConnectionEvent, HostEvent, MAKA_REPO_ENV,
    NodeRuntime, ReconnectPolicy, RemoteConnectError, RemoteConnectOptions, RemoteConnector,
    RemoteHostProfile, RemoteProfileStore, RequestError, WebSocketError, connect_remote,
    control_directory, pair_remote_host, random_client_instance_id, supervise,
};
use host_protocol::{
    AccessCredential, AccessCredentialPrepare, AccessCredentialPrepareInput, ClientHello,
    HostOperationErrorCode, RemoteTransport, SessionCatalogQuery, SessionCatalogQueryInput,
    SessionCatalogQueryResult,
};
use serde_json::Value;

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// A served Host: the process, its ready event, and where its files are.
struct ServedHost {
    child: Child,
    scratch: PathBuf,
    root_id: String,
    local_endpoint: String,
    websocket_url: String,
}

impl ServedHost {
    fn start(repo: &Path, node: &Path, scratch: &Path) -> Self {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("free port");
            listener.local_addr().expect("address").port()
        };
        let stderr = std::fs::File::create(scratch.join("host.stderr")).expect("stderr file");
        let mut child = Command::new(node)
            .arg(repo.join("packages/cli/dist/dev-cli.js"))
            .args(["runtime-host", "serve", "--root"])
            .arg(scratch.join("state-root"))
            .args(["--websocket-port", &port.to_string(), "--json"])
            .current_dir(repo)
            .env_remove("DEEPSEEK_API_KEY")
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .expect("runtime-host serve");
        let stdout = child.stdout.take().expect("stdout");
        let (lines, ready) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if lines.send(line).is_err() {
                    break;
                }
            }
        });
        let line = match ready.recv_timeout(READY_TIMEOUT) {
            Ok(line) => line,
            Err(_) => {
                let _ = child.kill();
                panic!(
                    "the Host printed no ready event; see {}",
                    scratch.join("host.stderr").display()
                );
            }
        };
        let event: Value = serde_json::from_str(&line).expect("ready event");
        assert_eq!(event["event"], "runtime_host_ready");
        assert_eq!(
            event["protocol"]["compatibilityEpoch"],
            host_protocol::RUNTIME_HOST_COMPATIBILITY_EPOCH
        );
        let listeners = event["listeners"].as_array().expect("listeners");
        let find =
            |kind: &str| listeners.iter().find(|listener| listener["kind"] == kind).expect(kind);
        let websocket = find("websocket");
        assert_eq!(websocket["tls"], false);
        let websocket_url = format!(
            "ws://{}:{}{}",
            websocket["host"].as_str().expect("host"),
            websocket["port"],
            websocket["path"].as_str().expect("path")
        );
        Self {
            child,
            scratch: scratch.to_owned(),
            root_id: event["rootId"].as_str().expect("rootId").to_owned(),
            local_endpoint: find("local_ipc")["endpoint"].as_str().expect("endpoint").to_owned(),
            websocket_url,
        }
    }

    /// Prepares a pending remote-owner credential bound to the client that
    /// finalizes it, over the local socket, and reads it from its delivery
    /// file.
    fn prepare_pairing_credential(&self) -> AccessCredential {
        let hello = ClientHello::new(random_client_instance_id());
        let options = ConnectOptions::default().with_expected_root_id(self.root_id.clone());
        let Connected { connection, pump, .. } =
            block_on(Connection::connect(&self.local_endpoint, hello, options))
                .expect("local owner");
        let pump = thread::spawn(move || block_on(pump));
        let input = AccessCredentialPrepareInput::remote_owner(
            "maka-gpui-live-test",
            ["access.credential.finalize", "session.catalog.query"],
        )
        .bind_client_instance(true);
        let prepared = block_on(async {
            connection.wait_until_ready(READY_TIMEOUT).await.expect("ready");
            connection
                .request_with_timeout::<AccessCredentialPrepare>(&input, REQUEST_TIMEOUT)
                .await
        })
        .expect("access.credential.prepare");
        connection.shutdown();
        pump.join().expect("pump thread").expect("clean close");
        eprintln!("prepared credential {} for {}", prepared.credential_id, prepared.principal_id);
        let delivery = control_directory(&self.root_id)
            .expect("control directory")
            .join(format!("runtime-host-access-delivery-{}.json", prepared.delivery_id));
        let text = std::fs::read_to_string(&delivery).expect("delivery file");
        std::fs::remove_file(&delivery).expect("consume the delivery");
        let value: Value = serde_json::from_str(&text).expect("delivery JSON");
        assert_eq!(value["credentialId"], prepared.credential_id.as_str());
        AccessCredential::new(value["credential"].as_str().expect("credential"))
            .expect("valid credential")
    }

    /// Stops the Host by its pid, then deletes its files.
    fn stop(mut self) {
        let pid = self.child.id().to_string();
        let _ = Command::new("kill").arg(&pid).status();
        let deadline = Instant::now() + Duration::from_secs(15);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        eprintln!("Host pid {pid} stopped: {:?}", self.child.try_wait());
        std::fs::remove_dir_all(&self.scratch).ok();
        if let Ok(control) = control_directory(&self.root_id) {
            std::fs::remove_dir_all(control).ok();
        }
        if let Some(home) = std::env::home_dir() {
            let owners = if cfg!(target_os = "macos") {
                home.join("Library/Application Support/Maka/state-root-owners")
            } else {
                home.join(".local/share/Maka/state-root-owners")
            };
            std::fs::remove_file(owners.join(format!("{}.lock", self.root_id))).ok();
        }
    }
}

/// Lists sessions on `connected` with its pump on a thread, then closes it.
fn list_sessions(connected: Connected) -> Result<SessionCatalogQueryResult, RequestError> {
    let Connected { connection, pump, .. } = connected;
    let pump = thread::spawn(move || block_on(pump));
    let result = block_on(async {
        connection.wait_until_ready(READY_TIMEOUT).await?;
        connection
            .request_with_timeout::<SessionCatalogQuery>(
                &SessionCatalogQueryInput::ListStart,
                REQUEST_TIMEOUT,
            )
            .await
    });
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean close");
    result
}

#[test]
#[ignore = "serves a real Runtime Host from $MAKA_REPO; run with --ignored"]
fn a_real_host_pairs_and_serves_over_websocket() {
    let Some(repo) = std::env::var_os(MAKA_REPO_ENV).map(PathBuf::from) else {
        eprintln!("skipped: {MAKA_REPO_ENV} is not set");
        return;
    };
    let scratch = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("real-remote-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let node = block_on(NodeRuntime::discover()).expect("a Node to run the Host");
    let host = ServedHost::start(&repo, node.path(), &scratch);
    eprintln!("Host for {} at {} and {}", host.root_id, host.local_endpoint, host.websocket_url);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| exercise(&host)));
    host.stop();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn exercise(host: &ServedHost) {
    let transport = RemoteTransport::plaintext(&host.websocket_url).expect("websocket URL");
    let profile = RemoteHostProfile::new("live", "Live test Host", &host.root_id, transport)
        .expect("profile");
    let options = RemoteConnectOptions::default().with_timeout(Duration::from_secs(10));

    // A credential the Host never issued: the upgrade is refused with 401.
    let wrong = AccessCredential::new("mrha_not-a-credential").expect("credential");
    let hello = ClientHello::new(random_client_instance_id());
    match block_on(connect_remote(&profile, &wrong, hello, &options)) {
        Err(RemoteConnectError::Connect(ConnectError::WebSocket(
            WebSocketError::AuthenticationFailed,
        ))) => {
            eprintln!("an unknown credential is refused at the upgrade");
        }
        other => panic!("expected an authentication failure, got {other:?}"),
    }

    // A pending credential completes the handshake but may only finalize.
    let pending = host.prepare_pairing_credential();
    let paired_hello = ClientHello::new(random_client_instance_id());
    let connected = block_on(connect_remote(&profile, &pending, paired_hello.clone(), &options))
        .expect("the pending credential completes the handshake");
    assert_eq!(connected.connection.root_id(), host.root_id);
    match list_sessions(connected) {
        Err(RequestError::Operation { error, .. })
            if error.code == HostOperationErrorCode::Unauthorized =>
        {
            eprintln!("before pairing, session.catalog.query is unauthorized: {}", error.message);
        }
        other => panic!("expected unauthorized before pairing, got {other:?}"),
    }

    // Pairing finalizes and reconnects; the new connection lists sessions.
    let paired = block_on(pair_remote_host(
        &profile,
        &pending,
        paired_hello.clone(),
        &options,
        Duration::from_secs(60),
    ))
    .expect("paired");
    eprintln!(
        "paired as {}: connection {}",
        paired_hello.client_instance_id,
        paired.connection.connection_id()
    );
    match list_sessions(paired).expect("session.catalog.query after pairing") {
        SessionCatalogQueryResult::Page { sessions, .. } => {
            eprintln!("the fresh root lists {} sessions", sessions.len());
            assert!(sessions.is_empty());
        }
        other => panic!("expected a page, got {other:?}"),
    }

    // The active credential, saved with its profile, drives a supervised
    // connection with the same client instance id.
    let store = RemoteProfileStore::new(host.scratch.join("client-config"));
    block_on(store.create(&profile, &pending)).expect("save the profile");
    let resolved = block_on(store.resolve("live")).expect("resolve");
    let credential = resolved.credential.expect("stored credential");
    let supervised = supervise(
        RemoteConnector::new(resolved.profile, credential, paired_hello).options(options),
        ReconnectPolicy::default(),
    );
    let handle = supervised.handle.clone();
    let run = thread::spawn(move || block_on(supervised.run));
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let event = block_on(async {
            futures_lite::future::or(async { supervised.events.recv().await.ok() }, async {
                async_io::Timer::at(deadline).await;
                None
            })
            .await
        })
        .expect("a connection event before the deadline");
        match event {
            HostEvent::Connection(ConnectionEvent::Connected { accepted }) => {
                assert_eq!(accepted.root_id, host.root_id);
                break;
            }
            HostEvent::Connection(ConnectionEvent::AttemptFailed { reason, .. }) => {
                panic!("the supervised attempt failed: {reason}");
            }
            _ => {}
        }
    }
    let connection = handle.connection().expect("a ready connection");
    let catalog = block_on(connection.request_with_timeout::<SessionCatalogQuery>(
        &SessionCatalogQueryInput::ListStart,
        REQUEST_TIMEOUT,
    ));
    assert!(matches!(catalog, Ok(SessionCatalogQueryResult::Page { .. })), "{catalog:?}");
    eprintln!("the supervised connection from the saved profile lists sessions");
    handle.shutdown();
    run.join().expect("supervisor thread");
}
