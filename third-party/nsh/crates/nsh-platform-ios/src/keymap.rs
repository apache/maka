//! The app's keyboard shortcuts (`nsh/keymap`) on a hardware keyboard
//! (an iPad's, a Mac's under Catalyst, the simulator's): the table the
//! engine mounts ([`MountItem::Keymap`](nsh_core::MountItem::Keymap)),
//! matched against every key press on the spot.
//!
//! UIKit hands a hardware key to the first responder as a press
//! (`pressesBegan:withEvent:`), which passes what it does not handle up the
//! responder chain. The text inputs (`input::Field`, `input::Area`) look at
//! the table before UIKit's text system does, so a binding that fires in
//! text (`when: "always"`, or a keystroke that edits no text) takes the key
//! there and the input never sees it: no caret move, no line break, no
//! typed character. A focusable custom view ([`crate::keyboard`]) does the
//! same before it reports raw keys. Presses nothing handled reach the
//! surface's root view (`surface::RootView`), which matches them as the
//! desktops do when the focus is on none of the app's inputs: a press from
//! a hosted view (a web view, a native component) counts as in text.
//!
//! A key that fires a binding is consumed until it is released (its
//! release is consumed too) and reported to JS with the root's
//! `KeyCommand` event; JS runs the handler afterwards. Keys are named by
//! their USB HID usage (their place on the US layout) for the keys that
//! type nothing, and by the character they type without modifiers
//! otherwise, the US layout's of the same key when that is no ASCII, as on
//! the desktops. UIKit sends a held key's press once: a binding that
//! repeats (`repeat: true`) fires again on a timer of its own while the key
//! is held, at the system's usual pace.

use std::{
    cell::{Cell, RefCell},
    sync::Arc,
    time::Duration,
};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, KeyMatch, Keymap, Keystroke, Modifiers},
};
use objc2::{MainThreadMarker, rc::Retained};
use objc2_foundation::NSSet;
use objc2_ui_kit::{UIKey, UIKeyModifierFlags, UIPress, UIView};

use crate::target::EventTarget;

/// How long a key is held before it repeats, and the time between repeats:
/// iOS's defaults for a hardware keyboard.
const REPEAT_DELAY: Duration = Duration::from_millis(400);
const REPEAT_INTERVAL: Duration = Duration::from_millis(100);

/// A surface's table, and the keys it consumed that are still down.
#[derive(Default)]
pub(crate) struct KeymapState {
    table: RefCell<Option<Arc<Keymap>>>,
    /// Keys whose press the table consumed, by HID usage, with the binding
    /// that repeats while they are held, if any.
    held: RefCell<Vec<(isize, Option<u32>)>>,
    /// Bumped by every press and release: a repeat timer of an older
    /// generation stops.
    generation: Cell<u64>,
}

impl KeymapState {
    /// `MountItem::Keymap`: replaces the table.
    pub(crate) fn set(&self, keymap: Arc<Keymap>) {
        *self.table.borrow_mut() = (!keymap.is_empty()).then_some(keymap);
    }

    /// Whether the table has bindings: presses need no look otherwise.
    fn active(&self) -> bool {
        self.table.borrow().is_some() || !self.held.borrow().is_empty()
    }
}

/// The presses of a `UIPress` set, with their keys (`UIKey`); presses of
/// no key (a remote's, a game controller's) are left out.
fn keys(presses: &NSSet<UIPress>, mtm: MainThreadMarker) -> Vec<Retained<UIKey>> {
    presses.iter().filter_map(|press| press.key(mtm)).collect()
}

/// `UIKey.keyCode`: the key's USB HID usage.
fn code(key: &UIKey) -> isize {
    key.keyCode().0
}

/// The modifiers `UIKey` reports.
fn modifiers(key: &UIKey) -> Modifiers {
    let flags = key.modifierFlags();
    Modifiers {
        ctrl: flags.contains(UIKeyModifierFlags::Control),
        alt: flags.contains(UIKeyModifierFlags::Alternate),
        shift: flags.contains(UIKeyModifierFlags::Shift),
        cmd: flags.contains(UIKeyModifierFlags::Command),
    }
}

/// The canonical keystroke of `key` (a `UIKey`), by its key on the US
/// layout: the shortcut spelling mounted `capture_keys` rules and the app's
/// keymap both use, whatever character the layout actually reports.
pub(crate) fn keystroke(key: &UIKey) -> Option<Keystroke> {
    let flags = key.modifierFlags();
    let shift = flags.contains(UIKeyModifierFlags::Shift);
    let typed = key.charactersIgnoringModifiers().to_string();
    let usage = u16::try_from(code(key)).ok()?;
    let modifiers = modifiers(key);
    let key = match Key::from_hid_usage(usage)? {
        // A key that types a character: the one it types without
        // modifiers. UIKit may leave Shift applied (`?` for Shift+/): then
        // the key's own, which the US layout names.
        us @ Key::Char(c) if c != ' ' => match typed.chars().next() {
            Some(c) if c.is_ascii_alphabetic() => Key::Char(c.to_ascii_lowercase()),
            Some(c) if c.is_ascii_graphic() && !shift => Key::Char(c),
            _ => us,
        },
        named => named,
    };
    Some(Keystroke { modifiers, key })
}

/// Tells the core a hardware key went down (`focus-visible:`), unless
/// `presses` are modifiers alone (HID usages Caps Lock and 0xE0 to 0xE7,
/// the Control, Shift, Option and Command keys).
fn keyboard_input(target: &EventTarget, presses: &NSSet<UIPress>, mtm: MainThreadMarker) {
    let modifier = |code: isize| code == 0x39 || (0xE0..=0xE7).contains(&code);
    if keys(presses, mtm).iter().any(|key| !modifier(code(key))) {
        target.input_with(nsh_core::platform::InputModality::Keyboard);
    }
}

/// `pressesBegan:withEvent:` of a responder of the surface: whether the
/// table consumed `presses` (then the responder neither handles them nor
/// passes them on). `editing`: a text input or hosted view has the focus;
/// `control`: a view that takes presses has it, so Return and Space are
/// its own first ([`Keymap::find_at`]).
pub(crate) fn began(
    target: &EventTarget,
    presses: &NSSet<UIPress>,
    editing: bool,
    control: bool,
) -> bool {
    let mtm = MainThreadMarker::from(target);
    keyboard_input(target, presses, mtm);
    let state = target.keymap();
    if !state.active() {
        return false;
    }
    let mut consumed = false;
    for key in keys(presses, mtm) {
        let code = code(&key);
        // UIKit sends a key's press once: one already held lost its
        // release to a responder elsewhere (the focus moved), so it is
        // pressed anew.
        state.held.borrow_mut().retain(|(held, _)| *held != code);
        let Some(stroke) = keystroke(&key) else {
            continue;
        };
        let Some(table) = state.table.borrow().clone() else {
            continue;
        };
        // The dev host's Cmd+R reloads, whatever the app binds.
        if cfg!(feature = "dev") && stroke.reloads(nsh_core::platform::Os::Ios) {
            continue;
        }
        // Presses come once: no auto-repeat to match (`KeyMatch::Held`).
        let id = match table.find_at(ROOT_ID, stroke, editing, control, false) {
            KeyMatch::Fire(id) => id,
            // Reported, and the press goes on to the responders (Tab
            // moves the focus); its release is theirs too.
            KeyMatch::Notify(id) => {
                fire(target, id);
                continue;
            }
            KeyMatch::None | KeyMatch::Held => continue,
        };
        fire(target, id);
        let repeats = table.bindings().iter().any(|b| b.id == id && b.repeat);
        state.held.borrow_mut().push((code, repeats.then_some(id)));
        if repeats {
            let generation = state.generation.get() + 1;
            state.generation.set(generation);
            schedule(target, code, generation, REPEAT_DELAY);
        }
        consumed = true;
    }
    consumed
}

/// `pressesEnded:` / `pressesCancelled:`: whether `presses` are releases
/// of keys the table consumed (then they are consumed too).
pub(crate) fn ended(target: &EventTarget, presses: &NSSet<UIPress>) -> bool {
    let state = target.keymap();
    if state.held.borrow().is_empty() {
        return false;
    }
    let mtm = MainThreadMarker::from(target);
    let mut consumed = false;
    for key in keys(presses, mtm) {
        let code = code(&key);
        let mut held = state.held.borrow_mut();
        if let Some(i) = held.iter().position(|(h, _)| *h == code) {
            held.remove(i);
            state.generation.set(state.generation.get() + 1);
            consumed = true;
        }
    }
    consumed
}

/// Reports binding `id` to JS.
fn fire(target: &EventTarget, id: u32) {
    target.dispatch(
        ROOT_ID,
        EventKind::KeyCommand,
        EventPayload::Value(PayloadValue::Number(f64::from(id))),
    );
}

/// A Tab delivered as a `UIKeyCommand` (`wantsPriorityOverSystemBehavior`,
/// which has no `UIPress`): runs the app's binding for it first, as a press
/// does. True when a binding consumed the key; a pass-through binding fires
/// and the key goes on. `control`: the focused view takes presses
/// ([`Keymap::find_at`]).
pub(crate) fn tab_binding_consumes(target: &EventTarget, stroke: Keystroke, control: bool) -> bool {
    match tab_match(target, &stroke, control) {
        KeyMatch::Fire(id) => {
            fire(target, id);
            true
        }
        KeyMatch::Notify(id) => {
            fire(target, id);
            false
        }
        KeyMatch::None | KeyMatch::Held => false,
    }
}

/// Whether the app's keymap would fire or report Tab `stroke` here: the
/// focused view's Tab is taken before UIKit's focus traversal, so a
/// priority `UIKeyCommand` is registered for it ([`crate::keyboard`]).
pub(crate) fn tab_bound(target: &EventTarget, stroke: &Keystroke, control: bool) -> bool {
    !matches!(tab_match(target, stroke, control), KeyMatch::None)
}

fn tab_match(target: &EventTarget, stroke: &Keystroke, control: bool) -> KeyMatch {
    let state = target.keymap();
    let Some(table) = state.table.borrow().clone() else {
        return KeyMatch::None;
    };
    table.find_at(ROOT_ID, *stroke, false, control, false)
}

/// Fires the repeating binding of held key `code` again after `delay`,
/// and on, while it is held and nothing else was pressed.
fn schedule(target: &EventTarget, code: isize, generation: u64, delay: Duration) {
    let mtm = MainThreadMarker::from(target);
    let weak = dispatch2::MainThreadBound::new(objc2::rc::Weak::from(target), mtm);
    let when = dispatch2::DispatchTime::NOW.time(delay.as_nanos() as i64);
    dispatch2::DispatchQueue::main()
        .after(when, move || {
            let mtm = MainThreadMarker::new().expect("main queue");
            let Some(target) = weak.into_inner(mtm).load() else {
                return;
            };
            let state = target.keymap();
            if state.generation.get() != generation {
                return;
            }
            let binding = state
                .held
                .borrow()
                .iter()
                .find(|(held, _)| *held == code)
                .and_then(|(_, binding)| *binding);
            // The binding may have gone with its component.
            let bound = state
                .table
                .borrow()
                .as_ref()
                .is_some_and(|t| t.bindings().iter().any(|b| Some(b.id) == binding));
            if let (Some(id), true) = (binding, bound) {
                fire(&target, id);
                schedule(&target, code, generation, REPEAT_INTERVAL);
            }
        })
        .ok();
}

/// `pressesBegan:withEvent:` of text input `view`: whether the table
/// consumed `presses`. While an input method composes, its keys are its
/// own (choosing a candidate, committing).
pub(crate) fn input_began(view: &UIView, presses: &NSSet<UIPress>) -> bool {
    if crate::input::marked_text(view).is_some() {
        return false;
    }
    crate::input::target_of(view).is_some_and(|target| began(&target, presses, true, false))
}

/// `pressesEnded:` / `pressesCancelled:` of text input `view`.
pub(crate) fn input_ended(view: &UIView, presses: &NSSet<UIPress>) -> bool {
    crate::input::target_of(view).is_some_and(|target| ended(&target, presses))
}

/// `pressesBegan:withEvent:` of the surface's root view, which gets the
/// presses no responder inside it handled: whether the table consumed
/// them. The app's text inputs and focusable views matched theirs already;
/// a press from another view taking text (a web view's, a native
/// component's) is in text.
pub(crate) fn root_began(target: &EventTarget, presses: &NSSet<UIPress>) -> bool {
    use objc2::ProtocolType;

    let mtm = MainThreadMarker::from(target);
    keyboard_input(target, presses, mtm);
    let responder = presses.iter().find_map(|press| press.responder(mtm));
    let editing = match responder.as_deref() {
        Some(r)
            if r.downcast_ref::<crate::input::Field>().is_some()
                || r.downcast_ref::<crate::input::Area>().is_some() =>
        {
            return false;
        }
        // A focusable view ran the table (and its raw keys) before passing
        // the press on: running it here again would fire a binding twice.
        Some(r)
            if r.downcast_ref::<crate::native_view::NshView>()
                .is_some_and(|view| view.keyboard_target().is_some()) =>
        {
            return false;
        }
        Some(r) => {
            let text = <dyn objc2_ui_kit::UIKeyInput>::protocol()
                .is_some_and(|p| r.class().conforms_to(p));
            // The app's own texts take keys only to select (`TextView`).
            text && r.downcast_ref::<crate::native_view::NshView>().is_none()
                && r.downcast_ref::<crate::selectable_view::AreaResponder>()
                    .is_none()
        }
        None => false,
    };
    began(target, presses, editing, false)
}
