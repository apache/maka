//! `<canvas>` drawings: what a `draw` callback recorded through the 2D
//! context (an HTML Canvas 2D subset), decoded in Rust into an immutable
//! list of operations that platforms replay natively (CGContext, Android
//! Canvas). Numbers may be animated values ([`Num::Slot`]): the platform
//! reads them while replaying, so animations redraw on the UI thread
//! without JS.

mod damage;
mod hit;

use std::sync::Arc;

pub use self::{
    damage::{Damage, DamageScan, first_animated, prefix_path_needed},
    hit::{point_in_path, point_in_stroke},
};
use crate::{
    element::{PropEnum, TsTypes},
    geometry::{Bounds, Corners, Percentage, Point, Points, Radians, ScaledPixels, Size, px},
    js::{
        canvas::*,
        host::{HostInput, HostList},
        ops::{JsOps, OpArg, OpReader, OpsError},
    },
    style::{Color, FontVariant},
};

/// A number of a drawing: a constant or the value of animated value slot
/// `n` of the drawing ([`Drawing::slots`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Num {
    /// A constant.
    Const(f32),
    /// The current value of an animated value.
    Slot(u16),
}

impl Num {
    /// The value, reading slots through `slot`.
    #[inline]
    pub fn get(self, slot: impl Fn(u16) -> f32) -> f32 {
        match self {
            Num::Const(v) => v,
            Num::Slot(s) => slot(s),
        }
    }
}

impl Default for Num {
    fn default() -> Self {
        Num::Const(0.0)
    }
}

/// One element of a path (`beginPath` … `closePath`, `Path2D`).
#[derive(Debug, Clone, PartialEq, JsOps)]
#[ops(cx = Drawing)]
pub enum PathOp {
    /// `moveTo(x, y)`: starts a subpath at (`x`, `y`).
    #[op(code = CV_MOVE_TO, method = "moveTo", params = "x, y")]
    MoveTo(Num, Num),
    /// `lineTo(x, y)`: a straight line to (`x`, `y`).
    #[op(code = CV_LINE_TO, method = "lineTo", params = "x, y")]
    LineTo(Num, Num),
    /// `quadraticCurveTo(cpx, cpy, x, y)`: a quadratic Bézier curve to (`x`,
    /// `y`).
    #[op(code = CV_QUAD_TO, method = "quadraticCurveTo", params = "cpx, cpy, x, y")]
    QuadTo([Num; 4]),
    /// `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)`: a cubic Bézier curve to
    /// (`x`, `y`).
    #[op(
        code = CV_CUBIC_TO,
        method = "bezierCurveTo",
        params = "cp1x, cp1y, cp2x, cp2y, x, y"
    )]
    CubicTo([Num; 6]),
    /// `arc(x, y, radius, startAngle, endAngle, counterclockwise)`: a
    /// circular arc; angles in radians, clockwise from the x axis.
    #[op(
        code = CV_ARC,
        method = "arc",
        params = "x, y, radius, startAngle, endAngle, counterclockwise = false"
    )]
    Arc {
        /// Center x.
        x: Num,
        /// Center y.
        y: Num,
        /// Radius.
        radius: Num,
        /// Start angle.
        start: Num,
        /// End angle.
        end: Num,
        /// Counterclockwise.
        ccw: bool,
    },
    /// `arcTo(x1, y1, x2, y2, radius)`: an arc tangent to the lines to (`x1`,
    /// `y1`) and on to (`x2`, `y2`).
    #[op(code = CV_ARC_TO, method = "arcTo", params = "x1, y1, x2, y2, radius")]
    ArcTo([Num; 5]),
    /// `ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle,
    /// counterclockwise)`: an elliptical arc; angles in radians, clockwise.
    #[op(
        code = CV_ELLIPSE,
        method = "ellipse",
        params = "x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise = false"
    )]
    Ellipse {
        /// Center and radii, rotation (radians).
        geometry: [Num; 5],
        /// Start angle.
        start: Num,
        /// End angle.
        end: Num,
        /// Counterclockwise.
        ccw: bool,
    },
    /// `rect(x, y, w, h)`: a closed rectangle subpath.
    #[op(code = CV_RECT, method = "rect", params = "x, y, w, h")]
    Rect([Num; 4]),
    /// `roundRect(x, y, w, h, radii)`: corner radii top-left, top-right,
    /// bottom-right, bottom-left (`canvas.ts` spreads `radii`).
    #[op(code = CV_ROUND_RECT)]
    RoundRect([Num; 4], [Num; 4]),
    /// `closePath()`: a straight line back to the subpath's start.
    #[op(code = CV_CLOSE, method = "closePath")]
    Close,
}

/// A path to fill, stroke or clip instead of the current one.
pub type Path = Arc<[PathOp]>;

/// Which areas a path fills (`fill` / `clip`'s rule).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum FillRule {
    /// `nonzero`.
    #[default]
    #[prop(rename = "nonzero")]
    NonZero,
    /// `evenodd`.
    #[prop(rename = "evenodd")]
    EvenOdd,
}

/// How strokes end (`lineCap`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum LineCap {
    /// `butt`.
    #[default]
    Butt,
    /// `round`.
    Round,
    /// `square`.
    Square,
}

/// How stroke segments join (`lineJoin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum LineJoin {
    /// `miter`.
    #[default]
    Miter,
    /// `round`.
    Round,
    /// `bevel`.
    Bevel,
}

/// The geometry of a gradient (canvas coordinates).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GradientShape {
    /// `createLinearGradient(x0, y0, x1, y1)`.
    Linear {
        /// Where it starts (`x0`, `y0`).
        start: Point<Points>,
        /// Where it ends (`x1`, `y1`).
        end: Point<Points>,
    },
    /// `createRadialGradient(x0, y0, r0, x1, y1, r1)`.
    Radial {
        /// The center of the start circle (`x0`, `y0`).
        start: Point<Points>,
        /// Its radius (`r0`).
        start_radius: Points,
        /// The center of the end circle (`x1`, `y1`).
        end: Point<Points>,
        /// Its radius (`r1`).
        end_radius: Points,
    },
    /// `createConicGradient(startAngle, x, y)`.
    Conic {
        /// Where it starts, clockwise from the x axis.
        start_angle: Radians,
        /// What it turns around.
        center: Point<Points>,
    },
}

/// A `CanvasGradient`.
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasGradient {
    /// Where it runs.
    pub shape: GradientShape,
    /// Offsets (0..1, ascending) and colors.
    pub stops: Vec<(Percentage, Color)>,
}

impl CanvasGradient {
    fn new(shape: GradientShape) -> Self {
        Self {
            shape,
            stops: Vec::new(),
        }
    }

    /// Along the line from `start` to `end` (`createLinearGradient`).
    pub fn linear(start: Point<Points>, end: Point<Points>) -> Self {
        Self::new(GradientShape::Linear { start, end })
    }

    /// From the circle around `start` of `start_radius` to the one around
    /// `end` of `end_radius` (`createRadialGradient`).
    pub fn radial(
        start: Point<Points>,
        start_radius: Points,
        end: Point<Points>,
        end_radius: Points,
    ) -> Self {
        Self::new(GradientShape::Radial {
            start,
            start_radius,
            end,
            end_radius,
        })
    }

    /// Around `center`, from `start_angle` (clockwise from the x axis;
    /// `createConicGradient`).
    pub fn conic(start_angle: Radians, center: Point<Points>) -> Self {
        Self::new(GradientShape::Conic {
            start_angle,
            center,
        })
    }

    /// Adds `color` at `offset` (0..1, clamped; `addColorStop`): stops
    /// apply in offset order, equal ones in the order added.
    pub fn add_color_stop(mut self, offset: Percentage, color: impl Into<crate::Hsla>) -> Self {
        let offset = offset.clamp(Percentage(0.0), Percentage(1.0));
        let at = self.stops.partition_point(|(o, _)| *o <= offset);
        self.stops.insert(at, (offset, Color::from(color.into())));
        self
    }

    /// The CSS gradient `gradient` (a layer of `background-image`) as the
    /// background of a box at `area` (canvas coordinates) draws it: the
    /// gradient line and its stops resolved for the box's size as CSS
    /// resolves them, a repeating gradient's stops repeated along the
    /// whole line. `None` for an elliptical radial gradient, which a canvas
    /// gradient (between circles) does not draw.
    pub fn from_css(gradient: &crate::effects::Gradient, area: Bounds<Points>) -> Option<Self> {
        use crate::{effects::GradientKind, geometry::point};
        let size = area.size;
        let (w, h) = (size.width.0, size.height.0);
        let (left, top) = (area.origin.x.0, area.origin.y.0);
        let at = |x: f32, y: f32| point(px(x), px(y));
        let shape = match gradient.kind {
            GradientKind::Radial { circle: false, .. } => return None,
            GradientKind::Radial { x, y, .. } => {
                let center = at(left + x.0 * w, top + y.0 * h);
                GradientShape::Radial {
                    start: center,
                    start_radius: Points::ZERO,
                    end: center,
                    end_radius: gradient.line_length(size),
                }
            }
            // CSS turns from the top, a canvas from the x axis; both
            // clockwise.
            GradientKind::Conic { from, x, y } => GradientShape::Conic {
                start_angle: Radians(from.0 - std::f32::consts::FRAC_PI_2),
                center: at(left + x.0 * w, top + y.0 * h),
            },
            kind => {
                // Through the center at the angle, long enough that the
                // corners get the end colors (CSS Images 3).
                let angle = kind
                    .linear_angle(size)
                    .unwrap_or(Radians(std::f32::consts::PI));
                // A quarter turn's sine and cosine exactly (`to bottom` is
                // 180deg): float error would put the line a hair off the
                // box's edges.
                let exact = |v: f32| {
                    if v.abs() < 1e-6 {
                        0.0
                    } else if (v.abs() - 1.0).abs() < 1e-6 {
                        v.signum()
                    } else {
                        v
                    }
                };
                let (sin, cos) = angle.sin_cos();
                let (sin, cos) = (exact(sin), exact(cos));
                // CSS's gradient line: |w sin| + |h cos| long.
                let half = ((w * sin).abs() + (h * cos).abs()) / 2.0;
                let (cx, cy) = (left + w / 2.0, top + h / 2.0);
                GradientShape::Linear {
                    start: at(cx - sin * half, cy + cos * half),
                    end: at(cx + sin * half, cy - cos * half),
                }
            }
        };
        let mut stops = gradient.unrolled_stops(size, Percentage(1.0));
        // A canvas gradient clamps offsets, which would squeeze stops past
        // either end: they are cut there, at the color between.
        if !stops.iter().all(|s| (0.0..=1.0).contains(&s.1.0)) {
            stops = crate::effects::cut_stops(&stops, Percentage(1.0));
        }
        let mut out = Self::new(shape);
        out.stops = stops.into_iter().map(|(color, at)| (at, color)).collect();
        Some(out)
    }
}

/// `fillStyle` / `strokeStyle`.
#[derive(Debug, Clone, PartialEq)]
pub enum Paint {
    /// A color.
    Color(Color),
    /// The current value of an animated value interpolating colors.
    Slot(u16),
    /// A gradient.
    Gradient(Arc<CanvasGradient>),
}

/// `globalCompositeOperation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(missing_docs)]
pub enum Composite {
    #[default]
    SourceOver,
    SourceIn,
    SourceOut,
    SourceAtop,
    DestinationOver,
    DestinationIn,
    DestinationOut,
    DestinationAtop,
    Lighter,
    Copy,
    Xor,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl Composite {
    /// Parses a `globalCompositeOperation` name.
    pub fn parse(name: &str) -> Option<Composite> {
        use Composite::*;
        Some(match name {
            "source-over" => SourceOver,
            "source-in" => SourceIn,
            "source-out" => SourceOut,
            "source-atop" => SourceAtop,
            "destination-over" => DestinationOver,
            "destination-in" => DestinationIn,
            "destination-out" => DestinationOut,
            "destination-atop" => DestinationAtop,
            "lighter" => Lighter,
            "copy" => Copy,
            "xor" => Xor,
            "multiply" => Multiply,
            "screen" => Screen,
            "overlay" => Overlay,
            "darken" => Darken,
            "lighten" => Lighten,
            "color-dodge" => ColorDodge,
            "color-burn" => ColorBurn,
            "hard-light" => HardLight,
            "soft-light" => SoftLight,
            "difference" => Difference,
            "exclusion" => Exclusion,
            "hue" => Hue,
            "saturation" => Saturation,
            "color" => Color,
            "luminosity" => Luminosity,
            _ => return None,
        })
    }
}

/// `font` (the CSS shorthand).
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasFont {
    /// Size.
    pub size: Points,
    /// 100..900.
    pub weight: u16,
    /// Italic.
    pub italic: bool,
    /// The first family; `None` is the system font (also for
    /// `system-ui` / `sans-serif`).
    pub family: Option<Arc<str>>,
    /// OpenType features: `small-caps` and (beyond CSS, which only has
    /// them in `font-variant-numeric`) `tabular-nums`, `oldstyle-nums`,
    /// `lining-nums` and `proportional-nums` in the shorthand.
    pub variant: FontVariant,
}

impl Default for CanvasFont {
    /// The canvas default, `10px sans-serif`.
    fn default() -> Self {
        Self {
            size: px(10.0),
            weight: 400,
            italic: false,
            family: None,
            variant: FontVariant::default(),
        }
    }
}

impl CanvasFont {
    /// Parses the CSS `font` shorthand (`italic bold 14px Inter`,
    /// `600 12px/1.2 system-ui`, `tabular-nums 13px system-ui`); `None` if
    /// it is invalid (canvas keeps the previous font then).
    pub fn parse(s: &str) -> Option<CanvasFont> {
        let mut font = CanvasFont {
            size: Points::ZERO,
            ..CanvasFont::default()
        };
        let mut rest = s.trim();
        // Style / variant / weight / stretch keywords until the size.
        loop {
            let (word, tail) = match rest.split_once(char::is_whitespace) {
                Some((w, t)) => (w, t.trim_start()),
                None => (rest, ""),
            };
            if let Some(size) = font_size(word) {
                font.size = size;
                rest = tail;
                break;
            }
            match word {
                "italic" | "oblique" => font.italic = true,
                "normal" | "condensed" | "expanded" => {}
                w if let Some(v) = FontVariant::parse(w) => font.variant.0 |= v.0,
                "bold" | "bolder" => font.weight = 700,
                "lighter" => font.weight = 300,
                w => match w.parse::<u16>() {
                    Ok(n) if (1..=1000).contains(&n) => font.weight = n,
                    _ => return None,
                },
            }
            if tail.is_empty() {
                return None;
            }
            rest = tail;
        }
        let family = rest
            .split(',')
            .next()
            .map(|f| f.trim().trim_matches(['"', '\'']))
            .filter(|f| !f.is_empty())?;
        font.family = match family {
            "system-ui" | "sans-serif" | "-apple-system" | "ui-sans-serif" => None,
            f => Some(f.into()),
        };
        Some(font)
    }
}

/// `14px` / `14px/1.2` / `1.5rem` / `12pt`: the size.
fn font_size(word: &str) -> Option<Points> {
    let word = word.split('/').next()?;
    let (num, scale) = if let Some(n) = word.strip_suffix("px") {
        (n, 1.0)
    } else if let Some(n) = word.strip_suffix("rem").or_else(|| word.strip_suffix("em")) {
        (n, 16.0)
    } else {
        (word.strip_suffix("pt")?, 4.0 / 3.0)
    };
    num.parse::<f32>()
        .ok()
        .filter(|v| *v > 0.0)
        .map(|v| Points(v * scale))
}

impl CanvasFont {
    /// This font with the numeric forms of `numeric` (`fontVariantNumeric`)
    /// in place of its own, unless `numeric` is `normal`.
    pub fn with_numeric(&self, numeric: FontVariant) -> CanvasFont {
        let mut font = self.clone();
        if numeric.0 != 0 {
            font.variant = FontVariant(font.variant.0 & FontVariant::SMALL_CAPS | numeric.0);
        }
        font
    }

    /// The text style of this font.
    pub fn text_style(&self) -> crate::text::ResolvedTextStyle {
        crate::text::ResolvedTextStyle {
            font_size: self.size,
            font_weight: self.weight,
            italic: self.italic,
            font_variant: self.variant,
            font_family: self.family.as_deref().map(crate::style::FontFamily::new),
            ..Default::default()
        }
    }
}

/// The width of `text` on one line in `font` (canvas `measureText`).
pub fn measure_line(
    engine: &impl crate::text::TextEngine,
    font: &CanvasFont,
    text: &str,
) -> Points {
    if let Some(width) = engine.measure_canvas(font, text) {
        return width;
    }
    if text.is_empty() {
        return Points::ZERO;
    }
    advance(engine, font, text)
}

/// What closes a text ending in white space while it is measured.
const MARK: &str = "x";

/// How far `text` advances on one line in `font`, its trailing white space
/// included, as canvas `measureText` counts it. Text engines lay a line
/// out without the white space at its end (it hangs past the line, as in
/// CSS), so a run of spaces measures 0 and `"a "` as `"a"`: such a text is
/// measured with a mark after it, less the mark.
fn advance(engine: &impl crate::text::TextEngine, font: &CanvasFont, text: &str) -> Points {
    let width = |text: &str| {
        let mut attributed = crate::text::AttributedText {
            no_wrap: true,
            max_lines: 1,
            ..Default::default()
        };
        attributed.push(text, font.text_style());
        let prepared = engine.prepare(&attributed);
        engine.measure(&prepared, None).width
    };
    // A line break ends the line: what follows it is not on it.
    let hangs = text.ends_with(|c: char| c.is_whitespace() && !is_line_break(c));
    if !hangs {
        return width(text);
    }
    let mut marked = String::with_capacity(text.len() + MARK.len());
    marked.push_str(text);
    marked.push_str(MARK);
    (width(&marked) - width(MARK)).max(Points::ZERO)
}

/// Whether `c` breaks a line (Unicode's mandatory breaks).
fn is_line_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

/// How `text` sits on one line in a canvas font ([`line_metrics`]): its
/// width, and the font's extent above and below the baseline, so a
/// component can center text in a box or place a caret over it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct TextMetrics {
    /// The advance width (canvas `measureText(text).width`).
    pub width: Points,
    /// Above the baseline (`fontBoundingBoxAscent`).
    pub ascent: Points,
    /// Below the baseline (`fontBoundingBoxDescent`).
    pub descent: Points,
    /// The line's height: ascent, descent and the font's leading.
    pub height: Points,
}

/// [`TextMetrics`] of `text` on one line in `font`, by `engine`. Engines
/// that do not report their lines give the em box's split of the size
/// (0.8 above the baseline, 0.2 below) and the measured height.
pub fn line_metrics(
    engine: &impl crate::text::TextEngine,
    font: &CanvasFont,
    text: &str,
) -> TextMetrics {
    let mut attributed = crate::text::AttributedText {
        no_wrap: true,
        max_lines: 1,
        ..Default::default()
    };
    // An empty line still has the font's extent.
    attributed.push(if text.is_empty() { " " } else { text }, font.text_style());
    let prepared = engine.prepare(&attributed);
    let size = engine.measure(&prepared, None);
    let width = if text.is_empty() {
        Points::ZERO
    } else {
        // Preserve canvas-specific advances, distinct from terminal cell layout.
        engine
            .measure_canvas(font, text)
            .unwrap_or_else(|| advance(engine, font, text))
    };
    let layout = engine.layout(&prepared, size);
    match engine.lines(&layout).first() {
        Some(line) => TextMetrics {
            width,
            ascent: line.ascender,
            descent: line.descender,
            height: line.height,
        },
        None => TextMetrics {
            width,
            ascent: Points(font.size.0 * 0.8),
            descent: Points(font.size.0 * 0.2),
            height: size.height,
        },
    }
}

/// Where text sits horizontally relative to its x (`textAlign`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum CanvasTextAlign {
    /// `start` (left, or right right to left).
    #[default]
    Start,
    /// `end`.
    End,
    /// `left`.
    Left,
    /// `right`.
    Right,
    /// `center`.
    Center,
}

/// Where text sits vertically relative to its y (`textBaseline`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum CanvasTextBaseline {
    /// `alphabetic`.
    #[default]
    Alphabetic,
    /// `top` (the em box's top: the ascent).
    Top,
    /// `hanging`.
    Hanging,
    /// `middle`.
    Middle,
    /// `ideographic`.
    Ideographic,
    /// `bottom`.
    Bottom,
}

/// What `drawImage` draws: a URL or an imported asset.
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasImage {
    /// URL or `asset:/path`.
    pub uri: Arc<str>,
}

/// One recorded operation. The methods and properties without `method` /
/// `property` are written in `canvas.ts` (overloads, the state stack,
/// gradients, images).
#[derive(Debug, Clone, PartialEq, JsOps)]
#[ops(cx = Drawing)]
pub enum CanvasOp {
    /// `save()`.
    #[op(code = CV_SAVE)]
    Save,
    /// `restore()`.
    #[op(code = CV_RESTORE)]
    Restore,
    /// `translate(x, y)`: moves the origin.
    #[op(code = CV_TRANSLATE, method = "translate", params = "x, y")]
    Translate(Num, Num),
    /// `scale(x, y)`: scales the axes.
    #[op(code = CV_SCALE, method = "scale", params = "x, y")]
    Scale(Num, Num),
    /// `rotate(angle)`: rotates the axes; radians, clockwise.
    #[op(code = CV_ROTATE, method = "rotate", params = "angle")]
    Rotate(Num),
    /// `transform(a, b, c, d, e, f)`: multiplies the transform by the matrix
    /// [a c e; b d f].
    #[op(code = CV_TRANSFORM, method = "transform", params = "a, b, c, d, e, f")]
    Transform([Num; 6]),
    /// `setTransform(a, b, c, d, e, f)`: replaces the transform by the matrix
    /// [a c e; b d f].
    ///
    /// Relative to the view, not the device.
    #[op(code = CV_SET_TRANSFORM, method = "setTransform", params = "a, b, c, d, e, f")]
    SetTransform([Num; 6]),
    /// `beginPath()`: starts a new current path.
    #[op(code = CV_BEGIN_PATH, method = "beginPath")]
    BeginPath,
    /// Adds to the current path.
    #[op(nested)]
    Path(PathOp),
    /// `fill(path?, rule)`: the current path when `None`.
    #[op(code = CV_FILL)]
    Fill(Option<Path>, FillRule),
    /// `stroke(path?)`.
    #[op(code = CV_STROKE)]
    Stroke(Option<Path>),
    /// `clip(path?, rule)`.
    #[op(code = CV_CLIP)]
    Clip(Option<Path>, FillRule),
    /// `fillRect(x, y, w, h)`: fills a rectangle with `fillStyle` (the
    /// current path stays).
    #[op(code = CV_FILL_RECT, method = "fillRect", params = "x, y, w, h")]
    FillRect([Num; 4]),
    /// `strokeRect(x, y, w, h)`: strokes a rectangle with `strokeStyle`.
    #[op(code = CV_STROKE_RECT, method = "strokeRect", params = "x, y, w, h")]
    StrokeRect([Num; 4]),
    /// `clearRect(x, y, w, h)`: makes a rectangle transparent.
    #[op(code = CV_CLEAR_RECT, method = "clearRect", params = "x, y, w, h")]
    ClearRect([Num; 4]),
    /// `fillStyle`.
    #[op(code = CV_FILL_STYLE)]
    FillStyle(Paint),
    /// `strokeStyle`.
    #[op(code = CV_STROKE_STYLE)]
    StrokeStyle(Paint),
    /// `lineWidth`: stroke width in points.
    #[op(code = CV_LINE_WIDTH, property = "lineWidth", initial = "1")]
    LineWidth(Num),
    /// `lineCap`: how strokes end.
    #[op(code = CV_LINE_CAP, property = "lineCap", initial = "\"butt\"")]
    LineCap(LineCap),
    /// `lineJoin`: how stroke segments join.
    #[op(code = CV_LINE_JOIN, property = "lineJoin", initial = "\"miter\"")]
    LineJoin(LineJoin),
    /// `miterLimit`: miter joins longer than this (in line widths) are
    /// beveled.
    #[op(code = CV_MITER_LIMIT, property = "miterLimit", initial = "10", min = 1.0)]
    MiterLimit(f32),
    /// `setLineDash(segments)`: an odd count is repeated, as in canvas.
    #[op(code = CV_LINE_DASH, with = crate::js::canvas::line_dash)]
    LineDash(Arc<[Points]>),
    /// `lineDashOffset`: where the dash pattern starts.
    #[op(code = CV_LINE_DASH_OFFSET, property = "lineDashOffset", initial = "0")]
    LineDashOffset(Num),
    /// `globalAlpha`: opacity of what is drawn next, 0..1.
    #[op(code = CV_GLOBAL_ALPHA, property = "globalAlpha", initial = "1")]
    GlobalAlpha(Num),
    /// `globalCompositeOperation`: how what is drawn next combines with the
    /// canvas (`source-over`, `multiply`, ...).
    #[op(
        code = CV_COMPOSITE,
        property = "globalCompositeOperation",
        initial = "\"source-over\""
    )]
    Composite(Composite),
    /// `shadowColor`: the color of shadows (transparent: none).
    #[op(code = CV_SHADOW_COLOR, property = "shadowColor", initial = "\"rgba(0,0,0,0)\"")]
    ShadowColor(Color),
    /// `shadowBlur`: shadow blur in points.
    #[op(code = CV_SHADOW_BLUR, property = "shadowBlur", initial = "0", min = 0.0)]
    ShadowBlur(Points),
    /// `shadowOffsetX` / `shadowOffsetY`.
    #[op(code = CV_SHADOW_OFFSET)]
    ShadowOffset(Point<Points>),
    /// `font`: CSS `font` shorthand, e.g. `"600 14px Inter"` (sizes in px, pt
    /// or rem).
    #[op(code = CV_FONT, property = "font", initial = "\"10px sans-serif\"")]
    Font(CanvasFont),
    /// `fontVariantNumeric` (CSS's `font-variant-numeric`, which HTML
    /// Canvas lacks): `"tabular-nums"` for figures of equal width,
    /// `oldstyle-nums`, `lining-nums`, `proportional-nums` or `"normal"`
    /// (the font's own); kept apart from `font`, which does not reset it.
    #[op(
        code = CV_FONT_VARIANT_NUMERIC,
        property = "fontVariantNumeric",
        initial = "\"normal\""
    )]
    FontVariantNumeric(FontVariant),
    /// `textAlign`: where text sits horizontally relative to its x.
    #[op(code = CV_TEXT_ALIGN, property = "textAlign", initial = "\"start\"")]
    TextAlign(CanvasTextAlign),
    /// `textBaseline`: where text sits vertically relative to its y.
    #[op(code = CV_TEXT_BASELINE, property = "textBaseline", initial = "\"alphabetic\"")]
    TextBaseline(CanvasTextBaseline),
    /// `fillText(text, x, y, maxWidth?)`.
    #[op(code = CV_FILL_TEXT)]
    FillText {
        /// The text.
        text: Arc<str>,
        /// Where it starts.
        x: Num,
        /// Its baseline.
        y: Num,
        /// Narrowed to fit.
        max_width: Option<Points>,
    },
    /// `strokeText(text, x, y, maxWidth?)`.
    #[op(code = CV_STROKE_TEXT)]
    StrokeText {
        /// The text.
        text: Arc<str>,
        /// Where it starts.
        x: Num,
        /// Its baseline.
        y: Num,
        /// Narrowed to fit.
        max_width: Option<Points>,
    },
    /// `drawImage(image, [sx, sy, sw, sh,] dx, dy, dw, dh)`.
    #[op(code = CV_DRAW_IMAGE)]
    DrawImage {
        /// The image.
        image: CanvasImage,
        /// The part of it, in the image's pixels.
        source: Option<Bounds<ScaledPixels>>,
        /// Where it goes.
        dest: [Num; 4],
    },
}

impl CanvasOp {
    /// Whether it paints (rather than setting the state: transforms,
    /// styles, paths, clips).
    pub fn paints(&self) -> bool {
        matches!(
            self,
            CanvasOp::Fill(..)
                | CanvasOp::Stroke(_)
                | CanvasOp::FillRect(_)
                | CanvasOp::StrokeRect(_)
                | CanvasOp::ClearRect(_)
                | CanvasOp::FillText { .. }
                | CanvasOp::StrokeText { .. }
                | CanvasOp::DrawImage { .. }
        )
    }
}

/// One `draw` of a canvas.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Drawing {
    /// The operations, in order.
    pub ops: Vec<CanvasOp>,
    /// The animated values the operations read, by slot.
    pub slots: Vec<crate::animation::NodeId>,
    /// The parts of what it draws that are elements of their own to
    /// assistive technologies and UI tests ([`CanvasNode`]), in reading
    /// order.
    pub nodes: Vec<CanvasNode>,
    /// The operations whose value is the canvas view's style rather than
    /// one of their own, by index in `ops`: the core gives them the
    /// view's paint properties ([`crate::style::PaintStyle`], inherited
    /// from the views around it) before a platform gets the drawing
    /// ([`Drawing::painted`]), so what a Rust component draws follows the
    /// app's `fill-*` / `stroke-*` classes and the appearance without
    /// being recorded again.
    pub view_paints: Vec<(u32, ViewPaint)>,
}

/// An operation of a [`Drawing`] that takes its value from the canvas
/// view's paint properties ([`Drawing::view_paints`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ViewPaint {
    /// `fillStyle` is the view's `fill`; where nothing sets one, this.
    Fill(crate::style::SvgPaint),
    /// `strokeStyle` is the view's `stroke`; where nothing sets one, this.
    Stroke(crate::style::SvgPaint),
    /// `lineWidth` is the view's `strokeWidth` (1 where nothing sets one,
    /// CSS's initial value).
    StrokeWidth,
    /// The line dash is the view's `strokeDasharray` (solid where nothing
    /// sets one).
    StrokeDasharray,
    /// `fillStyle` is the view's text color: a shape filled with
    /// `currentColor` (an SVG's, [`crate::element::svg`]), which follows
    /// the text color whatever the view's `fill`.
    FillCurrentColor,
    /// `strokeStyle` is the view's text color
    /// ([`ViewPaint::FillCurrentColor`]).
    StrokeCurrentColor,
    /// `transform` maps a view box onto the canvas's box: the operations
    /// after it draw in the view box's coordinates, and the canvas lays
    /// out at its natural size ([`ViewBoxFit`]).
    Fit(ViewBoxFit),
    /// Fills the current path by `rule` with the view's background: its
    /// `backgroundColor`, then its `backgroundImage` layers over it (the
    /// last one first, as CSS stacks them), each positioned over `area`
    /// (canvas coordinates) as over a box of that size
    /// ([`CanvasGradient::from_css`]); the canvas's state is kept around
    /// it. The view draws no background of its own behind the drawing: it
    /// shows where this fills, as with CSS's `clip-path` (an area under a
    /// chart's line that fades out, in the app's `bg-linear-*` classes).
    Background {
        /// The box the background is positioned over.
        area: Bounds<Points>,
        /// Which parts of the path are inside.
        rule: FillRule,
    },
}

/// How a drawing in the coordinates of a view box fills its canvas, as
/// SVG's `viewBox` and `preserveAspectRatio` fit an `<svg>` into its box
/// ([`ViewPaint::Fit`]). The canvas lays out as an image does: at
/// [`Self::size`] where its style sets no size, keeping that aspect ratio
/// where it sets one side; the core maps the view box onto the box it gets
/// and sends the drawing again when that box changes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewBoxFit {
    /// The view box (`viewBox`), of a positive width and height.
    pub view_box: Bounds<Points>,
    /// Where the view box sits in the box along each axis, its aspect
    /// ratio kept: 0 at the start, 0.5 in the middle, 1 at the end
    /// (`xMidYMid` is 50% and 50%). `None` (`none`) stretches it to the
    /// box.
    pub align: Option<(Percentage, Percentage)>,
    /// It covers the box (`slice`) rather than fits inside it (`meet`).
    pub slice: bool,
    /// The natural size: the `<svg>`'s `width` and `height`.
    pub size: Size<Points>,
}

impl ViewBoxFit {
    /// The matrix `[a, b, c, d, e, f]` (`transform`'s) mapping the view box
    /// onto a box of `size` at the origin.
    pub fn transform(&self, size: Size<Points>) -> [f32; 6] {
        let Size { width, height } = self.view_box.size;
        let (vw, vh) = (width.0, height.0);
        let (w, h) = (size.width.0.max(0.0), size.height.0.max(0.0));
        if !(vw > 0.0 && vh > 0.0) {
            return [0.0; 6];
        }
        let (mut sx, mut sy) = (w / vw, h / vh);
        let (ax, ay) = match self.align {
            None => (0.0, 0.0),
            Some((x, y)) => {
                let s = if self.slice { sx.max(sy) } else { sx.min(sy) };
                (sx, sy) = (s, s);
                (x.0, y.0)
            }
        };
        let origin = self.view_box.origin;
        [
            sx,
            0.0,
            0.0,
            sy,
            (w - vw * sx) * ax - origin.x.0 * sx,
            (h - vh * sy) * ay - origin.y.0 * sy,
        ]
    }
}

/// A part of a canvas's drawing that assistive technologies and UI tests
/// see as an element of its own: a cell of a grid, a bar of a chart. It
/// is the canvas's child at `bounds` (points from the canvas's top left),
/// with its own role, name and test id; a press on it is a press at its
/// center, as a pointer there makes it, which goes to whatever view is
/// under that point and takes presses. The GPUI backend and the headless
/// driver show them; the other backends do not yet.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct CanvasNode {
    /// Where it is in the canvas.
    pub bounds: Bounds<Points>,
    /// What it is to assistive technologies.
    pub role: crate::AccessibilityRole,
    /// Its accessible name: the text it shows.
    pub label: Arc<str>,
    /// `testID`: an identifier for UI tests.
    pub test_id: Option<Arc<str>>,
    /// It is selected (a grid's selected cells).
    pub selected: bool,
}

impl CanvasNode {
    /// A node at `bounds` with `role`, named `label`.
    pub fn new(
        bounds: Bounds<Points>,
        role: crate::AccessibilityRole,
        label: impl Into<Arc<str>>,
    ) -> Self {
        Self {
            bounds,
            role,
            label: label.into(),
            ..Self::default()
        }
    }

    /// With the test id `id`.
    pub fn test_id(mut self, id: impl Into<Arc<str>>) -> Self {
        self.test_id = Some(id.into());
        self
    }

    /// Selected, or not.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

impl Drawing {
    /// Whether it fills with its view's background
    /// ([`ViewPaint::Background`]), which the view then does not draw.
    pub fn paints_background(&self) -> bool {
        self.view_paints
            .iter()
            .any(|(_, v)| matches!(v, ViewPaint::Background { .. }))
    }

    /// The view box it fits into its canvas ([`ViewPaint::Fit`]), if any.
    pub fn fit(&self) -> Option<ViewBoxFit> {
        self.view_paints.iter().find_map(|&(_, v)| match v {
            ViewPaint::Fit(fit) => Some(fit),
            _ => None,
        })
    }

    /// The drawing as a platform replays it: its [`Drawing::view_paints`]
    /// given the paint properties `paint` of its view, whose text color is
    /// `current` (`currentColor`), its background, the color `background`
    /// under the gradients `images` (top layer first), and the size of its
    /// box, `size` (what a view box fits into). `none` paints nothing (a
    /// transparent paint). Its own `view_paints` are resolved, so it has
    /// none.
    pub fn painted(
        &self,
        paint: &crate::style::PaintStyle,
        current: Color,
        background: Color,
        images: &[crate::effects::Gradient],
        size: Size<Points>,
    ) -> Drawing {
        use crate::style::SvgPaint;
        let color = |p: SvgPaint| {
            Paint::Color(match p {
                SvgPaint::None => Color::TRANSPARENT,
                SvgPaint::CurrentColor => current,
                SvgPaint::Color(c) => c,
            })
        };
        let mut out = self.clone();
        for &(at, view) in &self.view_paints {
            let Some(op) = out.ops.get_mut(at as usize) else {
                continue;
            };
            *op = match view {
                ViewPaint::Fill(initial) => {
                    CanvasOp::FillStyle(color(paint.fill.unwrap_or(initial)))
                }
                ViewPaint::Stroke(initial) => {
                    CanvasOp::StrokeStyle(color(paint.stroke.unwrap_or(initial)))
                }
                ViewPaint::StrokeWidth => {
                    CanvasOp::LineWidth(Num::Const(paint.stroke_width.map_or(1.0, |w| w.0)))
                }
                ViewPaint::StrokeDasharray => CanvasOp::LineDash(
                    paint
                        .stroke_dasharray
                        .clone()
                        .unwrap_or_else(|| Arc::from([])),
                ),
                ViewPaint::FillCurrentColor => CanvasOp::FillStyle(Paint::Color(current)),
                ViewPaint::StrokeCurrentColor => CanvasOp::StrokeStyle(Paint::Color(current)),
                ViewPaint::Fit(fit) => CanvasOp::Transform(fit.transform(size).map(Num::Const)),
                // Expanded below: its place holds the fill it becomes.
                ViewPaint::Background { .. } => continue,
            };
        }
        out.view_paints = Vec::new();
        if !self.paints_background() {
            return out;
        }
        let ops = std::mem::take(&mut out.ops);
        let mut backgrounds = self.view_paints.iter().filter_map(|&(at, v)| match v {
            ViewPaint::Background { area, rule } => Some((at as usize, area, rule)),
            _ => None,
        });
        let mut next = backgrounds.next();
        for (i, op) in ops.into_iter().enumerate() {
            let Some((_, area, rule)) = next.filter(|&(at, ..)| at == i) else {
                out.ops.push(op);
                continue;
            };
            next = backgrounds.next();
            out.ops.push(CanvasOp::Save);
            if !background.is_transparent() {
                out.ops.push(CanvasOp::FillStyle(Paint::Color(background)));
                out.ops.push(CanvasOp::Fill(None, rule));
            }
            for image in images.iter().rev() {
                let Some(gradient) = CanvasGradient::from_css(image, area) else {
                    log::warn!("an elliptical `radial-gradient()` fills no canvas shape");
                    continue;
                };
                out.ops
                    .push(CanvasOp::FillStyle(Paint::Gradient(Arc::new(gradient))));
                out.ops.push(CanvasOp::Fill(None, rule));
            }
            out.ops.push(CanvasOp::Restore);
        }
        out
    }

    /// The slot of animated value `node`, adding it if new.
    pub fn slot(&mut self, node: crate::animation::NodeId) -> u16 {
        match self.slots.iter().position(|&n| n == node) {
            Some(i) => i as u16,
            None => {
                self.slots.push(node);
                (self.slots.len() - 1) as u16
            }
        }
    }

    /// The images it draws.
    pub fn images(&self) -> impl Iterator<Item = &CanvasImage> {
        self.ops.iter().filter_map(|op| match op {
            CanvasOp::DrawImage { image, .. } => Some(image),
            _ => None,
        })
    }
}

/// A length: values of another type are zero (as `f32`'s).
impl<Cx> OpArg<Cx> for Points {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        cx: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(<f32 as OpArg<Cx>>::read(r, cx)?.map(Points))
    }

    fn ts(types: &mut TsTypes) -> String {
        <f32 as OpArg<Cx>>::ts(types)
    }
}

/// A length, or nothing (`maxWidth`).
impl<Cx> OpArg<Cx> for Option<Points> {
    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        cx: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        Ok(<Option<f32> as OpArg<Cx>>::read(r, cx)?.map(|v| v.map(Points)))
    }

    fn ts(types: &mut TsTypes) -> String {
        <Option<f32> as OpArg<Cx>>::ts(types)
    }
}

/// A point: two arguments, `x` then `y`.
impl<Cx> OpArg<Cx> for Point<Points> {
    const ARITY: usize = 2;

    fn read<L: HostList<Item: HostInput>>(
        r: &mut OpReader<'_, L>,
        cx: &mut Cx,
    ) -> Result<Option<Self>, OpsError> {
        let x = <Points as OpArg<Cx>>::read(r, cx)?;
        let y = <Points as OpArg<Cx>>::read(r, cx)?;
        Ok(x.zip(y).map(|(x, y)| Point { x, y }))
    }

    fn ts(types: &mut TsTypes) -> String {
        <Points as OpArg<Cx>>::ts(types)
    }
}

/// The signed sweep of `arc` / `ellipse` from `start` to `end`, as the
/// Canvas spec defines it: a full turn when the angles are a turn or more
/// apart in the drawing direction, else the angle between them going that
/// way.
pub fn arc_sweep(start: Radians, end: Radians, ccw: bool) -> Radians {
    Radians(sweep(start.0, end.0, ccw))
}

pub(crate) fn sweep(start: f32, end: f32, ccw: bool) -> f32 {
    use std::f32::consts::TAU;
    if !ccw {
        if end - start >= TAU {
            TAU
        } else {
            (end - start).rem_euclid(TAU)
        }
    } else if start - end >= TAU {
        -TAU
    } else {
        -(start - end).rem_euclid(TAU)
    }
}

/// Corner radii of `roundRect` scaled down to fit a box of `size` (CSS
/// rule: all by the same factor when two on one side overlap); a negative
/// size is a box drawn the other way.
pub fn fit_radii(size: Size<Points>, radii: Corners<Points>) -> Corners<Points> {
    let [tl, tr, br, bl] = fit(
        size.width.0,
        size.height.0,
        [
            radii.top_left.0,
            radii.top_right.0,
            radii.bottom_right.0,
            radii.bottom_left.0,
        ],
    );
    Corners {
        top_left: Points(tl),
        top_right: Points(tr),
        bottom_right: Points(br),
        bottom_left: Points(bl),
    }
}

/// [`fit_radii`] on bare numbers: top left, top right, bottom right,
/// bottom left.
pub(crate) fn fit(w: f32, h: f32, radii: [f32; 4]) -> [f32; 4] {
    let r = radii.map(|r| r.max(0.0));
    let (w, h) = (w.abs(), h.abs());
    let sides = [r[0] + r[1], r[2] + r[3], r[0] + r[3], r[1] + r[2]];
    let limits = [w, w, h, h];
    let scale = sides
        .iter()
        .zip(limits)
        .filter(|(s, _)| **s > 0.0)
        .map(|(s, l)| l / s)
        .fold(1.0f32, f32::min);
    r.map(|r| r * scale)
}

// --- SVG path data (`new Path2D("M0 0 L10 10")`) ----------------------------

/// SVG path data as a path to fill, stroke or clip (TS: `new
/// Path2D(d)`), parsed by [`parse_svg_path`].
pub fn svg_path(d: &str) -> Path {
    parse_svg_path(d).into()
}

/// Parses SVG path data into path operations (absolute coordinates;
/// smooth curves made explicit, arcs as cubic Béziers). Parsing stops at
/// the first error, keeping what came before, as SVG renderers do.
pub fn parse_svg_path(d: &str) -> Vec<PathOp> {
    let mut out = Vec::new();
    let mut p = PathParser {
        s: d.as_bytes(),
        pos: 0,
    };
    let (mut x, mut y) = (0f32, 0f32);
    let (mut sx, mut sy) = (0f32, 0f32);
    // The last control point, for S / T.
    let mut last_cubic: Option<(f32, f32)> = None;
    let mut last_quad: Option<(f32, f32)> = None;
    let mut command = 0u8;
    let c = |v: f32| Num::Const(v);
    loop {
        p.skip_separators();
        if p.pos >= p.s.len() {
            break;
        }
        let b = p.s[p.pos];
        if b.is_ascii_alphabetic() {
            command = b;
            p.pos += 1;
        } else if command == 0 {
            break;
        } else if command == b'M' {
            // Coordinates after a moveto are linetos.
            command = b'L';
        } else if command == b'm' {
            command = b'l';
        }
        let rel = command.is_ascii_lowercase();
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        let upper = command.to_ascii_uppercase();
        let ok = (|| -> Option<()> {
            match upper {
                b'M' => {
                    let (nx, ny) = (p.number()? + ox, p.number()? + oy);
                    out.push(PathOp::MoveTo(c(nx), c(ny)));
                    (x, y, sx, sy) = (nx, ny, nx, ny);
                    last_cubic = None;
                    last_quad = None;
                }
                b'L' => {
                    let (nx, ny) = (p.number()? + ox, p.number()? + oy);
                    out.push(PathOp::LineTo(c(nx), c(ny)));
                    (x, y) = (nx, ny);
                    last_cubic = None;
                    last_quad = None;
                }
                b'H' => {
                    x = p.number()? + ox;
                    out.push(PathOp::LineTo(c(x), c(y)));
                    last_cubic = None;
                    last_quad = None;
                }
                b'V' => {
                    y = p.number()? + oy;
                    out.push(PathOp::LineTo(c(x), c(y)));
                    last_cubic = None;
                    last_quad = None;
                }
                b'C' | b'S' => {
                    let (x1, y1) = if upper == b'C' {
                        (p.number()? + ox, p.number()? + oy)
                    } else {
                        // The reflection of the last control point.
                        last_cubic.map_or((x, y), |(cx, cy)| (2.0 * x - cx, 2.0 * y - cy))
                    };
                    let (x2, y2) = (p.number()? + ox, p.number()? + oy);
                    let (nx, ny) = (p.number()? + ox, p.number()? + oy);
                    out.push(PathOp::CubicTo([x1, y1, x2, y2, nx, ny].map(c)));
                    last_cubic = Some((x2, y2));
                    last_quad = None;
                    (x, y) = (nx, ny);
                }
                b'Q' | b'T' => {
                    let (x1, y1) = if upper == b'Q' {
                        (p.number()? + ox, p.number()? + oy)
                    } else {
                        last_quad.map_or((x, y), |(cx, cy)| (2.0 * x - cx, 2.0 * y - cy))
                    };
                    let (nx, ny) = (p.number()? + ox, p.number()? + oy);
                    out.push(PathOp::QuadTo([x1, y1, nx, ny].map(c)));
                    last_quad = Some((x1, y1));
                    last_cubic = None;
                    (x, y) = (nx, ny);
                }
                b'A' => {
                    let rx = p.number()?.abs();
                    let ry = p.number()?.abs();
                    let rotation = p.number()?;
                    let large = p.flag()?;
                    let sweep = p.flag()?;
                    let (nx, ny) = (p.number()? + ox, p.number()? + oy);
                    arc_to_cubics(&mut out, (x, y), (rx, ry), rotation, large, sweep, (nx, ny));
                    (x, y) = (nx, ny);
                    last_cubic = None;
                    last_quad = None;
                }
                b'Z' => {
                    out.push(PathOp::Close);
                    (x, y) = (sx, sy);
                    last_cubic = None;
                    last_quad = None;
                    // Z takes no numbers: a number after it starts nothing.
                    command = 0;
                }
                _ => return None,
            }
            Some(())
        })();
        if ok.is_none() {
            break;
        }
    }
    out
}

struct PathParser<'a> {
    s: &'a [u8],
    pos: usize,
}

impl PathParser<'_> {
    fn skip_separators(&mut self) {
        while self.pos < self.s.len()
            && (self.s[self.pos].is_ascii_whitespace() || self.s[self.pos] == b',')
        {
            self.pos += 1;
        }
    }

    fn number(&mut self) -> Option<f32> {
        self.skip_separators();
        let start = self.pos;
        let s = self.s;
        let mut i = self.pos;
        if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
            i += 1;
        }
        let mut digits = false;
        while i < s.len() && s[i].is_ascii_digit() {
            i += 1;
            digits = true;
        }
        if i < s.len() && s[i] == b'.' {
            i += 1;
            while i < s.len() && s[i].is_ascii_digit() {
                i += 1;
                digits = true;
            }
        }
        if !digits {
            return None;
        }
        if i < s.len() && (s[i] == b'e' || s[i] == b'E') {
            let mut j = i + 1;
            if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
                j += 1;
            }
            if j < s.len() && s[j].is_ascii_digit() {
                while j < s.len() && s[j].is_ascii_digit() {
                    j += 1;
                }
                i = j;
            }
        }
        self.pos = i;
        std::str::from_utf8(&s[start..i]).ok()?.parse().ok()
    }

    /// Arc flags may be written without separators (`a1 1 0 0110 10`).
    fn flag(&mut self) -> Option<bool> {
        self.skip_separators();
        let b = *self.s.get(self.pos)?;
        self.pos += 1;
        match b {
            b'0' => Some(false),
            b'1' => Some(true),
            _ => None,
        }
    }
}

/// An SVG elliptical arc as cubic Béziers (SVG implementation notes,
/// F.6.5 and F.6.6).
fn arc_to_cubics(
    out: &mut Vec<PathOp>,
    from: (f32, f32),
    radii: (f32, f32),
    rotation_deg: f32,
    large: bool,
    sweep: bool,
    to: (f32, f32),
) {
    let c = |v: f64| Num::Const(v as f32);
    let (x1, y1) = (from.0 as f64, from.1 as f64);
    let (x2, y2) = (to.0 as f64, to.1 as f64);
    let (mut rx, mut ry) = (radii.0 as f64, radii.1 as f64);
    if (x1 == x2 && y1 == y2) || rx == 0.0 || ry == 0.0 {
        if x1 != x2 || y1 != y2 {
            out.push(PathOp::LineTo(c(x2), c(y2)));
        }
        return;
    }
    let phi = (rotation_deg as f64).to_radians();
    let (sin, cos) = phi.sin_cos();
    let dx = (x1 - x2) / 2.0;
    let dy = (y1 - y2) / 2.0;
    let x1p = cos * dx + sin * dy;
    let y1p = -sin * dx + cos * dy;
    // Radii too small to reach: scale them up.
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut coef = (num / den).max(0.0).sqrt();
    if large == sweep {
        coef = -coef;
    }
    let cxp = coef * rx * y1p / ry;
    let cyp = -coef * ry * x1p / rx;
    let cx = cos * cxp - sin * cyp + (x1 + x2) / 2.0;
    let cy = sin * cxp + cos * cyp + (y1 + y2) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let theta1 = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut delta = angle(
        (x1p - cxp) / rx,
        (y1p - cyp) / ry,
        (-x1p - cxp) / rx,
        (-y1p - cyp) / ry,
    );
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    // At most a quarter turn per segment.
    let segments = (delta.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let step = delta / segments as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let point = |t: f64| {
        let (s, co) = t.sin_cos();
        (
            cx + rx * co * cos - ry * s * sin,
            cy + rx * co * sin + ry * s * cos,
        )
    };
    let derivative = |t: f64| {
        let (s, co) = t.sin_cos();
        (-rx * s * cos - ry * co * sin, -rx * s * sin + ry * co * cos)
    };
    let mut t = theta1;
    for i in 0..segments {
        let t2 = t + step;
        let (p1x, p1y) = point(t);
        let (d1x, d1y) = derivative(t);
        let (p2x, p2y) = if i + 1 == segments {
            (x2, y2)
        } else {
            point(t2)
        };
        let (d2x, d2y) = derivative(t2);
        out.push(PathOp::CubicTo([
            c(p1x + k * d1x),
            c(p1y + k * d1y),
            c(p2x - k * d2x),
            c(p2y - k * d2y),
            c(p2x),
            c(p2y),
        ]));
        t = t2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{AttributedText, TextEngine, TextLayout};

    /// A CSS gradient as the background of a box: the line through the
    /// box's center at the gradient's angle, as long as CSS makes it, and
    /// its stops; a repeating one's stops repeated over the whole line, the
    /// ends cut at the colors there; an elliptical radial one not drawn.
    #[test]
    fn css_gradients_become_canvas_gradients_over_a_box() {
        use crate::geometry::{bounds, point, size};
        let area = bounds(point(px(10.0), px(20.0)), size(px(100.0), px(50.0)));
        let one = |css: &str| crate::css::gradients(css).unwrap().remove(0);
        let gradient = |css: &str| CanvasGradient::from_css(&one(css), area);
        let down = gradient("linear-gradient(to bottom, #ff0000, #0000ff)").unwrap();
        assert_eq!(
            down.shape,
            GradientShape::Linear {
                start: point(px(60.0), px(20.0)),
                end: point(px(60.0), px(70.0)),
            }
        );
        assert_eq!(down.stops[0], (Percentage(0.0), Color(0xff00_00ff)));
        assert_eq!(
            down.stops[down.stops.len() - 1],
            (Percentage(1.0), Color(0x0000_ffff))
        );
        let right = gradient("linear-gradient(90deg, #ff0000, #0000ff)").unwrap();
        let GradientShape::Linear { start, end } = right.shape else {
            panic!("{right:?}")
        };
        assert!((start.x.0 - 10.0).abs() < 1e-3 && (start.y.0 - 45.0).abs() < 1e-3);
        assert!((end.x.0 - 110.0).abs() < 1e-3 && (end.y.0 - 45.0).abs() < 1e-3);
        // Repeating every quarter: the stops again at each quarter, all
        // within the line.
        let stripes =
            gradient("repeating-linear-gradient(to bottom, #ff0000 0%, #0000ff 25%)").unwrap();
        let at = |o: f32| {
            stripes
                .stops
                .iter()
                .filter(|(p, _)| (p.0 - o).abs() < 1e-4)
                .count()
        };
        assert!(
            at(0.25) >= 2 && at(0.5) >= 2 && at(0.75) >= 2,
            "{stripes:?}"
        );
        assert!(
            stripes
                .stops
                .iter()
                .all(|(p, _)| (0.0..=1.0).contains(&p.0))
        );
        // Stops past the end: cut there, at the color between.
        let cut = gradient("linear-gradient(to bottom, #000000 0%, #ffffff 200%)").unwrap();
        assert_eq!(
            cut.stops[cut.stops.len() - 1],
            (Percentage(1.0), Color(0x8080_80ff))
        );
        assert!(gradient("radial-gradient(#ff0000, #0000ff)").is_none());
        let circle = gradient("radial-gradient(circle, #ff0000, #0000ff)").unwrap();
        assert!(matches!(circle.shape, GradientShape::Radial { .. }));
    }

    /// A drawing filling with its view's background: the color, then each
    /// gradient from the bottom layer up, filling the path, the canvas's
    /// state kept around them.
    #[test]
    fn a_drawing_fills_with_its_views_background() {
        use crate::geometry::{bounds, point, size};
        let area = bounds(point(px(0.0), px(0.0)), size(px(10.0), px(10.0)));
        let drawing = crate::element::Painter::new()
            .begin_path()
            .fill_background_from_view(area)
            .finish();
        assert!(drawing.paints_background());
        let images = crate::css::gradients("linear-gradient(#ff0000, #0000ff)").unwrap();
        let none = crate::style::PaintStyle::default();
        let painted = drawing.painted(
            &none,
            Color::TRANSPARENT,
            Color(0x00ff_00ff),
            &images,
            Size::default(),
        );
        assert!(painted.view_paints.is_empty());
        let ops = &painted.ops[1..];
        assert_eq!(ops[0], CanvasOp::Save);
        assert_eq!(
            ops[1],
            CanvasOp::FillStyle(Paint::Color(Color(0x00ff_00ff)))
        );
        assert_eq!(ops[2], CanvasOp::Fill(None, FillRule::NonZero));
        assert!(matches!(ops[3], CanvasOp::FillStyle(Paint::Gradient(_))));
        assert_eq!(ops[4], CanvasOp::Fill(None, FillRule::NonZero));
        assert_eq!(ops[5], CanvasOp::Restore);
        // No background: nothing fills.
        let bare = drawing.painted(
            &none,
            Color::TRANSPARENT,
            Color::TRANSPARENT,
            &[],
            Size::default(),
        );
        assert_eq!(&bare.ops[1..], [CanvasOp::Save, CanvasOp::Restore]);
    }

    /// Lays a line out as text engines do: 10 points a character, without
    /// the white space at its end.
    struct Hanging;

    impl TextEngine for Hanging {
        type Prepared = String;

        fn prepare(&self, text: &AttributedText) -> String {
            text.text.to_string()
        }

        fn prepare_aligned(
            &self,
            text: &AttributedText,
            _: &crate::text::AttachmentAlignments,
        ) -> String {
            self.prepare(text)
        }

        fn measure(&self, text: &String, _: Option<Points>) -> Size<Points> {
            let shown = text.trim_end_matches(|c: char| c.is_whitespace());
            Size::new(Points(10.0 * shown.chars().count() as f32), Points(12.0))
        }

        fn layout(&self, _: &String, _: Size<Points>) -> TextLayout {
            TextLayout(std::sync::Arc::new(()))
        }
    }

    #[test]
    fn trailing_white_space_advances_as_canvas_measures_it() {
        let font = CanvasFont::default();
        for (text, width) in [
            ("", 0.0),
            ("ab", 20.0),
            (" ", 10.0),
            ("   ", 30.0),
            ("  items: ", 90.0),
            ("a\t", 20.0),
            // Chinese and its ideographic space, a character each.
            ("名字\u{3000}", 30.0),
            ("你好 ", 30.0),
            // A line break ends the line.
            ("ab\n", 20.0),
        ] {
            assert_eq!(
                measure_line(&Hanging, &font, text),
                Points(width),
                "{text:?}"
            );
            assert_eq!(
                line_metrics(&Hanging, &font, text).width,
                Points(width),
                "{text:?}"
            );
        }
    }

    #[test]
    fn canvas_measurement_override_is_forwarded_by_shared_engines() {
        struct CanvasOnly;
        impl crate::TextEngine for CanvasOnly {
            type Prepared = ();
            fn prepare(&self, _: &crate::AttributedText) {
                panic!("Canvas override should handle measurement");
            }
            fn measure(&self, _: &(), _: Option<Points>) -> crate::Size<Points> {
                panic!("Canvas override should handle measurement");
            }
            fn layout(&self, _: &(), _: crate::Size<Points>) -> crate::TextLayout {
                panic!("not used by measurement");
            }
            fn measure_canvas(&self, font: &CanvasFont, text: &str) -> Option<Points> {
                Some(font.size * text.len() as f32)
            }
        }
        let font = CanvasFont::parse("20px sans-serif").unwrap();
        assert_eq!(
            measure_line(&std::rc::Rc::new(CanvasOnly), &font, "abc"),
            Points(60.0)
        );
        assert_eq!(
            measure_line(&std::rc::Rc::new(CanvasOnly), &font, "  "),
            Points(40.0)
        );
        // Engines using the default hook retain their existing prepare/measure path.
        assert!(
            (measure_line(&crate::ApproxTextEngine, &font, "abc") - Points(33.0)).abs()
                < Points(0.001)
        );
    }

    fn consts(op: &PathOp) -> Vec<f32> {
        let v = |n: &Num| match n {
            Num::Const(v) => *v,
            Num::Slot(_) => f32::NAN,
        };
        match op {
            PathOp::MoveTo(a, b) | PathOp::LineTo(a, b) => vec![v(a), v(b)],
            PathOp::QuadTo(n) => n.iter().map(v).collect(),
            PathOp::CubicTo(n) => n.iter().map(v).collect(),
            _ => vec![],
        }
    }

    #[test]
    fn svg_paths_parse_to_absolute_ops() {
        let ops = parse_svg_path("M10 20 l5-5 H30 v10 z m1 1 2 2");
        assert_eq!(ops.len(), 7);
        assert_eq!(consts(&ops[1]), vec![15.0, 15.0]);
        assert_eq!(consts(&ops[2]), vec![30.0, 15.0]);
        assert_eq!(consts(&ops[3]), vec![30.0, 25.0]);
        assert_eq!(ops[4], PathOp::Close);
        // After Z the current point is the subpath's start.
        assert_eq!(consts(&ops[5]), vec![11.0, 21.0]);
        // Implicit lineto after a moveto.
        assert_eq!(consts(&ops[6]), vec![13.0, 23.0]);
        // Compact numbers: `.5.5` is two numbers, `1e2` an exponent.
        let ops = parse_svg_path("M.5.5L1e1-2");
        assert_eq!(consts(&ops[0]), vec![0.5, 0.5]);
        assert_eq!(consts(&ops[1]), vec![10.0, -2.0]);
    }

    #[test]
    fn smooth_curves_reflect_control_points() {
        let ops = parse_svg_path("M0 0 C0 10 10 10 10 0 S20 -10 20 0");
        assert_eq!(consts(&ops[2]), vec![10.0, -10.0, 20.0, -10.0, 20.0, 0.0]);
    }

    #[test]
    fn arcs_become_cubics_ending_on_the_point() {
        // A half circle of radius 10, flags without separators.
        let ops = parse_svg_path("M0 0 A10 10 0 0120 0");
        assert_eq!(ops.len(), 3);
        let last = consts(&ops[2]);
        assert!((last[4] - 20.0).abs() < 1e-4 && last[5].abs() < 1e-4);
        // Its top: the end of the first quarter, 10 above the center.
        let mid = consts(&ops[1]);
        assert!((mid[4] - 10.0).abs() < 1e-3 && (mid[5] + 10.0).abs() < 1e-3);
    }

    #[test]
    fn bad_path_data_keeps_what_parsed() {
        let ops = parse_svg_path("M0 0 L10 10 L oops");
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn arc_sweeps_follow_the_canvas_spec() {
        use std::f32::consts::{PI, TAU};

        use crate::geometry::{radians, size};
        let sweep = |a, b, ccw| arc_sweep(radians(a), radians(b), ccw).0;
        assert_eq!(sweep(0.0, PI, false), PI);
        // Backwards clockwise: the long way round.
        assert!((sweep(PI, 0.0, false) - PI).abs() < 1e-6);
        assert!((sweep(0.0, -PI / 2.0, false) - 1.5 * PI).abs() < 1e-5);
        assert_eq!(sweep(0.0, 3.0 * TAU, false), TAU);
        assert!((sweep(0.0, PI / 2.0, true) + 1.5 * PI).abs() < 1e-5);
        assert_eq!(sweep(TAU, 0.0, true), -TAU);
        let corners = |[top_left, top_right, bottom_right, bottom_left]: [f32; 4]| Corners {
            top_left: px(top_left),
            top_right: px(top_right),
            bottom_right: px(bottom_right),
            bottom_left: px(bottom_left),
        };
        assert_eq!(
            fit_radii(size(px(10.0), px(100.0)), corners([8.0, 8.0, 0.0, 0.0])),
            corners([5.0, 5.0, 0.0, 0.0])
        );
    }

    #[test]
    fn fonts_parse_the_css_shorthand() {
        let f = CanvasFont::parse("italic bold 14px \"Inter\", sans-serif").unwrap();
        assert_eq!((f.size, f.weight, f.italic), (px(14.0), 700, true));
        assert_eq!(f.family.as_deref(), Some("Inter"));
        let f = CanvasFont::parse("600 12px/1.5 system-ui").unwrap();
        assert_eq!((f.size, f.weight, f.family), (px(12.0), 600, None));
        let f = CanvasFont::parse("small-caps tabular-nums 13px system-ui").unwrap();
        assert_eq!(
            f.variant.0,
            FontVariant::SMALL_CAPS | FontVariant::TABULAR_NUMS
        );
        let numeric = f.with_numeric(FontVariant(FontVariant::OLDSTYLE_NUMS));
        assert_eq!(
            numeric.variant.0,
            FontVariant::SMALL_CAPS | FontVariant::OLDSTYLE_NUMS
        );
        assert_eq!(f.with_numeric(FontVariant::default()), f);
        assert!(CanvasFont::parse("wide 13px system-ui").is_none());
        assert!(CanvasFont::parse("bold").is_none());
        assert!(CanvasFont::parse("14px").is_none());
    }
}
