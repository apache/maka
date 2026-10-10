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
//!
//! The same frame's marks place the diff's sticky header (the kit's Diff
//! has none): a copy of the header of the file at the top, at the top of
//! the diff, while that file's own header is above the diff's top, and
//! pushed up by the next file's header as it comes up under it
//! ([`StickyHeader`]). It is placed as the frame is laid out, after the
//! Diff, so it never lags the scroll.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, SharedString, Styled as _, WeakEntity, Window, canvas, point,
    px,
};

use crate::panel::ReviewPanel;

/// How far below the diff's top a header's content may sit and still count
/// as the top: a header scrolled to the top has its border and padding
/// above its content.
const TOP_SLACK_REMS: f32 = 0.75;

/// The kit's header row around the content the panel draws in it
/// (`render_file_header`): 4 px of padding and a hairline above and below.
const HEADER_CHROME_REMS: f32 = 0.25;
const HEADER_HAIRLINE: Pixels = px(1.);

/// Where this frame put the diff's sticky header.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Sticky {
    /// The file at the top of the diff, by its place in the Diff.
    pub(crate) file: usize,
    /// Its own header is above the diff's top, out of view: the copy shows.
    pub(crate) shown: bool,
    /// The top of the next file's header, if it is drawn: the copy's
    /// bottom goes no lower.
    next_top: Option<Pixels>,
}

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
    /// Each drawn header's content, its top and bottom.
    marks: RefCell<Vec<(SharedString, Pixels, Pixels)>>,
    last: Cell<Option<usize>>,
    /// The panel asked for each frame's answer, until it has the one it
    /// waits for (after it scrolled the diff itself).
    eager: Cell<bool>,
    /// The sticky header as this frame placed it.
    sticky: Cell<Option<Sticky>>,
}

impl HeaderMarks {
    /// The content of the header of the file at `path` in the Diff spans
    /// `top` to `bottom`.
    pub(crate) fn mark(&self, path: SharedString, top: Pixels, bottom: Pixels) {
        self.marks.borrow_mut().push((path, top, bottom));
    }

    /// The sticky header as the last frame placed it: the file whose
    /// header the panel draws a copy of.
    pub(crate) fn sticky(&self) -> Option<Sticky> {
        self.sticky.get()
    }

    /// Report every frame's answer, not only a changed one.
    pub(crate) fn set_eager(&self, eager: bool) {
        self.eager.set(eager);
    }

    /// Forgets the file at the top, as the Diff's files changed.
    pub(crate) fn reset(&self) {
        self.last.set(None);
        self.sticky.set(None);
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
                let rem = window.rem_size();
                let slack = rem * TOP_SLACK_REMS;
                let chrome = rem * HEADER_CHROME_REMS + HEADER_HAIRLINE;
                let drawn: Vec<(usize, Pixels, Pixels)> = drawn
                    .into_iter()
                    .filter_map(|(path, top, bottom)| order.get(&path).map(|ix| (*ix, top, bottom)))
                    .collect();
                let headers: Vec<(usize, Pixels)> =
                    drawn.iter().map(|(ix, top, _)| (*ix, *top)).collect();
                let line = bounds.top();
                let found = file_at_top(&headers, line + slack);
                // The sticky header: the file at the top, the one the last
                // frame found while no header is drawn.
                let sticky = found.or(marks.last.get()).map(|file| Sticky {
                    file,
                    shown: drawn
                        .iter()
                        .find(|(ix, _, _)| *ix == file)
                        .is_none_or(|(_, _, bottom)| *bottom + chrome <= line),
                    next_top: drawn
                        .iter()
                        .filter(|(ix, _, _)| *ix > file)
                        .min_by_key(|(ix, _, _)| *ix)
                        .map(|(_, top, _)| *top - chrome),
                });
                let before = marks.sticky.replace(sticky);
                if before.map(|sticky| sticky.file) != sticky.map(|sticky| sticky.file) {
                    // The copy drawn is of another file: draw it again.
                    let panel = panel.clone();
                    cx.defer(move |cx| {
                        panel.update(cx, |_, cx| cx.notify()).ok();
                    });
                }
                let Some(top) = found else { return };
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

/// A probe inside the header of the file at `path`: notes its top and
/// bottom as the frame is laid out. Put it in a `relative` element.
pub(crate) fn header_probe(marks: &Rc<HeaderMarks>, path: SharedString) -> impl IntoElement {
    let marks = marks.clone();
    canvas(
        move |bounds, _, _| marks.mark(path.clone(), bounds.top(), bounds.bottom()),
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The diff's sticky header: `header`, a copy of the header of file `file`
/// laid out at the top of the diff, drawn only while this frame's marks
/// say that file is at the top with its own header out of view, pushed up
/// by the next file's header and clipped to where it rests. Put it after
/// the marks' probe in the diff's column, so the frame's marks are read
/// by the time it is placed.
pub(crate) struct StickyHeader {
    header: AnyElement,
    file: usize,
    marks: Rc<HeaderMarks>,
}

impl StickyHeader {
    pub(crate) fn new(header: impl IntoElement, file: usize, marks: &Rc<HeaderMarks>) -> Self {
        Self { header: header.into_any_element(), file, marks: marks.clone() }
    }
}

impl IntoElement for StickyHeader {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for StickyHeader {
    type RequestLayoutState = ();
    /// Whether the header is drawn this frame.
    type PrepaintState = bool;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.header.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(sticky) =
            self.marks.sticky.get().filter(|sticky| sticky.file == self.file && sticky.shown)
        else {
            return false;
        };
        let lift = sticky.next_top.map_or(px(0.), |next| (next - bounds.bottom()).min(px(0.)));
        if -lift >= bounds.size.height {
            return false;
        }
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            window.with_element_offset(point(px(0.), lift), |window| {
                self.header.prepaint(window, cx);
            });
        });
        true
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        drawn: &mut bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        if *drawn {
            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                self.header.paint(window, cx);
            });
        }
    }
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
