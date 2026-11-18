//! Raw hardware key transitions for focused custom views: `on_key_down` /
//! `on_key_up`, and the capture rules mounted on them
//! (`capture_keys`, `ViewProps::key_capture`).
//!
//! AppKit sends a key to the window's first responder: a field's editor, a
//! hosted view, or one of NSH's views (the root, or a focusable view Tab,
//! `focus()` or a press moved the focus to). This module turns the events
//! of that focused NSH view into the core's [`KeyEvent`] and reports each
//! transition once, at the focused view: the engine bubbles both kinds to
//! its listening ancestors. Nothing waits for JS.
//!
//! One local monitor per surface sees keys before AppKit dispatches them,
//! so the order is:
//!
//! 1. the app's keymap ([`crate::keymap::pressed`]), which keeps its
//!    precedence and consumes a binding;
//! 2. the raw `KeyDown` ([`key_down`]) with the capture rules of the
//!    focused view and its enabled ancestors ([`captures`]); a captured
//!    key is consumed here, before any native action;
//! 3. the application menu's key equivalents and the responder's defaults
//!    (Tab, Return and Space, scrolling, going back), which a captured key
//!    never reaches.
//!
//! A key that is only listened to is not captured: the app hears it and
//! the default still runs. The dev host's Cmd+R is never captured (as the
//! keymap leaves it to the reload monitor).
//!
//! A view that hears none of the raw keys and captures none builds no
//! [`KeyEvent`] and takes the existing path. Fields, hosted views, menus
//! and OS-reserved shortcuts keep their own keys.
//!
//! Interest and capture follow the logical keyboard ancestry, not the
//! native view tree: an `Overlay` is moved under a root view's host
//! natively while its logical parent stays the view that contains it, and
//! the core marks the moved view's logical parent in
//! [`nsh_core::ViewProps::key_parent`] (an internal routing field, not an
//! app-settable prop). [`key_ancestor`] resolves that id through the
//! surface's mounted views, so a rule on the logical ancestor applies to
//! the focused view inside the portal and a sibling portal's rules do not.
//! Focus, hit testing, layout and Tab keep the native parent.
//!
//! Direct responder calls (`-[NSView keyDown:]` outside
//! `-[NSApplication sendEvent:]`, as a synthetic event from `synth`) go
//! through the same entry points from [`NshView`]'s overrides; the event
//! is remembered ([`Mark`]) so the monitor's notification is not repeated.
//!
//! Modifier keys change flags, not key values: `flagsChanged` gives the
//! virtual key code of the modifier and the flags after the transition.
//! Each is reported as a named `KeyDown`/`KeyUp` (`Shift`, `Control`,
//! `Alt`, `Meta`, `CapsLock`, `Fn`); [`KeyboardState::modifiers`] keeps
//! the physical keys held, so releasing one Shift while the other is held
//! reports the release, and nothing is reported twice. Caps Lock toggles
//! instead of holding, so its direction is whether the event changed its
//! flag. Losing the app's focus clears what was held, and no release is
//! made up.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
};

use block2::RcBlock;
use nsh_core::{
    EventKind, EventPayload, KeyEvent, ROOT_ID, element::SharedString, platform::InputModality,
};
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSView};
use objc2_foundation::NSString;
use rustc_hash::FxHashSet;

use crate::{surface::Surface, view::NshView};

/// A surface's raw keyboard state.
#[derive(Default)]
pub(crate) struct KeyboardState {
    /// The local monitor of this surface, while it runs.
    monitor: RefCell<Option<Retained<AnyObject>>>,
    /// The modifier keys held, by virtual key code: the next `flagsChanged`
    /// of a code in here is its release. Only modifiers, whose transitions
    /// AppKit reports this way.
    modifiers: RefCell<FxHashSet<u16>>,
    /// The event last reported, so the monitor and a responder's own
    /// `keyDown:` do not report it twice.
    last: Cell<Option<Mark>>,
    /// Whether Caps Lock was on at the last of its `flagsChanged` events:
    /// its key toggles (pressing it again turns it off) where the other
    /// modifier keys hold, so its direction comes from the flag.
    caps: Cell<bool>,
}

impl Drop for KeyboardState {
    fn drop(&mut self) {
        if let Some(monitor) = self.monitor.borrow_mut().take() {
            // SAFETY: a monitor `addLocalMonitorForEventsMatchingMask`
            // returned.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    }
}

/// Which event a [`KeyEvent`] was made of: its object, type, virtual key
/// code and time. AppKit passes the same `NSEvent` object to the monitor
/// and then down the responder chain; this recognizes that second arrival.
/// Only properties every key event has are read: `eventNumber` is the
/// mouse and tracking events' and raises for a key event.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Mark {
    event: usize,
    kind: NSEventType,
    code: u16,
    time: f64,
}

impl Mark {
    fn of(event: &NSEvent) -> Self {
        Mark {
            event: event as *const NSEvent as usize,
            kind: event.r#type(),
            code: event.keyCode(),
            time: event.timestamp(),
        }
    }
}

/// Starts the surface's key monitor. It is kept until the surface drops.
pub(crate) fn install(surface: &Rc<Surface>) {
    let key = surface.key();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event.
        let borrowed = unsafe { event.as_ref() };
        match Surface::with_key(key) {
            Some(surface) if press(&surface, borrowed) => std::ptr::null_mut(),
            _ => event.as_ptr(),
        }
    });
    let mask = NSEventMask::KeyDown | NSEventMask::KeyUp | NSEventMask::FlagsChanged;
    // SAFETY: the block returns the event it got, or null (consumed); the
    // monitor is removed with the surface.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    *surface.keyboard.monitor.borrow_mut() = monitor;
    surface
        .keyboard
        .caps
        .set(NSEvent::modifierFlags_class().contains(NSEventModifierFlags::CapsLock));
}

/// The monitor's decision: whether `event` is consumed.
fn press(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    match event.r#type() {
        NSEventType::KeyDown => {
            // The app's shortcuts keep their precedence: a binding that
            // fires consumes the key before any view or menu sees it.
            if crate::keymap::pressed(surface, event) {
                return true;
            }
            // The dev host's reload keeps the key it has always had, as
            // the keymap leaves it to the reload monitor.
            if cfg!(feature = "dev") && crate::keymap::reloads(event) {
                return false;
            }
            key_down(surface, event)
        }
        NSEventType::KeyUp => key_up(surface, event),
        NSEventType::FlagsChanged => {
            flags_changed(surface, event);
            false
        }
        _ => false,
    }
}

/// A key went down on the focused view: reports its `KeyDown` and returns
/// whether the mounted capture rules consumed it (then no default, menu or
/// text follows). Called by the monitor and by `NshView::keyDown:`.
pub(crate) fn key_down(surface: &Surface, event: &NSEvent) -> bool {
    reconcile(surface, event.modifierFlags(), None);
    let Some(view) = focused(surface, event) else {
        return false;
    };
    if !listens(surface, &view) || seen(surface, event) {
        return false;
    }
    // Before the key acts: the focus it moves shows (`focus-visible:`).
    surface.control(|c| c.set_input_modality(InputModality::Keyboard));
    let mut key = key_event(event, Phase::Down);
    let captured = captures(surface, &view, event);
    key.default_prevented = captured;
    remember(surface, event);
    notify(surface, &view, EventKind::KeyDown, key);
    captured
}

/// A key came up: reports its `KeyUp` to the focused view, with the
/// capture decision of this transition. Returns whether it was captured
/// (nothing follows a release either way).
pub(crate) fn key_up(surface: &Surface, event: &NSEvent) -> bool {
    reconcile(surface, event.modifierFlags(), None);
    let Some(view) = focused(surface, event) else {
        return false;
    };
    if !listens(surface, &view) || seen(surface, event) {
        return false;
    }
    let mut key = key_event(event, Phase::Up);
    let captured = captures(surface, &view, event);
    key.default_prevented = captured;
    remember(surface, event);
    notify(surface, &view, EventKind::KeyUp, key);
    captured
}

/// A modifier key changed: tracks which ones are held and reports the
/// transition as a named `KeyDown` / `KeyUp` on the focused view. Named
/// keys of AppKit have no `keyDown`/`keyUp` of their own.
pub(crate) fn flags_changed(surface: &Surface, event: &NSEvent) {
    // The monitor sees every window of the application: only the surface
    // whose window got the transition tracks it (one tracker per surface,
    // shared by that surface's windows).
    let Some(window) = event.window(surface.mtm) else {
        return;
    };
    if crate::window::root_in(surface, &window).is_none() {
        return;
    }
    // The monitor reports it first; the responder then gets the same event
    // (its transition is already accounted for).
    if seen(surface, event) {
        return;
    }
    let transition = modifier_transition(surface, event);
    remember(surface, event);
    let Some((name, down)) = transition else {
        return;
    };
    let Some(view) = focused(surface, event) else {
        return;
    };
    if !listens(surface, &view) {
        return;
    }
    let mut key = KeyEvent::default();
    key.key = SharedString::new_static(name);
    key.code = SharedString::new_static(dom_code(event.keyCode()));
    key.modifiers = crate::input::modifiers(event.modifierFlags());
    key.default_prevented = captures(surface, &view, event);
    let kind = if down {
        EventKind::KeyDown
    } else {
        EventKind::KeyUp
    };
    notify(surface, &view, kind, key);
}

/// The app stopped, or its surface went away: nothing is held any more
/// and no release is made up.
pub(crate) fn reset(surface: &Surface) {
    surface.keyboard.modifiers.borrow_mut().clear();
    surface.keyboard.last.set(None);
}

/// The app lost the keyboard focus (another app is in front, or it hid):
/// the releases of the keys held may never come, so they are not held any
/// more. No event is made up for them.
pub(crate) fn deactivated(surface: &Surface) {
    reset(surface);
    // Caps Lock's toggle is the system's, not a held key: re-read it.
    surface
        .keyboard
        .caps
        .set(NSEvent::modifierFlags_class().contains(NSEventModifierFlags::CapsLock));
}

/// The NSH view the key is for: the first responder of the event's window
/// when it is one of this surface's focusable views. A field, a hosted
/// view, the root, a blocked window (under a modal) and another surface's
/// views are none.
fn focused(surface: &Surface, event: &NSEvent) -> Option<NshView> {
    let window = event.window(surface.mtm)?;
    let root = crate::window::root_in(surface, &window)?;
    let own = root.ns() != surface.root.ns();
    if crate::window::blocked(surface, own.then_some(&root)) {
        return None;
    }
    let responder = window.firstResponder()?;
    let ns = responder.downcast_ref::<NSView>()?;
    if !ns.isDescendantOf(root.ns()) {
        return None;
    }
    let view = NshView::from_ns(ns)?;
    if view.id() == ROOT_ID {
        return None;
    }
    {
        let state = view.state();
        if !state
            .props
            .focus_stop(state.events.contains(EventKind::Press))
        {
            return None;
        }
    }
    if !view.surface().is_some_and(|s| s.key() == surface.key()) {
        return None;
    }
    Some(view)
}

/// The next view up the keyboard ancestry: the logical parent the core
/// marked for a portaled view ([`nsh_core::ViewProps::key_parent`]), else
/// the native parent.
///
/// An Overlay is moved to a root view's host natively (`Core::sync_overlays`
/// inserts it there) while its logical parent stays the view that contains
/// it. Interest and capture follow that logical ancestry, as the engine's
/// bubbling does; focus, hit testing and layout keep the native parent.
/// The override is an internal routing field, not an app-settable prop.
///
/// A `key_parent` that does not resolve (an ancestor not mounted) ends the
/// walk instead of falling back to the native host: the host is not a
/// logical ancestor, and capturing through it would take an unrelated
/// view's rule.
fn key_ancestor(surface: &Surface, view: &NshView) -> Option<NshView> {
    let logical = view.state().props.key_parent;
    match logical {
        Some(id) => surface
            .mounter
            .try_borrow()
            .ok()
            .and_then(|mounter| mounter.views.get(&id).cloned()),
        None => view.parent_view(),
    }
}

/// Whether `view` or a logical ancestor hears a raw key event or captures
/// keys: only then is a [`KeyEvent`] built. A view that hears none takes
/// the existing path.
fn listens(surface: &Surface, view: &NshView) -> bool {
    let mut current = Some(view.clone());
    while let Some(view) = current {
        {
            let state = view.state();
            let raw = state.events.contains(EventKind::KeyDown)
                || state.events.contains(EventKind::KeyUp);
            if raw || !state.props.key_capture.is_none() {
                return true;
            }
        }
        current = key_ancestor(surface, &view);
    }
    false
}

/// Whether the focused view or one of its enabled logical ancestors
/// captures this transition under the mounted rule ([`KeyCapture`]). A
/// disabled view captures nothing.
///
/// The key is matched as the existing shortcut vocabulary names it
/// ([`crate::keymap::keystroke`]: the virtual key code for named and
/// function keys, the layout's character for the others, the US layout's
/// only where the layout types no ASCII), never by a second parser over
/// the logical name.
fn captures(surface: &Surface, view: &NshView, event: &NSEvent) -> bool {
    // A modifier key's `flagsChanged` has no characters to read: only a
    // press or release has a stroke (and `All` captures it regardless).
    let stroke = match event.r#type() {
        NSEventType::KeyDown | NSEventType::KeyUp => crate::keymap::keystroke(event),
        _ => None,
    };
    let mut current = Some(view.clone());
    while let Some(view) = current {
        let state = view.state();
        if !state.props.accessibility.state.disabled
            && !state.props.key_capture.is_none()
            && state.props.key_capture.captures_key(stroke.as_ref())
        {
            return true;
        }
        drop(state);
        current = key_ancestor(surface, &view);
    }
    false
}

/// The transition being reported.
enum Phase {
    Down,
    Up,
}

/// The [`KeyEvent`] of a key press or release.
///
/// The logical key is what the source reports: AppKit's named keys in
/// their DOM spellings (`Enter`, `ArrowLeft`, `F5`, `Shift`, ...) and the
/// characters the key types with the modifiers held, case and layout
/// preserved (`"A"` for Shift+A, `"å"` for Option+A on the US layout).
/// `code` is the DOM `KeyboardEvent.code` of AppKit's virtual key code:
/// the key's physical place on any layout (`"KeyA"` for code 0, whatever
/// character the layout gives it), and `""` for a code this backend has
/// no name for. It is never derived from the typed character.
fn key_event(event: &NSEvent, phase: Phase) -> KeyEvent {
    let down = matches!(phase, Phase::Down);
    let modifiers = crate::input::modifiers(event.modifierFlags());
    let mut key = KeyEvent::default();
    key.key = key_name(event);
    key.code = SharedString::new_static(dom_code(event.keyCode()));
    key.modifiers = modifiers;
    key.repeat = down && event.isARepeat();
    key
}

/// The DOM `KeyboardEvent.code` of AppKit's virtual key code: the key's
/// physical place on the keyboard, by the UI Events code values' native
/// keycodes (the same mapping Chromium uses). Code 0 is the ANSI `A`.
/// `""` for a key this backend has no code for, never a code derived from
/// the character it types.
fn dom_code(code: u16) -> &'static str {
    match code {
        0x0000 => "KeyA",
        0x0001 => "KeyS",
        0x0002 => "KeyD",
        0x0003 => "KeyF",
        0x0004 => "KeyH",
        0x0005 => "KeyG",
        0x0006 => "KeyZ",
        0x0007 => "KeyX",
        0x0008 => "KeyC",
        0x0009 => "KeyV",
        0x000A => "IntlBackslash",
        0x000B => "KeyB",
        0x000C => "KeyQ",
        0x000D => "KeyW",
        0x000E => "KeyE",
        0x000F => "KeyR",
        0x0010 => "KeyY",
        0x0011 => "KeyT",
        0x0012 => "Digit1",
        0x0013 => "Digit2",
        0x0014 => "Digit3",
        0x0015 => "Digit4",
        0x0016 => "Digit6",
        0x0017 => "Digit5",
        0x0018 => "Equal",
        0x0019 => "Digit9",
        0x001A => "Digit7",
        0x001B => "Minus",
        0x001C => "Digit8",
        0x001D => "Digit0",
        0x001E => "BracketRight",
        0x001F => "KeyO",
        0x0020 => "KeyU",
        0x0021 => "BracketLeft",
        0x0022 => "KeyI",
        0x0023 => "KeyP",
        0x0024 => "Enter",
        0x0025 => "KeyL",
        0x0026 => "KeyJ",
        0x0027 => "Quote",
        0x0028 => "KeyK",
        0x0029 => "Semicolon",
        0x002A => "Backslash",
        0x002B => "Comma",
        0x002C => "Slash",
        0x002D => "KeyN",
        0x002E => "KeyM",
        0x002F => "Period",
        0x0030 => "Tab",
        0x0031 => "Space",
        0x0032 => "Backquote",
        0x0033 => "Backspace",
        0x0035 => "Escape",
        0x0036 => "MetaRight",
        0x0037 => "MetaLeft",
        0x0038 => "ShiftLeft",
        0x0039 => "CapsLock",
        0x003A => "AltLeft",
        0x003B => "ControlLeft",
        0x003C => "ShiftRight",
        0x003D => "AltRight",
        0x003E => "ControlRight",
        0x0040 => "F17",
        0x0041 => "NumpadDecimal",
        0x0043 => "NumpadMultiply",
        0x0045 => "NumpadAdd",
        0x0047 => "NumLock",
        0x0048 => "AudioVolumeUp",
        0x0049 => "AudioVolumeDown",
        0x004A => "AudioVolumeMute",
        0x004B => "NumpadDivide",
        0x004C => "NumpadEnter",
        0x004E => "NumpadSubtract",
        0x004F => "F18",
        0x0050 => "F19",
        0x0051 => "NumpadEqual",
        0x0052 => "Numpad0",
        0x0053 => "Numpad1",
        0x0054 => "Numpad2",
        0x0055 => "Numpad3",
        0x0056 => "Numpad4",
        0x0057 => "Numpad5",
        0x0058 => "Numpad6",
        0x0059 => "Numpad7",
        0x005A => "F20",
        0x005B => "Numpad8",
        0x005C => "Numpad9",
        0x005D => "IntlYen",
        0x005E => "IntlRo",
        0x005F => "NumpadComma",
        0x0060 => "F5",
        0x0061 => "F6",
        0x0062 => "F7",
        0x0063 => "F3",
        0x0064 => "F8",
        0x0065 => "F9",
        0x0066 => "Lang2",
        0x0067 => "F11",
        0x0068 => "Lang1",
        0x0069 => "F13",
        0x006A => "F16",
        0x006B => "F14",
        0x006D => "F10",
        0x006E => "ContextMenu",
        0x006F => "F12",
        0x0071 => "F15",
        0x0072 => "Insert",
        0x0073 => "Home",
        0x0074 => "PageUp",
        0x0075 => "Delete",
        0x0076 => "F4",
        0x0077 => "End",
        0x0078 => "F2",
        0x0079 => "PageDown",
        0x007A => "F1",
        0x007B => "ArrowLeft",
        0x007C => "ArrowRight",
        0x007D => "ArrowDown",
        0x007E => "ArrowUp",
        _ => "",
    }
}

/// The logical name of the key.
fn key_name(event: &NSEvent) -> SharedString {
    let code = event.keyCode();
    if let Some(name) = modifier_name(code) {
        return SharedString::new_static(name);
    }
    if let Some(name) = named_name(code) {
        return SharedString::new_static(name);
    }
    if code == SPACE {
        return SharedString::new_static(" ");
    }
    printed(event)
        .map(SharedString::from)
        .unwrap_or_else(|| SharedString::new_static("Unidentified"))
}

/// The characters `event` types, keeping case and layout: with the
/// modifiers held (Shift, Option, Caps Lock), without Control's control
/// characters, and without the function keys' private-use code points.
/// `None` for a key that types no character (a dead key before its
/// composition).
fn printed(event: &NSEvent) -> Option<String> {
    if let Some(characters) = printable(event.characters()) {
        return Some(characters);
    }
    // Control turns letters into control characters: the key itself is the
    // one Shift would type.
    let shift = NSEventModifierFlags::Shift;
    let flags = if event.modifierFlags().contains(shift) {
        shift
    } else {
        NSEventModifierFlags::empty()
    };
    if let Some(characters) = event
        .charactersByApplyingModifiers(flags)
        .and_then(|characters| printable(Some(characters)))
    {
        return Some(characters);
    }
    printable(event.charactersIgnoringModifiers())
}

/// `characters` as typed text, or `None` when it is empty, all control
/// characters, or all AppKit private-use code points (the arrow and
/// function keys' characters).
fn printable(characters: Option<Retained<NSString>>) -> Option<String> {
    let text = characters?.to_string();
    let usable = |c: char| !c.is_control() && !('\u{e000}'..='\u{f8ff}').contains(&c);
    (!text.is_empty() && text.chars().any(usable)).then_some(text)
}

/// AppKit's virtual key code of the space bar.
const SPACE: u16 = 49;

/// AppKit's virtual key code of Caps Lock (`kVK_CapsLock`).
const CAPS_LOCK: u16 = 57;

/// The app's named keys in their DOM spellings (`KeyboardEvent.key`).
fn named_name(code: u16) -> Option<&'static str> {
    Some(match code {
        36 | 76 => "Enter",
        48 => "Tab",
        51 => "Backspace",
        53 => "Escape",
        117 => "Delete",
        // Help, where PC keyboards have Insert.
        114 => "Help",
        115 => "Home",
        119 => "End",
        116 => "PageUp",
        121 => "PageDown",
        123 => "ArrowLeft",
        124 => "ArrowRight",
        125 => "ArrowDown",
        126 => "ArrowUp",
        _ => return function_name(code),
    })
}

/// F1 to F20, by virtual key code.
fn function_name(code: u16) -> Option<&'static str> {
    const NAMES: [&str; 20] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14",
        "F15", "F16", "F17", "F18", "F19", "F20",
    ];
    let n = crate::keymap::function_key(code)?;
    NAMES.get(usize::from(n).checked_sub(1)?).copied()
}

/// The name of a modifier key's virtual key code: the DOM's spelling of
/// each (`Alt` is Option, `Meta` is Command).
fn modifier_name(code: u16) -> Option<&'static str> {
    Some(match code {
        54 | 55 => "Meta",
        56 | 60 => "Shift",
        57 => "CapsLock",
        58 | 61 => "Alt",
        59 | 62 => "Control",
        63 => "Fn",
        _ => return None,
    })
}

/// Records `event`'s modifier transition and returns the key's name and
/// whether it went down. AppKit reports the modifier keys only this way.
///
/// A modifier's direction comes from its own flag, which is set while the
/// modifier is held: a transition without it is a release even when its
/// press was never tracked (after losing the app's focus, or in another
/// surface). A transition with the flag set is a press unless this key
/// code is already held (the release of one Shift while the other is).
/// Caps Lock toggles, so the event that changes its flag is its press.
fn modifier_transition(surface: &Surface, event: &NSEvent) -> Option<(&'static str, bool)> {
    let code = event.keyCode();
    let name = modifier_name(code)?;
    let flags = event.modifierFlags();
    // A modifier released while a native menu owned the events (local
    // monitors skip nested loops) is no longer held: the flags say so.
    reconcile(surface, flags, Some(code));
    let down = if code == CAPS_LOCK {
        // The key toggles: the event that changes the flag is its press,
        // and one that does not is its release.
        let on = flags.contains(NSEventModifierFlags::CapsLock);
        on != surface.keyboard.caps.replace(on)
    } else {
        let held_by = modifier_flag(code)?;
        let mut held = surface.keyboard.modifiers.borrow_mut();
        let was = held.remove(&code);
        let down = flags.contains(held_by) && !was;
        if down {
            held.insert(code);
        }
        down
    };
    Some((name, down))
}

/// The modifier flag a held key stands for (`None` for Caps Lock, which
/// toggles instead of holding).
fn modifier_flag(code: u16) -> Option<NSEventModifierFlags> {
    Some(match code {
        54 | 55 => NSEventModifierFlags::Command,
        56 | 60 => NSEventModifierFlags::Shift,
        58 | 61 => NSEventModifierFlags::Option,
        59 | 62 => NSEventModifierFlags::Control,
        63 => NSEventModifierFlags::Function,
        _ => return None,
    })
}

/// Drops the modifier keys held whose flag `flags` no longer has, except
/// `except` (the key of the transition being read: a release's flag is
/// gone, and it still has to be seen as a release).
fn reconcile(surface: &Surface, flags: NSEventModifierFlags, except: Option<u16>) {
    let mut held = surface.keyboard.modifiers.borrow_mut();
    held.retain(|&code| {
        except == Some(code) || modifier_flag(code).is_none_or(|flag| flags.contains(flag))
    });
}

/// Reports `key` at `view` (the engine bubbles it to the ancestors) as
/// `kind`.
fn notify(surface: &Surface, view: &NshView, kind: EventKind, key: KeyEvent) {
    let id = view.id();
    if !key.default_prevented {
        log::debug!(
            target: "nsh::keyboard",
            "{} {} on {id} (code {:?})",
            kind.prop_name(),
            key.key,
            key.code
        );
    }
    surface.event(id, kind, EventPayload::Key(key));
}

/// Whether this event was already reported (the monitor reported it, and
/// AppKit then handed it to the responder too). The mark stays through the
/// responder chain, so a key bubbled to several NSH views is not reported
/// at each of them.
fn seen(surface: &Surface, event: &NSEvent) -> bool {
    surface.keyboard.last.get() == Some(Mark::of(event))
}

fn remember(surface: &Surface, event: &NSEvent) {
    surface.keyboard.last.set(Some(Mark::of(event)));
}
