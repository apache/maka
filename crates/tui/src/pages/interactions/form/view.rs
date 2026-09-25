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
use crate::{
    app::Action,
    i18n::I18n,
    ui::{Node, On, Role, Size, Tone},
    view::safe,
};
use maka_protocol::capability::form::FormFormat;

/// The written value's field, a row of the sheet.
pub(in crate::pages::interactions) const VALUE: &str = "entry/value";

impl Form {
    /// What is asked and by whom, the field pager, the current field's
    /// label, description and constraints, then its value: a field to
    /// write, or choices, with Set empty value and Leave unset.
    pub(in crate::pages::interactions) fn nodes(
        &self,
        i18n: &I18n,
        ascii: bool,
        (width, height): (u16, u16),
        enabled: impl Fn(Command) -> bool,
    ) -> Vec<Node<Action>> {
        let action = Action::Interaction;
        let mut about = vec![
            Node::text("message", vec![(safe(&self.message), Tone::Normal)]),
            Node::text(
                "requester",
                vec![(
                    i18n.format(
                        "form-requester",
                        &[
                            ("name", &safe(&self.requester.name)),
                            (
                                "source",
                                &safe(self.requester.source.as_deref().unwrap_or("")),
                            ),
                        ],
                    ),
                    Tone::Subtle,
                )],
            ),
        ];
        let Some(field) = self.fields.get(self.current) else {
            return vec![Node::column("about", about)];
        };
        let page = |key: &'static str, label: &str, command: Option<Command>| {
            let node = Node::button(key, i18n.text(label), Role::Normal);
            match command {
                Some(command) => node
                    .on(On::Activate(action(command)))
                    .enabled(enabled(command)),
                None => node.on(On::Activate(action(Command::Close))).enabled(false),
            }
        };
        about.push(
            Node::row(
                "pager",
                vec![
                    page(
                        "previous",
                        "form-previous",
                        self.current.checked_sub(1).map(Command::Field),
                    ),
                    Node::text(
                        "position",
                        vec![(
                            format!(
                                "{} · {} {}",
                                i18n.format(
                                    "form-position",
                                    &[
                                        ("index", &(self.current + 1).to_string()),
                                        ("count", &self.fields.len().to_string())
                                    ]
                                ),
                                safe(&field.label),
                                i18n.text(if field.required {
                                    "form-required-label"
                                } else {
                                    "form-optional-label"
                                })
                            ),
                            Tone::Normal,
                        )],
                    )
                    .clip()
                    .size(Size::Fill),
                    page(
                        "next",
                        "form-next",
                        (self.current + 1 < self.fields.len())
                            .then_some(Command::Field(self.current + 1)),
                    ),
                ],
            )
            .gap(1),
        );
        if let Some(description) = &field.description {
            about.push(Node::text(
                "description",
                vec![(safe(description), Tone::Subtle)],
            ));
        }
        let constraints = match &field.spec {
            FormFieldSpec::String {
                min_length,
                max_length,
                format,
                ..
            } => {
                let kind = i18n.text(match format {
                    None => "form-string",
                    Some(FormFormat::Email) => "form-email",
                    Some(FormFormat::Uri) => "form-uri",
                    Some(FormFormat::Date) => "form-date",
                    Some(FormFormat::DateTime) => "form-date-time",
                });
                format!(
                    "{kind} · {}",
                    i18n.format(
                        "form-length",
                        &[
                            ("min", &min_length.unwrap_or(0).to_string()),
                            ("max", &max_length.unwrap_or(2048).to_string())
                        ]
                    )
                )
            }
            FormFieldSpec::Number {
                minimum, maximum, ..
            }
            | FormFieldSpec::Integer {
                minimum, maximum, ..
            } => {
                let kind = i18n.text(if matches!(field.spec, FormFieldSpec::Integer { .. }) {
                    "form-integer"
                } else {
                    "form-number"
                });
                format!(
                    "{kind} · {}",
                    i18n.format(
                        "form-range",
                        &[
                            (
                                "min",
                                &minimum
                                    .map(|n| n.to_string())
                                    .unwrap_or_else(|| i18n.text("form-unbounded"))
                            ),
                            (
                                "max",
                                &maximum
                                    .map(|n| n.to_string())
                                    .unwrap_or_else(|| i18n.text("form-unbounded"))
                            )
                        ]
                    )
                )
            }
            FormFieldSpec::Boolean { .. } => i18n.text("form-boolean"),
            FormFieldSpec::SingleSelect { .. } => i18n.text("form-single"),
            FormFieldSpec::MultiSelect {
                min_items,
                max_items,
                options,
                ..
            } => i18n.format(
                "form-items",
                &[
                    ("min", &min_items.unwrap_or(0).to_string()),
                    ("max", &max_items.unwrap_or(options.len()).to_string()),
                ],
            ),
        };
        about.push(Node::text("constraints", vec![(constraints, Tone::Subtle)]));
        let draft = &self.drafts[self.current];
        let mut entry = vec![];
        if self.editable() {
            let rows = draft
                .editor
                .rows(crate::ui::content_width(width))
                .clamp(1, 3);
            entry.push(Node::row(
                "value",
                vec![
                    Node::slot("input", rows)
                        .on(On::Activate(action(Command::FreeText)))
                        .enabled(enabled(Command::FreeText))
                        .size(Size::Fill),
                ],
            ));
        }
        let mut choices = vec![];
        for index in 0..self.options() {
            let (label, chosen) = match &field.spec {
                FormFieldSpec::Boolean { .. } => (
                    i18n.text(if index == 0 {
                        "form-true"
                    } else {
                        "form-false"
                    }),
                    draft.value == Some(FormValue::Boolean(index == 0)),
                ),
                FormFieldSpec::SingleSelect { options, .. } => (
                    safe(&options[index].label),
                    draft.value == Some(FormValue::String(options[index].value.clone())),
                ),
                FormFieldSpec::MultiSelect { options, .. } => (
                    safe(&options[index].label),
                    matches!(&draft.value, Some(FormValue::Strings(values)) if values.contains(&options[index].value)),
                ),
                _ => unreachable!(),
            };
            let multi = matches!(field.spec, FormFieldSpec::MultiSelect { .. });
            let chosen = chosen && draft.present;
            let mark = match (chosen, multi, ascii) {
                (true, true, _) => "[x]",
                (false, true, _) => "[ ]",
                (true, false, true) => "(*)",
                (false, false, true) => "( )",
                (true, false, false) => "●",
                (false, false, false) => "○",
            };
            let command = Command::Option(index);
            choices.push(
                Node::text(
                    format!("option-{index}"),
                    vec![(format!("{mark} {label}"), Tone::Accent)],
                )
                .on(On::Activate(action(command)))
                .enabled(enabled(command))
                .current(chosen),
            );
        }
        for (key, command) in [("empty", Command::Empty), ("omit", Command::Omit)] {
            if self.accepts(command) {
                let chosen = command == Command::Omit && !draft.present;
                choices.push(
                    Node::text(
                        key,
                        vec![(
                            format!(
                                "{} {}",
                                if chosen { "[x]" } else { "[ ]" },
                                i18n.text(command.label())
                            ),
                            Tone::Accent,
                        )],
                    )
                    .on(On::Activate(action(command)))
                    .enabled(enabled(command))
                    .current(chosen),
                );
            }
        }
        if !choices.is_empty() {
            entry.push(
                Node::scroll("choices", Node::column("rows", choices).focus_group())
                    .size(Size::Upto(height.saturating_sub(18).max(3))),
            );
        }
        // Who asks and which field, then the field's value and choices.
        vec![Node::column("about", about), Node::column("entry", entry)]
    }

    /// Paints the written value into its row, with a prompt while empty.
    pub(in crate::pages::interactions) fn draw(
        &mut self,
        frame: &mut ratatui::Frame<'_>,
        rect: Option<ratatui::layout::Rect>,
        focused: bool,
        prompt: &str,
        colors: crate::theme::Palette,
    ) {
        let editable = self.editable();
        let Some(draft) = self.drafts.get_mut(self.current) else {
            return;
        };
        let Some(rect) = rect.filter(|_| editable) else {
            draft.editor.invalidate_geometry();
            return;
        };
        draft.editor.draw(frame, rect, focused, colors);
        if draft.editor.text().is_empty() && !focused {
            frame.render_widget(
                ratatui::widgets::Paragraph::new(prompt)
                    .style(ratatui::style::Style::default().fg(colors.subtle)),
                rect,
            );
        }
    }
}
