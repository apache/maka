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

pub mod state;
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
    Host,
    Settings,
    Help,
    Inbox,
    Projects,
    Connections,
    /// The directory of every plugin view.
    Extensions,
    /// A plugin view as a page of its own.
    App(crate::apps::Key),
}

impl Route {
    pub const PAGE_COUNT: usize = Self::ALL.len() + 2;
    pub const ALL: [Self; 6] = [
        Self::Workspace,
        Self::Host,
        Self::Settings,
        Self::Help,
        Self::Inbox,
        Self::Projects,
    ];
    pub fn title(&self) -> &'static str {
        match self {
            Self::Workspace => "route-workspace",
            Self::Session(_) => "route-session",
            Self::Host => "route-host",
            Self::Settings => "route-settings",
            Self::Help => "route-help",
            Self::Inbox => "route-inbox",
            Self::Projects => "route-projects",
            Self::Connections => "route-connections",
            Self::Extensions | Self::App(_) => "route-extensions",
        }
    }
    pub fn section(&self) -> Self {
        match self {
            Self::Session(_) => Self::Workspace,
            Self::Connections => Self::Settings,
            Self::Extensions => Self::Host,
            Self::App(key) => Self::App(key.clone()),
            _ => self.clone(),
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Navigation {
    entries: VecDeque<Route>,
    cursor: usize,
}
impl Default for Navigation {
    fn default() -> Self {
        Self {
            entries: VecDeque::from([Route::Workspace]),
            cursor: 0,
        }
    }
}
impl Navigation {
    pub fn valid(&self, route: impl Fn(&Route) -> bool) -> bool {
        !self.entries.is_empty()
            && self.entries.len() <= 128
            && self.cursor < self.entries.len()
            && self.entries.iter().all(route)
    }
    pub fn current(&self) -> Route {
        self.entries[self.cursor].clone()
    }
    pub fn visit(&mut self, route: Route) {
        if route == self.current() {
            return;
        }
        self.entries.truncate(self.cursor + 1);
        self.entries.push_back(route);
        if self.entries.len() > 128 {
            self.entries.pop_front();
        }
        self.cursor = self.entries.len() - 1;
    }
    /// The session most recently visited up to here, the one that
    /// session-scoped places act on.
    pub fn recent_session(&self) -> Option<String> {
        self.entries
            .iter()
            .take(self.cursor + 1)
            .rev()
            .find_map(|route| match route {
                Route::Session(id) => Some(id.clone()),
                _ => None,
            })
    }
    pub fn back(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }
    pub fn destination(&self, forward: bool) -> Route {
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
        let target = Route::Session(id.into());
        let current = self.current();
        let before = self
            .entries
            .iter()
            .take(self.cursor + 1)
            .filter(|r| **r != target)
            .count();
        self.entries.retain(|route| *route != target);
        if self.entries.is_empty() {
            self.entries.push_back(Route::Workspace);
        }
        self.cursor = before.saturating_sub(1).min(self.entries.len() - 1);
        if current == target {
            self.visit(fallback);
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
        nav.visit(Route::Host);
        nav.visit(Route::Settings);
        nav.back();
        assert_eq!(nav.current(), Route::Host);
        nav.visit(Route::Help);
        nav.forward();
        assert_eq!(nav.current(), Route::Help);
        nav.visit(Route::Help);
        nav.back();
        assert_eq!(nav.current(), Route::Host);
        for _ in 0..200 {
            nav.visit(Route::Settings);
            nav.visit(Route::Help);
        }
        assert_eq!(nav.entries.len(), 128);
        for _ in 0..200 {
            nav.back();
        }
        assert_eq!(nav.cursor, 0);
    }
}
