//! The app's keyboard on a hardware keyboard (a tablet's, a Chromebook's,
//! an emulator's): the `nsh/keymap` shortcuts and the raw
//! `on_key_down` / `on_key_up` notifications of a focused custom view.
//!
//! `NshView.dispatchKeyEvent` asks here before its focused descendant gets
//! a key (`Native.keyDown` / `Native.keyUp`, on the UI thread): a key that
//! fires a binding is consumed (the focused input never sees it: no caret
//! move, no line break, no typed character) and reported to JS with the
//! root's `KeyCommand` event; JS runs the handler afterwards. Its release
//! is consumed too. The input method sees keys before the view hierarchy
//! does, so a composition keeps its keys. `NshView` holds the focus when
//! no input does, so keys reach it wherever the focus is in it; a text
//! input or hosted view (a web view, a native component) having the focus
//! is "in text": its keys stay its own and no raw event is reported.
//! Android repeats a held key's events itself (their repeat count): a
//! binding fires on them only when it asks to (`repeat`), and a raw event
//! says `repeat: true`.
//!
//! The table lives here rather than in Java (`MountItem::Keymap`); a
//! `capture_keys` policy is marshalled through the existing `ViewProps`
//! batch (`Mounter.java` keeps it) and matched on the UI thread with
//! `KeyCaptures.java`, before Android's defaults: the event carries
//! `default_prevented: true` and `dispatchKeyEvent` returns `true` (no Tab
//! traversal, focused-control activation or typed character). A system key
//! (`KeyEvent.isSystem()`: Back, Home, volume, media, camera, call, ...) is
//! never captured, not even by `all`: Android keeps its own default, and
//! the raw notification still reaches the focused view's listeners.
//!
//! One platform event, one notification: the focused node gets the
//! `KeyDown` / `KeyUp` and the engine bubbles it to the enabled listening
//! ancestors within its window (`Core::key_path`); no ancestor is told by
//! the platform. A captured transition is still notified, with
//! [`KeyEvent::default_prevented`] set; observation and consumption are
//! separate decisions made before Android runs a default, as the DOM's
//! `defaultPrevented` is. A release is decided from the focus, listeners
//! and mounted rules at the moment it arrives (a shortcut whose press it
//! consumed keeps the release consumed, while a view listening now still
//! hears the `KeyUp`); releasing, cancelling or losing the window forgets
//! the held keys, and no release is invented (`Native.keyReset`).
//!
//! Managed views take real focus, not only the root: `focusable={true}`,
//! or unset on a view that takes presses, is an Android focus stop
//! (`focusable={false}` and disabled views are not). Only an explicit
//! `focusable={true}` (or a programmatic `ref.focus()`) is focusable in
//! touch mode: a default pressable stays a hardware/Tab stop, revealed by
//! keyboard focus in its scroll view, but a touch-mode tap does not focus
//! it and never pulls the focus out of a text input or hosted native view.
//! That temporary touch-mode focusability ends when the view blurs, so a
//! default button stays touch-neutral. Tab and Shift+Tab walk the managed
//! stops and inputs in native tree order and yield to the embedding host at
//! the first/last stop instead of wrapping; a press on a stop focuses it
//! where the focus can go (an explicit `focusable` in touch mode too; a
//! default pressable outside touch mode and when no native child has the
//! focus, so a tap on a button leaves an input editing); `ref.focus()` /
//! `ref.blur()` focus and blur them; and `FOCUSED`, `onFocus` and `onBlur`
//! reach the core as for an input. The input modality is marked before the
//! focus moves (a pointer's before its request, the keyboard's before a
//! key's default), so `focus-visible:` shows the right one.
//!
//! `NshView` itself is the root stop when no managed view has the focus
//! (the event goes to [`nsh_core::ROOT_ID`]). A `<modal>` dialog window
//! runs the same dispatch with its own focus, fallback root and Tab order.
//! An uncaptured Return or Space down that later becomes captured on a
//! repeat or release is cleared in the native view with a cancelled up, so
//! no stale pressed state or click remains. An `EditText` or hosted native
//! view (a web view, a video, a native component) keeps its own keys and
//! its own internal focus, and a press on it does not become a managed
//! focus. A portaled view (an `Overlay` inserted at the root while its
//! logical `Node.parent` is elsewhere) carries `ViewProps::key_parent`;
//! keyboard interest and capture follow that logical parent (and the
//! mounted host parent), never its physical `Insert` parent, and stop at
//! the window's root. That lets a listener or `captureKeys` on a non-root
//! overlay ancestor apply without involving an unrelated sibling portal.
//!
//! The raw event is the shared [`nsh_core::KeyEvent`]. `key` is the actual
//! Unicode character the source reports with its modifiers (case and
//! non-US layouts preserved), the DOM spelling of a named key (`Enter`,
//! `ArrowLeft`, `Backspace`, `PageUp`, `F5`, `" "`), or `"Unidentified"`
//! when the source names neither: the US layout is never put in its place.
//! `code` is the DOM `KeyboardEvent.code` of the scan code Android reports
//! (`KeyEvent.getScanCode()`, the kernel's evdev code), so it names the
//! key's physical place on any layout; a synthetic event supplies none
//! (`adb shell input keyevent`, a virtual keyboard), and any code this
//! backend has no name for is `""`, never derived from the key code or the
//! typed character. `modifiers` uses the core's flags, `repeat` is
//! Android's auto-repeat, and `default_prevented` is the mounted capture
//! rule's decision for this transition. Capture normalizes like the app's
//! shortcuts ([`keystroke`]: a printable ASCII layout character wins,
//! letters lower case, else the Android key code's US character, 39/'л' is
//! `k`); the raw `key` keeps the actual Unicode. The event goes to the
//! focused managed view's node id, or [`nsh_core::ROOT_ID`] when `NshView`
//! itself has the focus; a modal's events go to its dialog root.
//!
//! Checking a change on an emulator needs a hardware-keyboard-capable AVD
//! and a dev host:
//!
//! ```sh
//! adb shell input keyevent 29               # a: a raw KeyDown and KeyUp (no scan code: code "")
//! adb shell input keyevent --longpress 29   # auto-repeat KeyDowns
//! adb shell input keyevent 61               # Tab: next managed stop (the last yields)
//! adb shell input keyevent 4                # back: never captured; the app's back handling
//! nsh test <app dir> --target android       # an app whose test steps call
//!                                           # keyboard.press(<keys>) and open a <modal>
//! ```
//!
//! A real scan code comes from a physical keyboard, or from the kernel on a
//! rooted emulator (`adb root`, `adb shell getevent -lp` to find the
//! keyboard, then `sendevent` with evdev code 30 for `a`), and reports
//! `code: "KeyA"`. No input method composes here: the composition path
//! stays InputBox's own. A test app with `focusable` views checks
//! `ref.focus()` / `ref.blur()` and the `FOCUSED`/`onFocus`/`onBlur`
//! reports through the same steps (`app.find(…).focus()` in TSX or the
//! Rust `ElementRef::focus`).

use std::sync::Arc;

use jni::{
    JNIEnv,
    objects::JClass,
    sys::{JNI_FALSE, JNI_TRUE, jboolean, jint, jlong},
};
use nsh_core::{
    EventKind, EventPayload, KeyEvent, NodeId, PayloadValue, ROOT_ID,
    element::SharedString,
    keymap::{Key, Keymap, Keystroke, Modifiers},
};

/// `KeyEvent.META_*_ON`.
const META_SHIFT_ON: i32 = 0x1;
const META_ALT_ON: i32 = 0x2;
const META_CTRL_ON: i32 = 0x1000;
const META_META_ON: i32 = 0x10000;

/// A view's table, and the keys whose press the table consumed and that
/// are still down.
#[derive(Default)]
pub(crate) struct KeymapState {
    table: Option<Arc<Keymap>>,
    /// Key codes whose press the table consumed.
    held: Vec<i32>,
}

impl KeymapState {
    /// `MountItem::Keymap`: replaces the table.
    pub(crate) fn set(&mut self, keymap: Arc<Keymap>) {
        self.table = (!keymap.is_empty()).then_some(keymap);
    }

    /// A new app: no bindings yet.
    pub(crate) fn clear(&mut self) {
        *self = KeymapState::default();
    }

    /// Forgets the keys held (the window lost the focus, the view went
    /// away, or the app restarted): their releases are no press of a key
    /// any more.
    pub(crate) fn reset_keys(&mut self) {
        self.held.clear();
    }

    /// Records that the table consumed key `code`.
    fn consume(&mut self, code: i32) {
        push_once(&mut self.held, code);
    }

    /// Removes key `code` from the held keys: `true` when the table
    /// consumed its press (then its release is consumed too).
    fn release(&mut self, code: i32) -> bool {
        remove(&mut self.held, code)
    }

    /// Forgets key `code` without reporting a release: `true` when its
    /// press was consumed.
    fn cancel(&mut self, code: i32) -> bool {
        remove(&mut self.held, code)
    }
}

fn push_once(keys: &mut Vec<i32>, code: i32) {
    if !keys.contains(&code) {
        keys.push(code);
    }
}

fn remove(keys: &mut Vec<i32>, code: i32) -> bool {
    match keys.iter().position(|held| *held == code) {
        Some(i) => {
            keys.remove(i);
            true
        }
        None => false,
    }
}

/// The canonical shortcut keystroke of a key event: key code `code`,
/// `unicode` the character it types without modifiers
/// (`KeyEvent.getUnicodeChar(0)`, 0 for none), `meta` its meta state.
/// This is the app's shortcut vocabulary, not the raw event: a key that
/// types no ASCII there is the US layout's key of the same code.
pub(crate) fn keystroke(code: i32, unicode: i32, meta: i32) -> Option<Keystroke> {
    let modifiers = modifiers(meta);
    let key = match Key::from_android_keycode(code)? {
        us @ Key::Char(c) if c != ' ' => match char::from_u32(unicode as u32) {
            Some(c) if c.is_ascii_graphic() => Key::Char(c.to_ascii_lowercase()),
            _ => us,
        },
        named => named,
    };
    Some(Keystroke { modifiers, key })
}

/// The core's modifiers for Android's meta state.
fn modifiers(meta: i32) -> Modifiers {
    Modifiers {
        ctrl: meta & META_CTRL_ON != 0,
        alt: meta & META_ALT_ON != 0,
        shift: meta & META_SHIFT_ON != 0,
        cmd: meta & META_META_ON != 0,
    }
}

/// The capture-key id of a shortcut key, as `KeyCaptures.java` reads it:
/// a non-negative Unicode scalar is a character (the canonical unshifted
/// one), and a negative id names a key (`-1` Enter, `-2` Escape, `-3`
/// Tab, `-4` Backspace, `-5` Delete, `-6` Insert, `-7` Up, `-8` Down,
/// `-9` Left, `-10` Right, `-11` Home, `-12` End, `-13` PageUp,
/// `-14` PageDown, `-100 - n` F(n)).
pub(crate) fn capture_key(key: Key) -> i32 {
    match key {
        Key::Char(c) => c as i32,
        Key::Enter => -1,
        Key::Escape => -2,
        Key::Tab => -3,
        Key::Backspace => -4,
        Key::Delete => -5,
        Key::Insert => -6,
        Key::Up => -7,
        Key::Down => -8,
        Key::Left => -9,
        Key::Right => -10,
        Key::Home => -11,
        Key::End => -12,
        Key::PageUp => -13,
        Key::PageDown => -14,
        Key::F(n) => -100 - i32::from(n),
    }
}

/// A capture rule's modifiers, as `KeyCaptures.java` reads them.
pub(crate) fn capture_modifiers(m: Modifiers) -> i32 {
    (m.ctrl as i32) | (m.alt as i32) << 1 | (m.shift as i32) << 2 | (m.cmd as i32) << 3
}

/// A key went down (`repeat`: an auto-repeat of a held key).
/// `focused` is the node that has the focus (`ROOT_ID` for `NshView`, a
/// modal's id in its dialog); `window` names the binding window;
/// `control` says the focused view takes presses ([`Keymap::find_at`]);
/// `default_prevented`/`raw` are the mounted decisions for this
/// transition. Returns whether the app's shortcuts or a mounted
/// `capture_keys` rule take the key (then Android runs no default).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_keyDown(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    code: jint,
    unicode: jint,
    text: jint,
    meta: jint,
    scan_code: jint,
    repeat: jboolean,
    editing: jboolean,
    focused: jint,
    window: jint,
    control: jboolean,
    default_prevented: jboolean,
    raw: jboolean,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { crate::host::host(handle) };
    note_key(host, code);
    if shortcut(
        host,
        window,
        code,
        unicode,
        meta,
        editing != 0,
        control != 0,
        repeat != 0,
    ) {
        return JNI_TRUE;
    }
    if raw == 0 || focused <= 0 {
        return JNI_FALSE;
    }
    let prevented = default_prevented != 0;
    let event = key_event(code, unicode, text, meta, scan_code, repeat != 0, prevented);
    host.dispatch(
        focused as NodeId,
        EventKind::KeyDown,
        EventPayload::Key(event),
    );
    if prevented { JNI_TRUE } else { JNI_FALSE }
}

/// A key came up (`focused`: the node focused now, 0 when a native child
/// owns the keys): the release uses the current `default_prevented` and
/// `raw` decisions, not what its down happened to do. A view listening now
/// hears the `KeyUp` even when the app's shortcuts consumed its press;
/// only the consumption carries over (`true`: Android runs no default).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_keyUp(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    code: jint,
    unicode: jint,
    text: jint,
    meta: jint,
    scan_code: jint,
    focused: jint,
    default_prevented: jboolean,
    raw: jboolean,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { crate::host::host(handle) };
    let held = {
        let mut state = host.keymap.lock().unwrap_or_else(|e| e.into_inner());
        state.release(code)
    };
    let prevented = default_prevented != 0;
    if release_observed(raw != 0, focused) {
        let event = key_event(code, unicode, text, meta, scan_code, false, prevented);
        host.dispatch(
            focused as NodeId,
            EventKind::KeyUp,
            EventPayload::Key(event),
        );
    }
    if release_consumed(held, prevented) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

/// A key's release was cancelled (the system took the gesture): forget it
/// without reporting a `KeyUp`; `true` when its press was consumed.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_keyCancel(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    code: jint,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { crate::host::host(handle) };
    let consumed = host
        .keymap
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cancel(code);
    if consumed { JNI_TRUE } else { JNI_FALSE }
}

/// The window lost the focus or the app went away: no held key has a
/// release any more.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_keyReset(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { crate::host::host(handle) };
    host.keymap
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .reset_keys();
}

/// The user gave the surface input with a pointer (a press that focuses a
/// managed view): the focus it moves shows as a pointer's, not the
/// keyboard's.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_pointerInput(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { crate::host::host(handle) };
    host.input_with(nsh_core::platform::InputModality::Pointer);
}

/// A key with Control comes as a shortcut before the key event (the
/// window's input stage offers it first): only the app's shortcuts, and
/// no raw event. Its capture rules take it in the key event that follows
/// when no binding does.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_keyShortcut(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    code: jint,
    unicode: jint,
    meta: jint,
    window: jint,
    control: jboolean,
    repeat: jboolean,
    editing: jboolean,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { crate::host::host(handle) };
    note_key(host, code);
    if shortcut(
        host,
        window,
        code,
        unicode,
        meta,
        editing != 0,
        control != 0,
        repeat != 0,
    ) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

/// Every key down passes here before it acts: the focus it moves shows
/// (`focus-visible:`). A modifier alone (Alt, Shift, Sym, Control, Caps
/// Lock, Meta, Function: `KeyEvent.KEYCODE_*`) does not count.
fn note_key(host: &crate::host::Host, code: i32) {
    if !matches!(code, 57..=60 | 63 | 113..=119) {
        host.input_with(nsh_core::platform::InputModality::Keyboard);
    }
}

/// Whether the table takes key `code` (firing its binding) in `window`,
/// where `control` is a focused view that takes presses.
#[allow(clippy::too_many_arguments)]
fn shortcut(
    host: &crate::host::Host,
    window: i32,
    code: i32,
    unicode: i32,
    meta: i32,
    editing: bool,
    control: bool,
    repeat: bool,
) -> bool {
    let Some(stroke) = keystroke(code, unicode, meta) else {
        return false;
    };
    let found = {
        let mut state = host.keymap.lock().unwrap_or_else(|e| e.into_inner());
        let Some(table) = state.table.clone() else {
            return false;
        };
        let found = table.find_at(window.max(1) as NodeId, stroke, editing, control, repeat);
        if found.consumed() {
            state.consume(code);
        }
        found
    };
    if let Some(id) = found.fired() {
        host.dispatch(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(f64::from(id))),
        );
    }
    found.consumed()
}

/// The shared [`KeyEvent`] of a press or release. Android's key code names
/// the non-printing keys; `unicode` is the unshifted character the layout
/// types on it (`KeyEvent.getUnicodeChar(0)`) and `text` the printable
/// character the source reports with the modifiers held (Shift, Caps Lock,
/// AltGr, Alt). The logical `key` is that character when there is one,
/// else the key code's DOM name, else `"Unidentified"`. `code` comes from
/// `scan_code` alone (the kernel's evdev code), never from the key code.
#[allow(clippy::too_many_arguments)]
pub(crate) fn key_event(
    code: i32,
    unicode: i32,
    text: i32,
    meta: i32,
    scan_code: i32,
    repeat: bool,
    default_prevented: bool,
) -> KeyEvent {
    let character = printable(text).or_else(|| printable(unicode));
    let key = match character {
        Some(c) => SharedString::from(c.to_string()),
        None => SharedString::new_static(named_key(code).unwrap_or("Unidentified")),
    };
    let mut event = KeyEvent::default();
    event.key = key;
    event.code = SharedString::new_static(dom_code(scan_code));
    event.modifiers = modifiers(meta);
    event.repeat = repeat;
    event.default_prevented = default_prevented;
    event
}

/// The printable character a reported code point is, `None` for none
/// (`0`, a control character, or not a Unicode scalar).
fn printable(value: i32) -> Option<char> {
    char::from_u32(u32::try_from(value).ok()?).filter(|c| !c.is_control())
}

/// The DOM `KeyboardEvent.code` of an Android scan code: the kernel's
/// evdev code (`KeyEvent.getScanCode()`), so the key's physical place on
/// any layout. The names are the UI Events code values, as Chromium maps
/// the same codes on Linux (the X11 keycode there is the evdev code plus
/// 8). `0` (a synthetic or virtual key) and any code this backend has no
/// name for are `""`; a code is never derived from the key code or the
/// character.
fn dom_code(scan_code: i32) -> &'static str {
    match scan_code {
        1 => "Escape",
        2 => "Digit1",
        3 => "Digit2",
        4 => "Digit3",
        5 => "Digit4",
        6 => "Digit5",
        7 => "Digit6",
        8 => "Digit7",
        9 => "Digit8",
        10 => "Digit9",
        11 => "Digit0",
        12 => "Minus",
        13 => "Equal",
        14 => "Backspace",
        15 => "Tab",
        16 => "KeyQ",
        17 => "KeyW",
        18 => "KeyE",
        19 => "KeyR",
        20 => "KeyT",
        21 => "KeyY",
        22 => "KeyU",
        23 => "KeyI",
        24 => "KeyO",
        25 => "KeyP",
        26 => "BracketLeft",
        27 => "BracketRight",
        28 => "Enter",
        29 => "ControlLeft",
        30 => "KeyA",
        31 => "KeyS",
        32 => "KeyD",
        33 => "KeyF",
        34 => "KeyG",
        35 => "KeyH",
        36 => "KeyJ",
        37 => "KeyK",
        38 => "KeyL",
        39 => "Semicolon",
        40 => "Quote",
        41 => "Backquote",
        42 => "ShiftLeft",
        43 => "Backslash",
        44 => "KeyZ",
        45 => "KeyX",
        46 => "KeyC",
        47 => "KeyV",
        48 => "KeyB",
        49 => "KeyN",
        50 => "KeyM",
        51 => "Comma",
        52 => "Period",
        53 => "Slash",
        54 => "ShiftRight",
        55 => "NumpadMultiply",
        56 => "AltLeft",
        57 => "Space",
        58 => "CapsLock",
        59 => "F1",
        60 => "F2",
        61 => "F3",
        62 => "F4",
        63 => "F5",
        64 => "F6",
        65 => "F7",
        66 => "F8",
        67 => "F9",
        68 => "F10",
        69 => "NumLock",
        70 => "ScrollLock",
        71 => "Numpad7",
        72 => "Numpad8",
        73 => "Numpad9",
        74 => "NumpadSubtract",
        75 => "Numpad4",
        76 => "Numpad5",
        77 => "Numpad6",
        78 => "NumpadAdd",
        79 => "Numpad1",
        80 => "Numpad2",
        81 => "Numpad3",
        82 => "Numpad0",
        83 => "NumpadDecimal",
        85 => "Lang5",
        86 => "IntlBackslash",
        87 => "F11",
        88 => "F12",
        89 => "IntlRo",
        90 => "Lang3",
        91 => "Lang4",
        92 => "Convert",
        93 => "KanaMode",
        94 => "NonConvert",
        96 => "NumpadEnter",
        97 => "ControlRight",
        98 => "NumpadDivide",
        99 => "PrintScreen",
        100 => "AltRight",
        102 => "Home",
        103 => "ArrowUp",
        104 => "PageUp",
        105 => "ArrowLeft",
        106 => "ArrowRight",
        107 => "End",
        108 => "ArrowDown",
        109 => "PageDown",
        110 => "Insert",
        111 => "Delete",
        113 => "AudioVolumeMute",
        114 => "AudioVolumeDown",
        115 => "AudioVolumeUp",
        116 => "Power",
        117 => "NumpadEqual",
        119 => "Pause",
        120 => "ShowAllWindows",
        121 => "NumpadComma",
        122 => "Lang1",
        123 => "Lang2",
        124 => "IntlYen",
        125 => "MetaLeft",
        126 => "MetaRight",
        127 => "ContextMenu",
        128 => "BrowserStop",
        129 => "Again",
        131 => "Undo",
        132 => "Select",
        133 => "Copy",
        134 => "Open",
        135 => "Paste",
        136 => "Find",
        137 => "Cut",
        138 => "Help",
        140 => "LaunchApp2",
        142 => "Sleep",
        143 => "WakeUp",
        144 => "LaunchApp1",
        155 => "LaunchMail",
        156 => "BrowserFavorites",
        158 => "BrowserBack",
        159 => "BrowserForward",
        161 => "Eject",
        163 => "MediaTrackNext",
        164 => "MediaPlayPause",
        165 => "MediaTrackPrevious",
        166 => "MediaStop",
        167 => "MediaRecord",
        168 => "MediaRewind",
        171 => "MediaSelect",
        172 => "BrowserHome",
        173 => "BrowserRefresh",
        179 => "NumpadParenLeft",
        180 => "NumpadParenRight",
        183 => "F13",
        184 => "F14",
        185 => "F15",
        186 => "F16",
        187 => "F17",
        188 => "F18",
        189 => "F19",
        190 => "F20",
        191 => "F21",
        192 => "F22",
        193 => "F23",
        194 => "F24",
        201 => "MediaPause",
        207 => "MediaPlay",
        208 => "MediaFastForward",
        217 => "BrowserSearch",
        224 => "BrightnessDown",
        225 => "BrightnessUp",
        227 => "DisplayToggleIntExt",
        231 => "MailSend",
        232 => "MailReply",
        233 => "MailForward",
        _ => "",
    }
}

/// A key that types no character, by Android's key code
/// (`KeyEvent.KEYCODE_*`), in the DOM's spelling (`KeyboardEvent.key`).
fn named_key(code: i32) -> Option<&'static str> {
    /// `F1` to `F24`.
    const FUNCTION: [&str; 24] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14",
        "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
    ];
    Some(match code {
        3 => "GoHome",
        4 => "GoBack",
        5 => "Call",
        6 => "EndCall",
        19 => "ArrowUp",
        20 => "ArrowDown",
        21 => "ArrowLeft",
        22 => "ArrowRight",
        23 => "Enter",
        24 => "AudioVolumeUp",
        25 => "AudioVolumeDown",
        26 => "Power",
        27 => "Camera",
        57 | 58 => "Alt",
        59 | 60 => "Shift",
        61 => "Tab",
        66 | 160 => "Enter",
        67 => "Backspace",
        79 => "HeadsetHook",
        80 => "CameraFocus",
        82 => "ContextMenu",
        85 => "MediaPlayPause",
        86 => "MediaStop",
        87 => "MediaTrackNext",
        88 => "MediaTrackPrevious",
        89 => "MediaRewind",
        90 => "MediaFastForward",
        92 => "PageUp",
        93 => "PageDown",
        111 => "Escape",
        112 => "Delete",
        113 | 114 => "Control",
        115 => "CapsLock",
        116 => "ScrollLock",
        117 | 118 => "Meta",
        119 => "Fn",
        120 => "PrintScreen",
        121 => "Pause",
        122 => "Home",
        123 => "End",
        124 => "Insert",
        126 => "MediaPlay",
        127 => "MediaPause",
        131..=142 => FUNCTION[(code - 131) as usize],
        143 => "NumLock",
        164 => "AudioVolumeMute",
        187 => "AppSwitch",
        _ => return None,
    })
}

/// Whether a release is observed at the current focus: the current
/// listeners/capture rules accept it. A shortcut's release is consumed
/// on its own ([`release_consumed`]) without suppressing the observation.
fn release_observed(raw: bool, focused: i32) -> bool {
    raw && focused > 0
}

/// Whether a release is consumed: the app's shortcut held the press, or a
/// mounted capture rule captures the release now.
fn release_consumed(held: bool, prevented: bool) -> bool {
    held || prevented
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keys_by_what_they_type() {
        let parse = |t| Keystroke::parse(t, nsh_core::platform::Os::Android).ok();
        assert_eq!(keystroke(20, 0, 0), parse("down"));
        assert_eq!(keystroke(66, 0, 0), parse("enter"));
        assert_eq!(keystroke(39, 'k' as i32, META_CTRL_ON), parse("mod+k"));
        assert_eq!(keystroke(76, '/' as i32, META_SHIFT_ON), parse("shift+/"));
        // A layout typing no ASCII there: the US layout's key.
        assert_eq!(keystroke(39, 'л' as i32, 0), parse("k"));
        // A layout typing another letter there (AZERTY's A on Q's key).
        assert_eq!(keystroke(45, 'a' as i32, 0), parse("a"));
        assert_eq!(keystroke(59, 0, META_SHIFT_ON), None);
    }

    #[test]
    fn reports_the_logical_key_the_source_gives() {
        let shift_a = key_event(29, 'a' as i32, 'A' as i32, META_SHIFT_ON, 0, false, false);
        assert_eq!(&*shift_a.key, "A");
        assert!(shift_a.modifiers.shift && !shift_a.modifiers.ctrl);

        // A shifted punctuation key reports the character it types.
        let question = key_event(76, '/' as i32, '?' as i32, META_SHIFT_ON, 0, false, false);
        assert_eq!(&*question.key, "?");

        // A non-US layout keeps its character, case and all.
        let cyrillic = key_event(39, 'л' as i32, 'Л' as i32, META_SHIFT_ON, 0, false, false);
        assert_eq!(&*cyrillic.key, "Л");
        let plain = key_event(39, 'л' as i32, 'л' as i32, 0, 0, false, false);
        assert_eq!(&*plain.key, "л");

        // No character from the source: the key code's DOM name, never a
        // US character in its place.
        assert_eq!(&*key_event(21, 0, 0, 0, 0, false, false).key, "ArrowLeft");
        assert_eq!(&*key_event(66, 0, 0, 0, 0, false, false).key, "Enter");
        assert_eq!(&*key_event(3, 0, 0, 0, 0, false, false).key, "GoHome");
        assert_eq!(&*key_event(5, 0, 0, 0, 0, false, false).key, "Call");
        assert_eq!(&*key_event(27, 0, 0, 0, 0, false, false).key, "Camera");
        assert_eq!(&*key_event(135, 0, 0, 0, 0, false, false).key, "F5");
        // The source names neither a character nor a key.
        assert_eq!(
            &*key_event(1000, 0, 0, 0, 0, false, false).key,
            "Unidentified"
        );

        // Space is the character it types.
        assert_eq!(
            &*key_event(62, ' ' as i32, ' ' as i32, 0, 0, false, false).key,
            " "
        );

        // An auto-repeat, and the capture decision of this transition.
        let repeat = key_event(29, 'a' as i32, 'A' as i32, META_SHIFT_ON, 30, true, true);
        assert!(repeat.repeat);
        assert!(repeat.default_prevented);
        assert!(!shift_a.repeat && !shift_a.default_prevented);
    }

    #[test]
    fn names_the_physical_code_only_from_a_scan_code() {
        // The kernel's evdev code names the key's place, whatever the
        // layout types on it.
        assert_eq!(
            &*key_event(29, 'a' as i32, 'a' as i32, 0, 30, false, false).code,
            "KeyA"
        );
        assert_eq!(
            &*key_event(39, 'л' as i32, 'л' as i32, 0, 37, false, false).code,
            "KeyK"
        );
        assert_eq!(
            &*key_event(76, '/' as i32, '?' as i32, META_SHIFT_ON, 53, false, false).code,
            "Slash"
        );
        assert_eq!(
            &*key_event(160, '\n' as i32, 0, 0, 96, false, false).code,
            "NumpadEnter"
        );
        // Both Shift keys are the same logical key, told apart by `code`.
        assert_eq!(
            &*key_event(59, 0, 0, META_SHIFT_ON, 42, false, false).code,
            "ShiftLeft"
        );
        assert_eq!(
            &*key_event(60, 0, 0, META_SHIFT_ON, 54, false, false).code,
            "ShiftRight"
        );
        // A synthetic event has no physical identity; an unknown code is
        // not guessed from the key code or the character.
        assert_eq!(
            &*key_event(29, 'a' as i32, 'a' as i32, 0, 0, false, false).code,
            ""
        );
        assert_eq!(
            &*key_event(29, 'a' as i32, 'a' as i32, 0, 9999, false, false).code,
            ""
        );
        assert_eq!(dom_code(0), "");
        assert_eq!(dom_code(-1), "");
        assert_eq!(dom_code(84), "");
        assert_eq!(dom_code(158), "BrowserBack");
    }

    #[test]
    fn a_release_uses_the_current_focus_and_capture() {
        // A release at a focus that listens now is observed, even when
        // the app's shortcuts owned its press; its consumption carries
        // over separately.
        assert!(release_observed(true, 7));
        assert!(!release_observed(false, 7));
        assert!(!release_observed(true, 0));
        assert!(release_consumed(true, false));
        assert!(release_consumed(false, true));
        assert!(!release_consumed(false, false));
    }

    #[test]
    fn a_release_forgets_only_its_key() {
        let mut state = KeymapState::default();
        state.consume(29);
        state.consume(30);
        // A repeated down does not duplicate the held state.
        state.consume(30);
        assert_eq!(state.held.iter().filter(|c| **c == 30).count(), 1);

        assert!(state.release(30));
        assert!(state.held.contains(&29));
        assert!(state.release(29));
        assert!(!state.release(29));
        assert!(state.held.is_empty());

        // A cancel reports what its press did without a `KeyUp`.
        state.consume(31);
        assert!(state.cancel(31));
        assert!(!state.release(31));

        state.consume(32);
        state.reset_keys();
        assert!(state.held.is_empty());
    }

    #[test]
    fn capture_ids_match_the_java_reader() {
        assert_eq!(capture_key(Key::Char('a')), 'a' as i32);
        assert_eq!(capture_key(Key::Char(' ')), ' ' as i32);
        assert_eq!(capture_key(Key::Enter), -1);
        assert_eq!(capture_key(Key::Escape), -2);
        assert_eq!(capture_key(Key::Tab), -3);
        assert_eq!(capture_key(Key::Backspace), -4);
        assert_eq!(capture_key(Key::Delete), -5);
        assert_eq!(capture_key(Key::Insert), -6);
        assert_eq!(capture_key(Key::Up), -7);
        assert_eq!(capture_key(Key::Down), -8);
        assert_eq!(capture_key(Key::Left), -9);
        assert_eq!(capture_key(Key::Right), -10);
        assert_eq!(capture_key(Key::Home), -11);
        assert_eq!(capture_key(Key::End), -12);
        assert_eq!(capture_key(Key::PageUp), -13);
        assert_eq!(capture_key(Key::PageDown), -14);
        assert_eq!(capture_key(Key::F(1)), -101);
        assert_eq!(capture_key(Key::F(24)), -124);

        let mods = Modifiers {
            ctrl: true,
            alt: true,
            shift: true,
            cmd: true,
        };
        assert_eq!(capture_modifiers(mods), 0b1111);
        assert_eq!(capture_modifiers(Modifiers::default()), 0);
    }
}
