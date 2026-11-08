//! Scroll bars: a scroll view whose content overflows along its axis shows a
//! one-Cell bar on its inner right edge (bottom edge when it scrolls
//! horizontally), unless the app hides its indicator or the view is a
//! single Cell across: a track the length of the view and a thumb as long
//! as the share of the content in view, at least one Cell, placed by the
//! offset.

use nsh_core::{NodeId, Points, Size, scroll::ScrollState};
use ratatui_core::layout::Rect;

use crate::geometry::CellBounds;

/// A drawn scroll bar, for drawing and for dragging its thumb.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScrollBar {
    /// The scroll view.
    pub(crate) node: NodeId,
    /// The whole bar's visible Cells.
    pub(crate) track: Rect,
    /// The thumb's visible Cells.
    pub(crate) thumb: Rect,
    /// Along the vertical axis (else the horizontal one).
    pub(crate) vertical: bool,
    /// Where the whole track starts along its axis and how many Cells it
    /// has, clipped or not: a bar whose view runs past the screen places
    /// its thumb on all of them, and a drag must too.
    pub(crate) extent: (i32, i32),
    /// Where the whole thumb starts along the axis and its Cells.
    pub(crate) thumb_extent: (i32, i32),
}

/// The bar of the scroll view `node` (`scroll`, its view `size`) whose
/// Cells inside its border are `inner`, clipped to `clip`; `None` when its
/// content fits, its indicator is hidden or it has no Cells.
pub(crate) fn bar(
    node: NodeId,
    scroll: &ScrollState,
    size: Size<Points>,
    inner: CellBounds,
    clip: Rect,
) -> Option<ScrollBar> {
    if !scroll.indicator {
        return None;
    }
    let vertical = !scroll.horizontal;
    let max = scroll.max(size);
    let (range, viewport, offset) = if vertical {
        (max.y, size.height, scroll.y)
    } else {
        (max.x, size.width, scroll.x)
    };
    if range < Points(0.5) || viewport <= Points::ZERO {
        return None;
    }
    let (start, length) = if vertical {
        (inner.top, inner.bottom - inner.top)
    } else {
        (inner.left, inner.right - inner.left)
    };
    // A bar takes a line of Cells across the view: one Cell across shows
    // the content rather than a bar over all of it.
    let across = if vertical {
        inner.right - inner.left
    } else {
        inner.bottom - inner.top
    };
    if length < 1 || across < 2 {
        return None;
    }
    let share = viewport / (viewport + range);
    let thumb_length = ((length as f32 * share).round() as i32).clamp(1, length);
    let progress = (offset / range).clamp(0.0, 1.0);
    let thumb_start = start + ((length - thumb_length) as f32 * progress).round() as i32;
    let (track, thumb) = if vertical {
        let column = CellBounds {
            left: inner.right - 1,
            ..inner
        };
        (
            column,
            CellBounds {
                top: thumb_start,
                bottom: thumb_start + thumb_length,
                ..column
            },
        )
    } else {
        let row = CellBounds {
            top: inner.bottom - 1,
            ..inner
        };
        (
            row,
            CellBounds {
                left: thumb_start,
                right: thumb_start + thumb_length,
                ..row
            },
        )
    };
    let track = track.clipped(clip);
    (!track.is_empty()).then(|| ScrollBar {
        node,
        track,
        thumb: thumb.clipped(clip),
        vertical,
        extent: (start, length),
        thumb_extent: (thumb_start, thumb_length),
    })
}

#[cfg(test)]
mod tests {
    use nsh_core::{Points, Size, scroll::ScrollState};
    use ratatui_core::layout::Rect;

    use super::bar;
    use crate::geometry::CellBounds;

    fn inner() -> CellBounds {
        CellBounds {
            left: 0,
            top: 0,
            right: 10,
            bottom: 10,
        }
    }

    fn scroll(y: f32) -> ScrollState {
        let mut scroll = ScrollState::default();
        scroll.indicator = true;
        scroll.y = Points(y);
        scroll.content = Size::new(Points(80.0), Points(640.0));
        scroll
    }

    #[test]
    fn the_thumb_shows_the_share_in_view_at_the_offset() {
        let size = Size::new(Points(80.0), Points(160.0));
        let clip = Rect::new(0, 0, 10, 10);
        let top = bar(1, &scroll(0.0), size, inner(), clip).unwrap();
        assert_eq!(top.track, Rect::new(9, 0, 1, 10));
        assert_eq!(top.thumb, Rect::new(9, 0, 1, 3));
        let end = bar(1, &scroll(480.0), size, inner(), clip).unwrap();
        assert_eq!(end.thumb, Rect::new(9, 7, 1, 3));
    }

    #[test]
    fn a_bar_the_screen_cuts_keeps_its_whole_track_for_drags() {
        let size = Size::new(Points(80.0), Points(160.0));
        // The screen shows the view's first six rows of ten.
        let clip = Rect::new(0, 0, 10, 6);
        let end = bar(1, &scroll(480.0), size, inner(), clip).unwrap();
        assert_eq!(end.track, Rect::new(9, 0, 1, 6));
        assert_eq!(end.extent, (0, 10));
        // The thumb stands at the end of the whole track, past the screen.
        assert_eq!(end.thumb_extent, (7, 3));
        assert!(end.thumb.is_empty());
    }

    #[test]
    fn content_that_fits_or_a_hidden_indicator_shows_no_bar() {
        let clip = Rect::new(0, 0, 10, 10);
        let size = Size::new(Points(80.0), Points(640.0));
        assert!(bar(1, &scroll(0.0), size, inner(), clip).is_none());
        let mut hidden = scroll(0.0);
        hidden.indicator = false;
        let size = Size::new(Points(80.0), Points(160.0));
        assert!(bar(1, &hidden, size, inner(), clip).is_none());
    }

    #[test]
    fn a_view_one_cell_across_shows_no_bar() {
        let size = Size::new(Points(8.0), Points(160.0));
        let column = CellBounds {
            right: 1,
            ..inner()
        };
        let clip = Rect::new(0, 0, 10, 10);
        assert!(bar(1, &scroll(0.0), size, column, clip).is_none());
    }
}
