//! SVGs as canvas drawings ([`drawing`]): what `element::svg` shows. The
//! document is parsed with usvg as the rasters are, and its tree is
//! recorded as the canvas's vector operations, which every platform
//! replays at its device pixels: an SVG stays sharp at any size and scale.
//!
//! The paints that were `currentColor` take the canvas view's text color
//! when it is drawn ([`ViewPaint::FillCurrentColor`]): usvg resolves
//! `currentColor` while it parses, so the root gets a `color` of a color
//! the document does not write (where it sets none itself), and the paints
//! of that color are the ones that inherited it.
//!
//! What a canvas has no operation for is drawn as near as it can be: a
//! group's opacity multiplies its shapes' (exact where they do not
//! overlap), its blend mode is each shape's composite operation, a clip
//! path of several shapes clips to them as one path (by `nonzero`),
//! gradients pad (`spreadMethod` aside), a gradient stop of `currentColor`
//! is black, and a radial gradient stretched by its transform strokes with
//! its circle. Masks and filters are left out (what they apply to is drawn
//! as it is), a pattern paints nothing, and `<text>` and `<image>` are not
//! drawn, as in the rasters.

use std::sync::Arc;

use resvg::usvg::{self, tiny_skia_path};

use super::Error;
use crate::{
    canvas::{
        CanvasGradient, CanvasOp, Composite, Drawing, FillRule, GradientShape, LineCap, LineJoin,
        Num, Paint, Path, PathOp, ViewBoxFit, ViewPaint,
    },
    geometry::{Bounds, Percentage, Point, Points, Size, point, px},
    style::Color,
};

/// The most operations a drawing of an SVG may hold: shared clip paths
/// are recorded each time they are used, so a small document could
/// otherwise make an enormous drawing.
const MAX_OPS: usize = 1 << 20;

/// Colors the root's `color` may get to find the paints that inherit it
/// (`currentColor`): the first one the document does not write.
const SENTINELS: [(u8, u8, u8); 4] = [
    (0x01, 0xfe, 0x7c),
    (0xfd, 0x02, 0x9b),
    (0x7d, 0x03, 0xfc),
    (0x02, 0x7e, 0xfb),
];

/// The SVG document `source` as a drawing in the coordinates of its
/// `viewBox`, fitted into the canvas's box as `preserveAspectRatio` says
/// ([`ViewPaint::Fit`]; an SVG without a `viewBox` scales as an image of
/// its size does): the canvas lays out at the SVG's size where its style
/// sets none. Its `currentColor` is the canvas's text color.
pub fn drawing(source: &str) -> Result<Drawing, Error> {
    super::guarded(|| {
        if source.len() > super::MAX_BYTES {
            return Err(Error::TooLarge);
        }
        let doc = super::xml(source)?;
        let root = doc.root_element();
        let lower = source.to_ascii_lowercase();
        let sentinel = SENTINELS
            .into_iter()
            .find(|&(r, g, b)| !lower.contains(&format!("{r:02x}{g:02x}{b:02x}")))
            .unwrap_or(SENTINELS[0]);
        let (r, g, b) = sentinel;
        // A root `color` of the document's own is what `currentColor`
        // inherits: nothing follows the view then.
        let marked;
        let text = if root.attribute("color").is_none() {
            let at = super::root_attributes_at(&doc, source);
            marked = format!(
                "{} color=\"#{r:02x}{g:02x}{b:02x}\"{}",
                &source[..at],
                &source[at..]
            );
            &marked[..]
        } else {
            source
        };
        let tree = super::parse_with(text.as_bytes(), &super::options())?;
        let size = tree.size();
        let natural = Size::new(px(size.width()), px(size.height()));
        let view_box =
            view_box(root.attribute("viewBox")).unwrap_or(Bounds::new(Point::default(), natural));
        let (align, slice) = aspect_ratio(root.attribute("preserveAspectRatio"));
        let fit = ViewBoxFit {
            view_box,
            align,
            slice,
            size: natural,
        };
        // usvg maps the view box onto the SVG's size; the drawing stays in
        // the view box's coordinates, mapped onto the canvas's box.
        let [sx, ky, kx, sy, tx, ty] = fit.transform(natural);
        let into_size = tiny_skia_path::Transform::from_row(sx, ky, kx, sy, tx, ty);
        let mut out = Recorder {
            drawing: Drawing::default(),
            current: usvg::Color::new_rgb(r, g, b),
        };
        out.view_paint(
            ViewPaint::Fit(fit),
            CanvasOp::Transform([Num::Const(0.0); 6]),
        );
        if let Some(back) = into_size.invert() {
            out.transform(back);
        }
        out.group(tree.root(), 1.0)?;
        Ok(out.drawing)
    })
}

/// A `viewBox` of a positive width and height.
fn view_box(value: Option<&str>) -> Option<Bounds<Points>> {
    let numbers: Vec<f32> = value?
        .split(|c: char| c.is_ascii_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let [x, y, w, h] = numbers[..] else {
        return None;
    };
    (w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite())
        .then(|| Bounds::new(point(px(x), px(y)), Size::new(px(w), px(h))))
}

/// `preserveAspectRatio`: where the view box sits along each axis (`None`
/// for `none`) and whether it slices; `xMidYMid meet` by default.
fn aspect_ratio(value: Option<&str>) -> (Option<(Percentage, Percentage)>, bool) {
    let mut words = value
        .unwrap_or_default()
        .split_ascii_whitespace()
        .skip_while(|&w| w == "defer");
    let at = |s: &str| match s {
        "Min" => Some(Percentage(0.0)),
        "Mid" => Some(Percentage(0.5)),
        "Max" => Some(Percentage(1.0)),
        _ => None,
    };
    let align = match words.next() {
        Some("none") => None,
        Some(w) if w.len() == 8 && w.starts_with('x') && w.as_bytes()[4] == b'Y' => {
            match (at(&w[1..4]), at(&w[5..8])) {
                (Some(x), Some(y)) => Some((x, y)),
                _ => Some((Percentage(0.5), Percentage(0.5))),
            }
        }
        _ => Some((Percentage(0.5), Percentage(0.5))),
    };
    (align, words.next() == Some("slice"))
}

/// Records usvg's tree as canvas operations.
struct Recorder {
    drawing: Drawing,
    /// The root's `color` (`currentColor`).
    current: usvg::Color,
}

impl Recorder {
    fn op(&mut self, op: CanvasOp) {
        self.drawing.ops.push(op);
    }

    fn view_paint(&mut self, view: ViewPaint, placeholder: CanvasOp) {
        let at = self.drawing.ops.len() as u32;
        self.drawing.view_paints.push((at, view));
        self.op(placeholder);
    }

    fn transform(&mut self, ts: tiny_skia_path::Transform) {
        if !ts.is_identity() {
            self.op(CanvasOp::Transform(
                [ts.sx, ts.ky, ts.kx, ts.sy, ts.tx, ts.ty].map(Num::Const),
            ));
        }
    }

    fn group(&mut self, group: &usvg::Group, alpha: f32) -> Result<(), Error> {
        let alpha = alpha * group.opacity().get();
        if alpha <= 0.0 {
            return Ok(());
        }
        if self.drawing.ops.len() > MAX_OPS {
            return Err(Error::TooManyNodes);
        }
        if group.mask().is_some() {
            log::warn!("svg: a mask is not drawn; what it masks is drawn whole");
        }
        if !group.filters().is_empty() {
            log::warn!("svg: a filter is not drawn; what it filters is drawn unfiltered");
        }
        self.op(CanvasOp::Save);
        self.transform(group.transform());
        if let Some(composite) = composite(group.blend_mode()) {
            self.op(CanvasOp::Composite(composite));
        }
        if let Some(clip) = group.clip_path() {
            self.clip(clip);
        }
        for node in group.children() {
            match node {
                usvg::Node::Group(g) => self.group(g, alpha)?,
                usvg::Node::Path(p) => self.path(p, alpha),
                // No fonts or images are loaded.
                usvg::Node::Image(_) | usvg::Node::Text(_) => {}
            }
        }
        self.op(CanvasOp::Restore);
        Ok(())
    }

    /// Clips to `clip` (and the clip path it is clipped by), its shapes as
    /// one path.
    fn clip(&mut self, clip: &usvg::ClipPath) {
        if let Some(inner) = clip.clip_path() {
            self.clip(inner);
        }
        let mut ops = Vec::new();
        let mut rules = Vec::new();
        collect_clip(clip.root(), clip.transform(), &mut ops, &mut rules);
        let rule = match rules[..] {
            [rule] => rule,
            _ => FillRule::NonZero,
        };
        self.op(CanvasOp::Clip(Some(ops.into()), rule));
    }

    fn path(&mut self, path: &usvg::Path, alpha: f32) {
        if !path.is_visible() {
            return;
        }
        let data = path_ops(path.data());
        let fill = |this: &mut Self| {
            if let Some(fill) = path.fill() {
                let rule = fill_rule(fill.rule());
                let alpha = alpha * fill.opacity().get();
                this.paint(fill.paint(), alpha, Target::Fill(rule), path.data(), &data);
            }
        };
        let stroke = |this: &mut Self| {
            if let Some(stroke) = path.stroke() {
                this.line_style(stroke);
                let alpha = alpha * stroke.opacity().get();
                this.paint(stroke.paint(), alpha, Target::Stroke, path.data(), &data);
            }
        };
        match path.paint_order() {
            usvg::PaintOrder::FillAndStroke => {
                fill(self);
                stroke(self);
            }
            usvg::PaintOrder::StrokeAndFill => {
                stroke(self);
                fill(self);
            }
        }
    }

    fn line_style(&mut self, stroke: &usvg::Stroke) {
        self.op(CanvasOp::LineWidth(Num::Const(stroke.width().get())));
        self.op(CanvasOp::LineCap(match stroke.linecap() {
            usvg::LineCap::Butt => LineCap::Butt,
            usvg::LineCap::Round => LineCap::Round,
            usvg::LineCap::Square => LineCap::Square,
        }));
        self.op(CanvasOp::LineJoin(match stroke.linejoin() {
            usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => LineJoin::Miter,
            usvg::LineJoin::Round => LineJoin::Round,
            usvg::LineJoin::Bevel => LineJoin::Bevel,
        }));
        self.op(CanvasOp::MiterLimit(stroke.miterlimit().get()));
        let dashes: Arc<[Points]> = stroke
            .dasharray()
            .unwrap_or_default()
            .iter()
            .map(|&d| px(d))
            .collect();
        self.op(CanvasOp::LineDash(dashes));
        self.op(CanvasOp::LineDashOffset(Num::Const(stroke.dashoffset())));
    }

    /// Fills or strokes `data` (`ops` as canvas path operations) with
    /// `paint` at `alpha`.
    fn paint(
        &mut self,
        paint: &usvg::Paint,
        alpha: f32,
        target: Target,
        data: &tiny_skia_path::Path,
        ops: &Path,
    ) {
        if alpha <= 0.0 {
            return;
        }
        self.op(CanvasOp::GlobalAlpha(Num::Const(alpha)));
        let style = match paint {
            usvg::Paint::Color(c) if *c == self.current => {
                let view = match target {
                    Target::Fill(_) => ViewPaint::FillCurrentColor,
                    Target::Stroke => ViewPaint::StrokeCurrentColor,
                };
                self.view_paint(view, target.style(Paint::Color(Color::TRANSPARENT)));
                self.op(target.draw(ops.clone()));
                return;
            }
            usvg::Paint::Color(c) => Paint::Color(Color::rgba(c.red, c.green, c.blue, 255)),
            usvg::Paint::LinearGradient(g) => {
                let ts = g.transform();
                let (start, end) = linear_line(ts, (g.x1(), g.y1()), (g.x2(), g.y2()));
                gradient(
                    GradientShape::Linear { start, end },
                    g.stops(),
                    self.current,
                )
            }
            usvg::Paint::RadialGradient(g) => {
                let ts = g.transform();
                let (focal, center, r) = ((g.fx(), g.fy()), (g.cx(), g.cy()), g.r().get());
                // A rotation and a uniform scale keep circles circles.
                let scale = ts
                    .sx
                    .abs()
                    .max(ts.sy.abs())
                    .max(ts.kx.abs())
                    .max(ts.ky.abs());
                let similar =
                    (ts.sx - ts.sy).abs() <= 1e-4 * scale && (ts.kx + ts.ky).abs() <= 1e-4 * scale;
                if !similar
                    && let Target::Fill(rule) = target
                    && let Some(back) = ts.invert()
                {
                    // Stretched into an ellipse: the circles are drawn in
                    // the gradient's own space, the shape mapped into it.
                    let shape = radial((None, focal, center, r));
                    let local = data.clone().transform(back).map(|p| path_ops(&p));
                    self.op(CanvasOp::Save);
                    self.transform(ts);
                    self.op(CanvasOp::FillStyle(gradient(
                        shape,
                        g.stops(),
                        self.current,
                    )));
                    if let Some(local) = local {
                        self.op(CanvasOp::Fill(Some(local), rule));
                    }
                    self.op(CanvasOp::Restore);
                    return;
                }
                gradient(
                    radial((Some(ts), focal, center, r)),
                    g.stops(),
                    self.current,
                )
            }
            usvg::Paint::Pattern(_) => {
                log::warn!("svg: a pattern is not drawn");
                return;
            }
        };
        self.op(target.style(style));
        self.op(target.draw(ops.clone()));
    }
}

/// What a paint is for.
#[derive(Clone, Copy)]
enum Target {
    Fill(FillRule),
    Stroke,
}

impl Target {
    fn style(self, paint: Paint) -> CanvasOp {
        match self {
            Target::Fill(_) => CanvasOp::FillStyle(paint),
            Target::Stroke => CanvasOp::StrokeStyle(paint),
        }
    }

    fn draw(self, path: Path) -> CanvasOp {
        match self {
            Target::Fill(rule) => CanvasOp::Fill(Some(path), rule),
            Target::Stroke => CanvasOp::Stroke(Some(path)),
        }
    }
}

fn identity() -> tiny_skia_path::Transform {
    tiny_skia_path::Transform::identity()
}

fn at(x: f32, y: f32) -> Point<Points> {
    point(px(x), px(y))
}

/// A radial gradient from the focal point to the circle around `center`
/// of radius `r`, mapped by a transform (its scale the square root of its
/// determinant's).
fn radial(
    (ts, focal, center, r): (
        Option<tiny_skia_path::Transform>,
        (f32, f32),
        (f32, f32),
        f32,
    ),
) -> GradientShape {
    let ts = ts.unwrap_or_else(identity);
    let map = |(x, y): (f32, f32)| {
        let mut p = tiny_skia_path::Point::from_xy(x, y);
        ts.map_point(&mut p);
        at(p.x, p.y)
    };
    let scale = (ts.sx * ts.sy - ts.kx * ts.ky).abs().sqrt();
    GradientShape::Radial {
        start: map(focal),
        start_radius: Points::ZERO,
        end: map(center),
        end_radius: px(r * scale),
    }
}

/// The line of a linear gradient from `p1` to `p2` mapped by `ts`: an
/// affine map keeps the lines of equal color parallel, so the gradient is
/// the one along their normal, from where `p1` goes.
fn linear_line(
    ts: tiny_skia_path::Transform,
    (x1, y1): (f32, f32),
    (x2, y2): (f32, f32),
) -> (Point<Points>, Point<Points>) {
    let (dx, dy) = (x2 - x1, y2 - y1);
    let det = ts.sx * ts.sy - ts.kx * ts.ky;
    let length = dx * dx + dy * dy;
    let mut start = tiny_skia_path::Point::from_xy(x1, y1);
    ts.map_point(&mut start);
    if det == 0.0 || length == 0.0 {
        return (at(start.x, start.y), at(start.x, start.y));
    }
    // The gradient's direction in the user space: the inverse transpose
    // of the transform's linear part applied to the line, over its length
    // squared, so that the color at `u` is `(u - start) · g`.
    let gx = (ts.sy * dx - ts.ky * dy) / det / length;
    let gy = (-ts.kx * dx + ts.sx * dy) / det / length;
    let g2 = gx * gx + gy * gy;
    (
        at(start.x, start.y),
        at(start.x + gx / g2, start.y + gy / g2),
    )
}

/// A gradient of `stops`; one of `current`, the root's `color`, is black,
/// the color of a `currentColor` that inherits none (a gradient's stops
/// are fixed when it is recorded).
fn gradient(shape: GradientShape, stops: &[usvg::Stop], current: usvg::Color) -> Paint {
    let stops = stops
        .iter()
        .map(|s| {
            let c = Some(s.color())
                .filter(|&c| c != current)
                .unwrap_or_else(usvg::Color::black);
            let a = (s.opacity().get() * 255.0).round() as u8;
            (
                Percentage(s.offset().get()),
                Color::rgba(c.red, c.green, c.blue, a),
            )
        })
        .collect();
    Paint::Gradient(Arc::new(CanvasGradient { shape, stops }))
}

fn fill_rule(rule: usvg::FillRule) -> FillRule {
    match rule {
        usvg::FillRule::NonZero => FillRule::NonZero,
        usvg::FillRule::EvenOdd => FillRule::EvenOdd,
    }
}

fn composite(mode: usvg::BlendMode) -> Option<Composite> {
    use usvg::BlendMode as B;
    Some(match mode {
        B::Normal => return None,
        B::Multiply => Composite::Multiply,
        B::Screen => Composite::Screen,
        B::Overlay => Composite::Overlay,
        B::Darken => Composite::Darken,
        B::Lighten => Composite::Lighten,
        B::ColorDodge => Composite::ColorDodge,
        B::ColorBurn => Composite::ColorBurn,
        B::HardLight => Composite::HardLight,
        B::SoftLight => Composite::SoftLight,
        B::Difference => Composite::Difference,
        B::Exclusion => Composite::Exclusion,
        B::Hue => Composite::Hue,
        B::Saturation => Composite::Saturation,
        B::Color => Composite::Color,
        B::Luminosity => Composite::Luminosity,
    })
}

/// The shapes of a clip path's `group`, mapped by `ts`, appended to `ops`
/// with their clip rules.
fn collect_clip(
    group: &usvg::Group,
    ts: tiny_skia_path::Transform,
    ops: &mut Vec<PathOp>,
    rules: &mut Vec<FillRule>,
) {
    let ts = ts.pre_concat(group.transform());
    for node in group.children() {
        match node {
            usvg::Node::Group(g) => collect_clip(g, ts, ops, rules),
            usvg::Node::Path(p) if p.is_visible() => {
                if let Some(data) = p.data().clone().transform(ts) {
                    append_path(&data, ops);
                    rules.push(p.fill().map_or(FillRule::NonZero, |f| fill_rule(f.rule())));
                }
            }
            _ => {}
        }
    }
}

fn path_ops(data: &tiny_skia_path::Path) -> Path {
    let mut ops = Vec::with_capacity(data.len());
    append_path(data, &mut ops);
    ops.into()
}

fn append_path(data: &tiny_skia_path::Path, ops: &mut Vec<PathOp>) {
    use tiny_skia_path::PathSegment as S;
    let n = |v: f32| Num::Const(v);
    for segment in data.segments() {
        ops.push(match segment {
            S::MoveTo(p) => PathOp::MoveTo(n(p.x), n(p.y)),
            S::LineTo(p) => PathOp::LineTo(n(p.x), n(p.y)),
            S::QuadTo(c, p) => PathOp::QuadTo([c.x, c.y, p.x, p.y].map(n)),
            S::CubicTo(c1, c2, p) => PathOp::CubicTo([c1.x, c1.y, c2.x, c2.y, p.x, p.y].map(n)),
            S::Close => PathOp::Close,
        });
    }
}
