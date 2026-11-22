//! Host filesystem services for platforms with virtual app storage.
use std::{future::Future, pin::Pin};

use crate::element::JsError;

/// A host filesystem confined to one app's private data root.
/// Requests contain normalized relative paths; implementations must not
/// follow links outside that root and must enforce the supplied read bounds.
pub trait FileSystem: Send + Sync {
    /// Runs an operation without blocking the engine thread.
    fn execute(
        &self,
        request: FileRequest,
    ) -> Pin<Box<dyn Future<Output = Result<FileResponse, JsError>> + 'static>>;
}
/// One capability-checked filesystem request.
pub struct FileRequest {
    /// Path relative to the app's private root; empty denotes the root.
    pub path: String,
    /// Work to perform.
    pub operation: FileOperation,
}
/// Filesystem operations provided by a host.
pub enum FileOperation {
    /// Read a regular file, refusing larger files before allocating them.
    Read {
        /// Maximum returned byte count.
        max_bytes: usize,
    },
    /// Replace a regular file's contents.
    Write(Vec<u8>),
    /// List entries, stopping before either bound is exceeded.
    Entries {
        /// Maximum number of entries.
        max_entries: usize,
        /// Maximum total UTF-8 name bytes.
        max_name_bytes: usize,
    },
    /// Test existence.
    Exists,
    /// Create a directory.
    Mkdir {
        /// Create missing parents too.
        recursive: bool,
    },
    /// Remove a file.
    Unlink,
    /// Remove an empty directory.
    Rmdir,
    /// Read metadata, optionally for a link itself.
    Stat {
        /// Inspect the link itself.
        link: bool,
    },
    /// Move to another normalized relative path.
    Rename {
        /// Destination relative to the same app root.
        to: String,
    },
    /// Read a link's target.
    Readlink,
}
/// A filesystem operation's result.
pub enum FileResponse {
    /// Completed mutation.
    Unit,
    /// File contents.
    Bytes(Vec<u8>),
    /// Directory entries.
    Entries(Vec<FileEntry>),
    /// Existence result.
    Exists(bool),
    /// Entry metadata.
    Metadata(FileMetadata),
    /// A link's target.
    Link(String),
}
/// One directory entry.
pub struct FileEntry {
    /// Its base name.
    pub name: String,
    /// Whether it is a directory.
    pub directory: bool,
}
/// Metadata represented by the standard `Stats` interface.
pub struct FileMetadata {
    /// Size in bytes.
    pub size: u64,
    /// Type and permission bits.
    pub mode: u32,
    /// Last modification, milliseconds since the epoch.
    pub mtime_ms: f64,
    /// Last access, milliseconds since the epoch.
    pub atime_ms: f64,
    /// Creation, milliseconds since the epoch.
    pub birthtime_ms: f64,
    /// Regular file.
    pub file: bool,
    /// Directory.
    pub directory: bool,
    /// Symbolic link.
    pub symlink: bool,
}
