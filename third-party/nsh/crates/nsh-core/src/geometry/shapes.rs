//! Shapes generic over their unit, as GPUI's: [`Point`], [`Size`],
//! [`Bounds`], [`Edges`] and [`Corners`], and the [`Axis`] they are read
//! [`Along`].

use std::ops::{Add, AddAssign, Div, Mul, MulAssign, Neg, Sub, SubAssign};

use serde::{Deserialize, Serialize};

use super::units::{DevicePixels, Half, IsZero, Points, ScaledPixels};

/// A direction in two dimensions (`"vertical"` or `"horizontal"` in JS:
/// a prop that names one, a split's or a resizable group's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, crate::element::PropEnum)]
pub enum Axis {
    /// Up and down.
    Vertical,
    /// Left and right.
    Horizontal,
}

impl Axis {
    /// The other axis.
    #[inline]
    pub fn invert(self) -> Self {
        match self {
            Axis::Vertical => Axis::Horizontal,
            Axis::Horizontal => Axis::Vertical,
        }
    }
}

/// A two-dimensional value read or changed along one [`Axis`].
pub trait Along {
    /// The value of one dimension.
    type Unit;

    /// The value along `axis`.
    fn along(&self, axis: Axis) -> Self::Unit;

    /// The value with `f` applied to the dimension along `axis`.
    fn apply_along(&self, axis: Axis, f: impl FnOnce(Self::Unit) -> Self::Unit) -> Self;
}

/// A point: `x` to the right, `y` down, from the origin of what it is
/// relative to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(C)]
pub struct Point<T> {
    /// The horizontal coordinate.
    pub x: T,
    /// The vertical coordinate.
    pub y: T,
}

/// A point at `x`, `y`.
#[inline]
pub const fn point<T>(x: T, y: T) -> Point<T> {
    Point { x, y }
}

impl<T> Point<T> {
    /// A point at `x`, `y`.
    #[inline]
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}

impl<T: Clone> Point<T> {
    /// Both coordinates converted by `f`.
    #[inline]
    pub fn map<U>(&self, f: impl Fn(T) -> U) -> Point<U> {
        Point {
            x: f(self.x.clone()),
            y: f(self.y.clone()),
        }
    }
}

impl<T: Clone + PartialOrd> Point<T> {
    /// The larger of each coordinate of both points.
    pub fn max(&self, other: &Self) -> Self {
        Point {
            x: if self.x >= other.x { &self.x } else { &other.x }.clone(),
            y: if self.y >= other.y { &self.y } else { &other.y }.clone(),
        }
    }

    /// The smaller of each coordinate of both points.
    pub fn min(&self, other: &Self) -> Self {
        Point {
            x: if self.x <= other.x { &self.x } else { &other.x }.clone(),
            y: if self.y <= other.y { &self.y } else { &other.y }.clone(),
        }
    }

    /// The point within the box between `min` and `max`.
    pub fn clamp(&self, min: &Self, max: &Self) -> Self {
        self.max(min).min(max)
    }
}

impl<T: Clone + Sub<Output = T>> Point<T> {
    /// The point relative to `origin`.
    #[inline]
    pub fn relative_to(&self, origin: &Point<T>) -> Point<T> {
        Point {
            x: self.x.clone() - origin.x.clone(),
            y: self.y.clone() - origin.y.clone(),
        }
    }
}

impl<T: Clone> Along for Point<T> {
    type Unit = T;

    #[inline]
    fn along(&self, axis: Axis) -> T {
        match axis {
            Axis::Horizontal => self.x.clone(),
            Axis::Vertical => self.y.clone(),
        }
    }

    fn apply_along(&self, axis: Axis, f: impl FnOnce(T) -> T) -> Self {
        match axis {
            Axis::Horizontal => Point::new(f(self.x.clone()), self.y.clone()),
            Axis::Vertical => Point::new(self.x.clone(), f(self.y.clone())),
        }
    }
}

impl Point<Points> {
    /// Scaled to device pixels at `factor` (unrounded).
    #[inline]
    pub fn scale(&self, factor: f32) -> Point<ScaledPixels> {
        Point::new(self.x.scale(factor), self.y.scale(factor))
    }

    /// The distance from the origin.
    #[inline]
    pub fn magnitude(&self) -> f64 {
        (self.x.0 as f64).hypot(self.y.0 as f64)
    }
}

impl<T: Add<Output = T>> Add for Point<T> {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        Point::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl<T: Sub<Output = T>> Sub for Point<T> {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        Point::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl<T: AddAssign> AddAssign for Point<T> {
    #[inline]
    fn add_assign(&mut self, rhs: Self) {
        self.x += rhs.x;
        self.y += rhs.y;
    }
}

impl<T: SubAssign> SubAssign for Point<T> {
    #[inline]
    fn sub_assign(&mut self, rhs: Self) {
        self.x -= rhs.x;
        self.y -= rhs.y;
    }
}

impl<T: Neg<Output = T>> Neg for Point<T> {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        Point::new(-self.x, -self.y)
    }
}

impl<T: Mul<S, Output = T>, S: Clone> Mul<S> for Point<T> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: S) -> Self {
        Point::new(self.x * rhs.clone(), self.y * rhs)
    }
}

impl<T: MulAssign<S>, S: Clone> MulAssign<S> for Point<T> {
    #[inline]
    fn mul_assign(&mut self, rhs: S) {
        self.x *= rhs.clone();
        self.y *= rhs;
    }
}

impl<T: Div<S, Output = T>, S: Clone> Div<S> for Point<T> {
    type Output = Self;
    #[inline]
    fn div(self, rhs: S) -> Self {
        Point::new(self.x / rhs.clone(), self.y / rhs)
    }
}

impl<T: IsZero> IsZero for Point<T> {
    fn is_zero(&self) -> bool {
        self.x.is_zero() && self.y.is_zero()
    }
}

impl<T> From<Size<T>> for Point<T> {
    #[inline]
    fn from(s: Size<T>) -> Self {
        Point::new(s.width, s.height)
    }
}

/// A width and a height.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(C)]
pub struct Size<T> {
    /// The width.
    pub width: T,
    /// The height.
    pub height: T,
}

/// A size of `width` × `height`.
#[inline]
pub const fn size<T>(width: T, height: T) -> Size<T> {
    Size { width, height }
}

impl<T> Size<T> {
    /// A size of `width` × `height`.
    #[inline]
    pub const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}

impl<T: Clone> Size<T> {
    /// Both dimensions converted by `f`.
    #[inline]
    pub fn map<U>(&self, f: impl Fn(T) -> U) -> Size<U> {
        Size {
            width: f(self.width.clone()),
            height: f(self.height.clone()),
        }
    }
}

impl<T: Clone + PartialOrd> Size<T> {
    /// The larger of each dimension of both sizes.
    pub fn max(&self, other: &Self) -> Self {
        Size {
            width: if self.width >= other.width {
                &self.width
            } else {
                &other.width
            }
            .clone(),
            height: if self.height >= other.height {
                &self.height
            } else {
                &other.height
            }
            .clone(),
        }
    }

    /// The smaller of each dimension of both sizes.
    pub fn min(&self, other: &Self) -> Self {
        Size {
            width: if self.width <= other.width {
                &self.width
            } else {
                &other.width
            }
            .clone(),
            height: if self.height <= other.height {
                &self.height
            } else {
                &other.height
            }
            .clone(),
        }
    }
}

impl<T: Half> Size<T> {
    /// The center of a box of this size at the origin.
    #[inline]
    pub fn center(&self) -> Point<T> {
        Point::new(self.width.half(), self.height.half())
    }
}

impl<T: Clone> Along for Size<T> {
    type Unit = T;

    #[inline]
    fn along(&self, axis: Axis) -> T {
        match axis {
            Axis::Horizontal => self.width.clone(),
            Axis::Vertical => self.height.clone(),
        }
    }

    fn apply_along(&self, axis: Axis, f: impl FnOnce(T) -> T) -> Self {
        match axis {
            Axis::Horizontal => Size::new(f(self.width.clone()), self.height.clone()),
            Axis::Vertical => Size::new(self.width.clone(), f(self.height.clone())),
        }
    }
}

impl Size<Points> {
    /// Scaled to device pixels at `factor` (unrounded).
    #[inline]
    pub fn scale(&self, factor: f32) -> Size<ScaledPixels> {
        Size::new(self.width.scale(factor), self.height.scale(factor))
    }

    /// In whole device pixels at `scale_factor`.
    #[inline]
    pub fn to_device_pixels(self, scale_factor: f32) -> Size<DevicePixels> {
        Size::new(
            self.width.to_device_pixels(scale_factor),
            self.height.to_device_pixels(scale_factor),
        )
    }
}

impl Size<DevicePixels> {
    /// In points at `scale_factor` device pixels per point.
    #[inline]
    pub fn to_points(self, scale_factor: f32) -> Size<Points> {
        Size::new(
            self.width.to_points(scale_factor),
            self.height.to_points(scale_factor),
        )
    }
}

impl<T: Add<Output = T>> Add for Size<T> {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        Size::new(self.width + rhs.width, self.height + rhs.height)
    }
}

impl<T: Sub<Output = T>> Sub for Size<T> {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        Size::new(self.width - rhs.width, self.height - rhs.height)
    }
}

impl<T: Mul<S, Output = T>, S: Clone> Mul<S> for Size<T> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: S) -> Self {
        Size::new(self.width * rhs.clone(), self.height * rhs)
    }
}

impl<T: MulAssign<S>, S: Clone> MulAssign<S> for Size<T> {
    #[inline]
    fn mul_assign(&mut self, rhs: S) {
        self.width *= rhs.clone();
        self.height *= rhs;
    }
}

impl<T: Div<S, Output = T>, S: Clone> Div<S> for Size<T> {
    type Output = Self;
    #[inline]
    fn div(self, rhs: S) -> Self {
        Size::new(self.width / rhs.clone(), self.height / rhs)
    }
}

impl<T: IsZero> IsZero for Size<T> {
    /// Either dimension is zero (the size covers no area), as GPUI's.
    fn is_zero(&self) -> bool {
        self.width.is_zero() || self.height.is_zero()
    }
}

impl<T> From<Point<T>> for Size<T> {
    #[inline]
    fn from(p: Point<T>) -> Self {
        Size::new(p.x, p.y)
    }
}

/// A rectangle: its top left corner (`origin`) and its `size`. A view's
/// frame is its bounds relative to its parent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(C)]
pub struct Bounds<T> {
    /// The top left corner.
    pub origin: Point<T>,
    /// The size.
    pub size: Size<T>,
}

/// Bounds at `origin` of `size`.
#[inline]
pub const fn bounds<T>(origin: Point<T>, size: Size<T>) -> Bounds<T> {
    Bounds { origin, size }
}

impl<T> Bounds<T> {
    /// Bounds at `origin` of `size`.
    #[inline]
    pub const fn new(origin: Point<T>, size: Size<T>) -> Self {
        Self { origin, size }
    }
}

impl<T: Clone> Bounds<T> {
    /// Every coordinate converted by `f`.
    #[inline]
    pub fn map<U>(&self, f: impl Fn(T) -> U) -> Bounds<U> {
        Bounds {
            origin: self.origin.map(&f),
            size: self.size.map(&f),
        }
    }

    /// The origin's coordinates converted by `f`, the size kept.
    #[inline]
    pub fn map_origin(self, f: impl Fn(T) -> T) -> Bounds<T> {
        Bounds {
            origin: self.origin.map(f),
            size: self.size,
        }
    }

    /// The size's dimensions converted by `f`, the origin kept.
    #[inline]
    pub fn map_size(self, f: impl Fn(T) -> T) -> Bounds<T> {
        Bounds {
            origin: self.origin,
            size: self.size.map(f),
        }
    }
}

impl<T: Clone + Add<Output = T> + Sub<Output = T>> Bounds<T> {
    /// The bounds between two corners.
    #[inline]
    pub fn from_corners(top_left: Point<T>, bottom_right: Point<T>) -> Self {
        let size = Size::new(
            bottom_right.x - top_left.x.clone(),
            bottom_right.y - top_left.y.clone(),
        );
        Bounds {
            origin: top_left,
            size,
        }
    }

    /// The top edge.
    #[inline]
    pub fn top(&self) -> T {
        self.origin.y.clone()
    }

    /// The bottom edge.
    #[inline]
    pub fn bottom(&self) -> T {
        self.origin.y.clone() + self.size.height.clone()
    }

    /// The left edge.
    #[inline]
    pub fn left(&self) -> T {
        self.origin.x.clone()
    }

    /// The right edge.
    #[inline]
    pub fn right(&self) -> T {
        self.origin.x.clone() + self.size.width.clone()
    }

    /// The top right corner.
    #[inline]
    pub fn top_right(&self) -> Point<T> {
        Point::new(self.right(), self.top())
    }

    /// The bottom right corner.
    #[inline]
    pub fn bottom_right(&self) -> Point<T> {
        Point::new(self.right(), self.bottom())
    }

    /// The bottom left corner.
    #[inline]
    pub fn bottom_left(&self) -> Point<T> {
        Point::new(self.left(), self.bottom())
    }

    /// The bounds grown by `amount` on every side.
    #[must_use]
    pub fn dilate(&self, amount: T) -> Self {
        let double = amount.clone() + amount.clone();
        Bounds {
            origin: self.origin.clone() - point(amount.clone(), amount),
            size: self.size.clone() + size(double.clone(), double),
        }
    }

    /// The bounds grown by each of `amount`'s edges.
    #[must_use]
    pub fn extend(&self, amount: Edges<T>) -> Self {
        Bounds {
            origin: self.origin.clone() - point(amount.left.clone(), amount.top.clone()),
            size: self.size.clone() + size(amount.left + amount.right, amount.top + amount.bottom),
        }
    }

    /// The space between these bounds and the `outer` bounds around them.
    pub fn space_within(&self, outer: &Self) -> Edges<T> {
        Edges {
            top: self.top() - outer.top(),
            right: outer.right() - self.right(),
            bottom: outer.bottom() - self.bottom(),
            left: self.left() - outer.left(),
        }
    }
}

impl<T: Clone + Add<Output = T> + Sub<Output = T> + Neg<Output = T>> Bounds<T> {
    /// The bounds shrunk by `amount` on every side (`dilate` of
    /// `-amount`).
    #[must_use]
    pub fn inset(&self, amount: T) -> Self {
        self.dilate(-amount)
    }
}

impl<T: Clone + Add<Output = T> + Sub<Output = T> + Half> Bounds<T> {
    /// Bounds of `size` centered at `center`.
    pub fn centered_at(center: Point<T>, size: Size<T>) -> Self {
        let origin = Point::new(center.x - size.width.half(), center.y - size.height.half());
        Bounds { origin, size }
    }

    /// The center.
    #[inline]
    pub fn center(&self) -> Point<T> {
        Point::new(
            self.origin.x.clone() + self.size.width.half(),
            self.origin.y.clone() + self.size.height.half(),
        )
    }

    /// The width plus the height.
    #[inline]
    pub fn half_perimeter(&self) -> T {
        self.size.width.clone() + self.size.height.clone()
    }
}

impl<T: Clone + Add<Output = T> + Sub<Output = T> + PartialOrd> Bounds<T> {
    /// Whether `point` is inside: on the left or top edge is, on the right
    /// or bottom one is not.
    #[inline]
    pub fn contains(&self, point: &Point<T>) -> bool {
        point.x >= self.left()
            && point.x < self.right()
            && point.y >= self.top()
            && point.y < self.bottom()
    }

    /// Whether the bounds lie within `other`.
    pub fn is_contained_within(&self, other: &Self) -> bool {
        self.left() >= other.left()
            && self.right() <= other.right()
            && self.top() >= other.top()
            && self.bottom() <= other.bottom()
    }

    /// Whether the two bounds overlap.
    #[inline]
    pub fn intersects(&self, other: &Self) -> bool {
        let my_lower_right = self.bottom_right();
        let their_lower_right = other.bottom_right();
        self.origin.x < their_lower_right.x
            && my_lower_right.x > other.origin.x
            && self.origin.y < their_lower_right.y
            && my_lower_right.y > other.origin.y
    }

    /// The overlap of two bounds (of no size when they do not overlap).
    pub fn intersect(&self, other: &Self) -> Self {
        let upper_left = self.origin.max(&other.origin);
        let bottom_right = self
            .bottom_right()
            .min(&other.bottom_right())
            .max(&upper_left);
        Self::from_corners(upper_left, bottom_right)
    }

    /// The smallest bounds holding both.
    pub fn union(&self, other: &Self) -> Self {
        let top_left = self.origin.min(&other.origin);
        let bottom_right = self.bottom_right().max(&other.bottom_right());
        Bounds::from_corners(top_left, bottom_right)
    }

    /// `point` relative to the bounds' origin, if it is inside.
    pub fn localize(&self, point: &Point<T>) -> Option<Point<T>> {
        self.contains(point)
            .then(|| point.relative_to(&self.origin))
    }
}

impl<T: PartialOrd + Default> Bounds<T> {
    /// Whether the bounds cover no area (a dimension zero or less).
    #[inline]
    pub fn is_empty(&self) -> bool {
        !(self.size.width > T::default() && self.size.height > T::default())
    }
}

impl Bounds<Points> {
    /// Bounds that never compare equal to real ones (NaN): a new view's
    /// first frame is sent whatever it is.
    pub(crate) const UNSET: Self = Bounds {
        origin: Point::new(Points(f32::NAN), Points(f32::NAN)),
        size: Size::new(Points(f32::NAN), Points(f32::NAN)),
    };

    /// Scaled to device pixels at `factor` (unrounded).
    #[inline]
    pub fn scale(&self, factor: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: self.origin.scale(factor),
            size: self.size.scale(factor),
        }
    }

    /// In whole device pixels at `scale_factor`.
    #[inline]
    pub fn to_device_pixels(self, scale_factor: f32) -> Bounds<DevicePixels> {
        Bounds {
            origin: self.origin.map(|p| p.to_device_pixels(scale_factor)),
            size: self.size.to_device_pixels(scale_factor),
        }
    }
}

impl Bounds<DevicePixels> {
    /// In points at `scale_factor` device pixels per point.
    #[inline]
    pub fn to_points(self, scale_factor: f32) -> Bounds<Points> {
        Bounds {
            origin: self.origin.map(|p| p.to_points(scale_factor)),
            size: self.size.to_points(scale_factor),
        }
    }
}

/// The bounds moved by a point.
impl<T: Add<Output = T>> Add<Point<T>> for Bounds<T> {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Point<T>) -> Self {
        Bounds {
            origin: self.origin + rhs,
            size: self.size,
        }
    }
}

/// The bounds moved back by a point.
impl<T: Sub<Output = T>> Sub<Point<T>> for Bounds<T> {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Point<T>) -> Self {
        Bounds {
            origin: self.origin - rhs,
            size: self.size,
        }
    }
}

impl<T: Mul<S, Output = T>, S: Clone> Mul<S> for Bounds<T> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: S) -> Self {
        Bounds {
            origin: self.origin * rhs.clone(),
            size: self.size * rhs,
        }
    }
}

impl<T: MulAssign<S>, S: Clone> MulAssign<S> for Bounds<T> {
    #[inline]
    fn mul_assign(&mut self, rhs: S) {
        self.origin *= rhs.clone();
        self.size *= rhs;
    }
}

impl<T: Div<S, Output = T>, S: Clone> Div<S> for Bounds<T> {
    type Output = Self;
    #[inline]
    fn div(self, rhs: S) -> Self {
        Bounds {
            origin: self.origin / rhs.clone(),
            size: self.size / rhs,
        }
    }
}

impl<T: IsZero> IsZero for Bounds<T> {
    fn is_zero(&self) -> bool {
        self.size.is_zero()
    }
}

/// A value for each edge of a box: insets, paddings, borders.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(C)]
pub struct Edges<T> {
    /// The top edge.
    pub top: T,
    /// The right edge.
    pub right: T,
    /// The bottom edge.
    pub bottom: T,
    /// The left edge.
    pub left: T,
}

impl<T: Clone> Edges<T> {
    /// `value` on every edge.
    #[inline]
    pub fn all(value: T) -> Self {
        Edges {
            top: value.clone(),
            right: value.clone(),
            bottom: value.clone(),
            left: value,
        }
    }

    /// `[top, right, bottom, left]`, for toolkits that take sides by index.
    #[inline]
    pub fn to_array(&self) -> [T; 4] {
        [
            self.top.clone(),
            self.right.clone(),
            self.bottom.clone(),
            self.left.clone(),
        ]
    }
}

impl<T> From<[T; 4]> for Edges<T> {
    /// From `[top, right, bottom, left]`.
    fn from([top, right, bottom, left]: [T; 4]) -> Self {
        Edges {
            top,
            right,
            bottom,
            left,
        }
    }
}

impl<T> Edges<T> {
    /// Every edge converted by `f`.
    #[inline]
    pub fn map<U>(&self, f: impl Fn(&T) -> U) -> Edges<U> {
        Edges {
            top: f(&self.top),
            right: f(&self.right),
            bottom: f(&self.bottom),
            left: f(&self.left),
        }
    }

    /// Whether `predicate` holds for any edge.
    #[inline]
    pub fn any(&self, predicate: impl Fn(&T) -> bool) -> bool {
        predicate(&self.top)
            || predicate(&self.right)
            || predicate(&self.bottom)
            || predicate(&self.left)
    }
}

impl Edges<Points> {
    /// Zero on every edge.
    pub fn zero() -> Self {
        Edges::all(Points::ZERO)
    }

    /// Scaled to device pixels at `factor` (unrounded).
    pub fn scale(&self, factor: f32) -> Edges<ScaledPixels> {
        self.map(|p| p.scale(factor))
    }

    /// The largest edge.
    pub fn max(&self) -> Points {
        self.top.max(self.right).max(self.bottom).max(self.left)
    }
}

impl<T: Mul<S, Output = T> + Clone, S: Clone> Mul<S> for Edges<T> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: S) -> Self {
        Edges {
            top: self.top * rhs.clone(),
            right: self.right * rhs.clone(),
            bottom: self.bottom * rhs.clone(),
            left: self.left * rhs,
        }
    }
}

impl<T: IsZero> IsZero for Edges<T> {
    fn is_zero(&self) -> bool {
        self.top.is_zero() && self.right.is_zero() && self.bottom.is_zero() && self.left.is_zero()
    }
}

impl From<f32> for Edges<Points> {
    fn from(v: f32) -> Self {
        Edges::all(Points(v))
    }
}

impl From<Points> for Edges<Points> {
    fn from(p: Points) -> Self {
        Edges::all(p)
    }
}

/// A value for each corner of a box: radii.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(C)]
pub struct Corners<T> {
    /// The top left corner.
    pub top_left: T,
    /// The top right corner.
    pub top_right: T,
    /// The bottom right corner.
    pub bottom_right: T,
    /// The bottom left corner.
    pub bottom_left: T,
}

impl<T: Clone> Corners<T> {
    /// `value` at every corner.
    #[inline]
    pub fn all(value: T) -> Self {
        Corners {
            top_left: value.clone(),
            top_right: value.clone(),
            bottom_right: value.clone(),
            bottom_left: value,
        }
    }

    /// `[top_left, top_right, bottom_right, bottom_left]`, clockwise from
    /// the top left, for toolkits that take corners by index.
    #[inline]
    pub fn to_array(&self) -> [T; 4] {
        [
            self.top_left.clone(),
            self.top_right.clone(),
            self.bottom_right.clone(),
            self.bottom_left.clone(),
        ]
    }
}

impl<T> From<[T; 4]> for Corners<T> {
    /// From `[top_left, top_right, bottom_right, bottom_left]`.
    fn from([top_left, top_right, bottom_right, bottom_left]: [T; 4]) -> Self {
        Corners {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        }
    }
}

impl<T> Corners<T> {
    /// Every corner converted by `f`.
    #[inline]
    pub fn map<U>(&self, f: impl Fn(&T) -> U) -> Corners<U> {
        Corners {
            top_left: f(&self.top_left),
            top_right: f(&self.top_right),
            bottom_right: f(&self.bottom_right),
            bottom_left: f(&self.bottom_left),
        }
    }

    /// Whether `predicate` holds for any corner.
    #[inline]
    pub fn any(&self, predicate: impl Fn(&T) -> bool) -> bool {
        predicate(&self.top_left)
            || predicate(&self.top_right)
            || predicate(&self.bottom_right)
            || predicate(&self.bottom_left)
    }
}

impl Corners<Points> {
    /// Scaled to device pixels at `factor` (unrounded).
    pub fn scale(&self, factor: f32) -> Corners<ScaledPixels> {
        self.map(|p| p.scale(factor))
    }

    /// The largest radius.
    pub fn max(&self) -> Points {
        self.top_left
            .max(self.top_right)
            .max(self.bottom_right)
            .max(self.bottom_left)
    }

    /// Each radius at most half the shorter side of a box of `size`, as
    /// GPUI clamps a quad's.
    pub fn clamp_radii_for_quad_size(self, size: Size<Points>) -> Corners<Points> {
        let max = size.width.min(size.height) / 2.0;
        self.map(|r| r.min(max))
    }
}

impl<T: Mul<S, Output = T> + Clone, S: Clone> Mul<S> for Corners<T> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: S) -> Self {
        Corners {
            top_left: self.top_left * rhs.clone(),
            top_right: self.top_right * rhs.clone(),
            bottom_right: self.bottom_right * rhs.clone(),
            bottom_left: self.bottom_left * rhs,
        }
    }
}

impl<T: IsZero> IsZero for Corners<T> {
    fn is_zero(&self) -> bool {
        self.top_left.is_zero()
            && self.top_right.is_zero()
            && self.bottom_right.is_zero()
            && self.bottom_left.is_zero()
    }
}

impl From<f32> for Corners<Points> {
    fn from(v: f32) -> Self {
        Corners::all(Points(v))
    }
}

impl From<Points> for Corners<Points> {
    fn from(p: Points) -> Self {
        Corners::all(p)
    }
}
