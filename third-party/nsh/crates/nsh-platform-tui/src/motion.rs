//! Presentation values for layout animations, transitions and keyframes.
//!
//! Nodes keep their layout and style targets. Only a node that is moving
//! carries a motion record; drawing and hit testing sample that same record.
//! All public-to-crate timestamps are seconds, like the native value graph.

use std::{borrow::Cow, sync::Arc};

use nsh_core::{
    Bounds, BoxShadow, Color, KeyframeAnimation, Keyframes, LayoutCurve, LayoutProperty,
    LayoutTransition, Point, Points, Size, Transform, TransitionProps, ViewStyle,
    geometry::{Radians, deg},
};

/// Values applied after a view's own transform, around its transform origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Extra {
    pub(crate) rotate: Radians,
    pub(crate) scale: f32,
    pub(crate) shift_y_fraction: f32,
}

impl Extra {
    pub(crate) const NONE: Self = Self {
        rotate: Radians::ZERO,
        scale: 1.0,
        shift_y_fraction: 0.0,
    };

    fn combine(self, other: Self) -> Self {
        Self {
            rotate: self.rotate + other.rotate,
            scale: self.scale * other.scale,
            shift_y_fraction: self.shift_y_fraction + other.shift_y_fraction,
        }
    }
}

/// The values visible at one instant. An idle style is borrowed without copying.
pub(crate) struct Presentation<'a> {
    pub(crate) frame: Bounds<Points>,
    pub(crate) style: Cow<'a, ViewStyle>,
}

/// Optional tracks on one node. Targets remain on the node itself.
#[derive(Default)]
pub(crate) struct NodeMotion {
    frame: Option<FrameTrack>,
    style: Option<StyleTrack>,
    presence: Option<Presence>,
    keyframes: Option<KeyframeRun>,
    dying: bool,
}

impl NodeMotion {
    /// Starts at the displayed frame, including an interrupted animation.
    /// An absent transition stops any previous frame track immediately.
    pub(crate) fn frame_changed(
        &mut self,
        from: Bounds<Points>,
        transition: Option<&LayoutTransition>,
        now: f64,
    ) {
        self.frame = transition
            .filter(|_| from != Bounds::default())
            .map(|transition| FrameTrack {
                from,
                timing: Timing::layout(transition, now),
            });
    }

    /// Starts changes from the displayed style, without restarting unchanged
    /// keyframes. The first style mounted on a view does not transition.
    pub(crate) fn style_changed(&mut self, from: &ViewStyle, target: &ViewStyle, now: f64) {
        self.style = target
            .transition
            .filter(|transition| {
                transition.duration + transition.delay > 0.0
                    && *from != ViewStyle::default()
                    && differs(from, target, transition.properties)
            })
            .map(|transition| StyleTrack {
                from: Box::new(from.clone()),
                properties: transition.properties,
                timing: Timing::new(
                    transition.delay,
                    transition.duration,
                    Curve::Bezier(transition.easing),
                    now,
                ),
            });
        if from.animation != target.animation {
            self.keyframes = target
                .animation
                .filter(|animation| animation.duration > 0.0 && animation.iterations != Some(0))
                .map(|animation| KeyframeRun {
                    animation,
                    started: now,
                });
        }
    }

    /// Starts an appearance, or cancels a pending removal when reinserted.
    /// The caller passes a create transition only for a newly laid out node.
    pub(crate) fn inserted(&mut self, transition: Option<&LayoutTransition>, now: f64) {
        let was_dying = self.dying;
        self.dying = false;
        if was_dying {
            self.presence = None;
        }
        if let Some(transition) = transition {
            self.presence = Some(Presence {
                from: 0.0,
                to: 1.0,
                property: transition.property,
                timing: Timing::layout(transition, now),
            });
        }
    }

    /// Whether to retain this node while its exit finishes. Repeated delete
    /// requests preserve the original end time.
    pub(crate) fn removing(&mut self, transition: Option<&LayoutTransition>, now: f64) -> bool {
        if self.dying {
            return true;
        }
        let Some(transition) = transition else {
            return false;
        };
        let from = self.presence.as_ref().map_or(1.0, |p| p.value(now));
        self.dying = true;
        self.presence = Some(Presence {
            from,
            to: 0.0,
            property: transition.property,
            timing: Timing::layout(transition, now),
        });
        true
    }

    /// A retained exit still paints, but cannot receive pointer or focus input.
    pub(crate) fn dying(&self) -> bool {
        self.dying
    }

    /// Whether a frame clock is still needed. Finite tracks disappear on advance.
    pub(crate) fn active(&self) -> bool {
        self.frame.is_some()
            || self.style.is_some()
            || self.presence.is_some()
            || self.keyframes.is_some()
    }

    /// Releases finished tracks, returning true when a retained node can be
    /// removed. Call before rendering; a completed track uses the node's target.
    pub(crate) fn advance(&mut self, now: f64) -> bool {
        if self.frame.as_ref().is_some_and(|t| t.timing.finished(now)) {
            self.frame = None;
        }
        if self.style.as_ref().is_some_and(|t| t.timing.finished(now)) {
            self.style = None;
        }
        if self
            .presence
            .as_ref()
            .is_some_and(|p| p.timing.finished(now))
        {
            self.presence = None;
        }
        if self
            .keyframes
            .as_ref()
            .is_some_and(|run| run.at(now).is_none())
        {
            self.keyframes = None;
        }
        self.dying && self.presence.is_none()
    }

    /// Samples geometry without copying an interpolating style.
    pub(crate) fn frame(&self, target: Bounds<Points>, now: f64) -> Bounds<Points> {
        self.frame.as_ref().map_or(target, |track| {
            lerp_bounds(track.from, target, track.timing.progress(now))
        })
    }

    /// Samples effects without copying an interpolating style.
    pub(crate) fn appearance(&self, now: f64) -> (f32, Extra) {
        let (mut opacity, mut extra) =
            self.presence
                .as_ref()
                .map_or((1.0, Extra::NONE), |p| match p.property {
                    LayoutProperty::Opacity => (p.value(now).clamp(0.0, 1.0), Extra::NONE),
                    LayoutProperty::Scale => (
                        1.0,
                        Extra {
                            scale: p.value(now).max(0.01),
                            ..Extra::NONE
                        },
                    ),
                });
        if let Some((key_opacity, key_extra)) = self.keyframes.as_ref().and_then(|run| run.at(now))
        {
            opacity *= key_opacity;
            extra = extra.combine(key_extra);
        }
        (opacity, extra)
    }

    /// Samples without changing either layout targets or animation state.
    pub(crate) fn sample<'a>(
        &self,
        target_frame: Bounds<Points>,
        target_style: &'a ViewStyle,
        now: f64,
    ) -> Presentation<'a> {
        let frame = self.frame(target_frame, now);
        let style = match &self.style {
            Some(track) if !track.timing.finished(now) => {
                let mut style = target_style.clone();
                lerp_style(
                    &mut style,
                    &track.from,
                    target_style,
                    track.properties,
                    track.timing.progress(now),
                );
                Cow::Owned(style)
            }
            _ => Cow::Borrowed(target_style),
        };
        Presentation { frame, style }
    }
}

struct FrameTrack {
    from: Bounds<Points>,
    timing: Timing,
}

struct StyleTrack {
    from: Box<ViewStyle>,
    properties: TransitionProps,
    timing: Timing,
}

struct Presence {
    from: f32,
    to: f32,
    property: LayoutProperty,
    timing: Timing,
}

impl Presence {
    fn value(&self, now: f64) -> f32 {
        lerp(self.from, self.to, self.timing.progress(now))
    }
}

struct KeyframeRun {
    animation: KeyframeAnimation,
    started: f64,
}

impl KeyframeRun {
    fn at(&self, now: f64) -> Option<(f32, Extra)> {
        let animation = &self.animation;
        let elapsed = elapsed_ms(self.started, now) - animation.delay;
        if elapsed < 0.0 {
            return Some((1.0, Extra::NONE));
        }
        let duration = animation.duration;
        if duration <= 0.0
            || animation
                .iterations
                .is_some_and(|n| elapsed >= n as f32 * duration)
        {
            return None;
        }
        let fraction = (elapsed % duration) / duration;
        let ease = |p| bezier(animation.easing, p);
        let mut extra = Extra::NONE;
        let mut opacity = 1.0;
        match animation.keyframes {
            Keyframes::Spin => extra.rotate = deg(360.0 * ease(fraction)),
            Keyframes::Ping => {
                let progress = if fraction < 0.75 {
                    ease(fraction / 0.75)
                } else {
                    1.0
                };
                extra.scale = 1.0 + progress;
                opacity = 1.0 - progress;
            }
            Keyframes::Pulse => {
                let progress = if fraction < 0.5 {
                    ease(fraction * 2.0)
                } else {
                    1.0 - ease(fraction * 2.0 - 1.0)
                };
                opacity = 1.0 - 0.5 * progress;
            }
            Keyframes::Bounce => {
                extra.shift_y_fraction = if fraction < 0.5 {
                    -0.25 * (1.0 - bezier([0.8, 0.0, 1.0, 1.0], fraction * 2.0))
                } else {
                    -0.25 * bezier([0.0, 0.0, 0.2, 1.0], fraction * 2.0 - 1.0)
                };
            }
        }
        Some((opacity, extra))
    }
}

#[derive(Clone, Copy)]
enum Curve {
    Linear,
    Bezier([f32; 4]),
    Spring(f32),
}

impl Curve {
    fn at(self, progress: f32) -> f32 {
        match self {
            Self::Linear => progress,
            Self::Bezier(points) => bezier(points, progress),
            Self::Spring(damping) => spring(damping, progress),
        }
    }
}

struct Timing {
    started: f64,
    delay: f32,
    duration: f32,
    curve: Curve,
}

impl Timing {
    fn new(delay: f32, duration: f32, curve: Curve, started: f64) -> Self {
        Self {
            started,
            delay: delay.max(0.0),
            duration: duration.max(0.0),
            curve,
        }
    }

    fn layout(transition: &LayoutTransition, started: f64) -> Self {
        let curve = match transition.curve {
            LayoutCurve::Linear => Curve::Linear,
            LayoutCurve::EaseIn => Curve::Bezier([0.42, 0.0, 1.0, 1.0]),
            LayoutCurve::EaseOut => Curve::Bezier([0.0, 0.0, 0.58, 1.0]),
            LayoutCurve::EaseInEaseOut | LayoutCurve::Keyboard => {
                Curve::Bezier([0.42, 0.0, 0.58, 1.0])
            }
            LayoutCurve::Spring { damping } => Curve::Spring(damping),
        };
        Self::new(transition.delay_ms, transition.duration_ms, curve, started)
    }

    fn progress(&self, now: f64) -> f32 {
        let elapsed = elapsed_ms(self.started, now) - self.delay;
        if elapsed < 0.0 {
            0.0
        } else if self.duration <= 0.0 || elapsed >= self.duration {
            1.0
        } else {
            self.curve.at(elapsed / self.duration)
        }
    }

    fn finished(&self, now: f64) -> bool {
        elapsed_ms(self.started, now) >= self.delay + self.duration
    }
}

fn elapsed_ms(started: f64, now: f64) -> f32 {
    ((now - started).max(0.0) * 1000.0) as f32
}

/// Solves CSS's time coordinate before sampling its value coordinate.
/// The native animation sampler is checked against this allocation-free path.
fn bezier([x1, y1, x2, y2]: [f32; 4], x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let (cx, cy) = (3.0 * x1, 3.0 * y1);
    let (bx, by) = (3.0 * (x2 - x1) - cx, 3.0 * (y2 - y1) - cy);
    let (ax, ay) = (1.0 - cx - bx, 1.0 - cy - by);
    let sample_x = |t: f32| ((ax * t + bx) * t + cx) * t;
    let slope_x = |t: f32| (3.0 * ax * t + 2.0 * bx) * t + cx;
    let mut t = x;
    let mut solved = false;
    for _ in 0..8 {
        let error = sample_x(t) - x;
        if error.abs() < 1e-6 {
            solved = true;
            break;
        }
        let slope = slope_x(t);
        if slope.abs() < 1e-6 {
            break;
        }
        t -= error / slope;
    }
    if !solved || !(0.0..=1.0).contains(&t) {
        let (mut lo, mut hi) = (0.0, 1.0);
        t = x;
        for _ in 0..32 {
            let value = sample_x(t);
            if (value - x).abs() < 1e-6 {
                break;
            }
            if value < x {
                lo = t;
            } else {
                hi = t;
            }
            t = (lo + hi) * 0.5;
        }
    }
    ((ay * t + by) * t + cy) * t
}

/// Fits the spring's envelope inside the configured layout duration.
fn spring(damping: f32, progress: f32) -> f32 {
    if progress <= 0.0 {
        return 0.0;
    }
    if progress >= 1.0 {
        return 1.0;
    }
    let damping = damping.clamp(0.05, 1.0);
    if damping > 0.999 {
        let frequency = 9.233;
        return 1.0 - (1.0 + frequency * progress) * (-frequency * progress).exp();
    }
    let frequency = 6.907_755 / damping;
    let damped = frequency * (1.0 - damping * damping).sqrt();
    1.0 - (-damping * frequency * progress).exp()
        * ((damped * progress).cos() + damping * frequency / damped * (damped * progress).sin())
}

fn lerp(a: f32, b: f32, progress: f32) -> f32 {
    a + (b - a) * progress
}

fn lerp_points(a: Points, b: Points, progress: f32) -> Points {
    a + (b - a) * progress
}

fn lerp_bounds(a: Bounds<Points>, b: Bounds<Points>, progress: f32) -> Bounds<Points> {
    Bounds::new(
        Point::new(
            lerp_points(a.origin.x, b.origin.x, progress),
            lerp_points(a.origin.y, b.origin.y, progress),
        ),
        Size::new(
            lerp_points(a.size.width, b.size.width, progress).max(Points::ZERO),
            lerp_points(a.size.height, b.size.height, progress).max(Points::ZERO),
        ),
    )
}

/// Premultiplication keeps a transparent endpoint from darkening a color.
fn lerp_color(a: Color, b: Color, progress: f32) -> Color {
    if a == b {
        return a;
    }
    let parts = |color: Color| {
        let (r, g, b, a) = color.to_f64();
        let alpha = a as f32;
        [r as f32 * alpha, g as f32 * alpha, b as f32 * alpha, alpha]
    };
    let (a, b) = (parts(a), parts(b));
    let p: [f32; 4] = std::array::from_fn(|i| lerp(a[i], b[i], progress.clamp(0.0, 1.0)));
    if p[3] <= 0.0 {
        return Color::TRANSPARENT;
    }
    let channel = |value: f32| (value * 255.0).round().clamp(0.0, 255.0) as u8;
    Color::rgba(
        channel(p[0] / p[3]),
        channel(p[1] / p[3]),
        channel(p[2] / p[3]),
        channel(p[3]),
    )
}

fn lerp_transform(a: &Transform, b: &Transform, progress: f32) -> Option<Transform> {
    let (a, b) = (a.ops(), b.ops());
    if !(a.is_empty() || b.is_empty() || a.iter().map(|op| op.kind).eq(b.iter().map(|op| op.kind)))
    {
        return None;
    }
    let kinds = if a.is_empty() { b } else { a };
    let mut out = Transform::IDENTITY;
    for (index, op) in kinds.iter().enumerate() {
        let from = a.get(index).map_or(op.kind.identity(), |op| op.value);
        let to = b.get(index).map_or(op.kind.identity(), |op| op.value);
        out.push(op.kind, lerp(from, to, progress));
    }
    Some(out)
}

fn box_shadows(style: &ViewStyle) -> &[BoxShadow] {
    style
        .effects
        .as_deref()
        .map_or(&[], |effects| &effects.box_shadows)
}

fn lerp_box_shadows(a: &[BoxShadow], b: &[BoxShadow], progress: f32) -> Option<Vec<BoxShadow>> {
    let empty = |other: BoxShadow| BoxShadow {
        offset_x: Points::ZERO,
        offset_y: Points::ZERO,
        blur: Points::ZERO,
        spread: Points::ZERO,
        color: Color::TRANSPARENT,
        inset: other.inset,
    };
    let mut out = Vec::with_capacity(a.len().max(b.len()));
    for i in 0..a.len().max(b.len()) {
        let (from, to) = match (a.get(i), b.get(i)) {
            (Some(from), Some(to)) => (*from, *to),
            (Some(from), None) => (*from, empty(*from)),
            (None, Some(to)) => (empty(*to), *to),
            (None, None) => unreachable!("index is below the longer list's length"),
        };
        if from.inset != to.inset {
            return None;
        }
        out.push(BoxShadow {
            offset_x: lerp_points(from.offset_x, to.offset_x, progress),
            offset_y: lerp_points(from.offset_y, to.offset_y, progress),
            blur: lerp_points(from.blur, to.blur, progress).max(Points::ZERO),
            spread: lerp_points(from.spread, to.spread, progress),
            color: lerp_color(from.color, to.color, progress),
            inset: from.inset,
        });
    }
    Some(out)
}

fn differs(a: &ViewStyle, b: &ViewStyle, props: TransitionProps) -> bool {
    (props.has(TransitionProps::COLORS)
        && (a.background_color != b.background_color
            || a.borders.colors != b.borders.colors
            || a.outline.color != b.outline.color
            || a.tint_color != b.tint_color))
        || (props.has(TransitionProps::OPACITY) && a.opacity != b.opacity)
        || (props.has(TransitionProps::TRANSFORM) && a.transform != b.transform)
        || (props.has(TransitionProps::SHADOW) && box_shadows(a) != box_shadows(b))
        || (props.has(TransitionProps::SHAPE)
            && (a.border_radius != b.border_radius
                || a.corner_radius != b.corner_radius
                || a.borders.widths != b.borders.widths
                || a.outline.width != b.outline.width))
}

fn lerp_style(
    out: &mut ViewStyle,
    from: &ViewStyle,
    to: &ViewStyle,
    props: TransitionProps,
    p: f32,
) {
    if props.has(TransitionProps::COLORS) {
        out.background_color = lerp_color(from.background_color, to.background_color, p);
        out.borders.colors =
            std::array::from_fn(|i| lerp_color(from.borders.colors[i], to.borders.colors[i], p));
        out.outline.color = lerp_color(from.outline.color, to.outline.color, p);
        if let (Some(a), Some(b)) = (from.tint_color, to.tint_color) {
            out.tint_color = Some(lerp_color(a, b, p));
        }
    }
    if props.has(TransitionProps::OPACITY) {
        out.opacity = lerp(from.opacity, to.opacity, p).clamp(0.0, 1.0);
    }
    if props.has(TransitionProps::TRANSFORM)
        && let Some(transform) = lerp_transform(&from.transform, &to.transform, p)
    {
        out.transform = transform;
    }
    if props.has(TransitionProps::SHADOW)
        && box_shadows(from) != box_shadows(to)
        && let Some(shadows) = lerp_box_shadows(box_shadows(from), box_shadows(to), p)
    {
        let mut effects = to.effects.as_deref().cloned().unwrap_or_default();
        effects.box_shadows = shadows;
        out.effects = Some(Arc::new(effects));
    }
    if props.has(TransitionProps::SHAPE) {
        out.border_radius = lerp_points(from.border_radius, to.border_radius, p).max(Points::ZERO);
        let (from_corners, to_corners) =
            (from.corner_radius.to_array(), to.corner_radius.to_array());
        out.corner_radius = std::array::from_fn(|i| match (from_corners[i], to_corners[i]) {
            (None, None) => None,
            (a, b) => Some(
                lerp_points(
                    a.unwrap_or(from.border_radius),
                    b.unwrap_or(to.border_radius),
                    p,
                )
                .max(Points::ZERO),
            ),
        })
        .into();
        let (from_widths, to_widths) =
            (from.borders.widths.to_array(), to.borders.widths.to_array());
        out.borders.widths =
            std::array::from_fn(|i| lerp_points(from_widths[i], to_widths[i], p).max(Points::ZERO))
                .into();
        out.outline.width = lerp_points(from.outline.width, to.outline.width, p).max(Points::ZERO);
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{LayoutAnimation, TransformKind, Transition, geometry::px};

    use super::*;

    fn frame(x: f32) -> Bounds<Points> {
        Bounds::new(Point::new(px(x), px(16.0)), Size::new(px(80.0), px(32.0)))
    }

    fn near(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.001, "{actual} != {expected}");
    }

    #[test]
    fn frame_sampling_uses_seconds_and_cleans_up_without_changing_target() {
        let mut motion = NodeMotion::default();
        motion.frame_changed(frame(0.0), LayoutAnimation::LINEAR.update.as_ref(), 10.0);
        let target = frame(80.0);
        near(
            motion
                .sample(target, &ViewStyle::default(), 10.125)
                .frame
                .origin
                .x
                .0,
            20.0,
        );
        assert!(!motion.advance(10.25));
        assert!(motion.active());
        assert!(!motion.advance(10.5));
        assert!(!motion.active());
        assert_eq!(
            motion.sample(target, &ViewStyle::default(), 10.5).frame,
            target
        );
    }

    #[test]
    fn interrupted_frame_continues_from_its_presentation() {
        let mut motion = NodeMotion::default();
        let style = ViewStyle::default();
        motion.frame_changed(frame(0.0), LayoutAnimation::LINEAR.update.as_ref(), 0.0);
        let presented = motion.sample(frame(80.0), &style, 0.25).frame;
        motion.frame_changed(presented, LayoutAnimation::LINEAR.update.as_ref(), 0.25);
        near(
            motion.sample(frame(120.0), &style, 0.25).frame.origin.x.0,
            40.0,
        );
        near(
            motion.sample(frame(120.0), &style, 0.5).frame.origin.x.0,
            80.0,
        );
        motion.frame_changed(frame(80.0), None, 0.5);
        assert_eq!(
            motion.sample(frame(120.0), &style, 0.5).frame.origin.x.0,
            120.0
        );
    }

    #[test]
    fn delayed_create_and_interrupted_delete_have_continuous_opacity() {
        let transition = LayoutTransition {
            delay_ms: 100.0,
            ..LayoutTransition::new(LayoutCurve::Linear, 200.0)
        };
        let mut motion = NodeMotion::default();
        motion.inserted(Some(&transition), 2.0);
        near(motion.appearance(2.05).0, 0.0);
        near(motion.appearance(2.2).0, 0.5);
        let exit = LayoutTransition::new(LayoutCurve::Linear, 200.0);
        assert!(motion.removing(Some(&exit), 2.2));
        assert!(motion.dying());
        near(motion.appearance(2.2).0, 0.5);
        near(motion.appearance(2.3).0, 0.25);
        assert!(motion.removing(Some(&exit), 2.3));
        assert!(!motion.advance(2.3));
        assert!(motion.advance(2.4));
    }

    #[test]
    fn reinserted_exit_takes_input_and_does_not_keep_fading() {
        let mut motion = NodeMotion::default();
        motion.removing(LayoutAnimation::LINEAR.delete.as_ref(), 0.0);
        motion.inserted(None, 0.25);
        assert!(!motion.dying());
        assert!(!motion.active());
        assert!(!motion.advance(1.0));
        near(motion.appearance(1.0).0, 1.0);
    }

    fn transition_style(opacity: f32, color: Color) -> ViewStyle {
        ViewStyle {
            opacity,
            background_color: color,
            transition: Some(Transition {
                properties: TransitionProps(TransitionProps::ALL),
                duration: 200.0,
                delay: 100.0,
                easing: [0.0, 0.0, 1.0, 1.0],
            }),
            ..ViewStyle::default()
        }
    }

    #[test]
    fn style_tracks_sample_colors_opacity_shapes_and_transform() {
        let old = transition_style(0.25, Color::rgba(255, 0, 0, 255));
        let mut target = transition_style(0.75, Color::rgba(0, 0, 255, 255));
        target.transform.push(TransformKind::TranslateX, 80.0);
        target.border_radius = px(16.0);
        target.borders.widths = [px(4.0); 4].into();
        let mut motion = NodeMotion::default();
        motion.style_changed(&old, &target, 3.0);
        let first = motion.sample(frame(0.0), &target, 3.05);
        near(first.style.opacity, 0.25);
        let middle = motion.sample(frame(0.0), &target, 3.2);
        near(middle.style.opacity, 0.5);
        assert_eq!(middle.style.background_color, Color::rgba(128, 0, 128, 255));
        near(middle.style.border_radius.0, 8.0);
        near(middle.style.borders.widths.top.0, 2.0);
        near(middle.style.transform.ops()[0].value, 40.0);
        assert!(!motion.advance(3.3));
        assert!(!motion.active());
        assert!(matches!(
            motion.sample(frame(0.0), &target, 3.3).style,
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn first_mount_does_not_transition_from_default() {
        let mut motion = NodeMotion::default();
        let target = transition_style(0.25, Color::rgba(255, 0, 0, 255));
        motion.style_changed(&ViewStyle::default(), &target, 0.0);
        assert!(!motion.active());
        motion.frame_changed(
            Bounds::default(),
            LayoutAnimation::LINEAR.update.as_ref(),
            0.0,
        );
        assert!(!motion.active());
    }

    #[test]
    fn finite_keyframes_stop_and_unrelated_style_does_not_restart_them() {
        let mut motion = NodeMotion::default();
        let mut style = ViewStyle {
            animation: Some(
                KeyframeAnimation::new(Keyframes::Pulse)
                    .duration(1000.0)
                    .iterations(1),
            ),
            ..ViewStyle::default()
        };
        motion.style_changed(&ViewStyle::default(), &style, 5.0);
        near(motion.appearance(5.5).0, 0.5);
        let old = style.clone();
        style.border_radius = px(4.0);
        motion.style_changed(&old, &style, 5.5);
        near(motion.appearance(5.75).0, 0.75);
        motion.advance(6.0);
        assert!(!motion.active());
        near(motion.appearance(6.0).0, 1.0);
        motion.style_changed(&style.clone(), &style, 7.0);
        assert!(!motion.active());
    }

    #[test]
    fn keyframes_compose_with_layout_presence_and_repeat_only_as_configured() {
        let mut motion = NodeMotion::default();
        let style = ViewStyle {
            animation: Some(KeyframeAnimation::new(Keyframes::Ping)),
            ..ViewStyle::default()
        };
        motion.style_changed(&ViewStyle::default(), &style, 0.0);
        motion.inserted(LayoutAnimation::LINEAR.create.as_ref(), 0.0);
        let (opacity, extra) = motion.appearance(0.25);
        near(opacity, 0.5 * (1.0 - 1.0 / 3.0));
        near(extra.scale, 1.0 + 1.0 / 3.0);
        motion.advance(10.0);
        assert!(motion.active());
        near(motion.appearance(10.25).1.scale, 1.0 + 1.0 / 3.0);
    }

    #[test]
    fn spin_bounce_and_scale_presence_supply_transforms() {
        let mut motion = NodeMotion::default();
        let mut style = ViewStyle {
            animation: Some(KeyframeAnimation::new(Keyframes::Spin)),
            ..ViewStyle::default()
        };
        motion.style_changed(&ViewStyle::default(), &style, 0.0);
        near(motion.appearance(0.25).1.rotate.to_degrees(), 90.0);
        let old = style.clone();
        style.animation = Some(KeyframeAnimation::new(Keyframes::Bounce));
        motion.style_changed(&old, &style, 1.0);
        near(motion.appearance(1.0).1.shift_y_fraction, -0.25);
        near(motion.appearance(1.5).1.shift_y_fraction, 0.0);
        let create = LayoutTransition {
            property: LayoutProperty::Scale,
            ..LayoutTransition::new(LayoutCurve::Linear, 200.0)
        };
        motion.inserted(Some(&create), 1.5);
        let (opacity, extra) = motion.appearance(1.6);
        near(extra.scale, 0.5);
        near(opacity, 1.0);
    }

    #[test]
    fn easing_matches_native_graph_samples_and_springs_settle() {
        let curve = [0.25, 0.1, 0.25, 1.0];
        let samples = nsh_core::animation::sample_easing(
            nsh_core::animation::Easing::Bezier(curve[0], curve[1], curve[2], curve[3]),
            101,
        );
        for (index, value) in samples.iter().enumerate() {
            near(bezier(curve, index as f32 / 100.0), *value);
        }
        assert!((1..100).any(|index| spring(0.4, index as f32 / 100.0) > 1.1));
        assert_eq!(spring(0.4, 1.0), 1.0);
        assert!((1..100).all(|index| spring(1.0, index as f32 / 100.0) <= 1.0));
        assert_eq!(
            lerp_color(Color::TRANSPARENT, Color::rgba(255, 0, 0, 255), 0.5),
            Color::rgba(255, 0, 0, 128)
        );
    }
}
