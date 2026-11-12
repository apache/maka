//! Overlays (`<Overlay>` of `nsh`, [`crate::element::overlay`]): views shown on
//! top of the root view they are in (the surface, or the dialog around
//! them), outside their parent's layout and clipping, while staying where
//! the app put them for everything else (reactive context, events,
//! lifetime).
//!
//! The core places them ([`Core`](crate::Core)'s `core/overlay.rs`):
//! without an anchor an overlay is laid out as `position: fixed` in its
//! root view (its insets, size and margins against the root view's box);
//! with one it goes on a side of the anchor ([`place`]): the side asked
//! for, the other one when it does not fit there, kept inside the root
//! view's safe area. An overlay whose size follows the room it was told
//! (`onPosition`'s `available`, a select's list) chooses its side at its
//! natural size, not the size that room gave it ([`place_fitted`]). This
//! module has the options and that placement, which has no state.
//!
//! A hint overlay (a tooltip, [`OverlayConfig::hint`]) is shown by the
//! core itself: on the desktops, once the pointer rested on its anchor (its
//! parent without one) for the hint's delay, until the pointer leaves the
//! anchor or presses it, as GPUI's tooltips are. An element's `tooltip`
//! ([`TooltipContent`]) is one the core makes.

use std::time::Duration;

use crate::{
    geometry::{Bounds, Point, Points, Size, point, rect, size},
    ops::NodeId,
};

/// What an overlay is placed against (`anchor`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum OverlayAnchor {
    /// Nothing: the overlay is laid out in its root view as a
    /// `position: fixed` box.
    #[default]
    None,
    /// A view: placed on a side of its frame, following it as it moves
    /// (scrolls, layout changes).
    Node(NodeId),
    /// A point in the root view's coordinates (touches' `pageX` /
    /// `pageY`): a menu opened where the pointer is.
    Point(Point<Points>),
    /// A box in the root view's coordinates: an input's caret
    /// (`onCaretMove`'s `pageBounds`), where an `@` mention's
    /// suggestions open.
    Bounds(Bounds<Points>),
    /// What a view draws: the box around its children with the view's
    /// padding and border around them (the view itself while it has no
    /// children). A trigger wrapped in a view its parent
    /// stretches is placed against what shows, not the stretched wrapper.
    /// The element that takes a component's slot (the app's, from TSX or
    /// Rust) goes by its own box: the slot's holder around it is that
    /// wrapper.
    Content(NodeId),
    /// Beside a view inside another, as a submenu beside its row: lined
    /// up with `node` along the side it goes on, and outside `edges` (the
    /// menu around the row) across it, so the gap is measured from the
    /// menu's edge, not from the row inside its padding.
    Beside {
        /// The view it lines up with.
        node: NodeId,
        /// The view whose edges it goes outside of.
        edges: NodeId,
    },
}

/// The resolved anchor and side delivered to native renderers for grid projection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacedAnchor {
    /// The anchor's frame in its root view's point coordinates.
    pub bounds: Bounds<Points>,
    /// The anchored view, when the anchor is its whole frame.
    pub node: Option<NodeId>,
    /// The final side, including a placement flipped to fit the viewport.
    pub placement: Placement,
}

/// The side of the anchor an overlay goes on (`placement`), as
/// `gpui-base`'s `Placement`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, nsh_macros::PropEnum)]
pub enum Placement {
    /// Above the anchor.
    Top,
    /// Below the anchor (default).
    #[default]
    Bottom,
    /// Left of the anchor.
    Left,
    /// Right of the anchor.
    Right,
}

impl Placement {
    /// The other side.
    pub fn opposite(self) -> Placement {
        match self {
            Placement::Top => Placement::Bottom,
            Placement::Bottom => Placement::Top,
            Placement::Left => Placement::Right,
            Placement::Right => Placement::Left,
        }
    }

    /// Left or right of the anchor.
    pub fn is_horizontal(self) -> bool {
        matches!(self, Placement::Left | Placement::Right)
    }

    /// Its name in JS (`"top"`, ...).
    pub fn name(self) -> &'static str {
        match self {
            Placement::Top => "top",
            Placement::Bottom => "bottom",
            Placement::Left => "left",
            Placement::Right => "right",
        }
    }
}

/// How an overlay lines up with its anchor along the side it is on
/// (`align`), as `gpui-base`'s `Align`: `start` and `end` follow the
/// layout direction above or below the anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, nsh_macros::PropEnum)]
pub enum Align {
    /// With the anchor's leading edge (its top on the left and right).
    Start,
    /// Centered on the anchor (default).
    #[default]
    Center,
    /// With the anchor's trailing edge (its bottom on the left and right).
    End,
}

/// How an overlay is placed.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct OverlayConfig {
    /// What it is placed against.
    pub anchor: OverlayAnchor,
    /// The side of the anchor it prefers.
    pub placement: Placement,
    /// How it lines up with the anchor.
    pub align: Align,
    /// The gap between the anchor and the overlay.
    pub offset: Points,
    /// The distance it keeps from the edges of the root view's safe area.
    pub margin: Points,
    /// A hint (a tooltip), shown after the pointer rested on the anchor
    /// this long: placed against its parent when it has no anchor, shown
    /// while the pointer stays on the anchor (desktops) or [`Self::open`]
    /// says, never taking the pointer itself. `None`: shown whenever its
    /// views around it are.
    pub hint: Option<Duration>,
    /// A hint shown (`Some(true)`) or hidden (`Some(false)`) whatever the
    /// pointer does: its owner decides from what the hint asks for
    /// (`EventKind::Show` / `EventKind::Dismiss`). `None`: the pointer
    /// decides.
    pub open: Option<bool>,
    /// A view inside it laid over the anchor, as a select's list opens
    /// with the selected item over the trigger: the overlay starts where
    /// the anchor does, with that view's middle on the anchor's, kept
    /// inside the area, instead of on a side. Where the view is in the
    /// overlay is kept while the overlay keeps its size, so scrolling its
    /// content does not move it. `None`: on a side, as `placement` says.
    pub cover: Option<NodeId>,
}

/// The delay of a hint before it shows (500 ms, as the desktops' tooltips).
pub const HINT_DELAY: Duration = Duration::from_millis(500);

/// What an element's `tooltip` shows, in a hint overlay the core makes
/// above the element (or the element itself when it is a hint overlay) ([`OverlayConfig::hint`]).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum TooltipContent {
    /// No tooltip.
    #[default]
    None,
    /// An element (JS's: a node it made), shown as it is.
    Node(NodeId),
}

/// Where [`place`] put an overlay.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct Placed {
    /// Its top left corner in the root view.
    pub origin: Point<Points>,
    /// The side it went on: the one asked for, or the other one when only
    /// that one has room.
    pub placement: Placement,
    /// The room on that side, inside the area it is kept in: what a menu
    /// may grow to.
    pub available: Size<Points>,
}

/// Places an overlay of `extent` on a side of `anchor` (both in the root
/// view's coordinates) as `config` says, kept inside `area` (the root
/// view's safe area less the margin) as far as it fits: on the side asked
/// for when it has room there, else on the other side when that one has,
/// else on the side with more room; then moved along the side to stay in
/// `area`. `rtl`: `start` and `end` mirror above and below the anchor.
pub fn place(
    anchor: Bounds<Points>,
    extent: Size<Points>,
    area: Bounds<Points>,
    config: &OverlayConfig,
    rtl: bool,
) -> Placed {
    let (w, h) = (extent.width.0, extent.height.0);
    let (left, top) = (anchor.origin.x.0, anchor.origin.y.0);
    let (right, bottom) = (anchor.right().0, anchor.bottom().0);
    let (area_left, area_top) = (area.origin.x.0, area.origin.y.0);
    let (area_right, area_bottom) = (area.right().0, area.bottom().0);
    let gap = config.offset.0;
    // The room on each side.
    let room = |side: Placement| match side {
        Placement::Top => top - gap - area_top,
        Placement::Bottom => area_bottom - bottom - gap,
        Placement::Left => left - gap - area_left,
        Placement::Right => area_right - right - gap,
    };
    let needs = |side: Placement| if side.is_horizontal() { w } else { h };
    let asked = config.placement;
    let other = asked.opposite();
    let fits = |side| room(side) >= needs(side);
    let side = if !fits(asked) && (fits(other) || room(other) > room(asked)) {
        other
    } else {
        asked
    };
    let (start, end) = if side.is_horizontal() || !rtl {
        (Align::Start, Align::End)
    } else {
        (Align::End, Align::Start)
    };
    let cross = |lo: f32, hi: f32, len: f32| match config.align {
        a if a == start => lo,
        a if a == end => hi - len,
        _ => (lo + hi - len) / 2.0,
    };
    let (x, y) = match side {
        Placement::Top => (cross(left, right, w), top - gap - h),
        Placement::Bottom => (cross(left, right, w), bottom + gap),
        Placement::Left => (left - gap - w, cross(top, bottom, h)),
        Placement::Right => (right + gap, cross(top, bottom, h)),
    };
    // Inside the area as far as it fits; from its start when it is larger.
    let keep = |v: f32, lo: f32, hi: f32, len: f32| v.min(hi - len).max(lo);
    let origin = point(
        Points(keep(x, area_left, area_right, w)),
        Points(keep(y, area_top, area_bottom, h)),
    );
    let room = room(side).max(0.0);
    let available = if side.is_horizontal() {
        size(Points(room), Points((area_bottom - area_top).max(0.0)))
    } else {
        size(Points((area_right - area_left).max(0.0)), Points(room))
    };
    Placed {
        origin,
        placement: side,
        available,
    }
}

/// Places an overlay whose size follows the room it is given (its max
/// size along the side is the [`Placed::available`] it was told, as a
/// list that scrolls past it), as [`place`] does: the side is chosen at
/// `natural`, its size without that limit, so one taller than the room
/// below goes above when it fits there whole, however short the room
/// below has made it; then it is placed at the size it takes on that side,
/// `natural` limited to the room there (on the side with more room when it
/// fits on neither).
pub fn place_fitted(
    anchor: Bounds<Points>,
    natural: Size<Points>,
    area: Bounds<Points>,
    config: &OverlayConfig,
    rtl: bool,
) -> Placed {
    let chosen = place(anchor, natural, area, config, rtl);
    let shown = if chosen.placement.is_horizontal() {
        size(natural.width.min(chosen.available.width), natural.height)
    } else {
        size(natural.width, natural.height.min(chosen.available.height))
    };
    // It fits on that side at that size: `place` keeps it there.
    let config = OverlayConfig {
        placement: chosen.placement,
        ..*config
    };
    place(anchor, shown, area, &config, rtl)
}

/// `bounds` less `inset` on every side (never negative).
pub(crate) fn inset(bounds: Bounds<Points>, edges: [f32; 4]) -> Bounds<Points> {
    let [top, right, bottom, left] = edges;
    rect(
        bounds.origin.x.0 + left,
        bounds.origin.y.0 + top,
        (bounds.size.width.0 - left - right).max(0.0),
        (bounds.size.height.0 - top - bottom).max(0.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::px;

    fn config(placement: Placement, align: Align) -> OverlayConfig {
        OverlayConfig {
            placement,
            align,
            offset: px(4.0),
            ..OverlayConfig::default()
        }
    }

    const AREA: Bounds<Points> = Bounds {
        origin: Point {
            x: Points(0.0),
            y: Points(0.0),
        },
        size: Size {
            width: Points(400.0),
            height: Points(800.0),
        },
    };

    #[test]
    fn goes_on_the_side_asked_for() {
        let anchor = rect(100.0, 100.0, 80.0, 40.0);
        let placed = place(
            anchor,
            size(px(120.0), px(60.0)),
            AREA,
            &config(Placement::Bottom, Align::Start),
            false,
        );
        assert_eq!(placed.placement, Placement::Bottom);
        assert_eq!(placed.origin, point(px(100.0), px(144.0)));
        assert_eq!(placed.available, size(px(400.0), px(656.0)));
        let centered = place(
            anchor,
            size(px(120.0), px(60.0)),
            AREA,
            &config(Placement::Top, Align::Center),
            false,
        );
        assert_eq!(centered.origin, point(px(80.0), px(36.0)));
        let end = place(
            anchor,
            size(px(120.0), px(60.0)),
            AREA,
            &config(Placement::Right, Align::End),
            false,
        );
        assert_eq!(end.origin, point(px(184.0), px(80.0)));
    }

    #[test]
    fn flips_when_only_the_other_side_has_room() {
        let anchor = rect(100.0, 740.0, 80.0, 40.0);
        let placed = place(
            anchor,
            size(px(120.0), px(60.0)),
            AREA,
            &config(Placement::Bottom, Align::Start),
            false,
        );
        assert_eq!(placed.placement, Placement::Top);
        assert_eq!(placed.origin, point(px(100.0), px(676.0)));
        // No room on either side: the larger one, kept inside.
        let tall = place(
            rect(0.0, 300.0, 50.0, 50.0),
            size(px(100.0), px(600.0)),
            AREA,
            &config(Placement::Bottom, Align::Start),
            false,
        );
        assert_eq!(tall.placement, Placement::Bottom);
        assert_eq!(tall.origin.y, px(200.0));
    }

    #[test]
    fn fitted_overlays_choose_their_side_at_their_natural_size() {
        let config = config(Placement::Bottom, Align::Start);
        // Fits below: stays there, at its size.
        let below = place_fitted(
            rect(100.0, 100.0, 80.0, 40.0),
            size(px(120.0), px(300.0)),
            AREA,
            &config,
            false,
        );
        assert_eq!(below.placement, Placement::Bottom);
        assert_eq!(below.origin, point(px(100.0), px(144.0)));
        assert_eq!(below.available, size(px(400.0), px(656.0)));
        // Taller than the room below (156), fits above (596): above, whole.
        let anchor = rect(100.0, 600.0, 80.0, 40.0);
        let above = place_fitted(anchor, size(px(120.0), px(400.0)), AREA, &config, false);
        assert_eq!(above.placement, Placement::Top);
        assert_eq!(above.origin, point(px(100.0), px(196.0)));
        assert_eq!(above.available, size(px(400.0), px(596.0)));
        // Fits on neither side: the one with more room (below, 446), its
        // size limited to that room, beside the anchor rather than over it.
        let anchor = rect(100.0, 300.0, 80.0, 50.0);
        let neither = place_fitted(anchor, size(px(120.0), px(700.0)), AREA, &config, false);
        assert_eq!(neither.placement, Placement::Bottom);
        assert_eq!(neither.origin, point(px(100.0), px(354.0)));
        assert_eq!(neither.available, size(px(400.0), px(446.0)));
        let config = OverlayConfig {
            placement: Placement::Top,
            ..config
        };
        // Asked above with less room there (296): below all the same.
        let neither = place_fitted(anchor, size(px(120.0), px(700.0)), AREA, &config, false);
        assert_eq!(neither.placement, Placement::Bottom);
        assert_eq!(neither.origin.y, px(354.0));
        // Beside the anchor: its width decides, limited the same way.
        let config = OverlayConfig {
            placement: Placement::Right,
            ..config
        };
        let anchor = rect(300.0, 100.0, 40.0, 40.0);
        let side = place_fitted(anchor, size(px(200.0), px(60.0)), AREA, &config, false);
        assert_eq!(side.placement, Placement::Left);
        assert_eq!(side.origin, point(px(96.0), px(100.0)));
    }

    #[test]
    fn stays_inside_the_area() {
        let anchor = rect(360.0, 100.0, 30.0, 30.0);
        let placed = place(
            anchor,
            size(px(120.0), px(60.0)),
            AREA,
            &config(Placement::Bottom, Align::Start),
            false,
        );
        assert_eq!(placed.origin.x, px(280.0));
        // Wider than the area: from its start.
        let wide = place(
            anchor,
            size(px(500.0), px(60.0)),
            AREA,
            &config(Placement::Bottom, Align::Center),
            false,
        );
        assert_eq!(wide.origin.x, px(0.0));
    }

    #[test]
    fn start_and_end_follow_the_direction() {
        let anchor = rect(100.0, 100.0, 80.0, 40.0);
        let placed = place(
            anchor,
            size(px(120.0), px(60.0)),
            AREA,
            &config(Placement::Bottom, Align::Start),
            true,
        );
        assert_eq!(placed.origin.x, px(60.0));
        // Left and right line up from the top whatever the direction.
        let side = place(
            anchor,
            size(px(50.0), px(60.0)),
            AREA,
            &config(Placement::Left, Align::Start),
            true,
        );
        assert_eq!(side.origin, point(px(46.0), px(100.0)));
    }
}
