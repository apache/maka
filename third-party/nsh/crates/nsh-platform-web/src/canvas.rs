//! Canvas drawings as JSON for `CanvasRenderingContext2D` (`web/nsh.js`,
//! `draw`): one array per operation, named after the 2D context's method
//! or property. An animated value is `["$", slot]`, filled in by JS with the
//! latest value of the slot (animation outputs `canvas:<slot>`).

use std::fmt::Write as _;

use nsh_core::{
    canvas::{
        CanvasFont, CanvasOp, Composite, Drawing, FillRule, GradientShape, LineCap, LineJoin, Num,
        Paint, PathOp,
    },
    element::PropEnum,
};

use crate::encode::css_color;

struct W(String);

impl W {
    fn sep(&mut self) {
        if !self.0.ends_with('[') {
            self.0.push(',');
        }
    }

    fn num(&mut self, n: Num) {
        self.sep();
        match n {
            Num::Const(v) if v.is_finite() => {
                let _ = write!(self.0, "{v}");
            }
            Num::Const(_) => self.0.push('0'),
            Num::Slot(s) => {
                let _ = write!(self.0, "[\"$\",{s}]");
            }
        }
    }

    fn nums(&mut self, ns: &[Num]) {
        for &n in ns {
            self.num(n);
        }
    }

    fn f(&mut self, v: f32) {
        self.sep();
        let _ = write!(self.0, "{}", if v.is_finite() { v } else { 0.0 });
    }

    fn str(&mut self, s: &str) {
        self.sep();
        self.0.push_str(&serde_json::Value::from(s).to_string());
    }

    fn raw(&mut self, s: &str) {
        self.sep();
        self.0.push_str(s);
    }

    fn op(&mut self, name: &str, f: impl FnOnce(&mut W)) {
        self.sep();
        self.0.push('[');
        self.str(name);
        f(self);
        self.0.push(']');
    }
}

fn path_op(w: &mut W, op: &PathOp) {
    match op {
        PathOp::MoveTo(x, y) => w.op("moveTo", |w| w.nums(&[*x, *y])),
        PathOp::LineTo(x, y) => w.op("lineTo", |w| w.nums(&[*x, *y])),
        PathOp::QuadTo(a) => w.op("quadraticCurveTo", |w| w.nums(a)),
        PathOp::CubicTo(a) => w.op("bezierCurveTo", |w| w.nums(a)),
        PathOp::Arc {
            x,
            y,
            radius,
            start,
            end,
            ccw,
        } => w.op("arc", |w| {
            w.nums(&[*x, *y, *radius, *start, *end]);
            w.raw(if *ccw { "true" } else { "false" });
        }),
        PathOp::ArcTo(a) => w.op("arcTo", |w| w.nums(a)),
        PathOp::Ellipse {
            geometry,
            start,
            end,
            ccw,
        } => w.op("ellipse", |w| {
            w.nums(geometry);
            w.nums(&[*start, *end]);
            w.raw(if *ccw { "true" } else { "false" });
        }),
        PathOp::Rect(a) => w.op("rect", |w| w.nums(a)),
        PathOp::RoundRect(a, r) => w.op("roundRect", |w| {
            w.nums(a);
            w.sep();
            w.0.push('[');
            w.nums(r);
            w.0.push(']');
        }),
        PathOp::Close => w.op("closePath", |_| {}),
    }
}

fn path(w: &mut W, p: &Option<nsh_core::canvas::Path>) {
    w.sep();
    match p {
        None => w.0.push_str("null"),
        Some(p) => {
            w.0.push('[');
            for op in p.iter() {
                path_op(w, op);
            }
            w.0.push(']');
        }
    }
}

fn paint(w: &mut W, p: &Paint) {
    match p {
        Paint::Color(c) => w.str(&css_color(*c)),
        Paint::Slot(s) => w.raw(&format!("[\"$\",{s}]")),
        Paint::Gradient(g) => {
            let (kind, args): (&str, Vec<f32>) = match &g.shape {
                GradientShape::Linear { start, end } => {
                    ("linear", vec![start.x.0, start.y.0, end.x.0, end.y.0])
                }
                GradientShape::Radial {
                    start,
                    start_radius,
                    end,
                    end_radius,
                } => (
                    "radial",
                    vec![
                        start.x.0,
                        start.y.0,
                        start_radius.0,
                        end.x.0,
                        end.y.0,
                        end_radius.0,
                    ],
                ),
                GradientShape::Conic {
                    start_angle,
                    center,
                } => ("conic", vec![start_angle.0, center.x.0, center.y.0]),
            };
            w.sep();
            w.0.push_str("{\"g\":");
            w.0.push_str(&serde_json::Value::from(kind).to_string());
            w.0.push_str(",\"args\":[");
            for a in args {
                w.f(a);
            }
            w.0.push_str("],\"stops\":[");
            for &(offset, color) in &g.stops {
                w.sep();
                let _ = write!(w.0, "[{},\"{}\"]", offset.0, css_color(color));
            }
            w.0.push_str("]}");
        }
    }
}

fn rule(r: FillRule) -> &'static str {
    match r {
        FillRule::NonZero => "nonzero",
        FillRule::EvenOdd => "evenodd",
    }
}

fn font(f: &CanvasFont) -> String {
    let family = f.family.as_deref().map_or_else(
        || "system-ui, sans-serif".to_owned(),
        |f| format!("\"{f}\""),
    );
    format!(
        "{}{}{} {}px {family}",
        if f.italic { "italic " } else { "" },
        if f.variant.has(nsh_core::FontVariant::SMALL_CAPS) {
            "small-caps "
        } else {
            ""
        },
        f.weight,
        f.size.0
    )
}

fn name(v: &impl PropEnum) -> &'static str {
    v.js_name()
}

/// The drawing as `[[op, ...args], ...]`.
pub(crate) fn encode(drawing: &Drawing) -> String {
    let mut w = W(String::from("["));
    for op in &drawing.ops {
        match op {
            CanvasOp::Save => w.op("save", |_| {}),
            CanvasOp::Restore => w.op("restore", |_| {}),
            CanvasOp::Translate(x, y) => w.op("translate", |w| w.nums(&[*x, *y])),
            CanvasOp::Scale(x, y) => w.op("scale", |w| w.nums(&[*x, *y])),
            CanvasOp::Rotate(a) => w.op("rotate", |w| w.num(*a)),
            CanvasOp::Transform(m) => w.op("transform", |w| w.nums(m)),
            CanvasOp::SetTransform(m) => w.op("setTransform", |w| w.nums(m)),
            CanvasOp::BeginPath => w.op("beginPath", |_| {}),
            CanvasOp::Path(p) => path_op(&mut w, p),
            CanvasOp::Fill(p, r) => w.op("fill", |w| {
                path(w, p);
                w.str(rule(*r));
            }),
            CanvasOp::Stroke(p) => w.op("stroke", |w| path(w, p)),
            CanvasOp::Clip(p, r) => w.op("clip", |w| {
                path(w, p);
                w.str(rule(*r));
            }),
            CanvasOp::FillRect(a) => w.op("fillRect", |w| w.nums(a)),
            CanvasOp::StrokeRect(a) => w.op("strokeRect", |w| w.nums(a)),
            CanvasOp::ClearRect(a) => w.op("clearRect", |w| w.nums(a)),
            CanvasOp::FillStyle(p) => w.op("=fillStyle", |w| paint(w, p)),
            CanvasOp::StrokeStyle(p) => w.op("=strokeStyle", |w| paint(w, p)),
            CanvasOp::LineWidth(n) => w.op("=lineWidth", |w| w.num(*n)),
            CanvasOp::LineCap(c) => w.op("=lineCap", |w| {
                w.str(match c {
                    LineCap::Butt => "butt",
                    LineCap::Round => "round",
                    LineCap::Square => "square",
                })
            }),
            CanvasOp::LineJoin(j) => w.op("=lineJoin", |w| {
                w.str(match j {
                    LineJoin::Miter => "miter",
                    LineJoin::Round => "round",
                    LineJoin::Bevel => "bevel",
                })
            }),
            CanvasOp::MiterLimit(v) => w.op("=miterLimit", |w| w.f(*v)),
            CanvasOp::LineDash(d) => w.op("setLineDash", |w| {
                w.sep();
                w.0.push('[');
                for &v in d.iter() {
                    w.f(v.0);
                }
                w.0.push(']');
            }),
            CanvasOp::LineDashOffset(n) => w.op("=lineDashOffset", |w| w.num(*n)),
            CanvasOp::GlobalAlpha(n) => w.op("=globalAlpha", |w| w.num(*n)),
            CanvasOp::Composite(c) => w.op("=globalCompositeOperation", |w| {
                w.str(&composite(*c));
            }),
            CanvasOp::ShadowColor(c) => w.op("=shadowColor", |w| w.str(&css_color(*c))),
            CanvasOp::ShadowBlur(v) => w.op("=shadowBlur", |w| w.f(v.0)),
            CanvasOp::ShadowOffset(offset) => w.op("shadowOffset", |w| {
                w.f(offset.x.0);
                w.f(offset.y.0);
            }),
            CanvasOp::Font(f) => w.op("=font", |w| w.str(&font(f))),
            // Browsers' canvases draw no number forms (the shorthand only
            // takes `small-caps`).
            CanvasOp::FontVariantNumeric(_) => {}
            CanvasOp::TextAlign(a) => w.op("=textAlign", |w| w.str(name(a))),
            CanvasOp::TextBaseline(b) => w.op("=textBaseline", |w| w.str(name(b))),
            CanvasOp::FillText {
                text,
                x,
                y,
                max_width,
            } => w.op("fillText", |w| {
                w.str(text);
                w.nums(&[*x, *y]);
                if let Some(m) = max_width {
                    w.f(m.0);
                }
            }),
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            } => w.op("strokeText", |w| {
                w.str(text);
                w.nums(&[*x, *y]);
                if let Some(m) = max_width {
                    w.f(m.0);
                }
            }),
            CanvasOp::DrawImage {
                image,
                source,
                dest,
            } => w.op("drawImage", |w| {
                w.str(&image.uri);
                w.sep();
                match source {
                    Some(s) => {
                        w.0.push('[');
                        for v in [s.origin.x, s.origin.y, s.size.width, s.size.height] {
                            w.f(v.0);
                        }
                        w.0.push(']');
                    }
                    None => w.0.push_str("null"),
                }
                w.nums(dest);
            }),
        }
    }
    w.0.push(']');
    w.0
}

fn composite(c: Composite) -> String {
    let debug = format!("{c:?}");
    let mut out = String::new();
    for (i, ch) in debug.chars().enumerate() {
        if ch.is_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}
