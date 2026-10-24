//! Canvas views: a recorded [`Drawing`] replayed with Cairo.
//!
//! Cairo's model is close to canvas: the current path is kept in device
//! space as it is built (later transforms do not move it), strokes use the
//! transform current when they are made, and `save` / `restore` cover the
//! transform and the clip. So the replay uses Cairo's own transform and
//! path; it keeps only canvas' paint state (styles, alpha, shadow, font)
//! itself. Fills, strokes and clips keep the path (`*_preserve`), as canvas
//! does; operations that draw without it (`fillRect`, text, images) set
//! the current path aside, and it is put back when an operation uses it.
//!
//! The drawing is rasterized into an image surface at the display's scale,
//! kept with its texture ([`Raster`]): a frame in which the canvas did not
//! change appends the same texture, which GSK keeps on the GPU, and only a
//! new drawing, size or scale replays it whole. An animation of its value
//! slots redraws only what the operations reading the changed slots cover,
//! where they were and where they are now ([`DamageScan`]): the area is
//! cleared and the drawing replayed clipped to it. What comes before the
//! first operation reading a slot paints the same every time
//! ([`first_animated`]): its pixels are kept from the last full replay
//! ([`Raster::prefix`]), copied back into the area, and only the operations
//! from there on paint (the ones before it still set the state).
//!
//! A canvas out of sight (outside a clipping ancestor or the window) is not
//! drawn: what changed waits, its animations stop asking for frames, and
//! every frame after layout draws those that came into sight ([`reveal`]).
//!
//! Composite operations combine within the canvas' own bitmap. Shadows are
//! rendered into an
//! alpha mask at the display's scale, blurred with three box blurs (an
//! approximation of the Gaussian canvas specifies) and painted through the
//! shadow color. Conic gradients are mesh patterns of thin wedges.
//!
//! Text is laid out with Pango (layouts cached per canvas). Images are
//! loaded through [`crate::image::load_bitmap`] when a drawing names them,
//! kept as Cairo surfaces per canvas and drawn once loaded. Animated value slots
//! ([`CanvasState::args`]) are read while replaying: an animation only
//! queues a redraw, without JS.

use std::{
    cell::{Cell, RefCell},
    f64::consts::TAU,
    rc::Rc,
    sync::Arc,
};

use gtk4::{self as gtk, cairo, gdk, glib, graphene, prelude::*};
use nsh_core::{
    Color,
    animation::AnimationValue,
    canvas::{
        CanvasFont, CanvasGradient, CanvasOp, CanvasTextAlign, CanvasTextBaseline, Composite,
        Damage, DamageScan, Drawing, FillRule, GradientShape, LineCap, LineJoin, Num, Paint,
        PathOp, arc_sweep, first_animated, fit_radii, prefix_path_needed,
    },
    geometry::{Corners, Points, Radians, size},
};
use rustc_hash::FxHashMap;

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

/// Layouts kept per canvas before the cache is emptied.
const MAX_LAYOUTS: usize = 256;
/// The largest side of a shadow mask, in pixels.
const MAX_SHADOW_SIZE: f64 = 4096.0;

/// What a canvas draws.
pub(crate) struct CanvasState {
    /// The drawing.
    pub(crate) drawing: Option<Arc<Drawing>>,
    /// Animated value slots (`AnimationProp::CanvasArg`).
    pub(crate) args: Vec<Option<AnimationValue>>,
    /// The images the drawing names, by URI: `None` while loading (or
    /// when they failed to load).
    images: FxHashMap<Arc<str>, Option<cairo::ImageSurface>>,
    /// Pango layouts of `fillText` / `strokeText`.
    text: RefCell<TextCache>,
    /// The drawing rasterized, and what of it must be drawn again.
    raster: RefCell<Option<Raster>>,
    /// The first operation reading an animated slot ([`first_animated`]),
    /// and whether the path the operations before it build is needed from
    /// it on ([`prefix_path_needed`]).
    split: usize,
    split_path: bool,
    dirty: Cell<Damage>,
    /// Out of sight with something to draw ([`reveal`]).
    hidden: Cell<bool>,
    /// Finds what animated slots paint, and the slots that changed (reused).
    scan: DamageScan,
    changed: Vec<u16>,
}

impl Default for CanvasState {
    fn default() -> Self {
        CanvasState {
            drawing: None,
            args: Vec::new(),
            images: FxHashMap::default(),
            text: RefCell::default(),
            raster: RefCell::new(None),
            split: 0,
            split_path: true,
            dirty: Cell::new(Damage::All),
            hidden: Cell::new(false),
            scan: DamageScan::default(),
            changed: Vec::new(),
        }
    }
}

/// A canvas' pixels: the surface it is drawn into, at the display's scale,
/// and the texture it is shown with.
struct Raster {
    surface: cairo::ImageSurface,
    scale: f64,
    /// The surface's pixels in tiles of [`TILE`] pixels, row by row: a
    /// partial redraw makes the textures of the tiles it touches again,
    /// and GSK keeps the others on the GPU.
    tiles: Vec<gdk::Texture>,
    /// What the operations before the first one reading a slot painted,
    /// when some do and some do not.
    prefix: Option<cairo::ImageSurface>,
}

thread_local! {
    /// Canvases out of sight with something to draw ([`reveal`]).
    static HIDDEN: RefCell<Vec<glib::WeakRef<NshView>>> = RefCell::default();
}

/// Draws the canvases that came into sight (called every frame, after
/// layout): those still out of sight wait.
pub(crate) fn reveal() {
    let shown: Vec<NshView> = HIDDEN.with(|h| {
        let mut shown = Vec::new();
        h.borrow_mut().retain(|weak| {
            let Some(view) = weak.upgrade() else {
                return false;
            };
            if !view.is_mapped() || !in_sight(&view) {
                return true;
            }
            shown.push(view);
            false
        });
        shown
    });
    for view in shown {
        if let Some(c) = view.state().canvas.as_ref() {
            c.hidden.set(false);
        }
        view.changed();
    }
}

/// Whether some of `view` may show: false only when it lies wholly
/// outside a clipping ancestor (a scroll view, `overflow: hidden`) or the
/// window.
fn in_sight(view: &NshView) -> bool {
    let mut widget = view.parent();
    while let Some(ancestor) = widget {
        widget = ancestor.parent();
        let Some(a) = ancestor.downcast_ref::<NshView>() else {
            continue;
        };
        // The root's bounds are the window's.
        let root = widget.as_ref().is_none_or(|p| !p.is::<NshView>());
        if !(root || a.state().clips()) {
            continue;
        }
        let Some(b) = view.compute_bounds(a) else {
            return true;
        };
        let (w, h) = (a.width() as f32, a.height() as f32);
        if b.x() >= w || b.y() >= h || b.x() + b.width() <= 0.0 || b.y() + b.height() <= 0.0 {
            return false;
        }
    }
    true
}

/// The side of a canvas' tiles, in pixels.
const TILE: i32 = 256;

/// The tiles of a surface `pw` × `ph` pixels: their areas (x, y, width,
/// height), row by row.
fn tiles((pw, ph): (i32, i32)) -> impl Iterator<Item = [i32; 4]> {
    (0..ph).step_by(TILE as usize).flat_map(move |y| {
        (0..pw)
            .step_by(TILE as usize)
            .map(move |x| [x, y, TILE.min(pw - x), TILE.min(ph - y)])
    })
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
        c.text.borrow_mut().trim();
        c.split = first_animated(&drawing.ops);
        c.split_path = prefix_path_needed(&drawing.ops, c.split);
        c.drawing = Some(drawing);
        c.dirty.set(Damage::All);
    }
    let hidden = view.state().canvas.as_ref().is_some_and(|c| c.hidden.get());
    for uri in load {
        let weak = view.downgrade();
        let key = uri.clone();
        crate::image::load_bitmap(surface, &uri, move |result| {
            let Some(view) = weak.upgrade() else { return };
            let image = match result.and_then(|t| image_surface(&t)) {
                Ok(image) => image,
                Err(e) => {
                    log::warn!("canvas: {e}");
                    return;
                }
            };
            let mut state = view.state_mut();
            let Some(slot) = state.canvas.as_mut().and_then(|c| c.images.get_mut(&key)) else {
                return;
            };
            *slot = Some(image);
            if let Some(c) = state.canvas.as_ref() {
                c.dirty.set(Damage::All);
            }
            drop(state);
            view.changed();
        });
    }
    if !hidden {
        view.changed();
    }
}

/// Animated value slots changed (`(slot, value)`, every bound slot on each
/// frame): draws again where the operations reading the slots whose values
/// changed paint, where they were and where they are now.
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) {
    let damage = {
        let mut state = view.state_mut();
        let Some(CanvasState {
            drawing,
            args,
            scan,
            changed,
            dirty,
            hidden,
            ..
        }) = state.canvas.as_mut()
        else {
            return;
        };
        changed.clear();
        for &(k, value) in values {
            if args.get(k as usize).copied().flatten() != Some(value) {
                changed.push(k);
            }
        }
        if changed.is_empty() {
            return;
        }
        let ops = drawing.as_ref().map_or(&[][..], |d| &d.ops[..]);
        let is_changed = |s: u16| changed.contains(&s);
        let before = scan.damage(ops, |s| slot_number(args, s), is_changed);
        for &(k, value) in values {
            let i = k as usize;
            if args.len() <= i {
                args.resize(i + 1, None);
            }
            args[i] = Some(value);
        }
        let damage = match before {
            Damage::All => Damage::All,
            _ => before.union(scan.damage(ops, |s| slot_number(args, s), is_changed)),
        };
        dirty.set(dirty.get().union(damage));
        // Out of sight, it is drawn when it comes into sight.
        damage != Damage::None && !hidden.get()
    };
    if damage {
        view.changed();
    }
}

/// The number in slot `s` (0 while unset).
fn slot_number(args: &[Option<AnimationValue>], s: u16) -> f32 {
    args.get(s as usize)
        .copied()
        .flatten()
        .map_or(0.0, AnimationValue::number)
}

/// Draws canvas `view` at the display's `scale`: its raster, drawn again
/// where it changed, unless it is out of sight.
pub(crate) fn draw(snapshot: &gtk::Snapshot, view: &NshView, state: &ViewState, scale: f64) {
    let Some(canvas) = state.canvas.as_ref() else {
        return;
    };
    let Some(drawing) = canvas.drawing.as_ref() else {
        return;
    };
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if drawing.ops.is_empty() || w <= 0.0 || h <= 0.0 {
        return;
    }
    let scale = scale.max(1.0);
    let (pw, ph) = (
        (w as f64 * scale).ceil() as i32,
        (h as f64 * scale).ceil() as i32,
    );
    let mut raster = canvas.raster.borrow_mut();
    let fits = raster
        .as_ref()
        .is_some_and(|r| r.scale == scale && r.surface.width() == pw && r.surface.height() == ph);
    if (!fits || canvas.dirty.get() != Damage::None) && !in_sight(view) {
        if !canvas.hidden.replace(true) {
            HIDDEN.with(|h| h.borrow_mut().push(view.downgrade()));
        }
        return;
    }
    let damage = match canvas.dirty.replace(Damage::None) {
        _ if !fits => Damage::All,
        damage => damage,
    };
    if damage != Damage::None {
        let started = crate::fps::measuring().then(nsh_core::time::Instant::now);
        let rasterized = rasterize(canvas, drawing, raster.take(), damage, (pw, ph), scale);
        if let Some(started) = started {
            crate::fps::rasterized(started.elapsed());
        }
        match rasterized {
            Ok(new) => *raster = Some(new),
            Err(e) => {
                log::warn!("canvas: {e}");
                return;
            }
        }
    }
    if let Some(raster) = &*raster {
        let s = scale as f32;
        for (texture, area) in raster.tiles.iter().zip(tiles((pw, ph))) {
            let [x, y, w, h] = area.map(|v| v as f32 / s);
            snapshot.append_texture(texture, &graphene::Rect::new(x, y, w, h));
        }
    }
}

/// Replays `drawing` into `old`'s surface where `damage` says (a new
/// surface for all of it, when the size or scale changed), and makes its
/// texture.
fn rasterize(
    canvas: &CanvasState,
    drawing: &Drawing,
    old: Option<Raster>,
    damage: Damage,
    (pw, ph): (i32, i32),
    scale: f64,
) -> Result<Raster, String> {
    // A full replay draws into the surfaces it had, cleared, when they
    // fit: no new allocations (pages the kernel must map) per drawing.
    let fits = old
        .as_ref()
        .is_some_and(|o| o.scale == scale && o.surface.width() == pw && o.surface.height() == ph);
    let (surface, mut prefix, kept, spare) = match old {
        Some(old) if damage != Damage::All => (old.surface, old.prefix, Some(old.tiles), None),
        Some(old) if fits => {
            let cr = cairo::Context::new(&old.surface).map_err(|e| e.to_string())?;
            cr.set_operator(cairo::Operator::Clear);
            cr.paint().map_err(|e| e.to_string())?;
            (old.surface, None, None, old.prefix)
        }
        _ => {
            let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, pw, ph)
                .map_err(|e| format!("image surface {pw}x{ph}: {e}"))?;
            surface.set_device_scale(scale, scale);
            (surface, None, None, None)
        }
    };
    let ops = &drawing.ops[..];
    let split = canvas.split.min(ops.len());
    {
        let cr = cairo::Context::new(&surface).map_err(|e| e.to_string())?;
        // Where only the operations from `split` on paint: the pixels of
        // those before it, kept.
        let mut kept = None;
        let mut spare = spare;
        if let Damage::Rect(area) = damage {
            cr.rectangle(
                area.origin.x.0 as f64,
                area.origin.y.0 as f64,
                area.size.width.0 as f64,
                area.size.height.0 as f64,
            );
            cr.clip();
            match &prefix {
                Some(prefix) => {
                    cr.set_source_surface(prefix, 0.0, 0.0)
                        .map_err(|e| e.to_string())?;
                    cr.set_operator(cairo::Operator::Source);
                    kept = Some(split);
                }
                None => cr.set_operator(cairo::Operator::Clear),
            }
            let _ = cr.paint();
            cr.set_operator(cairo::Operator::Over);
            cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
        }
        let mut text = canvas.text.borrow_mut();
        let mut replay = Replay {
            cr: &cr,
            args: &canvas.args,
            images: &canvas.images,
            text: &mut text,
            scale,
            base: cr.matrix(),
            state: State::default(),
            stack: Vec::new(),
            has_path: false,
            stash: None,
        };
        for (i, op) in ops.iter().enumerate() {
            if kept.is_some_and(|k| i < k)
                && (op.paints()
                    || (!canvas.split_path
                        && matches!(op, CanvasOp::BeginPath | CanvasOp::Path(_))))
            {
                continue;
            }
            // A full replay keeps what the static operations painted.
            if kept.is_none()
                && damage == Damage::All
                && i == split
                && 0 < split
                && split < ops.len()
            {
                prefix = Some(copy(&surface, spare.take(), (pw, ph), scale)?);
            }
            replay.op(op);
        }
        if let Err(e) = cr.status() {
            log::warn!("canvas: cairo: {e}");
        }
    }
    let mut surface = surface;
    surface.flush();
    // The area redrawn, in whole pixels (all of it for a full replay).
    let [x0, y0, x1, y1] = match damage {
        Damage::Rect(area) => {
            let px = |v: f32, round: fn(f64) -> f64, max: i32| {
                (round(v as f64 * scale) as i32).clamp(0, max)
            };
            [
                px(area.origin.x.0, f64::floor, pw),
                px(area.origin.y.0, f64::floor, ph),
                px(area.origin.x.0 + area.size.width.0, f64::ceil, pw),
                px(area.origin.y.0 + area.size.height.0, f64::ceil, ph),
            ]
        }
        _ => [0, 0, pw, ph],
    };
    let data = surface.data().map_err(|e| e.to_string())?;
    let stride = data.len() / ph.max(1) as usize;
    let mut old = kept.unwrap_or_default().into_iter();
    let tiles = tiles((pw, ph))
        .map(|[x, y, w, h]| {
            let touched = x < x1 && x + w > x0 && y < y1 && y + h > y0;
            match old.next() {
                Some(texture) if !touched => texture,
                _ => memory_texture(&data, stride, [x, y, w, h]),
            }
        })
        .collect();
    drop(data);
    Ok(Raster {
        surface,
        scale,
        tiles,
        prefix,
    })
}

/// A texture of the pixels of `area` (x, y, width, height) of an ARGB32
/// surface's `data`.
fn memory_texture(data: &[u8], stride: usize, [x, y, w, h]: [i32; 4]) -> gdk::Texture {
    let (x, y, w, h) = (x as usize, y as usize, w as usize, h as usize);
    let bytes = if x == 0 && w * 4 == stride {
        glib::Bytes::from(&data[y * stride..(y + h) * stride])
    } else {
        let mut pixels = Vec::with_capacity(w * h * 4);
        for row in y..y + h {
            let start = row * stride + x * 4;
            pixels.extend_from_slice(&data[start..start + w * 4]);
        }
        glib::Bytes::from_owned(pixels)
    };
    // Cairo's ARGB32 is premultiplied, native-endian: BGRA in memory on
    // little-endian machines.
    let format = if cfg!(target_endian = "little") {
        gdk::MemoryFormat::B8g8r8a8Premultiplied
    } else {
        gdk::MemoryFormat::A8r8g8b8Premultiplied
    };
    gdk::MemoryTexture::new(w as i32, h as i32, format, &bytes, w * 4).upcast()
}

/// A copy of `surface`'s pixels, in `into` (a surface of the same size)
/// when given.
fn copy(
    surface: &cairo::ImageSurface,
    into: Option<cairo::ImageSurface>,
    (pw, ph): (i32, i32),
    scale: f64,
) -> Result<cairo::ImageSurface, String> {
    surface.flush();
    let copy = match into {
        Some(into) => into,
        None => {
            let copy = cairo::ImageSurface::create(cairo::Format::ARgb32, pw, ph)
                .map_err(|e| format!("image surface {pw}x{ph}: {e}"))?;
            copy.set_device_scale(scale, scale);
            copy
        }
    };
    let cr = cairo::Context::new(&copy).map_err(|e| e.to_string())?;
    cr.set_source_surface(surface, 0.0, 0.0)
        .map_err(|e| e.to_string())?;
    cr.set_operator(cairo::Operator::Source);
    cr.paint().map_err(|e| e.to_string())?;
    drop(cr);
    copy.flush();
    Ok(copy)
}

/// A loaded texture as a Cairo surface (premultiplied ARGB32, which is
/// GDK's default download format on little-endian machines).
fn image_surface(texture: &gtk::gdk::Texture) -> Result<cairo::ImageSurface, String> {
    let (w, h) = (texture.width(), texture.height());
    let mut image = cairo::ImageSurface::create(cairo::Format::ARgb32, w, h)
        .map_err(|e| format!("image surface {w}x{h}: {e}"))?;
    let stride = image.stride() as usize;
    {
        let mut data = image.data().map_err(|e| e.to_string())?;
        texture.download(&mut data, stride);
    }
    image.mark_dirty();
    Ok(image)
}

// --- Text ----------------------------------------------------------------

/// Pango layouts of a canvas' text, by text and font.
#[derive(Default)]
struct TextCache {
    /// Made on first use (from the Cairo font map).
    context: Option<pango::Context>,
    layouts: FxHashMap<(Arc<str>, FontKey), pango::Layout>,
}

/// A [`CanvasFont`] as a hash key.
#[derive(Clone, PartialEq, Eq, Hash)]
struct FontKey {
    size: u32,
    weight: u16,
    italic: bool,
    family: Option<Arc<str>>,
    variant: u32,
}

impl FontKey {
    fn new(font: &CanvasFont) -> Self {
        FontKey {
            size: font.size.0.to_bits(),
            weight: font.weight,
            italic: font.italic,
            family: font.family.clone(),
            variant: font.variant.0 as u32,
        }
    }
}

impl TextCache {
    /// Keeps the cache bounded across drawings.
    fn trim(&mut self) {
        if self.layouts.len() > MAX_LAYOUTS {
            self.layouts.clear();
        }
    }

    fn layout(&mut self, text: &Arc<str>, font: &CanvasFont) -> pango::Layout {
        let key = (text.clone(), FontKey::new(font));
        if let Some(layout) = self.layouts.get(&key) {
            return layout.clone();
        }
        let context = self.context.get_or_insert_with(new_context);
        let layout = pango::Layout::new(context);
        // The text engine's fonts, so drawn widths match `measureText`.
        layout.set_font_description(Some(&crate::text::main_font_description(
            &font.text_style(),
        )));
        layout.set_text(text);
        // `fontVariantNumeric` (tabular figures in charts...), as the text
        // engine sets OpenType features.
        if font.variant.0 != 0 {
            let features: Vec<String> = font.variant.tags().map(|t| format!("{t}=1")).collect();
            let attrs = pango::AttrList::new();
            attrs.insert(pango::AttrFontFeatures::new(&features.join(",")));
            layout.set_attributes(Some(&attrs));
        }
        self.layouts.insert(key, layout.clone());
        layout
    }
}

/// A Pango context laid out as the text engine measures (`measureText`):
/// unhinted metrics, unrounded glyph positions.
fn new_context() -> pango::Context {
    let context = pangocairo::FontMap::default().create_context();
    if let Ok(mut options) = cairo::FontOptions::new() {
        options.set_hint_metrics(cairo::HintMetrics::Off);
        options.set_hint_style(cairo::HintStyle::None);
        pangocairo::functions::context_set_font_options(&context, Some(&options));
    }
    context.set_round_glyph_positions(false);
    context
}

// --- Replay --------------------------------------------------------------

/// Canvas state Cairo does not keep (or keeps differently).
#[derive(Clone)]
struct State {
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
    /// until `setTransform` or `restore` (Cairo cannot hold such a
    /// matrix).
    singular: bool,
}

impl Default for State {
    fn default() -> Self {
        Self {
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
        }
    }
}

struct Replay<'a> {
    cr: &'a cairo::Context,
    args: &'a [Option<AnimationValue>],
    images: &'a FxHashMap<Arc<str>, Option<cairo::ImageSurface>>,
    text: &'a mut TextCache,
    /// The display's scale.
    scale: f64,
    /// The view's transform (`setTransform` is relative to it).
    base: cairo::Matrix,
    state: State,
    stack: Vec<State>,
    /// The current path may hold something (so it must be set aside).
    has_path: bool,
    /// The current path while it is set aside (in device space, so later
    /// transforms leave it where it was): put back only when an operation
    /// uses it, so a run of `fillRect`s or `fillText`s after a long path
    /// copies it once ([`Replay::aside`]).
    stash: Option<cairo::Path>,
}

/// How a shape is painted.
#[derive(Clone, Copy)]
enum Mode {
    Fill(FillRule),
    Stroke,
}

impl Replay<'_> {
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
    fn concat(&mut self, m: cairo::Matrix) {
        if self.state.singular {
            return;
        }
        let next = cairo::Matrix::multiply(&m, &self.cr.matrix());
        if invertible(&next) {
            self.cr.set_matrix(next);
        } else {
            self.state.singular = true;
        }
    }

    fn op(&mut self, op: &CanvasOp) {
        let cr = self.cr;
        if matches!(
            op,
            CanvasOp::Path(_)
                | CanvasOp::Fill(None, _)
                | CanvasOp::Stroke(None)
                | CanvasOp::Clip(None, _)
        ) {
            self.unstash();
        }
        match op {
            CanvasOp::Save => {
                self.stack.push(self.state.clone());
                let _ = cr.save();
            }
            CanvasOp::Restore => {
                if let Some(s) = self.stack.pop() {
                    self.state = s;
                    let _ = cr.restore();
                }
            }
            CanvasOp::Translate(x, y) => {
                let m = cairo::Matrix::new(1.0, 0.0, 0.0, 1.0, self.n(*x), self.n(*y));
                self.concat(m);
            }
            CanvasOp::Scale(x, y) => {
                let m = cairo::Matrix::new(self.n(*x), 0.0, 0.0, self.n(*y), 0.0, 0.0);
                self.concat(m);
            }
            CanvasOp::Rotate(a) => {
                let (s, c) = self.n(*a).sin_cos();
                self.concat(cairo::Matrix::new(c, s, -s, c, 0.0, 0.0));
            }
            CanvasOp::Transform(m) => {
                let [a, b, c, d, e, f] = m.map(|v| self.n(v));
                self.concat(cairo::Matrix::new(a, b, c, d, e, f));
            }
            CanvasOp::SetTransform(m) => {
                let [a, b, c, d, e, f] = m.map(|v| self.n(v));
                let next =
                    cairo::Matrix::multiply(&cairo::Matrix::new(a, b, c, d, e, f), &self.base);
                self.state.singular = !invertible(&next);
                if !self.state.singular {
                    cr.set_matrix(next);
                }
            }
            CanvasOp::BeginPath => {
                cr.new_path();
                self.has_path = false;
                self.stash = None;
            }
            CanvasOp::Path(p) => {
                if !self.state.singular {
                    self.path_op(p);
                    self.has_path = true;
                }
            }
            CanvasOp::Fill(path, rule) => self.shape(path.as_deref(), Mode::Fill(*rule)),
            CanvasOp::Stroke(path) => self.shape(path.as_deref(), Mode::Stroke),
            CanvasOp::Clip(path, rule) => {
                if self.state.singular {
                    return;
                }
                cr.set_fill_rule(fill_rule(*rule));
                match path {
                    None => cr.clip_preserve(),
                    // Not `aside`: the clip outlives this operation.
                    Some(ops) => {
                        self.set_path_aside();
                        for op in ops.iter() {
                            self.path_op(op);
                        }
                        cr.clip();
                    }
                }
            }
            CanvasOp::FillRect(r) => self.rect(r, Mode::Fill(FillRule::NonZero)),
            CanvasOp::StrokeRect(r) => self.rect(r, Mode::Stroke),
            CanvasOp::ClearRect(r) => {
                if self.state.singular {
                    return;
                }
                let [x, y, w, h] = r.map(|v| self.n(v));
                self.aside(|r| {
                    let cr = r.cr;
                    cr.set_operator(cairo::Operator::Clear);
                    cr.rectangle(x, y, w, h);
                    let _ = cr.fill();
                });
            }
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
            CanvasOp::ShadowOffset(offset) => {
                self.state.shadow.2 = offset.x.0 as f64;
                self.state.shadow.3 = offset.y.0 as f64;
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
                self.text(text, self.n(*x), self.n(*y), max_width.map(|m| m.0), mode)
            }
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            } => self.text(
                text,
                self.n(*x),
                self.n(*y),
                max_width.map(|m| m.0),
                Mode::Stroke,
            ),
            CanvasOp::DrawImage {
                image,
                source,
                dest,
            } => self.image(
                &image.uri,
                source.map(|s| [s.origin.x.0, s.origin.y.0, s.size.width.0, s.size.height.0]),
                dest,
            ),
        }
    }

    /// Sets the current path aside ([`Replay::stash`], unless it is
    /// already) and empties Cairo's.
    fn set_path_aside(&mut self) {
        if self.has_path && self.stash.is_none() {
            let cr = self.cr;
            let user = cr.matrix();
            cr.identity_matrix();
            self.stash = cr.copy_path().ok();
            cr.set_matrix(user);
        }
        self.cr.new_path();
    }

    /// Puts the current path set aside back into Cairo.
    fn unstash(&mut self) {
        if let Some(path) = self.stash.take() {
            let cr = self.cr;
            let user = cr.matrix();
            cr.identity_matrix();
            cr.new_path();
            cr.append_path(&path);
            cr.set_matrix(user);
        }
    }

    /// Runs `f` on an empty path and in its own Cairo state; the current
    /// path stays aside until an operation uses it.
    fn aside(&mut self, f: impl FnOnce(&mut Self)) {
        self.set_path_aside();
        let _ = self.cr.save();
        f(self);
        let _ = self.cr.restore();
        self.cr.new_path();
    }

    /// Adds `op` to Cairo's current path.
    fn path_op(&self, op: &PathOp) {
        let cr = self.cr;
        let n = |v: Num| self.n(v);
        match op {
            PathOp::MoveTo(x, y) => cr.move_to(n(*x), n(*y)),
            // Cairo, like canvas, starts a subpath at the point when there is
            // none (also for curves, at their first control point).
            PathOp::LineTo(x, y) => cr.line_to(n(*x), n(*y)),
            PathOp::QuadTo(v) => {
                let [cx, cy, x, y] = v.map(n);
                let p0 = self.current_point().unwrap_or((cx, cy));
                let [c1x, c1y, c2x, c2y] = quad_to_cubic(p0, (cx, cy), (x, y));
                cr.curve_to(c1x, c1y, c2x, c2y, x, y);
            }
            PathOp::CubicTo(v) => {
                let [c1x, c1y, c2x, c2y, x, y] = v.map(n);
                cr.curve_to(c1x, c1y, c2x, c2y, x, y);
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
                arc(cr, n(*x), n(*y), r, start, sweep);
            }
            PathOp::ArcTo(v) => {
                let [x1, y1, x2, y2, r] = v.map(n);
                self.arc_to(x1, y1, x2, y2, r);
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
                // The unit circle, scaled, rotated and moved; radii stay
                // above zero so the matrix stays invertible.
                let m = cr.matrix();
                cr.translate(x, y);
                cr.rotate(rotation);
                cr.scale(rx.max(1e-6), ry.max(1e-6));
                arc(cr, 0.0, 0.0, 1.0, start, sweep);
                cr.set_matrix(m);
            }
            PathOp::Rect(v) => {
                let [x, y, w, h] = v.map(n);
                cr.rectangle(x, y, w, h);
            }
            PathOp::RoundRect(rect, radii) => {
                let [x, y, w, h] = rect.map(n);
                let [r0, r1, r2, r3] = radii.map(|r| Points(n(r) as f32));
                let fit = fit_radii(
                    size(Points(w as f32), Points(h as f32)),
                    Corners {
                        top_left: r0,
                        top_right: r1,
                        bottom_right: r2,
                        bottom_left: r3,
                    },
                );
                let [tl, tr, br, bl] = [
                    fit.top_left,
                    fit.top_right,
                    fit.bottom_right,
                    fit.bottom_left,
                ]
                .map(|r| f64::from(r.0));
                cr.move_to(x + tl, y);
                self.arc_to(x + w, y, x + w, y + h, tr);
                self.arc_to(x + w, y + h, x, y + h, br);
                self.arc_to(x, y + h, x, y, bl);
                self.arc_to(x, y, x + w, y, tl);
                cr.close_path();
                cr.move_to(x, y);
            }
            PathOp::Close => cr.close_path(),
        }
    }

    fn current_point(&self) -> Option<(f64, f64)> {
        if self.cr.has_current_point().unwrap_or(false) {
            self.cr.current_point().ok()
        } else {
            None
        }
    }

    /// Canvas `arcTo`, which Cairo lacks.
    fn arc_to(&self, x1: f64, y1: f64, x2: f64, y2: f64, r: f64) {
        let cr = self.cr;
        let Some(p0) = self.current_point() else {
            cr.move_to(x1, y1);
            return;
        };
        match arc_to_geometry(p0, (x1, y1), (x2, y2), r) {
            Some(ArcTo {
                center: (cx, cy),
                start,
                sweep,
            }) => arc(cr, cx, cy, r, start, sweep),
            None => cr.line_to(x1, y1),
        }
    }

    /// `fillRect` / `strokeRect`: without touching the current path.
    fn rect(&mut self, r: &[Num; 4], mode: Mode) {
        if self.state.singular {
            return;
        }
        let [x, y, w, h] = r.map(|v| self.n(v));
        self.aside(|r| {
            r.cr.rectangle(x, y, w, h);
            r.paint_path(mode);
        });
    }

    /// `fill` / `stroke` of the current path or of `path`.
    fn shape(&mut self, path: Option<&[PathOp]>, mode: Mode) {
        if self.state.singular {
            return;
        }
        match path {
            None => {
                let _ = self.cr.save();
                self.paint_path(mode);
                let _ = self.cr.restore();
            }
            Some(ops) => self.aside(|r| {
                for op in ops {
                    r.path_op(op);
                }
                r.paint_path(mode);
            }),
        }
    }

    /// Fills or strokes Cairo's current path (kept) with the state's paint,
    /// alpha, composite operation and shadow.
    fn paint_path(&self, mode: Mode) {
        let s = &self.state;
        let draw = |c: &cairo::Context| match mode {
            Mode::Fill(rule) => {
                c.set_fill_rule(fill_rule(rule));
                let _ = c.fill_preserve();
            }
            Mode::Stroke => {
                c.set_line_width(s.line_width);
                c.set_line_cap(match s.cap {
                    LineCap::Butt => cairo::LineCap::Butt,
                    LineCap::Round => cairo::LineCap::Round,
                    LineCap::Square => cairo::LineCap::Square,
                });
                c.set_line_join(match s.join {
                    LineJoin::Miter => cairo::LineJoin::Miter,
                    LineJoin::Round => cairo::LineJoin::Round,
                    LineJoin::Bevel => cairo::LineJoin::Bevel,
                });
                c.set_miter_limit(s.miter);
                // Cairo refuses all-zero patterns; canvas draws solid.
                if s.dash.iter().any(|d| d.0 > 0.0) {
                    let d: Vec<f64> = s.dash.iter().map(|&d| d.0 as f64).collect();
                    c.set_dash(&d, s.dash_offset);
                }
                let _ = c.stroke_preserve();
            }
        };
        self.with_shadow(true, &draw);
        if self.set_source(self.paint(mode)) {
            self.cr.set_operator(operator(s.composite));
            draw(self.cr);
        }
    }

    /// Sets `paint` as Cairo's source with the global alpha; false if it
    /// draws nothing.
    fn set_source(&self, paint: &Paint) -> bool {
        let alpha = self.state.alpha;
        match self.color(paint) {
            Some(color) => {
                let (r, g, b, a) = color.to_f64();
                self.cr.set_source_rgba(r, g, b, a * alpha);
                true
            }
            None => {
                let Paint::Gradient(g) = paint else {
                    return false;
                };
                match self.gradient(g, alpha) {
                    Some(pattern) => self.cr.set_source(&pattern).is_ok(),
                    None => false,
                }
            }
        }
    }

    /// A gradient as a Cairo pattern in the current user space.
    fn gradient(&self, g: &CanvasGradient, alpha: f64) -> Option<cairo::Pattern> {
        if g.stops.is_empty() {
            return None;
        }
        let add_stops = |p: &cairo::Gradient| {
            for (offset, color) in &g.stops {
                let (r, gr, b, a) = color.to_f64();
                p.add_color_stop_rgba(offset.0 as f64, r, gr, b, a * alpha);
            }
            p.set_extend(cairo::Extend::Pad);
        };
        Some(match g.shape {
            GradientShape::Linear { start, end } => {
                let (x0, y0, x1, y1) = (start.x.0, start.y.0, end.x.0, end.y.0);
                let p = cairo::LinearGradient::new(x0 as f64, y0 as f64, x1 as f64, y1 as f64);
                add_stops(&p);
                (**p).clone()
            }
            GradientShape::Radial {
                start,
                start_radius,
                end,
                end_radius,
            } => {
                let (x0, y0, r0) = (start.x.0, start.y.0, start_radius.0);
                let (x1, y1, r1) = (end.x.0, end.y.0, end_radius.0);
                let p = cairo::RadialGradient::new(
                    x0 as f64, y0 as f64, r0 as f64, x1 as f64, y1 as f64, r1 as f64,
                );
                add_stops(&p);
                (**p).clone()
            }
            GradientShape::Conic {
                start_angle,
                center,
            } => {
                let angle = start_angle.0;
                let (x, y) = (center.x.0 as f64, center.y.0 as f64);
                // Far enough to cover what is visible.
                let (x0, y0, x1, y1) = self.cr.clip_extents().ok()?;
                let radius = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
                    .iter()
                    .map(|(px, py)| (px - x).hypot(py - y))
                    .fold(1.0, f64::max)
                    + 1.0;
                (*conic(g, angle as f64, x, y, radius, alpha)).clone()
            }
        })
    }

    /// Draws the shadow of what `draw` paints (given a context with the
    /// canvas' transform, and its current path if `with_path`) when the
    /// state casts one.
    fn with_shadow(&self, with_path: bool, draw: &dyn Fn(&cairo::Context)) {
        let (color, blur, ox, oy) = self.state.shadow;
        if color.is_transparent() || (blur <= 0.0 && ox == 0.0 && oy == 0.0) {
            return;
        }
        if let Err(e) = self.shadow(with_path, draw) {
            log::debug!("canvas: shadow: {e}");
        }
    }

    fn shadow(&self, with_path: bool, draw: &dyn Fn(&cairo::Context)) -> Result<(), cairo::Error> {
        let cr = self.cr;
        let (color, blur, ox, oy) = self.state.shadow;
        // The visible area, in the canvas' device space.
        let user = cr.matrix();
        let path = if with_path {
            Some(cr.copy_path()?)
        } else {
            None
        };
        cr.identity_matrix();
        let clip = cr.clip_extents();
        cr.set_matrix(user);
        let (cx0, cy0, cx1, cy1) = clip?;
        // What casts a shadow there, with room for the blur.
        let spread = (blur * 1.5).ceil();
        let (x0, y0) = (cx0 - ox - spread, cy0 - oy - spread);
        let (w, h) = (cx1 - cx0 + 2.0 * spread, cy1 - cy0 + 2.0 * spread);
        let scale = self
            .scale
            .min(MAX_SHADOW_SIZE / w.max(1.0))
            .min(MAX_SHADOW_SIZE / h.max(1.0));
        let (pw, ph) = ((w * scale).ceil() as i32, (h * scale).ceil() as i32);
        if pw <= 0 || ph <= 0 {
            return Ok(());
        }
        let mut mask = cairo::ImageSurface::create(cairo::Format::A8, pw, ph)?;
        mask.set_device_scale(scale, scale);
        {
            let c = cairo::Context::new(&mask)?;
            c.translate(-x0, -y0);
            c.transform(user);
            if let Some(path) = &path {
                c.append_path(path);
            }
            c.set_source_rgba(0.0, 0.0, 0.0, 1.0);
            draw(&c);
        }
        mask.flush();
        if blur > 0.0 {
            let stride = mask.stride() as usize;
            let mut data = mask.data().map_err(|_| cairo::Error::InvalidStatus)?;
            // Canvas blurs with a Gaussian of standard deviation blur / 2.
            box_blur3(
                &mut data,
                pw as usize,
                ph as usize,
                stride,
                blur / 2.0 * scale,
            );
        }
        mask.mark_dirty();
        cr.save()?;
        cr.identity_matrix();
        let (r, g, b, a) = color.to_f64();
        cr.set_source_rgba(r, g, b, a * self.state.alpha);
        cr.set_operator(operator(self.state.composite));
        let result = cr.mask_surface(&mask, x0 + ox, y0 + oy);
        cr.restore()?;
        result
    }

    fn text(&mut self, text: &Arc<str>, x: f64, y: f64, max_width: Option<f32>, mode: Mode) {
        if text.is_empty() || self.state.singular {
            return;
        }
        let layout = self.text.layout(text, &self.state.font);
        let (_, logical) = layout.extents();
        let width = logical.width() as f64 / pango::SCALE as f64;
        let height = logical.height() as f64 / pango::SCALE as f64;
        // From the layout's top to its baseline, and on to its bottom.
        let ascent = layout.baseline() as f64 / pango::SCALE as f64;
        let descent = height - ascent;
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
        let line_width = self.state.line_width;
        // The glyphs' path where they go (the transform is restored).
        let glyphs = |c: &cairo::Context| {
            let m = c.matrix();
            c.translate(x, y + down);
            c.scale(squeeze, 1.0);
            c.move_to(dx, -ascent);
            pangocairo::functions::layout_path(c, &layout);
            c.set_matrix(m);
        };
        let draw = |c: &cairo::Context| match mode {
            Mode::Fill(_) => {
                glyphs(c);
                let _ = c.fill();
            }
            Mode::Stroke => {
                glyphs(c);
                c.set_line_width(line_width);
                let _ = c.stroke();
            }
        };
        let solid = self.color(self.paint(mode)).is_some();
        self.aside(|r| {
            r.with_shadow(false, &draw);
            if !r.set_source(r.paint(mode)) {
                return;
            }
            let cr = r.cr;
            cr.set_operator(operator(r.state.composite));
            if solid && matches!(mode, Mode::Fill(_)) {
                // Glyphs drawn as glyphs keep the font's hinting and
                // antialiasing.
                cr.translate(x, y + down);
                cr.scale(squeeze, 1.0);
                cr.move_to(dx, -ascent);
                pangocairo::functions::show_layout(cr, &layout);
            } else {
                // Gradients run in canvas space: the path is made where the
                // glyphs go, then painted from there.
                draw(cr);
            }
        });
    }

    fn image(&mut self, uri: &str, source: Option<[f32; 4]>, dest: &[Num; 4]) {
        if self.state.singular {
            return;
        }
        let Some(Some(image)) = self.images.get(uri) else {
            return;
        };
        let (iw, ih) = (image.width() as f64, image.height() as f64);
        let [sx, sy, sw, sh] = source.map_or([0.0, 0.0, iw, ih], |s| s.map(f64::from));
        if sw <= 0.0 || sh <= 0.0 {
            return;
        }
        let [dx, dy, dw, dh] = dest.map(|v| self.n(v));
        // Missing sizes are the source's.
        let dw = if dw.is_nan() { sw } else { dw };
        let dh = if dh.is_nan() { sh } else { dh };
        if dw == 0.0 || dh == 0.0 {
            return;
        }
        let image = image.clone();
        // Sets the image up as the source over its destination rectangle.
        let place = |c: &cairo::Context| {
            c.rectangle(dx, dy, dw, dh);
            c.clip();
            c.translate(dx, dy);
            c.scale(dw / sw, dh / sh);
            c.set_source_surface(&image, -sx, -sy).is_ok()
        };
        self.aside(|r| {
            r.with_shadow(false, &|c| {
                if place(c) {
                    let _ = c.paint();
                }
            });
            r.cr.set_operator(operator(r.state.composite));
            if place(r.cr) {
                let _ = r.cr.paint_with_alpha(r.state.alpha);
            }
        });
    }
}

fn invertible(m: &cairo::Matrix) -> bool {
    let det = m.xx() * m.yy() - m.yx() * m.xy();
    det.is_finite() && det.abs() > 1e-12 && m.x0().is_finite() && m.y0().is_finite()
}

fn fill_rule(rule: FillRule) -> cairo::FillRule {
    match rule {
        FillRule::NonZero => cairo::FillRule::Winding,
        FillRule::EvenOdd => cairo::FillRule::EvenOdd,
    }
}

/// An arc of `sweep` radians (negative: counterclockwise) from `start`.
fn arc(cr: &cairo::Context, x: f64, y: f64, r: f64, start: f64, sweep: f64) {
    if sweep >= 0.0 {
        cr.arc(x, y, r, start, start + sweep);
    } else {
        cr.arc_negative(x, y, r, start, start + sweep);
    }
}

/// The inner control points of the cubic equal to a quadratic curve.
fn quad_to_cubic(p0: (f64, f64), c: (f64, f64), p: (f64, f64)) -> [f64; 4] {
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
    center: (f64, f64),
    start: f64,
    sweep: f64,
}

/// The arc tangent to the lines `p0`–`p1` and `p1`–`p2` (canvas `arcTo`);
/// `None` when it degenerates to a line to `p1`.
fn arc_to_geometry(p0: (f64, f64), p1: (f64, f64), p2: (f64, f64), r: f64) -> Option<ArcTo> {
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
    if sweep > std::f64::consts::PI {
        sweep -= TAU;
    } else if sweep < -std::f64::consts::PI {
        sweep += TAU;
    }
    Some(ArcTo {
        center,
        start,
        sweep,
    })
}

fn operator(c: Composite) -> cairo::Operator {
    use Composite::*;
    use cairo::Operator as O;
    match c {
        SourceOver => O::Over,
        SourceIn => O::In,
        SourceOut => O::Out,
        SourceAtop => O::Atop,
        DestinationOver => O::DestOver,
        DestinationIn => O::DestIn,
        DestinationOut => O::DestOut,
        DestinationAtop => O::DestAtop,
        Lighter => O::Add,
        Copy => O::Source,
        Xor => O::Xor,
        Multiply => O::Multiply,
        Screen => O::Screen,
        Overlay => O::Overlay,
        Darken => O::Darken,
        Lighten => O::Lighten,
        ColorDodge => O::ColorDodge,
        ColorBurn => O::ColorBurn,
        HardLight => O::HardLight,
        SoftLight => O::SoftLight,
        Difference => O::Difference,
        Exclusion => O::Exclusion,
        Hue => O::HslHue,
        Saturation => O::HslSaturation,
        Color => O::HslColor,
        Luminosity => O::HslLuminosity,
    }
}

// --- Conic gradients ------------------------------------------------------

/// Wedges per turn of a conic gradient (plus one per stop).
const CONIC_WEDGES: usize = 64;

/// The gradient's color at `t` (0..1): at a hard stop (two stops at one
/// offset), the one before it, or the one after it with `after`.
fn stop_color(g: &CanvasGradient, t: f32, after: bool) -> Color {
    let stops = &g.stops;
    let (first, last) = (stops[0], stops[stops.len() - 1]);
    if t < first.0.0 || (t == first.0.0 && !after) {
        return first.1;
    }
    for w in stops.windows(2) {
        let ((o0, c0), (o1, c1)) = (w[0], w[1]);
        let (o0, o1) = (o0.0, o1.0);
        if t < o1 || (t == o1 && !after) {
            let f = if o1 > o0 { (t - o0) / (o1 - o0) } else { 1.0 };
            return lerp(c0, c1, f);
        }
    }
    last.1
}

fn lerp(a: Color, b: Color, t: f32) -> Color {
    let mut out = 0u32;
    for shift in [24, 16, 8, 0] {
        let (x, y) = (
            ((a.0 >> shift) & 0xff) as f32,
            ((b.0 >> shift) & 0xff) as f32,
        );
        out |= ((x + (y - x) * t).round() as u32 & 0xff) << shift;
    }
    Color(out)
}

/// Where the wedges of a conic gradient start and end (0..1): a regular
/// grid plus every stop, so hard stops stay hard.
fn conic_steps(g: &CanvasGradient) -> Vec<f32> {
    let mut steps: Vec<f32> = (0..=CONIC_WEDGES)
        .map(|i| i as f32 / CONIC_WEDGES as f32)
        .chain(g.stops.iter().map(|(o, _)| o.0))
        .collect();
    steps.sort_by(f32::total_cmp);
    steps.dedup();
    steps
}

/// A conic gradient as a mesh of wedges around (`x`, `y`) out to
/// `radius`; each wedge blends its two edges' colors.
fn conic(g: &CanvasGradient, angle: f64, x: f64, y: f64, radius: f64, alpha: f64) -> cairo::Mesh {
    let mesh = cairo::Mesh::new();
    let rgba = |c: Color| {
        let (r, g, b, a) = c.to_f64();
        (r, g, b, a * alpha)
    };
    for w in conic_steps(g).windows(2) {
        let (t0, t1) = (w[0], w[1]);
        let (a0, a1) = (angle + t0 as f64 * TAU, angle + t1 as f64 * TAU);
        let c0 = rgba(stop_color(g, t0, true));
        let c1 = rgba(stop_color(g, t1, false));
        // The outer edge as one cubic (wedges are at most 1/64 turn).
        let k = 4.0 / 3.0 * ((a1 - a0) / 4.0).tan() * radius;
        let (s0, co0) = a0.sin_cos();
        let (s1, co1) = a1.sin_cos();
        let p0 = (x + radius * co0, y + radius * s0);
        let p1 = (x + radius * co1, y + radius * s1);
        mesh.begin_patch();
        mesh.move_to(x, y);
        mesh.line_to(p0.0, p0.1);
        mesh.curve_to(
            p0.0 - k * s0,
            p0.1 + k * co0,
            p1.0 + k * s1,
            p1.1 - k * co1,
            p1.0,
            p1.1,
        );
        mesh.line_to(x, y);
        for (corner, (r, g, b, a)) in [
            (cairo::MeshCorner::MeshCorner0, c0),
            (cairo::MeshCorner::MeshCorner1, c0),
            (cairo::MeshCorner::MeshCorner2, c1),
            (cairo::MeshCorner::MeshCorner3, c1),
        ] {
            mesh.set_corner_color_rgba(corner, r, g, b, a);
        }
        mesh.end_patch();
    }
    mesh
}

// --- Shadow blur ----------------------------------------------------------

/// Approximates a Gaussian blur of standard deviation `sigma` (pixels) on
/// an 8-bit alpha image with three box blurs per axis.
fn box_blur3(data: &mut [u8], w: usize, h: usize, stride: usize, sigma: f64) {
    // The box width whose triple pass matches the Gaussian (SVG
    // feGaussianBlur's approximation).
    let d = (sigma * 3.0 * (2.0 * std::f64::consts::PI).sqrt() / 4.0 + 0.5).floor() as usize;
    if d < 2 || w == 0 || h == 0 {
        return;
    }
    let r = d / 2;
    let mut line = vec![0u8; w.max(h)];
    for _ in 0..3 {
        for y in 0..h {
            box_pass(&mut data[y * stride..], 1, w, r, &mut line);
        }
        for x in 0..w {
            box_pass(&mut data[x..], stride, h, r, &mut line);
        }
    }
}

/// One box blur of radius `r` over `n` values `step` apart (zero outside).
fn box_pass(data: &mut [u8], step: usize, n: usize, r: usize, scratch: &mut [u8]) {
    let scratch = &mut scratch[..n];
    for (i, v) in scratch.iter_mut().enumerate() {
        *v = data[i * step];
    }
    let window = (2 * r + 1) as u32;
    let at = |i: isize| -> u32 {
        if i < 0 || i as usize >= n {
            0
        } else {
            scratch[i as usize] as u32
        }
    };
    let r = r as isize;
    let mut sum: u32 = (-r..=r).map(at).sum();
    for i in 0..n as isize {
        data[i as usize * step] = ((sum + window / 2) / window) as u8;
        sum += at(i + r + 1);
        sum -= at(i - r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(stops: &[(f32, u32)]) -> CanvasGradient {
        stops.iter().fold(
            CanvasGradient::conic(Radians(0.0), nsh_core::Point::default()),
            |g, (o, c)| g.add_color_stop(nsh_core::geometry::Percentage(*o), Color(*c)),
        )
    }

    #[test]
    fn arc_to_rounds_a_right_angle() {
        // Along y = 0 to the corner (10, 0), then down.
        let a = arc_to_geometry((0.0, 0.0), (10.0, 0.0), (10.0, 10.0), 2.0).unwrap();
        assert!((a.center.0 - 8.0).abs() < 1e-9 && (a.center.1 - 2.0).abs() < 1e-9);
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
    fn hard_stops_stay_hard() {
        let g = gradient(&[
            (0.0, 0xff0000ff),
            (0.5, 0xff0000ff),
            (0.5, 0x0000ffff),
            (1.0, 0x0000ffff),
        ]);
        assert_eq!(stop_color(&g, 0.5, false), Color(0xff0000ff));
        assert_eq!(stop_color(&g, 0.5, true), Color(0x0000ffff));
        assert_eq!(stop_color(&g, 0.25, true), Color(0xff0000ff));
        let g = gradient(&[(0.0, 0x000000ff), (1.0, 0xffffffff)]);
        assert_eq!(stop_color(&g, 0.5, false), Color(0x808080ff));
        let steps = conic_steps(&gradient(&[(0.0, 0), (0.3, 0), (1.0, 0)]));
        assert_eq!(steps.len(), CONIC_WEDGES + 2);
        assert!(steps.contains(&0.3));
    }

    /// A static line under a filled ring whose radius is slot 0 (its alpha
    /// slot 1), rasterized at scale 2 as `damage` says over `old`.
    fn ring(canvas: &mut CanvasState, radius: f32, old: Option<Raster>, damage: Damage) -> Raster {
        use nsh_core::canvas::PathOp;
        let c = Num::Const;
        let drawing = canvas.drawing.get_or_insert_with(|| {
            Arc::new(Drawing {
                ops: vec![
                    CanvasOp::BeginPath,
                    CanvasOp::Path(PathOp::MoveTo(c(0.0), c(0.0))),
                    CanvasOp::Path(PathOp::LineTo(c(60.0), c(40.0))),
                    CanvasOp::LineWidth(c(3.0)),
                    CanvasOp::Stroke(None),
                    CanvasOp::FillStyle(Paint::Color(Color(0xff000080))),
                    // As a pulse's halo: its alpha animated too, before
                    // its path begins.
                    CanvasOp::GlobalAlpha(Num::Slot(1)),
                    CanvasOp::BeginPath,
                    CanvasOp::Path(PathOp::Arc {
                        x: c(30.0),
                        y: c(20.0),
                        radius: Num::Slot(0),
                        start: c(0.0),
                        end: c(TAU as f32),
                        ccw: false,
                    }),
                    CanvasOp::Fill(None, FillRule::NonZero),
                ],
                ..Drawing::default()
            })
        });
        canvas.split = first_animated(&drawing.ops);
        canvas.split_path = prefix_path_needed(&drawing.ops, canvas.split);
        canvas.args = vec![
            Some(AnimationValue::Number(radius)),
            Some(AnimationValue::Number(0.5)),
        ];
        let drawing = drawing.clone();
        rasterize(canvas, &drawing, old, damage, (600, 80), 2.0).unwrap()
    }

    fn pixels(raster: &Raster) -> Vec<u8> {
        let mut surface = copy(&raster.surface, None, (600, 80), 2.0).unwrap();
        let data = surface.data().map(|d| d.to_vec());
        data.unwrap()
    }

    #[test]
    fn partial_redraws_match_full_ones() {
        let mut canvas = CanvasState::default();
        let first = ring(&mut canvas, 4.0, None, Damage::All);
        // The ring grows: what the slot paints, before and after.
        let mut scan = DamageScan::default();
        let ops = canvas.drawing.as_ref().unwrap().ops.clone();
        let damage = scan
            .damage(&ops, |s| if s == 0 { 4.0 } else { 0.5 }, |s| s == 0)
            .union(scan.damage(&ops, |s| if s == 0 { 9.0 } else { 0.5 }, |s| s == 0));
        assert!(matches!(damage, Damage::Rect(_)));
        assert!(!canvas.split_path, "the ring begins a path of its own");
        let before = first.tiles.clone();
        assert_eq!(before.len(), 3);
        let partial = ring(&mut canvas, 9.0, Some(first), damage);
        // Only the first tile has the ring: the others stay as they were.
        assert_ne!(partial.tiles[0], before[0]);
        assert_eq!(partial.tiles[1..], before[1..]);
        let mut fresh = CanvasState::default();
        let full = ring(&mut fresh, 9.0, None, Damage::All);
        assert_eq!(pixels(&partial), pixels(&full));
        // A full replay over the old surfaces leaves nothing of them.
        let small = ring(&mut canvas, 2.0, Some(partial), Damage::All);
        let fresh = ring(&mut CanvasState::default(), 2.0, None, Damage::All);
        assert_eq!(pixels(&small), pixels(&fresh));
    }

    /// The pixels of `ops` drawn on a fresh `w` × `h` canvas at scale 1.
    fn draw_ops(ops: Vec<CanvasOp>, (w, h): (i32, i32)) -> (Vec<u8>, usize) {
        let drawing = Drawing {
            ops,
            ..Drawing::default()
        };
        let canvas = CanvasState::default();
        let raster = rasterize(&canvas, &drawing, None, Damage::All, (w, h), 1.0).unwrap();
        let mut surface = copy(&raster.surface, None, (w, h), 1.0).unwrap();
        let stride = surface.stride() as usize;
        let data = surface.data().map(|d| d.to_vec()).unwrap();
        (data, stride)
    }

    #[test]
    fn the_current_path_outlives_rects_and_transforms() {
        use nsh_core::canvas::PathOp;
        let c = Num::Const;
        let (data, stride) = draw_ops(
            vec![
                CanvasOp::FillStyle(Paint::Color(Color(0x000000ff))),
                CanvasOp::BeginPath,
                CanvasOp::Path(PathOp::Rect([c(0.0), c(0.0), c(10.0), c(10.0)])),
                // Drawn without touching the path; the transform after it
                // moves what comes next, not the path built before.
                CanvasOp::FillRect([c(40.0), c(0.0), c(10.0), c(10.0)]),
                CanvasOp::Translate(c(20.0), c(0.0)),
                CanvasOp::Fill(None, FillRule::NonZero),
                CanvasOp::Path(PathOp::Rect([c(0.0), c(0.0), c(5.0), c(5.0)])),
                CanvasOp::Fill(None, FillRule::NonZero),
            ],
            (60, 10),
        );
        let alpha = |x: usize, y: usize| data[y * stride + x * 4 + 3];
        // The first path where it was built, the rect, the second path
        // translated; nothing elsewhere.
        assert_eq!((alpha(5, 5), alpha(45, 5), alpha(22, 2)), (255, 255, 255));
        assert_eq!((alpha(15, 5), alpha(35, 5), alpha(27, 7)), (0, 0, 0));
    }

    /// A chart's pattern: a long line, then a run of bars drawn with
    /// `fillRect` (`cargo test --release -p nsh-platform-linux
    /// bench_rects_after_a_path -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn bench_rects_after_a_path() {
        use nsh_core::canvas::PathOp;
        let c = Num::Const;
        let mut ops = vec![
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::MoveTo(c(0.0), c(100.0))),
        ];
        for i in 0..400 {
            ops.push(CanvasOp::Path(PathOp::LineTo(
                c(i as f32 * 2.0),
                c(100.0 + 50.0 * (i as f32 * 0.1).sin()),
            )));
        }
        ops.push(CanvasOp::StrokeStyle(Paint::Color(Color(0xff0000ff))));
        ops.push(CanvasOp::Stroke(None));
        for i in 0..240 {
            ops.push(CanvasOp::FillStyle(Paint::Color(Color(0x00ff00ff))));
            ops.push(CanvasOp::FillRect([
                c(i as f32 * 3.4),
                c(280.0),
                c(2.0),
                c(-(i % 30) as f32),
            ]));
        }
        let t = std::time::Instant::now();
        for _ in 0..50 {
            draw_ops(ops.clone(), (840, 340));
        }
        eprintln!("a 400-point line, then 240 bars: {:?}", t.elapsed() / 50);
    }

    #[test]
    fn box_blur_spreads_and_keeps_mass() {
        let (w, h, stride) = (21, 21, 24);
        let mut data = vec![0u8; stride * h];
        // A 5×5 opaque square in the middle.
        for y in 8..13 {
            for x in 8..13 {
                data[y * stride + x] = 255;
            }
        }
        let before: i64 = data.iter().map(|&v| v as i64).sum();
        box_blur3(&mut data, w, h, stride, 2.0);
        let after: i64 = data.iter().map(|&v| v as i64).sum();
        let center = data[10 * stride + 10];
        assert!(center < 255 && center > 100);
        assert!(data[10 * stride + 5] > 0);
        // Rounding loses little; the padding past each row stays empty.
        assert!((before - after).abs() < before / 20);
        assert!(
            data[10 * stride + 21..10 * stride + 24]
                .iter()
                .all(|&v| v == 0)
        );
        // No blur below a pixel.
        let mut one = vec![255u8; 4];
        box_blur3(&mut one, 2, 2, 2, 0.3);
        assert_eq!(one, vec![255; 4]);
    }
}
