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

mod view;
pub use view::draw;

use crate::app::{Action, App, ConnectionState, Focus};
use crate::navigation::Route;
use maka_protocol::project::{PageItem, Query, QueryResult, View};
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Select(String),
    Create(String),
    Refresh,
    Next,
    Previous,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Select(_) => "project-select",
            Self::Create(_) => "project-create-session",
            Self::Refresh => "command-refresh",
            Self::Next => "sessions-next",
            Self::Previous => "sessions-previous",
        }
    }
}

pub struct Item {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub available: bool,
}
impl Item {
    pub(super) fn usable(&self) -> bool {
        self.available && !self.archived
    }
}

#[derive(Default)]
pub struct Projects {
    pub surface: crate::ui::Surface<Action>,
    pub items: Vec<Item>,
    pub selected: Option<String>,
    pub loading: bool,
    pub error: bool,
    pub loaded: bool,
    requested: bool,
    superseded: bool,
    revision: Option<String>,
    cursor: Option<String>,
    next: Option<String>,
    previous: VecDeque<Option<String>>,
    /// Canonical id and display name by project id or alias, kept across
    /// pages so session groups elsewhere stay labelled whichever page this
    /// list shows, and an absorbed project reads as the one that absorbed it.
    known: BTreeMap<String, (String, String)>,
}
impl Projects {
    pub fn resolve(&self, id: &str) -> Option<(&str, &str)> {
        self.known
            .get(id)
            .map(|(id, name)| (id.as_str(), name.as_str()))
    }
    pub(super) fn ready(&self) -> bool {
        self.loaded && !self.loading && !self.requested && !self.error
    }
    pub(super) fn change_page(&mut self, forward: bool) {
        if forward {
            if let Some(next) = self.next.clone() {
                if self.previous.len() == 128 {
                    self.previous.pop_front();
                }
                self.previous.push_back(self.cursor.clone());
                self.cursor = Some(next);
                self.refresh();
            }
        } else if let Some(previous) = self.previous.pop_back() {
            self.cursor = previous;
            self.refresh();
        }
    }
    pub fn refresh(&mut self) {
        self.requested = true;
    }
    pub fn can_next(&self) -> bool {
        !self.loading && self.next.is_some()
    }
    pub fn can_previous(&self) -> bool {
        !self.loading && !self.previous.is_empty()
    }
    pub fn query(&mut self) -> Option<Query> {
        if self.loading || !self.requested {
            return None;
        }
        self.requested = false;
        self.loading = true;
        self.error = false;
        Some(match (&self.revision, &self.cursor) {
            (Some(revision), Some(cursor)) => Query::ListContinue {
                view: View::Summary,
                revision: revision.clone(),
                cursor: cursor.clone(),
            },
            _ => Query::ListStart {
                view: View::Summary,
            },
        })
    }
    pub fn complete(&mut self, result: Result<QueryResult, String>) {
        self.loading = false;
        if std::mem::take(&mut self.superseded) {
            self.refresh(); // A pre-mutation read cannot overwrite the acknowledged projection.
            return;
        }
        match result {
            Ok(QueryResult::Page {
                revision,
                items,
                next_cursor,
                ..
            }) => {
                self.learn(&items);
                self.items = items
                    .into_iter()
                    .filter_map(|item| match item {
                        PageItem::Project {
                            id,
                            name,
                            archived_at,
                            available,
                            ..
                        } => Some(Item {
                            id,
                            name,
                            archived: archived_at.is_some(),
                            available,
                        }),
                        _ => None, // Summary wire pages also carry aliases, never selectable identities.
                    })
                    .collect();
                if !self.loaded {
                    self.selected = self.items.first().map(|item| item.id.clone());
                } else if !self
                    .items
                    .iter()
                    .any(|item| Some(&item.id) == self.selected.as_ref())
                {
                    self.selected = None; // Never silently rebind an action to a neighbour.
                }
                self.loaded = true;
                self.revision = Some(revision);
                self.next = next_cursor;
            }
            Ok(QueryResult::RevisionChanged { .. }) => self.restart(),
            Err(_) => self.error = true,
            _ => unreachable!("client enforces project list reply"),
        }
    }
    fn learn(&mut self, items: &[PageItem]) {
        let mut projects = BTreeMap::new();
        for item in items {
            match item {
                PageItem::Project {
                    project_index,
                    id,
                    name,
                    ..
                } => {
                    let known = (id.clone(), name.clone());
                    projects.insert(*project_index, known.clone());
                    self.known.insert(id.clone(), known);
                }
                PageItem::Alias {
                    project_index,
                    alias,
                    ..
                } => {
                    if let Some(known) = projects.get(project_index) {
                        self.known.insert(alias.clone(), known.clone());
                    }
                }
                PageItem::Location { .. } => {}
            }
        }
    }
    pub(super) fn restart(&mut self) {
        self.cursor = None;
        self.previous.clear();
        self.refresh();
    }
    pub fn updated(&mut self, project: &maka_protocol::project::Project) {
        if self
            .selected
            .as_ref()
            .is_some_and(|id| *id == project.id || project.aliases.contains(id))
        {
            self.selected = Some(project.id.clone());
        }
        // A relink can absorb another visible project. Retain one canonical
        // row immediately, rather than leaving the absorbed identity actionable.
        let index = self
            .items
            .iter()
            .position(|item| item.id == project.id)
            .or_else(|| {
                self.items
                    .iter()
                    .position(|item| project.aliases.contains(&item.id))
            });
        if let Some(index) = index {
            self.items[index] = Item {
                id: project.id.clone(),
                name: project.name.clone(),
                archived: project.archived_at.is_some(),
                available: project.available,
            };
        }
        self.items
            .retain(|item| item.id == project.id || !project.aliases.contains(&item.id));
        for id in std::iter::once(&project.id).chain(&project.aliases) {
            self.known
                .insert(id.clone(), (project.id.clone(), project.name.clone()));
        }
        self.superseded |= self.loading;
        self.refresh();
    }
}

impl App {
    pub fn project_actions(&self) -> Vec<Action> {
        let mut actions = self
            .register_project_action()
            .into_iter()
            .collect::<Vec<_>>();
        if let Some(id) = &self.projects.selected {
            actions.push(Action::Project(Command::Create(id.clone())));
            if let Some((action, _)) = self.management_commands().into_iter().find(|(action, _)| {
                matches!(
                    action,
                    Action::Manage(super::manage::Command::Open(
                        _,
                        super::manage::Kind::Locations
                    ))
                )
            }) {
                actions.push(action);
            }
        }
        if self.projects.error {
            actions.push(Action::Project(Command::Refresh));
        }
        if self.projects.can_previous() || self.projects.can_next() {
            actions.extend([Command::Previous, Command::Next].map(Action::Project));
        }
        actions
    }
    pub fn project_enabled(&self, command: &Command) -> bool {
        if self.navigation.current() != Route::Projects
            || !matches!(self.connection, ConnectionState::Connected { .. })
        {
            return false;
        }
        match command {
            Command::Select(id) => self.projects.items.iter().any(|item| item.id == *id),
            Command::Create(id) => {
                self.enabled(&Action::CreateSession)
                    && self
                        .projects
                        .items
                        .iter()
                        .any(|item| item.id == *id && item.usable())
            }
            Command::Next => self.projects.can_next(),
            Command::Previous => self.projects.can_previous(),
            Command::Refresh => !self.projects.loading,
        }
    }
    pub fn project_action(&mut self, command: Command) -> Option<Action> {
        match command {
            Command::Select(id) => {
                self.projects.selected = Some(id);
                self.focus = Focus::List;
            }
            Command::Create(id) => {
                self.creating = true;
                self.notice = None;
                return Some(Action::Project(Command::Create(id)));
            }
            Command::Refresh => self.projects.restart(),
            Command::Next => {
                self.projects.change_page(true);
            }
            Command::Previous => {
                self.projects.change_page(false);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, i18n::I18n};

    fn page(ids: &[&str], next: Option<&str>) -> QueryResult {
        QueryResult::Page {
            view: View::Summary,
            revision: "r1".into(),
            project_count: 2,
            items: ids
                .iter()
                .enumerate()
                .map(|(index, id)| PageItem::Project {
                    project_index: index as u64,
                    id: (*id).into(),
                    name: (*id).into(),
                    alias_count: 0,
                    location_count: 1,
                    preferred_location_index: Some(0),
                    archived_at: None,
                    available: true,
                })
                .collect(),
            next_cursor: next.map(str::to_owned),
        }
    }

    #[test]
    fn project_pages_keep_identity_and_bound_history_without_hiding_alias_only_pages() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Projects));
        assert!(matches!(
            app.projects.query(),
            Some(Query::ListStart { .. })
        ));
        app.projects.refresh(); // A notification while loading must not be lost.
        assert!(app.projects.query().is_none());
        app.projects.complete(Ok(page(&["a", "b"], Some("2"))));
        assert!(app.projects.query().is_some());
        app.projects.complete(Ok(page(&["a", "b"], Some("2"))));
        app.apply(Action::Project(Command::Select("b".into())));
        let frozen = Command::Create("b".into());
        app.projects.complete(Ok(page(&["b", "a"], Some("2"))));
        assert_eq!(app.projects.selected.as_deref(), Some("b"));
        assert!(app.project_enabled(&frozen));
        app.projects.items[0].archived = true;
        assert!(!app.project_enabled(&frozen));
        app.projects.items[0].archived = false;
        app.projects.items[0].available = false;
        assert!(!app.project_enabled(&frozen));
        app.projects.complete(Ok(page(&["a"], Some("2"))));
        assert!(app.projects.selected.is_none());
        assert!(!app.project_enabled(&frozen));
        app.apply(Action::Project(Command::Next));
        assert!(
            matches!(app.projects.query(), Some(Query::ListContinue { cursor, .. }) if cursor == "2")
        );
        let mut aliases = page(&[], Some("3"));
        if let QueryResult::Page { items, .. } = &mut aliases {
            items.push(PageItem::Alias {
                project_index: 0,
                item_index: 0,
                alias: "old".into(),
            });
        }
        app.projects.complete(Ok(aliases));
        assert!(app.projects.items.is_empty() && app.projects.can_next());
        for _ in 0..130 {
            app.apply(Action::Project(Command::Next));
            app.projects.query();
            app.projects.complete(Ok(page(&["a"], Some("next"))));
        }
        assert_eq!(app.projects.previous.len(), 128);
        assert!(app.projects.can_next());
        app.projects.complete(Ok(QueryResult::RevisionChanged {
            view: View::Summary,
            expected: "r1".into(),
            actual: "r2".into(),
        }));
        assert!(matches!(
            app.projects.query(),
            Some(Query::ListStart { .. })
        ));
        app.projects.complete(Err("offline".into()));
        assert!(app.projects.query().is_none());
        app.apply(Action::Project(Command::Refresh));
        assert!(app.projects.query().is_some());
        app.projects.complete(Ok(page(&["a"], None)));
        app.projects.refresh();
        assert!(app.projects.query().is_some());
        app.projects.updated(&maka_protocol::project::Project {
            id: "a".into(),
            aliases: vec![],
            name: "Acknowledged".into(),
            location_count: 1,
            archived_at: Some(1),
            available: true,
        });
        app.projects.complete(Ok(page(&["a"], None))); // A pre-mutation read arrives late.
        assert_eq!(app.projects.items[0].name, "Acknowledged");
        assert!(app.projects.items[0].archived);
        assert!(app.projects.query().is_some());
        app.projects.complete(Ok(page(&["a"], None))); // The replacement read is authoritative.
        app.projects.complete(Ok(page(&["b", "a", "c"], None)));
        app.projects.selected = Some("b".into());
        app.projects.updated(&maka_protocol::project::Project {
            id: "a".into(),
            aliases: vec!["b".into()],
            name: "Canonical".into(),
            location_count: 1,
            archived_at: None,
            available: true,
        });
        assert_eq!(
            app.projects
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "c"]
        );
        assert_eq!(app.projects.selected.as_deref(), Some("a"));
        // Names outlive the page they came from; an absorbed id reads as its canonical project.
        assert_eq!(app.projects.resolve("b"), Some(("a", "Canonical")));
        assert_eq!(app.projects.resolve("c"), Some(("c", "c")));
        assert!(
            !app.project_enabled(&Command::Create("b".into())),
            "absorbed rows cannot remain actionable before the catalog refresh"
        );
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 15)).unwrap();
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
        }
        app.apply(Action::Project(Command::Select("a".into())));
        assert!(
            matches!(app.apply(Action::Project(Command::Create("a".into()))),
            Some(Action::Project(Command::Create(id))) if id == "a")
        );
        assert!(
            !app.project_enabled(&Command::Create("a".into())),
            "one creation in flight"
        );
        app.apply(Action::Visit(Route::Settings));
        assert!(!app.project_enabled(&Command::Select("a".into())));
    }
}
