//! Canvas views: a recorded [`Drawing`] rasterized with tiny-skia at the
//! window's resolution, text included.
//!
//! GPUI paints paths with one solid color or a two-stop gradient, clips
//! only to rectangles and has no blur, no composite operations and no
//! transform for images or glyphs, so canvas' model does not map onto its
//! primitives. The replay rasterizes instead, into a pixmap in device
//! pixels of the view's whole transform (the window's scale factor, the
//! views' scales and rotations), which stays sharp at any scale: the
//! pixmap is made again when that transform's linear part changes, and
//! moves along with translations (scrolling) without being made again. It
//! is uploaded once as GPUI images of [`TILE`]-pixel tiles (again when the
//! view's opacity changes, which is multiplied into it), each owned as a
//! [`crate::image::Texture`] so it leaves the atlas once dropped; [`draw`]
//! only paints them. A canvas too large for one pixmap is rasterized around
//! the part that shows.
//!
//! Rasterizing never holds up a frame once a canvas has shown: a new
//! drawing (or an animated value change no area bounds) is rasterized and
//! uploaded on a worker ([`spawn`]) while the last one keeps showing, and
//! takes its place when done (a frame or two later; a live chart redrawn
//! twenty times a second rasterized ~13 million pixels a second on the
//! main thread, 15 ms of every frame of the Stocks demo at 1180 × 740
//! points). An animation of animated values rasterizes again only the area
//! the operations reading them paint ([`DamageScan`], the union of before
//! and after; [`patch`]), on the main thread, and uploads only the tiles it
//! touches. Only the first rasterization at a transform (a canvas appearing,
//! zooming) is made in place.
//!
//! The replay keeps canvas' model itself, as the Windows backend does: the
//! current path is kept in pixmap coordinates as it is built (later
//! transforms do not move it; arcs and ellipses become cubics), strokes
//! are made in the user space of the transform current when they are
//! drawn (so they are transformed, dashes included) and every painting
//! operation fills a path in pixmap coordinates. Clips are anti-aliased
//! masks kept with `save` / `restore`'s state. Gradients are evaluated per
//! pixel in user space, with stops interpolated premultiplied (as on
//! Windows: a stop fading to `transparent` does not turn grey): linear,
//! two-circle radial and conic gradients are all exact.
//! Shadows are the shape's alpha blurred by three box blurs (close to
//! canvas' Gaussian of standard deviation blur / 2), offset in the view's
//! coordinates. Composite operations other than `source-over` draw the
//! shape into a layer of its own, combined with the pixmap over the clip,
//! so they act where the shape is transparent too.
//!
//! Text is shaped by GPUI's text system in the fonts the engine measures
//! with (so drawn widths match `measureText`), and its glyphs become paths
//! like any other shape: GPUI gives no outlines, so the font's file is
//! found by family, weight and style with fontdb (the system's fonts and
//! those the app registers, [`font_registered`]) and checked against
//! GPUI's metrics before its outlines (ttf-parser) are used with GPUI's
//! glyph ids (the system's fonts are found by a worker, which takes
//! hundreds of milliseconds: canvases that drew text before are drawn
//! again then). Glyphs without a matching file or an outline (emoji, a
//! font GPUI fell back to, any before the fonts are found) are painted as
//! GPUI glyphs above the pixmap instead:
//! a painting operation overlapping them starts a new pixmap above, so the
//! order of what overlaps is kept, but they are clipped to their clip's
//! bounds, stay upright under rotations, are made smaller rather than
//! narrower by `maxWidth`, take a gradient's middle color, fill for
//! `strokeText`, cast unblurred shadows and ignore composite operations
//! and `clearRect`. Images are loaded through [`load_image`] when a
//! drawing names them and kept per canvas.

use std::{
    cell::RefCell,
    f64::consts::{PI, TAU},
    rc::Rc,
    sync::Arc,
};

use gpui::{Font, FontStyle, Hsla, RenderImage, TextRun, WindowTextSystem, px};
use nsh_core::{
    Color,
    animation::AnimationValue,
    canvas::{
        CanvasFont, CanvasGradient, CanvasOp, CanvasTextAlign, CanvasTextBaseline, Composite,
        Damage, DamageScan, Drawing, FillRule, GradientShape, LineCap, LineJoin, Num, Paint,
        PathOp, arc_sweep, fit_radii,
    },
    geometry::{Corners, Points, Radians, size},
};
use rustc_hash::FxHashMap;
use tiny_skia as sk;

use crate::{
    image::Texture,
    render::{DrawCx, bounds},
    surface::Surface,
    view::{NshView, ViewState},
};

/// The largest side of a pixmap, in device pixels.
const MAX_SIDE: i32 = 4096;
/// The most pixels a pixmap covers; a larger canvas is rasterized only
/// around the part of it that shows.
const MAX_AREA: i64 = 8 << 20;
/// How far past what shows a partly rasterized canvas goes, in device
/// pixels (so scrolling it makes the pixmap again only now and then).
const MARGIN: i32 = 256;
/// The side of the tiles a pixmap is uploaded in, in device pixels: a
/// partial redraw uploads only the tiles it touched.
const TILE: i32 = 256;
/// Entries of a gradient's color table.
const GRADIENT_STEPS: usize = 1024;
/// The largest shadow blur (standard deviation, device pixels): its
/// spread is worked out in memory, around what the shadow covers.
const MAX_SIGMA: f64 = 256.0;

/// What a canvas draws.
#[derive(Default)]
pub(crate) struct CanvasState {
    /// The drawing.
    pub(crate) drawing: Option<Arc<Drawing>>,
    /// Animated value slots (`AnimationProp::CanvasArg`).
    args: Vec<Option<AnimationValue>>,
    /// The images the drawing names, by URI (premultiplied pixels): `None`
    /// while loading (or when they failed to load).
    images: FxHashMap<Arc<str>, Option<Arc<sk::Pixmap>>>,
    /// What was rasterized (made while drawing, which only sees the
    /// state).
    cache: RefCell<Option<Recorded>>,
    /// What animated value changes moved since it was rasterized (view
    /// coordinates): only that is rasterized again.
    damage: std::cell::Cell<Option<Damage>>,
    /// Scratch space of the damage scans.
    scan: DamageScan,
    /// Counts the changes that need the whole drawing rasterized again
    /// (a new drawing, an image loaded, a value no area bounds).
    version: u64,
    /// The version a worker rasterizes now.
    inflight: std::cell::Cell<Option<u64>>,
}

impl CanvasState {
    /// Rasterizes the whole drawing again: on a worker while what was
    /// rasterized before shows, so the main thread never waits for it.
    fn stale(&mut self) {
        self.version += 1;
        self.damage.set(None);
    }

    /// The version a worker should rasterize now, if none is: one at a
    /// time, as drawings that change on every frame would queue a job a
    /// frame, the workers falling behind and showing frames ever older.
    fn ask(&self) -> Option<u64> {
        if self.inflight.get().is_some() {
            return None;
        }
        self.inflight.set(Some(self.version));
        Some(self.version)
    }

    /// A worker's rasterization of `version` is done: the next can be
    /// asked for.
    fn landed(&self, version: u64) {
        if self.inflight.get() == Some(version) {
            self.inflight.set(None);
        }
    }

    /// The value of animated value slot `k`, as damage scans read it.
    fn slot(args: &[Option<AnimationValue>], k: u16) -> f32 {
        args.get(k as usize)
            .copied()
            .flatten()
            .map_or(0.0, AnimationValue::number)
    }
}

/// A rasterized drawing.
struct Recorded {
    /// What it was made for.
    key: Key,
    /// The pixmaps' rectangle, in device pixels from the device pixel the
    /// view's origin fell in when it was made.
    region: IRect,
    /// Where the view's origin was in that pixel.
    frac: (f32, f32),
    /// Pixmaps and text, bottom to top.
    layers: Vec<Layer>,
    /// The canvas' version it was made at ([`CanvasState::version`]).
    version: u64,
    /// The animated values it was made with.
    args: Vec<Option<AnimationValue>>,
}

/// What a [`Recorded`] was made for: the linear part of the view's
/// transform to device pixels, the window's scale factor and the view's
/// size.
#[derive(Clone, Copy, PartialEq)]
struct Key {
    linear: [f32; 4],
    scale: f32,
    size: (f32, f32),
}

/// A part of a rasterized drawing.
enum Layer {
    /// Pixels, and the tiles they are uploaded in (made when first
    /// drawn).
    Pixels(sk::Pixmap, Vec<Tile>),
    /// Glyphs above the pixels below.
    Text(Vec<GlyphRun>),
}

/// A part of a pixmap uploaded as one image.
struct Tile {
    /// Its pixels in the pixmap.
    rect: IRect,
    /// The opacity and image it was uploaded at (`None` inside: nothing
    /// drawn there); `None` until uploaded, or after its pixels changed.
    uploaded: Option<(f32, Option<Texture>)>,
}

/// The tiles covering a pixmap `width` × `height` pixels.
fn tiles(width: u32, height: u32) -> Vec<Tile> {
    let (w, h) = (width as i32, height as i32);
    let mut tiles = Vec::new();
    for y0 in (0..h).step_by(TILE as usize) {
        for x0 in (0..w).step_by(TILE as usize) {
            let rect = IRect {
                x0,
                y0,
                x1: (x0 + TILE).min(w),
                y1: (y0 + TILE).min(h),
            };
            tiles.push(Tile {
                rect,
                uploaded: None,
            });
        }
    }
    tiles
}

/// Sets up a canvas view.
pub(crate) fn create(view: &NshView) {
    view.state_mut().canvas = Some(CanvasState::default());
}

/// A new drawing: loads the images it names that are new.
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, drawing: Arc<Drawing>) {
    let mut load = Vec::new();
    {
        let mut state = view.state_mut();
        let Some(c) = state.canvas.as_mut() else {
            return;
        };
        // Images no longer drawn are let go.
        c.images
            .retain(|uri, _| drawing.images().any(|i| &i.uri == uri));
        for image in drawing.images() {
            if !c.images.contains_key(&image.uri) {
                c.images.insert(image.uri.clone(), None);
                load.push(image.uri.clone());
            }
        }
        c.drawing = Some(drawing);
        c.stale();
    }
    let text =
        |op: &CanvasOp| matches!(op, CanvasOp::FillText { .. } | CanvasOp::StrokeText { .. });
    if view
        .state()
        .canvas
        .as_ref()
        .and_then(|c| c.drawing.as_ref())
        .is_some_and(|d| d.ops.iter().any(text))
    {
        wait_for_fonts(surface, view);
    }
    let id = view.id();
    for uri in load {
        let weak = Rc::downgrade(surface);
        let key = uri.clone();
        load_image(surface, &uri, move |result| {
            let pixmap = match result {
                Ok(pixmap) => pixmap,
                Err(e) => {
                    log::warn!("canvas: {e}");
                    return;
                }
            };
            let Some(view) = weak.upgrade().and_then(|s| s.view(id)) else {
                return;
            };
            {
                let mut state = view.state_mut();
                let Some(c) = state.canvas.as_mut() else {
                    return;
                };
                let Some(slot) = c.images.get_mut(&key) else {
                    return;
                };
                *slot = Some(Arc::new(pixmap));
                c.stale();
            }
            view.changed();
        });
    }
    view.changed();
}

/// Animated value slot `k` changed: draws again if the value did.
pub(crate) fn set_arg(view: &NshView, k: u16, value: AnimationValue) {
    {
        let mut state = view.state_mut();
        let Some(c) = state.canvas.as_mut() else {
            return;
        };
        let k = k as usize;
        if c.args.len() <= k {
            c.args.resize(k + 1, None);
        }
        if c.args[k] == Some(value) {
            return;
        }
        // What the operations reading the slot paint, before and after:
        // only that is rasterized again.
        let slot = k as u16;
        let damage = match c.drawing.clone() {
            Some(drawing) => {
                let changed = |s: u16| s == slot;
                let before =
                    c.scan
                        .damage(&drawing.ops, |s| CanvasState::slot(&c.args, s), changed);
                c.args[k] = Some(value);
                match before {
                    Damage::All => Damage::All,
                    _ => before.union(c.scan.damage(
                        &drawing.ops,
                        |s| CanvasState::slot(&c.args, s),
                        changed,
                    )),
                }
            }
            None => {
                c.args[k] = Some(value);
                Damage::All
            }
        };
        match damage {
            Damage::None => return,
            Damage::All => c.stale(),
            Damage::Rect(_) => {
                let pending = c.damage.get().map_or(damage, |d| d.union(damage));
                c.damage.set(Some(pending));
            }
        }
    }
    view.changed();
}

/// Loads the image `uri` for a canvas, as premultiplied pixels.
fn load_image(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<sk::Pixmap, String>) + 'static,
) {
    crate::image::load_bitmap(surface, uri, move |result| {
        done(result.and_then(|texture| {
            let image = texture.image();
            let size = image.size(0);
            let bytes = image.as_bytes(0).ok_or("an image without pixels")?;
            premultiplied(
                size.width.0.max(0) as u32,
                size.height.0.max(0) as u32,
                bytes,
            )
        }))
    });
}

/// GPUI's straight BGRA pixels as a pixmap.
fn premultiplied(width: u32, height: u32, bgra: &[u8]) -> Result<sk::Pixmap, String> {
    let mut pixmap = sk::Pixmap::new(width, height).ok_or("an empty image")?;
    if bgra.len() < width as usize * height as usize * 4 {
        return Err("an image of the wrong size".into());
    }
    for (p, c) in pixmap.pixels_mut().iter_mut().zip(bgra.as_chunks::<4>().0) {
        *p = sk::ColorU8::from_rgba(c[2], c[1], c[0], c[3]).premultiply();
    }
    Ok(pixmap)
}

/// Draws a canvas: rasterizes it first if needed.
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    // Pixmaps uploaded before and dropped since leave the atlas.
    crate::image::release_textures(cx);
    let Some(canvas) = state.canvas.as_ref() else {
        return;
    };
    let Some(drawing) = canvas.drawing.as_ref() else {
        return;
    };
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if drawing.ops.is_empty() || w <= 0.0 || h <= 0.0 || cx.culled() {
        return;
    }
    let s = cx.scale;
    let [a, b, c, d, e, f] = cx.transform.affine();
    let key = Key {
        linear: [a * s, b * s, c * s, d * s],
        scale: s,
        size: (w, h),
    };
    let origin = (e * s, f * s);
    if !origin.0.is_finite() || !origin.1.is_finite() {
        return;
    }
    let clip = cx.clip;
    let clip = [
        f32::from(clip.origin.x) * s - origin.0,
        f32::from(clip.origin.y) * s - origin.1,
        f32::from(clip.origin.x + clip.size.width) * s - origin.0,
        f32::from(clip.origin.y + clip.size.height) * s - origin.1,
    ];
    let frac = (origin.0 - origin.0.floor(), origin.1 - origin.1.floor());
    let Some((region, shown)) = region(&key, frac, clip) else {
        return;
    };
    let mut cache = canvas.cache.borrow_mut();
    let mut fresh = cache
        .as_ref()
        .is_some_and(|r| r.key == key && r.region.contains(&shown));
    let damage = canvas.damage.take();
    let outdated = cache.as_ref().is_some_and(|r| r.version != canvas.version);
    if fresh && outdated {
        // A new drawing: a worker rasterizes it while the last one shows
        // (a frame or two); damage is worked out again when it is done.
        // The latest is asked for when the one in flight lands.
        if let Some(version) = canvas.ask() {
            spawn(Job {
                surface: SURFACE.get(),
                id: state.id,
                drawing: drawing.clone(),
                args: canvas.args.clone(),
                images: canvas.images.clone(),
                system: cx.app.text_system().clone(),
                key,
                region,
                frac,
                version,
                opacity: cx.opacity,
            });
        }
    } else if fresh
        && let Some(Damage::Rect(r)) = damage
        && let Some(recorded) = cache.as_mut()
    {
        let text = cx.window.text_system().clone();
        let system = cx.app.text_system().clone();
        fresh = patch(
            recorded,
            drawing,
            &canvas.args,
            &canvas.images,
            (&text, &system),
            r,
        );
    }
    if !fresh {
        let text = cx.window.text_system().clone();
        let system = cx.app.text_system().clone();
        let started = std::time::Instant::now();
        let recorded = record(
            drawing,
            &canvas.args,
            &canvas.images,
            (&text, &system),
            key,
            region,
            frac,
        );
        log::debug!(
            target: "nsh::perf",
            "canvas: {}×{} px rasterized in {:.2} ms",
            region.width(),
            region.height(),
            started.elapsed().as_secs_f64() * 1000.0
        );
        *cache = Some(Recorded {
            version: canvas.version,
            ..recorded
        });
    }
    let Some(recorded) = cache.as_mut() else {
        return;
    };
    // The pixmap's top left, in device pixels: whole pixels, so its pixels
    // stay the screen's.
    let left = (origin.0 - recorded.frac.0).round() + recorded.region.x0 as f32;
    let top = (origin.1 - recorded.frac.1).round() + recorded.region.y0 as f32;
    let opacity = cx.opacity;
    for layer in &mut recorded.layers {
        match layer {
            Layer::Pixels(pixmap, tiled) => {
                if tiled.is_empty() {
                    *tiled = tiles(pixmap.width(), pixmap.height());
                }
                for tile in tiled.iter_mut() {
                    if tile.uploaded.as_ref().is_none_or(|(o, _)| *o != opacity) {
                        let image = upload(pixmap, tile.rect, opacity).map(Texture::new);
                        tile.uploaded = Some((opacity, image));
                    }
                    let Some((_, Some(image))) = &tile.uploaded else {
                        continue;
                    };
                    let r = tile.rect;
                    let rect = bounds(
                        (left + r.x0 as f32) / s,
                        (top + r.y0 as f32) / s,
                        r.width() as f32 / s,
                        r.height() as f32 / s,
                    );
                    let image = image.image().clone();
                    cx.paint(|window, _| {
                        let painted =
                            window.paint_image(rect, rect, Default::default(), image, 0, false);
                        if let Err(e) = painted {
                            log::debug!("canvas: not painted: {e}");
                        }
                    });
                }
            }
            Layer::Text(runs) => paint_text(cx, runs, (left, top)),
        }
    }
}

thread_local! {
    /// The surface being drawn ([`begin_pass`]): workers' results find
    /// their canvas by it.
    static SURFACE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// A drawing pass of the surface with `key` begins.
pub(crate) fn begin_pass(key: u64) {
    SURFACE.set(key);
}

/// Workers rasterizing canvases.
const WORKERS: usize = 2;

/// A canvas to rasterize on a worker.
struct Job {
    surface: u64,
    id: nsh_core::NodeId,
    drawing: Arc<Drawing>,
    args: Vec<Option<AnimationValue>>,
    images: FxHashMap<Arc<str>, Option<Arc<sk::Pixmap>>>,
    /// The app's text system (each worker shapes with a line layout cache
    /// of its own over it: the window's is the frame's).
    system: Arc<gpui::TextSystem>,
    key: Key,
    region: IRect,
    frac: (f32, f32),
    version: u64,
    /// Uploaded at this opacity (again on the main thread if it changed).
    opacity: f32,
}

/// Rasterizations a worker's line layout cache serves before it is made
/// again: it only empties with frames, which workers do not have.
const WORKER_TEXT_JOBS: u32 = 256;

/// This worker's text shaping over the app's text system `system` (the
/// same fonts, so the same font ids).
fn worker_text(system: &Arc<gpui::TextSystem>) -> Arc<WindowTextSystem> {
    thread_local! {
        static TEXT: RefCell<Option<(usize, u32, Arc<WindowTextSystem>)>> =
            const { RefCell::new(None) };
    }
    let key = Arc::as_ptr(system) as usize;
    TEXT.with_borrow_mut(|text| match text {
        Some((k, jobs, t)) if *k == key && *jobs < WORKER_TEXT_JOBS => {
            *jobs += 1;
            t.clone()
        }
        _ => {
            let t = Arc::new(WindowTextSystem::new(system.clone()));
            *text = Some((key, 1, t.clone()));
            t
        }
    })
}

/// Queues `job` on the canvas workers (started on first use).
fn spawn(job: Job) {
    static POOL: std::sync::OnceLock<crossbeam_channel::Sender<Job>> = std::sync::OnceLock::new();
    let tx = POOL.get_or_init(|| {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..WORKERS {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("nsh-canvas-{i}"))
                .spawn(move || {
                    crate::text::init_thread();
                    for job in rx {
                        rasterize(job);
                    }
                });
            if let Err(e) = spawned {
                log::error!("cannot start a canvas thread: {e}");
            }
        }
        tx
    });
    let _ = tx.send(job);
}

/// Rasterizes and uploads `job` (a worker), handing it to its canvas.
fn rasterize(job: Job) {
    let started = std::time::Instant::now();
    let mut recorded = record(
        &job.drawing,
        &job.args,
        &job.images,
        (&worker_text(&job.system), &job.system),
        job.key,
        job.region,
        job.frac,
    );
    recorded.version = job.version;
    // Uploaded here; owned as textures on the main thread, whose atlases
    // they leave from there once dropped.
    let mut uploads = Vec::new();
    for layer in &mut recorded.layers {
        if let Layer::Pixels(pixmap, tiled) = layer {
            *tiled = tiles(pixmap.width(), pixmap.height());
            for tile in tiled.iter() {
                uploads.push(upload(pixmap, tile.rect, job.opacity));
            }
        }
    }
    let opacity = job.opacity;
    log::debug!(
        target: "nsh::perf",
        "canvas: {}×{} px rasterized on a worker in {:.2} ms",
        job.region.width(),
        job.region.height(),
        started.elapsed().as_secs_f64() * 1000.0
    );
    let (surface, id) = (job.surface, job.id);
    crate::rt::invoke(move || {
        let mut uploads = uploads.into_iter();
        let mut recorded = recorded;
        for layer in &mut recorded.layers {
            if let Layer::Pixels(_, tiled) = layer {
                for (tile, image) in tiled.iter_mut().zip(&mut uploads) {
                    tile.uploaded = Some((opacity, image.map(Texture::new)));
                }
            }
        }
        deliver(surface, id, recorded);
    });
}

/// A worker's rasterization of canvas `id` is done (main thread).
fn deliver(surface: u64, id: nsh_core::NodeId, recorded: Recorded) {
    let Some(view) = Surface::by_key(surface).and_then(|s| s.view(id)) else {
        return;
    };
    {
        let mut state = view.state_mut();
        let Some(c) = state.canvas.as_mut() else {
            return;
        };
        c.landed(recorded.version);
        let newer = c
            .cache
            .get_mut()
            .as_ref()
            .is_none_or(|r| r.version < recorded.version);
        if !newer {
            // Drawn again to ask for the latest, if it is not this.
            drop(state);
            view.changed();
            return;
        }
        // Values that moved while it was made: their areas are made again.
        if recorded.version == c.version
            && let Some(drawing) = c.drawing.clone()
        {
            let len = c.args.len().max(recorded.args.len());
            let get = |a: &[Option<AnimationValue>], k: u16| a.get(k as usize).copied().flatten();
            let changed = |k: u16| get(&c.args, k) != get(&recorded.args, k);
            if (0..len as u16).any(changed) {
                let before = c.scan.damage(
                    &drawing.ops,
                    |k| CanvasState::slot(&recorded.args, k),
                    changed,
                );
                let after = c
                    .scan
                    .damage(&drawing.ops, |k| CanvasState::slot(&c.args, k), changed);
                match before.union(after) {
                    Damage::All => c.version += 1,
                    Damage::None => {}
                    d => c.damage.set(Some(d)),
                }
            }
        }
        *c.cache.get_mut() = Some(recorded);
    }
    view.changed();
}

/// The rectangle to rasterize for `key` (device pixels from the pixel the
/// view's origin falls in, `frac` into it) and the part of it that shows
/// inside `clip` (device pixels from the view's origin); `None` when
/// nothing shows.
fn region(key: &Key, frac: (f32, f32), clip: [f32; 4]) -> Option<(IRect, IRect)> {
    let [a, b, c, d] = key.linear;
    let (w, h) = key.size;
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (x, y) in [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)] {
        let (px, py) = (a * x + c * y + frac.0, b * x + d * y + frac.1);
        x0 = x0.min(px);
        y0 = y0.min(py);
        x1 = x1.max(px);
        y1 = y1.max(py);
    }
    let full = IRect::round_out(x0, y0, x1, y1)?;
    let shown = IRect::round_out(
        clip[0] + frac.0,
        clip[1] + frac.1,
        clip[2] + frac.0,
        clip[3] + frac.1,
    )?
    .intersect(&full)?;
    if full.width() <= MAX_SIDE
        && full.height() <= MAX_SIDE
        && full.width() as i64 * full.height() as i64 <= MAX_AREA
    {
        return Some((full, shown));
    }
    let around = IRect {
        x0: shown.x0 - MARGIN,
        y0: shown.y0 - MARGIN,
        x1: shown.x1 + MARGIN,
        y1: shown.y1 + MARGIN,
    }
    .intersect(&full)?;
    // What shows of a canvas larger than the limit is cut down to it.
    let around = IRect {
        x1: around.x1.min(around.x0 + MAX_SIDE),
        y1: around.y1.min(around.y0 + MAX_SIDE),
        ..around
    };
    let shown = shown.intersect(&around)?;
    Some((around, shown))
}

/// The pixels `rect` of `pixmap` as a GPUI image (straight BGRA) at
/// `opacity`; `None` when they are transparent.
fn upload(pixmap: &sk::Pixmap, rect: IRect, opacity: f32) -> Option<Arc<RenderImage>> {
    let width = pixmap.width() as usize;
    let pixels = pixmap.pixels();
    let mut buf = Vec::with_capacity(rect.width() as usize * rect.height() as usize * 4);
    let mut any = false;
    let rows = (rect.y0 as usize..rect.y1 as usize)
        .flat_map(|y| &pixels[y * width + rect.x0 as usize..y * width + rect.x1 as usize]);
    for p in rows {
        let a = p.alpha();
        if a == 0 {
            buf.extend_from_slice(&[0; 4]);
            continue;
        }
        any = true;
        let c = p.demultiply();
        let a = (a as f32 * opacity).round() as u8;
        buf.extend_from_slice(&[c.blue(), c.green(), c.red(), a]);
    }
    if !any {
        return None;
    }
    let image = image::RgbaImage::from_raw(rect.width() as u32, rect.height() as u32, buf)?;
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(image)])))
}

/// Paints the glyphs of `runs` (pixmap coordinates, the pixmap's top left
/// at `origin` in device pixels).
fn paint_text(cx: &mut DrawCx<'_>, runs: &[GlyphRun], origin: (f32, f32)) {
    let s = cx.scale;
    let opacity = cx.opacity;
    let window_clip = cx.clip;
    for run in runs {
        cx.clip = match run.clip {
            Some([x0, y0, x1, y1]) => window_clip.intersect(&bounds(
                (origin.0 + x0) / s,
                (origin.1 + y0) / s,
                (x1 - x0).max(0.0) / s,
                (y1 - y0).max(0.0) / s,
            )),
            None => window_clip,
        };
        if !cx.culled() {
            let mut color = run.color;
            color.a *= opacity;
            let size = px(run.size);
            cx.paint(|window, _| {
                for g in &run.glyphs {
                    let at = gpui::point(px((origin.0 + g.x) / s), px((origin.1 + g.y) / s));
                    let painted = if g.emoji {
                        window.paint_emoji(at, g.font, g.id, size)
                    } else {
                        window.paint_glyph(at, g.font, g.id, size, color)
                    };
                    if let Err(e) = painted {
                        log::debug!("canvas: cannot paint a glyph: {e}");
                    }
                }
            });
        }
    }
    cx.clip = window_clip;
}

// --- Recording -------------------------------------------------------------

/// A rectangle of whole device pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IRect {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl IRect {
    /// The pixels the rectangle touches; `None` if it is empty or not
    /// finite.
    fn round_out(x0: f32, y0: f32, x1: f32, y1: f32) -> Option<IRect> {
        let far = 1.0e8;
        if !(x0.abs() < far && y0.abs() < far && x1.abs() < far && y1.abs() < far) {
            return None;
        }
        let r = IRect {
            x0: x0.floor() as i32,
            y0: y0.floor() as i32,
            x1: x1.ceil() as i32,
            y1: y1.ceil() as i32,
        };
        (r.x1 > r.x0 && r.y1 > r.y0).then_some(r)
    }

    fn width(&self) -> i32 {
        self.x1 - self.x0
    }

    fn height(&self) -> i32 {
        self.y1 - self.y0
    }

    fn intersect(&self, o: &IRect) -> Option<IRect> {
        let r = IRect {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        };
        (r.x1 > r.x0 && r.y1 > r.y0).then_some(r)
    }

    fn contains(&self, o: &IRect) -> bool {
        o.x0 >= self.x0 && o.y0 >= self.y0 && o.x1 <= self.x1 && o.y1 <= self.y1
    }
}

/// Rasterizes `drawing` for `key` over `region`.
fn record(
    drawing: &Drawing,
    args: &[Option<AnimationValue>],
    images: &FxHashMap<Arc<str>, Option<Arc<sk::Pixmap>>>,
    (text, system): (&WindowTextSystem, &Arc<gpui::TextSystem>),
    key: Key,
    region: IRect,
    frac: (f32, f32),
) -> Recorded {
    let [a, b, c, d] = key.linear.map(f64::from);
    // The view's coordinates to the pixmap's.
    let base = Affine {
        a,
        b,
        c,
        d,
        e: (frac.0 - region.x0 as f32) as f64,
        f: (frac.1 - region.y0 as f32) as f64,
    };
    let size = (region.width() as u32, region.height() as u32);
    let mut replay = Replay {
        args,
        images,
        text,
        system,
        size,
        base,
        scale: key.scale as f64,
        state: State::new(base),
        stack: Vec::new(),
        path: PathBuf::default(),
        layers: Vec::new(),
        pixmap: sk::Pixmap::new(size.0, size.1),
        drawn: false,
        pending: Vec::new(),
        pending_bounds: None,
    };
    for op in &drawing.ops {
        replay.op(op);
    }
    replay.flush();
    Recorded {
        key,
        region,
        frac,
        layers: replay.layers,
        version: 0,
        args: args.to_vec(),
    }
}

/// Rasterizes again what `damage` (view coordinates) covers of
/// `recorded`, from the whole drawing clipped to it, which paints the same
/// pixels there as a full replay. False when the replay over that area
/// does not split into the same layers (an operation outside it decided
/// where text goes): then the whole drawing is rasterized again.
fn patch(
    recorded: &mut Recorded,
    drawing: &Drawing,
    args: &[Option<AnimationValue>],
    images: &FxHashMap<Arc<str>, Option<Arc<sk::Pixmap>>>,
    text: (&WindowTextSystem, &Arc<gpui::TextSystem>),
    damage: nsh_core::Bounds<nsh_core::Points>,
) -> bool {
    let [a, b, c, d] = recorded.key.linear;
    let frac = recorded.frac;
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let (rx, ry, rw, rh) = (
        damage.origin.x.0,
        damage.origin.y.0,
        damage.size.width.0,
        damage.size.height.0,
    );
    for (x, y) in [(rx, ry), (rx + rw, ry), (rx, ry + rh), (rx + rw, ry + rh)] {
        let (px, py) = (a * x + c * y + frac.0, b * x + d * y + frac.1);
        x0 = x0.min(px);
        y0 = y0.min(py);
        x1 = x1.max(px);
        y1 = y1.max(py);
    }
    // A pixel more around it: anti-aliasing of edges rounded to points.
    let Some(area) = IRect::round_out(x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0)
        .and_then(|r| r.intersect(&recorded.region))
    else {
        // Nothing of it is in the pixmap.
        return true;
    };
    // Shadows of shapes reaching into the area are blurred from all of
    // their shape: the replay covers the area grown by the farthest a
    // shadow reaches, and only the area is copied back.
    let k = (a.hypot(b)).max(c.hypot(d)) as f64;
    let reach = shadow_reach(drawing, k);
    let grown = IRect {
        x0: area.x0 - reach,
        y0: area.y0 - reach,
        x1: area.x1 + reach,
        y1: area.y1 + reach,
    }
    .intersect(&recorded.region)
    .unwrap_or(area);
    let part = record(drawing, args, images, text, recorded.key, grown, frac);
    let same = part.layers.len() == recorded.layers.len()
        && part
            .layers
            .iter()
            .zip(&recorded.layers)
            .all(|(p, r)| match (p, r) {
                (Layer::Pixels(..), Layer::Pixels(..)) => true,
                (Layer::Text(p), Layer::Text(r)) => {
                    p.len() == r.len()
                        && p.iter()
                            .zip(r)
                            .all(|(p, r)| p.glyphs.len() == r.glyphs.len())
                }
                _ => false,
            });
    if !same {
        return false;
    }
    // The part's pixmap coordinates to the recorded ones.
    let (dx, dy) = (grown.x0 - recorded.region.x0, grown.y0 - recorded.region.y0);
    // The area, in the recorded pixmap's and in the part's coordinates.
    let local = IRect {
        x0: area.x0 - recorded.region.x0,
        y0: area.y0 - recorded.region.y0,
        x1: area.x1 - recorded.region.x0,
        y1: area.y1 - recorded.region.y0,
    };
    let (ix, iy) = ((area.x0 - grown.x0) as usize, (area.y0 - grown.y0) as usize);
    let (aw, ah) = (area.width() as usize, area.height() as usize);
    for (p, r) in part.layers.into_iter().zip(&mut recorded.layers) {
        match (p, r) {
            (Layer::Pixels(from, _), Layer::Pixels(to, tiled)) => {
                let width = to.width() as usize;
                let fw = from.width() as usize;
                let (src, tp) = (from.pixels(), to.pixels_mut());
                for row in 0..ah {
                    let from_start = (iy + row) * fw + ix;
                    let to_start = (local.y0 as usize + row) * width + local.x0 as usize;
                    tp[to_start..to_start + aw].copy_from_slice(&src[from_start..from_start + aw]);
                }
                for tile in tiled.iter_mut() {
                    if tile.rect.intersect(&local).is_some() {
                        tile.uploaded = None;
                    }
                }
            }
            (Layer::Text(from), Layer::Text(to)) => {
                // Text is not clipped to the area: all of it, moved.
                *to = from
                    .into_iter()
                    .map(|mut run| {
                        for g in &mut run.glyphs {
                            g.x += dx as f32;
                            g.y += dy as f32;
                        }
                        if let Some(c) = &mut run.clip {
                            *c = [
                                c[0] + dx as f32,
                                c[1] + dy as f32,
                                c[2] + dx as f32,
                                c[3] + dy as f32,
                            ];
                        }
                        run
                    })
                    .collect();
            }
            _ => unreachable!("the layers were compared"),
        }
    }
    true
}

/// How far (device pixels, `k` per point) a shadow of `drawing` reaches
/// from its shape: three deviations of its blur and its offset.
fn shadow_reach(drawing: &Drawing, k: f64) -> i32 {
    let (mut blur, mut offset) = (0.0f64, 0.0f64);
    for op in &drawing.ops {
        match *op {
            CanvasOp::ShadowBlur(b) => {
                blur = blur.max(3.0 * (b.0.max(0.0) as f64 / 2.0 * k).min(MAX_SIGMA));
            }
            CanvasOp::ShadowOffset(o) => {
                offset = offset.max((o.x.0.abs() + o.y.0.abs()) as f64 * k);
            }
            _ => {}
        }
    }
    (blur + offset).ceil().min(f64::from(MAX_SIDE)) as i32
}

// --- Replay ----------------------------------------------------------------

/// Canvas' drawing state (`save` / `restore`).
#[derive(Clone)]
struct State {
    /// User space to the pixmap's coordinates.
    transform: Affine,
    fill: Paint,
    stroke: Paint,
    line_width: f64,
    cap: LineCap,
    join: LineJoin,
    miter: f64,
    dash: Arc<[Points]>,
    dash_offset: f64,
    alpha: f64,
    composite: Composite,
    /// Color, blur, offset x, offset y.
    shadow: (Color, f64, f64, f64),
    font: CanvasFont,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
    /// The transform is not invertible (`scale(0, 1)`): nothing draws
    /// until `setTransform` or `restore`.
    singular: bool,
    /// The clip (pixmap coordinates), and its bounds.
    clip: Option<(Rc<sk::Mask>, [f32; 4])>,
}

impl State {
    fn new(transform: Affine) -> Self {
        State {
            transform,
            fill: Paint::Color(Color::BLACK),
            stroke: Paint::Color(Color::BLACK),
            line_width: 1.0,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            miter: 10.0,
            dash: Arc::new([]),
            dash_offset: 0.0,
            alpha: 1.0,
            composite: Composite::SourceOver,
            shadow: (Color::TRANSPARENT, 0.0, 0.0, 0.0),
            font: CanvasFont::default(),
            align: CanvasTextAlign::Start,
            baseline: CanvasTextBaseline::Alphabetic,
            singular: false,
            clip: None,
        }
    }
}

/// How a shape is painted.
#[derive(Clone, Copy)]
enum Mode {
    Fill(FillRule),
    Stroke,
}

/// What a shape is filled with.
enum Source {
    Solid(sk::Color),
    /// Pixels over part of the pixmap (gradients), from `(x, y)`.
    Pixels(sk::Pixmap, i32, i32),
    /// An image: its pixels, the transform from them to the pixmap and the
    /// alpha.
    Image(Arc<sk::Pixmap>, sk::Transform, f32),
}

/// A run of canvas text in one color, as GPUI glyphs.
struct GlyphRun {
    glyphs: Vec<Glyph>,
    /// The font size, in points.
    size: f32,
    color: Hsla,
    /// Clipped to these pixmap coordinates.
    clip: Option<[f32; 4]>,
}

/// A glyph of canvas text: its baseline origin in pixmap coordinates.
#[derive(Clone, Copy)]
struct Glyph {
    x: f32,
    y: f32,
    font: gpui::FontId,
    id: gpui::GlyphId,
    emoji: bool,
}

struct Replay<'a> {
    args: &'a [Option<AnimationValue>],
    images: &'a FxHashMap<Arc<str>, Option<Arc<sk::Pixmap>>>,
    text: &'a WindowTextSystem,
    /// The app's text system (fonts are resolved in it).
    system: &'a Arc<gpui::TextSystem>,
    size: (u32, u32),
    /// The view's coordinates to the pixmap's.
    base: Affine,
    /// Device pixels per point.
    scale: f64,
    state: State,
    stack: Vec<State>,
    /// The current path, in pixmap coordinates.
    path: PathBuf,
    /// What is done, bottom to top.
    layers: Vec<Layer>,
    /// The pixmap drawn into (`None` if it could not be made).
    pixmap: Option<sk::Pixmap>,
    /// Something was drawn into `pixmap`.
    drawn: bool,
    /// Text drawn since `pixmap` was started, above it.
    pending: Vec<GlyphRun>,
    /// The bounds of `pending` (pixmap coordinates).
    pending_bounds: Option<sk::Rect>,
}

impl<'a> Replay<'a> {
    fn n(&self, n: Num) -> f64 {
        n.get(|s| {
            self.args
                .get(s as usize)
                .copied()
                .flatten()
                .map_or(0.0, AnimationValue::number)
        }) as f64
    }

    fn color(&self, paint: &Paint) -> Option<Color> {
        match paint {
            Paint::Color(c) => Some(*c),
            Paint::Slot(s) => match self.args.get(*s as usize).copied().flatten() {
                Some(AnimationValue::Color(c)) => Some(Color(c)),
                _ => Some(Color::TRANSPARENT),
            },
            Paint::Gradient(_) => None,
        }
    }

    fn paint(&self, mode: Mode) -> &Paint {
        match mode {
            Mode::Fill(_) => &self.state.fill,
            Mode::Stroke => &self.state.stroke,
        }
    }

    /// Multiplies the transform by `m` (canvas `transform`).
    fn concat(&mut self, m: Affine) {
        if self.state.singular {
            return;
        }
        let next = self.state.transform.then(&m);
        if next.invert().is_some() {
            self.state.transform = next;
        } else {
            self.state.singular = true;
        }
    }

    fn op(&mut self, op: &CanvasOp) {
        match op {
            CanvasOp::Save => self.stack.push(self.state.clone()),
            CanvasOp::Restore => {
                if let Some(state) = self.stack.pop() {
                    self.state = state;
                }
            }
            CanvasOp::Translate(x, y) => self.concat(Affine::translate(self.n(*x), self.n(*y))),
            CanvasOp::Scale(x, y) => self.concat(Affine::scale(self.n(*x), self.n(*y))),
            CanvasOp::Rotate(a) => self.concat(Affine::rotate(self.n(*a))),
            CanvasOp::Transform(m) => {
                let [a, b, c, d, e, f] = m.map(|v| self.n(v));
                self.concat(Affine { a, b, c, d, e, f });
            }
            CanvasOp::SetTransform(m) => {
                let [a, b, c, d, e, f] = m.map(|v| self.n(v));
                let next = self.base.then(&Affine { a, b, c, d, e, f });
                self.state.singular = next.invert().is_none();
                if !self.state.singular {
                    self.state.transform = next;
                }
            }
            CanvasOp::BeginPath => self.path.clear(),
            CanvasOp::Path(p) => {
                if !self.state.singular {
                    let mut path = std::mem::take(&mut self.path);
                    self.path_op(&mut path, p);
                    self.path = path;
                }
            }
            CanvasOp::Fill(path, rule) => self.shape(path.as_deref(), Mode::Fill(*rule)),
            CanvasOp::Stroke(path) => self.shape(path.as_deref(), Mode::Stroke),
            CanvasOp::Clip(path, rule) => self.clip(path.as_deref(), *rule),
            CanvasOp::FillRect(r) => self.rect(r, Mode::Fill(FillRule::NonZero)),
            CanvasOp::StrokeRect(r) => self.rect(r, Mode::Stroke),
            CanvasOp::ClearRect(r) => self.clear_rect(r),
            CanvasOp::FillStyle(p) => self.state.fill = p.clone(),
            CanvasOp::StrokeStyle(p) => self.state.stroke = p.clone(),
            CanvasOp::LineWidth(w) => {
                let w = self.n(*w);
                // Canvas ignores zero, negative and non-finite widths.
                if w > 0.0 && w.is_finite() {
                    self.state.line_width = w;
                }
            }
            CanvasOp::LineCap(cap) => self.state.cap = *cap,
            CanvasOp::LineJoin(join) => self.state.join = *join,
            CanvasOp::MiterLimit(m) => self.state.miter = *m as f64,
            CanvasOp::LineDash(d) => self.state.dash = d.clone(),
            CanvasOp::LineDashOffset(o) => self.state.dash_offset = self.n(*o),
            CanvasOp::GlobalAlpha(a) => {
                let a = self.n(*a);
                if (0.0..=1.0).contains(&a) {
                    self.state.alpha = a;
                }
            }
            CanvasOp::Composite(m) => self.state.composite = *m,
            CanvasOp::ShadowColor(color) => self.state.shadow.0 = *color,
            CanvasOp::ShadowBlur(b) => self.state.shadow.1 = b.0 as f64,
            CanvasOp::ShadowOffset(o) => {
                self.state.shadow.2 = o.x.0 as f64;
                self.state.shadow.3 = o.y.0 as f64;
            }
            CanvasOp::Font(f) => {
                // The shorthand keeps the numeric variant, as in browsers.
                let variant = self.state.font.variant;
                self.state.font = f.clone();
                self.state.font.variant = variant;
            }
            CanvasOp::FontVariantNumeric(v) => self.state.font.variant = *v,
            CanvasOp::TextAlign(a) => self.state.align = *a,
            CanvasOp::TextBaseline(b) => self.state.baseline = *b,
            CanvasOp::FillText {
                text,
                x,
                y,
                max_width,
            } => {
                let mode = Mode::Fill(FillRule::NonZero);
                self.text_op(text, self.n(*x), self.n(*y), max_width.map(|m| m.0), mode)
            }
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            } => {
                let max_width = max_width.map(|m| m.0);
                self.text_op(text, self.n(*x), self.n(*y), max_width, Mode::Stroke)
            }
            CanvasOp::DrawImage {
                image,
                source,
                dest,
            } => {
                let source = source
                    .map(|s| [s.origin.x, s.origin.y, s.size.width, s.size.height].map(|v| v.0));
                self.image(&image.uri, source, dest)
            }
        }
    }

    // --- Paths ---

    /// Adds `op` (in user space) to `path` (in pixmap coordinates).
    fn path_op(&self, path: &mut PathBuf, op: &PathOp) {
        let m = self.state.transform;
        let n = |v: Num| self.n(v);
        match op {
            PathOp::MoveTo(x, y) => path.move_to(m.map((n(*x), n(*y)))),
            PathOp::LineTo(x, y) => path.line_to(m.map((n(*x), n(*y)))),
            PathOp::QuadTo(v) => {
                let [cx, cy, x, y] = v.map(n);
                path.ensure(m.map((cx, cy)));
                let p0 = self.user_point(path).unwrap_or((cx, cy));
                let [c1x, c1y, c2x, c2y] = quad_to_cubic(p0, (cx, cy), (x, y));
                path.cubic_to(m.map((c1x, c1y)), m.map((c2x, c2y)), m.map((x, y)));
            }
            PathOp::CubicTo(v) => {
                let [c1x, c1y, c2x, c2y, x, y] = v.map(n);
                path.ensure(m.map((c1x, c1y)));
                path.cubic_to(m.map((c1x, c1y)), m.map((c2x, c2y)), m.map((x, y)));
            }
            PathOp::Arc {
                x,
                y,
                radius,
                start,
                end,
                ccw,
            } => {
                let r = n(*radius);
                if r < 0.0 {
                    return;
                }
                let start = n(*start);
                let sweep =
                    arc_sweep(Radians(start as f32), Radians(n(*end) as f32), *ccw).0 as f64;
                let unit = m.then(&Affine::translate(n(*x), n(*y)).then(&Affine::scale(r, r)));
                path.arc(&unit, start, sweep);
            }
            PathOp::ArcTo(v) => {
                let [x1, y1, x2, y2, r] = v.map(n);
                self.arc_to(path, x1, y1, x2, y2, r);
            }
            PathOp::Ellipse {
                geometry,
                start,
                end,
                ccw,
            } => {
                let [x, y, rx, ry, rotation] = geometry.map(n);
                if rx < 0.0 || ry < 0.0 {
                    return;
                }
                let start = n(*start);
                let sweep =
                    arc_sweep(Radians(start as f32), Radians(n(*end) as f32), *ccw).0 as f64;
                let unit = m.then(
                    &Affine::translate(x, y)
                        .then(&Affine::rotate(rotation))
                        .then(&Affine::scale(rx, ry)),
                );
                path.arc(&unit, start, sweep);
            }
            PathOp::Rect(v) => {
                let [x, y, w, h] = v.map(n);
                path.move_to(m.map((x, y)));
                path.line_to(m.map((x + w, y)));
                path.line_to(m.map((x + w, y + h)));
                path.line_to(m.map((x, y + h)));
                path.close();
            }
            PathOp::RoundRect(rect, radii) => {
                let [x, y, w, h] = rect.map(n);
                let [tl, tr, br, bl] = radii.map(|r| Points(n(r) as f32));
                let fitted = fit_radii(
                    size(Points(w as f32), Points(h as f32)),
                    Corners {
                        top_left: tl,
                        top_right: tr,
                        bottom_right: br,
                        bottom_left: bl,
                    },
                );
                let [tl, tr, br, bl] = [
                    fitted.top_left,
                    fitted.top_right,
                    fitted.bottom_right,
                    fitted.bottom_left,
                ]
                .map(|r| f64::from(r.0));
                path.move_to(m.map((x + tl, y)));
                self.arc_to(path, x + w, y, x + w, y + h, tr);
                self.arc_to(path, x + w, y + h, x, y + h, br);
                self.arc_to(path, x, y + h, x, y, bl);
                self.arc_to(path, x, y, x + w, y, tl);
                path.close();
                path.move_to(m.map((x, y)));
            }
            PathOp::Close => path.close(),
        }
    }

    /// The path's current point in user space.
    fn user_point(&self, path: &PathBuf) -> Option<Pt> {
        let p = path.current?;
        Some(self.state.transform.invert()?.map(p))
    }

    /// Canvas `arcTo` (user space).
    fn arc_to(&self, path: &mut PathBuf, x1: f64, y1: f64, x2: f64, y2: f64, r: f64) {
        let m = self.state.transform;
        let Some(p0) = self.user_point(path) else {
            path.move_to(m.map((x1, y1)));
            return;
        };
        match arc_to_geometry(p0, (x1, y1), (x2, y2), r) {
            Some(ArcTo {
                center: (cx, cy),
                start,
                sweep,
            }) => {
                let unit = m.then(&Affine::translate(cx, cy).then(&Affine::scale(r, r)));
                path.arc(&unit, start, sweep);
            }
            None => path.line_to(m.map((x1, y1))),
        }
    }

    /// `path` (the current path when `None`) in pixmap coordinates.
    fn shape_path(&self, path: Option<&[PathOp]>) -> Option<sk::Path> {
        match path {
            None => self.path.to_skia(),
            Some(ops) => {
                let mut own = PathBuf::default();
                for op in ops {
                    self.path_op(&mut own, op);
                }
                own.to_skia()
            }
        }
    }

    /// The area `path` (pixmap coordinates) covers when painted by `mode`,
    /// and its fill rule.
    fn coverage(&self, path: sk::Path, mode: Mode) -> Option<(sk::Path, sk::FillRule)> {
        match mode {
            Mode::Fill(rule) => Some((path, fill_rule(rule))),
            Mode::Stroke => {
                let s = &self.state;
                let to_user = s.transform.invert()?;
                let mut user = path.transform(to_user.skia())?;
                // Curves are flattened finely enough for the pixmap's pixels.
                let k = s.transform.scale_factor().max(1e-3) as f32;
                if let Some((dashes, offset)) = dash_pattern(&s.dash, s.dash_offset) {
                    let dash = sk::StrokeDash::new(dashes, offset)?;
                    user = user.dash(&dash, k)?;
                }
                let stroke = sk::Stroke {
                    width: s.line_width as f32,
                    miter_limit: s.miter as f32,
                    line_cap: match s.cap {
                        LineCap::Butt => sk::LineCap::Butt,
                        LineCap::Round => sk::LineCap::Round,
                        LineCap::Square => sk::LineCap::Square,
                    },
                    // tiny-skia bevels joins past the miter limit, as canvas
                    // does.
                    line_join: match s.join {
                        LineJoin::Miter => sk::LineJoin::Miter,
                        LineJoin::Round => sk::LineJoin::Round,
                        LineJoin::Bevel => sk::LineJoin::Bevel,
                    },
                    dash: None,
                };
                let outline = user.stroke(&stroke, k)?;
                Some((
                    outline.transform(s.transform.skia())?,
                    sk::FillRule::Winding,
                ))
            }
        }
    }

    /// `fill` / `stroke` of the current path or of `path`.
    fn shape(&mut self, path: Option<&[PathOp]>, mode: Mode) {
        if self.state.singular {
            return;
        }
        if let Some(path) = self.shape_path(path) {
            self.paint_path(path, mode);
        }
    }

    /// The rectangle `r` (user space) in pixmap coordinates.
    fn rect_path(&self, r: [f64; 4]) -> Option<sk::Path> {
        let [x, y, w, h] = r;
        let m = self.state.transform;
        let mut p = PathBuf::default();
        p.move_to(m.map((x, y)));
        p.line_to(m.map((x + w, y)));
        p.line_to(m.map((x + w, y + h)));
        p.line_to(m.map((x, y + h)));
        p.close();
        p.to_skia()
    }

    /// `fillRect` / `strokeRect` (the current path stays).
    fn rect(&mut self, r: &[Num; 4], mode: Mode) {
        if self.state.singular {
            return;
        }
        if let Some(path) = self.rect_path(r.map(|v| self.n(v))) {
            self.paint_path(path, mode);
        }
    }

    /// `clearRect`: the rectangle (inside the clip) becomes transparent.
    fn clear_rect(&mut self, r: &[Num; 4]) {
        if self.state.singular {
            return;
        }
        let Some(path) = self.rect_path(r.map(|v| self.n(v))) else {
            return;
        };
        self.before(path.bounds());
        let clip = self.state.clip.clone();
        let Some(pixmap) = self.pixmap.as_mut() else {
            return;
        };
        let paint = sk::Paint {
            blend_mode: sk::BlendMode::Clear,
            ..sk::Paint::default()
        };
        pixmap.fill_path(
            &path,
            &paint,
            sk::FillRule::Winding,
            sk::Transform::identity(),
            clip.as_ref().map(|c| &*c.0),
        );
    }

    /// `clip`: intersects the clip with the current path or `path`.
    fn clip(&mut self, path: Option<&[PathOp]>, rule: FillRule) {
        if self.state.singular {
            return;
        }
        let (w, h) = self.size;
        let path = self.shape_path(path);
        let old = self.state.clip.take();
        let mut mask = match &old {
            Some((mask, _)) => (**mask).clone(),
            None => match sk::Mask::new(w, h) {
                Some(mut mask) => {
                    mask.data_mut().fill(255);
                    mask
                }
                None => return,
            },
        };
        let bounds = match &path {
            Some(path) => {
                mask.intersect_path(path, fill_rule(rule), true, sk::Transform::identity());
                let b = path.bounds();
                [b.left(), b.top(), b.right(), b.bottom()]
            }
            // An empty path clips everything away.
            None => {
                mask.clear();
                [0.0; 4]
            }
        };
        let bounds = match &old {
            Some((_, old)) => intersect(old, &bounds),
            None => bounds,
        };
        self.state.clip = Some((Rc::new(mask), bounds));
    }

    // --- Painting ---

    /// Fills or strokes `path` (pixmap coordinates) with the state's
    /// paint, alpha, composite operation and shadow.
    fn paint_path(&mut self, path: sk::Path, mode: Mode) {
        let Some((area, rule)) = self.coverage(path, mode) else {
            return;
        };
        let Some(source) = self.source(self.paint(mode).clone(), &area, rule) else {
            return;
        };
        self.emit(area.bounds(), &|pixmap, to, mask, blend| {
            fill(pixmap, &area, rule, &source, to, blend, mask);
        });
    }

    /// What `paint` fills `area` with, at the state's alpha; `None` if it
    /// draws nothing.
    fn source(&self, paint: Paint, area: &sk::Path, rule: sk::FillRule) -> Option<Source> {
        let alpha = self.state.alpha as f32;
        if let Some(color) = self.color(&paint) {
            let (r, g, b, a) = color.to_f64();
            let c = sk::Color::from_rgba(r as f32, g as f32, b as f32, a as f32 * alpha)?;
            return (c.alpha() > 0.0).then_some(Source::Solid(c));
        }
        let Paint::Gradient(gradient) = paint else {
            return None;
        };
        let Some(pixels) = self.clipped(area.bounds()) else {
            // None of it is in the pixmap: painted as nothing rather than
            // skipped, so which layer later operations go to (and whether
            // the pixmap is drawn) does not depend on the area rasterized
            // ([`patch`]).
            return Some(Source::Solid(sk::Color::TRANSPARENT));
        };
        // Only the pixels the area covers are worked out (a stroke covers
        // little of its bounds).
        let mut covered = sk::Mask::new(pixels.width() as u32, pixels.height() as u32)?;
        let to_pixels = sk::Transform::from_translate(-pixels.x0 as f32, -pixels.y0 as f32);
        covered.fill_path(area, rule, true, to_pixels);
        let to_user = self.state.transform.invert()?;
        let gradient = gradient_pixels(&gradient, &to_user, pixels, &covered, alpha)?;
        Some(Source::Pixels(gradient, pixels.x0, pixels.y0))
    }

    /// The pixels of the pixmap within `bounds` and the clip.
    fn clipped(&self, bounds: sk::Rect) -> Option<IRect> {
        let (w, h) = self.size;
        let mut r = [bounds.left(), bounds.top(), bounds.right(), bounds.bottom()];
        if let Some((_, clip)) = &self.state.clip {
            r = intersect(&r, clip);
        }
        pixels_within(r, (w, h))
    }

    fn casts_shadow(&self) -> bool {
        let (color, blur, ox, oy) = self.state.shadow;
        !color.is_transparent() && (blur > 0.0 || ox != 0.0 || oy != 0.0)
    }

    /// The state's shadow offset, in pixmap pixels (shadows are in the
    /// view's coordinates, not the transform's).
    fn shadow_offset(&self) -> (f64, f64) {
        let (_, _, ox, oy) = self.state.shadow;
        let base = self.base;
        (base.a * ox + base.c * oy, base.b * ox + base.d * oy)
    }

    /// Before painting within `bounds`: text drawn before that it overlaps
    /// goes below a new pixmap.
    fn before(&mut self, bounds: sk::Rect) {
        let Some(text) = self.pending_bounds else {
            return;
        };
        if text.intersect(&bounds).is_some() {
            self.flush();
            self.pixmap = sk::Pixmap::new(self.size.0, self.size.1);
        }
    }

    /// Ends the pixmap and the text above it.
    fn flush(&mut self) {
        if let Some(pixmap) = self.pixmap.take()
            && self.drawn
        {
            self.layers.push(Layer::Pixels(pixmap, Vec::new()));
        }
        self.drawn = false;
        if !self.pending.is_empty() {
            self.layers
                .push(Layer::Text(std::mem::take(&mut self.pending)));
        }
        self.pending_bounds = None;
    }

    /// Draws what `draw` paints within `bounds` (pixmap coordinates) with
    /// the state's composite operation, clip and shadow. `draw` paints in
    /// pixmap coordinates moved by the transform it is given.
    fn emit(&mut self, bounds: sk::Rect, draw: Draw<'_>) {
        let shadow = if self.casts_shadow() {
            let (color, blur, _, _) = self.state.shadow;
            let sigma = (blur / 2.0 * self.base.scale_factor()).clamp(0.0, MAX_SIGMA);
            Some((color, sigma, self.shadow_offset()))
        } else {
            None
        };
        let mut extent = bounds;
        if let Some((_, sigma, (dx, dy))) = shadow {
            let grow = (3.0 * sigma) as f32;
            let (dx, dy) = (dx as f32, dy as f32);
            if let Some(r) = sk::Rect::from_ltrb(
                bounds.left() + dx.min(0.0) - grow,
                bounds.top() + dy.min(0.0) - grow,
                bounds.right() + dx.max(0.0) + grow,
                bounds.bottom() + dy.max(0.0) + grow,
            ) {
                extent = r;
            }
        }
        self.before(extent);
        let composite = self.state.composite;
        let clip = self.state.clip.clone();
        let mask = clip.as_ref().map(|c| &*c.0);
        let (w, h) = self.size;
        let Some(pixmap) = self.pixmap.as_mut() else {
            return;
        };
        self.drawn = true;
        if composite == Composite::SourceOver && shadow.is_none() {
            draw(
                pixmap,
                sk::Transform::identity(),
                mask,
                sk::BlendMode::SourceOver,
            );
            return;
        }
        // The shadow and the shape combine with the pixmap as one layer: of
        // what they cover, or of all of it for the operations that change
        // the pixmap where the shape is not.
        let all = IRect {
            x0: 0,
            y0: 0,
            x1: w as i32,
            y1: h as i32,
        };
        let rect = if destructive(composite) {
            Some(all)
        } else {
            let r = [extent.left(), extent.top(), extent.right(), extent.bottom()];
            pixels_within(r, (w, h))
        };
        let Some(rect) = rect else {
            return;
        };
        let Some(mut layer) = sk::Pixmap::new(rect.width() as u32, rect.height() as u32) else {
            return;
        };
        let to_layer = sk::Transform::from_translate(-rect.x0 as f32, -rect.y0 as f32);
        draw(&mut layer, to_layer, None, sk::BlendMode::SourceOver);
        if let Some((color, sigma, offset)) = shadow {
            let area = shadow_area(bounds, rect, sigma);
            let shadow = area.and_then(|area| shadow_pixels(&layer, area, sigma, color));
            if let Some((shadow, x, y)) = shadow {
                layer.draw_pixmap(
                    0,
                    0,
                    shadow.as_ref(),
                    &sk::PixmapPaint {
                        blend_mode: sk::BlendMode::DestinationOver,
                        quality: sk::FilterQuality::Bilinear,
                        ..sk::PixmapPaint::default()
                    },
                    sk::Transform::from_translate(
                        x as f32 + offset.0 as f32,
                        y as f32 + offset.1 as f32,
                    ),
                    None,
                );
            }
        }
        pixmap.draw_pixmap(
            rect.x0,
            rect.y0,
            layer.as_ref(),
            &sk::PixmapPaint {
                blend_mode: blend_mode(composite),
                ..sk::PixmapPaint::default()
            },
            sk::Transform::identity(),
            mask,
        );
    }

    // --- Text ---

    fn text_op(&mut self, text: &Arc<str>, x: f64, y: f64, max_width: Option<f32>, mode: Mode) {
        if text.is_empty() || self.state.singular {
            return;
        }
        let font = canvas_font(self.system, &self.state.font);
        let size = self.state.font.size.0.max(0.1);
        let system: &gpui::TextSystem = self.text;
        let id = system.resolve_font(&font);
        let ascent = f32::from(system.ascent(id, px(size))) as f64;
        let descent = f32::from(system.descent(id, px(size))).abs() as f64;
        let run = TextRun {
            len: text.len(),
            font,
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = self.text.layout_line(text, px(size), &[run], None);
        let width = f32::from(line.width) as f64;
        let dx = match self.state.align {
            CanvasTextAlign::Start | CanvasTextAlign::Left => 0.0,
            CanvasTextAlign::Center => -width / 2.0,
            CanvasTextAlign::End | CanvasTextAlign::Right => -width,
        };
        // How far below the given y the baseline goes.
        let down = match self.state.baseline {
            CanvasTextBaseline::Alphabetic => 0.0,
            CanvasTextBaseline::Top => ascent,
            CanvasTextBaseline::Hanging => ascent * 0.8,
            CanvasTextBaseline::Middle => (ascent - descent) / 2.0,
            CanvasTextBaseline::Ideographic | CanvasTextBaseline::Bottom => -descent,
        };
        let squeeze = match max_width {
            Some(m) if (m as f64) < width && width > 0.0 => m as f64 / width,
            _ => 1.0,
        };
        if squeeze <= 0.0 {
            return;
        }
        // The line's coordinates (baseline at y = 0) in the pixmap's.
        let place = self.state.transform.then(
            &Affine::translate(x, y + down)
                .then(&Affine::scale(squeeze, 1.0))
                .then(&Affine::translate(dx, 0.0)),
        );
        let Some(bounds) = quad_bounds(&place, 0.0, -ascent, width, ascent + descent) else {
            return;
        };
        // Glyphs whose outlines the font file gives are a path painted like
        // any other; the rest (emoji, fonts whose file is not found) are
        // GPUI glyphs above the pixmap.
        let mut outlines = sk::PathBuilder::new();
        let mut glyphs = Vec::new();
        for run in &line.runs {
            let file = font_file(system, run.font_id);
            for g in &run.glyphs {
                let gx = f32::from(g.position.x) as f64;
                let outlined = match &file {
                    Some(file) if !g.is_emoji => {
                        let k = size as f64 / file.units_per_em as f64;
                        let to =
                            place.then(&Affine::translate(gx, 0.0).then(&Affine::scale(k, -k)));
                        file.push_glyph(g.id.0 as u16, &to, &mut outlines)
                    }
                    _ => false,
                };
                if !outlined {
                    let (x, y) = place.map((gx, 0.0));
                    glyphs.push(Glyph {
                        x: x as f32,
                        y: y as f32,
                        font: run.font_id,
                        id: g.id,
                        emoji: g.is_emoji,
                    });
                }
            }
        }
        if let Some(path) = outlines.finish() {
            let mode = match mode {
                Mode::Fill(_) => Mode::Fill(FillRule::NonZero),
                Mode::Stroke => Mode::Stroke,
            };
            self.paint_path(path, mode);
        }
        if glyphs.is_empty() {
            return;
        }
        let color = match self.paint(mode) {
            Paint::Gradient(g) => middle_color(g),
            paint => self.color(paint).unwrap_or(Color::TRANSPARENT),
        };
        let (r, g, b, a) = color.to_f64();
        let alpha = a * self.state.alpha;
        if alpha <= 0.0 {
            return;
        }
        // Glyphs are as large as the text is under the transform, in
        // points; squeezed text is made smaller (glyphs cannot be
        // narrowed).
        let k = self.state.transform.det().abs().sqrt() * squeeze;
        let font_size = (size as f64 * k / self.scale) as f32;
        let clip = self.state.clip.as_ref().map(|c| c.1);
        if self.casts_shadow() {
            let (sx, sy) = self.shadow_offset();
            let (sr, sg, sb, sa) = self.state.shadow.0.to_f64();
            let shadow = gpui::Rgba {
                r: sr as f32,
                g: sg as f32,
                b: sb as f32,
                a: (sa * alpha) as f32,
            };
            let moved = glyphs
                .iter()
                .map(|g| Glyph {
                    x: g.x + sx as f32,
                    y: g.y + sy as f32,
                    ..*g
                })
                .collect();
            self.pending.push(GlyphRun {
                glyphs: moved,
                size: font_size,
                color: shadow.into(),
                clip,
            });
        }
        let color = gpui::Rgba {
            r: r as f32,
            g: g as f32,
            b: b as f32,
            a: alpha as f32,
        };
        self.pending.push(GlyphRun {
            glyphs,
            size: font_size,
            color: color.into(),
            clip,
        });
        self.pending_bounds = Some(match self.pending_bounds {
            Some(old) => union(&old, &bounds),
            None => bounds,
        });
    }

    // --- Images ---

    fn image(&mut self, uri: &str, source: Option<[f32; 4]>, dest: &[Num; 4]) {
        if self.state.singular {
            return;
        }
        let Some(Some(image)) = self.images.get(uri).cloned() else {
            return;
        };
        let (iw, ih) = (image.width() as f64, image.height() as f64);
        let [sx, sy, sw, sh] = source.map_or([0.0, 0.0, iw, ih], |s| s.map(f64::from));
        if sw == 0.0 || sh == 0.0 {
            return;
        }
        let [dx, dy, dw, dh] = dest.map(|v| self.n(v));
        // Missing sizes are the source's.
        let dw = if dw.is_nan() { sw } else { dw };
        let dh = if dh.is_nan() { sh } else { dh };
        if dw == 0.0 || dh == 0.0 {
            return;
        }
        let Some(path) = self.rect_path([dx, dy, dw, dh]) else {
            return;
        };
        // The image's pixels to user space, then to the pixmap.
        let to_dest = Affine::translate(dx, dy)
            .then(&Affine::scale(dw / sw, dh / sh))
            .then(&Affine::translate(-sx, -sy));
        let transform = self.state.transform.then(&to_dest).skia();
        let source = Source::Image(image, transform, self.state.alpha as f32);
        self.emit(path.bounds(), &|pixmap, to, mask, blend| {
            fill(
                pixmap,
                &path,
                sk::FillRule::Winding,
                &source,
                to,
                blend,
                mask,
            );
        });
    }
}

/// What paints a shape: on a pixmap, through a transform from pixmap
/// coordinates, inside a mask, with a blend mode.
type Draw<'a> = &'a dyn Fn(&mut sk::Pixmap, sk::Transform, Option<&sk::Mask>, sk::BlendMode);

// --- Glyph outlines -----------------------------------------------------------

/// Font files registered by the app (`asset:/` fonts), for
/// [`font_file`] to find besides the system's.
static REGISTERED_FONTS: std::sync::Mutex<Vec<Arc<[u8]>>> = std::sync::Mutex::new(Vec::new());

/// A font file was registered with GPUI's text system (any thread).
pub(crate) fn font_registered(data: &[u8]) {
    let mut fonts = REGISTERED_FONTS.lock().unwrap_or_else(|e| e.into_inner());
    fonts.push(Arc::from(data));
}

/// The font files canvas text is outlined from (any thread: canvas
/// workers outline text too).
#[derive(Default)]
struct Fonts {
    /// The system's fonts and the registered ones, once found (finding
    /// the system's takes long: a worker does it, [`load_fonts`]); shared,
    /// so searches run without the lock.
    db: Option<Arc<fontdb::Database>>,
    /// A worker is finding the system's fonts.
    loading: bool,
    /// How many of [`REGISTERED_FONTS`] `db` has.
    registered: usize,
    /// The file of each GPUI font, `None` when none matches it.
    by_id: FxHashMap<gpui::FontId, Option<Arc<FontFile>>>,
}

static FONTS: std::sync::LazyLock<std::sync::Mutex<Fonts>> =
    std::sync::LazyLock::new(Default::default);

/// [`FONTS`], locked.
fn fonts() -> std::sync::MutexGuard<'static, Fonts> {
    FONTS.lock().unwrap_or_else(|e| e.into_inner())
}

thread_local! {
    /// Canvases with text drawn before the fonts were found (main
    /// thread): drawn again once they are.
    static WAITING: RefCell<Vec<(std::rc::Weak<Surface>, nsh_core::NodeId)>> =
        const { RefCell::new(Vec::new()) };
}

/// A font file's glyph outlines.
struct FontFile {
    data: Arc<[u8]>,
    index: u32,
    units_per_em: u16,
    /// Outlines by glyph, in font units (y up), once read.
    glyphs: std::sync::Mutex<FxHashMap<u16, Option<sk::Path>>>,
}

impl FontFile {
    /// Adds the outline of `glyph` through `to` (from font units) to
    /// `path`; false if the font has no outline for it (bitmap and color
    /// glyphs). An empty glyph (a space) counts as outlined.
    fn push_glyph(&self, glyph: u16, to: &Affine, path: &mut sk::PathBuilder) -> bool {
        let mut glyphs = self.glyphs.lock().unwrap_or_else(|e| e.into_inner());
        let outline = glyphs.entry(glyph).or_insert_with(|| {
            let face = ttf_parser::Face::parse(&self.data, self.index).ok()?;
            let id = ttf_parser::GlyphId(glyph);
            let mut sink = Outline(sk::PathBuilder::new());
            match face.outline_glyph(id, &mut sink) {
                Some(_) => sink.0.finish(),
                // No outline: empty, or drawn some other way.
                None if face.glyph_raster_image(id, u16::MAX).is_some()
                    || face.glyph_svg_image(id).is_some()
                    || face.is_color_glyph(id) =>
                {
                    None
                }
                None => Some(sk::PathBuilder::from_rect(sk::Rect::from_xywh(
                    0.0, 0.0, 0.0, 0.0,
                )?)),
            }
        });
        let Some(outline) = outline else {
            return false;
        };
        if outline.bounds().width() == 0.0 && outline.bounds().height() == 0.0 {
            return true;
        }
        if let Some(placed) = outline.clone().transform(to.skia()) {
            path.push_path(&placed);
        }
        true
    }
}

/// tiny-skia's path builder as ttf-parser's outline sink.
struct Outline(sk::PathBuilder);

impl ttf_parser::OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y);
    }

    fn close(&mut self) {
        self.0.close();
    }
}

/// The file of GPUI's font `id`: found by its family, weight and style
/// among the system's and the app's fonts, and checked against GPUI's
/// metrics (so its glyph ids are GPUI's); `None` when none matches (a
/// font GPUI fell back to, a variable font at another weight, a system
/// font fontdb cannot read).
fn font_file(system: &gpui::TextSystem, id: gpui::FontId) -> Option<Arc<FontFile>> {
    let (db, registered) = {
        let fonts = &mut *self::fonts();
        let Some(db) = fonts.db.as_mut() else {
            load_fonts(fonts);
            return None;
        };
        let registered = REGISTERED_FONTS.lock().unwrap_or_else(|e| e.into_inner());
        if registered.len() > fonts.registered {
            // Copied only while a search elsewhere holds the database.
            let db = Arc::make_mut(db);
            for data in &registered[fonts.registered..] {
                db.load_font_data(data.to_vec());
            }
            fonts.registered = registered.len();
            // Fonts not found before may be among them.
            fonts.by_id.retain(|_, file| file.is_some());
        }
        drop(registered);
        if let Some(file) = fonts.by_id.get(&id) {
            return file.clone();
        }
        (db.clone(), fonts.registered)
    };
    // Reading a font file takes long (tens of milliseconds for a large
    // one): the main thread never waits for a worker's search.
    let file = find_font_file(&db, system, id).map(Arc::new);
    let mut fonts = self::fonts();
    // A search that raced with newly registered fonts is not kept.
    if fonts.registered == registered {
        return fonts.by_id.entry(id).or_insert(file).clone();
    }
    file
}

/// Starts finding the system's fonts on a worker (hundreds of
/// milliseconds), unless it is done or under way.
fn load_fonts(fonts: &mut Fonts) {
    if fonts.db.is_some() || fonts.loading {
        return;
    }
    fonts.loading = true;
    let spawned = std::thread::Builder::new()
        .name("nsh-canvas-fonts".into())
        .spawn(|| {
            let started = std::time::Instant::now();
            let mut db = fontdb::Database::new();
            db.load_system_fonts();
            log::debug!(
                target: "nsh::perf",
                "canvas: {} system font faces found in {:.1} ms",
                db.len(),
                started.elapsed().as_secs_f64() * 1000.0
            );
            crate::rt::invoke(move || fonts_loaded(db));
        });
    if let Err(e) = spawned {
        log::warn!("canvas: cannot find the system's fonts: {e}");
        fonts.db = Some(Arc::new(fontdb::Database::new()));
    }
}

/// The system's fonts were found: canvases that drew text without them
/// draw again.
fn fonts_loaded(db: fontdb::Database) {
    {
        let mut fonts = fonts();
        fonts.db = Some(Arc::new(db));
        fonts.loading = false;
    }
    let waiting = WAITING.with_borrow_mut(std::mem::take);
    for (surface, id) in waiting {
        let Some(view) = surface.upgrade().and_then(|s| s.view(id)) else {
            continue;
        };
        if let Some(c) = view.state_mut().canvas.as_mut() {
            c.stale();
        }
        view.changed();
    }
}

/// `view` draws text: until the system's fonts are found, it is drawn
/// again when they are.
fn wait_for_fonts(surface: &Rc<Surface>, view: &NshView) {
    let mut fonts = fonts();
    if fonts.db.is_none() {
        WAITING.with_borrow_mut(|w| w.push((Rc::downgrade(surface), view.id())));
        load_fonts(&mut fonts);
    }
}

/// [`font_file`]'s search.
fn find_font_file(
    db: &fontdb::Database,
    system: &gpui::TextSystem,
    id: gpui::FontId,
) -> Option<FontFile> {
    let font = system.get_font_for_id(id)?;
    let name = font.family.to_string();
    let mut families = vec![fontdb::Family::Name(&name)];
    // GPUI's own name for the UI font: what it resolves to on Linux, else
    // the platform's sans-serif.
    if name.starts_with('.') || name == "system-ui" {
        families = vec![fontdb::Family::Name("IBM Plex Sans")];
    }
    families.push(fontdb::Family::SansSerif);
    let style = match font.style {
        FontStyle::Normal => fontdb::Style::Normal,
        FontStyle::Italic => fontdb::Style::Italic,
        FontStyle::Oblique => fontdb::Style::Oblique,
    };
    for family in families {
        let query = fontdb::Query {
            families: &[family],
            weight: fontdb::Weight(font.weight.0.round() as u16),
            stretch: fontdb::Stretch::Normal,
            style,
        };
        let Some(face) = db.query(&query) else {
            continue;
        };
        let Some(file) = db.with_face_data(face, |data, index| {
            let face = ttf_parser::Face::parse(data, index).ok()?;
            same_font(system, id, &face).then(|| FontFile {
                data: Arc::from(data),
                index,
                units_per_em: face.units_per_em(),
                glyphs: Default::default(),
            })
        }) else {
            continue;
        };
        if file.is_some() {
            return file;
        }
    }
    None
}

/// True when `face` measures as GPUI's font `id` does: the same units per
/// em and the same advances of a few letters and figures.
fn same_font(system: &gpui::TextSystem, id: gpui::FontId, face: &ttf_parser::Face<'_>) -> bool {
    let upem = face.units_per_em();
    if upem == 0 || system.units_per_em(id) != upem as u32 {
        return false;
    }
    let mut compared = 0;
    for ch in ['0', '4', 'a', 'e', 'm', 'H', 'W'] {
        let Some(glyph) = face.glyph_index(ch) else {
            continue;
        };
        let Some(advance) = face.glyph_hor_advance(glyph) else {
            continue;
        };
        let Ok(gpui) = system.advance(id, px(upem as f32), ch) else {
            return false;
        };
        if (f32::from(gpui.width) - advance as f32).abs() > (upem as f32 / 200.0).max(1.0) {
            return false;
        }
        compared += 1;
    }
    compared >= 3
}

/// Fills `path` (pixmap coordinates, moved by `to`) on `pixmap` with
/// `source`.
fn fill(
    pixmap: &mut sk::Pixmap,
    path: &sk::Path,
    rule: sk::FillRule,
    source: &Source,
    to: sk::Transform,
    blend_mode: sk::BlendMode,
    mask: Option<&sk::Mask>,
) {
    let mut paint = sk::Paint {
        blend_mode,
        ..sk::Paint::default()
    };
    match source {
        Source::Solid(c) => paint.set_color(*c),
        Source::Pixels(pixels, x, y) => {
            paint.shader = sk::Pattern::new(
                pixels.as_ref(),
                sk::SpreadMode::Pad,
                sk::FilterQuality::Nearest,
                1.0,
                sk::Transform::from_translate(*x as f32, *y as f32),
            );
        }
        Source::Image(image, transform, alpha) => {
            // Drawn smaller than its pixels, bicubic keeps it from aliasing.
            let (sx, sy) = transform.get_scale();
            let quality = if sx.min(sy) < 0.75 {
                sk::FilterQuality::Bicubic
            } else {
                sk::FilterQuality::Bilinear
            };
            paint.shader = sk::Pattern::new(
                image.as_ref().as_ref(),
                sk::SpreadMode::Pad,
                quality,
                *alpha,
                *transform,
            );
        }
    }
    // The transform moves the shader along with the path.
    pixmap.fill_path(path, &paint, rule, to, mask);
}

fn fill_rule(rule: FillRule) -> sk::FillRule {
    match rule {
        FillRule::NonZero => sk::FillRule::Winding,
        FillRule::EvenOdd => sk::FillRule::EvenOdd,
    }
}

/// The GPUI font of a canvas font, as the text engine resolves it (so
/// widths match `measureText`), with its OpenType features.
fn canvas_font(system: &Arc<gpui::TextSystem>, font: &CanvasFont) -> Font {
    thread_local! {
        /// A text engine over the app's text system, for its font choice.
        static ENGINE: RefCell<Option<(usize, crate::text::GpuiTextEngine)>> =
            const { RefCell::new(None) };
    }
    let key = Arc::as_ptr(system) as usize;
    ENGINE.with_borrow_mut(|engine| {
        let engine = match engine {
            Some((k, engine)) if *k == key => engine,
            _ => {
                let made =
                    crate::text::GpuiTextEngine::new(system.clone(), crate::text::ui_family());
                &mut engine.insert((key, made)).1
            }
        };
        engine.font(&font.text_style())
    })
}

/// The bounds of the rectangle `(x, y, w, h)` under `m`.
fn quad_bounds(m: &Affine, x: f64, y: f64, w: f64, h: f64) -> Option<sk::Rect> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
        let (px, py) = m.map(p);
        x0 = x0.min(px);
        y0 = y0.min(py);
        x1 = x1.max(px);
        y1 = y1.max(py);
    }
    sk::Rect::from_ltrb(x0 as f32, y0 as f32, x1 as f32, y1 as f32)
}

/// The pixels of a `size` pixmap that the rectangle `[x0, y0, x1, y1]`
/// (which may be far larger) touches.
fn pixels_within(r: [f32; 4], size: (u32, u32)) -> Option<IRect> {
    let (w, h) = (size.0 as f32, size.1 as f32);
    let c = |v: f32, max: f32| if v.is_nan() { 0.0 } else { v.clamp(0.0, max) };
    IRect::round_out(c(r[0], w), c(r[1], h), c(r[2], w), c(r[3], h))
}

fn intersect(a: &[f32; 4], b: &[f32; 4]) -> [f32; 4] {
    [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ]
}

fn union(a: &sk::Rect, b: &sk::Rect) -> sk::Rect {
    sk::Rect::from_ltrb(
        a.left().min(b.left()),
        a.top().min(b.top()),
        a.right().max(b.right()),
        a.bottom().max(b.bottom()),
    )
    .unwrap_or(*a)
}

/// Canvas dashes in tiny-skia's form (an even count: odd lists repeat);
/// `None` for a solid line (no dashes, or all zero: canvas draws solid).
fn dash_pattern(dash: &[Points], offset: f64) -> Option<(Vec<f32>, f32)> {
    let mut d: Vec<f32> = dash.iter().map(|d| d.0).collect();
    if !d.iter().any(|d| *d > 0.0) || d.iter().any(|d| !d.is_finite() || *d < 0.0) {
        return None;
    }
    if d.len() % 2 == 1 {
        d.extend_from_within(..);
    }
    Some((d, offset as f32))
}

/// Operations that change the destination where the source is
/// transparent (bounded by the clip).
fn destructive(c: Composite) -> bool {
    matches!(
        c,
        Composite::SourceIn
            | Composite::SourceOut
            | Composite::DestinationIn
            | Composite::DestinationAtop
            | Composite::Copy
    )
}

/// Canvas' composite operations as tiny-skia's blend modes.
fn blend_mode(c: Composite) -> sk::BlendMode {
    use Composite::*;
    match c {
        SourceOver => sk::BlendMode::SourceOver,
        SourceIn => sk::BlendMode::SourceIn,
        SourceOut => sk::BlendMode::SourceOut,
        SourceAtop => sk::BlendMode::SourceAtop,
        DestinationOver => sk::BlendMode::DestinationOver,
        DestinationIn => sk::BlendMode::DestinationIn,
        DestinationOut => sk::BlendMode::DestinationOut,
        DestinationAtop => sk::BlendMode::DestinationAtop,
        Lighter => sk::BlendMode::Plus,
        Copy => sk::BlendMode::Source,
        Xor => sk::BlendMode::Xor,
        Multiply => sk::BlendMode::Multiply,
        Screen => sk::BlendMode::Screen,
        Overlay => sk::BlendMode::Overlay,
        Darken => sk::BlendMode::Darken,
        Lighten => sk::BlendMode::Lighten,
        ColorDodge => sk::BlendMode::ColorDodge,
        ColorBurn => sk::BlendMode::ColorBurn,
        HardLight => sk::BlendMode::HardLight,
        SoftLight => sk::BlendMode::SoftLight,
        Difference => sk::BlendMode::Difference,
        Exclusion => sk::BlendMode::Exclusion,
        Hue => sk::BlendMode::Hue,
        Saturation => sk::BlendMode::Saturation,
        Color => sk::BlendMode::Color,
        Luminosity => sk::BlendMode::Luminosity,
    }
}

// --- Shadows -----------------------------------------------------------------

/// The pixels whose shadow (blurred with standard deviation `sigma`) the
/// layer `layer` (pixmap pixels) needs, of a shape within `bounds`, in the
/// layer's coordinates: the shape grown by the blur's spread, inside the
/// layer grown likewise (the shape is drawn only in the layer); `None`
/// when that is nothing or too much to blur.
fn shadow_area(bounds: sk::Rect, layer: IRect, sigma: f64) -> Option<IRect> {
    let grow = (3.0 * sigma).ceil() as i32;
    let around = IRect {
        x0: -grow,
        y0: -grow,
        x1: layer.width() + grow,
        y1: layer.height() + grow,
    };
    let (x, y) = (layer.x0 as f32, layer.y0 as f32);
    let shape = [
        (bounds.left() - x).max(around.x0 as f32) - grow as f32,
        (bounds.top() - y).max(around.y0 as f32) - grow as f32,
        (bounds.right() - x).min(around.x1 as f32) + grow as f32,
        (bounds.bottom() - y).min(around.y1 as f32) + grow as f32,
    ];
    let area = IRect::round_out(shape[0], shape[1], shape[2], shape[3])?.intersect(&around)?;
    if area.width() as i64 * area.height() as i64 > 2 * MAX_AREA {
        log::debug!("canvas: a shadow too large to blur is left out");
        return None;
    }
    Some(area)
}

/// The shadow of `shape` within `area`: its alpha blurred with standard
/// deviation `sigma` and tinted `color`, as a pixmap to draw at `(x, y)`.
fn shadow_pixels(
    shape: &sk::Pixmap,
    area: IRect,
    sigma: f64,
    color: Color,
) -> Option<(sk::Pixmap, i32, i32)> {
    let (w, h) = (area.width() as usize, area.height() as usize);
    let mut alpha = vec![0u8; w * h];
    let (sw, sh) = (shape.width() as i32, shape.height() as i32);
    let pixels = shape.pixels();
    for y in area.y0.max(0)..area.y1.min(sh) {
        for x in area.x0.max(0)..area.x1.min(sw) {
            let p = pixels[(y * sw + x) as usize];
            alpha[(y - area.y0) as usize * w + (x - area.x0) as usize] = p.alpha();
        }
    }
    if sigma > 0.0 {
        blur(&mut alpha, w, h, sigma);
    }
    let (r, g, b, a) = color.to_f64();
    let mut out = sk::Pixmap::new(w as u32, h as u32)?;
    for (p, &m) in out.pixels_mut().iter_mut().zip(&alpha) {
        let a = a * m as f64 / 255.0;
        if a > 0.0 {
            let c = |v: f64| (v * a * 255.0).round() as u8;
            let alpha = (a * 255.0).round() as u8;
            *p = sk::PremultipliedColorU8::from_rgba(c(r), c(g), c(b), alpha)
                .unwrap_or(sk::PremultipliedColorU8::TRANSPARENT);
        }
    }
    Some((out, area.x0, area.y0))
}

/// The sizes of three box blurs that together come close to a Gaussian of
/// standard deviation `sigma`.
fn box_sizes(sigma: f64) -> [usize; 3] {
    let n = 3.0;
    let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut lower = ideal.floor() as usize;
    if lower.is_multiple_of(2) {
        lower = lower.saturating_sub(1);
    }
    let lower = lower.max(1);
    let l = lower as f64;
    let m = ((12.0 * sigma * sigma - n * l * l - 4.0 * n * l - 3.0 * n) / (-4.0 * l - 4.0))
        .round()
        .clamp(0.0, 3.0) as usize;
    [0, 1, 2].map(|i| if i < m { lower } else { lower + 2 })
}

/// Blurs `alpha` (`w` × `h`) with three box blurs each way.
fn blur(alpha: &mut [u8], w: usize, h: usize, sigma: f64) {
    let mut tmp = vec![0u8; alpha.len()];
    for size in box_sizes(sigma) {
        let r = size / 2;
        if r == 0 {
            continue;
        }
        box_pass(alpha, &mut tmp, w, h, r, true);
        box_pass(&tmp, alpha, w, h, r, false);
    }
}

/// One box blur of radius `r` along rows (`horizontal`) or columns, from
/// `src` into `dst`; outside is transparent.
fn box_pass(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let (lines, len, step, stride) = if horizontal {
        (h, w, 1, w)
    } else {
        (w, h, w, 1)
    };
    if len == 0 {
        return;
    }
    let width = (2 * r + 1) as u32;
    for line in 0..lines {
        let start = line * stride;
        let at = |i: usize| src[start + i * step] as u32;
        let mut sum: u32 = (0..=r.min(len - 1)).map(at).sum();
        for i in 0..len {
            dst[start + i * step] = ((sum + width / 2) / width) as u8;
            if i + r + 1 < len {
                sum += at(i + r + 1);
            }
            if i >= r {
                sum -= at(i - r);
            }
        }
    }
}

// --- Gradients ---------------------------------------------------------------

/// A gradient's colors at `GRADIENT_STEPS` offsets, premultiplied and
/// multiplied by `alpha`.
fn gradient_table(g: &CanvasGradient, alpha: f32) -> Vec<[f32; 4]> {
    let premultiplied = |c: Color| {
        let (r, g, b, a) = c.to_f64();
        let a = a as f32 * alpha;
        [r as f32 * a, g as f32 * a, b as f32 * a, a]
    };
    let stops = &g.stops;
    let (first, last) = (stops[0], stops[stops.len() - 1]);
    (0..GRADIENT_STEPS)
        .map(|i| {
            let t = i as f32 / (GRADIENT_STEPS - 1) as f32;
            if t <= first.0.0 {
                return premultiplied(first.1);
            }
            for w in stops.windows(2) {
                let ((o0, c0), (o1, c1)) = (w[0], w[1]);
                let (o0, o1) = (o0.0, o1.0);
                if t < o1 {
                    let f = if o1 > o0 { (t - o0) / (o1 - o0) } else { 1.0 };
                    let (a, b) = (premultiplied(c0), premultiplied(c1));
                    return [0, 1, 2, 3].map(|k| a[k] + (b[k] - a[k]) * f);
                }
            }
            premultiplied(last.1)
        })
        .collect()
}

/// Where a gradient is at a point of user space: 0..1 (padded past), or
/// `None` where it paints nothing (outside a radial gradient's cone).
fn gradient_offset(shape: &GradientShape, (x, y): Pt) -> Option<f64> {
    match *shape {
        GradientShape::Linear { start, end } => {
            let [x0, y0, x1, y1] = [start.x, start.y, end.x, end.y].map(|v| v.0);
            let (dx, dy) = ((x1 - x0) as f64, (y1 - y0) as f64);
            let len = dx * dx + dy * dy;
            Some(((x - x0 as f64) * dx + (y - y0 as f64) * dy) / len)
        }
        GradientShape::Radial {
            start,
            start_radius,
            end,
            end_radius,
        } => {
            let circles = [start.x, start.y, start_radius, end.x, end.y, end_radius];
            radial_offset(circles.map(|v| f64::from(v.0)), (x, y))
        }
        GradientShape::Conic {
            start_angle,
            center,
        } => {
            let (angle, cx, cy) = (start_angle.0, center.x.0, center.y.0);
            let a = (y - cy as f64).atan2(x - cx as f64) - angle as f64;
            Some((a / TAU).rem_euclid(1.0))
        }
    }
}

/// Canvas' two-circle radial gradient at `p`: the largest `t` whose circle
/// (centers and radii interpolated) passes through `p` with a radius of 0
/// or more.
fn radial_offset([x0, y0, r0, x1, y1, r1]: [f64; 6], (px, py): Pt) -> Option<f64> {
    let (cdx, cdy, dr) = (x1 - x0, y1 - y0, r1 - r0);
    let (pdx, pdy) = (px - x0, py - y0);
    let a = cdx * cdx + cdy * cdy - dr * dr;
    let b = pdx * cdx + pdy * cdy + r0 * dr;
    let c = pdx * pdx + pdy * pdy - r0 * r0;
    let ok = |t: f64| r0 + t * dr >= 0.0;
    if a.abs() < 1e-9 {
        if b.abs() < 1e-12 {
            return None;
        }
        let t = c / (2.0 * b);
        return ok(t).then_some(t);
    }
    let disc = b * b - a * c;
    if disc < 0.0 {
        return None;
    }
    let s = disc.sqrt();
    let (t1, t2) = ((b + s) / a, (b - s) / a);
    let (hi, lo) = if t1 > t2 { (t1, t2) } else { (t2, t1) };
    if ok(hi) {
        Some(hi)
    } else if ok(lo) {
        Some(lo)
    } else {
        None
    }
}

/// The gradient's pixels over `area` of the pixmap (`to_user` maps the
/// pixmap to user space) where `covered` (the size of `area`) is not
/// empty, at `alpha`; `None` if it paints nothing.
fn gradient_pixels(
    g: &CanvasGradient,
    to_user: &Affine,
    area: IRect,
    covered: &sk::Mask,
    alpha: f32,
) -> Option<sk::Pixmap> {
    if g.stops.is_empty() {
        return None;
    }
    match g.shape {
        // Canvas paints nothing along a gradient of no length...
        GradientShape::Linear { start, end } if start == end => return None,
        // ... or between two equal circles.
        GradientShape::Radial {
            start,
            start_radius,
            end,
            end_radius,
        } if start == end && start_radius == end_radius => {
            return None;
        }
        _ => {}
    }
    let table = gradient_table(g, alpha);
    let last = (GRADIENT_STEPS - 1) as f64;
    let mut pixmap = sk::Pixmap::new(area.width() as u32, area.height() as u32)?;
    let w = area.width() as usize;
    let byte = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    let pixels = pixmap.pixels_mut();
    let covered = covered.data();
    for y in 0..area.height() {
        let py = (area.y0 + y) as f64 + 0.5;
        for x in 0..area.width() {
            if covered[y as usize * w + x as usize] == 0 {
                continue;
            }
            let p = to_user.map(((area.x0 + x) as f64 + 0.5, py));
            let Some(t) = gradient_offset(&g.shape, p) else {
                continue;
            };
            let [r, g, b, a] = table[(t.clamp(0.0, 1.0) * last).round() as usize].map(byte);
            pixels[y as usize * w + x as usize] =
                sk::PremultipliedColorU8::from_rgba(r.min(a), g.min(a), b.min(a), a)
                    .unwrap_or(sk::PremultipliedColorU8::TRANSPARENT);
        }
    }
    Some(pixmap)
}

/// The color text painted with a gradient gets (glyphs take one color).
fn middle_color(g: &CanvasGradient) -> Color {
    match g.stops.len() {
        0 => Color::TRANSPARENT,
        n => g.stops[n / 2].1,
    }
}

// --- Geometry ----------------------------------------------------------------

/// A point.
type Pt = (f64, f64);

/// A 2D affine transform, canvas' matrix [a c e; b d f].
#[derive(Debug, Clone, Copy, PartialEq)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Affine {
    fn translate(x: f64, y: f64) -> Affine {
        Affine {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: x,
            f: y,
        }
    }

    fn scale(x: f64, y: f64) -> Affine {
        Affine {
            a: x,
            b: 0.0,
            c: 0.0,
            d: y,
            e: 0.0,
            f: 0.0,
        }
    }

    /// Clockwise in canvas' y-down coordinates.
    fn rotate(angle: f64) -> Affine {
        let (s, c) = angle.sin_cos();
        Affine {
            a: c,
            b: s,
            c: -s,
            d: c,
            e: 0.0,
            f: 0.0,
        }
    }

    /// `m` applied first, then `self` (canvas `transform(m)`).
    fn then(&self, m: &Affine) -> Affine {
        Affine {
            a: self.a * m.a + self.c * m.b,
            b: self.b * m.a + self.d * m.b,
            c: self.a * m.c + self.c * m.d,
            d: self.b * m.c + self.d * m.d,
            e: self.a * m.e + self.c * m.f + self.e,
            f: self.b * m.e + self.d * m.f + self.f,
        }
    }

    fn map(&self, (x, y): Pt) -> Pt {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    fn det(&self) -> f64 {
        self.a * self.d - self.b * self.c
    }

    /// The larger of the scales of its axes.
    fn scale_factor(&self) -> f64 {
        self.a.hypot(self.b).max(self.c.hypot(self.d))
    }

    /// The inverse; `None` if it is singular or not finite.
    fn invert(&self) -> Option<Affine> {
        let det = self.det();
        if !det.is_finite() || det.abs() < 1e-12 || !self.e.is_finite() || !self.f.is_finite() {
            return None;
        }
        Some(Affine {
            a: self.d / det,
            b: -self.b / det,
            c: -self.c / det,
            d: self.a / det,
            e: (self.c * self.f - self.d * self.e) / det,
            f: (self.b * self.e - self.a * self.f) / det,
        })
    }

    fn skia(&self) -> sk::Transform {
        sk::Transform::from_row(
            self.a as f32,
            self.b as f32,
            self.c as f32,
            self.d as f32,
            self.e as f32,
            self.f as f32,
        )
    }
}

/// A path segment, in pixmap coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Seg {
    Move(Pt),
    Line(Pt),
    Cubic(Pt, Pt, Pt),
    Close,
}

/// Canvas' current path: subpaths kept as they were added.
#[derive(Default)]
struct PathBuf {
    segments: Vec<Seg>,
    /// The current point (`None`: no subpath).
    current: Option<Pt>,
    /// Where the current subpath started.
    start: Pt,
}

impl PathBuf {
    fn clear(&mut self) {
        self.segments.clear();
        self.current = None;
    }

    fn move_to(&mut self, p: Pt) {
        self.segments.push(Seg::Move(p));
        self.current = Some(p);
        self.start = p;
    }

    /// Starts a subpath at `p` when there is none (curves start at their
    /// first control point, as canvas specifies).
    fn ensure(&mut self, p: Pt) {
        if self.current.is_none() {
            self.move_to(p);
        }
    }

    fn line_to(&mut self, p: Pt) {
        if self.current.is_none() {
            return self.move_to(p);
        }
        self.segments.push(Seg::Line(p));
        self.current = Some(p);
    }

    fn cubic_to(&mut self, c1: Pt, c2: Pt, p: Pt) {
        self.ensure(c1);
        self.segments.push(Seg::Cubic(c1, c2, p));
        self.current = Some(p);
    }

    /// Closes the subpath; the next one starts where it started.
    fn close(&mut self) {
        if self.current.is_some() {
            self.segments.push(Seg::Close);
            self.current = Some(self.start);
        }
    }

    /// An arc of the unit circle that `unit` maps into the pixmap, of
    /// `sweep` radians (negative: counterclockwise) from `start`, joined to
    /// the subpath by a line.
    fn arc(&mut self, unit: &Affine, start: f64, sweep: f64) {
        let p0 = unit.map((start.cos(), start.sin()));
        if self.current.is_some() {
            self.line_to(p0);
        } else {
            self.move_to(p0);
        }
        arc_cubics(start, sweep, |c1, c2, p| {
            self.cubic_to(unit.map(c1), unit.map(c2), unit.map(p));
        });
    }

    /// The path as tiny-skia's; `None` when it has nothing to paint.
    fn to_skia(&self) -> Option<sk::Path> {
        let n = self.segments.len();
        let mut b = sk::PathBuilder::with_capacity(n, n * 3);
        let f = |p: Pt| (p.0 as f32, p.1 as f32);
        // A segment after a close starts a subpath where the closed one
        // started.
        let mut start = (0.0, 0.0);
        let mut open = false;
        for seg in &self.segments {
            match *seg {
                Seg::Move(p) => {
                    start = f(p);
                    b.move_to(start.0, start.1);
                    open = true;
                }
                Seg::Line(p) => {
                    if !open {
                        b.move_to(start.0, start.1);
                        open = true;
                    }
                    let (x, y) = f(p);
                    b.line_to(x, y);
                }
                Seg::Cubic(c1, c2, p) => {
                    if !open {
                        b.move_to(start.0, start.1);
                        open = true;
                    }
                    let ((ax, ay), (bx, by), (x, y)) = (f(c1), f(c2), f(p));
                    b.cubic_to(ax, ay, bx, by, x, y);
                }
                Seg::Close => {
                    b.close();
                    open = false;
                }
            }
        }
        b.finish()
    }
}

/// The cubics of an arc of the unit circle of `sweep` radians from
/// `start`, at most a quarter turn each: `f(c1, c2, end)`.
fn arc_cubics(start: f64, sweep: f64, mut f: impl FnMut(Pt, Pt, Pt)) {
    if sweep == 0.0 || !sweep.is_finite() {
        return;
    }
    let n = (sweep.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let step = sweep / n as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let mut a0 = start;
    for _ in 0..n {
        let a1 = a0 + step;
        let (s0, c0) = a0.sin_cos();
        let (s1, c1) = a1.sin_cos();
        f(
            (c0 - k * s0, s0 + k * c0),
            (c1 + k * s1, s1 - k * c1),
            (c1, s1),
        );
        a0 = a1;
    }
}

/// The inner control points of the cubic equal to a quadratic curve.
fn quad_to_cubic(p0: Pt, c: Pt, p: Pt) -> [f64; 4] {
    [
        p0.0 + 2.0 / 3.0 * (c.0 - p0.0),
        p0.1 + 2.0 / 3.0 * (c.1 - p0.1),
        p.0 + 2.0 / 3.0 * (c.0 - p.0),
        p.1 + 2.0 / 3.0 * (c.1 - p.1),
    ]
}

/// The arc of `arcTo`.
#[derive(Debug, PartialEq)]
struct ArcTo {
    center: Pt,
    start: f64,
    sweep: f64,
}

/// The arc tangent to the lines `p0`–`p1` and `p1`–`p2` (canvas `arcTo`);
/// `None` when it degenerates to a line to `p1`.
fn arc_to_geometry(p0: Pt, p1: Pt, p2: Pt, r: f64) -> Option<ArcTo> {
    let (ux, uy) = (p0.0 - p1.0, p0.1 - p1.1);
    let (vx, vy) = (p2.0 - p1.0, p2.1 - p1.1);
    let (lu, lv) = (ux.hypot(uy), vx.hypot(vy));
    if r <= 0.0 || !r.is_finite() || lu < 1e-9 || lv < 1e-9 {
        return None;
    }
    let (ux, uy, vx, vy) = (ux / lu, uy / lu, vx / lv, vy / lv);
    if (ux * vy - uy * vx).abs() < 1e-9 {
        // Collinear.
        return None;
    }
    let half = (ux * vx + uy * vy).clamp(-1.0, 1.0).acos() / 2.0;
    // From p1 to the tangent points, and to the center along the bisector.
    let tangent = r / half.tan();
    let (bx, by) = (ux + vx, uy + vy);
    let lb = bx.hypot(by);
    let to_center = r / half.sin();
    let center = (p1.0 + bx / lb * to_center, p1.1 + by / lb * to_center);
    let t1 = (p1.0 + ux * tangent, p1.1 + uy * tangent);
    let t2 = (p1.0 + vx * tangent, p1.1 + vy * tangent);
    let start = (t1.1 - center.1).atan2(t1.0 - center.0);
    let end = (t2.1 - center.1).atan2(t2.0 - center.0);
    // The short way round: the arc between the tangent points is under a
    // half turn.
    let mut sweep = end - start;
    if sweep > PI {
        sweep -= TAU;
    } else if sweep < -PI {
        sweep += TAU;
    }
    Some(ArcTo {
        center,
        start,
        sweep,
    })
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::percentage;

    use super::*;

    fn pt(x: f32, y: f32) -> nsh_core::Point<Points> {
        nsh_core::geometry::point(Points(x), Points(y))
    }

    fn close(a: Pt, b: Pt) -> bool {
        (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
    }

    const IDENTITY: Affine = Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn c(v: f32) -> Num {
        Num::Const(v)
    }

    fn rect(x: f32, y: f32, w: f32, h: f32) -> [Num; 4] {
        [c(x), c(y), c(w), c(h)]
    }

    const RED: Color = Color(0xff0000ff);
    const BLUE: Color = Color(0x0000ffff);

    /// `ops` rasterized on a `w` × `h` canvas at `scale` device pixels per
    /// point (no text system: text draws no glyphs).
    fn raster(ops: Vec<CanvasOp>, scale: f32, w: f32, h: f32) -> Recorded {
        let system = Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new())));
        let text = WindowTextSystem::new(system.clone());
        let key = Key {
            linear: [scale, 0.0, 0.0, scale],
            scale,
            size: (w, h),
        };
        let (region, _) = region(&key, (0.0, 0.0), [0.0, 0.0, w * scale, h * scale]).unwrap();
        let drawing = Drawing {
            ops,
            ..Drawing::default()
        };
        record(
            &drawing,
            &[],
            &FxHashMap::default(),
            (&text, &system),
            key,
            region,
            (0.0, 0.0),
        )
    }

    /// The only pixmap of `r`.
    fn pixels(r: &Recorded) -> &sk::Pixmap {
        match r.layers.as_slice() {
            [Layer::Pixels(p, _)] => p,
            _ => panic!("{} layers", r.layers.len()),
        }
    }

    /// The pixel at `(x, y)` as straight RGBA.
    fn at(p: &sk::Pixmap, x: u32, y: u32) -> [u8; 4] {
        let c = p.pixel(x, y).unwrap().demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    }

    fn slot(k: u16) -> Num {
        Num::Slot(k)
    }

    #[test]
    fn tiles_cover_the_pixmap_once() {
        let t = tiles(600, 300);
        assert_eq!(t.len(), 6);
        let area: i32 = t.iter().map(|t| t.rect.width() * t.rect.height()).sum();
        assert_eq!(area, 600 * 300);
        assert_eq!(
            t[2].rect,
            IRect {
                x0: 512,
                y0: 0,
                x1: 600,
                y1: 256
            }
        );
    }

    #[test]
    fn a_patch_paints_what_a_full_replay_paints() {
        // A background, a dot moved by animated value 0 and text above, at
        // two device pixels per point.
        let ops = vec![
            CanvasOp::FillStyle(Paint::Color(BLUE)),
            CanvasOp::FillRect(rect(0.0, 0.0, 200.0, 100.0)),
            CanvasOp::FillStyle(Paint::Color(RED)),
            CanvasOp::FillRect([slot(0), c(40.0), c(10.0), c(10.0)]),
        ];
        let drawing = Drawing {
            ops,
            ..Drawing::default()
        };
        let system = Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new())));
        let text = WindowTextSystem::new(system.clone());
        let key = Key {
            linear: [2.0, 0.0, 0.0, 2.0],
            scale: 2.0,
            size: (200.0, 100.0),
        };
        let (region, _) = region(&key, (0.0, 0.0), [0.0, 0.0, 400.0, 200.0]).unwrap();
        let args = |x: f32| vec![Some(AnimationValue::Number(x))];
        let images = FxHashMap::default();
        let mut patched = record(
            &drawing,
            &args(20.0),
            &images,
            (&text, &system),
            key,
            region,
            (0.0, 0.0),
        );
        let changed = |s: u16| s == 0;
        let mut scan = DamageScan::default();
        let damage = scan
            .damage(&drawing.ops, |_| 20.0, changed)
            .union(scan.damage(&drawing.ops, |_| 120.0, changed));
        let Damage::Rect(r) = damage else {
            panic!("{damage:?}");
        };
        assert!(patch(
            &mut patched,
            &drawing,
            &args(120.0),
            &images,
            (&text, &system),
            r
        ));
        let full = record(
            &drawing,
            &args(120.0),
            &images,
            (&text, &system),
            key,
            region,
            (0.0, 0.0),
        );
        assert_eq!(pixels(&patched).data(), pixels(&full).data());
        // The dot left its old place.
        assert_eq!(at(pixels(&patched), 50, 90), [0, 0, 255, 255]);
        assert_eq!(at(pixels(&patched), 250, 90), [255, 0, 0, 255]);
    }

    #[test]
    fn a_patch_blurs_shadows_from_their_whole_shape() {
        // A card casting a blurred shadow, half inside the area a moving dot
        // damages: its shadow there is blurred from all of the card.
        let ops = vec![
            CanvasOp::FillStyle(Paint::Color(Color(0xffff_ffff))),
            CanvasOp::FillRect(rect(0.0, 0.0, 200.0, 100.0)),
            CanvasOp::Save,
            CanvasOp::ShadowColor(BLUE),
            CanvasOp::ShadowBlur(Points(16.0)),
            CanvasOp::ShadowOffset(pt(4.0, 4.0)),
            CanvasOp::FillStyle(Paint::Color(RED)),
            CanvasOp::FillRect(rect(75.0, 30.0, 60.0, 40.0)),
            CanvasOp::Restore,
            CanvasOp::FillStyle(Paint::Color(BLUE)),
            CanvasOp::FillRect([slot(0), c(10.0), c(10.0), c(10.0)]),
        ];
        let drawing = Drawing {
            ops,
            ..Drawing::default()
        };
        let system = Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new())));
        let text = WindowTextSystem::new(system.clone());
        let key = Key {
            linear: [2.0, 0.0, 0.0, 2.0],
            scale: 2.0,
            size: (200.0, 100.0),
        };
        let (region, _) = region(&key, (0.0, 0.0), [0.0, 0.0, 400.0, 200.0]).unwrap();
        let args = |x: f32| vec![Some(AnimationValue::Number(x))];
        let images = FxHashMap::default();
        let mut patched = record(
            &drawing,
            &args(60.0),
            &images,
            (&text, &system),
            key,
            region,
            (0.0, 0.0),
        );
        // The damage, as the scan bounds it, reaches into the card.
        let damage = crate::geom::rect(55.0, 5.0, 40.0, 90.0);
        assert!(patch(
            &mut patched,
            &drawing,
            &args(70.0),
            &images,
            (&text, &system),
            damage,
        ));
        let full = record(
            &drawing,
            &args(70.0),
            &images,
            (&text, &system),
            key,
            region,
            (0.0, 0.0),
        );
        assert_eq!(pixels(&patched).data(), pixels(&full).data());
    }

    #[test]
    fn culled_gradients_still_paint() {
        // A gradient fill wholly outside the pixmap paints nothing but
        // still counts as painting: the pixmap is kept, as where the fill
        // shows, so a partial redraw has the layers of a full one.
        let g = CanvasGradient::linear(pt(0.0, 0.0), pt(10.0, 0.0))
            .add_color_stop(percentage(0.0), RED)
            .add_color_stop(percentage(1.0), BLUE);
        let ops = vec![
            CanvasOp::FillStyle(Paint::Gradient(Arc::new(g))),
            CanvasOp::FillRect(rect(500.0, 500.0, 10.0, 10.0)),
        ];
        let r = raster(ops, 1.0, 50.0, 50.0);
        assert_eq!(at(pixels(&r), 5, 5), [0, 0, 0, 0]);
    }

    #[test]
    fn transforms_compose_like_canvas() {
        // translate then scale: points scale first.
        let m = Affine::translate(10.0, 20.0).then(&Affine::scale(2.0, 3.0));
        assert_eq!(m.map((1.0, 1.0)), (12.0, 23.0));
        // rotate a quarter turn clockwise (y down).
        let r = Affine::rotate(std::f64::consts::FRAC_PI_2);
        assert!(close(r.map((1.0, 0.0)), (0.0, 1.0)));
        let inv = m.then(&r).invert().unwrap();
        assert!(close(inv.map(m.then(&r).map((3.0, -4.0))), (3.0, -4.0)));
        assert_eq!(Affine::scale(0.0, 1.0).invert(), None);
        assert_eq!(m.det(), 6.0);
        assert_eq!(m.scale_factor(), 3.0);
        // tiny-skia maps points as the matrix does.
        let mut p = [sk::Point::from_xy(1.0, 1.0)];
        m.skia().map_points(&mut p);
        assert_eq!((p[0].x, p[0].y), (12.0, 23.0));
        assert_eq!(IDENTITY.then(&m), m);
    }

    #[test]
    fn arc_to_rounds_a_right_angle() {
        // Along y = 0 to the corner (10, 0), then down.
        let a = arc_to_geometry((0.0, 0.0), (10.0, 0.0), (10.0, 10.0), 2.0).unwrap();
        assert!(close(a.center, (8.0, 2.0)));
        // From straight above the center, a quarter turn clockwise.
        assert!((a.start + std::f64::consts::FRAC_PI_2).abs() < 1e-9);
        assert!((a.sweep - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
        // Collinear points and zero radii are lines.
        assert_eq!(
            arc_to_geometry((0.0, 0.0), (5.0, 0.0), (10.0, 0.0), 2.0),
            None
        );
        assert_eq!(
            arc_to_geometry((0.0, 0.0), (5.0, 0.0), (5.0, 5.0), 0.0),
            None
        );
    }

    #[test]
    fn quads_become_cubics() {
        let c = quad_to_cubic((0.0, 0.0), (3.0, 3.0), (6.0, 0.0));
        assert_eq!(c, [2.0, 2.0, 4.0, 2.0]);
    }

    #[test]
    fn arcs_are_quarter_turn_cubics_on_the_circle() {
        let mut ends = Vec::new();
        arc_cubics(0.0, PI, |c1, _, p| ends.push((c1, p)));
        assert_eq!(ends.len(), 2);
        assert!(close(ends[0].1, (0.0, 1.0)));
        assert!(close(ends[1].1, (-1.0, 0.0)));
        // The first control point is tangent to the circle at the start.
        assert!(ends[0].0.0 > 0.99 && ends[0].0.1 > 0.5);
        // Counterclockwise sweeps go the other way.
        let mut ends = Vec::new();
        arc_cubics(0.0, -std::f64::consts::FRAC_PI_2, |_, _, p| ends.push(p));
        assert_eq!(ends.len(), 1);
        assert!(close(ends[0], (0.0, -1.0)));
        // The midpoint of a quarter cubic is within 0.03% of the radius.
        let mut mid = None;
        arc_cubics(0.0, std::f64::consts::FRAC_PI_2, |c1, c2, p| {
            let m = (
                0.125 + 0.375 * c1.0 + 0.375 * c2.0 + 0.125 * p.0,
                0.375 * c1.1 + 0.375 * c2.1 + 0.125 * p.1,
            );
            mid = Some(m);
        });
        let m = mid.unwrap();
        assert!((m.0.hypot(m.1) - 1.0).abs() < 3e-4);
        let mut none = 0;
        arc_cubics(1.0, 0.0, |_, _, _| none += 1);
        assert_eq!(none, 0);
    }

    #[test]
    fn paths_follow_canvas_rules() {
        let mut p = PathBuf::default();
        assert!(p.to_skia().is_none());
        // A line without a subpath starts one.
        p.line_to((1.0, 1.0));
        assert_eq!(p.segments, vec![Seg::Move((1.0, 1.0))]);
        p.line_to((2.0, 1.0));
        p.close();
        // After closing, the current point is the subpath's start.
        assert_eq!(p.current, Some((1.0, 1.0)));
        // An arc joins the subpath with a line to its start.
        let unit = Affine::translate(10.0, 0.0).then(&Affine::scale(5.0, 5.0));
        p.arc(&unit, 0.0, std::f64::consts::FRAC_PI_2);
        assert_eq!(p.segments[3], Seg::Line((15.0, 0.0)));
        match p.segments[4] {
            Seg::Cubic(_, _, end) => assert!(close(end, (10.0, 5.0))),
            s => panic!("{s:?}"),
        }
        // As tiny-skia's: the segment after the close starts a subpath at
        // (1, 1).
        let path = p.to_skia().unwrap();
        let points = path.points();
        assert_eq!((points[2].x, points[2].y), (1.0, 1.0));
        assert_eq!((points[3].x, points[3].y), (15.0, 0.0));
        p.clear();
        assert!(p.segments.is_empty() && p.current.is_none());
        // Curves start at their first control point.
        p.cubic_to((3.0, 3.0), (4.0, 4.0), (5.0, 5.0));
        assert_eq!(p.segments[0], Seg::Move((3.0, 3.0)));
    }

    #[test]
    fn regions_cover_what_shows() {
        let key = Key {
            linear: [2.0, 0.0, 0.0, 2.0],
            scale: 2.0,
            size: (100.0, 50.0),
        };
        // A small canvas is rasterized whole, from the pixel its origin
        // falls in.
        let (r, shown) = region(&key, (0.5, 0.25), [-1e4, -1e4, 1e4, 1e4]).unwrap();
        assert_eq!(
            r,
            IRect {
                x0: 0,
                y0: 0,
                x1: 201,
                y1: 101
            }
        );
        assert_eq!(shown, r);
        let (r, shown) = region(&key, (0.0, 0.0), [10.0, 10.0, 20.0, 20.0]).unwrap();
        assert_eq!(
            r,
            IRect {
                x0: 0,
                y0: 0,
                x1: 200,
                y1: 100
            }
        );
        assert_eq!(
            shown,
            IRect {
                x0: 10,
                y0: 10,
                x1: 20,
                y1: 20
            }
        );
        // Nothing shows outside the clip.
        assert!(region(&key, (0.0, 0.0), [300.0, 0.0, 400.0, 10.0]).is_none());
        // A rotated canvas covers its bounds.
        let turned = Key {
            linear: [0.0, 1.0, -1.0, 0.0],
            ..key
        };
        let (r, _) = region(&turned, (0.0, 0.0), [-1e4, -1e4, 1e4, 1e4]).unwrap();
        assert_eq!(
            r,
            IRect {
                x0: -50,
                y0: 0,
                x1: 0,
                y1: 100
            }
        );
        // A huge one only around what shows.
        let tall = Key {
            size: (100.0, 20000.0),
            ..key
        };
        let (r, shown) = region(&tall, (0.0, 0.0), [0.0, 10000.0, 200.0, 11000.0]).unwrap();
        assert_eq!(
            r,
            IRect {
                x0: 0,
                y0: 10000 - MARGIN,
                x1: 200,
                y1: 11000 + MARGIN
            }
        );
        assert!(r.contains(&shown));
    }

    #[test]
    fn dashes_repeat_odd_lists() {
        assert_eq!(dash_pattern(&[], 0.0), None);
        assert_eq!(dash_pattern(&[Points(0.0), Points(0.0)], 0.0), None);
        assert_eq!(dash_pattern(&[Points(4.0), Points(-1.0)], 0.0), None);
        assert_eq!(
            dash_pattern(&[Points(4.0), Points(2.0)], 3.0),
            Some((vec![4.0, 2.0], 3.0))
        );
        assert_eq!(
            dash_pattern(&[Points(5.0), Points(3.0), Points(2.0)], 0.0),
            Some((vec![5.0, 3.0, 2.0, 5.0, 3.0, 2.0], 0.0))
        );
    }

    #[test]
    fn gradients_are_exact() {
        let linear = GradientShape::Linear {
            start: pt(0.0, 0.0),
            end: pt(10.0, 0.0),
        };
        assert_eq!(gradient_offset(&linear, (5.0, 7.0)), Some(0.5));
        assert_eq!(gradient_offset(&linear, (-5.0, 0.0)), Some(-0.5));
        // Concentric circles: t runs from the inner to the outer one.
        let rings = [0.0, 0.0, 10.0, 0.0, 0.0, 20.0];
        assert_eq!(radial_offset(rings, (15.0, 0.0)), Some(0.5));
        assert_eq!(radial_offset(rings, (0.0, 20.0)), Some(1.0));
        // From a point to a circle: t is the distance over the radius.
        let cone = [0.0, 0.0, 0.0, 0.0, 0.0, 40.0];
        assert_eq!(radial_offset(cone, (0.0, 10.0)), Some(0.25));
        // Outside the cone of two circles side by side, nothing is
        // painted.
        let side = [0.0, 0.0, 5.0, 100.0, 0.0, 5.0];
        assert_eq!(radial_offset(side, (50.0, 50.0)), None);
        assert!(radial_offset(side, (50.0, 2.0)).is_some());
        let conic = GradientShape::Conic {
            start_angle: Radians(0.0),
            center: pt(0.0, 0.0),
        };
        let t = gradient_offset(&conic, (0.0, 5.0)).unwrap();
        assert!((t - 0.25).abs() < 1e-9);
        let t = gradient_offset(&conic, (0.0, -5.0)).unwrap();
        assert!((t - 0.75).abs() < 1e-9);
    }

    #[test]
    fn gradient_stops_interpolate_premultiplied() {
        let g = CanvasGradient::linear(pt(0.0, 0.0), pt(1.0, 0.0))
            .add_color_stop(percentage(0.0), RED)
            .add_color_stop(percentage(1.0), Color::TRANSPARENT);
        let table = gradient_table(&g, 1.0);
        let mid = table[GRADIENT_STEPS / 2];
        // Red fading out, not darkening: premultiplied, the red stays the
        // alpha.
        assert!((mid[0] - mid[3]).abs() < 1e-6 && (mid[3] - 0.5).abs() < 0.01);
        assert_eq!(table[0], [1.0, 0.0, 0.0, 1.0]);
        // Hard stops stay hard.
        let g = CanvasGradient::linear(pt(0.0, 0.0), pt(1.0, 0.0))
            .add_color_stop(percentage(0.0), RED)
            .add_color_stop(percentage(0.5), RED)
            .add_color_stop(percentage(0.5), BLUE)
            .add_color_stop(percentage(1.0), BLUE);
        let table = gradient_table(&g, 0.5);
        assert_eq!(table[GRADIENT_STEPS / 2 - 2], [0.5, 0.0, 0.0, 0.5]);
        assert_eq!(table[GRADIENT_STEPS / 2 + 1], [0.0, 0.0, 0.5, 0.5]);
        assert_eq!(middle_color(&g), BLUE);
    }

    #[test]
    fn blurs_spread_and_keep_the_mass() {
        let sizes = box_sizes(4.0);
        // Three boxes of a Gaussian's variance: 3 × (n² − 1) / 12 ≈ σ².
        let variance: f64 = sizes.iter().map(|&n| ((n * n - 1) as f64) / 12.0).sum();
        assert!((variance - 16.0).abs() < 3.0, "{sizes:?}");
        let (w, h) = (41, 41);
        let mut alpha = vec![0u8; w * h];
        for y in 18..23 {
            for x in 18..23 {
                alpha[y * w + x] = 255;
            }
        }
        let before: u32 = alpha.iter().map(|&a| a as u32).sum();
        blur(&mut alpha, w, h, 3.0);
        let after: u32 = alpha.iter().map(|&a| a as u32).sum();
        assert!((after as f64 / before as f64 - 1.0).abs() < 0.05);
        assert!(alpha[20 * w + 20] < 255 && alpha[20 * w + 28] > 0);
        assert_eq!(alpha[0], 0);
    }

    #[test]
    fn fills_land_on_device_pixels() {
        let r = raster(
            vec![
                CanvasOp::FillStyle(Paint::Color(RED)),
                CanvasOp::FillRect(rect(10.0, 10.0, 20.0, 20.0)),
            ],
            2.0,
            50.0,
            50.0,
        );
        let p = pixels(&r);
        assert_eq!((p.width(), p.height()), (100, 100));
        assert_eq!(at(p, 30, 30), [255, 0, 0, 255]);
        assert_eq!(at(p, 19, 30)[3], 0);
        assert_eq!(at(p, 20, 20), [255, 0, 0, 255]);
        assert_eq!(at(p, 60, 60)[3], 0);
    }

    #[test]
    fn strokes_follow_the_transform() {
        // A line 2 wide, scaled 3× across: 6 points thick, 1 along.
        let r = raster(
            vec![
                CanvasOp::Scale(c(1.0), c(3.0)),
                CanvasOp::LineWidth(c(2.0)),
                CanvasOp::StrokeStyle(Paint::Color(BLUE)),
                CanvasOp::Path(PathOp::MoveTo(c(0.0), c(10.0))),
                CanvasOp::Path(PathOp::LineTo(c(40.0), c(10.0))),
                CanvasOp::Stroke(None),
            ],
            1.0,
            40.0,
            40.0,
        );
        let p = pixels(&r);
        assert_eq!(at(p, 20, 28), [0, 0, 255, 255]);
        assert_eq!(at(p, 20, 32), [0, 0, 255, 255]);
        assert_eq!(at(p, 20, 26)[3], 0);
        assert_eq!(at(p, 20, 34)[3], 0);
    }

    #[test]
    fn clips_and_composites_follow_canvas() {
        let r = raster(
            vec![
                CanvasOp::Save,
                CanvasOp::Path(PathOp::Rect(rect(0.0, 0.0, 10.0, 40.0))),
                CanvasOp::Clip(None, FillRule::NonZero),
                CanvasOp::FillStyle(Paint::Color(RED)),
                CanvasOp::FillRect(rect(0.0, 0.0, 40.0, 40.0)),
                CanvasOp::Restore,
                // `copy` clears what the shape does not cover.
                CanvasOp::FillStyle(Paint::Color(BLUE)),
                CanvasOp::Composite(Composite::Copy),
                CanvasOp::FillRect(rect(20.0, 0.0, 10.0, 10.0)),
            ],
            1.0,
            40.0,
            40.0,
        );
        let p = pixels(&r);
        assert_eq!(at(p, 5, 20)[3], 0);
        assert_eq!(at(p, 25, 5), [0, 0, 255, 255]);
        let r = raster(
            vec![
                CanvasOp::FillStyle(Paint::Color(RED)),
                CanvasOp::FillRect(rect(0.0, 0.0, 40.0, 40.0)),
                CanvasOp::Composite(Composite::DestinationOut),
                CanvasOp::FillRect(rect(0.0, 0.0, 20.0, 40.0)),
                CanvasOp::Composite(Composite::SourceOver),
                CanvasOp::ClearRect(rect(30.0, 0.0, 10.0, 10.0)),
            ],
            1.0,
            40.0,
            40.0,
        );
        let p = pixels(&r);
        assert_eq!(at(p, 10, 20)[3], 0);
        assert_eq!(at(p, 25, 20), [255, 0, 0, 255]);
        assert_eq!(at(p, 35, 5)[3], 0);
        assert_eq!(at(p, 35, 20), [255, 0, 0, 255]);
    }

    #[test]
    fn huge_shapes_and_blurs_stay_bounded() {
        for blur in [10.0, 1.0e9] {
            let r = raster(
                vec![
                    CanvasOp::ShadowColor(BLUE),
                    CanvasOp::ShadowBlur(Points(blur)),
                    CanvasOp::ShadowOffset(pt(3.0, 3.0)),
                    CanvasOp::FillStyle(Paint::Color(RED)),
                    CanvasOp::FillRect(rect(0.0, 0.0, 1.0e6, 1.0e6)),
                    CanvasOp::FillRect(rect(-1.0e12, -1.0e12, 2.0e12, 2.0e12)),
                ],
                2.0,
                50.0,
                50.0,
            );
            assert_eq!(at(pixels(&r), 50, 50), [255, 0, 0, 255]);
        }
        let layer = IRect {
            x0: 0,
            y0: 0,
            x1: 100,
            y1: 100,
        };
        let far = sk::Rect::from_ltrb(-1.0e9, -1.0e9, 1.0e9, 1.0e9).unwrap();
        let area = shadow_area(far, layer, 10.0).unwrap();
        assert_eq!(
            area,
            IRect {
                x0: -30,
                y0: -30,
                x1: 130,
                y1: 130
            }
        );
        assert_eq!(
            pixels_within([-1e30, 5.0, f32::INFINITY, 7.5], (10, 10)),
            Some(IRect {
                x0: 0,
                y0: 5,
                x1: 10,
                y1: 8
            })
        );
    }

    #[test]
    fn shadows_fall_offset_under_the_shape() {
        let r = raster(
            vec![
                CanvasOp::ShadowColor(BLUE),
                CanvasOp::ShadowOffset(pt(10.0, 0.0)),
                CanvasOp::FillStyle(Paint::Color(RED)),
                CanvasOp::FillRect(rect(5.0, 5.0, 10.0, 10.0)),
            ],
            2.0,
            40.0,
            40.0,
        );
        let p = pixels(&r);
        // The shape over its shadow, the shadow 10 points (20 pixels)
        // right.
        assert_eq!(at(p, 25, 20), [255, 0, 0, 255]);
        assert_eq!(at(p, 45, 20), [0, 0, 255, 255]);
        assert_eq!(at(p, 20, 45)[3], 0);
    }

    #[test]
    fn shapes_over_text_go_above_it() {
        let system = Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new())));
        let text = WindowTextSystem::new(system.clone());
        let images = FxHashMap::default();
        let base = Affine::scale(1.0, 1.0);
        let mut replay = Replay {
            args: &[],
            images: &images,
            text: &text,
            system: &system,
            size: (40, 40),
            base,
            scale: 1.0,
            state: State::new(base),
            stack: Vec::new(),
            path: PathBuf::default(),
            layers: Vec::new(),
            pixmap: sk::Pixmap::new(40, 40),
            drawn: false,
            pending: Vec::new(),
            pending_bounds: None,
        };
        replay.op(&CanvasOp::FillRect(rect(0.0, 0.0, 10.0, 10.0)));
        // Text at (20, 20)–(30, 30).
        replay.pending.push(GlyphRun {
            glyphs: Vec::new(),
            size: 10.0,
            color: gpui::black(),
            clip: None,
        });
        replay.pending_bounds = sk::Rect::from_ltrb(20.0, 20.0, 30.0, 30.0);
        // Beside the text: the same pixmap.
        replay.op(&CanvasOp::FillRect(rect(0.0, 20.0, 10.0, 10.0)));
        assert!(replay.layers.is_empty());
        // Over it: a new one above.
        replay.op(&CanvasOp::FillRect(rect(25.0, 25.0, 10.0, 10.0)));
        replay.flush();
        let kinds: Vec<_> = replay
            .layers
            .iter()
            .map(|l| matches!(l, Layer::Text(_)))
            .collect();
        assert_eq!(kinds, [false, true, false]);
    }

    #[test]
    fn glyph_outlines_come_from_the_font_file() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../examples/gallery/fonts/Pacifico-Regular.ttf"
        );
        let data: Arc<[u8]> = std::fs::read(path).unwrap().into();
        let face = ttf_parser::Face::parse(&data, 0).unwrap();
        let file = FontFile {
            units_per_em: face.units_per_em(),
            data: data.clone(),
            index: 0,
            glyphs: Default::default(),
        };
        let a = face.glyph_index('a').unwrap().0;
        let space = face.glyph_index(' ').unwrap().0;
        // 20 points high, flipped to y down, at (10, 30).
        let k = 20.0 / file.units_per_em as f64;
        let to = Affine::translate(10.0, 30.0).then(&Affine::scale(k, -k));
        let mut path = sk::PathBuilder::new();
        assert!(file.push_glyph(a, &to, &mut path));
        // A space is outlined as nothing.
        assert!(file.push_glyph(space, &to, &mut path));
        let b = path.finish().unwrap().bounds();
        assert!(b.left() >= 9.0 && b.right() < 30.0, "{b:?}");
        assert!(b.bottom() <= 31.0 && b.top() > 10.0, "{b:?}");
        assert_eq!(file.glyphs.lock().unwrap().len(), 2);
    }

    #[test]
    fn uploads_are_straight_bgra() {
        let mut p = sk::Pixmap::new(2, 1).unwrap();
        p.pixels_mut()[0] = sk::ColorU8::from_rgba(255, 128, 0, 128).premultiply();
        let all = IRect {
            x0: 0,
            y0: 0,
            x1: 2,
            y1: 1,
        };
        let image = upload(&p, all, 0.5).unwrap();
        let bytes = image.as_bytes(0).unwrap();
        assert_eq!(&bytes[..3], &[0, 128, 255]);
        assert_eq!(bytes[3], 64);
        assert_eq!(&bytes[4..], &[0; 4]);
        let empty = IRect {
            x0: 0,
            y0: 0,
            x1: 2,
            y1: 2,
        };
        assert!(upload(&sk::Pixmap::new(2, 2).unwrap(), empty, 1.0).is_none());
        // A tile: its own pixels only.
        let tile = IRect {
            x0: 1,
            y0: 0,
            x1: 2,
            y1: 1,
        };
        assert!(upload(&p, tile, 1.0).is_none());
        // GPUI's pixels come back premultiplied.
        let p = premultiplied(1, 1, &[0, 0, 255, 128]).unwrap();
        assert_eq!(at(&p, 0, 0)[0], 255);
        assert_eq!(p.pixel(0, 0).unwrap().red(), 128);
    }

    #[test]
    fn a_canvas_changing_on_every_frame_keeps_one_job_in_flight() {
        let mut canvas = CanvasState::default();
        assert_eq!(canvas.ask(), Some(0));
        // Changed on every frame while a worker makes it: nothing more is
        // queued behind it.
        for _ in 0..10 {
            canvas.stale();
            assert_eq!(canvas.ask(), None);
        }
        // Once it lands, the latest is asked for.
        canvas.landed(0);
        assert_eq!(canvas.ask(), Some(10));
        // A rasterization that lands late frees nothing.
        canvas.landed(3);
        assert_eq!(canvas.ask(), None);
    }
}
