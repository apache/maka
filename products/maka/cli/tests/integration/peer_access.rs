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

use crate::host_support as fixture;

use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, endpoint::presets};
use iroh_relay::server::{RelayConfig, Server, ServerConfig};
use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{ROOT_MARKER, RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        host::{
            AuthenticatedPeerStream, Channel, Client, Configuration, Host, OpenChannel, PeerId,
        },
        logs,
        transport::GATEWAY,
    },
    ipc::LocalListener,
};
use maka_packages::Package;
use maka_remote_pairing::{
    DeviceIdentity, HOST_IDENTITY_FILE, RelayEndpoint, SAS_EXPORTER_LABEL, SignedPairingTicket,
    derive_handshake_sas, parse_peer_id,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs, io,
    process::Output,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::join, sync::mpsc, time::timeout};
use tokio_util::sync::CancellationToken;

const ALPN: &[u8] = b"maka/host/v1";

pub(super) async fn open_host(sandbox: &fixture::Sandbox) -> Arc<Host> {
    let path = sandbox.root.clone();
    let root = tokio::task::spawn_blocking(move || {
        RootOwner::create(&path, &RootNamespaces::for_current_account().unwrap()).unwrap()
    })
    .await
    .unwrap();
    let store = Arc::new(
        RootStore::open(Arc::new(root), ROOT_MIGRATIONS)
            .await
            .unwrap(),
    );
    let package = |id: &str, host: Value| {
        Package::new(BTreeMap::from([(
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({"schemaVersion":1,"id":id,"application":{"host":host}}))
                .unwrap(),
        )]))
        .unwrap()
    };
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
    let id = uuid::Uuid::new_v4;
    let (deployment, consumer) = (id(), id());
    let source = store
        .commit_application(
            deployment, 0,
            serde_json::from_value(json!({"instances":{
                "logs":{"key":id(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
                "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                    "bindings":{"hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}]}}
            }})).unwrap(),
            vec![], vec![logs, gateway],
        )
        .await
        .unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read"],"recovery":false}}
        })).unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    store
        .select_committed_application_launch(source, serde_json::to_value(&configuration).unwrap())
        .await
        .unwrap();
    Host::open(store, deployment, Default::default(), None, configuration)
        .await
        .unwrap()
}

fn json_output(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn relay_only(identity: &DeviceIdentity, url: RelayUrl) -> iroh::endpoint::Builder {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(identity.secret_bytes()))
        .relay_mode(RelayMode::Custom(url.into()))
        .clear_ip_transports()
}

#[tokio::test]
async fn host_access_invite_redeems_over_the_running_hosts_advertised_relay() {
    timeout(Duration::from_secs(45), async {
        let sandbox = fixture::Sandbox::new().await.unwrap();
        let host = open_host(&sandbox).await;
        let socket = sandbox
            .directory
            .path()
            .canonicalize()
            .unwrap()
            .join("host.sock");
        let listener = LocalListener::bind(&socket).unwrap();
        let registration = host.publish_registration(&socket, None).unwrap();
        let stop = CancellationToken::new();
        let (sender, ingress) = mpsc::channel(1);
        let server = tokio::spawn({
            let host = host.clone();
            let stop = stop.clone();
            async move {
                host.serve_with_peers(listener, None, Some(ingress), stop)
                    .await
            }
        });
        let backup = sandbox.directory.path().join("backup");
        fs::create_dir(&backup).unwrap();
        fs::copy(sandbox.root.join(ROOT_MARKER), backup.join(ROOT_MARKER)).unwrap();
        let backup_id = DeviceIdentity::load_or_create(&backup.join(HOST_IDENTITY_FILE))
            .unwrap()
            .public_key();

        let executable = crate::maka_executable();
        let command = || {
            let mut cmd = fixture::command_for(&executable, &sandbox.home, &sandbox.workspace);
            cmd.kill_on_drop(true);
            cmd
        };
        let access = |subcommand| {
            let mut cmd = command();
            cmd.args([
                "host",
                "access",
                subcommand,
                "--timeout-ms",
                "15000",
                "--root",
            ])
            .arg(&backup);
            cmd
        };
        let invite = || {
            let mut cmd = access("invite");
            cmd.args(["--host-name", "Live Host"]);
            cmd
        };
        let no_route = invite().output().await.unwrap();
        assert!(!no_route.status.success());
        let diagnostic = String::from_utf8_lossy(&no_route.stderr);
        assert!(
            diagnostic.contains("no active native relay routes"),
            "{diagnostic}"
        );

        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            0,
        ))));
        let relay = Server::spawn(config).await.unwrap();
        let route = RelayEndpoint {
            url: format!("http://{}", relay.http_addr().unwrap()),
            quic_port: None,
            cert_sha256: None,
        };
        let invalid = RelayEndpoint {
            cert_sha256: Some("ab".repeat(32)),
            ..route.clone()
        };
        assert!(
            host.set_native_relays(vec![invalid])
                .unwrap_err()
                .contains("requires https://")
        );
        let home_relay = RelayUrl::from(route.validate().unwrap().url);
        let endpoint = relay_only(host.device_identity(), home_relay)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        endpoint.online().await;
        host.set_native_relays(vec![route]).unwrap();

        let now = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let invite = json_output(invite().output().await.unwrap());
        let ticket =
            SignedPairingTicket::parse_and_verify_uri(invite["uri"].as_str().unwrap(), now)
                .unwrap();
        let payload = ticket.payload();
        let host_key = parse_peer_id(&payload.host_peer_id).unwrap();
        assert_eq!(host_key, host.device_identity().public_key());
        assert_ne!(host_key, backup_id);
        let [advertised] = payload.relays.as_slice() else {
            panic!("expected exactly one active relay route");
        };
        let relay_url = RelayUrl::from(advertised.validate().unwrap().url);
        let host_id = EndpointId::from_bytes(host_key.as_bytes()).unwrap();
        let device = DeviceIdentity::generate().unwrap();
        let peer = relay_only(&device, relay_url.clone()).bind().await.unwrap();
        let (dialed, accepted) = tokio::join!(
            peer.connect(EndpointAddr::new(host_id).with_relay_url(relay_url), ALPN),
            async { endpoint.accept().await.unwrap().await.unwrap() },
        );
        let dialed = dialed.unwrap();
        assert_eq!(dialed.remote_id(), host_id);
        let client_key = parse_peer_id(&accepted.remote_id().to_string()).unwrap();
        assert_eq!(client_key, device.public_key());
        let sas = |conn: &iroh::endpoint::Connection| {
            let mut exporter = [0; 32];
            conn.export_keying_material(&mut exporter, SAS_EXPORTER_LABEL, b"")
                .unwrap();
            derive_handshake_sas(&host_key, &client_key, &exporter)
        };
        assert_eq!(sas(&dialed), sas(&accepted));

        let open: OpenChannel = Arc::new(move || {
            let conn = dialed.clone();
            Box::pin(async move {
                let (send, recv) = conn.open_bi().await.map_err(io::Error::other)?;
                Ok(Box::new(join(recv, send)) as Channel)
            })
        });
        let (receipt, ()) = tokio::join!(
            Client::redeem_peer_pairing(
                open,
                payload.invite_secret.clone(),
                Some("Laptop".into()),
                &payload.root_id
            ),
            async {
                let (send, recv) = accepted.accept_bi().await.unwrap();
                sender
                    .send(AuthenticatedPeerStream {
                        peer_id: PeerId::new(client_key.to_string()).unwrap(),
                        stream: Box::new(join(recv, send)),
                    })
                    .await
                    .unwrap();
            },
        );
        let receipt = receipt.unwrap();
        assert_eq!(receipt.peer_id, client_key.to_string());
        let peers = json_output(access("peers").output().await.unwrap());
        let [listed] = peers.as_array().unwrap().as_slice() else {
            panic!("expected exactly one paired peer");
        };
        assert_eq!(listed["peerId"], receipt.peer_id);
        assert_eq!(listed["label"], "Laptop");

        let revoked = access("revoke")
            .args(["--peer-id", &receipt.peer_id])
            .output()
            .await
            .unwrap();
        assert_eq!(json_output(revoked), json!({"revoked": true}));
        assert_eq!(
            json_output(access("peers").output().await.unwrap()),
            json!([])
        );

        let expired = command()
            .args(["host", "access", "peers", "--timeout-ms", "1", "--root"])
            .arg(&backup)
            .output()
            .await
            .unwrap();
        let diagnostic = String::from_utf8_lossy(&expired.stderr);
        assert!(
            expired.status.code() == Some(70) || diagnostic.contains("observation timed out"),
            "{diagnostic}"
        );

        drop(accepted);
        peer.close().await;
        endpoint.close().await;
        relay.shutdown().await.unwrap();
        stop.cancel();
        server.await.unwrap().unwrap();
        registration.remove().unwrap();
    })
    .await
    .expect("CLI invite and relay redemption did not finish");
}

#[tokio::test]
async fn host_access_keeps_bearer_prepare_and_revoke_and_requires_one_revoke_target() {
    let sandbox = fixture::Sandbox::new().await.unwrap();
    let host = open_host(&sandbox).await;
    let socket = sandbox
        .directory
        .path()
        .canonicalize()
        .unwrap()
        .join("host.sock");
    let listener = LocalListener::bind(&socket).unwrap();
    let registration = host.publish_registration(&socket, None).unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn({
        let stop = stop.clone();
        async move { host.serve_local(listener, stop).await }
    });

    let executable = crate::maka_executable();
    let access = |subcommand| {
        let mut cmd = fixture::command_for(&executable, &sandbox.home, &sandbox.workspace);
        cmd.args([
            "host",
            "access",
            subcommand,
            "--timeout-ms",
            "15000",
            "--root",
        ])
        .arg(&sandbox.root);
        cmd
    };
    let prepared = access("prepare")
        .args(["--principal", "desktop"])
        .output()
        .await
        .unwrap();
    let pairing = json_output(prepared);
    assert!(
        pairing["credential"]
            .as_str()
            .unwrap()
            .starts_with("maka_rh_")
    );
    let id = pairing["credentialId"].as_str().unwrap();
    for (flags, expected) in [
        (&[][..], "required"),
        (
            &["--credential-id", id, "--peer-id", "peer"][..],
            "cannot be used with",
        ),
    ] {
        let rejected = access("revoke").args(flags).output().await.unwrap();
        assert_eq!(rejected.status.code(), Some(2));
        let diagnostic = String::from_utf8_lossy(&rejected.stderr);
        assert!(diagnostic.contains(expected), "{diagnostic}");
    }
    let revoked = access("revoke")
        .args(["--credential-id", id])
        .output()
        .await
        .unwrap();
    assert_eq!(json_output(revoked), json!({"revoked": true}));

    stop.cancel();
    server.await.unwrap().unwrap();
    registration.remove().unwrap();
}
