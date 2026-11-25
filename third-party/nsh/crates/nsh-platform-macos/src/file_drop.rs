//! AppKit file-list drops, routed by the same hit testing as pointer input.
//!
//! A drag offers local files (`public.file-url`: Finder, a screenshot's
//! thumbnail), which drop as their URLs, or only promises files
//! (`NSFilePromiseReceiver`: an image dragged out of a page in Safari or
//! Chrome, Mail's attachments), which are written to a folder of their
//! own once dropped and handed over as their contents (`files`), as on the
//! Web.
use std::{
    cell::RefCell,
    path::PathBuf,
    ptr::NonNull,
    sync::{Arc, Mutex},
};

use block2::RcBlock;
use nsh_core::{
    EventKind, EventPayload, FileContents,
    geometry::{Point, Points, point},
    picker::{FilePickRequest, PickedFile, finish_files, read_picked_files},
};
use objc2::{
    ClassType, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, ProtocolObject},
};
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSFilePromiseReceiver, NSView};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSOperationQueue, NSString, NSURL};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    uris: RefCell<Vec<String>>,
    /// The MIME types of the files a drag without file URLs promises
    /// (`""` for a type with none).
    promised: RefCell<Vec<String>>,
    /// The queue promised files are read on, kept while they are written.
    promise_queue: std::cell::OnceCell<Retained<NSOperationQueue>>,
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
    let mut kinds = vec![kind];
    kinds.extend(NSFilePromiseReceiver::readableDraggedTypes().to_vec());
    let kinds = kinds.iter().map(|k| &**k).collect::<Vec<_>>();
    view.registerForDraggedTypes(&NSArray::from_slice(&kinds));
}

/// Whether the drag being tracked offers files: local ones or promised
/// ones.
fn offered(surface: &Surface) -> bool {
    !surface.file_drop.uris.borrow().is_empty() || !surface.file_drop.promised.borrow().is_empty()
}

/// What `onFileDragEnter` gets: the files' URLs, or for promised files,
/// their types (none are written before the drop).
fn entered_payload(surface: &Surface) -> EventPayload {
    let uris = surface.file_drop.uris.borrow();
    if uris.is_empty() {
        let promised = surface.file_drop.promised.borrow().clone();
        EventPayload::FileContents(Box::new(FileContents::new(Vec::new(), promised, None)))
    } else {
        EventPayload::FileDrop(uris.clone())
    }
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
            entered_payload(surface),
        );
    }
    *current = target;
}

pub(crate) fn clear(surface: &Surface) {
    surface.file_drop.uris.borrow_mut().clear();
    surface.file_drop.promised.borrow_mut().clear();
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
    let uris = read_uris(sender);
    // Local files win: a screenshot's thumbnail offers both.
    let promised = if uris.is_empty() {
        promised_types(&promises(sender))
    } else {
        Vec::new()
    };
    *surface.file_drop.uris.borrow_mut() = uris;
    *surface.file_drop.promised.borrow_mut() = promised;
    update(surface, sender)
}

pub(crate) fn update(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    let next = if offered(surface) {
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
    if !sender
        .draggingSourceOperationMask()
        .contains(NSDragOperation::Copy)
    {
        clear(surface);
        return false;
    }
    let point = input::event_root(surface)
        .ns()
        .convertPoint_fromView(sender.draggingLocation(), None);
    let (x, y) = (point.x as f32, point.y as f32);
    let uris = read_uris(sender);
    if uris.is_empty() {
        return drop_promises(surface, x, y, promises(sender));
    }
    drop_uris(surface, x, y, uris)
}

/// Drops the files `receivers` promise at `x`, `y` on the view there that
/// listens: whether one took them. The files are written to a folder of
/// their own, then read on AppKit's queue, and `onFileDrop` gets their
/// contents (`files`), in the drag's order, once all are written; the
/// folder is removed after.
fn drop_promises(
    surface: &Surface,
    x: f32,
    y: f32,
    receivers: Vec<Retained<NSFilePromiseReceiver>>,
) -> bool {
    let destination = input::file_drop_target(surface, x, y);
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    clear(surface);
    let (Some(destination), Some(control)) = (destination, control) else {
        return false;
    };
    let count = receivers
        .iter()
        .map(|r| r.fileTypes().count())
        .sum::<usize>();
    if count == 0 {
        return false;
    }
    let Some(folder) = promise_folder() else {
        return false;
    };
    let Some(folder_url) = folder
        .to_str()
        .map(|path| NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), true))
    else {
        return false;
    };
    let id = destination.id();
    let delivery = Arc::new(PromisedDrop {
        at: point(Points(x), Points(y)),
        folder,
        count,
        written: Mutex::new(Vec::new()),
        deliver: Box::new(move |contents| {
            control.dispatch_event(
                id,
                EventKind::FileDrop,
                EventPayload::FileContents(contents),
            );
        }),
    });
    let queue = surface
        .file_drop
        .promise_queue
        .get_or_init(NSOperationQueue::new);
    for (order, receiver) in receivers.iter().enumerate() {
        let delivery = delivery.clone();
        let reader = RcBlock::new(move |url: NonNull<NSURL>, error: *mut NSError| {
            // SAFETY: AppKit hands the reader a valid URL.
            let url = unsafe { url.as_ref() };
            let path = if error.is_null() {
                url.path().map(|path| PathBuf::from(path.to_string()))
            } else {
                // SAFETY: a non-null error is a valid `NSError`.
                let error = unsafe { &*error };
                log::warn!(
                    "a dropped file was not written: {}",
                    error.localizedDescription()
                );
                None
            };
            delivery.written(order, path);
        });
        // SAFETY: an empty options dictionary; the reader only moves
        // `Send` data between AppKit's queue and the engine.
        unsafe {
            receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(
                &folder_url,
                &NSDictionary::new(),
                queue,
                &reader,
            );
        }
    }
    true
}

/// Files promised by a drop, gathered as AppKit writes them.
struct PromisedDrop {
    /// Where they were let go, in the event root's coordinates.
    at: Point<Points>,
    /// The folder they are written to.
    folder: PathBuf,
    /// How many are promised.
    count: usize,
    /// Those written so far (`None`: failed), with their promise's order.
    written: Mutex<Vec<(usize, Option<PathBuf>)>>,
    /// Hands the files read to the view they were dropped on.
    deliver: Box<dyn Fn(Box<FileContents>) + Send + Sync>,
}

impl PromisedDrop {
    /// One promised file was written (`Some`) or failed (`None`): when it
    /// is the last, the files are read and dropped, and their folder
    /// removed.
    fn written(&self, order: usize, path: Option<PathBuf>) {
        let mut written = self.written.lock().unwrap_or_else(|e| e.into_inner());
        written.push((order, path));
        if written.len() != self.count {
            return;
        }
        written.sort_by_key(|(order, _)| *order);
        let paths = written
            .drain(..)
            .filter_map(|(_, path)| path)
            .collect::<Vec<_>>();
        drop(written);
        let files = read_promised(&paths);
        if let Err(e) = std::fs::remove_dir_all(&self.folder) {
            log::warn!("cannot remove {}: {e}", self.folder.display());
        }
        if files.is_empty() {
            return;
        }
        let mime_types = files.iter().map(|file| file.mime.clone()).collect();
        let contents = FileContents::new(files, mime_types, Some(self.at));
        (self.deliver)(Box::new(contents));
    }
}

/// The files at `paths`, as a pick of up to as many files as one takes
/// reads them (too large ones keep only their names and sizes).
fn read_promised(paths: &[PathBuf]) -> Vec<PickedFile> {
    let request = FilePickRequest::new(true, 0);
    finish_files(&request, read_picked_files(paths, &request))
}

/// A new folder for the files of one drop.
fn promise_folder() -> Option<PathBuf> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let folder = std::env::temp_dir().join(format!(
        "nsh-drop-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&folder)
        .inspect_err(|e| log::warn!("cannot make {}: {e}", folder.display()))
        .ok()?;
    Some(folder)
}

/// The file promises on the drag's pasteboard.
fn promises(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<Retained<NSFilePromiseReceiver>> {
    let board = sender.draggingPasteboard();
    let classes = NSArray::from_slice(&[NSFilePromiseReceiver::class()]);
    // SAFETY: an array of a class that reads from pasteboards, no options.
    let Some(objects) = (unsafe { board.readObjectsForClasses_options(&classes, None) }) else {
        return Vec::new();
    };
    objects
        .iter()
        .filter_map(|object| object.downcast::<NSFilePromiseReceiver>().ok())
        .collect()
}

/// The MIME types of the files `receivers` promise, in order (`""` for a
/// type without one).
fn promised_types(receivers: &[Retained<NSFilePromiseReceiver>]) -> Vec<String> {
    receivers
        .iter()
        .flat_map(|receiver| receiver.fileTypes().to_vec())
        .map(|kind| mime_type(&kind.to_string()))
        .collect()
}

/// The MIME type of uniform type `identifier` (`public.png`:
/// `image/png`), `""` when it has none.
fn mime_type(identifier: &str) -> String {
    let Some(class) = AnyClass::get(c"UTType") else {
        return String::new();
    };
    let identifier = NSString::from_str(identifier);
    // SAFETY: `+[UTType typeWithIdentifier:]` takes a string and returns
    // a type or nil; `preferredMIMEType` a string or nil.
    let kind: Option<Retained<AnyObject>> =
        unsafe { msg_send![class, typeWithIdentifier: &*identifier] };
    kind.and_then(|kind| {
        let mime: Option<Retained<NSString>> = unsafe { msg_send![&*kind, preferredMIMEType] };
        mime
    })
    .map(|mime| mime.to_string())
    .unwrap_or_default()
}

/// Drops `uris` at `x`, `y` (the event root's coordinates) on the view
/// there that listens: whether one took them. The test agent's `dropFiles`
/// comes here too.
pub(crate) fn drop_uris(surface: &Surface, x: f32, y: f32, uris: Vec<String>) -> bool {
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
    if !offered(surface) {
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
    (offered(surface) && target(surface, sender).is_some()).then(|| perform(surface, sender))
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

/// The local filesystem path and `file:` URL of the file or directory `uri`
/// names, if it names one. Finder puts file reference URLs
/// (`file:///.file/id=…`) on drag and copy pasteboards: they become the
/// path's URL, which apps can turn into a path.
pub(crate) fn local_file_path_and_uri(uri: &NSString) -> Option<(std::path::PathBuf, String)> {
    let url = NSURL::URLWithString(uri)?.filePathURL()?;
    if !url.isFileURL() {
        return None;
    }
    let path = url.path()?.to_string();
    if !path.starts_with('/') {
        return None;
    }
    let local_host = url.host().is_none_or(|host| {
        let host = host.to_string();
        host.is_empty() || host.eq_ignore_ascii_case("localhost")
    });
    if !local_host {
        return None;
    }
    let resolved = url.absoluteString()?.to_string();
    Some((std::path::PathBuf::from(path), resolved))
}

pub(crate) fn local_file_uri(uri: &NSString) -> Option<String> {
    local_file_path_and_uri(uri).map(|(_, uri)| uri)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promised_files_drop_in_order_once_all_are_written() {
        let folder = promise_folder().unwrap();
        std::fs::write(folder.join("a.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(folder.join("b.txt"), b"hello").unwrap();
        let dropped = Arc::new(Mutex::new(Vec::new()));
        let seen = dropped.clone();
        let drop = PromisedDrop {
            at: point(Points(40.), Points(50.)),
            folder: folder.clone(),
            count: 3,
            written: Mutex::new(Vec::new()),
            deliver: Box::new(move |contents| seen.lock().unwrap().push(contents)),
        };
        // AppKit may finish the promises in any order; one failed.
        drop.written(2, Some(folder.join("b.txt")));
        drop.written(1, None);
        assert!(
            dropped.lock().unwrap().is_empty(),
            "nothing before the last file"
        );
        drop.written(0, Some(folder.join("a.png")));
        let dropped = dropped.lock().unwrap();
        assert_eq!(dropped.len(), 1);
        let contents = &dropped[0];
        let names = contents
            .files
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["a.png", "b.txt"]);
        assert_eq!(contents.mime_types, ["image/png", "text/plain"]);
        assert_eq!(&*contents.files[1].data, b"hello");
        assert_eq!(
            contents.page_position,
            Some(point(Points(40.), Points(50.)))
        );
        assert!(!folder.exists(), "the drop's folder is removed");
    }

    #[test]
    fn promised_types_are_mime_types() {
        assert_eq!(mime_type("public.png"), "image/png");
        assert_eq!(mime_type("public.tiff"), "image/tiff");
        assert_eq!(mime_type("com.example.nothing"), "");
    }

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
