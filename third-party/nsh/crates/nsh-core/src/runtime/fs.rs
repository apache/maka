//! `fs/promises`: capability-checked files. A call checks its path against
//! `capabilities.fs` (an `ERR_ACCESS_DENIED` rejection there) and its limits
//! (a `RangeError`, or `ERR_NSH_QUOTA_EXCEEDED` for the runtime's quotas)
//! by the path's text and the VM's resolved roots, without disk work; the
//! work then runs off the engine thread, confined to the granted root by a
//! cap-std `Dir`, so a symlink inside a root cannot lead a later operation
//! outside it. Browser hosts provide app-private virtual files through
//! `FileSystem`; the same Rust grant checks confine those requests to the
//! app’s data directory and intersect the manifest and host roots. Results
//! settle as core tasks.

use std::path::{Path, PathBuf};

#[cfg(not(target_arch = "wasm32"))]
use crate::access::{in_root, resolved};
use crate::{
    access::{inside, lexical},
    element::{
        ClassDef, Held, Instance, JsError, JsHost, JsIn, JsKind, JsObject, JsOwned, JsValue, Later,
        PropError, Quotas, Ret, System, TsTypes, class, codes, module,
    },
};

/// The largest file `readFile` returns.
const MAX_READ: usize = 64 * 1024 * 1024;
/// The most data one `writeFile` writes.
const MAX_WRITE: usize = 8 * 1024 * 1024;
/// Operations one VM may have outstanding.
const MAX_PENDING: usize = 1024;
/// File data one VM may hold in flight: data handed to `writeFile` until it
/// is written, and data read (contents and directory names) until JS takes
/// it.
const MAX_IN_FLIGHT: usize = 64 * 1024 * 1024;
/// The [`Quotas`] kind of outstanding operations.
const PENDING: &str = "fs.pending";
/// The [`Quotas`] kind of bytes in flight.
const IN_FLIGHT: &str = "fs.bytes";
/// What a read holds of the budget at a time past the size the file had
/// when it was opened.
#[cfg(not(target_arch = "wasm32"))]
const GROWTH: usize = 1024 * 1024;
/// The most entries and name bytes one `readdir` lists.
const MAX_ENTRIES: usize = 10_000;
const MAX_NAME_BYTES: usize = 1024 * 1024;
/// The name bytes a `readdir` holds of the budget ahead of listing them.
#[cfg(not(target_arch = "wasm32"))]
const NAME_BATCH: usize = 64 * 1024;

/// Promise-based files under the roots `capabilities.fs` grants. Every
/// failure rejects. I/O failures carry Node's `code` (`ENOENT`, `EEXIST`,
/// ...), `syscall` and `path`; a path no grant covers rejects with `code`
/// `ERR_ACCESS_DENIED` (`permission` `"fs"`, `resource` the path), a
/// platform without files with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, a
/// used-up quota with `ERR_NSH_QUOTA_EXCEEDED`.
#[module]
pub(crate) struct Fs;

#[module(flat, default)]
impl Fs {
    /// Reads at most 64 MiB. Omitted encoding returns Uint8Array. A runtime
    /// holds at most 64 MiB of file data in flight. Like every function
    /// here, it fails with an `Error & { code?: string; syscall?: string;
    /// path?: string }` (`error.code === "ENOENT"`).
    #[overload(fn(path: String) -> Vec<u8>)]
    #[overload(fn(path: String, encoding: Encoding) -> String)]
    pub(crate) fn read_file(
        path: String,
        encoding: Option<Encoding>,
        sys: System,
    ) -> Result<Later<Holding<FileData>>, JsError> {
        let grant = grant(&sys, &path, false)?;
        let pending = pending(&sys)?;
        let text = encoding.is_some();
        Ok(Later::new(async move {
            let _pending = pending;
            grant.read(&sys.quotas, text).await
        }))
    }

    /// Writes UTF-8 or Uint8Array bytes, replacing an existing regular
    /// file; at most 8 MiB.
    pub(crate) fn write_file(
        path: String,
        data: FileData,
        sys: System,
    ) -> Result<Later<()>, JsError> {
        let grant = grant(&sys, &path, true)?;
        let too_long = |len: usize| {
            JsError::Range(format!(
                "`{}` write is {len} bytes, over the {MAX_WRITE}-byte fs.writeFile limit",
                grant.name()
            ))
            .with_code("ERR_OUT_OF_RANGE")
        };
        let bytes = match data {
            FileData::Text(text) => text.into_bytes(),
            FileData::Bytes(bytes) => bytes,
            FileData::TooLong(len) => return Err(too_long(len)),
        };
        if bytes.len() > MAX_WRITE {
            return Err(too_long(bytes.len()));
        }
        let pending = pending(&sys)?;
        let held = sys
            .quotas
            .reserve(IN_FLIGHT, bytes.len(), MAX_IN_FLIGHT)
            .ok_or_else(|| {
                JsError::Error(format!(
                    "fs exceeded the per-runtime limit of {MAX_IN_FLIGHT} bytes of file data in flight"
                ))
                .with_code(codes::QUOTA_EXCEEDED)
            })?;
        Ok(Later::new(async move {
            let _held = (pending, held);
            grant.write(bytes).await
        }))
    }

    /// Lists a directory's names, sorted, or its entries with
    /// `{ withFileTypes: true }`; at most 10 000 entries.
    #[overload(fn(path: String, options: WithFileTypes) -> Vec<Instance<Dirent>>)]
    #[overload(fn(path: String, options: Option<ReaddirOptions>) -> Vec<String>)]
    pub(crate) fn readdir(
        path: String,
        options: Option<ReaddirOptions>,
        sys: System,
    ) -> Result<Later<Holding<Entries>>, JsError> {
        let types = options.and_then(|o| o.with_file_types).unwrap_or(false);
        let grant = grant(&sys, &path, false)?;
        let pending = pending(&sys)?;
        Ok(Later::new(async move {
            let _pending = pending;
            grant.entries(&sys.quotas, types).await
        }))
    }

    /// Whether the entry exists; a symlink exists even when its target is
    /// missing.
    pub(crate) fn exists(path: String, sys: System) -> Result<Later<bool>, JsError> {
        let grant = grant(&sys, &path, false)?;
        start(&sys, grant.exists())
    }

    /// Removes a file or a symlink itself, never its target.
    pub(crate) fn unlink(path: String, sys: System) -> Result<Later<()>, JsError> {
        let grant = grant(&sys, &path, true)?;
        start(&sys, grant.unlink())
    }

    /// Removes one empty directory.
    pub(crate) fn rmdir(path: String, sys: System) -> Result<Later<()>, JsError> {
        let grant = grant(&sys, &path, true)?;
        start(&sys, grant.rmdir())
    }

    /// Creates a directory (and its missing parents with
    /// `{ recursive: true }`).
    pub(crate) fn mkdir(
        path: String,
        options: Option<MakeDirectoryOptions>,
        sys: System,
    ) -> Result<Later<()>, JsError> {
        let recursive = options.and_then(|o| o.recursive).unwrap_or(false);
        let grant = grant(&sys, &path, true)?;
        start(&sys, grant.mkdir(recursive))
    }

    /// The entry's metadata, following a symlink.
    pub(crate) fn stat(path: String, sys: System) -> Result<Later<Stats>, JsError> {
        let grant = grant(&sys, &path, false)?;
        start(&sys, grant.stat(false))
    }

    /// The entry's metadata; a symlink's own.
    pub(crate) fn lstat(path: String, sys: System) -> Result<Later<Stats>, JsError> {
        let grant = grant(&sys, &path, false)?;
        start(&sys, grant.stat(true))
    }

    /// Moves an entry (a symlink itself, not its target).
    pub(crate) fn rename(from: String, to: String, sys: System) -> Result<Later<()>, JsError> {
        let source = grant(&sys, &from, true)?;
        let target = grant(&sys, &to, true)?;
        start(&sys, source.rename(target))
    }

    /// A symlink's target, as it is written.
    pub(crate) fn readlink(path: String, sys: System) -> Result<Later<String>, JsError> {
        let grant = grant(&sys, &path, false)?;
        start(&sys, grant.readlink())
    }
}

/// One outstanding operation of the VM's at most [`MAX_PENDING`].
fn pending(sys: &System) -> Result<Held, JsError> {
    sys.quotas.take(PENDING, MAX_PENDING).ok_or_else(|| {
        JsError::Error(format!(
            "fs exceeded the per-runtime outstanding host task limit of {MAX_PENDING}"
        ))
        .with_code(codes::QUOTA_EXCEEDED)
    })
}

/// `work` as an outstanding operation.
fn start<T: Ret + 'static>(
    sys: &System,
    work: impl Future<Output = Result<T, JsError>> + 'static,
) -> Result<Later<T>, JsError> {
    let pending = pending(sys)?;
    Ok(Later::new(async move {
        let _pending = pending;
        work.await
    }))
}

/// `readFile`'s encoding: UTF-8 text, as `"utf8"` or `{ encoding: "utf8" }`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Encoding;

impl JsValue for Encoding {
    fn ts_type(_types: &mut TsTypes) -> String {
        r#""utf8" | { encoding: "utf8" }"#.into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let name = match value.kind() {
            JsKind::String => value.as_string(),
            JsKind::Object => {
                if let Some(key) = value.keys()?.into_iter().find(|k| k != "encoding") {
                    return Err(PropError(format!("unknown field `{key}`")));
                }
                value.field("encoding")?.get().as_string()
            }
            _ => None,
        };
        match name {
            Some(name) if matches!(name.to_ascii_lowercase().as_str(), "utf8" | "utf-8") => {
                Ok(Encoding)
            }
            _ => Err(value.expected(r#""utf8" (only UTF-8 text decoding is supported)"#)),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(JsOwned::new(host, host.new_string("utf8")?))
    }
}

/// A file's contents: UTF-8 text or bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FileData {
    Text(String),
    Bytes(Vec<u8>),
    /// Bytes past what one `writeFile` writes, left uncopied: their length.
    TooLong(usize),
}

impl JsValue for FileData {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | Uint8Array".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(text) = value.as_string() {
            return Ok(FileData::Text(text));
        }
        // Measured before the copy: a buffer far past the limit is refused
        // without one.
        if value.kind() == JsKind::Object
            && let Some(len) = value.field("byteLength")?.get().as_number()
            && len > MAX_WRITE as f64
        {
            return Ok(FileData::TooLong(len as usize));
        }
        value
            .as_bytes()
            .map(FileData::Bytes)
            .ok_or_else(|| value.expected("a string or Uint8Array"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            FileData::Text(text) => text.to_js(host),
            FileData::Bytes(bytes) => bytes.to_js(host),
            FileData::TooLong(_) => Err(PropError("file data past the write limit".into())),
        }
    }
}

/// `mkdir`'s options.
#[derive(Debug, Clone, JsObject)]
#[prop(exact)]
pub(crate) struct MakeDirectoryOptions {
    /// Creates the missing parents too.
    recursive: Option<bool>,
}

/// `readdir`'s options.
#[derive(Debug, Clone, JsObject)]
#[prop(exact)]
pub(crate) struct ReaddirOptions {
    /// Lists `Dirent`s instead of names.
    with_file_types: Option<bool>,
}

/// `readdir`'s options asking for `Dirent`s: the type of an overload.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WithFileTypes;

impl JsValue for WithFileTypes {
    fn ts_type(_types: &mut TsTypes) -> String {
        "{ withFileTypes: true }".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match ReaddirOptions::from_js(value)?.with_file_types {
            Some(true) => Ok(WithFileTypes),
            _ => Err(value.expected("{ withFileTypes: true }")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        ReaddirOptions {
            with_file_types: Some(true),
        }
        .to_js(host)
    }
}

/// A result holding part of the VM's in-flight budget until JS takes it.
pub(crate) struct Holding<T> {
    value: T,
    _held: Vec<Held>,
}

impl<T: Ret> Ret for Holding<T> {
    fn ts_type(types: &mut TsTypes) -> String {
        T::ts_type(types)
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // The budget is held until the value is JS's.
        let Holding { value, _held } = self;
        value.into_js(host)
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        T::classes(out);
    }
}

/// What `readdir` lists.
pub(crate) enum Entries {
    Names(Vec<String>),
    Typed(Vec<Instance<Dirent>>),
}

impl Ret for Entries {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {}",
            <Vec<String> as Ret>::ts_type(types),
            <Vec<Instance<Dirent>> as Ret>::ts_type(types)
        )
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Entries::Names(names) => names.into_js(host),
            Entries::Typed(entries) => entries.into_js(host),
        }
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        <Vec<Instance<Dirent>> as Ret>::classes(out);
    }
}

/// An entry of a directory `readdir` lists with `{ withFileTypes: true }`.
#[class(interface)]
pub(crate) struct Dirent {
    name: String,
    directory: bool,
}

#[class]
impl Dirent {
    /// The entry's name.
    #[getter]
    pub(crate) fn name(&self) -> String {
        self.name.clone()
    }

    /// Whether it is a directory.
    pub(crate) fn is_directory(&self) -> bool {
        self.directory
    }
}

/// What `stat` and `lstat` tell of an entry.
#[class(interface)]
#[derive(Debug, Clone)]
pub(crate) struct Stats {
    size: f64,
    mode: u32,
    mtime_ms: f64,
    atime_ms: f64,
    birthtime_ms: f64,
    file: bool,
    directory: bool,
    symlink: bool,
}

/// Milliseconds since the Unix epoch as a time.
fn time(millis: f64) -> std::time::SystemTime {
    std::time::UNIX_EPOCH + std::time::Duration::from_secs_f64(millis.max(0.0) / 1000.0)
}

#[class]
impl Stats {
    /// Its size in bytes.
    #[getter]
    pub(crate) fn size(&self) -> f64 {
        self.size
    }

    /// Its type and permission bits.
    #[getter]
    pub(crate) fn mode(&self) -> u32 {
        self.mode
    }

    /// When it was last modified, in milliseconds since the Unix epoch.
    #[getter]
    pub(crate) fn mtime_ms(&self) -> f64 {
        self.mtime_ms
    }

    /// When it was last accessed, in milliseconds since the Unix epoch.
    #[getter]
    pub(crate) fn atime_ms(&self) -> f64 {
        self.atime_ms
    }

    /// When it was created, in milliseconds since the Unix epoch.
    #[getter]
    pub(crate) fn birthtime_ms(&self) -> f64 {
        self.birthtime_ms
    }

    /// When it was last modified.
    #[getter]
    pub(crate) fn mtime(&self) -> std::time::SystemTime {
        time(self.mtime_ms)
    }

    /// When it was last accessed.
    #[getter]
    pub(crate) fn atime(&self) -> std::time::SystemTime {
        time(self.atime_ms)
    }

    /// When it was created.
    #[getter]
    pub(crate) fn birthtime(&self) -> std::time::SystemTime {
        time(self.birthtime_ms)
    }

    /// Whether it is a regular file.
    pub(crate) fn is_file(&self) -> bool {
        self.file
    }

    /// Whether it is a directory.
    pub(crate) fn is_directory(&self) -> bool {
        self.directory
    }

    /// Whether it is a symlink (only `lstat` tells).
    pub(crate) fn is_symbolic_link(&self) -> bool {
        self.symlink
    }
}

/// A checked path: the granted roots it is in (canonical, in the order
/// of the grants) and the path within each. The work opens the first that
/// exists, off the engine thread.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) struct Grant {
    within: Vec<(PathBuf, PathBuf)>,
    /// A write creates its root when it does not exist yet.
    write: bool,
    name: String,
    /// The path as the call gave it (an error's `path`).
    path: String,
}

/// One VM's granted roots, resolved: the canonical form of each root path
/// (the anchors and the manifest's root expanded), made the first time a
/// call names it. A root's place does not move while the VM runs; what is
/// in it is never cached.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
struct Roots(std::cell::RefCell<rustc_hash::FxHashMap<PathBuf, Option<PathBuf>>>);

#[cfg(not(target_arch = "wasm32"))]
impl crate::element::Local for Roots {}

#[cfg(not(target_arch = "wasm32"))]
impl Roots {
    /// Root `raw` of the manifest or the host grant: its expanded form and
    /// its canonical one (`None`: it names no root).
    fn get(&self, sys: &System, raw: &str) -> Option<(PathBuf, PathBuf)> {
        let data = sys.data_dir.clone().unwrap_or_default();
        let expanded = sys.paths.resolve_root(raw, &data).ok()?;
        let expanded = lexical(&expanded);
        let canonical = self
            .0
            .borrow_mut()
            .entry(expanded.clone())
            .or_insert_with(|| resolved(&expanded).ok())
            .clone()?;
        Some((expanded, canonical))
    }
}

/// The local files the user handed the app in its run: pasted into an
/// input or dropped on a view whose handler got them (`onPaste`'s and
/// `onFileDrop`'s `uris`). Each is readable at its exact path, as the user
/// chose it, whatever `capabilities.fs.read` declares: the path as the
/// event named it and its resolved form, and what that names (a file's
/// contents, a folder's own listing), never what is beside or below it.
/// Never written; forgotten when the VM goes.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
struct UserFiles(std::cell::RefCell<Vec<(PathBuf, PathBuf)>>);

#[cfg(not(target_arch = "wasm32"))]
impl crate::element::Local for UserFiles {}

/// The most files [`UserFiles`] keeps: the oldest go first.
#[cfg(not(target_arch = "wasm32"))]
const MAX_USER_FILES: usize = 4096;

/// Lets the app read the local files `uris` name (`file:` URLs) at their
/// exact paths for the rest of the VM's run: the user pasted or dropped
/// them, as a file chosen in a picker. `nsh-js` calls it as it hands a
/// paste or a drop to the app's handler, never for a drag that only
/// entered. Other URLs, and files that do not exist, are skipped.
#[doc(hidden)]
pub fn grant_user_files(locals: &crate::element::Locals, uris: &[String]) {
    #[cfg(target_arch = "wasm32")]
    let _ = (locals, uris);
    #[cfg(not(target_arch = "wasm32"))]
    {
        if uris.is_empty() {
            return;
        }
        let files = locals.get::<UserFiles>();
        let mut files = files.0.borrow_mut();
        for uri in uris {
            let Some(path) = crate::access::file_url_path(uri) else {
                continue;
            };
            let path = lexical(&path);
            let Ok(real) = crate::access::canonicalize(&path) else {
                continue;
            };
            if real.parent().is_none() || real.file_name().is_none() {
                continue;
            }
            files.retain(|(given, _)| *given != path);
            files.push((path, real));
        }
        let over = files.len().saturating_sub(MAX_USER_FILES);
        files.drain(..over);
    }
}

/// The user's file `requested` names, by its path as it was granted or its
/// resolved one: its folder (resolved) and its name in it.
#[cfg(not(target_arch = "wasm32"))]
fn user_file(sys: &System, requested: &Path) -> Option<(PathBuf, PathBuf)> {
    if !requested.is_absolute() {
        return None;
    }
    let requested = lexical(requested);
    let files = sys.locals.get::<UserFiles>();
    let files = files.0.borrow();
    let (_, real) = files
        .iter()
        .rev()
        .find(|(given, real)| *given == requested || *real == requested)?;
    Some((
        real.parent()?.to_path_buf(),
        PathBuf::from(real.file_name()?),
    ))
}

/// A capability-checked path in the host's private virtual filesystem.
#[cfg(any(target_arch = "wasm32", test))]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct VirtualGrant {
    filesystem: std::sync::Arc<dyn crate::filesystem::FileSystem>,
    relative: String,
    path: String,
}

#[cfg(target_arch = "wasm32")]
type Grant = VirtualGrant;

/// Checks `path` against the `capabilities.fs` roots of a read or a write,
/// by its text (`.` and `..` resolved as written) and the roots' resolved
/// forms. Operations on links (`lstat`, `readlink`, `exists`, `unlink`,
/// `rename`, `rmdir`) then act on the last component itself.
fn grant(sys: &System, path: &str, write: bool) -> Result<Grant, JsError> {
    let access = &sys.access;
    let roots = if write {
        &access.declared.fs.write
    } else {
        &access.declared.fs.read
    };
    let available = crate::access::native_files(sys.os);
    let available = available || (cfg!(target_arch = "wasm32") && sys.filesystem.is_some());
    if !roots.is_empty() && !available {
        return Err(
            JsError::Error("native filesystem unavailable on this platform".into())
                .with_code(codes::UNAVAILABLE),
        );
    }
    // By the path's text and the VM's resolved roots: no disk work on the
    // engine thread. A symlink inside a root cannot lead outside it: the
    // work runs in the opened root (cap-std).
    #[cfg(not(target_arch = "wasm32"))]
    {
        let roots_of = sys.locals.get::<Roots>();
        let data = sys.data_dir.clone().unwrap_or_default();
        let requested = requested_path(sys, path, &data)?;
        let host: Option<Vec<(PathBuf, PathBuf)>> = access.granted.as_ref().map(|host| {
            let grants = if write { &host.fs.write } else { &host.fs.read };
            grants.iter().filter_map(|r| roots_of.get(sys, r)).collect()
        });
        let mut within = Vec::new();
        for raw in roots {
            let Some(root) = roots_of.get(sys, raw) else {
                continue;
            };
            let candidate = if requested.is_absolute() {
                lexical(&requested)
            } else {
                lexical(&root.1.join(&requested))
            };
            let Some(mut relative) = in_root(&candidate, &root) else {
                continue;
            };
            let mut base = root.1.clone();
            if let Some(host) = &host {
                // The host's grant narrows the root: the path must be in
                // one of its roots too; work from the narrower.
                let Some(granted) = host.iter().find_map(|h| {
                    let rest = in_root(&candidate, h)?;
                    Some((h, rest))
                }) else {
                    continue;
                };
                if inside(&granted.0.1, &root.1).is_some() {
                    base = granted.0.1.clone();
                    relative = granted.1;
                }
            }
            within.push((base, relative));
        }
        if let Some((_, first)) = within.first() {
            let name = if first.as_os_str().is_empty() {
                ".".to_owned()
            } else {
                first.display().to_string()
            };
            let within = within
                .into_iter()
                .map(|(root, rest)| {
                    let rest = if rest.as_os_str().is_empty() {
                        PathBuf::from(".")
                    } else {
                        rest
                    };
                    (root, rest)
                })
                .collect();
            return Ok(Grant {
                within,
                write,
                name,
                path: path.to_owned(),
            });
        }
    }
    // A file the user pasted or dropped: read at its exact path, still
    // within the host's grant when the host narrows the app's.
    #[cfg(not(target_arch = "wasm32"))]
    if !write && available {
        let data = sys.data_dir.clone().unwrap_or_default();
        if let Ok(requested) = requested_path(sys, path, &data)
            && let Some((folder, name)) = user_file(sys, &requested)
        {
            let real = folder.join(&name);
            let hosted = access.granted.as_ref().is_none_or(|host| {
                let roots_of = sys.locals.get::<Roots>();
                host.fs.read.iter().any(|r| {
                    roots_of
                        .get(sys, r)
                        .is_some_and(|root| in_root(&real, &root).is_some())
                })
            });
            if hosted {
                return Ok(Grant {
                    within: vec![(folder, name.clone())],
                    write,
                    name: name.display().to_string(),
                    path: path.to_owned(),
                });
            }
        }
    }
    #[cfg(target_arch = "wasm32")]
    if let Some(filesystem) = &sys.filesystem
        && let Some(relative) = virtual_relative(sys, path, write)?
    {
        return Ok(Grant {
            filesystem: filesystem.clone(),
            relative,
            path: path.into(),
        });
    }
    let what = if write { "write" } else { "read" };
    Err(JsError::access_denied(
        format!("filesystem {what} of `{path}` is not granted by capabilities.fs.{what}"),
        "fs",
        path,
    ))
}

/// The real path of the file at `path` the app may share (`Share.show`'s
/// `files`): granted to read as `fs/promises` reads it, resolved through
/// its links and still inside the root that grants it, and a file that
/// exists. Rejects as `fs/promises` would: `ERR_ACCESS_DENIED` for a path
/// no grant covers (or a link leading out of its root), `ENOENT` for one
/// that is no file.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn shared_file(sys: &System, path: &str) -> Result<PathBuf, JsError> {
    let grant = grant(sys, path, false)?;
    let mut escaped = false;
    for (root, relative) in &grant.within {
        let (Ok(real), Ok(real_root)) = (
            crate::access::canonicalize(&root.join(relative)),
            crate::access::canonicalize(root),
        ) else {
            continue;
        };
        if inside(&real, &real_root).is_none() {
            escaped = true;
            continue;
        }
        if real.is_file() {
            return Ok(real);
        }
    }
    if escaped {
        return Err(JsError::access_denied(
            format!("share: `{path}` leads out of the roots capabilities.fs.read grants"),
            "fs",
            path,
        ));
    }
    Err(
        JsError::from(std::io::Error::from(std::io::ErrorKind::NotFound))
            .with_code("ENOENT")
            .with("path", path),
    )
}

/// Browsers' pages share no local files: their files are the page's own.
#[cfg(target_arch = "wasm32")]
pub(crate) fn shared_file(_sys: &System, path: &str) -> Result<PathBuf, JsError> {
    Err(JsError::Error(format!(
        "share: this platform shares no local files (`{path}`)"
    ))
    .with_code(codes::UNAVAILABLE))
}

/// The path a call names, its placeholder (`${dataDir}`, ...) resolved. A
/// `..` the placeholder's own resolution refuses is kept as written, so a
/// path climbing out of every root is refused as any path outside them is
/// (`ERR_ACCESS_DENIED`), and one staying inside a root is that path.
fn requested_path(sys: &System, path: &str, data: &Path) -> Result<PathBuf, JsError> {
    if !path.starts_with("${") {
        return Ok(PathBuf::from(path));
    }
    sys.paths.resolve_root(path, data).or_else(|error| {
        let (head, tail) = path.split_at(path.find('}').map_or(path.len(), |end| end + 1));
        let climbs = tail.split('/').any(|part| part == "..");
        match sys.paths.resolve_root(head, data) {
            Ok(anchor) if climbs && tail.starts_with('/') && !tail.contains(['\0', '*']) => {
                // Component by component: `/` separates nothing in a
                // verbatim Windows anchor.
                Ok(anchor.join(
                    tail.split('/')
                        .filter(|part| !part.is_empty())
                        .collect::<PathBuf>(),
                ))
            }
            _ => Err(JsError::Type(error)),
        }
    })
}

/// Intersects manifest and host grants inside the app's private data root.
#[cfg(any(target_arch = "wasm32", test))]
#[cfg_attr(all(test, windows), allow(dead_code))]
fn virtual_relative(sys: &System, path: &str, write: bool) -> Result<Option<String>, JsError> {
    let Some(data) = &sys.data_dir else {
        return Ok(None);
    };
    let data = lexical(data);
    let access = &sys.access;
    let roots = if write {
        &access.declared.fs.write
    } else {
        &access.declared.fs.read
    };
    let expand = |raw: &str| sys.paths.resolve_root(raw, &data).ok().map(|p| lexical(&p));
    let requested = requested_path(sys, path, &data)?;
    if path.contains('\0') {
        return Err(JsError::Type("filesystem path contains NUL".into())
            .with_code("EINVAL")
            .with("path", path));
    }
    for root in roots.iter().filter_map(|r| expand(r)) {
        let candidate = lexical(&if crate::access::absolute(&requested) {
            requested.clone()
        } else {
            root.join(&requested)
        });
        if inside(&candidate, &root).is_none() {
            continue;
        }
        if let Some(host) = &access.granted {
            let grants = if write { &host.fs.write } else { &host.fs.read };
            if !grants
                .iter()
                .filter_map(|r| expand(r))
                .any(|r| inside(&candidate, &r).is_some())
            {
                continue;
            }
        }
        // OPFS is app-private even when a manifest names other roots.
        let Some(relative) = inside(&candidate, &data) else {
            continue;
        };
        return Ok(Some(relative.to_string_lossy().into_owned()));
    }
    Ok(None)
}

/// "cannot read `name`: the runtime already holds ... in flight".
fn exceeded(name: &str) -> JsError {
    JsError::Error(format!(
        "cannot read `{name}`: the runtime already holds {MAX_IN_FLIGHT} bytes of file data in flight"
    ))
    .with_code(codes::QUOTA_EXCEEDED)
}

/// Runs `work` off the engine thread (on the tasks' runtime's blocking
/// threads, else a thread of its own).
#[cfg(not(target_arch = "wasm32"))]
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, JsError> + Send + 'static,
) -> Result<T, JsError> {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        return runtime
            .spawn_blocking(work)
            .await
            .map_err(|e| JsError::Error(e.to_string()))?;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("nsh-files".into())
        .spawn(move || {
            let _ = tx.send(work());
        })
        .map_err(|e| JsError::Error(e.to_string()))?;
    rx.await.map_err(|e| JsError::Error(e.to_string()))?
}

/// `relative` in canonical `root` with the symlinks on the way resolved
/// (the last component too when `follow`), when they lead to a place still
/// in `root`; else `relative` as it is.
#[cfg(not(target_arch = "wasm32"))]
fn through_links(root: &Path, relative: &Path, follow: bool) -> PathBuf {
    let (dirs, last) = match relative.file_name() {
        Some(name) if !follow => (relative.parent().unwrap_or(Path::new("")), Some(name)),
        _ => (relative, None),
    };
    let Ok(real) = resolved(&root.join(dirs)) else {
        return relative.to_path_buf();
    };
    let Some(mut rest) = inside(&real, root) else {
        return relative.to_path_buf();
    };
    if let Some(last) = last {
        rest.push(last);
    }
    if rest.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        rest
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Grant {
    fn name(&self) -> &str {
        &self.name
    }

    /// The first of its roots that exists, opened, and the path in it. A
    /// write creates its first root when none exists (the app's own
    /// directory, `${dataDir}`); for a read, every entry of a root that
    /// does not exist is missing.
    ///
    /// Symlinks on the way are resolved first (the last component too when
    /// `follow`): cap-std refuses any link to an absolute path, even one
    /// whose target is still in the root (`~/link -> /home/me/elsewhere`).
    /// A target outside the root keeps the path as written, so cap-std
    /// still refuses it.
    fn open(&self, follow: bool) -> std::io::Result<(cap_std::fs::Dir, PathBuf)> {
        let mut failed = None;
        for (root, relative) in &self.within {
            match confined::open_root(root) {
                Ok(dir) => return Ok((dir, through_links(root, relative, follow))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    failed.get_or_insert(e);
                }
            }
        }
        if let Some(e) = failed {
            return Err(e);
        }
        let Some((root, relative)) = self.within.first().filter(|_| self.write) else {
            return Err(std::io::ErrorKind::NotFound.into());
        };
        std::fs::create_dir_all(root)?;
        Ok((confined::open_root(root)?, relative.clone()))
    }

    /// I/O error `error` of `syscall` as Node's: the message names the
    /// entry, `code`, `syscall` and `path` tell it apart.
    fn error(&self, verb: &str, syscall: &'static str, error: std::io::Error) -> JsError {
        let code = crate::element::io_code(&error);
        let thrown = JsError::Error(format!("cannot {verb} `{}`: {error}", self.name));
        match code {
            Some(code) => thrown.with_code(code),
            None => thrown,
        }
        .with("syscall", syscall)
        .with("path", self.path.as_str())
    }

    async fn read(self, quotas: &Quotas, text: bool) -> Result<Holding<FileData>, JsError> {
        let name = self.name.clone();
        let too_big = move |len: usize| {
            JsError::Error(format!(
                "`{name}` is {len} bytes, over the {MAX_READ}-byte limit for fs.readFile; read it in pieces or keep it out of the script"
            ))
            .with_code("ERR_FS_FILE_TOO_LARGE")
        };
        let (grant, file, size) = blocking(move || {
            let file = self
                .open(true)
                .and_then(|(dir, relative)| confined::open_file(&dir, &relative, false))
                .map_err(|e| self.error("read", "open", e))?;
            let size = file
                .metadata()
                .map_err(|e| self.error("read", "fstat", e))?
                .len();
            Ok((self, file, size))
        })
        .await?;
        let size = usize::try_from(size).unwrap_or(usize::MAX);
        if size > MAX_READ {
            return Err(too_big(size));
        }
        let mut held = vec![
            quotas
                .reserve(IN_FLIGHT, size, MAX_IN_FLIGHT)
                .ok_or_else(|| exceeded(&grant.name))?,
        ];
        let mut reserved = size;
        // The file may grow while it is read (or say 0, as `/proc` does):
        // what is read never goes past what is held by more than the byte
        // that tells growth from the end, and more is held a chunk at a time.
        let grant = std::sync::Arc::new(grant);
        let mut bytes = Vec::with_capacity(size);
        let mut file = file;
        loop {
            let want = reserved - bytes.len() + 1;
            let reader = grant.clone();
            let (back, read, more) = blocking(move || {
                use std::io::Read;
                let mut bytes = bytes;
                let before = bytes.len();
                file.by_ref()
                    .take(want as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| reader.error("read", "read", e))?;
                let more = bytes.len() - before == want;
                Ok((file, bytes, more))
            })
            .await?;
            (file, bytes) = (back, read);
            if !more {
                break;
            }
            if bytes.len() > MAX_READ {
                return Err(too_big(bytes.len()));
            }
            let chunk = GROWTH.min(MAX_READ + 1 - reserved);
            held.push(
                quotas
                    .reserve(IN_FLIGHT, chunk, MAX_IN_FLIGHT)
                    .ok_or_else(|| exceeded(&grant.name))?,
            );
            reserved += chunk;
        }
        if bytes.len() > MAX_READ {
            return Err(too_big(bytes.len()));
        }
        let value = if text {
            let decoder = grant.clone();
            // Valid UTF-8 keeps its length, and so what it holds of the
            // budget.
            blocking(move || {
                String::from_utf8(bytes).map(FileData::Text).map_err(|e| {
                    JsError::Error(format!("cannot decode `{}` as UTF-8: {e}", decoder.name))
                        .with_code("EILSEQ")
                        .with("path", decoder.path.as_str())
                })
            })
            .await?
        } else {
            FileData::Bytes(bytes)
        };
        let len = match &value {
            FileData::Text(text) => text.len(),
            FileData::Bytes(bytes) => bytes.len(),
            FileData::TooLong(len) => *len,
        };
        drop(held);
        // At most what was held a moment ago: it fits.
        let held: Vec<Held> = quotas
            .reserve(IN_FLIGHT, len, MAX_IN_FLIGHT)
            .into_iter()
            .collect();
        Ok(Holding { value, _held: held })
    }

    async fn write(self, bytes: Vec<u8>) -> Result<(), JsError> {
        blocking(move || {
            use std::io::Write;
            let mut file = self
                .open(true)
                .and_then(|(dir, relative)| confined::open_file(&dir, &relative, true))
                .map_err(|e| self.error("write", "open", e))?;
            file.set_len(0)
                .map_err(|e| self.error("write", "ftruncate", e))?;
            file.write_all(&bytes)
                .map_err(|e| self.error("write", "write", e))
        })
        .await
    }

    async fn mkdir(self, recursive: bool) -> Result<(), JsError> {
        blocking(move || {
            self.open(true)
                .and_then(|(dir, relative)| {
                    if recursive {
                        dir.create_dir_all(relative)
                    } else {
                        dir.create_dir(relative)
                    }
                })
                .map_err(|e| self.error("create", "mkdir", e))
        })
        .await
    }

    /// Whether the entry exists; a symlink exists even when its target does
    /// not.
    async fn exists(self) -> Result<bool, JsError> {
        blocking(move || {
            Ok(self
                .open(false)
                .is_ok_and(|(dir, relative)| dir.symlink_metadata(&relative).is_ok()))
        })
        .await
    }

    async fn stat(self, link: bool) -> Result<Stats, JsError> {
        blocking(move || {
            self.open(!link)
                .and_then(|(dir, relative)| {
                    if link {
                        dir.symlink_metadata(relative)
                    } else {
                        dir.metadata(relative)
                    }
                })
                .map(confined::stats)
                .map_err(|e| self.error("stat", if link { "lstat" } else { "stat" }, e))
        })
        .await
    }

    async fn readlink(self) -> Result<String, JsError> {
        blocking(move || {
            self.open(false)
                .and_then(|(dir, relative)| dir.read_link_contents(&relative))
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| self.error("read link", "readlink", e))
        })
        .await
    }

    async fn unlink(self) -> Result<(), JsError> {
        blocking(move || {
            self.open(false)
                .and_then(|(dir, relative)| dir.remove_file(&relative))
                .map_err(|e| self.error("remove", "unlink", e))
        })
        .await
    }

    async fn rmdir(self) -> Result<(), JsError> {
        blocking(move || {
            self.open(false)
                .and_then(|(dir, relative)| dir.remove_dir(&relative))
                .map_err(|e| self.error("remove", "rmdir", e))
        })
        .await
    }

    async fn rename(self, to: Self) -> Result<(), JsError> {
        blocking(move || {
            self.open(false)
                .and_then(|(dir, relative)| {
                    let (target, to_relative) = to.open(false)?;
                    dir.rename(relative, &target, to_relative)
                })
                .map_err(|e| self.error("rename", "rename", e))
        })
        .await
    }

    async fn entries(self, quotas: &Quotas, types: bool) -> Result<Holding<Entries>, JsError> {
        let name = self.name.clone();
        let (grant, mut listing) = blocking(move || {
            let listing = self
                .open(true)
                .and_then(|(dir, relative)| dir.read_dir(&relative))
                .map_err(|e| self.error("list", "scandir", e))?;
            Ok((self, listing))
        })
        .await?;
        let grant = std::sync::Arc::new(grant);
        let mut entries = Vec::new();
        let mut name_bytes = 0;
        // The names are held a batch ahead of reading them.
        let mut held = Vec::new();
        let mut holding = 0;
        loop {
            held.push(
                quotas
                    .reserve(IN_FLIGHT, NAME_BATCH, MAX_IN_FLIGHT)
                    .ok_or_else(|| exceeded(&name))?,
            );
            holding += NAME_BATCH;
            let lister = grant.clone();
            let done;
            (listing, entries, name_bytes, done) = blocking(move || {
                let mut entries = entries;
                let mut name_bytes = name_bytes;
                while name_bytes < holding {
                    let Some(entry) = listing.next() else {
                        entries.sort_by(|a: &(String, bool), b| a.0.cmp(&b.0));
                        return Ok((listing, entries, name_bytes, true));
                    };
                    let entry = entry.map_err(|e| lister.error("list", "scandir", e))?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    name_bytes += name.len();
                    if entries.len() == MAX_ENTRIES || name_bytes > MAX_NAME_BYTES {
                        return Err(JsError::Range(format!(
                            "cannot list `{}`: directory exceeded the {MAX_ENTRIES}-entry or {MAX_NAME_BYTES}-name-byte fs.readdir limit",
                            lister.name
                        ))
                        .with_code("ERR_OUT_OF_RANGE")
                        .with("path", lister.path.as_str()));
                    }
                    let directory = entry.file_type().is_ok_and(|t| t.is_dir());
                    entries.push((name, directory));
                }
                Ok((listing, entries, name_bytes, false))
            })
            .await?;
            if done {
                break;
            }
        }
        drop(held);
        // At most what was held a moment ago: it fits.
        let held = quotas.reserve(IN_FLIGHT, name_bytes, MAX_IN_FLIGHT);
        let value = if types {
            Entries::Typed(
                entries
                    .into_iter()
                    .map(|(name, directory)| Instance::new(Dirent { name, directory }))
                    .collect(),
            )
        } else {
            Entries::Names(entries.into_iter().map(|(name, _)| name).collect())
        };
        Ok(Holding {
            value,
            _held: held.into_iter().collect(),
        })
    }
}

#[cfg(any(target_arch = "wasm32", test))]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
impl VirtualGrant {
    fn name(&self) -> &str {
        &self.relative
    }

    async fn run(
        &self,
        operation: crate::filesystem::FileOperation,
        syscall: &'static str,
    ) -> Result<crate::filesystem::FileResponse, JsError> {
        self.filesystem
            .execute(crate::filesystem::FileRequest {
                path: self.relative.clone(),
                operation,
            })
            .await
            .map_err(|e| e.with("syscall", syscall).with("path", self.path.as_str()))
    }

    fn invalid(&self) -> JsError {
        JsError::Error("invalid host filesystem response".into())
            .with_code("EIO")
            .with("path", self.path.as_str())
    }

    async fn read(self, quotas: &Quotas, text: bool) -> Result<Holding<FileData>, JsError> {
        use crate::filesystem::{FileOperation as O, FileResponse as R};
        // Reserve before the host allocates file bytes, including concurrent reads.
        let held = quotas
            .reserve(IN_FLIGHT, MAX_READ, MAX_IN_FLIGHT)
            .ok_or_else(|| exceeded(self.name()))?;
        let R::Bytes(bytes) = self
            .run(
                O::Read {
                    max_bytes: MAX_READ,
                },
                "read",
            )
            .await?
        else {
            return Err(self.invalid());
        };
        if bytes.len() > MAX_READ {
            return Err(JsError::Error("file exceeds fs.readFile limit".into())
                .with_code("ERR_FS_FILE_TOO_LARGE"));
        }
        let len = bytes.len();
        let value = if text {
            FileData::Text(String::from_utf8(bytes).map_err(|e| {
                JsError::Error(e.to_string())
                    .with_code("EILSEQ")
                    .with("path", self.path.as_str())
            })?)
        } else {
            FileData::Bytes(bytes)
        };
        drop(held);
        let held = quotas
            .reserve(IN_FLIGHT, len, MAX_IN_FLIGHT)
            .ok_or_else(|| exceeded(self.name()))?;
        Ok(Holding {
            value,
            _held: vec![held],
        })
    }

    async fn unit(
        self,
        operation: crate::filesystem::FileOperation,
        syscall: &'static str,
    ) -> Result<(), JsError> {
        match self.run(operation, syscall).await? {
            crate::filesystem::FileResponse::Unit => Ok(()),
            _ => Err(self.invalid()),
        }
    }
    async fn write(self, bytes: Vec<u8>) -> Result<(), JsError> {
        self.unit(crate::filesystem::FileOperation::Write(bytes), "write")
            .await
    }
    async fn mkdir(self, recursive: bool) -> Result<(), JsError> {
        self.unit(
            crate::filesystem::FileOperation::Mkdir { recursive },
            "mkdir",
        )
        .await
    }
    async fn unlink(self) -> Result<(), JsError> {
        self.unit(crate::filesystem::FileOperation::Unlink, "unlink")
            .await
    }
    async fn rmdir(self) -> Result<(), JsError> {
        self.unit(crate::filesystem::FileOperation::Rmdir, "rmdir")
            .await
    }
    async fn rename(self, to: Self) -> Result<(), JsError> {
        self.unit(
            crate::filesystem::FileOperation::Rename { to: to.relative },
            "rename",
        )
        .await
    }
    async fn exists(self) -> Result<bool, JsError> {
        match self
            .run(crate::filesystem::FileOperation::Exists, "access")
            .await?
        {
            crate::filesystem::FileResponse::Exists(value) => Ok(value),
            _ => Err(self.invalid()),
        }
    }
    async fn readlink(self) -> Result<String, JsError> {
        match self
            .run(crate::filesystem::FileOperation::Readlink, "readlink")
            .await?
        {
            crate::filesystem::FileResponse::Link(value) => Ok(value),
            _ => Err(self.invalid()),
        }
    }
    async fn stat(self, link: bool) -> Result<Stats, JsError> {
        match self
            .run(
                crate::filesystem::FileOperation::Stat { link },
                if link { "lstat" } else { "stat" },
            )
            .await?
        {
            crate::filesystem::FileResponse::Metadata(m) => Ok(Stats {
                size: m.size as f64,
                mode: m.mode,
                mtime_ms: m.mtime_ms,
                atime_ms: m.atime_ms,
                birthtime_ms: m.birthtime_ms,
                file: m.file,
                directory: m.directory,
                symlink: m.symlink,
            }),
            _ => Err(self.invalid()),
        }
    }
    async fn entries(self, quotas: &Quotas, types: bool) -> Result<Holding<Entries>, JsError> {
        use crate::filesystem::{FileOperation as O, FileResponse as R};
        let held = quotas
            .reserve(IN_FLIGHT, MAX_NAME_BYTES, MAX_IN_FLIGHT)
            .ok_or_else(|| exceeded(self.name()))?;
        let R::Entries(mut entries) = self
            .run(
                O::Entries {
                    max_entries: MAX_ENTRIES,
                    max_name_bytes: MAX_NAME_BYTES,
                },
                "scandir",
            )
            .await?
        else {
            return Err(self.invalid());
        };
        let bytes = entries
            .iter()
            .try_fold(0usize, |n, e| n.checked_add(e.name.len()))
            .unwrap_or(usize::MAX);
        if entries.len() > MAX_ENTRIES || bytes > MAX_NAME_BYTES {
            return Err(JsError::Range("directory exceeds fs.readdir limits".into())
                .with_code("ERR_OUT_OF_RANGE"));
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let value = if types {
            Entries::Typed(
                entries
                    .into_iter()
                    .map(|e| {
                        Instance::new(Dirent {
                            name: e.name,
                            directory: e.directory,
                        })
                    })
                    .collect(),
            )
        } else {
            Entries::Names(entries.into_iter().map(|e| e.name).collect())
        };
        drop(held);
        let held = quotas
            .reserve(IN_FLIGHT, bytes, MAX_IN_FLIGHT)
            .ok_or_else(|| exceeded(self.name()))?;
        Ok(Holding {
            value,
            _held: vec![held],
        })
    }
}

/// Opening granted roots and the files in them.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod confined {
    use std::{io, path::Path};

    use cap_std::fs::{Dir, File, Metadata, OpenOptions};

    /// How a root's ancestors are opened: for search only where the OS has
    /// such a mode (`O_PATH` on Linux and Android, `O_SEARCH` on Apple's),
    /// else for reading.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const SEARCH: libc::c_int = libc::O_PATH;
    #[cfg(target_vendor = "apple")]
    const SEARCH: libc::c_int = libc::O_SEARCH;
    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_vendor = "apple"))
    ))]
    const SEARCH: libc::c_int = libc::O_RDONLY;

    /// Opens a canonical root. On Unix every component is opened with
    /// `O_NOFOLLOW` from `/`, so a symlink swapped in after the grant check
    /// cannot redirect the root.
    #[cfg(unix)]
    pub(crate) fn open_root(path: &Path) -> io::Result<Dir> {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
            path::Component,
        };

        let mut parts = path.components().peekable();
        if parts.next() != Some(Component::RootDir) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // A sandbox may permit traversing / without permitting its contents to be listed.
        let mut current = open_dir_at(libc::AT_FDCWD, c"/", parts.peek().is_some())?;
        while let Some(part) = parts.next() {
            let Component::Normal(name) = part else {
                return Err(io::ErrorKind::InvalidInput.into());
            };
            let name = CString::new(name.as_bytes())
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            current = open_dir_at(current.as_raw_fd(), &name, parts.peek().is_some())?;
        }
        Ok(Dir::from_std_file(current))
    }

    #[cfg(unix)]
    fn open_dir_at(
        parent: std::os::fd::RawFd,
        name: &std::ffi::CStr,
        through: bool,
    ) -> io::Result<std::fs::File> {
        use std::os::fd::FromRawFd;

        let open = |access| {
            // SAFETY: parent is AT_FDCWD for / or a live directory descriptor.
            // name is NUL-terminated. Each opened directory stays pinned for the next step.
            unsafe {
                libc::openat(
                    parent,
                    name.as_ptr(),
                    access | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            }
        };
        let mut fd = open(if through { SEARCH } else { libc::O_RDONLY });
        if fd < 0 && through && SEARCH != libc::O_RDONLY {
            // Some older kernels do not support the search-only mode.
            fd = open(libc::O_RDONLY);
        }
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned an owned descriptor.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    /// Opens a canonical root. cap-std confines every later operation to
    /// it; the root is the path the grant check resolved, opened through
    /// the ambient filesystem once.
    #[cfg(not(unix))]
    pub(crate) fn open_root(path: &Path) -> io::Result<Dir> {
        Dir::open_ambient_dir(path, cap_std::ambient_authority())
    }

    /// Opens a regular file to read or to write (created when missing). On
    /// Unix it is opened non-blocking, so a FIFO or device cannot stall the
    /// worker; anything but a regular file is refused before a byte moves.
    pub(crate) fn open_file(dir: &Dir, path: &Path, write: bool) -> io::Result<File> {
        let mut options = OpenOptions::new();
        if write {
            options.write(true).create(true);
        } else {
            options.read(true);
        }
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK).mode(0o644);
        }
        let file = dir.open_with(path, &options)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            // Node's codes: a directory is EISDIR, a FIFO or device EINVAL.
            let kind = if meta.is_dir() {
                io::ErrorKind::IsADirectory
            } else {
                io::ErrorKind::InvalidInput
            };
            return Err(io::Error::new(kind, "not a regular file"));
        }
        Ok(file)
    }

    pub(super) fn stats(meta: Metadata) -> super::Stats {
        let millis = |time: io::Result<cap_std::time::SystemTime>| {
            time.ok()
                .and_then(|t| t.into_std().duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |t| t.as_secs_f64() * 1000.0)
        };
        #[cfg(unix)]
        let mode = {
            use cap_std::fs::MetadataExt;
            meta.mode()
        };
        // Node's modes on Windows: the type bits (a link's own, from
        // `lstat`), and write bits unless read-only.
        #[cfg(not(unix))]
        let mode = if meta.is_symlink() {
            0o120000
        } else if meta.is_dir() {
            0o040000
        } else {
            0o100000
        } | if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        };
        super::Stats {
            size: meta.len() as f64,
            mode,
            atime_ms: millis(meta.accessed()),
            birthtime_ms: millis(meta.created()),
            mtime_ms: millis(meta.modified()),
            file: meta.is_file(),
            directory: meta.is_dir(),
            symlink: meta.is_symlink(),
        }
    }
}

#[cfg(test)]
mod tests {
    /// A pasted or dropped file is readable at its exact path, by the path
    /// as the event named it or its resolved form; nothing beside it, no
    /// write, and only within the host's grant when the host narrows.
    #[cfg(unix)]
    #[test]
    fn pasted_files_are_readable_at_their_exact_paths() {
        use std::{os::unix::fs::symlink, sync::Arc};

        use crate::{
            access::{Access, Capabilities, TrustedPaths},
            element::{Quotas, System},
        };
        let base = std::env::temp_dir().join(format!("nsh-fs-pasted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let desk = base.join("desk");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(desk.join("folder/inner")).unwrap();
        std::fs::write(desk.join("a b.txt"), "pasted").unwrap();
        std::fs::write(desk.join("secret.txt"), "beside").unwrap();
        symlink(&desk, base.join("link")).unwrap();
        let mut declared = Capabilities::default();
        declared.fs.read = vec!["${dataDir}".into()];
        declared.fs.write = vec!["${dataDir}".into()];
        let sys = |granted: Option<Capabilities>| {
            System::new(
                Arc::new(Access {
                    declared: declared.clone(),
                    granted,
                }),
                Some(data.clone()),
                TrustedPaths::default(),
                Quotas::default(),
            )
        };
        let app = sys(None);
        let file = base.join("link/a b.txt");
        let file = file.to_str().unwrap();
        let real = crate::access::canonicalize(&desk.join("a b.txt")).unwrap();
        let real = real.to_str().unwrap();
        let denied = |r: Result<super::Grant, crate::element::JsError>| match r {
            Err(e) => assert_eq!(e.code(), Some(crate::element::codes::ACCESS_DENIED)),
            Ok(_) => panic!("granted"),
        };
        denied(super::grant(&app, file, false));
        let url = |path: &str| crate::platform::clipboard::file_url(path);
        super::grant_user_files(
            &app.locals,
            &[
                url(file),
                url(desk.join("folder").to_str().unwrap()),
                url(desk.join("missing.txt").to_str().unwrap()),
                "https://example.com/a.txt".into(),
            ],
        );
        for path in [file, real] {
            let grant = super::grant(&app, path, false).unwrap();
            let (dir, relative) = grant.open(true).unwrap();
            assert_eq!(dir.read_to_string(&relative).unwrap(), "pasted");
        }
        // A folder's own listing, nothing in it, nothing beside the file.
        assert!(super::grant(&app, desk.join("folder").to_str().unwrap(), false).is_ok());
        denied(super::grant(
            &app,
            desk.join("folder/inner").to_str().unwrap(),
            false,
        ));
        denied(super::grant(
            &app,
            desk.join("secret.txt").to_str().unwrap(),
            false,
        ));
        denied(super::grant(
            &app,
            desk.join("missing.txt").to_str().unwrap(),
            false,
        ));
        denied(super::grant(&app, &format!("{file}/../secret.txt"), false));
        denied(super::grant(&app, file, true));
        // Another VM's user files are its own.
        denied(super::grant(&sys(None), file, false));
        // A host that narrows the app's files narrows these too.
        let mut host = Capabilities::default();
        host.fs.read = vec!["${dataDir}".into()];
        let narrowed = sys(Some(host.clone()));
        super::grant_user_files(&narrowed.locals, &[url(file)]);
        denied(super::grant(&narrowed, file, false));
        host.fs.read.push(desk.to_str().unwrap().into());
        let wider = sys(Some(host));
        super::grant_user_files(&wider.locals, &[url(file)]);
        assert!(super::grant(&wider, file, false).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn a_path_is_inside_a_root_by_its_components() {
        use std::path::{Path, PathBuf};
        let root = Path::new(if cfg!(windows) {
            "C:\\data\\app"
        } else {
            "/data/app"
        });
        let file = root.join("notes").join("a.txt");
        assert_eq!(
            super::inside(&file, root),
            Some(PathBuf::from("notes").join("a.txt"))
        );
        assert_eq!(super::inside(root, root), Some(PathBuf::new()));
        let sibling = root.with_file_name("application");
        assert_eq!(super::inside(&sibling, root), None);
        #[cfg(windows)]
        assert!(super::inside(Path::new("c:\\DATA\\App\\x"), root).is_some());
    }

    /// A link to an absolute path still in the root is followed (cap-std
    /// alone refuses it); one leading out of the root is still refused.
    #[cfg(unix)]
    #[test]
    fn absolute_links_within_the_root_are_followed() {
        use std::{io::Read, os::unix::fs::symlink, path::Path};
        let base = std::env::temp_dir().join(format!("nsh-fs-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("real/a.txt"), "in").unwrap();
        std::fs::write(outside.join("a.txt"), "out").unwrap();
        let root = crate::access::canonicalize(&root).unwrap();
        let outside = crate::access::canonicalize(&outside).unwrap();
        symlink(root.join("real"), root.join("dir")).unwrap();
        symlink(root.join("real/a.txt"), root.join("file")).unwrap();
        symlink(&outside, root.join("away")).unwrap();
        let dir = super::confined::open_root(&root).unwrap();
        let read = |path: &str, follow: bool| {
            let relative = super::through_links(&root, Path::new(path), follow);
            let mut text = String::new();
            super::confined::open_file(&dir, &relative, false)?.read_to_string(&mut text)?;
            std::io::Result::Ok(text)
        };
        // cap-std alone refuses both.
        assert!(super::confined::open_file(&dir, Path::new("dir/a.txt"), false).is_err());
        assert_eq!(read("dir/a.txt", true).unwrap(), "in");
        assert_eq!(read("file", true).unwrap(), "in");
        assert!(read("away/a.txt", true).is_err());
        // An operation on the link itself keeps its last component.
        assert_eq!(
            super::through_links(&root, Path::new("dir/file"), false),
            Path::new("real/file")
        );
        assert_eq!(
            super::through_links(&root, Path::new("file"), false),
            Path::new("file")
        );
        // A path that does not exist yet (a write) resolves its ancestors.
        assert_eq!(
            super::through_links(&root, Path::new("dir/new.txt"), true),
            Path::new("real/new.txt")
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn virtual_reads_hold_budget_and_preserve_host_error_fields() {
        use std::{future::Future, pin::Pin, sync::Arc};

        use crate::{
            element::{JsError, Quotas},
            filesystem::*,
        };
        struct Fake;
        impl FileSystem for Fake {
            fn execute(
                &self,
                request: FileRequest,
            ) -> Pin<Box<dyn Future<Output = Result<FileResponse, JsError>>>> {
                Box::pin(async move {
                    assert_eq!(request.path, "note.txt");
                    match request.operation {
                        FileOperation::Read { max_bytes } => {
                            assert_eq!(max_bytes, super::MAX_READ);
                            Ok(FileResponse::Bytes(b"hello".to_vec()))
                        }
                        _ => Err(JsError::Error("missing".into()).with_code("ENOENT")),
                    }
                })
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let make = || super::VirtualGrant {
                filesystem: Arc::new(Fake),
                relative: "note.txt".into(),
                path: "${dataDir}/note.txt".into(),
            };
            let quotas = Quotas::default();
            let value = make().read(&quotas, true).await.unwrap();
            assert_eq!(value.value, super::FileData::Text("hello".into()));
            assert_eq!(quotas.held(super::IN_FLIGHT), 5);
            drop(value);
            assert_eq!(quotas.held(super::IN_FLIGHT), 0);
            let held = quotas
                .reserve(super::IN_FLIGHT, 1, super::MAX_IN_FLIGHT)
                .unwrap();
            assert!(make().read(&quotas, false).await.is_err());
            drop(held);
            let error = make().stat(false).await.unwrap_err();
            assert_eq!(error.code(), Some("ENOENT"));
            let JsError::Fields(error) = error else {
                panic!("structured error")
            };
            assert_eq!(
                error.field("path").and_then(|v| v.as_str()),
                Some("${dataDir}/note.txt")
            );
            assert_eq!(
                error.field("syscall").and_then(|v| v.as_str()),
                Some("stat")
            );
        });
    }

    // It models the web's rooted data directory (`/app-data/...`), absolute on
    // wasm32 but not on Windows, where `virtual_relative` never runs.
    #[test]
    #[cfg(not(windows))]
    fn virtual_paths_intersect_grants_and_remain_app_private() {
        use std::{path::PathBuf, sync::Arc};

        use crate::{
            access::{Access, Capabilities},
            element::System,
        };
        let mut declared = Capabilities::all();
        declared.fs.read = vec!["${dataDir}".into()];
        declared.fs.write = vec!["${dataDir}/notes".into()];
        let mut sys = System::new(
            Arc::new(Access {
                declared,
                granted: None,
            }),
            Some(PathBuf::from("/app-data/gallery")),
            Default::default(),
            Default::default(),
        );
        let check = |sys: &System, path, write| super::virtual_relative(sys, path, write).unwrap();
        assert_eq!(
            check(&sys, "notes/a.txt", false).as_deref(),
            Some("notes/a.txt")
        );
        assert_eq!(check(&sys, "a.txt", true).as_deref(), Some("notes/a.txt"));
        assert_eq!(
            check(&sys, "/app-data/gallery/notes/a.txt", true).as_deref(),
            Some("notes/a.txt")
        );
        assert_eq!(
            check(&sys, "${dataDir}/notes/a.txt", true).as_deref(),
            Some("notes/a.txt")
        );
        assert_eq!(check(&sys, "../other/a.txt", false), None);
        assert_eq!(check(&sys, "/app-data/gallery-other/a.txt", false), None);
        assert_eq!(check(&sys, "${dataDir}/outside/a.txt", true), None);
        // `..` after a placeholder resolves as in any path: outside every
        // root it is refused as such (`ERR_ACCESS_DENIED`), inside one it
        // is that path.
        assert_eq!(check(&sys, "${dataDir}/notes/../../secret", true), None);
        assert_eq!(
            check(&sys, "${dataDir}/notes/../notes/a.txt", true).as_deref(),
            Some("notes/a.txt")
        );
        assert!(super::virtual_relative(&sys, "${dataDir}x/a.txt", false).is_err());
        assert_eq!(
            super::virtual_relative(&sys, "bad\0name", false)
                .unwrap_err()
                .code(),
            Some("EINVAL")
        );
        let mut host = Capabilities::all();
        host.fs.read = vec!["${dataDir}/notes/allowed".into()];
        Arc::make_mut(&mut sys.access).granted = Some(host);
        assert_eq!(check(&sys, "notes/blocked.txt", false), None);
        assert_eq!(
            check(&sys, "notes/allowed/a.txt", false).as_deref(),
            Some("notes/allowed/a.txt")
        );
        Arc::make_mut(&mut sys.access).declared.fs.read = vec!["/".into()];
        assert_eq!(check(&sys, "/outside", false), None);
        Arc::make_mut(&mut sys.access).declared.fs.read.clear();
        assert_eq!(check(&sys, "notes/allowed/a.txt", false), None);
    }

    use crate::element::{Registry, declarations};

    #[test]
    fn the_declarations_keep_node_s_overloads_and_shapes() {
        let mut registry = Registry::runtime("fs/promises");
        registry.module::<super::Fs>();
        let d = declarations(&registry, &[]);
        for line in [
            "export declare function readFile(path: string): Promise<Uint8Array>;",
            r#"export declare function readFile(path: string, encoding: "utf8" | { encoding: "utf8" }): Promise<string>;"#,
            "export declare function writeFile(path: string, data: string | Uint8Array): Promise<void>;",
            "export declare function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;",
            "export declare function readdir(path: string, options?: ReaddirOptions | null): Promise<(string)[]>;",
            "export declare function mkdir(path: string, options?: MakeDirectoryOptions | null): Promise<void>;",
            "export declare function rename(from: string, to: string): Promise<void>;",
            "export declare function exists(path: string): Promise<boolean>;",
            "export declare function lstat(path: string): Promise<Stats>;",
            "export interface Stats {",
            "  readonly mtime: Date;",
            "  readonly mtimeMs: number;",
            "  isSymbolicLink(): boolean;",
            "export interface Dirent {",
            "  readonly name: string;",
            "export default defaultExport;",
        ] {
            assert!(d.contains(line), "{line}\n{d}");
        }
        assert!(!d.contains("declare class"), "{d}");
    }
}
