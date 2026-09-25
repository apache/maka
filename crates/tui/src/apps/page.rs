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

//! Views as pages. An app page is one instance under a bar that names
//! where Back goes, a notice when something needs a decision, and the
//! view itself. The directory lists every view the Host publishes and
//! where each appears.

use super::{Command, Intent, Key, Message, instance::Notice, region, tree};
use crate::{
    app::{App, Focus},
    ui::{self, Node, On, Role, Size, Tone},
};
use crossterm::event::{Event, KeyCode, KeyEventKind};
use maka_plugins::terminal_ui::{Context, Placement};
use ratatui::{
    Frame,
    layout::{Margin, Rect},
};

/// Where a page's content starts; a fresh page focuses the first control here.
pub(super) const BODY: &str = "app/body/";
/// Kernel path of the column a view's root sits in.
const CONTENT: &str = "app/body/frame/content";
/// Views read best up to this width; wider terminals keep the margin.
const READING: u16 = 120;

fn context(app: &App) -> ui::Context {
    ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Page && app.overlay().is_none(),
    }
}

pub fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect, key: &Key) {
    app.apps.invalidate_geometry();
    let area = area.inner(Margin::new(1, 1));
    let instance = app.apps.open(key);
    if area.width < 12 || area.height < 4 {
        instance.surface.invalidate();
        instance.wells.clear();
        return;
    }
    // The scrollbar keeps the body's last column.
    let width = area.width.saturating_sub(1).min(READING);
    let (tree, wells) = page(app, key, width);
    let context = context(app);
    let Some(instance) = app.apps.instances.get_mut(key) else {
        return;
    };
    let mut surface = std::mem::take(&mut instance.surface);
    surface.render_motion(frame, area, tree, context, &mut app.chrome.animation);
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
    if let Some(wait) = super::transcript::paint(
        frame,
        &mut app.apps.readers,
        &mut surface,
        context,
        &app.i18n,
        app.chrome.animation.frame_time(),
    ) && app.chrome.window_focused
    {
        app.chrome.animation.wake_after(wait);
    }
    surface.repaint_popover(frame, &context);
    if let Some(instance) = app.apps.instances.get_mut(key) {
        instance.surface = surface;
        instance.wells = wells;
    }
}

fn page(app: &App, key: &Key, width: u16) -> (Node<Message>, Vec<tree::Well>) {
    let Some(instance) = app.apps.instances.get(key) else {
        return (Node::column("app", vec![]), vec![]);
    };
    let message = |command: Command| Message::Instance(key.clone(), command);
    let mut rows = vec![];
    rows.extend(bar(app, key, width));
    rows.extend(notice(app, key, width));
    let (content, wells) = if instance.review.is_some() {
        (super::drafts::nodes(app, key), vec![])
    } else if let Some(view) = &instance.view {
        let offered = |intent: &Intent| instance.offered(intent);
        let slots = |name: &str, wire: &str, path: &str, width: u16| {
            fill(app, key, name, wire, path, width, instance.surface.splits())
        };
        let env = tree::Env {
            readers: &app.apps.readers,
            splits: instance.surface.splits(),
            resources_live: instance.live.is_some() && !instance.blocked,
            i18n: &app.i18n,
            key,
            drafts: &instance.drafts,
            ascii: app.chrome.ascii,
            offered: &offered,
            applied: instance.applied.as_deref(),
            slots: &slots,
        };
        let wrap = |intent| message(Command::View(intent));
        let (node, wells) = tree::build(view, &env, CONTENT, width, &wrap);
        (vec![node], wells)
    } else {
        let text = if instance.entry.is_none() && app.apps.loaded {
            ("extensions-unavailable", Tone::Warning)
        } else if instance.busy || instance.pending.is_some() || instance.entry.is_none() {
            ("extensions-loading", Tone::Subtle)
        } else {
            ("", Tone::Subtle)
        };
        let node = (!text.0.is_empty())
            .then(|| Node::text("status", vec![(app.i18n.text(text.0), text.1)]));
        (node.into_iter().collect(), vec![])
    };
    let frame = Node::row(
        "frame",
        vec![Node::column("content", content).size(Size::Fixed(width))],
    )
    .size(Size::Fill);
    rows.push(
        if instance
            .view
            .as_ref()
            .is_some_and(|view| tree::has_transcript(&view.root))
        {
            Node::column("body", vec![frame]).size(Size::Fill)
        } else {
            Node::scroll("body", frame)
        },
    );
    (Node::column("app", rows).gap(1), wells)
}

/// Back within the view, named after where it goes, and the page's
/// standing command. A view at its first route has no Back of its own:
/// the shell's goes to the previous place.
fn bar(app: &App, key: &Key, width: u16) -> Option<Node<Message>> {
    let instance = app.apps.instances.get(key)?;
    let i18n = &app.i18n;
    let message = |command: Command| Message::Instance(key.clone(), command);
    let offered = |command: Command| app.apps_offered(&message(command));
    let mut items = vec![];
    if app.navigation.can_back() && instance.review.is_none() {
        let chevron = if app.chrome.ascii { "<" } else { "‹" };
        items.push(
            Node::text(
                "back",
                vec![(
                    format!("{chevron} {}", i18n.text("extensions-back")),
                    Tone::Accent,
                )],
            )
            .clip()
            .size(Size::Upto(width / 2))
            .on(On::Activate(message(Command::Back)))
            .enabled(offered(Command::Back))
            .hint(i18n.text(Command::Back.label())),
        );
    }
    items.push(Node::text("spacer", vec![]).size(Size::Fill));
    if instance.busy {
        items.push(Node::text(
            "busy",
            vec![(i18n.text("extensions-loading"), Tone::Subtle)],
        ));
    }
    if instance.review.is_none() && !instance.confirm_discard {
        let (command, label, tone) = if instance.dirty() || instance.blocked {
            (Command::Discard, "extensions-discard-changes", Tone::Error)
        } else {
            (Command::Refresh, Command::Refresh.label(), Tone::Accent)
        };
        let enabled = offered(command.clone());
        items.push(
            Node::text(label, vec![(i18n.text(label), tone)])
                .on(On::Activate(message(command.clone())))
                .enabled(enabled)
                .hint(i18n.text(command.label())),
        );
    }
    Some(Node::row("bar", items).gap(3))
}

/// What went wrong or needs a decision, with the commands that resolve it.
pub(super) fn notice(app: &App, key: &Key, width: u16) -> Option<Node<Message>> {
    let instance = app.apps.instances.get(key)?;
    let i18n = &app.i18n;
    let message = instance.message.as_ref().map(|message| match message {
        Notice::Local(key) => (
            i18n.text(key),
            if *key == "extensions-draft-ready" {
                Tone::Muted
            } else {
                Tone::Warning
            },
        ),
        Notice::Remote(text) => (text.clone(), Tone::Warning),
    });
    let remedies = instance.remedies();
    if message.is_none() && remedies.is_empty() && instance.result.is_none() {
        return None;
    }
    let mut children: Vec<_> = message
        .into_iter()
        .map(|(text, tone)| Node::text("message", vec![(text, tone)]))
        .collect();
    if instance.result.is_some() {
        let message = Message::Result(key.clone());
        children.push(
            Node::button("result", i18n.text("extensions-open-result"), Role::Primary)
                .enabled(app.apps_offered(&message))
                .on(On::Activate(message)),
        );
    }
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
                let message = Message::Instance(key.clone(), command.clone());
                let enabled = app.apps_offered(&message);
                Node::button(command.label(), i18n.text(command.label()), role)
                    .on(On::Activate(message))
                    .enabled(enabled)
            })
            .collect();
        children.push(flow("remedies", buttons, width));
    }
    Some(Node::column("notice", children).gap(1))
}

/// Buttons side by side when they fit, else one per line at their own width.
fn flow(key: &'static str, buttons: Vec<Node<Message>>, width: u16) -> Node<Message> {
    let needed = buttons
        .iter()
        .map(|button| match button.size {
            Size::Fixed(width) => width + 2,
            _ => 0,
        })
        .sum::<u16>();
    if needed <= width + 2 {
        return Node::row(key, buttons).gap(2);
    }
    Node::column(
        key,
        buttons
            .into_iter()
            .map(|button| Node::row(button.key.clone(), vec![button]))
            .collect(),
    )
    .gap(1)
}

impl App {
    /// An app page's fields, then its surface; Esc steps back within the view.
    pub(crate) fn app_page_input(&mut self, key: &Key, event: &Event) -> Option<bool> {
        let keyboard = self.focus == Focus::Page;
        let instance = self.apps.instances.get_mut(key)?;
        let mut surface = std::mem::take(&mut instance.surface);
        let wells = std::mem::take(&mut instance.wells);
        let outcome = region::input(self, &mut surface, &wells, event, keyboard);
        if let Some(instance) = self.apps.instances.get_mut(key) {
            instance.surface = surface;
            instance.wells = wells;
        }
        if outcome.is_none() {
            let instance = self.apps.instances.get(key)?;
            if let Event::Key(press) = event
                && press.kind != KeyEventKind::Release
                && press.code == KeyCode::Esc
                && press.modifiers.is_empty()
                && keyboard
                && !instance.surface.captures()
                && !instance.surface.dragging_split()
            {
                let command = if instance.review.is_some() {
                    Command::CancelDraft
                } else if self.navigation.can_back() {
                    Command::Back
                } else {
                    return None;
                };
                self.apps_action(Message::Instance(key.clone(), command));
                return Some(true);
            }
        }
        let redraw = outcome?;
        if matches!(event, Event::Mouse(mouse) if matches!(mouse.kind, crossterm::event::MouseEventKind::Down(_)))
        {
            self.focus = Focus::Page;
        }
        Some(redraw)
    }
    /// The surface of the page on screen, if it is an app or the directory.
    pub(crate) fn apps_surface(&mut self) -> Option<&mut ui::Surface<Message>> {
        match self.navigation.current() {
            crate::navigation::Route::App(key) => self
                .apps
                .instances
                .get_mut(&key)
                .map(|instance| &mut instance.surface),
            crate::navigation::Route::Extensions => Some(&mut self.apps.surface),
            _ => None,
        }
    }
}

pub fn draw_directory(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let area = area.inner(Margin::new(1, 1));
    if area.width < 12 || area.height < 4 {
        app.apps.surface.invalidate();
        return;
    }
    let width = area.width.saturating_sub(1).min(READING);
    let tree = directory(app, width);
    let context = context(app);
    app.apps
        .surface
        .render_motion(frame, area, tree, context, &mut app.chrome.animation);
    app.apps.surface.repaint_popover(frame, &context);
}

/// Pages first, then this session's pages, then where the other views appear.
fn directory(app: &App, width: u16) -> Node<Message> {
    let apps = &app.apps;
    let i18n = &app.i18n;
    let locale = i18n.locale().id();
    let ascii = app.chrome.ascii;
    let session = app.navigation.recent_session();
    let mut bar = vec![Node::text("spacer", vec![]).size(Size::Fill)];
    if apps.listing() {
        bar.push(Node::text(
            "busy",
            vec![(i18n.text("extensions-loading"), Tone::Subtle)],
        ));
    }
    bar.push(
        Node::text(
            "reload",
            vec![(i18n.text("extensions-refresh"), Tone::Accent)],
        )
        .on(On::Activate(Message::Reload))
        .enabled(app.apps_offered(&Message::Reload)),
    );
    let mut sections = vec![];
    if apps.directory.is_empty() {
        let key = if apps.failed {
            "extensions-failed"
        } else if apps.loaded {
            "extensions-empty"
        } else {
            "extensions-loading"
        };
        sections.push(Node::text("empty", vec![(i18n.text(key), Tone::Subtle)]));
    }
    let row = |entry: &maka_protocol::plugin::TerminalViewProjection, detail: String| {
        let icon = match &entry.descriptor.icon {
            Some(icon) if ascii => icon.ascii.clone(),
            Some(icon) => icon.glyph.clone(),
            None => (if ascii { "*" } else { "◇" }).to_owned(),
        };
        let key = Key::of(entry, session.as_deref());
        let message = key.clone().map(Message::Open);
        let enabled = message
            .as_ref()
            .is_some_and(|message| app.apps_offered(message));
        let mut node = Node::row(
            format!("{}:{}", entry.package_id, entry.method).replace('/', ":"),
            vec![
                Node::text("icon", vec![(icon, Tone::Accent)]).size(Size::Fixed(3)),
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
            ],
        )
        .gap(1);
        if let Some(message) = message {
            node = node.on(On::Activate(message)).enabled(enabled);
        }
        node
    };
    let mut pages = vec![];
    let mut here = vec![];
    let mut elsewhere = vec![];
    for entry in &apps.directory {
        match (&entry.descriptor.placement, entry.descriptor.context) {
            (Placement::Page, Context::Application) => {
                pages.push(row(entry, entry.package_id.clone()))
            }
            (Placement::Page, Context::Session) => here.push(row(
                entry,
                if session.is_some() {
                    entry.package_id.clone()
                } else {
                    i18n.text("extensions-needs-session")
                },
            )),
            (placement, _) => {
                let key = match placement {
                    Placement::Panel => "extensions-placement-panel",
                    Placement::Status => "extensions-placement-status",
                    Placement::Settings => "extensions-placement-settings",
                    Placement::Slot { .. } => "extensions-placement-slot",
                    Placement::Page => unreachable!(),
                };
                let mut node = row(entry, i18n.text(key));
                node.on = None;
                elsewhere.push(node);
            }
        }
    }
    for (key, title, rows) in [
        ("pages", "extensions-section-pages", pages),
        ("session", "extensions-section-session", here),
        ("elsewhere", "extensions-section-elsewhere", elsewhere),
    ] {
        if rows.is_empty() {
            continue;
        }
        sections.push(Node::column(
            key,
            vec![
                Node::text("title", vec![(i18n.text(title), Tone::Muted)]),
                Node::column("rows", rows).gap(1).focus_group(),
            ],
        ));
    }
    let retained: Vec<_> = apps
        .instances
        .iter()
        .filter(|(_, instance)| instance.keeps())
        .enumerate()
        .map(|(index, (key, instance))| {
            let title = instance
                .title(locale)
                .unwrap_or_else(|| key.package.clone());
            let title = if instance.result.is_some() {
                format!("{} · {title}", i18n.text("extensions-open-result"))
            } else {
                title
            };
            let source = format!(
                "{} · {} · {}",
                key.package,
                key.session
                    .as_deref()
                    .unwrap_or(&i18n.text("extensions-scope-application")),
                key.route
            );
            Node::column(
                format!("retained-{index}"),
                vec![
                    Node::text("title", vec![(title, Tone::Normal)]).clip(),
                    Node::text("source", vec![(source, Tone::Subtle)]).clip(),
                ],
            )
            .on(On::Activate(if instance.result.is_some() {
                Message::Result(key.clone())
            } else {
                Message::Recover(key.clone())
            }))
        })
        .collect();
    if !retained.is_empty() {
        sections.push(Node::column(
            "retained",
            vec![
                Node::text(
                    "title",
                    vec![(i18n.text("extensions-section-retained"), Tone::Muted)],
                ),
                Node::column("rows", retained).gap(1).focus_group(),
            ],
        ));
    }
    let content = Node::column("content", sections)
        .gap(2)
        .size(Size::Fixed(width));
    Node::column(
        "apps",
        vec![
            Node::row("bar", bar).gap(3),
            Node::scroll("body", Node::row("frame", vec![content])),
        ],
    )
    .gap(1)
}

impl super::Apps {
    pub(crate) fn listing(&self) -> bool {
        self.listing || self.loading.is_some()
    }
}

/// A view as part of another page: its notice, then the view, its draft
/// review, or why it is not there yet. `path` is the kernel path of the
/// column these children go into.
pub(crate) fn pane(
    app: &App,
    key: &Key,
    path: &str,
    width: u16,
    splits: &ui::Splits,
) -> (Vec<Node<Message>>, Vec<tree::Well>) {
    let Some(instance) = app.apps.instances.get(key) else {
        return (vec![], vec![]);
    };
    let mut children: Vec<_> = notice(app, key, width).into_iter().collect();
    if instance.review.is_some() {
        children.push(Node::column("content", super::drafts::nodes(app, key)));
        return (children, vec![]);
    }
    let Some(view) = &instance.view else {
        let text = if instance.entry.is_none() && app.apps.loaded {
            ("extensions-unavailable", Tone::Warning)
        } else if instance.busy || instance.pending.is_some() || instance.entry.is_none() {
            ("extensions-loading", Tone::Subtle)
        } else {
            return (children, vec![]);
        };
        children.push(Node::text("status", vec![(app.i18n.text(text.0), text.1)]));
        return (children, vec![]);
    };
    let offered = |intent: &Intent| instance.offered(intent);
    let slots = |name: &str, wire: &str, path: &str, width: u16| {
        fill(app, key, name, wire, path, width, splits)
    };
    let env = tree::Env {
        readers: &app.apps.readers,
        splits,
        resources_live: instance.live.is_some() && !instance.blocked,
        i18n: &app.i18n,
        key,
        drafts: &instance.drafts,
        ascii: app.chrome.ascii,
        offered: &offered,
        applied: instance.applied.as_deref(),
        slots: &slots,
    };
    let wrap = |intent| Message::Instance(key.clone(), Command::View(intent));
    let (view, wells) = tree::build(view, &env, &format!("{path}/content"), width, &wrap);
    children.push(Node::column("content", vec![view]));
    (children, wells)
}

/// The views filling one slot of `host`'s view, each behind a quiet edge
/// that says whose it is.
fn fill(
    app: &App,
    host: &Key,
    name: &str,
    wire: &str,
    path: &str,
    width: u16,
    splits: &ui::Splits,
) -> (Vec<Node<Message>>, Vec<tree::Well>) {
    let locale = app.i18n.locale().id();
    let mut nodes = vec![];
    let mut wells = vec![];
    for key in app
        .apps
        .fillers(host, name, wire, app.navigation.location())
    {
        let node = key.node();
        let Some(instance) = app.apps.instances.get(&key) else {
            continue;
        };
        let body = format!("{path}/{node}/body");
        let (mut children, found) = pane(app, &key, &body, width.saturating_sub(2), splits);
        children.insert(
            0,
            Node::text(
                "caption",
                vec![(instance.title(locale).unwrap_or_default(), Tone::Subtle)],
            )
            .clip(),
        );
        wells.extend(found);
        nodes.push(
            Node::row(
                node,
                vec![
                    Node::rule("edge"),
                    Node::column("body", children).gap(1).size(Size::Fill),
                ],
            )
            .gap(1),
        );
    }
    (nodes, wells)
}
