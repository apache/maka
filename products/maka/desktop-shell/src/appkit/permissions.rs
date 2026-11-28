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

use maka_workbench::bindings::{PermissionGuide, SystemPermissionWindow};
use nsh_engine::{EngineConfig, JsonValue};
use nsh_platform_macos::{
    AppOptions, AppView,
    objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
        runtime::ProtocolObject,
    },
    objc2_app_kit::{
        NSBackingStoreType, NSFloatingWindowLevel, NSPanel, NSResponder, NSWindow, NSWindowButton,
        NSWindowCollectionBehavior, NSWindowStyleMask, NSWindowTitleVisibility,
        NSWindowWillMoveNotification,
    },
    objc2_foundation::{
        NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize,
        NSString,
    },
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

struct GuideWindow {
    lease: PermissionGuide,
    panel: Retained<NSPanel>,
    view: Rc<AppView>,
    moved: Rc<std::cell::Cell<bool>>,
    observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}
impl Drop for GuideWindow {
    fn drop(&mut self) {
        // SAFETY: this is our observer token, registered on the default center.
        unsafe {
            NSNotificationCenter::defaultCenter().removeObserver(self.observer.as_ref());
        }
    }
}

thread_local! {
    static GUIDE: RefCell<Option<GuideWindow>> = const { RefCell::new(None) };
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
    let lease = request.guide.clone();
    if lease.as_ref().is_some_and(|guide| !guide.active()) {
        return;
    }
    let drag_alive = alive.clone();
    let drag_lease = lease.clone();
    let native_drag = match request.application() {
        Some(application) => match crate::permission_application::register(
            &options.components,
            mtm,
            application,
            Rc::new(move || {
                drag_alive.load(Ordering::Acquire)
                    && drag_lease.as_ref().is_none_or(PermissionGuide::active)
            }),
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
    if let Some(guide) = lease {
        open_guide(guide, config, options, mtm);
        return;
    }
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

fn open_guide(
    guide: PermissionGuide,
    config: EngineConfig,
    mut options: AppOptions,
    mtm: MainThreadMarker,
) {
    close_guide(None);
    if !guide.active() {
        return;
    }
    options.size = (400, 144);
    let closing = guide.clone();
    config
        .host
        .handle("computerPermissions.close", move |call| {
            closing.close();
            call.resolve(JsonValue::Null);
        });
    let size = NSSize::new(400., 144.);
    // SAFETY: the main thread owns the panel, its engine and its content view.
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        NSRect::new(NSPoint::ZERO, size),
        NSWindowStyleMask::NonactivatingPanel
            | NSWindowStyleMask::Titled
            | NSWindowStyleMask::FullSizeContentView,
        NSBackingStoreType::Buffered,
        false,
    );
    unsafe {
        panel.setReleasedWhenClosed(false);
    }
    panel.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    panel.setTitlebarAppearsTransparent(true);
    panel.setFloatingPanel(true);
    panel.setHidesOnDeactivate(false);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setMovableByWindowBackground(true);
    let view = AppView::new(mtm, options);
    panel.setContentView(Some(&view.view()));
    panel.setLevel(NSFloatingWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    let fits = crate::permission_window::place_guide(&panel);
    view.load_with_config(config);
    if fits {
        panel.orderFrontRegardless();
    }
    let moved = Rc::new(std::cell::Cell::new(false));
    let observer = observe_interactive_move(&panel, moved.clone());
    let id = guide.id;
    GUIDE.with(|slot| {
        *slot.borrow_mut() = Some(GuideWindow {
            lease: guide,
            panel,
            view,
            moved,
            observer,
        })
    });
    follow_settings(id);
}

fn follow_settings(id: uuid::Uuid) {
    let next = dispatch2::DispatchTime::NOW.time(350_000_000);
    if let Err(error) = dispatch2::DispatchQueue::main().after(next, move || {
        let panel = GUIDE.with(|slot| {
            let slot = slot.borrow();
            let window = slot.as_ref()?;
            (window.lease.id == id && window.lease.active() && !window.moved.get())
                .then(|| window.panel.clone())
        });
        if let Some(panel) = panel {
            let fits = crate::permission_window::place_guide(&panel);
            if fits && !panel.isVisible() {
                panel.orderFrontRegardless();
            }
            if !fits && panel.isVisible() {
                panel.orderOut(None);
            }
            follow_settings(id);
        }
    }) {
        eprintln!("maka-desktop-shell: scheduling permission guide placement: {error:?}");
    }
}

pub(super) fn close_guide(id: Option<uuid::Uuid>) {
    let old = GUIDE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|window| id.is_none_or(|id| id == window.lease.id))
        {
            slot.take()
        } else {
            None
        }
    });
    if let Some(window) = old {
        window.lease.close();
        window.panel.orderOut(None);
        window.view.stop();
        window.panel.close();
    }
}

fn close(key: &str) {
    let window = WINDOWS.with(|windows| windows.borrow().get(key).map(|w| w.window.clone()));
    if let Some(window) = window {
        window.close();
    }
}

pub(super) fn close_all() {
    close_guide(None);
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

fn observe_interactive_move(
    sender: &NSObject,
    drag: Rc<std::cell::Cell<bool>>,
) -> Retained<ProtocolObject<dyn NSObjectProtocol>> {
    let block = block2::RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| drag.set(true));
    // WillMove is the AppKit notification for the start of an interactive move.
    // Frame changes made by setFrame:display: only post DidMove.
    unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillMoveNotification),
            Some(sender),
            None,
            &block,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_an_interactive_move_of_this_panel_disables_following() {
        use nsh_platform_macos::objc2_app_kit::NSWindowDidMoveNotification;
        let panel = NSObject::new();
        let other = NSObject::new();
        let moved = Rc::new(std::cell::Cell::new(false));
        let observer = observe_interactive_move(&panel, moved.clone());
        let center = NSNotificationCenter::defaultCenter();
        // SAFETY: notifications and registration are synchronous on this test thread.
        unsafe {
            center.postNotificationName_object(NSWindowDidMoveNotification, Some(&panel));
            center.postNotificationName_object(NSWindowWillMoveNotification, Some(&other));
            assert!(!moved.get());
            center.postNotificationName_object(NSWindowWillMoveNotification, Some(&panel));
            center.removeObserver(observer.as_ref());
        }
        assert!(moved.get());
    }
}
