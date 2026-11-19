//! `<canvas>`: replays a [`Drawing`] with CoreGraphics in `drawRect:`.
//!
//! Canvas semantics differ from CoreGraphics in a few places, so the
//! replay keeps its own state: the current path is built in the view's
//! space with the transform current when each piece is added (as in
//! canvas), and survives `fill` / `stroke`; strokes apply the current
//! transform again so line widths and dashes scale with it; gradients fill
//! by clipping to the shape. Animated value slots are read from
//! [`CanvasViewIvars::values`], which the mounter updates on animation
//! frames.
//!
//! `OffscreenCanvas` renders replay the same way into a bitmap of their own
//! ([`offscreen`]).

use std::{cell::RefCell, f64::consts::TAU, sync::Arc};

use nsh_core::{
    Color, FontVariant,
    animation::AnimationValue,
    canvas::{
        CanvasFont, CanvasGradient, CanvasOp, CanvasTextAlign, CanvasTextBaseline, Composite,
        Damage, DamageScan, Drawing, FillRule, GradientShape, LineCap, LineJoin, Num, Paint,
        PathOp, arc_sweep, fit_radii,
    },
    geometry::{Corners, Points, Radians, size},
};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_core_foundation::{
    CFAttributedString, CFMutableAttributedString, CFRange, CFRetained, CFString, CFType,
    CGAffineTransform, CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBlendMode, CGContext, CGGradient, CGGradientDrawingOptions, CGImage, CGLineCap, CGLineJoin,
    CGMutablePath, CGPath, CGTextDrawingMode,
};
use objc2_core_text::{CTLine, kCTFontAttributeName, kCTForegroundColorFromContextAttributeName};
use objc2_foundation::NSObject;
use objc2_ui_kit::{UIGraphicsGetCurrentContext, UIImage, UIResponder, UIView};
use rustc_hash::FxHashMap;

use crate::native_view::NshView;

mod offscreen;

pub(crate) use offscreen::{Offscreen, RenderRequest};

#[derive(Default)]
pub(crate) struct CanvasViewIvars {
    drawing: RefCell<Option<Arc<Drawing>>>,
    /// Current values of the drawing's animated value slots.
    values: RefCell<Vec<AnimationValue>>,
    /// Images it draws, by URI, once loaded.
    images: RefCell<Images>,
    /// Finds what a change of slots redraws ([`CanvasView::set_values`]).
    scan: RefCell<DamageScan>,
    /// This frame's slot values (scratch space of
    /// [`CanvasView::set_values`]).
    pending: RefCell<Vec<(u16, AnimationValue)>>,
    /// The slots that changed (scratch space too).
    changed: RefCell<Vec<u16>>,
}

define_class!(
    /// Draws a canvas drawing recorded in JS.
    #[unsafe(super(NshView, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = CanvasViewIvars]
    pub(crate) struct CanvasView;

    impl CanvasView {
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: CGRect) {
            let drawing = self.ivars().drawing.borrow();
            let Some(drawing) = drawing.as_ref() else { return };
            let Some(cx) = UIGraphicsGetCurrentContext() else { return };
            let values = self.ivars().values.borrow();
            let images = self.ivars().images.borrow();
            // UIKit's drawing contexts take shadows in the view's own
            // space (points, y down): no transform to the base space.
            paint(&cx, drawing, &values, &images, Affine::IDENTITY.cg());
        }
    }
);

/// The images a drawing draws, by URI.
type Images = FxHashMap<Arc<str>, Retained<UIImage>>;

/// Replays `drawing` into `cx`, whose space is the canvas's (points, y
/// down), its animated slots read from `values` (0 when missing): what a
/// canvas view draws, and an offscreen render ([`offscreen`]) too. `base`
/// takes the canvas's space to the context's base space, in which Core
/// Graphics takes shadow offsets and blurs (no transform reaches them).
/// Any thread: Core Graphics, Core Text and `UIImage` are thread-safe.
fn paint(
    cx: &CGContext,
    drawing: &Drawing,
    values: &[AnimationValue],
    images: &Images,
    base: CGAffineTransform,
) {
    let mut replay = Replay {
        c: cx,
        base,
        values,
        images,
        state: State::default(),
        stack: Vec::new(),
        path: CGMutablePath::new(),
    };
    CGContext::save_g_state(Some(cx));
    for op in &drawing.ops {
        replay.op(op);
    }
    CGContext::restore_g_state(Some(cx));
}

impl CanvasView {
    pub(crate) fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(CanvasViewIvars::default());
        // SAFETY: NshView's `initWithFrame:` initializes its ivars, then UIView.
        let view: Retained<Self> = unsafe {
            msg_send![super(this), initWithFrame: CGRect::new(CGPoint::ZERO, CGSize::ZERO)]
        };
        view.setOpaque(false);
        // Drawings scale with the view: draw again when it resizes.
        view.setContentMode(objc2_ui_kit::UIViewContentMode::Redraw);
        view
    }

    pub(crate) fn set_drawing(&self, drawing: Arc<Drawing>) {
        // Images no longer drawn are let go.
        self.ivars()
            .images
            .borrow_mut()
            .retain(|uri, _| drawing.images().any(|i| &i.uri == uri));
        *self.ivars().drawing.borrow_mut() = Some(drawing);
        self.setNeedsDisplay();
    }

    pub(crate) fn has_image(&self, uri: &str) -> bool {
        self.ivars().images.borrow().contains_key(uri)
    }

    pub(crate) fn set_image(&self, uri: Arc<str>, image: Retained<UIImage>) {
        self.ivars().images.borrow_mut().insert(uri, image);
        self.setNeedsDisplay();
    }

    /// Sets the drawing's animated value slots (`(slot, value)`, every
    /// bound slot on each frame) and draws again what changed: only the
    /// operations reading a slot whose value changed, where they were and
    /// where they are now ([`DamageScan`]).
    pub(crate) fn set_values(&self, values: impl Iterator<Item = (u16, AnimationValue)>) {
        let ivars = self.ivars();
        let mut new = ivars.pending.borrow_mut();
        let mut changed = ivars.changed.borrow_mut();
        new.clear();
        new.extend(values);
        let mut slots = ivars.values.borrow_mut();
        changed.clear();
        for &(k, value) in new.iter() {
            if slots.get(k as usize) != Some(&value) {
                changed.push(k);
            }
        }
        if changed.is_empty() {
            return;
        }
        let drawing = ivars.drawing.borrow();
        let ops = drawing.as_ref().map_or(&[][..], |d| &d.ops[..]);
        let mut scan = ivars.scan.borrow_mut();
        let is_changed = |s: u16| changed.contains(&s);
        let before = scan.damage(ops, |s| slot_number(&slots, s), is_changed);
        for &(k, value) in new.iter() {
            let i = k as usize;
            if slots.len() <= i {
                slots.resize(i + 1, AnimationValue::Number(0.0));
            }
            slots[i] = value;
        }
        let damage = match before {
            Damage::All => before,
            _ => before.union(scan.damage(ops, |s| slot_number(&slots, s), is_changed)),
        };
        match damage {
            Damage::None => {}
            Damage::Rect(r) => self.setNeedsDisplayInRect(CGRect::new(
                CGPoint::new(r.origin.x.0 as CGFloat, r.origin.y.0 as CGFloat),
                CGSize::new(r.size.width.0 as CGFloat, r.size.height.0 as CGFloat),
            )),
            Damage::All => self.setNeedsDisplay(),
        }
    }
}

/// The number in slot `s` (0 while unset).
fn slot_number(values: &[AnimationValue], s: u16) -> f32 {
    values.get(s as usize).map_or(0.0, |v| v.number())
}

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
    /// The canvas's space in the context's base space ([`paint`]).
    base: CGAffineTransform,
    values: &'a [AnimationValue],
    images: &'a Images,
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
    fn cx(&self) -> Option<&'a CGContext> {
        Some(self.c)
    }

    fn n(&self, n: Num) -> f64 {
        n.get(|s| slot_number(self.values, s)) as f64
    }

    fn color(&self, paint: &Paint) -> Option<Color> {
        match paint {
            Paint::Color(c) => Some(*c),
            Paint::Slot(s) => match self.values.get(*s as usize) {
                Some(AnimationValue::Color(c)) => Some(Color(*c)),
                _ => None,
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
                image.density(),
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
            // Shadow offsets and blurs are in the context's base space, which
            // no transform reaches: taken there from the canvas's space.
            let m = self.base;
            let offset = CGSize::new(m.a * x + m.c * y, m.b * x + m.d * y);
            let scale = (m.a * m.d - m.b * m.c).abs().sqrt();
            CGContext::set_shadow_with_color(c, offset, blur * scale, Some(&color));
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

    fn image(&self, uri: &str, density: f32, source: Option<[f32; 4]>, dest: &[Num; 4]) {
        let Some(image) = self.images.get(uri) else {
            return;
        };
        // Animated images draw their first frame.
        // SAFETY: plain getters.
        let cg = unsafe {
            image.CGImage().or_else(|| {
                image
                    .images()
                    .and_then(|f| f.firstObject())
                    .and_then(|f| f.CGImage())
            })
        };
        let Some(cg) = cg else { return };
        let mut part: Option<CFRetained<CGImage>> = None;
        // Its pixels over its file name's density (`@3x`), as an `Image`'s,
        // never over the `UIImage`'s scale: that is the screen's the image
        // was loaded for, so the same image would draw at another size on a
        // 2x and a 3x device.
        let density = f64::from(density);
        let size = natural_size(&cg, density);
        let [dx, dy, mut dw, mut dh] = dest.map(|v| self.n(v));
        if let Some([sx, sy, sw, sh]) = source {
            let rect = CGRect::new(
                CGPoint::new(sx as f64, sy as f64),
                CGSize::new(sw as f64, sh as f64),
            );
            part = CGImage::with_image_in_rect(Some(&cg), rect);
            if part.is_none() {
                return;
            }
            if dw.is_nan() {
                dw = sw as f64 / density;
            }
            if dh.is_nan() {
                dh = sh as f64 / density;
            }
        }
        if dw.is_nan() {
            dw = size.width;
        }
        if dh.is_nan() {
            dh = size.height;
        }
        let c = self.cx();
        CGContext::save_g_state(c);
        self.compositing();
        CGContext::concat_ctm(c, self.state.ctm.cg());
        // CoreGraphics images draw y up.
        CGContext::translate_ctm(c, dx, dy + dh);
        CGContext::scale_ctm(c, 1.0, -1.0);
        let drawn: &CGImage = part.as_deref().unwrap_or(&cg);
        CGContext::draw_image(
            c,
            CGRect::new(CGPoint::ZERO, CGSize::new(dw, dh)),
            Some(drawn),
        );
        CGContext::restore_g_state(c);
    }
}

/// An image's natural size in a canvas, in points: its pixels over
/// `density`.
fn natural_size(image: &CGImage, density: CGFloat) -> CGSize {
    CGSize::new(
        CGImage::width(Some(image)) as CGFloat / density,
        CGImage::height(Some(image)) as CGFloat / density,
    )
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
/// (CoreGraphics' own needs iOS 18).
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
        canvas::{CanvasImage, CanvasOp, Drawing, Num},
        geometry::{Bounds, Point, ScaledPixels, Size},
    };
    use nsh_platform_apple::canvas_image::bitmap_context;
    use objc2_core_graphics::{CGBitmapContextCreateImage, CGBitmapContextGetData};
    use objc2_ui_kit::UIImageOrientation;

    use super::*;

    /// A `w` × `h` pixel opaque image, as a `UIImage` loaded for a screen of
    /// `scale` pixels per point.
    fn image(w: usize, h: usize, scale: CGFloat) -> Retained<UIImage> {
        let cx = bitmap_context(w, h).unwrap();
        CGContext::set_rgb_fill_color(Some(&cx), 1.0, 0.0, 0.0, 1.0);
        CGContext::fill_rect(
            Some(&cx),
            CGRect::new(CGPoint::ZERO, CGSize::new(w as CGFloat, h as CGFloat)),
        );
        let cg = CGBitmapContextCreateImage(Some(&cx)).unwrap();
        UIImage::imageWithCGImage_scale_orientation(&cg, scale, UIImageOrientation::Up)
    }

    /// The extent in points, from the top left, of what `ops` cover when
    /// painted at `scale` pixels per point into a 200 × 200 point bitmap.
    fn covered(ops: Vec<CanvasOp>, images: &Images, scale: usize) -> (usize, usize) {
        let side = 200 * scale;
        let cx = bitmap_context(side, side).unwrap();
        CGContext::translate_ctm(Some(&cx), 0.0, side as CGFloat);
        CGContext::scale_ctm(Some(&cx), scale as CGFloat, -(scale as CGFloat));
        let base = CGContext::ctm(Some(&cx));
        let drawing = Drawing {
            ops,
            ..Drawing::default()
        };
        paint(&cx, &drawing, &[], images, base);
        let image = CGBitmapContextCreateImage(Some(&cx)).unwrap();
        let cx = bitmap_context(side, side).unwrap();
        // SAFETY: the bitmap Core Graphics allocated holds `side * side * 4`
        // bytes while the context lives; read after drawing the image in.
        let pixels = unsafe {
            CGContext::draw_image(
                Some(&cx),
                CGRect::new(CGPoint::ZERO, CGSize::new(side as CGFloat, side as CGFloat)),
                Some(&image),
            );
            let data = CGBitmapContextGetData(Some(&cx)).cast::<u8>();
            std::slice::from_raw_parts(data, side * side * 4).to_vec()
        };
        // Rows run top down in memory (the bitmap's y up, drawn upright).
        let alpha = |x: usize, y: usize| pixels[(y * side + x) * 4 + 3];
        let w = (0..side).take_while(|&x| alpha(x, 0) > 0).count();
        let h = (0..side).take_while(|&y| alpha(0, y) > 0).count();
        (w / scale, h / scale)
    }

    fn draw(uri: &str, source: Option<[f32; 4]>) -> CanvasOp {
        let nan = Num::Const(f32::NAN);
        CanvasOp::DrawImage {
            image: CanvasImage { uri: uri.into() },
            source: source.map(|[x, y, w, h]| Bounds {
                origin: Point::new(ScaledPixels(x), ScaledPixels(y)),
                size: Size {
                    width: ScaledPixels(w),
                    height: ScaledPixels(h),
                },
            }),
            dest: [Num::Const(0.0), Num::Const(0.0), nan, nan],
        }
    }

    #[test]
    fn an_image_draws_its_pixels_over_its_file_density_on_every_screen() {
        // 120 × 60 pixels, as `dot.png` and `dot@3x.png`, loaded for a 1x,
        // 2x and 3x screen, painted at 1, 2 and 3 pixels per point (a canvas
        // view, an offscreen render): 120 × 60 and 40 × 20 points always.
        for (uri, size, part) in [
            ("asset:/dot.png", (120, 60), (90, 36)),
            ("asset:/dot@3x.png", (40, 20), (30, 12)),
        ] {
            for loaded in [1.0, 2.0, 3.0] {
                let images: Images = [(Arc::from(uri), image(120, 60, loaded))]
                    .into_iter()
                    .collect();
                for scale in [1, 2, 3] {
                    assert_eq!(
                        covered(vec![draw(uri, None)], &images, scale),
                        size,
                        "{uri} loaded at {loaded}x, painted at {scale}x"
                    );
                    // A part of it, its source in the image's pixels.
                    let source = Some([30.0, 0.0, 90.0, 36.0]);
                    assert_eq!(
                        covered(vec![draw(uri, source)], &images, scale),
                        part,
                        "a part of {uri}, loaded at {loaded}x, painted at {scale}x"
                    );
                }
            }
        }
    }
}
