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

//! A reading bookmark, not another transcript or an observation lease.
use super::*;
pub mod saved;

pub struct Reading {
    folds: HashMap<MessageKey, bool>,
    groups: HashMap<MessageKey, Vec<MessageKey>>,
    membership: HashMap<MessageKey, MessageKey>,
    anchor: Option<Anchor>,
    selected: Option<MessageKey>,
    selection: selection::Selection,
    search: Option<search::Search>,
    trace: bool,
    mouse_selected: bool,
}

impl MessageKey {
    pub(super) fn bytes(&self) -> usize {
        self.turn.len() + self.message.len() + std::mem::size_of::<Self>()
    }
}

impl Reading {
    pub fn bytes(&self) -> usize {
        self.folds.keys().map(MessageKey::bytes).sum::<usize>()
            + self
                .groups
                .iter()
                .map(|(key, members)| {
                    key.bytes() + members.iter().map(MessageKey::bytes).sum::<usize>()
                })
                .sum::<usize>()
            + self
                .membership
                .iter()
                .map(|(key, group)| key.bytes() + group.bytes())
                .sum::<usize>()
            + self.anchor.as_ref().map_or(0, |anchor| anchor.key.bytes())
            + self.selected.as_ref().map_or(0, MessageKey::bytes)
            + self.selection.retained_bytes()
            + self
                .search
                .as_ref()
                .map_or(0, search::Search::retained_bytes)
    }
}

impl Transcript {
    /// Retained source, layout and interaction storage, excluding the source
    /// adapter's separately budgeted observations and fragment staging.
    pub fn retained_bytes(&self) -> usize {
        let blocks = self
            .blocks
            .iter()
            .map(|(key, block)| {
                key.bytes()
                    + std::mem::size_of_val(block)
                    + block.text.capacity()
                    + block.changes.capacity() * std::mem::size_of::<layout::diff::Row>()
                    + block.file.as_ref().map_or(0, |file| file.path.capacity())
                    + block.layout.as_ref().map_or(0, |layout| layout.bytes)
                    + block.markdown.syntax_bytes()
                    + block.reveal.bytes()
            })
            .sum::<usize>();
        blocks
            + self
                .order
                .iter()
                .chain(&self.source_order)
                .map(MessageKey::bytes)
                .sum::<usize>()
            + self
                .groups
                .iter()
                .map(|(key, members)| {
                    key.bytes() + members.iter().map(MessageKey::bytes).sum::<usize>()
                })
                .sum::<usize>()
            + self
                .membership
                .iter()
                .map(|(key, group)| key.bytes() + group.bytes())
                .sum::<usize>()
            + self.starts.capacity() * std::mem::size_of::<usize>()
            + self.text_selection.retained_bytes()
            + self
                .search
                .as_ref()
                .map_or(0, search::Search::retained_bytes)
    }
    pub fn anchored_to<'a>(&self, keys: impl IntoIterator<Item = &'a MessageKey>) -> bool {
        self.anchor
            .as_ref()
            .is_some_and(|anchor| keys.into_iter().any(|key| key == &anchor.key))
    }

    pub fn take_reading(&mut self) -> Reading {
        let mut selection = std::mem::take(&mut self.text_selection);
        selection.suspend();
        let mut search = self.search.take();
        if let Some(search) = &mut search {
            search.suspend();
        }
        Reading {
            folds: {
                let mut folds = self.restore_folds.take().unwrap_or_default();
                folds.extend(
                    self.blocks
                        .iter()
                        .filter(|(_, block)| block.kind.foldable())
                        .map(|(key, block)| (key.clone(), block.folded)),
                );
                folds
            },
            groups: std::mem::take(&mut self.groups),
            membership: std::mem::take(&mut self.membership),
            anchor: self.anchor.clone(),
            selected: self.selected.clone(),
            selection,
            search,
            trace: self.trace,
            mouse_selected: self.mouse_selected,
        }
    }

    pub fn resume(reading: Reading) -> Self {
        Self {
            restore_folds: Some(reading.folds),
            groups: reading.groups,
            membership: reading.membership,
            anchor: reading.anchor,
            selected: reading.selected,
            text_selection: reading.selection,
            search: reading.search,
            trace: reading.trace,
            mouse_selected: reading.mouse_selected,
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use crossterm::event::KeyCode;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn draw(view: &mut Transcript) {
        let mut terminal = Terminal::new(TestBackend::new(45, 12)).unwrap();
        terminal
            .draw(|frame| {
                view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
    }

    #[test]
    fn reading_rebuilds_anchor_folds_query_and_unicode_selection_without_cached_body_or_geometry() {
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        let rows: BTreeMap<_, _> = (1..40).map(|index| (index, json!({"type":"user","id":format!("m{index}"),"turnId":"turn","text":format!("中文🦀 {index}\n{}", "long paragraph ".repeat(15))}))).collect();
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &i18n, false);
        draw(&mut view);
        let folded = MessageKey::durable(&rows[&8]);
        view.toggle(&folded);
        view.select(MessageKey::durable(&rows[&9]));
        draw(&mut view);
        view.selection_key(KeyCode::Right);
        view.selection_key(KeyCode::Right);
        let copied = view
            .copy_text(selection::CopyMode::Selection, false)
            .unwrap();
        assert_eq!(copied, "中文");
        view.search_command(search::Command::Open);
        view.search.as_mut().unwrap().editor.insert("中文");
        view.refresh_search(false);
        draw(&mut view);
        let anchor = view.anchor.clone().unwrap();
        let count = view.search.as_ref().unwrap().count();
        let saved = view.take_reading();
        assert!(saved.bytes() < 100 * 1024);
        let mut resumed = Transcript::resume(saved);
        assert!(resumed.blocks.is_empty());
        assert!(resumed.text_selection.rows.is_empty());
        // A→B→A before the reopen completes must not erase pending fold state.
        let saved = resumed.take_reading();
        let mut resumed = Transcript::resume(saved);
        resumed.sync(&rows, &[], 0, &i18n, false);
        draw(&mut resumed);
        assert!(
            !resumed.folded(&folded),
            "manual expansion survives the default collapsed prompt"
        );
        assert_eq!(resumed.anchor.as_ref().unwrap().key, anchor.key);
        assert_eq!(resumed.anchor.as_ref().unwrap().source, anchor.source);
        assert_eq!(resumed.search.as_ref().unwrap().count(), count);
        assert_eq!(
            resumed
                .copy_text(selection::CopyMode::Selection, false)
                .unwrap(),
            copied
        );
        assert!(!resumed.following());
        assert!(resumed.selection_wait(std::time::Instant::now()).is_none());
    }
}
