//! How an editor sizes and scrolls: how far the text scrolls past its last
//! line ([`EditorScrollBeyond`]), the height of an editor that grows with
//! its text (`minRows` / `maxRows`), the rows kept around the caret
//! (`cursorSurroundingLines`), scrolling on its own while a drag selects
//! past the viewport's edge, and where the scroll bars keep within the
//! editor (`scrollbarInset`).

use nsh_core::{
    EdgeInsets,
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes},
    geometry::{Points, px},
};

pub(crate) use crate::autoscroll::{
    AUTOSCROLL_INNER_ZONE, AUTOSCROLL_PERIOD_MS, AutoScroll, edge_speed,
};

/// How far an `Editor`'s text scrolls on past its last line
/// (`scrollBeyondLastLine`): `true` up to a screen, `false` not at all, a
/// number that many rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum EditorScrollBeyond {
    /// Not past the last line (`false`).
    None,
    /// Up to a screen: the last line can scroll up to the top (`true`).
    #[default]
    Screen,
    /// That many empty rows (a number).
    Rows(u32),
}

impl From<bool> for EditorScrollBeyond {
    fn from(beyond: bool) -> Self {
        if beyond {
            EditorScrollBeyond::Screen
        } else {
            EditorScrollBeyond::None
        }
    }
}

impl From<u32> for EditorScrollBeyond {
    fn from(rows: u32) -> Self {
        EditorScrollBeyond::Rows(rows)
    }
}

impl EditorScrollBeyond {
    /// The room past the last row in a viewport `viewport` tall, with rows
    /// `line_height` tall.
    pub(crate) fn room(self, viewport: Points, line_height: Points) -> Points {
        match self {
            EditorScrollBeyond::None => px(0.0),
            EditorScrollBeyond::Screen => (viewport - line_height).max(px(0.0)),
            EditorScrollBeyond::Rows(rows) => line_height * rows as f32,
        }
    }
}

/// TS: `boolean | number`.
impl JsValue for EditorScrollBeyond {
    fn ts_type(_types: &mut TsTypes) -> String {
        "boolean | number".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(EditorScrollBeyond::default());
        }
        if let Some(beyond) = value.as_bool() {
            return Ok(beyond.into());
        }
        match value.as_number() {
            Some(n) if n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= u32::MAX as f64 => {
                Ok(EditorScrollBeyond::Rows(n as u32))
            }
            _ => Err(value.expected("a boolean or a whole number of rows")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(match self {
            EditorScrollBeyond::None => JsOwned::new(host, host.new_bool(false)),
            EditorScrollBeyond::Screen => JsOwned::new(host, host.new_bool(true)),
            EditorScrollBeyond::Rows(rows) => JsOwned::new(host, host.new_number(*rows as f64)),
        })
    }
}

/// The height of the rows of an editor growing with its text: `rows`
/// rows, at least `min` and at most `max` of them, the first `n` of them
/// `top(n)` tall (rows past the last a line height each). `None` when
/// neither is set (the app sizes the editor).
pub(crate) fn grow_height(
    rows: usize,
    min: Option<u32>,
    max: Option<u32>,
    top: impl Fn(usize) -> Points,
) -> Option<Points> {
    if min.is_none() && max.is_none() {
        return None;
    }
    let min = min.unwrap_or(1).max(1);
    let max = max.unwrap_or(u32::MAX).max(min);
    let rows = u32::try_from(rows).unwrap_or(u32::MAX).clamp(min, max);
    Some(top(rows as usize))
}

/// The room kept between the caret's row and the viewport's top and bottom
/// edges: `lines` rows (a row when not set, at most a quarter of the
/// viewport), never so much that the caret's row cannot show between them.
pub(crate) fn surrounding_margin(
    lines: Option<u32>,
    viewport: Points,
    line_height: Points,
) -> Points {
    match lines {
        None => line_height.min(viewport / 4.0),
        Some(lines) => {
            let most = ((viewport - line_height) / 2.0).max(px(0.0));
            (line_height * lines as f32).min(most)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrolling_beyond_the_last_line_takes_a_screen_rows_or_nothing() {
        let (viewport, lh) = (px(200.0), px(20.0));
        assert_eq!(EditorScrollBeyond::from(true).room(viewport, lh), px(180.0));
        assert_eq!(EditorScrollBeyond::from(false).room(viewport, lh), px(0.0));
        assert_eq!(EditorScrollBeyond::from(3).room(viewport, lh), px(60.0));
        // A viewport shorter than a row has no room past it.
        assert_eq!(EditorScrollBeyond::Screen.room(px(10.0), lh), px(0.0));
        assert_eq!(EditorScrollBeyond::default(), EditorScrollBeyond::Screen);
    }

    #[test]
    fn an_editor_grows_between_its_rows_bounds() {
        let top = |rows: usize| px(20.0) * rows as f32;
        assert_eq!(grow_height(5, None, None, top), None);
        assert_eq!(grow_height(1, Some(3), None, top), Some(px(60.0)));
        assert_eq!(grow_height(5, Some(3), None, top), Some(px(100.0)));
        assert_eq!(grow_height(9, Some(2), Some(6), top), Some(px(120.0)));
        // A max under the min is the min; zero rows are one.
        assert_eq!(grow_height(9, Some(4), Some(2), top), Some(px(80.0)));
        assert_eq!(grow_height(0, None, Some(4), top), Some(px(20.0)));
        // Taller rows: the rows' own tops.
        let tall = |rows: usize| px(20.0) * rows as f32 + if rows > 0 { px(12.0) } else { px(0.0) };
        assert_eq!(grow_height(2, Some(1), Some(4), tall), Some(px(52.0)));
    }

    #[test]
    fn the_margin_around_the_caret_fits_the_viewport() {
        let lh = px(20.0);
        assert_eq!(surrounding_margin(None, px(400.0), lh), px(20.0));
        assert_eq!(surrounding_margin(None, px(40.0), lh), px(10.0));
        assert_eq!(surrounding_margin(Some(3), px(400.0), lh), px(60.0));
        // Never more than half of what the caret's row leaves.
        assert_eq!(surrounding_margin(Some(10), px(100.0), lh), px(40.0));
        assert_eq!(surrounding_margin(Some(0), px(400.0), lh), px(0.0));
        assert_eq!(surrounding_margin(Some(2), px(10.0), lh), px(0.0));
    }
}

/// The least height of a mark on the overview ruler, as Monaco's.
const RULER_MARK_MIN_HEIGHT: Points = Points(6.0);

/// Where a mark covering rows `top` down and `height` tall in the rows'
/// box is down an overview ruler `track` tall: its top and height, the
/// rows' place in the rows' box (`content` tall, or the ruler's height when
/// shorter) scaled to the ruler, at least [`RULER_MARK_MIN_HEIGHT`] tall
/// and kept within it.
pub(crate) fn ruler_place(
    top: Points,
    height: Points,
    content: Points,
    track: Points,
) -> (Points, Points) {
    let content = content.max(track).max(px(1.0));
    let scale = track / content;
    let height = (height * scale).max(RULER_MARK_MIN_HEIGHT);
    let top = (top * scale).min((track - height).max(px(0.0)));
    (top, height)
}

/// The share of the ruler's width before a mark in `lane`, and the share
/// it takes: the ruler's width is its part's, so the lanes are fractions.
pub(crate) fn ruler_lane(lane: super::EditorOverviewRulerLane) -> (f32, f32) {
    use super::EditorOverviewRulerLane as Lane;
    const THIRD: f32 = 1.0 / 3.0;
    match lane {
        Lane::Left => (0.0, THIRD),
        Lane::Center => (THIRD, THIRD),
        Lane::Right => (2.0 * THIRD, THIRD),
        Lane::Full => (0.0, 1.0),
    }
}

/// The editor's `scrollbarInset`, none below zero, as a scroll view
/// takes it.
pub(crate) fn bar_inset(inset: EdgeInsets) -> EdgeInsets {
    inset.map(|v| v.max(px(0.0)))
}

/// The horizontal scroll view's `scrollbarInset`: the editor's `inset`,
/// measured from the editor's edges, for a text area starting `text_left`
/// past the editor's left (the gutter's width). Its bar runs along the
/// bottom between the ends, so the top is the vertical bar's alone, and
/// the gutter already keeps the bar that far from the left.
pub(crate) fn text_bar_inset(inset: EdgeInsets, text_left: Points) -> EdgeInsets {
    let inset = bar_inset(inset);
    EdgeInsets {
        top: px(0.0),
        right: inset.right,
        bottom: inset.bottom,
        left: (inset.left - text_left).max(px(0.0)),
    }
}

#[cfg(test)]
mod ruler_tests {
    use super::*;
    use crate::editor::EditorOverviewRulerLane as Lane;

    #[test]
    fn ruler_marks_scale_to_the_ruler_in_their_lanes() {
        // 100 rows (2000 points) on a 200 point ruler: a tenth.
        assert_eq!(
            ruler_place(px(1000.0), px(200.0), px(2000.0), px(200.0)),
            (px(100.0), px(20.0))
        );
        // A row is at least six points tall, kept within the ruler.
        assert_eq!(
            ruler_place(px(1980.0), px(20.0), px(2000.0), px(200.0)),
            (px(194.0), px(6.0))
        );
        // A short text keeps its rows' places.
        assert_eq!(
            ruler_place(px(40.0), px(20.0), px(100.0), px(200.0)).0,
            px(40.0)
        );
        assert_eq!(ruler_lane(Lane::Right), (2.0 / 3.0, 1.0 / 3.0));
        assert_eq!(ruler_lane(Lane::Full), (0.0, 1.0));
    }

    #[test]
    fn the_horizontal_bar_keeps_the_editors_inset_past_the_gutter() {
        let inset = EdgeInsets {
            top: px(8.0),
            right: px(4.0),
            bottom: px(6.0),
            left: px(12.0),
        };
        let without_top = |left| EdgeInsets {
            top: px(0.0),
            right: px(4.0),
            bottom: px(6.0),
            left: px(left),
        };
        // No gutter: the text area starts at the editor's left.
        assert_eq!(text_bar_inset(inset, px(0.0)), without_top(12.0));
        // A gutter narrower than the inset keeps the rest of it.
        assert_eq!(text_bar_inset(inset, px(5.0)), without_top(7.0));
        // A wider one already keeps the bar clear.
        assert_eq!(text_bar_inset(inset, px(40.0)), without_top(0.0));
        // Negative sides count as none, as on a scroll view.
        let negative = EdgeInsets::all(px(-3.0));
        assert_eq!(bar_inset(negative), EdgeInsets::default());
        assert_eq!(text_bar_inset(negative, px(0.0)), EdgeInsets::default());
    }
}
