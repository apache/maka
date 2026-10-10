/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Maka Desktop's palettes: the eleven `THEME_PALETTES` of
//! `$MAKA_REPO/packages/core/src/settings.ts`, each six base colours per
//! mode exactly as `apps/desktop/src/renderer/maka-tokens.css` writes them
//! (the `:root` block for the default, one `[data-maka-theme]` block for
//! each other palette), and the rules that derive every [`MakaPalette`]
//! role from them.
//!
//! Desktop derives its surfaces with oklch relative colour
//! (`oklch(from var(--background) calc(l - 0.025) c h)`) and `color-mix()`
//! in oklch. The rules below do the same arithmetic in the same space and
//! convert the result to sRGB the way Desktop's renderer (Chromium) paints
//! it: each channel clipped to the sRGB gamut, then stored in eight bits.
//! CSS Color 4's chroma-reducing gamut map would turn the default's
//! destructive `oklch(0.50 0.24 28)` into #C30000; the reviewed palette,
//! taken from Desktop, has the clipped #C90000.
//!
//! The default palette keeps the hand-tuned roles of [`MakaPalette::light`]
//! and [`MakaPalette::dark`], which the UI was reviewed with. The test
//! `the_default_is_desktops_but_for_the_reviewed_roles` names every role
//! where those depart from what Desktop's rules give.

use gpui_kit::{Hsla, rgba};

use crate::theme::{MakaPalette, SyntaxPalette, TerminalPalette};

/// One of Maka Desktop's palettes, named by the id Desktop stores in its
/// settings (`appearance.palette`) and selects with `[data-maka-theme]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ThemePalette {
    /// Maka's own palette, and the one an unknown id falls back to.
    #[default]
    Default,
    OneDark,
    CatppuccinMocha,
    TokyoNight,
    Nord,
    Coral,
    Azure,
    Forest,
    Dusk,
    Sand,
    Mono,
}

impl ThemePalette {
    /// Every palette, in Desktop's order (`THEME_PALETTES`).
    pub const ALL: [Self; 11] = [
        Self::Default,
        Self::OneDark,
        Self::CatppuccinMocha,
        Self::TokyoNight,
        Self::Nord,
        Self::Coral,
        Self::Azure,
        Self::Forest,
        Self::Dusk,
        Self::Sand,
        Self::Mono,
    ];

    /// The id Desktop stores, for example `"catppuccin-mocha"`.
    pub fn id(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::OneDark => "onedark",
            Self::CatppuccinMocha => "catppuccin-mocha",
            Self::TokyoNight => "tokyo-night",
            Self::Nord => "nord",
            Self::Coral => "coral",
            Self::Azure => "azure",
            Self::Forest => "forest",
            Self::Dusk => "dusk",
            Self::Sand => "sand",
            Self::Mono => "mono",
        }
    }

    /// The palette `id` names, or `None` for an id Desktop does not know
    /// (Desktop's `isThemePalette`; its settings read such an id as the
    /// default).
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|palette| palette.id() == id)
    }

    /// The palette's base colours, from its `maka-tokens.css` block.
    fn bases(self) -> Bases {
        match self {
            Self::Default => Bases {
                background: light_dark(oklch(1.000, 0., 0.), oklch(0.205, 0.004, 286.)),
                foreground: light_dark(oklch(0.17, 0.005, 286.), oklch(0.95, 0.004, 286.)),
                accent: light_dark(oklch(0.70, 0.135, 250.), oklch(0.74, 0.15, 250.)),
                success: light_dark(oklch(0.50, 0.17, 145.), oklch(0.60, 0.17, 145.)),
                destructive: light_dark(oklch(0.50, 0.24, 28.), oklch(0.70, 0.19, 22.)),
                // `--chat-user-bg`, which `--user-message-bubble` aliases here.
                bubble: light_dark(oklch(0.935, 0., 0.), oklch(0.30, 0.010, 250.)),
            },
            Self::OneDark => Bases {
                background: light_dark(oklch(0.95, 0.005, 250.), oklch(0.21, 0.010, 250.)),
                foreground: light_dark(oklch(0.30, 0.02, 250.), oklch(0.90, 0.010, 250.)),
                accent: light_dark(oklch(0.62, 0.13, 237.), oklch(0.70, 0.13, 237.)),
                success: light_dark(oklch(0.62, 0.16, 145.), oklch(0.65, 0.16, 145.)),
                destructive: light_dark(oklch(0.62, 0.20, 22.), oklch(0.70, 0.18, 22.)),
                bubble: light_dark(oklch(0.92, 0.012, 250.), oklch(0.30, 0.012, 250.)),
            },
            Self::CatppuccinMocha => Bases {
                background: light_dark(oklch(0.96, 0.008, 60.), oklch(0.22, 0.020, 290.)),
                foreground: light_dark(oklch(0.28, 0.02, 300.), oklch(0.92, 0.012, 320.)),
                accent: light_dark(oklch(0.65, 0.18, 330.), oklch(0.78, 0.16, 330.)),
                success: light_dark(oklch(0.62, 0.14, 145.), oklch(0.72, 0.14, 145.)),
                destructive: light_dark(oklch(0.62, 0.20, 25.), oklch(0.72, 0.18, 22.)),
                bubble: light_dark(oklch(0.94, 0.012, 60.), oklch(0.30, 0.020, 290.)),
            },
            Self::TokyoNight => Bases {
                background: light_dark(oklch(0.97, 0.005, 240.), oklch(0.18, 0.020, 250.)),
                foreground: light_dark(oklch(0.25, 0.015, 240.), oklch(0.90, 0.010, 240.)),
                accent: light_dark(oklch(0.55, 0.16, 215.), oklch(0.70, 0.18, 215.)),
                success: light_dark(oklch(0.62, 0.14, 145.), oklch(0.68, 0.16, 145.)),
                destructive: light_dark(oklch(0.62, 0.20, 22.), oklch(0.70, 0.19, 22.)),
                bubble: light_dark(oklch(0.93, 0.010, 240.), oklch(0.28, 0.018, 250.)),
            },
            Self::Nord => Bases {
                background: light_dark(oklch(0.97, 0.005, 220.), oklch(0.24, 0.012, 220.)),
                foreground: light_dark(oklch(0.28, 0.015, 220.), oklch(0.92, 0.008, 220.)),
                accent: light_dark(oklch(0.62, 0.12, 215.), oklch(0.72, 0.14, 215.)),
                success: light_dark(oklch(0.68, 0.12, 145.), oklch(0.72, 0.13, 145.)),
                destructive: light_dark(oklch(0.62, 0.16, 22.), oklch(0.72, 0.17, 22.)),
                bubble: light_dark(oklch(0.93, 0.008, 220.), oklch(0.32, 0.014, 220.)),
            },
            Self::Coral => Bases {
                background: light_dark(oklch(0.99, 0.005, 25.), oklch(0.22, 0.018, 25.)),
                foreground: light_dark(oklch(0.22, 0.015, 25.), oklch(0.94, 0.008, 25.)),
                accent: light_dark(oklch(0.68, 0.18, 25.), oklch(0.76, 0.18, 25.)),
                success: light_dark(oklch(0.68, 0.14, 145.), oklch(0.72, 0.13, 145.)),
                destructive: light_dark(oklch(0.60, 0.20, 18.), oklch(0.70, 0.20, 18.)),
                bubble: light_dark(oklch(0.95, 0.012, 25.), oklch(0.30, 0.020, 25.)),
            },
            Self::Azure => Bases {
                background: light_dark(oklch(0.98, 0.005, 250.), oklch(0.20, 0.015, 250.)),
                foreground: light_dark(oklch(0.20, 0.015, 250.), oklch(0.93, 0.010, 250.)),
                accent: light_dark(oklch(0.55, 0.12, 195.), oklch(0.72, 0.13, 195.)),
                success: light_dark(oklch(0.66, 0.15, 150.), oklch(0.72, 0.14, 150.)),
                destructive: light_dark(oklch(0.62, 0.18, 22.), oklch(0.72, 0.18, 22.)),
                bubble: light_dark(oklch(0.94, 0.010, 250.), oklch(0.28, 0.018, 250.)),
            },
            Self::Forest => Bases {
                background: light_dark(oklch(0.985, 0.006, 130.), oklch(0.21, 0.012, 145.)),
                foreground: light_dark(oklch(0.22, 0.018, 145.), oklch(0.93, 0.010, 130.)),
                accent: light_dark(oklch(0.50, 0.12, 152.), oklch(0.68, 0.14, 152.)),
                success: light_dark(oklch(0.62, 0.14, 145.), oklch(0.70, 0.14, 145.)),
                destructive: light_dark(oklch(0.58, 0.20, 22.), oklch(0.70, 0.20, 22.)),
                bubble: light_dark(oklch(0.94, 0.012, 130.), oklch(0.30, 0.014, 145.)),
            },
            Self::Dusk => Bases {
                background: light_dark(oklch(0.97, 0.008, 290.), oklch(0.20, 0.018, 295.)),
                foreground: light_dark(oklch(0.22, 0.018, 295.), oklch(0.92, 0.010, 290.)),
                accent: light_dark(oklch(0.55, 0.18, 305.), oklch(0.72, 0.18, 305.)),
                success: light_dark(oklch(0.64, 0.14, 145.), oklch(0.70, 0.14, 145.)),
                destructive: light_dark(oklch(0.60, 0.20, 18.), oklch(0.70, 0.20, 18.)),
                bubble: light_dark(oklch(0.93, 0.013, 290.), oklch(0.30, 0.020, 295.)),
            },
            Self::Sand => Bases {
                background: light_dark(oklch(0.98, 0.008, 75.), oklch(0.22, 0.014, 70.)),
                foreground: light_dark(oklch(0.22, 0.014, 70.), oklch(0.93, 0.010, 75.)),
                accent: light_dark(oklch(0.62, 0.14, 55.), oklch(0.72, 0.14, 55.)),
                success: light_dark(oklch(0.62, 0.14, 145.), oklch(0.70, 0.14, 145.)),
                destructive: light_dark(oklch(0.60, 0.20, 22.), oklch(0.70, 0.20, 22.)),
                bubble: light_dark(oklch(0.94, 0.012, 75.), oklch(0.30, 0.014, 70.)),
            },
            Self::Mono => Bases {
                background: light_dark(oklch(0.985, 0., 0.), oklch(0.18, 0., 0.)),
                foreground: light_dark(oklch(0.18, 0., 0.), oklch(0.95, 0., 0.)),
                accent: light_dark(oklch(0.30, 0., 0.), oklch(0.92, 0., 0.)),
                success: light_dark(oklch(0.55, 0., 0.), oklch(0.70, 0., 0.)),
                destructive: light_dark(oklch(0.45, 0.18, 22.), oklch(0.65, 0.18, 22.)),
                bubble: light_dark(oklch(0.93, 0., 0.), oklch(0.28, 0., 0.)),
            },
        }
    }
}

/// `--warning` from Desktop's `:root`. No palette sets it, so every palette
/// paints Maka's.
const WARNING: LightDark = light_dark(oklch(0.50, 0.18, 55.), oklch(0.66, 0.18, 55.));

/// The roles `palette` gives in one mode: the reviewed roles for the
/// default, Desktop's rules applied to the palette's base colours for the
/// others.
pub(crate) fn resolve(palette: ThemePalette, dark: bool) -> MakaPalette {
    let reviewed = if dark { MakaPalette::dark() } else { MakaPalette::light() };
    match palette {
        ThemePalette::Default => reviewed,
        palette => derive(&palette.bases(), dark, reviewed),
    }
}

/// Desktop's derivation (`:root` in maka-tokens.css) applied to `bases` in
/// one mode. Where the client has a role Desktop lacks, it takes the step
/// the reviewed default takes from the same base colour. Roles no Desktop
/// palette reaches (the ink on the primary fill, disabled ink, the
/// wordmark, the scrim, the find highlights) come from `invariant`, as a
/// `[data-maka-theme]` block inherits from `:root` every token it does not
/// set.
fn derive(bases: &Bases, dark: bool, invariant: MakaPalette) -> MakaPalette {
    let background = bases.background.pick(dark);
    let ink = bases.foreground.pick(dark);
    let accent = bases.accent.pick(dark);
    // `--surface-base`, which `--surface-canvas` aliases.
    let canvas = background.lighter(-0.025);
    // `--surface-sunken`.
    let sunken = background.lighter(if dark { -0.065 } else { -0.055 });
    MakaPalette {
        canvas: solid(canvas),
        // `--surface-raised`, the background itself.
        plate: solid(background),
        // `--surface-overlay`: the plate's fill in light (the floating recipe
        // tells it apart), a rung above it in dark.
        overlay: solid(if dark { background.lighter(0.018) } else { background }),
        // Client role: one tier below the overlay, the canvas in light and
        // the plate in dark.
        rail: solid(if dark { background } else { canvas }),
        sunken: solid(sunken),
        // `--user-message-bubble`.
        bubble: solid(bases.bubble.pick(dark)),
        // Client role (Desktop's code block is a fixed #FFFFFF / #111111 no
        // palette reaches): between canvas and sunken in light, the canvas
        // in dark.
        code: solid(if dark { canvas } else { background.lighter(-0.042) }),
        ink: solid(ink),
        // `--muted-foreground`: 68% ink mixed into the background.
        ink_muted: solid(ink.mix(background, 0.68)),
        // `--border`, `--border-soft`, `--border-strong`.
        border: translucent(ink, 0.10),
        border_soft: translucent(ink, 0.06),
        border_strong: translucent(ink, 0.16),
        // `--state-hover-bg`, `--state-selected-bg`, at the reviewed
        // default's strengths in every palette (Desktop: 4% and 6.5% in both
        // modes): a palette changes colours, not how strongly a row answers.
        hover: translucent(ink, if dark { 0.06 } else { 0.04 }),
        selected: translucent(ink, if dark { 0.09 } else { 0.06 }),
        // Client role: ink 8% (9% dark), as the default's menu rows.
        active_row: translucent(ink, if dark { 0.09 } else { 0.08 }),
        // `--foreground-alpha-6`.
        wash: translucent(ink, 0.06),
        // Client role: the plate stepped 0.055 towards the ink, which is the
        // sunken tier itself in light.
        chip: solid(if dark { background.lighter(0.055) } else { sunken }),
        // Client role: ink 8% (9% dark), as the default's badges.
        badge: translucent(ink, if dark { 0.09 } else { 0.08 }),
        // `--accent-solid`: the accent's hue and chroma at L 0.48 (0.76
        // dark), the one accent tier that carries text.
        primary: solid(accent.at_lightness(if dark { 0.76 } else { 0.48 })),
        accent: solid(accent),
        success: solid(bases.success.pick(dark)),
        warning: solid(WARNING.pick(dark)),
        destructive: solid(bases.destructive.pick(dark)),
        ..invariant
    }
}

/// The six hues a program names (red, green, yellow, blue, magenta, cyan),
/// as oklch hue and chroma: one set for every palette, so red means red
/// whatever the palette, at a lightness each mode picks.
const ANSI_HUES: [(f64, f64); 6] =
    [(27., 0.17), (145., 0.15), (85., 0.13), (255., 0.15), (325., 0.16), (200., 0.11)];

/// The lightness of the six hues and of their bright forms: dark enough to
/// read on the light `code` fill, light enough on the dark one. A bright
/// form moves away from the ink, as xterm's do.
const ANSI_LIGHTNESS: LightDark = light_dark(oklch(0.48, 0., 0.), oklch(0.74, 0., 0.));
const ANSI_BRIGHT_LIGHTNESS: LightDark = light_dark(oklch(0.56, 0., 0.), oklch(0.82, 0., 0.));

/// The terminal colours `palette` gives in one mode: the six hues at the
/// mode's lightness; black, white and their bright forms mixed from the
/// palette's ink and background, so they carry its tint and rise from the
/// ink towards the fill in light (where "white" must still read) and from
/// the fill towards the ink in dark; the default ink and fill are the
/// plate's ink and the `code` fill; the cursor is the ink; the selection is
/// the accent at 30%, which the ink reads through.
pub(crate) fn resolve_terminal(palette: ThemePalette, dark: bool) -> TerminalPalette {
    let roles = resolve(palette, dark);
    let bases = palette.bases();
    let ink = bases.foreground.pick(dark);
    let background = bases.background.pick(dark);
    let grey = |ink_share: f64| solid(ink.mix(background, ink_share));
    // Black, bright black, white, bright white.
    let [black, bright_black, white, bright_white] = if dark {
        [grey(0.25), grey(0.45), grey(0.8), roles.ink]
    } else {
        [roles.ink, grey(0.6), grey(0.48), grey(0.36)]
    };
    let hue = |(h, c): (f64, f64), lightness: LightDark| solid(oklch(lightness.pick(dark).l, c, h));
    let normal = ANSI_HUES.map(|each| hue(each, ANSI_LIGHTNESS));
    let bright = ANSI_HUES.map(|each| hue(each, ANSI_BRIGHT_LIGHTNESS));
    let mut ansi = [black; 16];
    ansi[1..7].copy_from_slice(&normal);
    ansi[7] = white;
    ansi[8] = bright_black;
    ansi[9..15].copy_from_slice(&bright);
    ansi[15] = bright_white;
    TerminalPalette {
        ansi,
        foreground: roles.ink,
        background: roles.code,
        cursor: roles.ink,
        selection: roles.accent.opacity(0.3),
    }
}

/// The hue and chroma (oklch) of each coloured syntax role: one set for
/// every palette, so a keyword looks like a keyword whatever the palette,
/// as a terminal's red stays red. Violet keywords, blue functions, teal
/// types, green strings, orange constants, red tags and properties, gold
/// attributes.
struct SyntaxHues {
    keyword: (f64, f64),
    function: (f64, f64),
    type_name: (f64, f64),
    string: (f64, f64),
    constant: (f64, f64),
    tag: (f64, f64),
    attribute: (f64, f64),
}

const SYNTAX_HUES: SyntaxHues = SyntaxHues {
    keyword: (305., 0.15),
    function: (255., 0.14),
    type_name: (195., 0.10),
    string: (145., 0.13),
    constant: (55., 0.14),
    tag: (25., 0.16),
    attribute: (85., 0.12),
};

/// The lightness of the coloured syntax roles: dark enough to read on the
/// light fills code sits on in every palette, light enough on the dark
/// ones (the test `syntax_colours_read_on_every_code_fill` holds them to
/// it).
const SYNTAX_LIGHTNESS: LightDark = light_dark(oklch(0.50, 0., 0.), oklch(0.76, 0., 0.));

/// How much ink a comment mixes into the palette's background, in light
/// and in dark: fainter than the muted ink (68%), and in dark, where the
/// same share reads fainter, a little more of it, which keeps every
/// palette's comments over [`crate::theme::COMMENT_MINIMUM_CONTRAST`].
const COMMENT_INK: [f64; 2] = [0.55, 0.62];

/// How much ink punctuation and operators mix into the background: a step
/// under the ink, so the names and literals between them lead.
const PUNCTUATION_INK: f64 = 0.75;

/// The syntax colours `palette` gives in one mode ([`SyntaxPalette`]): the
/// coloured roles at [`SYNTAX_HUES`] and [`SYNTAX_LIGHTNESS`]; variables in
/// the plate's ink; comments, punctuation and operators mixed from the
/// palette's ink and background, so they carry its tint.
pub(crate) fn resolve_syntax(palette: ThemePalette, dark: bool) -> SyntaxPalette {
    let roles = resolve(palette, dark);
    let bases = palette.bases();
    let ink = bases.foreground.pick(dark);
    let background = bases.background.pick(dark);
    let lightness = SYNTAX_LIGHTNESS.pick(dark).l;
    let hue = |(h, c): (f64, f64)| solid(oklch(lightness, c, h));
    let punctuation = solid(ink.mix(background, PUNCTUATION_INK));
    SyntaxPalette {
        keyword: hue(SYNTAX_HUES.keyword),
        function: hue(SYNTAX_HUES.function),
        type_name: hue(SYNTAX_HUES.type_name),
        string: hue(SYNTAX_HUES.string),
        constant: hue(SYNTAX_HUES.constant),
        comment: solid(ink.mix(background, COMMENT_INK[usize::from(dark)])),
        variable: roles.ink,
        property: hue(SYNTAX_HUES.tag),
        tag: hue(SYNTAX_HUES.tag),
        attribute: hue(SYNTAX_HUES.attribute),
        operator: punctuation,
        punctuation,
    }
}

/// The six colours a Desktop palette sets; every other role derives from
/// them.
#[derive(Debug, Clone, Copy)]
struct Bases {
    background: LightDark,
    foreground: LightDark,
    accent: LightDark,
    success: LightDark,
    destructive: LightDark,
    bubble: LightDark,
}

/// A colour per mode: CSS `light-dark(light, dark)`.
#[derive(Debug, Clone, Copy)]
struct LightDark {
    light: Oklch,
    dark: Oklch,
}

const fn light_dark(light: Oklch, dark: Oklch) -> LightDark {
    LightDark { light, dark }
}

impl LightDark {
    fn pick(self, dark: bool) -> Oklch {
        if dark { self.dark } else { self.light }
    }
}

/// A colour as Desktop's tokens write it: `oklch(l c h)`, hue in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Oklch {
    l: f64,
    c: f64,
    h: f64,
}

const fn oklch(l: f64, c: f64, h: f64) -> Oklch {
    Oklch { l, c, h }
}

impl Oklch {
    /// `oklch(from self calc(l + delta) c h)`, lightness clamped to 0..=1
    /// as CSS clamps it.
    fn lighter(self, delta: f64) -> Self {
        Self { l: (self.l + delta).clamp(0., 1.), ..self }
    }

    /// `oklch(from self l c h)` with a literal lightness: this hue and
    /// chroma at `l`.
    fn at_lightness(self, l: f64) -> Self {
        Self { l, ..self }
    }

    /// `color-mix(in oklch, self weight, other)`: every component
    /// interpolated, hue along the shorter arc. A hue written as 0 at zero
    /// chroma is interpolated like any other rather than taken from the
    /// other side, as Desktop's renderer does: that is what gives the
    /// #525153 Desktop measures for its default light muted ink.
    fn mix(self, other: Self, weight: f64) -> Self {
        let (mut from, mut to) = (self.h, other.h);
        if to - from > 180. {
            from += 360.;
        } else if from - to > 180. {
            to += 360.;
        }
        let blend = |a: f64, b: f64| a * weight + b * (1. - weight);
        Self {
            l: blend(self.l, other.l),
            c: blend(self.c, other.c),
            h: blend(from, to).rem_euclid(360.),
        }
    }

    /// The sRGB bytes Desktop paints for this colour: OKLab to linear sRGB
    /// (Björn Ottosson's matrices, which CSS Color 4 adopts), each channel
    /// clipped to the gamut, gamma-encoded and rounded to eight bits.
    fn srgb(self) -> [u8; 3] {
        let (sin, cos) = self.h.to_radians().sin_cos();
        let (a, b) = (self.c * cos, self.c * sin);
        let l = (self.l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
        let m = (self.l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
        let s = (self.l - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3);
        let linear = [
            4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
            -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
            -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s,
        ];
        linear.map(|channel| {
            let channel = channel.clamp(0., 1.);
            let encoded = if channel <= 0.003_130_8 {
                12.92 * channel
            } else {
                1.055 * channel.powf(1. / 2.4) - 0.055
            };
            byte(encoded)
        })
    }
}

/// A 0..=1 channel stored in eight bits.
fn byte(channel: f64) -> u8 {
    // In range by construction; the clamp makes the cast exact.
    (channel.clamp(0., 1.) * 255.).round() as u8
}

/// `color` as an opaque role.
fn solid(color: Oklch) -> Hsla {
    translucent(color, 1.)
}

/// `oklch(from color l c h / alpha)`, the alpha stored in eight bits as the
/// renderer stores it (0.10 is 0x1A).
fn translucent(color: Oklch, alpha: f64) -> Hsla {
    let [r, g, b] = color.srgb();
    rgba(u32::from_be_bytes([r, g, b, byte(alpha)])).into()
}

#[cfg(test)]
mod tests {
    use gpui_kit::{Rgba, rgb};

    use super::*;

    fn hex(color: Oklch) -> u32 {
        let [r, g, b] = color.srgb();
        u32::from_be_bytes([0, r, g, b])
    }

    #[test]
    fn oklch_converts_to_the_srgb_desktop_paints() {
        // The sRGB primaries and the ends of the lightness axis.
        assert_eq!(hex(oklch(0.62796, 0.25768, 29.2339)), 0xFF0000);
        assert_eq!(hex(oklch(0.86644, 0.29483, 142.4953)), 0x00FF00);
        assert_eq!(hex(oklch(0.45201, 0.31321, 264.052)), 0x0000FF);
        assert_eq!(hex(oklch(1., 0., 0.)), 0xFFFFFF);
        assert_eq!(hex(oklch(0., 0., 0.)), 0x000000);
        // In gamut, off the axes.
        assert_eq!(hex(oklch(0.5, 0.1, 180.)), 0x007565);
        assert_eq!(hex(oklch(0.7, 0.1, 40.)), 0xD4896E);
        // Out of gamut: clipped per channel, not chroma-reduced (#C30000,
        // #9F4500), as the reviewed destructive and warning are.
        assert_eq!(hex(oklch(0.50, 0.24, 28.)), 0xC90000);
        assert_eq!(hex(oklch(0.50, 0.18, 55.)), 0xAB3900);
        assert_eq!(hex(oklch(0.74, 0.15, 250.)), 0x58B0FF);
    }

    #[test]
    fn relative_colour_and_mixing_match_desktops_measurements() {
        let default = ThemePalette::Default.bases();
        // maka-tokens.css: 68% ink "measures #525153 / #a2a2a4".
        let muted = |dark: bool| {
            hex(default.foreground.pick(dark).mix(default.background.pick(dark), 0.68))
        };
        assert_eq!(muted(false), 0x525153);
        assert_eq!(muted(true), 0xA2A2A4);
        // maka-tokens.css: the dark overlay rung is "rgb 27,27,29".
        assert_eq!(hex(default.background.dark.lighter(0.018)), 0x1B1B1D);
        // The shorter arc across 0°, either way round.
        assert!((oklch(0.5, 0.1, 350.).mix(oklch(0.5, 0.1, 10.), 0.5).h - 0.).abs() < 1e-9);
        assert!((oklch(0.5, 0.1, 10.).mix(oklch(0.5, 0.1, 350.), 0.25).h - 355.).abs() < 1e-9);
        assert_eq!(translucent(oklch(0., 0., 0.), 0.10), rgba(0x0000001A).into());
    }

    /// Every role with its name, to compare palettes role by role.
    fn roles(palette: &MakaPalette) -> [(&'static str, Hsla); 29] {
        [
            ("canvas", palette.canvas),
            ("plate", palette.plate),
            ("overlay", palette.overlay),
            ("rail", palette.rail),
            ("sunken", palette.sunken),
            ("bubble", palette.bubble),
            ("code", palette.code),
            ("ink", palette.ink),
            ("ink_muted", palette.ink_muted),
            ("ink_disabled", palette.ink_disabled),
            ("border", palette.border),
            ("border_soft", palette.border_soft),
            ("border_strong", palette.border_strong),
            ("hover", palette.hover),
            ("selected", palette.selected),
            ("active_row", palette.active_row),
            ("wash", palette.wash),
            ("chip", palette.chip),
            ("badge", palette.badge),
            ("primary", palette.primary),
            ("on_primary", palette.on_primary),
            ("accent", palette.accent),
            ("brand", palette.brand),
            ("success", palette.success),
            ("warning", palette.warning),
            ("destructive", palette.destructive),
            ("scrim", palette.scrim),
            ("find_match", palette.find_match),
            ("find_match_active", palette.find_match_active),
        ]
    }

    /// The reviewed default, role by role, against Desktop's rules applied
    /// to Desktop's default base colours. Beyond the roles listed here,
    /// hover and selected take the reviewed strengths in every palette, and
    /// three reviewed values that no palette reaches differ from Desktop's
    /// fixed ones: disabled ink (#A3A3A3 against #919191 in light), the ink
    /// on the dark primary (#171717 against #111111) and the scrim (20% /
    /// 50% black against 50% / 80%).
    #[test]
    fn the_default_is_desktops_but_for_the_reviewed_roles() {
        for (dark, reviewed_departures) in [
            // Bubble #F2F2F3 (Desktop #E9E9E9), muted ink #525252 (#525153).
            (false, vec!["bubble", "ink_muted"]),
            // Overlay #1B1B1E (#1B1B1D), bubble #242427 (#2A2E33), muted
            // ink #A3A3A3 (#A2A2A4), chip #242427 (the rule's #242426).
            (true, vec!["overlay", "bubble", "ink_muted", "chip"]),
        ] {
            let reviewed = resolve(ThemePalette::Default, dark);
            let desktop = derive(&ThemePalette::Default.bases(), dark, reviewed);
            let departures: Vec<_> = roles(&reviewed)
                .into_iter()
                .zip(roles(&desktop))
                .filter(|((_, reviewed), (_, desktop))| reviewed != desktop)
                .map(|((name, _), _)| name)
                .collect();
            assert_eq!(departures, reviewed_departures, "dark: {dark}");
        }
    }

    /// WCAG 2 relative luminance of an opaque colour.
    fn luminance(color: Hsla) -> f32 {
        let Rgba { r, g, b, .. } = color.to_rgb();
        let linear = |channel: f32| {
            if channel <= 0.04045 { channel / 12.92 } else { ((channel + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    fn contrast(one: Hsla, other: Hsla) -> f32 {
        let (one, other) = (luminance(one), luminance(other));
        (one.max(other) + 0.05) / (one.min(other) + 0.05)
    }

    #[test]
    fn every_palette_gives_valid_roles_and_readable_ink_in_both_modes() {
        for palette in ThemePalette::ALL {
            for dark in [false, true] {
                let p = resolve(palette, dark);
                let name = format!("{} {}", palette.id(), if dark { "dark" } else { "light" });
                for (role, color) in roles(&p) {
                    // Through gpui's own conversion, which carries float noise
                    // (#FFFAFA reads as saturation 1.000003).
                    let Rgba { r, g, b, a } = color.to_rgb();
                    let valid =
                        [r, g, b, a].iter().all(|channel| (-1e-4..=1. + 1e-4).contains(channel));
                    assert!(valid, "{name}: {role} is {color:?}");
                    assert!(a > 0., "{name}: {role} is invisible");
                }
                // The surface ladder rises in lightness (DESIGN.md §2).
                assert!(luminance(p.sunken) < luminance(p.canvas), "{name}: sunken");
                assert!(luminance(p.canvas) < luminance(p.plate), "{name}: canvas");
                assert!(luminance(p.plate) <= luminance(p.overlay), "{name}: overlay");
                assert_ne!(p.ink, p.ink_muted, "{name}: two ink tiers");
                assert_ne!(p.bubble, p.plate, "{name}: bubble");
                assert!(contrast(p.ink, p.plate) >= 4.5, "{name}: ink on the plate");
                assert!(contrast(p.ink_muted, p.plate) >= 3., "{name}: muted ink on the plate");
                assert!(contrast(p.on_primary, p.primary) >= 4.5, "{name}: the send glyph");
            }
        }
    }

    /// The find highlights keep the text on them readable: ink on either
    /// fill, over the plate and over a code block, at 4.5:1 in every
    /// palette, and the active match differs from the others.
    #[test]
    fn find_highlights_keep_ink_readable_in_every_palette() {
        for palette in ThemePalette::ALL {
            for dark in [false, true] {
                let p = resolve(palette, dark);
                let name = format!("{} {}", palette.id(), if dark { "dark" } else { "light" });
                assert_ne!(p.find_match, p.find_match_active, "{name}");
                for (role, fill) in [("match", p.find_match), ("active", p.find_match_active)] {
                    for (surface_name, surface) in [("plate", p.plate), ("code", p.code)] {
                        let under = surface.blend(fill);
                        assert!(
                            contrast(p.ink, under) >= 4.5,
                            "{name}: ink on the {role} fill over the {surface_name}"
                        );
                    }
                }
            }
        }
    }

    /// What a program writes reads on the terminal's fill in every palette
    /// and mode: the default ink and the six hues at 4.5:1, their bright
    /// forms at 3:1, the grey a program writes text in ("white" in dark,
    /// "black" in light) at 4.5:1, and the ink through the selection.
    #[test]
    fn terminal_colours_read_on_the_code_fill_in_every_palette() {
        for palette in ThemePalette::ALL {
            for dark in [false, true] {
                let t = resolve_terminal(palette, dark);
                let name = format!("{} {}", palette.id(), if dark { "dark" } else { "light" });
                let on_fill = |color: Hsla| contrast(color, t.background);
                assert!(on_fill(t.foreground) >= 4.5, "{name}: the ink");
                for ix in 1..7 {
                    assert!(on_fill(t.ansi[ix]) >= 4.5, "{name}: colour {ix}");
                    assert!(on_fill(t.ansi[ix + 8]) >= 3., "{name}: bright colour {ix}");
                    for other in ix + 1..7 {
                        assert_ne!(t.ansi[ix], t.ansi[other], "{name}: {ix} and {other}");
                    }
                }
                let text_grey = if dark { t.ansi[7] } else { t.ansi[0] };
                assert!(on_fill(text_grey) >= 4.5, "{name}: the text grey");
                assert!(
                    contrast(t.foreground, t.background.blend(t.selection)) >= 4.5,
                    "{name}: the ink through the selection"
                );
                assert!(t.selection.a < 1., "{name}: the selection is translucent");
            }
        }
    }

    /// Every syntax colour, as gpui-kit's highlight theme holds it, reads on
    /// every fill code sits on, in every palette and mode: APCA Lc 45 for
    /// every role, Lc 35 for comments. The fills: `code` (the transcript's
    /// code blocks, the changes panel's and a tool card's diff box, the
    /// Files source view, the terminal), `sunken` (a Markdown code block
    /// outside the transcript, on the kit's muted fill), and a diff's added
    /// and removed rows (the kit's success and danger tint, 12%, over
    /// `code`). Not the kit's emphasis of the changed words inside a row
    /// (a further 30% of the tint), which gpui-kit fixes.
    #[test]
    fn syntax_colours_read_on_every_code_fill() {
        use gpui_kit::component::ThemeMode;

        use crate::contrast::{MINIMUM_CONTRAST, lightness_contrast};
        use crate::theme::{COMMENT_MINIMUM_CONTRAST, SYNTAX_NAMES, SyntaxRole, highlight_theme};

        let mut failures = Vec::new();
        let mut weakest = [(f32::MAX, String::new()), (f32::MAX, String::new())];
        for palette in ThemePalette::ALL {
            for (mode, dark) in [(ThemeMode::Light, false), (ThemeMode::Dark, true)] {
                let p = resolve(palette, dark);
                let theme = highlight_theme(palette, mode);
                let fills = [
                    ("code", p.code),
                    ("sunken", p.sunken),
                    ("added row", p.code.blend(p.success.opacity(0.12))),
                    ("removed row", p.code.blend(p.destructive.opacity(0.12))),
                ];
                for (name, role, _) in SYNTAX_NAMES {
                    let Some(color) = theme.style(name).and_then(|style| style.color) else {
                        continue;
                    };
                    let comment = role == Some(SyntaxRole::Comment);
                    let minimum = if comment { COMMENT_MINIMUM_CONTRAST } else { MINIMUM_CONTRAST };
                    for (fill_name, fill) in fills {
                        let lc = lightness_contrast(color, fill).abs();
                        let row = format!(
                            "{} {}: {name} on {fill_name}: Lc {lc:.1}",
                            palette.id(),
                            if dark { "dark" } else { "light" }
                        );
                        let slot = &mut weakest[usize::from(comment)];
                        if lc < slot.0 {
                            *slot = (lc, row.clone());
                        }
                        if lc < minimum {
                            failures.push(row);
                        }
                    }
                }
            }
        }
        assert!(failures.is_empty(), "under the minimum:\n{}", failures.join("\n"));
        println!("weakest role: {}\nweakest comment: {}", weakest[0].1, weakest[1].1);
    }

    /// The syntax roles stay apart: the seven hues differ from each other
    /// and from the ink, comments are fainter than the muted ink, and a
    /// palette's greys carry its own tint.
    #[test]
    fn syntax_roles_stay_apart_and_greys_follow_the_palette() {
        for dark in [false, true] {
            for palette in ThemePalette::ALL {
                let s = resolve_syntax(palette, dark);
                let p = resolve(palette, dark);
                let hues = [s.keyword, s.function, s.type_name, s.string, s.constant, s.tag];
                for (ix, one) in hues.iter().enumerate() {
                    assert_ne!(*one, s.variable);
                    for other in &hues[ix + 1..] {
                        assert_ne!(one, other, "{palette:?}");
                    }
                }
                assert_ne!(s.attribute, s.constant);
                assert_eq!(s.variable, p.ink);
                assert_eq!(s.property, s.tag, "fields share the tags' red");
                assert_ne!(s.comment, p.ink_muted);
            }
            let default = resolve_syntax(ThemePalette::Default, dark);
            let nord = resolve_syntax(ThemePalette::Nord, dark);
            assert_ne!(default.comment, nord.comment);
            assert_ne!(default.punctuation, nord.punctuation);
            assert_eq!(default.keyword, nord.keyword, "a hue keeps its meaning");
        }
    }

    #[test]
    fn the_256_colours_are_xterms_past_the_sixteen() {
        let t = resolve_terminal(ThemePalette::Default, false);
        let hex = |color: Hsla| {
            let Rgba { r, g, b, .. } = color.to_rgb();
            let byte = |channel: f32| (channel * 255.).round() as u32;
            (byte(r) << 16) | (byte(g) << 8) | byte(b)
        };
        assert_eq!(t.indexed(1), t.ansi[1]);
        assert_eq!(hex(t.indexed(16)), 0x000000);
        assert_eq!(hex(t.indexed(21)), 0x0000FF);
        assert_eq!(hex(t.indexed(196)), 0xFF0000);
        assert_eq!(hex(t.indexed(110)), 0x87AFD7);
        assert_eq!(hex(t.indexed(231)), 0xFFFFFF);
        assert_eq!(hex(t.indexed(232)), 0x080808);
        assert_eq!(hex(t.indexed(255)), 0xEEEEEE);
    }

    #[test]
    fn no_two_palettes_look_alike() {
        for dark in [false, true] {
            let looks: Vec<_> = ThemePalette::ALL
                .map(|palette| {
                    let p = resolve(palette, dark);
                    (palette, [p.plate, p.ink, p.accent, p.primary])
                })
                .into();
            for (index, (palette, look)) in looks.iter().enumerate() {
                for (other, other_look) in &looks[index + 1..] {
                    for (role, (one, two)) in look.iter().zip(other_look).enumerate() {
                        assert_ne!(one, two, "{palette:?} and {other:?} share role {role}");
                    }
                }
            }
        }
    }

    #[test]
    fn ids_are_desktops() {
        let ids = ThemePalette::ALL.map(ThemePalette::id);
        assert_eq!(
            ids,
            [
                "default",
                "onedark",
                "catppuccin-mocha",
                "tokyo-night",
                "nord",
                "coral",
                "azure",
                "forest",
                "dusk",
                "sand",
                "mono"
            ]
        );
        for palette in ThemePalette::ALL {
            assert_eq!(ThemePalette::from_id(palette.id()), Some(palette));
        }
        assert_eq!(ThemePalette::from_id("solarized"), None);
        assert_eq!(ThemePalette::default(), ThemePalette::Default);
    }

    #[test]
    fn a_palette_keeps_the_roles_desktop_never_repaints() {
        for dark in [false, true] {
            let default = resolve(ThemePalette::Default, dark);
            let nord = resolve(ThemePalette::Nord, dark);
            assert_eq!(nord.brand, rgb(0x71A8FD).into(), "the wordmark is Maka's");
            assert_eq!(nord.warning, default.warning, "no palette sets --warning");
            assert_eq!(nord.on_primary, default.on_primary);
            assert_eq!(nord.ink_disabled, default.ink_disabled);
            assert_eq!(nord.scrim, default.scrim);
            assert_ne!(nord.plate, default.plate);
        }
    }
}
