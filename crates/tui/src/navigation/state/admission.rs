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

impl App {
    // Both admission and entry use the same final focus, sidebar selection and
    // settings control. This computes local metadata without changing owners.
    pub(super) fn arrival_state(
        &self,
        target: &Location,
        restored: Option<&State>,
        preserved: Option<Focus>,
    ) -> State {
        let mut state = restored.cloned().unwrap_or(State {
            focus: match target.route {
                Route::Session(_) => Focus::Composer,
                Route::Projects | Route::Connections => Focus::List,
                _ => Focus::Page,
            },
            control: None,
            details: false,
            navigation: None,
        });
        if target.route == Route::Workspace && state.focus == Focus::List {
            state.focus = Focus::Page;
        }
        if matches!(target.route, Route::Session(_))
            && self.chrome.session_fullscreen
            && state.focus == Focus::Navigation
        {
            state.focus = Focus::Composer;
        }
        if let Some(focus) = preserved {
            state.focus = focus;
        }
        if target.route == Route::Settings && state.control.is_none() {
            state.control = self.settings.focused_setting();
        }
        if state.focus == Focus::Navigation && state.navigation.is_none() {
            state.navigation = self.sidebar.focused_route();
        }
        state
    }

    pub(crate) fn saved_pages_at(
        &self,
        target: &Location,
        leaving: bool,
        preserved: Option<Focus>,
    ) -> Vec<(Location, Saved)> {
        if !leaving {
            let mut pages = self.saved_pages();
            if let Some((current, _)) = pages.last_mut() {
                *current = target.clone();
            }
            return pages;
        }
        let opening = match &target.route {
            Route::Session(id) => Some(id.as_str()),
            _ => None,
        };
        let tab = |id: &str| self.tabs.contains(id) || opening == Some(id);
        let current = self.navigation.location();
        let outgoing = State::capture(self);
        let mut past: std::collections::VecDeque<_> = self
            .page_states
            .iter()
            .filter(|(location, _)| location != current)
            .map(|(location, state)| (location, state))
            .collect();
        past.push_back((current, &outgoing));
        while past.len() >= PAGE_LIMIT {
            past.pop_front();
        }
        let restored = past
            .iter()
            .position(|(location, _)| *location == target)
            .and_then(|index| past.remove(index))
            .map(|(_, state)| state);
        let arrival = self.arrival_state(target, restored, preserved);
        past.into_iter()
            .filter(|(location, _)| match &location.route {
                Route::Session(id) => tab(id),
                _ => true,
            })
            .map(|(location, state)| (location.clone(), state.saved(&location.route, &tab)))
            .chain(std::iter::once((
                target.clone(),
                arrival.saved(&target.route, &tab),
            )))
            .collect()
    }
}
