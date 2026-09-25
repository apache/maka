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
    let state = &app.projects;
    let message = if !matches!(app.connection, ConnectionState::Connected { .. }) {
        Some("workspace-connect")
    } else if state.error {
        Some("projects-failed")
    } else if state.items.is_empty() {
        Some(if state.loading {
            "projects-loading"
        } else if state.can_next() || state.can_previous() {
            "projects-page-empty"
        } else {
            "projects-empty"
        })
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
            .items
            .iter()
            .map(|item| {
                let mut title = vec![(item.name.clone(), Tone::Normal)];
                let status = if item.archived {
                    Some("session-archived")
                } else if !item.available {
                    Some("project-unavailable")
                } else {
                    None
                };
                if let Some(key) = status {
                    title.push((format!(" · {}", app.i18n.text(key)), Tone::Muted));
                }
                Node::text(item.id.clone(), title)
                    .clip()
                    .on(On::Activate(Action::Project(Command::Select(
                        item.id.clone(),
                    ))))
                    .submit(Action::Project(Command::Create(item.id.clone())))
                    .follow_focus()
                    .current(state.selected.as_ref() == Some(&item.id))
                    .hint(app.i18n.text("project-create-session"))
            })
            .collect()
    };
    let tree = Node::scroll("projects", Node::column("rows", rows).gap(1).focus_group());
    let context = ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::List && app.overlay().is_none(),
    };
    if app.projects.surface.focused().is_none()
        && let Some(id) = &app.projects.selected
    {
        app.projects.surface.focus(format!("projects/rows/{id}"));
    }
    app.projects.surface.render(frame, area, tree, context);
}
