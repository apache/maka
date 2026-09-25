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

//! The sidebar is the session directory: a new session first, sessions grouped
//! by workspace with live status, Settings pinned last. Host appears only when
//! it needs attention. Drawn and routed by the component kernel.
use crate::{
    app::{Action, App, ConnectionState, Focus},
    navigation::Route,
    ui::{self, Node, On, Role, Sheet, Size, Tone},
    view::activity::Activity,
};
use maka_protocol::session::SessionCatalogProjection;
use maka_runtime::execution::WorkspaceTarget;
use ratatui::{Frame, layout::Rect};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    New,
    Open(String),
    Group(String),
    Filter(bool),
    Close,
    Refresh,
    More,
    /// A plugin page, pinned above Settings.
    App(crate::apps::Key),
    /// Every plugin view, when more pages exist than the sidebar pins.
    Apps,
    Settings,
    Host,
}

#[derive(Default)]
pub struct State {
    pub surface: ui::Surface<Message>,
    pub pending_only: bool,
    pub drawer: bool,
    /// Groups the reader toggled away from their default: workspaces start
    /// open, Archived starts closed.
    toggled: BTreeSet<String>,
}

const SESSION: &str = "sidebar/list/rows/session-";
const ARCHIVED: &str = "archived";

impl State {
    /// The route of the focused row, which checkpoints keep as the sidebar cursor.
    pub(crate) fn focused_route(&self) -> Option<Route> {
        let id = self.surface.focused()?;
        if let Some(session) = id.strip_prefix(SESSION) {
            return Some(Route::Session(session.to_owned()));
        }
        (id == "sidebar/settings").then_some(Route::Settings)
    }
    pub(crate) fn focus_route(&mut self, route: &Route) {
        match route {
            Route::Session(id) => self.surface.focus(format!("{SESSION}{id}")),
            Route::Settings => self.surface.focus("sidebar/settings".into()),
            _ => {}
        }
    }
}

pub fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    // Animation frames advance per draw; take this one before borrowing the tree.
    let working = app
        .sessions
        .items
        .iter()
        .any(|item| app.session_activity(&item.id) == Activity::Working);
    let orbit = working.then(|| {
        app.chrome
            .animation
            .frame(crate::motion::Loop::OrbitSmall, app.chrome.ascii)
    });
    let tree = tree(app, orbit, area.height, false);
    let context = ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Navigation && app.overlay().is_none(),
    };
    app.sidebar.surface.render(frame, area, tree, context);
}

/// Below this height sessions keep every row; plugin pages move into the list.
const PINNED: u16 = 30;

/// A narrow terminal offers the same directory over the current page.
pub fn sheet(app: &App) -> Sheet<Action> {
    let height = app.frame_size.map_or(24, |size| size.1);
    Sheet::new("navigation", app.i18n.text("sidebar-title"))
        .body(tree(app, None, height.saturating_sub(8), true).map(&Action::Sidebar))
        .button(
            "close",
            app.i18n.text("help-close"),
            Role::Normal,
            Action::Sidebar(Message::Close),
            true,
        )
        .focus_node(if app.sidebar.pending_only {
            "sidebar/filter/pending"
        } else {
            "sidebar/filter/all"
        })
        .back(Action::Sidebar(Message::Close))
}

fn tree(app: &App, orbit: Option<&'static str>, height: u16, drawer: bool) -> Node<Message> {
    let i18n = &app.i18n;
    let connected = matches!(app.connection, ConnectionState::Connected { .. });
    let new = labelled("new", "+", i18n.text("sidebar-new-session"), Tone::Accent)
        .on(On::Activate(Message::New))
        .enabled(connected)
        .hint(i18n.text("session-create"));
    let mut rows = vec![];
    let catalog = app.catalog();
    if !connected || (catalog.loading && catalog.items.is_empty()) {
        rows.push(status(i18n.text("sessions-loading")));
    } else if catalog.error.is_some() {
        rows.push(status(i18n.text("sessions-failed")));
        rows.push(
            Node::text("retry", vec![(i18n.text("list-retry"), Tone::Accent)])
                .on(On::Activate(Message::Refresh)),
        );
    } else if catalog.items.is_empty() {
        rows.push(status(i18n.text(if app.sidebar.pending_only {
            "inbox-empty"
        } else {
            "sidebar-empty"
        })));
    }
    let current = match app.navigation.current() {
        Route::Session(id) => Some(id),
        _ => None,
    };
    let archived: Vec<_> = catalog
        .items
        .iter()
        .filter(|item| item.is_archived)
        .collect();
    let archived = (!archived.is_empty()).then(|| Group {
        key: ARCHIVED.into(),
        name: i18n.text("session-archived"),
        hint: i18n.text("session-archived"),
        members: archived,
    });
    for (index, group) in group_items(app, &catalog.items)
        .into_iter()
        .chain(archived)
        .enumerate()
    {
        let open = (group.key != ARCHIVED) != app.sidebar.toggled.contains(&group.key);
        if index > 0 {
            rows.push(Node::text(format!("gap-{}", group.key), vec![]).size(Size::Fixed(1)));
        }
        rows.push(
            Node::row(
                format!("group-{}", group.key),
                vec![
                    Node::text(
                        "disclosure",
                        vec![(format!("{} ", chevron(app, open)), Tone::Subtle)],
                    )
                    .size(Size::Fixed(2)),
                    Node::text("name", vec![(group.name, Tone::Muted)])
                        .clip()
                        .size(Size::Fill),
                    Node::text(
                        "count",
                        vec![(format!(" {}", group.members.len()), Tone::Subtle)],
                    ),
                ],
            )
            .on(On::Activate(Message::Group(group.key.clone())))
            .hint(group.hint),
        );
        if !open {
            continue;
        }
        for item in group.members {
            rows.push(session(
                app,
                item,
                current.as_deref() == Some(&item.id),
                orbit,
            ));
        }
    }
    if catalog.can_more() {
        rows.push(
            Node::text(
                "more",
                vec![(format!("   {}", i18n.text("sidebar-more")), Tone::Subtle)],
            )
            .clip()
            .on(On::Activate(Message::More)),
        );
    }
    // Short terminals keep sessions first and let plugin pages scroll below them.
    if height < PINNED {
        let pages = apps(app);
        if !pages.is_empty() {
            rows.push(Node::text("gap-apps", vec![]).size(Size::Fixed(1)));
            rows.push(
                Node::text(
                    "apps-title",
                    vec![(format!("  {}", i18n.text("sidebar-apps")), Tone::Muted)],
                )
                .clip(),
            );
            rows.extend(pages);
        }
    }
    let pending = format!(
        "{}{}",
        i18n.text("sidebar-pending"),
        if app.inbox.error.is_some() {
            " ?".into()
        } else if !app.inbox.items.is_empty() {
            format!(
                " · {}{}",
                app.inbox.items.len(),
                if app.inbox.has_more() { "+" } else { "" }
            )
        } else {
            String::new()
        }
    );
    let filter = Node::row(
        "filter",
        vec![
            Node::text("all", vec![(i18n.text("sidebar-all"), Tone::Muted)])
                .on(On::Activate(Message::Filter(false)))
                .current(!app.sidebar.pending_only),
            Node::text(
                "pending",
                vec![(
                    pending,
                    if app.inbox_attention() {
                        Tone::Warning
                    } else {
                        Tone::Muted
                    },
                )],
            )
            .on(On::Activate(Message::Filter(true)))
            .current(app.sidebar.pending_only),
        ],
    )
    .gap(2)
    .focus_group();
    let list = Node::scroll("list", Node::column("rows", rows).focus_group());
    let mut children = vec![
        new.size(Size::Fixed(1)),
        filter,
        Node::text("gap", vec![]).size(Size::Fixed(1)),
        if drawer {
            list.size(Size::Upto(height.saturating_sub(6).max(3)))
        } else {
            list
        },
    ];
    if height >= PINNED {
        children.extend(apps(app));
    }
    if let Some(problem) = host_problem(app) {
        children.push(
            labelled("host", app.chrome.symbol("⚠", "!"), problem, Tone::Warning)
                .on(On::Activate(Message::Host))
                .hint(i18n.text("sidebar-host-hint")),
        );
    }
    children.push(
        labelled(
            "settings",
            crate::view::icon(app, &Action::Visit(Route::Settings)),
            i18n.text("route-settings"),
            Tone::Normal,
        )
        .on(On::Activate(Message::Settings))
        .current(app.navigation.current().section() == Route::Settings),
    );
    Node::column("sidebar", children)
}

/// Pages the sidebar pins before offering the directory instead.
const PAGES: usize = 5;

/// Plugin pages pinned with Settings: destinations, not sessions.
fn apps(app: &App) -> Vec<Node<Message>> {
    let pages = app.apps.pages();
    let locale = app.i18n.locale().id();
    let current = app.navigation.current();
    let mut rows = vec![];
    let shown = if pages.len() > PAGES {
        PAGES - 1
    } else {
        PAGES
    };
    for entry in pages.iter().take(shown) {
        let Some(key) = crate::apps::Key::of(entry, None) else {
            continue;
        };
        let icon = match &entry.descriptor.icon {
            Some(icon) if app.chrome.ascii => icon.ascii.clone(),
            Some(icon) => icon.glyph.clone(),
            None => app.chrome.symbol("◇", "*").to_owned(),
        };
        let title = entry.descriptor.title.resolve(locale).to_owned();
        rows.push(
            labelled(
                format!("app-{}", key.node()),
                &icon,
                title.clone(),
                Tone::Normal,
            )
            .on(On::Activate(Message::App(key.clone())))
            .current(current == Route::App(key))
            .hint(title),
        );
    }
    if pages.len() > shown {
        rows.push(
            labelled(
                "apps",
                app.chrome.symbol("⋯", "."),
                app.i18n.text("sidebar-all-apps"),
                Tone::Muted,
            )
            .on(On::Activate(Message::Apps))
            .current(current == Route::Extensions),
        );
    }
    rows
}

/// The icon column leaves a gap even where a terminal draws the glyph
/// double-width, which unicode-width cannot predict for symbols like ⛭ or ⚠.
fn labelled(
    key: impl Into<std::borrow::Cow<'static, str>>,
    icon: &str,
    label: String,
    tone: Tone,
) -> Node<Message> {
    Node::row(
        key,
        vec![
            Node::text("icon", vec![(icon.to_owned(), tone)]).size(Size::Fixed(3)),
            Node::text("label", vec![(label, tone)])
                .clip()
                .size(Size::Fill),
        ],
    )
}

fn status(text: String) -> Node<Message> {
    Node::text("status", vec![(format!("   {text}"), Tone::Subtle)]).clip()
}

fn chevron(app: &App, open: bool) -> &'static str {
    match (open, app.chrome.ascii) {
        (true, false) => "▾",
        (false, false) => "▸",
        (true, true) => "v",
        (false, true) => ">",
    }
}

fn session(
    app: &App,
    item: &SessionCatalogProjection,
    current: bool,
    orbit: Option<&'static str>,
) -> Node<Message> {
    let (glyph, tone) = match app.session_activity(&item.id) {
        Activity::Working => (orbit.unwrap_or(app.chrome.symbol("⢁", "*")), Tone::Accent),
        Activity::Waiting => (app.chrome.symbol("◇", "!"), Tone::Warning),
        _ if item.has_unread => (app.chrome.symbol("●", "*"), Tone::Accent),
        _ => (" ", Tone::Subtle),
    };
    let name = if item.is_archived {
        Tone::Subtle
    } else if item.has_unread {
        Tone::Strong
    } else {
        Tone::Hue(crate::view::tone::session_hue(&item.id))
    };
    // Status sits in the group's disclosure column plus one: names align.
    Node::row(
        format!("session-{}", item.id),
        vec![
            Node::text("status", vec![(format!("  {glyph} "), tone)]).size(Size::Fixed(4)),
            Node::text("name", vec![(item.name.clone(), name)])
                .clip()
                .size(Size::Fill),
        ],
    )
    .on(On::Activate(Message::Open(item.id.clone())))
    .current(current)
    .hint(item.name.clone())
}

pub(crate) struct Group<'a> {
    key: String,
    /// The workspace's short name: a project name or a directory's last component.
    pub name: String,
    hint: String,
    pub members: Vec<&'a SessionCatalogProjection>,
}

/// Unarchived sessions grouped by workspace, in catalog (recency) order of
/// first appearance.
pub(crate) fn groups(app: &App) -> Vec<Group<'_>> {
    group_items(app, &app.sessions.items)
}

fn group_items<'a>(app: &App, items: &'a [SessionCatalogProjection]) -> Vec<Group<'a>> {
    let mut groups: Vec<Group<'_>> = vec![];
    for item in items.iter().filter(|item| !item.is_archived) {
        let (key, name, hint) = match &item.workspace.target {
            WorkspaceTarget::Project { project_id } => {
                let (id, name) = app.projects.resolve(project_id).map_or_else(
                    || (project_id.as_str(), app.i18n.text("sidebar-project")),
                    |(id, name)| (id, name.to_owned()),
                );
                (format!("project:{id}"), name.clone(), name)
            }
            WorkspaceTarget::HostPath { path } => {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
                (format!("path:{path}"), name, path.clone())
            }
        };
        match groups.iter_mut().find(|group| group.key == key) {
            Some(group) => group.members.push(item),
            None => groups.push(Group {
                key,
                name,
                hint,
                members: vec![item],
            }),
        }
    }
    groups
}

fn host_problem(app: &App) -> Option<String> {
    match &app.connection {
        ConnectionState::Failed(_) | ConnectionState::WrongEpoch => {
            Some(app.i18n.text("sidebar-host-failed"))
        }
        ConnectionState::Disconnected => Some(app.i18n.text("sidebar-host-disconnected")),
        ConnectionState::Connecting | ConnectionState::Connected { .. } => None,
    }
}

impl App {
    pub(crate) fn sidebar_action(&mut self, message: Message) -> Option<Action> {
        // Old geometry cannot open a row that has left the active filter.
        if let Message::Open(id) = &message
            && !self.catalog().items.iter().any(|item| item.id == *id)
        {
            return None;
        }
        if matches!(
            message,
            Message::New
                | Message::Open(_)
                | Message::App(_)
                | Message::Apps
                | Message::Settings
                | Message::Host
        ) {
            self.sidebar.drawer = false;
        }
        match message {
            Message::Close => {
                self.sidebar.drawer = false;
                None
            }
            Message::Filter(pending) => {
                self.sidebar.pending_only = pending;
                self.sidebar.surface.invalidate();
                self.layer.retire();
                None
            }
            Message::Refresh => {
                self.catalog_mut().restart();
                None
            }
            Message::New => self.apply(Action::CreateSession),
            Message::Open(id) => self.apply(Action::Visit(Route::Session(id))),
            Message::Group(key) => {
                if !self.sidebar.toggled.remove(&key) {
                    self.sidebar.toggled.insert(key);
                }
                None
            }
            Message::More => {
                self.catalog_mut().more();
                None
            }
            Message::App(key) => self.apply(Action::Apps(crate::apps::Message::Open(key))),
            Message::Apps => self.apply(Action::Apps(crate::apps::Message::Directory)),
            Message::Settings => self.apply(Action::Visit(Route::Settings)),
            Message::Host => self.apply(Action::Host),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    fn screen(app: &mut App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(30, 16)).unwrap();
        terminal
            .draw(|frame| draw(frame, app, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    + "\n"
            })
            .collect()
    }

    #[test]
    fn sessions_group_by_canonical_workspace_and_archived_ones_fold_away() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        let item = |id: &str, project: Option<&str>, archived: bool| {
            let mut item = crate::pages::sessions::tests::item(id);
            if let Some(project) = project {
                item.workspace.target = WorkspaceTarget::Project {
                    project_id: project.into(),
                };
            }
            item.is_archived = archived;
            item
        };
        app.sessions.items = vec![
            item("loose", None, false),
            item("absorbed", Some("old"), false),
            item("launch", Some("p"), false),
            item("shelved", None, true),
        ];
        // A relink absorbed "old" into "p": its sessions join the survivor.
        app.projects.updated(&maka_protocol::project::Project {
            id: "p".into(),
            aliases: vec!["old".into()],
            name: "Launch".into(),
            location_count: 1,
            archived_at: None,
            available: true,
        });
        let groups: Vec<_> = groups(&app)
            .into_iter()
            .map(|group| {
                let members: Vec<_> = group.members.iter().map(|item| item.id.as_str()).collect();
                (group.name, members.join(","))
            })
            .collect();
        assert_eq!(
            groups,
            [
                ("work".to_owned(), "loose".to_owned()),
                ("Launch".to_owned(), "absorbed,launch".to_owned())
            ]
        );
        let folded = screen(&mut app);
        assert!(folded.contains("▸ Archived") && !folded.contains("shelved"));
        app.sidebar_action(Message::Group(ARCHIVED.into()));
        let open = screen(&mut app);
        assert!(open.contains("▾ Archived") && open.contains("shelved"));
    }

    #[test]
    fn narrow_navigation_filters_in_place_and_closes_back_to_the_draft() {
        use crossterm::event::{
            Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
        };
        for locale in crate::Locale::ALL {
            let mut app = App::new(
                "/unused".into(),
                crate::i18n::I18n::new(
                    crate::LocalePreference::Explicit(locale),
                    crate::Locale::En,
                ),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            app.sessions.items = vec![
                crate::pages::sessions::tests::item("A"),
                crate::pages::sessions::tests::item("B"),
            ];
            app.inbox.items = vec![crate::pages::sessions::tests::item("A")];
            app.apply(Action::Visit(Route::Session("draft".into())));
            app.drafts.get_mut("draft").unwrap().insert("Keep this");
            let mut terminal = Terminal::new(TestBackend::new(44, 24)).unwrap();
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('b'),
                KeyModifiers::CONTROL,
            )));
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert!(app.sidebar.drawer);
            assert!(app.layer.rect("sidebar/list/rows/session-B").is_some());
            let filter = app.layer.rect("sidebar/filter/pending").unwrap();
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: filter.x,
                row: filter.y,
                modifiers: KeyModifiers::NONE,
            }));
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert!(app.sidebar.pending_only);
            assert!(app.layer.rect("sidebar/list/rows/session-A").is_some());
            assert!(app.layer.rect("sidebar/list/rows/session-B").is_none());
            assert_eq!(app.navigation.current(), Route::Session("draft".into()));
            app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            assert!(!app.sidebar.drawer);
            assert_eq!(app.focus, Focus::Composer);
            app.input(Event::Paste("?".into()));
            assert_eq!(app.drafts["draft"].text(), "Keep this?");
            assert!(app.i18n.diagnostics().is_empty());
        }
    }
}
