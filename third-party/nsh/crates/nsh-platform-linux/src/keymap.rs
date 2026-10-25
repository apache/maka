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
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, Keymap, Keystroke},
    platform::Os,
};

use crate::surface::Surface;

/// A surface's shortcut controller, while it has bindings.
#[derive(Default)]
pub(crate) struct KeymapState {
    controller: RefCell<Option<gtk::ShortcutController>>,
    /// Each binding's trigger and whether it fires in a text field
    /// (`KeyBinding::in_text`), for [`claims`].
    triggers: RefCell<Vec<(gtk::ShortcutTrigger, bool)>>,
    /// The binding whose key is held down (GDK does not mark auto-repeats):
    /// it does not fire again until a key is released.
    held: Rc<Cell<Option<u32>>>,
    /// The window's key controller that sees releases, and its window.
    releases: RefCell<Option<(glib::WeakRef<gtk::Window>, gtk::EventControllerKey)>>,
    /// The bindings, for keys pressed without a GDK event
    /// ([`press`], `nsh test --target linux`).
    #[cfg(feature = "dev")]
    keymap: RefCell<Option<Arc<Keymap>>>,
}

/// `MountItem::Keymap`: replaces the surface's shortcuts.
pub(crate) fn set(surface: &Rc<Surface>, keymap: Arc<Keymap>) {
    clear(surface);
    if keymap.is_empty() {
        return;
    }
    #[cfg(feature = "dev")]
    {
        *surface.keymap.keymap.borrow_mut() = Some(keymap.clone());
    }
    let controller = gtk::ShortcutController::new();
    controller.set_scope(gtk::ShortcutScope::Global);
    // The window runs global controllers in their phase: in the bubble
    // phase the focused field (and its own capture controller) would see
    // the key first, and `when: "always"` could not take Ctrl+A from it.
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    let display = surface.root.display();
    for binding in keymap.bindings().iter().rev() {
        // Focus-scoped shortcuts are currently supported by the terminal.
        if binding.within.is_some() || binding.fallback {
            continue;
        }
        // The dev host's Ctrl+R reloads, whatever the app binds.
        if cfg!(feature = "dev") && binding.keystroke.reloads(Os::Linux) {
            continue;
        }
        let Some(trigger) = trigger(&binding.keystroke, |key| shifted(&display, key)) else {
            continue;
        };
        let weak = Rc::downgrade(surface);
        let (id, in_text, repeat) = (binding.id, binding.in_text, binding.repeat);
        let action = gtk::CallbackAction::new(move |_, _| match weak.upgrade() {
            Some(surface) if fires(&surface, in_text) => {
                watch_releases(&surface);
                let held = &surface.keymap.held;
                if repeat || held.get() != Some(id) {
                    held.set(Some(id));
                    surface.event(
                        ROOT_ID,
                        EventKind::KeyCommand,
                        EventPayload::Value(PayloadValue::Number(id as f64)),
                    );
                }
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
        let Some(trigger) = gtk::ShortcutTrigger::parse_string(&trigger) else {
            continue;
        };
        surface
            .keymap
            .triggers
            .borrow_mut()
            .push((trigger.clone(), in_text));
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
    #[cfg(feature = "dev")]
    surface.keymap.keymap.borrow_mut().take();
}

/// A key pressed without a GDK event (GTK takes no made-up ones; `nsh test
/// --target linux`): the newest binding of `stroke` that fires where the
/// focus is reports it, as its shortcut's action would. False if none.
#[cfg(feature = "dev")]
pub(crate) fn press(surface: &Surface, stroke: Keystroke) -> bool {
    let keymap = surface.keymap.keymap.borrow().clone();
    let Some(keymap) = keymap else {
        return false;
    };
    let fired = keymap
        .bindings()
        .iter()
        .rev()
        .find(|b| !b.fallback && b.keystroke == stroke && fires(surface, b.in_text));
    if let Some(binding) = fired {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(binding.id as f64)),
        );
    }
    fired.is_some()
}

/// Whether a binding fires for `event` where the focus is: the application
/// menu's shortcuts (`chrome.rs`), whose controller the window runs first,
/// give way to it, as menus' key equivalents do on macOS.
pub(crate) fn claims(surface: &Surface, event: &gtk::gdk::Event) -> bool {
    surface
        .keymap
        .triggers
        .borrow()
        .iter()
        .any(|(trigger, in_text)| {
            trigger.trigger(event, false) != gtk::gdk::KeyMatch::None && fires(surface, *in_text)
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

/// Whether a binding fires where the focus is: never while it is in
/// another surface, in a text field or hosted widget only when the binding
/// may (`in_text`).
fn fires(surface: &Surface, in_text: bool) -> bool {
    let root = surface.root.upcast_ref::<gtk::Widget>();
    let Some(focus) = root.root().and_then(|r| r.focus()) else {
        return true;
    };
    if !(focus.is_ancestor(root) || &focus == root) {
        return false;
    }
    // A field's text widget, or a hosted widget (a web view).
    let editing = !focus.is::<crate::view::NshView>();
    in_text || !editing
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
