//! The columns' layout: their order (fixed columns first), widths and the
//! prefix sums that find a column at a position and the columns in a range
//! in time that does not depend on their number.
//!
//! Columns are named two ways: by *definition* index, their position in the
//! app's `columns` (stable while columns move), and by *display* index, their
//! place now (what the sums are over). A fixed column stays at the start,
//! where the scrolling columns pass under it.

use std::ops::Range;

/// What the layout needs of a column.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Spec {
    /// The width it starts at.
    pub(crate) width: f32,
    pub(crate) min: f32,
    pub(crate) max: f32,
    /// Stays at the start while the others scroll.
    pub(crate) fixed: bool,
}

/// The layout of a table's columns.
#[derive(Debug, Clone, Default)]
pub(crate) struct Columns {
    specs: Vec<Spec>,
    /// Widths by definition index.
    widths: Vec<f32>,
    /// Definition indexes in display order.
    order: Vec<usize>,
    /// Display indexes by definition index.
    shown: Vec<usize>,
    /// Where each display index starts (and the total at the end), in the
    /// whole table's coordinates: `starts.len() == len + 1`.
    starts: Vec<f64>,
    /// How many fixed columns lead the order.
    fixed: usize,
}

impl Columns {
    /// The layout of `specs` in their order, the fixed ones moved to the
    /// start (keeping their order among themselves).
    pub(crate) fn new(specs: Vec<Spec>) -> Columns {
        let widths = specs.iter().map(|s| clamp(s, s.width)).collect();
        let mut order: Vec<usize> = (0..specs.len()).collect();
        order.sort_by_key(|&i| !specs[i].fixed);
        let fixed = specs.iter().filter(|s| s.fixed).count();
        let mut columns = Columns {
            specs,
            widths,
            order,
            shown: Vec::new(),
            starts: Vec::new(),
            fixed,
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
        for (new, spec) in next.specs.clone().iter().enumerate() {
            if let Some(old) = old_of(new).filter(|&old| old < self.widths.len()) {
                // A width the user dragged survives; a width the app changed
                // (its own spec differs) wins.
                if self.specs[old].width == spec.width {
                    next.widths[new] = clamp(spec, self.widths[old]);
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
        next.order
            .sort_by_key(|&n| (!next.specs[n].fixed, position[n], n));
        next.reindex();
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

    /// How many columns are fixed.
    pub(crate) fn fixed_len(&self) -> usize {
        self.fixed
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

    /// The width the scrolling columns take.
    pub(crate) fn scroll_width(&self) -> f64 {
        self.total() - self.fixed_width()
    }

    /// The column at `x` of the table's coordinates when scrolled by
    /// `scroll_x` (content points); `None` past the columns.
    pub(crate) fn display_at(&self, x: f64, scroll_x: f64) -> Option<usize> {
        let fixed_width = self.fixed_width();
        let table_x = if x < fixed_width { x } else { x + scroll_x };
        if table_x < 0.0 || table_x >= self.total() {
            return None;
        }
        // The last start at or before `table_x`.
        let at = self.starts[..self.order.len()].partition_point(|&s| s <= table_x);
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

    /// The scrolling columns (display indexes, past the fixed ones) that
    /// intersect the content span `from..to`, which is in the whole table's
    /// coordinates (the viewport's start is `scroll_x + fixed_width`).
    pub(crate) fn visible(&self, from: f64, to: f64) -> Range<usize> {
        let n = self.order.len();
        if self.fixed >= n || to <= from || from >= self.total() {
            return n..n;
        }
        let first = self.starts[..n]
            .partition_point(|&s| s <= from)
            .saturating_sub(1)
            .max(self.fixed);
        let end = self.starts[..n].partition_point(|&s| s < to).max(first);
        first..end.min(n)
    }

    /// Sets definition `def`'s width (clamped to its limits); whether it
    /// changed.
    pub(crate) fn set_width(&mut self, def: usize, width: f32) -> bool {
        let width = clamp(&self.specs[def], width);
        if self.widths[def] == width {
            return false;
        }
        self.widths[def] = width;
        if let Some(display) = self.display_of(def) {
            self.rebuild(display);
        }
        true
    }

    /// Moves the column at display index `from` to `to`, within its zone
    /// (fixed columns among themselves, the others among theirs); whether it
    /// moved.
    pub(crate) fn move_to(&mut self, from: usize, to: usize) -> bool {
        let n = self.order.len();
        if from >= n || to >= n || from == to {
            return false;
        }
        let zone = |i: usize| i < self.fixed;
        if zone(from) != zone(to) {
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

    fn spec(width: f32, fixed: bool) -> Spec {
        Spec {
            width,
            min: 20.0,
            max: 400.0,
            fixed,
        }
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
        assert_eq!(c.display_at(30.0, 0.0), Some(0));
        // Fixed columns do not scroll.
        assert_eq!(c.display_at(30.0, 90.0), Some(0));
        assert_eq!(c.display_at(70.0, 0.0), Some(1));
        // Scrolling by 90 shows the second scrolling column at 70.
        assert_eq!(c.display_at(100.0, 90.0), Some(2));
        assert_eq!(c.display_at(400.0, 0.0), None);
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
        assert_eq!(c.display_at(10.0, 55_000_000.0), Some(550_000));
    }
}
