/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
//! A persistent, nonactivating GPUI panel with its own JS event channel.
use nsh_engine::{EngineConfig, HostCall, HostChannel, JsonValue, Limits};
use nsh_platform_gpui::{
    AppOptions, AppView,
    gpui::{self, AppContext as _, Focusable as _},
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub enum Request {
    Load(Box<EngineConfig>),
    Shortcut(JsonValue),
    Error(JsonValue),
    Show { settings: bool },
    Settings(HostCall, bool),
    Hide,
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
    pub fn run(
        self,
        mut requests: mpsc::Receiver<Request>,
        main: gpui::WindowHandle<AppView>,
        cx: &mut gpui::App,
    ) {
        cx.spawn(async move |cx| {
            let mut panel: Option<gpui::WindowHandle<AppView>> = None;
            let mut events = HostChannel::new();
            let mut _dismiss_observers = None;
            let visible = std::rc::Rc::new(std::cell::Cell::new(false));
            let picking = std::rc::Rc::new(std::cell::Cell::new(false));
            let mut preferences = JsonValue::Null;
            while let Some(request) = requests.recv().await {
                match request {
                    Request::Load(mut config) => {
                        _dismiss_observers = None;
                        if let Some(old) = panel.take() {
                            let _ = old.update(cx, |_, window, _| window.remove_window());
                        }
                        visible.set(false);
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
                            match send.try_send(Request::Hide) {
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
                        let (active, foreground) = tokio::sync::watch::channel(false);
                        config.context =
                            config.context.with(maka_workbench::Foreground(foreground));
                        let close = self.send.clone();
                        let opened = cx.update(|cx| {
                            let bounds = gpui::Bounds::centered(
                                None,
                                gpui::size(gpui::px(680.), gpui::px(400.)),
                                cx,
                            );
                            cx.open_window(
                                gpui::WindowOptions {
                                    window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                                    kind: gpui::WindowKind::PopUp,
                                    titlebar: None,
                                    is_minimizable: false,
                                    focus: false,
                                    show: false,
                                    is_resizable: false,
                                    is_movable: false,
                                    ..Default::default()
                                },
                                |window, cx| {
                                    let view = cx.new(|cx| {
                                        AppView::new(
                                            AppOptions {
                                                app_id: "org.apache.maka.quick-tools".into(),
                                                title: "Maka Quick Tools".into(),
                                                size: (680, 400),
                                                limits: Limits::standalone(),
                                                data_dir: config.data_dir.clone(),
                                                ..Default::default()
                                            },
                                            window,
                                            cx,
                                        )
                                    });
                                    let app = view.read(cx);
                                    app.own_window(window, cx);
                                    app.on_close_request(move |_, window, _| {
                                        hide(window);
                                        let _ = close.try_send(Request::Hide);
                                    });
                                    app.load_with_config(*config);
                                    view
                                },
                            )
                        });
                        match opened {
                            Ok(window) => {
                                let shown = visible.clone();
                                let dialog = picking.clone();
                                let channel = events.clone();
                                let _ = window.update(cx, |_, window, cx| {
                                    let shown_on_event = shown.clone();
                                    let dialog_on_event = dialog.clone();
                                    let send = self.send.clone();
                                    with_native_window(window, |native| {
                                        let number: isize =
                                            unsafe { objc2::msg_send![native, windowNumber] };
                                        _dismiss_observers =
                                            Some(super::dismiss::DismissObservers::new(
                                                number,
                                                move || {
                                                    if shown_on_event.get()
                                                        && !dialog_on_event.get()
                                                    {
                                                        let _ = send.try_send(Request::Hide);
                                                    }
                                                },
                                            ));
                                    });
                                    active.send_replace(window.is_window_active());
                                    cx.observe_window_activation(window, move |_, window, _| {
                                        let focused = window.is_window_active();
                                        let was_focused = active.send_replace(focused);
                                        if was_focused
                                            && !focused
                                            && !dialog.get()
                                            && shown.replace(false)
                                        {
                                            hide(window);
                                            let _ = channel.send(
                                                "quickTools.visibility",
                                                json!({"visible":false}),
                                            );
                                        }
                                    })
                                    .detach();
                                });
                                panel = Some(window);
                            }
                            Err(error) => eprintln!("Quick Tools window: {error}"),
                        }
                    }
                    Request::Shortcut(message) => {
                        let source = message["source"].clone();
                        let id = message["id"].as_str().unwrap_or("toggle");
                        let show = id != "toggle" || !visible.get();
                        visible.set(show);
                        let _ = events.send(
                            "quickTools.visibility",
                            json!({"visible":show,"source":source,"home":show && id == "toggle"}),
                        );
                        if let Some(panel) = panel {
                            let _ = panel.update(cx, |view, window, cx| {
                                if show {
                                    position(window, None);
                                    window.activate_window();
                                    window.focus(&view.focus_handle(cx), cx);
                                } else {
                                    hide(window);
                                }
                            });
                        }
                        if id != "toggle" {
                            let _ = events.send("quickTools.execute", json!({"id":id}));
                        }
                    }
                    Request::Show { settings } => {
                        visible.set(true);
                        let _ = events.send(
                            "quickTools.visibility",
                            json!({"visible":true,"home":true,"settings":settings}),
                        );
                        if let Some(panel) = panel {
                            let _ = panel.update(cx, |view, window, cx| {
                                position(window, None);
                                window.activate_window();
                                window.focus(&view.focus_handle(cx), cx);
                            });
                        }
                    }
                    Request::Hide => {
                        visible.set(false);
                        let _ = events.send("quickTools.visibility", json!({"visible":false}));
                        if let Some(panel) = panel {
                            let _ = panel.update(cx, |_, window, _| hide(window));
                        }
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
                        if let Some(panel) = panel {
                            match gpui::AnyWindowHandle::from(panel).update(cx, |_, window, cx| {
                                position(window, Some(height as f64));
                                // AppKit resizes synchronously while this GPUI window is borrowed.
                                // Refresh its viewport after the native frame has been set.
                                window.bounds_changed(cx);
                            }) {
                                Ok(()) => call.resolve(JsonValue::Null),
                                Err(error) => call.reject(error.to_string()),
                            }
                        } else {
                            call.reject("Quick Tools window is unavailable");
                        }
                    }
                    Request::Settings(call, from_panel) => {
                        let destination = if from_panel {
                            self.main.lock().unwrap_or_else(|e| e.into_inner()).clone()
                        } else {
                            panel.map(|_| events.clone())
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
                        let (reply, receive) = tokio::sync::oneshot::channel();
                        self.releases
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(token.clone(), reply);
                        let sent = channel.send(
                            "quickTools.session.release",
                            json!({"sessionId":id,"token":token}),
                        );
                        let settled = self
                            .runtime
                            .spawn(async move {
                                tokio::time::timeout(std::time::Duration::from_secs(10), receive)
                                    .await
                            })
                            .await;
                        self.releases
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&token);
                        if sent.is_ok() && matches!(settled, Ok(Ok(Ok(true)))) {
                            call.resolve(json!(true));
                        } else {
                            call.reject(
                                "The other window could not save and release this conversation",
                            );
                        }
                    }
                    Request::PickPackage(call) => {
                        picking.set(true);
                        let choice = cx
                            .update(|cx| {
                                cx.prompt_for_paths(gpui::PathPromptOptions {
                                    files: true,
                                    directories: false,
                                    multiple: false,
                                    prompt: None,
                                })
                            })
                            .await;
                        picking.set(false);
                        match choice {
                            Ok(Ok(Some(paths))) if !paths.is_empty() => {
                                let file = paths[0].clone();
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
                            Ok(Ok(_)) => call.resolve(JsonValue::Null),
                            Ok(Err(error)) => call.reject(error.to_string()),
                            Err(error) => call.reject(error.to_string()),
                        }
                    }
                    Request::Assistant(call) => {
                        if let Some(channel) =
                            self.main.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                        {
                            let _ = channel.send("quickTools.assistant", call.data().clone());
                            let _ = main.update(cx, |_, window, cx| {
                                cx.activate(true);
                                window.activate_window();
                            });
                            call.resolve(json!(true));
                        } else {
                            call.reject("Main window is unavailable");
                        }
                    }
                }
            }
        })
        .detach();
    }
}
// Keep the search bar anchored while taller pages expand downwards.
fn position(window: &gpui::Window, height: Option<f64>) {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    with_native_window(window, |native| unsafe {
        let screen: *mut objc2::runtime::AnyObject = objc2::msg_send![native, screen];
        if screen.is_null() {
            return;
        }
        let area: NSRect = objc2::msg_send![screen, visibleFrame];
        let current: NSRect = objc2::msg_send![native, frame];
        let height = height.unwrap_or(current.size.height).min(area.size.height);
        let width = 680_f64.min(area.size.width);
        let inset = ((area.size.height - 400.) / 2.)
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
            let _: () = objc2::msg_send![native, setFrame: frame, display: true];
        }
    });
}

fn hide(window: &gpui::Window) {
    with_native_window(window, |native| unsafe {
        let _: () =
            objc2::msg_send![native, orderOut: std::ptr::null::<objc2::runtime::AnyObject>()];
    });
}

fn with_native_window(window: &gpui::Window, f: impl FnOnce(*mut objc2::runtime::AnyObject)) {
    use raw_window_handle::RawWindowHandle;
    if let Ok(handle) = raw_window_handle::HasWindowHandle::window_handle(window) {
        if let RawWindowHandle::AppKit(handle) = handle.as_raw() {
            // SAFETY: GPUI owns this live NSView; only the UI-thread callbacks above call us.
            unsafe {
                let view = handle.ns_view.as_ptr().cast::<objc2::runtime::AnyObject>();
                let native: *mut objc2::runtime::AnyObject = objc2::msg_send![view, window];
                if !native.is_null() {
                    f(native);
                }
            }
        }
    }
}
