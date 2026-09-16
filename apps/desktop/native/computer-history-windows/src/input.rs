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

//! Input facts only: no text, target content, click inference or submission result.
//! The recorder owns consent and source validation. Renew `set_scope` each admitted
//! pass, changing the epoch on focus/document/control identity or policy changes,
//! not on every value/content mutation of the same control. Revoke with `None`
//! before pause/lock and drop the observer to uninstall. Revalidate before storing.
//! The callback checks foreground ownership and exact native focus. NativeChild
//! mouse facts additionally require WindowFromPoint to hit the admitted child.
//! ObservedUia is keyboard-only and requires the recorder's live subscription
//! lease, semantic focus/password validation and identity epoch, never a one-shot
//! snapshot alone. UIA is never called from a hook; the recorder revalidates that
//! lease and exact element/document identity before storing. These are receipt-
//! time observations, not proof of delivery or atomic semantic focus continuity.
//! For native Edit controls, the callback rejects an unreadable native style or
//! ES_PASSWORD; it must not interpret Edit styles on generic UIA hosts.
//! This receipt-time check cannot detect a protected-state
//! transition that begins and ends between observations; it is not an ABA fence.
//! A drain with `interrupted` requires discarding any pending mouse-down pairing.
//! Renew admission from the recorder's fast event loop, independently of snapshot
//! worker completion. A live thread does not prove live hooks: Windows may silently
//! remove a timed-out low-level hook. Missing input is never proof of inactivity.

use std::{
    collections::VecDeque,
    time::{Duration, Instant, SystemTime},
};

pub const MAX_FACTS: usize = 128;
pub const MAX_FACT_AGE: Duration = Duration::from_secs(2);
pub const ADMISSION_TTL: Duration = Duration::from_millis(250);
pub const MAX_PRESS_AGE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputMode {
    NativeChild,
    ObservedUia,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputScope {
    pub hwnd: usize,
    pub pid: u32,
    /// Actual native focus host; only a leased UIA target may use the root HWND.
    pub focus_hwnd: usize,
    pub mode: InputMode,
    /// Some only after live UIA subscription admission, not one-shot capture.
    /// The recorder verifies liveness at renewal/drain/write and changes `epoch`
    /// on replacement even if a new lease starts with the same identity counter.
    pub uia_lease_epoch: Option<u64>,
    /// Recorder-owned lifetime, including focus, document and policy generations.
    pub epoch: u64,
}

impl InputScope {
    pub(crate) fn is_admitted(self) -> bool {
        self.hwnd != 0
            && self.pid != 0
            && self.focus_hwnd != 0
            && match self.mode {
                InputMode::NativeChild => {
                    self.focus_hwnd != self.hwnd && self.uia_lease_epoch.is_none()
                }
                InputMode::ObservedUia => self.uia_lease_epoch.is_some(),
            }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

impl Modifiers {
    pub fn names(self) -> impl Iterator<Item = &'static str> {
        [
            (self.control, "control"),
            (self.shift, "shift"),
            (self.alt, "alt"),
            (self.meta, "meta"),
        ]
        .into_iter()
        .filter_map(|(down, name)| down.then_some(name))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl MouseButton {
    fn mask(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::Right => 2,
            Self::Middle => 4,
            Self::X1 => 8,
            Self::X2 => 16,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
            Self::X1 | Self::X2 => "other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseGesture {
    Click,
    Drag,
    Disqualified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputKind {
    /// Plain or Shift+Return key-down only; never proof of submission.
    Return,
    /// A modified virtual key, not translated text or an inferred command.
    Shortcut {
        virtual_key: u32,
    },
    MouseDown {
        button: MouseButton,
        x: i32,
        y: i32,
    },
    MouseUp {
        button: MouseButton,
        x: i32,
        y: i32,
        gesture: MouseGesture,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct InputFact {
    pub scope: InputScope,
    pub kind: InputKind,
    pub modifiers: Modifiers,
    /// Native DWORD event time. Compare using wrapping subtraction, not wall time.
    pub os_time_ms: u32,
    pub observed_at: Instant,
    /// Receipt time, not a claim about when the target processed the input.
    pub received_at: SystemTime,
}

#[derive(Debug, Default)]
pub struct InputBatch {
    pub facts: Vec<InputFact>,
    pub interrupted: bool,
}

#[derive(Clone, Copy)]
struct CallbackTarget {
    hwnd: usize,
    pid: u32,
    focus_hwnd: usize,
    hit_hwnd: Option<usize>,
}

struct FactBuffer {
    admission: Option<(InputScope, Instant, u32)>,
    facts: VecDeque<InputFact>,
    interrupted: bool,
    mouse_down: Option<MousePress>,
    held_buttons: u8,
}

struct MousePress {
    button: MouseButton,
    x: i32,
    y: i32,
    os_time_ms: u32,
    observed_at: Instant,
    dragged: bool,
}

fn outside_click_radius(start: (i32, i32), end: (i32, i32)) -> bool {
    let dx = i64::from(end.0) - i64::from(start.0);
    let dy = i64::from(end.1) - i64::from(start.1);
    dx.abs() > 6 || dy.abs() > 6 || dx * dx + dy * dy > 36
}

impl MousePress {
    fn current(&self, os_time_ms: u32, now: Instant) -> bool {
        os_time_ms.wrapping_sub(self.os_time_ms) <= MAX_PRESS_AGE.as_millis() as u32
            && now.saturating_duration_since(self.observed_at) <= MAX_PRESS_AGE
    }
}

impl Default for FactBuffer {
    fn default() -> Self {
        Self {
            admission: None,
            facts: VecDeque::with_capacity(MAX_FACTS),
            interrupted: false,
            mouse_down: None,
            held_buttons: 0,
        }
    }
}

impl FactBuffer {
    fn interrupt(&mut self) {
        self.facts.clear();
        self.interrupted = true;
        self.mouse_down = None;
        // Revocation discards attribution, not physical button state. Releases
        // must still arrive before an interrupted chord can start a new press.
    }

    fn reject_injected_mouse(&mut self, flags: u32) -> bool {
        // An injected release can end a physical press. Discard the sequence,
        // including a down already drained by the recorder, without retaining it.
        if flags & 3 == 0 {
            return false;
        }
        self.interrupt();
        true
    }

    fn observe_mouse(
        &mut self,
        message: u32,
        flags: u32,
        point: (i32, i32),
        os_time_ms: u32,
        now: Instant,
        target: impl FnOnce() -> Option<CallbackTarget>,
    ) {
        if self.reject_injected_mouse(flags) || message != 0x200 {
            return;
        }
        if self.mouse_down.is_none() {
            return;
        }
        if self.admit(target(), true, os_time_ms, now).is_none() {
            return;
        }
        let Some(press) = &mut self.mouse_down else {
            return;
        };
        if !press.current(os_time_ms, now) {
            self.mouse_down = None;
            return;
        }
        // Only the eventual Up carries the bounded excursion result. Ordinary
        // movement must not discard independent queued keyboard observations.
        press.dragged |= outside_click_radius((press.x, press.y), point);
    }

    fn set_scope(&mut self, scope: Option<InputScope>, now: Instant, os_time_ms: u32) {
        let scope = scope.filter(|s| s.is_admitted());
        let continued = self.admission.filter(|(old, renewed, _)| {
            Some(*old) == scope && now.saturating_duration_since(*renewed) <= ADMISSION_TTL
        });
        if self.admission.is_some_and(|(old, renewed, _)| {
            Some(old) != scope || now.saturating_duration_since(renewed) > ADMISSION_TTL
        }) || scope.is_none()
        {
            self.interrupt();
        }
        self.admission =
            scope.map(|s| (s, now, continued.map_or(os_time_ms, |(_, _, since)| since)));
    }

    fn admit(
        &mut self,
        target: Option<CallbackTarget>,
        mouse: bool,
        os_time_ms: u32,
        now: Instant,
    ) -> Option<InputScope> {
        let (scope, renewed, since) = self.admission?;
        if mouse && scope.mode == InputMode::ObservedUia {
            return None;
        }
        let target_matches = target.is_some_and(|target| {
            target.hwnd == scope.hwnd
                && target.pid == scope.pid
                && target.focus_hwnd == scope.focus_hwnd
                && (!mouse || target.hit_hwnd == Some(scope.focus_hwnd))
        });
        if !target_matches
            || now.saturating_duration_since(renewed) > ADMISSION_TTL
            || os_time_ms.wrapping_sub(since) == 0
            || os_time_ms.wrapping_sub(since) > i32::MAX as u32
        {
            self.interrupt();
            self.admission = None;
            return None;
        }
        Some(scope)
    }

    fn push(
        &mut self,
        target: Option<CallbackTarget>,
        mut kind: InputKind,
        modifiers: impl Into<Option<Modifiers>>,
        os_time_ms: u32,
        now: Instant,
        received_at: SystemTime,
    ) {
        let mouse = matches!(
            kind,
            InputKind::MouseDown { .. } | InputKind::MouseUp { .. }
        );
        let previously_held = self.held_buttons;
        match kind {
            InputKind::MouseDown { button, .. } => self.held_buttons |= button.mask(),
            InputKind::MouseUp { button, .. } => self.held_buttons &= !button.mask(),
            _ => {}
        }
        let Some(modifiers) = modifiers.into() else {
            self.interrupt();
            return;
        };
        let Some(scope) = self.admit(target, mouse, os_time_ms, now) else {
            self.mouse_down = None;
            return;
        };
        if self.facts.len() == MAX_FACTS {
            // Do not retain an arbitrary tail which could pair with an old down.
            self.interrupt();
            self.admission = None;
            return;
        }
        match &mut kind {
            InputKind::MouseDown { button, x, y } => {
                // Overlap or a duplicate down cancels the whole gesture. Keep
                // tracking releases so another down cannot revive it mid-chord.
                self.mouse_down = (previously_held == 0).then_some(MousePress {
                    button: *button,
                    x: *x,
                    y: *y,
                    os_time_ms,
                    observed_at: now,
                    dragged: false,
                });
            }
            InputKind::MouseUp {
                button,
                x,
                y,
                gesture,
            } => {
                *gesture = match self.mouse_down.take() {
                    Some(press) if press.button == *button && press.current(os_time_ms, now) => {
                        if press.dragged || outside_click_radius((press.x, press.y), (*x, *y)) {
                            MouseGesture::Drag
                        } else {
                            MouseGesture::Click
                        }
                    }
                    _ => MouseGesture::Disqualified,
                };
            }
            _ => {}
        }
        self.facts.push_back(InputFact {
            scope,
            kind,
            modifiers,
            os_time_ms,
            observed_at: now,
            received_at,
        });
    }

    fn drain(&mut self, scope: InputScope, now: Instant) -> InputBatch {
        if self.admission.is_none_or(|(admitted, renewed, _)| {
            admitted != scope || now.saturating_duration_since(renewed) > ADMISSION_TTL
        }) || self
            .facts
            .front()
            .is_some_and(|fact| now.saturating_duration_since(fact.observed_at) > MAX_FACT_AGE)
        {
            self.interrupt();
            self.admission = None;
        }
        InputBatch {
            facts: self.facts.drain(..).collect(),
            interrupted: std::mem::take(&mut self.interrupted),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeEditClass {
    Standard,
    Rich,
}

/// Class eligibility only; the snapshot must still validate the actual provider,
/// focused child HWND, source and privacy. Never apply Edit styles to other classes.
pub fn native_edit_class(class: &str) -> Option<NativeEditClass> {
    if class == "Edit" || class.starts_with("WindowsForms10.EDIT.") {
        Some(NativeEditClass::Standard)
    } else if matches!(class, "RichEdit20W" | "RICHEDIT50W")
        || class.starts_with("WindowsForms10.RichEdit20W.")
        || class.starts_with("WindowsForms10.RICHEDIT50W.")
    {
        Some(NativeEditClass::Rich)
    } else {
        None
    }
}

/// Maps an admitted native family and its observed UIA type to an action role.
/// The caller still owns framework, visible-leaf, HWND/PID, focus and privacy checks.
pub fn native_input_role(class: &str, control_type: i32) -> Option<&'static str> {
    // Actual provider roles only; this does not grant access to text patterns.
    match (native_edit_class(class)?, control_type) {
        (NativeEditClass::Standard, 50004) => Some("AXTextField"),
        (NativeEditClass::Rich, 50033) => Some("AXGroup"),
        (NativeEditClass::Rich, 50030) => Some("AXDocument"),
        _ => None,
    }
}

fn style_is_admitted(style: Option<isize>) -> bool {
    // Both admitted Edit and Rich Edit families use ES_PASSWORD.
    style.is_some_and(|style| style & 0x20 == 0)
}

fn callback_style_is_admitted(scope: InputScope, read: impl FnOnce() -> Option<isize>) -> bool {
    scope.is_admitted()
        && match scope.mode {
            InputMode::NativeChild => style_is_admitted(read()),
            // ES_PASSWORD is an Edit-class style, not a generic-host signal.
            InputMode::ObservedUia => true,
        }
}

// Left/right modifier VKs are contiguous, 0xA0..=0xA5; Windows keys use bits 6/7.
#[derive(Default)]
struct KeyboardState {
    down: u8,
    injected: u8,
}

impl KeyboardState {
    fn modifiers(&self) -> Option<Modifiers> {
        (self.injected == 0).then_some(Modifiers {
            shift: self.down & 0b0000_0011 != 0,
            control: self.down & 0b0000_1100 != 0,
            alt: self.down & 0b0011_0000 != 0,
            meta: self.down & 0b1100_0000 != 0,
        })
    }

    fn key(
        &mut self,
        virtual_key: u32,
        scan_code: u32,
        extended: bool,
        pressed: bool,
        injected: bool,
    ) -> Option<(InputKind, Modifiers)> {
        let modifier = match virtual_key {
            0x10 => Some(if scan_code == 0x36 { 1 } else { 0 }),
            0x11 => Some(if extended { 3 } else { 2 }),
            0x12 => Some(if extended { 5 } else { 4 }),
            0xA0..=0xA5 => Some(virtual_key - 0xA0),
            0x5B => Some(6),
            0x5C => Some(7),
            _ => None,
        };
        if let Some(bit) = modifier {
            let mask = 1 << bit;
            self.down &= !mask;
            self.injected &= !mask;
            if pressed {
                if injected {
                    self.injected |= mask;
                } else {
                    self.down |= mask;
                }
            }
            return None;
        }
        if injected || !pressed {
            return None;
        }
        let modifiers = self.modifiers()?;
        // Right Alt may be AltGr composition, including Return to confirm it.
        if self.down & (1 << 5) != 0 {
            return None;
        }
        let shortcut = modifiers.control || modifiers.alt || modifiers.meta;
        if virtual_key == 0x0D && !shortcut {
            return Some((InputKind::Return, modifiers));
        }
        if !shortcut
            || !matches!(virtual_key,
                0x08 | 0x09 | 0x0D | 0x1B | 0x20..=0x28 | 0x2D | 0x2E |
                0x30..=0x39 | 0x41..=0x5A | 0x70..=0x87)
        {
            return None;
        }
        Some((InputKind::Shortcut { virtual_key }, modifiers))
    }
}

fn mouse_kind(message: u32, data: u32, flags: u32, x: i32, y: i32) -> Option<InputKind> {
    // Win32 LLMHF_INJECTED / LLMHF_LOWER_IL_INJECTED and WM_*BUTTON* ABI values.
    if flags & 3 != 0 {
        return None;
    }
    let (button, down) = match message {
        0x201 => (MouseButton::Left, true),
        0x202 => (MouseButton::Left, false),
        0x204 => (MouseButton::Right, true),
        0x205 => (MouseButton::Right, false),
        0x207 => (MouseButton::Middle, true),
        0x208 => (MouseButton::Middle, false),
        0x20B | 0x20C => (
            match data >> 16 {
                1 => MouseButton::X1,
                2 => MouseButton::X2,
                _ => return None,
            },
            message == 0x20B,
        ),
        _ => return None,
    };
    Some(if down {
        InputKind::MouseDown { button, x, y }
    } else {
        InputKind::MouseUp {
            button,
            x,
            y,
            gesture: MouseGesture::Disqualified,
        }
    })
}

#[cfg(windows)]
pub use native::{InputError, InputObserver};

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        fmt,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        thread::{self, JoinHandle},
    };
    use windows::Win32::{
        Foundation::{GetLastError, LPARAM, LRESULT, POINT, SetLastError, WIN32_ERROR, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, SystemInformation::GetTickCount},
        UI::{
            Input::KeyboardAndMouse::GetAsyncKeyState,
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GA_ROOT, GUI_INMENUMODE, GUI_INMOVESIZE,
                GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE, GUITHREADINFO, GWL_STYLE, GetAncestor,
                GetForegroundWindow, GetGUIThreadInfo, GetWindowLongPtrW, GetWindowThreadProcessId,
                HHOOK, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_INJECTED, LLKHF_LOWER_IL_INJECTED,
                MSG, MSLLHOOKSTRUCT, PM_REMOVE, PeekMessageW, SetWindowsHookExW,
                UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
                WM_SYSKEYDOWN, WM_SYSKEYUP, WindowFromPoint,
            },
        },
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum InputError {
        ThreadStart,
        ThreadStopped,
        StateUnavailable,
        Module(i32),
        KeyboardHook(i32),
        MouseHook(i32),
    }

    impl fmt::Display for InputError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "computer_history_input_{self:?}")
        }
    }

    impl std::error::Error for InputError {}

    #[derive(Default)]
    struct Shared {
        buffer: Mutex<FactBuffer>,
        lost: AtomicBool,
        stop: AtomicBool,
        running: AtomicBool,
    }

    struct HookState {
        shared: Arc<Shared>,
        keyboard: KeyboardState,
        physical_buttons: Cell<u8>,
    }

    thread_local! {
        static HOOK_STATE: RefCell<Option<HookState>> = const { RefCell::new(None) };
        #[cfg(test)]
        static TEST_TARGET: std::cell::Cell<Option<CallbackTarget>> = const { std::cell::Cell::new(None) };
    }

    struct Hook(HHOOK);

    impl Drop for Hook {
        fn drop(&mut self) {
            let _ = unsafe { UnhookWindowsHookEx(self.0) };
        }
    }

    pub struct InputObserver {
        shared: Arc<Shared>,
        thread: Option<JoinHandle<()>>,
    }

    impl InputObserver {
        /// False creates no thread or hooks. True still records nothing until
        /// the recorder supplies a fresh, admitted source with `set_scope`.
        pub fn start(recording_allowed: bool) -> Result<Option<Self>, InputError> {
            Self::start_with(recording_allowed, false)
        }

        fn start_with(
            recording_allowed: bool,
            fail_mouse: bool,
        ) -> Result<Option<Self>, InputError> {
            if !recording_allowed {
                return Ok(None);
            }
            let shared = Arc::new(Shared::default());
            let state = shared.clone();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("history-input".into())
                .spawn(move || {
                    let result = install(fail_mouse);
                    match result {
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                        }
                        Ok(hooks) => {
                            let mut keyboard = KeyboardState::default();
                            for (bit, key) in [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C]
                                .into_iter()
                                .enumerate()
                            {
                                if unsafe { GetAsyncKeyState(key) } < 0 {
                                    // Initial held modifiers have unknown provenance.
                                    // Require release before using them for attribution.
                                    keyboard.injected |= 1 << bit;
                                }
                            }
                            HOOK_STATE.with(|slot| {
                                *slot.borrow_mut() = Some(HookState {
                                    shared: state.clone(),
                                    keyboard,
                                    physical_buttons: Cell::new(0),
                                });
                            });
                            state.running.store(true, Ordering::SeqCst);
                            let _ = ready_tx.send(Ok(()));
                            let mut message = MSG::default();
                            'pump: while !state.stop.load(Ordering::SeqCst) {
                                // Never let a busy queue prevent stop from being observed.
                                for _ in 0..256 {
                                    if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }
                                        .as_bool()
                                    {
                                        break;
                                    }
                                    if message.message == WM_QUIT {
                                        break 'pump;
                                    }
                                    unsafe { DispatchMessageW(&message) };
                                }
                                thread::sleep(Duration::from_millis(5));
                            }
                            state.running.store(false, Ordering::SeqCst);
                            HOOK_STATE.with(|slot| {
                                slot.borrow_mut().take();
                            });
                            drop(hooks);
                        }
                    }
                })
                .map_err(|_| InputError::ThreadStart)?;
            let mut observer = Self {
                shared,
                thread: Some(worker),
            };
            match ready_rx.recv() {
                Ok(Ok(())) => Ok(Some(observer)),
                Ok(Err(error)) => {
                    observer.stop_inner()?;
                    Err(error)
                }
                Err(_) => {
                    observer.stop_inner()?;
                    Err(InputError::ThreadStopped)
                }
            }
        }

        /// Renewal belongs to the fast recorder loop, not a blocking snapshot job.
        /// This reports thread failure, not undetectable OS hook removal.
        pub fn set_scope(&self, scope: Option<InputScope>) -> Result<(), InputError> {
            if !self.shared.running.load(Ordering::SeqCst) {
                return Err(InputError::ThreadStopped);
            }
            let mut buffer = self
                .shared
                .buffer
                .lock()
                .map_err(|_| InputError::StateUnavailable)?;
            buffer.set_scope(scope, Instant::now(), unsafe { GetTickCount() });
            Ok(())
        }

        pub fn drain(&self, scope: InputScope) -> Result<InputBatch, InputError> {
            if !self.shared.running.load(Ordering::SeqCst) {
                return Err(InputError::ThreadStopped);
            }
            let mut buffer = self
                .shared
                .buffer
                .lock()
                .map_err(|_| InputError::StateUnavailable)?;
            if self.shared.lost.swap(false, Ordering::SeqCst) {
                buffer.interrupt();
            }
            let batch = buffer.drain(scope, Instant::now());
            Ok(batch)
        }

        pub fn stop(mut self) -> Result<(), InputError> {
            self.stop_inner()
        }

        fn stop_inner(&mut self) -> Result<(), InputError> {
            self.shared.stop.store(true, Ordering::SeqCst);
            if let Some(worker) = self.thread.take() {
                worker.join().map_err(|_| InputError::ThreadStopped)?;
            }
            let mut buffer = self
                .shared
                .buffer
                .lock()
                .map_err(|_| InputError::StateUnavailable)?;
            buffer.set_scope(None, Instant::now(), unsafe { GetTickCount() });
            Ok(())
        }
    }

    impl Drop for InputObserver {
        fn drop(&mut self) {
            let _ = self.stop_inner();
        }
    }

    fn install(fail_mouse: bool) -> Result<(Hook, Hook), InputError> {
        let module =
            unsafe { GetModuleHandleW(None) }.map_err(|e| InputError::Module(e.code().0))?;
        let keyboard = Hook(
            unsafe {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), Some(module.into()), 0)
            }
            .map_err(|e| InputError::KeyboardHook(e.code().0))?,
        );
        if fail_mouse {
            return Err(InputError::MouseHook(-1));
        }
        let mouse = Hook(
            unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(module.into()), 0) }
                .map_err(|e| InputError::MouseHook(e.code().0))?,
        );
        Ok((keyboard, mouse))
    }

    fn callback_target(scope: InputScope, point: Option<POINT>) -> Option<CallbackTarget> {
        #[cfg(test)]
        if let Some(target) = TEST_TARGET.get() {
            return Some(target);
        }
        if !scope.is_admitted() || (point.is_some() && scope.mode == InputMode::ObservedUia) {
            return None;
        }
        let hwnd = unsafe { GetForegroundWindow() };
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if hwnd.0 as usize != scope.hwnd || pid != scope.pid || thread == 0 {
            return None;
        }
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
        if info.hwndActive != hwnd
            || info.hwndFocus.0 as usize != scope.focus_hwnd
            || info.flags.0
                & (GUI_INMENUMODE.0 | GUI_INMOVESIZE.0 | GUI_POPUPMENUMODE.0 | GUI_SYSTEMMENUMODE.0)
                != 0
        {
            return None;
        }
        let mut focus_pid = 0;
        unsafe { GetWindowThreadProcessId(info.hwndFocus, Some(&mut focus_pid)) };
        if focus_pid != pid || unsafe { GetAncestor(info.hwndFocus, GA_ROOT) } != hwnd {
            return None;
        }
        // GetWindowLongPtr does not read content or invoke a UIA provider.
        // Zero can be a valid style, so inspect the error only for that result.
        if !callback_style_is_admitted(scope, || {
            unsafe { SetLastError(WIN32_ERROR(0)) };
            let style = unsafe { GetWindowLongPtrW(info.hwndFocus, GWL_STYLE) };
            (style != 0 || unsafe { GetLastError() }.0 == 0).then_some(style)
        }) {
            return None;
        }
        let hit_hwnd = match point {
            Some(point) => {
                // A sibling's mouse capture can override the geometric hit target.
                if !info.hwndCapture.is_invalid() && info.hwndCapture != info.hwndFocus {
                    return None;
                }
                let hit = unsafe { WindowFromPoint(point) };
                if hit != info.hwndFocus {
                    return None;
                }
                Some(hit.0 as usize)
            }
            None => None,
        };
        (unsafe { GetForegroundWindow() } == hwnd).then_some(CallbackTarget {
            hwnd: hwnd.0 as usize,
            pid,
            focus_hwnd: info.hwndFocus.0 as usize,
            hit_hwnd,
        })
    }

    fn retain(state: &HookState, kind: InputKind, modifiers: Option<Modifiers>, time: u32) {
        if state.shared.stop.load(Ordering::SeqCst) {
            return;
        }
        // The hook thread sees physical transitions even when the recorder
        // holds the fact buffer. Losing attribution must not lose button state.
        let held = state.physical_buttons.get();
        match kind {
            InputKind::MouseDown { button, .. } => {
                state.physical_buttons.set(held | button.mask());
            }
            InputKind::MouseUp { button, .. } => {
                state.physical_buttons.set(held & !button.mask());
            }
            _ => {}
        }
        let Ok(mut buffer) = state.shared.buffer.try_lock() else {
            state.shared.lost.store(true, Ordering::SeqCst);
            return;
        };
        // push applies this callback's transition after classifying its prior
        // held set. No missing fact or interrupted press is reconstructed.
        buffer.held_buttons = held;
        let modifiers = modifiers.filter(|_| !state.shared.lost.load(Ordering::SeqCst));
        if unsafe { GetTickCount() }.wrapping_sub(time) > ADMISSION_TTL.as_millis() as u32 {
            buffer.interrupt();
            buffer.admission = None;
        }
        let point = match kind {
            InputKind::MouseDown { x, y, .. } | InputKind::MouseUp { x, y, .. } => {
                Some(POINT { x, y })
            }
            _ => None,
        };
        let target = modifiers.and_then(|_| {
            buffer
                .admission
                .and_then(|(scope, _, _)| callback_target(scope, point))
        });
        buffer.push(
            target,
            kind,
            modifiers,
            time,
            Instant::now(),
            SystemTime::now(),
        );
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && lparam.0 != 0 {
            let message = wparam.0 as u32;
            if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP) {
                let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
                let _ = HOOK_STATE.try_with(|slot| {
                    if let Ok(mut slot) = slot.try_borrow_mut()
                        && let Some(state) = slot.as_mut()
                        && let Some((kind, modifiers)) = state.keyboard.key(
                            event.vkCode,
                            event.scanCode,
                            event.flags.contains(LLKHF_EXTENDED),
                            matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN),
                            event.flags.0 & (LLKHF_INJECTED.0 | LLKHF_LOWER_IL_INJECTED.0) != 0,
                        )
                    {
                        retain(state, kind, Some(modifiers), event.time);
                    }
                });
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && lparam.0 != 0 {
            let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            if event.flags & 3 != 0 || wparam.0 == 0x200 {
                let _ = HOOK_STATE.try_with(|slot| {
                    if let Ok(slot) = slot.try_borrow()
                        && let Some(state) = slot.as_ref()
                    {
                        if let Ok(mut buffer) = state.shared.buffer.try_lock() {
                            if state.keyboard.modifiers().is_none() {
                                buffer.interrupt();
                            }
                            if unsafe { GetTickCount() }.wrapping_sub(event.time)
                                > ADMISSION_TTL.as_millis() as u32
                            {
                                buffer.interrupt();
                                buffer.admission = None;
                            } else {
                                let scope = buffer.admission.map(|(scope, _, _)| scope);
                                buffer.observe_mouse(
                                    wparam.0 as u32,
                                    event.flags,
                                    (event.pt.x, event.pt.y),
                                    event.time,
                                    Instant::now(),
                                    || {
                                        scope.and_then(|scope| {
                                            callback_target(scope, Some(event.pt))
                                        })
                                    },
                                );
                            }
                        } else {
                            state.shared.lost.store(true, Ordering::SeqCst);
                        }
                    }
                });
            }
            if let Some(kind) = mouse_kind(
                wparam.0 as u32,
                event.mouseData,
                event.flags,
                event.pt.x,
                event.pt.y,
            ) {
                let _ = HOOK_STATE.try_with(|slot| {
                    if let Ok(slot) = slot.try_borrow()
                        && let Some(state) = slot.as_ref()
                    {
                        retain(state, kind, state.keyboard.modifiers(), event.time);
                    }
                });
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn lock_loss(lost_down: bool) {
            use crate::input_actions::Actions;
            struct Reset;
            impl Drop for Reset {
                fn drop(&mut self) {
                    HOOK_STATE.with(|slot| slot.borrow_mut().take());
                    TEST_TARGET.set(None);
                }
            }
            let _reset = Reset;
            let scope = InputScope {
                hwnd: 42,
                pid: 123,
                focus_hwnd: 43,
                mode: InputMode::NativeChild,
                uia_lease_epoch: None,
                epoch: 1,
            };
            let shared = Arc::new(Shared::default());
            shared.running.store(true, Ordering::SeqCst);
            shared.buffer.lock().unwrap().set_scope(
                Some(scope),
                Instant::now(),
                unsafe { GetTickCount() }.wrapping_sub(1),
            );
            TEST_TARGET.set(Some(CallbackTarget {
                hwnd: scope.hwnd,
                pid: scope.pid,
                focus_hwnd: scope.focus_hwnd,
                hit_hwnd: Some(scope.focus_hwnd),
            }));
            HOOK_STATE.with(|slot| {
                *slot.borrow_mut() = Some(HookState {
                    shared: shared.clone(),
                    keyboard: KeyboardState::default(),
                    physical_buttons: Cell::new(0),
                });
            });
            let observer = InputObserver {
                shared: shared.clone(),
                thread: None,
            };
            let mouse = |message| {
                let event = MSLLHOOKSTRUCT {
                    pt: POINT { x: 10, y: 20 },
                    time: unsafe { GetTickCount() },
                    ..Default::default()
                };
                unsafe {
                    mouse_hook(0, WPARAM(message), LPARAM(&event as *const _ as isize));
                }
            };
            let mut actions = Actions::default();
            let drain = |actions: &mut Actions| {
                actions.ingest(observer.drain(scope).unwrap(), scope, Instant::now());
            };
            if !lost_down {
                mouse(0x201);
                drain(&mut actions);
            }
            {
                // Force the real callback's try_lock failure without scheduling
                // or sleeps, losing either LeftDown or LeftUp.
                let _held = shared.buffer.lock().unwrap();
                mouse(if lost_down { 0x201 } else { 0x202 });
                assert!(shared.lost.load(Ordering::SeqCst));
            }
            drain(&mut actions);
            assert!(!actions.pending());
            mouse(0x204);
            mouse(0x205);
            drain(&mut actions);
            let now = Instant::now();
            let output = actions.take(now, now);
            assert_eq!(
                output.iter().map(|action| action.kind).collect::<Vec<_>>(),
                if lost_down {
                    vec![]
                } else {
                    vec!["mouse.contextMenu"]
                },
                "lost physical transition must not fabricate or suppress the next gesture",
            );
            if lost_down {
                mouse(0x202);
                drain(&mut actions);
                assert!(!actions.pending());
            }
            mouse(0x201);
            mouse(0x202);
            drain(&mut actions);
            let now = Instant::now();
            let output = actions.take(now, now);
            assert_eq!(output.len(), 1);
            assert_eq!(output[0].kind, "mouse.click");
        }

        #[test]
        fn lost_down_keeps_chord_disqualified_until_physical_release() {
            lock_loss(true);
        }

        #[test]
        fn lost_up_allows_independent_fresh_gesture_without_replaying_old_press() {
            lock_loss(false);
        }

        #[test]
        fn disabled_policy_never_starts_a_hook_thread() {
            assert!(InputObserver::start(false).unwrap().is_none());
        }

        // Run on an isolated interactive Windows test desktop, not a user's session.
        #[test]
        #[ignore = "requires an isolated Windows interactive test desktop"]
        fn native_install_uninstall_owns_its_thread_and_starts_disarmed() {
            let observer = InputObserver::start(true).unwrap().unwrap();
            assert_ne!(
                observer.thread.as_ref().unwrap().thread().id(),
                thread::current().id()
            );
            assert!(observer.shared.running.load(Ordering::SeqCst));
            assert!(observer.shared.buffer.lock().unwrap().admission.is_none());
            let shared = observer.shared.clone();
            observer.stop().unwrap();
            assert!(!shared.running.load(Ordering::SeqCst));
            assert!(shared.buffer.lock().unwrap().facts.is_empty());
        }

        #[test]
        #[ignore = "requires an isolated Windows interactive test desktop"]
        fn partial_hook_install_failure_is_returned_and_keyboard_is_dropped() {
            assert!(matches!(
                InputObserver::start_with(true, true),
                Err(InputError::MouseHook(-1))
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> InputScope {
        InputScope {
            hwnd: 42,
            pid: 123,
            focus_hwnd: 43,
            mode: InputMode::NativeChild,
            uia_lease_epoch: None,
            epoch: 1,
        }
    }

    fn target() -> CallbackTarget {
        CallbackTarget {
            hwnd: 42,
            pid: 123,
            focus_hwnd: 43,
            hit_hwnd: Some(43),
        }
    }

    fn push(buffer: &mut FactBuffer, kind: InputKind, now: Instant) {
        buffer.push(
            Some(target()),
            kind,
            Modifiers::default(),
            99,
            now,
            SystemTime::UNIX_EPOCH,
        );
    }

    #[test]
    fn uia_keyboard_requires_explicit_lease_and_exact_native_host() {
        let now = Instant::now();
        for focus_hwnd in [scope().hwnd, scope().focus_hwnd] {
            for lease in [None, Some(0), Some(7)] {
                let scope = InputScope {
                    mode: InputMode::ObservedUia,
                    uia_lease_epoch: lease,
                    focus_hwnd,
                    ..scope()
                };
                let target = CallbackTarget {
                    focus_hwnd,
                    ..target()
                };
                let mut buffer = FactBuffer::default();
                buffer.set_scope(Some(scope), now, 98);
                for kind in [InputKind::Return, InputKind::Shortcut { virtual_key: 0x41 }] {
                    buffer.push(
                        Some(target),
                        kind,
                        Modifiers::default(),
                        99,
                        now,
                        SystemTime::UNIX_EPOCH,
                    );
                }
                let batch = buffer.drain(scope, now);
                assert_eq!(batch.facts.len(), if lease.is_some() { 2 } else { 0 });
                assert_eq!(batch.interrupted, lease.is_none());
            }
        }
        let scope = InputScope {
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(7),
            ..scope()
        };
        for observed in [
            None,
            Some(CallbackTarget {
                hwnd: 45,
                ..target()
            }),
            Some(CallbackTarget {
                pid: 99,
                ..target()
            }),
            Some(CallbackTarget {
                focus_hwnd: 44,
                ..target()
            }),
        ] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope), now, 98);
            push(&mut buffer, InputKind::Return, now);
            buffer.push(
                observed,
                InputKind::Return,
                Modifiers::default(),
                99,
                now,
                SystemTime::UNIX_EPOCH,
            );
            let batch = buffer.drain(scope, now);
            assert!(batch.interrupted && batch.facts.is_empty());
            assert!(buffer.admission.is_none());
        }
    }

    #[test]
    fn uia_drops_mouse_without_reading_target_or_losing_keys_but_injection_interrupts() {
        let now = Instant::now();
        let scope = InputScope {
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(1),
            ..scope()
        };
        for injected in [false, true] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope), now, 98);
            push(&mut buffer, InputKind::Return, now);
            for kind in [
                InputKind::MouseDown {
                    button: MouseButton::Left,
                    x: 0,
                    y: 0,
                },
                InputKind::MouseUp {
                    button: MouseButton::Left,
                    x: 0,
                    y: 0,
                    gesture: MouseGesture::Drag,
                },
            ] {
                push(&mut buffer, kind, now);
            }
            buffer.observe_mouse(0x200, u32::from(injected), (30, 30), 100, now, || {
                panic!("UIA mouse must not inspect a point target")
            });
            let batch = buffer.drain(scope, now);
            assert_eq!(batch.interrupted, injected);
            assert_eq!(batch.facts.len(), usize::from(!injected));
            assert!(
                batch
                    .facts
                    .iter()
                    .all(|fact| fact.kind == InputKind::Return)
            );
            assert!(buffer.mouse_down.is_none());
            assert_eq!(buffer.held_buttons, 0);
        }
    }

    #[test]
    fn lease_revocation_mode_change_epoch_change_and_gap_clear_undrained_facts() {
        let now = Instant::now();
        let scope = InputScope {
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(1),
            ..scope()
        };
        for (next, elapsed) in [
            (None, Duration::ZERO),
            (
                Some(InputScope {
                    uia_lease_epoch: None,
                    ..scope
                }),
                Duration::ZERO,
            ),
            (
                Some(InputScope {
                    uia_lease_epoch: Some(2),
                    ..scope
                }),
                Duration::ZERO,
            ),
            (
                Some(InputScope {
                    epoch: scope.epoch + 1,
                    ..scope
                }),
                Duration::ZERO,
            ),
            (
                Some(InputScope {
                    mode: InputMode::NativeChild,
                    uia_lease_epoch: None,
                    ..scope
                }),
                Duration::ZERO,
            ),
            (Some(scope), ADMISSION_TTL + Duration::from_millis(1)),
        ] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope), now, 98);
            push(&mut buffer, InputKind::Return, now);
            buffer.set_scope(next, now + elapsed, 100);
            let batch = buffer.drain(next.unwrap_or(scope), now + elapsed);
            assert!(batch.interrupted && batch.facts.is_empty());
            if let Some(next) = next.filter(|scope| scope.is_admitted()) {
                buffer.push(
                    Some(target()),
                    InputKind::Return,
                    Modifiers::default(),
                    101,
                    now + elapsed,
                    SystemTime::UNIX_EPOCH,
                );
                assert_eq!(buffer.drain(next, now + elapsed).facts.len(), 1);
            }
        }
    }

    #[test]
    fn uia_renewal_does_not_admit_old_callbacks_or_extend_fact_age() {
        let now = Instant::now();
        let scope = InputScope {
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(1),
            ..scope()
        };
        for stale_native_time in [true, false] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope), now, 98);
            if stale_native_time {
                buffer.push(
                    Some(target()),
                    InputKind::Return,
                    Modifiers::default(),
                    97,
                    now,
                    SystemTime::UNIX_EPOCH,
                );
            } else {
                push(&mut buffer, InputKind::Return, now);
                for ms in (100..=2100).step_by(100) {
                    buffer.set_scope(Some(scope), now + Duration::from_millis(ms), 98 + ms as u32);
                }
            }
            let batch = buffer.drain(
                scope,
                if stale_native_time {
                    now
                } else {
                    now + Duration::from_millis(2100)
                },
            );
            assert!(batch.interrupted && batch.facts.is_empty());
        }
    }

    #[test]
    fn same_host_lease_replacement_clears_both_drained_and_buffered_actions() {
        use crate::input_actions::Actions;
        let now = Instant::now();
        let scope = InputScope {
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(1),
            ..scope()
        };
        let mut buffer = FactBuffer::default();
        let mut actions = Actions::default();
        buffer.set_scope(Some(scope), now, 98);
        push(&mut buffer, InputKind::Return, now);
        actions.ingest(buffer.drain(scope, now), scope, now);
        assert!(actions.pending());
        push(&mut buffer, InputKind::Return, now);
        let next = InputScope {
            uia_lease_epoch: Some(2),
            ..scope
        };
        buffer.set_scope(Some(next), now, 100);
        let batch = buffer.drain(next, now);
        assert!(batch.interrupted && batch.facts.is_empty());
        actions.ingest(batch, next, now);
        assert!(
            !actions
                .persist_next(now, now, |_| panic!("previous field Return survived"))
                .unwrap()
        );
        buffer.push(
            Some(target()),
            InputKind::Return,
            Modifiers::default(),
            101,
            now,
            SystemTime::UNIX_EPOCH,
        );
        actions.ingest(buffer.drain(next, now), next, now);
        assert!(actions.persist_next(now, now, |_| Ok(true)).unwrap());
        assert!(!actions.pending());
    }

    #[test]
    fn native_style_checks_remain_strict_and_never_read_generic_uia_host_style() {
        for style in [None, Some(0), Some(0x20), Some(0x1020)] {
            assert_eq!(
                callback_style_is_admitted(scope(), || style),
                style_is_admitted(style)
            );
        }
        let uia = InputScope {
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(0),
            focus_hwnd: scope().hwnd,
            ..scope()
        };
        assert!(callback_style_is_admitted(uia, || panic!(
            "generic host style read"
        )));
        assert!(!callback_style_is_admitted(
            InputScope {
                uia_lease_epoch: None,
                ..uia
            },
            || panic!("unleased style read")
        ));
        assert!(!callback_style_is_admitted(
            InputScope {
                uia_lease_epoch: Some(0),
                ..scope()
            },
            || panic!("mixed mode style read")
        ));
    }

    #[test]
    fn only_actual_return_and_shortcut_keys_produce_facts() {
        let mut keys = KeyboardState::default();
        for key in [0x41, 0x39, 0x08, 0xE5, 0xE7] {
            assert!(keys.key(key, 0, false, true, false).is_none());
        }
        assert_eq!(
            keys.key(0x0D, 0, false, true, false),
            Some((InputKind::Return, Modifiers::default()))
        );
        keys.key(0xA0, 0, false, true, false);
        assert!(keys.key(0x41, 0, false, true, false).is_none());
        assert!(keys.key(0x0D, 0, false, true, false).unwrap().1.shift);
        keys.key(0xA2, 0, false, true, false);
        let (kind, modifiers) = keys.key(0x43, 0, false, true, false).unwrap();
        assert_eq!(kind, InputKind::Shortcut { virtual_key: 0x43 });
        assert!(modifiers.shift && modifiers.control);
        assert!(keys.key(0x43, 0, false, false, false).is_none());
        assert!(keys.key(0x43, 0, false, true, true).is_none());
    }

    #[test]
    fn altgr_and_injected_modifiers_do_not_invent_shortcuts() {
        let mut keys = KeyboardState::default();
        keys.key(0xA2, 0, false, true, false);
        keys.key(0xA5, 0, true, true, false);
        assert!(keys.key(0x51, 0, false, true, false).is_none());
        keys.key(0xA5, 0, true, false, false);
        keys.key(0xA2, 0, false, false, false);
        keys.key(0xA2, 0, false, true, true);
        assert!(keys.modifiers().is_none());
        assert!(keys.key(0x0D, 0, false, true, false).is_none());
        keys.key(0xA2, 0, false, false, true);
        assert_eq!(keys.modifiers(), Some(Modifiers::default()));
    }

    #[test]
    fn return_distinguishes_submit_shortcut_and_altgr_without_text_inference() {
        for modifier in [0xA2, 0xA4, 0x5B] {
            let mut keys = KeyboardState::default();
            keys.key(0xA0, 0, false, true, false);
            assert_eq!(
                keys.key(0x0D, 0, false, true, false).unwrap().0,
                InputKind::Return
            );
            keys.key(modifier, 0, false, true, false);
            let (kind, modifiers) = keys.key(0x0D, 0, false, true, false).unwrap();
            assert_eq!(kind, InputKind::Shortcut { virtual_key: 0x0D });
            assert!(modifiers.shift);
            assert!(modifiers.control || modifiers.alt || modifiers.meta);
            assert!(keys.key(0x0D, 0, false, false, false).is_none());
            assert!(keys.key(0x0D, 0, false, true, true).is_none());
        }
        for control in [false, true] {
            let mut keys = KeyboardState::default();
            if control {
                keys.key(0xA2, 0, false, true, false);
            }
            keys.key(0xA5, 0, true, true, false);
            assert!(keys.key(0x0D, 0, false, true, false).is_none());
            keys.key(0xA5, 0, true, false, false);
            assert_eq!(
                keys.key(0x0D, 0, false, true, false).unwrap().0,
                if control {
                    InputKind::Shortcut { virtual_key: 0x0D }
                } else {
                    InputKind::Return
                }
            );
        }
    }

    #[test]
    fn native_mouse_classifier_filters_injection_moves_and_unknown_buttons() {
        for (down, up, data, button) in [
            (0x201, 0x202, 0, MouseButton::Left),
            (0x204, 0x205, 0, MouseButton::Right),
            (0x207, 0x208, 0, MouseButton::Middle),
            (0x20B, 0x20C, 1 << 16, MouseButton::X1),
            (0x20B, 0x20C, 2 << 16, MouseButton::X2),
        ] {
            assert_eq!(
                mouse_kind(down, data, 0, -50, 10),
                Some(InputKind::MouseDown {
                    button,
                    x: -50,
                    y: 10
                })
            );
            assert_eq!(
                mouse_kind(up, data, 0, 500, 20),
                Some(InputKind::MouseUp {
                    button,
                    x: 500,
                    y: 20,
                    gesture: MouseGesture::Disqualified,
                })
            );
            for flags in 1..=3 {
                assert!(mouse_kind(down, data, flags, 0, 0).is_none());
                assert!(mouse_kind(up, data, flags, 0, 0).is_none());
            }
        }
        for message in [0x200, 0x203, 0x20A, 0x20E, 0, u32::MAX] {
            assert!(mouse_kind(message, 0, 0, 0, 0).is_none());
        }
        assert!(mouse_kind(0x20B, 3 << 16, 0, 0, 0).is_none());
        assert_eq!(MouseButton::X1.name(), "other");
        assert_eq!(MouseButton::X2.name(), "other");
    }

    #[test]
    fn modifiers_use_the_existing_evidence_contract() {
        let mut keys = KeyboardState::default();
        for key in [0xA0, 0xA2, 0xA4, 0x5B] {
            keys.key(key, 0, false, true, false);
        }
        let (_, modifiers) = keys.key(0x0D, 0, false, true, false).unwrap();
        assert_eq!(
            modifiers.names().collect::<Vec<_>>(),
            vec!["control", "shift", "alt", "meta"]
        );
    }

    #[test]
    fn native_edit_style_rejects_password_and_read_failure() {
        assert!(!style_is_admitted(None));
        for style in [0, 0x5000_0080, -0x8000_0000isize] {
            assert!(style_is_admitted(Some(style)));
            assert!(!style_is_admitted(Some(style | 0x20)));
        }
    }

    #[test]
    fn native_edit_classes_exclude_windowless_hosts_and_unverified_families() {
        for class in ["Edit", "WindowsForms10.EDIT.app.0.141b42a_r8_ad1"] {
            assert_eq!(native_edit_class(class), Some(NativeEditClass::Standard));
        }
        for class in [
            "RichEdit20W",
            "RICHEDIT50W",
            "WindowsForms10.RichEdit20W.app.0.141b42a_r8_ad1",
            "WindowsForms10.RICHEDIT50W.app.0.141b42a_r8_ad1",
        ] {
            assert_eq!(native_edit_class(class), Some(NativeEditClass::Rich));
        }
        for class in [
            "",
            "Button",
            "RichEdit20A",
            "RichEdit20WCustom",
            "WindowsForms10.RichEdit20WCustom.app.0",
            "WindowsForms10.EDITCustom.app.0",
            "Chrome_RenderWidgetHostHWND",
            "HwndWrapper",
            "Windows.UI.Composition.DesktopWindowContentBridge",
        ] {
            assert_eq!(native_edit_class(class), None, "{class}");
        }
    }

    #[test]
    fn native_input_roles_require_the_observed_family_and_provider_type() {
        for (class, admitted_type, expected) in [
            ("Edit", 50004, "AXTextField"),
            (
                "WindowsForms10.EDIT.app.0.141b42a_r8_ad1",
                50004,
                "AXTextField",
            ),
            ("RichEdit20W", 50033, "AXGroup"),
            ("RICHEDIT50W", 50033, "AXGroup"),
            (
                "WindowsForms10.RichEdit20W.app.0.34f5582_r6_ad1",
                50033,
                "AXGroup",
            ),
            (
                "WindowsForms10.RICHEDIT50W.app.0.141b42a_r8_ad1",
                50033,
                "AXGroup",
            ),
        ] {
            for control_type in [0, 50000, 50004, 50020, 50030, 50033] {
                let expected = if control_type == 50030
                    && native_edit_class(class) == Some(NativeEditClass::Rich)
                {
                    Some("AXDocument")
                } else {
                    (control_type == admitted_type).then_some(expected)
                };
                assert_eq!(
                    native_input_role(class, control_type),
                    expected,
                    "{class} / {control_type}",
                );
            }
        }
        for class in [
            "",
            "Pane",
            "Document",
            "Button",
            "RichEdit20A",
            "RichEdit20WCustom",
            "WindowsForms10.RichEdit20WCustom.app.0",
            "WindowsForms10.EDITCustom.app.0",
            "Chrome_RenderWidgetHostHWND",
            "HwndWrapper",
            "Windows.UI.Composition.DesktopWindowContentBridge",
        ] {
            for control_type in [50004, 50030, 50033] {
                assert_eq!(native_input_role(class, control_type), None, "{class}");
            }
        }
    }

    #[test]
    fn injected_release_interrupts_physical_pairing_before_or_after_drain() {
        for flags in 1..=3 {
            for drain_down in [false, true] {
                let now = Instant::now();
                let mut buffer = FactBuffer::default();
                buffer.set_scope(Some(scope()), now, 98);
                let down = mouse_kind(0x201, 0, 0, 10, 20).unwrap();
                let up = mouse_kind(0x202, 0, 0, 10, 20).unwrap();
                push(&mut buffer, down, now);
                if drain_down {
                    let batch = buffer.drain(scope(), now);
                    assert!(!batch.interrupted);
                    assert_eq!(batch.facts.len(), 1);
                    assert_eq!(batch.facts[0].kind, down);
                }
                assert!(buffer.reject_injected_mouse(flags));
                assert!(mouse_kind(0x202, 0, flags, 10, 20).is_none());
                push(&mut buffer, up, now);
                let batch = buffer.drain(scope(), now);
                // This barrier clears the consumer's earlier down before the
                // lone physical up is ingested, so it cannot become a click.
                assert!(batch.interrupted);
                assert_eq!(batch.facts.len(), 1);
                assert_eq!(batch.facts[0].kind, up);
                assert!(!buffer.reject_injected_mouse(0));
                push(&mut buffer, down, now);
                push(&mut buffer, up, now);
                let batch = buffer.drain(scope(), now);
                assert!(!batch.interrupted);
                assert_eq!(batch.facts.len(), 2);
            }
        }
    }

    fn mouse(buffer: &mut FactBuffer, message: u32, flags: u32, x: i32, y: i32, now: Instant) {
        buffer.observe_mouse(message, flags, (x, y), 99, now, || Some(target()));
        if let Some(kind) = mouse_kind(message, 0, flags, x, y) {
            push(buffer, kind, now);
        }
    }

    #[test]
    fn same_control_drag_preserves_keyboard_actions_across_drains() {
        use crate::input_actions::Actions;
        let now = Instant::now();
        for drain_each in [false, true] {
            let mut buffer = FactBuffer::default();
            let mut actions = Actions::default();
            buffer.set_scope(Some(scope()), now, 98);
            push(&mut buffer, InputKind::Return, now);
            mouse(&mut buffer, 0x201, 0, 10, 20, now);
            if drain_each {
                actions.ingest(buffer.drain(scope(), now), scope(), now);
            }
            mouse(&mut buffer, 0x200, 0, 40, 20, now);
            if drain_each {
                actions.ingest(buffer.drain(scope(), now), scope(), now);
            }
            push(&mut buffer, InputKind::Shortcut { virtual_key: 0x43 }, now);
            mouse(&mut buffer, 0x200, 0, 10, 20, now);
            mouse(&mut buffer, 0x202, 0, 11, 20, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            assert_eq!(
                actions
                    .take(now, now)
                    .iter()
                    .map(|action| action.kind)
                    .collect::<Vec<_>>(),
                vec!["keyboard.submit", "keyboard.shortcut", "mouse.drag"],
            );
        }
    }

    #[test]
    fn overlapping_and_mismatched_presses_stay_disqualified_until_all_buttons_are_up() {
        use crate::input_actions::Actions;
        let now = Instant::now();
        for messages in [
            &[0x201, 0x204, 0x205, 0x202][..],
            &[0x201, 0x204, 0x202, 0x205][..],
            &[0x201, 0x201, 0x202][..],
            &[0x201, 0x205, 0x204, 0x205, 0x202][..],
            &[0x201, 0x204, 0x205, 0x204, 0x205, 0x202][..],
            &[0x201, 0x204, 0x207, 0x205, 0x202, 0x208][..],
        ] {
            for drain_each in [false, true] {
                for excursion in [false, true] {
                    let mut buffer = FactBuffer::default();
                    let mut actions = Actions::default();
                    buffer.set_scope(Some(scope()), now, 98);
                    push(&mut buffer, InputKind::Return, now);
                    for &message in messages {
                        mouse(&mut buffer, message, 0, 10, 20, now);
                        if excursion {
                            mouse(&mut buffer, 0x200, 0, 40, 20, now);
                            mouse(&mut buffer, 0x200, 0, 10, 20, now);
                        }
                        if drain_each {
                            actions.ingest(buffer.drain(scope(), now), scope(), now);
                        }
                    }
                    actions.ingest(buffer.drain(scope(), now), scope(), now);
                    assert_eq!(
                        actions
                            .take(now, now)
                            .iter()
                            .map(|action| action.kind)
                            .collect::<Vec<_>>(),
                        vec!["keyboard.submit"],
                        "{messages:?}, drain_each={drain_each}, excursion={excursion}",
                    );
                    mouse(&mut buffer, 0x201, 0, 10, 20, now);
                    if excursion {
                        mouse(&mut buffer, 0x200, 0, 40, 20, now);
                    }
                    mouse(&mut buffer, 0x202, 0, 10, 20, now);
                    actions.ingest(buffer.drain(scope(), now), scope(), now);
                    let result = actions.take(now, now);
                    assert_eq!(result.len(), 1);
                    assert_eq!(
                        result[0].kind,
                        if excursion {
                            "mouse.drag"
                        } else {
                            "mouse.click"
                        }
                    );
                }
            }
        }
    }

    #[test]
    fn mouse_gestures_use_observed_excursion_and_recover_after_disqualified_pairs() {
        use crate::input_actions::Actions;
        let now = Instant::now();
        for (down, up, end, expected) in [
            (0x201, 0x202, (11, 20), "mouse.click"),
            (0x204, 0x205, (11, 20), "mouse.contextMenu"),
            (0x201, 0x202, (40, 20), "mouse.drag"),
            (0x204, 0x205, (40, 20), "mouse.drag"),
        ] {
            let mut buffer = FactBuffer::default();
            let mut actions = Actions::default();
            buffer.set_scope(Some(scope()), now, 98);
            // Missing down and mismatched buttons must not invent actions.
            mouse(&mut buffer, up, 0, 10, 20, now);
            mouse(&mut buffer, 0x201, 0, 10, 20, now);
            mouse(&mut buffer, 0x205, 0, 10, 20, now);
            mouse(&mut buffer, 0x202, 0, 10, 20, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            assert!(actions.take(now, now).is_empty());
            mouse(&mut buffer, down, 0, 10, 20, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            mouse(&mut buffer, up, 0, end.0, end.1, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            let result = actions.take(now, now);
            assert_eq!(result.len(), 1);
            assert_eq!(result[0].kind, expected);
        }
    }

    #[test]
    fn unknown_modifiers_cancel_pairing_but_still_account_for_releases() {
        use crate::input_actions::Actions;
        for drain_each in [false, true] {
            let now = Instant::now();
            let mut buffer = FactBuffer::default();
            let mut actions = Actions::default();
            buffer.set_scope(Some(scope()), now, 98);
            for (message, known) in [(0x201, true), (0x202, false), (0x201, false), (0x202, true)] {
                buffer.push(
                    Some(target()),
                    mouse_kind(message, 0, 0, 10, 20).unwrap(),
                    known.then_some(Modifiers::default()),
                    99,
                    now,
                    SystemTime::UNIX_EPOCH,
                );
                if drain_each {
                    actions.ingest(buffer.drain(scope(), now), scope(), now);
                }
            }
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            assert!(actions.take(now, now).is_empty());
            assert_eq!(buffer.held_buttons, 0);
            mouse(&mut buffer, 0x201, 0, 10, 20, now);
            mouse(&mut buffer, 0x202, 0, 10, 20, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            let result = actions.take(now, now);
            assert_eq!(result.len(), 1);
            assert_eq!(result[0].kind, "mouse.click");
        }
    }

    #[test]
    fn interrupted_chords_remain_held_across_admission_and_disarmed_releases() {
        use crate::input_actions::Actions;
        for reason in ["injection", "revoke", "epoch", "gap", "loss", "overflow"] {
            for release_disarmed in [false, true] {
                let now = Instant::now();
                let mut buffer = FactBuffer::default();
                let mut actions = Actions::default();
                let mut current = scope();
                let mut later = now;
                buffer.set_scope(Some(current), now, 98);
                mouse(&mut buffer, 0x201, 0, 10, 20, now);
                actions.ingest(buffer.drain(current, now), current, now);
                match reason {
                    "injection" => mouse(&mut buffer, 0x200, 1, 10, 20, now),
                    "revoke" => buffer.set_scope(None, now, 98),
                    "epoch" => {
                        current.epoch += 1;
                        buffer.set_scope(Some(current), now, 98);
                    }
                    "gap" => {
                        later += ADMISSION_TTL + Duration::from_millis(1);
                        buffer.set_scope(Some(current), later, 98);
                    }
                    "overflow" => {
                        for _ in 0..=MAX_FACTS {
                            push(&mut buffer, InputKind::Return, now);
                        }
                    }
                    _ => buffer.interrupt(),
                }
                buffer.set_scope(Some(current), later, 98);
                mouse(&mut buffer, 0x204, 0, 10, 20, later);
                mouse(&mut buffer, 0x205, 0, 10, 20, later);
                actions.ingest(buffer.drain(current, later), current, later);
                assert!(actions.take(later, later).is_empty(), "{reason}");
                assert_eq!(buffer.held_buttons, MouseButton::Left.mask());
                if release_disarmed {
                    buffer.set_scope(None, later, 98);
                }
                mouse(&mut buffer, 0x202, 0, 10, 20, later);
                assert_eq!(buffer.held_buttons, 0, "{reason}");
                buffer.set_scope(Some(current), later, 98);
                actions.ingest(buffer.drain(current, later), current, later);
                assert!(actions.take(later, later).is_empty());
                mouse(&mut buffer, 0x201, 0, 10, 20, later);
                mouse(&mut buffer, 0x202, 0, 10, 20, later);
                actions.ingest(buffer.drain(current, later), current, later);
                let result = actions.take(later, later);
                assert_eq!(result.len(), 1, "{reason}");
                assert_eq!(result[0].kind, "mouse.click");
            }
        }
    }

    #[test]
    fn drag_interruption_discards_keyboard_and_press_across_drains_then_recovers() {
        use crate::input_actions::Actions;
        let now = Instant::now();
        for reason in [
            "injected move",
            "injected up",
            "missing target",
            "foreign hit",
            "focus",
            "pid",
            "revoke",
            "epoch",
            "gap",
            "loss",
            "overflow",
        ] {
            let mut buffer = FactBuffer::default();
            let mut actions = Actions::default();
            buffer.set_scope(Some(scope()), now, 98);
            push(&mut buffer, InputKind::Return, now);
            mouse(&mut buffer, 0x201, 0, 10, 20, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            mouse(&mut buffer, 0x200, 0, 40, 20, now);
            let mut current = scope();
            let mut later = now;
            match reason {
                "injected move" => mouse(&mut buffer, 0x200, 1, 10, 20, now),
                "injected up" => mouse(&mut buffer, 0x202, 2, 10, 20, now),
                "missing target" | "foreign hit" | "focus" | "pid" => {
                    let observed = match reason {
                        "missing target" => None,
                        "foreign hit" => Some(CallbackTarget {
                            hit_hwnd: Some(999),
                            ..target()
                        }),
                        "focus" => Some(CallbackTarget {
                            focus_hwnd: 999,
                            ..target()
                        }),
                        _ => Some(CallbackTarget {
                            pid: 999,
                            ..target()
                        }),
                    };
                    buffer.observe_mouse(0x200, 0, (40, 20), 99, now, || observed);
                }
                "revoke" => buffer.set_scope(None, now, 99),
                "epoch" => {
                    current.epoch += 1;
                    buffer.set_scope(Some(current), now, 98);
                }
                "gap" => {
                    later += ADMISSION_TTL + Duration::from_millis(1);
                    buffer.set_scope(Some(current), later, 98);
                }
                "overflow" => {
                    for _ in 0..=MAX_FACTS {
                        push(&mut buffer, InputKind::Return, now);
                    }
                }
                _ => buffer.interrupt(),
            }
            let batch = buffer.drain(current, later);
            assert!(batch.interrupted, "{reason}");
            actions.ingest(batch, current, later);
            buffer.set_scope(Some(current), later, 98);
            mouse(&mut buffer, 0x202, 0, 10, 20, later);
            actions.ingest(buffer.drain(current, later), current, later);
            assert!(actions.take(later, later).is_empty(), "{reason}");
            mouse(&mut buffer, 0x201, 0, 10, 20, later);
            mouse(&mut buffer, 0x202, 0, 10, 20, later);
            actions.ingest(buffer.drain(current, later), current, later);
            let result = actions.take(later, later);
            assert_eq!(result.len(), 1, "{reason}");
            assert_eq!(result[0].kind, "mouse.click", "{reason}");
        }
    }

    #[test]
    fn drag_press_duration_is_bounded_without_discarding_independent_keys() {
        use crate::input_actions::Actions;
        let now = Instant::now();
        for (native_age, receipt_age, expected_drag) in
            [(2000, 2000, true), (2001, 2000, false), (2000, 2001, false)]
        {
            let mut buffer = FactBuffer::default();
            let mut actions = Actions::default();
            buffer.set_scope(Some(scope()), now, 98);
            mouse(&mut buffer, 0x201, 0, 10, 20, now);
            actions.ingest(buffer.drain(scope(), now), scope(), now);
            // Continuous admission is independent of the held press's time bound.
            for ms in (200..=2000).step_by(200) {
                buffer.set_scope(
                    Some(scope()),
                    now + Duration::from_millis(ms),
                    99 + ms as u32,
                );
            }
            let later = now + Duration::from_millis(receipt_age);
            let native_time = 99 + native_age;
            buffer.push(
                Some(target()),
                InputKind::Return,
                Modifiers::default(),
                native_time,
                later,
                SystemTime::UNIX_EPOCH,
            );
            buffer.observe_mouse(0x200, 0, (40, 20), native_time, later, || Some(target()));
            buffer.observe_mouse(0x200, 0, (10, 20), native_time, later, || Some(target()));
            buffer.push(
                Some(target()),
                mouse_kind(0x202, 0, 0, 10, 20).unwrap(),
                Modifiers::default(),
                native_time,
                later,
                SystemTime::UNIX_EPOCH,
            );
            let batch = buffer.drain(scope(), later);
            assert!(!batch.interrupted);
            actions.ingest(batch, scope(), later);
            let result = actions.take(later, later);
            assert_eq!(
                result.iter().map(|action| action.kind).collect::<Vec<_>>(),
                if expected_drag {
                    vec!["keyboard.submit", "mouse.drag"]
                } else {
                    vec!["keyboard.submit"]
                },
            );
        }
    }

    #[test]
    fn mouse_excursion_survives_drains_without_persisting_movements() {
        let now = Instant::now();
        for drain_down in [false, true] {
            for drain_movement in [false, true] {
                for (x, y) in [(17, 20), (15, 25), (i32::MIN, i32::MAX)] {
                    let mut buffer = FactBuffer::default();
                    buffer.set_scope(Some(scope()), now, 98);
                    mouse(&mut buffer, 0x201, 0, 10, 20, now);
                    if drain_down {
                        let batch = buffer.drain(scope(), now);
                        assert!(!batch.interrupted);
                        assert_eq!(batch.facts.len(), 1);
                    }
                    mouse(&mut buffer, 0x200, 0, x, y, now);
                    if drain_movement {
                        let batch = buffer.drain(scope(), now);
                        assert!(!batch.interrupted);
                        assert_eq!(batch.facts.len(), usize::from(!drain_down));
                    }
                    mouse(&mut buffer, 0x200, 0, 10, 20, now);
                    mouse(&mut buffer, 0x202, 0, 11, 20, now);
                    let batch = buffer.drain(scope(), now);
                    assert!(!batch.interrupted);
                    assert_eq!(
                        batch.facts.len(),
                        1 + usize::from(!drain_down && !drain_movement),
                        "movement must never become a fact",
                    );
                    assert!(matches!(
                        batch.facts.last().unwrap().kind,
                        InputKind::MouseUp {
                            gesture: MouseGesture::Drag,
                            ..
                        }
                    ));
                }
            }
        }
    }

    #[test]
    fn injected_moves_and_releases_interrupt_pending_clicks_without_facts() {
        let now = Instant::now();
        for message in [0x200, 0x202] {
            for flags in 1..=3 {
                let mut buffer = FactBuffer::default();
                buffer.set_scope(Some(scope()), now, 98);
                mouse(&mut buffer, 0x201, 0, 10, 20, now);
                buffer.drain(scope(), now);
                // Even an injected move at the same point cancels provenance.
                mouse(&mut buffer, message, flags, 10, 20, now);
                let batch = buffer.drain(scope(), now);
                assert!(batch.interrupted);
                assert!(batch.facts.is_empty());
                mouse(&mut buffer, 0x200, 0, 100, 200, now);
                mouse(&mut buffer, 0x202, 0, 10, 20, now);
                let batch = buffer.drain(scope(), now);
                assert!(!batch.interrupted, "the cancelled press must be gone");
                assert_eq!(batch.facts.len(), 1);
                assert!(matches!(batch.facts[0].kind, InputKind::MouseUp { .. }));
            }
        }
    }

    #[test]
    fn stationary_mouse_press_survives_moves_drains_and_scope_renewal() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, 98);
        mouse(&mut buffer, 0x201, 0, 10, 20, now);
        assert_eq!(buffer.drain(scope(), now).facts.len(), 1);
        buffer.set_scope(Some(scope()), now, 99);
        for (x, y) in [(10, 20), (16, 20), (14, 24), (10, 20)] {
            mouse(&mut buffer, 0x200, 0, x, y, now);
            let batch = buffer.drain(scope(), now);
            assert!(!batch.interrupted);
            assert!(batch.facts.is_empty());
        }
        mouse(&mut buffer, 0x202, 0, 11, 20, now);
        let batch = buffer.drain(scope(), now);
        assert!(!batch.interrupted);
        assert_eq!(batch.facts.len(), 1);
        assert!(matches!(
            batch.facts[0].kind,
            InputKind::MouseUp {
                gesture: MouseGesture::Click,
                ..
            }
        ));
        mouse(&mut buffer, 0x200, 0, 100, 200, now);
        assert!(!buffer.drain(scope(), now).interrupted);
    }

    #[test]
    fn interrupted_mouse_press_cannot_disqualify_a_later_independent_click() {
        let now = Instant::now();
        for interruption in ["injection", "revoke", "gap", "overflow", "epoch", "loss"] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope()), now, 98);
            mouse(&mut buffer, 0x201, 0, 10, 20, now);
            buffer.drain(scope(), now);
            let mut current = scope();
            let mut later = now;
            match interruption {
                "injection" => mouse(&mut buffer, 0x202, 1, 10, 20, now),
                "revoke" => buffer.set_scope(None, now, 99),
                "gap" => {
                    later += ADMISSION_TTL + Duration::from_millis(1);
                    buffer.set_scope(Some(current), later, 98);
                }
                "overflow" => {
                    for _ in 0..=MAX_FACTS {
                        push(&mut buffer, InputKind::Return, now);
                    }
                }
                "epoch" => {
                    current.epoch += 1;
                    buffer.set_scope(Some(current), now, 98);
                }
                _ => buffer.interrupt(),
            }
            assert!(buffer.drain(current, later).interrupted, "{interruption}");
            buffer.set_scope(Some(current), later, 98);
            mouse(&mut buffer, 0x200, 0, 100, 200, later);
            let batch = buffer.drain(current, later);
            assert!(!batch.interrupted, "{interruption}: old press survived");
            assert!(batch.facts.is_empty());
            // Cancelling attribution does not release the physical left button.
            mouse(&mut buffer, 0x202, 0, 100, 200, later);
            buffer.drain(current, later);
            mouse(&mut buffer, 0x201, 0, 100, 200, later);
            mouse(&mut buffer, 0x200, 0, 100, 200, later);
            mouse(&mut buffer, 0x202, 0, 100, 200, later);
            let batch = buffer.drain(current, later);
            assert!(!batch.interrupted, "{interruption}");
            assert_eq!(batch.facts.len(), 2, "{interruption}");
            assert!(matches!(
                batch.facts[1].kind,
                InputKind::MouseUp {
                    gesture: MouseGesture::Click,
                    ..
                }
            ));
        }
    }

    #[test]
    fn disarmed_revoked_and_changed_epochs_retain_nothing_old() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        push(&mut buffer, InputKind::Return, now);
        assert!(buffer.drain(scope(), now).facts.is_empty());
        buffer.set_scope(Some(scope()), now, 98);
        push(&mut buffer, InputKind::Return, now);
        buffer.set_scope(None, now, 99);
        push(&mut buffer, InputKind::Return, now);
        let batch = buffer.drain(scope(), now);
        assert!(batch.interrupted && batch.facts.is_empty());
        buffer.set_scope(Some(scope()), now, 98);
        push(&mut buffer, InputKind::Return, now);
        let next = InputScope {
            epoch: 2,
            ..scope()
        };
        buffer.set_scope(Some(next), now, 99);
        let batch = buffer.drain(next, now);
        assert!(batch.interrupted && batch.facts.is_empty());
    }

    #[test]
    fn source_metadata_replacement_requires_revoking_buffer_not_only_actions() {
        use crate::{
            input_actions::{Actions, same_input_source},
            model::{InputTarget, tests::snapshot},
        };

        for changed in ["title", "aumid", "missing_aumid", "new_aumid"] {
            for revoke_observer in [false, true] {
                let now = Instant::now();
                let current = scope();
                let mut original = snapshot();
                original.pid = current.pid;
                original.window_id = current.hwnd as u64;
                original.input_target = Some(InputTarget {
                    hwnd: current.focus_hwnd as u64,
                    role: "AXTextField".into(),
                    uia: None,
                });
                original.application_user_model_id = Some("Synthetic.Original".into());
                let mut replacement = original.clone();
                match changed {
                    "title" => replacement.title = "Another synthetic document".into(),
                    "aumid" => {
                        replacement.application_user_model_id = Some("Synthetic.Replacement".into())
                    }
                    "missing_aumid" => replacement.application_user_model_id = None,
                    "new_aumid" => original.application_user_model_id = None,
                    _ => unreachable!(),
                }
                assert!(!same_input_source(&original, &replacement), "{changed}");
                assert_eq!(original.input_target, replacement.input_target);

                let mut buffer = FactBuffer::default();
                let mut actions = Actions::default();
                buffer.set_scope(Some(current), now, 98);
                push(&mut buffer, InputKind::Return, now);
                actions.ingest(buffer.drain(current, now), current, now);
                assert!(actions.pending());
                // The hook receives this Return after the recorder's drain,
                // but before replacement metadata is installed on the same scope.
                push(&mut buffer, InputKind::Return, now);
                actions.clear();
                if revoke_observer {
                    buffer.set_scope(None, now, 100);
                }
                buffer.set_scope(Some(current), now, 101);
                actions.ingest(buffer.drain(current, now), current, now);
                let mut old_writes = 0;
                while actions
                    .persist_next(now, now, |action| {
                        assert_eq!(action.kind, "keyboard.submit");
                        old_writes += 1;
                        Ok(true)
                    })
                    .unwrap()
                {}
                assert_eq!(
                    old_writes,
                    usize::from(!revoke_observer),
                    "{changed}: clearing Actions alone leaves the undrained Return eligible"
                );
                assert!(!actions.pending());

                // Revocation discards old facts, not future admitted input.
                let fresh = now + Duration::from_millis(10);
                buffer.push(
                    Some(target()),
                    InputKind::Return,
                    Modifiers::default(),
                    102,
                    fresh,
                    SystemTime::UNIX_EPOCH,
                );
                actions.ingest(buffer.drain(current, fresh), current, fresh);
                assert!(
                    actions
                        .persist_next(fresh, fresh, |action| {
                            assert_eq!(action.kind, "keyboard.submit");
                            Ok(true)
                        })
                        .unwrap(),
                    "{changed}: fresh Return must remain usable"
                );
                assert!(
                    !actions
                        .persist_next(fresh, fresh, |_| panic!("duplicate Return"))
                        .unwrap()
                );
            }
        }
    }

    #[test]
    fn expired_admission_foreground_change_and_overflow_disarm() {
        for mode in 0..3 {
            let now = Instant::now();
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope()), now, 98);
            push(&mut buffer, InputKind::Return, now);
            match mode {
                0 => push(
                    &mut buffer,
                    InputKind::Return,
                    now + ADMISSION_TTL + Duration::from_millis(1),
                ),
                1 => buffer.push(
                    Some(CallbackTarget {
                        pid: 999,
                        ..target()
                    }),
                    InputKind::Return,
                    Modifiers::default(),
                    100,
                    now,
                    SystemTime::UNIX_EPOCH,
                ),
                _ => {
                    for _ in 0..MAX_FACTS {
                        push(&mut buffer, InputKind::Return, now);
                    }
                }
            }
            assert!(buffer.admission.is_none());
            let batch = buffer.drain(scope(), now);
            assert!(batch.interrupted && batch.facts.is_empty());
        }
    }

    #[test]
    fn old_facts_expire_even_when_admission_is_renewed() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, 98);
        push(&mut buffer, InputKind::Return, now);
        for tick in 1..=21 {
            buffer.set_scope(
                Some(scope()),
                now + Duration::from_millis(tick * 100),
                99 + tick as u32 * 100,
            );
        }
        let batch = buffer.drain(scope(), now + Duration::from_millis(2100));
        assert!(batch.interrupted && batch.facts.is_empty());
    }

    #[test]
    fn delayed_events_cannot_cross_revocation_even_with_the_same_scope() {
        let now = Instant::now();
        for delayed_time in [99, 100] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope()), now, 98);
            buffer.set_scope(None, now, 99);
            buffer.set_scope(Some(scope()), now, 100);
            buffer.push(
                Some(target()),
                InputKind::Return,
                Modifiers::default(),
                delayed_time,
                now,
                SystemTime::UNIX_EPOCH,
            );
            assert!(buffer.admission.is_none());
            let batch = buffer.drain(scope(), now);
            assert!(batch.interrupted && batch.facts.is_empty());
        }
    }

    #[test]
    fn native_time_wrap_and_renewal_preserve_new_events() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, u32::MAX - 5);
        buffer.set_scope(Some(scope()), now + Duration::from_millis(10), 4);
        buffer.push(
            Some(target()),
            InputKind::Return,
            Modifiers::default(),
            3,
            now + Duration::from_millis(10),
            SystemTime::UNIX_EPOCH,
        );
        let batch = buffer.drain(scope(), now + Duration::from_millis(10));
        assert!(!batch.interrupted);
        assert_eq!(batch.facts.len(), 1);
        assert_eq!(batch.facts[0].os_time_ms, 3);
    }

    #[test]
    fn fast_loop_can_drain_input_through_a_multisecond_snapshot() {
        let start = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), start, 100);
        let mut count = 0;
        for tick in 1..=70 {
            let elapsed = tick * 50;
            let now = start + Duration::from_millis(elapsed);
            buffer.set_scope(Some(scope()), now, 100 + elapsed as u32);
            buffer.push(
                Some(target()),
                InputKind::Return,
                Modifiers::default(),
                101 + elapsed as u32,
                now + Duration::from_millis(1),
                SystemTime::UNIX_EPOCH,
            );
            let batch = buffer.drain(scope(), now + Duration::from_millis(2));
            assert!(!batch.interrupted);
            assert_eq!(batch.facts.len(), 1);
            assert_eq!(batch.facts[0].scope, scope());
            count += batch.facts.len();
        }
        assert_eq!(count, 70);
    }

    #[test]
    fn draining_with_a_foreign_scope_clears_all_facts() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, 98);
        push(&mut buffer, InputKind::Return, now);
        let foreign = InputScope {
            hwnd: 101,
            ..scope()
        };
        let batch = buffer.drain(foreign, now);
        assert!(batch.interrupted && batch.facts.is_empty());
        assert!(buffer.drain(scope(), now).facts.is_empty());
    }

    #[test]
    fn missing_or_root_focus_cannot_admit_a_source() {
        let now = Instant::now();
        for focus_hwnd in [0, scope().hwnd] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(
                Some(InputScope {
                    focus_hwnd,
                    ..scope()
                }),
                now,
                98,
            );
            push(&mut buffer, InputKind::Return, now);
            assert!(buffer.admission.is_none());
            assert!(buffer.drain(scope(), now).facts.is_empty());
        }
    }

    #[test]
    fn callback_focus_and_mouse_hit_must_match_the_exact_admitted_child() {
        let now = Instant::now();
        let down = InputKind::MouseDown {
            button: MouseButton::Left,
            x: 1,
            y: 2,
        };
        let up = InputKind::MouseUp {
            button: MouseButton::Left,
            x: 1,
            y: 2,
            gesture: MouseGesture::Disqualified,
        };
        for (observed, kind) in [
            (None, InputKind::Return),
            (
                Some(CallbackTarget {
                    focus_hwnd: 0,
                    ..target()
                }),
                InputKind::Return,
            ),
            (
                Some(CallbackTarget {
                    focus_hwnd: 44,
                    ..target()
                }),
                InputKind::Return,
            ),
            (
                Some(CallbackTarget {
                    hit_hwnd: None,
                    ..target()
                }),
                up,
            ),
            (
                Some(CallbackTarget {
                    hit_hwnd: Some(42),
                    ..target()
                }),
                up,
            ),
            (
                Some(CallbackTarget {
                    hit_hwnd: Some(44),
                    ..target()
                }),
                up,
            ),
        ] {
            let mut buffer = FactBuffer::default();
            buffer.set_scope(Some(scope()), now, 98);
            push(&mut buffer, down, now);
            buffer.push(
                observed,
                kind,
                Modifiers::default(),
                100,
                now,
                SystemTime::UNIX_EPOCH,
            );
            assert!(buffer.admission.is_none());
            let batch = buffer.drain(scope(), now);
            assert!(batch.interrupted && batch.facts.is_empty());
        }
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, 98);
        buffer.push(
            Some(CallbackTarget {
                hit_hwnd: None,
                ..target()
            }),
            InputKind::Return,
            Modifiers::default(),
            99,
            now,
            SystemTime::UNIX_EPOCH,
        );
        let batch = buffer.drain(scope(), now);
        assert!(!batch.interrupted);
        assert_eq!(batch.facts.len(), 1);
    }

    #[test]
    fn changing_native_child_clears_facts_even_without_an_epoch_change() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, 98);
        push(&mut buffer, InputKind::Return, now);
        let next = InputScope {
            focus_hwnd: 44,
            ..scope()
        };
        buffer.set_scope(Some(next), now, 100);
        let batch = buffer.drain(next, now);
        assert!(batch.interrupted && batch.facts.is_empty());
    }

    #[test]
    fn mouse_facts_keep_order_identity_time_and_never_synthesize_clicks() {
        let now = Instant::now();
        let mut buffer = FactBuffer::default();
        buffer.set_scope(Some(scope()), now, 98);
        let up = InputKind::MouseUp {
            button: MouseButton::Left,
            x: 50,
            y: -10,
            gesture: MouseGesture::Disqualified,
        };
        push(&mut buffer, up, now);
        let batch = buffer.drain(scope(), now);
        assert!(!batch.interrupted);
        assert_eq!(batch.facts.len(), 1);
        assert_eq!(batch.facts[0].kind, up);
        assert_eq!(batch.facts[0].scope, scope());
        assert_eq!(batch.facts[0].os_time_ms, 99);
        assert_eq!(batch.facts[0].observed_at, now);
        assert_eq!(batch.facts[0].received_at, SystemTime::UNIX_EPOCH);
        let down = InputKind::MouseDown {
            button: MouseButton::Right,
            x: 1,
            y: 2,
        };
        push(&mut buffer, down, now);
        push(&mut buffer, up, now);
        assert_eq!(
            buffer
                .drain(scope(), now)
                .facts
                .iter()
                .map(|f| f.kind)
                .collect::<Vec<_>>(),
            vec![down, up]
        );
        assert!(buffer.drain(scope(), now).facts.is_empty());
    }
}
