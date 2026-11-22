//! Units and geometry, typed as GPUI's `gpui::geometry`: a length is
//! [`Points`] (GPUI's `Pixels`), [`Rems`], a [`Percentage`] (a fraction:
//! `0.5` is 50%) or one of the lengths styles give
//! ([`AbsoluteLength`], [`DefiniteLength`], [`Length`]); an angle is
//! [`Radians`]; shapes are generic over their unit ([`Point`], [`Size`],
//! [`Bounds`], [`Edges`], [`Corners`]). Public API takes and returns these,
//! never a bare `f32` for a length, an angle or a fraction (held by the
//! `unit_types` test; docs/dev/geometry.md).
//!
//! NSH lays out in points; [`DevicePixels`] and [`ScaledPixels`] exist
//! only where a platform draws or reports pixels. Conversions happen at
//! the boundaries: taffy here (`taffy.rs`, the one place), the platforms
//! where they hand values to their toolkits, `nsh-js` where it decodes JS
//! numbers.
//!
//! The units are `#[repr(transparent)]` newtypes and the shapes
//! `#[repr(C)]` structs of them: zero cost on hot paths. Deviations from
//! GPUI are deliberate and listed in docs/dev/geometry.md (points rather
//! than pixels, `f32`'s comparisons rather than a total order, a public
//! `.0`, CSS angle constructors).

mod length;
mod shapes;
mod taffy;
mod units;

pub use length::{AbsoluteLength, DefiniteLength, Length, auto, relative};
pub use shapes::{Along, Axis, Bounds, Corners, Edges, Point, Size, bounds, point, size};
pub use units::{
    DevicePixels, Half, IsZero, Percentage, Points, REM_SIZE, Radians, Rems, ScaledPixels, deg,
    grad, percentage, px, radians, rems, turn,
};

/// Bounds at `x`, `y` of `width` × `height` points, for the core's
/// layout code, which computes in taffy's `f32`.
#[inline]
pub(crate) const fn rect(x: f32, y: f32, width: f32, height: f32) -> Bounds<Points> {
    Bounds::new(
        Point::new(Points(x), Points(y)),
        Size::new(Points(width), Points(height)),
    )
}

/// A size of `width` × `height` points, for the core's layout code.
#[inline]
pub(crate) const fn size_pt(width: f32, height: f32) -> Size<Points> {
    Size::new(Points(width), Points(height))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod unit_scan;
#[cfg(test)]
mod unit_types;
