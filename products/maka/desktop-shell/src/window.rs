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

//! The window the workbench runs in, and the end of the client.
//!
//! Closing the window, the quit key and the quit menu item all close the
//! window; once no window is left the client detaches from the Host (its
//! tasks stop and its connection closes, within [`DETACH_LIMIT`]) and then the
//! app quits. On macOS quitting ends the process (`terminate:`), so the
//! detach runs before it, not after the event loop returns.
//!
//! While the window is open it follows the Root's Host: once the Host its
//! client reaches stops, it connects to the next one and loads the workbench
//! again in the same window.
//!
//! The window opens where it was when it last closed (see [`Placement`]).

use crate::{
    host::{self, Connection, Root},
    placement::Placement,
};
use maka_workbench::bindings::Bindings;
use nsh_engine::{EngineConfig, Limits};
use nsh_platform_gpui::{
    AppOptions, AppView,
    gpui::{self, App, AppContext as _, Focusable as _, WindowHandle},
    titlebar_options,
};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tokio::{runtime::Handle, sync::watch};

const APP_ID: &str = "org.apache.maka.desktop";
const TITLE: &str = "Maka";
const SIZE: (i32, i32) = (1280, 820);
/// The narrowest layout the workbench folds its sidebar for.
const MIN_SIZE: (f32, f32) = (640., 480.);
/// How long quitting waits for the Host connection to close.
const DETACH_LIMIT: Duration = Duration::from_secs(5);
/// The first pause between attempts to reach the Root's next Host.
const FIRST_PAUSE: Duration = Duration::from_secs(1);
/// The longest pause between attempts to reach the Root's next Host.
const RECONNECT_LIMIT: Duration = Duration::from_secs(30);
/// How long the window must have used a Host for the next one to be tried at
/// once after it stops.
const STEADY: Duration = Duration::from_secs(60);

/// Runs the workbench on `first` in its window until the app quits.
pub fn run(first: Connection, root: Root, runtime: tokio::runtime::Runtime) -> Result<(), String> {
    let Connection {
        bindings,
        config,
        directory,
        endpoint,
        epoch,
    } = first;
    let handle = runtime.handle().clone();
    let detach = Detach::new(bindings, (endpoint.clone(), epoch), runtime);
    let (active, foreground) = watch::channel(false);
    let (exit, mut exits) = tokio::sync::mpsc::unbounded_channel();
    let shell = Shell { foreground, exit };
    let mut start = Some((config, Placement::new(&directory), endpoint, epoch, root));
    // Quitting waits for the detach: GPUI's default quits Linux and Windows
    // apps as their last window closes, giving the detach no more than its
    // quit handlers' 200 ms.
    let application = gpui_platform::application().with_quit_mode(gpui::QuitMode::Explicit);
    application.run(move |cx| {
        let closed = detach.clone();
        cx.on_window_closed(move |cx, _| {
            if cx.windows().is_empty() {
                closed.then_quit(cx);
            }
        })
        .detach();
        let (config, placement, endpoint, epoch, root) = start.take().expect("the app starts once");
        let placement = Rc::new(placement);
        let window = match open(shell.attach(config), placement.clone(), cx) {
            Ok(window) => window,
            Err(error) => {
                eprintln!("maka-desktop-shell: cannot open a window: {error}");
                std::process::exit(1);
            }
        };
        let _ = window.update(cx, |_, window, cx| {
            active.send_replace(window.is_window_active());
            cx.observe_window_activation(window, move |_, window, _| {
                active.send_replace(window.is_window_active());
            })
            .detach();
        });
        let closing = placement.clone();
        cx.spawn(async move |cx| {
            if exits.recv().await.is_some() {
                let _ = window.update(cx, |_, window, cx| {
                    closing.save(window, cx);
                    window.remove_window();
                });
            }
        })
        .detach();
        // Quitting from elsewhere (the Dock, logging out) gets the time GPUI
        // gives quit handlers; a window still open records its place first.
        let quitting = detach.clone();
        cx.on_app_quit(move |cx| {
            let _ = window.update(cx, |_, window, cx| placement.save(window, cx));
            quitting.start(cx)
        })
        .detach();
        let host = (endpoint, epoch);
        follow(
            window,
            host,
            root,
            handle.clone(),
            &detach,
            shell.clone(),
            cx,
        );
        cx.activate(true);
    });
    Ok(())
}

fn open(
    config: EngineConfig,
    placement: Rc<Placement>,
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
        let app = view.read(cx);
        app.own_window(window, cx);
        // Quit and close both close the window, which records its place;
        // the last one closed detaches.
        app.on_close_request(move |_, window, cx| {
            placement.save(window, cx);
            window.remove_window();
        });
        app.load_with_config(config);
        let focus = view.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        view
    })
    .map_err(|error| error.to_string())
}

/// Keeps the window's client on a running Host: once the one at `host`
/// stops, connects to the Root's next Host (retrying with growing pauses)
/// and loads the workbench again on it. The workbench starts over, as it
/// does when the desktop opens.
fn follow(
    window: WindowHandle<AppView>,
    mut host: (PathBuf, uuid::Uuid),
    root: Root,
    runtime: Handle,
    detach: &Detach,
    shell: Shell,
    cx: &mut App,
) {
    let detach = detach.clone();
    cx.spawn(async move |cx| {
        let mut pause = FIRST_PAUSE;
        loop {
            let reached = Instant::now();
            let (endpoint, epoch) = host;
            let _ = runtime.spawn(host::stopped(endpoint, epoch)).await;
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
            let _ = window.update(cx, |view, _, _| view.load_with_config(shell.attach(config)));
            host = (endpoint, epoch);
        }
    })
    .detach();
}

/// What the window gives each workbench it loads, beside its Host.
#[derive(Clone)]
struct Shell {
    /// Whether the window is active.
    foreground: watch::Receiver<bool>,
    /// Closes the window.
    exit: tokio::sync::mpsc::UnboundedSender<()>,
}

impl Shell {
    fn attach(&self, mut config: EngineConfig) -> EngineConfig {
        config.context = config
            .context
            .with(maka_workbench::Foreground(self.foreground.clone()));
        // The workbench's exit gesture (Ctrl+C twice) closes the window, as
        // it ends the terminal.
        let exit = self.exit.clone();
        config.host.handle("terminal.exit", move |_| {
            let _ = exit.send(());
        });
        config
    }
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
                        let error = match tokio::time::timeout(DETACH_LIMIT, bindings.close()).await
                        {
                            Ok(Ok(())) => None,
                            Ok(Err(error)) => Some(format!("Host cleanup: {error}")),
                            Err(_) => Some("Host cleanup did not finish in time".to_owned()),
                        };
                        // A Host that stopped has no client left to detach.
                        if let Some(error) = error
                            && host::runs(&endpoint, epoch).await
                        {
                            eprintln!("maka-desktop-shell: {error}");
                        }
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
                        let _ = tokio::time::timeout(DETACH_LIMIT, settled).await;
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
    /// answers, within [`DETACH_LIMIT`].
    fn close(&self, bindings: Bindings) -> tokio::task::JoinHandle<()> {
        self.0.borrow().runtime.spawn(async move {
            let _ = tokio::time::timeout(DETACH_LIMIT, bindings.close()).await;
        })
    }

    /// Detaches, then quits the app.
    fn then_quit(&self, cx: &mut App) {
        let detached = self.start(cx);
        cx.spawn(async move |cx| {
            detached.await;
            cx.update(|cx| cx.quit());
        })
        .detach();
    }
}

/// A move of the window's client to another Host. Quitting waits (within
/// [`DETACH_LIMIT`]) until it is dropped.
struct Moving(watch::Sender<bool>);

impl Drop for Moving {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}
