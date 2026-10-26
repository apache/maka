//! `fs/promises`: capability-checked files. A call checks its path against
//! `capabilities.fs` (a `TypeError` there) and its limits (a `RangeError`)
//! by the path's text and the VM's resolved roots, without disk work; the
//! work then runs off the engine thread, confined to the granted root by a
//! cap-std `Dir`, so a symlink inside a root cannot lead a later operation
//! outside it. Browser hosts provide app-private virtual files through
//! `FileSystem`; the same Rust grant checks confine those requests to the
//! app’s data directory and intersect the manifest and host roots. Results
//! settle as core tasks.

use std::path::{Path, PathBuf};

use crate::element::{
    ClassDef, Held, Instance, JsError, JsHost, JsIn, JsKind, JsObject, JsOwned, JsValue, Later,
    PropError, Quotas, Ret, System, TsTypes, class, module,
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

/// Promise-based files under the roots `capabilities.fs` grants. Failures
/// carry Node's `code` (`ENOENT`, `EEXIST`, ...), `syscall` and `path`; a
/// path no grant covers throws a `TypeError` with `code` `EACCES`.
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
                JsError::Range(format!(
                    "fs exceeded the per-runtime limit of {MAX_IN_FLIGHT} bytes of file data in flight"
                ))
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
        JsError::Range(format!(
            "fs exceeded the per-runtime outstanding host task limit of {MAX_PENDING}"
        ))
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

/// `path` without `.` and `..`, resolved by its text.
fn lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => (),
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The canonical form of the nearest existing ancestor, with the rest
/// appended.
#[cfg(not(target_arch = "wasm32"))]
fn resolved(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    let mut tail = Vec::new();
    loop {
        if let Ok(mut real) = crate::access::canonicalize(&current) {
            real.extend(tail.into_iter().rev());
            return Ok(real);
        }
        let name = current
            .file_name()
            .ok_or("invalid filesystem path")?
            .to_owned();
        if !current.pop() {
            return Err("invalid filesystem path".into());
        }
        tail.push(name);
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

/// The rest of `path` past `root`, when `path` is in it (component by
/// component; ignoring ASCII case on Windows, as its file systems do).
fn inside(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut rest = path.components();
    for part in root.components() {
        let next = rest.next()?;
        let same = if cfg!(windows) {
            next.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&part.as_os_str().to_string_lossy())
        } else {
            next == part
        };
        if !same {
            return None;
        }
    }
    Some(rest.collect())
}

/// The rest of `path` in root `(expanded, canonical)`: under either form
/// (`/var/…` and `/private/var/…` on macOS).
#[cfg(not(target_arch = "wasm32"))]
fn in_root(path: &Path, (expanded, canonical): &(PathBuf, PathBuf)) -> Option<PathBuf> {
    inside(path, canonical).or_else(|| inside(path, expanded))
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
    let available = cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    )) && sys.os.is_desktop();
    let available = available || (cfg!(target_arch = "wasm32") && sys.filesystem.is_some());
    if !roots.is_empty() && !available {
        return Err(
            JsError::Type("native filesystem unavailable on this platform".into())
                .with_code("ENOSYS"),
        );
    }
    // By the path's text and the VM's resolved roots: no disk work on the
    // engine thread. A symlink inside a root cannot lead outside it: the
    // work runs in the opened root (cap-std).
    #[cfg(not(target_arch = "wasm32"))]
    {
        let roots_of = sys.locals.get::<Roots>();
        let data = sys.data_dir.clone().unwrap_or_default();
        let requested = if path.starts_with("${") {
            sys.paths.resolve_root(path, &data).map_err(JsError::Type)?
        } else {
            PathBuf::from(path)
        };
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
    Err(JsError::Type(format!(
        "filesystem {what} is not granted by capabilities.fs.{what}"
    ))
    .with_code("EACCES")
    .with("path", path))
}

/// Intersects manifest and host grants inside the app's private data root.
#[cfg(any(target_arch = "wasm32", test))]
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
    let requested = if path.starts_with("${") {
        sys.paths.resolve_root(path, &data).map_err(JsError::Type)?
    } else {
        PathBuf::from(path)
    };
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
}

/// Runs `work` off the engine thread (on the tasks' runtime's blocking
/// threads, else a thread of its own).
#[cfg(not(target_arch = "wasm32"))]
async fn blocking<T: Send + 'static>(
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

#[cfg(not(target_arch = "wasm32"))]
impl Grant {
    fn name(&self) -> &str {
        &self.name
    }

    /// The first of its roots that exists, opened, and the path in it. A
    /// write creates its first root when none exists (the app's own
    /// directory, `${dataDir}`); for a read, every entry of a root that
    /// does not exist is missing.
    fn open(&self) -> std::io::Result<(cap_std::fs::Dir, &Path)> {
        let mut failed = None;
        for (root, relative) in &self.within {
            match confined::open_root(root) {
                Ok(dir) => return Ok((dir, relative)),
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
        Ok((confined::open_root(root)?, relative))
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
                .open()
                .and_then(|(dir, relative)| confined::open_file(&dir, relative, false))
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
                .open()
                .and_then(|(dir, relative)| confined::open_file(&dir, relative, true))
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
            self.open()
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
                .open()
                .is_ok_and(|(dir, relative)| dir.symlink_metadata(relative).is_ok()))
        })
        .await
    }

    async fn stat(self, link: bool) -> Result<Stats, JsError> {
        blocking(move || {
            self.open()
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
            self.open()
                .and_then(|(dir, relative)| dir.read_link_contents(relative))
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| self.error("read link", "readlink", e))
        })
        .await
    }

    async fn unlink(self) -> Result<(), JsError> {
        blocking(move || {
            self.open()
                .and_then(|(dir, relative)| dir.remove_file(relative))
                .map_err(|e| self.error("remove", "unlink", e))
        })
        .await
    }

    async fn rmdir(self) -> Result<(), JsError> {
        blocking(move || {
            self.open()
                .and_then(|(dir, relative)| dir.remove_dir(relative))
                .map_err(|e| self.error("remove", "rmdir", e))
        })
        .await
    }

    async fn rename(self, to: Self) -> Result<(), JsError> {
        blocking(move || {
            self.open()
                .and_then(|(dir, relative)| {
                    let (target, to_relative) = to.open()?;
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
                .open()
                .and_then(|(dir, relative)| dir.read_dir(relative))
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
mod confined {
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
    pub(super) fn open_root(path: &Path) -> io::Result<Dir> {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            },
            path::Component,
        };
        let mut current = std::fs::File::open("/")?;
        let parts: Vec<_> = path.components().collect();
        for (i, part) in parts.iter().enumerate() {
            // An ancestor is only passed through: opened for search, it
            // needs no read permission (a home directory may be 0711).
            let through = i + 1 < parts.len();
            match part {
                Component::RootDir => (),
                Component::Normal(name) => {
                    let name = CString::new(name.as_bytes())
                        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
                    let open = |access: libc::c_int| {
                        // SAFETY: current is a live directory and name is
                        // NUL-terminated; the descriptor returned is owned
                        // below.
                        unsafe {
                            libc::openat(
                                current.as_raw_fd(),
                                name.as_ptr(),
                                access | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                            )
                        }
                    };
                    let mut fd = if through {
                        open(SEARCH)
                    } else {
                        open(libc::O_RDONLY)
                    };
                    // A kernel without the search mode (macOS before 13)
                    // refuses it: read the directory then.
                    if fd < 0 && through && SEARCH != libc::O_RDONLY {
                        fd = open(libc::O_RDONLY);
                    }
                    if fd < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    // SAFETY: openat returned a new descriptor nothing else
                    // owns.
                    current = unsafe { std::fs::File::from_raw_fd(fd) };
                }
                _ => return Err(io::Error::from(io::ErrorKind::InvalidInput)),
            }
        }
        Ok(Dir::from_std_file(current))
    }

    /// Opens a canonical root. cap-std confines every later operation to
    /// it; the root is the path the grant check resolved, opened through
    /// the ambient filesystem once.
    #[cfg(not(unix))]
    pub(super) fn open_root(path: &Path) -> io::Result<Dir> {
        Dir::open_ambient_dir(path, cap_std::ambient_authority())
    }

    /// Opens a regular file to read or to write (created when missing). On
    /// Unix it is opened non-blocking, so a FIFO or device cannot stall the
    /// worker; anything but a regular file is refused before a byte moves.
    pub(super) fn open_file(dir: &Dir, path: &Path, write: bool) -> io::Result<File> {
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

    #[test]
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
        assert!(super::virtual_relative(&sys, "${dataDir}/notes/../../secret", true).is_err());
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
