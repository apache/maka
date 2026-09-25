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

use self::layout::Layout;
use crate::i18n::I18n;
use ratatui::{Frame, layout::Rect, widgets::Paragraph};
pub mod layout;
mod semantic;
pub(crate) mod streaming;
#[cfg(test)]
use crate::pages::chat::presentation::testing::*;
use ratatui::text::Line;
use ratatui::{
    style::{Color, Modifier, Style},
    text::Span,
};
pub use semantic::{Activity, Content, ToolState};
use std::collections::{HashMap, HashSet};
pub use timing::{Outcome, Timing};
use unicode_segmentation::UnicodeSegmentation;

mod groups;
mod navigation;
#[cfg(test)]
mod performance;
mod prompt;
pub mod reading;
mod reveal;
mod scrollbar;
pub mod search;
pub mod selection;
mod time;
mod timing;

#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(deny_unknown_fields)]
pub struct MessageKey {
    turn: String,
    message: String,
    part: Part,
}
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    Text,
    Thinking,
    Tool,
    Activity,
    /// A run of reasoning summaries folded under one row.
    Reasoning,
    Timing,
}
impl Part {
    /// The member part a folding summary row gathers, if this is one.
    fn members(self) -> Option<Self> {
        match self {
            Self::Activity => Some(Self::Tool),
            Self::Reasoning => Some(Self::Thinking),
            _ => None,
        }
    }
}
impl MessageKey {
    pub fn new(turn: impl Into<String>, message: impl Into<String>, part: Part) -> Self {
        Self {
            turn: turn.into(),
            message: message.into(),
            part,
        }
    }
    pub fn turn(&self) -> &str {
        &self.turn
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    pub fn part(&self) -> Part {
        self.part
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Revision {
    External(String),
    Durable(u64),
    Live(u64),
    Group {
        reads: usize,
        searches: usize,
        pending: usize,
    },
    Steps {
        count: usize,
        latest: Option<Box<Revision>>,
    },
    Tool {
        call: Option<u64>,
        result: Option<u64>,
        trace: bool,
    },
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    User,
    Assistant,
    Thinking,
    Tool(ToolState),
    Activity,
    /// Summary row of consecutive reasoning parts.
    Steps,
    Failure,
    Other,
    Meta,
    Timing,
}
impl Kind {
    fn folded(self) -> bool {
        matches!(
            self,
            Self::User
                | Self::Thinking
                | Self::Tool(_)
                | Self::Activity
                | Self::Steps
                | Self::Failure
                | Self::Other
        )
    }
    /// Folding summary rows always disclose their members.
    fn group(self) -> bool {
        matches!(self, Self::Activity | Self::Steps)
    }
    fn foldable(self) -> bool {
        !matches!(self, Self::Meta | Self::Timing)
    }
    fn markdown(self) -> bool {
        matches!(self, Self::Assistant | Self::Thinking)
    }
}
/// Mount-local intent. The shell resolves links against the selected record revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Disclosure(MessageKey),
    Link { key: MessageKey, revision: Revision },
}
#[derive(Clone)]
pub struct Hit {
    pub area: Rect,
    pub effect: Effect,
}
pub struct SelectedBlock<'a> {
    pub key: &'a MessageKey,
    pub revision: &'a Revision,
    pub text: &'a str,
}

struct Block {
    time: Option<String>,
    timestamp_ms: Option<u64>,
    time_date: Option<chrono::NaiveDate>,
    revision: Revision,
    kind: Kind,
    text: String,
    changes: Vec<layout::diff::Row>,
    file: Option<crate::files::Link>,
    emphasis: Option<std::ops::Range<usize>>,
    folded: bool,
    expandable: bool,
    layout: Option<Layout>,
    /// Layout row carrying the glyph, hits and timestamp; padding rows precede it.
    header: usize,
    dirty: bool,
    markdown: streaming::Markdown,
    reveal: reveal::Reveal,
    activity: Option<Activity>,
    indent: u16,
}
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Anchor {
    key: MessageKey,
    source: usize,
    screen_row: usize,
}

/// Cache by message identity, and retain a logical reading position across reflow.
#[derive(Default)]
pub struct Transcript {
    /// Deferred source reconciliation and painting can change saved bookmarks
    /// after the input/notification that requested the frame has completed.
    reading_changes: u64,
    scrollbar: scrollbar::Scrollbar,
    timings: HashMap<String, timing::Timing>,
    #[cfg(test)]
    active_turn: Option<String>,
    restore_folds: Option<HashMap<MessageKey, bool>>,
    relocate: bool,
    pub text_selection: selection::Selection,
    pub search: Option<search::Search>,
    time_date: Option<chrono::NaiveDate>,
    blocks: HashMap<MessageKey, Block>,
    order: Vec<MessageKey>,
    source_order: Vec<MessageKey>,
    groups: HashMap<MessageKey, Vec<MessageKey>>,
    membership: HashMap<MessageKey, MessageKey>,
    starts: Vec<usize>,
    total: usize,
    width: u16,
    height: usize,
    top: usize,
    anchor: Option<Anchor>,
    pub unseen: bool,
    pub trace: bool,
    pub colors: crate::theme::Palette,
    layout_colors: crate::theme::Palette,
    /// User bands get a padding row above and below when there is room.
    layout_padded: bool,
    pub hovered: Option<MessageKey>,
    selected: Option<MessageKey>,
    /// A body click targets a message without asking to reveal its header.
    pub mouse_selected: bool,
    pub focused: bool,
    search_commands: Vec<search::Command>,
    motion: Option<std::time::Instant>,
    motion_wait: Option<std::time::Duration>,
    live_update: bool,
    #[cfg(test)]
    test_presentation: crate::pages::chat::presentation::Presentation,
    #[cfg(test)]
    builds: usize,
    #[cfg(test)]
    measurement: Option<performance::DrawStats>,
}
impl Transcript {
    /// Changes to persisted reading metadata made by reconciliation or paint.
    /// Direct reading input remains the owning surface's ordinary state event.
    pub(crate) fn reading_changes(&self) -> u64 {
        self.reading_changes
    }

    /// Call before reconciliation and drawing, using the shell's motion policy.
    pub fn motion(&mut self, now: Option<std::time::Instant>) {
        self.motion = now;
        self.motion_wait = None;
        for block in self.blocks.values_mut() {
            block.reveal.expire(now);
        }
    }
    /// Only visible, source-bearing text requests another paint frame.
    pub fn motion_wait(&self) -> Option<std::time::Duration> {
        self.motion_wait
    }
    pub fn selected_file(&self) -> Option<&str> {
        self.blocks
            .get(&self.selection()?)?
            .file
            .as_ref()
            .map(|file| file.path.as_str())
    }
    pub fn invalidate(&mut self) {
        for block in self.blocks.values_mut() {
            block.layout = None;
        }
    }
    pub fn invalidate_labels(&mut self) {
        // Localized summaries must be projected again, but manual folds and anchors survive.
        for block in self.blocks.values_mut() {
            block.revision = Revision::Live(u64::MAX);
        }
        self.invalidate();
    }
    pub fn following(&self) -> bool {
        self.anchor.is_none()
    }
    pub fn needs_fill(&self) -> bool {
        self.height > 0 && self.total < self.height
    }
    pub fn at_top(&self) -> bool {
        self.top == 0
    }
    pub fn pause(&mut self) {
        if self.following() {
            self.anchor = self.position(self.top);
        }
    }
    pub fn discarded(&mut self, turn: &str, message: &str) {
        let matches = |key: &MessageKey| turn == key.turn && message == key.message;
        if self
            .anchor
            .as_ref()
            .is_some_and(|anchor| matches(&anchor.key))
        {
            self.relocate = true;
        }
        if self.selected.as_ref().is_some_and(matches) {
            self.selected = None;
        }
    }
    pub fn new_output(&mut self) {
        self.unseen |= !self.following();
    }
    pub fn latest(&mut self) {
        self.anchor = None;
        self.unseen = false;
        self.selected = None;
    }
    pub fn first_visible(&self) -> Option<MessageKey> {
        let first = self
            .starts
            .partition_point(|start| *start <= self.top)
            .saturating_sub(1);
        self.order
            .iter()
            .skip(first)
            .find(|key| self.blocks[*key].kind.foldable())
            .cloned()
    }
    pub fn contains(&self, key: &MessageKey) -> bool {
        self.blocks
            .get(key)
            .is_some_and(|block| block.kind.foldable())
    }
    pub fn folded(&self, key: &MessageKey) -> bool {
        self.blocks.get(key).is_some_and(|block| block.folded)
    }
    pub fn can_toggle(&self, key: &MessageKey) -> bool {
        self.blocks
            .get(key)
            .is_some_and(|block| block.kind.foldable() && block.expandable)
    }
    pub fn tool_status(&self, key: &MessageKey) -> Option<&'static str> {
        match self.blocks.get(key)?.kind {
            Kind::Tool(state) => Some(state.label()),
            _ => None,
        }
    }
    pub fn toggle(&mut self, key: &MessageKey) {
        // Folding is a reading action: keep this message on screen, rather than chase the tail.
        if let Some(block) = self
            .blocks
            .get_mut(key)
            .filter(|block| block.kind.foldable() && block.expandable)
        {
            // The header keeps its text across folding; anchor that, not the
            // block start, which may be a padding row without source text.
            let source = block
                .layout
                .as_ref()
                .and_then(|layout| layout.lines.get(block.header))
                .and_then(|line| line.mapping.first())
                .map_or(0, |span| span.source.start);
            let header = block.header;
            block.folded = !block.folded;
            block.layout = None;
            self.anchor = Some(Anchor {
                key: key.clone(),
                source,
                screen_row: self
                    .order
                    .iter()
                    .position(|candidate| candidate == key)
                    .and_then(|index| self.starts.get(index))
                    .map_or(0, |start| (start + header).saturating_sub(self.top)),
            });
        }
        self.arrange_groups();
    }
    pub fn scroll(&mut self, up: bool, amount: usize) {
        self.selected = None;
        let bottom = self.total.saturating_sub(self.height);
        self.top = if up {
            self.top.saturating_sub(amount)
        } else {
            self.top.saturating_add(amount).min(bottom)
        };
        if self.top == bottom {
            self.latest();
        } else {
            self.anchor = self.position(self.top);
        }
    }
    /// Anchor a screen row to the first source-bearing line at or below it.
    /// Blank, padding and gap rows have no identity of their own; snapping
    /// them to the text above made line-by-line scrolling skip or stall.
    fn position(&self, row: usize) -> Option<Anchor> {
        if self.starts.len() != self.order.len() {
            return None;
        }
        let index = self
            .starts
            .partition_point(|start| *start <= row)
            .saturating_sub(1);
        let below = (index..self.order.len()).find_map(|index| {
            let key = &self.order[index];
            let start = self.starts[index];
            let lines = &self.blocks.get(key)?.layout.as_ref()?.lines;
            let (line, span) = lines
                .iter()
                .enumerate()
                .skip(row.saturating_sub(start))
                .find_map(|(line, visual)| Some((line, visual.mapping.first()?)))?;
            Some(Anchor {
                key: key.clone(),
                source: span.source.start,
                screen_row: start + line - row,
            })
        });
        if below.is_some() {
            return below;
        }
        let key = self.order.get(index)?;
        let block = self.blocks.get(key)?;
        let layout = block.layout.as_ref()?;
        let line = layout
            .lines
            .get(row.saturating_sub(self.starts[index]))
            .or_else(|| layout.lines.last())?;
        Some(Anchor {
            key: key.clone(),
            source: line.source,
            screen_row: 0,
        })
    }
    pub fn upsert(
        &mut self,
        key: MessageKey,
        revision: Revision,
        kind: Kind,
        text: impl FnOnce() -> Content,
    ) {
        match self.blocks.get_mut(&key) {
            Some(block) if block.revision != revision || block.kind != kind => {
                if block.kind.foldable() != kind.foldable() {
                    self.reading_changes = self.reading_changes.wrapping_add(1);
                }
                let live = self.live_update
                    || matches!(revision, Revision::Live(_))
                    || matches!(block.revision, Revision::Live(_));
                block.revision = revision;
                let Content {
                    text,
                    changes,
                    file,
                    emphasis,
                } = text();
                if block.emphasis != emphasis {
                    block.dirty = true;
                }
                block.file = file;
                block.emphasis = emphasis;
                if block.kind != kind || block.text != text || block.changes != changes {
                    if block.kind != kind || !text.starts_with(&block.text) {
                        // Keep the old logical text until selection has been rebased.
                        block.markdown = Default::default();
                        block.reveal.clear();
                    } else if live && kind.markdown() {
                        block
                            .reveal
                            .append(block.text.len()..text.len(), self.motion);
                    }
                    block.dirty = true;
                    block.text = text;
                    block.changes = changes;
                }
                block.kind = kind;
            }
            None => {
                let restored = self
                    .restore_folds
                    .as_ref()
                    .is_some_and(|folds| folds.contains_key(&key));
                if kind.foldable() != restored {
                    self.reading_changes = self.reading_changes.wrapping_add(1);
                }
                let Content {
                    text,
                    changes,
                    file,
                    emphasis,
                } = text();
                let mut reveal = reveal::Reveal::default();
                if kind.markdown() && (self.live_update || matches!(revision, Revision::Live(_))) {
                    reveal.append(0..text.len(), self.motion);
                }
                self.blocks.insert(
                    key.clone(),
                    Block {
                        time: None,
                        timestamp_ms: None,
                        time_date: None,
                        revision,
                        kind,
                        text,
                        changes,
                        file,
                        emphasis,
                        folded: kind.folded(),
                        expandable: true,
                        layout: None,
                        header: 0,
                        dirty: false,
                        markdown: Default::default(),
                        reveal,
                        activity: None,
                        indent: 0,
                    },
                );
            }
            _ => {}
        }
        self.order.push(key);
    }
    /// Start a reconciliation in source order. Content closures run only for changed revisions.
    pub fn begin(&mut self) {
        // Positions belong to the last laid-out order, never to the records
        // about to replace it. Logical anchors and block caches remain valid.
        self.starts.clear();
        self.order.clear();
        self.time_date = Some(chrono::Local::now().date_naive());
        self.live_update = false;
    }
    /// A live resource update, as distinct from its initial snapshot or a page.
    pub fn begin_stream(&mut self) {
        self.begin();
        self.live_update = true;
    }
    pub fn metadata(
        &mut self,
        key: &MessageKey,
        timestamp_ms: Option<u64>,
        activity: Option<Activity>,
    ) {
        let Some(block) = self.blocks.get_mut(key) else {
            return;
        };
        block.activity = activity;
        if block.timestamp_ms == timestamp_ms && block.time_date == self.time_date {
            return;
        }
        block.timestamp_ms = timestamp_ms;
        block.time_date = self.time_date;
        let time = time::label(timestamp_ms);
        if block.time != time {
            block.time = time;
            block.layout = None;
        }
    }
    /// Retain supplied source records, reconcile local folds and preserve reading anchors.
    pub fn finish(&mut self, timings: impl IntoIterator<Item = Timing>, i18n: &I18n) {
        self.live_update = false;
        self.sync_timings(timings);
        self.source_order = std::mem::take(&mut self.order);
        self.reconcile_groups(i18n);
        let retained: HashSet<_> = self.source_order.iter().chain(self.groups.keys()).collect();
        let mut removed_fold = false;
        self.blocks.retain(|key, block| {
            let keep = retained.contains(key);
            removed_fold |= !keep && block.kind.foldable();
            keep
        });
        if removed_fold {
            self.reading_changes = self.reading_changes.wrapping_add(1);
        }
        if let Some(folds) = &mut self.restore_folds {
            folds.retain(|key, folded| {
                if let Some(block) = self.blocks.get_mut(key) {
                    block.folded = *folded;
                    block.layout = None;
                    false
                } else {
                    true
                }
            });
            if folds.is_empty() {
                self.restore_folds = None;
            }
        }
        self.arrange_groups();
        self.refresh_search(false);
        if self.relocate {
            self.relocate = false;
            let anchor = self.order.first().cloned().map(|key| Anchor {
                key,
                source: 0,
                screen_row: 0,
            });
            if self.anchor != anchor {
                self.reading_changes = self.reading_changes.wrapping_add(1);
                self.anchor = anchor;
            }
            self.top = 0;
        }
    }
    fn layout(&mut self, width: u16, ascii: bool, padded: bool) -> Result<(), &'static str> {
        if self.width != width || self.layout_colors != self.colors || self.layout_padded != padded
        {
            self.invalidate();
            self.width = width;
            self.layout_colors = self.colors;
            self.layout_padded = padded;
        }
        self.starts.clear();
        self.total = 0;
        let mut bytes = 0;
        for (index, key) in self.order.iter().enumerate() {
            let next = self.order.get(index + 1).map(|key| self.blocks[key].kind);
            let block = self.blocks.get_mut(key).expect("indexed block");
            if block.dirty || block.layout.is_none() {
                let selected_text = self
                    .text_selection
                    .references(key)
                    .then(|| block.layout.as_ref().map(|layout| layout.text.clone()))
                    .flatten();
                let time_width = if width >= 60 {
                    block.time.as_ref().map_or(0, |time| time.len() as u16 + 2)
                } else {
                    0
                };
                let body_width = width.saturating_sub(2 + block.indent + time_width).max(1);
                block.layout = Some(if block.folded && block.kind == Kind::User {
                    let (layout, expandable) = prompt::preview(&block.text, body_width, ascii)?;
                    block.expandable = expandable;
                    layout
                } else if block.folded {
                    let preview_width = body_width;
                    let mut nonempty = block.text.lines().filter(|line| !line.trim().is_empty());
                    let preview = nonempty.next().unwrap_or("");
                    let more_lines = nonempty.next().is_some();
                    let preview_start = block.text.find(preview).unwrap_or(0);
                    let first_len = preview.len();
                    // Inspect a bounded first-line preview, including Markdown
                    // syntax, to distinguish real omitted content from decoration.
                    let preview: String = preview
                        .graphemes(true)
                        .take(usize::from(preview_width) * 4 + 32)
                        .collect();
                    let mut layout = if block.kind.markdown() {
                        layout::markdown(&preview, preview_width, ascii)?
                    } else {
                        layout::plain(&preview, preview_width)?
                    };
                    block.expandable = block.kind.group()
                        || more_lines
                        || preview.len() < first_len
                        || layout
                            .lines
                            .iter()
                            .skip(1)
                            .any(|line| !line.line.to_string().trim().is_empty());
                    let clipped = layout.lines.len() > 1;
                    layout.lines.truncate(1);
                    // Whole-word wrapping can drop a word from a one-row preview;
                    // mark it rather than end on a silently shortened sentence.
                    let line = &mut layout.lines[0].line;
                    if clipped && line.width() < usize::from(preview_width) {
                        line.spans.push(Span::raw(if ascii { "." } else { "…" }));
                    }
                    let end = layout.lines[0]
                        .mapping
                        .iter()
                        .map(|span| span.logical.end)
                        .max()
                        .unwrap_or(0);
                    layout.text.truncate(end);
                    for line in &mut layout.lines {
                        line.source += preview_start;
                        for span in &mut line.mapping {
                            span.source.start += preview_start;
                            span.source.end += preview_start;
                        }
                    }
                    layout
                } else if block.kind.markdown() {
                    block.markdown.render(
                        &block.text,
                        body_width,
                        ascii,
                        block.layout.take(),
                        self.colors,
                    )?
                } else {
                    layout::diff::render_colored(
                        &block.text,
                        &block.changes,
                        body_width,
                        ascii,
                        self.colors,
                    )?
                });
                if !block.folded {
                    block.expandable = block.kind.group()
                        || block
                            .layout
                            .as_ref()
                            .unwrap()
                            .lines
                            .iter()
                            .skip(if block.kind == Kind::User { 3 } else { 1 })
                            .any(|line| !line.line.to_string().trim().is_empty());
                }
                if block.kind == Kind::Timing {
                    let layout = block.layout.as_mut().unwrap();
                    layout.text.clear();
                    for line in &mut layout.lines {
                        line.mapping.clear();
                    }
                }
                block.header = 0;
                if block.kind == Kind::User && padded {
                    // Band padding rows carry no source text, so selection,
                    // search and copy skip them like any other decoration.
                    let lines = &mut block.layout.as_mut().unwrap().lines;
                    let pad = |source| layout::VisualLine {
                        line: Line::default(),
                        source,
                        mapping: vec![],
                    };
                    let (first, last) = (lines[0].source, lines[lines.len() - 1].source);
                    lines.insert(0, pad(first));
                    lines.push(pad(last));
                    block.header = 1;
                }
                if let Some(previous) = selected_text {
                    self.text_selection.rebase(
                        key,
                        &previous,
                        &block.layout.as_ref().unwrap().text,
                    );
                }
                block.dirty = false;
                #[cfg(test)]
                {
                    self.builds += 1;
                }
            }
            let layout = block.layout.as_ref().unwrap();
            self.starts.push(self.total);
            self.total += layout.lines.len() + usize::from(gap_after(block, next));
            bytes += layout.bytes + block.markdown.syntax_bytes();
            if self.total > layout::MAX_LINES || bytes > layout::MAX_BYTES {
                return Err("Transcript layout exceeds local capacity");
            }
        }
        Ok(())
    }
    pub fn draw(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        ascii: bool,
    ) -> Result<Vec<Hit>, &'static str> {
        self.motion_wait = None;
        let outer = area;
        let area = Rect {
            width: area
                .width
                .saturating_sub(if area.width >= 6 { 2 } else { 0 }),
            ..area
        };
        self.update_timings(ascii, chrono::Utc::now().timestamp_millis());
        // Short viewports spend rows on content rather than band padding.
        #[cfg(test)]
        let layout_started = self.measurement.map(|_| std::time::Instant::now());
        self.layout(
            area.width,
            ascii,
            !self.colors.terminal && area.height >= 12,
        )?;
        #[cfg(test)]
        let after_layout = layout_started.map(|start| {
            let now = std::time::Instant::now();
            let stats = self.measurement.as_mut().unwrap();
            stats.layout_ns = now.duration_since(start).as_nanos();
            stats.visited_blocks = self.starts.len();
            now
        });
        self.validate_text_selection();
        self.text_selection.begin_frame();
        self.height = usize::from(area.height);
        let bottom = self.total.saturating_sub(self.height);
        self.top = if let Some(anchor) = &self.anchor {
            self.order
                .iter()
                .position(|key| *key == anchor.key)
                .map_or(self.top, |index| {
                    let layout = self.blocks[&anchor.key].layout.as_ref().unwrap();
                    let line = layout
                        .lines
                        .iter()
                        .position(|line| {
                            line.mapping
                                .iter()
                                .any(|span| span.source.contains(&anchor.source))
                        })
                        .or_else(|| {
                            layout
                                .lines
                                .iter()
                                .rposition(|line| line.source <= anchor.source)
                        })
                        .unwrap_or(0);
                    let screen_row = if anchor.screen_row < self.height {
                        anchor.screen_row
                    } else {
                        // A resize must not preserve an off-screen target row.
                        self.height / 3
                    };
                    (self.starts[index] + line).saturating_sub(screen_row)
                })
                .min(bottom)
        } else {
            bottom
        };
        if self.focused
            && let Some(key) = &self.selected
            && let Some(index) = self.order.iter().position(|candidate| candidate == key)
        {
            let start = self.starts[index];
            let top = if start < self.top {
                start
            } else if start >= self.top + self.height {
                start.saturating_sub(self.height.saturating_sub(1))
            } else {
                self.top
            }
            .min(bottom);
            if top != self.top {
                self.top = top;
                let anchor = self.position(top);
                if self.anchor != anchor {
                    self.reading_changes = self.reading_changes.wrapping_add(1);
                    self.anchor = anchor;
                }
            }
        }
        self.selection_geometry(area);
        let mut lines = Vec::with_capacity(self.height);
        let selected = self.focused.then(|| self.selection()).flatten();
        let mut hits = vec![];
        let first = self
            .starts
            .partition_point(|start| *start <= self.top)
            .saturating_sub(1);
        for index in first..self.order.len() {
            let key = &self.order[index];
            let block = &self.blocks[key];
            let layout = block.layout.as_ref().unwrap();
            let offset = self.top.saturating_sub(self.starts[index]);
            let next = self.order.get(index + 1).map(|key| self.blocks[key].kind);
            let height = layout.lines.len() + usize::from(gap_after(block, next));
            let focused = selected.as_ref() == Some(key);
            let gutter = 2 + block.indent;
            for row in offset..height {
                if lines.len() >= self.height {
                    break;
                }
                let y = area.y + lines.len() as u16;
                let visual = layout.lines.get(row);
                if let Some((x, color)) = visual.and(self.fill(block, row)) {
                    let x = area.x + x.min(area.width);
                    frame.render_widget(
                        ratatui::widgets::Block::default().style(Style::default().bg(color)),
                        Rect::new(x, y, area.right() - x, 1),
                    );
                }
                let mut line = visual.map_or_else(Line::default, |visual| {
                    self.styled(block, key, row, visual.line.clone())
                });
                if let Some(visual) = visual
                    && let Some(wait) =
                        block
                            .reveal
                            .paint(visual, &mut line, self.motion, self.colors)
                {
                    self.motion_wait = Some(self.motion_wait.map_or(wait, |old| old.min(wait)));
                }
                if let Some(search) = &self.search
                    && let Some(visual) = visual
                {
                    search.highlight(key, visual, &mut line, self.colors);
                }
                if let Some(visual) = visual {
                    self.text_selection
                        .paint(key, visual, &mut line, self.colors);
                }
                if row == block.header {
                    if focused {
                        line =
                            line.patch_style(Style::default().add_modifier(Modifier::UNDERLINED));
                    }
                    if let Some(bytes) =
                        visual
                            .zip(block.emphasis.as_ref())
                            .and_then(|(visual, emphasis)| {
                                visual
                                    .mapping
                                    .iter()
                                    .filter_map(|span| span.intersection(emphasis))
                                    .reduce(|a, b| a.start.min(b.start)..a.end.max(b.end))
                            })
                    {
                        crate::files::restyle(
                            &mut line,
                            bytes,
                            Style::default().add_modifier(Modifier::BOLD),
                        );
                    }
                    if block.kind.foldable() && block.expandable && area.width > block.indent {
                        hits.push(Hit {
                            area: Rect::new(area.x + block.indent, y, area.width - block.indent, 1),
                            effect: Effect::Disclosure(key.clone()),
                        });
                    }
                    if let Some(file) = &block.file
                        && let Some(visual) = visual
                        && let Some(bytes) = visual
                            .mapping
                            .iter()
                            .filter_map(|span| span.intersection(&file.source))
                            .reduce(|a, b| a.start.min(b.start)..a.end.max(b.end))
                    {
                        let columns = crate::files::paint(&mut line, bytes, self.colors);
                        hits.push(Hit {
                            area: Rect::new(
                                area.x + gutter + columns.start as u16,
                                y,
                                (columns.end - columns.start) as u16,
                                1,
                            )
                            .intersection(area),
                            effect: Effect::Link {
                                key: key.clone(),
                                revision: block.revision.clone(),
                            },
                        });
                    }
                }
                line.spans
                    .insert(0, self.gutter(key, block, row, focused, ascii));
                let time = block
                    .time
                    .as_ref()
                    .filter(|_| row == block.header && area.width >= 60);
                // Code bands continue under the timestamp column, like tool panels.
                if let Some(style) =
                    line.spans.last().map(|span| span.style).filter(|style| {
                        style.bg == Some(self.colors.panel()) && !self.colors.terminal
                    })
                {
                    let end = usize::from(area.width)
                        .saturating_sub(time.map_or(0, |time| time.len() + 1));
                    let width = line.width();
                    line.spans
                        .push(Span::styled(" ".repeat(end.saturating_sub(width)), style));
                }
                if let Some(time) = time {
                    let gap = usize::from(area.width).saturating_sub(line.width() + time.len() + 1);
                    line.spans.push(Span::raw(" ".repeat(gap)));
                    line.spans.push(Span::styled(
                        time.clone(),
                        Style::default().fg(self.colors.subtle),
                    ));
                }
                lines.push(line);
            }
            if lines.len() >= self.height {
                break;
            }
        }
        #[cfg(test)]
        if let Some(stats) = &mut self.measurement {
            stats.painted_rows = lines.len();
        }
        frame.render_widget(Paragraph::new(lines), area);
        self.draw_scrollbar(frame, outer, ascii);
        #[cfg(test)]
        if let Some(start) = after_layout {
            self.measurement.as_mut().unwrap().after_layout_ns = start.elapsed().as_nanos();
        }
        Ok(hits)
    }
    /// Role styling of one laid-out row, before search, selection and gutter.
    fn styled(
        &self,
        block: &Block,
        key: &MessageKey,
        row: usize,
        line: Line<'static>,
    ) -> Line<'static> {
        let header = row == block.header;
        let line = match block.kind {
            Kind::Tool(state) if header && state.problem() => {
                line.style(Style::default().fg(state.color(self.colors)))
            }
            Kind::Thinking | Kind::Steps => {
                let mut line = line;
                for span in &mut line.spans {
                    span.style.fg = Some(self.colors.thinking);
                    span.style = span.style.remove_modifier(Modifier::BOLD);
                }
                line
            }
            Kind::User if self.colors.terminal => {
                line.style(Style::default().add_modifier(Modifier::BOLD))
            }
            Kind::User => line.style(Style::default().bg(self.colors.surface)),
            Kind::Failure if header => line.style(Style::default().fg(self.colors.error)),
            // Collapsed activity recedes like grok's summary rows; an open
            // header is what the reader is inspecting, so it stays brighter.
            Kind::Tool(_) | Kind::Activity | Kind::Meta if block.folded => {
                line.style(Style::default().fg(self.colors.subtle))
            }
            Kind::Tool(_) | Kind::Activity | Kind::Meta if header => {
                line.style(Style::default().fg(self.colors.muted))
            }
            _ => line,
        };
        if key.part == Part::Timing {
            line.style(Style::default().fg(self.timing_color(&key.turn)))
        } else {
            line
        }
    }
    /// Background band for a row, as (first column, color). User bands span the
    /// gutter; recessed detail panels start at the content column.
    fn fill(&self, block: &Block, row: usize) -> Option<(u16, Color)> {
        if self.colors.terminal {
            return None;
        }
        match block.kind {
            Kind::User => Some((0, self.colors.surface)),
            Kind::Tool(_) | Kind::Failure | Kind::Other if !block.folded && row > block.header => {
                Some((2 + block.indent, self.colors.panel()))
            }
            _ => None,
        }
    }
    /// Header rows carry a role glyph, replaced by a disclosure while the
    /// pointer or keyboard is on an expandable block. Expanded details keep a
    /// rail in the same column, so folding never shifts content horizontally.
    fn gutter(
        &self,
        key: &MessageKey,
        block: &Block,
        row: usize,
        focused: bool,
        ascii: bool,
    ) -> Span<'static> {
        let indent = " ".repeat(usize::from(block.indent));
        let lines = block.layout.as_ref().map_or(0, |layout| layout.lines.len());
        let problem = match block.kind {
            Kind::Tool(state) if state.problem() => Some(state.color(self.colors)),
            Kind::Failure => Some(self.colors.error),
            _ => None,
        };
        let (glyph, color) = if row == block.header {
            // A block folded against its kind's default (a hidden answer) must
            // say so at rest; summaries folded by default keep their bullet.
            let disclosure = block.kind.foldable()
                && block.expandable
                && (focused
                    || self.hovered.as_ref() == Some(key)
                    || (block.folded && !block.kind.folded()));
            let glyph = match (disclosure, block.folded, block.kind, ascii) {
                (true, true, _, false) => "▸",
                (true, false, _, false) => "▾",
                (true, true, _, true) => ">",
                (true, false, _, true) => "v",
                (false, _, Kind::User, false) => "❯",
                (false, _, Kind::User, true) => ">",
                (false, _, Kind::Assistant | Kind::Timing | Kind::Meta, _) => " ",
                (false, _, Kind::Activity, false) => "◈",
                (false, _, _, false) => "◆",
                (false, _, _, true) => "*",
            };
            let color = match block.kind {
                _ if focused => self.colors.accent,
                Kind::Tool(state) => state.color(self.colors),
                Kind::User => self.colors.accent,
                _ => problem.unwrap_or(self.colors.subtle),
            };
            (glyph, color)
        } else if row < lines
            && !block.folded
            && block.kind.foldable()
            && !matches!(block.kind, Kind::User | Kind::Assistant)
        {
            (
                if ascii { "|" } else { "│" },
                problem.unwrap_or(self.colors.border),
            )
        } else {
            (" ", self.colors.subtle)
        };
        Span::styled(format!("{indent}{glyph} "), Style::default().fg(color))
    }
}

fn gap_after(block: &Block, next: Option<Kind>) -> bool {
    matches!(
        block.kind,
        Kind::User | Kind::Assistant | Kind::Failure | Kind::Timing
    ) || (block.kind.foldable() && block.expandable && !block.folded && !block.kind.group())
        || (matches!(
            block.kind,
            Kind::Tool(_) | Kind::Activity | Kind::Steps | Kind::Thinking
        ) && matches!(next, Some(Kind::User | Kind::Assistant)))
}

#[cfg(test)]
impl Transcript {
    pub(crate) fn sync(
        &mut self,
        rows: &BTreeMap<u64, Value>,
        live: &[(SessionAssistantStreamIdentity, LiveText)],
        revision: u64,
        i18n: &I18n,
        ascii: bool,
    ) {
        let mut presentation = std::mem::take(&mut self.test_presentation);
        presentation.active_turn = self.active_turn.clone();
        presentation.sync(self, rows, live, revision, i18n, ascii);
        self.test_presentation = presentation;
    }
    fn selected_branch_point(&self) -> Option<(&str, &str)> {
        self.test_presentation.branch_point(self)
    }
}
#[cfg(test)]
impl MessageKey {
    fn durable(row: &Value) -> Self {
        crate::pages::chat::presentation::durable(row)
    }
    fn live(id: &SessionAssistantStreamIdentity) -> Self {
        crate::pages::chat::presentation::live_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;
    pub(super) fn locale() -> I18n {
        I18n::new(LocalePreference::Explicit(Locale::En), Locale::En)
    }
    pub(super) fn render(
        view: &mut Transcript,
        terminal: &mut Terminal<TestBackend>,
    ) -> Result<(), String> {
        let mut result = Ok(());
        terminal
            .draw(|frame| {
                result = view.draw(frame, frame.area(), false).map(|_| ());
            })
            .map_err(|error| error.to_string())?;
        result.map_err(str::to_owned)
    }
    fn draw(view: &mut Transcript, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        render(view, &mut terminal).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .enumerate()
            // Compare reading content; the thumb legitimately moves as history grows.
            .filter(|(index, _)| index % usize::from(width) < usize::from(width.saturating_sub(2)))
            .map(|(_, cell)| cell)
            .map(|cell| cell.symbol())
            .collect()
    }
    fn message(id: &str, text: &str) -> Value {
        json!({"turnId":"turn","id":id,"type":"user","text":text})
    }
    #[test]
    fn semantic_source_reconciles_opaque_revisions_without_rebuilding_unchanged_content() {
        let mut view = Transcript::default();
        let first = MessageKey::new("source", "a", Part::Thinking);
        let second = MessageKey::new("source", "b", Part::Thinking);
        for (revision, title) in [("one", "Initial title"), ("two", "Updated title")] {
            view.begin();
            view.upsert(
                first.clone(),
                Revision::External("stable".into()),
                Kind::Thinking,
                || "First step".to_owned().into(),
            );
            view.upsert(
                second.clone(),
                Revision::External(revision.into()),
                Kind::Thinking,
                || title.to_owned().into(),
            );
            view.finish([], &locale());
            let group = view.order[0].clone();
            assert_eq!(group.part(), Part::Reasoning);
            assert!(draw(&mut view, 80, 12).contains(title));
            let builds = view.builds;
            view.begin();
            view.upsert(
                first.clone(),
                Revision::External("stable".into()),
                Kind::Thinking,
                || panic!("unchanged content must remain cached"),
            );
            view.upsert(
                second.clone(),
                Revision::External(revision.into()),
                Kind::Thinking,
                || panic!("opaque revisions are equality identities"),
            );
            view.finish([], &locale());
            draw(&mut view, 80, 12);
            assert_eq!(view.builds, builds);
            assert_eq!(view.order[0], group);
        }
    }

    #[test]
    fn navigating_a_replacement_page_before_layout_never_reuses_old_line_positions() {
        let mut view = Transcript {
            focused: true,
            ..Default::default()
        };
        for (start, count) in [(0, 48), (48, 256), (0, 3)] {
            view.begin();
            for index in start..start + count {
                view.upsert(
                    MessageKey::new("history", format!("entry-{index}"), Part::Text),
                    Revision::External("one".into()),
                    Kind::Assistant,
                    || format!("Entry {index}\nSome history text.").into(),
                );
            }
            view.finish([], &locale());
            view.first();
            let screen = draw(&mut view, 60, 12);
            assert!(screen.contains(&format!("Entry {start}")), "{screen}");
            view.latest();
            draw(&mut view, 60, 12);
            view.pause();
        }
    }

    #[test]
    fn markdown_styles_reach_chat_and_palette_changes_keep_content_and_copy() {
        let source = "# Heading\n\n**bold** and ~~obsolete~~ and `inline`\n\n```rust\nfn main() { println!(\"hello\", 42); }\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |\n";
        let row = json!({"turnId":"turn","id":"reply","type":"assistant","text":source});
        let key = MessageKey::durable(&row);
        let mut view = Transcript::default();
        view.sync(&BTreeMap::from([(1, row)]), &[], 0, &locale(), false);
        view.select(key.clone());
        let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();
        let mut previous_text = None;
        use crate::theme::Choice;
        for theme in [
            Choice::Maka,
            Choice::Dusk,
            Choice::Paper,
            Choice::Terminal,
            Choice::Maka,
        ] {
            view.colors = theme.colors();
            terminal
                .draw(|frame| {
                    view.draw(frame, frame.area(), false).unwrap();
                })
                .unwrap();
            let cells = terminal.backend().buffer();
            let cell_for = |text: &str| {
                cells
                    .content
                    .chunks(80)
                    .find_map(|row| {
                        row.windows(text.len())
                            .find(|cells| {
                                cells
                                    .iter()
                                    .zip(text.chars())
                                    .all(|(cell, ch)| cell.symbol() == ch.to_string())
                            })
                            .map(|cells| &cells[0])
                    })
                    .unwrap()
            };
            assert!(cell_for("Heading").modifier.contains(Modifier::BOLD));
            assert!(cell_for("bold").modifier.contains(Modifier::BOLD));
            assert!(
                cell_for("obsolete")
                    .modifier
                    .contains(Modifier::CROSSED_OUT)
            );
            assert_eq!(cell_for("fn").fg, view.colors.syntax[0]);
            assert_eq!(cell_for("fn").bg, view.colors.panel());
            let code_row = cells
                .content
                .chunks(80)
                .find(|row| {
                    row.windows(2)
                        .any(|cells| cells[0].symbol() == "f" && cells[1].symbol() == "n")
                })
                .unwrap();
            assert_eq!(
                code_row[0].bg,
                Color::Reset,
                "panel must not color the chat gutter"
            );
            assert_eq!(code_row[1].bg, Color::Reset);
            assert_ne!(cell_for("hello").fg, cell_for("fn").fg);
            assert!(!view.folded(&key));
            let copy = view.copy_text(selection::CopyMode::Message, false).unwrap();
            assert!(copy.contains("fn main() { println!(\"hello\", 42); }"));
            assert!(!copy.contains("```"));
            assert!(!copy.contains('╭') && !copy.contains('│') && !copy.contains('╯'));
            if let Some(previous) = &previous_text {
                assert_eq!(previous, &copy);
            }
            previous_text = Some(copy);
            assert_eq!(
                view.copy_text(selection::CopyMode::Source, false).unwrap(),
                source
            );
        }
    }
    #[test]
    fn history_cache_and_source_anchor_survive_streaming_prepends_and_reflow() {
        let mut view = Transcript::default();
        let i18n = locale();
        let mut rows: BTreeMap<_, _> = (1..=20)
            .map(|n| {
                (
                    n,
                    message(
                        &format!("m{n}"),
                        &format!("line {n}: {}", "中文 abc 🦀 ".repeat(5)),
                    ),
                )
            })
            .collect();
        view.sync(&rows, &[], 0, &i18n, false);
        draw(&mut view, 40, 8);
        assert_eq!(view.builds, 20);
        view.scroll(true, 12);
        let expected = view.anchor.clone().unwrap();
        let before = draw(&mut view, 40, 8);
        let stream_id = SessionAssistantStreamIdentity {
            kind: AssistantStreamKind::Text,
            turn_id: "turn".into(),
            message_id: "live".into(),
        };
        let mut stream = LiveText::default();
        stream.text = "tail\n".repeat(50);
        let mut live = vec![(stream_id, stream)];
        view.new_output();
        view.sync(&rows, &live, 1, &i18n, false);
        assert_eq!(draw(&mut view, 40, 8), before);
        assert_eq!(
            view.builds, 21,
            "streaming must not re-layout completed history"
        );
        assert!(view.unseen && !view.following());
        live[0].1.text.push_str("\n\nmore output");
        view.sync(&rows, &live, 2, &i18n, false);
        assert_eq!(draw(&mut view, 40, 8), before);
        assert_eq!(view.builds, 22);
        rows.insert(0, message("older", &"previous page\n".repeat(30)));
        view.sync(&rows, &live, 2, &i18n, false);
        assert_eq!(draw(&mut view, 40, 8), before);
        assert_eq!(view.builds, 23);
        draw(&mut view, 25, 9);
        let actual = view.position(view.top).unwrap();
        assert_eq!(actual.key, expected.key);
        assert!(actual.source <= expected.source);
        assert_eq!(view.anchor.as_ref().unwrap().source, expected.source);
        assert_eq!(
            draw(&mut view, 40, 8),
            before,
            "reflow back restores the logical reading position"
        );
        view.latest();
        let tail = draw(&mut view, 40, 8);
        assert!(tail.contains("more output"));
        assert!(view.following() && !view.unseen);
    }

    #[test]
    fn manual_folds_survive_live_to_durable_and_locale_changes_without_mutating_source() {
        let mut view = Transcript::default();
        let i18n = locale();
        let id = SessionAssistantStreamIdentity {
            kind: AssistantStreamKind::Text,
            turn_id: "turn".into(),
            message_id: "stream".into(),
        };
        let key = MessageKey::live(&id);
        let mut stream = LiveText::default();
        stream.text = "**Summary**\n\nHidden detail\n\n```rust\nlet x = 1;".into();
        let mut live = vec![(id, stream)];
        view.sync(&BTreeMap::new(), &live, 1, &i18n, false);
        assert!(draw(&mut view, 60, 12).contains("Hidden detail"));
        view.toggle(&key);
        assert!(!draw(&mut view, 60, 12).contains("Hidden detail"));
        live[0].1.text.push_str("\n```\n\nFinal detail");
        view.sync(&BTreeMap::new(), &live, 2, &i18n, false);
        assert!(!draw(&mut view, 60, 12).contains("Final detail"));
        let rows = BTreeMap::from([(
            1,
            json!({"id":"stream","turnId":"turn","type":"assistant","text":live[0].1.text}),
        )]);
        view.sync(&rows, &[], 2, &i18n, false);
        view.invalidate_labels();
        view.sync(&rows, &[], 2, &i18n, true);
        assert!(view.folded(&key));
        view.toggle(&key);
        assert!(draw(&mut view, 60, 12).contains("Final detail"));
        assert_eq!(view.blocks[&key].text, live[0].1.text);
        assert_eq!(
            view.blocks.len(),
            1,
            "durability replaces the same message, not a duplicate"
        );
    }

    #[test]
    fn thinking_uses_content_without_role_prefix_and_animation_redraw_reuses_layout() {
        let text = "**Inspect** 中文🦀\n\nDetails stay available.";
        let mut rows = BTreeMap::from([(
            1,
            json!({"id":"thought","turnId":"turn","type":"assistant","modelId":"unknown-model-with-no-capability-declaration","thinking":{"text":text}}),
        )]);
        rows.insert(
            2,
            json!({"id":"blank","turnId":"turn","type":"assistant","thinking":{"text":" \n "}}),
        );
        let mut view = Transcript::default();
        for locale in Locale::ALL {
            let i18n = I18n::new(LocalePreference::Explicit(locale), locale);
            view.sync(&rows, &[], 0, &i18n, false);
            assert_eq!(
                view.order.len(),
                1,
                "blank reasoning must not create an empty caption"
            );
            let key = view.order[0].clone();
            if !view.folded(&key) {
                view.toggle(&key);
            }
            let rendered = draw(&mut view, 60, 8);
            let block = &view.blocks[&key];
            assert_eq!(block.text, text);
            let layout = block.layout.as_ref().unwrap();
            let line = &layout.lines[0];
            let display = line.line.to_string();
            assert!(display.starts_with("Inspect 中文🦀"), "{display:?}");
            for span in &line.mapping {
                assert_eq!(
                    &display[span.display.clone()],
                    &layout.text[span.logical.clone()]
                );
            }
            let builds = view.builds;
            assert_eq!(draw(&mut view, 60, 8), rendered);
            assert_eq!(
                view.builds, builds,
                "activity frames must reuse transcript layout"
            );
            view.toggle(&key);
            assert!(draw(&mut view, 60, 8).contains("Details stay available."));
        }
        let rows = BTreeMap::from([(
            1,
            json!({"id":"only-title","turnId":"turn","type":"assistant","thinking":{"text":"**A short summary**\n\n"}}),
        )]);
        view.sync(&rows, &[], 0, &locale(), false);
        let key = MessageKey::durable(&rows[&1]);
        let rendered = draw(&mut view, 60, 8);
        assert!(rendered.contains("A short summary") && !rendered.contains('▸'));
        assert!(!view.can_toggle(&key));
        view.toggle(&key);
        assert_eq!(draw(&mut view, 60, 8), rendered);
        draw(&mut view, 8, 8);
        assert!(
            view.can_toggle(&key),
            "wrapped/truncated content still has a disclosure"
        );
        draw(&mut view, 60, 8);
        assert!(
            !view.can_toggle(&key),
            "resize must recompute the disclosure"
        );
    }

    #[test]
    fn header_clicks_toggle_on_release_drag_selects_and_restored_focus_preserves_failure_color() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        let rows = BTreeMap::from([
            (
                1,
                json!({"id":"failure","turnId":"failed-turn","type":"turn_state","status":"failed"}),
            ),
            (
                2,
                json!({"id":"thought","turnId":"next","type":"assistant","thinking":{"text":"Summary header\n\nMore detail."}}),
            ),
        ]);
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &locale(), false);
        let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|f| hits = view.draw(f, f.area(), false).unwrap())
            .unwrap();
        let key = MessageKey::durable(&rows[&2]);
        let hit = hits
            .iter()
            .find(|hit| hit.effect == Effect::Disclosure(key.clone()))
            .unwrap();
        assert_eq!(
            hit.area.width, 58,
            "the whole title row, excluding the scrollbar gutter, is clickable"
        );
        let mouse = |kind, x| MouseEvent {
            kind,
            column: x,
            row: hit.area.y,
            modifiers: KeyModifiers::NONE,
        };
        let x = hit.area.x + 5;
        assert!(
            view.text_mouse(
                mouse(MouseEventKind::Down(MouseButton::Left), x),
                Some(hit.effect.clone())
            )
            .unwrap()
            .is_none()
        );
        assert!(
            view.folded(&key),
            "pressing text must not interfere with dragging"
        );
        assert_eq!(
            view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), x), None)
                .unwrap(),
            Some(hit.effect.clone())
        );
        view.toggle(&key);
        terminal
            .draw(|f| {
                view.draw(f, f.area(), false).unwrap();
            })
            .unwrap();
        view.text_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), x),
            Some(hit.effect.clone()),
        );
        view.text_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), x + 3), None);
        assert!(
            view.text_mouse(mouse(MouseEventKind::Up(MouseButton::Left), x + 3), None)
                .unwrap()
                .is_none()
        );
        assert!(view.text_selection.active());
        assert!(!view.folded(&key));

        let failure = MessageKey::durable(&rows[&1]);
        view.select(failure);
        let mut resumed = Transcript::resume(view.take_reading());
        resumed.sync(&rows, &[], 0, &locale(), false);
        for focused in [true, false, true] {
            resumed.focused = focused;
            terminal
                .draw(|f| {
                    resumed.draw(f, f.area(), false).unwrap();
                })
                .unwrap();
            let cell = &terminal.backend().buffer()[(2, 0)];
            assert_eq!(
                cell.fg, resumed.colors.error,
                "focus must not replace failure semantics"
            );
            assert_eq!(cell.modifier.contains(Modifier::UNDERLINED), focused);
        }
    }

    #[test]
    fn chat_roles_use_full_user_bands_and_contextual_assistant_disclosure() {
        let rows = BTreeMap::from([
            (1, message("user", "Hello")),
            (
                2,
                json!({"turnId":"turn","id":"reply","type":"assistant","text":"Answer"}),
            ),
        ]);
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &locale(), false);
        let reply = view.order[1].clone();
        let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
        for terminal_colors in [false, true] {
            terminal.clear().unwrap();
            view.colors = if terminal_colors {
                crate::theme::Choice::Terminal.colors()
            } else {
                crate::theme::Palette::default()
            };
            terminal
                .draw(|frame| {
                    view.draw(frame, frame.area(), false).unwrap();
                })
                .unwrap();
            let cells = terminal.backend().buffer();
            assert_eq!(
                cells[(37, 0)].bg,
                if terminal_colors {
                    Color::Reset
                } else {
                    view.colors.surface
                }
            );
            assert_eq!(
                cells[(0, 2)].symbol(),
                " ",
                "expanded assistant has no permanent role badge"
            );
            if terminal_colors {
                assert!(cells[(2, 0)].modifier.contains(Modifier::BOLD));
            }
        }
        view.hovered = Some(reply.clone());
        assert!(!draw(&mut view, 40, 8).contains("▾ Answer"));
        assert!(
            !view.can_toggle(&reply),
            "a short single-line answer has nothing to disclose"
        );
        view.toggle(&reply);
        view.hovered = None;
        assert!(!draw(&mut view, 40, 8).contains("▸ Answer"));
        let mut timed = rows;
        timed.get_mut(&1).unwrap()["ts"] = json!(1790087176603_u64);
        timed.get_mut(&2).unwrap()["ts"] = json!(1790087297422_u64);
        view.sync(&timed, &[], 0, &locale(), false);
        let time = time::label(Some(1790087176603)).unwrap();
        assert!(draw(&mut view, 80, 8).contains(&time));
        let narrow = draw(&mut view, 40, 8);
        assert!(
            narrow.contains("Hello") && !narrow.contains(&time),
            "narrow screens prioritize content over timestamps"
        );
    }

    #[test]
    fn imported_history_keeps_answer_and_reasoning_without_inventing_live_work() {
        let rows = BTreeMap::from([
            (
                1,
                json!({"type":"user","turnId":"foreign","id":"u","imported":true,"text":"Question"}),
            ),
            (
                2,
                json!({"type":"tool_call","turnId":"foreign","id":"call","origin":"imported","modelVisibility":"hidden","toolName":"foreign-tool","args":{}}),
            ),
            (
                3,
                json!({"type":"assistant","turnId":"foreign","id":"a","imported":true,"text":"Imported answer","thinking":{"text":"Imported reasoning"}}),
            ),
            (
                4,
                json!({"type":"system_note","turnId":"foreign","id":"note","kind":"imported","data":{"text":"Source ended without a terminal record."}}),
            ),
        ]);
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &locale(), false);
        assert_eq!(view.order.len(), 5);
        assert_eq!(view.tool_status(&view.order[1]), Some("tool-missing"));
        assert_eq!(view.order[2].part, Part::Thinking);
        assert_eq!(view.order[3].part, Part::Text);
        let screen = draw(&mut view, 80, 20);
        assert!(screen.contains("Imported answer"));
        assert!(screen.contains("Source ended without a terminal record."));
        assert!(!view.timing_visible());
        for key in view.order.clone() {
            view.select(key);
            assert!(
                view.selected_branch_point().is_none(),
                "imported messages are not executable Turn boundaries"
            );
        }
        let mut local = rows.clone();
        local.insert(5, json!({"type":"user","turnId":"import-is-just-an-id","id":"local","text":"A local Turn after import"}));
        view.sync(&local, &[], 0, &locale(), false);
        draw(&mut view, 80, 24);
        view.select(view.order.last().unwrap().clone());
        assert_eq!(
            view.selected_branch_point(),
            Some(("import-is-just-an-id", "A local Turn after import")),
            "use provenance, not an identifier prefix or the whole Session's origin"
        );
    }

    #[test]
    fn default_chat_hides_orchestration_but_keeps_real_tools_attention_and_opt_in_trace() {
        let i18n = locale();
        let mut rows = BTreeMap::new();
        for (index, (name, origin, error)) in [
            ("exec", "provider", false),
            ("code_cell", "code_mode", false),
            ("tool_search", "code_mode", false),
            ("wait", "provider", false),
            ("Shell", "code_mode", false),
            ("exec", "provider", true),
            // A namesake from another origin is not an orchestration record.
            ("exec", "host_sdk", false),
        ]
        .into_iter()
        .enumerate()
        {
            let sequence = index as u64 * 2;
            rows.insert(
                sequence,
                json!({"type":"tool_call","id":format!("call-{index}"),
                "turnId":"turn","toolName":name,"origin":origin,"args":{"command":"pwd"}}),
            );
            rows.insert(sequence + 1, json!({"type":"tool_result","id":format!("result-{index}"),
                "turnId":"turn","toolUseId":format!("call-{index}"),"origin":origin,
                "isError":error,"content":{"kind":"text","text":if error {"execution denied"} else {"output"}}}));
        }
        rows.insert(
            20,
            json!({"type":"token_usage","id":"usage","turnId":"turn","input":500,"output":100}),
        );
        rows.insert(
            21,
            json!({"type":"turn_state","id":"terminal","turnId":"turn","status":"completed"}),
        );
        let source = rows.clone();
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(view.order.len(), 3);
        let real_tool = view.order[0].clone();
        view.toggle(&real_tool);
        let normal = draw(&mut view, 80, 40);
        assert!(normal.contains("Run · pwd") && normal.contains("execution denied"));
        assert!(!normal.contains("tool_search") && !normal.contains("Completed"));
        view.trace = true;
        view.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(view.order.len(), 9);
        assert!(!view.folded(&real_tool));
        let trace = draw(&mut view, 80, 40);
        assert!(trace.contains("tool_search") && trace.contains("Completed"));
        view.trace = false;
        view.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(draw(&mut view, 80, 40), normal);
        // Internal calls awaiting a user or missing a result remain visible.
        rows.remove(&1);
        rows.remove(&3);
        view.test_presentation.wait_for("turn", "call-0");
        view.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(view.tool_status(&view.order[0]), Some("tool-waiting"));
        assert_eq!(view.tool_status(&view.order[1]), Some("tool-missing"));
        assert_eq!(
            source[&0], rows[&0],
            "filtering never rewrites durable source"
        );
        rows.insert(22, json!({"type":"turn_state","id":"failure","turnId":"turn","status":"failed","failureMessage":"provider-diagnostic-marker"}));
        view.sync(&rows, &[], 0, &i18n, false);
        let failure = MessageKey::durable(&rows[&22]);
        assert!(view.folded(&failure));
        let collapsed = draw(&mut view, 80, 40);
        assert!(collapsed.contains(&i18n.text("chat-run-failed")));
        assert!(!collapsed.contains("provider-diagnostic-marker"));
        view.toggle(&failure);
        assert!(draw(&mut view, 80, 40).contains("provider-diagnostic-marker"));
    }

    #[test]
    fn tool_cards_keep_identity_folds_and_results_through_pagination_waiting_and_interleaving() {
        let i18n = locale();
        let call = |id: &str| {
            json!({"turnId":"turn","id":id,"type":"tool_call",
            "toolName":"Shell","args":{"command":format!("printf 中文🦀-{id}\necho next")},
            "origin":"code_mode","parentToolCallId":"cell","parentOperationId":"operation-cell"})
        };
        let result = |id: &str| {
            json!({"turnId":"turn","id":format!("result-{id}"),"type":"tool_result",
            "toolUseId":id,"isError":false,"content":{"kind":"text","text":format!("output-{id}\n\u{1b}[31mraw")},
            "origin":"code_mode","parentToolCallId":"cell","parentOperationId":"operation-cell"})
        };
        let mut rows = BTreeMap::from([(30, result("b"))]);
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &i18n, false);
        let b = view.order[0].clone();
        view.toggle(&b);
        assert!(draw(&mut view, 80, 40).contains("output-b"));
        rows.insert(10, call("a"));
        rows.insert(20, call("b"));
        view.sync(&rows, &[], 0, &i18n, false);
        let a = view.order[0].clone();
        assert_eq!(view.order, vec![a.clone(), b.clone()]);
        assert!(
            !view.folded(&b),
            "older call joins the existing orphan result card"
        );
        assert_eq!(view.blocks.len(), 2);
        assert!(draw(&mut view, 80, 40).contains("output-b"));
        view.test_presentation.wait_for("turn", "a");
        view.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(view.tool_status(&a), Some("tool-waiting"));
        assert!(draw(&mut view, 80, 40).contains("Waiting for you"));
        rows.insert(40, result("a"));
        view.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(view.order, vec![a.clone(), b.clone()]);
        assert_eq!(view.tool_status(&a), Some("tool-returned"));
        assert!(view.folded(&a));
        view.toggle(&a);
        let full = draw(&mut view, 80, 40);
        assert!(full.contains("output-a") && full.contains("output-b"));
        assert!(!full.contains('\u{1b}'));
        assert!(!view.blocks[&a].text.contains("output-b"));
        assert!(!view.blocks[&a].text.contains("Parent call: cell"));
        view.trace = true;
        view.sync(&rows, &[], 0, &i18n, false);
        assert!(view.blocks[&a].text.contains("Parent call: cell"));
        view.trace = false;
        view.sync(&rows, &[], 0, &i18n, false);
        let mut replay = Transcript::default();
        replay.sync(&rows, &[], 0, &i18n, false);
        assert_eq!(view.order, replay.order);
        for key in &view.order {
            assert_eq!(view.blocks[key].text, replay.blocks[key].text);
        }
        let mut long = rows.clone();
        long.get_mut(&30).unwrap()["content"]["text"] = json!("long output\n".repeat(30));
        // Use a fresh projection, as durable records themselves never mutate.
        replay = Transcript::default();
        replay.sync(&long, &[], 0, &i18n, false);
        draw(&mut replay, 80, 12);
        let before = replay.starts[1] - replay.top;
        replay.toggle(&b);
        draw(&mut replay, 80, 12);
        assert_eq!(
            replay.starts[1] - replay.top,
            before,
            "opening details grows below its header without jumping it to the top"
        );
        rows.insert(50, call("missing"));
        rows.insert(
            60,
            json!({"turnId":"turn","id":"terminal","type":"turn_state","status":"aborted"}),
        );
        for locale in Locale::ALL {
            let i18n = I18n::new(LocalePreference::Explicit(locale), locale);
            view.invalidate_labels();
            view.sync(&rows, &[], 0, &i18n, true);
            assert_eq!(view.tool_status(&view.order[2]), Some("tool-missing"));
            assert!(!view.folded(&a) && !view.folded(&b));
            for width in [1, 12, 80] {
                draw(&mut view, width, 40);
            }
            assert!(i18n.diagnostics().is_empty());
        }
    }
    #[test]
    fn line_scrolling_is_monotonic_across_padding_blank_and_gap_rows() {
        let rows: BTreeMap<_, _> = (0..12)
            .map(|n| {
                let turn = format!("t{n}");
                (
                    n,
                    if n % 2 == 0 {
                        json!({"turnId":turn,"id":format!("u{n}"),"type":"user","text":format!("question {n}")})
                    } else {
                        json!({"turnId":turn,"id":format!("a{n}"),"type":"assistant","text":"one\n\ntwo\n\nthree"})
                    },
                )
            })
            .collect();
        for colors in [
            crate::theme::Choice::Maka.colors(),
            crate::theme::Choice::Terminal.colors(),
        ] {
            let mut view = Transcript {
                colors,
                ..Default::default()
            };
            view.sync(&rows, &[], 0, &locale(), false);
            draw(&mut view, 40, 14);
            let bottom = view.top;
            for step in 1..=bottom {
                view.scroll(true, 1);
                draw(&mut view, 40, 14);
                assert_eq!(view.top, bottom - step, "blank rows must not snap upwards");
            }
            for step in 1..=bottom {
                view.scroll(false, 1);
                draw(&mut view, 40, 14);
                assert_eq!(view.top, step, "blank rows must not stall scrolling");
            }
            // Folding a padded user band keeps its header on the same row.
            view.scroll(true, bottom);
            let user = view.order[2].clone();
            view.blocks.get_mut(&user).unwrap().expandable = true;
            let header = |view: &Transcript| {
                let index = view.order.iter().position(|key| *key == user).unwrap();
                view.starts[index] + view.blocks[&user].header - view.top
            };
            draw(&mut view, 40, 14);
            let before = header(&view);
            view.toggle(&user);
            draw(&mut view, 40, 14);
            assert_eq!(header(&view), before);
        }
    }

    #[test]
    fn blocks_use_role_glyphs_rails_and_recessed_panels_outside_the_gutter() {
        let rows = BTreeMap::from([
            (
                1,
                json!({"turnId":"t","id":"u","type":"user","text":"Hello","ts":1790087176603_u64}),
            ),
            (
                2,
                json!({"turnId":"t","id":"c","type":"tool_call","toolName":"Shell","origin":"provider","args":{"command":"pwd"}}),
            ),
            (
                3,
                json!({"turnId":"t","id":"r","type":"tool_result","toolUseId":"c","origin":"provider","isError":false,"content":{"kind":"text","text":"/work"}}),
            ),
            (
                4,
                json!({"turnId":"t","id":"a","type":"assistant","text":"```rust\nfn main() {}\n```"}),
            ),
        ]);
        let cell_row = |terminal: &Terminal<TestBackend>, text: &str| {
            let buffer = terminal.backend().buffer();
            (0..buffer.area.height)
                .find(|y| {
                    (0..buffer.area.width)
                        .map(|x| buffer[(x, *y)].symbol())
                        .collect::<String>()
                        .contains(text)
                })
                .unwrap()
        };
        for ascii in [false, true] {
            let mut view = Transcript::default();
            view.sync(&rows, &[], 0, &locale(), ascii);
            let tool = view.order[1].clone();
            view.toggle(&tool);
            view.latest();
            let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
            terminal
                .draw(|frame| {
                    view.draw(frame, frame.area(), ascii).unwrap();
                })
                .unwrap();
            let colors = view.colors;
            let buffer = terminal.backend().buffer();
            let user = cell_row(&terminal, "Hello");
            assert_eq!(buffer[(0, user)].symbol(), if ascii { ">" } else { "❯" });
            assert_eq!(buffer[(0, user)].fg, colors.accent);
            for y in [user - 1, user + 1] {
                assert_eq!(buffer[(0, y)].bg, colors.surface, "band padding rows");
                assert_eq!(buffer[(77, y)].bg, colors.surface);
            }
            assert!(
                (0..80)
                    .map(|x| buffer[(x, user)].symbol())
                    .collect::<String>()
                    .contains(&time::label(Some(1790087176603)).unwrap()),
                "timestamps stay on the text row, not a padding row"
            );
            let header = cell_row(&terminal, "pwd");
            assert_eq!(buffer[(0, header)].symbol(), if ascii { "*" } else { "◆" });
            assert!(
                buffer[(2, header)].modifier.contains(Modifier::BOLD),
                "verb"
            );
            let detail = cell_row(&terminal, "/work");
            assert_eq!(buffer[(0, detail)].symbol(), if ascii { "|" } else { "│" });
            assert_eq!(buffer[(0, detail)].fg, colors.border);
            for x in [0, 1] {
                assert_eq!(buffer[(x, detail)].bg, Color::Reset, "gutter stays clear");
            }
            assert_eq!(buffer[(2, detail)].bg, colors.panel());
            assert_eq!(buffer[(77, detail)].bg, colors.panel());
            let code = cell_row(&terminal, "fn main");
            assert_eq!(buffer[(1, code)].bg, Color::Reset);
            assert_eq!(buffer[(2, code)].bg, colors.panel());
            assert_eq!(
                buffer[(77, code)].bg,
                colors.panel(),
                "band reaches the edge"
            );
            assert!(
                !(0..80)
                    .map(|x| buffer[(x, code)].symbol())
                    .collect::<String>()
                    .contains(['│', '|', '╭']),
                "code is a band, not a bordered window"
            );
            view.hovered = Some(tool.clone());
            terminal
                .draw(|frame| {
                    view.draw(frame, frame.area(), ascii).unwrap();
                })
                .unwrap();
            let header = cell_row(&terminal, "pwd");
            assert_eq!(
                terminal.backend().buffer()[(0, header)].symbol(),
                if ascii { "v" } else { "▾" },
                "the pointer reveals the disclosure"
            );
        }
        let mut view = Transcript {
            colors: crate::theme::Choice::Terminal.colors(),
            ..Default::default()
        };
        view.sync(&rows, &[], 0, &locale(), false);
        let screen = draw(&mut view, 80, 24);
        assert!(
            screen.starts_with("❯ Hello"),
            "terminal-owned colors spend no rows on invisible bands"
        );
        let long = BTreeMap::from([(
            1,
            json!({"turnId":"t","id":"c","type":"tool_call","toolName":"Shell","origin":"provider","args":{"command":"printf one two three four five six"}}),
        )]);
        view.sync(&long, &[], 0, &locale(), false);
        // `draw` concatenates rows without the two scrollbar columns.
        let header: String = draw(&mut view, 32, 4).chars().take(30).collect();
        assert!(
            header.trim_end().ends_with('…') && !header.contains("five"),
            "a one-row preview shows that words were dropped: {header:?}"
        );
    }
}
