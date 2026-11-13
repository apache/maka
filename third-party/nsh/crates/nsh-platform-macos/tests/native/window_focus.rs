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

//! A popup that does not activate, focused while it waits for its first
//! frame, takes the keyboard when it shows and its field gets the focus.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    desktop::{WindowAttributes, WindowKind},
    element::{desktop, input},
    prelude::*,
};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly},
    objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSSize},
};

static WINDOW_FOCUSED: AtomicBool = AtomicBool::new(false);
static FIELD_FOCUSED: AtomicBool = AtomicBool::new(false);
/// The field is focused by its ref instead of `auto_focus`.
static BY_REF: AtomicBool = AtomicBool::new(false);

fn launcher() -> impl IntoElement {
    let launcher = desktop::current_window();
    launcher.on_focus_change(|focused| WINDOW_FOCUSED.store(focused, Ordering::SeqCst));
    set_timeout(Duration::ZERO, move || launcher.focus());
    let by_ref = BY_REF.load(Ordering::SeqCst);
    let field = element_ref();
    view()
        .flex_1()
        .child(
            input()
                .element_ref(&field)
                .auto_focus(!by_ref)
                .on_focus(|| FIELD_FOCUSED.store(true, Ordering::SeqCst)),
        )
        // Built after the field, in the batch that opens the window.
        .child(when(by_ref, move || {
            field.focus();
            view()
        }))
}

#[component]
// `WindowAttributes` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
fn Opener() -> impl IntoElement {
    let mut attributes = WindowAttributes::default();
    attributes.activate = Some(false);
    view().flex_1().child(
        desktop::window()
            .id("launcher")
            .kind(WindowKind::Popup)
            .attributes(attributes)
            .open(true)
            .content(launcher),
    )
}

/// Runs last: the policy that makes this deterministic outlives it.
pub(super) fn run() {
    NSApplication::sharedApplication(MainThreadMarker::new().unwrap())
        .setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    check(false);
    check(true);
    #[cfg(feature = "js")]
    pointer_and_keyboard_ownership();
    println!("window focus: a popup focused before its first frame has the keyboard");
}

// `AppOptions` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
fn check(by_ref: bool) {
    BY_REF.store(by_ref, Ordering::SeqCst);
    WINDOW_FOCUSED.store(false, Ordering::SeqCst);
    FIELD_FOCUSED.store(false, Ordering::SeqCst);
    let mtm = MainThreadMarker::new().unwrap();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(480.0, 300.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let mut options = platform::AppOptions::default();
    options.size = (480, 300);
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Opener>()));
    window.orderFrontRegardless();

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline
        && !(WINDOW_FOCUSED.load(Ordering::SeqCst) && FIELD_FOCUSED.load(Ordering::SeqCst))
    {
        platform::objc2_foundation::NSRunLoop::currentRunLoop()
            .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
    assert!(
        WINDOW_FOCUSED.load(Ordering::SeqCst),
        "the popup takes the keyboard it was asked for before its first frame"
    );
    assert!(
        FIELD_FOCUSED.load(Ordering::SeqCst),
        "the popup's field gets the focus (by_ref: {by_ref})"
    );
    surface.stop();
    window.close();
}

#[cfg(feature = "js")]
fn pointer_and_keyboard_ownership() {
    use nsh_engine::{App, Bundle, EngineConfig, Policy};
    use platform::{
        objc2::rc::Retained,
        objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView},
        objc2_foundation::NSRunLoop,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    const SOURCE: &str = r#"
        import { View, host, keymap, mount, signal } from "nsh";
        import { Input } from "nsh/base";
        import { Window } from "nsh/desktop";
        function App() {
            let popup;
            const shifted = signal(false);
            const report = name => host.post("report", [name, keymap.focusedWithin(popup)]);
            const launcher = Window.open(() => <View ref={v => popup = v} style={{flex: 1}}
                onMouseEnter={() => {
                    shifted.set(true);
                    report("popup enter");
                }}
                onMouseLeave={() => report("popup leave")}>
                <Input autoFocus style={{marginTop: shifted() ? 1 : 0}} />
            </View>, {
                id: "pointer-probe", title: "NSH pointer probe", kind: "popup", activate: false,
                defaultSize: {width: 300, height: 200}
            });
            launcher.focus();
            return <View style={{flex: 1}}>
                <View onMouseEnter={() => report("main enter")}
                    onMouseMove={() => report("main move")}
                    style={{position: "absolute", left: 30, top: 20, width: 150, height: 100}} />
            </View>;
        }
        mount(App);
    "#;

    fn tracked_root(view: &NSView) -> Option<Retained<NSView>> {
        if !view.trackingAreas().is_empty() {
            return Some(Retained::from(view));
        }
        view.subviews()
            .iter()
            .find_map(|child| tracked_root(&child))
    }

    fn pump() {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }

    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: the test runs on the main thread and retains the window until it closes.
    let main = unsafe {
        let window = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(50.0, 300.0), NSSize::new(400.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        );
        window.setReleasedWhenClosed(false);
        window
    };
    let view = platform::AppView::new(mtm, platform::AppOptions::default());
    main.setContentView(Some(&view.view()));
    let reports = Arc::new(Mutex::new(Vec::new()));
    let observed = reports.clone();
    let host = view.host();
    host.handle("report", move |mut call| {
        observed.lock().unwrap().push(call.take_data());
    });
    let mut capabilities = nsh_engine::Capabilities::all();
    capabilities.host = vec!["report".into()];
    let policy = Policy {
        declared: Some(capabilities),
        ..Policy::development()
    };
    let code = nsh_bundler::compile_module("PointerOwnership.tsx", SOURCE, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code).with_policy(policy)));
    config.host = host;
    config.ui_sets = vec![nsh_base::registry()];
    view.load_with_config(config);
    main.orderFrontRegardless();

    let deadline = Instant::now() + Duration::from_secs(5);
    let popup = loop {
        pump();
        if let Some(popup) = app
            .windows()
            .iter()
            .find(|w| w.title().to_string() == "NSH pointer probe" && w.isVisible())
        {
            break popup;
        }
        assert!(Instant::now() < deadline, "the popup never opened");
    };
    let main_root = tracked_root(&view.view()).unwrap();
    let popup_root = tracked_root(&popup.contentView().unwrap()).unwrap();
    let move_at = |window: &NSWindow, at: NSPoint| {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::MouseMoved, at, NSEventModifierFlags::empty(),
            0.0, window.windowNumber(), None, 0, 0, 0.0,
        ).unwrap()
    };
    popup_root.mouseMoved(&move_at(&popup, NSPoint::new(75.0, 150.0)));
    main_root.cursorUpdate(&move_at(&main, NSPoint::new(-10.0, -10.0)));
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        pump();
    }
    assert_eq!(*reports.lock().unwrap(), vec![json!(["popup enter", true])]);

    main_root.mouseMoved(&move_at(&main, NSPoint::new(75.0, 190.0)));
    let deadline = Instant::now() + Duration::from_secs(5);
    while reports.lock().unwrap().len() < 4 {
        assert!(
            Instant::now() < deadline,
            "missing mouse events: {:?}",
            reports.lock().unwrap()
        );
        pump();
    }
    assert_eq!(
        *reports.lock().unwrap(),
        vec![
            json!(["popup enter", true]),
            json!(["popup leave", true]),
            json!(["main enter", true]),
            json!(["main move", true]),
        ]
    );

    println!(
        "window focus: hover follows the pointer window and keyboard focus stays in the popup"
    );
    view.stop();
    main.close();
}
