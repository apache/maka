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

//! A session's views beside its conversation: panels stacked in the
//! inspector, and quiet status lines above the composer. Both follow the
//! session on screen and open with it.

use super::{Command, Intent, Key, Message, region, tree};
use crate::{
    app::{Action, App, Focus},
    navigation::Route,
    ui::{self, Node, On, Size, Tone},
};
use crossterm::event::{Event, MouseEventKind};
use maka_plugins::terminal_ui::{Context, Placement};
use maka_protocol::plugin::TerminalViewProjection;
use ratatui::{Frame, layout::Rect};

/// Where the inspector's content starts.
const BODY: &str = "inspector/body/panels";
/// The inspector's width, and the least the conversation keeps beside it.
pub(crate) const INSPECTOR: u16 = 40;
const CONVERSATION: u16 = 72;

impl super::Apps {
    /// Session views of one placement, in their declared order.
    pub(crate) fn session_views(&self, placement: &Placement) -> Vec<&TerminalViewProjection> {
        let mut views: Vec<_> = self
            .directory
            .iter()
            .filter(|entry| {
                entry.descriptor.context == Context::Session
                    && &entry.descriptor.placement == placement
            })
            .collect();
        views.sort_by(|left, right| {
            (left.descriptor.order, &left.descriptor.title.fallback)
                .cmp(&(right.descriptor.order, &right.descriptor.title.fallback))
        });
        views
    }
    /// The open instances of a session's views of one placement.
    fn session_keys(&self, session: &str, placement: &Placement) -> Vec<Key> {
        self.session_views(placement)
            .into_iter()
            .filter_map(|entry| Key::of(entry, Some(session)))
            .filter(|key| self.instances.contains_key(key))
            .collect()
    }
}

impl App {
    /// The session on screen, if the page is a session's conversation.
    fn session_on_screen(&self) -> Option<String> {
        match self.navigation.current() {
            Route::Session(id) => Some(id),
            _ => None,
        }
    }
    /// Whether the session on screen wants its inspector: panels exist and
    /// the reader has not put them away.
    pub(crate) fn inspector_wanted(&self) -> bool {
        self.chrome.inspector && !self.chrome.details && self.inspector_available()
    }
    /// Whether the inspector is beside the conversation now; the last frame
    /// decided whether both fit.
    pub(crate) fn inspector_shown(&self) -> bool {
        self.inspector_wanted() && self.apps.inspector_visible
    }
    /// Whether a page this wide holds the conversation and the inspector.
    pub(crate) fn inspector_fits(width: u16) -> bool {
        width >= INSPECTOR + CONVERSATION
    }
    /// Whether toggling the inspector means anything here.
    pub(crate) fn inspector_available(&self) -> bool {
        self.session_on_screen().is_some() && !self.apps.session_views(&Placement::Panel).is_empty()
    }
    /// Opens the views the session on screen shows: its status lines, and
    /// its panels while the inspector is shown.
    pub(super) fn open_session_views(&mut self) {
        let Some(session) = self.session_on_screen() else {
            return;
        };
        let mut placements = vec![Placement::Status];
        if self.inspector_wanted() {
            placements.push(Placement::Panel);
        }
        for placement in placements {
            let keys: Vec<_> = self
                .apps
                .session_views(&placement)
                .into_iter()
                .filter_map(|entry| Key::of(entry, Some(&session)))
                .collect();
            for key in keys {
                self.apps.open(&key);
            }
        }
    }
    /// Rows the status lines take above the composer: one, when any has
    /// something to say.
    pub(crate) fn status_rows(&self, session: &str) -> u16 {
        u16::from(
            self.apps
                .session_keys(session, &Placement::Status)
                .iter()
                .any(|key| self.apps.instances[key].view.is_some()),
        )
    }
}

fn context(app: &App, focused: bool) -> ui::Context {
    ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: focused && app.overlay().is_none(),
    }
}

/// Panels stacked under their titles; each keeps its own route and Back.
pub fn draw_inspector(frame: &mut Frame<'_>, app: &mut App, area: Rect, session: &str) {
    if area.width < 12 || area.height < 3 {
        app.apps.inspector.invalidate();
        app.apps.inspector_wells.clear();
        return;
    }
    let width = area.width.saturating_sub(1);
    let keys = app.apps.session_keys(session, &Placement::Panel);
    let mut panels = vec![];
    let mut wells = vec![];
    for key in &keys {
        let (node, found) = panel(app, key, width);
        panels.push(node);
        wells.extend(found);
    }
    let tree = Node::scroll(
        "body",
        Node::column("panels", panels)
            .gap(2)
            .size(Size::Fixed(width)),
    );
    let tree = Node::column("inspector", vec![tree]);
    let context = context(app, app.focus == Focus::Inspector);
    let mut surface = std::mem::take(&mut app.apps.inspector);
    surface.render(frame, area, tree, context);
    let focused = context
        .focused
        .then(|| surface.focused().map(str::to_owned))
        .flatten();
    region::paint(
        frame,
        &mut app.apps,
        &surface,
        &wells,
        focused.as_deref(),
        context.colors,
    );
    surface.repaint_popover(frame, &context);
    app.apps.inspector = surface;
    app.apps.inspector_wells = wells;
}

fn panel(app: &App, key: &Key, width: u16) -> (Node<Message>, Vec<tree::Well>) {
    let node = key.node();
    let Some(instance) = app.apps.instances.get(key) else {
        return (Node::column(node, vec![]), vec![]);
    };
    let locale = app.i18n.locale().id();
    let message = |command: Command| Message::Instance(key.clone(), command);
    let mut head = vec![];
    if !instance.history.is_empty() {
        let back = message(Command::Back);
        let enabled = app.apps_offered(&back);
        head.push(
            Node::text(
                "back",
                vec![(
                    (if app.chrome.ascii { "<" } else { "‹" }).into(),
                    Tone::Accent,
                )],
            )
            .on(On::Activate(back))
            .enabled(enabled)
            .hint(app.i18n.text(Command::Back.label())),
        );
    }
    head.push(
        Node::text(
            "title",
            vec![(instance.title(locale).unwrap_or_default(), Tone::Muted)],
        )
        .clip()
        .size(Size::Fill),
    );
    if instance.busy {
        head.push(Node::text(
            "busy",
            vec![(
                (if app.chrome.ascii { "..." } else { "…" }).into(),
                Tone::Subtle,
            )],
        ));
    }
    let mut children = vec![Node::row("head", head).gap(1)];
    let (pane, wells) = super::page::pane(app, key, &format!("{BODY}/{node}"), width);
    children.extend(pane);
    (Node::column(node, children).gap(1), wells)
}

/// One quiet line: each status view's icon, which reveals its panel, and
/// its first line.
pub fn draw_status(frame: &mut Frame<'_>, app: &mut App, area: Rect, session: &str) {
    if area.is_empty() {
        app.apps.status.invalidate();
        return;
    }
    let keys: Vec<_> = app
        .apps
        .session_keys(session, &Placement::Status)
        .into_iter()
        .filter(|key| app.apps.instances[key].view.is_some())
        .collect();
    let share = area.width / (keys.len().max(1) as u16);
    let mut items = vec![];
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            items.push(Node::text(
                format!("dot-{index}"),
                vec![("·".into(), Tone::Subtle)],
            ));
        }
        items.push(status(app, key, share.saturating_sub(2)));
    }
    let tree = Node::row("status", items).gap(1);
    let context = context(app, false);
    app.apps.status.render(frame, area, tree, context);
}

fn status(app: &App, key: &Key, width: u16) -> Node<Message> {
    let node = key.node();
    let Some(instance) = app.apps.instances.get(key) else {
        return Node::column(node, vec![]);
    };
    let icon = match instance
        .entry
        .as_ref()
        .and_then(|entry| entry.descriptor.icon.as_ref())
    {
        Some(icon) if app.chrome.ascii => icon.ascii.clone(),
        Some(icon) => icon.glyph.clone(),
        None => (if app.chrome.ascii { "*" } else { "◇" }).to_owned(),
    };
    let reveal = Message::Reveal(key.clone());
    let enabled = app.apps_offered(&reveal);
    let mut children = vec![
        Node::text("icon", vec![(icon, Tone::Accent)])
            .on(On::Activate(reveal))
            .enabled(enabled)
            .hint(instance.title(app.i18n.locale().id()).unwrap_or_default()),
    ];
    if let Some(view) = &instance.view {
        let offered = |intent: &Intent| instance.offered(intent);
        let env = tree::Env {
            key,
            drafts: &instance.drafts,
            ascii: app.chrome.ascii,
            offered: &offered,
            applied: instance.applied.as_deref(),
        };
        let wrap = |intent| Message::Instance(key.clone(), Command::View(intent));
        let parent = format!("status/{node}/line");
        let (view, _) = tree::build(view, &env, &parent, width.saturating_sub(3), &wrap);
        // A status is one line; the rest of a view stays in its panel.
        children.push(Node::column("line", vec![view]).size(Size::Upto(width.saturating_sub(3))));
    }
    Node::row(node, children).gap(1).size(Size::Upto(width))
}

impl App {
    /// The inspector's fields, then its surface, for the pointer over it
    /// or the keyboard while it has focus.
    pub(crate) fn inspector_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        if !self.inspector_shown() {
            return None;
        }
        let keyboard = self.focus == Focus::Inspector;
        let over = matches!(event, Event::Mouse(mouse)
            if self.apps.inspector.rect("inspector").is_some_and(|rect|
                rect.contains((mouse.column, mouse.row).into())));
        if !keyboard && !over && !self.apps.inspector.captures() {
            return None;
        }
        let mut surface = std::mem::take(&mut self.apps.inspector);
        let wells = std::mem::take(&mut self.apps.inspector_wells);
        let owned = region::input(&mut self.apps, &mut surface, &wells, event, keyboard);
        let outcome = owned.is_none().then(|| surface.input(event));
        self.apps.inspector = surface;
        self.apps.inspector_wells = wells;
        if matches!(event, Event::Mouse(mouse) if matches!(mouse.kind, MouseEventKind::Down(_)))
            && (owned.is_some() || outcome.as_ref().is_some_and(|outcome| outcome.consumed))
        {
            self.focus = Focus::Inspector;
        }
        if let Some(redraw) = owned {
            return Some((redraw, None));
        }
        let outcome = outcome?.map(Action::Apps);
        if !outcome.consumed {
            return None;
        }
        let action = outcome.message.and_then(|action| self.apply(action));
        Some((outcome.redraw || action.is_some(), action))
    }
    /// A status icon under the pointer reveals its panel.
    pub(crate) fn status_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        if !matches!(event, Event::Mouse(_)) || self.session_on_screen().is_none() {
            return None;
        }
        let outcome = self.apps.status.input(event).map(Action::Apps);
        if !outcome.consumed {
            return None;
        }
        let action = outcome.message.and_then(|action| self.apply(action));
        Some((outcome.redraw || action.is_some(), action))
    }
    /// Shows the panel that belongs with a status line, or the page when
    /// the package has no panel.
    pub(super) fn reveal(&mut self, key: &Key) -> Option<Action> {
        let session = key.session.as_deref()?;
        let panel = self
            .apps
            .session_views(&Placement::Panel)
            .into_iter()
            .find(|entry| entry.package_id == key.package)
            .and_then(|entry| Key::of(entry, Some(session)));
        if let Some(panel) = panel {
            self.chrome.inspector = true;
            self.focus = Focus::Inspector;
            self.apps.open(&panel);
            self.apps
                .inspector
                .focus_within(format!("{BODY}/{}", panel.node()));
            return None;
        }
        let page = self
            .apps
            .directory
            .iter()
            .find(|entry| {
                entry.package_id == key.package && entry.descriptor.placement == Placement::Page
            })
            .and_then(|entry| Key::of(entry, Some(session)))?;
        self.apps_action(Message::Open(page))
    }
}
