//! Shapes in points from the bare numbers the drawings compute with, for
//! `Painter`'s typed methods (as GPUI's `point(px(x), px(y))`, shorter).

use nsh_core::{
    Bounds, Point, Points,
    geometry::{point, px, size},
};

/// The point (`x`, `y`).
pub(crate) fn pt(x: f32, y: f32) -> Point<Points> {
    point(px(x), px(y))
}

/// The rectangle at (`x`, `y`) of `w` × `h`.
pub(crate) fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Points> {
    Bounds::new(pt(x, y), size(px(w), px(h)))
}

/// Lengths in points (dash patterns).
pub(crate) fn lengths<const N: usize>(values: [f32; N]) -> [Points; N] {
    values.map(px)
}
