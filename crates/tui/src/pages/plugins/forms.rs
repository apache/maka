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
    ui::{Choice, Node, On, Role, Tone},
    view::safe,
};
use ratatui::{Frame, layout::Margin, style::Style, widgets::Block};
use view::{button, button_row, review, text};

pub(super) fn rows(app: &App, snapshot: &Snapshot, rows: &mut Vec<Node<Command>>) {
    let state = &app.plugins;
    if state.place == Place::Install {
        if let Some(error) = state.path.error {
            rows.push(text("field-error", app.i18n.text(error), Tone::Warning));
        }
        rows.push(text(
            "note",
            app.i18n.text("plugins-host-path-note"),
            Tone::Muted,
        ));
        field(app, rows, 0, "plugins-host-path", 3);
        rows.push(button_row(
            app,
            "preview",
            "plugins-preview",
            Command::Preview,
            Role::Primary,
        ));
        if let Some(preview) = &state.preview {
            rows.push(text(
                "preview-name",
                format!(
                    "{} · {}",
                    safe(&preview.package.display_name),
                    safe(&preview.package.extension_id)
                ),
                Tone::Strong,
            ));
            rows.push(text(
                "capabilities",
                super::details::capabilities(app, &preview.package),
                Tone::Subtle,
            ));
            if state.details {
                rows.push(text(
                    "digest",
                    &preview.package.content_digest,
                    Tone::Subtle,
                ));
            }
            rows.push(text(
                "activation",
                app.i18n.text("plugins-install-impact"),
                Tone::Warning,
            ));
            rows.push(Node::row(
                "install-actions",
                vec![review(app, "install", Change::Install)],
            ));
        }
        return;
    }
    let Some(draft) = state.draft() else {
        return;
    };
    if let Some(error) = draft.fields.iter().find_map(|field| field.error) {
        rows.push(text("field-error", app.i18n.text(error), Tone::Warning));
    }
    let change = match &state.place {
        Place::New(package) => {
            rows.push(text("package", safe(package), Tone::Strong));
            field(app, rows, 0, "plugins-instance-id", 3);
            let choices: Vec<_> =
                std::iter::once((app.i18n.text("plugins-profile"), Scope::Profile))
                    .chain(app.sessions.items.iter().map(|s| {
                        (
                            format!("{} · {}", safe(&s.name), s.id),
                            Scope::Session(s.id.clone()),
                        )
                    }))
                    .collect();
            let current = choices.iter().position(|(_, scope)| *scope == draft.scope);
            rows.push(
                text(
                    "scope",
                    format!(
                        "{}: {} {}",
                        app.i18n.text("plugins-scope"),
                        String::from(draft.scope.clone()),
                        app.chrome.symbol("▾", "v")
                    ),
                    Tone::Normal,
                )
                .on(On::Choose {
                    current,
                    choices: choices
                        .into_iter()
                        .map(|(label, scope)| Choice {
                            label,
                            action: Command::Scope(scope),
                        })
                        .collect(),
                }),
            );
            rows.push(text(
                "create-note",
                app.i18n.text("plugins-create-note"),
                Tone::Muted,
            ));
            field(app, rows, 1, "plugins-configure", 8);
            Change::Create
        }
        Place::Configure(key) => {
            rows.push(text("entry", safe(&key.id), Tone::Strong));
            live_state(app, snapshot, key, rows);
            rows.push(text(
                "opaque",
                app.i18n.text("plugins-config-note"),
                Tone::Muted,
            ));
            field(app, rows, 1, "plugins-configure", 12);
            Change::Configure
        }
        Place::Services(key) => {
            rows.push(text("entry", safe(&key.id), Tone::Strong));
            live_state(app, snapshot, key, rows);
            if let Some(entry) = snapshot.entry(key) {
                rows.push(text(
                    "required",
                    format!(
                        "{}: {}",
                        app.i18n.text("plugins-required-services"),
                        entry
                            .required_services
                            .as_ref()
                            .map(|s| safe(&s.join(", ")))
                            .unwrap_or_else(|| app.i18n.text("plugins-requirements-unknown"))
                    ),
                    Tone::Normal,
                ));
                if !entry.waiting_for.is_empty() {
                    rows.push(text(
                        "waiting",
                        format!(
                            "{}: {}",
                            app.i18n.text("plugins-waiting"),
                            safe(&entry.waiting_for.join(", "))
                        ),
                        Tone::Warning,
                    ));
                }
            }
            rows.push(text(
                "routing",
                app.i18n.text("plugins-services-note"),
                Tone::Muted,
            ));
            field(app, rows, 2, "plugins-services-json", 12);
            Change::Services
        }
        _ => return,
    };
    if draft.base != snapshot.status.authority_epoch {
        rows.push(text(
            "conflict",
            app.i18n.text("plugins-conflict"),
            Tone::Warning,
        ));
        rows.push(button_row(
            app,
            "rebase",
            "plugins-review-current",
            Command::Rebase(state.token),
            Role::Caution,
        ));
    }
    rows.push(text(
        "memory",
        app.i18n.text("plugins-memory-note"),
        Tone::Subtle,
    ));
    rows.push(
        Node::row(
            "save-actions",
            vec![
                review(app, "save", change),
                button(
                    app,
                    "discard",
                    "plugins-discard",
                    Command::Discard,
                    Role::Normal,
                ),
            ],
        )
        .gap(1),
    );
}
fn live_state(app: &App, snapshot: &Snapshot, key: &EntryKey, rows: &mut Vec<Node<Command>>) {
    if let Some(entry) = snapshot.entry(key) {
        rows.push(text(
            "effective",
            format!(
                "{}: {}",
                app.i18n.text("plugins-effective"),
                super::details::phase(app, entry.status)
            ),
            if matches!(entry.status, maka_protocol::plugin::EntryPhase::Failed) {
                Tone::Warning
            } else {
                Tone::Muted
            },
        ));
        if let Some(diagnostic) = &entry.diagnostic {
            rows.push(text("diagnostic", safe(diagnostic), Tone::Warning));
        }
    }
}
fn field(app: &App, rows: &mut Vec<Node<Command>>, index: usize, label: &str, height: u16) {
    rows.push(text(
        format!("label-{index}"),
        app.i18n.text(label),
        Tone::Muted,
    ));
    rows.push(
        Node::slot(format!("field-{index}"), height)
            .on(On::Activate(Command::Field(index)))
            .enabled(app.plugins_enabled(&Command::Field(index))),
    );
}
pub(super) fn draw_fields(frame: &mut Frame<'_>, app: &mut App, context: ui::Context) {
    let indices: &[usize] = match app.plugins.place {
        Place::Install => &[0],
        Place::New(_) => &[0, 1],
        Place::Configure(_) => &[1],
        Place::Services(_) => &[2],
        _ => return,
    };
    let focused = app.plugins.surface.focused().map(str::to_owned);
    let editable = app.plugins_enabled(&Command::Field(0));
    for index in indices {
        let path = format!("plugins/scroll/body/field-{index}");
        let rect = app.plugins.surface.rect(&path);
        let Some(editor) = app.plugins.field_mut(*index) else {
            continue;
        };
        let Some(rect) = rect.filter(|rect| rect.width >= 3 && rect.height >= 3) else {
            editor.invalidate_geometry();
            continue;
        };
        let focused = context.focused && editable && focused.as_deref() == Some(path.as_str());
        frame.render_widget(
            Block::bordered().border_style(Style::default().fg(if focused {
                context.colors.accent
            } else {
                context.colors.subtle
            })),
            rect,
        );
        editor.draw(
            frame,
            rect.inner(Margin::new(1, 1)),
            focused,
            context.colors,
        );
    }
}
