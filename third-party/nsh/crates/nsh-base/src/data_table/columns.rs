//! The columns' layout: their order (fixed columns first), widths and the
//! prefix sums that find a column at a position and the columns in a range
//! in time that does not depend on their number.
//!
//! Columns are named two ways: by *definition* index, their position in the
//! app's `columns` (stable while columns move), and by *display* index, their
//! place now (what the sums are over). The display order is in three zones:
//! the columns fixed at the start, the scrolling ones, the columns fixed at
//! the end. Fixed columns stay where the scrolling columns pass under them;
//! those at the end stand right after the scrolling columns while these fit,
//! at the end of the view once they overflow it (as CSS's `sticky`).
//!
//! A column's *base* width is its spec's, or what a drag, a fit or the app
//! set since. The width it shows is the base plus its share of the room the
//! columns leave free in the view ([`Spec::grow`], as CSS's `flex-grow`),
//! until the user or the app sets its width: from then on it keeps that one.

use std::ops::Range;

use super::ColumnFixed;

/// What the layout needs of a column.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Spec {
    /// The width it starts at.
    pub(crate) width: f32,
    pub(crate) min: f32,
    pub(crate) max: f32,
    /// Where it stays while the others scroll.
    pub(crate) fixed: ColumnFixed,
    /// Its share of the room the columns leave free (0: none).
    pub(crate) grow: f32,
}

/// The zone of a column with `fixed`, in display order.
fn zone(fixed: ColumnFixed) -> u8 {
    match fixed {
        ColumnFixed::Left => 0,
        ColumnFixed::None => 1,
        ColumnFixed::Right => 2,
    }
}

/// The layout of a table's columns.
#[derive(Debug, Clone, Default)]
pub(crate) struct Columns {
    specs: Vec<Spec>,
    /// The widths shown, by definition index: the bases and what they grow.
    widths: Vec<f32>,
    /// The base widths, by definition index.
    bases: Vec<f32>,
    /// The columns whose width the user or the app set, by definition
    /// index: they no longer grow.
    settled: Vec<bool>,
    /// The columns fitted to their content once (`autoFit`), by definition
    /// index.
    fitted: Vec<bool>,
    /// The width the columns are shown in, which those that grow fill.
    room: f64,
    /// Definition indexes in display order.
    order: Vec<usize>,
    /// Display indexes by definition index.
    shown: Vec<usize>,
    /// Where each display index starts (and the total at the end), in the
    /// whole table's coordinates: `starts.len() == len + 1`.
    starts: Vec<f64>,
    /// How many columns fixed at the start lead the order.
    fixed: usize,
    /// How many columns fixed at the end close it.
    end: usize,
}

impl Columns {
    /// The layout of `specs` in their order, the fixed ones moved to their
    /// ends (keeping their order among themselves).
    pub(crate) fn new(specs: Vec<Spec>) -> Columns {
        let widths: Vec<f32> = specs.iter().map(|s| clamp(s, s.width)).collect();
        let n = specs.len();
        let mut order: Vec<usize> = (0..specs.len()).collect();
        crate::sort::sort_by_key(&mut order, |&i| zone(specs[i].fixed));
        let count = |f| specs.iter().filter(|s| s.fixed == f).count();
        let (fixed, end) = (count(ColumnFixed::Left), count(ColumnFixed::Right));
        let mut columns = Columns {
            specs,
            bases: widths.clone(),
            widths,
            settled: vec![false; n],
            fitted: vec![false; n],
            room: 0.0,
            order,
            shown: Vec::new(),
            starts: Vec::new(),
            fixed,
            end,
        };
        columns.reindex();
        columns.rebuild(0);
        columns
    }

    /// The same columns with new specs, keeping the widths the user set and
    /// the order they moved to for the columns that stay (matched by
    /// `same`: a definition of the new specs and the old index it is, if
    /// any).
    pub(crate) fn updated(
        &self,
        specs: Vec<Spec>,
        old_of: impl Fn(usize) -> Option<usize>,
    ) -> Columns {
        let mut next = Columns::new(specs);
        next.room = self.room;
        for (new, spec) in next.specs.clone().iter().enumerate() {
            if let Some(old) = old_of(new).filter(|&old| old < self.bases.len()) {
                next.fitted[new] = self.fitted[old];
                // A width the user dragged survives; a width the app changed
                // (its own spec differs) wins.
                if self.specs[old].width == spec.width {
                    next.bases[new] = clamp(spec, self.bases[old]);
                    next.settled[new] = self.settled[old];
                }
            }
        }
        // The order the user moved columns to, among those still there.
        let mut position = vec![usize::MAX; next.specs.len()];
        for (new, at) in position.iter_mut().enumerate() {
            if let Some(old) = old_of(new).filter(|&old| old < self.shown.len()) {
                *at = self.shown[old];
            }
        }
        crate::sort::sort_by_key(&mut next.order, |&n| {
            (zone(next.specs[n].fixed), position[n], n)
        });
        next.reindex();
        next.grow();
        next.rebuild(0);
        next
    }

    fn reindex(&mut self) {
        self.shown.resize(self.order.len(), 0);
        for (display, &def) in self.order.iter().enumerate() {
            self.shown[def] = display;
        }
    }

    fn rebuild(&mut self, from: usize) {
        self.starts.resize(self.order.len() + 1, 0.0);
        let mut x = if from == 0 { 0.0 } else { self.starts[from] };
        for display in from..self.order.len() {
            self.starts[display] = x;
            x += self.widths[self.order[display]] as f64;
        }
        let last = self.order.len();
        self.starts[last] = x;
    }

    pub(crate) fn len(&self) -> usize {
        self.order.len()
    }

    /// How many columns are fixed at the start.
    pub(crate) fn fixed_len(&self) -> usize {
        self.fixed
    }

    /// How many columns are fixed at the end.
    pub(crate) fn end_len(&self) -> usize {
        self.end
    }

    /// The display index of the first column fixed at the end (the number
    /// of columns when none is).
    pub(crate) fn end_start(&self) -> usize {
        self.order.len() - self.end
    }

    /// The definition index of the column shown at `display`.
    pub(crate) fn def(&self, display: usize) -> usize {
        self.order[display]
    }

    /// Where definition `def` is shown.
    pub(crate) fn display_of(&self, def: usize) -> Option<usize> {
        self.shown.get(def).copied()
    }

    /// The definition indexes in display order.
    pub(crate) fn order(&self) -> &[usize] {
        &self.order
    }

    /// The width of definition `def`.
    pub(crate) fn width(&self, def: usize) -> f32 {
        self.widths[def]
    }

    /// The widths by definition index.
    pub(crate) fn widths(&self) -> &[f32] {
        &self.widths
    }

    /// Where the column at `display` starts, in the whole table.
    pub(crate) fn start(&self, display: usize) -> f64 {
        self.starts[display]
    }

    /// The width of the column at `display`.
    pub(crate) fn display_width(&self, display: usize) -> f32 {
        self.widths[self.order[display]]
    }

    /// The width of all columns.
    pub(crate) fn total(&self) -> f64 {
        self.starts[self.order.len()]
    }

    /// The width of the fixed columns.
    pub(crate) fn fixed_width(&self) -> f64 {
        self.starts[self.fixed]
    }

    /// The width of the columns fixed at the end.
    pub(crate) fn end_width(&self) -> f64 {
        self.total() - self.starts[self.end_start()]
    }

    /// The width the scrolling columns take.
    pub(crate) fn scroll_width(&self) -> f64 {
        self.total() - self.fixed_width() - self.end_width()
    }

    /// Where the columns fixed at the end stand in a view `view` wide,
    /// scrolled by `scroll_x`, from the start of the columns: right after
    /// the scrolling columns while they fit, at the view's end once they
    /// overflow it.
    pub(crate) fn end_left(&self, view: f64, scroll_x: f64) -> f64 {
        let fixed = self.fixed_width();
        fixed + (self.scroll_width() - scroll_x).min(view - fixed - self.end_width())
    }

    /// The column at `x` of the table's coordinates (from the columns'
    /// start) in a view `view` wide when scrolled by `scroll_x` (content
    /// points); `None` past the columns.
    pub(crate) fn display_at(&self, x: f64, scroll_x: f64, view: f64) -> Option<usize> {
        if x < 0.0 {
            return None;
        }
        let n = self.order.len();
        let end_left = self.end_left(view, scroll_x);
        let table_x = if x < self.fixed_width() {
            x
        } else if self.end > 0 && x >= end_left {
            self.starts[self.end_start()] + (x - end_left)
        } else {
            let table_x = x + scroll_x;
            // Past the scrolling columns, where those at the end are not.
            if table_x >= self.starts[self.end_start()] {
                return None;
            }
            table_x
        };
        if table_x >= self.total() {
            return None;
        }
        // The last start at or before `table_x`.
        let at = self.starts[..n].partition_point(|&s| s <= table_x);
        at.checked_sub(1)
    }

    /// The column at `x` of the whole table's coordinates (the scrolling
    /// columns at their unscrolled places); `None` past the columns.
    pub(crate) fn display_at_table(&self, x: f64) -> Option<usize> {
        if x < 0.0 || x >= self.total() {
            return None;
        }
        let at = self.starts[..self.order.len()].partition_point(|&s| s <= x);
        at.checked_sub(1)
    }

    /// The scrolling columns (display indexes, between the fixed ones)
    /// that intersect the content span `from..to`, which is in the whole
    /// table's coordinates (the viewport's start is `scroll_x +
    /// fixed_width`).
    pub(crate) fn visible(&self, from: f64, to: f64) -> Range<usize> {
        let n = self.end_start();
        if self.fixed >= n || to <= from || from >= self.starts[n] {
            return n..n;
        }
        let first = self.starts[..n]
            .partition_point(|&s| s <= from)
            .saturating_sub(1)
            .max(self.fixed);
        let end = self.starts[..n].partition_point(|&s| s < to).max(first);
        first..end.min(n)
    }

    /// Sets definition `def`'s width (clamped to its limits), which it then
    /// keeps instead of growing; whether a width shown changed.
    pub(crate) fn set_width(&mut self, def: usize, width: f32) -> bool {
        self.settled[def] = true;
        self.set_base(def, width)
    }

    /// Sets definition `def`'s base width (clamped to its limits), which it
    /// still grows from; whether a width shown changed.
    pub(crate) fn set_base(&mut self, def: usize, width: f32) -> bool {
        self.bases[def] = clamp(&self.specs[def], width);
        self.relayout()
    }

    /// Sets the width the columns are shown in; whether a width shown
    /// changed.
    pub(crate) fn set_room(&mut self, room: f64) -> bool {
        if self.room == room {
            return false;
        }
        self.room = room;
        self.relayout()
    }

    /// Whether definition `def` was fitted to its content once.
    pub(crate) fn fitted(&self, def: usize) -> bool {
        self.fitted[def]
    }

    /// Notes that definition `def` was fitted to its content once.
    pub(crate) fn mark_fitted(&mut self, def: usize) {
        self.fitted[def] = true;
    }

    /// The widths shown again from the bases and the room; whether one
    /// changed.
    fn relayout(&mut self) -> bool {
        let before = std::mem::take(&mut self.widths);
        self.grow();
        if before == self.widths {
            return false;
        }
        self.rebuild(0);
        true
    }

    /// The widths shown: the bases, and while they leave room free, the
    /// columns that grow share it by their `grow`, each up to its `max`
    /// (what one cannot take goes to the others). Shares are whole points,
    /// the last column that grows taking what rounding leaves, so the
    /// columns fill the room exactly.
    fn grow(&mut self) {
        self.widths.clone_from(&self.bases);
        let total: f64 = self.bases.iter().map(|&w| w as f64).sum();
        let mut free = (self.room - total).floor();
        let mut growing: Vec<usize> = (0..self.specs.len())
            .filter(|&i| self.specs[i].grow > 0.0 && !self.settled[i])
            .collect();
        while free >= 1.0 && !growing.is_empty() {
            let weight: f64 = growing.iter().map(|&i| self.specs[i].grow as f64).sum();
            // A column its share would take past its `max` takes up to it,
            // and the others share the rest.
            let capped = growing.iter().position(|&i| {
                let share = free * self.specs[i].grow as f64 / weight;
                self.widths[i] as f64 + share > self.specs[i].max as f64
            });
            if let Some(at) = capped {
                let i = growing.remove(at);
                let max = self.specs[i].max.max(self.specs[i].min);
                free -= (max - self.widths[i]) as f64;
                self.widths[i] = max;
                continue;
            }
            let last = growing.len() - 1;
            let mut given = 0.0;
            for (k, &i) in growing.iter().enumerate() {
                let share = if k == last {
                    free - given
                } else {
                    (free * self.specs[i].grow as f64 / weight).floor()
                };
                self.widths[i] += share as f32;
                given += share;
            }
            break;
        }
    }

    /// Whether the column at `display` is fixed (at either side): it never
    /// scrolls out of view.
    pub(crate) fn is_fixed(&self, display: usize) -> bool {
        display < self.fixed || display >= self.end_start()
    }

    /// The display indexes of the zone the column at `display` is in: the
    /// columns fixed at its side, or the scrolling ones.
    pub(crate) fn zone_of(&self, display: usize) -> Range<usize> {
        let end = self.end_start();
        if display < self.fixed {
            0..self.fixed
        } else if display >= end {
            end..self.order.len()
        } else {
            self.fixed..end
        }
    }

    /// Moves the column at display index `from` to `to`, within its zone
    /// (fixed columns among those fixed at their side, the others among
    /// theirs); whether it moved.
    pub(crate) fn move_to(&mut self, from: usize, to: usize) -> bool {
        let n = self.order.len();
        if from >= n || to >= n || from == to {
            return false;
        }
        if !self.zone_of(from).contains(&to) {
            return false;
        }
        let def = self.order.remove(from);
        self.order.insert(to, def);
        self.reindex();
        self.rebuild(from.min(to));
        true
    }
}

fn clamp(spec: &Spec, width: f32) -> f32 {
    let max = spec.max.max(spec.min);
    width.clamp(spec.min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(width: f32, fixed: impl Into<ColumnFixed>) -> Spec {
        Spec {
            width,
            min: 20.0,
            max: 400.0,
            fixed: fixed.into(),
            grow: 0.0,
        }
    }

    fn growing(width: f32, grow: f32) -> Spec {
        Spec {
            grow,
            ..spec(width, false)
        }
    }

    #[test]
    fn growing_columns_share_the_free_room_by_their_grow() {
        // a(100) b(50, grow 1) c(50, grow 3) in 400: 200 free, b takes a
        // quarter, c the rest.
        let mut c = Columns::new(vec![
            spec(100.0, false),
            growing(50.0, 1.0),
            growing(50.0, 3.0),
        ]);
        assert_eq!(c.widths(), [100.0, 50.0, 50.0], "no room yet");
        assert!(c.set_room(400.0));
        assert_eq!(c.widths(), [100.0, 100.0, 200.0]);
        assert_eq!(c.total(), 400.0);
        assert!(!c.set_room(400.0));
        // Narrower than the columns: nothing grows (the table scrolls).
        assert!(c.set_room(150.0));
        assert_eq!(c.widths(), [100.0, 50.0, 50.0]);
    }

    #[test]
    fn growing_columns_fill_the_room_in_whole_points() {
        let mut c = Columns::new(vec![
            growing(10.0, 1.0),
            growing(10.0, 1.0),
            growing(10.0, 1.0),
        ]);
        c.set_room(130.5);
        assert_eq!(c.widths(), [43.0, 43.0, 44.0]);
    }

    #[test]
    fn a_growing_column_stops_at_its_max_and_the_others_take_the_rest() {
        // 1500 free: a stops at its max (400), b takes the other 1200.
        let mut c = Columns::new(vec![growing(100.0, 1.0), growing(100.0, 1.0)]);
        c.specs[1].max = 2000.0;
        c.set_room(1700.0);
        assert_eq!(c.widths(), [400.0, 1300.0]);
    }

    #[test]
    fn a_column_the_user_sizes_stops_growing() {
        let mut c = Columns::new(vec![growing(100.0, 1.0), growing(100.0, 1.0)]);
        c.set_room(400.0);
        assert_eq!(c.widths(), [200.0, 200.0]);
        // Dragged to 150: it keeps 150, the other takes the room left.
        assert!(c.set_width(0, 150.0));
        assert_eq!(c.widths(), [150.0, 250.0]);
        c.set_room(500.0);
        assert_eq!(c.widths(), [150.0, 350.0]);
    }

    #[test]
    fn a_fitted_base_still_grows() {
        let mut c = Columns::new(vec![growing(100.0, 1.0), spec(100.0, false)]);
        c.set_room(500.0);
        assert_eq!(c.widths(), [400.0, 100.0]);
        // Fitted to 180, it still fills the room: what it shows is the same.
        assert!(!c.set_base(0, 180.0));
        assert_eq!(c.widths(), [400.0, 100.0]);
        // Narrower than the columns, it shows its base.
        assert!(c.set_room(250.0));
        assert_eq!(c.widths(), [180.0, 100.0]);
    }

    #[test]
    fn an_update_keeps_the_room_what_was_fitted_and_what_was_sized() {
        let mut c = Columns::new(vec![growing(100.0, 1.0), growing(100.0, 1.0)]);
        c.set_room(400.0);
        c.set_width(0, 150.0);
        c.mark_fitted(1);
        let next = c.updated(vec![growing(100.0, 1.0), growing(100.0, 1.0)], Some);
        assert_eq!(next.widths(), [150.0, 250.0]);
        assert!(next.fitted(1) && !next.fitted(0));
        // A width the app changes grows again from there.
        let next = c.updated(vec![growing(120.0, 1.0), growing(100.0, 1.0)], Some);
        assert_eq!(next.widths(), [210.0, 190.0]);
    }

    /// a(100) B(60, start) c(80) D(50, end) e(120): B leads, D closes.
    fn ended() -> Columns {
        Columns::new(vec![
            spec(100.0, false),
            spec(60.0, true),
            spec(80.0, false),
            spec(50.0, ColumnFixed::Right),
            spec(120.0, false),
        ])
    }

    #[test]
    fn columns_fixed_at_the_end_close_the_order() {
        let c = ended();
        assert_eq!(c.order(), [1, 0, 2, 4, 3]);
        assert_eq!((c.fixed_len(), c.end_len(), c.end_start()), (1, 1, 4));
        assert_eq!(c.end_width(), 50.0);
        assert_eq!(c.scroll_width(), 300.0);
        assert_eq!(c.zone_of(4), 4..5);
        assert_eq!(c.zone_of(2), 1..4);
        // Scrolling columns only.
        assert_eq!(c.visible(0.0, 10_000.0), 1..4);
    }

    #[test]
    fn columns_fixed_at_the_end_stick_to_the_view_once_the_others_overflow() {
        let c = ended();
        // A view of 260: the scrolling columns (300) overflow it, so D
        // stands at 210, at the view's end, wherever they scroll.
        assert_eq!(c.end_left(260.0, 0.0), 210.0);
        assert_eq!(c.end_left(260.0, 150.0), 210.0);
        assert_eq!(c.display_at(220.0, 0.0, 260.0), Some(4));
        assert_eq!(c.display_at(220.0, 150.0, 260.0), Some(4));
        // Before D, the scrolling columns: c at 200.
        assert_eq!(c.display_at(200.0, 0.0, 260.0), Some(2));
        // A view of 600: they fit, and D follows them at 360.
        assert_eq!(c.end_left(600.0, 0.0), 360.0);
        assert_eq!(c.display_at(370.0, 0.0, 600.0), Some(4));
        assert_eq!(c.display_at(500.0, 0.0, 600.0), None);
    }

    #[test]
    fn columns_fixed_at_the_end_move_among_themselves() {
        let mut c = Columns::new(vec![
            spec(10.0, false),
            spec(20.0, ColumnFixed::Right),
            spec(30.0, ColumnFixed::Right),
        ]);
        assert_eq!(c.order(), [0, 1, 2]);
        assert!(!c.move_to(0, 2), "a scrolling column stays among them");
        assert!(c.move_to(2, 1));
        assert_eq!(c.order(), [0, 2, 1]);
    }

    fn table() -> Columns {
        // a(100) B(60, fixed) c(80) d(120), B moves to the front.
        Columns::new(vec![
            spec(100.0, false),
            spec(60.0, true),
            spec(80.0, false),
            spec(120.0, false),
        ])
    }

    #[test]
    fn fixed_columns_lead() {
        let c = table();
        assert_eq!(c.order(), [1, 0, 2, 3]);
        assert_eq!(c.fixed_len(), 1);
        assert_eq!(c.fixed_width(), 60.0);
        assert_eq!(c.total(), 360.0);
        assert_eq!(c.scroll_width(), 300.0);
        assert_eq!(c.start(2), 160.0);
    }

    #[test]
    fn finds_the_column_under_a_point() {
        let c = table();
        assert_eq!(c.display_at(30.0, 0.0, 1000.0), Some(0));
        // Fixed columns do not scroll.
        assert_eq!(c.display_at(30.0, 90.0, 1000.0), Some(0));
        assert_eq!(c.display_at(70.0, 0.0, 1000.0), Some(1));
        // Scrolling by 90 shows the second scrolling column at 70.
        assert_eq!(c.display_at(100.0, 90.0, 1000.0), Some(2));
        assert_eq!(c.display_at(400.0, 0.0, 1000.0), None);
    }

    #[test]
    fn visible_columns_skip_the_fixed_ones() {
        let c = table();
        assert_eq!(c.visible(60.0, 150.0), 1..2);
        assert_eq!(c.visible(100.0, 200.0), 1..3);
        assert_eq!(c.visible(0.0, 1000.0), 1..4);
        assert_eq!(c.visible(500.0, 600.0), 4..4);
        assert!(c.visible(10.0, 10.0).is_empty());
    }

    #[test]
    fn resizing_clamps_and_moves_the_columns_after_it() {
        let mut c = table();
        assert!(c.set_width(0, 1000.0));
        assert_eq!(c.width(0), 400.0);
        assert_eq!(c.start(2), 460.0);
        assert!(!c.set_width(0, 400.0));
        assert!(c.set_width(2, 1.0));
        assert_eq!(c.width(2), 20.0);
        assert_eq!(c.total(), 60.0 + 400.0 + 20.0 + 120.0);
    }

    #[test]
    fn columns_move_within_their_zone() {
        let mut c = Columns::new(vec![
            spec(10.0, true),
            spec(10.0, true),
            spec(30.0, false),
            spec(40.0, false),
            spec(50.0, false),
        ]);
        assert!(!c.move_to(0, 3), "a fixed column stays among the fixed");
        assert!(c.move_to(0, 1));
        assert_eq!(c.order(), [1, 0, 2, 3, 4]);
        assert!(c.move_to(2, 4));
        assert_eq!(c.order(), [1, 0, 3, 4, 2]);
        assert_eq!(c.start(4), 20.0 + 20.0 + 40.0 + 50.0);
    }

    #[test]
    fn an_update_keeps_what_the_user_changed() {
        let mut c = table();
        c.set_width(0, 150.0);
        c.move_to(1, 3);
        let before = c.order().to_vec();
        let next = c.updated(
            vec![
                spec(100.0, false),
                spec(60.0, true),
                spec(80.0, false),
                spec(120.0, false),
            ],
            Some,
        );
        assert_eq!(next.order(), before);
        assert_eq!(next.width(0), 150.0);
        // The app changing a width wins over the user's.
        let changed = c.updated(
            vec![
                spec(200.0, false),
                spec(60.0, true),
                spec(80.0, false),
                spec(120.0, false),
            ],
            Some,
        );
        assert_eq!(changed.width(0), 200.0);
    }

    #[test]
    fn a_million_columns_find_ranges_by_search() {
        let c = Columns::new((0..1_000_000).map(|_| spec(100.0, false)).collect());
        assert_eq!(c.total(), 100_000_000.0);
        assert_eq!(c.visible(55_000_050.0, 55_000_350.0), 550_000..550_004);
        assert_eq!(c.display_at(10.0, 55_000_000.0, 1000.0), Some(550_000));
    }
}
