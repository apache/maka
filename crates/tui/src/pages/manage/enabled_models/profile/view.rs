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

use super::super::{Command as Models, Manage};
use super::{Command, Draft, Field};
use crate::{
    app::{Action, App},
    pages::manage::Dialog,
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::{safe, tone},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::{
    Frame,
    layout::{Position, Rect},
    style::Style,
    widgets::Paragraph,
};

const ROWS: &str = "fields/rows";

fn action(command: Command) -> Action {
    Action::Manage(Manage::EnabledModels(Models::Profile(command)))
}

/// The form row a focus path points into.
fn row(path: &str) -> Option<usize> {
    path.strip_prefix(ROWS)?
        .strip_prefix('/')?
        .split('/')
        .next()?
        .parse()
        .ok()
}

fn label_width(app: &App) -> u16 {
    let width = crate::ui::content_width(app.frame_size.map_or(80, |(width, _)| width));
    20.min(width.saturating_sub(12))
}

fn label(app: &App, field: Field) -> String {
    if let Field::Level(level) = field {
        app.i18n.format(
            "model-profile-level",
            &[(
                "level",
                &app.i18n
                    .text(crate::pages::manage::models::thinking_key(Some(level))),
            )],
        )
    } else if let Field::Modality(direction, kind) = field {
        app.i18n.text(&format!("model-profile-{direction}-{kind}"))
    } else {
        app.i18n.text(field.label())
    }
}

fn display(app: &App, draft: &Draft, index: usize, field: Field) -> String {
    let checked = |yes: bool| {
        if yes {
            app.chrome.symbol("[✓]", "[x]").to_owned()
        } else {
            "[ ]".into()
        }
    };
    match field {
        Field::Level(level) => checked(
            draft.values["thinkingLevels"]
                .as_array()
                .is_some_and(|levels| levels.contains(&serde_json::json!(level))),
        ),
        Field::Boolean(_) | Field::Capability(_) => {
            app.i18n.text(match draft.field_value(field).as_bool() {
                Some(true) => "model-profile-on",
                Some(false) => "model-profile-off",
                None => "thinking-default",
            })
        }
        Field::Protocol => draft.values["apiProtocol"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| app.i18n.text("thinking-default")),
        Field::Advanced => if index + 1 < draft.fields.len() {
            app.chrome.symbol("⌄", "v")
        } else {
            app.chrome.symbol("›", ">")
        }
        .into(),
        Field::Modalities => app.i18n.text(if draft.values["modalities"].is_object() {
            "model-profile-custom"
        } else {
            "thinking-default"
        }),
        Field::Modality(direction, kind) => {
            if draft.values["modalities"].is_object() {
                checked(
                    draft.values["modalities"][direction]
                        .as_array()
                        .is_some_and(|items| items.contains(&serde_json::json!(kind))),
                )
            } else {
                app.i18n.text("thinking-default")
            }
        }
        Field::ServiceTier => {
            if draft.values["serviceTier"].is_null() {
                app.i18n.text("thinking-default")
            } else {
                "fast".into()
            }
        }
        Field::Text(_) | Field::Number(_) => unreachable!("text rows are drawn by their owner"),
    }
}

/// One model's settings: a form of labelled rows. Text rows are fields;
/// others cycle or toggle with Space, Enter or a click on their value, and
/// Backspace returns a row to the model's default. Esc or Back returns to
/// the list, where the model that was opened keeps focus.
pub(in crate::pages::manage::enabled_models) fn sheet(
    app: &App,
    dialog: &Dialog,
    draft: &Draft,
) -> Sheet<Action> {
    let busy = app.management.pending.is_some();
    let enabled = !busy && !dialog.blocked;
    let width = label_width(app);
    let rows = draft
        .fields
        .iter()
        .enumerate()
        .map(|(index, &field)| {
            let node = if field.editable() {
                Node::slot(index.to_string(), 1)
            } else {
                let adjustable = enabled && draft.accepts(&Command::Adjust(index, true));
                Node::row(
                    index.to_string(),
                    vec![
                        Node::text("label", vec![(label(app, field), Tone::Muted)])
                            .clip()
                            .size(Size::Fixed(width)),
                        Node::text(
                            "value",
                            vec![(
                                display(app, draft, index, field),
                                if adjustable {
                                    Tone::Accent
                                } else {
                                    Tone::Subtle
                                },
                            )],
                        )
                        .clip()
                        .size(Size::Fill),
                    ],
                )
            };
            node.on(On::Activate(action(Command::Field(index))))
                .enabled(enabled)
        })
        .collect();
    let height = app.frame_size.map_or(24, |(_, height)| height);
    let focused = app.layer.focused_path().and_then(row);
    let error = dialog
        .error
        .or_else(|| draft.value().err())
        .or_else(|| draft.texts.iter().find_map(|text| text.editor.error));
    let modalities = focused
        .and_then(|index| draft.fields.get(index))
        .is_some_and(|field| matches!(field, Field::Modalities | Field::Modality(_, _)));
    let (note, tone) = match (busy, error) {
        (true, _) => ("session-saving", Tone::Muted),
        (false, Some(error)) => (error, Tone::Warning),
        _ if modalities => ("model-profile-modalities-note", Tone::Muted),
        _ => ("model-profile-note", Tone::Muted),
    };
    Sheet::new(
        format!("profile:{}", draft.id),
        app.i18n.text("connection-model-overrides"),
    )
    .text("model", &safe(&draft.id), Tone::Muted)
    .body(
        Node::scroll("fields", Node::column("rows", rows))
            .size(Size::Upto(height.saturating_sub(16).max(4))),
    )
    .text("note", &app.i18n.text(note), tone)
    .aside(
        "back",
        app.i18n.text("model-profile-back"),
        action(Command::Back),
        true,
    )
    .back(action(Command::Back))
    .button(
        "cancel",
        app.i18n.text("session-cancel"),
        Role::Normal,
        Action::Manage(Manage::Close),
        true,
    )
    .button(
        "save",
        app.i18n.text("session-save"),
        Role::Primary,
        Action::Manage(Manage::Save),
        app.enabled(&Action::Manage(Manage::Save)),
    )
}

/// Paints the text rows: a label, then the editor, or the default when empty.
pub(in crate::pages::manage::enabled_models) fn draw(frame: &mut Frame<'_>, app: &mut App) {
    let width = label_width(app);
    let focused = app.layer.focused_path().and_then(row);
    let editable = app.management.pending.is_none();
    let colors = app.theme.colors();
    let default = app.i18n.text("thinking-default");
    let rects: Vec<Option<Rect>> = match app
        .management
        .dialog
        .as_ref()
        .and_then(|dialog| dialog.enabled_models.as_ref())
        .and_then(|state| state.profile.as_ref())
    {
        Some(draft) => (0..draft.fields.len())
            .map(|index| app.layer.rect(&format!("{ROWS}/{index}")))
            .collect(),
        None => return,
    };
    let labels: Vec<String> = {
        let draft = app
            .management
            .dialog
            .as_ref()
            .and_then(|dialog| dialog.enabled_models.as_ref())
            .and_then(|state| state.profile.as_ref())
            .expect("profile draft");
        draft
            .fields
            .iter()
            .map(|field| label(app, *field))
            .collect()
    };
    let Some(dialog) = app.management.dialog.as_mut() else {
        return;
    };
    let blocked = dialog.blocked;
    let Some(draft) = dialog
        .enabled_models
        .as_mut()
        .and_then(|state| state.profile.as_mut())
    else {
        return;
    };
    let fields = draft.fields.clone();
    for text in &mut draft.texts {
        let Some(index) = fields.iter().position(|field| *field == text.field) else {
            continue;
        };
        let Some(rect) = rects[index].filter(|rect| !rect.is_empty()) else {
            text.editor.invalidate_geometry();
            continue;
        };
        let here = focused == Some(index);
        let label = Rect::new(rect.x, rect.y, width.min(rect.width), 1);
        frame.buffer_mut().set_style(label, colors.base());
        frame.render_widget(
            Paragraph::new(labels[index].as_str()).style(Style::default().fg(if here {
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
            1,
        );
        text.editor
            .draw(frame, value, here && editable && !blocked, colors);
        if text.editor.text().is_empty() && !here {
            frame.render_widget(
                Paragraph::new(default.as_str()).style(Style::default().fg(colors.subtle)),
                value,
            );
        }
    }
}

/// Keys, pastes and pointer presses the form's rows take before the sheet.
pub(in crate::pages::manage::enabled_models) fn input(
    app: &mut App,
    event: &Event,
) -> Option<(bool, Option<Action>)> {
    let focused = app.layer.focused_path().and_then(row);
    let width = label_width(app);
    let busy = app.management.pending.is_some();
    let dialog = app.management.dialog.as_mut()?;
    if !dialog.visible || dialog.blocked || busy {
        return None;
    }
    let draft = dialog.enabled_models.as_mut()?.profile.as_mut()?;
    let command = match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Enter {
                return Some((true, app.apply(Action::Manage(Manage::Save))));
            }
            let index = focused?;
            let field = *draft.fields.get(index)?;
            if field.editable() {
                if matches!(
                    key.code,
                    KeyCode::Esc
                        | KeyCode::Tab
                        | KeyCode::BackTab
                        | KeyCode::Up
                        | KeyCode::Down
                        | KeyCode::PageUp
                        | KeyCode::PageDown
                ) || (key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('q'))
                {
                    return None;
                }
                if key.code == KeyCode::Enter {
                    // Enter moves on to the next setting, like a form.
                    if index + 1 < draft.fields.len() {
                        app.layer.focus_path(&format!("{ROWS}/{}", index + 1));
                    }
                    return Some((true, None));
                }
                let text = draft.texts.iter_mut().find(|text| text.field == field)?;
                return Some((text.editor.key(*key), None));
            }
            if !key.modifiers.is_empty() {
                return None;
            }
            match key.code {
                KeyCode::Char(' ') | KeyCode::Enter | KeyCode::Right => {
                    Command::Adjust(index, true)
                }
                KeyCode::Left => Command::Adjust(index, false),
                KeyCode::Backspace | KeyCode::Delete => Command::Default(index),
                _ => return None,
            }
        }
        Event::Paste(text) if !text.chars().any(char::is_control) => {
            let field = *draft.fields.get(focused?)?;
            let editor = draft.texts.iter_mut().find(|item| item.field == field)?;
            return Some((editor.editor.insert(text), None));
        }
        Event::Mouse(mouse) => {
            let point = Position::new(mouse.column, mouse.row);
            let fields = draft.fields.clone();
            if let Some(text) = draft
                .texts
                .iter_mut()
                .find(|text| text.editor.contains(point) || text.editor.dragging())
            {
                let index = fields.iter().position(|field| *field == text.field)?;
                text.editor.mouse(*mouse);
                app.layer.focus_path(&format!("{ROWS}/{index}"));
                return Some((true, None));
            }
            if mouse.kind != MouseEventKind::Down(MouseButton::Left) {
                return None;
            }
            // A press on a value, not its label, changes it.
            let index = (0..fields.len()).find(|index| {
                !fields[*index].editable()
                    && app
                        .layer
                        .rect(&format!("{ROWS}/{index}"))
                        .is_some_and(|rect| rect.contains(point) && point.x >= rect.x + width)
            })?;
            app.layer.focus_path(&format!("{ROWS}/{index}"));
            Command::Adjust(index, true)
        }
        _ => return None,
    };
    Some((true, app.apply(action(command))))
}
