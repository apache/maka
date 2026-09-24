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

use super::{Command, Entity, Kind};
use crate::{
    app::{Action, App},
    ui::{Role, Sheet, Tone},
};
use ratatui::Frame;

/// Every management dialog without a sub-view of its own: confirmations
/// (archive, restore, connection test, model fetch, enable, disable, remove),
/// text fields (rename, workspace, register, relink, configuration) with their
/// review step, and credentials. Confirmations of a change open on Cancel;
/// text dialogs open in their field, where Enter saves.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    use super::connection::Change;
    let dialog = app.management.dialog.as_ref()?;
    if dialog.kind == Kind::Oauth {
        return Some(super::oauth::sheet(app));
    }
    if dialog.credentials.is_some() {
        return Some(super::credentials::sheet(app, dialog));
    }
    if dialog.removal.is_some() {
        return Some(super::removal::sheet(app, dialog));
    }
    if dialog.sandbox.is_some() {
        return Some(super::sandbox::sheet(app, dialog));
    }
    if dialog.chooser.is_some() {
        return Some(super::choose_project::sheet(app, dialog));
    }
    if dialog.models.is_some() {
        return Some(super::models::sheet(app, dialog));
    }
    if dialog.locations.is_some() {
        return Some(super::locations::sheet(app, dialog));
    }
    if dialog.browser.is_some() {
        return Some(super::directory::sheet(app, dialog));
    }
    if dialog.enabled_models.is_some() {
        return Some(super::enabled_models::sheet(app, dialog));
    }
    let busy = app.management.pending.is_some();
    let kind = dialog.kind;
    let label = kind.label(&dialog.target);
    let result = dialog
        .connection_test
        .as_ref()
        .filter(|_| !busy && dialog.error.is_none());
    let step = match (result.is_some(), dialog.reviewing) {
        (true, _) => "result",
        (_, true) => "review",
        _ => "edit",
    };
    let title = match (dialog.reviewing, kind.edits_configuration()) {
        (true, true) => "connection-configuration-confirm",
        (true, false) => "project-relink-confirm",
        _ => label,
    };
    let mut sheet = Sheet::new(
        format!("{label}:{}:{step}", dialog.target.name),
        app.i18n.text(title),
    );
    // What the dialog is about, unless its field already holds it.
    if !matches!(kind, Kind::Rename | Kind::Register) {
        sheet = sheet.text(
            "name",
            &crate::view::safe(&dialog.target.name),
            Tone::Normal,
        );
    }
    if let Some(test) = result {
        let tone = if matches!(
            test,
            maka_protocol::connection_effects::ConnectionTestProjection::Failed { .. }
        ) {
            Tone::Warning
        } else {
            Tone::Accent
        };
        return Some(
            sheet
                .text(
                    "result",
                    &super::connection_test::text(test, &app.i18n),
                    tone,
                )
                .button(
                    "close",
                    app.i18n.text("connection-test-close"),
                    Role::Normal,
                    Action::Manage(Command::Close),
                    true,
                )
                .focus("close"),
        );
    }
    if kind.edits_text() && (!dialog.reviewing || kind.edits_configuration()) {
        let (width, height) = app.frame_size.unwrap_or((80, 24));
        let tall = kind.edits_path() || kind.edits_configuration();
        let most = if tall && height >= 14 { 3 } else { 1 };
        let rows = dialog
            .editor
            .rows(crate::ui::content_width(width))
            .min(most);
        // Busy keeps the field focused but read-only; only a blocked
        // dialog gives its focus away for good.
        sheet = sheet.field(
            "field",
            None,
            rows,
            Action::Manage(if dialog.reviewing {
                Command::Edit
            } else {
                Command::Save
            }),
            !dialog.blocked,
        );
    } else if kind.edits_text() {
        // Under review: exactly what will be written, read-only.
        sheet = sheet.text(
            "value",
            &crate::view::safe(dialog.editor.text()),
            Tone::Normal,
        );
    }
    let note = if busy {
        Some((
            if kind == Kind::Connection(Change::Test) {
                "connection-test-working"
            } else {
                "session-saving"
            },
            Tone::Subtle,
        ))
    } else if let Some(error) = dialog.editor.error.or(dialog.error) {
        Some((error, Tone::Warning))
    } else {
        match kind {
            Kind::Connection(_) if kind.edits_configuration() && !dialog.reviewing => {
                Some("connection-configuration-edit-note")
            }
            Kind::Connection(change) => Some(change.note()),
            Kind::Register => Some("project-register-note"),
            Kind::Relink if dialog.reviewing => Some("project-relink-note"),
            Kind::Relink => Some("project-relink-path-note"),
            Kind::Workspace
                if matches!(
                    dialog.target.entity,
                    Entity::Session {
                        project_bound: true,
                        ..
                    }
                ) =>
            {
                Some("session-workspace-project-note")
            }
            Kind::Workspace => Some("session-workspace-note"),
            Kind::Archive | Kind::Restore
                if matches!(dialog.target.entity, Entity::Project { .. }) =>
            {
                Some("project-archive-note")
            }
            Kind::Archive | Kind::Restore => Some("session-archive-note"),
            // A rename needs no explanation; other kinds have sub-views.
            _ => None,
        }
        .map(|key| (key, Tone::Subtle))
    };
    if let Some((key, tone)) = note {
        sheet = sheet.text("note", &app.i18n.text(key), tone);
    }
    let cancel = |sheet: Sheet<Action>| {
        sheet.button(
            "cancel",
            app.i18n.text("session-cancel"),
            Role::Normal,
            Action::Manage(Command::Close),
            app.enabled(&Action::Manage(Command::Close)),
        )
    };
    let save = |sheet: Sheet<Action>, label: &str| {
        sheet.button(
            "save",
            app.i18n.text(label),
            if app.management.destructive() {
                Role::Destructive
            } else {
                Role::Primary
            },
            Action::Manage(Command::Save),
            app.enabled(&Action::Manage(Command::Save)),
        )
    };
    if dialog.reviewing {
        let (edit, apply) = if kind.edits_configuration() {
            (
                "connection-configuration-edit",
                "connection-configuration-apply",
            )
        } else {
            ("project-relink-edit", "project-relink-apply")
        };
        let mut sheet = cancel(sheet).button(
            "edit",
            app.i18n.text(edit),
            Role::Normal,
            Action::Manage(Command::Edit),
            app.enabled(&Action::Manage(Command::Edit)),
        );
        if app.enabled(&Action::Manage(Command::Edit)) {
            sheet = sheet.back(Action::Manage(Command::Edit));
        }
        // Confirming a bulk change defaults to Cancel.
        return Some(save(sheet, apply).focus("cancel"));
    }
    if kind == Kind::Register {
        sheet = sheet.button(
            "browse",
            app.i18n.text("directory-browse"),
            Role::Normal,
            Action::Manage(Command::Browse),
            app.enabled(&Action::Manage(Command::Browse)),
        );
    }
    let label = match kind {
        _ if kind.edits_configuration() => "connection-configuration-review",
        Kind::Relink => "project-relink-review",
        Kind::Register => "project-register-apply",
        Kind::Workspace => "session-workspace-apply",
        Kind::Rename => "session-save",
        _ => label,
    };
    let sheet = save(cancel(sheet), label);
    Some(if kind.edits_text() {
        sheet
    } else {
        sheet.focus("cancel")
    })
}

/// Paints the sheet's text field, or forgets its geometry when none is shown.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    if app
        .management
        .dialog
        .as_ref()
        .is_some_and(|dialog| dialog.enabled_models.is_some())
    {
        return super::enabled_models::draw(frame, app);
    }
    if app
        .management
        .dialog
        .as_ref()
        .is_some_and(|dialog| dialog.kind == Kind::Oauth)
    {
        return super::oauth::draw(frame, app);
    }
    let editable = app.management.pending.is_none();
    let rect = app.layer.slot("field").filter(|rect| !rect.is_empty());
    let focused = app.layer.focused("field");
    let colors = app.theme.colors();
    let Some(dialog) = app.management.dialog.as_mut() else {
        return;
    };
    let Some(rect) = rect else {
        dialog.editor.invalidate_geometry();
        return;
    };
    let focused = focused && editable && !dialog.blocked;
    dialog.editor.draw(frame, rect, focused, colors);
}
