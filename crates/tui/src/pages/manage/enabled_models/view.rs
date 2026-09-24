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

use super::{Command, Manage};
use crate::{
    app::{Action, App},
    pages::manage::Dialog,
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};

/// Which models a connection offers, or which one to edit settings for.
/// It opens in the search field; the list below toggles with a click,
/// Space or Enter, and a model's settings are a second step.
pub(in crate::pages::manage) fn sheet(app: &App, dialog: &Dialog) -> Sheet<Action> {
    let state = dialog
        .enabled_models
        .as_ref()
        .expect("enabled models state");
    if let Some(draft) = &state.profile {
        return super::profile::sheet(app, dialog, draft);
    }
    let busy = app.management.pending.is_some();
    let enabled = !dialog.blocked && !busy;
    let mut sheet = Sheet::new(
        format!("enabled:{}:{}", dialog.target.name, state.edit_profiles),
        app.i18n.text(if state.edit_profiles {
            "connection-model-overrides"
        } else {
            "connection-enabled-models"
        }),
    )
    .body(Node::row(
        "search",
        vec![
            Node::text(
                "icon",
                vec![(format!("{} ", app.chrome.symbol("⌕", "/")), Tone::Muted)],
            )
            .size(Size::Fixed(2)),
            Node::slot("input", 1)
                .on(On::Activate(Action::Manage(Manage::EnabledModels(
                    Command::Search,
                ))))
                .enabled(enabled)
                .size(Size::Fill),
        ],
    ));
    let filtered = state.filtered();
    if filtered.is_empty() {
        let key = if state.catalog.ready {
            "enabled-model-empty"
        } else {
            "session-model-loading"
        };
        sheet = sheet.text("empty", &app.i18n.text(key), Tone::Subtle);
    } else {
        let rows = filtered
            .iter()
            .map(|index| {
                let model = &state.catalog.rows[*index];
                let name = if model.name == model.id {
                    String::new()
                } else {
                    format!(" · {}", safe(&model.name))
                };
                let label = if state.edit_profiles {
                    format!("{}{name}", safe(&model.id))
                } else {
                    let mark = if state.selected.contains(&model.id) {
                        app.chrome.symbol("✓", "x")
                    } else {
                        " "
                    };
                    format!("[{mark}] {}{name}", safe(&model.id))
                };
                Node::text(model.id.clone(), vec![(label, Tone::Normal)])
                    .clip()
                    .on(On::Activate(Action::Manage(Manage::EnabledModels(
                        Command::Toggle(model.id.clone()),
                    ))))
                    .enabled(enabled && state.catalog.ready)
            })
            .collect();
        let height = app.frame_size.map_or(24, |(_, height)| height);
        sheet = sheet.body(
            Node::scroll("list", Node::column("rows", rows))
                .size(Size::Upto(height.saturating_sub(16).max(3))),
        );
    }
    let clears_default = state
        .catalog
        .basis
        .default_model
        .as_ref()
        .is_some_and(|id| !state.selected.contains(id));
    let error = dialog.error.or(state.catalog.error).or(state.search.error);
    let (note, tone) = if busy {
        (app.i18n.text("session-saving"), Tone::Muted)
    } else if let Some(error) = error {
        (app.i18n.text(error), Tone::Warning)
    } else if !state.catalog.ready {
        (app.i18n.text("session-model-loading"), Tone::Muted)
    } else if state.edit_profiles {
        (app.i18n.text("model-profile-choose"), Tone::Muted)
    } else if clears_default {
        (app.i18n.text("enabled-model-default-note"), Tone::Warning)
    } else {
        (
            app.i18n.format(
                "enabled-model-note",
                &[("count", &state.selected.len().to_string())],
            ),
            Tone::Muted,
        )
    };
    sheet = sheet.text("note", &note, tone);
    if error == Some("session-model-load-failed") {
        let action = Action::Manage(Manage::EnabledModels(Command::Retry));
        let enabled = app.enabled(&action);
        sheet = sheet.aside("retry", app.i18n.text("list-retry"), action, enabled);
    }
    sheet = sheet.button(
        "cancel",
        app.i18n.text("session-cancel"),
        Role::Normal,
        Action::Manage(Manage::Close),
        true,
    );
    if !state.edit_profiles {
        sheet = sheet.button(
            "save",
            app.i18n.text("session-save"),
            Role::Primary,
            Action::Manage(Manage::Save),
            app.enabled(&Action::Manage(Manage::Save)),
        );
    }
    if enabled {
        sheet.focus_node("search/input")
    } else {
        sheet
    }
}
