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

//! One pass over a tree: measure, place, paint, and record what the committed
//! frame can hit. Nothing here keeps state between frames.
use super::node::{Align, Kind, Node, On, Role, Size, Tone};
use crate::theme::Palette;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
};
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub(super) struct Item<M> {
    pub id: String,
    /// Visible part only; clipped by any enclosing scroll viewport.
    pub rect: Rect,
    /// Unclipped rows on screen (may start above the viewport), used to
    /// reveal a keyboard target inside its scroller.
    pub top: i32,
    pub height: u16,
    pub scroller: Option<usize>,
    /// Ordinal of the nearest container: arrow keys along its axis move
    /// within it.
    pub group: usize,
    pub axis: Axis,
    pub on: On<M>,
    pub enabled: bool,
    pub current: bool,
    pub follow_focus: bool,
    pub submit: Option<M>,
    pub hint: Option<String>,
    pub role: Option<Role>,
    /// Owner-drawn: the surface paints neither focus nor hover over it.
    pub slot: bool,
}

pub(super) struct Scroller {
    pub id: String,
    pub viewport: Rect,
    pub content: u16,
    /// Unclipped placement and ancestry, including viewports outside a parent.
    pub top: i32,
    pub height: u16,
    pub parent: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Axis {
    Vertical,
    Horizontal,
}

/// A placement whose top may lie above the screen inside a scrolled viewport.
#[derive(Clone, Copy)]
struct Area {
    x: u16,
    y: i32,
    width: u16,
    height: u16,
}
impl Area {
    fn visible(self, clip: Rect) -> Rect {
        let top = self.y.max(i32::from(clip.top()));
        let bottom = (self.y + i32::from(self.height)).min(i32::from(clip.bottom()));
        if bottom <= top {
            return Rect::default();
        }
        Rect::new(self.x, top as u16, self.width, (bottom - top) as u16).intersection(clip)
    }
}

/// What a child inherits from its placement context.
#[derive(Clone, Copy)]
struct Scope {
    clip: Rect,
    axis: Axis,
    group: usize,
    scroller: Option<usize>,
    /// Interaction styling of an enclosing interactive node.
    style: Option<Style>,
}

pub(super) struct Pass<'a, M> {
    pub buffer: &'a mut Buffer,
    pub colors: Palette,
    pub ascii: bool,
    pub offsets: &'a HashMap<String, u16>,
    pub items: Vec<Item<M>>,
    pub scrollers: Vec<Scroller>,
    /// Slots without an activation: where their owner paints, by id.
    pub canvases: Vec<(String, Rect)>,
    groups: usize,
}

impl<'a, M> Pass<'a, M> {
    pub fn new(
        buffer: &'a mut Buffer,
        colors: Palette,
        ascii: bool,
        offsets: &'a HashMap<String, u16>,
    ) -> Self {
        Self {
            buffer,
            colors,
            ascii,
            offsets,
            items: vec![],
            scrollers: vec![],
            canvases: vec![],
            groups: 0,
        }
    }

    pub fn run(&mut self, root: Node<M>, area: Rect) {
        let id = root.key.to_string();
        let placed = Area {
            x: area.x,
            y: i32::from(area.y),
            width: area.width,
            height: area.height,
        };
        let scope = Scope {
            clip: area,
            axis: Axis::Vertical,
            group: 0,
            scroller: None,
            style: None,
        };
        self.place(root, placed, id, scope);
    }

    fn place(&mut self, node: Node<M>, area: Area, id: String, mut scope: Scope) {
        let visible = area.visible(scope.clip);
        let Node {
            kind,
            on,
            enabled,
            current,
            follow_focus,
            submit,
            hint,
            role,
            ..
        } = node;
        let canvas = on.is_none() && matches!(kind, Kind::Slot);
        // Scrolled-out items stay registered with an empty visible rectangle:
        // the pointer cannot hit them, but the keyboard can still reach them.
        if let Some(on) = on
            && scope.style.is_none()
        {
            // Focus and hover are painted by the surface after placement, so a
            // focus that must move to a neighbor is correct in this same frame.
            scope.style = Some(if !enabled {
                Style::default()
                    .fg(self.colors.subtle)
                    .add_modifier(Modifier::DIM)
            } else if current {
                Style::default()
                    .fg(self.colors.accent)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            });
            // A button's whole hit area reads as one filled control.
            if role.is_some() && enabled && !self.colors.terminal {
                self.buffer
                    .set_style(visible, Style::default().bg(self.colors.surface));
            }
            self.items.push(Item {
                id: id.clone(),
                rect: visible,
                top: area.y,
                height: area.height,
                scroller: scope.scroller,
                group: scope.group,
                axis: scope.axis,
                on,
                enabled,
                current,
                follow_focus,
                submit,
                hint,
                role,
                slot: matches!(kind, Kind::Slot),
            });
        }
        match kind {
            Kind::Column { children, gap } => {
                self.groups += 1;
                let sizes: Vec<_> = children
                    .iter()
                    .map(|child| (child.size, height(child, area.width)))
                    .collect();
                let heights = distribute(&sizes, area.height, gap);
                let inner = Scope {
                    axis: Axis::Vertical,
                    group: self.groups,
                    ..scope
                };
                let mut y = area.y;
                for (child, height) in children.into_iter().zip(heights) {
                    let child_id = format!("{id}/{}", child.key);
                    let placed = Area { y, height, ..area };
                    self.place(child, placed, child_id, inner);
                    y += i32::from(height) + i32::from(gap);
                }
            }
            Kind::Row { children, gap } => {
                self.groups += 1;
                let sizes: Vec<_> = children
                    .iter()
                    .map(|child| (child.size, width(child)))
                    .collect();
                let widths = distribute(&sizes, area.width, gap);
                let inner = Scope {
                    axis: Axis::Horizontal,
                    group: self.groups,
                    ..scope
                };
                let mut x = area.x;
                for (child, width) in children.into_iter().zip(widths) {
                    let child_id = format!("{id}/{}", child.key);
                    let width = width.min(area.x.saturating_add(area.width).saturating_sub(x));
                    let placed = Area { x, width, ..area };
                    self.place(child, placed, child_id, inner);
                    x = x.saturating_add(width).saturating_add(gap);
                }
            }
            Kind::Text { spans, align, clip } => {
                self.text(&spans, align, clip, area, visible, scope.style)
            }
            Kind::Slot => {
                // The field's well; its owner draws the content on top.
                self.buffer
                    .set_style(visible, Style::default().bg(self.colors.surface));
                if canvas {
                    self.canvases.push((id, visible));
                }
            }
            Kind::Rule => {
                let symbol = match (scope.axis, self.ascii) {
                    (Axis::Horizontal, true) => "|",
                    (Axis::Horizontal, false) => "│",
                    (Axis::Vertical, true) => "-",
                    (Axis::Vertical, false) => "─",
                };
                for y in visible.top()..visible.bottom() {
                    for x in visible.left()..visible.right() {
                        self.buffer[(x, y)]
                            .set_symbol(symbol)
                            .set_style(Style::default().fg(self.colors.border));
                    }
                }
            }
            Kind::Scroll(child) => {
                let inner = area.width.saturating_sub(1).max(1);
                let content = height(&child, inner);
                let offset = self
                    .offsets
                    .get(&id)
                    .copied()
                    .unwrap_or(0)
                    .min(content.saturating_sub(visible.height));
                let index = self.scrollers.len();
                self.scrollers.push(Scroller {
                    id: id.clone(),
                    viewport: visible,
                    content,
                    top: area.y,
                    height: area.height,
                    parent: scope.scroller,
                });
                let child_id = format!("{id}/{}", child.key);
                let placed = Area {
                    x: area.x,
                    y: area.y - i32::from(offset),
                    width: inner,
                    height: content,
                };
                let inner = Scope {
                    clip: visible,
                    axis: Axis::Vertical,
                    scroller: Some(index),
                    ..scope
                };
                self.place(*child, placed, child_id, inner);
                if content > visible.height && visible.height > 1 {
                    self.scrollbar(visible, content, offset);
                }
            }
        }
    }

    fn text(
        &mut self,
        spans: &[(String, Tone)],
        align: Align,
        clip: bool,
        area: Area,
        visible: Rect,
        style: Option<Style>,
    ) {
        let lines = if clip {
            vec![truncate(spans, area.width)]
        } else {
            wrap(spans, area.width)
        };
        for (row, line) in lines.into_iter().enumerate() {
            let y = area.y + row as i32;
            if y < i32::from(visible.top()) || y >= i32::from(visible.bottom()) {
                continue;
            }
            let y = y as u16;
            let used: u16 = line.iter().map(|(text, _)| text.width() as u16).sum();
            let spare = area.width.saturating_sub(used);
            let mut x = match align {
                Align::Start => area.x,
                // Odd remainders sit left of center, like shell buttons.
                Align::Center => area.x + spare / 2,
                Align::End => area.x + spare,
            };
            for (text, tone) in line {
                let base = self.tone(tone);
                let span = style.map_or(base, |style| base.patch(style));
                let limit = usize::from(visible.right().saturating_sub(x));
                if x < visible.left() || limit == 0 {
                    break;
                }
                let (end, _) = self.buffer.set_stringn(x, y, &text, limit, span);
                x = end;
            }
        }
    }

    fn tone(&self, tone: Tone) -> Style {
        let colors = self.colors;
        match tone {
            Tone::Normal => Style::default().fg(colors.foreground),
            Tone::Strong => Style::default()
                .fg(colors.foreground)
                .add_modifier(Modifier::BOLD),
            Tone::Muted => Style::default().fg(colors.muted),
            Tone::Subtle => Style::default().fg(colors.subtle),
            Tone::Accent => Style::default().fg(colors.accent),
            Tone::Primary => Style::default()
                .fg(colors.accent)
                .add_modifier(Modifier::BOLD),
            Tone::Success => Style::default().fg(colors.success),
            Tone::Warning => Style::default().fg(colors.warning),
            Tone::Error => Style::default().fg(colors.error),
            Tone::Hue(index) => Style::default().fg(crate::view::tone::hue(index, colors)),
        }
    }

    fn scrollbar(&mut self, viewport: Rect, content: u16, offset: u16) {
        let visible = viewport.height;
        let thumb = ((u32::from(visible) * u32::from(visible)) / u32::from(content)).max(1) as u16;
        let travel = visible.saturating_sub(thumb);
        let range = content.saturating_sub(visible).max(1);
        let top = (u32::from(offset) * u32::from(travel) / u32::from(range)) as u16;
        let x = viewport.right().saturating_sub(1);
        for y in 0..visible {
            let active = (top..top + thumb).contains(&y);
            let (symbol, color) = match (active, self.ascii) {
                (true, true) => ("#", self.colors.scrollbar),
                (true, false) => ("┃", self.colors.scrollbar),
                (false, true) => ("|", self.colors.border),
                (false, false) => ("│", self.colors.border),
            };
            self.buffer[(x, viewport.y + y)]
                .set_symbol(symbol)
                .set_style(Style::default().fg(color));
        }
    }
}

/// Resolve main-axis sizes: fixed and content first, fills share the rest.
fn distribute(sizes: &[(Size, u16)], available: u16, gap: u16) -> Vec<u16> {
    let gaps = gap.saturating_mul(sizes.len().saturating_sub(1) as u16);
    let fixed: u16 = sizes
        .iter()
        .map(|(size, content)| match size {
            Size::Fixed(n) => *n,
            Size::Upto(n) => (*content).min(*n),
            Size::Content => *content,
            Size::Fill => 0,
        })
        .fold(gaps, u16::saturating_add);
    let fills = sizes.iter().filter(|(size, _)| *size == Size::Fill).count() as u16;
    let remaining = available.saturating_sub(fixed);
    let mut spare = if fills > 0 { remaining % fills } else { 0 };
    sizes
        .iter()
        .map(|(size, content)| match size {
            Size::Fixed(n) => *n,
            Size::Upto(n) => (*content).min(*n),
            Size::Content => *content,
            Size::Fill => {
                let extra = u16::from(spare > 0);
                spare = spare.saturating_sub(1);
                remaining / fills + extra
            }
        })
        .collect()
}

pub(super) fn height<M>(node: &Node<M>, width: u16) -> u16 {
    match &node.kind {
        Kind::Column { children, gap } => children
            .iter()
            .map(|child| match child.size {
                Size::Fixed(n) => n,
                Size::Upto(n) => height(child, width).min(n),
                _ => height(child, width),
            })
            .fold(
                gap.saturating_mul(children.len().saturating_sub(1) as u16),
                u16::saturating_add,
            ),
        Kind::Row { children, gap } => {
            let widths = distribute(
                &children
                    .iter()
                    .map(|child| (child.size, self::width(child)))
                    .collect::<Vec<_>>(),
                width,
                *gap,
            );
            children
                .iter()
                .zip(widths)
                .map(|(child, width)| height(child, width))
                .max()
                .unwrap_or(0)
        }
        Kind::Text { clip: true, .. } => 1,
        Kind::Text { spans, .. } => wrap(spans, width).len() as u16,
        Kind::Rule | Kind::Slot => 1,
        Kind::Scroll(child) => height(child, width.saturating_sub(1)),
    }
}

pub(crate) fn width<M>(node: &Node<M>) -> u16 {
    match &node.kind {
        Kind::Column { children, .. } => children.iter().map(width).max().unwrap_or(0),
        Kind::Row { children, gap } => children.iter().map(width).fold(
            gap.saturating_mul(children.len().saturating_sub(1) as u16),
            u16::saturating_add,
        ),
        Kind::Text { spans, .. } => spans.iter().map(|(text, _)| text.width() as u16).sum(),
        Kind::Rule | Kind::Slot => 1,
        Kind::Scroll(child) => width(child).saturating_add(1),
    }
}

/// One row of at most `width` cells, ending in an ellipsis when it overflows.
fn truncate(spans: &[(String, Tone)], width: u16) -> Vec<(String, Tone)> {
    let width = usize::from(width);
    let total: usize = spans
        .iter()
        .map(|(text, _)| crate::view::safe(text).width())
        .sum();
    let budget = if total > width {
        width.saturating_sub(1)
    } else {
        width
    };
    let (mut line, mut used) = (vec![], 0);
    'spans: for (text, tone) in spans {
        let mut kept = String::new();
        for grapheme in crate::view::safe(text).graphemes(true) {
            if used + grapheme.width() > budget {
                if !kept.is_empty() {
                    line.push((kept, *tone));
                }
                break 'spans;
            }
            used += grapheme.width();
            kept.push_str(grapheme);
        }
        line.push((kept, *tone));
    }
    if total > width && width > 0 {
        let tone = line.last().map_or(Tone::Subtle, |(_, tone)| *tone);
        line.push(("…".into(), tone));
    }
    line
}

/// Greedy wrapping that keeps words whole when they fit a line; wide
/// graphemes (CJK) may break anywhere, as in the transcript.
fn wrap(spans: &[(String, Tone)], width: u16) -> Vec<Vec<(String, Tone)>> {
    let width = usize::from(width.max(1));
    let mut lines = vec![vec![]];
    let mut used = 0;
    for (text, tone) in spans {
        for word in words(text) {
            let safe = crate::view::safe(&word);
            let cells = safe.width();
            let space = safe.trim().is_empty();
            if used + cells > width && used > 0 {
                if space {
                    continue; // Never start a continuation line with a space.
                }
                if cells <= width {
                    lines.push(vec![]);
                    used = 0;
                }
            }
            for grapheme in safe.graphemes(true) {
                let cells = grapheme.width();
                if used + cells > width && used > 0 {
                    // An overlong word may split, but a closing mark never
                    // starts a line: the grapheme before it moves along.
                    let carried = grapheme
                        .chars()
                        .all(closing)
                        .then(|| last_grapheme(lines.last_mut().unwrap(), width - cells))
                        .flatten();
                    lines.push(vec![]);
                    used = 0;
                    if let Some((text, tone)) = carried {
                        used = text.width();
                        lines.last_mut().unwrap().push((text, tone));
                    }
                }
                let line: &mut Vec<(String, Tone)> = lines.last_mut().unwrap();
                match line.last_mut() {
                    Some((text, last)) if last == tone => text.push_str(grapheme),
                    _ => line.push((grapheme.to_owned(), *tone)),
                }
                used += cells;
            }
        }
    }
    lines
}

fn closing(c: char) -> bool {
    ",.!?:;%)]}、。，．！？：；％）］｝〉》」』】〕〗〙〛’”»".contains(c)
}

/// Takes the last grapheme off a line that keeps others, if it fits in
/// `room` cells.
fn last_grapheme(line: &mut Vec<(String, Tone)>, room: usize) -> Option<(String, Tone)> {
    let alone = line.len() == 1;
    let (text, tone) = line.last_mut()?;
    let (index, grapheme) = text.grapheme_indices(true).next_back()?;
    if grapheme.width() > room || (index == 0 && alone) {
        return None;
    }
    let tone = *tone;
    let grapheme = text.split_off(index);
    if text.is_empty() {
        line.pop();
    }
    Some((grapheme, tone))
}

/// Word boundaries, with closing punctuation kept on its preceding word
/// (including a single CJK character) so no line starts with it.
fn words(text: &str) -> Vec<String> {
    let mut words: Vec<String> = vec![];
    for word in text.split_word_bounds() {
        match words.last_mut() {
            Some(previous) if word.chars().all(closing) && !previous.trim().is_empty() => {
                previous.push_str(word)
            }
            _ => words.push(word.to_owned()),
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_share_remaining_space_after_fixed_content_and_gaps() {
        let sizes = [
            (Size::Fixed(4), 9),
            (Size::Fill, 0),
            (Size::Content, 3),
            (Size::Fill, 0),
        ];
        assert_eq!(distribute(&sizes, 20, 1), vec![4, 5, 3, 5]);
        assert_eq!(distribute(&sizes, 21, 1), vec![4, 6, 3, 5]);
        assert_eq!(
            distribute(&sizes, 2, 1),
            vec![4, 0, 3, 0],
            "no underflow when space runs out"
        );
    }

    #[test]
    fn clipped_text_ends_with_an_ellipsis_at_grapheme_boundaries() {
        let text = |line: Vec<(String, Tone)>| -> String {
            line.into_iter().map(|(text, _)| text).collect()
        };
        let spans = [("设计复核 review".into(), Tone::Normal)];
        assert_eq!(text(truncate(&spans, 20)), "设计复核 review");
        assert_eq!(text(truncate(&spans, 8)), "设计复…");
        assert_eq!(text(truncate(&spans, 9)), "设计复核…");
    }

    #[test]
    fn wrapping_keeps_words_whole_and_breaks_wide_text_anywhere() {
        let text = |lines: Vec<Vec<(String, Tone)>>| -> Vec<String> {
            lines
                .into_iter()
                .map(|line| line.into_iter().map(|(text, _)| text).collect())
                .collect()
        };
        let spans = [
            ("theme file ".into(), Tone::Muted),
            ("~/.config/maka".into(), Tone::Subtle),
        ];
        // Paths break at their punctuation boundaries, never inside a segment.
        assert_eq!(
            text(wrap(&spans, 12)),
            ["theme file ~", "/.config/", "maka"]
        );
        assert_eq!(
            text(wrap(&[("中文主题配置".into(), Tone::Normal)], 5)),
            ["中文", "主题", "配置"]
        );
        let prose = text(wrap(
            &[("历史会保留。你可以恢复。".into(), Tone::Normal)],
            5,
        ));
        assert!(
            prose.iter().all(|line| !line.starts_with('。')),
            "closing punctuation stays with its word: {prose:?}"
        );
        assert_eq!(
            text(wrap(&[("a \x1b[31m".into(), Tone::Normal)], 20)),
            ["a  [31m"],
            "terminal controls are neutralized"
        );
    }

    #[test]
    fn wrapping_keeps_cjk_with_latin_and_closing_punctuation_with_its_word() {
        let lines = |source: &str, width: u16| -> Vec<String> {
            wrap(&[(source.to_owned(), Tone::Normal)], width)
                .into_iter()
                .map(|line| line.into_iter().map(|(text, _)| text).collect())
                .collect()
        };
        let compact = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        let source =
            "Host 上的目录。 Existing sessions and files remain. abcdefghijklmn e\u{301}🦀";
        let texts = lines(source, 12);
        assert!(texts.iter().all(|line| line.width() <= 12));
        assert_eq!(compact(&texts.concat()), compact(source));
        assert!(texts.iter().any(|s| s.contains("Existing")));
        assert!(
            texts[0].contains("Host 上"),
            "CJK shares the line with Latin"
        );
        for width in [4, 8, 12, 44] {
            let source = "后续请求使用新密钥。保存不会测试。 Words, words. abcdefghijklmnop。";
            let texts = lines(source, width);
            assert!(texts.iter().all(|s| s.width() <= usize::from(width)));
            assert!(texts.iter().all(|s| !s.starts_with(['。', ',', '.'])));
            assert_eq!(compact(&texts.concat()), compact(source));
        }
    }
}
