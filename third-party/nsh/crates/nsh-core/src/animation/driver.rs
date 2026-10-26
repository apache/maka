//! Animation drivers. All are closed-form functions of elapsed time, so the
//! result does not depend on frame rate or dropped frames.

use crate::animation::ops::{AnimationId, Curve, Driver, EaseMode, Easing, StepPosition};

/// Spring rest thresholds (value units and units per second).
const REST_DISPLACEMENT: f32 = 0.001;
const REST_VELOCITY: f32 = 0.001;
/// Decay stops when it moves less than this per millisecond.
const DECAY_REST_SPEED: f32 = 0.0005;

/// One animation running on a value.
#[derive(Debug, Clone)]
pub(crate) struct Running {
    pub(crate) id: AnimationId,
    driver: Driver,
    from: f32,
    velocity: f32,
    /// First frame time (seconds); set on the first step.
    start: Option<f64>,
}

impl Running {
    /// Started at `start` (seconds) rather than on the first step: steps of
    /// a composite animation follow each other without a frame's gap.
    pub(crate) fn starting_at(mut self, start: f64) -> Self {
        self.start = Some(start);
        self
    }

    pub(crate) fn new(id: AnimationId, driver: Driver, from: f32, velocity: f32) -> Self {
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
        }
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

    /// Advances to `now` (seconds). Returns `(value, velocity, finished)`.
    pub(crate) fn step(&mut self, now: f64) -> (f32, f32, bool) {
        let start = *self.start.get_or_insert(now);
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
                let p = ease(easing, t_ms / duration_ms);
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
        let wd = w0 * (zeta * zeta - 1.0).sqrt();
        let a = x0;
        let b = (v0 + zeta * w0 * x0) / wd;
        let e = (-zeta * w0 * t).exp();
        let (ch, sh) = ((wd * t).cosh(), (wd * t).sinh());
        let x = e * (a * ch + b * sh);
        let v = e * ((b * wd - zeta * w0 * a) * ch + (a * wd - zeta * w0 * b) * sh);
        (x, v)
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
}
