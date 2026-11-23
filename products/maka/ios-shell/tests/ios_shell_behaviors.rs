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
        PreviewPart, Project, ProjectRef, ProjectsPage, ProjectsRead, Run, RunBackend, RunState,
        ScheduleRead, ScheduledSummary, Schedules, Send as AgentSend, SendResult, Session,
        SessionActivity, SessionKind, SessionPage, SessionRead, Watch, Workspace, WorkspaceAccess,
        WorkspacePermissions,
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
    let watch_break = Arc::new(Notify::new());
    let catalog_break = Arc::new(Notify::new());
    let watch_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let catalog_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let list_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let queue_state = Arc::new(std::sync::Mutex::new(json!({
        "revision": 2, "entries": [
            {"messageId":"q-1", "kind":"followup", "preview":"短预览"},
            {"messageId":"q-hidden", "kind":"followup", "preview":"内部完成", "origin":{"kind":"session_completion", "sessionId":"worker", "messageId":"msg"}},
            {"messageId":"q-2", "kind":"followup", "preview":"第二条"},
            {"messageId":"q-held", "kind":"held", "preview":"等待恢复"}
        ]
    })));
    let queue_changed = Arc::new(Notify::new());
    let queue_conflict = Arc::new(AtomicBool::new(true));
    let queue_hold_reply = Arc::new(AtomicBool::new(false));
    let queue_reply_entered = Arc::new(Notify::new());
    let queue_reply_release = Arc::new(Notify::new());
    let queue_body = Arc::new(std::sync::Mutex::new(String::new()));
    let queue_edits = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let full_message = "完整正文超过预览范围：".to_string() + &"长内容".repeat(40) + "正文末尾";
    *queue_body.lock().unwrap() = full_message.clone();
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
        watch_break: Arc<Notify>,
        catalog_break: Arc<Notify>,
        watch_opens: Arc<std::sync::atomic::AtomicUsize>,
        catalog_opens: Arc<std::sync::atomic::AtomicUsize>,
        list_calls: Arc<std::sync::atomic::AtomicUsize>,
        queue_state: Arc<std::sync::Mutex<Value>>,
        queue_changed: Arc<Notify>,
        queue_conflict: Arc<AtomicBool>,
        queue_hold_reply: Arc<AtomicBool>,
        queue_reply_entered: Arc<Notify>,
        queue_reply_release: Arc<Notify>,
        queue_body: Arc<std::sync::Mutex<String>>,
        queue_edits: Arc<std::sync::Mutex<Vec<Value>>>,
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
            let watch_break = self.watch_break.clone();
            let catalog_break = self.catalog_break.clone();
            let watch_opens = self.watch_opens.clone();
            let catalog_opens = self.catalog_opens.clone();
            let list_calls = self.list_calls.clone();
            let queue_state = self.queue_state.clone();
            let queue_changed = self.queue_changed.clone();
            let queue_conflict = self.queue_conflict.clone();
            let queue_hold_reply = self.queue_hold_reply.clone();
            let queue_reply_entered = self.queue_reply_entered.clone();
            let queue_reply_release = self.queue_reply_release.clone();
            let queue_body = self.queue_body.clone();
            let queue_edits = self.queue_edits.clone();
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
                        list_calls.fetch_add(1, Ordering::SeqCst);
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
                        let seq = catalog_opens.fetch_add(1, Ordering::SeqCst);
                        let mut session = session;
                        if seq > 0 {
                            session.title = "重连后的新目录项".into();
                        }
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
                        tokio::select! {
                            _ = catalog_break.notified() => Err(HandlerError::from("catalog-test-interruption")),
                            _ = context.scope().cancellation.cancelled() => Ok(HandlerValue::Json(Value::Null)),
                        }
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
                        watch_opens.fetch_add(1, Ordering::SeqCst);
                        if req.after != 12 {
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
                        }
                        loop {
                            let queue = queue_state.lock().unwrap().clone();
                            context
                                .emit(json!({"kind":"queue", "queue":queue}))
                                .await
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                            tokio::select! {
                                _ = queue_changed.notified() => {},
                                _ = watch_break.notified() => return Err(HandlerError::from("watch-test-interruption")),
                                _ = context.scope().cancellation.cancelled() => break,
                            }
                        }
                        watch_cancelled.store(true, Ordering::SeqCst);
                        watch_cancel_notify.notify_waiters();
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "queueMessage" => {
                        let req: maka_agent_api::contract::QueueMessage =
                            serde_json::from_value(input)
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                        let revision = queue_state.lock().unwrap()["revision"].as_u64().unwrap();
                        if req.expected_revision != revision {
                            return to_val(
                                &json!({"kind":"revision_conflict", "expected":req.expected_revision, "actual":revision}),
                            );
                        }
                        assert_eq!(req.message_id, "q-1");
                        let message = queue_body.lock().unwrap().clone();
                        to_val(
                            &json!({"kind":"ready", "revision":revision, "message":message, "hasAttachments":false, "quotes":[]}),
                        )
                    }
                    "editQueue" => {
                        let req: maka_agent_api::contract::QueueMutation =
                            serde_json::from_value(input.clone())
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                        let revision = {
                            let mut state = queue_state.lock().unwrap();
                            let revision = state["revision"].as_u64().unwrap();
                            if queue_conflict.swap(false, Ordering::SeqCst) {
                                *queue_body.lock().unwrap() = "对端更新后的真实正文".into();
                                state["entries"][0]["preview"] = json!("对端更新后的真实正文");
                                state["revision"] = json!(revision + 1);
                                queue_changed.notify_one();
                                return to_val(
                                    &json!({"kind":"revision_conflict", "expected":req.expected_revision, "actual":revision + 1}),
                                );
                            }
                            assert_eq!(req.expected_revision, revision);
                            queue_edits.lock().unwrap().push(input["edit"].clone());
                            if let Some(ids) = input["edit"]["messageIds"].as_array() {
                                let entries = state["entries"].as_array().unwrap().clone();
                                let mut sorted: Vec<Value> = ids
                                    .iter()
                                    .map(|id| {
                                        entries
                                            .iter()
                                            .find(|e| e["messageId"] == *id)
                                            .unwrap()
                                            .clone()
                                    })
                                    .collect();
                                sorted.extend(
                                    entries.into_iter().filter(|e| e["kind"] != "followup"),
                                );
                                state["entries"] = json!(sorted);
                            } else {
                                *queue_body.lock().unwrap() =
                                    input["edit"]["message"].as_str().unwrap().to_owned();
                                state["entries"][0]["preview"] = json!("已保存的编辑");
                            }
                            state["revision"] = json!(revision + 1);
                            revision + 1
                        };
                        if queue_hold_reply.swap(false, Ordering::SeqCst) {
                            queue_reply_entered.notify_one();
                            queue_reply_release.notified().await;
                        } else {
                            queue_changed.notify_one();
                        }
                        to_val(&json!({"kind":"committed", "revision":revision}))
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
        let wb_clone = watch_break.clone();
        let cb_clone = catalog_break.clone();
        let wo_clone = watch_opens.clone();
        let co_clone = catalog_opens.clone();
        let lc_clone = list_calls.clone();
        let qs_clone = queue_state.clone();
        let qc_clone = queue_changed.clone();
        let qconf_clone = queue_conflict.clone();
        let qhold_clone = queue_hold_reply.clone();
        let qentered_clone = queue_reply_entered.clone();
        let qrelease_clone = queue_reply_release.clone();
        let qbody_clone = queue_body.clone();
        let qe_clone = queue_edits.clone();
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
                    let watch_break = wb_clone.clone();
                    let catalog_break = cb_clone.clone();
                    let watch_opens = wo_clone.clone();
                    let catalog_opens = co_clone.clone();
                    let list_calls = lc_clone.clone();
                    let queue_state = qs_clone.clone();
                    let queue_changed = qc_clone.clone();
                    let queue_conflict = qconf_clone.clone();
                    let queue_hold_reply = qhold_clone.clone();
                    let queue_reply_entered = qentered_clone.clone();
                    let queue_reply_release = qrelease_clone.clone();
                    let queue_body = qbody_clone.clone();
                    let queue_edits = qe_clone.clone();
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
                                        watch_break,
                                        catalog_break,
                                        watch_opens,
                                        catalog_opens,
                                        list_calls,
                                        queue_state,
                                        queue_changed,
                                        queue_conflict,
                                        queue_hold_reply,
                                        queue_reply_entered,
                                        queue_reply_release,
                                        queue_body,
                                        queue_edits,
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
                            "watch", "queueMessage", "editQueue", "pendingInteractions", "interaction", "respond", "send",
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
    app.wait_for("text:/已排队 3 条消息/").unwrap();
    app.wait_for("text:cargo test -p maka-peer-mesh --locked")
        .unwrap();
    app.wait_for("text:第一题：先处理哪条链路？").unwrap();
    app.wait_for("text:第二题：验证优先级如何安排？").unwrap();
    app.wait_for("text:需要桌面端系统权限").unwrap();
    app.wait_for("label:Cancel system permission wait").unwrap();

    app.press("label:Open queued messages").unwrap();
    app.press("label:Edit queued q-1").unwrap();
    app.wait_for("label:Queued message editor").unwrap();
    assert_eq!(
        app.screen()
            .input_text("label:Queued message editor")
            .unwrap(),
        Some(full_message.as_str())
    );
    app.type_text("label:Queued message editor", "追加编辑")
        .unwrap();
    app.press("label:Save queued message").unwrap();
    app.wait_for("text:/队列已变化/").unwrap();
    assert!(
        app.screen()
            .input_text("label:Queued message editor")
            .unwrap()
            .unwrap()
            .contains("追加编辑")
    );
    app.press("label:Review queued message").unwrap();
    app.wait_for("label:Keep queued edit").unwrap();
    app.wait_for("text:当前消息: 对端更新后的真实正文").unwrap();
    assert!(
        app.screen()
            .input_text("label:Queued message editor")
            .unwrap()
            .unwrap()
            .contains("正文末尾追加编辑")
    );
    app.press("label:Keep queued edit").unwrap();
    queue_hold_reply.store(true, Ordering::SeqCst);
    app.press("label:Save queued message").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), queue_reply_entered.notified())
            .await
            .unwrap()
    });
    app.type_text("label:Queued message editor", "回执期间继续输入")
        .unwrap();
    queue_reply_release.notify_one();
    app.wait_for("text:等待队列同步…").unwrap();
    watch_break.notify_one();
    app.wait_for("text:/会话流式订阅中断/").unwrap();
    app.wait_for("text:/队列同步已中断/").unwrap();
    assert!(
        app.screen()
            .input_text("label:Queued message editor")
            .unwrap()
            .unwrap()
            .contains("回执期间继续输入")
    );
    app.press("label:Save queued message").unwrap();
    assert_eq!(
        queue_edits.lock().unwrap().len(),
        1,
        "stale queue must not issue a mutation"
    );
    app.press("label:Retry subscriptions").unwrap();
    app.wait_for("text:/新的编辑已保留/").unwrap();
    assert!(
        app.screen()
            .input_text("label:Queued message editor")
            .unwrap()
            .unwrap()
            .contains("回执期间继续输入")
    );
    app.wait_for("text:已保存的编辑").unwrap();
    watch_break.notify_one();
    app.wait_for("text:/队列同步已中断/").unwrap();
    app.press("label:Save queued message").unwrap();
    assert_eq!(
        queue_edits.lock().unwrap().len(),
        1,
        "stale queue must block edits even with no pending receipt"
    );
    app.press("label:Retry subscriptions").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while app.screen().matches("text:/队列同步已中断/").unwrap() {
        assert!(
            std::time::Instant::now() < deadline,
            "queue snapshot was not restored"
        );
        app.wait(Duration::from_millis(10)).unwrap();
    }
    app.press("label:Review queued message").unwrap();
    app.wait_for("label:Keep queued edit").unwrap();
    app.press("label:Keep queued edit").unwrap();
    queue_hold_reply.store(true, Ordering::SeqCst);
    app.press("label:Save queued message").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), queue_reply_entered.notified())
            .await
            .unwrap()
    });
    queue_reply_release.notify_one();
    app.wait_for("text:等待队列同步…").unwrap();
    watch_break.notify_one();
    app.wait_for("text:/队列同步已中断/").unwrap();
    app.press("label:Cancel queued edit").unwrap();
    assert!(
        !app.screen().matches("label:Queued message editor").unwrap(),
        "must be able to exit editing while stale"
    );
    app.press("label:Retry subscriptions").unwrap();
    app.wait_for("label:Move queued up q-2").unwrap();
    app.press("label:Move queued up q-2").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if queue_edits.lock().unwrap().len() == 3 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    });
    let edits = queue_edits.lock().unwrap();
    assert!(
        edits[0]["message"]
            .as_str()
            .unwrap()
            .contains("正文末尾追加编辑")
    );
    assert!(
        edits[1]["message"]
            .as_str()
            .unwrap()
            .contains("回执期间继续输入")
    );
    assert_eq!(edits[2]["messageIds"], json!(["q-2", "q-hidden", "q-1"]));
    drop(edits);
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let texts = app.screen().texts();
        let second = texts.iter().position(|text| *text == "第二条");
        let first = texts.iter().position(|text| *text == "已保存的编辑");
        if matches!((second, first), (Some(a), Some(b)) if a < b) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "watch did not publish reordered rows: {texts:?}"
        );
        app.wait(Duration::from_millis(10)).unwrap();
    }
    app.press("label:Open queued messages").unwrap();
    {
        let mut queue = queue_state.lock().unwrap();
        queue["revision"] = json!(queue["revision"].as_u64().unwrap() + 1);
        queue["entries"] = json!([]);
    }
    queue_changed.notify_one();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while app.screen().matches("label:Open queued messages").unwrap() {
        assert!(
            std::time::Instant::now() < deadline,
            "empty queue entry was not removed"
        );
        app.wait(Duration::from_millis(10)).unwrap();
    }

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

    assert!(app.press("label:Toggle steer or queue delivery").is_err());
    assert!(app.press("label:Retry subscriptions").is_err());

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

    // Each failed stream is retried independently and delivers fresh data.
    let lists_before = list_calls.load(Ordering::SeqCst);
    let catalogs_before = catalog_opens.load(Ordering::SeqCst);
    {
        let mut queue = queue_state.lock().unwrap();
        queue["revision"] = json!(queue["revision"].as_u64().unwrap() + 1);
        queue["entries"] =
            json!([{"messageId":"q-2", "kind":"followup", "preview":"重连后收到的消息"}]);
    }
    watch_break.notify_one();
    app.wait_for("text:/会话流式订阅中断/").unwrap();
    app.press("label:Retry subscriptions").unwrap();
    app.wait_for("text:/已排队 1 条消息/").unwrap();
    app.press("label:Open queued messages").unwrap();
    app.wait_for("text:重连后收到的消息").unwrap();
    app.press("label:Open queued messages").unwrap();
    assert_eq!(catalog_opens.load(Ordering::SeqCst), catalogs_before);
    assert_eq!(list_calls.load(Ordering::SeqCst), lists_before);
    assert!(!app.shows("text:/会话流式订阅中断/"));
    assert!(app.shows("已连接 Studio Agent Host"));

    let watches_before = watch_opens.load(Ordering::SeqCst);
    catalog_break.notify_one();
    app.wait_for("text:/会话目录同步中断/").unwrap();
    app.press("label:Retry subscriptions").unwrap();
    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Session 重连后的新目录项").unwrap();
    assert_eq!(watch_opens.load(Ordering::SeqCst), watches_before);
    assert_eq!(list_calls.load(Ordering::SeqCst), lists_before);
    // 9. Disconnect Host -> Host watch subscription cancels promptly!
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
#[test]
fn desktop_parity_project_plus_draft_models_goal_lifecycle_and_turn_rail() {
    use maka_agent_api::contract::{
        ChangeSession, Create, Created, DataSource, DeliveryPage, Directories, DirectoryPage,
        GoalChange, GoalResult, GoalView, History, HistoryChunk, HistoryOrder, HistoryPage,
        HistoryPosition, HistoryRowAddress, List, MarkRead, MarkReadResult, Metadata,
        MetadataResult, ModelChoice, ModelsPage, ModelsRead, Observation, PendingInteractions,
        Project, ProjectRef, ProjectsPage, ProjectsRead, SelectBackend, Send as AgentSend,
        SendResult, Session, SessionAction, SessionActivity, SessionChanged, SessionKind,
        SessionPage, SessionRead, Workspace, WorkspaceAccess, WorkspacePermissions,
        WorkspaceSelection,
    };
    use maka_agent_facts::{
        durable::{FactId, RunId},
        execution::ThinkingLevel,
        executor::BackendPreference,
    };
    use maka_agent_ports::session::history::{Cursor, HistoryField, Role};
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

    let proj_alpha_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
    let proj_empty_id = Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap();
    let goal_id = Uuid::parse_str("ab0ee903-f74d-4ba0-9145-06c6385ca630").unwrap();
    let deployment_id = Uuid::new_v4();
    let binding_id = Uuid::new_v4();
    let run_id = RunId::new();
    let facts = [
        FactId::new(),
        FactId::new(),
        FactId::new(),
        FactId::new(),
        FactId::new(),
    ];

    let created_reqs: Arc<
        std::sync::Mutex<Vec<(bool, String, WorkspaceSelection, Option<BackendPreference>)>>,
    > = Arc::new(std::sync::Mutex::new(Vec::new()));
    let metadata_reqs: Arc<std::sync::Mutex<Vec<(String, String, u64)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let change_reqs: Arc<std::sync::Mutex<Vec<(String, SessionAction)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let mark_read_reqs: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let goal_controls: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let history_before_called = Arc::new(AtomicBool::new(false));
    let goal_status = Arc::new(std::sync::Mutex::new("active".to_string()));
    let goal_revision = Arc::new(std::sync::Mutex::new(1u64));

    struct ParityAgentService {
        root_id: String,
        deployment_id: Uuid,
        binding_id: Uuid,
        proj_alpha_id: Uuid,
        proj_empty_id: Uuid,
        goal_id: Uuid,
        run_id: RunId,
        facts: [FactId; 5],
        sessions: Arc<std::sync::Mutex<Vec<Session>>>,
        created_reqs: Arc<
            std::sync::Mutex<Vec<(bool, String, WorkspaceSelection, Option<BackendPreference>)>>,
        >,
        metadata_reqs: Arc<std::sync::Mutex<Vec<(String, String, u64)>>>,
        change_reqs: Arc<std::sync::Mutex<Vec<(String, SessionAction)>>>,
        mark_read_reqs: Arc<std::sync::Mutex<Vec<String>>>,
        goal_controls: Arc<std::sync::Mutex<Vec<String>>>,
        history_before_called: Arc<AtomicBool>,
        goal_status: Arc<std::sync::Mutex<String>>,
        goal_revision: Arc<std::sync::Mutex<u64>>,
    }

    impl Handler for ParityAgentService {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
        {
            let root_id = self.root_id.clone();
            let deployment_id = self.deployment_id;
            let binding_id = self.binding_id;
            let proj_alpha_id = self.proj_alpha_id;
            let proj_empty_id = self.proj_empty_id;
            let goal_id = self.goal_id;
            let run_id = self.run_id;
            let facts = self.facts;
            let sessions = self.sessions.clone();
            let created_reqs = self.created_reqs.clone();
            let metadata_reqs = self.metadata_reqs.clone();
            let change_reqs = self.change_reqs.clone();
            let mark_read_reqs = self.mark_read_reqs.clone();
            let goal_controls = self.goal_controls.clone();
            let history_before_called = self.history_before_called.clone();
            let goal_status = self.goal_status.clone();
            let goal_revision = self.goal_revision.clone();

            Box::pin(async move {
                fn to_val<T: serde::Serialize>(v: &T) -> Result<HandlerValue, HandlerError> {
                    serde_json::to_value(v)
                        .map(HandlerValue::Json)
                        .map_err(|e| HandlerError::from(e.to_string()))
                }

                let make_goal_view = |status_str: &str, rev: u64| -> GoalView {
                    serde_json::from_value(json!({
                        "enabled": true,
                        "current": {
                            "id": goal_id.to_string(),
                            "revision": rev,
                            "objective": "对齐 iOS 与 Desktop 的全部核心交互",
                            "status": status_str,
                            "iterations": 2,
                            "tokenBudget": null,
                            "consumed": { "known": 1650, "missing": 0 },
                            "remainingTokens": null,
                            "elapsedSeconds": 125,
                            "retryAt": null,
                            "createdAt": 1795300000000u64,
                            "pending": false,
                            "dismissed": false,
                            "report": null,
                            "note": "正在补齐 TurnRail 与 GoalBar"
                        }
                    }))
                    .unwrap()
                };

                match method.as_str() {
                    "projects" => {
                        let _req: ProjectsRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let rev = "b".repeat(64);
                        to_val(&ProjectsPage::Projects {
                            revision: rev.clone(),
                            projects: vec![
                                Project {
                                    reference: ProjectRef {
                                        id: proj_alpha_id,
                                        revision: rev.clone(),
                                    },
                                    name: "alpha-repo".into(),
                                    archived: false,
                                    available: true,
                                    path: Some("/Users/dev/alpha".into()),
                                },
                                Project {
                                    reference: ProjectRef {
                                        id: proj_empty_id,
                                        revision: rev,
                                    },
                                    name: "empty-lab".into(),
                                    archived: false,
                                    available: true,
                                    path: Some("/Users/dev/empty-lab".into()),
                                },
                            ],
                            next: None,
                        })
                    }
                    "directories" => {
                        let _req: Directories = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&DirectoryPage::Roots { roots: vec![] })
                    }
                    "list" => {
                        let req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let filtered: Vec<Session> = sessions
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|s| {
                                if req.include_archived {
                                    s.archived
                                } else {
                                    !s.archived
                                }
                            })
                            .cloned()
                            .collect();
                        to_val(&SessionPage {
                            revision: "rev-parity".into(),
                            needs_you_count: 0,
                            sessions: filtered,
                            before: None,
                            after: None,
                        })
                    }
                    "catalog" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let visible: Vec<Session> = sessions
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|s| !s.archived)
                            .cloned()
                            .collect();
                        context
                            .emit(
                                serde_json::to_value(&SessionPage {
                                    revision: "rev-parity".into(),
                                    needs_you_count: 0,
                                    sessions: visible,
                                    before: None,
                                    after: None,
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "models" => {
                        let _req: ModelsRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&ModelsPage::Ready {
                            revision: "mrev-1".into(),
                            choices: vec![ModelChoice {
                                service_tiers: vec![],
                                selection: BackendPreference::Model {
                                    connection_id: "kimi-coding-plan".into(),
                                    model_id: "kimi-for-coding".into(),
                                    service_tier: None,
                                    thinking_level: Some(ThinkingLevel::Medium),
                                },
                                aliases: vec![],
                                source_name: "Kimi Coding Plan".into(),
                                label: "Kimi K2.5".into(),
                                thinking_levels: vec!["low".into(), "medium".into(), "high".into()],
                                default_thinking_level: Some("medium".into()),
                            }],
                            refreshing: false,
                            complete: true,
                            next: None,
                        })
                    }
                    "selectBackend" => {
                        let req: SelectBackend = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let mut guard = sessions.lock().unwrap();
                        let s = guard.iter_mut().find(|s| s.id == req.session_id).unwrap();
                        s.backend = Some(req.backend);
                        s.revision += 1;
                        to_val(&MetadataResult::Committed {
                            session: Box::new(s.clone()),
                        })
                    }
                    "create" => {
                        let req: Create = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let (proj_id, path) = match &req.workspace {
                            WorkspaceSelection::Project { project_id, path } => {
                                (Some(*project_id), path.clone())
                            }
                            _ => (Some(proj_empty_id), "/Users/dev/empty-lab".into()),
                        };
                        created_reqs.lock().unwrap().push((
                            req.automatic_title,
                            req.title.clone(),
                            req.workspace,
                            req.backend.clone(),
                        ));
                        let created_session = Session {
                            incognito: false,
                            kind: SessionKind::Agent,
                            applied_preset: None,
                            parent_session_id: None,
                            branch: None,
                            backend: req.backend,
                            tools: None,
                            data_source: Box::new(DataSource {
                                state_domain: root_id.clone(),
                                deployment: deployment_id,
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
                                id: binding_id,
                                permission_epoch: 1,
                            },
                            id: "sess-draft-created".into(),
                            title: "自动生成标题".into(),
                            labels: vec![],
                            workspace: Workspace {
                                worktree: None,
                                project_id: proj_id,
                                path,
                            },
                            revision: 1,
                            updated_at: 1_795_300_200_000,
                            archived: false,
                            pinned: false,
                            has_unread: false,
                            tail_message_id: None,
                            activity: SessionActivity::Idle,
                        };
                        sessions.lock().unwrap().insert(0, created_session.clone());
                        to_val(&Created::Created {
                            session: Box::new(created_session),
                        })
                    }
                    "send" => {
                        let req: AgentSend = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&SendResult::Started {
                            session_id: req.session_id,
                            run_id,
                            message_id: "msg-draft-1".into(),
                            completion: None,
                        })
                    }
                    "observe" => {
                        let req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let guard = sessions.lock().unwrap();
                        let s = guard
                            .iter()
                            .find(|s| s.id == req.session_id)
                            .cloned()
                            .unwrap_or_else(|| guard[0].clone());
                        to_val(&Observation {
                            session: s,
                            last_completed_turn_id: Some("t-5".into()),
                            compacting: None,
                            remembered_backend: None,
                            metrics: None,
                            latest_run_id: None,
                            through: 5,
                            run: None,
                            parts: vec![],
                            tool_seeds: vec![],
                        })
                    }
                    "history" => {
                        let req: History = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let mk = |seq: u64, fact: FactId, role: Role, id: &str, text: &str| {
                            HistoryChunk {
                                imported_turn: None,
                                run_id: Some(run_id),
                                model_part: None,
                                source_citation: false,
                                citation: None,
                                citation_anchor: None,
                                has_references: false,
                                quotes: vec![],
                                final_output: false,
                                reply_info: None,
                                final_answer: role == Role::Assistant,
                                model: None,
                                origin: None,
                                compaction: None,
                                attachments: vec![],
                                timing: None,
                                folded_work: None,
                                work: None,
                                field: HistoryField::Body,
                                message_id: Some(id.into()),
                                turn_id: Some(format!("t-{seq}")),
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
                            }
                        };
                        match req.position {
                            HistoryPosition::Before { .. } => {
                                history_before_called.store(true, Ordering::SeqCst);
                                to_val(&HistoryPage::Ready {
                                    through: Some(5),
                                    chunks: vec![mk(
                                        1,
                                        facts[0],
                                        Role::User,
                                        "m-older-1",
                                        "更早的历史消息内容",
                                    )],
                                    before: None,
                                    after: None,
                                })
                            }
                            _ => to_val(&HistoryPage::Ready {
                                through: Some(5),
                                chunks: vec![
                                    mk(2, facts[1], Role::User, "m-u1", "第一轮提问：检查编译状态"),
                                    mk(
                                        3,
                                        facts[2],
                                        Role::Assistant,
                                        "m-a1",
                                        "第一轮答复：编译正常。",
                                    ),
                                    mk(
                                        4,
                                        facts[3],
                                        Role::User,
                                        "m-u2",
                                        "第二轮提问：加上右侧进度条",
                                    ),
                                    mk(
                                        5,
                                        facts[4],
                                        Role::Assistant,
                                        "m-a2",
                                        "第二轮答复：TurnRail 已就绪。",
                                    ),
                                ],
                                before: Some(Cursor {
                                    position: HistoryRowAddress::Live {
                                        sequence: 2,
                                        fact: facts[1],
                                        item_index: 0,
                                    },
                                    field: HistoryField::Body,
                                    offset: 0,
                                }),
                                after: None,
                            }),
                        }
                    }
                    "watch" => {
                        context
                            .emit(
                                serde_json::to_value(&DeliveryPage::Events {
                                    through: 5,
                                    next_after: 5,
                                    events: vec![],
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "pendingInteractions" => to_val(&PendingInteractions {
                        revision: 1,
                        entries: vec![],
                    }),
                    "markRead" => {
                        let req: MarkRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        mark_read_reqs.lock().unwrap().push(req.session_id.clone());
                        let mut guard = sessions.lock().unwrap();
                        let s = guard.iter_mut().find(|s| s.id == req.session_id).unwrap();
                        s.has_unread = false;
                        to_val(&MarkReadResult::Observed {
                            session: Box::new(s.clone()),
                        })
                    }
                    "metadata" => {
                        let req: Metadata = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        metadata_reqs.lock().unwrap().push((
                            req.session_id.clone(),
                            req.title.clone(),
                            req.expected_revision,
                        ));
                        let mut guard = sessions.lock().unwrap();
                        let s = guard.iter_mut().find(|s| s.id == req.session_id).unwrap();
                        s.title = req.title;
                        if let Some(p) = req.pinned {
                            s.pinned = p;
                        }
                        s.revision += 1;
                        to_val(&MetadataResult::Committed {
                            session: Box::new(s.clone()),
                        })
                    }
                    "changeSession" => {
                        let req: ChangeSession = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        change_reqs
                            .lock()
                            .unwrap()
                            .push((req.session_id.clone(), req.action));
                        let mut guard = sessions.lock().unwrap();
                        let s = guard.iter_mut().find(|s| s.id == req.session_id).unwrap();
                        if matches!(req.action, SessionAction::Archive) {
                            s.archived = true;
                        }
                        s.revision += 1;
                        to_val(&SessionChanged::Changed {
                            session: Box::new(s.clone()),
                        })
                    }
                    "goal" => {
                        let st = goal_status.lock().unwrap().clone();
                        let rev = *goal_revision.lock().unwrap();
                        to_val(&make_goal_view(&st, rev))
                    }
                    "watchGoal" => {
                        let st = goal_status.lock().unwrap().clone();
                        let rev = *goal_revision.lock().unwrap();
                        context
                            .emit(serde_json::to_value(&make_goal_view(&st, rev)).unwrap())
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "changeGoal" => {
                        let req: GoalChange = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        match req {
                            GoalChange::Control { action, .. } => {
                                let action_str = serde_json::to_value(action)
                                    .unwrap()
                                    .as_str()
                                    .unwrap()
                                    .to_string();
                                goal_controls.lock().unwrap().push(action_str.clone());
                                if action_str == "pause" {
                                    *goal_status.lock().unwrap() = "paused".into();
                                }
                                let mut rev = goal_revision.lock().unwrap();
                                *rev += 1;
                                to_val(&GoalResult::Committed {
                                    goal_id,
                                    revision: *rev,
                                })
                            }
                            _ => Err(HandlerError::from("unexpected GoalChange variant")),
                        }
                    }
                    other => Err(HandlerError::from(format!(
                        "unexpected parity agent method: {other}"
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
            "test.agent.parity",
            json!({
                "implementation": { "kind": "native", "implementation": "test.parity.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": agent_contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway.parity",
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

        let initial_sessions = Arc::new(std::sync::Mutex::new(vec![Session {
            incognito: false,
            kind: SessionKind::Agent,
            applied_preset: None,
            parent_session_id: None,
            branch: None,
            backend: None,
            tools: None,
            data_source: Box::new(DataSource {
                state_domain: root_id_for_service.clone(),
                deployment: deployment_id,
                namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
            }),
            permissions: WorkspacePermissions {
                access: WorkspaceAccess::WorkspaceWrite,
                request_permissions: true,
            },
            boundary_revision: 1,
            binding: BindingStamp {
                id: binding_id,
                permission_epoch: 1,
            },
            id: "sess-existing".into(),
            title: "现有会话 Alpha".into(),
            labels: vec![],
            workspace: Workspace {
                worktree: None,
                project_id: Some(proj_alpha_id),
                path: "/Users/dev/alpha".into(),
            },
            revision: 2,
            updated_at: 1_795_300_100_000,
            archived: false,
            pinned: false,
            has_unread: true,
            tail_message_id: Some("m-a2".into()),
            activity: SessionActivity::Idle,
        }]));

        let mut native = NativeRegistry::default();
        let contract_clone = agent_contract.clone();
        let created_c = created_reqs.clone();
        let metadata_c = metadata_reqs.clone();
        let change_c = change_reqs.clone();
        let mark_c = mark_read_reqs.clone();
        let goal_c = goal_controls.clone();
        let hist_c = history_before_called.clone();
        let gs_c = goal_status.clone();
        let gr_c = goal_revision.clone();
        native
            .insert(
                "test.parity.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = contract_clone.clone();
                    let root_id = root_id_for_service.clone();
                    let sessions = initial_sessions.clone();
                    let created_reqs = created_c.clone();
                    let metadata_reqs = metadata_c.clone();
                    let change_reqs = change_c.clone();
                    let mark_read_reqs = mark_c.clone();
                    let goal_controls = goal_c.clone();
                    let history_before_called = hist_c.clone();
                    let goal_status = gs_c.clone();
                    let goal_revision = gr_c.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(ParityAgentService {
                                        root_id,
                                        deployment_id,
                                        binding_id,
                                        proj_alpha_id,
                                        proj_empty_id,
                                        goal_id,
                                        run_id,
                                        facts,
                                        sessions,
                                        created_reqs,
                                        metadata_reqs,
                                        change_reqs,
                                        mark_read_reqs,
                                        goal_controls,
                                        history_before_called,
                                        goal_status,
                                        goal_revision,
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
                            "projects", "directories", "list", "catalog", "models", "selectBackend",
                            "create", "send", "observe", "history", "watch", "pendingInteractions",
                            "markRead", "metadata", "changeSession", "goal", "watchGoal", "changeGoal"
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
        let pairing = host.prepare_access("ios-parity-e2e".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\.pipemaka-ios-parity-{}", Uuid::new_v4()));
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
        "Parity Mac",
        "peer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vec![format!("ws://{ws_addr}")],
        pairing.credential.clone(),
        "nonce-parity-01",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

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

    // 1. Pair & auto-open existing unread session -> verifies markRead, GoalBar, TurnRail, and Load earlier!
    app.wait_for("label:Confirm pairing and connect").unwrap();
    app.press("label:Confirm pairing and connect").unwrap();
    app.wait_for("text:现有会话 Alpha").unwrap();
    app.wait_for("text:第二轮答复：TurnRail 已就绪。").unwrap();
    app.wait_for("text:目标 · 正在推进").unwrap();
    app.wait_for("label:Jump to turn m-u1").unwrap();
    app.wait_for("label:Jump to turn m-u2").unwrap();

    app.press("label:Jump to turn m-u1").unwrap();
    app.wait_for("text:/第一轮提问：检查编译状态/").unwrap();
    assert!(
        !mark_read_reqs.lock().unwrap().is_empty(),
        "opening unread session must call agent.markRead"
    );

    // 2. Expand GoalBar and pause active goal via real agent.changeGoal!
    app.press("label:Toggle goal details").unwrap();
    app.wait_for("text:对齐 iOS 与 Desktop 的全部核心交互")
        .unwrap();
    app.press("label:Pause goal").unwrap();
    app.wait_for("text:目标 · 已暂停").unwrap();
    assert_eq!(goal_controls.lock().unwrap().as_slice(), &["pause"]);

    // 3. Backward history pagination ("加载更早消息" -> HistoryPosition::Before)!
    app.press("label:Load earlier messages").unwrap();
    app.wait_for("text:更早的历史消息内容").unwrap();
    assert!(history_before_called.load(Ordering::SeqCst));

    // 4. Inline header rename -> real agent.metadata with expectedRevision!
    app.press("label:Rename active session title").unwrap();
    app.type_text("label:Inline rename active session input", " · 已改名")
        .unwrap();
    app.press("label:Save inline session title").unwrap();
    app.wait_for("text:现有会话 Alpha · 已改名").unwrap();
    {
        let renames = metadata_reqs.lock().unwrap();
        assert_eq!(renames.len(), 1);
        assert_eq!(renames[0].0, "sess-existing");
        assert_eq!(renames[0].1, "现有会话 Alpha · 已改名");
        assert_eq!(renames[0].2, 2);
    }

    // 5. Open drawer -> verify EMPTY project "empty-lab" is shown with trailing "+" button!
    app.press("label:Open drawer").unwrap();
    app.wait_for("text:empty-lab").unwrap();
    app.wait_for("label:New draft in empty-lab").unwrap();

    // Pin and archive via Drawer "⋯" menu!
    app.press("label:Session actions 现有会话 Alpha · 已改名")
        .unwrap();
    app.press("label:Pin 现有会话 Alpha · 已改名").unwrap();
    app.wait_for("text:置顶").unwrap();
    app.press("label:Session actions 现有会话 Alpha · 已改名")
        .unwrap();
    app.press("label:Archive 现有会话 Alpha · 已改名").unwrap();
    assert!(
        change_reqs
            .lock()
            .unwrap()
            .iter()
            .any(|(sid, act)| sid == "sess-existing" && matches!(act, SessionAction::Archive))
    );

    // 6. Tap empty-lab trailing "+" -> opens local Draft (NO agent.create yet!), pick model + thinking level, send first message -> real agent.create(automaticTitle=true) + send!
    app.press("label:New draft in empty-lab").unwrap();
    app.wait_for("text:新对话").unwrap();
    app.wait_for("text:/工作区 · empty-lab/").unwrap();
    assert!(
        created_reqs.lock().unwrap().is_empty(),
        "tapping Project '+' must open a local Draft without prematurely calling agent.create"
    );

    app.press("label:Select model and thinking").unwrap();
    app.wait_for("text:Kimi K2.5").unwrap();
    app.press("label:Model Kimi K2.5").unwrap();
    app.press("label:Thinking high Kimi K2.5").unwrap();
    app.wait_for("text:/kimi-for-coding · high/").unwrap();

    app.type_text("label:Chat composer input", "帮我初始化 empty-lab 项目")
        .unwrap();
    app.press("label:Send message").unwrap();
    app.wait_for("text:自动生成标题").unwrap();

    {
        let created = created_reqs.lock().unwrap();
        assert_eq!(created.len(), 1);
        assert!(created[0].0, "first-send draft must enable automaticTitle");
        assert_eq!(created[0].1, "New conversation");
        assert!(matches!(
            &created[0].2,
            WorkspaceSelection::Project { project_id, path }
                if *project_id == proj_empty_id && path == "/Users/dev/empty-lab"
        ));
        assert!(matches!(
            &created[0].3,
            Some(BackendPreference::Model {
                model_id,
                thinking_level: Some(ThinkingLevel::High),
                ..
            }) if model_id == "kimi-for-coding"
        ));
    }

    rt.block_on(async {
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    });
    drop(dir);
}

#[test]
fn approval_rejection_keeps_card_open_and_send_rejection_restores_draft() {
    use maka_agent_api::contract::{
        DataSource, DeliveryPage, Directories, DirectoryPage, HistoryPage, InteractionKind,
        InteractionRead, InteractionRejection, InteractionRespond, InteractionResult,
        InteractionSummary, List, Observation, PendingInteractions, ProjectsPage, ProjectsRead,
        Send as AgentSend, SendRejection, SendResult, Session, SessionActivity, SessionKind,
        SessionPage, SessionRead, Workspace, WorkspaceAccess, WorkspacePermissions,
    };
    use maka_agent_facts::{
        durable::{AuthorizationObligation, ExecutionIdentity, RunId},
        interaction::{
            InteractionAnswer, InteractionQuestion, InteractionRecord, InteractionRequest,
            PermissionCommand, PermissionRequest, PermissionSource, QuestionOption,
            SystemPermissionGrant,
        },
    };
    use maka_host_runtime::application::{
        Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation,
        NativeRegistry,
    };
    use maka_plugin_core::runtime::Published;
    use maka_sandbox::{
        grant::Permissions,
        workspace::{BindingStamp, PermissionBasis},
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    let deployment_id = Uuid::new_v4();
    let binding_id = Uuid::new_v4();
    let active_run = RunId::new();
    let recorded_answers: Arc<std::sync::Mutex<Vec<(String, InteractionAnswer)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));

    struct SafetyAgentService {
        root_id: String,
        deployment_id: Uuid,
        binding_id: Uuid,
        active_run: RunId,
        recorded_answers: Arc<std::sync::Mutex<Vec<(String, InteractionAnswer)>>>,
    }

    impl Handler for SafetyAgentService {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
        {
            let root_id = self.root_id.clone();
            let deployment_id = self.deployment_id;
            let binding_id = self.binding_id;
            let active_run = self.active_run;
            let recorded_answers = self.recorded_answers.clone();

            Box::pin(async move {
                fn to_val<T: serde::Serialize>(v: &T) -> Result<HandlerValue, HandlerError> {
                    serde_json::to_value(v)
                        .map(HandlerValue::Json)
                        .map_err(|e| HandlerError::from(e.to_string()))
                }

                let session = Session {
                    incognito: false,
                    kind: SessionKind::Agent,
                    applied_preset: None,
                    parent_session_id: None,
                    branch: None,
                    backend: None,
                    tools: None,
                    data_source: Box::new(DataSource {
                        state_domain: root_id.clone(),
                        deployment: deployment_id,
                        namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
                    }),
                    permissions: WorkspacePermissions {
                        access: WorkspaceAccess::WorkspaceWrite,
                        request_permissions: true,
                    },
                    boundary_revision: 1,
                    binding: BindingStamp {
                        id: binding_id,
                        permission_epoch: 1,
                    },
                    id: "sess-safety".into(),
                    title: "安全边界回归".into(),
                    labels: vec![],
                    workspace: Workspace {
                        worktree: None,
                        project_id: None,
                        path: "/Users/dev/safety".into(),
                    },
                    revision: 1,
                    updated_at: 1_795_300_500_000,
                    archived: false,
                    pinned: false,
                    has_unread: false,
                    tail_message_id: None,
                    activity: SessionActivity::Waiting,
                };
                let execution = ExecutionIdentity {
                    session_id: "sess-safety".into(),
                    turn_id: "t-1".into(),
                    run_id: active_run,
                };
                let basis = PermissionBasis {
                    boundary_revision: 1,
                    binding: BindingStamp {
                        id: binding_id,
                        permission_epoch: 1,
                    },
                };
                let perm_record = InteractionRecord {
                    execution: execution.clone(),
                    request_id: "req-perm-no-tool".into(),
                    created_at: 1_795_300_501_000,
                    request: InteractionRequest::Permissions {
                        target: AuthorizationObligation::Cell {
                            cell: maka_agent_facts::cells::CellId::new(),
                            operation: Uuid::new_v4(),
                        },
                        tool_use_id: None,
                        basis,
                        request: PermissionRequest {
                            reason: "需要全局写入权限".into(),
                            command: Some(PermissionCommand {
                                command: "git push origin main".into(),
                                cwd: "/Users/dev/safety".into(),
                            }),
                            permissions: serde_json::from_value::<Permissions>(json!({
                                "filesystem": [{
                                    "path": "/Users/dev/safety",
                                    "scope": "subtree",
                                    "access": "write"
                                }],
                                "network": "allowed"
                            }))
                            .unwrap(),
                            source: PermissionSource::Processes,
                        },
                    },
                    outcome: None,
                };
                let q_record = InteractionRecord {
                    execution: execution.clone(),
                    request_id: "req-q-skip".into(),
                    created_at: 1_795_300_502_000,
                    request: InteractionRequest::Question {
                        tool_use_id: "tu-q-skip".into(),
                        questions: vec![InteractionQuestion {
                            question: "可选补充问题？".into(),
                            options: vec![
                                QuestionOption {
                                    label: "选项 A".into(),
                                    description: None,
                                },
                                QuestionOption {
                                    label: "选项 B".into(),
                                    description: None,
                                },
                            ],
                        }],
                    },
                    outcome: None,
                };
                let sys_record = InteractionRecord {
                    execution,
                    request_id: "req-sys-cancel".into(),
                    created_at: 1_795_300_503_000,
                    request: InteractionRequest::SystemPermission {
                        tool_use_id: "tu-sys".into(),
                        grants: vec![SystemPermissionGrant::ScreenRecording],
                        application: "Maka Host".into(),
                        application_location: None,
                    },
                    outcome: None,
                };

                match method.as_str() {
                    "projects" => {
                        let _req: ProjectsRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&ProjectsPage::Projects {
                            revision: "c".repeat(64),
                            projects: vec![],
                            next: None,
                        })
                    }
                    "directories" => {
                        let _req: Directories = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&DirectoryPage::Roots { roots: vec![] })
                    }
                    "list" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&SessionPage {
                            revision: "rev-safe".into(),
                            needs_you_count: 1,
                            sessions: vec![session],
                            before: None,
                            after: None,
                        })
                    }
                    "catalog" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context
                            .emit(
                                serde_json::to_value(&SessionPage {
                                    revision: "rev-safe".into(),
                                    needs_you_count: 1,
                                    sessions: vec![session],
                                    before: None,
                                    after: None,
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "observe" => {
                        let _req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&Observation {
                            session,
                            last_completed_turn_id: None,
                            compacting: None,
                            remembered_backend: None,
                            metrics: None,
                            latest_run_id: None,
                            through: 1,
                            run: None,
                            parts: vec![],
                            tool_seeds: vec![],
                        })
                    }
                    "history" => to_val(&HistoryPage::Ready {
                        through: Some(1),
                        chunks: vec![],
                        before: None,
                        after: None,
                    }),
                    "watch" => {
                        context
                            .emit(
                                serde_json::to_value(&DeliveryPage::Events {
                                    through: 1,
                                    next_after: 1,
                                    events: vec![],
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "goal" => Ok(HandlerValue::Json(
                        json!({ "enabled": false, "current": null }),
                    )),
                    "watchGoal" => {
                        context
                            .emit(json!({ "enabled": false, "current": null }))
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "pendingInteractions" => to_val(&PendingInteractions {
                        revision: 1,
                        entries: vec![
                            InteractionSummary {
                                request_id: "req-perm-no-tool".into(),
                                kind: InteractionKind::Permissions,
                                tool_use_id: None,
                            },
                            InteractionSummary {
                                request_id: "req-q-skip".into(),
                                kind: InteractionKind::Question,
                                tool_use_id: Some("tu-q-skip".into()),
                            },
                            InteractionSummary {
                                request_id: "req-sys-cancel".into(),
                                kind: InteractionKind::SystemPermission,
                                tool_use_id: Some("tu-sys".into()),
                            },
                        ],
                    }),
                    "interaction" => {
                        let req: InteractionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let rec = match req.request_id.as_str() {
                            "req-perm-no-tool" => Some(perm_record),
                            "req-q-skip" => Some(q_record),
                            "req-sys-cancel" => Some(sys_record),
                            _ => None,
                        };
                        to_val(&rec)
                    }
                    "respond" => {
                        let req: InteractionRespond = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        recorded_answers
                            .lock()
                            .unwrap()
                            .push((req.request_id.clone(), req.answer));
                        if req.request_id == "req-perm-no-tool" {
                            to_val(&InteractionResult::Rejected {
                                reason: InteractionRejection::AuthorizationChanged,
                            })
                        } else {
                            let rec = if req.request_id == "req-q-skip" {
                                q_record
                            } else {
                                sys_record
                            };
                            to_val(&InteractionResult::Recorded {
                                record: Box::new(rec),
                            })
                        }
                    }
                    "send" => {
                        let req: AgentSend = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&SendResult::Rejected {
                            session_id: req.session_id,
                            reason: SendRejection::ModelUnavailable,
                            skills: None,
                        })
                    }
                    other => Err(HandlerError::from(format!(
                        "unexpected safety agent method: {other}"
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
            "test.agent.safety",
            json!({
                "implementation": { "kind": "native", "implementation": "test.safety.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": agent_contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway.safety",
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
        let answers_c = recorded_answers.clone();
        native
            .insert(
                "test.safety.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = contract_clone.clone();
                    let root_id = root_id_for_service.clone();
                    let recorded_answers = answers_c.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(SafetyAgentService {
                                        root_id,
                                        deployment_id,
                                        binding_id,
                                        active_run,
                                        recorded_answers,
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
                            "watch", "goal", "watchGoal", "pendingInteractions", "interaction",
                            "respond", "send"
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
        let pairing = host.prepare_access("ios-safety-e2e".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\.pipemaka-ios-safety-{}", Uuid::new_v4()));
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
        "Safety Mac",
        "peer_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        vec![format!("ws://{ws_addr}")],
        pairing.credential.clone(),
        "nonce-safety-01",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

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
    app.wait_for("label:Confirm pairing and connect").unwrap();
    app.press("label:Confirm pairing and connect").unwrap();

    app.wait_for("text:git push origin main").unwrap();
    // toolUseId == None must hide "允许本次" and expose "本轮允许"!
    app.wait_for("label:Allow for run").unwrap();
    assert!(
        !app.screen().texts().iter().any(|t| *t == "允许本次"),
        "Allow once must be hidden when toolUseId is null"
    );

    // Clicking Allow for run gets InteractionResult::Rejected -> card MUST stay open & error banner shown!
    app.press("label:Allow for run").unwrap();
    app.wait_for("text:/权限回复被 Host 拒绝/").unwrap();
    app.wait_for("label:Allow for run").unwrap();

    // Clicking Skip question sends vec![None]!
    app.press("label:Skip question").unwrap();
    app.wait_for("text:已回答 · 已跳过").unwrap();

    // Clicking Cancel system permission wait sends SystemPermissionCancel!
    app.press("label:Cancel system permission wait").unwrap();
    app.wait_for("text:/已取消等待.*Maka Host/").unwrap();

    {
        let answers = recorded_answers.lock().unwrap();
        assert_eq!(answers.len(), 3);
        assert!(matches!(
            &answers[0],
            (id, InteractionAnswer::Permissions { .. }) if id == "req-perm-no-tool"
        ));
        assert_eq!(
            answers[1],
            (
                "req-q-skip".into(),
                InteractionAnswer::Question {
                    answers: vec![None]
                }
            )
        );
        assert_eq!(
            answers[2],
            (
                "req-sys-cancel".into(),
                InteractionAnswer::SystemPermissionCancel {}
            )
        );
    }

    // Sending a message when Host returns SendResult::Rejected restores the draft text!
    app.type_text("label:Chat composer input", "不要丢失这条草稿")
        .unwrap();
    app.press("label:Send message").unwrap();
    app.wait_for("text:/消息被 Host 拒绝/").unwrap();
    app.wait_for("text:不要丢失这条草稿").unwrap();

    rt.block_on(async {
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    });
    drop(dir);
}
#[test]
fn directory_children_pagination_and_goal_watch_beats_stale_read() {
    use maka_agent_api::contract::{
        DataSource, DeliveryPage, Directories, Directory, DirectoryPage, GoalChange, GoalResult,
        GoalView, HistoryPage, List, Observation, PendingInteractions, ProjectsPage, ProjectsRead,
        Session, SessionActivity, SessionKind, SessionPage, SessionRead, Workspace,
        WorkspaceAccess, WorkspacePermissions,
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

    let deployment_id = Uuid::new_v4();
    let binding_id = Uuid::new_v4();
    let goal_id = Uuid::parse_str("ab0ee903-f74d-4ba0-9145-06c6385ca631").unwrap();
    let stale_read_gate = Arc::new(Notify::new());
    let stale_read_entered = Arc::new(AtomicBool::new(false));
    let stale_read_returned = Arc::new(AtomicBool::new(false));
    let recorded_control_revs: Arc<std::sync::Mutex<Vec<u64>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let dir_after_calls: Arc<std::sync::Mutex<Vec<Option<String>>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));

    struct DirGoalService {
        root_id: String,
        deployment_id: Uuid,
        binding_id: Uuid,
        goal_id: Uuid,
        stale_read_gate: Arc<Notify>,
        stale_read_entered: Arc<AtomicBool>,
        stale_read_returned: Arc<AtomicBool>,
        recorded_control_revs: Arc<std::sync::Mutex<Vec<u64>>>,
        dir_after_calls: Arc<std::sync::Mutex<Vec<Option<String>>>>,
    }

    impl Handler for DirGoalService {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
        {
            let root_id = self.root_id.clone();
            let deployment_id = self.deployment_id;
            let binding_id = self.binding_id;
            let goal_id = self.goal_id;
            let stale_read_gate = self.stale_read_gate.clone();
            let stale_read_entered = self.stale_read_entered.clone();
            let stale_read_returned = self.stale_read_returned.clone();
            let recorded_control_revs = self.recorded_control_revs.clone();
            let dir_after_calls = self.dir_after_calls.clone();

            Box::pin(async move {
                fn to_val<T: serde::Serialize>(v: &T) -> Result<HandlerValue, HandlerError> {
                    serde_json::to_value(v)
                        .map(HandlerValue::Json)
                        .map_err(|e| HandlerError::from(e.to_string()))
                }
                let make_goal = |status: &str, rev: u64| -> GoalView {
                    serde_json::from_value(json!({
                        "enabled": true,
                        "current": {
                            "id": goal_id.to_string(),
                            "revision": rev,
                            "objective": "验证 Goal watch 优先于滞后 read",
                            "status": status,
                            "iterations": rev,
                            "tokenBudget": null,
                            "consumed": { "known": 100, "missing": 0 },
                            "remainingTokens": null,
                            "elapsedSeconds": 10,
                            "retryAt": null,
                            "createdAt": 1795300000000u64,
                            "pending": false,
                            "dismissed": false,
                            "report": null,
                            "note": ""
                        }
                    }))
                    .unwrap()
                };
                let session = Session {
                    incognito: false,
                    kind: SessionKind::Agent,
                    applied_preset: None,
                    parent_session_id: None,
                    branch: None,
                    backend: None,
                    tools: None,
                    data_source: Box::new(DataSource {
                        state_domain: root_id.clone(),
                        deployment: deployment_id,
                        namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
                    }),
                    permissions: WorkspacePermissions {
                        access: WorkspaceAccess::WorkspaceWrite,
                        request_permissions: true,
                    },
                    boundary_revision: 1,
                    binding: BindingStamp {
                        id: binding_id,
                        permission_epoch: 1,
                    },
                    id: "sess-dir-goal".into(),
                    title: "目录与目标测试".into(),
                    labels: vec![],
                    workspace: Workspace {
                        worktree: None,
                        project_id: None,
                        path: "/Users/dev/root".into(),
                    },
                    revision: 1,
                    updated_at: 1_795_300_100_000,
                    archived: false,
                    pinned: false,
                    has_unread: false,
                    tail_message_id: None,
                    activity: SessionActivity::Idle,
                };

                match method.as_str() {
                    "projects" => {
                        let _req: ProjectsRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&ProjectsPage::Projects {
                            revision: "d".repeat(64),
                            projects: vec![],
                            next: None,
                        })
                    }
                    "directories" => {
                        let req: Directories = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        match req {
                            Directories::Roots => to_val(&DirectoryPage::Roots {
                                roots: vec![Directory {
                                    name: "dev-root".into(),
                                    path: "/Users/dev/root".into(),
                                }],
                            }),
                            Directories::Children { path, after } => {
                                dir_after_calls.lock().unwrap().push(after.clone());
                                if after.is_none() {
                                    to_val(&DirectoryPage::Children {
                                        directory: Directory {
                                            name: "dev-root".into(),
                                            path,
                                        },
                                        children: vec![Directory {
                                            name: "sub-alpha".into(),
                                            path: "/Users/dev/root/sub-alpha".into(),
                                        }],
                                        after: Some("cur-dir-2".into()),
                                    })
                                } else {
                                    to_val(&DirectoryPage::Children {
                                        directory: Directory {
                                            name: "dev-root".into(),
                                            path,
                                        },
                                        children: vec![Directory {
                                            name: "sub-beta".into(),
                                            path: "/Users/dev/root/sub-beta".into(),
                                        }],
                                        after: None,
                                    })
                                }
                            }
                        }
                    }
                    "list" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&SessionPage {
                            revision: "rev-dg".into(),
                            needs_you_count: 0,
                            sessions: vec![session],
                            before: None,
                            after: None,
                        })
                    }
                    "catalog" => {
                        let _req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context
                            .emit(
                                serde_json::to_value(&SessionPage {
                                    revision: "rev-dg".into(),
                                    needs_you_count: 0,
                                    sessions: vec![session],
                                    before: None,
                                    after: None,
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "observe" => {
                        let _req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&Observation {
                            session,
                            last_completed_turn_id: None,
                            compacting: None,
                            remembered_backend: None,
                            metrics: None,
                            latest_run_id: None,
                            through: 1,
                            run: None,
                            parts: vec![],
                            tool_seeds: vec![],
                        })
                    }
                    "history" => to_val(&HistoryPage::Ready {
                        through: Some(1),
                        chunks: vec![],
                        before: None,
                        after: None,
                    }),
                    "watch" => {
                        context
                            .emit(
                                serde_json::to_value(&DeliveryPage::Events {
                                    through: 1,
                                    next_after: 1,
                                    events: vec![],
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "pendingInteractions" => to_val(&PendingInteractions {
                        revision: 1,
                        entries: vec![],
                    }),
                    "goal" => {
                        if !stale_read_entered.swap(true, Ordering::SeqCst) {
                            // First read stalls until watchGoal (rev 3) has already rendered!
                            stale_read_gate.notified().await;
                            stale_read_returned.store(true, Ordering::SeqCst);
                            to_val(&make_goal("active", 1))
                        } else {
                            // Post-control read returns rev 4
                            to_val(&make_goal("active", 4))
                        }
                    }
                    "watchGoal" => {
                        // Watch delivers newer revision 3 ("paused") immediately!
                        context
                            .emit(serde_json::to_value(&make_goal("paused", 3)).unwrap())
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "changeGoal" => {
                        let req: GoalChange = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        if let GoalChange::Control { revision, .. } = req {
                            recorded_control_revs.lock().unwrap().push(revision);
                            to_val(&GoalResult::Committed {
                                goal_id,
                                revision: revision + 1,
                            })
                        } else {
                            Err(HandlerError::from("unexpected GoalChange"))
                        }
                    }
                    other => Err(HandlerError::from(format!("unexpected method: {other}"))),
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
            "test.agent.dirgoal",
            json!({
                "implementation": { "kind": "native", "implementation": "test.dirgoal.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": agent_contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway.dirgoal",
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
        let gate_c = stale_read_gate.clone();
        let ent_c = stale_read_entered.clone();
        let ret_c = stale_read_returned.clone();
        let revs_c = recorded_control_revs.clone();
        let dir_c = dir_after_calls.clone();
        native
            .insert(
                "test.dirgoal.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = contract_clone.clone();
                    let root_id = root_id_for_service.clone();
                    let stale_read_gate = gate_c.clone();
                    let stale_read_entered = ent_c.clone();
                    let stale_read_returned = ret_c.clone();
                    let recorded_control_revs = revs_c.clone();
                    let dir_after_calls = dir_c.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(DirGoalService {
                                        root_id,
                                        deployment_id,
                                        binding_id,
                                        goal_id,
                                        stale_read_gate,
                                        stale_read_entered,
                                        stale_read_returned,
                                        recorded_control_revs,
                                        dir_after_calls,
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
                            "watch", "pendingInteractions", "goal", "watchGoal", "changeGoal"
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
        let pairing = host.prepare_access("ios-dirgoal-e2e".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\.pipemaka-ios-dirgoal-{}", Uuid::new_v4()));
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
        "DirGoal Mac",
        "peer_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        vec![format!("ws://{ws_addr}")],
        pairing.credential.clone(),
        "nonce-dirgoal-01",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

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
    app.wait_for("label:Confirm pairing and connect").unwrap();
    app.press("label:Confirm pairing and connect").unwrap();

    // 1. watchGoal delivers revision 3 ("paused") while initial agent.goal (rev 1, "active") is gated!
    app.wait_for("text:目标 · 已暂停").unwrap();
    // Release stale initial read and let it settle; UI MUST stay on rev 3 ("已暂停")!
    stale_read_gate.notify_one();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !stale_read_returned.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    });
    std::thread::sleep(Duration::from_millis(120));
    app.wait_for("text:目标 · 已暂停").unwrap();

    // Expand GoalBar and tap Resume -> MUST send revision 3 (NOT stale rev 1)!
    app.press("label:Toggle goal details").unwrap();
    app.press("label:Resume goal").unwrap();
    app.wait_for("text:目标 · 正在推进").unwrap();
    assert_eq!(recorded_control_revs.lock().unwrap().as_slice(), &[3]);

    // 2. Open Draft -> WorkspacePickerOverlay -> browse DirectoryPage::Children + after pagination!
    app.press("label:Open drawer").unwrap();
    app.press("label:New draft conversation").unwrap();
    app.wait_for("label:Pick draft workspace").unwrap();
    app.press("label:Pick draft workspace").unwrap();
    app.wait_for("label:Browse root dev-root").unwrap();
    app.press("label:Browse root dev-root").unwrap();
    app.wait_for("text:sub-alpha").unwrap();
    app.wait_for("label:Load more directories").unwrap();
    app.press("label:Load more directories").unwrap();
    app.wait_for("text:sub-beta").unwrap();
    app.press("label:Select dir sub-beta").unwrap();
    app.wait_for("text:/工作区 · sub-beta/").unwrap();
    assert_eq!(
        dir_after_calls.lock().unwrap().as_slice(),
        &[None, Some("cur-dir-2".into())]
    );

    rt.block_on(async {
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    });
    drop(dir);
}

#[test]
fn draft_create_switch_fencing_and_catalog_query_pagination_fencing() {
    use maka_agent_api::contract::{
        Create, Created, DataSource, DeliveryPage, Directories, DirectoryPage, HistoryPage, List,
        Observation, PendingInteractions, ProjectsPage, ProjectsRead, Send as AgentSend,
        SendResult, Session, SessionActivity, SessionKind, SessionPage, SessionPosition,
        SessionRead, Workspace, WorkspaceAccess, WorkspacePermissions,
    };
    use maka_agent_facts::durable::RunId;
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

    let deployment_id = Uuid::new_v4();
    let binding_id = Uuid::new_v4();
    let run_id = RunId::new();

    let create_gate = Arc::new(Notify::new());
    let create_entered = Arc::new(Notify::new());
    let create_fail_next = Arc::new(AtomicBool::new(false));
    let create_hang_next = Arc::new(AtomicBool::new(false));
    let create_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let send_session_ids: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));

    let slow_all_gate = Arc::new(Notify::new());
    let slow_all_entered = Arc::new(Notify::new());
    let slow_all_armed = Arc::new(AtomicBool::new(false));

    let load_more_gate = Arc::new(Notify::new());
    let load_more_entered = Arc::new(Notify::new());
    let load_more_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    struct FencingAgentService {
        root_id: String,
        deployment_id: Uuid,
        binding_id: Uuid,
        run_id: RunId,
        create_gate: Arc<Notify>,
        create_entered: Arc<Notify>,
        create_fail_next: Arc<AtomicBool>,
        create_hang_next: Arc<AtomicBool>,
        create_count: Arc<std::sync::atomic::AtomicUsize>,
        send_session_ids: Arc<std::sync::Mutex<Vec<String>>>,
        slow_all_gate: Arc<Notify>,
        slow_all_entered: Arc<Notify>,
        slow_all_armed: Arc<AtomicBool>,
        load_more_gate: Arc<Notify>,
        load_more_entered: Arc<Notify>,
        load_more_calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Handler for FencingAgentService {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'static>>
        {
            let root_id = self.root_id.clone();
            let deployment_id = self.deployment_id;
            let binding_id = self.binding_id;
            let run_id = self.run_id;
            let create_gate = self.create_gate.clone();
            let create_entered = self.create_entered.clone();
            let create_fail_next = self.create_fail_next.clone();
            let create_hang_next = self.create_hang_next.clone();
            let create_count = self.create_count.clone();
            let send_session_ids = self.send_session_ids.clone();
            let slow_all_gate = self.slow_all_gate.clone();
            let slow_all_entered = self.slow_all_entered.clone();
            let slow_all_armed = self.slow_all_armed.clone();
            let load_more_gate = self.load_more_gate.clone();
            let load_more_entered = self.load_more_entered.clone();
            let load_more_calls = self.load_more_calls.clone();

            Box::pin(async move {
                fn to_val<T: serde::Serialize>(v: &T) -> Result<HandlerValue, HandlerError> {
                    serde_json::to_value(v)
                        .map(HandlerValue::Json)
                        .map_err(|e| HandlerError::from(e.to_string()))
                }
                let mk_sess = |id: &str, title: &str| Session {
                    incognito: false,
                    kind: SessionKind::Agent,
                    applied_preset: None,
                    parent_session_id: None,
                    branch: None,
                    backend: None,
                    tools: None,
                    data_source: Box::new(DataSource {
                        state_domain: root_id.clone(),
                        deployment: deployment_id,
                        namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
                    }),
                    permissions: WorkspacePermissions {
                        access: WorkspaceAccess::WorkspaceWrite,
                        request_permissions: true,
                    },
                    boundary_revision: 1,
                    binding: BindingStamp {
                        id: binding_id,
                        permission_epoch: 1,
                    },
                    id: id.into(),
                    title: title.into(),
                    labels: vec![],
                    workspace: Workspace {
                        worktree: None,
                        project_id: None,
                        path: "/Users/dev/fence".into(),
                    },
                    revision: 1,
                    updated_at: 1_795_300_100_000,
                    archived: false,
                    pinned: false,
                    has_unread: false,
                    tail_message_id: None,
                    activity: SessionActivity::Idle,
                };

                match method.as_str() {
                    "projects" => {
                        let _req: ProjectsRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&ProjectsPage::Projects {
                            revision: "e".repeat(64),
                            projects: vec![],
                            next: None,
                        })
                    }
                    "directories" => {
                        let _req: Directories = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        to_val(&DirectoryPage::Roots { roots: vec![] })
                    }
                    "list" => {
                        let req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        if matches!(req.position, SessionPosition::After { .. }) {
                            load_more_calls.fetch_add(1, Ordering::SeqCst);
                            load_more_entered.notify_one();
                            load_more_gate.notified().await;
                            return to_val(&SessionPage {
                                revision: "rev-fence".into(),
                                needs_you_count: 1,
                                sessions: vec![mk_sess("sess-page2-stale", "旧筛选分页项")],
                                before: None,
                                after: None,
                            });
                        }
                        if req.include_archived {
                            return to_val(&SessionPage {
                                revision: "rev-arch".into(),
                                needs_you_count: 1,
                                sessions: vec![mk_sess("sess-arch-1", "归档会话 Gamma")],
                                before: None,
                                after: None,
                            });
                        }
                        if req.title_query.trim() == "slow" {
                            slow_all_armed.store(true, Ordering::SeqCst);
                            slow_all_entered.notify_one();
                            slow_all_gate.notified().await;
                            return to_val(&SessionPage {
                                revision: "rev-slow".into(),
                                needs_you_count: 1,
                                sessions: vec![mk_sess("sess-slow-stale", "过期的慢搜索结果")],
                                before: None,
                                after: None,
                            });
                        }
                        to_val(&SessionPage {
                            revision: "rev-fence".into(),
                            needs_you_count: 1,
                            sessions: vec![mk_sess("sess-beta", "现有会话 Beta")],
                            before: None,
                            after: Some("cur-p2".into()),
                        })
                    }
                    "catalog" => {
                        let req: List = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        if req.include_archived {
                            context
                                .emit(
                                    serde_json::to_value(&SessionPage {
                                        revision: "rev-arch".into(),
                                        needs_you_count: 1,
                                        sessions: vec![mk_sess("sess-arch-1", "归档会话 Gamma")],
                                        before: None,
                                        after: None,
                                    })
                                    .unwrap(),
                                )
                                .await
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                        } else if req.title_query.trim() != "slow" {
                            context
                                .emit(
                                    serde_json::to_value(&SessionPage {
                                        revision: "rev-fence".into(),
                                        needs_you_count: 1,
                                        sessions: vec![mk_sess("sess-beta", "现有会话 Beta")],
                                        before: None,
                                        after: Some("cur-p2".into()),
                                    })
                                    .unwrap(),
                                )
                                .await
                                .map_err(|e| HandlerError::from(e.to_string()))?;
                        }
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "observe" => {
                        let req: SessionRead = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let title = if req.session_id == "sess-beta" {
                            "现有会话 Beta"
                        } else {
                            "归档会话 Gamma"
                        };
                        to_val(&Observation {
                            session: mk_sess(&req.session_id, title),
                            last_completed_turn_id: None,
                            compacting: None,
                            remembered_backend: None,
                            metrics: None,
                            latest_run_id: None,
                            through: 1,
                            run: None,
                            parts: vec![],
                            tool_seeds: vec![],
                        })
                    }
                    "history" => to_val(&HistoryPage::Ready {
                        through: Some(1),
                        chunks: vec![],
                        before: None,
                        after: None,
                    }),
                    "watch" => {
                        context
                            .emit(
                                serde_json::to_value(&DeliveryPage::Events {
                                    through: 1,
                                    next_after: 1,
                                    events: vec![],
                                })
                                .unwrap(),
                            )
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "goal" => Ok(HandlerValue::Json(
                        json!({ "enabled": false, "current": null }),
                    )),
                    "watchGoal" => {
                        context
                            .emit(json!({ "enabled": false, "current": null }))
                            .await
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        context.scope().cancellation.cancelled().await;
                        Ok(HandlerValue::Json(Value::Null))
                    }
                    "pendingInteractions" => to_val(&PendingInteractions {
                        revision: 1,
                        entries: vec![],
                    }),
                    "create" => {
                        let _req: Create = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        let n = create_count.fetch_add(1, Ordering::SeqCst) + 1;
                        create_entered.notify_one();
                        if create_hang_next.swap(false, Ordering::SeqCst) {
                            // Never resolves on its own — stays pending across Host disconnect!
                            context.scope().cancellation.cancelled().await;
                            return Err(HandlerError::from("cancelled after disconnect"));
                        }
                        create_gate.notified().await;
                        if create_fail_next.load(Ordering::SeqCst) {
                            return Err(HandlerError::from("injected create failure"));
                        }
                        to_val(&Created::Created {
                            session: Box::new(mk_sess(
                                &format!("sess-late-{n}"),
                                &format!("迟到的草稿会话 {n}"),
                            )),
                        })
                    }
                    "send" => {
                        let req: AgentSend = serde_json::from_value(input)
                            .map_err(|e| HandlerError::from(e.to_string()))?;
                        send_session_ids
                            .lock()
                            .unwrap()
                            .push(req.session_id.clone());
                        to_val(&SendResult::Started {
                            session_id: req.session_id,
                            run_id,
                            message_id: "m-1".into(),
                            completion: None,
                        })
                    }
                    other => Err(HandlerError::from(format!("unexpected method: {other}"))),
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
            "test.agent.fencing",
            json!({
                "implementation": { "kind": "native", "implementation": "test.fencing.agent" },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "Agent": { "contract": agent_contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway.fencing",
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
        let cg = create_gate.clone();
        let ce = create_entered.clone();
        let cf = create_fail_next.clone();
        let ch = create_hang_next.clone();
        let cc = create_count.clone();
        let ss = send_session_ids.clone();
        let sg = slow_all_gate.clone();
        let se = slow_all_entered.clone();
        let sa = slow_all_armed.clone();
        let lg = load_more_gate.clone();
        let le = load_more_entered.clone();
        let lc = load_more_calls.clone();
        native
            .insert(
                "test.fencing.agent".into(),
                Arc::new(move |_ctx, _cfg| {
                    let contract = contract_clone.clone();
                    let root_id = root_id_for_service.clone();
                    let create_gate = cg.clone();
                    let create_entered = ce.clone();
                    let create_fail_next = cf.clone();
                    let create_hang_next = ch.clone();
                    let create_count = cc.clone();
                    let send_session_ids = ss.clone();
                    let slow_all_gate = sg.clone();
                    let slow_all_entered = se.clone();
                    let slow_all_armed = sa.clone();
                    let load_more_gate = lg.clone();
                    let load_more_entered = le.clone();
                    let load_more_calls = lc.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Agent".into(),
                                Published {
                                    contract,
                                    value: Arc::new(FencingAgentService {
                                        root_id,
                                        deployment_id,
                                        binding_id,
                                        run_id,
                                        create_gate,
                                        create_entered,
                                        create_fail_next,
                                        create_hang_next,
                                        create_count,
                                        send_session_ids,
                                        slow_all_gate,
                                        slow_all_entered,
                                        slow_all_armed,
                                        load_more_gate,
                                        load_more_entered,
                                        load_more_calls,
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
                            "watch", "goal", "watchGoal", "pendingInteractions", "create", "send"
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
        let pairing = host.prepare_access("ios-fencing-e2e".into()).await.unwrap();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket =
            std::path::PathBuf::from(format!(r"\.pipemaka-ios-fencing-{}", Uuid::new_v4()));
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
        "Fencing Mac",
        "peer_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        vec![format!("ws://{ws_addr}")],
        pairing.credential.clone(),
        "nonce-fencing-01",
        now_ms() + 300_000,
    )
    .unwrap()
    .encode_uri()
    .unwrap();

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
    app.wait_for("label:Confirm pairing and connect").unwrap();
    app.press("label:Confirm pairing and connect").unwrap();
    app.wait_for("text:现有会话 Beta").unwrap();

    // 1. Draft create SUCCESS while superseded by switching to Session Beta:
    //    MUST NOT hijack active session Beta and MUST NOT send into the late created session!
    app.press("label:Open drawer").unwrap();
    app.press("label:New draft conversation").unwrap();
    app.wait_for("text:新对话").unwrap();
    app.type_text("label:Chat composer input", "草稿首条消息")
        .unwrap();
    app.press("label:Send message").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), create_entered.notified())
            .await
            .unwrap();
    });
    // Switch to existing Session Beta BEFORE create settles!
    app.press("label:Open drawer").unwrap();
    app.press("label:Session 现有会话 Beta").unwrap();
    app.wait_for("text:现有会话 Beta").unwrap();
    create_gate.notify_one();
    std::thread::sleep(Duration::from_millis(120));
    app.wait_for("text:现有会话 Beta").unwrap();
    assert!(
        send_session_ids.lock().unwrap().is_empty(),
        "superseded Draft create must NOT send into late created session"
    );

    // 2. Draft create FAILURE while superseded by switching to Session Beta:
    //    MUST NOT pollute Session Beta's composer with the failed Draft's text!
    create_fail_next.store(true, Ordering::SeqCst);
    app.press("label:Open drawer").unwrap();
    app.press("label:New draft conversation").unwrap();
    app.wait_for("text:新对话").unwrap();
    app.type_text("label:Chat composer input", "失败草稿不串会话")
        .unwrap();
    app.press("label:Send message").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), create_entered.notified())
            .await
            .unwrap();
    });
    app.press("label:Open drawer").unwrap();
    app.press("label:Session 现有会话 Beta").unwrap();
    app.wait_for("text:现有会话 Beta").unwrap();
    create_gate.notify_one();
    std::thread::sleep(Duration::from_millis(120));
    app.wait_for("text:现有会话 Beta").unwrap();
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|t| *t == "失败草稿不串会话"),
        "failed superseded Draft must NOT overwrite Session Beta's composer"
    );

    // 3. Catalog pagination concurrency guard + stale filter-switch fencing + slow search fencing!
    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Load more sessions").unwrap();
    // Press Load more TWICE while first page-2 RPC is gated -> must only fire ONCE!
    app.press("label:Load more sessions").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), load_more_entered.notified())
            .await
            .unwrap();
    });
    app.press("label:Load more sessions").unwrap();
    assert_eq!(
        load_more_calls.load(Ordering::SeqCst),
        1,
        "concurrent Load more clicks must be deduplicated"
    );
    // Switch filter to Archived BEFORE stale Load more settles -> stale page-2 MUST be discarded!
    app.press("label:Filter archived").unwrap();
    app.wait_for("text:归档会话 Gamma").unwrap();
    load_more_gate.notify_one();
    std::thread::sleep(Duration::from_millis(120));
    app.wait_for("text:归档会话 Gamma").unwrap();
    assert!(
        !app.screen().texts().iter().any(|t| *t == "旧筛选分页项"),
        "stale Load more response must not append into newly selected Archived filter"
    );

    // Trigger slow search ("slow") under All, then switch back to Archived -> slow search MUST NOT overwrite Archived!
    app.press("label:Filter all").unwrap();
    app.type_text("label:Search sessions", "slow").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !slow_all_armed.load(Ordering::SeqCst) {
                slow_all_entered.notified().await;
            }
        })
        .await
        .unwrap();
    });
    app.press("label:Filter archived").unwrap();
    app.wait_for("text:归档会话 Gamma").unwrap();
    slow_all_gate.notify_one();
    std::thread::sleep(Duration::from_millis(120));
    app.wait_for("text:归档会话 Gamma").unwrap();
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|t| *t == "过期的慢搜索结果"),
        "stale slow search response must not overwrite newer filter results"
    );

    // 4. Draft create pending when Host disconnects:
    //    creatingDraft must clear, unsent text must be preserved in rootId:draft,
    //    and reconnecting + opening Draft must restore the text and allow immediate Send!
    create_fail_next.store(false, Ordering::SeqCst);
    create_hang_next.store(true, Ordering::SeqCst);
    app.press("label:Filter all").unwrap();
    app.press("label:New draft conversation").unwrap();
    app.wait_for("text:新对话").unwrap();
    app.type_text("label:Chat composer input", "断连不丢失草稿")
        .unwrap();
    app.press("label:Send message").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), create_entered.notified())
            .await
            .unwrap();
    });
    // Disconnect active Host WHILE create is permanently pending (NEVER released before reconnect)!
    app.press("label:Open drawer").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Disconnect active host").unwrap();
    // Reconnect to Fencing Mac from Settings WITHOUT releasing any stale RPC -> unsent Draft MUST be restored immediately and sendable!
    app.wait_for("label:Connect Fencing Mac").unwrap();
    app.press("label:Connect Fencing Mac").unwrap();
    app.press("label:Back from settings").unwrap();
    app.wait_for("label:New draft conversation").unwrap();
    app.press("label:New draft conversation").unwrap();
    app.wait_for("text:/断连不丢失草稿/").unwrap();
    // Verify creatingDraft is false and Send immediately triggers a fresh create + send!
    app.press("label:Send message").unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), create_entered.notified())
            .await
            .unwrap();
    });
    create_gate.notify_one();
    app.wait_for("text:/迟到的草稿会话/").unwrap();
    app.wait_for("label:Stop active run").unwrap();
    assert!(
        !send_session_ids.lock().unwrap().is_empty(),
        "reconnected Draft must not remain stuck in creatingDraft and must send cleanly"
    );

    rt.block_on(async {
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    });
    drop(dir);
}
