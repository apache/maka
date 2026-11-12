//! AppKit file-list drops, routed by the same hit testing as pointer input.
use std::cell::RefCell;

use nsh_core::{EventKind, EventPayload};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSView};
use objc2_foundation::{NSArray, NSString, NSURL};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    uris: RefCell<Vec<String>>,
    destinations: RefCell<Destinations>,
}

#[derive(Default)]
struct Destinations {
    /// The views that take drops, by id (a table that follows the views
    /// alive, not every id made).
    enabled: nsh_core::id_table::IdTable<()>,
}
impl Destinations {
    fn set(&mut self, id: nsh_core::NodeId, enabled: bool) -> Option<bool> {
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

pub(crate) fn events_changed(surface: &Surface, view: &NshView) {
    let enabled = view.state().events.contains(EventKind::FileDrop);
    destination_changed(surface, view.id(), enabled);
}

pub(crate) fn deleted(surface: &Surface, id: nsh_core::NodeId) {
    destination_changed(surface, id, false);
}

fn destination_changed(surface: &Surface, id: nsh_core::NodeId, enabled: bool) {
    let registration = surface.file_drop.destinations.borrow_mut().set(id, enabled);
    match registration {
        Some(true) => {
            register(surface.root.ns());
            for root in crate::window::roots(surface) {
                register(root.ns());
            }
        }
        Some(false) => {
            surface.root.ns().unregisterDraggedTypes();
            for root in crate::window::roots(surface) {
                root.ns().unregisterDraggedTypes();
            }
        }
        None => {}
    }
    if !enabled {
        invalidate(surface, id);
    }
}

pub(crate) fn reset(surface: &Surface) {
    clear(surface);
    if surface.file_drop.destinations.borrow().count() > 0 {
        surface.root.ns().unregisterDraggedTypes();
    }
    *surface.file_drop.destinations.borrow_mut() = Destinations::default();
}

/// Whether a view of the surface takes file drops: a window's root view
/// made later registers then ([`crate::window`]).
pub(crate) fn accepting(surface: &Surface) -> bool {
    surface.file_drop.destinations.borrow().count() > 0
}

pub(crate) fn register(view: &NSView) {
    let kind = NSString::from_str("public.file-url");
    view.registerForDraggedTypes(&NSArray::from_slice(&[&*kind]));
}

fn target(surface: &Surface, sender: &ProtocolObject<dyn NSDraggingInfo>) -> Option<NshView> {
    if !sender
        .draggingSourceOperationMask()
        .contains(NSDragOperation::Copy)
    {
        return None;
    }
    let point = input::event_root(surface)
        .ns()
        .convertPoint_fromView(sender.draggingLocation(), None);
    input::file_drop_target(surface, point.x as f32, point.y as f32)
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

pub(crate) fn clear(surface: &Surface) {
    surface.file_drop.uris.borrow_mut().clear();
    set_target(surface, None);
}

pub(crate) fn invalidate(surface: &Surface, id: nsh_core::NodeId) {
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

pub(crate) fn begin(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    *surface.file_drop.uris.borrow_mut() = read_uris(sender);
    update(surface, sender)
}

pub(crate) fn update(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    let next = if !surface.file_drop.uris.borrow().is_empty() {
        target(surface, sender)
    } else {
        None
    };
    let operation = if next.is_some() {
        NSDragOperation::Copy
    } else {
        NSDragOperation::None
    };
    set_target(surface, next);
    operation
}

pub(crate) fn perform(surface: &Surface, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
    let Some(destination) = target(surface, sender) else {
        clear(surface);
        return false;
    };
    let uris = read_uris(sender);
    if uris.is_empty() {
        clear(surface);
        return false;
    }
    *surface.file_drop.uris.borrow_mut() = uris.clone();
    set_target(surface, Some(destination.clone()));
    surface.event(
        destination.id(),
        EventKind::FileDrop,
        EventPayload::FileDrop(uris),
    );
    clear(surface);
    true
}

/// A drag entering an input's text view (a text area, a field's editor).
/// AppKit offers a drag to the deepest view registered for one of its
/// types, and a text view registers for files to insert their paths: local
/// files over an input inside a file drop target go to that target, as
/// anywhere else in it (`Some`); any other drag stays the text view's
/// (`None`), text drags included.
pub(crate) fn text_entered(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<NSDragOperation> {
    Some(begin(surface, sender)).filter(|operation| *operation == NSDragOperation::Copy)
}

/// A drag moving over an input's text view: [`text_entered`].
pub(crate) fn text_updated(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<NSDragOperation> {
    if surface.file_drop.uris.borrow().is_empty() {
        return None;
    }
    Some(update(surface, sender)).filter(|operation| *operation == NSDragOperation::Copy)
}

/// A drop on an input's text view: whether the target around it took the
/// files (`Some`), or `None` for the text view to handle ([`text_entered`]).
pub(crate) fn text_performed(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<bool> {
    let offered = !surface.file_drop.uris.borrow().is_empty();
    (offered && target(surface, sender).is_some()).then(|| perform(surface, sender))
}

fn read_uris(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<String> {
    let board = sender.draggingPasteboard();
    let kind = NSString::from_str("public.file-url");
    board
        .pasteboardItems()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.stringForType(&kind))
                .filter_map(|uri| local_file_uri(&uri))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// The `file:` URL with the path of the local file or directory `uri`
/// names, if it names one. Finder puts file reference URLs
/// (`file:///.file/id=…`) on drag and copy pasteboards: they become the
/// path's URL, which apps can turn into a path.
pub(crate) fn local_file_uri(uri: &NSString) -> Option<String> {
    let url = NSURL::URLWithString(uri)?.filePathURL()?;
    let local = url.isFileURL()
        && url
            .path()
            .is_some_and(|path| path.to_string().starts_with('/'))
        && url.host().is_none_or(|host| {
            let host = host.to_string();
            host.is_empty() || host.eq_ignore_ascii_case("localhost")
        });
    local
        .then(|| url.absoluteString())
        .flatten()
        .map(|uri| uri.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finder_references_expose_the_filename_before_drop() {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("nsh-drag-{}-a b.png", std::process::id()));
        std::fs::write(&path, b"metadata only").unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        let reference = url.fileReferenceURL().unwrap().absoluteString().unwrap();
        assert!(reference.to_string().contains("/.file/id="));
        assert_eq!(
            local_file_uri(&reference),
            url.absoluteString().map(|s| s.to_string())
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn registration_lasts_until_the_final_destination_is_removed() {
        let mut destinations = Destinations::default();
        assert_eq!(destinations.set(1, false), None);
        assert_eq!(destinations.set(2, true), Some(true));
        assert_eq!(destinations.set(5, true), None);
        assert_eq!(destinations.set(2, false), None);
        assert_eq!(destinations.set(2, false), None);
        assert_eq!(destinations.set(5, false), Some(false));
        assert_eq!(destinations.set(5, true), Some(true));
    }

    #[test]
    fn file_urls_are_local_and_absolute() {
        for uri in [
            "file:///tmp/a%20b",
            "file:///tmp/%E4%B8%AD/",
            "file://localhost/tmp/a",
        ] {
            assert!(local_file_uri(&NSString::from_str(uri)).is_some(), "{uri}");
        }
        for uri in [
            "https://example.com/file",
            "file://server/tmp/a",
            "file:relative",
            "plain text",
        ] {
            assert_eq!(local_file_uri(&NSString::from_str(uri)), None, "{uri}");
        }
    }

    #[test]
    fn file_reference_urls_become_the_paths_urls() {
        let dir = std::env::temp_dir().join("nsh file drop 中");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a b.txt");
        std::fs::write(&file, "x").unwrap();
        let path = NSString::from_str(&file.to_string_lossy());
        let path_url = NSURL::fileURLWithPath(&path);
        let reference = path_url
            .fileReferenceURL()
            .unwrap()
            .absoluteString()
            .unwrap();
        assert!(
            reference.to_string().starts_with("file:///.file/id="),
            "{reference}"
        );
        // The reference resolves to the file's real path (`/var` is `/private/var`).
        let real = std::fs::canonicalize(&file).unwrap();
        let expected = NSURL::fileURLWithPath(&NSString::from_str(&real.to_string_lossy()))
            .absoluteString()
            .unwrap()
            .to_string();
        assert_eq!(
            local_file_uri(&reference).as_deref(),
            Some(expected.as_str())
        );
        // A reference to nothing (the file is gone) is no file.
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(local_file_uri(&reference), None);
    }
}

/// Routes host-supplied files through the same native hit testing and enter/leave lifecycle.
#[cfg(feature = "terminal")]
pub(crate) fn paths(
    surface: &Surface,
    paths: Vec<std::path::PathBuf>,
    position: nsh_core::Point<nsh_core::Points>,
) {
    let uris: Vec<String> = paths
        .into_iter()
        .filter(|path| path.is_absolute())
        .filter_map(|path| {
            let path = path.to_str()?;
            NSURL::fileURLWithPath(&NSString::from_str(path))
                .absoluteString()
                .map(|url| url.to_string())
        })
        .collect();
    let destination = input::file_drop_target(surface, position.x.0, position.y.0);
    if uris.is_empty() {
        clear(surface);
        return;
    }
    set_target(surface, destination.clone());
    if let Some(destination) = destination {
        surface.event(
            destination.id(),
            EventKind::FileDrop,
            EventPayload::FileDrop(uris),
        );
    }
    clear(surface);
}
