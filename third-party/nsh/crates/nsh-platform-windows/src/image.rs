//! Image views: loading (`asset:/`, files, HTTP; `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding into
//! Direct2D bitmaps, drawing with the resize mode, tint, blur and
//! placeholder.
//!
//! Loads run on a small pool of worker threads: read the file or download
//! (ureq; `onProgress` at most every 100ms), decode (WIC, with COM
//! initialized on each worker, for PNG / JPEG / BMP / TIFF / ICO / HEIF /
//! WebP when a codec is installed; GIF and WebP with the `image` crate,
//! which also decodes every frame of animations) into premultiplied BGRA
//! and hand the pixels to the main thread with [`crate::window::invoke`].
//! Decoded images are kept in a main-thread cache keyed by the resolved
//! location (so `asset:/` URIs of surfaces with different asset bases
//! never mix), bounded by bytes and evicting the least recently used;
//! concurrent requests for one location share one load. Images decode at
//! their full size, up to [`MAX_DIMENSION`] pixels a side (larger ones are
//! scaled down on the worker: Direct2D bitmaps have a size limit and such
//! images take hundreds of megabytes); Direct2D scales them when drawing
//! (high quality cubic when shrinking a lot).
//!
//! A [`Frame`] keeps its pixels and makes its Direct2D bitmap on the main
//! thread when first drawn (a bitmap is a device resource: after a device
//! loss, [`crate::gfx::generation`] changes and the bitmap is made again
//! from the pixels). Bitmaps are 96 DPI, so one image pixel is one point;
//! a file named `…@2x.png` (or a source with a declared size) has its
//! natural size scaled accordingly, as on iOS.
//!
//! Animated GIF and WebP images decode every frame (composited, at most
//! [`MAX_FRAMES`] and [`MAX_ANIMATION_BYTES`]: larger ones show their first
//! frame) with its delay, as browsers and iOS time them (under 20ms: 100ms),
//! and play their loop count. A view advances its frames with a thread
//! timer at each frame's delay, not on the frame ticker (a 10 fps GIF need
//! not keep the ticker running at the display's rate), measured on the
//! monotonic clock so delays do not drift. Playback pauses when the view
//! was not drawn since its last frame change (it is hidden, off a stack's
//! top screen, removed, or the window is minimized) and resumes, on the
//! frame it was, when it is drawn again. `onLoad` comes once per load.
//!
//! `blurRadius` is a Direct2D Gaussian blur at draw time, in points, with
//! a hard border so the edges stay opaque. `tintColor` draws the color
//! through the image's alpha (a color matrix). The `placeholder` shows until
//! the image arrives (and stays on error); an image that had to load then
//! fades in over `fadeDuration` (default 0, as iOS).

use std::{
    cell::{Cell, RefCell},
    io::Read,
    path::PathBuf,
    rc::Rc,
    sync::OnceLock,
    time::{Duration, Instant},
};

use nsh_core::{
    Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId, ObjectPosition,
    PayloadValue, ResizeMode,
    geometry::{Points, Size},
    image::{CacheHeaders, DiskCache, Fetched},
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::{
        Foundation::HWND,
        Graphics::{
            Direct2D::{
                CLSID_D2D1ColorMatrix, CLSID_D2D1GaussianBlur,
                Common::{
                    D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_BORDER_MODE_HARD,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER, D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1,
                D2D1_COLORMATRIX_PROP_COLOR_MATRIX, D2D1_GAUSSIANBLUR_PROP_BORDER_MODE,
                D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, D2D1_INTERPOLATION_MODE,
                D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC, D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_PROPERTY_TYPE_ENUM, D2D1_PROPERTY_TYPE_FLOAT, D2D1_PROPERTY_TYPE_MATRIX_5X4,
                ID2D1Bitmap1, ID2D1DeviceContext, ID2D1Effect, ID2D1Image,
            },
            Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
            Imaging::{
                CLSID_WICImagingFactory, GUID_WICPixelFormat32bppPBGRA, IWICBitmapSource,
                IWICImagingFactory, WICBitmapInterpolationModeFant, WICConvertBitmapSource,
                WICDecodeMetadataCacheOnDemand,
            },
        },
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        },
        UI::WindowsAndMessaging::{KillTimer, SetTimer},
    },
    core::Interface,
};

use crate::{
    geom::Mat4,
    render::{DrawCx, rect_f},
    surface::Surface,
    view::{NshView, ViewState},
};

/// Decoded images kept in memory, in bytes (4 per pixel).
const CACHE_BYTES: usize = 128 << 20;

/// The largest download or file read.
const MAX_BYTES: u64 = 64 << 20;

/// Loader threads: reads, downloads and decodes run there.
const WORKERS: usize = 4;

/// Progress reports at most this often (a download reports its end too).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// The longest side of a decoded image, in pixels: larger images are
/// scaled down on the worker (every Direct3D 10+ device draws bitmaps this
/// big, and one this size already takes 256 MB).
const MAX_DIMENSION: u32 = 8192;

/// Where bundled (`asset:/…`) files are.
#[derive(Debug, Clone)]
pub enum AssetBase {
    /// Served over HTTP (the dev server): `http://host:port/assets/`.
    Http(String),
    /// A directory on disk.
    Directory(PathBuf),
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
            Some(location) => read(&location, None, &mut |_, _| {}).map(|b| b.to_vec()),
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

/// Resolves `uri` (`asset:/…` against `base`, `http(s)://`, `file:`, an
/// absolute Windows path, `data:`).
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
    if let Some(rest) = uri.strip_prefix("file:") {
        return file_uri(rest).map(Location::File);
    }
    absolute_path(uri).then(|| Location::File(uri.into()))
}

/// True for an absolute Windows path: `C:\…`, `C:/…` or a UNC path.
fn absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    let drive =
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
    drive || path.starts_with("\\\\") || path.starts_with("//")
}

/// The path of a `file:` URI (what follows `file:`): `///C:/a%20b.png`
/// is `C:\a b.png`, `//server/share/a.png` is `\\server\share\a.png`.
fn file_uri(rest: &str) -> Option<PathBuf> {
    let decoded = String::from_utf8(percent_decode(rest.as_bytes())).ok()?;
    let path = match decoded.strip_prefix("//") {
        // `file:///C:/…` (an empty host) or `file://localhost/C:/…`.
        Some(after) => match after.split_once('/') {
            Some(("" | "localhost", path)) => path.to_owned(),
            Some((host, path)) => format!("//{host}/{path}"),
            None => return None,
        },
        // `file:/C:/…` or `file:C:/…`.
        None => decoded.trim_start_matches('/').to_owned(),
    };
    let path = path.replace('/', "\\");
    absolute_path(&path).then(|| path.into())
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

/// The HTTP agent all downloads share.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(60)))
            // Every status is a response: the disk cache decides what a
            // `304` or a `5xx` means.
            .http_status_as_error(false)
            .build()
            .into()
    })
}

/// GETs `url` with `headers` (a revalidation's conditions) and reads the
/// body as it arrives (`progress(loaded, total)`, total 0: unknown).
fn download(
    url: &str,
    headers: &[(&'static str, String)],
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Fetched, String> {
    let mut request = agent().get(url);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    let mut response = request.call().map_err(|e| e.to_string())?;
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
            Some(cache) => cache.load(url, |headers| download(url, headers, progress)),
            None => download(url, &[], progress).and_then(|response| match response.status {
                200..=299 => Ok(response.body.into()),
                status => Err(format!("HTTP {status}")),
            }),
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

/// Decoded pixels: premultiplied BGRA, rows packed.
struct Pixels {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl Pixels {
    /// Straight RGBA (the `image` crate's) as premultiplied BGRA.
    fn from_rgba(rgba: image::RgbaImage) -> Pixels {
        let (width, height) = rgba.dimensions();
        let mut data = rgba.into_raw();
        premultiply_bgra(&mut data);
        Pixels {
            width,
            height,
            data,
        }
    }
}

/// Converts straight RGBA pixels to premultiplied BGRA in place.
fn premultiply_bgra(data: &mut [u8]) {
    let mul = |c: u8, a: u8| ((c as u32 * a as u32 + 127) / 255) as u8;
    for px in data.as_chunks_mut::<4>().0 {
        let (r, g, b, a) = (px[0], px[1], px[2], px[3]);
        px[0] = mul(b, a);
        px[1] = mul(g, a);
        px[2] = mul(r, a);
    }
}

/// What a worker decoded (sent to the main thread).
struct Decoded {
    /// The image, or every frame of an animation.
    frames: Vec<Pixels>,
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
    fn still(pixels: Pixels, size: (u32, u32)) -> Decoded {
        Decoded {
            frames: vec![pixels],
            delays: Vec::new(),
            plays: 0,
            size,
            points: None,
        }
    }
}

/// One decoded image (or frame) on the main thread: its pixels, and its
/// Direct2D bitmap once drawn.
pub(crate) struct Frame {
    pixels: Pixels,
    /// The bitmap and the device generation it was made in.
    bitmap: RefCell<Option<(u64, ID2D1Bitmap1)>>,
}

impl Frame {
    fn new(pixels: Pixels) -> Rc<Frame> {
        Rc::new(Frame {
            pixels,
            bitmap: RefCell::new(None),
        })
    }

    /// Its size in pixels (one point each, at 96 DPI).
    pub(crate) fn size(&self) -> (u32, u32) {
        (self.pixels.width, self.pixels.height)
    }

    /// Its bitmap on `dc`'s device, made on first use and again after a
    /// device loss.
    pub(crate) fn bitmap(&self, dc: &ID2D1DeviceContext) -> Option<ID2D1Bitmap1> {
        let generation = crate::gfx::generation();
        if let Some((g, b)) = &*self.bitmap.borrow()
            && *g == generation
        {
            return Some(b.clone());
        }
        let p = &self.pixels;
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let size = D2D_SIZE_U {
            width: p.width,
            height: p.height,
        };
        // SAFETY: `data` holds `height` rows of `width * 4` bytes.
        let made =
            unsafe { dc.CreateBitmap(size, Some(p.data.as_ptr().cast()), p.width * 4, &props) };
        match made {
            Ok(b) => {
                *self.bitmap.borrow_mut() = Some((generation, b.clone()));
                Some(b)
            }
            Err(e) => {
                log::warn!(
                    "image: cannot create a {}x{} bitmap: {e}",
                    p.width,
                    p.height
                );
                None
            }
        }
    }
}

/// A decoded image on the main thread.
#[derive(Clone)]
struct Picture {
    /// The image, or an animation's first frame.
    frame: Rc<Frame>,
    /// The source's size in pixels (an SVG's: whole points).
    size: (u32, u32),
    /// An SVG's intrinsic size, unrounded.
    points: Option<Size<Points>>,
    animation: Option<Rc<Animation>>,
}

impl Picture {
    fn new(decoded: Decoded) -> Option<Picture> {
        let Decoded {
            frames,
            delays,
            plays,
            size,
            points,
        } = decoded;
        let frames: Vec<Rc<Frame>> = frames.into_iter().map(Frame::new).collect();
        let frame = frames.first()?.clone();
        let animation = (frames.len() > 1).then(|| {
            Rc::new(Animation {
                frames,
                delays,
                plays,
            })
        });
        Some(Picture {
            frame,
            size,
            points,
            animation,
        })
    }

    /// Bytes its pixels take (4 per pixel, every frame).
    fn bytes(&self) -> usize {
        let (w, h) = self.frame.size();
        let frame = w as usize * h as usize * 4;
        frame * self.animation.as_ref().map_or(1, |a| a.frames.len())
    }
}

/// The frames of an animated image.
struct Animation {
    frames: Vec<Rc<Frame>>,
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
    let (mut pixels, mut delays, mut total) = (Vec::new(), Vec::new(), 0);
    for frame in frames.take(MAX_FRAMES) {
        let frame = match frame {
            Ok(frame) => frame,
            // A damaged frame ends the animation; what decoded plays.
            Err(e) if !pixels.is_empty() => {
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
            pixels.truncate(1);
            delays.truncate(1);
            if pixels.is_empty() {
                pixels.push(Pixels::from_rgba(buffer));
            }
            break;
        }
        pixels.push(Pixels::from_rgba(buffer));
        delays.push(delay);
    }
    let Some(first) = pixels.first() else {
        return Err("no frames".into());
    };
    let size = (first.width, first.height);
    if pixels.len() == 1 {
        delays.clear();
    }
    Ok(Some(Decoded {
        frames: pixels,
        delays,
        plays,
        size,
        points: None,
    }))
}

thread_local! {
    /// This worker's WIC factory (COM is initialized on the thread first).
    static WIC: Option<IWICImagingFactory> = {
        // SAFETY: initializes COM on this (worker) thread, which never
        // uninitializes it; a thread already initialized fails harmlessly.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // SAFETY: CoCreateInstance with a valid CLSID.
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| log::warn!("image: no WIC factory: {e}"))
            .ok()
    };
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

/// Decodes the first frame of an encoded image with WIC, as premultiplied
/// BGRA.
fn decode_wic(bytes: &[u8]) -> Result<Decoded, String> {
    WIC.with(|wic| {
        let wic = wic.as_ref().ok_or("no WIC factory")?;
        let e = |e: windows::core::Error| e.message();
        // SAFETY: COM calls on live objects of this thread; the stream
        // reads `bytes`, which outlive every object made from it here.
        unsafe {
            let stream = wic.CreateStream().map_err(e)?;
            stream.InitializeFromMemory(bytes).map_err(e)?;
            let decoder = wic
                .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
                .map_err(e)?;
            let frame = decoder.GetFrame(0).map_err(e)?;
            let mut source: IWICBitmapSource =
                WICConvertBitmapSource(&GUID_WICPixelFormat32bppPBGRA, &frame).map_err(e)?;
            let (mut w, mut h) = (0, 0);
            source.GetSize(&mut w, &mut h).map_err(e)?;
            if w == 0 || h == 0 {
                return Err("empty image".into());
            }
            let (tw, th) = bounded((w, h));
            if (tw, th) != (w, h) {
                log::debug!("image: {w}x{h} scaled down to {tw}x{th}");
                let scaler = wic.CreateBitmapScaler().map_err(e)?;
                scaler
                    .Initialize(&source, tw, th, WICBitmapInterpolationModeFant)
                    .map_err(e)?;
                source = scaler.cast().map_err(e)?;
            }
            let stride = tw * 4;
            let mut data = vec![0u8; stride as usize * th as usize];
            source
                .CopyPixels(std::ptr::null(), stride, &mut data)
                .map_err(e)?;
            Ok(Decoded::still(
                Pixels {
                    width: tw,
                    height: th,
                    data,
                },
                (w, h),
            ))
        }
    })
}

/// Draws an SVG at its intrinsic size × [`nsh_core::svg::OVERSAMPLE`] (at
/// most [`nsh_core::svg::MAX_OVERSAMPLED_SIDE`] a side), as premultiplied
/// BGRA: Direct2D scales it down to the size it is drawn at.
fn decode_svg(bytes: &[u8]) -> Result<Decoded, String> {
    let raster = nsh_core::svg::rasterize_oversampled(bytes).map_err(|e| e.to_string())?;
    let mut data = raster.pixels;
    for px in data.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    let reported = nsh_core::svg::reported_size(raster.size);
    let size = (reported.width.0 as u32, reported.height.0 as u32);
    let pixels = Pixels {
        width: raster.width,
        height: raster.height,
        data,
    };
    Ok(Decoded {
        points: Some(raster.size),
        ..Decoded::still(pixels, size)
    })
}

/// Decodes an encoded image (a worker): SVG with the shared rasterizer,
/// GIF and WebP with the `image` crate (every frame of animations), others
/// with WIC first.
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
    let wic_error = match decode_wic(bytes) {
        Ok(decoded) => return Ok(decoded),
        Err(e) => e,
    };
    let image = image::load_from_memory(bytes).map_err(|e| format!("{wic_error}; {e}"))?;
    let size = (image.width(), image.height());
    let image = match bounded(size) {
        b if b == size => image,
        (w, h) => image.resize(w, h, image::imageops::FilterType::Triangle),
    };
    Ok(Decoded::still(Pixels::from_rgba(image.into_rgba8()), size))
}

/// One load for the workers.
struct Job {
    key: String,
    location: Location,
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
        crate::window::invoke(move || {
            LOADER.with(|l| l.progress(&key, loaded, total));
        });
    };
    let result = read(&location, cache.as_ref(), &mut report).and_then(decode);
    crate::window::invoke(move || {
        let result = result.and_then(|d| Picture::new(d).ok_or_else(|| "no frames".to_owned()));
        finish(key, result);
    });
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

/// Loads `uri` for `surface`; `done` runs on the main thread. Returns
/// whether it already ran (cached, or a source that cannot load).
fn fetch(surface: &Surface, uri: &str, progress: Option<Progress>, done: Done) -> bool {
    let location = resolve(uri, surface.asset_base.borrow().as_ref());
    fetch_at(location, uri, disk_cache(surface, uri), progress, done)
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
            fetch_at(Some(location), &source.uri, None, progress, done)
        }
        None => fetch(surface, &source.uri, progress, done),
    }
}

/// Loads `location` (`uri`'s) through `cache`, as [`fetch`] does.
fn fetch_at(
    location: Option<Location>,
    uri: &str,
    cache: Option<DiskCache>,
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
            cache,
            progress: listens,
        });
    }
    false
}

/// Loads `uri` (`https://…`, `asset:/…`, a file path, `data:`) off the
/// main thread, through the image cache; `done` runs on the main thread
/// with the image (an animation's first frame) and the source's size in
/// pixels.
///
/// A cached image is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
pub(crate) fn load(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<(Rc<Frame>, (u32, u32)), String>) + 'static,
) {
    let done = move |result: Result<Picture, String>| done(result.map(|p| (p.frame, p.size)));
    fetch(surface, uri, None, Box::new(done));
}

/// Loads the bitmap `uri` for a canvas, as [`load`] does: canvases draw
/// bitmaps, so an SVG is an image that failed to load.
pub(crate) fn load_bitmap(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<Rc<Frame>, String>) + 'static,
) {
    let source = uri.to_owned();
    let done = move |result: Result<Picture, String>| {
        done(result.and_then(|p| match p.points {
            Some(_) => Err(format!(
                "{source} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
            )),
            None => Ok(p.frame),
        }));
    };
    fetch(surface, uri, None, Box::new(done));
}

/// The image of `uri` (an animation's first frame) if it is cached (to
/// draw without waiting).
#[allow(dead_code)]
pub(crate) fn cached(surface: &Surface, uri: &str) -> Option<Rc<Frame>> {
    let key = resolve(uri, surface.asset_base.borrow().as_ref())?.key();
    LOADER.with(|l| l.cached(&key)).map(|p| p.frame)
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

thread_local! {
    /// What each running thread timer calls, by timer id.
    static TIMERS: RefCell<FxHashMap<usize, Box<dyn FnOnce()>>> = RefCell::default();
}

/// Calls `f` once after `wait`, from the thread's message loop; returns
/// the timer, to [`cancel`] it.
fn after(wait: Duration, f: impl FnOnce() + 'static) -> Option<usize> {
    let ms = wait.as_millis().clamp(1, u32::MAX as u128) as u32;
    // SAFETY: a thread timer (no window) with a callback of the right
    // signature; the message loop of this thread dispatches it.
    let id = unsafe { SetTimer(None, 0, ms, Some(timer_proc)) };
    if id == 0 {
        log::warn!("image: cannot start a timer");
        return None;
    }
    TIMERS.with(|t| t.borrow_mut().insert(id, Box::new(f)));
    Some(id)
}

/// Stops a timer of [`after`].
fn cancel(id: usize) {
    // SAFETY: a thread timer this thread made.
    let _ = unsafe { KillTimer(None, id) };
    TIMERS.with(|t| t.borrow_mut().remove(&id));
}

unsafe extern "system" fn timer_proc(_: HWND, _: u32, id: usize, _: u32) {
    // Win32 timers repeat: this one is used once.
    // SAFETY: a thread timer this thread made.
    let _ = unsafe { KillTimer(None, id) };
    let f = TIMERS.with(|t| t.borrow_mut().remove(&id));
    if let Some(f) = f {
        f();
    }
}

/// An animation playing in a view.
struct Playback {
    animation: Rc<Animation>,
    timeline: Timeline,
    /// The timer of the next frame, while it plays.
    timer: Option<usize>,
    /// Bumped per timer: a timer that is not the latest is stale.
    serial: u64,
    /// The view was drawn since the frame last changed: it plays on.
    drawn: Cell<bool>,
    /// A drawing asked for playback to resume, which is on its way.
    resuming: Cell<bool>,
}

impl Playback {
    fn new(animation: Rc<Animation>) -> Playback {
        Playback {
            animation,
            timeline: Timeline::default(),
            timer: None,
            serial: 0,
            drawn: Cell::new(false),
            resuming: Cell::new(false),
        }
    }

    /// The frame to draw.
    fn frame(&self) -> &Rc<Frame> {
        &self.animation.frames[self.timeline.frame]
    }

    /// True when it waits for nothing: no timer, not finished.
    fn paused(&self) -> bool {
        let a = &self.animation;
        self.timer.is_none() && !self.timeline.finished(a.plays)
    }

    /// Advances to now; schedules the next frame (for the view `owner`)
    /// while it plays. Returns whether the frame changed.
    fn advance(&mut self, owner: (u64, NodeId)) -> bool {
        let now = monotonic();
        let a = &self.animation;
        let (changed, running) = self.timeline.advance(&a.delays, a.plays, now);
        if let Some(due) = self.timeline.due.filter(|_| running) {
            // Timers count whole milliseconds: one that fires early would
            // spin until the frame is due.
            let wait = Duration::from_millis(((due - now).max(0) as u64).div_ceil(1000));
            self.serial += 1;
            let serial = self.serial;
            self.timer = after(wait, move || step(owner, serial));
        }
        changed
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            cancel(timer);
        }
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
        // It ran: Win32 forgot it.
        p.timer = None;
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
                image.playback = picture.animation.clone().map(Playback::new);
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
                nsh_core::geometry::DevicePixels(picture.size.0 as i32),
                nsh_core::geometry::DevicePixels(picture.size.1 as i32),
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

/// The 5x4 color matrix that paints `tint` through the alpha of its input
/// (rows: input red, green, blue, alpha, then the constant; columns:
/// output red, green, blue, alpha; on straight colors).
fn tint_matrix(tint: nsh_core::Color) -> [f32; 20] {
    let (r, g, b, a) = tint.to_f64();
    let mut m = [0.0f32; 20];
    m[15] = a as f32;
    m[16] = r as f32;
    m[17] = g as f32;
    m[18] = b as f32;
    m
}

/// The effects images are drawn through, made once per device.
struct Effects {
    generation: u64,
    tint: ID2D1Effect,
    blur: ID2D1Effect,
}

thread_local! {
    static EFFECTS: RefCell<Option<Effects>> = const { RefCell::new(None) };
}

/// Runs `f` with the tint and blur effects of `dc`'s device.
fn with_effects<R>(dc: &ID2D1DeviceContext, f: impl FnOnce(&Effects) -> R) -> Option<R> {
    EFFECTS.with(|cell| {
        let mut cell = cell.borrow_mut();
        let generation = crate::gfx::generation();
        if cell.as_ref().is_none_or(|e| e.generation != generation) {
            // SAFETY: COM calls on the live context; the properties are set
            // with values of their types.
            let made = unsafe {
                (|| -> windows::core::Result<Effects> {
                    let tint = dc.CreateEffect(&CLSID_D2D1ColorMatrix)?;
                    let blur = dc.CreateEffect(&CLSID_D2D1GaussianBlur)?;
                    blur.SetValue(
                        D2D1_GAUSSIANBLUR_PROP_BORDER_MODE.0 as u32,
                        D2D1_PROPERTY_TYPE_ENUM,
                        &(D2D1_BORDER_MODE_HARD.0 as u32).to_ne_bytes(),
                    )?;
                    Ok(Effects {
                        generation,
                        tint,
                        blur,
                    })
                })()
            };
            match made {
                Ok(e) => *cell = Some(e),
                Err(e) => {
                    log::warn!("image: cannot create effects: {e}");
                    return None;
                }
            }
        }
        cell.as_ref().map(f)
    })
}

/// Draws one picture with the view's mode, tint and blur.
fn draw_one(
    cx: &mut DrawCx<'_>,
    state: &ViewState,
    image: &ImageState,
    frame: &Frame,
    (size, points): ((u32, u32), Option<Size<Points>>),
    source: Option<&ImageSource>,
) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let (x, y, fw, fh) = fit(
        image.mode,
        image.options.position,
        natural(size, points, source),
        (w, h),
    );
    if fw <= 0.0 || fh <= 0.0 {
        return;
    }
    let Some(bitmap) = frame.bitmap(cx.dc) else {
        return;
    };
    let (bw, bh) = frame.size();
    let (bw, bh) = (bw as f32, bh as f32);
    // Shrinking more than a 2× screen would: filtered like mipmaps.
    let interpolation: D2D1_INTERPOLATION_MODE = if bw > fw * cx.scale * 2.0 {
        D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC
    } else {
        D2D1_INTERPOLATION_MODE_LINEAR
    };
    let blur = image.options.blur_radius.0.max(0.0);
    let tint = state.style.tint_color;
    if blur <= 0.0 && tint.is_none() {
        // SAFETY: a COM call on the live context with a bitmap of its
        // device.
        unsafe {
            cx.dc.DrawBitmap(
                &bitmap,
                Some(&rect_f(x, y, fw, fh)),
                1.0,
                interpolation,
                None,
                None,
            )
        };
        return;
    }
    let saved = cx.transform;
    // Effects draw in the image's own pixels (one DIP each): mapped onto
    // the rectangle by the world transform.
    let (sx, sy) = (fw / bw, fh / bh);
    cx.set_transform(Mat4::new().translate(x, y).scale(sx, sy).then(&saved));
    with_effects(cx.dc, |effects| {
        // SAFETY: COM calls on the live context and effects of its device;
        // the property values have their types' sizes.
        unsafe {
            let Ok(mut input) = bitmap.cast::<ID2D1Image>() else {
                return;
            };
            if let Some(tint) = tint {
                let m = tint_matrix(tint);
                let bytes: Vec<u8> = m.iter().flat_map(|v| v.to_ne_bytes()).collect();
                let _ = effects.tint.SetValue(
                    D2D1_COLORMATRIX_PROP_COLOR_MATRIX.0 as u32,
                    D2D1_PROPERTY_TYPE_MATRIX_5X4,
                    &bytes,
                );
                effects.tint.SetInput(0, &input, true);
                match effects.tint.GetOutput() {
                    Ok(out) => input = out,
                    Err(_) => return,
                }
            }
            if blur > 0.0 {
                // A blur radius is twice the standard deviation (GSK's and
                // CSS's reading), in points: in image pixels here.
                let sigma = blur / 2.0 / sx.min(sy).max(1e-6);
                let _ = effects.blur.SetValue(
                    D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION.0 as u32,
                    D2D1_PROPERTY_TYPE_FLOAT,
                    &sigma.to_ne_bytes(),
                );
                effects.blur.SetInput(0, &input, true);
                match effects.blur.GetOutput() {
                    Ok(out) => input = out,
                    Err(_) => return,
                }
            }
            cx.dc.DrawImage(
                &input,
                None,
                None,
                interpolation,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
            // The effects keep no image alive between draws.
            effects.tint.SetInput(0, None, false);
            effects.blur.SetInput(0, None, false);
        }
    });
    cx.set_transform(saved);
}

/// Draws an image view's picture.
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(image) = &state.image else { return };
    let fading = image.fade.is_some();
    if let Some(placeholder) = &image.placeholder
        && (image.image.is_none() || fading)
    {
        let source = image.options.placeholder.as_ref();
        draw_one(
            cx,
            state,
            image,
            &placeholder.frame,
            (placeholder.size, placeholder.points),
            source,
        );
    }
    let Some(picture) = &image.image else { return };
    let frame = match &image.playback {
        Some(p) => {
            p.drawn.set(true);
            if p.paused() && !p.resuming.replace(true) {
                // Drawn again after it paused: resumes once this pass is
                // over (the view's state is borrowed while drawing).
                let owner = image.owner;
                crate::window::invoke(move || resume(owner));
            }
            p.frame()
        }
        None => &picture.frame,
    };
    let alpha = if fading { image.alpha } else { 1.0 };
    if alpha <= 0.0 {
        return;
    }
    if alpha < 1.0 {
        cx.push_opacity(alpha);
    }
    draw_one(
        cx,
        state,
        image,
        frame,
        (picture.size, picture.points),
        image.source.as_ref(),
    );
    if alpha < 1.0 {
        cx.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_uris() {
        let dir = AssetBase::Directory("C:\\app\\assets".into());
        let http = AssetBase::Http("http://10.0.0.2:8080/assets/".into());
        assert_eq!(
            resolve("asset:/img/a.png", Some(&dir)),
            Some(Location::File(
                PathBuf::from("C:\\app\\assets").join("img/a.png")
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
        assert_eq!(
            resolve("file:///C:/Users/a%20b.png", None),
            Some(Location::File("C:\\Users\\a b.png".into()))
        );
        assert_eq!(
            resolve("file://localhost/D:/x.png", None),
            Some(Location::File("D:\\x.png".into()))
        );
        assert_eq!(
            resolve("file://server/share/x.png", None),
            Some(Location::File("\\\\server\\share\\x.png".into()))
        );
        assert_eq!(resolve("file:///relative.png", None), None);
        assert_eq!(
            resolve("C:\\Users\\a.png", None),
            Some(Location::File("C:\\Users\\a.png".into()))
        );
        assert_eq!(
            resolve("c:/a.png", None),
            Some(Location::File("c:/a.png".into()))
        );
        assert_eq!(
            resolve("\\\\server\\share\\a.png", None),
            Some(Location::File("\\\\server\\share\\a.png".into()))
        );
        assert_eq!(resolve("relative.png", None), None);
        assert_eq!(resolve("C:relative.png", None), None);
        assert!(matches!(
            resolve("data:image/png;base64,AA==", None),
            Some(Location::Data(_))
        ));
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
    fn premultiplies() {
        let mut px = [255, 128, 0, 255, 255, 255, 255, 128, 10, 20, 30, 0];
        premultiply_bgra(&mut px);
        assert_eq!(px, [0, 128, 255, 255, 128, 128, 128, 128, 0, 0, 0, 0]);
    }

    #[test]
    fn bounds_huge_images() {
        assert_eq!(bounded((100, 50)), (100, 50));
        assert_eq!(bounded((16384, 4096)), (8192, 2048));
        assert_eq!(bounded((10, 100_000)), (1, 8192));
    }

    fn picture(w: u32, h: u32) -> Picture {
        Picture::new(Decoded::still(
            Pixels {
                width: w,
                height: h,
                data: vec![0; (w * h * 4) as usize],
            },
            (w, h),
        ))
        .unwrap()
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
    fn decodes_with_wic() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/gallery/logo@2x.png");
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let decoded = decode(bytes).unwrap();
        let p = &decoded.frames[0];
        assert_eq!((p.width, p.height), decoded.size);
        assert_eq!(p.data.len(), (p.width * p.height * 4) as usize);
        // Premultiplied: no channel above its alpha.
        assert!(
            p.data
                .as_chunks::<4>()
                .0
                .iter()
                .all(|c| c[0] <= c[3] && c[1] <= c[3] && c[2] <= c[3])
        );
    }

    const SVG_LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f" fill-opacity="0.5"/></svg>"##;

    #[test]
    fn svg_decodes_oversampled() {
        let decoded = decode(SVG_LOGO).unwrap();
        assert_eq!(decoded.points, Some(Size::new(Points(48.0), Points(24.0))));
        assert_eq!(decoded.size, (48, 24), "intrinsic size in points");
        let p = &decoded.frames[0];
        assert_eq!((p.width, p.height), (192, 96), "four pixels a point");
        let at = |x: u32, y: u32| -> [u8; 4] {
            let i = ((y * p.width + x) * 4) as usize;
            p.data[i..i + 4].try_into().unwrap()
        };
        // Premultiplied BGRA, as Direct2D's bitmaps.
        assert_eq!(at(10, 10), [0, 0, 255, 255]);
        let [b, g, r, a] = at(150, 50);
        assert!((127..=128).contains(&a), "alpha {a}");
        assert_eq!((b, g, r), (a, 0, 0));
        let big = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250"/>"#;
        let big = decode(big).unwrap();
        assert_eq!((big.frames[0].width, big.frames[0].height), (2048, 512));
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
        let picture = Picture::new(decode(SVG_LOGO).unwrap()).unwrap();
        assert_eq!(picture.size, (48, 24));
        assert_eq!(picture.frame.size(), (192, 96));
        assert_eq!(
            natural(picture.size, picture.points, Some(&source)),
            (48.0, 24.0)
        );
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decode(odd).unwrap();
        assert_eq!(odd.size, (11, 10));
        assert_eq!(natural(odd.size, odd.points, None), (10.5, 10.0));
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` is a color matrix over the premultiplied pixels: the
        // SVG's alpha decides where the color shows.
        let decoded = decode(SVG_LOGO).unwrap();
        let p = &decoded.frames[0];
        let m = tint_matrix(nsh_core::Color::rgba(0, 255, 0, 255));
        let alpha = |x: u32, y: u32| p.data[((y * p.width + x) * 4 + 3) as usize];
        // Green of the input's alpha only.
        assert_eq!(&m[15..19], &[1.0, 0.0, 1.0, 0.0]);
        assert_eq!(alpha(10, 10), 255);
        assert_eq!(alpha(0, 0), 255);
        assert!(alpha(150, 50) < 255);
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
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/gallery");
        for (name, format) in [
            ("bounce.gif", image::ImageFormat::Gif),
            ("spinner.webp", image::ImageFormat::WebP),
        ] {
            let bytes = std::fs::read(dir.join(name)).unwrap();
            assert_eq!(animated_format(&bytes), Some(format));
            let decoded = animation(&bytes, format).unwrap().unwrap();
            assert!(decoded.frames.len() > 1, "{name}");
            assert_eq!(decoded.frames.len(), decoded.delays.len());
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
    }

    #[test]
    fn tints_through_alpha() {
        let m = tint_matrix(nsh_core::Color::rgba(255, 0, 0, 255));
        // Red, of the input's alpha; nothing from its colors.
        assert_eq!(&m[15..19], &[1.0, 1.0, 0.0, 0.0]);
        assert!(m[..15].iter().all(|v| *v == 0.0));
    }
}
