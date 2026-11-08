//! The gallery's desktop layout (as the TSX gallery's `SIDEBAR`,
//! `desktop`, `paneWidth` and `columnsFor`): wide windows show a sidebar of
//! the demos and the open one beside it, in columns.

use nsh_core::{element::Idiom, prelude::*};

/// The width of the desktop layout's sidebar.
pub(crate) const SIDEBAR: f32 = 264.0;

/// The width of the terminal's sidebar: 20 Cells, room for the longest
/// demo name and group title on their one-Cell gutters.
const TERMINAL_SIDEBAR: f32 = 160.0;

/// The width of the sidebar on this platform: [`SIDEBAR`], or in a
/// terminal its narrower one.
pub(crate) fn sidebar_width() -> f32 {
    if terminal() {
        TERMINAL_SIDEBAR
    } else {
        SIDEBAR
    }
}

/// Whether the gallery takes its desktop layout: a sidebar of the demos
/// next to the open one, demos in columns, hover states. Desktops take it
/// from 700 pt wide, other platforms from 900 pt (an iPad in landscape, a
/// wide Mac Catalyst window); phones never do. Below that it is the phone
/// layout, unchanged. The shell is made again when it changes, so demos
/// read it once; reading it in a binding subscribes to the window's size.
pub(crate) fn desktop() -> bool {
    window().width >= if is_desktop() { px(700.0) } else { px(900.0) }
}

/// Whether the gallery runs in a terminal (as the TSX gallery's
/// `terminal`): it leaves out what a terminal program would not show (the
/// logo, icon tiles, badges), puts on one row what other platforms stack,
/// and spaces in whole Cells ([`TERMINAL_ROW`], [`TERMINAL_COLUMN`]).
pub(crate) fn terminal() -> bool {
    idiom() == Idiom::Terminal
}

/// One Cell row in points (the default 8 × 16 points per Cell): the
/// terminal's line height and its unit of vertical space.
pub(crate) const TERMINAL_ROW: f32 = 16.0;

/// One Cell column in points: the terminal's unit of horizontal space.
pub(crate) const TERMINAL_COLUMN: f32 = 8.0;

/// The width of the desktop layout's content pane, right of the sidebar.
/// Reading it in a binding subscribes to the window's size.
pub(crate) fn pane_width() -> f32 {
    window().width.0 - sidebar_width()
}

/// How many columns at least `min` pt wide fit in `width` (the content
/// pane: [`pane_width`]), with `gap` between them and 24 pt gutters: 1 to
/// `max`.
pub(crate) fn columns_for(min: f32, max: u32, width: f32, gap: f32) -> u32 {
    (((width - 48.0 + gap) / (min + gap)).floor() as u32).clamp(1, max)
}

#[cfg(test)]
mod tests {
    use super::columns_for;

    #[test]
    fn columns_fit_the_width_between_the_gutters() {
        // 4 × 200 + 3 × 16 + 48 = 896.
        assert_eq!(columns_for(200.0, 8, 896.0, 16.0), 4);
        assert_eq!(columns_for(200.0, 8, 895.0, 16.0), 3);
        assert_eq!(columns_for(200.0, 8, 100.0, 16.0), 1);
        assert_eq!(columns_for(200.0, 8, 4000.0, 16.0), 8);
    }
}
