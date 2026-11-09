//! The app's keyboard shortcuts (`nsh/keymap`): the table the engine
//! mounts ([`MountItem::Keymap`](nsh_core::MountItem::Keymap)), matched on
//! every key down the window gets ([`crate::input::key`]): after the dialogs
//! the surface shows, before the focused field, selectable text, navigation
//! and scroll views. A key that fires a binding is consumed (its `WM_CHAR`
//! too) and reported to JS with the root's `KeyCommand` event; JS runs the
//! handler afterwards.
//!
//! Keys are matched by virtual key code: letters and digits are the same
//! on every layout (a Cyrillic layout's keys have the US layout's codes),
//! punctuation by the US layout's `VK_OEM_*` keys.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, Keymap, Keystroke, Modifiers},
    platform::Os,
};
use windows::Win32::UI::{
    Input::KeyboardAndMouse::GetFocus,
    WindowsAndMessaging::{MSG, PM_REMOVE, PeekMessageW, WM_CHAR, WM_SYSCHAR},
};

use crate::{input::KeyEvent, surface::Surface};

/// A surface's table, while it has bindings.
#[derive(Default)]
pub(crate) struct KeymapState {
    table: RefCell<Option<Arc<Keymap>>>,
}

/// `MountItem::Keymap`: replaces the surface's table.
pub(crate) fn set(surface: &Surface, keymap: Arc<Keymap>) {
    *surface.keymap.table.borrow_mut() = (!keymap.is_empty()).then_some(keymap);
}

/// Drops the table (the app stopped).
pub(crate) fn clear(surface: &Surface) {
    surface.keymap.table.borrow_mut().take();
}

/// A key down: whether one of the bindings consumes it (it fired one, or,
/// held, repeats one). A binding passing the key through fires and leaves
/// it to the window.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    key_in_phase(surface, event, false)
}

pub(crate) fn fallback_key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    key_in_phase(surface, event, true)
}

fn key_in_phase(surface: &Rc<Surface>, event: &KeyEvent, fallback: bool) -> bool {
    let Some(table) = surface.keymap.table.borrow().clone() else {
        return false;
    };
    let Some(keystroke) = keystroke(event) else {
        return false;
    };
    // The dev host's Ctrl+R reloads, whatever the app binds.
    if cfg!(feature = "dev") && keystroke.reloads(Os::Windows) {
        return false;
    }
    if keystroke.key == Key::Escape && crate::text_input::composing_focused(surface) {
        return false;
    }
    let editing = crate::text_input::focused(surface).is_some();
    let path = surface.focus_path();
    let found = if fallback {
        table.find_fallback_with(keystroke, editing, event.repeat, |id| path.contains(&id))
    } else {
        table.find_with(keystroke, editing, event.repeat, |id| path.contains(&id))
    };
    if let Some(id) = found.fired() {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        );
        if keystroke.key != Key::Escape {
            crate::text_input::arm(surface);
        }
    }
    if found.consumed() {
        drop_char(surface);
    }
    found.consumed()
}

/// Removes the character `TranslateMessage` queued for the consumed key:
/// in the window that has the keyboard (the main one or a window of the
/// app's own; every window's keys go through the app's keymap).
pub(crate) fn drop_char(surface: &Surface) {
    // SAFETY: a plain query of this thread's focus.
    let focus = unsafe { GetFocus() };
    let hwnd = if focus.is_invalid() {
        surface.hwnd()
    } else {
        focus
    };
    let mut msg = MSG::default();
    for kind in [WM_CHAR, WM_SYSCHAR] {
        // SAFETY: a plain call with a local out value, for a window of
        // this thread.
        unsafe {
            let _ = PeekMessageW(&mut msg, Some(hwnd), kind, kind, PM_REMOVE);
        }
    }
}

/// The keystroke of a key down.
fn keystroke(event: &KeyEvent) -> Option<Keystroke> {
    let m = event.modifiers;
    let modifiers = Modifiers {
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        cmd: m.meta,
    };
    Some(Keystroke {
        modifiers,
        key: key_of(event.vk)?,
    })
}

/// The key of virtual key code `vk` (`VK_*`).
fn key_of(vk: u16) -> Option<Key> {
    Key::from_virtual_key(vk)
}

#[cfg(test)]
mod tests {
    use nsh_core::keymap::Key;

    #[test]
    fn virtual_keys() {
        assert_eq!(super::key_of(0x4B), Some(Key::Char('k')));
        assert_eq!(super::key_of(0x31), Some(Key::Char('1')));
        assert_eq!(super::key_of(0x74), Some(Key::F(5)));
        assert_eq!(super::key_of(0xBF), Some(Key::Char('/')));
        assert_eq!(super::key_of(0x10), None);
    }
}
