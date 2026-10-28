//! GTK file-list drops, routed through the surface's existing hit testing.
use std::{cell::RefCell, rc::Rc};

use gtk4::{self as gtk, gdk, prelude::*};
use nsh_core::{EventKind, EventPayload, NodeId};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    controller: RefCell<Option<gtk::DropTarget>>,
    destinations: RefCell<Destinations>,
}

#[derive(Default)]
struct Destinations {
    enabled: Vec<bool>,
    count: usize,
}
impl Destinations {
    fn set(&mut self, id: NodeId, enabled: bool) -> Option<bool> {
        let index = id as usize;
        if self.enabled.get(index).copied().unwrap_or(false) == enabled {
            return None;
        }
        let before = self.count != 0;
        if enabled {
            self.enabled
                .resize(self.enabled.len().max(index + 1), false);
            self.count += 1;
        } else {
            self.count -= 1;
        }
        self.enabled[index] = enabled;
        let after = self.count != 0;
        (before != after).then_some(after)
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
        invalidate(surface, id);
    }
}

/// Ends the old destination's drag state without disabling future drops.
pub(crate) fn invalidate(surface: &Surface, id: NodeId) {
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

fn install(surface: &Rc<Surface>) {
    let controller = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    controller.set_preload(true);
    let weak = Rc::downgrade(surface);
    controller.connect_enter(move |_, x, y| {
        weak.upgrade()
            .map_or(gdk::DragAction::empty(), |surface| update(&surface, x, y))
    });
    let weak = Rc::downgrade(surface);
    controller.connect_motion(move |_, x, y| {
        weak.upgrade()
            .map_or(gdk::DragAction::empty(), |surface| update(&surface, x, y))
    });
    let weak = Rc::downgrade(surface);
    controller.connect_leave(move |_| {
        if let Some(surface) = weak.upgrade() {
            set_target(&surface, None);
        }
    });
    let weak = Rc::downgrade(surface);
    controller.connect_drop(move |_, value, x, y| {
        let Some(surface) = weak.upgrade() else {
            return false;
        };
        let Ok(files) = value.get::<gdk::FileList>() else {
            set_target(&surface, None);
            return false;
        };
        let uris = files
            .files()
            .into_iter()
            .filter(|file| file.path().is_some_and(|path| path.is_absolute()))
            .map(|file| file.uri().to_string())
            .collect::<Vec<_>>();
        drop_uris(&surface, x as f32, y as f32, uris)
    });
    surface.root.add_controller(controller.clone());
    *surface.file_drop.controller.borrow_mut() = Some(controller);
}

fn update(surface: &Surface, x: f64, y: f64) -> gdk::DragAction {
    let target = input::file_drop_target(surface, x as f32, y as f32);
    let action = if target.is_some() {
        gdk::DragAction::COPY
    } else {
        gdk::DragAction::empty()
    };
    set_target(surface, target);
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
        surface.event(next.id(), EventKind::FileDragEnter, EventPayload::None);
    }
    *current = target;
}

fn remove_controller(surface: &Surface) {
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
    let Some(destination) = input::file_drop_target(surface, x, y) else {
        set_target(surface, None);
        return false;
    };
    if uris.is_empty() {
        set_target(surface, None);
        return false;
    }
    set_target(surface, Some(destination.clone()));
    surface.event(
        destination.id(),
        EventKind::FileDrop,
        EventPayload::FileDropAt {
            uris,
            page_position: nsh_core::prelude::point(nsh_core::Points(x), nsh_core::Points(y)),
        },
    );
    set_target(surface, None);
    true
}
