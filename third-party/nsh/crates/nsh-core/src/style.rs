use std::sync::Arc;

use taffy::{
    AlignContent, AlignItems, Dimension, Display, FlexDirection, FlexWrap, LengthPercentage,
    LengthPercentageAuto, Position,
};

use crate::{
    css,
    effects::{
        BackdropMaterial, BlendMode, BoxShadow, Cursor, Effects, Filter, GlassEffect, Gradient,
        KeyframeAnimation, Keyframes, Outline, Transition, TransitionProps,
    },
    element::PropEnum,
    geometry::{
        AbsoluteLength, Corners, DefiniteLength, Edges, Percentage, Point, Points, REM_SIZE, Size,
        percentage, point, px,
    },
    grid,
    transform::{Transform, TransformKind},
};

/// An sRGB color packed as `0xRRGGBBAA`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Color(pub u32);

impl Color {
    /// Fully transparent.
    pub const TRANSPARENT: Color = Color(0);
    /// Opaque black.
    pub const BLACK: Color = Color(0x0000_00ff);

    /// Creates a color from 8-bit components.
    #[inline]
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
        Color((r as u32) << 24 | (g as u32) << 16 | (b as u32) << 8 | a as u32)
    }

    /// Returns `(r, g, b, a)` in `0.0..=1.0`.
    #[inline]
    pub fn to_f64(self) -> (f64, f64, f64, f64) {
        let c = self.0;
        (
            (c >> 24) as f64 / 255.0,
            ((c >> 16) & 0xff) as f64 / 255.0,
            ((c >> 8) & 0xff) as f64 / 255.0,
            (c & 0xff) as f64 / 255.0,
        )
    }

    /// Returns true if the alpha component is zero.
    #[inline]
    pub const fn is_transparent(self) -> bool {
        self.0 & 0xff == 0
    }

    /// Parses a CSS color: hex, `rgb()` / `rgba()`, `hsl()` / `hsla()`,
    /// `oklch()`, `oklab()` or a CSS named color.
    pub fn parse(s: &str) -> Option<Color> {
        crate::css::color(s)
    }
}

/// Horizontal alignment of a text block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextAlign {
    /// Natural alignment for the writing direction.
    #[default]
    Auto,
    /// Left aligned.
    Left,
    /// Centered.
    Center,
    /// Right aligned.
    Right,
    /// Justified.
    Justify,
}

/// `verticalAlign`: where an element inside a `<Text>` (an inline
/// attachment) sits in its line, as CSS's `vertical-align` places a
/// replaced inline box. The font it is measured against is the text's
/// around the attachment; the line grows to hold the attachment wherever
/// it reaches past that font (`TextAttachment::extent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum VerticalAlign {
    /// `baseline`: its bottom on the baseline.
    #[default]
    Baseline,
    /// `text-top`: its top at the top of the font (its ascent).
    TextTop,
    /// `text-bottom`: its bottom at the bottom of the font (its descent).
    TextBottom,
    /// `middle`: its middle half the font's x height above the baseline.
    Middle,
}

impl VerticalAlign {
    /// The value named by CSS keyword `name`.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "baseline" => Self::Baseline,
            "text-top" => Self::TextTop,
            "text-bottom" => Self::TextBottom,
            "middle" => Self::Middle,
            _ => return None,
        })
    }
}

/// A font family name, interned: copying and comparing one is free, so
/// resolved text styles stay `Copy` and cheap to hash.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct FontFamily(u32);

static FAMILIES: std::sync::Mutex<Vec<std::sync::Arc<str>>> = std::sync::Mutex::new(Vec::new());

impl FontFamily {
    /// Interns `name`. Apps use a handful of families, so the table is a
    /// small vector scanned linearly.
    pub fn new(name: &str) -> FontFamily {
        let mut families = FAMILIES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = families.iter().position(|f| &**f == name) {
            return FontFamily(i as u32);
        }
        families.push(name.into());
        FontFamily(families.len() as u32 - 1)
    }

    /// The family name.
    pub fn name(self) -> std::sync::Arc<str> {
        FAMILIES.lock().unwrap_or_else(|e| e.into_inner())[self.0 as usize].clone()
    }
}

impl std::fmt::Debug for FontFamily {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FontFamily({:?})", self.name())
    }
}

/// Lines drawn through or under text (`textDecorationLine`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct TextDecoration {
    /// Underline.
    pub underline: bool,
    /// Strikethrough.
    pub line_through: bool,
}

impl TextDecoration {
    /// True if no line is drawn.
    #[inline]
    pub const fn is_none(self) -> bool {
        !self.underline && !self.line_through
    }
}

/// How decoration lines are drawn (`textDecorationStyle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum DecorationStyle {
    /// One solid line (default).
    #[default]
    Solid,
    /// Two lines.
    Double,
    /// Dots.
    Dotted,
    /// Dashes.
    Dashed,
    /// A wavy line.
    Wavy,
}

/// Case changes applied to text (`textTransform`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum TextTransform {
    /// As written.
    #[default]
    None,
    /// UPPER CASE.
    Uppercase,
    /// lower case.
    Lowercase,
    /// First Letter Of Each Word.
    Capitalize,
}

impl TextTransform {
    /// Applies the transform to `s`.
    pub fn apply<'a>(self, s: &'a str) -> std::borrow::Cow<'a, str> {
        match self {
            TextTransform::None => s.into(),
            TextTransform::Uppercase => s.to_uppercase().into(),
            TextTransform::Lowercase => s.to_lowercase().into(),
            TextTransform::Capitalize => {
                let mut out = String::with_capacity(s.len());
                let mut start = true;
                for c in s.chars() {
                    if start && c.is_alphanumeric() {
                        out.extend(c.to_uppercase());
                        start = false;
                    } else {
                        out.push(c);
                        start |= c.is_whitespace();
                    }
                }
                out.into()
            }
        }
    }
}

/// Where text that does not fit `numberOfLines` is cut (`ellipsizeMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum EllipsizeMode {
    /// "Lorem ips…" (default).
    #[default]
    Tail,
    /// "…sum dolor".
    Head,
    /// "Lorem…dolor".
    Middle,
    /// Cut without an ellipsis.
    Clip,
}

/// The corner radii of a view, clockwise from the top left: a
/// [`Corners<Points>`] with the curve they are drawn with.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CornerRadii {
    /// Top left.
    pub top_left: Points,
    /// Top right.
    pub top_right: Points,
    /// Bottom right.
    pub bottom_right: Points,
    /// Bottom left.
    pub bottom_left: Points,
    /// `borderCurve: "continuous"`: corners whose curvature grows from the
    /// edges (iOS app icons) instead of circular arcs; see [`crate::shape`].
    pub continuous: bool,
}

impl CornerRadii {
    /// The same circular radius on every corner.
    pub const fn all(r: Points) -> Self {
        Self {
            top_left: r,
            top_right: r,
            bottom_right: r,
            bottom_left: r,
            continuous: false,
        }
    }

    /// Circular corners with these radii.
    pub const fn circular(corners: Corners<Points>) -> Self {
        Self {
            top_left: corners.top_left,
            top_right: corners.top_right,
            bottom_right: corners.bottom_right,
            bottom_left: corners.bottom_left,
            continuous: false,
        }
    }

    /// The radii, without the curve.
    #[inline]
    pub const fn corners(self) -> Corners<Points> {
        Corners {
            top_left: self.top_left,
            top_right: self.top_right,
            bottom_right: self.bottom_right,
            bottom_left: self.bottom_left,
        }
    }

    /// `[top_left, top_right, bottom_right, bottom_left]`.
    #[inline]
    pub const fn to_array(self) -> [Points; 4] {
        [
            self.top_left,
            self.top_right,
            self.bottom_right,
            self.bottom_left,
        ]
    }

    /// True if no corner is rounded.
    #[inline]
    pub fn is_zero(&self) -> bool {
        self.to_array().iter().all(|&r| r <= Points::ZERO)
    }

    /// The radius shared by every rounded corner, if they all share one.
    /// Platforms render such shapes with a single radius plus a mask of
    /// the rounded corners (no paths).
    pub fn shared(&self) -> Option<Points> {
        let mut shared = Points::ZERO;
        for r in self.to_array() {
            if r > Points::ZERO {
                if shared > Points::ZERO && r != shared {
                    return None;
                }
                shared = r;
            }
        }
        Some(shared)
    }

    /// Scales the radii down so adjacent corners do not overlap on a box
    /// of `size` (CSS rule).
    pub fn fit(self, size: Size<Points>) -> Self {
        let ratio = |side: Points, a: Points, b: Points| {
            if a + b > side { side / (a + b) } else { 1.0 }
        };
        let (width, height) = (size.width, size.height);
        let f = ratio(width, self.top_left, self.top_right)
            .min(ratio(width, self.bottom_left, self.bottom_right))
            .min(ratio(height, self.top_left, self.bottom_left))
            .min(ratio(height, self.top_right, self.bottom_right))
            .max(0.0);
        if f >= 1.0 {
            return self;
        }
        Self {
            top_left: self.top_left * f,
            top_right: self.top_right * f,
            bottom_right: self.bottom_right * f,
            bottom_left: self.bottom_left * f,
            ..self
        }
    }

    /// The radii of a curve `d` inside this one (e.g. the inner edge of a
    /// border).
    pub fn inset(self, d: Points) -> Self {
        Self {
            top_left: (self.top_left - d).max(Points::ZERO),
            top_right: (self.top_right - d).max(Points::ZERO),
            bottom_right: (self.bottom_right - d).max(Points::ZERO),
            bottom_left: (self.bottom_left - d).max(Points::ZERO),
            ..self
        }
    }
}

impl From<CornerRadii> for Corners<Points> {
    fn from(radii: CornerRadii) -> Self {
        radii.corners()
    }
}

/// A drop shadow (React Native's `shadow*` properties).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shadow {
    /// Shadow color; its alpha is multiplied by `opacity`.
    pub color: Color,
    /// Horizontal offset.
    pub offset_x: Points,
    /// Vertical offset.
    pub offset_y: Points,
    /// Opacity in `0.0..=1.0`; 0 (the default) means no shadow.
    pub opacity: f32,
    /// Blur radius.
    pub radius: Points,
}

impl Shadow {
    /// React Native's defaults: black, offset `(0, -3)`, radius 3, opacity 0.
    pub const DEFAULT: Shadow = Shadow {
        color: Color::BLACK,
        offset_x: Points(0.0),
        offset_y: Points(-3.0),
        opacity: 0.0,
        radius: Points(3.0),
    };

    /// True if the shadow draws anything.
    #[inline]
    pub fn is_visible(&self) -> bool {
        self.opacity > 0.0 && !self.color.is_transparent()
    }
}

impl Default for Shadow {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// How borders are drawn (`borderStyle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BorderStyle {
    /// A solid line (default).
    #[default]
    Solid,
    /// Dashes.
    Dashed,
    /// Dots.
    Dotted,
}

/// Border widths and colors, per side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Borders {
    /// Widths.
    pub widths: Edges<Points>,
    /// Colors: top, right, bottom, left.
    pub colors: [Color; 4],
    /// Line style.
    pub style: BorderStyle,
}

impl Borders {
    /// No border.
    pub const NONE: Borders = Borders {
        widths: Edges {
            top: Points::ZERO,
            right: Points::ZERO,
            bottom: Points::ZERO,
            left: Points::ZERO,
        },
        colors: [Color::BLACK; 4],
        style: BorderStyle::Solid,
    };

    /// True if some side draws something.
    pub fn is_visible(&self) -> bool {
        let widths = self.widths.to_array();
        (0..4).any(|i| widths[i] > Points::ZERO && !self.colors[i].is_transparent())
    }

    /// `(width, color)` when every side is the same.
    pub fn uniform(&self) -> Option<(Points, Color)> {
        let widths = self.widths.to_array();
        let [w, ..] = widths;
        let [c, ..] = self.colors;
        (widths.iter().all(|&x| x == w) && self.colors.iter().all(|&x| x == c)).then_some((w, c))
    }

    /// The width of side `side`: 0 top, 1 right, 2 bottom, 3 left (the
    /// order of `colors`).
    pub fn width(&self, side: usize) -> Points {
        match side {
            0 => self.widths.top,
            1 => self.widths.right,
            2 => self.widths.bottom,
            _ => self.widths.left,
        }
    }

    fn width_mut(&mut self, side: usize) -> &mut Points {
        match side {
            0 => &mut self.widths.top,
            1 => &mut self.widths.right,
            2 => &mut self.widths.bottom,
            _ => &mut self.widths.left,
        }
    }
}

impl Default for Borders {
    fn default() -> Self {
        Self::NONE
    }
}

/// Visual (non-layout) properties of a native view.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewStyle {
    /// Background fill.
    pub background_color: Color,
    /// `borderRadius`: the radius of corners without their own.
    pub border_radius: Points,
    /// `borderTopLeftRadius` etc.; they override `border_radius`.
    pub corner_radius: Corners<Option<Points>>,
    /// `borderCurve: "continuous"`.
    pub continuous_corners: bool,
    /// Borders (their widths also affect layout).
    pub borders: Borders,
    /// Opacity in `0.0..=1.0`.
    pub opacity: f32,
    /// Clip children to the (rounded) bounds.
    pub overflow_hidden: bool,
    /// Drop shadow.
    pub shadow: Shadow,
    /// Static transform, around the view's center.
    pub transform: Transform,
    /// `tintColor`: recolors an image's opaque pixels.
    pub tint_color: Option<Color>,
    /// Android's material shadow: the node's `android={{ elevation }}` prop,
    /// not a style.
    pub elevation: Points,
    /// `transformOrigin`: the point transforms act around.
    pub transform_origin: TransformOrigin,
    /// `objectPosition`: where an image sits in its box (image views; the
    /// platforms take it from [`crate::mount::ImageOptions::position`]).
    pub object_position: ObjectPosition,
    /// `backfaceVisibility: "hidden"`: invisible when turned away.
    pub backface_hidden: bool,
    /// Layered / inset shadows, gradients and filters.
    pub effects: Option<Arc<Effects>>,
    /// `mixBlendMode`.
    pub blend_mode: BlendMode,
    /// The iOS material from `ios={{ backdropMaterial }}`, projected at mount time.
    pub backdrop_material: BackdropMaterial,
    /// `glassEffect`.
    pub glass_effect: GlassEffect,
    /// `outline*`.
    pub outline: Outline,
    /// `visibility: "hidden"`: not drawn and not touchable, still laid out.
    pub hidden: bool,
    /// `cursor`.
    pub cursor: Cursor,
    /// `transition*`: style changes animate.
    pub transition: Option<Transition>,
    /// `animation*`: a keyframe animation runs.
    pub animation: Option<KeyframeAnimation>,
}

/// `transformOrigin`: the point transforms rotate and scale around.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransformOrigin {
    /// Horizontal position: from the left edge, or a fraction of the width.
    pub x: DefiniteLength,
    /// Vertical position: from the top edge, or a fraction of the height.
    pub y: DefiniteLength,
    /// Depth.
    pub z: Points,
}

impl Default for TransformOrigin {
    fn default() -> Self {
        Self::CENTER
    }
}

impl TransformOrigin {
    /// The center (the default).
    pub const CENTER: Self = Self {
        x: DefiniteLength::Fraction(Percentage(0.5)),
        y: DefiniteLength::Fraction(Percentage(0.5)),
        z: Points::ZERO,
    };

    /// Offset of the origin from the center of a box of `size`, in the
    /// plane, and its depth.
    pub fn offset(&self, size: Size<Points>) -> (Point<Points>, Points) {
        let at = |len: DefiniteLength, side: Points| {
            len.to_points(AbsoluteLength::Points(side), REM_SIZE) - side / 2.0
        };
        (
            point(at(self.x, size.width), at(self.y, size.height)),
            self.z,
        )
    }

    /// Parses CSS's syntax: one to three of keywords (`left`, `center`,
    /// `right`, `top`, `bottom`), percentages and lengths (`10px` or a
    /// bare number), the third being a depth.
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.split_whitespace().collect();
        if parts.is_empty() || parts.len() > 3 {
            return None;
        }
        let fraction = |f: f32| DefiniteLength::Fraction(percentage(f));
        let len = |p: &str| -> Option<DefiniteLength> {
            if let Some(pct) = p.strip_suffix('%') {
                return pct.trim().parse::<f32>().ok().map(|v| fraction(v / 100.0));
            }
            p.strip_suffix("px")
                .unwrap_or(p)
                .parse::<f32>()
                .ok()
                .map(|v| px(v).into())
        };
        let mut x = None;
        let mut y = None;
        let mut free = Vec::new();
        for &p in parts.iter().take(2) {
            match p {
                "left" => x = Some(fraction(0.0)),
                "right" => x = Some(fraction(1.0)),
                "top" => y = Some(fraction(0.0)),
                "bottom" => y = Some(fraction(1.0)),
                "center" => free.push(fraction(0.5)),
                p => free.push(len(p)?),
            }
        }
        // Unnamed values fill x, then y.
        for v in free {
            if x.is_none() {
                x = Some(v);
            } else if y.is_none() {
                y = Some(v);
            } else {
                return None;
            }
        }
        let z = match parts.get(2) {
            Some(p) => px(p.strip_suffix("px").unwrap_or(p).parse::<f32>().ok()?),
            None => Points::ZERO,
        };
        Some(Self {
            x: x.unwrap_or(fraction(0.5)),
            y: y.unwrap_or(fraction(0.5)),
            z,
        })
    }
}

/// One axis of a CSS `<position>`: a distance from the start edge (left,
/// top) or the end edge (right, bottom). Percentages are fractions of the
/// free space: the box's size less the content's (negative when the
/// content overflows), as CSS's `object-position` resolves them.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct PositionAxis {
    /// Measured from the end edge (right, bottom) instead of the start.
    pub from_end: bool,
    /// The distance from that edge.
    pub offset: DefiniteLength,
}

impl Default for PositionAxis {
    /// The center.
    fn default() -> Self {
        Self::CENTER
    }
}

impl PositionAxis {
    /// The start edge (`left`, `top`, `0%`).
    pub const START: Self = Self::start(DefiniteLength::Fraction(Percentage(0.0)));
    /// The center (`center`, `50%`).
    pub const CENTER: Self = Self::start(DefiniteLength::Fraction(Percentage(0.5)));
    /// The end edge (`right`, `bottom`, `100%`).
    pub const END: Self = Self::start(DefiniteLength::Fraction(Percentage(1.0)));

    /// `offset` from the start edge.
    pub const fn start(offset: DefiniteLength) -> Self {
        Self {
            from_end: false,
            offset,
        }
    }

    /// `offset` from the end edge.
    pub const fn end(offset: DefiniteLength) -> Self {
        Self {
            from_end: true,
            offset,
        }
    }

    /// Where content starts along this axis, from the box's start edge,
    /// given the `free` space (the box's size less the content's).
    pub fn resolve(&self, free: Points) -> Points {
        let d = self
            .offset
            .to_points(AbsoluteLength::Points(free), REM_SIZE);
        if self.from_end { free - d } else { d }
    }
}

/// `objectPosition`: where an image sits in its box once
/// `resizeMode` / `object-fit` has sized it, as CSS's `object-position`
/// places it (the center by default). The parts of a covering image
/// outside the box are cropped.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct ObjectPosition {
    /// Horizontal.
    pub x: PositionAxis,
    /// Vertical.
    pub y: PositionAxis,
}

impl ObjectPosition {
    /// The center (the default).
    pub const CENTER: Self = Self {
        x: PositionAxis::CENTER,
        y: PositionAxis::CENTER,
    };

    /// A position of two axes.
    pub const fn new(x: PositionAxis, y: PositionAxis) -> Self {
        Self { x, y }
    }

    /// Parses CSS's `<position>` as `object-position` takes it: one or two
    /// keywords, percentages or lengths (`top`, `left bottom`, `25% 75%`,
    /// `10px 0`), or edges with offsets (`right 10px bottom 20%`).
    pub fn parse(s: &str) -> Option<Self> {
        css::object_position(s)
    }

    /// The top left corner of content of `content` size placed in a box of
    /// `size`.
    pub fn place(&self, size: Size<Points>, content: Size<Points>) -> Point<Points> {
        point(
            self.x.resolve(size.width - content.width),
            self.y.resolve(size.height - content.height),
        )
    }
}

impl std::fmt::Display for ObjectPosition {
    /// CSS's four-value form (`left 50% top 10px`), which every position
    /// can be written in.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let length = |l: DefiniteLength| match l {
            DefiniteLength::Absolute(a) => format!("{}px", a.to_points(REM_SIZE).0),
            DefiniteLength::Fraction(p) => format!("{}%", p.0 * 100.0),
        };
        write!(
            f,
            "{} {} {} {}",
            if self.x.from_end { "right" } else { "left" },
            length(self.x.offset),
            if self.y.from_end { "bottom" } else { "top" },
            length(self.y.offset),
        )
    }
}

/// `fontVariant`: OpenType features, as bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct FontVariant(pub u8);

impl FontVariant {
    /// `small-caps`.
    pub const SMALL_CAPS: u8 = 1;
    /// `oldstyle-nums`.
    pub const OLDSTYLE_NUMS: u8 = 2;
    /// `lining-nums`.
    pub const LINING_NUMS: u8 = 4;
    /// `tabular-nums`.
    pub const TABULAR_NUMS: u8 = 8;
    /// `proportional-nums`.
    pub const PROPORTIONAL_NUMS: u8 = 16;

    /// Parses space-separated variant names.
    pub fn parse(s: &str) -> Option<Self> {
        let mut bits = 0;
        for word in s.split_whitespace() {
            bits |= match word {
                "small-caps" => Self::SMALL_CAPS,
                "oldstyle-nums" => Self::OLDSTYLE_NUMS,
                "lining-nums" => Self::LINING_NUMS,
                "tabular-nums" => Self::TABULAR_NUMS,
                "proportional-nums" => Self::PROPORTIONAL_NUMS,
                "normal" => 0,
                _ => return None,
            };
        }
        Some(Self(bits))
    }

    /// Whether `bit` is set.
    pub fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }

    /// The OpenType feature tags.
    pub fn tags(self) -> impl Iterator<Item = &'static str> {
        [
            (Self::SMALL_CAPS, "smcp"),
            (Self::OLDSTYLE_NUMS, "onum"),
            (Self::LINING_NUMS, "lnum"),
            (Self::TABULAR_NUMS, "tnum"),
            (Self::PROPORTIONAL_NUMS, "pnum"),
        ]
        .into_iter()
        .filter(move |&(bit, _)| self.has(bit))
        .map(|(_, tag)| tag)
    }
}

impl ViewStyle {
    /// Drops the gradient backgrounds, so the background color shows: what
    /// press feedback and animated background colors do (a gradient is
    /// drawn over the color and would hide them).
    pub(crate) fn clear_background_images(&mut self) {
        if let Some(e) = self
            .effects
            .as_deref()
            .filter(|e| !e.background_images.is_empty())
        {
            let mut effects = e.clone();
            effects.background_images.clear();
            self.effects = crate::effects::shared(effects);
        }
    }

    /// The radius of each corner (before fitting them to a size with
    /// [`CornerRadii::fit`]).
    pub fn radii(&self) -> CornerRadii {
        let radii = self
            .corner_radius
            .map(|r| r.unwrap_or(self.border_radius).max(Points::ZERO));
        CornerRadii {
            continuous: self.continuous_corners,
            ..CornerRadii::circular(radii)
        }
    }
}

impl Default for ViewStyle {
    fn default() -> Self {
        Self {
            background_color: Color::TRANSPARENT,
            border_radius: Points::ZERO,
            corner_radius: Corners {
                top_left: None,
                top_right: None,
                bottom_right: None,
                bottom_left: None,
            },
            continuous_corners: false,
            borders: Borders::NONE,
            opacity: 1.0,
            overflow_hidden: false,
            shadow: Shadow::DEFAULT,
            transform: Transform::IDENTITY,
            tint_color: None,
            elevation: Points::ZERO,
            transform_origin: TransformOrigin::CENTER,
            object_position: ObjectPosition::CENTER,
            backface_hidden: false,
            effects: None,
            blend_mode: BlendMode::Normal,
            backdrop_material: BackdropMaterial::UltraThin,
            glass_effect: GlassEffect::None,
            outline: Outline::NONE,
            hidden: false,
            cursor: Cursor::Auto,
            transition: None,
            animation: None,
        }
    }
}

/// A shadow behind text (`textShadow*`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextShadow {
    /// Color.
    pub color: Color,
    /// Horizontal offset.
    pub offset_x: Points,
    /// Vertical offset.
    pub offset_y: Points,
    /// Blur radius.
    pub radius: Points,
}

/// Text properties as written on a node; unset values are inherited from
/// the enclosing text.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TextStyle {
    /// Foreground color.
    pub color: Option<Color>,
    /// Font size.
    pub font_size: Option<Points>,
    /// Font weight, `100..=900`.
    pub font_weight: Option<u16>,
    /// Line height.
    pub line_height: Option<Points>,
    /// Block alignment (only meaningful on a text block).
    pub text_align: Option<TextAlign>,
    /// Physical class alignment, preserved across direction changes in descendants.
    pub text_align_physical: bool,
    /// Font family; `None` inherits (the system font at the root).
    pub font_family: Option<FontFamily>,
    /// Italic (`fontStyle`).
    pub italic: Option<bool>,
    /// Extra space between characters.
    pub letter_spacing: Option<Points>,
    /// Extra space between characters in ems of this node's font size
    /// (`"0.05em"`); overrides `letter_spacing` when set after it.
    pub letter_spacing_em: Option<f32>,
    /// A line-height length relative to this node's font size (`em` or
    /// a percentage), resolved before inheritance.
    pub line_height_em: Option<f32>,
    /// Line height as a multiple of the font size (`"1.5"`),
    /// inherited as a multiple.
    pub line_height_multiple: Option<f32>,
    /// Underline / strikethrough.
    pub decoration: Option<TextDecoration>,
    /// `textDecorationStyle`.
    pub decoration_style: Option<DecorationStyle>,
    /// `textDecorationThickness`.
    pub decoration_thickness: Option<Points>,
    /// `textUnderlineOffset`: below the baseline.
    pub underline_offset: Option<Points>,
    /// Color of the decoration lines; the text color by default.
    pub decoration_color: Option<Color>,
    /// Case transform.
    pub transform: Option<TextTransform>,
    /// `textShadowColor`.
    pub shadow_color: Option<Color>,
    /// `textShadowOffset`.
    pub shadow_offset: Option<Point<Points>>,
    /// `textShadowRadius`.
    pub shadow_radius: Option<Points>,
    /// `fontVariant`.
    pub font_variant: Option<FontVariant>,
    /// `writingDirection`: right to left (`Some(true)`), left to right, or
    /// the layout's direction (`None`, `auto`).
    pub writing_direction: Option<bool>,
    /// `textAlignVertical`: where text shorter than its box sits, 0% top
    /// (`auto`, `top`), 50% `center`, 100% `bottom`.
    pub align_vertical: Option<Percentage>,
    /// `placeholderColor`: an input's placeholder (not inherited).
    pub placeholder_color: Option<Color>,
    /// `selectionColor`: an input's caret and selection, a selectable
    /// text's selection highlight (not inherited).
    pub selection_color: Option<Color>,
}

impl TextStyle {
    /// The text shadow these properties describe, if any. Like NSShadow, an
    /// offset or radius without a color uses black at a third of opacity.
    pub fn shadow(&self) -> Option<TextShadow> {
        if self.shadow_color.is_none()
            && self.shadow_offset.is_none()
            && self.shadow_radius.is_none()
        {
            return None;
        }
        let color = self.shadow_color.unwrap_or(Color(0x0000_0055));
        if color.is_transparent() {
            return None;
        }
        let offset = self.shadow_offset.unwrap_or_default();
        Some(TextShadow {
            color,
            offset_x: offset.x,
            offset_y: offset.y,
            radius: self.shadow_radius.unwrap_or_default().max(Points::ZERO),
        })
    }
}

/// What `fill` or `stroke` paints with (CSS's and SVG's `<paint>`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SvgPaint {
    /// `none`: nothing.
    None,
    /// `currentColor`: the element's text color (`color`, inherited).
    CurrentColor,
    /// A color.
    Color(Color),
}

/// SVG's paint properties, as CSS has them on any element and inherits
/// them (`fill`, `stroke`, `strokeWidth`, `strokeDasharray`; `fill-*` /
/// `stroke-*`): what the shapes a Rust component draws paint with (the
/// marks of `nsh/base/plot`), read through a drawing's
/// [`crate::canvas::ViewPaint`]s. Unset values inherit; at the root they
/// are CSS's initial values, which the drawing names.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct PaintStyle {
    /// `fill`.
    pub fill: Option<SvgPaint>,
    /// `stroke`.
    pub stroke: Option<SvgPaint>,
    /// `strokeWidth`.
    pub stroke_width: Option<Points>,
    /// `strokeDasharray`: the dashes and gaps, empty for `none`.
    pub stroke_dasharray: Option<Arc<[Points]>>,
}

impl PaintStyle {
    /// These properties where set, `parent`'s (the inherited ones) where
    /// not.
    pub fn inherit(&self, parent: &PaintStyle) -> PaintStyle {
        PaintStyle {
            fill: self.fill.or(parent.fill),
            stroke: self.stroke.or(parent.stroke),
            stroke_width: self.stroke_width.or(parent.stroke_width),
            stroke_dasharray: self
                .stroke_dasharray
                .clone()
                .or_else(|| parent.stroke_dasharray.clone()),
        }
    }
}

/// A complete node style, split by consumer.
#[derive(Debug, Clone)]
pub struct Style {
    /// Layout properties, consumed by taffy.
    pub layout: taffy::Style,
    /// Visual properties of the native view.
    pub view: ViewStyle,
    /// Text properties.
    pub text: TextStyle,
    /// SVG's paint properties (inherited, as text properties are).
    pub paint: PaintStyle,
    /// Visual properties driven by native animation nodes; they override
    /// the static values while bound.
    pub animated: Vec<(crate::animation::AnimationProp, crate::animation::NodeId)>,
    /// `zIndex`: stacking order among siblings (higher on top).
    pub z_index: i32,
    /// `verticalAlign`: where the element sits in its line when it is
    /// inside a `<Text>`.
    pub vertical_align: VerticalAlign,
    /// `direction`: right to left (`Some(true)`), left to right, or
    /// inherited (`None`).
    pub direction: Option<bool>,
    /// Start / end properties, placed by the resolved direction.
    pub logical: Logical,
    /// Values that only show together with another property.
    pub(crate) pending: Pending,
    /// CSS's `perspective` (`perspective-*`, `Styled::perspective`): the
    /// depth the view gives its children's 3D transforms, seen from its
    /// center; the core composes it into their transforms.
    pub perspective: Option<Points>,
}

/// Values of properties that take effect only together with another one,
/// kept so that the result does not depend on the order they are set in:
/// `outlineWidth` under `outlineStyle: "none"` and the border widths under
/// `borderStyle: "none"` (no outline, no border, as in CSS),
/// `animationDuration` and the other `animation*` keys before
/// `animationName`.
#[derive(Clone, Copy, Default)]
pub(crate) struct Pending {
    /// `outlineWidth` as set.
    outline_width: Points,
    /// `outlineStyle: "none"` / `"hidden"`.
    outline_hidden: bool,
    /// The border widths as set: top, right, bottom, left.
    border_widths: [Points; 4],
    /// `borderStartWidth`, `borderEndWidth` as set.
    border_logical: [Option<Points>; 2],
    /// `borderStyle: "none"` / `"hidden"`: every used width is 0.
    border_hidden: bool,
    /// `position: "fixed"`: laid out and mounted in its root view's box.
    pub(crate) fixed_position: bool,
    /// `position: "sticky"`: laid out as `relative`, its insets where it
    /// sticks in the viewport of the scroll view around it.
    pub(crate) sticky_position: bool,
    /// `animationDuration`.
    animation_duration: Option<f32>,
    /// `animationDelay`.
    animation_delay: Option<f32>,
    /// `animationTimingFunction`.
    animation_easing: Option<[f32; 4]>,
    /// `animationIterationCount` (`None` inside: forever).
    animation_iterations: Option<Option<u32>>,
    /// The `env()` terms of the padding and margin, added by the core to
    /// the lengths their declarations set.
    pub(crate) env: EnvEdges,
}

/// Bookkeeping, not what the style shows: styles that look the same print
/// the same (tests compare typed styles and classes so).
impl std::fmt::Debug for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pending")
    }
}

impl Pending {
    /// `animation` with the `animation*` values set.
    fn animation(&self, mut animation: KeyframeAnimation) -> KeyframeAnimation {
        if let Some(ms) = self.animation_duration {
            animation.duration = ms;
        }
        if let Some(ms) = self.animation_delay {
            animation.delay = ms;
        }
        if let Some(easing) = self.animation_easing {
            animation.easing = easing;
        }
        if let Some(count) = self.animation_iterations {
            animation.iterations = count;
        }
        animation
    }
}

/// A CSS environment variable (`env()`) a padding or margin may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnvVar {
    /// `safe-area-inset-top`: the top inset of the root view the node
    /// renders in.
    SafeAreaInsetTop,
    /// `safe-area-inset-right`.
    SafeAreaInsetRight,
    /// `safe-area-inset-bottom`.
    SafeAreaInsetBottom,
    /// `safe-area-inset-left`.
    SafeAreaInsetLeft,
    /// `keyboard-inset-height` (the VirtualKeyboard API's): the software
    /// keyboard's height over the surface, 0 while it is hidden.
    KeyboardInsetHeight,
}

impl EnvVar {
    /// The variable named `name`, if NSH has it.
    pub(crate) fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "safe-area-inset-top" => Self::SafeAreaInsetTop,
            "safe-area-inset-right" => Self::SafeAreaInsetRight,
            "safe-area-inset-bottom" => Self::SafeAreaInsetBottom,
            "safe-area-inset-left" => Self::SafeAreaInsetLeft,
            "keyboard-inset-height" => Self::KeyboardInsetHeight,
            _ => return None,
        })
    }
}

/// The `env()` terms of a node's padding and margin by physical edge (top,
/// right, bottom, left).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct EnvEdges {
    /// The padding's.
    pub(crate) padding: [Option<EnvVar>; 4],
    /// The margin's.
    pub(crate) margin: [Option<EnvVar>; 4],
}

impl EnvEdges {
    /// Whether no edge has a term.
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Left and right swapped, as their declarations are in right-to-left
    /// layouts ([`swap_sides`]).
    pub(crate) fn swapped(mut self) -> Self {
        self.padding.swap(1, 3);
        self.margin.swap(1, 3);
        self
    }
}

/// A padding or margin value using `env()`: `env(name)`, `env(name,
/// <length>)`, `calc(env(name) + <length>)` or `calc(<length> +
/// env(name))`. `None` when `s` uses no `env()`; else the length part (in
/// points) and the variable (none when an unknown name's fallback stands
/// in for it), or an error for anything else.
pub(crate) fn env_length(s: &str) -> Option<Result<(f32, Option<EnvVar>), StyleError>> {
    if !s.contains("env(") {
        return None;
    }
    // One term: `env(...)` or a length.
    fn term(s: &str) -> Option<(f32, Option<EnvVar>)> {
        let Some(args) = s.strip_prefix("env(").and_then(|r| r.strip_suffix(')')) else {
            return Some((css::length(s)?, None));
        };
        let (name, fallback) = match args.split_once(',') {
            Some((name, fallback)) => (name.trim(), Some(fallback.trim())),
            None => (args.trim(), None),
        };
        match EnvVar::parse(name) {
            Some(var) => Some((0.0, Some(var))),
            // CSS: an unknown variable is its fallback.
            None => Some((css::length(fallback?)?, None)),
        }
    }
    let parse = |s: &str| {
        let s = s.trim();
        let Some(inner) = s.strip_prefix("calc(").and_then(|r| r.strip_suffix(')')) else {
            return term(s);
        };
        // `a + b`, the `+` outside parentheses and between white space, as
        // CSS requires.
        let mut depth = 0i32;
        let mut plus = None;
        for (i, c) in inner.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                '+' if depth == 0 => {
                    let spaced = inner[..i].ends_with(char::is_whitespace)
                        && inner[i + 1..].starts_with(char::is_whitespace);
                    if !spaced || plus.is_some() {
                        return None;
                    }
                    plus = Some(i);
                }
                _ => {}
            }
        }
        let at = plus?;
        let (a, b) = (term(inner[..at].trim())?, term(inner[at + 1..].trim())?);
        if a.1.is_some() && b.1.is_some() {
            return None;
        }
        Some((a.0 + b.0, a.1.or(b.1)))
    };
    Some(parse(s).ok_or(StyleError::InvalidValue))
}

/// A padding edge: its length and its `env()` term.
fn padding_edge(v: StyleValue<'_>) -> Result<(LengthPercentage, Option<EnvVar>), StyleError> {
    if let StyleValue::Str(s) = v
        && let Some(env) = env_length(s)
    {
        let (length, var) = env?;
        // Padding is never negative.
        if length < 0.0 {
            return Err(StyleError::InvalidValue);
        }
        return Ok((LengthPercentage::length(length), var));
    }
    Ok((lp_or_zero(v)?, None))
}

/// A margin edge: its length and its `env()` term.
fn margin_edge(v: StyleValue<'_>) -> Result<(LengthPercentageAuto, Option<EnvVar>), StyleError> {
    if let StyleValue::Str(s) = v
        && let Some(env) = env_length(s)
    {
        let (length, var) = env?;
        return Ok((LengthPercentageAuto::length(length), var));
    }
    Ok((lpa_or_zero(v)?, None))
}

/// Properties named by start and end (`marginStart`, `borderTopEndRadius`
/// ...): left and right in left-to-right layouts, the other way around in
/// right-to-left ones.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Logical {
    /// `marginStart`, `marginEnd`.
    pub margin: [Option<LengthPercentageAuto>; 2],
    /// `paddingStart`, `paddingEnd`.
    pub padding: [Option<LengthPercentage>; 2],
    /// `start`, `end`.
    pub inset: [Option<LengthPercentageAuto>; 2],
    /// `borderStartWidth`, `borderEndWidth`.
    pub border_width: [Option<Points>; 2],
    /// `borderStartColor`, `borderEndColor`.
    pub border_color: [Option<Color>; 2],
    /// `borderTopStartRadius`, `borderTopEndRadius`,
    /// `borderBottomEndRadius`, `borderBottomStartRadius`.
    pub radius: [Option<Points>; 4],
}

impl Logical {
    /// Whether no start / end property is set.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

fn set_side<T>(rect: &mut taffy::Rect<T>, left: bool, value: T) {
    if left {
        rect.left = value;
    } else {
        rect.right = value;
    }
}

/// Swaps the left and right properties: in right-to-left layouts they
/// mean start and end, as in React Native. An involution.
pub(crate) fn swap_sides(layout: &mut taffy::Style, view: &mut ViewStyle) {
    fn swap<T>(r: &mut taffy::Rect<T>) {
        std::mem::swap(&mut r.left, &mut r.right);
    }
    swap(&mut layout.margin);
    swap(&mut layout.padding);
    swap(&mut layout.inset);
    swap(&mut layout.border);
    let (w, r) = (&mut view.borders.widths, &mut view.corner_radius);
    std::mem::swap(&mut w.left, &mut w.right);
    view.borders.colors.swap(1, 3);
    std::mem::swap(&mut r.top_left, &mut r.top_right);
    std::mem::swap(&mut r.bottom_left, &mut r.bottom_right);
}

/// Gives an unset `alignContent` (taffy's `normal`) its meaning for the
/// node's display: React Native's `flex-start` for flex (and block)
/// containers, where taffy's `normal` would stretch wrapped lines, and
/// CSS's `normal` for grids, whose auto tracks then stretch to fill the
/// container. (`justifyContent`'s `normal` is already `flex-start` in
/// flex containers.)
pub(crate) fn resolve_normal_alignment(layout: &mut taffy::Style) {
    if layout.display != Display::Grid && layout.align_content == AlignContent::NORMAL {
        layout.align_content = AlignContent::FLEX_START;
    }
}

/// Lays a node out in direction `rtl`: swaps its left and right
/// properties when right to left, then places the start / end ones.
pub(crate) fn apply_direction(
    layout: &mut taffy::Style,
    view: &mut ViewStyle,
    logical: &Logical,
    rtl: bool,
) {
    layout.direction = if rtl {
        taffy::Direction::Rtl
    } else {
        taffy::Direction::Ltr
    };
    if rtl {
        swap_sides(layout, view);
    }
    if logical.is_empty() {
        return;
    }
    // Start is the left side left to right.
    for (i, left) in [!rtl, rtl].into_iter().enumerate() {
        if let Some(v) = logical.margin[i] {
            set_side(&mut layout.margin, left, v);
        }
        if let Some(v) = logical.padding[i] {
            set_side(&mut layout.padding, left, v);
        }
        if let Some(v) = logical.inset[i] {
            set_side(&mut layout.inset, left, v);
        }
        let side = if left { 3 } else { 1 };
        if let Some(w) = logical.border_width[i] {
            set_side(&mut layout.border, left, LengthPercentage::length(w.0));
            *view.borders.width_mut(side) = w;
        }
        if let Some(c) = logical.border_color[i] {
            view.borders.colors[side] = c;
        }
    }
    // Corners: top start, top end, bottom end, bottom start.
    let [top_start, top_end, bottom_end, bottom_start] = logical.radius;
    let c = &mut view.corner_radius;
    let (top_left, top_right, bottom_right, bottom_left) = if rtl {
        (top_end, top_start, bottom_start, bottom_end)
    } else {
        (top_start, top_end, bottom_end, bottom_start)
    };
    for (corner, r) in [
        (&mut c.top_left, top_left),
        (&mut c.top_right, top_right),
        (&mut c.bottom_right, bottom_right),
        (&mut c.bottom_left, bottom_left),
    ] {
        if r.is_some() {
            *corner = r;
        }
    }
}

impl Default for Style {
    /// React Native defaults, which differ from CSS (and taffy) defaults.
    fn default() -> Self {
        let layout = taffy::Style {
            display: Display::Flex,
            position: Position::Relative,
            flex_direction: FlexDirection::Column,
            flex_shrink: 0.0,
            // Unset: `flex-start` (React Native) outside grids, CSS's
            // `normal` in grids (`resolve_normal_alignment`).
            align_content: AlignContent::NORMAL,
            // Yoga has no automatic minimum size (see `min_len`).
            min_size: taffy::Size {
                width: LengthPercentageAuto::length(0.0),
                height: LengthPercentageAuto::length(0.0),
            },
            ..taffy::Style::DEFAULT
        };
        Self {
            layout,
            view: ViewStyle::default(),
            text: TextStyle::default(),
            paint: PaintStyle::default(),
            animated: Vec::new(),
            z_index: 0,
            vertical_align: VerticalAlign::Baseline,
            direction: None,
            logical: Logical::default(),
            pending: Pending::default(),
            perspective: None,
        }
    }
}

/// Which TypeScript style interface a property belongs to (each extends
/// the one before: layout, then views, then text or images).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StyleGroup {
    Layout,
    View,
    Text,
    Image,
}

/// A style property's TypeScript declaration (`js::style`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct StyleType {
    pub(crate) name: &'static str,
    pub(crate) group: StyleGroup,
    pub(crate) ts: &'static str,
    pub(crate) doc: Option<&'static str>,
}

/// The style properties the JS bridge decodes itself (objects and lists,
/// `crates/nsh-js/src/protocol.rs`), for the TypeScript declarations.
pub(crate) const OBJECT_STYLE_TYPES: &[StyleType] = &[
    StyleType {
        name: "transform",
        group: StyleGroup::View,
        ts: "TransformStep[]",
        doc: None,
    },
    StyleType {
        name: "shadowOffset",
        group: StyleGroup::View,
        ts: "{ width: number; height: number }",
        doc: Some("Default `{ width: 0, height: -3 }`, as in React Native."),
    },
    StyleType {
        name: "textShadowOffset",
        group: StyleGroup::Text,
        ts: "{ width: number; height: number }",
        doc: None,
    },
];

macro_rules! style_keys {
    ($($key:ident = $name:literal: $group:ident $ts:literal $($doc:literal)?),* $(,)?) => {
        /// The style properties' TypeScript declarations, in order.
        pub(crate) const STYLE_TYPES: &[StyleType] = &[$(StyleType {
            name: $name,
            group: StyleGroup::$group,
            ts: $ts,
            doc: style_keys!(@doc $($doc)?),
        }),*];

        /// A style property, by its React Native name.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum StyleKey {
            $(
                #[doc = concat!("`", $name, "`")]
                $key,
            )*
        }

        impl StyleKey {
            /// The key named `name` (React Native's camel case).
            pub fn parse(name: &str) -> Option<StyleKey> {
                Some(match name {
                    $($name => StyleKey::$key,)*
                    _ => return None,
                })
            }

            /// The React Native name.
            pub fn name(self) -> &'static str {
                match self {
                    $(StyleKey::$key => $name,)*
                }
            }
        }
    };
    (@doc) => { None };
    (@doc $doc:literal) => { Some($doc) };
}

style_keys! {
    Display = "display": Layout "\"flex\" | \"grid\" | \"block\" | \"flow-root\" | \"none\"",
    BoxSizing = "boxSizing": Layout "\"border-box\" | \"content-box\"" "The box that width and height include.",
    Position = "position": Layout "\"relative\" | \"absolute\" | \"static\" | \"fixed\" | \"sticky\"" "`static` stays in flow and lets absolute descendants use the nearest positioned ancestor as their containing block. `fixed` lays an element out in its root view and mounts it above that root view's children. `sticky`: in the flow, and while its parent shows it stays `top` (in a horizontal scroll view `left`) from the start of the viewport of the scroll view around it, as far as the end of its parent's content box; it draws above its siblings of the same `zIndex`.",
    FlexDirection = "flexDirection": Layout "\"row\" | \"column\" | \"row-reverse\" | \"column-reverse\"",
    FlexWrap = "flexWrap": Layout "\"wrap\" | \"nowrap\" | \"wrap-reverse\"",
    Flex = "flex": Layout "number",
    FlexGrow = "flexGrow": Layout "number",
    FlexShrink = "flexShrink": Layout "number",
    FlexBasis = "flexBasis": Layout "DimensionValue | \"min-content\" | \"max-content\" | \"fit-content\"",
    JustifyContent = "justifyContent": Layout "Exclude<Distribute, \"stretch\"> | \"stretch\"",
    AlignItems = "alignItems": Layout "Align",
    AlignSelf = "alignSelf": Layout "Align | \"auto\"",
    AlignContent = "alignContent": Layout "Distribute",
    Width = "width": Layout "DimensionValue | \"min-content\" | \"max-content\" | \"fit-content\"",
    Height = "height": Layout "DimensionValue | \"min-content\" | \"max-content\" | \"fit-content\"",
    MinWidth = "minWidth": Layout "LengthValue",
    MinHeight = "minHeight": Layout "LengthValue",
    MaxWidth = "maxWidth": Layout "LengthValue",
    MaxHeight = "maxHeight": Layout "LengthValue",
    AspectRatio = "aspectRatio": Layout "number",
    Top = "top": Layout "DimensionValue | AnimatedNode" "An animated value only for a `position: \"sticky\"` view: how far from the top of the scroll view's viewport it sticks, following the value (below a header that moves).",
    Right = "right": Layout "DimensionValue",
    Bottom = "bottom": Layout "DimensionValue",
    Left = "left": Layout "DimensionValue | AnimatedNode" "An animated value only for a `position: \"sticky\"` view in a horizontal scroll view, as `top`.",
    Margin = "margin": Layout "DimensionValue | EnvValue",
    MarginHorizontal = "marginHorizontal": Layout "DimensionValue | EnvValue",
    MarginVertical = "marginVertical": Layout "DimensionValue | EnvValue",
    MarginTop = "marginTop": Layout "DimensionValue | EnvValue",
    MarginRight = "marginRight": Layout "DimensionValue | EnvValue",
    MarginBottom = "marginBottom": Layout "DimensionValue | EnvValue",
    MarginLeft = "marginLeft": Layout "DimensionValue | EnvValue",
    Padding = "padding": Layout "LengthValue | EnvValue",
    PaddingHorizontal = "paddingHorizontal": Layout "LengthValue | EnvValue",
    PaddingVertical = "paddingVertical": Layout "LengthValue | EnvValue",
    PaddingTop = "paddingTop": Layout "LengthValue | EnvValue",
    PaddingRight = "paddingRight": Layout "LengthValue | EnvValue",
    PaddingBottom = "paddingBottom": Layout "LengthValue | EnvValue",
    PaddingLeft = "paddingLeft": Layout "LengthValue | EnvValue",
    Gap = "gap": Layout "LengthValue",
    RowGap = "rowGap": Layout "LengthValue",
    ColumnGap = "columnGap": Layout "LengthValue",
    BorderWidth = "borderWidth": View "number",
    BorderTopWidth = "borderTopWidth": View "number",
    BorderRightWidth = "borderRightWidth": View "number",
    BorderBottomWidth = "borderBottomWidth": View "number",
    BorderLeftWidth = "borderLeftWidth": View "number",
    ZIndex = "zIndex": Layout "number" "Order among siblings (stable); also the native stacking order.",
    BoxShadow = "boxShadow": View "string" "CSS `box-shadow`: offsets, blur, spread and color, several separated by commas, `inset` for inner shadows.",
    BackgroundImage = "backgroundImage": View "string" "CSS gradients drawn over the background color: `linear-gradient(...)`, `radial-gradient(...)`, `conic-gradient(...)`, several separated by commas.",
    Filter = "filter": View "string" "CSS filters of the view and its content: `brightness()`, `contrast()`, `grayscale()`, `hue-rotate()`, `invert()`, `saturate()`, `sepia()`, `opacity()`, `blur()`, `drop-shadow()`.",
    BackdropFilter = "backdropFilter": View "string" "CSS filters of what is behind the view (`blur(10px)`).",
    MaskImage = "maskImage": View "string" "A CSS gradient whose alpha decides how much of the view is drawn, fully where opaque and not at all where transparent: `linear-gradient(...)`, `radial-gradient(...)`, `conic-gradient(...)`. Masks everything the view draws, its backdrop filter included.",
    GlassEffect = "glassEffect": View "\"none\" | \"regular\" | \"clear\"" "A glass material behind the view's content (Apple's Liquid Glass). Drawn on iOS 26 and later; elsewhere the view's `backdropFilter` is drawn as before, so give a glass view a blur to fall back to.",
    MixBlendMode = "mixBlendMode": View "\"normal\" | \"multiply\" | \"screen\" | \"overlay\" | \"darken\" | \"lighten\" | \"color-dodge\" | \"color-burn\" | \"hard-light\" | \"soft-light\" | \"difference\" | \"exclusion\" | \"hue\" | \"saturation\" | \"color\" | \"luminosity\" | \"plus-darker\" | \"plus-lighter\"" "How the view blends with what is behind it.",
    OutlineWidth = "outlineWidth": View "number" "A line outside the border that takes no space.",
    OutlineColor = "outlineColor": View "ColorValue",
    OutlineStyle = "outlineStyle": View "\"solid\" | \"dashed\" | \"dotted\" | \"none\" | \"hidden\"",
    OutlineOffset = "outlineOffset": View "number" "Distance from the border edge (negative: inside).",
    Visibility = "visibility": View "\"visible\" | \"hidden\" | \"collapse\"" "Hidden views keep their space.",
    Cursor = "cursor": View "\"auto\" | \"default\" | \"context-menu\" | \"alias\" | \"copy\" | \"cell\" | \"pointer\" | \"text\" | \"vertical-text\" | \"wait\" | \"progress\" | \"help\" | \"crosshair\" | \"move\" | \"all-scroll\" | \"grab\" | \"grabbing\" | \"not-allowed\" | \"no-drop\" | \"zoom-in\" | \"zoom-out\" | \"col-resize\" | \"e-resize\" | \"w-resize\" | \"ew-resize\" | \"row-resize\" | \"n-resize\" | \"s-resize\" | \"ns-resize\" | \"ne-resize\" | \"nw-resize\" | \"se-resize\" | \"sw-resize\" | \"nesw-resize\" | \"nwse-resize\" | \"none\"" "The pointer over the view (pointers and desktops).",
    TransitionProperty = "transitionProperty": View "string" "The properties that animate when they change (`\"opacity, transform\"`, `\"all\"`, `\"colors\"`).",
    TransitionDuration = "transitionDuration": View "number | `${number}ms` | `${number}s`" "Milliseconds as a number, or `\"150ms\"` / `\"0.2s\"`.",
    TransitionDelay = "transitionDelay": View "number | `${number}ms` | `${number}s`",
    TransitionTimingFunction = "transitionTimingFunction": View "\"linear\" | \"ease\" | \"ease-in\" | \"ease-out\" | \"ease-in-out\" | `cubic-bezier(${string})`",
    AnimationName = "animationName": View "\"none\" | \"spin\" | \"ping\" | \"pulse\" | \"bounce\"" "A built-in keyframe animation, run natively.",
    AnimationDuration = "animationDuration": View "number | `${number}ms` | `${number}s`",
    AnimationDelay = "animationDelay": View "number | `${number}ms` | `${number}s`",
    AnimationTimingFunction = "animationTimingFunction": View "\"linear\" | \"ease\" | \"ease-in\" | \"ease-out\" | \"ease-in-out\" | `cubic-bezier(${string})`",
    AnimationIterationCount = "animationIterationCount": View "number | \"infinite\"",
    TextDecorationStyle = "textDecorationStyle": Text "\"solid\" | \"double\" | \"dotted\" | \"dashed\" | \"wavy\"",
    TextDecorationThickness = "textDecorationThickness": Text "number | \"auto\" | \"from-font\"",
    TextUnderlineOffset = "textUnderlineOffset": Text "number | \"auto\"",
    GridTemplateColumns = "gridTemplateColumns": Layout "string" "CSS grid tracks: `\"repeat(3, 1fr)\"`, `\"200px 1fr\"`, `minmax()`, `auto-fill` / `auto-fit`, line names (`\"[full-start] 1fr [content-start] 2fr [content-end full-end]\"`).",
    GridTemplateRows = "gridTemplateRows": Layout "string",
    GridAutoColumns = "gridAutoColumns": Layout "string" "Tracks of implicitly created columns.",
    GridAutoRows = "gridAutoRows": Layout "string",
    GridAutoFlow = "gridAutoFlow": Layout "\"row\" | \"column\" | \"dense\" | \"row dense\" | \"column dense\"",
    GridColumn = "gridColumn": Layout "number | string" "`\"1 / 3\"`, `\"span 2\"`, a line number or name (`\"content-start / full-end\"`, `\"span col\"`).",
    GridColumnStart = "gridColumnStart": Layout "number | string",
    GridColumnEnd = "gridColumnEnd": Layout "number | string",
    GridRow = "gridRow": Layout "number | string",
    GridRowStart = "gridRowStart": Layout "number | string",
    GridRowEnd = "gridRowEnd": Layout "number | string",
    JustifyItems = "justifyItems": Layout "Align" "How grid items sit in their areas along the row.",
    JustifySelf = "justifySelf": Layout "Align | \"auto\"",
    Direction = "direction": Layout "\"inherit\" | \"ltr\" | \"rtl\"" "Layout direction; inherited by default. Right to left, `left` and `right` properties mean start and end (as in React Native).",
    MarginStart = "marginStart": Layout "DimensionValue",
    MarginEnd = "marginEnd": Layout "DimensionValue",
    PaddingStart = "paddingStart": Layout "LengthValue",
    PaddingEnd = "paddingEnd": Layout "LengthValue",
    Start = "start": Layout "DimensionValue" "Left in left-to-right layouts, right in right-to-left ones.",
    End = "end": Layout "DimensionValue",
    BorderStartWidth = "borderStartWidth": View "number",
    BorderEndWidth = "borderEndWidth": View "number",
    BorderStartColor = "borderStartColor": View "ColorValue",
    BorderEndColor = "borderEndColor": View "ColorValue",
    BorderTopStartRadius = "borderTopStartRadius": View "number",
    BorderTopEndRadius = "borderTopEndRadius": View "number",
    BorderBottomEndRadius = "borderBottomEndRadius": View "number",
    BorderBottomStartRadius = "borderBottomStartRadius": View "number",
    BackgroundColor = "backgroundColor": View "ColorValue | AnimatedNode",
    BorderRadius = "borderRadius": View "number",
    BorderTopLeftRadius = "borderTopLeftRadius": View "number",
    BorderTopRightRadius = "borderTopRightRadius": View "number",
    BorderBottomRightRadius = "borderBottomRightRadius": View "number",
    BorderBottomLeftRadius = "borderBottomLeftRadius": View "number",
    ShadowColor = "shadowColor": View "ColorValue | AnimatedNode",
    ShadowOpacity = "shadowOpacity": View "number | AnimatedNode",
    ShadowRadius = "shadowRadius": View "number | AnimatedNode",
    BorderColor = "borderColor": View "ColorValue | AnimatedNode",
    BorderTopColor = "borderTopColor": View "ColorValue",
    BorderRightColor = "borderRightColor": View "ColorValue",
    BorderBottomColor = "borderBottomColor": View "ColorValue",
    BorderLeftColor = "borderLeftColor": View "ColorValue",
    BorderStyle = "borderStyle": View "\"solid\" | \"dashed\" | \"dotted\" | \"none\" | \"hidden\"" "`none` and `hidden`: no border whatever the widths (they take no space).",
    BorderCurve = "borderCurve": View "\"circular\" | \"continuous\"" "`continuous`: corners whose curvature eases into the edges (iOS app icons).",
    TintColor = "tintColor": Image "ColorValue" "Recolors a template image.",
    ObjectPosition = "objectPosition": Image "string" "Where the image sits in its box once `resizeMode` has sized it, as CSS's `object-position`: keywords, percentages and lengths (`\"top\"`, `\"left bottom\"`, `\"25% 75%\"`, `\"right 10px bottom 20%\"`). A covering image is cropped around it. Default the center.",
    BackfaceVisibility = "backfaceVisibility": View "\"visible\" | \"hidden\"" "`\"hidden\"`: invisible while turned away (3D rotations).",
    TransformOrigin = "transformOrigin": View "string | (number | string)[]" "The point `transform` acts around: keywords, percentages and lengths (\"top left\", \"50% 0\", `[10, 20]`). Default the center.",
    Opacity = "opacity": View "number | AnimatedNode",
    Overflow = "overflow": View "\"visible\" | \"hidden\"",
    Color = "color": Text "ColorValue | AnimatedNode",
    FontSize = "fontSize": Text "number",
    FontWeight = "fontWeight": Text "\"normal\" | \"bold\" | number | `${number}`" "`\"normal\"` (400), `\"bold\"` (700) or 100–900.",
    LineHeight = "lineHeight": Text "number",
    FontFamily = "fontFamily": Text "string" "A system family or the name an imported font (`import Inter from \"./Inter.ttf\"`) evaluates to.",
    FontStyle = "fontStyle": Text "\"normal\" | \"italic\"",
    LetterSpacing = "letterSpacing": Text "number",
    TextDecorationLine = "textDecorationLine": Text "\"none\" | \"underline\" | \"line-through\" | \"underline line-through\"",
    TextDecorationColor = "textDecorationColor": Text "ColorValue",
    WritingDirection = "writingDirection": Text "\"auto\" | \"ltr\" | \"rtl\"" "Base direction of the text; `auto` takes it from the content.",
    TextAlignVertical = "textAlignVertical": Text "\"auto\" | \"top\" | \"center\" | \"bottom\"" "Where text shorter than its box sits (`<Text>` with a height).",
    FontVariant = "fontVariant": Text "(\"small-caps\" | \"oldstyle-nums\" | \"lining-nums\" | \"tabular-nums\" | \"proportional-nums\")[]" "OpenType number and letter forms.",
    TextShadowColor = "textShadowColor": Text "ColorValue",
    TextShadowRadius = "textShadowRadius": Text "number",
    TextTransform = "textTransform": Text "\"none\" | \"uppercase\" | \"lowercase\" | \"capitalize\"",
    TextAlign = "textAlign": Text "\"auto\" | \"left\" | \"center\" | \"right\" | \"justify\"",
    PlaceholderColor = "placeholderColor": Text "ColorValue" "An input's placeholder (`placeholder:text-*`).",
    SelectionColor = "selectionColor": Text "ColorValue" "An input's caret and selection, a selectable text's selection highlight (`selection:bg-*`).",
    Fill = "fill": View "\"none\" | \"currentColor\" | ColorValue" "What the shapes a component draws are filled with (CSS's and SVG's `fill`, inherited; `fill-*`): a chart's areas.",
    Stroke = "stroke": View "\"none\" | \"currentColor\" | ColorValue" "What the outlines of the shapes a component draws are painted with (CSS's and SVG's `stroke`, inherited; `stroke-<color>`): a chart's lines and grid lines.",
    StrokeWidth = "strokeWidth": View "number | string" "The width of those outlines, a length (CSS's and SVG's `stroke-width`, inherited, 1 by default; `stroke-<number>`).",
    StrokeDasharray = "strokeDasharray": View "number | string" "The dashes and gaps of those outlines, lengths separated by spaces or commas, an odd list repeated, or `none` (CSS's and SVG's `stroke-dasharray`, inherited).",
    VerticalAlign = "verticalAlign": View "\"baseline\" | \"text-top\" | \"text-bottom\" | \"middle\"" "Where a view or image inside a `<Text>` sits in its line (CSS `vertical-align`, `align-*`): its bottom on the baseline (the default), its top or bottom at the top or bottom of the text's font, or its middle half the font's x height above the baseline. The line grows to hold it.",
}

/// A style property value as read from JS.
#[derive(Debug, Clone, Copy)]
pub enum StyleValue<'a> {
    /// A number.
    Number(f32),
    /// A string.
    Str(&'a str),
    /// `null` / `undefined`: resets the property to its default.
    Null,
}

/// A style property value owned by a [`StylePatch`].
#[derive(Debug, Clone, PartialEq)]
pub enum PatchValue {
    /// A number.
    Number(f32),
    /// A string.
    Str(Box<str>),
    /// Resets the property to its default.
    Null,
}

impl PatchValue {
    /// The value as [`Style::set`] takes it.
    pub fn as_value(&self) -> StyleValue<'_> {
        match self {
            PatchValue::Number(n) => StyleValue::Number(*n),
            PatchValue::Str(s) => StyleValue::Str(s),
            PatchValue::Null => StyleValue::Null,
        }
    }
}

impl From<StyleValue<'_>> for PatchValue {
    fn from(v: StyleValue<'_>) -> Self {
        match v {
            StyleValue::Number(n) => PatchValue::Number(n),
            StyleValue::Str(s) => PatchValue::Str(s.into()),
            StyleValue::Null => PatchValue::Null,
        }
    }
}

/// One declaration of a [`StylePatch`].
#[derive(Debug, Clone, PartialEq)]
pub enum StyleDecl {
    /// A property.
    Set(StyleKey, PatchValue),
    /// Starts the `transform` list over: a `transform` replaces the
    /// transforms set before it (by classes).
    ClearTransform,
    /// Appends a `transform` entry, driven by an animated value when given
    /// (the amount is then the identity until it is bound).
    Transform(TransformKind, f32, Option<crate::animation::NodeId>),
    /// `shadowOffset`; `None` restores the default.
    ShadowOffset(Option<Point<Points>>),
    /// `textShadowOffset`.
    TextShadowOffset(Option<Point<Points>>),
    /// A property driven by a native animation node.
    Animated(crate::animation::AnimationProp, crate::animation::NodeId),
}

impl StyleDecl {
    /// Applies the declaration to `style`.
    pub fn apply(&self, style: &mut Style) -> Result<(), StyleError> {
        match self {
            StyleDecl::Set(key, value) => style.set_key(*key, value.as_value()),
            StyleDecl::ClearTransform => {
                style.view.transform = Transform::IDENTITY;
                style.animated.retain(|(prop, _)| {
                    !matches!(prop, crate::animation::AnimationProp::Transform(_))
                });
                Ok(())
            }
            StyleDecl::Transform(kind, amount, node) => {
                let index = style
                    .view
                    .transform
                    .push(*kind, *amount)
                    .ok_or(StyleError::InvalidValue)?;
                if let Some(node) = node {
                    style
                        .animated
                        .push((crate::animation::AnimationProp::Transform(index), *node));
                }
                Ok(())
            }
            StyleDecl::ShadowOffset(offset) => {
                style.set_shadow_offset(*offset);
                Ok(())
            }
            StyleDecl::TextShadowOffset(offset) => {
                style.set_text_shadow_offset(*offset);
                Ok(())
            }
            StyleDecl::Animated(prop, node) => {
                style.animated.push((*prop, *node));
                Ok(())
            }
        }
    }
}

/// A style as written (`style={...}`): its declarations in order (the
/// shorthands of [`StylePatch::set`] before their longhands), kept so the
/// core can apply them again over class styles when those change.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StylePatch {
    decls: Vec<StyleDecl>,
}

impl StylePatch {
    /// Applies `decl` to `style` and records it if it applied.
    pub fn push(&mut self, style: &mut Style, decl: StyleDecl) -> Result<(), StyleError> {
        decl.apply(style)?;
        self.decls.push(decl);
        Ok(())
    }

    /// Sets property `key` of the style object this patch records on
    /// `style`, and records it. As in React Native, a longhand
    /// (`borderTopWidth`, `marginHorizontal`, `flexGrow`, ...) wins over
    /// its shorthand (`borderWidth`, `margin`, `flex`) in one object
    /// whatever their order: a shorthand set after its longhands is
    /// recorded before them, and they apply again; a `null` longhand is
    /// unset, so its shorthand shows.
    pub fn set(
        &mut self,
        style: &mut Style,
        key: &str,
        value: StyleValue<'_>,
    ) -> Result<(), StyleError> {
        let key = StyleKey::parse(key).ok_or(StyleError::UnknownProperty)?;
        if matches!(value, StyleValue::Null) && self.has_shorthand_of(key) {
            return Ok(());
        }
        style.set_key(key, value)?;
        let decl = StyleDecl::Set(key, value.into());
        let longhands = key.longhands();
        let Some(at) = self
            .decls
            .iter()
            .position(|d| matches!(d, StyleDecl::Set(k, _) if longhands.contains(k)))
        else {
            self.decls.push(decl);
            return Ok(());
        };
        // Nulls set before are dropped (the shorthand shows); the others
        // apply again over it.
        self.decls
            .retain(|d| !matches!(d, StyleDecl::Set(k, PatchValue::Null) if longhands.contains(k)));
        let at = at.min(self.decls.len());
        self.decls.insert(at, decl);
        for d in &self.decls[at + 1..] {
            if let StyleDecl::Set(k, v) = d
                && longhands.contains(k)
            {
                let _ = style.set_key(*k, v.as_value());
            }
        }
        Ok(())
    }

    /// Whether a shorthand of `key` is recorded.
    fn has_shorthand_of(&self, key: StyleKey) -> bool {
        self.decls
            .iter()
            .any(|d| matches!(d, StyleDecl::Set(k, _) if k.longhands().contains(&key)))
    }

    /// Applies every declaration to `style`, in order.
    pub fn apply(&self, style: &mut Style) {
        for decl in &self.decls {
            // Declarations were checked when they were recorded.
            let _ = decl.apply(style);
        }
    }

    /// Whether there are no declarations.
    pub fn is_empty(&self) -> bool {
        self.decls.is_empty()
    }

    /// The declarations.
    pub fn decls(&self) -> &[StyleDecl] {
        &self.decls
    }
}

impl StyleKey {
    /// The properties that override this shorthand in a style object
    /// whatever their order (Yoga takes an edge's own value before its
    /// axis' and that of all edges, `flexGrow` before `flex`).
    fn longhands(self) -> &'static [StyleKey] {
        use StyleKey as K;
        match self {
            K::Margin => &[
                K::MarginHorizontal,
                K::MarginVertical,
                K::MarginTop,
                K::MarginRight,
                K::MarginBottom,
                K::MarginLeft,
            ],
            K::MarginHorizontal => &[K::MarginLeft, K::MarginRight],
            K::MarginVertical => &[K::MarginTop, K::MarginBottom],
            K::Padding => &[
                K::PaddingHorizontal,
                K::PaddingVertical,
                K::PaddingTop,
                K::PaddingRight,
                K::PaddingBottom,
                K::PaddingLeft,
            ],
            K::PaddingHorizontal => &[K::PaddingLeft, K::PaddingRight],
            K::PaddingVertical => &[K::PaddingTop, K::PaddingBottom],
            K::BorderWidth => &[
                K::BorderTopWidth,
                K::BorderRightWidth,
                K::BorderBottomWidth,
                K::BorderLeftWidth,
            ],
            K::BorderColor => &[
                K::BorderTopColor,
                K::BorderRightColor,
                K::BorderBottomColor,
                K::BorderLeftColor,
            ],
            K::Gap => &[K::RowGap, K::ColumnGap],
            K::Flex => &[K::FlexGrow, K::FlexShrink, K::FlexBasis],
            K::GridColumn => &[K::GridColumnStart, K::GridColumnEnd],
            K::GridRow => &[K::GridRowStart, K::GridRowEnd],
            _ => &[],
        }
    }
}

/// Why a style property was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StyleError {
    /// The property name is not supported.
    UnknownProperty,
    /// The value has the wrong type or format.
    InvalidValue,
}

enum Len {
    Px(f32),
    Pct(f32),
    Auto,
}

impl Len {
    fn parse(v: StyleValue<'_>) -> Result<Len, StyleError> {
        match v {
            StyleValue::Number(n) => Ok(Len::Px(n)),
            StyleValue::Str("auto") => Ok(Len::Auto),
            StyleValue::Str(s) => s
                .strip_suffix('%')
                .and_then(|p| p.trim().parse::<f32>().ok())
                .map(|p| Len::Pct(p / 100.0))
                .ok_or(StyleError::InvalidValue),
            StyleValue::Null => Ok(Len::Auto),
        }
    }

    fn dim(self) -> Dimension {
        match self {
            Len::Px(v) => Dimension::length(v),
            Len::Pct(v) => Dimension::percent(v),
            Len::Auto => Dimension::auto(),
        }
    }

    fn lpa(self) -> LengthPercentageAuto {
        match self {
            Len::Px(v) => LengthPercentageAuto::length(v),
            Len::Pct(v) => LengthPercentageAuto::percent(v),
            Len::Auto => LengthPercentageAuto::auto(),
        }
    }

    fn lp(self) -> Result<LengthPercentage, StyleError> {
        match self {
            Len::Px(v) => Ok(LengthPercentage::length(v)),
            Len::Pct(v) => Ok(LengthPercentage::percent(v)),
            Len::Auto => Err(StyleError::InvalidValue),
        }
    }
}

/// Intrinsic sizes are delegated to Taffy's sizing algorithms.
fn dimension(value: StyleValue<'_>) -> Result<Dimension, StyleError> {
    Ok(match value {
        StyleValue::Str("min-content") => Dimension::min_content(),
        StyleValue::Str("max-content") => Dimension::max_content(),
        StyleValue::Str("fit-content") => Dimension::fit_content(),
        value => Len::parse(value)?.dim(),
    })
}

/// A zero-default length: `null` resets to 0 rather than `auto`.
fn lp_or_zero(v: StyleValue<'_>) -> Result<LengthPercentage, StyleError> {
    match v {
        StyleValue::Null => Ok(LengthPercentage::length(0.0)),
        v => Len::parse(v)?.lp(),
    }
}

fn opt_lpa(v: StyleValue<'_>) -> Result<Option<LengthPercentageAuto>, StyleError> {
    match v {
        StyleValue::Null => Ok(None),
        v => Ok(Some(Len::parse(v)?.lpa())),
    }
}

fn opt_lp(v: StyleValue<'_>) -> Result<Option<LengthPercentage>, StyleError> {
    match v {
        StyleValue::Null => Ok(None),
        v => Ok(Some(Len::parse(v)?.lp()?)),
    }
}

/// A minimum size: unset is 0, as in Yoga. Taffy's `auto` would be CSS's
/// automatic minimum (the min-content size), which keeps flex items from
/// shrinking below their content (`flex: 1` text in a row would overflow).
fn min_len(v: StyleValue<'_>) -> Result<LengthPercentageAuto, StyleError> {
    Ok(match Len::parse(v)? {
        Len::Auto => LengthPercentageAuto::length(0.0),
        len => len.lpa(),
    })
}

fn lpa_or_zero(v: StyleValue<'_>) -> Result<LengthPercentageAuto, StyleError> {
    match v {
        StyleValue::Null => Ok(LengthPercentageAuto::length(0.0)),
        v => Ok(Len::parse(v)?.lpa()),
    }
}

fn number(v: StyleValue<'_>, default: f32) -> Result<f32, StyleError> {
    match v {
        StyleValue::Number(n) => Ok(n),
        StyleValue::Null => Ok(default),
        StyleValue::Str(_) => Err(StyleError::InvalidValue),
    }
}

fn opt_number(v: StyleValue<'_>) -> Result<Option<f32>, StyleError> {
    match v {
        StyleValue::Number(n) => Ok(Some(n)),
        StyleValue::Null => Ok(None),
        StyleValue::Str(_) => Err(StyleError::InvalidValue),
    }
}

fn opt_points(v: StyleValue<'_>) -> Result<Option<Points>, StyleError> {
    Ok(opt_number(v)?.map(px))
}

fn color(v: StyleValue<'_>) -> Result<Option<Color>, StyleError> {
    match v {
        StyleValue::Str(s) => Color::parse(s).map(Some).ok_or(StyleError::InvalidValue),
        StyleValue::Null => Ok(None),
        StyleValue::Number(_) => Err(StyleError::InvalidValue),
    }
}

/// A `fill` / `stroke` value; `inherit` is unset, since they inherit.
fn svg_paint(v: StyleValue<'_>) -> Result<Option<SvgPaint>, StyleError> {
    let StyleValue::Str(s) = v else {
        return match v {
            StyleValue::Null => Ok(None),
            _ => Err(StyleError::InvalidValue),
        };
    };
    let s = s.trim();
    Ok(if s.eq_ignore_ascii_case("none") {
        Some(SvgPaint::None)
    } else if s.eq_ignore_ascii_case("currentcolor") {
        Some(SvgPaint::CurrentColor)
    } else if s.eq_ignore_ascii_case("inherit") {
        None
    } else {
        Some(SvgPaint::Color(
            Color::parse(s).ok_or(StyleError::InvalidValue)?,
        ))
    })
}

/// A `strokeDasharray` value: lengths (no negatives) separated by commas
/// and / or spaces, or `none` (empty); one whose lengths add up to zero is
/// a solid line, as in SVG.
fn dasharray(v: StyleValue<'_>) -> Result<Option<Arc<[Points]>>, StyleError> {
    let lengths: Vec<Points> = match v {
        StyleValue::Null => return Ok(None),
        StyleValue::Number(n) if n >= 0.0 => vec![px(n)],
        StyleValue::Number(_) => return Err(StyleError::InvalidValue),
        StyleValue::Str(s) if s.trim().eq_ignore_ascii_case("none") => Vec::new(),
        StyleValue::Str(s) => s
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|part| !part.is_empty())
            .map(|part| match css::length(part) {
                Some(n) if n >= 0.0 => Ok(px(n)),
                _ => Err(StyleError::InvalidValue),
            })
            .collect::<Result<_, _>>()?,
    };
    if lengths.iter().all(|l| l.0 == 0.0) {
        return Ok(Some(Arc::from([])));
    }
    Ok(Some(lengths.into()))
}

fn keyword<'a>(v: StyleValue<'a>) -> Result<Option<&'a str>, StyleError> {
    match v {
        StyleValue::Str(s) => Ok(Some(s)),
        StyleValue::Null => Ok(None),
        StyleValue::Number(_) => Err(StyleError::InvalidValue),
    }
}

fn align_items(v: StyleValue<'_>) -> Result<Option<AlignItems>, StyleError> {
    Ok(match keyword(v)? {
        None => None,
        Some("flex-start") => Some(AlignItems::FLEX_START),
        Some("flex-end") => Some(AlignItems::FLEX_END),
        // CSS's logical keywords: the writing direction's start and end
        // (right to left, `start` is the right), not the flex direction's.
        Some("start") => Some(AlignItems::START),
        Some("end") => Some(AlignItems::END),
        Some("self-start") => Some(AlignItems::SELF_START),
        Some("self-end") => Some(AlignItems::SELF_END),
        Some("center") => Some(AlignItems::CENTER),
        Some("stretch") => Some(AlignItems::STRETCH),
        Some("baseline") => Some(AlignItems::BASELINE),
        // CSS's `normal`: `stretch` for items without an aspect ratio.
        Some("normal") => Some(AlignItems::NORMAL),
        Some(_) => return Err(StyleError::InvalidValue),
    })
}

/// `alignContent` / `justifyContent`; unset (null, `normal`) is CSS's
/// `normal`, which [`resolve_normal_alignment`] makes React Native's
/// `flex-start` outside grids.
fn align_content(v: StyleValue<'_>) -> Result<AlignContent, StyleError> {
    Ok(match keyword(v)? {
        None | Some("normal") => AlignContent::NORMAL,
        Some("flex-start") => AlignContent::FLEX_START,
        Some("flex-end") => AlignContent::FLEX_END,
        Some("start") => AlignContent::START,
        Some("end") => AlignContent::END,
        Some("center") => AlignContent::CENTER,
        Some("stretch") => AlignContent::STRETCH,
        Some("space-between") => AlignContent::SPACE_BETWEEN,
        Some("space-around") => AlignContent::SPACE_AROUND,
        Some("space-evenly") => AlignContent::SPACE_EVENLY,
        Some(_) => return Err(StyleError::InvalidValue),
    })
}

fn font_weight(v: StyleValue<'_>) -> Result<Option<u16>, StyleError> {
    Ok(match v {
        StyleValue::Null => None,
        StyleValue::Number(n) => Some((n as u16).clamp(100, 900)),
        StyleValue::Str("normal") => Some(400),
        StyleValue::Str("bold") => Some(700),
        StyleValue::Str(s) => Some(
            s.parse::<u16>()
                .map_err(|_| StyleError::InvalidValue)?
                .clamp(100, 900),
        ),
    })
}

/// A length in points from a number or a string (`"2px"`, `"0.5rem"`).
fn length_value(v: StyleValue<'_>, default: f32) -> Result<f32, StyleError> {
    match v {
        StyleValue::Number(n) => Ok(n),
        StyleValue::Str(s) => css::length(s).ok_or(StyleError::InvalidValue),
        StyleValue::Null => Ok(default),
    }
}

/// Milliseconds from a number or `"150ms"` / `"0.2s"`.
fn duration(v: StyleValue<'_>) -> Result<f32, StyleError> {
    match v {
        StyleValue::Number(n) => Ok(n.max(0.0)),
        StyleValue::Null => Ok(0.0),
        StyleValue::Str(s) => {
            let s = s.trim();
            let ms = if let Some(n) = s.strip_suffix("ms") {
                css::number(n)
            } else if let Some(n) = s.strip_suffix('s') {
                css::number(n).map(|n| n * 1000.0)
            } else {
                css::number(s)
            };
            ms.map(|n| n.max(0.0)).ok_or(StyleError::InvalidValue)
        }
    }
}

/// A CSS timing function as cubic Bézier control points.
fn timing_function(v: StyleValue<'_>) -> Result<[f32; 4], StyleError> {
    let Some(s) = keyword(v)? else {
        return Ok(Transition::EASE);
    };
    Ok(match s.trim() {
        "linear" => [0.0, 0.0, 1.0, 1.0],
        "ease" => Transition::EASE,
        "ease-in" => [0.42, 0.0, 1.0, 1.0],
        "ease-out" => [0.0, 0.0, 0.58, 1.0],
        "ease-in-out" => [0.42, 0.0, 0.58, 1.0],
        s => {
            let args = s
                .strip_prefix("cubic-bezier(")
                .and_then(|a| a.strip_suffix(')'))
                .ok_or(StyleError::InvalidValue)?;
            let n: Vec<f32> = args.split(',').filter_map(css::number).collect();
            let [a, b, c, d] = n.as_slice() else {
                return Err(StyleError::InvalidValue);
            };
            [*a, *b, *c, *d]
        }
    })
}

/// `transitionProperty`: CSS property names, mapped to the groups that
/// transition natively.
fn transition_properties(s: &str) -> Option<TransitionProps> {
    let mut bits = 0;
    for name in s.split(',').map(str::trim) {
        bits |= match name {
            "all" => TransitionProps::ALL,
            "none" => 0,
            "color"
            | "colors"
            | "background-color"
            | "backgroundColor"
            | "border-color"
            | "borderColor"
            | "outline-color"
            | "text-decoration-color"
            | "fill"
            | "stroke"
            | "--tw-gradient-from"
            | "--tw-gradient-via"
            | "--tw-gradient-to" => TransitionProps::COLORS,
            "opacity" => TransitionProps::OPACITY,
            "transform" | "translate" | "scale" | "rotate" => TransitionProps::TRANSFORM,
            "box-shadow" | "boxShadow" | "shadow" => TransitionProps::SHADOW,
            "border-radius" | "borderRadius" | "border-width" | "borderWidth" => {
                TransitionProps::SHAPE
            }
            // Properties that do not animate natively.
            "filter" | "backdrop-filter" | "display" | "visibility" | "content-visibility"
            | "overlay" | "pointer-events" => 0,
            _ => return None,
        };
    }
    Some(TransitionProps(bits))
}

fn grid_value<T>(
    v: StyleValue<'_>,
    parse: impl Fn(&str) -> Option<Vec<T>>,
) -> Result<Vec<T>, StyleError> {
    match keyword(v)? {
        None => Ok(Vec::new()),
        Some(s) => parse(s).ok_or(StyleError::InvalidValue),
    }
}

fn grid_template(v: StyleValue<'_>) -> Result<grid::Template, StyleError> {
    match keyword(v)? {
        None => Ok((Vec::new(), Vec::new())),
        Some(s) => grid::template(s).ok_or(StyleError::InvalidValue),
    }
}

fn grid_placement(v: StyleValue<'_>) -> Result<taffy::GridPlacement<String>, StyleError> {
    match v {
        StyleValue::Null => Ok(taffy::GridPlacement::Auto),
        StyleValue::Number(n) => {
            grid::placement(&(n as i32).to_string()).ok_or(StyleError::InvalidValue)
        }
        StyleValue::Str(s) => grid::placement(s).ok_or(StyleError::InvalidValue),
    }
}

fn grid_line(v: StyleValue<'_>) -> Result<taffy::Line<taffy::GridPlacement<String>>, StyleError> {
    match v {
        StyleValue::Null => Ok(taffy::Line {
            start: taffy::GridPlacement::Auto,
            end: taffy::GridPlacement::Auto,
        }),
        StyleValue::Number(n) => {
            grid::line(&(n as i32).to_string()).ok_or(StyleError::InvalidValue)
        }
        StyleValue::Str(s) => grid::line(s).ok_or(StyleError::InvalidValue),
    }
}

impl Style {
    /// Changes the effects lists (copying them if shared).
    pub fn edit_effects(&mut self, f: impl FnOnce(&mut Effects)) {
        let mut effects = self
            .view
            .effects
            .take()
            .map(|e| (*e).clone())
            .unwrap_or_default();
        f(&mut effects);
        self.view.effects = crate::effects::shared(effects);
    }

    /// Sets the box shadows (top layer first).
    pub fn set_box_shadows(&mut self, shadows: Vec<BoxShadow>) {
        self.edit_effects(|e| e.box_shadows = shadows);
    }

    /// Sets the gradient backgrounds (top layer first).
    pub fn set_background_images(&mut self, images: Vec<Gradient>) {
        self.edit_effects(|e| e.background_images = images);
    }

    /// Sets the filters.
    pub fn set_filters(&mut self, filters: Vec<Filter>, backdrop: bool) {
        self.edit_effects(|e| {
            if backdrop {
                e.backdrop_filters = filters;
            } else {
                e.filters = filters;
            }
        });
    }

    fn transition_mut(&mut self) -> &mut Transition {
        self.view.transition.get_or_insert(Transition {
            properties: TransitionProps(TransitionProps::ALL),
            duration: 0.0,
            delay: 0.0,
            easing: Transition::EASE,
        })
    }

    /// Appends an entry to the `transform` list (`translateX`, `scale`,
    /// ...); rotations and skews are degrees (`"45deg"` strings are parsed
    /// by the caller). Returns the entry's index.
    pub fn push_transform(&mut self, key: &str, value: f32) -> Result<u8, StyleError> {
        let kind = TransformKind::parse(key).ok_or(StyleError::UnknownProperty)?;
        self.view
            .transform
            .push(kind, value)
            .ok_or(StyleError::InvalidValue)
    }

    /// Sets `shadowOffset: { width, height }`; `None` restores the default.
    pub fn set_shadow_offset(&mut self, offset: Option<Point<Points>>) {
        let offset =
            offset.unwrap_or_else(|| point(Shadow::DEFAULT.offset_x, Shadow::DEFAULT.offset_y));
        self.view.shadow.offset_x = offset.x;
        self.view.shadow.offset_y = offset.y;
    }

    /// Sets `textShadowOffset: { width, height }`.
    pub fn set_text_shadow_offset(&mut self, offset: Option<Point<Points>>) {
        self.text.shadow_offset = offset;
    }

    fn set_border_width(
        &mut self,
        sides: &[usize],
        value: StyleValue<'_>,
    ) -> Result<(), StyleError> {
        let w = px(number(value, 0.0)?.max(0.0));
        for &side in sides {
            self.pending.border_widths[side] = w;
            if !self.pending.border_hidden {
                self.set_used_border_width(side, w);
            }
        }
        Ok(())
    }

    /// The width side `side` lays out and draws with.
    fn set_used_border_width(&mut self, side: usize, w: Points) {
        *self.view.borders.width_mut(side) = w;
        let v = LengthPercentage::length(w.0);
        let b = &mut self.layout.border;
        match side {
            0 => b.top = v,
            1 => b.right = v,
            2 => b.bottom = v,
            _ => b.left = v,
        }
    }

    fn set_logical_border_width(
        &mut self,
        i: usize,
        value: StyleValue<'_>,
    ) -> Result<(), StyleError> {
        let w = opt_points(value)?.map(|w| w.max(Points::ZERO));
        self.pending.border_logical[i] = w;
        if !self.pending.border_hidden {
            self.logical.border_width[i] = w;
        }
        Ok(())
    }

    fn set_border_color(
        &mut self,
        sides: &[usize],
        value: StyleValue<'_>,
    ) -> Result<(), StyleError> {
        let c = color(value)?.unwrap_or(Color::BLACK);
        for &side in sides {
            self.view.borders.colors[side] = c;
        }
        Ok(())
    }

    /// Sets color property `key` (`borderColor`, `outlineColor`) to `color`;
    /// other keys are left as they are.
    pub(crate) fn set_color(&mut self, key: StyleKey, color: Color) {
        match key {
            StyleKey::BorderColor => self.view.borders.colors = [color; 4],
            StyleKey::OutlineColor => self.view.outline.color = color,
            StyleKey::BackgroundColor => self.view.background_color = color,
            StyleKey::BorderTopColor => self.view.borders.colors[0] = color,
            StyleKey::BorderRightColor => self.view.borders.colors[1] = color,
            StyleKey::BorderBottomColor => self.view.borders.colors[2] = color,
            StyleKey::BorderLeftColor => self.view.borders.colors[3] = color,
            StyleKey::BorderStartColor => self.logical.border_color[0] = Some(color),
            StyleKey::BorderEndColor => self.logical.border_color[1] = Some(color),
            StyleKey::TextDecorationColor => self.text.decoration_color = Some(color),
            _ => debug_assert!(false, "set_color({key:?})"),
        }
    }

    /// Sets one property using its React Native name.
    pub fn set(&mut self, key: &str, value: StyleValue<'_>) -> Result<(), StyleError> {
        self.set_key(
            StyleKey::parse(key).ok_or(StyleError::UnknownProperty)?,
            value,
        )
    }

    /// Sets one property.
    pub fn set_key(&mut self, key: StyleKey, value: StyleValue<'_>) -> Result<(), StyleError> {
        let l = &mut self.layout;
        match key {
            // Layout
            StyleKey::Display => {
                l.display = match keyword(value)? {
                    None | Some("flex") => Display::Flex,
                    Some("grid") => Display::Grid,
                    Some("block") => Display::Block,
                    Some("flow-root") => Display::FlowRoot,
                    Some("none") => Display::None,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::BoxSizing => {
                l.box_sizing = match keyword(value)? {
                    None | Some("border-box") => taffy::BoxSizing::BorderBox,
                    Some("content-box") => taffy::BoxSizing::ContentBox,
                    _ => return Err(StyleError::InvalidValue),
                };
            }
            StyleKey::Position => {
                let (position, fixed, sticky) = match keyword(value)? {
                    None | Some("relative") => (Position::Relative, false, false),
                    Some("absolute") => (Position::Absolute, false, false),
                    Some("fixed") => (Position::Fixed, true, false),
                    Some("static") => (Position::Static, false, false),
                    Some("sticky") => (Position::Relative, false, true),
                    Some(_) => return Err(StyleError::InvalidValue),
                };
                l.position = position;
                self.pending.fixed_position = fixed;
                self.pending.sticky_position = sticky;
            }
            StyleKey::FlexDirection => {
                l.flex_direction = match keyword(value)? {
                    None | Some("column") => FlexDirection::Column,
                    Some("row") => FlexDirection::Row,
                    Some("column-reverse") => FlexDirection::ColumnReverse,
                    Some("row-reverse") => FlexDirection::RowReverse,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::FlexWrap => {
                l.flex_wrap = match keyword(value)? {
                    None | Some("nowrap") => FlexWrap::NoWrap,
                    Some("wrap") => FlexWrap::Wrap,
                    Some("wrap-reverse") => FlexWrap::WrapReverse,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::Flex => {
                // React Native semantics, not the CSS shorthand.
                let f = number(value, 0.0)?;
                if f > 0.0 {
                    l.flex_grow = f;
                    l.flex_shrink = 1.0;
                    l.flex_basis = Dimension::length(0.0);
                } else if f < 0.0 {
                    l.flex_grow = 0.0;
                    l.flex_shrink = -f;
                    l.flex_basis = Dimension::auto();
                } else {
                    l.flex_grow = 0.0;
                    l.flex_shrink = 0.0;
                    l.flex_basis = Dimension::auto();
                }
            }
            StyleKey::FlexGrow => l.flex_grow = number(value, 0.0)?,
            StyleKey::FlexShrink => l.flex_shrink = number(value, 0.0)?,
            StyleKey::FlexBasis => l.flex_basis = dimension(value)?,
            StyleKey::JustifyContent => l.justify_content = align_content(value)?,
            StyleKey::AlignItems => {
                l.align_items = align_items(value)?.unwrap_or(AlignItems::STRETCH)
            }
            StyleKey::AlignSelf => {
                l.align_self = match value {
                    StyleValue::Str("auto") => None,
                    v => align_items(v)?,
                }
            }
            StyleKey::AlignContent => l.align_content = align_content(value)?,
            StyleKey::Width => l.size.width = dimension(value)?,
            StyleKey::Height => l.size.height = dimension(value)?,
            StyleKey::MinWidth => l.min_size.width = min_len(value)?,
            StyleKey::MinHeight => l.min_size.height = min_len(value)?,
            StyleKey::MaxWidth => l.max_size.width = Len::parse(value)?.lpa(),
            StyleKey::MaxHeight => l.max_size.height = Len::parse(value)?.lpa(),
            StyleKey::AspectRatio => l.aspect_ratio = opt_number(value)?,
            StyleKey::Top => l.inset.top = Len::parse(value)?.lpa(),
            StyleKey::Right => l.inset.right = Len::parse(value)?.lpa(),
            StyleKey::Bottom => l.inset.bottom = Len::parse(value)?.lpa(),
            StyleKey::Left => l.inset.left = Len::parse(value)?.lpa(),
            StyleKey::Margin => {
                let (v, e) = margin_edge(value)?;
                l.margin = taffy::Rect {
                    left: v,
                    right: v,
                    top: v,
                    bottom: v,
                };
                self.pending.env.margin = [e; 4];
            }
            StyleKey::MarginHorizontal => {
                let (v, e) = margin_edge(value)?;
                (l.margin.left, l.margin.right) = (v, v);
                (self.pending.env.margin[1], self.pending.env.margin[3]) = (e, e);
            }
            StyleKey::MarginVertical => {
                let (v, e) = margin_edge(value)?;
                (l.margin.top, l.margin.bottom) = (v, v);
                (self.pending.env.margin[0], self.pending.env.margin[2]) = (e, e);
            }
            StyleKey::MarginTop => (l.margin.top, self.pending.env.margin[0]) = margin_edge(value)?,
            StyleKey::MarginRight => {
                (l.margin.right, self.pending.env.margin[1]) = margin_edge(value)?
            }
            StyleKey::MarginBottom => {
                (l.margin.bottom, self.pending.env.margin[2]) = margin_edge(value)?
            }
            StyleKey::MarginLeft => {
                (l.margin.left, self.pending.env.margin[3]) = margin_edge(value)?
            }
            StyleKey::Padding => {
                let (v, e) = padding_edge(value)?;
                l.padding = taffy::Rect {
                    left: v,
                    right: v,
                    top: v,
                    bottom: v,
                };
                self.pending.env.padding = [e; 4];
            }
            StyleKey::PaddingHorizontal => {
                let (v, e) = padding_edge(value)?;
                (l.padding.left, l.padding.right) = (v, v);
                (self.pending.env.padding[1], self.pending.env.padding[3]) = (e, e);
            }
            StyleKey::PaddingVertical => {
                let (v, e) = padding_edge(value)?;
                (l.padding.top, l.padding.bottom) = (v, v);
                (self.pending.env.padding[0], self.pending.env.padding[2]) = (e, e);
            }
            StyleKey::PaddingTop => {
                (l.padding.top, self.pending.env.padding[0]) = padding_edge(value)?
            }
            StyleKey::PaddingRight => {
                (l.padding.right, self.pending.env.padding[1]) = padding_edge(value)?
            }
            StyleKey::PaddingBottom => {
                (l.padding.bottom, self.pending.env.padding[2]) = padding_edge(value)?
            }
            StyleKey::PaddingLeft => {
                (l.padding.left, self.pending.env.padding[3]) = padding_edge(value)?
            }
            StyleKey::Gap => {
                let v = lp_or_zero(value)?;
                l.gap = taffy::Size {
                    width: v,
                    height: v,
                };
            }
            StyleKey::RowGap => l.gap.height = lp_or_zero(value)?,
            StyleKey::ColumnGap => l.gap.width = lp_or_zero(value)?,
            StyleKey::BorderWidth => self.set_border_width(&[0, 1, 2, 3], value)?,
            StyleKey::BorderTopWidth => self.set_border_width(&[0], value)?,
            StyleKey::BorderRightWidth => self.set_border_width(&[1], value)?,
            StyleKey::BorderBottomWidth => self.set_border_width(&[2], value)?,
            StyleKey::BorderLeftWidth => self.set_border_width(&[3], value)?,
            StyleKey::ZIndex => self.z_index = number(value, 0.0)? as i32,
            StyleKey::VerticalAlign => {
                self.vertical_align = match keyword(value)? {
                    None => VerticalAlign::Baseline,
                    Some(k) => VerticalAlign::parse(k).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::Direction => {
                self.direction = match keyword(value)? {
                    None | Some("inherit") => None,
                    Some("ltr") => Some(false),
                    Some("rtl") => Some(true),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::MarginStart => self.logical.margin[0] = opt_lpa(value)?,
            StyleKey::MarginEnd => self.logical.margin[1] = opt_lpa(value)?,
            StyleKey::PaddingStart => self.logical.padding[0] = opt_lp(value)?,
            StyleKey::PaddingEnd => self.logical.padding[1] = opt_lp(value)?,
            StyleKey::Start => self.logical.inset[0] = opt_lpa(value)?,
            StyleKey::End => self.logical.inset[1] = opt_lpa(value)?,
            StyleKey::BorderStartWidth => self.set_logical_border_width(0, value)?,
            StyleKey::BorderEndWidth => self.set_logical_border_width(1, value)?,
            StyleKey::BorderStartColor => self.logical.border_color[0] = color(value)?,
            StyleKey::BorderEndColor => self.logical.border_color[1] = color(value)?,
            StyleKey::BorderTopStartRadius => self.logical.radius[0] = opt_points(value)?,
            StyleKey::BorderTopEndRadius => self.logical.radius[1] = opt_points(value)?,
            StyleKey::BorderBottomEndRadius => self.logical.radius[2] = opt_points(value)?,
            StyleKey::BorderBottomStartRadius => self.logical.radius[3] = opt_points(value)?,

            // View
            StyleKey::BackgroundColor => {
                self.view.background_color = color(value)?.unwrap_or(Color::TRANSPARENT)
            }
            StyleKey::BorderRadius => self.view.border_radius = px(number(value, 0.0)?),
            StyleKey::BorderTopLeftRadius => self.view.corner_radius.top_left = opt_points(value)?,
            StyleKey::BorderTopRightRadius => {
                self.view.corner_radius.top_right = opt_points(value)?
            }
            StyleKey::BorderBottomRightRadius => {
                self.view.corner_radius.bottom_right = opt_points(value)?
            }
            StyleKey::BorderBottomLeftRadius => {
                self.view.corner_radius.bottom_left = opt_points(value)?
            }
            StyleKey::ShadowColor => {
                self.view.shadow.color = color(value)?.unwrap_or(Shadow::DEFAULT.color)
            }
            StyleKey::ShadowOpacity => {
                self.view.shadow.opacity = number(value, Shadow::DEFAULT.opacity)?.clamp(0.0, 1.0)
            }
            StyleKey::ShadowRadius => {
                self.view.shadow.radius = px(number(value, Shadow::DEFAULT.radius.0)?.max(0.0))
            }
            StyleKey::BorderColor => self.set_border_color(&[0, 1, 2, 3], value)?,
            StyleKey::BorderTopColor => self.set_border_color(&[0], value)?,
            StyleKey::BorderRightColor => self.set_border_color(&[1], value)?,
            StyleKey::BorderBottomColor => self.set_border_color(&[2], value)?,
            StyleKey::BorderLeftColor => self.set_border_color(&[3], value)?,
            StyleKey::BorderStyle => {
                // `none` (and `hidden`, the same outside tables) draws and
                // lays out no border whatever the widths, set before or
                // after it (CSS).
                let (style, hidden) = match keyword(value)? {
                    None | Some("solid") => (BorderStyle::Solid, false),
                    Some("dashed") => (BorderStyle::Dashed, false),
                    Some("dotted") => (BorderStyle::Dotted, false),
                    Some("none") | Some("hidden") => (BorderStyle::Solid, true),
                    Some(_) => return Err(StyleError::InvalidValue),
                };
                self.view.borders.style = style;
                if hidden != self.pending.border_hidden {
                    self.pending.border_hidden = hidden;
                    for side in 0..4 {
                        let w = if hidden {
                            Points::ZERO
                        } else {
                            self.pending.border_widths[side]
                        };
                        self.set_used_border_width(side, w);
                    }
                    self.logical.border_width = if hidden {
                        [None; 2]
                    } else {
                        self.pending.border_logical
                    };
                }
            }
            StyleKey::BorderCurve => {
                self.view.continuous_corners = match keyword(value)? {
                    None | Some("circular") => false,
                    Some("continuous") => true,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::TintColor => self.view.tint_color = color(value)?,
            StyleKey::ObjectPosition => {
                self.view.object_position = match keyword(value)? {
                    None => ObjectPosition::CENTER,
                    Some(s) => ObjectPosition::parse(s).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::BackfaceVisibility => {
                self.view.backface_hidden = match keyword(value)? {
                    None | Some("visible") => false,
                    Some("hidden") => true,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::TransformOrigin => {
                self.view.transform_origin = match keyword(value)? {
                    None => TransformOrigin::CENTER,
                    Some(s) => TransformOrigin::parse(s).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::Opacity => self.view.opacity = number(value, 1.0)?.clamp(0.0, 1.0),
            StyleKey::Overflow => {
                self.view.overflow_hidden = match keyword(value)? {
                    None | Some("visible") => false,
                    Some("hidden") => true,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }

            // Text
            StyleKey::Color => self.text.color = color(value)?,
            StyleKey::Fill => self.paint.fill = svg_paint(value)?,
            StyleKey::Stroke => self.paint.stroke = svg_paint(value)?,
            StyleKey::StrokeWidth => {
                self.paint.stroke_width = match value {
                    StyleValue::Null => None,
                    StyleValue::Number(n) if n >= 0.0 => Some(px(n)),
                    StyleValue::Str(s) => match css::length(s) {
                        Some(n) if n >= 0.0 => Some(px(n)),
                        _ => return Err(StyleError::InvalidValue),
                    },
                    StyleValue::Number(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::StrokeDasharray => self.paint.stroke_dasharray = dasharray(value)?,
            StyleKey::FontSize => self.text.font_size = opt_points(value)?,
            StyleKey::FontWeight => self.text.font_weight = font_weight(value)?,
            StyleKey::LineHeight => {
                // Numbers are points (React Native); strings may be a
                // multiple of the font size (`"1.5"`, `"1.5em"`) or points.
                let (points, multiple, em) = match value {
                    StyleValue::Str(s)
                        if s.ends_with("px") || s.ends_with("pt") || s.ends_with("rem") =>
                    {
                        (
                            Some(px(css::length(s).ok_or(StyleError::InvalidValue)?)),
                            None,
                            None,
                        )
                    }
                    StyleValue::Str(s) if s.ends_with('%') || s.ends_with("em") => {
                        let n = if let Some(n) = s.strip_suffix('%') {
                            css::number(n).map(|n| n / 100.0)
                        } else {
                            css::number(s.strip_suffix("em").unwrap())
                        }
                        .filter(|n| *n >= 0.0)
                        .ok_or(StyleError::InvalidValue)?;
                        (None, None, Some(n))
                    }
                    StyleValue::Str(s) => {
                        let n = css::number(s)
                            .filter(|n| *n >= 0.0)
                            .ok_or(StyleError::InvalidValue)?;
                        (None, Some(n), None)
                    }
                    v => (opt_points(v)?, None, None),
                };
                self.text.line_height = points;
                self.text.line_height_multiple = multiple;
                self.text.line_height_em = em;
            }
            StyleKey::FontFamily => {
                self.text.font_family = keyword(value)?.map(|name| FontFamily::new(name.trim()))
            }
            StyleKey::FontStyle => {
                self.text.italic = match keyword(value)? {
                    None => None,
                    Some("normal") => Some(false),
                    Some("italic") => Some(true),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::LetterSpacing => {
                let (points, em) = match value {
                    StyleValue::Str(s) if s.ends_with("em") && !s.ends_with("rem") => {
                        let n = css::number(&s[..s.len() - 2]).ok_or(StyleError::InvalidValue)?;
                        (None, Some(n))
                    }
                    StyleValue::Str(s) => (
                        Some(px(css::length(s).ok_or(StyleError::InvalidValue)?)),
                        None,
                    ),
                    v => (opt_points(v)?, None),
                };
                self.text.letter_spacing = points;
                self.text.letter_spacing_em = em;
            }
            StyleKey::TextDecorationLine => {
                self.text.decoration = match keyword(value)? {
                    None => None,
                    Some(words) => {
                        let mut d = TextDecoration::default();
                        for word in words.split_whitespace() {
                            match word {
                                "none" => {}
                                "underline" => d.underline = true,
                                "line-through" => d.line_through = true,
                                _ => return Err(StyleError::InvalidValue),
                            }
                        }
                        Some(d)
                    }
                }
            }
            StyleKey::TextDecorationColor => self.text.decoration_color = color(value)?,
            StyleKey::PlaceholderColor => self.text.placeholder_color = color(value)?,
            StyleKey::SelectionColor => self.text.selection_color = color(value)?,
            StyleKey::TextAlignVertical => {
                self.text.align_vertical = match keyword(value)? {
                    None => None,
                    Some("auto" | "top") => Some(percentage(0.0)),
                    Some("center") => Some(percentage(0.5)),
                    Some("bottom") => Some(percentage(1.0)),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::WritingDirection => {
                self.text.writing_direction = match keyword(value)? {
                    None | Some("auto") => None,
                    Some("ltr") => Some(false),
                    Some("rtl") => Some(true),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::FontVariant => {
                self.text.font_variant = match keyword(value)? {
                    None => None,
                    Some(s) => Some(FontVariant::parse(s).ok_or(StyleError::InvalidValue)?),
                }
            }
            StyleKey::TextShadowColor => self.text.shadow_color = color(value)?,
            StyleKey::TextShadowRadius => self.text.shadow_radius = opt_points(value)?,
            StyleKey::TextTransform => {
                self.text.transform = match keyword(value)? {
                    None => None,
                    Some("none") => Some(TextTransform::None),
                    Some("uppercase") => Some(TextTransform::Uppercase),
                    Some("lowercase") => Some(TextTransform::Lowercase),
                    Some("capitalize") => Some(TextTransform::Capitalize),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::TextAlign => {
                self.text.text_align_physical = false;
                self.text.text_align = match keyword(value)? {
                    None => None,
                    Some("auto") => Some(TextAlign::Auto),
                    Some("left") => Some(TextAlign::Left),
                    Some("center") => Some(TextAlign::Center),
                    Some("right") => Some(TextAlign::Right),
                    Some("justify") => Some(TextAlign::Justify),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }

            // Effects
            StyleKey::BoxShadow => {
                let list = match keyword(value)? {
                    None => Vec::new(),
                    Some(s) => css::box_shadows(s).ok_or(StyleError::InvalidValue)?,
                };
                self.edit_effects(|e| e.box_shadows = list);
            }
            StyleKey::BackgroundImage => {
                let list = match keyword(value)? {
                    None => Vec::new(),
                    Some(s) => css::gradients(s).ok_or(StyleError::InvalidValue)?,
                };
                self.edit_effects(|e| e.background_images = list);
            }
            StyleKey::MaskImage => {
                let list = match keyword(value)? {
                    None => Vec::new(),
                    Some("none") => Vec::new(),
                    Some(s) => css::gradients(s).ok_or(StyleError::InvalidValue)?,
                };
                self.edit_effects(|e| e.mask_images = list);
            }
            StyleKey::Filter => {
                let list = match keyword(value)? {
                    None => Vec::new(),
                    Some(s) => css::filters(s).ok_or(StyleError::InvalidValue)?,
                };
                self.edit_effects(|e| e.filters = list);
            }
            StyleKey::BackdropFilter => {
                let list = match keyword(value)? {
                    None => Vec::new(),
                    Some(s) => css::filters(s).ok_or(StyleError::InvalidValue)?,
                };
                self.edit_effects(|e| e.backdrop_filters = list);
            }
            StyleKey::GlassEffect => {
                self.view.glass_effect = match keyword(value)? {
                    None => GlassEffect::None,
                    Some(s) => GlassEffect::parse(s).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::MixBlendMode => {
                self.view.blend_mode = match keyword(value)? {
                    None => BlendMode::Normal,
                    Some(s) => BlendMode::parse(s).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::OutlineWidth => {
                let width = px(length_value(value, 0.0)?.max(0.0));
                self.pending.outline_width = width;
                if !self.pending.outline_hidden {
                    self.view.outline.width = width;
                }
            }
            StyleKey::OutlineColor => {
                self.view.outline.color = color(value)?.unwrap_or(Outline::NONE.color)
            }
            StyleKey::OutlineOffset => self.view.outline.offset = px(length_value(value, 0.0)?),
            StyleKey::OutlineStyle => {
                // `none` draws no outline whatever the width, set before
                // or after it (CSS).
                let (style, hidden) = match keyword(value)? {
                    None | Some("solid") => (BorderStyle::Solid, false),
                    Some("dashed") => (BorderStyle::Dashed, false),
                    Some("dotted") => (BorderStyle::Dotted, false),
                    Some("none") | Some("hidden") => (BorderStyle::Solid, true),
                    Some(_) => return Err(StyleError::InvalidValue),
                };
                self.view.outline.style = style;
                self.pending.outline_hidden = hidden;
                self.view.outline.width = if hidden {
                    Points::ZERO
                } else {
                    self.pending.outline_width
                };
            }
            StyleKey::Visibility => {
                self.view.hidden = match keyword(value)? {
                    None | Some("visible") => false,
                    Some("hidden") | Some("collapse") => true,
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::Cursor => {
                self.view.cursor = match keyword(value)? {
                    None => Cursor::Auto,
                    Some(s) => Cursor::parse(s).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::TransitionProperty => {
                let props = match keyword(value)? {
                    None => TransitionProps(TransitionProps::ALL),
                    Some(s) => transition_properties(s).ok_or(StyleError::InvalidValue)?,
                };
                self.transition_mut().properties = props;
            }
            StyleKey::TransitionDuration => {
                let ms = duration(value)?;
                self.transition_mut().duration = ms;
            }
            StyleKey::TransitionDelay => {
                let ms = duration(value)?;
                self.transition_mut().delay = ms;
            }
            StyleKey::TransitionTimingFunction => {
                let easing = timing_function(value)?;
                self.transition_mut().easing = easing;
            }
            StyleKey::AnimationName => {
                let keyframes = match keyword(value)? {
                    None | Some("none") => None,
                    Some("spin") => Some(Keyframes::Spin),
                    Some("ping") => Some(Keyframes::Ping),
                    Some("pulse") => Some(Keyframes::Pulse),
                    Some("bounce") => Some(Keyframes::Bounce),
                    Some(_) => return Err(StyleError::InvalidValue),
                };
                // An animation already running (a class's) keeps its
                // values; a new one takes those set before its name.
                let pending = self.pending;
                self.view.animation = keyframes.map(|keyframes| {
                    let base = self
                        .view
                        .animation
                        .unwrap_or_else(|| pending.animation(KeyframeAnimation::new(keyframes)));
                    KeyframeAnimation { keyframes, ..base }
                });
            }
            StyleKey::AnimationDuration => {
                let ms = duration(value)?;
                self.pending.animation_duration = Some(ms);
                if let Some(a) = self.view.animation.as_mut() {
                    a.duration = ms;
                }
            }
            StyleKey::AnimationDelay => {
                let ms = duration(value)?;
                self.pending.animation_delay = Some(ms);
                if let Some(a) = self.view.animation.as_mut() {
                    a.delay = ms;
                }
            }
            StyleKey::AnimationTimingFunction => {
                let easing = timing_function(value)?;
                self.pending.animation_easing = Some(easing);
                if let Some(a) = self.view.animation.as_mut() {
                    a.easing = easing;
                }
            }
            StyleKey::AnimationIterationCount => {
                let count = match value {
                    StyleValue::Str("infinite") | StyleValue::Null => None,
                    v => Some(number(v, 1.0)?.max(0.0) as u32),
                };
                self.pending.animation_iterations = Some(count);
                if let Some(a) = self.view.animation.as_mut() {
                    a.iterations = count;
                }
            }
            StyleKey::TextDecorationStyle => {
                self.text.decoration_style = match keyword(value)? {
                    None => None,
                    Some("solid") => Some(DecorationStyle::Solid),
                    Some("double") => Some(DecorationStyle::Double),
                    Some("dotted") => Some(DecorationStyle::Dotted),
                    Some("dashed") => Some(DecorationStyle::Dashed),
                    Some("wavy") => Some(DecorationStyle::Wavy),
                    Some(_) => return Err(StyleError::InvalidValue),
                }
            }
            StyleKey::TextDecorationThickness => {
                self.text.decoration_thickness = match value {
                    StyleValue::Null | StyleValue::Str("auto") | StyleValue::Str("from-font") => {
                        None
                    }
                    v => Some(px(length_value(v, 1.0)?.max(0.0))),
                }
            }
            StyleKey::TextUnderlineOffset => {
                self.text.underline_offset = match value {
                    StyleValue::Null | StyleValue::Str("auto") => None,
                    v => Some(px(length_value(v, 0.0)?)),
                }
            }

            // Grid
            StyleKey::GridTemplateColumns => {
                (l.grid_template_columns, l.grid_template_column_names) = grid_template(value)?;
            }
            StyleKey::GridTemplateRows => {
                (l.grid_template_rows, l.grid_template_row_names) = grid_template(value)?;
            }
            StyleKey::GridAutoColumns => {
                l.grid_auto_columns = grid_value(value, grid::auto_tracks)?;
            }
            StyleKey::GridAutoRows => {
                l.grid_auto_rows = grid_value(value, grid::auto_tracks)?;
            }
            StyleKey::GridAutoFlow => {
                l.grid_auto_flow = match keyword(value)? {
                    None => taffy::GridAutoFlow::Row,
                    Some(s) => grid::auto_flow(s).ok_or(StyleError::InvalidValue)?,
                }
            }
            StyleKey::GridColumn => l.grid_column = grid_line(value)?,
            StyleKey::GridRow => l.grid_row = grid_line(value)?,
            StyleKey::GridColumnStart => l.grid_column.start = grid_placement(value)?,
            StyleKey::GridColumnEnd => l.grid_column.end = grid_placement(value)?,
            StyleKey::GridRowStart => l.grid_row.start = grid_placement(value)?,
            StyleKey::GridRowEnd => l.grid_row.end = grid_placement(value)?,
            StyleKey::JustifyItems => {
                l.justify_items = align_items(value)?.unwrap_or(AlignItems::STRETCH);
            }
            StyleKey::JustifySelf => {
                l.justify_self = match value {
                    StyleValue::Str("auto") => None,
                    v => align_items(v)?,
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{relative, size};

    /// `fill`, `stroke`, `strokeWidth` and `strokeDasharray` take what CSS
    /// takes for them.
    #[test]
    fn svg_paint_properties() {
        let mut s = Style::default();
        s.set("fill", StyleValue::Str("#ff0000")).unwrap();
        s.set("stroke", StyleValue::Str("currentColor")).unwrap();
        s.set("strokeWidth", StyleValue::Str("2px")).unwrap();
        s.set("strokeDasharray", StyleValue::Str("4, 2 1")).unwrap();
        assert_eq!(s.paint.fill, Some(SvgPaint::Color(Color(0xff00_00ff))));
        assert_eq!(s.paint.stroke, Some(SvgPaint::CurrentColor));
        assert_eq!(s.paint.stroke_width, Some(px(2.0)));
        assert_eq!(
            s.paint.stroke_dasharray.as_deref(),
            Some(&[px(4.0), px(2.0), px(1.0)][..])
        );
        s.set("strokeDasharray", StyleValue::Number(3.0)).unwrap();
        assert_eq!(s.paint.stroke_dasharray.as_deref(), Some(&[px(3.0)][..]));
        // `none`, and dashes that add up to nothing: a solid line.
        for none in ["none", "0 0"] {
            s.set("strokeDasharray", StyleValue::Str(none)).unwrap();
            assert_eq!(s.paint.stroke_dasharray.as_deref(), Some(&[][..]));
        }
        s.set("fill", StyleValue::Str("none")).unwrap();
        assert_eq!(s.paint.fill, Some(SvgPaint::None));
        // Negative lengths are invalid, as in CSS.
        assert!(s.set("strokeWidth", StyleValue::Number(-1.0)).is_err());
        assert!(s.set("strokeDasharray", StyleValue::Str("4 -2")).is_err());
        assert!(s.set("fill", StyleValue::Str("nope")).is_err());
        s.set("stroke", StyleValue::Null).unwrap();
        assert_eq!(s.paint.stroke, None);
    }

    #[test]
    fn parse_colors() {
        assert_eq!(Color::parse("#fff"), Some(Color(0xffff_ffff)));
        assert_eq!(Color::parse("#f008"), Some(Color(0xff00_0088)));
        assert_eq!(Color::parse("#123456"), Some(Color(0x1234_56ff)));
        assert_eq!(Color::parse("#12345678"), Some(Color(0x1234_5678)));
        assert_eq!(Color::parse("rgb(255, 0, 10)"), Some(Color(0xff00_0aff)));
        assert_eq!(Color::parse("rgba(0,0,0,0.5)"), Some(Color(0x0000_0080)));
        assert_eq!(Color::parse("white"), Some(Color(0xffff_ffff)));
        assert_eq!(Color::parse("#12"), None);
        assert_eq!(Color::parse("nope"), None);
    }

    #[test]
    fn env_on_padding_and_margin() {
        use EnvVar::*;
        let mut s = Style::default();
        let k = StyleValue::Str;
        s.set("paddingBottom", k("env(keyboard-inset-height)"))
            .unwrap();
        assert_eq!(
            s.pending.env.padding,
            [None, None, Some(KeyboardInsetHeight), None]
        );
        assert_eq!(s.layout.padding.bottom, LengthPercentage::length(0.0));
        // `calc()` adds a length, on either side.
        s.set("paddingTop", k("calc(env(safe-area-inset-top) + 8px)"))
            .unwrap();
        assert_eq!(s.pending.env.padding[0], Some(SafeAreaInsetTop));
        assert_eq!(s.layout.padding.top, LengthPercentage::length(8.0));
        s.set("marginLeft", k("calc(0.5rem + env(safe-area-inset-left))"))
            .unwrap();
        assert_eq!(s.pending.env.margin[3], Some(SafeAreaInsetLeft));
        assert_eq!(s.layout.margin.left, LengthPercentageAuto::length(8.0));
        // Margins may go below zero.
        s.set("marginBottom", k("calc(env(keyboard-inset-height) + -4px)"))
            .unwrap();
        assert_eq!(s.layout.margin.bottom, LengthPercentageAuto::length(-4.0));
        // Shorthands set every edge they cover.
        s.set("paddingHorizontal", k("env(safe-area-inset-right)"))
            .unwrap();
        assert_eq!(s.pending.env.padding[1], Some(SafeAreaInsetRight));
        assert_eq!(s.pending.env.padding[3], Some(SafeAreaInsetRight));
        s.set("margin", k("env(safe-area-inset-top)")).unwrap();
        assert_eq!(s.pending.env.margin, [Some(SafeAreaInsetTop); 4]);
        // An unknown variable is its fallback.
        s.set("paddingRight", k("env(titlebar-area-x, 12px)"))
            .unwrap();
        assert_eq!(s.pending.env.padding[1], None);
        assert_eq!(s.layout.padding.right, LengthPercentage::length(12.0));
        // A known one ignores its fallback.
        s.set("paddingRight", k("env(safe-area-inset-right, 12px)"))
            .unwrap();
        assert_eq!(s.pending.env.padding[1], Some(SafeAreaInsetRight));
        assert_eq!(s.layout.padding.right, LengthPercentage::length(0.0));
        // A plain value or a reset drops the term.
        s.set("paddingTop", StyleValue::Number(4.0)).unwrap();
        s.set("paddingBottom", StyleValue::Null).unwrap();
        s.set("margin", StyleValue::Null).unwrap();
        assert_eq!(s.pending.env.padding[0], None);
        assert_eq!(s.pending.env.padding[2], None);
        assert_eq!(s.pending.env.margin, [None; 4]);
        // Anything else is rejected.
        for v in [
            "env(titlebar-area-x)",
            "env(safe-area-inset-top) + 8px",
            "calc(env(safe-area-inset-top)+8px)",
            "calc(env(safe-area-inset-top) - 8px)",
            "calc(env(safe-area-inset-top) + env(keyboard-inset-height))",
            "calc(env(safe-area-inset-top) + 10%)",
            "calc(env(safe-area-inset-top) + 1px + 2px)",
            "max(env(safe-area-inset-top), 8px)",
        ] {
            assert_eq!(
                s.set("paddingTop", k(v)),
                Err(StyleError::InvalidValue),
                "{v}"
            );
        }
        // Padding is never negative.
        assert_eq!(
            s.set("paddingTop", k("calc(env(safe-area-inset-top) + -8px)")),
            Err(StyleError::InvalidValue)
        );
        // Only padding and margin's physical edges take `env()`.
        for key in ["paddingStart", "marginEnd", "top", "width", "gap"] {
            assert!(s.set(key, k("env(safe-area-inset-top)")).is_err(), "{key}");
        }
    }

    #[test]
    fn react_native_defaults() {
        let s = Style::default();
        assert_eq!(s.layout.flex_direction, FlexDirection::Column);
        assert_eq!(s.layout.flex_shrink, 0.0);
        assert_eq!(s.layout.position, Position::Relative);
        // Unset: `flex-start` once laid out outside grids.
        assert_eq!(s.layout.align_content, AlignContent::NORMAL);
        let mut layout = s.layout.clone();
        resolve_normal_alignment(&mut layout);
        assert_eq!(layout.align_content, AlignContent::FLEX_START);
        assert_eq!(s.layout.min_size.width, LengthPercentageAuto::length(0.0));
    }

    #[test]
    fn css_alignment_keywords() {
        let mut s = Style::default();
        let k = StyleValue::Str;
        for key in ["alignItems", "alignSelf", "justifyItems", "justifySelf"] {
            for v in ["start", "end", "self-start", "self-end"] {
                s.set(key, k(v)).unwrap();
            }
        }
        assert_eq!(s.layout.justify_self, Some(AlignItems::SELF_END));
        for key in ["alignContent", "justifyContent"] {
            s.set(key, k("end")).unwrap();
            assert_eq!(s.set(key, k("self-end")), Err(StyleError::InvalidValue));
        }
        assert_eq!(s.layout.align_content, AlignContent::END);
        s.set("alignContent", k("normal")).unwrap();
        assert_eq!(s.layout.align_content, AlignContent::NORMAL);
        s.set("justifyContent", StyleValue::Null).unwrap();
        assert_eq!(s.layout.justify_content, AlignContent::NORMAL);
        // A grid keeps CSS's `normal`; other containers take `flex-start`.
        s.set("display", k("grid")).unwrap();
        let mut grid = s.layout.clone();
        resolve_normal_alignment(&mut grid);
        assert_eq!(grid.align_content, AlignContent::NORMAL);
        assert_eq!(
            s.set("gridTemplateColumns", k("[a] 40px [b")),
            Err(StyleError::InvalidValue)
        );
        s.set("gridTemplateRows", k("[a] 40px [b] 1fr")).unwrap();
        assert_eq!(s.layout.grid_template_row_names.len(), 3);
        s.set("gridTemplateRows", StyleValue::Null).unwrap();
        assert!(s.layout.grid_template_row_names.is_empty());
    }

    #[test]
    fn transform_origins() {
        let p = |s| TransformOrigin::parse(s).unwrap();
        assert_eq!(p("top left").x, relative(0.0));
        assert_eq!(p("top left").y, relative(0.0));
        assert_eq!(p("bottom").y, relative(1.0));
        assert_eq!(p("bottom").x, relative(0.5));
        assert_eq!(p("10px 25%").x, DefiniteLength::from(px(10.0)));
        assert_eq!(p("10px 25%").y, relative(0.25));
        assert_eq!(p("right 5 3").z, px(3.0));
        assert_eq!(p("center top").y, relative(0.0));
        assert_eq!(
            p("0 0").offset(size(px(100.0), px(50.0))),
            (point(px(-50.0), px(-25.0)), Points::ZERO)
        );
        assert!(TransformOrigin::parse("sideways").is_none());
    }

    #[test]
    fn font_variants() {
        let v = FontVariant::parse("small-caps tabular-nums").unwrap();
        assert_eq!(v.tags().collect::<Vec<_>>(), ["smcp", "tnum"]);
        assert!(FontVariant::parse("wide").is_none());
    }

    #[test]
    fn flex_shorthand() {
        let mut s = Style::default();
        s.set("flex", StyleValue::Number(2.0)).unwrap();
        assert_eq!(s.layout.flex_grow, 2.0);
        assert_eq!(s.layout.flex_shrink, 1.0);
        assert_eq!(s.layout.flex_basis, Dimension::length(0.0));
    }

    /// Every order of `decls`.
    fn permutations<T: Clone>(decls: &[T]) -> Vec<Vec<T>> {
        if decls.len() <= 1 {
            return vec![decls.to_vec()];
        }
        let mut out = Vec::new();
        for i in 0..decls.len() {
            let mut rest = decls.to_vec();
            let first = rest.remove(i);
            for mut tail in permutations(&rest) {
                tail.insert(0, first.clone());
                out.push(tail);
            }
        }
        out
    }

    /// Checks the style of one style object with `decls` in every order:
    /// as recorded, and replayed from the patch (over classes).
    fn in_any_order(decls: &[(&str, StyleValue<'_>)], check: impl Fn(&Style)) {
        for order in permutations(decls) {
            let mut style = Style::default();
            let mut patch = StylePatch::default();
            for &(key, value) in &order {
                patch.set(&mut style, key, value).unwrap();
            }
            let keys: Vec<_> = order.iter().map(|(k, _)| *k).collect();
            println!("{keys:?}");
            check(&style);
            let mut replayed = Style::default();
            patch.apply(&mut replayed);
            check(&replayed);
        }
    }

    #[test]
    fn border_longhands_override_the_shorthand_in_any_order() {
        use StyleValue::{Null, Number, Str};
        in_any_order(
            &[
                ("borderTopWidth", Number(5.0)),
                ("borderWidth", Number(2.0)),
                ("borderLeftColor", Str("red")),
                ("borderColor", Str("blue")),
            ],
            |s| {
                assert_eq!(
                    s.view.borders.widths.to_array().map(|w| w.0),
                    [5.0, 2.0, 2.0, 2.0]
                );
                assert_eq!(s.layout.border.top, LengthPercentage::length(5.0));
                assert_eq!(s.layout.border.left, LengthPercentage::length(2.0));
                let (red, blue) = (Color(0xff00_00ff), Color(0x0000_ffff));
                assert_eq!(s.view.borders.colors, [blue, blue, blue, red]);
            },
        );
        // A null longhand is unset: the shorthand shows.
        in_any_order(
            &[("borderTopWidth", Null), ("borderWidth", Number(2.0))],
            |s| assert_eq!(s.view.borders.widths.to_array().map(|w| w.0), [2.0; 4]),
        );
        // Without its shorthand, null still resets the longhand (a class's).
        let mut s = Style::default();
        s.set("borderTopWidth", Number(4.0)).unwrap();
        StylePatch::default()
            .set(&mut s, "borderTopWidth", Null)
            .unwrap();
        assert_eq!(s.view.borders.widths.top, Points::ZERO);
    }

    #[test]
    fn edge_longhands_override_their_shorthands_in_any_order() {
        use StyleValue::Number;
        let len = LengthPercentageAuto::length;
        in_any_order(
            &[
                ("marginTop", Number(1.0)),
                ("marginVertical", Number(2.0)),
                ("margin", Number(3.0)),
                ("marginLeft", Number(4.0)),
                ("marginHorizontal", Number(5.0)),
            ],
            |s| {
                let m = s.layout.margin;
                assert_eq!(
                    [m.top, m.bottom, m.left, m.right],
                    [len(1.0), len(2.0), len(4.0), len(5.0)]
                );
            },
        );
        let len = LengthPercentage::length;
        in_any_order(
            &[
                ("paddingRight", Number(1.0)),
                ("padding", Number(3.0)),
                ("paddingVertical", Number(2.0)),
            ],
            |s| {
                let p = s.layout.padding;
                assert_eq!(
                    [p.top, p.bottom, p.left, p.right],
                    [len(2.0), len(2.0), len(3.0), len(1.0)]
                );
            },
        );
        in_any_order(&[("rowGap", Number(4.0)), ("gap", Number(8.0))], |s| {
            assert_eq!(s.layout.gap.height, len(4.0));
            assert_eq!(s.layout.gap.width, len(8.0));
        });
    }

    #[test]
    fn flex_and_grid_longhands_override_their_shorthands_in_any_order() {
        use StyleValue::{Number, Str};
        in_any_order(&[("flexGrow", Number(2.0)), ("flex", Number(1.0))], |s| {
            assert_eq!(s.layout.flex_grow, 2.0);
            assert_eq!(s.layout.flex_shrink, 1.0);
            assert_eq!(s.layout.flex_basis, Dimension::length(0.0));
        });
        in_any_order(
            &[
                ("gridColumnStart", Number(2.0)),
                ("gridColumn", Str("1 / 4")),
            ],
            |s| {
                assert_eq!(
                    Some(&s.layout.grid_column.start),
                    grid::placement("2").as_ref()
                );
                assert_eq!(
                    Some(&s.layout.grid_column.end),
                    grid::placement("4").as_ref()
                );
            },
        );
    }

    #[test]
    fn outline_style_none_hides_the_outline_in_any_order() {
        use StyleValue::{Null, Number, Str};
        in_any_order(
            &[("outlineStyle", Str("none")), ("outlineWidth", Number(3.0))],
            |s| assert!(!s.view.outline.is_visible()),
        );
        in_any_order(
            &[
                ("outlineStyle", Str("dashed")),
                ("outlineWidth", Number(3.0)),
            ],
            |s| {
                assert_eq!(s.view.outline.width, px(3.0));
                assert_eq!(s.view.outline.style, BorderStyle::Dashed);
            },
        );
        // A later style (inline over classes) showing it again gets the
        // width back.
        let mut s = Style::default();
        s.set("outlineWidth", Number(3.0)).unwrap();
        s.set("outlineStyle", Str("none")).unwrap();
        s.set("outlineStyle", Null).unwrap();
        assert_eq!(s.view.outline.width, px(3.0));
    }

    #[test]
    fn border_style_none_hides_the_border_in_any_order() {
        use StyleValue::{Null, Number, Str};
        for none in ["none", "hidden"] {
            in_any_order(
                &[
                    ("borderStyle", Str(none)),
                    ("borderWidth", Number(3.0)),
                    ("borderTopWidth", Number(4.0)),
                    ("borderStartWidth", Number(5.0)),
                ],
                |s| {
                    assert!(!s.view.borders.is_visible());
                    assert_eq!(s.view.borders.widths.to_array(), [Points::ZERO; 4]);
                    assert_eq!(s.layout.border.top, LengthPercentage::length(0.0));
                    assert_eq!(s.layout.border.left, LengthPercentage::length(0.0));
                    assert_eq!(s.logical.border_width, [None; 2]);
                },
            );
        }
        // A later style showing it again gets the widths back.
        let mut s = Style::default();
        s.set("borderWidth", Number(3.0)).unwrap();
        s.set("borderEndWidth", Number(1.0)).unwrap();
        s.set("borderStyle", Str("none")).unwrap();
        s.set("borderStyle", Str("dashed")).unwrap();
        assert_eq!(s.view.borders.widths.to_array(), [px(3.0); 4]);
        assert_eq!(s.layout.border.right, LengthPercentage::length(3.0));
        assert_eq!(s.logical.border_width, [None, Some(px(1.0))]);
        assert_eq!(s.view.borders.style, BorderStyle::Dashed);
        s.set("borderStyle", Str("hidden")).unwrap();
        s.set("borderStyle", Null).unwrap();
        assert_eq!(s.view.borders.widths.to_array(), [px(3.0); 4]);
    }

    #[test]
    fn animation_keys_apply_in_any_order() {
        use StyleValue::{Number, Str};
        in_any_order(
            &[
                ("animationDuration", Number(500.0)),
                ("animationIterationCount", Number(2.0)),
                ("animationName", Str("spin")),
                ("animationDelay", Str("0.1s")),
                ("animationTimingFunction", Str("ease-in")),
            ],
            |s| {
                let a = s.view.animation.unwrap();
                assert_eq!(a.keyframes, Keyframes::Spin);
                assert_eq!(a.duration, 500.0);
                assert_eq!(a.iterations, Some(2));
                assert_eq!(a.delay, 100.0);
                assert_eq!(a.easing, [0.42, 0.0, 1.0, 1.0]);
            },
        );
        // Without a name nothing runs.
        in_any_order(&[("animationDuration", Number(500.0))], |s| {
            assert_eq!(s.view.animation, None)
        });
        // Over a running (class) animation, the values change it.
        let mut s = Style::default();
        s.set("animationName", Str("ping")).unwrap();
        s.set("animationDuration", Number(300.0)).unwrap();
        s.set("animationName", Str("spin")).unwrap();
        assert_eq!(s.view.animation.unwrap().duration, 300.0);
    }

    #[test]
    fn transition_keys_apply_in_any_order() {
        use StyleValue::{Number, Str};
        in_any_order(
            &[
                ("transitionDuration", Number(300.0)),
                ("transitionDelay", Number(50.0)),
                ("transitionTimingFunction", Str("linear")),
                ("transitionProperty", Str("opacity")),
            ],
            |s| {
                let t = s.view.transition.unwrap();
                assert_eq!(t.properties, TransitionProps(TransitionProps::OPACITY));
                assert_eq!(t.duration, 300.0);
                assert_eq!(t.delay, 50.0);
                assert_eq!(t.easing, [0.0, 0.0, 1.0, 1.0]);
            },
        );
    }

    #[test]
    fn corner_radii_override_the_shorthand_in_any_order() {
        let mut s = Style::default();
        s.set("borderTopLeftRadius", StyleValue::Number(4.0))
            .unwrap();
        s.set("borderRadius", StyleValue::Number(10.0)).unwrap();
        let r = s.view.radii();
        assert_eq!(r.to_array(), [px(4.0), px(10.0), px(10.0), px(10.0)]);
        assert_eq!(r.shared(), None);
        s.set("borderTopLeftRadius", StyleValue::Null).unwrap();
        assert_eq!(s.view.radii().shared(), Some(px(10.0)));
    }

    #[test]
    fn shared_radius_ignores_square_corners() {
        let r = CornerRadii {
            top_left: px(12.0),
            top_right: px(12.0),
            ..CornerRadii::default()
        };
        assert_eq!(r.shared(), Some(px(12.0)));
        assert_eq!(CornerRadii::default().shared(), Some(px(0.0)));
        assert!(CornerRadii::default().is_zero());
    }

    #[test]
    fn radii_fit_the_box() {
        // 100 + 300 on a 200 wide box: everything scales by 0.5.
        let r = CornerRadii {
            top_left: px(100.0),
            top_right: px(300.0),
            bottom_right: px(0.0),
            bottom_left: px(0.0),
            continuous: false,
        }
        .fit(size(px(200.0), px(1000.0)));
        assert_eq!(r.to_array(), [px(50.0), px(150.0), px(0.0), px(0.0)]);
        let fits = CornerRadii::all(px(10.0));
        assert_eq!(fits.fit(size(px(100.0), px(100.0))), fits);
        assert_eq!(fits.inset(px(4.0)), CornerRadii::all(px(6.0)));
        assert_eq!(fits.inset(px(40.0)), CornerRadii::all(px(0.0)));
    }

    #[test]
    fn shadow_defaults_follow_react_native() {
        let mut s = Style::default();
        assert!(!s.view.shadow.is_visible());
        s.set("shadowOpacity", StyleValue::Number(0.3)).unwrap();
        s.set("shadowRadius", StyleValue::Number(8.0)).unwrap();
        s.set_shadow_offset(Some(point(px(0.0), px(4.0))));
        assert!(s.view.shadow.is_visible());
        assert_eq!(s.view.shadow.offset_y, px(4.0));
        s.set("shadowColor", StyleValue::Str("transparent"))
            .unwrap();
        assert!(!s.view.shadow.is_visible());
        s.set_shadow_offset(None);
        assert_eq!(s.view.shadow.offset_y, px(-3.0));
    }

    #[test]
    fn text_styles_parse() {
        let mut s = Style::default();
        s.set("fontFamily", StyleValue::Str("Inter")).unwrap();
        s.set("fontStyle", StyleValue::Str("italic")).unwrap();
        s.set(
            "textDecorationLine",
            StyleValue::Str("underline line-through"),
        )
        .unwrap();
        s.set("textTransform", StyleValue::Str("capitalize"))
            .unwrap();
        assert_eq!(s.text.font_family, Some(FontFamily::new("Inter")));
        assert_eq!(&*s.text.font_family.unwrap().name(), "Inter");
        assert_eq!(s.text.italic, Some(true));
        assert_eq!(
            s.text.decoration,
            Some(TextDecoration {
                underline: true,
                line_through: true
            })
        );
        assert_eq!(
            TextTransform::Capitalize.apply("hello wörld-x  ünd"),
            "Hello Wörld-x  Ünd"
        );
        assert_eq!(
            s.set("fontStyle", StyleValue::Str("oblique")),
            Err(StyleError::InvalidValue)
        );
    }

    #[test]
    fn mask_image_parses() {
        let mut s = Style::default();
        assert!(s.view.effects.is_none());
        s.set(
            "maskImage",
            StyleValue::Str("linear-gradient(black 70%, transparent)"),
        )
        .unwrap();
        let masks = &s.view.effects.as_ref().unwrap().mask_images;
        assert_eq!(masks.len(), 1);
        // `none`, and the null of a style that was taken off, both clear it.
        s.set("maskImage", StyleValue::Str("none")).unwrap();
        assert!(
            s.view
                .effects
                .as_ref()
                .is_none_or(|e| e.mask_images.is_empty())
        );
        s.set(
            "maskImage",
            StyleValue::Str("linear-gradient(black, transparent)"),
        )
        .unwrap();
        s.set("maskImage", StyleValue::Null).unwrap();
        assert!(
            s.view
                .effects
                .as_ref()
                .is_none_or(|e| e.mask_images.is_empty())
        );
        assert_eq!(
            s.set("maskImage", StyleValue::Str("url(a.png)")),
            Err(StyleError::InvalidValue)
        );
    }

    #[test]
    fn glass_effect_parses() {
        let mut s = Style::default();
        assert_eq!(s.view.glass_effect, GlassEffect::None);
        s.set("glassEffect", StyleValue::Str("regular")).unwrap();
        assert_eq!(s.view.glass_effect, GlassEffect::Regular);
        s.set("glassEffect", StyleValue::Str("clear")).unwrap();
        assert_eq!(s.view.glass_effect, GlassEffect::Clear);
        // `none`, and the null of a style that was taken off, both clear it.
        s.set("glassEffect", StyleValue::Str("none")).unwrap();
        assert_eq!(s.view.glass_effect, GlassEffect::None);
        s.set("glassEffect", StyleValue::Str("clear")).unwrap();
        s.set("glassEffect", StyleValue::Null).unwrap();
        assert_eq!(s.view.glass_effect, GlassEffect::None);
        assert_eq!(
            s.set("glassEffect", StyleValue::Str("frosted")),
            Err(StyleError::InvalidValue)
        );
        assert_eq!(
            s.set("glassEffect", StyleValue::Number(1.0)),
            Err(StyleError::InvalidValue)
        );
    }

    #[test]
    fn rejects_bad_values() {
        let mut s = Style::default();
        assert_eq!(
            s.set("width", StyleValue::Str("wide")),
            Err(StyleError::InvalidValue)
        );
        assert_eq!(
            s.set("nope", StyleValue::Number(1.0)),
            Err(StyleError::UnknownProperty)
        );
        s.set("width", StyleValue::Str("50%")).unwrap();
        assert_eq!(s.layout.size.width, Dimension::percent(0.5));
    }
}
