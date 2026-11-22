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
use maka_ios_shell::{EndpointOpener, HostBridge, engine_config};
use maka_packages::Package;
use maka_remote_client::{PairingTicketV1, tcp_endpoint_opener};
use nsh_core::{
    Size,
    platform::{Environment, Os},
    prelude::px,
};
use nsh_engine::HostChannel;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct LiveTestHost {
    _dir: tempfile::TempDir,
    ws_addr: SocketAddr,
    pairing: Pairing,
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
                    "grant": { "methods": ["read", "watch"], "recovery": false }
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
            .prepare_access("ios-shell-ui-test".into())
            .await
            .unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-ios-test-{}", Uuid::new_v4()));
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
            stop,
            server,
        }
    }

    async fn shutdown(self) {
        self.stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.server).await;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn make_ticket_uri(live: &LiveTestHost, host_name: &str, peer_id: &str) -> String {
    PairingTicketV1::new(
        live.pairing.root_id.clone(),
        host_name,
        peer_id,
        vec![format!("ws://{}", live.ws_addr)],
        live.pairing.credential.clone(),
        "nonce-ios-headless-01",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap()
}

#[test]
fn ios_shell_pairs_real_host_verifies_live_rpc_filters_reconnects_and_removes() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let live = rt.block_on(LiveTestHost::start());
    let uri = make_ticket_uri(
        &live,
        "Mac Studio Live",
        "peer_1111111111111111111111111111111111111111111111111111111111111111",
    );

    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let _bridge =
        HostBridge::attach(channel.clone(), support_dir.path(), rt.handle().clone()).unwrap();

    let mut cfg = engine_config(channel.clone(), rt.handle().clone());
    cfg.viewport = Size::new(px(390.0), px(844.0));
    cfg.environment = Environment {
        os: Os::Ios,
        ..Environment::default()
    };
    let mut app = nsh_testing::Headless::start(cfg).unwrap();

    // 1. Cold-start Home renders V7 empty state & single-row Maka Bot.
    app.wait_for("text:Maka").unwrap();
    app.wait_for("text:连接你的第一台电脑").unwrap();

    // 2. Deliver deep-link pairing URI -> decodes & shows 6-digit SAS.
    channel
        .send("ios.pairingUri", json!({ "uri": uri }))
        .unwrap();
    app.wait_for("text:核对桌面端 Mac Studio Live 上的 6 位数字")
        .unwrap();
    app.wait_for("label:Confirm pairing and connect").unwrap();

    // 3. Confirm SAS -> real finalize_access + connect -> transitions to Chat!
    app.press("label:Confirm pairing and connect").unwrap();
    app.wait_for("text:远端 Host 已就绪").unwrap();

    // Verify mode-0600 private permissions on persisted secrets and store files on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [
            "device-identity.json",
            "credentials.json",
            "saved-hosts.json",
        ] {
            let mode = fs::metadata(support_dir.path().join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{file} must have mode 0600, got {mode:o}");
        }
    }

    // 4. Docked bottom Permission Approval -> Allow once triggers real hostLogs.read RPC!
    app.wait_for("label:Allow once").unwrap();
    app.press("label:Allow once").unwrap();
    app.wait_for("text:/实时 RPC 校验通过.*hostLogs/").unwrap();
    app.wait_for("text:/已允许本次/").unwrap();

    // 5. Telegram-style Reaction picker -> tap 🔥 toggles reaction pill.
    app.press("label:Agent message m2").unwrap();
    app.wait_for("label:React 🔥").unwrap();
    app.press("label:React 🔥").unwrap();
    app.wait_for("label:Toggle reaction 🔥").unwrap();

    // 6. Apple HIG AskUserQuestion card WITH custom user free-text input!
    app.press("label:Question custom option").unwrap();
    app.wait_for("label:Custom question answer input").unwrap();
    app.type_text("label:Custom question answer input", "先跑全量单测再决定")
        .unwrap();
    app.press("label:Submit question answer").unwrap();
    app.wait_for("text:/已回答 · 先跑全量单测再决定/").unwrap();

    // 7. 3-level TurnPanel expand -> Edit card jumps to Diff Viewer -> tap line quotes back!
    app.press("label:Toggle work details m2").unwrap();
    app.wait_for("label:Step platform/remote-client/src/client.rs")
        .unwrap();
    app.press("label:Step platform/remote-client/src/client.rs")
        .unwrap();
    app.wait_for("text:轻点任意一行可引用发给 Maka").unwrap();
    app.press("label:Quote diff line 340").unwrap();
    app.wait_for("text:/引用: client.*340/").unwrap();

    // 8. Open 78% Slide-Over Drawer -> real setFilter wire schema round-trip.
    app.press("label:Open drawer").unwrap();
    app.wait_for("text:Mac Studio Live").unwrap();
    app.wait_for("text:全部").unwrap();
    app.press("label:Switch host filter").unwrap();
    app.wait_for("text:单台").unwrap();
    let persisted_store: Value =
        serde_json::from_slice(&fs::read(support_dir.path().join("saved-hosts.json")).unwrap())
            .unwrap();
    assert_eq!(persisted_store["filter"]["kind"], "single_computer");
    assert_eq!(persisted_store["filter"]["root_id"], live.pairing.root_id);
    app.press("label:Switch host filter").unwrap();
    app.wait_for("text:全部").unwrap();

    // 9. Settings: toggle Light theme, disconnect, reconnect from Home, then remove host.
    app.press("label:Settings").unwrap();
    app.wait_for("text:深石墨暗色").unwrap();
    app.press("label:Toggle theme").unwrap();
    app.wait_for("text:暖纸白亮色").unwrap();
    app.press("label:Disconnect active host").unwrap();
    app.press("label:Back from settings").unwrap();
    app.wait_for("text:已保存 · 点击连接").unwrap();

    // Reconnect saved Host via Home row -> returns to Chat connected!
    app.press("label:Host Mac Studio Live").unwrap();
    app.wait_for("text:远端 Host 已就绪").unwrap();

    // Remove saved Host via Slide-Over Drawer -> Settings -> returns to cold-start empty state.
    app.press("label:Open drawer").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Remove Mac Studio Live").unwrap();
    app.press("label:Back from settings").unwrap();
    app.wait_for("text:连接你的第一台电脑").unwrap();

    drop(app);
    rt.block_on(live.shutdown());
}

#[tokio::test]
async fn pair_blocks_peer_mismatch_before_writes_and_rolls_back_on_store_failure() {
    let live_a = LiveTestHost::start().await;
    let live_b = LiveTestHost::start().await;
    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let bridge = HostBridge::attach(
        channel,
        support_dir.path(),
        tokio::runtime::Handle::current(),
    )
    .unwrap();

    let peer_a = "peer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let uri_a = make_ticket_uri(&live_a, "Mac Host A", peer_a);
    bridge.pair_host(json!({ "uri": uri_a })).await.unwrap();

    let cred_path = support_dir.path().join("credentials.json");
    let creds_before_hijack = fs::read_to_string(&cred_path).unwrap();
    assert!(creds_before_hijack.contains(&live_a.pairing.credential));

    // 1. Same root_id with a different peer_id + different token must fail BEFORE touching disk credentials.
    let hijack_uri = PairingTicketV1::new(
        live_a.pairing.root_id.clone(),
        "Hijacked Mac",
        "peer_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        vec![format!("ws://{}", live_a.ws_addr)],
        "evil-replacement-token",
        "nonce-hijack",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();
    let hijack_err = bridge
        .pair_host(json!({ "uri": hijack_uri }))
        .await
        .unwrap_err();
    assert!(
        hijack_err.contains("peer") || hijack_err.contains("mismatch"),
        "expected PeerIdMismatch error, got: {hijack_err}"
    );
    assert_eq!(
        fs::read_to_string(&cred_path).unwrap(),
        creds_before_hijack,
        "credentials.json must not be modified when peer admission fails"
    );

    // 2. Replace saved-hosts.json with a non-empty directory so store persistence fails on disk.
    let store_path = support_dir.path().join("saved-hosts.json");
    fs::remove_file(&store_path).unwrap();
    fs::create_dir(&store_path).unwrap();
    fs::write(store_path.join("blocker"), b"fail persist").unwrap();

    let uri_b = make_ticket_uri(
        &live_b,
        "Host B Fail Persist",
        "peer_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let pair_io_err = bridge.pair_host(json!({ "uri": uri_b })).await.unwrap_err();
    assert!(!pair_io_err.is_empty());

    // Credentials must have rolled back to ONLY Host A, and Host B must not exist in memory.
    let creds_after_pair_fail = fs::read_to_string(&cred_path).unwrap();
    assert!(creds_after_pair_fail.contains(&live_a.pairing.credential));
    assert!(
        !creds_after_pair_fail.contains(&live_b.pairing.credential),
        "failed pair must roll back credentials.json"
    );
    let snap = bridge.bootstrap().await.unwrap();
    assert_eq!(snap["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(snap["active"]["rootId"], live_a.pairing.root_id);

    // 3. remove_host while saved-hosts.json persist fails must also roll back credentials & keep Host A active.
    let remove_io_err = bridge
        .remove_host(json!({ "rootId": live_a.pairing.root_id }))
        .await
        .unwrap_err();
    assert!(!remove_io_err.is_empty());
    assert!(
        fs::read_to_string(&cred_path)
            .unwrap()
            .contains(&live_a.pairing.credential),
        "failed remove_host must roll back credentials.json"
    );
    let snap_after_remove_fail = bridge.bootstrap().await.unwrap();
    assert_eq!(snap_after_remove_fail["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(
        snap_after_remove_fail["active"]["rootId"],
        live_a.pairing.root_id
    );

    live_a.shutdown().await;
    live_b.shutdown().await;
}

#[tokio::test]
async fn concurrent_disconnect_and_remove_fence_inflight_connect_and_surface_close_error() {
    let live = LiveTestHost::start().await;
    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();

    struct CuttableStream {
        inner: maka_remote_client::BoxedStream,
        cut: Arc<AtomicBool>,
    }
    impl tokio::io::AsyncRead for CuttableStream {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.cut.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated abrupt link loss",
                )));
            }
            std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }
    impl tokio::io::AsyncWrite for CuttableStream {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            if self.cut.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated abrupt link loss",
                )));
            }
            std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
        }
        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.cut.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated abrupt link loss",
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

    let gate_enabled = Arc::new(AtomicBool::new(false));
    let wire_cut = Arc::new(AtomicBool::new(false));
    let connect_entered = Arc::new(Notify::new());
    let connect_release = Arc::new(Notify::new());

    let opener: EndpointOpener = {
        let gate_enabled = gate_enabled.clone();
        let wire_cut = wire_cut.clone();
        let connect_entered = connect_entered.clone();
        let connect_release = connect_release.clone();
        Arc::new(move |endpoint: &str| {
            let base = tcp_endpoint_opener(endpoint).map_err(|err| err.to_string())?;
            let gate_enabled = gate_enabled.clone();
            let wire_cut = wire_cut.clone();
            let connect_entered = connect_entered.clone();
            let connect_release = connect_release.clone();
            Ok(Arc::new(move || {
                let base = base.clone();
                let gate_enabled = gate_enabled.clone();
                let wire_cut = wire_cut.clone();
                let connect_entered = connect_entered.clone();
                let connect_release = connect_release.clone();
                Box::pin(async move {
                    if gate_enabled.load(Ordering::SeqCst) {
                        connect_entered.notify_one();
                        connect_release.notified().await;
                    }
                    let inner = base().await?;
                    Ok(Box::new(CuttableStream {
                        inner,
                        cut: wire_cut,
                    }) as maka_remote_client::BoxedStream)
                })
            }))
        })
    };

    let bridge = HostBridge::attach_with_opener(
        channel,
        support_dir.path(),
        tokio::runtime::Handle::current(),
        opener,
    )
    .unwrap();

    let uri = make_ticket_uri(
        &live,
        "Race Target Mac",
        "peer_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    bridge.pair_host(json!({ "uri": uri })).await.unwrap();
    bridge.disconnect_host().await.unwrap();

    // Case A: disconnect_host arrives while connect_host is in-flight -> stale connect is rejected & never installed.
    gate_enabled.store(true, Ordering::SeqCst);
    let pending_connect = tokio::spawn({
        let bridge = bridge.clone();
        let root_id = live.pairing.root_id.clone();
        async move { bridge.connect_host(json!({ "rootId": root_id })).await }
    });
    connect_entered.notified().await;
    bridge.disconnect_host().await.unwrap();
    connect_release.notify_one();

    let stale_err = pending_connect.await.unwrap().unwrap_err();
    assert!(
        stale_err.contains("cancelled"),
        "expected superseded connect error, got: {stale_err}"
    );
    assert!(bridge.bootstrap().await.unwrap()["active"].is_null());

    // Case B: remove_host arrives while connect_host is in-flight -> removed host is never resurrected as active.
    let pending_connect_b = tokio::spawn({
        let bridge = bridge.clone();
        let root_id = live.pairing.root_id.clone();
        async move { bridge.connect_host(json!({ "rootId": root_id })).await }
    });
    connect_entered.notified().await;
    bridge
        .remove_host(json!({ "rootId": live.pairing.root_id }))
        .await
        .unwrap();
    connect_release.notify_one();

    let removed_err = pending_connect_b.await.unwrap().unwrap_err();
    assert!(
        removed_err.contains("cancelled"),
        "expected cancelled connect error after remove, got: {removed_err}"
    );
    let snap_after_remove = bridge.bootstrap().await.unwrap();
    assert!(snap_after_remove["active"].is_null());
    assert!(snap_after_remove["hosts"].as_array().unwrap().is_empty());

    // Case C: Re-pair cleanly, kill the remote Host abruptly, verify disconnect_host surfaces the close error
    // AND updates state to active: null immediately.
    gate_enabled.store(false, Ordering::SeqCst);
    let live2 = LiveTestHost::start().await;
    let uri2 = make_ticket_uri(
        &live2,
        "Abrupt Close Mac",
        "peer_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    );
    bridge.pair_host(json!({ "uri": uri2 })).await.unwrap();
    assert_eq!(
        bridge.bootstrap().await.unwrap()["active"]["rootId"],
        live2.pairing.root_id
    );

    // Sever the active transport link abruptly so remote SessionControl::Close fails.
    wire_cut.store(true, Ordering::SeqCst);
    let close_err = bridge.disconnect_host().await.unwrap_err();
    assert!(
        close_err.contains("remote close failed"),
        "expected surfaced remote close failure, got: {close_err}"
    );
    assert!(
        bridge.bootstrap().await.unwrap()["active"].is_null(),
        "bridge state must already reflect disconnected after failed remote close"
    );

    live2.shutdown().await;
    live.shutdown().await;
}

#[tokio::test]
async fn stalled_remote_close_during_remove_does_not_block_persist_gate() {
    use std::task::{Context, Poll};

    struct StallableReadStream {
        inner: maka_remote_client::BoxedStream,
        stall_reads: Arc<AtomicBool>,
        read_stalled: Arc<Notify>,
        waker_slot: Arc<std::sync::Mutex<Option<std::task::Waker>>>,
    }
    impl tokio::io::AsyncRead for StallableReadStream {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.stall_reads.load(Ordering::SeqCst) {
                *self.waker_slot.lock().unwrap() = Some(cx.waker().clone());
                self.read_stalled.notify_one();
                return Poll::Pending;
            }
            std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }
    impl tokio::io::AsyncWrite for StallableReadStream {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
        }
        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    let live_a = LiveTestHost::start().await;
    let live_b = LiveTestHost::start().await;
    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();

    let stall_reads = Arc::new(AtomicBool::new(false));
    let read_stalled = Arc::new(Notify::new());
    let waker_slot: Arc<std::sync::Mutex<Option<std::task::Waker>>> =
        Arc::new(std::sync::Mutex::new(None));

    let opener: EndpointOpener = {
        let stall_reads = stall_reads.clone();
        let read_stalled = read_stalled.clone();
        let waker_slot = waker_slot.clone();
        Arc::new(move |endpoint: &str| {
            let base = tcp_endpoint_opener(endpoint).map_err(|err| err.to_string())?;
            let stall_reads = stall_reads.clone();
            let read_stalled = read_stalled.clone();
            let waker_slot = waker_slot.clone();
            Ok(Arc::new(move || {
                let base = base.clone();
                let stall_reads = stall_reads.clone();
                let read_stalled = read_stalled.clone();
                let waker_slot = waker_slot.clone();
                Box::pin(async move {
                    let inner = base().await?;
                    Ok(Box::new(StallableReadStream {
                        inner,
                        stall_reads,
                        read_stalled,
                        waker_slot,
                    }) as maka_remote_client::BoxedStream)
                })
            }))
        })
    };

    let bridge = HostBridge::attach_with_opener(
        channel,
        support_dir.path(),
        tokio::runtime::Handle::current(),
        opener,
    )
    .unwrap();

    // Pair Host B first, then Host A (so Host A is currently active and Host B remains saved).
    let uri_b = make_ticket_uri(
        &live_b,
        "Host B Survivor",
        "peer_2222222222222222222222222222222222222222222222222222222222222222",
    );
    let uri_a = make_ticket_uri(
        &live_a,
        "Host A Stalled Close",
        "peer_3333333333333333333333333333333333333333333333333333333333333333",
    );
    bridge.pair_host(json!({ "uri": uri_b })).await.unwrap();
    bridge.pair_host(json!({ "uri": uri_a })).await.unwrap();

    // Stall reads on the active Host A anchor so remove_host blocks waiting for Response::Closed.
    stall_reads.store(true, Ordering::SeqCst);
    let remove_task = tokio::spawn({
        let bridge = bridge.clone();
        let root_a = live_a.pairing.root_id.clone();
        async move { bridge.remove_host(json!({ "rootId": root_a })).await }
    });
    tokio::time::timeout(Duration::from_secs(3), read_stalled.notified())
        .await
        .expect("remove_host must reach remote close().await");

    // While remove_host's remote close() is stalled, set_filter MUST complete promptly (persist_gate released!).
    let filter_snap = tokio::time::timeout(
        Duration::from_secs(2),
        bridge.set_filter(json!({
            "filter": { "kind": "single_computer", "root_id": live_b.pairing.root_id }
        })),
    )
    .await
    .expect("set_filter must not block behind stalled remote close")
    .unwrap();
    assert_eq!(filter_snap["filter"]["kind"], "single_computer");
    assert_eq!(filter_snap["filter"]["root_id"], live_b.pairing.root_id);

    // Unstall reads and verify remove_host finishes cleanly.
    stall_reads.store(false, Ordering::SeqCst);
    if let Some(waker) = waker_slot.lock().unwrap().take() {
        waker.wake();
    }
    remove_task.await.unwrap().unwrap();

    live_a.shutdown().await;
    live_b.shutdown().await;
}

#[test]
fn ios_shell_drives_live_agent_host_with_real_agent_contract_schemas() {
    use maka_agent_api::contract::{
        ContentKind, DataSource, Delivery, DeliveryFact, DeliveryPage, Directories, Directory,
        DirectoryPage, GitWorkspaceDiffRead, History, HistoryChunk, HistoryOrder, HistoryPage,
        HistoryRowAddress, InteractionKind, InteractionRead, InteractionRespond, InteractionResult,
        InteractionSummary, List, Observation, PendingInteractions, PreviewField, PreviewPage,
        PreviewPart, Project, ProjectRef, ProjectsPage, ProjectsRead, Queue, QueueEntry, QueueKind,
        Run, RunBackend, RunState, ScheduleRead, ScheduledSummary, Schedules, Send as AgentSend,
        SendResult, Session, SessionActivity, SessionKind, SessionPage, SessionRead, Watch,
        Workspace, WorkspaceAccess, WorkspacePermissions,
    };
    use maka_agent_facts::{
        durable::{
            AuthorizationObligation, ExecutionIdentity, FactId, ModelAttemptId, RunId, StepId,
            ToolKey,
        },
        interaction::{
            InteractionAnswer, InteractionQuestion, InteractionRecord, InteractionRequest,
            PermissionCommand, PermissionDecision, PermissionRequest, PermissionScope,
            PermissionSource, QuestionOption, SystemPermissionGrant,
        },
    };
    use maka_agent_ports::session::history::{HistoryField, Role};
    use maka_fs_tools::git::GitWorkspaceDiff;
    use maka_host_runtime::application::{
        Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation,
        NativeRegistry,
    };
    use maka_plugin_core::runtime::Published;
    use maka_sandbox::{
        grant::Permissions,
        workspace::{BindingStamp, PermissionBasis},
    };
    use maka_scheduler::task::Status as ScheduleStatus;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    let requested_permissions: Permissions = serde_json::from_value(json!({
        "filesystem": [{
            "path": "/Users/dev/maka-agent",
            "scope": "subtree",
            "access": "write"
        }],
        "network": "allowed"
    }))
    .unwrap();
    let recorded_answers: Arc<std::sync::Mutex<Vec<(String, InteractionAnswer)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded_sends: Arc<std::sync::Mutex<Vec<(String, String)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let watch_cancelled = Arc::new(AtomicBool::new(false));
    let watch_cancel_notify = Arc::new(Notify::new());
    let perm_resolved = Arc::new(AtomicBool::new(false));
    let question_resolved = Arc::new(AtomicBool::new(false));

    let project_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
    let deployment_id = Uuid::new_v4();
    let binding_id = Uuid::new_v4();
    let active_run = RunId::new();
    let step_id = StepId::new();
    let attempt_id = ModelAttemptId::new();
    let fact_id_u = FactId::new();
    let fact_id_th = FactId::new();
    let fact_id_a = FactId::new();

    struct ContractAgentService {
        root_id: String,
        deployment_id: Uuid,
        project_id: Uuid,
        binding_id: Uuid,
        active_run: RunId,
        step_id: StepId,
        attempt_id: ModelAttemptId,
        fact_ids: [FactId; 3],
        requested_permissions: Permissions,
        answers: Arc<std::sync::Mutex<Vec<(String, InteractionAnswer)>>>,
        sends: Arc<std::sync::Mutex<Vec<(String, String)>>>,
        watch_cancelled: Arc<AtomicBool>,
        watch_cancel_notify: Arc<Notify>,
        perm_resolved: Arc<AtomicBool>,
        question_resolved: Arc<AtomicBool>,
    }

    impl ContractAgentService {
        fn sample_session(&self) -> Session {
            Session {
                incognito: false,
                kind: SessionKind::Agent,
                applied_preset: None,
                parent_session_id: None,
                branch: None,
                backend: None,
                tools: None,
                data_source: Box::new(DataSource {
                    state_domain: self.root_id.clone(),
                    deployment: self.deployment_id,
                    namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
                }),
                permissions: WorkspacePermissions {
                    access: WorkspaceAccess::WorkspaceWrite,
                    request_permissions: true,
                },
                boundary_revision: 1,
                binding: BindingStamp {
                    id: self.binding_id,
                    permission_epoch: 1,
                },
                id: "sess-quic-01".into(),
                title: "修复 QUIC 握手超时".into(),
                labels: vec!["p2p".into()],
                workspace: Workspace {
                    worktree: None,
                    project_id: Some(self.project_id),
                    path: "/Users/dev/maka-agent".into(),
                },
                revision: 3,
                updated_at: 1_795_300_000_000,
                archived: false,
                pinned: false,
                has_unread: false,
                tail_message_id: Some("h-a1".into()),
                activity: SessionActivity::Waiting,
            }
        }

        fn execution(&self) -> ExecutionIdentity {
            ExecutionIdentity {
                session_id: "sess-quic-01".into(),
                turn_id: "t-1".into(),
                run_id: self.active_run,
            }
        }

        fn basis(&self) -> PermissionBasis {
            PermissionBasis {
                boundary_revision: 1,
                binding: BindingStamp {
                    id: self.binding_id,
                    permission_epoch: 1,
                },
            }
        }
    }

    impl Handler for ContractAgentService {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
        {
            let session = self.sample_session();
            let execution = self.execution();
            let basis = self.basis();
            let project_id = self.project_id;
            let active_run = self.active_run;
            let step_id = self.step_id;
            let attempt_id = self.attempt_id;
            let fact_ids = self.fact_ids;
            let requested_permissions = self.requested_permissions.clone();
            let answers = self.answers.clone();
            let sends = self.sends.clone();
            let watch_cancelled = self.watch_cancelled.clone();
            let watch_cancel_notify = self.watch_cancel_notify.clone();
            let perm_resolved = self.perm_resolved.clone();
            let question_resolved = self.question_resolved.clone();

            Box::pin(async move {
                fn to_val<T: serde::Serialize>(v: &T) -> Result<HandlerValue, HandlerError> {
                    serde_json::to_value(v)
                        .map(HandlerValue::Json)
                        .map_err(|e| HandlerError::from(e.to_string()))
                }

                match method.as_str() {
                    "projects" => {
                        let _req: ProjectsRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let rev = "a".repeat(64);
                        let page = ProjectsPage::Projects {
                            revision: rev.clone(),
                            projects: vec![Project {
                                reference: ProjectRef {
                                    id: project_id,
                                    revision: rev,
                                },
                                name: "maka-agent".into(),
                                archived: false,
                                available: true,
                                path: Some("/Users/dev/maka-agent".into()),
                            }],
                            next: None,
                        };
                        to_val(&page)
                    }
                    "directories" => {
                        let _req: Directories = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&DirectoryPage::Roots {
                            roots: vec![Directory {
                                name: "maka-agent".into(),
                                path: "/Users/dev/maka-agent".into(),
                            }],
                        })
                    }
                    "list" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&SessionPage {
                            revision: "rev-1".into(),
                            needs_you_count: 3,
                            sessions: vec![session],
                            before: None,
                            after: None,
                        })
                    }
                    "catalog" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let page = serde_json::to_value(&SessionPage {
                            revision: "rev-1".into(),
                            needs_you_count: 3,
                            sessions: vec![session],
                            before: None,
                            after: None,
                        })
                        .unwrap();
                        context
                            .emit(page)
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "observe" => {
                        let _req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        // Returns real AgentObservation.run (NOT fake activeRunId!)
                        to_val(&Observation {
                            session,
                            last_completed_turn_id: Some("t-0".into()),
                            compacting: None,
                            remembered_backend: None,
                            metrics: None,
                            latest_run_id: Some(active_run),
                            through: 10,
                            run: Some(Run {
                                backend: RunBackend::Model,
                                run_id: active_run,
                                turn_id: "t-1".into(),
                                state: RunState::WaitingForUser,
                            }),
                            parts: vec![],
                            tool_seeds: vec![],
                        })
                    }
                    "history" => {
                        let _req: History = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let mk_chunk =
                            |seq: u64,
                             fact: FactId,
                             role: Role,
                             field: HistoryField,
                             id: &str,
                             text: &str| HistoryChunk {
                                imported_turn: None,
                                run_id: Some(active_run),
                                model_part: None,
                                source_citation: false,
                                citation: None,
                                citation_anchor: None,
                                has_references: false,
                                quotes: vec![],
                                final_output: false,
                                reply_info: None,
                                final_answer: false,
                                model: None,
                                origin: None,
                                compaction: None,
                                attachments: vec![],
                                timing: None,
                                folded_work: None,
                                work: None,
                                field,
                                message_id: Some(id.into()),
                                turn_id: Some("t-1".into()),
                                timestamp: Some(1_795_300_000_000 + seq),
                                role,
                                order: HistoryOrder {
                                    path: vec![seq],
                                    item_index: 0,
                                },
                                position: HistoryRowAddress::Live {
                                    sequence: seq,
                                    fact,
                                    item_index: 0,
                                },
                                offset: 0,
                                total_bytes: text.len() as u64,
                                text: text.into(),
                                tool: None,
                            };
                        to_val(&HistoryPage::Ready {
                            through: Some(10),
                            chunks: vec![
                                mk_chunk(
                                    1,
                                    fact_ids[0],
                                    Role::User,
                                    HistoryField::Body,
                                    "h-u1",
                                    "排查一下 RPK 证书校验为什么偶发失败",
                                ),
                                mk_chunk(
                                    2,
                                    fact_ids[1],
                                    Role::Assistant,
                                    HistoryField::Thinking,
                                    "h-th1",
                                    "先检查 SPKI 头部前缀和 Ed25519 公钥长度",
                                ),
                                mk_chunk(
                                    3,
                                    fact_ids[2],
                                    Role::Assistant,
                                    HistoryField::Body,
                                    "h-a1",
                                    "已定位到 SPKI 校验分支，请确认下一步方案。",
                                ),
                            ],
                            before: None,
                            after: None,
                        })
                    }
                    "watch" => {
                        let req: Watch = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        assert_eq!(req.session_id, "sess-quic-01");
                        assert_eq!(req.after, 10, "watch must resume from Observation.through");

                        // 1. Real DeliveryPage::Events with Delivery + DeliveryFact::Delta
                        let events_page = serde_json::to_value(&DeliveryPage::Events {
                            through: 11,
                            next_after: 11,
                            events: vec![Delivery {
                                sequence: 11,
                                run_id: active_run,
                                turn_id: "t-1".into(),
                                fact: DeliveryFact::Delta {
                                    step_id,
                                    attempt_id,
                                    part_id: "p-1".into(),
                                    text: "真实 DeliveryPage 增量：".into(),
                                },
                            }],
                        })
                        .unwrap();
                        context
                            .emit(events_page)
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;

                        // 2. Real incremental multi-chunk DeliveryPage::Preview (thinking + body UTF-8 byte offsets)
                        let think_a = "正在推演 ";
                        let think_b = "RPK 链路";
                        let think_total = (think_a.len() + think_b.len()) as u64;
                        let body_a = "实时流式预览：";
                        let body_b = "远端 QUIC 握手校验已就绪。";
                        let body_total = (body_a.len() + body_b.len()) as u64;

                        let emit_cut = |rev: u64,
                                        ordinal: u64,
                                        msg_id: &str,
                                        text_kind: ContentKind,
                                        offset: u64,
                                        total_bytes: u64,
                                        text: &str| {
                            serde_json::to_value(&DeliveryPage::Preview {
                                page: PreviewPage::Cut {
                                    host_epoch: "epoch-1".into(),
                                    run_id: active_run,
                                    turn_id: "t-1".into(),
                                    step_id,
                                    attempt_id,
                                    revision: rev,
                                    depends_on: 0,
                                    first: true,
                                    last: true,
                                    parts: vec![PreviewPart {
                                        ordinal: Some(ordinal),
                                        message_id: msg_id.into(),
                                        provider_part_id: Some("p-1".into()),
                                        started_at: 1_795_300_000_000.0,
                                        field: PreviewField::Text {
                                            text_kind,
                                            final_answer: false,
                                        },
                                        offset,
                                        total_bytes,
                                        text: text.into(),
                                    }],
                                },
                            })
                            .unwrap()
                        };

                        context
                            .emit(emit_cut(
                                1,
                                0,
                                "m-think-1",
                                ContentKind::Thinking,
                                0,
                                think_total,
                                think_a,
                            ))
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        // Mid-stream transcript_changed (e.g. user prompt committed) must NOT wipe active preview.
                        context
                            .emit(
                                serde_json::to_value(&DeliveryPage::Events {
                                    through: 12,
                                    next_after: 12,
                                    events: vec![Delivery {
                                        sequence: 12,
                                        run_id: active_run,
                                        turn_id: "t-1".into(),
                                        fact: DeliveryFact::TranscriptChanged,
                                    }],
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context
                            .emit(emit_cut(
                                2,
                                0,
                                "m-think-1",
                                ContentKind::Thinking,
                                think_a.len() as u64,
                                think_total,
                                think_b,
                            ))
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context
                            .emit(emit_cut(
                                3,
                                1,
                                "m-preview-1",
                                ContentKind::Text,
                                0,
                                body_total,
                                body_a,
                            ))
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context
                            .emit(emit_cut(
                                4,
                                1,
                                "m-preview-1",
                                ContentKind::Text,
                                body_a.len() as u64,
                                body_total,
                                body_b,
                            ))
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;

                        // 3. Real DeliveryPage::Queue
                        let queue_page = serde_json::to_value(&DeliveryPage::Queue {
                            queue: Queue {
                                revision: 2,
                                entries: vec![QueueEntry {
                                    origin: None,
                                    message_id: "q-1".into(),
                                    kind: QueueKind::Followup,
                                    preview: "顺手跑一下 clippy".into(),
                                }],
                            },
                        })
                        .unwrap();
                        context
                            .emit(queue_page)
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;

                        context.scope().cancellation.cancelled().await;
                        watch_cancelled.store(true, Ordering::SeqCst);
                        watch_cancel_notify.notify_waiters();
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "pendingInteractions" => {
                        let _req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let mut entries = Vec::new();
                        if !perm_resolved.load(Ordering::SeqCst) {
                            entries.push(InteractionSummary {
                                request_id: "req-perm-1".into(),
                                kind: InteractionKind::Permissions,
                                tool_use_id: Some("tu-1".into()),
                            });
                        }
                        if !question_resolved.load(Ordering::SeqCst) {
                            entries.push(InteractionSummary {
                                request_id: "req-q-multi".into(),
                                kind: InteractionKind::Question,
                                tool_use_id: Some("tu-2".into()),
                            });
                        }
                        entries.push(InteractionSummary {
                            request_id: "req-sys-1".into(),
                            kind: InteractionKind::SystemPermission,
                            tool_use_id: Some("tu-3".into()),
                        });
                        to_val(&PendingInteractions {
                            revision: 1,
                            entries,
                        })
                    }
                    "interaction" => {
                        let req: InteractionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let record: Option<InteractionRecord> = match req.request_id.as_str() {
                            "req-perm-1" => Some(InteractionRecord {
                                execution,
                                request_id: "req-perm-1".into(),
                                created_at: 1_795_300_000_000,
                                request: InteractionRequest::Permissions {
                                    target: AuthorizationObligation::Tool {
                                        tool: ToolKey {
                                            attempt: attempt_id,
                                            call: "tu-1".into(),
                                        },
                                    },
                                    tool_use_id: Some("tu-1".into()),
                                    basis,
                                    request: PermissionRequest {
                                        reason: "运行 QUIC 握手回归测试".into(),
                                        command: Some(PermissionCommand {
                                            command: "cargo test -p maka-peer-mesh --locked".into(),
                                            cwd: "/Users/dev/maka-agent".into(),
                                        }),
                                        permissions: requested_permissions,
                                        source: PermissionSource::Processes,
                                    },
                                },
                                outcome: None,
                            }),
                            "req-q-multi" => Some(InteractionRecord {
                                execution,
                                request_id: "req-q-multi".into(),
                                created_at: 1_795_300_000_100,
                                request: InteractionRequest::Question {
                                    tool_use_id: "tu-2".into(),
                                    questions: vec![
                                        InteractionQuestion {
                                            question: "第一题：先处理哪条链路？".into(),
                                            options: vec![
                                                QuestionOption {
                                                    label: "仅修 RPK 解析".into(),
                                                    description: Some("改动范围最小".into()),
                                                },
                                                QuestionOption {
                                                    label: "同步加固中继握手".into(),
                                                    description: Some("一起补 E2E 回归测试".into()),
                                                },
                                            ],
                                        },
                                        InteractionQuestion {
                                            question: "第二题：验证优先级如何安排？".into(),
                                            options: vec![
                                                QuestionOption {
                                                    label: "仅本地验证".into(),
                                                    description: None,
                                                },
                                                QuestionOption {
                                                    label: "双机真机实测".into(),
                                                    description: None,
                                                },
                                            ],
                                        },
                                    ],
                                },
                                outcome: None,
                            }),
                            "req-sys-1" => Some(InteractionRecord {
                                execution,
                                request_id: "req-sys-1".into(),
                                created_at: 1_795_300_000_200,
                                request: InteractionRequest::SystemPermission {
                                    tool_use_id: "tu-3".into(),
                                    grants: vec![SystemPermissionGrant::ScreenRecording],
                                    application: "Maka Host".into(),
                                    application_location: None,
                                },
                                outcome: None,
                            }),
                            _ => None,
                        };
                        to_val(&record)
                    }
                    "respond" => {
                        let req: InteractionRespond = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        if req.request_id == "req-perm-1" {
                            if let InteractionAnswer::Permissions { ref decision } = req.answer {
                                decision
                                    .validate_for(&requested_permissions)
                                    .map_err(|e| HandlerError::from(e.to_string()))?;
                            } else {
                                return Err(HandlerError::from("expected Permissions answer"));
                            }
                            perm_resolved.store(true, Ordering::SeqCst);
                        } else if req.request_id == "req-q-multi" {
                            if let InteractionAnswer::Question { ref answers } = req.answer {
                                if answers.len() != 2 {
                                    return Err(HandlerError::from(
                                        "expected 2 answers for 2-question interaction",
                                    ));
                                }
                            } else {
                                return Err(HandlerError::from("expected Question answer"));
                            }
                            question_resolved.store(true, Ordering::SeqCst);
                        }
                        let req_id = req.request_id.clone();
                        let outcome = req.answer.clone().into_outcome(1_795_300_005_000);
                        answers.lock().unwrap().push((req_id.clone(), req.answer));
                        to_val(&InteractionResult::Recorded {
                            record: Box::new(InteractionRecord {
                                execution,
                                request_id: req_id,
                                created_at: 1_795_300_000_000,
                                request: InteractionRequest::Question {
                                    tool_use_id: "tu-ack".into(),
                                    questions: vec![InteractionQuestion {
                                        question: "ack".into(),
                                        options: vec![
                                            QuestionOption {
                                                label: "a".into(),
                                                description: None,
                                            },
                                            QuestionOption {
                                                label: "b".into(),
                                                description: None,
                                            },
                                        ],
                                    }],
                                },
                                outcome: Some(outcome),
                            }),
                        })
                    }
                    "send" => {
                        let req: AgentSend = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        sends
                            .lock()
                            .unwrap()
                            .push((req.session_id.clone(), req.message.clone()));
                        to_val(&SendResult::Started {
                            session_id: req.session_id,
                            run_id: active_run,
                            message_id: "msg-live-1".into(),
                            completion: None,
                        })
                    }
                    "gitWorkspaceDiff" => {
                        let _req: GitWorkspaceDiffRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&Some(GitWorkspaceDiff {
                            patch: "diff --git a/platform/peer-mesh/src/transport.rs b/platform/peer-mesh/src/transport.rs\n--- a/platform/peer-mesh/src/transport.rs\n+++ b/platform/peer-mesh/src/transport.rs\n@@ -41,2 +41,3 @@\n-    allow_any_peer();\n+    verify_rpk_ed25519_peer_id(expected_peer)?;\n+    require_tls13_only();".into(),
                            truncated: true,
                            skipped_files: 2,
                        }))
                    }
                    "schedules" => {
                        let _req: ScheduleRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&Schedules::Page {
                            revision: 4,
                            tasks: vec![ScheduledSummary {
                                id: "sched-daily-check".into(),
                                revision: 1,
                                title: "每日 QUIC 连通性巡检".into(),
                                session_id: "sess-quic-01".into(),
                                script: false,
                                approved: true,
                                status: ScheduleStatus::Active,
                                background_followup: false,
                                next_fire_at: Some(1_795_400_000_000),
                                pending_fire: None,
                                last_error: None,
                            }],
                            next_cursor: None,
                        })
                    }
                    other => Err(HandlerError::from(format!(
                        "unsupported test method {other}"
                    ))),
                }
            })
        }
    }

    let (dir, ws_addr, pairing, stop, server) = rt.block_on(async {
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
        let root_id_for_service = root.root_id().to_owned();
        let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
        // Mount the REAL maka_agent_api::contract() so Host enforces full JSON Schema validation!
        let agent_contract = maka_agent_api::contract();
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
        let agent_pkg = pkg(
            "test.agent",
            json!({
                "implementation": { "kind": "native", "implementation": "test.contract.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": agent_contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway",
            json!({
                "implementation": { "kind": "native", "implementation": GATEWAY },
                "configuration": { "type": "object" },
                "exports": {},
                "imports": { "agent": { "contract": agent_contract, "cardinality": { "kind": "one" } } }
            }),
        );
        let consumer = Uuid::new_v4();
        store
            .commit_application(
                deployment_id,
                0,
                serde_json::from_value(json!({
                    "instances": {
                        "agent": {
                            "key": Uuid::new_v4(),
                            "package": { "source": "pinned", "package": agent_pkg.application_ref() },
                            "usePackage": "host"
                        },
                        "gateway": {
                            "key": consumer,
                            "package": { "source": "pinned", "package": gateway_pkg.application_ref() },
                            "usePackage": "host",
                            "bindings": {
                                "agent": [{ "kind": "instance", "path": ["agent"], "export": "Agent" }]
                            }
                        }
                    }
                }))
                .unwrap(),
                vec![],
                vec![agent_pkg, gateway_pkg],
            )
            .await
            .unwrap();

        let mut native = NativeRegistry::default();
        let contract_clone = agent_contract.clone();
        let answers_clone = recorded_answers.clone();
        let sends_clone = recorded_sends.clone();
        let wc_clone = watch_cancelled.clone();
        let wcn_clone = watch_cancel_notify.clone();
        let perm_clone = perm_resolved.clone();
        let q_clone = question_resolved.clone();
        let req_perms_clone = requested_permissions.clone();
        native
            .insert(
                "test.contract.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = contract_clone.clone();
                    let root_id = root_id_for_service.clone();
                    let answers = answers_clone.clone();
                    let sends = sends_clone.clone();
                    let watch_cancelled = wc_clone.clone();
                    let watch_cancel_notify = wcn_clone.clone();
                    let perm_resolved = perm_clone.clone();
                    let question_resolved = q_clone.clone();
                    let requested_permissions = req_perms_clone.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(ContractAgentService {
                                        root_id,
                                        deployment_id,
                                        project_id,
                                        binding_id,
                                        active_run,
                                        step_id,
                                        attempt_id,
                                        fact_ids: [fact_id_u, fact_id_th, fact_id_a],
                                        requested_permissions,
                                        answers,
                                        sends,
                                        watch_cancelled,
                                        watch_cancel_notify,
                                        perm_resolved,
                                        question_resolved,
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
                "agent": {
                    "consumer": [consumer],
                    "import": "agent",
                    "grant": {
                        "methods": [
                            "projects", "directories", "list", "catalog", "observe", "history",
                            "watch", "pendingInteractions", "interaction", "respond", "send",
                            "gitWorkspaceDiff", "schedules"
                        ],
                        "recovery": false
                    }
                }
            }))
            .unwrap(),
            native: Default::default(),
            product_methods: Default::default(),
        };
        let host = Host::open_with_options(
            store,
            deployment_id,
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
        let pairing = host.prepare_access("ios-agent-e2e".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-ios-agent-{}", Uuid::new_v4()));
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
        (dir, ws_addr, pairing, stop, server)
    });

    let uri = PairingTicketV1::new(
        pairing.root_id.clone(),
        "Studio Agent Host",
        "peer_9999999999999999999999999999999999999999999999999999999999999999",
        vec![format!("ws://{ws_addr}")],
        pairing.credential.clone(),
        "nonce-agent-e2e-01",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let bridge =
        HostBridge::attach(channel.clone(), support_dir.path(), rt.handle().clone()).unwrap();
    bridge.queue_pairing_uri(uri);

    let mut cfg = engine_config(channel.clone(), rt.handle().clone());
    cfg.viewport = Size::new(px(390.0), px(844.0));
    cfg.environment = Environment {
        os: Os::Ios,
        ..Environment::default()
    };
    let mut app = nsh_testing::Headless::start(cfg).unwrap();

    // 1. Cold-start SAS pairing
    app.wait_for("text:核对桌面端 Studio Agent Host 上的 6 位数字")
        .unwrap();
    app.press("label:Confirm pairing and connect").unwrap();

    // 2. 78% Drawer shows real Project & Session from real SessionPage
    app.wait_for("label:Open drawer").unwrap();
    app.press("label:Open drawer").unwrap();
    app.wait_for("text:maka-agent").unwrap();
    app.wait_for("label:Session 修复 QUIC 握手超时").unwrap();

    // 3. Select session -> verifies real AgentObservation.run.runId (Stop button visible immediately!),
    //    real HistoryPage::Ready, real DeliveryPage::Events + PreviewPage::Cut + Queue,
    //    real Permissions request, 2-question AskUserQuestion, AND unsupported SystemPermission notice!
    app.press("label:Session 修复 QUIC 握手超时").unwrap();
    app.wait_for("label:Stop active run").unwrap();
    app.wait_for("text:/已定位到 SPKI 校验分支/").unwrap();
    app.wait_for("text:/正在推演 RPK 链路/").unwrap();
    app.wait_for("text:/实时流式预览：远端 QUIC 握手校验已就绪/")
        .unwrap();
    app.wait_for("text:/已排队 1 条消息: 顺手跑一下 clippy/")
        .unwrap();
    app.wait_for("text:cargo test -p maka-peer-mesh --locked")
        .unwrap();
    app.wait_for("text:第一题：先处理哪条链路？").unwrap();
    app.wait_for("text:第二题：验证优先级如何安排？").unwrap();
    app.wait_for("text:/system_permission.*桌面端/").unwrap();

    // 4. Approve real Permission with Session scope -> Host validates original permissions & scope!
    app.press("label:Allow session").unwrap();
    app.wait_for("text:/已本会话允许 · cargo test/").unwrap();

    // 5. Answer 2-question AskUserQuestion: preset on Q1 + CUSTOM free-text on Q2!
    app.press("label:Question option 同步加固中继握手").unwrap();
    app.press("label:Question custom option 2").unwrap();
    app.type_text(
        "label:Custom question answer input 2",
        "保留直连优先并补测试",
    )
    .unwrap();
    app.press("label:Submit question answer").unwrap();
    app.wait_for("text:/已回答 · 同步加固中继握手 .*保留直连优先并补测试/")
        .unwrap();

    {
        let answers = recorded_answers.lock().unwrap();
        assert_eq!(answers.len(), 2);
        assert_eq!(answers[0].0, "req-perm-1");
        assert_eq!(
            answers[0].1,
            InteractionAnswer::Permissions {
                decision: PermissionDecision::Allow {
                    permissions: requested_permissions.clone(),
                    scope: PermissionScope::Session,
                }
            }
        );
        assert_eq!(answers[1].0, "req-q-multi");
        assert_eq!(
            answers[1].1,
            InteractionAnswer::Question {
                answers: vec![
                    Some("同步加固中继握手".into()),
                    Some("保留直连优先并补测试".into()),
                ],
            }
        );
    }

    // 6. Send real Steer message -> Host deserializes real AgentSend!
    app.type_text("label:Chat composer input", "按刚才的方案直接改")
        .unwrap();
    app.press("label:Send message").unwrap();
    {
        let sends = recorded_sends.lock().unwrap();
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].0, "sess-quic-01");
        assert_eq!(sends[0].1, "按刚才的方案直接改");
    }

    // 7. Real GitWorkspaceDiff { patch, truncated: true, skippedFiles: 2 }!
    app.press("label:Open diff viewer").unwrap();
    app.wait_for("text:/verify_rpk_ed25519_peer_id/").unwrap();
    app.wait_for("text:/Diff 已截断 · 跳过 2 个文件/").unwrap();
    app.press("label:Back from diff").unwrap();

    // 8. Real Schedules::Page with ScheduledSummary { status: Active } renders "运行中"!
    app.press("label:Open drawer").unwrap();
    app.press("label:Automations").unwrap();
    app.wait_for("text:每日 QUIC 连通性巡检").unwrap();
    app.wait_for("text:运行中").unwrap();
    app.press("label:Back from automations").unwrap();

    // 9. Disconnect Host -> Host watch subscription cancels promptly!
    app.press("label:Open drawer").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Disconnect active host").unwrap();

    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !watch_cancelled.load(Ordering::SeqCst) {
                watch_cancel_notify.notified().await;
            }
        })
        .await
        .expect("Host watch subscription must cancel promptly on Host disconnect");
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    });
    drop(dir);
}

#[test]
fn native_ios_url_scheme_launch_opens_sas_pairing_screen() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let live = rt.block_on(LiveTestHost::start());
    let uri = make_ticket_uri(
        &live,
        "URL Scheme Mac",
        "peer_7777777777777777777777777777777777777777777777777777777777777777",
    );

    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let _bridge =
        HostBridge::attach(channel.clone(), support_dir.path(), rt.handle().clone()).unwrap();

    let mut cfg = engine_config(channel, rt.handle().clone());
    cfg.viewport = Size::new(px(390.0), px(844.0));
    cfg.environment = Environment {
        os: Os::Ios,
        ..Environment::default()
    };
    let mut app = nsh_testing::Headless::start_with_link(cfg, &uri).unwrap();
    app.wait_for("text:核对桌面端 URL Scheme Mac 上的 6 位数字")
        .unwrap();
    app.wait_for("label:Confirm pairing and connect").unwrap();

    rt.block_on(live.shutdown());
}

#[test]
fn subscription_replacement_generation_fencing_and_stale_host_rpc_isolation() {
    use maka_agent_api::contract::{
        DataSource, DirectoryPage, List, ProjectsPage, Session, SessionActivity, SessionKind,
        SessionPage, Workspace, WorkspaceAccess, WorkspacePermissions,
    };
    use maka_host_runtime::application::{
        Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation,
        NativeRegistry,
    };
    use maka_plugin_core::runtime::Published;
    use maka_sandbox::workspace::BindingStamp;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    struct GatedAgentHost {
        _dir: tempfile::TempDir,
        ws_addr: SocketAddr,
        pairing: Pairing,
        stop: CancellationToken,
        server: JoinHandle<Result<(), String>>,
        catalog_fail: Arc<AtomicBool>,
        list_gate: Option<Arc<Notify>>,
        list_entered: Option<Arc<Notify>>,
        list_entered_flag: Arc<AtomicBool>,
        old_catalog_cancelled: Arc<AtomicBool>,
    }

    async fn start_agent_host(
        session_title: &'static str,
        delay_list: bool,
        fail_catalog: bool,
    ) -> GatedAgentHost {
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
        let root_id = root.root_id().to_owned();
        let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
        let contract = maka_agent_api::contract();
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
        let agent_pkg = pkg(
            "test.agent",
            json!({
                "implementation": { "kind": "native", "implementation": "test.gated.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway",
            json!({
                "implementation": { "kind": "native", "implementation": GATEWAY },
                "configuration": { "type": "object" },
                "exports": {},
                "imports": { "agent": { "contract": contract, "cardinality": { "kind": "one" } } }
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
                        "agent": {
                            "key": Uuid::new_v4(),
                            "package": { "source": "pinned", "package": agent_pkg.application_ref() },
                            "usePackage": "host"
                        },
                        "gateway": {
                            "key": consumer,
                            "package": { "source": "pinned", "package": gateway_pkg.application_ref() },
                            "usePackage": "host",
                            "bindings": {
                                "agent": [{ "kind": "instance", "path": ["agent"], "export": "Agent" }]
                            }
                        }
                    }
                }))
                .unwrap(),
                vec![],
                vec![agent_pkg, gateway_pkg],
            )
            .await
            .unwrap();

        let catalog_fail = Arc::new(AtomicBool::new(fail_catalog));
        let list_gate = delay_list.then(|| Arc::new(Notify::new()));
        let list_entered = delay_list.then(|| Arc::new(Notify::new()));
        let list_entered_flag = Arc::new(AtomicBool::new(false));
        let old_catalog_cancelled = Arc::new(AtomicBool::new(false));
        let catalog_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        struct GatedHandler {
            root_id: String,
            deployment: Uuid,
            session_title: &'static str,
            catalog_fail: Arc<AtomicBool>,
            list_gate: Option<Arc<Notify>>,
            list_entered: Option<Arc<Notify>>,
            list_entered_flag: Arc<AtomicBool>,
            old_catalog_cancelled: Arc<AtomicBool>,
            catalog_opens: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl Handler for GatedHandler {
            fn call(
                &self,
                method: String,
                input: Value,
                context: Context,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
            {
                let root_id = self.root_id.clone();
                let deployment = self.deployment;
                let title = self.session_title;
                let catalog_fail = self.catalog_fail.clone();
                let list_gate = self.list_gate.clone();
                let list_entered = self.list_entered.clone();
                let list_entered_flag = self.list_entered_flag.clone();
                let old_catalog_cancelled = self.old_catalog_cancelled.clone();
                let catalog_opens = self.catalog_opens.clone();
                Box::pin(async move {
                    let make_page = || SessionPage {
                        revision: "rev-1".into(),
                        needs_you_count: 0,
                        sessions: vec![Session {
                            incognito: false,
                            kind: SessionKind::Agent,
                            applied_preset: None,
                            parent_session_id: None,
                            branch: None,
                            backend: None,
                            tools: None,
                            data_source: Box::new(DataSource {
                                state_domain: root_id.clone(),
                                deployment,
                                namespace: maka_plugin_core::composition::InstanceId(vec![
                                    Uuid::new_v4(),
                                ]),
                            }),
                            permissions: WorkspacePermissions {
                                access: WorkspaceAccess::WorkspaceWrite,
                                request_permissions: true,
                            },
                            boundary_revision: 1,
                            binding: BindingStamp {
                                id: Uuid::new_v4(),
                                permission_epoch: 1,
                            },
                            id: format!("sess-{title}"),
                            title: title.into(),
                            labels: vec![],
                            workspace: Workspace {
                                worktree: None,
                                project_id: None,
                                path: "/Users/dev/maka-agent".into(),
                            },
                            revision: 1,
                            updated_at: 1_795_300_000_000,
                            archived: false,
                            pinned: false,
                            has_unread: false,
                            tail_message_id: None,
                            activity: SessionActivity::Idle,
                        }],
                        before: None,
                        after: None,
                    };
                    match method.as_str() {
                        "projects" => Ok(HandlerValue::Json(
                            serde_json::to_value(ProjectsPage::Projects {
                                revision: "a".repeat(64),
                                projects: vec![],
                                next: None,
                            })
                            .unwrap(),
                        )),
                        "directories" => Ok(HandlerValue::Json(
                            serde_json::to_value(DirectoryPage::Roots { roots: vec![] }).unwrap(),
                        )),
                        "list" => {
                            let _req: List = serde_json::from_value(input)
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                            if let (Some(entered), Some(gate)) = (list_entered, list_gate) {
                                list_entered_flag.store(true, Ordering::SeqCst);
                                entered.notify_waiters();
                                gate.notified().await;
                            }
                            Ok(HandlerValue::Json(
                                serde_json::to_value(make_page()).unwrap(),
                            ))
                        }
                        "catalog" => {
                            let _req: List = serde_json::from_value(input)
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                            if catalog_fail.load(Ordering::SeqCst) {
                                return Err(HandlerError::from("catalog-denied-for-test"));
                            }
                            let seq = catalog_opens.fetch_add(1, Ordering::SeqCst);
                            context
                                .emit(serde_json::to_value(make_page()).unwrap())
                                .await
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                            context.scope().cancellation.cancelled().await;
                            if seq == 0 {
                                old_catalog_cancelled.store(true, Ordering::SeqCst);
                            }
                            Ok(HandlerValue::Json(Value::Null))
                        }
                        other => Err(HandlerError::from(format!("unexpected {other}"))),
                    }
                })
            }
        }

        let mut native = NativeRegistry::default();
        let c_clone = contract.clone();
        let cf = catalog_fail.clone();
        let lg = list_gate.clone();
        let le = list_entered.clone();
        let lef = list_entered_flag.clone();
        let occ = old_catalog_cancelled.clone();
        let co = catalog_opens.clone();
        native
            .insert(
                "test.gated.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = c_clone.clone();
                    let root_id = root_id.clone();
                    let cf = cf.clone();
                    let lg = lg.clone();
                    let le = le.clone();
                    let lef = lef.clone();
                    let occ = occ.clone();
                    let co = co.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(GatedHandler {
                                        root_id,
                                        deployment,
                                        session_title,
                                        catalog_fail: cf,
                                        list_gate: lg,
                                        list_entered: le,
                                        list_entered_flag: lef,
                                        old_catalog_cancelled: occ,
                                        catalog_opens: co,
                                    })
                                        as Arc<dyn Handler>,
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
                "agent": {
                    "consumer": [consumer],
                    "import": "agent",
                    "grant": {
                        "methods": ["projects", "directories", "list", "catalog"],
                        "recovery": false
                    }
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
        let pairing = host.prepare_access("ios-race-test".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-ios-race-{}", Uuid::new_v4()));
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
        GatedAgentHost {
            _dir: dir,
            ws_addr,
            pairing,
            stop,
            server,
            catalog_fail,
            list_gate,
            list_entered,
            list_entered_flag,
            old_catalog_cancelled,
        }
    }

    let (host_a, host_b) = rt.block_on(async {
        let a = start_agent_host("HostA过期会话", true, true).await;
        let b = start_agent_host("HostB最新会话", false, false).await;
        (a, b)
    });

    let uri_a = PairingTicketV1::new(
        host_a.pairing.root_id.clone(),
        "Host A Slow",
        "peer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vec![format!("ws://{}", host_a.ws_addr)],
        host_a.pairing.credential.clone(),
        "nonce-race-a",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();
    let uri_b = PairingTicketV1::new(
        host_b.pairing.root_id.clone(),
        "Host B Fast",
        "peer_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        vec![format!("ws://{}", host_b.ws_addr)],
        host_b.pairing.credential.clone(),
        "nonce-race-b",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let bridge =
        HostBridge::attach(channel.clone(), support_dir.path(), rt.handle().clone()).unwrap();

    // Part A (Bridge level): Replacing same subscriptionId on Host B increments generation
    // and cancels old stream cleanly without clobbering the new generation.
    rt.block_on(async {
        bridge
            .pair_host(json!({ "uri": uri_b.clone() }))
            .await
            .unwrap();
        let list_input = json!({
            "kind": null,
            "filter": "all",
            "includeArchived": false,
            "rootsOnly": false,
            "position": { "kind": "start" },
            "scope": { "kind": "all" },
            "titleQuery": ""
        });
        let sub1 = bridge
            .subscribe(json!({
                "subscriptionId": "dup-sub",
                "endpoint": "agent",
                "method": "catalog",
                "input": list_input.clone()
            }))
            .await
            .unwrap();
        let sub2 = bridge
            .subscribe(json!({
                "subscriptionId": "dup-sub",
                "endpoint": "agent",
                "method": "catalog",
                "input": list_input
            }))
            .await
            .unwrap();
        assert!(
            sub2["generation"].as_u64().unwrap() > sub1["generation"].as_u64().unwrap(),
            "replacing same subscriptionId must allocate a strictly newer generation"
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while !host_b.old_catalog_cancelled.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("old replaced subscription must cancel promptly on Host");
        bridge
            .unsubscribe(json!({ "subscriptionId": "dup-sub" }))
            .await
            .unwrap();
        bridge.disconnect_host().await.unwrap();
    });

    // Part B (Full Headless UI): Pair Host A (whose list() stalls AND catalog subscribe fails),
    // verify subscribe error banner surfaces explicitly, then switch to Host B while Host A's
    // list() is still in-flight, release Host A's delayed list(), and assert Host B's session
    // list is NEVER overwritten by Host A's stale response!
    let mut cfg = engine_config(channel.clone(), rt.handle().clone());
    cfg.viewport = Size::new(px(390.0), px(844.0));
    cfg.environment = Environment {
        os: Os::Ios,
        ..Environment::default()
    };
    let mut app = nsh_testing::Headless::start(cfg).unwrap();

    // Pair Host A via deep-link
    channel
        .send("ios.pairingUri", json!({ "uri": uri_a }))
        .unwrap();
    app.wait_for("label:Confirm pairing and connect").unwrap();
    app.press("label:Confirm pairing and connect").unwrap();

    // Host A's catalog subscribe returns error -> UI MUST surface explicit banner (never swallow!)
    app.wait_for("text:/会话目录.*catalog-denied-for-test/")
        .unwrap();

    // Ensure Host A's delayed list() RPC is genuinely in-flight on the server
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !host_a.list_entered_flag.load(Ordering::SeqCst) {
                host_a.list_entered.as_ref().unwrap().notified().await;
            }
        })
        .await
        .expect("Host A list RPC must be in-flight");
    });

    // Switch active Host to Host B while Host A's list() is still pending!
    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Host Host B Fast").unwrap();
    app.press("label:Host Host B Fast").unwrap();
    app.wait_for("label:Session HostB最新会话").unwrap();

    // Now release Host A's delayed list() response!
    host_a.list_gate.as_ref().unwrap().notify_waiters();
    app.wait(Duration::from_millis(250)).unwrap();

    // Host B's session MUST remain visible and Host A's stale session MUST NOT overwrite it!
    assert!(
        app.shows("HostB最新会话"),
        "Host B session must remain shown"
    );
    assert!(
        !app.shows("HostA过期会话"),
        "stale delayed Host A RPC response must not overwrite Host B sessions"
    );

    let _ = host_a.catalog_fail.load(Ordering::SeqCst);
    rt.block_on(async {
        host_a.stop.cancel();
        host_b.stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), host_a.server).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), host_b.server).await;
    });
}

#[test]
fn session_switch_fences_stale_send_and_renders_room_session_author() {
    use maka_agent_api::contract::{
        DataSource, Delivery, DeliveryFact, DeliveryPage, DirectoryPage, History, HistoryChunk,
        HistoryOrder, HistoryPage, HistoryRowAddress, List, Observation, PendingInteractions,
        ProjectsPage, RoomContent, RoomHistoryPage, RoomMessage, Send as AgentSend, SendResult,
        Session, SessionActivity, SessionKind, SessionPage, SessionRead, Watch, Workspace,
        WorkspaceAccess, WorkspacePermissions,
    };
    use maka_agent_facts::{
        durable::{ExecutionIdentity, FactId, ModelAttemptId, RunId, StepId},
        room::RoomAuthor,
    };
    use maka_agent_ports::session::history::{HistoryField, Role};
    use maka_host_runtime::application::{
        Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation,
        NativeRegistry,
    };
    use maka_plugin_core::runtime::Published;
    use maka_sandbox::workspace::BindingStamp;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    let send_a_entered = Arc::new(Notify::new());
    let send_a_entered_flag = Arc::new(AtomicBool::new(false));
    let send_a_gate = Arc::new(Notify::new());
    let room_run_id = RunId::new();
    let beta_run_id = RunId::new();
    let beta_step_id = StepId::new();
    let beta_attempt_id = ModelAttemptId::new();
    let beta_fact_id = FactId::new();

    struct MultiSessionService {
        root_id: String,
        deployment: Uuid,
        send_a_entered: Arc<Notify>,
        send_a_entered_flag: Arc<AtomicBool>,
        send_a_gate: Arc<Notify>,
        room_run_id: RunId,
        beta_run_id: RunId,
        beta_step_id: StepId,
        beta_attempt_id: ModelAttemptId,
        beta_fact_id: FactId,
    }

    impl MultiSessionService {
        fn sessions(&self) -> Vec<Session> {
            let mk = |id: &str, title: &str, kind: SessionKind| Session {
                incognito: false,
                kind,
                applied_preset: None,
                parent_session_id: None,
                branch: None,
                backend: None,
                tools: None,
                data_source: Box::new(DataSource {
                    state_domain: self.root_id.clone(),
                    deployment: self.deployment,
                    namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
                }),
                permissions: WorkspacePermissions {
                    access: WorkspaceAccess::WorkspaceWrite,
                    request_permissions: true,
                },
                boundary_revision: 1,
                binding: BindingStamp {
                    id: Uuid::new_v4(),
                    permission_epoch: 1,
                },
                id: id.into(),
                title: title.into(),
                labels: vec![],
                workspace: Workspace {
                    worktree: None,
                    project_id: None,
                    path: "/Users/dev/maka-agent".into(),
                },
                revision: 1,
                updated_at: 1_795_300_000_000,
                archived: false,
                pinned: false,
                has_unread: false,
                tail_message_id: None,
                activity: SessionActivity::Idle,
            };
            vec![
                mk("sess-alpha", "Session Alpha", SessionKind::Agent),
                mk("sess-beta", "Session Beta", SessionKind::Agent),
                mk("room-mesh", "Mesh 协作室", SessionKind::Room),
            ]
        }
    }

    impl Handler for MultiSessionService {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
        {
            let sessions = self.sessions();
            let send_a_entered = self.send_a_entered.clone();
            let send_a_entered_flag = self.send_a_entered_flag.clone();
            let send_a_gate = self.send_a_gate.clone();
            let room_run_id = self.room_run_id;
            let beta_run_id = self.beta_run_id;
            let beta_step_id = self.beta_step_id;
            let beta_attempt_id = self.beta_attempt_id;
            let beta_fact_id = self.beta_fact_id;

            Box::pin(async move {
                let page = SessionPage {
                    revision: "rev-multi".into(),
                    needs_you_count: 0,
                    sessions: sessions.clone(),
                    before: None,
                    after: None,
                };
                match method.as_str() {
                    "projects" => Ok(HandlerValue::Json(
                        serde_json::to_value(ProjectsPage::Projects {
                            revision: "b".repeat(64),
                            projects: vec![],
                            next: None,
                        })
                        .unwrap(),
                    )),
                    "directories" => Ok(HandlerValue::Json(
                        serde_json::to_value(DirectoryPage::Roots { roots: vec![] }).unwrap(),
                    )),
                    "list" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        Ok(HandlerValue::Json(serde_json::to_value(page).unwrap()))
                    }
                    "catalog" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context
                            .emit(serde_json::to_value(page).unwrap())
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "observe" => {
                        let req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let session = sessions
                            .iter()
                            .find(|s| s.id == req.session_id)
                            .cloned()
                            .ok_or_else(|| HandlerError::from("unknown session"))?;
                        Ok(HandlerValue::Json(
                            serde_json::to_value(Observation {
                                session,
                                last_completed_turn_id: None,
                                compacting: None,
                                remembered_backend: None,
                                metrics: None,
                                latest_run_id: None,
                                through: 5,
                                run: None,
                                parts: vec![],
                                tool_seeds: vec![],
                            })
                            .unwrap(),
                        ))
                    }
                    "history" => {
                        let req: History = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let hist = match req.session_id.as_str() {
                            "room-mesh" => HistoryPage::Room {
                                page: RoomHistoryPage {
                                    through: 2,
                                    before: None,
                                    after: None,
                                    participants: vec![],
                                    items: vec![
                                        RoomMessage {
                                            id: "rm-1".into(),
                                            sequence: 1,
                                            at: 1_795_300_000_001,
                                            author: RoomAuthor::Human,
                                            content: RoomContent {
                                                text: "请核对 QUIC 证书状态".into(),
                                                attachments: vec![],
                                            },
                                            reply_to: None,
                                            mentions: vec!["sess-alpha".into()],
                                            deliveries: vec![],
                                            edited_at: None,
                                            deleted_at: None,
                                            reactions: vec![],
                                            pinned: false,
                                            delivery_states: vec![],
                                        },
                                        RoomMessage {
                                            id: "rm-2".into(),
                                            sequence: 2,
                                            at: 1_795_300_000_002,
                                            author: RoomAuthor::Session {
                                                execution: ExecutionIdentity {
                                                    session_id: "sess-alpha".into(),
                                                    turn_id: "turn-room-1".into(),
                                                    run_id: room_run_id,
                                                },
                                            },
                                            content: RoomContent {
                                                text: "RPK 校验已全部通过".into(),
                                                attachments: vec![],
                                            },
                                            reply_to: Some("rm-1".into()),
                                            mentions: vec![],
                                            deliveries: vec![],
                                            edited_at: None,
                                            deleted_at: None,
                                            reactions: vec![],
                                            pinned: false,
                                            delivery_states: vec![],
                                        },
                                    ],
                                },
                            },
                            "sess-beta" => HistoryPage::Ready {
                                through: Some(5),
                                chunks: vec![HistoryChunk {
                                    imported_turn: None,
                                    run_id: Some(beta_run_id),
                                    model_part: None,
                                    source_citation: false,
                                    citation: None,
                                    citation_anchor: None,
                                    has_references: false,
                                    quotes: vec![],
                                    final_output: false,
                                    reply_info: None,
                                    final_answer: false,
                                    model: None,
                                    origin: None,
                                    compaction: None,
                                    attachments: vec![],
                                    timing: None,
                                    folded_work: None,
                                    work: None,
                                    field: HistoryField::Body,
                                    message_id: Some("b-1".into()),
                                    turn_id: Some("t-b".into()),
                                    timestamp: Some(1_795_300_000_005),
                                    role: Role::Assistant,
                                    order: HistoryOrder {
                                        path: vec![1],
                                        item_index: 0,
                                    },
                                    position: HistoryRowAddress::Live {
                                        sequence: 1,
                                        fact: beta_fact_id,
                                        item_index: 0,
                                    },
                                    offset: 0,
                                    total_bytes: 18,
                                    text: "Beta 历史记录".into(),
                                    tool: None,
                                }],
                                before: None,
                                after: None,
                            },
                            _ => HistoryPage::Ready {
                                through: Some(5),
                                chunks: vec![],
                                before: None,
                                after: None,
                            },
                        };
                        Ok(HandlerValue::Json(serde_json::to_value(hist).unwrap()))
                    }
                    "pendingInteractions" => Ok(HandlerValue::Json(
                        serde_json::to_value(PendingInteractions {
                            revision: 1,
                            entries: vec![],
                        })
                        .unwrap(),
                    )),
                    "watch" => {
                        let req: Watch = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        if req.session_id == "sess-beta" {
                            // Immediately push first delta frame as soon as watch opens.
                            context
                                .emit(
                                    serde_json::to_value(DeliveryPage::Events {
                                        through: 6,
                                        next_after: 6,
                                        events: vec![Delivery {
                                            sequence: 6,
                                            run_id: beta_run_id,
                                            turn_id: "t-b".into(),
                                            fact: DeliveryFact::Delta {
                                                step_id: beta_step_id,
                                                attempt_id: beta_attempt_id,
                                                part_id: "p-beta".into(),
                                                text: "Beta首帧立即送达".into(),
                                            },
                                        }],
                                    })
                                    .unwrap(),
                                )
                                .await
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                        }
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "send" => {
                        let req: AgentSend = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        if req.session_id == "sess-alpha" {
                            send_a_entered_flag.store(true, Ordering::SeqCst);
                            send_a_entered.notify_waiters();
                            send_a_gate.notified().await;
                            return Ok(HandlerValue::Json(
                                serde_json::to_value(SendResult::Queued {
                                    session_id: req.session_id,
                                    message_id: "msg-alpha-queued".into(),
                                    revision: 2,
                                    completion: None,
                                })
                                .unwrap(),
                            ));
                        }
                        Ok(HandlerValue::Json(
                            serde_json::to_value(SendResult::Queued {
                                session_id: req.session_id,
                                message_id: "msg-other".into(),
                                revision: 2,
                                completion: None,
                            })
                            .unwrap(),
                        ))
                    }
                    other => Err(HandlerError::from(format!("unexpected {other}"))),
                }
            })
        }
    }

    let (_dir, ws_addr, pairing, stop, server) = rt.block_on(async {
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
        let root_id = root.root_id().to_owned();
        let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
        let contract = maka_agent_api::contract();
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
        let agent_pkg = pkg(
            "test.agent",
            json!({
                "implementation": { "kind": "native", "implementation": "test.multi.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway",
            json!({
                "implementation": { "kind": "native", "implementation": GATEWAY },
                "configuration": { "type": "object" },
                "exports": {},
                "imports": { "agent": { "contract": contract, "cardinality": { "kind": "one" } } }
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
                        "agent": {
                            "key": Uuid::new_v4(),
                            "package": { "source": "pinned", "package": agent_pkg.application_ref() },
                            "usePackage": "host"
                        },
                        "gateway": {
                            "key": consumer,
                            "package": { "source": "pinned", "package": gateway_pkg.application_ref() },
                            "usePackage": "host",
                            "bindings": {
                                "agent": [{ "kind": "instance", "path": ["agent"], "export": "Agent" }]
                            }
                        }
                    }
                }))
                .unwrap(),
                vec![],
                vec![agent_pkg, gateway_pkg],
            )
            .await
            .unwrap();

        let mut native = NativeRegistry::default();
        let contract_c = contract.clone();
        let entered_c = send_a_entered.clone();
        let flag_c = send_a_entered_flag.clone();
        let gate_c = send_a_gate.clone();
        native
            .insert(
                "test.multi.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = contract_c.clone();
                    let root_id = root_id.clone();
                    let send_a_entered = entered_c.clone();
                    let send_a_entered_flag = flag_c.clone();
                    let send_a_gate = gate_c.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(MultiSessionService {
                                        root_id,
                                        deployment,
                                        send_a_entered,
                                        send_a_entered_flag,
                                        send_a_gate,
                                        room_run_id,
                                        beta_run_id,
                                        beta_step_id,
                                        beta_attempt_id,
                                        beta_fact_id,
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
                "agent": {
                    "consumer": [consumer],
                    "import": "agent",
                    "grant": {
                        "methods": [
                            "projects", "directories", "list", "catalog",
                            "observe", "history", "watch", "pendingInteractions", "send"
                        ],
                        "recovery": false
                    }
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
        let pairing = host.prepare_access("multi-session-host".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-ios-multi-{}", Uuid::new_v4()));
        let ipc = LocalListener::bind(&socket).unwrap();
        let ws = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
            .await
            .unwrap();
        let ws_addr = ws.local_addr().unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn({
            let stop = stop.clone();
            async move { host.serve(ipc, Some(ws), stop).await }
        });
        (dir, ws_addr, pairing, stop, server)
    });

    let uri = PairingTicketV1::new(
        pairing.root_id.clone(),
        "Multi Session Mac",
        "peer_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        vec![format!("ws://{ws_addr}")],
        pairing.credential.clone(),
        "nonce-multi-sess",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let _bridge =
        HostBridge::attach(channel.clone(), support_dir.path(), rt.handle().clone()).unwrap();

    let mut cfg = engine_config(channel.clone(), rt.handle().clone());
    cfg.viewport = Size::new(px(390.0), px(844.0));
    cfg.environment = Environment {
        os: Os::Ios,
        ..Environment::default()
    };
    let mut app = nsh_testing::Headless::start(cfg).unwrap();

    channel
        .send("ios.pairingUri", json!({ "uri": uri }))
        .unwrap();
    app.wait_for("label:Confirm pairing and connect").unwrap();
    app.press("label:Confirm pairing and connect").unwrap();

    // Wait for pairing to finish and chat screen to mount, then open drawer
    app.wait_for("label:Open drawer").unwrap();
    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Session Session Alpha").unwrap();
    app.press("label:Session Session Alpha").unwrap();

    // Send a message in Session Alpha whose Host response is intentionally gated
    app.type_text("label:Chat composer input", "Alpha慢响应消息")
        .unwrap();
    app.press("label:Send message").unwrap();

    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !send_a_entered_flag.load(Ordering::SeqCst) {
                send_a_entered.notified().await;
            }
        })
        .await
        .expect("Session Alpha send RPC must reach Host");
    });

    // Immediately switch to Session Beta on the SAME Host while Alpha's send is in-flight!
    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Session Session Beta").unwrap();
    app.press("label:Session Session Beta").unwrap();
    app.wait_for("text:Beta 历史记录").unwrap();
    app.wait_for("text:Beta首帧立即送达").unwrap();

    // Release Session Alpha's delayed SendResult::Queued response!
    send_a_gate.notify_waiters();
    app.wait(Duration::from_millis(250)).unwrap();

    assert!(
        app.shows("Beta 历史记录"),
        "Session Beta transcript must remain active"
    );
    assert!(
        !app.shows("Alpha慢响应消息") && !app.shows("已排队"),
        "delayed Session Alpha send response must not pollute Session Beta queued state"
    );

    // Switch to Room session and verify real RoomAuthor::Human + RoomAuthor::Session { execution }
    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Session Mesh 协作室").unwrap();
    app.press("label:Session Mesh 协作室").unwrap();
    app.wait_for("text:请核对 QUIC 证书状态").unwrap();
    app.wait_for("text:RPK 校验已全部通过").unwrap();
    app.wait_for("text:Session Alpha").unwrap();

    drop(app);
    rt.block_on(async {
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    });
}

#[test]
fn early_subscription_frame_before_subscribe_reply_is_not_dropped() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    let channel = HostChannel::new();
    let bootstrap_snap = json!({
        "devicePeerId": "peer_early_frame_test",
        "filter": { "kind": "all_computers" },
        "hosts": [{
            "rootId": "root-early",
            "hostName": "Early Frame Mac",
            "peerId": "peer_early_host",
            "endpoints": ["ws://127.0.0.1:9"],
            "credentialId": "cred-1",
            "lastConnectedAtMs": 1_795_300_000_000_u64,
            "collapsedInAllView": false,
            "connected": true,
            "hasCredential": true
        }],
        "active": {
            "rootId": "root-early",
            "hostName": "Early Frame Mac",
            "epoch": "epoch-early-1",
            "session": "host-sess-1",
            "endpoints": ["agent"]
        }
    });
    let session_json = json!({
        "id": "sess-early-1",
        "title": "Early Watch Session",
        "kind": "agent",
        "parentSessionId": null,
        "labels": [],
        "workspace": { "path": "/Users/dev/maka-agent", "projectId": null },
        "revision": 1,
        "updatedAt": 1_795_300_000_000_u64,
        "archived": false,
        "pinned": false,
        "hasUnread": false,
        "activity": "idle"
    });

    {
        let snap = bootstrap_snap.clone();
        channel.handle("ios.bootstrap", move |call| {
            call.reply(Ok(snap.clone()));
        });
    }
    {
        let sess = session_json.clone();
        channel.handle("ios.hostQuery", move |mut call| {
            let data = call.take_data();
            let method = data["method"].as_str().unwrap_or_default();
            let val = match method {
                "projects" => json!({ "kind": "projects", "revision": "r1", "projects": [], "next": null }),
                "directories" => json!({ "kind": "roots", "roots": [] }),
                "list" => json!({ "revision": "r1", "needsYouCount": 0, "sessions": [sess], "before": null, "after": null }),
                "observe" => json!({ "hostEpoch": "epoch-early-1", "session": sess, "through": 1, "run": null, "parts": [], "toolSeeds": [] }),
                "history" => json!({ "kind": "ready", "through": 1, "chunks": [], "before": null, "after": null }),
                "pendingInteractions" => json!({ "revision": 1, "entries": [] }),
                _ => json!({}),
            };
            call.reply(Ok(json!({ "value": val })));
        });
    }
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });
    {
        let ch = channel.clone();
        let handle_rt = rt.handle().clone();
        channel.handle("ios.subscribe", move |mut call| {
            let data = call.take_data();
            let sub_id = data["subscriptionId"].as_str().unwrap().to_owned();
            let method = data["method"].as_str().unwrap().to_owned();
            let ch = ch.clone();
            if method == "watch" {
                // Deliberately deliver the first subscription item BEFORE replying to ios.subscribe!
                handle_rt.spawn(async move {
                    let _ = ch.send(
                        "ios.subscriptionItem",
                        json!({
                            "subscriptionId": sub_id,
                            "generation": 42,
                            "item": {
                                "kind": "events",
                                "through": 2,
                                "nextAfter": 2,
                                "events": [{
                                    "sequence": 2,
                                    "runId": Uuid::new_v4().to_string(),
                                    "turnId": "t-early",
                                    "fact": {
                                        "kind": "delta",
                                        "stepId": Uuid::new_v4().to_string(),
                                        "attemptId": Uuid::new_v4().to_string(),
                                        "partId": "p-early",
                                        "text": "先于Reply到达的首帧内容"
                                    }
                                }]
                            }
                        }),
                    );
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    call.reply(Ok(json!({
                        "subscriptionId": sub_id,
                        "generation": 42
                    })));
                });
            } else {
                call.reply(Ok(json!({
                    "subscriptionId": sub_id,
                    "generation": 1
                })));
            }
        });
    }

    let mut cfg = engine_config(channel, rt.handle().clone());
    cfg.viewport = Size::new(px(390.0), px(844.0));
    cfg.environment = Environment {
        os: Os::Ios,
        ..Environment::default()
    };
    let mut app = nsh_testing::Headless::start(cfg).unwrap();

    app.wait_for("label:Session Early Watch Session").unwrap();
    app.press("label:Session Early Watch Session").unwrap();
    app.wait_for("text:先于Reply到达的首帧内容").unwrap();
}

#[tokio::test]
async fn unsubscribe_records_cancel_write_error_as_cleanup_warning() {
    use std::pin::Pin;
    use std::task::{Context as TaskContext, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    struct FailWriteStream {
        inner: maka_remote_client::BoxedStream,
        fail_writes: Arc<AtomicBool>,
    }

    impl AsyncRead for FailWriteStream {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for FailWriteStream {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "injected cancel write failure",
                )));
            }
            Pin::new(&mut self.inner).poll_write(cx, buf)
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "injected cancel flush failure",
                )));
            }
            Pin::new(&mut self.inner).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    let live = LiveTestHost::start().await;
    let support_dir = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let fail_writes = Arc::new(AtomicBool::new(false));
    let opener: EndpointOpener = {
        let fail_writes = fail_writes.clone();
        Arc::new(move |endpoint: &str| {
            let base = tcp_endpoint_opener(endpoint).map_err(|err| err.to_string())?;
            let fail_writes = fail_writes.clone();
            Ok(Arc::new(move || {
                let base = base.clone();
                let fail_writes = fail_writes.clone();
                Box::pin(async move {
                    let inner = base().await?;
                    Ok(Box::new(FailWriteStream { inner, fail_writes })
                        as maka_remote_client::BoxedStream)
                })
            }))
        })
    };

    let bridge = HostBridge::attach_with_opener(
        channel,
        support_dir.path(),
        tokio::runtime::Handle::current(),
        opener,
    )
    .unwrap();

    let uri = make_ticket_uri(
        &live,
        "Cancel Error Host",
        "peer_4444444444444444444444444444444444444444444444444444444444444444",
    );
    bridge.pair_host(json!({ "uri": uri })).await.unwrap();

    let sub = bridge
        .subscribe(json!({
            "subscriptionId": "logs-cancel-err",
            "endpoint": "hostLogs",
            "method": "watch",
            "input": { "position": { "kind": "tail" } }
        }))
        .await
        .unwrap();
    assert!(sub["generation"].as_u64().unwrap() >= 1);

    // Cut client writes before unsubscribing so WireControl::Cancel fails to transmit.
    fail_writes.store(true, Ordering::SeqCst);
    let unsub = bridge
        .unsubscribe(json!({ "subscriptionId": "logs-cancel-err" }))
        .await
        .unwrap();
    assert_eq!(unsub["cancelled"], true);

    let warnings = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let w = bridge.cleanup_warnings().await;
            if !w.is_empty() {
                break w;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("unsubscribe cancel write failure must be recorded in cleanup_warnings");
    assert!(
        warnings.iter().any(|msg| msg.contains("logs-cancel-err")
            && (msg.contains("injected cancel") || msg.contains("Broken pipe"))),
        "unexpected cleanup warnings: {warnings:?}"
    );

    fail_writes.store(false, Ordering::SeqCst);
    bridge.disconnect_host().await.unwrap();
    live.shutdown().await;
}
