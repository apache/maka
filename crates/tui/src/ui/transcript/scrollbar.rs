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

#[derive(Default)]
pub(super) struct Scrollbar {
    geometry: Option<(Rect, usize)>,
    drag: Option<(u16, usize, usize)>,
}

impl Transcript {
    pub fn scrollbar_dragging(&self) -> bool {
        self.scrollbar.drag.is_some()
    }
    pub fn invalidate_scrollbar(&mut self) {
        self.scrollbar = Scrollbar::default();
    }

    fn scrollbar_geometry(&self) -> Option<(Rect, Rect)> {
        let (area, total) = self.scrollbar.geometry?;
        let visible = usize::from(area.height);
        if total <= visible || area.width < 6 || area.height < 2 {
            return None;
        }
        let height = (visible * visible / total).max(1) as u16;
        let travel = usize::from(area.height - height);
        let offset = self.top.min(total - visible) * travel / (total - visible);
        let track = Rect::new(area.right() - 1, area.y, 1, area.height);
        Some((
            track,
            Rect::new(track.x, track.y + offset as u16, 1, height),
        ))
    }

    pub(super) fn draw_scrollbar(&mut self, frame: &mut Frame<'_>, area: Rect, ascii: bool) {
        let geometry = Some((area, self.total));
        if self
            .scrollbar
            .geometry
            .is_some_and(|(previous, _)| previous != area)
        {
            self.scrollbar.drag = None;
        }
        self.scrollbar.geometry = geometry;
        let Some((track, thumb)) = self.scrollbar_geometry() else {
            self.scrollbar.drag = None;
            return;
        };
        for y in track.y..track.bottom() {
            let active = y >= thumb.y && y < thumb.bottom();
            let symbol = if ascii {
                if active { "#" } else { "|" }
            } else if active {
                "┃"
            } else {
                "│"
            };
            let color = if active {
                self.colors.scrollbar
            } else {
                self.colors.border
            };
            frame.render_widget(
                Paragraph::new(symbol).style(Style::default().fg(color)),
                Rect::new(track.x, y, 1, 1),
            );
        }
    }

    pub fn scrollbar_mouse(&mut self, event: MouseEvent) -> bool {
        let Some((track, thumb)) = self.scrollbar_geometry() else {
            return false;
        };
        let maximum = self.total.saturating_sub(self.height);
        let travel = usize::from(track.height - thumb.height).max(1);
        let target = match event.kind {
            MouseEventKind::Down(MouseButton::Left)
                if track.contains((event.column, event.row).into()) =>
            {
                self.text_selection.clear();
                let top = if thumb.contains((event.column, event.row).into()) {
                    self.top
                } else {
                    (usize::from(event.row.saturating_sub(track.y + thumb.height / 2)) * maximum
                        / travel)
                        .min(maximum)
                };
                self.scrollbar.drag = Some((event.row, top, maximum));
                top
            }
            MouseEventKind::Drag(MouseButton::Left) if self.scrollbar.drag.is_some() => {
                let (row, top, original_maximum) = self.scrollbar.drag.unwrap();
                // Measured heights refine while dragging. Keep the original
                // proportional position rather than cancelling capture.
                let top =
                    (top as u128 * maximum as u128 / original_maximum.max(1) as u128) as usize;
                let delta =
                    (i64::from(event.row) - i64::from(row)) * maximum as i64 / travel as i64;
                (top as i64 + delta).clamp(0, maximum as i64) as usize
            }
            MouseEventKind::Up(MouseButton::Left) if self.scrollbar.drag.take().is_some() => {
                return true;
            }
            _ => return false,
        };
        self.scroll(target < self.top, target.abs_diff(self.top));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use crossterm::event::KeyModifiers;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    #[test]
    fn track_drag_follow_resize_and_short_content_share_rendered_geometry() {
        let mut view = Transcript::default();
        let rows = (0..30).map(|i| (i, json!({"id":format!("m{i}"),"turnId":"t","type":"assistant","text":format!("line {i}: {}", "x".repeat(67))}))).collect();
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        view.sync(&rows, &[], 0, &i18n, false);
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let draw = |view: &mut Transcript, terminal: &mut Terminal<TestBackend>| {
            terminal
                .draw(|f| {
                    view.draw(f, f.area(), false).unwrap();
                })
                .unwrap();
        };
        draw(&mut view, &mut terminal);
        let (track, thumb) = view.scrollbar_geometry().unwrap();
        assert_eq!(thumb.bottom(), track.bottom());
        let mouse = |kind, x, y| MouseEvent {
            kind,
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        };
        assert!(!view.scrollbar_mouse(mouse(MouseEventKind::Down(MouseButton::Left), 2, 0)));
        assert!(view.scrollbar_mouse(mouse(
            MouseEventKind::Down(MouseButton::Left),
            track.x,
            track.y
        )));
        assert_eq!(view.top, 0);
        assert!(!view.following());
        let estimated_total = view.total;
        draw(&mut view, &mut terminal);
        assert_ne!(
            view.total, estimated_total,
            "newly measured rows refine the estimate"
        );
        assert!(view.scrollbar_dragging());
        assert!(view.scrollbar_mouse(mouse(
            MouseEventKind::Drag(MouseButton::Left),
            0,
            track.bottom() + 3
        )));
        assert!(view.following());
        assert!(view.scrollbar_mouse(mouse(MouseEventKind::Up(MouseButton::Left), 0, 12)));
        view.scrollbar_mouse(mouse(
            MouseEventKind::Down(MouseButton::Left),
            track.x,
            track.y,
        ));
        terminal.backend_mut().resize(30, 8);
        terminal.resize(Rect::new(0, 0, 30, 8)).unwrap();
        draw(&mut view, &mut terminal);
        assert!(!view.scrollbar_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), 29, 7)));
        // The App must keep a native drag captured while it crosses shell
        // regions; release there must still reach the original scrollbar.
        let mut app = crate::app::App::new(
            "/fixture".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.apply(crate::app::Action::Visit(
            crate::navigation::Route::Session("chat".into()),
        ));
        app.chat
            .select(&crate::navigation::Route::Session("chat".into()));
        app.chat.snapshot = Some(maka_protocol::subscription::decode_session_observation_snapshot(&json!({
            "schemaVersion":5,"session":{"sessionId":"chat","metadataRevision":1,"status":"active","createdAt":0,"isArchived":false},
            "projectionRevision":1,"rootTurn":null,"goal":null,
            "queue":{"hostEpoch":"epoch","queueRevision":0,"steering":[],"followup":[]},"interactions":{"pending":[]}
        })).unwrap());
        app.chat.fixture_rows(rows);
        let mut shell = Terminal::new(TestBackend::new(80, 24)).unwrap();
        for destination in ["header/left/sidebar", "composer/body/actions/buttons/send"] {
            shell
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let (track, _) = app.chat.view.scrollbar_geometry().unwrap();
            assert_eq!(
                app.input(crossterm::event::Event::Mouse(mouse(
                    MouseEventKind::Down(MouseButton::Left),
                    track.x,
                    track.y
                )))
                .1,
                None
            );
            assert!(app.chat.view.scrollbar_dragging());
            let target = app
                .chrome
                .header
                .rect(destination)
                .or_else(|| app.chrome.composer.rect(destination))
                .unwrap();
            assert_eq!(
                app.input(crossterm::event::Event::Mouse(mouse(
                    MouseEventKind::Drag(MouseButton::Left),
                    target.x,
                    target.y
                )))
                .1,
                None
            );
            assert!(app.chat.view.scrollbar_dragging());
            assert_eq!(
                app.input(crossterm::event::Event::Mouse(mouse(
                    MouseEventKind::Up(MouseButton::Left),
                    target.x,
                    target.y
                )))
                .1,
                None
            );
            assert!(!app.chat.view.scrollbar_dragging());
            assert_eq!(app.focus, crate::app::Focus::Transcript);
        }
        view.invalidate_scrollbar();
        assert!(view.scrollbar_geometry().is_none());
        view.sync(&BTreeMap::new(), &[], 1, &i18n, false);
        draw(&mut view, &mut terminal);
        assert!(view.scrollbar_geometry().is_none());
    }
}
