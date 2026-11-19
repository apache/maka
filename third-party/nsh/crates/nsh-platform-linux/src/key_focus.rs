//! The keyboard focus on views: Tab moves it between the stops
//! ([`nsh_core::ViewProps::focus_stop`]) and fields, in GTK's own focus
//! chain; `focus()` moves it to a stop. A focused stop reports `FOCUSED`,
//! `onFocus` and `onBlur`, Return and Space press it, and Shift+F10 or the
//! Menu key ask it for its context menu.
//!
//! One key controller per window, in GTK's capture phase, decides a press
//! in this order: the app's shortcuts, the focused view's `KeyDown`
//! (reported to the engine, never waited for) with its `capture_keys` rules
//! ([`crate::keyboard`]), the application menu's shortcuts
//! ([`crate::chrome::menu_shortcut`]), then the defaults of this module. A
//! view that hears raw keys runs the app's bindings itself, once
//! ([`crate::keymap::raw`]), and its shortcut's action skips that press;
//! other views leave the shortcuts to the app's `ShortcutController`, as
//! before. A captured key is reported (`KeyEvent::captured`) and runs none
//! of the menu's shortcuts or defaults: no traversal, activation or context
//! menu. A key that only listens runs them as before.
//!
//! A native popup (a context menu, the menu bar's menus, their nested
//! submenus) grabs the keyboard: its releases never reach the window's
//! controller. [`observe_popovers`] watches them where they are delivered,
//! so a release reaches the view focused now, as a browser reports a key
//! up on the focused element whichever view heard its press.
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
            || state.style.hidden
            || !state
                .props
                .focus_stop(state.events.contains(EventKind::Press))
        {
            return false;
        }
    }
    view.can_target() && view.is_visible()
}

/// A mounted change can make the keyboard stop ineligible without moving
/// GTK's focus. Let the normal focus watcher clear its state and report Blur.
/// Selection-only areas and native inputs do not own this keyboard-stop state.
pub(crate) fn changed(view: &NshView) {
    let was_stop = {
        let current = view.state();
        current.kind != ViewKind::Input && current.states & state::FOCUSED != 0
    };
    if was_stop && !is_stop(view) {
        blur(view);
    }
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
/// focused stop: the app's shortcuts first, then the view's raw keys and
/// capture rules, then the application menu's shortcuts and the defaults
/// of this module (see [`press`]).
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
    keys.connect_key_pressed(
        move |keys, keyval, keycode, modifiers| match pressed.upgrade() {
            Some(surface)
                if press(
                    &surface,
                    keys.widget().as_ref(),
                    keys.current_event().as_ref(),
                    keyval,
                    keycode,
                    modifiers,
                    crate::keyboard::layout(keys.current_event().as_ref()),
                ) =>
            {
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        },
    );
    let released = Rc::downgrade(surface);
    keys.connect_key_released(move |keys, keyval, keycode, modifiers| {
        if let Some(surface) = released.upgrade() {
            let window = keys
                .widget()
                .and_then(|widget| widget.root())
                .and_then(|root| root.downcast::<gtk::Window>().ok());
            let modifiers =
                crate::keyboard::modifier_state(keys.current_event().as_ref(), modifiers);
            let focused = window
                .as_ref()
                .and_then(|window| focused_view(&surface, window));
            crate::keyboard::released(
                &surface,
                window.as_ref(),
                focused.as_ref(),
                keyval,
                keycode,
                modifiers,
                crate::keyboard::layout(keys.current_event().as_ref()),
            );
        }
    });
    window.add_controller(keys);
    // A window losing the OS focus loses the releases of the keys held in
    // it (a focus move inside it does not).
    let inactive = Rc::downgrade(surface);
    window.connect_is_active_notify(move |window| {
        if window.is_active() {
            return;
        }
        // GTK's native popovers can briefly deactivate and reactivate the
        // host while taking their grab. Clear only a settled loss of focus,
        // after the pending focus events, not that in-window round trip.
        let inactive = inactive.clone();
        let window = window.downgrade();
        glib::idle_add_local_once(move || {
            if let (Some(surface), Some(window)) = (inactive.upgrade(), window.upgrade())
                && !window.is_active()
            {
                crate::keyboard::window_deactivated(&surface, &window);
            }
        });
    });
    let weak = Rc::downgrade(surface);
    let current = RefCell::new(None::<NshView>);
    window.connect_focus_widget_notify(move |window| {
        if let Some(surface) = weak.upgrade() {
            // The screen reader follows the keyboard focus again.
            crate::access::clear_reader_focus(&surface);
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

/// The view a release is reported to: the stop focused now in `window`
/// (the main window, or one of the app's own). Nothing when the window has
/// no focused view any more.
pub(crate) fn focused_view(surface: &Surface, window: &gtk::Window) -> Option<NshView> {
    focused_stop(surface, GtkWindowExt::focus(window))
}

/// Watches the keys a native popup receives while it owns the keyboard
/// grab: a context menu, the menu bar's menus and their nested submenus
/// (`GtkPopoverMenu`s), all under `widget`.
///
/// A popover's grab delivers keys to its own native surface, and GTK stops
/// their propagation at the grab (`gtk_propagate_event_internal`), so the
/// window's key controller never sees them: a key held when a menu opens
/// would never release. Here a press only tracks a modifier (no view hears
/// the popup's keys); a release ends the hold on the view the key went down
/// on ([`crate::keyboard::released`]), in the window the popover belongs
/// to. Nothing is reported for a key that went down in the popup, and
/// opening a popup emits nothing by itself.
pub(crate) fn observe_popovers(surface: &Rc<Surface>, widget: &gtk::Widget) {
    if let Some(popover) = widget.downcast_ref::<gtk::Popover>()
        && !popover_watched(surface, popover)
    {
        // The default `SameNative` propagation limit is what this needs:
        // the popover's own native surface delivers the keys, and its
        // widget tree is the one they propagate through.
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let pressed = Rc::downgrade(surface);
        keys.connect_key_pressed(move |_, keyval, keycode, _| {
            if let Some(surface) = pressed.upgrade() {
                crate::keyboard::track_modifiers(&surface, keyval, keycode, true);
            }
            glib::Propagation::Proceed
        });
        let released = Rc::downgrade(surface);
        keys.connect_key_released(move |keys, keyval, keycode, modifiers| {
            let window = host(keys.widget().as_ref());
            if let (Some(surface), Some(window)) = (released.upgrade(), window) {
                let modifiers =
                    crate::keyboard::modifier_state(keys.current_event().as_ref(), modifiers);
                let focused = focused_view(&surface, &window);
                crate::keyboard::released(
                    &surface,
                    Some(&window),
                    focused.as_ref(),
                    keyval,
                    keycode,
                    modifiers,
                    crate::keyboard::layout(keys.current_event().as_ref()),
                );
            }
        });
        popover.add_controller(keys);
    }
    // Nested menus are popovers of their own (children of their items),
    // each with its own native surface and grab.
    let mut child = widget.first_child();
    while let Some(current) = child {
        observe_popovers(surface, &current);
        child = current.next_sibling();
    }
}

/// Whether `popover` already has a release watcher (marking it when not):
/// walking a menu again, or a popover another menu adopted, adds none.
fn popover_watched(surface: &Surface, popover: &gtk::Popover) -> bool {
    let mut popovers = surface.chrome.popovers.borrow_mut();
    popovers.retain(|watched| watched.upgrade().is_some());
    if popovers
        .iter()
        .any(|watched| watched.upgrade().as_ref() == Some(popover))
    {
        return true;
    }
    popovers.push(popover.downgrade());
    false
}

/// The window a popover belongs to: a popover's own root is the popover,
/// so its host's parents lead to the window it pops over.
fn host(widget: Option<&gtk::Widget>) -> Option<gtk::Window> {
    let mut widget = widget?.parent();
    while let Some(current) = widget {
        if let Some(window) = current.downcast_ref::<gtk::Window>() {
            return Some(window.clone());
        }
        widget = current.parent();
    }
    None
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

/// A key on its way to the focus: the app's shortcuts first (the app's
/// `ShortcutController` runs right after this, when the key is the app's),
/// then the focused view's `KeyDown` and capture rules, then the
/// application menu's shortcuts ([`crate::chrome::menu_shortcut`]), then
/// the defaults (Tab's traversal, Return and Space pressing, a context
/// menu). True when the key is consumed.
///
/// A focused view whose ancestry hears none of the raw keys and captures
/// none builds no raw [`KeyEvent`]; the app's bindings, the menu and
/// [`defaults`] decide. A native input or native content focus owns its
/// keys the same way, capture rules around it aside. Modifier transitions
/// stay tracked.
pub(crate) fn press(
    surface: &Rc<Surface>,
    widget: Option<&gtk::Widget>,
    event: Option<&gdk::Event>,
    keyval: gdk::Key,
    keycode: u32,
    modifiers: gdk::ModifierType,
    group: i32,
) -> bool {
    // GDK's typed state drops private modifiers (NumLock's Mod2): take the
    // raw state so a keypad key keeps typing its digit.
    let modifiers = crate::keyboard::modifier_state(event, modifiers);
    // Every key the window gets passes here first (the capture phase),
    // before it acts: the focus it moves shows (`focus-visible:`). A
    // modifier alone does not count.
    let modifier = event.is_some_and(|event| {
        event
            .downcast_ref::<gdk::KeyEvent>()
            .is_some_and(gdk::KeyEvent::is_modifier)
    });
    if !modifier {
        surface.control(|c| c.set_input_modality(nsh_core::platform::InputModality::Keyboard));
    }
    // A binding a previous press's raw dispatch reported must not leave its
    // shortcut's action silent (`keymap::raw`).
    crate::keymap::forget(surface);
    // A modifier's press is tracked even when nothing raw has the focus (a
    // native field, no focus): the next key event carries it.
    crate::keyboard::track_modifiers(surface, keyval, keycode, true);
    // The window the key is going to, and its focus.
    let root = widget.and_then(|widget| widget.root());
    let window = root
        .as_ref()
        .and_then(|root| root.clone().downcast::<gtk::Window>().ok());
    let focus = root.and_then(|root| root.focus());
    // Track every press before focus and listener routing: a held key must
    // not become a new press when its handler moves the focus.
    let repeat = window
        .as_ref()
        .is_some_and(|window| crate::keyboard::held(surface, window, keycode));
    // The application menu's shortcut, where a view leaves the key to it.
    let menu_shortcut = || match (event, widget) {
        (Some(event), Some(widget)) => crate::chrome::menu_shortcut(surface, widget, event),
        _ => false,
    };
    let Some(view) = focused_stop(surface, focus) else {
        // A native field (or no focus) has no view to notify: the app's
        // bindings first, then the menu's shortcuts, then Tab's traversal.
        if event.is_some_and(|event| crate::keymap::claims(surface, event)) {
            return false;
        }
        if menu_shortcut() {
            return true;
        }
        if is_tab(keyval) {
            arm_tab();
        }
        return false;
    };
    if !crate::keyboard::listens(surface, &view) || crate::keyboard::native_owns(&view) {
        // A view with no raw keys (or a native input/content that owns its
        // keys) keeps the original path: the app's bindings (GTK's
        // controller) first, then the menu's shortcut, then the defaults.
        // Return and Space on a control fire only the focus' own (a menu
        // button's opening its menu, `keymap::fires`).
        if event.is_some_and(|event| crate::keymap::claims(surface, event)) {
            return false;
        }
        if menu_shortcut() {
            return true;
        }
        return defaults(surface, &view, keyval, modifiers, repeat);
    }
    // A raw view runs the app's bindings itself, once, before it is
    // notified: a pass-through binding reports and the key goes on, a
    // consuming one reports and takes it, and the shortcut controller does
    // not report either again.
    if let Some(event) = event {
        match crate::keymap::raw(surface, event, repeat) {
            crate::keymap::RawFire::Consumed => return true,
            crate::keymap::RawFire::None | crate::keymap::RawFire::Passed => {}
        }
    }
    // A key the layout cannot name (a dead key) is still a `KeyDown`
    // (`Dead`, or `Unidentified`), so a capture that takes every key gets
    // it. The capture decides over the canonical shortcut keystroke.
    let mut key_event = crate::keyboard::key_event(
        surface,
        keyval,
        keycode,
        modifiers,
        crate::keyboard::KeyPhase::Down { repeat },
    );
    let captured = crate::keyboard::captures(surface, &view, &key_event, keycode, modifiers, group);
    key_event.default_prevented = captured;
    crate::keyboard::notify(surface, &view, EventKind::KeyDown, key_event);
    if captured {
        // The view took the key: no menu shortcut, traversal, activation or
        // context menu.
        return true;
    }
    // The application menu's shortcuts come before the defaults: a menu's
    // key is the app's, not a traversal or a context menu.
    if menu_shortcut() {
        return true;
    }
    // Tab's traversal is a default too: it is armed here, then GTK moves the
    // focus right after this, in the same dispatch.
    defaults(surface, &view, keyval, modifiers, repeat)
}

/// Whether `keyval` is a Tab (the app's traversal).
fn is_tab(keyval: gdk::Key) -> bool {
    matches!(
        keyval,
        gdk::Key::Tab | gdk::Key::ISO_Left_Tab | gdk::Key::KP_Tab
    )
}

fn arm_tab() {
    TABBING.set(true);
    glib::idle_add_local_once(|| TABBING.set(false));
}

/// The defaults of a focused stop: Tab's traversal, a context menu on
/// Shift+F10 or the Menu key, and Return and Space pressing a view that
/// takes presses. True when one consumed the key.
fn defaults(
    surface: &Rc<Surface>,
    view: &NshView,
    keyval: gdk::Key,
    modifiers: gdk::ModifierType,
    repeat: bool,
) -> bool {
    if is_tab(keyval) {
        // Only a Tab left to GTK may offer the stops for traversal.
        arm_tab();
        return false;
    }
    let held = crate::input::modifiers(modifiers);
    let function = (keyval == gdk::Key::F10).then_some(Key::F(10));
    if core_input::opens_context_menu(keyval == gdk::Key::Menu, function, held) {
        return show_context_menu(surface, view);
    }
    let pressing = match keyval {
        gdk::Key::Return | gdk::Key::KP_Enter | gdk::Key::ISO_Enter => Key::Enter,
        gdk::Key::space => Key::Char(' '),
        _ => return false,
    };
    presses(surface, view, pressing, held, repeat)
}

/// Whether `focus` (a window's focus widget) is a stop that Return and
/// Space press: one of the surface's views that takes presses. The app's
/// bindings of those keys then give way to it, but for the focus' own
/// (`Keymap::find_at`).
pub(crate) fn is_control(surface: &Surface, focus: &gtk::Widget) -> bool {
    focused_stop(surface, Some(focus.clone()))
        .is_some_and(|view| view.state().events.contains(EventKind::Press))
}

/// Return and Space press the focused stop `view` when it takes presses
/// ([`core_input::presses_focused_control`]), once the app's bindings of
/// the focus passed on them. A stop that takes no presses (a `focusable`
/// chart) hears them through the shortcuts only. True when the key was
/// consumed, including a repeat that must not press the control again.
fn presses(
    surface: &Surface,
    view: &NshView,
    key: Key,
    held: nsh_core::keymap::Modifiers,
    repeat: bool,
) -> bool {
    if !core_input::presses_focused_control(key, held)
        || !view.state().events.contains(EventKind::Press)
    {
        return false;
    }
    if !repeat {
        crate::input::activate(surface, view);
    }
    true
}

/// A key pressed without a GDK event (`nsh test --target linux` without
/// XTest) that no binding took: Return or Space press the focused stop of
/// the key window, as [`press`] has them do. True when it was pressed.
#[cfg(feature = "dev")]
pub(crate) fn press_key(surface: &Surface, stroke: nsh_core::keymap::Keystroke) -> bool {
    let focus = crate::window::key_window(surface).and_then(|w| GtkWindowExt::focus(&w));
    focused_stop(surface, focus)
        .is_some_and(|view| presses(surface, &view, stroke.key, stroke.modifiers, false))
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
    use nsh_core::{
        Command, EventMask, KeyCapture, MountItem, NodeId, ROOT_ID, ViewProps, ViewStyle,
        keymap::Keystroke, platform::Os,
    };

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

    /// `props` of `id`, changed as `edit` says.
    fn props(surface: &Rc<Surface>, id: NodeId, edit: impl FnOnce(&mut ViewProps)) {
        let mut props = view(surface, id).state().props.clone();
        edit(&mut props);
        apply(surface, &[MountItem::ViewProps { id, props }]);
    }

    fn loses_focus(change: MountItem) {
        let surface = surface();
        let mut items = Vec::new();
        for (id, y) in [(2, 0.0), (3, 40.0)] {
            let mut events = EventMask::default();
            events.set(EventKind::Press, true);
            items.extend([
                MountItem::Create {
                    id,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                },
                MountItem::Frame {
                    id,
                    frame: frame(0.0, y, 100.0, 30.0),
                },
                MountItem::Events { id, events },
            ]);
        }
        apply(&surface, &items);
        let window = show(&surface);
        let first = view(&surface, 2);
        let neighbor = view(&surface, 3);
        assert!(wait_until(|| first.is_mapped() && neighbor.is_mapped()));
        let command = |id| {
            [MountItem::Command {
                id,
                command: Command::Focus,
            }]
        };
        // Prove the neighbor accepts explicit focus before testing invalidation.
        apply(&surface, &command(3));
        assert!(wait_until(|| neighbor.is_focus()));
        apply(&surface, &command(2));
        assert!(wait_until(|| first.is_focus()));
        assert_ne!(first.state().states & state::FOCUSED, 0);

        apply(&surface, &[change]);
        let cleared =
            wait_until(|| !first.is_focus() && first.state().states & state::FOCUSED == 0);
        // Capture both observations before any failure, and close even on red.
        let native_focus = GtkWindowExt::focus(&window).map(|widget| {
            (
                widget.type_().name().to_string(),
                widget == *first.upcast_ref::<gtk::Widget>(),
                widget == *neighbor.upcast_ref::<gtk::Widget>(),
            )
        });
        let diagnostic = format!(
            "native={native_focus:?}, focus_state={}",
            first.state().states & state::FOCUSED != 0,
        );
        window.destroy();
        assert!(
            cleared,
            "ineligible stop kept native focus or NSH focus state: {diagnostic}"
        );
    }

    #[test]
    fn focusable_false_releases_native_focus_with_press_listener_retained() {
        run(|| {
            loses_focus(MountItem::ViewProps {
                id: 2,
                props: Box::new(ViewProps {
                    focusable: Some(false),
                    ..Default::default()
                }),
            });
        });
    }

    #[test]
    fn removing_the_only_press_listener_releases_native_focus() {
        run(|| {
            loses_focus(MountItem::Events {
                id: 2,
                events: EventMask::default(),
            });
        });
    }

    #[test]
    fn disabling_a_focused_stop_releases_native_focus() {
        run(|| {
            let mut props = ViewProps::default();
            props.accessibility.state.disabled = true;
            loses_focus(MountItem::ViewProps {
                id: 2,
                props: Box::new(props),
            });
        });
    }

    #[test]
    fn a_visible_restyle_keeps_keyboard_focus() {
        run(|| {
            let surface = surface();
            views(&surface);
            let window = show(&surface);
            let first = view(&surface, 2);
            assert!(wait_until(|| first.is_mapped()));
            apply(
                &surface,
                &[MountItem::Command {
                    id: 2,
                    command: Command::Focus,
                }],
            );
            let owns_focus = || first.is_focus() && first.state().states & state::FOCUSED != 0;
            assert!(wait_until(owns_focus));

            apply(
                &surface,
                &[MountItem::ViewStyle {
                    id: 2,
                    style: Box::new(ViewStyle {
                        opacity: 0.5,
                        ..Default::default()
                    }),
                }],
            );
            let (native, focused) = (first.is_focus(), first.state().states & state::FOCUSED != 0);
            window.destroy();
            assert!(
                native && focused,
                "visible restyle cleared focus: native={native}, focused={focused}"
            );
        });
    }

    #[test]
    fn tab_skips_a_mounted_hidden_stop() {
        run(|| {
            let surface = surface();
            views(&surface);
            apply(
                &surface,
                &[MountItem::ViewStyle {
                    id: 2,
                    style: Box::new(ViewStyle {
                        hidden: true,
                        ..Default::default()
                    }),
                }],
            );
            let window = show(&surface);
            let (hidden, last) = (view(&surface, 2), view(&surface, 4));
            assert!(wait_until(|| last.is_mapped()));
            tab(&window);
            let (hidden_has_focus, last_has_focus) = (hidden.is_focus(), last.is_focus());
            window.destroy();
            assert!(
                !hidden_has_focus && last_has_focus,
                "Tab did not skip hidden stop: hidden={hidden_has_focus}, last={last_has_focus}"
            );
        });
    }

    #[test]
    fn hiding_a_focused_stop_releases_native_focus() {
        run(|| {
            // This tests the mounted hidden style, NOT GtkWidget::set_visible.
            loses_focus(MountItem::ViewStyle {
                id: 2,
                style: Box::new(ViewStyle {
                    hidden: true,
                    ..Default::default()
                }),
            });
        });
    }

    /// The display's keycode for `key`.
    fn keycode(key: gdk::Key) -> u32 {
        gdk::Display::default()
            .and_then(|display| display.map_keyval(key))
            .and_then(|keys| keys.first().map(|key| key.keycode()))
            .expect("a keycode")
    }

    /// Whether a press of `key` is captured by `view`'s ancestry, from the
    /// display's keycode for it.
    fn captured(surface: &Surface, view: &NshView, key: gdk::Key) -> bool {
        let keycode = keycode(key);
        let event = crate::keyboard::key_event(
            surface,
            key,
            keycode,
            gdk::ModifierType::empty(),
            crate::keyboard::KeyPhase::Down { repeat: false },
        );
        crate::keyboard::captures(
            surface,
            view,
            &event,
            keycode,
            gdk::ModifierType::empty(),
            0,
        )
    }

    #[derive(Clone)]
    struct StopPresses {
        nodes: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>,
        move_focus: bool,
    }

    #[nsh_core::element::component]
    fn RepeatStops() -> impl nsh_core::element::IntoElement {
        use nsh_core::prelude::*;

        let recorded = engine_context::<StopPresses>().unwrap();
        let first = recorded.nodes.clone();
        let second = recorded.nodes.clone();
        let move_focus = recorded.move_focus;
        let next = element_ref();
        view().children([
            view()
                .test_id("first-stop")
                .w(px(100.0))
                .h(px(40.0))
                .on_press(move || {
                    first.lock().unwrap().push("first");
                    if move_focus {
                        next.focus();
                    }
                }),
            view()
                .test_id("second-stop")
                .element_ref(&next)
                .w(px(100.0))
                .h(px(40.0))
                .on_press(move || second.lock().unwrap().push("second")),
        ])
    }

    fn repeated_return(move_focus: bool) {
        run(move || {
            let surface = surface();
            let nodes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut config = nsh_engine::EngineConfig::new(nsh_engine::Root::of::<RepeatStops>());
            config.context = config.context.with(StopPresses {
                nodes: nodes.clone(),
                move_focus,
            });
            surface.start(config);
            let window = show(&surface);
            let find = |name| {
                surface
                    .mounter
                    .borrow()
                    .views
                    .values()
                    .find(|view| view.state().props.test_id.as_deref() == Some(name))
                    .filter(|view| view.is_mapped())
                    .cloned()
            };
            assert!(wait_until(|| {
                find("first-stop").is_some() && find("second-stop").is_some()
            }));
            let first = find("first-stop").unwrap();
            let second = find("second-stop").unwrap();
            // Neither stop listens to raw keys: exercise press -> defaults
            // -> presses -> input::activate, not just KeyDown notification.
            assert!(!crate::keyboard::listens(&surface, &first));
            assert!(!crate::keyboard::listens(&surface, &second));
            focus(&first);
            assert!(first.is_focus());
            let code = keycode(gdk::Key::Return);
            let down = || {
                press(
                    &surface,
                    Some(window.upcast_ref()),
                    None,
                    gdk::Key::Return,
                    code,
                    gdk::ModifierType::empty(),
                    0,
                )
            };
            let flush = || {
                let (sent, received) = std::sync::mpsc::channel();
                surface.control(|control| {
                    control.flush(move |done| {
                        let _ = sent.send(done);
                    });
                });
                assert!(wait_until(|| received.try_recv() == Ok(true)));
            };
            down();
            flush();
            assert_eq!(*nodes.lock().unwrap(), ["first"]);
            assert!(wait_until(|| {
                if move_focus {
                    second.is_focus()
                } else {
                    first.is_focus()
                }
            }));
            // The same physical key goes down again without an intervening
            // release, just as GDK delivers an auto-repeat.
            let consumed = down();
            flush();
            assert_eq!(
                *nodes.lock().unwrap(),
                ["first"],
                "a held Return must not press again"
            );
            assert!(consumed, "a repeated control key must not propagate");
            assert!(crate::keyboard::held_key(&surface, code));
            crate::keyboard::released(
                &surface,
                Some(&window),
                focused_view(&surface, &window).as_ref(),
                gdk::Key::Return,
                code,
                gdk::ModifierType::empty(),
                0,
            );
            assert!(!crate::keyboard::held_key(&surface, code));
            down();
            flush();
            assert_eq!(
                *nodes.lock().unwrap(),
                ["first", if move_focus { "second" } else { "first" }]
            );
            window.destroy();
        });
    }

    #[test]
    fn a_held_return_presses_a_stop_once() {
        repeated_return(false);
    }

    #[test]
    fn a_return_repeat_does_not_press_the_stop_focused_by_its_handler() {
        repeated_return(true);
    }

    #[test]
    fn a_capture_takes_the_key_before_the_defaults() {
        run(|| {
            let surface = surface();
            views(&surface);
            let window = show(&surface);
            let (first, plain, last) = (view(&surface, 2), view(&surface, 3), view(&surface, 4));
            assert!(wait_until(|| first.is_mapped()));
            // The plain view becomes a stop that only listens to keys.
            props(&surface, 3, |props| props.focusable = Some(true));
            focus(&plain);
            assert!(plain.is_focus());
            // Listening does not consume: Tab is still GTK's traversal and
            // Space is still the platform's.
            assert!(!press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::space,
                keycode(gdk::Key::space),
                gdk::ModifierType::empty(),
                0,
            ));
            assert!(!press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::Tab,
                keycode(gdk::Key::Tab),
                gdk::ModifierType::empty(),
                0,
            ));
            tab(&window);
            assert!(last.is_focus(), "an uncaptured Tab still moves the focus");
            // A capture consumes the key here, before GTK's traversal.
            focus(&first);
            assert!(first.is_focus());
            props(&surface, 2, |props| props.key_capture = KeyCapture::All);
            assert!(press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::Tab,
                keycode(gdk::Key::Tab),
                gdk::ModifierType::empty(),
                0,
            ));
            assert!(first.is_focus(), "a captured Tab is no traversal");
            assert!(
                !TABBING.get(),
                "a captured Tab must not arm another window's focus"
            );
            // The capture follows the mounted props.
            props(&surface, 2, |props| props.key_capture = KeyCapture::None);
            assert!(!press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::Tab,
                keycode(gdk::Key::Tab),
                gdk::ModifierType::empty(),
                0,
            ));
            window.child_focus(gtk::DirectionType::TabForward);
            assert!(plain.is_focus());
            assert!(wait_until(|| !TABBING.get()));
            window.destroy();
        });
    }

    #[test]
    fn capture_walks_enabled_ancestors_only() {
        run(|| {
            let surface = surface();
            apply(
                &surface,
                &[
                    MountItem::Create {
                        id: 2,
                        kind: ViewKind::View,
                    },
                    MountItem::Insert {
                        parent: ROOT_ID,
                        child: 2,
                        before: None,
                    },
                    MountItem::Create {
                        id: 3,
                        kind: ViewKind::View,
                    },
                    MountItem::Insert {
                        parent: 2,
                        child: 3,
                        before: None,
                    },
                    MountItem::Frame {
                        id: 2,
                        frame: frame(0.0, 0.0, 100.0, 80.0),
                    },
                    MountItem::Frame {
                        id: 3,
                        frame: frame(0.0, 0.0, 100.0, 40.0),
                    },
                ],
            );
            let escape = Keystroke::parse("escape", Os::Linux).expect("a stroke");
            props(&surface, 2, |props| {
                props.key_capture = KeyCapture::keys([escape]);
            });
            let child = view(&surface, 3);
            let mut events = EventMask::default();
            events.set(EventKind::KeyDown, true);
            apply(&surface, &[MountItem::Events { id: 2, events }]);
            assert!(
                crate::keyboard::listens(&surface, &child),
                "an ancestor's raw listener reaches the child"
            );
            assert!(captured(&surface, &child, gdk::Key::Escape));
            assert!(!captured(&surface, &child, gdk::Key::Return));
            // A disabled view captures nothing.
            props(&surface, 2, |props| {
                props.accessibility.state.disabled = true;
            });
            assert!(!captured(&surface, &child, gdk::Key::Escape));
        });
    }

    /// Two portaled children share a native overlay host: one's logical
    /// parent listens and captures, the other's does not. Keyboard ancestry
    /// follows `key_parent`, not the native Insert parent.
    #[test]
    fn a_portals_logical_ancestor_routes_interest_and_capture() {
        run(|| {
            let surface = surface();
            let mut items = Vec::new();
            for id in [2, 5, 7] {
                items.push(MountItem::Create {
                    id,
                    kind: ViewKind::View,
                });
                items.push(MountItem::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                });
            }
            for id in [3, 4] {
                items.push(MountItem::Create {
                    id,
                    kind: ViewKind::View,
                });
                items.push(MountItem::Insert {
                    parent: 5,
                    child: id,
                    before: None,
                });
            }
            apply(&surface, &items);
            // The logical ancestor hears raw keys and captures them; the
            // unrelated logical parent (7) does neither.
            let mut events = EventMask::default();
            events.set(EventKind::KeyDown, true);
            apply(&surface, &[MountItem::Events { id: 2, events }]);
            props(&surface, 2, |props| props.key_capture = KeyCapture::All);
            props(&surface, 3, |props| {
                props.key_parent = Some(2);
                props.focusable = Some(true);
            });
            props(&surface, 4, |props| {
                props.key_parent = Some(7);
                props.focusable = Some(true);
            });
            let child = view(&surface, 3);
            let sibling = view(&surface, 4);
            assert!(
                crate::keyboard::listens(&surface, &child),
                "the portal follows its logical ancestor"
            );
            assert!(captured(&surface, &child, gdk::Key::Escape));
            assert!(
                !crate::keyboard::listens(&surface, &sibling),
                "an unrelated portal is not under the listener"
            );
            assert!(!captured(&surface, &sibling, gdk::Key::Escape));
        });
    }

    #[test]
    fn every_key_capture_takes_an_unidentified_key_and_none_lets_it_go() {
        run(|| {
            let surface = surface();
            views(&surface);
            // The view stays a stop (it takes presses) and hears the raw
            // keys, so a press takes the raw path.
            let mut events = EventMask::default();
            events.set(EventKind::Press, true);
            events.set(EventKind::KeyDown, true);
            apply(&surface, &[MountItem::Events { id: 2, events }]);
            let window = show(&surface);
            let first = view(&surface, 2);
            assert!(wait_until(|| first.is_mapped()));
            focus(&first);
            assert!(first.is_focus());
            // An unnamed key without a hardware code reports neither an
            // invented identity nor a code.
            let event = crate::keyboard::key_event(
                &surface,
                gdk::Key::VoidSymbol,
                0,
                gdk::ModifierType::empty(),
                crate::keyboard::KeyPhase::Down { repeat: false },
            );
            assert_eq!(event.key, "Unidentified");
            assert_eq!(event.code, "");
            assert!(!event.default_prevented);
            // `All` takes it before the defaults.
            props(&surface, 2, |props| props.key_capture = KeyCapture::All);
            assert!(press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::VoidSymbol,
                0,
                gdk::ModifierType::empty(),
                0,
            ));
            // `None` leaves it to the platform.
            props(&surface, 2, |props| props.key_capture = KeyCapture::None);
            assert!(!press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::VoidSymbol,
                0,
                gdk::ModifierType::empty(),
                0,
            ));
            window.destroy();
        });
    }

    #[test]
    fn a_tab_press_arms_the_traversal_without_focus() {
        run(|| {
            let surface = surface();
            views(&surface);
            let window = show(&surface);
            let first = view(&surface, 2);
            assert!(wait_until(|| first.is_mapped()));
            assert!(GtkWindowExt::focus(&window).is_none());
            // The press itself arms GTK's traversal (the stops are
            // focusable only while it moves the focus): no test helper.
            assert!(!press(
                &surface,
                Some(window.upcast_ref()),
                None,
                gdk::Key::Tab,
                keycode(gdk::Key::Tab),
                gdk::ModifierType::empty(),
                0,
            ));
            window.child_focus(gtk::DirectionType::TabForward);
            assert!(first.is_focus(), "Tab from nothing enters the first stop");
            assert!(wait_until(|| !TABBING.get()));
            window.destroy();
        });
    }

    #[test]
    fn a_release_is_reported_to_the_view_focused_then() {
        run(|| {
            let surface = surface();
            views(&surface);
            let window = show(&surface);
            let (first, last) = (view(&surface, 2), view(&surface, 4));
            assert!(wait_until(|| first.is_mapped()));
            focus(&first);
            assert!(first.is_focus());
            assert!(!crate::keyboard::held(&surface, &window, 9));
            crate::keyboard::notify(
                &surface,
                &first,
                EventKind::KeyDown,
                crate::keyboard::key_event(
                    &surface,
                    gdk::Key::Escape,
                    9,
                    gdk::ModifierType::empty(),
                    crate::keyboard::KeyPhase::Down { repeat: false },
                ),
            );
            assert!(crate::keyboard::held_key(&surface, 9));
            // A focus move keeps the key held, and the view focused at the
            // source's release is the one the key up goes to.
            focus(&last);
            assert!(last.is_focus());
            assert!(crate::keyboard::held_key(&surface, 9));
            assert_eq!(focused_view(&surface, &window).map(|v| v.id()), Some(4));
            // The release ends the hold; there is no original down target
            // to send it back to.
            crate::keyboard::released(
                &surface,
                Some(&window),
                focused_view(&surface, &window).as_ref(),
                gdk::Key::Escape,
                9,
                gdk::ModifierType::empty(),
                0,
            );
            assert!(!crate::keyboard::held_key(&surface, 9));
            window.destroy();
        });
    }

    #[test]
    fn the_fast_path_follows_the_mounted_events_and_capture() {
        run(|| {
            let surface = surface();
            views(&surface);
            let plain = view(&surface, 3);
            assert!(!crate::keyboard::listens(&surface, &plain));
            let mut events = EventMask::default();
            events.set(EventKind::KeyDown, true);
            apply(&surface, &[MountItem::Events { id: 3, events }]);
            assert!(
                crate::keyboard::listens(&surface, &plain),
                "a raw key listener"
            );
            events.set(EventKind::KeyDown, false);
            apply(&surface, &[MountItem::Events { id: 3, events }]);
            assert!(!crate::keyboard::listens(&surface, &plain));
            props(&surface, 3, |props| {
                props.key_capture = KeyCapture::keys([]);
            });
            assert!(
                !crate::keyboard::listens(&surface, &plain),
                "an empty capture takes no key"
            );
            props(&surface, 3, |props| props.key_capture = KeyCapture::All);
            assert!(
                crate::keyboard::listens(&surface, &plain),
                "a capture policy"
            );
        });
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

    /// A removed field takes the focus with it, as a removed DOM element
    /// does: GTK would hand it to another field, where the app's
    /// `notEditing` shortcuts stop firing.
    #[test]
    fn a_removed_field_takes_the_focus_with_it() {
        run(|| {
            let surface = surface();
            let create = |id, kind| MountItem::Create { id, kind };
            let insert = |parent, child| MountItem::Insert {
                parent,
                child,
                before: None,
            };
            let place = |id, y| MountItem::Frame {
                id,
                frame: frame(0.0, y, 100.0, 30.0),
            };
            let configure = |id| MountItem::Input {
                id,
                config: Box::default(),
            };
            // A field in a panel (2), and a field after the panel.
            apply(
                &surface,
                &[
                    create(2, ViewKind::View),
                    create(4, ViewKind::Input),
                    create(6, ViewKind::Input),
                    insert(ROOT_ID, 2),
                    insert(2, 4),
                    insert(ROOT_ID, 6),
                    place(2, 0.0),
                    place(4, 0.0),
                    place(6, 40.0),
                    configure(4),
                    configure(6),
                ],
            );
            let window = show(&surface);
            let field = view(&surface, 4);
            assert!(wait_until(|| field.is_mapped()));
            crate::text_input::focus(&field);
            let in_field =
                |w: &gtk::Window| GtkWindowExt::focus(w).is_some_and(|f| f.is_ancestor(&field));
            assert!(wait_until(|| in_field(&window)));
            apply(&surface, &[MountItem::Remove { id: 2 }]);
            // GTK moves the focus on a later frame.
            let settled = std::time::Instant::now() + std::time::Duration::from_millis(200);
            wait_until(|| std::time::Instant::now() >= settled);
            assert_eq!(
                GtkWindowExt::focus(&window).map(|w| w.type_().name()),
                None,
                "the focus leaves with the field"
            );
            window.destroy();
        });
    }

    #[cfg(feature = "dev")]
    mod menus {
        use nsh_core::{
            desktop::{DesktopCommand, MenuAction, MenuItem, MenuRole, Shortcut},
            keymap::When,
        };

        use super::*;

        /// Whether the tests' display is X11 (real keys need XTest).
        fn x11() -> bool {
            gdk::Display::default().is_some_and(|display| display.type_().name() == "GdkX11Display")
        }

        /// A menu item with Ctrl+N that does `role`.
        fn menu_item(role: MenuRole) -> MenuItem {
            MenuItem::Action(MenuAction {
                id: 1,
                label: "Test".into(),
                shortcut: Some(Shortcut::parse("mod+n", false).expect("a shortcut")),
                enabled: true,
                checked: None,
                role: Some(role),
                when: When::Auto,
                icon: None,
                symbol: None,
                destructive: false,
            })
        }

        /// The application menu of `surface`: one Ctrl+N item with `role`.
        fn set_menu(surface: &Rc<Surface>, role: MenuRole) {
            crate::chrome::command(
                surface,
                &DesktopCommand::SetMenu(Some(vec![menu_item(role)].into())),
            );
        }

        #[test]
        fn a_capture_takes_an_application_menu_key() {
            run(|| {
                if !x11() {
                    return;
                }
                let surface = surface();
                views(&surface);
                let window = show(&surface);
                let first = view(&surface, 2);
                assert!(wait_until(|| first.is_mapped()));
                focus(&first);
                assert!(first.is_focus());
                let mut events = EventMask::default();
                events.set(EventKind::Press, true);
                events.set(EventKind::KeyDown, true);
                apply(&surface, &[MountItem::Events { id: 2, events }]);
                props(&surface, 2, |props| props.key_capture = KeyCapture::All);
                set_menu(&surface, MenuRole::Close);
                let n = keycode(gdk::Key::n);
                crate::xtest::Xtest::with(|x| {
                    x.focus(&window);
                    assert!(wait_until(|| window.is_active()));
                    assert!(x.key(crate::xtest::CONTROL_L, true));
                    assert!(x.key(crate::xtest::char_keysym('n'), true));
                    assert!(
                        wait_until(|| crate::keyboard::held_key(&surface, n)),
                        "the capture hears the key the application menu also binds"
                    );
                    assert!(window.is_visible(), "the menu action did not run");
                    assert!(x.key(crate::xtest::char_keysym('n'), false));
                    assert!(x.key(crate::xtest::CONTROL_L, false));
                })
                .expect("real XTest is required");
                assert!(wait_until(|| !crate::keyboard::held_key(&surface, n)));
                window.destroy();
            });
        }

        #[test]
        fn the_application_menu_runs_without_a_focused_view() {
            run(|| {
                if !x11() {
                    return;
                }
                let surface = surface();
                views(&surface);
                let window = show(&surface);
                let first = view(&surface, 2);
                assert!(wait_until(|| first.is_mapped()));
                assert!(GtkWindowExt::focus(&window).is_none());
                set_menu(&surface, MenuRole::Close);
                crate::xtest::Xtest::with(|x| {
                    x.focus(&window);
                    assert!(wait_until(|| window.is_active()));
                    assert!(x.stroke(&[crate::xtest::CONTROL_L], crate::xtest::char_keysym('n')));
                })
                .expect("real XTest is required");
                assert!(
                    wait_until(|| !window.is_visible()),
                    "a menu shortcut still works where no view hears keys"
                );
            });
        }

        #[test]
        fn a_popover_grab_releases_the_key_it_held() {
            run(|| {
                if !x11() {
                    return;
                }
                let surface = surface();
                views(&surface);
                let window = show(&surface);
                let first = view(&surface, 2);
                assert!(wait_until(|| first.is_mapped()));
                let group = gtk::gio::SimpleActionGroup::new();
                group.add_action(&gtk::gio::SimpleAction::new("item", None));
                surface.root.insert_action_group("popup", Some(&group));
                let model = gtk::gio::Menu::new();
                model.append(Some("Item"), Some("popup.item"));
                let menu = gtk::PopoverMenu::from_model(Some(&model));
                menu.set_parent(&surface.root);
                observe_popovers(&surface, menu.upcast_ref());
                let k = keycode(gdk::Key::k);
                let mut events = nsh_core::EventMask::default();
                events.set(nsh_core::EventKind::KeyDown, true);
                events.set(nsh_core::EventKind::KeyUp, true);
                apply(&surface, &[MountItem::Events { id: 2, events }]);
                props(&surface, 2, |props| props.focusable = Some(true));
                crate::xtest::Xtest::with(|x| {
                    x.focus(&window);
                    assert!(wait_until(|| window.is_active()));
                    focus(&first);
                    assert!(wait_until(|| first.is_focus()));
                    assert!(x.key(crate::xtest::char_keysym('k'), true));
                    assert!(wait_until(|| crate::keyboard::held_key(&surface, k)));
                    menu.popup();
                    assert!(wait_until(|| menu.is_mapped()));
                    assert!(
                        crate::keyboard::held_key(&surface, k),
                        "opening the popup releases nothing"
                    );
                    // A key pressed in the popup is the popup's, not the view's.
                    let seen = Rc::new(std::cell::Cell::new(false));
                    let probe = gtk::EventControllerKey::new();
                    probe.set_propagation_phase(gtk::PropagationPhase::Capture);
                    let flag = seen.clone();
                    probe.connect_key_pressed(move |_, key, _, _| {
                        if key == gdk::Key::j {
                            flag.set(true);
                        }
                        glib::Propagation::Proceed
                    });
                    menu.add_controller(probe);
                    let j = keycode(gdk::Key::j);
                    assert!(x.key(crate::xtest::char_keysym('j'), true));
                    assert!(wait_until(|| seen.get()), "the popup hears its key");
                    assert!(
                        !crate::keyboard::held_key(&surface, j),
                        "a popup's key is not reported to a view"
                    );
                    assert!(x.key(crate::xtest::char_keysym('j'), false));
                    assert!(x.key(crate::xtest::char_keysym('k'), false));
                    assert!(
                        wait_until(|| !crate::keyboard::held_key(&surface, k)),
                        "the popup's grab reports the release"
                    );
                    menu.popdown();
                })
                .expect("real XTest is required");
                assert!(wait_until(|| !menu.is_visible()));
                window.destroy();
            });
        }
    }
}
