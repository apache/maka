//! Runs the native animation graph on the main thread, driven by a
//! `CADisplayLink` that only runs while something animates.

use nsh_core::animation::{AnimationOp, AnimationValue, Finished, Graph, NodeId};
use objc2::{rc::Retained, sel};
use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::CADisplayLink;

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
    link.setPaused(true);
    // SAFETY: the main run loop and standard modes.
    unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
    link
}

impl Drop for Animator {
    fn drop(&mut self) {
        self.link.invalidate();
    }
}
