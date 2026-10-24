//! Runs the native animation graph on the main thread, driven by a
//! `CADisplayLink` that only runs while something animates.
//!
//! Both display links ask for the screen's full rate ([`full_rate`]): on a
//! ProMotion iPhone a link left at its default runs at 60 Hz, and above
//! 60 Hz only in an app whose `Info.plist` sets
//! `CADisableMinimumFrameDurationOnPhone` (`nsh package` and the
//! development host do).

use nsh_core::animation::{AnimationOp, AnimationValue, Finished, Graph, NodeId};
use objc2::{MainThreadMarker, rc::Retained, sel};
use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::{CADisplayLink, CAFrameRateRange};
use objc2_ui_kit::UIScreen;

use crate::target::EventTarget;

pub(crate) struct Animator {
    graph: Graph,
    finished: Vec<Finished>,
    link: Retained<CADisplayLink>,
    running: bool,
}

impl Animator {
    pub(crate) fn new(target: &EventTarget) -> Self {
        // SAFETY: `tick:` is implemented by `EventTarget`, which outlives the
        // link (the link is invalidated in `Drop`).
        let link = unsafe { CADisplayLink::displayLinkWithTarget_selector(target, sel!(tick:)) };
        full_rate(&link);
        link.setPaused(true);
        // SAFETY: the main run loop and standard modes. Common modes keep
        // animations running while a scroll view is tracking.
        unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
        Self {
            graph: Graph::default(),
            finished: Vec::new(),
            link,
            running: false,
        }
    }

    pub(crate) fn apply(&mut self, op: AnimationOp) {
        self.graph.apply(op, &mut self.finished);
        self.update_link();
    }

    /// Sets a value from a gesture or a scroll position.
    pub(crate) fn set(&mut self, node: NodeId, value: f32) {
        self.graph.set(node, value, &mut self.finished);
        self.update_link();
    }

    /// The scroll view whose scroll value is `node` came to rest: the
    /// snapping values that follow it settle.
    pub(crate) fn settle(&mut self, node: NodeId) {
        if self.graph.settle(node) {
            self.update_link();
        }
    }

    pub(crate) fn value(&self, node: NodeId) -> f32 {
        self.graph.value(node).unwrap_or(0.0)
    }

    pub(crate) fn eval(&self, node: NodeId) -> AnimationValue {
        self.graph.eval(node)
    }

    /// Advances to the display link's target time. Returns true if values
    /// changed.
    pub(crate) fn tick(&mut self) -> bool {
        let changed = self
            .graph
            .tick(self.link.targetTimestamp(), &mut self.finished);
        self.update_link();
        changed
    }

    /// Whether the graph animates.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.graph.is_animating()
    }

    pub(crate) fn take_finished(&mut self) -> Vec<Finished> {
        std::mem::take(&mut self.finished)
    }

    fn update_link(&mut self) {
        let animating = self.graph.is_animating();
        if animating != self.running {
            self.running = animating;
            self.link.setPaused(!animating);
        }
    }
}

/// A paused display link calling `frame:` on `target`, unpaused for one
/// frame when JS calls `requestAnimationFrame`.
pub(crate) fn frame_link(target: &EventTarget) -> Retained<CADisplayLink> {
    // SAFETY: `frame:` is implemented by `EventTarget`, which outlives the
    // link (the mounter invalidates it when dropped).
    let link = unsafe { CADisplayLink::displayLinkWithTarget_selector(target, sel!(frame:)) };
    full_rate(&link);
    link.setPaused(true);
    // SAFETY: the main run loop and standard modes.
    unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
    link
}

/// Has `link` fire at the screen's `maximumFramesPerSecond` (120 Hz on
/// ProMotion), at least 80 there: animations, scroll-driven values and JS
/// frames move at the rate the system's own scrolling does.
pub(crate) fn full_rate(link: &CADisplayLink) {
    // The main screen: the links are made before the surface is in a
    // window, and every iOS device has one screen rate.
    #[allow(deprecated)]
    let max = MainThreadMarker::new()
        .map_or(60, |mtm| UIScreen::mainScreen(mtm).maximumFramesPerSecond())
        .max(1) as f32;
    link.setPreferredFrameRateRange(CAFrameRateRange {
        minimum: max.min(80.0),
        maximum: max,
        preferred: max,
    });
}

impl Drop for Animator {
    fn drop(&mut self) {
        self.link.invalidate();
    }
}
