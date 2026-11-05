//! Files dragged in from other applications (`onFileDragEnter`,
//! `onFileDragLeave`, `onFileDrop`).
//!
//! GPUI turns an external drag into an internal one carrying
//! [`gpui::ExternalPaths`]: its moves and its drop reach only GPUI's own
//! elements, and the surface's hitbox blocks the mouse for those behind it,
//! so the app view lays a drop layer over the surface while a drag is active
//! (`app.rs`). The layer reports where the drag is and the drop; this module
//! keeps the destination: the closest view under the pointer, within its
//! modal, that listens to `onFileDrop` ([`crate::input::file_drop_target`]).
//! Moving between destinations leaves one and enters the other; leaving the
//! window, dropping, and the destination's removal or disablement clear it.

use std::cell::{Cell, RefCell};

use nsh_core::{EventKind, EventPayload, NodeId};

use crate::{surface::Surface, view::NshView};

/// The destination of a surface's file drag.
#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    /// A [`clear`] is scheduled for a drag that ended ([`take_needs_clear`]).
    clearing: Cell<bool>,
}

fn set_target(surface: &Surface, target: Option<NshView>) {
    let previous = {
        let mut current = surface.file_drop.target.borrow_mut();
        if current.as_ref().map(NshView::id) == target.as_ref().map(NshView::id) {
            return;
        }
        std::mem::replace(&mut *current, target.clone())
    };
    // The events go out once the destination is stored and no longer
    // borrowed, so whatever handles them may ask for it again.
    if let Some(previous) = previous
        && previous.state().events.contains(EventKind::FileDragLeave)
    {
        surface.event(previous.id(), EventKind::FileDragLeave, EventPayload::None);
    }
    if let Some(next) = &target
        && next.state().events.contains(EventKind::FileDragEnter)
    {
        surface.event(next.id(), EventKind::FileDragEnter, EventPayload::None);
    }
}

/// No drag is active: whether the last one still has a destination for
/// which no [`clear`] is scheduled yet. Answering yes counts the clear as
/// scheduled, so a window redrawn again before it runs schedules no other.
pub(crate) fn take_needs_clear(surface: &Surface) -> bool {
    let state = &surface.file_drop;
    if state.clearing.get() || state.target.borrow().is_none() {
        return false;
    }
    state.clearing.set(true);
    true
}

/// The drag moved to `(x, y)` (root points).
pub(crate) fn update(surface: &Surface, x: f32, y: f32) {
    set_target(surface, crate::input::file_drop_target(surface, x, y));
}

/// The drag left the window or ended.
pub(crate) fn clear(surface: &Surface) {
    surface.file_drop.clearing.set(false);
    set_target(surface, None);
}

/// The view `id` was removed or stopped listening to drops.
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

/// The view's listeners changed: a destination that no longer listens to
/// drops stops being one.
pub(crate) fn events_changed(surface: &Surface, view: &NshView) {
    if !view.state().events.contains(EventKind::FileDrop) {
        invalidate(surface, view.id());
    }
}

/// The files at `paths` were dropped at `(x, y)` (root points); relative
/// paths are left out. Whether a destination heard them.
pub(crate) fn perform(surface: &Surface, x: f32, y: f32, paths: &[std::path::PathBuf]) -> bool {
    let uris = uris(paths);
    let destination = crate::input::file_drop_target(surface, x, y);
    let (Some(destination), false) = (destination, uris.is_empty()) else {
        clear(surface);
        return false;
    };
    set_target(surface, Some(destination.clone()));
    surface.event(
        destination.id(),
        EventKind::FileDrop,
        EventPayload::FileDrop(uris),
    );
    clear(surface);
    true
}

/// The absolute paths among `paths`, as `file:` URLs in their order.
fn uris(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| path.is_absolute())
        .map(|path| nsh_core::platform::clipboard::file_url(&path.to_string_lossy()))
        .collect()
}

/// An absolute path to `name` for tests: `/tmp/name`, or `C:\tmp\name` on
/// Windows, where a path without a drive is not absolute.
#[cfg(test)]
pub(crate) fn test_path(name: &str) -> String {
    if cfg!(windows) {
        format!(r"C:\tmp\{name}")
    } else {
        format!("/tmp/{name}")
    }
}

/// The `file:` URL of [`test_path`]`(name)`, `escaped` being `name`
/// percent-encoded.
#[cfg(test)]
pub(crate) fn test_url(escaped: &str) -> String {
    if cfg!(windows) {
        format!("file:///C:/tmp/{escaped}")
    } else {
        format!("file:///tmp/{escaped}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_paths_become_file_urls() {
        let paths = [test_path("a b.txt"), "relative.txt".into(), test_path("é")]
            .map(std::path::PathBuf::from);
        assert_eq!(uris(&paths), [test_url("a%20b.txt"), test_url("%C3%A9")]);
    }
}
