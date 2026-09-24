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

//! Settings, the first page presented through the component kernel. Rows are
//! data (label, current value, and choices or a destination); the kernel draws
//! and routes input, and every change applies through `App` like any action.
use crate::{
    app::{Action, App, Focus},
    i18n::{Locale, LocalePreference},
    navigation::Route,
    theme::Choice,
    ui::{self, Align, Node, On, Size, Tone},
};
use ratatui::{
    Frame,
    layout::{Margin, Rect},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Category {
    #[default]
    Appearance,
    Interface,
    Models,
    Sessions,
    Host,
}
impl Category {
    const ALL: [Self; 5] = [
        Self::Appearance,
        Self::Interface,
        Self::Models,
        Self::Sessions,
        Self::Host,
    ];
    fn key(self) -> &'static str {
        match self {
            Self::Appearance => "appearance",
            Self::Interface => "interface",
            Self::Models => "models",
            Self::Sessions => "sessions",
            Self::Host => "host",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Appearance => "settings-appearance",
            Self::Interface => "settings-interface",
            Self::Models => "settings-models",
            Self::Sessions => "settings-sessions",
            Self::Host => "route-host",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Category(Category),
    Palette(Choice),
    Locale(LocalePreference),
    Ascii(bool),
    Motion(bool),
    CustomTheme,
    Connections,
    SandboxDefaults,
    Host,
    /// A plugin's settings pane.
    Pane(crate::apps::Key),
    App(crate::apps::Message),
}

#[derive(Default)]
pub struct State {
    pub category: Category,
    /// The plugin pane shown instead of a built-in category.
    pub pane: Option<crate::apps::Key>,
    pub surface: ui::Surface<Message>,
    /// Whether the last frame listed every category in one column.
    pub(crate) single: bool,
}

/// Rows whose focus a checkpoint keeps, by the shell action each stands for.
/// Actions are the persisted vocabulary; row ids are only this layout's.
const PERSISTED: [(&str, Category); 5] = [
    ("palette", Category::Appearance),
    ("custom-theme", Category::Appearance),
    ("language", Category::Interface),
    ("symbols", Category::Interface),
    ("motion", Category::Interface),
];
fn persisted_action(key: &str) -> Option<Action> {
    Some(match key {
        "palette" => Action::ToggleTheme,
        "custom-theme" => Action::Theme(crate::theme::editor::Command::Open),
        "language" => Action::CycleLocale,
        "symbols" => Action::ToggleSymbols,
        "motion" => Action::ToggleMotion,
        _ => return None,
    })
}
const ROW_PATH: &str = "settings/pane/frame/rows/";

impl State {
    /// The shell action equivalent to the focused row, for checkpoints.
    pub(crate) fn focused_setting(&self) -> Option<Action> {
        persisted_action(self.surface.focused()?.strip_prefix(ROW_PATH)?)
    }
    pub(crate) fn focus_setting(&mut self, action: &Action) {
        if let Some((key, category)) = PERSISTED
            .iter()
            .find(|(key, _)| persisted_action(key).as_ref() == Some(action))
        {
            self.category = *category;
            self.surface.focus(format!("{ROW_PATH}{key}"));
        }
    }
}

/// Below this width categories become section headers of a single list.
const TWO_PANES: u16 = 56;
const CATEGORIES: u16 = 14;
/// Rows stop growing here, so values stay near their labels on wide screens.
const ROWS: u16 = 64;

pub fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let area = area.inner(Margin::new(1, 0));
    app.settings.single = area.width < TWO_PANES;
    let (tree, wells) = tree(app, area.width);
    let context = ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Page && app.overlay().is_none(),
    };
    app.settings.surface.render(frame, area, tree, context);
    let focused = context
        .focused
        .then(|| app.settings.surface.focused().map(str::to_owned))
        .flatten();
    crate::apps::paint_settings(frame, app, wells, focused.as_deref(), context.colors);
    app.settings.surface.repaint_popover(frame, &context);
}

/// A plugin's settings pane, under the column it shares with built-in rows.
fn pane(app: &App, key: &crate::apps::Key, wells: &mut Vec<crate::apps::Well>) -> Node<Message> {
    let node = key.node();
    let (children, found) = crate::apps::page::pane(app, key, &format!("{}{node}", ROW_PATH), ROWS);
    wells.extend(found);
    Node::column(node, children).gap(1).map(&Message::App)
}

fn tree(app: &App, width: u16) -> (Node<Message>, Vec<crate::apps::Well>) {
    let two_panes = width >= TWO_PANES;
    let panes = app.apps.settings_views();
    let mut wells = vec![];
    let rows: Vec<Node<Message>> = if two_panes {
        match &app.settings.pane {
            Some(key) => vec![pane(app, key, &mut wells)],
            None => section(app, app.settings.category),
        }
    } else {
        let mut rows: Vec<_> = Category::ALL
            .into_iter()
            .flat_map(|category| {
                let title = Node::text(
                    format!("{}-title", category.key()),
                    vec![(app.i18n.text(category.title()), Tone::Strong)],
                );
                std::iter::once(title).chain(section(app, category))
            })
            .collect();
        for (key, title) in &panes {
            rows.push(Node::text(
                format!("{}-title", key.node()),
                vec![(title.clone(), Tone::Strong)],
            ));
            rows.push(pane(app, key, &mut wells));
        }
        rows
    };
    // The frame keeps row identities equal in both layouts, so a resize
    // across the breakpoint preserves keyboard focus.
    let pane = Node::scroll(
        "pane",
        Node::row(
            "frame",
            vec![Node::column("rows", rows).size(Size::Fixed(ROWS)).gap(1)],
        ),
    );
    let mut children = vec![];
    if two_panes {
        let mut categories: Vec<_> = Category::ALL
            .into_iter()
            .map(|category| {
                Node::text(
                    category.key(),
                    vec![(app.i18n.text(category.title()), Tone::Normal)],
                )
                .on(On::Activate(Message::Category(category)))
                .current(app.settings.pane.is_none() && category == app.settings.category)
                .follow_focus()
            })
            .collect();
        // Plugins' categories follow the built-in ones, in their own order.
        categories.extend(panes.iter().map(|(key, title)| {
            Node::text(key.node(), vec![(title.clone(), Tone::Normal)])
                .clip()
                .on(On::Activate(Message::Pane(key.clone())))
                .current(app.settings.pane.as_ref() == Some(key))
                .follow_focus()
        }));
        children.push(
            Node::column("categories", categories)
                .size(Size::Fixed(CATEGORIES))
                .gap(1),
        );
        children.push(Node::rule("divider"));
    }
    children.push(pane);
    (Node::row("settings", children).gap(2), wells)
}

/// What every settings row shows: an icon borrowed from its shell action, a
/// label and the current value.
struct Setting {
    key: &'static str,
    action: Action,
    label: String,
    value: String,
}

fn section(app: &App, category: Category) -> Vec<Node<Message>> {
    let i18n = &app.i18n;
    let ascii = app.chrome.ascii;
    match category {
        Category::Appearance => {
            let mut palettes = vec![
                (
                    i18n.text("settings-palette-dark"),
                    Message::Palette(Choice::Maka),
                ),
                (
                    i18n.text("settings-palette-dusk"),
                    Message::Palette(Choice::Dusk),
                ),
                (
                    i18n.text("settings-palette-paper"),
                    Message::Palette(Choice::Paper),
                ),
                (
                    i18n.text("settings-palette-default"),
                    Message::Palette(Choice::Terminal),
                ),
            ];
            if let Some(name) = app.theme.custom_name() {
                palettes.push((name.to_owned(), Message::Palette(Choice::Custom)));
            }
            let current = Message::Palette(app.theme.choice);
            let value = if app.theme.busy() {
                i18n.text("theme-loading")
            } else {
                palettes
                    .iter()
                    .find(|(_, message)| *message == current)
                    .map_or_else(
                        || i18n.text("settings-palette-custom-fallback"),
                        |(label, _)| label.clone(),
                    )
            };
            let palette = Setting {
                key: "palette",
                action: Action::ToggleTheme,
                label: i18n.text("settings-palette"),
                value,
            };
            let mut rows = vec![
                chooser(app, palette, palettes, current).enabled(!app.theme.busy()),
                link(
                    app,
                    "custom-theme",
                    Action::Theme(crate::theme::editor::Command::Open),
                    Message::CustomTheme,
                ),
            ];
            let mut notes = vec![];
            if let Some(error) = app.theme.error_text(i18n) {
                notes.push((error, Tone::Warning));
            }
            if app.theme.choice == Choice::Custom || app.theme.error.is_some() {
                if let Some(path) = &app.theme.path {
                    notes.push((
                        i18n.format(
                            "theme-path",
                            &[("path", &crate::view::safe(&path.to_string_lossy()))],
                        ),
                        Tone::Subtle,
                    ));
                }
                notes.push((i18n.text("theme-file-hint"), Tone::Subtle));
            }
            rows.extend(note("theme-notes", notes));
            rows
        }
        Category::Interface => {
            let name = |preference| match preference {
                LocalePreference::Auto => i18n.format(
                    "language-auto",
                    &[("language", i18n.system().native_name())],
                ),
                LocalePreference::Explicit(locale) => locale.native_name().to_owned(),
            };
            let languages = std::iter::once(LocalePreference::Auto)
                .chain(Locale::ALL.map(LocalePreference::Explicit))
                .map(|preference| (name(preference), Message::Locale(preference)))
                .collect();
            let symbols = |ascii| {
                i18n.text(if ascii {
                    "settings-symbols-ascii"
                } else {
                    "settings-symbols-unicode"
                })
            };
            let motion = |on| {
                i18n.text(if on {
                    "settings-motion-on"
                } else {
                    "settings-motion-off"
                })
            };
            let mut rows = vec![
                chooser(
                    app,
                    Setting {
                        key: "language",
                        action: Action::CycleLocale,
                        label: i18n.text("settings-language"),
                        value: name(i18n.preference),
                    },
                    languages,
                    Message::Locale(i18n.preference),
                ),
                chooser(
                    app,
                    Setting {
                        key: "symbols",
                        action: Action::ToggleSymbols,
                        label: i18n.text("settings-symbols"),
                        value: symbols(ascii),
                    },
                    vec![
                        (symbols(false), Message::Ascii(false)),
                        (symbols(true), Message::Ascii(true)),
                    ],
                    Message::Ascii(ascii),
                ),
                chooser(
                    app,
                    Setting {
                        key: "motion",
                        action: Action::ToggleMotion,
                        label: i18n.text("settings-motion"),
                        value: motion(app.chrome.motion),
                    },
                    vec![
                        (motion(true), Message::Motion(true)),
                        (motion(false), Message::Motion(false)),
                    ],
                    Message::Motion(app.chrome.motion),
                ),
            ];
            let diagnostics = i18n.diagnostics();
            let mut notes = vec![];
            if !diagnostics.is_empty() {
                notes.push((
                    i18n.format(
                        "localization-errors",
                        &[("count", &diagnostics.len().to_string())],
                    ),
                    Tone::Warning,
                ));
                notes.extend(diagnostics.into_iter().map(|line| (line, Tone::Subtle)));
            }
            rows.extend(note("locale-notes", notes));
            rows
        }
        Category::Models => vec![link(
            app,
            "connections",
            Action::Visit(Route::Connections),
            Message::Connections,
        )],
        Category::Host => {
            let state = match app.connection {
                crate::app::ConnectionState::Connected { .. } => "settings-host-connected",
                crate::app::ConnectionState::Connecting => "settings-host-connecting",
                crate::app::ConnectionState::Disconnected => "settings-host-disconnected",
                crate::app::ConnectionState::Failed(_)
                | crate::app::ConnectionState::WrongEpoch => "settings-host-failed",
            };
            let action = Action::Visit(Route::Host);
            let hint = crate::view::action_label(app, &action);
            vec![
                row(
                    app,
                    Setting {
                        key: "host",
                        action,
                        label: i18n.text("route-host"),
                        value: i18n.text(state),
                    },
                    if ascii { " >" } else { " ›" },
                )
                .on(On::Activate(Message::Host))
                .hint(hint),
            ]
        }
        Category::Sessions => match app.sandbox_defaults_action() {
            Some(action) => vec![link(
                app,
                "sandbox-defaults",
                action,
                Message::SandboxDefaults,
            )],
            // Defaults live on the Host; without one there is nothing to edit.
            None => vec![
                row(
                    app,
                    Setting {
                        key: "sandbox-defaults",
                        action: Action::Refresh,
                        label: i18n.text("sandbox-default-title"),
                        value: String::new(),
                    },
                    "",
                )
                .on(On::Activate(Message::SandboxDefaults))
                .enabled(false),
            ],
        },
    }
}

/// A setting whose value is picked from a kernel-owned chooser.
fn chooser(
    app: &App,
    setting: Setting,
    choices: Vec<(String, Message)>,
    current: Message,
) -> Node<Message> {
    let index = choices.iter().position(|(_, message)| *message == current);
    let hint = app
        .i18n
        .format("settings-choose", &[("setting", &setting.label)]);
    row(app, setting, if app.chrome.ascii { " v" } else { " ▾" })
        .on(On::Choose {
            choices: choices
                .into_iter()
                .map(|(label, action)| ui::Choice { label, action })
                .collect(),
            current: index,
        })
        .hint(hint)
}

/// A setting that opens another page or dialog; it borrows that action's
/// icon, label and hint, so the shell and settings describe it identically.
fn link(app: &App, key: &'static str, action: Action, message: Message) -> Node<Message> {
    let hint = crate::view::action_label(app, &action);
    let setting = Setting {
        key,
        label: hint.clone(),
        action,
        value: String::new(),
    };
    row(app, setting, if app.chrome.ascii { " >" } else { " ›" })
        .on(On::Activate(message))
        .hint(hint)
}

fn row(app: &App, setting: Setting, affordance: &str) -> Node<Message> {
    let icon = crate::view::icon(app, &setting.action);
    Node::row(
        setting.key,
        vec![
            Node::text("icon", vec![(icon.to_owned(), Tone::Subtle)]).size(Size::Fixed(4)),
            Node::text("label", vec![(setting.label, Tone::Normal)]).size(Size::Fill),
            Node::text(
                "value",
                vec![
                    (setting.value, Tone::Muted),
                    (affordance.to_owned(), Tone::Subtle),
                ],
            )
            .align(Align::End),
        ],
    )
}

fn note(key: &'static str, lines: Vec<(String, Tone)>) -> Option<Node<Message>> {
    (!lines.is_empty()).then(|| {
        Node::column(
            key,
            lines
                .into_iter()
                .enumerate()
                .map(|(index, line)| Node::text(format!("line-{index}"), vec![line]))
                .collect(),
        )
    })
}

impl App {
    pub(crate) fn settings_action(&mut self, message: Message) -> Option<Action> {
        match message {
            Message::Category(category) => {
                self.settings.category = category;
                self.settings.pane = None;
            }
            Message::Pane(key) => {
                self.apps.open(&key);
                self.settings.pane = Some(key);
            }
            Message::App(message) => return self.apps_action(message),
            Message::Palette(choice) => self.theme.select(choice),
            Message::Locale(preference) => self.set_locale(preference),
            Message::Ascii(ascii) => self.set_ascii(ascii),
            Message::Motion(motion) => self.set_motion(motion),
            Message::CustomTheme => {
                return self.apply(Action::Theme(crate::theme::editor::Command::Open));
            }
            Message::Connections => return self.apply(Action::Visit(Route::Connections)),
            Message::Host => return self.apply(Action::Visit(Route::Host)),
            Message::SandboxDefaults => {
                return self
                    .sandbox_defaults_action()
                    .and_then(|action| self.apply(action));
            }
        }
        None
    }
    pub(crate) fn set_locale(&mut self, preference: LocalePreference) {
        self.i18n.preference = preference;
        self.chat.invalidate_layout();
        self.apps_relocalize();
        // Text widths change. Do not accept clicks against old geometry.
        self.hits.clear();
        self.hover = None;
        self.settings.surface.invalidate();
    }
    pub(crate) fn set_ascii(&mut self, ascii: bool) {
        self.chrome.ascii = ascii;
        self.chat.invalidate_layout();
    }
    pub(crate) fn set_motion(&mut self, motion: bool) {
        self.chrome.motion = motion;
        self.chrome.stop_animation();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::ConnectionState;
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    use unicode_width::UnicodeWidthStr;

    fn app(locale: Locale) -> App {
        let mut app = App::new(
            "/unused".into(),
            crate::i18n::I18n::new(LocalePreference::Explicit(locale), locale),
        );
        app.apply(Action::Visit(Route::Settings));
        app
    }
    fn render(app: &mut App, width: u16, height: u16) -> Terminal<TestBackend> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, app))
            .unwrap();
        terminal
    }
    fn rows(terminal: &Terminal<TestBackend>) -> Vec<String> {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                let (mut row, mut x) = (String::new(), 0);
                while x < buffer.area.width {
                    let symbol = buffer[(x, y)].symbol();
                    row.push_str(symbol);
                    x += (symbol.width() as u16).max(1);
                }
                row
            })
            .collect()
    }
    fn locate(terminal: &Terminal<TestBackend>, text: &str) -> (u16, u16) {
        rows(terminal)
            .iter()
            .enumerate()
            .find_map(|(y, row)| {
                row.find(text)
                    .map(|byte| (row[..byte].width() as u16, y as u16))
            })
            .unwrap_or_else(|| panic!("{text:?} is not on screen"))
    }
    fn click((column, row): (u16, u16)) -> Event {
        Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn labels_share_a_column_across_locales_icons_and_the_narrow_list() {
        for locale in Locale::ALL {
            for ascii in [false, true] {
                let mut app = app(locale);
                app.chrome.ascii = ascii;
                app.connection = ConnectionState::Connected {
                    root_id: "root".into(),
                    epoch: "epoch".into(),
                };
                // Narrow: every category is a section of one list.
                let terminal = render(&mut app, 50, 40);
                let columns: Vec<u16> = [
                    "settings-palette",
                    "theme-customize",
                    "settings-language",
                    "settings-symbols",
                    "settings-motion",
                    "route-connections",
                    "sandbox-default-title",
                ]
                .iter()
                .map(|key| locate(&terminal, &app.i18n.text(key)).0)
                .collect();
                assert!(
                    columns.iter().all(|x| *x == columns[0]),
                    "{locale:?} ascii={ascii}: {columns:?}"
                );
                assert!(
                    rows(&terminal)
                        .iter()
                        .any(|row| row.contains(&app.i18n.text("settings-sessions")))
                );
            }
        }
    }

    #[test]
    fn two_panes_link_categories_and_a_chooser_never_passes_clicks_through() {
        let mut app = app(Locale::En);
        let terminal = render(&mut app, 100, 30);
        assert!(rows(&terminal).iter().any(|row| row.contains("Maka dark")));
        assert!(
            !rows(&terminal)
                .iter()
                .any(|row| row.contains("Model connections"))
        );
        app.input(click(locate(&terminal, "Models")));
        let terminal = render(&mut app, 100, 30);
        assert_eq!(app.settings.category, Category::Models);
        assert!(
            rows(&terminal)
                .iter()
                .any(|row| row.contains("Model connections"))
        );
        app.input(click(locate(&terminal, "Appearance")));
        let terminal = render(&mut app, 100, 30);
        app.input(click(locate(&terminal, "Maka dark")));
        let terminal = render(&mut app, 100, 30);
        assert!(app.settings.surface.captures());
        // The shell's Back button sits under the chooser's modal layer: the
        // click only dismisses, it never navigates.
        assert_eq!(app.input(click(locate(&terminal, "‹"))).1, None);
        assert_eq!(app.navigation.current(), Route::Settings);
        assert!(!app.settings.surface.captures());
        assert_eq!(app.theme.choice, Choice::Maka, "dismissal chooses nothing");
    }

    #[test]
    fn host_owned_defaults_are_disabled_without_a_connection_and_open_the_original_dialog() {
        let mut app = app(Locale::En);
        app.settings.category = Category::Sessions;
        let terminal = render(&mut app, 100, 30);
        let row = locate(&terminal, "New session sandbox");
        assert_eq!(app.input(click(row)).1, None);
        assert!(
            app.management.dialog.is_none(),
            "disconnected rows do nothing"
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        let terminal = render(&mut app, 100, 30);
        app.input(click(locate(&terminal, "New session sandbox")));
        assert!(
            app.management.dialog.is_some(),
            "the existing dialog owns the edit"
        );
    }
}
