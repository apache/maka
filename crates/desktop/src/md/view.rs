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

//! Blocks to elements. Inline styles, the fade and the selection are all
//! highlights over one text per block, so none of them can move a glyph.

use super::{
    fade::Arrivals,
    parse::{Block, Document, Kind, Marker, Style, Text},
};
use crate::{
    theme::{Theme, theme},
    ui::{
        Copied, icon,
        select::{Key, Selection},
    },
};
use gpui_kit::{
    AnyElement, App, Div, ElementId, Entity, FontStyle, FontWeight, HighlightStyle,
    InteractiveElement, InteractiveText, IntoElement, ParentElement, Role, SharedString, Stateful,
    StatefulInteractiveElement, StrikethroughStyle, Styled, StyledText, Toggled, div, px, relative,
};
use std::{ops::Range, time::Instant};

#[derive(Clone, Copy)]
pub struct Metrics {
    pub text: f32,
    pub line: f32,
    pub code: f32,
    pub code_line: f32,
    pub gap: f32,
}

pub const BODY: Metrics = Metrics {
    text: 14.,
    line: 21.,
    code: 13.,
    code_line: 19.5,
    gap: 10.,
};

pub const PROMPT: Metrics = Metrics {
    text: 14.,
    line: 20.,
    code: 13.,
    code_line: 19.5,
    gap: 10.,
};

pub const COMPACT: Metrics = Metrics {
    text: 13.5,
    line: 19.5,
    code: 13.,
    code_line: 19.5,
    gap: 7.,
};

/// A markdown message: its parsed blocks and, while it streams, when each
/// part of it arrived.
pub struct Body {
    document: Document,
    arrivals: Option<Arrivals>,
}

impl Body {
    /// Text already on screen elsewhere, or loaded from history, starts
    /// fully opaque.
    pub fn new(source: &str, streaming: bool) -> Self {
        let mut document = Document::default();
        document.update(source, streaming);
        Self {
            document,
            arrivals: streaming.then(Arrivals::seeded),
        }
    }

    pub fn update(&mut self, source: &str, streaming: bool, now: Instant) {
        if streaming {
            let old = self.document.source().to_owned();
            self.arrivals
                .get_or_insert_with(Arrivals::seeded)
                .record(&old, source, now);
        } else {
            self.arrivals = None;
        }
        self.document.update(source, streaming);
    }

    pub fn fading(&self, now: Instant) -> bool {
        self.arrivals
            .as_ref()
            .is_some_and(|arrivals| arrivals.fading(now))
    }
}

/// Byte ranges of a text still fading in, with their opacity.
type Fades = Vec<(Range<usize>, f32)>;

pub struct Scope<'a> {
    pub row: &'a SharedString,
    pub metrics: Metrics,
    pub color: gpui_kit::Hsla,
    pub selection: &'a Selection,
    pub copied: &'a Entity<Copied>,
    /// `None` when nothing fades: settled text or reduced motion.
    pub now: Option<Instant>,
}

pub fn render(body: &Body, scope: &Scope, cx: &App) -> Div {
    let theme = theme(cx);
    let metrics = scope.metrics;
    let mut column = div()
        .flex()
        .flex_col()
        .min_w_0()
        .text_size(px(metrics.text))
        .line_height(px(metrics.line))
        .text_color(scope.color);
    let mut previous: Option<&Block> = None;
    for (ix, block) in body.document.blocks().enumerate() {
        let ordinal = (ix as u32) << 16;
        let fades = |text: &Text| match (&body.arrivals, scope.now) {
            (Some(arrivals), Some(now)) => arrivals.spans(text, now),
            _ => Vec::new(),
        };
        let element = match &block.kind {
            Kind::Paragraph => text(
                scope,
                ordinal,
                &block.texts[0],
                &fades(&block.texts[0]),
                theme,
            )
            .into_any_element(),
            Kind::Heading(level) => {
                let (scale, weight) = match level {
                    1 => (1.45, FontWeight::BOLD),
                    2 => (1.28, FontWeight::BOLD),
                    3 => (1.14, FontWeight::SEMIBOLD),
                    4 => (1.05, FontWeight::SEMIBOLD),
                    _ => (1.0, FontWeight::SEMIBOLD),
                };
                let size = (metrics.text * scale).round();
                div()
                    .text_size(px(size))
                    .line_height(px((size * 1.42).round()))
                    .font_weight(weight)
                    .when(*level <= 2, |this| this.pt(px(4.)))
                    .child(text(
                        scope,
                        ordinal,
                        &block.texts[0],
                        &fades(&block.texts[0]),
                        theme,
                    ))
                    .into_any_element()
            }
            Kind::Item(marker) => item(
                *marker,
                text(
                    scope,
                    ordinal,
                    &block.texts[0],
                    &fades(&block.texts[0]),
                    theme,
                ),
                metrics,
                theme,
            ),
            Kind::Code { language } => code_block(
                scope,
                ordinal,
                language.as_deref(),
                &block.texts[0],
                &fades(&block.texts[0]),
                theme,
                cx,
            ),
            Kind::Rule => div()
                .h(px(1.))
                .my(px(4.))
                .bg(theme.border)
                .into_any_element(),
            Kind::Table { columns } => table(scope, ordinal, *columns, block, &fades, theme),
        };
        let indent = match &block.kind {
            Kind::Item(_) => block.depth.saturating_sub(1),
            _ => block.depth,
        };
        let element = quoted(block.quote, indented(indent, element), theme);
        let gap = match (previous.map(|block| &block.kind), &block.kind) {
            (None, _) => 0.,
            (Some(Kind::Item(_)), Kind::Item(_)) => metrics.gap * 0.5,
            _ => metrics.gap,
        };
        column = column.child(
            accessible(block, scope, ordinal)
                .pt(px(gap))
                .min_w_0()
                .child(element),
        );
        previous = Some(block);
    }
    column
}

/// The block's node for assistive technology, which never sees `StyledText`.
fn accessible(block: &Block, scope: &Scope, ordinal: u32) -> Stateful<Div> {
    let text = || block.texts[0].text.clone();
    let node = div().id(ElementId::NamedInteger(
        scope.row.clone(),
        (ordinal | 0xffff) as u64,
    ));
    match &block.kind {
        Kind::Paragraph => node.role(Role::Paragraph).aria_label(text()),
        Kind::Heading(level) => node
            .role(Role::Heading)
            .aria_level(*level as usize)
            .aria_label(text()),
        Kind::Item(Marker::Task(done)) => node
            .role(Role::ListItem)
            .aria_toggled(if *done { Toggled::True } else { Toggled::False })
            .aria_label(text()),
        Kind::Item(_) => node.role(Role::ListItem).aria_label(text()),
        Kind::Code { .. } => node.role(Role::Code).aria_label(text()),
        Kind::Rule => node,
        Kind::Table { columns } => {
            let rows: Vec<String> = block
                .texts
                .chunks(*columns)
                .map(|row| {
                    row.iter()
                        .map(|cell| cell.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" | ")
                })
                .collect();
            node.role(Role::Table)
                .aria_row_count(rows.len())
                .aria_column_count(*columns)
                .aria_label(rows.join("\n"))
        }
    }
}

fn text(
    scope: &Scope,
    ordinal: u32,
    text: &Text,
    fades: &[(Range<usize>, f32)],
    theme: &Theme,
) -> AnyElement {
    let key = Key {
        row: scope.row.clone(),
        ordinal,
    };
    let selected = scope.selection.range_for(&key);
    let content: SharedString = text.text.clone().into();
    let mut code_ranges: Vec<Range<usize>> = Vec::new();
    for (range, style) in &text.styles {
        if *style == Style::Code {
            match code_ranges.last_mut() {
                Some(last) if last.end == range.start => last.end = range.end,
                _ => code_ranges.push(range.clone()),
            }
        }
    }
    let styled = StyledText::new(content.clone())
        .with_highlights(highlights(text, fades, selected, theme))
        .with_font_family_overrides(
            code_ranges
                .into_iter()
                .map(|range| (range, theme.mono_font.clone())),
        );
    let layout = styled.layout().clone();
    let element = if text.links.is_empty() {
        styled.into_any_element()
    } else {
        let urls: Vec<String> = text.links.iter().map(|(_, url)| url.clone()).collect();
        InteractiveText::new(
            ElementId::NamedInteger(scope.row.clone(), ordinal as u64),
            styled,
        )
        .on_click(
            text.links.iter().map(|(range, _)| range.clone()).collect(),
            move |ix, _, cx| cx.open_url(&urls[ix]),
        )
        .into_any_element()
    };
    let block_start = ordinal & 0xffff == 0;
    scope
        .selection
        .text(key, content, block_start, layout, element)
        .into_any_element()
}

/// Styles that apply to disjoint pieces of `text`, in order.
fn highlights(
    text: &Text,
    fades: &[(Range<usize>, f32)],
    selected: Option<Range<usize>>,
    theme: &Theme,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let mut cuts = vec![0, text.text.len()];
    for (range, _) in &text.styles {
        cuts.extend([range.start, range.end]);
    }
    for (range, _) in fades {
        cuts.extend([range.start, range.end]);
    }
    if let Some(range) = &selected {
        cuts.extend([range.start, range.end]);
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = Vec::new();
    for pair in cuts.windows(2) {
        let piece = pair[0]..pair[1];
        let mut style = HighlightStyle::default();
        for (range, kind) in &text.styles {
            if range.start <= piece.start && piece.end <= range.end {
                style = style.highlight(match kind {
                    Style::Strong => HighlightStyle {
                        font_weight: Some(FontWeight::SEMIBOLD),
                        ..Default::default()
                    },
                    Style::Emphasis => HighlightStyle {
                        font_style: Some(FontStyle::Italic),
                        ..Default::default()
                    },
                    Style::Strike => HighlightStyle {
                        strikethrough: Some(StrikethroughStyle {
                            thickness: px(1.),
                            color: Some(theme.muted),
                        }),
                        ..Default::default()
                    },
                    Style::Code => HighlightStyle {
                        background_color: Some(theme.text.opacity(0.07)),
                        ..Default::default()
                    },
                    Style::Link => HighlightStyle {
                        color: Some(theme.accent_solid),
                        ..Default::default()
                    },
                });
            }
        }
        if let Some((_, opacity)) = fades
            .iter()
            .find(|(range, _)| range.start <= piece.start && piece.end <= range.end)
        {
            style.fade_out = Some(1. - opacity);
        }
        if selected
            .as_ref()
            .is_some_and(|range| range.start <= piece.start && piece.end <= range.end)
        {
            style.background_color = Some(theme.selection);
        }
        if style != HighlightStyle::default() {
            out.push((piece, style));
        }
    }
    out
}

fn item(marker: Marker, content: AnyElement, metrics: Metrics, theme: &Theme) -> AnyElement {
    let gutter = match marker {
        Marker::Number(_) => 22.,
        _ => 14.,
    };
    let marker = match marker {
        Marker::Bullet => div().text_color(theme.muted).child("•").into_any_element(),
        Marker::Number(number) => div()
            .text_color(theme.muted)
            .child(format!("{number}."))
            .into_any_element(),
        Marker::Task(done) => {
            let size = (metrics.text * 0.92).round();
            div()
                .mt(px(((metrics.line - size) / 2.).floor()))
                .size(px(size))
                .rounded(px(3.))
                .border_1()
                .flex()
                .items_center()
                .justify_center()
                .border_color(if done { theme.accent } else { theme.border })
                .when(done, |this| {
                    this.bg(theme.accent)
                        .child(icon("icons/check.svg", theme.on_accent).size(px(size - 4.)))
                })
                .into_any_element()
        }
    };
    div()
        .flex()
        .items_start()
        .min_w_0()
        .child(div().w(px(gutter)).flex_none().child(marker))
        .child(div().flex_auto().min_w_0().child(content))
        .into_any_element()
}

fn indented(depth: u8, element: AnyElement) -> AnyElement {
    if depth == 0 {
        return element;
    }
    div()
        .pl(px(18. * depth as f32))
        .min_w_0()
        .child(element)
        .into_any_element()
}

fn quoted(depth: u8, element: AnyElement, theme: &Theme) -> AnyElement {
    if depth == 0 {
        return element;
    }
    let mut row = div().flex().gap(px(10.)).min_w_0();
    for _ in 0..depth {
        row = row.child(div().w(px(2.)).flex_none().rounded_full().bg(theme.border));
    }
    row.child(div().flex_auto().min_w_0().child(element))
        .into_any_element()
}

fn code_block(
    scope: &Scope,
    ordinal: u32,
    language: Option<&str>,
    code: &Text,
    fades: &[(Range<usize>, f32)],
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let copy_key: SharedString = format!("{}:{ordinal}", scope.row).into();
    let copied = scope.copied.read(cx).is(&copy_key);
    let source = scope.copied.clone();
    let raw = code.text.clone();
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .rounded(px(8.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.sunken)
        .overflow_hidden()
        .child(
            div()
                .flex()
                .items_center()
                .h(px(28.))
                .pl(px(10.))
                .pr(px(2.))
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.5))
                        .line_height(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.muted)
                        .child(language.unwrap_or_default().to_lowercase()),
                )
                .child(
                    div()
                        .id(ElementId::NamedInteger(copy_key.clone(), 1))
                        .size(px(24.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(5.))
                        .cursor_pointer()
                        .hover(|this| this.bg(theme.hover))
                        .child(
                            icon(
                                if copied {
                                    "icons/check.svg"
                                } else {
                                    "icons/copy.svg"
                                },
                                theme.muted,
                            )
                            .size(px(12.)),
                        )
                        .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
                            cx.stop_propagation()
                        })
                        .on_click(move |_, _, cx| {
                            source.update(cx, |copied, cx| {
                                copied.copy(copy_key.clone(), raw.clone(), cx)
                            })
                        }),
                ),
        )
        .child(
            div()
                .px(px(10.))
                .py(px(8.))
                .font_family(theme.mono_font.clone())
                .text_size(px(scope.metrics.code))
                .line_height(px(scope.metrics.code_line))
                .text_color(theme.text)
                .child(text(scope, ordinal, code, fades, theme)),
        )
        .into_any_element()
}

fn table(
    scope: &Scope,
    ordinal: u32,
    columns: usize,
    block: &Block,
    fades: &dyn Fn(&Text) -> Fades,
    theme: &Theme,
) -> AnyElement {
    if columns == 0 {
        return div().into_any_element();
    }
    let widths = column_widths(columns, &block.texts);
    let rows = block.texts.chunks(columns).count();
    let mut table = div()
        .flex()
        .flex_col()
        .w_full()
        .rounded(px(8.))
        .border_1()
        .border_color(theme.border)
        .overflow_hidden()
        .text_size(px((scope.metrics.text - 0.5).max(12.5)))
        .line_height(px(scope.metrics.line - 2.));
    for (row_ix, cells) in block.texts.chunks(columns).enumerate() {
        let mut row = div()
            .flex()
            .w_full()
            .when(row_ix == 0, |this| {
                this.bg(theme.text.opacity(0.04))
                    .font_weight(FontWeight::SEMIBOLD)
            })
            .when(row_ix + 1 < rows, |this| {
                this.border_b_1().border_color(theme.border)
            });
        for (column, cell) in cells.iter().enumerate() {
            let cell_ordinal = ordinal + (row_ix * columns + column) as u32;
            row = row.child(
                div()
                    .w(relative(widths[column]))
                    .min_w_0()
                    .px(px(9.))
                    .py(px(6.))
                    .child(text(scope, cell_ordinal, cell, &fades(cell), theme)),
            );
        }
        table = table.child(row);
    }
    table.into_any_element()
}

/// Column shares proportional to their longest cell, none below 55% of an
/// even share; a column held at the floor frees its excess for the others.
fn column_widths(columns: usize, cells: &[Text]) -> Vec<f32> {
    let mut content = vec![0f32; columns];
    for (ix, cell) in cells.iter().enumerate() {
        let width = cell.text.chars().count() as f32;
        content[ix % columns] = content[ix % columns].max(width);
    }
    let floor = 0.55 / columns as f32;
    let mut pinned = vec![false; columns];
    loop {
        let free: f32 = (0..columns)
            .filter(|ix| !pinned[*ix])
            .map(|ix| content[ix])
            .sum();
        let budget = 1. - floor * pinned.iter().filter(|pin| **pin).count() as f32;
        let share = |ix: usize| {
            if pinned[ix] {
                floor
            } else if free == 0. {
                budget / pinned.iter().filter(|pin| !**pin).count() as f32
            } else {
                budget * content[ix] / free
            }
        };
        let newly: Vec<usize> = (0..columns)
            .filter(|ix| !pinned[*ix] && share(*ix) < floor)
            .collect();
        if newly.is_empty() {
            return (0..columns).map(share).collect();
        }
        for ix in newly {
            pinned[ix] = true;
        }
    }
}

use gpui_kit::prelude::FluentBuilder;

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(texts: &[&str]) -> Vec<Text> {
        texts
            .iter()
            .map(|text| Text {
                text: (*text).into(),
                ..Default::default()
            })
            .collect()
    }

    #[test]
    fn columns_share_by_content_above_a_floor() {
        let widths = column_widths(2, &cells(&["abcd", "abcdef"]));
        assert!((widths[0] - 0.4).abs() < 1e-4 && (widths[1] - 0.6).abs() < 1e-4);
        let widths = column_widths(2, &cells(&["a", &"x".repeat(200)]));
        assert!((widths[0] - 0.275).abs() < 1e-4, "{widths:?}");
        assert!((widths.iter().sum::<f32>() - 1.).abs() < 1e-4);
        assert_eq!(column_widths(2, &cells(&["", ""])), vec![0.5, 0.5]);
    }

    #[test]
    fn highlights_split_at_every_style_fade_and_selection_edge() {
        let text = &crate::md::parse::parse("a **bold** `c`", 0).blocks[0].texts[0];
        let theme = Theme::for_appearance(gpui_kit::WindowAppearance::Light);
        let pieces = highlights(text, &[(2..6, 0.5)], Some(3..8), &theme);
        let ranges: Vec<_> = pieces.iter().map(|(range, _)| range.clone()).collect();
        assert_eq!(ranges, vec![2..3, 3..6, 6..7, 7..8]);
        assert!(pieces[1].1.background_color == Some(theme.selection));
        assert!(pieces[0].1.fade_out == Some(0.5));
    }
}
