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
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};

pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let confirmation = app.plugins.confirmation.as_ref()?;
    let token = confirmation.token();
    let (title, note, summary, technical, confirm) = match confirmation {
        Confirmation::Exit { token, .. } => (
            app.i18n.text("plugins-leave"),
            "plugins-exit-note",
            String::new(),
            None,
            Command::ConfirmExit(*token),
        ),
        Confirmation::Write(request) => {
            let (change, _, _) = request.intent()?;
            let note = match change {
                Change::Install => "plugins-install-impact",
                Change::Uninstall => "plugins-uninstall-impact",
                Change::Restart => "plugins-restart-impact",
                Change::Enable | Change::Disable => "plugins-toggle-impact",
                Change::Remove => "plugins-remove-impact",
                Change::Create => "plugins-create-impact",
                _ => "plugins-save-impact",
            };
            (
                app.i18n.text(change.label()),
                note,
                summary::write(app, request)?,
                summary::technical(app, request),
                Command::Confirm(request.token),
            )
        }
        Confirmation::Rebase {
            token,
            current,
            base,
            mine,
            dirty,
            scope,
            ..
        } => {
            let technical = format!(
                "{}: {}\n\n{}",
                app.i18n.text("plugins-base"),
                base,
                serde_json::to_string_pretty(current).ok()?
            );
            (
                app.i18n.text("plugins-review-current"),
                "plugins-rebase-note",
                summary::rebase(app, current.as_deref(), mine, dirty, scope),
                Some(technical),
                Command::ConfirmRebase(*token),
            )
        }
    };
    let mut lines: Vec<_> = summary
        .lines()
        .enumerate()
        .map(|(index, line)| {
            Node::text(format!("summary-{index}"), vec![(safe(line), Tone::Normal)])
        })
        .collect();
    if app.plugins.confirmation_details
        && let Some(technical) = &technical
    {
        lines.push(Node::text(
            "technical-title",
            vec![(app.i18n.text("plugins-technical-details"), Tone::Strong)],
        ));
        lines.extend(technical.lines().enumerate().map(|(index, line)| {
            Node::text(
                format!("technical-{index}"),
                vec![(safe(line), Tone::Subtle)],
            )
        }));
    }
    let mut sheet = Sheet::new(format!("plugin-confirm:{token}"), title).text(
        "impact",
        &app.i18n.text(note),
        Tone::Warning,
    );
    if !app.plugins.unknown.is_empty() {
        sheet = sheet.text(
            "unknown",
            &app.i18n.text("plugins-new-review"),
            Tone::Warning,
        );
    }
    if !lines.is_empty() {
        let height = app
            .frame_size
            .map_or(24, |(_, height)| height)
            .saturating_sub(14)
            .max(3);
        sheet = sheet.body(
            Node::scroll("review", Node::column("lines", lines))
                .on(On::Scroll)
                .size(Size::Upto(height)),
        );
    }
    if technical.is_some() {
        let command = Command::ConfirmationDetails(token);
        let glyph = if app.plugins.confirmation_details {
            app.chrome.symbol("▾", "v")
        } else {
            app.chrome.symbol("▸", ">")
        };
        sheet = sheet.body(
            Node::text(
                "details",
                vec![(
                    format!("{glyph} {}", app.i18n.text("plugins-technical-details")),
                    Tone::Subtle,
                )],
            )
            .on(On::Activate(Action::Plugins(command.clone())))
            .enabled(app.plugins_enabled(&command)),
        );
    }
    Some(
        sheet
            .button(
                "cancel",
                app.i18n.text("session-cancel"),
                Role::Normal,
                Action::Plugins(Command::Cancel),
                true,
            )
            .button(
                "confirm",
                app.i18n.text("plugins-confirm"),
                Role::Primary,
                Action::Plugins(confirm.clone()),
                app.plugins_enabled(&confirm),
            )
            .focus("cancel"),
    )
}
