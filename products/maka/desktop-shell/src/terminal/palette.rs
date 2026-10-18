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

//! The colours a terminal paints with, as the script's theme gives them
//! (`palette(...)` on the element, from theme.js), and the minimum contrast
//! themed text is raised to.
//!
//! The contrast is APCA's lightness contrast (Lc, the APCA-W3 0.0.98G
//! constants), as maka-gpui's terminal measures it: unlike WCAG 2's ratio it
//! weighs light-on-dark and dark-on-light differently, which a palette with a
//! light and a dark mode needs. The threshold is Lc 45, Zed's terminal
//! default: it leaves the palette's own colours alone and raises only what
//! falls under it (faint text, a grey on a near grey). A colour is raised by
//! moving its lightness towards white or black, whichever side of its fill
//! has more room, by the least step that reaches the threshold, so it keeps
//! its hue and saturation.

use gpui_shell::gpui::{Hsla, Rgba};

/// The least lightness contrast (APCA Lc, either polarity) themed text gets.
pub(crate) const MINIMUM_CONTRAST: f32 = 45.;

/// What a terminal paints with besides its cells' own 24-bit colours.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct TerminalPalette {
    /// Black, red, green, yellow, blue, magenta, cyan and white, then their
    /// bright forms, in xterm's order.
    pub ansi: [Hsla; 16],
    /// The ink of cells with no colour of their own.
    pub foreground: Hsla,
    /// The fill behind cells with no colour of their own.
    pub background: Hsla,
    pub cursor: Hsla,
    /// Translucent, over the cells, so their ink still reads.
    pub selection: Hsla,
}

impl Default for TerminalPalette {
    /// xterm's colours on white, until the script gives the theme's.
    fn default() -> Self {
        let ansi = [
            "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
            "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
        ]
        .map(|hex| parse_color(hex).expect("a valid colour"));
        let black = ansi[0];
        Self {
            ansi,
            foreground: black,
            background: ansi[15],
            cursor: black,
            selection: Hsla {
                a: 0.3,
                ..parse_color("#3584e4").expect("a valid colour")
            },
        }
    }
}

impl TerminalPalette {
    /// The palette the script names: sixteen ANSI colours and the default
    /// ink, fill, cursor and selection, each `#rrggbb` or `#rrggbbaa`.
    pub(crate) fn parse(
        ansi: &[String],
        foreground: &str,
        background: &str,
        cursor: &str,
        selection: &str,
    ) -> Result<Self, String> {
        let colors = ansi
            .iter()
            .map(|color| parse_color(color))
            .collect::<Result<Vec<_>, _>>()?;
        let ansi: [Hsla; 16] = colors.try_into().map_err(|colors: Vec<Hsla>| {
            format!("expected 16 ANSI colours, got {}", colors.len())
        })?;
        Ok(Self {
            ansi,
            foreground: parse_color(foreground)?,
            background: parse_color(background)?,
            cursor: parse_color(cursor)?,
            selection: parse_color(selection)?,
        })
    }

    /// Colour `index` of xterm's 256: the sixteen named ones, then the
    /// 6×6×6 colour cube (16–231) and the 24 greys (232–255), whose values
    /// xterm's protocol fixes (they are data, not the theme's).
    pub(crate) fn indexed(&self, index: u8) -> Hsla {
        match index {
            0..=15 => self.ansi[usize::from(index)],
            16..=231 => {
                let cube = index - 16;
                let level = |step: u8| if step == 0 { 0 } else { 55 + 40 * step };
                opaque(level(cube / 36), level(cube / 6 % 6), level(cube % 6))
            }
            232..=255 => {
                let grey = 8 + 10 * (index - 232);
                opaque(grey, grey, grey)
            }
        }
    }
}

/// An opaque colour from 8-bit channels.
pub(crate) fn opaque(r: u8, g: u8, b: u8) -> Hsla {
    let channel = |value: u8| f32::from(value) / 255.;
    Rgba {
        r: channel(r),
        g: channel(g),
        b: channel(b),
        a: 1.,
    }
    .into()
}

/// `#rrggbb` or `#rrggbbaa`.
pub(crate) fn parse_color(text: &str) -> Result<Hsla, String> {
    let hex = text
        .strip_prefix('#')
        .filter(|hex| (hex.len() == 6 || hex.len() == 8) && hex.is_ascii())
        .ok_or_else(|| format!("`{text}` is not a #rrggbb or #rrggbbaa colour"))?;
    let byte = |at: usize| {
        u8::from_str_radix(&hex[at..at + 2], 16)
            .map_err(|_| format!("`{text}` is not a #rrggbb or #rrggbbaa colour"))
    };
    let alpha = if hex.len() == 8 { byte(6)? } else { 255 };
    Ok(Hsla {
        a: f32::from(alpha) / 255.,
        ..opaque(byte(0)?, byte(2)?, byte(4)?)
    })
}

/// The screen luminance APCA works from: each channel through a 2.4
/// exponent, weighted, with near-black soft-clamped.
fn luminance(color: Rgba) -> f32 {
    let channel = |value: f32| value.clamp(0., 1.).powf(2.4);
    let y = 0.212_672_9 * channel(color.r)
        + 0.715_152_2 * channel(color.g)
        + 0.072_175 * channel(color.b);
    const BLACK_THRESHOLD: f32 = 0.022;
    if y < BLACK_THRESHOLD {
        y + (BLACK_THRESHOLD - y).powf(1.414)
    } else {
        y
    }
}

/// APCA's lightness contrast of `text` on `background`, opaque both: about
/// 0 to 106 for dark text on a light fill, 0 to −108 for light on dark.
pub(crate) fn lightness_contrast(text: Hsla, background: Hsla) -> f32 {
    let text = luminance(text.to_rgb());
    let background = luminance(background.to_rgb());
    if (background - text).abs() < 0.0005 {
        return 0.;
    }
    const SCALE: f32 = 1.14;
    const LOW_CLIP: f32 = 0.1;
    const LOW_OFFSET: f32 = 0.027;
    let contrast = if background > text {
        let sapc = (background.powf(0.56) - text.powf(0.57)) * SCALE;
        if sapc < LOW_CLIP {
            0.
        } else {
            sapc - LOW_OFFSET
        }
    } else {
        let sapc = (background.powf(0.65) - text.powf(0.62)) * SCALE;
        if sapc > -LOW_CLIP {
            0.
        } else {
            sapc + LOW_OFFSET
        }
    };
    contrast * 100.
}

/// `text` raised, when it must be, to `minimum` lightness contrast on
/// `background`; `text` itself when it already has it.
pub(crate) fn ensure_contrast(text: Hsla, background: Hsla, minimum: f32) -> Hsla {
    if lightness_contrast(text, background).abs() >= minimum {
        return text;
    }
    let white = Hsla {
        h: 0.,
        s: 0.,
        l: 1.,
        a: 1.,
    };
    let black = Hsla {
        h: 0.,
        s: 0.,
        l: 0.,
        a: 1.,
    };
    let towards = if lightness_contrast(white, background).abs()
        > lightness_contrast(black, background).abs()
    {
        1.
    } else {
        0.
    };
    let at = |share: f32| Hsla {
        l: text.l + (towards - text.l) * share,
        a: 1.,
        ..text
    };
    let reaches = |share: f32| lightness_contrast(at(share), background).abs() >= minimum;
    if !reaches(1.) {
        return at(1.);
    }
    // The least share that reaches it, to within 1/1024.
    let (mut low, mut high) = (0f32, 1f32);
    for _ in 0..10 {
        let middle = (low + high) / 2.;
        if reaches(middle) {
            high = middle;
        } else {
            low = middle;
        }
    }
    at(high)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey(level: f32) -> Hsla {
        Rgba {
            r: level,
            g: level,
            b: level,
            a: 1.,
        }
        .into()
    }

    #[test]
    fn colours_parse_with_and_without_alpha() {
        let red = parse_color("#ff0000").unwrap().to_rgb();
        assert!((red.r - 1.).abs() < 1e-3 && red.g.abs() < 1e-3 && (red.a - 1.).abs() < 1e-3);
        let translucent = parse_color("#57A3EF4D").unwrap();
        assert!((translucent.a - 0x4d as f32 / 255.).abs() < 1e-3);
        assert!(parse_color("57a3ef").is_err());
        assert!(parse_color("#57a3e").is_err());
        assert!(parse_color("#zzzzzz").is_err());
        let sixteen = vec!["#000000".to_owned(); 16];
        assert!(
            TerminalPalette::parse(&sixteen, "#000000", "#ffffff", "#000000", "#00000080").is_ok()
        );
        assert!(
            TerminalPalette::parse(&sixteen[1..], "#000000", "#ffffff", "#000000", "#000000")
                .is_err()
        );
    }

    #[test]
    fn ink_that_reads_is_kept_and_ink_that_does_not_is_raised_away_from_its_fill() {
        let dark_fill = grey(0.12);
        let kept = grey(0.85);
        assert_eq!(ensure_contrast(kept, dark_fill, MINIMUM_CONTRAST), kept);
        let raised = ensure_contrast(grey(0.25), dark_fill, MINIMUM_CONTRAST);
        assert!(lightness_contrast(raised, dark_fill).abs() >= MINIMUM_CONTRAST);
        assert!(raised.l > grey(0.25).l, "lighter on a dark fill");
        let light_fill = grey(0.96);
        let raised = ensure_contrast(grey(0.8), light_fill, MINIMUM_CONTRAST);
        assert!(raised.l < grey(0.8).l, "darker on a light fill");
        assert!(lightness_contrast(raised, light_fill) >= MINIMUM_CONTRAST);
    }

    #[test]
    fn the_colour_cube_and_greys_are_xterms() {
        let palette = TerminalPalette::default();
        assert_eq!(palette.indexed(1), palette.ansi[1]);
        assert_eq!(palette.indexed(196), opaque(255, 0, 0));
        assert_eq!(palette.indexed(232), opaque(8, 8, 8));
        assert_eq!(palette.indexed(255), opaque(238, 238, 238));
    }
}
