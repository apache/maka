//! The gallery's desktop layout (as the TSX gallery's `SIDEBAR`,
//! `desktop`, `paneWidth` and `columnsFor`): wide windows show a sidebar of
//! the demos and the open one beside it, in columns.

use nsh_core::prelude::*;

/// The width of the desktop layout's sidebar.
pub(crate) const SIDEBAR: f32 = 264.0;

/// Whether the gallery takes its desktop layout: a sidebar of the demos
/// next to the open one, demos in columns, hover states. Desktops take it
/// from 700 pt wide, other platforms from 900 pt (an iPad in landscape, a
/// wide Mac Catalyst window); phones never do. Below that it is the phone
/// layout, unchanged. The shell is made again when it changes, so demos
/// read it once; reading it in a binding subscribes to the window's size.
pub(crate) fn desktop() -> bool {
    window().width >= if is_desktop() { px(700.0) } else { px(900.0) }
}

/// The width of the desktop layout's content pane, right of the sidebar.
/// Reading it in a binding subscribes to the window's size.
pub(crate) fn pane_width() -> f32 {
    window().width.0 - SIDEBAR
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
