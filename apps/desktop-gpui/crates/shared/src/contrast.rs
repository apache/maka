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

//! A minimum contrast for themed text on its fill: the terminal raises a
//! cell whose ink is the default foreground or one of the sixteen ANSI
//! colours (the palette's, not the program's) until it reads, and every
//! palette's syntax colours are chosen to read on the fills code sits on
//! (`crate::palette`, tested there).
//!
//! The measure is APCA's lightness contrast (Lc, the APCA-W3 0.0.98G
//! constants, written from the published formula): unlike WCAG 2's ratio it
//! weighs light-on-dark and dark-on-light differently, which is what a
//! palette with a light and a dark mode needs; WCAG 2's ratio passes
//! dark-on-dark pairs that read poorly. The threshold is Lc 45, as Zed's
//! terminal sets by default: APCA's floor for text of the terminal's size in
//! a dense view, which leaves every palette's own colours alone and raises
//! only what falls under it (faint text, a grey on a near grey). A colour is
//! raised by moving its lightness towards white or black, whichever side of
//! its fill has more room, by the least step that reaches the threshold, so
//! it keeps its hue and saturation.

use gpui_kit::{Hsla, Rgba};

/// The least lightness contrast (APCA Lc, either polarity) themed text gets.
pub const MINIMUM_CONTRAST: f32 = 45.;

/// The screen luminance APCA works from: each channel through a 2.4
/// exponent, weighted, with near-black soft-clamped.
fn luminance(color: Rgba) -> f32 {
    let channel = |value: f32| value.clamp(0., 1.).powf(2.4);
    let y = 0.212_672_9 * channel(color.r)
        + 0.715_152_2 * channel(color.g)
        + 0.072_175 * channel(color.b);
    const BLACK_THRESHOLD: f32 = 0.022;
    if y < BLACK_THRESHOLD { y + (BLACK_THRESHOLD - y).powf(1.414) } else { y }
}

/// APCA's lightness contrast of `text` on `background`, opaque both: about
/// 0 to 106 for dark text on a light fill, 0 to −108 for light on dark.
pub fn lightness_contrast(text: Hsla, background: Hsla) -> f32 {
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
        if sapc < LOW_CLIP { 0. } else { sapc - LOW_OFFSET }
    } else {
        let sapc = (background.powf(0.65) - text.powf(0.62)) * SCALE;
        if sapc > -LOW_CLIP { 0. } else { sapc + LOW_OFFSET }
    };
    contrast * 100.
}

/// `text` raised, when it must be, to `minimum` lightness contrast on
/// `background`; `text` itself when it already has it. Its lightness moves
/// towards white or black, whichever side of the fill has more room, by the
/// least step that reaches the minimum; its hue and saturation stay.
pub fn ensure_contrast(text: Hsla, background: Hsla, minimum: f32) -> Hsla {
    if lightness_contrast(text, background).abs() >= minimum {
        return text;
    }
    let white = Hsla { h: 0., s: 0., l: 1., a: 1. };
    let black = Hsla { h: 0., s: 0., l: 0., a: 1. };
    let towards = if lightness_contrast(white, background).abs()
        > lightness_contrast(black, background).abs()
    {
        1.
    } else {
        0.
    };
    let at = |share: f32| Hsla { l: text.l + (towards - text.l) * share, a: 1., ..text };
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
        Rgba { r: level, g: level, b: level, a: 1. }.into()
    }

    #[test]
    fn contrast_is_signed_by_polarity_and_zero_for_one_colour() {
        let (black, white) = (grey(0.), grey(1.));
        assert!((lightness_contrast(black, white) - 106.).abs() < 1., "dark on light");
        assert!((lightness_contrast(white, black) + 108.).abs() < 1., "light on dark");
        assert_eq!(lightness_contrast(grey(0.4), grey(0.4)), 0.);
    }

    #[test]
    fn ink_that_reads_is_kept_and_ink_that_does_not_is_raised_away_from_its_fill() {
        let dark_fill = grey(0.12);
        let kept = grey(0.85);
        assert_eq!(ensure_contrast(kept, dark_fill, MINIMUM_CONTRAST), kept);
        let raised = ensure_contrast(grey(0.25), dark_fill, MINIMUM_CONTRAST);
        assert!(lightness_contrast(raised, dark_fill).abs() >= MINIMUM_CONTRAST);
        assert!(raised.l > grey(0.25).l, "lighter on a dark fill");
        // By the least share: just over the minimum, not white.
        assert!(lightness_contrast(raised, dark_fill).abs() < MINIMUM_CONTRAST + 1.);
        let light_fill = grey(0.96);
        let raised = ensure_contrast(grey(0.8), light_fill, MINIMUM_CONTRAST);
        assert!(raised.l < grey(0.8).l, "darker on a light fill");
        assert!(lightness_contrast(raised, light_fill) >= MINIMUM_CONTRAST);
        // A hue keeps its hue.
        let red: Hsla = Rgba { r: 0.35, g: 0.1, b: 0.1, a: 1. }.into();
        let raised = ensure_contrast(red, dark_fill, MINIMUM_CONTRAST);
        assert!((raised.h - red.h).abs() < 0.01 && raised.s > 0.2, "{raised:?}");
    }
}
