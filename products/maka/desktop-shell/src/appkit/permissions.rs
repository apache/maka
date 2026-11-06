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

//! Permission setup windows and their application-file drag source. Paths only
//! enter through the verified workbench request, never component props.

use maka_workbench::bindings::SystemPermissionWindow;
use nsh_engine::{EngineConfig, JsonValue};
use nsh_platform_macos::{
    AppOptions, AppView,
    objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained},
    objc2_app_kit::{
        NSBackingStoreType, NSResponder, NSWindow, NSWindowButton, NSWindowStyleMask,
        NSWindowTitleVisibility,
    },
    objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString},
};
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

struct SetupWindow {
    window: Retained<PermissionWindow>,
    view: Rc<AppView>,
}

thread_local! {
    static WINDOWS: RefCell<HashMap<String, SetupWindow>> = RefCell::new(HashMap::new());
}

define_class!(
    #[unsafe(super(NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MakaPermissionSetupWindow"]
    #[ivars = String]
    struct PermissionWindow;
    unsafe impl NSObjectProtocol for PermissionWindow {}
    impl PermissionWindow {
        #[unsafe(method(close))]
        fn close_window(&self) {
            // Keep the window and engine alive through AppKit's close callback.
            let removed = WINDOWS.with(|windows| windows.borrow_mut().remove(self.ivars()));
            if let Some(removed) = &removed { removed.view.stop(); }
            // SAFETY: NSWindow's close implementation on this window's main thread.
            unsafe { let _: () = msg_send![super(self), close]; }
        }
        #[unsafe(method(cancelOperation:))]
        fn cancel_operation(&self, _sender: Option<&NSObject>) { self.close(); }
    }
);

pub(super) fn open(request: SystemPermissionWindow, alive: Arc<AtomicBool>, parent: &EngineConfig) {
    let key = request.key().to_owned();
    if WINDOWS.with(|windows| {
        let windows = windows.borrow();
        if let Some(existing) = windows.get(&key) {
            if existing.window.isMiniaturized() {
                existing.window.deminiaturize(None);
            }
            existing.window.makeKeyAndOrderFront(None);
            true
        } else {
            false
        }
    }) {
        return;
    }
    let mtm = MainThreadMarker::new().expect("permission windows run on AppKit's main thread");
    let mut config = request.configuration();
    config.data_dir = parent.data_dir.clone();
    config.cache = parent.cache.clone();
    config.storage = parent.storage.clone();
    let options = AppOptions {
        app_id: crate::shell::APP_ID.into(),
        title: "Maka".into(),
        size: (560, 640),
        data_dir: config.data_dir.clone(),
        ..Default::default()
    };
    let native_drag = match request.application() {
        Some(application) => match crate::permission_application::register(
            &options.components,
            mtm,
            application,
            alive.clone(),
        ) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("maka-desktop-shell: permission application: {error}");
                false
            }
        },
        None => false,
    };
    let mut params = config.host.params();
    params.insert("nativeApplicationDrag".into(), JsonValue::Bool(native_drag));
    config.host.set_params(params);
    let resizing = key.clone();
    let resize_alive = alive.clone();
    config.host.handle(
        "appearance.textSize",
        move |call| match call.data()["scale"].as_f64().map(|scale| scale as f32) {
            Some(scale) if scale.is_finite() && scale > 0.0 => {
                let key = resizing.clone();
                let alive = resize_alive.clone();
                nsh_platform_macos::with_running_view(move |_| {
                    if alive.load(Ordering::Acquire) {
                        WINDOWS.with(|windows| {
                            if let Some(window) = windows.borrow().get(&key) {
                                window.view.set_font_scale(Some(scale));
                            }
                        });
                    }
                });
                call.resolve(JsonValue::Null);
            }
            _ => call.reject("expected a finite positive text scale"),
        },
    );
    let closing = key.clone();
    config
        .host
        .handle("computerPermissions.close", move |call| {
            let key = closing.clone();
            let alive = alive.clone();
            nsh_platform_macos::with_running_view(move |_| {
                if alive.load(Ordering::Acquire) {
                    close(&key);
                }
            });
            call.resolve(JsonValue::Null);
        });
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(560.0, 640.0));
    let allocated = PermissionWindow::alloc(mtm).set_ivars(key.clone());
    // SAFETY: NSWindow's designated initializer for our initialized subclass.
    let window: Retained<PermissionWindow> = unsafe {
        msg_send![
            super(allocated),
            initWithContentRect: frame,
            styleMask: NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable | NSWindowStyleMask::Miniaturizable | NSWindowStyleMask::FullSizeContentView,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    // SAFETY: WINDOWS owns the window until its close override removes it.
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
    window.setMovableByWindowBackground(true);
    window.setContentMinSize(NSSize::new(480.0, 520.0));
    let view = AppView::new(mtm, options);
    window.setContentView(Some(&view.view()));
    crate::permission_window::configure(&window);
    view.load_with_config(config);
    window.makeKeyAndOrderFront(None);
    if let Some(root) = view.view().subviews().firstObject() {
        window.makeFirstResponder(Some(&root));
    }
    WINDOWS.with(|windows| {
        windows
            .borrow_mut()
            .insert(key, SetupWindow { window, view });
    });
}

fn close(key: &str) {
    let window = WINDOWS.with(|windows| windows.borrow().get(key).map(|w| w.window.clone()));
    if let Some(window) = window {
        window.close();
    }
}

pub(super) fn close_all() {
    // Close outside the borrow: NSWindow's close override removes its entry.
    let windows: Vec<_> = WINDOWS.with(|windows| {
        windows
            .borrow()
            .values()
            .map(|w| w.window.clone())
            .collect()
    });
    for window in windows {
        window.close();
    }
}
