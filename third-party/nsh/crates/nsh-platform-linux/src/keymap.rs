//! The app's keyboard shortcuts (`nsh/keymap`): the table the engine
//! mounts ([`MountItem::Keymap`](nsh_core::MountItem::Keymap)) becomes a
//! global-scope `gtk::ShortcutController` on the root view of each of the
//! app's windows (the main one and its own), one shortcut per binding,
//! newest first (GTK tries a controller's shortcuts in order).
//!
//! GTK matches the triggers, also on the keys of the layout's Latin group
//! under other layouts, as it does the application's accelerators. A
//! binding's action decides on the spot whether it fires (where the focus
//! is: `KeyBinding::in_text`; Return and Space on a focused control only
//! when `KeyBinding::for_focus`), reports it to JS with the root's
//! `KeyCommand` event and stops the key; JS runs the handler afterwards.
//! A binding that does not fire, or fires and passes the key through
//! (`KeyBinding::pass_through`), lets GTK try the next shortcut and then
//! the focus widget.
//!
//! A view that hears the raw keys ([`crate::keyboard`]) runs the bindings
//! itself, once, before it is notified ([`raw`]): the newest eligible
//! binding reports its `KeyCommand` there, as the controller would choose
//! it (an exact match before a Latin-group layout fallback), and its
//! shortcut's action does not report the same press again. Other views
//! keep the controller's path unchanged.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, ROOT_ID,
    keymap::{Key, KeyBinding, Keymap, Keystroke},
    platform::Os,
};

use crate::{surface::Surface, view::NshView};

/// A surface's shortcut controllers, while it has bindings.
#[derive(Default)]
pub(crate) struct KeymapState {
    /// The bindings.
    keymap: RefCell<Option<Arc<Keymap>>>,
    /// A controller on each window's root view.
    controllers: RefCell<Vec<(glib::WeakRef<NshView>, gtk::ShortcutController)>>,
    /// Each non-fallback binding's trigger, newest first, for [`claims`] and held-key replay.
    triggers: RefCell<Vec<(gtk::ShortcutTrigger, KeyBinding)>>,
    /// Fallback bindings' triggers, newest first, for [`unhandled`].
    fallbacks: RefCell<Vec<(gtk::ShortcutTrigger, KeyBinding)>>,
    /// Binding and press time, retained across a repeat's paired release.
    held: Rc<Cell<Option<(u32, u32)>>>,
    press_time: Rc<Cell<u32>>,
    raw_fired: Cell<bool>,
    /// The windows' key controllers that track presses and releases.
    key_events: RefCell<Vec<(glib::WeakRef<gtk::Window>, gtk::EventControllerKey)>>,
}

/// `MountItem::Keymap`: replaces the surface's shortcuts.
pub(crate) fn set(surface: &Rc<Surface>, keymap: Arc<Keymap>) {
    // A render can change bindings while a key is down. Keep tracking its release.
    clear_bindings(surface);
    if keymap.is_empty() {
        return;
    }
    // What a press of the menus' shortcuts gives way to (`claims`) and how
    // a raw view's own dispatch runs them ([`raw`]).
    let display = surface.root.display();
    let mut triggers = Vec::new();
    let mut fallbacks = Vec::new();
    for binding in keymap.bindings().iter().rev() {
        if skipped(binding) {
            continue;
        }
        if let Some(trigger) = trigger(&binding.keystroke, |key| shifted(&display, key))
            .and_then(|t| gtk::ShortcutTrigger::parse_string(&t))
        {
            if binding.fallback {
                fallbacks.push((trigger, *binding));
            } else {
                triggers.push((trigger, *binding));
            }
        }
    }
    *surface.keymap.triggers.borrow_mut() = triggers;
    *surface.keymap.fallbacks.borrow_mut() = fallbacks;
    *surface.keymap.keymap.borrow_mut() = Some(keymap);
    attach(surface, &surface.root);
    for (_, root) in crate::window::roots(surface) {
        attach(surface, &root);
    }
}

/// The dev host's Ctrl+R reloads, whatever the app binds.
fn skipped(binding: &nsh_core::keymap::KeyBinding) -> bool {
    cfg!(feature = "dev") && binding.keystroke.reloads(Os::Linux)
}

/// Gives the root view of a window (`root`) the app's shortcuts: a window
/// of the app's own as it opens, every window as the bindings change.
pub(crate) fn attach(surface: &Rc<Surface>, root: &NshView) {
    let keymap = surface.keymap.keymap.borrow().clone();
    let Some(keymap) = keymap else {
        return;
    };
    let mut controllers = surface.keymap.controllers.borrow_mut();
    controllers.retain(|(r, _)| r.upgrade().is_some());
    if controllers
        .iter()
        .any(|(r, _)| r.upgrade().as_ref() == Some(root))
    {
        return;
    }
    let controller = gtk::ShortcutController::new();
    controller.set_scope(gtk::ShortcutScope::Global);
    // The window runs global controllers in their phase: in the bubble
    // phase the focused field (and its own capture controller) would see
    // the key first, and `when: "always"` could not take Ctrl+A from it.
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    let keys_ref = controller.downgrade();
    let display = root.display();
    // Only the window's own bindings (and JS's, of no window).
    let window = root.id();
    for binding in keymap.bindings().iter().rev() {
        if skipped(binding) || binding.fallback || binding.window.is_some_and(|w| w != window) {
            continue;
        }
        let Some(trigger) = trigger(&binding.keystroke, |key| shifted(&display, key))
            .and_then(|t| gtk::ShortcutTrigger::parse_string(&t))
        else {
            continue;
        };
        let weak = Rc::downgrade(surface);
        let keys = keys_ref.clone();
        let binding = *binding;
        // The widget is the root view of the window the key is in.
        let action = gtk::CallbackAction::new(move |widget, _| {
            let Some(root) = widget.downcast_ref::<NshView>() else {
                return glib::Propagation::Proceed;
            };
            match weak.upgrade() {
                Some(surface) if surface.input_paused.get() => glib::Propagation::Stop,
                Some(surface)
                    if keys
                        .upgrade()
                        .and_then(|c| c.current_event())
                        .is_some_and(|event| {
                            crate::text_input::hold_shortcut_event(&surface, &event)
                        }) =>
                {
                    glib::Propagation::Stop
                }
                Some(surface) if !controller_acts(&surface.keymap) => glib::Propagation::Proceed,
                Some(surface) if fires(&surface, root, false)(&binding) => {
                    fire(&surface, &binding, surface.keymap.press_time.get());
                    if binding.pass_through {
                        glib::Propagation::Proceed
                    } else {
                        glib::Propagation::Stop
                    }
                }
                _ => glib::Propagation::Proceed,
            }
        });
        controller.add_shortcut(gtk::Shortcut::new(Some(trigger), Some(action)));
    }
    root.add_controller(controller.clone());
    controllers.push((root.downgrade(), controller));
    if let Some(window) = root.root().and_downcast::<gtk::Window>() {
        watch_keys(surface, &window);
    }
}

/// Removes the surface's shortcuts (the app stopped).
pub(crate) fn clear(surface: &Surface) {
    clear_bindings(surface);
    for (window, keys) in surface.keymap.key_events.borrow_mut().drain(..) {
        if let Some(window) = window.upgrade() {
            window.remove_controller(&keys);
        }
    }
    surface.keymap.held.set(None);
    surface.keymap.press_time.set(0);
}

fn clear_bindings(surface: &Surface) {
    for (root, controller) in surface.keymap.controllers.borrow_mut().drain(..) {
        if let Some(root) = root.upgrade() {
            root.remove_controller(&controller);
        }
    }
    surface.keymap.triggers.borrow_mut().clear();
    surface.keymap.fallbacks.borrow_mut().clear();
    surface.keymap.keymap.borrow_mut().take();
}

fn fire(surface: &Rc<Surface>, binding: &KeyBinding, time: u32) {
    let held = &surface.keymap.held;
    if binding.repeat || held.get().is_none_or(|(id, _)| id != binding.id) {
        held.set(Some((binding.id, time)));
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(binding.id as f64)),
        );
        if binding.keystroke.key != Key::Escape && !binding.pass_through {
            crate::text_input::arm(surface);
        }
    }
}

/// Replays capture-phase shortcut matching for a held GDK key event.
pub(crate) fn press_gdk(surface: &Rc<Surface>, event: &gtk::gdk::Event) -> bool {
    if surface.input_paused.get() && !crate::text_input::is_replaying(surface) {
        return true;
    }
    let root = event
        .surface()
        .and_then(|s| crate::window::root_at(surface, &s))
        .unwrap_or_else(|| surface.root.clone());
    let fires = fires(surface, &root, false);
    let matched = surface
        .keymap
        .triggers
        .borrow()
        .iter()
        .find(|(trigger, binding)| {
            !binding.fallback
                && trigger.trigger(event, false) != gtk::gdk::KeyMatch::None
                && fires(binding)
        })
        .map(|(_, binding)| *binding);
    if let Some(binding) = matched {
        fire(surface, &binding, event.time());
        return !binding.pass_through;
    }
    false
}

/// Fallback bindings, run after the focused control, selection, scroll and
/// navigation all left `event` unhandled.
pub(crate) fn unhandled(
    surface: &Rc<Surface>,
    root: &NshView,
    event: Option<&gtk::gdk::Event>,
) -> bool {
    let Some(event) = event else {
        return false;
    };
    if surface.input_paused.get() && !crate::text_input::is_replaying(surface) {
        return true;
    }
    let fires = fires(surface, root, true);
    let matched = surface
        .keymap
        .fallbacks
        .borrow()
        .iter()
        .find(|(trigger, binding)| {
            trigger.trigger(event, false) != gtk::gdk::KeyMatch::None && fires(binding)
        })
        .map(|(_, binding)| *binding);
    if let Some(binding) = matched {
        fire(surface, &binding, event.time());
        return !binding.pass_through;
    }
    false
}

/// A key pressed without a GDK event (GTK takes no made-up ones; `nsh test
/// --target linux`): the newest binding of `stroke` that fires where the
/// focus is reports it, as its shortcut's action would. Whether it took
/// the key: false if none fired or the one that did passes it through.
#[cfg(any(feature = "dev", all(test, feature = "js")))]
pub(crate) fn press(surface: &Rc<Surface>, stroke: Keystroke) -> bool {
    press_in_phase(surface, stroke, false)
}

#[cfg(all(test, feature = "js"))]
pub(crate) fn press_fallback(surface: &Rc<Surface>, stroke: Keystroke) -> bool {
    press_in_phase(surface, stroke, true)
}

#[cfg(any(feature = "dev", all(test, feature = "js")))]
fn press_in_phase(surface: &Rc<Surface>, stroke: Keystroke, fallback: bool) -> bool {
    if surface.input_paused.get() && !crate::text_input::is_replaying(surface) {
        return true;
    }
    if cfg!(feature = "dev") && stroke.reloads(Os::Linux) {
        return false;
    }
    if crate::text_input::composing_focused(surface) {
        return false;
    }
    let Some(keymap) = surface.keymap.keymap.borrow().clone() else {
        return false;
    };
    let root = crate::window::key_root(surface);
    let Some((editing, control, path)) = focus_context(surface, &root) else {
        return false;
    };
    let found = if fallback {
        keymap.find_fallback_at_with(root.id(), stroke, editing, control, false, |id| {
            path.contains(&id)
        })
    } else {
        keymap.find_at_with(root.id(), stroke, editing, control, false, |id| {
            path.contains(&id)
        })
    };
    if let Some(id) = found.fired() {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        );
        if stroke.key != Key::Escape && found.consumed() {
            crate::text_input::arm(surface);
        }
    }
    found.consumed()
}

/// Whether a binding fires for `event` where the focus is: the application
/// menu's shortcuts (`chrome.rs`), whose controller the window runs first,
/// give way to it, as menus' key equivalents do on macOS. Any match counts,
/// a Latin-group partial fallback too: this asks whether the app's own
/// dispatch takes the key, and [`raw`] or the shortcut controller then
/// chooses the best matching binding.
pub(crate) fn claims(surface: &Surface, event: &gtk::gdk::Event) -> bool {
    if surface.input_paused.get() {
        return true;
    }
    // The root view of the window the key is in.
    let root = event
        .surface()
        .and_then(|s| crate::window::root_at(surface, &s))
        .unwrap_or_else(|| surface.root.clone());
    let fires = fires(surface, &root, false);
    surface
        .keymap
        .triggers
        .borrow()
        .iter()
        .any(|(trigger, binding)| {
            !binding.pass_through
                && trigger.trigger(event, false) != gtk::gdk::KeyMatch::None
                && fires(binding)
        })
}

/// Tracks native key events before GTK dispatches global shortcut actions.
fn watch_keys(surface: &Surface, window: &gtk::Window) {
    let mut events = surface.keymap.key_events.borrow_mut();
    events.retain(|(w, _)| w.upgrade().is_some());
    if events
        .iter()
        .any(|(w, _)| w.upgrade().as_ref() == Some(window))
    {
        return;
    }
    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    let press_time = surface.keymap.press_time.clone();
    keys.connect_key_pressed(move |keys, _, _, _| {
        press_time.set(keys.current_event_time());
        glib::Propagation::Proceed
    });
    let held = surface.keymap.held.clone();
    keys.connect_key_released(move |keys, _, _, _| {
        // A synthetic release paired with a repeat carries the original press time.
        let time = keys.current_event_time();
        if time == 0 || held.get().is_some_and(|(_, press)| time != press) {
            held.set(None);
        }
    });
    window.add_controller(keys.clone());
    events.push((window.downgrade(), keys));
}

/// What the app's bindings did with a key a raw view hears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawFire {
    /// No binding takes it: the raw view, its capture rule and the
    /// platform's defaults.
    None,
    /// A binding reported it and took it: nothing hears the key after.
    Consumed,
    /// A binding reported it and passes the key on: the raw view and the
    /// defaults still get it.
    Passed,
}

/// Forgets the press a previous raw dispatch ran the bindings for, so the
/// shortcut controller acts on the next press again.
pub(crate) fn forget(surface: &Surface) {
    surface.keymap.raw_fired.set(false);
}

/// Runs the app's bindings for a key a raw view hears, before the view is
/// notified: the binding whose trigger matches the event best where the
/// shortcut controller would take it (an exact match before a Latin-group
/// layout fallback) and whose window is the key's (its `pass_through`
/// respected). Reports it once (`KeyCommand`) and says what it did; the
/// controller then leaves the whole press alone ([`controller_acts`]), so
/// an older binding of the same keystroke cannot report or consume it
/// either.
pub(crate) fn raw(surface: &Surface, event: &gtk::gdk::Event, repeat: bool) -> RawFire {
    // This path makes the entire shortcut decision, even when a passing
    // binding's repeat reports nothing. The controller must not retry an
    // older match after it.
    surface.keymap.raw_fired.set(true);
    // The root view of the window the key is in.
    let root = event
        .surface()
        .and_then(|s| crate::window::root_at(surface, &s))
        .unwrap_or_else(|| surface.root.clone());
    let (fired, binding) = {
        let fires = fires(surface, &root, false);
        let triggers = surface.keymap.triggers.borrow();
        pick(&triggers[..], root.id(), repeat, fires, |trigger| {
            trigger.trigger(event, false)
        })
    };
    let Some(binding) = binding else {
        return fired;
    };
    if let Some(window) = root.root().and_downcast::<gtk::Window>() {
        watch_keys(surface, &window);
    }
    surface.keymap.held.set(Some((binding.id, event.time())));
    surface.event(
        ROOT_ID,
        EventKind::KeyCommand,
        EventPayload::Value(PayloadValue::Number(f64::from(binding.id))),
    );
    fired
}

/// The binding of `claims` (newest first) whose window is `window`, whose
/// trigger `matches` best and that `eligible` fires (`keymap::fires`), and
/// what its `pass_through` does with the key; `repeat` is the auto-repeat
/// of a key whose binding fires once (`KeyMatch`'s rules).
///
/// Match quality wins over newness, as in `gtk::ShortcutController`: a
/// trigger that names the keys of the layout's Latin group (`mod+w` under
/// Hebrew) matches partially, and an eligible exact match outranks every
/// partial one. Within a quality the newest eligible binding is the one, as
/// before.
fn pick(
    claims: &[(gtk::ShortcutTrigger, KeyBinding)],
    window: NodeId,
    repeat: bool,
    eligible: impl Fn(&KeyBinding) -> bool,
    matches: impl Fn(&gtk::ShortcutTrigger) -> gtk::gdk::KeyMatch,
) -> (RawFire, Option<KeyBinding>) {
    // The newest partial match, kept until no exact match turns up. One
    // pass, no allocation: the hot path is a key press.
    let mut partial = None;
    let mut exact = None;
    for (trigger, binding) in claims {
        if !binding.window.is_none_or(|w| w == window) || !eligible(binding) {
            continue;
        }
        match matches(trigger) {
            gtk::gdk::KeyMatch::Exact => {
                exact = Some(*binding);
                break;
            }
            gtk::gdk::KeyMatch::Partial if partial.is_none() => {
                partial = Some(*binding);
            }
            _ => {}
        };
    }
    let Some(binding) = exact.or(partial) else {
        return (RawFire::None, None);
    };
    if repeat && !binding.repeat && binding.pass_through {
        // Its auto-repeat goes on as if there were no binding.
        return (RawFire::None, None);
    }
    if repeat && !binding.repeat {
        // Consumed, reported once already.
        return (RawFire::Consumed, None);
    }
    let fired = if binding.pass_through {
        RawFire::Passed
    } else {
        RawFire::Consumed
    };
    (fired, Some(binding))
}

/// Whether the shortcut controller's action acts on this press at all: not
/// after a raw view's dispatch ran the bindings for it ([`raw`]), whatever
/// binding (`claim`) the controller reaches — the newest eligible one was
/// already chosen, and an older duplicate must not report or consume the
/// key either.
fn controller_acts(state: &KeymapState) -> bool {
    !state.raw_fired.get()
}

fn focus_context(surface: &Surface, root: &NshView) -> Option<(bool, bool, Vec<NodeId>)> {
    let root_widget = root.upcast_ref::<gtk::Widget>();
    let Some(focus) = root_widget.root().and_then(|r| r.focus()) else {
        return Some((false, false, Vec::new()));
    };
    if !(focus.is_ancestor(root_widget) || &focus == root_widget) {
        return None;
    }
    // A field's text widget, or a hosted widget (a web view).
    let editing = !focus.is::<crate::view::NshView>();
    let control = crate::key_focus::is_control(surface, &focus);
    let path = crate::input::focus_path(surface, root, Some(focus));
    Some((editing, control, path))
}

/// A pointer override must be eligible in the same window, focus and phase
/// as the binding it supersedes.
fn fires<'a>(
    surface: &'a Surface,
    root: &NshView,
    fallback: bool,
) -> impl Fn(&KeyBinding) -> bool + use<'a> {
    let focus = focus_context(surface, root);
    let composing = crate::text_input::composing_focused(surface);
    let window = root.id();
    move |binding| {
        let Some((editing, control, path)) = &focus else {
            return false;
        };
        let eligible = |b: &KeyBinding| {
            b.window.is_none_or(|w| w == window)
                && b.fallback == fallback
                && (b.in_text || !editing)
                && b.within.is_none_or(|scope| path.contains(&scope))
                && !skipped(b)
        };
        !composing
            && eligible(binding)
            && (!control
                || *editing
                || surface
                    .keymap
                    .keymap
                    .borrow()
                    .as_ref()
                    .is_none_or(|table| !table.gives_way(binding, eligible)))
    }
}

/// The keyval that `key` types with Shift on the display's layout (`slash`
/// → `question`, `Tab` → `ISO_Left_Tab`), if it differs.
fn shifted(display: &gtk::gdk::Display, key: gtk::gdk::Key) -> Option<gtk::gdk::Key> {
    let keys = display.map_keyval(key)?;
    let base = keys
        .iter()
        .filter(|k| k.level() == 0)
        .min_by_key(|k| k.group())?;
    let (shifted, ..) = display.translate_key(
        base.keycode(),
        gtk::gdk::ModifierType::SHIFT_MASK,
        base.group(),
    )?;
    (shifted != key && shifted != gtk::gdk::Key::VoidSymbol).then_some(shifted)
}

/// The GTK trigger of `keystroke` (`<Control><Shift>p`). A key event
/// carries the keyval Shift typed, and Shift counts as consumed: a shifted
/// key other than a letter (`shift+/`, `mod+shift+=`, `shift+tab`) is
/// matched by the keyval `shifted` gives (`question`, `plus`,
/// `ISO_Left_Tab`), as GTK's own bindings name it.
fn trigger(
    keystroke: &Keystroke,
    shifted: impl Fn(gtk::gdk::Key) -> Option<gtk::gdk::Key>,
) -> Option<String> {
    let m = keystroke.modifiers;
    let mut out = String::new();
    for (on, name) in [
        (m.ctrl, "<Control>"),
        (m.alt, "<Alt>"),
        (m.shift, "<Shift>"),
        (m.cmd, "<Super>"),
    ] {
        if on {
            out.push_str(name);
        }
    }
    let name = match keystroke.key {
        Key::Char(c) if c.is_ascii_alphanumeric() => c.to_string(),
        Key::Char(c) => match c {
            ' ' => "space",
            '-' => "minus",
            '=' => "equal",
            '[' => "bracketleft",
            ']' => "bracketright",
            '\\' => "backslash",
            ';' => "semicolon",
            '\'' => "apostrophe",
            ',' => "comma",
            '.' => "period",
            '/' => "slash",
            '`' => "grave",
            _ => return None,
        }
        .to_owned(),
        Key::Enter => "Return".to_owned(),
        Key::Escape => "Escape".to_owned(),
        Key::Tab => "Tab".to_owned(),
        Key::Backspace => "BackSpace".to_owned(),
        Key::Delete => "Delete".to_owned(),
        Key::Insert => "Insert".to_owned(),
        Key::Up => "Up".to_owned(),
        Key::Down => "Down".to_owned(),
        Key::Left => "Left".to_owned(),
        Key::Right => "Right".to_owned(),
        Key::Home => "Home".to_owned(),
        Key::End => "End".to_owned(),
        Key::PageUp => "Page_Up".to_owned(),
        Key::PageDown => "Page_Down".to_owned(),
        Key::F(n) => format!("F{n}"),
    };
    let letter = matches!(keystroke.key, Key::Char(c) if c.is_ascii_alphabetic());
    let name = match gtk::gdk::Key::from_name(&name) {
        Some(key) if m.shift && !letter => shifted(key)
            .and_then(|k| k.name())
            .map_or(name, |n| n.to_string()),
        _ => name,
    };
    out.push_str(&name);
    Some(out)
}

#[cfg(test)]
mod tests {
    use gtk4 as gtk;
    use nsh_core::{
        ROOT_ID,
        keymap::{KeyBinding, Keystroke, When},
        platform::Os,
    };

    use crate::gtk_test::run;

    /// A Linux keystroke of the bindings.
    fn stroke(stroke: &str) -> Keystroke {
        Keystroke::parse(stroke, Os::Linux).expect("a stroke")
    }

    /// The trigger GTK parses for `trigger` (`<Control>w`).
    fn trigger(trigger: &str) -> gtk::ShortcutTrigger {
        gtk::ShortcutTrigger::parse_string(trigger).expect("a trigger")
    }

    /// How each of a test's triggers matches the pressed key: the quality
    /// GTK gives a trigger of that name, `None` for the others.
    fn matches<const N: usize>(
        table: [(&'static str, gtk::gdk::KeyMatch); N],
    ) -> impl Fn(&gtk::ShortcutTrigger) -> gtk::gdk::KeyMatch {
        move |trigger| {
            let name = trigger.to_string();
            table
                .iter()
                .find(|entry| name.as_str() == entry.0)
                .map_or(gtk::gdk::KeyMatch::None, |entry| entry.1)
        }
    }

    /// The lookup a raw view runs: the best match quality first (as
    /// `gtk::ShortcutController` picks), then the newest of the window's,
    /// `pass_through` respected, and a held key's auto-repeat once.
    #[test]
    fn pick_prefers_exact_over_newer_partial() {
        run(|| {
            // US plus Hebrew: with Hebrew active the physical US `w` types
            // `'`, so `mod+w` is only the layout's Latin-group fallback
            // while `mod+'` is the key the layout really names.
            let triggers = vec![
                (
                    trigger("<Control>w"),
                    KeyBinding::new(1, stroke("mod+w"), When::Always, false),
                ),
                (
                    trigger("<Control>apostrophe"),
                    KeyBinding::new(2, stroke("mod+'"), When::Always, false),
                ),
            ];
            let both = matches([
                ("<Control>w", gtk::gdk::KeyMatch::Partial),
                ("<Control>apostrophe", gtk::gdk::KeyMatch::Exact),
            ]);
            let (fired, binding) = super::pick(&triggers, ROOT_ID, false, |_| true, both);
            assert_eq!(fired, super::RawFire::Consumed);
            assert_eq!(
                binding.map(|binding| binding.id),
                Some(2),
                "the exact match, not the newer partial one"
            );
            // Only the Latin-group fallback matches: it fires.
            let partial = matches([("<Control>w", gtk::gdk::KeyMatch::Partial)]);
            let (fired, binding) = super::pick(&triggers, ROOT_ID, false, |_| true, &partial);
            assert_eq!(fired, super::RawFire::Consumed);
            assert_eq!(binding.map(|binding| binding.id), Some(1));
            // Nothing matches: nothing is reported.
            let (fired, binding) = super::pick(
                &triggers,
                ROOT_ID,
                false,
                |_| true,
                |_| gtk::gdk::KeyMatch::None,
            );
            assert_eq!(fired, super::RawFire::None);
            assert!(binding.is_none());
        });
    }

    /// A window's own bindings only: another window's exact match is not
    /// this window's, and an ineligible binding never shadows an eligible
    /// partial one.
    #[test]
    fn pick_respects_windows_before_match_quality() {
        run(|| {
            let triggers = vec![
                (
                    trigger("<Control>a"),
                    KeyBinding::new(1, stroke("mod+a"), When::Always, false).in_window(7),
                ),
                (
                    trigger("<Control>b"),
                    KeyBinding::new(2, stroke("mod+b"), When::Always, false)
                        .in_window(ROOT_ID)
                        .passing_through(true),
                ),
            ];
            let quality = matches([
                ("<Control>a", gtk::gdk::KeyMatch::Exact),
                ("<Control>b", gtk::gdk::KeyMatch::Partial),
            ]);
            // The main window only has the passing partial fallback.
            let (fired, binding) = super::pick(&triggers, ROOT_ID, false, |_| true, &quality);
            assert_eq!(fired, super::RawFire::Passed);
            assert_eq!(binding.map(|binding| binding.id), Some(2));
            // Window 7's exact binding takes the key.
            let (fired, binding) = super::pick(&triggers, 7, false, |_| true, &quality);
            assert_eq!(fired, super::RawFire::Consumed);
            assert_eq!(binding.map(|binding| binding.id), Some(1));
            // A window with neither hears nothing.
            let (fired, binding) = super::pick(&triggers, 9, false, |_| true, &quality);
            assert_eq!(fired, super::RawFire::None);
            assert!(binding.is_none());
        });
    }

    /// An ineligible binding never shadows an eligible one: the raw view
    /// rules (`keymap::fires`: a text field, a control's Return or Space)
    /// choose before match quality does.
    #[test]
    fn pick_skips_ineligible_bindings() {
        run(|| {
            let triggers = vec![
                (
                    trigger("<Control>a"),
                    KeyBinding::new(1, stroke("mod+a"), When::Always, false),
                ),
                (
                    trigger("<Control>a"),
                    KeyBinding::new(2, stroke("mod+a"), When::Always, false).passing_through(true),
                ),
            ];
            let exact = matches([("<Control>a", gtk::gdk::KeyMatch::Exact)]);
            // The newest binding does not fire here: the older one is the
            // press's.
            let (fired, binding) =
                super::pick(&triggers, ROOT_ID, false, |claim| claim.id == 1, &exact);
            assert_eq!(fired, super::RawFire::Consumed);
            assert_eq!(binding.map(|binding| binding.id), Some(1));
            // None eligible: no binding takes the key at all.
            let (fired, binding) = super::pick(&triggers, ROOT_ID, false, |_| false, &exact);
            assert_eq!(fired, super::RawFire::None);
            assert!(binding.is_none());
        });
    }

    #[test]
    fn pick_respects_repeats_and_pass_through_within_a_match_quality() {
        run(|| {
            // A repeat of an exact binding that fires once: consumed,
            // reported once already.
            let once = vec![(
                trigger("<Control>a"),
                KeyBinding::new(1, stroke("mod+a"), When::Always, false),
            )];
            let exact = matches([("<Control>a", gtk::gdk::KeyMatch::Exact)]);
            let (fired, binding) = super::pick(&once, ROOT_ID, true, |_| true, &exact);
            assert_eq!(fired, super::RawFire::Consumed);
            assert!(binding.is_none());

            // A passing binding lets its auto-repeat go on as if it were
            // not there, partial or exact.
            let passing = vec![(
                trigger("<Control>b"),
                KeyBinding::new(2, stroke("mod+b"), When::Always, false).passing_through(true),
            )];
            let partial = matches([("<Control>b", gtk::gdk::KeyMatch::Partial)]);
            let (fired, binding) = super::pick(&passing, ROOT_ID, true, |_| true, &partial);
            assert_eq!(fired, super::RawFire::None);
            assert!(binding.is_none());
            // Its press reports and passes the key on.
            let (fired, binding) = super::pick(&passing, ROOT_ID, false, |_| true, &partial);
            assert_eq!(fired, super::RawFire::Passed);
            assert_eq!(binding.map(|binding| binding.id), Some(2));

            // A binding that repeats keeps reporting on the repeats.
            let repeating = vec![(
                trigger("<Control>c"),
                KeyBinding::new(3, stroke("mod+c"), When::Always, true),
            )];
            let exact = matches([("<Control>c", gtk::gdk::KeyMatch::Exact)]);
            let (fired, binding) = super::pick(&repeating, ROOT_ID, true, |_| true, &exact);
            assert_eq!(fired, super::RawFire::Consumed);
            assert_eq!(binding.map(|binding| binding.id), Some(3));

            // The newest of two equal matches decides, so an older duplicate
            // (which the guard keeps the controller from acting on) never
            // takes the key.
            let duplicates = vec![
                (
                    trigger("<Control>a"),
                    KeyBinding::new(4, stroke("mod+a"), When::Always, false).passing_through(true),
                ),
                (
                    trigger("<Control>a"),
                    KeyBinding::new(5, stroke("mod+a"), When::Always, false),
                ),
            ];
            let exact = matches([("<Control>a", gtk::gdk::KeyMatch::Exact)]);
            let (fired, binding) = super::pick(&duplicates, ROOT_ID, false, |_| true, &exact);
            assert_eq!(fired, super::RawFire::Passed, "the newest passes it on");
            assert_eq!(binding.map(|binding| binding.id), Some(4));
        });
    }

    #[test]
    fn triggers() {
        use gtk4::gdk::Key;
        // The US layout's shifted keys.
        let us = |key| match key {
            Key::slash => Some(Key::question),
            Key::equal => Some(Key::plus),
            Key::_1 => Some(Key::exclam),
            Key::Tab => Some(Key::ISO_Left_Tab),
            _ => None,
        };
        let t = |s| super::trigger(&Keystroke::parse(s, Os::Linux).unwrap(), us).unwrap();
        assert_eq!(t("mod+shift+p"), "<Control><Shift>p");
        assert_eq!(t("alt+enter"), "<Alt>Return");
        assert_eq!(t("cmd+["), "<Super>bracketleft");
        assert_eq!(t("f5"), "F5");
        assert_eq!(t("shift+/"), "<Shift>question");
        assert_eq!(t("mod+shift+="), "<Control><Shift>plus");
        assert_eq!(t("mod+shift+1"), "<Control><Shift>exclam");
        assert_eq!(t("shift+tab"), "<Shift>ISO_Left_Tab");
        assert_eq!(t("mod+="), "<Control>equal");
    }
}
