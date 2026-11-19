//! GTK file-list drops, routed through the surface's existing hit testing.
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use gtk4::{self as gtk, gdk, prelude::*};
use nsh_core::{EventKind, EventPayload, NodeId};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    position: Cell<Option<(f64, f64)>>,
    uris: RefCell<Vec<String>>,
    controller: RefCell<Option<gtk::DropTarget>>,
    destinations: RefCell<Destinations>,
}

#[derive(Default)]
struct Destinations {
    /// The views that take drops, by id (a table that follows the views
    /// alive, not every id made).
    enabled: nsh_core::id_table::IdTable<()>,
}
impl Destinations {
    fn set(&mut self, id: NodeId, enabled: bool) -> Option<bool> {
        let index = id as usize;
        if self.enabled.contains(index) == enabled {
            return None;
        }
        let before = self.count() != 0;
        if enabled {
            self.enabled.insert(index, ());
        } else {
            self.enabled.remove(index);
        }
        let after = self.count() != 0;
        (before != after).then_some(after)
    }

    fn count(&self) -> usize {
        self.enabled.len()
    }
}

pub(crate) fn events_changed(surface: &Rc<Surface>, view: &NshView) {
    destination_changed(
        surface,
        view.id(),
        view.state().events.contains(EventKind::FileDrop),
    );
}

pub(crate) fn deleted(surface: &Rc<Surface>, id: NodeId) {
    destination_changed(surface, id, false);
}

fn destination_changed(surface: &Rc<Surface>, id: NodeId, enabled: bool) {
    let registration = surface.file_drop.destinations.borrow_mut().set(id, enabled);
    match registration {
        Some(true) => install(surface),
        Some(false) => remove_controller(surface),
        None => {}
    }
    if !enabled {
        let matches = surface
            .file_drop
            .target
            .borrow()
            .as_ref()
            .is_some_and(|view| view.id() == id);
        if matches {
            set_target(surface, None);
        }
    }
}

fn install(surface: &Rc<Surface>) {
    let controller = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    controller.set_preload(true);
    let weak = Rc::downgrade(surface);
    controller.connect_enter(move |controller, x, y| {
        weak.upgrade().map_or(gdk::DragAction::empty(), |surface| {
            *surface.file_drop.uris.borrow_mut() = controller
                .value()
                .map(|value| file_uris(&value))
                .unwrap_or_default();
            update(&surface, x, y)
        })
    });
    // Preloading is asynchronous: report a stationary drag as soon as its
    // list arrives. Leave/reset clears position; an old controller must
    // also not deliver into a replacement app's new drag.
    let weak = Rc::downgrade(surface);
    controller.connect_value_notify(move |controller| {
        if let Some(surface) = weak.upgrade() {
            preloaded(&surface, controller, controller.value());
        }
    });
    let weak = Rc::downgrade(surface);
    controller.connect_motion(move |_, x, y| {
        weak.upgrade()
            .map_or(gdk::DragAction::empty(), |surface| update(&surface, x, y))
    });
    let weak = Rc::downgrade(surface);
    controller.connect_leave(move |_| {
        if let Some(surface) = weak.upgrade() {
            clear(&surface);
        }
    });
    let weak = Rc::downgrade(surface);
    controller.connect_drop(move |_, value, x, y| {
        let Some(surface) = weak.upgrade() else {
            return false;
        };
        let uris = file_uris(value);
        drop_uris(&surface, x as f32, y as f32, uris)
    });
    surface.root.add_controller(controller.clone());
    *surface.file_drop.controller.borrow_mut() = Some(controller);
}

fn update(surface: &Surface, x: f64, y: f64) -> gdk::DragAction {
    if surface.input_paused.get() {
        set_target(surface, None);
        return gdk::DragAction::empty();
    }
    surface.file_drop.position.set(Some((x, y)));
    let target = input::file_drop_target(surface, x as f32, y as f32);
    let action = if target.is_some() {
        gdk::DragAction::COPY
    } else {
        gdk::DragAction::empty()
    };
    // Negotiate Copy while loading; entry always carries a local file list.
    let ready = !surface.file_drop.uris.borrow().is_empty();
    set_target(surface, if ready { target } else { None });
    action
}

fn set_target(surface: &Surface, target: Option<NshView>) {
    let mut current = surface.file_drop.target.borrow_mut();
    if current.as_ref().map(NshView::id) == target.as_ref().map(NshView::id) {
        return;
    }
    if let Some(previous) = current.take()
        && previous.state().events.contains(EventKind::FileDragLeave)
    {
        surface.event(previous.id(), EventKind::FileDragLeave, EventPayload::None);
    }
    if let Some(next) = &target
        && next.state().events.contains(EventKind::FileDragEnter)
    {
        surface.event(
            next.id(),
            EventKind::FileDragEnter,
            EventPayload::FileDrop(surface.file_drop.uris.borrow().clone()),
        );
    }
    *current = target;
}

fn preloaded(surface: &Surface, controller: &gtk::DropTarget, value: Option<gtk::glib::Value>) {
    if surface.file_drop.controller.borrow().as_ref() == Some(controller)
        && let Some((x, y)) = surface.file_drop.position.get()
    {
        *surface.file_drop.uris.borrow_mut() = value.as_ref().map(file_uris).unwrap_or_default();
        update(surface, x, y);
    }
}

fn file_uris(value: &gtk::glib::Value) -> Vec<String> {
    value
        .get::<gdk::FileList>()
        .map(|files| {
            files
                .files()
                .into_iter()
                .filter(|file| file.path().is_some_and(|path| path.is_absolute()))
                .map(|file| file.uri().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn clear(surface: &Surface) {
    surface.file_drop.position.set(None);
    surface.file_drop.uris.borrow_mut().clear();
    set_target(surface, None);
}

fn remove_controller(surface: &Surface) {
    clear(surface);
    let controller = surface.file_drop.controller.borrow_mut().take();
    if let Some(controller) = controller {
        surface.root.remove_controller(&controller);
    }
    set_target(surface, None);
}

pub(crate) fn reset(surface: &Surface) {
    remove_controller(surface);
    *surface.file_drop.destinations.borrow_mut() = Destinations::default();
}

/// Drops `uris` at `x`, `y` (the root's coordinates) on the view there that
/// listens, as a drop from a file manager does: whether one took them. The
/// test agent's `dropFiles` comes here too.
pub(crate) fn drop_uris(surface: &Surface, x: f32, y: f32, uris: Vec<String>) -> bool {
    if surface.input_paused.get() {
        set_target(surface, None);
        return false;
    }
    let Some(destination) = input::file_drop_target(surface, x, y) else {
        clear(surface);
        return false;
    };
    if uris.is_empty() {
        clear(surface);
        return false;
    }
    *surface.file_drop.uris.borrow_mut() = uris.clone();
    set_target(surface, Some(destination.clone()));
    surface.event(
        destination.id(),
        EventKind::FileDrop,
        EventPayload::FileDropAt {
            uris,
            page_position: nsh_core::prelude::point(nsh_core::Points(x), nsh_core::Points(y)),
        },
    );
    clear(surface);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gtk_test;

    #[test]
    fn preload_finishes_a_stationary_drag_but_not_a_left_or_reset_drag() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            surface.root.state_mut().frame = gtk_test::frame(0.0, 0.0, 100.0, 100.0);
            surface
                .root
                .state_mut()
                .events
                .set(EventKind::FileDrop, true);
            surface
                .root
                .state_mut()
                .events
                .set(EventKind::FileDragEnter, true);
            install(&surface);
            let controller = surface.file_drop.controller.borrow().clone().unwrap();
            let files = gdk::FileList::from_array(&[
                gtk::gio::File::for_path("/tmp/a b.png"),
                gtk::gio::File::for_uri("https://example.com/remote.png"),
            ])
            .to_value();
            assert_eq!(update(&surface, 10.0, 10.0), gdk::DragAction::COPY);
            assert!(surface.file_drop.target.borrow().is_none());
            preloaded(&surface, &controller, Some(files.clone()));
            assert_eq!(
                surface.file_drop.target.borrow().as_ref().map(NshView::id),
                Some(nsh_core::ROOT_ID)
            );
            assert_eq!(*surface.file_drop.uris.borrow(), ["file:///tmp/a%20b.png"]);
            clear(&surface);
            preloaded(&surface, &controller, Some(files.clone()));
            assert!(surface.file_drop.target.borrow().is_none());
            assert!(surface.file_drop.uris.borrow().is_empty());
            update(&surface, 10.0, 10.0);
            reset(&surface);
            preloaded(&surface, &controller, Some(files.clone()));
            assert!(surface.file_drop.uris.borrow().is_empty());
            // A new app may already be dragging when the old controller notifies.
            install(&surface);
            update(&surface, 10.0, 10.0);
            preloaded(&surface, &controller, Some(files));
            assert!(surface.file_drop.target.borrow().is_none());
            assert!(surface.file_drop.uris.borrow().is_empty());
            reset(&surface);
        });
    }
}
