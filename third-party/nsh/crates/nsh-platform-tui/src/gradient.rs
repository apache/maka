//! Gradient backgrounds in Cells: each Cell takes the color the gradient
//! has at its center, as CSS would draw it there (linear, radial and conic,
//! repeating or not, layered over the view's fill). A terminal draws one
//! color per Cell, so a gradient is a picture of its colors at the
//! terminal's depth (`palette::convert`), not a step of the surfaces ramp.

use nsh_core::{
    Color, Gradient, GradientKind, GradientSize,
    geometry::{Points, Size, deg},
};

use crate::palette::Rgb;

/// The geometry of one gradient over a box: where along its stops a point
/// of the box falls.
enum Geometry {
    /// Along the line from `a` to `b` (`t` 0 at `a`, 1 at `b`).
    Linear { a: (f32, f32), b: (f32, f32) },
    /// Out from `c` to an ending shape of radii `r` (`t` 1 on it).
    Radial { c: (f32, f32), r: (f32, f32) },
    /// Clockwise around `c` from `from` degrees, 0 pointing up.
    Conic { c: (f32, f32), from: f32 },
}

impl Geometry {
    fn t(&self, (x, y): (f32, f32)) -> f32 {
        match *self {
            Geometry::Linear { a, b } => {
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let len = (dx * dx + dy * dy).max(f32::EPSILON);
                ((x - a.0) * dx + (y - a.1) * dy) / len
            }
            Geometry::Radial { c, r } => {
                ((x - c.0) / r.0.max(f32::EPSILON)).hypot((y - c.1) / r.1.max(f32::EPSILON))
            }
            Geometry::Conic { c, from } => {
                let degrees = (x - c.0).atan2(-(y - c.1)).to_degrees();
                ((degrees - from) / 360.0).rem_euclid(1.0)
            }
        }
    }
}

/// Whether `gradient` is a picture of colors a terminal shows: its stops
/// differ by more than a sheen. A finish (one color, or a few steps of
/// lightness over a fill, as the gallery's cards and buttons have) is a
/// surface, drawn as a step of the ramp like any fill.
pub(crate) fn shows(gradient: &Gradient) -> bool {
    /// The largest channel difference a sheen has (of 255, alpha
    /// included).
    const SHEEN: u8 = 32;
    let Some(first) = gradient.stops.first() else {
        return false;
    };
    let first = first.color.0.to_be_bytes();
    gradient.stops.iter().any(|stop| {
        let c = stop.color.0.to_be_bytes();
        (0..4).any(|i| first[i].abs_diff(c[i]) > SHEEN)
    })
}

/// A gradient resolved over a box, ready to be sampled at its points.
pub(crate) struct Sampler {
    geometry: Geometry,
    /// Premultiplied `0..1` channels and positions, ascending.
    stops: Vec<([f32; 4], f32)>,
    /// The period the stops repeat with (last − first), if they repeat.
    period: Option<f32>,
}

impl Sampler {
    /// `gradient` over a box of `size`, `None` when it draws nothing (no
    /// two stops, an empty box).
    pub(crate) fn new(gradient: &Gradient, size: Size<Points>) -> Option<Self> {
        let (w, h) = (size.width.0, size.height.0);
        if gradient.stops.len() < 2 || w <= 0.0 || h <= 0.0 {
            return None;
        }
        let stops: Vec<([f32; 4], f32)> = gradient
            .resolved_stops(size)
            .into_iter()
            .map(|(color, at)| (premultiplied(color), at.0))
            .collect();
        let (first, last) = (stops[0].1, stops[stops.len() - 1].1);
        let period = (gradient.repeating && last - first > 1e-4).then_some(last - first);
        let geometry = match gradient.kind {
            GradientKind::Radial {
                circle,
                size: shape,
                x,
                y,
            } => {
                let c = (x.0 * w, y.0 * h);
                Geometry::Radial {
                    c,
                    r: radial_radii(circle, shape, c.0, c.1, w, h),
                }
            }
            GradientKind::Conic { from, x, y } => Geometry::Conic {
                c: (x.0 * w, y.0 * h),
                from: from.0.to_degrees(),
            },
            kind => {
                let angle = kind.linear_angle(size).unwrap_or(deg(180.0));
                let (s, c) = angle.0.sin_cos();
                let len = (w * s).abs() + (h * c).abs();
                let (dx, dy) = (s * len / 2.0, -c * len / 2.0);
                let (cx, cy) = (w / 2.0, h / 2.0);
                Geometry::Linear {
                    a: (cx - dx, cy - dy),
                    b: (cx + dx, cy + dy),
                }
            }
        };
        Some(Self {
            geometry,
            stops,
            period,
        })
    }

    /// The premultiplied color at `point` (points from the box's top left).
    pub(crate) fn at(&self, point: (f32, f32)) -> [f32; 4] {
        let mut t = self.geometry.t(point);
        if let Some(period) = self.period {
            let first = self.stops[0].1;
            t = first + (t - first).rem_euclid(period);
        }
        sample(&self.stops, t)
    }
}

/// `layers` (premultiplied, the top one last) over the opaque `under`.
pub(crate) fn over(under: Rgb, layers: impl Iterator<Item = [f32; 4]>) -> Rgb {
    let mut rgb = under.map(|c| f32::from(c) / 255.0);
    for [r, g, b, a] in layers {
        rgb = [
            r + rgb[0] * (1.0 - a),
            g + rgb[1] * (1.0 - a),
            b + rgb[2] * (1.0 - a),
        ];
    }
    rgb.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// `c` as premultiplied `0..1` channels (r, g, b, a).
fn premultiplied(c: Color) -> [f32; 4] {
    let [r, g, b, a] = c.0.to_be_bytes().map(|v| f32::from(v) / 255.0);
    [r * a, g * a, b * a, a]
}

/// The color of sorted premultiplied stops at `t`: the end colors past
/// either end.
fn sample(stops: &[([f32; 4], f32)], t: f32) -> [f32; 4] {
    let Some(&(first, p0)) = stops.first() else {
        return [0.0; 4];
    };
    if t <= p0 {
        return first;
    }
    for pair in stops.windows(2) {
        let ((a, pa), (b, pb)) = (pair[0], pair[1]);
        if t <= pb {
            let k = if pb - pa > 1e-6 {
                (t - pa) / (pb - pa)
            } else {
                1.0
            };
            return std::array::from_fn(|i| a[i] + (b[i] - a[i]) * k);
        }
    }
    stops[stops.len() - 1].0
}

/// The radii of a radial gradient's ending shape centered at `(cx, cy)` in
/// a `w` × `h` box (CSS Images 3, as the core's `line_length` takes them).
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

#[cfg(test)]
mod tests {
    use nsh_core::{
        ColorStop,
        geometry::{Percentage, Radians},
    };

    use super::*;

    fn gradient(kind: GradientKind, colors: &[u32]) -> Gradient {
        Gradient {
            kind,
            stops: colors
                .iter()
                .map(|&c| ColorStop {
                    color: Color(c),
                    position: None,
                })
                .collect(),
            repeating: false,
        }
    }

    #[test]
    fn a_linear_gradient_runs_from_its_first_stop_to_its_last() {
        let g = gradient(
            GradientKind::Linear { angle: deg(90.0) },
            &[0x0000_00ff, 0xffff_ffff],
        );
        let s = Sampler::new(&g, Size::new(Points(100.0), Points(10.0))).unwrap();
        let rgb = |x: f32| over([0; 3], std::iter::once(s.at((x, 5.0))));
        assert_eq!(rgb(0.0), [0; 3]);
        assert_eq!(rgb(100.0), [255; 3]);
        assert!((i32::from(rgb(50.0)[0]) - 128).abs() <= 1);
    }

    #[test]
    fn a_conic_gradient_turns_clockwise_from_the_top() {
        let g = gradient(
            GradientKind::Conic {
                from: Radians(0.0),
                x: Percentage(0.5),
                y: Percentage(0.5),
            },
            &[0x0000_00ff, 0xffff_ffff],
        );
        let s = Sampler::new(&g, Size::new(Points(10.0), Points(10.0))).unwrap();
        // A quarter turn: to the right of the center.
        let right = over([0; 3], std::iter::once(s.at((10.0, 5.0))));
        assert!((i32::from(right[0]) - 64).abs() <= 1);
    }

    #[test]
    fn a_sheen_is_a_surface_and_a_ramp_a_picture() {
        let kind = GradientKind::Linear { angle: deg(180.0) };
        assert!(!shows(&gradient(kind, &[0x9a9d_a3ff, 0x8386_8cff])));
        assert!(!shows(&gradient(kind, &[0x2526_2aff, 0x2526_2aff])));
        assert!(shows(&gradient(kind, &[0x38bd_f8ff, 0x2563_ebff])));
    }

    #[test]
    fn a_transparent_stop_shows_the_fill_under_it() {
        let g = gradient(
            GradientKind::Linear { angle: deg(90.0) },
            &[0xffff_ff00, 0xffff_ff00],
        );
        let s = Sampler::new(&g, Size::new(Points(10.0), Points(10.0))).unwrap();
        assert_eq!(
            over([10, 20, 30], std::iter::once(s.at((5.0, 5.0)))),
            [10, 20, 30]
        );
    }
}
