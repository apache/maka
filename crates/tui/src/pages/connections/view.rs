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

use super::Command;
use crate::{
    app::{Action, App, ConnectionState, Focus},
    ui::{self, Node, On, Tone},
};
use ratatui::{
    Frame,
    layout::{Margin, Rect},
};

pub fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let area = area.inner(Margin::new(1, u16::from(area.height >= 18)));
    let state = &app.connections;
    let message = if !matches!(app.connection, ConnectionState::Connected { .. }) {
        Some("workspace-connect")
    } else if state.error {
        Some("connections-failed")
    } else if !state.loaded {
        Some("connections-loading")
    } else if state.rows.is_empty() {
        Some("connections-empty")
    } else {
        None
    };
    let rows = if let Some(key) = message {
        vec![Node::text(
            "status",
            vec![(app.i18n.text(key), Tone::Subtle)],
        )]
    } else {
        state
            .rows
            .iter()
            .map(|row| {
                let selected = state.selected.as_ref() == Some(&row.id);
                let name = format!(
                    "{} {}",
                    if selected {
                        app.chrome.symbol("›", ">")
                    } else {
                        " "
                    },
                    row.name
                );
                let mut title = vec![(name, Tone::Normal)];
                if !row.enabled {
                    title.push((
                        format!(" · {}", app.i18n.text("connection-disabled")),
                        Tone::Muted,
                    ));
                }
                let identity = if row.slug == row.provider.name {
                    row.slug.clone()
                } else {
                    format!("{} · {}", row.slug, row.provider.name)
                };
                let detail = if let Some(model) = &row.default_model {
                    format!(
                        "{}: {} · {}",
                        app.i18n.text("connection-default"),
                        model,
                        identity
                    )
                } else {
                    format!(
                        "{} · {}",
                        app.i18n.format(
                            "connection-models",
                            &[("count", &row.enabled_models.to_string())]
                        ),
                        identity
                    )
                };
                Node::column(
                    row.id.clone(),
                    vec![
                        Node::text("name", title).clip(),
                        Node::text("detail", vec![(detail, Tone::Subtle)]).clip(),
                    ],
                )
                .on(On::Activate(Action::Connection(Command::Select(
                    row.id.clone(),
                ))))
                .submit(Action::Connection(Command::Open(row.id.clone())))
                .follow_focus()
                .current(selected)
                .hint(app.i18n.text("connection-rename"))
            })
            .collect()
    };
    let tree = Node::scroll(
        "connections",
        Node::column("rows", rows).gap(1).focus_group(),
    );
    let context = ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::List && app.overlay().is_none(),
    };
    if app.connections.surface.focused().is_none()
        && let Some(id) = &app.connections.selected
    {
        app.connections
            .surface
            .focus(format!("connections/rows/{id}"));
    }
    app.connections.surface.render(frame, area, tree, context);
}
