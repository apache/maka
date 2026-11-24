//! Keyboard focus for custom views, and the hardware key events they hear.
//!
//! Windows gives the keyboard to a text field NSH hosts or to a web view's
//! window; nothing else in a surface could take it. This module adds the
//! third case: a mounted view that is a focus stop
//! ([`nsh_core::ViewProps::focus_stop`]: `focusable`, or a view that takes
//! presses) takes the keyboard focus with Tab, a click, `ref.focus()` or
//! UI Automation. While it has the focus, the window's `WM_KEYDOWN` /
//! `WM_KEYUP` messages become [`nsh_core::KeyEvent`]s
//! ([`crate::surface::Surface::event`]): the engine bubbles both to the
//! view's listening ancestors within its native window.
//!
//! The logical key comes from the current keyboard layout
//! (`ToUnicodeEx`), never from a US layout guess; `code` is the DOM
//! `KeyboardEvent.code` of the message's scan code and extended bit, the
//! key's physical place on any layout (`""` when the message carries no
//! scan code, as input injected as text does). The keys are the same
//! shortcut keys [`crate::keymap`] matches (virtual keys, US letters under
//! non-Latin layouts), so a captured key is one the app can also bind.
//!
//! Capture rules ([`nsh_core::KeyCapture`]) are read from the mounted
//! props of the focused view and its enabled ancestors — walking
//! [`nsh_core::ViewProps::key_parent`] when core set one for a view a
//! native surface portals at a root it does not logically live under —
//! before the native defaults of [`crate::input::key`] (the application menu, a focused
//! field's editing, navigation, scrolling, Tab's traversal). A captured
//! key is still reported, with `default_prevented` set, and runs none of
//! those defaults. A captured key is never translated into characters:
//! [`suppress_translation`] runs from the thread's `WH_GETMESSAGE` hook
//! (and the standalone loop) before `TranslateMessage`, and turns the key
//! down into a private message the window procedure handles as the key
//! down it was. Nothing of the message queue is inspected, moved or
//! restamped, so a character queued around the key keeps its place and
//! its delivery.
//!
//! Focus is per native window (the main window's root, or the root of a
//! window of the app's own): a window in the background keeps its view, and
//! the keys of the window in front only reach its own. A modal presented
//! over a window saves the custom view with the focus, as it saves a
//! text field, and gives it back when it closes if that view is still a
//! shown, enabled stop. A view that is removed, concealed or disabled
//! loses the focus without a synthetic key release; releases are reported
//! when the source sends them, on whatever view has the focus then, and
//! repeats are what the message's previous-key-state bit says.

use std::cell::RefCell;

use nsh_core::{
    EventKind, EventPayload, NodeId, PointerEvents, ViewKind,
    element::SharedString,
    keymap::{Key, Keystroke},
};
use rustc_hash::FxHashMap;
#[cfg(test)]
use windows::Win32::UI::Input::KeyboardAndMouse::SetKeyboardState;
use windows::Win32::UI::{
    Input::KeyboardAndMouse::{
        GetFocus, GetKeyState, GetKeyboardLayout, GetKeyboardState, HKL, MAPVK_VK_TO_CHAR,
        MapVirtualKeyExW, SetFocus, ToUnicodeEx, VK_NUMLOCK,
    },
    WindowsAndMessaging::{MSG, WM_KEYDOWN, WM_SYSKEYDOWN},
};

use crate::{app_window::window_of, input::KeyEvent, surface::Surface, view::NshView};

/// `ToUnicodeEx`'s "keyboard state is not changed" flag (Windows 10
/// 1607+): translating a key for an event must not store the dead key,
/// ligature or Alt+numpad state it reads.
const NO_STATE_CHANGE: u32 = 0x4;

/// A surface's keyboard focus: the view with it in each of its windows.
#[derive(Default)]
pub(crate) struct Keyboard {
    /// The focused custom view of each native window, by the window's root
    /// node ([`ROOT_ID`](nsh_core::ROOT_ID) for the main window).
    focus: RefCell<FxHashMap<NodeId, NshView>>,
}

/// The app stopped: its views are gone with it.
pub(crate) fn reset(surface: &Surface) {
    surface.keyboard.focus.borrow_mut().clear();
}

/// Whether Tab stops at `view`: it takes presses or is `focusable`, and
/// the pointer could reach it. A text field is a stop of its own
/// ([`crate::text_input`]) and not one of these.
pub(crate) fn is_stop(view: &NshView) -> bool {
    {
        let state = view.state();
        if state.kind == ViewKind::Input
            || !state
                .props
                .focus_stop(state.events.contains(EventKind::Press))
        {
            return false;
        }
    }
    targetable(view)
}

/// Whether the pointer may reach `view` (it and its ancestors are shown,
/// targetable and not leaving).
fn targetable(view: &NshView) -> bool {
    let mut current = Some(view.clone());
    while let Some(view) = current {
        {
            let state = view.state();
            if state.style.hidden
                || state.concealed
                || state.props.pointer_events == PointerEvents::None
                || state.live.as_ref().is_some_and(|live| live.dying())
            {
                return false;
            }
        }
        current = view.parent_view();
    }
    view.attached()
}

/// Whether `view` is the root of a window of the app's own: the keyboard
/// boundary its ancestors do not cross.
fn window_root(surface: &Surface, view: &NshView) -> bool {
    view.kind() == ViewKind::Modal && crate::app_window::is_window(surface, view.id())
}

/// Walks `view` and its keyboard ancestry within its native window, with
/// `f` deciding; true when `f` does.
///
/// The next ancestor is [`nsh_core::ViewProps::key_parent`] when core set
/// one — a view a native surface portals at a root it does not logically
/// live under (an `Overlay`): the mounted parent there is not proof of
/// logical ancestry — and the mounted parent otherwise. The walk ends
/// after the root of a window of the app's own: keys do not cross native
/// windows. Ordinary focus, hit testing and layout keep their mounted
/// parents; only this interest/capture walk follows the override.
fn walk_keyboard(surface: &Surface, view: &NshView, mut f: impl FnMut(&NshView) -> bool) -> bool {
    let window = window_of(surface, view);
    let content = view.state().props.key_content;
    let mut current = Some(
        content
            .and_then(|id| surface.view(id))
            .unwrap_or_else(|| view.clone()),
    );
    // Bounded: a routing override is core's, but a broken one must not hang
    // the window.
    for _ in 0..1024 {
        let Some(view) = current else {
            return false;
        };
        if f(&view) {
            return true;
        }
        if window_root(surface, &view) {
            return false;
        }
        let logical = view
            .state()
            .props
            .key_parent
            .and_then(|id| surface.view(id))
            // A native window is a keyboard boundary even across a
            // routing override.
            .filter(|parent| window_of(surface, parent) == window);
        current = logical.or_else(|| view.parent_view());
    }
    false
}

/// Whether `view` or a keyboard ancestor within its window hears
/// `KeyDown` / `KeyUp` or captures keys. A view that does neither takes
/// the original path of [`crate::input::key`], with no event built.
pub(crate) fn listens(surface: &Surface, view: &NshView) -> bool {
    walk_keyboard(surface, view, |view| {
        let state = view.state();
        state.events.contains(EventKind::KeyDown)
            || state.events.contains(EventKind::KeyUp)
            || !state.props.key_capture.is_none()
    })
}

/// Whether the focused `view` or one of its enabled keyboard ancestors
/// captures the key of `stroke` (`capture_keys`;
/// [`nsh_core::KeyCapture`]). Disabled views and the views outside the
/// window capture nothing.
pub(crate) fn captures(surface: &Surface, view: &NshView, stroke: Option<&Keystroke>) -> bool {
    walk_keyboard(surface, view, |view| {
        let state = view.state();
        !state.props.accessibility.state.disabled && state.props.key_capture.captures_key(stroke)
    })
}

/// The focused custom view of window `window`, if it is still a stop
/// (a view that lost `focusable`, was hidden or was removed loses the
/// focus quietly).
pub(crate) fn focused_in(surface: &Surface, window: NodeId) -> Option<NshView> {
    let view = surface.keyboard.focus.borrow().get(&window).cloned()?;
    if !valid(surface, &view) || window_of(surface, &view) != window {
        clear(surface, window);
        return None;
    }
    Some(view)
}

/// The focused custom view of the input window (or of any window when that
/// one has none): UI Automation's focus, per window.
pub(crate) fn focused_any(surface: &Surface) -> Option<NshView> {
    let windows: Vec<NodeId> = surface.keyboard.focus.borrow().keys().copied().collect();
    let input = surface.input_root().id();
    if windows.contains(&input)
        && let Some(view) = focused_in(surface, input)
    {
        return Some(view);
    }
    for window in windows {
        if let Some(view) = focused_in(surface, window) {
            return Some(view);
        }
    }
    None
}

/// The view the raw keys of window `window` go to: its focused custom
/// view, else its root when nothing in it has the keyboard (no custom
/// view, no text field), as a browser reports a key at `document.body`.
/// The root is no stop: it is only notified, never pressed.
pub(crate) fn key_target(surface: &Surface, window: NodeId) -> Option<NshView> {
    if let Some(view) = focused_in(surface, window) {
        return Some(view);
    }
    if crate::text_input::focused(surface).is_some_and(|field| window_of(surface, &field) == window)
    {
        return None;
    }
    if window == nsh_core::ROOT_ID {
        Some(surface.root.clone())
    } else {
        crate::app_window::root_view(surface, window)
    }
}

/// Whether the focus held for `view` is still valid: a stop, and not
/// given to a text field of the same window (a field and a custom view
/// never both have the keyboard of one window).
fn valid(surface: &Surface, view: &NshView) -> bool {
    if !is_stop(view) {
        return false;
    }
    let Some(field) = crate::text_input::focused(surface) else {
        return true;
    };
    window_of(surface, &field) != window_of(surface, view)
}

/// `ref.focus()` on a view that is not a field: the keyboard focus moves
/// to it if it is a stop, as Tab moves it there. False when it is not.
pub(crate) fn focus_control(surface: &std::rc::Rc<Surface>, view: &NshView) -> bool {
    if view.kind() == ViewKind::Input || view.id() == nsh_core::ROOT_ID || !is_stop(view) {
        return false;
    }
    focus_view(surface, view, true);
    true
}

/// A press at `view`: the focus stop it belongs to is the view itself or
/// its nearest focusable ancestor within the same window.
pub(crate) fn focus_target(surface: &Surface, view: &NshView) -> Option<NshView> {
    let window = window_of(surface, view);
    let mut current = Some(view.clone());
    while let Some(view) = current {
        if is_stop(&view) {
            return Some(view);
        }
        if window_of(surface, &view) != window {
            return None;
        }
        current = view.parent_view();
    }
    None
}

/// A press focused `view`: as [`focus_control`], without scrolling it into
/// view (the pointer is on it).
pub(crate) fn focus_pointer(surface: &std::rc::Rc<Surface>, view: &NshView) {
    if is_stop(view) {
        focus_view(surface, view, false);
    }
}

/// Moves the keyboard focus to `view` in its window, reporting the blur of
/// the view that had it and the focus of the new one.
fn focus_view(surface: &std::rc::Rc<Surface>, view: &NshView, reveal: bool) {
    let window = window_of(surface, view);
    if surface
        .keyboard
        .focus
        .borrow()
        .get(&window)
        .is_some_and(|held| held == view)
    {
        return;
    }
    // A field of this window that edits leaves the focus to the custom
    // view, as Tab does; another window's field keeps its own.
    if let Some(field) = crate::text_input::focused(surface)
        && window_of(surface, &field) == window
    {
        crate::text_input::blur(&field);
    }
    clear(surface, window);
    take_keyboard(surface, view);
    surface
        .keyboard
        .focus
        .borrow_mut()
        .insert(window, view.clone());
    crate::input::set_state(surface, view, nsh_core::tailwind::state::FOCUSED, true);
    surface.event(view.id(), EventKind::Focus, EventPayload::None);
    // Focused stops report it to assistive technologies, as fields do.
    crate::access::focus_changed(surface, view);
    if reveal {
        crate::scroll::reveal(surface, view);
    }
    view.changed();
}

/// Gives the window showing `view` the keyboard focus, so the next
/// `WM_KEY*` message comes to it rather than to a child a page took it
/// from.
fn take_keyboard(surface: &Surface, view: &NshView) {
    let hwnd = crate::app_window::hwnd_showing(surface, view);
    if hwnd.is_invalid() {
        return;
    }
    // SAFETY: plain calls on a window of this thread.
    unsafe {
        if GetFocus() != hwnd {
            let _ = SetFocus(Some(hwnd));
        }
    }
}

/// `ref.blur()` on a custom view that has the focus. False when it does
/// not.
pub(crate) fn blur(surface: &Surface, view: &NshView) -> bool {
    let window = window_of(surface, view);
    let holds = surface
        .keyboard
        .focus
        .borrow()
        .get(&window)
        .is_some_and(|held| held == view);
    if !holds {
        return false;
    }
    surface.keyboard.focus.borrow_mut().remove(&window);
    blur_view(surface, view);
    true
}

/// Blurs the focused custom view of window `window` (a modal is presented
/// over it).
pub(crate) fn blur_window(surface: &Surface, window: NodeId) {
    clear(surface, window);
}

/// Blurs the focus held inside `ancestor` (it is being concealed).
pub(crate) fn blur_within(surface: &Surface, ancestor: &NshView) {
    let affected: Vec<(NodeId, NshView)> = {
        let focus = surface.keyboard.focus.borrow();
        focus
            .iter()
            .filter(|(_, view)| within(view, ancestor))
            .map(|(window, view)| (*window, view.clone()))
            .collect()
    };
    for (window, view) in affected {
        surface.keyboard.focus.borrow_mut().remove(&window);
        blur_view(surface, &view);
    }
}

/// `view` (or one of its views) is gone: forget the focus without an
/// event (a removed view has no one to tell).
pub(crate) fn forget(surface: &Surface, view: &NshView) {
    surface
        .keyboard
        .focus
        .borrow_mut()
        .retain(|_, focused| &*focused != view && !within(focused, view));
}

/// The window showing dialog root `window` was destroyed.
pub(crate) fn forget_window(surface: &Surface, window: NodeId) {
    surface.keyboard.focus.borrow_mut().remove(&window);
}

/// Whether `view` is `ancestor` or inside it.
fn within(view: &NshView, ancestor: &NshView) -> bool {
    let mut current = Some(view.clone());
    while let Some(view) = current {
        if view == *ancestor {
            return true;
        }
        current = view.parent_view();
    }
    false
}

/// Reports the blur of `view`: its `focus:` state goes off and a `Blur`
/// event follows.
fn blur_view(surface: &Surface, view: &NshView) {
    crate::input::set_state(surface, view, nsh_core::tailwind::state::FOCUSED, false);
    surface.event(view.id(), EventKind::Blur, EventPayload::None);
    view.changed();
}

/// Clears the focus held in `window`, reporting the blur.
fn clear(surface: &Surface, window: NodeId) {
    let view = surface.keyboard.focus.borrow_mut().remove(&window);
    if let Some(view) = view {
        blur_view(surface, &view);
    }
}

/// The key a key message went down or up on, as the layout names it: a
/// named key by its DOM spelling (`Enter`, `ArrowLeft`, `F5`), a
/// character by the character it types (its actual case, with Shift and
/// Caps Lock), and `Unidentified` for a key the layout cannot name (a dead
/// key, `VK_PROCESSKEY`).
fn key_name(event: &KeyEvent) -> SharedString {
    // With Num Lock off, the keypad's keys are the navigation keys they
    // are labeled with, as they are to the system (`WM_CHAR` comes for
    // none of them).
    if !num_lock()
        && let Some(name) = keypad_navigation(event.vk)
    {
        return SharedString::new_static(name);
    }
    let named = match event.vk {
        0x03 => Some("Cancel"),
        0x08 => Some("Backspace"),
        0x09 => Some("Tab"),
        0x0C => Some("Clear"),
        0x0D => Some("Enter"),
        0x13 => Some("Pause"),
        0x14 => Some("CapsLock"),
        0x1B => Some("Escape"),
        0x20 => Some(" "),
        0x21 => Some("PageUp"),
        0x22 => Some("PageDown"),
        0x23 => Some("End"),
        0x24 => Some("Home"),
        0x25 => Some("ArrowLeft"),
        0x26 => Some("ArrowUp"),
        0x27 => Some("ArrowRight"),
        0x28 => Some("ArrowDown"),
        0x29 => Some("Select"),
        0x2A => Some("Print"),
        0x2B => Some("Execute"),
        0x2C => Some("PrintScreen"),
        0x2D => Some("Insert"),
        0x2E => Some("Delete"),
        0x2F => Some("Help"),
        0x5D => Some("ContextMenu"),
        0x5F => Some("Sleep"),
        0x6A => Some("Multiply"),
        0x6B => Some("Add"),
        0x6C => Some("Separator"),
        0x6D => Some("Subtract"),
        0x6E => Some("Decimal"),
        0x6F => Some("Divide"),
        // The Windows, Command/Super key.
        0x5B | 0x5C => Some("Meta"),
        // The modifier keys themselves (the left and right ones too).
        0x10 | 0xA0 | 0xA1 => Some("Shift"),
        0x11 | 0xA2 | 0xA3 => Some("Control"),
        0x12 | 0xA4 | 0xA5 => Some("Alt"),
        0x90 => Some("NumLock"),
        0x91 => Some("ScrollLock"),
        0xA6 => Some("BrowserBack"),
        0xA7 => Some("BrowserForward"),
        0xA8 => Some("BrowserRefresh"),
        0xA9 => Some("BrowserStop"),
        0xAA => Some("BrowserSearch"),
        0xAB => Some("BrowserFavorites"),
        0xAC => Some("BrowserHome"),
        0xAD => Some("AudioVolumeMute"),
        0xAE => Some("AudioVolumeDown"),
        0xAF => Some("AudioVolumeUp"),
        0xB0 => Some("MediaTrackNext"),
        0xB1 => Some("MediaTrackPrevious"),
        0xB2 => Some("MediaStop"),
        0xB3 => Some("MediaPlayPause"),
        0xB4 => Some("LaunchMail"),
        0xB5 => Some("LaunchMediaPlayer"),
        0xB6 => Some("LaunchApplication1"),
        0xB7 => Some("LaunchApplication2"),
        0xFA => Some("MediaPlay"),
        _ => None,
    };
    if let Some(named) = named {
        return SharedString::new_static(named);
    }
    if (0x70..=0x87).contains(&event.vk) {
        let n = event.vk - 0x6F;
        return SharedString::from(format!("F{n}"));
    }
    match logical_char(event) {
        Some(c) => SharedString::from(c.to_string()),
        None => SharedString::new_static("Unidentified"),
    }
}

/// The character `event`'s key types on the current layout, as DOM's
/// `key` reports it: the source's own translation with every modifier and
/// lock held (AltGr's `@`, Shift's `A`). A Control/Alt/Windows combination
/// that only makes a control character (`Ctrl+A`'s 0x01) is no key name:
/// then the key without them is used (`a`), with Shift and Caps Lock kept
/// (a shortcut reports the character it is on). A dead key has none (it
/// composes with the next key), and neither has a key that types nothing.
fn logical_char(event: &KeyEvent) -> Option<char> {
    if dead_key(event.vk) {
        return None;
    }
    // The source's own translation first: AltGr's `@`, Shift's `?` and
    // Caps Lock's `A` are the character the key is, even though the
    // modifiers held are Control and Alt. A Control/Alt combination that
    // makes a control character (`Ctrl+A`'s 0x01) is not a key name: then
    // the key without them (`a`), which is what a shortcut is on.
    if let Some(c) = translated(event, &actual_state()) {
        return Some(c);
    }
    translated(event, &logical_state()).or_else(|| {
        // A virtual key with no character (an arrow, a function key).
        mapped_char(event.vk).filter(|c| !c.is_control())
    })
}

/// `event`'s key translated with `state` (`ToUnicodeEx`): the first
/// character, when the source writes one and it is printable. A dead key
/// is never translated (`dead_key`) and written nothing.
///
/// Every translation passes [`NO_STATE_CHANGE`], so a dead key in a layer
/// the virtual key's base character does not show (an AltGr dead key) is
/// read without being stored: the layout's pending dead key, ligatures and
/// Alt+numpad entry are left as `TranslateMessage` left them.
fn translated(event: &KeyEvent, state: &[u8; 256]) -> Option<char> {
    let mut buffer = [0u16; 4];
    // SAFETY: plain calls; `buffer` is a local out value and `state` a
    // full keyboard-state array.
    let written = unsafe {
        ToUnicodeEx(
            event.vk as u32,
            event.scan as u32,
            state,
            &mut buffer,
            NO_STATE_CHANGE,
            Some(layout()),
        )
    };
    if written <= 0 {
        return None;
    }
    let text = String::from_utf16_lossy(&buffer[..written as usize]);
    text.chars().next().filter(|c| !c.is_control())
}

/// The keyboard state as the message found it: what the character is with
/// every modifier and lock the user holds (AltGr's `@`, Shift's `A`).
fn actual_state() -> [u8; 256] {
    let mut state = [0u8; 256];
    // SAFETY: a full keyboard-state array as an out value.
    let _ = unsafe { GetKeyboardState(&mut state) };
    state
}

/// Whether Num Lock is on (its toggle, as of the key being handled).
fn num_lock() -> bool {
    // SAFETY: a plain query of this thread's key state.
    let state = unsafe { GetKeyState(VK_NUMLOCK.0 as i32) };
    state & 1 != 0
}

/// The key a keypad key is with Num Lock off.
fn keypad_navigation(vk: u16) -> Option<&'static str> {
    Some(match vk {
        0x60 => "Insert",
        0x61 => "End",
        0x62 => "ArrowDown",
        0x63 => "PageDown",
        0x64 => "ArrowLeft",
        0x65 => "Clear",
        0x66 => "ArrowRight",
        0x67 => "Home",
        0x68 => "ArrowUp",
        0x69 => "PageUp",
        0x6E => "Delete",
        _ => return None,
    })
}

/// The keyboard state with Control, Alt and the Windows key up: what a
/// shortcut's key is, without the control character they make. Shift and
/// Caps Lock stay, so the key keeps its actual case; `ToUnicodeEx` ignores
/// Num Lock and Scroll Lock (a keypad key with Num Lock off is named as
/// its navigation key by [`key_name`] before this).
fn logical_state() -> [u8; 256] {
    let mut state = [0u8; 256];
    // SAFETY: a full keyboard-state array as an out value.
    if unsafe { GetKeyboardState(&mut state) }.is_err() {
        return state;
    }
    for vk in [0x11, 0xA2, 0xA3, 0x12, 0xA4, 0xA5, 0x5B, 0x5C] {
        state[vk] = 0;
    }
    state
}

/// Whether `vk` is a dead key (it composes with the next key on the
/// current layout). `ToUnicodeEx` would then change the layout's pending
/// dead key, so its callers do not ask it.
fn dead_key(vk: u16) -> bool {
    let value = unsafe { MapVirtualKeyExW(vk as u32, MAPVK_VK_TO_CHAR, Some(layout())) };
    value & 0x8000_0000 != 0
}

/// The character `vk` maps to (`MapVirtualKeyEx`), when the layout has
/// one: letters come as the US layout's upper case here (the source's own
/// limit), which [`logical_char`] refines through `ToUnicodeEx`.
fn mapped_char(vk: u16) -> Option<char> {
    let value = unsafe { MapVirtualKeyExW(vk as u32, MAPVK_VK_TO_CHAR, Some(layout())) };
    if value & 0x8000_0000 != 0 {
        return None;
    }
    let unit = (value & 0xFFFF) as u16;
    if unit == 0 {
        return None;
    }
    char::from_u32(unit as u32)
}

/// The current thread's keyboard layout (the one its window's keys come
/// from).
fn layout() -> HKL {
    // SAFETY: a plain query for this thread's layout.
    unsafe { GetKeyboardLayout(0) }
}

/// The DOM `KeyboardEvent.code` of the message's physical key: its scan
/// code with the E0 prefix when the message sets the extended-key bit,
/// matching the native scan codes in the UI Events/Chromium table.
/// `""` when the message carries no scan code (input the system injected
/// as text, `VK_PACKET`) or names a key this backend has no code for.
/// Never derived from the layout's character or the virtual key.
fn dom_code(event: &KeyEvent) -> &'static str {
    if event.scan == 0 {
        return "";
    }
    let code = event.scan | if event.extended { 0xE000 } else { 0 };
    match code {
        0x0001 => "Escape",
        0x0002 => "Digit1",
        0x0003 => "Digit2",
        0x0004 => "Digit3",
        0x0005 => "Digit4",
        0x0006 => "Digit5",
        0x0007 => "Digit6",
        0x0008 => "Digit7",
        0x0009 => "Digit8",
        0x000A => "Digit9",
        0x000B => "Digit0",
        0x000C => "Minus",
        0x000D => "Equal",
        0x000E => "Backspace",
        0x000F => "Tab",
        0x0010 => "KeyQ",
        0x0011 => "KeyW",
        0x0012 => "KeyE",
        0x0013 => "KeyR",
        0x0014 => "KeyT",
        0x0015 => "KeyY",
        0x0016 => "KeyU",
        0x0017 => "KeyI",
        0x0018 => "KeyO",
        0x0019 => "KeyP",
        0x001A => "BracketLeft",
        0x001B => "BracketRight",
        0x001C => "Enter",
        0x001D => "ControlLeft",
        0x001E => "KeyA",
        0x001F => "KeyS",
        0x0020 => "KeyD",
        0x0021 => "KeyF",
        0x0022 => "KeyG",
        0x0023 => "KeyH",
        0x0024 => "KeyJ",
        0x0025 => "KeyK",
        0x0026 => "KeyL",
        0x0027 => "Semicolon",
        0x0028 => "Quote",
        0x0029 => "Backquote",
        0x002A => "ShiftLeft",
        0x002B => "Backslash",
        0x002C => "KeyZ",
        0x002D => "KeyX",
        0x002E => "KeyC",
        0x002F => "KeyV",
        0x0030 => "KeyB",
        0x0031 => "KeyN",
        0x0032 => "KeyM",
        0x0033 => "Comma",
        0x0034 => "Period",
        0x0035 => "Slash",
        0x0036 => "ShiftRight",
        0x0037 => "NumpadMultiply",
        0x0038 => "AltLeft",
        0x0039 => "Space",
        0x003A => "CapsLock",
        0x003B => "F1",
        0x003C => "F2",
        0x003D => "F3",
        0x003E => "F4",
        0x003F => "F5",
        0x0040 => "F6",
        0x0041 => "F7",
        0x0042 => "F8",
        0x0043 => "F9",
        0x0044 => "F10",
        0x0045 => "Pause",
        0x0046 => "ScrollLock",
        0x0047 => "Numpad7",
        0x0048 => "Numpad8",
        0x0049 => "Numpad9",
        0x004A => "NumpadSubtract",
        0x004B => "Numpad4",
        0x004C => "Numpad5",
        0x004D => "Numpad6",
        0x004E => "NumpadAdd",
        0x004F => "Numpad1",
        0x0050 => "Numpad2",
        0x0051 => "Numpad3",
        0x0052 => "Numpad0",
        0x0053 => "NumpadDecimal",
        0x0056 => "IntlBackslash",
        0x0057 => "F11",
        0x0058 => "F12",
        0x0059 => "NumpadEqual",
        0x0064 => "F13",
        0x0065 => "F14",
        0x0066 => "F15",
        0x0067 => "F16",
        0x0068 => "F17",
        0x0069 => "F18",
        0x006A => "F19",
        0x006B => "F20",
        0x006C => "F21",
        0x006D => "F22",
        0x006E => "F23",
        0x0070 => "KanaMode",
        0x0071 => "Lang2",
        0x0072 => "Lang1",
        0x0073 => "IntlRo",
        0x0076 => "F24",
        0x0077 => "Lang4",
        0x0078 => "Lang3",
        0x0079 => "Convert",
        0x007B => "NonConvert",
        0x007D => "IntlYen",
        0x007E => "NumpadComma",
        0xE008 => "Undo",
        0xE00A => "Paste",
        0xE010 => "MediaTrackPrevious",
        0xE017 => "Cut",
        0xE018 => "Copy",
        0xE019 => "MediaTrackNext",
        0xE01C => "NumpadEnter",
        0xE01D => "ControlRight",
        0xE020 => "AudioVolumeMute",
        0xE021 => "LaunchApp2",
        0xE022 => "MediaPlayPause",
        0xE024 => "MediaStop",
        0xE02C => "Eject",
        0xE02E => "AudioVolumeDown",
        0xE030 => "AudioVolumeUp",
        0xE032 => "BrowserHome",
        0xE035 => "NumpadDivide",
        0xE037 => "PrintScreen",
        0xE038 => "AltRight",
        0xE03B => "Help",
        0xE045 => "NumLock",
        0xE047 => "Home",
        0xE048 => "ArrowUp",
        0xE049 => "PageUp",
        0xE04B => "ArrowLeft",
        0xE04D => "ArrowRight",
        0xE04F => "End",
        0xE050 => "ArrowDown",
        0xE051 => "PageDown",
        0xE052 => "Insert",
        0xE053 => "Delete",
        0xE05B => "MetaLeft",
        0xE05C => "MetaRight",
        0xE05D => "ContextMenu",
        0xE05E => "Power",
        0xE05F => "Sleep",
        0xE063 => "WakeUp",
        0xE065 => "BrowserSearch",
        0xE066 => "BrowserFavorites",
        0xE067 => "BrowserRefresh",
        0xE068 => "BrowserStop",
        0xE069 => "BrowserForward",
        0xE06A => "BrowserBack",
        0xE06B => "LaunchApp1",
        0xE06C => "LaunchMail",
        0xE06D => "MediaSelect",
        _ => "",
    }
}

/// The capture rule's keystroke: the same shortcut key [`crate::keymap`]
/// matches (virtual keys, US letters under non-Latin layouts), or `None`
/// for a key no shortcut names (a modifier key, an unidentified one) —
/// only [`nsh_core::KeyCapture::All`] takes those.
fn capture_keystroke(event: &KeyEvent) -> Option<Keystroke> {
    Some(Keystroke {
        modifiers: event.modifiers.core(),
        key: Key::from_virtual_key(event.vk)?,
    })
}

/// The core event of `event`, with the transition's capture decision.
#[allow(
    clippy::field_reassign_with_default,
    reason = "nsh_core::KeyEvent is #[non_exhaustive]: its default, then its fields"
)]
fn core_event(event: &KeyEvent, down: bool, default_prevented: bool) -> nsh_core::KeyEvent {
    let mut key = nsh_core::KeyEvent::default();
    key.key = key_name(event);
    key.code = SharedString::new_static(dom_code(event));
    key.modifiers = event.modifiers.core();
    key.repeat = down && event.repeat;
    key.default_prevented = default_prevented;
    key
}

/// A key down on the focused custom view: reports it and says whether a
/// capture consumed it (no native default follows).
pub(crate) fn press(surface: &std::rc::Rc<Surface>, event: &KeyEvent) -> bool {
    let window = surface.input_root().id();
    let Some(view) = key_target(surface, window) else {
        return false;
    };
    if !listens(surface, &view) {
        return false;
    }
    let stroke = capture_keystroke(event);
    let captured = captures(surface, &view, stroke.as_ref());
    let key = core_event(event, true, captured);
    surface.event(view.id(), EventKind::KeyDown, EventPayload::Key(key));
    // A captured key was never translated into characters
    // (`suppress_translation`), so no text follows it; no queue is
    // touched here, and a character the queue already held stays where it
    // is.
    captured
}

/// The focused custom view of the input window when it takes presses: a
/// control Return and Space press ([`activate`]).
pub(crate) fn focused_control(surface: &Surface) -> Option<NshView> {
    let view = focused_in(surface, surface.input_root().id())?;
    let takes_presses = {
        let state = view.state();
        state.events.contains(EventKind::Press) && !state.props.accessibility.state.disabled
    };
    takes_presses.then_some(view)
}

/// Return or Space press the focused control
/// ([`nsh_core::input::presses_focused_control`]), as on the other
/// platforms, once the app's bindings and the view's own key listeners
/// passed on them. True when handled.
pub(crate) fn activate(surface: &std::rc::Rc<Surface>, event: &KeyEvent) -> bool {
    use nsh_core::keymap::{Key, Modifiers};
    let key = match event.vk {
        0x0D => Key::Enter,
        0x20 => Key::Char(' '),
        _ => return false,
    };
    let m = event.modifiers;
    let held = Modifiers {
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        cmd: m.meta,
    };
    if !event.down || !nsh_core::input::presses_focused_control(key, held) {
        return false;
    }
    let Some(view) = focused_control(surface) else {
        return false;
    };
    surface.event(view.id(), EventKind::Press, EventPayload::None);
    true
}

/// The Menu key or Shift+F10 ([`nsh_core::input::opens_context_menu`])
/// opens the context menu of what has the keyboard focus, with no
/// pointer, as a secondary click does: the focused view or the nearest
/// around it that listens to `onContextMenu` ([`crate::input::show_context_menu`]);
/// a focused text field shows its edit menu at its bottom-start corner
/// unless it listens itself.
/// True when handled.
pub(crate) fn context_menu(surface: &std::rc::Rc<Surface>, event: &KeyEvent) -> bool {
    if !opens_context_menu(event) {
        return false;
    }
    if let Some(view) = focused_in(surface, surface.input_root().id()) {
        return crate::input::show_context_menu(surface, &view);
    }
    let Some(field) = crate::text_input::focused(surface) else {
        return false;
    };
    if !crate::input::show_context_menu(surface, &field) {
        // At the field's bottom-start corner, where the app's menus open
        // without a pointer.
        let rtl = surface.mounter.try_borrow().is_ok_and(|m| m.rtl);
        let size = field.state().frame.size;
        let corner = nsh_core::input::context_menu_anchor(size, rtl);
        let at = field
            .to_root()
            .and_then(|m| m.map(corner.x.0, corner.y.0))
            .map(|at| in_main_window(surface, &field, at));
        crate::text_input::context_menu(surface, &field, at);
    }
    true
}

/// `at`, a point in the window `view` shows in (the window's points), in
/// the main window's points, where the platform's menus are placed from:
/// the app's own windows are top-level windows of their own.
fn in_main_window(surface: &Surface, view: &NshView, (x, y): (f32, f32)) -> (f32, f32) {
    use windows::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{ClientToScreen, ScreenToClient},
    };
    let window = crate::app_window::hwnd_showing(surface, view);
    let main = surface.hwnd();
    if window == main {
        return (x, y);
    }
    let scale = surface.scale();
    let mut p = POINT {
        x: (x * scale).round() as i32,
        y: (y * scale).round() as i32,
    };
    // SAFETY: plain coordinate queries on windows of this thread, with a
    // local point.
    unsafe {
        let _ = ClientToScreen(window, &mut p);
        let _ = ScreenToClient(main, &mut p);
    }
    (p.x as f32 / scale, p.y as f32 / scale)
}

/// Whether key down `event` asks for a context menu: the Menu key
/// (`VK_APPS`) or Shift+F10.
fn opens_context_menu(event: &KeyEvent) -> bool {
    use nsh_core::keymap::{Key, Modifiers};
    // Held down, the key opens the menu once.
    if !event.down || event.repeat {
        return false;
    }
    let m = event.modifiers;
    let held = Modifiers {
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        cmd: m.meta,
    };
    let function = (event.vk == 0x79).then_some(Key::F(10));
    nsh_core::input::opens_context_menu(event.vk == crate::input::VK_APPS, function, held)
}

/// A key up: the focused custom view hears it (whichever view has the
/// focus now), with the capture rule that matches the release.
pub(crate) fn release(surface: &std::rc::Rc<Surface>, event: &KeyEvent) {
    let window = surface.input_root().id();
    let Some(view) = key_target(surface, window) else {
        return;
    };
    if !listens(surface, &view) {
        return;
    }
    // A dialog over the app owns the keyboard: the view under it hears
    // neither the presses nor their releases.
    if crate::system::dialog_shown(surface) {
        return;
    }
    let stroke = capture_keystroke(event);
    let captured = captures(surface, &view, stroke.as_ref());
    let key = core_event(event, false, captured);
    surface.event(view.id(), EventKind::KeyUp, EventPayload::Key(key));
}

/// A key down that a mounted capture consumes must not be translated into
/// characters: this changes such a message to
/// [`crate::window::WM_NSH_KEYDOWN`] / [`crate::window::WM_NSH_SYSKEYDOWN`],
/// which `TranslateMessage` ignores, and the window procedure handles as
/// the key down it was.
///
/// The thread's `WH_GETMESSAGE` hook runs this before the caller's
/// `TranslateMessage` (the standalone loop calls it too), so a captured key
/// never queues a `WM_CHAR` / `WM_SYSCHAR`: nothing of the queue is
/// inspected, moved or restamped, and a character queued around the key
/// keeps its place. A key no mounted capture takes is left alone and
/// translates as usual.
pub(crate) fn suppress_translation(msg: &mut MSG) -> bool {
    let sys = msg.message == WM_SYSKEYDOWN;
    if !sys && msg.message != WM_KEYDOWN {
        return false;
    }
    let Some(surface) = crate::window::surface_of(msg.hwnd) else {
        return false;
    };
    let bits = msg.lParam.0 as usize;
    let event = KeyEvent {
        vk: msg.wParam.0 as u16,
        down: true,
        repeat: (bits >> 30) & 1 == 1,
        modifiers: crate::window::modifiers(),
        scan: ((bits >> 16) & 0xFF) as u16,
        extended: (bits >> 24) & 1 == 1,
        sys,
        translated: false,
    };
    let window = crate::window::app_window_root(msg.hwnd).unwrap_or(nsh_core::ROOT_ID);
    if !captured_now(&surface, window, &event) {
        return false;
    }
    msg.message = if sys {
        crate::window::WM_NSH_SYSKEYDOWN
    } else {
        crate::window::WM_NSH_KEYDOWN
    };
    true
}

/// Whether the key down on window `window`'s focused custom view is
/// consumed by a mounted capture rule: the decision [`press`] makes when
/// the message is dispatched.
fn captured_now(surface: &Surface, window: NodeId, event: &KeyEvent) -> bool {
    let Some(view) = key_target(surface, window) else {
        return false;
    };
    if !listens(surface, &view) {
        return false;
    }
    let stroke = capture_keystroke(event);
    captures(surface, &view, stroke.as_ref())
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        EventMask, MountItem, ROOT_ID, ViewProps,
        keymap::{Keystroke, Modifiers as CoreModifiers},
    };

    use super::*;
    use crate::{geom::rect, input::Modifiers};

    fn apply(surface: &std::rc::Rc<Surface>, items: &[MountItem]) {
        for item in items {
            surface.mounter.borrow_mut().apply(surface, item);
        }
    }

    fn surface() -> std::rc::Rc<Surface> {
        let surface = Surface::new(nsh_core::platform::Environment::default());
        surface.root.state_mut().frame = rect(0.0, 0.0, 400.0, 400.0);
        surface
    }

    /// A focusable view `id` under the root.
    fn focusable(surface: &std::rc::Rc<Surface>, id: NodeId) -> NshView {
        apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                },
                MountItem::Frame {
                    id,
                    frame: rect(0.0, 0.0, 100.0, 40.0),
                },
            ],
        );
        let view = surface.view(id).expect("the view");
        let mut props: ViewProps = (*view.state().props).clone();
        props.focusable = Some(true);
        apply(
            surface,
            &[MountItem::ViewProps {
                id,
                props: Box::new(props),
            }],
        );
        view
    }

    fn key(vk: u16) -> KeyEvent {
        KeyEvent::synthetic(vk, true, false, Modifiers::default())
    }

    fn stroke(text: &str) -> Keystroke {
        Keystroke::parse_with(text, false).expect(text)
    }

    #[test]
    fn the_menu_key_and_shift_f10_open_a_context_menu() {
        let with = |vk: u16, modifiers: Modifiers| KeyEvent {
            modifiers,
            ..key(vk)
        };
        let shift = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        assert!(opens_context_menu(&key(0x5D)));
        assert!(opens_context_menu(&with(0x5D, shift)));
        assert!(opens_context_menu(&with(0x79, shift)));
        // F10 alone is the menu bar's; Control or Alt make another shortcut.
        assert!(!opens_context_menu(&key(0x79)));
        let ctrl_shift = Modifiers {
            ctrl: true,
            ..shift
        };
        assert!(!opens_context_menu(&with(0x79, ctrl_shift)));
        let up = KeyEvent {
            down: false,
            ..key(0x5D)
        };
        assert!(!opens_context_menu(&up));
        let repeat = KeyEvent {
            repeat: true,
            ..key(0x5D)
        };
        assert!(!opens_context_menu(&repeat));
    }

    #[test]
    fn named_keys_follow_dom_spellings() {
        for (vk, name) in [
            (0x0D, "Enter"),
            (0x09, "Tab"),
            (0x08, "Backspace"),
            (0x1B, "Escape"),
            (0x20, " "),
            (0x2E, "Delete"),
            (0x25, "ArrowLeft"),
            (0x26, "ArrowUp"),
            (0x27, "ArrowRight"),
            (0x28, "ArrowDown"),
            (0x24, "Home"),
            (0x23, "End"),
            (0x21, "PageUp"),
            (0x22, "PageDown"),
            (0x10, "Shift"),
            (0x11, "Control"),
            (0x12, "Alt"),
            (0x5B, "Meta"),
            (0xB3, "MediaPlayPause"),
            (0xFA, "MediaPlay"),
            (0x70, "F1"),
            (0x74, "F5"),
            (0x87, "F24"),
        ] {
            assert_eq!(key_name(&key(vk)).as_str(), name, "{vk:#x}");
        }
        // A key the system means to a text service has no name of its own.
        assert_eq!(key_name(&key(0xE5)).as_str(), "Unidentified");
    }

    #[test]
    fn the_code_is_the_scan_codes_place_on_any_layout() {
        let with = |vk: u16, scan: u16, extended: bool| {
            let mut event = key(vk);
            event.scan = scan;
            event.extended = extended;
            event
        };
        // The physical key, not the layout's character: the A key's scan
        // is KeyA whatever virtual key the layout gives it.
        assert_eq!(dom_code(&with(0x41, 0x1E, false)), "KeyA");
        assert_eq!(dom_code(&with(0x51, 0x1E, false)), "KeyA");
        // Scan codes name the physical key: Numpad4 and ArrowLeft differ
        // only by the extended bit.
        assert_eq!(dom_code(&with(0x25, 0x4B, true)), "ArrowLeft");
        assert_eq!(dom_code(&with(0x64, 0x4B, false)), "Numpad4");
        // The keypad's enter is not the main Enter.
        assert_eq!(dom_code(&with(0x0D, 0x1C, false)), "Enter");
        assert_eq!(dom_code(&with(0x0D, 0x1C, true)), "NumpadEnter");
        // Both sides of each modifier have their own code.
        for (vk, scan, extended, code) in [
            (0x10, 0x2A, false, "ShiftLeft"),
            (0x10, 0x36, false, "ShiftRight"),
            (0x11, 0x1D, false, "ControlLeft"),
            (0x11, 0x1D, true, "ControlRight"),
            (0x12, 0x38, false, "AltLeft"),
            (0x12, 0x38, true, "AltRight"),
            (0x5B, 0x5B, true, "MetaLeft"),
            (0x5C, 0x5C, true, "MetaRight"),
        ] {
            assert_eq!(dom_code(&with(vk, scan, extended)), code, "{scan:#x}");
        }
        // Punctuation is the key's place too.
        assert_eq!(dom_code(&with(0xBA, 0x27, false)), "Semicolon");
        assert_eq!(dom_code(&with(0xBF, 0x35, false)), "Slash");
        // Input injected as text carries no scan code: no code is invented.
        assert_eq!(dom_code(&with(0x41, 0, false)), "");
        // A scan code with no DOM code reports the empty string.
        assert_eq!(dom_code(&with(0x41, 0xFC, false)), "");
    }

    #[test]
    fn capture_walks_enabled_ancestors_by_their_shortcuts() {
        let surface = surface();
        let outer = focusable(&surface, 2);
        let inner = focusable(&surface, 4);
        apply(
            &surface,
            &[MountItem::Insert {
                parent: 2,
                child: 4,
                before: None,
            }],
        );
        let escape = stroke("escape");
        assert!(!listens(&surface, &inner), "no listeners and no rules");
        let mut props = outer.state().props.clone();
        props.key_capture = nsh_core::KeyCapture::keys([escape]);
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        assert!(listens(&surface, &inner), "a capture rule is a raw path");
        let mut mask = EventMask::default();
        mask.set(EventKind::KeyDown, true);
        apply(
            &surface,
            &[MountItem::Events {
                id: 2,
                events: mask,
            }],
        );
        assert!(listens(&surface, &inner));
        assert!(captures(&surface, &inner, Some(&escape)));
        let enter = stroke("enter");
        assert!(!captures(&surface, &inner, Some(&enter)));
        // Only `All` takes a key no shortcut names.
        assert!(!captures(&surface, &inner, None));
        let mut props = outer.state().props.clone();
        props.key_capture = nsh_core::KeyCapture::All;
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        assert!(captures(&surface, &inner, None));
        // A disabled view captures nothing.
        let mut props = outer.state().props.clone();
        props.accessibility.state.disabled = true;
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        assert!(!captures(&surface, &inner, None));
    }

    #[test]
    fn the_capture_uses_the_keymaps_shortcut_key() {
        let mut event = key(0x41);
        assert_eq!(
            capture_keystroke(&event),
            Some(Keystroke {
                modifiers: CoreModifiers::default(),
                key: Key::Char('a'),
            })
        );
        event.modifiers.ctrl = true;
        assert_eq!(
            capture_keystroke(&event),
            Some(Keystroke {
                modifiers: CoreModifiers {
                    ctrl: true,
                    ..Default::default()
                },
                key: Key::Char('a'),
            })
        );
        // A modifier key has no shortcut.
        assert!(capture_keystroke(&key(0x10)).is_none());
    }

    #[test]
    fn a_capture_consumes_the_press_and_a_listener_cannot() {
        let surface = surface();
        let view = focusable(&surface, 2);
        let mut props = view.state().props.clone();
        props.key_capture = nsh_core::KeyCapture::All;
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        assert!(focus_control(&surface, &view));
        assert!(
            press(&surface, &key(0x41)),
            "a captured key is consumed before the defaults"
        );
        // Listening does not consume.
        let mut props = view.state().props.clone();
        props.key_capture = nsh_core::KeyCapture::None;
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        let mut mask = EventMask::default();
        mask.set(EventKind::KeyDown, true);
        apply(
            &surface,
            &[MountItem::Events {
                id: 2,
                events: mask,
            }],
        );
        assert!(listens(&surface, &view));
        assert!(!press(&surface, &key(0x41)));
    }

    /// The Menu key asks the focused view for its context menu when it
    /// listens; the window then answers the key's own `WM_CONTEXTMENU`,
    /// once, rather than handing it on.
    #[test]
    fn the_menu_key_opens_the_focused_views_context_menu() {
        let surface = surface();
        let view = focusable(&surface, 2);
        assert!(focus_control(&surface, &view));
        let menu = key(crate::input::VK_APPS);
        // Nothing listens: the key goes on, and so does its request.
        assert!(!context_menu(&surface, &menu));
        assert!(!crate::input::key(&surface, menu));
        assert!(!crate::input::keyboard_context_menu_opened(&surface));
        let mut mask = EventMask::default();
        mask.set(EventKind::ContextMenu, true);
        apply(
            &surface,
            &[MountItem::Events {
                id: 2,
                events: mask,
            }],
        );
        assert!(crate::input::key(&surface, menu));
        assert!(crate::input::keyboard_context_menu_opened(&surface));
        assert!(
            !crate::input::keyboard_context_menu_opened(&surface),
            "only the request of the key that opened it"
        );
        // Another key in between: a later request is not NSH's.
        assert!(crate::input::key(&surface, menu));
        crate::input::key(&surface, key(0x41));
        assert!(!crate::input::keyboard_context_menu_opened(&surface));
    }

    #[test]
    fn return_and_space_press_the_focused_control() {
        let surface = surface();
        let view = focusable(&surface, 2);
        assert!(focus_control(&surface, &view));
        // A focusable view that takes no presses is not pressed.
        assert!(!activate(&surface, &key(0x0D)));
        let mut mask = EventMask::default();
        mask.set(EventKind::Press, true);
        apply(
            &surface,
            &[MountItem::Events {
                id: 2,
                events: mask,
            }],
        );
        assert!(focused_control(&surface).is_some());
        assert!(activate(&surface, &key(0x0D)), "Return");
        assert!(activate(&surface, &key(0x20)), "Space");
        assert!(!activate(&surface, &key(0x41)), "another key");
        let mut ctrl = key(0x0D);
        ctrl.modifiers.ctrl = true;
        assert!(!activate(&surface, &ctrl), "a shortcut, not a press");
        let mut up = key(0x0D);
        up.down = false;
        assert!(!activate(&surface, &up), "the release presses nothing");
        let mut props = view.state().props.clone();
        props.accessibility.state.disabled = true;
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        assert!(!activate(&surface, &key(0x0D)), "a disabled control");
    }

    #[test]
    fn the_event_reports_the_transition() {
        let mut down = key(0x41);
        down.scan = 0x1E;
        down.repeat = true;
        let event = core_event(&down, true, true);
        assert!(event.default_prevented);
        assert_eq!(event.code, "KeyA");
        assert!(event.repeat, "the message's previous-key-state bit");
        let event = core_event(&down, false, false);
        assert!(!event.default_prevented);
        assert!(!event.repeat, "a release is never an auto-repeat");
        assert_eq!(event.code, "KeyA", "a release names the same physical key");
        // Control makes a shortcut, not another key.
        let mut ctrl = key(0x41);
        ctrl.scan = 0x1E;
        ctrl.modifiers.ctrl = true;
        let event = core_event(&ctrl, true, false);
        assert_eq!(event.code, "KeyA");
        assert!(!event.default_prevented);
    }

    /// A modal root `id`, presented without animation.
    fn modal(surface: &std::rc::Rc<Surface>, id: NodeId) -> NshView {
        use nsh_core::{ModalAnimation, ModalConfig};
        let view = NshView::new(id, ViewKind::Modal);
        view.state_mut().frame = rect(0.0, 0.0, 400.0, 400.0);
        crate::navigation::modal_config(
            surface,
            &view,
            &ModalConfig {
                animation: ModalAnimation::None,
                ..Default::default()
            },
        );
        view
    }

    /// A view `id` under `parent`.
    fn under(
        surface: &std::rc::Rc<Surface>,
        parent: NodeId,
        id: NodeId,
        focusable: bool,
    ) -> NshView {
        apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent,
                    child: id,
                    before: None,
                },
                MountItem::Frame {
                    id,
                    frame: rect(0.0, 0.0, 100.0, 40.0),
                },
            ],
        );
        let view = surface.view(id).expect("the view");
        let mut props: ViewProps = (*view.state().props).clone();
        props.focusable = focusable.then_some(true);
        apply(
            surface,
            &[MountItem::ViewProps {
                id,
                props: Box::new(props),
            }],
        );
        view
    }

    /// A view a native surface mounted at a root it does not logically live
    /// under (an `Overlay`, portaled by core) follows `key_parent` for its
    /// keyboard interest and capture: only its logical ancestors count, not
    /// the mounted parent or a sibling portal's views.
    #[test]
    fn a_portaled_views_keys_follow_its_logical_ancestors() {
        let surface = surface();
        // The logical ancestor, not the root, hears keys and captures one.
        let ancestor = under(&surface, ROOT_ID, 2, false);
        let mut mask = EventMask::default();
        mask.set(EventKind::KeyDown, true);
        apply(
            &surface,
            &[MountItem::Events {
                id: 2,
                events: mask,
            }],
        );
        let escape = stroke("escape");
        let mut props = ancestor.state().props.clone();
        props.key_capture = nsh_core::KeyCapture::keys([escape]);
        apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
        // The portal: mounted at the root, logically under the ancestor.
        let portal = under(&surface, ROOT_ID, 4, false);
        let mut props = portal.state().props.clone();
        props.key_parent = Some(2);
        apply(&surface, &[MountItem::ViewProps { id: 4, props }]);
        let child = under(&surface, 4, 6, true);
        assert_eq!(
            portal.parent_view().map(|view| view.id()),
            Some(ROOT_ID),
            "the mounted parent is the root, not the logical one"
        );
        assert!(focus_control(&surface, &child));
        assert!(
            listens(&surface, &child),
            "the logical ancestor's listener is heard"
        );
        assert!(
            captures(&surface, &child, Some(&escape)),
            "the logical ancestor captures"
        );
        assert!(press(&surface, &key(0x1B)));
        // The raw payload keeps the source's key and code (`""`: the
        // synthetic event has no scan code).
        let reported = core_event(&key(0x1B), true, true);
        assert_eq!(reported.key.as_str(), "Escape");
        assert_eq!(reported.code, "");
        assert!(reported.default_prevented);
        // An unrelated sibling portal has no such ancestor: nothing is
        // heard or captured, and a key there is not consumed.
        let sibling = under(&surface, ROOT_ID, 8, false);
        let other = under(&surface, 8, 10, true);
        assert!(sibling.parent_view().is_some());
        assert!(!listens(&surface, &other));
        assert!(!captures(&surface, &other, Some(&escape)));
        assert!(focus_control(&surface, &other));
        assert!(!press(&surface, &key(0x1B)));
    }

    #[test]
    fn a_modal_restores_the_custom_focus_it_took() {
        let surface = surface();
        let view = focusable(&surface, 2);
        assert!(focus_control(&surface, &view));
        let dialog = modal(&surface, 4);
        crate::navigation::present(&surface, &dialog);
        assert!(
            focused_in(&surface, ROOT_ID).is_none(),
            "the modal takes the keyboard from the view behind it"
        );
        crate::navigation::dismiss(&surface, &dialog);
        assert_eq!(
            focused_in(&surface, ROOT_ID).as_ref(),
            Some(&view),
            "closing the modal gives the focus back, as a field's"
        );
        // A view that is gone, disabled or no longer a stop restores
        // nothing.
        let dialog = modal(&surface, 6);
        crate::navigation::present(&surface, &dialog);
        let mut props: ViewProps = (*view.state().props).clone();
        props.accessibility.state.disabled = true;
        apply(
            &surface,
            &[MountItem::ViewProps {
                id: 2,
                props: Box::new(props),
            }],
        );
        crate::navigation::dismiss(&surface, &dialog);
        assert!(focused_in(&surface, ROOT_ID).is_none());
        let mut props: ViewProps = (*view.state().props).clone();
        props.accessibility.state.disabled = false;
        apply(
            &surface,
            &[MountItem::ViewProps {
                id: 2,
                props: Box::new(props),
            }],
        );
        assert!(focus_control(&surface, &view));
        let dialog = modal(&surface, 8);
        crate::navigation::present(&surface, &dialog);
        apply(&surface, &[MountItem::Delete { id: 2 }]);
        crate::navigation::dismiss(&surface, &dialog);
        assert!(focused_in(&surface, ROOT_ID).is_none());
    }

    #[test]
    fn keypad_keys_are_the_navigation_keys_with_num_lock_off() {
        for (vk, name) in [
            (0x60, "Insert"),
            (0x61, "End"),
            (0x62, "ArrowDown"),
            (0x63, "PageDown"),
            (0x64, "ArrowLeft"),
            (0x65, "Clear"),
            (0x66, "ArrowRight"),
            (0x67, "Home"),
            (0x68, "ArrowUp"),
            (0x69, "PageUp"),
            (0x6E, "Delete"),
        ] {
            assert_eq!(keypad_navigation(vk), Some(name), "{vk:#x}");
        }
        assert!(keypad_navigation(0x41).is_none());
    }

    /// AltGr (Windows reports it as Control+Alt) keeps the character the
    /// source translates, when it has one; a control character is not the
    /// key's name, so the key without Control/Alt is used.
    #[test]
    fn the_logical_key_prefers_the_sources_actual_character() {
        let mut event = key(0x41);
        event.scan = 0x1E;
        let mut state = [0u8; 256];
        // Control and Alt down, as AltGr is reported.
        state[0x11] = 0x80;
        state[0x12] = 0x80;
        // SAFETY: a full keyboard-state array for this thread.
        if unsafe { SetKeyboardState(&state) }.is_err() {
            // A thread that cannot set its key state has no AltGr state to
            // exercise here.
            return;
        }
        let actual = translated(&event, &actual_state());
        let base = translated(&event, &logical_state());
        let expected = actual
            .or(base)
            .or_else(|| mapped_char(event.vk).filter(|c| !c.is_control()));
        let reported = core_event(&event, true, false);
        match expected {
            Some(character) => {
                assert_eq!(reported.key.as_str(), character.to_string().as_str())
            }
            None => assert_eq!(reported.key.as_str(), "Unidentified"),
        }
        if let Some(character) = actual {
            assert_eq!(
                reported.key.as_str(),
                character.to_string().as_str(),
                "the source's actual character wins (AltGr)"
            );
        }
        let clear = [0u8; 256];
        // SAFETY: as above.
        let _ = unsafe { SetKeyboardState(&clear) };
    }

    /// `ToUnicodeEx` runs with its no-state-change flag: a dead key read
    /// for an event is not stored, so asking twice is still the dead key
    /// (a state-changing call would compose it with itself). The setup
    /// looks for a dead key on this layout; one without any checks nothing.
    /// An AltGr-layer-only dead key is covered by the same flag, though
    /// `MapVirtualKeyEx` cannot name it.
    #[test]
    fn translations_do_not_store_a_dead_key() {
        let Some(vk) = (0x20u16..=0xFF).find(|vk| dead_key(*vk)) else {
            return;
        };
        let event = key(vk);
        let state = actual_state();
        assert!(translated(&event, &state).is_none(), "{vk:#x} is dead");
        assert!(
            translated(&event, &state).is_none(),
            "{vk:#x} composed with itself: the dead key was stored"
        );
    }

    #[test]
    fn focus_and_tab_walk_the_focus_stops() {
        let surface = surface();
        let first = focusable(&surface, 2);
        let second = focusable(&surface, 4);
        assert!(focus_control(&surface, &first));
        assert_eq!(focused_in(&surface, ROOT_ID).as_ref(), Some(&first));
        assert!(!is_stop(&surface.root));
        // Tab moves to the next stop and Shift+Tab back.
        let tab = key(0x09);
        assert!(crate::input::tab(&surface, &tab));
        assert_eq!(focused_in(&surface, ROOT_ID).as_ref(), Some(&second));
        let back = KeyEvent {
            modifiers: Modifiers {
                shift: true,
                ..Default::default()
            },
            ..tab
        };
        assert!(crate::input::tab(&surface, &back));
        assert_eq!(focused_in(&surface, ROOT_ID).as_ref(), Some(&first));
        // A press on the top view focuses it.
        crate::input::pointer(
            &surface,
            crate::input::PointerEvent {
                kind: crate::input::PointerKind::Down,
                x: 10.0,
                y: 10.0,
                button: 0,
                buttons: 1,
                pointer: 1,
                touch: false,
                pen: false,
                time: 0.0,
                clicks: 1,
                modifiers: Modifiers::default(),
            },
        );
        assert_eq!(focused_in(&surface, ROOT_ID).as_ref(), Some(&second));
        // Removed: the focus goes with the view.
        apply(&surface, &[MountItem::Delete { id: 4 }]);
        assert!(focused_in(&surface, ROOT_ID).is_none());
    }
}
