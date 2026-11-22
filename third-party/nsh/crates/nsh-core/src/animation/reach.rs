//! How far each node of the animation graph may go: the core's answer to
//! where an animated transform may take a view, without evaluating the
//! graph (the platforms do, every frame).
//!
//! Content culling and pacing (`core/cull.rs`, `core/pace.rs`) make a
//! scroll view's content only near its viewport. A view whose transform is
//! animated shows away from its frame, so its subtree was always made in
//! full: a page whose sections fade and slide in (an `Appear` wrapper) made
//! every view of every section in one frame. [`Reach`] follows the
//! [`AnimationOp`]s on their way to the platform and keeps, for each value,
//! the interval it has held and may hold (its value, every value set, the
//! targets of its animations with their easings' and springs' overshoot,
//! a decay's bounds), and for each derived node how it maps intervals. A
//! view whose transform entries are translations of bounded nodes moves at
//! most that far from its frame, and culling widens its rectangle by as
//! much; anything it cannot bound (a gesture's or a scroll view's value, a
//! decay without bounds, a scale or a rotation) keeps the view and its
//! content made with their parent, as before.
//!
//! Intervals only grow, so a bound holds for the past and for the future
//! until an op widens it; [`Reach::apply`] says when one did, and the core
//! looks at what it culls again in that commit, before the platform runs
//! the animation that may move a view into sight.

use rustc_hash::FxHashMap;

use super::{
    driver::ease,
    ops::{AnimationOp, Composite, Driver, Easing, Extrapolate, MathOp, NodeId, Operand, Output},
};

/// Derived nodes deeper than this are not bounded (a cycle, a JS bug).
const MAX_DEPTH: u32 = 32;

/// Points a curve with overshoot ([`Easing::Curve`]) is sampled at to
/// find how far it goes.
const CURVE_SAMPLES: usize = 129;

/// A closed interval.
type Span = (f32, f32);

/// What [`Reach`] keeps of one node.
#[derive(Debug, Clone)]
enum Def {
    /// A value: what its own value and its offset (`setOffset`) have held
    /// and may hold; `free` once something outside the graph drives it (a
    /// gesture, a scroll view) or an animation has no bound.
    Value {
        own: Span,
        offset: Span,
        free: bool,
        /// It has run an animation: it may be moving when the next starts
        /// with the velocity it has ([`Driver::Spring`]'s `velocity: None`).
        moved: bool,
    },
    /// An interpolation, reduced to what bounds it.
    Interpolate {
        input: NodeId,
        /// Its breakpoints and curve, for new outputs ([`AnimationOp::SetOutput`]).
        inputs: Box<[f32]>,
        easing: Easing,
        /// The first and last two breakpoints of the input and the outputs
        /// at them (equal pairs for a single breakpoint).
        first: [(f32, f32); 2],
        last: [(f32, f32); 2],
        /// The outputs' interval, widened by the easing's overshoot of the
        /// largest segment.
        outputs: Option<Span>,
        left: Extrapolate,
        right: Extrapolate,
    },
    DiffClamp {
        min: Operand,
        max: Operand,
    },
    Math {
        op: MathOp,
        a: Operand,
        b: Operand,
    },
}

/// The intervals of the animation graph's nodes (`reach.rs`).
#[derive(Debug, Default, Clone)]
pub(crate) struct Reach {
    nodes: FxHashMap<NodeId, Def>,
}

impl Reach {
    /// Takes in `op`; whether a value's interval widened or a derived
    /// node's mapping changed (a view bound to it may reach further now).
    pub(crate) fn apply(&mut self, op: &AnimationOp) -> bool {
        match op {
            AnimationOp::CreateValue { node, value } => {
                self.nodes.insert(
                    *node,
                    Def::Value {
                        own: (*value, *value),
                        offset: (0.0, 0.0),
                        free: !value.is_finite(),
                        moved: false,
                    },
                );
                false
            }
            AnimationOp::CreateInterpolate {
                node,
                input,
                input_range,
                output,
                extrapolate_left,
                extrapolate_right,
                easing,
            } => {
                let def = interpolate(
                    *input,
                    input_range.as_slice().into(),
                    output,
                    *extrapolate_left,
                    *extrapolate_right,
                    *easing,
                );
                self.nodes.insert(*node, def);
                false
            }
            AnimationOp::SetOutput { node, output } => {
                let Some(Def::Interpolate {
                    input,
                    inputs,
                    easing,
                    left,
                    right,
                    ..
                }) = self.nodes.get(node)
                else {
                    return false;
                };
                let def = interpolate(*input, inputs.clone(), output, *left, *right, *easing);
                self.nodes.insert(*node, def);
                true
            }
            AnimationOp::CreateDiffClamp { node, min, max, .. } => {
                self.nodes.insert(
                    *node,
                    Def::DiffClamp {
                        min: *min,
                        max: *max,
                    },
                );
                false
            }
            AnimationOp::CreateMath { node, op, a, b } => {
                self.nodes.insert(
                    *node,
                    Def::Math {
                        op: *op,
                        a: *a,
                        b: *b,
                    },
                );
                false
            }
            AnimationOp::Set { node, value } => self.widen_own(*node, (*value, *value)),
            AnimationOp::Start { node, driver, .. } => self.run(*node, driver),
            AnimationOp::StartComposite { spec, .. } => {
                // Twice: a loop's later runs start where the first left
                // them, and a sequence's steps where the step before did.
                let mut widened = self.composite(spec);
                widened |= self.composite(spec);
                widened
            }
            AnimationOp::Adjust { node, .. } => self.drive(*node),
            AnimationOp::SetOffset { node, offset } => {
                let Some(Def::Value { offset: o, .. }) = self.nodes.get_mut(node) else {
                    return false;
                };
                widen(o, (*offset, *offset))
            }
            AnimationOp::FlattenOffset { node } => {
                let Some(Def::Value { own, offset, .. }) = self.nodes.get_mut(node) else {
                    return false;
                };
                // Its own value takes in the offset, which goes to 0.
                let sum = (own.0 + offset.0, own.1 + offset.1);
                widen(own, sum) | widen(offset, (0.0, 0.0))
            }
            AnimationOp::ExtractOffset { node } => {
                let Some(Def::Value { own, offset, .. }) = self.nodes.get_mut(node) else {
                    return false;
                };
                // The offset takes in its own value, which goes to 0.
                let sum = (own.0 + offset.0, own.1 + offset.1);
                widen(offset, sum) | widen(own, (0.0, 0.0))
            }
            AnimationOp::Release { node } => {
                self.nodes.remove(node);
                false
            }
            // Values go back where they were, within what they held; a
            // stop leaves a value where it is.
            AnimationOp::ResetComposite { .. }
            | AnimationOp::ReleaseComposite { .. }
            | AnimationOp::Stop { .. }
            | AnimationOp::StopAnimation { .. }
            | AnimationOp::Read { .. } => false,
        }
    }

    /// Something outside the graph drives value `node` (a gesture, a
    /// scroll view): it has no bound from now on. Whether that is new.
    pub(crate) fn drive(&mut self, node: NodeId) -> bool {
        match self.nodes.get_mut(&node) {
            Some(Def::Value { free, .. }) if !*free => {
                *free = true;
                true
            }
            _ => false,
        }
    }

    /// The interval `node` may take, or `None` when it has no bound (or
    /// is not known: made by no op the core saw).
    pub(crate) fn range(&self, node: NodeId) -> Option<(f32, f32)> {
        self.span(node, 0)
            .filter(|s| s.0.is_finite() && s.1.is_finite())
    }

    fn span(&self, node: NodeId, depth: u32) -> Option<Span> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.nodes.get(&node)? {
            Def::Value {
                own, offset, free, ..
            } => (!*free).then_some((own.0 + offset.0, own.1 + offset.1)),
            Def::Interpolate {
                input,
                first,
                last,
                outputs,
                left,
                right,
                ..
            } => {
                let (lo, hi) = self.span(*input, depth + 1)?;
                let (i0, o0) = first[0];
                let (in_last, o_last) = last[1];
                let mut out: Option<Span> = None;
                // Within the breakpoints: anywhere among the outputs.
                if hi >= i0 && lo <= in_last {
                    out = Some((*outputs)?);
                }
                if lo < i0 {
                    let part = match left {
                        Extrapolate::Clamp => (o0, o0),
                        Extrapolate::Identity => (lo, hi.min(i0)),
                        Extrapolate::Extend => {
                            let at = extend(first[0], first[1], lo);
                            (at.min(o0), at.max(o0))
                        }
                    };
                    join(&mut out, part);
                }
                if hi > in_last {
                    let part = match right {
                        Extrapolate::Clamp => (o_last, o_last),
                        Extrapolate::Identity => (lo.max(in_last), hi),
                        Extrapolate::Extend => {
                            let at = extend(last[0], last[1], hi);
                            (at.min(o_last), at.max(o_last))
                        }
                    };
                    join(&mut out, part);
                }
                out
            }
            Def::DiffClamp { min, max } => {
                let min = self.operand(*min, depth)?;
                let max = self.operand(*max, depth)?;
                Some((min.0.min(max.0), max.1.max(min.1)))
            }
            Def::Math { op, a, b } => {
                let a = self.operand(*a, depth)?;
                let b = self.operand(*b, depth)?;
                match op {
                    MathOp::Add => Some((a.0 + b.0, a.1 + b.1)),
                    MathOp::Sub => Some((a.0 - b.1, a.1 - b.0)),
                    MathOp::Mul => Some(hull(&[a.0 * b.0, a.0 * b.1, a.1 * b.0, a.1 * b.1])),
                    MathOp::Div => {
                        // A divisor that may be 0 may give anything.
                        if b.0 <= 0.0 && b.1 >= 0.0 {
                            return None;
                        }
                        Some(hull(&[a.0 / b.0, a.0 / b.1, a.1 / b.0, a.1 / b.1]))
                    }
                    // Within `0..b` for a positive `b` (0 for 0).
                    MathOp::Mod if b.0 >= 0.0 => Some((0.0, b.1.max(0.0))),
                    MathOp::Mod => None,
                }
            }
        }
    }

    fn operand(&self, operand: Operand, depth: u32) -> Option<Span> {
        match operand {
            Operand::Const(c) => Some((c, c)),
            Operand::Node(node) => self.span(node, depth + 1),
        }
    }

    /// Widens value `node`'s own interval by `span`.
    fn widen_own(&mut self, node: NodeId, span: Span) -> bool {
        let Some(Def::Value { own, free, .. }) = self.nodes.get_mut(&node) else {
            return false;
        };
        if !(span.0.is_finite() && span.1.is_finite()) {
            let was = *free;
            *free = true;
            return !was;
        }
        widen(own, span)
    }

    /// Value `node` runs `driver` from anywhere it may be.
    fn run(&mut self, node: NodeId, driver: &Driver) -> bool {
        let Some(Def::Value {
            own, free, moved, ..
        }) = self.nodes.get_mut(&node)
        else {
            return false;
        };
        if *free {
            return false;
        }
        let from = *own;
        let was_moving = std::mem::replace(moved, true);
        let reach = match *driver {
            Driver::Timing { to, easing, .. } => {
                // Along the easing from each end of where it may start.
                let (e0, e1) = easing_span(easing);
                Some(hull(&[
                    from.0 + (to - from.0) * e0,
                    from.0 + (to - from.0) * e1,
                    from.1 + (to - from.1) * e0,
                    from.1 + (to - from.1) * e1,
                ]))
            }
            Driver::Spring {
                to,
                stiffness,
                mass,
                velocity,
                ..
            } => {
                // A damped spring's energy only falls: it swings at most
                // as far from its target as its start and speed give
                // (`|x| <= |x0| + |v| * sqrt(m / k)`). A spring that keeps
                // the speed of an animation it interrupts has an unknown
                // one: twice its distance stands for it.
                let distance = (from.0 - to).abs().max((from.1 - to).abs());
                let swing = match velocity {
                    Some(v) if stiffness > 0.0 && mass > 0.0 => {
                        distance + v.abs() * (mass / stiffness).sqrt()
                    }
                    Some(_) => f32::INFINITY,
                    None if was_moving => 2.0 * distance,
                    None => distance,
                };
                Some((to - swing, to + swing))
            }
            Driver::Decay { clamp, .. } => clamp.map(|(lo, hi)| (lo.min(hi), hi.max(lo))),
        };
        match reach {
            Some(span) if span.0.is_finite() && span.1.is_finite() => widen(own, span),
            _ => {
                *free = true;
                true
            }
        }
    }

    /// Takes in what composite `spec` runs.
    fn composite(&mut self, spec: &Composite) -> bool {
        match spec {
            Composite::Run { node, driver } => self.run(*node, driver),
            Composite::Sequence(children) | Composite::Parallel { children, .. } => children
                .iter()
                .fold(false, |widened, child| self.composite(child) | widened),
            Composite::Delay(_) => false,
            Composite::Loop { child, .. } => self.composite(child),
        }
    }
}

/// An interpolation reduced to its bounds.
fn interpolate(
    input: NodeId,
    input_range: Box<[f32]>,
    output: &Output,
    left: Extrapolate,
    right: Extrapolate,
    easing: Easing,
) -> Def {
    let numbers: &[f32] = match output {
        Output::Numbers(n) => n,
        // Colors move no view.
        Output::Colors(_) => &[],
    };
    let n = input_range.len().min(numbers.len());
    if n == 0 {
        return Def::Interpolate {
            input,
            inputs: input_range,
            easing,
            first: [(0.0, 0.0); 2],
            last: [(0.0, 0.0); 2],
            outputs: None,
            left,
            right,
        };
    }
    let at = |i: usize| (input_range[i], numbers[i]);
    let (e0, e1) = easing_span(easing);
    let mut outputs = hull(&numbers[..n]);
    // A segment's easing may overshoot its outputs.
    let widest = numbers[..n]
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0f32, f32::max);
    outputs.0 -= widest * (-e0).max(0.0);
    outputs.1 += widest * (e1 - 1.0).max(0.0);
    let finite = numbers[..n].iter().all(|v| v.is_finite());
    let (first, last) = (
        [at(0), at(1.min(n - 1))],
        [at(n.saturating_sub(2)), at(n - 1)],
    );
    Def::Interpolate {
        input,
        inputs: input_range,
        easing,
        first,
        last,
        outputs: finite.then_some(outputs),
        left,
        right,
    }
}

/// The interval an easing's progress takes on its way from 0 to 1.
fn easing_span(easing: Easing) -> Span {
    match easing {
        Easing::Linear
        | Easing::EaseIn
        | Easing::EaseOut
        | Easing::EaseInOut
        | Easing::Steps(..) => (0.0, 1.0),
        // A cubic Bézier stays within the hull of its control points.
        Easing::Bezier(_, y1, _, y2) => (y1.min(y2).min(0.0), y1.max(y2).max(1.0)),
        Easing::Curve(..) => {
            let (mut lo, mut hi) = (0.0f32, 1.0f32);
            for i in 0..CURVE_SAMPLES {
                let v = ease(easing, i as f32 / (CURVE_SAMPLES - 1) as f32);
                if v.is_finite() {
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
            // Between samples a peak may go a little further.
            let pad = (hi - lo) * 0.05;
            (
                lo - if lo < 0.0 { pad } else { 0.0 },
                hi + if hi > 1.0 { pad } else { 0.0 },
            )
        }
    }
}

/// The output of the segment through `a` and `b` (input, output) at `x`.
fn extend(a: (f32, f32), b: (f32, f32), x: f32) -> f32 {
    if b.0 == a.0 {
        return a.1;
    }
    a.1 + (x - a.0) * (b.1 - a.1) / (b.0 - a.0)
}

/// Widens `span` by `by`; whether it grew.
fn widen(span: &mut Span, by: Span) -> bool {
    let grown = (span.0.min(by.0), span.1.max(by.1));
    let changed = grown != *span;
    *span = grown;
    changed
}

fn join(out: &mut Option<Span>, part: Span) {
    *out = Some(match *out {
        Some(s) => (s.0.min(part.0), s.1.max(part.1)),
        None => part,
    });
}

fn hull(values: &[f32]) -> Span {
    values
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| {
            (lo.min(v), hi.max(v))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::{Curve, EaseMode};

    fn timing(to: f32, easing: Easing) -> Driver {
        Driver::Timing {
            to,
            duration_ms: 300.0,
            easing,
            delay_ms: 0.0,
            frame_rate: None,
        }
    }

    fn value(reach: &mut Reach, node: NodeId, value: f32) {
        reach.apply(&AnimationOp::CreateValue { node, value });
    }

    #[test]
    fn appear_slides_at_most_its_distance() {
        // `Appear`: 0 → 1 over an ease, mapped to a 14pt slide.
        let mut reach = Reach::default();
        value(&mut reach, 1, 0.0);
        reach.apply(&AnimationOp::CreateInterpolate {
            node: 2,
            input: 1,
            input_range: vec![0.0, 1.0],
            output: Output::Numbers(vec![14.0, 0.0]),
            extrapolate_left: Extrapolate::Extend,
            extrapolate_right: Extrapolate::Extend,
            easing: Easing::Linear,
        });
        // Within the breakpoints the interval is the outputs' hull, not
        // the exact image: loose, never too small (a view's reach is the
        // larger magnitude, 14 here whether it rests at 14 or slides).
        assert_eq!(reach.range(2), Some((0.0, 14.0)));
        assert!(reach.apply(&AnimationOp::Start {
            node: 1,
            animation: 1,
            driver: timing(1.0, Easing::Bezier(0.2, 0.0, 0.0, 1.0)),
        }));
        assert_eq!(reach.range(1), Some((0.0, 1.0)));
        assert_eq!(reach.range(2), Some((0.0, 14.0)));
        // Running it again to where it went widens nothing.
        assert!(!reach.apply(&AnimationOp::Start {
            node: 1,
            animation: 2,
            driver: timing(1.0, Easing::Linear),
        }));
    }

    #[test]
    fn overshoot_widens_the_interval() {
        let mut reach = Reach::default();
        value(&mut reach, 1, 0.0);
        reach.apply(&AnimationOp::Start {
            node: 1,
            animation: 1,
            driver: timing(100.0, Easing::Curve(Curve::Back(1.70158), EaseMode::Out)),
        });
        let (lo, hi) = reach.range(1).unwrap();
        assert!(lo <= 0.0 && hi > 105.0, "{lo} {hi}");
        let mut reach = Reach::default();
        value(&mut reach, 1, 0.0);
        reach.apply(&AnimationOp::Start {
            node: 1,
            animation: 1,
            driver: Driver::Spring {
                to: 100.0,
                stiffness: 100.0,
                damping: 2.0,
                mass: 1.0,
                velocity: None,
                frame_rate: None,
            },
        });
        // At most as far past its target as it started from it.
        assert_eq!(reach.range(1), Some((0.0, 200.0)));
    }

    #[test]
    fn drivers_outside_the_graph_and_free_decays_have_no_bound() {
        let mut reach = Reach::default();
        value(&mut reach, 1, 0.0);
        assert!(reach.drive(1));
        assert_eq!(reach.range(1), None);
        value(&mut reach, 2, 0.0);
        reach.apply(&AnimationOp::Start {
            node: 2,
            animation: 1,
            driver: Driver::Decay {
                velocity: Some(1000.0),
                deceleration: 0.998,
                clamp: None,
                bounce: 0.0,
                frame_rate: None,
            },
        });
        assert_eq!(reach.range(2), None);
        // A node made by no op the core saw.
        assert_eq!(reach.range(9), None);
    }

    #[test]
    fn math_clamps_and_offsets() {
        let mut reach = Reach::default();
        value(&mut reach, 1, 10.0);
        reach.apply(&AnimationOp::SetOffset {
            node: 1,
            offset: 5.0,
        });
        assert_eq!(reach.range(1), Some((10.0, 15.0)));
        reach.apply(&AnimationOp::CreateMath {
            node: 2,
            op: MathOp::Mul,
            a: Operand::Node(1),
            b: Operand::Const(-2.0),
        });
        assert_eq!(reach.range(2), Some((-30.0, -20.0)));
        reach.apply(&AnimationOp::CreateInterpolate {
            node: 3,
            input: 2,
            input_range: vec![0.0, 1.0],
            output: Output::Numbers(vec![0.0, 50.0]),
            extrapolate_left: Extrapolate::Clamp,
            extrapolate_right: Extrapolate::Clamp,
            easing: Easing::Linear,
        });
        assert_eq!(reach.range(3), Some((0.0, 0.0)));
        reach.apply(&AnimationOp::CreateMath {
            node: 4,
            op: MathOp::Div,
            a: Operand::Const(1.0),
            b: Operand::Node(2),
        });
        assert!(reach.range(4).is_some());
        reach.apply(&AnimationOp::Set {
            node: 1,
            value: 0.0,
        });
        // The divisor may be 0 now.
        assert_eq!(reach.range(4), None);
    }
}
