//! AppKit file-list drops, routed by the same hit testing as pointer input.
//!
//! A drag offers local files (`public.file-url`: Finder, a screenshot's
//! thumbnail), which drop as their URLs, or only promises files
//! (`NSFilePromiseReceiver`: an image dragged out of a page in Safari or
//! Chrome, Mail's attachments), which are written to a folder of their
//! own once dropped and handed over as their contents (`files`), as on the
//! Web. Other sources, chat apps among them, offer a picture as its data
//! alone, or beside the URL of a file this app cannot read (one in the
//! source's own container): the picture drops as its contents (`files`)
//! too, as a paste takes it ([`crate::system::pasted`]). Such sources may
//! offer only the generic operation, not a copy, and a drop takes either.
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::{Arc, Mutex},
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchQueueGlobalPriority, GlobalQueueIdentifier};
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
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSFilePromiseReceiver, NSPasteboard, NSView};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSOperationQueue, NSString, NSURL};

use crate::{
    input,
    surface::Surface,
    system::{IMAGE_TYPES, prefer_file_url, to_png},
    view::NshView,
};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    uris: RefCell<Vec<String>>,
    /// The MIME types of the files a drag without file URLs promises, or
    /// of what it drops as contents ([`offered_types`]; `""` for a type
    /// with none).
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
    kinds.extend(IMAGE_TYPES.iter().map(|(_, kind)| NSString::from_str(kind)));
    kinds.extend(NSFilePromiseReceiver::readableDraggedTypes().to_vec());
    let kinds = kinds.iter().map(|k| &**k).collect::<Vec<_>>();
    view.registerForDraggedTypes(&NSArray::from_slice(&kinds));
}

/// Whether the drag being tracked offers files: local ones, promised ones
/// or pictures.
fn offered(surface: &Surface) -> bool {
    !surface.file_drop.uris.borrow().is_empty() || !surface.file_drop.promised.borrow().is_empty()
}

/// What `onFileDragEnter` gets: the files' URLs, or for promised files and
/// pictures, their types (none are written or read before the drop).
fn entered_payload(surface: &Surface) -> EventPayload {
    let uris = surface.file_drop.uris.borrow();
    if uris.is_empty() {
        let promised = surface.file_drop.promised.borrow().clone();
        EventPayload::FileContents(Box::new(FileContents::new(Vec::new(), promised, None)))
    } else {
        EventPayload::FileDrop(uris.clone())
    }
}

/// The operation a drop of files makes when the drag's source allows
/// `mask`: a copy, else the generic operation, all some sources offer;
/// never a move, which has the source remove what it dragged, or a link.
fn drop_operation(mask: NSDragOperation) -> NSDragOperation {
    if mask.contains(NSDragOperation::Copy) {
        NSDragOperation::Copy
    } else if mask.contains(NSDragOperation::Generic) {
        NSDragOperation::Generic
    } else {
        NSDragOperation::None
    }
}

/// [`drop_operation`] for `sender`'s drag.
fn operation(sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
    drop_operation(sender.draggingSourceOperationMask())
}

fn target(surface: &Surface, sender: &ProtocolObject<dyn NSDraggingInfo>) -> Option<NshView> {
    if operation(sender).is_empty() {
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
    let offers = offers_on(&sender.draggingPasteboard());
    // Local files win: a screenshot's thumbnail offers both. Promised
    // files come next: an image dragged out of a page carries its picture
    // too, but the promised file keeps its name and format.
    let (uris, promised) = match uris_of(&offers) {
        Some(uris) => (uris, Vec::new()),
        None => match promised_types(&promises(sender)) {
            promised if promised.is_empty() && has_pictures(&offers) => {
                (Vec::new(), offered_types(&offers))
            }
            promised => (Vec::new(), promised),
        },
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
        operation(sender)
    } else {
        NSDragOperation::None
    };
    set_target(surface, next);
    operation
}

pub(crate) fn perform(surface: &Surface, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
    if operation(sender).is_empty() {
        clear(surface);
        return false;
    }
    let point = input::event_root(surface)
        .ns()
        .convertPoint_fromView(sender.draggingLocation(), None);
    let (x, y) = (point.x as f32, point.y as f32);
    let board = sender.draggingPasteboard();
    let offers = offers_on(&board);
    if let Some(uris) = uris_of(&offers) {
        return drop_uris(surface, x, y, uris);
    }
    let receivers = promises(sender);
    if promised_types(&receivers).is_empty() && has_pictures(&offers) {
        return drop_contents(surface, x, y, &board, &offers);
    }
    drop_promises(surface, x, y, receivers)
}

/// What one item of a drag drops as.
#[derive(Debug, PartialEq)]
enum Offer {
    /// A local file or directory, by its URL.
    Uri(String),
    /// A picture as its data: that of pasteboard item `item`, of the first
    /// of `kinds` (those of [`IMAGE_TYPES`] it offers, in that order) that
    /// has data, named after the item's file if it names one.
    Picture {
        item: usize,
        kinds: Vec<&'static str>,
        name: Option<String>,
    },
}

/// What the pasteboard item at `item` drops as, from the local file it
/// names (`uri`) and the types it offers (`types`), as a paste takes an
/// item ([`crate::system::pasted`]): its file when `readable` says this app
/// can read it where it is (a directory counts), when the item offers no
/// picture, or when Finder put it there (with the file's icon, no picture
/// of it); else its pictures of [`IMAGE_TYPES`]. `readable` is only
/// asked when the item also offers a picture, which spares probing each
/// file of a Finder drag. An item with neither is left out.
fn offer(
    item: usize,
    uri: Option<String>,
    types: &[String],
    readable: impl FnOnce(&Path) -> bool,
) -> Option<Offer> {
    let offers = |kind: &str| types.iter().any(|offered| offered == kind);
    let kinds = IMAGE_TYPES
        .iter()
        .map(|(_, kind)| *kind)
        .filter(|kind| offers(kind))
        .collect::<Vec<_>>();
    if kinds.is_empty() {
        return uri.map(Offer::Uri);
    }
    let path = uri.as_deref().and_then(nsh_core::access::file_url_path);
    if let Some(uri) = uri
        && (offers("com.apple.finder.node")
            || offers("com.apple.finder.noderef")
            || path.as_deref().is_none_or(readable))
    {
        return Some(Offer::Uri(uri));
    }
    let name = path.and_then(|path| {
        path.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
    });
    Some(Offer::Picture { item, kinds, name })
}

/// What each item on `board` drops as ([`offer`]).
fn offers_on(board: &NSPasteboard) -> Vec<Offer> {
    let file = NSString::from_str("public.file-url");
    let Some(items) = board.pasteboardItems() else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let uri = item
                .stringForType(&file)
                .and_then(|uri| local_file_uri(&uri));
            let types = item
                .types()
                .iter()
                .map(|kind| kind.to_string())
                .collect::<Vec<_>>();
            offer(index, uri, &types, prefer_file_url)
        })
        .collect()
}

/// The URLs of `offers`, when all are files.
fn uris_of(offers: &[Offer]) -> Option<Vec<String>> {
    let uris = offers
        .iter()
        .map(|offer| match offer {
            Offer::Uri(uri) => Some(uri.clone()),
            Offer::Picture { .. } => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!uris.is_empty()).then_some(uris)
}

/// Whether some of `offers` drop as pictures: then all drop as their
/// contents ([`drop_contents`]).
fn has_pictures(offers: &[Offer]) -> bool {
    offers
        .iter()
        .any(|offer| matches!(offer, Offer::Picture { .. }))
}

/// The MIME types of `offers` before the drop, for `onFileDragEnter`: a
/// file's by its name ([`nsh_core::platform::file_mime_type`], as for
/// `uris`), a picture's as it drops ([`picture_type`]).
fn offered_types(offers: &[Offer]) -> Vec<String> {
    offers
        .iter()
        .map(|offer| match offer {
            Offer::Uri(uri) => nsh_core::platform::file_mime_type(uri).to_owned(),
            Offer::Picture { kinds, .. } => picture_type(kinds[0]).0.to_owned(),
        })
        .collect()
}

/// The MIME type and file extension a picture of pasteboard type `kind`
/// drops as: TIFF (AppKit's own) and BMP as PNG, as a paste takes them.
fn picture_type(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "public.jpeg" => ("image/jpeg", "jpg"),
        "com.compuserve.gif" => ("image/gif", "gif"),
        "org.webmproject.webp" => ("image/webp", "webp"),
        _ => ("image/png", "png"),
    }
}

/// A picture's `bytes`, of pasteboard type `kind`, as [`picture_type`]
/// says it drops: `None` when they are empty or cannot be converted.
fn picture_data(kind: &str, bytes: Vec<u8>) -> Option<Vec<u8>> {
    if bytes.is_empty() {
        return None;
    }
    match kind {
        "public.tiff" | "com.microsoft.bmp" => to_png(&bytes),
        _ => Some(bytes),
    }
}

/// What a drop of contents takes from the drag's pasteboard, on the main
/// thread ([`take`]), to be read and converted off it ([`contents_of`]).
#[derive(Debug, PartialEq)]
enum Taken {
    /// A file, by where it is.
    File(PathBuf),
    /// A picture's `bytes`, of pasteboard type `kind`, and the name it drops
    /// under, without its extension.
    Picture {
        kind: &'static str,
        stem: String,
        bytes: Vec<u8>,
    },
}

/// What `offers` drop from `board`, in their order: each file's path, and
/// each picture's data of the first of its types that has some (copied
/// here: a pasteboard is read on the main thread). Only the first `limit`
/// pictures are copied: no more than `limit` files drop. A picture with no
/// data is left out.
fn take(board: &NSPasteboard, offers: &[Offer], limit: usize) -> Vec<Taken> {
    let items = board.pasteboardItems();
    let mut taken = Vec::new();
    let mut pictures = 0;
    for (n, offer) in offers.iter().enumerate() {
        match offer {
            Offer::Uri(uri) => taken.extend(nsh_core::access::file_url_path(uri).map(Taken::File)),
            Offer::Picture { .. } if pictures == limit => {}
            Offer::Picture { item, kinds, name } => {
                let item = items.as_ref().and_then(|items| items.iter().nth(*item));
                let data = kinds.iter().find_map(|kind| {
                    let data = item.as_ref()?.dataForType(&NSString::from_str(kind))?;
                    (data.length() > 0).then(|| (*kind, data.to_vec()))
                });
                let Some((kind, bytes)) = data else {
                    log::warn!("a dropped picture ({kinds:?}) has no data to read");
                    continue;
                };
                pictures += 1;
                taken.push(Taken::Picture {
                    kind,
                    stem: name.clone().unwrap_or_else(|| format!("image-{}", n + 1)),
                    bytes,
                });
            }
        }
    }
    taken
}

/// The contents of what a drop took ([`take`]), in its order, until
/// `request`'s limit is reached: each file read where it is, each picture
/// as [`picture_type`] says it drops. What is not a regular file
/// (a directory, a pipe, a device, whose reading may never end) and what
/// cannot be read or converted are left out. Off the main thread: it reads
/// files and converts pictures.
fn contents_of(taken: Vec<Taken>, request: &FilePickRequest) -> Vec<PickedFile> {
    let limit = request.limit.max(1) as usize;
    let mut files = Vec::new();
    for taken in taken {
        if files.len() == limit {
            break;
        }
        match taken {
            Taken::File(path) => {
                if path.metadata().is_ok_and(|meta| meta.is_file()) {
                    files.extend(read_picked_files(&[path], request));
                }
            }
            Taken::Picture { kind, stem, bytes } => {
                let Some(data) = picture_data(kind, bytes) else {
                    log::warn!("a dropped picture ({kind}) cannot be read");
                    continue;
                };
                let (mime, ext) = picture_type(kind);
                files.push(PickedFile::new(
                    format!("{stem}.{ext}"),
                    mime,
                    nsh_core::image::ImageData::from(data),
                ));
            }
        }
    }
    finish_files(request, files)
}

/// Drops `offers` at `x`, `y` on the view there that listens, as their
/// contents (`files`): whether one takes them. What they drop is taken from
/// `board` here ([`take`]), then read and converted on a global queue
/// ([`contents_of`]), and `onFileDrop` gets it on the main thread, unless
/// none of it could be read.
fn drop_contents(
    surface: &Surface,
    x: f32,
    y: f32,
    board: &NSPasteboard,
    offers: &[Offer],
) -> bool {
    let destination = input::file_drop_target(surface, x, y);
    clear(surface);
    let Some(destination) = destination else {
        return false;
    };
    let request = FilePickRequest::new(true, 0);
    let taken = take(board, offers, request.limit as usize);
    if taken.is_empty() {
        return false;
    }
    let (id, key, at) = (destination.id(), surface.key(), point(Points(x), Points(y)));
    DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
        DispatchQueueGlobalPriority::Default,
    ))
    .exec_async(move || {
        let files = contents_of(taken, &request);
        if files.is_empty() {
            return;
        }
        let mime_types = files.iter().map(|file| file.mime.clone()).collect();
        let contents = FileContents::new(files, mime_types, Some(at));
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = Surface::with_key(key) {
                surface.event(
                    id,
                    EventKind::FileDrop,
                    EventPayload::FileContents(Box::new(contents)),
                );
            }
        });
    });
    true
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
        EventPayload::FileDropAt {
            uris,
            page_position: point(Points(x), Points(y)),
        },
    );
    clear(surface);
    true
}

/// A drag entering an input's text view (a text area, a field's editor).
/// AppKit offers a drag to the deepest view registered for one of its
/// types, and a text view registers for files to insert their paths: files
/// (local, promised or pictures) over an input inside a file drop target go
/// to that target, as anywhere else in it (`Some`, with the operation a drop
/// makes, a copy or the generic one); any other drag stays the text view's
/// (`None`), text drags included.
pub(crate) fn text_entered(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<NSDragOperation> {
    Some(begin(surface, sender)).filter(|operation| !operation.is_empty())
}

/// A drag moving over an input's text view: [`text_entered`].
pub(crate) fn text_updated(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<NSDragOperation> {
    if !offered(surface) {
        return None;
    }
    Some(update(surface, sender)).filter(|operation| !operation.is_empty())
}

/// A drop on an input's text view: whether the target around it took the
/// files (`Some`), or `None` for the text view to handle ([`text_entered`]).
pub(crate) fn text_performed(
    surface: &Surface,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<bool> {
    (offered(surface) && target(surface, sender).is_some()).then(|| perform(surface, sender))
}

/// The `file:` URL with the path of the local file or directory `uri`
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
    use nsh_core::picker::PickedStatus;

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
    fn a_drop_copies_else_makes_the_generic_operation() {
        use NSDragOperation as Op;
        for (mask, expected) in [
            (Op::Copy | Op::Generic | Op::Move, Op::Copy),
            (Op::Copy, Op::Copy),
            (Op::Every, Op::Copy),
            // Sources that offer nothing else, chat apps among them.
            (Op::Generic, Op::Generic),
            (Op::Generic | Op::Move, Op::Generic),
            (Op::Move, Op::None),
            (Op::Link, Op::None),
            (Op::Move | Op::Link | Op::Delete, Op::None),
            (Op::None, Op::None),
        ] {
            assert_eq!(drop_operation(mask), expected, "{mask:?}");
        }
    }

    fn types(kinds: &[&str]) -> Vec<String> {
        kinds.iter().map(|kind| (*kind).to_owned()).collect()
    }

    /// A `readable` for [`offer`] that must not be asked.
    fn unasked(path: &Path) -> bool {
        panic!("{} was probed", path.display())
    }

    #[test]
    fn an_item_drops_its_readable_file_else_its_picture() {
        let uri = || Some("file:///tmp/chat%20app/a%20b.png".to_owned());
        let file = || Some(Offer::Uri(uri().unwrap()));
        let picture = |kinds: &[&'static str], name: Option<&str>| {
            Some(Offer::Picture {
                item: 3,
                kinds: kinds.to_vec(),
                name: name.map(str::to_owned),
            })
        };
        // A file this app can read drops as its URL, picture or not.
        let readable = |path: &Path| {
            assert_eq!(path, Path::new("/tmp/chat app/a b.png"));
            true
        };
        assert_eq!(offer(3, uri(), &types(&["public.png"]), readable), file());
        // One it cannot read drops the picture beside it, named after it,
        // of the types of `IMAGE_TYPES` the item offers, in that order.
        let unreadable = |_: &Path| false;
        let offered = types(&["public.file-url", "public.tiff", "public.png"]);
        assert_eq!(
            offer(3, uri(), &offered, unreadable),
            picture(&["public.png", "public.tiff"], Some("a b"))
        );
        let offered = types(&["public.tiff", "public.jpeg"]);
        assert_eq!(
            offer(3, uri(), &offered, unreadable),
            picture(&["public.jpeg", "public.tiff"], Some("a b"))
        );
        // Finder's icon of a file is no picture of it.
        let offered = types(&["com.apple.finder.node", "public.tiff"]);
        assert_eq!(offer(3, uri(), &offered, unreadable), file());
        // Without a picture the file is kept, and not probed.
        assert_eq!(
            offer(3, uri(), &types(&["public.file-url"]), unasked),
            file()
        );
        // A picture with no file, under no name.
        let offered = types(&["com.compuserve.gif", "public.utf8-plain-text"]);
        assert_eq!(
            offer(3, None, &offered, unasked),
            picture(&["com.compuserve.gif"], None)
        );
        // Neither: left out.
        let offered = types(&["public.utf8-plain-text", "public.url"]);
        assert_eq!(offer(3, None, &offered, unasked), None);
        // A directory drops as its URL even beside a picture.
        let dir = std::env::temp_dir();
        let dir_uri = NSURL::fileURLWithPath(&NSString::from_str(dir.to_str().unwrap()))
            .absoluteString()
            .unwrap()
            .to_string();
        assert_eq!(
            offer(
                0,
                Some(dir_uri.clone()),
                &types(&["public.tiff"]),
                prefer_file_url
            ),
            Some(Offer::Uri(dir_uri))
        );
    }

    #[test]
    fn offers_drop_as_urls_only_when_all_are_files() {
        let file = |name: &str| Offer::Uri(format!("file:///tmp/{name}"));
        let picture = |kind| Offer::Picture {
            item: 1,
            kinds: vec![kind],
            name: None,
        };
        let files = [file("a.txt"), file("dir/")];
        assert_eq!(
            uris_of(&files),
            Some(vec![
                "file:///tmp/a.txt".to_owned(),
                "file:///tmp/dir/".to_owned()
            ])
        );
        assert!(!has_pictures(&files));
        assert_eq!(uris_of(&[]), None);
        let mixed = [
            file("a.txt"),
            picture("public.tiff"),
            picture("public.jpeg"),
            picture("com.compuserve.gif"),
            picture("org.webmproject.webp"),
            picture("com.microsoft.bmp"),
            file("dir/"),
        ];
        assert_eq!(uris_of(&mixed), None);
        assert!(has_pictures(&mixed));
        // Before the drop: files by their names, pictures as they drop.
        assert_eq!(
            offered_types(&mixed),
            [
                "text/plain",
                "image/png",
                "image/jpeg",
                "image/gif",
                "image/webp",
                "image/png",
                ""
            ]
        );
    }

    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

    /// A 1×1 picture as AppKit puts pictures on pasteboards: TIFF.
    fn tiff() -> Vec<u8> {
        use objc2_app_kit::{NSBitmapImageRep, NSDeviceRGBColorSpace};
        // SAFETY: null planes have the image representation allocate its
        // own; an immutable AppKit constant.
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                <NSBitmapImageRep as objc2::AnyThread>::alloc(),
                std::ptr::null_mut(),
                1,
                1,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }
        .unwrap();
        let tiff = rep.TIFFRepresentation().unwrap().to_vec();
        assert!(tiff.starts_with(b"II*\0") || tiff.starts_with(b"MM\0*"));
        tiff
    }

    #[test]
    fn a_tiff_picture_drops_as_png() {
        let png = picture_data("public.tiff", tiff()).unwrap();
        assert!(png.starts_with(PNG_SIGNATURE));
        assert_eq!(picture_type("public.tiff"), ("image/png", "png"));
        // Other types drop as they are.
        assert_eq!(picture_data("public.png", png.clone()), Some(png));
        assert_eq!(
            picture_data("public.jpeg", vec![0xff, 0xd8]),
            Some(vec![0xff, 0xd8])
        );
        assert_eq!(picture_data("public.tiff", b"no picture".to_vec()), None);
        assert_eq!(picture_data("public.png", Vec::new()), None);
    }

    /// A pasteboard of its own, released when dropped.
    struct Board(Retained<NSPasteboard>);

    impl Drop for Board {
        fn drop(&mut self) {
            // SAFETY: NSPasteboard's method; the pasteboard is not used again.
            let _: () = unsafe { msg_send![&*self.0, releaseGlobally] };
        }
    }

    #[test]
    fn a_drag_pasteboard_drops_files_and_pictures_in_order() {
        use std::os::unix::fs::OpenOptionsExt;

        use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
        use objc2_foundation::NSData;

        let folder = std::env::temp_dir().join(format!("nsh-drop-data-{}", std::process::id()));
        std::fs::create_dir_all(folder.join("dir")).unwrap();
        std::fs::write(folder.join("a.txt"), b"hello").unwrap();
        let denied = folder.join("denied.png");
        std::fs::File::options()
            .write(true)
            .create_new(true)
            .mode(0o000)
            .open(&denied)
            .unwrap();
        let can_read_denied = std::fs::File::open(&denied).is_ok();
        let url = |path: &Path| {
            NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()))
                .absoluteString()
                .unwrap()
        };
        let png = picture_data("public.tiff", tiff()).unwrap();
        let jpeg = [0xff, 0xd8, 0xff, 0xe0];
        let file_url = NSString::from_str("public.file-url");

        let board = Board(NSPasteboard::pasteboardWithUniqueName());
        board.0.clearContents();
        let item = |uri: Option<&Path>, data: &[(&str, &[u8])]| {
            let item = NSPasteboardItem::new();
            if let Some(path) = uri {
                item.setString_forType(&url(path), &file_url);
            }
            for (kind, bytes) in data {
                item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind));
            }
            ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item)
        };
        let tiff = tiff();
        let items = [
            // 0: a file this app reads.
            item(Some(&folder.join("a.txt")), &[]),
            // 1: a picture alone.
            item(None, &[("public.png", &png)]),
            // 2: a file in another app's container, beside its picture.
            item(
                Some(&folder.join("gone/chat photo.jpg")),
                &[("public.tiff", &tiff), ("public.jpeg", &jpeg)],
            ),
            // 3: AppKit's own picture.
            item(None, &[("public.tiff", &tiff)]),
            // 4: a directory, beside a picture.
            item(Some(&folder.join("dir")), &[("public.tiff", &tiff)]),
            // 5: text, no file.
            item(None, &[("public.utf8-plain-text", b"text")]),
            // 6: a file this app may not read, beside its picture.
            item(Some(&denied), &[("public.png", &png)]),
        ];
        assert!(board.0.writeObjects(&NSArray::from_retained_slice(&items)));

        let local = |path: &Path| local_file_uri(&url(path)).unwrap();
        let mut expected = vec![
            Offer::Uri(local(&folder.join("a.txt"))),
            Offer::Picture {
                item: 1,
                kinds: vec!["public.png"],
                name: None,
            },
            Offer::Picture {
                item: 2,
                kinds: vec!["public.jpeg", "public.tiff"],
                name: Some("chat photo".to_owned()),
            },
            Offer::Picture {
                item: 3,
                kinds: vec!["public.tiff"],
                name: None,
            },
            Offer::Uri(local(&folder.join("dir"))),
        ];
        expected.push(if can_read_denied {
            Offer::Uri(local(&denied))
        } else {
            Offer::Picture {
                item: 6,
                kinds: vec!["public.png"],
                name: Some("denied".to_owned()),
            }
        });
        let offers = offers_on(&board.0);
        assert_eq!(offers, expected);
        assert_eq!(uris_of(&offers), None);
        assert_eq!(
            offered_types(&offers),
            [
                "text/plain",
                "image/png",
                "image/jpeg",
                "image/png",
                "",
                "image/png"
            ]
        );

        let request = FilePickRequest::new(true, 0);
        let files = contents_of(take(&board.0, &offers, 100), &request);
        let named = files
            .iter()
            .map(|file| (file.name.as_str(), file.mime.as_str()))
            .collect::<Vec<_>>();
        let mut expected = vec![
            ("a.txt", "text/plain"),
            ("image-2.png", "image/png"),
            ("chat photo.jpg", "image/jpeg"),
            ("image-4.png", "image/png"),
        ];
        if !can_read_denied {
            expected.push(("denied.png", "image/png"));
        }
        assert_eq!(named, expected, "the directory is left out");
        assert_eq!(&*files[0].data, b"hello");
        assert_eq!(&*files[1].data, &*png);
        assert_eq!(&*files[2].data, &jpeg);
        assert!(
            files[3].data.starts_with(PNG_SIGNATURE),
            "TIFF drops as PNG"
        );
        assert!(files.iter().all(|file| file.status == PickedStatus::Read));

        drop(board);
        std::fs::remove_dir_all(&folder).unwrap();
    }

    /// A pasteboard of `items`, each its types and data.
    fn board_of(items: &[&[(&str, &[u8])]]) -> Board {
        use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
        use objc2_foundation::NSData;

        let board = Board(NSPasteboard::pasteboardWithUniqueName());
        board.0.clearContents();
        let items = items
            .iter()
            .map(|data| {
                let item = NSPasteboardItem::new();
                for (kind, bytes) in *data {
                    item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind));
                }
                ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item)
            })
            .collect::<Vec<_>>();
        assert!(board.0.writeObjects(&NSArray::from_retained_slice(&items)));
        board
    }

    #[test]
    fn a_picture_with_no_data_of_its_first_type_drops_its_next() {
        let tiff = tiff();
        let board = board_of(&[
            &[("public.png", b""), ("public.tiff", &tiff)],
            &[("public.png", b"")],
        ]);
        let offers = offers_on(&board.0);
        assert_eq!(
            offers[0],
            Offer::Picture {
                item: 0,
                kinds: vec!["public.png", "public.tiff"],
                name: None,
            }
        );
        // The second has no data at all: left out.
        assert_eq!(
            take(&board.0, &offers, 100),
            [Taken::Picture {
                kind: "public.tiff",
                stem: "image-1".to_owned(),
                bytes: tiff,
            }]
        );
    }

    #[test]
    fn no_more_pictures_than_drop_are_copied() {
        let png: &[u8] = b"\x89PNG";
        let picture: &[(&str, &[u8])] = &[("public.png", png)];
        let board = board_of(&[picture; 3]);
        let offers = offers_on(&board.0);
        let mut offers_and_file = offers;
        offers_and_file.push(Offer::Uri("file:///tmp/a.txt".to_owned()));
        let taken = take(&board.0, &offers_and_file, 2);
        assert_eq!(
            taken
                .iter()
                .map(|taken| match taken {
                    Taken::File(path) => path.display().to_string(),
                    Taken::Picture { stem, .. } => stem.clone(),
                })
                .collect::<Vec<_>>(),
            ["image-1", "image-2", "/tmp/a.txt"]
        );
    }

    #[test]
    fn only_regular_files_are_read_and_no_more_than_drop() {
        let folder = std::env::temp_dir().join(format!("nsh-drop-regular-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(folder.join("dir")).unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(folder.join(name), name).unwrap();
        }
        // A pipe with no writer: reading it would never end.
        let fifo = folder.join("pipe");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let taken = |names: &[&str]| {
            names
                .iter()
                .map(|name| Taken::File(folder.join(name)))
                .collect::<Vec<_>>()
        };
        let read = |taken: Vec<Taken>, limit| {
            let (send, receive) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let files = contents_of(taken, &FilePickRequest::new(true, limit));
                let _ = send.send(files.into_iter().map(|file| file.name).collect::<Vec<_>>());
            });
            receive
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("a drop read a file that never ends")
        };
        assert_eq!(read(taken(&["pipe", "dir", "a.txt"]), 0), ["a.txt"]);
        assert_eq!(
            read(taken(&["a.txt", "b.txt", "c.txt"]), 2),
            ["a.txt", "b.txt"]
        );
        std::fs::remove_dir_all(&folder).unwrap();
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
