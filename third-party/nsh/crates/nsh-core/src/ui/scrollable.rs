//! How scroll views and lists scroll ([`Scrollable`]): the behavior props
//! and scroll events `Scroll` and `List` share in TS
//! (`ScrollingHostProps`).

use super::{
    AnimatedValue, Element, IntoListener, IntoReactive, Listener, ScrollEvent, ScrollIntent,
    events::{self, Decode},
    host,
};
use crate::{
    EdgeInsets, EventKind, KeyboardDismissMode, KeyboardTaps, Prop, ScrollProp, SnapAlignment,
    geometry::{Point, Points},
};

/// How an element scrolls: [`super::Scroll`], [`super::VirtualList`] and
/// [`super::ListElement`] (the app's rows a component places). The
/// direction and the indicator are [`super::Scroll::horizontal`] /
/// [`super::ListLayout::horizontal`] and their `scrollbar`.
pub trait Scrollable: Element {
    #[doc(hidden)]
    fn set_scroll_prop(mut self, prop: Prop) -> Self {
        host::set(self.node(), prop);
        self
    }

    #[doc(hidden)]
    fn listen_scroll<T: ?Sized + ToOwned + 'static>(
        mut self,
        kind: EventKind,
        listener: Listener<T>,
        decode: Decode<T>,
    ) -> Self {
        self.node()
            .handlers
            .push((kind, events::typed(listener, decode)));
        self
    }

    /// Stops on multiples of its size (TS: `pagingEnabled`).
    fn paging(mut self, paging: impl IntoReactive<bool>) -> Self {
        host::bind_prop(self.node(), paging, |paging| {
            Prop::Scroll(ScrollProp::Paging(paging))
        });
        self
    }

    /// Stops on multiples of `interval` (TS: `snapToInterval`; 0: off).
    fn snap_interval(mut self, interval: impl IntoReactive<Points>) -> Self {
        host::bind_prop(self.node(), interval, |interval: Points| {
            Prop::Scroll(ScrollProp::SnapInterval(interval))
        });
        self
    }

    /// Stops at these offsets (TS: `snapToOffsets`).
    fn snap_offsets(mut self, offsets: impl IntoReactive<Vec<Points>>) -> Self {
        host::bind_prop(self.node(), offsets, |offsets: Vec<Points>| {
            Prop::Scroll(ScrollProp::SnapOffsets(offsets))
        });
        self
    }

    /// Where a snapped item sits in the viewport (TS: `snapToAlignment`).
    fn snap_alignment(mut self, alignment: impl IntoReactive<SnapAlignment>) -> Self {
        host::bind_prop(self.node(), alignment, |alignment| {
            Prop::Scroll(ScrollProp::SnapAlignment(alignment))
        });
        self
    }

    /// A fling moves one snap point at most (TS: `disableIntervalMomentum`).
    fn disable_interval_momentum(mut self, disable: impl IntoReactive<bool>) -> Self {
        host::bind_prop(self.node(), disable, |disable| {
            Prop::Scroll(ScrollProp::DisableIntervalMomentum(disable))
        });
        self
    }

    /// How fast a fling slows down: the velocity kept per millisecond (TS:
    /// `decelerationRate`; 0.99 is `"fast"`, 0.998 `"normal"`).
    fn deceleration(mut self, rate: impl IntoReactive<f32>) -> Self {
        host::bind_prop(self.node(), rate, |rate| {
            Prop::Scroll(ScrollProp::Deceleration(rate))
        });
        self
    }

    /// The user can scroll it (default yes; TS: `scrollable`).
    fn scrollable(mut self, enabled: impl IntoReactive<bool>) -> Self {
        host::bind_prop(self.node(), enabled, |enabled| {
            Prop::Native(crate::NativeProp::Scrollable(enabled))
        });
        self
    }

    /// Bounces at the ends (default yes).
    fn bounces(mut self, bounces: impl IntoReactive<bool>) -> Self {
        host::bind_prop(self.node(), bounces, |bounces| {
            Prop::Scroll(ScrollProp::Bounces(bounces))
        });
        self
    }

    /// Space around the content that scrolls with it.
    fn content_inset(mut self, insets: impl IntoReactive<EdgeInsets>) -> Self {
        host::bind_prop(self.node(), insets, |insets| {
            Prop::Scroll(ScrollProp::ContentInset(insets))
        });
        self
    }

    /// Where it starts (set once).
    fn content_offset(self, offset: Point<Points>) -> Self {
        self.set_scroll_prop(Prop::Scroll(ScrollProp::ContentOffset(offset)))
    }

    /// Taps while the keyboard shows: dismiss it, or reach the content (TS:
    /// `keyboardShouldPersistTaps`).
    fn keyboard_taps(mut self, taps: impl IntoReactive<KeyboardTaps>) -> Self {
        host::bind_prop(self.node(), taps, |taps| {
            Prop::Scroll(ScrollProp::KeyboardTaps(taps))
        });
        self
    }

    /// Dragging dismisses the keyboard (TS: `keyboardDismissMode`).
    fn keyboard_dismiss_mode(mut self, mode: impl IntoReactive<KeyboardDismissMode>) -> Self {
        host::bind_prop(self.node(), mode, Prop::KeyboardDismissMode);
        self
    }

    /// At most one `on_scroll` per `ms` milliseconds (default: every frame;
    /// TS: `scrollEventThrottle`).
    fn event_throttle(mut self, ms: impl IntoReactive<f32>) -> Self {
        host::bind_prop(self.node(), ms, |ms| {
            Prop::Scroll(ScrollProp::EventThrottle(ms))
        });
        self
    }

    /// Shows the pull-to-refresh spinner (start it from
    /// [`Self::on_refresh`], clear it when done).
    fn refreshing(mut self, refreshing: impl IntoReactive<bool>) -> Self {
        host::bind_prop(self.node(), refreshing, |refreshing| {
            Prop::Refreshing(refreshing)
        });
        self
    }

    /// Follows the scroll offset (along its axis) with an animated value:
    /// headers that shrink or fade, parallax, with no engine work per frame
    /// (TS: `scrollValue`).
    fn scroll_value(mut self, value: &AnimatedValue) -> Self {
        if let Some(node) = value.node().live() {
            host::set(self.node(), Prop::ScrollValue(Some(node.id())));
            self.node().attrs.bound.push(node);
        }
        self
    }

    /// Follows how far it is pulled past its top with an animated value (0
    /// at rest, growing with the pull; the room kept above the content
    /// while it refreshes): an app's own pull-to-refresh indicator, with no
    /// engine work per frame (TS: `pullValue`).
    fn pull_value(mut self, value: &AnimatedValue) -> Self {
        if let Some(node) = value.node().live() {
            host::set(self.node(), Prop::PullValue(Some(node.id())));
            self.node().attrs.bound.push(node);
        }
        self
    }

    /// The app draws its own pull-to-refresh indicator, `height` points
    /// tall (from [`Self::pull_value`]): the platform's spinner is hidden, a
    /// pull refreshes once it reaches `height`, and refreshing keeps `height`
    /// above the content (`None`: the platform's spinner; TS:
    /// `refreshIndicator`).
    fn refresh_indicator(mut self, height: impl IntoReactive<Option<Points>>) -> Self {
        host::bind_prop(self.node(), height, |height: Option<Points>| {
            Prop::Scroll(ScrollProp::RefreshIndicator(height))
        });
        self
    }

    /// Pulled down to refresh (enables pull to refresh).
    fn on_refresh<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen_scroll(EventKind::Refresh, listener.into_listener(), events::unit)
    }

    /// It moved (at most once per frame, [`Self::event_throttle`]).
    fn on_scroll<M>(self, listener: impl IntoListener<ScrollEvent, M>) -> Self {
        self.listen_scroll(EventKind::Scroll, listener.into_listener(), events::scroll)
    }

    /// The user requested scrolling, before the offset changes, including at a
    /// boundary. A drag emits once at its start; programmatic scrolling does not.
    fn on_scroll_intent<M>(self, listener: impl IntoListener<ScrollIntent, M>) -> Self {
        self.listen_scroll(
            EventKind::ScrollIntent,
            listener.into_listener(),
            events::scroll_intent,
        )
    }

    /// It became focused.
    fn on_focus<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen_scroll(EventKind::Focus, listener.into_listener(), events::unit)
    }

    /// It lost focus.
    fn on_blur<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.listen_scroll(EventKind::Blur, listener.into_listener(), events::unit)
    }

    /// The user started dragging it.
    fn on_scroll_drag_start<M>(self, listener: impl IntoListener<Point<Points>, M>) -> Self {
        self.listen_scroll(
            EventKind::ScrollDragStart,
            listener.into_listener(),
            events::offset,
        )
    }

    /// The user let go.
    fn on_scroll_drag_end<M>(self, listener: impl IntoListener<Point<Points>, M>) -> Self {
        self.listen_scroll(
            EventKind::ScrollDragEnd,
            listener.into_listener(),
            events::offset,
        )
    }

    /// It started gliding after a fling.
    fn on_momentum_start<M>(self, listener: impl IntoListener<Point<Points>, M>) -> Self {
        self.listen_scroll(
            EventKind::MomentumStart,
            listener.into_listener(),
            events::offset,
        )
    }

    /// It stopped gliding.
    fn on_momentum_end<M>(self, listener: impl IntoListener<Point<Points>, M>) -> Self {
        self.listen_scroll(
            EventKind::MomentumEnd,
            listener.into_listener(),
            events::offset,
        )
    }

    /// It came to rest.
    fn on_scroll_end<M>(self, listener: impl IntoListener<Point<Points>, M>) -> Self {
        self.listen_scroll(
            EventKind::ScrollEnd,
            listener.into_listener(),
            events::offset,
        )
    }
}

crate::static_reactive!(SnapAlignment: SnapAlignment);
crate::static_reactive!(KeyboardTaps: KeyboardTaps);
crate::static_reactive!(KeyboardDismissMode: KeyboardDismissMode);
crate::static_reactive!(Vec<f32>: Vec<f32>);
crate::static_reactive!(Vec<Points>: Vec<Points>);
