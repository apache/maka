//! Global shortcuts on macOS (`DesktopCommand::RegisterGlobalShortcut`,
//! `nsh/desktop`'s `GlobalShortcut`): Carbon's hot keys, which AppKit has no
//! counterpart of and which need no permission from the user, unlike an event
//! tap or a global key monitor.
//!
//! - A hot key names a virtual key code. A character's is the key typing it on
//!   the keyboard layout at registration (the nearest ASCII one when the
//!   current layout types none, as with Russian or an input method), so a
//!   letter stays that letter on Dvorak; the US layout's when none types it.
//! - A hot key another app holds is refused (`kEventHotKeyExclusive`).
//! - The shortcuts go with the app that registered them.

use std::{
    cell::{Cell, RefCell},
    ffi::{c_uint, c_void},
    ptr,
};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    desktop::{Key, Shortcut},
};
use objc2_core_foundation::{CFData, CFRetained, CFString, CFType};

use crate::surface::Surface;

type OsStatus = i32;
type EventRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHandlerCallRef = *mut c_void;
type EventHotKeyRef = *mut c_void;
type EventHandler = unsafe extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OsStatus;

/// A four-character code, as Carbon's constants are.
const fn code(name: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*name)
}

const EVENT_CLASS_KEYBOARD: u32 = code(b"keyb");
const EVENT_HOT_KEY_PRESSED: u32 = 5;
const EVENT_PARAM_DIRECT_OBJECT: u32 = code(b"----");
const TYPE_EVENT_HOT_KEY_ID: u32 = code(b"hkid");
const EVENT_HOT_KEY_EXCLUSIVE: u32 = 1;
const EVENT_NOT_HANDLED: OsStatus = -9874;
/// The signature of the hot keys' ids.
const SIGNATURE: u32 = code(b"NSHk");

const CMD_KEY: u32 = 1 << 8;
const SHIFT_KEY: u32 = 1 << 9;
const OPTION_KEY: u32 = 1 << 11;
const CONTROL_KEY: u32 = 1 << 12;

#[repr(C)]
#[derive(Clone, Copy)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: EventHandler,
        count: usize,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        out: *mut EventHandlerRef,
    ) -> OsStatus;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyId,
        target: EventTargetRef,
        options: u32,
        out: *mut EventHotKeyRef,
    ) -> OsStatus;
    fn UnregisterEventHotKey(hot_key: EventHotKeyRef) -> OsStatus;
    fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> OsStatus;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> *mut CFType;
    fn TISGetInputSourceProperty(source: *const CFType, key: &CFString) -> *const CFData;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const c_void,
        key_code: u16,
        action: u16,
        modifiers: u32,
        keyboard_type: u32,
        options: u32,
        dead_keys: *mut u32,
        max_length: usize,
        length: *mut usize,
        text: *mut u16,
    ) -> OsStatus;
    static kTISPropertyUnicodeKeyLayoutData: &'static CFString;
}

const UC_KEY_ACTION_DISPLAY: u16 = 3;
const UC_KEY_TRANSLATE_NO_DEAD_KEYS: u32 = 1;

/// A shortcut registered.
struct Global {
    /// The hot key's id.
    serial: u32,
    /// The surface whose app registered it.
    surface: u64,
    /// What the app knows it as.
    id: u32,
    hot_key: EventHotKeyRef,
}

impl Global {
    fn unregister(self) {
        // SAFETY: a hot key `RegisterEventHotKey` gave, unregistered once.
        let status = unsafe { UnregisterEventHotKey(self.hot_key) };
        if status != 0 {
            log::warn!("UnregisterEventHotKey: {status}");
        }
    }
}

thread_local! {
    static GLOBALS: RefCell<Vec<Global>> = const { RefCell::new(Vec::new()) };
    static SERIAL: Cell<u32> = const { Cell::new(0) };
    /// The process's handler was installed.
    static HANDLER: Cell<bool> = const { Cell::new(false) };
}

/// A hot key was pressed, on the main thread.
unsafe extern "C" fn pressed(
    _call: EventHandlerCallRef,
    event: EventRef,
    _user_data: *mut c_void,
) -> OsStatus {
    let mut id = EventHotKeyId::default();
    // SAFETY: `id` is the parameter's type and size.
    let status = unsafe {
        GetEventParameter(
            event,
            EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOT_KEY_ID,
            ptr::null_mut(),
            size_of::<EventHotKeyId>(),
            ptr::null_mut(),
            (&raw mut id).cast(),
        )
    };
    if status != 0 {
        return status;
    }
    if id.signature != SIGNATURE {
        return EVENT_NOT_HANDLED;
    }
    let found = GLOBALS.with(|g| {
        g.borrow()
            .iter()
            .find(|g| g.serial == id.id)
            .map(|g| (g.surface, g.id))
    });
    if let Some((key, id)) = found
        && let Some(surface) = Surface::with_key(key)
    {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(id)))]),
        );
    }
    0
}

/// Installs the process's handler of hot keys, once; whether it is.
fn install_handler() -> bool {
    if HANDLER.get() {
        return true;
    }
    let types = EventTypeSpec {
        event_class: EVENT_CLASS_KEYBOARD,
        event_kind: EVENT_HOT_KEY_PRESSED,
    };
    // SAFETY: a function for the process's life, one type, no user data.
    let status = unsafe {
        InstallEventHandler(
            GetApplicationEventTarget(),
            pressed,
            1,
            &types,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if status != 0 {
        log::warn!("InstallEventHandler: {status}");
    }
    HANDLER.set(status == 0);
    status == 0
}

/// `DesktopCommand::RegisterGlobalShortcut`: answers whether the system took
/// it.
pub(crate) fn register(surface: &Surface, id: u32, shortcut: &Shortcut) {
    let registered = try_register(surface.key(), id, shortcut);
    surface.event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![
            ("id", PayloadValue::Number(f64::from(id))),
            ("registered", PayloadValue::Bool(registered)),
        ]),
    );
}

fn try_register(surface: u64, id: u32, shortcut: &Shortcut) -> bool {
    let Some(key_code) = key_code(shortcut.key) else {
        return false;
    };
    if !install_handler() {
        return false;
    }
    let serial = SERIAL.get() + 1;
    SERIAL.set(serial);
    let mut hot_key = ptr::null_mut();
    // SAFETY: the target is the application's; `hot_key` receives the ref.
    let status = unsafe {
        RegisterEventHotKey(
            u32::from(key_code),
            modifiers(shortcut),
            EventHotKeyId {
                signature: SIGNATURE,
                id: serial,
            },
            GetApplicationEventTarget(),
            EVENT_HOT_KEY_EXCLUSIVE,
            &mut hot_key,
        )
    };
    if status != 0 {
        log::info!("RegisterEventHotKey: {status}");
        return false;
    }
    GLOBALS.with(|g| {
        g.borrow_mut().push(Global {
            serial,
            surface,
            id,
            hot_key,
        });
    });
    true
}

/// `DesktopCommand::UnregisterGlobalShortcut`.
pub(crate) fn unregister(surface: &Surface, id: u32) {
    let key = surface.key();
    remove(|g| g.surface == key && g.id == id);
}

/// The app of the surface with `key` stopped: its shortcuts go with it.
pub(crate) fn release(key: u64) {
    remove(|g| g.surface == key);
}

fn remove(picks: impl Fn(&Global) -> bool) {
    // Surfaces can drop while the thread ends, after its locals.
    let _ = GLOBALS.try_with(|g| {
        let mut globals = g.borrow_mut();
        let (removed, kept) = std::mem::take(&mut *globals).into_iter().partition(picks);
        *globals = kept;
        let removed: Vec<Global> = removed;
        removed.into_iter().for_each(Global::unregister);
    });
}

/// Carbon's modifiers of `shortcut`.
fn modifiers(shortcut: &Shortcut) -> u32 {
    [
        (shortcut.meta, CMD_KEY),
        (shortcut.shift, SHIFT_KEY),
        (shortcut.alt, OPTION_KEY),
        (shortcut.ctrl, CONTROL_KEY),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .fold(0, |all, (_, flag)| all | flag)
}

/// The virtual key code (`kVK_*`) of `key`.
fn key_code(key: Key) -> Option<u16> {
    Some(match key {
        Key::Char(c) => return char_key_code(c),
        Key::Enter => 36,
        Key::Escape => 53,
        Key::Tab => 48,
        Key::Backspace => 51,
        Key::Delete => 117,
        // Help, where PC keyboards have Insert.
        Key::Insert => 114,
        Key::Space => 49,
        Key::Up => 126,
        Key::Down => 125,
        Key::Left => 123,
        Key::Right => 124,
        Key::Home => 115,
        Key::End => 119,
        Key::PageUp => 116,
        Key::PageDown => 121,
        Key::F(n) => return crate::keymap::function_key_code(n),
    })
}

/// The key typing `c` on the current layout, else on the US one.
fn char_key_code(c: char) -> Option<u16> {
    // SAFETY: a copy the rule's name says is ours, or null.
    let source = unsafe { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() };
    let on_layout = ptr::NonNull::new(source).and_then(|source| {
        // SAFETY: an owned input source.
        let source = unsafe { CFRetained::from_raw(source) };
        layout_key_code(&source, c)
    });
    on_layout.or_else(|| crate::input::us_key_code(c))
}

/// The key typing `c` (without modifiers) on `source`, an input source.
fn layout_key_code(source: &CFType, c: char) -> Option<u16> {
    // SAFETY: the key is the framework's constant; the data is the source's,
    // which outlives it here.
    let data =
        unsafe { TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData).as_ref() }?;
    let layout: *const c_void = data.byte_ptr().cast();
    // SAFETY: no arguments.
    let keyboard = c_uint::from(unsafe { LMGetKbdType() });
    (0..128).find(|&code| {
        let (mut dead, mut text, mut length) = (0, [0_u16; 4], 0);
        // SAFETY: `layout` is a `UCKeyboardLayout` (the property's type);
        // the buffer's length is given.
        let status = unsafe {
            UCKeyTranslate(
                layout,
                code,
                UC_KEY_ACTION_DISPLAY,
                0,
                keyboard,
                UC_KEY_TRANSLATE_NO_DEAD_KEYS,
                &mut dead,
                text.len(),
                &mut length,
                text.as_mut_ptr(),
            )
        };
        status == 0
            && char::decode_utf16(text[..length.min(text.len())].iter().copied())
                .next()
                .and_then(Result::ok)
                .is_some_and(|typed| typed.to_ascii_lowercase() == c)
    })
}

#[cfg(test)]
mod tests {
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSArray, NSDictionary, NSString};

    use super::*;

    #[test]
    fn modifiers_are_carbons() {
        let of = |text: &str| modifiers(&Shortcut::parse(text, true).unwrap());
        assert_eq!(of("f5"), 0);
        assert_eq!(of("cmd+k"), CMD_KEY);
        assert_eq!(of("ctrl+alt+k"), CONTROL_KEY | OPTION_KEY);
        assert_eq!(
            of("cmd+shift+alt+ctrl+k"),
            CMD_KEY | SHIFT_KEY | OPTION_KEY | CONTROL_KEY
        );
    }

    #[test]
    fn named_keys_have_their_codes() {
        assert_eq!(key_code(Key::Space), Some(49));
        assert_eq!(key_code(Key::Left), Some(123));
        assert_eq!(key_code(Key::F(1)), Some(122));
        // Past the keyboard's function keys.
        assert_eq!(key_code(Key::F(24)), None);
    }

    unsafe extern "C" {
        fn TISCreateInputSourceList(
            properties: *const c_void,
            include_all_installed: bool,
        ) -> *mut c_void;
        static kTISPropertyInputSourceID: &'static NSString;
    }

    /// The installed keyboard layout `id`, without selecting it.
    fn layout(id: &str) -> CFRetained<CFType> {
        // SAFETY: a dictionary of the property's key and a string (toll-free
        // bridged), and the list the rule's name says is ours.
        unsafe {
            let id = NSString::from_str(id);
            let filter = NSDictionary::from_slices(&[kTISPropertyInputSourceID], &[&*id]);
            let list = TISCreateInputSourceList(Retained::as_ptr(&filter).cast(), true);
            let list: Retained<NSArray<AnyObject>> =
                Retained::from_raw(list.cast()).expect("an input source list");
            let source = list.firstObject().expect("the layout is installed");
            CFRetained::retain(ptr::NonNull::from(&*source).cast())
        }
    }

    #[test]
    fn a_character_finds_its_key_on_the_layout() {
        assert_eq!(
            layout_key_code(&layout("com.apple.keylayout.US"), 'k'),
            Some(40)
        );
        // Where QWERTY has V.
        assert_eq!(
            layout_key_code(&layout("com.apple.keylayout.Dvorak"), 'k'),
            Some(9)
        );
        // Nothing types it: the caller falls back on the US layout.
        assert_eq!(
            layout_key_code(&layout("com.apple.keylayout.US"), '\u{e9}'),
            None
        );
        assert!(key_code(Key::Char('k')).is_some());
    }
}
