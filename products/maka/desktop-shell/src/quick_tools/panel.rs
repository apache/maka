/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
//! A persistent, nonactivating AppKit panel with its own JS event channel.
//!
//! Requests are ordered by one Tokio task. Everything that touches the panel
//! window hops to AppKit's main thread, where the panel and its engine live.
use nsh_engine::{EngineConfig, HostCall, HostChannel, JsonValue, Limits};
use nsh_platform_macos::{AppOptions, AppView, with_running_view};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSBackingStoreType, NSModalResponse,
    NSModalResponseOK, NSOpenPanel, NSPanel, NSResponder, NSRunningApplication, NSWindow,
    NSWindowAnimationBehavior, NSWindowButton, NSWindowCollectionBehavior, NSWindowStyleMask,
    NSWindowTitleVisibility, NSWorkspace,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot, watch};

const WIDTH: f64 = 680.;
const HEIGHT: f64 = 400.;
/// AppKit's pop-up menu level: above the user's other windows, like Spotlight.
const POP_UP_LEVEL: isize = 101;

pub enum Request {
    Load(Box<EngineConfig>),
    Shortcut(JsonValue),
    Error(JsonValue),
    Show {
        settings: bool,
    },
    Settings(HostCall, bool),
    Hide {
        restore_focus: bool,
    },
    /// The panel stopped being the key window.
    Resigned,
    Modifiers(JsonValue),
    Assistant(HostCall),
    PickPackage(HostCall),
    Claim(HostCall, bool),
    Preferences(HostCall, bool),
    ReadPreferences(HostCall),
    Resize(HostCall),
}
#[derive(Clone)]
pub struct Control {
    send: mpsc::Sender<Request>,
    main: Arc<Mutex<Option<HostChannel>>>,
    shortcuts: mpsc::Sender<HostCall>,
    runtime: tokio::runtime::Handle,
    releases: Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    state: Arc<Shared>,
}

/// What the request task and the main thread both read.
#[derive(Default)]
struct Shared {
    visible: AtomicBool,
    /// A file dialog is open; losing key status to it does not dismiss the panel.
    picking: AtomicBool,
}

impl Control {
    pub fn new(
        runtime: &tokio::runtime::Handle,
        directory: std::path::PathBuf,
    ) -> (Self, mpsc::Receiver<Request>) {
        let (send, receive) = mpsc::channel(64);
        let shortcuts = super::shortcuts::start(runtime, directory, send.clone());
        (
            Self {
                send,
                main: Arc::default(),
                shortcuts,
                runtime: runtime.clone(),
                releases: Arc::default(),
                state: Arc::default(),
            },
            receive,
        )
    }
    fn session_handlers(&self, host: &HostChannel, panel: bool) {
        let send = self.send.clone();
        host.handle("quickTools.settings", move |call| {
            if let Err(error) = send.try_send(Request::Settings(call, panel)) {
                if let Request::Settings(call, _) = error.into_inner() {
                    call.reject("Quick Tools is busy");
                }
            }
        });
        if panel {
            let send = self.send.clone();
            host.handle("quickTools.resize", move |call| {
                if let Err(error) = send.try_send(Request::Resize(call)) {
                    if let Request::Resize(call) = error.into_inner() {
                        call.reject("Quick Tools is busy");
                    }
                }
            });
        }

        let update = self.send.clone();
        host.handle("quickTools.preferences.update", move |call| {
            if let Err(error) = update.try_send(Request::Preferences(call, panel)) {
                if let Request::Preferences(call, _) = error.into_inner() {
                    call.reject("Preference synchronization is busy");
                }
            }
        });
        let read = self.send.clone();
        host.handle("quickTools.preferences.read", move |call| {
            if let Err(error) = read.try_send(Request::ReadPreferences(call)) {
                if let Request::ReadPreferences(call) = error.into_inner() {
                    call.reject("Preference synchronization is busy");
                }
            }
        });
        let send = self.send.clone();
        host.handle("quickTools.session.claim", move |call| {
            if let Err(error) = send.try_send(Request::Claim(call, panel)) {
                if let Request::Claim(call, _) = error.into_inner() {
                    call.reject("Session transfer is busy");
                }
            }
        });
        let releases = self.releases.clone();
        host.handle("quickTools.session.reply", move |call| {
            if let Some(token) = call.data()["token"].as_str() {
                if let Some(reply) = releases
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(token)
                {
                    let _ = reply.send(call.data()["ok"] == true);
                }
            }
            call.resolve(JsonValue::Null);
        });
    }
    /// Connects the main workbench's configuration, and (re)loads the panel
    /// for the connection it belongs to.
    pub fn attach(&self, config: &mut EngineConfig) {
        self.session_handlers(&config.host, false);
        let mut params = config.host.params();
        params.insert("nativeQuickTools".into(), json!(true));
        config.host.set_params(params);
        *self.main.lock().unwrap_or_else(|e| e.into_inner()) = Some(config.host.clone());
        let send = self.send.clone();
        config.host.handle("quickTools.show", move |call| {
            match send.try_send(Request::Show {
                settings: call.data()["settings"] == true,
            }) {
                Ok(()) => call.resolve(JsonValue::Null),
                Err(_) => call.reject("Quick Tools is busy"),
            }
        });
        let _ = self.send.try_send(Request::Load(Box::new(config.clone())));
    }
    pub fn run(self, mut requests: mpsc::Receiver<Request>) {
        let runtime = self.runtime.clone();
        runtime.spawn(async move {
            let state = self.state.clone();
            let mut loaded = false;
            let mut events = HostChannel::new();
            let mut preferences = JsonValue::Null;
            while let Some(request) = requests.recv().await {
                match request {
                    Request::Load(mut config) => {
                        state.visible.store(false, Ordering::Release);
                        // HostChannel::clone shares a single engine attachment. Never clone the main
                        // channel into a second VM: it would steal events from the workbench.
                        config.host = HostChannel::new();
                        config.host.set_params(
                            serde_json::from_value(json!({"quickToolsPanel":true})).unwrap(),
                        );
                        maka_workbench::quick_tools::attach(&mut config);
                        super::attach(&mut config);
                        let send = self.send.clone();
                        config.host.handle("quickTools.hide", move |call| {
                            match send.try_send(Request::Hide {
                                restore_focus: true,
                            }) {
                                Ok(()) => call.resolve(JsonValue::Null),
                                Err(_) => call.reject("Quick Tools is busy"),
                            }
                        });
                        let send = self.send.clone();
                        config.host.handle("quickTools.assistant", move |call| {
                            if let Err(error) = send.try_send(Request::Assistant(call)) {
                                if let Request::Assistant(call) = error.into_inner() {
                                    call.reject("Quick Tools is busy");
                                }
                            }
                        });
                        let picker = self.send.clone();
                        config.host.handle("quickTools.package.pick", move |call| {
                            if let Err(error) = picker.try_send(Request::PickPackage(call)) {
                                if let Request::PickPackage(call) = error.into_inner() {
                                    call.reject("Quick Tools is busy");
                                }
                            }
                        });
                        let shortcuts = self.shortcuts.clone();
                        config
                            .host
                            .handle("quickTools.shortcuts.configure", move |call| {
                                if let Err(error) = shortcuts.try_send(call) {
                                    error.into_inner().reject("Shortcut helper is busy");
                                }
                            });
                        self.session_handlers(&config.host, true);
                        events = config.host.clone();
                        let (active, foreground) = watch::channel(false);
                        config.context =
                            config.context.with(maka_workbench::Foreground(foreground));
                        let send = self.send.clone();
                        let state = state.clone();
                        on_main(move || open(*config, active, send, state));
                        loaded = true;
                    }
                    Request::Shortcut(message) => {
                        let source = message["source"].clone();
                        let id = message["id"].as_str().unwrap_or("toggle").to_owned();
                        let show = id != "toggle" || !state.visible.load(Ordering::Acquire);
                        state.visible.store(show, Ordering::Release);
                        let _ = events.send(
                            "quickTools.visibility",
                            json!({"visible":show,"source":source,"home":show && id == "toggle"}),
                        );
                        on_main(move || {
                            with_panel(|panel| {
                                if show {
                                    panel.present();
                                } else {
                                    panel.dismiss();
                                }
                            });
                        });
                        if id != "toggle" {
                            let _ = events.send("quickTools.execute", json!({"id":id}));
                        }
                    }
                    Request::Show { settings } => {
                        state.visible.store(true, Ordering::Release);
                        let _ = events.send(
                            "quickTools.visibility",
                            json!({"visible":true,"home":true,"settings":settings}),
                        );
                        on_main(|| {
                            with_panel(Panel::present);
                        });
                    }
                    Request::Hide { restore_focus } => {
                        state.visible.store(false, Ordering::Release);
                        let _ = events.send("quickTools.visibility", json!({"visible":false}));
                        on_main(move || {
                            with_panel(|panel| {
                                if !restore_focus {
                                    panel.previous_app.set(None);
                                }
                                panel.dismiss();
                            });
                        });
                    }
                    Request::Resigned => {
                        if !state.visible.load(Ordering::Acquire)
                            || state.picking.load(Ordering::Acquire)
                        {
                            continue;
                        }
                        // Ordering and focusing the panel can briefly resign key status.
                        // The hop to the main thread checks again once AppKit finishes.
                        let state = state.clone();
                        let channel = events.clone();
                        on_main(move || {
                            with_panel(|panel| {
                                if !panel.window.isKeyWindow()
                                    && !state.picking.load(Ordering::Acquire)
                                    && state.visible.swap(false, Ordering::AcqRel)
                                {
                                    panel.window.orderOut(None);
                                    let _ = channel
                                        .send("quickTools.visibility", json!({"visible":false}));
                                }
                            });
                        });
                    }
                    Request::Error(value) => {
                        let _ = events.send("quickTools.error", value);
                    }
                    Request::Modifiers(value) => {
                        let _ = events.send("quickTools.modifiers", value);
                    }
                    Request::Resize(call) => {
                        let Some(height) = call.data()["height"]
                            .as_u64()
                            .filter(|height| (180..=800).contains(height))
                        else {
                            call.reject("Invalid Quick Tools height");
                            continue;
                        };
                        on_main(move || {
                            let resized = with_panel(|panel| {
                                position(&panel.window, Some(height as f64));
                            });
                            match resized {
                                Some(()) => call.resolve(JsonValue::Null),
                                None => call.reject("Quick Tools window is unavailable"),
                            }
                        });
                    }
                    Request::Settings(call, from_panel) => {
                        let destination = if from_panel {
                            self.main.lock().unwrap_or_else(|e| e.into_inner()).clone()
                        } else {
                            loaded.then(|| events.clone())
                        };
                        let result = destination
                            .ok_or_else(|| "Quick Tools is unavailable".to_string())
                            .and_then(|channel| {
                                channel.send("quickTools.settings", call.data().clone())
                            });
                        match result {
                            Ok(()) => call.resolve(JsonValue::Null),
                            Err(error) => call.reject(error),
                        }
                    }
                    Request::ReadPreferences(call) => call.resolve(preferences.clone()),
                    Request::Preferences(call, from_panel) => {
                        let value = call.data();
                        if !value.is_object() || value.to_string().len() > 8192 {
                            call.reject("Invalid preferences");
                            continue;
                        }
                        preferences = value.clone();
                        let channel = if from_panel {
                            self.main.lock().unwrap_or_else(|e| e.into_inner()).clone()
                        } else {
                            Some(events.clone())
                        };
                        if let Some(channel) = channel {
                            let _ = channel.send("quickTools.preferences", preferences.clone());
                        }
                        call.resolve(JsonValue::Null);
                    }
                    Request::Claim(call, from_panel) => {
                        let Some(id) = call.data()["sessionId"].as_str() else {
                            call.reject("Expected session ID");
                            continue;
                        };
                        let channel = if from_panel {
                            self.main.lock().unwrap_or_else(|e| e.into_inner()).clone()
                        } else {
                            Some(events.clone())
                        };
                        let Some(channel) = channel else {
                            call.reject("Other window is unavailable");
                            continue;
                        };
                        let token = uuid::Uuid::new_v4().to_string();
                        let (reply, receive) = oneshot::channel();
                        self.releases
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(token.clone(), reply);
                        let sent = channel.send(
                            "quickTools.session.release",
                            json!({"sessionId":id,"token":token}),
                        );
                        let settled =
                            tokio::time::timeout(std::time::Duration::from_secs(10), receive).await;
                        self.releases
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&token);
                        if sent.is_ok() && matches!(settled, Ok(Ok(true))) {
                            call.resolve(json!(true));
                        } else {
                            call.reject(
                                "The other window could not save and release this conversation",
                            );
                        }
                    }
                    Request::PickPackage(call) => {
                        state.picking.store(true, Ordering::Release);
                        let (chosen, choice) = oneshot::channel();
                        on_main(move || choose_file(chosen));
                        let choice = choice.await;
                        state.picking.store(false, Ordering::Release);
                        match choice {
                            Ok(Some(file)) => {
                                let result = self
                                    .runtime
                                    .spawn_blocking(move || -> Result<String, String> {
                                        use std::io::Read;
                                        let mut bytes = Vec::new();
                                        std::fs::File::open(file)
                                            .map_err(|e| e.to_string())?
                                            .take(9 * 1024 * 1024 + 1)
                                            .read_to_end(&mut bytes)
                                            .map_err(|e| e.to_string())?;
                                        if bytes.len() > 9 * 1024 * 1024 {
                                            return Err("Plugin package exceeds 9 MiB".into());
                                        }
                                        String::from_utf8(bytes).map_err(|e| e.to_string())
                                    })
                                    .await;
                                match result {
                                    Ok(Ok(text)) => call.resolve(json!(text)),
                                    Ok(Err(error)) => call.reject(error),
                                    Err(error) => call.reject(error.to_string()),
                                }
                            }
                            Ok(None) => call.resolve(JsonValue::Null),
                            Err(_) => call.reject("The file dialog is unavailable"),
                        }
                    }
                    Request::Assistant(call) => {
                        if let Some(channel) =
                            self.main.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                        {
                            let _ = channel.send("quickTools.assistant", call.data().clone());
                            with_running_view(|view| {
                                let Some(mtm) = MainThreadMarker::new() else {
                                    return;
                                };
                                NSApplication::sharedApplication(mtm).activate();
                                if let Some(window) = view.view().window() {
                                    if window.isMiniaturized() {
                                        window.deminiaturize(None);
                                    }
                                    window.makeKeyAndOrderFront(None);
                                }
                            });
                            call.resolve(json!(true));
                        } else {
                            call.reject("Main window is unavailable");
                        }
                    }
                }
            }
        });
    }
}

/// Closes the panel and stops its engine. The main-thread barrier between
/// connections and the end of the app call this, so no engine outlives its Host.
pub fn close_all() {
    if let Some(panel) = PANEL.with(|panel| panel.borrow_mut().take()) {
        panel.view.stop();
        panel.window.orderOut(None);
    }
}

/// Runs `f` on AppKit's main thread while the workbench runs.
fn on_main(f: impl FnOnce() + Send + 'static) {
    with_running_view(move |_| f());
}

struct Panel {
    window: Retained<QuickPanel>,
    view: Rc<AppView>,
    _dismiss: super::dismiss::DismissObservers,
    /// The app to give focus back to when the panel is dismissed.
    previous_app: Cell<Option<i32>>,
}

thread_local! {
    static PANEL: RefCell<Option<Panel>> = const { RefCell::new(None) };
}

fn with_panel<T>(f: impl FnOnce(&Panel) -> T) -> Option<T> {
    PANEL.with(|panel| panel.borrow().as_ref().map(f))
}

struct PanelIvars {
    active: watch::Sender<bool>,
    send: mpsc::Sender<Request>,
}

define_class!(
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MakaQuickToolsPanel"]
    #[ivars = PanelIvars]
    struct QuickPanel;
    unsafe impl NSObjectProtocol for QuickPanel {}
    impl QuickPanel {
        // A panel without a visible title bar still takes the keyboard.
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { true }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool { true }
        #[unsafe(method(becomeKeyWindow))]
        fn become_key_window(&self) {
            // SAFETY: NSWindow's implementation on this window's main thread.
            unsafe { let _: () = msg_send![super(self), becomeKeyWindow]; }
            self.ivars().active.send_replace(true);
        }
        #[unsafe(method(resignKeyWindow))]
        fn resign_key_window(&self) {
            // SAFETY: NSWindow's implementation on this window's main thread.
            unsafe { let _: () = msg_send![super(self), resignKeyWindow]; }
            if self.ivars().active.send_replace(false) {
                let _ = self.ivars().send.try_send(Request::Resigned);
            }
        }
        // Command-W hides the panel; it lives as long as its connection.
        #[unsafe(method(performClose:))]
        fn perform_close(&self, _sender: Option<&NSObject>) {
            let _ = self.ivars().send.try_send(Request::Hide { restore_focus: true });
        }
    }
);

fn open(
    config: EngineConfig,
    active: watch::Sender<bool>,
    send: mpsc::Sender<Request>,
    state: Arc<Shared>,
) {
    close_all();
    let mtm = MainThreadMarker::new().expect("the Quick Tools panel runs on AppKit's main thread");
    let options = AppOptions {
        app_id: "org.apache.maka.quick-tools".into(),
        title: "Maka Quick Tools".into(),
        size: (WIDTH as i32, HEIGHT as i32),
        limits: Limits::standalone(),
        data_dir: config.data_dir.clone(),
        ..Default::default()
    };
    let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(WIDTH, HEIGHT));
    let dismiss_send = send.clone();
    let allocated = QuickPanel::alloc(mtm).set_ivars(PanelIvars { active, send });
    // SAFETY: NSWindow's designated initializer for our initialized subclass.
    let window: Retained<QuickPanel> = unsafe {
        msg_send![
            super(allocated),
            initWithContentRect: frame,
            styleMask: NSWindowStyleMask::Titled
                | NSWindowStyleMask::FullSizeContentView
                | NSWindowStyleMask::NonactivatingPanel,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    // SAFETY: PANEL owns the window until close_all drops it.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str(&options.title));
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
    window.setMovable(false);
    // The panel hides itself when it loses focus; AppKit hiding it behind our
    // back on deactivation would leave the visibility state stale.
    window.setHidesOnDeactivate(false);
    window.setLevel(POP_UP_LEVEL);
    window.setAnimationBehavior(NSWindowAnimationBehavior::UtilityWindow);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    let view = AppView::new(mtm, options);
    window.setContentView(Some(&view.view()));
    view.load_with_config(config);
    let dismiss = super::dismiss::DismissObservers::new(window.windowNumber(), move || {
        if state.visible.load(Ordering::Acquire) && !state.picking.load(Ordering::Acquire) {
            let _ = dismiss_send.try_send(Request::Hide {
                restore_focus: false,
            });
        }
    });
    PANEL.with(|panel| {
        *panel.borrow_mut() = Some(Panel {
            window,
            view,
            _dismiss: dismiss,
            previous_app: Cell::new(None),
        });
    });
}

impl Panel {
    // AppKit activates both the key and main windows. Assign both roles to the
    // panel first so the workbench keeps its place behind the user's other windows.
    fn present(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSRunningApplication::currentApplication();
        if let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() {
            if front.processIdentifier() != app.processIdentifier() {
                self.previous_app.set(Some(front.processIdentifier()));
            } else if !self.window.isKeyWindow() {
                self.previous_app.set(None);
            }
        }
        position(&self.window, None);
        self.window.makeKeyAndOrderFront(None);
        self.window.makeMainWindow();
        NSApplication::sharedApplication(mtm).activate();
        if let Some(root) = self.view.view().subviews().firstObject() {
            self.window.makeFirstResponder(Some(&root));
        }
    }

    fn dismiss(&self) {
        if let Some(pid) = self.previous_app.take() {
            if NSRunningApplication::currentApplication().isActive() && self.window.isKeyWindow() {
                if let Some(app) =
                    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
                {
                    app.activateWithOptions(NSApplicationActivationOptions::empty());
                }
            }
        }
        self.window.orderOut(None);
    }
}

// Keep the search bar anchored while taller pages expand downwards.
fn position(window: &NSWindow, height: Option<f64>) {
    let Some(screen) = window.screen() else {
        return;
    };
    let area = screen.visibleFrame();
    let current = window.frame();
    let height = height.unwrap_or(current.size.height).min(area.size.height);
    let width = WIDTH.min(area.size.width);
    let inset = ((area.size.height - HEIGHT) / 2.)
        .min(area.size.height - 560.)
        .max(0.);
    let frame = NSRect::new(
        NSPoint::new(
            area.origin.x + (area.size.width - width) / 2.,
            area.origin.y + area.size.height - inset - height,
        ),
        NSSize::new(width, height),
    );
    if frame != current {
        window.setFrame_display(frame, true);
    }
}

/// Asks for one plugin package. The dialog sits above the panel's level.
/// Runs the package picker as a sheet on the panel. A sheet needs no application
/// activation, so the main window stays put, and AppKit returns key status to
/// the panel when the sheet ends; the queued resign then finds a key panel.
fn choose_file(done: oneshot::Sender<Option<PathBuf>>) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = done.send(None);
        return;
    };
    let Some(window) = with_panel(|panel| panel.window.clone()) else {
        let _ = done.send(None);
        return;
    };
    let dialog = NSOpenPanel::openPanel(mtm);
    dialog.setCanChooseFiles(true);
    dialog.setCanChooseDirectories(false);
    dialog.setAllowsMultipleSelection(false);
    let done = Cell::new(Some(done));
    let chosen = dialog.clone();
    let handler = block2::RcBlock::new(move |response: NSModalResponse| {
        let file = (response == NSModalResponseOK)
            .then(|| chosen.URL().and_then(|url| url.path()))
            .flatten()
            .map(|path| PathBuf::from(path.to_string()));
        if let Some(done) = done.take() {
            let _ = done.send(file);
        }
    });
    dialog.beginSheetModalForWindow_completionHandler(&window, &handler);
}
