//! Image views: loading (`asset:/`, files, HTTP; `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding into
//! GPUI images, drawing with the resize mode, corner radii, tint, blur,
//! filters, opacity and placeholder.
//!
//! Loads run on a small pool of worker threads: read the file or download
//! (ureq, following redirects one checked hop at a time; `onProgress` at
//! most every 100ms), decode with the `image` crate (PNG, JPEG, GIF, WebP,
//! BMP, ICO, TIFF; EXIF orientation applied; every frame of animated GIF
//! and WebP) into a GPUI [`RenderImage`] (straight BGRA, one frame per
//! animation frame) and hand it to the main thread with [`rt::invoke`].
//! SVG images (sniffed from their bytes) are drawn by [`nsh_core::svg`] at
//! their intrinsic size × [`nsh_core::svg::OVERSAMPLE`] (at most
//! [`nsh_core::svg::MAX_OVERSAMPLED_SIDE`] a side) and then handled as
//! bitmaps; their size is their intrinsic size in points. Canvases draw
//! bitmaps only ([`load_bitmap`]).
//! Decoded images are kept in a main-thread cache keyed by the resolved
//! location (so `asset:/` URIs of surfaces with different asset bases
//! never mix). Host-provided assets are keyed by their surface/load binding
//! and opaque URI. The cache is bounded by bytes and evicts the least recently used;
//! concurrent requests for one location share one load. Images decode at
//! their full size, up to [`MAX_DIMENSION`] pixels a side (larger ones are
//! scaled down on the worker: GPU textures have a size limit).
//!
//! GPUI draws an image as a sprite of its texture atlas, scaled bilinearly,
//! with rounded corners, inside rectangular content masks, and nothing
//! else: it has no color matrix, no blur, no mipmaps and no public way to
//! draw a sprite translucent. What GPUI cannot do is done on the pixels
//! instead: a picture keeps a few *variants* ([`Look`]) made on the worker
//! threads from its pixels: scaled down by powers of two when drawn much
//! smaller than its size (as mipmaps: no aliasing, smaller textures),
//! blurred (`blurRadius` and `filter: blur()`, a stack blur in pixels at
//! the variant's size, scaled down further for large radii), passed
//! through the color filters it is drawn with (the view's and its
//! ancestors', [`DrawCx::matrix`]), tinted
//! (`tintColor` paints its color through the image's alpha) and multiplied
//! by the view's opacity (quantized to [`ALPHA_STEPS`] levels: fades and
//! translucent screens). While a variant is being made, the closest one
//! that is ready is drawn. A texture leaves GPUI's atlases when its last
//! owner drops it ([`Texture`]). GPUI rounds the sprite: the corners of
//! the innermost rounded clip it reaches ([`DrawCx::clip_rounded`]).
//!
//! A file named `…@2x.png` (or a source with a declared size) has its
//! natural size scaled accordingly, as on iOS.
//!
//! Animated GIF and WebP images decode every frame (composited, at most
//! [`MAX_FRAMES`] and [`MAX_ANIMATION_BYTES`]: larger ones show their first
//! frame) with its delay, as browsers and iOS time them (under 20ms: 100ms),
//! and play their loop count. A view advances its frames with a timer at
//! each frame's delay ([`rt::after_ms`]), not on the frame ticker (a 10 fps
//! GIF need not keep the window redrawing at the display's rate), measured
//! on the monotonic clock so delays do not drift. Playback pauses when the
//! view was not drawn since its last frame change (it is hidden, off a
//! stack's top screen, removed) and resumes, on the frame it was, when it
//! is drawn again. `onLoad` comes once per load.
//!
//! The `placeholder` shows until the image arrives (and stays on error); an
//! image that had to load then fades in over `fadeDuration` (default 0, as
//! iOS).

use std::{
    cell::{Cell, RefCell},
    io::Read,
    path::PathBuf,
    rc::{Rc, Weak},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use gpui::{Corners, RenderImage};
use nsh_core::{
    Color, Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId,
    ObjectPosition, PayloadValue, ResizeMode,
    access::Access,
    geometry::{DevicePixels, Points, Size},
    image::{CacheHeaders, DiskCache, Fetched},
};
use rustc_hash::FxHashMap;

use crate::{
    render::DrawCx,
    rt,
    surface::Surface,
    view::{NshView, ViewState},
};

/// Decoded images kept in memory, in bytes (4 per pixel).
const CACHE_BYTES: usize = 128 << 20;

/// The largest download or file read.
const MAX_BYTES: u64 = 64 << 20;

/// Loader threads: reads, downloads, decodes and variants run there.
const WORKERS: usize = 4;

/// Progress reports at most this often (a download reports its end too).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// The longest side of a decoded image, in pixels: larger images are
/// scaled down on the worker (the texture size every GPU takes, and one
/// this size already takes 256 MB).
const MAX_DIMENSION: u32 = 8192;

/// Redirects followed at most (as `fetch`).
const MAX_REDIRECTS: usize = 20;

/// Variants a picture keeps (more while recent ones are still drawn).
const VARIANTS: usize = 4;

/// Opacity levels of variants: drawing at an opacity rounds it to one.
const ALPHA_STEPS: u8 = 16;

/// The largest stack blur radius at a variant's size, in pixels: larger
/// blurs scale the variant down first (a blur hides the lost detail).
const MAX_BLUR: f32 = 16.0;

/// Where bundled (`asset:/…`) files are.
#[derive(Debug, Clone)]
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
    pub(crate) fn file(&self, path: &str) -> Option<PathBuf> {
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

/// The default bundled location, or the reader bound to an engine load.
/// `Engine(None)` deliberately disables assets instead of falling back to a base.
#[derive(Default)]
pub(crate) enum AssetSource {
    #[default]
    Base,
    Engine(Option<Arc<dyn nsh_engine::Assets>>),
}

/// One worker's original source, retained until its read finishes.
enum LoadSource {
    Location(Location),
    Asset {
        uri: String,
        reader: Arc<dyn nsh_engine::Assets>,
    },
}

impl LoadSource {
    fn read(
        &self,
        access: &Access,
        cache: Option<&DiskCache>,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<ImageData, String> {
        match self {
            Self::Location(location) => read(location, access, cache, progress),
            Self::Asset { uri, reader } => {
                let bytes = reader.read(uri)?;
                if bytes.len() as u64 > MAX_BYTES {
                    return Err(format!("{uri}: image exceeds the encoded-byte limit"));
                }
                Ok(bytes.into())
            }
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
            Location::Data(uri) => uri.clone(),
            // App-written URIs must not address bytes carried by another
            // surface, even if they spell the core's internal image key.
            Location::Memory(uri, _) => format!("inline:{uri}"),
        }
    }
}

/// Resolves `uri` (`asset:/…` against `base`, `http(s)://`, `file:`, an
/// absolute path, `data:`).
fn resolve(uri: &str, base: Option<&AssetBase>) -> Option<Location> {
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
    if let Some(rest) = uri.strip_prefix("file:") {
        return file_uri(rest).map(Location::File);
    }
    absolute_path(uri).then(|| Location::File(uri.into()))
}

/// True for an absolute path of this system: `/…`; on Windows `C:\…`,
/// `C:/…` or a UNC path.
fn absolute_path(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        let drive = b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/');
        drive || path.starts_with("\\\\") || path.starts_with("//")
    } else {
        path.starts_with('/')
    }
}

/// The path of a `file:` URI (what follows `file:`): `///home/a%20b.png`
/// is `/home/a b.png`; on Windows `///C:/a.png` is `C:\a.png` and
/// `//server/share/a.png` is `\\server\share\a.png`.
fn file_uri(rest: &str) -> Option<PathBuf> {
    let decoded = String::from_utf8(percent_decode(rest.as_bytes())).ok()?;
    let path = match decoded.strip_prefix("//") {
        // `file:///…` (an empty host) or `file://localhost/…`.
        Some(after) => match after.split_once('/') {
            Some(("" | "localhost", path)) => format!("/{path}"),
            Some((host, path)) if cfg!(windows) => format!("//{host}/{path}"),
            _ => return None,
        },
        // `file:/…`.
        None => decoded,
    };
    if cfg!(windows) {
        // `/C:/…` is `C:\…`; `//host/…` stays a UNC path.
        let path = match path.strip_prefix('/') {
            Some(p) if !p.starts_with('/') => p.to_owned(),
            _ => path,
        };
        let path = path.replace('/', "\\");
        absolute_path(&path).then(|| path.into())
    } else {
        absolute_path(&path).then(|| path.into())
    }
}

/// `%xx` escapes decoded; malformed ones stay as they are.
fn percent_decode(bytes: &[u8]) -> Vec<u8> {
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

/// Swaps the red and blue channels of RGBA pixels in place: GPUI's images
/// are BGRA (straight alpha).
fn swap_red_blue(data: &mut [u8]) {
    for px in data.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
}

/// One frame for a [`RenderImage`]: `rgba` (straight RGBA) as BGRA.
fn bgra_frame(rgba: image::RgbaImage) -> image::Frame {
    let (w, h) = rgba.dimensions();
    let mut data = rgba.into_raw();
    swap_red_blue(&mut data);
    image::Frame::new(image::RgbaImage::from_raw(w, h, data).unwrap_or_default())
}

/// What a worker decoded (sent to the main thread).
struct Decoded {
    /// The image, every frame of an animation.
    image: Arc<RenderImage>,
    /// Each frame's delay in ms (animations).
    delays: Vec<u32>,
    /// Plays before it stops on its last frame; 0: forever.
    plays: u32,
    /// The source's size in pixels (before any scaling down; an SVG's:
    /// whole points).
    size: (u32, u32),
    /// An SVG's intrinsic size, unrounded: what it lays out at, whatever its
    /// file name says.
    points: Option<Size<Points>>,
}

impl Decoded {
    fn new(frames: Vec<image::Frame>, delays: Vec<u32>, plays: u32, size: (u32, u32)) -> Decoded {
        Decoded {
            image: Arc::new(RenderImage::new(frames)),
            delays,
            plays,
            size,
            points: None,
        }
    }
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
fn animation(bytes: &[u8], format: image::ImageFormat) -> Result<Option<Decoded>, String> {
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
    let (mut buffers, mut delays, mut total) = (Vec::new(), Vec::new(), 0);
    for frame in frames.take(MAX_FRAMES) {
        let frame = match frame {
            Ok(frame) => frame,
            // A damaged frame ends the animation; what decoded plays.
            Err(e) if !buffers.is_empty() => {
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
            buffers.truncate(1);
            delays.truncate(1);
            if buffers.is_empty() {
                buffers.push(buffer);
            }
            break;
        }
        buffers.push(buffer);
        delays.push(delay);
    }
    let Some(first) = buffers.first() else {
        return Err("no frames".into());
    };
    let size = first.dimensions();
    if buffers.len() == 1 {
        delays.clear();
    }
    let frames = buffers.into_iter().map(bgra_frame).collect();
    Ok(Some(Decoded::new(frames, delays, plays, size)))
}

/// The size an image of `size` pixels decodes at: its own, or scaled
/// down to [`MAX_DIMENSION`] a side.
fn bounded(size: (u32, u32)) -> (u32, u32) {
    let (w, h) = size;
    let longest = w.max(h);
    if longest <= MAX_DIMENSION {
        return size;
    }
    let f = MAX_DIMENSION as f64 / longest as f64;
    (
        ((w as f64 * f).round() as u32).max(1),
        ((h as f64 * f).round() as u32).max(1),
    )
}

/// Decodes a still image (any format the `image` crate reads), turned
/// upright as its EXIF orientation says.
fn decode_still(bytes: &[u8]) -> Result<Decoded, String> {
    use image::ImageDecoder;
    let error = |e: image::ImageError| e.to_string();
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(error)?;
    let orientation = decoder.orientation().ok();
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(error)?;
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }
    let size = (image.width(), image.height());
    if size.0 == 0 || size.1 == 0 {
        return Err("empty image".into());
    }
    let image = match bounded(size) {
        b if b == size => image,
        (w, h) => {
            log::debug!("image: {}x{} scaled down to {w}x{h}", size.0, size.1);
            image.resize(w, h, image::imageops::FilterType::Triangle)
        }
    };
    Ok(Decoded::new(
        vec![bgra_frame(image.into_rgba8())],
        Vec::new(),
        0,
        size,
    ))
}

/// Draws an SVG oversampled (premultiplied RGBA) into one straight BGRA
/// frame, which the variants then scale down as they do bitmaps.
fn decode_svg(bytes: &[u8]) -> Result<Decoded, String> {
    let raster = nsh_core::svg::rasterize_oversampled(bytes).map_err(|e| e.to_string())?;
    let mut data = raster.pixels;
    unpremultiply(&mut data);
    swap_red_blue(&mut data);
    let frame = image::RgbaImage::from_raw(raster.width, raster.height, data)
        .ok_or("SVG raster of the wrong size")?;
    let reported = nsh_core::svg::reported_size(raster.size);
    let size = (reported.width.0 as u32, reported.height.0 as u32);
    Ok(Decoded {
        points: Some(raster.size),
        ..Decoded::new(vec![image::Frame::new(frame)], Vec::new(), 0, size)
    })
}

/// Decodes an encoded image (a worker): every frame of animations.
fn decode(bytes: impl AsRef<[u8]>) -> Result<Decoded, String> {
    let bytes = bytes.as_ref();
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes);
    }
    if let Some(format) = animated_format(bytes) {
        match animation(bytes, format) {
            Ok(Some(decoded)) => return Ok(decoded),
            Ok(None) => {}
            Err(e) => log::debug!("image: not decoded as an animation: {e}"),
        }
    }
    decode_still(bytes)
}

/// Queues `job` on the worker pool (started on first use).
fn spawn(job: impl FnOnce() + Send + 'static) {
    type Job = Box<dyn FnOnce() + Send>;
    static POOL: OnceLock<crossbeam_channel::Sender<Job>> = OnceLock::new();
    let tx = POOL.get_or_init(|| {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..WORKERS {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("nsh-image-{i}"))
                .spawn(move || {
                    for job in rx {
                        job();
                    }
                });
            if let Err(e) = spawned {
                log::error!("cannot start an image loader thread: {e}");
            }
        }
        tx
    });
    let _ = tx.send(Box::new(job));
}

/// Loads `source` on a worker and hands the result to the main thread.
fn work(
    key: String,
    source: LoadSource,
    access: Arc<Access>,
    cache: Option<DiskCache>,
    progress: bool,
) {
    let mut last: Option<Instant> = None;
    let mut report = |loaded: u64, total: u64| {
        let now = Instant::now();
        let done = total > 0 && loaded >= total;
        if !progress || !(done || last.is_none_or(|t| now - t >= PROGRESS_INTERVAL)) {
            return;
        }
        last = Some(now);
        let key = key.clone();
        rt::invoke(move || {
            LOADER.with(|l| l.progress(&key, loaded, total));
        });
    };
    let result = source
        .read(&access, cache.as_ref(), &mut report)
        .and_then(decode);
    rt::invoke(move || finish(key, result.map(Image::shared)));
}

thread_local! {
    /// Textures dropped since images were last drawn: they leave GPUI's
    /// atlases then ([`release_textures`]).
    static DROPPED: RefCell<Vec<Arc<RenderImage>>> = const { RefCell::new(Vec::new()) };
}

/// A GPUI image owned by nsh (main thread): when the last owner drops it,
/// it is removed from the windows' sprite atlases, which would keep it
/// for as long as the window lives.
pub(crate) struct Texture(Arc<RenderImage>);

impl Texture {
    /// Owns `image` (made elsewhere: canvases' pixmaps).
    pub(crate) fn new(image: Arc<RenderImage>) -> Texture {
        Texture(image)
    }

    /// The GPUI image (to paint; not to keep).
    pub(crate) fn image(&self) -> &Arc<RenderImage> {
        &self.0
    }

    /// Its frames.
    fn frames(&self) -> usize {
        self.0.frame_count()
    }
}

impl Drop for Texture {
    fn drop(&mut self) {
        let image = self.0.clone();
        let _ = DROPPED.try_with(|d| d.borrow_mut().push(image));
    }
}

/// Removes the textures dropped since the last call from the atlases
/// (paint phase: nothing painted in this frame was dropped, as nothing
/// owns a dropped texture to paint it).
pub(crate) fn release_textures(cx: &mut DrawCx<'_>) {
    release_dropped(cx.window, cx.app);
}

/// [`release_textures`] from anywhere a frame of `window` is drawn (the
/// surface's prepaint does it every frame, so textures dropped where no
/// image draws leave the atlases too).
pub(crate) fn release_dropped(window: &mut gpui::Window, app: &mut gpui::App) {
    let dropped = DROPPED.with(|d| std::mem::take(&mut *d.borrow_mut()));
    for image in dropped {
        app.drop_image(image, Some(window));
    }
}

/// Removes `image` from the atlases with the next frame: for GPUI images
/// nsh painted that are not [`Texture`]s (video frames).
#[cfg_attr(not(feature = "video"), allow(dead_code))]
pub(crate) fn release_later(image: Arc<RenderImage>) {
    let _ = DROPPED.try_with(|d| d.borrow_mut().push(image));
}

/// How a variant of a picture differs from its pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Look {
    /// Halvings of its size (a mipmap level).
    mip: u8,
    /// Blur radius in drawn pixels (0: none).
    blur: u16,
    /// A color matrix (filters).
    matrix: Option<[f32; 20]>,
    /// The color painted through its alpha.
    tint: Option<Color>,
    /// Opacity in [`ALPHA_STEPS`]ths.
    alpha: u8,
}

impl Default for Look {
    fn default() -> Self {
        Look {
            mip: 0,
            blur: 0,
            matrix: None,
            tint: None,
            alpha: ALPHA_STEPS,
        }
    }
}

impl Look {
    /// The same look, opaque.
    fn opaque(self) -> Look {
        Look {
            alpha: ALPHA_STEPS,
            ..self
        }
    }

    /// True when it changes colors (blur, matrix, tint): without the
    /// variant, the image is not drawn.
    fn recolors(&self) -> bool {
        self.blur > 0 || self.matrix.is_some() || self.tint.is_some()
    }
}

/// What a worker does to a texture's pixels to make a variant.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ops {
    /// Halvings of the size.
    mip: u8,
    /// Stack blur radius in pixels of the result.
    blur: u8,
    matrix: Option<[f32; 20]>,
    tint: Option<Color>,
    /// Opacity in [`ALPHA_STEPS`]ths.
    alpha: u8,
}

/// Multiplies colors by alpha (any channel order, alpha last).
fn premultiply(data: &mut [u8]) {
    let mul = |c: u8, a: u8| ((c as u32 * a as u32 + 127) / 255) as u8;
    for px in data.as_chunks_mut::<4>().0 {
        let a = px[3];
        px[0] = mul(px[0], a);
        px[1] = mul(px[1], a);
        px[2] = mul(px[2], a);
    }
}

/// Divides colors by alpha (any channel order, alpha last).
fn unpremultiply(data: &mut [u8]) {
    for px in data.as_chunks_mut::<4>().0 {
        let a = px[3] as u32;
        if a == 0 || a == 255 {
            continue;
        }
        let div = |c: u8| ((c as u32 * 255 + a / 2) / a).min(255) as u8;
        px[0] = div(px[0]);
        px[1] = div(px[1]);
        px[2] = div(px[2]);
    }
}

/// Blurs pixels (4 channels) in place: rows, then columns. A stack blur
/// (a fast approximation of a Gaussian, the same as the macOS and iOS
/// backends'); edges repeat their pixels, so they stay opaque.
fn stack_blur(pixels: &mut [u8], width: usize, height: usize, radius: usize) {
    let mut stack = vec![[0u32; 4]; 2 * radius + 1];
    let stride = width * 4;
    for y in 0..height {
        blur_line(pixels, y * stride, 4, width, radius, &mut stack);
    }
    for x in 0..width {
        blur_line(pixels, x * 4, stride, height, radius, &mut stack);
    }
}

/// One stack blur pass over `count` pixels starting at byte `start`,
/// `step` bytes apart. Reads only ahead of what it writes, so it works in
/// place; the stack keeps the original values.
fn blur_line(
    pixels: &mut [u8],
    start: usize,
    step: usize,
    count: usize,
    radius: usize,
    stack: &mut [[u32; 4]],
) {
    if count == 0 {
        return;
    }
    let div = 2 * radius + 1;
    let last = count - 1;
    let pixel = |pixels: &[u8], i: usize| -> [u32; 4] {
        let at = start + i.min(last) * step;
        [
            pixels[at] as u32,
            pixels[at + 1] as u32,
            pixels[at + 2] as u32,
            pixels[at + 3] as u32,
        ]
    };
    let (mut sum, mut sum_in, mut sum_out) = ([0u32; 4], [0u32; 4], [0u32; 4]);
    for (i, slot) in stack.iter_mut().enumerate().take(radius + 1) {
        let p = pixel(pixels, 0);
        *slot = p;
        for c in 0..4 {
            sum[c] += p[c] * (i as u32 + 1);
            sum_out[c] += p[c];
        }
    }
    for i in 1..=radius {
        let p = pixel(pixels, i);
        stack[i + radius] = p;
        for c in 0..4 {
            sum[c] += p[c] * (radius + 1 - i) as u32;
            sum_in[c] += p[c];
        }
    }
    let weight = ((radius + 1) * (radius + 1)) as u32;
    let mut sp = radius;
    for x in 0..count {
        let at = start + x * step;
        for c in 0..4 {
            pixels[at + c] = (sum[c] / weight) as u8;
            sum[c] -= sum_out[c];
        }
        let slot = (sp + div - radius) % div;
        let incoming = pixel(pixels, x + radius + 1);
        for c in 0..4 {
            sum_out[c] -= stack[slot][c];
            sum_in[c] += incoming[c];
            sum[c] += sum_in[c];
        }
        stack[slot] = incoming;
        sp = (sp + 1) % div;
        for c in 0..4 {
            sum_out[c] += stack[sp][c];
            sum_in[c] -= stack[sp][c];
        }
    }
}

/// Applies a 4×5 color matrix (rows: output red, green, blue, alpha;
/// columns: input red, green, blue, alpha, then the offset in 0..1) to
/// straight BGRA pixels in place.
fn color_matrix(data: &mut [u8], m: &[f32; 20]) {
    for px in data.as_chunks_mut::<4>().0 {
        let a = px[3] as f32 / 255.0;
        if a == 0.0 && m[19] == 0.0 {
            continue;
        }
        let (b, g, r) = (
            px[0] as f32 / 255.0,
            px[1] as f32 / 255.0,
            px[2] as f32 / 255.0,
        );
        let out = |i: usize| {
            let v = m[i] * r + m[i + 1] * g + m[i + 2] * b + m[i + 3] * a + m[i + 4];
            (v.clamp(0.0, 1.0) * 255.0).round() as u8
        };
        let (nr, ng, nb, na) = (out(0), out(5), out(10), out(15));
        *px = [nb, ng, nr, na];
    }
}

/// Paints `tint` through the alpha of straight BGRA pixels, in place.
fn tint(data: &mut [u8], tint: Color) {
    let (r, g, b, a) = tint.to_f64();
    let c = |v: f64| (v * 255.0).round() as u8;
    let (r, g, b) = (c(r), c(g), c(b));
    for px in data.as_chunks_mut::<4>().0 {
        let alpha = (px[3] as f64 * a).round() as u8;
        *px = [b, g, r, alpha];
    }
}

/// Multiplies the alpha of straight BGRA pixels by `alpha`
/// [`ALPHA_STEPS`]ths.
fn fade(data: &mut [u8], alpha: u8) {
    let (alpha, steps) = (alpha as u32, ALPHA_STEPS as u32);
    for px in data.as_chunks_mut::<4>().0 {
        px[3] = ((px[3] as u32 * alpha + steps / 2) / steps) as u8;
    }
}

/// The size of a variant `mip` halvings down from `size`.
fn mip_size(size: (u32, u32), mip: u8) -> (u32, u32) {
    let shrink = |v: u32| v.div_ceil(1 << mip).max(1);
    (shrink(size.0), shrink(size.1))
}

/// One frame of a variant: `ops` applied to straight BGRA pixels of `size`.
fn render_frame(data: &[u8], size: (u32, u32), ops: &Ops) -> image::RgbaImage {
    let (mut w, mut h) = size;
    let mut data = data.to_vec();
    // Scaling and blurring mix pixels: on premultiplied colors, so that
    // transparent pixels lend no color.
    let mixes = ops.mip > 0 || ops.blur > 0;
    if mixes {
        premultiply(&mut data);
    }
    if ops.mip > 0 {
        let (nw, nh) = mip_size((w, h), ops.mip);
        if let Some(buffer) = image::RgbaImage::from_raw(w, h, data.clone()) {
            data = image::imageops::resize(&buffer, nw, nh, image::imageops::FilterType::Triangle)
                .into_raw();
            (w, h) = (nw, nh);
        }
    }
    if ops.blur > 0 {
        stack_blur(&mut data, w as usize, h as usize, ops.blur as usize);
    }
    if mixes {
        unpremultiply(&mut data);
    }
    if let Some(m) = &ops.matrix {
        color_matrix(&mut data, m);
    }
    if let Some(color) = ops.tint {
        tint(&mut data, color);
    }
    if ops.alpha < ALPHA_STEPS {
        fade(&mut data, ops.alpha);
    }
    image::RgbaImage::from_raw(w, h, data).unwrap_or_default()
}

/// A variant: `ops` applied to every frame of `source` (a worker).
fn render_variant(source: &RenderImage, ops: &Ops) -> RenderImage {
    let frames: Vec<image::Frame> = (0..source.frame_count())
        .filter_map(|i| {
            let bytes = source.as_bytes(i)?;
            let size = source.size(i);
            let size = (size.width.0.max(0) as u32, size.height.0.max(0) as u32);
            Some(image::Frame::new(render_frame(bytes, size, ops)))
        })
        .collect();
    RenderImage::new(frames)
}

/// A variant of a picture, made or being made.
struct Variant {
    look: Look,
    /// `None` while a worker makes it.
    texture: Option<Rc<Texture>>,
    /// When it was last drawn (monotonic µs).
    used: Cell<i64>,
}

/// A decoded image on the main thread (shared by the cache and the views
/// showing it).
pub(crate) struct Image {
    /// The image, every frame of an animation.
    texture: Rc<Texture>,
    /// Its size in pixels (as decoded).
    pixels: (u32, u32),
    /// The source's size in pixels (an SVG's: whole points).
    size: (u32, u32),
    /// An SVG's intrinsic size, unrounded.
    points: Option<Size<Points>>,
    /// Each frame's delay in ms (animations).
    delays: Rc<[u32]>,
    /// Plays before it stops on its last frame; 0: forever.
    plays: u32,
    variants: RefCell<Vec<Variant>>,
}

/// A decoded image, shared.
type Picture = Rc<Image>;

impl Image {
    /// What a worker decoded, shared.
    fn shared(decoded: Decoded) -> Picture {
        let size = decoded.image.size(0);
        Rc::new(Image {
            texture: Rc::new(Texture(decoded.image)),
            pixels: (size.width.0.max(0) as u32, size.height.0.max(0) as u32),
            size: decoded.size,
            points: decoded.points,
            delays: decoded.delays.into(),
            plays: decoded.plays,
            variants: RefCell::default(),
        })
    }

    /// Bytes its pixels take (4 per pixel, every frame).
    fn bytes(&self) -> usize {
        let (w, h) = self.pixels;
        w as usize * h as usize * 4 * self.texture.frames().max(1)
    }

    /// True when it is an animation.
    fn animated(&self) -> bool {
        self.delays.len() > 1
    }
}

/// The texture to draw `picture` with `look`: the variant if it is made,
/// else the closest one that is (asking a worker for it, which redraws
/// `surface` when done); `None` when nothing fitting is ready. `blur_px`
/// is the stack blur radius at the variant's size.
fn texture_for(picture: &Picture, look: Look, blur_px: u8, surface: u64) -> Option<Rc<Texture>> {
    if look == Look::default() {
        return Some(picture.texture.clone());
    }
    let now = monotonic();
    let mut variants = picture.variants.borrow_mut();
    if let Some(v) = variants.iter().find(|v| v.look == look) {
        v.used.set(now);
        if let Some(t) = &v.texture {
            return Some(t.clone());
        }
    } else {
        // Fading only needs the opaque variant faded: cheaper than all of
        // it again from the pixels.
        let opaque = (look.alpha < ALPHA_STEPS && look.opaque() != Look::default())
            .then(|| {
                variants
                    .iter()
                    .find(|v| v.look == look.opaque())
                    .and_then(|v| v.texture.clone())
            })
            .flatten();
        let (source, ops) = match opaque {
            Some(t) => (
                t,
                Ops {
                    mip: 0,
                    blur: 0,
                    matrix: None,
                    tint: None,
                    alpha: look.alpha,
                },
            ),
            None => (
                picture.texture.clone(),
                Ops {
                    mip: look.mip,
                    blur: blur_px,
                    matrix: look.matrix,
                    tint: look.tint,
                    alpha: look.alpha,
                },
            ),
        };
        variants.push(Variant {
            look,
            texture: None,
            used: Cell::new(now),
        });
        let source = source.image().clone();
        let job = MAKING.with(|m| {
            let mut m = m.borrow_mut();
            m.1 += 1;
            let job = m.1;
            m.0.insert(job, Rc::downgrade(picture));
            job
        });
        spawn(move || {
            let made = Arc::new(render_variant(&source, &ops));
            rt::invoke(move || made_variant(job, look, made, surface));
        });
    }
    // Only scaled or faded: the pixels themselves may stand in, when they
    // are not huge (a texture that large is worth waiting for).
    let (w, h) = picture.pixels;
    let pixels = (!look.recolors() && w.max(h) <= 2048).then(|| &picture.texture);
    closest(&variants, pixels, look, now)
}

/// The ready texture closest to `look`: a variant of the same colors (or
/// `pixels`, the picture's own) of the nearest opacity, then size; `None`
/// when the nearest opacity is too far off (a fade-in would flash).
fn closest(
    variants: &[Variant],
    pixels: Option<&Rc<Texture>>,
    look: Look,
    now: i64,
) -> Option<Rc<Texture>> {
    let same = |l: &Look| l.blur == look.blur && l.matrix == look.matrix && l.tint == look.tint;
    let ready = variants
        .iter()
        .filter(|v| same(&v.look))
        .filter_map(|v| Some((v.look, v.texture.as_ref()?, Some(&v.used))));
    let own = pixels.map(|t| (Look::default(), t, None));
    let (l, texture, used) = ready
        .chain(own)
        .min_by_key(|(l, ..)| (l.alpha.abs_diff(look.alpha), l.mip.abs_diff(look.mip)))?;
    if l.alpha.abs_diff(look.alpha) > ALPHA_STEPS / 4 {
        return None;
    }
    if let Some(used) = used {
        used.set(now);
    }
    Some(texture.clone())
}

thread_local! {
    /// The pictures whose variants workers make, by job; the last job.
    static MAKING: RefCell<(FxHashMap<u64, Weak<Image>>, u64)> = RefCell::default();
}

/// A worker made the variant `look` of the picture of `job`.
fn made_variant(job: u64, look: Look, made: Arc<RenderImage>, surface: u64) {
    let texture = Rc::new(Texture(made));
    let weak = MAKING.with(|m| m.borrow_mut().0.remove(&job));
    let Some(picture) = weak.and_then(|w| w.upgrade()) else {
        return;
    };
    {
        let mut variants = picture.variants.borrow_mut();
        let Some(v) = variants.iter_mut().find(|v| v.look == look) else {
            return;
        };
        v.texture = Some(texture);
        trim(&mut variants, monotonic());
    }
    if let Some(surface) = Surface::by_key(surface) {
        surface.invalidate();
    }
}

/// Drops the least recently drawn variants beyond [`VARIANTS`], keeping
/// the ones being made and the ones drawn in the last second (which may
/// still be on screen).
fn trim(variants: &mut Vec<Variant>, now: i64) {
    while variants.len() > VARIANTS {
        let oldest = variants
            .iter()
            .enumerate()
            .filter(|(_, v)| v.texture.is_some() && now - v.used.get() > 1_000_000)
            .min_by_key(|(_, v)| v.used.get())
            .map(|(i, _)| i);
        match oldest {
            Some(i) => {
                variants.swap_remove(i);
            }
            None => break,
        }
    }
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

/// The main thread's image cache and running loads.
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

fn source(surface: &Surface, uri: &str) -> Result<(String, LoadSource), String> {
    if uri.starts_with("asset:/")
        && let AssetSource::Engine(reader) = &*surface.image_assets.borrow()
    {
        let reader = reader
            .clone()
            .ok_or_else(|| format!("{uri}: no asset reader configured"))?;
        // A load binding, rather than an Arc address: a stopped Host may be
        // freed while the decoded picture still lives in the global cache.
        let key = format!(
            "host-asset:{}:{}:{uri}",
            surface.key(),
            surface.load_generation()
        );
        return Ok((
            key,
            LoadSource::Asset {
                uri: uri.to_owned(),
                reader,
            },
        ));
    }
    let location = resolve(uri, surface.asset_base.borrow().as_ref())
        .ok_or_else(|| format!("unsupported image source `{uri}`"))?;
    Ok((location.key(), LoadSource::Location(location)))
}

/// Loads `uri` for `surface`; `done` runs on the main thread. Returns
/// whether it already ran (cached, or a source that cannot load).
fn fetch(surface: &Surface, uri: &str, progress: Option<Progress>, done: Done) -> bool {
    fetch_at(
        surface,
        source(surface, uri),
        disk_cache(surface, uri),
        progress,
        done,
    )
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
            fetch_at(
                surface,
                Ok((location.key(), LoadSource::Location(location))),
                None,
                progress,
                done,
            )
        }
        None => fetch(surface, &source.uri, progress, done),
    }
}

/// Loads a resolved source for `surface`, as [`fetch`] does. Every path
/// keeps its callbacks bound to the engine load that requested it.
fn fetch_at(
    surface: &Surface,
    source: Result<(String, LoadSource), String>,
    cache: Option<DiskCache>,
    progress: Option<Progress>,
    done: Done,
) -> bool {
    let surface_key = surface.key();
    let generation = surface.load_generation();
    let current = move || {
        Surface::by_key(surface_key).is_some_and(|surface| surface.load_generation() == generation)
    };
    let done: Done = Box::new(move |result| {
        if current() {
            done(result);
        }
    });
    let progress: Option<Progress> = progress.map(|progress| {
        Box::new(move |loaded, total| {
            if current() {
                progress(loaded, total);
            }
        }) as Progress
    });
    let (key, source) = match source {
        Ok(source) => source,
        Err(reason) => {
            done(Err(reason));
            return true;
        }
    };
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
        let access = surface.access.borrow().clone();
        spawn(move || work(key, source, access, cache, listens));
    }
    false
}

/// Loads `uri` (`https://…`, `asset:/…`, a file path, `data:`) off the
/// main thread, through the image cache; `done` runs on the main thread
/// with the image (every frame of an animation: frame 0 is the first) and
/// the source's size in pixels (an SVG's: in points).
///
/// A cached image is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
pub(crate) fn load(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<(Rc<Texture>, (u32, u32)), String>) + 'static,
) {
    let done = move |result: Result<Picture, String>| {
        done(result.map(|p| (p.texture.clone(), p.size)));
    };
    fetch(surface, uri, None, Box::new(done));
}

/// Loads the bitmap `uri` for a canvas, as [`load`] does: canvases draw
/// bitmaps, so an SVG is an image that failed to load.
pub(crate) fn load_bitmap(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<Rc<Texture>, String>) + 'static,
) {
    let source = uri.to_owned();
    let done = move |result: Result<Picture, String>| {
        done(result.and_then(|p| match p.points {
            Some(_) => Err(format!(
                "{source} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
            )),
            None => Ok(p.texture.clone()),
        }));
    };
    fetch(surface, uri, None, Box::new(done));
}

/// `Command::ImageInfo` (`Image.getSize`, `Image.prefetch`): loads the
/// image into the cache and reports its size in pixels (an SVG's: its
/// intrinsic size in points).
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    let Command::ImageInfo { id, uri } = command else {
        return;
    };
    let request = *id;
    let weak = Rc::downgrade(surface);
    load(surface, uri, move |result| {
        let Some(surface) = weak.upgrade() else {
            return;
        };
        let mut fields = vec![("id", PayloadValue::Number(request as f64))];
        match result {
            Ok((_, (w, h))) => {
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
    });
}

/// A fade-in in progress.
#[derive(Debug, Clone, Copy)]
struct Fade {
    /// Frame time it started (seconds); set on the first frame.
    start: Option<f64>,
    /// Duration in seconds.
    duration: f64,
}

/// What an image view shows.
#[derive(Default)]
pub(crate) struct ImageState {
    source: Option<ImageSource>,
    mode: ResizeMode,
    options: ImageOptions,
    /// The source's image, once loaded.
    image: Option<Picture>,
    /// The placeholder's image, until the image shows.
    placeholder: Option<Picture>,
    /// Bumped on every source change: older loads are stale.
    generation: u64,
    /// The image's opacity while it fades in.
    alpha: f32,
    fade: Option<Fade>,
    /// The source's animation, playing.
    playback: Option<Playback>,
    /// The surface's key and the view's node id: timers find the view
    /// again with them (and find nothing once it is gone).
    owner: (u64, NodeId),
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

/// Microseconds on the monotonic clock.
fn monotonic() -> i64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_micros() as i64
}

/// An animation playing in a view.
struct Playback {
    delays: Rc<[u32]>,
    plays: u32,
    timeline: Timeline,
    /// A timer for the next frame is pending.
    timer: bool,
    /// Bumped per timer: a timer that is not the latest is stale (GPUI's
    /// timers are not cancelled: a stale one finds nothing to do).
    serial: u64,
    /// The view was drawn since the frame last changed: it plays on.
    drawn: Cell<bool>,
    /// A drawing asked for playback to resume, which is on its way.
    resuming: Cell<bool>,
}

impl Playback {
    fn new(picture: &Image) -> Playback {
        Playback {
            delays: picture.delays.clone(),
            plays: picture.plays,
            timeline: Timeline::default(),
            timer: false,
            serial: 0,
            drawn: Cell::new(false),
            resuming: Cell::new(false),
        }
    }

    /// True when it waits for nothing: no timer, not finished.
    fn paused(&self) -> bool {
        !self.timer && !self.timeline.finished(self.plays)
    }

    /// Advances to now; schedules the next frame (for the view `owner`)
    /// while it plays. Returns whether the frame changed.
    fn advance(&mut self, owner: (u64, NodeId)) -> bool {
        let now = monotonic();
        let (changed, running) = self.timeline.advance(&self.delays, self.plays, now);
        self.timer = false;
        if let Some(due) = self.timeline.due.filter(|_| running) {
            // Timers count whole milliseconds: one that fires early would
            // spin until the frame is due.
            let wait = ((due - now).max(0) as u64).div_ceil(1000).max(1);
            self.serial += 1;
            self.timer = true;
            let serial = self.serial;
            rt::after_ms(wait, move || step(owner, serial));
        }
        changed
    }
}

/// The view `owner` names, while its surface and the view live.
fn owner_view(owner: (u64, NodeId)) -> Option<NshView> {
    Surface::by_key(owner.0)?.view(owner.1)
}

/// Plays the view's animation from where it is (it was drawn again).
fn resume(owner: (u64, NodeId)) {
    let Some(view) = owner_view(owner) else {
        return;
    };
    let mut s = view.state_mut();
    if let Some(p) = s.image.as_mut().and_then(|i| i.playback.as_mut()) {
        p.resuming.set(false);
        if p.paused() {
            p.advance(owner);
        }
    }
}

/// Timer `serial` of the view's next frame fired.
fn step(owner: (u64, NodeId), serial: u64) {
    let Some(view) = owner_view(owner) else {
        return;
    };
    let changed = {
        let mut s = view.state_mut();
        let Some(p) = s
            .image
            .as_mut()
            .and_then(|i| i.playback.as_mut())
            .filter(|p| p.serial == serial)
        else {
            return;
        };
        p.timer = false;
        if !p.drawn.get() {
            // Not drawn since the last frame: nobody sees it. It pauses
            // here, and drawing resumes it.
            p.timeline.due = None;
            return;
        }
        let changed = p.advance(owner);
        if changed {
            p.drawn.set(false);
        }
        changed
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
        image.owner = (surface.key(), id);
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
            image.playback = None;
        }
        if !same_placeholder {
            image.placeholder = None;
        }
        (image.generation, image.image.is_none(), events, id)
    };
    view.changed();
    let key = surface.key();
    // The image first: when it is cached, the placeholder is not needed.
    if let Some(source) = source.filter(|_| needs_image) {
        let progress = events.contains(EventKind::Progress).then(|| {
            Box::new(move |loaded: u64, total: u64| {
                let Some(surface) = Surface::by_key(key) else {
                    return;
                };
                let current = surface.view(id).is_some_and(|v| {
                    v.state()
                        .image
                        .as_ref()
                        .is_some_and(|i| i.generation == generation)
                });
                if current {
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
            let waited = waited.clone();
            move |result: Result<Picture, String>| {
                if let Some(surface) = Surface::by_key(key)
                    && let Some(view) = surface.view(id)
                {
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
            let Some(view) = Surface::by_key(key).and_then(|s| s.view(id)) else {
                return;
            };
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
    surface: &Rc<Surface>,
    view: &NshView,
    generation: u64,
    result: Result<Picture, String>,
    waited: bool,
) {
    let (events, id, fades) = {
        let mut s = view.state_mut();
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        match &result {
            Ok(picture) => {
                image.image = Some(picture.clone());
                image.playback = picture.animated().then(|| Playback::new(picture));
                let owner = image.owner;
                if let Some(p) = image.playback.as_mut() {
                    p.advance(owner);
                }
                let ms = image.options.fade_ms.unwrap_or(0.0);
                image.alpha = 1.0;
                image.fade = None;
                if waited && ms > 0.0 {
                    image.alpha = 0.0;
                    image.fade = Some(Fade {
                        start: None,
                        duration: f64::from(ms) / 1000.0,
                    });
                }
            }
            Err(message) => log::warn!("image failed: {message}"),
        }
        (events, id, image.fade.is_some())
    };
    if fades {
        surface.on_frame(move |surface, now| fade_tick(surface, id, generation, now));
    }
    view.changed();
    match &result {
        Ok(picture) if events.contains(EventKind::Load) => surface.event(
            id,
            EventKind::Load,
            EventPayload::Image(nsh_core::geometry::size(
                DevicePixels(picture.size.0 as i32),
                DevicePixels(picture.size.1 as i32),
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

/// Advances the fade-in of view `id`'s load `generation` to frame time
/// `now` (seconds); false once it is over.
fn fade_tick(surface: &Rc<Surface>, id: NodeId, generation: u64, now: f64) -> bool {
    let Some(view) = surface.view(id) else {
        return false;
    };
    let running = {
        let mut s = view.state_mut();
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return false;
        };
        let Some(fade) = image.fade.as_mut() else {
            return false;
        };
        let start = *fade.start.get_or_insert(now);
        let t = ((now - start) / fade.duration.max(1e-6)).min(1.0) as f32;
        image.alpha = t;
        if t >= 1.0 {
            image.fade = None;
        }
        t < 1.0
    };
    view.changed();
    running
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

/// The natural size in points of an image of `size` pixels loaded from
/// `source`: the size the source declares, an SVG's intrinsic size
/// (`points`), or its pixels over the file name's density.
fn natural(
    size: (u32, u32),
    points: Option<Size<Points>>,
    source: Option<&ImageSource>,
) -> (f32, f32) {
    if let Some(size) = source
        .and_then(|s| s.size)
        .filter(|s| s.width.0 > 0.0 && s.height.0 > 0.0)
    {
        return (size.width.0, size.height.0);
    }
    if let Some(points) = points {
        return (points.width.0, points.height.0);
    }
    let d = source.map_or(1.0, |s| density(&s.uri));
    (size.0 as f32 / d, size.1 as f32 / d)
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

/// The mipmap level and the blur of a variant of an image of `pixels`
/// drawn at `drawn` pixels with a blur of `blur` drawn pixels: halved
/// while it stays at least as large as drawn, then while the blur at its
/// size is over [`MAX_BLUR`] pixels. Returns the level and the stack blur
/// radius at that level's size (0: none).
fn level(pixels: (u32, u32), drawn: (f32, f32), blur: f32) -> (u8, u8) {
    let (pw, ph) = (pixels.0 as f32, pixels.1 as f32);
    // Pixels of the image per drawn pixel, along its denser axis.
    let mut density = (pw / drawn.0.max(1e-3)).min(ph / drawn.1.max(1e-3));
    let mut mip = 0u8;
    let fits = |mip: u8| mip < 12 && pixels.0 >> (mip + 1) >= 1 && pixels.1 >> (mip + 1) >= 1;
    while density >= 2.0 && fits(mip) {
        density /= 2.0;
        mip += 1;
    }
    if blur <= 0.0 {
        return (mip, 0);
    }
    let mut radius = blur * density;
    while radius > MAX_BLUR && fits(mip) {
        radius /= 2.0;
        mip += 1;
    }
    (mip, radius.round().clamp(1.0, 254.0) as u8)
}

/// Draws one picture with the view's mode, the clip's corners, tint,
/// filters, blur and `alpha` (with the pass's opacity).
fn draw_one(
    cx: &mut DrawCx<'_>,
    state: &ViewState,
    image: &ImageState,
    picture: &Picture,
    frame: usize,
    source: Option<&ImageSource>,
    alpha: f32,
) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let (x, y, fw, fh) = fit(
        image.mode,
        image.options.position,
        natural(picture.size, picture.points, source),
        (w, h),
    );
    if fw <= 0.0 || fh <= 0.0 || cx.culled() {
        return;
    }
    let alpha = (alpha * cx.opacity * ALPHA_STEPS as f32).round();
    if alpha <= 0.0 {
        return;
    }
    let k = cx.transform_scale();
    let px_per_pt = k * cx.scale;
    let filters = state
        .style
        .effects
        .as_ref()
        .map(|e| &e.filters[..])
        .unwrap_or(&[]);
    let blur = ((image.options.blur_radius.0.max(0.0) + nsh_core::blur_radius(filters).0)
        * px_per_pt)
        .round()
        .clamp(0.0, u16::MAX as f32);
    let (mip, blur_px) = level(picture.pixels, (fw * px_per_pt, fh * px_per_pt), blur);
    let look = Look {
        mip,
        blur: blur as u16,
        // The view's and its ancestors' color filters, which GPUI cannot
        // apply to a sprite.
        matrix: cx.matrix,
        tint: state.style.tint_color,
        alpha: alpha.min(ALPHA_STEPS as f32) as u8,
    };
    let Some(texture) = texture_for(picture, look, blur_px, image.owner.0) else {
        return;
    };
    let boxed = cx.rect(0.0, 0.0, w, h);
    let placed = cx.rect(x, y, fw, fh);
    // GPUI rounds the sprite itself: the corners of the innermost rounded
    // clip (the view's own, or a rounded parent's) that the part shown
    // reaches.
    let (shown, corners) = cx.clip_rounded(boxed.intersect(&placed), Corners::default());
    let frame = frame.min(texture.frames().saturating_sub(1));
    let data = texture.image().clone();
    cx.paint(|window, _| {
        if let Err(e) = window.paint_image(shown, placed, corners, data, frame, false) {
            log::warn!("image: cannot paint: {e}");
        }
    });
}

/// Draws an image view's picture.
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(image) = &state.image else { return };
    release_textures(cx);
    let fading = image.fade.is_some();
    if let Some(placeholder) = &image.placeholder
        && (image.image.is_none() || fading)
    {
        let source = image.options.placeholder.as_ref();
        draw_one(cx, state, image, placeholder, 0, source, 1.0);
    }
    let Some(picture) = &image.image else { return };
    let frame = match &image.playback {
        Some(p) => {
            p.drawn.set(true);
            if p.paused() && !p.resuming.replace(true) {
                // Drawn again after it paused: resumes once this pass is
                // over (the view's state is borrowed while drawing).
                let owner = image.owner;
                rt::invoke(move || resume(owner));
            }
            p.timeline.frame
        }
        None => 0,
    };
    let alpha = if fading { image.alpha } else { 1.0 };
    let source = image.source.as_ref();
    draw_one(cx, state, image, picture, frame, source, alpha);
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
            Some(Location::File(
                PathBuf::from("/app/assets").join("img/a.png")
            ))
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
        assert_eq!(resolve("relative.png", None), None);
        assert!(matches!(
            resolve("data:image/png;base64,AA==", None),
            Some(Location::Data(_))
        ));
        if cfg!(windows) {
            assert_eq!(
                resolve("file:///C:/Users/a%20b.png", None),
                Some(Location::File("C:\\Users\\a b.png".into()))
            );
            assert_eq!(
                resolve("file://server/share/x.png", None),
                Some(Location::File("\\\\server\\share\\x.png".into()))
            );
            assert_eq!(
                resolve("C:\\Users\\a.png", None),
                Some(Location::File("C:\\Users\\a.png".into()))
            );
        } else {
            assert_eq!(
                resolve("file:///home/a%20b.png", None),
                Some(Location::File("/home/a b.png".into()))
            );
            assert_eq!(
                resolve("file://localhost/x.png", None),
                Some(Location::File("/x.png".into()))
            );
            assert_eq!(resolve("file://server/share/x.png", None), None);
            assert_eq!(
                resolve("/home/a.png", None),
                Some(Location::File("/home/a.png".into()))
            );
        }
    }

    #[test]
    fn decodes_data_uris() {
        assert_eq!(data_uri("data:image/png;base64,aGk=").unwrap(), b"hi");
        assert_eq!(data_uri("data:image/png;base64,aG\n k").unwrap(), b"hi");
        assert_eq!(data_uri("data:text/plain,a%20b%zz").unwrap(), b"a b%zz");
        assert!(data_uri("data:nocomma").is_err());
        assert!(data_uri("data:;base64,@@").is_err());
    }

    #[test]
    fn reads_inline_bytes_by_digest_key() {
        let source = ImageSource::default().with_bytes("image/svg+xml", SVG_ICON.to_vec().into());
        let same = ImageSource::default().with_bytes("image/svg+xml", SVG_ICON.to_vec().into());
        let location = Location::Memory(source.uri.to_string(), source.data.unwrap());
        assert_eq!(location.key(), format!("inline:{}", same.uri));
        assert!(
            location
                .key()
                .starts_with("inline:data:image/svg+xml;nsh-key=")
        );
        assert!(
            data_uri(&source.uri).is_err(),
            "the key is not a data URI payload"
        );
        let bytes = read(&location, &Access::default(), None, &mut |_, _| {}).unwrap();
        assert_eq!(bytes.as_ref(), SVG_ICON);
        let Location::Memory(_, original) = &location else {
            unreachable!()
        };
        assert_eq!(&bytes, original, "inline reads keep shared original bytes");
        assert_eq!(decode(bytes).unwrap().size, (24, 24));
    }

    #[test]
    fn raw_uris_cannot_address_inline_cache_entries() {
        // Blob MIME types can contain commas: excluding only malformed
        // data URIs would still let these internal keys reach the cache.
        for mime in ["image/svg+xml", "image/svg+xml,x"] {
            let source = ImageSource::default().with_bytes(mime, SVG_ICON.to_vec().into());
            let memory = Location::Memory(source.uri.to_string(), source.data.unwrap());
            let raw = resolve(&source.uri, None).unwrap();
            assert_ne!(raw.key(), memory.key());
            assert_eq!(resolve(&memory.key(), None), None);
            let loader = Loader::default();
            loader.insert(memory.key(), picture(1, 1));
            loader
                .inflight
                .borrow_mut()
                .insert(memory.key(), Vec::new());
            assert!(loader.cached(&memory.key()).is_some());
            assert!(loader.cached(&raw.key()).is_none());
            assert!(!loader.inflight.borrow().contains_key(&raw.key()));
            assert_eq!(
                read(&memory, &Access::default(), None, &mut |_, _| {})
                    .unwrap()
                    .as_ref(),
                SVG_ICON
            );
        }
    }

    #[test]
    fn disk_cache_is_remote_only_and_cleared_with_load() {
        let surface = Surface::new(nsh_engine::Environment::default());
        set_asset_base(
            &surface,
            Some(AssetBase::Http("https://dev.test/assets/".into())),
        );
        let cache = DiskCache::open("first-engine-cache", nsh_core::ByteSize::mib(1)).unwrap();
        set_disk_cache(&surface, Some(cache));
        let retained = disk_cache(&surface, "https://example.test/image.png").unwrap();
        assert_eq!(retained.dir(), std::path::Path::new("first-engine-cache"));
        assert!(disk_cache(&surface, "http://example.test/image.png").is_some());
        assert!(matches!(
            resolve("asset:/image.png", surface.asset_base.borrow().as_ref()),
            Some(Location::Url(_))
        ));
        for uri in [
            "asset:/image.png",
            "data:image/png;base64,AA==",
            "blob:local",
            "file:/image.png",
        ] {
            assert!(
                disk_cache(&surface, uri).is_none(),
                "{uri} is never disk cached"
            );
        }
        surface.stop();
        assert!(disk_cache(&surface, "https://example.test/image.png").is_none());
        // A running worker retains its original handle across a replacement load.
        set_disk_cache(
            &surface,
            DiskCache::open("second-engine-cache", nsh_core::ByteSize::mib(1)),
        );
        assert_eq!(retained.dir(), std::path::Path::new("first-engine-cache"));
        assert_eq!(
            disk_cache(&surface, "https://example.test/image.png")
                .unwrap()
                .dir(),
            std::path::Path::new("second-engine-cache")
        );
    }

    #[test]
    fn inline_bytes_bypass_asset_resolution_and_keep_load_guards() {
        let surface = Surface::new(nsh_engine::Environment::default());
        *surface.image_assets.borrow_mut() = AssetSource::Engine(None);
        let source = ImageSource {
            uri: "asset:/inline-load-guard.svg".into(),
            data: Some(SVG_ICON.to_vec().into()),
            ..Default::default()
        };
        assert!(super::source(&surface, &source.uri).is_err());

        // Stand in for an existing worker so callbacks can be driven without
        // a GPUI event loop. Attached bytes must bypass the missing reader.
        let key = format!("inline:{}", source.uri);
        LOADER.with(|l| {
            l.inflight.borrow_mut().insert(
                key.clone(),
                vec![Waiter {
                    done: Box::new(|_| {}),
                    progress: None,
                }],
            );
        });
        let completed = Rc::new(Cell::new(false));
        let progressed = Rc::new(Cell::new(0));
        let done = {
            let completed = completed.clone();
            Box::new(move |_| completed.set(true)) as Done
        };
        let progress = {
            let progressed = progressed.clone();
            Box::new(move |_, _| progressed.set(progressed.get() + 1)) as Progress
        };
        assert!(!fetch_source(&surface, &source, Some(progress), done));
        LOADER.with(|l| l.progress(&key, 1, 2));
        assert_eq!(progressed.get(), 1);
        surface.stop();
        LOADER.with(|l| l.progress(&key, 2, 2));
        finish(key, Err("the old load finished".into()));
        assert_eq!(progressed.get(), 1);
        assert!(!completed.get());
    }

    #[test]
    fn bounds_huge_images() {
        assert_eq!(bounded((100, 50)), (100, 50));
        assert_eq!(bounded((16384, 4096)), (8192, 2048));
        assert_eq!(bounded((10, 100_000)), (1, 8192));
    }

    fn picture(w: u32, h: u32) -> Picture {
        let frame = image::Frame::new(image::RgbaImage::new(w, h));
        Image::shared(Decoded::new(vec![frame], Vec::new(), 0, (w, h)))
    }

    #[test]
    fn evicts_the_least_recently_used() {
        let loader = Loader::default();
        // 16 MB each: eight fill the cache.
        for i in 0..8 {
            loader.insert(format!("{i}"), picture(2048, 2048));
        }
        assert_eq!(loader.bytes.get(), CACHE_BYTES);
        assert!(loader.cached("0").is_some());
        loader.insert("8".into(), picture(2048, 2048));
        // "1" was the oldest once "0" was used.
        assert!(loader.cached("1").is_none());
        assert!(loader.cached("0").is_some());
        assert!(loader.cached("8").is_some());
        assert_eq!(loader.bytes.get(), CACHE_BYTES);
        // Replacing an entry counts it once.
        loader.insert("8".into(), picture(1024, 1024));
        assert_eq!(loader.bytes.get(), CACHE_BYTES - (12 << 20));
        // Too big to cache.
        loader.insert("big".into(), picture(8192, 4096));
        assert!(loader.cached("big").is_none());
    }

    #[test]
    fn decodes_pngs_as_bgra() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/gallery/logo@2x.png");
        let bytes = std::fs::read(path).unwrap();
        let rgba = image::load_from_memory(&bytes).unwrap().into_rgba8();
        let decoded = decode(bytes).unwrap();
        let size = decoded.image.size(0);
        assert_eq!((size.width.0 as u32, size.height.0 as u32), decoded.size);
        assert_eq!(decoded.size, rgba.dimensions());
        let bgra = decoded.image.as_bytes(0).unwrap();
        // Red and blue swapped, alpha straight.
        let pixels = rgba.as_raw().as_chunks::<4>().0.iter();
        for (a, b) in pixels.zip(bgra.as_chunks::<4>().0) {
            assert_eq!([a[2], a[1], a[0], a[3]], *b);
        }
    }

    #[test]
    fn reads_densities() {
        assert_eq!(density("asset:/logo@2x.png"), 2.0);
        assert_eq!(density("asset:/a@3x.webp"), 3.0);
        assert_eq!(density("https://x.org/me@home/a.png"), 1.0);
        assert_eq!(density("a.png"), 1.0);
        let source = ImageSource {
            uri: "asset:/logo@2x.png".into(),
            size: None,
            scales: Default::default(),
            data: None,
        };
        assert_eq!(natural((200, 100), None, Some(&source)), (100.0, 50.0));
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

    #[test]
    fn decodes_animations() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/gallery");
        for (name, format) in [
            ("bounce.gif", image::ImageFormat::Gif),
            ("spinner.webp", image::ImageFormat::WebP),
        ] {
            let bytes = std::fs::read(dir.join(name)).unwrap();
            assert_eq!(animated_format(&bytes), Some(format));
            let decoded = animation(&bytes, format).unwrap().unwrap();
            assert!(decoded.image.frame_count() > 1, "{name}");
            assert_eq!(decoded.image.frame_count(), decoded.delays.len());
            assert!(decoded.delays.iter().all(|&d| d >= 20));
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
        // No natural size yet: fills the box.
        assert_eq!(
            fit(ResizeMode::Contain, ObjectPosition::CENTER, (0.0, 0.0), b),
            (0.0, 0.0, 100.0, 100.0)
        );
    }

    #[test]
    fn picks_mip_levels() {
        // Drawn at its size or larger: the pixels themselves.
        assert_eq!(level((400, 200), (400.0, 200.0), 0.0), (0, 0));
        assert_eq!(level((400, 200), (800.0, 400.0), 0.0), (0, 0));
        // Under half its size: halved while it stays at least as large.
        assert_eq!(level((400, 200), (199.0, 99.0), 0.0), (1, 0));
        assert_eq!(level((4000, 2000), (300.0, 150.0), 0.0), (3, 0));
        // The denser axis decides (a stretched image keeps its detail).
        assert_eq!(level((400, 400), (100.0, 400.0), 0.0), (0, 0));
        // Large blurs shrink it further; the radius is at its size.
        assert_eq!(level((400, 200), (400.0, 200.0), 10.0), (0, 10));
        assert_eq!(level((400, 200), (400.0, 200.0), 40.0), (2, 10));
        // Never below a pixel.
        assert_eq!(level((2, 2), (0.1, 0.1), 0.0).0, 1);
    }

    const SVG_ICON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>"##;
    const SVG_LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f" fill-opacity="0.5"/></svg>"##;

    /// The BGRA pixel at (`x`, `y`) of the first frame.
    fn bgra(decoded: &Decoded, x: u32, y: u32) -> [u8; 4] {
        let width = decoded.image.size(0).width.0 as u32;
        let i = ((y * width + x) * 4) as usize;
        decoded.image.as_bytes(0).unwrap()[i..i + 4]
            .try_into()
            .unwrap()
    }

    #[test]
    fn svg_decodes_oversampled() {
        let logo = decode(SVG_LOGO).unwrap();
        assert_eq!(logo.points, Some(Size::new(Points(48.0), Points(24.0))));
        assert_eq!(logo.size, (48, 24), "intrinsic size in points");
        let pixels = logo.image.size(0);
        assert_eq!(
            (pixels.width.0, pixels.height.0),
            (192, 96),
            "four pixels a point"
        );
        // Straight BGRA: the half-transparent blue is not premultiplied.
        assert_eq!(bgra(&logo, 10, 10), [0, 0, 255, 255]);
        let [b, g, r, a] = bgra(&logo, 150, 50);
        assert_eq!((b, g, r), (255, 0, 0));
        assert!((127..=128).contains(&a), "alpha {a}");
        // Capped: a large SVG draws at most 2048 pixels a side.
        let big = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250"/>"#;
        let big = decode(big).unwrap();
        let pixels = big.image.size(0);
        assert_eq!((pixels.width.0, pixels.height.0), (2048, 512));
        assert_eq!(big.size, (1000, 250));
        assert!(decode(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect").is_err());
    }

    #[test]
    fn svg_size_is_in_points() {
        let source = ImageSource {
            uri: "asset:/logo@2x.svg".into(),
            size: None,
            scales: nsh_core::ImageScales::NONE,
            data: None,
        };
        let logo = decode(SVG_LOGO).unwrap();
        assert_eq!(natural(logo.size, logo.points, Some(&source)), (48.0, 24.0));
        // The picture keeps it for `onLoad` and `Image.getSize`.
        let picture = Image::shared(logo);
        assert_eq!(picture.size, (48, 24));
        assert!(picture.points.is_some());
        assert_eq!(picture.pixels, (192, 96));
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decode(odd).unwrap();
        assert_eq!(odd.size, (11, 10));
        assert_eq!(natural(odd.size, odd.points, None), (10.5, 10.0));
    }

    #[test]
    fn svg_draws_no_text_or_embedded_images() {
        // GPUI's own resvg / usvg enable text and raster images: an SVG
        // still draws neither (no fonts loaded, the resolver resolves
        // nothing).
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><text x="0" y="9" font-size="10" fill="#f00">NSH</text><image width="20" height="10" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="/></svg>"##;
        let decoded = decode(svg).unwrap();
        assert_eq!(decoded.size, (20, 10));
        let bytes = decoded.image.as_bytes(0).unwrap();
        assert!(bytes.iter().all(|&b| b == 0), "nothing drawn");
    }

    #[test]
    fn svg_tints_through_alpha() {
        // A variant tinted red: the SVG's shape in red, the rest transparent.
        let icon = decode(SVG_ICON).unwrap();
        let size = icon.image.size(0);
        let size = (size.width.0 as u32, size.height.0 as u32);
        let ops = Ops {
            mip: 1,
            blur: 0,
            matrix: None,
            tint: Some(Color::rgba(255, 0, 0, 255)),
            alpha: ALPHA_STEPS,
        };
        let tinted = render_frame(icon.image.as_bytes(0).unwrap(), size, &ops);
        assert_eq!(tinted.dimensions(), (48, 48), "a mip level down");
        assert_eq!(tinted.get_pixel(24, 24).0, [0, 0, 255, 255]);
        assert_eq!(tinted.get_pixel(1, 1).0[3], 0);
    }

    #[test]
    fn tints_through_alpha() {
        // BGRA: half-transparent green, transparent.
        let mut px = [0, 255, 0, 128, 9, 9, 9, 0];
        tint(&mut px, Color::rgba(255, 0, 0, 255));
        assert_eq!(px, [0, 0, 255, 128, 0, 0, 255, 0]);
        // A translucent tint scales the alpha.
        let mut px = [1, 2, 3, 200];
        tint(&mut px, Color::rgba(0, 0, 255, 128));
        assert_eq!(px, [255, 0, 0, 100]);
    }

    #[test]
    fn applies_color_matrices() {
        // Grayscale: equal channels, alpha kept.
        let m = nsh_core::Filter::Grayscale(1.0).color_matrix().unwrap();
        let mut px = [0, 0, 255, 200];
        color_matrix(&mut px, &m);
        assert_eq!(px[0], px[1]);
        assert_eq!(px[1], px[2]);
        assert_eq!(px[2], (0.2126f32 * 255.0).round() as u8);
        assert_eq!(px[3], 200);
    }

    #[test]
    fn fades_and_premultiplies() {
        let mut px = [10, 20, 30, 255, 10, 20, 30, 128];
        fade(&mut px, ALPHA_STEPS / 2);
        assert_eq!((px[3], px[7]), (128, 64));
        let mut px = [200, 100, 0, 128];
        premultiply(&mut px);
        assert_eq!(px, [100, 50, 0, 128]);
        unpremultiply(&mut px);
        assert_eq!(px, [199, 100, 0, 128]);
    }

    #[test]
    fn blurs_and_keeps_flat_areas() {
        let (w, h) = (9, 9);
        let mut px = vec![0u8; w * h * 4];
        let center = (4 * w + 4) * 4;
        px[center..center + 4].copy_from_slice(&[255, 255, 255, 255]);
        stack_blur(&mut px, w, h, 2);
        assert!(px[center + 3] < 255 && px[center + 3] > 0);
        assert!(px[((4 * w + 5) * 4) + 3] > 0, "spread to the neighbor");
        let mut flat = vec![100u8; w * h * 4];
        stack_blur(&mut flat, w, h, 3);
        assert!(flat.iter().all(|&v| v == 100));
    }

    #[test]
    fn renders_variants() {
        // A 4×4 opaque red image (BGRA), halved, blurred and faded.
        let data: Vec<u8> = [0, 0, 255, 255].repeat(16);
        let ops = Ops {
            mip: 1,
            blur: 1,
            matrix: None,
            tint: None,
            alpha: ALPHA_STEPS / 2,
        };
        let out = render_frame(&data, (4, 4), &ops);
        assert_eq!(out.dimensions(), (2, 2));
        assert!(
            out.as_raw()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| *p == [0, 0, 255, 128])
        );
        assert_eq!(mip_size((5, 3), 1), (3, 2));
        assert_eq!(mip_size((5, 3), 4), (1, 1));
    }

    #[test]
    fn stands_in_with_the_closest_texture() {
        let texture = || Rc::new(Texture(Arc::new(RenderImage::new(Vec::new()))));
        let own = texture();
        let look = |alpha: u8, mip: u8| Look {
            alpha,
            mip,
            ..Look::default()
        };
        // Nothing made yet: the pixels stand in for an opaque look, not
        // for a nearly transparent one (a fade-in would flash).
        let none: Vec<Variant> = Vec::new();
        assert!(closest(&none, Some(&own), look(ALPHA_STEPS, 2), 0).is_some());
        assert!(closest(&none, Some(&own), look(2, 0), 0).is_none());
        // A faded variant stands in for a nearby opacity.
        let faded = texture();
        let v = vec![Variant {
            look: look(3, 0),
            texture: Some(faded.clone()),
            used: Cell::new(0),
        }];
        let got = closest(&v, Some(&own), look(2, 0), 5).unwrap();
        assert!(Rc::ptr_eq(&got, &faded));
        assert_eq!(v[0].used.get(), 5);
        // Other colors never stand in.
        let tinted = Look {
            tint: Some(Color::rgba(255, 0, 0, 255)),
            ..look(2, 0)
        };
        assert!(closest(&v, None, tinted, 0).is_none());
        DROPPED.with(|d| d.borrow_mut().clear());
    }

    #[test]
    fn keeps_recent_variants() {
        let texture = || Some(Rc::new(Texture(Arc::new(RenderImage::new(Vec::new())))));
        let variant = |alpha: u8, used: i64, made: bool| Variant {
            look: Look {
                alpha,
                ..Look::default()
            },
            texture: if made { texture() } else { None },
            used: Cell::new(used),
        };
        let now = 10_000_000;
        let mut v = vec![
            variant(1, 0, true),
            variant(2, now, true),
            variant(3, 1_000, true),
            variant(4, now, false),
            variant(5, now, true),
            variant(6, now, true),
        ];
        trim(&mut v, now);
        // The two drawn long ago go; recent and pending ones stay.
        let mut left: Vec<u8> = v.iter().map(|v| v.look.alpha).collect();
        left.sort();
        assert_eq!(left, [2, 4, 5, 6]);
        // Their textures wait to leave the atlases.
        assert_eq!(DROPPED.with(|d| d.borrow().len()), 2);
    }
}
