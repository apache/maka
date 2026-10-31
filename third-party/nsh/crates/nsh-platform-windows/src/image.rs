//! Image views: loading (`asset:/`, files, HTTP; `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding into
//! Direct2D bitmaps, drawing with the resize mode, tint, blur and
//! placeholder.
//!
//! Loads go through the core's shared loader and decoded images
//! ([`nsh_core::image::Images`], `docs/dev/images.md`): one read per source
//! in flight, reads and decodes on their own pools, the encoded bytes and
//! failures remembered, and pictures kept in the process's image budget,
//! leased by the views that show them. An image decodes at the size its
//! view shows it ([`Want`]: the size bucket covering its box in device
//! pixels, never above its natural size nor [`MAX_DIMENSION`] a side):
//! with WIC (COM initialized on each decoding thread) for PNG / JPEG /
//! BMP / TIFF / ICO / HEIF / WebP when a codec is installed, shrunk by
//! WIC's scaler; GIF and WebP animations, and what WIC cannot read, with
//! the `image` crate. A view that grows past its bucket loads the next one.
//! SVG images (sniffed from their bytes) are drawn by [`nsh_core::svg`] at
//! the bucket's size; their picture keeps their intrinsic size in points,
//! which they are laid out with and report. Canvases draw bitmaps only
//! ([`load_bitmap`]).
//!
//! A [`Frame`] keeps its pixels (premultiplied BGRA) and makes its Direct2D
//! bitmap on the main thread when first drawn (a bitmap is a device
//! resource: after a device loss, [`crate::gfx::generation`] changes and
//! the bitmap is made again from the pixels). The bitmap counts in its
//! picture's entry once made ([`nsh_core::image::MemoryCache::add_cost`])
//! and goes with it: evicting a picture releases its bitmaps. Bitmaps are
//! 96 DPI, so one image pixel is one point; a file named `…@2x.png` (or a
//! source with a declared size) has its natural size scaled accordingly,
//! as on iOS.
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
    any::Any,
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc, LazyLock, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

pub use nsh_core::image::loader::AssetBase;
use nsh_core::{
    Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId, ObjectPosition,
    PayloadValue, ResizeMode,
    geometry::{DevicePixels, Points, Size, size},
    image::{
        DiskCache, Frames, Images, Key, Lease, Natural, Request, Target, Want,
        loader::{Context, Priority, Ticket, loader},
    },
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

/// The longest side of a decoded image, in pixels: larger images are
/// scaled down as they decode (every Direct3D 10+ device draws bitmaps
/// this big, and one this size already takes 256 MB).
const MAX_DIMENSION: u32 = 8192;

/// Reads `asset:/…` files for the engine (fonts), on the engine thread.
pub(crate) struct AssetReader(pub(crate) Option<AssetBase>);

impl nsh_engine::Assets for AssetReader {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        if !uri.starts_with("asset:/") {
            return Err(format!("not an asset URI: {uri}"));
        }
        let context = Context {
            asset_base: self.0.clone(),
            ..Context::default()
        };
        match context.resolve(uri) {
            Some(location) => {
                nsh_core::image::loader::read_now(&location, &context).map(|b| b.to_vec())
            }
            None => Err(format!("{uri}: no asset location configured")),
        }
    }

    fn base(&self) -> Option<AssetBase> {
        self.0.clone()
    }
}

/// The disk cache of what this surface's images download (`None`: none).
pub(crate) fn set_disk_cache(surface: &Surface, cache: Option<DiskCache>) {
    *surface.image_cache.borrow_mut() = cache;
}

/// Where this surface's images resolve `asset:/` URIs.
pub(crate) fn set_asset_base(surface: &Rc<Surface>, base: Option<AssetBase>) {
    *surface.asset_base.borrow_mut() = base;
}

/// What a load of `uri` for `surface` goes through: its asset base and,
/// for remote images, its disk cache (`asset:/` URIs, served by the dev
/// server during development, change as the app does: never kept).
/// Surfaces here keep no access policy: redirects are allowed anywhere
/// but from `https` down to `http`, as before.
fn context(surface: &Surface, uri: &str) -> Context {
    let remote = uri.starts_with("http://") || uri.starts_with("https://");
    Context {
        asset_base: surface.asset_base.borrow().clone(),
        read_asset: None,
        access: Arc::default(),
        disk: remote
            .then(|| surface.image_cache.borrow().clone())
            .flatten(),
        transport: None,
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

thread_local! {
    /// The main thread's Direct2D bitmaps by frame, with the device
    /// generation each was made in.
    static BITMAPS: RefCell<FxHashMap<u64, (u64, ID2D1Bitmap1)>> = RefCell::default();
}

/// One decoded image (or frame): its pixels, and its Direct2D bitmap on
/// the main thread once drawn.
pub(crate) struct Frame {
    pixels: Pixels,
    /// Names its bitmap in [`BITMAPS`].
    id: u64,
    /// The decoded entry it belongs to, which its bitmap counts in (set
    /// once it is loaded).
    key: OnceLock<Key>,
    /// It has a bitmap (or had one, released since).
    drawn: AtomicBool,
    /// Its bitmap's bytes were added to its entry's cost.
    counted: AtomicBool,
}

impl Frame {
    fn new(pixels: Pixels) -> Arc<Frame> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Arc::new(Frame {
            pixels,
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            key: OnceLock::new(),
            drawn: AtomicBool::new(false),
            counted: AtomicBool::new(false),
        })
    }

    /// Its size in pixels (one point each, at 96 DPI).
    pub(crate) fn size(&self) -> (u32, u32) {
        (self.pixels.width, self.pixels.height)
    }

    /// Its bitmap on `dc`'s device, made on first use and again after a
    /// device loss (main thread).
    pub(crate) fn bitmap(&self, dc: &ID2D1DeviceContext) -> Option<ID2D1Bitmap1> {
        let generation = crate::gfx::generation();
        let made = BITMAPS.with_borrow(|b| {
            b.get(&self.id)
                .filter(|(g, _)| *g == generation)
                .map(|(_, b)| b.clone())
        });
        if made.is_some() {
            return made;
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
                BITMAPS.with_borrow_mut(|m| m.insert(self.id, (generation, b.clone())));
                self.drawn.store(true, Ordering::Relaxed);
                // The GPU copy counts in the budget, once: one made again
                // after a device loss replaces the lost one.
                if let Some(key) = self.key.get()
                    && !self.counted.swap(true, Ordering::Relaxed)
                {
                    images().memory().add_cost(key, p.data.len() as isize);
                }
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

    /// Releases its bitmap, on the main thread (any thread; a frame drawn
    /// again makes it again).
    fn release(&self) {
        if self.drawn.swap(false, Ordering::Relaxed) {
            let id = self.id;
            crate::window::invoke(move || {
                BITMAPS.with_borrow_mut(|m| m.remove(&id));
            });
        }
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        self.release();
    }
}

/// A decoded image.
#[derive(Clone)]
struct Picture {
    /// The image, or an animation's first frame.
    frame: Arc<Frame>,
    animation: Option<Arc<Animation>>,
    /// Its own size (an SVG's in points: what it lays out at and reports,
    /// whatever its file name says), whatever size it was decoded at.
    natural: Natural,
}

impl Picture {
    fn still(pixels: Pixels, natural: Natural) -> Picture {
        Picture {
            frame: Frame::new(pixels),
            animation: None,
            natural,
        }
    }

    /// Its frames: the image, or every frame of its animation.
    fn frames(&self) -> &[Arc<Frame>] {
        match &self.animation {
            Some(a) => &a.frames,
            None => std::slice::from_ref(&self.frame),
        }
    }

    /// Bytes its pixels take (4 per pixel, every frame); each bitmap adds
    /// as much once made.
    fn cost(&self) -> usize {
        self.frames().iter().map(|f| f.pixels.data.len()).sum()
    }

    /// It is kept as `key`: its bitmaps count there.
    fn adopt(&self, key: &Key) {
        for frame in self.frames() {
            let _ = frame.key.set(key.clone());
        }
    }

    /// Releases its bitmaps (it was evicted).
    fn release(&self) {
        for frame in self.frames() {
            frame.release();
        }
    }
}

/// The frames of an animated image.
struct Animation {
    frames: Vec<Arc<Frame>>,
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

/// The size an image of `size` pixels decodes at to have its longest side
/// `longest` pixels long (0: its own): never larger than it is, nor than
/// [`MAX_DIMENSION`] a side.
fn scaled(size: (u32, u32), longest: u32) -> (u32, u32) {
    let (w, h) = size;
    let side = w.max(h);
    let limit = match longest {
        0 => MAX_DIMENSION,
        l => l.min(MAX_DIMENSION),
    };
    if side <= limit {
        return size;
    }
    let f = limit as f64 / side as f64;
    (
        ((w as f64 * f).round() as u32).max(1),
        ((h as f64 * f).round() as u32).max(1),
    )
}

/// `rgba` scaled to [`scaled`]'s size.
fn shrunk(rgba: image::RgbaImage, longest: u32) -> image::RgbaImage {
    let size = rgba.dimensions();
    match scaled(size, longest) {
        s if s == size => rgba,
        (w, h) => image::imageops::thumbnail(&rgba, w, h),
    }
}

/// Decodes the frames of a GIF or WebP, its longest side at most `longest`
/// pixels (0: its own); `None` when it is a still image (or too large to
/// animate: then it decodes as one).
fn animation(
    bytes: &[u8],
    format: image::ImageFormat,
    longest: u32,
) -> Result<Option<Picture>, String> {
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
    let mut natural = None;
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
        let (w, h) = buffer.dimensions();
        natural.get_or_insert(Natural::Pixels(w, h));
        let buffer = shrunk(buffer, longest);
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
    let Some(natural) = natural.filter(|_| !pixels.is_empty()) else {
        return Err("no frames".into());
    };
    let frames: Vec<Arc<Frame>> = pixels.into_iter().map(Frame::new).collect();
    let first = frames[0].clone();
    let animation = (frames.len() > 1).then(|| {
        Arc::new(Animation {
            frames,
            delays,
            plays,
        })
    });
    Ok(Some(Picture {
        frame: first,
        animation,
        natural,
    }))
}

thread_local! {
    /// This thread's WIC factory (COM is initialized on the thread first).
    static WIC: Option<IWICImagingFactory> = {
        // SAFETY: initializes COM on this (decoding) thread, which never
        // uninitializes it; a thread already initialized fails harmlessly.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // SAFETY: CoCreateInstance with a valid CLSID.
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| log::warn!("image: no WIC factory: {e}"))
            .ok()
    };
}

/// Decodes the first frame of an encoded image with WIC, as premultiplied
/// BGRA, its longest side at most `longest` pixels (0: its own; WIC's
/// scaler shrinks it).
fn decode_wic(bytes: &[u8], longest: u32) -> Result<Picture, String> {
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
            // Scaled after the conversion: on premultiplied pixels, so
            // transparent edges do not darken.
            let (tw, th) = scaled((w, h), longest);
            if (tw, th) != (w, h) {
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
            let pixels = Pixels {
                width: tw,
                height: th,
                data,
            };
            Ok(Picture::still(pixels, Natural::Pixels(w, h)))
        }
    })
}

/// Draws an SVG, its longest side `longest` pixels, as premultiplied BGRA.
fn decode_svg(bytes: &[u8], longest: u32) -> Result<Picture, String> {
    let raster = nsh_core::svg::rasterize(bytes, longest.max(1)).map_err(|e| e.to_string())?;
    let mut data = raster.pixels;
    for px in data.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    let pixels = Pixels {
        width: raster.width,
        height: raster.height,
        data,
    };
    Ok(Picture::still(pixels, Natural::Vector(raster.size)))
}

/// The size `onLoad` and `Image.getSize` report: pixels, or an SVG's whole
/// points.
fn reported_size(natural: Natural) -> Size<DevicePixels> {
    match natural {
        Natural::Vector(points) => nsh_core::svg::reported_size(points),
        Natural::Pixels(w, h) => size(DevicePixels(w as i32), DevicePixels(h as i32)),
    }
}

/// Decodes an encoded image at `target` (a decoding thread): SVG with the
/// shared rasterizer, GIF and WebP with the `image` crate (every frame of
/// animations), others with WIC first.
fn decode(bytes: &[u8], target: &Target) -> Result<Picture, String> {
    let longest = target.longest;
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes, longest);
    }
    if target.frames == Frames::All
        && let Some(format) = animated_format(bytes)
    {
        match animation(bytes, format, longest) {
            Ok(Some(picture)) => return Ok(picture),
            Ok(None) => {}
            Err(e) => log::debug!("image: not decoded as an animation: {e}"),
        }
    }
    let wic_error = match decode_wic(bytes, longest) {
        Ok(picture) => return Ok(picture),
        Err(e) => e,
    };
    let image = image::load_from_memory(bytes).map_err(|e| format!("{wic_error}; {e}"))?;
    let (w, h) = (image.width(), image.height());
    let image = match scaled((w, h), longest) {
        s if s == (w, h) => image,
        (tw, th) => image.thumbnail(tw, th),
    };
    Ok(Picture::still(
        Pixels::from_rgba(image.into_rgba8()),
        Natural::Pixels(w, h),
    ))
}

/// The process's decoded images, in the core's budget.
fn images() -> &'static Images<Picture> {
    static IMAGES: LazyLock<Images<Picture>> = LazyLock::new(|| {
        Images::with_on_evict(
            nsh_core::image::budget(),
            |bytes: &ImageData, target: &Target| {
                let picture = decode(bytes, target)?;
                let cost = picture.cost();
                Ok((picture.clone(), picture.natural, cost))
            },
            // Its bitmaps go with it (a canvas still drawing one of its
            // frames makes that bitmap again, uncounted).
            Picture::release,
        )
    });
    &IMAGES
}

/// Called with a load's picture (and the lease that keeps it) or error.
type Done = Box<dyn FnOnce(Result<(Picture, Lease), String>)>;

/// Called with a download's bytes so far and its size (0: unknown).
type Progress = Box<dyn Fn(u64, u64)>;

/// Main-thread callbacks by id.
type Waiting<T> = RefCell<FxHashMap<u64, T>>;

thread_local! {
    /// The main thread's side of the loads running: their callbacks
    /// (`Box<dyn FnOnce(T)>`) and progress listeners, by id.
    static WAITING: Waiting<Box<dyn Any>> = RefCell::default();
    static PROGRESS: Waiting<Rc<dyn Fn(u64, u64)>> = RefCell::default();
    static NEXT: Cell<u64> = const { Cell::new(0) };
}

fn next_id() -> u64 {
    NEXT.with(|n| {
        n.set(n.get() + 1);
        n.get()
    })
}

/// Keeps `f` on the main thread as callback `id`; the function returned
/// runs it there from any thread (posted, also from the main thread),
/// unless it was forgotten ([`Load`]'s drop).
fn on_main<T: Send + 'static>(f: impl FnOnce(T) + 'static) -> (u64, impl FnOnce(T) + Send) {
    let id = next_id();
    let f: Box<dyn FnOnce(T)> = Box::new(f);
    WAITING.with_borrow_mut(|w| w.insert(id, Box::new(f) as Box<dyn Any>));
    let run = move |value: T| {
        crate::window::invoke(move || {
            let f = WAITING.with_borrow_mut(|w| w.remove(&id));
            if let Some(f) = f.and_then(|f| f.downcast::<Box<dyn FnOnce(T)>>().ok()) {
                f(value);
            }
        });
    };
    (id, run)
}

/// A load running for a view: dropping it gives up (and cancels the load
/// when nobody else waits for it).
pub(crate) struct Load {
    ticket: Option<Ticket>,
    /// Its callback and progress listener.
    ids: (u64, u64),
}

impl Load {
    /// Lets it run to its end, callback included.
    fn detach(mut self) {
        if let Some(ticket) = self.ticket.take() {
            ticket.detach();
        }
    }
}

impl Drop for Load {
    fn drop(&mut self) {
        if self.ticket.is_some() {
            WAITING.with_borrow_mut(|w| w.remove(&self.ids.0));
            PROGRESS.with_borrow_mut(|p| p.remove(&self.ids.1));
        }
    }
}

/// Loads `source` at `want` for `surface`; `done` runs on the main thread.
/// Returns the load while it runs, `None` when `done` already ran (in
/// memory, or a source that cannot load).
///
/// A cached picture is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
fn fetch(
    surface: &Surface,
    source: &ImageSource,
    want: Want,
    frames: Frames,
    priority: Priority,
    progress: Option<Progress>,
    done: Done,
) -> Option<Load> {
    let context = context(surface, &source.uri);
    let Some(location) = context.locate(source) else {
        done(Err(format!("unsupported image source `{}`", source.uri)));
        return None;
    };
    let listener = next_id();
    let progress = progress.map(|p| {
        PROGRESS.with_borrow_mut(|m| m.insert(listener, Rc::from(p)));
        Arc::new(move |loaded: u64, total: u64| {
            crate::window::invoke(move || {
                if let Some(p) = PROGRESS.with_borrow(|m| m.get(&listener).cloned()) {
                    p(loaded, total);
                }
            });
        }) as nsh_core::image::loader::Progress
    });
    let request = Request {
        location,
        context,
        declared: source.size,
        want,
        frames,
        priority,
        progress,
    };
    // In memory: here and now, as the callers expect.
    if let Some((decoded, lease)) = images().cached(&request) {
        PROGRESS.with_borrow_mut(|p| p.remove(&listener));
        // Decoded for `getSize`, it may not know its key yet.
        decoded
            .value
            .adopt(&images().key_of(&request, decoded.natural));
        done(Ok((decoded.value, lease)));
        return None;
    }
    let (id, done) = on_main(move |result| {
        PROGRESS.with_borrow_mut(|p| p.remove(&listener));
        done(result);
    });
    let keyed = request.clone();
    let ticket = images().load(
        request,
        Box::new(move |result| {
            done(result.map(|(decoded, lease)| {
                decoded
                    .value
                    .adopt(&images().key_of(&keyed, decoded.natural));
                (decoded.value, lease)
            }))
        }),
    );
    Some(Load {
        ticket: Some(ticket),
        ids: (id, listener),
    })
}

/// Loads the bitmap `uri` (`https://…`, `asset:/…`, a file path, `data:`)
/// for a canvas off the main thread, at its natural size; `done` runs on
/// the main thread with the image (an animation's first frame). Canvases
/// draw bitmaps: an SVG is an image that failed to load.
///
/// A cached image is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
pub(crate) fn load_bitmap(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<Arc<Frame>, String>) + 'static,
) {
    let name = uri.to_owned();
    let done = move |result: Result<(Picture, Lease), String>| {
        done(result.and_then(|(p, _)| match p.natural {
            Natural::Vector(_) => Err(format!(
                "{name} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
            )),
            Natural::Pixels(..) => Ok(p.frame),
        }));
    };
    let source = ImageSource {
        uri: uri.into(),
        size: None,
        scales: nsh_core::ImageScales::NONE,
        data: None,
    };
    // A canvas keeps the frame itself: the load runs to its end.
    if let Some(load) = fetch(
        surface,
        &source,
        Want::natural(1.0),
        Frames::First,
        Priority::Normal,
        None,
        Box::new(done),
    ) {
        load.detach();
    }
}

/// `Command::ImageInfo` (`Image.getSize`, `Image.prefetch`): reads the
/// image's bytes (into the loader's memory and disk caches) and reports its
/// size in pixels (an SVG's: its intrinsic size in points), from its
/// header when it says, else by decoding it.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    let Command::ImageInfo { id, uri } = command else {
        return;
    };
    let request = *id;
    let key = surface.key();
    let report = move |result: Result<Natural, String>| {
        let Some(surface) = Surface::by_key(key) else {
            return;
        };
        let mut fields = vec![("id", PayloadValue::Number(request as f64))];
        match result {
            Ok(natural) => {
                let size = reported_size(natural);
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
    let context = context(surface, uri);
    let Some(location) = context.resolve(uri) else {
        report(Err(format!("unsupported image source `{uri}`")));
        return;
    };
    let (_, report) = on_main(report);
    let decode = Request {
        location: location.clone(),
        context: context.clone(),
        declared: None,
        want: Want::natural(1.0),
        frames: Frames::First,
        priority: Priority::Prefetch,
        progress: None,
    };
    // The header first; a decode only for what it cannot tell.
    loader()
        .read(
            location,
            &context,
            Priority::Prefetch,
            None,
            Box::new(move |bytes| match bytes.map(|b| Natural::of(&b)) {
                Ok(Some(natural)) => report(Ok(natural)),
                Ok(None) => images()
                    .load(decode, Box::new(move |r| report(r.map(|(d, _)| d.natural))))
                    .detach(),
                Err(e) => report(Err(e)),
            }),
        )
        .detach();
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
    /// The source's picture, once loaded, and the lease that keeps it.
    image: Option<Picture>,
    lease: Lease,
    /// The source's load running (a first one, or a larger size).
    load: Option<Load>,
    /// The placeholder's picture, until the image shows.
    placeholder: Option<Picture>,
    placeholder_lease: Lease,
    placeholder_load: Option<Load>,
    /// Its loads wait for the view's first frame.
    deferred: bool,
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
    animation: Arc<Animation>,
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
    fn new(animation: Arc<Animation>) -> Playback {
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
    fn frame(&self) -> &Arc<Frame> {
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

/// The size `surface` shows an image in a box of `frame` at: the box in
/// device pixels, fitted by `mode`.
fn want(surface: &Surface, frame: Size<Points>, mode: ResizeMode) -> Want {
    Want {
        size: frame,
        scale: surface.scale(),
        mode,
    }
}

/// An image view's source changed.
pub(crate) fn set(
    surface: &Rc<Surface>,
    view: &NshView,
    source: Option<&ImageSource>,
    mode: ResizeMode,
    options: &ImageOptions,
) {
    {
        let mut s = view.state_mut();
        let id = s.id;
        let image = s.image.get_or_insert_with(ImageState::default);
        image.owner = (surface.key(), id);
        let same_source = image.source.as_ref() == source;
        let same_placeholder = image.options.placeholder == options.placeholder;
        image.mode = mode;
        image.options = options.clone();
        if same_source && same_placeholder {
            drop(s);
            view.changed();
            // A new resize mode may show it larger.
            resized(surface, view);
            return;
        }
        image.generation += 1;
        if !same_source {
            image.source = source.cloned();
            image.image = None;
            image.lease = Lease::none();
            image.load = None;
            image.fade = None;
            image.playback = None;
        }
        if !same_placeholder {
            image.placeholder = None;
            image.placeholder_lease = Lease::none();
            image.placeholder_load = None;
        }
    }
    view.changed();
    let laid_out = {
        let frame = view.state().frame.size;
        frame.width.0 > 0.0 || frame.height.0 > 0.0
    };
    if laid_out {
        start(surface, view);
        return;
    }
    // A new view's frame comes after its source in the same batch: its
    // loads start once it has one (posted, so after the batch), so they
    // decode at the size it shows them.
    let (generation, owner) = {
        let mut s = view.state_mut();
        let Some(image) = s.image.as_mut().filter(|i| !i.deferred) else {
            return;
        };
        image.deferred = true;
        (image.generation, image.owner)
    };
    crate::window::invoke(move || {
        let (Some(surface), Some(view)) = (Surface::by_key(owner.0), owner_view(owner)) else {
            return;
        };
        let current = view.state_mut().image.as_mut().is_some_and(|i| {
            i.deferred = false;
            i.generation == generation
        });
        if current {
            start(&surface, &view);
        }
    });
}

/// Starts the loads `view` waits for: its source's, then its placeholder's
/// (not needed when the source is in memory).
fn start(surface: &Rc<Surface>, view: &NshView) {
    let (generation, events, owner, source, frame, mode) = {
        let s = view.state();
        let (events, frame) = (s.events, s.frame.size);
        let Some(image) = s.image.as_ref() else {
            return;
        };
        let source = image
            .source
            .clone()
            .filter(|_| image.image.is_none() && image.load.is_none());
        (
            image.generation,
            events,
            image.owner,
            source,
            frame,
            image.mode,
        )
    };
    let id = owner.1;
    let want = want(surface, frame, mode);
    if let Some(source) = source {
        let progress = events.contains(EventKind::Progress).then(|| {
            Box::new(move |loaded: u64, total: u64| {
                let Some(surface) = Surface::by_key(owner.0) else {
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
            move |result: Result<(Picture, Lease), String>| {
                if let Some(surface) = Surface::by_key(owner.0)
                    && let Some(view) = surface.view(id)
                {
                    loaded(&surface, &view, generation, result, waited.get());
                }
            }
        };
        let load = fetch(
            surface,
            &source,
            want,
            Frames::All,
            Priority::Visible,
            progress,
            Box::new(done),
        );
        waited.set(true);
        if let Some(load) = load {
            if let Some(i) = view.state_mut().image.as_mut()
                && i.generation == generation
            {
                i.load = Some(load);
            }
            if events.contains(EventKind::LoadStart) {
                surface.event(id, EventKind::LoadStart, EventPayload::None);
            }
        }
    }
    let placeholder = view.state().image.as_ref().and_then(|i| {
        let wanted = i.image.is_none() && i.placeholder.is_none() && i.placeholder_load.is_none();
        i.options.placeholder.clone().filter(|_| wanted)
    });
    if let Some(placeholder) = placeholder {
        let done = move |result: Result<(Picture, Lease), String>| {
            let Some(view) = owner_view(owner) else {
                return;
            };
            match result {
                Ok((picture, lease)) => {
                    if let Some(i) = view.state_mut().image.as_mut()
                        && i.generation == generation
                    {
                        i.placeholder = Some(picture);
                        i.placeholder_lease = lease;
                        i.placeholder_load = None;
                    }
                    view.changed();
                }
                Err(message) => log::warn!("image placeholder failed: {message}"),
            }
        };
        let load = fetch(
            surface,
            &placeholder,
            want,
            Frames::All,
            Priority::Visible,
            None,
            Box::new(done),
        );
        if let Some(load) = load
            && let Some(i) = view.state_mut().image.as_mut()
            && i.generation == generation
        {
            i.placeholder_load = Some(load);
        }
    }
}

/// `view`'s frame changed: an image now shown larger than it was decoded
/// loads the larger size, showing the smaller one meanwhile.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    let (generation, owner, source, want) = {
        let s = view.state();
        let frame = s.frame.size;
        let Some(image) = s.image.as_ref() else {
            return;
        };
        let (Some(picture), Some(source)) = (&image.image, &image.source) else {
            return;
        };
        if image.load.is_some() {
            return;
        }
        let want = want(surface, frame, image.mode);
        let density = context(surface, &source.uri)
            .locate(source)
            .map_or(1.0, |l| l.density());
        let longest = want.longest(picture.natural, density, source.size);
        let (w, h) = picture.frame.size();
        if longest <= w.max(h) {
            return;
        }
        (image.generation, image.owner, source.clone(), want)
    };
    let done = move |result: Result<(Picture, Lease), String>| {
        let Some(view) = owner_view(owner) else {
            return;
        };
        let mut s = view.state_mut();
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        image.load = None;
        let Ok((picture, lease)) = result else { return };
        // The same image, larger: no new load events; an animation plays
        // on from the frame it was.
        if let (Some(p), Some(animation)) = (image.playback.as_mut(), picture.animation.clone())
            && animation.frames.len() == p.animation.frames.len()
        {
            p.animation = animation;
        }
        image.image = Some(picture);
        image.lease = lease;
        drop(s);
        view.changed();
    };
    let load = fetch(
        surface,
        &source,
        want,
        Frames::All,
        Priority::Visible,
        None,
        Box::new(done),
    );
    if let Some(load) = load
        && let Some(i) = view.state_mut().image.as_mut()
        && i.generation == generation
    {
        i.load = Some(load);
    }
}

/// The source of `view` loaded (or failed); `waited`: it was not cached,
/// so it fades in (when the app asked for a fade).
fn loaded(
    surface: &Rc<Surface>,
    view: &NshView,
    generation: u64,
    result: Result<(Picture, Lease), String>,
    waited: bool,
) {
    let (events, id, fades) = {
        let mut s = view.state_mut();
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        image.load = None;
        match &result {
            Ok((picture, lease)) => {
                image.image = Some(picture.clone());
                image.lease = lease.clone();
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
                // The image shows: the placeholder is no longer needed.
                if image.fade.is_none() {
                    image.placeholder_load = None;
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
        Ok((picture, _)) if events.contains(EventKind::Load) => surface.event(
            id,
            EventKind::Load,
            EventPayload::Image(reported_size(picture.natural)),
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
    // It may have been laid out larger while it loaded.
    if result.is_ok() {
        resized(surface, view);
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

/// The natural size in points of a picture of `own` size loaded from
/// `source`: the size the source declares, an SVG's intrinsic size, or its
/// pixels over the file name's density.
fn natural(own: Natural, source: Option<&ImageSource>) -> (f32, f32) {
    if let Some(size) = source
        .and_then(|s| s.size)
        .map(|s| (s.width.0, s.height.0))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
    {
        return size;
    }
    let d = source.map_or(1.0, |s| nsh_core::image::loader::density(&s.uri));
    let points = own.points(d);
    (points.width.0, points.height.0)
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
    (frame, own): (&Frame, Natural),
    source: Option<&ImageSource>,
) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let (x, y, fw, fh) = fit(
        image.mode,
        image.options.position,
        natural(own, source),
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
            (&placeholder.frame, placeholder.natural),
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
        (frame, picture.natural),
        image.source.as_ref(),
    );
    if alpha < 1.0 {
        cx.pop();
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use nsh_core::image::loader::{Location, resolve};

    use super::*;

    /// Where `uri` resolves on Windows, as a path (`None`: not a file).
    fn file(uri: &str, base: Option<&AssetBase>) -> Option<PathBuf> {
        match resolve(uri, base)? {
            Location::File(path) => Some(path),
            _ => None,
        }
    }

    #[test]
    fn resolves_windows_paths() {
        let dir = AssetBase::Directory("C:\\app\\assets".into());
        let http = AssetBase::Http("http://10.0.0.2:8080/assets/".into());
        assert_eq!(
            file("asset:/img/a.png", Some(&dir)),
            Some(PathBuf::from("C:\\app\\assets").join("img/a.png"))
        );
        assert!(matches!(
            resolve("asset:/a.png", Some(&http)),
            Some(Location::Url(url)) if url == "http://10.0.0.2:8080/assets/a.png"
        ));
        assert!(resolve("asset:/a.png", None).is_none());
        assert_eq!(
            file("file:///C:/Users/a%20b.png", None),
            Some("C:\\Users\\a b.png".into())
        );
        assert_eq!(
            file("file://localhost/D:/x.png", None),
            Some("D:\\x.png".into())
        );
        assert_eq!(
            file("file://server/share/x.png", None),
            Some("\\\\server\\share\\x.png".into())
        );
        assert_eq!(
            file("C:\\Users\\a.png", None),
            Some("C:\\Users\\a.png".into())
        );
        assert_eq!(file("c:/a.png", None), Some("c:/a.png".into()));
        assert_eq!(
            file("\\\\server\\share\\a.png", None),
            Some("\\\\server\\share\\a.png".into())
        );
        assert!(resolve("relative.png", None).is_none());
        assert!(resolve("C:relative.png", None).is_none());
    }

    #[test]
    fn premultiplies() {
        let mut px = [255, 128, 0, 255, 255, 255, 255, 128, 10, 20, 30, 0];
        premultiply_bgra(&mut px);
        assert_eq!(px, [0, 128, 255, 255, 128, 128, 128, 128, 0, 0, 0, 0]);
    }

    #[test]
    fn scales_to_the_size_shown() {
        assert_eq!(scaled((100, 50), 0), (100, 50));
        assert_eq!(scaled((100, 50), 512), (100, 50), "never enlarged");
        assert_eq!(scaled((4000, 3000), 512), (512, 384));
        assert_eq!(scaled((16384, 4096), 0), (8192, 2048));
        assert_eq!(scaled((16384, 4096), 10_000), (8192, 2048));
        assert_eq!(scaled((10, 100_000), 0), (1, 8192));
    }

    /// `bytes` decoded with its longest side `longest` pixels (0: its own).
    fn decoded(bytes: &[u8], longest: u32) -> Result<Picture, String> {
        let target = Target {
            natural: Natural::of(bytes),
            longest,
            frames: Frames::All,
        };
        decode(bytes, &target)
    }

    #[test]
    fn decodes_with_wic() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/gallery/logo@2x.png");
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let picture = decoded(&bytes, 0).unwrap();
        let p = &picture.frame.pixels;
        assert_eq!(picture.natural, Natural::Pixels(p.width, p.height));
        assert_eq!(p.data.len(), (p.width * p.height * 4) as usize);
        // Premultiplied: no channel above its alpha.
        assert!(
            p.data
                .as_chunks::<4>()
                .0
                .iter()
                .all(|c| c[0] <= c[3] && c[1] <= c[3] && c[2] <= c[3])
        );
        // Shrunk by WIC's scaler, its own size kept.
        let small = decoded(&bytes, 16).unwrap();
        let (w, h) = small.frame.size();
        assert_eq!(w.max(h), 16);
        assert_eq!(small.natural, picture.natural);
        assert_eq!(small.cost(), (w * h * 4) as usize);
    }

    const SVG_LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f" fill-opacity="0.5"/></svg>"##;

    #[test]
    fn svg_decodes_at_the_size_shown() {
        let picture = decoded(SVG_LOGO, 192).unwrap();
        assert_eq!(
            picture.natural,
            Natural::Vector(Size::new(Points(48.0), Points(24.0)))
        );
        let p = &picture.frame.pixels;
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
        assert_eq!(decoded(big, 2048).unwrap().frame.size(), (2048, 512));
        assert!(decoded(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect", 64).is_err());
    }

    #[test]
    fn svg_size_is_in_points() {
        let source = ImageSource {
            uri: "asset:/logo@2x.svg".into(),
            size: None,
            scales: nsh_core::ImageScales::NONE,
            data: None,
        };
        let picture = decoded(SVG_LOGO, 192).unwrap();
        assert_eq!(natural(picture.natural, Some(&source)), (48.0, 24.0));
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decoded(odd, 32).unwrap();
        let reported = reported_size(odd.natural);
        assert_eq!((reported.width.0, reported.height.0), (11, 10));
        assert_eq!(natural(odd.natural, None), (10.5, 10.0));
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` is a color matrix over the premultiplied pixels: the
        // SVG's alpha decides where the color shows.
        let picture = decoded(SVG_LOGO, 192).unwrap();
        let p = &picture.frame.pixels;
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
        let source = ImageSource {
            uri: "asset:/logo@2x.png".into(),
            size: None,
            scales: Default::default(),
            data: None,
        };
        assert_eq!(
            natural(Natural::Pixels(200, 100), Some(&source)),
            (100.0, 50.0)
        );
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
            let picture = animation(&bytes, format, 0).unwrap().unwrap();
            let a = picture.animation.as_ref().unwrap();
            assert!(a.frames.len() > 1, "{name}");
            assert_eq!(a.frames.len(), a.delays.len());
            assert!(a.delays.iter().all(|&d| d >= 20));
            assert!(Arc::ptr_eq(&picture.frame, &a.frames[0]));
            // Shrunk frame by frame, its own size kept.
            let small = animation(&bytes, format, 8).unwrap().unwrap();
            assert_eq!(small.natural, picture.natural);
            let (w, h) = small.frame.size();
            assert!(w.max(h) <= 8);
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
