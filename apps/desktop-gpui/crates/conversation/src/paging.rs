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

//! Keyboard paging of the transcript: PageUp and PageDown by most of the
//! visible height, with pixel precision.
//!
//! `MessageScrollerState` scrolls only to a row (`scroll_to_item`) or to the
//! end, but a page is a distance, and a long reply is taller than the window.
//! GPUI's autoscroll supplies the precision instead: an element inside a
//! `list` may, during prepaint, ask for a rectangle to be revealed
//! (`Window::request_autoscroll`), and the list scrolls exactly as far as
//! that takes (`prepaint_items` in GPUI's `elements/list.rs`).
//!
//! A page takes two steps. On the key press, [`Paging::plan`] reads the
//! geometry of the last painted frame and names an [`Anchor`]: the content
//! point that should end up on the list's top line, as an offset from an edge
//! of a row the next frame is sure to paint. The view then scrolls that row to
//! the top with `scroll_to_item` (which also pauses tail following, so the
//! list does not snap back to the end) and hands the anchor over. In the next
//! frame that row's prepaint asks for the rectangle that starts at the anchor
//! and is one list height tall; the list moves its top to the top line, or
//! walks back into earlier rows when it lies above them.
//!
//! Geometry is recorded in paint, which runs once per frame on the final
//! layout, so the second layout pass an autoscroll causes never leaves stale
//! rows behind. It describes one frame only and is replaced by the next.

use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::rc::Rc;

use gpui_kit::{
    App, Bounds, IntoElement, Pixels, Styled as _, Window, canvas, point, px, rems, size,
};

use crate::rows::RowKey;

/// The share of the visible height one page moves; the rest stays on screen
/// as context.
const PAGE_FRACTION: f32 = 0.875;

/// `MessageScroller` pads its list with `py_2` (0.5 rem) at the top and the
/// bottom; the row at the scroll position starts below the top padding.
const LIST_PADDING_REMS: f32 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PageDirection {
    Up,
    Down,
}

/// The content point that should end up on the list's top line, relative to
/// a row: `offset` from the row's top edge, or from its bottom edge.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Anchor {
    pub(crate) key: RowKey,
    pub(crate) from_bottom: bool,
    pub(crate) offset: Pixels,
}

/// One page: the row to scroll to the top first, then the anchor to reveal.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PagePlan {
    pub(crate) scroll_to: usize,
    pub(crate) anchor: Anchor,
}

/// The transcript's paging state, shared with the probes placed in the
/// rendered tree. Clones share it.
#[derive(Clone, Default)]
pub(crate) struct Paging(Rc<PagingState>);

#[derive(Default)]
struct PagingState {
    /// The list's bounds and top padding in the current frame.
    viewport: Cell<Option<(Bounds<Pixels>, Pixels)>>,
    /// Rows painted inside the viewport in the last frame, top to bottom.
    rows: RefCell<Vec<(RowKey, Bounds<Pixels>)>>,
    /// Handed over by a key press, armed by the next frame.
    requested: RefCell<Option<Anchor>>,
    /// Waiting for its row's prepaint in this frame.
    armed: RefCell<Option<Anchor>>,
    /// Runs once, deferred, when the older-history row is painted inside the
    /// viewport: reaching the top loads older messages.
    on_history_visible: RefCell<Option<Deferred>>,
    /// Runs once, deferred, when one of these rows is painted inside the
    /// viewport: the place of a card that waits for older history.
    on_rows_visible: RefCell<Option<(HashSet<RowKey>, Deferred)>>,
}

/// Work a paint callback hands to the next effect cycle.
type Deferred = Box<dyn FnOnce(&mut App)>;

impl Paging {
    /// Plans a page from the last painted frame. `index_of` maps a row to its
    /// current position in the list and `key_at` the reverse. `None` when
    /// nothing is painted yet.
    pub(crate) fn plan(
        &self,
        direction: PageDirection,
        index_of: impl Fn(&RowKey) -> Option<usize>,
        key_at: impl Fn(usize) -> Option<RowKey>,
    ) -> Option<PagePlan> {
        let (viewport, padding) = self.0.viewport.get()?;
        plan(direction, viewport, padding, &self.0.rows.borrow(), index_of, key_at)
    }

    /// Hands `anchor` to the next frame, replacing any page not shown yet.
    pub(crate) fn request(&self, anchor: Anchor) {
        self.0.requested.replace(Some(anchor));
    }

    /// Drops a page not shown yet, for a command that scrolls on its own.
    pub(crate) fn cancel(&self) {
        self.0.requested.replace(None);
        self.0.armed.replace(None);
    }

    /// Where the topmost painted row that `skip` does not reject sits: an
    /// anchor that keeps it on screen where it is. A view that inserts rows
    /// above it scrolls that row to the top and hands this over, so the
    /// viewport does not move. `None` when nothing is painted yet.
    pub(crate) fn top_anchor(&self, skip: impl Fn(&RowKey) -> bool) -> Option<Anchor> {
        let (viewport, padding) = self.0.viewport.get()?;
        let rows = self.0.rows.borrow();
        let (key, bounds) =
            rows.iter().filter(|(key, _)| !skip(key)).min_by(|a, b| by_top(a, b))?;
        Some(Anchor {
            key: key.clone(),
            from_bottom: false,
            offset: viewport.top() + padding - bounds.top(),
        })
    }

    /// Whether row `key` was painted inside the viewport in the last frame.
    pub(crate) fn is_painted(&self, key: &RowKey) -> bool {
        self.0.rows.borrow().iter().any(|(painted, _)| painted == key)
    }

    /// The topmost row painted inside the viewport in the last frame.
    pub(crate) fn top_painted_row(&self) -> Option<RowKey> {
        let rows = self.0.rows.borrow();
        rows.iter().min_by(|a, b| by_top(a, b)).map(|(key, _)| key.clone())
    }

    /// Runs `action` (deferred, once) the next time the older-history row
    /// is painted inside the viewport, replacing an earlier one.
    pub(crate) fn when_history_visible(&self, action: impl FnOnce(&mut App) + 'static) {
        self.0.on_history_visible.replace(Some(Box::new(action)));
    }

    /// Drops the action [`Self::when_history_visible`] set.
    pub(crate) fn forget_history_visible(&self) {
        self.0.on_history_visible.replace(None);
    }

    /// Runs `action` (deferred, once) the next time one of `keys` is
    /// painted inside the viewport, replacing an earlier one.
    pub(crate) fn when_any_visible(
        &self,
        keys: HashSet<RowKey>,
        action: impl FnOnce(&mut App) + 'static,
    ) {
        self.0.on_rows_visible.replace(Some((keys, Box::new(action))));
    }

    /// Drops the action [`Self::when_any_visible`] set.
    pub(crate) fn forget_any_visible(&self) {
        self.0.on_rows_visible.replace(None);
    }

    /// An empty element that covers the list's viewport. Place it before the
    /// list among its siblings, so it prepaints and paints before any row.
    pub(crate) fn viewport_probe(&self) -> impl IntoElement {
        let (prepaint, paint) = (self.0.clone(), self.0.clone());
        canvas(
            move |bounds, window, _| {
                let padding = rems(LIST_PADDING_REMS).to_pixels(window.rem_size());
                prepaint.viewport.set(Some((bounds, padding)));
                let requested = prepaint.requested.take();
                prepaint.armed.replace(requested);
            },
            move |_, _, _, _| paint.rows.borrow_mut().clear(),
        )
        .absolute()
        .inset_0()
    }

    /// An empty element that covers row `key`. It records where the row was
    /// painted and, when a page is anchored on it, asks the list to scroll.
    pub(crate) fn row_probe(&self, key: RowKey) -> impl IntoElement {
        let (prepaint, paint) = (self.0.clone(), self.0.clone());
        let painted_key = key.clone();
        canvas(
            move |bounds, window, _| prepaint.row_prepainted(&key, bounds, window),
            move |bounds, _, _, cx| {
                let visible = paint.viewport.get().is_some_and(|(v, _)| v.intersects(&bounds));
                if !visible {
                    return;
                }
                if painted_key == RowKey::History
                    && let Some(action) = paint.on_history_visible.borrow_mut().take()
                {
                    // Paint must not change state; the action runs after
                    // this frame.
                    cx.defer(action);
                }
                let watched = paint
                    .on_rows_visible
                    .borrow()
                    .as_ref()
                    .is_some_and(|(keys, _)| keys.contains(&painted_key));
                if watched && let Some((_, action)) = paint.on_rows_visible.borrow_mut().take() {
                    cx.defer(action);
                }
                paint.rows.borrow_mut().push((painted_key, bounds));
            },
        )
        .absolute()
        .inset_0()
    }
}

impl PagingState {
    fn row_prepainted(&self, key: &RowKey, bounds: Bounds<Pixels>, window: &mut Window) {
        let anchor = {
            let mut armed = self.armed.borrow_mut();
            if armed.as_ref().is_none_or(|anchor| &anchor.key != key) {
                return;
            }
            armed.take()
        };
        let (Some(anchor), Some((viewport, padding))) = (anchor, self.viewport.get()) else {
            return;
        };
        let edge = if anchor.from_bottom { bounds.bottom() } else { bounds.top() };
        // One list height from the anchor: the list scrolls up when its top
        // is above the viewport, and down when its bottom is below.
        let height = (viewport.size.height - padding * 2.).max(px(1.));
        window.request_autoscroll(Bounds::new(
            point(bounds.left(), edge + anchor.offset),
            size(bounds.size.width, height),
        ));
    }
}

/// PageDown anchors on the painted row that holds the point one page below
/// the top line. PageUp anchors one page above the top line, measured from
/// the topmost painted row; the row before it is scrolled to the top so that
/// the position really changes (tail following resumes when a layout ends at
/// the bottom), and the anchor is taken from that row's bottom edge, which is
/// where the topmost row starts.
fn plan(
    direction: PageDirection,
    viewport: Bounds<Pixels>,
    padding: Pixels,
    rows: &[(RowKey, Bounds<Pixels>)],
    index_of: impl Fn(&RowKey) -> Option<usize>,
    key_at: impl Fn(usize) -> Option<RowKey>,
) -> Option<PagePlan> {
    let top_line = viewport.top() + padding;
    let page = viewport.size.height * PAGE_FRACTION;
    match direction {
        PageDirection::Down => {
            let target = top_line + page;
            let (key, bounds) = rows
                .iter()
                .filter(|(_, bounds)| bounds.top() <= target)
                .max_by(|a, b| by_top(a, b))?;
            Some(PagePlan {
                scroll_to: index_of(key)?,
                anchor: Anchor {
                    key: key.clone(),
                    from_bottom: false,
                    offset: target - bounds.top(),
                },
            })
        }
        PageDirection::Up => {
            let target = top_line - page;
            let (key, bounds) = rows.iter().min_by(|a, b| by_top(a, b))?;
            let offset = target - bounds.top();
            match index_of(key)? {
                0 => Some(PagePlan {
                    scroll_to: 0,
                    anchor: Anchor { key: key.clone(), from_bottom: false, offset },
                }),
                ix => Some(PagePlan {
                    scroll_to: ix - 1,
                    anchor: Anchor { key: key_at(ix - 1)?, from_bottom: true, offset },
                }),
            }
        }
    }
}

fn by_top(a: &(RowKey, Bounds<Pixels>), b: &(RowKey, Bounds<Pixels>)) -> Ordering {
    a.1.top().partial_cmp(&b.1.top()).unwrap_or(Ordering::Equal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use transcript_model::ItemKey;

    fn key(id: &str) -> RowKey {
        RowKey::Item { turn_id: "t".into(), key: ItemKey::Text(id.into()) }
    }

    fn row(id: &str, top: f32, height: f32) -> (RowKey, Bounds<Pixels>) {
        (key(id), Bounds::new(point(px(0.), px(top)), size(px(100.), px(height))))
    }

    /// Rows `a` (index 4) through `c`, painted in an 800 px viewport with
    /// 8 px list padding.
    fn plan_for(direction: PageDirection, rows: &[(RowKey, Bounds<Pixels>)]) -> Option<PagePlan> {
        let ids = ["z", "y", "x", "w", "a", "b", "c"];
        let viewport = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(800.)));
        plan(
            direction,
            viewport,
            px(8.),
            rows,
            |row| ids.iter().position(|id| &key(id) == row),
            |ix| ids.get(ix).map(|id| key(id)),
        )
    }

    #[test]
    fn page_down_anchors_inside_the_row_one_page_below_the_top_line() {
        let rows = [row("a", -40., 300.), row("b", 260., 500.), row("c", 760., 400.)];
        // 8 + 700 = 708 lies in `b`, 448 px below its top.
        assert_eq!(
            plan_for(PageDirection::Down, &rows),
            Some(PagePlan {
                scroll_to: 5,
                anchor: Anchor { key: key("b"), from_bottom: false, offset: px(448.) },
            })
        );
    }

    #[test]
    fn page_down_inside_a_row_taller_than_the_viewport_stays_in_it() {
        let rows = [row("a", -2000., 5000.)];
        assert_eq!(
            plan_for(PageDirection::Down, &rows),
            Some(PagePlan {
                scroll_to: 4,
                anchor: Anchor { key: key("a"), from_bottom: false, offset: px(2708.) },
            })
        );
    }

    #[test]
    fn page_up_measures_from_the_top_row_and_scrolls_the_row_before_it() {
        let rows = [row("a", -40., 300.), row("b", 260., 500.)];
        // 8 - 700 = -692 lies 652 px above `a`, which starts where `w` ends.
        assert_eq!(
            plan_for(PageDirection::Up, &rows),
            Some(PagePlan {
                scroll_to: 3,
                anchor: Anchor { key: key("w"), from_bottom: true, offset: px(-652.) },
            })
        );
    }

    #[test]
    fn page_up_from_the_first_row_anchors_on_its_top() {
        let rows = [row("z", -1000., 3000.)];
        assert_eq!(
            plan_for(PageDirection::Up, &rows),
            Some(PagePlan {
                scroll_to: 0,
                anchor: Anchor { key: key("z"), from_bottom: false, offset: px(308.) },
            })
        );
    }

    #[test]
    fn nothing_painted_plans_nothing() {
        assert_eq!(plan_for(PageDirection::Down, &[]), None);
        assert_eq!(plan_for(PageDirection::Up, &[]), None);
    }
}
