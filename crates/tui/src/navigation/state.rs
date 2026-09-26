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
    navigation::{Location, Route},
};

/// Includes the current page captured alongside the retained past pages.
pub(crate) const PAGE_LIMIT: usize = super::tabs::LIMIT + Route::PAGE_COUNT;
mod admission;

#[derive(Clone)]
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
    Host,
}

impl Setting {
    fn action(&self) -> Action {
        match self {
            Self::Theme => Action::ToggleTheme,
            Self::Locale => Action::CycleLocale,
            Self::Symbols => Action::ToggleSymbols,
            Self::Motion => Action::ToggleMotion,
            Self::CustomTheme => Action::Theme(crate::theme::editor::Command::Open),
            Self::Host => Action::Host,
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
    pub fn valid(&self, location: &Location, destination: impl Fn(&Route) -> bool) -> bool {
        let route = &location.route;
        let focus = match self.focus {
            Focus::Navigation => true,
            Focus::List => matches!(
                route,
                Route::Workspace | Route::Projects | Route::Connections
            ),
            Focus::Composer | Focus::Transcript | Focus::Inspector => {
                matches!(route, Route::Session(_))
            }
            Focus::Page => matches!(
                route,
                Route::Workspace
                    | Route::Settings
                    | Route::Plugins(_)
                    | Route::Extensions
                    | Route::App(_)
            ),
            Focus::Header | Focus::Queue => false,
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
                None
            },
            details: app.chrome.details,
            navigation: (app.focus == Focus::Navigation)
                .then(|| app.sidebar.focused_route())
                .flatten(),
        }
    }

    fn saved(&self, route: &Route, tab: &impl Fn(&str) -> bool) -> Saved {
        let focus = match (route, self.focus) {
            (Route::Session(_), Focus::Header) => Focus::Composer,
            (Route::Connections | Route::Projects, Focus::Header) => Focus::List,
            (_, Focus::Header) => Focus::Page,
            (Route::Session(_), Focus::Page | Focus::Queue | Focus::Inspector) => Focus::Composer,
            (Route::Workspace | Route::Projects | Route::Connections, Focus::Page) => Focus::List,
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
                    Some(Action::Host) => Some(Setting::Host),
                    Some(Action::Theme(crate::theme::editor::Command::Open)) => {
                        Some(Setting::CustomTheme)
                    }
                    _ => None,
                }
            } else {
                None
            },
            details: self.details,
            navigation: self.navigation.clone().filter(|route| {
                focus == Focus::Navigation
                    && match route {
                        Route::Session(id) => tab(id),
                        _ => true,
                    }
            }),
        }
    }
}

impl App {
    pub(crate) fn saved_pages(&self) -> Vec<(Location, Saved)> {
        let tab = |id: &str| self.tabs.contains(id);
        let current = self.navigation.location().clone();
        self.page_states
            .iter()
            .filter(|(location, _)| {
                *location != current
                    && match &location.route {
                        Route::Session(id) => tab(id),
                        _ => true,
                    }
            })
            .rev()
            .take(PAGE_LIMIT - 1)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|(location, state)| (location.clone(), state.saved(&location.route, &tab)))
            .chain(std::iter::once((
                current.clone(),
                State::capture(self).saved(&current.route, &tab),
            )))
            .collect()
    }

    pub(crate) fn leave_page(&mut self) {
        self.park_app_reading();
        let route = self.navigation.current();
        match route {
            Route::Plugins(_) => self.plugins.leave(),
            Route::Settings => self.settings.surface.leave(),
            Route::Connections => self.connections.surface.leave(),
            Route::Projects => self.projects.surface.leave(),
            Route::Workspace => self.home.surface.leave(),
            Route::Extensions | Route::App(_) => {
                if let Some(surface) = self.apps_surface() {
                    surface.leave();
                }
            }
            _ => {}
        }
        let state = State::capture(self);
        let location = self.navigation.location().clone();
        self.page_states.retain(|(key, _)| *key != location);
        self.page_states.push_back((location, state));
        while self.page_states.len() >= PAGE_LIMIT {
            self.page_states.pop_front();
        }
    }
    pub(crate) fn enter_page(&mut self) {
        self.enter_page_focused(None);
    }
    pub(crate) fn enter_page_focused(&mut self, preserved: Option<Focus>) {
        let route = self.navigation.current();
        if let Route::Plugins(place) = &route {
            self.plugins.enter(place);
        }
        if route == Route::Connections {
            self.connections.refresh();
        }
        if route == Route::Projects {
            self.projects.refresh();
        }
        let restored = self
            .page_states
            .iter()
            .position(|(key, _)| key == self.navigation.location())
            .map(|index| self.page_states.remove(index).unwrap().1);
        let state = self.arrival_state(self.navigation.location(), restored.as_ref(), preserved);
        self.focus = state.focus;
        self.chrome.details = state.details;
        if let Some(route) = &state.navigation {
            self.sidebar.focus_route(route);
        }
        if route == Route::Settings
            && let Some(action) = &state.control
        {
            self.settings.focus_setting(action);
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
        app.apply(Action::Visit(Route::Settings));
        app.settings.focus_setting(&Action::ToggleSymbols);
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
        app.apply(Action::Visit(Route::Settings));
        assert_eq!(app.focus, Focus::Page);
        assert_eq!(app.settings.focused_setting(), Some(Action::ToggleSymbols));
    }
}
