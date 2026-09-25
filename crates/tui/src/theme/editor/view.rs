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

use super::{Command, SWATCHES};
use crate::{
    app::{Action, App},
    ui::{Node, On, Role, Sheet, Size, Tone},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub(super) const NAME: &str = "name";
pub(super) const HEX: &str = "columns/colors/hex";
const ROLES: &str = "columns/roles/list/rows";
const SWATCH_ROWS: &str = "columns/colors/swatches";
const PREVIEW: &str = "columns/colors/preview";
/// Swatches per row of the grid.
const ACROSS: usize = 6;

fn action(command: Command) -> Action {
    Action::Theme(command)
}

/// Customizing the theme: a name, a preset to start from, then each color
/// role chosen from the list (the selection follows the focus) and set from
/// a swatch or as #RRGGBB, previewed live on the page behind. The sheet
/// keeps the colors it opened with, so its controls stay readable.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let editor = app.theme.editor.as_ref()?;
    let height = app.frame_size.map_or(24, |(_, height)| height);
    let name_label = app.i18n.text("theme-name");
    let mut sheet = Sheet::new("theme", app.i18n.text("theme-customize"))
        .body(Node::row(
            NAME,
            vec![
                Node::text("label", vec![(name_label.clone(), Tone::Muted)])
                    .size(Size::Fixed(name_label.width() as u16 + 2)),
                Node::slot("input", 1)
                    .on(On::Activate(action(Command::Save)))
                    .size(Size::Fill),
            ],
        ))
        .body(
            Node::row(
                "base",
                ["Maka", "Dusk", "Paper"]
                    .into_iter()
                    .enumerate()
                    .map(|(index, label)| {
                        Node::button(index.to_string(), label.into(), Role::Normal)
                            .on(On::Activate(action(Command::Base(index))))
                            .current(editor.base == index)
                    })
                    .collect(),
            )
            .gap(1),
        );
    let width = crate::ui::content_width(app.frame_size.map_or(80, |(width, _)| width));
    let entries = editor.colors.entries();
    let roles = entries
        .iter()
        .enumerate()
        .map(|(index, (key, _))| {
            // Two cells for the color itself, painted by `draw`.
            let label = format!("   {}", app.i18n.text(&format!("theme-role-{key}")));
            Node::text(index.to_string(), vec![(label, Tone::Normal)])
                .clip()
                .on(On::Activate(action(Command::Role(index))))
                .current(editor.role == index)
                .follow_focus()
        })
        .collect();
    let swatches = SWATCHES
        .chunks(ACROSS)
        .enumerate()
        .map(|(row, chunk)| {
            Node::row(
                format!("r{row}"),
                (0..chunk.len())
                    .map(|column| {
                        let index = row * ACROSS + column;
                        Node::text(index.to_string(), vec![(String::new(), Tone::Normal)])
                            .on(On::Activate(action(Command::Swatch(index))))
                            .size(Size::Fill)
                    })
                    .collect(),
            )
            .gap(1)
        })
        .collect();
    let colors = Node::column(
        "colors",
        vec![
            Node::text(
                "label",
                vec![(app.i18n.text("theme-swatches"), Tone::Muted)],
            ),
            Node::column("swatches", swatches).focus_group(),
            Node::row(
                "hex",
                vec![
                    Node::text("label", vec![("#RRGGBB".into(), Tone::Muted)]).size(Size::Fixed(9)),
                    Node::slot("input", 1)
                        .on(On::Activate(action(Command::Hex)))
                        .size(Size::Fill),
                ],
            ),
            Node::slot("preview", 2),
        ],
    )
    .gap(1)
    .size(Size::Fill);
    sheet = sheet.body(
        Node::row(
            "columns",
            vec![
                Node::column(
                    "roles",
                    vec![
                        Node::scroll("list", Node::column("rows", roles).focus_group())
                            .size(Size::Upto(height.saturating_sub(16).clamp(5, 12))),
                    ],
                )
                .size(Size::Fixed(22.min(width / 2 - 1))),
                colors,
            ],
        )
        .gap(2),
    );
    // The file line: what went wrong, else where the theme lives, and
    // loading that file again.
    let label = app.i18n.text("theme-reload-file");
    let room = width.saturating_sub(label.width() as u16 + 6);
    let reload = Node::button("reload", label, Role::Normal)
        .on(On::Activate(action(Command::Reload)))
        .enabled(!app.theme.busy());
    let error = editor
        .error
        .map(|key| app.i18n.text(key))
        .or_else(|| app.theme.error_text(&app.i18n));
    let status = match (error, &app.theme.path) {
        (Some(error), _) => Node::text("status", vec![(error, Tone::Warning)]),
        (None, Some(path)) => Node::text(
            "status",
            vec![(
                app.i18n.format(
                    "theme-path",
                    &[(
                        "path",
                        &tail(&crate::view::safe(&path.to_string_lossy()), room),
                    )],
                ),
                Tone::Subtle,
            )],
        )
        .clip(),
        (None, None) => Node::text("status", vec![]),
    };
    sheet = sheet.body(Node::row("file", vec![status.size(Size::Fill), reload]).gap(2));
    let busy = app.theme.busy();
    Some(
        sheet
            .button(
                "cancel",
                app.i18n.text(Command::Close.label()),
                Role::Normal,
                action(Command::Close),
                true,
            )
            .button(
                "save",
                app.i18n.text(Command::Save.label()),
                Role::Primary,
                action(Command::Save),
                !busy,
            )
            .focus_node(format!("{ROLES}/{}", editor.role)),
    )
}

/// The end of a long path, where the file name is.
fn tail(text: &str, width: u16) -> String {
    let width = usize::from(width).saturating_sub(8);
    if text.width() <= width {
        return text.to_owned();
    }
    let mut tail = String::new();
    for grapheme in text.graphemes(true).rev() {
        if tail.width() + grapheme.width() + 1 > width {
            break;
        }
        tail.insert_str(0, grapheme);
    }
    format!("…{tail}")
}

/// Paints what the kernel cannot: each role's color, the swatches, the two
/// text fields and the preview, over the sheet just drawn.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let focused = app.layer.focused_path().map(str::to_owned);
    let name = app.layer.slot(NAME).filter(|rect| !rect.is_empty());
    let hex = app.layer.slot(HEX).filter(|rect| !rect.is_empty());
    let roles: Vec<_> = (0..24)
        .map(|index| app.layer.rect(&format!("{ROLES}/{index}")))
        .collect();
    let swatches: Vec<_> = (0..SWATCHES.len())
        .map(|index| {
            app.layer
                .rect(&format!("{SWATCH_ROWS}/r{}/{index}", index / ACROSS))
        })
        .collect();
    let preview = app.layer.rect(PREVIEW).filter(|rect| !rect.is_empty());
    let busy = app.theme.busy();
    let text = app.i18n.text("theme-preview");
    let Some(editor) = app.theme.editor.as_mut() else {
        return;
    };
    let chrome = editor.chrome;
    let entries = editor.colors.entries();
    let buffer = frame.buffer_mut();
    for (rect, (_, color)) in roles.iter().zip(entries) {
        if let Some(rect) = rect.filter(|rect| !rect.is_empty()) {
            buffer.set_style(
                Rect::new(rect.x, rect.y, rect.width.min(2), 1),
                Style::default().bg(color),
            );
        }
    }
    for (index, rect) in swatches.iter().enumerate() {
        let Some(rect) = rect.filter(|rect| !rect.is_empty()) else {
            continue;
        };
        let color = super::super::rgb(SWATCHES[index]);
        let Color::Rgb(r, g, b) = color else {
            unreachable!()
        };
        // Readable ink on light and dark swatches alike.
        let ink = if u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114 > 145000 {
            Color::Black
        } else {
            Color::White
        };
        let mut style = Style::default().bg(color).fg(ink);
        if focused.as_deref() == Some(&format!("{SWATCH_ROWS}/r{}/{index}", index / ACROSS)) {
            style = style.add_modifier(Modifier::UNDERLINED | Modifier::BOLD);
        }
        let mark = if color == entries[editor.role].1 {
            if app.chrome.ascii { "*" } else { "✓" }
        } else {
            " "
        };
        frame.render_widget(Paragraph::new(mark).centered().style(style), rect);
    }
    let fields = [(name, &mut editor.name, NAME), (hex, &mut editor.hex, HEX)];
    for (rect, field, key) in fields {
        match rect {
            Some(rect) => {
                let here = !busy && focused.as_deref() == Some(&format!("{key}/input"));
                field.draw(frame, rect, here, chrome);
            }
            None => field.invalidate_geometry(),
        }
    }
    if let Some(rect) = preview {
        let colors = editor.colors;
        let surface = Style::default().bg(colors.surface);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(text, Style::default().fg(colors.foreground))),
                Line::from(vec![
                    Span::styled("fn", Style::default().fg(colors.syntax[0])),
                    Span::styled(" main", Style::default().fg(colors.syntax[4])),
                    Span::styled("() { ", Style::default().fg(colors.syntax[6])),
                    Span::styled("42", Style::default().fg(colors.syntax[3])),
                    Span::styled(" }", Style::default().fg(colors.syntax[6])),
                ]),
            ])
            .style(surface),
            rect,
        );
    }
}
