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

use std::collections::VecDeque;

mod location;
pub mod state;
pub(crate) use location::Intent;
pub use location::{Location, SettingsPlace};
pub mod tabs;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "page",
    content = "id",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Route {
    Workspace,
    Session(String),
    Settings,
    /// Local-owner package and composition management, with shell history.
    Plugins(crate::pages::plugins::Place),
    Projects,
    Connections,
    /// The directory of every plugin view.
    Extensions,
    /// A plugin view as a page of its own.
    App(crate::apps::Key),
}

impl Route {
    pub const PAGE_COUNT: usize = Self::ALL.len() + 3;
    pub const ALL: [Self; 3] = [Self::Workspace, Self::Settings, Self::Projects];
    pub fn title(&self) -> &'static str {
        match self {
            Self::Workspace => "route-workspace",
            Self::Session(_) => "route-session",
            Self::Settings => "route-settings",
            Self::Plugins(_) => "route-plugins",
            Self::Projects => "route-projects",
            Self::Connections => "route-connections",
            Self::Extensions | Self::App(_) => "route-extensions",
        }
    }
    pub fn section(&self) -> Self {
        match self {
            Self::Session(_) => Self::Workspace,
            Self::Connections | Self::Plugins(_) => Self::Settings,
            Self::Extensions => Self::Settings,
            Self::App(key) => Self::App(key.clone()),
            _ => self.clone(),
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Navigation {
    entries: VecDeque<Location>,
    cursor: usize,
}
impl Default for Navigation {
    fn default() -> Self {
        Self {
            entries: VecDeque::from([Route::Workspace.into()]),
            cursor: 0,
        }
    }
}
impl Navigation {
    pub fn valid(&self, route: impl Fn(&Route) -> bool) -> bool {
        !self.entries.is_empty()
            && self.entries.len() <= 128
            && self.cursor < self.entries.len()
            && self.entries.iter().all(|location| location.valid(&route))
    }
    pub fn current(&self) -> Route {
        self.location().route.clone()
    }
    pub fn location(&self) -> &Location {
        &self.entries[self.cursor]
    }
    /// A shell destination returns to its last selected place.
    pub fn resolve(&self, route: Route) -> Location {
        self.entries
            .iter()
            .take(self.cursor + 1)
            .rev()
            .find(|location| location.route == route)
            .cloned()
            .unwrap_or_else(|| route.into())
    }
    pub fn visit(&mut self, location: impl Into<Location>) {
        let location = location.into();
        if &location == self.location() {
            return;
        }
        self.entries.truncate(self.cursor + 1);
        self.entries.push_back(location);
        if self.entries.len() > 128 {
            self.entries.pop_front();
        }
        self.cursor = self.entries.len() - 1;
    }
    pub(crate) fn replace(&mut self, location: Location) -> bool {
        if !location.valid(|_| true) {
            return false;
        }
        self.entries[self.cursor] = location;
        true
    }
    pub(crate) fn can_back(&self) -> bool {
        self.cursor > 0
    }
    /// The session most recently visited up to here, the one that
    /// session-scoped places act on.
    pub fn recent_session(&self) -> Option<String> {
        self.entries
            .iter()
            .take(self.cursor + 1)
            .rev()
            .find_map(|location| match &location.route {
                Route::Session(id) => Some(id.clone()),
                _ => None,
            })
    }
    pub fn back(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }
    pub fn destination(&self, forward: bool) -> Location {
        self.entries[if forward {
            (self.cursor + 1).min(self.entries.len() - 1)
        } else {
            self.cursor.saturating_sub(1)
        }]
        .clone()
    }
    /// Closing a reading tab is not deleting the session. Remove its history
    /// entries so Back cannot immediately reopen the tab the user just closed.
    pub fn close_session(&mut self, id: &str, fallback: Route) {
        let closing_current = self.location().references_session(id);
        let before = self
            .entries
            .iter()
            .take(self.cursor + 1)
            .filter(|location| !location.references_session(id))
            .count();
        self.entries
            .retain(|location| !location.references_session(id));
        if self.entries.is_empty() {
            self.entries.push_back(Route::Workspace.into());
        }
        self.cursor = before.saturating_sub(1).min(self.entries.len() - 1);
        if closing_current {
            self.visit(self.resolve(fallback));
        }
    }
    pub fn forward(&mut self) {
        self.cursor = (self.cursor + 1).min(self.entries.len() - 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_replaces_forward_branch_and_bounds_history() {
        let mut nav = Navigation::default();
        nav.visit(Route::Projects);
        nav.visit(Route::Settings);
        nav.back();
        assert_eq!(nav.current(), Route::Projects);
        nav.visit(Route::Extensions);
        nav.forward();
        assert_eq!(nav.current(), Route::Extensions);
        nav.visit(Route::Extensions);
        nav.back();
        assert_eq!(nav.current(), Route::Projects);
        for _ in 0..200 {
            nav.visit(Route::Settings);
            nav.visit(Route::Extensions);
        }
        assert_eq!(nav.entries.len(), 128);
        for _ in 0..200 {
            nav.back();
        }
        assert_eq!(nav.cursor, 0);
    }
    #[test]
    fn locations_keep_settings_in_order_and_validate_the_selected_address() {
        use crate::pages::settings::Category;
        let mut nav = Navigation::default();
        let interface = Location::settings(SettingsPlace::Builtin(Category::Interface));
        let host = Location::settings(SettingsPlace::Builtin(Category::Host));
        nav.visit(interface.clone());
        nav.visit(host.clone());
        nav.back();
        assert_eq!(nav.location(), &interface);
        nav.forward();
        assert_eq!(nav.location(), &host);
        nav.visit(Route::Projects);
        assert_eq!(nav.resolve(Route::Settings), host);
        assert!(nav.valid(|_| true));
        let mut invalid = Location::from(Route::Workspace);
        invalid.settings = interface.settings;
        assert!(!invalid.valid(|_| true));
        let mut key = crate::apps::tests::key();
        key.package.clear();
        assert!(!Location::from(Route::App(key)).valid(|_| true));
    }
}
