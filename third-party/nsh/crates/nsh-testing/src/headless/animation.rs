//! The native animations of a headless app: the graph platforms run on
//! their UI thread (nsh-core's `animation`, platform-free), run here frame by
//! frame while anything animates, finished animations reported to the
//! engine as a platform reports them. Nothing is drawn: the values only
//! move, so what waits for an animation's end goes on.

use std::time::Duration;

use nsh_core::{
    MountItem, NodeId, Point, Points,
    animation::{Animator as Bindings, Finished},
    time::{Clock, Instant},
};

/// A display frame at 60 Hz.
pub(crate) const FRAME: Duration = Duration::from_micros(16_667);

pub(crate) struct Animator {
    /// The graph with its bindings to views, gestures and scroll views,
    /// as the desktop backends run it.
    graph: Bindings,
    /// When the graph's clock started (its times are seconds since).
    epoch: Instant,
    /// When the next frame is due, while anything animates.
    next: Option<Instant>,
    /// The app's clock, whose time the frames are at.
    clock: Clock,
}

impl Animator {
    /// An animator on `clock`, the app's.
    pub(crate) fn new(clock: Clock) -> Self {
        Self {
            graph: Bindings::default(),
            epoch: clock.now(),
            next: None,
            clock,
        }
    }

    /// Takes in one item of a batch: animation ops, gesture and scroll
    /// values.
    pub(crate) fn apply(&mut self, item: &MountItem) {
        self.graph.apply(item);
        if matches!(item, MountItem::Animation(_)) {
            self.wake();
        }
    }

    /// A scroll view moved: feeds its offset's value.
    pub(crate) fn scrolled(&mut self, id: NodeId, offset: Point<Points>) {
        if self.graph.scrolled(id, offset) {
            self.wake();
        }
    }

    /// Scroll view `id` came to rest: the snapping values that follow it
    /// settle.
    pub(crate) fn scroll_ended(&mut self, id: NodeId) {
        if self.graph.scroll_ended(id) {
            self.wake();
        }
    }

    /// A drag of view `id` began: grabbing its animating pan values stops
    /// them where they are.
    pub(crate) fn pan_began(&mut self, id: NodeId) {
        self.graph.pan_began(id);
        self.wake();
    }

    /// The drag of view `id` moved by `translation` since it began: its pan
    /// values follow.
    pub(crate) fn pan_moved(&mut self, id: NodeId, translation: Point<Points>) {
        self.graph.pan_moved(id, translation);
        self.wake();
    }

    /// View `id`'s pan values now, for `onPanStart` / `onPanEnd`.
    pub(crate) fn pan_values(&self, id: NodeId) -> (Option<f32>, Option<f32>) {
        self.graph.pan_values(id)
    }

    /// Starts the frames when something animates.
    fn wake(&mut self) {
        if self.graph.animating() && self.next.is_none() {
            self.next = Some(self.clock.now());
        }
    }

    /// Whether anything animates.
    pub(crate) fn running(&self) -> bool {
        self.next.is_some()
    }

    /// When the next frame is due, while anything animates.
    pub(crate) fn next_frame(&self) -> Option<Instant> {
        self.next
    }

    /// Runs the frames that are due.
    pub(crate) fn tick(&mut self) {
        let Some(next) = self.next else {
            return;
        };
        let now = self.clock.now();
        if now < next {
            return;
        }
        self.graph.tick((now - self.epoch).as_secs_f64());
        self.next = self.graph.animating().then(|| (next + FRAME).max(now));
    }

    /// The animations that finished since the last call.
    pub(crate) fn take_finished(&mut self) -> Vec<Finished> {
        std::mem::take(&mut self.graph.finished)
    }
}
