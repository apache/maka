//! What animates on one view, without the view: `LayoutAnimation`
//! (frames, insertions, removals), style `transition`s and keyframe
//! `animation`s (`spin`, `ping`, `pulse`, `bounce`), stepped by a desktop
//! backend's frame clock (Windows, GPUI, Linux and macOS share it).
//!
//! A backend keeps a [`Live`] beside a view that animates and runs a
//! frame callback while it has something to do; other views carry
//! nothing and cost nothing. The backend tells [`Live`] what changed
//! ([`Live::appear`], [`Live::disappear`], [`Live::move_frame`],
//! [`restyle`]) and calls [`Live::step`] on every frame with the view's
//! frame and style, which it writes the in-between values into: everything
//! that draws reads the current value without knowing about transitions,
//! and a change that arrives mid-animation starts from where the view is,
//! as UIKit's `beginFromCurrentState`.
//!
//! Appearing / disappearing views and keyframes do not touch the style:
//! they multiply the opacity ([`Live::opacity`]) and add a transform to the
//! style's ([`Live::extra`]), which the backend applies in its own matrix
//! type. Which views animate (navigation, reduced motion), the frame
//! callbacks and detaching a view that finished animating out stay in the
//! backends.

use std::sync::Arc;

use crate::{
    Bounds, BoxShadow, Color, Corners, Edges, KeyframeAnimation, Keyframes, LayoutCurve,
    LayoutProperty, LayoutTransition, Points, Transform, TransitionProps, ViewStyle,
    geometry::{Percentage, Point, Radians, Size, deg},
};

/// What animates on one view, and the values drawing reads.
#[non_exhaustive]
pub struct Live {
    /// A frame callback steps it.
    ticking: bool,
    /// A frame moving to its new place.
    frame: Option<FrameTrack>,
    /// Style values moving to the new style's.
    style: Option<StyleTrack>,
    /// Appearing or disappearing.
    presence: Option<Presence>,
    /// A keyframe animation.
    keyframes: Option<KeyframeRun>,
    /// The view was removed and stays only while it animates out.
    dying: bool,
    /// Opacity multiplier (appearing / disappearing, keyframes).
    opacity: f32,
    /// Transform added to the style's.
    extra: Extra,
}

impl Default for Live {
    fn default() -> Self {
        Live {
            ticking: false,
            frame: None,
            style: None,
            presence: None,
            keyframes: None,
            dying: false,
            opacity: 1.0,
            extra: Extra::NONE,
        }
    }
}

/// What one [`Live::step`] did.
#[non_exhaustive]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    /// The view finished animating out: the backend detaches it.
    pub removed: bool,
    /// Nothing is left to animate (or the view was removed): the frame
    /// callback stops ([`Live::ticking`] is false again).
    pub finished: bool,
    /// The frame's size changed.
    pub resized: bool,
    /// The style transition moved (or ended).
    pub restyled: bool,
}

impl Live {
    /// The opacity multiplier of appearing, disappearing and keyframes.
    pub fn opacity(&self) -> f32 {
        self.opacity
    }

    /// The transform to add to the style's, if any.
    pub fn extra(&self) -> Option<Extra> {
        (self.extra != Extra::NONE).then_some(self.extra)
    }

    /// True while the view animates out after its removal: it is drawn but
    /// takes no pointer.
    pub fn dying(&self) -> bool {
        self.dying
    }

    /// True when nothing animates.
    pub fn idle(&self) -> bool {
        self.frame.is_none()
            && self.style.is_none()
            && self.presence.is_none()
            && self.keyframes.is_none()
    }

    /// True while a frame callback steps it.
    pub fn ticking(&self) -> bool {
        self.ticking
    }

    /// Records whether a frame callback steps it (the backend sets it when
    /// it starts one; [`Live::step`] clears it when it finishes).
    pub fn set_ticking(&mut self, ticking: bool) {
        self.ticking = ticking;
    }

    /// The view is back (or moved) before its removal finished animating.
    pub fn revive(&mut self) {
        self.dying = false;
        self.presence = None;
        // The next step adds a keyframe animation's values again.
        self.opacity = 1.0;
        self.extra = Extra::NONE;
    }

    /// The view was inserted: it appears as `t` describes.
    pub fn appear(&mut self, t: LayoutTransition) {
        let presence = Presence {
            property: t.property,
            from: 0.0,
            to: 1.0,
            value: 0.0,
            timing: Timing::layout(&t),
        };
        self.opacity = 0.0;
        self.extra = presence.extra();
        self.presence = Some(presence);
    }

    /// The view was removed: it disappears as `t` describes, from where an
    /// appearance got to, and is [`Live::dying`] until done.
    pub fn disappear(&mut self, t: LayoutTransition) {
        let value = self.presence.as_ref().map_or(1.0, |p| p.value);
        self.dying = true;
        self.presence = Some(Presence {
            property: t.property,
            from: value,
            to: 0.0,
            value,
            timing: Timing::layout(&t),
        });
    }

    /// The frame a running layout animation is heading to, if any.
    pub fn frame_target(&self) -> Option<Bounds<Points>> {
        self.frame.as_ref().map(|t| t.to)
    }

    /// Stops a running layout animation (the new frame applies at once).
    pub fn stop_frame(&mut self) {
        self.frame = None;
    }

    /// The frame moves from `from` to `to` as `t` describes (the view shows
    /// `from` until the first step).
    pub fn move_frame(&mut self, from: Bounds<Points>, to: Bounds<Points>, t: LayoutTransition) {
        self.frame = Some(FrameTrack {
            from,
            to,
            timing: Timing::layout(&t),
        });
    }

    /// Stops a running style transition.
    pub fn stop_style(&mut self) {
        self.style = None;
    }

    /// Starts what [`restyle`] found.
    pub fn restyle(&mut self, restyle: Restyle) {
        self.style = restyle.track;
        if let Some(animation) = restyle.keyframes {
            self.keyframes = animation.map(|animation| KeyframeRun {
                animation,
                start: None,
            });
            if self.keyframes.is_none() {
                self.opacity = self.presence.as_ref().map_or(1.0, Presence::opacity);
                self.extra = self.presence.as_ref().map_or(Extra::NONE, Presence::extra);
            }
        }
    }

    /// True if the view is removed and has not begun to animate out: a
    /// view deleted inside a deleted subtree leaves with its ancestor
    /// ([`Live::leave_with_ancestor`]) instead of fading on its own.
    pub fn leaving(&self) -> bool {
        self.dying
            && self
                .presence
                .as_ref()
                .is_some_and(|p| p.timing.start.is_none())
    }

    /// An ancestor animates out and takes the view with it.
    pub fn leave_with_ancestor(&mut self) {
        self.presence = None;
        self.dying = false;
    }

    /// One frame at `now` (ms): writes the animated frame and style into
    /// `frame` and `style` and updates [`Live::opacity`] and
    /// [`Live::extra`].
    pub fn step(
        &mut self,
        now: f64,
        frame: &mut Bounds<Points>,
        style: &mut Box<ViewStyle>,
    ) -> Step {
        let mut step = Step::default();

        if let Some(track) = &mut self.frame
            && let Some((p, done)) = track.timing.at(now)
        {
            let next = if done {
                track.to
            } else {
                lerp_rect(track.from, track.to, p)
            };
            step.resized = next.size.width.0 != frame.size.width.0
                || next.size.height.0 != frame.size.height.0;
            *frame = next;
            if done {
                self.frame = None;
            }
        }

        if let Some(track) = &mut self.style
            && let Some((p, done)) = track.timing.at(now)
        {
            step.restyled = true;
            if done {
                *style = std::mem::take(&mut track.to);
                self.style = None;
            } else {
                lerp_style(style, &track.from, &track.to, track.props, p);
            }
        }

        let (mut opacity, mut extra) = (1.0, Extra::NONE);
        if let Some(presence) = &mut self.presence {
            let at = presence.timing.at(now);
            if let Some((p, done)) = at {
                presence.value = if done {
                    presence.to
                } else {
                    lerp(presence.from, presence.to, p)
                };
            }
            if at.is_some_and(|(_, done)| done) {
                step.removed = self.dying;
                self.presence = None;
            } else {
                opacity = presence.opacity();
                extra = presence.extra();
            }
        }

        if let Some(run) = &mut self.keyframes {
            let start = *run.start.get_or_insert(now);
            match keyframes_at(&run.animation, (now - start) as f32) {
                Some((o, e)) => {
                    opacity *= o;
                    extra = Extra {
                        rotate: extra.rotate + e.rotate,
                        scale: extra.scale * e.scale,
                        shift_y: extra.shift_y + e.shift_y,
                    };
                }
                None => self.keyframes = None,
            }
        }
        self.opacity = opacity;
        self.extra = extra;

        step.finished = step.removed || self.idle();
        if step.finished {
            self.ticking = false;
        }
        step
    }
}

/// What a style change starts, from [`restyle`] for [`Live::restyle`].
#[non_exhaustive]
pub struct Restyle {
    track: Option<StyleTrack>,
    /// The new keyframe animation, when it changed.
    keyframes: Option<Option<KeyframeAnimation>>,
}

/// A view's style changed from `old` to `style`: what it starts (a
/// transition of the values its `transition` names, a new keyframe
/// animation), or `None` when the new values apply at once (stop a running
/// transition with [`Live::stop_style`]). A transition writes the old
/// values into `style`, which shows them until the first step.
pub fn restyle(
    old: &ViewStyle,
    style: &mut Box<ViewStyle>,
    reduce_motion: bool,
) -> Option<Restyle> {
    // Keyframes restart only when the animation itself changes, as in CSS.
    let keyframes_changed = style.animation != old.animation;
    let transition = style.transition.filter(|t| {
        !reduce_motion
            && t.duration + t.delay > 0.0
            && differs(old, style, t.properties)
            // A view's first style does not transition from the defaults.
            && *old != ViewStyle::default()
    });
    if transition.is_none() && !keyframes_changed {
        return None;
    }
    let keyframes = keyframes_changed.then(|| style.animation.filter(|_| !reduce_motion));
    let track = transition.map(|t| {
        let to = style.clone();
        lerp_style(style, old, &to, t.properties, 0.0);
        StyleTrack {
            from: Box::new(old.clone()),
            to,
            props: t.properties,
            timing: Timing::new(t.delay, t.duration, Curve::Bezier(t.easing)),
        }
    });
    Some(Restyle { track, keyframes })
}

/// A rotation, scale and vertical shift around the transform origin, which
/// appearing, disappearing and keyframes add to the style's transform.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Extra {
    /// Rotation.
    pub rotate: Radians,
    /// Uniform scale.
    pub scale: f32,
    /// Vertical shift, a fraction of the view's height.
    pub shift_y: Percentage,
}

impl Extra {
    /// No transform.
    pub const NONE: Extra = Extra {
        rotate: Radians(0.0),
        scale: 1.0,
        shift_y: Percentage(0.0),
    };
}

impl Default for Extra {
    fn default() -> Self {
        Extra::NONE
    }
}

/// An easing curve, from progress in time to progress in value.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Curve {
    Linear,
    /// Cubic Bézier `x1, y1, x2, y2`.
    Bezier([f32; 4]),
    /// A spring with this damping ratio that settles within the duration.
    Spring(f32),
}

impl Curve {
    fn of(curve: LayoutCurve) -> Curve {
        match curve {
            LayoutCurve::Linear => Curve::Linear,
            // UIKit's curves.
            LayoutCurve::EaseIn => Curve::Bezier([0.42, 0.0, 1.0, 1.0]),
            LayoutCurve::EaseOut => Curve::Bezier([0.0, 0.0, 0.58, 1.0]),
            LayoutCurve::EaseInEaseOut | LayoutCurve::Keyboard => {
                Curve::Bezier([0.42, 0.0, 0.58, 1.0])
            }
            LayoutCurve::Spring { damping } => Curve::Spring(damping),
        }
    }

    fn at(self, x: f32) -> f32 {
        match self {
            Curve::Linear => x,
            Curve::Bezier(b) => cubic_bezier(b, x),
            Curve::Spring(damping) => spring(damping, x),
        }
    }
}

/// CSS `cubic-bezier(x1, y1, x2, y2)` at `x` in `0..=1`.
fn cubic_bezier([x1, y1, x2, y2]: [f32; 4], x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    // Polynomial coefficients of B(t) = ((a t + b) t + c) t.
    let (cx, cy) = (3.0 * x1, 3.0 * y1);
    let (bx, by) = (3.0 * (x2 - x1) - cx, 3.0 * (y2 - y1) - cy);
    let (ax, ay) = (1.0 - cx - bx, 1.0 - cy - by);
    let sample_x = |t: f32| ((ax * t + bx) * t + cx) * t;
    let slope_x = |t: f32| (3.0 * ax * t + 2.0 * bx) * t + cx;
    // Newton's method converges in a few steps on most curves; bisection
    // catches the flat ones.
    let mut t = x;
    let mut solved = false;
    for _ in 0..8 {
        let err = sample_x(t) - x;
        if err.abs() < 1e-6 {
            solved = true;
            break;
        }
        let d = slope_x(t);
        if d.abs() < 1e-6 {
            break;
        }
        t -= err / d;
    }
    if !solved || !(0.0..=1.0).contains(&t) {
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        t = x;
        for _ in 0..32 {
            let v = sample_x(t);
            if (v - x).abs() < 1e-6 {
                break;
            }
            if v < x {
                lo = t;
            } else {
                hi = t;
            }
            t = (lo + hi) / 2.0;
        }
    }
    ((ay * t + by) * t + cy) * t
}

/// A damped spring from 0 to 1 at `x` (the fraction of the duration), its
/// stiffness chosen so that it settles by the end, as UIKit's
/// `usingSpringWithDamping` fits a spring into the given duration.
fn spring(damping: f32, x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    // The envelope falls to 1/1000 by the end.
    const SETTLE: f32 = 6.907_755; // ln(1000)
    let zeta = damping.clamp(0.05, 1.0);
    if zeta > 0.999 {
        // Critically damped: (1 + w x) e^(-w x) reaches 1/1000 at w = 9.23.
        let w = 9.233;
        return 1.0 - (1.0 + w * x) * (-w * x).exp();
    }
    let w = SETTLE / zeta;
    let wd = w * (1.0 - zeta * zeta).sqrt();
    let envelope = (-zeta * w * x).exp();
    1.0 - envelope * ((wd * x).cos() + zeta * w / wd * (wd * x).sin())
}

/// When a change runs and how it eases.
#[derive(Debug, Clone, Copy)]
struct Timing {
    /// Frame time (ms) of the first step.
    start: Option<f64>,
    delay: f32,
    duration: f32,
    curve: Curve,
}

impl Timing {
    fn new(delay: f32, duration: f32, curve: Curve) -> Self {
        Timing {
            start: None,
            delay: delay.max(0.0),
            duration: duration.max(0.0),
            curve,
        }
    }

    fn layout(t: &LayoutTransition) -> Self {
        Timing::new(t.delay_ms, t.duration_ms, Curve::of(t.curve))
    }

    /// Eased progress at `now` (ms): `None` while delayed, then the value
    /// and whether it finished.
    fn at(&mut self, now: f64) -> Option<(f32, bool)> {
        let start = *self.start.get_or_insert(now);
        progress(self.curve, self.delay, self.duration, (now - start) as f32)
    }
}

/// Eased progress `elapsed` ms after a change began.
fn progress(curve: Curve, delay: f32, duration: f32, elapsed: f32) -> Option<(f32, bool)> {
    let t = elapsed - delay;
    if t < 0.0 {
        return None;
    }
    if duration <= 0.0 || t >= duration {
        return Some((1.0, true));
    }
    Some((curve.at(t / duration), false))
}

struct FrameTrack {
    from: Bounds<Points>,
    to: Bounds<Points>,
    timing: Timing,
}

struct StyleTrack {
    from: Box<ViewStyle>,
    to: Box<ViewStyle>,
    props: TransitionProps,
    timing: Timing,
}

struct Presence {
    property: LayoutProperty,
    /// Visibility at the start and end (0 hidden, 1 shown).
    from: f32,
    to: f32,
    /// The current visibility.
    value: f32,
    timing: Timing,
}

impl Presence {
    fn opacity(&self) -> f32 {
        match self.property {
            LayoutProperty::Opacity => self.value.clamp(0.0, 1.0),
            LayoutProperty::Scale => 1.0,
        }
    }

    fn extra(&self) -> Extra {
        match self.property {
            LayoutProperty::Opacity => Extra::NONE,
            LayoutProperty::Scale => Extra {
                // Not quite zero: a singular matrix cannot be inverted for
                // picking.
                scale: self.value.max(0.01),
                ..Extra::NONE
            },
        }
    }
}

struct KeyframeRun {
    animation: KeyframeAnimation,
    start: Option<f64>,
}

/// The opacity multiplier and extra transform of `animation`, `elapsed` ms
/// after it was set; `None` once a finite animation ended. During the delay
/// the view shows its own values, as CSS without `animation-fill-mode`.
fn keyframes_at(animation: &KeyframeAnimation, elapsed: f32) -> Option<(f32, Extra)> {
    let t = elapsed - animation.delay;
    if t < 0.0 {
        return Some((1.0, Extra::NONE));
    }
    let d = animation.duration;
    if d <= 0.0 || animation.iterations.is_some_and(|n| t >= n as f32 * d) {
        return None;
    }
    let frac = (t % d) / d;
    let ease = |x: f32| cubic_bezier(animation.easing, x);
    let mut extra = Extra::NONE;
    let mut opacity = 1.0;
    match animation.keyframes {
        Keyframes::Spin => extra.rotate = deg(360.0 * ease(frac)),
        Keyframes::Ping => {
            // 75%, 100% { transform: scale(2); opacity: 0 }
            let q = if frac < 0.75 { ease(frac / 0.75) } else { 1.0 };
            extra.scale = 1.0 + q;
            opacity = 1.0 - q;
        }
        Keyframes::Pulse => {
            // 50% { opacity: .5 }
            let q = if frac < 0.5 {
                ease(frac * 2.0)
            } else {
                1.0 - ease(frac * 2.0 - 1.0)
            };
            opacity = 1.0 - 0.5 * q;
        }
        Keyframes::Bounce => {
            // 0%, 100% { translateY(-25%) } eased in, 50% { none } eased
            // out; the animation's own easing does not apply.
            extra.shift_y = Percentage(if frac < 0.5 {
                -0.25 * (1.0 - cubic_bezier([0.8, 0.0, 1.0, 1.0], frac * 2.0))
            } else {
                -0.25 * cubic_bezier([0.0, 0.0, 0.2, 1.0], frac * 2.0 - 1.0)
            });
        }
    }
    Some((opacity, extra))
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn lerp_points(a: Points, b: Points, t: f32) -> Points {
    Points(lerp(a.0, b.0, t))
}

/// Interpolates colors in premultiplied RGBA, as CSS does, so that
/// transparent ends do not pass through black.
fn lerp_color(a: Color, b: Color, t: f32) -> Color {
    if a == b {
        return a;
    }
    let t = t.clamp(0.0, 1.0);
    let parts = |c: Color| {
        let (r, g, b, a) = c.to_f64();
        let a = a as f32;
        [r as f32 * a, g as f32 * a, b as f32 * a, a]
    };
    let (pa, pb) = (parts(a), parts(b));
    let p: [f32; 4] = std::array::from_fn(|i| lerp(pa[i], pb[i], t));
    let alpha = p[3];
    if alpha <= 0.0 {
        return Color::TRANSPARENT;
    }
    let channel = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    Color::rgba(
        channel(p[0] / alpha),
        channel(p[1] / alpha),
        channel(p[2] / alpha),
        channel(alpha),
    )
}

/// Interpolates transform lists entry by entry when their kinds match (an
/// empty list stands for the identity of the other); `None` when they
/// cannot be interpolated and the new list applies at once.
fn lerp_transform(a: &Transform, b: &Transform, t: f32) -> Option<Transform> {
    let (ao, bo) = (a.ops(), b.ops());
    let same_kinds = ao.iter().map(|o| o.kind).eq(bo.iter().map(|o| o.kind));
    if !(ao.is_empty() || bo.is_empty() || same_kinds) {
        return None;
    }
    let kinds = if ao.is_empty() { bo } else { ao };
    let mut out = Transform::IDENTITY;
    for (i, op) in kinds.iter().enumerate() {
        let va = ao.get(i).map_or(op.kind.identity(), |o| o.value);
        let vb = bo.get(i).map_or(op.kind.identity(), |o| o.value);
        out.push(op.kind, lerp(va, vb, t));
    }
    Some(out)
}

/// A shadow that draws nothing, to interpolate against `s`.
fn none_like(s: &BoxShadow) -> BoxShadow {
    BoxShadow {
        offset_x: Points::ZERO,
        offset_y: Points::ZERO,
        blur: Points::ZERO,
        spread: Points::ZERO,
        color: Color::TRANSPARENT,
        inset: s.inset,
    }
}

/// Interpolates box shadow lists, the shorter padded with empty shadows
/// (CSS); `None` when an inset and an outer shadow meet.
fn lerp_box_shadows(a: &[BoxShadow], b: &[BoxShadow], t: f32) -> Option<Vec<BoxShadow>> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (sa, sb) = match (a.get(i), b.get(i)) {
            (Some(x), Some(y)) => (*x, *y),
            (Some(x), None) => (*x, none_like(x)),
            (None, Some(y)) => (none_like(y), *y),
            (None, None) => unreachable!("i < the longer length"),
        };
        if sa.inset != sb.inset {
            return None;
        }
        let l = |a: Points, b: Points| Points(lerp(a.0, b.0, t));
        out.push(BoxShadow {
            offset_x: l(sa.offset_x, sb.offset_x),
            offset_y: l(sa.offset_y, sb.offset_y),
            blur: l(sa.blur, sb.blur).max(Points::ZERO),
            spread: l(sa.spread, sb.spread),
            color: lerp_color(sa.color, sb.color, t),
            inset: sa.inset,
        });
    }
    Some(out)
}

fn box_shadows(s: &ViewStyle) -> &[BoxShadow] {
    s.effects.as_deref().map_or(&[], |e| &e.box_shadows)
}

/// True if `a` and `b` differ in what `props` animates.
fn differs(a: &ViewStyle, b: &ViewStyle, props: TransitionProps) -> bool {
    (props.has(TransitionProps::COLORS)
        && (a.background_color != b.background_color
            || a.borders.colors != b.borders.colors
            || a.outline.color != b.outline.color
            || a.tint_color != b.tint_color))
        || (props.has(TransitionProps::OPACITY) && a.opacity != b.opacity)
        || (props.has(TransitionProps::TRANSFORM) && a.transform != b.transform)
        || (props.has(TransitionProps::SHADOW)
            && (a.shadow != b.shadow || box_shadows(a) != box_shadows(b)))
        || (props.has(TransitionProps::SHAPE)
            && (a.border_radius != b.border_radius
                || a.corner_radius != b.corner_radius
                || a.borders.widths != b.borders.widths
                || a.outline.width != b.outline.width))
}

/// Writes the values between `from` and `to` that `props` animates into
/// `out` (a copy of `to`).
fn lerp_style(
    out: &mut ViewStyle,
    from: &ViewStyle,
    to: &ViewStyle,
    props: TransitionProps,
    t: f32,
) {
    if props.has(TransitionProps::COLORS) {
        out.background_color = lerp_color(from.background_color, to.background_color, t);
        out.borders.colors =
            std::array::from_fn(|i| lerp_color(from.borders.colors[i], to.borders.colors[i], t));
        out.outline.color = lerp_color(from.outline.color, to.outline.color, t);
        if let (Some(a), Some(b)) = (from.tint_color, to.tint_color) {
            out.tint_color = Some(lerp_color(a, b, t));
        }
    }
    if props.has(TransitionProps::OPACITY) {
        out.opacity = lerp(from.opacity, to.opacity, t).clamp(0.0, 1.0);
    }
    if props.has(TransitionProps::TRANSFORM)
        && let Some(transform) = lerp_transform(&from.transform, &to.transform, t)
    {
        out.transform = transform;
    }
    if props.has(TransitionProps::SHADOW) {
        let (a, b) = (&from.shadow, &to.shadow);
        out.shadow.color = lerp_color(a.color, b.color, t);
        out.shadow.offset_x = lerp_points(a.offset_x, b.offset_x, t);
        out.shadow.offset_y = lerp_points(a.offset_y, b.offset_y, t);
        out.shadow.opacity = lerp(a.opacity, b.opacity, t).clamp(0.0, 1.0);
        out.shadow.radius = lerp_points(a.radius, b.radius, t).max(Points::ZERO);
        let (sa, sb) = (box_shadows(from), box_shadows(to));
        if sa != sb
            && let Some(shadows) = lerp_box_shadows(sa, sb, t)
        {
            let mut effects = to.effects.as_deref().cloned().unwrap_or_default();
            effects.box_shadows = shadows;
            out.effects = Some(Arc::new(effects));
        }
    }
    if props.has(TransitionProps::SHAPE) {
        out.border_radius = lerp_points(from.border_radius, to.border_radius, t).max(Points::ZERO);
        let (ca, cb) = (from.corner_radius.to_array(), to.corner_radius.to_array());
        out.corner_radius = Corners::from(std::array::from_fn(|i| match (ca[i], cb[i]) {
            (None, None) => None,
            (a, b) => Some(
                lerp_points(
                    a.unwrap_or(from.border_radius),
                    b.unwrap_or(to.border_radius),
                    t,
                )
                .max(Points::ZERO),
            ),
        }));
        let (wa, wb) = (from.borders.widths.to_array(), to.borders.widths.to_array());
        out.borders.widths = Edges::from(std::array::from_fn(|i| {
            lerp_points(wa[i], wb[i], t).max(Points::ZERO)
        }));
        out.outline.width = Points(lerp(from.outline.width.0, to.outline.width.0, t).max(0.0));
    }
}

fn lerp_rect(a: Bounds<Points>, b: Bounds<Points>, t: f32) -> Bounds<Points> {
    Bounds {
        origin: Point {
            x: Points(lerp(a.origin.x.0, b.origin.x.0, t)),
            y: Points(lerp(a.origin.y.0, b.origin.y.0, t)),
        },
        size: Size {
            width: Points(lerp(a.size.width.0, b.size.width.0, t).max(0.0)),
            height: Points(lerp(a.size.height.0, b.size.height.0, t).max(0.0)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LayoutAnimation, TransformKind};

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn bezier_matches_css() {
        let ease = [0.25, 0.1, 0.25, 1.0];
        assert_eq!(cubic_bezier(ease, 0.0), 0.0);
        assert_eq!(cubic_bezier(ease, 1.0), 1.0);
        // Reference values of CSS `ease`.
        assert!(
            close(cubic_bezier(ease, 0.5), 0.8024),
            "{}",
            cubic_bezier(ease, 0.5)
        );
        assert!(
            close(cubic_bezier(ease, 0.25), 0.4094),
            "{}",
            cubic_bezier(ease, 0.25)
        );
        assert!(close(cubic_bezier([0.0, 0.0, 1.0, 1.0], 0.37), 0.37));
        let in_out = [0.42, 0.0, 0.58, 1.0];
        let mut last = 0.0;
        for i in 1..=100 {
            let v = cubic_bezier(in_out, i as f32 / 100.0);
            assert!(v >= last, "monotonic");
            last = v;
        }
        assert!(close(cubic_bezier(in_out, 0.5), 0.5));
        // A flat start (x1 = 1) still solves.
        assert!(cubic_bezier([0.8, 0.0, 1.0, 1.0], 0.5) < 0.3);
    }

    #[test]
    fn spring_settles_and_overshoots() {
        assert_eq!(spring(0.4, 0.0), 0.0);
        assert_eq!(spring(0.4, 1.0), 1.0);
        let max = (1..100)
            .map(|i| spring(0.4, i as f32 / 100.0))
            .fold(0.0, f32::max);
        assert!(max > 1.1, "a loose spring overshoots: {max}");
        assert!((spring(0.4, 0.99) - 1.0).abs() < 0.01);
        // A critically damped spring does not overshoot.
        assert!((1..100).all(|i| spring(1.0, i as f32 / 100.0) <= 1.0));
        assert!((spring(1.0, 0.98) - 1.0).abs() < 0.01);
    }

    #[test]
    fn progress_waits_for_delay() {
        assert_eq!(progress(Curve::Linear, 100.0, 200.0, 50.0), None);
        assert_eq!(
            progress(Curve::Linear, 100.0, 200.0, 200.0),
            Some((0.5, false))
        );
        assert_eq!(
            progress(Curve::Linear, 100.0, 200.0, 300.0),
            Some((1.0, true))
        );
        assert_eq!(progress(Curve::Linear, 0.0, 0.0, 0.0), Some((1.0, true)));
    }

    #[test]
    fn presets_time_as_configured() {
        let mut t = Timing::layout(&LayoutAnimation::EASE_IN_EASE_OUT.update.unwrap());
        assert_eq!(t.at(1000.0), Some((0.0, false)));
        assert!(close(t.at(1150.0).unwrap().0, 0.5));
        assert_eq!(t.at(1300.0), Some((1.0, true)));
        let mut t = Timing::layout(&LayoutAnimation::LINEAR.create.unwrap());
        t.at(0.0);
        assert!(close(t.at(125.0).unwrap().0, 0.25));
        assert_eq!(t.at(500.0), Some((1.0, true)));
        let spring = LayoutAnimation::SPRING;
        let mut t = Timing::layout(&spring.update.unwrap());
        t.at(0.0);
        // The frame overshoots at some point before settling at 700 ms.
        let over = (1..70).any(|i| t.at(i as f64 * 10.0).unwrap().0 > 1.0);
        assert!(over);
        assert_eq!(t.at(700.0), Some((1.0, true)));
        assert_eq!(spring.create.unwrap().property, LayoutProperty::Opacity);
        assert_eq!(Curve::of(spring.delete.unwrap().curve), Curve::Linear);
    }

    #[test]
    fn rects_interpolate_and_never_go_negative() {
        let a = Bounds {
            origin: Point {
                x: Points(0.0),
                y: Points(10.0),
            },
            size: Size {
                width: Points(100.0),
                height: Points(40.0),
            },
        };
        let b = Bounds {
            origin: Point {
                x: Points(50.0),
                y: Points(20.0),
            },
            size: Size {
                width: Points(0.0),
                height: Points(80.0),
            },
        };
        let r = lerp_rect(a, b, 0.5);
        assert_eq!(
            (r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0),
            (25.0, 15.0, 50.0, 60.0)
        );
        // A spring past its end does not make a negative size.
        assert_eq!(lerp_rect(a, b, 1.2).size.width.0, 0.0);
    }

    #[test]
    fn presence_values() {
        let p = Presence {
            property: LayoutProperty::Scale,
            from: 0.0,
            to: 1.0,
            value: 0.0,
            timing: Timing::new(0.0, 100.0, Curve::Linear),
        };
        assert_eq!(p.opacity(), 1.0);
        assert_eq!(p.extra().scale, 0.01);
        let p = Presence {
            property: LayoutProperty::Opacity,
            value: 0.4,
            ..p
        };
        assert_eq!(p.opacity(), 0.4);
        assert_eq!(p.extra(), Extra::NONE);
    }

    #[test]
    fn colors_interpolate_premultiplied() {
        let red = Color::rgba(255, 0, 0, 255);
        let blue = Color::rgba(0, 0, 255, 255);
        assert_eq!(lerp_color(red, blue, 0.5), Color::rgba(128, 0, 128, 255));
        // From transparent the color stays red while it fades in.
        assert_eq!(
            lerp_color(Color::TRANSPARENT, red, 0.5),
            Color::rgba(255, 0, 0, 128)
        );
        assert_eq!(lerp_color(red, blue, 1.0), blue);
    }

    #[test]
    fn transforms_interpolate_by_position() {
        let mut a = Transform::IDENTITY;
        a.push(TransformKind::TranslateX, 10.0);
        a.push(TransformKind::Scale, 1.0);
        let mut b = Transform::IDENTITY;
        b.push(TransformKind::TranslateX, 30.0);
        b.push(TransformKind::Scale, 2.0);
        let m = lerp_transform(&a, &b, 0.5).unwrap();
        assert_eq!(m.ops()[0].value, 20.0);
        assert_eq!(m.ops()[1].value, 1.5);
        // From none: each entry's identity.
        let m = lerp_transform(&Transform::IDENTITY, &b, 0.5).unwrap();
        assert_eq!(m.ops()[0].value, 15.0);
        assert_eq!(m.ops()[1].value, 1.5);
        let mut c = Transform::IDENTITY;
        c.push(TransformKind::Rotate, 90.0);
        assert!(lerp_transform(&a, &c, 0.5).is_none());
    }

    #[test]
    fn style_lerp_touches_only_its_groups() {
        let from = ViewStyle {
            opacity: 0.0,
            background_color: Color::rgba(0, 0, 0, 255),
            ..ViewStyle::default()
        };
        let to = ViewStyle {
            opacity: 1.0,
            background_color: Color::rgba(255, 255, 255, 255),
            border_radius: Points(10.0),
            ..ViewStyle::default()
        };
        let mut out = to.clone();
        lerp_style(
            &mut out,
            &from,
            &to,
            TransitionProps(TransitionProps::OPACITY),
            0.5,
        );
        assert_eq!(out.opacity, 0.5);
        assert_eq!(out.background_color, to.background_color);
        assert_eq!(out.border_radius, Points(10.0));
        assert!(differs(
            &from,
            &to,
            TransitionProps(TransitionProps::COLORS)
        ));
        assert!(!differs(&from, &to, TransitionProps(0)));
    }

    #[test]
    fn box_shadows_pad_with_none() {
        let s = BoxShadow {
            offset_x: Points(0.0),
            offset_y: Points(10.0),
            blur: Points(20.0),
            spread: Points(0.0),
            color: Color::rgba(0, 0, 0, 100),
            inset: false,
        };
        let out = lerp_box_shadows(&[], &[s], 0.5).unwrap();
        assert_eq!(out[0].offset_y, Points(5.0));
        assert_eq!(out[0].blur, Points(10.0));
        assert_eq!(out[0].color, Color::rgba(0, 0, 0, 50));
        let inset = BoxShadow { inset: true, ..s };
        assert!(lerp_box_shadows(&[inset], &[s], 0.5).is_none());
    }

    #[test]
    fn keyframes() {
        let anim = |keyframes, iterations| KeyframeAnimation {
            keyframes,
            duration: 1000.0,
            delay: 0.0,
            easing: [0.0, 0.0, 1.0, 1.0],
            iterations,
        };
        let spin = anim(Keyframes::Spin, None);
        assert!(close(
            keyframes_at(&spin, 250.0).unwrap().1.rotate.to_degrees(),
            90.0
        ));
        assert!(close(
            keyframes_at(&spin, 1250.0).unwrap().1.rotate.to_degrees(),
            90.0
        ));
        let ping = anim(Keyframes::Ping, Some(1));
        let (o, e) = keyframes_at(&ping, 375.0).unwrap();
        assert!(close(o, 0.5) && close(e.scale, 1.5));
        assert!(close(keyframes_at(&ping, 900.0).unwrap().0, 0.0));
        assert!(keyframes_at(&ping, 1000.0).is_none());
        let pulse = anim(Keyframes::Pulse, None);
        assert!(close(keyframes_at(&pulse, 500.0).unwrap().0, 0.5));
        assert!(close(keyframes_at(&pulse, 0.0).unwrap().0, 1.0));
        let bounce = anim(Keyframes::Bounce, None);
        assert!(close(
            keyframes_at(&bounce, 0.0).unwrap().1.shift_y.0,
            -0.25
        ));
        assert!(close(
            keyframes_at(&bounce, 500.0).unwrap().1.shift_y.0,
            0.0
        ));
        // Delayed: the view's own values.
        let delayed = KeyframeAnimation {
            delay: 300.0,
            ..spin
        };
        assert_eq!(keyframes_at(&delayed, 100.0), Some((1.0, Extra::NONE)));
    }

    #[test]
    fn a_view_appears_and_disappears() {
        let t = LayoutAnimation::LINEAR.create.unwrap();
        let mut live = Live::default();
        live.appear(t);
        assert_eq!(live.opacity(), 0.0);
        let (mut frame, mut style) = (Bounds::default(), Box::default());
        live.step(0.0, &mut frame, &mut style);
        let step = live.step(250.0, &mut frame, &mut style);
        assert!(!step.finished && close(live.opacity(), 0.5));
        live.disappear(t);
        assert!(live.dying() && live.leaving());
        live.step(1000.0, &mut frame, &mut style);
        assert!(close(live.opacity(), 0.5));
        let step = live.step(2000.0, &mut frame, &mut style);
        assert!(step.removed && step.finished && !live.ticking());
    }
}
