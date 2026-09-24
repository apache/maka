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

use crate::{
    app::{Action, App, Focus},
    navigation::Route,
};

pub struct State {
    focus: Focus,
    control: Option<Action>,
    details: bool,
    navigation: Option<Route>,
}

/// Only stable local controls survive a process boundary. In particular, never
/// serialize Action: it may carry a stale Turn target or an interaction binding.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum Setting {
    Theme,
    Locale,
    Symbols,
    Motion,
    CustomTheme,
}

impl Setting {
    fn action(&self) -> Action {
        match self {
            Self::Theme => Action::ToggleTheme,
            Self::Locale => Action::CycleLocale,
            Self::Symbols => Action::ToggleSymbols,
            Self::Motion => Action::ToggleMotion,
            Self::CustomTheme => Action::Theme(crate::theme::editor::Command::Open),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    focus: Focus,
    setting: Option<Setting>,
    details: bool,
    navigation: Option<Route>,
}

impl Saved {
    pub fn valid(&self, route: &Route, destination: impl Fn(&Route) -> bool) -> bool {
        let focus = match self.focus {
            Focus::Navigation => true,
            Focus::List => matches!(
                route,
                Route::Workspace | Route::Inbox | Route::Projects | Route::Connections
            ),
            Focus::Composer | Focus::Transcript | Focus::Inspector => {
                matches!(route, Route::Session(_))
            }
            Focus::Page => matches!(
                route,
                Route::Workspace
                    | Route::Settings
                    | Route::Host
                    | Route::Help
                    | Route::Extensions
                    | Route::App(_)
            ),
            Focus::Queue => false,
        };
        focus
            && (self.setting.is_none() || *route == Route::Settings)
            && self
                .navigation
                .as_ref()
                .is_none_or(|route| self.focus == Focus::Navigation && destination(route))
    }

    pub fn restore(self) -> State {
        State {
            focus: self.focus,
            control: self.setting.map(|setting| setting.action()),
            details: self.details,
            navigation: self.navigation,
        }
    }
}

impl State {
    fn capture(app: &App) -> Self {
        Self {
            focus: app.focus,
            control: if app.navigation.current() == Route::Settings {
                app.settings.focused_setting()
            } else {
                app.page_actions().get(app.selected_control).cloned()
            },
            details: app.chrome.details,
            navigation: (app.focus == Focus::Navigation)
                .then(|| app.sidebar.focused_route())
                .flatten(),
        }
    }

    fn saved(&self, route: &Route, app: &App) -> Saved {
        let focus = match (route, self.focus) {
            (Route::Session(_), Focus::Page | Focus::Queue | Focus::Inspector) => Focus::Composer,
            (
                Route::Workspace | Route::Inbox | Route::Projects | Route::Connections,
                Focus::Page,
            ) => Focus::List,
            (_, focus) => focus,
        };
        Saved {
            focus,
            setting: if *route == Route::Settings {
                match self.control {
                    Some(Action::ToggleTheme) => Some(Setting::Theme),
                    Some(Action::CycleLocale) => Some(Setting::Locale),
                    Some(Action::ToggleSymbols) => Some(Setting::Symbols),
                    Some(Action::ToggleMotion) => Some(Setting::Motion),
                    Some(Action::Theme(crate::theme::editor::Command::Open)) => {
                        Some(Setting::CustomTheme)
                    }
                    _ => None,
                }
            } else {
                None
            },
            details: self.details,
            navigation: self.navigation.clone().filter(|route| match route {
                Route::Session(id) => app.tabs.contains(id),
                _ => true,
            }),
        }
    }
}

impl App {
    pub(crate) fn saved_pages(&self) -> Vec<(Route, Saved)> {
        let current = self.navigation.current();
        self.page_states
            .iter()
            .filter(|(route, _)| {
                *route != current
                    && match route {
                        Route::Session(id) => self.tabs.contains(id),
                        _ => true,
                    }
            })
            .map(|(route, state)| (route.clone(), state.saved(route, self)))
            .chain(std::iter::once((
                current.clone(),
                State::capture(self).saved(&current, self),
            )))
            .collect()
    }

    pub(crate) fn leave_page(&mut self) {
        let route = self.navigation.current();
        match route {
            Route::Settings => self.settings.surface.leave(),
            Route::Workspace => self.home.surface.leave(),
            Route::Extensions | Route::App(_) => {
                if let Some(surface) = self.apps_surface() {
                    surface.leave();
                }
            }
            _ => {}
        }
        let state = State::capture(self);
        self.page_states.retain(|(key, _)| *key != route);
        self.page_states.push_back((route, state));
        while self.page_states.len() > super::tabs::LIMIT + Route::PAGE_COUNT {
            self.page_states.pop_front();
        }
    }
    pub(crate) fn enter_page(&mut self) {
        let route = self.navigation.current();
        if route == Route::Connections {
            self.connections.refresh();
        }
        if route == Route::Projects {
            self.projects.refresh();
        }
        if route == Route::Inbox && self.inbox.selected.is_none() {
            self.inbox.selected = self.inbox.items.first().map(|item| item.id.clone());
        }
        self.focus = match route {
            Route::Inbox | Route::Projects | Route::Connections => Focus::List,
            Route::Session(_) => Focus::Composer,
            _ => Focus::Page,
        };
        self.selected_control = 0;
        self.chrome.details = false;
        if let Some(index) = self.page_states.iter().position(|(key, _)| *key == route) {
            let (_, state) = self.page_states.remove(index).unwrap();
            self.focus = state.focus;
            self.chrome.details = state.details;
            if let Some(route) = &state.navigation {
                self.sidebar.focus_route(route);
            }
            // Home was a list before the sidebar became the session directory.
            if route == Route::Workspace && self.focus == Focus::List {
                self.focus = Focus::Page;
            }
            if route == Route::Settings
                && let Some(action) = &state.control
            {
                self.settings.focus_setting(action);
            }
            self.selected_control = state
                .control
                .and_then(|action| {
                    self.page_actions()
                        .iter()
                        .position(|candidate| *candidate == action)
                })
                .unwrap_or(0);
        }
        if self.fullscreen() && self.focus == Focus::Navigation {
            self.focus = Focus::Composer;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, i18n::I18n};
    #[test]
    fn returning_to_pages_restores_focus_controls_and_details_without_replacing_drafts() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.apply(Action::Visit(Route::Session("a".into())));
        app.drafts.get_mut("a").unwrap().insert("draft A");
        assert!(app.bind_root("root-a"));
        assert!(app.bind_root("root-a"));
        assert!(!app.bind_root("different-root-at-the-same-path"));
        assert_eq!(app.drafts["a"].text(), "draft A");
        app.focus = Focus::Transcript;
        app.apply(Action::Visit(Route::Host));
        app.selected_control = 1;
        app.apply(Action::Visit(Route::Session("b".into())));
        app.drafts.get_mut("b").unwrap().insert("draft B");
        app.apply(Action::ToggleDetails);
        app.apply(Action::Visit(Route::Session("a".into())));
        assert_eq!(app.focus, Focus::Transcript);
        assert!(!app.chrome.details);
        assert_eq!(app.drafts["a"].text(), "draft A");
        app.apply(Action::Back);
        assert!(app.chrome.details);
        assert_eq!(app.drafts["b"].text(), "draft B");
        app.apply(Action::Visit(Route::Host));
        assert_eq!(app.focus, Focus::Page);
        assert_eq!(app.selected_control, 1);
        assert_eq!(app.page_actions()[1], Action::Connect);
    }
}
