//! `<Canvas>`: the recorded [`Drawing`] replayed with Core Graphics in
//! `drawRect:`.
//!
//! Canvas semantics differ from Core Graphics in a few places, so the
//! replay keeps its own state: the current path is built in the view's
//! space with the transform current when each piece is added (as in
//! canvas), and survives `fill` / `stroke`; strokes apply the current
//! transform again so line widths and dashes scale with it; gradients fill
//! by clipping to the shape. Animated value slots ([`CanvasState::args`])
//! are read while replaying: an animation only redraws, without JS.
//!
//! What comes before the first operation reading a slot paints the same
//! every time ([`first_animated`]). When it is long and the drawing stays
//! unchanged a while, it is rasterized once per drawing, size and scale into
//! a `CGLayer` ([`Prefix`]), and a redraw draws that layer and replays only
//! the painting from there on (the operations before it still set the
//! state), as Linux does. A frame of a pulsing dot over a chart then
//! replays the dot, not the chart under it. Short or changing drawings
//! replay whole: drawing a layer costs about what replaying a sparkline
//! does, and rasterizing one runs on the main thread, where a full replay
//! is only recorded for Core Animation's drawing threads.
//!
//! Where a canvas draws ([`CanvasState::draws_asynchronously`]): at once on
//! the main thread, unless it paints often ([`FREQUENT`] times a second or
//! more: an animation, live data) and keeps no layer, when Core Animation
//! replays it on its threads, which keeps the main thread free. Drawing
//! there costs graphics memory (~50 MB for the process on macOS 27, held
//! while any canvas draws so) and Metal work per layer, which a canvas
//! redrawn now and then (a chart updated every few seconds) gains nothing
//! from.
//!
//! Images are loaded through [`crate::image::load`] when a drawing names
//! them, kept per canvas and drawn once loaded, at their natural size in
//! pixels as points (as a canvas bitmap's CSS pixels).

use std::{
    cell::{Cell, RefCell},
    f64::consts::TAU,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::{
    Color, FontVariant,
    animation::AnimationValue,
    canvas::{
        CanvasFont, CanvasGradient, CanvasOp, CanvasTextAlign, CanvasTextBaseline, Composite,
        Damage, DamageScan, Drawing, FillRule, GradientShape, LineCap, LineJoin, Num, Paint,
        PathOp, arc_sweep, first_animated, fit_radii, prefix_path_needed,
    },
    geometry::{Corners, Points, Radians, size},
};
use objc2_core_foundation::{
    CFAttributedString, CFMutableAttributedString, CFRange, CFRetained, CFString, CFType,
    CGAffineTransform, CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBlendMode, CGContext, CGGradient, CGGradientDrawingOptions, CGImage, CGLayer, CGLineCap,
    CGLineJoin, CGMutablePath, CGPath, CGTextDrawingMode,
};
use objc2_core_text::{CTLine, kCTFontAttributeName, kCTForegroundColorFromContextAttributeName};
use rustc_hash::FxHashMap;

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

/// What a canvas draws.
#[derive(Default)]
pub(crate) struct CanvasState {
    /// The drawing.
    drawing: Option<Arc<Drawing>>,
    /// Animated value slots (`AnimationProp::CanvasArg`).
    args: Vec<Option<AnimationValue>>,
    /// The images the drawing names, by URI: `None` while loading (or
    /// when they failed to load).
    images: FxHashMap<Arc<str>, Option<CFRetained<CGImage>>>,
    /// Finds what a change of slots redraws ([`set_args`]).
    scan: DamageScan,
    /// The slots that changed (scratch space of [`set_args`]).
    changed: Vec<u16>,
    /// The first operation reading an animated slot ([`first_animated`]),
    /// and whether the path the operations before it build is needed from
    /// it on ([`prefix_path_needed`]).
    split: usize,
    split_path: bool,
    /// What the operations before `split` paint, when some do and some
    /// do not.
    prefix: RefCell<Option<Prefix>>,
    /// How often the drawing was painted since it was set.
    redrawn: Cell<u32>,
    /// How often it paints ([`CanvasState::draws_asynchronously`]).
    cadence: Cadence,
}

/// How many paints a second make a canvas draw on Core Animation's threads.
const FREQUENT: u32 = 10;

/// How often a canvas paints, counted a second at a time.
#[derive(Default)]
struct Cadence {
    /// When the current second began, and its paints so far.
    since: Cell<Option<Instant>>,
    paints: Cell<u32>,
    /// [`FREQUENT`] paints in the current second, or in the last one.
    frequent: Cell<bool>,
}

impl Cadence {
    /// A paint at `now`.
    fn paint(&self, now: Instant) {
        match self.since.get() {
            Some(since) if now.duration_since(since) < Duration::from_secs(1) => {
                let paints = self.paints.get() + 1;
                self.paints.set(paints);
                if paints >= FREQUENT {
                    self.frequent.set(true);
                }
            }
            since => {
                // A new second: the last one was slow, or a second without
                // paints came between.
                if since.is_some_and(|since| {
                    self.paints.get() < FREQUENT
                        || now.duration_since(since) >= Duration::from_secs(2)
                }) {
                    self.frequent.set(false);
                }
                self.since.set(Some(now));
                self.paints.set(1);
            }
        }
    }
}

/// How often a drawing is painted unchanged before its static part is kept
/// ([`Prefix`]): one that keeps changing (a sparkline of live quotes) would
/// rasterize it on the main thread more often than it draws from it.
const STABLE: u32 = 30;

/// The fewest operations before the first animated one that are kept as a
/// layer: drawing one costs about as much as replaying a sparkline's 74
/// (measured on the Stocks demo).
const MIN_PREFIX: usize = 128;

/// The pixels of a drawing's operations before its first animated one, at
/// a size and scale.
struct Prefix {
    drawing: Arc<Drawing>,
    /// The size in pixels, and how many of the drawing's images had loaded.
    size: (usize, usize),
    images: usize,
    layer: CFRetained<CGLayer>,
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
        c.split = first_animated(&drawing.ops);
        // Short static parts replay faster than a layer draws.
        if c.split < MIN_PREFIX || !drawing.ops[..c.split].iter().any(CanvasOp::paints) {
            c.split = 0;
        }
        c.split_path = prefix_path_needed(&drawing.ops, c.split);
        c.redrawn.set(0);
        c.drawing = Some(drawing);
    }
    for uri in load {
        let view = view.clone();
        let key = uri.clone();
        crate::image::load(surface, &uri, move |result| {
            let image = match result {
                Ok(image) => image,
                Err(e) => {
                    log::warn!("canvas: {e}");
                    return;
                }
            };
            {
                let mut state = view.state_mut();
                let Some(slot) = state.canvas.as_mut().and_then(|c| c.images.get_mut(&key)) else {
                    return;
                };
                *slot = Some(image);
            }
            view.changed();
        });
    }
    // The mounter draws it, when it shows.
    view.restyle();
}

/// Animated value slots changed (`(slot, value)`, every bound slot on each
/// frame): what has to be drawn again ([`crate::mount::Mounter::draw_when_shown`]).
/// Only the operations reading a slot whose value changed are redrawn,
/// where they were and where they are now ([`DamageScan`]).
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) -> Damage {
    let mut state = view.state_mut();
    let Some(CanvasState {
        drawing,
        args,
        scan,
        changed,
        ..
    }) = state.canvas.as_mut()
    else {
        return Damage::None;
    };
    changed.clear();
    for &(k, value) in values {
        let i = k as usize;
        if args.get(i).copied().flatten() != Some(value) {
            changed.push(k);
        }
    }
    if changed.is_empty() {
        return Damage::None;
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
    if before == Damage::All {
        return before;
    }
    let after = scan.damage(ops, |s| slot_number(args, s), is_changed);
    before.union(after)
}

/// The number in slot `s` (0 while unset).
fn slot_number(args: &[Option<AnimationValue>], s: u16) -> f32 {
    args.get(s as usize)
        .copied()
        .flatten()
        .map_or(0.0, AnimationValue::number)
}

/// Draws a canvas view's drawing (in its content layer's
/// `drawLayer:inContext:`; the context is y down, in points, `size` points
/// at `scale` pixels each) where it is `dirty`: Core Graphics skips the
/// rest.
pub(crate) fn draw(
    cx: &CGContext,
    state: &ViewState,
    dirty: CGRect,
    size: CGSize,
    scale: f64,
    asynchronous: bool,
) {
    if let Some(canvas) = state.canvas.as_ref() {
        canvas.paint(cx, dirty, size, scale, asynchronous);
    }
}

impl CanvasState {
    /// Whether the static part is (or is about to be) kept as a layer:
    /// long, painted unchanged [`STABLE`] times. Such a canvas draws at once
    /// (`drawsAsynchronously` off), where its layer is made.
    pub(crate) fn keeps_prefix(&self) -> bool {
        0 < self.split && self.redrawn.get() >= STABLE
    }

    /// Whether Core Animation draws it on its threads
    /// (`drawsAsynchronously`): when it paints often and keeps no layer.
    pub(crate) fn draws_asynchronously(&self) -> bool {
        self.cadence.frequent.get() && !self.keeps_prefix()
    }

    /// [`draw`]'s replay; `asynchronous`: `cx` records for Core Animation's
    /// drawing threads.
    fn paint(&self, cx: &CGContext, dirty: CGRect, size: CGSize, scale: f64, asynchronous: bool) {
        self.cadence.paint(Instant::now());
        let canvas = self;
        let Some(drawing) = canvas.drawing.as_ref() else {
            return;
        };
        let ops = &drawing.ops[..];
        if ops.is_empty() {
            return;
        }
        let split = canvas.split.min(ops.len());
        let prefix = (0 < split && split < ops.len())
            .then(|| canvas.prefix(cx, drawing, split, size, scale, asynchronous))
            .flatten();
        let mut replay = Replay::new(cx, canvas);
        // Clearing and composite operations combine with what the canvas drew,
        // as on a canvas bitmap: never with what is behind it (AppKit may draw
        // views into one context, as when caching a display for a snapshot).
        let isolated = ops.iter().any(|op| {
            matches!(op, CanvasOp::ClearRect(_))
                || matches!(op, CanvasOp::Composite(c) if *c != Composite::SourceOver)
        });
        CGContext::save_g_state(Some(cx));
        // Core Animation clips to what it redraws already; said again for the
        // transparency layer, which takes the clip's size.
        CGContext::clip_to_rect(Some(cx), dirty);
        if isolated {
            // SAFETY: no auxiliary info.
            unsafe { CGContext::begin_transparency_layer(Some(cx), None) };
        }
        if let Some(layer) = &prefix {
            // The layer holds the canvas y down at the layer's scale, as the
            // replay draws; layers draw y up.
            CGContext::save_g_state(Some(cx));
            CGContext::translate_ctm(Some(cx), 0.0, size.height);
            CGContext::scale_ctm(Some(cx), 1.0, -1.0);
            CGContext::draw_layer_in_rect(Some(cx), CGRect::new(CGPoint::ZERO, size), Some(layer));
            CGContext::restore_g_state(Some(cx));
        }
        for (i, op) in ops.iter().enumerate() {
            // What the layer holds: the operations before `split` only set
            // the state, and build the path when it is used from `split` on.
            if prefix.is_some()
                && i < split
                && (op.paints()
                    || (!canvas.split_path
                        && matches!(op, CanvasOp::BeginPath | CanvasOp::Path(_))))
            {
                continue;
            }
            replay.op(op);
        }
        if isolated {
            CGContext::end_transparency_layer(Some(cx));
        }
        CGContext::restore_g_state(Some(cx));
    }

    /// What `drawing`'s operations before `split` paint at `size` and
    /// `scale`, in a layer made for `cx`, once it was painted [`STABLE`]
    /// times: kept until one of them changes, or an image loads.
    fn prefix(
        &self,
        cx: &CGContext,
        drawing: &Arc<Drawing>,
        split: usize,
        size: CGSize,
        scale: f64,
        asynchronous: bool,
    ) -> Option<CFRetained<CGLayer>> {
        let px = (
            (size.width * scale).ceil() as usize,
            (size.height * scale).ceil() as usize,
        );
        if px.0 == 0 || px.1 == 0 {
            return None;
        }
        let images = self.images.values().filter(|i| i.is_some()).count();
        let mut prefix = self.prefix.borrow_mut();
        if let Some(p) = &*prefix
            && Arc::ptr_eq(&p.drawing, drawing)
            && p.size == px
            && p.images == images
        {
            return Some(p.layer.clone());
        }
        let redrawn = self.redrawn.get();
        self.redrawn.set(redrawn.saturating_add(1));
        // Made for the context it is drawn into: once the layer draws at
        // once.
        if redrawn < STABLE || asynchronous {
            return None;
        }
        // In pixels: a layer takes its size in the user space of the
        // context it is made for, not its device's.
        // SAFETY: no auxiliary info.
        let layer = unsafe {
            CGLayer::with_context(
                Some(cx),
                CGSize::new(px.0 as CGFloat, px.1 as CGFloat),
                None,
            )
        }?;
        let context = CGLayer::context(Some(&layer))?;
        // y down, in points, as the layer's context.
        CGContext::translate_ctm(Some(&context), 0.0, px.1 as CGFloat);
        CGContext::scale_ctm(Some(&context), scale, -scale);
        let mut replay = Replay::new(&context, self);
        for op in &drawing.ops[..split] {
            replay.op(op);
        }
        drop(replay);
        *prefix = Some(Prefix {
            drawing: drawing.clone(),
            size: px,
            images,
            layer: layer.clone(),
        });
        Some(layer)
    }
}

/// An affine transform `[a, b, c, d, e, f]` (canvas order: `x' = a x + c y
/// + e`).
#[derive(Clone, Copy)]
struct Affine([f64; 6]);

impl Affine {
    const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    /// `self` then `m` applied first (canvas `transform`: post-multiply).
    fn then(self, m: [f64; 6]) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [ma, mb, mc, md, me, mf] = m;
        Affine([
            a * ma + c * mb,
            b * ma + d * mb,
            a * mc + c * md,
            b * mc + d * md,
            a * me + c * mf + e,
            b * me + d * mf + f,
        ])
    }

    fn inverse(self) -> Option<Affine> {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        if det.abs() < 1e-12 || !det.is_finite() {
            return None;
        }
        Some(Affine([
            d / det,
            -b / det,
            -c / det,
            a / det,
            (c * f - d * e) / det,
            (b * e - a * f) / det,
        ]))
    }

    fn cg(self) -> CGAffineTransform {
        let [a, b, c, d, tx, ty] = self.0;
        CGAffineTransform { a, b, c, d, tx, ty }
    }
}

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
    shadow: (Color, f64, f64, f64),
    font: CanvasFont,
    /// `fontVariantNumeric`.
    numeric: FontVariant,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
    ctm: Affine,
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
            numeric: FontVariant::default(),
            align: CanvasTextAlign::Start,
            baseline: CanvasTextBaseline::Alphabetic,
            ctm: Affine::IDENTITY,
        }
    }
}

struct Replay<'a> {
    c: &'a CGContext,
    args: &'a [Option<AnimationValue>],
    images: &'a FxHashMap<Arc<str>, Option<CFRetained<CGImage>>>,
    state: State,
    stack: Vec<State>,
    /// The current path, in the view's space.
    path: CFRetained<CGMutablePath>,
}

/// What fills or strokes.
#[derive(Clone, Copy)]
enum Mode {
    Fill(FillRule),
    Stroke,
}

impl<'a> Replay<'a> {
    fn new(c: &'a CGContext, canvas: &'a CanvasState) -> Self {
        Replay {
            c,
            args: &canvas.args,
            images: &canvas.images,
            state: State::default(),
            stack: Vec::new(),
            path: CGMutablePath::new(),
        }
    }

    fn cx(&self) -> Option<&'a CGContext> {
        Some(self.c)
    }

    fn n(&self, n: Num) -> f64 {
        n.get(|s| slot_number(self.args, s)) as f64
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

    fn op(&mut self, op: &CanvasOp) {
        let c = self.cx();
        match op {
            CanvasOp::Save => {
                self.stack.push(self.state.clone());
                CGContext::save_g_state(c);
            }
            CanvasOp::Restore => {
                if let Some(s) = self.stack.pop() {
                    self.state = s;
                    CGContext::restore_g_state(c);
                }
            }
            CanvasOp::Translate(x, y) => {
                let m = [1.0, 0.0, 0.0, 1.0, self.n(*x), self.n(*y)];
                self.state.ctm = self.state.ctm.then(m);
            }
            CanvasOp::Scale(x, y) => {
                let m = [self.n(*x), 0.0, 0.0, self.n(*y), 0.0, 0.0];
                self.state.ctm = self.state.ctm.then(m);
            }
            CanvasOp::Rotate(a) => {
                let (s, co) = self.n(*a).sin_cos();
                self.state.ctm = self.state.ctm.then([co, s, -s, co, 0.0, 0.0]);
            }
            CanvasOp::Transform(m) => {
                let m = m.map(|v| self.n(v));
                self.state.ctm = self.state.ctm.then(m);
            }
            CanvasOp::SetTransform(m) => {
                self.state.ctm = Affine(m.map(|v| self.n(v)));
            }
            CanvasOp::BeginPath => self.path = CGMutablePath::new(),
            CanvasOp::Path(p) => {
                let path = self.path.clone();
                self.add_path_op(&path, p, self.state.ctm);
            }
            CanvasOp::Fill(path, rule) => {
                let path = self.resolve(path.as_deref());
                self.paint(&path, Mode::Fill(*rule));
            }
            CanvasOp::Stroke(path) => {
                let path = self.resolve(path.as_deref());
                self.paint(&path, Mode::Stroke);
            }
            CanvasOp::Clip(path, rule) => {
                let path = self.resolve(path.as_deref());
                CGContext::add_path(c, Some(&path));
                match rule {
                    FillRule::NonZero => CGContext::clip(c),
                    FillRule::EvenOdd => CGContext::eo_clip(c),
                }
            }
            CanvasOp::FillRect(r) => {
                let path = self.rect_path(r);
                self.paint(&path, Mode::Fill(FillRule::NonZero));
            }
            CanvasOp::StrokeRect(r) => {
                let path = self.rect_path(r);
                self.paint(&path, Mode::Stroke);
            }
            CanvasOp::ClearRect(r) => {
                let path = self.rect_path(r);
                CGContext::save_g_state(c);
                CGContext::add_path(c, Some(&path));
                CGContext::clip(c);
                let bounds = CGPath::bounding_box(Some(&path));
                CGContext::clear_rect(c, bounds);
                CGContext::restore_g_state(c);
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
            CanvasOp::Font(f) => self.state.font = f.clone(),
            CanvasOp::FontVariantNumeric(v) => self.state.numeric = *v,
            CanvasOp::TextAlign(a) => self.state.align = *a,
            CanvasOp::TextBaseline(b) => self.state.baseline = *b,
            CanvasOp::FillText {
                text,
                x,
                y,
                max_width,
            } => self.text(text, self.n(*x), self.n(*y), max_width.map(|m| m.0), false),
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            } => self.text(text, self.n(*x), self.n(*y), max_width.map(|m| m.0), true),
            CanvasOp::DrawImage {
                image,
                source,
                dest,
            } => self.image(
                &image.uri,
                source.map(|b| [b.origin.x, b.origin.y, b.size.width, b.size.height].map(|v| v.0)),
                dest,
            ),
        }
    }

    /// `path`, or the current path.
    fn resolve(&self, path: Option<&[PathOp]>) -> CFRetained<CGMutablePath> {
        match path {
            None => self.path.clone(),
            Some(ops) => {
                let p = CGMutablePath::new();
                for op in ops {
                    self.add_path_op(&p, op, self.state.ctm);
                }
                p
            }
        }
    }

    fn rect_path(&self, r: &[Num; 4]) -> CFRetained<CGMutablePath> {
        let p = CGMutablePath::new();
        let m = self.state.ctm.cg();
        let [x, y, w, h] = r.map(|v| self.n(v));
        // SAFETY: a valid path and transform.
        unsafe {
            CGMutablePath::add_rect(
                Some(&p),
                &m,
                CGRect::new(CGPoint::new(x, y), CGSize::new(w, h)),
            )
        };
        p
    }

    /// Adds `op` to `path`, transformed by `ctm`.
    fn add_path_op(&self, path: &CGMutablePath, op: &PathOp, ctm: Affine) {
        let p = Some(path);
        let m = ctm.cg();
        let n = |v: Num| self.n(v);
        // SAFETY: a valid path; every transform pointer points at a live
        // local.
        unsafe {
            match op {
                PathOp::MoveTo(x, y) => CGMutablePath::move_to_point(p, &m, n(*x), n(*y)),
                PathOp::LineTo(x, y) => {
                    if CGPath::is_empty(Some(path)) {
                        CGMutablePath::move_to_point(p, &m, n(*x), n(*y));
                    } else {
                        CGMutablePath::add_line_to_point(p, &m, n(*x), n(*y));
                    }
                }
                PathOp::QuadTo(v) => {
                    let [cx, cy, x, y] = v.map(n);
                    self.ensure_point(path, &m, cx, cy);
                    CGMutablePath::add_quad_curve_to_point(p, &m, cx, cy, x, y);
                }
                PathOp::CubicTo(v) => {
                    let [c1x, c1y, c2x, c2y, x, y] = v.map(n);
                    self.ensure_point(path, &m, c1x, c1y);
                    CGMutablePath::add_curve_to_point(p, &m, c1x, c1y, c2x, c2y, x, y);
                }
                PathOp::Arc {
                    x,
                    y,
                    radius,
                    start,
                    end,
                    ccw,
                } => {
                    let r = n(*radius).max(0.0);
                    let start = n(*start);
                    let sweep =
                        arc_sweep(Radians(start as f32), Radians(n(*end) as f32), *ccw).0 as f64;
                    // Increasing angles turn clockwise on a y-down screen,
                    // which is CoreGraphics' counterclockwise.
                    CGMutablePath::add_arc(
                        p,
                        &m,
                        n(*x),
                        n(*y),
                        r,
                        start,
                        start + sweep,
                        sweep < 0.0,
                    );
                }
                PathOp::ArcTo(v) => {
                    let [x1, y1, x2, y2, r] = v.map(n);
                    if CGPath::is_empty(Some(path)) {
                        CGMutablePath::move_to_point(p, &m, x1, y1);
                    }
                    CGMutablePath::add_arc_to_point(p, &m, x1, y1, x2, y2, r.max(0.0));
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
                    let (s, c) = rotation.sin_cos();
                    // The unit circle, scaled, rotated and moved.
                    let unit = ctm
                        .then([1.0, 0.0, 0.0, 1.0, x, y])
                        .then([c, s, -s, c, 0.0, 0.0])
                        .then([rx.max(1e-9), 0.0, 0.0, ry.max(1e-9), 0.0, 0.0])
                        .cg();
                    let start = n(*start);
                    let sweep =
                        arc_sweep(Radians(start as f32), Radians(n(*end) as f32), *ccw).0 as f64;
                    CGMutablePath::add_arc(
                        p,
                        &unit,
                        0.0,
                        0.0,
                        1.0,
                        start,
                        start + sweep,
                        sweep < 0.0,
                    );
                }
                PathOp::Rect(v) => {
                    let [x, y, w, h] = v.map(n);
                    CGMutablePath::add_rect(
                        p,
                        &m,
                        CGRect::new(CGPoint::new(x, y), CGSize::new(w, h)),
                    );
                }
                PathOp::RoundRect(rect, radii) => {
                    let [x, y, w, h] = rect.map(n);
                    let [tl, tr, br, bl] = fit_corners(w, h, radii.map(n));
                    CGMutablePath::move_to_point(p, &m, x + tl, y);
                    CGMutablePath::add_arc_to_point(p, &m, x + w, y, x + w, y + h, tr);
                    CGMutablePath::add_arc_to_point(p, &m, x + w, y + h, x, y + h, br);
                    CGMutablePath::add_arc_to_point(p, &m, x, y + h, x, y, bl);
                    CGMutablePath::add_arc_to_point(p, &m, x, y, x + w, y, tl);
                    CGMutablePath::close_subpath(p);
                    CGMutablePath::move_to_point(p, &m, x, y);
                }
                PathOp::Close => CGMutablePath::close_subpath(p),
            }
        }
    }

    /// Curves on an empty path start at their first control point (canvas
    /// "ensure there is a subpath").
    fn ensure_point(&self, path: &CGMutablePath, m: &CGAffineTransform, x: f64, y: f64) {
        if CGPath::is_empty(Some(path)) {
            // SAFETY: a valid path and transform.
            unsafe { CGMutablePath::move_to_point(Some(path), m, x, y) };
        }
    }

    /// Whether the current state casts a shadow.
    fn shadowed(&self) -> bool {
        let (color, blur, x, y) = self.state.shadow;
        color.0 & 0xff != 0 && (blur > 0.0 || x != 0.0 || y != 0.0)
    }

    /// Alpha, blend mode and shadow of the current state, for one draw.
    fn compositing(&self) {
        let c = self.cx();
        let s = &self.state;
        CGContext::set_alpha(c, s.alpha);
        CGContext::set_blend_mode(c, blend(s.composite));
        let (color, blur, x, y) = s.shadow;
        if self.shadowed() {
            let color = crate::text::cg_color(color);
            // Shadow offsets are in the layer's base space, which is y up
            // under AppKit's flipped context: a positive offset goes down.
            CGContext::set_shadow_with_color(c, CGSize::new(x, -y), blur, Some(&color));
        }
    }

    /// Fills or strokes `path` (in the view's space) with the state's paint.
    fn paint(&self, path: &CGMutablePath, mode: Mode) {
        let c = self.cx();
        let s = &self.state;
        CGContext::save_g_state(c);
        self.compositing();
        let paint = match mode {
            Mode::Fill(_) => &s.fill,
            Mode::Stroke => &s.stroke,
        };
        // A gradient is drawn through a clip, which would clip its shadow
        // too: drawn in a transparency layer, the shadow falls from what
        // the layer holds.
        let layered = self.color(paint).is_none() && self.shadowed();
        if layered {
            // SAFETY: a valid context; ended below, before the state is
            // restored.
            unsafe { CGContext::begin_transparency_layer(c, None) };
        }
        match mode {
            Mode::Fill(rule) => {
                CGContext::add_path(c, Some(path));
                match self.color(paint) {
                    Some(color) => {
                        CGContext::set_fill_color_with_color(
                            c,
                            Some(&crate::text::cg_color(color)),
                        );
                        match rule {
                            FillRule::NonZero => CGContext::fill_path(c),
                            FillRule::EvenOdd => CGContext::eo_fill_path(c),
                        }
                    }
                    None => {
                        match rule {
                            FillRule::NonZero => CGContext::clip(c),
                            FillRule::EvenOdd => CGContext::eo_clip(c),
                        }
                        CGContext::concat_ctm(c, s.ctm.cg());
                        self.gradient(paint);
                    }
                }
            }
            Mode::Stroke => {
                // Stroke in user space: widths and dashes follow the
                // transform.
                let Some(inverse) = s.ctm.inverse() else {
                    CGContext::restore_g_state(c);
                    return;
                };
                CGContext::concat_ctm(c, s.ctm.cg());
                let m = inverse.cg();
                // SAFETY: a valid path and transform.
                let local = unsafe { CGPath::new_copy_by_transforming_path(Some(path), &m) };
                CGContext::add_path(c, local.as_deref());
                CGContext::set_line_width(c, s.line_width);
                CGContext::set_line_cap(
                    c,
                    match s.cap {
                        LineCap::Butt => CGLineCap::Butt,
                        LineCap::Round => CGLineCap::Round,
                        LineCap::Square => CGLineCap::Square,
                    },
                );
                CGContext::set_line_join(
                    c,
                    match s.join {
                        LineJoin::Miter => CGLineJoin::Miter,
                        LineJoin::Round => CGLineJoin::Round,
                        LineJoin::Bevel => CGLineJoin::Bevel,
                    },
                );
                CGContext::set_miter_limit(c, s.miter);
                if !s.dash.is_empty() {
                    let lengths: Vec<CGFloat> = s.dash.iter().map(|&d| d.0 as CGFloat).collect();
                    // SAFETY: `lengths` outlives the call.
                    unsafe {
                        CGContext::set_line_dash(c, s.dash_offset, lengths.as_ptr(), lengths.len())
                    };
                }
                match self.color(paint) {
                    Some(color) => {
                        CGContext::set_stroke_color_with_color(
                            c,
                            Some(&crate::text::cg_color(color)),
                        );
                        CGContext::stroke_path(c);
                    }
                    None => {
                        CGContext::replace_path_with_stroked_path(c);
                        CGContext::clip(c);
                        self.gradient(paint);
                    }
                }
            }
        }
        if layered {
            CGContext::end_transparency_layer(c);
        }
        CGContext::restore_g_state(c);
    }

    /// Draws a gradient paint over the clip (in user space).
    fn gradient(&self, paint: &Paint) {
        let Paint::Gradient(g) = paint else { return };
        let c = self.cx();
        if g.stops.is_empty() {
            return;
        }
        let options = CGGradientDrawingOptions::DrawsBeforeStartLocation
            | CGGradientDrawingOptions::DrawsAfterEndLocation;
        match g.shape {
            GradientShape::Linear { start, end } => {
                let [x0, y0, x1, y1] = [start.x, start.y, end.x, end.y].map(|v| v.0);
                let Some(gradient) = cg_gradient(g) else {
                    return;
                };
                CGContext::draw_linear_gradient(
                    c,
                    Some(&gradient),
                    CGPoint::new(x0 as f64, y0 as f64),
                    CGPoint::new(x1 as f64, y1 as f64),
                    options,
                );
            }
            GradientShape::Radial {
                start,
                start_radius,
                end,
                end_radius,
            } => {
                let [x0, y0, r0, x1, y1, r1] =
                    [start.x, start.y, start_radius, end.x, end.y, end_radius].map(|v| v.0);
                let Some(gradient) = cg_gradient(g) else {
                    return;
                };
                CGContext::draw_radial_gradient(
                    c,
                    Some(&gradient),
                    CGPoint::new(x0 as f64, y0 as f64),
                    r0 as f64,
                    CGPoint::new(x1 as f64, y1 as f64),
                    r1 as f64,
                    options,
                );
            }
            GradientShape::Conic {
                start_angle,
                center,
            } => conic(
                c,
                g,
                start_angle.0 as f64,
                center.x.0 as f64,
                center.y.0 as f64,
            ),
        }
    }

    fn text(&self, text: &str, x: f64, y: f64, max_width: Option<f32>, stroke: bool) {
        if text.is_empty() {
            return;
        }
        let c = self.cx();
        let s = &self.state;
        let font = crate::text::make_font(&s.font.with_numeric(s.numeric).text_style());
        let string =
            CFMutableAttributedString::new(None, 0).expect("CFAttributedStringCreateMutable");
        let whole = CFRange {
            location: 0,
            length: 0,
        };
        // SAFETY: a valid mutable string; attribute values have the types
        // CoreText expects for their keys; the range covers the string.
        unsafe {
            CFMutableAttributedString::replace_string(
                Some(&string),
                whole,
                Some(&CFString::from_str(text)),
            );
            let range = CFRange {
                location: 0,
                length: CFAttributedString::length(&string),
            };
            CFMutableAttributedString::set_attribute(
                Some(&string),
                range,
                Some(kCTFontAttributeName),
                Some(font.as_ref()),
            );
            let yes: &CFType = objc2_core_foundation::CFBoolean::new(true).as_ref();
            CFMutableAttributedString::set_attribute(
                Some(&string),
                range,
                Some(kCTForegroundColorFromContextAttributeName),
                Some(yes),
            );
        }
        // SAFETY: a valid attributed string.
        let line = unsafe { CTLine::with_attributed_string(&string) };
        let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
        // SAFETY: valid out pointers.
        let width = unsafe { line.typographic_bounds(&mut ascent, &mut descent, &mut leading) };
        let dx = match s.align {
            CanvasTextAlign::Start | CanvasTextAlign::Left => 0.0,
            CanvasTextAlign::Center => -width / 2.0,
            CanvasTextAlign::End | CanvasTextAlign::Right => -width,
        };
        // How far below the given y the baseline goes.
        let down = match s.baseline {
            CanvasTextBaseline::Alphabetic => 0.0,
            CanvasTextBaseline::Top => ascent,
            CanvasTextBaseline::Hanging => ascent * 0.8,
            CanvasTextBaseline::Middle => (ascent - descent) / 2.0,
            CanvasTextBaseline::Ideographic | CanvasTextBaseline::Bottom => -descent,
        };
        let squeeze = match max_width {
            Some(m) if (m as f64) < width && width > 0.0 => (m as f64 / width).max(0.0),
            _ => 1.0,
        };
        CGContext::save_g_state(c);
        self.compositing();
        CGContext::concat_ctm(c, s.ctm.cg());
        CGContext::translate_ctm(c, x, y + down);
        // CoreText draws y up.
        CGContext::scale_ctm(c, squeeze, -1.0);
        CGContext::set_text_matrix(c, Affine::IDENTITY.cg());
        CGContext::set_text_position(c, dx, 0.0);
        let paint = if stroke { &s.stroke } else { &s.fill };
        let color = self.color(paint);
        if stroke {
            CGContext::set_line_width(c, s.line_width);
            CGContext::set_text_drawing_mode(c, CGTextDrawingMode::Stroke);
            if let Some(color) = color {
                CGContext::set_stroke_color_with_color(c, Some(&crate::text::cg_color(color)));
            }
        } else if let Some(color) = color {
            CGContext::set_fill_color_with_color(c, Some(&crate::text::cg_color(color)));
        }
        match color {
            // SAFETY: a valid line and context.
            Some(_) => unsafe { line.draw(self.c) },
            None => {
                // Gradient text: the glyphs clip, then the gradient fills.
                CGContext::set_text_drawing_mode(
                    c,
                    if stroke {
                        CGTextDrawingMode::StrokeClip
                    } else {
                        CGTextDrawingMode::Clip
                    },
                );
                // SAFETY: a valid line and context.
                unsafe { line.draw(self.c) };
                // Back to canvas space for the gradient's coordinates.
                CGContext::scale_ctm(c, 1.0 / squeeze, -1.0);
                CGContext::translate_ctm(c, -x, -(y + down));
                self.gradient(paint);
            }
        }
        CGContext::restore_g_state(c);
    }

    fn image(&self, uri: &str, source: Option<[f32; 4]>, dest: &[Num; 4]) {
        let Some(Some(image)) = self.images.get(uri) else {
            return;
        };
        let mut part: Option<CFRetained<CGImage>> = None;
        // Pixels as points, as a canvas bitmap's CSS pixels.
        let size = (
            CGImage::width(Some(image)) as f64,
            CGImage::height(Some(image)) as f64,
        );
        let [dx, dy, mut dw, mut dh] = dest.map(|v| self.n(v));
        if let Some([sx, sy, sw, sh]) = source {
            let rect = CGRect::new(
                CGPoint::new(sx as f64, sy as f64),
                CGSize::new(sw as f64, sh as f64),
            );
            part = CGImage::with_image_in_rect(Some(image), rect);
            if part.is_none() {
                return;
            }
            if dw.is_nan() {
                dw = sw as f64;
            }
            if dh.is_nan() {
                dh = sh as f64;
            }
        }
        if dw.is_nan() {
            dw = size.0;
        }
        if dh.is_nan() {
            dh = size.1;
        }
        let c = self.cx();
        CGContext::save_g_state(c);
        self.compositing();
        CGContext::concat_ctm(c, self.state.ctm.cg());
        // Core Graphics images draw y up.
        CGContext::translate_ctm(c, dx, dy + dh);
        CGContext::scale_ctm(c, 1.0, -1.0);
        let drawn: &CGImage = part.as_deref().unwrap_or(image);
        CGContext::draw_image(
            c,
            CGRect::new(CGPoint::ZERO, CGSize::new(dw, dh)),
            Some(drawn),
        );
        CGContext::restore_g_state(c);
    }
}

fn blend(c: Composite) -> CGBlendMode {
    use Composite::*;
    match c {
        SourceOver => CGBlendMode::Normal,
        SourceIn => CGBlendMode::SourceIn,
        SourceOut => CGBlendMode::SourceOut,
        SourceAtop => CGBlendMode::SourceAtop,
        DestinationOver => CGBlendMode::DestinationOver,
        DestinationIn => CGBlendMode::DestinationIn,
        DestinationOut => CGBlendMode::DestinationOut,
        DestinationAtop => CGBlendMode::DestinationAtop,
        Lighter => CGBlendMode::PlusLighter,
        Copy => CGBlendMode::Copy,
        Xor => CGBlendMode::XOR,
        Multiply => CGBlendMode::Multiply,
        Screen => CGBlendMode::Screen,
        Overlay => CGBlendMode::Overlay,
        Darken => CGBlendMode::Darken,
        Lighten => CGBlendMode::Lighten,
        ColorDodge => CGBlendMode::ColorDodge,
        ColorBurn => CGBlendMode::ColorBurn,
        HardLight => CGBlendMode::HardLight,
        SoftLight => CGBlendMode::SoftLight,
        Difference => CGBlendMode::Difference,
        Exclusion => CGBlendMode::Exclusion,
        Hue => CGBlendMode::Hue,
        Saturation => CGBlendMode::Saturation,
        Color => CGBlendMode::Color,
        Luminosity => CGBlendMode::Luminosity,
    }
}

/// The gradient's stops as a CoreGraphics gradient (sRGB).
fn cg_gradient(g: &CanvasGradient) -> Option<CFRetained<CGGradient>> {
    let space = objc2_core_graphics::CGColorSpace::new_device_rgb()?;
    let mut components = Vec::with_capacity(g.stops.len() * 4);
    let mut locations = Vec::with_capacity(g.stops.len());
    for (offset, color) in &g.stops {
        let (r, gr, b, a) = color.to_f64();
        components.extend_from_slice(&[r, gr, b, a]);
        locations.push(offset.0 as CGFloat);
    }
    // SAFETY: four components per location, both arrays live for the call.
    unsafe {
        CGGradient::with_color_components(
            Some(&space),
            components.as_ptr(),
            locations.as_ptr(),
            locations.len(),
        )
    }
}

/// The gradient's color at `t` (0..1).
fn stop_color(g: &CanvasGradient, t: f32) -> Color {
    let stops = &g.stops;
    if t <= stops[0].0.0 {
        return stops[0].1;
    }
    for w in stops.windows(2) {
        let ((o0, c0), (o1, c1)) = (w[0], w[1]);
        let (o0, o1) = (o0.0, o1.0);
        if t <= o1 {
            let f = if o1 > o0 { (t - o0) / (o1 - o0) } else { 1.0 };
            return lerp(c0, c1, f);
        }
    }
    stops[stops.len() - 1].1
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

/// A conic gradient as thin wedges around `(x, y)`, over the clip
/// (Core Graphics' own needs macOS 15).
fn conic(c: Option<&CGContext>, g: &CanvasGradient, angle: f64, x: f64, y: f64) {
    const WEDGES: usize = 360;
    // Far enough to cover any clip.
    let r = 1e5;
    for i in 0..WEDGES {
        let t0 = i as f64 / WEDGES as f64;
        let t1 = (i + 1) as f64 / WEDGES as f64;
        let color = stop_color(g, ((t0 + t1) / 2.0) as f32);
        let p = CGMutablePath::new();
        // SAFETY: a valid path; a null transform is the identity.
        unsafe {
            CGMutablePath::move_to_point(Some(&p), std::ptr::null(), x, y);
            // Slightly overlapping wedges hide antialiasing seams.
            CGMutablePath::add_arc(
                Some(&p),
                std::ptr::null(),
                x,
                y,
                r,
                angle + t0 * TAU,
                angle + t1 * TAU + 0.002,
                false,
            );
            CGMutablePath::close_subpath(Some(&p));
            CGContext::add_path(c, Some(&p));
        }
        CGContext::set_fill_color_with_color(c, Some(&crate::text::cg_color(color)));
        CGContext::fill_path(c);
    }
}

/// [`fit_radii`] on CoreGraphics' numbers: top left, top right, bottom
/// right, bottom left.
fn fit_corners(w: f64, h: f64, radii: [f64; 4]) -> [f64; 4] {
    let [top_left, top_right, bottom_right, bottom_left] = radii.map(|r| Points(r as f32));
    let fit = fit_radii(
        size(Points(w as f32), Points(h as f32)),
        Corners {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        },
    );
    [
        fit.top_left,
        fit.top_right,
        fit.bottom_right,
        fit.bottom_left,
    ]
    .map(|r| f64::from(r.0))
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        canvas::PathOp,
        geometry::{Percentage, Point},
    };
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo,
        CGImageByteOrderInfo,
    };

    use super::*;

    /// A sparkline as the Stocks demo draws it: a gradient fill, faded in
    /// by `destination-out`, a stroke, then a pulsing ring (slots 0 and 1).
    fn sparkline() -> Arc<Drawing> {
        let c = Num::Const;
        let line = |ops: &mut Vec<CanvasOp>| {
            ops.push(CanvasOp::Path(PathOp::MoveTo(c(4.0), c(30.0))));
            for (x, y) in [(20.0, 12.0), (40.0, 26.0), (60.0, 8.0), (90.0, 18.0)] {
                ops.push(CanvasOp::Path(PathOp::LineTo(c(x), c(y))));
            }
        };
        let gradient = |(x0, y0): (f32, f32), (x1, y1): (f32, f32), from: u32, to: u32| {
            CanvasGradient::linear(
                Point::new(Points(x0), Points(y0)),
                Point::new(Points(x1), Points(y1)),
            )
            .add_color_stop(Percentage(0.0), Color(from))
            .add_color_stop(Percentage(1.0), Color(to))
        };
        let fade = gradient((0.0, 0.0), (20.0, 0.0), 0x000000ff, 0x00000000);
        let gradient = gradient((0.0, 8.0), (0.0, 36.0), 0x30a46c55, 0x30a46c00);
        let mut ops = vec![CanvasOp::BeginPath];
        line(&mut ops);
        ops.extend([
            CanvasOp::Path(PathOp::LineTo(c(90.0), c(36.0))),
            CanvasOp::Path(PathOp::LineTo(c(4.0), c(36.0))),
            CanvasOp::Path(PathOp::Close),
            CanvasOp::FillStyle(Paint::Gradient(Arc::new(gradient))),
            CanvasOp::Fill(None, FillRule::NonZero),
            CanvasOp::Composite(Composite::DestinationOut),
            CanvasOp::FillStyle(Paint::Gradient(Arc::new(fade))),
            CanvasOp::FillRect([c(0.0), c(0.0), c(20.0), c(40.0)]),
            CanvasOp::Composite(Composite::SourceOver),
            CanvasOp::BeginPath,
        ]);
        line(&mut ops);
        ops.extend([
            CanvasOp::StrokeStyle(Paint::Color(Color(0x30a46cff))),
            CanvasOp::LineWidth(c(1.5)),
            CanvasOp::Stroke(None),
            CanvasOp::GlobalAlpha(Num::Slot(1)),
            CanvasOp::FillStyle(Paint::Color(Color(0x30a46cff))),
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::Arc {
                x: c(90.0),
                y: c(18.0),
                radius: Num::Slot(0),
                start: c(0.0),
                end: c(TAU as f32),
                ccw: false,
            }),
            CanvasOp::Fill(None, FillRule::NonZero),
        ]);
        Arc::new(Drawing {
            ops,
            ..Drawing::default()
        })
    }

    /// `canvas` painted into a fresh 100 × 40 point bitmap at scale 2.
    fn pixels(canvas: &CanvasState) -> Vec<u8> {
        let (w, h, scale) = (100.0, 40.0, 2.0);
        let (pw, ph) = (200, 80);
        let space = CGColorSpace::new_device_rgb().unwrap();
        // SAFETY: a context with pixels of its own, read after drawing.
        unsafe {
            let cx = CGBitmapContextCreate(
                std::ptr::null_mut(),
                pw,
                ph,
                8,
                pw * 4,
                Some(&space),
                CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0,
            )
            .unwrap();
            CGContext::translate_ctm(Some(&cx), 0.0, ph as CGFloat);
            CGContext::scale_ctm(Some(&cx), scale, -scale);
            let size = CGSize::new(w, h);
            canvas.paint(&cx, CGRect::new(CGPoint::ZERO, size), size, scale, false);
            let data = CGBitmapContextGetData(Some(&cx)).cast::<u8>();
            std::slice::from_raw_parts(data, pw * ph * 4).to_vec()
        }
    }

    fn sparkline_canvas(radius: f32) -> CanvasState {
        let drawing = sparkline();
        let mut canvas = CanvasState {
            split: first_animated(&drawing.ops),
            split_path: prefix_path_needed(&drawing.ops, first_animated(&drawing.ops)),
            drawing: Some(drawing),
            redrawn: Cell::new(STABLE),
            ..CanvasState::default()
        };
        canvas.args = vec![
            Some(AnimationValue::Number(radius)),
            Some(AnimationValue::Number(0.4)),
        ];
        canvas
    }

    #[test]
    fn a_canvas_painting_often_draws_asynchronously() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        // Redrawn every 2 s: at once.
        let rare = Cadence::default();
        for n in 0..5 {
            rare.paint(at(n * 2000));
        }
        assert!(!rare.frequent.get());
        // An animation at 120 Hz: on Core Animation's threads from its
        // tenth frame.
        let animated = Cadence::default();
        for n in 0..9 {
            animated.paint(at(n * 8));
        }
        assert!(!animated.frequent.get());
        animated.paint(at(72));
        assert!(animated.frequent.get());
        for n in 10..240 {
            animated.paint(at(n * 8));
        }
        assert!(animated.frequent.get());
        // It stops: the next paint, a second on, draws at once again.
        animated.paint(at(240 * 8 + 3000));
        assert!(!animated.frequent.get());
        // A canvas keeping its static part draws at once however often.
        let mut canvas = sparkline_canvas(5.0);
        canvas.cadence.frequent.set(true);
        canvas.split = MIN_PREFIX;
        assert!(!canvas.draws_asynchronously());
        canvas.redrawn.set(0);
        assert!(canvas.draws_asynchronously());
    }

    #[test]
    fn the_static_part_is_drawn_from_its_layer() {
        // Not before the drawing has been painted unchanged a while.
        let fresh = sparkline_canvas(5.0);
        fresh.redrawn.set(0);
        pixels(&fresh);
        assert!(fresh.prefix.borrow().is_none());
        let canvas = sparkline_canvas(5.0);
        assert!(0 < canvas.split && canvas.split < canvas.drawing.as_ref().unwrap().ops.len());
        assert!(!canvas.split_path, "the ring begins a path of its own");
        let kept = pixels(&canvas);
        assert!(canvas.prefix.borrow().is_some());
        // The whole drawing replayed, nothing kept.
        let mut whole = sparkline_canvas(5.0);
        whole.split = 0;
        let replayed = pixels(&whole);
        assert!(replayed.iter().any(|&b| b != 0));
        assert_eq!(kept, replayed);
        // The ring grows: the layer is kept, the ring drawn anew.
        let mut canvas = canvas;
        canvas.args[0] = Some(AnimationValue::Number(8.0));
        let layer = canvas.prefix.borrow().as_ref().map(|p| p.layer.clone());
        let grown = pixels(&canvas);
        let again = canvas.prefix.borrow().as_ref().map(|p| p.layer.clone());
        assert!(
            matches!((layer, again), (Some(a), Some(b)) if CFRetained::as_ptr(&a) == CFRetained::as_ptr(&b))
        );
        whole.args[0] = Some(AnimationValue::Number(8.0));
        assert_eq!(grown, pixels(&whole));
    }
}
