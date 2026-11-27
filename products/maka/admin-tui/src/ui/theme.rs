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

use nsh_core::prelude::*;

/// Standard terminal cell width in points (matches nsh-platform-tui CellSize::default).
pub const CELL_W: f32 = 8.0;
/// Standard terminal cell height in points (matches nsh-platform-tui CellSize::default).
pub const CELL_H: f32 = 16.0;

const fn adaptive(light: u32, dark: u32) -> AdaptiveColor {
    AdaptiveColor {
        light: rgb(light).to_hsla(),
        dark: rgb(dark).to_hsla(),
    }
}

/// Terminal-calibrated surface and semantic palette following Maka DESIGN.md.
pub mod palette {
    use super::*;

    pub const BG: AdaptiveColor = adaptive(0xfafaf8, 0x111214);
    pub const SIDEBAR: AdaptiveColor = adaptive(0xf2f2ef, 0x16181d);
    pub const CARD: AdaptiveColor = adaptive(0xffffff, 0x1c1f26);
    pub const RAISED: AdaptiveColor = adaptive(0xe8eaf0, 0x262a34);
    pub const BORDER: AdaptiveColor = adaptive(0xd4d7df, 0x313643);
    pub const BORDER_STRONG: AdaptiveColor = adaptive(0x9ea4b2, 0x4b5263);

    pub const TEXT: AdaptiveColor = adaptive(0x111214, 0xf2f4f8);
    pub const MUTED: AdaptiveColor = adaptive(0x636874, 0x8f96a6);
    pub const FAINT: AdaptiveColor = adaptive(0x959ba8, 0x626877);

    // Saturated semantic hues: map cleanly to ANSI cyan/blue/green/yellow/red/magenta.
    pub const ACCENT: AdaptiveColor = adaptive(0x0b7a8c, 0x38d0e8);
    pub const PRIMARY: AdaptiveColor = adaptive(0x2457c5, 0x6ba1ff);
    pub const SUCCESS: AdaptiveColor = adaptive(0x15804c, 0x4ade80);
    pub const WARNING: AdaptiveColor = adaptive(0xb4690e, 0xfbbf24);
    pub const DANGER: AdaptiveColor = adaptive(0xc82838, 0xf87171);
    pub const PEER: AdaptiveColor = adaptive(0x9333ea, 0xd875ff);
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Neutral,
    Muted,
    Accent,
    Primary,
    Success,
    Warning,
    Danger,
    Peer,
}

impl Tone {
    pub const fn color(self) -> AdaptiveColor {
        match self {
            Self::Neutral => palette::TEXT,
            Self::Muted => palette::MUTED,
            Self::Accent => palette::ACCENT,
            Self::Primary => palette::PRIMARY,
            Self::Success => palette::SUCCESS,
            Self::Warning => palette::WARNING,
            Self::Danger => palette::DANGER,
            Self::Peer => palette::PEER,
        }
    }

    pub const fn dot(self) -> &'static str {
        match self {
            Self::Success => "●",
            Self::Warning => "◐",
            Self::Danger => "✕",
            Self::Accent | Self::Primary | Self::Peer => "◆",
            Self::Neutral | Self::Muted => "○",
        }
    }
}

/// Whether the terminal viewport is narrow enough to fold the sidebar into a top tab strip.
pub fn is_compact() -> bool {
    let w = window().width.0;
    w > 0.0 && w < 96.0 * CELL_W
}
