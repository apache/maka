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

//! The text view state of each reply row the transcript lays out.
//!
//! gpui-kit's `TextView::markdown(id, text)` keeps its state in the
//! window's keyed state, which only that element reaches. The find bar
//! must reach it (to paint matches, to reveal one), so the view keeps it
//! here instead: one `TextViewState` per reply row the list lays out, made
//! when the row is first laid out and dropped once a frame passes without
//! it, which is the keyed state's life. Rows out of view hold nothing, as
//! before, and a row's text reaches its state only when the row's string
//! changed (the rows reuse an unchanged string), as the keyed element
//! does.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::time::Instant;

use gpui_kit::base::{RangeHighlight, RenderedText, TextViewState};
use gpui_kit::{
    App, AppContext as _, Entity, Hsla, IntoElement, SharedString, Styled as _, canvas,
};

use super::find::Mark;
use crate::corpus::Field;
use crate::rows::RowKey;

/// The reply rows' text view states, shared with the row renderer.
#[derive(Clone, Default)]
pub(crate) struct TextViews(Rc<Inner>);

#[derive(Default)]
struct Inner {
    /// The frame the transcript is drawing.
    frame: Cell<u64>,
    rows: RefCell<HashMap<RowKey, Row>>,
}

struct Row {
    state: Entity<TextViewState>,
    /// The string last handed to `state`.
    text: SharedString,
    /// The last frame that laid the row out.
    used: u64,
    /// What the highlights were last painted from.
    painted: Option<Painted>,
    /// The highlights the state holds now.
    highlights: Vec<RangeHighlight>,
}

#[derive(PartialEq)]
struct Painted {
    rendered: RenderedText,
    marks: u64,
    fills: (Hsla, Hsla),
}

impl TextViews {
    /// An empty element that starts each frame: place it before the list.
    /// The states of rows the last frame did not lay out are dropped.
    pub(crate) fn frame_probe(&self) -> impl IntoElement {
        let inner = self.0.clone();
        canvas(
            move |_, _, _| {
                let frame = inner.frame.get() + 1;
                inner.frame.set(frame);
                inner.rows.borrow_mut().retain(|_, row| row.used + 1 >= frame);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_0()
    }

    /// The state of reply row `key`, showing `text`: made on first use,
    /// handed the text when it changed.
    pub(crate) fn state(
        &self,
        key: &RowKey,
        text: &SharedString,
        cx: &mut App,
    ) -> Entity<TextViewState> {
        let frame = self.0.frame.get();
        let changed = {
            let mut rows = self.0.rows.borrow_mut();
            match rows.get_mut(key) {
                Some(row) => {
                    row.used = frame;
                    let same = row.text.as_ptr() == text.as_ptr() && row.text.len() == text.len();
                    (!same).then(|| {
                        row.text = text.clone();
                        row.state.clone()
                    })
                }
                None => {
                    let state = cx.new(|cx| TextViewState::markdown(text, cx));
                    let row = Row {
                        state: state.clone(),
                        text: text.clone(),
                        used: frame,
                        painted: None,
                        highlights: Vec::new(),
                    };
                    rows.insert(key.clone(), row);
                    return state;
                }
            }
        };
        if let Some(state) = changed {
            state.update(cx, |state, cx| state.set_text(text, cx));
        }
        self.0.rows.borrow()[key].state.clone()
    }

    /// Paints `marks` (ranges of the row's Markdown source) over reply row
    /// `key`, mapped to the text the view draws: the active one in
    /// `fills.1`, the rest in `fills.0`. Painted again only when the marks,
    /// the fills or the parse they map onto changed. Marks of a source the
    /// view has not parsed yet wait for its parse, which redraws the row.
    pub(crate) fn paint_marks(
        &self,
        key: &RowKey,
        marks: Option<&[Mark]>,
        revision: u64,
        fills: (Hsla, Hsla),
        cx: &mut App,
    ) {
        let Some(state) = self.0.rows.borrow().get(key).map(|row| row.state.clone()) else {
            return;
        };
        let rendered = state.read(cx).rendered_text();
        let painted = Painted { rendered: rendered.clone(), marks: revision, fills };
        {
            let rows = self.0.rows.borrow();
            let Some(row) = rows.get(key) else { return };
            if row.painted.as_ref() == Some(&painted) {
                return;
            }
            if row.painted.is_none() && marks.is_none_or(<[Mark]>::is_empty) {
                // Nothing painted, nothing to paint.
                return;
            }
        }
        let highlights: Vec<RangeHighlight> = marks
            .into_iter()
            .flatten()
            .filter(|mark| mark.field == Field::Body)
            .filter_map(|mark| {
                let range = rendered.range_for_source(mark.range.clone())?;
                Some(RangeHighlight::new(range, if mark.active { fills.1 } else { fills.0 }))
            })
            .collect();
        let set = state.update(cx, |state, cx| {
            if highlights.is_empty() {
                state.clear_range_highlights(cx);
                true
            } else {
                state.set_range_highlights(highlights.clone(), cx).is_ok()
            }
        });
        if let Some(row) = self.0.rows.borrow_mut().get_mut(key) {
            row.painted = Some(painted);
            row.highlights = if set { highlights } else { Vec::new() };
        }
    }

    /// Asks reply row `key` to reveal `source`, a range of its Markdown
    /// source, by the kit's `reveal_range`. Whether the request was taken:
    /// not while the source waits for its parse.
    pub(crate) fn reveal(&self, key: &RowKey, source: Range<usize>, cx: &mut App) -> bool {
        let Some(state) = self.0.rows.borrow().get(key).map(|row| row.state.clone()) else {
            return false;
        };
        let rendered = state.read(cx).rendered_text();
        let Some(range) = rendered.range_for_source(source) else { return false };
        state.update(cx, |state, cx| state.reveal_range(range, cx)).is_ok()
    }

    /// Drops every state: a new session starts over.
    /// The reply rows laid out that hold selected text, with that text.
    pub(crate) fn selected(&self, cx: &App) -> Vec<(RowKey, String)> {
        self.0
            .rows
            .borrow()
            .iter()
            .filter_map(|(key, row)| {
                let text = row.state.read(cx).selected_text();
                (!text.trim().is_empty()).then(|| (key.clone(), text))
            })
            .collect()
    }

    pub(crate) fn clear(&self) {
        self.0.rows.borrow_mut().clear();
    }

    /// The state of reply row `key`, while it is laid out.
    #[cfg(test)]
    pub(crate) fn get(&self, key: &RowKey) -> Option<Entity<TextViewState>> {
        self.0.rows.borrow().get(key).map(|row| row.state.clone())
    }

    /// The highlights reply row `key`'s text view holds, as ranges of the
    /// text it draws and their fills.
    #[cfg(test)]
    pub(crate) fn highlights(&self, key: &RowKey) -> Vec<(Range<usize>, Hsla)> {
        let rows = self.0.rows.borrow();
        let highlights = rows.get(key).map(|row| row.highlights.as_slice()).unwrap_or_default();
        highlights.iter().map(|highlight| (highlight.range(), highlight.background())).collect()
    }

    /// How many reply rows hold a state.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.rows.borrow().len()
    }
}

/// A match to bring into view once its row is laid out: the reply rows
/// hand it to their text view, the other rows to a probe after the text
/// it is in. It lapses after a second, as the kit's reveal does, so it
/// never scrolls long after it was asked for.
#[derive(Clone, Default)]
pub(crate) struct RevealSlot(Rc<RefCell<Option<Reveal>>>);

#[derive(Debug, Clone)]
pub(crate) struct Reveal {
    pub(crate) row: RowKey,
    pub(crate) field: Field,
    pub(crate) range: Range<usize>,
    pub(crate) until: Instant,
}

impl RevealSlot {
    pub(crate) fn set(&self, reveal: Reveal) {
        self.0.replace(Some(reveal));
    }

    pub(crate) fn clear(&self) {
        self.0.replace(None);
    }

    /// The range to reveal in `field` of row `key`, while one waits there
    /// and has not lapsed at `now`.
    pub(crate) fn pending(&self, key: &RowKey, field: Field, now: Instant) -> Option<Range<usize>> {
        let mut slot = self.0.borrow_mut();
        if slot.as_ref().is_some_and(|reveal| reveal.until < now) {
            *slot = None;
        }
        slot.as_ref()
            .filter(|reveal| reveal.row == *key && reveal.field == field)
            .map(|reveal| reveal.range.clone())
    }

    /// The row a reveal waits in, if any.
    #[cfg(test)]
    pub(crate) fn row(&self) -> Option<RowKey> {
        self.0.borrow().as_ref().map(|reveal| reveal.row.clone())
    }
}
