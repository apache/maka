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
//! typed character. Presses nothing handled reach the surface's root view
//! (`surface::RootView`), which matches them as the desktops do when the
//! focus is on none of the app's inputs: a press from a hosted view (a web
//! view, a native component) counts as in text.
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
use objc2::{MainThreadMarker, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSArray, NSString};
use objc2_ui_kit::UIView;

use crate::target::EventTarget;

/// How long a key is held before it repeats, and the time between repeats:
/// iOS's defaults for a hardware keyboard.
const REPEAT_DELAY: Duration = Duration::from_millis(400);
const REPEAT_INTERVAL: Duration = Duration::from_millis(100);

/// `UIKeyModifierFlags`.
const SHIFT: isize = 1 << 17;
const CONTROL: isize = 1 << 18;
const ALTERNATE: isize = 1 << 19;
const COMMAND: isize = 1 << 20;

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
fn keys(presses: &AnyObject) -> Vec<Retained<AnyObject>> {
    // SAFETY: `presses` is the `NSSet<UIPress *>` UIKit passes; `key` is
    // UIPress's (iOS 13.4, below the deployment target).
    unsafe {
        let all: Retained<NSArray<AnyObject>> = msg_send![presses, allObjects];
        all.iter()
            .filter_map(|press| msg_send![&*press, key])
            .collect()
    }
}

/// `UIKey.keyCode`: the key's USB HID usage.
fn code(key: &AnyObject) -> isize {
    // SAFETY: UIKey's property.
    unsafe { msg_send![key, keyCode] }
}

/// The keystroke of `key` (a `UIKey`), by its key on the US layout.
fn keystroke(key: &AnyObject) -> Option<Keystroke> {
    // SAFETY: UIKey's properties.
    let (flags, typed): (isize, Option<Retained<NSString>>) = unsafe {
        (
            msg_send![key, modifierFlags],
            msg_send![key, charactersIgnoringModifiers],
        )
    };
    let modifiers = Modifiers {
        ctrl: flags & CONTROL != 0,
        alt: flags & ALTERNATE != 0,
        shift: flags & SHIFT != 0,
        cmd: flags & COMMAND != 0,
    };
    let usage = u16::try_from(code(key)).ok()?;
    let key = match Key::from_hid_usage(usage)? {
        // A key that types a character: the one it types without
        // modifiers. UIKit may leave Shift applied (`?` for Shift+/): then
        // the key's own, which the US layout names.
        us @ Key::Char(c) if c != ' ' => match typed.and_then(|s| s.to_string().chars().next()) {
            Some(c) if c.is_ascii_alphabetic() => Key::Char(c.to_ascii_lowercase()),
            Some(c) if c.is_ascii_graphic() && !modifiers.shift => Key::Char(c),
            _ => us,
        },
        named => named,
    };
    Some(Keystroke { modifiers, key })
}

/// `pressesBegan:withEvent:` of a responder of the surface: whether the
/// table consumed `presses` (then the responder neither handles them nor
/// passes them on). `editing`: a text input or hosted view has the focus.
pub(crate) fn began(target: &EventTarget, presses: &AnyObject, editing: bool) -> bool {
    let state = target.keymap();
    if !state.active() {
        return false;
    }
    let mut consumed = false;
    for key in keys(presses) {
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
        let KeyMatch::Fire(id) = table.find(stroke, editing, false) else {
            continue;
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
pub(crate) fn ended(target: &EventTarget, presses: &AnyObject) -> bool {
    let state = target.keymap();
    if state.held.borrow().is_empty() {
        return false;
    }
    let mut consumed = false;
    for key in keys(presses) {
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

/// The event target of text input `view` (its delegate).
fn input_target(view: &UIView) -> Option<Retained<EventTarget>> {
    // SAFETY: both input classes have a `delegate`, set to the target.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![view, delegate] };
    delegate?.downcast::<EventTarget>().ok()
}

/// `pressesBegan:withEvent:` of text input `view`: whether the table
/// consumed `presses`. While an input method composes, its keys are its
/// own (choosing a candidate, committing).
pub(crate) fn input_began(view: &UIView, presses: &AnyObject) -> bool {
    if crate::input::marked_text(view).is_some() {
        return false;
    }
    input_target(view).is_some_and(|target| began(&target, presses, true))
}

/// `pressesEnded:` / `pressesCancelled:` of text input `view`.
pub(crate) fn input_ended(view: &UIView, presses: &AnyObject) -> bool {
    input_target(view).is_some_and(|target| ended(&target, presses))
}

/// `pressesBegan:withEvent:` of the surface's root view, which gets the
/// presses no responder inside it handled: whether the table consumed
/// them. The app's text inputs matched theirs already; a press from
/// another view taking text (a web view's, a native component's) is in
/// text.
pub(crate) fn root_began(target: &EventTarget, presses: &AnyObject) -> bool {
    use objc2::ProtocolType;
    // SAFETY: as in `keys`; `responder` is UIPress's.
    let responder: Option<Retained<AnyObject>> = unsafe {
        let all: Retained<NSArray<AnyObject>> = msg_send![presses, allObjects];
        all.iter()
            .next()
            .and_then(|press| msg_send![&*press, responder])
    };
    let editing = match responder.as_deref() {
        Some(r)
            if r.downcast_ref::<crate::input::Field>().is_some()
                || r.downcast_ref::<crate::input::Area>().is_some() =>
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
    began(target, presses, editing)
}
