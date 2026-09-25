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

//! Disk-safe reading metadata; never contains rendered text or observation authority.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    folds: Vec<(MessageKey, bool)>,
    groups: Vec<(MessageKey, Vec<MessageKey>)>,
    anchor: Option<Anchor>,
    selected: Option<MessageKey>,
    search: Option<search::Saved>,
    trace: bool,
}

impl MessageKey {
    pub(in crate::ui::transcript) fn valid(&self) -> bool {
        [&self.turn, &self.message].into_iter().all(|part| {
            !part.is_empty() && part.len() <= 2048 && !part.chars().any(char::is_control)
        })
    }
    pub(in crate::ui::transcript) fn budget(&self) -> usize {
        2 * (self.turn.len() + self.message.len()) + 128
    }
}

impl Saved {
    pub fn bytes(&self) -> usize {
        512 + self
            .folds
            .iter()
            .map(|(key, _)| key.budget())
            .sum::<usize>()
            + self
                .groups
                .iter()
                .map(|(key, members)| {
                    key.budget() + members.iter().map(MessageKey::budget).sum::<usize>()
                })
                .sum::<usize>()
            + self
                .anchor
                .as_ref()
                .map_or(0, |anchor| anchor.key.budget() + 128)
            + self.selected.as_ref().map_or(0, MessageKey::budget)
            + self.search.as_ref().map_or(0, search::Saved::bytes)
    }
    pub fn valid(&self) -> bool {
        let mut keys = HashSet::new();
        let folds = self
            .folds
            .iter()
            .all(|(key, _)| key.valid() && keys.insert(key));
        keys.clear();
        let mut members = HashSet::new();
        let groups = self.groups.iter().all(|(key, items)| {
            key.valid()
                && key.part.members().is_some()
                && keys.insert(key)
                && !items.is_empty()
                && items.iter().all(|member| {
                    member.valid()
                        && Some(member.part) == key.part.members()
                        && member.turn == key.turn
                        && members.insert(member)
                })
        });
        folds
            && groups
            && self.anchor.as_ref().is_none_or(|anchor| {
                anchor.key.valid()
                    && anchor.source <= 64 * 1024 * 1024
                    && anchor.screen_row <= usize::from(u16::MAX)
            })
            && self.selected.as_ref().is_none_or(MessageKey::valid)
            && self.search.as_ref().is_none_or(search::Saved::valid)
    }
    pub fn restore(self) -> Reading {
        Reading {
            folds: self.folds.into_iter().collect(),
            membership: self
                .groups
                .iter()
                .flat_map(|(key, members)| {
                    members.iter().map(|member| (member.clone(), key.clone()))
                })
                .collect(),
            groups: self.groups.into_iter().collect(),
            anchor: self.anchor,
            selected: self.selected,
            selection: Default::default(),
            search: self.search.map(search::Saved::restore),
            trace: self.trace,
            mouse_selected: false,
        }
    }
    fn canonical(mut self) -> Self {
        self.folds.sort_by(|(left, _), (right, _)| left.cmp(right));
        self.groups.sort_by(|(left, _), (right, _)| left.cmp(right));
        self
    }
}

impl Reading {
    pub fn saved(&self) -> Saved {
        Saved {
            folds: self
                .folds
                .iter()
                .map(|(key, folded)| (key.clone(), *folded))
                .collect(),
            groups: self
                .groups
                .iter()
                .map(|(key, members)| (key.clone(), members.clone()))
                .collect(),
            anchor: self.anchor.clone(),
            selected: self.selected.clone(),
            search: self.search.as_ref().map(search::Search::saved),
            trace: self.trace,
        }
        .canonical()
    }
}

impl Transcript {
    pub fn saved_reading(&self) -> Saved {
        let mut folds = self.restore_folds.clone().unwrap_or_default();
        folds.extend(
            self.blocks
                .iter()
                .filter(|(_, block)| block.kind.foldable())
                .map(|(key, block)| (key.clone(), block.folded)),
        );
        Saved {
            folds: folds.into_iter().collect(),
            groups: self
                .groups
                .iter()
                .map(|(key, members)| (key.clone(), members.clone()))
                .collect(),
            anchor: self.anchor.clone(),
            selected: self.selected.clone(),
            search: self.search.as_ref().map(search::Search::saved),
            trace: self.trace,
        }
        .canonical()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    #[test]
    fn disk_bookmark_rebuilds_folds_anchor_and_search_without_text_selection_or_cached_authority() {
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        let rows: BTreeMap<_, _> = (1..20).map(|index| (index, json!({"type":"user", "id":format!("m{index}"), "turnId":"turn", "text":format!("中文 {index}\nBODY_NOT_SAVED {}", "paragraph ".repeat(80))}))).collect();
        let draw = |view: &mut Transcript| {
            let mut terminal = Terminal::new(TestBackend::new(45, 12)).unwrap();
            terminal
                .draw(|frame| {
                    view.draw(frame, frame.area(), false).unwrap();
                })
                .unwrap();
        };
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &i18n, false);
        draw(&mut view);
        let key = MessageKey::durable(&rows[&8]);
        view.toggle(&key);
        view.select(MessageKey::durable(&rows[&9]));
        draw(&mut view);
        view.selection_key(crossterm::event::KeyCode::Right);
        assert!(view.text_selection.active());
        view.search_command(search::Command::Open);
        view.search.as_mut().unwrap().editor.insert("中文");
        view.refresh_search(false);
        let anchor = view.anchor.clone().unwrap();
        let bytes = serde_json::to_vec(&view.saved_reading()).unwrap();
        assert!(
            !std::str::from_utf8(&bytes)
                .unwrap()
                .contains("BODY_NOT_SAVED")
        );
        let saved: Saved = serde_json::from_slice(&bytes).unwrap();
        assert!(saved.valid());
        assert!(bytes.len() <= saved.bytes());
        let mut resumed = Transcript::resume(saved.restore());
        assert!(!resumed.text_selection.active());
        assert!(resumed.blocks.is_empty());
        resumed.sync(&rows, &[], 0, &i18n, false);
        draw(&mut resumed);
        assert!(
            !resumed.folded(&key),
            "manual expansion survives the default collapsed prompt"
        );
        assert_eq!(resumed.anchor.as_ref().unwrap().key, anchor.key);
        assert_eq!(resumed.anchor.as_ref().unwrap().source, anchor.source);
        assert_eq!(
            resumed.search.as_ref().unwrap().count(),
            view.search.as_ref().unwrap().count()
        );
        resumed.search_command(search::Command::Scope);
        let history: Saved =
            serde_json::from_slice(&serde_json::to_vec(&resumed.saved_reading()).unwrap()).unwrap();
        let restored = history.restore();
        assert!(restored.search.unwrap().history);

        let mut invalid: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let duplicate = invalid["folds"][0].clone();
        invalid["folds"].as_array_mut().unwrap().push(duplicate);
        assert!(!serde_json::from_value::<Saved>(invalid).unwrap().valid());
        let mut invalid: Saved = serde_json::from_slice(&bytes).unwrap();
        invalid.anchor.as_mut().unwrap().source = usize::MAX;
        assert!(!invalid.valid());

        let mut oversized: Saved = serde_json::from_slice(&bytes).unwrap();
        oversized.folds = (0..1100)
            .map(|index| {
                (
                    MessageKey {
                        turn: "turn".into(),
                        message: format!("{index:04}{}", "x".repeat(2044)),
                        part: Part::Text,
                    },
                    true,
                )
            })
            .collect();
        assert!(oversized.valid());
        assert!(oversized.bytes() > crate::pages::chat::reading::DISK_BUDGET);
        let large = serde_json::from_value(json!({"range":null, "view":oversized})).unwrap();
        let small =
            serde_json::from_value(json!({"range":null, "view":view.saved_reading()})).unwrap();
        let mut chat = crate::pages::chat::Chat::default();
        chat.restore_checkpoints(vec![("large".into(), large), ("recent".into(), small)]);
        let retained = chat.checkpoints();
        assert_eq!(retained.len(), 1);
        assert_eq!(
            retained[0].0, "recent",
            "oversized cache metadata must not block saving other state"
        );
    }
}
