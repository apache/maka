//! Image views: loading (`asset:/`, files, HTTP; `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding into
//! textures, drawing with the resize mode, tint, blur and placeholder.
//!
//! Loads run on a small pool of worker threads: read the file or download
//! (ureq; `onProgress` at most every 100ms), decode (GDK's own PNG / JPEG /
//! TIFF loaders; GIF and WebP with the `image` crate) and hand the texture
//! to the main thread with `MainContext::invoke`. Textures are kept in a
//! main-thread cache keyed by the resolved location (so `asset:/` URIs of
//! surfaces with different asset bases never mix), bounded by bytes and
//! evicting the least recently used; concurrent requests for one location
//! share one load. Images decode at their full size: GSK scales them when
//! drawing (trilinear filtering when shrinking a lot). SVG images (sniffed
//! from their bytes) are drawn by [`nsh_core::svg`] at their intrinsic size
//! × [`nsh_core::svg::OVERSAMPLE`] (at most
//! [`nsh_core::svg::MAX_OVERSAMPLED_SIDE`] a side); their picture keeps
//! their intrinsic size in points, which they are laid out with and report.
//! Canvases draw bitmaps only ([`load_bitmap`]).
//!
//! Animated GIF and WebP images decode every frame (composited, at most
//! [`MAX_FRAMES`] and [`MAX_ANIMATION_BYTES`]: larger ones show their first
//! frame) with its delay, as browsers and iOS time them (under 20ms: 100ms),
//! and play their loop count. A view advances its frames with a timer at
//! each frame's delay, not on the frame clock (a 10 fps GIF need not keep
//! the clock running at the display's rate), measured on the monotonic
//! clock so delays do not drift; only while it is mapped (a hidden screen
//! pauses it, and it resumes on the frame it was); and redraws only when
//! a frame changes and its `display` is not `none`.
//! `onLoad` comes once per load; canvases draw the first frame.
//!
//! `blurRadius` is a GSK blur at draw time, in points; the image is drawn
//! enlarged under a clip to its own rectangle so the blur's edges stay
//! opaque. `tintColor` draws the color through the image's alpha.
//! The `placeholder` shows until the image arrives (and stays on error); an
//! image that had to load then fades in over `fadeDuration` (default 0, as
//! iOS).

use std::{
    cell::{Cell, RefCell},
    io::Read,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use gtk4::{self as gtk, gdk, glib, graphene, gsk, prelude::*};
use nsh_core::{
    Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId, ObjectPosition,
    PayloadValue, ResizeMode,
    access::Access,
    geometry::{DevicePixels, Points, Size, size},
    image::{CacheHeaders, DiskCache, Fetched},
};
use rustc_hash::FxHashMap;

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

/// Decoded textures kept in memory, in bytes (4 per pixel).
const CACHE_BYTES: usize = 128 << 20;

/// The largest download or file read.
const MAX_BYTES: u64 = 64 << 20;

/// Loader threads: reads, downloads and decodes run there.
const WORKERS: usize = 4;

/// Progress reports at most this often (a download reports its end too).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Where bundled (`asset:/…`) files are.
#[derive(Debug, Clone)]
pub enum AssetBase {
    /// Served over HTTP (the dev server): `http://host:port/assets/`.
    Http(String),
    /// A directory on disk.
    Directory(std::path::PathBuf),
}

/// Reads `asset:/…` files for the engine (fonts), on the engine thread.
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
            Some(location) => {
                read(&location, &Access::default(), None, &mut |_, _| {}).map(|b| b.to_vec())
            }
            None => Err(format!("{uri}: no asset location configured")),
        }
    }
}

/// The disk cache of what this surface's images download (`None`: none).
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

/// Where this surface's images resolve `asset:/` URIs.
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
    /// A `data:` URI (decoded on the worker): `Image.getSize`'s; a view's
    /// source arrives decoded ([`Location::Memory`]).
    Data(String),
    /// Bytes in memory (a decoded `data:` URI, a blob), by the source's
    /// URI.
    Memory(String, ImageData),
}

impl Location {
    /// The cache key: the same location is the same image, whatever URI
    /// named it.
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
    if uri.starts_with("file:") {
        return glib::filename_from_uri(uri)
            .ok()
            .map(|(path, _)| Location::File(path));
    }
    uri.starts_with('/').then(|| Location::File(uri.into()))
}

/// The bytes of a `data:` URI (base64 or percent-encoded).
fn data_uri(uri: &str) -> Result<Vec<u8>, String> {
    nsh_core::image::decode_data_uri(uri).map(|(_, bytes)| bytes)
}

/// Redirects followed at most (as `fetch`).
const MAX_REDIRECTS: usize = 20;

/// The HTTP agent all downloads share. It never follows redirects: each hop
/// is checked against the app's capabilities before it is requested.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .build()
            .into()
    })
}

/// GETs `url` with `headers`, following redirects one hop at a time: a hop
/// the app is not granted is never requested.
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
        url = access.media_redirect(&url, location)?;
    }
    Err("too many redirects".to_owned())
}

/// GETs `url` with `headers` (a revalidation's conditions), following
/// redirects one hop at a time (a hop the app is not granted is never
/// requested), and reads the body as it arrives (`progress(loaded,
/// total)`, total 0: unknown). Every status is a response: the cache
/// decides what a `304` or a `5xx` means.
fn download(
    url: &str,
    access: &Access,
    headers: &[(&'static str, String)],
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
    let mut reader = response.body_mut().with_config().limit(MAX_BYTES).reader();
    let mut bytes = Vec::with_capacity(total.min(MAX_BYTES) as usize);
    let mut chunk = [0u8; 16 << 10];
    loop {
        let n = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        progress(bytes.len() as u64, total);
    }
    Ok(Fetched::new(status, cache, bytes))
}

/// Reads the bytes at `location` (blocking), calling `progress(loaded,
/// total)` (total 0: unknown) as a download goes; a download through
/// `cache` (the surface's disk cache, for `http(s)://` sources) when
/// there is one.
fn read(
    location: &Location,
    access: &Access,
    cache: Option<&DiskCache>,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<ImageData, String> {
    match location {
        Location::File(path) => std::fs::read(path)
            .map(ImageData::from)
            .map_err(|e| format!("{}: {e}", path.display())),
        Location::Data(uri) => data_uri(uri).map(ImageData::from),
        Location::Memory(_, data) => Ok(data.clone()),
        Location::Url(url) => match cache {
            Some(cache) => cache.load(url, |headers| download(url, access, headers, progress)),
            None => {
                download(url, access, &[], progress).and_then(|response| match response.status {
                    200..=299 => Ok(response.body.into()),
                    status => Err(format!("HTTP {status}")),
                })
            }
        }
        .map_err(|e| format!("{url}: {e}")),
    }
}

/// Frames of an animated image decoded at most (as iOS; longer ones stop
/// at the last of them).
const MAX_FRAMES: usize = 600;

/// The most bytes one animation's frames take: larger animations show
/// their first frame.
const MAX_ANIMATION_BYTES: usize = 48 << 20;

/// A decoded image.
#[derive(Clone)]
struct Picture {
    /// The image, or an animation's first frame.
    texture: gdk::Texture,
    animation: Option<Arc<Animation>>,
    /// An SVG's intrinsic size: what it lays out at and reports, whatever
    /// its file name says.
    points: Option<Size<Points>>,
}

impl Picture {
    fn still(texture: gdk::Texture) -> Self {
        Picture {
            texture,
            animation: None,
            points: None,
        }
    }

    /// Bytes its pixels take (4 per pixel, every frame).
    fn bytes(&self) -> usize {
        let frame =
            self.texture.width().max(0) as usize * self.texture.height().max(0) as usize * 4;
        frame * self.animation.as_ref().map_or(1, |a| a.frames.len())
    }
}

/// The frames of an animated image.
struct Animation {
    frames: Vec<gdk::Texture>,
    /// Each frame's delay in ms.
    delays: Vec<u32>,
    /// Plays before it stops on its last frame; 0: forever.
    plays: u32,
}

/// A frame's delay in ms: as browsers and iOS, delays under 20ms (often
/// written as 0 by tools that meant "fast") show for 100ms.
fn frame_delay(delay: image::Delay) -> u32 {
    let (numer, denom) = delay.numer_denom_ms();
    match numer / denom.max(1) {
        ms if ms >= 20 => ms,
        _ => 100,
    }
}

/// An RGBA buffer as a texture.
fn texture(rgba: image::RgbaImage) -> gdk::Texture {
    let (width, height) = rgba.dimensions();
    let pixels = glib::Bytes::from_owned(rgba.into_raw());
    gdk::MemoryTexture::new(
        width as i32,
        height as i32,
        gdk::MemoryFormat::R8g8b8a8,
        &pixels,
        width as usize * 4,
    )
    .upcast()
}

/// The container `bytes` start with, if it may hold an animation.
fn animated_format(bytes: &[u8]) -> Option<image::ImageFormat> {
    if bytes.starts_with(b"GIF8") {
        Some(image::ImageFormat::Gif)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(image::ImageFormat::WebP)
    } else {
        None
    }
}

/// Decodes the frames of a GIF or WebP; `None` when it is a still image
/// (or too large to animate: then it decodes as one).
fn animation(bytes: &[u8], format: image::ImageFormat) -> Result<Option<Picture>, String> {
    use image::{AnimationDecoder, metadata::LoopCount};
    let cursor = std::io::Cursor::new(bytes);
    let error = |e: image::ImageError| e.to_string();
    let (frames, loops) = match format {
        image::ImageFormat::Gif => {
            let decoder = image::codecs::gif::GifDecoder::new(cursor).map_err(error)?;
            let loops = decoder.loop_count();
            (decoder.into_frames(), loops)
        }
        _ => {
            let decoder = image::codecs::webp::WebPDecoder::new(cursor).map_err(error)?;
            if !decoder.has_animation() {
                return Ok(None);
            }
            let loops = decoder.loop_count();
            (decoder.into_frames(), loops)
        }
    };
    let plays = match loops {
        LoopCount::Infinite => 0,
        // GIF counts repetitions after the first play (as browsers read
        // it), WebP plays.
        LoopCount::Finite(n) if format == image::ImageFormat::Gif => n.get().saturating_add(1),
        LoopCount::Finite(n) => n.get(),
    };
    let (mut textures, mut delays, mut total) = (Vec::new(), Vec::new(), 0);
    for frame in frames.take(MAX_FRAMES) {
        let frame = match frame {
            Ok(frame) => frame,
            // A damaged frame ends the animation; what decoded plays.
            Err(e) if !textures.is_empty() => {
                log::debug!("image: animation cut short: {e}");
                break;
            }
            Err(e) => return Err(error(e)),
        };
        let delay = frame_delay(frame.delay());
        let buffer = frame.into_buffer();
        total += buffer.as_raw().len();
        if total > MAX_ANIMATION_BYTES {
            log::debug!("image: animation over {MAX_ANIMATION_BYTES} bytes: its first frame shows");
            textures.truncate(1);
            delays.truncate(1);
            if textures.is_empty() {
                textures.push(texture(buffer));
            }
            break;
        }
        textures.push(texture(buffer));
        delays.push(delay);
    }
    let Some(first) = textures.first().cloned() else {
        return Err("no frames".into());
    };
    if textures.len() == 1 {
        return Ok(Some(Picture::still(first)));
    }
    Ok(Some(Picture {
        texture: first,
        animation: Some(Arc::new(Animation {
            frames: textures,
            delays,
            plays,
        })),
        points: None,
    }))
}

/// Draws an SVG oversampled into a texture; any thread.
fn decode_svg(bytes: &[u8]) -> Result<Picture, String> {
    let raster = nsh_core::svg::rasterize_oversampled(bytes).map_err(|e| e.to_string())?;
    let (width, height) = (raster.width, raster.height);
    let pixels = glib::Bytes::from_owned(raster.pixels);
    let texture: gdk::Texture = gdk::MemoryTexture::new(
        width as i32,
        height as i32,
        gdk::MemoryFormat::R8g8b8a8Premultiplied,
        &pixels,
        width as usize * 4,
    )
    .upcast();
    Ok(Picture {
        points: Some(raster.size),
        ..Picture::still(texture)
    })
}

/// The size `onLoad` and `Image.getSize` report: pixels, or an SVG's whole
/// points.
fn reported_size(picture: &Picture) -> Size<DevicePixels> {
    match picture.points {
        Some(points) => nsh_core::svg::reported_size(points),
        None => size(
            DevicePixels(picture.texture.width()),
            DevicePixels(picture.texture.height()),
        ),
    }
}

/// Decodes an encoded image (any thread): SVG with the shared rasterizer,
/// GIF and WebP with the `image` crate (every frame of animations), others
/// with GDK's loaders first.
fn decode(bytes: impl AsRef<[u8]> + Send + 'static) -> Result<Picture, String> {
    if nsh_core::svg::sniff(bytes.as_ref()) {
        return decode_svg(bytes.as_ref());
    }
    if let Some(format) = animated_format(bytes.as_ref()) {
        match animation(bytes.as_ref(), format) {
            Ok(Some(picture)) => return Ok(picture),
            Ok(None) => {}
            Err(e) => log::debug!("image: not decoded as an animation: {e}"),
        }
    }
    let bytes = glib::Bytes::from_owned(bytes);
    let gdk_error = match gdk::Texture::from_bytes(&bytes) {
        Ok(texture) => return Ok(Picture::still(texture)),
        Err(e) => e,
    };
    let image = image::load_from_memory(&bytes).map_err(|e| format!("{gdk_error}; {e}"))?;
    Ok(Picture::still(texture(image.into_rgba8())))
}

/// One load for the workers.
struct Job {
    key: String,
    location: Location,
    /// What the app may load, for the redirects.
    access: Arc<Access>,
    /// The disk cache it goes through (remote images).
    cache: Option<DiskCache>,
    /// Someone listens to `onProgress`.
    progress: bool,
}

/// Queues `job` on the worker pool (started on first use).
fn spawn(job: Job) {
    static POOL: OnceLock<crossbeam_channel::Sender<Job>> = OnceLock::new();
    let tx = POOL.get_or_init(|| {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..WORKERS {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("nsh-image-{i}"))
                .spawn(move || {
                    for job in rx {
                        work(job);
                    }
                });
            if let Err(e) = spawned {
                log::error!("cannot start an image loader thread: {e}");
            }
        }
        tx
    });
    let _ = tx.send(job);
}

/// Runs one job on a worker and hands the result to the main thread.
fn work(job: Job) {
    let Job {
        key,
        location,
        access,
        cache,
        progress,
    } = job;
    let mut last: Option<Instant> = None;
    let mut report = |loaded: u64, total: u64| {
        let now = Instant::now();
        let done = total > 0 && loaded >= total;
        if !progress || !(done || last.is_none_or(|t| now - t >= PROGRESS_INTERVAL)) {
            return;
        }
        last = Some(now);
        let key = key.clone();
        glib::MainContext::default().invoke(move || {
            LOADER.with(|l| l.progress(&key, loaded, total));
        });
    };
    let result = read(&location, &access, cache.as_ref(), &mut report).and_then(decode);
    glib::MainContext::default().invoke(move || finish(key, result));
}

/// Called with a load's picture or error.
type Done = Box<dyn FnOnce(Result<Picture, String>)>;

/// Called with a download's bytes so far and its size (0: unknown).
type Progress = Box<dyn Fn(u64, u64)>;

/// Someone waiting for a load.
struct Waiter {
    done: Done,
    progress: Option<Progress>,
}

/// A cached picture.
struct Entry {
    picture: Picture,
    bytes: usize,
    used: u64,
}

/// The main thread's texture cache and running loads.
#[derive(Default)]
struct Loader {
    cache: RefCell<FxHashMap<String, Entry>>,
    bytes: Cell<usize>,
    clock: Cell<u64>,
    inflight: RefCell<FxHashMap<String, Vec<Waiter>>>,
}

thread_local! {
    static LOADER: Loader = Loader::default();
}

impl Loader {
    fn tick(&self) -> u64 {
        let now = self.clock.get() + 1;
        self.clock.set(now);
        now
    }

    fn cached(&self, key: &str) -> Option<Picture> {
        let mut cache = self.cache.borrow_mut();
        let entry = cache.get_mut(key)?;
        entry.used = self.tick();
        Some(entry.picture.clone())
    }

    fn insert(&self, key: String, picture: Picture) {
        let bytes = picture.bytes();
        if bytes > CACHE_BYTES / 2 {
            return;
        }
        let used = self.tick();
        let mut cache = self.cache.borrow_mut();
        let mut total = self.bytes.get() + bytes;
        let entry = Entry {
            picture,
            bytes,
            used,
        };
        if let Some(old) = cache.insert(key, entry) {
            total -= old.bytes;
        }
        // Rare, and the cache holds hundreds of entries at most: a scan for
        // the oldest beats keeping an ordered index up to date on every hit.
        while total > CACHE_BYTES {
            let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(e) = cache.remove(&oldest) {
                total -= e.bytes;
            }
        }
        self.bytes.set(total);
    }

    fn progress(&self, key: &str, loaded: u64, total: u64) {
        if let Some(waiters) = self.inflight.borrow().get(key) {
            for p in waiters.iter().filter_map(|w| w.progress.as_ref()) {
                p(loaded, total);
            }
        }
    }
}

/// A load finished (main thread): caches it and calls the waiters.
fn finish(key: String, result: Result<Picture, String>) {
    let waiters = LOADER.with(|l| {
        if let Ok(picture) = &result {
            l.insert(key.clone(), picture.clone());
        }
        l.inflight.borrow_mut().remove(&key).unwrap_or_default()
    });
    for w in waiters {
        (w.done)(result.clone());
    }
}

/// Loads `uri` for `surface`; `done` runs on the main thread. Returns
/// whether it already ran (cached, or a source that cannot load).
fn fetch(surface: &Surface, uri: &str, progress: Option<Progress>, done: Done) -> bool {
    let location = resolve(uri, surface.asset_base.borrow().as_ref());
    fetch_at(surface, location, uri, progress, done)
}

/// Loads `source` for `surface` as [`fetch`] does: from its bytes, when it
/// carries them (a `data:` URI, a blob).
fn fetch_source(
    surface: &Surface,
    source: &ImageSource,
    progress: Option<Progress>,
    done: Done,
) -> bool {
    match &source.data {
        Some(data) => {
            let location = Location::Memory(source.uri.to_string(), data.clone());
            fetch_at(surface, Some(location), &source.uri, progress, done)
        }
        None => fetch(surface, &source.uri, progress, done),
    }
}

/// Loads `location` (`uri`'s) for `surface`, as [`fetch`] does.
fn fetch_at(
    surface: &Surface,
    location: Option<Location>,
    uri: &str,
    progress: Option<Progress>,
    done: Done,
) -> bool {
    let Some(location) = location else {
        done(Err(format!("unsupported image source `{uri}`")));
        return true;
    };
    let key = location.key();
    if let Some(picture) = LOADER.with(|l| l.cached(&key)) {
        done(Ok(picture));
        return true;
    }
    let listens = progress.is_some();
    let start = LOADER.with(|l| {
        let mut inflight = l.inflight.borrow_mut();
        let waiters = inflight.entry(key.clone()).or_default();
        waiters.push(Waiter { done, progress });
        waiters.len() == 1
    });
    if start {
        spawn(Job {
            key,
            location,
            access: surface.access.borrow().clone(),
            cache: disk_cache(surface, uri),
            progress: listens,
        });
    }
    false
}

/// Loads the bitmap `uri` (`https://…`, `asset:/…`, a file path, `data:`)
/// for a canvas off the main thread, through the texture cache; `done` runs
/// on the main thread with the image (an animation's first frame).
/// Canvases draw bitmaps: an SVG is an image that failed to load.
///
/// A cached texture is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
pub(crate) fn load_bitmap(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<gdk::Texture, String>) + 'static,
) {
    let source = uri.to_owned();
    let done = move |result: Result<Picture, String>| {
        done(result.and_then(|p| match p.points {
            Some(_) => Err(format!(
                "{source} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
            )),
            None => Ok(p.texture),
        }));
    };
    fetch(surface, uri, None, Box::new(done));
}

/// The texture of `uri` (an animation's first frame) if it is cached (to
/// draw without waiting).
#[allow(dead_code)]
pub(crate) fn cached(surface: &Surface, uri: &str) -> Option<gdk::Texture> {
    let key = resolve(uri, surface.asset_base.borrow().as_ref())?.key();
    LOADER.with(|l| l.cached(&key)).map(|p| p.texture)
}

/// `Command::ImageInfo` (`Image.getSize`, `Image.prefetch`): loads the
/// image into the texture cache and reports its size in pixels (an SVG's:
/// its intrinsic size in points).
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    let Command::ImageInfo { id, uri } = command else {
        return;
    };
    let request = *id;
    let weak = Rc::downgrade(surface);
    let done = move |result: Result<Picture, String>| {
        let Some(surface) = weak.upgrade() else {
            return;
        };
        let mut fields = vec![("id", PayloadValue::Number(request as f64))];
        match result {
            Ok(picture) => {
                let size = reported_size(&picture);
                fields.push(("width", PayloadValue::Number(size.width.0 as f64)));
                fields.push(("height", PayloadValue::Number(size.height.0 as f64)));
            }
            Err(message) => fields.push(("error", PayloadValue::Str(message))),
        }
        surface.event(
            nsh_core::ROOT_ID,
            EventKind::ImageInfo,
            EventPayload::Map(fields),
        );
    };
    fetch(surface, uri, None, Box::new(done));
}

/// A fade-in in progress.
#[derive(Debug, Clone, Copy)]
struct Fade {
    /// Frame time it started (µs); set on the first tick.
    start: Option<i64>,
    /// Duration in µs.
    duration: i64,
}

/// What an image view shows.
#[derive(Default)]
pub(crate) struct ImageState {
    source: Option<ImageSource>,
    mode: ResizeMode,
    options: ImageOptions,
    /// The source's picture, once loaded.
    image: Option<Picture>,
    /// The placeholder's picture, until the image shows.
    placeholder: Option<Picture>,
    /// Bumped on every source change: older loads are stale.
    generation: u64,
    /// The image's opacity while it fades in.
    alpha: f32,
    fade: Option<Fade>,
    /// The source's animation, playing.
    playback: Option<Playback>,
    /// The view's map / unmap handlers (start and pause playback) are
    /// connected.
    hooked: bool,
}

/// Where an animation is in its timeline: pure bookkeeping, in monotonic
/// time (µs).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Timeline {
    /// The frame showing.
    frame: usize,
    /// When it ends; `None` until the first step after (re)starting, so a
    /// paused animation resumes on the frame it was.
    due: Option<i64>,
    /// Plays completed.
    played: u32,
}

impl Timeline {
    /// Whether it played its count (`plays`, 0: forever) and stopped.
    fn finished(&self, plays: u32) -> bool {
        plays > 0 && self.played >= plays
    }

    /// Advances to time `now` through frames of `delays` (ms);
    /// returns whether the frame changed and whether it plays on.
    fn advance(&mut self, delays: &[u32], plays: u32, now: i64) -> (bool, bool) {
        let len = delays.len();
        if len < 2 || self.finished(plays) {
            return (false, false);
        }
        let ms = |frame: usize| i64::from(delays[frame].max(1)) * 1000;
        let mut due = *self.due.get_or_insert(now + ms(self.frame));
        if now < due {
            return (false, true);
        }
        // Far behind (a stalled main loop): carry on from now rather than
        // racing through the frames missed.
        if now - due > 1_000_000 {
            due = now;
        }
        let mut changed = false;
        while now >= due {
            let mut next = self.frame + 1;
            if next == len {
                self.played += 1;
                if self.finished(plays) {
                    // Stays on its last frame, as browsers.
                    self.due = None;
                    return (changed, false);
                }
                next = 0;
            }
            self.frame = next;
            changed = true;
            due += ms(next);
        }
        self.due = Some(due);
        (changed, true)
    }
}

/// An animation playing in a view.
struct Playback {
    animation: Arc<Animation>,
    timeline: Timeline,
    /// The timer of the next frame, while it plays.
    timer: Option<glib::SourceId>,
    /// Bumped per timer: a timer that is not the latest is stale.
    serial: u64,
}

impl Playback {
    /// The frame to draw.
    fn texture(&self) -> &gdk::Texture {
        &self.animation.frames[self.timeline.frame]
    }

    /// Stops the timer; it resumes on the frame it was.
    fn pause(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.remove();
        }
        self.timeline.due = None;
    }

    /// Advances to now; schedules the next frame (for `view`) while it
    /// plays. Returns whether the frame changed.
    fn advance(&mut self, view: &NshView) -> bool {
        let now = glib::monotonic_time();
        let a = &self.animation;
        let (changed, running) = self.timeline.advance(&a.delays, a.plays, now);
        if let Some(due) = self.timeline.due.filter(|_| running) {
            let weak = view.downgrade();
            // GLib's timeouts count whole milliseconds, rounded down: one
            // that fires early would spin until the frame is due.
            let wait = Duration::from_millis(((due - now).max(0) as u64).div_ceil(1000));
            self.serial += 1;
            let serial = self.serial;
            self.timer = Some(glib::timeout_add_local_once(wait, move || {
                if let Some(view) = weak.upgrade() {
                    step(&view, serial);
                }
            }));
        }
        changed
    }
}

/// Plays `view`'s animation from where it is, while the view is mapped.
fn play(view: &NshView) {
    if !view.is_mapped() {
        return;
    }
    let mut s = view.state_mut();
    if let Some(p) = s.image.as_mut().and_then(|i| i.playback.as_mut())
        && p.timer.is_none()
    {
        p.advance(view);
    }
}

/// Pauses `view`'s animation (the view was unmapped).
fn pause(view: &NshView) {
    if let Some(p) = view
        .state_mut()
        .image
        .as_mut()
        .and_then(|i| i.playback.as_mut())
    {
        p.pause();
    }
}

/// Timer `serial` of `view`'s next frame fired.
fn step(view: &NshView, serial: u64) {
    let changed = {
        let mut s = view.state_mut();
        let hidden = s.style.hidden;
        let Some(p) = s
            .image
            .as_mut()
            .and_then(|i| i.playback.as_mut())
            .filter(|p| p.serial == serial)
        else {
            return;
        };
        // It ran: removing it again would be an error.
        p.timer = None;
        p.advance(view) && !hidden
    };
    if changed {
        view.changed();
    }
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
    let (generation, needs_image, events, id) = {
        let mut s = view.state_mut();
        let (events, id) = (s.events, s.id);
        let image = s.image.get_or_insert_with(ImageState::default);
        let same_source = image.source.as_ref() == source;
        let same_placeholder = image.options.placeholder == options.placeholder;
        image.mode = mode;
        image.options = options.clone();
        if same_source && same_placeholder {
            drop(s);
            view.changed();
            return;
        }
        image.generation += 1;
        if !same_source {
            image.source = source.cloned();
            image.image = None;
            image.fade = None;
            if let Some(mut p) = image.playback.take() {
                p.pause();
            }
        }
        if !same_placeholder {
            image.placeholder = None;
        }
        (image.generation, image.image.is_none(), events, id)
    };
    view.changed();
    let weak = view.downgrade();
    // The image first: when it is cached, the placeholder is not needed.
    if let Some(source) = source.filter(|_| needs_image) {
        let progress = events.contains(EventKind::Progress).then(|| {
            let surface = Rc::downgrade(surface);
            let weak = weak.clone();
            Box::new(move |loaded: u64, total: u64| {
                let current = weak.upgrade().is_some_and(|v| {
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
            move |result: Result<Picture, String>| {
                if let (Some(view), Some(surface)) = (weak.upgrade(), surface.upgrade()) {
                    loaded(&surface, &view, generation, result, waited.get());
                }
            }
        };
        let immediate = fetch_source(surface, source, progress, Box::new(done));
        waited.set(true);
        if !immediate && events.contains(EventKind::LoadStart) {
            surface.event(id, EventKind::LoadStart, EventPayload::None);
        }
    }
    let wants_placeholder = view
        .state()
        .image
        .as_ref()
        .is_some_and(|i| i.image.is_none() && i.placeholder.is_none());
    if let Some(placeholder) = options.placeholder.as_ref().filter(|_| wants_placeholder) {
        let done = move |result: Result<Picture, String>| {
            let Some(view) = weak.upgrade() else { return };
            match result {
                Ok(picture) => {
                    if let Some(i) = view.state_mut().image.as_mut()
                        && i.generation == generation
                    {
                        i.placeholder = Some(picture);
                    }
                    view.changed();
                }
                Err(message) => log::warn!("image placeholder failed: {message}"),
            }
        };
        fetch_source(surface, placeholder, None, Box::new(done));
    }
}

/// The source of `view` loaded (or failed); `waited`: it was not cached,
/// so it fades in (when the app asked for a fade).
fn loaded(
    surface: &Surface,
    view: &NshView,
    generation: u64,
    result: Result<Picture, String>,
    waited: bool,
) {
    let (events, id, fades, hook) = {
        let mut s = view.state_mut();
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        let mut hook = false;
        match &result {
            Ok(picture) => {
                image.image = Some(picture.clone());
                if let Some(mut old) = image.playback.take() {
                    old.pause();
                }
                image.playback = picture.animation.clone().map(|animation| Playback {
                    animation,
                    timeline: Timeline::default(),
                    timer: None,
                    serial: 0,
                });
                hook = image.playback.is_some() && !std::mem::replace(&mut image.hooked, true);
                let ms = image.options.fade_ms.unwrap_or(0.0);
                image.alpha = 1.0;
                image.fade = None;
                if waited && ms > 0.0 {
                    image.alpha = 0.0;
                    image.fade = Some(Fade {
                        start: None,
                        duration: (ms * 1000.0) as i64,
                    });
                }
            }
            Err(message) => log::warn!("image failed: {message}"),
        }
        (events, id, image.fade.is_some(), hook)
    };
    if fades {
        view.add_tick_callback(|view, clock| fade_tick(view, clock.frame_time()));
    }
    if hook {
        view.connect_map(play);
        view.connect_unmap(pause);
    }
    play(view);
    view.changed();
    match &result {
        Ok(picture) if events.contains(EventKind::Load) => surface.event(
            id,
            EventKind::Load,
            EventPayload::Image(reported_size(picture)),
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

/// Advances a fade-in to frame time `now` (µs).
fn fade_tick(view: &NshView, now: i64) -> glib::ControlFlow {
    let running = {
        let mut s = view.state_mut();
        let Some(image) = s.image.as_mut() else {
            return glib::ControlFlow::Break;
        };
        let Some(fade) = image.fade.as_mut() else {
            return glib::ControlFlow::Break;
        };
        let start = *fade.start.get_or_insert(now);
        let t = ((now - start) as f32 / fade.duration.max(1) as f32).min(1.0);
        image.alpha = t;
        if t >= 1.0 {
            image.fade = None;
        }
        t < 1.0
    };
    view.changed();
    if running {
        glib::ControlFlow::Continue
    } else {
        glib::ControlFlow::Break
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

/// The natural size in points of `texture` loaded from `source`: the size
/// the source declares, an SVG's intrinsic size (`points`), or its pixels
/// over the file name's density.
fn natural(
    texture: &gdk::Texture,
    points: Option<Size<Points>>,
    source: Option<&ImageSource>,
) -> (f32, f32) {
    if let Some(size) = source
        .and_then(|s| s.size)
        .map(|s| (s.width.0, s.height.0))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
    {
        return size;
    }
    if let Some(points) = points {
        return (points.width.0, points.height.0);
    }
    let d = source.map_or(1.0, |s| density(&s.uri));
    (texture.width() as f32 / d, texture.height() as f32 / d)
}

/// Where an image of natural size `natural` goes in a box of `bounds`
/// (x, y, width, height), as React Native fits it and `objectPosition` places it; it may extend past the
/// box (`cover`), which the view clips.
fn fit(
    mode: ResizeMode,
    position: ObjectPosition,
    natural: (f32, f32),
    bounds: (f32, f32),
) -> (f32, f32, f32, f32) {
    use nsh_core::geometry::{px, size};
    let r = mode.fit(
        size(px(natural.0), px(natural.1)),
        size(px(bounds.0), px(bounds.1)),
        position,
    );
    (r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0)
}

/// Draws `texture` at `rect` (points); mipmaps when it shrinks more than
/// a 2× screen would.
fn draw_texture(snapshot: &gtk::Snapshot, texture: &gdk::Texture, rect: &graphene::Rect) {
    let filter = if texture.width() as f32 > rect.width() * 2.0 {
        gsk::ScalingFilter::Trilinear
    } else {
        gsk::ScalingFilter::Linear
    };
    snapshot.append_scaled_texture(texture, filter, rect);
}

/// Draws one picture (`texture`, the frame showing) with the view's mode,
/// tint and blur.
fn draw_one(
    snapshot: &gtk::Snapshot,
    state: &ViewState,
    image: &ImageState,
    (texture, points): (&gdk::Texture, Option<Size<Points>>),
    source: Option<&ImageSource>,
) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let (x, y, fw, fh) = fit(
        image.mode,
        image.options.position,
        natural(texture, points, source),
        (w, h),
    );
    let mut rect = graphene::Rect::new(x, y, fw, fh);
    let blur = image.options.blur_radius.0.max(0.0);
    if blur > 0.0 {
        // Enlarged under a clip to its own rectangle: the blur's
        // transparent fringe falls outside.
        let clip = rect
            .intersection(&graphene::Rect::new(0.0, 0.0, w, h))
            .unwrap_or(rect);
        snapshot.push_clip(&clip);
        snapshot.push_blur(blur as f64);
        let grow = 2.0 * blur;
        rect = graphene::Rect::new(x - grow, y - grow, fw + 2.0 * grow, fh + 2.0 * grow);
    }
    match state.style.tint_color {
        Some(tint) => {
            // The mask is recorded first, then the source.
            snapshot.push_mask(gsk::MaskMode::Alpha);
            draw_texture(snapshot, texture, &rect);
            snapshot.pop();
            snapshot.append_color(&crate::decor::rgba(tint), &rect);
            snapshot.pop();
        }
        None => draw_texture(snapshot, texture, &rect),
    }
    if blur > 0.0 {
        snapshot.pop();
        snapshot.pop();
    }
}

/// Draws an image view's picture.
pub(crate) fn draw(snapshot: &gtk::Snapshot, state: &ViewState) {
    let Some(image) = &state.image else { return };
    let fading = image.fade.is_some();
    if let Some(placeholder) = &image.placeholder
        && (image.image.is_none() || fading)
    {
        let source = image.options.placeholder.as_ref();
        let shown = (&placeholder.texture, placeholder.points);
        draw_one(snapshot, state, image, shown, source);
    }
    let Some(picture) = &image.image else {
        return;
    };
    let texture = image
        .playback
        .as_ref()
        .map(Playback::texture)
        .unwrap_or(&picture.texture);
    let alpha = if fading { image.alpha } else { 1.0 };
    if alpha <= 0.0 {
        return;
    }
    if alpha < 1.0 {
        snapshot.push_opacity(alpha as f64);
    }
    let shown = (texture, picture.points);
    draw_one(snapshot, state, image, shown, image.source.as_ref());
    if alpha < 1.0 {
        snapshot.pop();
    }
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
            resolve("https://x.org/a.jpg", None),
            Some(Location::Url("https://x.org/a.jpg".into()))
        );
        assert_eq!(
            resolve("file:///home/a%20b.png", None),
            Some(Location::File("/home/a b.png".into()))
        );
        assert_eq!(
            resolve("/home/a.png", None),
            Some(Location::File("/home/a.png".into()))
        );
        assert_eq!(resolve("relative.png", None), None);
        assert!(matches!(
            resolve("data:image/png;base64,AA==", None),
            Some(Location::Data(_))
        ));
    }

    #[test]
    fn decodes_data_uris() {
        assert_eq!(data_uri("data:image/png;base64,aGk=").unwrap(), b"hi");
        assert_eq!(data_uri("data:text/plain,a%20b%zz").unwrap(), b"a b%zz");
        assert!(data_uri("data:nocomma").is_err());
    }

    #[test]
    fn reads_densities() {
        assert_eq!(density("asset:/logo@2x.png"), 2.0);
        assert_eq!(density("asset:/a@3x.webp"), 3.0);
        assert_eq!(density("https://x.org/me@home/a.png"), 1.0);
        assert_eq!(density("a.png"), 1.0);
    }

    #[test]
    fn plays_animations() {
        let delays = [100, 50, 200];
        let mut t = Timeline::default();
        // The first step starts the clock.
        assert_eq!(t.advance(&delays, 0, 1_000_000), (false, true));
        assert_eq!(t.advance(&delays, 0, 1_099_000), (false, true));
        assert_eq!(t.advance(&delays, 0, 1_100_000), (true, true));
        assert_eq!(t.frame, 1);
        // A late step skips the frames it missed.
        assert_eq!(t.advance(&delays, 0, 1_400_000), (true, true));
        assert_eq!((t.frame, t.played), (0, 1));
        // Far behind: from now on.
        assert_eq!(t.advance(&delays, 0, 9_000_000), (true, true));
        assert_eq!((t.frame, t.due), (1, Some(9_050_000)));
    }

    #[test]
    fn stops_after_its_plays() {
        let delays = [100, 100];
        let mut t = Timeline::default();
        t.advance(&delays, 1, 0);
        assert_eq!(t.advance(&delays, 1, 100_000), (true, true));
        // The end of the only play: stays on the last frame.
        assert_eq!(t.advance(&delays, 1, 200_000), (false, false));
        assert_eq!(t.frame, 1);
        assert!(t.finished(1));
        assert_eq!(t.advance(&delays, 1, 900_000), (false, false));
        // One frame never plays.
        assert_eq!(Timeline::default().advance(&[100], 0, 0), (false, false));
    }

    #[test]
    fn times_frames() {
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(70, 1)), 70);
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(0, 1)), 100);
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(10, 1)), 100);
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(41, 2)), 20);
    }

    #[test]
    fn sniffs_animated_formats() {
        assert_eq!(animated_format(b"GIF89a..."), Some(image::ImageFormat::Gif));
        assert_eq!(
            animated_format(b"RIFF\0\0\0\0WEBPVP8X"),
            Some(image::ImageFormat::WebP)
        );
        assert_eq!(animated_format(b"\x89PNG\r\n"), None);
        assert_eq!(animated_format(b"RIFF"), None);
    }

    const SVG_LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f" fill-opacity="0.5"/></svg>"##;

    /// The texture's pixels as premultiplied BGRA (Cairo's ARGB32 on a
    /// little-endian machine), row by row.
    fn pixels(texture: &gdk::Texture) -> Vec<u8> {
        let (w, h) = (texture.width() as usize, texture.height() as usize);
        let mut data = vec![0u8; w * h * 4];
        texture.download(&mut data, w * 4);
        data
    }

    #[test]
    fn svg_decodes_oversampled() {
        let picture = decode(SVG_LOGO).unwrap();
        let texture = &picture.texture;
        assert_eq!(
            (texture.width(), texture.height()),
            (192, 96),
            "four pixels a point"
        );
        assert_eq!(picture.points, Some(Size::new(Points(48.0), Points(24.0))));
        let data = pixels(texture);
        let at = |x: usize, y: usize| -> [u8; 4] {
            let i = (y * 192 + x) * 4;
            data[i..i + 4].try_into().unwrap()
        };
        assert_eq!(at(10, 10), [0, 0, 255, 255]);
        let [b, g, r, a] = at(150, 50);
        assert!((127..=128).contains(&a), "alpha {a}");
        assert_eq!((b, g, r), (a, 0, 0));
        let big = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250"/>"#;
        let big = decode(big).unwrap();
        assert_eq!((big.texture.width(), big.texture.height()), (2048, 512));
        assert!(decode(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect").is_err());
    }

    #[test]
    fn svg_size_is_in_points() {
        let picture = decode(SVG_LOGO).unwrap();
        assert_eq!(
            reported_size(&picture),
            size(DevicePixels(48), DevicePixels(24))
        );
        let source = ImageSource {
            uri: "asset:/logo@2x.svg".into(),
            size: None,
            scales: nsh_core::ImageScales::NONE,
            data: None,
        };
        assert_eq!(
            natural(&picture.texture, picture.points, Some(&source)),
            (48.0, 24.0)
        );
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decode(odd).unwrap();
        assert_eq!(natural(&odd.texture, odd.points, None), (10.5, 10.0));
        assert_eq!(
            reported_size(&odd),
            size(DevicePixels(11), DevicePixels(10))
        );
        // Bitmaps keep their pixels.
        let bitmap = Picture::still(texture(image::RgbaImage::new(20, 10)));
        assert_eq!(bitmap.points, None);
        assert_eq!(
            reported_size(&bitmap),
            size(DevicePixels(20), DevicePixels(10))
        );
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` masks the color with the texture's alpha: the shape
        // is opaque, the rest transparent.
        let icon = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>"##;
        let picture = decode(icon).unwrap();
        let data = pixels(&picture.texture);
        let alpha = |x: usize, y: usize| data[(y * 96 + x) * 4 + 3];
        assert_eq!(alpha(48, 48), 255);
        assert_eq!(alpha(2, 2), 0);
    }

    #[test]
    fn decodes_animations() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/gallery");
        for (name, format) in [
            ("bounce.gif", image::ImageFormat::Gif),
            ("spinner.webp", image::ImageFormat::WebP),
        ] {
            let bytes = std::fs::read(dir.join(name)).unwrap();
            assert_eq!(animated_format(&bytes), Some(format));
            let picture = animation(&bytes, format).unwrap().unwrap();
            let animation = picture.animation.expect(name);
            assert!(animation.frames.len() > 1, "{name}");
            assert_eq!(animation.frames.len(), animation.delays.len());
            assert!(animation.delays.iter().all(|&d| d >= 20));
        }
    }

    #[test]
    fn fits_images() {
        let n = (200.0, 100.0);
        let b = (100.0, 100.0);
        assert_eq!(
            fit(ResizeMode::Cover, ObjectPosition::CENTER, n, b),
            (-50.0, 0.0, 200.0, 100.0)
        );
        assert_eq!(
            fit(ResizeMode::Contain, ObjectPosition::CENTER, n, b),
            (0.0, 25.0, 100.0, 50.0)
        );
        assert_eq!(
            fit(ResizeMode::Stretch, ObjectPosition::CENTER, n, b),
            (0.0, 0.0, 100.0, 100.0)
        );
        // CSS's `object-fit: none` and `scale-down`.
        assert_eq!(
            fit(ResizeMode::Center, ObjectPosition::CENTER, n, b),
            (-50.0, 0.0, 200.0, 100.0)
        );
        assert_eq!(
            fit(ResizeMode::ScaleDown, ObjectPosition::CENTER, n, b),
            (0.0, 25.0, 100.0, 50.0)
        );
        for mode in [ResizeMode::Center, ResizeMode::ScaleDown] {
            assert_eq!(
                fit(mode, ObjectPosition::CENTER, n, (400.0, 400.0)),
                (100.0, 150.0, 200.0, 100.0)
            );
        }
        // `objectPosition`: a tall image covering its box shows its top.
        let top = ObjectPosition::parse("top").unwrap();
        assert_eq!(
            fit(ResizeMode::Cover, top, (100.0, 300.0), b),
            (0.0, 0.0, 100.0, 300.0)
        );
        let right = ObjectPosition::parse("right").unwrap();
        assert_eq!(
            fit(ResizeMode::Contain, right, (50.0, 100.0), b),
            (50.0, 0.0, 50.0, 100.0)
        );
    }
}
