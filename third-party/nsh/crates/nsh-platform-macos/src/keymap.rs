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
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, KeyMatch, Keymap, Keystroke, Modifiers},
    platform::Os,
};
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSView, NSWindow};

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
        clear(surface);
        return;
    }
    *state.table.borrow_mut() = Some(keymap);
    if state.monitor.borrow().is_none() {
        let monitor = install(surface.key());
        *state.monitor.borrow_mut() = monitor;
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
/// monitor never sees): whether it fired a binding (then it is reported to
/// JS, and the window must not get it).
#[cfg(feature = "dev")]
pub(crate) fn fires(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    pressed(surface, event)
}

/// Whether key-down `event` fired one of the surface's ordinary bindings
/// (then it is reported to JS and consumed).
fn pressed(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    *surface.keymap.key.borrow_mut() = Some(event.into());
    crate::input::control_activation_target(surface, event).is_none()
        && matched(surface, event, false)
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
    let Some(window) = surface.root.ns().window() else {
        return false;
    };
    if event.window(surface.mtm).as_deref() != Some(&*window) {
        return false;
    }
    let Some(editing) = editing(surface, &window) else {
        return false;
    };
    let Some(keystroke) = keystroke(event) else {
        return false;
    };
    // The dev host's Cmd+R reloads, whatever the app binds.
    if cfg!(feature = "dev") && keystroke.reloads(Os::MacOs) {
        return false;
    }
    let path = crate::input::focus_path(surface);
    let within = |id| path.contains(&id);
    let repeat = event.isARepeat();
    let found = if fallback {
        table.find_fallback_with(keystroke, editing, repeat, within)
    } else {
        table.find_with(keystroke, editing, repeat, within)
    };
    if let KeyMatch::Fire(id) = found {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        );
    }
    found.consumed()
}

/// Where the keyboard focus is: `Some(true)` in a text input or hosted
/// view of the surface (an AppKit view of its own), `Some(false)` on one
/// of nsh's views or nowhere, `None` in another surface's views.
fn editing(surface: &Surface, window: &NSWindow) -> Option<bool> {
    let Some(responder) = window.firstResponder() else {
        return Some(false);
    };
    // The window itself: nothing has the focus.
    let Some(view) = responder.downcast_ref::<NSView>() else {
        return Some(false);
    };
    let root = surface.root.ns();
    if !view.isDescendantOf(root) {
        return None;
    }
    Some(!crate::view::is_ours(view))
}

/// The keystroke of `event`, by its key on the US layout.
fn keystroke(event: &NSEvent) -> Option<Keystroke> {
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

/// F1 to F20, by virtual key code.
fn function_key(code: u16) -> Option<u8> {
    const KEYS: [u16; 20] = [
        122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
    ];
    KEYS.iter().position(|&k| k == code).map(|i| i as u8 + 1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn function_keys() {
        assert_eq!(super::function_key(122), Some(1));
        assert_eq!(super::function_key(96), Some(5));
        assert_eq!(super::function_key(90), Some(20));
        assert_eq!(super::function_key(0), None);
    }
}
