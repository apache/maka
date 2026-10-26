//! What the runtime's system modules (`net`, files, processes) need of the
//! machinery beyond values: the VM's capabilities ([`System`], a parameter
//! the call fills in rather than JS), work that starts in the JS call and
//! finishes as a task ([`Later`]), and errors of a chosen JS class with
//! Node's properties (`code`, `syscall`, `path`), thrown or rejected
//! ([`JsError`]).

use std::{
    any::{Any, TypeId},
    cell::RefCell,
    fmt,
    future::Future,
    path::PathBuf,
    pin::Pin,
    rc::Rc,
    sync::Arc,
};

use rustc_hash::FxHashMap;

use super::{JsHost, Ret, Thrown, call::JsResult, module::ModuleFuture};
use crate::{
    JsonValue,
    access::{Access, TrustedPaths},
};

/// The VM a call comes from, as the host configured it: what the app may
/// do and where its files are. A parameter `sys: System` of a module
/// function or a class's member is not one JS passes: the call fills it
/// in (an `async` one when it is made, as its arguments are converted). A
/// host that configured nothing gives one that grants nothing.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct System {
    /// The capabilities: the app's declaration and the host's grant.
    pub access: Arc<Access>,
    /// The app's own data directory (`${dataDir}`), when the host has one.
    pub data_dir: Option<PathBuf>,
    /// The host's anchors of `${pluginDir}` and `${homeDir}`.
    pub paths: TrustedPaths,
    /// The VM's counts of limited resources.
    pub quotas: Quotas,
    /// The VM's own state of the runtime's modules (`process`'s children).
    pub locals: Locals,
    /// What the host does when the app asks to exit (`process.exit`);
    /// `None`: it installed nothing.
    pub exit: Option<Rc<dyn Fn(i32)>>,
    /// The host WebSocket transport, when the platform supplies one.
    pub websocket: Option<Arc<dyn crate::websocket::WebSocketTransport>>,
    /// The host virtual filesystem, confined to this app’s data directory.
    pub filesystem: Option<Arc<dyn crate::filesystem::FileSystem>>,
    /// The operating system the app runs on, as the host says.
    pub os: crate::platform::Os,
}

impl System {
    /// The VM's capabilities and directories.
    pub fn new(
        access: Arc<Access>,
        data_dir: Option<PathBuf>,
        paths: TrustedPaths,
        quotas: Quotas,
    ) -> Self {
        Self {
            access,
            data_dir,
            paths,
            quotas,
            locals: Locals::default(),
            exit: None,
            websocket: None,
            filesystem: None,
            os: crate::platform::Os::default(),
        }
    }

    /// Uses the host WebSocket transport instead of the native stack.
    pub fn with_websocket(
        mut self,
        websocket: Option<Arc<dyn crate::websocket::WebSocketTransport>>,
    ) -> Self {
        self.websocket = websocket;
        self
    }

    /// Uses the host virtual filesystem.
    pub fn with_filesystem(
        mut self,
        filesystem: Option<Arc<dyn crate::filesystem::FileSystem>>,
    ) -> Self {
        self.filesystem = filesystem;
        self
    }

    /// The operating system the app runs on.
    pub fn with_os(mut self, os: crate::platform::Os) -> Self {
        self.os = os;
        self
    }

    /// The VM's state of the runtime modules, kept with it.
    pub fn with_locals(mut self, locals: Locals) -> Self {
        self.locals = locals;
        self
    }

    /// What the host does with an exit request.
    pub fn with_exit(mut self, exit: Option<Rc<dyn Fn(i32)>>) -> Self {
        self.exit = exit;
        self
    }
}

/// One VM's state of a runtime module (a [`Locals`] entry): made on first
/// use, closed when the VM goes.
pub trait Local: Default + 'static {
    /// Ends what the state owns, before the VM's callbacks go (children
    /// killed, connections closed). Runs once.
    fn close(&self) {}
}

type Entry = (TypeId, Rc<dyn Any>, fn(&dyn Any));

/// One VM's states of the runtime modules ([`Local`]), one per type: the
/// host keeps one per VM, hands it to every [`System`] and closes it when
/// the VM goes.
#[derive(Clone, Default)]
pub struct Locals(Rc<RefCell<Vec<Entry>>>);

impl Locals {
    /// The VM's `T`, made the first time.
    pub fn get<T: Local>(&self) -> Rc<T> {
        let id = TypeId::of::<T>();
        if let Some((_, local, _)) = self.0.borrow().iter().find(|(t, ..)| *t == id) {
            return local
                .clone()
                .downcast()
                .expect("the type it is filed under");
        }
        let local = Rc::new(T::default());
        let close: fn(&dyn Any) = |local| {
            if let Some(local) = local.downcast_ref::<T>() {
                local.close();
            }
        };
        self.0.borrow_mut().push((id, local.clone(), close));
        local
    }

    /// Closes every state, in the order they were made, and forgets them
    /// (the host, when its VM goes).
    pub fn close_all(&self) {
        let locals = std::mem::take(&mut *self.0.borrow_mut());
        for (_, local, close) in &locals {
            close(&**local);
        }
    }
}

/// What a call that is not `async` can do beyond computing (a parameter
/// `cx: CallCx`, filled in by the call): start a task of the core, and tie
/// work to what owns the call in JS. Only in the call: it borrows it.
#[derive(Clone, Copy)]
pub struct CallCx<'a> {
    host: &'a dyn JsHost,
}

impl<'a> CallCx<'a> {
    #[doc(hidden)]
    pub fn new(host: &'a dyn JsHost) -> Self {
        Self { host }
    }

    /// Runs `work` as a task of the core, started in order with what JS
    /// sent before this call (nothing waits for it).
    pub fn start(&self, work: impl Future<Output = ()> + 'static) {
        self.host.start_task(Box::new(move || {
            Box::pin(async move {
                work.await;
                Ok(Box::new(()) as Box<dyn super::ToJs>)
            })
        }));
    }

    /// Runs `f` when what owns the call in JS goes: the reactive owner it
    /// runs under, or the module's run under hot reload (otherwise when the
    /// VM goes, as everything else does). [`Cleanup::release`] unregisters
    /// it once what it undoes ended by itself, so an owner that lives long
    /// does not collect them.
    pub fn on_cleanup(&self, f: impl FnOnce() + 'static) -> Cleanup {
        Cleanup(Some(self.host.on_cleanup(Box::new(f))))
    }
}

/// A cleanup [`CallCx::on_cleanup`] registered. Dropping it keeps the
/// cleanup registered.
pub struct Cleanup(Option<Box<dyn FnOnce()>>);

impl Cleanup {
    /// Unregisters the cleanup without running it (a no-op once it ran).
    pub fn release(mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

impl fmt::Debug for Cleanup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Cleanup")
    }
}

impl fmt::Debug for System {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("System")
            .field("data_dir", &self.data_dir)
            .field("os", &self.os)
            .finish_non_exhaustive()
    }
}

/// One VM's counts of limited resources (open sockets, bytes of file data
/// in flight, ...), by kind: a host keeps one per VM and hands it to every
/// [`System`].
#[derive(Clone, Default)]
pub struct Quotas(Rc<RefCell<FxHashMap<&'static str, usize>>>);

impl Quotas {
    /// Takes one `kind` when fewer than `max` are held; dropping the
    /// [`Held`] gives it back.
    pub fn take(&self, kind: &'static str, max: usize) -> Option<Held> {
        self.reserve(kind, 1, max)
    }

    /// Takes `amount` of `kind` (bytes, ...) when the held total stays at
    /// most `max`; dropping the [`Held`] gives them back.
    pub fn reserve(&self, kind: &'static str, amount: usize, max: usize) -> Option<Held> {
        let mut counts = self.0.borrow_mut();
        let count = counts.entry(kind).or_default();
        let total = count.checked_add(amount).filter(|&total| total <= max)?;
        *count = total;
        Some(Held {
            quotas: self.clone(),
            kind,
            amount,
        })
    }

    /// How many `kind` are held.
    pub fn held(&self, kind: &'static str) -> usize {
        self.0.borrow().get(kind).copied().unwrap_or(0)
    }
}

/// Resources of a [`Quotas`] kind (one, or an amount), given back when
/// dropped.
pub struct Held {
    quotas: Quotas,
    kind: &'static str,
    amount: usize,
}

impl Held {
    /// How much it holds.
    pub fn amount(&self) -> usize {
        self.amount
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(count) = self.quotas.0.borrow_mut().get_mut(self.kind) {
            *count -= self.amount;
        }
    }
}

impl fmt::Debug for Held {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Held({} {})", self.amount, self.kind)
    }
}

/// Work a function or member that is not `async` starts in the JS call
/// and finishes as a task of the core: JS gets a promise of `T`. What the
/// call does before returning it (checking its arguments, taking a quota)
/// throws as a synchronous call's error does; the task's `Err` rejects
/// (a [`JsError`] with its class and properties, any other error as an
/// `Error` with its message). TS: `Promise<T>`.
#[must_use = "the work runs only when the call returns it"]
pub struct Later<T>(Pin<Box<dyn Future<Output = Result<T, Thrown>>>>);

impl<T: Ret + 'static> Later<T> {
    /// The task's work: its value, or what the promise rejects with.
    pub fn new<E: IntoThrown>(work: impl Future<Output = Result<T, E>> + 'static) -> Self {
        Self(Box::pin(async move {
            work.await.map_err(IntoThrown::into_thrown)
        }))
    }

    pub(crate) fn into_future(self) -> ModuleFuture {
        Box::pin(async move {
            let result: JsResult = match self.0.await {
                Ok(v) => Ok(Box::new(v)),
                Err(e) => Err(e),
            };
            result
        })
    }
}

impl<T> fmt::Debug for Later<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Later")
    }
}

/// An error of a chosen JS class: what `Result<T, JsError>` throws, and
/// what a [`Later`] task's `Err(JsError)` rejects with (any other error
/// type is an `Error` with its message). [`JsError::with_code`] and
/// [`JsError::with`] give it properties, as Node's errors have
/// (`error.code === "ENOENT"`; TS: `Error & { code?: string }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsError {
    /// A `TypeError`: the call was not allowed or its value is wrong.
    Type(String),
    /// A `RangeError`: a value past a limit.
    Range(String),
    /// An `Error`.
    Error(String),
    /// One of those with properties.
    Fields(Box<ErrorFields>),
}

/// The JS class of an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// `TypeError`.
    Type,
    /// `RangeError`.
    Range,
    /// `Error`.
    Error,
}

/// An error with properties beside its message ([`JsError::Fields`],
/// [`Thrown::Fields`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorFields {
    /// Its class.
    pub class: ErrorClass,
    /// Its message.
    pub message: String,
    /// Its properties, in order (`code`, `syscall`, `path`, `errno`, ...).
    pub fields: Vec<(&'static str, JsonValue)>,
}

impl ErrorFields {
    fn of(class: ErrorClass, message: String) -> Self {
        Self {
            class,
            message,
            fields: Vec::new(),
        }
    }

    /// Property `key`, if it has one.
    pub fn field(&self, key: &str) -> Option<&JsonValue> {
        self.fields.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }
}

impl JsError {
    /// The error with property `key` set to `value` (replacing one of the
    /// same name).
    pub fn with(self, key: &'static str, value: impl Into<JsonValue>) -> Self {
        let mut fields = match self {
            JsError::Type(m) => ErrorFields::of(ErrorClass::Type, m),
            JsError::Range(m) => ErrorFields::of(ErrorClass::Range, m),
            JsError::Error(m) => ErrorFields::of(ErrorClass::Error, m),
            JsError::Fields(f) => *f,
        };
        fields.fields.retain(|(k, _)| *k != key);
        fields.fields.push((key, value.into()));
        JsError::Fields(Box::new(fields))
    }

    /// The error with Node's `code` (`"ENOENT"`).
    pub fn with_code(self, code: &str) -> Self {
        self.with("code", code)
    }

    /// Its message.
    pub fn message(&self) -> &str {
        match self {
            JsError::Type(m) | JsError::Range(m) | JsError::Error(m) => m,
            JsError::Fields(f) => &f.message,
        }
    }

    /// Its `code`, if it has one.
    pub fn code(&self) -> Option<&str> {
        match self {
            JsError::Fields(f) => f.field("code").and_then(JsonValue::as_str),
            _ => None,
        }
    }
}

/// An I/O error as Node reports it: `Error` with the message and the
/// `code` of its kind or OS error (`ENOENT`, `EACCES`, ...; none when it
/// has no name).
impl From<std::io::Error> for JsError {
    fn from(error: std::io::Error) -> Self {
        let message = error.to_string();
        match io_code(&error) {
            Some(code) => JsError::Error(message).with_code(code),
            None => JsError::Error(message),
        }
    }
}

/// Node's code of I/O error `error`: its OS error's name when it has one,
/// else its kind's.
pub fn io_code(error: &std::io::Error) -> Option<&'static str> {
    use std::io::ErrorKind as K;
    #[cfg(unix)]
    if let Some(code) = error.raw_os_error().and_then(errno_name) {
        return Some(code);
    }
    Some(match error.kind() {
        K::NotFound => "ENOENT",
        K::PermissionDenied => "EACCES",
        K::AlreadyExists => "EEXIST",
        K::NotADirectory => "ENOTDIR",
        K::IsADirectory => "EISDIR",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        K::InvalidFilename => "ENAMETOOLONG",
        K::ReadOnlyFilesystem => "EROFS",
        K::CrossesDevices => "EXDEV",
        K::StorageFull => "ENOSPC",
        K::QuotaExceeded => "EDQUOT",
        K::FileTooLarge => "EFBIG",
        K::ResourceBusy => "EBUSY",
        K::ExecutableFileBusy => "ETXTBSY",
        K::Deadlock => "EDEADLK",
        K::TooManyLinks => "EMLINK",
        K::ArgumentListTooLong => "E2BIG",
        K::Interrupted => "EINTR",
        K::WouldBlock => "EAGAIN",
        K::TimedOut => "ETIMEDOUT",
        K::BrokenPipe => "EPIPE",
        K::ConnectionRefused => "ECONNREFUSED",
        K::ConnectionReset => "ECONNRESET",
        K::ConnectionAborted => "ECONNABORTED",
        K::NotConnected => "ENOTCONN",
        K::AddrInUse => "EADDRINUSE",
        K::AddrNotAvailable => "EADDRNOTAVAIL",
        K::HostUnreachable => "EHOSTUNREACH",
        K::NetworkUnreachable => "ENETUNREACH",
        K::NetworkDown => "ENETDOWN",
        K::InvalidInput => "EINVAL",
        K::Unsupported => "ENOTSUP",
        K::OutOfMemory => "ENOMEM",
        _ => return None,
    })
}

/// The name of Unix error number `errno`, for the ones a file, process or
/// socket call gives that no [`std::io::ErrorKind`] names (`ELOOP`).
#[cfg(unix)]
fn errno_name(errno: i32) -> Option<&'static str> {
    let names: &[(i32, &str)] = &[
        (libc::ENOENT, "ENOENT"),
        (libc::EACCES, "EACCES"),
        (libc::EPERM, "EPERM"),
        (libc::EEXIST, "EEXIST"),
        (libc::ENOTDIR, "ENOTDIR"),
        (libc::EISDIR, "EISDIR"),
        (libc::ENOTEMPTY, "ENOTEMPTY"),
        (libc::ELOOP, "ELOOP"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG"),
        (libc::EBADF, "EBADF"),
        (libc::EBUSY, "EBUSY"),
        (libc::EINVAL, "EINVAL"),
        (libc::EMFILE, "EMFILE"),
        (libc::ENFILE, "ENFILE"),
        (libc::ENOSPC, "ENOSPC"),
        (libc::EROFS, "EROFS"),
        (libc::EXDEV, "EXDEV"),
        (libc::EAGAIN, "EAGAIN"),
        (libc::ENXIO, "ENXIO"),
        (libc::ETXTBSY, "ETXTBSY"),
        (libc::EFBIG, "EFBIG"),
        (libc::EMLINK, "EMLINK"),
        (libc::EPIPE, "EPIPE"),
        (libc::ENOEXEC, "ENOEXEC"),
    ];
    names
        .iter()
        .find(|(n, _)| *n == errno)
        .map(|(_, name)| *name)
}

/// What an `Err` of a synchronous call throws: an `Error` with its message
/// for any [`fmt::Display`] error, the chosen class for a [`JsError`].
pub trait IntoThrown {
    /// The exception.
    fn into_thrown(self) -> Thrown;
}

impl<E: fmt::Display> IntoThrown for E {
    fn into_thrown(self) -> Thrown {
        Thrown::Error(self.to_string())
    }
}

impl IntoThrown for JsError {
    fn into_thrown(self) -> Thrown {
        match self {
            JsError::Type(m) => Thrown::Type(m),
            JsError::Range(m) => Thrown::Range(m),
            JsError::Error(m) => Thrown::Error(m),
            JsError::Fields(f) => Thrown::Fields(f),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        JsonValue,
        element::{JsValue, Registry, declarations, json_host},
        prelude::*,
    };

    #[module]
    struct Files;

    #[module(flat)]
    impl Files {
        /// Reads `path` later.
        pub(crate) fn read(path: String, sys: System) -> Result<Later<Vec<u8>>, JsError> {
            let _ = (path, sys);
            Ok(Later::new(async { Ok::<_, String>(vec![1]) }))
        }

        /// Writes `bytes`, at once.
        pub(crate) fn write(sys: System, bytes: Vec<u8>) -> u32 {
            let _ = sys;
            bytes.len() as u32
        }

        /// Starts a task, tied to the call's owner.
        pub(crate) fn watch(path: String, cx: CallCx<'_>) {
            cx.on_cleanup(move || drop(path));
            cx.start(async {});
        }

        /// Where the files are.
        #[getter]
        pub(crate) fn root(sys: System) -> Option<String> {
            sys.data_dir.map(|d| d.display().to_string())
        }
    }

    #[class]
    struct Handle;

    #[class]
    impl Handle {
        /// Its next bytes, later.
        pub(crate) fn next(&self, sys: System, size: Option<u32>) -> Later<Option<Vec<u8>>> {
            let _ = (sys, size);
            Later::new(async { Ok::<_, String>(None) })
        }

        /// Itself, for chaining.
        #[overload(fn(event: String, #[args(index, label)] f: Callback<(u32, String)>) -> Instance<Handle>)]
        pub(crate) fn on(this: Instance<Self>, event: String, cx: CallCx<'_>) -> Instance<Self> {
            let _ = (event, cx);
            this
        }
    }

    #[test]
    fn bytes_are_uint8_arrays_tasks_promises_and_the_system_no_parameter() {
        let mut registry = Registry::ui_set("test/system");
        registry.module::<Files>().class::<Handle>();
        let d = declarations(&registry, &[]);
        assert!(
            d.contains("function read(path: string): Promise<Uint8Array>;"),
            "{d}"
        );
        assert!(
            d.contains("function write(bytes: Uint8Array): number;"),
            "{d}"
        );
        assert!(
            d.contains("next(size?: number | null): Promise<Uint8Array | null>;"),
            "{d}"
        );
        assert!(d.contains("function watch(path: string): void;"), "{d}");
        assert!(
            d.contains("  on(event: string, f: (index: number, label: string) => void): Handle;"),
            "{d}"
        );
        // A getter is no flat export.
        assert!(!d.contains("function root"), "{d}");
    }

    #[test]
    fn bytes_convert_from_and_to_js() {
        let host = json_host::JsonHost::default();
        let raw = host.value(serde_json::json!([0, 7, 255]));
        let bytes = <Vec<u8>>::from_js(crate::element::JsIn::new(&host, raw)).unwrap();
        assert_eq!(bytes, [0, 7, 255]);
        let out = bytes.to_js(&host).unwrap();
        assert_eq!(host.read(out), Some(serde_json::json!([0, 7, 255])));
        let bad = host.value(JsonValue::from("x"));
        assert!(<Vec<u8>>::from_js(crate::element::JsIn::new(&host, bad)).is_err());
    }

    #[derive(Debug, JsObject)]
    #[prop(exact)]
    struct Options {
        recursive: Option<bool>,
        #[prop(skip_none)]
        note: Option<String>,
    }

    #[test]
    fn times_are_dates_and_exact_objects_refuse_other_keys() {
        let host = json_host::JsonHost::default();
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1500);
        let out = time.to_js(&host).unwrap();
        assert_eq!(host.read(out), Some(serde_json::json!({ "$date": 1500.0 })));
        let date = host.value(serde_json::json!({ "$date": -250.0 }));
        let back = std::time::SystemTime::from_js(crate::element::JsIn::new(&host, date)).unwrap();
        assert_eq!(
            std::time::UNIX_EPOCH
                .duration_since(back)
                .unwrap()
                .as_millis(),
            250
        );
        let options = host.value(serde_json::json!({ "recursive": true }));
        let options = Options::from_js(crate::element::JsIn::new(&host, options)).unwrap();
        assert_eq!(options.recursive, Some(true));
        let shown = Options {
            recursive: None,
            note: None,
        }
        .to_js(&host)
        .unwrap();
        assert_eq!(
            host.read(shown),
            Some(serde_json::json!({ "recursive": null }))
        );
        let typo = host.value(serde_json::json!({ "recursive": true, "typo": 1 }));
        let error = Options::from_js(crate::element::JsIn::new(&host, typo)).unwrap_err();
        assert_eq!(error.0, "unknown field `typo`");
    }

    #[test]
    fn errors_carry_node_s_codes_thrown_and_rejected() {
        use super::{ErrorClass, JsError, io_code};
        use crate::element::{IntoThrown, Thrown};
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(io_code(&missing), Some("ENOENT"));
        #[cfg(unix)]
        assert_eq!(
            io_code(&std::io::Error::from_raw_os_error(libc::ELOOP)),
            Some("ELOOP")
        );
        assert_eq!(io_code(&std::io::Error::other("x")), None);
        let error = JsError::Type("denied".into())
            .with_code("EPERM")
            .with_code("EACCES")
            .with("path", "a.txt");
        assert_eq!((error.message(), error.code()), ("denied", Some("EACCES")));
        let Thrown::Fields(fields) = error.clone().into_thrown() else {
            panic!("fields go with the error");
        };
        assert_eq!(fields.class, ErrorClass::Type);
        assert_eq!(fields.fields.len(), 2);
        assert_eq!(JsError::from(missing).code(), Some("ENOENT"));
        // A task's `Err(JsError)` rejects with the same.
        let later = super::Later::<u32>::new(async { Err::<u32, _>(error) });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let Err(Thrown::Fields(rejected)) = runtime.block_on(later.into_future()) else {
            panic!("a rejection with fields");
        };
        assert_eq!(rejected.field("path"), Some(&serde_json::json!("a.txt")));
        // Any other error rejects with its message.
        let later = super::Later::<u32>::new(async { Err::<u32, _>("plain") });
        assert!(matches!(
            runtime.block_on(later.into_future()),
            Err(Thrown::Error(m)) if m == "plain"
        ));
    }

    #[test]
    fn quotas_count_what_is_held() {
        let quotas = super::Quotas::default();
        let a = quotas.take("k", 2).unwrap();
        let _b = quotas.take("k", 2).unwrap();
        assert!(quotas.take("k", 2).is_none());
        drop(a);
        assert_eq!(quotas.held("k"), 1);
        assert!(quotas.take("other", 1).is_some());
    }

    #[test]
    fn quotas_reserve_amounts_up_to_their_limit() {
        let quotas = super::Quotas::default();
        let a = quotas.reserve("bytes", 40, 64).unwrap();
        assert!(quotas.reserve("bytes", 25, 64).is_none());
        let b = quotas.reserve("bytes", 24, 64).unwrap();
        assert_eq!((quotas.held("bytes"), a.amount()), (64, 40));
        assert!(quotas.reserve("bytes", usize::MAX, usize::MAX).is_none());
        drop(a);
        assert_eq!(quotas.held("bytes"), 24);
        drop(b);
        assert!(quotas.reserve("bytes", 64, 64).is_some());
    }
}
