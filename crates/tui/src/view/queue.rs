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
    pages::queue::{Command, Kind, Row},
    ui::{Context, Node, On, Role, Size, Tone},
};

pub(super) fn height(app: &App, available: u16) -> u16 {
    (app.queue_rows().len() as u16).min(if available < 12 { 1 } else { 3 })
}
pub(super) fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let rows = app.queue_rows();
    let selected = rows
        .iter()
        .find(|row| Some(&row.target.entry) == app.queue.selected.as_ref());
    if selected.is_none() && app.focus == Focus::Queue {
        // A consumed entry never transfers its mutation target to a neighbor.
        app.focus = Focus::Composer;
        app.queue.selected = None;
        app.queue.surface = Default::default();
    }
    if rows.is_empty() || area.is_empty() {
        app.queue_surface_invalidate();
        return;
    }
    app.queue.area = Some(area);
    let tree = Node::scroll(
        "queue",
        Node::column(
            "entries",
            rows.iter().map(|row| entry(app, row, area.width)).collect(),
        ),
    );
    let context = Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Queue && app.overlay().is_none(),
    };
    app.queue.surface.render(frame, area, tree, context);
}

fn entry(app: &App, row: &Row, width: u16) -> Node<Command> {
    let current = app.queue.selected.as_ref() == Some(&row.target.entry);
    let focused = app.focus == Focus::Queue && current;
    let prefix = row.target.control_key("");
    let hovered = app
        .queue
        .surface
        .hovered()
        .is_some_and(|hover| hover.key.starts_with(&prefix));
    let symbol = match row.kind {
        Kind::Steering => app.chrome.symbol("↗", "s"),
        Kind::InFlight => app.chrome.symbol("…", "~"),
        Kind::Followup => app.chrome.symbol("↳", "q"),
    };
    let text = row
        .content
        .display_text
        .as_deref()
        .unwrap_or(&row.content.text);
    let text = if text.trim().is_empty() {
        app.i18n.text("queue-attachments")
    } else {
        safe(text)
    };
    let mut children = vec![
        Node::text("preview", vec![(format!(" {symbol} {text}"), Tone::Muted)])
            .clip()
            .size(Size::Fill)
            .current(current)
            .on(On::Activate(Command::Select(row.target.clone())))
            .hint(app.i18n.text(row.kind.label())),
    ];
    if focused || hovered {
        if row.kind == Kind::Followup {
            children.push(action(app, "promote", Command::Promote(row.target.clone())));
        }
        if row.kind != Kind::InFlight {
            if width >= 60 {
                children.push(action(
                    app,
                    "up",
                    Command::Reorder(row.target.clone(), false),
                ));
                children.push(action(
                    app,
                    "down",
                    Command::Reorder(row.target.clone(), true),
                ));
            }
            children.push(action(app, "edit", Command::Edit(row.target.clone())));
            children.push(action(app, "retract", Command::Retract(row.target.clone())));
        }
    }
    Node::row(row.target.surface_key(), children).size(Size::Fixed(1))
}

fn action(app: &App, key: &'static str, command: Command) -> Node<Command> {
    let action = Action::Queue(command.clone());
    let role = if matches!(command, Command::Retract(_)) {
        Role::Destructive
    } else {
        Role::Normal
    };
    Node::button(key, icon(app, &action).into(), role)
        .size(Size::Fixed(3))
        .enabled(app.queue_enabled(&command))
        .hint(action_label(app, &action))
        .on(On::Activate(command))
}
