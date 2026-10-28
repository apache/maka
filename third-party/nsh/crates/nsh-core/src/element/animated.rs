//! Native animation values for Rust components (TS: `createAnimatedValue`,
//! `Animated.spring`, `interpolate`): nodes of the platform's animation
//! graph that styles, drags, scroll offsets and drawings are bound to, so
//! they move on the UI thread with no engine work per frame. Composed
//! animations ([`Animation`], TS: `Animated.sequence` and co.) run there
//! too, step after step.
//!
//! Ids are odd (JS gives its own nodes, animations and composites even
//! ones), so the graph, which indexes nodes by id, stays dense.
//!
//! [`AnimatedValue`] and [`AnimatedNode`] are `Copy` handles: the reactive
//! owner current when one is made (the component, a region, a row) keeps
//! its node, and releases it when it is disposed. Used after that, a
//! handle does nothing (its derivations are gone as well). What binds a
//! node keeps it while bound ([`LiveNode`]: an element's styles, drags and
//! scroll offsets, a drawing, a composed animation, a derived node's
//! inputs), so a binding in a region that outlives the handle's owner
//! goes on moving, and an animation running on it goes on running.
//! Listeners and tasks run under the owner that made them, so what they
//! make is that owner's too; deriving a node again under an owner that
//! has a handle of it returns that handle ([`Derived`]), so code run over
//! and over adds nothing. Made with no owner at all (outside any
//! component), a handle keeps its node as long as the surface, as a
//! signal made there lives as long as the graph.

use std::{
    cell::Cell,
    fmt,
    rc::{Rc, Weak},
};

use super::{
    AdaptiveColor,
    reactive::{Kept, Owner},
    task::{Action, Answer, Executor},
};
use crate::animation::{
    AnimationId, AnimationOp, Composite, Driver, Easing, Extrapolate, Keyframe, KeyframeTiming,
    MathOp, MotionChannel, MotionSpec, Operand, Output, StaggerFrom,
};

/// A node of the graph, released when the last of what holds it goes
/// (the owner of its handles, its bindings, the nodes derived from it).
pub(crate) struct Node {
    id: crate::animation::NodeId,
    executor: Weak<Executor>,
    /// The nodes it derives from, alive while it is: a chain such as
    /// `v.mul(TAU).sub(1.0)` keeps no handle of its middle node.
    _inputs: Vec<Rc<Node>>,
}

impl Node {
    fn new(
        executor: &Rc<Executor>,
        op: impl FnOnce(crate::animation::NodeId) -> AnimationOp,
        inputs: Vec<Rc<Node>>,
    ) -> Rc<Self> {
        let id = executor.next_animation_id();
        executor.act(Action::Animation(op(id)));
        Rc::new(Self {
            id,
            executor: Rc::downgrade(executor),
            _inputs: inputs,
        })
    }

    fn act(&self, op: AnimationOp) {
        if let Some(executor) = self.executor.upgrade() {
            executor.act(Action::Animation(op));
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.act(AnimationOp::Release { node: self.id });
    }
}

/// `op` (a node-making operation) making node `id`.
fn with_node(mut op: AnimationOp, id: crate::animation::NodeId) -> AnimationOp {
    match &mut op {
        AnimationOp::CreateValue { node, .. }
        | AnimationOp::CreateInterpolate { node, .. }
        | AnimationOp::CreateDiffClamp { node, .. }
        | AnimationOp::CreateMath { node, .. } => *node = id,
        _ => {}
    }
    op
}

/// Derived nodes by what made them ([`DerivedKey`]), while alive, with the
/// handles of each that owners keep: deriving a node again under an owner
/// that has a handle of it returns that handle, so doing it over and over
/// (in a listener, a binding run again) adds nothing.
#[derive(Default)]
pub(crate) struct Derived(Vec<DerivedNode>);

/// What makes a derived node: its operation (node id 0) and, for colors
/// that follow the appearance, the dark ones (the operation has the light
/// ones, whichever appearance is current), so interpolations sharing their
/// light colors are not one node, and neither are a constant one and an
/// adaptive one.
#[derive(Clone, PartialEq)]
struct DerivedKey {
    op: AnimationOp,
    dark: Option<Output>,
}

struct DerivedNode {
    key: DerivedKey,
    node: Weak<Node>,
    /// The live handles of it, by the owner keeping each.
    handles: Vec<(Owner, AnimatedNode)>,
}

impl Derived {
    /// The live node `key` made.
    fn entry(&mut self, key: &DerivedKey) -> Option<&mut DerivedNode> {
        self.0.retain(|d| d.node.strong_count() > 0);
        self.0.iter_mut().find(|d| d.key == *key)
    }
}

/// A value of the graph: [`AnimatedValue`] or [`AnimatedNode`], to bind
/// (`Styled::bind_opacity`) or derive from.
pub trait Animated {
    /// The node.
    fn animated_node(&self) -> AnimatedNode;
}

/// A node of the graph held while something is bound to it (an element's
/// style or gesture, a drawing, a composed animation): it outlives the
/// owner of the handle it came from for as long as it is held.
#[derive(Clone)]
pub(crate) struct LiveNode(Rc<Node>);

impl LiveNode {
    pub(crate) fn id(&self) -> crate::animation::NodeId {
        self.0.id
    }

    fn act(&self, op: AnimationOp) {
        self.0.act(op);
    }

    fn executor(&self) -> Option<Rc<Executor>> {
        self.0.executor.upgrade()
    }
}

impl PartialEq for LiveNode {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}

impl fmt::Debug for LiveNode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("LiveNode").field(&self.id()).finish()
    }
}

/// A node derived from values (an interpolation, arithmetic): bound like a
/// value, moving when they move. A `Copy` handle, kept by the owner it was
/// made under (see the module's docs).
#[derive(Clone, Copy)]
pub struct AnimatedNode {
    node: Kept<Node>,
    /// The node's id, for what names it (styles, equality) without
    /// reaching it.
    id: crate::animation::NodeId,
}

impl AnimatedNode {
    /// Keeps `node` in the current owner.
    fn keep(node: Rc<Node>) -> Self {
        let id = node.id;
        Self {
            node: Kept::new(node),
            id,
        }
    }

    /// A handle of no node (made from a handle whose owner is gone).
    fn gone() -> Self {
        Self {
            node: Kept::gone(),
            id: 0,
        }
    }

    pub(crate) fn id(&self) -> crate::animation::NodeId {
        self.id
    }

    /// The node, while the owner of the handle lives: what a binding
    /// holds.
    pub(crate) fn live(&self) -> Option<LiveNode> {
        self.node.get().map(LiveNode)
    }

    /// Sends `op` to the graph while the node is live (queuing it reaches
    /// only the executor, never the reactive graph).
    fn act(&self, op: impl FnOnce(crate::animation::NodeId) -> AnimationOp) {
        let id = self.id;
        self.node.with(|node| node.act(op(id)));
    }

    /// Where the node's operations go, while it is live.
    fn executor(&self) -> Option<Rc<Executor>> {
        self.node.with(|node| node.executor.upgrade()).flatten()
    }

    /// The node `key` makes from this one: the live one made by the same
    /// key if there is one (a region or a row made again derives it again
    /// and gets the same node, so its bindings stay as they are), through
    /// the handle the current owner keeps of it (made the first time), and
    /// whether that handle is new. A new node is made by `now` if given (the
    /// current appearance's colors), else by the key's operation. Of a node
    /// whose owner is gone (or with an operand whose owner is gone): no
    /// node.
    fn derive(
        &self,
        key: DerivedKey,
        now: Option<AnimationOp>,
        other: Option<AnimatedNode>,
    ) -> (AnimatedNode, bool) {
        let Some(node) = self.live() else {
            return (Self::gone(), false);
        };
        let other = match other {
            Some(other) => match other.live() {
                Some(other) => Some(other),
                None => return (Self::gone(), false),
            },
            None => None,
        };
        let Some(executor) = node.executor() else {
            // The surface is gone: a node nothing reads.
            return (*self, false);
        };
        let owner = Owner::current();
        let mut derived = executor.derived();
        if let Some(entry) = derived.entry(&key) {
            entry.handles.retain(|(_, h)| h.node.is_live());
            if let Some(&(_, handle)) = entry.handles.iter().find(|(o, _)| *o == owner) {
                return (handle, false);
            }
            let Some(node) = entry.node.upgrade() else {
                unreachable!("entries are of live nodes");
            };
            let handle = Self::keep(node);
            entry.handles.push((owner, handle));
            return (handle, true);
        }
        drop(derived);
        let mut inputs = vec![node.0];
        inputs.extend(other.map(|o| o.0));
        let op = now.unwrap_or_else(|| key.op.clone());
        let node = Node::new(&executor, |id| with_node(op, id), inputs);
        let weak = Rc::downgrade(&node);
        let handle = Self::keep(node);
        executor.derived().0.push(DerivedNode {
            key,
            node: weak,
            handles: vec![(owner, handle)],
        });
        (handle, true)
    }

    /// Maps the value through `input` breakpoints (ascending) to numbers,
    /// clamped at both ends: `x.interpolate(&[0.0, 300.0], &[1.0, 0.0])`.
    pub fn interpolate(&self, input: &[f32], output: &[f32]) -> AnimatedNode {
        self.interpolate_with(
            input,
            Output::Numbers(output.to_vec()),
            Interpolation::default(),
        )
    }

    /// Maps the value to colors (`backgroundColor` bindings). Theme colors
    /// (`AdaptiveColor`s) follow the appearance: when it changes, the node
    /// takes the other appearance's colors in place, its bindings as they
    /// are.
    pub fn interpolate_colors<C: Into<AdaptiveColor> + Copy>(
        &self,
        input: &[f32],
        colors: &[C],
    ) -> AnimatedNode {
        let colors: Rc<[AdaptiveColor]> = colors.iter().map(|&c| c.into()).collect();
        let pick = {
            let colors = colors.clone();
            move |dark: bool| {
                Output::Colors(
                    colors
                        .iter()
                        .map(|c| crate::style::Color::from(if dark { c.dark } else { c.light }).0)
                        .collect(),
                )
            }
        };
        if colors.iter().all(|c| c.light == c.dark) {
            return self.interpolate_with(input, pick(false), Interpolation::default());
        }
        let (node, new) = self.interpolate_derived(
            input,
            pick(false),
            Some(pick(true)),
            Interpolation::default(),
        );
        // The appearance's colors from now on; the effect holds the node
        // while it lives (it goes with the owner that keeps the handle,
        // which has one already when the handle is not new).
        let Some(held) = node.live().filter(|_| new) else {
            return node;
        };
        let first = Cell::new(true);
        super::reactive::render_effect(move || {
            let output = pick(super::dark());
            if !first.replace(false) {
                held.act(AnimationOp::SetOutput {
                    node: held.id(),
                    output,
                });
            }
        });
        node
    }

    /// [`Self::interpolate`] with any output, extrapolation on each side
    /// and curve (TS: `interpolate({ extrapolateLeft, extrapolateRight,
    /// easing })`).
    pub fn interpolate_with(
        &self,
        input: &[f32],
        output: Output,
        interpolation: Interpolation,
    ) -> AnimatedNode {
        self.interpolate_derived(input, output, None, interpolation)
            .0
    }

    /// [`Self::interpolate_with`] to `output`, or, with `dark`, to the
    /// current appearance's of `output` (light) and `dark`; and whether its
    /// handle is new.
    fn interpolate_derived(
        &self,
        input: &[f32],
        output: Output,
        dark: Option<Output>,
        interpolation: Interpolation,
    ) -> (AnimatedNode, bool) {
        let op = |output| AnimationOp::CreateInterpolate {
            node: 0,
            input: self.id(),
            input_range: input.to_vec(),
            output,
            extrapolate_left: interpolation.extrapolate_left,
            extrapolate_right: interpolation.extrapolate_right,
            easing: interpolation.easing,
        };
        let now = dark
            .clone()
            .filter(|_| super::untracked(super::dark))
            .map(op);
        self.derive(
            DerivedKey {
                op: op(output),
                dark,
            },
            now,
            None,
        )
    }

    fn math(&self, op: MathOp, other: AnimationOperand) -> AnimatedNode {
        let a = Operand::Node(self.id());
        let b = other.operand;
        let op = AnimationOp::CreateMath { node: 0, op, a, b };
        self.derive(DerivedKey { op, dark: None }, None, other.node)
            .0
    }

    /// The sum with `other`.
    pub fn add(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.math(MathOp::Add, other.into())
    }

    /// The difference with `other`.
    pub fn sub(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.math(MathOp::Sub, other.into())
    }

    /// The product with `other`.
    pub fn mul(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.math(MathOp::Mul, other.into())
    }

    /// The quotient by `other`.
    pub fn div(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.math(MathOp::Div, other.into())
    }

    /// The remainder by `other`.
    pub fn modulo(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.math(MathOp::Mod, other.into())
    }

    /// Follows the value's changes but stays within `min..=max` (a header
    /// hiding as content scrolls up).
    pub fn diff_clamp(&self, min: f32, max: f32) -> AnimatedNode {
        self.diff_clamp_with(min, max, DiffClamp::default())
    }

    /// [`Self::diff_clamp`] with options: [`DiffClamp::snapping`] settles at
    /// the nearer bound when the scroll view the value follows comes to rest
    /// (TS: `diffClamp(min, max, { snap: true })`).
    pub fn diff_clamp_with(&self, min: f32, max: f32, options: DiffClamp) -> AnimatedNode {
        let op = AnimationOp::CreateDiffClamp {
            node: 0,
            input: self.id(),
            min,
            max,
            snap: options.snap,
        };
        self.derive(DerivedKey { op, dark: None }, None, None).0
    }
}

/// Options of [`AnimatedNode::diff_clamp_with`] (TS: `diffClamp`'s third
/// argument). By default it only follows its input.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct DiffClamp {
    /// When the scroll view the value follows comes to rest between the
    /// bounds, it settles at the nearer one in 200 ms, easing out: a
    /// floating bar shows or hides fully. It settles at `max` only once
    /// the value reached `max`, so a page scrolled less than the bar's
    /// height shows the whole bar.
    pub snap: bool,
}

impl DiffClamp {
    /// Settles at the nearer bound when its scroll view rests.
    pub const fn snapping() -> Self {
        Self { snap: true }
    }
}

impl Animated for AnimatedNode {
    fn animated_node(&self) -> AnimatedNode {
        *self
    }
}

impl PartialEq for AnimatedNode {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}

impl fmt::Debug for AnimatedNode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("AnimatedNode").field(&self.id()).finish()
    }
}

/// An operand of arithmetic on nodes: a number or another node.
#[derive(Debug, Clone)]
pub struct AnimationOperand {
    operand: Operand,
    /// The node, which what derives from it holds.
    node: Option<AnimatedNode>,
}

impl From<f32> for AnimationOperand {
    fn from(n: f32) -> Self {
        Self {
            operand: Operand::Const(n),
            node: None,
        }
    }
}

impl<A: Animated> From<&A> for AnimationOperand {
    fn from(a: &A) -> Self {
        let node = a.animated_node();
        Self {
            operand: Operand::Node(node.id()),
            node: Some(node),
        }
    }
}

/// How [`AnimatedNode::interpolate_with`] maps: what it does outside the
/// input range on each side, and the curve within each segment (TS:
/// `extrapolateLeft`, `extrapolateRight`, `easing`). By default it clamps
/// on both sides, linearly.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Interpolation {
    /// Below the first breakpoint.
    pub extrapolate_left: Extrapolate,
    /// Above the last breakpoint.
    pub extrapolate_right: Extrapolate,
    /// The curve within each segment.
    pub easing: Easing,
}

impl Interpolation {
    /// `extrapolate` on both sides, linearly (TS: `extrapolate`).
    pub const fn extrapolate(extrapolate: Extrapolate) -> Self {
        Self {
            extrapolate_left: extrapolate,
            extrapolate_right: extrapolate,
            easing: Easing::Linear,
        }
    }
}

impl Default for Interpolation {
    fn default() -> Self {
        Self::extrapolate(Extrapolate::Clamp)
    }
}

/// A settable, animatable value (made with
/// [`super::animated_value`]): set it, animate it, bind it, derive
/// from it. A `Copy` handle, kept by the owner it was made under: copies
/// are the same value, closures share it as they share a signal; used
/// after the owner is gone, it does nothing (see the module's docs).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct AnimatedValue(AnimatedNode);

/// How a spring moves (TS's defaults: stiffness 170, damping 26, mass 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spring {
    /// Stiffness `k`.
    pub stiffness: f32,
    /// Damping `c`.
    pub damping: f32,
    /// Mass `m`.
    pub mass: f32,
    /// The velocity it starts with (per second); `None` keeps the current
    /// one.
    pub velocity: Option<f32>,
}

impl Default for Spring {
    fn default() -> Self {
        Self {
            stiffness: 170.0,
            damping: 26.0,
            mass: 1.0,
            velocity: None,
        }
    }
}

/// How a timing animation moves (TS's defaults: 300 ms, ease in-out, no
/// delay).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    /// How long it takes, in milliseconds.
    pub duration_ms: f32,
    /// The curve.
    pub easing: Easing,
    /// How long it waits before it starts, in milliseconds.
    pub delay_ms: f32,
}

impl Timing {
    /// `duration_ms` along `easing`, with no delay.
    pub const fn new(duration_ms: f32, easing: Easing) -> Self {
        Self {
            duration_ms,
            easing,
            delay_ms: 0.0,
        }
    }

    fn driver(self, to: f32) -> Driver {
        Driver::Timing {
            to,
            duration_ms: self.duration_ms,
            easing: self.easing,
            delay_ms: self.delay_ms,
        }
    }
}

impl Default for Timing {
    fn default() -> Self {
        Self::new(300.0, Easing::EaseInOut)
    }
}

impl Spring {
    fn driver(self, to: f32) -> Driver {
        Driver::Spring {
            to,
            stiffness: self.stiffness,
            damping: self.damping,
            mass: self.mass,
            velocity: self.velocity,
        }
    }
}

/// The values `driver` moves a value through from `from`, one per frame at
/// `fps` (1 to 1000), until it ends: the exact curve the graph runs.
fn sample(driver: Driver, from: f32, fps: f32) -> Vec<f32> {
    let step = 1.0 / f64::from(fps.clamp(1.0, 1000.0));
    crate::animation::sample_driver(driver, from, step, crate::animation::MAX_SAMPLES)
}

/// The values a spring moves a value through from `from` to `to`, one per
/// frame at `fps` (60 on most screens) until it rests (TS:
/// `Animated.sampleSpring`): its curve, to draw it. At most
/// [`crate::animation::MAX_SAMPLES`].
pub fn sample_spring(from: f32, to: f32, spring: Spring, fps: f32) -> Vec<f32> {
    sample(spring.driver(to), from, fps)
}

/// The values a decay ([`AnimatedValue::decay`]) moves a value through from
/// `from` at `velocity` (per second), one per frame at `fps` until it
/// stops (TS: `Animated.sampleDecay`). At most
/// [`crate::animation::MAX_SAMPLES`].
pub fn sample_decay(from: f32, velocity: f32, deceleration: f32, fps: f32) -> Vec<f32> {
    sample(
        Driver::Decay {
            velocity: Some(velocity),
            deceleration,
            clamp: None,
            bounce: 0.0,
        },
        from,
        fps,
    )
}

/// Like [`sample_decay`], within `min..=max` ([`AnimatedValue::decay_within`]:
/// it stops at a bound, or bounces back keeping `bounce` of its speed).
pub fn sample_decay_within(
    from: f32,
    velocity: f32,
    deceleration: f32,
    (min, max): (f32, f32),
    bounce: f32,
    fps: f32,
) -> Vec<f32> {
    sample(
        Driver::Decay {
            velocity: Some(velocity),
            deceleration,
            clamp: Some((min, max)),
            bounce,
        },
        from,
        fps,
    )
}

/// The end of an animation: `true` when it reached its end, `false` when
/// it was stopped or replaced (or never ran: its value's owner was gone).
/// The animation runs either way: await this in a task to follow it up, or
/// drop it.
#[derive(Debug)]
pub struct AnimationEnd(Answer<bool>);

impl std::future::IntoFuture for AnimationEnd {
    type Output = bool;
    type IntoFuture = Answer<bool>;

    fn into_future(self) -> Answer<bool> {
        self.0
    }
}

impl AnimatedValue {
    pub(crate) fn new(executor: &Rc<Executor>, value: f32) -> Self {
        Self(AnimatedNode::keep(Node::new(
            executor,
            |node| AnimationOp::CreateValue { node, value },
            Vec::new(),
        )))
    }

    /// The node, to derive from.
    pub fn node(&self) -> &AnimatedNode {
        &self.0
    }

    /// Sets the value at once, stopping its animation.
    pub fn set(&self, value: f32) {
        self.0.act(|node| AnimationOp::Set { node, value });
    }

    /// Adjusts the base value to `value * factor + offset` on the UI thread,
    /// stopping its animation and retaining the offset from [`Self::set_offset`].
    pub fn adjust(&self, factor: f32, offset: f32) {
        self.0.act(|node| AnimationOp::Adjust {
            node,
            factor,
            offset,
        });
    }

    /// Stops its animation where it is ([`Self::value`] then reads where
    /// that is; TS: `stop()`'s promise).
    pub fn stop(&self) {
        self.0.act(|node| AnimationOp::Stop { node });
    }

    /// Its value now, read on the UI thread where it moves (TS:
    /// `getValue()`): after the changes queued before it (a [`Self::stop`],
    /// a [`Self::set`]). Await it in a task. Once its owner is gone, it
    /// never comes.
    pub fn value(&self) -> Answer<f32> {
        let (answer, slot) = Answer::new();
        if let Some(executor) = self.0.executor() {
            executor.act(Action::ReadValue {
                node: self.0.id(),
                value: slot,
            });
        }
        answer
    }

    fn start(&self, driver: Driver) -> AnimationEnd {
        let (end, slot) = Answer::new();
        let end = AnimationEnd(end);
        match self.0.executor() {
            Some(executor) => {
                let animation = executor.next_animation_id();
                executor.act(Action::Animate {
                    op: AnimationOp::Start {
                        node: self.0.id(),
                        animation,
                        driver,
                    },
                    animation,
                    end: slot,
                });
            }
            // Its owner (or the surface) is gone: it ends at once, unfinished.
            None => slot.borrow_mut().deliver(false),
        }
        end
    }

    /// Plays `frames` as CSS keyframes play (TS: `keyframes(frames,
    /// options)`): each segment with its easing, `timing.iterations` times
    /// in `timing.direction`.
    pub fn keyframes(
        &self,
        frames: impl IntoIterator<Item = Keyframe>,
        timing: KeyframeTiming,
    ) -> AnimationEnd {
        Animation::keyframes(self, frames, timing).start()
    }

    /// Springs to `to`.
    pub fn spring(&self, to: f32, spring: Spring) -> AnimationEnd {
        self.start(spring.driver(to))
    }

    /// Moves to `to` in `ms` milliseconds along `easing`.
    pub fn timing(&self, to: f32, ms: f32, easing: Easing) -> AnimationEnd {
        self.timing_with(to, Timing::new(ms, easing))
    }

    /// Moves to `to` as `timing` says, after its delay.
    pub fn timing_with(&self, to: f32, timing: Timing) -> AnimationEnd {
        self.start(timing.driver(to))
    }

    /// Glides from `velocity` (per second; `None`: the current one),
    /// slowing down by `deceleration` per millisecond (0.998: a fling).
    pub fn decay(&self, velocity: Option<f32>, deceleration: f32) -> AnimationEnd {
        self.start(Driver::Decay {
            velocity,
            deceleration,
            clamp: None,
            bounce: 0.0,
        })
    }

    /// Like [`Self::decay`], within `min..=max`: it stops at a bound, or
    /// bounces back from it keeping `bounce` (0..1) of its speed.
    pub fn decay_within(
        &self,
        velocity: Option<f32>,
        deceleration: f32,
        (min, max): (f32, f32),
        bounce: f32,
    ) -> AnimationEnd {
        self.start(Driver::Decay {
            velocity,
            deceleration,
            clamp: Some((min, max)),
            bounce,
        })
    }

    /// Sets the offset added to the value (React Native's `setOffset`):
    /// bindings see value + offset, animations and `set` move the value.
    pub fn set_offset(&self, offset: f32) {
        self.0.act(|node| AnimationOp::SetOffset { node, offset });
    }

    /// Adds the offset to the value and clears it.
    pub fn flatten_offset(&self) {
        self.0.act(|node| AnimationOp::FlattenOffset { node });
    }

    /// Moves the value into the offset, leaving the value 0 (a drag then
    /// starts from where the last one left it).
    pub fn extract_offset(&self) {
        self.0.act(|node| AnimationOp::ExtractOffset { node });
    }

    /// See [`AnimatedNode::interpolate`].
    pub fn interpolate(&self, input: &[f32], output: &[f32]) -> AnimatedNode {
        self.0.interpolate(input, output)
    }

    /// See [`AnimatedNode::interpolate_colors`].
    pub fn interpolate_colors<C: Into<AdaptiveColor> + Copy>(
        &self,
        input: &[f32],
        colors: &[C],
    ) -> AnimatedNode {
        self.0.interpolate_colors(input, colors)
    }

    /// See [`AnimatedNode::interpolate_with`].
    pub fn interpolate_with(
        &self,
        input: &[f32],
        output: Output,
        interpolation: Interpolation,
    ) -> AnimatedNode {
        self.0.interpolate_with(input, output, interpolation)
    }

    /// See [`AnimatedNode::diff_clamp`].
    pub fn diff_clamp(&self, min: f32, max: f32) -> AnimatedNode {
        self.0.diff_clamp(min, max)
    }

    /// See [`AnimatedNode::diff_clamp_with`].
    pub fn diff_clamp_with(&self, min: f32, max: f32, options: DiffClamp) -> AnimatedNode {
        self.0.diff_clamp_with(min, max, options)
    }

    /// See [`AnimatedNode::add`].
    pub fn add(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.0.add(other)
    }

    /// See [`AnimatedNode::sub`].
    pub fn sub(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.0.sub(other)
    }

    /// See [`AnimatedNode::mul`].
    pub fn mul(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.0.mul(other)
    }

    /// See [`AnimatedNode::div`].
    pub fn div(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.0.div(other)
    }

    /// See [`AnimatedNode::modulo`].
    pub fn modulo(&self, other: impl Into<AnimationOperand>) -> AnimatedNode {
        self.0.modulo(other)
    }
}

impl Animated for AnimatedValue {
    fn animated_node(&self) -> AnimatedNode {
        self.0
    }
}

/// A composed animation (TS: `Animated.timing` / `spring` / `decay` /
/// `sequence` / `parallel` / `stagger` / `delay` / `loop`): a tree of
/// steps over animated values, run on the UI thread, each step starting at
/// the exact end of the one before (no round trip to the engine between
/// steps).
///
/// Build it once (in the view, captured by the listeners that run it) and
/// run it any number of times: [`Self::start`] runs it (stopping a run of
/// it going on) and returns its [`AnimationEnd`], [`Self::stop`] stops it
/// where it is, [`Self::reset`] stops it and puts its values back where
/// they were when it last started. Clones are the same animation; building a group from
/// animations makes a new one (its parts are copied in). It holds the nodes
/// of its values while it lives (values whose owner is gone are left
/// out), wherever it is kept.
///
/// ```ignore
/// let jump = Animation::sequence([
///     Animation::timing(&y, -36.0, Timing::new(220.0, Easing::EaseOut)),
///     Animation::spring(&y, 0.0, Spring::default()),
/// ]);
/// view().on_press(move || {
///     let end = jump.start();
/// })
/// ```
#[derive(Clone)]
pub struct Animation(Rc<Composed>);

struct Composed {
    spec: Composite,
    /// The nodes of the values it animates, held while it is.
    values: Vec<LiveNode>,
    run: Run,
}

/// An animation's identity in the graph.
struct Run {
    executor: Weak<Executor>,
    /// Its composite key (what resets restore by); 0 until it first runs.
    key: Cell<u32>,
    /// Its last run (0: none).
    animation: Cell<AnimationId>,
}

impl Drop for Run {
    fn drop(&mut self) {
        // A run going on goes on; the graph forgets the values to reset to.
        let key = self.key.get();
        if key != 0
            && let Some(executor) = self.executor.upgrade()
        {
            executor.act(Action::Animation(AnimationOp::ReleaseComposite { key }));
        }
    }
}

impl Animation {
    fn new(spec: Composite, values: Vec<LiveNode>) -> Self {
        let executor = values
            .first()
            .map(|n| n.0.executor.clone())
            .unwrap_or_default();
        Self(Rc::new(Composed {
            spec,
            values,
            run: Run {
                executor,
                key: Cell::new(0),
                animation: Cell::new(0),
            },
        }))
    }

    fn run(value: &AnimatedValue, driver: Driver) -> Self {
        let node = value.0.id();
        Self::new(
            Composite::Run { node, driver },
            value.0.live().into_iter().collect(),
        )
    }

    /// `value` moving to `to` as `timing` says.
    pub fn timing(value: &AnimatedValue, to: f32, timing: Timing) -> Self {
        Self::run(value, timing.driver(to))
    }

    /// `value` springing to `to`.
    pub fn spring(value: &AnimatedValue, to: f32, spring: Spring) -> Self {
        Self::run(value, spring.driver(to))
    }

    /// `value` gliding from `velocity` (per second; `None`: the current
    /// one), slowing down by `deceleration` per millisecond (0.998: a
    /// fling).
    pub fn decay(value: &AnimatedValue, velocity: Option<f32>, deceleration: f32) -> Self {
        Self::run(
            value,
            Driver::Decay {
                velocity,
                deceleration,
                clamp: None,
                bounce: 0.0,
            },
        )
    }

    /// Like [`Self::decay`], within `min..=max`: it stops at a bound, or
    /// bounces back from it keeping `bounce` (0..1) of its speed.
    pub fn decay_within(
        value: &AnimatedValue,
        velocity: Option<f32>,
        deceleration: f32,
        (min, max): (f32, f32),
        bounce: f32,
    ) -> Self {
        Self::run(
            value,
            Driver::Decay {
                velocity,
                deceleration,
                clamp: Some((min, max)),
                bounce,
            },
        )
    }

    /// `value` through `frames`, as CSS keyframes play (TS:
    /// `Animated.keyframes`): offsets spread as the Web Animations API
    /// spreads them, an easing per segment, iterations, a direction and a
    /// delay ([`KeyframeTiming`]).
    pub fn keyframes(
        value: &AnimatedValue,
        frames: impl IntoIterator<Item = Keyframe>,
        timing: KeyframeTiming,
    ) -> Self {
        let frames: Vec<Keyframe> = frames.into_iter().collect();
        Self::new(
            crate::animation::keyframes(value.0.id(), &frames, &timing),
            value.0.live().into_iter().collect(),
        )
    }

    /// A wait of `ms` milliseconds (in a sequence).
    pub fn delay(ms: f32) -> Self {
        Self::new(Composite::Delay(ms), Vec::new())
    }

    /// The spec and values of this animation.
    fn into_parts(self) -> (Composite, Vec<LiveNode>) {
        match Rc::try_unwrap(self.0) {
            Ok(Composed { spec, values, .. }) => (spec, values),
            Err(shared) => (shared.spec.clone(), shared.values.clone()),
        }
    }

    fn group(
        animations: impl IntoIterator<Item = Animation>,
        make: impl FnOnce(Vec<Composite>) -> Composite,
    ) -> Self {
        let mut specs = Vec::new();
        let mut values: Vec<LiveNode> = Vec::new();
        for animation in animations {
            let (spec, of) = animation.into_parts();
            specs.push(spec);
            for value in of {
                if !values.contains(&value) {
                    values.push(value);
                }
            }
        }
        Self::new(make(specs), values)
    }

    /// `animations` one after the other; it stops at the first that is
    /// stopped.
    pub fn sequence(animations: impl IntoIterator<Item = Animation>) -> Self {
        Self::group(animations, Composite::Sequence)
    }

    /// `animations` all at once; one stopped stops the others (see
    /// [`Self::stop_together`]).
    pub fn parallel(animations: impl IntoIterator<Item = Animation>) -> Self {
        Self::group(animations, |children| Composite::Parallel {
            children,
            stop_together: true,
        })
    }

    /// `animations` all at once, each starting `ms` milliseconds after the
    /// one before.
    pub fn stagger(ms: f32, animations: impl IntoIterator<Item = Animation>) -> Self {
        let staged = animations
            .into_iter()
            .enumerate()
            .map(|(i, a)| Self::sequence([Self::delay(ms * i as f32), a]));
        Self::parallel(staged)
    }

    /// `animations` all at once, each starting `ms` milliseconds after the
    /// one before, counted from `from` (TS: `Animated.stagger(ms, list, {
    /// from })`): from the center, a list ripples out from its middle.
    pub fn stagger_from(
        ms: f32,
        from: StaggerFrom,
        animations: impl IntoIterator<Item = Animation>,
    ) -> Self {
        let animations: Vec<Animation> = animations.into_iter().collect();
        let count = animations.len();
        let staged = animations.into_iter().enumerate().map(|(i, a)| {
            Self::sequence([
                Self::delay(ms * crate::animation::stagger_delay(i, count, from)),
                a,
            ])
        });
        Self::parallel(staged)
    }

    /// This animation over and over: `iterations` times, or until stopped
    /// with `None`; its values go back to where they were before each run
    /// (see [`Self::reset_before_iteration`]).
    pub fn looped(self, iterations: Option<u32>) -> Self {
        let (spec, values) = self.into_parts();
        Self::new(
            Composite::Loop {
                child: Box::new(spec),
                iterations,
                reset: true,
            },
            values,
        )
    }

    /// For a group made with [`Self::parallel`] or [`Self::stagger`]:
    /// whether one of its animations stopped stops the others (by
    /// default it does). Other animations stay as they are.
    pub fn stop_together(self, stop_together: bool) -> Self {
        let (mut spec, values) = self.into_parts();
        if let Composite::Parallel {
            stop_together: s, ..
        } = &mut spec
        {
            *s = stop_together;
        }
        Self::new(spec, values)
    }

    /// For a loop made with [`Self::looped`]: whether its values go back
    /// to where they were before each run (by default they do). Other
    /// animations stay as they are.
    pub fn reset_before_iteration(self, reset: bool) -> Self {
        let (mut spec, values) = self.into_parts();
        if let Composite::Loop { reset: r, .. } = &mut spec {
            *r = reset;
        }
        Self::new(spec, values)
    }

    /// Runs it, stopping a run of it going on (which ends `false`). It
    /// runs either way: await the end in a task to follow it up, or drop
    /// it. An animation of no values (only delays) has nothing to run on
    /// and ends at once.
    pub fn start(&self) -> AnimationEnd {
        let (end, slot) = Answer::new();
        let run = &self.0.run;
        let Some(executor) = run.executor.upgrade() else {
            if self.0.values.is_empty() {
                slot.borrow_mut().deliver(true);
            }
            return AnimationEnd(end);
        };
        self.stop();
        if run.key.get() == 0 {
            run.key.set(executor.next_animation_id());
        }
        let animation = executor.next_animation_id();
        run.animation.set(animation);
        executor.act(Action::Animate {
            op: AnimationOp::StartComposite {
                animation,
                key: run.key.get(),
                spec: self.0.spec.clone(),
            },
            animation,
            end: slot,
        });
        AnimationEnd(end)
    }

    /// Stops its run where it is (the run ends `false`).
    pub fn stop(&self) {
        let run = &self.0.run;
        let animation = run.animation.replace(0);
        if animation != 0
            && let Some(executor) = run.executor.upgrade()
        {
            executor.act(Action::Animation(AnimationOp::StopAnimation { animation }));
        }
    }

    /// Stops its run (which ends `false`) and puts its values back where
    /// they were when it last started.
    pub fn reset(&self) {
        let run = &self.0.run;
        run.animation.set(0);
        let key = run.key.get();
        if key != 0
            && let Some(executor) = run.executor.upgrade()
        {
            executor.act(Action::Animation(AnimationOp::ResetComposite { key }));
        }
    }
}

impl fmt::Debug for Animation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Animation").field(&self.0.spec).finish()
    }
}

/// Animated values for a view's opacity and the parts of its transform
/// (TS: `createMotion`), and motions to play on them: presets
/// ([`crate::animation::MotionPreset`]: entrances, exits, attention seekers,
/// loops) or keyframes of the app's own ([`MotionSpec`]). Bind it with
/// [`super::Styled::bind_motion`]. A `Copy` handle, kept by the owner
/// current when it is made, as an [`AnimatedValue`] is.
///
/// ```ignore
/// let card = motion().entering(MotionPreset::FadeInUp);
/// view().bind_motion(&card).on_press(move || {
///     card.play(MotionPreset::Pulse);
/// })
/// ```
#[derive(Clone, Copy)]
pub struct Motion {
    values: [AnimatedValue; 9],
}

impl fmt::Debug for Motion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Motion").finish_non_exhaustive()
    }
}

impl Motion {
    pub(crate) fn new(executor: &Rc<Executor>) -> Self {
        Self {
            values: MotionChannel::ALL.map(|c| AnimatedValue::new(executor, c.identity())),
        }
    }

    /// The value of `channel` (opacity 0..1, translations in points,
    /// rotations in degrees, scales).
    pub fn value(&self, channel: MotionChannel) -> AnimatedValue {
        self.values[channel.index()]
    }

    /// Starting where `motion` starts and playing it at once: a view that
    /// comes in shows its first frame where the motion begins.
    pub fn entering(self, motion: impl Into<MotionSpec>) -> Self {
        let motion = motion.into();
        for (channel, start) in motion.start_values() {
            self.value(channel).set(start);
        }
        let _ = self.play(motion);
        self
    }

    /// Plays `motion` on its channels (a new one interrupts the one
    /// playing). When the user asks for less motion
    /// ([`super::reduce_motion`]), it lands where it ends without moving.
    pub fn play(&self, motion: impl Into<MotionSpec>) -> AnimationEnd {
        self.run(motion.into(), super::reduce_motion())
    }

    /// Plays `motion` even when the user asks for less motion.
    pub fn play_ignoring_reduce_motion(&self, motion: impl Into<MotionSpec>) -> AnimationEnd {
        self.run(motion.into(), false)
    }

    /// `motion` as an [`Animation`] to compose, not started (TS:
    /// `motion.animation(..)`): `Animation::stagger_from(60.0,
    /// StaggerFrom::Center, cards.iter().map(|m| m.animation(..)))`. Like
    /// [`Self::play`], it lands at its end when the user asks for less
    /// motion (as things are when it is made).
    pub fn animation(&self, motion: impl Into<MotionSpec>) -> Animation {
        self.composed(motion.into(), super::reduce_motion())
    }

    fn composed(&self, motion: MotionSpec, reduced: bool) -> Animation {
        let nodes = self.values.map(|v| v.0.id());
        let held = self
            .values
            .iter()
            .filter_map(|v| v.0.live())
            .collect::<Vec<_>>();
        Animation::new(motion.composite(&nodes, reduced), held)
    }

    fn run(&self, motion: MotionSpec, reduced: bool) -> AnimationEnd {
        self.composed(motion, reduced).start()
    }

    /// Stops it where it is.
    pub fn stop(&self) {
        for value in &self.values {
            value.stop();
        }
    }

    /// Stops it and puts every channel back at rest.
    pub fn reset(&self) {
        for channel in MotionChannel::ALL {
            self.value(channel).set(channel.identity());
        }
    }
}

/// A timing a component's prop takes (TS `{ duration?: number; easing?:
/// Easing; delay?: number }`): the options of `AnimatedValue.timing` in
/// `nsh/animated`, with its defaults (300 ms, ease in-out, no delay).
impl super::JsValue for Timing {
    fn ts_type(_types: &mut super::TsTypes) -> String {
        "{ duration?: number; easing?: import(\"nsh\").Easing; delay?: number }".into()
    }

    fn from_js(value: super::JsIn<'_>) -> Result<Self, super::PropError> {
        let json = value.to_json()?;
        let Some(object) = json.as_object() else {
            return Err(value.expected("a timing: `{ duration, easing, delay }`"));
        };
        let num = |key: &str| object.get(key).and_then(|v| v.as_f64()).map(|v| v as f32);
        let default = Timing::default();
        Ok(Timing {
            duration_ms: num("duration").unwrap_or(default.duration_ms).max(0.0),
            easing: object
                .get("easing")
                .and_then(|e| crate::js::animation::easing(&JsonInput(Some(e))))
                .unwrap_or(default.easing),
            delay_ms: num("delay").unwrap_or(default.delay_ms).max(0.0),
        })
    }

    fn to_js<'a>(
        &self,
        host: &'a dyn super::JsHost,
    ) -> Result<super::JsOwned<'a>, super::PropError> {
        let json = serde_json::json!({ "duration": self.duration_ms, "delay": self.delay_ms });
        Ok(super::JsOwned::new(host, host.json(&json)?))
    }
}

/// A spring a component's prop takes (TS `{ stiffness?: number; damping?:
/// number; mass?: number; velocity?: number }`): the options of
/// `AnimatedValue.spring` in `nsh/animated`, with its defaults.
impl super::JsValue for Spring {
    fn ts_type(_types: &mut super::TsTypes) -> String {
        "{ stiffness?: number; damping?: number; mass?: number; velocity?: number }".into()
    }

    fn from_js(value: super::JsIn<'_>) -> Result<Self, super::PropError> {
        let json = value.to_json()?;
        let Some(object) = json.as_object() else {
            return Err(value.expected("a spring: `{ stiffness, damping, mass }`"));
        };
        let num = |key: &str| object.get(key).and_then(|v| v.as_f64()).map(|v| v as f32);
        let default = Spring::default();
        Ok(Spring {
            stiffness: num("stiffness").unwrap_or(default.stiffness),
            damping: num("damping").unwrap_or(default.damping),
            mass: num("mass").unwrap_or(default.mass),
            velocity: num("velocity"),
        })
    }

    fn to_js<'a>(
        &self,
        host: &'a dyn super::JsHost,
    ) -> Result<super::JsOwned<'a>, super::PropError> {
        let json = serde_json::json!({
            "stiffness": self.stiffness,
            "damping": self.damping,
            "mass": self.mass,
        });
        Ok(super::JsOwned::new(host, host.json(&json)?))
    }
}

/// A JSON value as the core's decoders read JS values (an easing).
struct JsonInput<'a>(Option<&'a crate::JsonValue>);

/// A JSON array, read by index.
struct JsonList<'a>(&'a [crate::JsonValue]);

impl<'a> crate::js::host::HostList for JsonList<'a> {
    type Item = JsonInput<'a>;

    fn len(&self) -> usize {
        self.0.len()
    }

    fn item(&self, index: usize) -> Option<JsonInput<'a>> {
        self.0.get(index).map(|v| JsonInput(Some(v)))
    }
}

impl<'a> crate::js::host::HostInput for JsonInput<'a> {
    type List = JsonList<'a>;

    fn is_nullish(&self) -> bool {
        self.0.is_none_or(|v| v.is_null())
    }

    fn is_object(&self) -> bool {
        self.0.is_some_and(|v| v.is_object() || v.is_array())
    }

    fn as_bool(&self) -> Option<bool> {
        self.0?.as_bool()
    }

    fn as_number(&self) -> Option<f64> {
        self.0?.as_f64()
    }

    fn as_string(&self) -> Option<String> {
        self.0?.as_str().map(str::to_owned)
    }

    fn field(&self, key: &str) -> Option<Self> {
        self.0?.get(key).map(|v| JsonInput(Some(v)))
    }

    fn as_list(&self) -> Option<JsonList<'a>> {
        self.0?.as_array().map(|a| JsonList(a))
    }

    fn entries(&self) -> Vec<(String, Self)> {
        match self.0.and_then(|v| v.as_object()) {
            Some(o) => o
                .iter()
                .map(|(k, v)| (k.clone(), JsonInput(Some(v))))
                .collect(),
            None => Vec::new(),
        }
    }

    fn truthy(&self) -> bool {
        match self.0 {
            None | Some(crate::JsonValue::Null) => false,
            Some(crate::JsonValue::Bool(b)) => *b,
            Some(crate::JsonValue::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
            Some(crate::JsonValue::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::reactive::{Runtime, create_root};

    fn released(executor: &Executor) -> usize {
        executor
            .take_actions()
            .into_iter()
            .filter(|a| matches!(a, Action::Animation(AnimationOp::Release { .. })))
            .count()
    }

    #[test]
    fn a_derived_chain_keeps_its_middle_nodes() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let (value_owner, v) = create_root(|| AnimatedValue::new(&executor, 0.5));
        // The chain's handles go with their owner; a binding of its end
        // holds the product too.
        let (chain_owner, end) = create_root(|| v.node().mul(2.0).sub(1.0));
        let bound = end.live().expect("live");
        chain_owner.dispose();
        assert_eq!(released(&executor), 0, "the product lives with the end");
        assert!(end.live().is_none(), "its handle is gone");
        drop(bound);
        assert_eq!(released(&executor), 2, "then both go");
        value_owner.dispose();
        assert_eq!(released(&executor), 1);
    }

    #[test]
    fn copies_are_the_same_value_in_every_closure() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let (_owner, v) = create_root(|| AnimatedValue::new(&executor, 0.0));
        let node = v.node().id();
        let _ = ops(&executor);
        // Two closures and the code after them use the one value.
        let press = move || v.set(1.0);
        let release = move || v.set_offset(2.0);
        press();
        release();
        v.adjust(2.0, -3.0);
        let _ = v.timing(3.0, 100.0, Easing::Linear);
        assert!(matches!(
            &ops(&executor)[..],
            [
                AnimationOp::Set { node: a, value: 1.0 },
                AnimationOp::SetOffset { node: b, offset: 2.0 },
                AnimationOp::Adjust { node: c, factor: 2.0, offset: -3.0 },
                AnimationOp::Start { node: d, .. },
            ] if [*a, *b, *c, *d] == [node; 4]
        ));
        let copy = v;
        assert_eq!(copy, v);
        assert_eq!(
            format!("{v:?}"),
            format!("AnimatedValue(AnimatedNode({node}))")
        );
    }

    #[test]
    fn handles_do_nothing_once_their_owner_is_gone() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let (owner, (v, half)) = create_root(|| {
            let v = AnimatedValue::new(&executor, 0.0);
            (v, v.mul(0.5))
        });
        let jump = Animation::timing(&v, 1.0, Timing::default());
        let _ = ops(&executor);
        owner.dispose();
        // The value and its product go with their owner; the composite
        // holds the value's node while it lives.
        assert_eq!(ops(&executor), [AnimationOp::Release { node: half.id() }]);
        drop(jump);
        assert_eq!(
            ops(&executor),
            [AnimationOp::Release {
                node: v.node().id()
            }]
        );

        v.set(1.0);
        v.stop();
        v.set_offset(1.0);
        v.flatten_offset();
        v.extract_offset();
        let ended = v.spring(1.0, Spring::default());
        let tasks = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert!(!tasks.block_on(ended.into_future()), "unfinished, at once");
        drop(v.value());
        let derived = [
            v.interpolate(&[0.0, 1.0], &[0.0, 1.0]),
            v.add(&half),
            half.mul(2.0),
        ];
        assert!(derived.iter().all(|n| n.live().is_none()));
        drop(Animation::timing(&v, 1.0, Timing::default()).start());
        assert_eq!(ops(&executor), [], "nothing reaches the graph");
        // Handles keep their identity.
        let copy = half;
        assert_eq!(copy, half);
        assert_eq!(format!("{half:?}"), format!("AnimatedNode({})", half.id()));
    }

    /// The graph operations `executor` was asked for (animations' ends
    /// dropped).
    fn ops(executor: &Executor) -> Vec<AnimationOp> {
        executor
            .take_actions()
            .into_iter()
            .filter_map(|a| match a {
                Action::Animation(op) | Action::Animate { op, .. } => Some(op),
                _ => None,
            })
            .collect()
    }

    fn timing(to: f32, ms: f32) -> Driver {
        Timing::new(ms, Easing::Linear).driver(to)
    }

    #[test]
    fn keyframes_staggers_and_motions_describe_their_trees() {
        use crate::animation::{MotionPreset, StaggerFrom};
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let values: Vec<AnimatedValue> =
            (0..3).map(|_| AnimatedValue::new(&executor, 0.0)).collect();
        let step = |v: &AnimatedValue| {
            Animation::keyframes(
                v,
                [Keyframe::new(0.0), Keyframe::new(1.0)],
                KeyframeTiming::new(100.0),
            )
        };
        let rippled = Animation::stagger_from(40.0, StaggerFrom::Center, values.iter().map(step));
        let Composite::Parallel { children, .. } = &rippled.0.spec else {
            panic!("{:?}", rippled.0.spec)
        };
        let delays: Vec<f32> = children
            .iter()
            .map(|c| match c {
                Composite::Sequence(s) => match s[0] {
                    Composite::Delay(ms) => ms,
                    _ => -1.0,
                },
                _ => -1.0,
            })
            .collect();
        assert_eq!(delays, [40.0, 0.0, 40.0]);

        let motion = Motion::new(&executor);
        executor.take_actions();
        let _ = motion.play_ignoring_reduce_motion(MotionPreset::Shake);
        let started = executor.take_actions().into_iter().find_map(|a| match a {
            Action::Animate {
                op: AnimationOp::StartComposite { spec, .. },
                ..
            } => Some(spec),
            _ => None,
        });
        let Some(Composite::Parallel { children, .. }) = started else {
            panic!("{started:?}")
        };
        // `shake` moves one channel: translateX.
        assert_eq!(children.len(), 1);
        let mut nodes = Vec::new();
        children[0].nodes(&mut nodes);
        assert_eq!(nodes, [motion.value(MotionChannel::TranslateX).node().id()]);
    }

    #[test]
    fn composites_describe_their_steps() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let (a, b) = (
            AnimatedValue::new(&executor, 0.0),
            AnimatedValue::new(&executor, 1.0),
        );
        let (na, nb) = (a.node().id(), b.node().id());
        let run = |node, to| Composite::Run {
            node,
            driver: timing(to, 100.0),
        };
        let step =
            |v: &AnimatedValue, to| Animation::timing(v, to, Timing::new(100.0, Easing::Linear));
        let staggered = Animation::stagger(50.0, [step(&a, 1.0), step(&b, 2.0)]);
        let delayed = |ms, c| Composite::Sequence(vec![Composite::Delay(ms), c]);
        assert_eq!(
            staggered.0.spec,
            Composite::Parallel {
                children: vec![delayed(0.0, run(na, 1.0)), delayed(50.0, run(nb, 2.0))],
                stop_together: true,
            }
        );
        let ids = |a: &Animation| a.0.values.iter().map(LiveNode::id).collect::<Vec<_>>();
        assert_eq!(ids(&staggered), [na, nb]);

        let looped = Animation::sequence([step(&a, 1.0), Animation::delay(10.0), step(&a, 0.0)])
            .looped(Some(3))
            .reset_before_iteration(false);
        assert_eq!(
            looped.0.spec,
            Composite::Loop {
                child: Box::new(Composite::Sequence(vec![
                    run(na, 1.0),
                    Composite::Delay(10.0),
                    run(na, 0.0)
                ])),
                iterations: Some(3),
                reset: false,
            }
        );
        // Each value once.
        assert_eq!(ids(&looped), [na]);
        let apart = Animation::parallel([step(&a, 1.0)]).stop_together(false);
        assert!(matches!(
            apart.0.spec,
            Composite::Parallel {
                stop_together: false,
                ..
            }
        ));
        // A delay on its own driver.
        let delayed = Animation::timing(
            &a,
            1.0,
            Timing {
                delay_ms: 40.0,
                ..Timing::default()
            },
        );
        assert!(matches!(
            delayed.0.spec,
            Composite::Run {
                driver: Driver::Timing {
                    delay_ms: 40.0,
                    duration_ms: 300.0,
                    easing: Easing::EaseInOut,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn composites_start_stop_reset_and_release_by_key() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let x = AnimatedValue::new(&executor, 0.0);
        let _ = ops(&executor);
        let jump = Animation::sequence([
            Animation::timing(&x, 10.0, Timing::default()),
            Animation::spring(&x, 0.0, Spring::default()),
        ]);
        // Nothing until it runs.
        jump.stop();
        jump.reset();
        assert_eq!(ops(&executor), []);

        let _ = jump.start();
        let [
            AnimationOp::StartComposite {
                animation,
                key,
                spec,
            },
        ] = &ops(&executor)[..]
        else {
            panic!("a composite start");
        };
        assert_eq!((animation % 2, key % 2), (1, 1), "the core's ids are odd");
        assert_eq!(spec, &jump.0.spec);
        let (first, key) = (*animation, *key);

        // Again: the run going on stops first; the key stays.
        let _ = jump.clone().start();
        let again = ops(&executor);
        assert!(matches!(
            &again[..],
            [
                AnimationOp::StopAnimation { animation: a },
                AnimationOp::StartComposite { animation: b, key: k, .. },
            ] if *a == first && *b != first && *k == key
        ));
        jump.stop();
        assert!(matches!(
            &ops(&executor)[..],
            [AnimationOp::StopAnimation { .. }]
        ));
        jump.stop();
        assert_eq!(ops(&executor), [], "stopped once");
        jump.reset();
        assert_eq!(ops(&executor), [AnimationOp::ResetComposite { key }]);

        drop(jump);
        assert_eq!(ops(&executor), [AnimationOp::ReleaseComposite { key }]);
    }

    #[test]
    fn delays_alone_end_at_once() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let end = Animation::sequence([Animation::delay(100.0)]).start();
        assert!(runtime.block_on(end.into_future()));
    }

    #[test]
    fn values_derive_like_their_nodes() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let t = AnimatedValue::new(&executor, 0.0);
        let right = Interpolation {
            extrapolate_right: Extrapolate::Extend,
            ..Interpolation::default()
        };
        let angle = t.interpolate_with(&[0.0, 1.0], Output::Numbers(vec![0.0, 180.0]), right);
        let [
            ..,
            AnimationOp::CreateInterpolate {
                extrapolate_left,
                extrapolate_right,
                easing,
                ..
            },
        ] = &ops(&executor)[..]
        else {
            panic!("an interpolation");
        };
        assert_eq!(
            (*extrapolate_left, *extrapolate_right, *easing),
            (Extrapolate::Clamp, Extrapolate::Extend, Easing::Linear)
        );
        // The same node as through `node()`.
        assert_eq!(
            angle,
            t.node()
                .interpolate_with(&[0.0, 1.0], Output::Numbers(vec![0.0, 180.0]), right)
        );
        assert_eq!(t.diff_clamp(0.0, 44.0), t.node().diff_clamp(0.0, 44.0));
        assert_eq!(t.mul(-1.0), t.node().mul(-1.0));
    }

    #[test]
    fn curves_sample_as_the_graph_runs_them() {
        // A spring from 0 to 1, one value a frame at 60 Hz, at rest at its
        // end; at 120 Hz about twice the frames.
        let spring = sample_spring(0.0, 1.0, Spring::default(), 60.0);
        assert_eq!(spring[0], 0.0);
        assert!((spring.last().unwrap() - 1.0).abs() < 1e-3, "{spring:?}");
        let fast = sample_spring(0.0, 1.0, Spring::default(), 120.0);
        assert!(fast.len() > spring.len() * 3 / 2, "{}", fast.len());
        // A spring that never rests stops at the cap.
        let undamped = Spring {
            damping: 0.0,
            ..Spring::default()
        };
        assert_eq!(
            sample_spring(0.0, 1.0, undamped, 60.0).len(),
            crate::animation::MAX_SAMPLES
        );
        // A fling glides on and slows down; within bounds it stops at one.
        let decay = sample_decay(0.0, 1000.0, 0.998, 60.0);
        assert!(decay.windows(2).all(|w| w[1] >= w[0]), "{decay:?}");
        assert!(*decay.last().unwrap() > 400.0, "{decay:?}");
        let within = sample_decay_within(0.0, 1000.0, 0.998, (0.0, 100.0), 0.0, 60.0);
        assert!(within.iter().all(|&x| (0.0..=100.0).contains(&x)));
        assert_eq!(*within.last().unwrap(), 100.0);
        // An easing's curve: both ends.
        let curve = super::super::sample_easing(Easing::EaseInOut, 5);
        assert_eq!((curve[0], curve[4], curve.len()), (0.0, 1.0, 5));
    }
}
