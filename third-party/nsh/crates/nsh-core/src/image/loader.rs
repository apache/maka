//! The image loader the native backends share (L1–L3 of
//! `docs/dev/image-loading-design.md`): where an image's bytes are, one load
//! per source in flight, the pools that read and decode them, and the small
//! cache of encoded bytes.
//!
//! - **Locations**: an `http(s)` URL, a file, an `asset:/` URI (a file or the
//!   dev server's URL by the surface's [`AssetBase`], or the engine's
//!   reader), or bytes in memory (a `data:` URI, a blob). One source key
//!   names a location everywhere ([`Location::key`]).
//! - **Dedup**: one read per source key in flight; later requests wait on it.
//! - **Pools**: reads and downloads ([`DOWNLOADS`] at once, [`PER_HOST`] to
//!   one host) apart from decodes ([`decoders`]), so a slow network never
//!   holds a decode. Both take the highest [`Priority`] first.
//! - **Cancellation**: dropping a [`Ticket`] stops waiting; a load nobody
//!   waits for any more is dropped from its queue, or stops between two
//!   chunks of its download.
//! - **Limits**: [`MAX_BYTES`] a response, a minute a request,
//!   [`MAX_REDIRECTS`] redirects, each checked against the app's access
//!   policy and never from `https` to `http` ([`redirect`]).
//! - **Transport**: downloads go through ureq (feature `loader`), or a
//!   backend's own [`Transport`] (macOS: `NSURLSession`, for the system's
//!   proxies, authentication and App Transport Security), which follows the
//!   same limits; the loader keeps the policy around it.
//! - **Failures** are remembered for [`FAILURE_TTL`]: a broken URL in a list
//!   is not fetched again for every row.
//! - **L3**: the last bytes read ([`ENCODED_BYTES`]) stay, so a decode at
//!   another size, an SVG parsed again or `Image.getSize` reads nothing
//!   again. An entry over a quarter of it is not kept.
//!
//! [`super::Images`] adds the decoded images (L4, [`super::MemoryCache`]) on top.
//!
//! Callbacks run on the pools' threads: a backend hands their results to
//! its main thread.

use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
    path::PathBuf,
    sync::{
        Arc, Condvar, LazyLock, Mutex, MutexGuard, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use super::{DiskCache, ImageData};
use crate::{ImageSource, access::Access};

/// Downloads and reads at once.
pub const DOWNLOADS: usize = 6;

/// Downloads to one host at once.
pub const PER_HOST: usize = 4;

/// The largest HTTP response body read.
pub const MAX_BYTES: u64 = 64 << 20;

/// How long a request may take, start to end.
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// Redirects followed at most (as `fetch`).
pub const MAX_REDIRECTS: usize = 20;

/// How long a failed read is remembered.
pub const FAILURE_TTL: Duration = Duration::from_secs(30);

/// The encoded bytes kept in memory (L3).
pub const ENCODED_BYTES: usize = if cfg!(any(target_os = "ios", target_os = "android")) {
    16 << 20
} else {
    32 << 20
};

/// Progress reports at most this often (a download reports its end too).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Decoder threads: one core is left to the main thread, at most 4.
pub fn decoders() -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    cores.saturating_sub(1).clamp(1, 4)
}

/// Where a surface's bundled (`asset:/…`) files are.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AssetBase {
    /// Served over HTTP (the dev server): `http://host:port/assets/`.
    Http(String),
    /// A directory on disk.
    Directory(PathBuf),
    /// Directories on disk, looked in in order: a file is the first
    /// directory's that has it (the app's own files, then an embedding
    /// app's, say).
    Directories(Vec<PathBuf>),
}

impl AssetBase {
    /// The file of `path` (relative, `/`-separated) on disk: in the first
    /// of [`AssetBase::Directories`] that has it, else in the first (where
    /// reading it fails, naming that path). `None` over HTTP.
    pub fn file(&self, path: &str) -> Option<PathBuf> {
        match self {
            AssetBase::Http(_) => None,
            AssetBase::Directory(dir) => Some(dir.join(path)),
            AssetBase::Directories(dirs) => {
                let mut files = dirs.iter().map(|dir| dir.join(path));
                let first = files.next()?;
                if first.exists() {
                    return Some(first);
                }
                Some(files.find(|file| file.exists()).unwrap_or(first))
            }
        }
    }
}

type AssetReader = dyn Fn(&str) -> Result<Vec<u8>, String> + Send + Sync;

/// Reads an `asset:/…` URI for [`Context::read_asset`]: blocking.
/// Clones share its identity; a new reader has its own cache entries.
#[derive(Clone)]
pub struct ReadAsset {
    id: u64,
    read: Arc<AssetReader>,
}

impl ReadAsset {
    /// Creates a reader with its own cache identity.
    pub fn new(read: impl Fn(&str) -> Result<Vec<u8>, String> + Send + Sync + 'static) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            read: Arc::new(read),
        }
    }
}

/// What a surface's loads go through.
#[derive(Clone, Default)]
pub struct Context {
    /// Where `asset:/` URIs resolve.
    pub asset_base: Option<AssetBase>,
    /// Reads `asset:/` URIs when there is no base.
    pub read_asset: Option<ReadAsset>,
    /// What the app may load, for the redirects.
    pub access: Arc<Access>,
    /// The disk cache remote images go through.
    pub disk: Option<DiskCache>,
    /// How remote images download: `None`, the process's
    /// ([`set_transport`]), else ureq.
    pub transport: Option<Arc<dyn Transport>>,
}

/// One download a [`Transport`] makes.
pub struct Get<'a> {
    /// What it fetches.
    pub url: &'a str,
    /// A revalidation's conditions (`If-None-Match`, `If-Modified-Since`).
    pub headers: &'a [(&'static str, String)],
    /// The disk cache answers for this URL: a cache of the transport's own
    /// must not.
    pub cached: bool,
    /// What the app may load: every redirect is checked ([`redirect`]).
    pub access: &'a Access,
    /// Set when nobody waits for it any more: it stops.
    pub cancelled: &'a AtomicBool,
    /// Called with the bytes so far and the size (0: unknown).
    pub progress: &'a mut dyn FnMut(u64, u64),
}

/// How a backend downloads remote images, when it has a stack of its own.
/// The loader keeps the policy around it (one download per source,
/// priorities, cancellation, the disk cache, failures remembered, the size
/// checked again).
pub trait Transport: Send + Sync {
    /// GETs `get.url` (blocking, on a loader thread). Every status is a
    /// response (the disk cache decides what a `304` or a `5xx` means). It
    /// follows at most [`MAX_REDIRECTS`] redirects, each one [`redirect`]
    /// grants; reads at most [`MAX_BYTES`]; gives up after [`TIMEOUT`];
    /// stops soon after `get.cancelled` is set.
    fn get(&self, get: Get<'_>) -> Result<super::Fetched, String>;
}

static TRANSPORT: OnceLock<Arc<dyn Transport>> = OnceLock::new();

/// Makes `transport` the process's, for the contexts that name none (the
/// engine's `svg()` loads too). Only the first call counts.
pub fn set_transport(transport: Arc<dyn Transport>) {
    let _ = TRANSPORT.set(transport);
}

/// The next hop of a redirect from `url` to `location` (relative or
/// absolute): granted by `access`, and never from `https` down to `http`.
pub fn redirect(access: &Access, url: &str, location: &str) -> Result<String, String> {
    let next = access.media_redirect(url, location)?;
    if url.starts_with("https://") && !next.starts_with("https://") {
        return Err(format!("redirect from https to `{next}` refused"));
    }
    Ok(next)
}

impl std::fmt::Debug for Context {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Context")
            .field("asset_base", &self.asset_base)
            .field("read_asset", &self.read_asset.is_some())
            .field("disk", &self.disk)
            .field("transport", &self.transport.is_some())
            .finish_non_exhaustive()
    }
}

impl Context {
    /// Where `source`'s bytes are: in the source (a `data:` URI, a blob),
    /// or where its URI points.
    pub fn locate(&self, source: &ImageSource) -> Option<Location> {
        match &source.data {
            Some(data) => Some(Location::Memory(source.uri.clone(), data.clone())),
            None => self.resolve(&source.uri),
        }
    }

    /// Where `uri` points ([`resolve`]); an `asset:/` URI with no base,
    /// through [`Self::read_asset`].
    pub fn resolve(&self, uri: &str) -> Option<Location> {
        if uri.starts_with("asset:/")
            && self.asset_base.is_none()
            && let Some(read) = &self.read_asset
        {
            return Some(Location::Asset(uri.to_owned(), read.clone()));
        }
        resolve(uri, self.asset_base.as_ref())
    }
}

thread_local! {
    /// What the core's own loads on this thread (its engine's) go through.
    static CONTEXT: std::cell::RefCell<Context> = std::cell::RefCell::default();
}

/// Sets what the core's own loads on this thread go through
/// ([`crate::core::Core::set_image_context`]).
pub(crate) fn set_context(context: Context) {
    CONTEXT.set(context);
}

/// What the core's own loads on this thread go through.
#[cfg(feature = "svg")]
pub(crate) fn context() -> Context {
    CONTEXT.with_borrow(Context::clone)
}

/// Where an image's bytes are.
#[derive(Clone)]
pub enum Location {
    /// `http(s)://`.
    Url(String),
    /// A file.
    File(PathBuf),
    /// A `data:` URI's bytes, decoded when it is read.
    Data(String),
    /// Bytes in memory (a decoded `data:` URI, a blob), by the source's
    /// URI.
    Memory(Arc<str>, ImageData),
    /// An `asset:/` URI the engine reads.
    Asset(String, ReadAsset),
}

impl std::fmt::Debug for Location {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Location::Url(url) => f.debug_tuple("Url").field(url).finish(),
            Location::File(path) => f.debug_tuple("File").field(path).finish(),
            Location::Data(uri) => f.debug_tuple("Data").field(&uri.len()).finish(),
            Location::Memory(uri, _) => f.debug_tuple("Memory").field(uri).finish(),
            Location::Asset(uri, _) => f.debug_tuple("Asset").field(uri).finish(),
        }
    }
}

impl PartialEq for Location {
    fn eq(&self, other: &Self) -> bool {
        self.key() == other.key()
    }
}

impl Location {
    /// The source key: the same location is the same image, whatever URI
    /// named it.
    pub fn key(&self) -> String {
        match self {
            Location::Url(url) => url.clone(),
            Location::File(path) => format!("file://{}", path.display()),
            Location::Data(uri) => uri.clone(),
            Location::Memory(uri, _) => format!("inline:{uri}"),
            // An engine's reader resolves for that engine's app alone.
            Location::Asset(uri, read) => format!("{uri}#{}", read.id),
        }
    }

    /// The URI's file name density (`logo@2x.png` → 2; 1 without).
    pub fn density(&self) -> f32 {
        match self {
            Location::Url(uri) | Location::Asset(uri, _) => density(uri),
            Location::File(path) => density(&path.to_string_lossy()),
            Location::Data(_) | Location::Memory(..) => 1.0,
        }
    }

    /// The host a download goes to, for the per-host limit.
    fn host(&self) -> String {
        match self {
            Location::Url(url) => {
                crate::access::parse_url(url).map_or_else(String::new, |u| u.host)
            }
            _ => String::new(),
        }
    }

    /// Whether its bytes are already in memory (never kept in L3).
    fn in_memory(&self) -> bool {
        matches!(self, Location::Memory(..) | Location::Data(_))
    }
}

/// Resolves `uri`: `asset:/…` against `base`, `http(s)://`, `file://`, an
/// absolute path, `data:`.
pub fn resolve(uri: &str, base: Option<&AssetBase>) -> Option<Location> {
    if let Some(path) = uri.strip_prefix("asset:/") {
        let path = path.trim_start_matches('/');
        return match base? {
            AssetBase::Http(base) => {
                let sep = if base.ends_with('/') { "" } else { "/" };
                Some(Location::Url(format!("{base}{sep}{path}")))
            }
            dirs => dirs.file(path).map(Location::File),
        };
    }
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return Some(Location::Url(uri.to_owned()));
    }
    if uri.starts_with("data:") {
        return Some(Location::Data(uri.to_owned()));
    }
    if uri.starts_with("file:") {
        return url::Url::parse(uri)
            .ok()?
            .to_file_path()
            .ok()
            .map(Location::File);
    }
    let path = std::path::Path::new(uri);
    path.is_absolute().then(|| Location::File(path.into()))
}

/// `logo@2x.png` -> 2: the pixel density a file name declares (1 without).
pub fn density(uri: &str) -> f32 {
    let name = uri.rsplit(['/', '\\']).next().unwrap_or(uri);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.rsplit_once('@')
        .and_then(|(_, s)| s.strip_suffix('x'))
        .and_then(|n| n.parse::<f32>().ok())
        .filter(|n| *n > 0.0)
        .unwrap_or(1.0)
}

/// Which loads go first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum Priority {
    /// Loading ahead (`Image.prefetch`): last.
    Prefetch,
    /// Everything else.
    #[default]
    Normal,
    /// For a view on screen: first.
    Visible,
}

/// Called with a download's bytes so far and its size (0: unknown).
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;

/// Called with a read's bytes, or why there are none.
pub type BytesDone = Box<dyn FnOnce(Result<ImageData, String>) + Send>;

/// A request's hold on its load: dropping it stops waiting (and cancels
/// the load when nobody else waits for it). [`Ticket::detach`] keeps the
/// load and its callback.
#[must_use = "dropping a ticket cancels its load"]
#[derive(Default)]
pub struct Ticket {
    cancel: Option<Box<dyn FnOnce() + Send>>,
    pub(super) reprioritize: Option<Arc<dyn Fn(Priority) + Send + Sync>>,
}

impl std::fmt::Debug for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.cancel.is_some() {
            "Ticket"
        } else {
            "Ticket(done)"
        })
    }
}

impl Ticket {
    /// A ticket of a request that already ended.
    pub fn done() -> Self {
        Ticket::default()
    }

    pub(super) fn new(
        cancel: impl FnOnce() + Send + 'static,
        reprioritize: Option<Arc<dyn Fn(Priority) + Send + Sync>>,
    ) -> Self {
        Ticket {
            cancel: Some(Box::new(cancel)),
            reprioritize,
        }
    }

    /// Lets the load run to its end, callback included.
    pub fn detach(mut self) {
        self.cancel = None;
    }

    /// Moves the load to `priority` while it waits (a view scrolled into
    /// or out of sight).
    pub fn set_priority(&self, priority: Priority) {
        if let Some(f) = &self.reprioritize {
            f(priority);
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
    }
}

/// The loader of the process ([`loader`]).
pub struct Loader {
    reads: Mutex<Reads>,
    ready: Condvar,
    decodes: Mutex<BinaryHeap<Decode>>,
    decode_ready: Condvar,
    encoded: Mutex<Encoded>,
    failures: Mutex<HashMap<String, (Instant, String)>>,
    started: OnceLock<()>,
    seq: AtomicU64,
}

/// The loader the process shares (its threads start on first use).
pub fn loader() -> &'static Loader {
    static LOADER: LazyLock<Loader> = LazyLock::new(Loader::default);
    &LOADER
}

impl Default for Loader {
    fn default() -> Self {
        Loader {
            reads: Mutex::default(),
            ready: Condvar::new(),
            decodes: Mutex::default(),
            decode_ready: Condvar::new(),
            encoded: Mutex::new(Encoded::new(ENCODED_BYTES)),
            failures: Mutex::default(),
            started: OnceLock::new(),
            seq: AtomicU64::new(0),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The reads in flight and waiting.
#[derive(Default)]
struct Reads {
    jobs: HashMap<String, ReadJob>,
    /// Running reads per host.
    hosts: HashMap<String, usize>,
    running: usize,
    /// Read waiters added so far (their ids).
    waiters: u64,
}

struct ReadJob {
    location: Location,
    context: Context,
    host: String,
    priority: Priority,
    /// Its place among equal priorities.
    seq: u64,
    running: bool,
    cancelled: Arc<AtomicBool>,
    waiters: Vec<ReadWaiter>,
}

struct ReadWaiter {
    id: u64,
    priority: Priority,
    done: BytesDone,
    progress: Option<Progress>,
}

impl ReadJob {
    fn reprioritize(&mut self) {
        self.priority = self
            .waiters
            .iter()
            .map(|w| w.priority)
            .max()
            .unwrap_or_default();
    }
}

/// A decode waiting for a thread.
struct Decode {
    priority: Priority,
    seq: Reverse<u64>,
    cancelled: Arc<AtomicBool>,
    run: Box<dyn FnOnce() + Send>,
}

impl PartialEq for Decode {
    fn eq(&self, other: &Self) -> bool {
        (self.priority, self.seq) == (other.priority, other.seq)
    }
}
impl Eq for Decode {}
impl PartialOrd for Decode {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Decode {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.priority, self.seq).cmp(&(other.priority, other.seq))
    }
}

impl Loader {
    fn start(&'static self) {
        self.started.get_or_init(|| {
            for i in 0..DOWNLOADS {
                spawn_thread(format!("nsh-image-io-{i}"), move || self.read_loop());
            }
            for i in 0..decoders() {
                spawn_thread(format!("nsh-image-decode-{i}"), move || self.decode_loop());
            }
        });
    }

    /// Reads `location`'s bytes through `context` and calls `done` with
    /// them (on a loader thread, or here when they are in memory, in L3 or
    /// failed recently); `progress` hears a download's progress.
    pub fn read(
        &'static self,
        location: Location,
        context: &Context,
        priority: Priority,
        progress: Option<Progress>,
        done: BytesDone,
    ) -> Ticket {
        let key = location.key();
        if let Location::Memory(_, data) = &location {
            done(Ok(data.clone()));
            return Ticket::done();
        }
        if let Some(bytes) = self.encoded(&key) {
            done(Ok(bytes));
            return Ticket::done();
        }
        if let Some(error) = self.failed(&key) {
            done(Err(error));
            return Ticket::done();
        }
        self.start();
        let mut reads = lock(&self.reads);
        // A read of the key may have ended since: it kept its bytes (or its
        // failure) before it left the jobs.
        if !reads.jobs.contains_key(&key) {
            let ended = match self.encoded(&key) {
                Some(bytes) => Some(Ok(bytes)),
                None => self.failed(&key).map(Err),
            };
            if let Some(result) = ended {
                drop(reads);
                done(result);
                return Ticket::done();
            }
        }
        reads.waiters += 1;
        let id = reads.waiters;
        let waiter = ReadWaiter {
            id,
            priority,
            done,
            progress,
        };
        // A read given up on may still be running: a new one replaces it.
        let live = reads
            .jobs
            .get(&key)
            .is_some_and(|j| !j.cancelled.load(Ordering::Relaxed));
        if live && let Some(job) = reads.jobs.get_mut(&key) {
            job.waiters.push(waiter);
            job.reprioritize();
        } else {
            let seq = self.seq.fetch_add(1, Ordering::Relaxed);
            reads.jobs.insert(
                key.clone(),
                ReadJob {
                    host: location.host(),
                    location,
                    context: context.clone(),
                    priority,
                    seq,
                    running: false,
                    cancelled: Arc::default(),
                    waiters: vec![waiter],
                },
            );
            drop(reads);
            self.ready.notify_all();
            return self.read_ticket(key, id);
        }
        drop(reads);
        self.read_ticket(key, id)
    }

    fn read_ticket(&'static self, key: String, id: u64) -> Ticket {
        let reprioritize = {
            let key = key.clone();
            Arc::new(move |priority: Priority| {
                let mut reads = lock(&self.reads);
                if let Some(job) = reads.jobs.get_mut(&key) {
                    if let Some(w) = job.waiters.iter_mut().find(|w| w.id == id) {
                        w.priority = priority;
                    }
                    job.reprioritize();
                }
            }) as Arc<dyn Fn(Priority) + Send + Sync>
        };
        Ticket {
            cancel: Some(Box::new(move || self.stop_waiting(&key, id))),
            reprioritize: Some(reprioritize),
        }
    }

    /// Waiter `id` of `key`'s read gave up: a read nobody waits for goes.
    fn stop_waiting(&self, key: &str, id: u64) {
        let mut reads = lock(&self.reads);
        let Some(job) = reads.jobs.get_mut(key) else {
            return;
        };
        job.waiters.retain(|w| w.id != id);
        job.reprioritize();
        if !job.waiters.is_empty() {
            return;
        }
        job.cancelled.store(true, Ordering::Relaxed);
        if !job.running {
            reads.jobs.remove(key);
        }
    }

    /// A read thread: takes the next read the limits allow, highest
    /// priority first.
    fn read_loop(&'static self) {
        loop {
            let (key, seq, host, location, context, cancelled) = {
                let mut reads = lock(&self.reads);
                loop {
                    if let Some(key) = next_read(&reads) {
                        let job = reads.jobs.get_mut(&key).expect("picked");
                        job.running = true;
                        let host = job.host.clone();
                        let picked = (
                            key,
                            job.seq,
                            host.clone(),
                            job.location.clone(),
                            job.context.clone(),
                            job.cancelled.clone(),
                        );
                        reads.running += 1;
                        *reads.hosts.entry(host).or_default() += 1;
                        break picked;
                    }
                    reads = self.ready.wait(reads).unwrap_or_else(|e| e.into_inner());
                }
            };
            let mut last: Option<Instant> = None;
            let mut report = |loaded: u64, total: u64| {
                let now = Instant::now();
                let done = total > 0 && loaded >= total;
                if !(done || last.is_none_or(|t| now - t >= PROGRESS_INTERVAL)) {
                    return;
                }
                last = Some(now);
                let listeners: Vec<Progress> = lock(&self.reads)
                    .jobs
                    .get(&key)
                    .map(|j| {
                        j.waiters
                            .iter()
                            .filter_map(|w| w.progress.clone())
                            .collect()
                    })
                    .unwrap_or_default();
                for p in listeners {
                    p(loaded, total);
                }
            };
            let result = read(&location, &context, &cancelled, &mut report);
            // Kept before the job ends: a request arriving meanwhile finds
            // the bytes (or the failure) rather than reading again.
            match &result {
                Ok(bytes) if !location.in_memory() => self.keep_encoded(&key, bytes),
                Err(error) if !cancelled.load(Ordering::Relaxed) => {
                    lock(&self.failures).insert(key.clone(), (Instant::now(), error.clone()));
                }
                _ => {}
            }
            let waiters = {
                let mut reads = lock(&self.reads);
                reads.running -= 1;
                if let Some(n) = reads.hosts.get_mut(&host) {
                    *n -= 1;
                    if *n == 0 {
                        reads.hosts.remove(&host);
                    }
                }
                // Unless a new read of the key replaced this one.
                let ours = reads.jobs.get(&key).is_some_and(|j| j.seq == seq);
                let job = ours.then(|| reads.jobs.remove(&key)).flatten();
                job.map(|j| j.waiters).unwrap_or_default()
            };
            self.ready.notify_all();
            if cancelled.load(Ordering::Relaxed) {
                continue;
            }
            for w in waiters {
                (w.done)(result.clone());
            }
        }
    }

    /// Runs `job` on a decode thread, highest priority first, unless the
    /// ticket is dropped before it starts.
    pub fn decode(
        &'static self,
        priority: Priority,
        job: impl FnOnce() + Send + 'static,
    ) -> Ticket {
        self.start();
        let cancelled = Arc::new(AtomicBool::new(false));
        let seq = Reverse(self.seq.fetch_add(1, Ordering::Relaxed));
        lock(&self.decodes).push(Decode {
            priority,
            seq,
            cancelled: cancelled.clone(),
            run: Box::new(job),
        });
        self.decode_ready.notify_one();
        Ticket::new(move || cancelled.store(true, Ordering::Relaxed), None)
    }

    fn decode_loop(&'static self) {
        loop {
            let job = {
                let mut queue = lock(&self.decodes);
                loop {
                    match queue.pop() {
                        Some(job) if job.cancelled.load(Ordering::Relaxed) => continue,
                        Some(job) => break job,
                        None => {
                            queue = self
                                .decode_ready
                                .wait(queue)
                                .unwrap_or_else(|e| e.into_inner());
                        }
                    }
                }
            };
            (job.run)();
        }
    }

    /// `key`'s bytes, when L3 has them.
    pub fn encoded(&self, key: &str) -> Option<ImageData> {
        lock(&self.encoded).get(key)
    }

    fn keep_encoded(&self, key: &str, bytes: &ImageData) {
        lock(&self.encoded).insert(key, bytes.clone());
    }

    /// Why `key` failed, if it did in the last [`FAILURE_TTL`].
    fn failed(&self, key: &str) -> Option<String> {
        let mut failures = lock(&self.failures);
        let (when, error) = failures.get(key)?;
        if when.elapsed() < FAILURE_TTL {
            return Some(error.clone());
        }
        failures.remove(key);
        None
    }

    /// Forgets the encoded bytes and failures it keeps (memory pressure, a
    /// "clear cache").
    pub fn clear(&self) {
        lock(&self.encoded).clear();
        lock(&self.failures).clear();
    }
}

/// The read to start next: the highest priority (the oldest of equals)
/// whose host has room, when a thread is free.
fn next_read(reads: &Reads) -> Option<String> {
    if reads.running >= DOWNLOADS {
        return None;
    }
    reads
        .jobs
        .iter()
        .filter(|(_, j)| !j.running && !j.cancelled.load(Ordering::Relaxed))
        .filter(|(_, j)| {
            j.host.is_empty() || reads.hosts.get(&j.host).copied().unwrap_or(0) < PER_HOST
        })
        .max_by_key(|(_, j)| (j.priority, Reverse(j.seq)))
        .map(|(k, _)| k.clone())
}

fn spawn_thread(name: String, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name).spawn(f) {
        log::error!("cannot start an image loader thread: {e}");
    }
}

/// Reads `location`'s bytes (blocking): `progress(loaded, total)` hears a
/// download; it stops when `cancelled` is set.
fn read(
    location: &Location,
    context: &Context,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<ImageData, String> {
    match location {
        Location::File(path) => std::fs::read(path)
            .map(ImageData::from)
            .map_err(|e| format!("{}: {e}", path.display())),
        Location::Data(uri) => super::decode_data_uri(uri).map(|(_, bytes)| bytes.into()),
        Location::Memory(_, data) => Ok(data.clone()),
        Location::Asset(uri, read) => (read.read)(uri).map(ImageData::from),
        Location::Url(url) => {
            fetch(url, context, cancelled, progress).map_err(|e| format!("{url}: {e}"))
        }
    }
}

/// Reads `location`'s bytes here and now (blocking; the engine's bundled
/// fonts), through L3 but no queue.
pub fn read_now(location: &Location, context: &Context) -> Result<ImageData, String> {
    if let Some(bytes) = loader().encoded(&location.key()) {
        return Ok(bytes);
    }
    read(location, context, &AtomicBool::new(false), &mut |_, _| {})
}

fn fetch(
    url: &str,
    context: &Context,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<ImageData, String> {
    let cached = context.disk.is_some();
    let mut get = |headers: &[(&'static str, String)]| {
        download(url, context, headers, cached, cancelled, progress)
    };
    match &context.disk {
        Some(cache) => cache.load(url, get),
        None => get(&[]).and_then(|response| match response.status {
            200..=299 => Ok(response.body.into()),
            status => Err(format!("HTTP {status}")),
        }),
    }
}

/// GETs `url` with the context's transport (the process's, else ureq), its
/// limits checked again.
fn download(
    url: &str,
    context: &Context,
    headers: &[(&'static str, String)],
    cached: bool,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<super::Fetched, String> {
    let transport = context.transport.as_ref().or(TRANSPORT.get());
    let fetched = match transport {
        Some(transport) => transport.get(Get {
            url,
            headers,
            cached,
            access: &context.access,
            cancelled,
            progress,
        }),
        None => ureq_download(url, &context.access, headers, cancelled, progress),
    }?;
    if cancelled.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if fetched.body.len() as u64 > MAX_BYTES {
        return Err(format!("larger than {MAX_BYTES} bytes"));
    }
    Ok(fetched)
}

#[cfg(feature = "loader")]
fn ureq_download(
    url: &str,
    access: &Access,
    headers: &[(&'static str, String)],
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<super::Fetched, String> {
    http::download(url, access, headers, cancelled, progress)
}

#[cfg(not(feature = "loader"))]
fn ureq_download(
    _url: &str,
    _access: &Access,
    _headers: &[(&'static str, String)],
    _cancelled: &AtomicBool,
    _progress: &mut dyn FnMut(u64, u64),
) -> Result<super::Fetched, String> {
    Err("this build has no transport for remote images".into())
}

#[cfg(feature = "loader")]
mod http {
    use std::{
        io::Read,
        sync::{OnceLock, atomic::AtomicBool},
    };

    use super::{MAX_BYTES, MAX_REDIRECTS, TIMEOUT, redirect};
    use crate::{
        access::Access,
        image::{CacheHeaders, Fetched},
    };

    /// The HTTP agent all downloads share. It never follows redirects: each
    /// hop is checked before it is requested.
    fn agent() -> &'static ureq::Agent {
        static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
        AGENT.get_or_init(|| {
            ureq::Agent::config_builder()
                .timeout_global(Some(TIMEOUT))
                .http_status_as_error(false)
                .max_redirects(0)
                .max_redirects_will_error(false)
                .build()
                .into()
        })
    }

    /// GETs `url` with `headers`, following redirects one hop at a time.
    fn get(
        url: &str,
        access: &Access,
        headers: &[(&'static str, String)],
    ) -> Result<ureq::http::Response<ureq::Body>, String> {
        let mut url = url.to_owned();
        for _ in 0..=MAX_REDIRECTS {
            let mut request = agent().get(&url);
            for (name, value) in headers {
                request = request.header(*name, value);
            }
            let response = request.call().map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            if !matches!(status, 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("{url}: redirect without a Location"))?;
            url = redirect(access, &url, location)?;
        }
        Err("too many redirects".to_owned())
    }

    /// GETs `url` and reads its body as it arrives (at most [`MAX_BYTES`],
    /// stopping when `cancelled` is set). Every status is a response: the
    /// disk cache decides what a `304` or a `5xx` means.
    pub(super) fn download(
        url: &str,
        access: &Access,
        headers: &[(&'static str, String)],
        cancelled: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<Fetched, String> {
        let mut response = get(url, access, headers)?;
        let status = response.status().as_u16();
        let cache = CacheHeaders::from_lookup(|name| {
            let values: Vec<&str> = response
                .headers()
                .get_all(name)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect();
            (!values.is_empty()).then(|| values.join(", "))
        });
        if status >= 300 {
            return Ok(Fetched::new(status, cache, Vec::new()));
        }
        let total = response.body().content_length().unwrap_or(0);
        if total > MAX_BYTES {
            return Err(format!("larger than {MAX_BYTES} bytes"));
        }
        let mut reader = response.body_mut().with_config().limit(MAX_BYTES).reader();
        let mut bytes = Vec::with_capacity(total as usize);
        let mut chunk = [0u8; 16 << 10];
        loop {
            if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = reader.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
            progress(bytes.len() as u64, total);
        }
        Ok(Fetched::new(status, cache, bytes))
    }
}

/// The encoded bytes kept in memory (L3): least recently used out first.
struct Encoded {
    limit: usize,
    used: usize,
    clock: u64,
    entries: HashMap<String, (ImageData, u64)>,
}

impl Encoded {
    fn new(limit: usize) -> Self {
        Encoded {
            limit,
            used: 0,
            clock: 0,
            entries: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<ImageData> {
        self.clock += 1;
        let (bytes, used) = self.entries.get_mut(key)?;
        *used = self.clock;
        Some(bytes.clone())
    }

    fn insert(&mut self, key: &str, bytes: ImageData) {
        let size = bytes.len();
        if size > self.limit / 4 {
            return;
        }
        self.clock += 1;
        if let Some((old, _)) = self.entries.insert(key.to_owned(), (bytes, self.clock)) {
            self.used -= old.len();
        }
        self.used += size;
        // A few hundred entries at most: a scan for the oldest beats an
        // ordered index kept up to date on every hit.
        while self.used > self.limit {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((bytes, _)) = self.entries.remove(&oldest) {
                self.used -= bytes.len();
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.used = 0;
    }
}

#[cfg(test)]
mod tests;
