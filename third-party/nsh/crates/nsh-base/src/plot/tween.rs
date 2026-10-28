//! The move of a plot's linear axis to a new domain (`motion.update`), as
//! d3 transitions a scale's domain: the domain shown is interpolated from
//! the old one to the new one on the platform's animator, and everything
//! placed on the axis goes where the interpolated scale puts it, so every
//! mark keeps its shape while the scale moves and what comes in with the
//! new domain (a new row) moves with the rest.
//!
//! The marks place their points on the new scale once; a place `at` on
//! it shows at `scale * at + offset`, two nodes of the graph the domain's
//! two ends drive: a scale's map of one domain is an affine map of its map
//! of another, along each axis. The marks' canvases record their paths
//! through that transform while a move runs (their strokes unscaled, as a
//! canvas transforms a path's points when it adds them), bars and bound
//! views (the hover's parts, a line's dots) derive their places from the
//! two nodes. No JS runs and nothing is recorded per frame.

use nsh_core::{
    element::{AnimationOperand, Timing},
    prelude::*,
};

use super::scale::{AxisMap, Linear};

/// A linear axis's move to a new domain: the domain shown, which the
/// animator moves, and where a place on the new scale shows.
#[derive(Clone, Copy)]
pub(super) struct Tween {
    /// The ends of the domain shown, in the units of `basis`.
    lo: AnimatedValue,
    hi: AnimatedValue,
    /// The new domain's start and length, in those units, and the start
    /// and length of the range.
    to_lo: AnimatedValue,
    to_span: AnimatedValue,
    start: AnimatedValue,
    length: AnimatedValue,
    /// A place `at` on the new scale shows at `scale * at + offset` (1 and
    /// 0 at rest).
    scale: AnimatedNode,
    offset: AnimatedNode,
    /// A move runs: the marks record through it.
    pub(super) moving: Signal<bool>,
    /// The origin and unit the domains are measured in while moves follow
    /// each other: the animator's numbers are `f32`, which keep a domain of
    /// prices or of times in milliseconds only measured from where it is.
    basis: Stored<(f64, f64)>,
    /// The axis's last linear map.
    last: Stored<Option<Linear>>,
}

impl Tween {
    /// An axis at rest.
    pub(super) fn new() -> Self {
        let (lo, hi) = (animated_value(0.0), animated_value(1.0));
        let (to_lo, to_span) = (animated_value(0.0), animated_value(1.0));
        let (start, length) = (animated_value(0.0), animated_value(0.0));
        // The scale shown places `v` at `start + (v - lo) / (hi - lo) *
        // length`; the new one put it at `at = start + (v - to_lo) /
        // to_span * length`: `scale * at + offset`.
        let span = hi.sub(&lo);
        let scale = to_span.div(&span);
        let offset = start
            .sub(&start.mul(&scale))
            .add(&to_lo.sub(&lo).mul(&length).div(&span));
        Self {
            lo,
            hi,
            to_lo,
            to_span,
            start,
            length,
            scale,
            offset,
            moving: signal(false),
            basis: stored((0.0, 1.0)),
            last: stored(None),
        }
    }

    /// Where a place on the new scale shows now (a number or a node).
    pub(super) fn shown(&self, at: impl Into<AnimationOperand>) -> AnimatedNode {
        self.scale.mul(at).add(&self.offset)
    }

    /// How far a place on the new scale shows from it now: what moves a
    /// view laid out there.
    pub(super) fn moved(&self, at: impl Into<AnimationOperand>) -> AnimatedNode {
        self.scale.sub(1.0).mul(at).add(&self.offset)
    }

    /// The length a length on the new scale shows at now.
    pub(super) fn stretched(&self, length: impl Into<AnimationOperand>) -> AnimatedNode {
        self.scale.mul(length)
    }

    /// The nodes a canvas transform takes along this axis: its scale and
    /// offset.
    pub(super) fn transform(&self) -> (AnimatedNode, AnimatedNode) {
        (self.scale, self.offset)
    }

    /// The axis places values by `map` now: from the last linear map, its
    /// domain moves to the new one over `timing` (from where it shows, if
    /// a move runs). At once without a timing, with reduced motion, for a
    /// new range (the plot's size: nothing moves for it), a domain of one
    /// value at either end, or another kind of scale.
    pub(super) fn follow(&self, map: AxisMap, timing: Option<Timing>) {
        let to = match map {
            AxisMap::Linear(linear) => Some(linear),
            _ => None,
        };
        let Some(from) = self.last.get() else {
            self.last.replace(to);
            return self.rest();
        };
        self.last.replace(to);
        let Some(to) = to else { return self.rest() };
        if from == to {
            return;
        }
        let ([f0, f1], [t0, t1], range) = (from.domain(), to.domain(), to.range());
        let movable = from.range() == range && range[0] != range[1] && f1 > f0 && t1 > t0;
        let timing = timing.filter(|t| t.duration_ms > 0.0 && movable && !reduce_motion());
        let Some(timing) = timing else {
            return self.rest();
        };
        if !self.moving.get_untracked() {
            // From the old domain: 0 to 1 in its own units.
            self.basis.replace((f0, f1 - f0));
            self.lo.set(0.0);
            self.hi.set(1.0);
        }
        let (origin, unit) = self.basis.get();
        let (lo, hi) = (((t0 - origin) / unit) as f32, ((t1 - origin) / unit) as f32);
        self.to_lo.set(lo);
        self.to_span.set(hi - lo);
        self.start.set(range[0]);
        self.length.set(range[1] - range[0]);
        if !self.moving.get_untracked() {
            self.moving.set(true);
        }
        drop(self.lo.timing_with(lo, timing));
        let end = self.hi.timing_with(hi, timing);
        let this = *self;
        spawn(async move {
            // Stopped by a newer move or a jump: that one ends it.
            if end.await {
                this.rest();
            }
        });
    }

    /// No move runs: places show where the new scale puts them.
    fn rest(&self) {
        if !self.moving.get_untracked() {
            return;
        }
        self.moving.set(false);
        for (value, at) in [
            (self.lo, 0.0),
            (self.hi, 1.0),
            (self.to_lo, 0.0),
            (self.to_span, 1.0),
            (self.start, 0.0),
            (self.length, 0.0),
        ] {
            value.set(at);
        }
    }
}
