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

//! Labelled text rows of a form sheet. Each whole row is one kernel slot,
//! so a form's rows share a focus group and the arrows walk them; the
//! label and the editor are painted here, over the drawn sheet.
use crate::{editor::Editor, theme::Palette, view::tone};
use ratatui::{Frame, layout::Rect, style::Style, widgets::Paragraph};

/// The label column for labels this wide, on a terminal this wide.
pub(crate) fn label_width(labels: impl IntoIterator<Item = usize>, terminal: u16) -> u16 {
    let width = crate::ui::content_width(terminal);
    let widest = labels.into_iter().max().unwrap_or(0) as u16;
    (widest + 2).min(width * 2 / 5)
}

/// One row: its label, then the editor (masked for secrets), or a
/// placeholder while the field is empty and unfocused.
pub(crate) struct Row<'a> {
    pub label: &'a str,
    pub focused: bool,
    pub masked: bool,
    pub placeholder: Option<&'a str>,
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    rect: Rect,
    width: u16,
    row: Row<'_>,
    editor: &mut Editor,
    colors: Palette,
) {
    // A multi-line field keeps its label on the first row, beside the text.
    let label = Rect::new(rect.x, rect.y, width.min(rect.width), rect.height);
    frame.buffer_mut().set_style(label, colors.base());
    frame.render_widget(
        Paragraph::new(row.label).style(Style::default().fg(if row.focused {
            tone::accent(colors)
        } else {
            colors.muted
        })),
        Rect::new(label.x, label.y, label.width.saturating_sub(1), 1),
    );
    let value = Rect::new(
        rect.x + label.width,
        rect.y,
        rect.width.saturating_sub(label.width),
        rect.height,
    );
    if row.masked {
        editor.draw_masked(frame, value, row.focused, colors);
    } else {
        editor.draw(frame, value, row.focused, colors);
    }
    if let Some(placeholder) = row.placeholder
        && editor.text().is_empty()
        && !row.focused
    {
        frame.render_widget(
            Paragraph::new(placeholder).style(Style::default().fg(colors.subtle)),
            value,
        );
    }
}
