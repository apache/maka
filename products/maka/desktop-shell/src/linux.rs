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

//! The GTK workbench window, including Host reconnection and UI reload.

use crate::{
    host::{self, Connection, Root},
    placement::Placement,
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use gtk::{gio, glib, prelude::*};
use maka_workbench::{
    bindings::Bindings,
    reload::{Request, UiReload},
};
use nsh_engine::{EngineConfig, JsonValue};
use nsh_platform_linux::{AppOptions, AppView, gtk4 as gtk};
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tokio::{runtime::Handle, sync::watch};

const FIRST_PAUSE: Duration = Duration::from_secs(1);
const RECONNECT_LIMIT: Duration = Duration::from_secs(30);
const STEADY: Duration = Duration::from_secs(60);
/// The panel service that shows `nsh/desktop`'s tray icon.
const TRAY_WATCHER: &str = "org.kde.StatusNotifierWatcher";

pub(crate) fn start(target: crate::Target) -> Result<(), String> {
    use maka_host_runtime::application::host::Client as HostClient;
    let root = Root::find(target.root, target.launcher)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    let first = runtime.block_on(async {
        let host = HostClient::connect(&target.endpoint, Some(target.epoch)).await?;
        Connection::admit(host, target.endpoint, root.path(), Handle::current()).await
    })?;
    run(first, root, runtime)
}

fn run(first: Connection, root: Root, runtime: tokio::runtime::Runtime) -> Result<(), String> {
    let Connection {
        bindings,
        config,
        endpoint,
        epoch,
    } = first;
    let placement = Placement::new(
        config
            .data_dir
            .as_ref()
            .expect("Host admission sets the client directory"),
    );
    let handle = runtime.handle().clone();
    let detach = Detach::new(bindings, (endpoint.clone(), epoch), runtime);
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    glib::set_prgname(Some(APP_ID));
    let app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();
    let start = RefCell::new(Some((config, placement, endpoint, epoch, root, requests)));
    let closing = detach.clone();
    app.connect_activate(move |app| {
        let Some((config, placement, endpoint, epoch, root, requests)) = start.take() else {
            if let Some(window) = app.active_window() {
                window.present();
            }
            return;
        };
        let current = ConnectedView::new((endpoint, epoch), shell.attach(config));
        let window = gtk::ApplicationWindow::builder()
            .application(app)
            .title(TITLE)
            .default_width(SIZE.0)
            .default_height(SIZE.1)
            .build();
        window.set_size_request(MIN_SIZE.0 as i32, MIN_SIZE.1 as i32);
        let view = AppView::new(AppOptions {
            app_id: APP_ID.into(),
            title: TITLE.into(),
            size: SIZE,
            ..Default::default()
        });
        window.set_child(Some(&view.widget()));
        placement.restore(&window);
        view.load_with_config(current.config.clone());
        let focus = active.clone();
        window.connect_is_active_notify(move |window| {
            focus.send_replace(window.is_active());
        });
        let follow_detach = closing.clone();
        let quit = Rc::new(Quit {
            placement,
            view: view.clone(),
            detach: closing.clone(),
        });
        let tray = watch_tray(window.downgrade());
        let closing = quit.clone();
        window.connect_close_request(move |window| {
            if tray.get() {
                closing.placement.save(window);
                window.set_visible(false);
            } else {
                closing.run(window);
            }
            glib::Propagation::Stop
        });
        install_shortcuts(app, &window, &quit);
        carry_out(requests, app, &window, &view, &shell, quit);
        follow(
            window.downgrade(),
            view,
            current,
            root,
            handle.clone(),
            follow_detach,
            shell.clone(),
        );
        window.present();
    });
    let result = app.run_with_args::<&str>(&[]);
    // Covers display initialization failures and shutdown without close-request.
    glib::MainContext::default().block_on(detach.start());
    if result == glib::ExitCode::SUCCESS {
        Ok(())
    } else {
        Err("the GTK window failed".into())
    }
}

/// Ends the application: closing only hides the window while a tray can
/// bring it back.
struct Quit {
    placement: Placement,
    view: Rc<AppView>,
    detach: Detach,
}
impl Quit {
    fn run(&self, window: &gtk::ApplicationWindow) {
        self.placement.save(window);
        self.view.stop();
        let detached = self.detach.start();
        let window = window.clone();
        glib::MainContext::default().spawn_local(async move {
            detached.await;
            window.destroy();
        });
    }
}

/// Whether a panel shows the tray now. Without one a hidden window could not
/// come back, so a panel leaving also brings the window back.
fn watch_tray(window: glib::WeakRef<gtk::ApplicationWindow>) -> Rc<Cell<bool>> {
    let tray = Rc::new(Cell::new(false));
    let (appeared, vanished) = (tray.clone(), tray.clone());
    gio::bus_watch_name(
        gio::BusType::Session,
        TRAY_WATCHER,
        gio::BusNameWatcherFlags::NONE,
        move |_, _, _| appeared.set(true),
        move |_, _| {
            vanished.set(false);
            if let Some(window) = window.upgrade()
                && !window.is_visible()
            {
                window.present();
            }
        },
    );
    tray
}

fn carry_out(
    requests: Requests,
    app: &gtk::Application,
    window: &gtk::ApplicationWindow,
    view: &Rc<AppView>,
    shell: &Shell,
    quit: Rc<Quit>,
) {
    let Requests {
        mut exits,
        mut folders,
        mut text_sizes,
        mut notices,
    } = requests;
    let context = glib::MainContext::default();
    let weak = window.downgrade();
    context.spawn_local(async move {
        if exits.recv().await.is_some()
            && let Some(window) = weak.upgrade()
        {
            quit.run(&window);
        }
    });
    let weak = window.downgrade();
    context.spawn_local(async move {
        while let Some(call) = folders.recv().await {
            let Some(window) = weak.upgrade() else {
                call.reject("the window is closing");
                return;
            };
            let dialog = gtk::FileDialog::builder().title("Choose a folder").build();
            match dialog.select_folder_future(Some(&window)).await {
                Ok(file) => match file.path() {
                    Some(path) => match path.to_str() {
                        Some(path) => call.resolve(JsonValue::from(path)),
                        None => call.reject("the folder's path is not valid UTF-8"),
                    },
                    None => call.reject("the selected folder is not a local path"),
                },
                Err(error)
                    if error.matches(gtk::DialogError::Dismissed)
                        || error.matches(gtk::DialogError::Cancelled) =>
                {
                    call.resolve(JsonValue::Null)
                }
                Err(error) => call.reject(error.to_string()),
            }
        }
    });
    let weak = Rc::downgrade(view);
    context.spawn_local(async move {
        while let Some(scale) = text_sizes.recv().await {
            let Some(view) = weak.upgrade() else {
                return;
            };
            view.set_font_scale(Some(scale));
        }
    });
    let action = gio::SimpleAction::new("notification-open", Some(glib::VariantTy::STRING));
    let weak = window.downgrade();
    let events = shell.events.clone();
    action.connect_activate(move |_, parameter| {
        if let Some(window) = weak.upgrade() {
            window.present();
        }
        if let Some(tag) = parameter.and_then(|p| p.str())
            && let Some(host) = events.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        {
            let _ = host.send("notification.open", serde_json::json!({ "tag": tag }));
        }
    });
    app.add_action(&action);
    let app = app.downgrade();
    context.spawn_local(async move {
        while let Some(call) = notices.recv().await {
            let text = |key: &str| call.data()[key].as_str().map(str::to_owned);
            match (text("tag"), text("title"), text("body"), app.upgrade()) {
                (Some(tag), Some(title), Some(body), Some(app)) => {
                    let notice = gio::Notification::new(&title);
                    notice.set_body(Some(&body));
                    notice.set_default_action_and_target_value(
                        "app.notification-open",
                        Some(&tag.to_variant()),
                    );
                    app.send_notification(Some(&tag), &notice);
                    call.resolve(JsonValue::Null);
                }
                _ => call.reject("expected a tag, a title and a body in an open window"),
            }
        }
    });
}

fn install_shortcuts(app: &gtk::Application, window: &gtk::ApplicationWindow, quit: &Rc<Quit>) {
    let close = gio::SimpleAction::new("close", None);
    let weak = window.downgrade();
    close.connect_activate(move |_, _| {
        if let Some(window) = weak.upgrade() {
            window.close();
        }
    });
    window.add_action(&close);
    let quitting = gio::SimpleAction::new("quit", None);
    let weak = window.downgrade();
    let quit = quit.clone();
    quitting.connect_activate(move |_, _| {
        if let Some(window) = weak.upgrade() {
            quit.run(&window);
        }
    });
    window.add_action(&quitting);
    app.set_accels_for_action("win.quit", &["<Control>q"]);
    let fullscreen = gio::SimpleAction::new("fullscreen", None);
    let weak = window.downgrade();
    fullscreen.connect_activate(move |_, _| {
        if let Some(window) = weak.upgrade() {
            window.set_fullscreened(!window.is_fullscreen());
        }
    });
    window.add_action(&fullscreen);
    app.set_accels_for_action("win.fullscreen", &["F11"]);
    let close = gtk::ShortcutController::new();
    close.set_propagation_phase(gtk::PropagationPhase::Bubble);
    close.add_shortcut(gtk::Shortcut::new(
        gtk::ShortcutTrigger::parse_string("<Control>w"),
        Some(gtk::NamedAction::new("win.close")),
    ));
    window.add_controller(close);
}

struct ConnectedView {
    host: (PathBuf, uuid::Uuid),
    config: EngineConfig,
    reloading: tokio::sync::mpsc::UnboundedReceiver<Request>,
}
impl ConnectedView {
    fn new(host: (PathBuf, uuid::Uuid), config: EngineConfig) -> Self {
        let reloading = config
            .context
            .get::<UiReload>()
            .expect("the admitted workbench owns its UI reload channel")
            .take_requests();
        Self {
            host,
            config,
            reloading,
        }
    }
}

fn follow(
    window: glib::WeakRef<gtk::ApplicationWindow>,
    view: Rc<AppView>,
    mut current: ConnectedView,
    root: Root,
    runtime: Handle,
    detach: Detach,
    shell: Shell,
) {
    glib::MainContext::default().spawn_local(async move {
        let mut pause = FIRST_PAUSE;
        loop {
            let reached = Instant::now();
            let (endpoint, epoch) = current.host.clone();
            let mut stopped = runtime.spawn(host::stopped(endpoint, epoch));
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    request = current.reloading.recv() => {
                        let Some(request) = request else { return; };
                        if detach.0.borrow().quitting { return; }
                        match request {
                            Request::Pause(ready) => view.pause_input(move |result| { let _ = ready.send(result); }),
                            Request::Resume => view.resume_input(),
                            Request::Reload => view.load_with_config(current.config.clone()),
                        }
                    }
                }
            }
            let Some((stale, moving)) = detach.take() else { return; };
            let _ = detach.close(stale).await;
            drop(moving);
            let mut wait = reached.elapsed() < STEADY;
            if !wait { pause = FIRST_PAUSE; }
            let (connection, moving) = loop {
                if wait {
                    glib::timeout_future(pause).await;
                    pause = (pause * 2).min(RECONNECT_LIMIT);
                }
                wait = true;
                let Some(moving) = detach.moving() else { return; };
                let (root, handle) = (root.clone(), runtime.clone());
                match runtime.spawn(async move { root.connect(handle).await }).await {
                    Ok(Ok(connection)) => break (connection, moving),
                    Ok(Err(error)) => eprintln!("maka-desktop-shell: reconnecting: {error}"),
                    Err(error) => eprintln!("maka-desktop-shell: reconnecting: {error}"),
                }
            };
            let Connection { bindings, config, endpoint, epoch } = connection;
            if let Err(bindings) = detach.put(bindings, (endpoint.clone(), epoch)) {
                let _ = detach.close(bindings).await;
                return;
            }
            drop(moving);
            current = ConnectedView::new((endpoint, epoch), shell.attach(config));
            if window.upgrade().is_none() { return; }
            view.load_with_config(current.config.clone());
        }
    });
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
    fn start(&self) -> impl Future<Output = ()> + use<> {
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
}

/// A move of the window's client to another Host. Quitting waits (within
/// [`host::DETACH_LIMIT`]) until it is dropped.
struct Moving(watch::Sender<bool>);

impl Drop for Moving {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}
