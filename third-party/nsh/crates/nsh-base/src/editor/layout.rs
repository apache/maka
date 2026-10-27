//! How an editor sizes and scrolls: how far the text scrolls past its last
//! line ([`EditorScrollBeyond`]), the height of an editor that grows with
//! its text (`minRows` / `maxRows`), the rows kept around the caret
//! (`cursorSurroundingLines`), and scrolling on its own while a drag
//! selects past the viewport's edge.

use nsh_core::{
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes},
    geometry::{Point, Points, px},
    prelude::Spawned,
};

/// How often a drag past the viewport's edge scrolls (about a frame).
pub(crate) const AUTOSCROLL_PERIOD_MS: u64 = 16;
/// How far inside the viewport's top and bottom edges a drag starts
/// scrolling, so that it scrolls in a window filling the screen, where the
/// pointer cannot leave the editor.
pub(crate) const AUTOSCROLL_INNER_ZONE: Points = Points(16.0);
/// Points scrolled per period at the edge.
const MIN_SPEED: f32 = 12.0;
/// Points scrolled per period at the end of the ramp.
const MAX_SPEED: f32 = 64.0;
/// How far past the inner zone the speed ramps up to [`MAX_SPEED`].
const OUTER_RAMP: f32 = 80.0;

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
/// rows, at least `min` and at most `max` of them. `None` when neither is
/// set (the app sizes the editor).
pub(crate) fn grow_height(
    rows: usize,
    line_height: Points,
    min: Option<u32>,
    max: Option<u32>,
) -> Option<Points> {
    if min.is_none() && max.is_none() {
        return None;
    }
    let min = min.unwrap_or(1).max(1);
    let max = max.unwrap_or(u32::MAX).max(min);
    let rows = u32::try_from(rows).unwrap_or(u32::MAX).clamp(min, max);
    Some(line_height * rows as f32)
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

/// How far to scroll per period while a drag is at `position` along an
/// axis of a viewport `length` long: toward the end past `length - inner`,
/// toward the start before `inner`, faster the farther out (none inside).
pub(crate) fn edge_speed(position: Points, length: Points, inner: Points) -> Points {
    if length.0 <= 0.0 {
        return px(0.0);
    }
    let inner = inner.0.min(length.0 / 4.0);
    let ramp = |past: f32| {
        let t = (past / (inner + OUTER_RAMP)).min(1.0);
        MIN_SPEED + t * (MAX_SPEED - MIN_SPEED)
    };
    let end = length.0 - inner;
    if position.0 > end {
        px(ramp(position.0 - end))
    } else if position.0 < inner {
        px(-ramp(inner - position.0))
    } else {
        px(0.0)
    }
}

/// A drag scrolling on its own past the viewport's edge.
pub(crate) struct AutoScroll {
    /// The pointer's last position in the root view.
    pub(crate) page: Point<Points>,
    /// How far each period scrolls, per axis.
    pub(crate) speed: Point<Points>,
    /// The timer, while it scrolls.
    pub(crate) task: Option<Spawned<()>>,
}

impl Default for AutoScroll {
    fn default() -> Self {
        AutoScroll {
            page: Point::new(px(0.0), px(0.0)),
            speed: Point::new(px(0.0), px(0.0)),
            task: None,
        }
    }
}

impl AutoScroll {
    /// Stops scrolling.
    pub(crate) fn stop(&mut self) {
        self.speed = Point::new(px(0.0), px(0.0));
        if let Some(task) = self.task.take() {
            task.cancel();
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
        let lh = px(20.0);
        assert_eq!(grow_height(5, lh, None, None), None);
        assert_eq!(grow_height(1, lh, Some(3), None), Some(px(60.0)));
        assert_eq!(grow_height(5, lh, Some(3), None), Some(px(100.0)));
        assert_eq!(grow_height(9, lh, Some(2), Some(6)), Some(px(120.0)));
        // A max under the min is the min; zero rows are one.
        assert_eq!(grow_height(9, lh, Some(4), Some(2)), Some(px(80.0)));
        assert_eq!(grow_height(0, lh, None, Some(4)), Some(px(20.0)));
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

    #[test]
    fn a_drag_scrolls_faster_the_farther_past_the_edge() {
        let (length, inner) = (px(400.0), px(16.0));
        assert_eq!(edge_speed(px(200.0), length, inner), px(0.0));
        // In the inner zone: the slowest speed at its start.
        assert!((edge_speed(px(384.05), length, inner).0 - MIN_SPEED).abs() < 0.2);
        let near = edge_speed(px(410.0), length, inner);
        let far = edge_speed(px(450.0), length, inner);
        assert!(near.0 > MIN_SPEED && far.0 > near.0);
        assert_eq!(edge_speed(px(1000.0), length, inner), px(MAX_SPEED));
        assert_eq!(edge_speed(px(-1000.0), length, inner), px(-MAX_SPEED));
        assert!(edge_speed(px(-10.0), length, inner).0 < -MIN_SPEED);
        // Without an inner zone only past the edges.
        assert_eq!(edge_speed(px(0.0), length, px(0.0)), px(0.0));
        assert_eq!(edge_speed(px(400.0), length, px(0.0)), px(0.0));
        assert!(edge_speed(px(-1.0), length, px(0.0)).0 < 0.0);
        assert_eq!(edge_speed(px(5.0), px(0.0), inner), px(0.0));
    }
}
