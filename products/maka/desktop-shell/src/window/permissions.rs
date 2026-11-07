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

//! Independent NSH setup windows. GPUI deliberately advertises no native
//! application-file drag source; that capability belongs to AppKit.

use maka_workbench::bindings::SystemPermissionWindow;
use nsh_engine::{EngineConfig, JsonValue, Limits};
use nsh_platform_gpui::{
    AppOptions, AppView, CloseRequest,
    gpui::{self, App, AppContext as _, Focusable as _, WindowHandle},
    titlebar_options,
};
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use tokio::sync::mpsc;

pub(super) enum Command {
    Close(uuid::Uuid),
    TextSize(uuid::Uuid, f32),
}

#[derive(Clone, Default)]
pub(super) struct Windows(Rc<RefCell<HashMap<String, (uuid::Uuid, WindowHandle<AppView>)>>>);

impl Windows {
    pub(super) fn open(
        &self,
        request: SystemPermissionWindow,
        commands: mpsc::UnboundedSender<Command>,
        parent: &EngineConfig,
        main: WindowHandle<AppView>,
        cx: &mut App,
    ) {
        let key = request.key().to_owned();
        let existing = self.0.borrow().get(&key).copied();
        if let Some((_, window)) = existing {
            if window
                .update(cx, |_, window, _| window.activate_window())
                .is_ok()
            {
                return;
            }
            self.0.borrow_mut().remove(&key);
        }
        let mut config = request.configuration();
        config.data_dir = parent.data_dir.clone();
        config.cache = parent.cache.clone();
        config.storage = parent.storage.clone();
        let mut params = config.host.params();
        params.insert("nativeApplicationDrag".into(), JsonValue::Bool(false));
        config.host.set_params(params);
        let id = uuid::Uuid::new_v4();
        let close = commands.clone();
        config
            .host
            .handle("computerPermissions.close", move |call| {
                if close.send(Command::Close(id)).is_ok() {
                    call.resolve(JsonValue::Null);
                } else {
                    call.reject("the setup window is closing");
                }
            });
        config.host.handle(
            "appearance.textSize",
            move |call| match call.data()["scale"].as_f64().map(|scale| scale as f32) {
                Some(scale) if scale.is_finite() && scale > 0.0 => {
                    if commands.send(Command::TextSize(id, scale)).is_ok() {
                        call.resolve(JsonValue::Null);
                    } else {
                        call.reject("the setup window is closing");
                    }
                }
                _ => call.reject("expected a finite positive text scale"),
            },
        );
        let size = gpui::size(gpui::px(560.0), gpui::px(640.0));
        let options = gpui::WindowOptions {
            window_bounds: Some(gpui::WindowBounds::Windowed(gpui::Bounds::centered(
                None, size, cx,
            ))),
            titlebar: Some(titlebar_options("Maka")),
            app_id: Some(crate::shell::APP_ID.into()),
            window_min_size: Some(gpui::size(gpui::px(480.0), gpui::px(520.0))),
            window_decorations: Some(gpui::WindowDecorations::Server),
            inactive_frame_interval: None,
            ..Default::default()
        };
        let closing = self.clone();
        let closing_key = key.clone();
        let data_dir = config.data_dir.clone();
        match cx.open_window(options, move |window, cx| {
            let view = cx.new(|cx| {
                AppView::new(
                    AppOptions {
                        app_id: crate::shell::APP_ID.into(),
                        title: "Maka".into(),
                        size: (560, 640),
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
            app.on_close_request(move |request, window, cx| {
                if request == CloseRequest::Quit {
                    let _ = main.update(cx, |_, main, _| main.remove_window());
                } else {
                    closing.0.borrow_mut().remove(&closing_key);
                    window.remove_window();
                }
            });
            app.load_with_config(config);
            #[cfg(target_os = "macos")]
            if let Err(error) = configure_macos_window(window) {
                eprintln!("maka-desktop-shell: permission window presentation: {error}");
            }
            window.focus(&app.focus_handle(cx), cx);
            view
        }) {
            Ok(window) => {
                self.0.borrow_mut().insert(key, (id, window));
            }
            Err(error) => eprintln!("maka-desktop-shell: cannot open permission setup: {error}"),
        }
    }

    pub(super) fn command(&self, command: Command, cx: &mut App) {
        match command {
            Command::Close(id) => self.close(id, cx),
            Command::TextSize(id, scale) => {
                let window = self
                    .0
                    .borrow()
                    .values()
                    .find_map(|(existing, window)| (*existing == id).then_some(*window));
                if let Some(window) = window {
                    let _ = window.update(cx, |view, _, cx| view.set_font_scale(Some(scale), cx));
                }
            }
        }
    }

    pub(super) fn close(&self, id: uuid::Uuid, cx: &mut App) {
        let key = self
            .0
            .borrow()
            .iter()
            .find_map(|(key, (existing, _))| (*existing == id).then(|| key.clone()));
        let Some(key) = key else {
            return;
        };
        let entry = self.0.borrow_mut().remove(&key);
        if let Some((_, window)) = entry {
            let _ = window.update(cx, |view, window, _| {
                view.stop();
                window.remove_window();
            });
        }
    }

    pub(super) fn close_all(&self, cx: &mut App) {
        let windows: Vec<_> = self
            .0
            .borrow_mut()
            .drain()
            .map(|(_, (_, window))| window)
            .collect();
        for window in windows {
            let _ = window.update(cx, |view, window, _| {
                view.stop();
                window.remove_window();
            });
        }
    }
}

#[cfg(target_os = "macos")]
fn configure_macos_window(window: &gpui::Window) -> Result<(), String> {
    use nsh_platform_macos::objc2_app_kit::{NSView, NSWindowButton};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = HasWindowHandle::window_handle(window).map_err(|error| error.to_string())?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err("the macOS child has no AppKit window handle".into());
    };
    // SAFETY: this borrowed GPUI Window owns the live NSView. The child-window
    // builder runs on AppKit's main thread; this reference never leaves the call.
    let view = unsafe { &*handle.ns_view.as_ptr().cast::<NSView>() };
    let window = view
        .window()
        .ok_or("the child view is not attached to its window")?;
    crate::permission_window::configure(&window);
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
    Ok(())
}
