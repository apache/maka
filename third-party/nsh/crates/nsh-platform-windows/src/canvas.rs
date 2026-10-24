//! Canvas views: a recorded [`Drawing`] replayed with Direct2D.
//!
//! The replay is recorded into an `ID2D1CommandList` when the drawing,
//! one of its animated values or an image it draws changes (and when the
//! device is replaced); [`draw`] only plays the list back with the view's
//! transform. A drawing whose animated values are read late is recorded
//! as two lists: the operations before the first one reading a slot
//! ([`nsh_core::canvas::first_animated`]), recorded once, and the rest,
//! recorded again when a slot changes; the tail replays the head's state
//! (transforms, styles, the path, clips) without painting it. A tail that
//! would combine with what the head drew (a composite operation other than
//! `source-over` in effect or set in it, a `clearRect`) is recorded whole
//! with its head. Command lists are vector: redrawing the window is cheap and
//! stays sharp at any scale, and effects (shadows, composite operations)
//! are rendered at the resolution they are played back at.
//!
//! Direct2D has no current path and no clip state, so the replay keeps
//! canvas' model itself: the current path is kept in the view's
//! coordinates as it is built (later transforms do not move it; arcs and
//! ellipses become cubics), and every fill and stroke maps it back into
//! the user space of the transform current at that moment and draws there,
//! so strokes are transformed and gradients run in user space as canvas
//! specifies. Clips are geometric layers pushed with `save` / `restore`'s
//! state.
//!
//! Recording uses device contexts of its own (one per nesting level,
//! [`Pool`]), never the one the frame is being drawn with: a shadow or a
//! composite operation records what it needs into a nested command list
//! while the outer one stays open. Shadows are the drawn shape through
//! Direct2D's shadow effect (a Gaussian of standard deviation blur / 2, as
//! canvas specifies), offset in the view's coordinates. Composite
//! operations other than `source-over` combine with what was drawn so far
//! through the composite or blend effect: the list so far is closed, the
//! shape recorded on its own, and a new list starts with the effect's
//! output, so they combine within the canvas, as on a canvas bitmap.
//! Conic gradients, which Direct2D lacks, are thin wedges with linear
//! gradients, drawn aliased (so they leave no seams) inside a layer masked
//! by the shape.
//!
//! Text is laid out with DirectWrite (layouts cached per canvas) in the
//! fonts the text engine measures with, so drawn widths match
//! `measureText`; `strokeText` and conic-filled text use the glyphs'
//! outlines. Images are loaded through [`crate::image::load_bitmap`] when
//! a drawing names them and kept per canvas (their frames make bitmaps per
//! device).

use std::{cell::RefCell, f64::consts::TAU, rc::Rc, sync::Arc};

use nsh_core::{
    Color, Corners, Points,
    animation::AnimationValue,
    canvas::{
        CanvasFont, CanvasGradient, CanvasOp, CanvasTextAlign, CanvasTextBaseline, Composite,
        Drawing, FillRule, GradientShape, LineCap, LineJoin, Num, Paint, PathOp, arc_sweep,
        fit_radii,
    },
    geometry::{Percentage, Radians, size},
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::Graphics::{
        Direct2D::{
            CLSID_D2D1Blend, CLSID_D2D1Composite, CLSID_D2D1Shadow,
            Common::{
                D2D_RECT_F, D2D1_BEZIER_SEGMENT, D2D1_BLEND_MODE, D2D1_BLEND_MODE_COLOR,
                D2D1_BLEND_MODE_COLOR_BURN, D2D1_BLEND_MODE_COLOR_DODGE, D2D1_BLEND_MODE_DARKEN,
                D2D1_BLEND_MODE_DIFFERENCE, D2D1_BLEND_MODE_EXCLUSION, D2D1_BLEND_MODE_HARD_LIGHT,
                D2D1_BLEND_MODE_HUE, D2D1_BLEND_MODE_LIGHTEN, D2D1_BLEND_MODE_LUMINOSITY,
                D2D1_BLEND_MODE_MULTIPLY, D2D1_BLEND_MODE_OVERLAY, D2D1_BLEND_MODE_SATURATION,
                D2D1_BLEND_MODE_SCREEN, D2D1_BLEND_MODE_SOFT_LIGHT, D2D1_COMPOSITE_MODE,
                D2D1_COMPOSITE_MODE_DESTINATION_ATOP, D2D1_COMPOSITE_MODE_DESTINATION_IN,
                D2D1_COMPOSITE_MODE_DESTINATION_OUT, D2D1_COMPOSITE_MODE_DESTINATION_OVER,
                D2D1_COMPOSITE_MODE_PLUS, D2D1_COMPOSITE_MODE_SOURCE_ATOP,
                D2D1_COMPOSITE_MODE_SOURCE_COPY, D2D1_COMPOSITE_MODE_SOURCE_IN,
                D2D1_COMPOSITE_MODE_SOURCE_OUT, D2D1_COMPOSITE_MODE_SOURCE_OVER,
                D2D1_COMPOSITE_MODE_XOR, D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_END_CLOSED,
                D2D1_FIGURE_END_OPEN, D2D1_FILL_MODE_ALTERNATE, D2D1_FILL_MODE_WINDING,
                D2D1_GRADIENT_STOP,
            },
            D2D1_ANTIALIAS_MODE_ALIASED, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_BLEND_PROP_MODE,
            D2D1_BRUSH_PROPERTIES, D2D1_BUFFER_PRECISION_8BPC_UNORM, D2D1_CAP_STYLE,
            D2D1_CAP_STYLE_FLAT, D2D1_CAP_STYLE_ROUND, D2D1_CAP_STYLE_SQUARE,
            D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED, D2D1_COLOR_SPACE_SRGB,
            D2D1_COMBINE_MODE_EXCLUDE, D2D1_COMBINE_MODE_INTERSECT, D2D1_COMPOSITE_PROP_MODE,
            D2D1_DASH_STYLE_CUSTOM, D2D1_DASH_STYLE_SOLID, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
            D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT, D2D1_EXTEND_MODE_CLAMP,
            D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LAYER_OPTIONS1_NONE, D2D1_LAYER_PARAMETERS1,
            D2D1_LINE_JOIN, D2D1_LINE_JOIN_BEVEL, D2D1_LINE_JOIN_MITER_OR_BEVEL,
            D2D1_LINE_JOIN_ROUND, D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES, D2D1_PROPERTY_TYPE_ENUM,
            D2D1_PROPERTY_TYPE_FLOAT, D2D1_PROPERTY_TYPE_VECTOR4,
            D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES, D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION,
            D2D1_SHADOW_PROP_COLOR, D2D1_STROKE_STYLE_PROPERTIES1,
            D2D1_STROKE_TRANSFORM_TYPE_NORMAL, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE, ID2D1Bitmap1,
            ID2D1Brush, ID2D1CommandList, ID2D1DeviceContext, ID2D1Factory1, ID2D1Geometry,
            ID2D1Image, ID2D1StrokeStyle1,
        },
        DirectWrite::{
            DWRITE_FONT_FEATURE, DWRITE_FONT_FEATURE_TAG, DWRITE_FONT_STRETCH_NORMAL,
            DWRITE_FONT_STYLE_ITALIC, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT,
            DWRITE_GLYPH_RUN, DWRITE_GLYPH_RUN_DESCRIPTION, DWRITE_LINE_METRICS, DWRITE_MATRIX,
            DWRITE_MEASURING_MODE, DWRITE_STRIKETHROUGH, DWRITE_TEXT_METRICS, DWRITE_TEXT_RANGE,
            DWRITE_UNDERLINE, DWRITE_WORD_WRAPPING_NO_WRAP, IDWriteInlineObject,
            IDWritePixelSnapping_Impl, IDWriteTextLayout, IDWriteTextRenderer,
            IDWriteTextRenderer_Impl,
        },
    },
    core::{HSTRING, Interface},
};
use windows_numerics::{Matrix3x2, Vector2};

use crate::{
    gfx::{self, Gfx},
    image::Frame,
    render::{DrawCx, color_f, rect_f},
    surface::Surface,
    view::{NshView, ViewState},
};

/// Layouts kept per canvas before the cache is emptied.
const MAX_LAYOUTS: usize = 256;
/// Wedges per turn of a conic gradient (plus one per stop).
const CONIC_WEDGES: usize = 64;
/// How closely curves are flattened where Direct2D needs it (widened
/// strokes, combined clips), in user units.
const TOLERANCE: f32 = 0.05;

/// What a canvas draws.
#[derive(Default)]
pub(crate) struct CanvasState {
    /// The drawing.
    drawing: Option<Arc<Drawing>>,
    /// Animated value slots (`AnimationProp::CanvasArg`).
    args: Vec<Option<AnimationValue>>,
    /// The images the drawing names, by URI: `None` while loading (or
    /// when they failed to load).
    images: FxHashMap<Arc<str>, Option<Rc<Frame>>>,
    /// What was recorded (made while drawing, which only sees the state).
    cache: RefCell<Cache>,
}

/// A canvas' recording and the device resources it draws with.
#[derive(Default)]
struct Cache {
    /// The replay, once recorded (`None` inside when recording failed):
    /// the whole drawing, or the operations from `split` on.
    list: Option<Option<ID2D1CommandList>>,
    /// The operations before `split`, recorded once per drawing (`None`
    /// while the drawing is recorded whole).
    head: Option<Option<ID2D1CommandList>>,
    /// Where the drawing splits into the head and the animated tail
    /// (`0`: recorded whole).
    split: usize,
    /// The device generation `list` belongs to.
    generation: u64,
    /// DirectWrite layouts of `fillText` / `strokeText`.
    text: TextCache,
}

impl CanvasState {
    /// Records again on the next draw.
    fn stale(&mut self) {
        let cache = self.cache.get_mut();
        cache.list = None;
        cache.head = None;
    }

    /// An animated value changed: records the tail again on the next draw.
    fn stale_tail(&mut self) {
        self.cache.get_mut().list = None;
    }
}

/// Where `drawing` splits into a head recorded once and a tail recorded
/// when a slot changes (`0`: recorded whole).
fn split(drawing: &Drawing) -> usize {
    let ops = &drawing.ops;
    let first = nsh_core::canvas::first_animated(ops);
    // Nothing animated, or nothing before it to keep.
    if first == 0 || first >= ops.len() {
        return 0;
    }
    // The tail must not combine with what was drawn before it, which its
    // list does not hold: no composite operation in effect where it starts
    // or set in it, no `clearRect` in it. The head's own composite
    // operations combine within its list.
    let mut composite = Composite::SourceOver;
    let mut saved = Vec::new();
    for op in &ops[..first] {
        match op {
            CanvasOp::Save => saved.push(composite),
            CanvasOp::Restore => composite = saved.pop().unwrap_or(composite),
            CanvasOp::Composite(m) => composite = *m,
            _ => {}
        }
    }
    let combines = |op: &CanvasOp| {
        matches!(op, CanvasOp::Composite(m) if *m != Composite::SourceOver)
            || matches!(op, CanvasOp::ClearRect(_))
    };
    if composite != Composite::SourceOver || ops[first..].iter().any(combines) {
        return 0;
    }
    first
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
        c.cache.get_mut().text.trim();
        c.drawing = Some(drawing);
        c.stale();
    }
    let id = view.id();
    for uri in load {
        let weak = Rc::downgrade(surface);
        let key = uri.clone();
        crate::image::load_bitmap(surface, &uri, move |result| {
            let frame = match result {
                Ok(frame) => frame,
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
                *slot = Some(frame);
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
        c.args[k] = Some(value);
        c.stale_tail();
    }
    view.changed();
}

/// Draws a canvas: records it first if needed.
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let started = crate::fps::measuring().then(std::time::Instant::now);
    draw_canvas(cx, state);
    if let Some(started) = started {
        crate::fps::drew_canvas(started.elapsed());
    }
}

fn draw_canvas(cx: &mut DrawCx<'_>, state: &ViewState) {
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
    let mut cache = canvas.cache.borrow_mut();
    let generation = gfx::generation();
    if cache.generation != generation {
        cache.generation = generation;
        cache.list = None;
        cache.head = None;
    }
    let cache = &mut *cache;
    if cache.head.is_none() {
        cache.split = split(drawing);
        let head = (cache.split > 0).then(|| {
            record(
                cx.gfx,
                &drawing.ops[..cache.split],
                0,
                &canvas.args,
                &canvas.images,
                &mut cache.text,
            )
            .map_err(|e| log::warn!("canvas: not recorded: {e}"))
            .ok()
        });
        cache.head = Some(head.flatten());
        // A new head goes with a new tail.
        cache.list = None;
    }
    if cache.list.is_none() {
        let recorded = record(
            cx.gfx,
            &drawing.ops,
            cache.split,
            &canvas.args,
            &canvas.images,
            &mut cache.text,
        );
        let list = recorded
            .map_err(|e| log::warn!("canvas: not recorded: {e}"))
            .ok();
        cache.list = Some(list);
    }
    for list in [&cache.head, &cache.list].into_iter().flatten().flatten() {
        // SAFETY: a COM call between BeginDraw and EndDraw; the list is
        // closed and made on this device.
        unsafe {
            cx.dc.DrawImage(
                list,
                None,
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
        }
    }
}

// --- Recording -------------------------------------------------------------

/// The device contexts recording uses, by nesting level, and the stroke
/// styles of the device's factory.
#[derive(Default)]
struct Pool {
    generation: u64,
    dcs: Vec<ID2D1DeviceContext>,
    strokes: FxHashMap<StrokeKey, ID2D1StrokeStyle1>,
}

thread_local! {
    static POOL: RefCell<Pool> = RefCell::new(Pool::default());
}

/// Replays `ops` into a new command list; the ones before `from` only set
/// the state (they are painted by another list).
fn record(
    gfx: &Gfx,
    ops: &[CanvasOp],
    from: usize,
    args: &[Option<AnimationValue>],
    images: &FxHashMap<Arc<str>, Option<Rc<Frame>>>,
    text: &mut TextCache,
) -> windows::core::Result<ID2D1CommandList> {
    // The pool leaves the thread-local while recording, which never
    // records another canvas.
    let generation = gfx::generation();
    let mut pool = POOL.with(|p| std::mem::take(&mut *p.borrow_mut()));
    if pool.generation != generation {
        pool = Pool {
            generation,
            ..Pool::default()
        };
    }
    let mut replay = Replay {
        gfx,
        pool: &mut pool,
        depth: 0,
        main: None,
        args,
        images,
        text,
        state: State::default(),
        stack: Vec::new(),
        path: PathBuf::default(),
        clips: Vec::new(),
    };
    let mut result = replay.begin_main(None);
    if result.is_ok() {
        for (i, op) in ops.iter().enumerate() {
            if i < from && op.paints() {
                continue;
            }
            if let Err(e) = replay.op(op) {
                result = Err(e);
                break;
            }
        }
    }
    let list = replay.end_main();
    POOL.with(|p| *p.borrow_mut() = pool);
    result.and(list)
}

/// A device context for recording, made on `gfx`'s device.
fn recorder(gfx: &Gfx) -> windows::core::Result<ID2D1DeviceContext> {
    // SAFETY: COM calls on the live device.
    unsafe {
        let dc = gfx
            .device
            .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
        // ClearType needs to know what is behind the text, which a command
        // list does not.
        dc.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        Ok(dc)
    }
}

/// Clips what `dc` draws next to `mask` (in its current coordinates), at
/// `opacity`.
fn push_mask(dc: &ID2D1DeviceContext, mask: &ID2D1Geometry, opacity: f32) {
    let mut params = D2D1_LAYER_PARAMETERS1 {
        contentBounds: crate::render::INFINITE,
        geometricMask: std::mem::ManuallyDrop::new(Some(mask.clone())),
        maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
        maskTransform: Matrix3x2::identity(),
        opacity,
        opacityBrush: std::mem::ManuallyDrop::new(None),
        layerOptions: D2D1_LAYER_OPTIONS1_NONE,
    };
    // SAFETY: valid parameters; the caller pops the layer before
    // `EndDraw`. The parameters own a reference to the mask, released
    // after the call (the context keeps its own).
    unsafe {
        dc.PushLayer(&params, None);
        std::mem::ManuallyDrop::drop(&mut params.geometricMask);
    }
}

// --- Replay ----------------------------------------------------------------

/// Canvas' drawing state (`save` / `restore`).
#[derive(Clone)]
struct State {
    /// User space to the view's coordinates.
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
}

impl Default for State {
    fn default() -> Self {
        Self {
            transform: Affine::IDENTITY,
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

/// How a shape is painted.
#[derive(Clone, Copy)]
enum Mode {
    Fill(FillRule),
    Stroke,
}

/// A paint as Direct2D draws it.
enum Brush {
    Plain(ID2D1Brush),
    /// Drawn as wedges ([`Replay::fill_conic`]).
    Conic(Arc<CanvasGradient>),
}

/// What draws a shape on the current recording context with an alpha.
type DrawFn<'a, 'b> = &'b dyn Fn(&mut Replay<'a>, f32) -> windows::core::Result<()>;

struct Replay<'a> {
    gfx: &'a Gfx,
    pool: &'a mut Pool,
    /// The nesting level recorded into (0: the main list).
    depth: usize,
    /// The main list being recorded.
    main: Option<ID2D1CommandList>,
    args: &'a [Option<AnimationValue>],
    images: &'a FxHashMap<Arc<str>, Option<Rc<Frame>>>,
    text: &'a mut TextCache,
    state: State,
    /// Saved states and how many clips each had.
    stack: Vec<(State, usize)>,
    /// The current path, in the view's coordinates.
    path: PathBuf,
    /// The clips in effect (view coordinates), each a layer pushed on the
    /// main list's context.
    clips: Vec<ID2D1Geometry>,
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

    fn factory(&self) -> &ID2D1Factory1 {
        &self.gfx.factory
    }

    /// The context recording at the current level.
    fn dc(&self) -> ID2D1DeviceContext {
        self.pool.dcs[self.depth].clone()
    }

    /// The recording context of level `depth`, made if new.
    fn level(&mut self, depth: usize) -> windows::core::Result<ID2D1DeviceContext> {
        while self.pool.dcs.len() <= depth {
            self.pool.dcs.push(recorder(self.gfx)?);
        }
        Ok(self.pool.dcs[depth].clone())
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

    fn op(&mut self, op: &CanvasOp) -> windows::core::Result<()> {
        match op {
            CanvasOp::Save => self.stack.push((self.state.clone(), self.clips.len())),
            CanvasOp::Restore => {
                if let Some((state, clips)) = self.stack.pop() {
                    self.state = state;
                    let dc = self.dc();
                    while self.clips.len() > clips {
                        self.clips.pop();
                        // SAFETY: pops a layer `clip` pushed on this context.
                        unsafe { dc.PopLayer() };
                    }
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
                let next = Affine { a, b, c, d, e, f };
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
            CanvasOp::Fill(path, rule) => self.shape(path.as_deref(), Mode::Fill(*rule))?,
            CanvasOp::Stroke(path) => self.shape(path.as_deref(), Mode::Stroke)?,
            CanvasOp::Clip(path, rule) => self.clip(path.as_deref(), *rule)?,
            CanvasOp::FillRect(r) => self.rect(r, Mode::Fill(FillRule::NonZero))?,
            CanvasOp::StrokeRect(r) => self.rect(r, Mode::Stroke)?,
            CanvasOp::ClearRect(r) => self.clear_rect(r)?,
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
                let max_width = max_width.map(|m| m.0);
                self.text_op(text, self.n(*x), self.n(*y), max_width, mode)?
            }
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            } => {
                let max_width = max_width.map(|m| m.0);
                self.text_op(text, self.n(*x), self.n(*y), max_width, Mode::Stroke)?
            }
            CanvasOp::DrawImage {
                image,
                source,
                dest,
            } => {
                let source =
                    source.map(|s| [s.origin.x.0, s.origin.y.0, s.size.width.0, s.size.height.0]);
                self.image(&image.uri, source, dest)?
            }
        }
        Ok(())
    }

    // --- Paths ---

    /// Adds `op` (in user space) to `path` (in the view's coordinates).
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
                let fit = fit_radii(
                    size(Points(w as f32), Points(h as f32)),
                    Corners {
                        top_left: tl,
                        top_right: tr,
                        bottom_right: br,
                        bottom_left: bl,
                    },
                );
                let [tl, tr, br, bl] = [
                    fit.top_left,
                    fit.top_right,
                    fit.bottom_right,
                    fit.bottom_left,
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

    /// `segments` (view coordinates) as a geometry in the coordinates
    /// `to` maps them into.
    fn geometry(
        &self,
        segments: &[Seg],
        to: &Affine,
        rule: FillRule,
    ) -> windows::core::Result<ID2D1Geometry> {
        let v = |p: Pt| {
            let (x, y) = to.map(p);
            Vector2 {
                X: x as f32,
                Y: y as f32,
            }
        };
        // SAFETY: COM calls on live objects; the sink is closed before the
        // geometry is used.
        unsafe {
            let path = self.factory().CreatePathGeometry()?;
            let sink = path.Open()?;
            sink.SetFillMode(match rule {
                FillRule::NonZero => D2D1_FILL_MODE_WINDING,
                FillRule::EvenOdd => D2D1_FILL_MODE_ALTERNATE,
            });
            let mut start = (0.0, 0.0);
            let mut open = false;
            for seg in segments {
                match *seg {
                    Seg::Move(p) => {
                        if open {
                            sink.EndFigure(D2D1_FIGURE_END_OPEN);
                            open = false;
                        }
                        start = p;
                    }
                    Seg::Line(p) => {
                        if !open {
                            sink.BeginFigure(v(start), D2D1_FIGURE_BEGIN_FILLED);
                            open = true;
                        }
                        sink.AddLine(v(p));
                    }
                    Seg::Cubic(c1, c2, p) => {
                        if !open {
                            sink.BeginFigure(v(start), D2D1_FIGURE_BEGIN_FILLED);
                            open = true;
                        }
                        sink.AddBezier(&D2D1_BEZIER_SEGMENT {
                            point1: v(c1),
                            point2: v(c2),
                            point3: v(p),
                        });
                    }
                    // The next segment starts at the closed subpath's start.
                    Seg::Close => {
                        if open {
                            sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                            open = false;
                        }
                    }
                }
            }
            if open {
                sink.EndFigure(D2D1_FIGURE_END_OPEN);
            }
            sink.Close()?;
            path.cast()
        }
    }

    /// The segments of `path` (the current path when `None`), and the
    /// geometry of them in user space.
    fn shape_geometry(
        &self,
        path: Option<&[PathOp]>,
        to: &Affine,
        rule: FillRule,
    ) -> windows::core::Result<ID2D1Geometry> {
        match path {
            None => self.geometry(&self.path.segments, to, rule),
            Some(ops) => {
                let mut own = PathBuf::default();
                for op in ops {
                    self.path_op(&mut own, op);
                }
                self.geometry(&own.segments, to, rule)
            }
        }
    }

    /// `fill` / `stroke` of the current path or of `path`.
    fn shape(&mut self, path: Option<&[PathOp]>, mode: Mode) -> windows::core::Result<()> {
        if self.state.singular {
            return Ok(());
        }
        let Some(to_user) = self.state.transform.invert() else {
            return Ok(());
        };
        let rule = match mode {
            Mode::Fill(rule) => rule,
            Mode::Stroke => FillRule::NonZero,
        };
        let geometry = self.shape_geometry(path, &to_user, rule)?;
        self.paint_geometry(&geometry, mode)
    }

    /// `fillRect` / `strokeRect` (the current path stays).
    fn rect(&mut self, r: &[Num; 4], mode: Mode) -> windows::core::Result<()> {
        if self.state.singular {
            return Ok(());
        }
        let geometry = self.rect_geometry(r)?;
        self.paint_geometry(&geometry, mode)
    }

    fn rect_geometry(&self, r: &[Num; 4]) -> windows::core::Result<ID2D1Geometry> {
        let [x, y, w, h] = r.map(|v| self.n(v) as f32);
        let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
        let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
        // SAFETY: a COM call on the live factory.
        unsafe {
            self.factory()
                .CreateRectangleGeometry(&rect_f(x, y, w, h))?
                .cast()
        }
    }

    /// `clearRect`: the rectangle (inside the clip) becomes transparent.
    fn clear_rect(&mut self, r: &[Num; 4]) -> windows::core::Result<()> {
        if self.state.singular {
            return Ok(());
        }
        let geometry = self.rect_geometry(r)?;
        let transform = self.state.transform;
        // Neither shadows nor the alpha nor the composite operation apply.
        self.emit(false, Composite::DestinationOut, 1.0, &|r, _| {
            let dc = r.dc();
            // SAFETY: COM calls on the recording context, inside its draw.
            unsafe {
                dc.SetTransform(&transform.d2d());
                let black = dc.CreateSolidColorBrush(&color_f(Color::BLACK), None)?;
                dc.FillGeometry(&geometry, &black, None);
            }
            Ok(())
        })
    }

    /// `clip`: intersects the clip with the current path or `path`.
    fn clip(&mut self, path: Option<&[PathOp]>, rule: FillRule) -> windows::core::Result<()> {
        if self.state.singular {
            return Ok(());
        }
        // In the view's coordinates: the clip outlives the transform.
        let geometry = self.shape_geometry(path, &Affine::IDENTITY, rule)?;
        let dc = self.dc();
        // SAFETY: a COM call on the main recording context.
        unsafe { dc.SetTransform(&Matrix3x2::identity()) };
        push_mask(&dc, &geometry, 1.0);
        self.clips.push(geometry);
        Ok(())
    }

    // --- Painting ---

    /// Fills or strokes `geometry` (user space) with the state's paint,
    /// alpha, composite operation and shadow.
    fn paint_geometry(
        &mut self,
        geometry: &ID2D1Geometry,
        mode: Mode,
    ) -> windows::core::Result<()> {
        let (alpha, composite) = (self.state.alpha as f32, self.state.composite);
        self.emit(true, composite, alpha, &|r, alpha| {
            r.draw_geometry(geometry, mode, alpha)
        })
    }

    /// Draws `geometry` (user space) on the current recording context.
    fn draw_geometry(
        &mut self,
        geometry: &ID2D1Geometry,
        mode: Mode,
        alpha: f32,
    ) -> windows::core::Result<()> {
        let dc = self.dc();
        // SAFETY: a COM call on the recording context, inside its draw.
        unsafe { dc.SetTransform(&self.state.transform.d2d()) };
        let paint = self.paint(mode).clone();
        match self.brush(&dc, &paint, alpha, &Affine::IDENTITY)? {
            None => {}
            Some(Brush::Plain(brush)) => match mode {
                // SAFETY: COM calls on the recording context, inside its
                // draw.
                Mode::Fill(_) => unsafe { dc.FillGeometry(geometry, &brush, None) },
                Mode::Stroke => {
                    let style = self.stroke_style()?;
                    let width = self.state.line_width as f32;
                    // SAFETY: as above.
                    unsafe { dc.DrawGeometry(geometry, &brush, width, &style) };
                }
            },
            Some(Brush::Conic(g)) => {
                let area = match mode {
                    Mode::Fill(_) => geometry.clone(),
                    Mode::Stroke => self.widen(geometry)?,
                };
                self.fill_conic(&dc, &area, &g, alpha)?;
            }
        }
        Ok(())
    }

    /// The area a stroke of `geometry` covers.
    fn widen(&mut self, geometry: &ID2D1Geometry) -> windows::core::Result<ID2D1Geometry> {
        let style = self.stroke_style()?;
        // SAFETY: COM calls on live objects; the sink is closed before the
        // geometry is used.
        unsafe {
            let path = self.factory().CreatePathGeometry()?;
            let sink = path.Open()?;
            geometry.Widen(self.state.line_width as f32, &style, None, TOLERANCE, &sink)?;
            sink.Close()?;
            path.cast()
        }
    }

    /// Draws what `draw` paints with `composite` and, when `shadow` and
    /// the state casts one, its shadow first.
    fn emit(
        &mut self,
        shadow: bool,
        composite: Composite,
        alpha: f32,
        draw: DrawFn<'a, '_>,
    ) -> windows::core::Result<()> {
        let shadow = shadow && self.casts_shadow();
        if composite == Composite::SourceOver {
            if shadow {
                self.shadow(draw)?;
            }
            return draw(self, alpha);
        }
        // The rest combines with what was drawn so far, which an effect
        // reads: the list so far is closed, the shape recorded on its own.
        let dest = self.end_main()?;
        let source = self.record(true, |r| {
            if shadow {
                r.shadow(draw)?;
            }
            draw(r, alpha)
        });
        let image = source.and_then(|source| self.combine(&dest, &source, composite));
        match image {
            Ok(image) => self.begin_main(Some((&dest, &image, composite))),
            Err(e) => {
                // Goes on with what was drawn so far.
                let _ = self.begin_main(Some((&dest, &dest.cast()?, Composite::SourceOver)));
                Err(e)
            }
        }
    }

    fn casts_shadow(&self) -> bool {
        let (color, blur, ox, oy) = self.state.shadow;
        !color.is_transparent() && (blur > 0.0 || ox != 0.0 || oy != 0.0)
    }

    /// Draws the shadow of what `draw` paints.
    fn shadow(&mut self, draw: DrawFn<'a, '_>) -> windows::core::Result<()> {
        let (color, blur, ox, oy) = self.state.shadow;
        let shape = self.record(false, |r| draw(r, 1.0))?;
        let (red, green, blue, a) = color.to_f64();
        let rgba = [red, green, blue, a * self.state.alpha].map(|v| v as f32);
        let dc = self.dc();
        // SAFETY: COM calls on live objects, inside the recording context's
        // draw.
        unsafe {
            let effect = dc.CreateEffect(&CLSID_D2D1Shadow)?;
            effect.SetInput(0, &shape, false);
            // Canvas blurs with a Gaussian of standard deviation blur / 2.
            let deviation = (blur / 2.0) as f32;
            effect.SetValue(
                D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION.0 as u32,
                D2D1_PROPERTY_TYPE_FLOAT,
                &deviation.to_le_bytes(),
            )?;
            let mut bytes = [0u8; 16];
            for (i, v) in rgba.iter().enumerate() {
                bytes[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
            }
            effect.SetValue(
                D2D1_SHADOW_PROP_COLOR.0 as u32,
                D2D1_PROPERTY_TYPE_VECTOR4,
                &bytes,
            )?;
            let output = effect.GetOutput()?;
            // Shadow offsets are not transformed.
            dc.SetTransform(&Affine::translate(ox, oy).d2d());
            dc.DrawImage(
                &output,
                None,
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
        }
        Ok(())
    }

    /// `source` combined with `dest` by `composite`.
    fn combine(
        &self,
        dest: &ID2D1CommandList,
        source: &ID2D1CommandList,
        composite: Composite,
    ) -> windows::core::Result<ID2D1Image> {
        let dc = &self.pool.dcs[0];
        // SAFETY: COM calls on live objects.
        unsafe {
            let effect = match blend(composite) {
                Blend::Composite(mode) => {
                    let effect = dc.CreateEffect(&CLSID_D2D1Composite)?;
                    effect.SetValue(
                        D2D1_COMPOSITE_PROP_MODE.0 as u32,
                        D2D1_PROPERTY_TYPE_ENUM,
                        &(mode.0 as u32).to_le_bytes(),
                    )?;
                    effect
                }
                Blend::Blend(mode) => {
                    let effect = dc.CreateEffect(&CLSID_D2D1Blend)?;
                    effect.SetValue(
                        D2D1_BLEND_PROP_MODE.0 as u32,
                        D2D1_PROPERTY_TYPE_ENUM,
                        &(mode.0 as u32).to_le_bytes(),
                    )?;
                    effect
                }
            };
            // Input 0 is the destination, 1 the source.
            effect.SetInput(0, dest, false);
            effect.SetInput(1, source, false);
            effect.GetOutput()
        }
    }

    /// Starts a main list; after a composite operation, with `image` (what
    /// `dest` became).
    fn begin_main(
        &mut self,
        after: Option<(&ID2D1CommandList, &ID2D1Image, Composite)>,
    ) -> windows::core::Result<()> {
        let dc = self.level(0)?;
        // SAFETY: COM calls on the main recording context; `end_main`
        // closes the draw.
        unsafe {
            let list = dc.CreateCommandList()?;
            dc.SetTarget(&list);
            dc.BeginDraw();
            dc.SetTransform(&Matrix3x2::identity());
            self.main = Some(list);
            let draw = |image: &ID2D1Image| {
                dc.DrawImage(
                    image,
                    None,
                    None,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER,
                )
            };
            match after {
                // These change the destination where the source is not:
                // outside the clip, it stays.
                Some((dest, image, mode)) if destructive(mode) && !self.clips.is_empty() => {
                    if let Ok(outside) = self.outside_clips() {
                        push_mask(&dc, &outside, 1.0);
                        draw(&dest.cast()?);
                        dc.PopLayer();
                    }
                    for clip in &self.clips {
                        push_mask(&dc, clip, 1.0);
                    }
                    draw(image);
                }
                Some((_, image, _)) => {
                    draw(image);
                    for clip in &self.clips {
                        push_mask(&dc, clip, 1.0);
                    }
                }
                None => {
                    for clip in &self.clips {
                        push_mask(&dc, clip, 1.0);
                    }
                }
            }
        }
        Ok(())
    }

    /// Closes the main list.
    fn end_main(&mut self) -> windows::core::Result<ID2D1CommandList> {
        let Some(list) = self.main.take() else {
            return Err(windows::Win32::Foundation::E_UNEXPECTED.into());
        };
        let dc = self.pool.dcs[0].clone();
        // SAFETY: closes the draw `begin_main` started, after popping the
        // clips' layers it pushed.
        unsafe {
            for _ in &self.clips {
                dc.PopLayer();
            }
            let ended = dc.EndDraw(None, None);
            dc.SetTarget(None);
            ended?;
            list.Close()?;
        }
        Ok(list)
    }

    /// Records what `f` draws into a list of its own, inside the clip when
    /// `clipped`.
    fn record(
        &mut self,
        clipped: bool,
        f: impl FnOnce(&mut Self) -> windows::core::Result<()>,
    ) -> windows::core::Result<ID2D1CommandList> {
        let dc = self.level(self.depth + 1)?;
        // SAFETY: COM calls on the nested recording context; the draw is
        // ended and the layers popped before returning.
        unsafe {
            let list = dc.CreateCommandList()?;
            dc.SetTarget(&list);
            dc.BeginDraw();
            dc.SetTransform(&Matrix3x2::identity());
            if clipped {
                for clip in &self.clips {
                    push_mask(&dc, clip, 1.0);
                }
            }
            self.depth += 1;
            let drawn = f(self);
            self.depth -= 1;
            if clipped {
                for _ in &self.clips {
                    dc.PopLayer();
                }
            }
            let ended = dc.EndDraw(None, None);
            dc.SetTarget(None);
            drawn?;
            ended?;
            list.Close()?;
            Ok(list)
        }
    }

    /// Everything outside the clip (view coordinates).
    fn outside_clips(&self) -> windows::core::Result<ID2D1Geometry> {
        let combine =
            |a: &ID2D1Geometry, b: &ID2D1Geometry, mode| -> windows::core::Result<ID2D1Geometry> {
                // SAFETY: COM calls on live objects; the sink is closed before
                // the geometry is used.
                unsafe {
                    let path = self.factory().CreatePathGeometry()?;
                    let sink = path.Open()?;
                    a.CombineWithGeometry(b, mode, None, TOLERANCE, &sink)?;
                    sink.Close()?;
                    path.cast()
                }
            };
        let mut inside = self.clips[0].clone();
        for clip in &self.clips[1..] {
            inside = combine(&inside, clip, D2D1_COMBINE_MODE_INTERSECT)?;
        }
        let far = 1.0e6;
        // SAFETY: a COM call on the live factory.
        let everything: ID2D1Geometry = unsafe {
            self.factory()
                .CreateRectangleGeometry(&D2D_RECT_F {
                    left: -far,
                    top: -far,
                    right: far,
                    bottom: far,
                })?
                .cast()?
        };
        combine(&everything, &inside, D2D1_COMBINE_MODE_EXCLUDE)
    }

    /// `paint` as a brush with `alpha`; `local` maps the drawing's
    /// coordinates to the user space gradients are defined in. `None` if
    /// it draws nothing.
    fn brush(
        &self,
        dc: &ID2D1DeviceContext,
        paint: &Paint,
        alpha: f32,
        local: &Affine,
    ) -> windows::core::Result<Option<Brush>> {
        let properties = D2D1_BRUSH_PROPERTIES {
            opacity: alpha,
            transform: local.d2d(),
        };
        if let Some(color) = self.color(paint) {
            // SAFETY: a COM call on the recording context.
            let brush = unsafe { dc.CreateSolidColorBrush(&color_f(color), Some(&properties))? };
            return Ok(Some(Brush::Plain(brush.cast()?)));
        }
        let Paint::Gradient(g) = paint else {
            return Ok(None);
        };
        if g.stops.is_empty() {
            return Ok(None);
        }
        let brush: ID2D1Brush = match g.shape {
            GradientShape::Linear { start, end } => {
                let (x0, y0, x1, y1) = (start.x.0, start.y.0, end.x.0, end.y.0);
                // Canvas paints nothing along a gradient of no length.
                if x0 == x1 && y0 == y1 {
                    return Ok(None);
                }
                let stops = gradient_stops(&g.stops, false, 0.0);
                // SAFETY: COM calls on the recording context.
                unsafe {
                    let collection = stop_collection(dc, &stops)?;
                    dc.CreateLinearGradientBrush(
                        &D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                            startPoint: Vector2 { X: x0, Y: y0 },
                            endPoint: Vector2 { X: x1, Y: y1 },
                        },
                        Some(&properties),
                        &collection,
                    )?
                    .cast()?
                }
            }
            GradientShape::Radial {
                start,
                start_radius,
                end,
                end_radius,
            } => {
                let circles = [
                    start.x.0,
                    start.y.0,
                    start_radius.0,
                    end.x.0,
                    end.y.0,
                    end_radius.0,
                ];
                let Some(r) = radial(circles) else {
                    return Ok(None);
                };
                let stops = gradient_stops(&g.stops, r.reversed, r.inner);
                // SAFETY: COM calls on the recording context.
                unsafe {
                    let collection = stop_collection(dc, &stops)?;
                    dc.CreateRadialGradientBrush(
                        &D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES {
                            center: Vector2 {
                                X: r.center.0 as f32,
                                Y: r.center.1 as f32,
                            },
                            gradientOriginOffset: Vector2 {
                                X: r.offset.0 as f32,
                                Y: r.offset.1 as f32,
                            },
                            radiusX: r.radius as f32,
                            radiusY: r.radius as f32,
                        },
                        Some(&properties),
                        &collection,
                    )?
                    .cast()?
                }
            }
            GradientShape::Conic { .. } => return Ok(Some(Brush::Conic(g.clone()))),
        };
        Ok(Some(Brush::Plain(brush)))
    }

    /// Fills `area` (user space, the context's transform set) with the
    /// conic gradient `g`: wedges inside a layer masked by the area.
    fn fill_conic(
        &self,
        dc: &ID2D1DeviceContext,
        area: &ID2D1Geometry,
        g: &CanvasGradient,
        alpha: f32,
    ) -> windows::core::Result<()> {
        let GradientShape::Conic {
            start_angle,
            center,
        } = g.shape
        else {
            return Ok(());
        };
        let (angle, x, y) = (start_angle.0 as f64, center.x.0 as f64, center.y.0 as f64);
        // SAFETY: COM calls on live objects inside the recording context's
        // draw; the layer is popped and the antialiasing restored.
        unsafe {
            let b = area.GetBounds(None)?;
            // Far enough to cover the area.
            let radius = [
                (b.left, b.top),
                (b.right, b.top),
                (b.left, b.bottom),
                (b.right, b.bottom),
            ]
            .iter()
            .map(|&(px, py)| (px as f64 - x).hypot(py as f64 - y))
            .fold(1.0, f64::max)
                + 1.0;
            push_mask(dc, area, alpha);
            dc.SetAntialiasMode(D2D1_ANTIALIAS_MODE_ALIASED);
            let result = (|| -> windows::core::Result<()> {
                for w in conic_steps(g).windows(2) {
                    let (t0, t1) = (w[0], w[1]);
                    let (a0, a1) = (angle + t0 as f64 * TAU, angle + t1 as f64 * TAU);
                    // Out past the circle, so the straight outer edge covers
                    // it (wedges are at most 1/64 turn).
                    let far = radius / ((a1 - a0) / 2.0).cos();
                    let at = |a: f64, r: f64| Vector2 {
                        X: (x + r * a.cos()) as f32,
                        Y: (y + r * a.sin()) as f32,
                    };
                    let wedge = self.factory().CreatePathGeometry()?;
                    let sink = wedge.Open()?;
                    sink.BeginFigure(
                        Vector2 {
                            X: x as f32,
                            Y: y as f32,
                        },
                        D2D1_FIGURE_BEGIN_FILLED,
                    );
                    sink.AddLine(at(a0, far));
                    sink.AddLine(at(a1, far));
                    sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                    sink.Close()?;
                    let stops = [
                        D2D1_GRADIENT_STOP {
                            position: 0.0,
                            color: color_f(stop_color(g, t0, true)),
                        },
                        D2D1_GRADIENT_STOP {
                            position: 1.0,
                            color: color_f(stop_color(g, t1, false)),
                        },
                    ];
                    let collection = stop_collection(dc, &stops)?;
                    let brush = dc.CreateLinearGradientBrush(
                        &D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                            startPoint: at(a0, radius),
                            endPoint: at(a1, radius),
                        },
                        None,
                        &collection,
                    )?;
                    dc.FillGeometry(&wedge, &brush, None);
                }
                Ok(())
            })();
            dc.SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
            dc.PopLayer();
            result
        }
    }

    /// The stroke style of the state (cached per device).
    fn stroke_style(&mut self) -> windows::core::Result<ID2D1StrokeStyle1> {
        let s = &self.state;
        let dashes = dash_pattern(&s.dash, s.line_width, s.dash_offset);
        let key = StrokeKey {
            cap: s.cap as u8,
            join: s.join as u8,
            miter: (s.miter as f32).to_bits(),
            dash: dashes.as_ref().map(|(d, offset)| {
                d.iter()
                    .map(|v| v.to_bits())
                    .chain(Some(offset.to_bits()))
                    .collect()
            }),
        };
        if let Some(style) = self.pool.strokes.get(&key) {
            return Ok(style.clone());
        }
        let cap = cap_style(s.cap);
        let properties = D2D1_STROKE_STYLE_PROPERTIES1 {
            startCap: cap,
            endCap: cap,
            dashCap: cap,
            lineJoin: line_join(s.join),
            miterLimit: s.miter as f32,
            dashStyle: if dashes.is_some() {
                D2D1_DASH_STYLE_CUSTOM
            } else {
                D2D1_DASH_STYLE_SOLID
            },
            dashOffset: dashes.as_ref().map_or(0.0, |d| d.1),
            transformType: D2D1_STROKE_TRANSFORM_TYPE_NORMAL,
        };
        // SAFETY: a COM call on the live factory.
        let style = unsafe {
            self.factory()
                .CreateStrokeStyle(&properties, dashes.as_ref().map(|d| d.0.as_slice()))?
        };
        if self.pool.strokes.len() > 64 {
            self.pool.strokes.clear();
        }
        self.pool.strokes.insert(key, style.clone());
        Ok(style)
    }

    // --- Text ---

    fn text_op(
        &mut self,
        text: &Arc<str>,
        x: f64,
        y: f64,
        max_width: Option<f32>,
        mode: Mode,
    ) -> windows::core::Result<()> {
        if text.is_empty() || self.state.singular {
            return Ok(());
        }
        let Some(entry) = self.text.layout(text, &self.state.font) else {
            return Ok(());
        };
        let (width, ascent) = (entry.width, entry.ascent);
        let descent = entry.height - ascent;
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
            return Ok(());
        }
        // The layout's coordinates in user space.
        let place = Affine::translate(x, y + down)
            .then(&Affine::scale(squeeze, 1.0))
            .then(&Affine::translate(dx, -ascent));
        let conic = matches!(self.paint(mode), Paint::Gradient(g) if matches!(g.shape, GradientShape::Conic { .. }));
        if matches!(mode, Mode::Fill(_)) && !conic {
            // Glyphs drawn as glyphs keep DirectWrite's rendering.
            let Some(to_layout) = place.invert() else {
                return Ok(());
            };
            let (alpha, composite) = (self.state.alpha as f32, self.state.composite);
            let layout = entry.layout.clone();
            return self.emit(true, composite, alpha, &|r, alpha| {
                let dc = r.dc();
                let paint = r.state.fill.clone();
                // SAFETY: COM calls on the recording context, inside its
                // draw.
                unsafe {
                    dc.SetTransform(&r.state.transform.then(&place).d2d());
                    // Gradients run in user space.
                    if let Some(Brush::Plain(brush)) = r.brush(&dc, &paint, alpha, &to_layout)? {
                        dc.DrawTextLayout(
                            Vector2 { X: 0.0, Y: 0.0 },
                            &layout,
                            &brush,
                            D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
                        );
                    }
                }
                Ok(())
            });
        }
        let outline = outline(self.factory(), &entry.layout)?;
        // SAFETY: a COM call on the live factory.
        let geometry: ID2D1Geometry = unsafe {
            self.factory()
                .CreateTransformedGeometry(&outline, &place.d2d())?
                .cast()?
        };
        self.paint_geometry(&geometry, mode)
    }

    // --- Images ---

    /// The bitmap of the image `uri`, once loaded.
    fn bitmap(&self, uri: &str) -> Option<ID2D1Bitmap1> {
        let frame = self.images.get(uri)?.as_ref()?;
        frame.bitmap(&self.pool.dcs[0])
    }

    fn image(
        &mut self,
        uri: &str,
        source: Option<[f32; 4]>,
        dest: &[Num; 4],
    ) -> windows::core::Result<()> {
        if self.state.singular {
            return Ok(());
        }
        let Some(bitmap) = self.bitmap(uri) else {
            return Ok(());
        };
        // SAFETY: a COM call on a live bitmap.
        let size = unsafe { bitmap.GetPixelSize() };
        let (iw, ih) = (size.width as f64, size.height as f64);
        let [sx, sy, sw, sh] = source.map_or([0.0, 0.0, iw, ih], |s| s.map(f64::from));
        if sw == 0.0 || sh == 0.0 {
            return Ok(());
        }
        let [dx, dy, dw, dh] = dest.map(|v| self.n(v));
        // Missing sizes are the source's.
        let dw = if dw.is_nan() { sw } else { dw };
        let dh = if dh.is_nan() { sh } else { dh };
        if dw == 0.0 || dh == 0.0 {
            return Ok(());
        }
        let src = normalized(sx, sy, sw, sh);
        let dst = normalized(dx, dy, dw, dh);
        let (alpha, composite) = (self.state.alpha as f32, self.state.composite);
        self.emit(true, composite, alpha, &|r, alpha| {
            let dc = r.dc();
            // SAFETY: COM calls on the recording context, inside its draw.
            unsafe {
                dc.SetTransform(&r.state.transform.d2d());
                dc.DrawBitmap(
                    &bitmap,
                    Some(&dst),
                    alpha,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    Some(&src),
                    None,
                );
            }
            Ok(())
        })
    }
}

/// A rectangle with its size made positive.
fn normalized(x: f64, y: f64, w: f64, h: f64) -> D2D_RECT_F {
    let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
    let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
    rect_f(x as f32, y as f32, w as f32, h as f32)
}

/// `stops` as a gradient stop collection (premultiplied interpolation,
/// as canvas specifies).
///
/// # Safety
///
/// Must be called on the thread that owns `dc`.
unsafe fn stop_collection(
    dc: &ID2D1DeviceContext,
    stops: &[D2D1_GRADIENT_STOP],
) -> windows::core::Result<windows::Win32::Graphics::Direct2D::ID2D1GradientStopCollection1> {
    // SAFETY: a COM call on the live context (the caller's thread owns it).
    unsafe {
        dc.CreateGradientStopCollection(
            stops,
            D2D1_COLOR_SPACE_SRGB,
            D2D1_COLOR_SPACE_SRGB,
            D2D1_BUFFER_PRECISION_8BPC_UNORM,
            D2D1_EXTEND_MODE_CLAMP,
            D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED,
        )
    }
}

/// Canvas gradient stops as Direct2D's: reversed (offset 1 - t) when
/// `reversed`, then moved into `inner..1`; stops at one offset are kept
/// apart by a hair so hard stops stay hard (in order).
fn gradient_stops(
    stops: &[(Percentage, Color)],
    reversed: bool,
    inner: f64,
) -> Vec<D2D1_GRADIENT_STOP> {
    let inner = inner as f32;
    let mut out: Vec<(f32, Color)> = if reversed {
        stops.iter().rev().map(|&(o, c)| (1.0 - o.0, c)).collect()
    } else {
        stops.iter().map(|&(o, c)| (o.0, c)).collect()
    };
    let mut last = f32::NEG_INFINITY;
    for (o, _) in &mut out {
        *o = inner + *o * (1.0 - inner);
        if *o <= last {
            *o = last + 1e-5;
        }
        last = *o;
    }
    out.into_iter()
        .map(|(position, c)| D2D1_GRADIENT_STOP {
            position,
            color: color_f(c),
        })
        .collect()
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
    const IDENTITY: Affine = Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn translate(x: f64, y: f64) -> Affine {
        Affine {
            e: x,
            f: y,
            ..Affine::IDENTITY
        }
    }

    fn scale(x: f64, y: f64) -> Affine {
        Affine {
            a: x,
            d: y,
            ..Affine::IDENTITY
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

    /// The inverse; `None` if it is singular or not finite.
    fn invert(&self) -> Option<Affine> {
        let det = self.a * self.d - self.b * self.c;
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

    fn d2d(&self) -> Matrix3x2 {
        Matrix3x2 {
            M11: self.a as f32,
            M12: self.b as f32,
            M21: self.c as f32,
            M22: self.d as f32,
            M31: self.e as f32,
            M32: self.f as f32,
        }
    }
}

/// A path segment, in the view's coordinates.
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

    /// An arc of the unit circle that `unit` maps into the view, of `sweep`
    /// radians (negative: counterclockwise) from `start`, joined to the
    /// subpath by a line.
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

/// A two-circle radial gradient as Direct2D's one-ellipse one.
#[derive(Debug, PartialEq)]
struct Radial {
    /// The outer circle.
    center: Pt,
    radius: f64,
    /// From the center to the gradient's origin (the inner circle's
    /// center).
    offset: Pt,
    /// Where the inner circle falls (0..1 of the radius): stops move into
    /// `inner..1`.
    inner: f64,
    /// The circles were swapped (the first was the larger): stops run
    /// backwards.
    reversed: bool,
}

/// Canvas `createRadialGradient(x0, y0, r0, x1, y1, r1)` as close as
/// Direct2D allows: exact when the inner circle is a point or the circles
/// are concentric; otherwise the inner circle's center is the origin and
/// its radius moves the stops. `None` when it paints nothing.
fn radial([x0, y0, r0, x1, y1, r1]: [f32; 6]) -> Option<Radial> {
    let (mut inner, mut outer) = (
        (x0 as f64, y0 as f64, r0 as f64),
        (x1 as f64, y1 as f64, r1 as f64),
    );
    let reversed = inner.2 > outer.2;
    if reversed {
        std::mem::swap(&mut inner, &mut outer);
    }
    if outer.2 <= 0.0 || inner.2 < 0.0 || !outer.2.is_finite() {
        return None;
    }
    let mut offset = (inner.0 - outer.0, inner.1 - outer.1);
    // Direct2D's origin must stay inside the ellipse.
    let len = offset.0.hypot(offset.1);
    let max = outer.2 * 0.999;
    if len > max {
        offset = (offset.0 * max / len, offset.1 * max / len);
    }
    Some(Radial {
        center: (outer.0, outer.1),
        radius: outer.2,
        offset,
        inner: inner.2 / outer.2,
        reversed,
    })
}

// --- Strokes -----------------------------------------------------------------

/// A stroke style's parameters, as a hash key.
#[derive(PartialEq, Eq, Hash)]
struct StrokeKey {
    cap: u8,
    join: u8,
    miter: u32,
    /// The dashes and offset (bits), if dashed.
    dash: Option<Box<[u32]>>,
}

fn cap_style(cap: LineCap) -> D2D1_CAP_STYLE {
    match cap {
        LineCap::Butt => D2D1_CAP_STYLE_FLAT,
        LineCap::Round => D2D1_CAP_STYLE_ROUND,
        LineCap::Square => D2D1_CAP_STYLE_SQUARE,
    }
}

fn line_join(join: LineJoin) -> D2D1_LINE_JOIN {
    match join {
        // Canvas bevels joins past the miter limit.
        LineJoin::Miter => D2D1_LINE_JOIN_MITER_OR_BEVEL,
        LineJoin::Round => D2D1_LINE_JOIN_ROUND,
        LineJoin::Bevel => D2D1_LINE_JOIN_BEVEL,
    }
}

/// Canvas dashes (points) as Direct2D's, which are in line widths, and
/// the offset likewise; `None` for a solid line (no dashes, or all zero:
/// canvas draws solid).
fn dash_pattern(dash: &[Points], width: f64, offset: f64) -> Option<(Vec<f32>, f32)> {
    if !dash.iter().any(|d| d.0 > 0.0) || width <= 0.0 {
        return None;
    }
    let w = width as f32;
    Some((
        dash.iter().map(|d| d.0 / w).collect(),
        (offset / width) as f32,
    ))
}

// --- Composite operations ----------------------------------------------------

/// How an effect combines a source with what was drawn.
enum Blend {
    Composite(D2D1_COMPOSITE_MODE),
    Blend(D2D1_BLEND_MODE),
}

fn blend(c: Composite) -> Blend {
    use Composite::*;
    match c {
        SourceOver => Blend::Composite(D2D1_COMPOSITE_MODE_SOURCE_OVER),
        SourceIn => Blend::Composite(D2D1_COMPOSITE_MODE_SOURCE_IN),
        SourceOut => Blend::Composite(D2D1_COMPOSITE_MODE_SOURCE_OUT),
        SourceAtop => Blend::Composite(D2D1_COMPOSITE_MODE_SOURCE_ATOP),
        DestinationOver => Blend::Composite(D2D1_COMPOSITE_MODE_DESTINATION_OVER),
        DestinationIn => Blend::Composite(D2D1_COMPOSITE_MODE_DESTINATION_IN),
        DestinationOut => Blend::Composite(D2D1_COMPOSITE_MODE_DESTINATION_OUT),
        DestinationAtop => Blend::Composite(D2D1_COMPOSITE_MODE_DESTINATION_ATOP),
        Lighter => Blend::Composite(D2D1_COMPOSITE_MODE_PLUS),
        Copy => Blend::Composite(D2D1_COMPOSITE_MODE_SOURCE_COPY),
        Xor => Blend::Composite(D2D1_COMPOSITE_MODE_XOR),
        Multiply => Blend::Blend(D2D1_BLEND_MODE_MULTIPLY),
        Screen => Blend::Blend(D2D1_BLEND_MODE_SCREEN),
        Overlay => Blend::Blend(D2D1_BLEND_MODE_OVERLAY),
        Darken => Blend::Blend(D2D1_BLEND_MODE_DARKEN),
        Lighten => Blend::Blend(D2D1_BLEND_MODE_LIGHTEN),
        ColorDodge => Blend::Blend(D2D1_BLEND_MODE_COLOR_DODGE),
        ColorBurn => Blend::Blend(D2D1_BLEND_MODE_COLOR_BURN),
        HardLight => Blend::Blend(D2D1_BLEND_MODE_HARD_LIGHT),
        SoftLight => Blend::Blend(D2D1_BLEND_MODE_SOFT_LIGHT),
        Difference => Blend::Blend(D2D1_BLEND_MODE_DIFFERENCE),
        Exclusion => Blend::Blend(D2D1_BLEND_MODE_EXCLUSION),
        Hue => Blend::Blend(D2D1_BLEND_MODE_HUE),
        Saturation => Blend::Blend(D2D1_BLEND_MODE_SATURATION),
        Color => Blend::Blend(D2D1_BLEND_MODE_COLOR),
        Luminosity => Blend::Blend(D2D1_BLEND_MODE_LUMINOSITY),
    }
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

// --- Conic gradients ---------------------------------------------------------

/// The gradient's color at `t` (0..1): at a hard stop (two stops at one
/// offset), the one before it, or the one after it with `after`.
fn stop_color(g: &CanvasGradient, t: f32, after: bool) -> Color {
    let stops = &g.stops;
    let (first, last) = (stops[0], stops[stops.len() - 1]);
    if t < first.0.0 || (t == first.0.0 && !after) {
        return first.1;
    }
    for w in stops.windows(2) {
        let ((o0, c0), (o1, c1)) = ((w[0].0.0, w[0].1), (w[1].0.0, w[1].1));
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

// --- Text --------------------------------------------------------------------

/// A laid-out line of canvas text.
#[derive(Clone)]
struct TextEntry {
    layout: IDWriteTextLayout,
    /// Advance width, as `measureText` measures it.
    width: f64,
    /// From the top to the baseline.
    ascent: f64,
    /// The line's height.
    height: f64,
}

/// DirectWrite layouts of a canvas' text, by text and font.
#[derive(Default)]
struct TextCache {
    /// The system font's family (fonts without a family), once asked.
    ui_family: Option<Arc<str>>,
    layouts: FxHashMap<(Arc<str>, FontKey), TextEntry>,
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

    fn layout(&mut self, text: &Arc<str>, font: &CanvasFont) -> Option<TextEntry> {
        let key = (text.clone(), FontKey::new(font));
        if let Some(entry) = self.layouts.get(&key) {
            return Some(entry.clone());
        }
        // The family the text engine resolves (`measureText` measures
        // there).
        let family = match &font.text_style().font_family {
            Some(f) => f.name(),
            None => self
                .ui_family
                .get_or_insert_with(crate::text::ui_family)
                .clone(),
        };
        let entry = match make_layout(text, font, &family) {
            Ok(entry) => entry,
            Err(e) => {
                log::debug!("canvas: no layout for {text:?}: {e}");
                return None;
            }
        };
        self.layouts.insert(key, entry.clone());
        Some(entry)
    }
}

/// `text` on one line in `font` of `family`.
fn make_layout(text: &str, font: &CanvasFont, family: &str) -> windows::core::Result<TextEntry> {
    let factory = gfx::dwrite();
    let wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: COM calls on the shared factory with valid strings and
    // ranges; out values are locals.
    unsafe {
        let format = factory.CreateTextFormat(
            &HSTRING::from(family),
            None,
            DWRITE_FONT_WEIGHT(font.weight as i32),
            if font.italic {
                DWRITE_FONT_STYLE_ITALIC
            } else {
                DWRITE_FONT_STYLE_NORMAL
            },
            DWRITE_FONT_STRETCH_NORMAL,
            font.size.0.max(0.1),
            &HSTRING::new(),
        )?;
        format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        let layout = factory.CreateTextLayout(&wide, &format, f32::MAX / 4.0, f32::MAX / 4.0)?;
        // `fontVariantNumeric` (tabular figures in charts...).
        if font.variant.0 != 0 {
            let typography = factory.CreateTypography()?;
            for tag in font.variant.tags() {
                let b = tag.as_bytes();
                let tag = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                typography.AddFontFeature(DWRITE_FONT_FEATURE {
                    nameTag: DWRITE_FONT_FEATURE_TAG(tag),
                    parameter: 1,
                })?;
            }
            layout.SetTypography(
                &typography,
                DWRITE_TEXT_RANGE {
                    startPosition: 0,
                    length: wide.len() as u32,
                },
            )?;
        }
        let mut metrics = DWRITE_TEXT_METRICS::default();
        layout.GetMetrics(&mut metrics)?;
        let mut line = [DWRITE_LINE_METRICS::default()];
        let mut count = 0;
        layout.GetLineMetrics(Some(&mut line), &mut count)?;
        Ok(TextEntry {
            layout,
            width: metrics.widthIncludingTrailingWhitespace as f64,
            ascent: line[0].baseline as f64,
            height: line[0].height as f64,
        })
    }
}

/// The outlines of `layout`'s glyphs (in the layout's coordinates).
fn outline(
    factory: &ID2D1Factory1,
    layout: &IDWriteTextLayout,
) -> windows::core::Result<ID2D1Geometry> {
    let runs = Rc::new(RefCell::new(Vec::new()));
    let renderer: IDWriteTextRenderer = Outliner {
        factory: factory.clone(),
        runs: runs.clone(),
    }
    .into();
    // SAFETY: COM calls on live objects; the renderer only runs during
    // `Draw`.
    unsafe {
        layout.Draw(None, &renderer, 0.0, 0.0)?;
        let runs = runs.take();
        factory
            .CreateGeometryGroup(D2D1_FILL_MODE_WINDING, &runs)?
            .cast()
    }
}

/// A text renderer that collects the outlines of the glyph runs drawn.
#[windows_core::implement(IDWriteTextRenderer)]
struct Outliner {
    factory: ID2D1Factory1,
    runs: Rc<RefCell<Vec<Option<ID2D1Geometry>>>>,
}

impl IDWritePixelSnapping_Impl for Outliner_Impl {
    fn IsPixelSnappingDisabled(
        &self,
        _context: *const core::ffi::c_void,
    ) -> windows::core::Result<windows::core::BOOL> {
        Ok(true.into())
    }

    fn GetCurrentTransform(
        &self,
        _context: *const core::ffi::c_void,
        transform: *mut DWRITE_MATRIX,
    ) -> windows::core::Result<()> {
        // SAFETY: DirectWrite passes a valid out pointer.
        unsafe {
            transform.write(DWRITE_MATRIX {
                m11: 1.0,
                m12: 0.0,
                m21: 0.0,
                m22: 1.0,
                dx: 0.0,
                dy: 0.0,
            })
        };
        Ok(())
    }

    fn GetPixelsPerDip(&self, _context: *const core::ffi::c_void) -> windows::core::Result<f32> {
        Ok(1.0)
    }
}

impl IDWriteTextRenderer_Impl for Outliner_Impl {
    fn DrawGlyphRun(
        &self,
        _context: *const core::ffi::c_void,
        x: f32,
        y: f32,
        _mode: DWRITE_MEASURING_MODE,
        run: *const DWRITE_GLYPH_RUN,
        _description: *const DWRITE_GLYPH_RUN_DESCRIPTION,
        _effect: windows::core::Ref<windows::core::IUnknown>,
    ) -> windows::core::Result<()> {
        // SAFETY: DirectWrite passes a valid glyph run for the call's
        // duration; the font face is borrowed, not released.
        unsafe {
            let run = &*run;
            let Some(face) = run.fontFace.as_ref() else {
                return Ok(());
            };
            let path = self.factory.CreatePathGeometry()?;
            let sink = path.Open()?;
            face.GetGlyphRunOutline(
                run.fontEmSize,
                run.glyphIndices,
                (!run.glyphAdvances.is_null()).then_some(run.glyphAdvances),
                (!run.glyphOffsets.is_null()).then_some(run.glyphOffsets),
                run.glyphCount,
                run.isSideways.as_bool(),
                run.bidiLevel & 1 == 1,
                &sink,
            )?;
            sink.Close()?;
            let placed = self
                .factory
                .CreateTransformedGeometry(&path, &Matrix3x2::translation(x, y))?;
            self.runs.borrow_mut().push(Some(placed.cast()?));
        }
        Ok(())
    }

    fn DrawUnderline(
        &self,
        _context: *const core::ffi::c_void,
        _x: f32,
        _y: f32,
        _underline: *const DWRITE_UNDERLINE,
        _effect: windows::core::Ref<windows::core::IUnknown>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn DrawStrikethrough(
        &self,
        _context: *const core::ffi::c_void,
        _x: f32,
        _y: f32,
        _strikethrough: *const DWRITE_STRIKETHROUGH,
        _effect: windows::core::Ref<windows::core::IUnknown>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn DrawInlineObject(
        &self,
        _context: *const core::ffi::c_void,
        _x: f32,
        _y: f32,
        _object: windows::core::Ref<IDWriteInlineObject>,
        _sideways: windows::core::BOOL,
        _rtl: windows::core::BOOL,
        _effect: windows::core::Ref<windows::core::IUnknown>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(stops: &[(f32, u32)]) -> CanvasGradient {
        stops.iter().fold(
            CanvasGradient::conic(
                Radians(0.0),
                nsh_core::geometry::point(Points(0.0), Points(0.0)),
            ),
            |g, (o, c)| g.add_color_stop(Percentage(*o), Color(*c)),
        )
    }

    fn close(a: Pt, b: Pt) -> bool {
        (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
    }

    /// What `lists` draw on a transparent 100 × 60 bitmap, as BGRA bytes.
    fn pixels(gfx: &Gfx, lists: &[&ID2D1CommandList]) -> Vec<u8> {
        use windows::Win32::Graphics::{
            Direct2D::{
                Common::{
                    D2D_POINT_2U, D2D_RECT_U, D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED,
                    D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_CPU_READ,
                D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1, D2D1_MAP_OPTIONS_READ,
            },
            Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
        };
        let (w, h) = (100, 60);
        let props = |options: D2D1_BITMAP_OPTIONS| D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: options,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let size = D2D_SIZE_U {
            width: w,
            height: h,
        };
        // SAFETY: COM calls on live objects; the mapped memory is copied
        // before `Unmap`.
        unsafe {
            let target = gfx
                .dc
                .CreateBitmap(size, None, 0, &props(D2D1_BITMAP_OPTIONS_TARGET))
                .unwrap();
            gfx.dc.SetTarget(&target);
            gfx.dc.BeginDraw();
            gfx.dc.Clear(None);
            for list in lists {
                gfx.dc.DrawImage(
                    *list,
                    None,
                    None,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER,
                );
            }
            gfx.dc.EndDraw(None, None).unwrap();
            gfx.dc.SetTarget(None);
            let read = gfx
                .dc
                .CreateBitmap(
                    size,
                    None,
                    0,
                    &props(D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW),
                )
                .unwrap();
            read.CopyFromBitmap(
                Some(&D2D_POINT_2U { x: 0, y: 0 }),
                &target,
                Some(&D2D_RECT_U {
                    left: 0,
                    top: 0,
                    right: w,
                    bottom: h,
                }),
            )
            .unwrap();
            let mapped = read.Map(D2D1_MAP_OPTIONS_READ).unwrap();
            let mut data = Vec::new();
            for row in 0..h {
                let start = mapped.bits.add((row * mapped.pitch) as usize);
                data.extend_from_slice(std::slice::from_raw_parts(start, (w * 4) as usize));
            }
            read.Unmap().unwrap();
            data
        }
    }

    #[test]
    fn a_split_drawing_draws_what_the_whole_one_does() {
        let c = Num::Const;
        let ops = vec![
            CanvasOp::Save,
            CanvasOp::Translate(c(10.0), c(5.0)),
            CanvasOp::Path(PathOp::Rect([c(0.0), c(0.0), c(60.0), c(40.0)])),
            CanvasOp::Clip(None, FillRule::NonZero),
            CanvasOp::BeginPath,
            CanvasOp::FillStyle(Paint::Color(Color(0xff0000ff))),
            CanvasOp::FillRect([c(0.0), c(0.0), c(100.0), c(100.0)]),
            // Erased within the head, as the sparklines fade.
            CanvasOp::Composite(Composite::DestinationOut),
            CanvasOp::FillRect([c(0.0), c(0.0), c(15.0), c(40.0)]),
            CanvasOp::Composite(Composite::SourceOver),
            // The current path and the clip are the head's, painted by the
            // tail.
            CanvasOp::Path(PathOp::Arc {
                x: c(30.0),
                y: c(20.0),
                radius: c(12.0),
                start: c(0.0),
                end: c(TAU as f32),
                ccw: false,
            }),
            CanvasOp::GlobalAlpha(Num::Slot(0)),
            CanvasOp::FillStyle(Paint::Color(Color(0x0000ffff))),
            CanvasOp::Fill(None, FillRule::NonZero),
            CanvasOp::Restore,
            CanvasOp::FillRect([c(0.0), c(0.0), c(8.0), c(8.0)]),
        ];
        let drawing = Drawing {
            ops: ops.clone(),
            ..Drawing::default()
        };
        let at = split(&drawing);
        assert_eq!(at, 11);
        let Ok(gfx) = gfx::get() else {
            // No Direct3D device, not even WARP.
            return;
        };
        let images = FxHashMap::default();
        let mut text = TextCache::default();
        for alpha in [0.5, 1.0] {
            let args = [Some(AnimationValue::Number(alpha))];
            let whole = record(&gfx, &ops, 0, &args, &images, &mut text).unwrap();
            let head = record(&gfx, &ops[..at], 0, &args, &images, &mut text).unwrap();
            let tail = record(&gfx, &ops, at, &args, &images, &mut text).unwrap();
            let expected = pixels(&gfx, &[&whole]);
            assert_eq!(pixels(&gfx, &[&head, &tail]), expected);
            // The tail alone paints only the circle and the corner.
            let alone = pixels(&gfx, &[&tail]);
            let px = |data: &[u8], x: usize, y: usize| data[(y * 100 + x) * 4..][..4].to_vec();
            assert_eq!(px(&alone, 12, 7), [0, 0, 0, 0]);
            // Erased by the head.
            assert_eq!(px(&expected, 22, 40), [0, 0, 0, 0]);
            assert_eq!(px(&expected, 60, 40), [0, 0, 255, 255]);
            assert_eq!(px(&alone, 40, 25)[3], (alpha * 255.0) as u8);
        }
    }

    #[test]
    fn tails_that_combine_with_the_head_record_whole() {
        let c = Num::Const;
        let rect = |x| CanvasOp::FillRect([x, c(0.0), c(10.0), c(10.0)]);
        let at = |ops: Vec<CanvasOp>| {
            split(&Drawing {
                ops,
                ..Drawing::default()
            })
        };
        let multiply = CanvasOp::Composite(Composite::Multiply);
        let over = CanvasOp::Composite(Composite::SourceOver);
        // In effect where the tail starts.
        assert_eq!(
            at(vec![rect(c(0.0)), multiply.clone(), rect(Num::Slot(0))]),
            0
        );
        // Set in the tail.
        assert_eq!(
            at(vec![rect(c(0.0)), rect(Num::Slot(0)), multiply.clone()]),
            0
        );
        assert_eq!(
            at(vec![
                rect(c(0.0)),
                rect(Num::Slot(0)),
                CanvasOp::ClearRect([c(0.0); 4])
            ]),
            0
        );
        // Combined within the head, then back to source-over: the
        // sparklines' fade.
        assert_eq!(
            at(vec![
                rect(c(0.0)),
                multiply.clone(),
                rect(c(0.0)),
                over,
                rect(Num::Slot(0))
            ]),
            4
        );
        assert_eq!(
            at(vec![
                CanvasOp::Save,
                multiply,
                rect(c(0.0)),
                CanvasOp::Restore,
                rect(Num::Slot(0))
            ]),
            4
        );
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
        arc_cubics(0.0, std::f64::consts::PI, |c1, _, p| ends.push((c1, p)));
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
                0.125 * 1.0 + 0.375 * c1.0 + 0.375 * c2.0 + 0.125 * p.0,
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
        p.clear();
        assert!(p.segments.is_empty() && p.current.is_none());
        // Curves start at their first control point.
        p.cubic_to((3.0, 3.0), (4.0, 4.0), (5.0, 5.0));
        assert_eq!(p.segments[0], Seg::Move((3.0, 3.0)));
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
        let d = m.d2d();
        assert_eq!((d.M11, d.M22, d.M31, d.M32), (2.0, 3.0, 10.0, 20.0));
    }

    #[test]
    fn radial_gradients_map_to_one_ellipse() {
        // A point inside the circle: exact, with the origin offset.
        let r = radial([10.0, 10.0, 0.0, 20.0, 10.0, 30.0]).unwrap();
        assert_eq!(r.center, (20.0, 10.0));
        assert_eq!(r.offset, (-10.0, 0.0));
        assert_eq!((r.radius, r.inner, r.reversed), (30.0, 0.0, false));
        // Concentric circles move the stops.
        let r = radial([0.0, 0.0, 10.0, 0.0, 0.0, 40.0]).unwrap();
        assert_eq!(r.inner, 0.25);
        // A larger first circle runs backwards.
        let r = radial([0.0, 0.0, 40.0, 0.0, 0.0, 10.0]).unwrap();
        assert!(r.reversed && r.radius == 40.0 && r.inner == 0.25);
        // The origin stays inside.
        let r = radial([100.0, 0.0, 0.0, 0.0, 0.0, 10.0]).unwrap();
        assert!(r.offset.0 < 10.0 && r.offset.0 > 9.9);
        assert_eq!(radial([0.0, 0.0, 0.0, 0.0, 0.0, 0.0]), None);
    }

    #[test]
    fn gradient_stops_convert() {
        let red = Color(0xff0000ff);
        let blue = Color(0x0000ffff);
        let stops =
            [(0.0, red), (0.5, red), (0.5, blue), (1.0, blue)].map(|(o, c)| (Percentage(o), c));
        let s = gradient_stops(&stops, false, 0.0);
        assert_eq!(s.len(), 4);
        // Hard stops are kept apart, in order.
        assert!(s[2].position > s[1].position && s[2].position - s[1].position < 1e-4);
        assert_eq!(s[1].color.r, 1.0);
        assert_eq!(s[2].color.b, 1.0);
        // Reversed and moved into inner..1.
        let s = gradient_stops(
            &[(Percentage(0.0), red), (Percentage(1.0), blue)],
            true,
            0.5,
        );
        assert_eq!(s[0].position, 0.5);
        assert_eq!(s[0].color.b, 1.0);
        assert_eq!(s[1].position, 1.0);
        assert_eq!(s[1].color.r, 1.0);
    }

    #[test]
    fn dashes_are_in_line_widths() {
        assert_eq!(dash_pattern(&[], 2.0, 0.0), None);
        assert_eq!(dash_pattern(&[Points(0.0), Points(0.0)], 2.0, 0.0), None);
        assert_eq!(
            dash_pattern(&[Points(4.0), Points(2.0)], 2.0, 3.0),
            Some((vec![2.0, 1.0], 1.5))
        );
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

    #[test]
    fn composite_operations_map() {
        assert!(
            matches!(blend(Composite::Lighter), Blend::Composite(m) if m == D2D1_COMPOSITE_MODE_PLUS)
        );
        assert!(
            matches!(blend(Composite::Multiply), Blend::Blend(m) if m == D2D1_BLEND_MODE_MULTIPLY)
        );
        assert!(destructive(Composite::Copy) && destructive(Composite::SourceIn));
        assert!(!destructive(Composite::DestinationOut) && !destructive(Composite::Multiply));
    }
}
