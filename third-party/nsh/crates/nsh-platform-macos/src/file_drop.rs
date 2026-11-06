//! AppKit file-list drops, routed by the same hit testing as pointer input.
use std::cell::{Cell, RefCell};

use nsh_core::{EventKind, EventPayload};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSView};
use objc2_foundation::{NSArray, NSString, NSURL};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    offered: Cell<bool>,
    destinations: RefCell<Destinations>,
}

#[derive(Default)]
struct Destinations {
    enabled: Vec<bool>,
    count: usize,
}
impl Destinations {
    fn set(&mut self, id: nsh_core::NodeId, enabled: bool) -> Option<bool> {
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
        Some(true) => register(surface.root.ns()),
        Some(false) => surface.root.ns().unregisterDraggedTypes(),
        None => {}
    }
    if !enabled {
        invalidate(surface, id);
    }
}

pub(crate) fn reset(surface: &Surface) {
    clear(surface);
    if surface.file_drop.destinations.borrow().count > 0 {
        surface.root.ns().unregisterDraggedTypes();
    }
    *surface.file_drop.destinations.borrow_mut() = Destinations::default();
}

fn register(view: &NSView) {
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
    let point = surface
        .root
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
        surface.event(next.id(), EventKind::FileDragEnter, EventPayload::None);
    }
    *current = target;
}

pub(crate) fn clear(surface: &Surface) {
    surface.file_drop.offered.set(false);
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
    surface.file_drop.offered.set(!read_uris(sender).is_empty());
    update(surface, sender)
}

pub(crate) fn update(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    let next = if surface.file_drop.offered.get() {
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
    set_target(surface, Some(destination.clone()));
    surface.event(
        destination.id(),
        EventKind::FileDrop,
        EventPayload::FileDrop(uris),
    );
    clear(surface);
    true
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
                .filter(|uri| is_local_uri(uri))
                .map(|uri| uri.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn is_local_uri(uri: &NSString) -> bool {
    NSURL::URLWithString(uri).is_some_and(|url| {
        url.isFileURL()
            && url
                .path()
                .is_some_and(|path| path.to_string().starts_with('/'))
            && url.host().is_none_or(|host| {
                let host = host.to_string();
                host.is_empty() || host.eq_ignore_ascii_case("localhost")
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(is_local_uri(&NSString::from_str(uri)), "{uri}");
        }
        for uri in [
            "https://example.com/file",
            "file://server/tmp/a",
            "file:relative",
            "plain text",
        ] {
            assert!(!is_local_uri(&NSString::from_str(uri)), "{uri}");
        }
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
