//! Outlines of rounded rectangles, shared by the platforms so both draw the
//! same corners (Android's `Decor.java` ports [`rounded_rect`]).
//!
//! Circular corners are quarter circles (ellipses). Continuous corners
//! (`borderCurve: "continuous"`) ease into the edges: each one is a circular
//! arc between two cubic transitions that spread the curvature over
//! `(1 + SMOOTHING) * r` of each edge (Figma's corner smoothing; 0.6 matches
//! iOS). Where the box is too small for the transitions they shrink, down to
//! a circular corner, so `rounded-full` stays a pill.

use crate::geometry::{Bounds, Corners, Point, Points, Size};

/// Corner smoothing of continuous corners (0: circular, 1: maximal).
pub const SMOOTHING: f64 = 0.6;

/// One segment of an outline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Segment {
    /// Starts the outline at a point.
    Move(Point<Points>),
    /// A straight line to a point.
    Line(Point<Points>),
    /// A cubic Bézier curve: two control points, then the end point.
    Cubic([Point<Points>; 3]),
    /// Closes the outline.
    Close,
}

/// A corner's radii: along the horizontal edge (`width`) and the vertical
/// one (`height`).
pub type Corner = Size<Points>;

/// The outline of `rect` with `corners` (already fitted so adjacent radii
/// do not overlap), clockwise on screen (y down) or, with `reverse`,
/// counterclockwise (a hole under the non-zero rule). Starts on the top
/// edge.
pub fn rounded_rect(
    rect: Bounds<Points>,
    corners: Corners<Corner>,
    continuous: bool,
    reverse: bool,
    out: &mut impl FnMut(Segment),
) {
    // Computed in `f64`, as the platforms' path APIs take it.
    let (x0, y0) = (f64::from(rect.origin.x.0), f64::from(rect.origin.y.0));
    let (w, h) = (f64::from(rect.size.width.0), f64::from(rect.size.height.0));
    let (x1, y1) = (x0 + w, y0 + h);
    let radii = |c: Corner| (f64::from(c.width.0), f64::from(c.height.0));
    let (tl, tr, br, bl) = (
        radii(corners.top_left),
        radii(corners.top_right),
        radii(corners.bottom_right),
        radii(corners.bottom_left),
    );
    let at = |(x, y): (f64, f64)| Point::new(Points(x as f32), Points(y as f32));
    // Each corner as (its point, the unit direction it is entered along,
    // the one it leaves along, its radius along each, the edge lengths
    // and the radii of the neighbors sharing those edges).
    struct Spec {
        at: (f64, f64),
        u: (f64, f64),
        v: (f64, f64),
        ru: f64,
        rv: f64,
        limit_u: f64,
        limit_v: f64,
    }
    // How far a corner may reach along an edge of `len` shared with a
    // neighbor of radius `other`: its share of the edge.
    let limit = |len: f64, r: f64, other: f64| {
        if r + other > 0.0 {
            len * r / (r + other)
        } else {
            0.0
        }
    };
    let specs: [Spec; 4] = if reverse {
        [
            Spec {
                at: (x0, y0),
                u: (-1.0, 0.0),
                v: (0.0, 1.0),
                ru: tl.0,
                rv: tl.1,
                limit_u: limit(w, tl.0, tr.0),
                limit_v: limit(h, tl.1, bl.1),
            },
            Spec {
                at: (x0, y1),
                u: (0.0, 1.0),
                v: (1.0, 0.0),
                ru: bl.1,
                rv: bl.0,
                limit_u: limit(h, bl.1, tl.1),
                limit_v: limit(w, bl.0, br.0),
            },
            Spec {
                at: (x1, y1),
                u: (1.0, 0.0),
                v: (0.0, -1.0),
                ru: br.0,
                rv: br.1,
                limit_u: limit(w, br.0, bl.0),
                limit_v: limit(h, br.1, tr.1),
            },
            Spec {
                at: (x1, y0),
                u: (0.0, -1.0),
                v: (-1.0, 0.0),
                ru: tr.1,
                rv: tr.0,
                limit_u: limit(h, tr.1, br.1),
                limit_v: limit(w, tr.0, tl.0),
            },
        ]
    } else {
        [
            Spec {
                at: (x1, y0),
                u: (1.0, 0.0),
                v: (0.0, 1.0),
                ru: tr.0,
                rv: tr.1,
                limit_u: limit(w, tr.0, tl.0),
                limit_v: limit(h, tr.1, br.1),
            },
            Spec {
                at: (x1, y1),
                u: (0.0, 1.0),
                v: (-1.0, 0.0),
                ru: br.1,
                rv: br.0,
                limit_u: limit(h, br.1, tr.1),
                limit_v: limit(w, br.0, bl.0),
            },
            Spec {
                at: (x0, y1),
                u: (-1.0, 0.0),
                v: (0.0, -1.0),
                ru: bl.0,
                rv: bl.1,
                limit_u: limit(w, bl.0, br.0),
                limit_v: limit(h, bl.1, tl.1),
            },
            Spec {
                at: (x0, y0),
                u: (0.0, -1.0),
                v: (1.0, 0.0),
                ru: tl.1,
                rv: tl.0,
                limit_u: limit(h, tl.1, bl.1),
                limit_v: limit(w, tl.0, tr.0),
            },
        ]
    };
    for (i, s) in specs.iter().enumerate() {
        let r = s.ru.max(s.rv);
        // Corner-frame coordinates (along u from the corner, along v from
        // the corner) to the plane, each axis scaled to its own radius.
        let (su, sv) = if r > 0.0 {
            (s.ru / r, s.rv / r)
        } else {
            (0.0, 0.0)
        };
        let pt = |a: f64, b: f64| {
            (
                s.at.0 + s.u.0 * a * su + s.v.0 * b * sv,
                s.at.1 + s.u.1 * a * su + s.v.1 * b * sv,
            )
        };
        if r <= 0.0 {
            out(if i == 0 {
                Segment::Move(at(s.at))
            } else {
                Segment::Line(at(s.at))
            });
            continue;
        }
        // How far the corner may spread, in the frame of radius `r`.
        let budget = (s.limit_u / su).min(s.limit_v / sv).max(r);
        let c = params(r, if continuous { SMOOTHING } else { 0.0 }, budget);
        let start = at(pt(-c.p, 0.0));
        out(if i == 0 {
            Segment::Move(start)
        } else {
            Segment::Line(start)
        });
        // Corner frame: the corner at (0, 0), entered along +a from
        // a = -p, left along +b to b = p. The arc's circle is centered at
        // (-r, r).
        let cubic =
            |c1: (f64, f64), c2: (f64, f64), e: (f64, f64)| Segment::Cubic([at(c1), at(c2), at(e)]);
        let e1 = (-c.p + c.a + c.b + c.c, c.d);
        // Circular corners (and continuous ones without room) have none.
        let transitions = c.a + c.b + c.c > 1e-9 * r;
        if transitions {
            out(cubic(
                pt(-c.p + c.a, 0.0),
                pt(-c.p + c.a + c.b, 0.0),
                pt(e1.0, e1.1),
            ));
        }
        // The arc, symmetric about the corner's diagonal, as one cubic.
        let theta = c.arc;
        let k = 4.0 / 3.0 * (theta / 4.0).tan() * r;
        let start = -std::f64::consts::FRAC_PI_4 - theta / 2.0;
        let end = -std::f64::consts::FRAC_PI_4 + theta / 2.0;
        let on = |phi: f64| (-r + r * phi.cos(), r + r * phi.sin());
        let tangent = |phi: f64| (-phi.sin(), phi.cos());
        let (p0, p3) = (on(start), on(end));
        let (t0, t3) = (tangent(start), tangent(end));
        out(cubic(
            pt(p0.0 + k * t0.0, p0.1 + k * t0.1),
            pt(p3.0 - k * t3.0, p3.1 - k * t3.1),
            pt(p3.0, p3.1),
        ));
        if transitions {
            // The first transition mirrored about the diagonal
            // ((x, y) -> (-y, -x)), backwards.
            out(cubic(
                pt(0.0, c.p - c.a - c.b),
                pt(0.0, c.p - c.a),
                pt(0.0, c.p),
            ));
        }
    }
    out(Segment::Close);
}

/// The shape of one corner of radius `r` (Figma's corner smoothing): the
/// transition reaches `p` along each edge, its cubic's handles are `a`,
/// `b`, it ends `c` further along and `d` inwards, and the arc spans `arc`
/// radians.
struct Params {
    p: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    arc: f64,
}

fn params(r: f64, smoothing: f64, budget: f64) -> Params {
    use std::f64::consts::FRAC_PI_2;
    // Less smoothing where the edge is too short for all of it.
    let smoothing = smoothing.min(budget / r - 1.0).max(0.0);
    let p = ((1.0 + smoothing) * r).min(budget);
    let arc = FRAC_PI_2 * (1.0 - smoothing);
    let arc_len = (arc / 2.0).sin() * r * std::f64::consts::SQRT_2;
    let alpha = (FRAC_PI_2 - arc) / 2.0;
    let p3_to_p4 = r * (alpha / 2.0).tan();
    let beta = std::f64::consts::FRAC_PI_4 * smoothing;
    let c = p3_to_p4 * beta.cos();
    let d = c * beta.tan();
    let b = ((p - arc_len - c - d) / 3.0).max(0.0);
    Params {
        p,
        a: 2.0 * b,
        b,
        c,
        d,
        arc,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{bounds, point, px, size};

    fn outline(corners: [f32; 4], continuous: bool, reverse: bool) -> Vec<Segment> {
        let [tl, tr, br, bl] = corners.map(|r| size(px(r), px(r)));
        let mut v = Vec::new();
        rounded_rect(
            bounds(point(px(0.0), px(0.0)), size(px(100.0), px(60.0))),
            Corners {
                top_left: tl,
                top_right: tr,
                bottom_right: br,
                bottom_left: bl,
            },
            continuous,
            reverse,
            &mut |s| v.push(s),
        );
        v
    }

    fn end(s: &Segment) -> (f32, f32) {
        let p = match *s {
            Segment::Move(p) | Segment::Line(p) => p,
            Segment::Cubic(c) => c[2],
            Segment::Close => unreachable!(),
        };
        (p.x.0, p.y.0)
    }

    fn close(a: (f32, f32), b: (f32, f32)) -> bool {
        (a.0 - b.0).abs() < 1e-4 && (a.1 - b.1).abs() < 1e-4
    }

    #[test]
    fn circular_corners_are_quarter_circles() {
        let v = outline([10.0; 4], false, false);
        // Move, then per corner a line and one arc, then close.
        assert_eq!(v.len(), 1 + 1 + 3 * 2 + 1);
        assert!(close(end(&v[0]), (90.0, 0.0)));
        assert!(close(end(&v[1]), (100.0, 10.0)));
        let Segment::Cubic(c) = v[1] else { panic!() };
        // The standard quarter circle handles (0.5523 r).
        assert!((c[0].x.0 - (90.0 + 5.522_847_5)).abs() < 1e-4 && c[0].y.0.abs() < 1e-6);
        assert!(close(end(&v[2]), (100.0, 50.0)));
    }

    #[test]
    fn continuous_corners_spread_along_the_edges() {
        let v = outline([10.0; 4], true, false);
        // The curve starts 1.6 r before the corner and ends 1.6 r after it.
        assert!(close(end(&v[0]), (84.0, 0.0)));
        assert!(close(end(&v[3]), (100.0, 16.0)));
        // Tangent continuity: the first handle lies on the edge.
        let Segment::Cubic(c) = v[1] else { panic!() };
        assert_eq!(c[0].y.0, 0.0);
        let Segment::Cubic(last) = v[3] else { panic!() };
        assert_eq!(last[1].x.0, 100.0);
        assert_eq!(last[2].x.0, 100.0);
    }

    #[test]
    fn pills_stay_pills() {
        // Radius half the height: no room to spread, so circular ends.
        let continuous = outline([30.0; 4], true, false);
        let circular = outline([30.0; 4], false, false);
        assert_eq!(continuous.len(), circular.len());
        for (a, b) in continuous.iter().zip(&circular) {
            if let (Segment::Cubic(a), Segment::Cubic(b)) = (a, b) {
                for (x, y) in a.iter().zip(b) {
                    assert!((x.x.0 - y.x.0).abs() < 1e-4 && (x.y.0 - y.y.0).abs() < 1e-4);
                }
            }
        }
    }

    #[test]
    fn reversed_outlines_visit_the_corners_the_other_way() {
        let v = outline([10.0, 0.0, 0.0, 0.0], false, true);
        assert!(close(end(&v[0]), (10.0, 0.0)));
        assert!(close(end(&v[1]), (0.0, 10.0)));
        assert!(close(end(&v[2]), (0.0, 60.0)));
        assert!(close(end(&v[3]), (100.0, 60.0)));
        assert!(close(end(&v[4]), (100.0, 0.0)));
        // Square corners are lines only.
        assert_eq!(v.len(), 6);
    }
}
