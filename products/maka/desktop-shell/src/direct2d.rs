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

//! The Windows workbench in a Direct2D window, with one admitted Host
//! (or a WSL Host reconnected in-place inside the same window).

use crate::{
    host::{self, Connection},
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
    wsl_stdio,
};
use maka_workbench::{
    bindings::Bindings,
    reload::{Request, UiReload},
};
use nsh_core::{
    desktop::{MenuRole, WindowAttributes},
    element::{Root, desktop},
    prelude::*,
};
use nsh_engine::JsonValue;
use nsh_platform_windows::{AppOptions, AppView, quit_app, run_app_with_config, with_running_view};
use std::time::{Duration, Instant};
use tokio::{
    runtime::{Handle, Runtime},
    sync::{mpsc, oneshot, watch},
};

const FIRST_PAUSE: Duration = Duration::from_secs(1);
const RECONNECT_LIMIT: Duration = Duration::from_secs(30);
const STEADY: Duration = Duration::from_secs(60);

struct WslReconnect {
    errors: watch::Receiver<Option<String>>,
}

#[component]
fn WslReconnectView() -> impl IntoElement {
    let reconnect = engine_context::<WslReconnect>().expect("WSL reconnect view context");
    let mut errors = reconnect.errors.clone();
    let error = signal(errors.borrow_and_update().clone());
    spawn(async move {
        while errors.changed().await.is_ok() {
            error.set(errors.borrow_and_update().clone());
        }
    });
    let locale = locale();
    let (connecting, unavailable, quit) = match locale.language() {
        "zh" if locale.as_str().contains("-Hant")
            || matches!(locale.region(), Some("TW" | "HK" | "MO")) =>
        {
            (
                "正在重新連線到 WSL Host…",
                "無法連線到 WSL Host。Maka 會自動重試。",
                "結束 Maka",
            )
        }
        "zh" => (
            "正在重新连接 WSL Host…",
            "无法连接 WSL Host。Maka 会自动重试。",
            "退出 Maka",
        ),
        _ => (
            "Reconnecting to the WSL Host…",
            "Could not connect to the WSL Host. Maka will retry automatically.",
            "Quit Maka",
        ),
    };
    desktop::set_application_menu(vec![desktop::MenuItem::submenu(
        TITLE,
        [desktop::MenuItem::role(MenuRole::Quit)
            .label(quit)
            .shortcut("ctrl+q")],
    )]);
    let mut attrs = WindowAttributes::default();
    attrs.title = Some(TITLE.into());
    attrs.title_bar = Some(Default::default());
    attrs.min_size = Some(Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1))));
    attrs.close_on_press = Some(true);
    attrs.close_on_escape = Some(false);
    attrs.close_on_blur = Some(false);
    let body = move || {
        view()
            .h_full()
            .p_6()
            .flex()
            .flex_col()
            .gap_2()
            .justify_center()
            .items_center()
            .child(
                text(move || {
                    if error.get().is_some() {
                        unavailable
                    } else {
                        connecting
                    }
                })
                .text_lg()
                .text_color(AdaptiveColor::rgb(0x171717, 0xf5f5f5)),
            )
            .child(when(
                move || error.get().is_some(),
                move || {
                    text(move || error.get().unwrap_or_default())
                        .selectable(true)
                        .text_center()
                        .text_color(AdaptiveColor::rgb(0x525252, 0xa3a3a3))
                },
            ))
    };
    if engine_context::<nsh_engine::EmbeddedHost>().is_some() {
        desktop::current_window().set(attrs);
        body().into_element()
    } else {
        desktop::window()
            .id("main")
            .attributes(attrs)
            .restore_bounds(true)
            .content(body)
            .into_element()
    }
}

fn wsl_reconnect_config(
    errors: watch::Receiver<Option<String>>,
    data_dir: Option<std::path::PathBuf>,
) -> nsh_engine::EngineConfig {
    let mut config = nsh_engine::EngineConfig::new(Root::of::<WslReconnectView>());
    config.context = config.context.with(WslReconnect { errors });
    config.data_dir = data_dir;
    config
}

pub(crate) fn start(target: crate::Target) -> Result<(), String> {
    use maka_host_runtime::application::host::Client as HostClient;
    let root = maka_event_log::root::resolve(&target.root).map_err(|error| error.to_string())?;
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    let first = runtime.block_on(async {
        let host = HostClient::connect(&target.endpoint, Some(target.epoch)).await?;
        host::Connection::admit(host, root.canonical_path(), Handle::current()).await
    })?;
    run(
        first,
        root.canonical_path().to_path_buf(),
        target.endpoint,
        target.epoch,
        runtime,
    )
}

fn run(
    first: Connection,
    root: std::path::PathBuf,
    endpoint: std::path::PathBuf,
    epoch: uuid::Uuid,
    runtime: Runtime,
) -> Result<(), String> {
    let Connection { bindings, config } = first;
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    let (_active_host_tx, active_host_rx) = watch::channel((endpoint, epoch));
    let (updating_tx, updating_rx) = watch::channel(false);
    let updater = crate::updater::Controller::new(
        root,
        active_host_rx,
        updating_tx,
        shell.exit_sender(),
        shell.events.clone(),
        runtime.handle().clone(),
    );
    let updater_exit = std::sync::Arc::clone(&updater);
    let shell = shell.with_updater(updater);
    let reloading = config
        .context
        .get::<UiReload>()
        .expect("the admitted workbench owns its UI reload channel")
        .take_requests();
    carry_out(requests, &runtime);
    refuse_reloads(reloading, runtime.handle());
    let result = run_app_with_config(shell.attach(config), window_options(), move |is_active| {
        active.send_replace(is_active);
    });
    updater_exit.wait_for_in_flight_swap();
    if !*updating_rx.borrow() {
        runtime.block_on(host::quit(bindings));
    }
    runtime.shutdown_background();
    if result == std::process::ExitCode::SUCCESS {
        Ok(())
    } else {
        Err("the Direct2D window failed".into())
    }
}

pub(crate) fn run_wsl(
    first: wsl_stdio::Session,
    target: wsl_stdio::Target,
    runtime: Runtime,
) -> Result<(), String> {
    let wsl_stdio::Session {
        connection: Connection { bindings, config },
        bridge,
        disconnected,
        root,
    } = first;
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    let Requests {
        exits,
        mut folders,
        mut text_sizes,
    } = requests;
    runtime.spawn(async move {
        while let Some(call) = folders.recv().await {
            call.reject("the Windows folder dialog cannot choose Linux paths for a WSL Host");
        }
    });
    runtime.spawn(async move {
        while let Some(scale) = text_sizes.recv().await {
            with_running_view(move |view| view.set_font_scale(Some(scale)));
        }
    });
    let reloading = config
        .context
        .get::<UiReload>()
        .expect("the admitted workbench owns its UI reload channel")
        .take_requests();
    refuse_reloads(reloading, runtime.handle());
    let data_dir = config.data_dir.clone();
    let initial = shell.attach(config);
    let (closed_tx, closed_rx) = watch::channel(false);
    let following = runtime.spawn(follow_wsl(
        bindings,
        bridge,
        disconnected,
        root,
        data_dir,
        target,
        shell,
        exits,
        closed_rx,
        runtime.handle().clone(),
    ));
    let result = run_app_with_config(initial, window_options(), move |is_active| {
        active.send_replace(is_active);
    });
    // Only reached if the Direct2D UI thread failed to start; normal shutdown exits
    // inside `run_app_with_config` after `follow_wsl` completes quit + bridge cleanup.
    let _ = closed_tx.send(true);
    let _ = runtime.block_on(following);
    runtime.shutdown_background();
    if result == std::process::ExitCode::SUCCESS {
        Ok(())
    } else {
        Err("the Direct2D window failed".into())
    }
}

fn window_options() -> AppOptions {
    let components = nsh_platform_windows::Components::default();
    crate::screenshot_windows::stage::register(&components);
    AppOptions {
        components,
        app_id: APP_ID.into(),
        title: TITLE.into(),
        size: SIZE,
        min_size: Some((MIN_SIZE.0 as i32, MIN_SIZE.1 as i32)),
        notifications: true,
        ..Default::default()
    }
}

async fn wait_for_exit(
    exits: &mut mpsc::UnboundedReceiver<()>,
    window_closed: &mut watch::Receiver<bool>,
) {
    if *window_closed.borrow() {
        return;
    }
    tokio::select! {
        _ = exits.recv() => {}
        _ = window_closed.wait_for(|closed| *closed) => {}
    }
}

async fn ensure_window_started(
    window_started: &mut bool,
    exits: &mut mpsc::UnboundedReceiver<()>,
    window_closed: &mut watch::Receiver<bool>,
) -> bool {
    while !*window_started {
        let (ready_tx, ready_rx) = oneshot::channel();
        with_running_view(move |_| {
            let _ = ready_tx.send(());
        });
        if ready_rx.await.is_ok() {
            *window_started = true;
            return true;
        }
        tokio::select! {
            biased;
            _ = wait_for_exit(exits, window_closed) => return false,
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
    true
}

async fn run_on_view(
    window_started: &mut bool,
    exits: &mut mpsc::UnboundedReceiver<()>,
    window_closed: &mut watch::Receiver<bool>,
    action: impl FnOnce(&AppView) + Send + 'static,
) -> bool {
    if !ensure_window_started(window_started, exits, window_closed).await {
        return false;
    }
    let (done_tx, done_rx) = oneshot::channel();
    with_running_view(move |view| {
        action(view);
        let _ = done_tx.send(());
    });
    done_rx.await.is_ok()
}

#[allow(clippy::too_many_arguments)]
async fn follow_wsl(
    bindings: Bindings,
    bridge: wsl_stdio::Bridge,
    mut disconnected: oneshot::Receiver<()>,
    expected_root: String,
    mut data_dir: Option<std::path::PathBuf>,
    target: wsl_stdio::Target,
    shell: Shell,
    mut exits: mpsc::UnboundedReceiver<()>,
    mut window_closed: watch::Receiver<bool>,
    runtime: Handle,
) {
    let mut bindings = Some(bindings);
    let mut bridge = Some(bridge);
    let mut window_started = false;
    let mut pause = FIRST_PAUSE;
    'connected: loop {
        let reached = Instant::now();
        let quit = tokio::select! {
            biased;
            _ = wait_for_exit(&mut exits, &mut window_closed) => true,
            _ = &mut disconnected => false,
        };
        if quit {
            break 'connected;
        }
        let (report_error, errors) = watch::channel(None);
        let reconnect_data_dir = data_dir.clone();
        if !run_on_view(
            &mut window_started,
            &mut exits,
            &mut window_closed,
            move |view| {
                view.load_with_config(wsl_reconnect_config(errors, reconnect_data_dir));
            },
        )
        .await
        {
            break 'connected;
        }
        if let Some(old_bindings) = bindings.take() {
            match tokio::time::timeout(host::DETACH_LIMIT, old_bindings.close()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("maka-desktop-shell: WSL Host detach: {error}"),
                Err(_) => eprintln!("maka-desktop-shell: WSL Host detach timed out"),
            }
        }
        if let Some(old_bridge) = bridge.take() {
            old_bridge.close().await;
        }
        let mut wait = reached.elapsed() < STEADY;
        if !wait {
            pause = FIRST_PAUSE;
        }
        let next = loop {
            if wait {
                tokio::select! {
                    biased;
                    _ = wait_for_exit(&mut exits, &mut window_closed) => break 'connected,
                    _ = tokio::time::sleep(pause) => {}
                }
                pause = (pause * 2).min(RECONNECT_LIMIT);
            }
            wait = true;
            let attempt = tokio::select! {
                biased;
                _ = wait_for_exit(&mut exits, &mut window_closed) => break 'connected,
                result = target.connect(Some(&expected_root)) => result,
            };
            match attempt {
                Ok(session) => break session,
                Err(error) => {
                    eprintln!("maka-desktop-shell: reconnecting WSL Host: {error}");
                    report_error.send_if_modified(|previous| {
                        if previous.as_ref() == Some(&error) {
                            return false;
                        }
                        *previous = Some(error);
                        true
                    });
                }
            }
        };
        let Connection {
            bindings: next_bindings,
            config,
        } = next.connection;
        let reloading = config
            .context
            .get::<UiReload>()
            .expect("the admitted workbench owns its UI reload channel")
            .take_requests();
        refuse_reloads(reloading, &runtime);
        data_dir = config.data_dir.clone();
        let attached = shell.attach(config);
        if !run_on_view(
            &mut window_started,
            &mut exits,
            &mut window_closed,
            move |view| {
                view.load_with_config(attached);
            },
        )
        .await
        {
            let _ = tokio::time::timeout(host::DETACH_LIMIT, next_bindings.close()).await;
            next.bridge.close().await;
            break 'connected;
        }
        bindings = Some(next_bindings);
        bridge = Some(next.bridge);
        disconnected = next.disconnected;
    }
    let (stopped_tx, stopped_rx) = oneshot::channel();
    with_running_view(move |view| {
        view.stop();
        let _ = stopped_tx.send(());
    });
    let _ = stopped_rx.await;
    if let Some(bindings) = bindings.take()
        && tokio::time::timeout(host::DETACH_LIMIT, host::quit(bindings))
            .await
            .is_err()
    {
        eprintln!("maka-desktop-shell: WSL Host quit timed out");
    }
    if let Some(bridge) = bridge.take() {
        bridge.close().await;
    }
    quit_app();
}

fn carry_out(requests: Requests, runtime: &Runtime) {
    let Requests {
        mut exits,
        mut folders,
        mut text_sizes,
    } = requests;
    runtime.spawn(async move {
        if exits.recv().await.is_some() {
            quit_app();
        }
    });
    runtime.spawn(async move {
        while let Some(call) = folders.recv().await {
            choose_local_folder(call);
        }
    });
    runtime.spawn(async move {
        while let Some(scale) = text_sizes.recv().await {
            with_running_view(move |view| view.set_font_scale(Some(scale)));
        }
    });
}

pub(crate) fn choose_local_folder(call: nsh_engine::HostCall) {
    with_running_view(move |view| {
        view.choose_directory(move |path| match path {
            Ok(Some(path)) => match path.to_str() {
                Some(path) => call.resolve(JsonValue::from(path)),
                None => call.reject("the folder's path is not valid UTF-8"),
            },
            Ok(None) => call.resolve(JsonValue::Null),
            Err(error) => call.reject(error),
        });
    });
}

fn refuse_reloads(mut requests: tokio::sync::mpsc::UnboundedReceiver<Request>, runtime: &Handle) {
    runtime.spawn(async move {
        while let Some(request) = requests.recv().await {
            if let Request::Pause(ready) = request {
                let _ = ready.send(Err("the Direct2D window cannot reload its UI".into()));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const WM_CLOSE: u32 = 0x0010;

    #[component]
    fn WorkbenchChrome() -> impl IntoElement {
        use nsh_core::desktop::{TitleBarOptions, TitleBarStyle};
        let mut attrs = WindowAttributes::default();
        attrs.title = Some("Workbench chrome fixture".into());
        let mut title_bar = TitleBarOptions::default();
        title_bar.style = TitleBarStyle::Hidden;
        title_bar.height = Some(px(48.0));
        attrs.title_bar = Some(title_bar);
        attrs.close_on_press = Some(false);
        desktop::current_window().set(attrs);
        view()
    }

    #[test]
    fn wsl_reconnect_restores_native_window_close() {
        use nsh_platform_windows::windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetWindowTextW, IsWindow, MSG, PM_REMOVE, PeekMessageW,
            TranslateMessage,
        };

        fn pump_until(mut done: impl FnMut() -> bool, failure: &str) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(Instant::now() < deadline, "{failure}");
                // SAFETY: this test owns a Win32 message queue and its window on this thread.
                unsafe {
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        let window = AppView::new(
            None,
            AppOptions {
                title: "Before workbench chrome".into(),
                size: (400, 250),
                ..Default::default()
            },
        )
        .unwrap();
        let hwnd = window.hwnd();
        let has_title = |expected: &str| {
            let mut text = [0; 64];
            // SAFETY: hwnd belongs to this test window and the output is a local buffer.
            let length = unsafe { GetWindowTextW(hwnd, &mut text) };
            String::from_utf16_lossy(&text[..length as usize]) == expected
        };
        window.load_with_config(nsh_engine::EngineConfig::new(Root::of::<WorkbenchChrome>()));
        window.show();
        pump_until(
            || has_title("Workbench chrome fixture"),
            "workbench window attributes were not applied",
        );

        let (_errors, receiver) = watch::channel(None);
        window.load_with_config(wsl_reconnect_config(receiver, None));
        pump_until(
            || has_title(TITLE),
            "reconnect window attributes were not applied",
        );
        // SAFETY: post WM_CLOSE to the test's live window on this thread.
        assert_ne!(unsafe { post_message(hwnd.0, WM_CLOSE, 0, 0) }, 0);
        pump_until(
            // SAFETY: querying a Win32 window handle is valid even after its window is destroyed.
            || !unsafe { IsWindow(Some(hwnd)) }.as_bool(),
            "WM_CLOSE did not close the reconnect window",
        );
    }

    #[test]
    fn wsl_reconnect_restores_saved_window_placement() {
        use nsh_core::{
            ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem,
            desktop::{DesktopCommand, WindowEvent, WindowMode, WindowPlacement, WindowState},
            geometry::Bounds,
        };
        use nsh_engine::{Engine, Environment, Idiom, MountSink, Os};
        use std::sync::mpsc;

        struct ChannelSink(mpsc::Sender<MountBatch>);
        impl MountSink for ChannelSink {
            fn submit(&self, batch: MountBatch) {
                let _ = self.0.send(batch);
            }
        }

        let dir = std::env::temp_dir().join(format!(
            "maka-wsl-reconnect-bounds-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let saved = WindowPlacement::new(
            WindowMode::Normal,
            Bounds::new(point(px(150.0), px(200.0)), size(px(1000.0), px(700.0))),
        );
        let start_reconnect = |data_dir: std::path::PathBuf| {
            let (_errors, receiver) = watch::channel(None);
            let mut config = wsl_reconnect_config(receiver, Some(data_dir));
            config.environment = Environment {
                os: Os::Windows,
                idiom: Idiom::Desktop,
                ..Environment::default()
            };
            let (tx, rx) = mpsc::channel();
            let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let (node, open) = loop {
                let remain = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remain.is_zero(),
                    "WslReconnectView did not emit OpenWindow"
                );
                let batch = rx.recv_timeout(remain).expect("reconnect mount batch");
                if let Some(found) = batch.items.into_iter().find_map(|item| match item {
                    MountItem::Command {
                        id,
                        command: Command::Desktop(command),
                    } => match *command {
                        DesktopCommand::OpenWindow(open) if open.options.id == "main" => {
                            Some((id, open))
                        }
                        _ => None,
                    },
                    _ => None,
                }) {
                    break found;
                }
            };
            (engine, node, open)
        };
        {
            let (engine, node, open) = start_reconnect(dir.clone());
            assert!(open.options.restore_bounds);
            assert_eq!(
                open.options.attributes.min_size,
                Some(Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1))))
            );
            assert_eq!(open.placement, None);
            let state = WindowState::new(saved.bounds, saved);
            engine.control().dispatch_event(
                node,
                EventKind::Window,
                EventPayload::Window(Box::new(WindowEvent::State(Box::new(state)))),
            );
            let storage_file = dir.join("storage.json");
            let deadline = Instant::now() + Duration::from_secs(5);
            while !storage_file.exists() {
                assert!(
                    Instant::now() < deadline,
                    "reconnect window placement was not persisted"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            drop(engine);
        }
        let (engine, _node, open) = start_reconnect(dir.clone());
        assert_eq!(open.placement, Some(saved));
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        #[link_name = "PostMessageW"]
        fn post_message(hwnd: *mut std::ffi::c_void, msg: u32, wparam: usize, lparam: isize)
        -> i32;
    }

    #[test]
    fn terminal_exit_closes_the_hidden_native_window_with_close_on_press_disabled() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        let runtime = Runtime::new().unwrap();
        let (_active, foreground) = watch::channel(false);
        let (shell, requests) = Shell::new(foreground);
        carry_out(requests, &runtime);
        let mut policy = nsh_engine::Policy {
            declared: Some(nsh_engine::Capabilities::all()),
            ..nsh_engine::Policy::development()
        };
        policy
            .declared
            .get_or_insert_default()
            .host
            .extend(["terminal.exit", "test.ready", "test.hidden"].map(String::from));
        let bundle = nsh_engine::Bundle::source(
            r#"import { effect, host, mount, signal } from 'nsh';
                import { currentWindow } from 'nsh/desktop';
                mount(() => {
                    const main = currentWindow();
                    const closing = signal(false);
                    main.set({ closeOnPress: false });
                    main.on('closePress', () => { closing.set(true); main.hide(); });
                    effect(() => {
                        if (closing() && main.state()?.visible === false) {
                            host.post('test.hidden');
                            host.post('terminal.exit');
                        }
                    });
                    requestAnimationFrame(() => host.post('test.ready'));
                    return null;
                });
            "#
            .into(),
        )
        .with_policy(policy);
        let hidden = Arc::new(AtomicBool::new(false));
        let observed = hidden.clone();
        let config = shell.attach(nsh_engine::EngineConfig::new(bundle));
        let posted = Arc::new(AtomicBool::new(false));
        let close_posted = posted.clone();
        config.host.handle("test.ready", move |_| {
            let close_posted = close_posted.clone();
            with_running_view(move |view| {
                let target = view.active_window_hwnd().unwrap_or_else(|| view.hwnd());
                // SAFETY: the running view owns this live HWND; posting does not retain a Rust reference.
                let ok = unsafe { post_message(target.0, WM_CLOSE, 0, 0) };
                close_posted.store(ok != 0, Ordering::SeqCst);
            });
        });
        config.host.handle("test.hidden", move |_| {
            observed.store(true, Ordering::SeqCst);
        });
        let (done, finished) = mpsc::channel();
        let timed_out = Arc::new(AtomicBool::new(false));
        let timeout = timed_out.clone();
        let watchdog = std::thread::spawn(move || {
            if matches!(
                finished.recv_timeout(std::time::Duration::from_secs(30)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                timeout.store(true, Ordering::SeqCst);
                quit_app();
            }
        });
        let code = run_app_with_config(
            config,
            AppOptions {
                app_id: "org.apache.maka.direct2d-test".into(),
                title: "Direct2D exit bridge test".into(),
                size: (320, 240),
                ..Default::default()
            },
            |_| {},
        );
        let _ = done.send(());
        watchdog.join().unwrap();
        runtime.shutdown_background();
        assert!(
            !timed_out.load(Ordering::SeqCst),
            "terminal.exit did not close the native window"
        );
        assert!(
            posted.load(Ordering::SeqCst),
            "could not post the native close"
        );
        assert!(
            hidden.load(Ordering::SeqCst),
            "ordinary close did not hide the window"
        );
        assert_eq!(code, std::process::ExitCode::SUCCESS);
    }

    #[tokio::test]
    async fn reload_pause_gets_an_explicit_rejection() {
        let (send, recv) = tokio::sync::mpsc::unbounded_channel();
        refuse_reloads(recv, &Handle::current());
        let (ready, received) = tokio::sync::oneshot::channel();
        send.send(Request::Pause(ready)).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), received)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            Err("the Direct2D window cannot reload its UI".into())
        );
    }
}
