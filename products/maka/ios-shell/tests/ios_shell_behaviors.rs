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

    // 6. Readonly Artifact Diff viewer -> tap line quotes back to Chat composer!
    app.press("label:Open diff artifact").unwrap();
    app.wait_for("text:轻点任意一行可引用发给 Maka").unwrap();
    app.press("label:Quote diff line 340").unwrap();
    app.wait_for("text:/引用: client.*340/").unwrap();

    // 7. Return Home -> test real setFilter wire schema round-trip (all_computers <-> single_computer).
    app.press("label:Back to home").unwrap();
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

    // 8. Settings: toggle Warm Light theme, disconnect, reconnect from Home, then remove host.
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

    // Remove saved Host via Settings -> returns to cold-start empty state.
    app.press("label:Back to home").unwrap();
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
