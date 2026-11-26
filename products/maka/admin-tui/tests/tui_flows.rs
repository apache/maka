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

use maka_admin_tui::{
    ControlPlane, ControlPlaneConfig, admin_root, app_options,
    backend::relay_mgr::RelayManager,
    model::{
        ActivityEntry, AdminCommand, AdminSnapshot, DeploymentView, HostEntry, HostHealth,
        HostRuntimeView, LocalRelayConfig, LocalRelayRuntime, LocalRelayState, LogLevel, LogLine,
        LogSnapshot, PairingInviteView, PeerEntry, PublishedEndpointView, RelayTlsMode,
        RemoteAccessView, RemoteRelayItem, SystemInfo, UpdateCheckState,
    },
};
use nsh_engine::HostChannel;
use nsh_platform_tui::{App, AppView, Input, Modifiers, MouseButton, MouseInput, MouseKind};
use ratatui::{Terminal, backend::TestBackend};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use uuid::Uuid;

fn sample_snapshot() -> AdminSnapshot {
    let dep_id = Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888);
    let root_id_a = "a".repeat(64);
    let root_id_b = "b".repeat(64);

    AdminSnapshot {
        refreshed_at: "23:59:10".to_owned(),
        busy_label: None,
        selected_host_key: Some(root_id_a.clone()),
        hosts: vec![
            HostEntry {
                key: root_id_a.clone(),
                label: "Default Host".to_owned(),
                root_id: Some(root_id_a.clone()),
                root_path: PathBuf::from("/Users/dev/.maka/application/host"),
                health: HostHealth::Running,
                runtime: Some(HostRuntimeView {
                    pid: 42190,
                    epoch: Uuid::from_u128(1).to_string(),
                    generation: Some(format!("{dep_id}:3")),
                    lifecycle_mode: "service".to_owned(),
                    protocol_version: 1,
                    sessions: 2,
                    active_calls: 1,
                    closing: false,
                    closed: false,
                    cleanup_error: None,
                    ipc_endpoint: "/Users/dev/.maka/control/host.sock".to_owned(),
                    websocket_endpoints: vec!["ws://127.0.0.1:49152/runtime-host".to_owned()],
                    published_endpoints: vec![
                        PublishedEndpointView {
                            name: "agent".to_owned(),
                            methods: vec!["run".to_owned(), "status".to_owned(), "stop".to_owned()],
                            product_owned: true,
                        },
                        PublishedEndpointView {
                            name: "settings".to_owned(),
                            methods: vec!["read".to_owned(), "write".to_owned()],
                            product_owned: true,
                        },
                    ],
                }),
                deployment: Some(DeploymentView {
                    deployment_id: dep_id,
                    config_revision: 3,
                    mode: "supervised".to_owned(),
                    admission: "active".to_owned(),
                    websocket: "127.0.0.1:49152".to_owned(),
                    sha256: "deadbeef".repeat(8),
                    executable: "/Users/dev/.maka/deployments/bin/maka".to_owned(),
                    pending_update_sha256: None,
                    update_policy: "nightly".to_owned(),
                    update_policy_revision: 2,
                    update_policy_last_error: None,
                    operation_in_progress: false,
                    supervisor_kind: "present".to_owned(),
                    supervisor_state: Some("running".to_owned()),
                    supervisor_enabled: Some(true),
                    supervisor_pid: Some(42190),
                    supervisor_last_result: Some(0),
                    supervisor_message: None,
                }),
                remote_access: Some(RemoteAccessView {
                    status: "connected".to_owned(),
                    peer_id: "peer_host_0123456789abcdef0123456789abcdef".to_owned(),
                    enabled: true,
                    relay_only: false,
                    relays: vec![RemoteRelayItem {
                        url: "https://relay.internal:3443/".to_owned(),
                        quic_port: Some(3478),
                        cert_sha256: Some("cafebabe".repeat(8)),
                        ca_der_path: None,
                        has_auth_token: true,
                        connected: true,
                    }],
                    connected_relays: vec!["https://relay.internal:3443/".to_owned()],
                    sas: None,
                    invite_state: Some("pending".to_owned()),
                    error: None,
                    cli_override: false,
                }),
                peers: vec![PeerEntry {
                    peer_id: "peer_iphone_9876543210fedcba9876543210".to_owned(),
                    grant: "remote_owner".to_owned(),
                    label: "M4n5ter iPhone".to_owned(),
                    created_at: "2026-11-26T10:00:00Z".to_owned(),
                    last_active_at: Some("2026-11-26T23:58:00Z".to_owned()),
                }],
                error: None,
            },
            HostEntry {
                key: root_id_b.clone(),
                label: "Staging Host".to_owned(),
                root_id: Some(root_id_b),
                root_path: PathBuf::from("/Users/dev/.maka/staging"),
                health: HostHealth::Stopped,
                runtime: None,
                deployment: None,
                remote_access: None,
                peers: vec![],
                error: None,
            },
        ],
        local_relay: LocalRelayState::Running(LocalRelayRuntime {
            http_addr: Some("127.0.0.1:3340".to_owned()),
            https_addr: Some("127.0.0.1:3443".to_owned()),
            quic_addr: Some("127.0.0.1:3478".to_owned()),
            cert_sha256: Some("1234abcd".repeat(8)),
            has_auth_token: true,
            started_at: "23:55:00 UTC".to_owned(),
            uptime_secs: 250,
            endpoint_url: "https://127.0.0.1:3443/".to_owned(),
            cli_command: "maka relay --https 127.0.0.1:3443 --self-signed --tls-san localhost"
                .to_owned(),
        }),
        local_relay_config: LocalRelayConfig::default(),
        active_invite: Some(PairingInviteView {
            uri: "maka://pair?v=1&invite=inv_demo_999".to_owned(),
            host_peer_id: "peer_host_0123456789abcdef0123456789abcdef".to_owned(),
            root_id: root_id_a,
            invite_id: "inv_demo_999".to_owned(),
            expires_at_ms: 1_900_000_000_000,
            relays: vec!["https://relay.internal:3443/".to_owned()],
            state: Some("pending".to_owned()),
        }),
        last_app_pairing: None,
        update_check: UpdateCheckState::UpToDate,
        system: SystemInfo {
            version: "0.3.0".to_owned(),
            channel: "nightly".to_owned(),
            install_path: "/usr/local/bin".to_owned(),
            install_writable: true,
            os: "macos".to_owned(),
            arch: "aarch64".to_owned(),
            maka_binary: "/usr/local/bin/maka".to_owned(),
            account_data_dir: "/Users/dev/Library/Application Support/maka".to_owned(),
            deployments_dir: "/Users/dev/Library/Application Support/maka/deployments".to_owned(),
            control_dir: "/Users/dev/Library/Application Support/maka/control".to_owned(),
            default_root: "/Users/dev/.maka/application/host".to_owned(),
        },
        activity: vec![
            ActivityEntry {
                id: 2,
                at: "23:58:42".to_owned(),
                target: "Local Relay".to_owned(),
                action: "Start".to_owned(),
                ok: true,
                detail: "Relay listening on https://127.0.0.1:3443/".to_owned(),
            },
            ActivityEntry {
                id: 1,
                at: "23:57:10".to_owned(),
                target: "Host".to_owned(),
                action: "Activate".to_owned(),
                ok: true,
                detail: "Activated Host (pid 42190)".to_owned(),
            },
        ],
    }
}

fn sample_logs() -> LogSnapshot {
    LogSnapshot {
        root_id: Some("a".repeat(64)),
        path: Some("/Users/dev/.maka/control/aaaa/host.stderr.log".to_owned()),
        missing: false,
        follow: true,
        lines: vec![
            LogLine {
                seq: 1,
                level: LogLevel::Info,
                text: "2026-11-26T23:57:10Z INFO maka_host: listening on ws://127.0.0.1:49152/runtime-host".to_owned(),
            },
            LogLine {
                seq: 2,
                level: LogLevel::Warn,
                text: "2026-11-26T23:58:02Z WARN remote_transport: reconnecting relay https://relay.internal:3443/".to_owned(),
            },
            LogLine {
                seq: 3,
                level: LogLevel::Error,
                text: "2026-11-26T23:58:15Z ERROR access: rejected expired pairing token".to_owned(),
            },
        ],
    }
}

type MountedSurface = (
    AppView,
    Terminal<TestBackend>,
    HostChannel,
    mpsc::Receiver<()>,
    Arc<Mutex<Vec<AdminCommand>>>,
);

fn mount_surface(cols: u16, rows: u16) -> MountedSurface {
    let (tx, rx) = mpsc::channel();
    let commands = Arc::new(Mutex::new(Vec::new()));
    let host = HostChannel::new();
    let captured = commands.clone();
    host.handle("command", move |call| {
        if let Ok(cmd) = serde_json::from_value::<AdminCommand>(call.data().clone()) {
            captured.lock().unwrap().push(cmd);
        }
        call.resolve(serde_json::json!({ "ok": true }));
    });

    let mut options = app_options(host.clone());
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(cols, rows)).unwrap();
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    view.load(App::Rust(admin_root())).unwrap();
    (view, terminal, host, rx, commands)
}

fn draw_until(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &mpsc::Receiver<()>,
    needle: &str,
) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let snap = view.snapshot();
        if snap.contains(needle) {
            return snap;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {needle:?} in frame:
{snap}"
        );
        let _ = rx.recv_timeout(Duration::from_millis(30));
    }
}

fn send_key(view: &mut AppView, key: &str, shift: bool, ctrl: bool) {
    view.handle(Input::Key {
        key: key.to_owned(),
        modifiers: Modifiers {
            shift,
            ctrl,
            ..Modifiers::default()
        },
        release: false,
    });
}

fn click_button(view: &mut AppView, label: &str) {
    let cells = view.cells();
    let all = view.accessibility_snapshot();
    let node = all
        .iter()
        .find(|n| n.role == nsh_core::AccessibilityRole::Button && n.label == label)
        .unwrap_or_else(|| {
            let names: Vec<_> = all
                .iter()
                .map(|n| format!("{:?}:{:?}@{:?}", n.role, n.label, n.frame))
                .collect();
            panic!("button {label:?} not found; nodes: {names:#?}");
        });
    let col =
        ((node.frame.origin.x.0 + node.frame.size.width.0 * 0.5) / cells.width().0).floor() as u16;
    let row = ((node.frame.origin.y.0 + node.frame.size.height.0 * 0.5) / cells.height().0).floor()
        as u16;
    let mut down = MouseInput::default();
    down.kind = MouseKind::Down(MouseButton::Left);
    down.column = col;
    down.row = row;
    let mut up = MouseInput::default();
    up.kind = MouseKind::Up(MouseButton::Left);
    up.column = col;
    up.row = row;
    let h1 = view.handle(Input::Mouse(down));
    let h2 = view.handle(Input::Mouse(up));
    let line = view
        .snapshot()
        .lines()
        .nth(row as usize)
        .unwrap_or("")
        .to_owned();
    assert_eq!(
        h1,
        nsh_platform_tui::Handled::Yes,
        "down ignored on {label:?} at ({col},{row}) frame={:?} line={line:?}",
        node.frame
    );
    assert_eq!(
        h2,
        nsh_platform_tui::Handled::Yes,
        "up ignored on {label:?} at ({col},{row}) frame={:?} line={line:?}",
        node.frame
    );
    assert!(
        line.contains(label),
        "click row {row} col {col} frame={:?} line={line:?} did not contain {label:?}",
        node.frame
    );
}

#[test]
fn renders_all_tabs_overlays_and_dispatches_commands() {
    let (mut view, mut terminal, host, rx, commands) = mount_surface(120, 36);
    host.send("snapshot", serde_json::to_value(sample_snapshot()).unwrap())
        .unwrap();
    host.send("logs", serde_json::to_value(sample_logs()).unwrap())
        .unwrap();

    // 1. Overview
    let overview = draw_until(&mut view, &mut terminal, &rx, "MAKA ADMIN");
    assert!(
        overview.contains("Default Host"),
        "overview:
{overview}"
    );
    assert!(
        overview.contains("42190"),
        "overview:
{overview}"
    );
    assert!(
        overview.contains("Recent Activity"),
        "overview:
{overview}"
    );
    assert!(overview.contains(":3443"), "overview:\n{overview}");

    // 2. Hosts tab via '2'
    send_key(&mut view, "2", false, false);
    let hosts = draw_until(&mut view, &mut terminal, &rx, "State Roots (2)");
    assert!(
        hosts.contains("Published Endpoints"),
        "hosts:
{hosts}"
    );
    assert!(
        hosts.contains("Managed Deployment & Service"),
        "hosts:
{hosts}"
    );

    // Switch host via Down arrow -> dispatches SelectHost
    send_key(&mut view, "ArrowDown", false, false);
    let deadline = Instant::now() + Duration::from_secs(2);
    while commands.lock().unwrap().is_empty() && Instant::now() < deadline {
        terminal.draw(|f| view.render(f, f.area())).unwrap();
        let _ = rx.recv_timeout(Duration::from_millis(20));
    }
    assert!(
        commands
            .lock()
            .unwrap()
            .iter()
            .any(|c| matches!(c, AdminCommand::SelectHost { .. })),
        "expected SelectHost command"
    );

    // 3. Relay tab via '3'
    send_key(&mut view, "3", false, false);
    let relay = draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Local Self-Hosted Relay Server",
    );
    assert!(
        relay.contains("https://relay.internal:3443/"),
        "relay:
{relay}"
    );

    // 4. Access tab via '4'
    send_key(&mut view, "4", false, false);
    let access = draw_until(&mut view, &mut terminal, &rx, "Authorized Native Peers (1)");
    assert!(
        access.contains("M4n5ter iPhone"),
        "access:
{access}"
    );
    assert!(
        access.contains("inv_demo_999"),
        "access:
{access}"
    );

    // 5. Logs tab via '5'
    send_key(&mut view, "5", false, false);
    let logs = draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "rejected expired pairing token",
    );
    assert!(
        logs.contains("Follow: ON"),
        "logs:
{logs}"
    );

    // 6. System tab via '6'
    send_key(&mut view, "6", false, false);
    let system = draw_until(&mut view, &mut terminal, &rx, "Build & Release Channel");
    assert!(
        system.contains("Session Audit Trail"),
        "system:
{system}"
    );

    // 7. Command Palette via Ctrl+P, then Escape closes it
    send_key(&mut view, "p", false, true);
    let palette = draw_until(&mut view, &mut terminal, &rx, "Command Palette");
    assert!(
        palette.contains("Refresh All Hosts"),
        "palette:
{palette}"
    );

    send_key(&mut view, "Escape", false, false);
    draw_until(&mut view, &mut terminal, &rx, "Build & Release Channel");

    // 8. Help overlay via '?' (shift + /), then Escape
    send_key(&mut view, "/", true, false);
    let help = draw_until(&mut view, &mut terminal, &rx, "Keyboard Shortcuts");
    assert!(help.contains("Quit Maka Admin"), "help:\n{help}");
    send_key(&mut view, "Escape", false, false);

    // 8b. Switch back to Default Host and click Stop -> Confirm dialog, Escape cancels without StopHost
    send_key(&mut view, "ArrowUp", false, false);
    send_key(&mut view, "1", false, false);
    draw_until(&mut view, &mut terminal, &rx, "Active Host · Default Host");
    click_button(&mut view, "Stop");
    let confirm = draw_until(&mut view, &mut terminal, &rx, "Stop managed Host?");
    assert!(confirm.contains("Cancel"), "confirm:\n{confirm}");
    assert!(confirm.contains("Stop Host"), "confirm:\n{confirm}");
    send_key(&mut view, "Escape", false, false);
    draw_until(&mut view, &mut terminal, &rx, "Recent Activity");
    assert!(
        !commands
            .lock()
            .unwrap()
            .iter()
            .any(|c| matches!(c, AdminCommand::StopHost { .. })),
        "canceling confirm dialog must not dispatch StopHost"
    );

    // 9. Quit via 'q'
    send_key(&mut view, "q", false, false);
    let quit_deadline = Instant::now() + Duration::from_secs(2);
    while !view.exit_requested() && Instant::now() < quit_deadline {
        terminal.draw(|f| view.render(f, f.area())).unwrap();
        let _ = rx.recv_timeout(Duration::from_millis(20));
    }
    assert!(view.exit_requested(), "pressing q should request exit");
}

#[test]
fn compact_viewport_folds_sidebar_cleanly() {
    let (mut view, mut terminal, host, rx, _commands) = mount_surface(82, 26);
    host.send("snapshot", serde_json::to_value(sample_snapshot()).unwrap())
        .unwrap();
    let frame = draw_until(&mut view, &mut terminal, &rx, "MAKA ADMIN");
    assert!(
        frame.contains("1 Overview"),
        "compact frame:
{frame}"
    );
    assert!(
        frame.contains("Default Host"),
        "compact frame:
{frame}"
    );
}

#[tokio::test]
async fn relay_manager_binds_and_shuts_down_http_and_self_signed_https() {
    let mut mgr = RelayManager::default();
    assert!(matches!(mgr.state(), LocalRelayState::Stopped));

    // 1. Plain HTTP on ephemeral port
    let http_rt = mgr
        .start(LocalRelayConfig {
            http_addr: "127.0.0.1:0".to_owned(),
            https_addr: String::new(),
            quic_addr: String::new(),
            tls_mode: RelayTlsMode::None,
            tls_sans: String::new(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
        })
        .await
        .expect("start plain HTTP relay");
    assert!(http_rt.http_addr.is_some());
    assert!(http_rt.endpoint_url.starts_with("http://127.0.0.1:"));
    assert!(matches!(mgr.state(), LocalRelayState::Running(_)));

    // 2. Self-signed HTTPS with Bearer token on ephemeral port
    let token = mgr.set_generated_token();
    assert_eq!(token.len(), 64);
    let https_rt = mgr
        .start(LocalRelayConfig {
            http_addr: String::new(),
            https_addr: "127.0.0.1:0".to_owned(),
            quic_addr: String::new(),
            tls_mode: RelayTlsMode::SelfSigned,
            tls_sans: "localhost,127.0.0.1".to_owned(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: token,
        })
        .await
        .expect("start self-signed HTTPS relay");
    assert!(https_rt.https_addr.is_some());
    assert!(https_rt.cert_sha256.as_ref().is_some_and(|s| s.len() == 64));
    assert!(https_rt.has_auth_token);

    mgr.stop().await;
    assert!(matches!(mgr.state(), LocalRelayState::Stopped));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_plane_handles_live_relay_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let host = HostChannel::new();
    let control = ControlPlane::start(
        ControlPlaneConfig {
            extra_root: Some(temp.path().to_path_buf()),
            preferred_root_id: None,
            maka_binary: PathBuf::from("maka"),
            refresh_interval: Duration::from_secs(30),
        },
        host.clone(),
        &tokio::runtime::Handle::current(),
    );

    // Mount headless view to confirm real ControlPlane <-> NSH HostChannel end-to-end
    let (tx, rx) = mpsc::channel();
    let mut options = app_options(host);
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal.draw(|f| view.render(f, f.area())).unwrap();
    view.load(App::Rust(admin_root())).unwrap();

    let frame = draw_until(&mut view, &mut terminal, &rx, "Synced");
    assert!(frame.contains("MAKA ADMIN"), "live frame:\n{frame}");

    // Press '3' to go to Relay, start a real local Relay via UI button, verify Running, then stop it
    send_key(&mut view, "3", false, false);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Local Self-Hosted Relay Server",
    );

    // First verify Configure… modal opens via click, then Esc, then Start Local Relay
    click_button(&mut view, "Configure…");
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Configure Local Self-Hosted Relay",
    );
    send_key(&mut view, "Escape", false, false);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Local Self-Hosted Relay Server",
    );

    click_button(&mut view, "Start Local Relay");
    let running = draw_until(&mut view, &mut terminal, &rx, "Stop Relay");
    assert!(
        running.contains("Endpoint URL"),
        "running relay frame:\n{running}"
    );

    click_button(&mut view, "Stop Relay");
    draw_until(&mut view, &mut terminal, &rx, "Start Local Relay");

    control.shutdown().await;
}
