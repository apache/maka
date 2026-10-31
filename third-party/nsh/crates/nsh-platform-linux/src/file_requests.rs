//! Local paths ([`nsh_core::file_dialog`]): GTK's file dialog for opening
//! and saving (the desktop portal's where there is one), `GtkFileLauncher`
//! to open a file in its app or show it in the file manager (the portal's
//! `OpenURI`, else `GAppInfo` and the `org.freedesktop.FileManager1`
//! service), and GIO's trash (`g_file_trash`). Each is parented to the
//! surface's window and answered as a root `FileRequest` event when GTK
//! calls back.

use std::{path::PathBuf, rc::Rc};

use gtk4::{self as gtk, gio, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    file_dialog::{FileFilter, FileRequest, OpenDialog, SaveDialog},
};

use crate::surface::Surface;

/// Carries out request `id`.
pub(crate) fn request(surface: &Rc<Surface>, id: u32, request: &FileRequest) {
    let window = surface.root.root().and_downcast::<gtk::Window>();
    let surface = Rc::downgrade(surface);
    let request = request.clone();
    glib::spawn_future_local(async move {
        let answer = match request {
            FileRequest::OpenDialog(dialog) => answer(id, pick_paths(&dialog, window).await),
            FileRequest::SaveDialog(dialog) => answer(
                id,
                pick_save_path(&dialog, window)
                    .await
                    .map(|path| path.into_iter().collect()),
            ),
            FileRequest::OpenPath(path) => done(
                id,
                gtk::FileLauncher::new(Some(&gio::File::for_path(&path)))
                    .launch_future(window.as_ref())
                    .await,
            ),
            FileRequest::RevealPath(path) => done(
                id,
                gtk::FileLauncher::new(Some(&gio::File::for_path(&path)))
                    .open_containing_folder_future(window.as_ref())
                    .await,
            ),
            FileRequest::MoveToTrash(path) => done(
                id,
                gio::File::for_path(&path)
                    .trash_future(glib::Priority::DEFAULT)
                    .await,
            ),
            other => {
                log::debug!("linux: file request {other:?} is not supported");
                EventPayload::file_failed(id, "not supported")
            }
        };
        if let Some(surface) = surface.upgrade() {
            surface.event(ROOT_ID, EventKind::FileRequest, answer);
        }
    });
}

fn done(id: u32, result: Result<(), glib::Error>) -> EventPayload {
    answer(id, result.map(|()| Vec::new()))
}

/// A dialog's answer: the paths (none when dismissed), or why it failed.
fn answer(id: u32, result: Result<Vec<PathBuf>, glib::Error>) -> EventPayload {
    match result {
        Ok(paths) => EventPayload::file_answer(id, paths),
        Err(err) => EventPayload::file_failed(id, err.to_string()),
    }
}

/// A dialog showing `title` and `button_label`, starting in `directory`,
/// offering `filters` (any file without), the first chosen.
fn dialog(
    title: Option<&str>,
    button_label: Option<&str>,
    directory: Option<&PathBuf>,
    filters: &[FileFilter],
) -> gtk::FileDialog {
    let dialog = gtk::FileDialog::builder().modal(true).build();
    if let Some(title) = title {
        dialog.set_title(title);
    }
    if let Some(label) = button_label {
        dialog.set_accept_label(Some(label));
    }
    if let Some(directory) = directory {
        dialog.set_initial_folder(Some(&gio::File::for_path(directory)));
    }
    let filters: Vec<gtk::FileFilter> = filters
        .iter()
        .map(|filter| {
            let shown = gtk::FileFilter::new();
            shown.set_name(Some(&filter.name));
            for extension in &filter.extensions {
                shown.add_suffix(extension);
            }
            shown
        })
        .collect();
    if let Some(first) = filters.first() {
        let list = gio::ListStore::new::<gtk::FileFilter>();
        list.extend_from_slice(&filters);
        dialog.set_filters(Some(&list));
        dialog.set_default_filter(Some(first));
    }
    dialog
}

/// The paths picked (none when the dialog was dismissed), or why it
/// failed. GTK's dialog picks files or folders, not both: files and
/// folders pick files.
async fn pick_paths(
    request: &OpenDialog,
    window: Option<gtk::Window>,
) -> Result<Vec<PathBuf>, glib::Error> {
    let folders = !request.picks_files();
    let filters: &[FileFilter] = if folders { &[] } else { &request.filters };
    let dialog = dialog(
        request.title.as_deref(),
        request.button_label.as_deref(),
        request.directory.as_ref(),
        filters,
    );
    let window = window.as_ref();
    let list = match (folders, request.multiple) {
        (false, false) => one(dialog.open_future(window).await),
        (false, true) => many(dialog.open_multiple_future(window).await),
        (true, false) => one(dialog.select_folder_future(window).await),
        (true, true) => many(dialog.select_multiple_folders_future(window).await),
    };
    dismissed_is_none(list)
}

/// The path chosen (none when the dialog was dismissed), or why it failed.
async fn pick_save_path(
    request: &SaveDialog,
    window: Option<gtk::Window>,
) -> Result<Option<PathBuf>, glib::Error> {
    let dialog = dialog(
        request.title.as_deref(),
        request.button_label.as_deref(),
        request.directory.as_ref(),
        &request.filters,
    );
    if let Some(name) = &request.file_name {
        dialog.set_initial_name(Some(name));
    }
    let chosen = dialog
        .save_future(window.as_ref())
        .await
        .map(|file| file.path().into_iter().collect());
    dismissed_is_none(chosen).map(|mut paths: Vec<PathBuf>| paths.pop())
}

fn one(result: Result<gio::File, glib::Error>) -> Result<Vec<PathBuf>, glib::Error> {
    result.map(|file| file.path().into_iter().collect())
}

fn many(result: Result<gio::ListModel, glib::Error>) -> Result<Vec<PathBuf>, glib::Error> {
    result.map(|list| {
        (0..list.n_items())
            .filter_map(|i| list.item(i).and_downcast::<gio::File>())
            .filter_map(|file| file.path())
            .collect()
    })
}

/// A dismissed dialog is the user's answer, no paths; anything else is
/// the dialog failing (no file chooser portal, ...), logged.
fn dismissed_is_none(
    result: Result<Vec<PathBuf>, glib::Error>,
) -> Result<Vec<PathBuf>, glib::Error> {
    match result {
        Err(err)
            if err.matches(gtk::DialogError::Dismissed)
                || err.matches(gtk::DialogError::Cancelled) =>
        {
            Ok(Vec::new())
        }
        Err(err) => {
            log::warn!("linux: the file dialog failed: {err}");
            Err(err)
        }
        ok => ok,
    }
}
