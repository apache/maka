//! Visual effects beyond React Native's classic view styles: layered and
//! inset box shadows, gradient backgrounds, filters, blend modes, outlines,
//! cursors, and the transitions / keyframe animations of class styles.

use std::sync::Arc;

use crate::{
    color::Hsla,
    geometry::{
        AbsoluteLength, Bounds, Corners, DefiniteLength, Edges, Percentage, Point, Points,
        REM_SIZE, Radians, Size, deg, point, size,
    },
    style::{BorderStyle, Color, CornerRadii},
};

/// `clipPath`: CSS's `inset()` shape, a rectangle inset from the view's
/// border box, its corners rounded (`inset(8px 0 0 50% round 12px)`).
/// Everything the view draws shows only inside it (its background, borders,
/// shadows and the views in it), and only there is the view, or anything in
/// it, hit. It transitions (`transitionProperty: "clip-path"`), each edge and
/// radius on its own, so a panel can open out of a corner.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct ClipInset {
    /// How far each edge moves in, in points (negative: out), besides
    /// [`Self::fractions`].
    pub offsets: Edges<Points>,
    /// How far each edge moves in as a fraction of the box's width (left and
    /// right) or height (top and bottom): CSS's percentages. An edge is at
    /// its offset plus its fraction of the size, as CSS's `calc()`, which is
    /// what an inset between a length and a percentage interpolates to.
    pub fractions: Edges<Percentage>,
    /// The corners' radii (`round`): circular, scaled down as a border's are
    /// where they do not fit.
    pub radii: Corners<Points>,
}

impl ClipInset {
    /// No inset and square corners: the border box.
    pub const fn new() -> Self {
        Self {
            offsets: Edges {
                top: Points::ZERO,
                right: Points::ZERO,
                bottom: Points::ZERO,
                left: Points::ZERO,
            },
            fractions: Edges {
                top: Percentage(0.0),
                right: Percentage(0.0),
                bottom: Percentage(0.0),
                left: Percentage(0.0),
            },
            radii: Corners {
                top_left: Points::ZERO,
                top_right: Points::ZERO,
                bottom_right: Points::ZERO,
                bottom_left: Points::ZERO,
            },
        }
    }

    /// Moves every edge in by `length`.
    pub fn inset(self, length: impl Into<DefiniteLength>) -> Self {
        let length = length.into();
        self.top(length).right(length).bottom(length).left(length)
    }

    /// Moves the top edge down by `length` (a fraction: of the height).
    pub fn top(mut self, length: impl Into<DefiniteLength>) -> Self {
        (self.offsets.top, self.fractions.top) = edge(length.into());
        self
    }

    /// Moves the right edge left by `length` (a fraction: of the width).
    pub fn right(mut self, length: impl Into<DefiniteLength>) -> Self {
        (self.offsets.right, self.fractions.right) = edge(length.into());
        self
    }

    /// Moves the bottom edge up by `length` (a fraction: of the height).
    pub fn bottom(mut self, length: impl Into<DefiniteLength>) -> Self {
        (self.offsets.bottom, self.fractions.bottom) = edge(length.into());
        self
    }

    /// Moves the left edge right by `length` (a fraction: of the width).
    pub fn left(mut self, length: impl Into<DefiniteLength>) -> Self {
        (self.offsets.left, self.fractions.left) = edge(length.into());
        self
    }

    /// Rounds every corner by `radius`.
    pub fn rounded(mut self, radius: impl Into<Points>) -> Self {
        self.radii = Corners::all(radius.into());
        self
    }

    /// Rounds each corner by its own radius.
    pub fn corner_radii(mut self, radii: Corners<Points>) -> Self {
        self.radii = radii;
        self
    }

    /// The rectangle it clips a box of `size` to, in the box's coordinates,
    /// and its radii fitted to it. As CSS: two opposite edges that would
    /// pass each other are moved in proportion until they meet, and radii
    /// that do not fit are scaled down together.
    pub fn resolve(&self, size: Size<Points>) -> (Bounds<Points>, CornerRadii) {
        let (w, h) = (size.width.0.max(0.0), size.height.0.max(0.0));
        let at = |o: Points, f: Percentage, len: f32| o.0 + f.0 * len;
        let (mut top, mut bottom) = (
            at(self.offsets.top, self.fractions.top, h),
            at(self.offsets.bottom, self.fractions.bottom, h),
        );
        let (mut left, mut right) = (
            at(self.offsets.left, self.fractions.left, w),
            at(self.offsets.right, self.fractions.right, w),
        );
        let meet = |a: &mut f32, b: &mut f32, len: f32| {
            let sum = *a + *b;
            if sum > len && sum > 0.0 {
                let k = len / sum;
                *a *= k;
                *b *= k;
            }
        };
        meet(&mut top, &mut bottom, h);
        meet(&mut left, &mut right, w);
        let rect = Bounds::new(
            point(Points(left), Points(top)),
            size_of((w - left - right).max(0.0), (h - top - bottom).max(0.0)),
        );
        let radii = CornerRadii::circular(self.radii.map(|r| r.max(Points::ZERO))).fit(rect.size);
        (rect, radii)
    }

    /// The outline of the shape in a box of `size`, clockwise on screen
    /// from the top edge, its corners circular arcs. Always the same
    /// segments (a corner of radius 0 is a curve of length 0), so two
    /// outlines interpolate segment by segment, as Core Animation animates
    /// a path.
    pub fn outline(&self, size: Size<Points>, out: &mut impl FnMut(crate::shape::Segment)) {
        use crate::shape::Segment;
        // A quarter circle's control points: `4/3 · (√2 − 1)` of the radius
        // along each tangent.
        const K: f32 = 0.552_284_8;
        let (rect, radii) = self.resolve(size);
        let (x0, y0) = (rect.origin.x.0, rect.origin.y.0);
        let (x1, y1) = (x0 + rect.size.width.0, y0 + rect.size.height.0);
        let (tl, tr, br, bl) = (
            radii.top_left.0,
            radii.top_right.0,
            radii.bottom_right.0,
            radii.bottom_left.0,
        );
        let p = |x: f32, y: f32| point(Points(x), Points(y));
        let c =
            |c1: Point<Points>, c2: Point<Points>, to: Point<Points>| Segment::Cubic([c1, c2, to]);
        out(Segment::Move(p(x0 + tl, y0)));
        out(Segment::Line(p(x1 - tr, y0)));
        out(c(
            p(x1 - tr + K * tr, y0),
            p(x1, y0 + tr - K * tr),
            p(x1, y0 + tr),
        ));
        out(Segment::Line(p(x1, y1 - br)));
        out(c(
            p(x1, y1 - br + K * br),
            p(x1 - br + K * br, y1),
            p(x1 - br, y1),
        ));
        out(Segment::Line(p(x0 + bl, y1)));
        out(c(
            p(x0 + bl - K * bl, y1),
            p(x0, y1 - bl + K * bl),
            p(x0, y1 - bl),
        ));
        out(Segment::Line(p(x0, y0 + tl)));
        out(c(
            p(x0, y0 + tl - K * tl),
            p(x0 + tl - K * tl, y0),
            p(x0 + tl, y0),
        ));
        out(Segment::Close);
    }

    /// Whether `p` (in the coordinates of a box of `size`) is inside it.
    pub fn contains(&self, size: Size<Points>, p: Point<Points>) -> bool {
        let (rect, radii) = self.resolve(size);
        let (x0, y0) = (rect.origin.x.0, rect.origin.y.0);
        let (x1, y1) = (x0 + rect.size.width.0, y0 + rect.size.height.0);
        let (x, y) = (p.x.0, p.y.0);
        if !(x >= x0 && y >= y0 && x < x1 && y < y1) {
            return false;
        }
        // In a corner's square, the point must be within its circle.
        let outside = |r: Points, cx: f32, cy: f32, beyond_x: bool, beyond_y: bool| {
            let r = r.0;
            r > 0.0 && beyond_x && beyond_y && {
                let (dx, dy) = (x - cx, y - cy);
                dx * dx + dy * dy > r * r
            }
        };
        let (tl, tr, br, bl) = (
            radii.top_left,
            radii.top_right,
            radii.bottom_right,
            radii.bottom_left,
        );
        !(outside(tl, x0 + tl.0, y0 + tl.0, x < x0 + tl.0, y < y0 + tl.0)
            || outside(tr, x1 - tr.0, y0 + tr.0, x > x1 - tr.0, y < y0 + tr.0)
            || outside(br, x1 - br.0, y1 - br.0, x > x1 - br.0, y > y1 - br.0)
            || outside(bl, x0 + bl.0, y1 - bl.0, x < x0 + bl.0, y > y1 - bl.0))
    }

    /// The inset `t` of the way from `self` to `to`, edge by edge and
    /// corner by corner (`t` beyond 0..1 overshoots, radii stay at 0 or
    /// more).
    pub fn lerp(&self, to: &Self, t: f32) -> Self {
        let l = |a: f32, b: f32| a + (b - a) * t;
        let lp = |a: Points, b: Points| Points(l(a.0, b.0));
        let lf = |a: Percentage, b: Percentage| Percentage(l(a.0, b.0));
        Self {
            offsets: Edges {
                top: lp(self.offsets.top, to.offsets.top),
                right: lp(self.offsets.right, to.offsets.right),
                bottom: lp(self.offsets.bottom, to.offsets.bottom),
                left: lp(self.offsets.left, to.offsets.left),
            },
            fractions: Edges {
                top: lf(self.fractions.top, to.fractions.top),
                right: lf(self.fractions.right, to.fractions.right),
                bottom: lf(self.fractions.bottom, to.fractions.bottom),
                left: lf(self.fractions.left, to.fractions.left),
            },
            radii: Corners {
                top_left: lp(self.radii.top_left, to.radii.top_left).max(Points::ZERO),
                top_right: lp(self.radii.top_right, to.radii.top_right).max(Points::ZERO),
                bottom_right: lp(self.radii.bottom_right, to.radii.bottom_right).max(Points::ZERO),
                bottom_left: lp(self.radii.bottom_left, to.radii.bottom_left).max(Points::ZERO),
            },
        }
    }
}

/// An edge's length as an offset in points and a fraction.
fn edge(length: DefiniteLength) -> (Points, Percentage) {
    match length {
        DefiniteLength::Absolute(a) => (a.to_points(REM_SIZE), Percentage(0.0)),
        DefiniteLength::Fraction(f) => (Points::ZERO, f),
    }
}

fn size_of(width: f32, height: f32) -> Size<Points> {
    size(Points(width), Points(height))
}

/// One layer of `boxShadow` (CSS `box-shadow`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BoxShadow {
    /// Horizontal offset.
    pub offset_x: Points,
    /// Vertical offset.
    pub offset_y: Points,
    /// Blur radius (CSS: twice the Gaussian's standard deviation).
    pub blur: Points,
    /// How far the shadow's shape grows (negative: shrinks).
    pub spread: Points,
    /// Color.
    pub color: Color,
    /// Drawn inside the box, over the background.
    pub inset: bool,
}

impl BoxShadow {
    /// True if the layer draws anything.
    pub fn is_visible(&self) -> bool {
        !self.color.is_transparent()
    }
}

/// How far a radial gradient reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradientSize {
    /// To the nearest side.
    ClosestSide,
    /// To the nearest corner.
    ClosestCorner,
    /// To the farthest side.
    FarthestSide,
    /// To the farthest corner (CSS default).
    FarthestCorner,
}

/// The geometry of a gradient.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GradientKind {
    /// Along a line at `angle` (CSS: 0 points up, a quarter turn right).
    Linear {
        /// Direction.
        angle: Radians,
    },
    /// Toward a corner (`to top right`): the angle follows the box's
    /// shape (see [`GradientKind::linear_angle`]).
    LinearCorner {
        /// The right corners (else the left ones).
        right: bool,
        /// The bottom corners (else the top ones).
        bottom: bool,
    },
    /// Out from a center.
    Radial {
        /// A circle (else an ellipse matching the box).
        circle: bool,
        /// Ending shape size.
        size: GradientSize,
        /// Center, as a fraction of the width.
        x: Percentage,
        /// Center, as a fraction of the height.
        y: Percentage,
    },
    /// Around a center, starting at `from`.
    Conic {
        /// Start angle (0 is up, clockwise).
        from: Radians,
        /// Center, as a fraction of the width.
        x: Percentage,
        /// Center, as a fraction of the height.
        y: Percentage,
    },
}

impl GradientKind {
    /// The CSS angle of a linear gradient over a box of `size`.
    pub fn linear_angle(&self, size: Size<Points>) -> Option<Radians> {
        match *self {
            GradientKind::Linear { angle } => Some(angle),
            GradientKind::LinearCorner { right, bottom } => {
                // Perpendicular to the diagonal between the other two
                // corners (CSS Images 3).
                let a = (size.height.0.max(f32::EPSILON) / size.width.0.max(f32::EPSILON))
                    .atan()
                    .to_degrees();
                Some(deg(match (right, bottom) {
                    (true, false) => 90.0 - a,
                    (true, true) => 90.0 + a,
                    (false, true) => 270.0 - a,
                    (false, false) => 270.0 + a,
                }))
            }
            _ => None,
        }
    }
}

/// A stop's position as a fraction of a `line` long: a fraction as it
/// is, a length (rems at [`REM_SIZE`]) against the line.
fn stop_fraction(position: DefiniteLength, line: Points) -> f32 {
    match position {
        DefiniteLength::Fraction(f) => f.0,
        DefiniteLength::Absolute(a) => {
            let p = a.to_points(REM_SIZE);
            if line.0 > 0.0 {
                p / line
            } else if p.0 > 0.0 {
                // A line of no length (an empty box) draws nothing:
                // lengths only need to stay in order and finite.
                1.0
            } else {
                0.0
            }
        }
    }
}

/// A color at a point of a gradient.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorStop {
    /// Color.
    pub color: Color,
    /// Position along the gradient line: a fraction of it (`50%`; a
    /// conic gradient's angles as fractions of a turn: `90deg` is 0.25),
    /// or a length from its start (`10px`), resolved against its length
    /// ([`Gradient::line_length`]) where the box is known. `None` is
    /// spread evenly between its neighbors.
    pub position: Option<DefiniteLength>,
}

/// A gradient image (`backgroundImage`, `maskImage`).
#[derive(Debug, Clone, PartialEq)]
pub struct Gradient {
    /// Geometry.
    pub kind: GradientKind,
    /// At least two stops.
    pub stops: Vec<ColorStop>,
    /// Repeats past the last stop.
    pub repeating: bool,
}

/// A stop at no position of its own: spread evenly between its neighbors.
impl From<Hsla> for ColorStop {
    fn from(color: Hsla) -> Self {
        ColorStop {
            color: color.into(),
            position: None,
        }
    }
}

/// A stop at a fraction of the gradient line (`percentage(0.2)`) or a
/// length from its start (`px(12.0)`).
impl<P: Into<DefiniteLength>> From<(Hsla, P)> for ColorStop {
    fn from((color, position): (Hsla, P)) -> Self {
        ColorStop {
            color: color.into(),
            position: Some(position.into()),
        }
    }
}

impl<T: Into<ColorStop>, const N: usize> crate::element::IntoReactive<Vec<ColorStop>> for [T; N] {
    fn into_reactive(self) -> crate::element::Reactive<Vec<ColorStop>> {
        crate::element::Reactive::Static(self.into_iter().map(Into::into).collect())
    }
}

impl<T: Into<ColorStop>> crate::element::IntoReactive<Vec<ColorStop>> for Vec<T> {
    fn into_reactive(self) -> crate::element::Reactive<Vec<ColorStop>> {
        crate::element::Reactive::Static(self.into_iter().map(Into::into).collect())
    }
}

impl Gradient {
    /// The gradient `t` of the way to `to` (`t` beyond 0..1 overshoots):
    /// each stop's color (in premultiplied RGBA, as CSS mixes them) and
    /// position, and the geometry's angle and center. `None` when the two
    /// do not interpolate and `to` applies at once, as CSS's discrete
    /// interpolation does: different kinds, sizes or repeating, a different
    /// number of stops, a linear gradient toward a different corner, or a
    /// stop placed in one and not the other, or as a fraction in one and a
    /// length in the other.
    pub fn lerp(&self, to: &Self, t: f32) -> Option<Self> {
        if self.repeating != to.repeating || self.stops.len() != to.stops.len() {
            return None;
        }
        let l = |a: f32, b: f32| a + (b - a) * t;
        let kind = match (self.kind, to.kind) {
            (GradientKind::Linear { angle: a }, GradientKind::Linear { angle: b }) => {
                GradientKind::Linear {
                    angle: Radians(l(a.0, b.0)),
                }
            }
            (a @ GradientKind::LinearCorner { .. }, b) if a == b => a,
            (
                GradientKind::Radial {
                    circle,
                    size,
                    x: ax,
                    y: ay,
                },
                GradientKind::Radial {
                    circle: bc,
                    size: bs,
                    x: bx,
                    y: by,
                },
            ) if circle == bc && size == bs => GradientKind::Radial {
                circle,
                size,
                x: Percentage(l(ax.0, bx.0)),
                y: Percentage(l(ay.0, by.0)),
            },
            (
                GradientKind::Conic {
                    from: af,
                    x: ax,
                    y: ay,
                },
                GradientKind::Conic {
                    from: bf,
                    x: bx,
                    y: by,
                },
            ) => GradientKind::Conic {
                from: Radians(l(af.0, bf.0)),
                x: Percentage(l(ax.0, bx.0)),
                y: Percentage(l(ay.0, by.0)),
            },
            _ => return None,
        };
        let stops = self
            .stops
            .iter()
            .zip(&to.stops)
            .map(|(a, b)| {
                let position = match (a.position, b.position) {
                    (None, None) => None,
                    (Some(DefiniteLength::Fraction(pa)), Some(DefiniteLength::Fraction(pb))) => {
                        Some(DefiniteLength::Fraction(Percentage(l(pa.0, pb.0))))
                    }
                    (Some(DefiniteLength::Absolute(pa)), Some(DefiniteLength::Absolute(pb))) => {
                        let (pa, pb) = (pa.to_points(REM_SIZE), pb.to_points(REM_SIZE));
                        Some(DefiniteLength::Absolute(AbsoluteLength::Points(Points(l(
                            pa.0, pb.0,
                        )))))
                    }
                    _ => return None,
                };
                Some(ColorStop {
                    color: crate::transition::lerp_color(a.color, b.color, t),
                    position,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Gradient {
            kind,
            stops,
            repeating: self.repeating,
        })
    }

    /// Whether a stop is placed in points, so the stops depend on the
    /// size of the box ([`Gradient::resolved_stops`]).
    pub fn has_lengths(&self) -> bool {
        self.stops
            .iter()
            .any(|s| matches!(s.position, Some(DefiniteLength::Absolute(_))))
    }

    /// The length of the gradient line over a box of `size`, what
    /// lengths of stops are fractions of (CSS Images 3): a linear
    /// gradient's line through the center, long enough that the corners
    /// get the end colors; a radial gradient's ray to the right, from the
    /// center to the ending shape; 0 for a conic gradient, whose stops
    /// are angles.
    pub fn line_length(&self, size: Size<Points>) -> Points {
        let (w, h) = (size.width.0, size.height.0);
        Points(match self.kind {
            GradientKind::Radial {
                circle,
                size: shape,
                x,
                y,
            } => radial_radii(circle, shape, x.0 * w, y.0 * h, w, h).0,
            GradientKind::Conic { .. } => 0.0,
            kind => {
                let angle = kind.linear_angle(size).unwrap_or(deg(180.0));
                let (s, c) = angle.sin_cos();
                (w * s).abs() + (h * c).abs()
            }
        })
    }

    /// Stop positions over a box of `size` as fractions of the gradient
    /// line, resolved as CSS does: lengths against the line's length,
    /// missing ones spread evenly, each at least the one before it.
    pub fn resolved_stops(&self, size: Size<Points>) -> Vec<(Color, Percentage)> {
        let mut out = Vec::with_capacity(self.stops.len());
        self.resolve_stops(size, &mut out);
        out
    }

    /// [`Gradient::resolved_stops`] into a reused buffer.
    pub fn resolve_stops(&self, size: Size<Points>, out: &mut Vec<(Color, Percentage)>) {
        let line = if self.has_lengths() {
            self.line_length(size)
        } else {
            Points::ZERO
        };
        out.clear();
        out.extend(self.stops.iter().map(|s| {
            let at = s.position.map_or(f32::NAN, |p| stop_fraction(p, line));
            (s.color, Percentage(at))
        }));
        let n = out.len();
        if n == 0 {
            return;
        }
        if out[0].1.is_nan() {
            out[0].1 = Percentage(0.0);
        }
        if out[n - 1].1.is_nan() {
            out[n - 1].1 = Percentage(1.0);
        }
        // From 0, not -∞: released apps' negative stops resolve to 0, as
        // they always have (docs/dev/compatibility.md, rule 4).
        let mut max = Percentage(0.0);
        for s in out.iter_mut().filter(|s| !s.1.is_nan()) {
            max = max.max(s.1);
            s.1 = max;
        }
        let mut i = 1;
        while i < n {
            if !out[i].1.is_nan() {
                i += 1;
                continue;
            }
            let start = i - 1;
            let mut end = i;
            while out[end].1.is_nan() {
                end += 1;
            }
            let (a, b) = (out[start].1, out[end].1);
            for (k, s) in out[i..end].iter_mut().enumerate() {
                s.1 = Percentage(a.0 + (b.0 - a.0) * (k + 1) as f32 / (end - start) as f32);
            }
            i = end;
        }
    }

    /// The stops over a box of `size` as a toolkit gradient that repeats
    /// nothing and takes stops within `0..=1` (Core Animation's, Android's
    /// shaders) draws them over `0..reach` of the gradient line (1: the
    /// whole line of a linear or conic gradient; a radial gradient's rings
    /// go on past its ending shape, to the box's farthest corner): the
    /// positions as fractions of `reach`. A repeating gradient's stops are
    /// repeated over all of it, with period last − first, both ways (CSS
    /// Images 3), and cut at both ends with the colors there. A
    /// non-repeating gradient's, or one whose period is too short to
    /// repeat, are [`Gradient::resolved_stops`].
    pub fn unrolled_stops(
        &self,
        size: Size<Points>,
        reach: Percentage,
    ) -> Vec<(Color, Percentage)> {
        let stops = self.resolved_stops(size);
        let reach = reach.0.max(f32::EPSILON);
        let mut out = match self
            .repeating
            .then(|| repeat_stops(&stops, reach))
            .flatten()
        {
            Some(tiled) => cut_stops(&tiled, Percentage(reach)),
            None => stops,
        };
        if reach != 1.0 {
            for s in &mut out {
                s.1 = Percentage(s.1.0 / reach);
            }
        }
        out
    }
}

/// Most stops [`Gradient::unrolled_stops`] repeats a gradient's into: a
/// period of 1pt along a long line fits, a vanishing one is drawn once.
const MAX_UNROLLED_STOPS: usize = 16_384;

/// The copies of `stops` (ascending fractions of the line), one period
/// (last − first) apart, that reach into `0..reach`: from the one ending
/// before it to the one starting after it. `None` for a period too short
/// to repeat, or more copies than [`MAX_UNROLLED_STOPS`] holds.
fn repeat_stops(stops: &[(Color, Percentage)], reach: f32) -> Option<Vec<(Color, Percentage)>> {
    let (first, last) = (stops.first()?.1.0, stops.last()?.1.0);
    let period = last - first;
    if period <= 1e-4 {
        return None;
    }
    let start = ((0.0 - last) / period).floor();
    let end = ((reach - first) / period).ceil();
    let copies = end - start + 1.0;
    if copies * stops.len() as f32 > MAX_UNROLLED_STOPS as f32 {
        return None;
    }
    let mut out: Vec<(Color, Percentage)> = (start as i32..=end as i32)
        .flat_map(|k| {
            let shift = k as f32 * period;
            stops
                .iter()
                .map(move |&(c, p)| (c, Percentage(p.0 + shift)))
        })
        .collect();
    // A copy's first stop may round to a hair before the last one's.
    let mut max = Percentage(f32::NEG_INFINITY);
    for s in &mut out {
        max = max.max(s.1);
        s.1 = max;
    }
    Some(out)
}

/// `stops` (ascending positions) cut to `0..=reach`: those inside as they
/// are, and at each end the color there, between the stops around it (at
/// a hard edge, two stops at one position, the later one's).
pub(crate) fn cut_stops(
    stops: &[(Color, Percentage)],
    reach: Percentage,
) -> Vec<(Color, Percentage)> {
    let color_at = |t: f32| {
        let Some(i) = stops.iter().rposition(|s| s.1.0 <= t) else {
            return stops.first().map_or(Color::TRANSPARENT, |s| s.0);
        };
        match stops.get(i + 1) {
            Some(&(c, p)) if p.0 > stops[i].1.0 => {
                mix(stops[i].0, c, (t - stops[i].1.0) / (p.0 - stops[i].1.0))
            }
            _ => stops[i].0,
        }
    };
    let mut out = Vec::with_capacity(stops.len() + 2);
    out.push((color_at(0.0), Percentage(0.0)));
    out.extend(stops.iter().copied().filter(|s| s.1.0 > 0.0 && s.1 < reach));
    out.push((color_at(reach.0), reach));
    out
}

/// `a` mixed with `b` by `t` (0: `a`) with premultiplied alpha, as CSS
/// interpolates gradients: a fade to transparent keeps its hue.
fn mix(a: Color, b: Color, t: f32) -> Color {
    let channel = |c: Color, shift: u32| ((c.0 >> shift) & 0xff) as f32;
    let (alpha_a, alpha_b) = (channel(a, 0), channel(b, 0));
    let alpha = alpha_a + (alpha_b - alpha_a) * t;
    let color = |shift: u32| {
        if alpha <= 0.0 {
            return 0;
        }
        let (x, y) = (channel(a, shift) * alpha_a, channel(b, shift) * alpha_b);
        ((x + (y - x) * t) / alpha).round().clamp(0.0, 255.0) as u32
    };
    let alpha_byte = alpha.round().clamp(0.0, 255.0) as u32;
    Color((color(24) << 24) | (color(16) << 16) | (color(8) << 8) | alpha_byte)
}

/// The radii of a radial gradient's ending shape centered at `cx`, `cy`
/// in a `w` × `h` box.
fn radial_radii(circle: bool, size: GradientSize, cx: f32, cy: f32, w: f32, h: f32) -> (f32, f32) {
    let near = (cx.min(w - cx).abs(), cy.min(h - cy).abs());
    let far = (cx.max(w - cx).abs(), cy.max(h - cy).abs());
    if circle {
        let r = match size {
            GradientSize::ClosestSide => near.0.min(near.1),
            GradientSize::FarthestSide => far.0.max(far.1),
            GradientSize::ClosestCorner => near.0.hypot(near.1),
            GradientSize::FarthestCorner => far.0.hypot(far.1),
        };
        return (r, r);
    }
    // An ellipse to a corner keeps the side ellipse's aspect ratio.
    let s = std::f32::consts::SQRT_2;
    match size {
        GradientSize::ClosestSide => near,
        GradientSize::FarthestSide => far,
        GradientSize::ClosestCorner => (near.0 * s, near.1 * s),
        GradientSize::FarthestCorner => (far.0 * s, far.1 * s),
    }
}

/// One function of `filter` / `backdropFilter`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Filter {
    /// Gaussian blur radius.
    Blur(Points),
    /// 1 is unchanged.
    Brightness(f32),
    /// 1 is unchanged.
    Contrast(f32),
    /// 0..1.
    Grayscale(f32),
    /// The hue's rotation.
    HueRotate(Radians),
    /// 0..1.
    Invert(f32),
    /// 0..1.
    Opacity(f32),
    /// 1 is unchanged.
    Saturate(f32),
    /// 0..1.
    Sepia(f32),
    /// A shadow of the content's shape.
    DropShadow {
        /// Horizontal offset.
        offset_x: Points,
        /// Vertical offset.
        offset_y: Points,
        /// Blur radius.
        blur: Points,
        /// Color.
        color: Color,
    },
}

impl Filter {
    /// The 4×5 color matrix (row major, sRGB, offsets in 0..1) of a color
    /// filter; `None` for blur and drop shadows.
    pub fn color_matrix(&self) -> Option<[f32; 20]> {
        let id = |r: [f32; 3], g: [f32; 3], b: [f32; 3]| {
            [
                r[0], r[1], r[2], 0.0, 0.0, g[0], g[1], g[2], 0.0, 0.0, b[0], b[1], b[2], 0.0, 0.0,
                0.0, 0.0, 0.0, 1.0, 0.0,
            ]
        };
        Some(match *self {
            Filter::Brightness(v) => id([v, 0.0, 0.0], [0.0, v, 0.0], [0.0, 0.0, v]),
            Filter::Contrast(v) => {
                let t = (1.0 - v) / 2.0;
                [
                    v, 0.0, 0.0, 0.0, t, 0.0, v, 0.0, 0.0, t, 0.0, 0.0, v, 0.0, t, 0.0, 0.0, 0.0,
                    1.0, 0.0,
                ]
            }
            Filter::Grayscale(v) => {
                let a = 1.0 - v;
                id(
                    [
                        0.2126 + 0.7874 * a,
                        0.7152 - 0.7152 * a,
                        0.0722 - 0.0722 * a,
                    ],
                    [
                        0.2126 - 0.2126 * a,
                        0.7152 + 0.2848 * a,
                        0.0722 - 0.0722 * a,
                    ],
                    [
                        0.2126 - 0.2126 * a,
                        0.7152 - 0.7152 * a,
                        0.0722 + 0.9278 * a,
                    ],
                )
            }
            Filter::Sepia(v) => {
                let a = 1.0 - v;
                id(
                    [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a],
                    [0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a],
                    [0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a],
                )
            }
            Filter::Saturate(s) => id(
                [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
                [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
                [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
            ),
            Filter::HueRotate(angle) => {
                let (s, c) = angle.sin_cos();
                id(
                    [
                        0.213 + c * 0.787 - s * 0.213,
                        0.715 - c * 0.715 - s * 0.715,
                        0.072 - c * 0.072 + s * 0.928,
                    ],
                    [
                        0.213 - c * 0.213 + s * 0.143,
                        0.715 + c * 0.285 + s * 0.140,
                        0.072 - c * 0.072 - s * 0.283,
                    ],
                    [
                        0.213 - c * 0.213 - s * 0.787,
                        0.715 - c * 0.715 + s * 0.715,
                        0.072 + c * 0.928 + s * 0.072,
                    ],
                )
            }
            Filter::Invert(v) => {
                let m = 1.0 - 2.0 * v;
                [
                    m, 0.0, 0.0, 0.0, v, 0.0, m, 0.0, 0.0, v, 0.0, 0.0, m, 0.0, v, 0.0, 0.0, 0.0,
                    1.0, 0.0,
                ]
            }
            Filter::Opacity(v) => [
                1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                0.0, 0.0, v, 0.0,
            ],
            Filter::Blur(_) | Filter::DropShadow { .. } => return None,
        })
    }
}

/// The color matrices of `filters` composed in order (the first applies
/// first), or `None` when none changes colors.
pub fn compose_color_matrices(filters: &[Filter]) -> Option<[f32; 20]> {
    let mut out: Option<[f32; 20]> = None;
    for m in filters.iter().filter_map(Filter::color_matrix) {
        out = Some(match out {
            None => m,
            Some(prev) => {
                // `m · prev`, with the offset column treated as a 5th
                // homogeneous coordinate.
                let mut r = [0.0; 20];
                for row in 0..4 {
                    for col in 0..5 {
                        let mut v = if col == 4 { m[row * 5 + 4] } else { 0.0 };
                        for k in 0..4 {
                            v += m[row * 5 + k] * prev[k * 5 + col];
                        }
                        r[row * 5 + col] = v;
                    }
                }
                r
            }
        });
    }
    out
}

/// The total blur radius of `filters`.
pub fn blur_radius(filters: &[Filter]) -> Points {
    filters
        .iter()
        .map(|f| match f {
            Filter::Blur(r) => *r,
            _ => Points::ZERO,
        })
        .sum()
}

/// `ios={{ backdropMaterial }}`: the system material a `backdropFilter` blur draws.
///
/// iOS blurs a backdrop with a material rather than a plain Gaussian blur:
/// each one blurs and tints by a fixed amount, and the thicker it is, the
/// less of what is behind it comes through. A navigation bar over scrolling
/// content usually wants a thicker one than the thinnest, which on its own
/// is too faint to keep its contents legible.
///
/// There is no CSS for this -- `backdrop-filter` only describes filters --
/// so the names follow Apple's `UIBlurEffectStyle.system*Material`.
///
/// Read on iOS, where it picks the material; the blur's radius still sets
/// how strongly it is applied, as an approximation rather than a Gaussian radius.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
pub enum BackdropMaterial {
    /// The thinnest material, the most of what is behind coming through.
    #[default]
    UltraThin,
    /// Thin.
    Thin,
    /// The standard material.
    Regular,
    /// Thick, letting little through.
    Thick,
    /// The material of system chrome, such as a toolbar.
    Chrome,
}

impl BackdropMaterial {
    /// The iOS prop name ([`BackdropMaterial::parse`]'s input).
    pub fn name(self) -> &'static str {
        match self {
            BackdropMaterial::UltraThin => "ultraThin",
            BackdropMaterial::Thin => "thin",
            BackdropMaterial::Regular => "regular",
            BackdropMaterial::Thick => "thick",
            BackdropMaterial::Chrome => "chrome",
        }
    }

    /// Parses a material name.
    pub fn parse(s: &str) -> Option<BackdropMaterial> {
        Some(match s {
            "ultraThin" => BackdropMaterial::UltraThin,
            "thin" => BackdropMaterial::Thin,
            "regular" => BackdropMaterial::Regular,
            "thick" => BackdropMaterial::Thick,
            "chrome" => BackdropMaterial::Chrome,
            _ => return None,
        })
    }
}

/// `macos={{ backdrop }}`: the `NSVisualEffectView` material a view draws with
/// on macOS.
///
/// Unlike iOS's [`BackdropMaterial`], which always blurs a `backdropFilter`,
/// this is a material of its own: an explicit backdrop draws its native
/// view whether or not the style has a blur, and it wins over
/// [`GlassEffect`] and `backdropFilter` on macOS. Its fields default to
/// `popover`, `withinWindow` and `active`, the blur macOS has always drawn.
///
/// There is no CSS for this -- `backdrop-filter` only describes filters --
/// so the names follow AppKit's `NSVisualEffectMaterial`,
/// `NSVisualEffectBlendingMode` and `NSVisualEffectState` in camel case.
///
/// Fields may be added: start with [`Self::default`] and set what it
/// needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct MacOsBackdrop {
    /// The material: what is blurred and how it is tinted.
    pub material: MacOsBackdropMaterial,
    /// What it blurs: the view's window, or what is behind the window.
    pub blending: MacOsBackdropBlending,
    /// Whether it follows the window's active state, or is always active
    /// or inactive.
    pub state: MacOsBackdropState,
}

/// `NSVisualEffectMaterial`: the material of a [`MacOsBackdrop`].
///
/// The roles AppKit still documents: the newer content and under-window
/// roles, and the older named roles apps still use (which AppKit marks
/// deprecated in favor of the newer ones).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
pub enum MacOsBackdropMaterial {
    /// The title bar's material.
    Titlebar,
    /// The selected content's material.
    Selection,
    /// A menu's material.
    Menu,
    /// A popover's material.
    #[default]
    Popover,
    /// A source list's (sidebar's) material.
    Sidebar,
    /// A table header's material.
    HeaderView,
    /// A sheet's material.
    Sheet,
    /// The window's background material.
    WindowBackground,
    /// A heads-up display's material.
    HudWindow,
    /// A full-screen UI's material.
    FullScreenUI,
    /// A tooltip's material.
    ToolTip,
    /// The content's background material.
    ContentBackground,
    /// The material under the window's background.
    UnderWindowBackground,
    /// The material under a page's background.
    UnderPageBackground,
}

/// `NSVisualEffectBlendingMode`: what a [`MacOsBackdrop`] blurs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
pub enum MacOsBackdropBlending {
    /// What is in the view's window behind it.
    #[default]
    WithinWindow,
    /// What is behind the window, so the window must be transparent for
    /// it to show.
    BehindWindow,
}

/// `NSVisualEffectState`: whether a [`MacOsBackdrop`] follows the window's
/// active state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
pub enum MacOsBackdropState {
    /// Active while the window is, inactive otherwise.
    FollowsWindowActiveState,
    /// Always active.
    #[default]
    Active,
    /// Always inactive.
    Inactive,
}

/// `windows={{ backdrop }}`: a system backdrop drawn under the view's box
/// and corners on Windows 11 and later, below everything the window draws;
/// the view's own background draws over it, and tints it when translucent.
/// Nothing elsewhere, nor in a window that is not transparent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct WindowsBackdrop {
    /// The system material to draw behind the view.
    pub material: WindowsBackdropMaterial,
}

/// The material of a [`WindowsBackdrop`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
#[non_exhaustive]
pub enum WindowsBackdropMaterial {
    /// The system's blur of what is behind the window, with no tint of its
    /// own (a host backdrop brush).
    #[default]
    Blur,
}

/// `glassEffect`: a glass material drawn behind the view's content.
///
/// Apple's "Liquid Glass", new in iOS 26. No CSS property describes it --
/// Safari keeps it to the private `-apple-visual-effect`, and the W3C has
/// yet to define backdrop refraction (w3c/svgwg#1142) -- so this follows
/// React Native's `expo-glass-effect` instead.
///
/// Drawn on iOS 26 and later. Earlier iOS, and every other platform, draw
/// the view's `backdropFilter` as before, so give a glass view a blur to
/// fall back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GlassEffect {
    /// No glass: `backdropFilter` alone decides what is drawn behind.
    #[default]
    None,
    /// The standard glass material.
    Regular,
    /// Clearer glass, taking less color from what is behind it.
    Clear,
}

impl GlassEffect {
    /// The style name ([`GlassEffect::parse`]'s input).
    pub fn name(self) -> &'static str {
        match self {
            GlassEffect::None => "none",
            GlassEffect::Regular => "regular",
            GlassEffect::Clear => "clear",
        }
    }

    /// Parses a glass effect name.
    pub fn parse(s: &str) -> Option<GlassEffect> {
        Some(match s {
            "none" => GlassEffect::None,
            "regular" => GlassEffect::Regular,
            "clear" => GlassEffect::Clear,
            _ => return None,
        })
    }
}

/// `mixBlendMode`: how the view composites with what is behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(missing_docs)]
pub enum BlendMode {
    #[default]
    Normal,
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
    PlusDarker,
    PlusLighter,
}

impl BlendMode {
    /// The CSS name ([`BlendMode::parse`]'s input).
    pub fn name(self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::ColorDodge => "color-dodge",
            BlendMode::ColorBurn => "color-burn",
            BlendMode::HardLight => "hard-light",
            BlendMode::SoftLight => "soft-light",
            BlendMode::Difference => "difference",
            BlendMode::Exclusion => "exclusion",
            BlendMode::Hue => "hue",
            BlendMode::Saturation => "saturation",
            BlendMode::Color => "color",
            BlendMode::Luminosity => "luminosity",
            BlendMode::PlusDarker => "plus-darker",
            BlendMode::PlusLighter => "plus-lighter",
        }
    }

    /// Parses a CSS blend mode name.
    pub fn parse(s: &str) -> Option<BlendMode> {
        Some(match s {
            "normal" => BlendMode::Normal,
            "multiply" => BlendMode::Multiply,
            "screen" => BlendMode::Screen,
            "overlay" => BlendMode::Overlay,
            "darken" => BlendMode::Darken,
            "lighten" => BlendMode::Lighten,
            "color-dodge" => BlendMode::ColorDodge,
            "color-burn" => BlendMode::ColorBurn,
            "hard-light" => BlendMode::HardLight,
            "soft-light" => BlendMode::SoftLight,
            "difference" => BlendMode::Difference,
            "exclusion" => BlendMode::Exclusion,
            "hue" => BlendMode::Hue,
            "saturation" => BlendMode::Saturation,
            "color" => BlendMode::Color,
            "luminosity" => BlendMode::Luminosity,
            "plus-darker" => BlendMode::PlusDarker,
            "plus-lighter" => BlendMode::PlusLighter,
            _ => return None,
        })
    }
}

/// `outline*`: a line around the border box, outside the layout.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Outline {
    /// Width (0: none).
    pub width: Points,
    /// Color.
    pub color: Color,
    /// Line style.
    pub style: BorderStyle,
    /// Gap between the border box and the outline (negative: inside).
    pub offset: Points,
}

impl Outline {
    /// No outline.
    pub const NONE: Outline = Outline {
        width: Points::ZERO,
        color: Color::BLACK,
        style: BorderStyle::Solid,
        offset: Points::ZERO,
    };

    /// True if the outline draws anything.
    pub fn is_visible(&self) -> bool {
        self.width > Points::ZERO && !self.color.is_transparent()
    }
}

impl Default for Outline {
    fn default() -> Self {
        Self::NONE
    }
}

/// The pointer's look over a view (`cursor`; iPad, Mac Catalyst and
/// Android with a mouse).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(missing_docs)]
pub enum Cursor {
    #[default]
    Auto,
    Default,
    Pointer,
    Text,
    Wait,
    Progress,
    Help,
    Crosshair,
    Move,
    Grab,
    Grabbing,
    NotAllowed,
    ZoomIn,
    ZoomOut,
    ColResize,
    RowResize,
    None,
    /// Resize along the northwest–southeast diagonal (`nwse-resize`).
    NwseResize,
    /// Resize along the northeast–southwest diagonal (`nesw-resize`).
    NeswResize,
}

impl Cursor {
    /// Its CSS name ([`Cursor::parse`]'s input).
    pub fn name(self) -> &'static str {
        match self {
            Cursor::Auto => "auto",
            Cursor::Default => "default",
            Cursor::Pointer => "pointer",
            Cursor::Text => "text",
            Cursor::Wait => "wait",
            Cursor::Progress => "progress",
            Cursor::Help => "help",
            Cursor::Crosshair => "crosshair",
            Cursor::Move => "move",
            Cursor::Grab => "grab",
            Cursor::Grabbing => "grabbing",
            Cursor::NotAllowed => "not-allowed",
            Cursor::ZoomIn => "zoom-in",
            Cursor::ZoomOut => "zoom-out",
            Cursor::ColResize => "col-resize",
            Cursor::RowResize => "row-resize",
            Cursor::None => "none",
            Cursor::NwseResize => "nwse-resize",
            Cursor::NeswResize => "nesw-resize",
        }
    }

    /// Parses a CSS cursor name (resize directions map to their axis).
    pub fn parse(s: &str) -> Option<Cursor> {
        Some(match s {
            "auto" => Cursor::Auto,
            "default" | "context-menu" | "alias" | "copy" | "cell" => Cursor::Default,
            "pointer" => Cursor::Pointer,
            "text" | "vertical-text" => Cursor::Text,
            "wait" => Cursor::Wait,
            "progress" => Cursor::Progress,
            "help" => Cursor::Help,
            "crosshair" => Cursor::Crosshair,
            "move" | "all-scroll" => Cursor::Move,
            "grab" => Cursor::Grab,
            "grabbing" => Cursor::Grabbing,
            "not-allowed" | "no-drop" => Cursor::NotAllowed,
            "zoom-in" => Cursor::ZoomIn,
            "zoom-out" => Cursor::ZoomOut,
            "col-resize" | "e-resize" | "w-resize" | "ew-resize" => Cursor::ColResize,
            "row-resize" | "n-resize" | "s-resize" | "ns-resize" => Cursor::RowResize,
            "nw-resize" | "se-resize" | "nwse-resize" => Cursor::NwseResize,
            "ne-resize" | "sw-resize" | "nesw-resize" => Cursor::NeswResize,
            "none" => Cursor::None,
            _ => return None,
        })
    }
}

/// Which property groups a [`Transition`] animates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TransitionProps(pub u8);

impl TransitionProps {
    /// Background, border, outline, shadow and text colors.
    pub const COLORS: u8 = 1;
    /// `opacity`.
    pub const OPACITY: u8 = 2;
    /// `transform`.
    pub const TRANSFORM: u8 = 4;
    /// Box shadows.
    pub const SHADOW: u8 = 8;
    /// Corner radii and border widths.
    pub const SHAPE: u8 = 16;
    /// `clipPath` (CSS's `clip-path`).
    pub const CLIP_PATH: u8 = 32;
    /// `maskImage` (CSS's `mask-image`): gradients of the same shape and
    /// stop count, stop by stop.
    pub const MASK: u8 = 64;
    /// A single foreground blur filter, including transitions to/from none.
    pub const FILTER: u8 = 128;
    /// Everything that can transition.
    pub const ALL: u8 = Self::COLORS
        | Self::OPACITY
        | Self::TRANSFORM
        | Self::SHADOW
        | Self::SHAPE
        | Self::CLIP_PATH
        | Self::MASK
        | Self::FILTER;

    /// True if `group` is included.
    #[inline]
    pub fn has(self, group: u8) -> bool {
        self.0 & group != 0
    }
}

/// `transition*`: style changes animate natively instead of jumping.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct Transition {
    /// Properties that animate.
    pub properties: TransitionProps,
    /// Milliseconds.
    pub duration: f32,
    /// Milliseconds before it starts.
    pub delay: f32,
    /// Cubic Bézier `x1, y1, x2, y2` (a `y` outside 0..1 overshoots).
    pub easing: [f32; 4],
    /// A spring's physics it runs on instead of `easing`
    /// (`transitionTimingFunction: "spring(stiffness, damping, mass)"`),
    /// released at rest: it times itself, lasting until it settles
    /// ([`Spring::settle_ms`](crate::element::Spring::settle_ms)), so
    /// `duration` is not used, nor the spring's `velocity` and
    /// `frame_rate`. A change that arrives mid-way starts again from what
    /// is on screen, at rest.
    pub spring: Option<crate::element::Spring>,
}

impl Default for Transition {
    /// CSS's initial values: every property, no time, `ease`.
    fn default() -> Self {
        Self {
            properties: TransitionProps(TransitionProps::ALL),
            duration: 0.0,
            delay: 0.0,
            easing: Self::EASE,
            spring: None,
        }
    }
}

impl Transition {
    /// CSS's default curve (`ease`).
    pub const EASE: [f32; 4] = [0.25, 0.1, 0.25, 1.0];

    /// How long it runs once started, in milliseconds: the duration, or
    /// the time its spring takes to settle (its delay not included).
    pub fn run_ms(&self) -> f32 {
        match self.spring {
            Some(spring) => spring.settle_ms(),
            None => self.duration.max(0.0),
        }
    }
}

/// A built-in keyframe animation (Tailwind's `animate-*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keyframes {
    /// One turn clockwise.
    Spin,
    /// Scales up to 2× and fades out.
    Ping,
    /// Fades to half opacity and back.
    Pulse,
    /// Jumps up by a quarter of its height and lands.
    Bounce,
}

/// `animation*`: a keyframe animation running natively, forever by default.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeyframeAnimation {
    /// What runs.
    pub keyframes: Keyframes,
    /// Milliseconds per iteration.
    pub duration: f32,
    /// Milliseconds before it starts.
    pub delay: f32,
    /// Cubic Bézier `x1, y1, x2, y2` (Bounce uses its own per half).
    pub easing: [f32; 4],
    /// `None` repeats forever.
    pub iterations: Option<u32>,
    /// The highest frame rate it needs, in Hz (`animationFrameRate`);
    /// `None`: the screen's highest. Platforms that can lower their frame
    /// rate honor it.
    pub frame_rate: Option<f32>,
}

impl KeyframeAnimation {
    /// `keyframes` as TS's `animationName` alone runs them: a second per
    /// iteration at a constant pace, forever.
    pub const fn new(keyframes: Keyframes) -> Self {
        Self {
            keyframes,
            duration: 1000.0,
            delay: 0.0,
            easing: [0.0, 0.0, 1.0, 1.0],
            iterations: None,
            frame_rate: None,
        }
    }

    /// `ms` milliseconds per iteration.
    pub const fn duration(mut self, ms: f32) -> Self {
        self.duration = ms;
        self
    }

    /// Starts after `ms` milliseconds.
    pub const fn delay(mut self, ms: f32) -> Self {
        self.delay = ms;
        self
    }

    /// Along the cubic Bézier curve `x1, y1, x2, y2`.
    pub const fn easing(mut self, curve: [f32; 4]) -> Self {
        self.easing = curve;
        self
    }

    /// `count` iterations, then it stops.
    pub const fn iterations(mut self, count: u32) -> Self {
        self.iterations = Some(count);
        self
    }

    /// Needs at most `hz` frames per second (a slow spinner: 30), so the
    /// screen may refresh less often while it is all that moves.
    pub const fn frame_rate(mut self, hz: f32) -> Self {
        self.frame_rate = Some(hz);
        self
    }
}

/// The list-valued effects of a view, shared between equal styles.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Effects {
    /// Box shadows, top layer first (CSS order).
    pub box_shadows: Vec<BoxShadow>,
    /// Gradient backgrounds, top layer first, over `backgroundColor`.
    pub background_images: Vec<Gradient>,
    /// Filters applied to the view and its content, in order.
    pub filters: Vec<Filter>,
    /// Filters applied to what is behind the view (blur only on iOS).
    pub backdrop_filters: Vec<Filter>,
    /// `maskImage`: gradients whose alpha decides how much of the view is
    /// drawn, top layer first (CSS order). Only gradients: CSS also takes
    /// images and shapes here, which no platform of NSH draws yet.
    pub mask_images: Vec<Gradient>,
    /// `clipPath`: the inset rounded rectangle everything the view draws is
    /// clipped to, and outside which nothing of it is hit.
    pub clip_path: Option<ClipInset>,
}

impl Effects {
    /// True if nothing is set.
    pub fn is_empty(&self) -> bool {
        self.box_shadows.is_empty()
            && self.background_images.is_empty()
            && self.filters.is_empty()
            && self.backdrop_filters.is_empty()
            && self.mask_images.is_empty()
            && self.clip_path.is_none()
    }
}

/// [`Effects`] behind a cheap shared pointer (`None` when empty).
pub(crate) fn shared(effects: Effects) -> Option<Arc<Effects>> {
    (!effects.is_empty()).then(|| Arc::new(effects))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{percentage, px, size};

    #[test]
    fn a_clip_inset_resolves_as_css_does() {
        let at =
            |x: f32, y: f32, w: f32, h: f32| Bounds::new(point(px(x), px(y)), size(px(w), px(h)));
        let box_ = size(px(200.0), px(100.0));
        // Percentages of the width (left, right) and the height (top, bottom).
        let clip = ClipInset::new()
            .top(percentage(0.1))
            .right(px(20.0))
            .bottom(px(30.0))
            .left(percentage(0.25));
        assert_eq!(clip.resolve(box_).0, at(50.0, 10.0, 130.0, 60.0));
        // Opposite edges that would pass each other meet, in proportion.
        let past = ClipInset::new()
            .left(percentage(0.75))
            .right(percentage(0.75));
        assert_eq!(past.resolve(box_).0, at(100.0, 0.0, 0.0, 100.0));
        // Negative edges reach out of the box.
        assert_eq!(
            ClipInset::new().inset(px(-8.0)).resolve(box_).0,
            at(-8.0, -8.0, 216.0, 116.0)
        );
        // Radii that do not fit are scaled down together, as a border's.
        let pill = ClipInset::new().top(px(40.0)).rounded(px(100.0));
        let (rect, radii) = pill.resolve(box_);
        assert_eq!(rect, at(0.0, 40.0, 200.0, 60.0));
        assert!(
            radii.to_array().iter().all(|r| (r.0 - 30.0).abs() < 1e-4),
            "{radii:?}"
        );
    }

    #[test]
    fn a_clip_inset_contains_what_its_rounded_corners_leave() {
        let box_ = size(px(100.0), px(100.0));
        let clip = ClipInset::new().inset(px(10.0)).rounded(px(20.0));
        assert!(clip.contains(box_, point(px(50.0), px(50.0))));
        // The inset edges.
        assert!(!clip.contains(box_, point(px(5.0), px(50.0))));
        assert!(!clip.contains(box_, point(px(50.0), px(95.0))));
        // Each corner's square, outside its circle and inside it.
        for (out, inside) in [
            ((12.0, 12.0), (18.0, 18.0)),
            ((88.0, 12.0), (82.0, 18.0)),
            ((88.0, 88.0), (82.0, 82.0)),
            ((12.0, 88.0), (18.0, 82.0)),
        ] {
            assert!(!clip.contains(box_, point(px(out.0), px(out.1))), "{out:?}");
            assert!(
                clip.contains(box_, point(px(inside.0), px(inside.1))),
                "{inside:?}"
            );
        }
        // Shut to nothing, nothing is inside.
        let shut = ClipInset::new()
            .bottom(percentage(1.0))
            .left(percentage(1.0));
        assert!(!shut.contains(box_, point(px(99.0), px(0.0))));
    }

    #[test]
    fn a_clip_inset_outline_keeps_its_segments() {
        use crate::shape::Segment;
        let kinds = |clip: ClipInset| {
            let mut out = Vec::new();
            clip.outline(size(px(100.0), px(50.0)), &mut |s| {
                out.push(std::mem::discriminant(&s));
            });
            out
        };
        // Shut to nothing with square corners, or open and rounded: the
        // same segments, so a path animates from one to the other.
        let shut = ClipInset::new()
            .bottom(percentage(1.0))
            .left(percentage(1.0));
        let open = ClipInset::new().rounded(px(12.0));
        assert_eq!(kinds(shut), kinds(open));
        assert_eq!(kinds(open).len(), 10);
        let mut last = None;
        open.outline(size(px(100.0), px(50.0)), &mut |s| {
            if let Segment::Cubic([_, _, to]) = s {
                last = Some(to);
            }
        });
        // It ends where it started, past the top left corner's arc.
        assert_eq!(last, Some(point(px(12.0), px(0.0))));
    }

    #[test]
    fn a_clip_inset_interpolates_lengths_and_percentages_together() {
        let from = ClipInset::new()
            .bottom(percentage(1.0))
            .left(px(40.0))
            .rounded(px(0.0));
        let to = ClipInset::new().bottom(px(10.0)).rounded(px(16.0));
        let half = from.lerp(&to, 0.5);
        // CSS's calc(): half of each, the length and the percentage apart.
        assert_eq!(
            (half.offsets.bottom, half.fractions.bottom),
            (px(5.0), percentage(0.5))
        );
        assert_eq!(
            (half.offsets.left, half.fractions.left),
            (px(20.0), percentage(0.0))
        );
        assert_eq!(half.radii, Corners::all(px(8.0)));
        assert_eq!(
            half.resolve(size(px(100.0), px(100.0))).0.size.height,
            px(45.0)
        );
        // An overshooting curve never makes a radius negative.
        assert_eq!(from.lerp(&to, -0.5).radii, Corners::all(px(0.0)));
        assert_eq!(from.lerp(&to, 1.0), to);
    }

    #[test]
    fn stops_spread_evenly() {
        let c = Color::BLACK;
        let g = Gradient {
            kind: GradientKind::Linear { angle: deg(90.0) },
            stops: vec![
                ColorStop {
                    color: c,
                    position: None,
                },
                ColorStop {
                    color: c,
                    position: None,
                },
                ColorStop {
                    color: c,
                    position: Some(DefiniteLength::from(percentage(0.8))),
                },
                ColorStop {
                    color: c,
                    position: Some(DefiniteLength::from(percentage(0.5))),
                },
            ],
            repeating: false,
        };
        let p: Vec<f32> = g
            .resolved_stops(size(px(100.0), px(100.0)))
            .into_iter()
            .map(|(_, p)| p.0)
            .collect();
        assert_eq!(p, [0.0, 0.4, 0.8, 0.8]);
    }

    #[test]
    fn negative_stops_resolve_to_zero() {
        let stop = |p: f32| ColorStop {
            color: Color::BLACK,
            position: Some(DefiniteLength::from(percentage(p))),
        };
        let mut g = Gradient {
            kind: GradientKind::Linear { angle: deg(180.0) },
            stops: vec![stop(-0.5), stop(1.0)],
            repeating: false,
        };
        let positions = |g: &Gradient| -> Vec<f32> {
            g.resolved_stops(size(px(100.0), px(40.0)))
                .into_iter()
                .map(|(_, p)| p.0)
                .collect()
        };
        assert_eq!(positions(&g), [0.0, 1.0]);
        g.stops = vec![
            stop(-0.5),
            ColorStop {
                color: Color::BLACK,
                position: Some(DefiniteLength::from(px(-20.0))),
            },
            stop(1.0),
        ];
        assert_eq!(positions(&g), [0.0, 0.0, 1.0]);
    }

    #[test]
    fn lengths_resolve_against_the_line() {
        let c = Color::BLACK;
        let stop = |p: Option<DefiniteLength>| ColorStop {
            color: c,
            position: p,
        };
        let mut g = Gradient {
            kind: GradientKind::Linear { angle: deg(90.0) },
            stops: vec![
                stop(Some(DefiniteLength::from(px(0.0)))),
                stop(Some(DefiniteLength::from(px(10.0)))),
                stop(None),
                stop(Some(DefiniteLength::from(percentage(0.5)))),
            ],
            repeating: true,
        };
        assert!(g.has_lengths());
        // Across a 200 × 50 box: the line is the width.
        let p: Vec<f32> = g
            .resolved_stops(size(px(200.0), px(50.0)))
            .into_iter()
            .map(|(_, p)| p.0)
            .collect();
        assert_eq!(p, [0.0, 0.05, 0.275, 0.5]);
        // Down: the height.
        g.kind = GradientKind::Linear { angle: deg(180.0) };
        assert!((g.resolved_stops(size(px(200.0), px(50.0)))[1].1.0 - 0.2).abs() < 1e-6);
        // Diagonal over a square: the diagonal.
        g.kind = GradientKind::Linear { angle: deg(45.0) };
        let line = g.line_length(size(px(100.0), px(100.0)));
        assert!((line.0 - 100.0 * std::f32::consts::SQRT_2).abs() < 1e-3);
        // Radial: the ray to the ending shape (a circle to the farthest
        // side of a 200 × 100 box from its center is 100 points).
        g.kind = GradientKind::Radial {
            circle: true,
            size: GradientSize::FarthestSide,
            x: percentage(0.5),
            y: percentage(0.5),
        };
        assert!((g.line_length(size(px(200.0), px(100.0))).0 - 100.0).abs() < 1e-4);
        assert!((g.resolved_stops(size(px(200.0), px(100.0)))[1].1.0 - 0.1).abs() < 1e-6);
        // An empty box puts lengths at the start or past the end, still
        // in order.
        g.kind = GradientKind::Linear { angle: deg(90.0) };
        let p: Vec<f32> = g
            .resolved_stops(size(px(0.0), px(0.0)))
            .into_iter()
            .map(|(_, p)| p.0)
            .collect();
        assert_eq!(p[0], 0.0);
        assert!(p.windows(2).all(|w| w[0] <= w[1]));
    }

    /// A linear gradient of the stops `stops` (colors at fractions of the
    /// line).
    fn bands(stops: &[(Color, f32)], repeating: bool) -> Gradient {
        Gradient {
            kind: GradientKind::Linear { angle: deg(90.0) },
            stops: stops
                .iter()
                .map(|&(color, p)| ColorStop {
                    color,
                    position: Some(DefiniteLength::from(percentage(p))),
                })
                .collect(),
            repeating,
        }
    }

    /// A repeating gradient's stops over the whole line, within `0..=1`:
    /// a band of 0..0.1 again every tenth, the ends cut at the colors
    /// there; over more than the line (a radial gradient's rings past its
    /// ending shape) as fractions of that.
    #[test]
    fn repeating_stops_unroll_over_the_line() {
        let (red, blue) = (Color(0xff00_00ff), Color(0x0000_ffff));
        let box_size = size(px(100.0), px(100.0));
        let g = bands(&[(red, 0.0), (blue, 0.1)], true);
        let stops = g.unrolled_stops(box_size, percentage(1.0));
        assert!(stops.iter().all(|s| (0.0..=1.0).contains(&s.1.0)));
        assert!(stops.windows(2).all(|w| w[0].1 <= w[1].1));
        assert_eq!(stops[0], (red, percentage(0.0)));
        assert_eq!(stops[stops.len() - 1].1, percentage(1.0));
        for k in 1..10 {
            let at = |c: Color| {
                stops
                    .iter()
                    .any(|s| s.0 == c && (s.1.0 - k as f32 * 0.1).abs() < 1e-4)
            };
            assert!(at(red) && at(blue), "{k}: {stops:?}");
        }
        // Half a band later, both ways: the ends cut halfway through a
        // band, at the color between.
        let g = bands(&[(red, 0.125), (blue, 0.375)], true);
        let stops = g.unrolled_stops(box_size, percentage(1.0));
        let purple = Color(0x8000_80ff);
        assert_eq!(stops[0], (purple, percentage(0.0)));
        assert_eq!(stops[stops.len() - 1], (purple, percentage(1.0)));
        assert!(stops.windows(2).all(|w| w[0].1 <= w[1].1));
        // A fade to transparent keeps its hue where it is cut.
        let g = bands(&[(red, 0.0), (Color::TRANSPARENT, 0.3)], true);
        let stops = g.unrolled_stops(box_size, percentage(1.0));
        assert_eq!(stops[stops.len() - 1].0.0 & 0xffff_ff00, 0xff00_0000);
        // Over twice the line.
        let g = bands(&[(red, 0.0), (blue, 0.1)], true);
        let stops = g.unrolled_stops(box_size, percentage(2.0));
        assert_eq!(stops[stops.len() - 1].1, percentage(1.0));
        let blue_at = |p: f32| {
            stops
                .iter()
                .any(|s| s.0 == blue && (s.1.0 - p).abs() < 1e-4)
        };
        assert!(blue_at(0.05) && blue_at(0.95), "{stops:?}");
    }

    /// A hatch's copies stay in order over any box: a copy's first stop,
    /// shifted by whole periods, rounds a hair before the one ending the
    /// copy before it on most line lengths, and CoreGraphics draws stops
    /// out of order as a smeared band.
    #[test]
    fn repeating_stops_stay_in_order() {
        let (red, clear) = (Color(0xff00_004d), Color::TRANSPARENT);
        let stop = |color, at: f32| ColorStop {
            color,
            position: Some(DefiniteLength::from(px(at))),
        };
        let hatch = Gradient {
            kind: GradientKind::Linear { angle: deg(-45.0) },
            stops: vec![
                stop(red, 0.0),
                stop(red, 1.0),
                stop(clear, 1.0),
                stop(clear, 6.0),
            ],
            repeating: true,
        };
        for width in 100..400 {
            let box_size = size(px(width as f32 * 0.75), px(140.0));
            let stops = hatch.unrolled_stops(box_size, percentage(1.0));
            assert!(
                stops.windows(2).all(|w| w[0].1 <= w[1].1),
                "{width}: {stops:?}"
            );
        }
    }

    /// Stops that do not repeat come out as resolved: a gradient that is
    /// not repeating (stops past the end too), and one whose period
    /// vanishes; a period of 1pt along a long line still repeats.
    #[test]
    fn other_stops_unroll_as_resolved() {
        let (red, blue) = (Color(0xff00_00ff), Color(0x0000_ffff));
        let box_size = size(px(100.0), px(100.0));
        for g in [
            bands(&[(red, 0.0), (blue, 0.1)], false),
            bands(&[(red, 0.0), (blue, 1.5)], false),
            bands(&[(red, 0.5), (blue, 0.5)], true),
        ] {
            assert_eq!(
                g.unrolled_stops(box_size, percentage(1.0)),
                g.resolved_stops(box_size)
            );
        }
        let hatch = Gradient {
            stops: vec![
                ColorStop {
                    color: red,
                    position: Some(DefiniteLength::from(px(0.0))),
                },
                ColorStop {
                    color: blue,
                    position: Some(DefiniteLength::from(px(1.0))),
                },
            ],
            ..bands(&[], true)
        };
        let stops = hatch.unrolled_stops(size(px(4000.0), px(10.0)), percentage(1.0));
        assert!(stops.len() > 4000, "{}", stops.len());
    }

    #[test]
    fn matrices_compose_in_order() {
        let m = compose_color_matrices(&[Filter::Invert(1.0), Filter::Brightness(0.5)]).unwrap();
        // White inverted is black; halved stays black. Black: 1 * 0.5.
        let apply = |c: f32| m[0] * c + m[4];
        assert!((apply(1.0) - 0.0).abs() < 1e-6);
        assert!((apply(0.0) - 0.5).abs() < 1e-6);
        assert!(compose_color_matrices(&[Filter::Blur(px(2.0))]).is_none());
    }

    #[test]
    fn corner_angles() {
        let k = GradientKind::LinearCorner {
            right: true,
            bottom: false,
        };
        assert!(
            (k.linear_angle(size(px(100.0), px(100.0)))
                .unwrap()
                .to_degrees()
                - 45.0)
                .abs()
                < 1e-4
        );
        let k = GradientKind::LinearCorner {
            right: true,
            bottom: true,
        };
        assert!(
            (k.linear_angle(size(px(100.0), px(100.0)))
                .unwrap()
                .to_degrees()
                - 135.0)
                .abs()
                < 1e-4
        );
    }
}
