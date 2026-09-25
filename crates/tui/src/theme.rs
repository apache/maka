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

use ratatui::style::{Color, Modifier, Style};
use serde::{Deserialize, Serialize};

mod custom;
pub mod editor;
mod runtime;
pub use runtime::Theme;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Choice {
    #[default]
    Maka,
    Dusk,
    Paper,
    Terminal,
    Custom,
}
impl Choice {
    pub fn next(self) -> Self {
        match self {
            Self::Maka => Self::Dusk,
            Self::Dusk => Self::Paper,
            Self::Paper => Self::Terminal,
            Self::Terminal | Self::Custom => Self::Maka,
        }
    }
    pub fn colors(self) -> Palette {
        match self {
            Self::Maka | Self::Custom => Palette::default(),
            Self::Dusk => Palette {
                background: rgb(0x17191c),
                foreground: rgb(0xd9dde3),
                surface: rgb(0x22262c),
                accent: rgb(0x9bbbcf),
                thinking: rgb(0xb4abc8),
                success: rgb(0x9fc5af),
                warning: rgb(0xd4ba8b),
                error: rgb(0xddaaa7),
                muted: rgb(0x939eac),
                subtle: rgb(0x7e8999),
                border: rgb(0x3b4551),
                scrollbar: rgb(0x748397),
                selection: rgb(0x354659),
                selection_text: rgb(0xf4f6fa),
                search: rgb(0x494130),
                search_active: rgb(0xd4ba8b),
                search_text: rgb(0x17191c),
                syntax: [
                    rgb(0xc1afd7),
                    rgb(0xabc7b1),
                    rgb(0x929dac),
                    rgb(0xd4ba8b),
                    rgb(0xa3bfd8),
                    rgb(0x9bc6c8),
                    rgb(0xc6cbd3),
                ],
                terminal: false,
            },
            Self::Paper => Palette {
                background: rgb(0xf7f8fc),
                foreground: rgb(0x273347),
                surface: rgb(0xe9edf5),
                accent: rgb(0x205fc1),
                thinking: rgb(0x70589b),
                success: rgb(0x21714f),
                warning: rgb(0x8c5c13),
                error: rgb(0xb33e48),
                muted: rgb(0x5b687c),
                subtle: rgb(0x647186),
                border: rgb(0xc5cddd),
                scrollbar: rgb(0x8694aa),
                selection: rgb(0xd2e2ff),
                selection_text: rgb(0x163e7c),
                search: rgb(0xf3e5bb),
                search_active: rgb(0x815600),
                search_text: rgb(0xffffff),
                syntax: [
                    rgb(0x804caf),
                    rgb(0x246c48),
                    rgb(0x5e6c82),
                    rgb(0x985812),
                    rgb(0x205fc1),
                    rgb(0x147078),
                    rgb(0x4c5c72),
                ],
                terminal: false,
            },
            Self::Terminal => Palette {
                background: Color::Reset,
                foreground: Color::Reset,
                surface: Color::Reset,
                accent: Color::LightBlue,
                thinking: Color::Reset,
                success: Color::Green,
                warning: Color::Yellow,
                error: Color::Red,
                muted: Color::Gray,
                subtle: Color::DarkGray,
                border: Color::DarkGray,
                scrollbar: Color::Gray,
                selection: Color::Cyan,
                selection_text: Color::Black,
                search: Color::DarkGray,
                search_active: Color::Yellow,
                search_text: Color::Black,
                syntax: [
                    Color::Magenta,
                    Color::Green,
                    Color::Gray,
                    Color::Yellow,
                    Color::Blue,
                    Color::Cyan,
                    Color::Cyan,
                ],
                terminal: true,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub background: Color,
    pub foreground: Color,
    pub surface: Color,
    pub accent: Color,
    pub thinking: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub muted: Color,
    pub subtle: Color,
    pub border: Color,
    pub scrollbar: Color,
    pub selection: Color,
    pub selection_text: Color,
    pub search: Color,
    pub search_active: Color,
    pub search_text: Color,
    /// Keyword, string, comment, number, function, type, operator.
    pub syntax: [Color; 7],
    pub terminal: bool,
}
impl Default for Palette {
    fn default() -> Self {
        Self {
            background: rgb(0x131720),
            foreground: rgb(0xe1e7f0),
            surface: rgb(0x202837),
            accent: rgb(0x71a8fd),
            thinking: rgb(0xbba3de),
            success: rgb(0x7ecfa4),
            warning: rgb(0xe7bd7f),
            error: rgb(0xec939b),
            muted: rgb(0xa0afc3),
            subtle: rgb(0x8695ab),
            border: rgb(0x344258),
            scrollbar: rgb(0x6a83a5),
            selection: rgb(0x304d75),
            selection_text: rgb(0xf1f6ff),
            search: rgb(0x4b422f),
            search_active: rgb(0xe7bd7f),
            search_text: rgb(0x131720),
            syntax: [
                rgb(0xbe9df7),
                rgb(0x8ecca7),
                rgb(0x8591a2),
                rgb(0xeab982),
                rgb(0x71a8fd),
                rgb(0x71ccd1),
                rgb(0xc0c9d9),
            ],
            terminal: false,
        }
    }
}
const fn rgb(hex: u32) -> Color {
    Color::Rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}
impl Palette {
    pub fn entries(self) -> [(&'static str, Color); 24] {
        [
            ("background", self.background),
            ("foreground", self.foreground),
            ("surface", self.surface),
            ("accent", self.accent),
            ("thinking", self.thinking),
            ("success", self.success),
            ("warning", self.warning),
            ("error", self.error),
            ("muted", self.muted),
            ("subtle", self.subtle),
            ("border", self.border),
            ("scrollbar", self.scrollbar),
            ("selection", self.selection),
            ("selection-text", self.selection_text),
            ("search", self.search),
            ("search-active", self.search_active),
            ("search-text", self.search_text),
            ("keyword", self.syntax[0]),
            ("string", self.syntax[1]),
            ("comment", self.syntax[2]),
            ("number", self.syntax[3]),
            ("function", self.syntax[4]),
            ("type", self.syntax[5]),
            ("operator", self.syntax[6]),
        ]
    }
    pub fn set_role(&mut self, index: usize, color: Color) {
        if index >= 17 {
            if let Some(target) = self.syntax.get_mut(index - 17) {
                *target = color;
            }
        } else {
            let fields = [
                &mut self.background,
                &mut self.foreground,
                &mut self.surface,
                &mut self.accent,
                &mut self.thinking,
                &mut self.success,
                &mut self.warning,
                &mut self.error,
                &mut self.muted,
                &mut self.subtle,
                &mut self.border,
                &mut self.scrollbar,
                &mut self.selection,
                &mut self.selection_text,
                &mut self.search,
                &mut self.search_active,
                &mut self.search_text,
            ];
            *fields[index] = color;
        }
    }
    pub fn base(self) -> Style {
        Style::default().fg(self.foreground).bg(self.background)
    }
    /// Code and tool-output background: recessed below `surface`, which stays
    /// reserved for the user band. Derived so custom files need no extra role.
    pub fn panel(self) -> Color {
        match (self.background, self.surface) {
            (Color::Rgb(r, g, b), Color::Rgb(sr, sg, sb)) => {
                let mix = |low: u8, high: u8| ((u16::from(low) + u16::from(high)) / 2) as u8;
                Color::Rgb(mix(r, sr), mix(g, sg), mix(b, sb))
            }
            _ => self.background,
        }
    }
    pub fn selected(self) -> Style {
        Style::default().fg(self.selection_text).bg(self.selection)
    }
    pub fn focused(self) -> Style {
        if self.terminal {
            Style::default().add_modifier(Modifier::REVERSED)
        } else {
            self.selected()
        }
    }
    pub fn breath(self, focused: bool, phase: Option<f32>) -> Color {
        let (Color::Rgb(r, g, b), Color::Rgb(ar, ag, ab)) = (self.background, self.accent) else {
            return self.accent;
        };
        let strength = phase.map_or(if focused { 0.82 } else { 0.74 }, |phase| {
            0.36 + 0.64 * phase.clamp(0.0, 1.0)
        });
        let mix = |low: u8, high: u8| {
            (f32::from(low) + (f32::from(high) - f32::from(low)) * strength).round() as u8
        };
        Color::Rgb(mix(r, ar), mix(g, ag), mix(b, ab))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn luminance(color: Color) -> f64 {
        let Color::Rgb(r, g, b) = color else {
            panic!("RGB theme required");
        };
        let linear = |value: u8| {
            let value = f64::from(value) / 255.0;
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
    fn contrast(a: Color, b: Color) -> f64 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }
    #[test]
    fn shipped_palettes_keep_text_readable_and_motion_appropriate() {
        let mut choice = Choice::default();
        for expected in [Choice::Maka, Choice::Dusk, Choice::Paper, Choice::Terminal] {
            assert_eq!(choice, expected);
            choice = choice.next();
            let c = expected.colors();
            if expected == Choice::Terminal {
                assert_eq!(c.breath(true, Some(0.0)), c.breath(true, Some(1.0)));
                continue;
            }
            assert_ne!(c.breath(true, Some(0.0)), c.breath(true, Some(1.0)));
            assert_eq!(c.breath(true, Some(1.0)), c.accent);
            for color in [
                c.foreground,
                c.muted,
                c.subtle,
                c.accent,
                c.thinking,
                c.success,
                c.warning,
                c.error,
            ]
            .into_iter()
            .chain(c.syntax)
            {
                assert!(
                    contrast(color, c.background) >= 4.5,
                    "{expected:?} {color:?}"
                );
            }
            assert!(contrast(c.foreground, c.surface) >= 4.5);
            for color in c.syntax {
                assert!(
                    contrast(color, c.surface) >= 4.5,
                    "{expected:?} code {color:?}"
                );
                assert!(
                    contrast(color, c.panel()) >= 4.5,
                    "{expected:?} panel code {color:?}"
                );
            }
            assert!(contrast(c.foreground, c.panel()) >= 4.5);
            assert_ne!(c.panel(), c.background, "panels must stay visible");
            assert_ne!(c.panel(), c.surface, "code must not read as a user band");
            assert!(contrast(c.selection_text, c.selection) >= 4.5);
            assert!(contrast(c.search_text, c.search_active) >= 4.5);
        }
        assert_eq!(choice, Choice::Maka);
    }
}
