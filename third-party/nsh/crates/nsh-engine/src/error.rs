//! The errors of the app an engine runs, as the platform hears them
//! ([`crate::MountSink::report`]).

use std::{fmt, sync::Arc};

/// What went wrong ([`AppError::kind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AppErrorKind {
    /// The app did not start: its VM could not be made, or evaluating the
    /// bundle threw (a missing module, an exception at the top level).
    Load,
    /// An exception escaped a callback (an event handler, a timer, a
    /// promise). The app keeps running.
    Uncaught,
    /// The VM was stopped: it ran out of memory, went over a quota or sent
    /// an invalid op. No JS of the app runs again and its views stay as
    /// they were. Reported once.
    Stopped,
    /// A development update could not be evaluated; the app keeps the
    /// modules that ran.
    HotUpdate,
    /// A file the app needs (a font) could not be loaded.
    Asset,
}

/// The signed package an app came from ([`crate::Bundle::package`]): which
/// release of it ran, for reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageInfo {
    /// The app id (`com.example.app`).
    pub id: String,
    /// Its display name.
    pub name: String,
    /// Its version string.
    pub version: String,
    /// Its build number.
    pub build: u64,
    /// The package's SHA-256 (hex), its identity for revocation.
    pub sha256: String,
}

/// An error of the app an engine runs. Its text ([`fmt::Display`]) is the
/// message and the stack, as [`crate::MountSink::report_error`] receives
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AppError {
    /// What went wrong.
    pub kind: AppErrorKind,
    /// The message (`Error: boom`), without the stack.
    pub message: String,
    /// The JS stack (`    at fail (App.tsx:5:9)` lines), mapped to the
    /// app's sources when the bundle has a source map.
    pub stack: Option<String>,
    /// The signed package the app came from, if it did.
    pub package: Option<Arc<PackageInfo>>,
}

impl AppError {
    /// An error from its text: the lines from the first stack frame on
    /// (`at …`) are the stack, the ones before it the message.
    pub fn new(kind: AppErrorKind, text: &str) -> AppError {
        let (message, stack) = split_stack(text);
        AppError {
            kind,
            message: message.to_owned(),
            stack: stack.map(str::to_owned),
            package: None,
        }
    }

    /// Sets the package the app came from.
    pub fn with_package(mut self, package: Option<Arc<PackageInfo>>) -> AppError {
        self.package = package;
        self
    }

    /// The app cannot go on: it did not start ([`AppErrorKind::Load`]) or
    /// its VM was stopped ([`AppErrorKind::Stopped`]). An embedding app
    /// would fall back to another build here.
    pub fn is_fatal(&self) -> bool {
        matches!(self.kind, AppErrorKind::Load | AppErrorKind::Stopped)
    }

    /// No JS of the app runs any more ([`AppErrorKind::Stopped`]).
    pub fn is_stopped(&self) -> bool {
        self.kind == AppErrorKind::Stopped
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if let Some(stack) = &self.stack {
            write!(f, "\n{stack}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

/// `text` split before its first stack frame line (QuickJS writes them
/// as `    at name (file:line:column)`), at a line break, so that joining
/// the parts with one gives `text` back.
fn split_stack(text: &str) -> (&str, Option<&str>) {
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        if start > 0 && line.trim_start().starts_with("at ") {
            return (&text[..start - 1], Some(&text[start..]));
        }
        start += line.len();
    }
    (text, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stack_is_split_from_the_message() {
        let text = "Error: boom\n    at fail (App.tsx:5:9)\n    at <anonymous> (App.tsx:7:1)\n";
        let error = AppError::new(AppErrorKind::Uncaught, text);
        assert_eq!(error.message, "Error: boom");
        assert_eq!(
            error.stack.as_deref(),
            Some("    at fail (App.tsx:5:9)\n    at <anonymous> (App.tsx:7:1)\n")
        );
        assert_eq!(error.to_string(), text);
    }

    #[test]
    fn messages_keep_their_lines_and_may_have_no_stack() {
        let text = "Error: two\nlines\n    at f (a.js:1:1)";
        let error = AppError::new(AppErrorKind::Load, text);
        assert_eq!(error.message, "Error: two\nlines");
        assert_eq!(error.to_string(), text);
        let plain = AppError::new(AppErrorKind::Stopped, "the app ran out of memory");
        assert_eq!(plain.stack, None);
        assert_eq!(plain.to_string(), "the app ran out of memory");
        // A message that starts like a frame is still a message.
        assert_eq!(AppError::new(AppErrorKind::Uncaught, "at once").stack, None);
    }

    #[test]
    fn load_failures_and_stops_are_fatal() {
        let kinds = [
            (AppErrorKind::Load, true, false),
            (AppErrorKind::Stopped, true, true),
            (AppErrorKind::Uncaught, false, false),
            (AppErrorKind::HotUpdate, false, false),
            (AppErrorKind::Asset, false, false),
        ];
        for (kind, fatal, stopped) in kinds {
            let error = AppError::new(kind, "x");
            assert_eq!(
                (error.is_fatal(), error.is_stopped()),
                (fatal, stopped),
                "{kind:?}"
            );
        }
    }
}
