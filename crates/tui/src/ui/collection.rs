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

//! Local collection interaction. A view owns one state handle; surfaces use
//! it without backend calls. A committed move is taken exactly once by its owner.
mod control;
mod render;
pub use control::Control;
#[cfg(test)]
mod tests;
use crate::editor::Editor;
use crossterm::event::{Event, KeyCode, KeyModifiers};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub group: String,
    pub title: String,
    pub summary: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Move {
    pub item: String,
    pub group: String,
    pub before: String,
}
struct State {
    query: Editor,
    groups: Vec<String>,
    items: Vec<Entry>,
    selected: Option<String>,
    preview: Option<Move>,
    committed: Option<Move>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            query: Editor::bounded(256, "extensions-field-limit"),
            groups: vec![],
            items: vec![],
            selected: None,
            preview: None,
            committed: None,
        }
    }
}
#[derive(Clone, Default)]
pub struct Collection(Arc<Mutex<State>>);
#[derive(Default)]
pub struct Collections(Mutex<HashMap<String, Collection>>);
impl Collections {
    pub fn get(&self, path: &str) -> Collection {
        self.0
            .lock()
            .unwrap()
            .entry(path.into())
            .or_default()
            .clone()
    }
    pub fn retain(&self, paths: &[String]) {
        self.0
            .lock()
            .unwrap()
            .retain(|path, _| paths.contains(path));
    }
}
impl Collection {
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub fn model(&self, groups: Vec<String>, items: Vec<Entry>, initial: Option<&str>) {
        let mut state = self.0.lock().unwrap();
        let fresh = state.groups.is_empty();
        if state.groups != groups || state.items != items {
            state.preview = None;
            state.committed = None;
        }
        state.groups = groups;
        state.items = items;
        if fresh {
            state.selected = initial.map(str::to_owned);
        }
        if state
            .selected
            .as_ref()
            .is_some_and(|id| !state.items.iter().any(|item| &item.key == id))
        {
            state.selected = None;
        }
    }
    pub fn selected(&self) -> Option<String> {
        self.0.lock().unwrap().selected.clone()
    }
    pub fn select(&self, item: &str) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.selected.as_deref() == Some(item)
            || !state.items.iter().any(|entry| entry.key == item)
        {
            return false;
        }
        state.selected = Some(item.into());
        true
    }
    pub fn edit(&self, event: &Event) -> Option<bool> {
        let mut state = self.0.lock().unwrap();
        if let Event::Key(key) = event
            && (key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META)
                || key.modifiers.contains(KeyModifiers::CONTROL)
                    && !matches!(
                        key.code,
                        KeyCode::Char('a' | 'z' | 'y' | 'u' | 'k')
                            | KeyCode::Left
                            | KeyCode::Right
                            | KeyCode::Backspace
                            | KeyCode::Delete
                    ))
        {
            return None;
        }
        match event {
            Event::Key(key)
                if !matches!(
                    key.code,
                    KeyCode::Enter
                        | KeyCode::Tab
                        | KeyCode::BackTab
                        | KeyCode::Esc
                        | KeyCode::Up
                        | KeyCode::Down
                        | KeyCode::F(_)
                ) =>
            {
                Some(state.query.key(*key))
            }
            Event::Paste(text) => Some(state.query.insert(&crate::view::safe(text))),
            _ => None,
        }
    }
    pub fn visible(&self) -> Vec<Entry> {
        let state = self.0.lock().unwrap();
        let query = state.query.text().to_lowercase();
        let mut items = state.items.clone();
        if let Some(preview) = &state.preview
            && let Some(at) = items.iter().position(|item| item.key == preview.item)
        {
            let mut item = items.remove(at);
            item.group = preview.group.clone();
            let index = items
                .iter()
                .position(|item| item.key == preview.before)
                .unwrap_or(items.len());
            items.insert(index, item);
        }
        items.retain(|item| {
            query.is_empty()
                || item.title.to_lowercase().contains(&query)
                || item.summary.to_lowercase().contains(&query)
        });
        items
    }
    pub fn preview(&self) -> Option<Move> {
        self.0.lock().unwrap().preview.clone()
    }
    pub fn begin(&self, item: &str) -> bool {
        let mut state = self.0.lock().unwrap();
        let Some(at) = state.items.iter().position(|entry| entry.key == item) else {
            return false;
        };
        let entry = &state.items[at];
        let next = state.items[at + 1..]
            .iter()
            .find(|other| other.group == entry.group);
        state.preview = Some(Move {
            item: item.into(),
            group: entry.group.clone(),
            before: next.map_or(String::new(), |entry| entry.key.clone()),
        });
        true
    }
    pub fn target(&self, group: &str, before: &str) {
        let mut state = self.0.lock().unwrap();
        if !state.groups.iter().any(|id| id == group)
            || !before.is_empty()
                && !state
                    .items
                    .iter()
                    .any(|entry| entry.key == before && entry.group == group)
        {
            return;
        }
        if let Some(preview) = &mut state.preview
            && preview.item != before
        {
            preview.group = group.into();
            preview.before = before.into();
        }
    }
    pub fn step(&self, code: KeyCode) {
        let mut state = self.0.lock().unwrap();
        let Some(mut preview) = state.preview.clone() else {
            return;
        };
        if matches!(code, KeyCode::Left | KeyCode::Right) {
            let at = state
                .groups
                .iter()
                .position(|id| *id == preview.group)
                .unwrap_or(0);
            let next = if code == KeyCode::Left {
                at.saturating_sub(1)
            } else {
                (at + 1).min(state.groups.len().saturating_sub(1))
            };
            preview.group = state.groups[next].clone();
            preview.before.clear();
        } else {
            let items: Vec<_> = state
                .items
                .iter()
                .filter(|entry| entry.group == preview.group && entry.key != preview.item)
                .collect();
            let at = items
                .iter()
                .position(|entry| entry.key == preview.before)
                .unwrap_or(items.len());
            let next = if code == KeyCode::Up {
                at.saturating_sub(1)
            } else {
                (at + 1).min(items.len())
            };
            preview.before = items
                .get(next)
                .map_or(String::new(), |entry| entry.key.clone());
        }
        state.preview = Some(preview);
    }
    pub fn cancel(&self) {
        self.0.lock().unwrap().preview = None;
    }
    pub fn commit(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        let Some(preview) = state.preview.take() else {
            return false;
        };
        let Some(at) = state
            .items
            .iter()
            .position(|entry| entry.key == preview.item)
        else {
            return false;
        };
        let entry = &state.items[at];
        let before = state.items[at + 1..]
            .iter()
            .find(|next| next.group == entry.group)
            .map_or("", |next| next.key.as_str());
        if entry.group == preview.group && before == preview.before {
            return false;
        }
        state.committed = Some(preview);
        true
    }
    pub fn take_move(&self) -> Option<Move> {
        self.0.lock().unwrap().committed.take()
    }
}
