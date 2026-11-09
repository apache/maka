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

//! Main-thread AppKit host for terminal RGBA rendering. The window is never ordered on screen.
//!
//! Native NSH controls use the same mounted views, layout and input state machines
//! as desktop AppKit. Text pointers use NSTextView selection APIs without entering
//! a blocking desktop tracking loop. Custom hosted widgets requiring that loop
//! reject terminal pointer input. In-process capture requires no Screen Recording
//! permission; AppKit backdrop effects and AVPlayerLayer are not captured.
use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{Bounds, Points, Size};
use nsh_engine::EngineConfig;
use nsh_terminal::{
    DevicePixels, FrameClock, FrameToken, InputAdmissions, Modifiers, MouseButton, NativeSurface,
    PlatformInput, PreparedFrame, ScrollDelta, TextInputTarget, TouchPhase,
};
use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSEvent, NSEventModifierFlags, NSEventType, NSPasteboard,
    NSPasteboardTypeString, NSStandardKeyBindingResponding, NSTextInputClient, NSWindow,
    NSWindowStyleMask,
};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRange, NSRect, NSSize, NSString};

use crate::{AppOptions, AppView};

/// A hidden native surface owned, pumped and dropped on the process main thread.
#[non_exhaustive]
pub struct TerminalSurface {
    view: Rc<AppView>,
    window: Retained<NSWindow>,
    frames: RefCell<FrameClock>,
    on_frame: RefCell<Box<dyn FnMut(PreparedFrame)>>,
    error: Rc<RefCell<Option<String>>>,
    wake: Arc<dyn Fn() + Send + Sync>,
    admissions: RefCell<InputAdmissions>,
    focus_generation: Cell<u64>,
    paused: Cell<bool>,
    active: Cell<bool>,
    stopped: Cell<bool>,
    dirty: Cell<bool>,
    text_drag: Cell<Option<(u32, NSRange)>>,
    revision: Cell<u64>,
    clipboard: RefCell<Option<String>>,
    fence: RefCell<Option<InputFence>>,
}
struct InputFence {
    ready: Arc<AtomicBool>,
    events_sent_at_schedule: u64,
    done: Box<dyn FnOnce(Result<(), String>)>,
}
impl TerminalSurface {
    /// Creates a native surface without activating the application or opening a visible window.
    pub fn new(
        config: EngineConfig,
        size: Size<DevicePixels>,
        scale: f32,
        on_frame: Box<dyn FnMut(PreparedFrame)>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        objc2::rc::autoreleasepool(|_| {
            let mtm = MainThreadMarker::new()
                .ok_or("AppKit terminal host must run on the process main thread")?;
            let mut frames = FrameClock::default();
            frames.set_viewport(size, scale)?;
            NSApplication::sharedApplication(mtm);
            let options = AppOptions {
                size: (
                    (size.width.0 as f32 / scale).ceil() as i32,
                    (size.height.0 as f32 / scale).ceil() as i32,
                ),
                ..AppOptions::default()
            };
            let view = AppView::new(mtm, options);
            let rect = NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(
                    size.width.0 as f64 / scale as f64,
                    size.height.0 as f64 / scale as f64,
                ),
            );
            // SAFETY: AppKit initialization is confined to the main thread; the host owns the window.
            let window = unsafe {
                NSWindow::initWithContentRect_styleMask_backing_defer(
                    NSWindow::alloc(mtm),
                    rect,
                    NSWindowStyleMask::Borderless,
                    NSBackingStoreType::Buffered,
                    false,
                )
            };
            // SAFETY: Rust ownership, rather than AppKit's close autorelease, releases the window.
            unsafe {
                window.setReleasedWhenClosed(false);
            }
            window.setContentView(Some(&view.view()));
            window.makeFirstResponder(Some(view.surface().root.ns()));
            view.surface().terminal.set(true);
            view.surface().terminal_scale.set(scale);
            *view.surface().terminal_wake.borrow_mut() = Some(wake.clone());
            let mut environment = view.surface().environment.get();
            environment.pixel_ratio = scale;
            environment.ctrl_for_command = true;
            environment.lifecycle = nsh_core::platform::Lifecycle::Active;
            view.surface().environment.set(environment);
            let error = Rc::new(RefCell::new(None));
            let errors = error.clone();
            view.surface().set_error_handler(Box::new(move |message| {
                *errors.borrow_mut() = Some(message.to_owned())
            }));
            let host = Self {
                view,
                window,
                frames: RefCell::new(frames),
                on_frame: RefCell::new(on_frame),
                error,
                wake,
                admissions: RefCell::default(),
                focus_generation: Cell::new(0),
                paused: Cell::new(false),
                active: Cell::new(true),
                stopped: Cell::new(false),
                dirty: Cell::new(true),
                text_drag: Cell::new(None),
                revision: Cell::new(0),
                clipboard: RefCell::new(None),
                fence: RefCell::new(None),
            };
            host.set_viewport(size, scale)?;
            host.load_with_config(config);
            if let Some(error) = host.take_error() {
                return Err(error);
            }
            Ok(host)
        })
    }

    fn admit(&self) -> Option<TextInputTarget> {
        let generation = self.view.surface().focus_generation.get();
        let mut admissions = self.admissions.borrow_mut();
        if self.focus_generation.replace(generation) != generation {
            admissions.focus(None);
        }
        let node = (!self.stopped.get() && !self.paused.get() && self.active.get())
            .then(|| {
                crate::text_input::terminal_editor(self.view.surface()).map(|(id, _)| u64::from(id))
            })
            .flatten();
        admissions.focus(node)
    }
    fn schedule_fence(&self, done: Box<dyn FnOnce(Result<(), String>)>) {
        let surface = self.view.surface();
        let events_sent_at_schedule = surface.events_sent();
        let ready = Arc::new(AtomicBool::new(false));
        let completion = ready.clone();
        let wake = self.wake.clone();
        surface.control(move |control| {
            control.flush(move |_| {
                completion.store(true, Ordering::Release);
                wake();
            })
        });
        *self.fence.borrow_mut() = Some(InputFence {
            ready,
            events_sent_at_schedule,
            done,
        });
    }

    fn key(&self, key: &nsh_terminal::Keystroke, down: bool, repeat: bool) -> Result<(), String> {
        // Unsupported named keys are valid terminal input, but have no AppKit
        // event representation. Ignore them without terminating the session.
        if key_characters(key).is_none() {
            return Ok(());
        }
        let surface = self.view.surface();
        if crate::text_input::hold_terminal_key(surface, &self.window, key, down, repeat) {
            return Ok(());
        }
        dispatch_terminal_key(surface, &self.window, key, down, repeat)
    }
    fn mouse(
        &self,
        kind: NSEventType,
        position: nsh_core::Point<Points>,
        mods: Modifiers,
        clicks: usize,
    ) -> Result<(), String> {
        let event = crate::native_events::mouse_event(
            &self.window,
            kind,
            position.x.0.into(),
            position.y.0.into(),
            clicks as isize,
            flags(mods),
        )
        .ok_or("cannot allocate native pointer event")?;
        let surface = self.view.surface();
        if kind == NSEventType::LeftMouseDown
            && !mods.control
            && let Some(native) = crate::input::native_at(&surface.root, position.x.0, position.y.0)
        {
            let view = surface
                .mounter
                .borrow()
                .views
                .values()
                .find(|view| view.state().input.is_some() && native.isDescendantOf(view.ns()))
                .cloned();
            let Some(view) = view else {
                return Err(
                    "this hosted AppKit component requires interactive desktop tracking".into(),
                );
            };
            crate::text_input::focus(&view);
            if let Some((id, editor)) = crate::text_input::terminal_editor(surface) {
                let at = editor.convertPoint_fromView(event.locationInWindow(), None);
                let index = editor.characterIndexForInsertionAtPoint(at);
                let mut range = NSRange::new(index, 0);
                if clicks > 1 {
                    let granularity = if clicks == 2 {
                        objc2_app_kit::NSSelectionGranularity::SelectByWord
                    } else {
                        objc2_app_kit::NSSelectionGranularity::SelectByParagraph
                    };
                    range = editor.selectionRangeForProposedRange_granularity(range, granularity);
                } else if mods.shift {
                    let start = editor.selectedRange().location;
                    range = NSRange::new(start.min(index), start.abs_diff(index));
                }
                editor.setSelectedRange(range);
                self.text_drag.set(Some((id, range)));
            }
            return Ok(());
        }
        if matches!(
            kind,
            NSEventType::LeftMouseDragged | NSEventType::LeftMouseUp
        ) && let Some((id, anchor)) = self.text_drag.get()
        {
            if let Some((focused, editor)) = crate::text_input::terminal_editor(surface)
                && id == focused
            {
                let at = editor.convertPoint_fromView(event.locationInWindow(), None);
                let index = editor.characterIndexForInsertionAtPoint(at);
                let start = index.min(anchor.location);
                let end = index.max(anchor.location + anchor.length);
                editor.setSelectedRange(NSRange::new(start, end - start));
                editor.scrollRangeToVisible(NSRange::new(index, 0));
            }
            if kind == NSEventType::LeftMouseUp {
                self.text_drag.set(None);
            }
            return Ok(());
        }
        // NSH's native pointer state machine is nonblocking. NSTextView's ordinary
        // mouseDown instead owns a nested tracking loop, which would prevent the
        // terminal's serialized input FIFO from delivering its matching mouseUp.
        crate::view::scripted(&event, || crate::input::event(surface, &event));
        Ok(())
    }
}
impl NativeSurface for TerminalSurface {
    fn set_selected_text_range(&self, range: Range<usize>) -> Result<(), String> {
        let (_, editor) = crate::text_input::terminal_editor(self.view.surface())
            .ok_or("no editable input is focused")?;
        if range.start > range.end || range.end > editor.string().length() {
            return Err("selection is outside the native editor".into());
        }
        editor.setSelectedRange(NSRange::new(range.start, range.end - range.start));
        self.dirty.set(true);
        Ok(())
    }
    fn is_active(&self) -> bool {
        self.active.get() && !self.stopped.get() && self.view.surface().running()
    }
    fn stop(&self) {
        self.paused.set(true);
        self.cancel_pointer();
        self.admissions.borrow_mut().focus(None);
        self.frames.borrow_mut().revoke();
        self.window
            .makeFirstResponder(Some(self.view.surface().root.ns()));
        self.view.stop();
        self.dirty.set(true);
        let fence = self.fence.borrow_mut().take();
        if let Some(InputFence { done, .. }) = fence {
            done(Err("native engine stopped before input fence".into()));
        }
    }

    fn viewport_size(&self) -> Size<DevicePixels> {
        self.frames.borrow().size()
    }
    fn scale_factor(&self) -> f32 {
        self.frames.borrow().scale()
    }
    fn pressable_bounds(&self, label: &str) -> Vec<Bounds<Points>> {
        pressable_bounds_in(self.view.surface(), label)
    }
    fn editor_text(&self) -> Option<String> {
        crate::text_input::terminal_text(self.view.surface())
    }
    fn set_clipboard_text(&self, text: &str) {
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        // SAFETY: immutable AppKit string pasteboard type.
        board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
    }
    fn drop_paths(&self, paths: Vec<std::path::PathBuf>, position: nsh_core::Point<Points>) {
        if self.paused.get() || self.stopped.get() {
            return;
        }
        if let Err(error) = self.set_active(true) {
            *self.error.borrow_mut() = Some(error);
            return;
        }
        crate::file_drop::paths(self.view.surface(), paths, position);
        self.dirty.set(true);
    }
    fn set_viewport(&self, size: Size<DevicePixels>, scale: f32) -> Result<(), String> {
        self.frames.borrow_mut().set_viewport(size, scale)?;
        self.cancel_pointer();
        self.view.surface().terminal_scale.set(scale);
        let mut environment = self.view.surface().environment.get();
        environment.pixel_ratio = scale;
        environment.ctrl_for_command = true;
        self.view.surface().environment.set(environment);
        let width = size.width.0 as f32 / scale;
        let height = size.height.0 as f32 / scale;
        self.window
            .setContentSize(NSSize::new(width.into(), height.into()));
        self.view.surface().resized(width, height);
        self.dirty.set(true);
        (self.wake)();
        Ok(())
    }
    fn pump_with_draw(&self, draw: bool) -> bool {
        objc2::rc::autoreleasepool(|_| {
            if self.stopped.get() {
                return false;
            }
            let app = NSApplication::sharedApplication(MainThreadMarker::from(&*self.window));
            // Drain events without blocking terminal I/O. This also services main-queue engine deliveries.
            for _ in 0..64 {
                // SAFETY: Foundation's immutable default run-loop mode.
                let event = unsafe {
                    app.nextEventMatchingMask_untilDate_inMode_dequeue(
                        objc2_app_kit::NSEventMask::Any,
                        Some(&NSDate::dateWithTimeIntervalSinceNow(0.0001)),
                        NSDefaultRunLoopMode,
                        true,
                    )
                };
                let Some(event) = event else { break };
                app.sendEvent(&event);
            }
            self.view.surface().drain();
            if self.view.surface().wants_frames() {
                self.view
                    .surface()
                    .frame(objc2_quartz_core::CACurrentMediaTime(), 1.0 / 60.0);
            }
            if self
                .fence
                .borrow()
                .as_ref()
                .is_some_and(|fence| fence.ready.load(Ordering::Acquire))
            {
                let InputFence {
                    events_sent_at_schedule,
                    done,
                    ..
                } = self.fence.borrow_mut().take().expect("ready fence");
                let surface = self.view.surface();
                surface.drain();
                if surface.events_sent() != events_sent_at_schedule
                    || surface.events_handled() < surface.events_sent()
                    || crate::text_input::has_pending_auto_focus(surface)
                {
                    self.schedule_fence(done);
                } else if crate::text_input::has_pending(surface) {
                    crate::text_input::disarm(surface);
                    done(Err("pending input has no editable focus target".into()));
                } else {
                    crate::text_input::disarm(surface);
                    done(Ok(()));
                }
            }
            self.admit();
            let changed = self
                .revision
                .replace(self.view.surface().capture_revision.get())
                != self.view.surface().capture_revision.get();
            if changed {
                self.dirty.set(true);
            }
            if !draw || !self.dirty.get() {
                return changed;
            }
            let size = self.frames.borrow().size();
            match crate::capture::rgba(&self.window, size.width.0 as u32, size.height.0 as u32)
                .and_then(|pixels| self.frames.borrow_mut().prepare(pixels))
            {
                Ok(frame) => {
                    self.dirty.set(false);
                    (self.on_frame.borrow_mut())(frame);
                    true
                }
                Err(error) => {
                    *self.error.borrow_mut() = Some(error);
                    false
                }
            }
        })
    }

    fn dispatch_input(&self, input: PlatformInput) -> Result<(), String> {
        objc2::rc::autoreleasepool(|_| {
            if self.paused.get() || !self.active.get() || self.stopped.get() {
                return Err("terminal input is not active".into());
            }
            self.dirty.set(true);
            let board = NSPasteboard::generalPasteboard();
            let count = board.changeCount();
            let result = match input {
                PlatformInput::KeyDown(e) => self.key(&e.keystroke, true, e.is_held),
                PlatformInput::KeyUp(e) => self.key(&e.keystroke, false, false),
                PlatformInput::MouseDown(e) => self.mouse(
                    mouse_kind(e.button, true),
                    e.position,
                    e.modifiers,
                    e.click_count,
                ),
                PlatformInput::MouseUp(e) => self.mouse(
                    mouse_kind(e.button, false),
                    e.position,
                    e.modifiers,
                    e.click_count,
                ),
                PlatformInput::MouseMove(e) => self.mouse(
                    match e.pressed_button {
                        Some(MouseButton::Left) => NSEventType::LeftMouseDragged,
                        Some(MouseButton::Right) => NSEventType::RightMouseDragged,
                        Some(MouseButton::Middle) => NSEventType::OtherMouseDragged,
                        None => NSEventType::MouseMoved,
                    },
                    e.position,
                    e.modifiers,
                    0,
                ),
                PlatformInput::ScrollWheel(e) => {
                    let (x, y, phase) = match e.delta {
                        ScrollDelta::Lines(p) => (p.x, p.y, None),
                        ScrollDelta::Pixels(p) => (
                            p.x.0,
                            p.y.0,
                            Some(match e.touch_phase {
                                TouchPhase::Started => 1,
                                TouchPhase::Moved => 2,
                                TouchPhase::Ended => 4,
                            }),
                        ),
                    };
                    crate::native_events::wheel_with(
                        &self.window,
                        e.position.x.0.into(),
                        e.position.y.0.into(),
                        -x.round() as i32,
                        -y.round() as i32,
                        phase,
                        0,
                        crate::native_events::timestamp(),
                        flags(e.modifiers),
                    );
                    Ok(())
                }
            };
            if board.changeCount() != count {
                // SAFETY: immutable AppKit string pasteboard type.
                *self.clipboard.borrow_mut() = board
                    .stringForType(unsafe { NSPasteboardTypeString })
                    .map(|text| text.to_string());
            }
            result
        })
    }

    fn set_active(&self, active: bool) -> Result<(), String> {
        self.active.set(active);
        let mut environment = self.view.surface().environment.get();
        environment.lifecycle = if active {
            nsh_core::platform::Lifecycle::Active
        } else {
            nsh_core::platform::Lifecycle::Inactive
        };
        self.view.surface().set_environment(environment);
        if !active {
            self.cancel_pointer();
            let _ = crate::text_input::terminal_compose(
                self.view.surface(),
                "",
                "",
                NSRange::new(0, 0),
                false,
            );
            crate::text_input::disarm(self.view.surface());
            self.admissions.borrow_mut().focus(None);
        }
        self.dirty.set(true);
        Ok(())
    }
    fn cancel_pointer(&self) {
        self.text_drag.set(None);
        crate::input::cancel_pointer(self.view.surface());
    }
    fn paste(&self, event: nsh_core::PasteEvent) -> bool {
        if self.paused.get() || !self.active.get() || self.stopped.get() {
            return false;
        }
        let surface = self.view.surface();
        if self.admit().is_none() && !crate::text_input::is_armed(surface) {
            return false;
        }
        match crate::text_input::paste_or_hold(surface, &self.window, &event) {
            Ok(()) => {
                self.dirty.set(true);
                true
            }
            Err(error) => {
                *self.error.borrow_mut() = Some(error);
                false
            }
        }
    }
    fn load_with_config(&self, config: EngineConfig) {
        if self.stopped.get() {
            return;
        }
        self.cancel_pointer();
        self.admissions.borrow_mut().focus(None);
        self.frames.borrow_mut().revoke();
        self.clipboard.borrow_mut().take();
        self.view.surface().terminal_clipboard.borrow_mut().take();
        self.view.surface().terminal_quit.set(false);
        self.error.borrow_mut().take();
        let surface = self.view.surface();
        crate::system::set_appearance(
            surface,
            match config.environment.color_scheme {
                nsh_core::platform::ColorScheme::Light => nsh_core::platform::Appearance::Light,
                nsh_core::platform::ColorScheme::Dark => nsh_core::platform::Appearance::Dark,
            },
        );
        let mut environment = surface.environment.get();
        environment.ctrl_for_command = true;
        environment.pixel_ratio = self.frames.borrow().scale();
        environment.lifecycle = if self.active.get() {
            nsh_core::platform::Lifecycle::Active
        } else {
            nsh_core::platform::Lifecycle::Inactive
        };
        surface.environment.set(environment);
        self.window.makeFirstResponder(Some(surface.root.ns()));
        self.view.load_with_config(config);
        self.paused.set(false);
        self.dirty.set(true);
        (self.wake)();
    }
    fn pause_input(&self, done: Box<dyn FnOnce(Result<(), String>)>) {
        self.paused.set(true);
        self.cancel_pointer();
        self.admissions.borrow_mut().focus(None);
        if self.stopped.get() || !self.view.surface().running() {
            done(Err("native engine is not running".into()));
            return;
        }
        if self.fence.borrow().is_some() {
            done(Err("input fence already pending".into()));
            return;
        }
        self.schedule_fence(done);
    }
    fn resume_input(&self) {
        if self.stopped.get() {
            return;
        }
        self.paused.set(false);
        self.admit();
    }
    fn text_input_target(&self) -> Option<TextInputTarget> {
        self.admit()
    }
    fn apply_composition(
        &self,
        target: &TextInputTarget,
        commit: &str,
        preedit: &str,
        selection: Option<Range<usize>>,
        active: bool,
    ) -> Result<bool, String> {
        self.admit();
        if !self.admissions.borrow().accepts(target) {
            return Ok(false);
        }
        let length = preedit.encode_utf16().count();
        let selected = selection.unwrap_or(length..length);
        let boundary = |offset| {
            preedit
                .chars()
                .scan(0, |at, c| {
                    let before = *at;
                    *at += c.len_utf16();
                    Some(before)
                })
                .any(|at| at == offset)
                || offset == length
        };
        if selected.start > selected.end
            || selected.end > length
            || !boundary(selected.start)
            || !boundary(selected.end)
        {
            return Err("composition selection is outside preedit".into());
        }
        let applied = crate::text_input::terminal_compose_admitted(
            self.view.surface(),
            commit,
            preedit,
            NSRange::new(selected.start, selected.end - selected.start),
            active,
        );
        self.dirty.set(true);
        Ok(applied)
    }
    fn input_caret_bounds(&self) -> Option<Bounds<Points>> {
        self.admit()?;
        crate::text_input::terminal_caret(self.view.surface())
    }
    fn input_candidate_bounds(&self) -> Option<Bounds<Points>> {
        self.admit()?;
        crate::text_input::terminal_candidate(self.view.surface())
    }
    fn take_clipboard_write(&self) -> Option<String> {
        self.view
            .surface()
            .terminal_clipboard
            .borrow_mut()
            .take()
            .or_else(|| self.clipboard.borrow_mut().take())
    }
    fn frame_is_current(&self, token: &FrameToken) -> bool {
        self.frames.borrow().is_current(token)
    }
    fn mark_presented(&self, token: FrameToken) -> Result<(), String> {
        self.frames.borrow_mut().mark_presented(token)
    }
    fn take_error(&self) -> Option<String> {
        self.error.borrow_mut().take()
    }
    fn is_quit_requested(&self) -> bool {
        self.view.surface().terminal_quit.get()
    }
    fn has_pending(&self) -> bool {
        !self.stopped.get()
            && (self.dirty.get()
                || self.view.surface().wants_frames()
                || crate::text_input::has_pending(self.view.surface())
                || self.fence.borrow().is_some())
    }
    fn next_deadline(&self) -> Option<Instant> {
        (!self.stopped.get()).then(|| Instant::now() + Duration::from_millis(16))
    }
    fn shutdown(&self) {
        if self.stopped.replace(true) {
            return;
        }
        self.cancel_pointer();
        self.admissions.borrow_mut().focus(None);
        self.frames.borrow_mut().revoke();
        self.view.stop();
        self.window.close();
        let fence = self.fence.borrow_mut().take();
        if let Some(InputFence { done, .. }) = fence {
            done(Err("native surface stopped before input fence".into()));
        }
    }
}
impl Drop for TerminalSurface {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn pressable_bounds_in(surface: &crate::surface::Surface, label: &str) -> Vec<Bounds<Points>> {
    fn visit(
        surface: &crate::surface::Surface,
        view: &crate::view::NshView,
        label: &str,
        out: &mut Vec<Bounds<Points>>,
    ) {
        if view.ns().isHidden() {
            return;
        }
        let Some(state) = view.try_state() else {
            return;
        };
        if state.style.hidden
            || state.props.accessibility.hidden
            || state.props.pointer_events == nsh_core::PointerEvents::None
            || state.live.as_ref().is_some_and(|l| l.dying())
        {
            return;
        }
        let pointer_events = state.props.pointer_events;
        let pressable = pointer_events != nsh_core::PointerEvents::BoxNone
            && !state.props.accessibility.state.disabled
            && (state.events.contains(nsh_core::EventKind::Press)
                || state.events.contains(nsh_core::EventKind::LongPress));
        drop(state);
        if pressable && crate::access::name_of(view).as_deref() == Some(label) {
            let visible = view.visible_bounds();
            if visible.size.width.0 > 0.0
                && visible.size.height.0 > 0.0
                && let Some(bounds) = view
                    .to_root(&surface.root)
                    .and_then(|m| crate::view::map_bounds(&m, visible))
                && bounds.size.width.0 > 0.0
                && bounds.size.height.0 > 0.0
            {
                out.push(bounds);
            }
        }
        if pointer_events != nsh_core::PointerEvents::BoxOnly {
            let container = view.container_view();
            for sub in view.ns().subviews().iter() {
                if container.as_deref() == Some(&*sub) {
                    for child in view.child_views() {
                        visit(surface, &child, label, out);
                    }
                } else if let Some(child) = crate::view::NshView::from_ns(&sub) {
                    visit(surface, &child, label, out);
                }
            }
        }
    }
    let scope_ns = crate::navigation::focus_scope(surface);
    let Some(scope) =
        crate::view::NshView::from_ns(&scope_ns).filter(crate::view::NshView::is_shown_in_tree)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    visit(surface, &scope, label, &mut out);
    out
}
pub(crate) fn dispatch_terminal_key(
    surface: &Rc<crate::surface::Surface>,
    window: &NSWindow,
    key: &nsh_terminal::Keystroke,
    down: bool,
    repeat: bool,
) -> Result<(), String> {
    let Some((chars, code)) = key_characters(key) else {
        return Ok(());
    };
    let string = NSString::from_str(&chars);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        if down {
            NSEventType::KeyDown
        } else {
            NSEventType::KeyUp
        },
        NSPoint::new(0.0, 0.0),
        flags(key.modifiers),
        crate::native_events::timestamp(),
        window.windowNumber(),
        None,
        &string,
        &string,
        repeat,
        code,
    )
    .ok_or("cannot allocate native key event")?;
    if down
        && matches!(key.key.as_str(), "enter" | "return" | "escape")
        && crate::text_input::composing_focused(surface)
    {
        return Ok(());
    }
    if down && crate::keymap::fires(surface, &event) {
        return Ok(());
    }
    let board = NSPasteboard::generalPasteboard();
    let count = board.changeCount();
    let mut handled = false;
    if down
        && !key.modifiers.control
        && !key.modifiers.platform
        && !key.modifiers.alt
        && !crate::text_input::composing_focused(surface)
        && let Some((_, editor)) = crate::text_input::terminal_editor(surface)
    {
        match (key.key.as_str(), key.modifiers.shift) {
            ("home", false) => {
                // SAFETY: standard NSStandardKeyBindingResponding actions accept a nil sender.
                unsafe { editor.moveToBeginningOfLine(None) };
                handled = true;
            }
            ("home", true) => {
                // SAFETY: standard NSStandardKeyBindingResponding actions accept a nil sender.
                unsafe { editor.moveToBeginningOfLineAndModifySelection(None) };
                handled = true;
            }
            ("end", false) => {
                // SAFETY: standard NSStandardKeyBindingResponding actions accept a nil sender.
                unsafe { editor.moveToEndOfLine(None) };
                handled = true;
            }
            ("end", true) => {
                // SAFETY: standard NSStandardKeyBindingResponding actions accept a nil sender.
                unsafe { editor.moveToEndOfLineAndModifySelection(None) };
                handled = true;
            }
            _ => {}
        }
    }
    if down
        && (key.modifiers.control || key.modifiers.platform)
        && !key.modifiers.alt
        && let Some((_, editor)) = crate::text_input::terminal_editor(surface)
    {
        if matches!(key.key.as_str(), "c" | "x")
            && !crate::text_input::terminal_allows_copy(surface)
        {
            return Ok(());
        }
        // SAFETY: standard NSText action methods accept a nil sender. The native
        // editor enforces read-only, secure copy/cut, paste policy and undo rules.
        unsafe {
            match key.key.as_str() {
                "a" => {
                    editor.selectAll(None);
                    handled = true;
                }
                "c" => {
                    editor.copy(None);
                    handled = true;
                }
                "x" => {
                    editor.cut(None);
                    handled = true;
                }
                "v" => {
                    editor.paste(None);
                    handled = true;
                }
                _ => {}
            }
        }
    }
    if !handled {
        window.sendEvent(&event);
    }
    if board.changeCount() != count {
        // SAFETY: immutable AppKit string pasteboard type.
        *surface.terminal_clipboard.borrow_mut() = board
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|text| text.to_string());
    }
    Ok(())
}

fn flags(modifiers: Modifiers) -> NSEventModifierFlags {
    let mut flags = NSEventModifierFlags::empty();
    for (on, flag) in [
        (modifiers.control, NSEventModifierFlags::Control),
        (modifiers.alt, NSEventModifierFlags::Option),
        (modifiers.shift, NSEventModifierFlags::Shift),
        (modifiers.platform, NSEventModifierFlags::Command),
        (modifiers.function, NSEventModifierFlags::Function),
    ] {
        if on {
            flags |= flag;
        }
    }
    flags
}
fn mouse_kind(button: MouseButton, down: bool) -> NSEventType {
    match (button, down) {
        (MouseButton::Left, true) => NSEventType::LeftMouseDown,
        (MouseButton::Left, false) => NSEventType::LeftMouseUp,
        (MouseButton::Right, true) => NSEventType::RightMouseDown,
        (MouseButton::Right, false) => NSEventType::RightMouseUp,
        (_, true) => NSEventType::OtherMouseDown,
        (_, false) => NSEventType::OtherMouseUp,
    }
}
fn key_characters(key: &nsh_terminal::Keystroke) -> Option<(String, u16)> {
    let named = match key.key.as_str() {
        "enter" | "return" => Some(("\r", 36)),
        "escape" => Some(("\u{1b}", 53)),
        "tab" => Some((if key.modifiers.shift { "\u{19}" } else { "\t" }, 48)),
        "backspace" => Some(("\u{7f}", 51)),
        "space" => Some((" ", 49)),
        "up" => Some(("\u{f700}", 126)),
        "down" => Some(("\u{f701}", 125)),
        "left" => Some(("\u{f702}", 123)),
        "right" => Some(("\u{f703}", 124)),
        "pageup" => Some(("\u{f72c}", 116)),
        "pagedown" => Some(("\u{f72d}", 121)),
        "home" => Some(("\u{f729}", 115)),
        "end" => Some(("\u{f72b}", 119)),
        "delete" => Some(("\u{f728}", 117)),
        "insert" => Some(("\u{f727}", 114)),
        "clear" => Some(("\u{f739}", 71)),
        _ => None,
    };
    if let Some((text, code)) = named {
        return Some((text.into(), code));
    }
    if let Some(n) = key
        .key
        .strip_prefix('f')
        .and_then(|n| n.parse::<usize>().ok())
    {
        const CODES: [u16; 20] = [
            122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80,
            90,
        ];
        let code = n.checked_sub(1).and_then(|index| CODES.get(index))?;
        return Some((
            char::from_u32(0xf703 + n as u32)
                .expect("native function key")
                .to_string(),
            *code,
        ));
    }
    if key.key_char.is_none() && key.key.chars().count() != 1 {
        return None;
    }
    let text = key.key_char.as_deref().unwrap_or(&key.key);
    let code = key
        .key
        .chars()
        .next()
        .and_then(crate::input::us_key_code)
        .unwrap_or(crate::input::NO_KEY);
    Some((text.to_owned(), code))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_terminal_text_is_not_reconstructed_from_the_key() {
        let mut key = nsh_terminal::Keystroke::default();
        key.key = "a".into();
        key.key_char = Some("你好".into());
        assert_eq!(key_characters(&key).unwrap().0, "你好");
        key.key = "tab".into();
        key.modifiers.shift = true;
        assert_eq!(key_characters(&key).unwrap(), ("\u{19}".into(), 48));
    }
    #[test]
    fn named_keys_keep_native_virtual_codes() {
        let mut key = nsh_terminal::Keystroke::default();
        key.key = "f12".into();
        assert_eq!(key_characters(&key).unwrap(), ("\u{f70f}".into(), 111));
        key.key = "left".into();
        assert_eq!(key_characters(&key).unwrap(), ("\u{f702}".into(), 123));
    }
    #[test]
    fn extended_named_keys_are_native_events_not_literal_words() {
        let mut key = nsh_terminal::Keystroke::default();
        for (name, character, code) in [
            ("insert", '\u{f727}', 114),
            ("clear", '\u{f739}', 71),
            ("f13", '\u{f710}', 105),
            ("f20", '\u{f717}', 90),
        ] {
            key.key = name.into();
            assert_eq!(key_characters(&key).unwrap(), (character.to_string(), code));
        }
        for name in ["f0", "f21", "f35", "f255", "unsupported", ""] {
            key.key = name.into();
            assert!(
                key_characters(&key).is_none(),
                "{name} must never become inserted text"
            );
        }
    }
}
