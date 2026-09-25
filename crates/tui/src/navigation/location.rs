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

use super::Route;
use crate::pages::settings::Category;

/// The selected Settings destination belongs to shell history, not its surface.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum SettingsPlace {
    Builtin(Category),
    Contribution(Box<crate::apps::Key>),
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    pub route: Route,
    pub settings: Option<SettingsPlace>,
    pub embedded: Vec<crate::apps::Key>,
    pub inspector: bool,
    pub recovery: bool,
}

impl From<Route> for Location {
    fn from(route: Route) -> Self {
        let settings =
            (route == Route::Settings).then_some(SettingsPlace::Builtin(Category::default()));
        Self {
            route,
            settings,
            embedded: Vec::new(),
            inspector: false,
            recovery: false,
        }
    }
}

impl Location {
    /// Reconstruct the composition that owns an explicit result address.
    pub(crate) fn result(key: crate::apps::Key) -> Option<Self> {
        use maka_plugins::terminal_ui::Placement;
        let mut chain = vec![key];
        while let Some((parent, _)) = chain.last()?.within.as_deref() {
            chain.push(parent.clone());
        }
        chain.reverse();
        let root = chain.remove(0);
        let mut location = match root.placement {
            Placement::Page => Self::from(Route::App(root)),
            Placement::Settings => {
                let mut location = Self::from(Route::Settings);
                location.settings = Some(SettingsPlace::Contribution(Box::new(root)));
                location
            }
            Placement::Panel | Placement::Status => {
                let mut location = Self::from(Route::Session(root.session.clone()?));
                location.inspector = true;
                location.embedded.push(root);
                location
            }
            Placement::Slot { .. } => return None,
        };
        location.embedded.extend(chain);
        location.valid(|_| true).then_some(location)
    }
    #[cfg(test)]
    pub fn settings(place: SettingsPlace) -> Self {
        Self {
            route: Route::Settings,
            settings: Some(place),
            embedded: Vec::new(),
            inspector: false,
            recovery: false,
        }
    }
    pub(crate) fn valid(&self, destination: impl Fn(&Route) -> bool) -> bool {
        let route = match &self.route {
            Route::Session(id) => {
                !id.is_empty()
                    && id.encode_utf16().count() <= 256
                    && !id.chars().any(char::is_control)
            }
            Route::Plugins(place) => place.valid(),
            Route::App(key) => {
                key.valid()
                    && (self.recovery
                        || key.placement == maka_plugins::terminal_ui::Placement::Page)
            }
            _ => true,
        };
        route
            && self.mounts_valid()
            && destination(&self.route)
            && match (&self.route, &self.settings) {
                (Route::Settings, Some(SettingsPlace::Builtin(_))) => true,
                (Route::Settings, Some(SettingsPlace::Contribution(key))) => {
                    key.valid()
                        && key.placement == maka_plugins::terminal_ui::Placement::Settings
                        && key.within.is_none()
                        && key.session.is_none()
                }
                (Route::Settings, None) | (_, Some(_)) => false,
                (_, None) => true,
            }
    }
    pub(crate) fn addresses(&self) -> impl Iterator<Item = &crate::apps::Key> {
        let main = match &self.route {
            Route::App(key) => Some(key),
            Route::Settings => self.settings_pane(),
            _ => None,
        };
        main.into_iter().chain(&self.embedded)
    }
    pub(crate) fn contains(&self, key: &crate::apps::Key) -> bool {
        self.addresses().any(|address| address == key)
    }
    pub(crate) fn selected(&self, key: &crate::apps::Key) -> Option<&crate::apps::Key> {
        self.addresses().find(|address| address.same_mount(key))
    }
    pub(crate) fn mount(&mut self, key: crate::apps::Key) -> crate::apps::Key {
        if let Some(current) = self.selected(&key) {
            return current.clone();
        }
        self.embedded.push(key.clone());
        key
    }
    pub(crate) fn change_view(
        &mut self,
        source: &crate::apps::Key,
        route: serde_json::Value,
    ) -> bool {
        if !self.contains(source) {
            return false;
        }
        let target = source.at(route);
        if !target.valid() {
            return false;
        }
        self.embedded.retain(|key| !key.descends_from(source));
        if matches!(&self.route, Route::App(key) if key == source) {
            self.route = Route::App(target);
        } else if self.settings_pane() == Some(source) {
            self.settings = Some(SettingsPlace::Contribution(Box::new(target)));
        } else {
            let Some(current) = self.embedded.iter_mut().find(|key| *key == source) else {
                return false;
            };
            *current = target;
        }
        true
    }
    pub(crate) fn choose_settings(&mut self, place: SettingsPlace) {
        if let Some(SettingsPlace::Contribution(key)) = self.settings.take() {
            self.embedded.push(*key);
        }
        let place = match place {
            SettingsPlace::Contribution(key) => {
                let key = self.selected(&key).cloned().unwrap_or(*key);
                self.embedded.retain(|other| !other.same_mount(&key));
                SettingsPlace::Contribution(Box::new(key))
            }
            place => place,
        };
        self.settings = Some(place);
        self.embedded.sort_by_key(crate::apps::Key::depth);
    }
    fn mounts_valid(&self) -> bool {
        use maka_plugins::terminal_ui::Placement;
        if self.embedded.len() > 256
            || (self.inspector && !matches!(self.route, Route::Session(_)))
            || (self.recovery && !matches!(self.route, Route::App(_)))
        {
            return false;
        }
        let mut seen = Vec::<&crate::apps::Key>::new();
        if let Route::App(key) = &self.route {
            seen.push(key);
        }
        if let Some(key) = self.settings_pane() {
            seen.push(key);
        }
        for key in &self.embedded {
            if !key.valid() || seen.iter().any(|other| other.same_mount(key)) {
                return false;
            }
            let valid = match (&key.placement, &key.within, &self.route) {
                (Placement::Slot { .. }, Some(parent), _) => seen.contains(&&parent.0),
                (Placement::Panel | Placement::Status, None, Route::Session(session)) => {
                    key.session.as_ref() == Some(session)
                }
                (Placement::Settings, None, Route::Settings) => true,
                _ => false,
            };
            if !valid {
                return false;
            }
            seen.push(key);
        }
        true
    }
    pub(crate) fn references_session(&self, session: &str) -> bool {
        match &self.route {
            Route::Session(id) => id == session,
            Route::App(key) => key.references_session(session),
            _ => false,
        }
    }
    pub fn settings_category(&self) -> Category {
        match self.settings {
            Some(SettingsPlace::Builtin(category)) => category,
            _ => Category::default(),
        }
    }
    pub fn settings_pane(&self) -> Option<&crate::apps::Key> {
        match &self.settings {
            Some(SettingsPlace::Contribution(key)) => Some(key),
            _ => None,
        }
    }
}

/// Every shell location change enters through App::navigate.
pub(crate) enum Intent {
    Visit(Route),
    Settings(SettingsPlace),
    Back,
    Forward,
    CloseSession(String),
    ChangeView {
        source: crate::apps::Key,
        route: serde_json::Value,
        replace: bool,
    },
    Inspector(bool),
    Recovery(crate::apps::Key),
    Result(crate::apps::Key),
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugins::terminal_ui::Placement;
    use serde_json::json;

    #[test]
    fn interleaved_panels_and_slots_share_ordered_locations() {
        let mut panel = crate::apps::tests::key();
        panel.placement = Placement::Panel;
        let mut other = panel.clone();
        other.method = "other".into();
        let mut location = Location::from(Route::Session("session".into()));
        location.inspector = true;
        location.mount(panel.clone());
        location.mount(other.clone());
        let mut nav = crate::navigation::Navigation::default();
        nav.visit(location.clone());
        assert!(location.change_view(&panel, json!({"item":1})));
        nav.visit(location.clone());
        assert!(location.change_view(&other, json!({"item":2})));
        nav.visit(location.clone());
        let parent = panel.at(json!({"item":1}));
        let child = crate::apps::Key {
            package: "example.child".into(),
            method: "detail".into(),
            placement: Placement::Slot {
                name: "detail".into(),
            },
            within: Some(Box::new((parent.clone(), "root/detail".into()))),
            origin: json!({"parent":1}),
            route: json!({"parent":1}),
            session: Some("session".into()),
        };
        location.mount(child.clone());
        nav.replace(location.clone());
        assert!(location.change_view(&child, json!({"child":3})));
        nav.visit(location);
        assert!(nav.valid(|_| true));
        nav.back();
        assert!(nav.location().contains(&child));
        nav.back();
        assert!(nav.location().contains(&parent));
        assert!(nav.location().contains(&other));
        nav.forward();
        assert!(nav.location().contains(&other.at(json!({"item":2}))));
        let encoded = serde_json::to_vec(&nav).unwrap();
        let restored: crate::navigation::Navigation = serde_json::from_slice(&encoded).unwrap();
        assert!(restored.valid(|_| true));
        assert_eq!(restored.location(), nav.location());
    }
}
