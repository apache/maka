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

use super::*;
use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use std::ops::Range;
use std::time::{Duration, Instant};
use unicode_width::UnicodeWidthStr;

pub const MAX_COPY_BYTES: usize = crate::terminal::MAX_CLIPBOARD_BYTES;
mod keyboard;
#[cfg(test)]
mod loading;
pub(super) mod rebase;
mod resolve;
use keyboard::{Caret, Extent};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyMode {
    Selection,
    Message,
    Source,
}
impl CopyMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Selection => "chat-copy-selection",
            Self::Message => "chat-copy-message",
            Self::Source => "chat-copy-source",
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Point {
    key: MessageKey,
    range: Range<usize>,
}
struct Drag {
    anchor: Point,
    position: (u16, u16),
    click: Option<Effect>,
    moved: bool,
    pointer: (u16, u16),
    edge: Option<(bool, Instant)>,
}
pub(super) struct Row {
    pub key: MessageKey,
    pub index: usize,
    pub area: Rect,
}
struct Segment {
    key: MessageKey,
    range: Range<usize>,
    text: String,
}

#[derive(Default)]
pub struct Selection {
    ranges: Vec<Segment>,
    drag: Option<Drag>,
    pub(super) rows: Vec<Row>,
    pub occluded: Option<Rect>,
    too_large: bool,
    area: Option<Rect>,
    extent: Option<Extent>,
    pending: Option<resolve::Resolution>,
    error: Option<&'static str>,
    validating: bool,
    keys: std::collections::VecDeque<crossterm::event::KeyCode>,
    movement: Option<keyboard::Pending>,
    loading: Option<MessageKey>,
}
impl Selection {
    pub(super) fn geometry_key(&self) -> Option<&MessageKey> {
        (!self.keys.is_empty())
            .then_some(self.loading.as_ref())
            .flatten()
    }
    pub(super) fn preparing_geometry(&self) -> bool {
        !self.keys.is_empty()
    }

    pub(super) fn retained_bytes(&self) -> usize {
        self.ranges
            .iter()
            .map(|segment| segment.text.len() + segment.key.bytes())
            .sum::<usize>()
            + self.loading.as_ref().map_or(0, MessageKey::bytes)
            + self
                .pending
                .as_ref()
                .and_then(|pending| pending.key.as_ref())
                .map_or(0, MessageKey::bytes)
            + self
                .movement
                .as_ref()
                .map_or(0, keyboard::Pending::retained_bytes)
            + self.keys.capacity() * std::mem::size_of::<crossterm::event::KeyCode>()
            + self.extent.as_ref().map_or(0, |extent| {
                extent.anchor.key.bytes() + extent.head.key.bytes()
            })
    }
    pub(super) fn suspend(&mut self) {
        self.validating = self.has_caret() || self.active();
        self.invalidate_geometry();
        self.rows = Vec::new();
    }
    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }
    pub fn end_drag(&mut self) {
        self.drag = None;
    }
    pub fn active(&self) -> bool {
        !self.ranges.is_empty()
            || self.pending.is_some()
            || self.error.is_some()
            || !self.keys.is_empty()
    }
    pub fn has_caret(&self) -> bool {
        self.extent.is_some()
    }
    pub fn clear(&mut self) {
        self.ranges.clear();
        self.drag = None;
        self.too_large = false;
        self.extent = None;
        self.pending = None;
        self.error = None;
        self.validating = false;
        self.keys.clear();
        self.movement = None;
        self.loading = None;
    }
    pub fn begin_frame(&mut self) {
        self.rows.clear();
        self.occluded = None;
        self.area = None;
    }
    pub fn invalidate_geometry(&mut self) {
        self.begin_frame();
        self.drag = None;
        self.movement = None;
        self.loading = None;
        if let Some(extent) = &mut self.extent {
            extent.column = None;
        }
    }
    pub(super) fn paint(
        &self,
        key: &MessageKey,
        visual: &layout::VisualLine,
        line: &mut Line<'static>,
        colors: crate::theme::Palette,
    ) {
        let Some(selected) = self.ranges.iter().find(|segment| &segment.key == key) else {
            return;
        };
        let ranges: Vec<_> = visual
            .mapping
            .iter()
            .filter_map(|span| {
                let start = span.logical.start.max(selected.range.start);
                let end = span.logical.end.min(selected.range.end);
                (start < end).then(|| {
                    let range = if span.logical.len() == span.display.len() {
                        span.display.start + start - span.logical.start
                            ..span.display.start + end - span.logical.start
                    } else {
                        span.display.clone()
                    };
                    (range, true)
                })
            })
            .collect();
        let style = colors.selected();
        search::paint(line, &ranges, [style, style]);
    }
}

impl Transcript {
    pub(super) fn selection_geometry(&mut self, area: Rect) {
        self.text_selection.area = Some(area);
        self.text_selection.rows.clear();
        if self.starts.len() != self.order.len() {
            return;
        }
        let first = self.starts.at(self.top);
        for index in first..self.order.len() {
            let start = self.starts.start(index);
            if start >= self.top + usize::from(area.height) {
                break;
            }
            let key = &self.order[index];
            let block = &self.blocks[key];
            if area.width <= 2 + block.indent
                || block.kind == Kind::Timing
                || !block.visual_current()
            {
                continue;
            }
            let offset = self.top.saturating_sub(start).max(block.visual_origin());
            let end = (block.visual_origin() + block.visual_lines().len())
                .min(self.top + usize::from(area.height) - start);
            for row in offset..end {
                if block
                    .visual_line(row)
                    .is_none_or(|line| line.mapping.is_empty())
                {
                    continue;
                }
                self.text_selection.rows.push(Row {
                    key: key.clone(),
                    index: row,
                    area: Rect::new(
                        area.x + (2 + block.indent).min(area.width),
                        area.y + (start + row - self.top) as u16,
                        area.width.saturating_sub(2 + block.indent),
                        1,
                    ),
                });
            }
        }
    }
    pub fn selection_wait(&self, now: Instant) -> Option<Duration> {
        let drag = self.text_selection.drag.as_ref()?;
        let (up, deadline) = drag.edge?;
        self.text_selection.area?;
        (drag.moved
            && if up {
                self.top > 0
            } else {
                self.top < self.total.saturating_sub(self.height)
            })
        .then(|| deadline.saturating_duration_since(now))
    }
    pub fn selection_scroll(&mut self, now: Instant) -> bool {
        let _work = frame_work::begin();
        if self.selection_wait(now) != Some(Duration::ZERO) {
            return false;
        }
        let drag = self.text_selection.drag.as_ref().unwrap();
        let (up, _) = drag.edge.unwrap();
        let pointer = drag.pointer;
        let anchor = drag.anchor.clone();
        let area = self.text_selection.area.unwrap();
        let distance = if up {
            area.y.saturating_sub(pointer.1)
        } else {
            pointer.1.saturating_sub(area.bottom().saturating_sub(1))
        };
        self.scroll(up, usize::from(distance.min(3)) + 1);
        // Reaching the tail while selecting must not switch to following new output.
        self.anchor = self.position(self.top);
        self.selected = Some(anchor.key.clone());
        self.selection_geometry(area);
        if let Some(head) = self.text_point(pointer.0, pointer.1, true) {
            self.select_text(&anchor, &head);
        }
        self.text_selection.drag.as_mut().unwrap().edge =
            Some((up, now + Duration::from_millis(60)));
        true
    }
    fn text_point(&self, column: u16, row: u16, clamp: bool) -> Option<Point> {
        let visible = self
            .text_selection
            .rows
            .iter()
            .filter(|line| clamp || line.area.y == row)
            .min_by_key(|line| line.area.y.abs_diff(row))?;
        let visual = self.blocks.get(&visible.key)?.visual_line(visible.index)?;
        let text = visual.line.to_string();
        let column = if clamp {
            column
                .saturating_sub(visible.area.x)
                .min(visual.line.width().saturating_sub(1) as u16)
        } else {
            if column < visible.area.x || column >= visible.area.x + visual.line.width() as u16 {
                return None;
            }
            column - visible.area.x
        };
        let mut cell = 0;
        let mut nearest = None;
        for (start, grapheme) in text.grapheme_indices(true) {
            let end = start + grapheme.len();
            let width = grapheme.width();
            let mut logical: Option<Range<usize>> = None;
            for span in &visual.mapping {
                let left = span.display.start.max(start);
                let right = span.display.end.min(end);
                if left >= right {
                    continue;
                }
                let range = if span.logical.len() == span.display.len() {
                    span.logical.start + left - span.display.start
                        ..span.logical.start + right - span.display.start
                } else {
                    span.logical.clone()
                };
                logical = Some(logical.map_or(range.clone(), |old| {
                    old.start.min(range.start)..old.end.max(range.end)
                }));
            }
            if let Some(range) = logical {
                let point = Point {
                    key: visible.key.clone(),
                    range,
                };
                if usize::from(column) < cell + width {
                    return Some(point);
                }
                nearest = Some(point);
            } else if !clamp && usize::from(column) < cell + width {
                return None;
            }
            cell += width;
        }
        clamp.then_some(nearest).flatten()
    }
    fn select_text(&mut self, anchor: &Point, head: &Point) {
        self.text_selection.keys.clear();
        self.text_selection.movement = None;
        self.text_selection.loading = None;
        let Some(a) = self.order.iter().position(|key| key == &anchor.key) else {
            return;
        };
        let Some(b) = self.order.iter().position(|key| key == &head.key) else {
            return;
        };
        let forward = (a, anchor.range.start) <= (b, head.range.start);
        self.select_extent(Extent {
            anchor: Caret {
                trailing: !forward,
                key: anchor.key.clone(),
                offset: if forward {
                    anchor.range.start
                } else {
                    anchor.range.end
                },
            },
            head: Caret {
                trailing: forward,
                key: head.key.clone(),
                offset: if forward {
                    head.range.end
                } else {
                    head.range.start
                },
            },
            column: None,
        });
    }
    /// None means this event belongs to another control. A plain click on a card is
    /// delayed until release, so dragging its text cannot accidentally fold it.
    pub fn text_mouse(
        &mut self,
        mouse: MouseEvent,
        click: Option<Effect>,
    ) -> Option<Option<Effect>> {
        let _work = frame_work::begin();
        if !self.text_selection.dragging()
            && self
                .text_selection
                .occluded
                .is_some_and(|area| area.contains((mouse.column, mouse.row).into()))
        {
            return None;
        }
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let point = self.text_point(mouse.column, mouse.row, false)?;
                self.text_selection.clear();
                let caret = Caret {
                    trailing: false,
                    key: point.key.clone(),
                    offset: point.range.start,
                };
                self.text_selection.extent = Some(Extent {
                    anchor: caret.clone(),
                    head: caret,
                    column: None,
                });
                self.selected = Some(point.key.clone());
                self.mouse_selected = true;
                self.anchor = self.position(self.top);
                self.text_selection.drag = Some(Drag {
                    anchor: point,
                    position: (mouse.column, mouse.row),
                    click,
                    moved: false,
                    pointer: (mouse.column, mouse.row),
                    edge: None,
                });
                Some(None)
            }
            MouseEventKind::Drag(MouseButton::Left) if self.text_selection.drag.is_some() => {
                let point = self.text_point(mouse.column, mouse.row, true);
                let drag = self.text_selection.drag.as_mut().unwrap();
                drag.moved |= (mouse.column, mouse.row) != drag.position;
                drag.pointer = (mouse.column, mouse.row);
                let edge = self.text_selection.area.and_then(|area| {
                    if mouse.row <= area.y {
                        Some(true)
                    } else if mouse.row >= area.bottom().saturating_sub(1) {
                        Some(false)
                    } else {
                        None
                    }
                });
                drag.edge = edge.map(|up| {
                    (
                        up,
                        drag.edge.filter(|(old, _)| *old == up).map_or_else(
                            || Instant::now() + Duration::from_millis(180),
                            |(_, deadline)| deadline,
                        ),
                    )
                });
                let anchor = drag.anchor.clone();
                if drag.moved
                    && let Some(point) = point
                {
                    self.select_text(&anchor, &point);
                }
                Some(None)
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let drag = self.text_selection.drag.take()?;
                Some((!drag.moved).then_some(drag.click).flatten())
            }
            MouseEventKind::Moved if self.text_selection.drag.is_some() => {
                self.text_selection.drag = None;
                Some(None)
            }
            _ => None,
        }
    }
    pub fn copy_text(&self, mode: CopyMode, ascii: bool) -> Result<String, &'static str> {
        let text = match mode {
            CopyMode::Selection => {
                if self.text_selection.too_large {
                    return Err("chat-copy-too-large");
                }
                if let Some(error) = self.text_selection.error {
                    return Err(error);
                }
                if self.text_selection.pending.is_some()
                    || self.text_selection.validating
                    || !self.text_selection.keys.is_empty()
                {
                    return Err("chat-copy-pending");
                }
                if !self.text_selection.active() {
                    return Err("chat-copy-empty");
                }
                self.text_selection
                    .ranges
                    .iter()
                    .map(|segment| segment.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            }
            CopyMode::Message | CopyMode::Source => {
                let key = self.selection().ok_or("chat-copy-empty")?;
                let block = &self.blocks[&key];
                if mode == CopyMode::Source {
                    if block.text.len() > MAX_COPY_BYTES {
                        return Err("chat-copy-too-large");
                    }
                    block.text.clone()
                } else if let Some(text) = block.message_text() {
                    if text.len() > MAX_COPY_BYTES {
                        return Err("chat-copy-too-large");
                    }
                    text.to_owned()
                } else if block.text.len() > MAX_COPY_BYTES {
                    return Err("chat-copy-pending");
                } else {
                    let document = if block.kind.markdown() {
                        layout::prepared::Document::markdown(&block.text, ascii, self.colors)
                    } else {
                        layout::prepared::Document::diff(
                            &block.text,
                            &block.changes,
                            ascii,
                            self.colors,
                        )
                    }
                    .map_err(|_| "chat-copy-unavailable")?;
                    document.text().to_owned()
                }
            }
        };
        if text.is_empty() {
            Err("chat-copy-empty")
        } else if text.len() > MAX_COPY_BYTES {
            Err("chat-copy-too-large")
        } else {
            Ok(text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Action;
    use crate::i18n::{Locale, LocalePreference};
    use crossterm::event::KeyModifiers;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn locale() -> I18n {
        I18n::new(LocalePreference::Explicit(Locale::En), Locale::En)
    }
    fn draw(view: &mut Transcript, width: u16) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            draw_at(view, width, 60);
            if view.motion_wait().is_none() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "transcript preparation must make progress"
            );
            std::thread::yield_now();
        }
    }
    fn draw_at(view: &mut Transcript, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|frame| {
                view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
    }
    fn position(view: &Transcript, key: &MessageKey, offset: usize) -> (u16, u16) {
        for row in &view.text_selection.rows {
            if &row.key != key {
                continue;
            }
            let visual = view.blocks[key].visual_line(row.index).unwrap();
            for span in &visual.mapping {
                if span.logical.contains(&offset) {
                    let byte = span.display.start
                        + if span.display.len() == span.logical.len() {
                            offset - span.logical.start
                        } else {
                            0
                        };
                    return (
                        row.area.x + visual.line.to_string()[..byte].width() as u16,
                        row.area.y,
                    );
                }
            }
        }
        panic!("logical offset {offset} is not visible");
    }
    fn mouse(kind: MouseEventKind, (column, row): (u16, u16)) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }
    fn drag(view: &mut Transcript, start: (u16, u16), end: (u16, u16)) {
        assert!(matches!(
            view.text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), start), None),
            Some(None)
        ));
        assert!(matches!(
            view.text_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), end), None),
            Some(None)
        ));
        assert!(matches!(
            view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), end), None),
            Some(None)
        ));
    }

    #[test]
    fn held_drag_copies_intermediate_messages_after_wheel_eviction() {
        let rows: BTreeMap<_, _> = (0..100)
            .map(|index| {
                (
                    index,
                    json!({
                        "id":format!("m{index}"),"turnId":"turn","type":"assistant",
                        "text":format!("item {index:03} 中文 🦀")
                    }),
                )
            })
            .collect();
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &locale(), false);
        view.focused = true;
        view.first();
        draw_at(&mut view, 50, 8);
        let first = MessageKey::durable(&rows[&0]);
        let start = position(&view, &first, 0);
        view.text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), start), None);
        for _ in 0..30 {
            view.scroll(false, 3);
            draw_at(&mut view, 50, 8);
        }
        assert!(
            view.blocks[&MessageKey::durable(&rows[&10])]
                .layout
                .is_none()
        );
        let last = view.text_selection.rows.last().unwrap().key.clone();
        let last_index = last
            .message()
            .strip_prefix('m')
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let text = rows[&last_index]["text"].as_str().unwrap();
        let end = position(&view, &last, text.len() - '🦀'.len_utf8());
        view.text_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), end), None);
        let expected = (0..=last_index)
            .map(|index| rows[&index]["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(
            view.copy_text(CopyMode::Selection, false).unwrap(),
            expected
        );
        draw_at(&mut view, 50, 8);
        assert!(
            view.blocks[&MessageKey::durable(&rows[&10])]
                .layout
                .is_none()
        );
        assert_eq!(
            view.copy_text(CopyMode::Selection, false).unwrap(),
            expected
        );
    }

    #[test]
    fn tool_status_updates_preserve_unchanged_body_selection_and_pending_clicks() {
        let key = MessageKey {
            turn: "turn".into(),
            message: "tool".into(),
            part: Part::Tool,
        };
        let body = "+literal 中文🦀";
        let update = |view: &mut Transcript, revision, header: &str, body: &str| {
            view.order.clear();
            let text = format!("{header}\n{body}");
            let start = header.len() + 1;
            let end = text.len();
            view.upsert(
                key.clone(),
                Revision::Durable(revision),
                Kind::Tool(if revision == 1 {
                    ToolState::Pending
                } else {
                    ToolState::Returned
                }),
                || Content {
                    text,
                    changes: vec![layout::diff::Row {
                        source: start..end,
                        kind: layout::diff::Kind::Added,
                        language: None,
                    }],
                    file: None,
                    emphasis: None,
                },
            );
        };
        for width in [80, 38] {
            let mut view = Transcript::default();
            update(&mut view, 1, "Patch · Running · created.txt", body);
            view.blocks.get_mut(&key).unwrap().folded = false;
            draw(&mut view, width);
            let start = view.blocks[&key]
                .layout
                .as_ref()
                .unwrap()
                .text
                .find(body)
                .unwrap();
            let point = position(&view, &key, start);
            view.text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), point), None);
            update(&mut view, 2, "Patch · created.txt", body);
            draw(&mut view, width);
            assert!(
                view.text_selection.dragging(),
                "late result must not lose an unchanged body"
            );
            let text = &view.blocks[&key].layout.as_ref().unwrap().text;
            let end = position(&view, &key, text.find('🦀').unwrap());
            view.text_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), end), None);
            view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), end), None);
            assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), body);
            update(&mut view, 3, "Patch · confirmed · created.txt", body);
            draw(&mut view, width);
            assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), body);
            let point = position(&view, &key, 0);
            let action = Effect::Disclosure(key.clone());
            view.text_mouse(
                mouse(MouseEventKind::Down(MouseButton::Left), point),
                Some(action.clone()),
            );
            update(&mut view, 4, "Patch · created.txt", body);
            draw(&mut view, width);
            assert_eq!(
                view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), point), None),
                Some(Some(action))
            );
            let text = &view.blocks[&key].layout.as_ref().unwrap().text;
            let a = position(&view, &key, text.find(body).unwrap());
            let b = position(&view, &key, text.find('🦀').unwrap());
            drag(&mut view, a, b);
            update(&mut view, 5, "Patch · created.txt", "changed");
            draw(&mut view, width);
            assert!(
                !view.text_selection.active(),
                "changed content cannot be copied as the old selection"
            );
        }
    }

    #[test]
    fn mouse_selection_copies_semantic_unicode_tables_and_links_across_reflow() {
        let source = "**中文🦀** e\u{301} 👩‍💻 wrap words here\n\n| Name | Count |\n| --- | ---: |\n| 中文🦀 | 7 |\n| other | 123 |\n\n[reference][r] then end\n\n[r]: https://example.test/path";
        let rows = BTreeMap::from([(
            1,
            json!({"id":"m", "turnId":"t", "type":"assistant", "text":source}),
        )]);
        let key = MessageKey::durable(&rows[&1]);
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &locale(), false);
        for width in [80, 20] {
            draw(&mut view, width);
            let text = view.blocks[&key].layout.as_ref().unwrap().text.clone();
            for needle in [
                "中文🦀 e\u{301} 👩‍💻 wrap words here",
                "Name\tCount\n中文🦀\t7\nother\t123",
                "https://example.test/path",
            ] {
                let start = text.find(needle).unwrap();
                let last = start + needle.grapheme_indices(true).next_back().unwrap().0;
                let a = position(&view, &key, start);
                let b = position(&view, &key, last);
                drag(&mut view, a, b);
                assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), needle);
                draw(&mut view, if width == 80 { 20 } else { 80 });
                assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), needle);
                draw(&mut view, width);
                // Reverse drag has identical inclusive grapheme boundaries.
                drag(&mut view, b, a);
                assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), needle);
            }
            let start = position(&view, &key, text.find('🦀').unwrap());
            drag(&mut view, start, (start.0 + 1, start.1));
            assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), "🦀");
        }
        let plain = view.copy_text(CopyMode::Message, false).unwrap();
        assert!(plain.contains("Name\tCount\n中文🦀\t7\nother\t123"));
        assert!(!plain.contains("**"));
        assert_eq!(view.copy_text(CopyMode::Source, false).unwrap(), source);
        let point = position(&view, &key, 0);
        let click = Effect::Disclosure(key.clone());
        view.text_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), point),
            Some(click),
        );
        assert!(matches!(
            view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), point), None),
            Some(Some(Effect::Disclosure(_)))
        ));
        view.text_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), point),
            Some(Effect::Disclosure(key.clone())),
        );
        view.text_mouse(
            mouse(
                MouseEventKind::Drag(MouseButton::Left),
                (point.0 + 1, point.1),
            ),
            None,
        );
        assert!(matches!(
            view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), point), None),
            Some(None)
        ));
        view.text_selection.occluded = Some(Rect::new(point.0, point.1, 5, 1));
        assert!(
            view.text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), point), None)
                .is_none()
        );
    }

    #[test]
    fn selection_freezes_during_append_and_prepends_but_rejects_changed_text_and_oversize() {
        let id = SessionAssistantStreamIdentity {
            kind: AssistantStreamKind::Text,
            turn_id: "t".into(),
            message_id: "m".into(),
        };
        let key = MessageKey::live(&id);
        let mut live = LiveText::default();
        live.text = "**selected 中文** tail".into();
        let mut live = vec![(id, live)];
        let mut view = Transcript::default();
        view.sync(&BTreeMap::new(), &live, 1, &locale(), false);
        draw(&mut view, 40);
        let a = position(&view, &key, 0);
        let b = position(&view, &key, "selected 中".len());
        drag(&mut view, a, b);
        live[0].1.text.push_str(" appended\n\nparagraph");
        let mut rows = BTreeMap::from([(
            0,
            json!({"id":"old", "turnId":"old", "type":"user", "text":"older history"}),
        )]);
        view.sync(&rows, &live, 2, &locale(), false);
        draw(&mut view, 20);
        assert_eq!(
            view.copy_text(CopyMode::Selection, false).unwrap(),
            "selected 中文"
        );
        let old = MessageKey::durable(&rows[&0]);
        view.select_text(
            &Point {
                key: old,
                range: 0..1,
            },
            &Point {
                key: key.clone(),
                range: 0..1,
            },
        );
        assert_eq!(
            view.copy_text(CopyMode::Selection, false).unwrap(),
            "older history\n\ns"
        );
        view.select_text(
            &Point {
                key: key.clone(),
                range: 0..1,
            },
            &Point {
                key: key.clone(),
                range: "selected 中".len().."selected 中文".len(),
            },
        );
        rows.insert(
            1,
            json!({"id":"m", "turnId":"t", "type":"assistant", "text":live[0].1.text}),
        );
        view.sync(&rows, &[], 3, &locale(), false);
        draw(&mut view, 40);
        assert_eq!(
            view.copy_text(CopyMode::Selection, false).unwrap(),
            "selected 中文"
        );
        // A replacement on a live stream must not silently copy stale or unrelated text.
        rows.remove(&1);
        live[0].1.text = "replacement".into();
        view.sync(&rows, &live, 4, &locale(), false);
        draw(&mut view, 40);
        assert_eq!(
            view.copy_text(CopyMode::Selection, false),
            Err("chat-copy-empty")
        );
        live[0].1.text = "x".repeat(MAX_COPY_BYTES + 1);
        view.sync(&rows, &live, 5, &locale(), false);
        draw(&mut view, 120);
        view.select_text(
            &Point {
                key: key.clone(),
                range: 0..1,
            },
            &Point {
                key: key.clone(),
                range: MAX_COPY_BYTES..MAX_COPY_BYTES + 1,
            },
        );
        assert_eq!(
            view.copy_text(CopyMode::Selection, false),
            Err("chat-copy-too-large")
        );
        view.selected = Some(key.clone());
        assert_eq!(
            view.copy_text(CopyMode::Source, false),
            Err("chat-copy-too-large")
        );
        view.select_text(
            &Point {
                key: key.clone(),
                range: 0..1,
            },
            &Point {
                key,
                range: MAX_COPY_BYTES - 1..MAX_COPY_BYTES,
            },
        );
        assert_eq!(
            view.copy_text(CopyMode::Selection, false).unwrap().len(),
            MAX_COPY_BYTES
        );
        view.text_selection.invalidate_geometry();
        assert!(view.text_selection.rows.is_empty());
        assert!(!view.text_selection.dragging());
        assert!(view.text_selection.active());
    }

    #[test]
    fn copy_is_scoped_to_visible_reader_and_modals_and_resize_cannot_leak_input() {
        use crate::{app::App, navigation::Route};
        use crossterm::event::{Event, KeyCode, KeyEvent};
        let mut app = App::new("/fixture".into(), locale());
        app.apply(Action::Visit(Route::Session("chat".into())));
        app.chat.select(&Route::Session("chat".into()));
        app.input(Event::Paste("keep draft".into()));
        let rows = BTreeMap::from([(
            1,
            json!({"id":"m", "turnId":"t", "type":"user", "text":"中文🦀"}),
        )]);
        let key = MessageKey::durable(&rows[&1]);
        app.chat.snapshot = Some(maka_protocol::subscription::decode_session_observation_snapshot(&json!({
            "schemaVersion":5,"session":{"sessionId":"chat","metadataRevision":1,"status":"active","createdAt":0,"isArchived":false},
            "projectionRevision":1,"rootTurn":null,"goal":null,
            "queue":{"hostEpoch":"epoch","queueRevision":0,"steering":[],"followup":[]},"interactions":{"pending":[]}
        })).unwrap());
        app.chat.fixture_rows(rows);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let start = position(&app.chat.view, &key, 0);
        let end = position(&app.chat.view, &key, "中文".len());
        for (kind, point) in [
            (MouseEventKind::Down(MouseButton::Left), start),
            (MouseEventKind::Drag(MouseButton::Left), end),
            (MouseEventKind::Up(MouseButton::Left), end),
        ] {
            assert!(app.input(Event::Mouse(mouse(kind, point))).1.is_none());
        }
        let copy = || Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        let escape = || Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        for (code, expected) in [(KeyCode::Left, "中文"), (KeyCode::Right, "中文🦀")] {
            app.input(Event::Key(KeyEvent::new(code, KeyModifiers::SHIFT)));
            assert_eq!(
                app.chat.view.copy_text(CopyMode::Selection, false).unwrap(),
                expected
            );
        }
        assert_eq!(app.input(copy()).1, Some(Action::Copy(CopyMode::Selection)));
        assert_eq!(app.focus, crate::app::Focus::Transcript);
        assert!(app.chat.view.mouse_selected);
        app.apply(Action::Palette);
        assert!(app.input(copy()).1.is_none());
        app.input(escape());
        assert!(app.chat.view.text_selection.active());
        app.apply(Action::ToggleDetails);
        assert!(app.input(copy()).1.is_none());
        app.apply(Action::ToggleDetails);
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(Event::Resize(40, 20));
        assert!(
            app.input(Event::Mouse(mouse(
                MouseEventKind::Down(MouseButton::Left),
                start
            )))
            .1
            .is_none()
        );
        assert!(!app.chat.view.text_selection.dragging());
        assert_eq!(app.input(copy()).1, Some(Action::Copy(CopyMode::Selection)));
        app.input(escape());
        assert!(!app.chat.view.text_selection.active());
        assert_eq!(app.navigation.current(), Route::Session("chat".into()));
        assert_eq!(app.drafts["chat"].text(), "keep draft");
        app.apply(Action::BrowseTranscript);
        app.apply(Action::Search(search::Command::Open));
        app.input(Event::Paste("中文".into()));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Left,
            KeyModifiers::SHIFT,
        )));
        app.input(Event::Paste("X".into()));
        assert_eq!(app.chat.view.search.as_ref().unwrap().editor.text(), "中X");
        assert!(!app.chat.view.text_selection.has_caret());
        assert_eq!(app.drafts["chat"].text(), "keep draft");
    }

    #[test]
    fn edge_drag_scrolls_on_deadlines_and_stops_at_bounds_release_and_focus_loss() {
        let text = (0..30)
            .map(|n| format!("line {n:02} 中文🦀\n"))
            .collect::<String>();
        let rows = BTreeMap::from([(
            1,
            json!({"id":"m", "turnId":"t", "type":"user", "text":text}),
        )]);
        let key = MessageKey::durable(&rows[&1]);
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &locale(), false);
        draw_at(&mut view, 40, 8);
        view.toggle(&key); // Read the long user prompt, which now defaults to a three-line preview.
        view.latest();
        draw_at(&mut view, 40, 8);
        view.scroll(true, 12);
        draw_at(&mut view, 40, 8);
        let start = (4, 3);
        view.text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), start), None);
        view.text_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), (4, 0)), None);
        let now = Instant::now();
        let wait = view.selection_wait(now).unwrap();
        assert!(wait > Duration::ZERO && wait <= Duration::from_millis(180));
        let before = view.top;
        assert!(!view.selection_scroll(now));
        let mut now = now + wait;
        assert!(view.selection_scroll(now));
        assert_eq!(view.top, before - 1);
        draw_at(&mut view, 40, 8);
        let first = view.copy_text(CopyMode::Selection, false).unwrap();
        now += Duration::from_millis(60);
        assert!(view.selection_scroll(now));
        draw_at(&mut view, 40, 8);
        assert!(
            view.copy_text(CopyMode::Selection, false)
                .unwrap()
                .ends_with(&first)
        );
        for _ in 0..30 {
            now += Duration::from_millis(60);
            view.selection_scroll(now);
            draw_at(&mut view, 40, 8);
        }
        assert_eq!(view.top, 0);
        assert!(
            view.selection_wait(now).is_none(),
            "no idle wakeups at the loaded edge"
        );
        view.text_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), (4, 7)), None);
        now += Duration::from_secs(1);
        assert!(view.selection_scroll(now));
        assert_eq!(view.top, 1);
        draw_at(&mut view, 40, 8);
        // Moving farther beyond the viewport accelerates, but is capped at four rows.
        view.text_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), (4, 100)),
            None,
        );
        now += Duration::from_millis(60);
        assert!(view.selection_scroll(now));
        assert_eq!(view.top, 5);
        for _ in 0..30 {
            now += Duration::from_millis(60);
            view.selection_scroll(now);
            draw_at(&mut view, 40, 8);
        }
        assert_eq!(view.top, view.total - view.height);
        assert!(view.selection_wait(now).is_none());
        assert!(
            !view.following(),
            "selection cannot start chasing appended output"
        );
        view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), (4, 100)), None);
        assert!(!view.text_selection.dragging());
        assert!(view.text_selection.active());
        let point = position(&view, &key, text.find("line 27").unwrap());
        view.text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), point), None);
        view.text_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), (point.0, 0)),
            None,
        );
        view.text_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), (point.0, 3)),
            None,
        );
        assert!(
            view.selection_wait(now).is_none(),
            "returning inside stops scrolling"
        );
        view.text_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), (point.0, 0)),
            None,
        );
        let mut app = crate::app::App::new("/fixture".into(), locale());
        app.apply(Action::Visit(crate::navigation::Route::Session(
            "chat".into(),
        )));
        app.chat
            .select(&crate::navigation::Route::Session("chat".into()));
        app.chat.view = view;
        assert!(app.selection_wait(now).is_some());
        app.input(crossterm::event::Event::FocusLost);
        assert!(app.selection_wait(now).is_none());
        assert!(!app.chat.view.text_selection.dragging());
        assert!(app.chat.view.text_selection.active());
        assert_eq!(
            app.input(crossterm::event::Event::FocusGained),
            (true, None)
        );
        draw_at(&mut app.chat.view, 40, 8);
        app.chat
            .view
            .text_mouse(mouse(MouseEventKind::Down(MouseButton::Left), point), None);
        app.chat.view.text_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), (point.0, 0)),
            None,
        );
        let preview = std::mem::take(&mut app.chat.view);
        app.chat.search_command(search::Command::Open);
        app.chat.search_command(search::Command::Scope);
        app.chat.history.as_mut().unwrap().preview = Some(preview);
        assert!(app.selection_wait(now).is_some());
        assert!(app.selection_scroll(now + Duration::from_secs(1)));
        assert_eq!(
            app.chat.view.top, 0,
            "preview scrolling cannot move the hidden main transcript"
        );
        app.input(crossterm::event::Event::Key(
            crossterm::event::KeyEvent::new(crossterm::event::KeyCode::F(12), KeyModifiers::NONE),
        ));
        assert!(
            app.selection_wait(now).is_none(),
            "keyboard input ends pointer capture"
        );
        assert!(app.chat.reader().unwrap().text_selection.active());
        app.apply(Action::ToggleDetails);
        assert!(app.selection_wait(now).is_none());
        assert!(!app.chat.reader().unwrap().text_selection.dragging());
    }
}
