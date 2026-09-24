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

//! The extensions page: a directory of plugin views, then one view at a
//! time under a navigation bar that names where Back goes. Everything is
//! kernel nodes; only text fields are painted here, over their wells.

use super::{Command, Intent, Message, tree};
use crate::{
    app::{App, Focus},
    ui::{self, Node, On, Role, Size, Tone},
    view::form,
};
use maka_plugins::terminal_ui::Context;
use ratatui::{
    Frame,
    layout::{Margin, Rect},
};

/// Views read best up to this width; wider terminals keep the margin.
const READING: u16 = 120;
/// Kernel path of the column a view's root sits in.
const CONTENT: &str = "extensions/body/frame/content";

pub fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    app.extensions.invalidate_geometry();
    let area = area.inner(Margin::new(1, 1));
    if area.width < 12 || area.height < 4 {
        app.extensions.surface.invalidate();
        app.extensions.wells.clear();
        return;
    }
    // The scrollbar keeps the body's last column.
    let width = area.width.saturating_sub(1).min(READING);
    let (tree, wells) = page(app, width);
    let context = ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Page && app.overlay().is_none(),
    };
    app.extensions.surface.render(frame, area, tree, context);
    let focused = context
        .focused
        .then(|| app.extensions.surface.focused().map(str::to_owned))
        .flatten();
    for well in &wells {
        paint(frame, app, well, focused.as_deref() == Some(&well.path));
    }
    app.extensions.wells = wells;
    app.extensions.surface.repaint_popover(frame, &context);
}

/// A text field's label and editor over its well, once the whole well is
/// on screen; a partly scrolled one stays empty rather than half-drawn.
fn paint(frame: &mut Frame<'_>, app: &mut App, well: &tree::Well, focused: bool) {
    let Some(rect) = app.extensions.surface.rect(&well.path) else {
        return;
    };
    let rows = if well.multiline { tree::AREA_ROWS } else { 1 };
    if rect.height < rows {
        return;
    }
    let colors = app.theme.colors();
    let placeholder = (!well.placeholder.is_empty()).then_some(well.placeholder.as_str());
    let Some(editor) = app.extensions.editors.get_mut(&well.field) else {
        return;
    };
    form::draw(
        frame,
        rect,
        well.label_width,
        form::Row {
            label: &well.label,
            focused,
            masked: false,
            placeholder,
        },
        editor,
        colors,
    );
}

fn page(app: &App, width: u16) -> (Node<Command>, Vec<tree::Well>) {
    let state = &app.extensions;
    let mut rows = vec![bar(app, width)];
    rows.extend(notice(app, width));
    let (content, wells) = if state.review.is_some() {
        (super::drafts::nodes(app), vec![])
    } else if let Some(view) = &state.view {
        let offered = |intent: &Intent| state.offered(intent);
        let env = tree::Env {
            drafts: &state.drafts,
            ascii: app.chrome.ascii,
            offered: &offered,
            applied: state.applied.as_deref(),
        };
        let (node, wells) = tree::build(view, &env, CONTENT, width, &Command::View);
        (vec![node], wells)
    } else if state.entry.is_some() {
        let loading = state.busy.then(|| {
            Node::text(
                "loading",
                vec![(app.i18n.text("extensions-loading"), Tone::Subtle)],
            )
        });
        (loading.into_iter().collect(), vec![])
    } else {
        (directory(app), vec![])
    };
    rows.push(Node::scroll(
        "body",
        Node::row(
            "frame",
            vec![Node::column("content", content).size(Size::Fixed(width))],
        ),
    ));
    (Node::column("extensions", rows).gap(1), wells)
}

/// Back, named after where it goes, and the page's standing command.
fn bar(app: &App, width: u16) -> Node<Command> {
    let state = &app.extensions;
    let i18n = &app.i18n;
    let offered = |command: &Command| app.extensions_offered(command);
    let mut items = vec![];
    if state.entry.is_some() && state.review.is_none() {
        let target = state
            .history
            .back()
            .map(|(_, title)| title.clone())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| i18n.text("route-extensions"));
        let chevron = if app.chrome.ascii { "<" } else { "‹" };
        items.push(
            Node::text("back", vec![(format!("{chevron} {target}"), Tone::Accent)])
                .clip()
                .size(Size::Upto(width / 2))
                .on(On::Activate(Command::Back))
                .enabled(offered(&Command::Back))
                .hint(i18n.text(Command::Back.label())),
        );
    }
    items.push(Node::text("spacer", vec![]).size(Size::Fill));
    if state.busy {
        items.push(Node::text(
            "busy",
            vec![(i18n.text("extensions-loading"), Tone::Subtle)],
        ));
    }
    if state.review.is_none() && !state.confirm_discard {
        let (command, label, tone) = if state.dirty() || state.blocked {
            (Command::Discard, "extensions-discard-changes", Tone::Error)
        } else {
            (Command::Refresh, Command::Refresh.label(), Tone::Accent)
        };
        items.push(
            Node::text(label, vec![(i18n.text(label), tone)])
                .on(On::Activate(command.clone()))
                .enabled(offered(&command))
                .hint(i18n.text(command.label())),
        );
    }
    Node::row("bar", items).gap(3)
}

/// What went wrong or needs a decision, with the commands that resolve it.
fn notice(app: &App, width: u16) -> Option<Node<Command>> {
    let state = &app.extensions;
    let i18n = &app.i18n;
    let message = state.message.as_ref().map(|message| match message {
        Message::Local(key) => (
            i18n.text(key),
            if *key == "extensions-draft-ready" {
                Tone::Muted
            } else {
                Tone::Warning
            },
        ),
        Message::Remote(text) => (text.clone(), Tone::Warning),
    });
    let remedies = state.remedies();
    if message.is_none() && remedies.is_empty() {
        return None;
    }
    let mut children: Vec<_> = message
        .into_iter()
        .map(|(text, tone)| Node::text("message", vec![(text, tone)]))
        .collect();
    if !remedies.is_empty() {
        let buttons: Vec<_> = remedies
            .into_iter()
            .enumerate()
            .map(|(index, command)| {
                let role = match command {
                    Command::ConfirmDiscard => Role::Destructive,
                    Command::CancelDiscard | Command::CancelDraft => Role::Normal,
                    _ if index == 0 => Role::Primary,
                    _ => Role::Normal,
                };
                let enabled = app.extensions_offered(&command);
                Node::button(command.label(), i18n.text(command.label()), role)
                    .on(On::Activate(command))
                    .enabled(enabled)
            })
            .collect();
        let needed = buttons
            .iter()
            .map(|button| match button.size {
                Size::Fixed(width) => width + 2,
                _ => 0,
            })
            .sum::<u16>();
        // Side by side when they fit, else one per line at their own width.
        children.push(if needed <= width + 2 {
            Node::row("remedies", buttons).gap(2)
        } else {
            Node::column(
                "remedies",
                buttons
                    .into_iter()
                    .map(|button| Node::row(button.key.clone(), vec![button]))
                    .collect(),
            )
            .gap(1)
        });
    }
    Some(Node::column("notice", children).gap(1))
}

fn directory(app: &App) -> Vec<Node<Command>> {
    let state = &app.extensions;
    let i18n = &app.i18n;
    let locale = i18n.locale().id();
    if state.directory.is_empty() {
        let key = if state.loaded && !state.busy {
            "extensions-empty"
        } else {
            "extensions-loading"
        };
        return vec![Node::text("empty", vec![(i18n.text(key), Tone::Subtle)])];
    }
    let ascii = app.chrome.ascii;
    let mut items: Vec<_> = state
        .directory
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let unavailable =
                entry.descriptor.context == Context::Session && state.session.is_none();
            let icon = match &entry.descriptor.icon {
                Some(icon) if ascii => icon.ascii.as_str(),
                Some(icon) => icon.glyph.as_str(),
                None if ascii => "*",
                None => "◇",
            };
            let detail = if unavailable {
                i18n.text("extensions-needs-session")
            } else {
                entry.package_id.clone()
            };
            let command = Command::Choose(index);
            let enabled = app.extensions_offered(&command);
            Node::row(
                format!("{}:{}", entry.package_id, entry.method).replace('/', ":"),
                vec![
                    Node::text("icon", vec![(icon.to_owned(), Tone::Accent)]).size(Size::Fixed(3)),
                    Node::column(
                        "text",
                        vec![
                            Node::text(
                                "title",
                                vec![(
                                    entry.descriptor.title.resolve(locale).to_owned(),
                                    Tone::Normal,
                                )],
                            )
                            .clip(),
                            Node::text("detail", vec![(detail, Tone::Subtle)]).clip(),
                        ],
                    )
                    .size(Size::Fill),
                    Node::text(
                        "chevron",
                        vec![((if ascii { ">" } else { "›" }).into(), Tone::Subtle)],
                    ),
                ],
            )
            .gap(1)
            .on(On::Activate(command))
            .enabled(enabled)
        })
        .collect();
    if state.next.is_some() {
        items.push(
            Node::text(
                "more",
                vec![(i18n.text(Command::Next.label()), Tone::Accent)],
            )
            .on(On::Activate(Command::Next))
            .enabled(app.extensions_offered(&Command::Next)),
        );
    }
    vec![Node::column("directory", items).gap(1)]
}
