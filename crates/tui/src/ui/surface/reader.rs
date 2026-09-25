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

//! Transcript placement and local interaction share the surface's committed
//! geometry. A disappeared mount cannot receive a click from a previous frame.
use super::*;
use crate::ui::transcript::{self, Effect, Hit, Transcript, search::Command, selection::CopyMode};
use ratatui::widgets::Paragraph;
use uuid::Uuid;

pub(crate) struct Placement {
    pub path: String,
    pub token: Uuid,
    pub area: Rect,
    pub hits: Vec<Hit>,
    pub latest: Option<Rect>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReaderEffect {
    Copy(String),
    Older,
    Newer,
    Latest,
    Refresh,
    Error(&'static str),
}

impl<M: Clone> Surface<M> {
    /// A local read failure leaves the last good content below a quiet notice.
    pub fn transcript_notice(
        &mut self,
        frame: &mut Frame<'_>,
        token: Uuid,
        text: &str,
        colors: Palette,
    ) {
        let Some(placed) = self.committed.as_mut().and_then(|committed| {
            committed
                .transcripts
                .iter_mut()
                .find(|placed| placed.token == token)
        }) else {
            return;
        };
        if placed.area.height == 0 {
            return;
        }
        frame.render_widget(
            Paragraph::new(text).style(colors.base().fg(colors.subtle)),
            Rect::new(placed.area.x, placed.area.y, placed.area.width, 1),
        );
        placed.area.y += 1;
        placed.area.height -= 1;
        placed.hits.clear();
    }
    pub fn transcript_area(&self, token: Uuid) -> Option<Rect> {
        self.committed
            .as_ref()?
            .transcripts
            .iter()
            .find(|placed| placed.token == token)
            .map(|placed| placed.area)
    }

    pub fn paint_transcript(
        &mut self,
        frame: &mut Frame<'_>,
        token: Uuid,
        reader: &mut Transcript,
        context: Context,
        local_controls: bool,
    ) -> Result<Vec<Hit>, &'static str> {
        let Some(placed) = self.committed.as_mut().and_then(|committed| {
            committed
                .transcripts
                .iter_mut()
                .find(|placed| placed.token == token)
        }) else {
            reader.text_selection.invalidate_geometry();
            reader.invalidate_scrollbar();
            return Ok(vec![]);
        };
        let mut area = placed.area;
        let focused = context.focused && self.focus.as_ref() == Some(&placed.path);
        // A body click selects source text without revealing the message's
        // header. Keyboard navigation explicitly leaves this reading mode.
        reader.focused = focused && !reader.mouse_selected;
        reader.colors = context.colors;
        if local_controls
            && area.height > 1
            && let Some(search) = &mut reader.search
        {
            let count = search.count();
            let tail = (count.width() as u16).min(area.width / 3);
            frame.render_widget(
                Paragraph::new(if context.ascii { "/ " } else { "⌕ " })
                    .style(context.colors.base().fg(context.colors.subtle)),
                Rect::new(area.x, area.y, area.width.min(2), 1),
            );
            search.editor.draw(
                frame,
                Rect::new(
                    area.x.saturating_add(2),
                    area.y,
                    area.width.saturating_sub(tail + 3),
                    1,
                ),
                focused,
                context.colors,
            );
            frame.render_widget(
                Paragraph::new(count).style(context.colors.base().fg(context.colors.subtle)),
                Rect::new(area.right().saturating_sub(tail), area.y, tail, 1),
            );
            area.y += 1;
            area.height -= 1;
        }
        if area.is_empty() {
            reader.text_selection.invalidate_geometry();
            reader.invalidate_scrollbar();
            placed.hits.clear();
            return Ok(vec![]);
        }
        let hits = reader.draw(frame, area, context.ascii)?;
        placed.hits = hits.clone();
        placed.latest = (local_controls && reader.unseen).then(|| {
            Rect::new(
                area.right().saturating_sub(1),
                area.bottom().saturating_sub(1),
                1,
                1,
            )
        });
        if let Some(rect) = placed.latest {
            frame.render_widget(
                Paragraph::new(if context.ascii { "v" } else { "▼" })
                    .style(context.colors.base().fg(context.colors.accent)),
                rect,
            );
        }
        Ok(hits)
    }

    pub fn transcript_input(
        &mut self,
        token: Uuid,
        reader: &mut Transcript,
        event: &Event,
        keyboard: bool,
        ascii: bool,
    ) -> Outcome<ReaderEffect> {
        if matches!(event, Event::Resize(..) | Event::FocusLost) {
            reader.text_selection.invalidate_geometry();
            reader.invalidate_scrollbar();
            return Outcome::ignored();
        }
        if self.captures() {
            return Outcome::ignored();
        }
        let Some(placed) = self.committed.as_ref().and_then(|committed| {
            committed
                .transcripts
                .iter()
                .find(|placed| placed.token == token)
        }) else {
            reader.text_selection.invalidate_geometry();
            reader.invalidate_scrollbar();
            return Outcome::ignored();
        };
        if placed.area.is_empty() {
            return Outcome::ignored();
        }
        let focused = keyboard && self.focus.as_ref() == Some(&placed.path);
        if let Event::Mouse(mouse) = event {
            if mouse.kind == MouseEventKind::Down(MouseButton::Left)
                && placed
                    .latest
                    .is_some_and(|rect| rect.contains((mouse.column, mouse.row).into()))
            {
                let path = placed.path.clone();
                self.focus(path);
                reader.text_selection.end_drag();
                reader.invalidate_scrollbar();
                reader.latest();
                return Outcome::emit(ReaderEffect::Latest);
            }
            let inside = placed.area.contains((mouse.column, mouse.row).into());
            if !inside && !reader.text_selection.dragging() && !reader.scrollbar_dragging() {
                return Outcome::ignored();
            }
            let path = placed.path.clone();
            let click = placed
                .hits
                .iter()
                .rev()
                .find(|hit| hit.area.contains((mouse.column, mouse.row).into()))
                .map(|hit| hit.effect.clone());
            if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                self.focus(path);
            }
            if reader.scrollbar_mouse(*mouse) {
                return Outcome::handled(true);
            }
            if let Some(effect) = reader.text_mouse(*mouse, click) {
                return effect
                    .map_or_else(|| Outcome::handled(true), |effect| local(reader, effect));
            }
            if let Some(redraw) = reader.search_input(event) {
                return Outcome::handled(redraw);
            }
            match mouse.kind {
                MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                    let up = mouse.kind == MouseEventKind::ScrollUp;
                    reader.scroll(up, 3);
                    if up && reader.at_top() {
                        return Outcome::emit(ReaderEffect::Older);
                    }
                    if !up && reader.following() {
                        return Outcome::emit(ReaderEffect::Newer);
                    }
                    return Outcome::handled(true);
                }
                MouseEventKind::Moved => {
                    let hover = placed_key(reader, mouse.column, mouse.row, self, token);
                    let changed = reader.hovered != hover;
                    reader.hovered = hover;
                    return Outcome::handled(changed);
                }
                _ => return Outcome::ignored(),
            }
        }
        if !focused {
            return Outcome::ignored();
        }
        if let Event::Key(key) = event
            && key.kind != KeyEventKind::Release
        {
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('r') {
                return Outcome::emit(ReaderEffect::Refresh);
            }
            if key.modifiers == KeyModifiers::SHIFT
                && let Some(redraw) = reader.selection_key(key.code)
            {
                return Outcome::handled(redraw);
            }
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                let mode = if key.modifiers.contains(KeyModifiers::SHIFT) {
                    CopyMode::Source
                } else if reader.text_selection.active() {
                    CopyMode::Selection
                } else {
                    CopyMode::Message
                };
                return Outcome::emit(match reader.copy_text(mode, ascii) {
                    Ok(text) => ReaderEffect::Copy(text),
                    Err(error) => ReaderEffect::Error(error),
                });
            }
            // The source offers no native full-history authority. Local find
            // cannot switch itself into a Session search by a keyboard chord.
            if key.modifiers.contains(KeyModifiers::ALT) && key.code == KeyCode::Char('f') {
                return Outcome::handled(false);
            }
        }
        if let Some(redraw) = reader.search_input(event) {
            return Outcome::handled(redraw);
        }
        let Event::Key(key) = event else {
            return Outcome::ignored();
        };
        if key.kind == KeyEventKind::Release {
            return Outcome::ignored();
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('f') {
            reader.search_command(Command::Open);
            return Outcome::handled(true);
        }
        if key.modifiers.intersects(
            KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META,
        ) {
            return Outcome::ignored();
        }
        match key.code {
            KeyCode::Up | KeyCode::Down => reader.move_selection(key.code == KeyCode::Down),
            KeyCode::Home => {
                reader.first();
                return Outcome::emit(ReaderEffect::Older);
            }
            KeyCode::End => {
                reader.latest();
                return Outcome::emit(ReaderEffect::Latest);
            }
            KeyCode::Left | KeyCode::Right => {
                if let Some(key) = reader.horizontal(key.code == KeyCode::Right) {
                    reader.toggle(&key);
                }
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                if let Some(key) = reader.selection() {
                    reader.toggle(&key);
                }
            }
            KeyCode::PageUp | KeyCode::PageDown => {
                let up = key.code == KeyCode::PageUp;
                reader.scroll(up, usize::from(placed.area.height.saturating_sub(1)).max(1));
                if up && reader.at_top() {
                    return Outcome::emit(ReaderEffect::Older);
                }
                if !up && reader.following() {
                    return Outcome::emit(ReaderEffect::Newer);
                }
            }
            KeyCode::Esc if reader.text_selection.has_caret() => reader.text_selection.clear(),
            _ => return Outcome::ignored(),
        }
        Outcome::handled(true)
    }
}

fn local(reader: &mut Transcript, effect: Effect) -> Outcome<ReaderEffect> {
    match effect {
        Effect::Disclosure(key) => {
            reader.toggle(&key);
            Outcome::handled(true)
        }
        Effect::Link { key, revision } => reader
            .link(&key, &revision)
            .map(|path| Outcome::emit(ReaderEffect::Copy(path.into())))
            .unwrap_or_else(|| Outcome::handled(false)),
    }
}
fn placed_key<M: Clone>(
    reader: &Transcript,
    x: u16,
    y: u16,
    surface: &Surface<M>,
    token: Uuid,
) -> Option<transcript::MessageKey> {
    surface
        .committed
        .as_ref()?
        .transcripts
        .iter()
        .find(|placed| placed.token == token)?
        .hits
        .iter()
        .find_map(|hit| match &hit.effect {
            Effect::Disclosure(key) if hit.area.contains((x, y).into()) && reader.contains(key) => {
                Some(key.clone())
            }
            _ => None,
        })
}
