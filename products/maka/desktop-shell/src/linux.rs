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

//! The disposable GTK workbench and its process-owned Host connection.

use crate::{
    host::{self, Connection, Root},
    placement::Placement,
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
    tray_linux::{Event, Tray},
};
use gtk::{gio, glib, prelude::*};
use maka_workbench::{
    bindings::Bindings,
    reload::{Request, UiReload},
};
use nsh_engine::{EngineConfig, HostChannel, JsonValue};
use nsh_platform_linux::{AppOptions, AppView, gtk4 as gtk};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tokio::{
    runtime::Handle,
    sync::{mpsc, watch},
};

const FIRST_PAUSE: Duration = Duration::from_secs(1);
const RECONNECT_LIMIT: Duration = Duration::from_secs(30);
const STEADY: Duration = Duration::from_secs(60);

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
    let current = ConnectedHost::new((endpoint.clone(), epoch), &config);
    let handle = runtime.handle().clone();
    let detach = Detach::new(bindings, (endpoint, epoch), runtime);
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    let (events, received) = mpsc::unbounded_channel();
    let tray = Tray::start(handle.clone(), events);
    glib::set_prgname(Some(APP_ID));
    let app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();
    let desktop = Rc::new(RefCell::new(Desktop {
        app: app.downgrade(),
        config: Some(config),
        placement,
        detach: detach.clone(),
        shell,
        active,
        window: None,
        paused: false,
        tray,
        hold: None,
    }));
    let pending = RefCell::new(Some((current, root, requests, received)));
    let tasks = Rc::new(RefCell::new(Vec::new()));
    let running = tasks.clone();
    let activate = desktop.clone();
    app.connect_activate(move |_| {
        Desktop::show(&activate);
        if let Some((current, root, requests, received)) = pending.take() {
            running
                .borrow_mut()
                .extend(carry_out(requests, received, &activate));
            running
                .borrow_mut()
                .push(follow(activate.clone(), current, root, handle.clone()));
        }
    });
    let result = app.run_with_args::<&str>(&[]);
    // Also handles GTK shutdown that bypassed our close/quit actions.
    Desktop::release_window(&desktop);
    glib::MainContext::default().block_on(detach.start());
    for task in tasks.take() {
        task.abort();
    }
    // The hold owns the application, whose activation callback owns this controller.
    desktop.borrow_mut().hold.take();
    if result == glib::ExitCode::SUCCESS {
        Ok(())
    } else {
        Err("the GTK application failed".into())
    }
}

struct Window {
    native: gtk::ApplicationWindow,
    view: Rc<AppView>,
    closed: watch::Sender<bool>,
}
impl Window {
    fn release(self) {
        self.closed.send_replace(true);
        self.view.stop();
        self.native.set_child(None::<&gtk::Widget>);
        self.native.destroy();
    }
}

struct Desktop {
    app: glib::WeakRef<gtk::Application>,
    // Never passed to an engine: registry values and HostChannel are per window.
    config: Option<EngineConfig>,
    placement: Placement,
    detach: Detach,
    shell: Shell,
    active: watch::Sender<bool>,
    window: Option<Window>,
    paused: bool,
    tray: Tray,
    hold: Option<gio::ApplicationHoldGuard>,
}
impl Desktop {
    fn show(this: &Rc<RefCell<Self>>) {
        let mut state = this.borrow_mut();
        if state.detach.0.borrow().quitting {
            return;
        }
        if let Some(window) = &state.window {
            window.native.present();
            return;
        }
        let Some(app) = state.app.upgrade() else {
            return;
        };
        let window = gtk::ApplicationWindow::builder()
            .application(&app)
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
        state.placement.restore(&window);
        if let Some(config) = &state.config {
            let mut config = config.clone();
            config.host = HostChannel::new();
            view.load_with_config(state.shell.attach(config));
            if state.paused {
                view.pause_input(|_| {});
            }
        }
        let active = state.active.clone();
        window.connect_is_active_notify(move |window| {
            active.send_replace(window.is_active());
        });
        let weak = Rc::downgrade(this);
        window.connect_close_request(move |_| {
            if let Some(desktop) = weak.upgrade() {
                Self::close(&desktop);
            }
            glib::Propagation::Stop
        });
        install_shortcuts(&app, &window);
        state.window = Some(Window {
            native: window.clone(),
            view,
            closed: watch::Sender::new(false),
        });
        // Register the new window before releasing the tray's application hold.
        state.hold.take();
        drop(state);
        window.present();
    }

    fn close(this: &Rc<RefCell<Self>>) {
        let mut state = this.borrow_mut();
        if state.detach.0.borrow().quitting || state.window.is_none() {
            return;
        }
        if !state.tray.ready() {
            drop(state);
            Self::quit(this);
            return;
        }
        if !state.shell.prepare_close() {
            return;
        }
        let app = state
            .app
            .upgrade()
            .expect("the application owns its windows");
        state.hold.get_or_insert_with(|| app.hold());
        drop(state);
        Self::release_window(this);
    }

    fn release_window(this: &Rc<RefCell<Self>>) {
        let mut state = this.borrow_mut();
        let window = state.window.take();
        if let Some(window) = &window {
            state.placement.save(&window.native);
        }
        state.active.send_replace(false);
        state.shell.release();
        drop(state);
        if let Some(window) = window {
            window.release();
        }
    }

    fn quit(this: &Rc<RefCell<Self>>) {
        let mut state = this.borrow_mut();
        if state.detach.0.borrow().quitting {
            return;
        }
        let app = state
            .app
            .upgrade()
            .expect("the application owns its controller");
        state.hold.get_or_insert_with(|| app.hold());
        let detached = state.detach.start();
        drop(state);
        Self::release_window(this);
        glib::MainContext::default().spawn_local(async move {
            detached.await;
            app.quit();
        });
    }

    fn reload(&self) {
        if let (Some(window), Some(config)) = (&self.window, &self.config) {
            let mut config = config.clone();
            config.host = HostChannel::new();
            window.view.load_with_config(self.shell.attach(config));
        }
    }
}

fn carry_out(
    requests: Requests,
    mut tray: mpsc::UnboundedReceiver<Event>,
    desktop: &Rc<RefCell<Desktop>>,
) -> Vec<glib::JoinHandle<()>> {
    let Requests {
        mut close_ready,
        mut exits,
        mut folders,
        mut text_sizes,
        mut notices,
    } = requests;
    let context = glib::MainContext::default();
    let mut tasks = Vec::new();
    let weak = Rc::downgrade(desktop);
    tasks.push(context.spawn_local(async move {
        while let Some(event) = tray.recv().await {
            let Some(desktop) = weak.upgrade() else {
                return;
            };
            match event {
                Event::Open => Desktop::show(&desktop),
                Event::Quit => Desktop::quit(&desktop),
                Event::Unavailable => {
                    let hidden = desktop.borrow().window.is_none();
                    if hidden {
                        Desktop::show(&desktop);
                    }
                }
            }
        }
    }));
    let weak = Rc::downgrade(desktop);
    tasks.push(context.spawn_local(async move {
        while let Some(ready) = close_ready.recv().await {
            if ready.is_current()
                && let Some(desktop) = weak.upgrade()
            {
                Desktop::close(&desktop);
            }
        }
    }));
    let weak = Rc::downgrade(desktop);
    tasks.push(context.spawn_local(async move {
        if exits.recv().await.is_some()
            && let Some(desktop) = weak.upgrade()
        {
            Desktop::quit(&desktop);
        }
    }));
    let weak = Rc::downgrade(desktop);
    tasks.push(context.spawn_local(async move {
        while let Some(call) = folders.recv().await {
            let current = weak.upgrade().and_then(|desktop| {
                desktop.borrow().window.as_ref().map(|window| (window.native.clone(), window.closed.subscribe()))
            });
            let Some((window, mut closed)) = current else { call.reject("the window is closed"); continue; };
            let dialog = gtk::FileDialog::builder().title("Choose a folder").build();
            let selected = tokio::select! {
                biased;
                _ = closed.wait_for(|closed| *closed) => { call.reject("the window is closed"); continue; }
                result = dialog.select_folder_future(Some(&window)) => result,
            };
            match selected {
                Ok(file) => match file.path() {
                    Some(path) => match path.to_str() {
                        Some(path) => call.resolve(JsonValue::from(path)),
                        None => call.reject("the folder's path is not valid UTF-8"),
                    },
                    None => call.reject("the selected folder is not a local path"),
                },
                Err(error) if error.matches(gtk::DialogError::Dismissed) || error.matches(gtk::DialogError::Cancelled) => call.resolve(JsonValue::Null),
                Err(error) => call.reject(error.to_string()),
            }
        }
    }));
    let weak = Rc::downgrade(desktop);
    tasks.push(context.spawn_local(async move {
        while let Some(scale) = text_sizes.recv().await {
            if let Some(desktop) = weak.upgrade()
                && let Some(window) = &desktop.borrow().window
            {
                window.view.set_font_scale(Some(scale));
            }
        }
    }));
    let action = gio::SimpleAction::new("notification-open", Some(glib::VariantTy::STRING));
    let weak = Rc::downgrade(desktop);
    action.connect_activate(move |_, parameter| {
        if let Some(desktop) = weak.upgrade() {
            Desktop::show(&desktop);
            if let Some(tag) = parameter.and_then(|p| p.str())
                && let Some(host) = desktop
                    .borrow()
                    .shell
                    .events
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
            {
                let _ = host.send("notification.open", serde_json::json!({"tag": tag}));
            }
        }
    });
    let app = desktop.borrow().app.clone();
    if let Some(app) = app.upgrade() {
        app.add_action(&action);
        let quit = gio::SimpleAction::new("quit", None);
        let weak = Rc::downgrade(desktop);
        quit.connect_activate(move |_, _| {
            if let Some(desktop) = weak.upgrade() {
                Desktop::quit(&desktop);
            }
        });
        app.add_action(&quit);
        app.set_accels_for_action("app.quit", &["<Control>q"]);
    }
    tasks.push(context.spawn_local(async move {
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
                _ => call.reject("expected a tag, a title and a body"),
            }
        }
    }));
    tasks
}

fn install_shortcuts(app: &gtk::Application, window: &gtk::ApplicationWindow) {
    let close = gio::SimpleAction::new("close", None);
    let weak = window.downgrade();
    close.connect_activate(move |_, _| {
        if let Some(window) = weak.upgrade() {
            window.close();
        }
    });
    window.add_action(&close);

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

struct ConnectedHost {
    host: (PathBuf, uuid::Uuid),
    reloading: mpsc::UnboundedReceiver<Request>,
}
impl ConnectedHost {
    fn new(host: (PathBuf, uuid::Uuid), config: &EngineConfig) -> Self {
        let reloading = config
            .context
            .get::<UiReload>()
            .expect("the admitted workbench owns its UI reload channel")
            .take_requests();
        Self { host, reloading }
    }
}

fn follow(
    desktop: Rc<RefCell<Desktop>>,
    mut current: ConnectedHost,
    root: Root,
    runtime: Handle,
) -> glib::JoinHandle<()> {
    glib::MainContext::default().spawn_local(async move {
        let detach = desktop.borrow().detach.clone();
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
                        let mut state = desktop.borrow_mut();
                        match request {
                            Request::Pause(ready) => {
                                state.paused = true;
                                if let Some(window) = &state.window {
                                    window.view.pause_input(move |result| { let _ = ready.send(result); });
                                } else { let _ = ready.send(Ok(())); }
                            }
                            Request::Resume => {
                                state.paused = false;
                                if let Some(window) = &state.window { window.view.resume_input(); }
                            }
                            Request::Reload => { state.paused = false; state.reload(); }
                        }
                    }
                }
            }
            {
                let mut state = desktop.borrow_mut();
                state.shell.release();
                if let Some(window) = &state.window { window.view.stop(); }
                state.config = None;
                state.paused = false;
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
            current = ConnectedHost::new((endpoint, epoch), &config);
            let mut state = desktop.borrow_mut();
            state.config = Some(config);
            state.reload();
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Assets;
    impl nsh_engine::Assets for Assets {
        fn read(&self, _: &str) -> Result<Vec<u8>, String> {
            Err("no test assets".into())
        }
    }

    #[test]
    #[ignore = "requires a GTK display; exercised by linux-desktop CI"]
    fn closing_gtk_windows_releases_their_engine_and_surface_before_reopening() {
        gtk::init().expect("the GTK lifecycle test requires a display (run under xvfb-run)");
        let app = gtk::Application::builder()
            .application_id("org.apache.maka.desktop.test")
            .flags(gio::ApplicationFlags::NON_UNIQUE)
            .build();
        app.register(None::<&gio::Cancellable>).unwrap();
        let _hold = app.hold();
        let context = glib::MainContext::default();
        for _ in 0..3 {
            let native = gtk::ApplicationWindow::builder().application(&app).build();
            let view = AppView::new(AppOptions::default());
            native.set_child(Some(&view.widget()));
            let weak_view = Rc::downgrade(&view);
            let assets = Arc::new(Assets);
            let weak_assets = Arc::downgrade(&assets);
            let mut policy = nsh_engine::Policy::default();
            policy
                .declared
                .get_or_insert_default()
                .host
                .push("loaded".into());
            let mut config = EngineConfig::new(
                nsh_engine::Bundle::source(
                    "import { host } from 'nsh'; host.post('loaded');".into(),
                )
                .with_policy(policy),
            );
            config.assets = Some(assets);
            let (loaded, mut received) = mpsc::unbounded_channel();
            config.host.handle("loaded", move |_| {
                let _ = loaded.send(());
            });
            view.load_with_config(config);
            native.present();
            context.block_on(async {
                tokio::select! {
                    value = received.recv() => assert_eq!(value, Some(())),
                    _ = glib::timeout_future(Duration::from_secs(10)) => panic!("the window's engine did not start"),
                }
            });
            assert!(native.is_visible());
            let (closed, mut closing) = watch::channel(false);
            let window = Window {
                native,
                view,
                closed,
            };
            window.release();
            assert!(
                *closing.borrow_and_update(),
                "pending dialogs must be cancelled"
            );
            assert!(weak_view.upgrade().is_none(), "the old surface is retained");
            assert!(
                weak_assets.upgrade().is_none(),
                "the old engine or image reader is retained"
            );
            assert!(
                app.windows().is_empty(),
                "the closed GTK window is retained by the application"
            );
        }
    }
}
