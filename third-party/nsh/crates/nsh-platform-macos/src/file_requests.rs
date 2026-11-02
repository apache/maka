//! Local paths ([`nsh_core::file_dialog`]): an open or save panel as a
//! sheet of the surface's window (`NSOpenPanel`, `NSSavePanel`), opening a
//! file in its app (`NSWorkspace openURL:`), showing it selected in Finder
//! (`activateFileViewerSelectingURLs:`) and the trash (`NSFileManager
//! trashItemAtURL:resultingItemURL:error:`, which says where the item
//! went). The panels answer as a root `FileRequest` event when they close,
//! the rest at once.

use std::{cell::Cell, path::PathBuf, rc::Rc};

use block2::RcBlock;
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    file_dialog::{self, FileFilter, FileRequest, OpenDialog, SaveDialog},
};
use nsh_engine::EngineControl;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSError, NSString, NSURL};

use crate::surface::Surface;

/// Carries out request `id`.
pub(crate) fn request(surface: &Rc<Surface>, id: u32, request: &FileRequest) {
    let answer = match request {
        FileRequest::OpenDialog(dialog) => return pick_paths(surface, id, dialog),
        FileRequest::SaveDialog(dialog) => return pick_save_path(surface, id, dialog),
        FileRequest::OpenPath(path) => {
            if NSWorkspace::sharedWorkspace().openURL(&file_url(path)) {
                EventPayload::file_answer(id, Vec::new())
            } else {
                EventPayload::file_failed(id, format!("no app opened `{}`", path.display()))
            }
        }
        FileRequest::RevealPath(path) => {
            // Finder reports nothing back: an item that is not there is
            // the only failure known here.
            if path.exists() {
                let urls = NSArray::from_retained_slice(&[file_url(path)]);
                NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
                EventPayload::file_answer(id, Vec::new())
            } else {
                EventPayload::file_failed(id, format!("`{}` does not exist", path.display()))
            }
        }
        FileRequest::MoveToTrash(path) => match trash(path) {
            Ok(went) => EventPayload::file_answer(id, went.into_iter().collect()),
            Err(error) => EventPayload::file_failed(id, error),
        },
        other => {
            log::debug!("macos: file request {other:?} is not supported");
            EventPayload::file_failed(id, "not supported")
        }
    };
    surface.event(ROOT_ID, EventKind::FileRequest, answer);
}

fn file_url(path: &std::path::Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

fn url_path(url: &NSURL) -> Option<PathBuf> {
    url.path().map(|p| PathBuf::from(p.to_string()))
}

/// Moves `path` to the trash: where it went.
fn trash(path: &std::path::Path) -> Result<Option<PathBuf>, String> {
    let class = AnyClass::get(c"NSFileManager").ok_or("no NSFileManager")?;
    let url = file_url(path);
    let mut went: Option<Retained<NSURL>> = None;
    // SAFETY: Foundation's documented NSFileManager API; `went` is the
    // nullable out-parameter of the item's new URL.
    let result: Result<(), Retained<NSError>> = unsafe {
        let manager: Retained<AnyObject> = msg_send![class, defaultManager];
        msg_send![&manager, trashItemAtURL: &*url, resultingItemURL: Some(&mut went), error: _]
    };
    match result {
        Ok(()) => Ok(went.as_deref().and_then(url_path)),
        Err(error) => Err(error.localizedDescription().to_string()),
    }
}

fn control(surface: &Surface) -> Option<EngineControl> {
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    control
}

/// Sets what the open and save panels share.
///
/// # Safety
///
/// `panel` is an `NSSavePanel` (or an `NSOpenPanel`), on the main thread.
unsafe fn configure(
    panel: &AnyObject,
    title: Option<&str>,
    button_label: Option<&str>,
    directory: Option<&PathBuf>,
    filters: &[FileFilter],
) {
    // SAFETY: AppKit's documented NSSavePanel API, as the caller promises.
    unsafe {
        // Sheets show no title bar: the message is what the user reads.
        if let Some(title) = title {
            let _: () = msg_send![panel, setMessage: &*NSString::from_str(title)];
        }
        if let Some(label) = button_label {
            let _: () = msg_send![panel, setPrompt: &*NSString::from_str(label)];
        }
        if let Some(directory) = directory {
            let _: () = msg_send![panel, setDirectoryURL: &*file_url(directory)];
        }
        // The panels show no filter names: they take every extension.
        let extensions = file_dialog::extensions(filters);
        if !extensions.is_empty() {
            let types: Vec<Retained<NSString>> =
                extensions.iter().map(|e| NSString::from_str(e)).collect();
            let types = NSArray::from_retained_slice(&types);
            // `allowedContentTypes` needs UniformTypeIdentifiers; the
            // extensions say the same.
            let _: () = msg_send![panel, setAllowedFileTypes: &*types];
        }
    }
}

/// Shows `panel` as a sheet of the surface's window (a window of its own
/// without one); `handler` gets the panel's response.
///
/// # Safety
///
/// `panel` is an `NSSavePanel` (or an `NSOpenPanel`), on the main thread.
unsafe fn begin(surface: &Surface, panel: &AnyObject, handler: impl Fn(isize) + 'static) {
    let handler = RcBlock::new(handler);
    // SAFETY: AppKit's documented NSSavePanel API, as the caller promises.
    unsafe {
        match surface.root.ns().window() {
            Some(window) => {
                let _: () = msg_send![panel, beginSheetModalForWindow: &*window, completionHandler: &*handler];
            }
            None => {
                let _: () = msg_send![panel, beginWithCompletionHandler: &*handler];
            }
        }
    }
}

/// Asks the host's question for one folder: `done` gets its path, or `None`
/// when cancelled.
pub(crate) fn choose_directory(surface: &Surface, done: impl FnOnce(Option<PathBuf>) + 'static) {
    let Some(class) = AnyClass::get(c"NSOpenPanel") else {
        return done(None);
    };
    let done = Cell::new(Some(done));
    // SAFETY: AppKit's documented NSOpenPanel API, on the main thread.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class, openPanel];
        let _: () = msg_send![&panel, setCanChooseFiles: false];
        let _: () = msg_send![&panel, setCanChooseDirectories: true];
        let _: () = msg_send![&panel, setCanCreateDirectories: true];
        let _: () = msg_send![&panel, setAllowsMultipleSelection: false];
        let chosen = panel.clone();
        begin(surface, &panel, move |response| {
            let path = if response == 1 {
                let url: Option<Retained<NSURL>> = msg_send![&chosen, URL];
                url.as_deref().and_then(url_path)
            } else {
                None
            };
            if let Some(done) = done.take() {
                done(path);
            }
        });
    }
}

fn pick_paths(surface: &Rc<Surface>, id: u32, request: &OpenDialog) {
    let Some(control) = control(surface) else {
        return;
    };
    let Some(class) = AnyClass::get(c"NSOpenPanel") else {
        control.dispatch_event(
            ROOT_ID,
            EventKind::FileRequest,
            EventPayload::file_failed(id, "no NSOpenPanel"),
        );
        return;
    };
    let filters: &[FileFilter] = if request.picks_files() {
        &request.filters
    } else {
        &[]
    };
    // SAFETY: AppKit's documented NSOpenPanel API, on the main thread.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class, openPanel];
        let _: () = msg_send![&panel, setCanChooseFiles: request.picks_files()];
        let _: () = msg_send![&panel, setCanChooseDirectories: request.picks_folders()];
        let _: () = msg_send![&panel, setCanCreateDirectories: request.picks_folders()];
        let _: () = msg_send![&panel, setAllowsMultipleSelection: request.multiple];
        configure(
            &panel,
            request.title.as_deref(),
            request.button_label.as_deref(),
            request.directory.as_ref(),
            filters,
        );
        let chosen = panel.clone();
        begin(surface, &panel, move |response| {
            // NSModalResponseOK = 1.
            let paths = if response == 1 {
                let urls: Retained<NSArray<NSURL>> = msg_send![&chosen, URLs];
                urls.iter().filter_map(|url| url_path(&url)).collect()
            } else {
                Vec::new()
            };
            control.dispatch_event(
                ROOT_ID,
                EventKind::FileRequest,
                EventPayload::file_answer(id, paths),
            );
        });
    }
}

fn pick_save_path(surface: &Rc<Surface>, id: u32, request: &SaveDialog) {
    let Some(control) = control(surface) else {
        return;
    };
    let Some(class) = AnyClass::get(c"NSSavePanel") else {
        control.dispatch_event(
            ROOT_ID,
            EventKind::FileRequest,
            EventPayload::file_failed(id, "no NSSavePanel"),
        );
        return;
    };
    // SAFETY: AppKit's documented NSSavePanel API, on the main thread.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class, savePanel];
        let _: () = msg_send![&panel, setCanCreateDirectories: true];
        if let Some(name) = &request.file_name {
            let _: () = msg_send![&panel, setNameFieldStringValue: &*NSString::from_str(name)];
        }
        configure(
            &panel,
            request.title.as_deref(),
            request.button_label.as_deref(),
            request.directory.as_ref(),
            &request.filters,
        );
        let chosen = panel.clone();
        begin(surface, &panel, move |response| {
            let path = if response == 1 {
                let url: Option<Retained<NSURL>> = msg_send![&chosen, URL];
                url.as_deref().and_then(url_path)
            } else {
                None
            };
            control.dispatch_event(
                ROOT_ID,
                EventKind::FileRequest,
                EventPayload::file_answer(id, path.into_iter().collect()),
            );
        });
    }
}
