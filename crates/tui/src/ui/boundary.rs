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

use super::{Context, layout::Area};
use crate::motion::Motion;
use ratatui::{buffer::Buffer, layout::Rect, style::Style};

/// Semantic border strength; the active terminal palette owns the color.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Emphasis {
    #[default]
    Normal,
    Accent,
}

/// Real activity may request a gentle accent breath from the shared clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Activity {
    #[default]
    Idle,
    Busy,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Padding {
    pub(super) horizontal: u16,
    pub(super) vertical: u16,
}

impl Padding {
    pub(super) fn new(horizontal: u16, vertical: u16) -> Self {
        Self {
            horizontal: horizontal.min(4),
            vertical: vertical.min(4),
        }
    }

    pub(super) fn width(self) -> u16 {
        2 + self.horizontal * 2
    }

    pub(super) fn height(self) -> u16 {
        2 + self.vertical * 2
    }

    pub(super) fn body(self, area: Area) -> Area {
        Area {
            x: area.x.saturating_add(1 + self.horizontal),
            y: area.y + i32::from(1 + self.vertical),
            width: area.width.saturating_sub(self.width()),
            height: area.height.saturating_sub(self.height()),
        }
    }
}

pub(super) fn paint(
    buffer: &mut Buffer,
    area: Area,
    clip: Rect,
    context: Context,
    emphasis: Emphasis,
    activity: Activity,
    motion: Option<&mut Motion>,
) {
    let visible = area.visible(clip);
    if visible.is_empty() {
        return;
    }
    let right = area.x.saturating_add(area.width).saturating_sub(1);
    let bottom = area.y + i32::from(area.height) - 1;
    let horizontal = [area.y, bottom]
        .iter()
        .any(|y| (i32::from(visible.top())..i32::from(visible.bottom())).contains(y));
    let vertical = [area.x, right]
        .iter()
        .any(|x| (visible.left()..visible.right()).contains(x));
    // A viewport can expose the middle of the body without exposing a border.
    if !horizontal && !vertical {
        return;
    }
    let colors = context.colors;
    let phase = (emphasis == Emphasis::Accent && activity == Activity::Busy && !colors.terminal)
        .then(|| motion.map_or(0.45, Motion::breath));
    let color = match emphasis {
        Emphasis::Normal => colors.border,
        Emphasis::Accent => colors.breath(context.focused, phase),
    };
    let style = Style::default().fg(color);
    for y in visible.top()..visible.bottom() {
        for x in visible.left()..visible.right() {
            let top = i32::from(y) == area.y;
            let bottom = i32::from(y) == bottom;
            let left = x == area.x;
            let right = x == right;
            let symbol = match (top, bottom, left, right, context.ascii) {
                (true, _, true, _, true)
                | (true, _, _, true, true)
                | (_, true, true, _, true)
                | (_, true, _, true, true) => "+",
                (true, _, true, _, false) => "╭",
                (true, _, _, true, false) => "╮",
                (_, true, true, _, false) => "╰",
                (_, true, _, true, false) => "╯",
                (true, _, _, _, true) | (_, true, _, _, true) => "-",
                (true, _, _, _, false) | (_, true, _, _, false) => "─",
                (_, _, true, _, true) | (_, _, _, true, true) => "|",
                (_, _, true, _, false) | (_, _, _, true, false) => "│",
                _ => continue,
            };
            buffer[(x, y)].set_symbol(symbol).set_style(style);
        }
    }
}
