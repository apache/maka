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
use nsh_platform_linux::{AppOptions, AppView, gtk4 as gtk, on_tray_lost, tray_registered};
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
    let detach = Detach::new(bindings, runtime);
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
            residency: Cell::new(Residency::Running),
            placement,
            view: view.clone(),
            detach: closing.clone(),
        });
        restore_when_tray_lost(&window, &quit);
        let closing = quit.clone();
        window.connect_close_request(move |window| closing.close_request(window));
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Residency {
    Running,
    TrayLost,
    Quitting,
}

/// Ends the application: closing only hides the window while a tray can
/// bring it back.
struct Quit {
    residency: Cell<Residency>,
    placement: Placement,
    view: Rc<AppView>,
    detach: Detach,
}
impl Quit {
    fn close_request(&self, window: &gtk::ApplicationWindow) -> glib::Propagation {
        if self.residency.get() == Residency::Quitting {
            return glib::Propagation::Stop;
        }
        if tray_registered() {
            self.residency.set(Residency::Running);
            self.placement.save(window);
            self.view.main_close_request()
        } else {
            self.run(window);
            glib::Propagation::Stop
        }
    }

    fn run(&self, window: &gtk::ApplicationWindow) {
        if self.residency.replace(Residency::Quitting) == Residency::Quitting {
            return;
        }
        let app = window
            .application()
            .expect("the window belongs to its application");
        let hold = app.hold();
        self.placement.save(window);
        for window in app.windows() {
            window.set_visible(false);
        }
        self.view.stop();
        window.set_child(None::<&gtk::Widget>);
        window.destroy();
        let detached = self.detach.start();
        glib::MainContext::default().spawn_local(async move {
            detached.await;
            app.quit();
            drop(hold);
        });
    }
}

// A tray can disappear before the engine's deferred hide reaches GTK.
fn restore_when_tray_lost(window: &gtk::ApplicationWindow, quit: &Rc<Quit>) {
    let owner = Rc::downgrade(quit);
    window.connect_visible_notify(move |window| {
        if let Some(quit) = owner.upgrade() {
            restore_if_unreachable(window, &quit);
        }
    });
    let window = window.downgrade();
    let owner = Rc::downgrade(quit);
    on_tray_lost(move || {
        if let (Some(window), Some(quit)) = (window.upgrade(), owner.upgrade())
            && quit.residency.get() != Residency::Quitting
        {
            quit.residency.set(Residency::TrayLost);
            restore_if_unreachable(&window, &quit);
        }
    });
}

fn restore_if_unreachable(window: &gtk::ApplicationWindow, quit: &Quit) {
    if quit.residency.get() != Residency::TrayLost {
        return;
    }
    if tray_registered() {
        quit.residency.set(Residency::Running);
    } else if !window.is_visible() {
        window.present();
    }
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
    app.add_action(&quitting);
    app.set_accels_for_action("app.quit", &["<Control>q"]);
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
            if let Err(bindings) = detach.put(bindings) {
                let _ = runtime.spawn(host::quit(bindings)).await;
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
    /// Set by the first [`Detach::start`].
    quitting: bool,
    /// Set while the window moves its client to another Host; see [`Moving`].
    moving: watch::Sender<bool>,
    /// Runs the bindings until the process ends.
    runtime: tokio::runtime::Runtime,
    done: watch::Sender<bool>,
}

impl Detach {
    fn new(bindings: Bindings, runtime: tokio::runtime::Runtime) -> Self {
        Self(Rc::new(RefCell::new(DetachState {
            bindings: Some(bindings),
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
                    state.runtime.spawn(async move {
                        host::quit(bindings).await;
                        done.send_replace(true);
                    });
                }
                // Between two Hosts no client is connected; a move under way
                // (the stale client closing, or the next Host being reached)
                // finishes first.
                None => {
                    let mut moving = state.moving.subscribe();
                    state.runtime.spawn(async move {
                        let _ = moving.wait_for(|moving| !*moving).await;
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

    /// Gives the client the next Host's bindings, or returns them during quit.
    fn put(&self, bindings: Bindings) -> Result<(), Bindings> {
        let mut state = self.0.borrow_mut();
        if state.quitting {
            return Err(bindings);
        }
        state.bindings = Some(bindings);
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

/// A move of the window's client to another Host. Quitting waits for its
/// result so any newly admitted Host receives the same quit request.
struct Moving(watch::Sender<bool>);

impl Drop for Moving {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use tokio::sync::mpsc;

    fn until(mut ready: impl FnMut() -> bool) {
        let expired = Rc::new(Cell::new(false));
        let timeout = expired.clone();
        let timer =
            glib::timeout_add_local_once(Duration::from_secs(10), move || timeout.set(true));
        let context = glib::MainContext::default();
        while !ready() {
            assert!(!expired.get(), "the native operation did not settle");
            context.iteration(true);
        }
        assert!(!expired.get(), "the native operation timed out");
        timer.remove();
    }

    fn receive<T>(received: &mut mpsc::UnboundedReceiver<T>) -> T {
        let mut value = None;
        until(|| {
            value = received.try_recv().ok();
            value.is_some()
        });
        value.unwrap()
    }

    struct Watcher {
        bus: gio::DBusConnection,
        object: Option<gio::RegistrationId>,
    }
    impl Watcher {
        fn release_name(&self) {
            self.bus
                .call_sync(
                    Some("org.freedesktop.DBus"),
                    "/org/freedesktop/DBus",
                    "org.freedesktop.DBus",
                    "ReleaseName",
                    Some(&("org.kde.StatusNotifierWatcher",).to_variant()),
                    None,
                    gio::DBusCallFlags::NONE,
                    5000,
                    gio::Cancellable::NONE,
                )
                .unwrap();
        }

        fn new() -> (Self, mpsc::UnboundedReceiver<gio::DBusMethodInvocation>) {
            let bus = gio::DBusConnection::for_address_sync(
                &std::env::var("DBUS_SESSION_BUS_ADDRESS").expect("run under dbus-run-session"),
                gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
                    | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
                None,
                gio::Cancellable::NONE,
            )
            .unwrap();
            let info = gio::DBusNodeInfo::for_xml(
                r#"<node>
                <interface name="org.kde.StatusNotifierWatcher">
                  <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
                </interface></node>"#,
            )
            .unwrap();
            let (requests, received) = mpsc::unbounded_channel();
            let object = bus
                .register_object(
                    "/StatusNotifierWatcher",
                    &info
                        .lookup_interface("org.kde.StatusNotifierWatcher")
                        .unwrap(),
                )
                .method_call(move |_, _, _, _, _, _, invocation| {
                    requests.send(invocation).unwrap();
                })
                .build()
                .unwrap();
            let acquired = bus
                .call_sync(
                    Some("org.freedesktop.DBus"),
                    "/org/freedesktop/DBus",
                    "org.freedesktop.DBus",
                    "RequestName",
                    Some(&("org.kde.StatusNotifierWatcher", 0u32).to_variant()),
                    None,
                    gio::DBusCallFlags::NONE,
                    5000,
                    gio::Cancellable::NONE,
                )
                .unwrap();
            assert_eq!(acquired.child_value(0).get::<u32>(), Some(1));
            (
                Self {
                    bus,
                    object: Some(object),
                },
                received,
            )
        }
    }
    impl Drop for Watcher {
        fn drop(&mut self) {
            self.bus
                .unregister_object(self.object.take().unwrap())
                .unwrap();
            self.bus.close_sync(gio::Cancellable::NONE).unwrap();
        }
    }

    struct DesktopTest {
        app: gtk::Application,
        window: gtk::ApplicationWindow,
        quit: Rc<Quit>,
        directory: PathBuf,
    }
    impl DesktopTest {
        fn new() -> Self {
            gtk::init().expect("run under xvfb-run");
            let app = gtk::Application::builder()
                .application_id("org.apache.maka.desktop.test")
                .flags(gio::ApplicationFlags::NON_UNIQUE)
                .build();
            app.register(None::<&gio::Cancellable>).unwrap();
            let window = gtk::ApplicationWindow::builder().application(&app).build();
            let view = AppView::new(AppOptions::default());
            window.set_child(Some(&view.widget()));
            let directory = std::env::temp_dir().join(format!("maka-gtk-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            // Exercise Quit during a Host transition, when no bindings are installed.
            let detach = Detach(Rc::new(RefCell::new(DetachState {
                bindings: None,
                quitting: false,
                moving: watch::Sender::new(true),
                runtime: tokio::runtime::Runtime::new().unwrap(),
                done: watch::Sender::new(false),
            })));
            let quit = Rc::new(Quit {
                residency: Cell::new(Residency::Running),
                placement: Placement::new(&directory),
                view,
                detach,
            });
            restore_when_tray_lost(&window, &quit);
            let closing = quit.clone();
            window.connect_close_request(move |window| closing.close_request(window));
            install_shortcuts(&app, &window, &quit);
            window.present();
            Self {
                app,
                window,
                quit,
                directory,
            }
        }

        fn load(&self) -> (EngineConfig, mpsc::UnboundedReceiver<JsonValue>) {
            self.load_source(r#"
                import { host } from 'nsh';
                import { Window, Tray } from 'nsh/desktop';
                let count = 0;
                const main = Window.get('main');
                main.set({ closeOnPress: false, title: 'Resident ready' });
                main.on('closePress', () => {
                    main.hide();
                    host.post('observed', { kind: 'hidden', count: ++count });
                });
                host.on('reopen', () => main.focus());
                const side = Window.open(() => {
                    host.on('probe', () => {
                        side.set({ title: 'Probe ' + ++count });
                        host.post('observed', { kind: 'secondary', count });
                    });
                    return null;
                }, { id: 'secondary', title: 'Secondary', defaultSize: { width: 200, height: 150 } });
                Tray.set({ menu: [] });
                host.post('observed', { kind: 'loaded', count });
            "#)
        }

        fn load_source(&self, source: &str) -> (EngineConfig, mpsc::UnboundedReceiver<JsonValue>) {
            let mut policy = nsh_engine::Policy::default();
            policy.declared = Some(
                nsh_engine::parse_capabilities(r#"{"host":["observed"],"windows":{}}"#).unwrap(),
            );
            let config =
                EngineConfig::new(nsh_engine::Bundle::source(source.into()).with_policy(policy));
            let (observed, received) = mpsc::unbounded_channel();
            config.host.handle("observed", move |call| {
                let _ = observed.send(call.data().clone());
            });
            self.quit.view.load_with_config(config.clone());
            (config, received)
        }
    }
    impl Drop for DesktopTest {
        fn drop(&mut self) {
            self.quit.view.stop();
            self.window.destroy();
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    #[test]
    #[ignore = "requires GTK and a private D-Bus session; exercised by linux-desktop CI"]
    fn deferred_close_remains_reachable_when_the_tray_is_lost_before_hide() {
        let desktop = DesktopTest::new();
        let (watcher, mut registrations) = Watcher::new();
        let (config, mut observed) = desktop.load_source(
            r#"
            import { host } from 'nsh';
            import { Window, Tray } from 'nsh/desktop';
            const main = Window.get('main');
            main.set({ closeOnPress: false });
            main.on('closePress', () => host.post('observed', 'close-pending'));
            host.on('continueHide', () => main.hide());
            Tray.set({ menu: [] });
            host.post('observed', 'loaded');
        "#,
        );
        assert_eq!(receive(&mut observed), serde_json::json!("loaded"));
        receive(&mut registrations).return_value(None);
        until(tray_registered);
        for _ in 0..2 {
            desktop.window.close();
            assert_eq!(receive(&mut observed), serde_json::json!("close-pending"));
        }
        watcher.release_name();
        until(|| !tray_registered());
        assert!(desktop.window.is_visible());

        let hidden = Rc::new(Cell::new(false));
        let notified = hidden.clone();
        desktop
            .window
            .connect_visible_notify(move |_| notified.set(true));
        for _ in 0..2 {
            hidden.set(false);
            config.host.send("continueHide", JsonValue::Null).unwrap();
            until(|| hidden.get());
            assert!(
                desktop.window.is_visible(),
                "a deferred hide stranded main after tray loss"
            );
            assert!(
                desktop.window.is_mapped(),
                "recovery must map main, not only set its visible flag"
            );
            assert!(!desktop.quit.detach.0.borrow().quitting);
        }
        gtk::prelude::WidgetExt::activate_action(&desktop.window, "app.quit", None).unwrap();
        assert!(
            desktop.app.windows().is_empty(),
            "reachability recovery resurrected Quit"
        );
        desktop.quit.detach.0.borrow().moving.send_replace(false);
        until(|| *desktop.quit.detach.0.borrow().done.borrow());
    }

    #[test]
    #[ignore = "requires GTK and a private D-Bus session; exercised by linux-desktop CI"]
    fn hidden_engine_keeps_host_state_and_secondary_windows_across_tray_reload() {
        let desktop = DesktopTest::new();
        let (watcher, mut registrations) = Watcher::new();
        let (config, mut observed) = desktop.load();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        receive(&mut registrations).return_value(None);
        until(tray_registered);
        until(|| {
            desktop.app.windows().len() == 2
                && desktop.window.title().as_deref() == Some("Resident ready")
        });
        let secondary = desktop
            .app
            .windows()
            .into_iter()
            .find(|w| w != desktop.window.upcast_ref::<gtk::Window>())
            .unwrap();
        until(|| secondary.is_visible());
        for cycle in 0..3 {
            if cycle == 1 {
                desktop
                    .window
                    .lookup_action("close")
                    .unwrap()
                    .activate(None);
            } else {
                desktop.window.close();
            }
            assert_eq!(
                receive(&mut observed),
                serde_json::json!({"kind":"hidden","count":cycle * 2 + 1})
            );
            until(|| !desktop.window.is_visible());
            assert!(!desktop.quit.detach.0.borrow().quitting);
            config.host.send("probe", JsonValue::Null).unwrap();
            assert_eq!(
                receive(&mut observed),
                serde_json::json!({"kind":"secondary","count":cycle * 2 + 2})
            );
            let title = format!("Probe {}", cycle * 2 + 2);
            until(|| secondary.title().as_deref() == Some(title.as_str()));
            assert!(secondary.is_visible());
            assert!(!desktop.window.is_visible());
            config.host.send("reopen", JsonValue::Null).unwrap();
            until(|| desktop.window.is_visible());
        }
        desktop.window.close();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"hidden","count":7})
        );
        until(|| !desktop.window.is_visible());

        desktop.quit.view.load_with_config(config.clone());
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        let pending = receive(&mut registrations);
        assert!(!tray_registered());
        assert!(
            !desktop.window.is_visible(),
            "a pending registration is not a failed registration"
        );
        pending.return_value(None);
        until(tray_registered);
        assert!(
            !desktop.window.is_visible(),
            "healthy hidden reload must stay hidden"
        );
        assert!(!desktop.app.windows().contains(&secondary));
        config.host.send("probe", JsonValue::Null).unwrap();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"secondary","count":1})
        );
        until(|| {
            desktop
                .app
                .windows()
                .iter()
                .any(|w| w.title().as_deref() == Some("Probe 1"))
        });

        // A retired engine's late refusal must not reveal its replacement.
        desktop.quit.view.load_with_config(config.clone());
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        let retired = receive(&mut registrations);
        desktop.quit.view.load_with_config(config.clone());
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        let current = receive(&mut registrations);
        retired.return_dbus_error("org.kde.StatusNotifierWatcher.Refused", "retired attempt");
        current.return_value(None);
        until(tray_registered);
        assert!(
            !desktop.window.is_visible(),
            "a stale reply restored a healthy hidden window"
        );

        // Losing a watcher before its answer must also restore reachability.
        desktop.quit.view.load_with_config(config.clone());
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        let retired = receive(&mut registrations);
        watcher.release_name();
        until(|| desktop.window.is_visible());
        assert!(!tray_registered());
        let (watcher, mut registrations) = Watcher::new();
        let current = receive(&mut registrations);
        retired.return_dbus_error("org.kde.StatusNotifierWatcher.Refused", "departed watcher");
        current.return_value(None);
        until(tray_registered);
        desktop.window.close();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"hidden","count":1})
        );
        until(|| !desktop.window.is_visible());

        // The watcher's refusal arrives only after load_with_config has returned.
        desktop.quit.view.load_with_config(config.clone());
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        let pending = receive(&mut registrations);
        assert!(!desktop.window.is_visible());
        pending.return_dbus_error(
            "org.kde.StatusNotifierWatcher.Refused",
            "registration refused",
        );
        until(|| desktop.window.is_visible());
        assert!(!tray_registered());

        desktop.quit.view.load_with_config(config.clone());
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        receive(&mut registrations).return_value(None);
        until(tray_registered);
        desktop.window.close();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"hidden","count":1})
        );
        until(|| !desktop.window.is_visible());
        drop(watcher);
        until(|| desktop.window.is_visible());
        assert!(
            !tray_registered(),
            "losing an accepted watcher must restore reachability"
        );

        // Reload hidden with no watcher before its loss callback is dispatched.
        let (watcher, mut registrations) = Watcher::new();
        receive(&mut registrations).return_value(None);
        until(tray_registered);
        desktop.window.close();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"hidden","count":2})
        );
        until(|| !desktop.window.is_visible());
        watcher.release_name();
        assert!(!desktop.window.is_visible());
        desktop.quit.view.load_with_config(config);
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        until(|| desktop.window.is_visible());
        desktop.window.close();
        assert!(
            desktop.app.windows().is_empty(),
            "no-tray close must destroy windows before detach"
        );
        assert!(!*desktop.quit.detach.0.borrow().done.borrow());
        desktop.quit.detach.0.borrow().moving.send_replace(false);
        until(|| *desktop.quit.detach.0.borrow().done.borrow());
    }

    #[test]
    #[ignore = "requires GTK and a private D-Bus session; exercised by linux-desktop CI"]
    fn application_quit_from_a_secondary_window_removes_windows_before_detach() {
        let desktop = DesktopTest::new();
        let (_config, mut observed) = desktop.load();
        assert_eq!(
            receive(&mut observed),
            serde_json::json!({"kind":"loaded","count":0})
        );
        until(|| desktop.app.windows().len() == 2);
        let secondary = desktop
            .app
            .windows()
            .into_iter()
            .find(|w| w != desktop.window.upcast_ref::<gtk::Window>())
            .unwrap();
        gtk::prelude::WidgetExt::activate_action(&secondary, "app.quit", None).unwrap();
        assert!(
            desktop.app.windows().is_empty(),
            "Quit left a blank frame during detach"
        );
        assert!(desktop.quit.detach.0.borrow().quitting);
        assert!(!*desktop.quit.detach.0.borrow().done.borrow());
        desktop.quit.detach.0.borrow().moving.send_replace(false);
        until(|| *desktop.quit.detach.0.borrow().done.borrow());
    }
}
