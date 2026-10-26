//! The rows a virtualized view makes: those in view and a reach around
//! them, moved only when the viewport nears the window's edge. Scrolling a
//! little then changes no rows (no commit), and a scroll finds the rows of
//! the next frames made already instead of a blank: the platform moves the
//! content at once, the rows the move needs come a frame later.

use std::{cell::Cell, ops::Range, rc::Rc};

/// Rows kept made past the viewport's edges, at least: the window moves
/// when the viewport comes closer to its edge than this or half a viewport.
const MARGIN: usize = 4;
/// Rows made ahead of the viewport, in the way it scrolls, when the window
/// moves, at least (a viewport and a half, else); behind it, half that.
const MIN_AHEAD: usize = 16;

/// The window of rows made last, which the next one keeps when it can.
#[derive(Debug, Clone)]
pub(crate) struct RowWindow {
    window: Rc<Cell<Window>>,
    /// Rows kept made past the viewport's edges, at least.
    margin: usize,
    /// Rows made ahead of the viewport when the window moves, at least.
    ahead: usize,
}

#[derive(Debug, Default, Clone, Copy)]
struct Window {
    start: usize,
    end: usize,
    /// The first row in view when it was made.
    first: usize,
}

impl Default for RowWindow {
    fn default() -> Self {
        RowWindow::reaching(MARGIN, MIN_AHEAD)
    }
}

impl RowWindow {
    /// A window keeping `margin` items made past the viewport's edges and
    /// making `ahead` ahead of it when it moves, at least (a window of
    /// columns, which are wide, reaches less far than one of rows).
    pub(crate) fn reaching(margin: usize, ahead: usize) -> Self {
        RowWindow {
            window: Rc::default(),
            margin,
            ahead,
        }
    }

    /// The rows to make with `visible` of `count` rows in view: the
    /// previous window while it covers them with half a viewport to spare,
    /// else the visible rows and a viewport and a half more ahead (the way
    /// they scrolled), half a viewport behind.
    pub(crate) fn rows(&self, visible: Range<usize>, count: usize) -> Range<usize> {
        let w = self.window.get();
        let page = visible.len();
        let margin = (page / 2).max(self.margin);
        let need = visible.start.saturating_sub(margin)..(visible.end + margin).min(count);
        // Kept while it covers what is needed, within the rows there are,
        // and is not much more (the viewport grew smaller).
        let fits = w.start <= need.start && need.end <= w.end && w.end <= count;
        if fits && w.end - w.start <= page * 4 + self.ahead * 3 {
            return w.start..w.end;
        }
        let ahead = (page * 3 / 2).max(self.ahead);
        let behind = (page / 2).max(self.ahead / 2);
        let (before, after) = if visible.start < w.first {
            (ahead, behind)
        } else {
            (behind, ahead)
        };
        let start = visible.start.saturating_sub(before).min(count);
        let end = (visible.end + after).min(count);
        self.window.set(Window {
            start,
            end,
            first: visible.start,
        });
        start..end
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_stays_while_it_covers_the_rows_in_view() {
        let w = RowWindow::default();
        // Scrolling down: a viewport and a half ahead, half behind.
        assert_eq!(w.rows(100..140, 1000), 80..200);
        assert_eq!(w.rows(110..150, 1000), 80..200);
        assert_eq!(w.rows(100..140, 1000), 80..200);
        // Within half a viewport of its end it moves on.
        assert_eq!(w.rows(141..181, 1000), 121..241);
        // Scrolling up: the reach goes up.
        assert_eq!(w.rows(100..140, 1000), 40..160);
        assert_eq!(w.rows(0..40, 1000), 0..60);
    }

    #[test]
    fn a_window_follows_the_rows_there_are() {
        let w = RowWindow::default();
        assert_eq!(w.rows(980..1000, 1000), 970..1000);
        assert_eq!(w.rows(980..990, 990), 972..990);
        assert_eq!(w.rows(0..0, 0), 0..0);
        // A smaller viewport makes a smaller window.
        let w = RowWindow::default();
        assert_eq!(w.rows(0..200, 1000), 0..500);
        assert_eq!(w.rows(0..10, 1000), 0..26);
    }
}
