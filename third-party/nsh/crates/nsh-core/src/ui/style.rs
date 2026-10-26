//! Typed styles of Rust components ([`Styled`]): chained methods
//! (`.px_4()`, `.rounded_xl()`, `.bg(color)`) recording declarations that
//! lower into the same rules Tailwind classes compile to, without strings
//! to parse. Values follow Tailwind's default scales (4pt spacing steps),
//! independent of the app's Tailwind theme, so a component looks the same
//! in every app.
//!
//! Some changes are native, as with classes: theme colors carry a light
//! and a dark value ([`AdaptiveColor`]), `.active(|s| …)`, `.hover(…)` and
//! `.focus(…)` follow the view's interaction states. Others are bindings: a
//! method given a signal or a closure (`.w(move || px(width.get()))`),
//! `.style_when(signal, …)`, `.style_with(…)`. What is known when the view
//! is made (a variant) is plain Rust: `.when(cond, …)`.

use std::{
    fmt,
    hash::{Hash, Hasher},
    rc::Rc,
    sync::{Arc, LazyLock},
};

use super::{IntoReactive, Reactive, SharedString};
use crate::{
    BlendMode, BoxShadow, Cursor, FontVariant, ObjectPosition, TransformOrigin, TransitionProps,
    color::{Hsla, Rgba, transparent_black},
    effects::{Filter, GradientKind, GradientSize, KeyframeAnimation, Keyframes},
    geometry::{
        AbsoluteLength, DefiniteLength, Length, Percentage, Point, Points, REM_SIZE, Radians, Rems,
        deg, percentage, point, px, relative,
    },
    style::{Color, PatchValue, StyleDecl, StyleKey},
    tailwind::{self, ClassList, Decl, Part, Rank, Rule, rank, state},
    transform::TransformKind,
};

/// The style value of a length.
fn length_patch(length: Length) -> PatchValue {
    match length {
        Length::Definite(DefiniteLength::Absolute(a)) => {
            PatchValue::Number(a.to_points(REM_SIZE).0)
        }
        Length::Definite(DefiniteLength::Fraction(f)) => {
            PatchValue::Str(format!("{}%", f.0 * 100.0).into())
        }
        Length::Auto => PatchValue::Str("auto".into()),
    }
}

/// An absolute length in points (a rem at [`REM_SIZE`]).
fn points(length: AbsoluteLength) -> f32 {
    length.to_points(REM_SIZE).0
}

/// A font weight (100–900).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FontWeight(pub u16);

impl FontWeight {
    /// 100.
    pub const THIN: Self = Self(100);
    /// 200.
    pub const EXTRA_LIGHT: Self = Self(200);
    /// 300.
    pub const LIGHT: Self = Self(300);
    /// 400.
    pub const NORMAL: Self = Self(400);
    /// 500.
    pub const MEDIUM: Self = Self(500);
    /// 600.
    pub const SEMIBOLD: Self = Self(600);
    /// 700.
    pub const BOLD: Self = Self(700);
    /// 800.
    pub const EXTRA_BOLD: Self = Self(800);
    /// 900.
    pub const BLACK: Self = Self(900);
}

/// A color for each appearance: the platform switches between them
/// with nothing running. Theme colors are adaptive; an [`Hsla`] (or anything
/// that converts to one) is the same in both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct AdaptiveColor {
    /// In light appearance.
    pub light: Hsla,
    /// In dark appearance.
    pub dark: Hsla,
}

impl AdaptiveColor {
    /// Transparent in both.
    pub const TRANSPARENT: Self = Self {
        light: transparent_black(),
        dark: transparent_black(),
    };

    /// `light` and `dark`.
    pub fn new(light: impl Into<Hsla>, dark: impl Into<Hsla>) -> Self {
        Self {
            light: light.into(),
            dark: dark.into(),
        }
    }

    /// `0xRRGGBB` in light appearance and in dark, opaque (`const`s:
    /// `AdaptiveColor::rgb(0xffffff, 0x101113)`).
    pub const fn rgb(light: u32, dark: u32) -> Self {
        Self {
            light: crate::color::rgb(light).to_hsla(),
            dark: crate::color::rgb(dark).to_hsla(),
        }
    }

    /// Both with their alpha multiplied by `opacity`.
    pub fn opacity(self, opacity: f32) -> Self {
        self.map(|c| c.opacity(opacity))
    }

    /// Both through `f` (`theme.primary.map(|c| c.darken(0.1))`).
    pub fn map(self, f: impl Fn(Hsla) -> Hsla) -> Self {
        Self {
            light: f(self.light),
            dark: f(self.dark),
        }
    }
}

impl From<Hsla> for AdaptiveColor {
    fn from(c: Hsla) -> Self {
        Self { light: c, dark: c }
    }
}

impl From<Rgba> for AdaptiveColor {
    fn from(c: Rgba) -> Self {
        Hsla::from(c).into()
    }
}

impl From<Color> for AdaptiveColor {
    fn from(c: Color) -> Self {
        Hsla::from(c).into()
    }
}

/// An `f32` compared and hashed by its bits (styles are cache keys).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Bits(f32);

impl PartialEq for Bits {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

impl Eq for Bits {}

impl Hash for Bits {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.to_bits().hash(state)
    }
}

/// When a declaration applies: always, or while the element (or an
/// ancestor group) is in some states, or in dark appearance. Nested
/// variants (`.dark(|s| s.group_active(..))`) all have to hold. Small:
/// every declaration has one (a named group's name is in its
/// [`StyleRefinement`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub(crate) struct Variant {
    /// [`state`] bits of the element itself.
    states: u8,
    /// [`state`] bits of the nearest ancestor group (none: no group
    /// condition).
    group_states: u8,
    /// That group's name: 0 unnamed, else 1 + its index in
    /// [`StyleRefinement::names`].
    group: u8,
    dark: bool,
}

impl Variant {
    /// While hovered.
    pub(crate) const HOVER: Self = Self::states(state::HOVERED);
    /// While focused.
    pub(crate) const FOCUS: Self = Self::states(state::FOCUSED);
    /// While pressed.
    pub(crate) const ACTIVE: Self = Self::states(state::PRESSED);
    /// While disabled.
    pub(crate) const DISABLED: Self = Self::states(state::DISABLED);
    /// While selected (set by the core from the accessibility state).
    pub(crate) const SELECTED: Self = Self::states(state::SELECTED);
    /// While checked (set by the core from the accessibility state).
    pub(crate) const CHECKED: Self = Self::states(state::CHECKED);
    /// While indeterminate (set by the core from the accessibility state).
    pub(crate) const INDETERMINATE: Self = Self::states(state::INDETERMINATE);
    /// In dark appearance.
    const DARK: Self = Self {
        states: 0,
        group_states: 0,
        group: 0,
        dark: true,
    };

    const fn states(states: u8) -> Self {
        Self {
            states,
            group_states: 0,
            group: 0,
            dark: false,
        }
    }

    /// `self` inside `outer`: both must hold.
    fn within(self, outer: Variant) -> Variant {
        let (group, group_states) = match (outer.group_states, self.group_states) {
            (0, _) => (self.group, self.group_states),
            (o, i) if i != 0 && outer.group == self.group => (outer.group, o | i),
            (o, _) => (outer.group, o),
        };
        Variant {
            states: self.states | outer.states,
            group_states,
            group,
            dark: self.dark || outer.dark,
        }
    }

    /// Its place in Tailwind's variant order: every part's, group
    /// `group` (`""`: unnamed).
    fn rank(self, group: &str) -> Rank {
        let mut r = Rank::default();
        let keys = [
            (state::HOVERED, rank::HOVER),
            (state::FOCUSED, rank::FOCUS),
            (state::PRESSED, rank::ACTIVE),
            (state::DISABLED, rank::DISABLED),
            (state::SELECTED, rank::SELECTED),
            (state::CHECKED, rank::CHECKED),
            (state::INDETERMINATE, rank::INDETERMINATE),
        ];
        for (bit, key) in keys {
            if self.group_states & bit != 0 {
                r.add_group(&key, group);
            }
            if self.states & bit != 0 {
                r.add(key);
            }
        }
        if self.dark {
            r.add(rank::DARK);
        }
        r
    }
}

/// A color of a property several declarations build (a shadow's, a
/// ring's, a gradient stop's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ColorPart {
    Shadow,
    InsetShadow,
    TextShadow,
    Ring,
    RingOffset,
    InsetRing,
    From,
    Via,
    To,
}

impl ColorPart {
    fn part(self, c: Hsla) -> Part {
        let c = Color::from(c);
        // The color replaces the layers', alpha too (as Tailwind's
        // `shadow-red-500`).
        match self {
            ColorPart::Shadow => Part::ShadowColor(c),
            ColorPart::InsetShadow => Part::InsetShadowColor(c),
            ColorPart::TextShadow => Part::TextShadowColor(c),
            ColorPart::Ring => Part::RingColor(c),
            ColorPart::RingOffset => Part::RingOffsetColor(c),
            ColorPart::InsetRing => Part::InsetRingColor(c),
            // Theme and palette colors, which Tailwind writes in OKLCH.
            ColorPart::From => Part::From(c, false),
            ColorPart::Via => Part::Via(c, false),
            ColorPart::To => Part::To(c, false),
        }
    }
}

/// A gradient's geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum GradientShape {
    /// Along a line at an angle (radians, 0 up, a quarter turn right).
    Linear(Bits),
    /// Towards a corner.
    Corner { right: bool, bottom: bool },
    /// An ellipse from the center to the farthest corner.
    Radial,
    /// Around the center, from an angle (radians, 0 up).
    Conic(Bits),
}

/// A filter function (`Opacity` only of backdrops: a view's own opacity
/// is [`Styled::opacity`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum FilterFn {
    Blur,
    Brightness,
    Contrast,
    Grayscale,
    HueRotate,
    Invert,
    Opacity,
    Saturate,
    Sepia,
}

impl FilterFn {
    /// Its slot in the composed list (CSS's order, as Tailwind's
    /// utilities), and the filter.
    fn part(self, backdrop: bool, amount: f32) -> Part {
        let (slot, filter) = match self {
            FilterFn::Blur => (0, Filter::Blur(crate::geometry::px(amount))),
            FilterFn::Brightness => (1, Filter::Brightness(amount)),
            FilterFn::Contrast => (2, Filter::Contrast(amount)),
            FilterFn::Grayscale => (3, Filter::Grayscale(amount)),
            FilterFn::HueRotate => (4, Filter::HueRotate(crate::geometry::deg(amount))),
            FilterFn::Invert => (5, Filter::Invert(amount)),
            FilterFn::Opacity => (6, Filter::Opacity(amount)),
            FilterFn::Saturate => (6 + u8::from(backdrop), Filter::Saturate(amount)),
            FilterFn::Sepia => (7 + u8::from(backdrop), Filter::Sepia(amount)),
        };
        Part::Filter {
            backdrop,
            slot,
            filter: Some(filter),
        }
    }
}

/// Layers of [`BoxShadow`]s, compared and hashed by their bits.
#[derive(Debug, Clone)]
pub(crate) struct Layers(Arc<[BoxShadow]>);

impl Layers {
    fn bits(&self) -> impl Iterator<Item = (u32, u32, u32, u32, u32, bool)> + '_ {
        self.0.iter().map(|l| {
            (
                l.offset_x.0.to_bits(),
                l.offset_y.0.to_bits(),
                l.blur.0.to_bits(),
                l.spread.0.to_bits(),
                l.color.0,
                l.inset,
            )
        })
    }
}

impl PartialEq for Layers {
    fn eq(&self, other: &Self) -> bool {
        self.0.len() == other.0.len() && self.bits().eq(other.bits())
    }
}

impl Eq for Layers {}

impl Hash for Layers {
    fn hash<H: Hasher>(&self, state: &mut H) {
        for l in self.bits() {
            l.hash(state);
        }
    }
}

/// `underline` in [`Declaration::Decoration`].
const UNDERLINE: u8 = 1;
/// `line-through` in [`Declaration::Decoration`].
const LINE_THROUGH: u8 = 2;

/// One typed declaration.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Declaration {
    Number(StyleKey, Bits),
    Length(StyleKey, Length),
    Keyword(StyleKey, &'static str),
    /// What a declaration implies for another property, which any
    /// declaration of that property overrides wherever it is (an outline
    /// width's solid style).
    DefaultKeyword(StyleKey, &'static str),
    DefaultNumber(StyleKey, Bits),
    Str(StyleKey, SharedString),
    Color(StyleKey, AdaptiveColor),
    /// Tailwind's `text-*` size and line height.
    TextPreset(&'static str),
    /// Tailwind's `shadow-*` (`"none"` removes it).
    Shadow(&'static str),
    /// Tailwind's `inset-shadow-*` (`"none"` removes it).
    InsetShadow(&'static str),
    /// Tailwind's `text-shadow-*` (`"none"` removes it).
    TextShadow(&'static str),
    /// Box shadows of the element's own.
    Shadows(Layers),
    PartColor(ColorPart, AdaptiveColor),
    Ring(Bits),
    RingOffset(Bits),
    RingInset,
    InsetRing(Bits),
    /// `shadowOffset` (React Native's shadow).
    ShadowOffset(Bits, Bits),
    TextShadowOffset(Bits, Bits),
    /// One step of the transform the styles compose (CSS's order:
    /// translate, rotate, scale, then the 3D rotations and skews).
    Transform(TransformKind, Bits),
    /// `transform: none` (the 3D rotations and the skews).
    TransformNone,
    /// `translate: none`, `scale: none`, `rotate: none`.
    TranslateNone,
    ScaleNone,
    RotateNone,
    /// `transformOrigin` at points or fractions (`true`) of the size.
    Origin([(bool, Bits); 2]),
    Gradient(GradientShape),
    GradientNone,
    /// The position of the gradient's `from` (0), `via` (1) or `to` (2)
    /// color, a fraction of its length.
    StopPosition(u8, Bits),
    Filter(bool, FilterFn, Bits),
    FilterNone(bool),
    FontVariant {
        set: u8,
        clear: u8,
    },
    /// [`UNDERLINE`] and [`LINE_THROUGH`] add up; 0 removes both.
    Decoration(u8),
    /// [`TransitionProps`] bits.
    Transition(u8),
    TransitionNone,
    Duration(Bits),
    Delay(Bits),
    Ease([Bits; 4]),
    /// Tailwind's `ease-*`.
    EasePreset(&'static str),
    /// A keyframe animation (`None`: none).
    Animate(Option<u8>),
    /// A keyframe animation with its own timing: the keyframes' index,
    /// duration, delay, easing and iterations (`None`: forever).
    Animation(u8, Bits, Bits, [Bits; 4], Option<u32>),
    /// `repeat(n, minmax(0, 1fr))` tracks.
    Tracks(StyleKey, u16),
    /// `span n / span n`.
    Span(StyleKey, u16),
    /// The element is a group (`""`: unnamed): `group_*` styles inside
    /// follow its states.
    Group(&'static str),
}

/// Tailwind's default theme: the presets typed styles name.
static PRESETS: LazyLock<tailwind::Theme> = LazyLock::new(tailwind::Theme::default);

/// A color enters styles packed (`crate::color`'s rounding).
fn color_patch(c: Hsla) -> PatchValue {
    PatchValue::Str(format!("#{:08x}", Color::from(c).0).into())
}

fn shadow_preset(layers: Option<&Vec<BoxShadow>>) -> Arc<[BoxShadow]> {
    layers.map_or_else(|| Arc::from([]), |l| Arc::from(l.as_slice()))
}

/// The keyframes of [`Declaration::Animate`].
const KEYFRAMES: [Keyframes; 4] = [
    Keyframes::Spin,
    Keyframes::Ping,
    Keyframes::Pulse,
    Keyframes::Bounce,
];

impl Declaration {
    fn lower(&self, out: &mut Vec<Decl>) {
        let part = |out: &mut Vec<Decl>, p: Part| out.push(Decl::Part(p));
        match self {
            Declaration::Number(key, n) => {
                out.push(Decl::Set(*key, PatchValue::Number(n.0)));
                // As the classes': a width's color is `currentColor` unless
                // a color method sets one.
                match key {
                    StyleKey::BorderWidth
                    | StyleKey::BorderTopWidth
                    | StyleKey::BorderRightWidth
                    | StyleKey::BorderBottomWidth
                    | StyleKey::BorderLeftWidth
                    | StyleKey::BorderStartWidth
                    | StyleKey::BorderEndWidth => {
                        out.push(Decl::CurrentColor(StyleKey::BorderColor))
                    }
                    StyleKey::OutlineWidth => out.push(Decl::CurrentColor(StyleKey::OutlineColor)),
                    _ => {}
                }
            }
            Declaration::Length(key, l) => out.push(Decl::Set(*key, length_patch(*l))),
            Declaration::Keyword(key, k) => out.push(Decl::Set(*key, PatchValue::Str((*k).into()))),
            Declaration::DefaultKeyword(key, k) => {
                out.push(Decl::Default(*key, PatchValue::Str((*k).into())))
            }
            Declaration::DefaultNumber(key, n) => {
                out.push(Decl::Default(*key, PatchValue::Number(n.0)));
                if *key == StyleKey::OutlineWidth {
                    out.push(Decl::CurrentColor(StyleKey::OutlineColor));
                }
            }
            Declaration::Str(key, s) => {
                out.push(Decl::Set(*key, PatchValue::Str(s.as_str().into())))
            }
            Declaration::Color(key, c) => out.push(if c.light == c.dark {
                Decl::Set(*key, color_patch(c.light))
            } else {
                Decl::Adaptive(*key, [color_patch(c.light), color_patch(c.dark)])
            }),
            Declaration::TextPreset(name) => {
                if let Some(&(size, line)) = PRESETS.text.get(*name) {
                    out.push(Decl::Set(StyleKey::FontSize, PatchValue::Number(size)));
                    // As `text-lg`'s: a line height set anywhere wins.
                    if let Some(m) = line {
                        out.push(Decl::Default(
                            StyleKey::LineHeight,
                            PatchValue::Str(m.to_string().into()),
                        ));
                    }
                }
            }
            Declaration::Shadow(name) => {
                part(out, Part::Shadow(shadow_preset(PRESETS.shadows.get(*name))))
            }
            Declaration::InsetShadow(name) => part(
                out,
                Part::InsetShadow(shadow_preset(PRESETS.inset_shadows.get(*name))),
            ),
            Declaration::TextShadow(name) => {
                let layers = PRESETS.text_shadows.get(*name);
                part(
                    out,
                    Part::TextShadow(
                        layers.map_or_else(|| Arc::from([]), |l| Arc::from(l.as_slice())),
                    ),
                )
            }
            Declaration::Shadows(layers) => part(out, Part::Shadow(layers.0.clone())),
            Declaration::PartColor(which, c) => out.push(if c.light == c.dark {
                Decl::Part(which.part(c.light))
            } else {
                Decl::AdaptivePart(Box::new([which.part(c.light), which.part(c.dark)]))
            }),
            Declaration::Ring(w) => part(out, Part::Ring(w.0)),
            Declaration::RingOffset(w) => part(out, Part::RingOffset(w.0)),
            Declaration::RingInset => part(out, Part::RingInset),
            Declaration::InsetRing(w) => part(out, Part::InsetRing(w.0)),
            Declaration::ShadowOffset(x, y) => out.push(Decl::Style(StyleDecl::ShadowOffset(
                Some(point(px(x.0), px(y.0))),
            ))),
            Declaration::TextShadowOffset(x, y) => out.push(Decl::Style(
                StyleDecl::TextShadowOffset(Some(point(px(x.0), px(y.0)))),
            )),
            Declaration::Transform(kind, v) => {
                let v = v.0;
                let parts: &[Part] = match kind {
                    TransformKind::Scale => &[Part::ScaleX(v), Part::ScaleY(v)],
                    TransformKind::ScaleX => &[Part::ScaleX(v)],
                    TransformKind::ScaleY => &[Part::ScaleY(v)],
                    TransformKind::TranslateX => &[Part::TranslateX(tailwind::Len::Points(v))],
                    TransformKind::TranslateY => &[Part::TranslateY(tailwind::Len::Points(v))],
                    TransformKind::TranslateXFraction => {
                        &[Part::TranslateX(tailwind::Len::Fraction(v))]
                    }
                    TransformKind::TranslateYFraction => {
                        &[Part::TranslateY(tailwind::Len::Fraction(v))]
                    }
                    TransformKind::Rotate => &[Part::Rotate(v)],
                    TransformKind::RotateX => &[Part::RotateX(v)],
                    TransformKind::RotateY => &[Part::RotateY(v)],
                    TransformKind::SkewX => &[Part::SkewX(v)],
                    TransformKind::SkewY => &[Part::SkewY(v)],
                    TransformKind::Perspective => &[Part::Perspective(Some(v))],
                };
                out.extend(parts.iter().cloned().map(Decl::Part));
            }
            Declaration::TransformNone => part(out, Part::TransformNone),
            Declaration::TranslateNone => part(out, Part::TranslateNone),
            Declaration::ScaleNone => part(out, Part::ScaleNone),
            Declaration::RotateNone => part(out, Part::RotateNone),
            Declaration::Origin(axes) => {
                let [x, y] = axes.map(|(fraction, v)| {
                    if fraction {
                        format!("{}%", v.0 * 100.0)
                    } else {
                        format!("{}px", v.0)
                    }
                });
                out.push(Decl::Set(
                    StyleKey::TransformOrigin,
                    PatchValue::Str(format!("{x} {y}").into()),
                ));
            }
            Declaration::Gradient(shape) => part(
                out,
                Part::Gradient(match *shape {
                    GradientShape::Linear(angle) => GradientKind::Linear {
                        angle: Radians(angle.0),
                    },
                    GradientShape::Corner { right, bottom } => {
                        GradientKind::LinearCorner { right, bottom }
                    }
                    GradientShape::Radial => GradientKind::Radial {
                        circle: false,
                        size: GradientSize::FarthestCorner,
                        x: percentage(0.5),
                        y: percentage(0.5),
                    },
                    GradientShape::Conic(from) => GradientKind::Conic {
                        from: Radians(from.0),
                        x: percentage(0.5),
                        y: percentage(0.5),
                    },
                }),
            ),
            Declaration::GradientNone => part(out, Part::GradientNone),
            Declaration::StopPosition(i, at) => part(
                out,
                match i {
                    0 => Part::FromPos(at.0),
                    1 => Part::ViaPos(at.0),
                    _ => Part::ToPos(at.0),
                },
            ),
            Declaration::Filter(backdrop, f, amount) => part(out, f.part(*backdrop, amount.0)),
            Declaration::FilterNone(backdrop) => part(
                out,
                Part::FilterNone {
                    backdrop: *backdrop,
                },
            ),
            Declaration::FontVariant { set, clear } => part(
                out,
                Part::FontVariant {
                    set: *set,
                    clear: *clear,
                },
            ),
            Declaration::Decoration(bits) => out.push(Decl::Set(
                StyleKey::TextDecorationLine,
                PatchValue::Str(
                    match *bits {
                        0 => "none",
                        UNDERLINE => "underline",
                        LINE_THROUGH => "line-through",
                        _ => "underline line-through",
                    }
                    .into(),
                ),
            )),
            Declaration::Transition(props) => part(out, Part::TransitionProps(*props)),
            Declaration::TransitionNone => part(out, Part::TransitionNone),
            Declaration::Duration(ms) => part(out, Part::Duration(ms.0)),
            Declaration::Delay(ms) => part(out, Part::Delay(ms.0)),
            Declaration::Ease(curve) => part(out, Part::Ease(curve.map(|b| b.0))),
            Declaration::EasePreset(name) => {
                if let Some(curve) = PRESETS.ease.get(*name) {
                    part(out, Part::Ease(*curve));
                }
            }
            Declaration::Animate(k) => part(out, Part::Animate(k.map(|i| KEYFRAMES[i as usize]))),
            Declaration::Animation(k, duration, delay, easing, iterations) => part(
                out,
                Part::Animation(KeyframeAnimation {
                    keyframes: KEYFRAMES[*k as usize],
                    duration: duration.0,
                    delay: delay.0,
                    easing: easing.map(|b| b.0),
                    iterations: *iterations,
                }),
            ),
            Declaration::Tracks(key, n) => out.push(Decl::Set(
                *key,
                PatchValue::Str(format!("repeat({n}, minmax(0, 1fr))").into()),
            )),
            Declaration::Span(key, n) => out.push(Decl::Set(
                *key,
                PatchValue::Str(format!("span {n} / span {n}").into()),
            )),
            // A property of the class list, not a declaration.
            Declaration::Group(_) => {}
        }
    }
}

type Entries = Vec<(Variant, Declaration)>;

crate::static_reactive!(AdaptiveColor: AdaptiveColor, Hsla, Rgba, Color);
crate::static_reactive!(Length: Length, Points, Rems, AbsoluteLength, DefiniteLength, Percentage);
crate::static_reactive!(DefiniteLength: Points, Rems, AbsoluteLength, DefiniteLength, Percentage);
crate::static_reactive!(AbsoluteLength: Points, Rems, AbsoluteLength);
crate::static_reactive!(Points: Points);
crate::static_reactive!(Radians: Radians);
crate::static_reactive!(Percentage: Percentage);
crate::static_reactive!(u16: u16);
crate::static_reactive!(i16: i16);

/// A bound part of a style: it adds its declarations to a style, reading
/// the signals it binds (run again when they change).
pub(crate) type BoundStyle = Rc<dyn Fn(&mut StyleRefinement)>;

/// An element's styles, in order (later declarations win). Built by the
/// [`Styled`] methods; `.active(|s| …)` and the like hand a fresh one to
/// their closure. Values given as signals or closures are bound parts,
/// added after the static declarations ([`StyleRefinement::resolved`]).
#[derive(Clone, Default)]
pub struct StyleRefinement {
    entries: Entries,
    /// The names of the groups its variants follow ([`Variant::group`]).
    names: Vec<&'static str>,
    bound: Vec<BoundStyle>,
}

impl fmt::Debug for StyleRefinement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StyleRefinement")
            .field("entries", &self.entries)
            .field("names", &self.names)
            .field("bound", &self.bound.len())
            .finish()
    }
}

/// Equal static declarations and the same bound parts.
impl PartialEq for StyleRefinement {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
            && self.names == other.names
            && self.bound.len() == other.bound.len()
            && self
                .bound
                .iter()
                .zip(&other.bound)
                .all(|(a, b)| Rc::ptr_eq(a, b))
    }
}

impl Eq for StyleRefinement {}

/// The static declarations (a resolved style, [`StyleRefinement::resolved`],
/// has no bound parts).
impl Hash for StyleRefinement {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.entries.hash(state);
        self.names.hash(state);
    }
}

impl StyleRefinement {
    /// Applies `value` with `apply`: now when it is static, else as a bound
    /// part.
    pub(crate) fn bind_value<T: 'static>(
        &mut self,
        value: impl IntoReactive<T>,
        apply: impl Fn(&mut StyleRefinement, T) + 'static,
    ) {
        match value.into_reactive() {
            Reactive::Static(v) => apply(self, v),
            Reactive::Bound(f) => self.bound.push(Rc::new(move |s| apply(s, f()))),
        }
    }

    /// Adds a bound part.
    pub(crate) fn bind(&mut self, part: impl Fn(&mut StyleRefinement) + 'static) {
        self.bound.push(Rc::new(part));
    }

    /// Whether it has bound parts.
    pub(crate) fn is_bound(&self) -> bool {
        !self.bound.is_empty()
    }

    /// Its static declarations alone.
    pub(crate) fn static_part(&self) -> StyleRefinement {
        StyleRefinement {
            entries: self.entries.clone(),
            names: self.names.clone(),
            bound: Vec::new(),
        }
    }

    /// The style now: the static declarations, then the bound parts' (read
    /// in the running computation, which subscribes to them).
    pub(crate) fn resolved(&self) -> StyleRefinement {
        let mut out = StyleRefinement {
            entries: self.entries.clone(),
            names: self.names.clone(),
            bound: Vec::new(),
        };
        for part in &self.bound {
            part(&mut out);
        }
        out
    }

    pub(crate) fn push(&mut self, decl: Declaration) {
        // Elements take several declarations: no regrowth for the first.
        if self.entries.capacity() == 0 {
            self.entries.reserve(8);
        }
        self.entries.push((Variant::default(), decl));
    }

    pub(crate) fn lengths(&mut self, keys: &[StyleKey], length: impl Into<Length>) {
        let length = length.into();
        for key in keys {
            self.push(Declaration::Length(*key, length));
        }
    }

    pub(crate) fn number(&mut self, key: StyleKey, n: f32) {
        self.push(Declaration::Number(key, Bits(n)));
    }

    pub(crate) fn numbers(&mut self, keys: &[StyleKey], n: f32) {
        for key in keys {
            self.number(*key, n);
        }
    }

    pub(crate) fn keyword(&mut self, key: StyleKey, k: &'static str) {
        self.push(Declaration::Keyword(key, k));
    }

    pub(crate) fn color(&mut self, keys: &[StyleKey], color: AdaptiveColor) {
        for key in keys {
            self.push(Declaration::Color(*key, color));
        }
    }

    /// `other`'s declarations, applying while in `variant` (and in their
    /// own).
    pub(crate) fn extend_as(&mut self, variant: Variant, other: StyleRefinement) {
        for (mut v, d) in other.entries {
            if v.group != 0 {
                v.group = self.name(other.names[v.group as usize - 1]);
            }
            self.entries.push((v.within(variant), d));
        }
        // Bound parts apply in the variant too.
        for part in other.bound {
            self.bound.push(Rc::new(move |s| {
                let mut inner = StyleRefinement::default();
                part(&mut inner);
                s.extend_as(variant, inner);
            }));
        }
    }

    /// [`Variant::group`] of the group `name`.
    fn name(&mut self, name: &'static str) -> u8 {
        if name.is_empty() {
            return 0;
        }
        let at = match self.names.iter().position(|n| *n == name) {
            Some(at) => at,
            None => {
                self.names.push(name);
                self.names.len() - 1
            }
        };
        u8::try_from(at + 1).expect("fewer than 255 group names")
    }

    /// No declarations, and no bound parts.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.bound.is_empty()
    }

    /// The rules, as Tailwind classes compile to: one per variant, in
    /// Tailwind's variant order.
    pub(crate) fn lower(&self) -> ClassList {
        let mut variants: Vec<Variant> = Vec::new();
        let mut groups: Vec<Box<str>> = Vec::new();
        for (v, d) in &self.entries {
            if let Declaration::Group(name) = d {
                if !groups.iter().any(|g| **g == **name) {
                    groups.push((*name).into());
                }
            } else if !variants.contains(v) {
                variants.push(*v);
            }
        }
        let mut rules = Vec::with_capacity(variants.len());
        for variant in variants {
            let mut decls = Vec::new();
            // Decorations add up within a variant (`.underline()
            // .line_through()` draws both).
            let mut decoration = 0;
            for (v, d) in &self.entries {
                if *v != variant {
                    continue;
                }
                if let Declaration::Decoration(bits) = d {
                    decoration = if *bits == 0 { 0 } else { decoration | bits };
                    Declaration::Decoration(decoration).lower(&mut decls);
                } else {
                    d.lower(&mut decls);
                }
            }
            if !decls.is_empty() {
                let name = match variant.group {
                    0 => "",
                    g => self.names[g as usize - 1],
                };
                let group = (variant.group_states != 0).then_some((name, variant.group_states));
                rules.push(Rule::with(
                    variant.states,
                    group,
                    variant.dark,
                    variant.rank(name),
                    decls,
                ));
            }
        }
        ClassList::from_rules(rules, groups)
    }
}

/// `s` with number / letter forms `set` on and `clear` off.
fn font_variant<S: Styled>(mut s: S, set: u8, clear: u8) -> S {
    s.style().push(Declaration::FontVariant { set, clear });
    s
}

/// A text's base direction (`writingDirection`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum WritingDirection {
    /// From the content (the default).
    #[default]
    Auto,
    /// Left to right.
    Ltr,
    /// Right to left.
    Rtl,
}

/// The layout direction of a view and its subtree (`direction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum LayoutDirection {
    /// Its parent's (the default): the surface's follows the user's
    /// language.
    #[default]
    Inherit,
    /// Left to right.
    Ltr,
    /// Right to left: rows run from the right, and left / right
    /// properties mean start and end.
    Rtl,
}
crate::static_reactive!(LayoutDirection: LayoutDirection);

/// The shape of rounded corners (`borderCurve`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum BorderCurve {
    /// Quarter circles (the default).
    #[default]
    Circular,
    /// Curvature easing into the edges (iOS app icons); pills stay pills.
    Continuous,
}

/// Styling methods, named after the utility classes they match (`.p_4()` is
/// `p-4`). Implemented by the elements and by [`StyleRefinement`] (in
/// `.active(|s| …)`).
pub trait Styled: Sized {
    /// The styles being built.
    fn style(&mut self) -> &mut StyleRefinement;

    nsh_macros::style_helpers! {
        /// Padding on all sides
        p => [Padding],
        /// Horizontal padding
        px => [PaddingHorizontal],
        /// Vertical padding
        py => [PaddingVertical],
        /// Top padding
        pt => [PaddingTop],
        /// Right padding
        pr => [PaddingRight],
        /// Bottom padding
        pb => [PaddingBottom],
        /// Left padding
        pl => [PaddingLeft],
        /// Leading padding (left in left-to-right layouts)
        ps => [PaddingStart],
        /// Trailing padding
        pe => [PaddingEnd],
        /// Margin on all sides
        m => [Margin],
        /// Horizontal margin
        mx => [MarginHorizontal],
        /// Vertical margin
        my => [MarginVertical],
        /// Top margin
        mt => [MarginTop],
        /// Right margin
        mr => [MarginRight],
        /// Bottom margin
        mb => [MarginBottom],
        /// Left margin
        ml => [MarginLeft],
        /// Leading margin
        ms => [MarginStart],
        /// Trailing margin
        me => [MarginEnd],
        /// Space between children
        gap => [Gap],
        /// Space between columns
        gap_x => [ColumnGap],
        /// Space between rows
        gap_y => [RowGap],
        /// Width
        w => [Width],
        /// Height
        h => [Height],
        /// Width and height
        size => [Width, Height],
        /// Minimum width
        min_w => [MinWidth],
        /// Minimum height
        min_h => [MinHeight],
        /// Maximum width
        max_w => [MaxWidth],
        /// Maximum height
        max_h => [MaxHeight],
        /// Distance from the parent's top edge (absolute layout)
        top => [Top],
        /// Distance from the parent's right edge
        right => [Right],
        /// Distance from the parent's bottom edge
        bottom => [Bottom],
        /// Distance from the parent's left edge
        left => [Left],
        /// Distance from every edge of the parent
        inset => [Top, Right, Bottom, Left],
        /// The flex basis
        basis => [FlexBasis],
    }

    // Layout.

    /// Flex layout (the default).
    fn flex(mut self) -> Self {
        self.style().keyword(StyleKey::Display, "flex");
        self
    }

    /// Grid layout.
    fn grid(mut self) -> Self {
        self.style().keyword(StyleKey::Display, "grid");
        self
    }

    /// `count` equal grid columns (Tailwind's `grid-cols-3`).
    fn grid_cols(mut self, count: impl IntoReactive<u16>) -> Self {
        self.style().bind_value(count, |s, count: u16| {
            s.push(Declaration::Tracks(StyleKey::GridTemplateColumns, count));
        });
        self
    }

    /// `count` equal grid rows.
    fn grid_rows(mut self, count: impl IntoReactive<u16>) -> Self {
        self.style().bind_value(count, |s, count: u16| {
            s.push(Declaration::Tracks(StyleKey::GridTemplateRows, count));
        });
        self
    }

    /// The grid's columns as CSS tracks (`"200px 1fr"`, `"repeat(auto-fill,
    /// minmax(80px, 1fr))"`, line names).
    fn grid_template_columns(mut self, tracks: impl IntoReactive<SharedString>) -> Self {
        self.style().bind_value(tracks, |s, tracks: SharedString| {
            s.push(Declaration::Str(StyleKey::GridTemplateColumns, tracks));
        });
        self
    }

    /// The grid's rows as CSS tracks.
    fn grid_template_rows(mut self, tracks: impl IntoReactive<SharedString>) -> Self {
        self.style().bind_value(tracks, |s, tracks: SharedString| {
            s.push(Declaration::Str(StyleKey::GridTemplateRows, tracks));
        });
        self
    }

    /// Items fill the grid column by column.
    fn grid_flow_col(mut self) -> Self {
        self.style().keyword(StyleKey::GridAutoFlow, "column");
        self
    }

    /// Items fill the grid's holes left by larger ones.
    fn grid_flow_dense(mut self) -> Self {
        self.style().keyword(StyleKey::GridAutoFlow, "row dense");
        self
    }

    /// In the grid, `count` columns wide.
    fn col_span(mut self, count: impl IntoReactive<u16>) -> Self {
        self.style().bind_value(count, |s, count: u16| {
            s.push(Declaration::Span(StyleKey::GridColumn, count));
        });
        self
    }

    /// In the grid, `count` rows high.
    fn row_span(mut self, count: impl IntoReactive<u16>) -> Self {
        self.style().bind_value(count, |s, count: u16| {
            s.push(Declaration::Span(StyleKey::GridRow, count));
        });
        self
    }

    /// Across every column of the grid.
    fn col_span_full(mut self) -> Self {
        self.style().keyword(StyleKey::GridColumn, "1 / -1");
        self
    }

    /// Across every row of the grid.
    fn row_span_full(mut self) -> Self {
        self.style().keyword(StyleKey::GridRow, "1 / -1");
        self
    }

    /// Starts at column line `line` (1 is the first; negative from the
    /// end).
    fn col_start(mut self, line: impl IntoReactive<i16>) -> Self {
        self.style().bind_value(line, |s, line: i16| {
            s.number(StyleKey::GridColumnStart, f32::from(line));
        });
        self
    }

    /// Ends at column line `line`.
    fn col_end(mut self, line: impl IntoReactive<i16>) -> Self {
        self.style().bind_value(line, |s, line: i16| {
            s.number(StyleKey::GridColumnEnd, f32::from(line));
        });
        self
    }

    /// Starts at row line `line`.
    fn row_start(mut self, line: impl IntoReactive<i16>) -> Self {
        self.style().bind_value(line, |s, line: i16| {
            s.number(StyleKey::GridRowStart, f32::from(line));
        });
        self
    }

    /// Ends at row line `line`.
    fn row_end(mut self, line: impl IntoReactive<i16>) -> Self {
        self.style().bind_value(line, |s, line: i16| {
            s.number(StyleKey::GridRowEnd, f32::from(line));
        });
        self
    }

    /// Not laid out nor shown.
    fn hidden(mut self) -> Self {
        self.style().keyword(StyleKey::Display, "none");
        self
    }

    /// Children in a row.
    fn flex_row(mut self) -> Self {
        self.style().keyword(StyleKey::FlexDirection, "row");
        self
    }

    /// Children in a row, last first.
    fn flex_row_reverse(mut self) -> Self {
        self.style().keyword(StyleKey::FlexDirection, "row-reverse");
        self
    }

    /// Children in a column (the default).
    fn flex_col(mut self) -> Self {
        self.style().keyword(StyleKey::FlexDirection, "column");
        self
    }

    /// Children in a column, last first.
    fn flex_col_reverse(mut self) -> Self {
        self.style()
            .keyword(StyleKey::FlexDirection, "column-reverse");
        self
    }

    /// Children wrap onto new lines.
    fn flex_wrap(mut self) -> Self {
        self.style().keyword(StyleKey::FlexWrap, "wrap");
        self
    }

    /// Grows and shrinks, ignoring its own size (`flex: 1 1 0`).
    fn flex_1(mut self) -> Self {
        let s = self.style();
        s.number(StyleKey::FlexGrow, 1.0);
        s.number(StyleKey::FlexShrink, 1.0);
        s.lengths(&[StyleKey::FlexBasis], px(0.0));
        self
    }

    /// Grows and shrinks from its own size (`flex: 1 1 auto`).
    fn flex_auto(mut self) -> Self {
        let s = self.style();
        s.number(StyleKey::FlexGrow, 1.0);
        s.number(StyleKey::FlexShrink, 1.0);
        s.lengths(&[StyleKey::FlexBasis], Length::Auto);
        self
    }

    /// Neither grows nor shrinks.
    fn flex_none(mut self) -> Self {
        let s = self.style();
        s.number(StyleKey::FlexGrow, 0.0);
        s.number(StyleKey::FlexShrink, 0.0);
        self
    }

    /// Takes free space, `factor` times as much as a sibling growing by 1
    /// (`flex-grow`; Tailwind's `grow-*`).
    fn flex_grow(mut self, factor: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(factor, |s, factor: f32| {
            s.number(StyleKey::FlexGrow, factor);
        });
        self
    }

    /// Gives up space when there is too little, `factor` times as much as
    /// a sibling shrinking by 1 (`flex-shrink`).
    fn flex_shrink(mut self, factor: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(factor, |s, factor: f32| {
            s.number(StyleKey::FlexShrink, factor);
        });
        self
    }

    /// Never shrinks.
    fn flex_shrink_0(mut self) -> Self {
        self.style().number(StyleKey::FlexShrink, 0.0);
        self
    }

    /// Children at the cross axis' start.
    fn items_start(mut self) -> Self {
        self.style().keyword(StyleKey::AlignItems, "flex-start");
        self
    }

    /// Children centered on the cross axis.
    fn items_center(mut self) -> Self {
        self.style().keyword(StyleKey::AlignItems, "center");
        self
    }

    /// Children at the cross axis' end.
    fn items_end(mut self) -> Self {
        self.style().keyword(StyleKey::AlignItems, "flex-end");
        self
    }

    /// Children stretched across (the default).
    fn items_stretch(mut self) -> Self {
        self.style().keyword(StyleKey::AlignItems, "stretch");
        self
    }

    /// Children aligned on their text baseline.
    fn items_baseline(mut self) -> Self {
        self.style().keyword(StyleKey::AlignItems, "baseline");
        self
    }

    /// Children at the main axis' start (the default).
    fn justify_start(mut self) -> Self {
        self.style().keyword(StyleKey::JustifyContent, "flex-start");
        self
    }

    /// Children centered on the main axis.
    fn justify_center(mut self) -> Self {
        self.style().keyword(StyleKey::JustifyContent, "center");
        self
    }

    /// Children at the main axis' end.
    fn justify_end(mut self) -> Self {
        self.style().keyword(StyleKey::JustifyContent, "flex-end");
        self
    }

    /// Free space between children.
    fn justify_between(mut self) -> Self {
        self.style()
            .keyword(StyleKey::JustifyContent, "space-between");
        self
    }

    /// Free space around children.
    fn justify_around(mut self) -> Self {
        self.style()
            .keyword(StyleKey::JustifyContent, "space-around");
        self
    }

    /// Free space evenly between and around children.
    fn justify_evenly(mut self) -> Self {
        self.style()
            .keyword(StyleKey::JustifyContent, "space-evenly");
        self
    }

    /// Itself at the cross axis' start.
    fn self_start(mut self) -> Self {
        self.style().keyword(StyleKey::AlignSelf, "flex-start");
        self
    }

    /// Itself centered on the cross axis.
    fn self_center(mut self) -> Self {
        self.style().keyword(StyleKey::AlignSelf, "center");
        self
    }

    /// Itself at the cross axis' end.
    fn self_end(mut self) -> Self {
        self.style().keyword(StyleKey::AlignSelf, "flex-end");
        self
    }

    /// Itself stretched across.
    fn self_stretch(mut self) -> Self {
        self.style().keyword(StyleKey::AlignSelf, "stretch");
        self
    }

    /// The parent's full width.
    fn w_full(self) -> Self {
        self.w(relative(1.0))
    }

    /// The parent's full height.
    fn h_full(self) -> Self {
        self.h(relative(1.0))
    }

    /// The parent's full size.
    fn size_full(self) -> Self {
        self.size(relative(1.0))
    }

    /// Width over height.
    fn aspect_ratio(mut self, ratio: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(ratio, |s, ratio: f32| {
            s.number(StyleKey::AspectRatio, ratio);
        });
        self
    }

    /// As wide as high.
    fn aspect_square(self) -> Self {
        self.aspect_ratio(1.0)
    }

    /// Laid out in the flow (the default).
    fn relative(mut self) -> Self {
        self.style().keyword(StyleKey::Position, "relative");
        self
    }

    /// Out of the flow, placed by `top` / `left` / ... in the parent.
    fn absolute(mut self) -> Self {
        self.style().keyword(StyleKey::Position, "absolute");
        self
    }

    /// In the flow, and while its parent shows it sticks `top` (in a
    /// horizontal scroll view `left`) from the start of the viewport of the
    /// scroll view around it, as far as the end of its parent's content box
    /// (CSS `position: sticky`; `.top(..)` / `.bind_sticky_top(..)` say
    /// where).
    fn sticky(mut self) -> Self {
        self.style().keyword(StyleKey::Position, "sticky");
        self
    }

    /// Clips its children.
    fn overflow_hidden(mut self) -> Self {
        self.style().keyword(StyleKey::Overflow, "hidden");
        self
    }

    /// Stacking order among siblings.
    fn z_index(mut self, z: impl IntoReactive<i32>) -> Self {
        self.style()
            .bind_value(z, |s, z: i32| s.number(StyleKey::ZIndex, z as f32));
        self
    }

    // Visuals.

    /// The background color.
    fn bg(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BackgroundColor], color);
        });
        self
    }

    /// Opacity, 0 (invisible) to 1.
    fn opacity(mut self, opacity: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(opacity, |s, opacity: f32| {
            s.number(StyleKey::Opacity, opacity.clamp(0.0, 1.0));
        });
        self
    }

    /// The corner radius.
    fn rounded(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderRadius], radius);
        });
        self
    }

    /// No rounded corners.
    fn rounded_none(self) -> Self {
        self.rounded(px(0.0))
    }

    /// 2pt corners.
    fn rounded_xs(self) -> Self {
        self.rounded(px(2.0))
    }

    /// 4pt corners.
    fn rounded_sm(self) -> Self {
        self.rounded(px(4.0))
    }

    /// 6pt corners.
    fn rounded_md(self) -> Self {
        self.rounded(px(6.0))
    }

    /// 8pt corners.
    fn rounded_lg(self) -> Self {
        self.rounded(px(8.0))
    }

    /// 12pt corners.
    fn rounded_xl(self) -> Self {
        self.rounded(px(12.0))
    }

    /// 16pt corners.
    fn rounded_2xl(self) -> Self {
        self.rounded(px(16.0))
    }

    /// 24pt corners.
    fn rounded_3xl(self) -> Self {
        self.rounded(px(24.0))
    }

    /// Fully round ends (pills, circles).
    fn rounded_full(self) -> Self {
        self.rounded(px(9999.0))
    }

    /// The top corners' radius.
    fn rounded_t(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(
                &[
                    StyleKey::BorderTopLeftRadius,
                    StyleKey::BorderTopRightRadius,
                ],
                radius,
            );
        });
        self
    }

    /// The bottom corners' radius.
    fn rounded_b(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(
                &[
                    StyleKey::BorderBottomLeftRadius,
                    StyleKey::BorderBottomRightRadius,
                ],
                radius,
            );
        });
        self
    }

    /// The border width on all sides.
    fn border(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderWidth, points(width));
        });
        self
    }

    /// A 1pt border.
    fn border_1(self) -> Self {
        self.border(px(1.0))
    }

    /// A 2pt border.
    fn border_2(self) -> Self {
        self.border(px(2.0))
    }

    /// A 1pt top border.
    fn border_t_1(mut self) -> Self {
        self.style().number(StyleKey::BorderTopWidth, 1.0);
        self
    }

    /// A 1pt bottom border.
    fn border_b_1(mut self) -> Self {
        self.style().number(StyleKey::BorderBottomWidth, 1.0);
        self
    }

    /// A 1pt left border.
    fn border_l_1(mut self) -> Self {
        self.style().number(StyleKey::BorderLeftWidth, 1.0);
        self
    }

    /// A 1pt right border.
    fn border_r_1(mut self) -> Self {
        self.style().number(StyleKey::BorderRightWidth, 1.0);
        self
    }

    /// The border color.
    fn border_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderColor], color);
        });
        self
    }

    /// The top border's width.
    fn border_t(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderTopWidth, points(width));
        });
        self
    }

    /// The right border's width.
    fn border_r(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderRightWidth, points(width));
        });
        self
    }

    /// The bottom border's width.
    fn border_b(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderBottomWidth, points(width));
        });
        self
    }

    /// The left border's width.
    fn border_l(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderLeftWidth, points(width));
        });
        self
    }

    /// The left and right borders' width.
    fn border_x(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.numbers(
                &[StyleKey::BorderLeftWidth, StyleKey::BorderRightWidth],
                points(width),
            );
        });
        self
    }

    /// The top and bottom borders' width.
    fn border_y(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.numbers(
                &[StyleKey::BorderTopWidth, StyleKey::BorderBottomWidth],
                points(width),
            );
        });
        self
    }

    /// The leading border's width (left in left-to-right layouts).
    fn border_s(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderStartWidth, points(width));
        });
        self
    }

    /// The trailing border's width.
    fn border_e(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::BorderEndWidth, points(width));
        });
        self
    }

    /// The top border's color.
    fn border_t_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderTopColor], color);
        });
        self
    }

    /// The right border's color.
    fn border_r_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderRightColor], color);
        });
        self
    }

    /// The bottom border's color.
    fn border_b_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderBottomColor], color);
        });
        self
    }

    /// The left border's color.
    fn border_l_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderLeftColor], color);
        });
        self
    }

    /// The left and right borders' color.
    fn border_x_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(
                &[StyleKey::BorderLeftColor, StyleKey::BorderRightColor],
                color,
            );
        });
        self
    }

    /// The top and bottom borders' color.
    fn border_y_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(
                &[StyleKey::BorderTopColor, StyleKey::BorderBottomColor],
                color,
            );
        });
        self
    }

    /// The leading border's color.
    fn border_s_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderStartColor], color);
        });
        self
    }

    /// The trailing border's color.
    fn border_e_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::BorderEndColor], color);
        });
        self
    }

    /// Solid borders (the default).
    fn border_solid(mut self) -> Self {
        self.style().keyword(StyleKey::BorderStyle, "solid");
        self
    }

    /// Dashed borders.
    fn border_dashed(mut self) -> Self {
        self.style().keyword(StyleKey::BorderStyle, "dashed");
        self
    }

    /// Dotted borders.
    fn border_dotted(mut self) -> Self {
        self.style().keyword(StyleKey::BorderStyle, "dotted");
        self
    }

    /// No border, whatever the widths set before or after (they take no
    /// space); [`Styled::border_solid`] and the other styles show it again.
    fn border_none(mut self) -> Self {
        self.style().keyword(StyleKey::BorderStyle, "none");
        self
    }

    /// The shape of its rounded corners.
    fn border_curve(mut self, curve: BorderCurve) -> Self {
        self.style().keyword(
            StyleKey::BorderCurve,
            match curve {
                BorderCurve::Circular => "circular",
                BorderCurve::Continuous => "continuous",
            },
        );
        self
    }

    /// The top left corner's radius.
    fn rounded_tl(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderTopLeftRadius], radius);
        });
        self
    }

    /// The top right corner's radius.
    fn rounded_tr(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderTopRightRadius], radius);
        });
        self
    }

    /// The bottom right corner's radius.
    fn rounded_br(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderBottomRightRadius], radius);
        });
        self
    }

    /// The bottom left corner's radius.
    fn rounded_bl(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderBottomLeftRadius], radius);
        });
        self
    }

    /// The left corners' radius.
    fn rounded_l(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(
                &[
                    StyleKey::BorderTopLeftRadius,
                    StyleKey::BorderBottomLeftRadius,
                ],
                radius,
            );
        });
        self
    }

    /// The right corners' radius.
    fn rounded_r(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(
                &[
                    StyleKey::BorderTopRightRadius,
                    StyleKey::BorderBottomRightRadius,
                ],
                radius,
            );
        });
        self
    }

    /// The top leading corner's radius (top left in left-to-right
    /// layouts; Tailwind's `rounded-ss`).
    fn rounded_ss(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderTopStartRadius], radius);
        });
        self
    }

    /// The top trailing corner's radius (`rounded-se`).
    fn rounded_se(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderTopEndRadius], radius);
        });
        self
    }

    /// The bottom trailing corner's radius (`rounded-ee`).
    fn rounded_ee(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderBottomEndRadius], radius);
        });
        self
    }

    /// The bottom leading corner's radius (`rounded-es`).
    fn rounded_es(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(&[StyleKey::BorderBottomStartRadius], radius);
        });
        self
    }

    /// The leading corners' radius.
    fn rounded_s(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(
                &[
                    StyleKey::BorderTopStartRadius,
                    StyleKey::BorderBottomStartRadius,
                ],
                radius,
            );
        });
        self
    }

    /// The trailing corners' radius.
    fn rounded_e(mut self, radius: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(radius, |s, radius: Length| {
            s.lengths(
                &[
                    StyleKey::BorderTopEndRadius,
                    StyleKey::BorderBottomEndRadius,
                ],
                radius,
            );
        });
        self
    }

    /// An outline `width` wide, outside the border; it takes no space.
    /// Solid unless a style method says otherwise, before or after it.
    fn outline(mut self, width: impl Into<AbsoluteLength>) -> Self {
        let s = self.style();
        s.number(StyleKey::OutlineWidth, points(width.into()));
        s.push(Declaration::DefaultKeyword(StyleKey::OutlineStyle, "solid"));
        self
    }

    /// The outline's color.
    fn outline_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::OutlineColor], color);
        });
        self
    }

    /// The outline's distance from the border (negative: inside it).
    fn outline_offset(mut self, offset: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style()
            .bind_value(offset, |s, offset: AbsoluteLength| {
                s.number(StyleKey::OutlineOffset, points(offset));
            });
        self
    }

    /// A dashed outline (3 points wide unless [`Styled::outline`] sets a
    /// width, as CSS's `medium`).
    fn outline_dashed(mut self) -> Self {
        let s = self.style();
        s.keyword(StyleKey::OutlineStyle, "dashed");
        s.push(Declaration::DefaultNumber(
            StyleKey::OutlineWidth,
            Bits(3.0),
        ));
        self
    }

    /// A dotted outline (3 points wide unless [`Styled::outline`] sets a
    /// width).
    fn outline_dotted(mut self) -> Self {
        let s = self.style();
        s.keyword(StyleKey::OutlineStyle, "dotted");
        s.push(Declaration::DefaultNumber(
            StyleKey::OutlineWidth,
            Bits(3.0),
        ));
        self
    }

    /// No outline.
    fn outline_none(mut self) -> Self {
        self.style().keyword(StyleKey::OutlineStyle, "none");
        self
    }

    /// No shadow.
    fn shadow_none(mut self) -> Self {
        self.style().push(Declaration::Shadow("none"));
        self
    }

    /// Tailwind's `shadow-2xs`.
    fn shadow_2xs(mut self) -> Self {
        self.style().push(Declaration::Shadow("2xs"));
        self
    }

    /// Tailwind's `shadow-xs`.
    fn shadow_xs(mut self) -> Self {
        self.style().push(Declaration::Shadow("xs"));
        self
    }

    /// Tailwind's `shadow-sm`.
    fn shadow_sm(mut self) -> Self {
        self.style().push(Declaration::Shadow("sm"));
        self
    }

    /// Tailwind's `shadow-md`.
    fn shadow_md(mut self) -> Self {
        self.style().push(Declaration::Shadow("md"));
        self
    }

    /// Tailwind's `shadow-lg`.
    fn shadow_lg(mut self) -> Self {
        self.style().push(Declaration::Shadow("lg"));
        self
    }

    /// Tailwind's `shadow-xl`.
    fn shadow_xl(mut self) -> Self {
        self.style().push(Declaration::Shadow("xl"));
        self
    }

    /// Tailwind's `shadow-2xl`.
    fn shadow_2xl(mut self) -> Self {
        self.style().push(Declaration::Shadow("2xl"));
        self
    }

    /// Box shadows of its own (CSS's `box-shadow`: offsets, blur, spread,
    /// color, `inset`), instead of a preset's.
    fn shadow(mut self, layers: impl IntoIterator<Item = BoxShadow>) -> Self {
        let layers: Arc<[BoxShadow]> = layers.into_iter().collect();
        self.style().push(Declaration::Shadows(Layers(layers)));
        self
    }

    /// The shadow's color: of the presets' layers (an opaque color keeps
    /// their alpha, Tailwind's `shadow-sky-500`; one with an alpha sets it,
    /// `shadow-sky-500/50`), or of the shadow set with
    /// [`Styled::shadow_opacity`], [`Styled::shadow_radius`] and
    /// [`Styled::shadow_offset`].
    fn shadow_color(mut self, color: impl Into<AdaptiveColor>) -> Self {
        let color = color.into();
        let s = self.style();
        s.color(&[StyleKey::ShadowColor], color);
        s.push(Declaration::PartColor(ColorPart::Shadow, color));
        self
    }

    /// A shadow of this opacity (0 by default: none), with
    /// [`Styled::shadow_color`] (black by default), [`Styled::shadow_radius`]
    /// and [`Styled::shadow_offset`].
    fn shadow_opacity(mut self, opacity: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(opacity, |s, opacity: f32| {
            s.number(StyleKey::ShadowOpacity, opacity.clamp(0.0, 1.0));
        });
        self
    }

    /// The shadow's blur radius (3 points by default).
    fn shadow_radius(mut self, radius: impl IntoReactive<Points>) -> Self {
        self.style().bind_value(radius, |s, radius: Points| {
            s.number(StyleKey::ShadowRadius, radius.0);
        });
        self
    }

    /// The shadow's offset (right and down; `(0, -3)` points by default).
    fn shadow_offset(mut self, offset: Point<Points>) -> Self {
        self.style().push(Declaration::ShadowOffset(
            Bits(offset.x.0),
            Bits(offset.y.0),
        ));
        self
    }

    /// Tailwind's `inset-shadow-2xs`.
    fn inset_shadow_2xs(mut self) -> Self {
        self.style().push(Declaration::InsetShadow("2xs"));
        self
    }

    /// Tailwind's `inset-shadow-xs`.
    fn inset_shadow_xs(mut self) -> Self {
        self.style().push(Declaration::InsetShadow("xs"));
        self
    }

    /// Tailwind's `inset-shadow-sm`.
    fn inset_shadow_sm(mut self) -> Self {
        self.style().push(Declaration::InsetShadow("sm"));
        self
    }

    /// No inset shadow.
    fn inset_shadow_none(mut self) -> Self {
        self.style().push(Declaration::InsetShadow("none"));
        self
    }

    /// The inset shadow's color (as [`Styled::shadow_color`] for the
    /// presets).
    fn inset_shadow_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::InsetShadow, color));
        });
        self
    }

    /// A ring `width` wide around the border (a solid shadow; it takes no
    /// space), in the text color unless [`Styled::ring_color`].
    fn ring(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.push(Declaration::Ring(Bits(points(width))));
        });
        self
    }

    /// The ring's color.
    fn ring_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::Ring, color));
        });
        self
    }

    /// A gap of `width` between the border and the ring.
    fn ring_offset(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.push(Declaration::RingOffset(Bits(points(width))));
        });
        self
    }

    /// The gap's color (white by default).
    fn ring_offset_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::RingOffset, color));
        });
        self
    }

    /// The ring inside the border instead.
    fn ring_inset(mut self) -> Self {
        self.style().push(Declaration::RingInset);
        self
    }

    /// A second ring `width` wide, inside the border.
    fn inset_ring(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.push(Declaration::InsetRing(Bits(points(width))));
        });
        self
    }

    /// The inside ring's color.
    fn inset_ring_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::InsetRing, color));
        });
        self
    }

    /// A linear gradient over the background, along `angle` (0 up,
    /// `deg(90.0)` right), from [`Styled::gradient_from`] through
    /// [`Styled::gradient_via`] to [`Styled::gradient_to`].
    fn bg_linear(mut self, angle: impl IntoReactive<Radians>) -> Self {
        self.style().bind_value(angle, |s, angle: Radians| {
            s.push(Declaration::Gradient(GradientShape::Linear(Bits(angle.0))));
        });
        self
    }

    /// A linear gradient towards the top.
    fn bg_linear_to_t(self) -> Self {
        self.bg_linear(deg(0.0))
    }

    /// A linear gradient towards the right.
    fn bg_linear_to_r(self) -> Self {
        self.bg_linear(deg(90.0))
    }

    /// A linear gradient towards the bottom.
    fn bg_linear_to_b(self) -> Self {
        self.bg_linear(deg(180.0))
    }

    /// A linear gradient towards the left.
    fn bg_linear_to_l(self) -> Self {
        self.bg_linear(deg(270.0))
    }

    /// A linear gradient towards the top right corner.
    fn bg_linear_to_tr(mut self) -> Self {
        self.style()
            .push(Declaration::Gradient(GradientShape::Corner {
                right: true,
                bottom: false,
            }));
        self
    }

    /// A linear gradient towards the bottom right corner.
    fn bg_linear_to_br(mut self) -> Self {
        self.style()
            .push(Declaration::Gradient(GradientShape::Corner {
                right: true,
                bottom: true,
            }));
        self
    }

    /// A linear gradient towards the bottom left corner.
    fn bg_linear_to_bl(mut self) -> Self {
        self.style()
            .push(Declaration::Gradient(GradientShape::Corner {
                right: false,
                bottom: true,
            }));
        self
    }

    /// A linear gradient towards the top left corner.
    fn bg_linear_to_tl(mut self) -> Self {
        self.style()
            .push(Declaration::Gradient(GradientShape::Corner {
                right: false,
                bottom: false,
            }));
        self
    }

    /// A radial gradient from the center to the farthest corner.
    fn bg_radial(mut self) -> Self {
        self.style()
            .push(Declaration::Gradient(GradientShape::Radial));
        self
    }

    /// A conic gradient around the center, starting at `angle` (0 up).
    fn bg_conic(mut self, angle: impl IntoReactive<Radians>) -> Self {
        self.style().bind_value(angle, |s, angle: Radians| {
            s.push(Declaration::Gradient(GradientShape::Conic(Bits(angle.0))));
        });
        self
    }

    /// No gradient.
    fn bg_gradient_none(mut self) -> Self {
        self.style().push(Declaration::GradientNone);
        self
    }

    /// The gradient's first color (transparent by default).
    fn gradient_from(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::From, color));
        });
        self
    }

    /// A color in the middle of the gradient.
    fn gradient_via(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::Via, color));
        });
        self
    }

    /// The gradient's last color (transparent by default).
    fn gradient_to(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.push(Declaration::PartColor(ColorPart::To, color));
        });
        self
    }

    /// Where the first color is along the gradient (0% by default).
    fn gradient_from_position(mut self, at: impl IntoReactive<Percentage>) -> Self {
        self.style().bind_value(at, |s, at: Percentage| {
            s.push(Declaration::StopPosition(0, Bits(at.0)));
        });
        self
    }

    /// Where the middle color is (50% by default).
    fn gradient_via_position(mut self, at: impl IntoReactive<Percentage>) -> Self {
        self.style().bind_value(at, |s, at: Percentage| {
            s.push(Declaration::StopPosition(1, Bits(at.0)));
        });
        self
    }

    /// Where the last color is (100% by default).
    fn gradient_to_position(mut self, at: impl IntoReactive<Percentage>) -> Self {
        self.style().bind_value(at, |s, at: Percentage| {
            s.push(Declaration::StopPosition(2, Bits(at.0)));
        });
        self
    }

    /// Blurs it and its content by `radius` (Tailwind's `blur-sm` is 8
    /// points).
    fn blur(self, radius: impl Into<Points>) -> Self {
        filter(self, false, FilterFn::Blur, radius.into().0)
    }

    /// Brightens (> 1) or darkens (< 1) it.
    fn brightness(self, amount: f32) -> Self {
        filter(self, false, FilterFn::Brightness, amount)
    }

    /// Raises (> 1) or lowers (< 1) its contrast.
    fn contrast(self, amount: f32) -> Self {
        filter(self, false, FilterFn::Contrast, amount)
    }

    /// Turns it gray (1: fully).
    fn grayscale(self, amount: f32) -> Self {
        filter(self, false, FilterFn::Grayscale, amount)
    }

    /// Turns its hues by `angle`.
    fn hue_rotate(self, angle: impl Into<Radians>) -> Self {
        filter(self, false, FilterFn::HueRotate, angle.into().to_degrees())
    }

    /// Inverts its colors (1: fully).
    fn invert(self, amount: f32) -> Self {
        filter(self, false, FilterFn::Invert, amount)
    }

    /// Saturates (> 1) or desaturates (< 1) it.
    fn saturate(self, amount: f32) -> Self {
        filter(self, false, FilterFn::Saturate, amount)
    }

    /// Tones it sepia (1: fully).
    fn sepia(self, amount: f32) -> Self {
        filter(self, false, FilterFn::Sepia, amount)
    }

    /// No filters.
    fn filter_none(mut self) -> Self {
        self.style().push(Declaration::FilterNone(false));
        self
    }

    /// Blurs what is behind it by `radius` (frosted glass; give it a
    /// translucent background).
    fn backdrop_blur(self, radius: impl Into<Points>) -> Self {
        filter(self, true, FilterFn::Blur, radius.into().0)
    }

    /// Brightens or darkens what is behind it.
    fn backdrop_brightness(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Brightness, amount)
    }

    /// Changes the contrast of what is behind it.
    fn backdrop_contrast(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Contrast, amount)
    }

    /// Turns what is behind it gray.
    fn backdrop_grayscale(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Grayscale, amount)
    }

    /// Turns the hues of what is behind it.
    fn backdrop_hue_rotate(self, angle: impl Into<Radians>) -> Self {
        filter(self, true, FilterFn::HueRotate, angle.into().to_degrees())
    }

    /// Inverts what is behind it.
    fn backdrop_invert(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Invert, amount)
    }

    /// Fades what is behind it.
    fn backdrop_opacity(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Opacity, amount)
    }

    /// Saturates what is behind it.
    fn backdrop_saturate(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Saturate, amount)
    }

    /// Tones what is behind it sepia.
    fn backdrop_sepia(self, amount: f32) -> Self {
        filter(self, true, FilterFn::Sepia, amount)
    }

    /// No backdrop filters.
    fn backdrop_filter_none(mut self) -> Self {
        self.style().push(Declaration::FilterNone(true));
        self
    }

    /// How it blends with what is behind it.
    fn mix_blend_mode(mut self, mode: BlendMode) -> Self {
        self.style().keyword(StyleKey::MixBlendMode, mode.name());
        self
    }

    /// The pointer's look over the element (`cursor`; desktops, and iPad
    /// and Android with a mouse).
    fn cursor(mut self, cursor: Cursor) -> Self {
        self.style().keyword(StyleKey::Cursor, cursor.name());
        self
    }

    /// The pointing hand over the element: something to press (Tailwind's
    /// `cursor-pointer`).
    fn cursor_pointer(self) -> Self {
        self.cursor(Cursor::Pointer)
    }

    /// Changes of colors, opacity, shadows and transforms animate
    /// (Tailwind's `transition`: 150ms, ease-in-out by default).
    fn transition(self) -> Self {
        transition(
            self,
            TransitionProps::COLORS
                | TransitionProps::OPACITY
                | TransitionProps::SHADOW
                | TransitionProps::TRANSFORM,
        )
    }

    /// Changes of everything that can animate do.
    fn transition_all(self) -> Self {
        transition(self, TransitionProps::ALL)
    }

    /// Changes of colors animate.
    fn transition_colors(self) -> Self {
        transition(self, TransitionProps::COLORS)
    }

    /// Changes of opacity animate.
    fn transition_opacity(self) -> Self {
        transition(self, TransitionProps::OPACITY)
    }

    /// Changes of shadows animate.
    fn transition_shadow(self) -> Self {
        transition(self, TransitionProps::SHADOW)
    }

    /// Changes of the transform animate.
    fn transition_transform(self) -> Self {
        transition(self, TransitionProps::TRANSFORM)
    }

    /// Changes jump.
    fn transition_none(mut self) -> Self {
        self.style().push(Declaration::TransitionNone);
        self
    }

    /// Transitions last `ms` milliseconds.
    fn duration(mut self, ms: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(ms, |s, ms: f32| {
            s.push(Declaration::Duration(Bits(ms)));
        });
        self
    }

    /// Transitions start after `ms` milliseconds.
    fn delay(mut self, ms: impl IntoReactive<f32>) -> Self {
        self.style().bind_value(ms, |s, ms: f32| {
            s.push(Declaration::Delay(Bits(ms)));
        });
        self
    }

    /// Transitions at a constant pace.
    fn ease_linear(mut self) -> Self {
        self.style().push(Declaration::EasePreset("linear"));
        self
    }

    /// Transitions that start slowly.
    fn ease_in(mut self) -> Self {
        self.style().push(Declaration::EasePreset("in"));
        self
    }

    /// Transitions that end slowly.
    fn ease_out(mut self) -> Self {
        self.style().push(Declaration::EasePreset("out"));
        self
    }

    /// Transitions that start and end slowly.
    fn ease_in_out(mut self) -> Self {
        self.style().push(Declaration::EasePreset("in-out"));
        self
    }

    /// Transitions along the cubic Bézier curve `x1, y1, x2, y2`.
    fn ease_bezier(mut self, x1: f32, y1: f32, x2: f32, y2: f32) -> Self {
        self.style()
            .push(Declaration::Ease([x1, y1, x2, y2].map(Bits)));
        self
    }

    /// Turns around, forever (Tailwind's `animate-spin`: a loader).
    fn animate_spin(mut self) -> Self {
        self.style().push(Declaration::Animate(Some(0)));
        self
    }

    /// Scales up and fades out, forever (`animate-ping`: a badge's pulse).
    fn animate_ping(mut self) -> Self {
        self.style().push(Declaration::Animate(Some(1)));
        self
    }

    /// Fades to half and back, forever (`animate-pulse`: a skeleton).
    fn animate_pulse(mut self) -> Self {
        self.style().push(Declaration::Animate(Some(2)));
        self
    }

    /// Jumps and lands, forever (`animate-bounce`).
    fn animate_bounce(mut self) -> Self {
        self.style().push(Declaration::Animate(Some(3)));
        self
    }

    /// A keyframe animation with its own timing (TS: `animationName`
    /// with `animationDuration`, `animationDelay`,
    /// `animationTimingFunction`, `animationIterationCount`):
    /// `.animation(KeyframeAnimation::new(Keyframes::Spin).duration(800.0))`.
    fn animation(mut self, animation: KeyframeAnimation) -> Self {
        let index = KEYFRAMES
            .iter()
            .position(|k| *k == animation.keyframes)
            .expect("every keyframes") as u8;
        self.style().push(Declaration::Animation(
            index,
            Bits(animation.duration),
            Bits(animation.delay),
            animation.easing.map(Bits),
            animation.iterations,
        ));
        self
    }

    /// No keyframe animation.
    fn animate_none(mut self) -> Self {
        self.style().push(Declaration::Animate(None));
        self
    }

    /// Scales from the center (1 is the natural size).
    fn scale(self, scale: impl IntoReactive<f32>) -> Self {
        self.transform_step(TransformKind::Scale, scale)
    }

    /// Scales horizontally.
    fn scale_x(self, scale: impl IntoReactive<f32>) -> Self {
        self.transform_step(TransformKind::ScaleX, scale)
    }

    /// Scales vertically.
    fn scale_y(self, scale: impl IntoReactive<f32>) -> Self {
        self.transform_step(TransformKind::ScaleY, scale)
    }

    /// Moves horizontally by `offset` (after layout): points, or a
    /// fraction of its own width (`relative(-0.5)`).
    fn translate_x(self, offset: impl IntoReactive<DefiniteLength>) -> Self {
        transform_with(self, offset, |offset| {
            translation(
                offset,
                TransformKind::TranslateX,
                TransformKind::TranslateXFraction,
            )
        })
    }

    /// Moves vertically by `offset` (after layout): points, or a fraction
    /// of its own height.
    fn translate_y(self, offset: impl IntoReactive<DefiniteLength>) -> Self {
        transform_with(self, offset, |offset| {
            translation(
                offset,
                TransformKind::TranslateY,
                TransformKind::TranslateYFraction,
            )
        })
    }

    /// Rotates by `angle`, clockwise.
    fn rotate(self, angle: impl IntoReactive<Radians>) -> Self {
        transform_with(self, angle, |a: Radians| {
            (TransformKind::Rotate, a.to_degrees())
        })
    }

    /// Rotates by `angle` around the horizontal axis (3D; in a view with
    /// [`Styled::perspective`] it tilts towards the viewer).
    fn rotate_x(self, angle: impl IntoReactive<Radians>) -> Self {
        transform_with(self, angle, |a: Radians| {
            (TransformKind::RotateX, a.to_degrees())
        })
    }

    /// Rotates by `angle` around the vertical axis (3D).
    fn rotate_y(self, angle: impl IntoReactive<Radians>) -> Self {
        transform_with(self, angle, |a: Radians| {
            (TransformKind::RotateY, a.to_degrees())
        })
    }

    /// Slants vertical edges by `angle` (iOS; Android has no skew).
    fn skew_x(self, angle: impl IntoReactive<Radians>) -> Self {
        transform_with(self, angle, |a: Radians| {
            (TransformKind::SkewX, a.to_degrees())
        })
    }

    /// Slants horizontal edges by `angle` (iOS).
    fn skew_y(self, angle: impl IntoReactive<Radians>) -> Self {
        transform_with(self, angle, |a: Radians| {
            (TransformKind::SkewY, a.to_degrees())
        })
    }

    /// Gives its children depth: their 3D rotations are seen from
    /// `distance` away (smaller: stronger), from its center (CSS's
    /// `perspective`, `perspective-*`).
    fn perspective(self, distance: impl IntoReactive<AbsoluteLength>) -> Self {
        transform_with(self, distance, |d: AbsoluteLength| {
            (TransformKind::Perspective, points(d))
        })
    }

    /// The step `kind` of its transform, by `amount`. The steps compose in
    /// CSS's order, whatever the order of the calls: translate, rotate,
    /// scale, then the 3D rotations and the skews.
    /// [`TransformKind::Perspective`] is [`Styled::perspective`], its
    /// children's depth.
    fn transform_step(self, kind: TransformKind, amount: impl IntoReactive<f32>) -> Self {
        transform_with(self, amount, move |amount| (kind, amount))
    }

    /// No 3D rotations and skews (CSS's `transform: none`; the
    /// translation, rotation and scale are properties of their own, which
    /// [`Styled::translate_none`], [`Styled::rotate_none`] and
    /// [`Styled::scale_none`] remove).
    fn transform_none(self) -> Self {
        transform_reset(self, Declaration::TransformNone)
    }

    /// No translation (also none set before).
    fn translate_none(self) -> Self {
        transform_reset(self, Declaration::TranslateNone)
    }

    /// No scale (also none set before).
    fn scale_none(self) -> Self {
        transform_reset(self, Declaration::ScaleNone)
    }

    /// No rotation (also none set before; the 3D rotations stay).
    fn rotate_none(self) -> Self {
        transform_reset(self, Declaration::RotateNone)
    }

    /// The point its transform turns and scales around (the center by
    /// default).
    fn transform_origin(mut self, origin: TransformOrigin) -> Self {
        let axis = |l: DefiniteLength| match l {
            DefiniteLength::Absolute(a) => (false, Bits(a.to_points(REM_SIZE).0)),
            DefiniteLength::Fraction(f) => (true, Bits(f.0)),
        };
        self.style()
            .push(Declaration::Origin([axis(origin.x), axis(origin.y)]));
        self
    }

    /// Transforms around its top left corner.
    fn origin_top_left(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "top left");
        self
    }

    /// Transforms around the middle of its top edge.
    fn origin_top(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "top");
        self
    }

    /// Transforms around its top right corner.
    fn origin_top_right(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "top right");
        self
    }

    /// Transforms around the middle of its left edge.
    fn origin_left(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "left");
        self
    }

    /// Transforms around its center (the default).
    fn origin_center(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "center");
        self
    }

    /// Transforms around the middle of its right edge.
    fn origin_right(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "right");
        self
    }

    /// Transforms around its bottom left corner.
    fn origin_bottom_left(mut self) -> Self {
        self.style()
            .keyword(StyleKey::TransformOrigin, "bottom left");
        self
    }

    /// Transforms around the middle of its bottom edge.
    fn origin_bottom(mut self) -> Self {
        self.style().keyword(StyleKey::TransformOrigin, "bottom");
        self
    }

    /// Transforms around its bottom right corner.
    fn origin_bottom_right(mut self) -> Self {
        self.style()
            .keyword(StyleKey::TransformOrigin, "bottom right");
        self
    }

    /// Where an image sits in its box once its resize mode has sized it
    /// (CSS's `object-position`; the center by default): a covering image
    /// is cropped around it.
    fn object_position(mut self, position: ObjectPosition) -> Self {
        self.style().push(Declaration::Str(
            StyleKey::ObjectPosition,
            position.to_string().into(),
        ));
        self
    }

    /// Shows an image's top left corner (Tailwind's `object-top-left`).
    fn object_top_left(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "left top");
        self
    }

    /// Shows an image's top (Tailwind's `object-top`): a tall image
    /// covering its box is cropped at the bottom.
    fn object_top(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "top");
        self
    }

    /// Shows an image's top right corner (Tailwind's `object-top-right`).
    fn object_top_right(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "right top");
        self
    }

    /// Shows an image's left side (Tailwind's `object-left`).
    fn object_left(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "left");
        self
    }

    /// Centers an image in its box (Tailwind's `object-center`, the
    /// default).
    fn object_center(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "center");
        self
    }

    /// Shows an image's right side (Tailwind's `object-right`).
    fn object_right(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "right");
        self
    }

    /// Shows an image's bottom left corner (Tailwind's
    /// `object-bottom-left`).
    fn object_bottom_left(mut self) -> Self {
        self.style()
            .keyword(StyleKey::ObjectPosition, "left bottom");
        self
    }

    /// Shows an image's bottom (Tailwind's `object-bottom`).
    fn object_bottom(mut self) -> Self {
        self.style().keyword(StyleKey::ObjectPosition, "bottom");
        self
    }

    /// Shows an image's bottom right corner (Tailwind's
    /// `object-bottom-right`).
    fn object_bottom_right(mut self) -> Self {
        self.style()
            .keyword(StyleKey::ObjectPosition, "right bottom");
        self
    }

    /// Invisible while its 3D rotations turn it away (a card's back).
    fn backface_hidden(mut self) -> Self {
        self.style().keyword(StyleKey::BackfaceVisibility, "hidden");
        self
    }

    /// Visible from behind too (the default).
    fn backface_visible(mut self) -> Self {
        self.style()
            .keyword(StyleKey::BackfaceVisibility, "visible");
        self
    }

    // Text (inherited by the texts inside).

    /// The text color.
    fn text_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::Color], color);
        });
        self
    }

    /// The tint color (Tailwind's `tint-*`): of template images, and of a
    /// page header's buttons in [`super::Screen::header_style_with`].
    fn tint_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::TintColor], color);
        });
        self
    }

    /// What the shapes the element draws are filled with (`fill`,
    /// Tailwind's `fill-<color>`; the elements inside inherit it, as in
    /// CSS): the areas of `nsh_base::plot`.
    fn fill_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::Fill], color);
        });
        self
    }

    /// No fill (`fill-none`).
    fn fill_none(mut self) -> Self {
        self.style().keyword(StyleKey::Fill, "none");
        self
    }

    /// The text color as the fill (`fill-current`, `currentColor`).
    fn fill_current(mut self) -> Self {
        self.style().keyword(StyleKey::Fill, "currentColor");
        self
    }

    /// What the outlines of the shapes the element draws are painted with
    /// (`stroke`, Tailwind's `stroke-<color>`; inherited, as in CSS): the
    /// lines and grids of `nsh_base::plot`.
    fn stroke_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::Stroke], color);
        });
        self
    }

    /// No stroke (`stroke-none`).
    fn stroke_none(mut self) -> Self {
        self.style().keyword(StyleKey::Stroke, "none");
        self
    }

    /// The text color as the stroke (`stroke-current`, `currentColor`).
    fn stroke_current(mut self) -> Self {
        self.style().keyword(StyleKey::Stroke, "currentColor");
        self
    }

    /// The width of those outlines (`strokeWidth`, Tailwind's
    /// `stroke-<number>`; 1 by default, inherited).
    fn stroke_width(mut self, width: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style().bind_value(width, |s, width: AbsoluteLength| {
            s.number(StyleKey::StrokeWidth, points(width));
        });
        self
    }

    /// The font size, in points.
    fn text_size(mut self, size: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(size, |s, size: Length| {
            s.lengths(&[StyleKey::FontSize], size);
        });
        self
    }

    /// 12pt text, 16pt lines.
    fn text_xs(mut self) -> Self {
        self.style().push(Declaration::TextPreset("xs"));
        self
    }

    /// 14pt text, 20pt lines.
    fn text_sm(mut self) -> Self {
        self.style().push(Declaration::TextPreset("sm"));
        self
    }

    /// 16pt text, 24pt lines.
    fn text_base(mut self) -> Self {
        self.style().push(Declaration::TextPreset("base"));
        self
    }

    /// 18pt text, 28pt lines.
    fn text_lg(mut self) -> Self {
        self.style().push(Declaration::TextPreset("lg"));
        self
    }

    /// 20pt text, 28pt lines.
    fn text_xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("xl"));
        self
    }

    /// 24pt text, 32pt lines.
    fn text_2xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("2xl"));
        self
    }

    /// 30pt text, 36pt lines.
    fn text_3xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("3xl"));
        self
    }

    /// 36pt text, 40pt lines.
    fn text_4xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("4xl"));
        self
    }

    /// 48pt text, 48pt lines.
    fn text_5xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("5xl"));
        self
    }

    /// 60pt text, 60pt lines.
    fn text_6xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("6xl"));
        self
    }

    /// 72pt text, 72pt lines.
    fn text_7xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("7xl"));
        self
    }

    /// 96pt text, 96pt lines.
    fn text_8xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("8xl"));
        self
    }

    /// 128pt text, 128pt lines.
    fn text_9xl(mut self) -> Self {
        self.style().push(Declaration::TextPreset("9xl"));
        self
    }

    /// The line height, in points.
    fn line_height(mut self, height: impl IntoReactive<Length>) -> Self {
        self.style().bind_value(height, |s, height: Length| {
            s.lengths(&[StyleKey::LineHeight], height);
        });
        self
    }

    /// The font weight.
    fn font_weight(mut self, weight: FontWeight) -> Self {
        self.style().number(StyleKey::FontWeight, weight.0 as f32);
        self
    }

    /// The font family (`None` style: the system font is the default).
    fn font_family(mut self, family: impl IntoReactive<SharedString>) -> Self {
        self.style().bind_value(family, |s, family: SharedString| {
            s.push(Declaration::Str(StyleKey::FontFamily, family));
        });
        self
    }

    /// Italic text.
    fn italic(mut self) -> Self {
        self.style().keyword(StyleKey::FontStyle, "italic");
        self
    }

    /// Underlined text (with [`Styled::line_through`], both lines).
    fn underline(mut self) -> Self {
        self.style().push(Declaration::Decoration(UNDERLINE));
        self
    }

    /// Struck-through text (with [`Styled::underline`], both lines).
    fn line_through(mut self) -> Self {
        self.style().push(Declaration::Decoration(LINE_THROUGH));
        self
    }

    /// No underline nor strike-through.
    fn no_underline(mut self) -> Self {
        self.style().push(Declaration::Decoration(0));
        self
    }

    /// The color of the underline and strike-through (the text's by
    /// default).
    fn text_decoration_color(mut self, color: impl IntoReactive<AdaptiveColor>) -> Self {
        self.style().bind_value(color, |s, color: AdaptiveColor| {
            s.color(&[StyleKey::TextDecorationColor], color);
        });
        self
    }

    /// Solid decoration lines (the default).
    fn text_decoration_solid(mut self) -> Self {
        self.style().keyword(StyleKey::TextDecorationStyle, "solid");
        self
    }

    /// Double decoration lines.
    fn text_decoration_double(mut self) -> Self {
        self.style()
            .keyword(StyleKey::TextDecorationStyle, "double");
        self
    }

    /// Dotted decoration lines.
    fn text_decoration_dotted(mut self) -> Self {
        self.style()
            .keyword(StyleKey::TextDecorationStyle, "dotted");
        self
    }

    /// Dashed decoration lines.
    fn text_decoration_dashed(mut self) -> Self {
        self.style()
            .keyword(StyleKey::TextDecorationStyle, "dashed");
        self
    }

    /// Wavy decoration lines (spelling marks).
    fn text_decoration_wavy(mut self) -> Self {
        self.style().keyword(StyleKey::TextDecorationStyle, "wavy");
        self
    }

    /// The decoration lines' thickness.
    fn text_decoration_thickness(mut self, thickness: impl IntoReactive<Points>) -> Self {
        self.style().bind_value(thickness, |s, thickness: Points| {
            s.number(StyleKey::TextDecorationThickness, thickness.0);
        });
        self
    }

    /// The underline's distance below the baseline.
    fn underline_offset(mut self, offset: impl IntoReactive<Points>) -> Self {
        self.style().bind_value(offset, |s, offset: Points| {
            s.number(StyleKey::TextUnderlineOffset, offset.0);
        });
        self
    }

    /// Shown in capitals (the content stays as it is).
    fn uppercase(mut self) -> Self {
        self.style().keyword(StyleKey::TextTransform, "uppercase");
        self
    }

    /// Shown in small letters.
    fn lowercase(mut self) -> Self {
        self.style().keyword(StyleKey::TextTransform, "lowercase");
        self
    }

    /// Each word shown with a capital first letter.
    fn capitalize(mut self) -> Self {
        self.style().keyword(StyleKey::TextTransform, "capitalize");
        self
    }

    /// Shown as written (undoes an inherited case).
    fn normal_case(mut self) -> Self {
        self.style().keyword(StyleKey::TextTransform, "none");
        self
    }

    /// Digits of one width, for columns of numbers.
    fn tabular_nums(self) -> Self {
        font_variant(
            self,
            FontVariant::TABULAR_NUMS,
            FontVariant::PROPORTIONAL_NUMS,
        )
    }

    /// Digits of their own widths (the default).
    fn proportional_nums(self) -> Self {
        font_variant(
            self,
            FontVariant::PROPORTIONAL_NUMS,
            FontVariant::TABULAR_NUMS,
        )
    }

    /// Old-style digits, with ascenders and descenders.
    fn oldstyle_nums(self) -> Self {
        font_variant(self, FontVariant::OLDSTYLE_NUMS, FontVariant::LINING_NUMS)
    }

    /// Lining digits, all of capital height.
    fn lining_nums(self) -> Self {
        font_variant(self, FontVariant::LINING_NUMS, FontVariant::OLDSTYLE_NUMS)
    }

    /// Small capitals for lower-case letters.
    fn small_caps(self) -> Self {
        font_variant(self, FontVariant::SMALL_CAPS, 0)
    }

    /// The font's own number forms (undoes the number forms set before;
    /// `small_caps` stays).
    fn normal_nums(self) -> Self {
        font_variant(self, 0, !FontVariant::SMALL_CAPS)
    }

    /// The layout direction of the view and its subtree (by default its
    /// parent's; the surface's follows the user's language).
    fn direction(mut self, direction: impl IntoReactive<LayoutDirection>) -> Self {
        self.style()
            .bind_value(direction, |s, direction: LayoutDirection| {
                s.keyword(
                    StyleKey::Direction,
                    match direction {
                        LayoutDirection::Inherit => "inherit",
                        LayoutDirection::Ltr => "ltr",
                        LayoutDirection::Rtl => "rtl",
                    },
                );
            });
        self
    }

    /// The text's base direction (by default its content's).
    fn writing_direction(mut self, direction: WritingDirection) -> Self {
        self.style().keyword(
            StyleKey::WritingDirection,
            match direction {
                WritingDirection::Auto => "auto",
                WritingDirection::Ltr => "ltr",
                WritingDirection::Rtl => "rtl",
            },
        );
        self
    }

    /// Lines stretched to both edges.
    fn text_justify(mut self) -> Self {
        self.style().keyword(StyleKey::TextAlign, "justify");
        self
    }

    /// Tailwind's `text-shadow-2xs`.
    fn text_shadow_2xs(mut self) -> Self {
        self.style().push(Declaration::TextShadow("2xs"));
        self
    }

    /// Tailwind's `text-shadow-xs`.
    fn text_shadow_xs(mut self) -> Self {
        self.style().push(Declaration::TextShadow("xs"));
        self
    }

    /// Tailwind's `text-shadow-sm`.
    fn text_shadow_sm(mut self) -> Self {
        self.style().push(Declaration::TextShadow("sm"));
        self
    }

    /// Tailwind's `text-shadow-md`.
    fn text_shadow_md(mut self) -> Self {
        self.style().push(Declaration::TextShadow("md"));
        self
    }

    /// Tailwind's `text-shadow-lg`.
    fn text_shadow_lg(mut self) -> Self {
        self.style().push(Declaration::TextShadow("lg"));
        self
    }

    /// No text shadow from the presets.
    fn text_shadow_none(mut self) -> Self {
        self.style().push(Declaration::TextShadow("none"));
        self
    }

    /// The text shadow's color: of a preset (an opaque color keeps the
    /// preset's alpha), or of the shadow set with
    /// [`Styled::text_shadow_radius`] and [`Styled::text_shadow_offset`].
    fn text_shadow_color(mut self, color: impl Into<AdaptiveColor>) -> Self {
        let color = color.into();
        let s = self.style();
        s.color(&[StyleKey::TextShadowColor], color);
        s.push(Declaration::PartColor(ColorPart::TextShadow, color));
        self
    }

    /// The text shadow's blur radius.
    fn text_shadow_radius(mut self, radius: impl IntoReactive<Points>) -> Self {
        self.style().bind_value(radius, |s, radius: Points| {
            s.number(StyleKey::TextShadowRadius, radius.0);
        });
        self
    }

    /// The text shadow's offset (right and down).
    fn text_shadow_offset(mut self, offset: Point<Points>) -> Self {
        self.style().push(Declaration::TextShadowOffset(
            Bits(offset.x.0),
            Bits(offset.y.0),
        ));
        self
    }

    /// Text aligned left.
    fn text_left(mut self) -> Self {
        self.style().keyword(StyleKey::TextAlign, "left");
        self
    }

    /// Text centered.
    fn text_center(mut self) -> Self {
        self.style().keyword(StyleKey::TextAlign, "center");
        self
    }

    /// Text aligned right.
    fn text_right(mut self) -> Self {
        self.style().keyword(StyleKey::TextAlign, "right");
        self
    }

    /// Inside a text, its bottom on the baseline (the default:
    /// `align-baseline`).
    fn align_baseline(mut self) -> Self {
        self.style().keyword(StyleKey::VerticalAlign, "baseline");
        self
    }

    /// Inside a text, its top at the top of the text's font
    /// (`align-text-top`).
    fn align_text_top(mut self) -> Self {
        self.style().keyword(StyleKey::VerticalAlign, "text-top");
        self
    }

    /// Inside a text, its bottom at the bottom of the text's font
    /// (`align-text-bottom`).
    fn align_text_bottom(mut self) -> Self {
        self.style().keyword(StyleKey::VerticalAlign, "text-bottom");
        self
    }

    /// Inside a text, its middle half the font's x height above the
    /// baseline (`align-middle`).
    fn align_middle(mut self) -> Self {
        self.style().keyword(StyleKey::VerticalAlign, "middle");
        self
    }

    /// Extra space between letters.
    fn letter_spacing(mut self, spacing: impl IntoReactive<AbsoluteLength>) -> Self {
        self.style()
            .bind_value(spacing, |s, spacing: AbsoluteLength| {
                s.number(StyleKey::LetterSpacing, points(spacing));
            });
        self
    }

    // Variants (native: nothing runs).

    /// `f`'s styles while `when` holds: a value decides once, a signal or a
    /// closure switches them as it changes (Tailwind's classes made
    /// conditional; native states such as `.active` need none).
    fn style_when(
        mut self,
        when: impl IntoReactive<bool>,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self {
        let layer = f(StyleRefinement::default());
        match when.into_reactive() {
            Reactive::Static(true) => self.style().extend_as(Variant::default(), layer),
            Reactive::Static(false) => {}
            Reactive::Bound(when) => self.style().bind(move |s| {
                if when() {
                    s.extend_as(Variant::default(), layer.resolved());
                }
            }),
        }
        self
    }

    /// The styles `f` makes, made again when what it reads changes (any
    /// style that depends on the app's state; a value that changes alone
    /// is better given to its method: `.w(move || px(width.get()))`).
    fn style_with(mut self, f: impl Fn(StyleRefinement) -> StyleRefinement + 'static) -> Self {
        self.style().bind(move |s| {
            let made = f(StyleRefinement::default()).resolved();
            s.extend_as(Variant::default(), made);
        });
        self
    }

    /// Styles in dark appearance (Tailwind's `dark:`), for what is not a
    /// color: theme colors switch by themselves.
    fn dark(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::DARK, s);
        self
    }

    /// Styles while selected (Tailwind's `selected:`): the element's
    /// accessibility state says so (a `Button`'s `selected`, a tab's).
    fn selected(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::SELECTED, s);
        self
    }

    /// Styles while checked (Tailwind's `checked:`): the element's
    /// accessibility state says so, not mixed (a checkbox's, a switch's, a
    /// radio's), or the control it is a part of is
    /// (`Interactive::project_checked`: a switch's thumb).
    fn checked(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::CHECKED, s);
        self
    }

    /// Styles while indeterminate (Tailwind's `indeterminate:`): the
    /// element's accessibility state says checked is mixed (a checkbox
    /// that is neither), or the control it is a part of is
    /// (`Interactive::project_indeterminate`: a checkbox's indicator).
    fn indeterminate(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::INDETERMINATE, s);
        self
    }

    /// Makes it a group: the `group_*` styles of the elements inside follow
    /// its press, hover and focus (Tailwind's `group`).
    fn group(mut self) -> Self {
        self.style().push(Declaration::Group(""));
        self
    }

    /// Makes it the group `name` (`group/name`), for `group_*_named`
    /// styles inside it that skip nearer groups.
    fn group_named(mut self, name: &'static str) -> Self {
        self.style().push(Declaration::Group(name));
        self
    }

    /// Styles while the nearest [`Styled::group`] around it is pressed
    /// (`group-active:`).
    fn group_active(self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        in_group(self, "", state::PRESSED, f)
    }

    /// Styles while the nearest group around it is hovered.
    fn group_hover(self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        in_group(self, "", state::HOVERED, f)
    }

    /// Styles while an input in the nearest group around it has focus
    /// (`group-focus-within:`).
    fn group_focus_within(self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        in_group(self, "", state::FOCUS_WITHIN, f)
    }

    /// Styles while the group `name` around it is pressed
    /// (`group-active/name:`).
    fn group_active_named(
        self,
        name: &'static str,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self {
        in_group(self, name, state::PRESSED, f)
    }

    /// Styles while the group `name` around it is hovered.
    fn group_hover_named(
        self,
        name: &'static str,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self {
        in_group(self, name, state::HOVERED, f)
    }

    /// Styles while an input in the group `name` around it has focus.
    fn group_focus_within_named(
        self,
        name: &'static str,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self {
        in_group(self, name, state::FOCUS_WITHIN, f)
    }
}

/// `s` with filter `f` by `amount` (of what is behind it when `backdrop`).
/// `s` with the transform step `step` makes of `value` (its kind and
/// operand).
fn transform_with<S: Styled, T: Clone + 'static>(
    mut s: S,
    value: impl IntoReactive<T>,
    step: impl Fn(T) -> (TransformKind, f32) + 'static,
) -> S {
    // Steps compose in order: after a bound part, a static step is
    // applied with the bound ones too.
    let style = s.style();
    match value.into_reactive() {
        Reactive::Static(value) if !style.is_bound() => {
            let (kind, amount) = step(value);
            style.push(Declaration::Transform(kind, Bits(amount)));
        }
        value => style.bind(move |st| {
            let (kind, amount) = step(value.get());
            st.push(Declaration::Transform(kind, Bits(amount)));
        }),
    }
    s
}

/// `reset` (`transform_none()`, ...), in order with the bound steps.
fn transform_reset<S: Styled>(mut s: S, reset: Declaration) -> S {
    let style = s.style();
    if style.is_bound() {
        style.bind(move |st| st.push(reset.clone()));
    } else {
        style.push(reset);
    }
    s
}

/// A translation's step: points (a rem at [`REM_SIZE`]) or a fraction of
/// the size.
fn translation(
    offset: DefiniteLength,
    points_kind: TransformKind,
    fraction_kind: TransformKind,
) -> (TransformKind, f32) {
    match offset {
        DefiniteLength::Absolute(a) => (points_kind, points(a)),
        DefiniteLength::Fraction(f) => (fraction_kind, f.0),
    }
}

fn filter<S: Styled>(mut s: S, backdrop: bool, f: FilterFn, amount: f32) -> S {
    s.style()
        .push(Declaration::Filter(backdrop, f, Bits(amount)));
    s
}

/// `s` with transitions of the [`TransitionProps`] `props`.
fn transition<S: Styled>(mut s: S, props: u8) -> S {
    s.style().push(Declaration::Transition(props));
    s
}

/// `s` with `f`'s styles while the group `name` is in `states`.
fn in_group<S: Styled>(
    mut s: S,
    name: &'static str,
    states: u8,
    f: impl FnOnce(StyleRefinement) -> StyleRefinement,
) -> S {
    let styles = f(StyleRefinement::default());
    let style = s.style();
    let group = style.name(name);
    style.extend_as(
        Variant {
            group_states: states,
            group,
            ..Variant::default()
        },
        styles,
    );
    s
}

impl Styled for StyleRefinement {
    fn style(&mut self) -> &mut StyleRefinement {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Style,
        color::{rgb, rgba},
        geometry::point,
        tailwind::{ClassEnvironment, ClassProps, Context},
        ui::palette::{EMERALD, PINK, RED, SKY, VIOLET},
    };

    /// What `list` resolves to in `dark` appearance, in [`state`] `states`,
    /// inside a group in `group` (as text, to compare).
    fn resolve(list: &ClassList, dark: bool, states: u8, group: u8) -> String {
        resolve_with(list, dark, states, group, &|_| {})
    }

    /// [`resolve`], then `inline` on the style.
    fn resolve_with(
        list: &ClassList,
        dark: bool,
        states: u8,
        group: u8,
        inline: &dyn Fn(&mut Style),
    ) -> String {
        let cx = Context {
            env: ClassEnvironment {
                dark,
                ..Default::default()
            },
            window: crate::geometry::size_pt(390.0, 844.0),
            rtl: false,
            states,
            position: 0,
            group: &|_| group,
        };
        let mut style = Style::default();
        let mut props = ClassProps::default();
        list.apply(&cx, &PRESETS, &mut style, &mut props, inline);
        format!("{style:?} {props:?}")
    }

    /// `typed` styles an element as Tailwind's `classes` do, in both
    /// appearances and in every state.
    #[track_caller]
    fn same(typed: StyleRefinement, classes: &str) {
        same_with(typed, classes, &|_| {});
    }

    /// [`same`], `classes` then `inline` (what classes cannot say).
    #[track_caller]
    fn same_with(typed: StyleRefinement, classes: &str, inline: &dyn Fn(&mut Style)) {
        let typed = typed.lower();
        let parsed = tailwind::parse(&PRESETS, classes);
        assert!(parsed.unknown().is_empty(), "{:?}", parsed.unknown());
        assert_eq!(typed.deps(), parsed.deps(), "{classes}: deps");
        assert_eq!(typed.groups(), parsed.groups(), "{classes}: groups");
        for dark in [false, true] {
            for states in [0, state::PRESSED, state::DISABLED] {
                for group in [0, state::PRESSED, state::HOVERED] {
                    assert_eq!(
                        resolve(&typed, dark, states, group),
                        resolve_with(&parsed, dark, states, group, inline),
                        "{classes} (dark {dark}, states {states}, group {group})"
                    );
                }
            }
        }
    }

    fn s() -> StyleRefinement {
        StyleRefinement::default()
    }

    #[test]
    fn svg_paint_is_tailwinds() {
        same(
            s().fill_color(RED.shade(600))
                .stroke_color(SKY.shade(500))
                .stroke_width(px(2.0)),
            "fill-red-600 stroke-sky-500 stroke-2",
        );
        same(s().fill_none().stroke_current(), "fill-none stroke-current");
        same(s().fill_current().stroke_none(), "fill-current stroke-none");
    }

    #[test]
    fn borders_and_corners_are_tailwinds() {
        same(
            s().border_t(px(6.0))
                .border_t_color(RED.shade(600))
                .border_r(px(2.0))
                .border_b(px(4.0))
                .border_l(px(1.0))
                .border_x_color(SKY.shade(500)),
            "border-t-6 border-t-red-600 border-r-2 border-b-4 border-l border-x-sky-500",
        );
        same(
            s().border_y(px(3.0))
                .border_s(px(1.0))
                .border_e(px(2.0))
                .border_dashed(),
            "border-y-3 border-s border-e-2 border-dashed",
        );
        same(s().border_none().border(px(2.0)), "border-none border-2");
        same(
            s().border(px(3.0)).border_dotted(),
            "border-3 border-dotted",
        );
        same(
            s().rounded_tl(px(44.0))
                .rounded_tr(px(6.0))
                .rounded_br(px(28.0))
                .rounded_bl(px(2.0)),
            "rounded-tl-[44px] rounded-tr-[6px] rounded-br-[28px] rounded-bl-[2px]",
        );
        same(
            s().rounded_ss(px(22.0))
                .rounded_ee(px(8.0))
                .rounded_l(px(4.0)),
            "rounded-ss-[22px] rounded-ee-[8px] rounded-l-[4px]",
        );
        same(
            s().outline(px(2.0))
                .outline_offset(px(2.0))
                .outline_dashed()
                .outline_color(PINK.shade(500)),
            "outline-2 outline-offset-2 outline-dashed outline-pink-500",
        );
        same(
            s().outline_dotted().outline(px(2.0)),
            "outline-dotted outline-2",
        );
        same(s().outline_dashed(), "outline-dashed");
        let curved = s().border_curve(BorderCurve::Continuous).lower();
        let mut style = Style::default();
        let _ = style.set_key(StyleKey::BorderCurve, crate::StyleValue::Str("continuous"));
        assert_eq!(
            resolve(&curved, false, 0, 0),
            format!("{style:?} {:?}", ClassProps::default())
        );
    }

    #[test]
    fn shadows_and_rings_are_tailwinds() {
        // The color is React Native's shadow's too (invisible at its
        // default opacity 0).
        let emerald = EMERALD.shade(500).opacity(0.5);
        same_with(
            s().shadow_lg().shadow_color(emerald),
            "shadow-lg shadow-emerald-500/50",
            &|s| s.view.shadow.color = emerald.into(),
        );
        same_with(
            s().shadow_xl().shadow_color(SKY.shade(500)),
            "shadow-xl shadow-sky-500",
            &|s| s.view.shadow.color = SKY.shade(500).into(),
        );
        same(s().inset_shadow_sm(), "inset-shadow-sm");
        same(
            s().ring(px(2.0))
                .ring_color(SKY.shade(500))
                .ring_offset(px(2.0)),
            "ring-2 ring-sky-500 ring-offset-2",
        );
        same(
            s().ring(px(1.0)).ring_color(rgba(0x0000_000d)).ring_inset(),
            "ring-1 ring-black/5 ring-inset",
        );
        same(s().text_shadow_md(), "text-shadow-md");
        // A theme color of the shadow switches with the appearance.
        let adaptive = s()
            .shadow_md()
            .shadow_color(AdaptiveColor::new(SKY.shade(500), PINK.shade(500)))
            .lower();
        assert_eq!(adaptive.deps(), tailwind::deps::DARK);
        for (dark, hue) in [(false, SKY), (true, PINK)] {
            let classes = format!("shadow-md shadow-{}-500", hue.name());
            assert_eq!(
                resolve(&adaptive, dark, 0, 0),
                resolve_with(&tailwind::parse(&PRESETS, &classes), dark, 0, 0, &|s| {
                    s.view.shadow.color = hue.shade(500).into()
                })
            );
        }
    }

    #[test]
    fn custom_shadows_set_react_natives_and_box_shadows() {
        let list = s()
            .shadow_color(rgb(0x0969da))
            .shadow_opacity(0.35)
            .shadow_radius(px(10.0))
            .shadow_offset(point(px(4.0), px(8.0)))
            .text_shadow_color(rgba(0x0000_0099))
            .text_shadow_radius(px(4.0))
            .text_shadow_offset(point(px(2.0), px(2.0)))
            .lower();
        let mut style = Style::default();
        list.apply(
            &Context {
                env: ClassEnvironment::default(),
                window: crate::geometry::size_pt(390.0, 844.0),
                rtl: false,
                states: 0,
                position: 0,
                group: &|_| 0,
            },
            &PRESETS,
            &mut style,
            &mut ClassProps::default(),
            |_| {},
        );
        assert_eq!(style.view.shadow.color, rgb(0x0969da).into());
        assert_eq!(style.view.shadow.opacity, 0.35);
        assert_eq!(style.view.shadow.radius, px(10.0));
        assert_eq!(
            (style.view.shadow.offset_x, style.view.shadow.offset_y),
            (px(4.0), px(8.0))
        );
        assert_eq!(style.text.shadow_color, Some(rgba(0x0000_0099).into()));
        assert_eq!(style.text.shadow_radius, Some(px(4.0)));
        assert_eq!(style.text.shadow_offset, Some(point(px(2.0), px(2.0))));
        let layer = BoxShadow {
            offset_x: px(0.0),
            offset_y: px(2.0),
            blur: px(4.0),
            spread: px(0.0),
            color: rgba(0x0000_000d).into(),
            inset: true,
        };
        same(
            s().shadow([layer]),
            "shadow-[inset_0_2px_4px_rgb(0_0_0/0.05)]",
        );
    }

    #[test]
    fn effects_are_tailwinds() {
        same(
            s().bg_linear_to_br()
                .gradient_from(VIOLET.shade(500))
                .gradient_via(PINK.shade(500))
                .gradient_to(RED.shade(400)),
            "bg-linear-to-br from-violet-500 via-pink-500 to-red-400",
        );
        same(
            s().bg_linear(deg(45.0))
                .gradient_from(SKY.shade(400))
                .gradient_to(VIOLET.shade(600))
                .gradient_to_position(percentage(0.8)),
            "bg-linear-45 from-sky-400 to-violet-600 to-80%",
        );
        same(
            s().bg_radial().gradient_from(SKY.shade(200)),
            "bg-radial from-sky-200",
        );
        same(
            s().bg_conic(deg(0.0)).gradient_from(RED.shade(500)),
            "bg-conic from-red-500",
        );
        same(s().grayscale(1.0).sepia(1.0), "grayscale sepia");
        same(s().blur(px(8.0)).brightness(0.5), "blur-sm brightness-50");
        same(
            s().saturate(1.5).hue_rotate(deg(90.0)),
            "saturate-150 hue-rotate-90",
        );
        same(
            s().backdrop_blur(px(12.0))
                .backdrop_saturate(1.5)
                .backdrop_sepia(1.0),
            "backdrop-blur-md backdrop-saturate-150 backdrop-sepia",
        );
        same(
            s().mix_blend_mode(BlendMode::Multiply),
            "mix-blend-multiply",
        );
        same(s().transition(), "transition");
        same(
            s().transition_colors()
                .duration(150.0)
                .ease_in_out()
                .delay(75.0),
            "transition-colors duration-150 ease-in-out delay-75",
        );
        same(
            s().transition_transform().duration(200.0),
            "transition-transform duration-200",
        );
        for (typed, classes) in [
            (s().animate_spin(), "animate-spin"),
            (s().animate_ping(), "animate-ping"),
            (s().animate_pulse(), "animate-pulse"),
            (s().animate_bounce(), "animate-bounce"),
        ] {
            same(typed, classes);
        }
    }

    #[test]
    fn keyframe_animations_take_their_own_timing() {
        // As TS's `animationName` and its timing keys over no animation.
        let timed = |name: &'static str, ms: f32, easing: &'static str| {
            move |style: &mut Style| {
                use crate::StyleValue;
                style
                    .set_key(StyleKey::AnimationName, StyleValue::Str(name))
                    .unwrap();
                style
                    .set_key(StyleKey::AnimationDuration, StyleValue::Number(ms))
                    .unwrap();
                style
                    .set_key(StyleKey::AnimationTimingFunction, StyleValue::Str(easing))
                    .unwrap();
            }
        };
        same_with(
            s().animation(KeyframeAnimation::new(Keyframes::Spin).duration(800.0)),
            "animate-none",
            &timed("spin", 800.0, "linear"),
        );
        same_with(
            s().animation(
                KeyframeAnimation::new(Keyframes::Pulse)
                    .duration(900.0)
                    .easing([0.42, 0.0, 0.58, 1.0]),
            ),
            "animate-none",
            &timed("pulse", 900.0, "ease-in-out"),
        );
        // The later declaration wins, either way round.
        same(
            s().animation(KeyframeAnimation::new(Keyframes::Spin).duration(800.0))
                .animate_ping(),
            "animate-ping",
        );
        same_with(
            s().animate_ping()
                .animation(KeyframeAnimation::new(Keyframes::Spin).duration(800.0)),
            "animate-none",
            &timed("spin", 800.0, "linear"),
        );
    }

    #[test]
    fn transforms_are_tailwinds() {
        same(
            s().rotate(deg(12.0)).skew_x(deg(6.0)).scale(0.9),
            "rotate-12 skew-x-6 scale-90",
        );
        same(
            s().perspective(px(400.0))
                .rotate_y(deg(35.0))
                .rotate_x(deg(40.0)),
            "perspective-[400px] rotate-y-35 rotate-x-40",
        );
        same(s().scale_x(1.5).skew_y(deg(-3.0)), "scale-x-150 -skew-y-3");
        same(
            s().rotate(deg(12.0))
                .rotate_x(deg(40.0))
                .skew_x(deg(6.0))
                .scale(0.9)
                .transform_none(),
            "rotate-12 rotate-x-40 skew-x-6 scale-90 transform-none",
        );
        same(
            s().translate_x(px(8.0))
                .rotate(deg(12.0))
                .scale(0.9)
                .translate_none()
                .rotate_none()
                .scale_none(),
            "translate-x-2 rotate-12 scale-90 translate-none rotate-none scale-none",
        );
        same(
            s().origin_top_left().backface_hidden(),
            "origin-top-left backface-hidden",
        );
        same(
            s().transform_origin(TransformOrigin {
                x: px(10.0).into(),
                y: relative(0.25),
                z: Points::ZERO,
            }),
            "origin-[10px_25%]",
        );
    }

    #[test]
    fn text_is_tailwinds() {
        same(
            s().underline()
                .text_decoration_wavy()
                .text_decoration_color(RED.shade(500))
                .text_decoration_thickness(px(2.0))
                .underline_offset(px(4.0)),
            "underline decoration-wavy decoration-red-500 decoration-2 underline-offset-4",
        );
        same(s().uppercase().tabular_nums(), "uppercase tabular-nums");
        same(s().small_caps().oldstyle_nums(), "small-caps oldstyle-nums");
        same(s().capitalize().text_justify(), "capitalize text-justify");
        same(s().align_baseline(), "align-baseline");
        same(s().align_text_top(), "align-text-top");
        same(s().align_text_bottom(), "align-text-bottom");
        same(s().align_middle(), "align-middle");
        // Unlike classes, the two lines add up.
        let both = s().underline().line_through().lower();
        let mut style = Style::default();
        let _ = style.set_key(
            StyleKey::TextDecorationLine,
            crate::StyleValue::Str("underline line-through"),
        );
        assert_eq!(
            resolve(&both, false, 0, 0),
            format!("{style:?} {:?}", ClassProps::default())
        );
        same(
            s().underline().line_through().no_underline(),
            "no-underline",
        );
        let rtl = s().writing_direction(WritingDirection::Rtl).lower();
        let mut style = Style::default();
        let _ = style.set_key(StyleKey::WritingDirection, crate::StyleValue::Str("rtl"));
        assert_eq!(
            resolve(&rtl, false, 0, 0),
            format!("{style:?} {:?}", ClassProps::default())
        );
    }

    #[test]
    fn layout_is_tailwinds() {
        same(s().grid().grid_cols(3).gap_2(), "grid grid-cols-3 gap-2");
        same(s().col_span(2).row_span(2), "col-span-2 row-span-2");
        same(s().col_start(2).col_end(-1), "col-start-2 col-end-[-1]");
        same(s().flex_grow(2.0).flex_shrink(0.0), "grow-2 shrink-0");
        same(
            s().grid_rows(2).grid_flow_col(),
            "grid-rows-2 grid-flow-col",
        );
    }

    #[test]
    fn variants_are_tailwinds() {
        same(
            s().group_active(|s| s.text_color(VIOLET.shade(600)).translate_x(px(4.0))),
            "group-active:text-violet-600 group-active:translate-x-1",
        );
        same(s().group(), "group");
        same(
            s().group_named("item")
                .group_hover_named("item", |s| s.opacity(0.5)),
            "group/item group-hover/item:opacity-50",
        );
        same(s().dark(|s| s.shadow_none()), "dark:shadow-none");
        let mut disabled = s();
        disabled.extend_as(Variant::DISABLED, s().opacity(0.4));
        same(disabled, "disabled:opacity-40");
        // Nested variants: both hold.
        let mut nested = s();
        nested.extend_as(Variant::ACTIVE, s().dark(|s| s.opacity(0.5)));
        same(nested, "dark:active:opacity-50");
    }
}
