//! The app's keyboard shortcuts (`nsh/keymap`): the table the engine
//! mounts ([`MountItem::Keymap`](nsh_core::MountItem::Keymap)) and a local
//! key monitor that matches every key against it on the spot.
//!
//! The monitor sees a key before AppKit dispatches it: before menus' key
//! equivalents (which is why the keystrokes of Quit, Hide, Minimize and
//! Full Screen cannot be bound: `Keystroke::reserved`; the dev host's
//! Cmd+R is left alone), before the field
//! editor's key bindings and before the root's own keys (going back,
//! scrolling). A key that fires a binding is consumed (no beep, nothing
//! typed) and reported to JS with the root's `KeyCommand` event; JS runs
//! the handler afterwards. Other keys go on as if there were no monitor.
//!
//! A surface takes the keys of its window while the keyboard focus is in
//! it (its root, one of its views, a field or hosted view inside it), or
//! nowhere (the window itself). A binding `within` a node fires while the
//! responder's chain of native views passes through it.
//!
//! Fallback bindings run after that dispatch instead ([`unhandled`]): when
//! the focused view's `keyDown:` leaves the key, or a text view's key
//! bindings resolve it to `noop:`, which does not say which key it was: the
//! monitor keeps the last one it saw ([`unhandled_key`]).

use std::{cell::RefCell, ptr::NonNull, rc::Rc, sync::Arc};

use block2::RcBlock;
use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, ROOT_ID,
    keymap::{Key, KeyMatch, Keymap, Keystroke, Modifiers},
    platform::Os,
};
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSEventModifierFlags, NSTextInputClient, NSTextView, NSView, NSWindow,
};

use crate::surface::Surface;

/// A surface's table and the monitor matching keys against it (while it
/// has bindings).
#[derive(Default)]
pub(crate) struct KeymapState {
    table: RefCell<Option<Arc<Keymap>>>,
    monitor: RefCell<Option<Retained<AnyObject>>>,
    key: RefCell<Option<Retained<NSEvent>>>,
}

impl KeymapState {
    fn remove_monitor(&self) {
        if let Some(monitor) = self.monitor.borrow_mut().take() {
            // SAFETY: a monitor `addLocalMonitorForEventsMatchingMask`
            // returned.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    }
}

impl Drop for KeymapState {
    fn drop(&mut self) {
        self.remove_monitor();
    }
}

/// `MountItem::Keymap`: replaces the surface's table.
pub(crate) fn set(surface: &Surface, keymap: Arc<Keymap>) {
    let state = &surface.keymap;
    if keymap.is_empty() {
        surface.keymap.table.borrow_mut().take();
        if !crate::text_input::is_armed(surface) {
            surface.keymap.remove_monitor();
        }
        return;
    }
    *state.table.borrow_mut() = Some(keymap);
    ensure_monitor(surface);
}

/// Ensures the surface's key-down monitor is installed so armed focus fences
/// see desktop keystrokes even before a keymap table is mounted.
pub(crate) fn ensure_monitor(surface: &Surface) {
    let state = &surface.keymap;
    if state.monitor.borrow().is_none() {
        let monitor = install(surface.key());
        *state.monitor.borrow_mut() = monitor;
    }
}

/// Removes the local key monitor once neither a keymap table nor an armed
/// focus fence needs it.
pub(crate) fn sync_monitor(surface: &Surface) {
    if surface.keymap.table.borrow().is_none() && !crate::text_input::is_armed(surface) {
        surface.keymap.remove_monitor();
    }
}

/// Drops the table (the app stopped).
pub(crate) fn clear(surface: &Surface) {
    surface.keymap.table.borrow_mut().take();
    surface.keymap.remove_monitor();
}

fn install(key: u64) -> Option<Retained<AnyObject>> {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event.
        let e = unsafe { event.as_ref() };
        match Surface::with_key(key) {
            Some(surface) if pressed(&surface, e) => std::ptr::null_mut(),
            _ => event.as_ptr(),
        }
    });
    // SAFETY: the block returns the event it got, or null (consumed); the
    // monitor is removed with the table.
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block) }
}

/// What the monitor does with key-down `event`, for a key given to a
/// window that is not the key window (`nsh test`'s, whose events the
/// monitor never sees): whether a binding consumed it (then the window
/// must not get it; a binding passing it through is reported and the
/// window gets it).
#[cfg(any(feature = "dev", feature = "terminal"))]
pub(crate) fn fires(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    fires_now(surface, event)
}

/// Whether key-down `event` is consumed by one of the surface's ordinary
/// bindings without re-checking the focus-settle fence.
pub(crate) fn fires_now(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    *surface.keymap.key.borrow_mut() = Some(event.into());
    matched(surface, event, false)
}

/// Whether key-down `event` was held by an unsettled focus fence or consumed
/// by one of the surface's ordinary bindings.
fn pressed(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    if crate::text_input::is_replaying(surface) {
        return false;
    }
    let Some(window) = event.window(surface.mtm) else {
        return false;
    };
    let Some(root) = crate::window::root_in(surface, &window) else {
        return false;
    };
    if editing(&root, &window).is_none() {
        return false;
    }
    crate::text_input::hold_nsevent(surface, event) || fires_now(surface, event)
}

/// Whether key-down `event`, which the focused view, field, selection and
/// navigation left unhandled, fired one of the surface's fallback bindings.
pub(crate) fn unhandled(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    matched(surface, event, true)
}

/// [`unhandled`] for the key being dispatched, for a text view's `noop:`.
pub(crate) fn unhandled_key(surface: &Rc<Surface>) -> bool {
    let key = surface.keymap.key.borrow().clone();
    key.is_some_and(|key| unhandled(surface, &key))
}

/// Whether key-down `event` fired a binding of its phase.
fn matched(surface: &Rc<Surface>, event: &NSEvent, fallback: bool) -> bool {
    let Some(table) = surface.keymap.table.borrow().clone() else {
        return false;
    };
    // The monitor sees the key before any view: the window it is in (the
    // main one or a window of the app's own) is the one picked in.
    let Some(window) = event.window(surface.mtm) else {
        return false;
    };
    let Some(root) = crate::window::root_in(surface, &window) else {
        return false;
    };
    // Before a binding acts: the focus it moves shows (`focus-visible:`).
    surface.control(|c| c.set_input_modality(nsh_core::platform::InputModality::Keyboard));
    let Some(editing) = editing(&root, &window) else {
        return false;
    };
    let own = root.ns() != surface.root.ns();
    let window_root = root.id();
    if crate::window::blocked(surface, own.then_some(&root)) {
        return false;
    }
    crate::input::enter(surface, own.then_some(root));
    if composing(&window) {
        return false;
    }
    // Return and Space on a focused control fire only the focus' own
    // bindings; else the control takes them (`input::key`).
    let control = crate::input::control_activation_target(surface, event).is_some();
    let Some(keystroke) = keystroke(event) else {
        return false;
    };
    // The dev host's Cmd+R reloads, whatever the app binds.
    if cfg!(feature = "dev") && keystroke.reloads(Os::MacOs) {
        return false;
    }
    if keystroke.key == Key::Escape && crate::text_input::composing_focused(surface) {
        return false;
    }
    let ctrl_for_command = surface.environment.get().ctrl_for_command;
    if !fallback && editing && crate::text::can_copy(surface) {
        let field_selected = window.firstResponder().is_some_and(|r| {
            r.downcast_ref::<NSTextView>()
                .is_some_and(|v| v.selectedRange().length > 0)
        });
        if !field_selected {
            let m = keystroke.modifiers;
            let is_copy = keystroke.key == Key::Char('c')
                && !m.alt
                && !m.shift
                && ((m.cmd && !m.ctrl) || (ctrl_for_command && m.ctrl && !m.cmd));
            if is_copy {
                return crate::text::copy(surface);
            }
            if keystroke.key == Key::Escape && m == Modifiers::default() {
                crate::text::clear(surface);
                return true;
            }
            crate::text::clear(surface);
        }
    }
    let path = crate::input::focus_path(surface);
    let found = match_table(
        &table,
        window_root,
        keystroke,
        editing,
        control,
        event.isARepeat(),
        fallback,
        ctrl_for_command,
        |id| path.contains(&id),
    );
    if let Some(id) = found.fired() {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        );
        if keystroke.key != Key::Escape && found.consumed() {
            crate::text_input::arm(surface);
        }
    }
    found.consumed()
}

/// Whether an input method is composing in the focused text view (it has
/// marked text: pinyin, kana). Every key is then the input method's:
/// Backspace deletes a letter of the composition, Return and Space
/// commit it, arrows move through its candidates. A binding taking one
/// first would leave the composition stuck.
fn composing(window: &NSWindow) -> bool {
    window
        .firstResponder()
        .and_then(|r| r.downcast::<NSTextView>().ok())
        .is_some_and(|t| t.hasMarkedText())
}

/// Where the keyboard focus is: `Some(true)` in a text input or hosted
/// view of the surface (an AppKit view of its own), `Some(false)` on one
/// of nsh's views or nowhere, `None` in another surface's views.
fn editing(root: &crate::view::NshView, window: &NSWindow) -> Option<bool> {
    let Some(responder) = window.firstResponder() else {
        return Some(false);
    };
    // The window itself: nothing has the focus.
    let Some(view) = responder.downcast_ref::<NSView>() else {
        return Some(false);
    };
    if !view.isDescendantOf(root.ns()) {
        return None;
    }
    Some(!crate::view::is_ours(view))
}

/// The keystroke of `event`, by its key on the US layout.
pub(crate) fn keystroke(event: &NSEvent) -> Option<Keystroke> {
    let flags = event.modifierFlags();
    let modifiers = Modifiers {
        ctrl: flags.contains(NSEventModifierFlags::Control),
        alt: flags.contains(NSEventModifierFlags::Option),
        shift: flags.contains(NSEventModifierFlags::Shift),
        cmd: flags.contains(NSEventModifierFlags::Command),
    };
    // The virtual key codes (`kVK_*`) of keys that type no character.
    let code = event.keyCode();
    let key = match code {
        53 => Key::Escape,
        36 | 76 => Key::Enter,
        48 => Key::Tab,
        49 => Key::Char(' '),
        51 => Key::Backspace,
        117 => Key::Delete,
        // Help, where PC keyboards have Insert.
        114 => Key::Insert,
        123 => Key::Left,
        124 => Key::Right,
        125 => Key::Down,
        126 => Key::Up,
        115 => Key::Home,
        119 => Key::End,
        116 => Key::PageUp,
        121 => Key::PageDown,
        _ => match function_key(code) {
            Some(n) => Key::F(n),
            None => Key::Char(character(event, modifiers.shift)?),
        },
    };
    Some(Keystroke { modifiers, key })
}

/// The character `event`'s key types without modifiers (Shift included:
/// Shift+/ is `shift+/`), in lower case; on a layout that types no ASCII
/// there, the US layout's character of the key, as menus match it.
fn character(event: &NSEvent, shift: bool) -> Option<char> {
    let typed = if shift {
        event.charactersByApplyingModifiers(NSEventModifierFlags::empty())
    } else {
        event.charactersIgnoringModifiers()
    };
    match typed.and_then(|s| s.to_string().chars().next()) {
        Some(c) if c.is_ascii_graphic() => Some(c.to_ascii_lowercase()),
        _ => crate::input::us_key(event.keyCode()),
    }
}

/// The virtual key codes of F1 to F20.
const FUNCTION_KEYS: [u16; 20] = [
    122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
];

/// F1 to F20, by virtual key code.
pub(crate) fn function_key(code: u16) -> Option<u8> {
    FUNCTION_KEYS
        .iter()
        .position(|&k| k == code)
        .map(|i| i as u8 + 1)
}

/// The virtual key code of F`n` (macOS's keyboards end at F20).
pub(crate) fn function_key_code(n: u8) -> Option<u16> {
    FUNCTION_KEYS.get(usize::from(n).checked_sub(1)?).copied()
}

/// Matches `keystroke` against `table`, falling back from `Ctrl` to `Cmd` on
/// terminal surfaces where `ctrl_for_command` stands in for Apple's Command.
fn match_table(
    table: &Keymap,
    window: NodeId,
    keystroke: Keystroke,
    editing: bool,
    control: bool,
    repeat: bool,
    fallback: bool,
    ctrl_for_command: bool,
    within: impl Fn(NodeId) -> bool,
) -> KeyMatch {
    let find = |stroke| {
        if fallback {
            table.find_fallback_at_with(window, stroke, editing, control, repeat, &within)
        } else {
            table.find_at_with(window, stroke, editing, control, repeat, &within)
        }
    };
    let mut found = find(keystroke);
    if matches!(found, KeyMatch::None)
        && ctrl_for_command
        && keystroke.modifiers.ctrl
        && !keystroke.modifiers.cmd
    {
        let mut command = keystroke;
        command.modifiers.ctrl = false;
        command.modifiers.cmd = true;
        found = find(command);
    }
    found
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        keymap::{KeyBinding, KeyMatch, Keymap, Keystroke, When},
        platform::Os,
    };

    #[test]
    fn function_keys() {
        assert_eq!(super::function_key(122), Some(1));
        assert_eq!(super::function_key(96), Some(5));
        assert_eq!(super::function_key(90), Some(20));
        assert_eq!(super::function_key(0), None);
        assert_eq!(super::function_key_code(1), Some(122));
        assert_eq!(super::function_key_code(20), Some(90));
        assert_eq!(super::function_key_code(0), None);
        assert_eq!(super::function_key_code(21), None);
    }

    #[test]
    fn ctrl_for_command_falls_back_to_command_after_explicit_ctrl_bindings() {
        let parse = |text| Keystroke::parse(text, Os::MacOs).unwrap();
        let table = Keymap::new(vec![
            KeyBinding::new(1, parse("mod+u"), When::Always, false),
            KeyBinding::new(2, parse("ctrl+c"), When::Always, false),
            KeyBinding::new(3, parse("mod+c"), When::Always, false),
            KeyBinding::new(4, parse("mod+s"), When::Always, false),
        ]);
        assert_eq!(
            super::match_table(
                &table,
                nsh_core::ROOT_ID,
                parse("ctrl+u"),
                true,
                false,
                false,
                false,
                false,
                |_| true
            ),
            KeyMatch::None
        );
        assert_eq!(
            super::match_table(
                &table,
                nsh_core::ROOT_ID,
                parse("ctrl+u"),
                true,
                false,
                false,
                false,
                true,
                |_| true
            ),
            KeyMatch::Fire(1)
        );
        assert_eq!(
            super::match_table(
                &table,
                nsh_core::ROOT_ID,
                parse("ctrl+c"),
                true,
                false,
                false,
                false,
                true,
                |_| true
            ),
            KeyMatch::Fire(2)
        );
        assert_eq!(
            super::match_table(
                &table,
                nsh_core::ROOT_ID,
                parse("ctrl+cmd+s"),
                true,
                false,
                false,
                false,
                true,
                |_| true
            ),
            KeyMatch::None
        );
    }

    #[test]
    fn ctrl_for_command_respects_window_and_fallback_scope() {
        let parse = |text| Keystroke::parse(text, Os::MacOs).unwrap();
        let table = Keymap::new(vec![KeyBinding {
            window: Some(7),
            within: Some(8),
            fallback: true,
            ..KeyBinding::new(1, parse("mod+s"), When::Always, false)
        }]);
        let match_in = |window, fallback, focused| {
            super::match_table(
                &table,
                window,
                parse("ctrl+s"),
                true,
                false,
                false,
                fallback,
                true,
                |id| id == focused,
            )
        };
        assert_eq!(match_in(7, true, 8), KeyMatch::Fire(1));
        assert_eq!(match_in(9, true, 8), KeyMatch::None);
        assert_eq!(match_in(7, true, 9), KeyMatch::None);
        assert_eq!(match_in(7, false, 8), KeyMatch::None);
    }

    #[test]
    fn activation_keys_prefer_the_focused_controls_binding_in_both_phases() {
        for key in ["enter", "space"] {
            let key = Keystroke::parse(key, Os::MacOs).unwrap();
            for fallback in [false, true] {
                let table = Keymap::new(vec![
                    KeyBinding {
                        fallback,
                        ..KeyBinding::new(1, key, When::Always, false)
                    },
                    KeyBinding {
                        window: Some(7),
                        within: Some(8),
                        for_focus: true,
                        fallback,
                        ..KeyBinding::new(2, key, When::Always, false)
                    },
                ]);
                let match_at = |control, focused| {
                    super::match_table(
                        &table,
                        7,
                        key,
                        false,
                        control,
                        false,
                        fallback,
                        false,
                        |id| id == focused,
                    )
                };
                assert_eq!(match_at(true, 8), KeyMatch::Fire(2));
                assert_eq!(match_at(true, 9), KeyMatch::None);
                assert_eq!(match_at(false, 9), KeyMatch::Fire(1));
            }
        }
    }
}
