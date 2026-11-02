//! Image views: loading (`asset:/`, files, HTTP; `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding into
//! GPUI images, drawing with the resize mode, corner radii, tint, blur,
//! filters, opacity and placeholder.
//!
//! Loads go through the core's shared loader and decoded images
//! ([`nsh_core::image::Images`], `docs/dev/images.md`): one read per source
//! in flight (redirects checked against the app's access policy), reads
//! and decodes on their own pools, the encoded bytes and failures
//! remembered, and pictures kept in the process's image budget, leased by
//! the views that show them. An image decodes at the size its view shows
//! it ([`Want`]: the size bucket covering its box in device pixels, never
//! above its natural size nor [`MAX_DIMENSION`] a side) with the `image`
//! crate (PNG, JPEG, GIF, WebP, BMP, ICO, TIFF; EXIF orientation applied;
//! every frame of animated GIF and WebP), shrunk as it decodes, into a GPUI
//! [`RenderImage`] (straight BGRA, one frame per animation frame); a view
//! that grows past its bucket loads the next one. SVG images (sniffed from
//! their bytes) are drawn by [`nsh_core::svg`] at the bucket's size and
//! then handled as bitmaps; their size is their intrinsic size in points.
//! Canvases draw bitmaps only ([`load_bitmap`]).
//!
//! A decoded entry's picture on the main thread ([`Image`]) counts what it
//! adds in its entry ([`nsh_core::image::MemoryCache::add_cost`]): its
//! atlas copy once drawn and its variants (their pixels and atlas copies).
//! Evicting the entry drops the picture, and its textures leave the
//! atlases once no view shows them.
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
    any::Any,
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc, LazyLock, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use gpui::{Corners, RenderImage};
pub use nsh_core::image::loader::AssetBase;
use nsh_core::{
    Color, Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId,
    ObjectPosition, PayloadValue, ResizeMode,
    geometry::{DevicePixels, Points, Size, size},
    image::{
        DiskCache, Frames, Images, Key, Lease, Natural, Request, Target, Want,
        loader::{Context, Priority, ReadAsset, Ticket, loader},
    },
};
use rustc_hash::FxHashMap;

use crate::{
    render::DrawCx,
    rt,
    surface::Surface,
    view::{NshView, ViewState},
};

/// Threads that make variants.
const WORKERS: usize = 4;

/// The longest side of a decoded image, in pixels: larger images are
/// scaled down as they decode (the texture size every GPU takes, and one
/// this size already takes 256 MB).
const MAX_DIMENSION: u32 = 8192;

/// Variants a picture keeps (more while recent ones are still drawn).
const VARIANTS: usize = 4;

/// Opacity levels of variants: drawing at an opacity rounds it to one.
const ALPHA_STEPS: u8 = 16;

/// The largest stack blur radius at a variant's size, in pixels: larger
/// blurs scale the variant down first (a blur hides the lost detail).
const MAX_BLUR: f32 = 16.0;

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

/// The default bundled location, or the reader bound to an engine load.
/// `Engine(None)` deliberately disables assets instead of falling back to a base.
#[derive(Default)]
pub(crate) enum AssetSource {
    #[default]
    Base,
    Engine(Option<ReadAsset>),
}

impl AssetSource {
    pub(crate) fn engine(assets: Option<Arc<dyn nsh_engine::Assets>>) -> Self {
        Self::Engine(assets.map(|assets| ReadAsset::new(move |uri: &str| assets.read(uri))))
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

/// What a load of `uri` for `surface` goes through: its asset base, its
/// access policy and, for remote images, its disk cache (`asset:/` URIs,
/// served by the dev server during development, change as the app does:
/// never kept).
fn context(surface: &Surface, uri: &str) -> Context {
    let remote = uri.starts_with("http://") || uri.starts_with("https://");
    let (asset_base, read_asset) = match &*surface.image_assets.borrow() {
        AssetSource::Base => (surface.asset_base.borrow().clone(), None),
        AssetSource::Engine(read) => (None, read.clone()),
    };
    Context {
        asset_base,
        read_asset,
        access: surface.access.borrow().clone(),
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

/// What a decode made (any thread; the budget keeps it): the pixels of
/// every frame.
#[derive(Clone)]
struct Pixels {
    /// Names its picture on the main thread ([`PICTURES`]).
    id: u64,
    /// The image, every frame of an animation.
    image: Arc<RenderImage>,
    /// Each frame's delay in ms (animations).
    delays: Arc<[u32]>,
    /// Plays before it stops on its last frame; 0: forever.
    plays: u32,
    /// Its own size (an SVG's in points: what it lays out at and reports,
    /// whatever its file name says), whatever size it was decoded at.
    natural: Natural,
}

impl Pixels {
    fn new(frames: Vec<image::Frame>, delays: Vec<u32>, plays: u32, natural: Natural) -> Pixels {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Pixels {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            image: Arc::new(RenderImage::new(frames)),
            delays: delays.into(),
            plays,
            natural,
        }
    }

    /// Its size in pixels (as decoded).
    fn size(&self) -> (u32, u32) {
        let size = self.image.size(0);
        (size.width.0.max(0) as u32, size.height.0.max(0) as u32)
    }

    /// Bytes its pixels take (4 per pixel, every frame).
    fn bytes(&self) -> usize {
        let (w, h) = self.size();
        w as usize * h as usize * 4 * self.image.frame_count().max(1)
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
) -> Result<Option<Pixels>, String> {
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
    let mut natural = None;
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
        let (w, h) = buffer.dimensions();
        natural.get_or_insert(Natural::Pixels(w, h));
        let buffer = shrunk(buffer, longest);
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
    let Some(natural) = natural.filter(|_| !buffers.is_empty()) else {
        return Err("no frames".into());
    };
    if buffers.len() == 1 {
        delays.clear();
    }
    let frames = buffers.into_iter().map(bgra_frame).collect();
    Ok(Some(Pixels::new(frames, delays, plays, natural)))
}

/// Decodes a still image (any format the `image` crate reads), turned
/// upright as its EXIF orientation says, its longest side at most
/// `longest` pixels (0: its own).
fn decode_still(bytes: &[u8], longest: u32) -> Result<Pixels, String> {
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
    // Shrunk as decoded (a JPEG's RGB), before it takes 4 bytes a pixel.
    let image = match scaled(size, longest) {
        s if s == size => image,
        (w, h) => image.thumbnail(w, h),
    };
    Ok(Pixels::new(
        vec![bgra_frame(image.into_rgba8())],
        Vec::new(),
        0,
        Natural::Pixels(size.0, size.1),
    ))
}

/// The natural size the header of `bytes` tells, turned as its EXIF
/// orientation says (a photo taken sideways reports its upright size, as
/// it is shown).
fn upright(bytes: &[u8]) -> Option<Natural> {
    use image::{ImageDecoder, metadata::Orientation};
    let natural = Natural::of(bytes)?;
    let Natural::Pixels(w, h) = natural else {
        return Some(natural);
    };
    let orientation = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_decoder().ok())
        .and_then(|mut decoder| decoder.orientation().ok());
    let turned = matches!(
        orientation,
        Some(
            Orientation::Rotate90
                | Orientation::Rotate270
                | Orientation::Rotate90FlipH
                | Orientation::Rotate270FlipH
        )
    );
    Some(if turned {
        Natural::Pixels(h, w)
    } else {
        natural
    })
}

/// Draws an SVG, its longest side `longest` pixels (premultiplied RGBA),
/// into one straight BGRA frame.
fn decode_svg(bytes: &[u8], longest: u32) -> Result<Pixels, String> {
    let raster = nsh_core::svg::rasterize(bytes, longest.max(1)).map_err(|e| e.to_string())?;
    let mut data = raster.pixels;
    unpremultiply(&mut data);
    swap_red_blue(&mut data);
    let frame = image::RgbaImage::from_raw(raster.width, raster.height, data)
        .ok_or("SVG raster of the wrong size")?;
    Ok(Pixels::new(
        vec![image::Frame::new(frame)],
        Vec::new(),
        0,
        Natural::Vector(raster.size),
    ))
}

/// Decodes an encoded image at `target` (a decoding thread): every frame
/// of animations when it asks.
fn decode(bytes: &[u8], target: &Target) -> Result<Pixels, String> {
    let longest = target.longest;
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes, longest);
    }
    if target.frames == Frames::All
        && let Some(format) = animated_format(bytes)
    {
        match animation(bytes, format, longest) {
            Ok(Some(pixels)) => return Ok(pixels),
            Ok(None) => {}
            Err(e) => log::debug!("image: not decoded as an animation: {e}"),
        }
    }
    decode_still(bytes, longest)
}

/// The size `onLoad` and `Image.getSize` report: pixels, or an SVG's whole
/// points.
fn reported_size(natural: Natural) -> Size<DevicePixels> {
    match natural {
        Natural::Vector(points) => nsh_core::svg::reported_size(points),
        Natural::Pixels(w, h) => size(DevicePixels(w as i32), DevicePixels(h as i32)),
    }
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

    /// Bytes its pixels take (4 per pixel, every frame).
    fn bytes(&self) -> usize {
        let size = self.0.size(0);
        let (w, h) = (size.width.0.max(0) as usize, size.height.0.max(0) as usize);
        w * h * 4 * self.frames().max(1)
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

/// A decoded image on the main thread (shared by its budget entry and the
/// views showing it).
pub(crate) struct Image {
    /// The image, every frame of an animation.
    texture: Rc<Texture>,
    /// Its size in pixels (as decoded).
    pixels: (u32, u32),
    /// Its own size (an SVG's in points).
    natural: Natural,
    /// Each frame's delay in ms (animations).
    delays: Arc<[u32]>,
    /// Plays before it stops on its last frame; 0: forever.
    plays: u32,
    variants: RefCell<Vec<Variant>>,
    /// Its entry in the budget, which its atlas copy and its variants count
    /// in.
    key: Key,
    /// Its atlas copy is counted (it was drawn).
    drawn: Cell<bool>,
}

/// A decoded image, shared.
type Picture = Rc<Image>;

impl Image {
    /// Bytes its pixels take (4 per pixel, every frame).
    fn bytes(&self) -> usize {
        let (w, h) = self.pixels;
        w as usize * h as usize * 4 * self.texture.frames().max(1)
    }

    /// True when it is an animation.
    fn animated(&self) -> bool {
        self.delays.len() > 1
    }

    /// Adds `delta` bytes to what its entry costs (an atlas copy or a
    /// variant made, or dropped).
    fn count(&self, delta: isize) {
        images().memory().add_cost(&self.key, delta);
    }
}

thread_local! {
    /// The main-thread pictures of the decoded entries, by [`Pixels::id`]:
    /// kept until the entry is evicted, then dropped (their textures leave
    /// the atlases once the views showing them let go too).
    static PICTURES: RefCell<FxHashMap<u64, Picture>> = RefCell::default();
}

/// The main-thread picture of `pixels`, decoded as `key`'s entry.
fn picture(pixels: &Pixels, key: Key) -> Picture {
    if let Some(picture) = PICTURES.with_borrow(|m| m.get(&pixels.id).cloned()) {
        return picture;
    }
    let picture = Rc::new(Image {
        texture: Rc::new(Texture(pixels.image.clone())),
        pixels: pixels.size(),
        natural: pixels.natural,
        delays: pixels.delays.clone(),
        plays: pixels.plays,
        variants: RefCell::default(),
        key: key.clone(),
        drawn: Cell::new(false),
    });
    // An entry evicted already would never drop it: it is not kept.
    if images().memory().contains(&key) {
        PICTURES.with_borrow_mut(|m| m.insert(pixels.id, picture.clone()));
    }
    picture
}

/// The process's decoded images, in the core's budget.
fn images() -> &'static Images<Pixels> {
    static IMAGES: LazyLock<Images<Pixels>> = LazyLock::new(|| {
        Images::with_on_evict(
            nsh_core::image::budget(),
            |bytes: &ImageData, target: &Target| {
                let pixels = decode(bytes, target)?;
                let cost = pixels.bytes();
                Ok((pixels.clone(), pixels.natural, cost))
            },
            // Its picture goes with it (and with that its textures, once
            // no view shows them).
            |pixels: &Pixels| {
                let id = pixels.id;
                rt::invoke(move || {
                    PICTURES.with_borrow_mut(|m| m.remove(&id));
                });
            },
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
/// runs it there from any thread ([`rt::invoke`], also from the main
/// thread), unless it was forgotten ([`Load`]'s drop).
fn on_main<T: Send + 'static>(f: impl FnOnce(T) + 'static) -> (u64, impl FnOnce(T) + Send) {
    let id = next_id();
    let f: Box<dyn FnOnce(T)> = Box::new(f);
    WAITING.with_borrow_mut(|w| w.insert(id, Box::new(f) as Box<dyn Any>));
    let run = move |value: T| {
        rt::invoke(move || {
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
    let context = context(surface, &source.uri);
    let Some(location) = context.locate(source) else {
        done(Err(format!("unsupported image source `{}`", source.uri)));
        return None;
    };
    let listener = next_id();
    let progress = progress.map(|p| {
        PROGRESS.with_borrow_mut(|m| m.insert(listener, Rc::from(p)));
        Arc::new(move |loaded: u64, total: u64| {
            rt::invoke(move || {
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
        let key = images().key_of(&request, decoded.natural);
        done(Ok((picture(&decoded.value, key), lease)));
        return None;
    }
    let keyed = request.clone();
    let (id, done) = on_main(move |result: Result<(Pixels, Key, Lease), String>| {
        PROGRESS.with_borrow_mut(|p| p.remove(&listener));
        done(result.map(|(pixels, key, lease)| (picture(&pixels, key), lease)));
    });
    let ticket = images().load(
        request,
        Box::new(move |result| {
            done(result.map(|(decoded, lease)| {
                let key = images().key_of(&keyed, decoded.natural);
                (decoded.value, key, lease)
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
/// the main thread with the image (every frame of an animation: frame 0
/// is the first). Canvases draw bitmaps: an SVG is an image that failed
/// to load.
///
/// A cached image is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
pub(crate) fn load_bitmap(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<Rc<Texture>, String>) + 'static,
) {
    let name = uri.to_owned();
    let done = move |result: Result<(Picture, Lease), String>| {
        done(result.and_then(|(p, _)| match p.natural {
            Natural::Vector(_) => Err(format!(
                "{name} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
            )),
            Natural::Pixels(..) => Ok(p.texture.clone()),
        }));
    };
    let source = ImageSource {
        uri: uri.into(),
        size: None,
        scales: nsh_core::ImageScales::NONE,
        data: None,
    };
    // A canvas keeps the texture itself: the load runs to its end.
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
    let weak = Rc::downgrade(surface);
    let generation = surface.load_generation();
    let report = move |result: Result<Natural, String>| {
        let Some(surface) = weak.upgrade() else {
            return;
        };
        if surface.load_generation() != generation {
            return;
        }
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
            Box::new(move |bytes| match bytes.map(|b| upright(&b)) {
                Ok(Some(natural)) => report(Ok(natural)),
                Ok(None) => images()
                    .load(decode, Box::new(move |r| report(r.map(|(d, _)| d.natural))))
                    .detach(),
                Err(e) => report(Err(e)),
            }),
        )
        .detach();
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
        // Its pixels and their atlas copy count in the picture's entry.
        let made = texture.bytes();
        v.texture = Some(texture);
        let freed = trim(&mut variants, monotonic());
        picture.count(2 * (made as isize - freed as isize));
    }
    if let Some(surface) = Surface::by_key(surface) {
        surface.invalidate();
    }
}

/// Drops the least recently drawn variants beyond [`VARIANTS`], keeping
/// the ones being made and the ones drawn in the last second (which may
/// still be on screen); returns the bytes of their pixels.
fn trim(variants: &mut Vec<Variant>, now: i64) -> usize {
    let mut freed = 0;
    while variants.len() > VARIANTS {
        let oldest = variants
            .iter()
            .enumerate()
            .filter(|(_, v)| v.texture.is_some() && now - v.used.get() > 1_000_000)
            .min_by_key(|(_, v)| v.used.get())
            .map(|(i, _)| i);
        match oldest {
            Some(i) => {
                let gone = variants.swap_remove(i);
                freed += gone.texture.map_or(0, |t| t.bytes());
            }
            None => break,
        }
    }
    freed
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

/// An animation playing in a view.
struct Playback {
    delays: Arc<[u32]>,
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
    rt::invoke(move || {
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
        let (w, h) = picture.pixels;
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
        if image.playback.is_some() != picture.animated() {
            image.playback = picture.animated().then(|| Playback::new(&picture));
            if let Some(p) = image.playback.as_mut() {
                p.advance(owner);
            }
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
        natural(picture.natural, source),
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
    // Its atlas copy counts in its entry once drawn.
    if Rc::ptr_eq(&texture, &picture.texture) && !picture.drawn.replace(true) {
        picture.count(picture.bytes() as isize);
    }
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
    fn disk_cache_is_remote_only_and_cleared_with_load() {
        let surface = Surface::new(nsh_engine::Environment::default());
        set_asset_base(
            &surface,
            Some(AssetBase::Http("https://dev.test/assets/".into())),
        );
        let cache = DiskCache::open("first-engine-cache", nsh_core::ByteSize::mib(1)).unwrap();
        set_disk_cache(&surface, Some(cache));
        let retained = context(&surface, "https://example.test/image.png")
            .disk
            .unwrap();
        assert_eq!(retained.dir(), std::path::Path::new("first-engine-cache"));
        assert!(
            context(&surface, "http://example.test/image.png")
                .disk
                .is_some()
        );
        for uri in [
            "asset:/image.png",
            "data:image/png;base64,AA==",
            "blob:local",
            "file:/image.png",
        ] {
            assert!(
                context(&surface, uri).disk.is_none(),
                "{uri} is never disk cached"
            );
        }
        surface.stop();
        assert!(
            context(&surface, "https://example.test/image.png")
                .disk
                .is_none()
        );
        // A running worker retains its original handle across a replacement load.
        set_disk_cache(
            &surface,
            DiskCache::open("second-engine-cache", nsh_core::ByteSize::mib(1)),
        );
        assert_eq!(retained.dir(), std::path::Path::new("first-engine-cache"));
        assert_eq!(
            context(&surface, "https://example.test/image.png")
                .disk
                .unwrap()
                .dir(),
            std::path::Path::new("second-engine-cache")
        );
    }

    #[test]
    fn inline_bytes_bypass_missing_engine_assets() {
        let surface = Surface::new(nsh_engine::Environment::default());
        set_asset_base(
            &surface,
            Some(AssetBase::Directory("fallback-assets".into())),
        );
        *surface.image_assets.borrow_mut() = AssetSource::Engine(None);
        let source = ImageSource {
            uri: "asset:/inline-load-guard.svg".into(),
            data: Some(SVG_ICON.to_vec().into()),
            ..Default::default()
        };
        let context = context(&surface, &source.uri);
        assert!(context.resolve(&source.uri).is_none());
        let location = context.locate(&source).unwrap();
        let bytes = nsh_core::image::loader::read_now(&location, &context).unwrap();
        assert_eq!(bytes.as_ref(), SVG_ICON);
    }

    #[test]
    fn scales_to_the_size_shown() {
        assert_eq!(scaled((100, 50), 0), (100, 50));
        assert_eq!(scaled((100, 50), 512), (100, 50), "never enlarged");
        assert_eq!(scaled((4000, 3000), 512), (512, 384));
        assert_eq!(scaled((16384, 4096), 0), (8192, 2048));
        assert_eq!(scaled((10, 100_000), 0), (1, 8192));
    }

    /// `bytes` decoded with its longest side `longest` pixels (0: its own).
    fn decoded(bytes: &[u8], longest: u32) -> Result<Pixels, String> {
        let target = Target {
            natural: Natural::of(bytes),
            longest,
            frames: Frames::All,
        };
        decode(bytes, &target)
    }

    #[test]
    fn decodes_pngs_as_bgra() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/gallery/logo@2x.png");
        let bytes = std::fs::read(path).unwrap();
        let rgba = image::load_from_memory(&bytes).unwrap().into_rgba8();
        let decoded = decoded(&bytes, 0).unwrap();
        let (w, h) = rgba.dimensions();
        assert_eq!(decoded.size(), (w, h));
        assert_eq!(decoded.natural, Natural::Pixels(w, h));
        // Shrunk as it decodes, its own size kept.
        let small = super::decode(
            &bytes,
            &Target {
                natural: Natural::of(&bytes),
                longest: 16,
                frames: Frames::First,
            },
        )
        .unwrap();
        assert_eq!(small.size().0.max(small.size().1), 16);
        assert_eq!(small.natural, decoded.natural);
        let bgra = decoded.image.as_bytes(0).unwrap();
        // Red and blue swapped, alpha straight.
        let pixels = rgba.as_raw().as_chunks::<4>().0.iter();
        for (a, b) in pixels.zip(bgra.as_chunks::<4>().0) {
            assert_eq!([a[2], a[1], a[0], a[3]], *b);
        }
    }

    /// A 4×2 JPEG whose EXIF orientation is `orientation` (1–8).
    fn jpeg_turned(orientation: u16) -> Vec<u8> {
        use image::ImageEncoder;
        // A little-endian TIFF block with one entry: Orientation (0x0112),
        // a SHORT.
        let mut exif = b"II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend_from_slice(&orientation.to_le_bytes());
        exif.extend_from_slice(&[0; 6]);
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut bytes);
        encoder.set_exif_metadata(exif).unwrap();
        let pixels = image::RgbImage::from_pixel(4, 2, image::Rgb([200, 40, 40]));
        encoder
            .write_image(pixels.as_raw(), 4, 2, image::ExtendedColorType::Rgb8)
            .unwrap();
        bytes
    }

    #[test]
    fn get_size_reports_photos_upright() {
        // 5–8 turn the picture a quarter: its sides swap, as the decode's do.
        for orientation in 5..=8 {
            let bytes = jpeg_turned(orientation);
            assert_eq!(Natural::of(&bytes), Some(Natural::Pixels(4, 2)));
            assert_eq!(
                upright(&bytes),
                Some(Natural::Pixels(2, 4)),
                "{orientation}"
            );
            assert_eq!(decoded(&bytes, 0).unwrap().natural, Natural::Pixels(2, 4));
        }
        for orientation in 1..=4 {
            let bytes = jpeg_turned(orientation);
            assert_eq!(
                upright(&bytes),
                Some(Natural::Pixels(4, 2)),
                "{orientation}"
            );
        }
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
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/gallery");
        for (name, format) in [
            ("bounce.gif", image::ImageFormat::Gif),
            ("spinner.webp", image::ImageFormat::WebP),
        ] {
            let bytes = std::fs::read(dir.join(name)).unwrap();
            assert_eq!(animated_format(&bytes), Some(format));
            let decoded = animation(&bytes, format, 0).unwrap().unwrap();
            assert!(decoded.image.frame_count() > 1, "{name}");
            let small = animation(&bytes, format, 8).unwrap().unwrap();
            assert!(small.size().0.max(small.size().1) <= 8, "{name}");
            assert_eq!(small.natural, decoded.natural);
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
    fn bgra(decoded: &Pixels, x: u32, y: u32) -> [u8; 4] {
        let width = decoded.size().0;
        let i = ((y * width + x) * 4) as usize;
        decoded.image.as_bytes(0).unwrap()[i..i + 4]
            .try_into()
            .unwrap()
    }

    #[test]
    fn svg_decodes_at_the_size_shown() {
        let logo = decoded(SVG_LOGO, 192).unwrap();
        assert_eq!(
            logo.natural,
            Natural::Vector(Size::new(Points(48.0), Points(24.0)))
        );
        assert_eq!(logo.size(), (192, 96), "four pixels a point");
        // Straight BGRA: the half-transparent blue is not premultiplied.
        assert_eq!(bgra(&logo, 10, 10), [0, 0, 255, 255]);
        let [b, g, r, a] = bgra(&logo, 150, 50);
        assert_eq!((b, g, r), (255, 0, 0));
        assert!((127..=128).contains(&a), "alpha {a}");
        let big = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250"/>"#;
        assert_eq!(decoded(big, 2048).unwrap().size(), (2048, 512));
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
        let logo = decoded(SVG_LOGO, 192).unwrap();
        assert_eq!(natural(logo.natural, Some(&source)), (48.0, 24.0));
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decoded(odd, 32).unwrap();
        let size = reported_size(odd.natural);
        assert_eq!((size.width.0, size.height.0), (11, 10));
        assert_eq!(natural(odd.natural, None), (10.5, 10.0));
    }

    #[test]
    fn svg_draws_no_text_or_embedded_images() {
        // GPUI's own resvg / usvg enable text and raster images: an SVG
        // still draws neither (no fonts loaded, the resolver resolves
        // nothing).
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><text x="0" y="9" font-size="10" fill="#f00">NSH</text><image width="20" height="10" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="/></svg>"##;
        let decoded = decoded(svg, 20).unwrap();
        assert_eq!(decoded.size(), (20, 10));
        let bytes = decoded.image.as_bytes(0).unwrap();
        assert!(bytes.iter().all(|&b| b == 0), "nothing drawn");
    }

    #[test]
    fn svg_tints_through_alpha() {
        // A variant tinted red: the SVG's shape in red, the rest transparent.
        let icon = decoded(SVG_ICON, 96).unwrap();
        let size = icon.size();
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
