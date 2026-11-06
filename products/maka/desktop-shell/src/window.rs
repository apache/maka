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

//! The disposable workbench window and the process-owned Host connection.
//!
//! Closing releases the UI, not the admitted client. The tray reconstructs a
//! window from the retained configuration; only Quit detaches, then exits.
//! Host following continues with or without a window.

use crate::{
    host::{self, Connection, Root},
    placement::Placement,
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::bindings::Bindings;
use nsh_engine::{EngineConfig, JsonValue, Limits};
use nsh_platform_gpui::{
    AppOptions, AppView, CloseRequest,
    gpui::{self, App, AppContext as _, Focusable as _, SystemNotification, WindowHandle},
    titlebar_options,
};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tokio::{runtime::Handle, sync::watch};

#[cfg(target_os = "linux")]
use crate::tray_linux::{Event as TrayEvent, Tray};
#[cfg(target_os = "macos")]
use nsh_platform_macos::StatusMenu;

#[cfg(target_os = "macos")]
enum TrayEvent {
    Open,
    Quit,
}

/// The first pause between attempts to reach the Root's next Host.
const FIRST_PAUSE: Duration = Duration::from_secs(1);

/// The longest pause between attempts to reach the Root's next Host.
const RECONNECT_LIMIT: Duration = Duration::from_secs(30);
/// How long the window must have used a Host for the next one to be tried at
/// once after it stops.
const STEADY: Duration = Duration::from_secs(60);

/// Set and not empty on macOS, the shell opens this window instead of the
/// AppKit one.
#[cfg(target_os = "macos")]
const GPUI: &str = "MAKA_GPUI";

pub(crate) fn start(target: crate::Target) -> Result<(), String> {
    use maka_host_runtime::application::host::Client as HostClient;
    let root = Root::find(target.root, target.launcher)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    let first = runtime.block_on(async {
        let host = HostClient::connect(&target.endpoint, Some(target.epoch)).await?;
        Connection::admit(
            host,
            target.endpoint,
            root.path(),
            tokio::runtime::Handle::current(),
        )
        .await
    })?;
    #[cfg(target_os = "macos")]
    if std::env::var_os(GPUI).is_none_or(|value| value.is_empty()) {
        return crate::appkit::run(first, runtime);
    }
    run(first, root, runtime)
}

/// Runs the workbench on `first` in its window until the app quits.
pub fn run(first: Connection, root: Root, runtime: tokio::runtime::Runtime) -> Result<(), String> {
    let Connection {
        bindings,
        config,
        endpoint,
        epoch,
    } = first;
    let directory = config
        .data_dir
        .as_ref()
        .expect("Host admission sets the client directory");
    let handle = runtime.handle().clone();
    let detach = Detach::new(bindings, (endpoint.clone(), epoch), runtime);
    let (active, foreground) = watch::channel(false);
    let (
        shell,
        Requests {
            mut exits,
            mut folders,
            mut text_sizes,
            mut notices,
        },
    ) = Shell::new(foreground);
    let placement = Placement::new(directory);
    let mut start = Some((config, placement, endpoint, epoch, root));
    // Quitting waits for the detach: GPUI's default quits Linux and Windows
    // apps as their last window closes, giving the detach no more than its
    // quit handlers' 200 ms.
    let (tray_events, mut tray_requests) = tokio::sync::mpsc::unbounded_channel();
    let reopening = tray_events.clone();
    let application = gpui_platform::application().with_quit_mode(gpui::QuitMode::Explicit);
    application.on_reopen(move |_| {
        let _ = reopening.send(TrayEvent::Open);
    });
    application.run(move |cx| {
        cx.set_app_identity(APP_ID, TITLE);
        let (config, placement, endpoint, epoch, root) = start.take().expect("the app starts once");
        #[cfg(target_os = "linux")]
        let tray = Tray::start(handle.clone(), tray_events);
        #[cfg(target_os = "macos")]
        let tray = {
            let open = tray_events.clone();
            StatusMenu::new(
                TITLE,
                move || {
                    let _ = open.send(TrayEvent::Open);
                },
                move || {
                    let _ = tray_events.send(TrayEvent::Quit);
                },
            )
        };
        // Keep the pristine configuration before constructing any UI. Each
        // window gets its own HostChannel, engine and registry instances.
        let desktop = Rc::new(RefCell::new(Desktop {
            config: config.clone(),
            window: None,
            quitting: false,
            paused: false,
            placement: Rc::new(placement),
            shell: shell.clone(),
            active,
            tray,
        }));
        if let Err(error) = Desktop::show(&desktop, cx) {
            eprintln!("maka-desktop-shell: cannot open a window: {error}");
            detach.then_quit(cx);
        }
        let current = ConnectedHost::new((endpoint, epoch), config);
        let commands = desktop.clone();
        cx.spawn(async move |cx| {
            while let Some(event) = tray_requests.recv().await {
                cx.update(|cx| match event {
                    TrayEvent::Quit => cx.quit(),
                    TrayEvent::Open => Desktop::present(&commands, cx),
                    #[cfg(target_os = "linux")]
                    TrayEvent::Unavailable => {
                        if commands.borrow().window.is_none() {
                            Desktop::present(&commands, cx);
                        }
                    }
                });
            }
        })
        .detach();
        cx.spawn(async move |cx| {
            while exits.recv().await.is_some() {
                cx.update(|cx| cx.quit());
            }
        })
        .detach();
        // Native Quit (including Dock/log-out on macOS) must not bypass
        // the bounded detach through GPUI's 200 ms shutdown observers.
        let quitting = detach.clone();
        let saving = desktop.clone();
        cx.on_request_quit(move |cx| {
            if quitting.finished() {
                return true;
            }
            saving.borrow_mut().quitting = true;
            Desktop::save(&saving, cx);
            quitting.then_quit(cx);
            false
        })
        .expect("the desktop owns quit admission");
        let closed = desktop.clone();
        cx.on_window_closed(move |cx, _| {
            if cx.windows().is_empty() {
                let mut state = closed.borrow_mut();
                state.window = None;
                state.active.send_replace(false);
                state.shell.release();
            }
        })
        .detach();
        // The workbench's folder choices open the system's folder dialog, one
        // at a time; a cancelled dialog answers null.
        cx.spawn(async move |cx| {
            while let Some(call) = folders.recv().await {
                let paths = cx.update(|cx| {
                    cx.prompt_for_paths(gpui::PathPromptOptions {
                        files: false,
                        directories: true,
                        multiple: false,
                        prompt: None,
                    })
                });
                let path = match paths.await {
                    Ok(Ok(paths)) => paths.and_then(|paths| paths.into_iter().next()),
                    Ok(Err(error)) => {
                        call.reject(error.to_string());
                        continue;
                    }
                    Err(error) => {
                        call.reject(error.to_string());
                        continue;
                    }
                };
                match path {
                    Some(path) => match path.to_str() {
                        Some(path) => call.resolve(JsonValue::from(path)),
                        None => call.reject("the folder's path is not valid UTF-8"),
                    },
                    None => call.resolve(JsonValue::Null),
                }
            }
        })
        .detach();
        let scaling = desktop.clone();
        cx.spawn(async move |cx| {
            while let Some(scale) = text_sizes.recv().await {
                if let Some(window) = scaling.borrow().window {
                    let _ = window.update(cx, |view, _, cx| view.set_font_scale(Some(scale), cx));
                }
            }
        })
        .detach();
        // The workbench's notifications (a conversation finished or waits
        // while the window is in the background) go to the system's
        // notification center; choosing one brings the window back and
        // tells the workbench which conversation to show.
        cx.spawn(async move |cx| {
            while let Some(notice) = notices.recv().await {
                let text = |key: &str| notice.data()[key].as_str().map(str::to_owned);
                match (text("tag"), text("title"), text("body")) {
                    (Some(tag), Some(title), Some(body)) => {
                        cx.update(|cx| {
                            cx.show_system_notification(SystemNotification {
                                tag: tag.into(),
                                title: title.into(),
                                body: body.into(),
                                actions: Vec::new(),
                            })
                        });
                        notice.resolve(JsonValue::Null);
                    }
                    _ => notice.reject("expected a tag, a title and a body"),
                }
            }
        })
        .detach();
        let events = shell.events.clone();
        let notified = desktop.clone();
        cx.on_system_notification_response(move |response, cx| {
            Desktop::present(&notified, cx);
            let host = events.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(host) = host {
                let _ = host.send(
                    "notification.open",
                    serde_json::json!({ "tag": response.tag.to_string() }),
                );
            }
        });
        follow(desktop, current, root, handle.clone(), &detach, cx);
        cx.activate(true);
    });
    Ok(())
}

fn open(
    config: EngineConfig,
    placement: Rc<Placement>,
    desktop: Rc<RefCell<Desktop>>,
    cx: &mut App,
) -> Result<WindowHandle<AppView>, String> {
    let min = gpui::size(gpui::px(MIN_SIZE.0), gpui::px(MIN_SIZE.1));
    // Where the window last closed, or centered on the main display.
    let (display_id, bounds) = match placement.restore(min, cx) {
        Some((display, bounds)) => (Some(display), bounds),
        None => {
            let size = gpui::size(gpui::px(SIZE.0 as f32), gpui::px(SIZE.1 as f32));
            let bounds = gpui::Bounds::centered(None, size, cx);
            (None, gpui::WindowBounds::Windowed(bounds))
        }
    };
    let options = gpui::WindowOptions {
        window_bounds: Some(bounds),
        display_id,
        titlebar: Some(titlebar_options(TITLE)),
        app_id: Some(APP_ID.into()),
        window_min_size: Some(min),
        // Linux: the window manager's decorations until the app hides the
        // title bar.
        window_decorations: Some(gpui::WindowDecorations::Server),
        // Animations keep the display's rate while another window has the keyboard.
        inactive_frame_interval: None,
        ..Default::default()
    };
    let data_dir = config.data_dir.clone();
    cx.open_window(options, move |window, cx| {
        let view = cx.new(|cx| {
            AppView::new(
                AppOptions {
                    app_id: APP_ID.into(),
                    title: TITLE.into(),
                    size: SIZE,
                    // The workbench is compiled into this trusted executable.
                    limits: Limits::standalone(),
                    data_dir,
                    ..Default::default()
                },
                window,
                cx,
            )
        });
        let moved = placement.clone();
        view.update(cx, |_, cx| {
            cx.observe_window_bounds(window, move |_, window, _| moved.follow(window))
                .detach();
        });
        let app = view.read(cx);
        app.own_window(window, cx);
        app.on_close_request(move |request, window, cx| match request {
            CloseRequest::Quit => {
                placement.save(window, cx);
                cx.quit();
            }
            _ => {
                let mut state = desktop.borrow_mut();
                if state.can_close() {
                    placement.save(window, cx);
                    state.window = None;
                    state.active.send_replace(false);
                    state.shell.release();
                    drop(state);
                    window.remove_window();
                }
            }
        });
        app.load_with_config(config);
        let focus = view.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        view
    })
    .map_err(|error| error.to_string())
}

struct Desktop {
    config: EngineConfig,
    window: Option<WindowHandle<AppView>>,
    quitting: bool,
    paused: bool,
    placement: Rc<Placement>,
    shell: Shell,
    active: watch::Sender<bool>,
    #[cfg(target_os = "linux")]
    tray: Tray,
    #[cfg(target_os = "macos")]
    tray: StatusMenu,
}

impl Desktop {
    fn can_close(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.tray.ready()
        }
        #[cfg(target_os = "macos")]
        {
            let _ = &self.tray;
            true
        }
    }

    fn show(this: &Rc<RefCell<Self>>, cx: &mut App) -> Result<(), String> {
        if this.borrow().quitting {
            return Ok(());
        }
        if let Some(window) = this.borrow().window {
            let _ = window.update(cx, |_, window, _| window.activate_window());
            return Ok(());
        }
        let (config, placement, active) = {
            let state = this.borrow();
            let mut config = state.config.clone();
            config.host = nsh_engine::HostChannel::new();
            (
                state.shell.attach(config),
                state.placement.clone(),
                state.active.clone(),
            )
        };
        let window = match open(config, placement, this.clone(), cx) {
            Ok(window) => window,
            Err(error) => {
                this.borrow().shell.release();
                return Err(error);
            }
        };
        this.borrow_mut().window = Some(window);
        let paused = this.borrow().paused;
        let _ = window.update(cx, |view, window, cx| {
            if paused {
                view.pause_input(window, cx, |_| {});
            }
            active.send_replace(window.is_window_active());
            cx.observe_window_activation(window, move |_, window, _| {
                active.send_replace(window.is_window_active());
            })
            .detach();
        });
        Ok(())
    }

    fn present(this: &Rc<RefCell<Self>>, cx: &mut App) {
        if let Err(error) = Self::show(this, cx) {
            eprintln!("maka-desktop-shell: cannot reopen the workbench: {error}");
        }
        cx.activate(true);
    }

    fn save(this: &Rc<RefCell<Self>>, cx: &mut App) {
        let state = this.borrow();
        if let Some(window) = state.window {
            let _ = window.update(cx, |_, window, cx| state.placement.save(window, cx));
        }
    }

    fn reload(&self, cx: &mut App) {
        if let Some(window) = self.window {
            let mut config = self.config.clone();
            config.host = nsh_engine::HostChannel::new();
            let config = self.shell.attach(config);
            let _ = window.update(cx, |view, window, cx| {
                view.load_with_config(config);
                window.focus(&view.focus_handle(cx), cx);
            });
        }
    }
}

struct ConnectedHost {
    host: (PathBuf, uuid::Uuid),
    config: EngineConfig,
    reloading: tokio::sync::mpsc::UnboundedReceiver<maka_workbench::reload::Request>,
}

impl ConnectedHost {
    fn new(host: (PathBuf, uuid::Uuid), config: EngineConfig) -> Self {
        let reloading = config
            .context
            .get::<maka_workbench::reload::UiReload>()
            .expect("the admitted workbench owns its UI reload channel")
            .take_requests();
        Self {
            host,
            config,
            reloading,
        }
    }
}

/// Keeps the window's client on a running Host: once the one at `host`
/// stops, connects to the Root's next Host (retrying with growing pauses)
/// and loads the workbench again on it. The workbench starts over, as it
/// does when the desktop opens.
fn follow(
    desktop: Rc<RefCell<Desktop>>,
    mut current: ConnectedHost,
    root: Root,
    runtime: Handle,
    detach: &Detach,
    cx: &mut App,
) {
    let detach = detach.clone();
    cx.spawn(async move |cx| {
        let mut pause = FIRST_PAUSE;
        loop {
            let reached = Instant::now();
            let (endpoint, epoch) = current.host.clone();
            let mut stopped = runtime.spawn(host::stopped(endpoint, epoch));
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    request = current.reloading.recv() => {
                        let Some(request) = request else { return };
                        cx.update(|cx| {
                            let mut state = desktop.borrow_mut();
                            match request {
                                maka_workbench::reload::Request::Pause(ready) => {
                                    state.paused = true;
                                    if let Some(window) = state.window {
                                        let _ = window.update(cx, |view, window, cx| {
                                            view.pause_input(window, cx, move |result| { let _ = ready.send(result); });
                                        });
                                    } else {
                                        let _ = ready.send(Ok(()));
                                    }
                                }
                                maka_workbench::reload::Request::Resume => {
                                    state.paused = false;
                                    if let Some(window) = state.window {
                                        let _ = window.update(cx, |view, window, cx| view.resume_input(window, cx));
                                    }
                                }
                                maka_workbench::reload::Request::Reload => {
                                    state.paused = false;
                                    state.reload(cx);
                                }
                            }
                        });
                    }
                }
            }
            // The client closes first, as when the desktop is reopened: what
            // it leaves in its journal is settled before the next client
            // opens the journal.
            let Some((stale, moving)) = detach.take() else {
                return;
            };
            let _ = detach.close(stale).await;
            drop(moving);
            // A Host that stopped soon after the window reached it is not
            // tried again at once: the pauses keep growing from the last one.
            let mut wait = reached.elapsed() < STEADY;
            if !wait {
                pause = FIRST_PAUSE;
            }
            let (connection, moving) = loop {
                if wait {
                    cx.background_executor().timer(pause).await;
                    pause = (pause * 2).min(RECONNECT_LIMIT);
                }
                wait = true;
                let Some(moving) = detach.moving() else {
                    return;
                };
                let attempt = {
                    let (root, runtime) = (root.clone(), runtime.clone());
                    runtime
                        .clone()
                        .spawn(async move { root.connect(runtime).await })
                };
                match attempt.await {
                    Ok(Ok(connection)) => break (connection, moving),
                    Ok(Err(error)) => eprintln!("maka-desktop-shell: reconnecting: {error}"),
                    Err(error) => eprintln!("maka-desktop-shell: reconnecting: {error}"),
                }
            };
            let Connection {
                bindings,
                config,
                endpoint,
                epoch,
                ..
            } = connection;
            if let Err(bindings) = detach.put(bindings, (endpoint.clone(), epoch)) {
                // Quitting began during the attempt: this client detaches
                // too, before the app quits.
                let _ = detach.close(bindings).await;
                return;
            }
            drop(moving);
            current = ConnectedHost::new((endpoint, epoch), config);
            cx.update(|cx| {
                let mut state = desktop.borrow_mut();
                state.config = current.config.clone();
                state.paused = false;
                state.reload(cx);
            });
        }
    })
    .detach();
}

/// Detaches the client once: its tasks stop and its Host connection closes.
#[derive(Clone)]
struct Detach(Rc<RefCell<DetachState>>);

struct DetachState {
    /// The client's bindings; out while the window moves to another Host.
    bindings: Option<Bindings>,
    /// The endpoint and epoch of the Host the bindings reach.
    host: (PathBuf, uuid::Uuid),
    /// Set by the first [`Detach::start`].
    quitting: bool,
    /// Set while the window moves its client to another Host; see [`Moving`].
    moving: watch::Sender<bool>,
    /// Runs the bindings until the process ends.
    runtime: tokio::runtime::Runtime,
    done: watch::Sender<bool>,
}

impl Detach {
    fn new(
        bindings: Bindings,
        host: (PathBuf, uuid::Uuid),
        runtime: tokio::runtime::Runtime,
    ) -> Self {
        Self(Rc::new(RefCell::new(DetachState {
            bindings: Some(bindings),
            host,
            quitting: false,
            moving: watch::Sender::new(false),
            runtime,
            done: watch::Sender::new(false),
        })))
    }

    /// Starts detaching (once) and returns a future that ends when it has.
    fn start(&self, _: &mut App) -> impl Future<Output = ()> + use<> {
        let mut state = self.0.borrow_mut();
        if !state.quitting {
            state.quitting = true;
            let done = state.done.clone();
            match state.bindings.take() {
                Some(bindings) => {
                    let (endpoint, epoch) = state.host.clone();
                    state.runtime.spawn(async move {
                        host::detach(bindings, &endpoint, epoch).await;
                        done.send_replace(true);
                    });
                }
                // Between two Hosts no client is connected; a move under way
                // (the stale client closing, or the next Host being reached)
                // finishes first.
                None => {
                    let mut moving = state.moving.subscribe();
                    state.runtime.spawn(async move {
                        let settled = moving.wait_for(|moving| !*moving);
                        let _ = tokio::time::timeout(host::DETACH_LIMIT, settled).await;
                        done.send_replace(true);
                    });
                }
            }
        }
        let mut done = state.done.subscribe();
        async move {
            let _ = done.wait_for(|done| *done).await;
        }
    }

    /// Takes the bindings whose Host stopped, starting a move; `None` once
    /// quitting.
    fn take(&self) -> Option<(Bindings, Moving)> {
        let moving = self.moving()?;
        let bindings = self.0.borrow_mut().bindings.take()?;
        Some((bindings, moving))
    }

    /// Starts a move to another Host; `None` once quitting.
    fn moving(&self) -> Option<Moving> {
        let state = self.0.borrow();
        if state.quitting {
            return None;
        }
        state.moving.send_replace(true);
        Some(Moving(state.moving.clone()))
    }

    /// Gives the client `bindings` on the next Host, at `host`; once
    /// quitting, returns them.
    fn put(&self, bindings: Bindings, host: (PathBuf, uuid::Uuid)) -> Result<(), Bindings> {
        let mut state = self.0.borrow_mut();
        if state.quitting {
            return Err(bindings);
        }
        state.bindings = Some(bindings);
        state.host = host;
        Ok(())
    }

    /// Closes `bindings` taken from the window, whatever their Host
    /// answers, within [`host::DETACH_LIMIT`].
    fn close(&self, bindings: Bindings) -> tokio::task::JoinHandle<()> {
        self.0.borrow().runtime.spawn(async move {
            let _ = tokio::time::timeout(host::DETACH_LIMIT, bindings.close()).await;
        })
    }

    fn finished(&self) -> bool {
        *self.0.borrow().done.borrow()
    }

    /// Detaches, then re-enters the quit admission gate.
    fn then_quit(&self, cx: &mut App) {
        if self.0.borrow().quitting {
            return;
        }
        let detached = self.start(cx);
        cx.spawn(async move |cx| {
            detached.await;
            cx.update(|cx| cx.quit());
        })
        .detach();
    }
}

/// A move of the window's client to another Host. Quitting waits (within
/// [`host::DETACH_LIMIT`]) until it is dropped.
struct Moving(watch::Sender<bool>);

impl Drop for Moving {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}
