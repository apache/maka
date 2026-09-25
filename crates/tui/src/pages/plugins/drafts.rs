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
use maka_plugins::composition::{EntryPatch, Injection, Isolation, Operation};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) struct Draft {
    pub base: u64,
    pub original: Option<EntryProjection>,
    // Identifier, opaque configuration, and routing. Never serialized.
    pub fields: [Editor; 3],
    pub scope: Scope,
    pub dirty: [bool; 3],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Services {
    inject: Injection,
    isolate: BTreeMap<String, Isolation>,
    intercept: BTreeMap<String, Value>,
}
pub(super) fn editor(text: &str, limit: usize) -> Editor {
    let mut editor = Editor::bounded(limit, "plugins-field-limit");
    editor.insert(text);
    editor.clear_history();
    editor
}
pub(super) const EDITOR_BYTES: usize = 256 * 1024;
pub(super) fn json_text(value: &impl Serialize) -> String {
    let pretty = serde_json::to_string_pretty(value).expect("JSON value");
    if pretty.len() <= EDITOR_BYTES {
        pretty
    } else {
        serde_json::to_string(value).expect("JSON value")
    }
}
pub(super) fn routing(entry: &EntryProjection) -> String {
    json_text(&Services {
        inject: entry.inject.clone(),
        isolate: entry.isolate.clone(),
        intercept: entry.intercept.clone(),
    })
}
impl Draft {
    fn existing(entry: &EntryProjection) -> Self {
        Self {
            base: entry.base_generation,
            scope: entry.root_id.clone(),
            original: Some(entry.clone()),
            fields: [
                editor(&entry.id, 128),
                editor(&json_text(&entry.config), EDITOR_BYTES),
                editor(&routing(entry), EDITOR_BYTES),
            ],
            dirty: [false; 3],
        }
    }
    fn new(base: u64) -> Self {
        Self {
            base,
            scope: Scope::Profile,
            original: None,
            fields: [
                editor("", 128),
                editor("null", EDITOR_BYTES),
                editor(r#"{"inject":[],"isolate":{},"intercept":{}}"#, EDITOR_BYTES),
            ],
            dirty: [false; 3],
        }
    }
    pub(super) fn adopt(&mut self, current: Option<EntryProjection>, base: u64) {
        if let Some(entry) = &current {
            let config = json_text(&entry.config);
            if !self.dirty[1] && self.fields[1].text() != config {
                self.fields[1] = editor(&config, EDITOR_BYTES);
            }
            let routing = routing(entry);
            if !self.dirty[2] && self.fields[2].text() != routing {
                self.fields[2] = editor(&routing, EDITOR_BYTES);
            }
        }
        self.base = base;
        self.original = current;
    }
    pub fn patch(&self, change: Change) -> Result<EntryPatch, String> {
        let index = if change == Change::Services { 2 } else { 1 };
        if let Some(error) = self.fields[index].error {
            return Err(error.into());
        }
        let patch = match change {
            Change::Configure => {
                let config: Value = serde_json::from_str(self.fields[1].text())
                    .map_err(|_| "plugins-invalid-json")?;
                if serde_json::to_vec(&config).expect("JSON value").len() > 64 * 1024 {
                    return Err("plugins-config-too-large".into());
                }
                EntryPatch {
                    config: Some(config),
                    ..Default::default()
                }
            }
            Change::Services => {
                let routing: Services = serde_json::from_str(self.fields[2].text())
                    .map_err(|_| "plugins-invalid-services")?;
                EntryPatch {
                    inject: Some(routing.inject),
                    isolate: Some(routing.isolate),
                    intercept: Some(routing.intercept),
                    ..Default::default()
                }
            }
            _ => return Err("plugins-invalid-json".into()),
        };
        Operation::Update {
            entry_id: "review".into(),
            patch: patch.clone(),
        }
        .validate()
        .map_err(|_| {
            if change == Change::Services {
                "plugins-invalid-services"
            } else {
                "plugins-invalid-config"
            }
        })?;
        Ok(patch)
    }
}
impl State {
    pub(super) fn sync_drafts(&mut self, snapshot: &Snapshot) {
        self.drafts.retain_mut(|(place, draft)| {
            if draft.dirty.iter().any(|dirty| *dirty) {
                return true;
            }
            match place {
                Place::Entry(key) => {
                    let Some(current) = snapshot.entry(key) else {
                        return false;
                    };
                    draft.adopt(Some(current.clone()), current.base_generation);
                    true
                }
                Place::New(package) => {
                    if snapshot.package(package).is_none() {
                        return false;
                    }
                    draft.base = snapshot.status.authority_epoch;
                    true
                }
                _ => true,
            }
        });
    }
    fn draft_place(&self) -> Place {
        self.place
            .entry()
            .map_or_else(|| self.place.clone(), |key| Place::Entry(key.clone()))
    }
    pub(super) fn draft(&self) -> Option<&Draft> {
        let place = self.draft_place();
        self.drafts
            .iter()
            .find(|(key, _)| *key == place)
            .map(|(_, draft)| draft)
    }
    pub(super) fn draft_mut(&mut self) -> Option<&mut Draft> {
        let place = self.draft_place();
        self.drafts
            .iter_mut()
            .find(|(key, _)| *key == place)
            .map(|(_, draft)| draft)
    }
    pub(super) fn ensure_draft(&mut self) {
        let place = self.draft_place();
        if self.drafts.iter().any(|(key, _)| *key == place) {
            return;
        }
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let draft = match &place {
            Place::Entry(key) => snapshot.entry(key).map(Draft::existing),
            Place::New(id) if snapshot.package(id).is_some() => {
                Some(Draft::new(snapshot.status.authority_epoch))
            }
            _ => None,
        };
        let Some(draft) = draft else {
            return;
        };
        if self.drafts.len() >= LIMIT {
            if let Some(index) = self
                .drafts
                .iter()
                .position(|(_, draft)| !draft.dirty.iter().any(|dirty| *dirty))
            {
                self.drafts.remove(index);
            } else {
                self.error = Some("plugins-draft-limit".into());
                return;
            }
        }
        self.drafts.push_back((place, draft));
    }
    pub(super) fn discard_draft(&mut self) {
        let place = self.draft_place();
        self.drafts.retain(|(key, _)| *key != place);
        self.ensure_draft();
    }
    pub(super) fn field_mut(&mut self, index: usize) -> Option<&mut Editor> {
        if self.place == Place::Install {
            return (index == 0).then_some(&mut self.path);
        }
        self.draft_mut()?.fields.get_mut(index)
    }
}
impl App {
    pub(crate) fn plugins_field_input(&mut self, event: &crossterm::event::Event) -> Option<bool> {
        use crossterm::event::{
            Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
        };
        if !self.plugins_enabled(&Command::Field(0)) || self.plugins.surface.captures() {
            return None;
        }
        let focused = self
            .plugins
            .surface
            .focused()
            .and_then(|p| p.rsplit('/').next())
            .and_then(|p| p.strip_prefix("field-"))
            .and_then(|p| p.parse::<usize>().ok());
        let (index, changed, edited) = match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let index = focused?;
                if matches!(key.code, KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab)
                    || (key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('q' | 'k' | 'p')))
                {
                    return None;
                }
                if index == 0 && matches!(key.code, KeyCode::Enter | KeyCode::Up | KeyCode::Down) {
                    return None;
                }
                let editor = self.plugins.field_mut(index)?;
                let before = editor.text().to_owned();
                let changed = editor.key(*key);
                (index, changed, before != editor.text())
            }
            Event::Paste(text) => {
                let index = focused?;
                if index == 0 && text.chars().any(char::is_control) {
                    self.plugins.error = Some("plugins-invalid-path".into());
                    return Some(true);
                }
                let editor = self.plugins.field_mut(index)?;
                let before = editor.text().to_owned();
                let changed = editor.insert(text);
                (index, changed, before != editor.text())
            }
            Event::Mouse(mouse) => {
                let indices: &[usize] = match self.plugins.place {
                    Place::Install => &[0],
                    Place::Configure(_) => &[1],
                    Place::Services(_) => &[2],
                    Place::New(_) => &[0, 1],
                    _ => return None,
                };
                let index = indices.iter().copied().find(|index| {
                    self.plugins
                        .field_mut(*index)
                        .is_some_and(|field| field.takes(mouse))
                })?;
                let changed = self.plugins.field_mut(index)?.mouse(*mouse);
                if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                    self.focus = crate::app::Focus::Page;
                    self.plugins
                        .surface
                        .focus(format!("plugins/scroll/body/field-{index}"));
                }
                (index, changed, false)
            }
            _ => return None,
        };
        if edited {
            self.plugins.error = None;
            if self.plugins.place == Place::Install {
                self.plugins.preview = None;
            } else if let Some(draft) = self.plugins.draft_mut() {
                draft.dirty[index] = true;
            }
        }
        Some(changed)
    }
}
