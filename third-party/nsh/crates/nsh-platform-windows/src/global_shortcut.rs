//! Global shortcuts (`DesktopCommand::RegisterGlobalShortcut`, `nsh/desktop`'s
//! `GlobalShortcut`): `RegisterHotKey` on the app's top-level window.
//!
//! - Windows takes a hot key from one app at a time: one another app holds,
//!   or the system keeps (Win+L, Ctrl+Alt+Delete), is refused, and the app
//!   hears `registered: false`.
//! - `MOD_NOREPEAT`: holding the keys down presses once, as a menu
//!   shortcut does.
//! - The hot key's id is this module's (0 to `0xBFFF`, what an app may use),
//!   mapped to the app's; a press arrives as `WM_HOTKEY` on the window that
//!   registered it ([`pressed`]) and is reported as the root's `Menu` event.
//! - A window's hot keys go with it ([`destroyed`]).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    desktop::{Key, Shortcut},
};
use windows::Win32::{
    Foundation::{HWND, WPARAM},
    UI::{
        Input::KeyboardAndMouse::{
            HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
            RegisterHotKey, UnregisterHotKey, VkKeyScanW,
        },
        WindowsAndMessaging::{GA_ROOT, GetAncestor},
    },
};

use crate::surface::Surface;

/// The largest hot key id an application may register.
const MAX_ID: i32 = 0xBFFF;

/// A hot key registered.
struct HotKey {
    /// The app's id, reported at each press.
    id: u32,
    /// The id Windows knows it by.
    hot_key: i32,
    /// The window it is registered on.
    hwnd: HWND,
    /// The surface its presses go to.
    surface: Weak<Surface>,
}

thread_local! {
    static HOT_KEYS: RefCell<Vec<HotKey>> = const { RefCell::new(Vec::new()) };
    static NEXT: Cell<i32> = const { Cell::new(1) };
}

/// Registers `shortcut` as the app's `id` on `surface`'s window and reports
/// whether Windows took it.
pub(crate) fn register(surface: &Rc<Surface>, id: u32, shortcut: &Shortcut) {
    // An id the app registers again replaces its earlier hot key.
    unregister(surface, id);
    let registered = match virtual_key(shortcut.key) {
        Some(vk) => add(surface, id, modifiers(shortcut), vk),
        None => {
            log::warn!("global shortcut: Windows has no key for {:?}", shortcut.key);
            false
        }
    };
    answer(surface, id, registered);
}

/// Tells the app whether its shortcut `id` is registered.
pub(crate) fn answer(surface: &Surface, id: u32, registered: bool) {
    surface.event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![
            ("id", PayloadValue::Number(f64::from(id))),
            ("registered", PayloadValue::Bool(registered)),
        ]),
    );
}

fn add(surface: &Rc<Surface>, id: u32, modifiers: HOT_KEY_MODIFIERS, vk: u16) -> bool {
    // SAFETY: a plain call.
    let hwnd = unsafe { GetAncestor(surface.hwnd(), GA_ROOT) };
    if hwnd.is_invalid() {
        return false;
    }
    let Some(hot_key) = next_id() else {
        log::warn!("global shortcut: no hot key id left");
        return false;
    };
    // SAFETY: a window of this thread.
    if let Err(err) = unsafe { RegisterHotKey(Some(hwnd), hot_key, modifiers, u32::from(vk)) } {
        log::info!("global shortcut: refused: {err}");
        return false;
    }
    HOT_KEYS.with(|h| {
        h.borrow_mut().push(HotKey {
            id,
            hot_key,
            hwnd,
            surface: Rc::downgrade(surface),
        })
    });
    true
}

/// An id no hot key has: ids are not reused while the app has a hot key with
/// one, so a press that was queued before an unregister cannot reach
/// another shortcut.
fn next_id() -> Option<i32> {
    let used =
        |candidate: i32| HOT_KEYS.with(|h| h.borrow().iter().any(|k| k.hot_key == candidate));
    for _ in 0..MAX_ID {
        let candidate = NEXT.get();
        NEXT.set(if candidate >= MAX_ID {
            1
        } else {
            candidate + 1
        });
        if !used(candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Gives back the hot key of the app's `id`.
pub(crate) fn unregister(surface: &Surface, id: u32) {
    let removed: Vec<HotKey> = HOT_KEYS.with(|h| {
        let mut keys = h.borrow_mut();
        let (removed, kept) = std::mem::take(&mut *keys)
            .into_iter()
            .partition(|k| k.id == id && std::ptr::eq(k.surface.as_ptr(), surface));
        *keys = kept;
        removed
    });
    release(removed);
}

/// `WM_HOTKEY` on `hwnd`: reports the press to the app.
pub(crate) fn pressed(hwnd: HWND, wparam: WPARAM) {
    let found = HOT_KEYS.with(|h| {
        h.borrow()
            .iter()
            .find(|k| k.hwnd == hwnd && k.hot_key as usize == wparam.0)
            .map(|k| (k.id, k.surface.clone()))
    });
    let Some((id, surface)) = found else { return };
    let Some(surface) = surface.upgrade() else {
        return;
    };
    surface.event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(id)))]),
    );
}

/// `hwnd` is being destroyed: its hot keys go.
pub(crate) fn destroyed(hwnd: HWND) {
    let removed: Vec<HotKey> = HOT_KEYS.with(|h| {
        let mut keys = h.borrow_mut();
        let (removed, kept) = std::mem::take(&mut *keys)
            .into_iter()
            .partition(|k| k.hwnd == hwnd);
        *keys = kept;
        removed
    });
    release(removed);
}

fn release(keys: Vec<HotKey>) {
    for key in keys {
        // SAFETY: a hot key this thread registered on a window of its own.
        let _ = unsafe { UnregisterHotKey(Some(key.hwnd), key.hot_key) };
    }
}

fn modifiers(shortcut: &Shortcut) -> HOT_KEY_MODIFIERS {
    let mut m = MOD_NOREPEAT;
    if shortcut.ctrl {
        m |= MOD_CONTROL;
    }
    if shortcut.alt {
        m |= MOD_ALT;
    }
    if shortcut.shift {
        m |= MOD_SHIFT;
    }
    if shortcut.meta {
        m |= MOD_WIN;
    }
    m
}

/// The virtual key of `key`. Letters and digits have fixed keys; other
/// characters are looked up in the keyboard layout, so `;` is the key that
/// types it there, then on the US layout, as menu shortcuts read keys.
fn virtual_key(key: Key) -> Option<u16> {
    if let Key::Char(c) = key {
        let upper = c.to_ascii_uppercase();
        if upper.is_ascii_alphanumeric() {
            return Some(upper as u16);
        }
        let mut units = [0u16; 2];
        if c.encode_utf16(&mut units).len() == 1 {
            // SAFETY: a plain call. The low byte is the key, the high one the
            // shift state that types the character; -1 when no key does.
            let scan = unsafe { VkKeyScanW(units[0]) };
            if scan != -1 && (scan >> 8) & 0xFF == 0 {
                return Some((scan & 0xFF) as u16);
            }
        }
    }
    (1..=0xFEu16).find(|&vk| crate::chrome::shortcut_key(vk) == Some(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_map_to_virtual_keys() {
        assert_eq!(virtual_key(Key::Char('k')), Some(0x4B));
        assert_eq!(virtual_key(Key::Char('7')), Some(0x37));
        assert_eq!(virtual_key(Key::Space), Some(0x20));
        assert_eq!(virtual_key(Key::F(5)), Some(0x74));
        assert_eq!(virtual_key(Key::Enter), Some(0x0D));
    }

    #[test]
    fn modifiers_never_repeat() {
        let shortcut = Shortcut {
            ctrl: true,
            alt: true,
            ..Shortcut::key(Key::Char('k'))
        };
        assert_eq!(modifiers(&shortcut), MOD_NOREPEAT | MOD_CONTROL | MOD_ALT);
    }
}
