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
