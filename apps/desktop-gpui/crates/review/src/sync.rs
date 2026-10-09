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

//! Which file the continuous diff shows, for the tree's highlight.
//!
//! The kit's Diff owns its scrolling and says nothing of where it is, but
//! it draws a file's header only while the header is in view, and the
//! panel draws each header's content. So each header carries a probe that
//! notes, as the frame is laid out, where its top is ([`HeaderMarks::mark`]),
//! and a probe after the Diff in its column reads the frame's notes once
//! the Diff is laid out ([`HeaderMarks::probe`]):
//!
//! - the last file whose header is at or above the diff's top is the file
//!   in view (its rows fill the top);
//! - with every drawn header below the top, the file before the first of
//!   them is;
//! - with no header drawn the view is inside one file, the one it was in.
//!
//! Scrolling a view down or up passes every header on the way, so the file
//! in view follows. A jump that lands deep in a long file with no header in
//! view (the scrollbar dragged far, End, `n` into a long file) keeps the
//! last file until a header shows: the Diff gives nothing else to tell.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::{IntoElement, Pixels, SharedString, Styled as _, WeakEntity, canvas};

use crate::panel::ReviewPanel;

/// How far below the diff's top a header's content may sit and still count
/// as the top: a header scrolled to the top has its border and padding
/// above its content.
const TOP_SLACK_REMS: f32 = 0.75;

/// What the panel learns from a frame: the file at the top of the diff,
/// and the files whose headers are in view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InView {
    pub(crate) top: usize,
    pub(crate) headers: Vec<usize>,
}

/// The headers drawn this frame, by their files' paths in the Diff, and
/// the file the last frame found at the top.
#[derive(Debug, Default)]
pub(crate) struct HeaderMarks {
    marks: RefCell<Vec<(SharedString, Pixels)>>,
    last: Cell<Option<usize>>,
    /// The panel asked for each frame's answer, until it has the one it
    /// waits for (after it scrolled the diff itself).
    eager: Cell<bool>,
}

impl HeaderMarks {
    /// The header of the file at `path` in the Diff has its top at `top`.
    pub(crate) fn mark(&self, path: SharedString, top: Pixels) {
        self.marks.borrow_mut().push((path, top));
    }

    /// Report every frame's answer, not only a changed one.
    pub(crate) fn set_eager(&self, eager: bool) {
        self.eager.set(eager);
    }

    /// Forgets the file at the top, as the Diff's files changed.
    pub(crate) fn reset(&self) {
        self.last.set(None);
        self.marks.borrow_mut().clear();
    }

    /// An element filling the diff's column that, laid out after the Diff,
    /// reads the frame's marks and tells `panel` the file in view when it
    /// changes. `order` gives each file's place in the Diff by its path.
    pub(crate) fn probe(
        self: &Rc<Self>,
        order: Rc<HashMap<SharedString, usize>>,
        panel: WeakEntity<ReviewPanel>,
    ) -> impl IntoElement {
        let marks = self.clone();
        canvas(
            move |bounds, window, cx| {
                let drawn = std::mem::take(&mut *marks.marks.borrow_mut());
                let slack = window.rem_size() * TOP_SLACK_REMS;
                let headers: Vec<(usize, Pixels)> = drawn
                    .into_iter()
                    .filter_map(|(path, top)| order.get(&path).map(|ix| (*ix, top)))
                    .collect();
                let Some(top) = file_at_top(&headers, bounds.top() + slack) else { return };
                if marks.last.replace(Some(top)) == Some(top) && !marks.eager.get() {
                    return;
                }
                let view = InView { top, headers: headers.iter().map(|(ix, _)| *ix).collect() };
                let panel = panel.clone();
                cx.defer(move |cx| {
                    panel.update(cx, |panel, cx| panel.follow_diff(&view, cx)).ok();
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// The file whose rows are at the top, `line` down the window, from the
/// headers drawn: the last one at or above the line, else the file before
/// the first one below it; none without a header.
pub(crate) fn file_at_top(headers: &[(usize, Pixels)], line: Pixels) -> Option<usize> {
    let above = headers.iter().filter(|(_, top)| *top <= line).map(|(ix, _)| *ix).max();
    above.or_else(|| headers.iter().map(|(ix, _)| *ix).min().map(|first| first.saturating_sub(1)))
}

/// A probe inside the header of the file at `path`: notes its top as the
/// frame is laid out. Put it in a `relative` element.
pub(crate) fn header_probe(marks: &Rc<HeaderMarks>, path: SharedString) -> impl IntoElement {
    let marks = marks.clone();
    canvas(move |bounds, _, _| marks.mark(path.clone(), bounds.top()), |_, _, _, _| {})
        .absolute()
        .top_0()
        .left_0()
        .size_full()
}

#[cfg(test)]
mod tests {
    use gpui_kit::px;

    use super::*;

    #[test]
    fn the_file_at_the_top_comes_from_the_headers_drawn() {
        let line = px(100.);
        assert_eq!(file_at_top(&[(3, px(90.)), (4, px(300.))], line), Some(3), "at the top");
        assert_eq!(file_at_top(&[(2, px(-40.)), (3, px(60.))], line), Some(3), "the last above");
        assert_eq!(file_at_top(&[(4, px(300.)), (5, px(500.))], line), Some(3), "before the first");
        assert_eq!(file_at_top(&[(0, px(100.))], line), Some(0));
        assert_eq!(file_at_top(&[], line), None, "none drawn: unknown");
    }
}
