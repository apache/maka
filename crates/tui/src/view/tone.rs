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

//! Shared semantic colors; no process-global theme or terminal-cell recoloring.
use crate::theme::Palette;
use ratatui::style::{Color, Style};
pub fn accent(colors: Palette) -> Color {
    colors.accent
}
pub fn thinking(colors: Palette) -> Color {
    colors.thinking
}
pub fn selection(colors: Palette) -> Style {
    colors.focused()
}
/// Stable identity hue index for a session ID (FNV-1a), never its position.
pub fn session_hue(id: &str) -> u8 {
    let hash = id.bytes().fold(0xcbf29ce484222325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    (hash % 6) as u8
}
pub fn hue(index: u8, colors: Palette) -> Color {
    if colors.terminal {
        return colors.foreground;
    }
    let variants = [
        colors.accent,
        colors.thinking,
        colors.success,
        colors.warning,
        colors.syntax[5],
        colors.syntax[0],
    ];
    variants[usize::from(index) % variants.len()]
}
pub fn border(colors: Palette, focused: bool, breath: Option<f32>) -> Color {
    colors.breath(focused, breath)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Choice;
    #[test]
    fn working_border_has_visible_blue_breath_without_flashing_or_changing_terminal_palette() {
        let palette = Choice::Maka.colors();
        let Color::Rgb(r, g, b) = border(palette, true, Some(0.0)) else {
            panic!("RGB");
        };
        assert!(b > g && g > r && b >= 100);
        assert_eq!(border(palette, true, Some(1.0)), palette.accent);
        assert!(253 - b >= 100);
        let terminal = Choice::Terminal.colors();
        assert_eq!(
            border(terminal, true, Some(0.0)),
            border(terminal, true, Some(1.0))
        );
    }
}
