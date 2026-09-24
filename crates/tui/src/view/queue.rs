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
use crate::pages::queue::{Command, Kind};

pub(super) fn height(app: &App, available: u16) -> u16 {
    (app.queue_rows().len() as u16).min(if available < 12 { 1 } else { 3 })
}
pub(super) fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let rows = app.queue_rows();
    if rows.is_empty() {
        if app.focus == Focus::Queue {
            app.focus = Focus::Composer;
        }
        return;
    }
    if area.is_empty() {
        return;
    }
    app.queue.area = Some(area);
    let selected = rows
        .iter()
        .position(|row| Some(&row.target.entry) == app.queue.selected.as_ref());
    if selected.is_none() && app.focus == Focus::Queue {
        // Do not silently select a different message after the selected entry was consumed.
        app.focus = Focus::Composer;
        app.queue.selected = None;
    }
    let start = selected
        .unwrap_or(0)
        .saturating_sub(usize::from(area.height).saturating_sub(1));
    for (offset, row) in rows
        .iter()
        .skip(start)
        .take(usize::from(area.height))
        .enumerate()
    {
        let rect = Rect::new(area.x, area.y + offset as u16, area.width, 1);
        let focused = app.focus == Focus::Queue && selected == Some(start + offset);
        let hovered = matches!(&app.hover, Some(Action::Queue(
            Command::Select(target) | Command::Edit(target) | Command::Retract(target) | Command::Promote(target) | Command::Reorder(target, _)
        )) if target == &row.target);
        let mut actions = vec![];
        if focused || hovered {
            if row.kind == Kind::Followup {
                actions.push(Command::Promote(row.target.clone()));
            }
            if row.kind != Kind::InFlight {
                if area.width >= 60 {
                    actions.push(Command::Reorder(row.target.clone(), false));
                    actions.push(Command::Reorder(row.target.clone(), true));
                }
                actions.push(Command::Edit(row.target.clone()));
                actions.push(Command::Retract(row.target.clone()));
            }
        }
        let action_width = actions.len() as u16 * 3;
        let prefix = match row.kind {
            Kind::Steering => app.chrome.symbol("↗", "s"),
            Kind::InFlight => app.chrome.symbol("…", "~"),
            Kind::Followup => app.chrome.symbol("↳", "q"),
        };
        let text = row
            .content
            .display_text
            .as_deref()
            .unwrap_or(&row.content.text);
        let text = if text.trim().is_empty() {
            app.i18n.text("queue-attachments")
        } else {
            safe(text)
        };
        let preview = Rect::new(rect.x, rect.y, rect.width.saturating_sub(action_width), 1);
        let style = if focused || hovered {
            if app.theme.choice == crate::theme::Choice::Terminal {
                Style::default()
                    .fg(app.theme.colors().muted)
                    .add_modifier(Modifier::REVERSED)
            } else {
                Style::default()
                    .fg(app.theme.colors().muted)
                    .bg(app.theme.colors().surface)
            }
        } else {
            Style::default().fg(app.theme.colors().muted)
        };
        frame.render_widget(
            Paragraph::new(format!(" {prefix} {text}")).style(style),
            preview,
        );
        if !preview.is_empty() {
            app.hits.push(Hit {
                area: preview,
                action: Action::Queue(Command::Select(row.target.clone())),
            });
        }
        for (index, action) in actions.into_iter().enumerate() {
            icon_button(
                frame,
                app,
                Rect::new(preview.right() + index as u16 * 3, rect.y, 3, 1),
                Action::Queue(action),
                false,
            );
        }
    }
}
