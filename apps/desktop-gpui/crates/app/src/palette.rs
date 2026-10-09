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

//! The command palette: gpui-kit's `Command` in a dialog, listing every
//! command of the window's table that can run now, the choices the pickers
//! offer (model, permission mode, appearance, language, a settings
//! section), and the catalog's tasks, searched by a fuzzy match.
//!
//! The Workbench builds the entries when the palette opens and runs the
//! chosen one after the dialog has closed and returned focus to what had
//! it, so a command that moves focus (Focus composer, a task) keeps it.

use std::rc::Rc;

use gpui_kit::component::command::{Command, CommandGroup, CommandItem, CommandState};
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _, h_flex};
use gpui_kit::{
    Action, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, WeakEntity, Window, div, px, rems,
};
use host_protocol::PermissionMode;
use settings::{Appearance, Language, SettingsSection};
use shared::copy::{Text, commands as words};
use shared::domain_element_id;
use shared::theme::{floating_surface, shortcut_hint};

use crate::Workbench;
use crate::commands::CommandGroup as TableGroup;

/// The palette's width, and its list's greatest height before it scrolls.
const WIDTH_REMS: f32 = 36.;
const LIST_MAX_HEIGHT_REMS: f32 = 24.;
/// The palette's distance from the window's top, as a share of its height.
const TOP_SHARE: f32 = 0.14;

/// What choosing an entry does. The Workbench runs it.
pub(crate) enum PaletteCommand {
    /// A command of the table, through its Action.
    Action(Box<dyn Action>),
    OpenTask(SharedString),
    Settings(SettingsSection),
    Model {
        connection: SharedString,
        model: SharedString,
    },
    PermissionMode(PermissionMode),
    Appearance(Appearance),
    Language(Language),
}

impl Clone for PaletteCommand {
    fn clone(&self) -> Self {
        match self {
            Self::Action(action) => Self::Action(action.boxed_clone()),
            Self::OpenTask(id) => Self::OpenTask(id.clone()),
            Self::Settings(section) => Self::Settings(*section),
            Self::Model { connection, model } => {
                Self::Model { connection: connection.clone(), model: model.clone() }
            }
            Self::PermissionMode(mode) => Self::PermissionMode(mode.clone()),
            Self::Appearance(appearance) => Self::Appearance(*appearance),
            Self::Language(language) => Self::Language(*language),
        }
    }
}

/// A heading of the palette, in the order it lists them when nothing is
/// searched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Section {
    Commands(TableGroup),
    Model,
    PermissionMode,
    Appearance,
    Language,
    Settings,
    Tasks,
}

impl Section {
    fn heading(self) -> Text {
        match self {
            Self::Commands(group) => group.heading(),
            Self::Model => words::GROUP_MODEL,
            Self::PermissionMode => words::GROUP_PERMISSION_MODE,
            Self::Appearance => words::GROUP_APPEARANCE,
            Self::Language => words::GROUP_LANGUAGE,
            Self::Settings => crate::commands::SETTINGS_HEADING,
            Self::Tasks => words::GROUP_OPEN_TASK,
        }
    }
}

/// One line of the palette.
pub(crate) struct PaletteEntry {
    /// Stable across openings: `command:new-task`, `task:<id>`, ….
    pub(crate) key: SharedString,
    pub(crate) section: Section,
    pub(crate) label: SharedString,
    /// More words the search matches: the English label and heading, so
    /// English works in every language.
    pub(crate) keywords: Vec<SharedString>,
    pub(crate) icon: Icon,
    pub(crate) checked: bool,
    /// The Action whose key binding the line shows.
    pub(crate) shortcut: Option<Box<dyn Action>>,
    pub(crate) command: PaletteCommand,
}

impl PaletteEntry {
    pub(crate) fn new(
        key: impl Into<SharedString>,
        section: Section,
        label: impl Into<SharedString>,
        icon: Icon,
        command: PaletteCommand,
    ) -> Self {
        Self {
            key: key.into(),
            section,
            label: label.into(),
            keywords: Vec::new(),
            icon,
            checked: false,
            shortcut: None,
            command,
        }
    }

    pub(crate) fn keywords(mut self, words: impl IntoIterator<Item = SharedString>) -> Self {
        self.keywords.extend(words);
        self
    }

    pub(crate) fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub(crate) fn shortcut(mut self, action: Box<dyn Action>) -> Self {
        self.shortcut = Some(action);
        self
    }

    /// How well `query` matches the entry, or `None` when it does not.
    fn score(&self, query: &str) -> Option<i32> {
        let label = fuzzy_score(query, &self.label);
        let keywords = self
            .keywords
            .iter()
            .filter_map(|keyword| fuzzy_score(query, keyword))
            .max()
            .map(|score| score - 1);
        label.max(keywords)
    }
}

/// The palette's content: owns the query field and highlight
/// ([`CommandState`]) and the entries as of opening.
pub struct CommandPalette {
    state: Entity<CommandState>,
    entries: Rc<Vec<PaletteEntry>>,
    workbench: WeakEntity<Workbench>,
}

impl std::fmt::Debug for CommandPalette {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandPalette").field("entries", &self.entries.len()).finish()
    }
}

impl CommandPalette {
    fn new(
        entries: Vec<PaletteEntry>,
        workbench: WeakEntity<Workbench>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = cx.new(|cx| CommandState::new(window, cx));
        // The highlighted row reads as selected, not hovered, while open.
        shared::theme::command_list_opened(cx);
        cx.on_release(|_, cx| shared::theme::command_list_closed(cx)).detach();
        Self { state, entries: Rc::new(entries), workbench }
    }

    /// The query field and highlight.
    pub fn state(&self) -> &Entity<CommandState> {
        &self.state
    }

    /// The keys of the entries the query matches, grouped as listed.
    pub fn listed(&self, cx: &App) -> Vec<Vec<SharedString>> {
        let query = self.state.read(cx).query(cx);
        filter(&self.entries, &query)
            .into_iter()
            .map(|(_, items)| items.into_iter().map(|ix| self.entries[ix].key.clone()).collect())
            .collect()
    }

    /// Runs the entry at `index` of the listed groups: the dialog closes
    /// first, returning focus, then the Workbench runs it.
    fn confirm(
        &mut self,
        index: gpui_kit::component::IndexPath,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let query = self.state.read(cx).query(cx);
        let groups = filter(&self.entries, &query);
        let Some(&ix) = groups.get(index.section).and_then(|(_, items)| items.get(index.row))
        else {
            return;
        };
        let command = self.entries[ix].command.clone();
        window.close_dialog(cx);
        self.workbench
            .update(cx, |workbench, cx| workbench.run_palette_command(command, window, cx))
            .ok();
    }
}

impl Render for CommandPalette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.state.read(cx).query(cx);
        let palette = cx.entity().downgrade();
        let confirm = palette.clone();
        // The dialog draws the floating recipe; the list inside paints no
        // fill of its own, so it cannot square off the dialog's corners. It
        // sets no corners either: gpui-kit rounds a Command's highlighted row
        // concentric with the corners the Command sets (8px inside 12), and
        // without them the row keeps the theme's 10px.
        let mut command = Command::new(&self.state)
            .filterable(false)
            .bordered(false)
            .bg(gpui_kit::transparent_black())
            .max_h(rems(LIST_MAX_HEIGHT_REMS))
            .placeholder(words::PALETTE_PLACEHOLDER.get(cx))
            .empty(|_, _, cx| {
                div()
                    .py_6()
                    .w_full()
                    .text_center()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(words::PALETTE_EMPTY.get(cx))
            })
            // The query is filtered here, fuzzily; a change re-renders.
            .on_query(move |_, _, cx| {
                palette.update(cx, |_, cx| cx.notify()).ok();
            })
            .on_confirm(move |index, window, cx| {
                confirm.update(cx, |palette, cx| palette.confirm(index, window, cx)).ok();
            });
        for (section, items) in filter(&self.entries, &query) {
            let group = CommandGroup::new()
                .label(section.heading().get(cx))
                .items(items.into_iter().map(|ix| item(&self.entries, ix)));
            command = command.group(group);
        }
        div()
            .id("command-palette")
            .test_support()
            .aria_label(words::PALETTE.get(cx))
            .w_full()
            .child(command)
    }
}

/// The palette row of entry `ix`: its icon, label, and key binding as plain
/// muted text (the menus' and the sidebar's hint, never a keycap). The
/// row is built in place of the default one so that the Workbench, not the
/// palette, dispatches the Action once the dialog has closed.
fn item(entries: &Rc<Vec<PaletteEntry>>, ix: usize) -> CommandItem {
    let entry = &entries[ix];
    let entries = entries.clone();
    CommandItem::new().label(entry.label.clone()).checked(entry.checked).child(move |window, cx| {
        let entry = &entries[ix];
        let shortcut = entry
            .shortcut
            .as_ref()
            .and_then(|action| Kbd::binding_for_action(action.as_ref(), None, window));
        h_flex()
            .id(domain_element_id("palette-entry", &entry.key))
            .test_support()
            .flex_1()
            .min_w_0()
            .gap_2()
            .child(entry.icon.clone().size_4().text_color(cx.theme().muted_foreground))
            .child(div().flex_1().min_w_0().truncate().child(entry.label.clone()))
            .children(shortcut.map(|kbd| shortcut_hint(kbd, cx)))
    })
}

/// The entries `query` matches, by section: in table order when nothing is
/// searched; otherwise each section's entries best first and the sections
/// by their best entry, so Enter runs the best match.
fn filter(entries: &[PaletteEntry], query: &str) -> Vec<(Section, Vec<usize>)> {
    let query = query.trim();
    let mut sections: Vec<(Section, Vec<(usize, i32)>)> = Vec::new();
    for (ix, entry) in entries.iter().enumerate() {
        let score = if query.is_empty() { Some(0) } else { entry.score(query) };
        let Some(score) = score else { continue };
        match sections.iter_mut().find(|(section, _)| *section == entry.section) {
            Some((_, items)) => items.push((ix, score)),
            None => sections.push((entry.section, vec![(ix, score)])),
        }
    }
    if !query.is_empty() {
        for (_, items) in &mut sections {
            items.sort_by_key(|(ix, score)| (std::cmp::Reverse(*score), *ix));
        }
        sections.sort_by_key(|(_, items)| std::cmp::Reverse(items.first().map_or(0, |i| i.1)));
    }
    sections
        .into_iter()
        .map(|(section, items)| (section, items.into_iter().map(|(ix, _)| ix).collect()))
        .collect()
}

/// A fuzzy match of `query` in `text`, ignoring case and the query's
/// spaces: every query character must appear in order. Higher is better:
/// each match scores, more when it continues the previous one, starts a
/// word, or starts the text; each skipped character costs a little. `None`
/// when a character is missing.
pub(crate) fn fuzzy_score(query: &str, text: &str) -> Option<i32> {
    let text: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let mut score = 0;
    let mut position = 0;
    let mut previous: Option<usize> = None;
    for wanted in query.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase) {
        let found = (position..text.len()).find(|&ix| text[ix] == wanted)?;
        score += 10;
        if previous.is_some_and(|previous| previous + 1 == found) {
            score += 15;
        }
        let word_start = found == 0 || !text[found - 1].is_alphanumeric();
        if found == 0 {
            score += 20;
        } else if word_start {
            score += 12;
        }
        score -= (found - position).min(10) as i32;
        previous = Some(found);
        position = found + 1;
    }
    Some(score)
}

/// Opens the palette over `window` with `entries`, its query field
/// focused. Escape clears a query, then closes the palette; focus returns
/// to what had it.
pub(crate) fn open_palette(
    entries: Vec<PaletteEntry>,
    workbench: WeakEntity<Workbench>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<CommandPalette> {
    let palette = cx.new(|cx| CommandPalette::new(entries, workbench, window, cx));
    let content = palette.clone();
    window.open_dialog(cx, move |dialog, window, cx| {
        let viewport = window.viewport_size();
        let width = (window.rem_size() * WIDTH_REMS).min(viewport.width - px(32.));
        floating_surface(dialog, cx)
            .p_0()
            .w(width)
            .margin_top(viewport.height * TOP_SHARE)
            .close_button(false)
            .child(content.clone())
    });
    let state = palette.read(cx).state.clone();
    state.update(cx, |state, cx| state.focus(window, cx));
    palette
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fuzzy_match_needs_every_character_in_order() {
        assert!(fuzzy_score("tgsb", "Toggle sidebar").is_some());
        assert!(fuzzy_score("sidebar", "Toggle sidebar").is_some());
        assert!(fuzzy_score("bs", "Toggle sidebar").is_none(), "out of order");
        assert!(fuzzy_score("xyz", "Toggle sidebar").is_none());
        assert!(fuzzy_score("任务", "新任务").is_some());
        assert_eq!(fuzzy_score("", "anything"), Some(0));
    }

    #[test]
    fn prefixes_and_word_starts_beat_scattered_matches() {
        let score = |query, text| fuzzy_score(query, text).expect("match");
        assert!(score("new", "New task") > score("new", "Renew the key"));
        assert!(score("st", "Stop turn") > score("st", "Toggle sidebar list"));
        assert!(score("dark", "Dark") > score("dark", "Dim background, dark mode"));
    }
}
