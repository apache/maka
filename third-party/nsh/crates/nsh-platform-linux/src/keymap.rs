//! The app's keyboard shortcuts (`nsh/keymap`): the table the engine
//! mounts ([`MountItem::Keymap`](nsh_core::MountItem::Keymap)) becomes a
//! global-scope `gtk::ShortcutController` on the root, one shortcut per
//! binding, newest first (GTK tries a controller's shortcuts in order).
//!
//! GTK matches the triggers, also on the keys of the layout's Latin group
//! under other layouts, as it does the application's accelerators. A
//! binding's action decides on the spot whether it fires (where the focus
//! is: `KeyBinding::in_text`), reports it to JS with the root's
//! `KeyCommand` event and stops the key; JS runs the handler afterwards.
//! A binding that does not fire lets GTK try the next shortcut and then the
//! focus widget.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, ROOT_ID,
    keymap::{Key, KeyBinding, KeyMatch, Keymap, Keystroke},
    platform::Os,
};

use crate::surface::Surface;

/// A surface's shortcut controller, while it has bindings.
#[derive(Default)]
pub(crate) struct KeymapState {
    controller: RefCell<Option<gtk::ShortcutController>>,
    /// Each binding's trigger, newest first, for [`claims`] and held-key replay.
    triggers: RefCell<Vec<(gtk::ShortcutTrigger, KeyBinding)>>,
    /// Fallback bindings' triggers, newest first, for [`unhandled`].
    fallbacks: RefCell<Vec<(gtk::ShortcutTrigger, KeyBinding)>>,
    /// The binding whose key is held down (GDK does not mark auto-repeats):
    /// it does not fire again until a key is released.
    held: Rc<Cell<Option<u32>>>,
    /// The window's key controller that sees releases, and its window.
    releases: RefCell<Option<(glib::WeakRef<gtk::Window>, gtk::EventControllerKey)>>,
    /// The bindings, for keys pressed without a GDK event ([`press`]).
    keymap: RefCell<Option<Arc<Keymap>>>,
}

/// `MountItem::Keymap`: replaces the surface's shortcuts.
pub(crate) fn set(surface: &Rc<Surface>, keymap: Arc<Keymap>) {
    clear(surface);
    if keymap.is_empty() {
        return;
    }
    *surface.keymap.keymap.borrow_mut() = Some(keymap.clone());
    let controller = gtk::ShortcutController::new();
    controller.set_scope(gtk::ShortcutScope::Global);
    // The window runs global controllers in their phase: in the bubble
    // phase the focused field (and its own capture controller) would see
    // the key first, and `when: "always"` could not take Ctrl+A from it.
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    let keys_ref = controller.downgrade();
    let display = surface.root.display();
    for binding in keymap.bindings().iter().rev() {
        // The dev host's Ctrl+R reloads, whatever the app binds.
        if cfg!(feature = "dev") && binding.keystroke.reloads(Os::Linux) {
            continue;
        }
        let Some(trigger) = trigger(&binding.keystroke, |key| shifted(&display, key)) else {
            continue;
        };
        let Some(trigger) = gtk::ShortcutTrigger::parse_string(&trigger) else {
            continue;
        };
        surface
            .keymap
            .triggers
            .borrow_mut()
            .push((trigger.clone(), *binding));
        if binding.fallback {
            surface
                .keymap
                .fallbacks
                .borrow_mut()
                .push((trigger, *binding));
            continue;
        }
        let weak = Rc::downgrade(surface);
        let keys = keys_ref.clone();
        let binding = *binding;
        let action = gtk::CallbackAction::new(move |_, _| match weak.upgrade() {
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
            Some(surface) if fires_binding(&surface, &binding) => {
                fire(&surface, &binding);
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
        controller.add_shortcut(gtk::Shortcut::new(Some(trigger), Some(action)));
    }
    surface.root.add_controller(controller.clone());
    *surface.keymap.controller.borrow_mut() = Some(controller);
}

/// Removes the surface's shortcuts (the app stopped).
pub(crate) fn clear(surface: &Surface) {
    if let Some(controller) = surface.keymap.controller.borrow_mut().take() {
        surface.root.remove_controller(&controller);
    }
    if let Some((window, keys)) = surface.keymap.releases.borrow_mut().take()
        && let Some(window) = window.upgrade()
    {
        window.remove_controller(&keys);
    }
    surface.keymap.held.set(None);
    surface.keymap.triggers.borrow_mut().clear();
    surface.keymap.fallbacks.borrow_mut().clear();
    surface.keymap.keymap.borrow_mut().take();
}

fn fire(surface: &Rc<Surface>, binding: &KeyBinding) {
    watch_releases(surface);
    let held = &surface.keymap.held;
    if binding.repeat || held.get() != Some(binding.id) {
        held.set(Some(binding.id));
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(binding.id as f64)),
        );
        if binding.keystroke.key != Key::Escape {
            crate::text_input::arm(surface);
        }
    }
}

fn fires_binding(surface: &Surface, binding: &KeyBinding) -> bool {
    !(binding.keystroke.key == Key::Escape && crate::text_input::composing_focused(surface))
        && fires(surface, binding.in_text, binding.within)
}

/// Replays capture-phase shortcut matching for a held GDK key event.
pub(crate) fn press_gdk(surface: &Rc<Surface>, event: &gtk::gdk::Event) -> bool {
    if surface.input_paused.get() && !crate::text_input::is_replaying(surface) {
        return true;
    }
    let matched = surface
        .keymap
        .triggers
        .borrow()
        .iter()
        .find(|(trigger, binding)| {
            !binding.fallback
                && trigger.trigger(event, false) != gtk::gdk::KeyMatch::None
                && fires_binding(surface, binding)
        })
        .map(|(_, binding)| *binding);
    if let Some(binding) = matched {
        fire(surface, &binding);
        return true;
    }
    false
}

/// Fallback bindings, run after the focused control, selection, scroll and
/// navigation all left `event` unhandled.
pub(crate) fn unhandled(surface: &Rc<Surface>, event: Option<&gtk::gdk::Event>) -> bool {
    let Some(event) = event else {
        return false;
    };
    if surface.input_paused.get() && !crate::text_input::is_replaying(surface) {
        return true;
    }
    let matched = surface
        .keymap
        .fallbacks
        .borrow()
        .iter()
        .find(|(trigger, binding)| {
            trigger.trigger(event, false) != gtk::gdk::KeyMatch::None
                && fires_binding(surface, binding)
        })
        .map(|(_, binding)| *binding);
    if let Some(binding) = matched {
        fire(surface, &binding);
        return true;
    }
    false
}

/// A key pressed without a GDK event (GTK takes no made-up ones; `nsh test
/// --target linux`): the newest binding of `stroke` that fires where the
/// focus is reports it, as its shortcut's action would. False if none.
pub(crate) fn press(surface: &Rc<Surface>, stroke: Keystroke) -> bool {
    press_in_phase(surface, stroke, false)
}

pub(crate) fn press_fallback(surface: &Rc<Surface>, stroke: Keystroke) -> bool {
    press_in_phase(surface, stroke, true)
}

fn press_in_phase(surface: &Rc<Surface>, stroke: Keystroke, fallback: bool) -> bool {
    if surface.input_paused.get() && !crate::text_input::is_replaying(surface) {
        return true;
    }
    if cfg!(feature = "dev") && stroke.reloads(Os::Linux) {
        return false;
    }
    if stroke.key == Key::Escape && crate::text_input::composing_focused(surface) {
        return false;
    }
    let Some(keymap) = surface.keymap.keymap.borrow().clone() else {
        return false;
    };
    let Some((editing, path)) = focus_context(surface) else {
        return false;
    };
    let found = if fallback {
        keymap.find_fallback_with(stroke, editing, false, |id| path.contains(&id))
    } else {
        keymap.find_with(stroke, editing, false, |id| path.contains(&id))
    };
    if let KeyMatch::Fire(id) = found {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        );
        if stroke.key != Key::Escape {
            crate::text_input::arm(surface);
        }
    }
    found.consumed()
}

/// Whether a binding fires for `event` where the focus is: the application
/// menu's shortcuts (`chrome.rs`), whose controller the window runs first,
/// give way to it, as menus' key equivalents do on macOS.
pub(crate) fn claims(surface: &Surface, event: &gtk::gdk::Event) -> bool {
    if surface.input_paused.get() {
        return true;
    }
    surface
        .keymap
        .triggers
        .borrow()
        .iter()
        .any(|(trigger, binding)| {
            trigger.trigger(event, false) != gtk::gdk::KeyMatch::None
                && fires_binding(surface, binding)
        })
}

/// Listens to the releases of the surface's window (once per window), so
/// that a held key's binding fires again after it is released.
fn watch_releases(surface: &Surface) {
    let Some(window) = surface.root.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let mut releases = surface.keymap.releases.borrow_mut();
    if releases
        .as_ref()
        .is_some_and(|(w, _)| w.upgrade().as_ref() == Some(&window))
    {
        return;
    }
    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    let held = surface.keymap.held.clone();
    keys.connect_key_released(move |_, _, _, _| held.set(None));
    window.add_controller(keys.clone());
    *releases = Some((window.downgrade(), keys));
}

fn focus_context(surface: &Surface) -> Option<(bool, Vec<NodeId>)> {
    let root = surface.root.upcast_ref::<gtk::Widget>();
    let Some(focus) = root.root().and_then(|r| r.focus()) else {
        return Some((false, Vec::new()));
    };
    if !(focus.is_ancestor(root) || &focus == root) {
        return None;
    }
    // A field's text widget, or a hosted widget (a web view).
    let editing = !focus.is::<crate::view::NshView>();
    let path = crate::input::focus_path(surface, Some(focus));
    Some((editing, path))
}

/// Whether a binding fires where the focus is: never while it is in
/// another surface, in a text field or hosted widget only when the binding
/// may (`in_text`), and inside `within` when scoped.
fn fires(surface: &Surface, in_text: bool, within: Option<NodeId>) -> bool {
    focus_context(surface).is_some_and(|(editing, path)| {
        (in_text || !editing) && within.is_none_or(|scope| path.contains(&scope))
    })
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
    use nsh_core::{keymap::Keystroke, platform::Os};

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
