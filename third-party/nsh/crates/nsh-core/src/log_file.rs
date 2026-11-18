//! The file the process's logger writes: the desktop release runners keep
//! a rolling log in the app's data directory (`nsh_engine::logging`) and
//! record its path here, where apps read it ([`crate::element::log_file`],
//! TS `process.logFile`). A process has one logger (the `log` facade's), so
//! it has at most one log file, shared by every engine it runs.

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

/// The file the process's logger writes, `None` when it writes none (a
/// development host, an embedding app, mobile, the web).
pub fn path() -> Option<&'static Path> {
    LOG_FILE.get().map(PathBuf::as_path)
}

/// Records `path` as the file the process's logger writes, for the logger
/// that writes it. The first call holds; returns whether it was this one.
pub fn set(path: PathBuf) -> bool {
    LOG_FILE.set(path).is_ok()
}
