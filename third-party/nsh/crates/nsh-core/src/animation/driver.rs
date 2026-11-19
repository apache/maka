//! Animation drivers. All are closed-form functions of elapsed time, so the
//! result does not depend on frame rate or dropped frames.

use crate::animation::ops::{AnimationId, Curve, Driver, EaseMode, Easing, StepPosition};

/// Spring rest thresholds (value units and units per second).
const REST_DISPLACEMENT: f32 = 0.001;
const REST_VELOCITY: f32 = 0.001;
/// Decay stops when it moves less than this per millisecond.
const DECAY_REST_SPEED: f32 = 0.0005;

/// How often an animation whose end is not known in advance (a spring, a
/// decay that bounces) is checked while no frames are drawn
/// ([`Running::deadline`]): it settles within this of its real end.
pub(crate) const CHECK_SECONDS: f64 = 0.1;

/// One animation running on a value.
#[derive(Debug, Clone)]
pub(crate) struct Running {
    pub(crate) id: AnimationId,
    driver: Driver,
    from: f32,
    velocity: f32,
    /// First frame time (seconds); set on the first step.
    start: Option<f64>,
    /// The frame time (seconds) of the last step.
    last: Option<f64>,
}

impl Running {
    /// Started at `start` (seconds) rather than on the first step: steps of
    /// a composite animation follow each other without a frame's gap.
    pub(crate) fn starting_at(mut self, start: f64) -> Self {
        self.start = Some(start);
        self
    }

    /// The frame time (seconds) of its last step: where an animation that
    /// replaces it starts, holding the value and velocity of that frame.
    pub(crate) fn last_step(&self) -> Option<f64> {
        self.last
    }

    pub(crate) fn new(id: AnimationId, driver: Driver, from: f32, velocity: f32) -> Self {
        let driver = sanitized(driver, from);
        let velocity = if velocity.is_finite() { velocity } else { 0.0 };
        let velocity = match driver {
            Driver::Spring {
                velocity: Some(v), ..
            }
            | Driver::Decay {
                velocity: Some(v), ..
            } => v,
            _ => velocity,
        };
        Self {
            id,
            driver,
            from,
            velocity,
            start: None,
            last: None,
        }
    }

    /// The highest frame rate it needs ([`Driver::frame_rate`]).
    pub(crate) fn frame_rate(&self) -> Option<f32> {
        self.driver.frame_rate()
    }

    /// When an animation that ended at the frame `now` really ended: timings
    /// end on time; springs and decays when the frame noticed.
    pub(crate) fn end_time(&self, now: f64) -> f64 {
        match (self.driver, self.start) {
            (
                Driver::Timing {
                    duration_ms,
                    delay_ms,
                    ..
                },
                Some(start),
            ) => (start + (delay_ms.max(0.0) + duration_ms.max(0.0)) as f64 / 1000.0).min(now),
            _ => now,
        }
    }

    /// When this animation ends, as far as it can tell before it does
    /// (seconds, the clock `now` is on): a timing's end; a decay without
    /// bounds when it slows to rest; a spring or a bounded decay, which
    /// bounce, [`CHECK_SECONDS`] from `now`. `now` before its first step,
    /// which gives it its start.
    pub(crate) fn deadline(&self, now: f64) -> f64 {
        let Some(start) = self.start else { return now };
        match self.driver {
            Driver::Timing {
                duration_ms,
                delay_ms,
                ..
            } => start + (delay_ms.max(0.0) + duration_ms.max(0.0)) as f64 / 1000.0,
            Driver::Decay {
                deceleration,
                clamp: None,
                ..
            } => {
                let speed = (self.velocity / 1000.0).abs();
                if speed < DECAY_REST_SPEED {
                    return start;
                }
                let ms = (speed / DECAY_REST_SPEED).ln() / decay_rate(deceleration);
                start + ms as f64 / 1000.0
            }
            Driver::Spring { .. } | Driver::Decay { .. } => now + CHECK_SECONDS,
        }
    }

    /// Advances to `now` (seconds). Returns `(value, velocity, finished)`.
    /// A value that is not finite ends the animation (the parameters are
    /// checked when it starts; this is for numbers that overflow on the
    /// way, such as a velocity near `f32::MAX`): a timing or spring at its
    /// target, a decay where it started (its travel is what overflowed, on
    /// its first frame).
    pub(crate) fn step(&mut self, now: f64) -> (f32, f32, bool) {
        let (value, velocity, done) = self.advance(now);
        if value.is_finite() && velocity.is_finite() {
            return (value, velocity, done);
        }
        let rest = match self.driver {
            Driver::Timing { to, .. } | Driver::Spring { to, .. } => to,
            Driver::Decay { .. } => self.from,
        };
        (rest, 0.0, true)
    }

    fn advance(&mut self, now: f64) -> (f32, f32, bool) {
        let start = *self.start.get_or_insert(now);
        self.last = Some(now);
        if let Driver::Decay {
            deceleration,
            clamp: Some(bounds),
            bounce,
            ..
        } = self.driver
        {
            return self.bounded_decay(now, deceleration, bounds, bounce);
        }
        let t = (now - start).max(0.0) as f32;
        match self.driver {
            Driver::Timing {
                to,
                duration_ms,
                easing,
                delay_ms,
                ..
            } => {
                let t_ms = t * 1000.0 - delay_ms;
                // A step of no duration (a keyframe's jump) ends on the
                // frame it starts, so the next one starts with it.
                if t_ms < 0.0 || (t_ms == 0.0 && duration_ms > 0.0) {
                    return (self.from, 0.0, false);
                }
                if t_ms >= duration_ms {
                    return (to, 0.0, true);
                }
                let linear = t_ms / duration_ms;
                // A curve that overflows (`poly` of a negative power near
                // 0) moves linearly there, keeping the duration.
                let p = Some(ease(easing, linear))
                    .filter(|p| p.is_finite())
                    .unwrap_or(linear);
                (self.from + (to - self.from) * p, 0.0, false)
            }
            Driver::Spring {
                to,
                stiffness,
                damping,
                mass,
                ..
            } => {
                let x0 = self.from - to;
                let (x, v) = spring(x0, self.velocity, stiffness, damping, mass, t);
                if x.abs() < REST_DISPLACEMENT && v.abs() < REST_VELOCITY {
                    (to, 0.0, true)
                } else {
                    (to + x, v, false)
                }
            }
            Driver::Decay { deceleration, .. } => decay(self.from, self.velocity, deceleration, t),
        }
    }

    /// A decay within `bounds`: each time it reaches one it stops there, or
    /// goes on from it in the other direction with `bounce` of its speed
    /// (a new segment of the closed form, starting at the exact time it got
    /// there).
    fn bounded_decay(
        &mut self,
        now: f64,
        deceleration: f32,
        (a, b): (f32, f32),
        bounce: f32,
    ) -> (f32, f32, bool) {
        let (lo, hi) = (a.min(b), a.max(b));
        let k = decay_rate(deceleration);
        // A few bounces may fall within one frame.
        for _ in 0..16 {
            let start = self.start.unwrap_or(now);
            let t_ms = ((now - start).max(0.0) * 1000.0) as f32;
            if self.from < lo || self.from > hi {
                // Started outside: it goes to the bound and stays.
                self.from = self.from.clamp(lo, hi);
                self.velocity = 0.0;
                return (self.from, 0.0, true);
            }
            let v0 = self.velocity / 1000.0;
            let bound = if v0 > 0.0 { hi } else { lo };
            // The fraction of the whole travel (`v0 / k`) that reaches the
            // bound; at 1 or more it never gets there.
            let reach = if v0 == 0.0 {
                f32::INFINITY
            } else {
                (bound - self.from) * k / v0
            };
            let hit = (reach < 1.0).then(|| -(1.0 - reach.max(0.0)).ln() / k);
            match hit {
                Some(hit) if hit <= t_ms => {
                    let speed = -v0 * (-k * hit).exp() * bounce.clamp(0.0, 1.0);
                    self.from = bound;
                    if speed.abs() < DECAY_REST_SPEED {
                        self.velocity = 0.0;
                        return (bound, 0.0, true);
                    }
                    self.velocity = speed * 1000.0;
                    self.start = Some(start + hit as f64 / 1000.0);
                }
                _ => {
                    let (value, velocity, done) =
                        decay(self.from, self.velocity, deceleration, t_ms / 1000.0);
                    return (value.clamp(lo, hi), velocity, done);
                }
            }
        }
        (self.from, 0.0, true)
    }
}

/// `driver` with parameters its closed form can run, starting from `from`.
/// The decoders take any number from JS or Rust, and a spring without
/// stiffness once computed `0 * inf`: its value was NaN on every frame and
/// it never came to rest. What cannot move the value (stiffness or mass
/// not above 0, damping or a target that is not finite, a NaN or infinite
/// duration) ends at once where it would rest; negative damping, which
/// would grow without end, is no damping (it oscillates as an undamped
/// spring does); a velocity that is not finite is 0; an easing whose
/// numbers are not finite is linear; a NaN delay is none (an infinite one
/// waits, as a sequence's does); a NaN deceleration or bounce is 0 (the
/// clamps of [`decay`] and the bounds already hold infinite ones); and
/// bounds that leave no finite place, both NaN (which made `f32::clamp`
/// panic) or both the same infinity (the value became it), are none.
/// Silent: it runs again on every pass of a loop, so [`warn_out_of_range`]
/// reports once where the animation starts.
fn sanitized(driver: Driver, from: f32) -> Driver {
    match driver {
        Driver::Timing {
            to,
            duration_ms,
            easing,
            delay_ms,
            frame_rate,
        } => Driver::Timing {
            to: finite_or(to, from),
            // A negative one, -inf too, already ended at once.
            duration_ms: if never_ends(duration_ms) {
                0.0
            } else {
                duration_ms
            },
            easing: if easing_finite(easing) {
                easing
            } else {
                Easing::Linear
            },
            delay_ms: nan_or(delay_ms, 0.0),
            frame_rate,
        },
        Driver::Spring {
            to,
            stiffness,
            damping,
            mass,
            velocity,
            frame_rate,
        } => {
            let to = finite_or(to, from);
            if !spring_moves(stiffness, damping, mass) {
                return Driver::Timing {
                    to,
                    duration_ms: 0.0,
                    easing: Easing::Linear,
                    delay_ms: 0.0,
                    frame_rate,
                };
            }
            Driver::Spring {
                to,
                stiffness,
                damping: damping.max(0.0),
                mass,
                velocity: velocity.map(|v| finite_or(v, 0.0)),
                frame_rate,
            }
        }
        Driver::Decay {
            velocity,
            deceleration,
            clamp,
            bounce,
            frame_rate,
        } => Driver::Decay {
            velocity: velocity.map(|v| finite_or(v, 0.0)),
            deceleration: nan_or(deceleration, 0.0),
            // One NaN bound is the other (`min` / `max` pick it, as on
            // `main`).
            clamp: clamp.filter(|&(a, b)| bounds_hold(a, b)),
            bounce: nan_or(bounce, 0.0),
            frame_rate,
        },
    }
}

/// Whether a spring of these parameters moves a value: stiffness and mass
/// above 0, a finite damping.
fn spring_moves(stiffness: f32, damping: f32, mass: f32) -> bool {
    let positive = |v: f32| v.is_finite() && v > 0.0;
    positive(stiffness) && positive(mass) && damping.is_finite()
}

/// Whether a duration never ends a timing: NaN (no time reaches it) or
/// infinite.
fn never_ends(duration_ms: f32) -> bool {
    duration_ms.is_nan() || duration_ms == f32::INFINITY
}

/// Whether `easing`'s own numbers are finite.
fn easing_finite(easing: Easing) -> bool {
    match easing {
        Easing::Bezier(x1, y1, x2, y2) => [x1, y1, x2, y2].iter().all(|v| v.is_finite()),
        Easing::Curve(Curve::Poly(n) | Curve::Elastic(n) | Curve::Back(n), _) => n.is_finite(),
        _ => true,
    }
}

/// Whether bounds leave a finite place for the value: not both NaN, not
/// both the same infinity (after `min` / `max`, which take the other of
/// one NaN).
fn bounds_hold(a: f32, b: f32) -> bool {
    let (lo, hi) = (a.min(b), a.max(b));
    !lo.is_nan() && !(lo.is_infinite() && lo == hi)
}

/// Whether [`sanitized`] changes `driver` (a target it keeps is a finite
/// one, so `from` does not matter).
fn out_of_range(driver: &Driver) -> bool {
    match *driver {
        Driver::Timing {
            to,
            duration_ms,
            easing,
            delay_ms,
            ..
        } => {
            !to.is_finite()
                || never_ends(duration_ms)
                || !easing_finite(easing)
                || delay_ms.is_nan()
        }
        Driver::Spring {
            to,
            stiffness,
            damping,
            mass,
            velocity,
            ..
        } => {
            !(to.is_finite()
                && spring_moves(stiffness, damping, mass)
                && damping >= 0.0
                && velocity.is_none_or(f32::is_finite))
        }
        Driver::Decay {
            velocity,
            deceleration,
            clamp,
            bounce,
            ..
        } => {
            velocity.is_some_and(|v| !v.is_finite())
                || deceleration.is_nan()
                || bounce.is_nan()
                || clamp.is_some_and(|(a, b)| !bounds_hold(a, b))
        }
    }
}

#[cfg(test)]
thread_local! {
    /// How often [`warn_out_of_range`] warned on this thread: tests count
    /// the warnings without a global logger.
    pub(crate) static WARNINGS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Logs, once where an animation starts, that `driver` holds parameters
/// [`sanitized`] replaces, so the app learns why it moved as it did.
pub(crate) fn warn_out_of_range(driver: &Driver) {
    if out_of_range(driver) {
        #[cfg(test)]
        WARNINGS.with(|n| n.set(n.get() + 1));
        log::warn!(
            "animation parameters out of range ({driver:?}): replaced by ones it can run (a spring that cannot move jumps to its target)"
        );
    }
}

/// `v`, or `default` when it is not finite.
fn finite_or(v: f32, default: f32) -> f32 {
    if v.is_finite() { v } else { default }
}

/// `v`, or `default` when it is not a number.
fn nan_or(v: f32, default: f32) -> f32 {
    if v.is_nan() { default } else { v }
}

/// `1 - deceleration`: the fraction of velocity lost per millisecond.
fn decay_rate(deceleration: f32) -> f32 {
    1.0 - deceleration.clamp(0.0, 0.999_999)
}

/// Value, velocity and whether it stopped `t` seconds into a decay from
/// `from` at `velocity` (units per second).
fn decay(from: f32, velocity: f32, deceleration: f32, t: f32) -> (f32, f32, bool) {
    // Velocity in units per millisecond decays by `deceleration` every
    // millisecond (React Native's formula).
    let v0 = velocity / 1000.0;
    let k = decay_rate(deceleration);
    let decay = (-k * t * 1000.0).exp();
    let value = from + v0 / k * (1.0 - decay);
    let speed = v0 * decay;
    (value, speed * 1000.0, speed.abs() < DECAY_REST_SPEED)
}

/// Most samples a sampled curve should have (a minute at 60 Hz): the cap
/// of [`sample_driver`]'s callers (a spring without damping never ends).
pub const MAX_SAMPLES: usize = 3600;

/// `easing` at `count` evenly spaced points of `0..=1` (both ends
/// included): the curve a timing animation follows, to draw it.
pub fn sample_easing(easing: Easing, count: usize) -> Vec<f32> {
    match count {
        0 => Vec::new(),
        1 => vec![ease(easing, 0.0)],
        n => (0..n)
            .map(|i| ease(easing, i as f32 / (n - 1) as f32))
            .collect(),
    }
}

/// The values `driver` moves a value through from `from`, every `step`
/// seconds from its start until it ends (the last sample is where it
/// ends), at most `max` of them: the exact curve the animation runs.
pub fn sample_driver(driver: Driver, from: f32, step: f64, max: usize) -> Vec<f32> {
    warn_out_of_range(&driver);
    let mut running = Running::new(0, driver, from, 0.0).starting_at(0.0);
    let step = step.max(1e-4);
    let mut out = Vec::new();
    for i in 0..max {
        let (value, _, done) = running.step(i as f64 * step);
        out.push(value);
        if done {
            break;
        }
    }
    out
}

/// Displacement and velocity of a damped spring after `t` seconds, from
/// displacement `x0` and velocity `v0`.
fn spring(x0: f32, v0: f32, k: f32, c: f32, m: f32, t: f32) -> (f32, f32) {
    let (x0, v0, k, c, m, t) = (
        x0 as f64,
        v0 as f64,
        k as f64,
        c as f64,
        m.max(1e-6) as f64,
        t as f64,
    );
    let w0 = (k / m).sqrt();
    let zeta = c / (2.0 * (k * m).sqrt());
    let (x, v) = if zeta < 1.0 {
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        let a = x0;
        let b = (v0 + zeta * w0 * x0) / wd;
        let e = (-zeta * w0 * t).exp();
        let (s, co) = (wd * t).sin_cos();
        let x = e * (a * co + b * s);
        let v = e * ((b * wd - zeta * w0 * a) * co - (a * wd + zeta * w0 * b) * s);
        (x, v)
    } else if (zeta - 1.0).abs() < 1e-9 {
        let e = (-w0 * t).exp();
        let b = v0 + w0 * x0;
        (e * (x0 + b * t), e * (b - w0 * (x0 + b * t)))
    } else {
        // Two decaying exponentials, not `e^(-ζω₀t) · cosh(ω_d t)`: cosh
        // overflows (`ω_d t` past ~710) long before the product is small,
        // so a strongly overdamped spring (from about ζ 7.5 over a travel
        // of 1) went infinite, then NaN, mid-flight.
        // `r1` is written so it does not cancel when ζ is large.
        let s = (zeta * zeta - 1.0).sqrt();
        let r1 = -w0 / (zeta + s);
        let r2 = -w0 * (zeta + s);
        let c1 = (v0 - r2 * x0) / (r1 - r2);
        let c2 = x0 - c1;
        let (e1, e2) = ((r1 * t).exp(), (r2 * t).exp());
        (c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2)
    };
    (x as f32, v as f32)
}

pub(crate) fn ease(easing: Easing, p: f32) -> f32 {
    match easing {
        Easing::Linear => p,
        Easing::EaseIn => cubic_bezier(0.42, 0.0, 1.0, 1.0, p),
        Easing::EaseOut => cubic_bezier(0.0, 0.0, 0.58, 1.0, p),
        Easing::EaseInOut => cubic_bezier(0.42, 0.0, 0.58, 1.0, p),
        Easing::Bezier(x1, y1, x2, y2) => cubic_bezier(x1, y1, x2, y2, p),
        Easing::Curve(curve, mode) => match mode {
            EaseMode::In => curve_in(curve, p),
            EaseMode::Out => 1.0 - curve_in(curve, 1.0 - p),
            EaseMode::InOut if p < 0.5 => curve_in(curve, p * 2.0) / 2.0,
            EaseMode::InOut => 1.0 - curve_in(curve, (1.0 - p) * 2.0) / 2.0,
        },
        Easing::Steps(count, position) => steps(count, position, p),
    }
}

/// CSS `steps(count, position)` at `p` (Easing Functions Level 2, without
/// the before flag, which only matters for fill modes).
fn steps(count: u32, position: StepPosition, p: f32) -> f32 {
    let count = match position {
        StepPosition::JumpNone => count.max(2),
        _ => count.max(1),
    } as f32;
    let jumps = match position {
        StepPosition::JumpStart | StepPosition::JumpEnd => count,
        StepPosition::JumpNone => count - 1.0,
        StepPosition::JumpBoth => count + 1.0,
    };
    let mut step = (p * count).floor();
    if matches!(position, StepPosition::JumpStart | StepPosition::JumpBoth) {
        step += 1.0;
    }
    if p >= 0.0 && step < 0.0 {
        step = 0.0;
    }
    if p <= 1.0 && step > jumps {
        step = jumps;
    }
    step / jumps
}

/// React Native's `Easing` functions (their own, "in", form).
fn curve_in(curve: Curve, t: f32) -> f32 {
    use std::f32::consts::PI;
    match curve {
        Curve::Quad => t * t,
        Curve::Cubic => t * t * t,
        Curve::Poly(n) => t.powf(n),
        Curve::Sin => 1.0 - (t * PI / 2.0).cos(),
        Curve::Circle => 1.0 - (1.0 - t * t).max(0.0).sqrt(),
        Curve::Exp => 2f32.powf(10.0 * (t - 1.0)),
        Curve::Elastic(bounciness) => {
            let p = bounciness * PI;
            1.0 - (t * PI / 2.0).cos().powi(3) * (t * p).cos()
        }
        Curve::Back(s) => t * t * ((s + 1.0) * t - s),
        Curve::Bounce => {
            if t < 1.0 / 2.75 {
                7.5625 * t * t
            } else if t < 2.0 / 2.75 {
                let t = t - 1.5 / 2.75;
                7.5625 * t * t + 0.75
            } else if t < 2.5 / 2.75 {
                let t = t - 2.25 / 2.75;
                7.5625 * t * t + 0.9375
            } else {
                let t = t - 2.625 / 2.75;
                7.5625 * t * t + 0.984375
            }
        }
    }
}

/// CSS `cubic-bezier()`: solves x(t) = p for t, returns y(t).
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, p: f32) -> f32 {
    let (x1, x2) = (x1.clamp(0.0, 1.0), x2.clamp(0.0, 1.0));
    let bez = |a: f32, b: f32, t: f32| {
        let u = 1.0 - t;
        3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
    };
    let dx = |t: f32| {
        let u = 1.0 - t;
        3.0 * u * u * x1 + 6.0 * u * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2)
    };
    // Newton first, bisection when the slope is too flat.
    let mut t = p;
    for _ in 0..8 {
        let err = bez(x1, x2, t) - p;
        if err.abs() < 1e-6 {
            return bez(y1, y2, t);
        }
        let d = dx(t);
        if d.abs() < 1e-6 {
            break;
        }
        t = (t - err / d).clamp(0.0, 1.0);
    }
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    t = p;
    for _ in 0..32 {
        let x = bez(x1, x2, t);
        if (x - p).abs() < 1e-6 {
            break;
        }
        if x < p {
            lo = t;
        } else {
            hi = t;
        }
        t = (lo + hi) / 2.0;
    }
    bez(y1, y2, t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(mut r: Running, until: f64) -> (f32, f64) {
        let mut now = 0.0;
        loop {
            let (v, _, done) = r.step(now);
            if done || now > until {
                return (v, now);
            }
            now += 1.0 / 60.0;
        }
    }

    #[test]
    fn timing_reaches_target_on_time() {
        let r = Running::new(
            1,
            Driver::Timing {
                to: 100.0,
                duration_ms: 300.0,
                easing: Easing::EaseInOut,
                delay_ms: 0.0,
                frame_rate: None,
            },
            0.0,
            0.0,
        );
        let (v, t) = run(r, 2.0);
        assert_eq!(v, 100.0);
        assert!((0.29..0.33).contains(&t), "{t}");
    }

    #[test]
    fn easing_curves_are_monotonic_and_pinned() {
        for e in [
            Easing::Linear,
            Easing::EaseIn,
            Easing::EaseOut,
            Easing::EaseInOut,
        ] {
            assert!(ease(e, 0.0).abs() < 1e-4 && (ease(e, 1.0) - 1.0).abs() < 1e-4);
            let mut prev = -1.0;
            for i in 0..=100 {
                let y = ease(e, i as f32 / 100.0);
                assert!(y >= prev - 1e-5, "{e:?} not monotonic");
                prev = y;
            }
        }
        assert!((ease(Easing::EaseInOut, 0.5) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn springs_settle_in_all_damping_regimes() {
        for damping in [10.0, 2.0 * (100.0f32).sqrt(), 60.0] {
            let r = Running::new(
                1,
                Driver::Spring {
                    to: 1.0,
                    stiffness: 100.0,
                    damping,
                    mass: 1.0,
                    velocity: Some(0.0),
                    frame_rate: None,
                },
                0.0,
                0.0,
            );
            let (v, t) = run(r, 10.0);
            assert_eq!(v, 1.0, "damping {damping}");
            assert!(t < 10.0, "damping {damping} did not settle");
        }
    }

    #[test]
    fn underdamped_spring_overshoots_and_matches_velocity() {
        let mut r = Running::new(
            1,
            Driver::Spring {
                to: 1.0,
                stiffness: 200.0,
                damping: 5.0,
                mass: 1.0,
                velocity: Some(0.0),
                frame_rate: None,
            },
            0.0,
            0.0,
        );
        let mut max = 0.0f32;
        let mut now = 0.0;
        let mut prev = r.step(now).0;
        while now < 1.0 {
            now += 0.001;
            let (v, vel, _) = r.step(now);
            max = max.max(v);
            // Analytic velocity agrees with the numeric derivative.
            assert!(((v - prev) / 0.001 - vel).abs() < 0.5, "at {now}");
            prev = v;
        }
        assert!(max > 1.2, "no overshoot: {max}");
    }

    #[test]
    fn decay_travels_and_stops() {
        let r = Running::new(
            1,
            Driver::Decay {
                velocity: Some(1000.0),
                deceleration: 0.998,
                clamp: None,
                bounce: 0.0,
                frame_rate: None,
            },
            0.0,
            0.0,
        );
        let (v, t) = run(r, 10.0);
        // Total travel = v0 / (1 - d) = 1 unit/ms / 0.002 = 500 units.
        assert!((v - 500.0).abs() < 2.0, "{v}");
        assert!(t < 5.0);
    }

    fn bounded(bounce: f32) -> Driver {
        Driver::Decay {
            velocity: Some(1000.0),
            deceleration: 0.998,
            clamp: Some((-50.0, 100.0)),
            bounce,
            frame_rate: None,
        }
    }

    #[test]
    fn bounded_decay_stops_at_the_bound() {
        let mut r = Running::new(1, bounded(0.0), 0.0, 0.0);
        // Free travel would be 500: it reaches 100 after
        // -ln(1 - 100 * 0.002) / 0.002 ≈ 111.6 ms and stays.
        assert_eq!(r.step(0.0), (0.0, 1000.0, false));
        let (v, _, done) = r.step(0.1);
        assert!(v < 100.0 && !done, "{v}");
        assert_eq!(r.step(0.112), (100.0, 0.0, true));
        // Starting outside: at the bound at once.
        let mut r = Running::new(1, bounded(0.0), 300.0, 0.0);
        assert_eq!(r.step(0.0), (100.0, 0.0, true));
    }

    #[test]
    fn bounded_decay_bounces_within_the_bounds() {
        let r = Running::new(1, bounded(0.5), 0.0, 0.0);
        let mut r2 = r.clone();
        let (v, t) = run(r, 10.0);
        assert!((-50.0..=100.0).contains(&v), "{v}");
        assert!(t < 10.0, "did not settle");
        // Back from the top bound, moving down, soon after hitting it.
        r2.step(0.0);
        let (v, vel, _) = r2.step(0.15);
        assert!(v < 100.0 && vel < 0.0, "{v} {vel}");
        // Frame independent: one big step lands where small ones do.
        let mut a = Running::new(1, bounded(0.5), 0.0, 0.0);
        let mut b = a.clone();
        a.step(0.0);
        b.step(0.0);
        for i in 1..=60 {
            a.step(i as f64 / 120.0);
        }
        let (x, _, _) = a.step(0.5);
        let (y, _, _) = b.step(0.5);
        assert!((x - y).abs() < 1e-3, "{x} {y}");
    }

    #[test]
    fn samples_follow_the_drivers() {
        let linear = sample_easing(Easing::Linear, 5);
        assert_eq!(linear, [0.0, 0.25, 0.5, 0.75, 1.0]);
        let quad = sample_easing(Easing::Curve(Curve::Quad, EaseMode::In), 3);
        assert_eq!(quad, [0.0, 0.25, 1.0]);
        assert!(sample_easing(Easing::Linear, 0).is_empty());
        let spring = Driver::Spring {
            to: 1.0,
            stiffness: 100.0,
            damping: 10.0,
            mass: 1.0,
            velocity: Some(0.0),
            frame_rate: None,
        };
        let samples = sample_driver(spring, 0.0, 1.0 / 60.0, 1000);
        assert_eq!(samples[0], 0.0);
        assert_eq!(*samples.last().unwrap(), 1.0);
        assert!(samples.iter().any(|&v| v > 1.0), "overshoots");
        assert!(samples.len() < 1000);
        // Exactly the frames a running spring shows.
        let mut r = Running::new(1, spring, 0.0, 0.0).starting_at(0.0);
        assert_eq!(r.step(10.0 / 60.0).0, samples[10]);
        assert_eq!(sample_driver(spring, 0.0, 1.0 / 60.0, 3).len(), 3);
    }

    /// Every value a driver gives is finite, as is when it expects to end
    /// while no frames are drawn ([`Running::deadline`]), and it ends within
    /// `limit` seconds.
    fn ends_finite(driver: Driver, from: f32, limit: f64) -> f32 {
        // What is replaced is also what is reported.
        assert!(out_of_range(&driver), "{driver:?}: not reported");
        let mut r = Running::new(1, driver, from, 0.0).starting_at(0.0);
        let mut now = 0.0;
        loop {
            assert!(r.deadline(now).is_finite(), "{driver:?}: deadline");
            let (v, velocity, done) = r.step(now);
            assert!(
                v.is_finite() && velocity.is_finite(),
                "{driver:?}: {v} {velocity}"
            );
            if done {
                return v;
            }
            assert!(now < limit, "{driver:?} never ends");
            now += 1.0 / 60.0;
        }
    }

    #[test]
    fn invalid_spring_parameters_end_at_the_target() {
        let spring = |stiffness, damping, mass, velocity| Driver::Spring {
            to: 1.0,
            stiffness,
            damping,
            mass,
            velocity,
            frame_rate: None,
        };
        for driver in [
            // No stiffness: the overdamped form once computed 0 * inf.
            spring(0.0, 26.0, 1.0, None),
            spring(0.0, 0.0, 1.0, None),
            spring(-10.0, 26.0, 1.0, None),
            spring(f32::NAN, 26.0, 1.0, None),
            spring(f32::INFINITY, 26.0, 1.0, None),
            spring(170.0, f32::NAN, 1.0, None),
            spring(170.0, 26.0, f32::INFINITY, None),
            spring(170.0, 26.0, f32::NAN, None),
            spring(170.0, 26.0, -1.0, None),
            // A negative mass without damping never ended.
            spring(170.0, 0.0, -1.0, None),
            spring(170.0, 26.0, 1.0, Some(f32::NAN)),
            spring(170.0, 26.0, 1.0, Some(f32::INFINITY)),
        ] {
            assert_eq!(ends_finite(driver, 0.0, 30.0), 1.0, "{driver:?}");
        }
        // Negative damping would grow without end: it is treated as none,
        // a spring that keeps oscillating within its first amplitude.
        let mut r = Running::new(1, spring(170.0, -5.0, 1.0, None), 0.0, 0.0).starting_at(0.0);
        for i in 0..600 {
            let (v, _, _) = r.step(i as f64 / 60.0);
            assert!(v.is_finite() && (-1.5..=3.5).contains(&v), "{v}");
        }
        // A target that is not a number leaves the value where it is.
        let to_nan = Driver::Spring {
            to: f32::NAN,
            stiffness: 170.0,
            damping: 26.0,
            mass: 1.0,
            velocity: None,
            frame_rate: None,
        };
        assert_eq!(ends_finite(to_nan, 4.0, 30.0), 4.0);
    }

    /// What `main` already ran to an end, or waits for on purpose, keeps its
    /// behavior: a negative delay starts part-way, an infinite one waits, an
    /// infinite deceleration or bounce is held by the clamps (it coasts, it
    /// bounces with all its speed), and of bounds with one NaN the other is
    /// both.
    #[test]
    fn parameters_that_already_end_keep_their_behavior() {
        let timing = Driver::Timing {
            to: 1.0,
            duration_ms: 300.0,
            easing: Easing::Linear,
            delay_ms: -100.0,
            frame_rate: None,
        };
        let mut r = Running::new(1, timing, 0.0, 0.0).starting_at(0.0);
        assert!((r.step(0.1).0 - 2.0 / 3.0).abs() < 1e-3);
        // A duration of -inf ends at once, as a negative one does.
        let ended = Driver::Timing {
            to: 1.0,
            duration_ms: f32::NEG_INFINITY,
            easing: Easing::Linear,
            delay_ms: 0.0,
            frame_rate: None,
        };
        let mut r = Running::new(1, ended, 0.0, 0.0).starting_at(0.0);
        assert_eq!(r.step(0.0), (1.0, 0.0, true));
        // An infinite delay waits, as a sequence's infinite delay does.
        let waiting = Driver::Timing {
            to: 1.0,
            duration_ms: 300.0,
            easing: Easing::Linear,
            delay_ms: f32::INFINITY,
            frame_rate: None,
        };
        let mut r = Running::new(1, waiting, 0.0, 0.0).starting_at(0.0);
        assert_eq!(r.step(60.0), (0.0, 0.0, false));
        let decay = |deceleration, clamp, bounce| Driver::Decay {
            velocity: Some(500.0),
            deceleration,
            clamp,
            bounce,
            frame_rate: None,
        };
        let mut coasting =
            Running::new(1, decay(f32::INFINITY, None, 0.0), 0.0, 0.0).starting_at(0.0);
        let (v, velocity, done) = coasting.step(1.0);
        assert!(!done && v > 400.0 && velocity > 400.0, "{v} {velocity}");
        assert!(coasting.deadline(1.0).is_finite());
        let mut bouncing =
            Running::new(1, decay(0.998, Some((0.0, 10.0)), f32::INFINITY), 0.0, 0.0)
                .starting_at(0.0);
        let (v, _, done) = bouncing.step(0.03);
        assert!(!done && (0.0..10.0).contains(&v), "{v}");
        // One NaN bound: the other is both, so it stops there at once.
        let mut one_bound =
            Running::new(1, decay(0.998, Some((f32::NAN, 10.0)), 0.5), 0.0, 0.0).starting_at(0.0);
        assert_eq!(one_bound.step(0.0), (10.0, 0.0, true));
        // None of them is out of range: nothing is replaced or reported.
        for driver in [
            timing,
            ended,
            waiting,
            decay(f32::INFINITY, None, 0.0),
            decay(0.998, Some((0.0, 10.0)), f32::INFINITY),
            decay(0.998, Some((f32::NAN, 10.0)), 0.5),
        ] {
            assert!(!out_of_range(&driver), "{driver:?}");
        }
    }

    #[test]
    fn invalid_timing_and_decay_parameters_end() {
        let timing = |to, duration_ms, delay_ms| Driver::Timing {
            to,
            duration_ms,
            easing: Easing::EaseInOut,
            delay_ms,
            frame_rate: None,
        };
        assert_eq!(ends_finite(timing(1.0, f32::NAN, 0.0), 0.0, 1.0), 1.0);
        assert_eq!(ends_finite(timing(1.0, f32::INFINITY, 0.0), 0.0, 1.0), 1.0);
        assert_eq!(ends_finite(timing(1.0, 100.0, f32::NAN), 0.0, 1.0), 1.0);
        assert_eq!(ends_finite(timing(f32::NAN, 100.0, 0.0), 2.0, 1.0), 2.0);
        assert_eq!(
            ends_finite(timing(f32::INFINITY, 100.0, 0.0), 2.0, 1.0),
            2.0
        );
        // An easing whose numbers are not finite is linear, over the same
        // duration.
        for easing in [
            Easing::Bezier(0.0, f32::NAN, 1.0, 1.0),
            Easing::Curve(Curve::Poly(f32::NAN), EaseMode::In),
            Easing::Curve(Curve::Elastic(f32::NAN), EaseMode::Out),
            Easing::Curve(Curve::Back(f32::INFINITY), EaseMode::In),
        ] {
            let driver = Driver::Timing {
                to: 1.0,
                duration_ms: 1000.0,
                easing,
                delay_ms: 0.0,
                frame_rate: None,
            };
            assert!(out_of_range(&driver), "{driver:?}");
            let mut r = Running::new(1, driver, 0.0, 0.0).starting_at(0.0);
            assert_eq!(r.step(0.5), (0.5, 0.0, false), "{easing:?}");
            assert_eq!(r.step(1.0), (1.0, 0.0, true), "{easing:?}");
        }
        let decay = |velocity, deceleration, clamp, bounce| Driver::Decay {
            velocity,
            deceleration,
            clamp,
            bounce,
            frame_rate: None,
        };
        for driver in [
            decay(Some(f32::NAN), 0.998, None, 0.0),
            decay(Some(f32::INFINITY), 0.998, None, 0.0),
            decay(Some(500.0), f32::NAN, None, 0.0),
            decay(Some(500.0), 0.998, Some((f32::NAN, f32::NAN)), 0.5),
            // Bounds at one infinity made the value that infinity.
            decay(
                Some(500.0),
                0.998,
                Some((f32::INFINITY, f32::INFINITY)),
                0.5,
            ),
            decay(Some(500.0), 0.998, Some((f32::NAN, f32::INFINITY)), 0.5),
            decay(
                Some(-500.0),
                0.998,
                Some((f32::NEG_INFINITY, f32::NEG_INFINITY)),
                0.5,
            ),
            decay(Some(500.0), 0.998, Some((0.0, 10.0)), f32::NAN),
        ] {
            ends_finite(driver, 0.0, 30.0);
        }
    }
    /// A strongly overdamped spring (ζ of 10 to 31.5 here, one of them by a
    /// tiny mass) moves to its target and settles there: `cosh` overflowed
    /// on the way and made it infinite, then NaN.
    #[test]
    fn overdamped_springs_settle_without_a_jump() {
        for (stiffness, damping, mass) in [
            (170.0, 26.0, 0.001),
            (1000.0, 1000.0, 1.0),
            (100.0, 200.0, 1.0),
        ] {
            let driver = Driver::Spring {
                to: 1.0,
                stiffness,
                damping,
                mass,
                velocity: None,
                frame_rate: None,
            };
            assert!(!out_of_range(&driver));
            let mut r = Running::new(1, driver, 0.0, 0.0).starting_at(0.0);
            let (mut now, mut last) = (0.0, 0.0);
            loop {
                let (v, velocity, done) = r.step(now);
                assert!(v.is_finite() && velocity.is_finite(), "{driver:?} at {now}");
                // Overdamped: it never passes the target, and it settles
                // from close to it, not from part-way.
                assert!(
                    (last..=1.0).contains(&v),
                    "{driver:?} at {now}: {last} -> {v}"
                );
                if done {
                    assert!(1.0 - last < 0.01, "{driver:?}: jumped from {last}");
                    break;
                }
                assert!(now < 120.0, "{driver:?} never ends");
                last = v;
                now += 1.0 / 60.0;
            }
        }
    }

    /// A curve that overflows for numbers that are finite (`poly` of a
    /// negative power near 0) still takes its duration.
    #[test]
    fn an_easing_that_overflows_keeps_its_duration() {
        let driver = Driver::Timing {
            to: 1.0,
            duration_ms: 1000.0,
            easing: Easing::Curve(Curve::Poly(-200.0), EaseMode::In),
            delay_ms: 0.0,
            frame_rate: None,
        };
        assert!(!out_of_range(&driver));
        let mut r = Running::new(1, driver, 0.0, 0.0).starting_at(0.0);
        let (v, _, done) = r.step(0.1);
        assert_eq!((v, done), (0.1, false));
        assert_eq!(r.step(1.0), (1.0, 0.0, true));
    }
}
