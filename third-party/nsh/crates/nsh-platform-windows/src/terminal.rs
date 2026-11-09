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

//! A hidden Win32 surface, drawn by Direct2D for terminal graphics transport.
//! Construct and pump it on one OLE UI thread; no window is shown.
use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use nsh_terminal::{
    Bounds, DevicePixels, FrameClock, FrameToken, InputAdmissions, NativeSurface, PlatformInput,
    Points, PreparedFrame, Size, TextInputTarget,
};
use windows::Win32::{
    System::Ole::{OleInitialize, OleUninitialize},
    UI::WindowsAndMessaging::{
        DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage, WM_QUIT,
    },
};

use crate::{
    AppOptions, AppView,
    input::{KeyEvent, Modifiers, PointerEvent, PointerKind, WheelEvent},
};

#[derive(Default)]
struct ClipboardState {
    text: Option<String>,
    pending: Option<String>,
}
type Clipboard = Rc<RefCell<ClipboardState>>;
thread_local! { static CLIPBOARD: RefCell<Option<Clipboard>> = const { RefCell::new(None) }; }
pub(crate) fn clipboard_write(text: &str) -> bool {
    CLIPBOARD.with(|slot| {
        if let Some(out) = &*slot.borrow() {
            let mut state = out.borrow_mut();
            state.text = Some(text.to_owned());
            state.pending = Some(text.to_owned());
            true
        } else {
            false
        }
    })
}
pub(crate) fn clipboard_read() -> Option<String> {
    CLIPBOARD.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|state| state.borrow().text.clone())
    })
}
struct OleApartment;
impl Drop for OleApartment {
    fn drop(&mut self) {
        // SAFETY: paired with initialization on this UI thread, after all native objects drop.
        unsafe { OleUninitialize() };
    }
}
struct ClipboardScope(Option<Clipboard>);
impl ClipboardScope {
    fn enter(value: Clipboard) -> Self {
        Self(CLIPBOARD.with(|slot| slot.replace(Some(value))))
    }
}
impl Drop for ClipboardScope {
    fn drop(&mut self) {
        CLIPBOARD.with(|slot| slot.replace(self.0.take()));
    }
}

type PendingFence = (mpsc::Receiver<()>, Box<dyn FnOnce(Result<(), String>)>);

/// UI-thread-owned native terminal renderer. Drop releases the engine and hidden HWND.
pub struct TerminalSurface {
    view: Rc<AppView>,
    frames: RefCell<FrameClock>,
    admissions: RefCell<InputAdmissions>,
    on_frame: RefCell<Box<dyn FnMut(PreparedFrame)>>,
    error: Rc<RefCell<Option<String>>>,
    clipboard: Clipboard,
    paused: Cell<bool>,
    active: Cell<bool>,
    closed: Cell<bool>,
    quit: Cell<bool>,
    focus_generation: Cell<u64>,
    stamp: Cell<(u64, u64)>,
    fence: RefCell<Option<PendingFence>>,
    _ole: OleApartment,
}
impl TerminalSurface {
    /// Creates an invisible native host with explicit application capabilities.
    pub fn new(
        config: nsh_engine::EngineConfig,
        size: Size<DevicePixels>,
        scale: f32,
        on_frame: Box<dyn FnMut(PreparedFrame)>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        let mut frames = FrameClock::default();
        frames.set_viewport(size, scale)?;
        // SAFETY: initialized and released on this object's owning UI thread.
        unsafe { OleInitialize(None) }.map_err(|e| e.to_string())?;
        let ole = OleApartment;
        let view = AppView::new(None, AppOptions::default()).map_err(|e| e.to_string())?;
        let error = Rc::new(RefCell::new(None));
        let out = error.clone();
        view.surface()
            .set_error_handler(Box::new(move |e| *out.borrow_mut() = Some(e.to_owned())));
        *view.surface().terminal_wake.borrow_mut() = Some(wake);
        view.surface().terminal_active.set(Some(true));
        let mut env = view.surface().environment.get();
        env.ctrl_for_command = true;
        view.surface().environment.set(env);
        let result = Self {
            view,
            frames: RefCell::new(frames),
            admissions: RefCell::default(),
            on_frame: RefCell::new(on_frame),
            error,
            clipboard: Rc::default(),
            paused: Cell::new(false),
            active: Cell::new(true),
            closed: Cell::new(false),
            quit: Cell::new(false),
            stamp: Cell::new((0, 0)),
            fence: RefCell::new(None),
            focus_generation: Cell::new(0),
            _ole: ole,
        };
        result.set_viewport(size, scale)?;
        result.load_with_config(config);
        if let Some(error) = result.take_error() {
            return Err(error);
        }
        Ok(result)
    }
    fn scope(&self) -> ClipboardScope {
        ClipboardScope::enter(self.clipboard.clone())
    }
    fn sync_focus(&self) -> Option<TextInputTarget> {
        let generation = self.view.surface().terminal_focus_generation.get();
        if self.focus_generation.replace(generation) != generation {
            self.admissions.borrow_mut().focus(None);
        }
        let node = if self.paused.get()
            || !self.active.get()
            || self.closed.get()
            || !self.view.surface().running()
        {
            None
        } else {
            crate::text_input::terminal_target(self.view.surface()).map(|(id, _)| id)
        };
        self.admissions.borrow_mut().focus(node)
    }
    fn pointer(
        &self,
        kind: PointerKind,
        position: nsh_terminal::Point<Points>,
        button: u8,
        buttons: u8,
        modifiers: nsh_terminal::Modifiers,
        clicks: usize,
    ) {
        crate::input::pointer(
            self.view.surface(),
            PointerEvent {
                kind,
                x: position.x.0,
                y: position.y.0,
                button,
                buttons,
                pointer: 1,
                touch: false,
                pen: false,
                time: self.view.surface().clock(),
                modifiers: mods(modifiers),
                clicks: clicks as u32,
            },
        );
    }
    fn key(&self, stroke: nsh_terminal::Keystroke, down: bool, repeat: bool) {
        let key = nsh_core::keymap::Keystroke::parse(&stroke.key, nsh_core::platform::Os::Windows)
            .ok()
            .and_then(|k| k.key.virtual_key());
        if down
            && matches!(key, Some(0x0D | 0x1B))
            && crate::text_input::terminal_is_composing(self.view.surface())
        {
            return;
        }
        let handled = key.is_some_and(|vk| {
            crate::input::key(
                self.view.surface(),
                KeyEvent {
                    vk,
                    down,
                    repeat,
                    modifiers: mods(stroke.modifiers),
                },
            )
        });
        if down
            && !handled
            && !stroke.modifiers.control
            && !stroke.modifiers.platform
            && let Some(text) = stroke.key_char
        {
            crate::text_input::char_input(self.view.surface(), &text);
        }
    }
}
impl NativeSurface for TerminalSurface {
    fn set_selected_text_range(&self, range: Range<usize>) -> Result<(), String> {
        let view =
            crate::text_input::focused(self.view.surface()).ok_or("no focused native editor")?;
        crate::text_input::terminal_validate_selection(self.view.surface(), &range)?;
        let start = u32::try_from(range.start).map_err(|e| e.to_string())?;
        let end = u32::try_from(range.end).map_err(|e| e.to_string())?;
        crate::text_input::set_selection(&view, start, end);
        Ok(())
    }
    fn is_active(&self) -> bool {
        self.active.get() && !self.closed.get() && self.view.surface().running()
    }
    fn stop(&self) {
        self.paused.set(true);
        self.admissions.borrow_mut().focus(None);
        self.frames.borrow_mut().revoke();
        self.cancel_pointer();
        self.view.stop();
        let fence = self.fence.borrow_mut().take();
        if let Some((_, done)) = fence {
            done(Err("native app stopped before input fence".into()));
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
        self.clipboard.borrow_mut().text = Some(text.to_owned());
        if !crate::system::set_clipboard_text(text) {
            *self.error.borrow_mut() = Some("cannot set Windows clipboard".into());
        }
    }
    fn drop_paths(&self, paths: Vec<std::path::PathBuf>, position: nsh_terminal::Point<Points>) {
        if self.paused.get() || self.closed.get() || !self.view.surface().running() {
            return;
        }
        if let Err(error) = self.set_active(true) {
            *self.error.borrow_mut() = Some(error);
            return;
        }
        crate::file_drop::terminal_drop(self.view.surface(), paths, position);
    }
    fn set_viewport(&self, size: Size<DevicePixels>, scale: f32) -> Result<(), String> {
        if self.closed.get() {
            return Err("terminal surface stopped".into());
        }
        self.frames.borrow_mut().set_viewport(size, scale)?;
        self.cancel_pointer();
        self.view
            .surface()
            .resized((size.width.0 as u32, size.height.0 as u32), scale);
        self.stamp.set((0, 0));
        Ok(())
    }
    fn pump_with_draw(&self, draw: bool) -> bool {
        if self.closed.get() {
            return false;
        }
        let _scope = self.scope();
        let mut msg = MSG::default();
        // SAFETY: dispatch only this UI thread's queued native messages.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    self.quit.set(true);
                } else {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        self.view.surface().drain();
        if self.view.surface().wants_frames() {
            self.view.surface().tick();
            self.view.surface().drain();
        }
        let complete = self.fence.borrow().as_ref().map(|(rx, _)| rx.try_recv());
        if let Some(result) = complete
            && !matches!(result, Err(mpsc::TryRecvError::Empty))
        {
            let surface = self.view.surface();
            surface.drain();
            if result.is_err() {
                if let Some((_, done)) = self.fence.borrow_mut().take() {
                    done(Err("engine stopped before input fence".into()));
                }
            } else if crate::text_input::has_pending(surface) {
                if surface.events_sent() > surface.events_handled() {
                    let (tx, rx) = mpsc::channel();
                    surface.control(|c| {
                        c.flush(move |_| {
                            let _ = tx.send(());
                        });
                    });
                    if let Some((slot, _)) = self.fence.borrow_mut().as_mut() {
                        *slot = rx;
                    }
                } else if let Some((_, done)) = self.fence.borrow_mut().take() {
                    crate::text_input::disarm(surface);
                    done(Err("pending input has no editable focus target".into()));
                }
            } else if surface.events_sent() > surface.events_handled() {
                let (tx, rx) = mpsc::channel();
                surface.control(|c| {
                    c.flush(move |_| {
                        let _ = tx.send(());
                    });
                });
                if let Some((slot, _)) = self.fence.borrow_mut().as_mut() {
                    *slot = rx;
                }
            } else if let Some((_, done)) = self.fence.borrow_mut().take() {
                done(Ok(()));
            }
        }
        if self.closed.get() {
            return false;
        }
        self.sync_focus();
        let surface = self.view.surface();
        let stamp = (surface.whole_change(), surface.root.changes());
        if !draw || !self.active.get() || stamp == self.stamp.get() {
            return false;
        }
        if surface.native.needs_window_composition() {
            *self.error.borrow_mut() = Some(
                "Windows terminal capture cannot include externally composed web views or child windows".into(),
            );
            return false;
        }
        let scale = self.frames.borrow().scale();
        let capture = crate::render::snapshot(surface, scale, None)
            .map_err(|e| e.to_string())
            .and_then(|pixels| {
                let mut rgba = pixels.data;
                for px in rgba.as_chunks_mut::<4>().0 {
                    let a = px[3] as u32;
                    let un = |v: u8| {
                        (v as u32 * 255 + a / 2)
                            .checked_div(a)
                            .map_or(0, |q| q.min(255) as u8)
                    };
                    let (r, g, b) = (un(px[2]), un(px[1]), un(px[0]));
                    px[0] = r;
                    px[1] = g;
                    px[2] = b;
                }
                self.frames.borrow_mut().prepare(rgba)
            });
        match capture {
            Ok(frame) => {
                self.stamp.set(stamp);
                (self.on_frame.borrow_mut())(frame);
                true
            }
            Err(e) => {
                *self.error.borrow_mut() = Some(e);
                false
            }
        }
    }
    fn dispatch_input(&self, input: PlatformInput) -> Result<(), String> {
        if !self.is_active() || self.paused.get() {
            return Err("terminal input is inactive".into());
        }
        let _scope = self.scope();
        match input {
            PlatformInput::KeyDown(e) => self.key(e.keystroke, true, e.is_held),
            PlatformInput::KeyUp(e) => self.key(e.keystroke, false, false),
            PlatformInput::MouseDown(e) => {
                let b = button(e.button);
                self.pointer(
                    PointerKind::Down,
                    e.position,
                    b,
                    1 << b,
                    e.modifiers,
                    e.click_count,
                )
            }
            PlatformInput::MouseUp(e) => self.pointer(
                PointerKind::Up,
                e.position,
                button(e.button),
                0,
                e.modifiers,
                e.click_count,
            ),
            PlatformInput::MouseMove(e) => {
                let b = e.pressed_button.map(button);
                self.pointer(
                    PointerKind::Move,
                    e.position,
                    b.unwrap_or(0),
                    b.map_or(0, |b| 1 << b),
                    e.modifiers,
                    0,
                )
            }
            PlatformInput::ScrollWheel(e) => {
                let (dx, dy, precise) = match e.delta {
                    nsh_terminal::ScrollDelta::Lines(p) => (-p.x * 40.0, -p.y * 40.0, false),
                    nsh_terminal::ScrollDelta::Pixels(p) => (-p.x.0, -p.y.0, true),
                };
                crate::input::wheel(
                    self.view.surface(),
                    WheelEvent {
                        x: e.position.x.0,
                        y: e.position.y.0,
                        dx,
                        dy,
                        precise,
                        modifiers: mods(e.modifiers),
                        time: self.view.surface().clock(),
                    },
                );
            }
        }
        self.sync_focus();
        Ok(())
    }
    fn set_active(&self, active: bool) -> Result<(), String> {
        if self.closed.get() {
            return Err("terminal surface stopped".into());
        }
        self.active.set(active);
        self.view.surface().terminal_active.set(Some(active));
        if !active {
            self.cancel_pointer();
            crate::text_input::terminal_composition(self.view.surface(), "", "", None, false)?;
        }
        crate::text_input::window_focus(self.view.surface(), active);
        self.view.surface().activation_changed(active);
        let mut env = self.view.surface().environment.get();
        env.lifecycle = if active {
            nsh_core::platform::Lifecycle::Active
        } else {
            nsh_core::platform::Lifecycle::Inactive
        };
        self.view.surface().set_environment(env);
        self.sync_focus();
        Ok(())
    }
    fn cancel_pointer(&self) {
        self.pointer(
            PointerKind::Cancel,
            Default::default(),
            0,
            0,
            Default::default(),
            0,
        );
        crate::input::cancel_keyboard_press(self.view.surface());
    }
    fn paste(&self, event: nsh_core::PasteEvent) -> bool {
        if !self.paused.get()
            && self.active.get()
            && !self.closed.get()
            && (self.sync_focus().is_some() || crate::text_input::is_armed(self.view.surface()))
        {
            let _scope = self.scope();
            crate::text_input::terminal_paste(self.view.surface(), event);
            true
        } else {
            false
        }
    }
    fn load_with_config(&self, config: nsh_engine::EngineConfig) {
        if self.closed.get() {
            *self.error.borrow_mut() = Some("cannot load a closed terminal surface".into());
            return;
        }
        self.error.borrow_mut().take();
        self.admissions.borrow_mut().focus(None);
        self.frames.borrow_mut().revoke();
        self.cancel_pointer();
        let appearance = match config.environment.color_scheme {
            nsh_engine::ColorScheme::Light => crate::Appearance::Light,
            nsh_engine::ColorScheme::Dark => crate::Appearance::Dark,
        };
        crate::system::set_appearance(self.view.surface(), appearance);
        self.view.load_with_config(config);
        self.paused.set(false);
        self.stamp.set((0, 0));
        if let Err(e) = self.set_active(self.active.get()) {
            *self.error.borrow_mut() = Some(e);
        }
    }
    fn pause_input(&self, done: Box<dyn FnOnce(Result<(), String>)>) {
        if self.closed.get() || !self.view.surface().running() {
            done(Err("native engine is not running".into()));
            return;
        }
        if self.fence.borrow().is_some() {
            done(Err("input pause already pending".into()));
            return;
        }
        self.paused.set(true);
        self.cancel_pointer();
        if let Err(error) =
            crate::text_input::terminal_composition(self.view.surface(), "", "", None, false)
        {
            done(Err(error));
            return;
        }
        self.admissions.borrow_mut().focus(None);
        let (tx, rx) = mpsc::channel();
        self.view.surface().control(|c| {
            c.flush(move |_| {
                let _ = tx.send(());
            })
        });
        *self.fence.borrow_mut() = Some((rx, done));
    }
    fn resume_input(&self) {
        if self.closed.get() || !self.view.surface().running() {
            return;
        }
        self.paused.set(false);
        self.sync_focus();
    }
    fn text_input_target(&self) -> Option<TextInputTarget> {
        self.sync_focus()
    }
    fn apply_composition(
        &self,
        target: &TextInputTarget,
        commit: &str,
        preedit: &str,
        selection: Option<Range<usize>>,
        active: bool,
    ) -> Result<bool, String> {
        self.sync_focus();
        if !self.admissions.borrow().accepts(target) {
            return Ok(false);
        }
        let selection = selection
            .map(|r| {
                Ok::<_, String>(utf16_offset(preedit, r.start)?..utf16_offset(preedit, r.end)?)
            })
            .transpose()?;
        crate::text_input::terminal_composition(
            self.view.surface(),
            commit,
            preedit,
            selection,
            active,
        )?;
        Ok(true)
    }
    fn input_caret_bounds(&self) -> Option<Bounds<Points>> {
        self.sync_focus()?;
        crate::text_input::terminal_target(self.view.surface()).map(|(_, b)| b)
    }
    fn input_candidate_bounds(&self) -> Option<Bounds<Points>> {
        self.sync_focus()?;
        crate::text_input::terminal_candidate(self.view.surface())
    }
    fn take_clipboard_write(&self) -> Option<String> {
        self.clipboard.borrow_mut().pending.take()
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
        self.quit.get() || self.view.surface().hwnd().is_invalid()
    }
    fn has_pending(&self) -> bool {
        if self.closed.get() {
            return false;
        }
        self.fence.borrow().is_some()
            || crate::text_input::has_pending(self.view.surface())
            || self.stamp.get()
                != (
                    self.view.surface().whole_change(),
                    self.view.surface().root.changes(),
                )
    }
    fn next_deadline(&self) -> Option<Instant> {
        (!self.closed.get()).then(|| Instant::now() + Duration::from_millis(16))
    }
    fn shutdown(&self) {
        if self.closed.replace(true) {
            return;
        }
        self.admissions.borrow_mut().focus(None);
        self.frames.borrow_mut().revoke();
        self.view.stop();
        let fence = self.fence.borrow_mut().take();
        if let Some((_, done)) = fence {
            done(Err("terminal surface stopped".into()));
        }
        // SAFETY: the hidden HWND and OLE apartment belong to this UI thread.
        unsafe {
            let _ = DestroyWindow(self.view.hwnd());
        }
    }
}
impl Drop for TerminalSurface {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn button(b: nsh_terminal::MouseButton) -> u8 {
    match b {
        nsh_terminal::MouseButton::Left => 0,
        nsh_terminal::MouseButton::Right => 1,
        nsh_terminal::MouseButton::Middle => 2,
    }
}
fn pressable_bounds_in(surface: &crate::surface::Surface, label: &str) -> Vec<Bounds<Points>> {
    fn visit(view: &crate::view::NshView, label: &str, out: &mut Vec<Bounds<Points>>) {
        let state = view.state();
        if state.props.pointer_events == nsh_core::PointerEvents::None
            || state.live.as_ref().is_some_and(|l| l.dying())
            || crate::access::part(&state) == crate::access::Part::Hidden
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
                && let Some((x, y, w, h)) = view.to_root().and_then(|m| {
                    m.bounds(
                        visible.origin.x.0,
                        visible.origin.y.0,
                        visible.size.width.0,
                        visible.size.height.0,
                    )
                })
            {
                out.push(crate::geom::rect(x, y, w, h));
            }
        }
        if pointer_events != nsh_core::PointerEvents::BoxOnly {
            view.with_children(|children| {
                for child in children {
                    visit(child, label, out);
                }
            });
        }
    }
    let mut out = Vec::new();
    visit(&crate::navigation::focus_scope(surface), label, &mut out);
    out
}
fn mods(m: nsh_terminal::Modifiers) -> Modifiers {
    Modifiers {
        shift: m.shift,
        ctrl: m.control,
        alt: m.alt,
        meta: m.platform,
    }
}
pub(crate) fn utf16_offset(text: &str, offset: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += ch.len_utf16();
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err("composition selection splits UTF-16 or exceeds preedit".into())
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{EventKind, ModalAnimation, ModalConfig, NodeId, ViewKind};

    use super::{
        Clipboard, ClipboardScope, clipboard_read, clipboard_write, pressable_bounds_in,
        utf16_offset,
    };
    use crate::{geom::rect, navigation, surface::Surface, view::NshView};

    #[test]
    fn clipboard_transport_receipt_keeps_native_paste_text() {
        let clipboard = Clipboard::default();
        let _scope = ClipboardScope::enter(clipboard.clone());
        assert!(clipboard_write("copied text"));
        assert_eq!(
            clipboard.borrow_mut().pending.take().as_deref(),
            Some("copied text")
        );
        assert_eq!(clipboard_read().as_deref(), Some("copied text"));
        assert!(clipboard.borrow_mut().pending.take().is_none());
    }

    #[test]
    fn composition_selection_uses_utf16_not_utf8_offsets() {
        let text = "a😀中";
        assert_eq!(utf16_offset(text, 0), Ok(0));
        assert_eq!(utf16_offset(text, 1), Ok(1));
        assert_eq!(utf16_offset(text, 3), Ok(5));
        assert_eq!(utf16_offset(text, 4), Ok(text.len()));
        assert!(utf16_offset(text, 2).is_err());
        assert!(utf16_offset(text, 5).is_err());
    }

    #[test]
    fn pressable_bounds_respects_active_modal_and_disabled_state() {
        let surface = Surface::new(Default::default());
        surface.root.state_mut().frame = rect(0.0, 0.0, 800.0, 600.0);
        let button = |parent: &NshView, id: NodeId, label: &str, y: f32| {
            let view = NshView::new(id, ViewKind::View);
            {
                let mut state = view.state_mut();
                state.frame = rect(10.0, y, 120.0, 32.0);
                state.events.set(EventKind::Press, true);
                state.props.accessibility.label = Some(label.into());
            }
            view.insert_before(parent, None);
            view
        };
        let background = button(&surface.root, 2, "Focus message composer", 400.0);
        assert_eq!(
            pressable_bounds_in(&surface, "Focus message composer").len(),
            1
        );

        background.state_mut().props.accessibility.state.disabled = true;
        assert!(pressable_bounds_in(&surface, "Focus message composer").is_empty());
        background.state_mut().props.accessibility.state.disabled = false;

        let modal = NshView::new(3, ViewKind::Modal);
        modal.state_mut().frame = rect(0.0, 0.0, 800.0, 600.0);
        let confirm = button(&modal, 4, "Use this workspace folder", 200.0);
        navigation::modal_config(
            &surface,
            &modal,
            &ModalConfig {
                animation: ModalAnimation::None,
                ..Default::default()
            },
        );
        navigation::present(&surface, &modal);
        navigation::end_batch(&surface);

        assert!(pressable_bounds_in(&surface, "Focus message composer").is_empty());
        assert_eq!(
            pressable_bounds_in(&surface, "Use this workspace folder").len(),
            1
        );
        let _ = confirm;

        navigation::dismiss(&surface, &modal);
        navigation::end_batch(&surface);
        assert_eq!(
            pressable_bounds_in(&surface, "Focus message composer").len(),
            1
        );
    }
}
