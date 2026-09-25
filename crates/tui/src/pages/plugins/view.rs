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
    app::Focus,
    ui::{Node, On, Role, Size, Tone},
    view::safe,
};
use ratatui::{
    Frame,
    layout::{Margin, Rect},
};

pub(super) fn text(key: impl Into<String>, value: impl Into<String>, tone: Tone) -> Node<Command> {
    Node::text(key.into(), vec![(value.into(), tone)])
}
pub(super) fn button(
    app: &App,
    key: &'static str,
    label: &str,
    command: Command,
    role: Role,
) -> Node<Command> {
    Node::button(key, app.i18n.text(label), role)
        .enabled(app.plugins_enabled(&command))
        .on(On::Activate(command))
}
/// Buttons carry a horizontal fixed width. Put a standalone action in a row so
/// a surrounding column cannot interpret that width as its height.
pub(super) fn button_row(
    app: &App,
    key: &'static str,
    label: &str,
    command: Command,
    role: Role,
) -> Node<Command> {
    Node::row(
        format!("{key}-row"),
        vec![button(app, key, label, command, role)],
    )
}
pub(super) fn review(app: &App, key: &'static str, change: Change) -> Node<Command> {
    button(
        app,
        key,
        change.label(),
        Command::Review(app.plugins.token, change),
        if matches!(change, Change::Remove | Change::Uninstall) {
            Role::Destructive
        } else {
            Role::Normal
        },
    )
}
pub(super) fn link(key: String, title: String, place: Place) -> Node<Command> {
    text(key, title, Tone::Normal)
        .on(On::Activate(Command::Visit(place)))
        .clip()
}
pub(crate) fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let area = area.inner(Margin::new(1, 0));
    app.plugins.rendered = area.width >= 20 && area.height >= 4 && app.overlay().is_none();
    let tree = tree(app, area.width);
    let context = ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Page && app.overlay().is_none(),
    };
    app.plugins.surface.render(frame, area, tree, context);
    forms::draw_fields(frame, app, context);
    app.plugins.surface.repaint_popover(frame, &context);
}
fn tree(app: &App, width: u16) -> Node<Command> {
    let state = &app.plugins;
    let refresh_width =
        unicode_width::UnicodeWidthStr::width(app.i18n.text("extensions-refresh").as_str()) as u16
            + 4;
    let narrow = width < refresh_width + 25;
    let refresh = Node::row(
        "action",
        vec![button(
            app,
            "refresh",
            "extensions-refresh",
            Command::Refresh,
            Role::Normal,
        )],
    )
    .size(if narrow {
        Size::Content
    } else {
        Size::Fixed(refresh_width)
    });
    let working = text(
        "working",
        if state.pending.is_some() || state.queued.is_some() {
            app.i18n.text("plugins-working")
        } else {
            String::new()
        },
        Tone::Subtle,
    )
    .size(Size::Fixed(if narrow { 1 } else { 24 }))
    .clip();
    let status = if narrow {
        Node::column("refresh", vec![refresh, working])
    } else {
        Node::row("refresh", vec![refresh, working]).gap(1)
    };
    let header = Node::column(
        "header",
        vec![
            Node::row(
                "navigation",
                vec![
                    button(
                        app,
                        "overview",
                        "plugins-overview",
                        Command::Visit(Place::Overview),
                        Role::Normal,
                    ),
                    button(
                        app,
                        "details",
                        "plugins-details",
                        Command::Details,
                        Role::Normal,
                    ),
                ],
            )
            .gap(1)
            .focus_group(),
            status,
        ],
    );
    let mut rows = vec![];
    if !state.unknown.is_empty() {
        rows.push(text(
            "unknown",
            app.i18n.text("plugins-unknown"),
            Tone::Warning,
        ));
        if state.details {
            rows.extend(
                state
                    .unknown
                    .iter()
                    .enumerate()
                    .map(|(i, p)| text(format!("unknown-{i}"), p.description(app), Tone::Subtle)),
            );
        }
    }
    if !state.withheld.is_empty() {
        rows.push(text(
            "withheld",
            app.i18n.text("plugins-withheld"),
            Tone::Warning,
        ));
    }
    if let Some(error) = &state.error {
        rows.push(text(
            "error",
            if error.starts_with("plugins-") {
                app.i18n.text(error)
            } else {
                safe(error)
            },
            Tone::Warning,
        ));
    }
    if let Some(receipt) = &state.receipt {
        rows.push(text(
            "receipt",
            app.i18n.text("plugins-saved"),
            Tone::Success,
        ));
        if state.details {
            rows.push(text(
                "receipt-title",
                app.i18n.text("plugins-original-result"),
                Tone::Muted,
            ));
            let original = serde_json::to_string_pretty(receipt).expect("typed receipt");
            rows.extend(original.lines().enumerate().map(|(index, line)| {
                text(format!("receipt-detail-{index}"), safe(line), Tone::Subtle)
            }));
        }
    }
    if let Some(snapshot) = &state.snapshot {
        // These are current failures. The original receipt remains unchanged
        // above, and is never replaced by a later successful observation.
        for (index, entry) in snapshot
            .entries
            .iter()
            .filter(|entry| {
                matches!(entry.status, maka_protocol::plugin::EntryPhase::Failed)
                    || entry.diagnostic.is_some()
            })
            .filter(|entry| match &state.place {
                Place::Overview | Place::Install => true,
                Place::Package(package) | Place::New(package) => {
                    entry.package_id.as_ref() == Some(package)
                }
                _ => false, // Instance/configuration panes already show the same diagnostic.
            })
            .enumerate()
        {
            rows.push(text(
                format!("current-failure-{index}"),
                format!(
                    "{}: {}",
                    safe(&entry.id),
                    entry
                        .diagnostic
                        .as_deref()
                        .map(safe)
                        .unwrap_or_else(|| app.i18n.text("plugins-failed"))
                ),
                Tone::Warning,
            ));
        }
    }
    match state.snapshot.as_ref() {
        None => rows.push(text(
            "unavailable",
            app.i18n.text("plugins-unavailable"),
            Tone::Muted,
        )),
        Some(snapshot) => match &state.place {
            Place::Overview => overview(app, snapshot, &mut rows),
            Place::Package(id) => super::details::package(app, snapshot, id, &mut rows),
            Place::Entry(key) => super::details::instance(app, snapshot, key, &mut rows),
            _ => forms::rows(app, snapshot, &mut rows),
        },
    }
    Node::column(
        "plugins",
        vec![
            header,
            Node::scroll("scroll", Node::column("body", rows).gap(1)).size(Size::Fill),
        ],
    )
    .gap(1)
}
fn overview(app: &App, snapshot: &Snapshot, rows: &mut Vec<Node<Command>>) {
    rows.push(button_row(
        app,
        "install",
        "plugins-install",
        Command::Visit(Place::Install),
        Role::Primary,
    ));
    rows.push(text(
        "packages",
        app.i18n.text("plugins-packages"),
        Tone::Strong,
    ));
    if snapshot.packages.is_empty() {
        rows.push(text(
            "empty",
            app.i18n.text("plugins-no-packages"),
            Tone::Muted,
        ));
    }
    rows.extend(snapshot.packages.iter().enumerate().map(|(i, p)| {
        link(
            format!("package-{i}"),
            safe(&p.display_name),
            Place::Package(p.extension_id.clone()),
        )
    }));
    rows.push(text(
        "instances",
        app.i18n.text("plugins-instances"),
        Tone::Strong,
    ));
    rows.extend(snapshot.entries.iter().enumerate().map(|(i, e)| {
        link(
            format!("entry-{i}"),
            format!(
                "{} · {} · {}",
                safe(&e.id),
                String::from(e.root_id.clone()),
                super::details::phase(app, e.status)
            ),
            Place::Entry(EntryKey::of(e)),
        )
    }));
    if let Some(diagnostic) = &snapshot.status.fence_diagnostic {
        rows.push(text("fence", safe(diagnostic), Tone::Warning));
    }
    if app.plugins.details {
        rows.push(text(
            "status",
            format!(
                "{:?} · {} · {:?}",
                snapshot.status.phase, snapshot.status.authority_epoch, snapshot.status.convergence
            ),
            Tone::Subtle,
        ));
    }
}
