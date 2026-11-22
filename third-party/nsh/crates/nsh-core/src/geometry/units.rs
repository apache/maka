//! The units: [`Points`] (what NSH lays out in), [`DevicePixels`] (at
//! platform boundaries), [`Rems`], [`Percentage`] and [`Radians`].

use std::{
    fmt,
    hash::{Hash, Hasher},
    iter::Sum,
    ops::{Add, AddAssign, Div, DivAssign, Mul, MulAssign, Neg, Sub, SubAssign},
};

use serde::{Deserialize, Serialize};

/// Implements what a unit that wraps one `f32` shares: arithmetic within
/// the unit, scaling by `f32`, a ratio of two values, bitwise equality for
/// `Eq` / `Hash` (as map keys and in hashed declarations), and conversions
/// to and from `f32`.
macro_rules! f32_unit {
    ($unit:ident) => {
        impl Add for $unit {
            type Output = Self;
            #[inline]
            fn add(self, rhs: Self) -> Self {
                Self(self.0 + rhs.0)
            }
        }

        impl Sub for $unit {
            type Output = Self;
            #[inline]
            fn sub(self, rhs: Self) -> Self {
                Self(self.0 - rhs.0)
            }
        }

        impl Neg for $unit {
            type Output = Self;
            #[inline]
            fn neg(self) -> Self {
                Self(-self.0)
            }
        }

        impl AddAssign for $unit {
            #[inline]
            fn add_assign(&mut self, rhs: Self) {
                self.0 += rhs.0;
            }
        }

        impl SubAssign for $unit {
            #[inline]
            fn sub_assign(&mut self, rhs: Self) {
                self.0 -= rhs.0;
            }
        }

        impl Mul<f32> for $unit {
            type Output = Self;
            #[inline]
            fn mul(self, rhs: f32) -> Self {
                Self(self.0 * rhs)
            }
        }

        impl Mul<$unit> for f32 {
            type Output = $unit;
            #[inline]
            fn mul(self, rhs: $unit) -> $unit {
                $unit(self * rhs.0)
            }
        }

        impl MulAssign<f32> for $unit {
            #[inline]
            fn mul_assign(&mut self, rhs: f32) {
                self.0 *= rhs;
            }
        }

        impl Div<f32> for $unit {
            type Output = Self;
            #[inline]
            fn div(self, rhs: f32) -> Self {
                Self(self.0 / rhs)
            }
        }

        impl DivAssign<f32> for $unit {
            #[inline]
            fn div_assign(&mut self, rhs: f32) {
                self.0 /= rhs;
            }
        }

        /// The ratio of two values.
        impl Div for $unit {
            type Output = f32;
            #[inline]
            fn div(self, rhs: Self) -> f32 {
                self.0 / rhs.0
            }
        }

        impl Sum for $unit {
            fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
                Self(iter.map(|v| v.0).sum())
            }
        }

        impl<'a> Sum<&'a $unit> for $unit {
            fn sum<I: Iterator<Item = &'a Self>>(iter: I) -> Self {
                Self(iter.map(|v| v.0).sum())
            }
        }

        // Equal values hash alike: `PartialEq` is `f32`'s, so `-0.0 == 0.0`
        // and NaN differs from itself (frames start as NaN to be sent once
        // set). `Eq` lets the unit sit in hashed declarations and keys, as
        // GPUI's `Pixels` does; NaN never reaches them.
        impl Eq for $unit {}

        impl Hash for $unit {
            fn hash<H: Hasher>(&self, state: &mut H) {
                // `0.0` and `-0.0` are equal, so they hash alike.
                let v = if self.0 == 0.0 { 0.0f32 } else { self.0 };
                v.to_bits().hash(state);
            }
        }

        impl PartialOrd for $unit {
            #[inline]
            fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
                self.0.partial_cmp(&other.0)
            }
        }

        impl From<f32> for $unit {
            #[inline]
            fn from(v: f32) -> Self {
                Self(v)
            }
        }

        impl From<$unit> for f32 {
            #[inline]
            fn from(v: $unit) -> f32 {
                v.0
            }
        }

        impl IsZero for $unit {
            #[inline]
            fn is_zero(&self) -> bool {
                self.0 == 0.0
            }
        }

        impl Half for $unit {
            #[inline]
            fn half(&self) -> Self {
                Self(self.0 / 2.0)
            }
        }

        impl $unit {
            /// Zero.
            pub const ZERO: Self = Self(0.0);

            /// The value as a bare `f32`, for a platform API or an encoder.
            #[inline]
            pub const fn as_f32(self) -> f32 {
                self.0
            }

            /// The absolute value.
            #[inline]
            pub fn abs(self) -> Self {
                Self(self.0.abs())
            }

            /// The smaller of two values.
            #[inline]
            pub fn min(self, other: Self) -> Self {
                Self(self.0.min(other.0))
            }

            /// The larger of two values.
            #[inline]
            pub fn max(self, other: Self) -> Self {
                Self(self.0.max(other.0))
            }

            /// The value within `min..=max`.
            #[inline]
            pub fn clamp(self, min: Self, max: Self) -> Self {
                Self(self.0.clamp(min.0, max.0))
            }

            /// Rounded down.
            #[inline]
            pub fn floor(self) -> Self {
                Self(self.0.floor())
            }

            /// Rounded to the nearest whole value.
            #[inline]
            pub fn round(self) -> Self {
                Self(self.0.round())
            }

            /// Rounded up.
            #[inline]
            pub fn ceil(self) -> Self {
                Self(self.0.ceil())
            }

            /// Whether the value is neither infinite nor NaN.
            #[inline]
            pub fn is_finite(self) -> bool {
                self.0.is_finite()
            }

            /// Whether the value is NaN.
            #[inline]
            pub fn is_nan(self) -> bool {
                self.0.is_nan()
            }
        }
    };
}

/// A value that can be zero.
pub trait IsZero {
    /// Whether the value is zero.
    fn is_zero(&self) -> bool;
}

/// A value that can be halved (the center of a [`Bounds`](super::Bounds)).
pub trait Half {
    /// Half the value.
    fn half(&self) -> Self;
}

impl Half for f32 {
    #[inline]
    fn half(&self) -> Self {
        self / 2.0
    }
}

impl Half for i32 {
    #[inline]
    fn half(&self) -> Self {
        self / 2
    }
}

/// A length in points, the unit NSH lays out in (GPUI's `Pixels`): the
/// platform's density-independent unit (iOS / macOS points, Android dp,
/// CSS `px` on the web, DIPs on Windows). Style strings' `px` and bare
/// numbers are points. Device pixels are [`DevicePixels`] /
/// [`ScaledPixels`], met only where a platform draws or reports them.
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Points(pub f32);

f32_unit!(Points);

impl Points {
    /// In device pixels at `scale_factor` device pixels per point,
    /// rounded to the nearest pixel.
    #[inline]
    pub fn to_device_pixels(self, scale_factor: f32) -> DevicePixels {
        DevicePixels((self.0 * scale_factor).round() as i32)
    }

    /// Scaled by `scale_factor` device pixels per point, unrounded (a
    /// fractional device position).
    #[inline]
    pub fn scale(self, scale_factor: f32) -> ScaledPixels {
        ScaledPixels(self.0 * scale_factor)
    }

    /// In rems of `rem_size`.
    #[inline]
    pub fn to_rems(self, rem_size: Points) -> Rems {
        Rems(self.0 / rem_size.0)
    }
}

impl fmt::Debug for Points {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}pt", self.0)
    }
}

impl fmt::Display for Points {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}pt", self.0)
    }
}

/// `points` points. The name is GPUI's and CSS's: a CSS `px` is a point.
#[inline]
pub const fn px(points: f32) -> Points {
    Points(points)
}

/// The points of one rem in NSH's style strings and Tailwind's default
/// theme (CSS's 16px).
pub const REM_SIZE: Points = Points(16.0);

/// A length in rems: multiples of a root font size (16 points in style
/// strings, [`REM_SIZE`]).
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Rems(pub f32);

f32_unit!(Rems);

impl Rems {
    /// In points, with a rem of `rem_size`.
    #[inline]
    pub fn to_points(self, rem_size: Points) -> Points {
        Points(self.0 * rem_size.0)
    }
}

impl fmt::Debug for Rems {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}rem", self.0)
    }
}

impl fmt::Display for Rems {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}rem", self.0)
    }
}

/// `rems` rems.
#[inline]
pub const fn rems(rems: f32) -> Rems {
    Rems(rems)
}

/// A fraction of a whole: `0.5` is 50%, `1.0` all of it. NSH keeps CSS
/// percentages as fractions everywhere (styles, gradients, transform
/// origins). Values outside `0..=1` are taken (a gradient stop at 150%,
/// a `-50%` translation).
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Percentage(pub f32);

f32_unit!(Percentage);

impl Percentage {
    /// This fraction of `whole`.
    #[inline]
    pub fn of(self, whole: Points) -> Points {
        Points(self.0 * whole.0)
    }
}

impl fmt::Debug for Percentage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}%", self.0 * 100.0)
    }
}

impl fmt::Display for Percentage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}%", self.0 * 100.0)
    }
}

/// `value` as a fraction of a whole (`percentage(0.5)` is 50%).
#[inline]
pub const fn percentage(value: f32) -> Percentage {
    Percentage(value)
}

/// An angle in radians. Which way it turns and where 0 points is the
/// API's that takes it (CSS: 0 points up, clockwise). [`deg`], [`turn`]
/// and [`grad`] make one from CSS's other angle units.
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Radians(pub f32);

f32_unit!(Radians);

impl Radians {
    /// In degrees.
    #[inline]
    pub fn to_degrees(self) -> f32 {
        self.0.to_degrees()
    }

    /// In whole turns.
    #[inline]
    pub fn to_turns(self) -> f32 {
        self.0 / std::f32::consts::TAU
    }

    /// The sine and cosine.
    #[inline]
    pub fn sin_cos(self) -> (f32, f32) {
        self.0.sin_cos()
    }
}

/// A fraction of a full turn (`Radians::from(percentage(0.25))` is a
/// quarter turn), as in GPUI.
impl From<Percentage> for Radians {
    #[inline]
    fn from(value: Percentage) -> Self {
        Radians(value.0 * std::f32::consts::TAU)
    }
}

impl fmt::Debug for Radians {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}rad", self.0)
    }
}

impl fmt::Display for Radians {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}rad", self.0)
    }
}

/// `value` radians.
#[inline]
pub const fn radians(value: f32) -> Radians {
    Radians(value)
}

/// `degrees` degrees, in radians (CSS `deg`).
#[inline]
pub fn deg(degrees: f32) -> Radians {
    Radians(degrees.to_radians())
}

/// `turns` whole turns, in radians (CSS `turn`).
#[inline]
pub fn turn(turns: f32) -> Radians {
    Radians(turns * std::f32::consts::TAU)
}

/// `gradians` gradians, in radians: 400 to a turn (CSS `grad`).
#[inline]
pub fn grad(gradians: f32) -> Radians {
    Radians(gradians * (std::f32::consts::PI / 200.0))
}

/// Physical pixels of a display: what a platform's bitmaps, swap chains
/// and pointer events in pixels count. NSH's own values are [`Points`];
/// conversions happen at the platform boundary, with the surface's scale
/// factor.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(transparent)]
pub struct DevicePixels(pub i32);

impl DevicePixels {
    /// In points at `scale_factor` device pixels per point.
    #[inline]
    pub fn to_points(self, scale_factor: f32) -> Points {
        Points(self.0 as f32 / scale_factor)
    }
}

impl fmt::Debug for DevicePixels {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}px (device)", self.0)
    }
}

impl From<i32> for DevicePixels {
    #[inline]
    fn from(v: i32) -> Self {
        Self(v)
    }
}

impl From<DevicePixels> for i32 {
    #[inline]
    fn from(v: DevicePixels) -> i32 {
        v.0
    }
}

impl Add for DevicePixels {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0)
    }
}

impl Sub for DevicePixels {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0)
    }
}

impl IsZero for DevicePixels {
    #[inline]
    fn is_zero(&self) -> bool {
        self.0 == 0
    }
}

impl Half for DevicePixels {
    #[inline]
    fn half(&self) -> Self {
        Self(self.0 / 2)
    }
}

/// Points scaled to device pixels without rounding: a fractional device
/// position, as a platform draws at ([`Points::scale`]).
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[repr(transparent)]
pub struct ScaledPixels(pub f32);

f32_unit!(ScaledPixels);

impl ScaledPixels {
    /// Rounded to whole device pixels.
    #[inline]
    pub fn to_device_pixels(self) -> DevicePixels {
        DevicePixels(self.0.round() as i32)
    }
}

impl fmt::Debug for ScaledPixels {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}px (scaled)", self.0)
    }
}
