//! The one boundary between NSH's geometry and taffy's: taffy lays out in
//! bare `f32` (points, as NSH gives them) and percentages as fractions,
//! so conversions only wrap or unwrap. Rems resolve at [`REM_SIZE`], the
//! rem of style strings.

use taffy::{Dimension, LengthPercentage, LengthPercentageAuto};

use super::{AbsoluteLength, Bounds, DefiniteLength, Edges, Length, Point, Points, REM_SIZE, Size};

impl From<AbsoluteLength> for LengthPercentage {
    #[inline]
    fn from(l: AbsoluteLength) -> Self {
        LengthPercentage::length(l.to_points(REM_SIZE).0)
    }
}

impl From<DefiniteLength> for LengthPercentage {
    #[inline]
    fn from(l: DefiniteLength) -> Self {
        match l {
            DefiniteLength::Absolute(a) => a.into(),
            DefiniteLength::Fraction(f) => LengthPercentage::percent(f.0),
        }
    }
}

impl From<DefiniteLength> for LengthPercentageAuto {
    #[inline]
    fn from(l: DefiniteLength) -> Self {
        match l {
            DefiniteLength::Absolute(a) => LengthPercentageAuto::length(a.to_points(REM_SIZE).0),
            DefiniteLength::Fraction(f) => LengthPercentageAuto::percent(f.0),
        }
    }
}

impl From<Length> for LengthPercentageAuto {
    #[inline]
    fn from(l: Length) -> Self {
        match l {
            Length::Definite(d) => d.into(),
            Length::Auto => LengthPercentageAuto::auto(),
        }
    }
}

impl From<DefiniteLength> for Dimension {
    #[inline]
    fn from(l: DefiniteLength) -> Self {
        match l {
            DefiniteLength::Absolute(a) => Dimension::length(a.to_points(REM_SIZE).0),
            DefiniteLength::Fraction(f) => Dimension::percent(f.0),
        }
    }
}

impl From<Length> for Dimension {
    #[inline]
    fn from(l: Length) -> Self {
        match l {
            Length::Definite(d) => d.into(),
            Length::Auto => Dimension::auto(),
        }
    }
}

impl From<taffy::Size<f32>> for Size<Points> {
    #[inline]
    fn from(s: taffy::Size<f32>) -> Self {
        Size::new(Points(s.width), Points(s.height))
    }
}

impl From<Size<Points>> for taffy::Size<f32> {
    #[inline]
    fn from(s: Size<Points>) -> Self {
        taffy::Size {
            width: s.width.0,
            height: s.height.0,
        }
    }
}

impl From<taffy::Point<f32>> for Point<Points> {
    #[inline]
    fn from(p: taffy::Point<f32>) -> Self {
        Point::new(Points(p.x), Points(p.y))
    }
}

impl From<taffy::Rect<f32>> for Edges<Points> {
    #[inline]
    fn from(r: taffy::Rect<f32>) -> Self {
        Edges {
            top: Points(r.top),
            right: Points(r.right),
            bottom: Points(r.bottom),
            left: Points(r.left),
        }
    }
}

/// A laid out node's border box relative to its parent.
impl From<&taffy::Layout> for Bounds<Points> {
    #[inline]
    fn from(l: &taffy::Layout) -> Self {
        Bounds::new(l.location.into(), l.size.into())
    }
}

impl From<Size<Length>> for taffy::Size<Dimension> {
    #[inline]
    fn from(s: Size<Length>) -> Self {
        taffy::Size {
            width: s.width.into(),
            height: s.height.into(),
        }
    }
}

impl From<Size<DefiniteLength>> for taffy::Size<LengthPercentage> {
    #[inline]
    fn from(s: Size<DefiniteLength>) -> Self {
        taffy::Size {
            width: s.width.into(),
            height: s.height.into(),
        }
    }
}

impl From<Edges<DefiniteLength>> for taffy::Rect<LengthPercentage> {
    #[inline]
    fn from(e: Edges<DefiniteLength>) -> Self {
        taffy::Rect {
            top: e.top.into(),
            right: e.right.into(),
            bottom: e.bottom.into(),
            left: e.left.into(),
        }
    }
}

impl From<Edges<Length>> for taffy::Rect<LengthPercentageAuto> {
    #[inline]
    fn from(e: Edges<Length>) -> Self {
        taffy::Rect {
            top: e.top.into(),
            right: e.right.into(),
            bottom: e.bottom.into(),
            left: e.left.into(),
        }
    }
}
