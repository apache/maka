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
use maka_host_runtime::{
    application::{
        host::{
            AuthenticatedPeerStream, Channel, Client, Configuration, Host, LifecycleMode,
            LocalCall, OpenChannel, Options, PeerId, PeerPairingOptions, VERSION,
            protocol::{Opening, Request, Response, SessionControl},
            websocket::{self, WebSocketListener},
        },
        logs,
        transport::{GATEWAY, Reply, wire},
    },
    ipc::LocalListener,
};
use maka_packages::Package;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
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

async fn logs_host() -> (tempfile::TempDir, Arc<Host>, Configuration) {
    let (dir, host, configuration, _) = logs_host_with_store().await;
    (dir, host, configuration)
}

async fn logs_host_with_store() -> (tempfile::TempDir, Arc<Host>, Configuration, Arc<RootStore>) {
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

    (dir, host, configuration, store)
}

#[tokio::test]
async fn host_opens_independent_supplied_channels() {
    let (dir, host, configuration) = logs_host().await;
    let pairing = host
        .prepare_access("test-remote-client".into())
        .await
        .unwrap();
    let epoch = host.epoch();
    let (socket, local) = local_listener(dir.path());
    let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
        .await
        .unwrap();
    let address = websocket.local_addr().unwrap();
    let stop = CancellationToken::new();
    let mut server = tokio::spawn({
        let stop = stop.clone();
        async move { host.serve(local, Some(websocket), stop).await }
    });
    let transport: OpenChannel = Arc::new(move || {
        Box::pin(
            async move { Ok(Box::new(tokio::net::TcpStream::connect(address).await?) as Channel) },
        )
    });
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let bad =
        Client::connect_websocket(transport.clone(), "invalid".into(), client_id.clone(), None)
            .await;
    assert!(matches!(bad, Err(ref error) if error.contains("401")));

    let bearer: Arc<str> = pairing.credential.into();
    // A routine connect cannot accidentally activate a pending credential.
    assert!(
        Client::connect_websocket(transport.clone(), bearer.clone(), client_id.clone(), None)
            .await
            .is_err()
    );
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    Client::finalize_access(opener, client_id.clone(), &pairing.root_id, None)
        .await
        .unwrap();
    assert!(
        Client::connect_websocket(
            transport.clone(),
            bearer.clone(),
            client_id.clone(),
            Some(Uuid::new_v4())
        )
        .await
        .is_err()
    );
    let mut client = Client::connect_websocket(transport, bearer, client_id, None)
        .await
        .unwrap();
    assert_eq!(client.epoch(), epoch);
    assert_eq!(client.source().state_domain, pairing.root_id);
    for rejected in [
        client.quit().await,
        client.quit_ephemeral().await,
        client.publication().await.map(|_| ()),
        client
            .configure(
                client.source().clone(),
                configuration.clone(),
                configuration,
            )
            .await,
    ] {
        assert_eq!(
            rejected.unwrap_err(),
            "Host control requires the local owner"
        );
    }
    read_logs_on_independent_channels(&client).await;
    client.close().await.unwrap();
    let status = Client::status(&socket, Some(epoch)).await.unwrap();
    assert!(!status.closing && !status.closed);
    assert_eq!(status.sessions, 0);

    let opener: OpenChannel = Arc::new({
        let socket = socket.clone();
        move || {
            let socket = socket.clone();
            Box::pin(async move {
                Ok(Box::new(
                    maka_host_runtime::ipc::connect(&socket)
                        .await
                        .map_err(io::Error::other)?,
                ) as Channel)
            })
        }
    });
    let mut supplied = Client::connect_on(opener, Some(epoch), None).await.unwrap();
    assert_eq!(supplied.epoch(), epoch);
    supplied.publication().await.unwrap();
    read_logs_on_independent_channels(&supplied).await;
    supplied.quit_ephemeral().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut server)
        .await
        .expect("the last local owner can quit an ephemeral Host")
        .unwrap()
        .unwrap();
}

fn local_listener(dir: &std::path::Path) -> (std::path::PathBuf, LocalListener) {
    #[cfg(unix)]
    let socket = dir.join("host.sock");
    #[cfg(windows)]
    let socket = {
        let _ = dir;
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-remote-test-{}", Uuid::new_v4()))
    };
    let listener = LocalListener::bind(&socket).unwrap();
    (socket, listener)
}

fn read_call(client: &Client) -> impl Future<Output = Result<LocalCall, String>> + use<> {
    client.call(
        "hostLogs",
        "read".into(),
        json!({"position":{"kind":"tail"}}),
        Default::default(),
    )
}

async fn finish_log_read(mut call: LocalCall) {
    call.start().await.unwrap();
    match call.receive().await.unwrap() {
        Reply::Finished { result, cleanup } => {
            cleanup.unwrap();
            let page: maka_host_runtime::logs::HostLogPage =
                serde_json::from_value(result.unwrap()).unwrap();
            assert_eq!(page, maka_host_runtime::logs::HostLogPage::Missing);
        }
        _ => panic!("HostLogs.read did not finish"),
    }
    call.close().await.unwrap();
}

async fn read_logs_on_independent_channels(client: &Client) {
    let read = || async { finish_log_read(read_call(client).await.unwrap()).await };
    tokio::join!(read(), read());
}

type PeerSender = mpsc::Sender<AuthenticatedPeerStream>;

async fn peer_channel(sender: &PeerSender, peer_id: PeerId) -> io::Result<Channel> {
    let (client, stream) = tokio::io::duplex(64 * 1024);
    sender
        .send(AuthenticatedPeerStream {
            peer_id,
            stream: Box::new(stream),
        })
        .await
        .map_err(io::Error::other)?;
    Ok(Box::new(client))
}

fn peer_opener(sender: &PeerSender, peer: &PeerId) -> OpenChannel {
    let sender = sender.downgrade();
    let peer = peer.clone();
    Arc::new(move || {
        let sender = sender.upgrade();
        let peer = peer.clone();
        Box::pin(async move {
            let sender = sender.ok_or(io::ErrorKind::BrokenPipe)?;
            peer_channel(&sender, peer).await
        })
    })
}

async fn opening(
    open: &OpenChannel,
    request: Request,
    client_instance: Option<String>,
) -> wire::Reader<Channel> {
    let mut stream = open().await.unwrap();
    wire::write(
        &mut stream,
        &Opening {
            version: VERSION,
            epoch: None,
            client_instance,
            request,
        },
    )
    .await
    .unwrap();
    wire::Reader::new(stream)
}

async fn assert_peer_closed(mut stream: impl tokio::io::AsyncRead + Unpin) {
    let bytes = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut [0]))
        .await
        .expect("Host did not close the peer stream")
        .unwrap();
    assert_eq!(
        bytes, 0,
        "Host sent an unexpected response instead of closing"
    );
}

async fn assert_peer_revoked(mut stream: wire::Reader<Channel>) {
    let response = tokio::time::timeout(Duration::from_secs(5), stream.read::<Response>())
        .await
        .expect("Host did not report revoked peer access")
        .unwrap();
    assert!(matches!(response, Response::PeerAccessRevoked));
    assert_peer_closed(stream.inner).await;
}

async fn assert_rejected(mut stream: wire::Reader<Channel>) {
    assert!(
        tokio::time::timeout(Duration::from_secs(5), stream.read::<Response>())
            .await
            .expect("Host did not reject the opening")
            .is_err()
    );
}

async fn wait_for_server(server: tokio::task::JoinHandle<Result<(), String>>) {
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("Host did not finish serving")
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn oversized_native_opening_is_rejected_without_waiting_for_its_body() {
    let (_dir, host, _) = logs_host().await;
    let (sender, ingress) = mpsc::channel(1);
    let server = tokio::spawn(async move {
        host.serve_peer_streams(ingress, CancellationToken::new())
            .await
    });

    // No body means there is no Opening to identify. A reader without the
    // bound would wait for more bytes until the Host handshake timeout.
    let mut stream = peer_channel(&sender, PeerId::new("unpaired".into()).unwrap())
        .await
        .unwrap();
    stream.write_u32(64 * 1024 + 1).await.unwrap();
    assert_peer_closed(stream).await;
    drop(sender);
    wait_for_server(server).await;
}

#[tokio::test]
async fn native_peers_can_call_but_cannot_control_the_host_and_are_revocable() {
    let (_dir, host, configuration) = logs_host().await;
    let peer = PeerId::new("transport-key".into()).unwrap();
    let ungranted = PeerId::new("another-transport-key".into()).unwrap();
    host.grant_peer_access(peer.clone()).await.unwrap();
    let mut revoked = host.subscribe_revoked_peers();
    let (sender, ingress) = mpsc::channel(4);
    let cancel = CancellationToken::new();
    let server = tokio::spawn({
        let host = host.clone();
        let cancel = cancel.clone();
        async move { host.serve_peer_streams(ingress, cancel).await }
    });
    let open = peer_opener(&sender, &peer);
    let outsider = peer_opener(&sender, &ungranted);
    assert!(
        Client::connect_authenticated_peer(outsider.clone(), None)
            .await
            .is_err()
    );
    assert!(
        Client::status_channel(outsider().await.unwrap(), None)
            .await
            .is_err()
    );

    let mut client = Client::connect_authenticated_peer(open.clone(), None)
        .await
        .unwrap();
    let mut raw_anchor = opening(&open, Request::Connect, None).await;
    let Response::Connected(connected) = raw_anchor.read().await.unwrap() else {
        panic!("native anchor did not connect");
    };
    let ((), status) = tokio::join!(read_logs_on_independent_channels(&client), async {
        Client::status_channel(open().await.unwrap(), Some(client.epoch()))
            .await
            .unwrap()
    });
    assert_eq!(status.epoch, host.epoch());
    assert_eq!(status.sessions, 2);

    for request in [
        Request::PrepareAccess {
            principal: "forbidden".into(),
        },
        Request::RevokeAccess {
            credential: "forbidden".into(),
        },
        Request::Configure {
            source: client.source().clone(),
            previous: configuration.clone(),
            configuration,
        },
        Request::Retire {
            interrupt: true,
            allow_idle_connections: true,
            refuse_active_sessions: false,
        },
        Request::Quit {
            session: connected.session,
            ephemeral_only: false,
        },
        Request::Publication,
    ] {
        assert_peer_closed(opening(&open, request, None).await.inner).await;
    }
    // Leave a call stream waiting for its first RPC frame, as well as two anchors.
    let call = client.open_call_channel().await.unwrap();
    assert!(host.revoke_peer_access(peer.clone()).await.unwrap());
    assert_eq!(revoked.try_recv().unwrap(), peer);
    assert_peer_revoked(opening(&open, Request::Connect, None).await).await;
    assert!(
        Client::status_channel(open().await.unwrap(), None)
            .await
            .is_err()
    );
    assert_peer_closed(call).await;
    assert_peer_revoked(raw_anchor).await;
    assert!(client.refresh().await.is_err());
    cancel.cancel();
    wait_for_server(server).await;
}

#[tokio::test]
async fn revocation_drains_when_the_peer_never_reads_its_anchor() {
    let (_dir, host, _) = logs_host().await;
    let peer = PeerId::new("unreading-peer".into()).unwrap();
    host.grant_peer_access(peer.clone()).await.unwrap();
    let (sender, ingress) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let server = tokio::spawn({
        let host = host.clone();
        let cancel = cancel.clone();
        async move { host.serve_peer_streams(ingress, cancel).await }
    });

    // Connected fills this tiny send buffer. Keep the peer alive without
    // reading even one byte, so the revocation frame cannot fit either.
    let (mut anchor, host_stream) = tokio::io::duplex(32);
    sender
        .send(AuthenticatedPeerStream {
            peer_id: peer.clone(),
            stream: Box::new(host_stream),
        })
        .await
        .unwrap();
    wire::write(
        &mut anchor,
        &Opening {
            version: VERSION,
            epoch: None,
            client_instance: None,
            request: Request::Connect,
        },
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while host.status().sessions != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Host did not admit the anchor");
    assert!(host.revoke_peer_access(peer).await.unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        while host.status().sessions != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("unreading peer held up session cleanup");

    drop(anchor);
    cancel.cancel();
    wait_for_server(server).await;
}

#[tokio::test]
async fn narrowing_publication_fences_old_peers_and_leaves_idempotent_configure_alone() {
    let (dir, host, configuration) = logs_host().await;
    let peer = PeerId::new("transport-key".into()).unwrap();
    let other = PeerId::new("other-transport-key".into()).unwrap();
    host.grant_peer_access(peer.clone()).await.unwrap();
    host.grant_peer_access(other.clone()).await.unwrap();
    let mut revoked = host.subscribe_revoked_peers();

    let (socket, local) = local_listener(dir.path());
    let (sender, ingress) = mpsc::channel(4);
    let cancel = CancellationToken::new();
    let server = tokio::spawn({
        let host = host.clone();
        let cancel = cancel.clone();
        async move {
            host.serve_with_peers(local, None, Some(ingress), cancel)
                .await
        }
    });
    let open = peer_opener(&sender, &peer);
    let old = Client::connect_authenticated_peer(open.clone(), None)
        .await
        .unwrap();
    let duplicate = Client::connect_authenticated_peer(open.clone(), None)
        .await
        .unwrap();
    let other_anchor = Client::connect_authenticated_peer(peer_opener(&sender, &other), None)
        .await
        .unwrap();
    let mut owner = Client::connect(&socket, None).await.unwrap();
    let source = owner.publication().await.unwrap().source;

    owner
        .configure(source.clone(), configuration.clone(), configuration.clone())
        .await
        .unwrap();
    assert!(matches!(
        revoked.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    read_logs_on_independent_channels(&old).await;

    let mut inert = read_call(&old).await.unwrap();
    let old_opener = old.call_channel_opener().unwrap();
    let mut narrowed = configuration.clone();
    let Configuration::PublicHost { endpoints, .. } = &mut narrowed;
    assert!(
        endpoints
            .get_mut("hostLogs")
            .unwrap()
            .grant
            .methods
            .remove("read")
    );
    owner
        .configure(source.clone(), configuration.clone(), narrowed.clone())
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), inert.start())
            .await
            .expect("stale inert call was not fenced")
            .is_err()
    );
    // One notification per peer, even with multiple sessions and a subscriber
    // that has not polled while the entire batch was published.
    assert_eq!(
        BTreeSet::from([revoked.try_recv().unwrap(), revoked.try_recv().unwrap()]),
        BTreeSet::from([peer.clone(), other]),
    );
    assert!(matches!(
        revoked.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    assert!(
        Client::connect_authenticated_peer(open.clone(), None)
            .await
            .is_err()
    );

    host.grant_peer_access(peer).await.unwrap();
    assert!(old_opener.open().await.is_err());
    let mut fresh = Client::connect_authenticated_peer(open, None)
        .await
        .unwrap();
    let mut removed_method = read_call(&fresh).await.unwrap();
    assert_eq!(
        removed_method.start().await.unwrap_err(),
        "Application method is not granted"
    );

    owner
        .configure(source, configuration, narrowed)
        .await
        .unwrap();
    fresh.refresh().await.unwrap();
    assert!(matches!(
        revoked.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    drop((old, duplicate, other_anchor));
    fresh.close().await.unwrap();
    owner.close().await.unwrap();
    cancel.cancel();
    wait_for_server(server).await;
}

#[tokio::test]
async fn peer_only_eof_drains_a_call_whose_handshake_has_not_started() {
    let (_dir, host, _) = logs_host().await;
    let peer = PeerId::new("transport-key".into()).unwrap();
    host.grant_peer_access(peer.clone()).await.unwrap();
    let (sender, ingress) = mpsc::channel(1);
    let server = tokio::spawn(async move {
        host.serve_peer_streams(ingress, CancellationToken::new())
            .await
    });

    // Control exactly when the client gets each stream, not how the server
    // schedules its handshake task.
    let (handoff, streams) = mpsc::channel::<Channel>(1);
    let streams = Arc::new(tokio::sync::Mutex::new(streams));
    let open: OpenChannel = Arc::new(move || {
        let streams = streams.clone();
        Box::pin(async move { Ok(streams.lock().await.recv().await.unwrap()) })
    });
    handoff
        .send(peer_channel(&sender, peer.clone()).await.unwrap())
        .await
        .unwrap();
    let mut client = Client::connect_authenticated_peer(open, None)
        .await
        .unwrap();

    let last = peer_channel(&sender, peer).await.unwrap();
    drop(sender);
    handoff.send(last).await.unwrap();
    finish_log_read(read_call(&client).await.unwrap()).await;
    client.close().await.unwrap();
    wait_for_server(server).await;
}

#[tokio::test]
async fn peer_only_cancel_interrupts_eof_drain_with_an_open_anchor() {
    let (_dir, host, _) = logs_host().await;
    let peer = PeerId::new("transport-key".into()).unwrap();
    host.grant_peer_access(peer.clone()).await.unwrap();
    let (sender, ingress) = mpsc::channel(1);
    let open = peer_opener(&sender, &peer);
    let cancel = CancellationToken::new();
    let serving = host.serve_peer_streams(ingress, cancel.clone());
    tokio::pin!(serving);
    let anchor = tokio::select! {
        result = &mut serving => panic!("Host stopped before connect: {result:?}"),
        anchor = async {
            let mut anchor = opening(&open, Request::Connect, None).await;
            assert!(matches!(anchor.read::<Response>().await.unwrap(), Response::Connected(_)));
            anchor
        } => anchor,
    };
    drop(sender);
    // Drive the server past EOF, while the live anchor still prevents it draining.
    assert!(futures_util::poll!(&mut serving).is_pending());
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), serving)
        .await
        .expect("cancel did not interrupt EOF drain")
        .unwrap();
    assert_peer_closed(anchor.inner).await;
}

#[tokio::test]
async fn websocket_and_native_principals_are_isolated_and_ingress_eof_keeps_other_listeners_live() {
    let (dir, host, _) = logs_host().await;
    let peer = PeerId::new("same-identity-string".into()).unwrap();
    let wrong_peer = PeerId::new("different-transport-key".into()).unwrap();
    host.grant_peer_access(peer.clone()).await.unwrap();
    let pairing = host.prepare_access("websocket".into()).await.unwrap();
    let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
        .await
        .unwrap();
    let address = websocket.local_addr().unwrap();
    let tcp: OpenChannel = Arc::new(move || {
        Box::pin(
            async move { Ok(Box::new(tokio::net::TcpStream::connect(address).await?) as Channel) },
        )
    });
    let ws = websocket::channel_opener(tcp, pairing.credential.into());
    let (socket, local) = local_listener(dir.path());
    let (sender, ingress) = mpsc::channel(2);
    let cancel = CancellationToken::new();
    let server = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            host.serve_with_peers(local, Some(websocket), Some(ingress), cancel)
                .await
        }
    });
    let native = peer_opener(&sender, &peer);
    let wrong_native = peer_opener(&sender, &wrong_peer);
    let claimed = Some(peer.as_str().to_owned());

    assert_rejected(opening(&ws, Request::Connect, claimed.clone()).await).await;
    Client::finalize_access(ws.clone(), peer.as_str().into(), &pairing.root_id, None)
        .await
        .unwrap();
    let mut ws_anchor = opening(&ws, Request::Connect, claimed.clone()).await;
    let Response::Connected(web) = ws_anchor.read().await.unwrap() else {
        panic!("active Bearer did not establish a WebSocket session");
    };
    let mut peer_anchor = opening(&native, Request::Connect, None).await;
    let Response::Connected(binary) = peer_anchor.read().await.unwrap() else {
        panic!("granted identity did not establish a native session");
    };
    assert_rejected(
        opening(
            &ws,
            Request::Call {
                session: binary.session,
            },
            claimed.clone(),
        )
        .await,
    )
    .await;
    assert_peer_closed(
        opening(
            &native,
            Request::Call {
                session: web.session,
            },
            claimed.clone(),
        )
        .await
        .inner,
    )
    .await;
    assert_peer_revoked(opening(&wrong_native, Request::Connect, claimed.clone()).await).await;

    drop(sender);
    let mut local = Client::connect(&socket, None).await.unwrap();
    read_logs_on_independent_channels(&local).await;
    local.close().await.unwrap();
    let mut web_after_eof = Client::connect_on(ws, None, claimed.map(Arc::from))
        .await
        .unwrap();
    read_logs_on_independent_channels(&web_after_eof).await;
    web_after_eof.close().await.unwrap();
    // Keep peer_anchor open to ensure EOF stops accepting peers, not existing sessions.
    wire::write(peer_anchor.inner.get_mut(), &SessionControl::Refresh)
        .await
        .unwrap();
    assert!(matches!(
        peer_anchor.read::<Response>().await.unwrap(),
        Response::Refreshed(Ok(_))
    ));
    cancel.cancel();
    wait_for_server(server).await;
}

#[tokio::test]
async fn local_pairing_invite_grants_only_the_redeeming_native_peer_and_can_be_revoked() {
    use maka_remote_pairing::{DeviceIdentity, RelayEndpoint, SignedPairingTicket};

    let (dir, host, configuration, store) = logs_host_with_store().await;
    host.set_native_relays(vec![RelayEndpoint {
        url: "http://127.0.0.1:3340".into(),
        quic_port: None,
        cert_sha256: None,
    }])
    .unwrap();
    let host_peer_id = host.device_identity().public_key().to_string();
    let peer = PeerId::new(DeviceIdentity::generate().unwrap().public_key().to_string()).unwrap();
    let other = PeerId::new(DeviceIdentity::generate().unwrap().public_key().to_string()).unwrap();
    let legacy = host.prepare_access("websocket".into()).await.unwrap();
    let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
        .await
        .unwrap();
    let address = websocket.local_addr().unwrap();
    let tcp: OpenChannel = Arc::new(move || {
        Box::pin(
            async move { Ok(Box::new(tokio::net::TcpStream::connect(address).await?) as Channel) },
        )
    });
    let ws = websocket::channel_opener(tcp, legacy.credential.into());
    let (socket, local) = local_listener(dir.path());
    let local_open: OpenChannel = Arc::new({
        let socket = socket.clone();
        move || {
            let socket = socket.clone();
            Box::pin(async move {
                Ok(Box::new(
                    maka_host_runtime::ipc::connect(&socket)
                        .await
                        .map_err(io::Error::other)?,
                ) as Channel)
            })
        }
    });
    let root_id = host.root_id().to_owned();
    let epoch = host.epoch();
    let mut revoked = host.subscribe_revoked_peers();
    let (sender, ingress) = mpsc::channel(4);
    let cancel = CancellationToken::new();
    let server = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            host.serve_with_peers(local, Some(websocket), Some(ingress), cancel)
                .await
        }
    });

    let open = peer_opener(&sender, &peer);
    let outsider = peer_opener(&sender, &other);
    assert!(
        Client::connect_authenticated_peer(open.clone(), None)
            .await
            .is_err()
    );
    let now = || {
        u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap()
    };
    let options = |label: Option<&str>, ttl_secs| PeerPairingOptions {
        host_name: "Logs fixture".into(),
        label: label.map(str::to_owned),
        ttl_secs,
    };
    let prepare = |label, ttl| Client::prepare_peer_pairing(&socket, epoch, options(label, ttl));
    let invite = prepare(Some("My device"), None).await.unwrap();
    let ticket = SignedPairingTicket::parse_and_verify_uri(&invite.uri, now()).unwrap();
    let payload = ticket.payload();
    assert_eq!(payload.root_id, root_id);
    assert_eq!(payload.host_peer_id, host_peer_id);
    assert_eq!(payload.expires_at_ms, invite.expires_at_ms);
    let invite_secret = &payload.invite_secret;
    for channel in [local_open, ws] {
        let mut result = opening(
            &channel,
            Request::RedeemPeerPairing {
                invite_secret: invite_secret.clone(),
                device_label: None,
            },
            None,
        )
        .await;
        assert!(matches!(
            result.read::<Response>().await.unwrap(),
            Response::PeerPairingReceipt(Err(ref message)) if message == "pairing requires an authenticated native peer"
        ));
    }

    let error = Client::redeem_peer_pairing(
        open.clone(),
        invite_secret.clone(),
        Some("界".repeat(43)),
        &root_id,
    )
    .await
    .unwrap_err();
    assert!(
        error.contains("device label must be at most 128 bytes"),
        "{error}"
    );

    let receipt = Client::redeem_peer_pairing(
        open.clone(),
        invite_secret.clone(),
        Some("Client label".into()),
        &root_id,
    )
    .await
    .unwrap();
    assert_eq!(receipt.peer_id, peer.as_str());
    let devices = Client::list_peer_access(&socket, epoch).await.unwrap();
    let [device] = devices.as_slice() else {
        panic!("expected exactly one paired device");
    };
    assert_eq!(device.peer_id, peer.as_str());
    assert_eq!(device.label, "My device");

    let mut connected = Client::connect_authenticated_peer(open.clone(), None)
        .await
        .unwrap();
    finish_log_read(read_call(&connected).await.unwrap()).await;
    for replay in [open.clone(), outsider.clone()] {
        assert!(
            Client::redeem_peer_pairing(replay, invite_secret.clone(), None, &root_id)
                .await
                .is_err()
        );
    }
    assert!(
        Client::connect_authenticated_peer(outsider, None)
            .await
            .is_err()
    );
    for request in [
        Request::RemoteAccessStatus {
            invite_id: Some("invite".into()),
        },
        Request::UpdateRemoteAccess(
            maka_host_runtime::application::host::remote_access::RemoteAccessUpdate {
                enabled: false,
                relay_only: false,
                relays: Vec::new(),
            },
        ),
        Request::PreparePeerPairing(options(None, None)),
        Request::ListPeerAccess,
        Request::RevokePeerAccess {
            peer_id: peer.as_str().into(),
        },
    ] {
        assert_peer_closed(opening(&open, request, None).await.inner).await;
    }

    assert!(
        Client::revoke_peer_access(&socket, epoch, &peer)
            .await
            .unwrap()
    );
    assert_eq!(revoked.try_recv().unwrap(), peer);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), connected.refresh())
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        Client::connect_authenticated_peer(open.clone(), None)
            .await
            .is_err()
    );
    assert!(
        Client::list_peer_access(&socket, epoch)
            .await
            .unwrap()
            .is_empty()
    );

    let still_valid = prepare(None, None).await.unwrap();
    let mut owner = Client::connect(&socket, None).await.unwrap();
    let source = owner.publication().await.unwrap().source;
    let mut narrowed = configuration.clone();
    let Configuration::PublicHost { endpoints, .. } = &mut narrowed;
    endpoints
        .get_mut("hostLogs")
        .unwrap()
        .grant
        .methods
        .remove("watch");
    let loaded = store
        .load_application(source.deployment)
        .await
        .unwrap()
        .unwrap();
    let (loaded, packages, _, _) = loaded.into_parts();
    let next_source = store
        .commit_application(
            source.deployment,
            source.revision,
            loaded.input,
            loaded.remote_exports,
            packages,
        )
        .await
        .unwrap();
    assert_eq!(
        owner
            .configure(source, configuration.clone(), narrowed.clone())
            .await
            .unwrap_err(),
        "Host configuration source or persisted authority changed"
    );
    let valid_ticket = SignedPairingTicket::parse_and_verify_uri(&still_valid.uri, now()).unwrap();
    Client::redeem_peer_pairing(
        open.clone(),
        valid_ticket.payload().invite_secret.clone(),
        None,
        &root_id,
    )
    .await
    .unwrap();

    let blocked = prepare(None, None).await.unwrap();
    let blocked_ticket = SignedPairingTicket::parse_and_verify_uri(&blocked.uri, now()).unwrap();
    let blocked_secret = &blocked_ticket.payload().invite_secret;
    owner
        .configure(next_source.clone(), configuration.clone(), narrowed.clone())
        .await
        .unwrap();
    assert!(
        Client::redeem_peer_pairing(open.clone(), blocked_secret.clone(), None, &root_id)
            .await
            .is_err()
    );
    owner
        .configure(next_source, narrowed, configuration)
        .await
        .unwrap();
    assert!(
        Client::redeem_peer_pairing(open.clone(), blocked_secret.clone(), None, &root_id)
            .await
            .is_err()
    );

    for ttl in [0, u64::MAX] {
        assert!(prepare(None, Some(ttl)).await.is_err());
    }
    let issued_after = now();
    let short = prepare(None, Some(1)).await.unwrap();
    let short_ticket = SignedPairingTicket::parse_and_verify_uri(&short.uri, issued_after).unwrap();
    assert!((issued_after + 1_000..=now() + 1_000).contains(&short.expires_at_ms));
    while let Some(remaining) = short.expires_at_ms.checked_sub(now()) {
        if remaining == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(remaining)).await;
    }
    assert!(
        Client::redeem_peer_pairing(
            open,
            short_ticket.payload().invite_secret.clone(),
            None,
            &root_id
        )
        .await
        .is_err()
    );

    owner.close().await.unwrap();
    cancel.cancel();
    wait_for_server(server).await;
}
