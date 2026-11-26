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

use nsh_core::{
    color::{Hsla, rgb},
    platform::ColorScheme,
};
use termina::{
    Event,
    escape::osc::{ColorOrQuery, DynamicColorNumber, Osc},
};

/// Terminals answer in order, so these replies precede those of the startup
/// probe, whose deadline the character UI waits for. A terminal that does not
/// know them stays silent and keeps NSH's bandless look.
pub(super) const QUERY: &[u8] = b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\";

/// The terminal's default foreground and background (OSC 10 and 11).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Colors {
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
}

impl Colors {
    pub fn observe(&mut self, event: &Event) {
        let Event::Osc(Osc::ChangeDynamicColors(number, colors)) = event else {
            return;
        };
        let [ColorOrQuery::Color(color)] = colors.as_slice() else {
            return;
        };
        let slot = match number {
            DynamicColorNumber::TextForegroundColor => &mut self.foreground,
            DynamicColorNumber::TextBackgroundColor => &mut self.background,
            _ => return,
        };
        *slot = Some([color.red, color.green, color.blue]);
    }

    /// Light when the background's relative luminance is above 0.4, as in
    /// NSH's own TUI host.
    pub fn scheme(self) -> Option<ColorScheme> {
        let [red, green, blue] = self.background?;
        let background = Hsla::from(rgb(u32::from_be_bytes([0, red, green, blue])));
        Some(if background.luminance() > 0.4 {
            ColorScheme::Light
        } else {
            ColorScheme::Dark
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(input: &[u8]) -> Colors {
        let mut parser = termina::Parser::default();
        parser.parse(input, false).unwrap();
        let mut colors = Colors::default();
        while let Some(event) = parser.pop() {
            colors.observe(&event);
        }
        colors
    }

    #[test]
    fn replies_report_the_default_foreground_and_background() {
        let colors = observe(
            b"\x1b]10;rgb:cccc/cccc/cccc\x1b\\\x1b]12;rgb:ffff/0000/0000\x07\x1b]11;rgb:0c/0c/0c\x07",
        );
        assert_eq!(
            colors,
            Colors {
                foreground: Some([0xcc; 3]),
                background: Some([0x0c; 3]),
            }
        );
        assert_eq!(colors.scheme(), Some(ColorScheme::Dark));
        let light = observe(b"\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
        assert_eq!(light.foreground, None);
        assert_eq!(light.scheme(), Some(ColorScheme::Light));
        assert_eq!(observe(b"\x1b[?62;4c").scheme(), None);
    }
}
