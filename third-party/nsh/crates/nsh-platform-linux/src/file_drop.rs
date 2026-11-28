//! GTK file-list drops, routed through the surface's existing hit testing.
use std::{cell::RefCell, rc::Rc};

use gtk4::{self as gtk, gdk, glib, prelude::*};
use nsh_core::{EventKind, EventPayload, NodeId};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    position: RefCell<Option<(glib::WeakRef<NshView>, f64, f64)>>,
    uris: RefCell<Vec<String>>,
    controllers: RefCell<Vec<(glib::WeakRef<NshView>, gtk::DropTarget)>>,
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
        Some(false) => remove_controllers(surface),
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

/// Attaches a file-drop controller to a window's root view when any view in the
/// surface listens to `onFileDrop`.
pub(crate) fn attach(surface: &Rc<Surface>, root: &NshView) {
    if surface.file_drop.destinations.borrow().count() == 0 {
        return;
    }
    attach_to(surface, root);
}

fn install(surface: &Rc<Surface>) {
    attach_to(surface, &surface.root);
    for (_, root) in crate::window::roots(surface) {
        attach_to(surface, &root);
    }
}

fn attach_to(surface: &Rc<Surface>, root: &NshView) {
    let mut controllers = surface.file_drop.controllers.borrow_mut();
    controllers.retain(|(r, _)| r.upgrade().is_some());
    if controllers
        .iter()
        .any(|(r, _)| r.upgrade().as_ref() == Some(root))
    {
        return;
    }
    // Wayland compositors may pre-select Move for a file-manager drag before
    // we answer; a Copy-only target then never matches and GTK rejects the
    // whole drag. Take both and prefer Copy (see `action`).
    let controller = gtk::DropTarget::new(
        gdk::FileList::static_type(),
        gdk::DragAction::COPY | gdk::DragAction::MOVE,
    );
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    controller.set_preload(true);
    let weak = Rc::downgrade(surface);
    let weak_root = root.downgrade();
    controller.connect_enter(move |controller, x, y| {
        let (Some(surface), Some(root)) = (weak.upgrade(), weak_root.upgrade()) else {
            return gdk::DragAction::empty();
        };
        *surface.file_drop.uris.borrow_mut() = controller
            .value()
            .map(|value| file_uris(&value))
            .unwrap_or_default();
        action(update(&surface, &root, x, y), offered(controller))
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
    let weak_root = root.downgrade();
    controller.connect_motion(move |controller, x, y| {
        let (Some(surface), Some(root)) = (weak.upgrade(), weak_root.upgrade()) else {
            return gdk::DragAction::empty();
        };
        action(update(&surface, &root, x, y), offered(controller))
    });
    let weak = Rc::downgrade(surface);
    controller.connect_leave(move |_| {
        if let Some(surface) = weak.upgrade() {
            clear(&surface);
        }
    });
    let weak = Rc::downgrade(surface);
    let weak_root = root.downgrade();
    controller.connect_drop(move |_, value, x, y| {
        let (Some(surface), Some(root)) = (weak.upgrade(), weak_root.upgrade()) else {
            return false;
        };
        let uris = file_uris(value);
        drop_uris_in(&surface, &root, x as f32, y as f32, uris)
    });
    root.add_controller(controller.clone());
    controllers.push((root.downgrade(), controller));
}

/// Moves the drag to `x`, `y` in `root`: whether a view there takes drops.
/// Negotiation accepts while the list is loading; entry always carries a local
/// file list.
fn update(surface: &Surface, root: &NshView, x: f64, y: f64) -> bool {
    if surface.input_paused.get() {
        set_target(surface, None);
        return false;
    }
    *surface.file_drop.position.borrow_mut() = Some((root.downgrade(), x, y));
    let target = input::file_drop_target_in(root, x as f32, y as f32);
    let accepts = target.is_some();
    let ready = !surface.file_drop.uris.borrow().is_empty();
    set_target(surface, if ready { target } else { None });
    accepts
}

fn offered(controller: &gtk::DropTarget) -> gdk::DragAction {
    controller
        .current_drop()
        .map_or(gdk::DragAction::COPY, |drop| drop.actions())
}

/// The action to answer with: Copy whenever the drag allows it, so the source
/// keeps its files. Move only when the compositor already chose it; answering
/// Copy and Move then lets it renegotiate to Copy.
fn action(accepts: bool, offered: gdk::DragAction) -> gdk::DragAction {
    if !accepts {
        gdk::DragAction::empty()
    } else if offered.contains(gdk::DragAction::COPY) {
        gdk::DragAction::COPY
    } else if offered.contains(gdk::DragAction::MOVE) {
        gdk::DragAction::MOVE
    } else {
        gdk::DragAction::empty()
    }
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
    let active = surface
        .file_drop
        .controllers
        .borrow()
        .iter()
        .any(|(_, c)| c == controller);
    let pos = surface.file_drop.position.borrow().clone();
    if active
        && let Some((weak_root, x, y)) = pos
        && let Some(root) = weak_root.upgrade()
    {
        *surface.file_drop.uris.borrow_mut() = value.as_ref().map(file_uris).unwrap_or_default();
        update(surface, &root, x, y);
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
    *surface.file_drop.position.borrow_mut() = None;
    surface.file_drop.uris.borrow_mut().clear();
    set_target(surface, None);
}

fn remove_controllers(surface: &Surface) {
    clear(surface);
    for (root, controller) in surface.file_drop.controllers.borrow_mut().drain(..) {
        if let Some(root) = root.upgrade() {
            root.remove_controller(&controller);
        }
    }
    set_target(surface, None);
}

pub(crate) fn reset(surface: &Surface) {
    remove_controllers(surface);
    *surface.file_drop.destinations.borrow_mut() = Destinations::default();
}

/// Drops `uris` at `x`, `y` (the active window root's coordinates) on the view
/// there that listens, as a drop from a file manager does: whether one took
/// them. The test agent's `dropFiles` comes here too.
#[cfg(feature = "dev")]
pub(crate) fn drop_uris(surface: &Surface, x: f32, y: f32, uris: Vec<String>) -> bool {
    drop_uris_in(surface, &input::event_root(surface), x, y, uris)
}

fn drop_uris_in(surface: &Surface, root: &NshView, x: f32, y: f32, uris: Vec<String>) -> bool {
    if surface.input_paused.get() {
        set_target(surface, None);
        return false;
    }
    let Some(destination) = input::file_drop_target_in(root, x, y) else {
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
            let controller = surface.file_drop.controllers.borrow()[0].1.clone();
            let files = gdk::FileList::from_array(&[
                gtk::gio::File::for_path("/tmp/a b.png"),
                gtk::gio::File::for_uri("https://example.com/remote.png"),
            ])
            .to_value();
            assert!(update(&surface, &surface.root, 10.0, 10.0));
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
            update(&surface, &surface.root, 10.0, 10.0);
            reset(&surface);
            preloaded(&surface, &controller, Some(files.clone()));
            assert!(surface.file_drop.uris.borrow().is_empty());
            // A new app may already be dragging when the old controller notifies.
            install(&surface);
            update(&surface, &surface.root, 10.0, 10.0);
            preloaded(&surface, &controller, Some(files));
            assert!(surface.file_drop.target.borrow().is_none());
            assert!(surface.file_drop.uris.borrow().is_empty());
            reset(&surface);
        });
    }

    #[test]
    fn answers_copy_when_offered_and_move_only_when_preselected() {
        use gdk::DragAction as A;
        assert_eq!(action(true, A::COPY | A::MOVE | A::ASK), A::COPY);
        assert_eq!(action(true, A::COPY), A::COPY);
        // Wayland: the compositor pre-selected Move before we answered.
        assert_eq!(action(true, A::MOVE), A::MOVE);
        assert_eq!(action(true, A::LINK), A::empty());
        assert_eq!(action(false, A::COPY | A::MOVE), A::empty());
    }

    #[test]
    fn attaches_and_hit_tests_in_a_secondary_window_root() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let window_root = NshView::new(2, nsh_core::ViewKind::View);
            window_root.state_mut().frame = gtk_test::frame(0.0, 0.0, 100.0, 100.0);
            window_root
                .state_mut()
                .events
                .set(EventKind::FileDrop, true);
            window_root
                .state_mut()
                .events
                .set(EventKind::FileDragEnter, true);

            // No listeners registered yet: `attach` does nothing.
            attach(&surface, &window_root);
            assert!(surface.file_drop.controllers.borrow().is_empty());

            // Registering a listener installs on `surface.root`, and `attach`
            // adds a controller to the secondary `<Window>` root without duplicating.
            events_changed(&surface, &window_root);
            attach(&surface, &window_root);
            attach(&surface, &window_root);
            assert_eq!(surface.file_drop.controllers.borrow().len(), 2);

            let window_controller = surface.file_drop.controllers.borrow()[1].1.clone();
            let files =
                gdk::FileList::from_array(&[gtk::gio::File::for_path("/tmp/doc.txt")]).to_value();

            // `surface.root` itself does not accept drops, but `window_root` does.
            assert!(!update(&surface, &surface.root, 10.0, 10.0));
            assert!(update(&surface, &window_root, 10.0, 10.0));
            preloaded(&surface, &window_controller, Some(files));
            assert_eq!(
                surface.file_drop.target.borrow().as_ref().map(NshView::id),
                Some(2)
            );
            assert!(drop_uris_in(
                &surface,
                &window_root,
                10.0,
                10.0,
                vec!["file:///tmp/doc.txt".into()],
            ));

            reset(&surface);
            assert!(surface.file_drop.controllers.borrow().is_empty());
        });
    }
}
