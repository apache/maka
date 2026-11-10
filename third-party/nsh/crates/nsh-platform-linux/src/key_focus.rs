//! The keyboard focus on views: Tab moves it between the stops
//! ([`nsh_core::ViewProps::focus_stop`]) and fields, in GTK's own focus
//! chain; `focus()` moves it to a stop. A focused stop reports `FOCUSED`,
//! `onFocus` and `onBlur`, Return and Space press it, and Shift+F10 or the
//! Menu key ask it for its context menu.
//!
//! Views stay unfocusable until Tab or `focus()` picks them: GTK also
//! hands the focus around by itself (to the first focusable widget as a
//! window maps, into a parent's children when a focused widget goes), and
//! a click or a new window must not land on a button.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use gtk4::{self as gtk, gdk, glib, graphene, prelude::*};
use nsh_core::{
    EventKind, EventPayload, ViewKind,
    geometry::{Points, point},
    input as core_input,
    keymap::Key,
    tailwind::state,
};

use crate::{surface::Surface, view::NshView};

thread_local! {
    /// Whether a Tab key is moving the focus right now.
    static TABBING: Cell<bool> = const { Cell::new(false) };
}

/// Lets a view take part in the Tab GTK is moving the focus for
/// (`GtkWidget::focus`): only stops do, only then.
pub(crate) fn offer(view: &NshView) {
    if TABBING.get() {
        view.set_focusable(is_stop(view));
    }
}

/// After [`offer`]: a stop Tab passed over goes back to unfocusable.
pub(crate) fn offered(view: &NshView) {
    if TABBING.get() && !view.is_focus() {
        view.set_focusable(false);
    }
}

/// Whether Tab stops at `view`: it takes presses or is `focusable`, and
/// the pointer could reach it.
pub(crate) fn is_stop(view: &NshView) -> bool {
    {
        let state = view.state();
        if state.kind == ViewKind::Input
            || !state
                .props
                .focus_stop(state.events.contains(EventKind::Press))
        {
            return false;
        }
    }
    view.can_target() && view.is_visible()
}

/// `focus()` on a view that is not an input: the focus moves to it as Tab
/// moves it there, if it is a stop.
pub(crate) fn focus(view: &NshView) {
    if !is_stop(view) || view.is_focus() {
        return;
    }
    view.set_focusable(true);
    if !view.grab_focus() {
        view.set_focusable(false);
    }
}

/// `blur()` on a view that is not an input, when it has the focus.
pub(crate) fn blur(view: &NshView) -> bool {
    if !view.is_focus() {
        return false;
    }
    if let Some(root) = view.root() {
        root.set_focus(None::<&gtk::Widget>);
    }
    true
}

/// Follows the focus of the surface's window, and takes the keys of a
/// focused stop before the app's shortcuts and the focused widget's own
/// (Space would scroll, Return would fire a global binding).
pub(crate) fn install(surface: &Rc<Surface>) {
    let weak = Rc::downgrade(surface);
    let installed = RefCell::new(glib::WeakRef::<gtk::Window>::new());
    surface.root.connect_realize(move |root| {
        let Some(window) = root.root().and_downcast::<gtk::Window>() else {
            return;
        };
        if installed.borrow().upgrade().as_ref() == Some(&window) {
            return;
        }
        installed.borrow().set(Some(&window));
        if let Some(surface) = weak.upgrade() {
            watch(&surface, &window);
        }
    });
}

/// Follows the focus in `window` (the main one or one of the app's own,
/// each with focus chains of its own) and takes a focused stop's keys.
pub(crate) fn watch(surface: &Rc<Surface>, window: &gtk::Window) {
    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    let pressed = Rc::downgrade(surface);
    keys.connect_key_pressed(move |keys, key, _, modifiers| match pressed.upgrade() {
        Some(surface) if key_pressed(&surface, keys, key, modifiers) => glib::Propagation::Stop,
        _ => glib::Propagation::Proceed,
    });
    window.add_controller(keys);
    let weak = Rc::downgrade(surface);
    let current = RefCell::new(None::<NshView>);
    window.connect_focus_widget_notify(move |window| {
        if let Some(surface) = weak.upgrade() {
            moved(&surface, window, &current);
        }
    });
}

/// The focused stop of `surface`, in whichever of its windows.
fn focused_stop(surface: &Surface, focus: Option<gtk::Widget>) -> Option<NshView> {
    focus
        .and_downcast::<NshView>()
        .filter(|view| crate::window::holds(surface, view))
        .filter(is_stop)
}

/// The window's focus moved: the stop it left and the one it reached say so.
fn moved(surface: &Surface, window: &gtk::Window, current: &RefCell<Option<NshView>>) {
    let next = focused_stop(surface, GtkWindowExt::focus(window));
    if *current.borrow() == next {
        return;
    }
    let previous = current.replace(next.clone());
    if let Some(view) = previous {
        view.set_focusable(false);
        crate::input::set_state(surface, &view, state::FOCUSED, false);
        surface.event(view.id(), EventKind::Blur, EventPayload::None);
    }
    if let Some(view) = next {
        crate::input::set_state(surface, &view, state::FOCUSED, true);
        surface.event(view.id(), EventKind::Focus, EventPayload::None);
    }
}

/// A key on its way to the focus: whether it was taken here.
fn key_pressed(
    surface: &Rc<Surface>,
    keys: &gtk::EventControllerKey,
    key: gdk::Key,
    modifiers: gdk::ModifierType,
) -> bool {
    if matches!(
        key,
        gdk::Key::Tab | gdk::Key::ISO_Left_Tab | gdk::Key::KP_Tab
    ) {
        // GTK moves the focus right after this, in the same dispatch.
        TABBING.set(true);
        glib::idle_add_local_once(|| TABBING.set(false));
        return false;
    }
    // The focus of the window the key is going to.
    let focus = keys.widget().and_then(|w| w.root()).and_then(|r| r.focus());
    let Some(view) = focused_stop(surface, focus) else {
        return false;
    };
    // The app's bindings come first (a menu's trigger opens at its first
    // item with Return): the shortcut controller runs right after this.
    if keys
        .current_event()
        .is_some_and(|event| crate::keymap::claims(surface, &event))
    {
        return false;
    }
    let held = crate::input::modifiers(modifiers);
    let function = (key == gdk::Key::F10).then_some(Key::F(10));
    if core_input::opens_context_menu(key == gdk::Key::Menu, function, held) {
        return show_context_menu(surface, &view);
    }
    let activates = matches!(
        key,
        gdk::Key::Return | gdk::Key::KP_Enter | gdk::Key::ISO_Enter | gdk::Key::space
    ) && !(held.ctrl || held.alt || held.cmd);
    if activates && view.state().events.contains(EventKind::Press) {
        let events = view.state().events;
        for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
            if events.contains(kind) {
                surface.event(view.id(), kind, EventPayload::None);
            }
        }
        return true;
    }
    false
}

/// A context menu asked for on `view` without a pointer: the nearest view
/// from it outwards that listens to `onContextMenu` hears it, with no
/// pointer, at its bottom-start corner. True when one heard it.
fn show_context_menu(surface: &Surface, view: &NshView) -> bool {
    let rtl = surface.mounter.try_borrow().is_ok_and(|m| m.rtl);
    let mut at = Some(view.clone());
    while let Some(v) = at {
        let (id, listens, size) = {
            let s = v.state();
            (
                s.id,
                s.events.contains(EventKind::ContextMenu),
                s.frame.size,
            )
        };
        if listens {
            let position = core_input::context_menu_anchor(size, rtl);
            let (x, y) = v
                .compute_point(
                    &crate::window::root_of(surface, &v),
                    &graphene::Point::new(position.x.0, position.y.0),
                )
                .map_or((position.x.0, position.y.0), |p| (p.x(), p.y()));
            let event = nsh_core::ContextMenuEvent::new(
                position,
                point(Points(x), Points(y)),
                Default::default(),
                None,
            );
            surface.event(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
            return true;
        }
        at = v.parent_view();
    }
    false
}

#[cfg(test)]
mod tests {
    use nsh_core::{EventMask, MountItem, ROOT_ID};

    use super::*;
    use crate::gtk_test::{apply, frame, run, show, surface, view, wait_until};

    /// A stop (2, it takes presses), a plain view (3) and a stop (4).
    fn views(surface: &Rc<Surface>) {
        let mut items = Vec::new();
        for (id, y) in [(2, 0.0), (3, 40.0), (4, 80.0)] {
            items.push(MountItem::Create {
                id,
                kind: ViewKind::View,
            });
            items.push(MountItem::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            });
            items.push(MountItem::Frame {
                id,
                frame: frame(0.0, y, 100.0, 30.0),
            });
            if id != 3 {
                let mut events = EventMask::default();
                events.set(EventKind::Press, true);
                items.push(MountItem::Events { id, events });
            }
        }
        apply(surface, &items);
    }

    fn tab(window: &gtk::Window) {
        TABBING.set(true);
        window.child_focus(gtk::DirectionType::TabForward);
        TABBING.set(false);
    }

    #[test]
    fn tab_stops_at_stops_and_a_window_opening_focuses_none() {
        run(|| {
            let surface = surface();
            views(&surface);
            let window = show(&surface);
            let (first, plain, last) = (view(&surface, 2), view(&surface, 3), view(&surface, 4));
            assert!(wait_until(|| first.is_mapped()));
            assert!(
                GtkWindowExt::focus(&window).is_none(),
                "nothing focused on opening"
            );
            tab(&window);
            assert!(first.is_focus());
            tab(&window);
            assert!(last.is_focus(), "the plain view is no stop");
            assert!(!plain.is_focusable());
            assert!(!first.is_focusable(), "unfocusable again once left");
            window.destroy();
        });
    }

    #[test]
    fn focus_moves_to_stops_only_and_blur_lets_go() {
        run(|| {
            let surface = surface();
            views(&surface);
            let window = show(&surface);
            let (first, plain) = (view(&surface, 2), view(&surface, 3));
            assert!(wait_until(|| first.is_mapped()));
            focus(&plain);
            assert!(!plain.is_focus());
            focus(&first);
            assert!(first.is_focus());
            assert!(blur(&first));
            assert!(!first.is_focus());
            window.destroy();
        });
    }
}
