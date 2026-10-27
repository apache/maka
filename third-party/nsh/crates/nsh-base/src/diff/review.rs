//! What a reviewer does in a diff view besides reading: selecting lines on
//! their numbers (a press, a drag with the mouse, a Shift-press), the app's
//! annotations under lines and its control to add one, moving from change
//! to change, the split sides scrolling sideways together, and the text
//! box's width that soft wrap follows.

use nsh_core::prelude::*;

use super::{
    DiffLine, DiffLineRange, DiffSide, DiffViewEvent,
    controller::{Dv, line_at, wrap_columns},
    geometry::Geometry,
    layout::Row,
};

/// A press selecting lines on their numbers, while it lasts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LineDrag {
    /// The side it selects on.
    side: DiffSide,
    /// The line the selection extends from.
    anchor: usize,
    /// The line the pointer is on.
    head: usize,
    /// The press's y in the rows' box less its y in the root view: what
    /// turns the pointer's root position into the rows' while it drags.
    shift: Points,
    /// The vertical scroll offset at the press (the rows move under the
    /// pointer as they scroll).
    scroll: Points,
    /// The pointer moved to another line.
    moved: bool,
    /// A Shift-press: it extends the selection, it presses no number.
    extended: bool,
}

/// A navigation to a change: the view goes on from that change (not from
/// where it is: a change near the end may not reach the top) until the
/// user scrolls away.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Nav {
    /// The change.
    hunk: usize,
    /// Where the view scrolls to.
    y: Points,
    /// The view got there.
    reached: bool,
}

/// What the pointer is over in a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HoverPart {
    /// Its numbers.
    Gutter,
    /// Its text.
    Text,
    /// The app's add control, which keeps its row hovered.
    Control,
}

/// The lines between `a` and `b` of `side`, in order.
pub(crate) fn range(side: DiffSide, a: usize, b: usize) -> DiffLineRange {
    DiffLineRange {
        side,
        start: a.min(b) as u32,
        end: a.max(b) as u32,
    }
}

/// The other side.
fn other(side: DiffSide) -> DiffSide {
    match side {
        DiffSide::Old => DiffSide::New,
        DiffSide::New => DiffSide::Old,
    }
}

/// Each change's rows: its index, the top of its first row and the bottom
/// of its last, in order.
pub(crate) fn hunk_spans(rows: &[Row], geometry: &Geometry) -> Vec<(usize, Points, Points)> {
    let mut out: Vec<(usize, Points, Points)> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let Row::Line {
            hunk: Some(hunk), ..
        } = row
        else {
            continue;
        };
        let bottom = geometry.top(index + 1);
        match out.last_mut() {
            Some(last) if last.0 == *hunk => last.2 = bottom,
            _ => out.push((*hunk, geometry.top(index), bottom)),
        }
    }
    out
}

/// The first change below `y` (a point under it), else the first.
pub(crate) fn next_of(spans: &[(usize, Points, Points)], y: Points) -> Option<usize> {
    spans
        .iter()
        .find(|(_, top, _)| *top > y + px(1.0))
        .or(spans.first())
        .map(|(hunk, ..)| *hunk)
}

/// The last change above `y` (a point over it), else the last.
pub(crate) fn previous_of(spans: &[(usize, Points, Points)], y: Points) -> Option<usize> {
    spans
        .iter()
        .rev()
        .find(|(_, top, _)| *top < y - px(1.0))
        .or(spans.last())
        .map(|(hunk, ..)| *hunk)
}

/// The change at `y`, else the first one that starts between `y` and
/// `y + height`.
pub(crate) fn current_of(
    spans: &[(usize, Points, Points)],
    y: Points,
    height: Points,
) -> Option<usize> {
    spans
        .iter()
        .find(|(_, top, bottom)| *top <= y && y < *bottom)
        .or_else(|| {
            spans
                .iter()
                .find(|(_, top, _)| *top >= y && *top < y + height)
        })
        .map(|(hunk, ..)| *hunk)
}

impl Dv {
    // Line selection.

    /// A press on the gutter at `at` (in the rows' box), `page` in the root
    /// view, over `prefer`'s numbers (`either`: the other side's line when
    /// that side has none there, as unified rows have one). `shift`
    /// extends the selection; `drag`: the mouse may drag on.
    pub(crate) fn line_press(
        &self,
        at: Point<Points>,
        page: Point<Points>,
        prefer: DiffSide,
        either: bool,
        shift: bool,
        drag: bool,
    ) {
        let found = {
            let st = self.st.borrow();
            let row = st.geometry.row_at(at.y);
            // Beside an annotation, under the row's lines, is no line.
            let below = at.y >= st.geometry.top(row) + st.geometry.text_height(row);
            st.rows.get(row).filter(|_| !below).and_then(|r| {
                line_at(r, prefer).map(|line| (prefer, line)).or_else(|| {
                    either
                        .then(|| line_at(r, other(prefer)).map(|l| (other(prefer), l)))
                        .flatten()
                })
            })
        };
        let Some((side, line)) = found else {
            return;
        };
        let anchor = match self.anchor.get() {
            Some((s, a)) if shift && s == side => a,
            _ => line,
        };
        self.anchor.set(Some((side, anchor)));
        self.select(Some(range(side, anchor, line)));
        if drag {
            self.line_drag.set(Some(LineDrag {
                side,
                anchor,
                head: line,
                shift: at.y - page.y,
                scroll: self.scroll_y.get_untracked(),
                moved: false,
                extended: shift,
            }));
        } else if !shift {
            self.line_number_press(side, line);
        }
    }

    /// A press on the number of `side`'s line in `row` without a pointer's
    /// place to read (a tap on the number itself, assistive technologies):
    /// selects that line.
    pub(crate) fn number_press(&self, row: usize, side: DiffSide) {
        let line = {
            let st = self.st.borrow();
            st.rows.get(row).and_then(|r| line_at(r, side))
        };
        let Some(line) = line else {
            return;
        };
        self.anchor.set(Some((side, line)));
        self.select(Some(range(side, line, line)));
        self.line_number_press(side, line);
    }

    /// The pointer moved to `page` (in the root view) while pressed on the
    /// numbers.
    pub(crate) fn line_drag_to(&self, page: Point<Points>) {
        let Some(mut drag) = self.line_drag.get() else {
            return;
        };
        let y = page.y + drag.shift + (self.scroll_y.get_untracked() - drag.scroll);
        let line = {
            let st = self.st.borrow();
            let row = st.geometry.row_at(y);
            st.rows.get(row).and_then(|r| line_at(r, drag.side))
        };
        // Rows without a line of the side (the filler, separators) keep
        // the line the pointer was on.
        let Some(line) = line.filter(|l| *l != drag.head) else {
            return;
        };
        drag.head = line;
        drag.moved = true;
        self.line_drag.set(Some(drag));
        self.select(Some(range(drag.side, drag.anchor, line)));
    }

    /// The press on the numbers ended (`pressed`: where it began, a press
    /// of its number unless it dragged or extended).
    pub(crate) fn line_release(&self, pressed: bool) {
        let Some(drag) = self.line_drag.take() else {
            return;
        };
        if pressed && !drag.moved && !drag.extended {
            self.line_number_press(drag.side, drag.head);
        }
    }

    /// Selects `range`, reporting it when it changed.
    fn select(&self, range: Option<DiffLineRange>) {
        if self.selection.get_untracked() == range {
            return;
        }
        self.selection.set(range);
        self.emit(DiffViewEvent::LineSelectionChange(range));
    }

    /// Other texts: no lines are selected any more (reported), and
    /// navigation starts from the view again.
    pub(crate) fn texts_changed(&self) {
        self.anchor.set(None);
        self.line_drag.set(None);
        self.nav.set(None);
        self.select(None);
    }

    pub(crate) fn set_selected_lines(&self, range: Option<DiffLineRange>) {
        let range = range.and_then(|r| {
            let st = self.st.borrow();
            let side = match r.side {
                DiffSide::Old => &st.old,
                DiffSide::New => &st.new,
            };
            let lines = side.lines() as u32;
            let (start, end) = (r.start.min(r.end), r.start.max(r.end));
            (start < lines).then(|| DiffLineRange {
                side: r.side,
                start,
                end: end.min(lines - 1),
            })
        });
        self.anchor.set(range.map(|r| (r.side, r.start as usize)));
        self.selection.set(range);
    }

    pub(crate) fn selected_text(&self) -> String {
        let Some(range) = self.selection.get_untracked() else {
            return String::new();
        };
        let st = self.st.borrow();
        let side = match range.side {
            DiffSide::Old => &st.old,
            DiffSide::New => &st.new,
        };
        let end = (range.end as usize).min(side.lines().saturating_sub(1));
        (range.start as usize..=end)
            .filter(|line| *line < side.lines())
            .map(|line| side.line(line))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Whether row `row`'s line of `side` (`None`: either side's) is
    /// selected.
    pub(crate) fn row_selected(&self, row: usize, side: Option<DiffSide>) -> bool {
        let Some(selection) = self.selection.get() else {
            return false;
        };
        if side.is_some_and(|s| s != selection.side) {
            return false;
        }
        let st = self.st.borrow();
        st.rows
            .get(row)
            .and_then(|r| line_at(r, selection.side))
            .is_some_and(|l| selection.start as usize <= l && l <= selection.end as usize)
    }

    fn line_number_press(&self, side: DiffSide, line: usize) {
        self.emit(DiffViewEvent::LineNumberPress(DiffLine {
            side,
            line: line as u32,
        }));
    }

    // Hover and the add control.

    /// The pointer came over `part` of row `row`, of `side` (`None`: the
    /// side whose line the row shows, new before old).
    pub(crate) fn hover_in(&self, row: usize, part: HoverPart, side: Option<DiffSide>) {
        {
            let mut keys = self.hover_keys.borrow_mut();
            // Only one row is under the pointer: a row left unreported
            // (it scrolled away) is not.
            keys.retain(|(r, _)| *r == row);
            if !keys.contains(&(row, part)) {
                keys.push((row, part));
            }
        }
        let side = side.or_else(|| {
            let st = self.st.borrow();
            let r = st.rows.get(row)?;
            [DiffSide::New, DiffSide::Old]
                .into_iter()
                .find(|s| line_at(r, *s).is_some())
        });
        let Some(side) = side else {
            return;
        };
        if self.hover.get_untracked() != Some((row, side)) {
            self.hover.set(Some((row, side)));
        }
    }

    /// The pointer left `part` of row `row`. The hover ends a frame later
    /// unless it came over another: it may leave one before it enters the
    /// next.
    pub(crate) fn hover_out(&self, row: usize, part: HoverPart) {
        let empty = {
            let mut keys = self.hover_keys.borrow_mut();
            keys.retain(|key| *key != (row, part));
            keys.is_empty()
        };
        if !empty {
            return;
        }
        let dv = self.clone();
        spawn(async move {
            next_frame().await;
            if dv.hover_keys.borrow().is_empty() && dv.hover.get_untracked().is_some() {
                dv.hover.set(None);
            }
        });
    }

    /// Where the app's add control shows: the row and side, its render
    /// key and the lines it adds to. At the last selected line, for the
    /// selection, and at the hovered line when it is not selected.
    pub(crate) fn add_controls(&self) -> Vec<(usize, DiffSide, &'static str, DiffLineRange)> {
        if self.props.render_add_annotation.get().is_none() {
            return Vec::new();
        }
        self.rev.get();
        let selection = self.selection.get();
        let hover = self.hover.get();
        let st = self.st.borrow();
        let mut out = Vec::new();
        if let Some(selection) = selection
            && let Some(row) = st.row_of(selection.side, selection.end as usize)
        {
            out.push((row, selection.side, "add:selection", selection));
        }
        if let Some((row, side)) = hover
            && let Some(line) = st.rows.get(row).and_then(|r| line_at(r, side))
        {
            let selected = selection.is_some_and(|s| {
                s.side == side && s.start as usize <= line && line <= s.end as usize
            });
            if !selected {
                out.push((row, side, "add:hover", range(side, line, line)));
            }
        }
        out
    }

    // Geometry.

    /// The top of row `row`.
    pub(crate) fn row_top(&self, row: usize) -> Points {
        self.rev.get();
        self.geo.get();
        self.st.borrow().geometry.top(row)
    }

    /// The height of row `row`'s lines.
    pub(crate) fn row_height(&self, row: usize) -> Points {
        self.rev.get();
        self.geo.get();
        self.st.borrow().geometry.text_height(row)
    }

    /// The height of every row.
    pub(crate) fn rows_height(&self) -> Points {
        self.rev.get();
        self.geo.get();
        self.st.borrow().geometry.height()
    }

    /// A side's text box laid out `width` wide: lines wrap again when the
    /// columns that fit changed.
    pub(crate) fn text_box_laid_out(&self, width: Points) {
        {
            let mut st = self.st.borrow_mut();
            if (st.text_box - width).abs() < px(0.5) {
                return;
            }
            st.text_box = width;
            let columns = wrap_columns(self.props.soft_wrap.get_untracked(), width, st.column);
            if columns == st.wrap_columns {
                return;
            }
            st.wrap_columns = columns;
            st.measure_rows();
        }
        // The rows' lines change: their cells too.
        self.rev.update(|r| *r += 1);
    }

    /// Annotation `id` laid out `height` tall: the rows below it move.
    pub(crate) fn annotation_laid_out(&self, id: &SharedString, height: Points) {
        {
            let mut st = self.st.borrow_mut();
            let known = st.annotation_heights.get(id).copied();
            if known.is_some_and(|h| (h - height).abs() < px(0.5)) {
                return;
            }
            st.annotation_heights.insert(id.clone(), height);
            st.place();
        }
        self.geo.update(|g| *g += 1);
    }

    /// The top of annotation `id`, `None` while it does not show.
    pub(crate) fn annotation_top(&self, id: &SharedString) -> Option<Points> {
        self.rev.get();
        self.geo.get();
        let st = self.st.borrow();
        let index = st.annotations.iter().position(|a| a.id == *id)?;
        st.placed.get(index).copied().flatten().map(|(_, top)| top)
    }

    // Scrolling.

    /// Scrolls `y` to the top of the view (as far as the rows go), with
    /// an animation: to change `hunk`, which navigation goes on from.
    pub(crate) fn scroll_to_y(&self, y: Points, hunk: Option<usize>) {
        let max = {
            let st = self.st.borrow();
            (st.geometry.height() - self.viewport.get_untracked().height).max(Points::ZERO)
        };
        let y = y.min(max).max(Points::ZERO);
        self.nav.set(hunk.map(|hunk| Nav {
            hunk,
            y,
            reached: (self.scroll_y.get_untracked() - y).abs() < px(1.0),
        }));
        self.vscroll.scroll_to(point(px(0.0), y), true);
    }

    /// The view scrolled to `y`: a navigation got there, or the user
    /// scrolled away from it (once it got there, or far on the way).
    pub(crate) fn scrolled_to(&self, y: Points) {
        let Some(mut nav) = self.nav.get() else {
            return;
        };
        let off = (nav.y - y).abs();
        if off < px(1.0) {
            nav.reached = true;
            self.nav.set(Some(nav));
        } else if nav.reached || off > self.viewport.get_untracked().height.max(px(1.0)) {
            self.nav.set(None);
        }
    }

    fn spans(&self) -> Vec<(usize, Points, Points)> {
        let st = self.st.borrow();
        hunk_spans(&st.rows, &st.geometry)
    }

    /// The change after (`by` 1) or before (`by` -1) the last one
    /// navigated to, while the view is still there.
    fn nav_from(&self, spans: &[(usize, Points, Points)], by: isize) -> Option<usize> {
        let nav = self.nav.get()?;
        let at = spans.iter().position(|(hunk, ..)| *hunk == nav.hunk)?;
        let len = spans.len() as isize;
        Some(spans[(at as isize + by).rem_euclid(len) as usize].0)
    }

    pub(crate) fn next_hunk(&self) -> Option<usize> {
        let spans = self.spans();
        let hunk = self
            .nav_from(&spans, 1)
            .or_else(|| next_of(&spans, self.scroll_y.get_untracked()))?;
        self.go_to_hunk(hunk);
        Some(hunk)
    }

    pub(crate) fn previous_hunk(&self) -> Option<usize> {
        let spans = self.spans();
        let hunk = self
            .nav_from(&spans, -1)
            .or_else(|| previous_of(&spans, self.scroll_y.get_untracked()))?;
        self.go_to_hunk(hunk);
        Some(hunk)
    }

    pub(crate) fn current_hunk(&self) -> Option<usize> {
        let spans = self.spans();
        self.nav_from(&spans, 0).or_else(|| {
            let height = self.viewport.get_untracked().height;
            current_of(&spans, self.scroll_y.get_untracked(), height)
        })
    }

    /// A split side scrolled sideways to `x`: the other follows.
    pub(crate) fn side_scrolled(&self, side: DiffSide, x: Points) {
        if !self.st.borrow().split || (x - self.hscroll_x.get()).abs() < px(0.5) {
            return;
        }
        self.hscroll_x.set(x);
        let follower = match side {
            DiffSide::Old => self.hscroll[1],
            DiffSide::New => self.hscroll[0],
        };
        follower.scroll_to(point(x, px(0.0)), false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::layout::Kind;

    fn line(old: Option<usize>, new: Option<usize>, hunk: Option<usize>) -> Row {
        let kind = match (old, new, hunk) {
            (_, _, None) => Kind::Context,
            (Some(_), Some(_), _) => Kind::Modified,
            (Some(_), None, _) => Kind::Deleted,
            _ => Kind::Added,
        };
        Row::Line {
            old,
            new,
            kind,
            hunk,
        }
    }

    /// Context, hunk 0 (two rows), context, a separator, hunk 1.
    fn rows() -> Vec<Row> {
        vec![
            line(Some(0), Some(0), None),
            line(Some(1), None, Some(0)),
            line(None, Some(1), Some(0)),
            line(Some(2), Some(2), None),
            Row::Separator {
                gap: 1,
                lines: 10,
                first: false,
                last: false,
                header: None,
            },
            line(Some(13), Some(13), Some(1)),
        ]
    }

    #[test]
    fn ranges_are_in_order() {
        assert_eq!(
            range(DiffSide::Old, 7, 3),
            DiffLineRange {
                side: DiffSide::Old,
                start: 3,
                end: 7
            }
        );
        let rows = rows();
        assert_eq!(line_at(&rows[1], DiffSide::Old), Some(1));
        assert_eq!(line_at(&rows[1], DiffSide::New), None);
        assert_eq!(line_at(&rows[4], DiffSide::New), None);
    }

    #[test]
    fn hunks_span_their_rows() {
        let rows = rows();
        // Row 2 wraps into three lines.
        let geometry = Geometry::new(&[1, 1, 3, 1, 1, 1], &[], px(10.0));
        let spans = hunk_spans(&rows, &geometry);
        assert_eq!(
            spans,
            vec![(0, px(10.0), px(50.0)), (1, px(70.0), px(80.0))]
        );
    }

    #[test]
    fn navigation_moves_from_the_top_of_the_view() {
        let spans = vec![(0, px(10.0), px(50.0)), (1, px(70.0), px(80.0))];
        assert_eq!(next_of(&spans, px(0.0)), Some(0));
        // At a change's top, the next is the one after it.
        assert_eq!(next_of(&spans, px(10.0)), Some(1));
        // After the last, the first.
        assert_eq!(next_of(&spans, px(70.0)), Some(0));
        assert_eq!(previous_of(&spans, px(70.0)), Some(0));
        assert_eq!(previous_of(&spans, px(100.0)), Some(1));
        // Before the first, the last.
        assert_eq!(previous_of(&spans, px(10.0)), Some(1));
        assert_eq!(next_of(&[], px(0.0)), None);
        assert_eq!(previous_of(&[], px(0.0)), None);
    }

    #[test]
    fn the_current_change_is_at_the_top_or_in_view() {
        let spans = vec![(0, px(10.0), px(50.0)), (1, px(70.0), px(80.0))];
        assert_eq!(current_of(&spans, px(20.0), px(100.0)), Some(0));
        assert_eq!(current_of(&spans, px(55.0), px(100.0)), Some(1));
        assert_eq!(current_of(&spans, px(0.0), px(5.0)), None);
        assert_eq!(current_of(&spans, px(90.0), px(100.0)), None);
    }
}
