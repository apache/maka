//! Hardware keys on the focused view: the `on_key_down` / `on_key_up`
//! notifications a focusable view and its ancestors hear, the mounted
//! capture rules that decide whether a key runs a default, and Tab's focus
//! traversal.
//!
//! UIKit delivers a key to the first responder as `UIPress`es
//! ([`crate::native_view::NshView`] overrides `pressesBegan:withEvent:`,
//! `pressesChanged:withEvent:`, `pressesEnded:withEvent:` and
//! `pressesCancelled:withEvent:`). A focused view reports one
//! [`KeyEvent`](nsh_core::KeyEvent) per transition and lets the engine
//! bubble it to the listening ancestors in its window; an ancestor that is
//! not the first responder reports nothing itself. Listeners and capture
//! rules are read from the mounter's metadata for the focused node and
//! every logical ancestor (a scroll view included), stopping at a modal's
//! window boundary as the core's bubbling does. A portaled view (an
//! `Overlay`, whose native Insert is at the root) uses the core's
//! `ViewProps::key_parent` override for these walks; its layout and
//! hit-testing parent stays the native one.
//!
//! The app's shortcuts ([`crate::keymap`]) keep their precedence: a press
//! they consume never becomes a raw notification. Otherwise the mounted
//! capture rules of the focused view and its enabled ancestors decide
//! whether the key runs a default ([`KeyEvent::default_prevented`]). A
//! captured key still notifies. Tab and Shift+Tab move the keyboard focus
//! between the focus stops (inputs and `focusable` views) unless a rule
//! captures them or the app's keymap binds them; Return and Space press a
//! focused view that takes presses, as the other backends do.
//!
//! What the source gives:
//!
//! - The physical identity is `UIKey.keyCode`, the USB HID usage. UIKit
//!   has no DOM code of its own, so [`dom_code`] maps the HID usage to the
//!   DOM's `KeyboardEvent.code` spelling (the key's place: `"KeyA"` for
//!   the usage under `A`, whatever the layout types there). A usage this
//!   backend has no DOM code for reports `""`, never a guess from the
//!   character.
//! - The logical key is the character the source reports for this press
//!   (`UIKey.characters`: its case, Shift and layout included, so Shift+A
//!   is `"A"`, a US keyboard's Shift+/ is `"?"`, and a German or Cyrillic
//!   key keeps its own character). Only a chord whose `characters` is no
//!   printable text (Control's `\u{1}`, an empty composition) falls back
//!   to `UIKey.charactersIgnoringModifiers`, the layout's unmodified
//!   character; never to a US layout guess. Named keys (`Enter`, `Escape`,
//!   `Tab`, `Backspace`, `Delete`, `ArrowLeft`, `F1`, `Shift`, ...) keep
//!   the DOM's spelling. Capture matching canonicalizes through the same
//!   `keymap::keystroke` the app's shortcuts use, so a layout's reported
//!   character wins over its HID position on both sides (a French `a` on
//!   the US `q` key captures `a`, not `q`).
//! - UIKit delivers a held key's press once and reports no auto-repeat:
//!   `repeat` is always false here, and `pressesChanged:` (whose keyboard
//!   transitions UIKit does not document) reports nothing. An app that
//!   wants repeats starts its own timer from the press.
//!
//! Tab has two paths. While no view or input has the focus, the surface
//! root is the first responder ([`crate::surface::RootView`]): a Tab it
//! receives at `pressesBegan:` moves to the first stop and Shift+Tab to the
//! last ([`root_tab`]) through the same walk of visible focus stops that a
//! focused view uses. A focusable view also answers `canBecomeFocused`, so
//! UIKit's focus engine and `didUpdateFocusInContext:` follow the same
//! items. On a focused view, a Tab an app shortcut binds or a mounted rule
//! captures returns `UIKeyCommand`s with `wantsPriorityOverSystemBehavior`
//! for exactly those modifier combinations: the app's Tab binding runs
//! first, then the capture keeps the key (an uncaptured, unbound Tab follows
//! the normal traversal). A Tab delivered by that command has no `UIPress`:
//! its `KeyDown` has `code: ""`, `repeat: false`, and no `KeyUp` is
//! invented. Command+Tab is the system's app switcher and is never
//! intercepted.
//!
//! Blur, cancellation and deactivation clear the keys a view holds without
//! synthesizing a release: the source delivered no `pressesEnded:`, so no
//! `KeyUp` is invented. A real release that arrives after the focus moved
//! is reported on the view that has the focus then (the DOM's behavior).
//!
//! A focused view that blurs (`ref.blur()`) or is deleted leaves UIKit
//! without a first responder; UIKit does not make the window's root one. On
//! the next turn [`root_focus_if_none`] gives the surface root the keyboard
//! back only where no view in the window is first responder, so a transfer
//! to a native input, a hosted view or another custom view keeps its focus.
//! A modal's view is its own scope and is never replaced by the background
//! surface root. Window attachment and explicit keyboard dismissal use the
//! same restoration, including when the root itself gave up the keyboard.

use std::cell::{Cell, RefCell};

use nsh_core::{
    EventKind, EventPayload, KeyEvent,
    element::SharedString,
    keymap::{Key, Keystroke},
};
use objc2::{
    MainThreadMarker, MainThreadOnly, Message, rc::Retained, runtime::ProtocolObject, sel,
};
use objc2_foundation::{NSArray, NSSet, NSString};
use objc2_ui_kit::{
    UIFocusEnvironment, UIFocusSystem, UIFocusUpdateContext, UIKey, UIKeyCommand,
    UIKeyModifierFlags, UIPress, UITouch, UIView, UIWindow,
};

use crate::{
    input::{Area, Field},
    native_view::NshView,
    target::EventTarget,
};

/// `UIKeyboardHIDUsageKeyboardTab`.
const TAB: u16 = 0x2B;

/// Keyboard state of one surface: the physical keys whose press this
/// surface reported, and the modifier keys it saw pressed.
pub(crate) struct Keyboard {
    /// The HID usages a `KeyDown` was sent for, until their release or the
    /// state is cleared (blur, cancellation, deactivation).
    held: RefCell<rustc_hash::FxHashSet<u16>>,
    /// The modifier keys held, by HID usage, with the modifier each
    /// stands for: releasing one Shift keeps Shift while the other is
    /// still held.
    modifiers: RefCell<rustc_hash::FxHashMap<u16, UIKeyModifierFlags>>,
    /// Modifiers UIKit reports that no physical key seen here accounts
    /// for (held before the focused view got the keys).
    unseen: Cell<UIKeyModifierFlags>,
}

impl Default for Keyboard {
    fn default() -> Self {
        Self {
            held: RefCell::default(),
            modifiers: RefCell::default(),
            unseen: Cell::new(UIKeyModifierFlags::empty()),
        }
    }
}

impl Keyboard {
    /// Forgets every key held, without a release (blur, deactivation or the
    /// surface's app stopping).
    pub(crate) fn clear(&self) {
        self.held.borrow_mut().clear();
        self.modifiers.borrow_mut().clear();
        self.unseen.set(UIKeyModifierFlags::empty());
    }

    fn down(&self, usage: u16) {
        self.held.borrow_mut().insert(usage);
    }

    fn up(&self, usage: u16) -> bool {
        self.held.borrow_mut().remove(&usage)
    }

    fn is_held(&self, usage: u16) -> bool {
        self.held.borrow().contains(&usage)
    }

    /// The modifiers after `usage`'s transition, with a modifier key's own
    /// mask taken from the physical modifier keys held (so one Shift's
    /// release does not clear the other's). `flags` is UIKit's report.
    fn effective_modifiers(
        &self,
        usage: u16,
        flags: UIKeyModifierFlags,
        down: bool,
    ) -> nsh_core::keymap::Modifiers {
        let Some(mask) = modifier_mask(usage) else {
            self.observe(flags, None);
            return modifiers_of(flags);
        };
        {
            let mut held = self.modifiers.borrow_mut();
            if down {
                held.insert(usage, mask);
            } else {
                held.remove(&usage);
            }
            if down || held.values().any(|m| *m == mask) {
                // A physical key stands for the mask; a UIKit report of it
                // before this press is accounted for now.
                self.unseen.set(self.unseen.get() & !mask);
            }
        }
        let tracked = self.modifiers.borrow().values().any(|m| *m == mask);
        let effective = tracked || self.unseen.get().contains(mask);
        let mut flags = flags;
        flags.set(mask, effective);
        // The other masks are UIKit's; remember those no physical key seen
        // here accounts for.
        self.observe(flags, Some(mask));
        modifiers_of(flags)
    }

    /// Records which of `flags` are held without a physical key seen here
    /// (`own` is the mask of the modifier key whose transition is being
    /// reported, already handled).
    fn observe(&self, flags: UIKeyModifierFlags, own: Option<UIKeyModifierFlags>) {
        let held = self.modifiers.borrow();
        let mut unseen = self.unseen.get();
        for mask in [
            UIKeyModifierFlags::Shift,
            UIKeyModifierFlags::Control,
            UIKeyModifierFlags::Alternate,
            UIKeyModifierFlags::Command,
        ] {
            if own == Some(mask) {
                continue;
            }
            let tracked = held.values().any(|m| *m == mask);
            if tracked {
                unseen &= !mask;
            } else if flags.contains(mask) {
                unseen |= mask;
            } else {
                unseen &= !mask;
            }
        }
        self.unseen.set(unseen);
    }
}

/// The modifier a physical modifier key stands for.
fn modifier_mask(usage: u16) -> Option<UIKeyModifierFlags> {
    Some(match usage {
        0xE0 | 0xE4 => UIKeyModifierFlags::Control,
        0xE1 | 0xE5 => UIKeyModifierFlags::Shift,
        0xE2 | 0xE6 => UIKeyModifierFlags::Alternate,
        0xE3 | 0xE7 => UIKeyModifierFlags::Command,
        _ => return None,
    })
}

fn modifiers_of(flags: UIKeyModifierFlags) -> nsh_core::keymap::Modifiers {
    nsh_core::keymap::Modifiers {
        ctrl: flags.contains(UIKeyModifierFlags::Control),
        alt: flags.contains(UIKeyModifierFlags::Alternate),
        shift: flags.contains(UIKeyModifierFlags::Shift),
        cmd: flags.contains(UIKeyModifierFlags::Command),
        alt_graph: false,
    }
}

/// `pressesBegan:withEvent:` of focusable view `view`: whether the view
/// consumed the presses. It runs the app's shortcuts first, then reports a
/// `KeyDown` per key (marked prevented by the mounted rules), then the
/// defaults a captured key never reaches.
pub(crate) fn began(view: &NshView, presses: &NSSet<UIPress>) -> bool {
    view.isFirstResponder() && reported_began(view, presses)
}

/// The presses a selectable view's internal responder
/// ([`crate::selectable_view::AreaResponder`]) did not take (it answers
/// Copy and Select All): they go through `area`'s raw key path, as if the
/// area were focused, so its `KeyDown` and capture rules and the listening
/// ancestors hear them. Whether the presses were consumed.
pub(crate) fn area_began(area: &UIView, presses: &NSSet<UIPress>) -> bool {
    area.downcast_ref::<NshView>()
        .is_some_and(|view| reported_began(view, presses))
}

/// [`area_began`] for releases ([`ended`]).
pub(crate) fn area_ended(area: &UIView, presses: &NSSet<UIPress>) -> bool {
    area.downcast_ref::<NshView>()
        .is_some_and(|view| reported_ended(view, presses))
}

/// [`area_began`] for cancellations ([`cancelled`]).
pub(crate) fn area_cancelled(area: &UIView, presses: &NSSet<UIPress>) -> bool {
    area.downcast_ref::<NshView>()
        .is_some_and(|view| reported_cancelled(view, presses))
}

/// Whether `area` reports raw keys itself ([`area_began`]): the surface
/// root then leaves the presses its responder passes on alone.
pub(crate) fn area_reports(area: &UIView) -> bool {
    area.downcast_ref::<NshView>()
        .is_some_and(|view| view.keyboard_target().is_some())
}

/// [`began`] on `view`, which holds the keyboard (as the first responder,
/// or through its selectable view's responder).
fn reported_began(view: &NshView, presses: &NSSet<UIPress>) -> bool {
    let Some(target) = view.keyboard_target() else {
        return false;
    };
    // The app's shortcuts keep their precedence: a press they consume is no
    // raw notification, and a pass-through one is reported and goes on.
    if crate::keymap::began(&target, presses, false, view.takes_presses()) {
        return true;
    }
    let mtm = view.mtm();
    let state = target.keyboard();
    let listens = listens(view, &target);
    let mut consumed = false;
    let mut tab: Option<bool> = None;
    let mut activates = false;
    for press in presses.iter() {
        let Some(key) = press.key(mtm) else {
            continue;
        };
        let Some(usage) = usage(&key) else {
            continue;
        };
        let down = event(&key, usage, state, true);
        // The same canonical stroke the app's keymap uses: HID-first
        // normalization would disagree on a layout whose character differs
        // from the US key's position.
        let stroke = crate::keymap::keystroke(&key);
        let captured = listens && captures(view, &target, stroke.as_ref());
        if captured || listens {
            let mut reported = down;
            reported.default_prevented = captured;
            target.dispatch(view.id(), EventKind::KeyDown, EventPayload::Key(reported));
        }
        state.down(usage);
        consumed |= captured;
        if usage == TAB && !flags_block_tab(&key) {
            tab = Some(key.modifierFlags().contains(UIKeyModifierFlags::Shift));
        } else if let Some(stroke) = stroke
            && nsh_core::input::presses_focused_control(stroke.key, stroke.modifiers)
            && view.takes_presses()
        {
            activates = true;
        }
    }
    if consumed {
        return true;
    }
    let mut handled = false;
    if let Some(backward) = tab {
        handled |= tab_focus(view, &target, backward);
    }
    if activates && !handled {
        handled |= activate(view, &target);
    }
    handled
}

/// `pressesChanged:withEvent:`: UIKit documents no keyboard transition for
/// it (a held key's repeat is not reported), so nothing is notified. The
/// presses go on to the superclass.
pub(crate) fn changed(_view: &NshView, _presses: &NSSet<UIPress>) -> bool {
    false
}

/// `pressesEnded:withEvent:` of `view`: whether it consumed the releases.
/// A real release is reported on the view that has the focus now, even if
/// its press went elsewhere (the DOM's behavior).
pub(crate) fn ended(view: &NshView, presses: &NSSet<UIPress>) -> bool {
    view.isFirstResponder() && reported_ended(view, presses)
}

fn reported_ended(view: &NshView, presses: &NSSet<UIPress>) -> bool {
    let Some(target) = view.keyboard_target() else {
        return false;
    };
    if crate::keymap::ended(&target, presses) {
        return true;
    }
    let mtm = view.mtm();
    let state = target.keyboard();
    let listens = listens(view, &target);
    let mut handled = false;
    for press in presses.iter() {
        let Some(key) = press.key(mtm) else {
            continue;
        };
        let Some(usage) = usage(&key) else {
            continue;
        };
        let was_held = state.is_held(usage);
        let up = event(&key, usage, state, false);
        let stroke = crate::keymap::keystroke(&key);
        if listens || was_held {
            let mut reported = up;
            reported.default_prevented = captures(view, &target, stroke.as_ref());
            target.dispatch(view.id(), EventKind::KeyUp, EventPayload::Key(reported));
            handled = true;
        }
        state.up(usage);
    }
    handled
}

/// `pressesCancelled:withEvent:` of `view`: whether it consumed the
/// cancellations. None of them becomes a `KeyUp`: the source cancelled a
/// press instead of releasing it, so no release is invented. What the
/// cancelled keys held is forgotten.
pub(crate) fn cancelled(view: &NshView, presses: &NSSet<UIPress>) -> bool {
    view.isFirstResponder() && reported_cancelled(view, presses)
}

fn reported_cancelled(view: &NshView, presses: &NSSet<UIPress>) -> bool {
    let Some(target) = view.keyboard_target() else {
        return false;
    };
    let mut cleared = crate::keymap::ended(&target, presses);
    let mtm = view.mtm();
    let state = target.keyboard();
    let mut cancelled = false;
    for press in presses.iter() {
        let Some(key) = press.key(mtm) else {
            continue;
        };
        let Some(usage) = usage(&key) else {
            continue;
        };
        cleared |= state.up(usage);
        if modifier_mask(usage).is_some() {
            state.modifiers.borrow_mut().remove(&usage);
        }
        cancelled = true;
    }
    // A cancellation without a key (a remote's, a game controller's) says
    // the surface took no key input: forget whatever is held.
    if !cancelled && !cleared {
        state.clear();
    }
    cleared
}

/// The HID usage of `key`, if it is one.
fn usage(key: &UIKey) -> Option<u16> {
    u16::try_from(key.keyCode().0).ok()
}

/// Whether Command, Option or Control is held with a Tab (which is then no
/// focus traversal).
fn flags_block_tab(key: &UIKey) -> bool {
    key.modifierFlags().intersects(
        UIKeyModifierFlags::Command | UIKeyModifierFlags::Alternate | UIKeyModifierFlags::Control,
    )
}

/// The key event of `key`'s press (`down`) or release.
fn event(key: &UIKey, usage: u16, state: &Keyboard, down: bool) -> KeyEvent {
    event_from(
        usage,
        &key.characters().to_string(),
        &key.charactersIgnoringModifiers().to_string(),
        key.modifierFlags(),
        state,
        down,
    )
}

/// [`event`] from what a `UIKey` reports, for the tests.
fn event_from(
    usage: u16,
    characters: &str,
    ignoring_modifiers: &str,
    flags: UIKeyModifierFlags,
    state: &Keyboard,
    down: bool,
) -> KeyEvent {
    let key = match named_key(usage) {
        Some(name) => SharedString::new_static(name),
        None => reported_key(characters, ignoring_modifiers),
    };
    let mut event = KeyEvent::default();
    event.key = key;
    event.code = SharedString::new_static(dom_code(usage));
    event.modifiers = state.effective_modifiers(usage, flags, down);
    event.repeat = false;
    event
}

/// The logical key of a character key: the character the source reports
/// for this press, with its case and layout (`UIKey.characters`). Only
/// when that is nothing printable (a Control or Option chord's control
/// character, an empty composition) does the key fall back to the layout's
/// unmodified character (`charactersIgnoringModifiers`), and never to a US
/// layout guess.
fn reported_key(characters: &str, ignoring_modifiers: &str) -> SharedString {
    printable(characters)
        .or_else(|| printable(ignoring_modifiers))
        .map_or_else(
            || SharedString::new_static("Unidentified"),
            |text| SharedString::from(text.to_owned()),
        )
}

/// `text` when it is something printable: not empty and no control
/// character (a Control chord's `\u{1}`, Return's `\r`).
fn printable(text: &str) -> Option<&str> {
    (!text.is_empty() && !text.chars().any(char::is_control)).then_some(text)
}

/// F1 to F24, the names the DOM uses for both the logical key and the
/// code.
const F1_TO_F24: [&str; 24] = [
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15",
    "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
];

/// The name of a named key by its HID usage: the DOM's
/// `KeyboardEvent.key` spelling. Character keys (letters, digits,
/// punctuation, the keypad's) have none.
fn named_key(usage: u16) -> Option<&'static str> {
    Some(match usage {
        0x28 | 0x58 => "Enter",
        0x29 => "Escape",
        0x2A => "Backspace",
        0x2B => "Tab",
        0x2C => " ",
        0x39 => "CapsLock",
        0x3A..=0x45 => F1_TO_F24[usize::from(usage - 0x3A)],
        0x46 => "PrintScreen",
        0x47 => "ScrollLock",
        0x48 => "Pause",
        0x49 => "Insert",
        0x4A => "Home",
        0x4B => "PageUp",
        0x4C => "Delete",
        0x4D => "End",
        0x4E => "PageDown",
        0x4F => "ArrowRight",
        0x50 => "ArrowLeft",
        0x51 => "ArrowDown",
        0x52 => "ArrowUp",
        0x53 => "NumLock",
        0x65 => "ContextMenu",
        0x68..=0x73 => F1_TO_F24[usize::from(usage - 0x68) + 12],
        0x75 => "Help",
        0xE0 | 0xE4 => "Control",
        0xE1 | 0xE5 => "Shift",
        0xE2 | 0xE6 => "Alt",
        0xE3 | 0xE7 => "Meta",
        _ => return None,
    })
}

/// The DOM `KeyboardEvent.code` of a USB HID usage: the key's physical
/// place on any layout (`"KeyA"` for usage `0x04`, whatever character the
/// layout gives it), as the UI Events code values name it. `""` for a
/// usage this backend has no code for, never a code derived from the
/// character it types.
fn dom_code(usage: u16) -> &'static str {
    const A_TO_Z: [&str; 26] = [
        "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK",
        "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV",
        "KeyW", "KeyX", "KeyY", "KeyZ",
    ];
    const ONE_TO_ZERO: [&str; 10] = [
        "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
        "Digit0",
    ];
    const ONE_TO_NINE: [&str; 9] = [
        "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8",
        "Numpad9",
    ];
    match usage {
        0x04..=0x1D => A_TO_Z[usize::from(usage - 0x04)],
        0x1E..=0x27 => ONE_TO_ZERO[usize::from(usage - 0x1E)],
        0x28 => "Enter",
        0x29 => "Escape",
        0x2A => "Backspace",
        0x2B => "Tab",
        0x2C => "Space",
        0x2D => "Minus",
        0x2E => "Equal",
        0x2F => "BracketLeft",
        0x30 => "BracketRight",
        // The US `\|` key and the 102-key `#~` key share one code.
        0x31 | 0x32 => "Backslash",
        0x33 => "Semicolon",
        0x34 => "Quote",
        0x35 => "Backquote",
        0x36 => "Comma",
        0x37 => "Period",
        0x38 => "Slash",
        0x39 => "CapsLock",
        0x3A..=0x45 => F1_TO_F24[usize::from(usage - 0x3A)],
        0x46 => "PrintScreen",
        0x47 => "ScrollLock",
        0x48 => "Pause",
        0x49 => "Insert",
        0x4A => "Home",
        0x4B => "PageUp",
        0x4C => "Delete",
        0x4D => "End",
        0x4E => "PageDown",
        0x4F => "ArrowRight",
        0x50 => "ArrowLeft",
        0x51 => "ArrowDown",
        0x52 => "ArrowUp",
        0x53 => "NumLock",
        0x54 => "NumpadDivide",
        0x55 => "NumpadMultiply",
        0x56 => "NumpadSubtract",
        0x57 => "NumpadAdd",
        0x58 => "NumpadEnter",
        0x59..=0x61 => ONE_TO_NINE[usize::from(usage - 0x59)],
        0x62 => "Numpad0",
        0x63 => "NumpadDecimal",
        0x64 => "IntlBackslash",
        0x65 => "ContextMenu",
        0x66 => "Power",
        0x67 => "NumpadEqual",
        0x68..=0x73 => F1_TO_F24[usize::from(usage - 0x68) + 12],
        0x75 => "Help",
        0x87 => "IntlRo",
        0x88 => "KanaMode",
        0x89 => "IntlYen",
        0x8A => "Convert",
        0x8B => "NonConvert",
        0x90 => "Lang1",
        0x91 => "Lang2",
        0x92 => "Lang3",
        0x93 => "Lang4",
        0x94 => "Lang5",
        0xE0 => "ControlLeft",
        0xE1 => "ShiftLeft",
        0xE2 => "AltLeft",
        0xE3 => "MetaLeft",
        0xE4 => "ControlRight",
        0xE5 => "ShiftRight",
        0xE6 => "AltRight",
        0xE7 => "MetaRight",
        _ => "",
    }
}

/// Whether `view` or a logical ancestor hears raw keys or captures them:
/// only then is a `KeyEvent` built. The mounter's metadata covers every
/// managed node (a scroll view too), not just `NshView`s.
fn listens(view: &NshView, target: &EventTarget) -> bool {
    target.listens_keys(view.id()) || view.listens_key()
}

/// Whether the focused view or an enabled logical ancestor captures
/// `stroke` (the keymap's canonical keystroke) under its mounted
/// `capture_keys` rule.
fn captures(view: &NshView, target: &EventTarget, stroke: Option<&Keystroke>) -> bool {
    target.captures_stroke(view.id(), stroke) || view.captures_key(stroke)
}

/// The `UIKeyCommand`s that let an app shortcut or a mounted capture take
/// Tab before UIKit's focus system: one per bound or captured modifier
/// combination, with `wantsPriorityOverSystemBehavior`. Command+Tab is the
/// system's app switcher and is never registered.
pub(crate) fn tab_key_commands(
    view: &NshView,
    inherited: Option<Retained<NSArray<UIKeyCommand>>>,
) -> Option<Retained<NSArray<UIKeyCommand>>> {
    let Some(target) = view.keyboard_target() else {
        return inherited;
    };
    let control = view.takes_presses();
    let mut commands = inherited.map(|array| array.to_vec()).unwrap_or_default();
    for flags in tab_flag_combinations() {
        if !wants_tab_command(view, &target, control, flags) {
            continue;
        }
        let input = NSString::from_str("\t");
        // SAFETY: `nshTabKeyCommand:` is implemented by NshView, which owns
        // the command and outlives it; a Tab input is valid.
        let command = unsafe {
            UIKeyCommand::keyCommandWithInput_modifierFlags_action(
                &input,
                flags,
                sel!(nshTabKeyCommand:),
                view.mtm(),
            )
        };
        command.setWantsPriorityOverSystemBehavior(true);
        commands.push(command);
    }
    (!commands.is_empty()).then(|| NSArray::from_retained_slice(&commands))
}

/// The modifier combinations a Tab command can carry: Shift, Control and
/// Option in every combination. Command+Tab is the system's.
fn tab_flag_combinations() -> Vec<UIKeyModifierFlags> {
    let mut combinations = Vec::with_capacity(8);
    for shift in [false, true] {
        for ctrl in [false, true] {
            for alt in [false, true] {
                let mut flags = UIKeyModifierFlags::empty();
                if shift {
                    flags |= UIKeyModifierFlags::Shift;
                }
                if ctrl {
                    flags |= UIKeyModifierFlags::Control;
                }
                if alt {
                    flags |= UIKeyModifierFlags::Alternate;
                }
                combinations.push(flags);
            }
        }
    }
    combinations
}

/// Whether the focused view or an enabled logical ancestor captures Tab
/// with `flags`, or the app's keymap binds it.
fn wants_tab_command(
    view: &NshView,
    target: &EventTarget,
    control: bool,
    flags: UIKeyModifierFlags,
) -> bool {
    let stroke = Keystroke {
        key: Key::Tab,
        modifiers: modifiers_of(flags),
    };
    captures_tab(view, target, &stroke) || crate::keymap::tab_bound(target, &stroke, control)
}

/// Whether the focused view or an enabled logical ancestor captures Tab
/// with `stroke`.
fn captures_tab(view: &NshView, target: &EventTarget, stroke: &Keystroke) -> bool {
    target.captures_stroke(view.id(), Some(stroke)) || view.captures_key(Some(stroke))
}

/// `nshTabKeyCommand:`: the app's binding first, then the mounted capture
/// (a captured Tab stays), else the normal traversal the priority command
/// intercepted. A `UIKeyCommand` gives no HID usage, release or repeat, so
/// the event has `code: ""`, `repeat: false`, and no `KeyUp` follows.
pub(crate) fn tab_command(view: &NshView, command: &UIKeyCommand) {
    let Some(target) = view.keyboard_target() else {
        return;
    };
    if !view.isFirstResponder() || !view.is_focus_stop() {
        return;
    }
    let flags = command.modifierFlags();
    let stroke = Keystroke {
        key: Key::Tab,
        modifiers: modifiers_of(flags),
    };
    target.input_with(nsh_core::platform::InputModality::Keyboard);
    // The app's shortcuts keep their precedence over the capture, as a
    // UIPress's path does.
    if crate::keymap::tab_binding_consumes(&target, stroke, view.takes_presses()) {
        return;
    }
    let captured = captures_tab(view, &target, &stroke);
    if captured || listens(view, &target) {
        let mut event = KeyEvent::default();
        event.key = SharedString::new_static("Tab");
        event.modifiers = stroke.modifiers;
        event.repeat = false;
        event.default_prevented = captured;
        target.dispatch(view.id(), EventKind::KeyDown, EventPayload::Key(event));
    }
    if captured {
        return;
    }
    // The rule went away between the query and the press: the command
    // already stopped the system's traversal, so follow the normal one.
    let modifiers = stroke.modifiers;
    if !modifiers.ctrl && !modifiers.alt && !modifiers.cmd {
        tab_focus(view, &target, modifiers.shift);
    }
}

/// Tab / Shift+Tab from focused view `view`: the focus moves to the next or
/// previous stop in its window (the modal it is in, when one is presented),
/// wrapping around. True when another stop took the focus.
fn tab_focus(view: &NshView, target: &EventTarget, backward: bool) -> bool {
    tab_from(view, target, backward)
}

/// Raw keys delivered to the surface root while it has the keyboard focus
/// (no view or input focused): the root hears them and they bubble from
/// there, as a browser reports them at `document.body`. The root is no
/// stop, so nothing is pressed; Tab's traversal still follows
/// ([`root_tab`]) unless a capture took the key. True when a mounted
/// capture consumed a press.
pub(crate) fn root_raw(
    view: &UIView,
    target: &EventTarget,
    presses: &NSSet<UIPress>,
    down: bool,
) -> bool {
    if !view.isFirstResponder() {
        return false;
    }
    let id = view.tag() as nsh_core::NodeId;
    let listens = target.listens_keys(id);
    let mtm = MainThreadMarker::from(view);
    let state = target.keyboard();
    let mut consumed = false;
    for press in presses.iter() {
        let Some(key) = press.key(mtm) else {
            continue;
        };
        let Some(usage) = usage(&key) else {
            continue;
        };
        let was_held = state.is_held(usage);
        let mut reported = event(&key, usage, state, down);
        if down {
            state.down(usage);
        } else {
            state.up(usage);
        }
        if !listens && !(was_held && !down) {
            continue;
        }
        let stroke = crate::keymap::keystroke(&key);
        let captured = target.captures_stroke(id, stroke.as_ref());
        reported.default_prevented = captured;
        let kind = if down {
            EventKind::KeyDown
        } else {
            EventKind::KeyUp
        };
        target.dispatch(id, kind, EventPayload::Key(reported));
        consumed |= captured;
    }
    consumed
}

/// Tab / Shift+Tab delivered to the surface root while it has the keyboard
/// focus: UIKit sends a hardware key to the first responder, and before a
/// view or input takes the focus the root owns that role (its
/// `canBecomeFirstResponder`), so the first Tab reaches the first stop and
/// Shift+Tab the last. No focused view is in the stop list; `tab_from`
/// starts at the matching end.
pub(crate) fn root_tab(view: &UIView, target: &EventTarget, presses: &NSSet<UIPress>) -> bool {
    if !view.isFirstResponder() {
        return false;
    }
    let mtm = MainThreadMarker::from(view);
    let mut backward = None;
    for press in presses.iter() {
        let Some(key) = press.key(mtm) else {
            continue;
        };
        let Some(usage) = usage(&key) else {
            continue;
        };
        if usage == TAB && !flags_block_tab(&key) {
            backward = Some(key.modifierFlags().contains(UIKeyModifierFlags::Shift));
        }
    }
    backward.is_some_and(|backward| tab_from(view, target, backward))
}

/// Moves the focus from `view` (a focused view, or the root with no view
/// focused) to the next or previous stop of its window or modal, wrapping
/// around. True when another stop took the focus.
fn tab_from(view: &UIView, target: &EventTarget, backward: bool) -> bool {
    let Some(window) = view.window() else {
        return false;
    };
    let scope = target
        .focus_scope(view)
        .unwrap_or_else(|| Retained::into_super(window));
    let mut stops = Vec::new();
    collect_stops(&scope, &mut stops);
    if stops.is_empty() {
        return false;
    }
    let current = stops
        .iter()
        .position(|stop| std::ptr::eq::<UIView>(&**stop, view));
    let mut at = current;
    for _ in 0..stops.len() {
        let Some(next) = nsh_core::input::tab_stop(at, stops.len(), backward, true) else {
            return false;
        };
        if std::ptr::eq::<UIView>(&*stops[next], view) {
            return false;
        }
        if stops[next].becomeFirstResponder() {
            request_focus(&stops[next]);
            return true;
        }
        at = Some(next);
    }
    false
}

/// The surface root takes the keyboard back when its window has no first
/// responder left: the root `ref.blur()` or a removed view left no one to
/// receive hardware keys. Called on a later turn, so a focus transfer to a
/// native input, a hosted view or another custom view (all first responders
/// in the window) keeps the focus; a modal's view is not the surface root,
/// so its scope is never replaced by the background root.
pub(crate) fn root_focus_if_none(root: &UIView, window: &UIWindow) {
    if root.tag() != nsh_core::ROOT_ID as isize {
        return;
    }
    if root
        .window()
        .is_none_or(|current| !std::ptr::eq::<UIWindow>(&*current, window))
    {
        return;
    }
    if has_responder(window) {
        return;
    }
    let _ = root.becomeFirstResponder();
}

/// Whether `responder` is the surface root holding the hardware keys
/// because nothing else had the focus ([`root_focus_if_none`]). Code that
/// returns the focus to a control only where none has it treats this
/// responder as no focus.
pub(crate) fn is_root_focus(responder: &UIView) -> bool {
    responder.tag() == nsh_core::ROOT_ID as isize
}

/// Whether `view` or any view below it is the first responder. A native
/// input's field editor and a hosted view's content are views in the tree,
/// so a transfer to either counts before the root is restored.
fn has_responder(view: &UIView) -> bool {
    view.isFirstResponder() || view.subviews().iter().any(|sub| has_responder(&sub))
}

/// The focus stops of `scope` in the native view tree's order: inputs that
/// edit and visible `focusable` views.
fn collect_stops(view: &UIView, stops: &mut Vec<Retained<UIView>>) {
    for sub in view.subviews() {
        if sub.isHidden() || sub.alpha() <= 0.01 {
            continue;
        }
        if is_stop(&sub) && visible(&sub) {
            stops.push(sub.clone());
        }
        collect_stops(&sub, stops);
    }
}

/// Whether `touch` is on a stop inside `view` (`view` itself is not asked):
/// the keyboard focus a touch moves goes to the innermost stop under it.
pub(crate) fn stop_inside(touch: &UITouch, view: &UIView) -> bool {
    let mut current = touch.view();
    while let Some(v) = current {
        if std::ptr::eq::<UIView>(&*v, view) {
            return false;
        }
        if is_stop(&v) {
            return true;
        }
        current = v.superview();
    }
    false
}

fn is_stop(view: &UIView) -> bool {
    if let Some(view) = view.downcast_ref::<NshView>() {
        return view.is_focus_stop() && view.canBecomeFirstResponder();
    }
    if view.downcast_ref::<Field>().is_some() || view.downcast_ref::<Area>().is_some() {
        // A disabled field or a read-only area decides natively.
        return view.canBecomeFirstResponder();
    }
    false
}

/// Whether `view` and its ancestors are shown (a hidden or transparent
/// ancestor hides it) and it is in a window: a stop Tab and UIKit's focus
/// engine move the focus to.
pub(crate) fn visible(view: &UIView) -> bool {
    in_window(view, true)
}

/// Whether `view` and its ancestors are not hidden and it is in a window,
/// whatever their opacity: a stop the first responder can move to as
/// `ref.focus()` asks, as on the other platforms, where opacity keeps no
/// focus away. A popup that comes in from `opacity: 0` (its starting look)
/// is transparent as its items ask for the focus.
pub(crate) fn shown(view: &UIView) -> bool {
    in_window(view, false)
}

/// Whether `view` and its ancestors are not hidden, nor transparent when
/// `opaque`, and it is in a window.
fn in_window(view: &UIView, opaque: bool) -> bool {
    let mut current: Option<Retained<UIView>> = Some(view.retain());
    while let Some(v) = current {
        if v.isHidden() || (opaque && v.alpha() <= 0.01) {
            return false;
        }
        current = v.superview();
    }
    view.window().is_some()
}

/// Moves UIKit's focus system to `view` after a responder change the system
/// did not initiate (`ref.focus()`, our own Tab traversal). The focus engine
/// then continues from this item (its own Tab traversal) and the surface's
/// `didUpdateFocusInContext:` sees the same view. Nothing happens where the
/// window has no focus system.
pub(crate) fn request_focus(view: &UIView) {
    let environment: &ProtocolObject<dyn UIFocusEnvironment> = ProtocolObject::from_ref(view);
    if let Some(system) = UIFocusSystem::focusSystemForEnvironment(environment) {
        system.requestFocusUpdateToEnvironment(environment);
    }
}

/// `didUpdateFocusInContext:` of the surface: UIKit's focus engine chose
/// `nextFocusedView`, so that view becomes the first responder (hardware
/// keys follow the focused item) and a view or input of ours that lost the
/// focus gives it up. An embedded native component's own focusable controls
/// are left to the component (the previous responder still resigns, so its
/// keys do not leak).
#[allow(deprecated)]
pub(crate) fn adopt_focus(context: &UIFocusUpdateContext) {
    let next = context.nextFocusedView();
    let previous = context.previouslyFocusedView();
    let Some(next) = next else {
        // UIKit reports no next view when a text field's own editor takes the
        // focus (the field editor is not a focus item), and when the focus
        // engine merely re-evaluates. Resigning here dismissed the keyboard
        // after the first keystroke. A field that is still the first
        // responder keeps it; only a view that is no longer in a window gives
        // it up.
        if let Some(previous) = previous.as_deref()
            && is_ours(previous)
            && previous.window().is_none()
        {
            let _ = previous.resignFirstResponder();
        }
        return;
    };
    let accepted = if let Some(view) = next.downcast_ref::<NshView>() {
        view.is_focus_stop() && view.becomeFirstResponder()
    } else if next.downcast_ref::<Field>().is_some() || next.downcast_ref::<Area>().is_some() {
        next.becomeFirstResponder()
    } else {
        false
    };
    if !accepted
        && let Some(previous) = previous.as_deref()
        && is_ours(previous)
        && previous.isFirstResponder()
    {
        let _ = previous.resignFirstResponder();
    }
}

/// A view whose keys this surface owns: its focusable views and the editor
/// views of its inputs.
fn is_ours(view: &UIView) -> bool {
    view.downcast_ref::<NshView>().is_some()
        || view.downcast_ref::<Field>().is_some()
        || view.downcast_ref::<Area>().is_some()
}

/// Return or Space pressed the focused control: its `onPressDown`,
/// `onPressUp` and `onPress`, as the same key does on the other backends.
fn activate(view: &NshView, target: &EventTarget) -> bool {
    if !view.takes_presses() {
        return false;
    }
    let events = view.events();
    let id = view.id();
    let mut pressed = false;
    for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
        if events.contains(kind) {
            target.dispatch(id, kind, EventPayload::None);
            pressed = true;
        }
    }
    pressed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(usage: u16, characters: &str, ignoring: &str, down: bool) -> KeyEvent {
        event_from(
            usage,
            characters,
            ignoring,
            UIKeyModifierFlags::empty(),
            &Keyboard::default(),
            down,
        )
    }

    #[test]
    fn named_keys_use_the_doms_spelling() {
        for (usage, name) in [
            (0x28, "Enter"),
            (0x58, "Enter"),
            (0x29, "Escape"),
            (0x2A, "Backspace"),
            (0x2B, "Tab"),
            (0x2C, " "),
            (0x4C, "Delete"),
            (0x4F, "ArrowRight"),
            (0x50, "ArrowLeft"),
            (0x51, "ArrowDown"),
            (0x52, "ArrowUp"),
            (0x3A, "F1"),
            (0x45, "F12"),
            (0x68, "F13"),
            (0x73, "F24"),
            (0xE1, "Shift"),
            (0xE4, "Control"),
            (0xE6, "Alt"),
            (0xE3, "Meta"),
        ] {
            assert_eq!(named_key(usage), Some(name), "{usage:#04x}");
        }
        // Character keys have no name: their reported character is the key.
        assert_eq!(named_key(0x04), None);
        assert_eq!(event(0x04, "a", "a", true).key.as_str(), "a");
        // A layout's own character, not the US layout's.
        assert_eq!(event(0x1E, "&", "&", true).key.as_str(), "&");
        assert_eq!(event(0x38, "/", "/", true).key.as_str(), "/");
        // A key that types nothing stays in the event.
        assert_eq!(event(0x39, "", "", true).key.as_str(), "CapsLock");
        assert_eq!(event(0xFFFF, "", "", true).key.as_str(), "Unidentified");
    }

    #[test]
    fn hid_usages_map_to_the_doms_codes() {
        assert_eq!(dom_code(0x04), "KeyA");
        assert_eq!(dom_code(0x1D), "KeyZ");
        assert_eq!(dom_code(0x1E), "Digit1");
        assert_eq!(dom_code(0x27), "Digit0");
        assert_eq!(dom_code(0x28), "Enter");
        // The keypad's Enter is its own physical key.
        assert_eq!(dom_code(0x58), "NumpadEnter");
        // The US `\|` and the 102-key `#~` share the DOM's code.
        assert_eq!(dom_code(0x31), "Backslash");
        assert_eq!(dom_code(0x32), "Backslash");
        assert_eq!(dom_code(0x64), "IntlBackslash");
        assert_eq!(dom_code(0x3A), "F1");
        assert_eq!(dom_code(0x68), "F13");
        assert_eq!(dom_code(0xE1), "ShiftLeft");
        assert_eq!(dom_code(0xE5), "ShiftRight");
        // No identity: never guessed from the key.
        assert_eq!(dom_code(0xFFFF), "");
        assert_eq!(event(0xFFFF, "a", "a", true).code.as_str(), "");
        // The code is the physical key, whatever character it types.
        let french = event(0x1E, "&", "&", true);
        assert_eq!(french.key.as_str(), "&");
        assert_eq!(french.code.as_str(), "Digit1");
    }

    #[test]
    fn a_press_reports_no_text_and_a_release_names_the_same_key() {
        let down = event(0x04, "A", "a", true);
        assert_eq!(down.key.as_str(), "A");
        assert_eq!(down.code.as_str(), "KeyA");
        assert!(!down.repeat);
        assert!(!down.default_prevented);

        let up = event(0x04, "A", "a", false);
        assert_eq!(up.key.as_str(), "A");
        assert_eq!(up.code.as_str(), "KeyA");
    }

    #[test]
    fn reported_characters_keep_their_case_and_layout() {
        use UIKeyModifierFlags as F;
        // Shift+A and Caps Lock report `A`: the key keeps it.
        for flags in [F::Shift, F::AlphaShift] {
            let event = event_from(0x04, "A", "a", flags, &Keyboard::default(), true);
            assert_eq!(event.key.as_str(), "A", "{flags:?}");
        }
        // A non-US shift (Cyrillic) is the layout's, never the US key's.
        let cyrillic = event_from(0x04, "Ж", "ж", F::Shift, &Keyboard::default(), true);
        assert_eq!(cyrillic.key.as_str(), "Ж");
        // A Control chord reports a control character: the key falls back
        // to the layout's unmodified character.
        let control = event_from(0x04, "\u{1}", "a", F::Control, &Keyboard::default(), true);
        assert_eq!(control.key.as_str(), "a");
        assert_eq!(control.code.as_str(), "KeyA");
        // An Option chord that composes nothing printable falls back too.
        let option = event_from(0x04, "", "e", F::Alternate, &Keyboard::default(), true);
        assert_eq!(option.key.as_str(), "e");
    }

    #[test]
    fn two_shifts_keep_the_mask_until_both_are_up() {
        use UIKeyModifierFlags as F;
        let keyboard = Keyboard::default();
        assert!(keyboard.effective_modifiers(0xE1, F::Shift, true).shift);
        assert!(keyboard.effective_modifiers(0xE5, F::Shift, true).shift);
        assert!(
            keyboard.effective_modifiers(0xE1, F::Shift, false).shift,
            "the right Shift still holds Shift"
        );
        assert!(!keyboard.effective_modifiers(0xE5, F::Shift, false).shift);
    }

    #[test]
    fn a_modifier_held_before_the_focus_is_trusted() {
        use UIKeyModifierFlags as F;
        let keyboard = Keyboard::default();
        // UIKit reports Shift for a key while no physical Shift was seen.
        assert!(keyboard.effective_modifiers(0x04, F::Shift, true).shift);
        // Seeing the left Shift press accounts for it, so its release
        // clears Shift.
        assert!(keyboard.effective_modifiers(0xE1, F::Shift, true).shift);
        assert!(!keyboard.effective_modifiers(0xE1, F::Shift, false).shift);
    }

    #[test]
    fn clearing_forgets_held_keys_without_events() {
        let keyboard = Keyboard::default();
        keyboard.down(0x04);
        keyboard.clear();
        assert!(!keyboard.is_held(0x04));
    }
}
