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
//!
//! Scaled, a finger would move the content several times as far as itself
//! (a million rows of 28 points, nine times). Where the scroll bar is not
//! dragged (touch), the offset is followed from an [`Anchor`] instead: the
//! content moves as far as the scroll ([`Axis::content_offset_from`]), and
//! once the scroll comes to rest the scroll view is moved, unseen, to where
//! its bar stands for the content ([`Axis::anchor_at`]).

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

    /// The content offset scroll offset `scroll` stands for, followed from
    /// `anchor`: as far from the anchor's content as the scroll is from its
    /// scroll offset, for half the room to the scroll view's end that way;
    /// faster past that, so the scroll view's ends are still the content's.
    pub(crate) fn content_offset_from(&self, scroll: f64, anchor: Anchor) -> f64 {
        if !self.scaled() {
            return self.content_offset(scroll);
        }
        let smax = (self.extent() - self.viewport).max(0.0);
        let cmax = (self.total - self.viewport).max(0.0);
        let (a_scroll, a_content) = (
            anchor.scroll.clamp(0.0, smax),
            anchor.content.clamp(0.0, cmax),
        );
        let at = if scroll >= a_scroll {
            a_content + follow(scroll - a_scroll, smax - a_scroll, cmax - a_content)
        } else {
            a_content - follow(a_scroll - scroll, a_scroll, a_content)
        };
        at.clamp(0.0, cmax)
    }

    /// The anchor that shows content offset `content` with the scroll view
    /// where its bar stands for it: [`Self::scroll_offset`] on a device
    /// pixel of `pixel_ratio`, where the platforms keep a scroll offset.
    pub(crate) fn anchor_at(&self, content: f64, pixel_ratio: f64) -> Anchor {
        let max = (self.total - self.viewport).max(0.0);
        let content = content.clamp(0.0, max);
        let ratio = pixel_ratio.max(f64::MIN_POSITIVE);
        let scroll = (self.scroll_offset(content) * ratio).round() / ratio;
        // The `f32` the scroll view reports, so the anchor's offset is met
        // exactly when the scroll comes back to it.
        Anchor {
            scroll: f64::from(scroll as f32),
            content,
        }
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

/// A scroll offset and the content offset it shows: where content offsets
/// are followed from ([`Axis::content_offset_from`]).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct Anchor {
    pub(crate) scroll: f64,
    pub(crate) content: f64,
}

/// How far the content moves for a scroll of `by`, with `room` left to the
/// scroll view's end and `content` to the content's: as far as the scroll
/// for the first half of the room, then as fast as reaches the content's
/// end with the scroll view's.
fn follow(by: f64, room: f64, content: f64) -> f64 {
    if content <= room {
        return by.min(content);
    }
    let half = room / 2.0;
    if by <= half {
        by
    } else {
        half + (by - half) * (content - half) / (room - half).max(f64::MIN_POSITIVE)
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
    fn a_followed_offset_moves_as_far_as_the_scroll() {
        // A million rows of 28 points, scaled about nine times.
        let axis = Axis::new(28_000_000.0, 600.0);
        let anchor = axis.anchor_at(14_000_000.0, 2.625);
        let at = |scroll: f64| axis.content_offset_from(scroll, anchor);
        assert_eq!(at(anchor.scroll), 14_000_000.0);
        // A finger's scroll moves the content as far, either way.
        assert!((at(anchor.scroll + 76.0) - 14_000_076.0).abs() < 1e-6);
        assert!((at(anchor.scroll - 300.0) - 13_999_700.0).abs() < 1e-6);
        // The scroll view's ends are still the content's.
        let smax = MAX_EXTENT - 600.0;
        assert!((at(smax) - (28_000_000.0 - 600.0)).abs() < 1e-3);
        assert_eq!(at(0.0), 0.0);
        // Monotonic between.
        let mut last = 0.0;
        for i in 0..=1000 {
            let c = at(smax * f64::from(i) / 1000.0);
            assert!(c >= last, "{i}: {c} < {last}");
            last = c;
        }
    }

    #[test]
    fn an_anchor_stands_where_the_bar_does() {
        let axis = Axis::new(28_000_000.0, 600.0);
        let anchor = axis.anchor_at(14_000_000.0, 2.625);
        assert!((anchor.scroll - axis.scroll_offset(14_000_000.0)).abs() < 1.0);
        // On a device pixel, as near as an `f32` is (an eighth of a point
        // there): what the scroll view reports back moves the content less
        // than a pixel, a finger's scroll being followed one to one.
        let px = anchor.scroll * 2.625;
        assert!((px - px.round()).abs() < 0.25, "{px}");
        assert_eq!(f64::from(anchor.scroll as f32), anchor.scroll);
        // Not scaled, the anchor changes nothing.
        let small = Axis::new(10_000.0, 500.0);
        let a = small.anchor_at(1234.0, 3.0);
        assert_eq!(small.content_offset_from(2000.0, a), 2000.0);
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
