//! Tailwind utilities (without variants) to style declarations, and the
//! properties several utilities build together (transforms, box shadows
//! and rings, gradients, filters, transitions).

use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::{ClassProps, Theme, deps};
use crate::{
    css,
    effects::{
        BoxShadow, ColorStop, Filter, Gradient, GradientKind, GradientSize, KeyframeAnimation,
        Keyframes, Transition, TransitionProps,
    },
    geometry::{DefiniteLength, Length, Points, REM_SIZE, Size, deg, percentage, point, px},
    props::PointerEvents,
    style::{
        Color, EllipsizeMode, FontVariant, LineHeight, PropertyValue, Style, StyleDecl, StyleKey,
        StyleValue, TextShadow, TransformProperty,
    },
    transform::TransformKind,
};

/// A length that may be a fraction of the view's own size (translations).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Len {
    Points(f32),
    Fraction(f32),
}

/// One contribution to a property several utilities build together.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Part {
    TranslateX(Len),
    TranslateY(Len),
    /// The `rotate` property (`rotate-*`).
    Rotate(f32),
    /// `rotateX()` in the `transform` property (`rotate-x-*`).
    RotateX(f32),
    RotateY(f32),
    RotateZ(f32),
    ScaleX(f32),
    ScaleY(f32),
    SkewX(f32),
    SkewY(f32),
    /// The children's depth (`perspective-*`); `None`: `perspective-none`.
    Perspective(Option<f32>),
    /// `transform: none`: the 3D rotations and the skews.
    TransformNone,
    /// `translate: none`.
    TranslateNone,
    /// `scale: none`.
    ScaleNone,
    /// `rotate: none`.
    RotateNone,
    Shadow(Arc<[BoxShadow]>),
    /// A color for the shadow layers (`shadow-red-500`), mixed with the
    /// shadow's alpha.
    ShadowColor(Color),
    /// The alpha a size's modifier gives the shadow colors (`shadow-xl/20`,
    /// Tailwind's `--tw-shadow-alpha`).
    ShadowAlpha(f32),
    InsetShadow(Arc<[BoxShadow]>),
    InsetShadowColor(Color),
    InsetShadowAlpha(f32),
    Ring(f32),
    RingInset,
    RingColor(Color),
    RingOffset(f32),
    RingOffsetColor(Color),
    InsetRing(f32),
    InsetRingColor(Color),
    /// A gradient of a utility that mixes `in oklab` (`bg-linear-to-r`,
    /// `bg-radial`).
    Gradient(GradientKind),
    /// A gradient at an arbitrary position (`bg-linear-[25deg]`), where
    /// Tailwind writes no interpolation: CSS's default, Oklab unless every
    /// stop is a legacy sRGB color.
    ArbitraryGradient(GradientKind),
    GradientNone,
    /// A stop's color, and whether it is a legacy sRGB color (hex,
    /// `rgb()`, `hsl()`, a name; the palette's are OKLCH).
    From(Color, bool),
    Via(Color, bool),
    To(Color, bool),
    FromPos(f32),
    ViaPos(f32),
    ToPos(f32),
    /// A filter in its CSS slot; `None` clears the slot.
    Filter {
        backdrop: bool,
        slot: u8,
        filter: Option<Filter>,
    },
    FilterNone {
        backdrop: bool,
    },
    /// `drop-shadow-*`: a `drop-shadow()` per layer, last in the filter
    /// chain (Tailwind's `--tw-drop-shadow`).
    DropShadows(Arc<[Filter]>),
    /// A color for the drop shadows (`drop-shadow-red-500`).
    DropShadowColor(Color),
    DropShadowAlpha(f32),
    FontVariant {
        set: u8,
        clear: u8,
    },
    TransitionProps(u8),
    Duration(f32),
    Ease([f32; 4]),
    Delay(f32),
    TransitionNone,
    Animate(Option<Keyframes>),
    /// A keyframe animation with its own timing.
    Animation(KeyframeAnimation),
    TextShadow(Arc<[TextShadow]>),
    TextShadowColor(Color),
    TextShadowAlpha(f32),
}

/// A color of a part, which currentColor can give (`ring-current`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ColorSlot {
    Shadow,
    InsetShadow,
    TextShadow,
    DropShadow,
    Ring,
    InsetRing,
    RingOffset,
    From,
    Via,
    To,
    Caret,
}

/// A node property set by a class.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PropDecl {
    NoWrap(bool),
    Caret(Color),
    /// `space-x-*` (`false`) / `space-y-*` (`true`).
    Space(bool, PropertyValue),
    /// `space-x-reverse` / `space-y-reverse`.
    SpaceReverse(bool),
}

/// What one utility declares.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Decl {
    Set(StyleKey, PropertyValue),
    /// A value the utility implies for another property, applied before
    /// every other rule so any utility of that property wins wherever it is
    /// in the string (`flex` is a row as in CSS, `flex-col flex` a column).
    Default(StyleKey, PropertyValue),
    Style(StyleDecl),
    Part(Part),
    Prop(PropDecl),
    /// A length relative to the window (`w-screen`): `(key, fraction of
    /// width, fraction of height)`.
    Screen(StyleKey, f32, f32),
    /// One value in light appearance, another in dark (a theme color of a
    /// Rust component): one declaration, so a later plain one still wins.
    Adaptive(StyleKey, [PropertyValue; 2]),
    /// [`Decl::Adaptive`] for a part (a shadow's, ring's or gradient
    /// stop's theme color).
    AdaptivePart(Box<[Part; 2]>),
    /// CSS's `currentColor` for a color property, implied as
    /// [`Decl::Default`] is (a border width's color): the node's text
    /// color, its own or the one it inherits.
    CurrentColor(StyleKey),
    /// An explicit currentColor declaration, in normal cascade order, at
    /// an alpha (`bg-current/50`).
    SetCurrentColor(StyleKey, f32),
    /// A part's color in currentColor (`ring-current`, `shadow-current`),
    /// at an alpha.
    CurrentPart(ColorSlot, f32),
    /// A length in CSS's `ch` (the advance of the font's `0`):
    /// `max-w-prose`, `65ch`.
    Ch(StyleKey, f32),
}

impl Decl {
    pub(crate) fn apply(
        &self,
        dark: bool,
        important: bool,
        style: &mut Style,
        props: &mut ClassProps,
        parts: &mut Parts,
    ) {
        match self {
            Decl::Set(key, value) => {
                let _ = style.apply_value(*key, value);
            }
            // Applied by `ClassList::apply` before the rules.
            Decl::Default(..) | Decl::CurrentColor(_) => {}
            Decl::SetCurrentColor(key, alpha) => {
                style.set_color(*key, mixed(parts.current, *alpha));
            }
            Decl::CurrentPart(slot, alpha) => {
                let c = mixed(parts.current, *alpha);
                match slot {
                    ColorSlot::Caret => props.caret_color = Some(c),
                    slot => parts.push(match slot {
                        ColorSlot::Shadow => Part::ShadowColor(c),
                        ColorSlot::InsetShadow => Part::InsetShadowColor(c),
                        ColorSlot::TextShadow => Part::TextShadowColor(c),
                        ColorSlot::DropShadow => Part::DropShadowColor(c),
                        ColorSlot::Ring => Part::RingColor(c),
                        ColorSlot::InsetRing => Part::InsetRingColor(c),
                        ColorSlot::RingOffset => Part::RingOffsetColor(c),
                        ColorSlot::From => Part::From(c, true),
                        ColorSlot::Via => Part::Via(c, true),
                        _ => Part::To(c, true),
                    }),
                }
            }
            Decl::Style(decl) => {
                let _ = decl.apply(style);
            }
            Decl::Part(part) => parts.push(part.clone()),
            Decl::Prop(p) => match p {
                PropDecl::NoWrap(b) => props.no_wrap = Some(*b),
                PropDecl::Caret(c) => props.caret_color = Some(*c),
                PropDecl::Space(y, v) => {
                    let space = props.space.get_or_insert_default();
                    if *y {
                        space.y = Some(v.clone());
                        space.important_y = important;
                    } else {
                        space.x = Some(v.clone());
                        space.important_x = important;
                    }
                }
                PropDecl::SpaceReverse(y) => {
                    let space = props.space.get_or_insert_default();
                    if *y {
                        space.reverse_y = true;
                    } else {
                        space.reverse_x = true;
                    }
                }
            },
            Decl::Screen(key, fw, fh) => {
                parts.screen.push((*key, *fw, *fh));
                parts.touched |= touched::SCREEN;
            }
            Decl::Ch(key, n) => {
                let _ = style.set_key(*key, StyleValue::Number(n * parts.ch));
            }
            Decl::Adaptive(key, values) => {
                let _ = style.apply_value(*key, &values[usize::from(dark)]);
            }
            Decl::AdaptivePart(pair) => parts.push(pair[usize::from(dark)].clone()),
        }
    }

    /// Sets the background color.
    pub(crate) fn sets_background_color(&self) -> bool {
        matches!(
            self,
            Decl::Set(StyleKey::BackgroundColor, _)
                | Decl::SetCurrentColor(StyleKey::BackgroundColor, _)
                | Decl::Adaptive(StyleKey::BackgroundColor, _)
                | Decl::Style(StyleDecl::Set(StyleKey::BackgroundColor, _))
        )
    }

    /// Sets (or removes) a gradient background, or a part of one.
    pub(crate) fn sets_background_image(&self) -> bool {
        let gradient = |p: &Part| {
            matches!(
                p,
                Part::Gradient(_)
                    | Part::ArbitraryGradient(_)
                    | Part::GradientNone
                    | Part::From(..)
                    | Part::Via(..)
                    | Part::To(..)
                    | Part::FromPos(_)
                    | Part::ViaPos(_)
                    | Part::ToPos(_)
            )
        };
        match self {
            Decl::Style(StyleDecl::Set(StyleKey::BackgroundImage, _)) => true,
            Decl::Part(p) => gradient(p),
            Decl::AdaptivePart(p) => gradient(&p[0]),
            _ => false,
        }
    }

    pub(crate) fn text_color(&self) -> Option<Color> {
        match self {
            Decl::Set(StyleKey::Color, PropertyValue::Color(c)) => *c,
            // `placeholder:` rules are Tailwind's: never adaptive.
            _ => None,
        }
    }

    /// The text color this sets, if it sets one (`Some(None)`: the default).
    pub(crate) fn sets_text_color(&self, dark: bool) -> Option<Option<Color>> {
        let value = match self {
            Decl::Set(StyleKey::Color, v) | Decl::Style(StyleDecl::Set(StyleKey::Color, v)) => v,
            Decl::Adaptive(StyleKey::Color, values) => &values[usize::from(dark)],
            _ => return None,
        };
        Some(match value {
            PropertyValue::Color(c) => *c,
            _ => None,
        })
    }

    /// The background color this declares, for `selection:` rules.
    pub(crate) fn background_color(&self) -> Option<Color> {
        match self {
            Decl::Set(StyleKey::BackgroundColor, PropertyValue::Color(c)) => *c,
            _ => None,
        }
    }

    pub(crate) fn deps(&self) -> u16 {
        match self {
            Decl::Screen(_, w, h) => {
                (if *w != 0.0 { deps::WIDTH } else { 0 })
                    | (if *h != 0.0 { deps::HEIGHT } else { 0 })
            }
            Decl::Adaptive(..) | Decl::AdaptivePart(_) => deps::DARK,
            Decl::CurrentColor(_)
            | Decl::CurrentPart(..)
            | Decl::SetCurrentColor(..)
            | Decl::Part(Part::Ring(_) | Part::InsetRing(_)) => deps::CURRENT_COLOR,
            // A value that writes `currentColor` inside it (a gradient's
            // stop, a `color-mix()`): the style fills it in.
            Decl::Set(_, PropertyValue::Deferred(..) | PropertyValue::CurrentColor)
            | Decl::Style(StyleDecl::Set(
                _,
                PropertyValue::Deferred(..) | PropertyValue::CurrentColor,
            )) => deps::CURRENT_COLOR,
            Decl::Ch(..) => deps::CH,
            _ => 0,
        }
    }
}

/// Groups of properties [`Parts::finish`] writes.
pub(crate) mod touched {
    pub(crate) const SCREEN: u16 = 1;
    pub(crate) const TRANSFORM: u16 = 2;
    pub(crate) const SHADOWS: u16 = 4;
    pub(crate) const GRADIENT: u16 = 8;
    pub(crate) const FILTERS: u16 = 16;
    pub(crate) const BACKDROP: u16 = 32;
    pub(crate) const FONT_VARIANT: u16 = 64;
    pub(crate) const TRANSITION: u16 = 128;
    pub(crate) const ANIMATE: u16 = 256;
    pub(crate) const TEXT_SHADOW: u16 = 512;
    pub(crate) const ALL: u16 = u16::MAX;
}

/// The transform properties parts set ([`Parts::transform_parts`]).
mod transform_part {
    pub(super) const TRANSLATE: u8 = 1;
    pub(super) const ROTATE: u8 = 2;
    pub(super) const SCALE: u8 = 4;
    pub(super) const TRANSFORM: u8 = 8;
}

/// Accumulated [`Part`]s of the matching rules, later ones winning.
#[derive(Debug, Default)]
pub(crate) struct Parts {
    /// [`touched`] groups the parts pushed since this was last cleared.
    pub(crate) touched: u16,
    /// The [`transform_part`]s pushed since this was last cleared.
    pub(crate) transform_parts: u8,
    translate: [Option<Len>; 2],
    /// The `rotate` property.
    rotate: Option<f32>,
    /// The `transform` property's `rotateX()`, `rotateY()`, `rotateZ()`.
    rotate_3d: [Option<f32>; 3],
    scale: [Option<f32>; 2],
    skew: [Option<f32>; 2],
    /// `perspective-none` is `Some(None)`.
    perspective: Option<Option<f32>>,
    transform_set: bool,
    shadow: Option<Arc<[BoxShadow]>>,
    shadow_color: Option<Color>,
    shadow_alpha: Option<f32>,
    inset_shadow: Option<Arc<[BoxShadow]>>,
    inset_shadow_color: Option<Color>,
    inset_shadow_alpha: Option<f32>,
    ring: Option<f32>,
    ring_inset: bool,
    ring_color: Option<Color>,
    ring_offset: Option<f32>,
    ring_offset_color: Option<Color>,
    inset_ring: Option<f32>,
    inset_ring_color: Option<Color>,
    shadows_set: bool,
    /// The gradient, and whether it mixes `in oklab` whatever its colors.
    gradient: Option<Option<(GradientKind, bool)>>,
    stops: [Option<Color>; 3],
    /// The stops' colors are legacy sRGB ones.
    legacy_stops: [bool; 3],
    stop_positions: [Option<f32>; 3],
    filters: [Option<Filter>; 9],
    /// After the filters of `filters`.
    drop_shadows: Option<Arc<[Filter]>>,
    drop_shadow_color: Option<Color>,
    drop_shadow_alpha: Option<f32>,
    filters_set: bool,
    backdrop: [Option<Filter>; 9],
    backdrop_set: bool,
    font_variant: Option<u8>,
    transition_props: Option<u8>,
    duration: Option<f32>,
    ease: Option<[f32; 4]>,
    delay: Option<f32>,
    transition_none: bool,
    animate: Option<Option<KeyframeAnimation>>,
    text_shadow: Option<Arc<[TextShadow]>>,
    text_shadow_color: Option<Color>,
    text_shadow_alpha: Option<f32>,
    /// `w-screen` and friends, resolved against the window.
    pub(crate) screen: Vec<(StyleKey, f32, f32)>,
    /// CSS's `currentColor`: the ring's color when no class sets one.
    pub(crate) current: Color,
    /// The advance of the node font's `0`.
    pub(crate) ch: f32,
}

impl Parts {
    fn push(&mut self, part: Part) {
        use Part::*;
        self.touched |= match &part {
            TranslateX(_) | TranslateY(_) | Rotate(_) | RotateX(_) | RotateY(_) | RotateZ(_)
            | ScaleX(_) | ScaleY(_) | SkewX(_) | SkewY(_) | Perspective(_) | TransformNone
            | TranslateNone | ScaleNone | RotateNone => touched::TRANSFORM,
            Shadow(_) | ShadowColor(_) | ShadowAlpha(_) | InsetShadow(_) | InsetShadowColor(_)
            | InsetShadowAlpha(_) | Ring(_) | RingInset | RingColor(_) | RingOffset(_)
            | RingOffsetColor(_) | InsetRing(_) | InsetRingColor(_) => touched::SHADOWS,
            Gradient(_) | ArbitraryGradient(_) | GradientNone | From(..) | Via(..) | To(..)
            | FromPos(_) | ViaPos(_) | ToPos(_) => touched::GRADIENT,
            Filter {
                backdrop: false, ..
            }
            | FilterNone { backdrop: false }
            | DropShadows(_)
            | DropShadowColor(_)
            | DropShadowAlpha(_) => touched::FILTERS,
            Filter { backdrop: true, .. } | FilterNone { backdrop: true } => touched::BACKDROP,
            FontVariant { .. } => touched::FONT_VARIANT,
            TransitionProps(_) | Duration(_) | Ease(_) | Delay(_) | TransitionNone => {
                touched::TRANSITION
            }
            Animate(_) | Animation(_) => touched::ANIMATE,
            TextShadow(_) | TextShadowColor(_) | TextShadowAlpha(_) => touched::TEXT_SHADOW,
        };
        self.transform_parts |= match &part {
            TranslateX(_) | TranslateY(_) | TranslateNone => transform_part::TRANSLATE,
            Rotate(_) | RotateNone => transform_part::ROTATE,
            ScaleX(_) | ScaleY(_) | ScaleNone => transform_part::SCALE,
            RotateX(_) | RotateY(_) | RotateZ(_) | SkewX(_) | SkewY(_) | TransformNone => {
                transform_part::TRANSFORM
            }
            _ => 0,
        };
        match part {
            TranslateX(l) => (self.translate[0], self.transform_set) = (Some(l), true),
            TranslateY(l) => (self.translate[1], self.transform_set) = (Some(l), true),
            Rotate(d) => (self.rotate, self.transform_set) = (Some(d), true),
            RotateX(d) => (self.rotate_3d[0], self.transform_set) = (Some(d), true),
            RotateY(d) => (self.rotate_3d[1], self.transform_set) = (Some(d), true),
            RotateZ(d) => (self.rotate_3d[2], self.transform_set) = (Some(d), true),
            ScaleX(s) => (self.scale[0], self.transform_set) = (Some(s), true),
            ScaleY(s) => (self.scale[1], self.transform_set) = (Some(s), true),
            SkewX(d) => (self.skew[0], self.transform_set) = (Some(d), true),
            SkewY(d) => (self.skew[1], self.transform_set) = (Some(d), true),
            Perspective(p) => (self.perspective, self.transform_set) = (Some(p), true),
            // `translate`, `rotate` and `scale` are properties of their
            // own: `transform: none` leaves them.
            TransformNone => {
                self.rotate_3d = [None; 3];
                self.skew = [None; 2];
                self.transform_set = true;
            }
            TranslateNone => (self.translate, self.transform_set) = ([None; 2], true),
            ScaleNone => (self.scale, self.transform_set) = ([None; 2], true),
            RotateNone => (self.rotate, self.transform_set) = (None, true),
            Shadow(s) => (self.shadow, self.shadows_set) = (Some(s), true),
            ShadowColor(c) => (self.shadow_color, self.shadows_set) = (Some(c), true),
            ShadowAlpha(a) => (self.shadow_alpha, self.shadows_set) = (Some(a), true),
            InsetShadow(s) => (self.inset_shadow, self.shadows_set) = (Some(s), true),
            InsetShadowColor(c) => (self.inset_shadow_color, self.shadows_set) = (Some(c), true),
            InsetShadowAlpha(a) => (self.inset_shadow_alpha, self.shadows_set) = (Some(a), true),
            Ring(w) => (self.ring, self.shadows_set) = (Some(w), true),
            RingInset => (self.ring_inset, self.shadows_set) = (true, true),
            RingColor(c) => (self.ring_color, self.shadows_set) = (Some(c), true),
            RingOffset(w) => (self.ring_offset, self.shadows_set) = (Some(w), true),
            RingOffsetColor(c) => (self.ring_offset_color, self.shadows_set) = (Some(c), true),
            InsetRing(w) => (self.inset_ring, self.shadows_set) = (Some(w), true),
            InsetRingColor(c) => (self.inset_ring_color, self.shadows_set) = (Some(c), true),
            Gradient(k) => self.gradient = Some(Some((k, true))),
            ArbitraryGradient(k) => self.gradient = Some(Some((k, false))),
            GradientNone => self.gradient = Some(None),
            From(c, legacy) => (self.stops[0], self.legacy_stops[0]) = (Some(c), legacy),
            Via(c, legacy) => (self.stops[1], self.legacy_stops[1]) = (Some(c), legacy),
            To(c, legacy) => (self.stops[2], self.legacy_stops[2]) = (Some(c), legacy),
            FromPos(p) => self.stop_positions[0] = Some(p),
            ViaPos(p) => self.stop_positions[1] = Some(p),
            ToPos(p) => self.stop_positions[2] = Some(p),
            Filter {
                backdrop: false,
                slot,
                filter,
            } => {
                self.filters[slot as usize] = filter;
                self.filters_set = true;
            }
            Filter {
                backdrop: true,
                slot,
                filter,
            } => {
                self.backdrop[slot as usize] = filter;
                self.backdrop_set = true;
            }
            FilterNone { backdrop: false } => {
                self.filters = [None; 9];
                self.drop_shadows = None;
                self.filters_set = true;
            }
            DropShadows(layers) => {
                self.drop_shadows = Some(layers);
                self.filters_set = true;
            }
            DropShadowColor(c) => (self.drop_shadow_color, self.filters_set) = (Some(c), true),
            DropShadowAlpha(a) => (self.drop_shadow_alpha, self.filters_set) = (Some(a), true),
            FilterNone { backdrop: true } => {
                self.backdrop = [None; 9];
                self.backdrop_set = true;
            }
            FontVariant { set, clear } => {
                let bits = self.font_variant.unwrap_or(0);
                self.font_variant = Some(bits & !clear | set);
            }
            TransitionProps(p) => {
                self.transition_props = Some(p);
                self.transition_none = false;
            }
            Duration(ms) => self.duration = Some(ms),
            Ease(e) => self.ease = Some(e),
            Delay(ms) => self.delay = Some(ms),
            TransitionNone => {
                self.transition_none = true;
                self.transition_props = None;
            }
            Animate(k) => self.animate = Some(k.map(preset)),
            Animation(a) => self.animate = Some(Some(a)),
            TextShadow(layers) => self.text_shadow = Some(layers),
            TextShadowColor(c) => self.text_shadow_color = Some(c),
            TextShadowAlpha(a) => self.text_shadow_alpha = Some(a),
        }
    }

    /// Writes the built properties of the [`touched`] groups in `only`
    /// into `style`; `window` resolves window-relative lengths.
    pub(crate) fn finish(
        &self,
        style: &mut Style,
        props: &mut ClassProps,
        theme: &Theme,
        window: Size<Points>,
        only: u16,
    ) {
        let has = |group: u16| only & group != 0;
        for &(key, fw, fh) in self.screen.iter().filter(|_| has(touched::SCREEN)) {
            let _ = style.set_key(
                key,
                crate::style::StyleValue::Number(fw * window.width.0 + fh * window.height.0),
            );
        }
        if self.transform_set && has(touched::TRANSFORM) {
            // CSS: `translate`, `rotate`, `scale`, then `transform`
            // (`rotateX() rotateY() rotateZ() skewX() skewY()`, as Tailwind
            // writes it); a list applies right to left. Each is a property of
            // its own: only those the rules set are written, so an inline
            // style's others stay (and an important rule's pass writes only
            // its own).
            // `perspective-*` is CSS's `perspective` property: depth for the
            // children, not a step of the view's own transform.
            style.perspective = self.perspective.flatten().map(px);
            let step = |kind, v| (kind, v, None);
            if self.transform_parts & transform_part::TRANSLATE != 0 {
                let mut steps = Vec::new();
                for (i, t) in self.translate.iter().enumerate() {
                    steps.extend(match (i, t) {
                        (0, Some(Len::Points(v))) => Some(step(TransformKind::TranslateX, *v)),
                        (0, Some(Len::Fraction(f))) => {
                            Some(step(TransformKind::TranslateXFraction, *f))
                        }
                        (1, Some(Len::Points(v))) => Some(step(TransformKind::TranslateY, *v)),
                        (1, Some(Len::Fraction(f))) => {
                            Some(step(TransformKind::TranslateYFraction, *f))
                        }
                        _ => None,
                    });
                }
                let _ = style.set_transform(TransformProperty::Translate, &steps);
            }
            if self.transform_parts & transform_part::ROTATE != 0 {
                let steps: Vec<_> = self
                    .rotate
                    .map(|r| step(TransformKind::Rotate, r))
                    .into_iter()
                    .collect();
                let _ = style.set_transform(TransformProperty::Rotate, &steps);
            }
            if self.transform_parts & transform_part::SCALE != 0 {
                let steps: Vec<_> = match self.scale {
                    [Some(x), Some(y)] if x == y => vec![step(TransformKind::Scale, x)],
                    [x, y] => x
                        .map(|x| step(TransformKind::ScaleX, x))
                        .into_iter()
                        .chain(y.map(|y| step(TransformKind::ScaleY, y)))
                        .collect(),
                };
                let _ = style.set_transform(TransformProperty::Scale, &steps);
            }
            if self.transform_parts & transform_part::TRANSFORM != 0 {
                let [x, y, z] = self.rotate_3d;
                let steps: Vec<_> = [
                    (TransformKind::RotateX, x),
                    (TransformKind::RotateY, y),
                    (TransformKind::Rotate, z),
                    (TransformKind::SkewX, self.skew[0]),
                    (TransformKind::SkewY, self.skew[1]),
                ]
                .into_iter()
                .filter_map(|(kind, v)| Some(step(kind, v?)))
                .collect();
                let _ = style.set_transform(TransformProperty::Transform, &steps);
            }
        }
        if self.shadows_set && has(touched::SHADOWS) {
            let current = self.current;
            // A color class replaces the layers' colors, alpha too
            // (Tailwind's `--tw-shadow-color` mixed at `--tw-shadow-alpha`).
            let recolor = |layers: &[BoxShadow],
                           color: Option<Color>,
                           alpha: Option<f32>|
             -> Vec<BoxShadow> {
                layers
                    .iter()
                    .map(|l| match color {
                        Some(c) => BoxShadow {
                            color: mixed(c, alpha.unwrap_or(1.0)),
                            ..*l
                        },
                        None => *l,
                    })
                    .collect()
            };
            // CSS order, top layer first: inset shadow, inset ring, ring
            // offset, ring, shadow.
            let mut list = Vec::new();
            if let Some(s) = &self.inset_shadow {
                list.extend(recolor(s, self.inset_shadow_color, self.inset_shadow_alpha));
            }
            if let Some(w) = self.inset_ring {
                list.push(BoxShadow {
                    spread: px(w),
                    color: self.inset_ring_color.unwrap_or(current),
                    inset: true,
                    ..BoxShadow::default()
                });
            }
            let offset = self.ring_offset.unwrap_or(0.0);
            if let Some(w) = self.ring {
                if offset > 0.0 {
                    list.push(BoxShadow {
                        spread: px(offset),
                        color: self.ring_offset_color.unwrap_or(Color(0xffff_ffff)),
                        inset: self.ring_inset,
                        ..BoxShadow::default()
                    });
                }
                list.push(BoxShadow {
                    spread: px(w + offset),
                    color: self.ring_color.unwrap_or(current),
                    inset: self.ring_inset,
                    ..BoxShadow::default()
                });
            }
            if let Some(s) = &self.shadow {
                list.extend(recolor(s, self.shadow_color, self.shadow_alpha));
            }
            style.set_box_shadows(list);
        }
        if let Some(gradient) = self.gradient.filter(|_| has(touched::GRADIENT)) {
            match gradient {
                None => style.set_background_images(Vec::new()),
                Some((kind, oklab)) => {
                    let [from, via, to] = self.stops;
                    let [fp, vp, tp] = self.stop_positions;
                    let mut stops = vec![ColorStop {
                        color: from.unwrap_or(Color::TRANSPARENT),
                        position: Some(percentage(fp.unwrap_or(0.0)).into()),
                    }];
                    if let Some(via) = via {
                        stops.push(ColorStop {
                            color: via,
                            position: Some(percentage(vp.unwrap_or(0.5)).into()),
                        });
                    }
                    stops.push(ColorStop {
                        color: to.unwrap_or(Color::TRANSPARENT),
                        position: Some(percentage(tp.unwrap_or(1.0)).into()),
                    });
                    // Tailwind's gradients mix `in oklab`; at an arbitrary
                    // position, as CSS does without a method: in Oklab
                    // unless every color is a legacy one (the ends Tailwind
                    // leaves out are `#0000`).
                    let modern = (0..3).any(|i| self.stops[i].is_some() && !self.legacy_stops[i]);
                    let method = if oklab || modern {
                        css::Interpolation::OKLAB
                    } else {
                        css::Interpolation::SRGB
                    };
                    style.set_background_images(vec![Gradient {
                        kind,
                        stops: css::interpolate_stops(stops, method),
                        repeating: false,
                    }]);
                }
            }
        }
        if self.filters_set && has(touched::FILTERS) {
            let drop = self.drop_shadows.as_deref().unwrap_or_default();
            let color = self
                .drop_shadow_color
                .map(|c| mixed(c, self.drop_shadow_alpha.unwrap_or(1.0)));
            let drop = drop.iter().map(|f| match (f, color) {
                (Filter::DropShadow { .. }, Some(c)) => {
                    let mut f = *f;
                    if let Filter::DropShadow { color, .. } = &mut f {
                        *color = c;
                    }
                    f
                }
                _ => *f,
            });
            style.set_filters(
                self.filters.iter().flatten().copied().chain(drop).collect(),
                false,
            );
        }
        if self.backdrop_set && has(touched::BACKDROP) {
            style.set_filters(self.backdrop.iter().flatten().copied().collect(), true);
        }
        if let Some(bits) = self.font_variant.filter(|_| has(touched::FONT_VARIANT)) {
            style.text.font_variant = Some(FontVariant(bits));
        }
        if !has(touched::TRANSITION) {
        } else if self.transition_none {
            style.view.transition = None;
        } else if self.transition_props.is_some() || self.duration.is_some() || self.ease.is_some()
        {
            let (duration, ease) = theme.transition;
            style.view.transition = Some(Transition {
                // CSS's initial `transition-property` is `all`.
                properties: TransitionProps(self.transition_props.unwrap_or(TransitionProps::ALL)),
                duration: self.duration.unwrap_or(if self.transition_props.is_some() {
                    duration
                } else {
                    0.0
                }),
                delay: self.delay.unwrap_or(0.0),
                easing: self.ease.unwrap_or(ease),
            });
        }
        if let Some(k) = self.animate.filter(|_| has(touched::ANIMATE)) {
            style.view.animation = k;
        }
        if let Some(layers) = self
            .text_shadow
            .as_ref()
            .filter(|_| has(touched::TEXT_SHADOW))
        {
            // One text shadow natively: the widest layer stands for all.
            let mut shadow = layers
                .iter()
                .copied()
                .max_by(|a, b| a.radius.0.total_cmp(&b.radius.0));
            let color = self
                .text_shadow_color
                .map(|c| mixed(c, self.text_shadow_alpha.unwrap_or(1.0)));
            if let (Some(s), Some(c)) = (shadow.as_mut(), color) {
                s.color = c;
            }
            match shadow {
                Some(s) => {
                    style.text.shadow_color = Some(s.color);
                    style.text.shadow_offset = Some(point(s.offset_x, s.offset_y));
                    style.text.shadow_radius = Some(s.radius);
                }
                None => {
                    style.text.shadow_color = None;
                    style.text.shadow_offset = None;
                    style.text.shadow_radius = None;
                }
            }
            props.text_shadows = Some(match color {
                Some(color) => layers.iter().map(|l| TextShadow { color, ..*l }).collect(),
                None => layers.to_vec(),
            });
        }
    }
}

// --- Values -----------------------------------------------------------------

/// `[...]` contents with `_` as spaces (`\_` stays an underscore).
fn arbitrary(v: &str) -> Option<String> {
    let inner = v.strip_prefix('[')?.strip_suffix(']')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'_') => {
                out.push('_');
                chars.next();
            }
            '_' => out.push(' '),
            c => out.push(c),
        }
    }
    (!out.is_empty()).then_some(out)
}

/// An arbitrary value without a type hint (`[length:2px]` -> `2px`).
fn arbitrary_hinted<'a>(v: &'a str, hint: &str) -> Option<&'a str> {
    v.strip_prefix(hint).and_then(|v| v.strip_prefix(':'))
}

/// A bare number as Tailwind takes one: written as JavaScript prints it
/// (`2.5`, not `+2.5`, `.5`, `2.50` or `1e1`), not negative.
fn num(v: &str) -> Option<f32> {
    let n: f64 = v.parse().ok()?;
    (n >= 0.0 && !v.starts_with('-') && format!("{n}") == v).then_some(n as f32)
}

/// A bare whole number (`2`, not `2.5`): border widths, filters,
/// durations and the other utilities Tailwind takes integers for.
fn int(v: &str) -> Option<f32> {
    num(v).filter(|n| n.fract() == 0.0)
}

/// A number in brackets (`flex-[2]`, `duration-[0.3s]`): CSS's syntax.
fn arbitrary_num(v: &str) -> Option<f32> {
    css::number(v).filter(|n| *n >= 0.0)
}

/// A length in brackets only (`outline-offset-[3px]`): for utilities whose
/// bare values are integers of pixels.
fn arbitrary_points(theme: &Theme, v: &str) -> Option<f32> {
    v.starts_with('[').then(|| points(theme, v))?
}

/// A spacing step count (`4`, `1.5`; quarter steps as in v4).
fn steps(v: &str) -> Option<f32> {
    let n = num(v)?;
    ((n * 4.0).fract() == 0.0).then_some(n)
}

/// `a/b` as a fraction.
fn fraction(v: &str) -> Option<f32> {
    let (a, b) = v.split_once('/')?;
    let (a, b) = (int(a)?, int(b)?);
    (b > 0.0).then(|| a / b)
}

fn class_length(theme: &Theme, value: &str) -> Option<f32> {
    let value = value.trim();
    if css::number(value).is_some_and(|n| n != 0.0) {
        return None;
    }
    if let Some(n) = value.strip_suffix("rem") {
        return css::number(n).map(|n| n * theme.rem);
    }
    css::length(value)
}

/// A length value of a spacing-like utility: steps, `px`, fractions,
/// `full`, `auto` (when allowed), or arbitrary lengths / percentages.
fn length_value(theme: &Theme, v: &str, neg: bool, auto: bool) -> Option<Length> {
    let sign = if neg { -1.0 } else { 1.0 };
    if let Some(n) = steps(v) {
        return Some(px(sign * n * theme.spacing).into());
    }
    Some(match v {
        "px" => px(sign).into(),
        "0" => px(0.0).into(),
        "full" => percentage(sign).into(),
        "auto" if auto && !neg => Length::Auto,
        v if v.contains('/') && !v.starts_with('[') => percentage(sign * fraction(v)?).into(),
        v => {
            let a = arbitrary(v)?;
            let a = arbitrary_hinted(&a, "length").unwrap_or(&a).to_string();
            let length = if let Some(percent) = a.strip_suffix('%') {
                crate::geometry::percentage(css::number(percent)? / 100.0).into()
            } else {
                px(class_length(theme, &a)?).into()
            };
            match length {
                DefiniteLength::Absolute(l) => px(sign * l.to_points(REM_SIZE).0).into(),
                DefiniteLength::Fraction(f) => percentage(sign * f.0).into(),
            }
        }
    })
}

/// [`length_value`] of a utility Tailwind CSS takes no fractions or
/// `full` for (padding, margin, gaps).
fn spacing_value(theme: &Theme, v: &str, neg: bool, auto: bool) -> Option<Length> {
    if v == "full" || v.contains('/') && !v.starts_with('[') {
        return None;
    }
    length_value(theme, v, neg, auto)
}

/// An arbitrary spacing value that uses `env()` (`pt-[env(safe-area-inset-top)]`,
/// `pb-[calc(env(keyboard-inset-height)+1rem)]`), the `+` spaced as CSS's
/// `calc()` requires (Tailwind's class names cannot hold a space); `Some(None)`
/// when it uses `env()` in a form NSH does not take.
fn env_value(v: &str) -> Option<Option<String>> {
    let a = arbitrary(v).filter(|a| a.contains("env("))?;
    let mut out = String::with_capacity(a.len() + 4);
    let mut chars = a.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '+' {
            out.truncate(out.trim_end().len());
            out.push_str(" + ");
            while chars.next_if(|c| c.is_whitespace()).is_some() {}
        } else {
            out.push(c);
        }
    }
    Some(match crate::style::env_length(&out) {
        Some(Ok(_)) => Some(out),
        _ => None,
    })
}

/// A padding or margin utility's declaration: its length, or a length with
/// an `env()` term (the physical keys only; Tailwind's negation is a
/// `calc(... * -1)`, which NSH does not take with `env()`).
fn spacing(key: StyleKey, theme: &Theme, v: &str, neg: bool, auto: bool) -> Option<Decl> {
    if let Some(env) = env_value(v) {
        return if neg { None } else { arb(key, &env?) };
    }
    Some(set(key, spacing_value(theme, v, neg, auto)?))
}

/// A length in points (no percentages).
fn points(theme: &Theme, v: &str) -> Option<f32> {
    match length_value(theme, v, false, false)? {
        Length::Definite(DefiniteLength::Absolute(a)) => Some(a.to_points(REM_SIZE).0),
        _ => None,
    }
}

/// A color with an optional opacity modifier (`red-500/50`), and whether
/// the modifier (or an arbitrary color) set its alpha.
fn color_value(theme: &Theme, v: &str) -> Option<(Color, bool)> {
    // `[rgb(0_0_0)]/50` or `red-500/50`: the modifier follows the base.
    let (base, modifier) = if v.starts_with('[') {
        let end = v.find(']')?;
        (&v[..=end], v[end + 1..].strip_prefix('/'))
    } else {
        match v.rsplit_once('/') {
            Some((b, m)) => (b, Some(m)),
            None => (v, None),
        }
    };
    let (color, own_alpha) = if base.starts_with('[') {
        let a = arbitrary(base)?;
        let a = arbitrary_hinted(&a, "color").unwrap_or(&a).to_string();
        let c = css::color(&a)?;
        (c, (c.0 & 0xff) != 0xff)
    } else {
        (theme.color(base)?, false)
    };
    match modifier {
        None => Some((color, own_alpha)),
        Some(m) => Some((mixed(color, alpha_modifier(m)?), true)),
    }
}

/// Whether the color value `v` is a legacy sRGB color in CSS (an arbitrary
/// hex, `rgb()`, `hsl()`, `hwb()` or named color), which a gradient without
/// an interpolation method mixes in sRGB; the palette's colors are OKLCH.
fn legacy_color(v: &str) -> bool {
    let base = match v.find(']') {
        Some(end) if v.starts_with('[') => &v[1..end],
        _ => return false,
    };
    css::is_legacy_color(arbitrary_hinted(base, "color").unwrap_or(base))
}

fn color(theme: &Theme, v: &str) -> Option<Color> {
    color_value(theme, v).map(|(c, _)| c)
}

/// `c` at `alpha` of its own alpha (CSS's `color-mix(in oklab, c alpha,
/// transparent)`).
fn mixed(c: Color, alpha: f32) -> Color {
    c.with_alpha(alpha)
}

/// `c` with alpha `alpha` (CSS's `oklab(from c l a b / alpha)`).
fn alpha_of(c: Color, alpha: f32) -> Color {
    Color(c.0 & 0xffff_ff00 | (alpha.clamp(0.0, 1.0) * 255.0).round() as u32)
}

/// An alpha modifier (`/50`, `/2.5`, `/[0.3]`, `/[30%]`).
fn alpha_modifier(m: &str) -> Option<f32> {
    match arbitrary(m) {
        Some(a) => css::amount(&a),
        None => num(m).map(|n| n / 100.0),
    }
}

/// `current`, `current/50`, `[currentColor]` or `[currentColor]/50`:
/// currentColor at an alpha.
fn current(v: &str) -> Option<f32> {
    let (base, modifier) = if v.starts_with('[') {
        let end = v.find(']')?;
        let rest = &v[end + 1..];
        let modifier = match rest.strip_prefix('/') {
            Some(m) => Some(m),
            None if rest.is_empty() => None,
            None => return None,
        };
        let a = arbitrary(&v[..=end])?;
        let a = arbitrary_hinted(&a, "color").unwrap_or(&a);
        (css::is_current_color(a).then_some("current")?, modifier)
    } else {
        match v.split_once('/') {
            None => (v, None),
            Some((b, m)) => (b, Some(m)),
        }
    };
    if base != "current" {
        return None;
    }
    match modifier {
        None => Some(1.0),
        Some(m) => alpha_modifier(m),
    }
}

/// An arbitrary color that writes `currentColor` inside it
/// (`[color-mix(in_srgb,currentColor_50%,transparent)]`): the value as
/// written, which the style fills in with the node's text color.
fn mixes_current(v: &str) -> Option<Box<str>> {
    let a = arbitrary(v)?;
    let a = arbitrary_hinted(&a, "color").unwrap_or(&a);
    if !css::mentions_current_color(a) {
        return None;
    }
    css::color(&css::with_current_color(a, Color::BLACK))?;
    Some(a.into())
}

/// `name/50` of a theme's shadow sizes: the layers, and the modifier's
/// alpha, which replaces the alpha of the layers' own colors.
fn sized<T: Copy>(
    sizes: &FxHashMap<Box<str>, Vec<T>>,
    v: &str,
    recolor: impl Fn(T, f32) -> T,
) -> Option<(Vec<T>, Option<f32>)> {
    let (base, alpha) = match v.split_once('/') {
        Some((b, m)) => (b, Some(alpha_modifier(m)?)),
        None => (v, None),
    };
    let layers = sizes.get(base)?;
    Some(match alpha {
        Some(a) => (layers.iter().map(|&l| recolor(l, a)).collect(), Some(a)),
        None => (layers.clone(), None),
    })
}

/// A `fill-*` / `stroke-*` paint: `none`, `current` (`currentColor`),
/// `inherit` or a color.
fn svg_paint(theme: &Theme, v: &str) -> Option<PropertyValue> {
    use crate::style::SvgPaint;
    Some(PropertyValue::Paint(match v {
        "none" => Some(SvgPaint::None),
        "current" => Some(SvgPaint::CurrentColor),
        "inherit" => None,
        v => Some(SvgPaint::Color(color(theme, v)?)),
    }))
}

/// A value the utility table writes: valid by construction.
fn checked(key: StyleKey, value: Result<PropertyValue, crate::StyleError>) -> Decl {
    Decl::Set(
        key,
        value.unwrap_or_else(|_| {
            debug_assert!(false, "a utility's value of `{}` is invalid", key.name());
            PropertyValue::Default
        }),
    )
}

/// A length (`w-4`, `p-[10px]`, `top-1/2`).
fn set(key: StyleKey, length: Length) -> Decl {
    checked(key, key.length_value(length))
}

/// A color.
fn setc(key: StyleKey, c: Color) -> Decl {
    Decl::Set(key, PropertyValue::Color(Some(c)))
}

/// A number, as a TSX style's (points for lengths).
fn setn(key: StyleKey, n: f32) -> Decl {
    checked(key, key.number_value(n))
}

/// A keyword of the utility table (`flex-start`), parsed once when the
/// class compiles.
fn sets(key: StyleKey, s: &str) -> Decl {
    checked(key, key.parse_value(StyleValue::Str(s)))
}

/// An arbitrary value (`[…]`), parsed once when the class compiles: a
/// value the property rejects makes the class unknown.
fn arb(key: StyleKey, s: &str) -> Option<Decl> {
    Some(Decl::Set(key, key.parse_value(StyleValue::Str(s)).ok()?))
}

/// `line-clamp-*` (0: none).
fn clamp(lines: u32) -> Decl {
    Decl::Set(K::NumberOfLines, PropertyValue::NumberOfLines(Some(lines)))
}

/// `text-ellipsis`, `text-clip`.
fn overflow(mode: EllipsizeMode) -> Decl {
    Decl::Set(K::TextOverflow, PropertyValue::TextOverflow(Some(mode)))
}

fn one(d: Decl) -> Option<Vec<Decl>> {
    Some(vec![d])
}

fn part(p: Part) -> Option<Vec<Decl>> {
    Some(vec![Decl::Part(p)])
}

/// An angle in degrees: a number (`45`) or arbitrary (`[0.5turn]`).
fn degrees(v: &str) -> Option<f32> {
    match arbitrary(v) {
        Some(a) => css::angle(&a),
        None => int(v),
    }
}

/// Milliseconds: `300` or `[0.3s]`.
fn millis(v: &str) -> Option<f32> {
    match arbitrary(v) {
        Some(a) => {
            let a = a.trim();
            if let Some(n) = a.strip_suffix("ms") {
                arbitrary_num(n)
            } else if let Some(n) = a.strip_suffix('s') {
                arbitrary_num(n).map(|s| s * 1000.0)
            } else {
                arbitrary_num(a)
            }
        }
        None => int(v),
    }
}

/// A factor from a percentage step (`scale-150` = 1.5) or arbitrary.
fn percent_factor(v: &str) -> Option<f32> {
    match arbitrary(v) {
        Some(a) => css::amount(&a),
        None => int(v).map(|n| n / 100.0),
    }
}

/// An opacity from a percentage (`opacity-50`, `opacity-2.5`) or
/// arbitrary.
fn opacity_factor(v: &str) -> Option<f32> {
    match arbitrary(v) {
        Some(a) => css::amount(&a),
        None => num(v).map(|n| n / 100.0),
    }
}

fn scale_factor(v: &str) -> Option<f32> {
    if v.starts_with('[') {
        percent_factor(v)
    } else {
        int(v).map(|n| n / 100.0)
    }
}

// --- Utilities --------------------------------------------------------------

/// Parses one utility.
pub(crate) fn parse(theme: &Theme, utility: &str) -> Option<Vec<Decl>> {
    if theme.rem != REM_SIZE.0 && utility.contains('[') && utility.contains("rem") {
        let normalized = rem_lengths(utility, theme.rem);
        if normalized != utility {
            return parse(theme, &normalized);
        }
    }
    if let Some(d) = keyword(utility) {
        return Some(d);
    }
    let (neg, u) = match utility.strip_prefix('-') {
        Some(u) => (true, u),
        None => (false, utility),
    };
    // The longest matching prefix decides (`inset-x-` before `inset-`).
    for &(prefix, handler) in PREFIXES {
        if neg && !NEGATIVE.contains(&prefix) {
            continue;
        }
        if let Some(value) = u.strip_prefix(prefix)
            && let Some(value) = value.strip_prefix('-')
            && !value.is_empty()
            && let Some(d) = handler(theme, value, neg)
        {
            return valid(d);
        }
    }
    // Bare forms that also take a value (`shadow`, `ring`, `border`, ...).
    bare(theme, u, neg)
}

/// `decls`, unless one is a negative value of a property CSS takes none
/// for (`p-[-4px]`, `w-[-10px]`): a browser drops that declaration.
fn valid(decls: Vec<Decl>) -> Option<Vec<Decl>> {
    let negative = |v: &PropertyValue| match v {
        PropertyValue::Number(n) => n.0 < 0.0,
        PropertyValue::Points(p) => p.0 < 0.0,
        PropertyValue::OptPoints(p) => p.is_some_and(|p| p.0 < 0.0),
        PropertyValue::Dimension(d) => d.into_raw().value() < 0.0,
        PropertyValue::Lpa(d) => d.into_raw().value() < 0.0,
        PropertyValue::Lp(d) => d.into_raw().value() < 0.0,
        PropertyValue::OptLp(d) => d.is_some_and(|d| d.into_raw().value() < 0.0),
        PropertyValue::LineHeight(
            LineHeight::Points(crate::geometry::Points(n))
            | LineHeight::Multiple(n)
            | LineHeight::Em(n),
        ) => *n < 0.0,
        _ => false,
    };
    let invalid = decls.iter().any(|d| match d {
        Decl::Set(key, v) => {
            matches!(
                key,
                K::Width
                    | K::Height
                    | K::MinWidth
                    | K::MinHeight
                    | K::MaxWidth
                    | K::MaxHeight
                    | K::FlexBasis
                    | K::Padding
                    | K::PaddingHorizontal
                    | K::PaddingVertical
                    | K::PaddingTop
                    | K::PaddingRight
                    | K::PaddingBottom
                    | K::PaddingLeft
                    | K::PaddingStart
                    | K::PaddingEnd
                    | K::Gap
                    | K::RowGap
                    | K::ColumnGap
                    | K::BorderWidth
                    | K::BorderTopWidth
                    | K::BorderRightWidth
                    | K::BorderBottomWidth
                    | K::BorderLeftWidth
                    | K::BorderStartWidth
                    | K::BorderEndWidth
                    | K::BorderRadius
                    | K::BorderTopLeftRadius
                    | K::BorderTopRightRadius
                    | K::BorderBottomRightRadius
                    | K::BorderBottomLeftRadius
                    | K::BorderTopStartRadius
                    | K::BorderTopEndRadius
                    | K::BorderBottomEndRadius
                    | K::BorderBottomStartRadius
                    | K::OutlineWidth
                    | K::FontSize
                    | K::LineHeight
            ) && negative(v)
        }
        _ => false,
    });
    (!invalid).then_some(decls)
}

/// Normalize arbitrary CSS lengths before shared CSS parsers consume them.
/// Quoted font names and strings retain their literal contents.
fn rem_lengths(value: &str, rem: f32) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut at = 0;
    let mut copied = 0;
    let mut quote = None;
    while at < bytes.len() {
        let ch = bytes[at];
        if ch == b'\\' {
            at = (at + 2).min(bytes.len());
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            at += 1;
            continue;
        }
        if ch == b'\'' || ch == b'"' {
            quote = Some(ch);
            at += 1;
            continue;
        }
        if ch.is_ascii_digit() || ch == b'.' {
            let start = at;
            while at < bytes.len()
                && (bytes[at].is_ascii_digit()
                    || matches!(bytes[at], b'.' | b'e' | b'E' | b'+' | b'-'))
            {
                at += 1;
            }
            if value[at..].starts_with("rem")
                && !bytes.get(at + 3).is_some_and(u8::is_ascii_alphabetic)
                && let Some(n) = css::number(&value[start..at])
            {
                out.push_str(&value[copied..start]);
                out.push_str(&format!("{}px", n * rem));
                at += 3;
                copied = at;
            }
        } else {
            at += 1;
        }
    }
    out.push_str(&value[copied..]);
    out
}

type Handler = fn(&Theme, &str, bool) -> Option<Vec<Decl>>;

/// The prefixes Tailwind CSS has a negative form of (`-mt-2`); a leading
/// `-` on any other is no class.
static NEGATIVE: &[&str] = &[
    "mx",
    "my",
    "mt",
    "mr",
    "mb",
    "ml",
    "ms",
    "me",
    "m",
    "space-x",
    "space-y",
    "inset-s",
    "inset-e",
    "inset-x",
    "inset-y",
    "inset",
    "top",
    "right",
    "bottom",
    "left",
    "start",
    "end",
    "z",
    "col-start",
    "col-end",
    "row-start",
    "row-end",
    "col",
    "row",
    "tracking",
    "underline-offset",
    "outline-offset",
    "bg-linear",
    "bg-conic",
    "hue-rotate",
    "backdrop-hue-rotate",
    "translate-x",
    "translate-y",
    "translate",
    "rotate-x",
    "rotate-y",
    "rotate-z",
    "rotate",
    "scale-x",
    "scale-y",
    "scale",
    "skew-x",
    "skew-y",
    "skew",
];

use StyleKey as K;

/// Utilities without a value.
fn keyword(u: &str) -> Option<Vec<Decl>> {
    let d = match u {
        // Display and position.
        // A CSS flex container is a row; views without the class keep
        // React Native's column.
        "flex" | "inline-flex" => {
            return Some(vec![
                sets(K::Display, "flex"),
                Decl::Default(
                    K::FlexDirection,
                    PropertyValue::FlexDirection(taffy::FlexDirection::Row),
                ),
            ]);
        }
        // Inside a flex or grid container, which every NSH parent but a
        // block is, a browser blockifies inline boxes: `inline` and
        // `inline-block` compute to `block` there. (Inside a block there is
        // no inline formatting context: they are blocks too.)
        "block" | "inline-block" | "inline" => sets(K::Display, "block"),
        "flow-root" => sets(K::Display, "flow-root"),
        "box-content" => sets(K::BoxSizing, "content-box"),
        "box-border" => sets(K::BoxSizing, "border-box"),
        "grid" | "inline-grid" => sets(K::Display, "grid"),
        "hidden" => sets(K::Display, "none"),
        "static" => sets(K::Position, "static"),
        "relative" => sets(K::Position, "relative"),
        "absolute" => sets(K::Position, "absolute"),
        "fixed" => sets(K::Position, "fixed"),
        "sticky" => sets(K::Position, "sticky"),
        "visible" => sets(K::Visibility, "visible"),
        "invisible" | "collapse" => sets(K::Visibility, "hidden"),
        "overflow-hidden" | "overflow-clip" | "overflow-x-hidden" | "overflow-y-hidden" => {
            sets(K::Overflow, "hidden")
        }
        "overflow-visible" => sets(K::Overflow, "visible"),
        // Flexbox.
        "flex-row" => sets(K::FlexDirection, "row"),
        "flex-row-reverse" => sets(K::FlexDirection, "row-reverse"),
        "flex-col" => sets(K::FlexDirection, "column"),
        "flex-col-reverse" => sets(K::FlexDirection, "column-reverse"),
        "flex-wrap" => sets(K::FlexWrap, "wrap"),
        "flex-wrap-reverse" => sets(K::FlexWrap, "wrap-reverse"),
        "flex-nowrap" => sets(K::FlexWrap, "nowrap"),
        "flex-1" => {
            return Some(vec![
                setn(K::FlexGrow, 1.0),
                setn(K::FlexShrink, 1.0),
                setn(K::FlexBasis, 0.0),
            ]);
        }
        "flex-auto" => {
            return Some(vec![
                setn(K::FlexGrow, 1.0),
                setn(K::FlexShrink, 1.0),
                sets(K::FlexBasis, "auto"),
            ]);
        }
        "flex-initial" => {
            return Some(vec![
                setn(K::FlexGrow, 0.0),
                setn(K::FlexShrink, 1.0),
                sets(K::FlexBasis, "auto"),
            ]);
        }
        "flex-none" => {
            return Some(vec![
                setn(K::FlexGrow, 0.0),
                setn(K::FlexShrink, 0.0),
                sets(K::FlexBasis, "auto"),
            ]);
        }
        "grow" => setn(K::FlexGrow, 1.0),
        "shrink" => setn(K::FlexShrink, 1.0),
        // Alignment: each class sets what Tailwind CSS's does (its generated
        // CSS is the reference), and the value means what it means in a
        // browser: `start` / `end` are the writing direction's, `flex-start`
        // / `flex-end` the flex direction's, `normal` CSS's `normal`.
        "justify-start" => sets(K::JustifyContent, "flex-start"),
        "justify-normal" => sets(K::JustifyContent, "normal"),
        "justify-end" => sets(K::JustifyContent, "flex-end"),
        "justify-center" => sets(K::JustifyContent, "center"),
        "justify-between" => sets(K::JustifyContent, "space-between"),
        "justify-around" => sets(K::JustifyContent, "space-around"),
        "justify-evenly" => sets(K::JustifyContent, "space-evenly"),
        "justify-stretch" => sets(K::JustifyContent, "stretch"),
        "justify-items-start" => sets(K::JustifyItems, "start"),
        "justify-items-end" => sets(K::JustifyItems, "end"),
        "justify-items-center" => sets(K::JustifyItems, "center"),
        "justify-items-stretch" => sets(K::JustifyItems, "stretch"),
        "justify-items-normal" => sets(K::JustifyItems, "normal"),
        "justify-self-auto" => sets(K::JustifySelf, "auto"),
        "justify-self-start" => sets(K::JustifySelf, "flex-start"),
        "justify-self-end" => sets(K::JustifySelf, "flex-end"),
        "justify-self-center" => sets(K::JustifySelf, "center"),
        "justify-self-stretch" => sets(K::JustifySelf, "stretch"),
        // CSS's `normal` behaves as `stretch` in flex and grid containers
        // alike; the style's `normal` is also what an unset `alignContent`
        // is, which stays React Native's `flex-start` outside grids
        // (`resolve_normal_alignment`), so the class sets `stretch`.
        "content-normal" => sets(K::AlignContent, "stretch"),
        "content-start" => sets(K::AlignContent, "flex-start"),
        "content-end" => sets(K::AlignContent, "flex-end"),
        "content-center" => sets(K::AlignContent, "center"),
        "content-between" => sets(K::AlignContent, "space-between"),
        "content-around" => sets(K::AlignContent, "space-around"),
        "content-evenly" => sets(K::AlignContent, "space-evenly"),
        "content-stretch" => sets(K::AlignContent, "stretch"),
        "items-start" => sets(K::AlignItems, "flex-start"),
        "items-end" => sets(K::AlignItems, "flex-end"),
        "items-center" => sets(K::AlignItems, "center"),
        "items-baseline" => sets(K::AlignItems, "baseline"),
        "items-stretch" => sets(K::AlignItems, "stretch"),
        "self-auto" => sets(K::AlignSelf, "auto"),
        "self-start" => sets(K::AlignSelf, "flex-start"),
        "self-end" => sets(K::AlignSelf, "flex-end"),
        "self-center" => sets(K::AlignSelf, "center"),
        "self-stretch" => sets(K::AlignSelf, "stretch"),
        "self-baseline" => sets(K::AlignSelf, "baseline"),
        "place-content-center" => {
            return Some(vec![
                sets(K::AlignContent, "center"),
                sets(K::JustifyContent, "center"),
            ]);
        }
        "place-content-start" => {
            return Some(vec![
                sets(K::AlignContent, "start"),
                sets(K::JustifyContent, "start"),
            ]);
        }
        "place-content-end" => {
            return Some(vec![
                sets(K::AlignContent, "end"),
                sets(K::JustifyContent, "end"),
            ]);
        }
        "place-content-between" => {
            return Some(vec![
                sets(K::AlignContent, "space-between"),
                sets(K::JustifyContent, "space-between"),
            ]);
        }
        "place-content-stretch" => {
            return Some(vec![
                sets(K::AlignContent, "stretch"),
                sets(K::JustifyContent, "stretch"),
            ]);
        }
        "place-items-center" => {
            return Some(vec![
                sets(K::AlignItems, "center"),
                sets(K::JustifyItems, "center"),
            ]);
        }
        "place-items-start" => {
            return Some(vec![
                sets(K::AlignItems, "start"),
                sets(K::JustifyItems, "start"),
            ]);
        }
        "place-items-end" => {
            return Some(vec![
                sets(K::AlignItems, "end"),
                sets(K::JustifyItems, "end"),
            ]);
        }
        "place-items-stretch" => {
            return Some(vec![
                sets(K::AlignItems, "stretch"),
                sets(K::JustifyItems, "stretch"),
            ]);
        }
        "place-self-auto" => {
            return Some(vec![
                sets(K::AlignSelf, "auto"),
                sets(K::JustifySelf, "auto"),
            ]);
        }
        "place-self-center" => {
            return Some(vec![
                sets(K::AlignSelf, "center"),
                sets(K::JustifySelf, "center"),
            ]);
        }
        "place-self-start" => {
            return Some(vec![
                sets(K::AlignSelf, "start"),
                sets(K::JustifySelf, "start"),
            ]);
        }
        "place-self-end" => {
            return Some(vec![sets(K::AlignSelf, "end"), sets(K::JustifySelf, "end")]);
        }
        "place-self-stretch" => {
            return Some(vec![
                sets(K::AlignSelf, "stretch"),
                sets(K::JustifySelf, "stretch"),
            ]);
        }
        "grid-flow-row" => sets(K::GridAutoFlow, "row"),
        "grid-flow-col" => sets(K::GridAutoFlow, "column"),
        "grid-flow-dense" | "grid-flow-row-dense" => sets(K::GridAutoFlow, "row dense"),
        "grid-flow-col-dense" => sets(K::GridAutoFlow, "column dense"),
        "col-auto" => sets(K::GridColumn, "auto"),
        "row-auto" => sets(K::GridRow, "auto"),
        "col-span-full" => sets(K::GridColumn, "1 / -1"),
        "row-span-full" => sets(K::GridRow, "1 / -1"),
        "grid-cols-none" => sets(K::GridTemplateColumns, "none"),
        "grid-rows-none" => sets(K::GridTemplateRows, "none"),
        "auto-cols-auto" => sets(K::GridAutoColumns, "auto"),
        "auto-cols-min" => sets(K::GridAutoColumns, "min-content"),
        "auto-cols-max" => sets(K::GridAutoColumns, "max-content"),
        "auto-cols-fr" => sets(K::GridAutoColumns, "minmax(0, 1fr)"),
        "auto-rows-auto" => sets(K::GridAutoRows, "auto"),
        "auto-rows-min" => sets(K::GridAutoRows, "min-content"),
        "auto-rows-max" => sets(K::GridAutoRows, "max-content"),
        "auto-rows-fr" => sets(K::GridAutoRows, "minmax(0, 1fr)"),
        "aspect-auto" => Decl::Set(K::AspectRatio, PropertyValue::Default),
        // Typography.
        "italic" => sets(K::FontStyle, "italic"),
        "not-italic" => sets(K::FontStyle, "normal"),
        "underline" => sets(K::TextDecorationLine, "underline"),
        "line-through" => sets(K::TextDecorationLine, "line-through"),
        "no-underline" => sets(K::TextDecorationLine, "none"),
        "decoration-solid" => sets(K::TextDecorationStyle, "solid"),
        "decoration-double" => sets(K::TextDecorationStyle, "double"),
        "decoration-dotted" => sets(K::TextDecorationStyle, "dotted"),
        "decoration-dashed" => sets(K::TextDecorationStyle, "dashed"),
        "decoration-wavy" => sets(K::TextDecorationStyle, "wavy"),
        "decoration-auto" | "decoration-from-font" => sets(K::TextDecorationThickness, "auto"),
        "underline-offset-auto" => sets(K::TextUnderlineOffset, "auto"),
        "uppercase" => sets(K::TextTransform, "uppercase"),
        "lowercase" => sets(K::TextTransform, "lowercase"),
        "capitalize" => sets(K::TextTransform, "capitalize"),
        "normal-case" => sets(K::TextTransform, "none"),
        "text-left" => sets(K::TextAlign, "left"),
        "text-center" => sets(K::TextAlign, "center"),
        "text-right" => sets(K::TextAlign, "right"),
        "text-justify" => sets(K::TextAlign, "justify"),
        "text-start" => sets(K::TextAlign, "start"),
        "text-end" => sets(K::TextAlign, "end"),
        // `vertical-align` of views and images inside a text (`align-top`,
        // `align-bottom`, `align-sub` and `align-super` are the line box's
        // or the baseline's, which NSH does not place by).
        "align-baseline" => sets(K::VerticalAlign, "baseline"),
        "align-text-top" => sets(K::VerticalAlign, "text-top"),
        "align-text-bottom" => sets(K::VerticalAlign, "text-bottom"),
        "align-middle" => sets(K::VerticalAlign, "middle"),
        "text-ellipsis" => overflow(EllipsizeMode::Tail),
        "text-clip" => overflow(EllipsizeMode::Clip),
        "truncate" => {
            return Some(vec![
                clamp(1),
                overflow(EllipsizeMode::Tail),
                Decl::Prop(PropDecl::NoWrap(true)),
                sets(K::Overflow, "hidden"),
            ]);
        }
        "whitespace-nowrap" | "text-nowrap" => Decl::Prop(PropDecl::NoWrap(true)),
        "whitespace-normal" | "text-wrap" | "text-balance" | "text-pretty" => {
            Decl::Prop(PropDecl::NoWrap(false))
        }
        "line-clamp-none" => clamp(0),
        // `font-variant-numeric: normal`: the number forms only.
        "normal-nums" => Decl::Part(Part::FontVariant {
            set: 0,
            clear: !FontVariant::SMALL_CAPS,
        }),
        "small-caps" => Decl::Part(Part::FontVariant {
            set: FontVariant::SMALL_CAPS,
            clear: 0,
        }),
        "oldstyle-nums" => Decl::Part(Part::FontVariant {
            set: FontVariant::OLDSTYLE_NUMS,
            clear: FontVariant::LINING_NUMS,
        }),
        "lining-nums" => Decl::Part(Part::FontVariant {
            set: FontVariant::LINING_NUMS,
            clear: FontVariant::OLDSTYLE_NUMS,
        }),
        "tabular-nums" => Decl::Part(Part::FontVariant {
            set: FontVariant::TABULAR_NUMS,
            clear: FontVariant::PROPORTIONAL_NUMS,
        }),
        "proportional-nums" => Decl::Part(Part::FontVariant {
            set: FontVariant::PROPORTIONAL_NUMS,
            clear: FontVariant::TABULAR_NUMS,
        }),
        // Backgrounds.
        "text-inherit" | "text-current" => Decl::Set(K::Color, PropertyValue::Default),
        "bg-none" => Decl::Part(Part::GradientNone),
        "bg-linear-to-t" | "bg-gradient-to-t" => {
            Decl::Part(Part::Gradient(GradientKind::Linear { angle: deg(0.0) }))
        }
        "bg-linear-to-r" | "bg-gradient-to-r" => {
            Decl::Part(Part::Gradient(GradientKind::Linear { angle: deg(90.0) }))
        }
        "bg-linear-to-b" | "bg-gradient-to-b" => {
            Decl::Part(Part::Gradient(GradientKind::Linear { angle: deg(180.0) }))
        }
        "bg-linear-to-l" | "bg-gradient-to-l" => {
            Decl::Part(Part::Gradient(GradientKind::Linear { angle: deg(270.0) }))
        }
        "bg-linear-to-tr" | "bg-gradient-to-tr" => {
            Decl::Part(Part::Gradient(GradientKind::LinearCorner {
                right: true,
                bottom: false,
            }))
        }
        "bg-linear-to-br" | "bg-gradient-to-br" => {
            Decl::Part(Part::Gradient(GradientKind::LinearCorner {
                right: true,
                bottom: true,
            }))
        }
        "bg-linear-to-bl" | "bg-gradient-to-bl" => {
            Decl::Part(Part::Gradient(GradientKind::LinearCorner {
                right: false,
                bottom: true,
            }))
        }
        "bg-linear-to-tl" | "bg-gradient-to-tl" => {
            Decl::Part(Part::Gradient(GradientKind::LinearCorner {
                right: false,
                bottom: false,
            }))
        }
        "bg-radial" => Decl::Part(Part::Gradient(GradientKind::Radial {
            circle: false,
            size: GradientSize::FarthestCorner,
            x: percentage(0.5),
            y: percentage(0.5),
        })),
        "bg-conic" => Decl::Part(Part::Gradient(GradientKind::Conic {
            from: deg(0.0),
            x: percentage(0.5),
            y: percentage(0.5),
        })),
        // Borders and outlines.
        "border-solid" => sets(K::BorderStyle, "solid"),
        "border-dashed" => sets(K::BorderStyle, "dashed"),
        "border-dotted" => sets(K::BorderStyle, "dotted"),
        // `border-style: none`: no border whatever the width utilities.
        "border-none" => sets(K::BorderStyle, "none"),
        "border-hidden" => sets(K::BorderStyle, "hidden"),
        // A style without a width: CSS's initial `medium` width (3px).
        "outline-solid" => return outline_style("solid"),
        "outline-dashed" => return outline_style("dashed"),
        "outline-dotted" => return outline_style("dotted"),
        "outline-none" | "outline-hidden" => sets(K::OutlineStyle, "none"),
        "ring-inset" => Decl::Part(Part::RingInset),
        // Effects.
        "shadow-none" => Decl::Part(Part::Shadow(Arc::from([]))),
        "inset-shadow-none" => Decl::Part(Part::InsetShadow(Arc::from([]))),
        "text-shadow-none" => Decl::Part(Part::TextShadow(Arc::from([]))),
        "filter-none" => Decl::Part(Part::FilterNone { backdrop: false }),
        "backdrop-filter-none" => Decl::Part(Part::FilterNone { backdrop: true }),
        "grayscale" => filter(false, 3, Filter::Grayscale(1.0)),
        "invert" => filter(false, 5, Filter::Invert(1.0)),
        "sepia" => filter(false, 7, Filter::Sepia(1.0)),
        "backdrop-grayscale" => filter(true, 3, Filter::Grayscale(1.0)),
        "backdrop-invert" => filter(true, 5, Filter::Invert(1.0)),
        "backdrop-sepia" => filter(true, 8, Filter::Sepia(1.0)),
        // Transforms.
        "transform-none" => Decl::Part(Part::TransformNone),
        "translate-none" => Decl::Part(Part::TranslateNone),
        "scale-none" => Decl::Part(Part::ScaleNone),
        "rotate-none" => Decl::Part(Part::RotateNone),
        "backface-hidden" => sets(K::BackfaceVisibility, "hidden"),
        "backface-visible" => sets(K::BackfaceVisibility, "visible"),
        // NSH composes every transform alike, and flat is the default.
        "transform" | "transform-gpu" | "transform-cpu" | "transform-flat" => {
            return Some(Vec::new());
        }
        // Transitions and animations.
        "transition" => Decl::Part(Part::TransitionProps(
            TransitionProps::COLORS
                | TransitionProps::OPACITY
                | TransitionProps::SHADOW
                | TransitionProps::TRANSFORM,
        )),
        "transition-all" => Decl::Part(Part::TransitionProps(TransitionProps::ALL)),
        "transition-colors" => Decl::Part(Part::TransitionProps(TransitionProps::COLORS)),
        "transition-opacity" => Decl::Part(Part::TransitionProps(TransitionProps::OPACITY)),
        "transition-shadow" => Decl::Part(Part::TransitionProps(TransitionProps::SHADOW)),
        "transition-transform" => Decl::Part(Part::TransitionProps(TransitionProps::TRANSFORM)),
        "transition-none" => Decl::Part(Part::TransitionNone),
        "ease-initial" => Decl::Part(Part::Ease(Transition::EASE)),
        "animate-spin" => Decl::Part(Part::Animate(Some(Keyframes::Spin))),
        "animate-ping" => Decl::Part(Part::Animate(Some(Keyframes::Ping))),
        "animate-pulse" => Decl::Part(Part::Animate(Some(Keyframes::Pulse))),
        "animate-bounce" => Decl::Part(Part::Animate(Some(Keyframes::Bounce))),
        "animate-none" => Decl::Part(Part::Animate(None)),
        // Interactivity.
        "pointer-events-none" => Decl::Set(
            K::PointerEvents,
            PropertyValue::PointerEvents(Some(PointerEvents::None)),
        ),
        "pointer-events-auto" => Decl::Set(
            K::PointerEvents,
            PropertyValue::PointerEvents(Some(PointerEvents::Auto)),
        ),
        // `user-select` of a text that says `auto` is its parent's: the
        // classes of the views around it reach it (`Core::rebuild_text`).
        "select-none" => Decl::Set(K::UserSelect, PropertyValue::OptBool(Some(false))),
        "select-text" => Decl::Set(K::UserSelect, PropertyValue::OptBool(Some(true))),
        "select-auto" => Decl::Set(K::UserSelect, PropertyValue::OptBool(None)),
        "space-x-reverse" => Decl::Prop(PropDecl::SpaceReverse(false)),
        "space-y-reverse" => Decl::Prop(PropDecl::SpaceReverse(true)),
        // Images.
        "object-contain" => sets(K::ObjectFit, "contain"),
        "object-cover" => sets(K::ObjectFit, "cover"),
        "object-fill" => sets(K::ObjectFit, "fill"),
        "object-none" => sets(K::ObjectFit, "none"),
        "object-scale-down" => sets(K::ObjectFit, "scale-down"),
        _ => return None,
    };
    Some(vec![d])
}

/// `outline-<style>`: the style, and a medium width unless a width
/// utility sets one.
fn outline_style(style: &str) -> Option<Vec<Decl>> {
    Some(vec![
        sets(K::OutlineStyle, style),
        Decl::Default(K::OutlineWidth, PropertyValue::Points(px(3.0))),
        Decl::CurrentColor(K::OutlineColor),
    ])
}

/// `outline-<width>`: the width, solid unless a style utility says
/// otherwise wherever it is (`outline-style: var(--tw-outline-style)`).
fn outline_width(width: f32) -> Vec<Decl> {
    vec![
        setn(K::OutlineWidth, width),
        Decl::Default(
            K::OutlineStyle,
            PropertyValue::BorderStyle(crate::BorderStyle::Solid, false),
        ),
        Decl::CurrentColor(K::OutlineColor),
    ]
}

/// A shadow size of the theme or arbitrary layers (`shadow-xl`,
/// `shadow-[0_35px_35px_red]`), with an alpha modifier (`/20`) replacing
/// the alpha of their colors; `inset` for an inset shadow's arbitrary
/// layers.
fn shadow_layers(
    sizes: &FxHashMap<Box<str>, Vec<BoxShadow>>,
    v: &str,
    inset: bool,
) -> Option<(Vec<BoxShadow>, Option<f32>)> {
    let with_alpha = |l: BoxShadow, a: f32| BoxShadow {
        color: alpha_of(l.color, a),
        ..l
    };
    if let Some(found) = sized(sizes, v, with_alpha) {
        return Some(found);
    }
    let (base, modifier) = match v.find(']') {
        Some(end) if v.starts_with('[') => (&v[..=end], v[end + 1..].strip_prefix('/')),
        _ => return None,
    };
    let layers = css::box_shadows(&arbitrary(base)?)?
        .into_iter()
        .map(|s| BoxShadow {
            inset: inset || s.inset,
            ..s
        });
    Some(match modifier {
        Some(m) => {
            let a = alpha_modifier(m)?;
            (layers.map(|l| with_alpha(l, a)).collect(), Some(a))
        }
        None => (layers.collect(), None),
    })
}

/// A `drop-shadow()` per layer, in their order (CSS's chain: each one
/// shadows what the ones before it drew too).
fn drop_shadows(layers: &[BoxShadow]) -> Part {
    Part::DropShadows(
        layers
            .iter()
            .map(|l| Filter::DropShadow {
                offset_x: l.offset_x,
                offset_y: l.offset_y,
                blur: l.blur,
                color: l.color,
            })
            .collect(),
    )
}

fn filter(backdrop: bool, slot: u8, f: Filter) -> Decl {
    Decl::Part(Part::Filter {
        backdrop,
        slot,
        filter: Some(f),
    })
}

/// Prefixed utilities, longest prefixes first where they overlap.
static PREFIXES: &[(&str, Handler)] = &[
    // Spacing.
    ("px", |t, v, n| {
        one(spacing(K::PaddingHorizontal, t, v, n, false)?)
    }),
    ("py", |t, v, n| {
        one(spacing(K::PaddingVertical, t, v, n, false)?)
    }),
    ("pt", |t, v, n| one(spacing(K::PaddingTop, t, v, n, false)?)),
    ("pr", |t, v, n| {
        one(spacing(K::PaddingRight, t, v, n, false)?)
    }),
    ("pb", |t, v, n| {
        one(spacing(K::PaddingBottom, t, v, n, false)?)
    }),
    ("pl", |t, v, n| {
        one(spacing(K::PaddingLeft, t, v, n, false)?)
    }),
    ("ps", |t, v, n| {
        one(spacing(K::PaddingStart, t, v, n, false)?)
    }),
    ("pe", |t, v, n| one(spacing(K::PaddingEnd, t, v, n, false)?)),
    ("p", |t, v, n| one(spacing(K::Padding, t, v, n, false)?)),
    ("mx", |t, v, n| {
        one(spacing(K::MarginHorizontal, t, v, n, true)?)
    }),
    ("my", |t, v, n| {
        one(spacing(K::MarginVertical, t, v, n, true)?)
    }),
    ("mt", |t, v, n| one(spacing(K::MarginTop, t, v, n, true)?)),
    ("mr", |t, v, n| one(spacing(K::MarginRight, t, v, n, true)?)),
    ("mb", |t, v, n| {
        one(spacing(K::MarginBottom, t, v, n, true)?)
    }),
    ("ml", |t, v, n| one(spacing(K::MarginLeft, t, v, n, true)?)),
    ("ms", |t, v, n| one(spacing(K::MarginStart, t, v, n, true)?)),
    ("me", |t, v, n| one(spacing(K::MarginEnd, t, v, n, true)?)),
    ("m", |t, v, n| one(spacing(K::Margin, t, v, n, true)?)),
    ("gap-x", |t, v, _| {
        one(set(K::ColumnGap, spacing_value(t, v, false, false)?))
    }),
    ("gap-y", |t, v, _| {
        one(set(K::RowGap, spacing_value(t, v, false, false)?))
    }),
    ("gap", |t, v, _| {
        one(set(K::Gap, spacing_value(t, v, false, false)?))
    }),
    // `space-*` gives the children but the last a margin (the view's
    // `ClassProps::space`, which the core gives them).
    ("space-x", |t, v, n| {
        let margin = K::MarginRight.length_value(spacing_value(t, v, n, false)?);
        one(Decl::Prop(PropDecl::Space(false, margin.ok()?)))
    }),
    ("space-y", |t, v, n| {
        let margin = K::MarginBottom.length_value(spacing_value(t, v, n, false)?);
        one(Decl::Prop(PropDecl::Space(true, margin.ok()?)))
    }),
    // Insets.
    ("inset-x", |t, v, n| {
        let l = length_value(t, v, n, true)?;
        Some(vec![set(K::Left, l), set(K::Right, l)])
    }),
    ("inset-y", |t, v, n| {
        let l = length_value(t, v, n, true)?;
        Some(vec![set(K::Top, l), set(K::Bottom, l)])
    }),
    ("inset", |t, v, n| {
        let l = length_value(t, v, n, true)?;
        Some(vec![
            set(K::Top, l),
            set(K::Right, l),
            set(K::Bottom, l),
            set(K::Left, l),
        ])
    }),
    ("top", |t, v, n| {
        one(set(K::Top, length_value(t, v, n, true)?))
    }),
    ("right", |t, v, n| {
        one(set(K::Right, length_value(t, v, n, true)?))
    }),
    ("bottom", |t, v, n| {
        one(set(K::Bottom, length_value(t, v, n, true)?))
    }),
    ("left", |t, v, n| {
        one(set(K::Left, length_value(t, v, n, true)?))
    }),
    ("inset-s", |t, v, n| {
        one(set(K::Start, length_value(t, v, n, true)?))
    }),
    ("inset-e", |t, v, n| {
        one(set(K::End, length_value(t, v, n, true)?))
    }),
    ("start", |t, v, n| {
        one(set(K::Start, length_value(t, v, n, true)?))
    }),
    ("end", |t, v, n| {
        one(set(K::End, length_value(t, v, n, true)?))
    }),
    ("z", |_, v, n| {
        // `z-index` takes integers: bare positive ones, any arbitrary one.
        let z = match v {
            "auto" if !n => 0.0,
            v => match arbitrary(v) {
                Some(a) => unhinted(&a).trim().parse::<i32>().ok()? as f32,
                None => int(v)?,
            },
        };
        one(setn(K::ZIndex, if n { -z } else { z }))
    }),
    // Sizing.
    ("min-w", |t, v, _| size(t, v, K::MinWidth, true)),
    ("max-w", |t, v, _| size(t, v, K::MaxWidth, true)),
    ("min-h", |t, v, _| size(t, v, K::MinHeight, false)),
    ("max-h", |t, v, _| size(t, v, K::MaxHeight, false)),
    ("size", |t, v, _| {
        // `screen` is `100vw` or `100vh`, one axis's.
        if v == "screen" {
            return None;
        }
        let mut w = size(t, v, K::Width, true)?;
        w.extend(size(t, v, K::Height, false)?);
        Some(w)
    }),
    ("w", |t, v, _| size(t, v, K::Width, true)),
    ("h", |t, v, _| size(t, v, K::Height, false)),
    ("basis", |t, v, _| {
        if let Some(w) = t.containers.get(v) {
            return one(setn(K::FlexBasis, *w));
        }
        one(set(K::FlexBasis, length_value(t, v, false, true)?))
    }),
    ("aspect", |t, v, _| {
        let r = match t.aspect.get(v) {
            Some(r) => *r,
            None => match arbitrary(v) {
                Some(a) => fraction(&a.replace(' ', "")).or_else(|| arbitrary_num(&a))?,
                None => fraction(v)?,
            },
        };
        one(setn(K::AspectRatio, r))
    }),
    // Flex and grid.
    ("flex", |t, v, _| {
        if let Some(n) = int(v) {
            return Some(vec![
                setn(K::FlexGrow, n),
                setn(K::FlexShrink, 1.0),
                setn(K::FlexBasis, 0.0),
            ]);
        }
        // `flex-[2]`, `flex-[2_1_0%]`, `flex-[auto]`: the CSS shorthand,
        // as a style's `flex` reads it.
        let a = arbitrary(v)?;
        let (grow, shrink, basis) = css::flex(&a)?;
        let basis = match basis {
            None => px(0.0).into(),
            Some("auto") => Length::Auto,
            Some(b) => length_value(t, &format!("[{b}]"), false, true)?,
        };
        Some(vec![
            setn(K::FlexGrow, grow),
            setn(K::FlexShrink, shrink),
            set(K::FlexBasis, basis),
        ])
    }),
    ("grow", |_, v, _| {
        one(setn(
            K::FlexGrow,
            int(v).or_else(|| arbitrary(v).and_then(|a| arbitrary_num(&a)))?,
        ))
    }),
    ("shrink", |_, v, _| {
        one(setn(
            K::FlexShrink,
            int(v).or_else(|| arbitrary(v).and_then(|a| arbitrary_num(&a)))?,
        ))
    }),
    // Tailwind CSS has no negative grid templates, spans or auto tracks.
    ("grid-cols", |_, v, n| {
        one(Decl::Set(K::GridTemplateColumns, grid_template(v, n)?))
    }),
    ("grid-rows", |_, v, n| {
        one(Decl::Set(K::GridTemplateRows, grid_template(v, n)?))
    }),
    ("col-span", |_, v, n| {
        let c = count(v, n)?;
        one(Decl::Set(
            K::GridColumn,
            PropertyValue::GridLine(crate::grid::span(c)),
        ))
    }),
    ("row-span", |_, v, n| {
        let c = count(v, n)?;
        one(Decl::Set(
            K::GridRow,
            PropertyValue::GridLine(crate::grid::span(c)),
        ))
    }),
    ("col-start", |_, v, n| {
        one(Decl::Set(
            K::GridColumnStart,
            PropertyValue::GridPlacement(line_index(v, n)?),
        ))
    }),
    ("col-end", |_, v, n| {
        one(Decl::Set(
            K::GridColumnEnd,
            PropertyValue::GridPlacement(line_index(v, n)?),
        ))
    }),
    ("row-start", |_, v, n| {
        one(Decl::Set(
            K::GridRowStart,
            PropertyValue::GridPlacement(line_index(v, n)?),
        ))
    }),
    ("row-end", |_, v, n| {
        one(Decl::Set(
            K::GridRowEnd,
            PropertyValue::GridPlacement(line_index(v, n)?),
        ))
    }),
    ("col", |_, v, n| {
        let line = match arbitrary(v) {
            // Left to the style, which logs an invalid one and sets
            // nothing, as a browser drops an invalid declaration.
            Some(a) if !n => return Some(arb(K::GridColumn, unhinted(&a)).into_iter().collect()),
            // `-col-[2]`: Tailwind CSS's `calc(2 * -1)`; anything else
            // negated is a declaration a browser drops.
            Some(_) => {
                return Some(line_index(v, n).map_or_else(Vec::new, |l| {
                    vec![Decl::Set(
                        K::GridColumn,
                        PropertyValue::GridLine(crate::grid::line_from(l)),
                    )]
                }));
            }
            None => line_index(v, n)?,
        };
        one(Decl::Set(
            K::GridColumn,
            PropertyValue::GridLine(crate::grid::line_from(line)),
        ))
    }),
    ("row", |_, v, n| {
        let line = match arbitrary(v) {
            // As `col`.
            Some(a) if !n => return Some(arb(K::GridRow, unhinted(&a)).into_iter().collect()),
            Some(_) => {
                return Some(line_index(v, n).map_or_else(Vec::new, |l| {
                    vec![Decl::Set(
                        K::GridRow,
                        PropertyValue::GridLine(crate::grid::line_from(l)),
                    )]
                }));
            }
            None => line_index(v, n)?,
        };
        one(Decl::Set(
            K::GridRow,
            PropertyValue::GridLine(crate::grid::line_from(line)),
        ))
    }),
    ("auto-cols", |_, v, n| auto_tracks(K::GridAutoColumns, v, n)),
    ("auto-rows", |_, v, n| auto_tracks(K::GridAutoRows, v, n)),
    // Typography.
    ("font", |t, v, _| {
        if let Some(w) = t.weights.get(v) {
            return one(setn(K::FontWeight, *w as f32));
        }
        if let Some(f) = t.fonts.get(v) {
            return one(match f {
                Some(name) => sets(K::FontFamily, name),
                None => Decl::Set(K::FontFamily, PropertyValue::Default),
            });
        }
        let a = arbitrary(v)?;
        if let Some(family) = arbitrary_hinted(&a, "family-name") {
            return one(sets(K::FontFamily, family.trim_matches(['"', '\''])));
        }
        match arbitrary_num(&a) {
            Some(w) => one(setn(K::FontWeight, w)),
            None => one(sets(K::FontFamily, a.trim_matches(['"', '\'']))),
        }
    }),
    ("text-shadow", |t, v, _| {
        if let Some((layers, alpha)) = sized(&t.text_shadows, v, |l, a| TextShadow {
            color: alpha_of(l.color, a),
            ..l
        }) {
            let mut d = vec![Decl::Part(Part::TextShadow(Arc::from(layers)))];
            d.extend(alpha.map(|a| Decl::Part(Part::TextShadowAlpha(a))));
            return Some(d);
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::TextShadow, a));
        }
        part(Part::TextShadowColor(color(t, v)?))
    }),
    ("text", text),
    ("tracking", |t, v, n| {
        let em = match t.tracking.get(v) {
            Some(em) => *em,
            None => {
                let a = arbitrary(v)?;
                return one(arb(K::LetterSpacing, &a)?);
            }
        };
        let em = if n { -em } else { em };
        one(Decl::Set(
            K::LetterSpacing,
            PropertyValue::LetterSpacing(None, Some(ordered_float::OrderedFloat(em))),
        ))
    }),
    ("leading", |t, v, _| one(line_height(t, v)?)),
    ("line-clamp", |_, v, _| one(clamp(int(v)? as u32))),
    ("decoration", |t, v, _| {
        if let Some(n) = int(v) {
            return one(setn(K::TextDecorationThickness, n));
        }
        if let Some(a) = current(v) {
            return one(Decl::SetCurrentColor(K::TextDecorationColor, a));
        }
        if let Some(mix) = mixes_current(v) {
            return one(arb(K::TextDecorationColor, &mix)?);
        }
        if let Some(c) = color(t, v) {
            return one(setc(K::TextDecorationColor, c));
        }
        one(setn(K::TextDecorationThickness, arbitrary_points(t, v)?))
    }),
    ("underline-offset", |t, v, n| {
        let p = int(v).or_else(|| arbitrary_points(t, v))?;
        one(setn(K::TextUnderlineOffset, if n { -p } else { p }))
    }),
    // SVG paint (Tailwind's `fill-*` / `stroke-*`): what the shapes Rust
    // components draw paint with.
    ("fill", |t, v, _| one(Decl::Set(K::Fill, svg_paint(t, v)?))),
    ("stroke", |t, v, _| {
        if let Some(n) = num(v) {
            return one(setn(K::StrokeWidth, n));
        }
        if let Some(p) = svg_paint(t, v) {
            return one(Decl::Set(K::Stroke, p));
        }
        let a = arbitrary(v)?;
        let a = arbitrary_hinted(&a, "length")
            .or_else(|| arbitrary_hinted(&a, "number"))
            .unwrap_or(&a);
        one(setn(K::StrokeWidth, css::length(a).filter(|n| *n >= 0.0)?))
    }),
    ("caret", |t, v, _| {
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::Caret, a));
        }
        one(Decl::Prop(PropDecl::Caret(color(t, v)?)))
    }),
    // Backgrounds.
    ("bg-linear", |_, v, n| {
        let a = degrees(v)?;
        let kind = GradientKind::Linear {
            angle: deg(if n { -a } else { a }),
        };
        part(if v.starts_with('[') {
            Part::ArbitraryGradient(kind)
        } else {
            Part::Gradient(kind)
        })
    }),
    ("bg-conic", |_, v, n| {
        let a = degrees(v)?;
        let kind = GradientKind::Conic {
            from: deg(if n { -a } else { a }),
            x: percentage(0.5),
            y: percentage(0.5),
        };
        part(if v.starts_with('[') {
            Part::ArbitraryGradient(kind)
        } else {
            Part::Gradient(kind)
        })
    }),
    ("bg", |t, v, _| {
        if let Some(a) = arbitrary(v)
            && a.contains("gradient(")
        {
            if css::gradient(&css::with_current_color(&a, Color::BLACK)).is_none() {
                // Reported here: the class is also unknown, but that does
                // not say the gradient is what was rejected.
                log::warn!("invalid gradient in class `bg-{v}`: {a}");
                return None;
            }
            return one(Decl::Style(StyleDecl::Set(
                K::BackgroundImage,
                K::BackgroundImage.parse_value(StyleValue::Str(&a)).ok()?,
            )));
        }
        if let Some(a) = current(v) {
            return one(Decl::SetCurrentColor(K::BackgroundColor, a));
        }
        if let Some(mix) = mixes_current(v) {
            return one(arb(K::BackgroundColor, &mix)?);
        }
        one(setc(K::BackgroundColor, color(t, v)?))
    }),
    ("from", |t, v, _| match (stop_position(v), current(v)) {
        (Some(p), _) => part(Part::FromPos(p)),
        (_, Some(a)) => one(Decl::CurrentPart(ColorSlot::From, a)),
        _ => part(Part::From(color(t, v)?, legacy_color(v))),
    }),
    ("via", |t, v, _| match (stop_position(v), current(v)) {
        (Some(p), _) => part(Part::ViaPos(p)),
        (_, Some(a)) => one(Decl::CurrentPart(ColorSlot::Via, a)),
        _ => part(Part::Via(color(t, v)?, legacy_color(v))),
    }),
    ("to", |t, v, _| match (stop_position(v), current(v)) {
        (Some(p), _) => part(Part::ToPos(p)),
        (_, Some(a)) => one(Decl::CurrentPart(ColorSlot::To, a)),
        _ => part(Part::To(color(t, v)?, legacy_color(v))),
    }),
    // Borders.
    ("rounded-tl", |t, v, _| {
        radius(t, v, &[K::BorderTopLeftRadius])
    }),
    ("rounded-tr", |t, v, _| {
        radius(t, v, &[K::BorderTopRightRadius])
    }),
    ("rounded-br", |t, v, _| {
        radius(t, v, &[K::BorderBottomRightRadius])
    }),
    ("rounded-bl", |t, v, _| {
        radius(t, v, &[K::BorderBottomLeftRadius])
    }),
    ("rounded-ss", |t, v, _| {
        radius(t, v, &[K::BorderTopStartRadius])
    }),
    ("rounded-se", |t, v, _| {
        radius(t, v, &[K::BorderTopEndRadius])
    }),
    ("rounded-ee", |t, v, _| {
        radius(t, v, &[K::BorderBottomEndRadius])
    }),
    ("rounded-es", |t, v, _| {
        radius(t, v, &[K::BorderBottomStartRadius])
    }),
    ("rounded-t", |t, v, _| {
        radius(t, v, &[K::BorderTopLeftRadius, K::BorderTopRightRadius])
    }),
    ("rounded-r", |t, v, _| {
        radius(t, v, &[K::BorderTopRightRadius, K::BorderBottomRightRadius])
    }),
    ("rounded-b", |t, v, _| {
        radius(
            t,
            v,
            &[K::BorderBottomRightRadius, K::BorderBottomLeftRadius],
        )
    }),
    ("rounded-l", |t, v, _| {
        radius(t, v, &[K::BorderTopLeftRadius, K::BorderBottomLeftRadius])
    }),
    ("rounded-s", |t, v, _| {
        radius(t, v, &[K::BorderTopStartRadius, K::BorderBottomStartRadius])
    }),
    ("rounded-e", |t, v, _| {
        radius(t, v, &[K::BorderTopEndRadius, K::BorderBottomEndRadius])
    }),
    ("rounded", |t, v, _| radius(t, v, &[K::BorderRadius])),
    ("border-x", |t, v, _| {
        border(
            t,
            v,
            &[K::BorderLeftWidth, K::BorderRightWidth],
            &[K::BorderLeftColor, K::BorderRightColor],
        )
    }),
    ("border-y", |t, v, _| {
        border(
            t,
            v,
            &[K::BorderTopWidth, K::BorderBottomWidth],
            &[K::BorderTopColor, K::BorderBottomColor],
        )
    }),
    ("border-t", |t, v, _| {
        border(t, v, &[K::BorderTopWidth], &[K::BorderTopColor])
    }),
    ("border-r", |t, v, _| {
        border(t, v, &[K::BorderRightWidth], &[K::BorderRightColor])
    }),
    ("border-b", |t, v, _| {
        border(t, v, &[K::BorderBottomWidth], &[K::BorderBottomColor])
    }),
    ("border-l", |t, v, _| {
        border(t, v, &[K::BorderLeftWidth], &[K::BorderLeftColor])
    }),
    ("border-s", |t, v, _| {
        border(t, v, &[K::BorderStartWidth], &[K::BorderStartColor])
    }),
    ("border-e", |t, v, _| {
        border(t, v, &[K::BorderEndWidth], &[K::BorderEndColor])
    }),
    ("border", |t, v, _| {
        border(t, v, &[K::BorderWidth], &[K::BorderColor])
    }),
    ("outline-offset", |t, v, n| {
        let p = int(v).or_else(|| arbitrary_points(t, v))?;
        one(setn(K::OutlineOffset, if n { -p } else { p }))
    }),
    ("outline", |t, v, _| {
        if let Some(n) = int(v) {
            return Some(outline_width(n));
        }
        if let Some(a) = current(v) {
            return one(Decl::SetCurrentColor(K::OutlineColor, a));
        }
        if let Some(mix) = mixes_current(v) {
            return one(arb(K::OutlineColor, &mix)?);
        }
        if let Some(c) = color(t, v) {
            return one(setc(K::OutlineColor, c));
        }
        Some(outline_width(arbitrary_points(t, v)?))
    }),
    ("inset-ring", |t, v, _| {
        if let Some(n) = int(v).or_else(|| arbitrary(v).and_then(|a| class_length(t, &a))) {
            return part(Part::InsetRing(n));
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::InsetRing, a));
        }
        part(Part::InsetRingColor(color(t, v)?))
    }),
    ("ring-offset", |t, v, _| {
        if let Some(n) = int(v).or_else(|| arbitrary(v).and_then(|a| class_length(t, &a))) {
            return part(Part::RingOffset(n));
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::RingOffset, a));
        }
        part(Part::RingOffsetColor(color(t, v)?))
    }),
    ("ring", |t, v, _| {
        if let Some(n) = int(v).or_else(|| arbitrary(v).and_then(|a| class_length(t, &a))) {
            return part(Part::Ring(n));
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::Ring, a));
        }
        part(Part::RingColor(color(t, v)?))
    }),
    // Effects.
    ("inset-shadow", |t, v, _| {
        if let Some((s, alpha)) = shadow_layers(&t.inset_shadows, v, true) {
            let mut d = vec![Decl::Part(Part::InsetShadow(Arc::from(s)))];
            d.extend(alpha.map(|a| Decl::Part(Part::InsetShadowAlpha(a))));
            return Some(d);
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::InsetShadow, a));
        }
        part(Part::InsetShadowColor(color(t, v)?))
    }),
    ("shadow", |t, v, _| {
        if let Some((s, alpha)) = shadow_layers(&t.shadows, v, false) {
            let mut d = vec![Decl::Part(Part::Shadow(Arc::from(s)))];
            d.extend(alpha.map(|a| Decl::Part(Part::ShadowAlpha(a))));
            return Some(d);
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::Shadow, a));
        }
        part(Part::ShadowColor(color(t, v)?))
    }),
    ("opacity", |_, v, _| {
        one(setn(K::Opacity, opacity_factor(v)?.clamp(0.0, 1.0)))
    }),
    ("mix-blend", |_, v, _| {
        one(Decl::Set(
            K::MixBlendMode,
            PropertyValue::BlendMode(crate::effects::BlendMode::parse(v)?),
        ))
    }),
    ("backdrop-blur", |t, v, _| blur(t, v, true)),
    ("backdrop-brightness", |_, v, _| {
        one(filter(true, 1, Filter::Brightness(percent_factor(v)?)))
    }),
    ("backdrop-contrast", |_, v, _| {
        one(filter(true, 2, Filter::Contrast(percent_factor(v)?)))
    }),
    ("backdrop-grayscale", |_, v, _| {
        one(filter(true, 3, Filter::Grayscale(percent_factor(v)?)))
    }),
    ("backdrop-hue-rotate", |_, v, n| {
        one(filter(
            true,
            4,
            Filter::HueRotate(deg(if n { -degrees(v)? } else { degrees(v)? })),
        ))
    }),
    ("backdrop-invert", |_, v, _| {
        one(filter(true, 5, Filter::Invert(percent_factor(v)?)))
    }),
    ("backdrop-opacity", |_, v, _| {
        one(filter(true, 6, Filter::Opacity(opacity_factor(v)?)))
    }),
    ("backdrop-saturate", |_, v, _| {
        one(filter(true, 7, Filter::Saturate(percent_factor(v)?)))
    }),
    ("backdrop-sepia", |_, v, _| {
        one(filter(true, 8, Filter::Sepia(percent_factor(v)?)))
    }),
    ("blur", |t, v, _| blur(t, v, false)),
    ("brightness", |_, v, _| {
        one(filter(false, 1, Filter::Brightness(percent_factor(v)?)))
    }),
    ("contrast", |_, v, _| {
        one(filter(false, 2, Filter::Contrast(percent_factor(v)?)))
    }),
    ("grayscale", |_, v, _| {
        one(filter(false, 3, Filter::Grayscale(percent_factor(v)?)))
    }),
    ("hue-rotate", |_, v, n| {
        one(filter(
            false,
            4,
            Filter::HueRotate(deg(if n { -degrees(v)? } else { degrees(v)? })),
        ))
    }),
    ("invert", |_, v, _| {
        one(filter(false, 5, Filter::Invert(percent_factor(v)?)))
    }),
    ("saturate", |_, v, _| {
        one(filter(false, 6, Filter::Saturate(percent_factor(v)?)))
    }),
    ("sepia", |_, v, _| {
        one(filter(false, 7, Filter::Sepia(percent_factor(v)?)))
    }),
    ("drop-shadow", |t, v, _| {
        if v == "none" && !t.drop_shadows.contains_key("none") {
            return part(drop_shadows(&[]));
        }
        if let Some((layers, alpha)) = shadow_layers(&t.drop_shadows, v, false) {
            let mut d = vec![Decl::Part(drop_shadows(&layers))];
            d.extend(alpha.map(|a| Decl::Part(Part::DropShadowAlpha(a))));
            return Some(d);
        }
        if let Some(a) = current(v) {
            return one(Decl::CurrentPart(ColorSlot::DropShadow, a));
        }
        part(Part::DropShadowColor(color(t, v)?))
    }),
    // Transforms.
    ("translate-x", |t, v, n| {
        part(Part::TranslateX(translate(t, v, n)?))
    }),
    ("translate-y", |t, v, n| {
        part(Part::TranslateY(translate(t, v, n)?))
    }),
    ("translate", |t, v, n| {
        let l = translate(t, v, n)?;
        Some(vec![
            Decl::Part(Part::TranslateX(l)),
            Decl::Part(Part::TranslateY(l)),
        ])
    }),
    ("rotate-x", |_, v, n| {
        part(Part::RotateX(signed(degrees(v)?, n)))
    }),
    ("rotate-y", |_, v, n| {
        part(Part::RotateY(signed(degrees(v)?, n)))
    }),
    ("rotate-z", |_, v, n| {
        part(Part::RotateZ(signed(degrees(v)?, n)))
    }),
    ("rotate", |_, v, n| {
        part(Part::Rotate(signed(degrees(v)?, n)))
    }),
    ("scale-x", |_, v, n| {
        part(Part::ScaleX(signed(scale_factor(v)?, n)))
    }),
    ("scale-y", |_, v, n| {
        part(Part::ScaleY(signed(scale_factor(v)?, n)))
    }),
    ("scale", |_, v, n| {
        let s = signed(scale_factor(v)?, n);
        Some(vec![
            Decl::Part(Part::ScaleX(s)),
            Decl::Part(Part::ScaleY(s)),
        ])
    }),
    ("skew-x", |_, v, n| {
        part(Part::SkewX(signed(degrees(v)?, n)))
    }),
    ("skew-y", |_, v, n| {
        part(Part::SkewY(signed(degrees(v)?, n)))
    }),
    ("skew", |_, v, n| {
        let s = signed(degrees(v)?, n);
        Some(vec![Decl::Part(Part::SkewX(s)), Decl::Part(Part::SkewY(s))])
    }),
    ("perspective", |t, v, _| {
        let p = match (v, t.perspective.get(v)) {
            (_, Some(p)) => Some(*p),
            ("none", None) => None,
            _ => Some(class_length(t, &arbitrary(v)?)?),
        };
        part(Part::Perspective(p))
    }),
    ("origin", |_, v, _| {
        let o = match v {
            "center" => "center",
            "top" => "top",
            "top-right" => "top right",
            "right" => "right",
            "bottom-right" => "bottom right",
            "bottom" => "bottom",
            "bottom-left" => "bottom left",
            "left" => "left",
            "top-left" => "top left",
            v => return one(arb(K::TransformOrigin, &arbitrary(v)?)?),
        };
        one(sets(K::TransformOrigin, o))
    }),
    // Transitions.
    ("duration", |_, v, _| part(Part::Duration(millis(v)?))),
    ("delay", |_, v, _| part(Part::Delay(millis(v)?))),
    ("ease", |t, v, _| {
        let e = match t.ease.get(v) {
            Some(e) => *e,
            None => {
                let a = arbitrary(v)?;
                let args = a.strip_prefix("cubic-bezier(")?.strip_suffix(')')?;
                let n: Vec<f32> = args.split(',').filter_map(css::number).collect();
                let [a, b, c, d] = n.as_slice() else {
                    return None;
                };
                [*a, *b, *c, *d]
            }
        };
        part(Part::Ease(e))
    }),
    ("cursor", |_, v, _| {
        let name = arbitrary(v).unwrap_or_else(|| v.to_string());
        one(Decl::Set(
            K::Cursor,
            PropertyValue::Cursor(crate::effects::Cursor::parse(&name)?),
        ))
    }),
    // Images.
    ("object", |_, v, _| {
        let p = match v {
            "center" => "center",
            "top" => "top",
            "bottom" => "bottom",
            "left" => "left",
            "right" => "right",
            "top-left" | "left-top" => "left top",
            "top-right" | "right-top" => "right top",
            "bottom-left" | "left-bottom" => "left bottom",
            "bottom-right" | "right-bottom" => "right bottom",
            v => {
                let a = arbitrary(v)?;
                return one(Decl::Set(
                    K::ObjectPosition,
                    PropertyValue::ObjectPosition(css::object_position(&a)?),
                ));
            }
        };
        one(sets(K::ObjectPosition, p))
    }),
    ("tint", |t, v, _| one(setc(K::TintColor, color(t, v)?))),
];

/// Forms without a value: `shadow`, `ring`, `border`, `rounded`, ...
fn bare(theme: &Theme, u: &str, neg: bool) -> Option<Vec<Decl>> {
    if neg {
        return None;
    }
    Some(match u {
        "shadow" => return part(Part::Shadow(Arc::from(theme.shadows.get("")?.as_slice()))),
        "inset-shadow" => {
            return part(Part::InsetShadow(Arc::from(
                theme.inset_shadows.get("")?.as_slice(),
            )));
        }
        "drop-shadow" => return part(drop_shadows(theme.drop_shadows.get("")?)),
        "ring" => return part(Part::Ring(1.0)),
        "inset-ring" => return part(Part::InsetRing(1.0)),
        "border" => border_widths(&[K::BorderWidth], 1.0),
        "border-x" => border_widths(&[K::BorderLeftWidth, K::BorderRightWidth], 1.0),
        "border-y" => border_widths(&[K::BorderTopWidth, K::BorderBottomWidth], 1.0),
        "border-t" => border_widths(&[K::BorderTopWidth], 1.0),
        "border-r" => border_widths(&[K::BorderRightWidth], 1.0),
        "border-b" => border_widths(&[K::BorderBottomWidth], 1.0),
        "border-l" => border_widths(&[K::BorderLeftWidth], 1.0),
        "border-s" => border_widths(&[K::BorderStartWidth], 1.0),
        "border-e" => border_widths(&[K::BorderEndWidth], 1.0),
        "outline" => outline_width(1.0),
        "rounded" => return radius(theme, "sm", &[K::BorderRadius]),
        "rounded-t" | "rounded-r" | "rounded-b" | "rounded-l" | "rounded-tl" | "rounded-tr"
        | "rounded-br" | "rounded-bl" | "rounded-s" | "rounded-e" | "rounded-ss" | "rounded-se"
        | "rounded-ee" | "rounded-es" => {
            return parse(theme, &format!("{u}-sm"));
        }
        "blur" => return blur(theme, "", false),
        "backdrop-blur" => return blur(theme, "", true),
        "grow" => vec![setn(K::FlexGrow, 1.0)],
        "shrink" => vec![setn(K::FlexShrink, 1.0)],
        "transition" => return keyword("transition"),
        _ => return None,
    })
}

fn signed(v: f32, neg: bool) -> f32 {
    if neg { -v } else { v }
}

fn count(v: &str, neg: bool) -> Option<u16> {
    if neg {
        return None;
    }
    match arbitrary(v) {
        Some(a) => unhinted(&a).trim().parse().ok().filter(|&n| n > 0),
        None => int(v).map(|n| n as u16).filter(|&n| n > 0),
    }
}

fn line_index(v: &str, neg: bool) -> Option<taffy::GridPlacement<String>> {
    if v == "auto" {
        return (!neg).then_some(taffy::GridPlacement::Auto);
    }
    let n: i16 = match arbitrary(v) {
        Some(a) => match unhinted(&a).trim().parse() {
            Ok(n) => n,
            // A named line (`col-start-[content-start]`).
            Err(_) if !neg => return crate::grid::placement(unhinted(&a)),
            Err(_) => return None,
        },
        None => int(v)? as i16,
    };
    // CSS has no line 0.
    (n != 0).then(|| crate::grid::line_number(if neg { -n } else { n }))
}

fn grid_template(v: &str, neg: bool) -> Option<PropertyValue> {
    if neg {
        return None;
    }
    if let Some(n) = int(v) {
        return (n > 0.0)
            .then(|| PropertyValue::grid_template(crate::grid::equal_tracks(n as u16)));
    }
    let a = arbitrary(v)?;
    Some(PropertyValue::grid_template(crate::grid::template(
        track_list(&a)?,
    )?))
}

/// `auto-cols-[…]` / `auto-rows-[…]`: an invalid value is the style's to
/// log, and sets nothing, as a browser drops the declaration.
fn auto_tracks(key: StyleKey, v: &str, neg: bool) -> Option<Vec<Decl>> {
    let a = arbitrary(v).filter(|_| !neg)?;
    Some(
        track_list(&a)
            .and_then(|a| arb(key, a))
            .into_iter()
            .collect(),
    )
}

/// An arbitrary track list without its type hint; `None` when the hint
/// makes it a bare number, which CSS has no track size for (unlike a
/// bare number without a hint, NSH's length in points).
fn track_list(a: &str) -> Option<&str> {
    match hint(a) {
        (Some("number" | "integer"), _) => None,
        (_, a) => Some(a),
    }
}

/// An arbitrary value's type hint and the value without it (`[number:2]`
/// -> `2`), as Tailwind CSS writes the value into the declaration
/// whatever the hint.
fn hint(a: &str) -> (Option<&str>, &str) {
    match a.split_once(':') {
        Some((h, v)) if !h.is_empty() && h.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') => {
            (Some(h), v)
        }
        _ => (None, a),
    }
}

fn unhinted(a: &str) -> &str {
    hint(a).1
}

fn stop_position(v: &str) -> Option<f32> {
    if let Some(p) = v.strip_suffix('%') {
        return int(p).map(|p| p / 100.0);
    }
    let a = arbitrary(v)?;
    a.strip_suffix('%')
        .and_then(arbitrary_num)
        .map(|p| p / 100.0)
}

fn size(theme: &Theme, v: &str, key: StyleKey, width: bool) -> Option<Vec<Decl>> {
    if matches!(key, K::Width | K::Height) {
        let intrinsic = match v {
            "fit" => Some("fit-content"),
            "min" => Some("min-content"),
            "max" => Some("max-content"),
            _ => None,
        };
        if let Some(value) = intrinsic {
            return one(sets(key, value));
        }
    }
    // Window-relative: `w-screen` (`100vw`), `h-dvh`, `w-dvh`, `min-h-svh`...
    let screen = match v {
        "screen" if width => Some((1.0, 0.0)),
        "screen" => Some((0.0, 1.0)),
        "dvw" | "svw" | "lvw" => Some((1.0, 0.0)),
        "dvh" | "svh" | "lvh" => Some((0.0, 1.0)),
        _ => None,
    };
    if let Some((fw, fh)) = screen {
        return one(Decl::Screen(key, fw, fh));
    }
    if v == "none" && matches!(key, K::MaxWidth | K::MaxHeight) {
        return one(Decl::Set(key, PropertyValue::Default));
    }
    if matches!(key, K::MaxWidth | K::Width | K::MinWidth) {
        if let Some(w) = theme.containers.get(v) {
            return one(setn(key, *w));
        }
        // Tailwind's `--max-width-prose: 65ch`, of the node's font.
        if v == "prose" && key == K::MaxWidth {
            return one(Decl::Ch(key, 65.0));
        }
    }
    let auto = matches!(key, K::Width | K::Height | K::MinWidth | K::MinHeight);
    one(set(key, length_value(theme, v, false, auto)?))
}

fn radius(theme: &Theme, v: &str, keys: &[StyleKey]) -> Option<Vec<Decl>> {
    let r = match v {
        "none" => 0.0,
        "full" => 9999.0,
        v => match theme.radius.get(v) {
            Some(r) => *r,
            None => class_length(theme, &arbitrary(v)?)?,
        },
    };
    Some(keys.iter().map(|k| setn(*k, r)).collect())
}

fn border(theme: &Theme, v: &str, widths: &[StyleKey], colors: &[StyleKey]) -> Option<Vec<Decl>> {
    if let Some(a) = current(v) {
        return Some(
            colors
                .iter()
                .map(|&key| Decl::SetCurrentColor(key, a))
                .collect(),
        );
    }
    if let Some(n) = int(v) {
        return Some(border_widths(widths, n));
    }
    if let Some(a) = arbitrary(v)
        && let Some(w) = arbitrary_hinted(&a, "length")
            .and_then(|s| class_length(theme, s))
            .or_else(|| class_length(theme, &a))
    {
        return Some(border_widths(widths, w));
    }
    if let Some(mix) = mixes_current(v) {
        return colors.iter().map(|k| arb(*k, &mix)).collect();
    }
    let c = color(theme, v)?;
    Some(colors.iter().map(|k| setc(*k, c)).collect())
}

/// Border widths, in `currentColor` unless a color utility says otherwise
/// (preflight's `border: 0 solid`, whose color is `currentColor`).
fn border_widths(keys: &[StyleKey], width: f32) -> Vec<Decl> {
    let mut out: Vec<Decl> = keys.iter().map(|k| setn(*k, width)).collect();
    out.push(Decl::CurrentColor(K::BorderColor));
    out
}

fn blur(theme: &Theme, v: &str, backdrop: bool) -> Option<Vec<Decl>> {
    let r = match v {
        "none" => 0.0,
        v => match theme.blur.get(v) {
            Some(r) => *r,
            None => class_length(theme, &arbitrary(v)?)?,
        },
    };
    one(filter(backdrop, 0, Filter::Blur(px(r))))
}

fn translate(theme: &Theme, v: &str, neg: bool) -> Option<Len> {
    let sign = if neg { -1.0 } else { 1.0 };
    if v == "full" {
        return Some(Len::Fraction(sign));
    }
    if v.contains('/') && !v.starts_with('[') {
        return Some(Len::Fraction(sign * fraction(v)?));
    }
    match length_value(theme, v, neg, false)? {
        Length::Definite(DefiniteLength::Absolute(a)) => Some(Len::Points(a.to_points(REM_SIZE).0)),
        Length::Definite(DefiniteLength::Fraction(f)) => Some(Len::Fraction(f.0)),
        Length::Auto => None,
    }
}

/// `text-*`: sizes (with an optional line height, `text-sm/6`), colors,
/// arbitrary sizes or colors.
fn text(theme: &Theme, v: &str, _neg: bool) -> Option<Vec<Decl>> {
    let (base, line) = match v.split_once('/') {
        Some((b, l)) if theme.text.contains_key(b) || b.starts_with('[') && !b.contains('#') => {
            (b, Some(l))
        }
        _ => (v, None),
    };
    let line_height = || line_height(theme, line?);
    if let Some(&(size, multiple)) = theme.text.get(base) {
        let mut out = vec![setn(K::FontSize, size)];
        match line {
            Some(_) => out.push(line_height()?),
            // `line-height: var(--tw-leading, var(--text-lg--line-height))`:
            // any `leading-*` wins, wherever it is and whatever its variant.
            None => {
                if let Some(m) = multiple {
                    out.push(Decl::Default(
                        K::LineHeight,
                        PropertyValue::LineHeight(LineHeight::Multiple(m)),
                    ));
                }
            }
        }
        return Some(out);
    }
    if base.starts_with('[') {
        let a = arbitrary(base)?;
        if let Some(l) = arbitrary_hinted(&a, "length").and_then(|s| class_length(theme, s)) {
            return one(setn(K::FontSize, l));
        }
        if let Some(c) = arbitrary_hinted(&a, "color").and_then(css::color) {
            return one(setc(K::Color, c));
        }
        if let Some(l) = class_length(theme, &a) {
            let mut out = vec![setn(K::FontSize, l)];
            if line.is_some() {
                out.push(line_height()?);
            }
            return Some(out);
        }
    }
    one(setc(K::Color, color(theme, v)?))
}

/// A line height (`leading-*`, `text-sm/<line>`): a theme multiple
/// (`tight`), spacing steps (`6`, 24 points), or arbitrary: a number
/// without a unit, `em` or a percentage is a multiple of the font size
/// (`[1.5]`), a length is points (`[22px]`).
fn line_height(theme: &Theme, v: &str) -> Option<Decl> {
    if let Some(m) = theme.leading.get(v) {
        return Some(Decl::Set(
            K::LineHeight,
            PropertyValue::LineHeight(LineHeight::Multiple(*m)),
        ));
    }
    if let Some(a) = arbitrary(v) {
        let a = a.trim();
        if a.ends_with('%') || a.ends_with("em") && !a.ends_with("rem") {
            return arb(K::LineHeight, a);
        }
        let multiple = css::number(a);
        if let Some(m) = multiple.filter(|m| *m >= 0.0) {
            return Some(Decl::Set(
                K::LineHeight,
                PropertyValue::LineHeight(LineHeight::Multiple(m)),
            ));
        }
    }
    match length_value(theme, v, false, false)? {
        l @ Length::Definite(DefiniteLength::Absolute(_)) => Some(set(K::LineHeight, l)),
        _ => None,
    }
}

/// Tailwind's timing of `animate-*`.
fn preset(keyframes: Keyframes) -> KeyframeAnimation {
    match keyframes {
        Keyframes::Spin => KeyframeAnimation {
            keyframes,
            duration: 1000.0,
            delay: 0.0,
            easing: [0.0, 0.0, 1.0, 1.0],
            iterations: None,
        },
        Keyframes::Ping => KeyframeAnimation {
            keyframes,
            duration: 1000.0,
            delay: 0.0,
            easing: [0.0, 0.0, 0.2, 1.0],
            iterations: None,
        },
        Keyframes::Pulse => KeyframeAnimation {
            keyframes,
            duration: 2000.0,
            delay: 0.0,
            easing: [0.4, 0.0, 0.6, 1.0],
            iterations: None,
        },
        Keyframes::Bounce => KeyframeAnimation {
            keyframes,
            duration: 1000.0,
            delay: 0.0,
            easing: [0.8, 0.0, 1.0, 1.0],
            iterations: None,
        },
    }
}
