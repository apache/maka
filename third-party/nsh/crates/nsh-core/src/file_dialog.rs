//! The system's file dialogs and file manager for local paths: the open
//! and save dialogs ([`OpenDialog`], [`SaveDialog`]; shown with
//! [`crate::element::pick_paths`] and [`crate::element::pick_save_path`]),
//! opening a file or folder in its default app, showing it in the file
//! manager and moving it to the trash ([`crate::element::open_path`],
//! [`crate::element::reveal_path`], [`crate::element::move_to_trash`]), as
//! GPUI's `prompt_for_paths`, `prompt_for_new_path`, `open_with_system` and
//! `reveal_path` are.
//!
//! Each request is a [`Command::FileRequest`](crate::Command::FileRequest)
//! on the root with a [`FileRequest`]; the platform carries it out
//! (AppKit's `NSOpenPanel`, `NSSavePanel`, `NSWorkspace` and
//! `NSFileManager`; GTK's `GtkFileDialog`, `GtkFileLauncher` and
//! `g_file_trash`; the shell's `IFileOpenDialog`, `IFileSaveDialog`,
//! `ShellExecuteW`, `SHOpenFolderAndSelectItems` and `IFileOperation`;
//! GPUI's prompts and openers) and answers with the root's
//! [`EventKind::FileRequest`](crate::EventKind::FileRequest), whose
//! [`EventPayload::FileRequest`](crate::EventPayload::FileRequest) carries
//! the paths and the error, if any ([`EventPayload::file_answer`],
//! [`EventPayload::file_failed`]).
//!
//! Only platforms whose
//! [`Environment::file_requests`](crate::platform::Environment::file_requests)
//! is set get these commands (the desktops: AppKit, GTK, Win32, GPUI); on
//! the others (iOS, Android, the web) every request answers at once with
//! an error.
//!
//! These services are Rust's only: no module of the runtime exposes them to
//! an app's JS, so only native code (an app's own crate, `nsh-base`) asks,
//! which reaches the filesystem anyway, and no capability gates them. The
//! dialogs only give what the user chose.

use std::path::{Path, PathBuf};

use crate::EventPayload;

/// What the open dialog lets the user pick ([`OpenDialog::kind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum OpenDialogKind {
    /// Files.
    #[default]
    Files,
    /// Folders.
    Folders,
    /// Files and folders alike, where the platform's dialog can (macOS);
    /// files elsewhere.
    FilesAndFolders,
}

/// A group of file types a dialog offers, shown by its name: `Markdown`
/// for `md` and `markdown`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct FileFilter {
    /// What the dialog shows for it (`"Markdown"`).
    pub name: String,
    /// Its file extensions, without the dot, lower case (`"md"`); never
    /// empty.
    pub extensions: Vec<String>,
}

impl FileFilter {
    /// The files of `extensions` (`"md"`, `".md"` or `"*.md"`, any case),
    /// shown as `name`.
    pub fn new(
        name: impl Into<String>,
        extensions: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        let mut filter = FileFilter {
            name: name.into(),
            extensions: extensions.into_iter().map(Into::into).collect(),
        };
        normalize(&mut filter.extensions);
        filter
    }

    /// Whether `path`'s extension is one of the filter's, for platforms
    /// whose dialogs cannot filter (GPUI's).
    pub fn matches(&self, path: &Path) -> bool {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| self.extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
    }
}

/// Whether `path` passes `filters`: any file when there are none.
pub fn passes(filters: &[FileFilter], path: &Path) -> bool {
    filters.is_empty() || filters.iter().any(|f| f.matches(path))
}

/// The open dialog ([`crate::element::pick_paths`]):
///
/// ```ignore
/// let picked = pick_paths(
///     OpenDialog::files()
///         .multiple(true)
///         .filter(FileFilter::new("Markdown", ["md", "markdown"]))
///         .button_label("Open"),
/// )
/// .await;
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct OpenDialog {
    /// What the user picks.
    pub kind: OpenDialogKind,
    /// The user may pick several.
    pub multiple: bool,
    /// The file types offered, the first chosen; none: any file. Ignored
    /// when picking folders.
    pub filters: Vec<FileFilter>,
    /// The dialog's title; `None`: the system's. macOS shows none on a
    /// dialog attached to the window: give a [`Self::button_label`] too.
    pub title: Option<String>,
    /// The label of the button that confirms (`"Link"`); `None`: the
    /// system's (`Open`). GPUI's `prompt`.
    pub button_label: Option<String>,
    /// The folder the dialog starts in; `None`: the system's choice.
    pub directory: Option<PathBuf>,
}

impl OpenDialog {
    /// A dialog picking a file.
    pub fn files() -> Self {
        Self::default()
    }

    /// A dialog picking a folder.
    pub fn folders() -> Self {
        Self::of(OpenDialogKind::Folders)
    }

    /// A dialog picking a file or a folder where the platform can (macOS),
    /// a file elsewhere.
    pub fn files_and_folders() -> Self {
        Self::of(OpenDialogKind::FilesAndFolders)
    }

    fn of(kind: OpenDialogKind) -> Self {
        OpenDialog {
            kind,
            ..Self::default()
        }
    }

    /// Whether the user may pick several.
    pub fn multiple(mut self, multiple: bool) -> Self {
        self.multiple = multiple;
        self
    }

    /// Offers the file types of `filter`, after those given before.
    pub fn filter(mut self, filter: FileFilter) -> Self {
        push_filter(&mut self.filters, filter);
        self
    }

    /// The dialog's title.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// The label of the button that confirms.
    pub fn button_label(mut self, label: impl Into<String>) -> Self {
        self.button_label = Some(label.into());
        self
    }

    /// The folder the dialog starts in.
    pub fn directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.directory = Some(directory.into());
        self
    }

    /// Whether the user picks folders (with files or not).
    pub fn picks_folders(&self) -> bool {
        self.kind != OpenDialogKind::Files
    }

    /// Whether the user picks files (with folders or not).
    pub fn picks_files(&self) -> bool {
        self.kind != OpenDialogKind::Folders
    }
}

/// The save dialog ([`crate::element::pick_save_path`]):
///
/// ```ignore
/// let path = pick_save_path(
///     SaveDialog::new()
///         .file_name("Untitled.md")
///         .filter(FileFilter::new("Markdown", ["md"])),
/// )
/// .await;
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct SaveDialog {
    /// The file name suggested (`"Untitled.md"`); `None`: none.
    pub file_name: Option<String>,
    /// The file types the file may have, the first chosen; none: any.
    pub filters: Vec<FileFilter>,
    /// The dialog's title; `None`: the system's.
    pub title: Option<String>,
    /// The label of the button that confirms (`"Export"`); `None`: the
    /// system's (`Save`).
    pub button_label: Option<String>,
    /// The folder the dialog starts in; `None`: the system's choice.
    pub directory: Option<PathBuf>,
}

impl SaveDialog {
    /// A save dialog with the system's defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// The file name suggested.
    pub fn file_name(mut self, name: impl Into<String>) -> Self {
        self.file_name = Some(name.into());
        self
    }

    /// Offers the file types of `filter`, after those given before.
    pub fn filter(mut self, filter: FileFilter) -> Self {
        push_filter(&mut self.filters, filter);
        self
    }

    /// The dialog's title.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// The label of the button that confirms.
    pub fn button_label(mut self, label: impl Into<String>) -> Self {
        self.button_label = Some(label.into());
        self
    }

    /// The folder the dialog starts in.
    pub fn directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.directory = Some(directory.into());
        self
    }
}

/// The file extensions of all `filters`, each once, for platforms whose
/// dialogs take one list.
pub fn extensions(filters: &[FileFilter]) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    for extension in filters.iter().flat_map(|f| &f.extensions) {
        if !all.contains(extension) {
            all.push(extension.clone());
        }
    }
    all
}

/// What the platform is asked to do with local paths
/// ([`crate::Command::FileRequest`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FileRequest {
    /// Show the open dialog: answer with the paths picked, none when
    /// cancelled, or the error.
    OpenDialog(OpenDialog),
    /// Show the save dialog: answer with the path chosen, none when
    /// cancelled, or the error.
    SaveDialog(SaveDialog),
    /// Open the file or folder in its default app: answer with no error
    /// when it opened.
    OpenPath(PathBuf),
    /// Show the item selected in the file manager: answer with no error
    /// when it showed.
    RevealPath(PathBuf),
    /// Move the item to the trash: answer with where it went when the
    /// platform says (none otherwise), or the error.
    MoveToTrash(PathBuf),
}

/// Adds `filter` unless it has no extensions left.
fn push_filter(filters: &mut Vec<FileFilter>, filter: FileFilter) {
    if !filter.extensions.is_empty() {
        filters.push(filter);
    }
}

/// `extensions` as the dialogs take them: without leading dots or `*.`,
/// lower case, each once, empty ones left out.
fn normalize(extensions: &mut Vec<String>) {
    for extension in extensions.iter_mut() {
        let trimmed = extension
            .trim()
            .trim_start_matches('*')
            .trim_start_matches('.');
        *extension = trimmed.to_lowercase();
    }
    extensions.retain(|e| !e.is_empty());
    let mut seen = Vec::with_capacity(extensions.len());
    extensions.retain(|e| {
        let new = !seen.contains(e);
        if new {
            seen.push(e.clone());
        }
        new
    });
}

impl EventPayload {
    /// The answer to file request `id` that succeeded with `paths`: those
    /// picked, the one chosen to save to, where a trashed item went, or
    /// none (cancelled, or nothing to say).
    pub fn file_answer(id: u32, paths: Vec<PathBuf>) -> EventPayload {
        EventPayload::FileRequest {
            id,
            paths,
            error: None,
        }
    }

    /// The answer to file request `id` that failed, with why.
    pub fn file_failed(id: u32, error: impl Into<String>) -> EventPayload {
        EventPayload::FileRequest {
            id,
            paths: Vec::new(),
            error: Some(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_lose_dots_case_and_empty_extensions() {
        let filter = FileFilter::new("Markdown", [".MD", "*.markdown", "", "md", " txt "]);
        assert_eq!(filter.extensions, ["md", "markdown", "txt"]);
        assert!(filter.matches(Path::new("/a/B.Markdown")));
        assert!(!filter.matches(Path::new("/a/b.rs")));

        let dialog = OpenDialog::files()
            .filter(filter)
            .filter(FileFilter::new("Nothing", [".", ""]))
            .filter(FileFilter::new("Text", ["TXT", "log"]));
        assert_eq!(
            dialog.filters.len(),
            2,
            "a filter without extensions is left out"
        );
        assert_eq!(
            extensions(&dialog.filters),
            ["md", "markdown", "txt", "log"]
        );
        assert!(passes(&dialog.filters, Path::new("/a/b.log")));
        assert!(!passes(&dialog.filters, Path::new("/a/b")));
        assert!(passes(&[], Path::new("/a/b")));
    }

    #[test]
    fn open_dialog_kinds() {
        assert!(OpenDialog::files().picks_files() && !OpenDialog::files().picks_folders());
        assert!(!OpenDialog::folders().picks_files() && OpenDialog::folders().picks_folders());
        let both = OpenDialog::files_and_folders();
        assert!(both.picks_files() && both.picks_folders());
    }
}
