//! The canvas's operations (`CV_*`): how a recorded drawing is read
//! ([`decode`], [`CanvasOp`]'s and [`PathOp`]'s `#[derive(JsOps)]` with the
//! arguments' readers here) and the part of the 2D context that only
//! records them, generated from the same variants: the methods that push
//! their code and arguments, and the drawing-state properties that push
//! their code and value (`nsh-js` `canvas.rs` records natively from the
//! same specs; [`typescript`] gives their declarations).

codes! { CODES:
    CV_SAVE = 0,
    CV_RESTORE = 1,
    CV_TRANSLATE = 2,
    CV_SCALE = 3,
    CV_ROTATE = 4,
    CV_TRANSFORM = 5,
    CV_SET_TRANSFORM = 6,
    CV_BEGIN_PATH = 7,
    CV_MOVE_TO = 8,
    CV_LINE_TO = 9,
    CV_QUAD_TO = 10,
    CV_CUBIC_TO = 11,
    CV_ARC = 12,
    CV_ARC_TO = 13,
    CV_ELLIPSE = 14,
    CV_RECT = 15,
    CV_ROUND_RECT = 16,
    CV_CLOSE = 17,
    CV_FILL = 18,
    CV_STROKE = 19,
    CV_CLIP = 20,
    CV_FILL_RECT = 21,
    CV_STROKE_RECT = 22,
    CV_CLEAR_RECT = 23,
    CV_FILL_STYLE = 24,
    CV_STROKE_STYLE = 25,
    CV_LINE_WIDTH = 26,
    CV_LINE_CAP = 27,
    CV_LINE_JOIN = 28,
    CV_MITER_LIMIT = 29,
    CV_LINE_DASH = 30,
    CV_LINE_DASH_OFFSET = 31,
    CV_GLOBAL_ALPHA = 32,
    CV_COMPOSITE = 33,
    CV_SHADOW_COLOR = 34,
    CV_SHADOW_BLUR = 35,
    CV_SHADOW_OFFSET = 36,
    CV_FONT = 37,
    CV_TEXT_ALIGN = 38,
    CV_TEXT_BASELINE = 39,
    CV_FILL_TEXT = 40,
    CV_STROKE_TEXT = 41,
    CV_DRAW_IMAGE = 42,
    CV_FONT_VARIANT_NUMERIC = 43,
    /// SVG path data, parsed natively (`new Path2D("M0 0 L10 10")`)
    CV_SVG_PATH = 50,
}

use std::sync::Arc;

use super::{
    host::{HostInput, HostList, HostValue},
    ops::{JsOps, OpArg, OpMethod, OpReader, OpsError, host_value},
};
use crate::{
    canvas::{
        CanvasFont, CanvasGradient, CanvasImage, CanvasOp, CanvasTextAlign, CanvasTextBaseline,
        Composite, Drawing, FillRule, GradientShape, LineCap, LineJoin, Num, Paint, Path, PathOp,
        parse_svg_path,
    },
    element::TsTypes,
    geometry::{Bounds, Percentage, Points, Radians, ScaledPixels, point, size},
    style::{Color, FontVariant},
};

/// Reads drawing `list[start..end]` (what a `draw` callback recorded).
pub fn decode<L: HostList<Item: HostInput>>(
    list: &L,
    start: usize,
    end: usize,
) -> Result<Drawing, OpsError> {
    let mut drawing = Drawing::default();
    let mut r = OpReader::new(list, start, end);
    while r.more() {
        let code = r.code()?;
        match CanvasOp::decode(code, &mut r, &mut drawing)? {
            Some(Some(op)) => drawing.ops.push(op),
            Some(None) => {}
            None => return Err(OpsError::Unknown(code)),
        }
    }
    Ok(drawing)
}

/// A constant, or an animated value the canvas reads while it draws (a slot
/// of the drawing); anything else is 0.
impl OpArg<Drawing> for Num {
    #[inline]
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        drawing: &mut Drawing,
    ) -> Result<Option<Self>, OpsError> {
        let v = r.arg()?;
        if let Some(n) = v.as_number() {
            return Ok(Some(Num::Const(n as f32)));
        }
        Ok(Some(match v.animated_node() {
            Some(node) => Num::Slot(drawing.slot(node)),
            None => Num::Const(0.0),
        }))
    }

    fn ts(_: &mut TsTypes) -> String {
        "CanvasNumber".into()
    }
}

/// A `Path2D`'s recorded list, or (anything else) the current path.
impl OpArg<Drawing> for Option<Path> {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        drawing: &mut Drawing,
    ) -> Result<Option<Self>, OpsError> {
        let Some(list) = r.arg()?.as_list() else {
            return Ok(Some(None));
        };
        let mut ops = Vec::new();
        let mut path = OpReader::all(&list);
        while path.more() {
            let code = path.code()?;
            if code == CV_SVG_PATH {
                ops.extend(parse_svg_path(&path.arg()?.as_string().unwrap_or_default()));
                continue;
            }
            match PathOp::decode(code, &mut path, drawing)? {
                Some(Some(op)) => ops.push(op),
                Some(None) => {}
                None => return Err(OpsError::Misplaced(code)),
            }
        }
        Ok(Some(Some(ops.into())))
    }

    fn ts(_: &mut TsTypes) -> String {
        "Path2D".into()
    }
}

/// A color, an animated value interpolating colors, or a gradient
/// (`[kind, ...geometry, [offset, color, ...]]`); anything else drops the
/// operation.
impl OpArg<Drawing> for Paint {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        drawing: &mut Drawing,
    ) -> Result<Option<Self>, OpsError> {
        let v = r.arg()?;
        if let Some(s) = v.as_string() {
            return Ok(Color::parse(&s).map(Paint::Color));
        }
        if let Some(node) = v.animated_node() {
            return Ok(Some(Paint::Slot(drawing.slot(node))));
        }
        let Some(list) = v.as_list() else {
            return Ok(None);
        };
        let n = |i: usize| list.item(i).and_then(|x| x.as_number()).unwrap_or(0.0) as f32;
        let p = |i: usize| Points(n(i));
        let at = |i: usize| point(p(i), p(i + 1));
        let (shape, stops_at) = match list.item(0).and_then(|k| k.as_number()) {
            Some(0.0) => (
                GradientShape::Linear {
                    start: at(1),
                    end: at(3),
                },
                5,
            ),
            Some(1.0) => (
                GradientShape::Radial {
                    start: at(1),
                    start_radius: p(3),
                    end: at(4),
                    end_radius: p(6),
                },
                7,
            ),
            Some(2.0) => (
                GradientShape::Conic {
                    start_angle: Radians(n(1)),
                    center: at(2),
                },
                4,
            ),
            _ => return Ok(None),
        };
        let mut stops = Vec::new();
        if let Some(raw) = list.item(stops_at).and_then(|s| s.as_list()) {
            let mut i = 0;
            while i + 1 < raw.len() {
                let offset = raw.item(i).and_then(|o| o.as_number()).unwrap_or(0.0) as f32;
                let color = raw
                    .item(i + 1)
                    .and_then(|c| c.as_string())
                    .and_then(|c| Color::parse(&c));
                if let Some(color) = color {
                    stops.push((Percentage(offset.clamp(0.0, 1.0)), color));
                }
                i += 2;
            }
        }
        // Stops apply in offset order (equal offsets keep their order).
        stops.sort_by(|a, b| a.0.0.total_cmp(&b.0.0));
        Ok(Some(Paint::Gradient(Arc::new(CanvasGradient {
            shape,
            stops,
        }))))
    }

    fn ts(_: &mut TsTypes) -> String {
        "CanvasPaint".into()
    }
}

/// A URL or `asset:/` URI; without one the operation is dropped.
impl OpArg<Drawing> for CanvasImage {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Drawing,
    ) -> Result<Option<Self>, OpsError> {
        let uri = r.arg()?.as_string().unwrap_or_default();
        Ok((!uri.is_empty()).then(|| CanvasImage { uri: uri.into() }))
    }

    fn ts(_: &mut TsTypes) -> String {
        "string".into()
    }
}

/// `drawImage`'s source rectangle `[sx, sy, sw, sh]`, or the whole image.
impl OpArg<Drawing> for Option<Bounds<ScaledPixels>> {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Drawing,
    ) -> Result<Option<Self>, OpsError> {
        let Some(v) = r.arg()?.as_list() else {
            return Ok(Some(None));
        };
        let mut out = [0f32; 4];
        for (i, o) in out.iter_mut().enumerate().take(v.len()) {
            *o = v.item(i).and_then(|n| n.as_number()).unwrap_or(0.0) as f32;
        }
        let [x, y, w, h] = out.map(ScaledPixels);
        Ok(Some(Some(Bounds {
            origin: point(x, y),
            size: size(w, h),
        })))
    }

    fn ts(_: &mut TsTypes) -> String {
        "number[]".into()
    }
}

/// Values parsed from a string that drop the operation when invalid.
macro_rules! parsed {
    ($($ty:ty => $parse:path),* $(,)?) => {$(
        impl<Cx> OpArg<Cx> for $ty {
            fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>, _: &mut Cx) -> Result<Option<Self>, OpsError> {
                Ok(r.arg()?.as_string().and_then(|s| $parse(&s)))
            }

            fn ts(_: &mut TsTypes) -> String {
                "string".into()
            }
        }
    )*};
}

parsed! {
    Color => Color::parse,
    Composite => Composite::parse,
    CanvasFont => CanvasFont::parse,
}

/// `fontVariantNumeric`: number forms only (space-separated, as in CSS);
/// anything else drops the operation.
impl<Cx> OpArg<Cx> for FontVariant {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        _: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(r.arg()?
            .as_string()
            .and_then(|s| FontVariant::parse(&s))
            .filter(|v| !v.has(FontVariant::SMALL_CAPS)))
    }

    fn ts(_: &mut TsTypes) -> String {
        "\"normal\" | \"tabular-nums\" | \"proportional-nums\" | \"lining-nums\" | \"oldstyle-nums\" | (string & {})".into()
    }
}

/// String unions: names they do not have are the default.
macro_rules! named {
    ($($ty:ty),* $(,)?) => {$(
        impl<Cx> OpArg<Cx> for $ty {
            fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>, _: &mut Cx) -> Result<Option<Self>, OpsError> {
                Ok(Some(host_value(r)?.unwrap_or_default()))
            }

            fn ts(types: &mut TsTypes) -> String {
                <$ty as HostValue>::ts_type(types)
            }
        }
    )*};
}

named!(
    FillRule,
    LineCap,
    LineJoin,
    CanvasTextAlign,
    CanvasTextBaseline
);

/// `setLineDash(segments)`: lists with negative or non-finite entries are
/// ignored, as in canvas; an odd count is repeated.
pub(crate) fn line_dash<L: HostList<Item: HostInput>>(
    r: &mut OpReader<'_, L>,
    _: &mut Drawing,
) -> Result<Option<CanvasOp>, OpsError> {
    let mut dash: Vec<f32> = match r.arg()?.as_list() {
        Some(v) => (0..v.len())
            .filter_map(|i| v.item(i)?.as_number())
            .map(|d| d as f32)
            .collect(),
        None => Vec::new(),
    };
    if dash.iter().any(|d| !d.is_finite() || *d < 0.0) {
        return Ok(None);
    }
    if dash.len() % 2 == 1 {
        dash.extend_from_within(..);
    }
    Ok(Some(CanvasOp::LineDash(
        dash.into_iter().map(Points).collect(),
    )))
}

/// The declarations of the recording methods and properties (`nsh/canvas`
/// declares the classes; `nsh-js` records natively from the same specs).
pub fn declarations() -> String {
    use std::fmt::Write as _;
    let mut types = TsTypes::default();
    let (mut path, mut context, mut properties) = (Vec::new(), Vec::new(), Vec::new());
    PathOp::methods(&mut types, &mut path);
    CanvasOp::methods(&mut types, &mut context);
    CanvasOp::properties(&mut types, &mut properties);
    let mut out = String::from(
        "/** A number in a drawing: a constant, or an animated value the canvas reads\n \
         * while it draws (its animations redraw natively, without JS). */\n\
         export type CanvasNumber = number | AnimatedNode;\n",
    );
    for declaration in types.declarations() {
        let _ = write!(out, "\n{declaration}\n");
    }
    let methods = |out: &mut String, iface: &str, doc: &str, list: &[OpMethod]| {
        let _ = write!(out, "\n/** {doc} */\nexport interface {iface} {{\n");
        for m in list {
            let params = m
                .params
                .iter()
                .map(|p| {
                    format!(
                        "{}{}: {}",
                        p.name,
                        if p.default.is_some() { "?" } else { "" },
                        p.ts
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let _ = writeln!(out, "  /** {} */\n  {}({params}): void;", m.doc, m.name);
        }
        out.push_str("}\n");
    };
    methods(
        &mut out,
        "CanvasPathMethods",
        "Path building, shared by the context (its current path) and `Path2D`.",
        &path,
    );
    methods(
        &mut out,
        "CanvasContextMethods",
        "The context's transforms and rectangles.",
        &context,
    );
    out.push_str("\n/** The drawing state kept as set. */\nexport interface CanvasProperties {\n");
    for p in &properties {
        let _ = writeln!(out, "  /** {} */\n  {}: {};", p.doc, p.name, p.ts);
    }
    out.push_str("}\n");
    out
}
