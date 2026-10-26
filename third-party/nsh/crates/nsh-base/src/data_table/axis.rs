//! One axis of the table's scroll range: the real extent of the content and
//! the extent the scroll views are given.
//!
//! Platforms keep scroll offsets and content sizes in 32-bit floats and
//! layers cannot be arbitrarily large, so a table of ten million rows (a
//! quarter of a billion points) cannot be a scroll view's content as it is.
//! Past [`MAX_EXTENT`] the scroll view gets that extent and its offset is
//! scaled to the content's (`ratio`): the table finds the rows from the
//! scaled offset and places them relative to its first row, so what is
//! drawn is exact at any size, and a scroll bar still spans the content.

use nsh_core::Points;

/// The largest extent, in points, a scroll view is given.
pub(crate) const MAX_EXTENT: f64 = 3_000_000.0;

/// The content and viewport lengths of one axis.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct Axis {
    /// The content's length.
    pub(crate) total: f64,
    /// The viewport's length.
    pub(crate) viewport: f64,
}

impl Axis {
    pub(crate) fn new(total: f64, viewport: f64) -> Axis {
        Axis { total, viewport }
    }

    /// The length of the box the scroll view holds.
    pub(crate) fn extent(&self) -> f64 {
        self.total.min(MAX_EXTENT)
    }

    /// Whether the content is longer than a scroll view can hold.
    pub(crate) fn scaled(&self) -> bool {
        self.total > MAX_EXTENT
    }

    /// Content points per scroll point.
    pub(crate) fn ratio(&self) -> f64 {
        if !self.scaled() {
            return 1.0;
        }
        let content = (self.total - self.viewport).max(0.0);
        let scroll = (self.extent() - self.viewport).max(1.0);
        content / scroll
    }

    /// The content offset a scroll offset stands for.
    pub(crate) fn content_offset(&self, scroll: f64) -> f64 {
        let max = (self.total - self.viewport).max(0.0);
        (scroll * self.ratio()).clamp(0.0, max)
    }

    /// The scroll offset showing content offset `content` at the start.
    pub(crate) fn scroll_offset(&self, content: f64) -> f64 {
        let max = (self.extent() - self.viewport).max(0.0);
        (content / self.ratio()).clamp(0.0, max)
    }

    /// The scroll offset to give a scroll view to show content offset
    /// `content` at the start: [`Self::scroll_offset`] as the 32-bit float
    /// platforms keep, the first that does not stop short of `content`.
    /// Far down a scaled axis one step of that float is several content
    /// points, so the nearest could leave a sliver of the row before in
    /// view (a scroll to row 500 000 showing row 499 999 first).
    pub(crate) fn scroll_points(&self, content: f64) -> Points {
        let max = (self.extent() - self.viewport).max(0.0) as f32;
        let mut at = (self.scroll_offset(content) as f32).min(max);
        while at < max && self.content_offset(f64::from(at)) < content - 1e-6 {
            at = at.next_up().min(max);
        }
        Points(at)
    }

    /// The content offset that brings `start..end` into view from content
    /// offset `from`: the nearest offset that shows it, unchanged when it
    /// already shows (and it is not taller than the viewport; then its start
    /// is shown).
    pub(crate) fn reveal(&self, from: f64, start: f64, end: f64) -> f64 {
        if start < from || end - start > self.viewport {
            start
        } else if end > from + self.viewport {
            end - self.viewport
        } else {
            from
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_content_is_not_scaled() {
        let axis = Axis::new(10_000.0, 500.0);
        assert!(!axis.scaled());
        assert_eq!(axis.extent(), 10_000.0);
        assert_eq!(axis.content_offset(1234.0), 1234.0);
        assert_eq!(axis.scroll_offset(1234.0), 1234.0);
    }

    #[test]
    fn huge_content_scales_the_offset_to_the_range() {
        let axis = Axis::new(240_000_000.0, 600.0);
        assert!(axis.scaled());
        assert_eq!(axis.extent(), MAX_EXTENT);
        // The scroll view's end is the content's end.
        let end = axis.content_offset(MAX_EXTENT - 600.0);
        assert!((end - (240_000_000.0 - 600.0)).abs() < 1.0, "{end}");
        assert_eq!(axis.content_offset(0.0), 0.0);
        // And back.
        let at = axis.scroll_offset(axis.content_offset(1_000_000.0));
        assert!((at - 1_000_000.0).abs() < 1e-6);
    }

    #[test]
    fn scroll_points_never_stop_short_of_a_row() {
        // A million rows of 32 points, scaled about ten times.
        let axis = Axis::new(32_000_000.0, 540.0);
        for row in [1_u32, 7, 499_999, 500_000, 777_777, 999_983] {
            let top = f64::from(row) * 32.0;
            let at = axis.content_offset(f64::from(axis.scroll_points(top).0));
            assert!(at >= top - 1e-6, "row {row}: {at} < {top}");
            assert!(at < top + 32.0, "row {row}: {at} past the row");
        }
        // Not scaled, offsets are exact.
        let small = Axis::new(10_000.0, 500.0);
        assert_eq!(small.scroll_points(1234.5), Points(1234.5));
    }

    #[test]
    fn offsets_stay_within_the_content() {
        let axis = Axis::new(1000.0, 400.0);
        assert_eq!(axis.content_offset(-5.0), 0.0);
        assert_eq!(axis.content_offset(5000.0), 600.0);
        let short = Axis::new(100.0, 400.0);
        assert_eq!(short.content_offset(50.0), 0.0);
    }

    #[test]
    fn reveal_moves_the_least() {
        let axis = Axis::new(1000.0, 100.0);
        assert_eq!(axis.reveal(50.0, 60.0, 90.0), 50.0);
        assert_eq!(axis.reveal(50.0, 20.0, 40.0), 20.0);
        assert_eq!(axis.reveal(50.0, 140.0, 170.0), 70.0);
        assert_eq!(axis.reveal(50.0, 60.0, 400.0), 60.0);
    }
}
