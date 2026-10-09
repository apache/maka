/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The thinking face, the reasoning row's icon: the person's own drawing
//! (`docs/design/icons/thinking-icon-v4.svg`), a small face on a 128 view
//! box that SMIL animates over 2.4 s. GPUI's SVG renderer does not play
//! SMIL, so the face is drawn here with GPUI paths from the drawing's
//! points, and its animation is reproduced in code.
//!
//! Two brows (strokes with round caps and joins) and two eyes (filled
//! circles) move between a rest pose and a moved pose on the drawing's key
//! times: they rest, then the left brow's inner end hooks up, the right
//! brow slides in and the eyes widen, they hold, and they return. The
//! brows ease through the drawing's key spline, `cubic-bezier(.42, 0, .58,
//! 1)`, on every interval; the eyes change linearly. [`pose_at`] is the
//! face at a time into its loop, and [`thinking_face`] draws it then.

use gpui_kit::base::animation::cubic_bezier;
use gpui_kit::{
    Bounds, FillOptions, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, Path,
    PathBuilder, PathStyle, Pixels, Point, Styled as _, TestSupportExt as _, canvas, div, point,
    px,
};

/// How long the face's loop takes, in seconds, as in the drawing.
pub(crate) const LOOP_SECS: f32 = 2.4;

/// The drawing's key times, as shares of the loop.
const KEY_TIMES: [f32; 6] = [0., 0.18, 0.43, 0.65, 0.9, 1.];

/// How far toward the moved pose the face is at each key time: rest, rest,
/// moved, moved, rest, rest.
const KEY_POSES: [f32; 6] = [0., 0., 1., 1., 0., 0.];

/// The brows' easing on every interval, the drawing's `keySplines`.
const BROW_SPLINE: [f32; 4] = [0.42, 0., 0.58, 1.];

/// The square of the drawing that fills the icon (x, y, side, in drawing
/// units): the face, centred across, and down between its rest and moved
/// heights, so the hooked brow stays well inside.
/// At 16 px the drawing's 5.5 stroke is 1.57 px, by the icon set's 1.5, and
/// the face is 13.6 px wide, as wide as the widest icons beside it (the
/// terminal's 13.5); a smaller square would make it wider than they are.
const VIEW_BOX: (f32, f32, f32) = (33., 30., 56.);

/// The brows' stroke width, in drawing units.
const STROKE: f32 = 5.5;

/// The eyes' centres, in drawing units.
const EYES: [Point<f32>; 2] = [point(47., 65.), point(74., 65.)];

/// How far, in pixels, the drawn curves may stray from true circles: a
/// fiftieth of a pixel, so even the smallest disc at 16 px is round.
const TOLERANCE: f32 = 0.02;

/// Where the face's parts are at one moment, in drawing units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FacePose {
    /// The left brow, a polyline whose inner end hooks up.
    left_brow: [Point<f32>; 3],
    /// The right brow, a line.
    right_brow: [Point<f32>; 2],
    /// The radius of both eyes.
    eye_radius: f32,
}

impl FacePose {
    /// The face at rest, as drawn.
    pub(crate) const REST: Self = Self {
        left_brow: [point(40., 54.), point(53., 54.), point(54., 54.)],
        right_brow: [point(68., 53.), point(82., 53.)],
        eye_radius: 3.6,
    };

    /// The face at the height of its thought.
    pub(crate) const MOVED: Self = Self {
        left_brow: [point(43., 54.), point(57., 54.), point(58., 46.)],
        right_brow: [point(65., 53.), point(79., 53.)],
        eye_radius: 4.8,
    };

    /// The face with its brows `brows` and its eyes `eyes` of the way from
    /// rest to moved: exactly the rest pose at 0 and the moved pose at 1.
    fn between(brows: f32, eyes: f32) -> Self {
        let mix = |rest: f32, moved: f32, t: f32| rest * (1. - t) + moved * t;
        let mix_point = |rest: Point<f32>, moved: Point<f32>| {
            point(mix(rest.x, moved.x, brows), mix(rest.y, moved.y, brows))
        };
        let (rest, moved) = (Self::REST, Self::MOVED);
        Self {
            left_brow: std::array::from_fn(|i| mix_point(rest.left_brow[i], moved.left_brow[i])),
            right_brow: std::array::from_fn(|i| mix_point(rest.right_brow[i], moved.right_brow[i])),
            eye_radius: mix(rest.eye_radius, moved.eye_radius, eyes),
        }
    }
}

/// The face `secs` into its loop, which repeats: the rest pose at 0 s and
/// at [`LOOP_SECS`], the moved pose from 0.43 to 0.65 of the loop, and
/// between them each part where the drawing's animation has it.
pub(crate) fn pose_at(secs: f32) -> FacePose {
    let share = (secs / LOOP_SECS).rem_euclid(1.);
    let last = KEY_TIMES.len() - 2;
    let span = KEY_TIMES.windows(2).position(|times| share < times[1]).unwrap_or(last);
    let progress = (share - KEY_TIMES[span]) / (KEY_TIMES[span + 1] - KEY_TIMES[span]);
    let (from, to) = (KEY_POSES[span], KEY_POSES[span + 1]);
    let [x1, y1, x2, y2] = BROW_SPLINE;
    let eased = cubic_bezier(x1, y1, x2, y2)(progress);
    FacePose::between(from + (to - from) * eased, from + (to - from) * progress)
}

/// The thinking face as an icon `size` square, in `color`, `secs` into its
/// loop (0 for the rest pose).
pub(crate) fn thinking_face(secs: f32, size: Pixels, color: Hsla) -> impl IntoElement {
    let pose = pose_at(secs);
    div().id("thinking-face").test_support().flex_shrink_0().size(size).child(
        canvas(
            |_, _, _| {},
            move |bounds, (), window, _| {
                if let Some(path) = face_path(&pose, bounds) {
                    window.paint_path(path, color);
                }
            },
        )
        .size_full(),
    )
}

/// The face in `pose` as one filled path over `bounds` (the drawing's
/// [`VIEW_BOX`]). A brow is a band along each of its segments with a disc
/// at each of its points, which is its stroke with round caps and joins;
/// an eye is a disc. Every piece winds the same way and the path fills
/// non-zero, so the overlapping pieces merge into one shape.
fn face_path(pose: &FacePose, bounds: Bounds<Pixels>) -> Option<Path<Pixels>> {
    let (left, top, side) = VIEW_BOX;
    let scale = bounds.size.width / px(side);
    let at =
        |p: Point<f32>| bounds.origin + point(px((p.x - left) * scale), px((p.y - top) * scale));
    let half_stroke = px(STROKE / 2. * scale);
    let mut path = PathBuilder::fill()
        .with_style(PathStyle::Fill(FillOptions::non_zero().with_tolerance(TOLERANCE)));
    for brow in [&pose.left_brow[..], &pose.right_brow[..]] {
        for segment in brow.windows(2) {
            band(&mut path, at(segment[0]), at(segment[1]), half_stroke);
        }
        for &joint in brow {
            disc(&mut path, at(joint), half_stroke);
        }
    }
    for eye in EYES {
        disc(&mut path, at(eye), px(pose.eye_radius * scale));
    }
    path.build().ok()
}

/// A band `half_width` either side of the segment from `start` to `end`,
/// with square ends; it winds as [`disc`] does.
fn band(path: &mut PathBuilder, start: Point<Pixels>, end: Point<Pixels>, half_width: Pixels) {
    let along = end - start;
    let length = along.x.as_f32().hypot(along.y.as_f32());
    if length == 0. {
        return;
    }
    let across = point(-along.y, along.x) * (half_width.as_f32() / length);
    path.add_polygon(&[start + across, end + across, end - across, start - across], true);
}

/// A disc of `radius` around `centre`, two half arcs that wind as
/// [`band`]'s polygon does.
fn disc(path: &mut PathBuilder, centre: Point<Pixels>, radius: Pixels) {
    let (east, west) = (centre + point(radius, px(0.)), centre - point(radius, px(0.)));
    let radii = point(radius, radius);
    path.move_to(east);
    path.arc_to(radii, px(0.), false, false, west);
    path.arc_to(radii, px(0.), false, false, east);
    path.close();
}

#[cfg(test)]
mod tests {
    use super::*;

    use gpui_kit::size;

    /// The pose a share of the way through the loop.
    fn at_share(share: f32) -> FacePose {
        pose_at(share * LOOP_SECS)
    }

    #[test]
    fn the_face_rests_at_the_ends_of_its_loop_and_is_moved_in_its_middle() {
        assert_eq!(pose_at(0.), FacePose::REST);
        assert_eq!(pose_at(LOOP_SECS), FacePose::REST, "the loop starts again");
        assert_eq!(at_share(0.1), FacePose::REST, "still at first");
        for share in [0.44, 0.5, 0.6, 0.64] {
            assert_eq!(at_share(share), FacePose::MOVED, "held at {share}");
        }
        assert_eq!(at_share(0.95), FacePose::REST, "back before the loop ends");
        assert_eq!(pose_at(LOOP_SECS + 1.2), at_share(0.5), "it repeats");
    }

    #[test]
    fn the_brows_ease_through_the_spline_and_the_eyes_grow_linearly() {
        // A quarter of the way from rest (0.18) to moved (0.43), where
        // cubic-bezier(.42, 0, .58, 1) is 0.129162 (solved offline).
        let eased = 0.129_162;
        let rising = at_share(0.18 + 0.25 * 0.25);
        assert!((rising.right_brow[0].x - (68. - 3. * eased)).abs() < 1e-3, "{rising:?}");
        assert!((rising.left_brow[2].y - (54. - 8. * eased)).abs() < 1e-3, "{rising:?}");
        assert!((rising.eye_radius - 3.9).abs() < 1e-4, "linear: {rising:?}");
        // The same share of the way back (0.65 to 0.9).
        let falling = at_share(0.65 + 0.25 * 0.25);
        assert!((falling.right_brow[0].x - (65. + 3. * eased)).abs() < 1e-3, "{falling:?}");
        assert!((falling.eye_radius - 4.5).abs() < 1e-4, "linear: {falling:?}");
    }

    #[test]
    fn the_face_fills_its_icon_without_clipping() {
        let icon = Bounds::new(point(px(0.), px(0.)), size(px(16.), px(16.)));
        for step in 0..=96 {
            let pose = pose_at(LOOP_SECS * step as f32 / 96.);
            let path = face_path(&pose, icon).expect("a path");
            assert!(icon.contains(&path.bounds.origin), "{step}: {:?}", path.bounds);
            assert!(icon.contains(&path.bounds.bottom_right()), "{step}: {:?}", path.bounds);
        }
        let moved = face_path(&FacePose::MOVED, icon).expect("a path").bounds;
        assert!(moved.size.width > px(11.) && moved.size.height > px(7.), "{moved:?}");
    }

    /// Drawn one pixel to a unit, the rest pose covers two stadiums (each
    /// brow: 14 long, 5.5 wide, round ends) and two eyes: the pieces of a
    /// brow merge, with no hole where they overlap.
    #[test]
    fn the_brows_are_strokes_with_round_caps_and_joins() {
        let unit = Bounds::new(point(px(0.), px(0.)), size(px(56.), px(56.)));
        let path = face_path(&FacePose::REST, unit).expect("a path");
        let area: f32 = path
            .vertices
            .chunks(3)
            .map(|triangle| {
                let [a, b, c] = [0, 1, 2].map(|i| triangle[i].xy_position);
                let (ab, ac) = (b - a, c - a);
                (ab.x.as_f32() * ac.y.as_f32() - ab.y.as_f32() * ac.x.as_f32()).abs() / 2.
            })
            .sum();
        let r = STROKE / 2.;
        let brow = 14. * STROKE + std::f32::consts::PI * r * r;
        let eye = std::f32::consts::PI * 3.6 * 3.6;
        let expected = 2. * brow + 2. * eye;
        assert!((area - expected).abs() < expected * 0.01, "{area} against {expected}");
    }
}
