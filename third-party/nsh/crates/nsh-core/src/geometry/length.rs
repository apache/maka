//! Lengths as styles give them, from the most to the least resolved:
//! [`AbsoluteLength`] (points or rems), [`DefiniteLength`] (also a
//! fraction of a reference length) and [`Length`] (also `auto`). Each
//! resolves with what it needs: the rem size, the reference length.

use std::fmt;

use super::{
    Edges, Size,
    shapes::Corners,
    units::{IsZero, Percentage, Points, Rems},
};

/// A length known without layout: points, or rems of a root font size.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum AbsoluteLength {
    /// Points.
    Points(Points),
    /// Rems.
    Rems(Rems),
}

impl AbsoluteLength {
    /// In points, with a rem of `rem_size`.
    #[inline]
    pub fn to_points(self, rem_size: Points) -> Points {
        match self {
            AbsoluteLength::Points(p) => p,
            AbsoluteLength::Rems(r) => r.to_points(rem_size),
        }
    }
}

impl Default for AbsoluteLength {
    fn default() -> Self {
        AbsoluteLength::Points(Points::ZERO)
    }
}

impl IsZero for AbsoluteLength {
    fn is_zero(&self) -> bool {
        match self {
            AbsoluteLength::Points(p) => p.is_zero(),
            AbsoluteLength::Rems(r) => r.is_zero(),
        }
    }
}

impl From<Points> for AbsoluteLength {
    #[inline]
    fn from(p: Points) -> Self {
        AbsoluteLength::Points(p)
    }
}

impl From<Rems> for AbsoluteLength {
    #[inline]
    fn from(r: Rems) -> Self {
        AbsoluteLength::Rems(r)
    }
}

impl fmt::Debug for AbsoluteLength {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AbsoluteLength::Points(p) => fmt::Debug::fmt(p, f),
            AbsoluteLength::Rems(r) => fmt::Debug::fmt(r, f),
        }
    }
}

/// A length that is not `auto`: absolute, or a fraction of a reference
/// length (the parent's size for a box, the gradient line for a color
/// stop).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum DefiniteLength {
    /// Points or rems.
    Absolute(AbsoluteLength),
    /// A fraction of the reference length (`0.5` is 50%).
    Fraction(Percentage),
}

impl DefiniteLength {
    /// In points: a fraction of `base_size`, rems of `rem_size`.
    #[inline]
    pub fn to_points(self, base_size: AbsoluteLength, rem_size: Points) -> Points {
        match self {
            DefiniteLength::Absolute(a) => a.to_points(rem_size),
            DefiniteLength::Fraction(f) => f.of(base_size.to_points(rem_size)),
        }
    }

    /// Whether the length is absolute (it does not depend on a reference).
    #[inline]
    pub fn is_absolute(self) -> bool {
        matches!(self, DefiniteLength::Absolute(_))
    }
}

impl Default for DefiniteLength {
    fn default() -> Self {
        DefiniteLength::Absolute(AbsoluteLength::default())
    }
}

impl IsZero for DefiniteLength {
    fn is_zero(&self) -> bool {
        match self {
            DefiniteLength::Absolute(a) => a.is_zero(),
            DefiniteLength::Fraction(f) => f.is_zero(),
        }
    }
}

impl From<Points> for DefiniteLength {
    #[inline]
    fn from(p: Points) -> Self {
        DefiniteLength::Absolute(p.into())
    }
}

impl From<Rems> for DefiniteLength {
    #[inline]
    fn from(r: Rems) -> Self {
        DefiniteLength::Absolute(r.into())
    }
}

impl From<AbsoluteLength> for DefiniteLength {
    #[inline]
    fn from(a: AbsoluteLength) -> Self {
        DefiniteLength::Absolute(a)
    }
}

impl From<Percentage> for DefiniteLength {
    #[inline]
    fn from(f: Percentage) -> Self {
        DefiniteLength::Fraction(f)
    }
}

impl fmt::Debug for DefiniteLength {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DefiniteLength::Absolute(a) => fmt::Debug::fmt(a, f),
            DefiniteLength::Fraction(fr) => fmt::Debug::fmt(fr, f),
        }
    }
}

/// A length a style gives a box: definite, or `auto` (sized by layout).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Length {
    /// Points, rems or a fraction of the parent.
    Definite(DefiniteLength),
    /// Sized by layout.
    #[default]
    Auto,
}

impl Length {
    /// In points against `base_size` and `rem_size`; `None` for `auto`.
    #[inline]
    pub fn to_points(self, base_size: AbsoluteLength, rem_size: Points) -> Option<Points> {
        match self {
            Length::Definite(d) => Some(d.to_points(base_size, rem_size)),
            Length::Auto => None,
        }
    }
}

impl IsZero for Length {
    fn is_zero(&self) -> bool {
        match self {
            Length::Definite(d) => d.is_zero(),
            Length::Auto => false,
        }
    }
}

impl From<Points> for Length {
    #[inline]
    fn from(p: Points) -> Self {
        Length::Definite(p.into())
    }
}

impl From<Rems> for Length {
    #[inline]
    fn from(r: Rems) -> Self {
        Length::Definite(r.into())
    }
}

impl From<AbsoluteLength> for Length {
    #[inline]
    fn from(a: AbsoluteLength) -> Self {
        Length::Definite(a.into())
    }
}

impl From<Percentage> for Length {
    #[inline]
    fn from(f: Percentage) -> Self {
        Length::Definite(f.into())
    }
}

impl From<DefiniteLength> for Length {
    #[inline]
    fn from(d: DefiniteLength) -> Self {
        Length::Definite(d)
    }
}

impl fmt::Debug for Length {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Length::Definite(d) => fmt::Debug::fmt(d, f),
            Length::Auto => f.write_str("auto"),
        }
    }
}

/// `fraction` of the reference length, the parent's size for a box
/// (`relative(0.5)` is 50%).
#[inline]
pub const fn relative(fraction: f32) -> DefiniteLength {
    DefiniteLength::Fraction(Percentage(fraction))
}

/// `auto`: sized by layout.
#[inline]
pub const fn auto() -> Length {
    Length::Auto
}

impl Size<Length> {
    /// Both dimensions `auto`.
    pub fn auto() -> Self {
        Size::new(Length::Auto, Length::Auto)
    }

    /// The whole of the parent in both dimensions.
    pub fn full() -> Self {
        Size::new(relative(1.0).into(), relative(1.0).into())
    }
}

impl Edges<Length> {
    /// `auto` on every edge.
    pub fn auto() -> Self {
        Edges::all(Length::Auto)
    }

    /// Zero on every edge.
    pub fn zero() -> Self {
        Edges::all(Points::ZERO.into())
    }
}

impl Edges<DefiniteLength> {
    /// Zero on every edge.
    pub fn zero() -> Self {
        Edges::all(Points::ZERO.into())
    }

    /// In points: fractions of `parent_size` along each edge's axis (the
    /// height for the top and bottom edges, as GPUI resolves them; CSS
    /// resolves a padding's percentages against the width on every edge,
    /// which a `parent_size` of the width twice gives), rems of
    /// `rem_size`.
    pub fn to_points(self, parent_size: Size<AbsoluteLength>, rem_size: Points) -> Edges<Points> {
        Edges {
            top: self.top.to_points(parent_size.height, rem_size),
            right: self.right.to_points(parent_size.width, rem_size),
            bottom: self.bottom.to_points(parent_size.height, rem_size),
            left: self.left.to_points(parent_size.width, rem_size),
        }
    }
}

impl Edges<AbsoluteLength> {
    /// Zero on every edge.
    pub fn zero() -> Self {
        Edges::all(Points::ZERO.into())
    }

    /// In points, with a rem of `rem_size`.
    pub fn to_points(self, rem_size: Points) -> Edges<Points> {
        self.map(|l| l.to_points(rem_size))
    }
}

impl Corners<AbsoluteLength> {
    /// In points, with a rem of `rem_size`.
    pub fn to_points(self, rem_size: Points) -> Corners<Points> {
        self.map(|l| l.to_points(rem_size))
    }
}
