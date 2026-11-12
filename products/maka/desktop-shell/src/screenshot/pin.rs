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

//! Screenshots pinned above other windows: drag to move, scroll to zoom, double-click or Escape to
//! close, Command-C to copy and Command-S to save.

use super::output;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_platform_macos::{
    objc2::{
        AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::Retained,
    },
    objc2_app_kit::{
        NSBackingStoreType, NSColor, NSCompositingOperation, NSEvent, NSEventModifierFlags,
        NSGraphicsContext, NSImage, NSImageInterpolation, NSPanel, NSResponder, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize},
};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::CGImage;
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
};

const FLOATING_LEVEL: isize = 3;
const SMALLEST_ZOOM: f64 = 0.1;
const LARGEST_ZOOM: f64 = 8.0;

thread_local! {
    /// The open pins; AppKit only keeps a window alive while something owns it.
    static PINS: RefCell<Vec<Retained<NSWindow>>> = const { RefCell::new(Vec::new()) };
}

define_class!(
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MakaPinPanel"]
    struct PinPanel;
    unsafe impl NSObjectProtocol for PinPanel {}
    impl PinPanel {
        // Borderless panels refuse the keys otherwise.
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { true }
    }
);

struct PinState {
    picture: CFRetained<CGImage>,
    /// Where S saves it, as the stage's Save does.
    folder: Option<PathBuf>,
    image: Retained<NSImage>,
    /// The picture's size in points at a zoom of one.
    size: NSSize,
    zoom: Cell<f64>,
}

define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MakaPin"]
    #[ivars = PinState]
    struct Pin;
    unsafe impl NSObjectProtocol for Pin {}
    impl Pin {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool { true }
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) { self.draw(); }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            match self.window() {
                Some(window) if event.clickCount() >= 2 => close(&window),
                Some(window) => window.performWindowDragWithEvent(event),
                None => {}
            }
        }
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) { self.zoom(event.scrollingDeltaY()); }
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) { self.key(event); }
    }
);

impl Pin {
    fn draw(&self) {
        let bounds = self.bounds();
        if let Some(context) = NSGraphicsContext::currentContext() {
            context.setImageInterpolation(NSImageInterpolation::High);
        }
        self.ivars().image.drawInRect_fromRect_operation_fraction(
            bounds,
            NSRect::ZERO,
            NSCompositingOperation::Copy,
            1.0,
        );
        NSColor::colorWithWhite_alpha(0.5, 0.6).setStroke();
        nsh_platform_macos::objc2_app_kit::NSBezierPath::strokeRect(super::paint::inset(
            bounds, 0.5,
        ));
    }

    fn zoom(&self, delta: f64) {
        let Some(window) = self.window() else { return };
        if delta == 0.0 {
            return;
        }
        let state = self.ivars();
        let zoom = (state.zoom.get() * if delta > 0.0 { 1.1 } else { 1.0 / 1.1 })
            .clamp(SMALLEST_ZOOM, LARGEST_ZOOM);
        state.zoom.set(zoom);
        let frame = window.frame();
        let size = NSSize::new(state.size.width * zoom, state.size.height * zoom);
        // The top left corner stays put; AppKit's screen origin is at the bottom.
        let origin = NSPoint::new(
            frame.origin.x,
            frame.origin.y + frame.size.height - size.height,
        );
        window.setFrame_display(NSRect::new(origin, size), true);
    }

    fn key(&self, event: &NSEvent) {
        const ESCAPE: u16 = 53;
        let Some(window) = self.window() else { return };
        if event.keyCode() == ESCAPE {
            return close(&window);
        }
        if !event
            .modifierFlags()
            .contains(NSEventModifierFlags::Command)
        {
            return;
        }
        let typed = event
            .charactersIgnoringModifiers()
            .map(|typed| typed.to_string().to_lowercase());
        let picture = &self.ivars().picture;
        // A pin has nowhere to report a failure; the picture is still on screen to retry.
        match typed.as_deref() {
            Some("c") => drop(output::copy(picture)),
            Some("s") => drop(output::save(picture, self.ivars().folder.as_deref())),
            Some("w") => close(&window),
            _ => {}
        }
    }
}

/// Pins `picture` at `frame`, in screen points.
pub(super) fn pin(
    mtm: MainThreadMarker,
    picture: CFRetained<CGImage>,
    frame: NSRect,
    folder: Option<PathBuf>,
) {
    let image = NSImage::initWithCGImage_size(NSImage::alloc(), &picture, frame.size);
    let view = Pin::alloc(mtm).set_ivars(PinState {
        picture,
        folder,
        image,
        size: frame.size,
        zoom: Cell::new(1.0),
    });
    // SAFETY: NSView's designated initializer, with all subclass ivars initialized.
    let view: Retained<Pin> = unsafe { msg_send![super(view), initWithFrame: frame] };
    let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;
    // SAFETY: NSPanel's designated initializer.
    let panel: Retained<PinPanel> = unsafe {
        msg_send![
            PinPanel::alloc(mtm),
            initWithContentRect: frame,
            styleMask: style,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    let window: Retained<NSWindow> = panel.into_super().into_super();
    // SAFETY: PINS owns the window, so closing it must not release it as well.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setLevel(FLOATING_LEVEL);
    window.setHidesOnDeactivate(false);
    window.setHasShadow(true);
    window.setContentView(Some(&view));
    window.makeKeyAndOrderFront(None);
    window.makeFirstResponder(Some(&view));
    PINS.with_borrow_mut(|pins| pins.push(window));
}

fn close(window: &NSWindow) {
    window.orderOut(None);
    let closed = PINS.with_borrow_mut(|pins| {
        let at = pins.iter().position(|pin| std::ptr::eq(&**pin, window));
        at.map(|at| pins.remove(at))
    });
    // The pin's own event handler is still running; the window goes once it returns.
    let closed = MainThreadBound::new(closed, window.mtm());
    DispatchQueue::main().exec_async(move || drop(closed));
}
