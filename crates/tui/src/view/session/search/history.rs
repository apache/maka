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
use crate::pages::chat::history::History;

pub(super) fn draw(
    frame: &mut Frame<'_>,
    history: &mut History,
    area: Rect,
    i18n: &crate::i18n::I18n,
    ascii: bool,
    colors: crate::theme::Palette,
    available: bool,
) -> Vec<Hit> {
    history.invalidate_geometry();
    history.prepare_preview(i18n, ascii);
    if area.is_empty() {
        return vec![];
    }
    let columns = if area.width >= 100 {
        Layout::horizontal([
            Constraint::Percentage(34),
            Constraint::Length(1),
            Constraint::Min(1),
        ])
        .split(area)
    } else {
        Layout::vertical([
            Constraint::Length(
                (area.height / 3)
                    .clamp(1, 6)
                    .min(history.matches.len().max(1) as u16),
            ),
            Constraint::Length(1),
            Constraint::Min(1),
        ])
        .split(area)
    };
    let list = columns[0];
    let body = columns[2];
    history.list_area = Some(list);
    history.preview_area = Some(body);
    let mut hits = Vec::new();
    let offset = history
        .selected
        .saturating_sub(usize::from(list.height) / 2)
        .min(
            history
                .matches
                .len()
                .saturating_sub(usize::from(list.height)),
        );
    for (index, item) in history
        .matches
        .iter()
        .enumerate()
        .skip(offset)
        .take(usize::from(list.height))
    {
        let row = Rect::new(list.x, list.y + (index - offset) as u16, list.width, 1);
        let selected = index == history.selected;
        let marker = if selected {
            if ascii { ">" } else { "›" }
        } else {
            " "
        };
        let text = fit(
            &safe(&item.preview),
            usize::from(list.width.saturating_sub(2)),
        );
        let line = Line::from(vec![
            Span::styled(format!("{marker} "), Style::default().fg(colors.accent)),
            Span::raw(text),
        ]);
        let style = if selected {
            if colors.terminal {
                Style::default().add_modifier(Modifier::REVERSED)
            } else {
                Style::default().bg(colors.surface)
            }
        } else {
            Style::default()
        };
        frame.render_widget(Paragraph::new(line).style(style), row);
        hits.push(Hit {
            area: row,
            action: Action::Search(Command::Pick(item.sequence)),
        });
    }
    let message = if !available {
        Some("chat-search-connect")
    } else if history.error.is_some() {
        // The session's single feedback row owns the summary and opt-in detail.
        None
    } else if history.matches.is_empty() {
        Some(if history.query_empty() {
            "chat-search-history-prompt"
        } else if history.scanning {
            "chat-search-scanning"
        } else {
            "chat-search-no-matches"
        })
    } else {
        None
    };
    if let Some(message) = message {
        frame.render_widget(
            Paragraph::new(i18n.text(message))
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(colors.subtle)),
            body,
        );
    } else if let Some(preview) = &mut history.preview {
        preview.colors = colors;
        let context = crate::ui::Context {
            colors,
            ascii,
            focused: preview.focused,
        };
        history.reader_surface.render(
            frame,
            body,
            crate::ui::Node::transcript("transcript", uuid::Uuid::nil()),
            context,
        );
        match history.reader_surface.paint_transcript(
            frame,
            uuid::Uuid::nil(),
            preview,
            context,
            false,
        ) {
            Ok(found) => hits.extend(found.into_iter().filter_map(|hit| {
                use crate::ui::transcript::Effect;
                let action = match hit.effect {
                    Effect::Disclosure(key) => Action::Search(Command::PreviewToggle(key)),
                    Effect::Link { key, revision } => {
                        Action::CopyFile(preview.link(&key, &revision)?.into())
                    }
                };
                Some(Hit {
                    area: hit.area,
                    action,
                })
            })),
            Err(error) => history.fail(error.into()),
        }
    } else if history.preview_loading {
        frame.render_widget(
            Paragraph::new(i18n.text("chat-search-preview-loading"))
                .style(Style::default().fg(colors.subtle)),
            body,
        );
    }
    hits
}
