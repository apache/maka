//! Scrolling on its own while a drag selects past the viewport's edge: what
//! the `Editor` and the `RichEditor` share of it.

use nsh_core::{
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
