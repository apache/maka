//! File drops (`onFileDragEnter`, `onFileDragLeave`, `onFileDrop`) and text
//! drops ([`nsh_core::EventKind::TextDrop`], a Rust component's such as
//! `RichEditor`'s) on iOS: a `UIDropInteraction` on each view that listens
//! to either, whose delegate is the surface's
//! [`crate::target::EventTarget`].
//!
//! UIKit routes a drag to the deepest view under it with a drop interaction
//! that can handle the session, so the closest listener takes the files, as
//! the desktop backends' hit testing gives them. A text input keeps the text
//! drags that come to it; a drag of files is no text, and goes to the
//! listener around the input.
//!
//! A drag of another app's items carries no file URLs: an item offers its
//! data in types (a photo as `public.jpeg`, a document as `com.adobe.pdf`),
//! read only when it is dropped. So `onFileDragEnter` reports no URLs here,
//! and the drop copies each item's file into the app's temporary directory
//! (the provider deletes its own copy when the read returns), then reports
//! those copies' `file:` URLs, in the drag's order. An item that offers only
//! text or a link is no file: it is not offered to the listener.

use std::{
    ffi::CStr,
    sync::{Arc, Mutex},
};

use block2::RcBlock;
use objc2::{
    msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::{NSArray, NSData, NSError, NSString, NSURL};

/// `UIDropOperationCopy`.
const COPY: isize = 2;
/// `UIDropOperationForbidden`.
const FORBIDDEN: isize = 1;

fn class(name: &CStr) -> Option<&'static AnyClass> {
    AnyClass::get(name)
}

/// A drop interaction whose delegate is `delegate` (the surface's event
/// target), for a view that listens to `onFileDrop`.
pub(crate) fn interaction(delegate: &AnyObject) -> Option<Retained<AnyObject>> {
    let class = class(c"UIDropInteraction")?;
    // SAFETY: UIDropInteraction's documented initializer (iOS 11); it holds
    // its delegate weakly, and the event target outlives the surface's views.
    unsafe {
        let alloc: Allocated<AnyObject> = msg_send![class, alloc];
        msg_send![alloc, initWithDelegate: delegate]
    }
}

/// The type identifier of the file `provider` offers: its first registered
/// type that is data, but not text or a link (those are a text drag's).
fn file_type(provider: &AnyObject) -> Option<Retained<NSString>> {
    // SAFETY: NSItemProvider's documented API (iOS 11).
    let types: Retained<NSArray<NSString>> =
        unsafe { msg_send![provider, registeredTypeIdentifiers] };
    types.iter().find(|identifier| is_file_type(identifier))
}

/// The uniform type `identifier` names (a `UTType`), when the framework
/// loads and knows it.
fn uniform_type(identifier: &str) -> Option<Retained<AnyObject>> {
    let type_class = crate::picker::uniform_types()
        .then(|| class(c"UTType"))
        .flatten()?;
    let identifier = NSString::from_str(identifier);
    // SAFETY: UTType's documented API (iOS 14).
    unsafe { msg_send![type_class, typeWithIdentifier: &*identifier] }
}

/// Whether the type `identifier` conforms to the type `to` (false when
/// either is unknown).
pub(crate) fn conforms(identifier: &NSString, to: &str) -> bool {
    let (Some(kind), Some(to)) = (uniform_type(&identifier.to_string()), uniform_type(to)) else {
        return false;
    };
    // SAFETY: UTType's documented API (iOS 14).
    unsafe { msg_send![&kind, conformsToType: &*to] }
}

/// Whether the type `identifier` is a file's: data, but not text or a link.
pub(crate) fn is_file_type(identifier: &NSString) -> bool {
    conforms(identifier, "public.data")
        && !conforms(identifier, "public.text")
        && !conforms(identifier, "public.url")
}

/// The MIME type of a file of type `identifier` (`application/octet-stream`
/// when the type has none) and the file name extension the type prefers.
pub(crate) fn mime_and_extension(identifier: &NSString) -> (String, Option<String>) {
    let kind = uniform_type(&identifier.to_string());
    // SAFETY: UTType's documented getters (iOS 14).
    let (mime, extension) = kind.map_or((None, None), |kind| unsafe {
        let mime: Option<Retained<NSString>> = msg_send![&kind, preferredMIMEType];
        let extension: Option<Retained<NSString>> = msg_send![&kind, preferredFilenameExtension];
        (
            mime.map(|m| m.to_string()),
            extension.map(|e| e.to_string()),
        )
    });
    (
        mime.unwrap_or_else(|| "application/octet-stream".into()),
        extension,
    )
}

/// The type identifier a file named `name` of MIME type `mime` has: the
/// type of its extension, else of its MIME type, else `public.data`.
#[cfg(feature = "dev")]
pub(crate) fn type_of_file(name: &str, mime: &str) -> String {
    let found = crate::picker::uniform_types()
        .then(|| class(c"UTType"))
        .flatten()
        .and_then(|type_class| {
            let extension = std::path::Path::new(name)
                .extension()
                .map(|e| NSString::from_str(&e.to_string_lossy()));
            let mime = NSString::from_str(mime);
            // SAFETY: UTType's documented API (iOS 14).
            unsafe {
                let by_extension: Option<Retained<AnyObject>> = match &extension {
                    Some(extension) => {
                        msg_send![type_class, typeWithFilenameExtension: &**extension]
                    }
                    None => None,
                };
                let found = match by_extension {
                    Some(found) => Some(found),
                    None => msg_send![type_class, typeWithMIMEType: &*mime],
                };
                // A dynamic type (`dyn.…`) is no type another app reads.
                found
                    .map(|found| -> Retained<NSString> { msg_send![&found, identifier] })
                    .map(|identifier| identifier.to_string())
                    .filter(|identifier| !identifier.starts_with("dyn."))
            }
        });
    found.unwrap_or_else(|| "public.data".into())
}

/// The name of a pasted file: the one its item suggests (no folder in it),
/// else `file`, given the extension of its type when it has none.
pub(crate) fn pasted_name(suggested: Option<&str>, extension: Option<&str>) -> String {
    let suggested = suggested.unwrap_or_default().trim().replace('/', "_");
    let name = if suggested.is_empty() {
        "file".to_owned()
    } else {
        suggested
    };
    match extension {
        Some(extension) if std::path::Path::new(&name).extension().is_none() => {
            format!("{name}.{extension}")
        }
        _ => name,
    }
}

/// The item providers of `session`'s items (a `UIDropSession`).
fn providers(session: &AnyObject) -> Vec<Retained<AnyObject>> {
    // SAFETY: UIDragDropSession's `items`, UIDragItem's `itemProvider`.
    unsafe {
        let items: Retained<NSArray<AnyObject>> = msg_send![session, items];
        items
            .iter()
            .map(|item| msg_send![&item, itemProvider])
            .collect()
    }
}

/// Whether `session` offers at least one file.
fn offers_files(session: &AnyObject) -> bool {
    providers(session).iter().any(|p| file_type(p).is_some())
}

/// Whether `provider` offers text (plain or rich; a link alone is no text).
fn has_text(provider: &AnyObject) -> bool {
    let text = NSString::from_str("public.text");
    // SAFETY: NSItemProvider's documented API (iOS 11).
    unsafe { msg_send![provider, hasItemConformingToTypeIdentifier: &*text] }
}

/// What a drag gives a view: its files when it offers some and the view
/// listens to `onFileDrop`, else its text when it offers some and the view
/// takes text drops (a Rust component such as `RichEditor`,
/// [`nsh_core::EventKind::TextDrop`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Offer {
    Files,
    Text,
}

/// What `session` gives a view that listens to `events`, if anything.
pub(crate) fn offer(session: &AnyObject, events: nsh_core::EventMask) -> Option<Offer> {
    use nsh_core::EventKind;
    let files = offers_files(session);
    if files && events.contains(EventKind::FileDrop) {
        Some(Offer::Files)
    } else if !files
        && events.contains(EventKind::TextDrop)
        && providers(session).iter().any(|p| has_text(p))
    {
        Some(Offer::Text)
    } else {
        None
    }
}

/// The proposal for a drag over a listener: copy what it offers it.
pub(crate) fn proposal(offered: bool) -> Option<Retained<AnyObject>> {
    let operation = if offered { COPY } else { FORBIDDEN };
    let class = class(c"UIDropProposal")?;
    // SAFETY: UIDropProposal's documented initializer (iOS 11).
    unsafe {
        let alloc: Allocated<AnyObject> = msg_send![class, alloc];
        msg_send![alloc, initWithDropOperation: operation]
    }
}

/// Where `session` is, in the window's coordinates, or `None` once
/// `interaction`'s view is gone. A drop session takes no nil view
/// (`locationInView:` raises), so the point is read in the view's
/// coordinates and converted.
pub(crate) fn location(
    interaction: &AnyObject,
    session: &AnyObject,
) -> Option<objc2_core_foundation::CGPoint> {
    // SAFETY: UIInteraction's `view` (weak), UIDragDropSession's
    // `locationInView:` with that view.
    unsafe {
        let view: Option<Retained<objc2_ui_kit::UIView>> = msg_send![interaction, view];
        let view = view?;
        let local: objc2_core_foundation::CGPoint = msg_send![session, locationInView: &*view];
        Some(view.convertPoint_toView(local, None))
    }
}

/// The directory this drop's copies go to: a new one in the app's
/// temporary directory, so files of the same name do not collide.
fn drop_directory() -> Option<std::path::PathBuf> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join("nsh-drops").join(format!(
        "{}-{n}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis())
    ));
    std::fs::create_dir_all(&dir).ok().map(|()| dir)
}

/// The file name of an item's copy: the provider's suggested name with the
/// extension of the file it wrote, or that file's own name.
fn file_name(suggested: &str, written: &std::path::Path) -> String {
    let own = written
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let suggested = suggested.trim().replace('/', "_");
    if suggested.is_empty() {
        return own;
    }
    match written.extension().map(|e| e.to_string_lossy()) {
        Some(ext) if !suggested.ends_with(&format!(".{ext}")) => format!("{suggested}.{ext}"),
        _ => suggested,
    }
}

/// Reads the files `session` offers into the app's temporary directory, then
/// calls `done` with their `file:` URLs in the drag's order (on a queue of
/// the providers'; empty when none could be read).
pub(crate) fn read(session: &AnyObject, done: impl FnOnce(Vec<String>) + Send + 'static) {
    let files: Vec<_> = providers(session)
        .into_iter()
        .filter_map(|p| file_type(&p).map(|t| (p, t)))
        .collect();
    let Some(dir) = (!files.is_empty()).then(drop_directory).flatten() else {
        done(Vec::new());
        return;
    };
    struct Reading<F> {
        uris: Vec<Option<String>>,
        left: usize,
        done: Option<F>,
    }
    let reading = Arc::new(Mutex::new(Reading {
        uris: vec![None; files.len()],
        left: files.len(),
        done: Some(done),
    }));
    for (index, (provider, kind)) in files.into_iter().enumerate() {
        // SAFETY: NSItemProvider's `suggestedName` (iOS 11).
        let suggested: Option<Retained<NSString>> = unsafe { msg_send![&provider, suggestedName] };
        let suggested = suggested.map(|n| n.to_string()).unwrap_or_default();
        let item_dir = dir.join(index.to_string());
        let reading = reading.clone();
        let handler = RcBlock::new(move |url: *mut NSURL, _error: *mut NSError| {
            // SAFETY: the URL of the file the provider wrote, valid until
            // this returns (null on failure).
            let url = unsafe { url.as_ref() };
            let uri = url
                .and_then(|url| url.path())
                .and_then(|path| {
                    let written = std::path::PathBuf::from(path.to_string());
                    let to = item_dir.join(file_name(&suggested, &written));
                    std::fs::create_dir_all(&item_dir).ok()?;
                    std::fs::copy(&written, &to).ok()?;
                    Some(to)
                })
                .and_then(|to| {
                    let path = NSString::from_str(&to.to_string_lossy());
                    NSURL::fileURLWithPath(&path).absoluteString()
                })
                .map(|uri| uri.to_string());
            if uri.is_none() {
                log::warn!("a dropped file could not be read");
            }
            let mut state = reading.lock().unwrap_or_else(|e| e.into_inner());
            state.uris[index] = uri;
            state.left -= 1;
            if state.left == 0
                && let Some(done) = state.done.take()
            {
                let uris = state.uris.drain(..).flatten().collect();
                drop(state);
                done(uris);
            }
        });
        // SAFETY: NSItemProvider's documented API (iOS 11); the handler runs
        // once on a queue of the provider's.
        let _: Option<Retained<AnyObject>> = unsafe {
            msg_send![&provider, loadFileRepresentationForTypeIdentifier: &*kind, completionHandler: &*handler]
        };
    }
}

/// Reads the text `session` offers (each item's plain text, and its HTML
/// when it has some, joined by line breaks), then calls `done` with the
/// text and the HTML, on a queue of the providers'.
pub(crate) fn read_text(session: &AnyObject, done: impl FnOnce(String, String) + Send + 'static) {
    let providers: Vec<_> = providers(session)
        .into_iter()
        .filter(|p| has_text(p))
        .collect();
    let Some(string_class) = class(c"NSString").filter(|_| !providers.is_empty()) else {
        done(String::new(), String::new());
        return;
    };
    let html_type = NSString::from_str("public.html");
    let with_html: Vec<bool> = providers
        .iter()
        // SAFETY: NSItemProvider's documented API (iOS 11).
        .map(|p| unsafe { msg_send![&**p, hasItemConformingToTypeIdentifier: &*html_type] })
        .collect();
    let reads = providers.len() + with_html.iter().filter(|&&h| h).count();
    let reading = Arc::new(Mutex::new(TextReading {
        text: vec![None; providers.len()],
        html: vec![None; providers.len()],
        left: reads,
        done: Some(Box::new(done) as Box<dyn FnOnce(String, String) + Send>),
    }));
    for (index, provider) in providers.iter().enumerate() {
        let r = reading.clone();
        let handler = RcBlock::new(move |object: *mut AnyObject, _error: *mut NSError| {
            // SAFETY: the NSString the provider read, valid for this call
            // (null on failure).
            let text = unsafe { object.as_ref() }
                .and_then(|o| o.downcast_ref::<NSString>())
                .map(|s| s.to_string());
            TextReading::done_one(&r, |state| state.text[index] = text);
        });
        // SAFETY: NSItemProvider's `loadObjectOfClass:completionHandler:`
        // (iOS 11) with NSString, an NSItemProviderReading class; the
        // handler runs once on a queue of the provider's.
        let _: Option<Retained<AnyObject>> = unsafe {
            msg_send![&**provider, loadObjectOfClass: string_class, completionHandler: &*handler]
        };
        if with_html[index] {
            let r = reading.clone();
            let handler = RcBlock::new(move |data: *mut NSData, _error: *mut NSError| {
                // SAFETY: the data the provider read, valid for this call
                // (null on failure).
                let html = unsafe { data.as_ref() }
                    .map(|d| String::from_utf8_lossy(&d.to_vec()).into_owned());
                TextReading::done_one(&r, |state| state.html[index] = html);
            });
            // SAFETY: NSItemProvider's documented API (iOS 11); the handler
            // runs once on a queue of the provider's.
            let _: Option<Retained<AnyObject>> = unsafe {
                msg_send![&**provider, loadDataRepresentationForTypeIdentifier: &*html_type, completionHandler: &*handler]
            };
        }
    }
}

/// The text and HTML of a text drop read so far, by item.
struct TextReading {
    text: Vec<Option<String>>,
    html: Vec<Option<String>>,
    left: usize,
    done: Option<Box<dyn FnOnce(String, String) + Send>>,
}

impl TextReading {
    /// One read finished (`set` keeps what it read); the last one calls
    /// `done` with the items' text and HTML joined by line breaks.
    fn done_one(reading: &Mutex<TextReading>, set: impl FnOnce(&mut TextReading)) {
        let mut state = reading.lock().unwrap_or_else(|e| e.into_inner());
        set(&mut state);
        state.left -= 1;
        if state.left == 0
            && let Some(done) = state.done.take()
        {
            let text: Vec<String> = state.text.drain(..).flatten().collect();
            let html: Vec<String> = state.html.drain(..).flatten().collect();
            drop(state);
            done(text.join("\n"), html.join("\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::file_name;

    #[test]
    fn copies_keep_the_suggested_name_with_the_written_extension() {
        let written = Path::new("/tmp/x/IMG_0001.jpeg");
        assert_eq!(file_name("Beach", written), "Beach.jpeg");
        assert_eq!(file_name("Beach.jpeg", written), "Beach.jpeg");
        assert_eq!(file_name("", written), "IMG_0001.jpeg");
        assert_eq!(file_name("a/b", written), "a_b.jpeg");
        assert_eq!(file_name("Notes", Path::new("/tmp/x/notes")), "Notes");
    }
}
