//! `<Image>`: loading (`asset:/`, files, HTTP, `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding with
//! ImageIO off the main thread, and showing the result in an image sublayer
//! of the view ([`crate::decor`]).
//!
//! Bytes are fetched once per location (NSURLSession downloads report
//! `onProgress` at most every 100ms; files and `data:` URIs are read on a
//! global dispatch queue), then decoded on a global queue: downsampled to
//! the view's size in pixels (ImageIO thumbnails), blurred (`blurRadius`,
//! `blur()`) and passed through the color matrix of the view's other
//! filters ([`crate::blur`]). Decoded images live in a main-thread cache
//! keyed by location and look, bounded by bytes (least recently used go
//! first); concurrent requests for one key share one load.
//! `Image.getSize` / `prefetch` read only the header and keep the bytes for
//! the views that show the image next.
//!
//! A view decodes once its frame is known: the core sends the image before
//! the frame, so [`set`] waits for [`crate::decor::apply`] to see a size
//! (or the next display frame, for views that stay empty).
//!
//! SVG images (sniffed from their bytes) are drawn by
//! [`nsh_core::svg`] at the view's size in pixels (at its natural size, at
//! the backing scale), then go through the same blur, color matrix, tint
//! and cache as decoded bitmaps; their size is their intrinsic size in
//! points (CSS pixels of the SVG). Canvases draw bitmaps only.
//!
//! Animated GIF / PNG / WebP images play through a keyframe animation of the
//! layer's `contents`. The `placeholder` shows until the image arrives (and
//! stays on error); an image that had to load fades in over `fadeDuration`
//! (default 0, as iOS).

use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use dispatch2::{DispatchQueue, DispatchQueueGlobalPriority, GlobalQueueIdentifier};
use nsh_core::{
    Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId, PayloadValue,
    ResizeMode,
    geometry::{DevicePixels, Points, Size, size},
    image::{CacheHeaders, DiskCache, Fetched, Lookup},
};
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGFloat, kCFBooleanTrue,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{
    NSData, NSDataReadingOptions, NSError, NSHTTPURLResponse, NSMutableURLRequest, NSObject,
    NSObjectProtocol, NSString, NSURL, NSURLResponse, NSURLSession, NSURLSessionDataDelegate,
    NSURLSessionDataTask, NSURLSessionDelegate, NSURLSessionResponseDisposition, NSURLSessionTask,
    NSURLSessionTaskDelegate,
};
use objc2_image_io::{
    CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCacheImmediately,
    kCGImageSourceThumbnailMaxPixelSize,
};
use rustc_hash::FxHashMap;

use crate::{
    surface::{Surface, quiet},
    view::{NshView, ViewObj},
};

/// Decoded images kept in memory (bytes: 4 per pixel and frame).
const CACHE_BYTES: usize = 128 << 20;

/// Encoded bytes kept for `Image.prefetch` / `getSize`.
const DATA_BYTES: usize = 32 << 20;

/// Frames of an animated image decoded at most (longer ones play the first
/// ones).
const MAX_FRAMES: usize = 600;

/// Progress reports at most this often (a download reports its end too).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Where bundled (`asset:/…`) files are.
#[derive(Debug, Clone)]
pub enum AssetBase {
    /// Served over HTTP (the dev server): `http://host:port/assets/`.
    Http(String),
    /// A directory on disk.
    Directory(PathBuf),
}

/// Reads `asset:/…` files for the engine (fonts): synchronously, on the
/// engine thread.
pub(crate) struct AssetReader(pub(crate) Option<AssetBase>);

impl nsh_engine::Assets for AssetReader {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        if !uri.starts_with("asset:/") {
            return Err(format!("not an asset URI: {uri}"));
        }
        match resolve(uri, self.0.as_ref()) {
            Some(Location::File(path)) => {
                std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
            }
            Some(Location::Url(url)) => {
                let ns = ns_url(&url).ok_or_else(|| format!("bad asset URL {url}"))?;
                NSData::dataWithContentsOfURL_options_error(&ns, NSDataReadingOptions::empty())
                    .map(|d| d.to_vec())
                    .map_err(|e| format!("{url}: {}", e.localizedDescription()))
            }
            Some(Location::Data(data)) => data_uri(&data),
            Some(Location::Memory(_, data)) => Ok(data.to_vec()),
            None => Err(format!("{uri}: no asset location configured")),
        }
    }
}

/// Sets the disk cache of what `surface`'s images download (`None`:
/// none).
pub(crate) fn set_disk_cache(surface: &Surface, cache: Option<DiskCache>) {
    *surface.image_cache.borrow_mut() = cache;
}

/// The disk cache a load of `uri` goes through: the surface's, for remote
/// images (`asset:/` URIs, served by the dev server during development,
/// change as the app does: never kept).
fn disk_cache(surface: &Surface, uri: &str) -> Option<DiskCache> {
    let remote = uri.starts_with("http://") || uri.starts_with("https://");
    remote
        .then(|| surface.image_cache.borrow().clone())
        .flatten()
}

/// Sets where `asset:/` URIs of `surface` resolve.
pub(crate) fn set_asset_base(surface: &Rc<Surface>, base: Option<AssetBase>) {
    *surface.asset_base.borrow_mut() = base;
}

/// Where an image's bytes come from.
#[derive(Debug, Clone, PartialEq)]
enum Location {
    /// `http(s)://`.
    Url(String),
    /// A file on disk.
    File(PathBuf),
    /// A `data:` URI (decoded off the main thread): `Image.getSize`'s; a
    /// view's source arrives decoded ([`Location::Memory`]).
    Data(String),
    /// Bytes in memory (a decoded `data:` URI, a blob), by the source's
    /// URI.
    Memory(String, ImageData),
}

impl Location {
    /// The same location is the same image, whatever URI named it.
    fn key(&self) -> String {
        match self {
            Location::Url(url) => url.clone(),
            Location::File(path) => format!("file://{}", path.display()),
            Location::Data(uri) | Location::Memory(uri, _) => uri.clone(),
        }
    }
}

/// Resolves `uri` (`asset:/…` against `base`, `http(s)://`, `file://`, an
/// absolute path, `data:`).
fn resolve(uri: &str, base: Option<&AssetBase>) -> Option<Location> {
    if let Some(path) = uri.strip_prefix("asset:/") {
        let path = path.trim_start_matches('/');
        return match base? {
            AssetBase::Http(base) => {
                let sep = if base.ends_with('/') { "" } else { "/" };
                Some(Location::Url(format!("{base}{sep}{path}")))
            }
            AssetBase::Directory(dir) => Some(Location::File(dir.join(path))),
        };
    }
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return Some(Location::Url(uri.to_owned()));
    }
    if uri.starts_with("data:") {
        return Some(Location::Data(uri.to_owned()));
    }
    if let Some(rest) = uri.strip_prefix("file://") {
        let path = String::from_utf8(percent_decode(rest)).ok()?;
        return path.starts_with('/').then(|| Location::File(path.into()));
    }
    uri.starts_with('/').then(|| Location::File(uri.into()))
}

/// Where the bytes of `source` are: in memory, when it carries them.
fn locate(source: &ImageSource, base: Option<&AssetBase>) -> Option<Location> {
    match &source.data {
        Some(data) => Some(Location::Memory(source.uri.to_string(), data.clone())),
        None => resolve(&source.uri, base),
    }
}

/// `%xx` escapes decoded (invalid ones kept as they are).
fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (
            bytes[i],
            bytes.get(i + 1).and_then(|&b| hex(b)),
            bytes.get(i + 2).and_then(|&b| hex(b)),
        ) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// The bytes of a `data:` URI (base64 or percent-encoded).
fn data_uri(uri: &str) -> Result<Vec<u8>, String> {
    nsh_core::image::decode_data_uri(uri).map(|(_, bytes)| bytes)
}

fn ns_url(s: &str) -> Option<Retained<NSURL>> {
    NSURL::URLWithString(&NSString::from_str(s))
}

/// A decoded image: its frames (one unless animated) and the pixel size
/// of its source (before downsampling: `onLoad` reports it).
#[derive(Clone)]
pub(crate) struct Decoded {
    /// The frames, each once.
    pub(crate) frames: Arc<[CFRetained<CGImage>]>,
    /// When each frame starts, as a fraction of `duration`, and 1 at the
    /// end (a discrete keyframe animation's times).
    pub(crate) key_times: Arc<[f64]>,
    /// One loop of the animation, in seconds.
    pub(crate) duration: f64,
    /// The source's width in pixels (an SVG's: in whole points).
    pub(crate) width: u32,
    /// The source's height in pixels (an SVG's: in whole points).
    pub(crate) height: u32,
    /// An SVG's intrinsic size, unrounded: what it lays out at, whatever its
    /// file name says.
    pub(crate) points: Option<Size<Points>>,
}

// SAFETY: CGImages are immutable and documented as thread-safe; they are
// only created off the main thread and then moved.
unsafe impl Send for Decoded {}

impl Decoded {
    /// The decoded width in pixels (of the first frame).
    pub(crate) fn pixel_width(&self) -> usize {
        CGImage::width(Some(&self.frames[0]))
    }

    fn cost(&self) -> usize {
        self.frames
            .iter()
            .map(|f| CGImage::width(Some(f)) * CGImage::height(Some(f)) * 4)
            .sum()
    }
}

/// How a request decodes: the longer side in pixels (0: natural), the
/// backing scale (what an SVG at its natural size is drawn at), the blur
/// radius in pixels, a color matrix.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Decoding {
    max_pixels: u32,
    scale: f64,
    blur: f64,
    matrix: Option<[f32; 20]>,
}

impl Default for Decoding {
    fn default() -> Self {
        Decoding {
            max_pixels: 0,
            scale: 1.0,
            blur: 0.0,
            matrix: None,
        }
    }
}

impl Decoding {
    /// The cache key of `location` decoded so: the same image at another
    /// size or look is another image.
    fn key(&self, location: &str) -> String {
        let mut key = format!("{}@", self.max_pixels);
        if self.max_pixels == 0 && self.scale != 1.0 {
            key.push_str(&format!("s{}@", self.scale));
        }
        if self.blur > 0.0 {
            key.push_str(&format!("b{}@", self.blur));
        }
        if let Some(m) = self.matrix {
            use std::hash::{Hash, Hasher};
            let mut h = std::hash::DefaultHasher::new();
            m.map(f32::to_bits).hash(&mut h);
            key.push_str(&format!("m{:x}@", h.finish()));
        }
        key.push_str(location);
        key
    }
}

/// Called with a load's image or error (main thread).
type Done = Box<dyn FnOnce(Result<Decoded, String>)>;

/// Called with a download's bytes so far and its size (0: unknown).
type Progress = Box<dyn Fn(u64, u64)>;

/// Called with an image's size in pixels (`Image.getSize`).
type InfoDone = Box<dyn FnOnce(Result<(u32, u32), String>)>;

/// Someone waiting for a decode.
struct Waiter {
    done: Done,
    progress: Option<Progress>,
}

/// A decode waiting for its bytes, or decoding.
struct Inflight {
    /// The location's key.
    location: String,
    decoding: Decoding,
    waiters: Vec<Waiter>,
}

/// What a location's bytes are for.
enum Want {
    /// Decode for this cache key.
    Decode(String),
    /// Answer an `Image.getSize` / `Image.prefetch` request.
    Info(InfoDone),
}

/// A cached decode.
struct Entry {
    image: Decoded,
    bytes: usize,
    used: u64,
}

/// The main thread's image cache and running loads.
#[derive(Default)]
struct Loader {
    cache: FxHashMap<String, Entry>,
    bytes: usize,
    clock: u64,
    /// Encoded bytes kept by `getSize` / `prefetch`, by location.
    data: FxHashMap<String, (ImageData, u64)>,
    data_bytes: usize,
    inflight: FxHashMap<String, Inflight>,
    /// Running reads and downloads, by location.
    downloads: FxHashMap<String, Vec<Want>>,
    /// `Image.getSize` answers waiting for a measure off the main thread.
    infos: FxHashMap<u64, InfoDone>,
}

thread_local! {
    static LOADER: RefCell<Loader> = RefCell::default();
}

/// Runs `f` with the loader. Callbacks of waiters never run inside.
fn with<R>(f: impl FnOnce(&mut Loader) -> R) -> R {
    LOADER.with(|l| f(&mut l.borrow_mut()))
}

impl Loader {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn cached(&mut self, key: &str) -> Option<Decoded> {
        let now = self.tick();
        let entry = self.cache.get_mut(key)?;
        entry.used = now;
        Some(entry.image.clone())
    }

    fn insert(&mut self, key: String, image: Decoded) {
        let bytes = image.cost();
        if bytes > CACHE_BYTES / 2 {
            return;
        }
        let used = self.tick();
        if let Some(old) = self.cache.insert(key, Entry { image, bytes, used }) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        // Rare, and the cache holds hundreds of entries at most: a scan for
        // the oldest beats keeping an ordered index up to date on every hit.
        while self.bytes > CACHE_BYTES {
            let Some(oldest) = self
                .cache
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(e) = self.cache.remove(&oldest) {
                self.bytes -= e.bytes;
            }
        }
    }

    fn keep_data(&mut self, location: &str, bytes: ImageData) {
        if bytes.len() > DATA_BYTES / 2 {
            return;
        }
        let used = self.tick();
        self.data_bytes += bytes.len();
        if let Some((old, _)) = self.data.insert(location.to_owned(), (bytes, used)) {
            self.data_bytes -= old.len();
        }
        while self.data_bytes > DATA_BYTES {
            let Some(oldest) = self
                .data
                .iter()
                .min_by_key(|(_, (_, u))| *u)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((b, _)) = self.data.remove(&oldest) {
                self.data_bytes -= b.len();
            }
        }
    }

    fn drop_data(&mut self, location: &str) {
        if let Some((b, _)) = self.data.remove(location) {
            self.data_bytes -= b.len();
        }
    }
}

/// Runs `f` on the main queue.
fn on_main(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

/// Runs `f` on a global queue.
fn in_background(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
        DispatchQueueGlobalPriority::Default,
    ))
    .exec_async(f);
}

/// Decodes `location` as `decoding` asks, a download through `cache`;
/// `done` runs on the main thread (before this returns when the image is
/// cached). Returns whether it ran.
fn request(
    location: Location,
    cache: Option<DiskCache>,
    decoding: Decoding,
    progress: Option<Progress>,
    done: Done,
) -> bool {
    let lk = location.key();
    let key = decoding.key(&lk);
    if let Some(image) = with(|l| l.cached(&key)) {
        done(Ok(image));
        return true;
    }
    let waiter = Waiter { done, progress };
    let start = with(|l| match l.inflight.get_mut(&key) {
        Some(i) => {
            i.waiters.push(waiter);
            false
        }
        None => {
            l.inflight.insert(
                key.clone(),
                Inflight {
                    location: lk,
                    decoding,
                    waiters: vec![waiter],
                },
            );
            true
        }
    });
    if start {
        fetch(location, cache, Want::Decode(key));
    }
    false
}

/// Gets the bytes of `location` for `want`: kept ones, a running read, or
/// a new one (a download through `cache` when there is one).
fn fetch(location: Location, cache: Option<DiskCache>, want: Want) {
    let lk = location.key();
    if let Location::Memory(_, bytes) = location {
        serve(&lk, bytes, want);
        return;
    }
    if let Some(bytes) = with(|l| l.data.get(&lk).map(|(b, _)| b.clone())) {
        serve(&lk, bytes, want);
        return;
    }
    let first = with(|l| {
        let wants = l.downloads.entry(lk.clone()).or_default();
        wants.push(want);
        wants.len() == 1
    });
    if !first {
        return;
    }
    match location {
        Location::File(path) => in_background(move || {
            let result = std::fs::read(&path)
                .map(ImageData::from)
                .map_err(|e| format!("{}: {e}", path.display()));
            on_main(move || bytes_ready(&lk, result));
        }),
        Location::Data(uri) => in_background(move || {
            let result = data_uri(&uri).map(ImageData::from);
            on_main(move || bytes_ready(&lk, result));
        }),
        Location::Memory(..) => unreachable!("served above"),
        Location::Url(url) => match cache {
            // The disk is read off the main thread; a fresh copy is all it
            // takes, a stale one is revalidated.
            Some(cache) => in_background(move || {
                let lookup = cache.lookup(&url);
                if let Lookup::Fresh(bytes) = lookup {
                    on_main(move || bytes_ready(&lk, Ok(bytes)));
                    return;
                }
                let headers = lookup.request_headers();
                download(&url, lk, Some(cache), &headers);
            }),
            None => download(&url, lk, None, &[]),
        },
    }
}

/// The bytes of `location` arrived (or failed).
fn bytes_ready(location: &str, result: Result<ImageData, String>) {
    let wants = with(|l| l.downloads.remove(location)).unwrap_or_default();
    match result {
        Ok(bytes) => {
            if wants.iter().any(|w| matches!(w, Want::Info(_))) {
                // Kept for the views that show it next.
                with(|l| l.keep_data(location, bytes.clone()));
            }
            for want in wants {
                serve(location, bytes.clone(), want);
            }
        }
        Err(message) => {
            for want in wants {
                match want {
                    Want::Decode(key) => finish(key, Err(message.clone())),
                    Want::Info(done) => done(Err(message.clone())),
                }
            }
        }
    }
}

/// Decodes or measures `bytes` for `want`.
fn serve(location: &str, bytes: ImageData, want: Want) {
    match want {
        Want::Decode(key) => {
            let Some(decoding) = with(|l| l.inflight.get(&key).map(|i| i.decoding)) else {
                return;
            };
            let what = location.to_owned();
            in_background(move || {
                let result =
                    decode(&bytes, decoding).ok_or_else(|| format!("cannot decode {what}"));
                on_main(move || finish(key, result));
            });
        }
        Want::Info(done) => {
            // An SVG's size takes parsing it: measured off the main thread.
            let id = with(|l| {
                let id = l.tick();
                l.infos.insert(id, done);
                id
            });
            let what = location.to_owned();
            in_background(move || {
                let size =
                    info_size(&bytes).ok_or_else(|| format!("cannot read the size of {what}"));
                on_main(move || {
                    if let Some(done) = with(|l| l.infos.remove(&id)) {
                        done(size);
                    }
                });
            });
        }
    }
}

/// The size `Image.getSize` reports: pixels, or an SVG's whole points.
fn info_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let size = if nsh_core::svg::sniff(bytes) {
        nsh_core::svg::size(bytes)
            .inspect_err(|e| log::warn!("{e}"))
            .ok()
            .map(svg_size)
    } else {
        let data = CFData::from_bytes(bytes);
        // SAFETY: valid data; only the header is read.
        unsafe { CGImageSource::with_data(&data, None) }.map(|s| source_size(&s))
    };
    size.filter(|(w, h)| *w > 0 && *h > 0)
}

/// An SVG's intrinsic size in whole points, as `onLoad` and
/// `Image.getSize` report it.
fn svg_size(size: Size<Points>) -> (u32, u32) {
    let reported = nsh_core::svg::reported_size(size);
    (reported.width.0 as u32, reported.height.0 as u32)
}

/// A decode finished: caches it and calls its waiters.
fn finish(key: String, result: Result<Decoded, String>) {
    let waiters = with(|l| {
        let inflight = l.inflight.remove(&key)?;
        if let Ok(image) = &result {
            l.insert(key, image.clone());
            // Shown now: the encoded bytes are not needed any more.
            l.drop_data(&inflight.location);
        }
        Some(inflight.waiters)
    })
    .unwrap_or_default();
    for w in waiters {
        (w.done)(result.clone());
    }
}

/// A download of `location` got `loaded` of `total` bytes (0: unknown).
fn progress(location: &str, loaded: u64, total: u64) {
    LOADER.with(|l| {
        let l = l.borrow();
        for i in l.inflight.values().filter(|i| i.location == location) {
            for p in i.waiters.iter().filter_map(|w| w.progress.as_ref()) {
                p(loaded, total);
            }
        }
    });
}

struct DownloadIvars {
    location: String,
    /// The disk cache and URL it goes through.
    cache: Option<(DiskCache, String)>,
    data: Mutex<DownloadState>,
}

#[derive(Default)]
struct DownloadState {
    bytes: Vec<u8>,
    total: u64,
    status: isize,
    headers: CacheHeaders,
    reported: Option<Instant>,
}

define_class!(
    /// A download's delegate: collects the bytes and reports progress.
    #[unsafe(super(NSObject))]
    #[name = "NshImageDownload"]
    #[ivars = DownloadIvars]
    struct ImageDownload;

    unsafe impl NSObjectProtocol for ImageDownload {}

    unsafe impl NSURLSessionDelegate for ImageDownload {}

    unsafe impl NSURLSessionTaskDelegate for ImageDownload {
        #[unsafe(method(URLSession:task:didCompleteWithError:))]
        fn did_complete(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            error: Option<&NSError>,
        ) {
            let ivars = self.ivars();
            let state = std::mem::take(&mut *ivars.data.lock().expect("download"));
            // Delegates run on the session's queue, off the main thread:
            // the cache's file IO is done here.
            let result = match (&ivars.cache, error) {
                (Some((cache, url)), error) => {
                    let response = match error {
                        Some(e) => Err(e.localizedDescription().to_string()),
                        None => Ok(Fetched::new(
                            state.status as u16,
                            state.headers,
                            state.bytes,
                        )),
                    };
                    cache.complete(url, response)
                }
                (None, Some(e)) => Err(e.localizedDescription().to_string()),
                (None, None) if state.status >= 400 => Err(format!("HTTP {}", state.status)),
                (None, None) => Ok(ImageData::from(state.bytes)),
            };
            let location = ivars.location.clone();
            let result = result.map_err(|e| format!("{location}: {e}"));
            on_main(move || bytes_ready(&location, result));
        }
    }

    unsafe impl NSURLSessionDataDelegate for ImageDownload {
        #[unsafe(method(URLSession:dataTask:didReceiveResponse:completionHandler:))]
        fn did_receive_response(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionDataTask,
            response: &NSURLResponse,
            completion: &block2::DynBlock<dyn Fn(NSURLSessionResponseDisposition)>,
        ) {
            let mut state = self.ivars().data.lock().expect("download");
            state.total = response.expectedContentLength().max(0) as u64;
            if let Some(http) = response.downcast_ref::<NSHTTPURLResponse>() {
                state.status = http.statusCode();
                if self.ivars().cache.is_some() {
                    state.headers = cache_headers(http);
                }
            }
            drop(state);
            completion.call((NSURLSessionResponseDisposition::Allow,));
        }

        #[unsafe(method(URLSession:dataTask:didReceiveData:))]
        fn did_receive_data(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionDataTask,
            data: &NSData,
        ) {
            let ivars = self.ivars();
            let mut state = ivars.data.lock().expect("download");
            state.bytes.extend_from_slice(&data.to_vec());
            let now = Instant::now();
            let due = state.reported.is_none_or(|t| now - t >= PROGRESS_INTERVAL);
            let done = state.total > 0 && state.bytes.len() as u64 >= state.total;
            if due || done {
                state.reported = Some(now);
                let (loaded, total) = (state.bytes.len() as u64, state.total);
                drop(state);
                let location = ivars.location.clone();
                on_main(move || progress(&location, loaded, total));
            }
        }
    }
);

/// The caching headers of `response`.
fn cache_headers(response: &NSHTTPURLResponse) -> CacheHeaders {
    let (keys, values) = response.allHeaderFields().to_vecs();
    let pairs: Vec<(String, String)> = keys
        .iter()
        .zip(values.iter())
        .filter_map(|(k, v)| {
            let k = k.downcast_ref::<NSString>()?;
            let v = v.downcast_ref::<NSString>()?;
            Some((k.to_string(), v.to_string()))
        })
        .collect();
    CacheHeaders::from_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
}

/// Downloads `url` with `headers` (a revalidation's conditions), through
/// `cache` when there is one, reporting progress and then its bytes.
/// Any thread.
fn download(
    url: &str,
    location: String,
    cache: Option<DiskCache>,
    headers: &[(&'static str, String)],
) {
    let Some(ns) = ns_url(url) else {
        let error = format!("bad URL {url}");
        on_main(move || bytes_ready(&location, Err(error)));
        return;
    };
    let cached = cache.is_some();
    let delegate = ImageDownload::alloc().set_ivars(DownloadIvars {
        location,
        cache: cache.map(|cache| (cache, url.to_owned())),
        data: Mutex::new(DownloadState::default()),
    });
    // SAFETY: NSObject's designated initializer.
    let delegate: Retained<ImageDownload> = unsafe { msg_send![super(delegate), init] };
    let request = NSMutableURLRequest::requestWithURL(&ns);
    if cached {
        // The disk cache answers for these: the shared URL cache must not
        // serve a copy it never saw (nor hide a revalidation's 304).
        request.setCachePolicy(
            objc2_foundation::NSURLRequestCachePolicy::ReloadIgnoringLocalCacheData,
        );
    }
    for (name, value) in headers {
        request.setValue_forHTTPHeaderField(
            Some(&NSString::from_str(value)),
            &NSString::from_str(name),
        );
    }
    let task = NSURLSession::sharedSession().dataTaskWithRequest(&request);
    // The task keeps its delegate until it completes.
    task.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    task.resume();
}

/// Decodes (downsamples, blurs, filters) with ImageIO; any thread.
fn decode(bytes: &[u8], d: Decoding) -> Option<Decoded> {
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes, d);
    }
    let data = CFData::from_bytes(bytes);
    // SAFETY: valid data and option dictionaries of the documented types.
    unsafe {
        let source = CGImageSource::with_data(&data, None)?;
        let yes: &CFType = kCFBooleanTrue?;
        let max = CFNumber::new_cgfloat(d.max_pixels as CGFloat);
        let mut keys: Vec<&CFString> = vec![
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceShouldCacheImmediately,
        ];
        let mut values: Vec<&CFType> = vec![yes, yes, yes];
        if d.max_pixels > 0 {
            keys.push(kCGImageSourceThumbnailMaxPixelSize);
            values.push(&max);
        }
        let options = CFDictionary::from_slices(&keys, &values);
        let options: &CFDictionary = options.as_opaque();
        let frame = |i: usize| -> Option<CFRetained<CGImage>> {
            let image = source.thumbnail_at_index(i, Some(options))?;
            if d.blur > 0.0 || d.matrix.is_some() {
                return Some(crate::blur::filtered(&image, d.blur, d.matrix).unwrap_or(image));
            }
            Some(image)
        };
        let (width, height) = source_size(&source);
        let count = source.count().clamp(1, MAX_FRAMES);
        let mut frames = Vec::with_capacity(count);
        let mut delays = Vec::with_capacity(count);
        for i in 0..count {
            let Some(image) = frame(i) else { break };
            frames.push(image);
            delays.push(if count > 1 {
                frame_delay(&source, i)
            } else {
                1
            });
        }
        if frames.is_empty() {
            return None;
        }
        let total: u32 = delays.iter().sum();
        let mut key_times = Vec::with_capacity(frames.len() + 1);
        let mut at = 0;
        for delay in &delays {
            key_times.push(at as f64 / total as f64);
            at += delay;
        }
        key_times.push(1.0);
        Some(Decoded {
            frames: frames.into(),
            key_times: key_times.into(),
            duration: total as f64 / 100.0,
            width,
            height,
            points: None,
        })
    }
}

/// Draws an SVG for a view `d.max_pixels` pixels on its longer side, with
/// its shorter side that long, so it stays sharp in every resize mode
/// (natural: at its intrinsic size at the backing scale), then blurs and
/// filters it as [`decode`] does bitmaps; any thread.
fn decode_svg(bytes: &[u8], d: Decoding) -> Option<Decoded> {
    let raster = match d.max_pixels {
        0 => nsh_core::svg::rasterize_scaled(bytes, d.scale as f32),
        n => nsh_core::svg::rasterize_covering(bytes, n),
    }
    .inspect_err(|e| log::warn!("{e}"))
    .ok()?;
    let image = rgba_image(&raster)?;
    let image = if d.blur > 0.0 || d.matrix.is_some() {
        crate::blur::filtered(&image, d.blur, d.matrix).unwrap_or(image)
    } else {
        image
    };
    let (width, height) = svg_size(raster.size);
    Some(Decoded {
        frames: Arc::new([image]),
        key_times: Arc::new([0.0, 1.0]),
        duration: 0.0,
        width,
        height,
        points: Some(raster.size),
    })
}

/// A CGImage of premultiplied sRGB RGBA pixels.
fn rgba_image(raster: &nsh_core::svg::Raster) -> Option<CFRetained<CGImage>> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
        CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo, CGImageByteOrderInfo,
        kCGColorSpaceSRGB,
    };
    let (width, height) = (raster.width as usize, raster.height as usize);
    // SAFETY: a constant of CoreGraphics.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    // SAFETY: CoreGraphics allocates the pixels (null data) of an RGBA
    // context of these dimensions; the rows are copied within
    // `bytes_per_row * height` bytes while `context` lives.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )?;
        let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
        if data.is_null() {
            return None;
        }
        let stride = CGBitmapContextGetBytesPerRow(Some(&context));
        let pixels = std::slice::from_raw_parts_mut(data, stride * height);
        for (row, src) in raster.pixels.chunks_exact(width * 4).enumerate() {
            pixels[row * stride..row * stride + width * 4].copy_from_slice(src);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}

/// The pixel size of the first image, as displayed (EXIF orientations 5–8
/// turn it a quarter).
pub(crate) fn source_size(source: &CGImageSource) -> (u32, u32) {
    use objc2_image_io::{
        kCGImagePropertyOrientation, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
    };
    // SAFETY: a CoreFoundation dictionary of CFString keys, read with the
    // documented ImageIO keys and value types.
    unsafe {
        let Some(props) = source.properties_at_index(0, None) else {
            return (0, 0);
        };
        let props: &CFDictionary<CFString, CFType> = props.cast_unchecked();
        let number = |key: &CFString| {
            props
                .get(key)
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_i64()))
                .unwrap_or(0)
                .max(0) as u32
        };
        let (w, h) = (
            number(kCGImagePropertyPixelWidth),
            number(kCGImagePropertyPixelHeight),
        );
        match number(kCGImagePropertyOrientation) {
            5..=8 => (h, w),
            _ => (w, h),
        }
    }
}

/// The delay of frame `i` in centiseconds (GIF's unit), at least 2 (as
/// browsers: shorter ones show for 10).
fn frame_delay(source: &CGImageSource, i: usize) -> u32 {
    use objc2_image_io::{
        kCGImagePropertyAPNGDelayTime, kCGImagePropertyAPNGUnclampedDelayTime,
        kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFDictionary,
        kCGImagePropertyGIFUnclampedDelayTime, kCGImagePropertyPNGDictionary,
        kCGImagePropertyWebPDelayTime, kCGImagePropertyWebPDictionary,
        kCGImagePropertyWebPUnclampedDelayTime,
    };
    // SAFETY: CoreFoundation dictionaries of CFString keys, read with the
    // documented ImageIO keys and value types.
    let seconds = unsafe {
        source.properties_at_index(i, None).and_then(|props| {
            let props: &CFDictionary<CFString, CFType> = props.cast_unchecked();
            [
                (
                    kCGImagePropertyGIFDictionary,
                    kCGImagePropertyGIFUnclampedDelayTime,
                    kCGImagePropertyGIFDelayTime,
                ),
                (
                    kCGImagePropertyPNGDictionary,
                    kCGImagePropertyAPNGUnclampedDelayTime,
                    kCGImagePropertyAPNGDelayTime,
                ),
                (
                    kCGImagePropertyWebPDictionary,
                    kCGImagePropertyWebPUnclampedDelayTime,
                    kCGImagePropertyWebPDelayTime,
                ),
            ]
            .into_iter()
            .find_map(|(dict, unclamped, clamped)| {
                let format = props.get(dict)?;
                let format: &CFDictionary<CFString, CFType> =
                    format.downcast_ref::<CFDictionary>()?.cast_unchecked();
                let number = |key| {
                    format
                        .get(key)
                        .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_cgfloat()))
                        .filter(|s| *s > 0.0)
                };
                number(unclamped).or_else(|| number(clamped))
            })
        })
    };
    match seconds {
        Some(s) if s >= 0.02 => (s * 100.0).round() as u32,
        _ => 10,
    }
}

/// Loads the bitmap `uri` (`https://…`, `asset:/…`, a file path, `data:`)
/// for a canvas, at its natural size, through the cache, and hands over its
/// (first) frame; `done` runs on the main thread (before this returns when
/// it is cached: callers must not hold a borrow `done` takes). Canvases
/// draw bitmaps: an SVG is an image that failed to load.
pub(crate) fn load(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<CFRetained<CGImage>, String>) + 'static,
) {
    match resolve(uri, surface.asset_base.borrow().as_ref()) {
        Some(location) => {
            let cache = disk_cache(surface, uri);
            let uri = uri.to_owned();
            let done = move |r: Result<Decoded, String>| done(r.and_then(|d| bitmap(&uri, d)));
            request(location, cache, Decoding::default(), None, Box::new(done));
        }
        None => done(Err(format!("unsupported image source `{uri}`"))),
    }
}

/// The first frame of `image`, loaded from `uri`, unless it is an SVG.
fn bitmap(uri: &str, image: Decoded) -> Result<CFRetained<CGImage>, String> {
    match image.points {
        Some(_) => Err(format!(
            "{uri} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
        )),
        None => Ok(image.frames[0].clone()),
    }
}

/// The image of `uri` at its natural size, if it is cached.
#[allow(dead_code)]
pub(crate) fn cached(surface: &Surface, uri: &str) -> Option<Decoded> {
    let location = resolve(uri, surface.asset_base.borrow().as_ref())?.key();
    with(|l| l.cached(&Decoding::default().key(&location)))
}

/// `Command::ImageInfo` (`Image.getSize`, `Image.prefetch`): the image's
/// size in pixels, keeping its bytes for the views that show it next.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    let Command::ImageInfo { id, uri } = command else {
        return;
    };
    let request = *id;
    let weak = Rc::downgrade(surface);
    let done = move |result: Result<(u32, u32), String>| {
        let Some(surface) = weak.upgrade() else {
            return;
        };
        let mut fields = vec![("id", PayloadValue::Number(request as f64))];
        match result {
            Ok((w, h)) => {
                fields.push(("width", PayloadValue::Number(w as f64)));
                fields.push(("height", PayloadValue::Number(h as f64)));
            }
            Err(message) => fields.push(("error", PayloadValue::Str(message))),
        }
        surface.event(
            nsh_core::ROOT_ID,
            EventKind::ImageInfo,
            EventPayload::Map(fields),
        );
    };
    match resolve(uri, surface.asset_base.borrow().as_ref()) {
        Some(location) => fetch(
            location,
            disk_cache(surface, uri),
            Want::Info(Box::new(done)),
        ),
        None => done(Err(format!("unsupported image source `{uri}`"))),
    }
}

/// What an image view shows.
#[derive(Default)]
pub(crate) struct ImageState {
    source: Option<ImageSource>,
    options: ImageOptions,
    /// Bumped on every source change: older loads are stale.
    generation: u64,
    /// The source's image (not the placeholder) is shown.
    shown: bool,
    /// Waiting for a size to decode at.
    pending: bool,
    /// The surface's key ([`Surface::with_key`]).
    surface: u64,
}

/// Sets up an image view.
pub(crate) fn create(view: &NshView) {
    view.state_mut().image = Some(ImageState::default());
}

/// An image view's source changed.
pub(crate) fn set(
    surface: &Rc<Surface>,
    view: &NshView,
    source: Option<&ImageSource>,
    mode: ResizeMode,
    options: &ImageOptions,
) {
    let restart = {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        // `center` shows the image at its own size: decoded so, where the
        // other modes decode it at the view's.
        let natural = |m: ResizeMode| m == ResizeMode::Center;
        let same_decode = natural(s.decor.resize_mode()) == natural(mode);
        s.decor.set_fit(mode, options.position);
        let image = s.image.get_or_insert_with(ImageState::default);
        image.surface = surface.key();
        let same_source =
            same_decode && image.source.as_ref().map(|i| &i.uri) == source.map(|i| &i.uri);
        let same_look = image.options.placeholder == options.placeholder
            && image.options.blur_radius == options.blur_radius;
        image.options = options.clone();
        if same_source && same_look {
            false
        } else {
            image.generation += 1;
            image.shown = false;
            image.source = source.cloned();
            image.pending = image.source.is_some() || image.options.placeholder.is_some();
            s.decor.set_image(None, 0.0);
            true
        }
    };
    view.changed();
    if restart {
        resume(view);
        wait_for_frame(surface, view);
    }
}

/// The view's filters changed: it decodes again.
pub(crate) fn filters_changed(view: &NshView) {
    {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        let Some(image) = s.image.as_mut() else {
            return;
        };
        if image.source.is_none() {
            return;
        }
        image.generation += 1;
        image.shown = false;
        image.pending = true;
    }
    resume(view);
}

/// Starts the view's pending loads once it has a size (called whenever its
/// decoration is applied).
pub(crate) fn resume(view: &NshView) {
    let key = {
        let s = view.state();
        match &s.image {
            Some(i) if i.pending && s.frame.size.width.0 > 0.0 && s.frame.size.height.0 > 0.0 => {
                i.surface
            }
            _ => return,
        }
    };
    if let Some(surface) = Surface::with_key(key) {
        start(&surface, view);
    }
}

/// Loads at the natural size if the view still has no size by the next
/// display frame.
fn wait_for_frame(surface: &Rc<Surface>, view: &NshView) {
    let pending = view.state().image.as_ref().is_some_and(|i| i.pending);
    if !pending {
        return;
    }
    let weak = Weak::from_retained(&Retained::from(&**view as &ViewObj));
    surface.add_frame_callback(move |surface, _| {
        if let Some(view) = weak.load().and_then(|v| NshView::from_ns(&v))
            && view.state().image.as_ref().is_some_and(|i| i.pending)
        {
            start(surface, &view);
        }
        false
    });
}

/// Requests the view's image (and placeholder) at its current size.
fn start(surface: &Rc<Surface>, view: &NshView) {
    let scale = view.ns().window().map_or(2.0, |w| w.backingScaleFactor());
    let (generation, source, placeholder, decoding, events, id) = {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        let (w, h) = (s.frame.size.width.0, s.frame.size.height.0);
        let filters = s
            .style
            .effects
            .as_ref()
            .map(|e| &e.filters[..])
            .unwrap_or(&[]);
        let blur = nsh_core::blur_radius(filters).0;
        let matrix = nsh_core::compose_color_matrices(filters);
        let (events, id) = (s.events, s.id);
        // 0: the image's own size, which `center` shows.
        let natural = s.decor.resize_mode() == ResizeMode::Center;
        let Some(image) = s.image.as_mut() else {
            return;
        };
        image.pending = false;
        let decoding = Decoding {
            max_pixels: if natural {
                0
            } else {
                (w.max(h) as CGFloat * scale).ceil() as u32
            },
            scale,
            blur: ((image.options.blur_radius.0 + blur) as CGFloat * scale).max(0.0),
            matrix,
        };
        (
            image.generation,
            image.source.clone(),
            image.options.placeholder.clone(),
            decoding,
            events,
            id,
        )
    };
    let weak = Weak::from_retained(&Retained::from(&**view as &ViewObj));
    let base = surface.asset_base.borrow().clone();
    if let Some(source) = source {
        let progress = events.contains(EventKind::Progress).then(|| {
            let surface = Rc::downgrade(surface);
            let weak = weak.clone();
            Box::new(move |loaded: u64, total: u64| {
                let current = weak
                    .load()
                    .and_then(|v| NshView::from_ns(&v))
                    .is_some_and(|v| {
                        v.state()
                            .image
                            .as_ref()
                            .is_some_and(|i| i.generation == generation)
                    });
                if let (true, Some(surface)) = (current, surface.upgrade()) {
                    surface.event(
                        id,
                        EventKind::Progress,
                        EventPayload::Map(vec![
                            ("loaded", PayloadValue::Number(loaded as f64)),
                            ("total", PayloadValue::Number(total as f64)),
                        ]),
                    );
                }
            }) as Progress
        });
        // Fades only what had to wait.
        let waited = Rc::new(Cell::new(false));
        let done = {
            let surface = Rc::downgrade(surface);
            let weak = weak.clone();
            let waited = waited.clone();
            move |result: Result<Decoded, String>| {
                let view = weak.load().and_then(|v| NshView::from_ns(&v));
                if let (Some(view), Some(surface)) = (view, surface.upgrade()) {
                    loaded(&surface, &view, generation, result, waited.get());
                }
            }
        };
        let immediate = match locate(&source, base.as_ref()) {
            Some(location) => request(
                location,
                disk_cache(surface, &source.uri),
                decoding,
                progress,
                Box::new(done),
            ),
            None => {
                done(Err(format!("unsupported image source `{}`", source.uri)));
                true
            }
        };
        waited.set(true);
        if !immediate && events.contains(EventKind::LoadStart) {
            surface.event(id, EventKind::LoadStart, EventPayload::None);
        }
    }
    // The placeholder, until the image shows.
    let shown = view.state().image.as_ref().is_some_and(|i| i.shown);
    let Some(placeholder) = placeholder.filter(|_| !shown) else {
        return;
    };
    let Some(location) = locate(&placeholder, base.as_ref()) else {
        log::warn!("unsupported image placeholder `{}`", placeholder.uri);
        return;
    };
    let plain = Decoding {
        max_pixels: decoding.max_pixels,
        scale: decoding.scale,
        ..Decoding::default()
    };
    request(
        location,
        disk_cache(surface, &placeholder.uri),
        plain,
        None,
        Box::new(move |result| {
            let Some(view) = weak.load().and_then(|v| NshView::from_ns(&v)) else {
                return;
            };
            match result {
                Ok(decoded) => {
                    {
                        let mut guard = view.state_mut();
                        let s = &mut *guard;
                        let Some(image) = s
                            .image
                            .as_ref()
                            .filter(|i| i.generation == generation && !i.shown)
                        else {
                            return;
                        };
                        let natural = natural(&decoded, image.options.placeholder.as_ref());
                        s.decor.set_image(Some((&decoded, natural)), 0.0);
                    }
                    view.changed();
                }
                Err(message) => log::warn!("image placeholder failed: {message}"),
            }
        }),
    );
}

/// The source of `view` loaded (or failed); `waited`: it was not cached,
/// so it fades in (when the app asked for a fade).
fn loaded(
    surface: &Surface,
    view: &NshView,
    generation: u64,
    result: Result<Decoded, String>,
    waited: bool,
) {
    let (events, id) = {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        match &result {
            Ok(decoded) => {
                image.shown = true;
                let natural = natural(decoded, image.source.as_ref());
                let fade = match image.options.fade_ms {
                    Some(ms) if waited && ms > 0.0 => ms as f64 / 1000.0,
                    _ => 0.0,
                };
                quiet(|| s.decor.set_image(Some((decoded, natural)), fade));
            }
            // The placeholder (if any) stays.
            Err(message) => log::warn!("image failed: {message}"),
        }
        (events, id)
    };
    view.changed();
    match &result {
        Ok(decoded) if events.contains(EventKind::Load) => surface.event(
            id,
            EventKind::Load,
            EventPayload::Image(size(
                DevicePixels(decoded.width as i32),
                DevicePixels(decoded.height as i32),
            )),
        ),
        Err(message) if events.contains(EventKind::Error) => surface.event(
            id,
            EventKind::Error,
            EventPayload::Error {
                message: message.clone(),
            },
        ),
        _ => {}
    }
    if events.contains(EventKind::LoadEnd) {
        surface.event(id, EventKind::LoadEnd, EventPayload::None);
    }
}

/// `logo@2x.png` -> 2: the pixel density a file name declares (1 without).
fn density(uri: &str) -> f32 {
    let name = uri.rsplit('/').next().unwrap_or(uri);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.rsplit_once('@')
        .and_then(|(_, s)| s.strip_suffix('x'))
        .and_then(|n| n.parse::<f32>().ok())
        .filter(|n| *n > 0.0)
        .unwrap_or(1.0)
}

/// The natural size in points of `image` loaded from `source`: the size
/// the source declares, an SVG's intrinsic size, or its pixels over the
/// file name's density.
fn natural(image: &Decoded, source: Option<&ImageSource>) -> (f32, f32) {
    if let Some(size) = source
        .and_then(|s| s.size)
        .filter(|s| s.width.0 > 0.0 && s.height.0 > 0.0)
    {
        return (size.width.0, size.height.0);
    }
    if let Some(points) = image.points {
        return (points.width.0, points.height.0);
    }
    let d = source.map_or(1.0, |s| density(&s.uri));
    (image.width as f32 / d, image.height as f32 / d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_uris() {
        let dir = AssetBase::Directory("/app/assets".into());
        let http = AssetBase::Http("http://10.0.0.2:8080/assets/".into());
        assert_eq!(
            resolve("asset:/img/a.png", Some(&dir)),
            Some(Location::File("/app/assets/img/a.png".into()))
        );
        assert_eq!(
            resolve("asset:/a.png", Some(&http)),
            Some(Location::Url("http://10.0.0.2:8080/assets/a.png".into()))
        );
        assert_eq!(resolve("asset:/a.png", None), None);
        assert_eq!(
            resolve("file:///home/a%20b.png", None),
            Some(Location::File("/home/a b.png".into()))
        );
        assert_eq!(resolve("relative.png", None), None);
    }

    const SVG_ICON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>"##;
    const SVG_LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f"/></svg>"##;

    /// The pixels of `image` as premultiplied sRGB RGBA, row by row.
    fn rgba(image: &CGImage) -> (usize, usize, Vec<u8>) {
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGColorSpace, CGContext, CGImageAlphaInfo, CGImageByteOrderInfo,
            kCGColorSpaceSRGB,
        };
        let (w, h) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
        let mut pixels = vec![0u8; w * h * 4];
        // SAFETY: `pixels` holds `w * 4 * h` bytes and outlives the context.
        unsafe {
            let space = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)).unwrap();
            let context = CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                w,
                h,
                8,
                w * 4,
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
            )
            .unwrap();
            CGContext::draw_image(
                Some(&context),
                CGRect::new(CGPoint::ZERO, CGSize::new(w as f64, h as f64)),
                Some(image),
            );
        }
        (w, h, pixels)
    }

    fn at((w, _, pixels): &(usize, usize, Vec<u8>), x: usize, y: usize) -> [u8; 4] {
        let i = (y * w + x) * 4;
        pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn svg_decodes_at_the_view_size() {
        let d = |max_pixels| Decoding {
            max_pixels,
            ..Decoding::default()
        };
        let icon = decode(SVG_ICON, d(54)).unwrap();
        assert_eq!(icon.points, Some(Size::new(Points(24.0), Points(24.0))));
        assert_eq!(
            (icon.width, icon.height),
            (24, 24),
            "intrinsic size in points"
        );
        assert_eq!(icon.frames.len(), 1);
        assert_eq!(icon.pixel_width(), 54);
        let logo = decode(SVG_LOGO, d(144)).unwrap();
        let first = &logo.frames[0];
        assert_eq!(
            (CGImage::width(Some(first)), CGImage::height(Some(first))),
            (288, 144),
            "the shorter side at the view's longer one: sharp when `cover` crops it"
        );
        // Natural size: at the backing scale.
        assert_eq!(decode(SVG_LOGO, d(0)).unwrap().pixel_width(), 48);
        let retina = Decoding {
            scale: 2.0,
            ..Decoding::default()
        };
        assert_eq!(decode(SVG_LOGO, retina).unwrap().pixel_width(), 96);
        assert_ne!(retina.key("a.svg"), Decoding::default().key("a.svg"));
        // Colours survive the trip through CGImage.
        let pixels = rgba(first);
        assert_eq!(at(&pixels, 10, 36), [255, 0, 0, 255]);
        assert_eq!(at(&pixels, 270, 72), [0, 0, 255, 255]);
        assert!(decode(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect", d(24)).is_none());
    }

    #[test]
    fn svg_info_reports_points() {
        assert_eq!(info_size(SVG_ICON), Some((24, 24)));
        assert_eq!(info_size(SVG_LOGO), Some((48, 24)));
        assert_eq!(info_size(b"<svg><rect"), None);
        // A file name's density does not apply to an SVG.
        let source = ImageSource {
            uri: "asset:/logo@2x.svg".into(),
            size: None,
            scales: nsh_core::ImageScales::NONE,
            data: None,
        };
        let logo = decode(SVG_LOGO, Decoding::default()).unwrap();
        assert_eq!(natural(&logo, Some(&source)), (48.0, 24.0));
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let decoded = decode(odd, Decoding::default()).unwrap();
        assert_eq!(natural(&decoded, None), (10.5, 10.0));
        assert_eq!((decoded.width, decoded.height), (11, 10));
        let huge = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1e30" height="1"/>"#;
        assert_eq!(info_size(huge), Some((i32::MAX as u32, 1)));
    }

    /// A 1 × 1 PNG.
    fn png_pixel() -> Vec<u8> {
        data_uri("data:;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==").unwrap()
    }

    #[test]
    fn svg_is_no_canvas_image() {
        let logo = decode(SVG_LOGO, Decoding::default()).unwrap();
        let error = bitmap("asset:/logo.svg", logo).unwrap_err();
        assert!(error.starts_with("asset:/logo.svg"), "{error}");
        let png = decode(&png_pixel(), Decoding::default()).unwrap();
        assert!(bitmap("asset:/a.png", png).is_ok());
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` shows a color through the image's alpha (a mask): the
        // SVG's shape is opaque, the rest transparent, whatever its colour.
        let icon = decode(
            SVG_ICON,
            Decoding {
                max_pixels: 48,
                ..Decoding::default()
            },
        )
        .unwrap();
        let pixels = rgba(&icon.frames[0]);
        assert_eq!(at(&pixels, 24, 24)[3], 255);
        assert_eq!(at(&pixels, 1, 1)[3], 0);
        // Filters apply to SVGs as to bitmaps: an inverting matrix.
        let mut invert = [0.0f32; 20];
        invert[0] = -1.0;
        invert[4] = 1.0;
        invert[6] = -1.0;
        invert[9] = 1.0;
        invert[12] = -1.0;
        invert[14] = 1.0;
        invert[18] = 1.0;
        let inverted = decode(
            SVG_ICON,
            Decoding {
                max_pixels: 48,
                matrix: Some(invert),
                ..Decoding::default()
            },
        )
        .unwrap();
        let pixels = rgba(&inverted.frames[0]);
        assert_eq!(at(&pixels, 24, 24), [255, 255, 255, 255]);
        assert_eq!(at(&pixels, 1, 1)[3], 0);
    }

    #[test]
    fn reads_densities() {
        assert_eq!(density("asset:/logo@2x.png"), 2.0);
        assert_eq!(density("https://x.org/me@home/a.png"), 1.0);
    }
}
