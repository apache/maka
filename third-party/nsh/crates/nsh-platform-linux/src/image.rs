//! Image views: loading (`asset:/`, files, HTTP; `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding into
//! textures, drawing with the resize mode, tint, blur and placeholder.
//!
//! Loads go through the core's shared loader and decoded images
//! ([`nsh_core::image::Images`], `docs/dev/images.md`): one read per source
//! in flight, reads and decodes on their own pools, the encoded bytes and
//! failures remembered, and textures kept in the process's image budget,
//! leased by the views that show them. An image decodes at the size its
//! view shows it ([`Want`]: the size bucket covering its box in device
//! pixels, never above its natural size), with the `image` crate when it
//! shrinks and GDK's own PNG / JPEG / TIFF loaders otherwise (GIF and WebP
//! with the `image` crate); a view that grows past its bucket loads the
//! next one. A texture's GPU copy lives as long as the texture: GSK drops
//! it when the last reference (the cache's, the views') goes. SVG images
//! (sniffed from their bytes) are drawn by [`nsh_core::svg`] at the
//! bucket's size; their picture keeps their intrinsic size in points, which
//! they are laid out with and report. Canvases draw bitmaps only
//! ([`load_bitmap`]).
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
    any::Any,
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{Arc, LazyLock},
    time::Duration,
};

use gtk4::{self as gtk, gdk, glib, graphene, gsk, prelude::*};
pub use nsh_core::image::loader::AssetBase;
use nsh_core::{
    Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId, ObjectPosition,
    PayloadValue, ResizeMode,
    geometry::{DevicePixels, Points, Size, size},
    image::{
        DiskCache, Frames, Images, Lease, Natural, Request, Target, Want,
        loader::{Context, Priority, Ticket, loader},
    },
};
use rustc_hash::FxHashMap;

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

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

/// What a load of `uri` for `surface` goes through: its asset base, its
/// access policy and, for remote images, its disk cache (`asset:/` URIs,
/// served by the dev server during development, change as the app does:
/// never kept).
fn context(surface: &Surface, uri: &str) -> Context {
    let remote = uri.starts_with("http://") || uri.starts_with("https://");
    Context {
        asset_base: surface.asset_base.borrow().clone(),
        read_asset: None,
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

/// A decoded image.
#[derive(Clone)]
struct Picture {
    /// The image, or an animation's first frame.
    texture: gdk::Texture,
    animation: Option<Arc<Animation>>,
    /// Its own size (an SVG's in points: what it lays out at and reports,
    /// whatever its file name says), whatever size it was decoded at.
    natural: Natural,
}

impl Picture {
    fn still(texture: gdk::Texture) -> Self {
        let natural = Natural::Pixels(texture.width() as u32, texture.height() as u32);
        Picture {
            texture,
            animation: None,
            natural,
        }
    }

    /// Bytes its pixels take (4 per pixel, every frame), twice: the
    /// texture's memory and its GPU copy once drawn.
    fn cost(&self) -> usize {
        let frame =
            self.texture.width().max(0) as usize * self.texture.height().max(0) as usize * 4;
        2 * frame * self.animation.as_ref().map_or(1, |a| a.frames.len())
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

/// `rgba` with its longest side `longest` pixels long, when that shrinks
/// it.
fn shrunk(rgba: image::RgbaImage, longest: u32) -> image::RgbaImage {
    let (w, h) = rgba.dimensions();
    if longest == 0 || longest >= w.max(h) {
        return rgba;
    }
    let scale = longest as f64 / w.max(h) as f64;
    let side = |n: u32| ((n as f64 * scale).round() as u32).max(1);
    image::imageops::thumbnail(&rgba, side(w), side(h))
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
    let (mut textures, mut delays, mut total) = (Vec::new(), Vec::new(), 0);
    let mut natural = None;
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
        let (w, h) = buffer.dimensions();
        natural.get_or_insert(Natural::Pixels(w, h));
        let buffer = shrunk(buffer, longest);
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
    let (Some(first), Some(natural)) = (textures.first().cloned(), natural) else {
        return Err("no frames".into());
    };
    let animation = (textures.len() > 1).then(|| {
        Arc::new(Animation {
            frames: textures,
            delays,
            plays,
        })
    });
    Ok(Some(Picture {
        texture: first,
        animation,
        natural,
    }))
}

/// Draws an SVG into a texture, its longest side `longest` pixels; any
/// thread.
fn decode_svg(bytes: &[u8], longest: u32) -> Result<Picture, String> {
    let raster = nsh_core::svg::rasterize(bytes, longest.max(1)).map_err(|e| e.to_string())?;
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
        natural: Natural::Vector(raster.size),
        ..Picture::still(texture)
    })
}

/// The size `onLoad` and `Image.getSize` report: pixels, or an SVG's whole
/// points.
fn reported_size(natural: Natural) -> Size<DevicePixels> {
    match natural {
        Natural::Vector(points) => nsh_core::svg::reported_size(points),
        Natural::Pixels(w, h) => size(DevicePixels(w as i32), DevicePixels(h as i32)),
    }
}

/// Decodes an encoded image at `target` (any thread): SVG with the shared
/// rasterizer, GIF and WebP with the `image` crate (every frame of
/// animations), an image that shrinks with the `image` crate, others with
/// GDK's loaders first.
fn decode(bytes: &[u8], target: &Target) -> Result<Picture, String> {
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes, target.longest);
    }
    let longest = target.longest;
    if target.frames == Frames::All
        && let Some(format) = animated_format(bytes)
    {
        match animation(bytes, format, longest) {
            Ok(Some(picture)) => return Ok(picture),
            Ok(None) => {}
            Err(e) => log::debug!("image: not decoded as an animation: {e}"),
        }
    }
    let shrinks = matches!(target.natural, Some(Natural::Pixels(w, h)) if longest < w.max(h));
    if shrinks && let Ok(image) = image::load_from_memory(bytes) {
        let (w, h) = (image.width(), image.height());
        // Shrunk as decoded (a JPEG's RGB), before it takes 4 bytes a pixel.
        let scale = longest as f64 / w.max(h) as f64;
        let side = |n: u32| ((n as f64 * scale).round() as u32).max(1);
        let picture = Picture::still(texture(image.thumbnail(side(w), side(h)).into_rgba8()));
        return Ok(Picture {
            natural: Natural::Pixels(w, h),
            ..picture
        });
    }
    let gdk_error = match gdk::Texture::from_bytes(&glib::Bytes::from(bytes)) {
        Ok(texture) => return Ok(Picture::still(texture)),
        Err(e) => e,
    };
    let image = image::load_from_memory(bytes).map_err(|e| format!("{gdk_error}; {e}"))?;
    Ok(Picture::still(texture(image.into_rgba8())))
}

/// The process's decoded images, in the core's budget.
fn images() -> &'static Images<Picture> {
    static IMAGES: LazyLock<Images<Picture>> = LazyLock::new(|| {
        Images::new(
            nsh_core::image::budget(),
            |bytes: &ImageData, target: &Target| {
                let picture = decode(bytes, target)?;
                let cost = picture.cost();
                Ok((picture.clone(), picture.natural, cost))
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
/// runs it there from any thread (here and now on the main thread), unless
/// it was forgotten ([`Load`]'s drop).
fn on_main<T: Send + 'static>(f: impl FnOnce(T) + 'static) -> (u64, impl FnOnce(T) + Send) {
    let id = next_id();
    let f: Box<dyn FnOnce(T)> = Box::new(f);
    WAITING.with_borrow_mut(|w| w.insert(id, Box::new(f) as Box<dyn Any>));
    let run = move |value: T| {
        glib::MainContext::default().invoke(move || {
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
            glib::MainContext::default().invoke(move || {
                if let Some(p) = PROGRESS.with_borrow(|m| m.get(&listener).cloned()) {
                    p(loaded, total);
                }
            });
        }) as nsh_core::image::loader::Progress
    });
    let (id, done) = on_main(move |result| {
        PROGRESS.with_borrow_mut(|p| p.remove(&listener));
        done(result);
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
    let ticket = images().load(
        request,
        Box::new(move |result| done(result.map(|(decoded, lease)| (decoded.value, lease)))),
    );
    if WAITING.with_borrow(|w| w.contains_key(&id)) {
        Some(Load {
            ticket: Some(ticket),
            ids: (id, listener),
        })
    } else {
        ticket.detach();
        None
    }
}

/// Loads the bitmap `uri` (`https://…`, `asset:/…`, a file path, `data:`)
/// for a canvas off the main thread, at its natural size; `done` runs on
/// the main thread with the image (an animation's first frame). Canvases
/// draw bitmaps: an SVG is an image that failed to load.
///
/// A cached texture is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
pub(crate) fn load_bitmap(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<gdk::Texture, String>) + 'static,
) {
    let name = uri.to_owned();
    let done = move |result: Result<(Picture, Lease), String>| {
        done(result.and_then(|(p, _)| match p.natural {
            Natural::Vector(_) => Err(format!(
                "{name} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
            )),
            Natural::Pixels(..) => Ok(p.texture),
        }));
    };
    let source = ImageSource {
        uri: uri.into(),
        size: None,
        scales: nsh_core::ImageScales::NONE,
        data: None,
    };
    let want = Want::natural(1.0);
    // A canvas keeps the texture itself: the load runs to its end.
    if let Some(load) = fetch(
        surface,
        &source,
        want,
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
    let report = move |result: Result<Natural, String>| {
        let Some(surface) = weak.upgrade() else {
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

/// The size `view` shows its image at: its box in device pixels, fitted by
/// `mode`.
fn want(view: &NshView, frame: Size<Points>, mode: ResizeMode) -> Want {
    // The surface's own scale, fractional ones included.
    let scale = view
        .native()
        .and_then(|n| n.surface())
        .map_or(view.scale_factor() as f64, |s| s.scale());
    Want {
        size: frame,
        scale: scale as f32,
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
        let image = s.image.get_or_insert_with(ImageState::default);
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
            if let Some(mut p) = image.playback.take() {
                p.pause();
            }
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
    // loads start once it has one (before the next frame is drawn), so they
    // decode at the size it shows them.
    let generation = {
        let mut s = view.state_mut();
        let Some(image) = s.image.as_mut().filter(|i| !i.deferred) else {
            return;
        };
        image.deferred = true;
        image.generation
    };
    let (surface, weak) = (Rc::downgrade(surface), view.downgrade());
    glib::idle_add_local_full(glib::Priority::HIGH_IDLE, move || {
        if let (Some(surface), Some(view)) = (surface.upgrade(), weak.upgrade()) {
            let current = view.state_mut().image.as_mut().is_some_and(|i| {
                i.deferred = false;
                i.generation == generation
            });
            if current {
                start(&surface, &view);
            }
        }
        glib::ControlFlow::Break
    });
}

/// Starts the loads `view` waits for: its source's, then its placeholder's
/// (not needed when the source is in memory).
fn start(surface: &Rc<Surface>, view: &NshView) {
    let (generation, events, id, source, frame, mode) = {
        let s = view.state();
        let (events, id, frame) = (s.events, s.id, s.frame.size);
        let Some(image) = s.image.as_ref() else {
            return;
        };
        let source = image
            .source
            .clone()
            .filter(|_| image.image.is_none() && image.load.is_none());
        (image.generation, events, id, source, frame, image.mode)
    };
    let want = want(view, frame, mode);
    let weak = view.downgrade();
    if let Some(source) = source {
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
            move |result: Result<(Picture, Lease), String>| {
                if let (Some(view), Some(surface)) = (weak.upgrade(), surface.upgrade()) {
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
        let weak = weak.clone();
        let done = move |result: Result<(Picture, Lease), String>| {
            let Some(view) = weak.upgrade() else { return };
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
    let (generation, source, want) = {
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
        let want = want(view, frame, image.mode);
        let density = context(surface, &source.uri)
            .locate(source)
            .map_or(1.0, |l| l.density());
        let longest = want.longest(picture.natural, density, source.size);
        let shown = picture.texture.width().max(picture.texture.height()) as u32;
        if longest <= shown {
            return;
        }
        (image.generation, source.clone(), want)
    };
    let weak = view.downgrade();
    let done = move |result: Result<(Picture, Lease), String>| {
        let Some(view) = weak.upgrade() else { return };
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
    let (events, id, fades, hook) = {
        let mut s = view.state_mut();
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        image.load = None;
        let mut hook = false;
        match &result {
            Ok((picture, lease)) => {
                image.image = Some(picture.clone());
                image.lease = lease.clone();
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
                // The image shows: the placeholder is no longer needed.
                if image.fade.is_none() {
                    image.placeholder_load = None;
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
    (texture, own): (&gdk::Texture, Natural),
    source: Option<&ImageSource>,
) {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let (x, y, fw, fh) = fit(
        image.mode,
        image.options.position,
        natural(own, source),
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
        let shown = (&placeholder.texture, placeholder.natural);
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
    let shown = (texture, picture.natural);
    draw_one(snapshot, state, image, shown, image.source.as_ref());
    if alpha < 1.0 {
        snapshot.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Decodes `bytes` at their natural size (`longest` 0), or with their
    /// longest side `longest` pixels.
    fn decoded(bytes: &[u8], longest: u32) -> Result<Picture, String> {
        let natural = Natural::of(bytes);
        let longest = match (longest, natural) {
            (0, Some(n)) => Want::natural(4.0).longest(n, 1.0, None),
            _ => longest,
        };
        let target = Target {
            natural,
            longest,
            frames: Frames::All,
        };
        decode(bytes, &target)
    }

    #[test]
    fn svg_decodes_at_its_bucket() {
        // At 4 pixels a point, the 192 px it needs round up to the 256
        // bucket.
        let picture = decoded(SVG_LOGO, 0).unwrap();
        let texture = &picture.texture;
        assert_eq!((texture.width(), texture.height()), (256, 128));
        assert_eq!(
            picture.natural,
            Natural::Vector(Size::new(Points(48.0), Points(24.0)))
        );
        let data = pixels(texture);
        let at = |x: usize, y: usize| -> [u8; 4] {
            let i = (y * 256 + x) * 4;
            data[i..i + 4].try_into().unwrap()
        };
        assert_eq!(at(10, 10), [0, 0, 255, 255]);
        let [b, g, r, a] = at(200, 64);
        assert!((127..=128).contains(&a), "alpha {a}");
        assert_eq!((b, g, r), (a, 0, 0));
        // Drawn at the size it shows at, small or large.
        let small = decoded(SVG_LOGO, 64).unwrap();
        assert_eq!((small.texture.width(), small.texture.height()), (64, 32));
        assert!(decoded(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect", 64).is_err());
    }

    #[test]
    fn bitmaps_decode_shrunk_to_their_bucket() {
        let mut png = Vec::new();
        image::RgbaImage::new(400, 300)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let full = decoded(&png, 0).unwrap();
        assert_eq!((full.texture.width(), full.texture.height()), (400, 300));
        let thumb = decoded(&png, 181).unwrap();
        assert_eq!((thumb.texture.width(), thumb.texture.height()), (181, 136));
        // It keeps its own size: what it lays out at and reports.
        assert_eq!(thumb.natural, Natural::Pixels(400, 300));
        assert_eq!(thumb.cost(), 2 * 181 * 136 * 4);
    }

    #[test]
    fn svg_size_is_in_points() {
        let picture = decoded(SVG_LOGO, 0).unwrap();
        assert_eq!(
            reported_size(picture.natural),
            size(DevicePixels(48), DevicePixels(24))
        );
        let source = ImageSource {
            uri: "asset:/logo@2x.svg".into(),
            size: None,
            scales: nsh_core::ImageScales::NONE,
            data: None,
        };
        assert_eq!(natural(picture.natural, Some(&source)), (48.0, 24.0));
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decoded(odd, 0).unwrap();
        assert_eq!(natural(odd.natural, None), (10.5, 10.0));
        assert_eq!(
            reported_size(odd.natural),
            size(DevicePixels(11), DevicePixels(10))
        );
        // Bitmaps keep their pixels, over their file name's density.
        let bitmap = Picture::still(texture(image::RgbaImage::new(20, 10)));
        assert_eq!(
            reported_size(bitmap.natural),
            size(DevicePixels(20), DevicePixels(10))
        );
        assert_eq!(natural(bitmap.natural, Some(&source)), (10.0, 5.0));
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` masks the color with the texture's alpha: the shape
        // is opaque, the rest transparent.
        let icon = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>"##;
        let picture = decoded(icon, 96).unwrap();
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
            let picture = animation(&bytes, format, 0).unwrap().unwrap();
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

    /// The process's resident and peak memory in MiB (`VmRSS`, `VmHWM`).
    fn memory() -> (u64, u64) {
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        let field = |name: &str| {
            let line = status.lines().find(|l| l.starts_with(name)).unwrap();
            line.split_whitespace()
                .nth(1)
                .unwrap()
                .parse::<u64>()
                .unwrap()
                / 1024
        };
        (field("VmRSS:"), field("VmHWM:"))
    }

    /// A measurement, run by hand (`docs/dev/images.md`): a list of 1,000
    /// remote 4000×3000 JPEGs (a local server) scrolled through, 8 rows of
    /// 200×150-point thumbnails at 2× on screen (`NSH_IMAGE_ROWS`), a row
    /// every 100 ms; prints the process's memory, and the budget's once the
    /// rows on screen are all that is left of it. `NSH_IMAGE_PIPELINE=old` decodes at full size
    /// in 128 MiB of cache with the views' textures held beside it, as the
    /// Linux loader did before the shared pipeline; `NSH_IMAGE_BUDGET_MIB`
    /// sets the budget's limit.
    #[test]
    #[ignore = "a measurement: run by hand with --nocapture"]
    fn heap_while_scrolling_remote_photos() {
        use std::io::{Read as _, Write as _};
        let old = std::env::var("NSH_IMAGE_PIPELINE").is_ok_and(|v| v == "old");
        let rows: usize = std::env::var("NSH_IMAGE_ROWS").map_or(8, |v| v.parse().unwrap());
        let mut photo = image::RgbImage::new(4000, 3000);
        for (x, y, p) in photo.enumerate_pixels_mut() {
            let n = (x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503)) >> 24;
            *p = image::Rgb([(x / 16) as u8, (y / 12) as u8, n as u8]);
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85)
            .encode_image(&photo)
            .unwrap();
        drop(photo);
        let jpeg = Arc::new(jpeg);
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let body = jpeg.clone();
        std::thread::spawn(move || {
            for stream in server.incoming() {
                let (Ok(mut stream), body) = (stream, body.clone()) else {
                    continue;
                };
                std::thread::spawn(move || {
                    let mut request = [0u8; 4096];
                    let _ = stream.read(&mut request);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                });
            }
        });
        let budget = if old {
            nsh_core::image::Budget::new(256 << 20)
        } else {
            nsh_core::image::budget().clone()
        };
        // `NSH_IMAGE_BUDGET_MIB`: another limit than the default.
        if let Ok(mib) = std::env::var("NSH_IMAGE_BUDGET_MIB") {
            budget.set_limit(mib.parse::<usize>().unwrap() << 20);
        }
        let images = if old {
            // Full-size textures, 128 MiB of them cached (counted twice
            // here, as a texture's GPU copy is).
            Images::new(&budget, |bytes: &ImageData, target: &Target| {
                let picture = decode(bytes, target)?;
                let cost = picture.cost();
                Ok((picture.clone(), picture.natural, cost))
            })
        } else {
            images().clone()
        };
        let thumbnail = Want {
            size: size(Points(200.0), Points(150.0)),
            scale: 2.0,
            mode: ResizeMode::Cover,
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let (start, _) = memory();
        println!("JPEG {} KiB; {start} MiB resident before", jpeg.len() >> 10);
        let mut shown = std::collections::VecDeque::new();
        let (mut loaded, mut peak_used) = (0, 0);
        let began = std::time::Instant::now();
        for i in 0..1000usize {
            let want = if old { Want::natural(1.0) } else { thumbnail };
            let tx = tx.clone();
            let request = Request {
                location: nsh_core::image::loader::Location::Url(format!(
                    "http://127.0.0.1:{port}/photos/{i}.jpg"
                )),
                context: Context::default(),
                declared: None,
                want,
                frames: Frames::All,
                priority: Priority::Visible,
                progress: None,
            };
            let ticket = images.load(
                request,
                Box::new(move |r| {
                    let _ = tx.send((i, r.map(|(d, lease)| (d.value, lease))));
                }),
            );
            shown.push_back((i, ticket, None));
            // A row scrolls in every 100 ms; the one at the top scrolls out,
            // giving up its load or its lease.
            let until = std::time::Instant::now() + Duration::from_millis(100);
            while let Ok((i, result)) =
                rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
            {
                if let Some(row) = shown.iter_mut().find(|r| r.0 == i) {
                    row.2 = result.ok();
                    loaded += 1;
                }
            }
            if shown.len() > rows {
                shown.pop_front();
            }
            peak_used = peak_used.max(budget.used());
            if i % 100 == 99 {
                let (rss, _) = memory();
                println!(
                    "{:>4} rows: {rss} MiB resident, {} MiB in the budget, {loaded} shown",
                    i + 1,
                    budget.used() >> 20
                );
            }
        }
        let (rss, hwm) = memory();
        println!(
            "{} pipeline, {rows} rows: {rss} MiB resident at the end, {hwm} MiB at the peak; {} MiB at most in the budget; {loaded} of 1000 shown in {:.1?}",
            if old { "old" } else { "new" },
            peak_used >> 20,
            began.elapsed()
        );
        budget.clear();
        println!(
            "on screen alone: {} MiB in the budget, {} MiB resident",
            budget.used() >> 20,
            memory().0
        );
    }
}
