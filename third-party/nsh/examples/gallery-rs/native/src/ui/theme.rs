//! The gallery's look (as the TSX gallery's `ui.tsx`): a graphite page (or
//! a paper one in light appearance), cards with an inset surface, tabular
//! numbers and one citrus accent. Sizes are for phones: 16 pt gutters,
//! 44 pt touch targets, 15 pt body text.
//!
//! Colors are [`AdaptiveColor`]s, so the platform switches them with the
//! appearance natively, without a render; what needs one color (a canvas,
//! an animated value's interpolation, a header) takes `cx.color(..)`, which
//! reads the appearance in the render. Finishes ([`Finish`]) carry their
//! shadows for both appearances (`.dark(..)` variants: native too).

use nsh_core::{
    animation::{Curve, EaseMode},
    element::{
        AdaptiveColor, BoxShadow, Easing, Rgba, Spring, StyleRefinement, Styled, Timing,
        percentage, rgb, rgba,
    },
    geometry::px,
};

/// `#rrggbb` at opacity `alpha` (CSS's `rgba(r, g, b, alpha)`).
pub(crate) const fn rgb_a(hex: u32, alpha: f32) -> Rgba {
    rgba(hex << 8 | (alpha * 255.0 + 0.5) as u32)
}

/// A color for each appearance: `light`, `dark`.
const fn tone(light: Rgba, dark: Rgba) -> AdaptiveColor {
    AdaptiveColor {
        light: light.to_hsla(),
        dark: dark.to_hsla(),
    }
}

/// The roles of the palette (TS `colors`).
pub(crate) mod colors {
    use super::{AdaptiveColor, rgb, tone};

    /// The page behind the cards.
    pub(crate) const BACKGROUND: AdaptiveColor = tone(rgb(0xf4f4f2), rgb(0x101113));
    /// A card.
    pub(crate) const SURFACE: AdaptiveColor = tone(rgb(0xffffff), rgb(0x18191c));
    /// A surface inside a card.
    pub(crate) const INSET: AdaptiveColor = tone(rgb(0xf0f0ec), rgb(0x0c0d0f));
    /// A control on a card (buttons, fields, tracks).
    pub(crate) const RAISED: AdaptiveColor = tone(rgb(0xfbfbf9), rgb(0x24262a));
    /// Borders of cards and controls.
    pub(crate) const BORDER: AdaptiveColor = tone(rgb(0xd8d8d1), rgb(0x2c2e33));
    /// Hairlines inside insets.
    pub(crate) const LINE: AdaptiveColor = tone(rgb(0xe2e2dc), rgb(0x24262a));
    /// Text.
    pub(crate) const TEXT: AdaptiveColor = tone(rgb(0x16171a), rgb(0xeceef1));
    /// Secondary text.
    pub(crate) const MUTED: AdaptiveColor = tone(rgb(0x5f636a), rgb(0x8d9198));
    /// Quiet text: counts, notes, chevrons.
    pub(crate) const FAINT: AdaptiveColor = tone(rgb(0x9a9ea4), rgb(0x5a5e65));
    /// The accent as a foreground: text, icons, lines, small marks.
    pub(crate) const ACCENT: AdaptiveColor = tone(rgb(0x4f6e0c), rgb(0xc8f26d));
    /// The accent as a fill (buttons, bubbles), with [`ON_ACCENT`] on it.
    pub(crate) const ACCENT_FILL: AdaptiveColor = tone(rgb(0xc8f26d), rgb(0xc8f26d));
    /// Text on the accent fill.
    pub(crate) const ON_ACCENT: AdaptiveColor = tone(rgb(0x13160c), rgb(0x13160c));
    /// The main action's button: light on the dark page, dark on the light
    /// one.
    pub(crate) const LIGHT: AdaptiveColor = tone(rgb(0x16171a), rgb(0xeef0f2));
    /// Text on [`LIGHT`].
    pub(crate) const ON_LIGHT: AdaptiveColor = tone(rgb(0xffffff), rgb(0x111214));
    /// A switch's track when off.
    pub(crate) const TRACK: AdaptiveColor = tone(rgb(0xe2e2dd), rgb(0x24262a));
    /// A switch's knob when off.
    pub(crate) const KNOB: AdaptiveColor = tone(rgb(0xffffff), rgb(0x8d9198));
    /// Code inside insets.
    pub(crate) const CODE: AdaptiveColor = tone(rgb(0x2a2d33), rgb(0xd9dde3));
    /// Information.
    pub(crate) const INFO: AdaptiveColor = tone(rgb(0x3d63d1), rgb(0x7ea8ff));
    /// A warning.
    pub(crate) const WARN: AdaptiveColor = tone(rgb(0xb26a00), rgb(0xffb547));
    /// Danger.
    pub(crate) const DANGER: AdaptiveColor = tone(rgb(0xd43a4a), rgb(0xff6170));
    /// Rising figures.
    pub(crate) const UP: AdaptiveColor = tone(rgb(0x138a5a), rgb(0x45d49a));
    /// Falling figures.
    pub(crate) const DOWN: AdaptiveColor = tone(rgb(0xd43a4a), rgb(0xff6170));
}

/// Translucent tints of the tones, for fills behind text (TS `tints`).
pub(crate) mod tints {
    use super::{AdaptiveColor, rgb_a, tone};

    /// Of the accent.
    pub(crate) const ACCENT: AdaptiveColor = tone(rgb_a(0x7caa14, 0.14), rgb_a(0xc8f26d, 0.14));
    /// Of information.
    pub(crate) const INFO: AdaptiveColor = tone(rgb_a(0x3d63d1, 0.10), rgb_a(0x7ea8ff, 0.16));
    /// Of a warning.
    pub(crate) const WARN: AdaptiveColor = tone(rgb_a(0xb26a00, 0.11), rgb_a(0xffb547, 0.16));
    /// Of danger.
    pub(crate) const DANGER: AdaptiveColor = tone(rgb_a(0xd43a4a, 0.10), rgb_a(0xff6170, 0.16));
    /// Of rising figures.
    pub(crate) const UP: AdaptiveColor = tone(rgb_a(0x138a5a, 0.10), rgb_a(0x45d49a, 0.16));
    /// Of falling figures.
    pub(crate) const DOWN: AdaptiveColor = tone(rgb_a(0xd43a4a, 0.10), rgb_a(0xff6170, 0.16));
}

/// What a mark says: its color and its tint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, nsh_core::element::PropEnum)]
pub(crate) enum Tone {
    /// No meaning: muted.
    #[default]
    Neutral,
    /// The accent.
    Accent,
    /// Information.
    Info,
    /// A warning.
    Warn,
    /// Danger.
    Danger,
    /// Rising.
    Up,
    /// Falling.
    Down,
}

nsh_core::static_reactive!(Tone: Tone);

impl Tone {
    /// Its color (TS `toneColor`).
    pub(crate) const fn color(self) -> AdaptiveColor {
        match self {
            Tone::Neutral => colors::MUTED,
            Tone::Accent => colors::ACCENT,
            Tone::Info => colors::INFO,
            Tone::Warn => colors::WARN,
            Tone::Danger => colors::DANGER,
            Tone::Up => colors::UP,
            Tone::Down => colors::DOWN,
        }
    }

    /// Its tint (TS `toneTint`).
    pub(crate) const fn tint(self) -> AdaptiveColor {
        match self {
            Tone::Neutral => colors::RAISED,
            Tone::Accent => tints::ACCENT,
            Tone::Info => tints::INFO,
            Tone::Warn => tints::WARN,
            Tone::Danger => tints::DANGER,
            Tone::Up => tints::UP,
            Tone::Down => tints::DOWN,
        }
    }
}

/// The monospaced family, for code (API names, identifiers). Figures use
/// the system font with tabular numbers instead.
pub(crate) const MONO: &str = "monospace";

/// Corner radii.
pub(crate) mod radius {
    /// A card.
    pub(crate) const CARD: f32 = 16.0;
    /// An inset inside a card.
    pub(crate) const INSET: f32 = 12.0;
    /// A control (buttons, fields).
    pub(crate) const CONTROL: f32 = 10.0;
}

/// The motion every control shares: quick, slightly springy.
pub(crate) mod motion {
    use super::{Curve, EaseMode, Easing, Spring, Timing};

    /// Sinking under the finger and back.
    pub(crate) const PRESS: Spring = Spring {
        stiffness: 520.0,
        damping: 34.0,
        mass: 1.0,
        velocity: None,
    };
    /// Knobs and indicators settling at their place.
    pub(crate) const SETTLE: Spring = Spring {
        stiffness: 320.0,
        damping: 30.0,
        mass: 1.0,
        velocity: None,
    };
    /// Content coming in.
    pub(crate) const ENTER: Timing = Timing::new(420.0, Easing::Curve(Curve::Cubic, EaseMode::Out));
}

/// A box shadow outside the box.
const fn drop(y: f32, blur: f32, color: Rgba) -> BoxShadow {
    BoxShadow {
        offset_x: px(0.0),
        offset_y: px(y),
        blur: px(blur),
        spread: px(0.0),
        color: color.to_packed(),
        inset: false,
    }
}

/// A box shadow under the box, pulled in by `spread` (negative): it lifts the
/// surface without hazing around its edge.
const fn lift(y: f32, blur: f32, spread: f32, color: Rgba) -> BoxShadow {
    BoxShadow {
        offset_x: px(0.0),
        offset_y: px(y),
        blur: px(blur),
        spread: px(spread),
        color: color.to_packed(),
        inset: false,
    }
}

/// A box shadow inside the box (`spread`: a rim all around).
const fn inner(y: f32, blur: f32, spread: f32, color: Rgba) -> BoxShadow {
    BoxShadow {
        offset_x: px(0.0),
        offset_y: px(y),
        blur: px(blur),
        spread: px(spread),
        color: color.to_packed(),
        inset: true,
    }
}

const WHITE: u32 = 0xffffff;
const BLACK: u32 = 0x000000;
/// The light theme's shadows: a warm black.
const INK: u32 = 0x14140a;

/// A surface's finish (TS `finish`): a gradient over its color, its
/// shadows, a rim, a blur behind it. Light and depth: gentle top-to-bottom
/// gradients, a highlight along top edges and soft shadows, so cards,
/// controls and buttons read as surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Finish {
    /// A card.
    Card,
    /// A surface sunk into a card.
    Inset,
    /// A control on a card.
    Raised,
    /// The main action's button ([`colors::LIGHT`]).
    Light,
    /// A citrus button.
    Accent,
    /// A switch's or a slider's track.
    Track,
    /// A knob or handle over a track.
    Knob,
    /// Lit glass: a pill that floats over a track (the selected segment, a
    /// small round button), a specular top, a faint inner edge, a lower rim.
    Pill,
    /// A tinted capsule's rim and highlight (badges).
    Chip,
    /// A bar floating over content: translucent, blurred, rimmed.
    Glass,
    /// A floating panel (menus, the composer): glass, denser for reading.
    Menu,
}

/// What a [`Finish`] sets.
struct Look {
    /// The background color under the gradient.
    fill: Option<AdaptiveColor>,
    /// The gradient's stops, top to bottom (2 or 3), at fractions of the
    /// height.
    stops: &'static [(AdaptiveColor, f32)],
    /// The shadows in light appearance.
    light: &'static [BoxShadow],
    /// The shadows in dark appearance.
    dark: &'static [BoxShadow],
    /// The rim's color (the caller sets its width).
    border: Option<AdaptiveColor>,
    /// The blur behind it.
    backdrop_blur: f32,
}

const fn stop(light: Rgba, dark: Rgba, at: f32) -> (AdaptiveColor, f32) {
    (tone(light, dark), at)
}

const CARD: Look = Look {
    fill: None,
    stops: &[
        stop(rgb(0xffffff), rgb(0x1b1c20), 0.0),
        stop(rgb(0xfdfdfc), rgb(0x191a1d), 1.0),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb(WHITE)),
        drop(1.0, 1.0, rgb_a(INK, 0.04)),
        lift(14.0, 32.0, -18.0, rgb_a(INK, 0.2)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.04)),
        lift(16.0, 36.0, -20.0, rgb_a(BLACK, 0.75)),
    ],
    border: None,
    backdrop_blur: 0.0,
};

const INSET: Look = Look {
    fill: None,
    stops: &[],
    light: &[inner(1.0, 2.0, 0.0, rgb_a(INK, 0.07))],
    dark: &[inner(1.0, 3.0, 0.0, rgb_a(BLACK, 0.55))],
    border: None,
    backdrop_blur: 0.0,
};

const RAISED: Look = Look {
    fill: None,
    stops: &[
        stop(rgb(0xffffff), rgb(0x2b2d32), 0.0),
        stop(rgb(0xf6f6f2), rgb(0x24262a), 1.0),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb(WHITE)),
        drop(1.0, 1.0, rgb_a(INK, 0.06)),
        lift(5.0, 12.0, -6.0, rgb_a(INK, 0.18)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.07)),
        drop(1.0, 1.0, rgb_a(BLACK, 0.4)),
        lift(6.0, 14.0, -7.0, rgb_a(BLACK, 0.7)),
    ],
    border: None,
    backdrop_blur: 0.0,
};

const LIGHT: Look = Look {
    fill: None,
    stops: &[
        stop(rgb(0x2e3035), rgb(0xfbfbfc), 0.0),
        stop(rgb(0x1b1c20), rgb(0xe3e5e8), 1.0),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.16)),
        drop(1.0, 1.0, rgb_a(INK, 0.2)),
        lift(7.0, 14.0, -7.0, rgb_a(INK, 0.5)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb(WHITE)),
        drop(1.0, 1.0, rgb_a(BLACK, 0.4)),
        lift(8.0, 18.0, -8.0, rgb_a(BLACK, 0.75)),
    ],
    border: None,
    backdrop_blur: 0.0,
};

const ACCENT: Look = Look {
    fill: None,
    stops: &[
        stop(rgb(0xd6f78a), rgb(0xd6f78a), 0.0),
        stop(rgb(0xc1ea5c), rgb(0xc1ea5c), 1.0),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.6)),
        drop(1.0, 1.0, rgb_a(0x506e0a, 0.2)),
        lift(7.0, 14.0, -7.0, rgb_a(0x6e9614, 0.55)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.55)),
        drop(1.0, 1.0, rgb_a(BLACK, 0.4)),
        lift(8.0, 20.0, -9.0, rgb_a(0xc8f26d, 0.4)),
    ],
    border: None,
    backdrop_blur: 0.0,
};

const TRACK: Look = Look {
    fill: None,
    stops: &[],
    light: &[inner(1.0, 2.0, 0.0, rgb_a(INK, 0.08))],
    dark: &[inner(1.0, 2.0, 0.0, rgb_a(BLACK, 0.5))],
    border: None,
    backdrop_blur: 0.0,
};

const KNOB: Look = Look {
    fill: None,
    stops: &[],
    light: &[
        inner(1.0, 0.0, 0.0, rgb(WHITE)),
        drop(1.0, 4.0, rgb_a(INK, 0.28)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.35)),
        drop(2.0, 6.0, rgb_a(BLACK, 0.45)),
    ],
    border: None,
    backdrop_blur: 0.0,
};

const PILL: Look = Look {
    fill: Some(tone(rgb(0xffffff), rgb(0x2b2d32))),
    stops: &[
        stop(rgb(0xffffff), rgb(0x2f3136), 0.0),
        stop(rgb(0xf6f6f2), rgb(0x2a2c30), 1.0),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb(WHITE)),
        drop(1.0, 1.0, rgb_a(INK, 0.06)),
        lift(5.0, 12.0, -6.0, rgb_a(INK, 0.18)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.08)),
        drop(1.0, 1.0, rgb_a(BLACK, 0.4)),
        lift(6.0, 14.0, -7.0, rgb_a(BLACK, 0.7)),
    ],
    border: Some(tone(rgb_a(INK, 0.14), rgb_a(WHITE, 0.08))),
    backdrop_blur: 0.0,
};

const CHIP: Look = Look {
    fill: None,
    stops: &[],
    light: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.65)),
        inner(-1.0, 0.0, 0.0, rgb_a(INK, 0.04)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.07)),
        inner(-1.0, 0.0, 0.0, rgb_a(BLACK, 0.18)),
    ],
    border: None,
    backdrop_blur: 0.0,
};

const GLASS: Look = Look {
    fill: Some(tone(rgb_a(0xfafaf8, 0.66), rgb_a(0x16171a, 0.62))),
    stops: &[
        stop(rgb_a(WHITE, 0.7), rgb_a(WHITE, 0.06), 0.0),
        stop(rgb_a(WHITE, 0.0), rgb_a(WHITE, 0.0), 0.6),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.9)),
        drop(-6.0, 20.0, rgb_a(INK, 0.06)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.09)),
        drop(-8.0, 24.0, rgb_a(BLACK, 0.28)),
    ],
    border: Some(tone(rgb_a(INK, 0.07), rgb_a(WHITE, 0.07))),
    backdrop_blur: 20.0,
};

const MENU: Look = Look {
    fill: Some(tone(rgb_a(WHITE, 0.84), rgb_a(0x1e2024, 0.82))),
    stops: &[
        stop(rgb_a(WHITE, 0.8), rgb_a(WHITE, 0.07), 0.0),
        stop(rgb_a(WHITE, 0.2), rgb_a(WHITE, 0.015), 0.4),
        stop(rgb_a(WHITE, 0.0), rgb_a(WHITE, 0.0), 1.0),
    ],
    light: &[
        inner(1.0, 0.0, 0.0, rgb(WHITE)),
        inner(-1.0, 0.0, 0.0, rgb_a(INK, 0.05)),
        drop(12.0, 32.0, rgb_a(INK, 0.12)),
    ],
    dark: &[
        inner(1.0, 0.0, 0.0, rgb_a(WHITE, 0.11)),
        inner(-1.0, 0.0, 0.0, rgb_a(BLACK, 0.25)),
        drop(12.0, 32.0, rgb_a(BLACK, 0.42)),
    ],
    border: Some(tone(rgb_a(INK, 0.08), rgb_a(WHITE, 0.08))),
    backdrop_blur: 24.0,
};

impl Finish {
    fn look(self) -> &'static Look {
        match self {
            Finish::Card => &CARD,
            Finish::Inset => &INSET,
            Finish::Raised => &RAISED,
            Finish::Light => &LIGHT,
            Finish::Accent => &ACCENT,
            Finish::Track => &TRACK,
            Finish::Knob => &KNOB,
            Finish::Pill => &PILL,
            Finish::Chip => &CHIP,
            Finish::Glass => &GLASS,
            Finish::Menu => &MENU,
        }
    }

    /// Its shadows in light and in dark appearance (to add layers of one's
    /// own: [`Finished::adaptive_shadow`]).
    pub(crate) fn shadows(self) -> (&'static [BoxShadow], &'static [BoxShadow]) {
        let look = self.look();
        (look.light, look.dark)
    }

    /// Its rim's color, for the finishes that have one (pill, glass, menu).
    pub(crate) fn border_color(self) -> Option<AdaptiveColor> {
        self.look().border
    }
}

/// Styling with the gallery's [`Finish`]es; every [`Styled`] element has it.
pub(crate) trait Finished: Styled + Sized {
    /// The whole finish: its color and gradient, shadows, rim color and
    /// backdrop blur (TS `...finish.card`).
    fn finish(self, finish: Finish) -> Self {
        let look = finish.look();
        let mut this = self.finish_fill(finish).finish_shadow(finish);
        if let Some(border) = look.border {
            this = this.border_color(border);
        }
        if look.backdrop_blur > 0.0 {
            this = this.backdrop_blur(look.backdrop_blur);
        }
        this
    }

    /// Its background color and gradient only (TS
    /// `finish.card.backgroundImage`).
    fn finish_fill(self, finish: Finish) -> Self {
        let look = finish.look();
        let mut this = self;
        if let Some(fill) = look.fill {
            this = this.bg(fill);
        }
        match look.stops {
            [(from, from_at), rest @ ..] if !rest.is_empty() => {
                this = this
                    .bg_linear_to_b()
                    .gradient_from(*from)
                    .gradient_from_position(percentage(*from_at));
                if let [(via, via_at), _] = rest {
                    this = this
                        .gradient_via(*via)
                        .gradient_via_position(percentage(*via_at));
                }
                let (to, to_at) = rest[rest.len() - 1];
                this.gradient_to(to).gradient_to_position(percentage(to_at))
            }
            _ => this,
        }
    }

    /// Its shadows only (TS `finish.card.boxShadow`).
    fn finish_shadow(self, finish: Finish) -> Self {
        let (light, dark) = finish.shadows();
        self.adaptive_shadow(light.iter().copied(), dark.iter().copied())
    }

    /// Box shadows for each appearance.
    fn adaptive_shadow(
        self,
        light: impl IntoIterator<Item = BoxShadow>,
        dark: impl IntoIterator<Item = BoxShadow>,
    ) -> Self {
        let dark: Vec<BoxShadow> = dark.into_iter().collect();
        self.shadow(light)
            .dark(move |s: StyleRefinement| s.shadow(dark))
    }
}

impl<T: Styled + Sized> Finished for T {}

/// A shadow layer inside the box, for [`Finished::adaptive_shadow`].
pub(crate) const fn inset_shadow(y: f32, blur: f32, color: Rgba) -> BoxShadow {
    inner(y, blur, 0.0, color)
}
