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

use super::{
    layout::{Axis, Item, Pass, Scroller},
    node::{Node, On, Role},
};
use crate::theme::Palette;
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::{
    Frame,
    layout::{Position, Rect},
    style::{Modifier, Style},
    widgets::{Block, BorderType, Clear},
};
use std::collections::HashMap;
use unicode_width::UnicodeWidthStr;
pub(super) mod reader;

#[derive(Clone, Copy)]
pub struct Context {
    pub colors: Palette,
    pub ascii: bool,
    /// The page owns keyboard focus; only then is the focus drawn.
    pub focused: bool,
}

/// Result of one input event. Unconsumed events belong to the shell (global
/// keys, navigation); a consumed event never falls through to another layer.
pub struct Outcome<M> {
    pub redraw: bool,
    pub consumed: bool,
    pub message: Option<M>,
}
impl<M> Outcome<M> {
    pub(super) fn ignored() -> Self {
        Self {
            redraw: false,
            consumed: false,
            message: None,
        }
    }
    pub(super) fn handled(redraw: bool) -> Self {
        Self {
            redraw,
            consumed: true,
            message: None,
        }
    }
    pub(super) fn emit(message: M) -> Self {
        Self {
            redraw: true,
            consumed: true,
            message: Some(message),
        }
    }
    pub fn map<N>(self, f: impl FnOnce(M) -> N) -> Outcome<N> {
        Outcome {
            redraw: self.redraw,
            consumed: self.consumed,
            message: self.message.map(f),
        }
    }
}

struct Popover {
    owner: String,
    highlighted: usize,
}

/// Geometry of the last drawn frame. Input only ever resolves against what
/// was actually presented; a resize drops it until the next draw.
struct Committed<M> {
    area: Rect,
    items: Vec<Item<M>>,
    scrollers: Vec<Scroller>,
    canvases: Vec<(String, Rect)>,
    transcripts: Vec<reader::Placement>,
    popover: Option<Chooser>,
}

/// A drawn chooser: its box, visible rows, and the choice index of row 0.
#[derive(Clone, Default)]
struct Chooser {
    rect: Rect,
    rows: Vec<Rect>,
    first: usize,
}

pub struct Surface<M> {
    focus: Option<String>,
    /// Ordinal of the focus among enabled stops, kept for continuity when
    /// an update removes the focused node.
    focus_index: usize,
    /// Recently focused ids, newest last: returning to a group resumes there.
    recent: Vec<String>,
    hover: Option<String>,
    popover: Option<Popover>,
    offsets: HashMap<String, u16>,
    /// The scroller whose thumb the pointer is dragging.
    drag: Option<String>,
    /// Where focus lands first, by path prefix, once such a stop exists.
    start: Option<String>,
    committed: Option<Committed<M>>,
    /// Survives hit-geometry invalidation, so resize can keep a previously
    /// visible focus in view without undoing the reader's manual scrolling.
    last_layout: Option<(Rect, bool)>,
}

impl<M> Default for Surface<M> {
    fn default() -> Self {
        Self {
            focus: None,
            focus_index: 0,
            recent: vec![],
            hover: None,
            popover: None,
            offsets: HashMap::new(),
            drag: None,
            start: None,
            committed: None,
            last_layout: None,
        }
    }
}

impl<M: Clone> Surface<M> {
    pub fn render(&mut self, frame: &mut Frame<'_>, area: Rect, tree: Node<M>, context: Context) {
        let reveal = context.focused
            && (self
                .last_layout
                .is_some_and(|(before, visible)| before != area && visible)
                || self.focus.is_none() && self.start.is_some());
        // A reflow may need one corrective placement after its new geometry
        // is known. Ordinary frames neither copy the tree nor move the viewport.
        let retry = reveal.then(|| tree.clone());
        let mut pass = Pass::new(
            frame.buffer_mut(),
            context.colors,
            context.ascii,
            &self.offsets,
        );
        pass.run(tree, area);
        let (items, scrollers, canvases, transcripts) =
            (pass.items, pass.scrollers, pass.canvases, pass.transcripts);
        let stops: Vec<_> = items.iter().filter(|item| item.enabled).collect();
        match stops
            .iter()
            .position(|item| Some(&item.id) == self.focus.as_ref())
        {
            Some(index) => self.focus_index = index,
            // A fresh page waits for its content rather than settling on
            // the chrome above it.
            None if self.focus.is_none() && self.start.is_some() => {
                let start = self.start.as_deref().unwrap_or_default();
                if let Some(index) = stops.iter().position(|item| item.id.starts_with(start)) {
                    let index = stops[index]
                        .tab_group
                        .and_then(|group| {
                            stops.iter().position(|item| {
                                item.tab_group == Some(group)
                                    && item.current
                                    && item.id.starts_with(start)
                            })
                        })
                        .unwrap_or(index);
                    self.focus = Some(stops[index].id.clone());
                    self.focus_index = index;
                    self.start = None;
                }
            }
            // A removed or disabled target falls to the stop now at its old
            // place, not to the top of the page.
            None if self.focus.is_some() || context.focused => {
                self.focus = stops
                    .get(self.focus_index.min(stops.len().saturating_sub(1)))
                    .map(|item| item.id.clone());
            }
            None => {}
        }
        let focused = items
            .iter()
            .find(|item| Some(&item.id) == self.focus.as_ref());
        self.last_layout = Some((
            area,
            context.focused && focused.is_some_and(|item| !item.rect.is_empty()),
        ));
        if let Some(tree) = retry
            && let Some(item) = focused
            && reveal_offsets(
                &mut self.offsets,
                &scrollers,
                item.scroller,
                item.top,
                item.height,
            )
        {
            frame.render_widget(Clear, area);
            frame.render_widget(Block::default().style(context.colors.base()), area);
            self.render(frame, area, tree, context);
            return;
        }
        if self
            .hover
            .as_ref()
            .is_some_and(|hover| !stops.iter().any(|item| item.id == *hover))
        {
            self.hover = None;
        }
        let colors = context.colors;
        for item in items.iter().filter(|item| {
            item.enabled && !item.slot && !matches!(item.on, On::Scroll) && self.popover.is_none()
        }) {
            // Keyboard focus and the pointer stay distinguishable: focus takes
            // the selection, hover only lifts the row.
            let style = if context.focused && Some(&item.id) == self.focus.as_ref() {
                colors.focused().fg(match item.role {
                    Some(Role::Destructive) => colors.error,
                    Some(Role::Caution) => colors.warning,
                    _ => colors.accent,
                })
            } else if Some(&item.id) == self.hover.as_ref() {
                if colors.terminal {
                    Style::default().add_modifier(Modifier::UNDERLINED)
                } else if item.role.is_some() {
                    // Buttons are already filled at rest; hover lifts the fill.
                    Style::default().bg(colors.border)
                } else {
                    Style::default().bg(colors.surface)
                }
            } else {
                continue;
            };
            frame.buffer_mut().set_style(item.rect, style);
        }
        let popover = self.draw_popover(frame, area, &items, &context);
        self.committed = Some(Committed {
            area,
            items,
            scrollers,
            canvases,
            transcripts,
            popover,
        });
    }

    /// Paints an open chooser again, over what an owner drew on top of
    /// this frame: the chooser is modal, so nothing covers it.
    pub fn repaint_popover(&mut self, frame: &mut Frame<'_>, context: &Context) {
        if self.popover.is_none() {
            return;
        }
        let Some(committed) = self.committed.take() else {
            return;
        };
        let popover = self.draw_popover(frame, committed.area, &committed.items, context);
        self.committed = Some(Committed {
            popover,
            ..committed
        });
    }

    fn draw_popover(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        items: &[Item<M>],
        context: &Context,
    ) -> Option<Chooser> {
        let popover = self.popover.as_mut()?;
        let Some(owner) = items
            .iter()
            .find(|item| item.id == popover.owner && item.enabled)
        else {
            // The chooser's owner is gone or disabled: close, never retarget.
            self.popover = None;
            return None;
        };
        let On::Choose { choices, .. } = &owner.on else {
            self.popover = None;
            return None;
        };
        popover.highlighted = popover.highlighted.min(choices.len().saturating_sub(1));
        let labels: Vec<String> = choices
            .iter()
            .map(|choice| crate::view::safe(&choice.label))
            .collect();
        let width = (labels.iter().map(|label| label.width()).max().unwrap_or(0) as u16 + 6)
            .min(area.width);
        let rows = (choices.len() as u16).min(area.height.saturating_sub(2));
        if rows == 0 || width < 7 {
            self.popover = None;
            return None;
        }
        let height = rows + 2;
        let below = owner.rect.bottom().saturating_add(height) <= area.bottom();
        let y = if below {
            owner.rect.bottom()
        } else {
            owner.rect.y.saturating_sub(height).max(area.y)
        };
        let x = owner
            .rect
            .right()
            .saturating_sub(width)
            .clamp(area.x, area.right().saturating_sub(width));
        let rect = Rect::new(x, y, width, height).intersection(area);
        let colors = context.colors;
        frame.render_widget(Clear, rect);
        frame.render_widget(
            Block::bordered()
                .border_type(if context.ascii {
                    BorderType::Plain
                } else {
                    BorderType::Rounded
                })
                .border_style(Style::default().fg(colors.border))
                .style(colors.base()),
            rect,
        );
        // Keep the highlighted choice visible when a long list is clipped.
        let first = (popover.highlighted + 1).saturating_sub(usize::from(rows));
        let mut rows_out = Vec::new();
        for (row, index) in (first..choices.len()).take(usize::from(rows)).enumerate() {
            let line = Rect::new(rect.x + 1, rect.y + 1 + row as u16, rect.width - 2, 1);
            let current = matches!(owner.on, On::Choose { current, .. } if current == Some(index));
            let marker = match (current, context.ascii) {
                (true, false) => "● ",
                (false, false) => "○ ",
                (true, true) => "* ",
                (false, true) => "  ",
            };
            let style = if index == popover.highlighted {
                colors.focused().fg(colors.accent)
            } else if current {
                Style::default().fg(colors.accent)
            } else {
                Style::default().fg(colors.foreground)
            };
            let buffer = frame.buffer_mut();
            buffer.set_style(line, style);
            buffer.set_stringn(
                line.x + 1,
                line.y,
                format!("{marker}{}", labels[index]),
                usize::from(line.width.saturating_sub(1)),
                style,
            );
            rows_out.push(line);
        }
        Some(Chooser {
            rect,
            rows: rows_out,
            first,
        })
    }

    /// Whether this surface currently holds a modal layer over its page.
    pub fn captures(&self) -> bool {
        self.popover.is_some()
    }

    /// Footer hint of the pointed-at or keyboard-focused control.
    pub fn hint(&self, focused: bool) -> Option<&str> {
        let committed = self.committed.as_ref()?;
        let id = self
            .hover
            .as_ref()
            .or(self.focus.as_ref().filter(|_| focused))?;
        committed
            .items
            .iter()
            .find(|item| item.id == *id)
            .and_then(|item| item.hint.as_deref())
    }

    pub fn focused(&self) -> Option<&str> {
        self.focus.as_deref()
    }

    /// Where a node was drawn in the committed frame; empty when scrolled out.
    pub fn rect(&self, id: &str) -> Option<Rect> {
        let committed = self.committed.as_ref()?;
        committed
            .items
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.rect)
            .or_else(|| {
                committed
                    .canvases
                    .iter()
                    .find(|(canvas, _)| canvas == id)
                    .map(|(_, rect)| *rect)
            })
    }

    /// Focus a node by id; resolved against the next drawn frame.
    /// Restores a focus quietly: scroll positions stay where they are.
    pub fn focus(&mut self, id: String) {
        self.set_focus(id);
    }

    /// Brings a node the last frame had scrolled out back into view,
    /// leaving the focus alone.
    pub fn reveal_item(&mut self, id: &str) {
        if let Some((scroller, top, height)) = self
            .committed
            .as_ref()
            .and_then(|committed| committed.items.iter().find(|item| item.id == id))
            .map(|item| (item.scroller, item.top, item.height))
        {
            self.reveal(scroller, top, height);
        }
    }

    /// Moves focus as the reader would, bringing a target that the last
    /// frame had scrolled out back into view.
    pub fn move_focus(&mut self, id: String) {
        if let Some((scroller, top, height)) = self
            .committed
            .as_ref()
            .and_then(|committed| committed.items.iter().find(|item| item.id == id))
            .map(|item| (item.scroller, item.top, item.height))
        {
            self.reveal(scroller, top, height);
        }
        self.set_focus(id);
    }

    /// Until focus is placed, it lands on the first stop under `prefix`
    /// as soon as one is drawn: a page's content, not its toolbar.
    pub fn start_at(&mut self, prefix: impl Into<String>) {
        self.start = Some(prefix.into());
    }

    /// Focus moves to the first stop under `prefix` once one is drawn.
    pub fn focus_within(&mut self, prefix: impl Into<String>) {
        self.focus = None;
        self.start = Some(prefix.into());
    }

    /// Keyboard focus arrives from outside the page (Tab from navigation).
    pub fn enter(&mut self, last: bool) {
        self.start = None;
        let Some(committed) = &self.committed else {
            self.focus = None;
            self.focus_index = if last { usize::MAX } else { 0 };
            return;
        };
        let stops = self.tab_stops();
        let target = if last { stops.last() } else { stops.first() };
        let id = target.map(|index| committed.items[*index].id.clone());
        if let Some(id) = id {
            self.move_focus(id);
        } else {
            self.focus = None;
        }
    }

    /// A shell overlay drawn over this surface hides these cells from the
    /// pointer; the keyboard still reaches every item.
    pub fn occlude(&mut self, rect: Rect) {
        if let Some(committed) = &mut self.committed {
            for placed in &mut committed.transcripts {
                if !placed.area.intersection(rect).is_empty() {
                    placed.area = Rect::default();
                    placed.hits.clear();
                }
            }
            for item in &mut committed.items {
                if !item.rect.intersection(rect).is_empty() {
                    item.rect = Rect::default();
                }
            }
        }
    }

    /// The page is no longer shown: close its chooser and forget geometry.
    pub fn leave(&mut self) {
        self.popover = None;
        self.invalidate();
    }

    /// Drop presented geometry; nothing is clickable until the next draw.
    pub fn invalidate(&mut self) {
        self.committed = None;
        self.hover = None;
        self.drag = None;
    }

    pub fn input(&mut self, event: &Event) -> Outcome<M> {
        match event {
            Event::Resize(_, _) => {
                self.invalidate();
                Outcome::handled(true)
            }
            Event::FocusLost => {
                let redraw = self.hover.take().is_some();
                Outcome {
                    redraw,
                    consumed: false,
                    message: None,
                }
            }
            Event::Mouse(mouse) => self.mouse(*mouse),
            Event::Key(key) if key.kind != KeyEventKind::Release => self.key(*key),
            _ if self.popover.is_some() => Outcome::handled(false),
            _ => Outcome::ignored(),
        }
    }

    fn mouse(&mut self, mouse: MouseEvent) -> Outcome<M> {
        let Some(committed) = &self.committed else {
            // Stale or unpresented geometry: a chooser still blocks the page.
            return if self.popover.is_some() {
                Outcome::handled(false)
            } else {
                Outcome::ignored()
            };
        };
        let point = Position::new(mouse.column, mouse.row);
        if let Some(popover) = &mut self.popover {
            let chooser = committed.popover.clone().unwrap_or_default();
            let index = chooser
                .rows
                .iter()
                .position(|row| row.contains(point))
                .map(|row| chooser.first + row);
            return match mouse.kind {
                MouseEventKind::Moved => match index {
                    Some(index) if index != popover.highlighted => {
                        popover.highlighted = index;
                        Outcome::handled(true)
                    }
                    _ => Outcome::handled(false),
                },
                MouseEventKind::Down(MouseButton::Left) => match index {
                    Some(index) => self.choose(index),
                    None if chooser.rect.contains(point) => Outcome::handled(false),
                    None => {
                        // Outside click dismisses the chooser; it never
                        // reaches the page, navigation or shell beneath.
                        self.popover = None;
                        Outcome::handled(true)
                    }
                },
                _ => Outcome::handled(false),
            };
        }
        // A scrollbar column is a thumb to drag, never a row to open.
        let bar = committed.scrollers.iter().rev().find(|scroller| {
            scroller.content > scroller.viewport.height
                && scroller.viewport.contains(point)
                && point.x == scroller.viewport.right().saturating_sub(1)
        });
        let dragged = self.drag.as_ref().and_then(|id| {
            committed
                .scrollers
                .iter()
                .find(|scroller| scroller.id == *id)
        });
        match (mouse.kind, bar, dragged) {
            (MouseEventKind::Down(MouseButton::Left), Some(scroller), _)
            | (MouseEventKind::Drag(MouseButton::Left), _, Some(scroller)) => {
                let maximum = scroller.content.saturating_sub(scroller.viewport.height);
                let span = scroller.viewport.height.saturating_sub(1).max(1);
                let row = point
                    .y
                    .saturating_sub(scroller.viewport.y)
                    .min(scroller.viewport.height.saturating_sub(1));
                let offset = (u32::from(row) * u32::from(maximum) / u32::from(span)) as u16;
                let id = scroller.id.clone();
                self.offsets.insert(id.clone(), offset.min(maximum));
                self.drag = Some(id);
                self.hover = None;
                self.manually_scrolled();
                return Outcome::handled(true);
            }
            (MouseEventKind::Up(MouseButton::Left), _, _) if self.drag.is_some() => {
                self.drag = None;
                return Outcome::handled(true);
            }
            _ => {}
        }
        let inside = committed.area.contains(point);
        let target = committed
            .items
            .iter()
            .rev()
            .find(|item| item.enabled && item.rect.contains(point));
        match mouse.kind {
            MouseEventKind::Moved => {
                let hover = target.map(|item| item.id.clone());
                let redraw = hover != self.hover;
                self.hover = hover;
                Outcome {
                    redraw,
                    consumed: inside,
                    message: None,
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let Some(item) = target else {
                    return if inside {
                        Outcome::handled(false)
                    } else {
                        Outcome::ignored()
                    };
                };
                let id = item.id.clone();
                // Pressing a button beside a text field leaves the typing
                // where it was, as on the Mac; anything else takes focus.
                let typing = committed.items.iter().any(|field| {
                    field.slot && field.enabled && Some(&field.id) == self.focus.as_ref()
                });
                let keep = typing && item.role.is_some() && matches!(item.on, On::Activate(_));
                let outcome = match &item.on {
                    // Clicking into a field or a viewer places focus; only
                    // Enter submits.
                    On::Activate(_) if item.slot => Outcome::handled(true),
                    On::Scroll | On::Transcript => Outcome::handled(true),
                    On::Activate(message) => Outcome::emit(message.clone()),
                    On::Choose { current, .. } => {
                        self.popover = Some(Popover {
                            owner: id.clone(),
                            highlighted: current.unwrap_or(0),
                        });
                        Outcome::handled(true)
                    }
                };
                if !keep {
                    self.set_focus(id);
                }
                outcome
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown if inside => {
                let Some(scroller) = committed
                    .scrollers
                    .iter()
                    .rev()
                    .find(|scroller| scroller.viewport.contains(point))
                else {
                    return Outcome::handled(false);
                };
                let maximum = scroller.content.saturating_sub(scroller.viewport.height);
                let offset = self.offsets.entry(scroller.id.clone()).or_default();
                *offset = (*offset).min(maximum);
                let before = *offset;
                *offset = if mouse.kind == MouseEventKind::ScrollUp {
                    offset.saturating_sub(3)
                } else {
                    offset.saturating_add(3).min(maximum)
                };
                // Pointer targets move under the wheel; resolve them afresh.
                self.hover = None;
                let changed = *offset != before;
                self.manually_scrolled();
                Outcome::handled(changed)
            }
            _ if inside => Outcome::handled(false),
            _ => Outcome::ignored(),
        }
    }

    fn choose(&mut self, index: usize) -> Outcome<M> {
        let owner = self.popover.take().map(|popover| popover.owner);
        let message = self
            .committed
            .as_ref()
            .and_then(|committed| {
                committed
                    .items
                    .iter()
                    .find(|item| Some(&item.id) == owner.as_ref())
            })
            .and_then(|item| match &item.on {
                On::Choose { choices, .. } => {
                    choices.get(index).map(|choice| choice.action.clone())
                }
                On::Activate(_) | On::Scroll | On::Transcript => None,
            });
        match message {
            Some(message) => Outcome::emit(message),
            None => Outcome::handled(true),
        }
    }

    fn key(&mut self, key: KeyEvent) -> Outcome<M> {
        if key.modifiers.intersects(
            KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META,
        ) {
            // Shell shortcuts (quit, palette, Alt+arrow history) stay
            // reachable over the page and its choosers.
            return Outcome::ignored();
        }
        if self.popover.is_some() {
            return self.chooser_key(key.code);
        }
        let Some(committed) = &self.committed else {
            return Outcome::ignored();
        };
        // Indices into the committed items of every enabled focus stop.
        let stops: Vec<usize> = (0..committed.items.len())
            .filter(|index| committed.items[*index].enabled)
            .collect();
        let item = |index: usize| &committed.items[index];
        let current = stops
            .iter()
            .position(|index| Some(&item(*index).id) == self.focus.as_ref());
        // A focused viewer scrolls; with nothing to scroll the keys move focus.
        if let Some(at) = current
            && matches!(item(stops[at]).on, On::Scroll)
            && let Some(scroller) = committed
                .scrollers
                .iter()
                .find(|scroller| scroller.id == item(stops[at]).id)
        {
            let maximum = scroller.content.saturating_sub(scroller.viewport.height);
            let page = scroller.viewport.height.saturating_sub(1).max(1);
            if maximum > 0 {
                let offset = self.offsets.entry(scroller.id.clone()).or_default();
                *offset = (*offset).min(maximum);
                let before = *offset;
                *offset = match key.code {
                    KeyCode::Up => offset.saturating_sub(1),
                    KeyCode::Down => (*offset + 1).min(maximum),
                    KeyCode::PageUp => offset.saturating_sub(page),
                    KeyCode::PageDown => (*offset + page).min(maximum),
                    KeyCode::Home => 0,
                    KeyCode::End => maximum,
                    _ => *offset,
                };
                if matches!(
                    key.code,
                    KeyCode::Up
                        | KeyCode::Down
                        | KeyCode::PageUp
                        | KeyCode::PageDown
                        | KeyCode::Home
                        | KeyCode::End
                ) {
                    let changed = *offset != before;
                    self.manually_scrolled();
                    return Outcome::handled(changed);
                }
            }
        }
        let target = match (key.code, current) {
            (KeyCode::Tab | KeyCode::BackTab, _) => {
                let tabs = self.tab_stops();
                let current = tabs
                    .iter()
                    .position(|index| Some(&item(*index).id) == self.focus.as_ref());
                let backwards =
                    key.code == KeyCode::BackTab || key.modifiers.contains(KeyModifiers::SHIFT);
                let next = match (current, backwards) {
                    (None, false) => tabs.first(),
                    (None, true) => tabs.last(),
                    (Some(at), false) => tabs.get(at + 1),
                    (Some(at), true) => at.checked_sub(1).and_then(|at| tabs.get(at)),
                };
                // Past either end, focus leaves the page for the shell.
                match next {
                    Some(index) => *index,
                    None => return Outcome::ignored(),
                }
            }
            (KeyCode::Up | KeyCode::Down | KeyCode::Home | KeyCode::End, Some(at))
                if item(stops[at]).axis == Axis::Vertical =>
            {
                match self.along(&stops, stops[at], key.code) {
                    Some(index) => index,
                    None => return Outcome::handled(false),
                }
            }
            (KeyCode::Left | KeyCode::Right | KeyCode::Home | KeyCode::End, Some(at))
                if item(stops[at]).axis == Axis::Horizontal =>
            {
                match self.along(&stops, stops[at], key.code) {
                    Some(index) => index,
                    None => return Outcome::handled(false),
                }
            }
            (KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right, Some(at)) => {
                match self.across(&stops, stops[at], key.code) {
                    Some(index) => index,
                    None => return Outcome::ignored(),
                }
            }
            (KeyCode::Enter | KeyCode::Char(' '), Some(at)) => {
                let item = item(stops[at]);
                if key.code == KeyCode::Enter
                    && let Some(message) = &item.submit
                {
                    return Outcome::emit(message.clone());
                }
                return match &item.on {
                    On::Activate(message) => Outcome::emit(message.clone()),
                    On::Choose { current, .. } => {
                        self.popover = Some(Popover {
                            owner: item.id.clone(),
                            highlighted: current.unwrap_or(0),
                        });
                        Outcome::handled(true)
                    }
                    On::Scroll | On::Transcript => Outcome::handled(false),
                };
            }
            (
                KeyCode::Up
                | KeyCode::Down
                | KeyCode::Home
                | KeyCode::End
                | KeyCode::Enter
                | KeyCode::Char(' '),
                None,
            ) => match stops.first() {
                Some(index) => *index,
                None => return Outcome::handled(false),
            },
            _ => return Outcome::ignored(),
        };
        self.focus_item(target)
    }

    /// A list contributes one stop at its position in reading order. Reentry
    /// keeps the reader's cursor, then prefers a selected or visible item.
    fn tab_stops(&self) -> Vec<usize> {
        let Some(committed) = &self.committed else {
            return vec![];
        };
        let priority = |item: &Item<M>| {
            (
                Some(&item.id) == self.focus.as_ref(),
                self.recent.iter().rposition(|id| *id == item.id),
                item.current,
                !item.rect.is_empty(),
            )
        };
        let mut stops = vec![];
        let mut groups = HashMap::new();
        for (index, item) in committed
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.enabled)
        {
            if let Some(group) = item.tab_group {
                if let Some(at) = groups.get(&group).copied() {
                    if priority(item) > priority(&committed.items[stops[at]]) {
                        stops[at] = index;
                    }
                    continue;
                }
                groups.insert(group, stops.len());
            }
            stops.push(index);
        }
        stops
    }

    /// Next stop along the focused item's own group axis.
    fn along(&self, stops: &[usize], from: usize, code: KeyCode) -> Option<usize> {
        let items = &self.committed.as_ref()?.items;
        let group = items[from].group;
        let peers: Vec<usize> = stops
            .iter()
            .copied()
            .filter(|index| items[*index].group == group)
            .collect();
        let here = peers.iter().position(|index| *index == from)?;
        match code {
            KeyCode::Up | KeyCode::Left => peers.get(here.saturating_sub(1)),
            KeyCode::Down | KeyCode::Right => peers.get(here + 1).or(peers.last()),
            KeyCode::Home => peers.first(),
            _ => peers.last(),
        }
        .copied()
    }

    /// A stop in the neighboring group in the pressed direction. Entering a
    /// group resumes its chosen or last focused item, else its first visible
    /// one; a pointer-level neighbor is only the tie breaker for which group.
    fn across(&self, stops: &[usize], from: usize, code: KeyCode) -> Option<usize> {
        let items = &self.committed.as_ref()?.items;
        let origin = items[from].rect;
        let beside: Vec<usize> = stops
            .iter()
            .copied()
            .filter(|index| {
                let rect = items[*index].rect;
                items[*index].group != items[from].group
                    && !rect.is_empty()
                    && match code {
                        KeyCode::Left => rect.right() <= origin.x,
                        KeyCode::Right => rect.x >= origin.right(),
                        KeyCode::Up => rect.bottom() <= origin.y,
                        _ => rect.y >= origin.bottom(),
                    }
            })
            .collect();
        let nearest = beside.iter().copied().min_by_key(|index| {
            let rect = items[*index].rect;
            let (x, y) = (rect.x.abs_diff(origin.x), rect.y.abs_diff(origin.y));
            if matches!(code, KeyCode::Left | KeyCode::Right) {
                (x, y)
            } else {
                (y, x)
            }
        })?;
        let group = items[nearest].group;
        let members: Vec<usize> = beside
            .iter()
            .copied()
            .filter(|index| items[*index].group == group)
            .collect();
        members
            .iter()
            .copied()
            .find(|index| items[*index].current)
            .or_else(|| {
                self.recent.iter().rev().find_map(|id| {
                    members
                        .iter()
                        .copied()
                        .find(|index| items[*index].id == *id)
                })
            })
            .or_else(|| {
                // A group reached along its own axis continues from the edge.
                (items[nearest].axis
                    == if matches!(code, KeyCode::Left | KeyCode::Right) {
                        Axis::Horizontal
                    } else {
                        Axis::Vertical
                    })
                .then_some(nearest)
            })
            .or_else(|| members.first().copied())
    }

    fn chooser_key(&mut self, code: KeyCode) -> Outcome<M> {
        let Some(popover) = &mut self.popover else {
            return Outcome::ignored();
        };
        let count = self
            .committed
            .as_ref()
            .and_then(|committed| committed.items.iter().find(|item| item.id == popover.owner))
            .map_or(0, |item| match &item.on {
                On::Choose { choices, .. } => choices.len(),
                On::Activate(_) | On::Scroll | On::Transcript => 0,
            });
        match code {
            KeyCode::Up => {
                popover.highlighted = popover.highlighted.saturating_sub(1);
                Outcome::handled(true)
            }
            KeyCode::Down => {
                popover.highlighted = (popover.highlighted + 1).min(count.saturating_sub(1));
                Outcome::handled(true)
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                let index = popover.highlighted;
                self.choose(index)
            }
            KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => {
                self.popover = None;
                Outcome::handled(true)
            }
            // The chooser is modal: other keys never reach the page.
            _ => Outcome::handled(false),
        }
    }

    fn focus_item(&mut self, index: usize) -> Outcome<M> {
        let Some(item) = self
            .committed
            .as_ref()
            .and_then(|committed| committed.items.get(index))
        else {
            return Outcome::handled(false);
        };
        if Some(&item.id) == self.focus.as_ref() {
            // The focused row may have been scrolled away: bring it back.
            let (scroller, top, height) = (item.scroller, item.top, item.height);
            let message = match &item.on {
                // An arrow at a list's edge still chooses the focused row
                // when it is not the choice yet (a refresh took its choice).
                On::Activate(message) if item.follow_focus && !item.current => {
                    Some(message.clone())
                }
                _ => None,
            };
            let before = self.offsets.clone();
            self.reveal(scroller, top, height);
            return match message {
                Some(message) => Outcome::emit(message),
                None => Outcome::handled(self.offsets != before),
            };
        }
        let message = match &item.on {
            On::Activate(message) if item.follow_focus => Some(message.clone()),
            _ => None,
        };
        let (id, scroller, top, height) = (item.id.clone(), item.scroller, item.top, item.height);
        self.reveal(scroller, top, height);
        self.set_focus(id);
        self.hover = None;
        Outcome {
            redraw: true,
            consumed: true,
            message,
        }
    }

    fn set_focus(&mut self, id: String) {
        self.recent.retain(|recent| *recent != id);
        self.recent.push(id.clone());
        if self.recent.len() > 16 {
            self.recent.remove(0);
        }
        if let Some(committed) = &self.committed
            && let Some(index) = committed
                .items
                .iter()
                .filter(|item| item.enabled)
                .position(|item| item.id == id)
        {
            self.focus_index = index;
        }
        self.focus = Some(id);
    }

    /// Explicit scrolling wins over a simultaneous change in layout.
    fn manually_scrolled(&mut self) {
        if let Some((_, keep_focus)) = &mut self.last_layout {
            *keep_focus = false;
        }
    }

    /// Scroll a keyboard target fully into its viewport.
    fn reveal(&mut self, scroller: Option<usize>, top: i32, height: u16) {
        if let Some(committed) = &self.committed {
            reveal_offsets(
                &mut self.offsets,
                &committed.scrollers,
                scroller,
                top,
                height,
            );
        }
    }
}

/// Reveal from the innermost viewport outward. Clipped viewports can have an
/// empty hit rectangle, so their allocated position supplies the geometry.
fn reveal_offsets(
    offsets: &mut HashMap<String, u16>,
    scrollers: &[Scroller],
    mut index: Option<usize>,
    mut top: i32,
    mut height: u16,
) -> bool {
    let mut changed = false;
    while let Some(scroller) = index.and_then(|index| scrollers.get(index)) {
        let offset = offsets.entry(scroller.id.clone()).or_default();
        let drawn = (*offset).min(scroller.content.saturating_sub(scroller.viewport.height));
        let maximum = scroller.content.saturating_sub(scroller.height);
        let before = *offset;
        *offset = drawn.min(maximum);
        top += i32::from(drawn) - i32::from(*offset);
        height = height.min(scroller.height);
        let above = scroller.top - top;
        let below = top + i32::from(height) - (scroller.top + i32::from(scroller.height));
        let adjusted = if above > 0 {
            offset.saturating_sub(above.min(i32::from(u16::MAX)) as u16)
        } else if below > 0 {
            offset
                .saturating_add(below.min(i32::from(u16::MAX)) as u16)
                .min(maximum)
        } else {
            *offset
        };
        top += i32::from(*offset) - i32::from(adjusted);
        *offset = adjusted;
        changed |= before != *offset;
        index = scroller.parent;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::super::node::{Choice, Node, Size, Tone};
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    #[derive(Clone, Debug, PartialEq)]
    enum Message {
        Pick(usize),
        Choose(&'static str),
    }

    fn tree(categories: &[usize], selected: usize, rows: &[(&'static str, bool)]) -> Node<Message> {
        let list = categories
            .iter()
            .map(|index| {
                Node::text(
                    format!("c{index}"),
                    vec![(format!("Category {index}"), Tone::Normal)],
                )
                .on(On::Activate(Message::Pick(*index)))
                .current(*index == selected)
                .follow_focus()
            })
            .collect();
        let items = rows
            .iter()
            .map(|(key, enabled)| {
                Node::row(
                    *key,
                    vec![
                        Node::text("label", vec![(key.to_string(), Tone::Normal)]).size(Size::Fill),
                        Node::text("value", vec![("Value ›".into(), Tone::Muted)]),
                    ],
                )
                .on(On::Choose {
                    choices: vec![
                        Choice {
                            label: "One".into(),
                            action: Message::Choose("one"),
                        },
                        Choice {
                            label: "Two".into(),
                            action: Message::Choose("two"),
                        },
                    ],
                    current: Some(1),
                })
                .enabled(*enabled)
                .hint(format!("hint {key}"))
            })
            .collect();
        Node::row(
            "root",
            vec![
                Node::column("list", list).size(Size::Fixed(14)),
                Node::rule("rule"),
                Node::scroll("pane", Node::column("rows", items).gap(1)),
            ],
        )
    }

    fn draw(
        surface: &mut Surface<Message>,
        width: u16,
        height: u16,
        root: Node<Message>,
    ) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                surface.render(
                    frame,
                    frame.area(),
                    root,
                    Context {
                        colors: crate::theme::Palette::default(),
                        ascii: false,
                        focused: true,
                    },
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        })
    }
    fn click(column: u16, row: u16) -> Event {
        mouse(MouseEventKind::Down(MouseButton::Left), column, row)
    }

    #[test]
    fn keyboard_moves_within_groups_follows_list_selection_and_crosses_panes_spatially() {
        let mut surface = Surface::default();
        let rows = [("alpha", true), ("beta", false), ("gamma", true)];
        draw(&mut surface, 50, 12, tree(&[0, 1, 2], 0, &rows));
        assert_eq!(
            surface.focus.as_deref(),
            Some("root/list/c0"),
            "entry focus"
        );
        let down = surface.input(&key(KeyCode::Down));
        assert_eq!(
            down.message,
            Some(Message::Pick(1)),
            "selection follows focus"
        );
        draw(&mut surface, 50, 12, tree(&[0, 1, 2], 1, &rows));
        assert!(surface.input(&key(KeyCode::Right)).consumed);
        assert_eq!(surface.focus.as_deref(), Some("root/pane/rows/alpha"));
        surface.input(&key(KeyCode::Down));
        assert_eq!(
            surface.focus.as_deref(),
            Some("root/pane/rows/gamma"),
            "disabled rows are skipped"
        );
        assert_eq!(surface.hint(true), Some("hint gamma"));
        assert!(
            !surface.input(&key(KeyCode::Tab)).consumed,
            "Tab past the end leaves the page"
        );
        surface.input(&key(KeyCode::Left));
        assert_eq!(surface.focus.as_deref(), Some("root/list/c1"));
        assert!(
            !surface.input(&key(KeyCode::Esc)).consumed,
            "Esc belongs to the shell"
        );
    }

    #[test]
    fn tab_crosses_long_lists_and_returns_to_the_cursor_without_skipping_fields() {
        let tree = |reverse: bool, removed: Option<usize>| {
            let mut rows: Vec<_> = (0..200)
                .filter(|index| Some(*index) != removed)
                .map(|index| {
                    Node::text(
                        index.to_string(),
                        vec![(format!("Item {index}"), Tone::Normal)],
                    )
                    .on(On::Activate(Message::Pick(index)))
                    .current(index == 150)
                    .enabled(index != 151)
                })
                .collect();
            if reverse {
                rows.reverse();
            }
            Node::column(
                "root",
                vec![
                    Node::slot("before", 1).on(On::Activate(Message::Choose("before"))),
                    Node::scroll("list", Node::column("rows", rows).focus_group())
                        .size(Size::Fixed(5)),
                    Node::slot("after", 1).on(On::Activate(Message::Choose("after"))),
                    Node::button("save", "Save".into(), Role::Primary)
                        .on(On::Activate(Message::Choose("save"))),
                ],
            )
            .map(&|message| message)
        };
        let mut surface = Surface::default();
        draw(&mut surface, 40, 10, tree(false, None));
        assert_eq!(surface.focused(), Some("root/before"));
        assert!(surface.input(&key(KeyCode::Tab)).message.is_none());
        assert_eq!(surface.focused(), Some("root/list/rows/150"));
        draw(&mut surface, 40, 10, tree(false, None));
        assert!(!surface.rect("root/list/rows/150").unwrap().is_empty());
        surface.input(&key(KeyCode::Down));
        assert_eq!(surface.focused(), Some("root/list/rows/152"));
        surface.input(&key(KeyCode::Tab));
        assert_eq!(surface.focused(), Some("root/after"));
        surface.input(&key(KeyCode::BackTab));
        assert_eq!(surface.focused(), Some("root/list/rows/152"));
        surface.input(&key(KeyCode::Tab));
        surface.input(&key(KeyCode::Tab));
        assert_eq!(surface.focused(), Some("root/save"));
        assert!(!surface.input(&key(KeyCode::Tab)).consumed);
        surface.input(&key(KeyCode::BackTab));
        draw(&mut surface, 40, 10, tree(true, None));
        surface.input(&key(KeyCode::BackTab));
        assert_eq!(
            surface.focused(),
            Some("root/list/rows/152"),
            "identity survives reordering"
        );
        surface.input(&key(KeyCode::Tab));
        draw(&mut surface, 40, 10, tree(true, Some(152)));
        surface.input(&key(KeyCode::BackTab));
        assert_eq!(
            surface.focused(),
            Some("root/list/rows/150"),
            "a removed cursor falls back within its group"
        );
        surface.input(&key(KeyCode::BackTab));
        assert_eq!(surface.focused(), Some("root/before"));
    }

    #[test]
    fn chooser_is_modal_dismisses_outside_without_passthrough_and_emits_choices() {
        let mut surface = Surface::default();
        let rows = [("alpha", true)];
        let screen = draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        let y = screen
            .lines()
            .position(|line| line.contains("alpha"))
            .unwrap() as u16;
        assert!(surface.input(&click(30, y)).consumed);
        assert!(surface.captures());
        let screen = draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        assert!(screen.contains("○ One") && screen.contains("● Two"));
        // A click on the list beneath the chooser only dismisses it.
        let dismissed = surface.input(&click(2, 0));
        assert!(dismissed.consumed && dismissed.message.is_none());
        assert!(!surface.captures());
        draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        surface.input(&key(KeyCode::Enter));
        draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        surface.input(&key(KeyCode::Up));
        assert_eq!(
            surface.input(&key(KeyCode::Enter)).message,
            Some(Message::Choose("one"))
        );
        assert!(!surface.captures());
        // Shell shortcuts stay reachable while a chooser is open.
        surface.input(&key(KeyCode::Enter));
        let quit = surface.input(&Event::Key(KeyEvent::new(
            KeyCode::Char('q'),
            KeyModifiers::CONTROL,
        )));
        assert!(!quit.consumed);
        let back = surface.input(&Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT)));
        assert!(
            !back.consumed,
            "Alt+Left is history navigation, not a focus move"
        );
    }

    #[test]
    fn hover_and_keyboard_focus_stay_distinguishable() {
        let mut surface = Surface::default();
        let rows = [("alpha", true), ("gamma", true)];
        let screen = draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        let y = screen
            .lines()
            .position(|line| line.contains("gamma"))
            .unwrap() as u16;
        surface.input(&mouse(MouseEventKind::Moved, 30, y));
        let mut terminal = Terminal::new(TestBackend::new(50, 12)).unwrap();
        let colors = crate::theme::Palette::default();
        terminal
            .draw(|frame| {
                surface.render(
                    frame,
                    frame.area(),
                    tree(&[0], 0, &rows),
                    Context {
                        colors,
                        ascii: false,
                        focused: true,
                    },
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(0, 0)].bg, colors.selection, "focused category");
        assert_eq!(
            buffer[(30, y)].bg,
            colors.surface,
            "hovered row is only lifted"
        );
    }

    #[test]
    fn stale_geometry_and_vanished_targets_never_receive_input() {
        let mut surface = Surface::default();
        let rows = [("alpha", true), ("gamma", true)];
        let screen = draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        let y = screen
            .lines()
            .position(|line| line.contains("gamma"))
            .unwrap() as u16;
        surface.input(&Event::Resize(80, 24));
        let stale = surface.input(&click(30, y));
        assert!(
            !stale.consumed && !surface.captures(),
            "old hit regions are gone"
        );
        draw(&mut surface, 50, 12, tree(&[0], 0, &rows));
        surface.input(&click(30, y));
        assert!(surface.captures());
        // An update removes the chooser's owner: the chooser closes instead of
        // retargeting, and focus falls to the neighbor at the same place.
        draw(&mut surface, 50, 12, tree(&[0], 0, &[("alpha", true)]));
        assert!(!surface.captures());
        assert_eq!(surface.focus.as_deref(), Some("root/pane/rows/alpha"));
    }

    #[test]
    fn resizing_reveals_visible_focus_through_nested_viewports_without_undoing_manual_scroll() {
        for nested in [false, true] {
            let tree = || {
                let list = Node::scroll(
                    "list",
                    Node::column(
                        "rows",
                        (0..30)
                            .map(|index| {
                                Node::text(
                                    index.to_string(),
                                    vec![(
                                        if index < 10 {
                                            format!("Long label that belongs to row {index}")
                                        } else {
                                            format!("Row {index}")
                                        },
                                        Tone::Normal,
                                    )],
                                )
                                .on(On::Activate(Message::Pick(index)))
                            })
                            .collect(),
                    ),
                );
                if nested {
                    Node::scroll(
                        "outer",
                        Node::column(
                            "sections",
                            vec![
                                Node::text("intro", vec![]).size(Size::Fixed(15)),
                                list.size(Size::Fixed(10)),
                            ],
                        ),
                    )
                } else {
                    list
                }
            };
            let target = if nested {
                "outer/sections/list/rows/20"
            } else {
                "list/rows/20"
            };
            let mut surface = Surface::default();
            draw(&mut surface, 80, 40, tree());
            surface.move_focus(target.into());
            draw(&mut surface, 80, 40, tree());
            assert!(!surface.rect(target).unwrap().is_empty());
            surface.input(&Event::Resize(40, 8));
            let screen = draw(&mut surface, 40, 8, tree());
            assert!(
                !screen.contains("belongs"),
                "corrective layout must erase the first pass"
            );
            assert_eq!(surface.focused(), Some(target));
            let rect = surface.rect(target).unwrap();
            assert_eq!(
                rect.height, 1,
                "the focused row stays visible across reflow"
            );
            assert_eq!(
                surface.input(&click(rect.x, rect.y)).message,
                Some(Message::Pick(20))
            );
            for _ in 0..12 {
                surface.input(&mouse(MouseEventKind::ScrollUp, 1, 1));
                draw(&mut surface, 40, 8, tree());
            }
            assert!(
                surface.rect(target).unwrap().is_empty(),
                "manual scrolling can leave focus behind"
            );
            surface.input(&Event::Resize(50, 9));
            draw(&mut surface, 50, 9, tree());
            assert!(
                surface.rect(target).unwrap().is_empty(),
                "resize must respect that reading position"
            );
        }
    }

    #[test]
    fn keys_keep_focus_across_reordering_and_scroll_reveals_keyboard_targets() {
        let mut surface = Surface::default();
        let rows: Vec<_> = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]
            .into_iter()
            .map(|key| (key, true))
            .collect();
        draw(&mut surface, 50, 6, tree(&[0], 0, &rows));
        surface.input(&key(KeyCode::Right));
        for _ in 0..6 {
            surface.input(&key(KeyCode::Down));
            draw(&mut surface, 50, 6, tree(&[0], 0, &rows));
        }
        assert_eq!(surface.focus.as_deref(), Some("root/pane/rows/r6"));
        let screen = draw(&mut surface, 50, 6, tree(&[0], 0, &rows));
        assert!(
            screen.contains("r6"),
            "keyboard target scrolled into view:\n{screen}"
        );
        assert!(!screen.contains("r0"));
        let mut reversed = rows.clone();
        reversed.reverse();
        draw(&mut surface, 50, 6, tree(&[0], 0, &reversed));
        assert_eq!(
            surface.focus.as_deref(),
            Some("root/pane/rows/r6"),
            "stable keys, not positions, carry focus"
        );
        let wheel = surface.input(&mouse(MouseEventKind::ScrollUp, 30, 3));
        assert!(wheel.consumed && wheel.redraw);
        assert!(
            !surface.input(&key(KeyCode::Char('x'))).consumed,
            "unbound keys belong to the shell"
        );
    }
}
