//! Real key events for `nsh test --target linux` under X11 (Xvfb, Xorg,
//! Xwayland): the XTest extension makes the X server send the window key
//! presses and releases as a keyboard's, so GTK's whole key path runs on
//! them (its shortcut controllers, the focused widget's key bindings, the
//! input method), with the modifiers' state the server keeps.
//!
//! libX11 and libXtst are loaded when the agent first types (`dlopen`), and
//! GDK's X11 functions looked up in the GTK already loaded, so the crate
//! links no X11 libraries and runs where neither exists (Wayland, a build
//! without GDK's X11 backend): [`Xtest::with`] is `None` there, and the
//! agent keeps to the widgets' signals ([`crate::synth`]).
//!
//! Everything here runs on the GTK main thread, on GDK's own connection.

use std::{
    cell::{Cell, OnceCell},
    ffi::{CStr, c_char, c_int, c_uint, c_ulong, c_void},
};

use gtk4::{self as gtk, prelude::*};

type Display = c_void;
type KeySym = c_ulong;
type XWindow = c_ulong;

/// `RevertToParent`.
const REVERT_TO_PARENT: c_int = 2;
const RTLD_NOW: c_int = 2;

#[link(name = "dl")]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// The X functions the agent calls, resolved once.
pub(crate) struct Xtest {
    display: *mut Display,
    keysym_to_keycode: unsafe extern "C" fn(*mut Display, KeySym) -> u8,
    keycode_to_keysym: unsafe extern "C" fn(*mut Display, u8, c_int) -> KeySym,
    get_keyboard_mapping: unsafe extern "C" fn(*mut Display, u8, c_int, *mut c_int) -> *mut KeySym,
    change_keyboard_mapping:
        unsafe extern "C" fn(*mut Display, c_int, c_int, *const KeySym, c_int) -> c_int,
    display_keycodes: unsafe extern "C" fn(*mut Display, *mut c_int, *mut c_int) -> c_int,
    free: unsafe extern "C" fn(*mut c_void) -> c_int,
    set_input_focus: unsafe extern "C" fn(*mut Display, XWindow, c_int, c_ulong) -> c_int,
    get_input_focus: unsafe extern "C" fn(*mut Display, *mut XWindow, *mut c_int) -> c_int,
    sync: unsafe extern "C" fn(*mut Display, c_int) -> c_int,
    fake_key: unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int,
    query_keymap: unsafe extern "C" fn(*mut Display, *mut c_char) -> c_int,
    surface_xid: unsafe extern "C" fn(*mut c_void) -> XWindow,
    /// A keycode no key uses, for characters the layout has no key for.
    spare: Option<u8>,
    remapped: Cell<bool>,
}

thread_local! {
    static XTEST: OnceCell<Option<Xtest>> = const { OnceCell::new() };
}

/// A symbol from `lib` (or the process' own, with a null `lib`).
unsafe fn sym<T: Copy>(lib: *mut c_void, name: &CStr) -> Option<T> {
    // SAFETY: the caller names a function of type `T`.
    unsafe {
        let p = dlsym(lib, name.as_ptr());
        (!p.is_null()).then(|| std::mem::transmute_copy::<*mut c_void, T>(&p))
    }
}

fn open(name: &CStr) -> Option<*mut c_void> {
    // SAFETY: a plain dlopen; the library stays loaded.
    let lib = unsafe { dlopen(name.as_ptr(), RTLD_NOW) };
    (!lib.is_null()).then_some(lib)
}

impl Xtest {
    /// Runs `f` with the X functions when the default display is X11 and
    /// its server has XTest.
    pub(crate) fn with<R>(f: impl FnOnce(&Xtest) -> R) -> Option<R> {
        XTEST.with(|x| x.get_or_init(Xtest::load).as_ref().map(f))
    }

    fn load() -> Option<Xtest> {
        let display = gtk::gdk::Display::default()?;
        if display.type_().name() != "GdkX11Display" {
            return None;
        }
        let x11 = open(c"libX11.so.6")?;
        let xtst = open(c"libXtst.so.6")?;
        // SAFETY: the signatures are Xlib's, XTest's and GDK's X11 ones.
        unsafe {
            let get_xdisplay: unsafe extern "C" fn(*mut c_void) -> *mut Display =
                sym(std::ptr::null_mut(), c"gdk_x11_display_get_xdisplay")?;
            let display = get_xdisplay(display.as_ptr().cast());
            if display.is_null() {
                return None;
            }
            let query: unsafe extern "C" fn(
                *mut Display,
                *mut c_int,
                *mut c_int,
                *mut c_int,
                *mut c_int,
            ) -> c_int = sym(xtst, c"XTestQueryExtension")?;
            let (mut a, mut b, mut c, mut d) = (0, 0, 0, 0);
            if query(display, &mut a, &mut b, &mut c, &mut d) == 0 {
                log::warn!("test: the X server has no XTest; keys go to the widgets' signals");
                return None;
            }
            let mut x = Xtest {
                display,
                keysym_to_keycode: sym(x11, c"XKeysymToKeycode")?,
                keycode_to_keysym: sym(x11, c"XKeycodeToKeysym")?,
                get_keyboard_mapping: sym(x11, c"XGetKeyboardMapping")?,
                change_keyboard_mapping: sym(x11, c"XChangeKeyboardMapping")?,
                display_keycodes: sym(x11, c"XDisplayKeycodes")?,
                free: sym(x11, c"XFree")?,
                set_input_focus: sym(x11, c"XSetInputFocus")?,
                get_input_focus: sym(x11, c"XGetInputFocus")?,
                sync: sym(x11, c"XSync")?,
                fake_key: sym(xtst, c"XTestFakeKeyEvent")?,
                query_keymap: sym(x11, c"XQueryKeymap")?,
                surface_xid: sym(std::ptr::null_mut(), c"gdk_x11_surface_get_xid")?,
                spare: None,
                remapped: Cell::new(false),
            };
            x.spare = x.find_spare();
            // The X pointer to the screen's corner, off the window: Xvfb
            // starts it in the middle, where the window's views would get
            // its hover whenever a key comes (a list's highlight moved back
            // under it), while the agent's pointer is simulated.
            let root: unsafe extern "C" fn(*mut Display) -> XWindow =
                sym(x11, c"XDefaultRootWindow")?;
            let screen: unsafe extern "C" fn(*mut Display) -> c_int = sym(x11, c"XDefaultScreen")?;
            let width: unsafe extern "C" fn(*mut Display, c_int) -> c_int =
                sym(x11, c"XDisplayWidth")?;
            let height: unsafe extern "C" fn(*mut Display, c_int) -> c_int =
                sym(x11, c"XDisplayHeight")?;
            let warp: unsafe extern "C" fn(
                *mut Display,
                XWindow,
                XWindow,
                c_int,
                c_int,
                c_uint,
                c_uint,
                c_int,
                c_int,
            ) -> c_int = sym(x11, c"XWarpPointer")?;
            let n = screen(display);
            let (w, h) = (width(display, n), height(display, n));
            warp(display, 0, root(display), 0, 0, 0, 0, w - 1, h - 1);
            Some(x)
        }
    }

    /// The highest keycode without symbols.
    unsafe fn find_spare(&self) -> Option<u8> {
        // SAFETY: Xlib calls on GDK's display, on its thread.
        unsafe {
            let (mut min, mut max) = (0, 0);
            (self.display_keycodes)(self.display, &mut min, &mut max);
            let count = max - min + 1;
            let mut per = 0;
            let map = (self.get_keyboard_mapping)(self.display, min as u8, count, &mut per);
            if map.is_null() || per <= 0 {
                return None;
            }
            let spare = (0..count)
                .rev()
                .find(|&i| (0..per).all(|j| *map.add((i * per + j) as usize) == 0));
            (self.free)(map.cast());
            spare.map(|i| (min + i) as u8)
        }
    }

    /// Gives `window` the X input focus, as a click on it would, so the
    /// keys go to it; whether it did not have it.
    pub(crate) fn focus(&self, window: &gtk::Window) -> bool {
        let Some(surface) = window.surface() else {
            return false;
        };
        // SAFETY: GDK's X11 surface; Xlib calls on its display.
        unsafe {
            let xid = (self.surface_xid)(surface.as_ptr().cast());
            let (mut now, mut revert) = (0, 0);
            (self.get_input_focus)(self.display, &mut now, &mut revert);
            if now == xid {
                return false;
            }
            (self.set_input_focus)(self.display, xid, REVERT_TO_PARENT, 0);
            self.flush();
            true
        }
    }

    /// The key typing `keysym`, if the layout has one, and whether Shift
    /// has to be held for it (the symbol is the key's second level).
    fn keycode(&self, keysym: KeySym) -> Option<(u8, bool)> {
        // SAFETY: Xlib calls on GDK's display, on its thread.
        unsafe {
            let code = (self.keysym_to_keycode)(self.display, keysym);
            if code == 0 {
                return None;
            }
            if (self.keycode_to_keysym)(self.display, code, 0) == keysym {
                Some((code, false))
            } else if (self.keycode_to_keysym)(self.display, code, 1) == keysym {
                Some((code, true))
            } else {
                // XKeysymToKeycode searches every group and level. A key
                // needing AltGr or another group cannot be typed with
                // Shift alone; let stroke borrow its spare key instead.
                None
            }
        }
    }

    fn fake(&self, code: u8, down: bool) {
        // SAFETY: XTest on GDK's display, on its thread.
        unsafe {
            (self.fake_key)(self.display, c_uint::from(code), c_int::from(down), 0);
        }
    }

    /// Presses or releases the key `keysym` names (a modifier, for
    /// `holdKeys`); whether there is one.
    pub(crate) fn key(&self, keysym: KeySym, down: bool) -> bool {
        let Some((code, _)) = self.keycode(keysym) else {
            return false;
        };
        self.fake(code, down);
        self.flush();
        true
    }

    /// Types `keysym` as a keystroke: `modifiers` (keysyms) held, the key
    /// pressed and released, the modifiers released. A symbol the layout
    /// has no key for is put on a spare key for it, as `xdotool` does.
    /// Whether it was typed.
    pub(crate) fn stroke(&self, modifiers: &[KeySym], keysym: KeySym) -> bool {
        let (code, shift) = match self.keycode(keysym) {
            Some(k) => k,
            None => {
                let Some(spare) = self.spare else {
                    return false;
                };
                let syms = [keysym, keysym];
                // SAFETY: Xlib calls on GDK's display, on its thread.
                unsafe {
                    (self.change_keyboard_mapping)(
                        self.display,
                        c_int::from(spare),
                        2,
                        syms.as_ptr(),
                        1,
                    );
                }
                self.remapped.set(true);
                (spare, false)
            }
        };
        let mut held: Vec<u8> = modifiers
            .iter()
            .filter_map(|&m| self.keycode(m).map(|(c, _)| c))
            .collect();
        if shift && !modifiers.contains(&SHIFT_L) {
            held.extend(self.keycode(SHIFT_L).map(|(c, _)| c));
        }
        // A modifier held by keyboard.down (or the real keyboard) belongs
        // to that caller. Do not release it at the end of this stroke.
        let mut state = [0_u8; 32];
        // SAFETY: XQueryKeymap writes exactly 32 bytes, on GDK's thread.
        unsafe { (self.query_keymap)(self.display, state.as_mut_ptr().cast()) };
        held.retain(|&code| state[usize::from(code / 8)] & (1 << (code % 8)) == 0);
        for &m in &held {
            self.fake(m, true);
        }
        self.fake(code, true);
        self.fake(code, false);
        for &m in held.iter().rev() {
            self.fake(m, false);
        }
        self.flush();
        true
    }

    /// Restore the unused key after GTK has consumed its events. Restoring
    /// it before then would make GDK translate those events as NoSymbol.
    pub(crate) fn restore_mapping(&self) {
        if self.remapped.replace(false)
            && let Some(spare) = self.spare
        {
            let syms = [0, 0];
            // SAFETY: this key had no symbols before the agent borrowed it.
            unsafe {
                (self.change_keyboard_mapping)(
                    self.display,
                    c_int::from(spare),
                    2,
                    syms.as_ptr(),
                    1,
                );
            }
            self.flush();
        }
    }

    /// Waits for the server to have sent the events (they come back to GDK
    /// through its main loop source).
    fn flush(&self) {
        // SAFETY: Xlib call on GDK's display, on its thread.
        unsafe {
            (self.sync)(self.display, 0);
        }
    }
}

pub(crate) const SHIFT_L: KeySym = 0xffe1;
pub(crate) const CONTROL_L: KeySym = 0xffe3;
pub(crate) const ALT_L: KeySym = 0xffe9;
pub(crate) const SUPER_L: KeySym = 0xffeb;

/// The keysym typing `c`: Latin-1's are the code point, the rest Unicode's
/// (`0x0100_0000` + the code point); control characters their keys'.
pub(crate) fn char_keysym(c: char) -> KeySym {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        '\u{8}' => 0xff08,
        ' '..='~' | '\u{a0}'..='\u{ff}' => c as KeySym,
        c => 0x0100_0000 + c as KeySym,
    }
}

/// The keysym of a key of `nsh_core::keymap` (a `Char` is unshifted).
pub(crate) fn key_keysym(key: nsh_core::keymap::Key) -> KeySym {
    use nsh_core::keymap::Key as K;
    match key {
        K::Char(c) => char_keysym(c),
        K::Enter => 0xff0d,
        K::Escape => 0xff1b,
        K::Tab => 0xff09,
        K::Backspace => 0xff08,
        K::Delete => 0xffff,
        K::Insert => 0xff63,
        K::Up => 0xff52,
        K::Down => 0xff54,
        K::Left => 0xff51,
        K::Right => 0xff53,
        K::Home => 0xff50,
        K::End => 0xff57,
        K::PageUp => 0xff55,
        K::PageDown => 0xff56,
        K::F(n) => 0xffbe + KeySym::from(n.saturating_sub(1)),
    }
}

/// A modifier's keysym by its name in `holdKeys` / `pressKeys`.
pub(crate) fn modifier_keysym(name: &str) -> Option<KeySym> {
    Some(match name {
        "mod" | "ctrl" | "control" => CONTROL_L,
        "alt" | "option" => ALT_L,
        "shift" => SHIFT_L,
        "meta" | "cmd" | "command" | "super" => SUPER_L,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use super::*;
    use crate::gtk_test::{run, wait_until};

    #[test]
    fn real_keys_reach_gtk_shortcuts_editing_and_held_modifiers() {
        run(|| {
            if gtk::gdk::Display::default().unwrap().type_().name() != "GdkX11Display" {
                return;
            }
            Xtest::with(|x| {
                let field = gtk::Text::new();
                let window = gtk::Window::new();
                window.set_child(Some(&field));
                window.present();
                assert!(wait_until(|| window.is_mapped()));
                x.focus(&window);
                field.grab_focus_without_selecting();
                assert!(wait_until(|| window.is_active()));

                let fired = Rc::new(Cell::new(0));
                let count = fired.clone();
                let shortcuts = gtk::ShortcutController::new();
                shortcuts.set_propagation_phase(gtk::PropagationPhase::Capture);
                shortcuts.add_shortcut(gtk::Shortcut::new(
                    gtk::ShortcutTrigger::parse_string("<Control><Shift>k"),
                    Some(gtk::CallbackAction::new(move |_, _| {
                        count.set(count.get() + 1);
                        gtk::glib::Propagation::Stop
                    })),
                ));
                window.add_controller(shortcuts);

                for c in "abc".chars() {
                    assert!(x.stroke(&[], char_keysym(c)));
                    assert!(wait_until(|| field.text().ends_with(c)));
                }
                assert!(x.stroke(&[CONTROL_L, SHIFT_L], char_keysym('k')));
                assert!(wait_until(|| fired.get() == 1));
                assert_eq!(field.text(), "abc");
                assert!(x.stroke(&[CONTROL_L], char_keysym('a')));
                assert!(wait_until(|| field.selection_bounds() == Some((0, 3))));
                assert!(x.stroke(&[], char_keysym('x')));
                assert!(wait_until(|| field.text() == "x"));

                assert!(x.key(SHIFT_L, true));
                assert!(x.stroke(&[], char_keysym('B')));
                assert!(wait_until(|| field.text() == "xB"));
                assert!(x.stroke(&[], char_keysym('c')));
                let held = wait_until(|| field.text() == "xBC");
                x.key(SHIFT_L, false);
                assert!(held, "a stroke must leave keyboard.down modifiers held");
                assert!(x.stroke(&[], char_keysym('d')));
                assert!(wait_until(|| field.text() == "xBCd"));
                assert!(x.stroke(&[], char_keysym('中')));
                assert!(wait_until(|| field.text() == "xBCd中"));
                x.restore_mapping();
                assert_eq!(x.keycode(char_keysym('中')), None);

                // A layout can already map a character beyond the two
                // levels stroke handles (backslash on German keyboards,
                // for example). It must still use the spare-key path.
                let spare = x.spare.expect("Xvfb has an unused keycode");
                let symbol = char_keysym('🦄');
                let syms = [char_keysym('a'), char_keysym('A'), symbol, symbol];
                // SAFETY: the unused keycode belongs to this test's Xvfb
                // display; restore_mapping clears it after the stroke.
                unsafe {
                    (x.change_keyboard_mapping)(
                        x.display,
                        c_int::from(spare),
                        syms.len() as c_int,
                        syms.as_ptr(),
                        1,
                    );
                }
                x.remapped.set(true);
                x.flush();
                // Let GDK consume the mapping change before querying it.
                assert!(wait_until(|| {
                    // SAFETY: query the same display on its GTK thread.
                    unsafe { (x.keysym_to_keycode)(x.display, symbol) == spare }
                }));
                assert_eq!(x.keycode(symbol), None);
                assert!(x.stroke(&[], symbol));
                assert!(wait_until(|| field.text() == "xBCd中🦄"));
                x.restore_mapping();
                assert_eq!(x.keycode(symbol), None);
                window.close();
            })
            .expect("X11 tests require the XTest extension and libXtst");
        });
    }
}
