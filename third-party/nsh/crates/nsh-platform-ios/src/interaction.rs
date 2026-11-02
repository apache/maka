//! What class styles animate and how the pointer looks: transitions of
//! style changes, built-in keyframe animations (`animate-spin`, ...),
//! blend modes and pointer styles.
//!
//! A text's color is not a layer property but the color its lines are
//! drawn in: its transition ([`TextColors`]) draws the laid-out lines
//! again in the in-between color on every frame of a display link that
//! runs only while one moves, as an animated `color` does.

use nsh_core::{
    AttributedText, BlendMode, Cursor, KeyframeAnimation, Keyframes, Transition, TransitionProps,
    ViewStyle, transition,
};
use objc2::{
    MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, runtime::AnyObject, sel,
};
use objc2_core_foundation::CGFloat;
use objc2_foundation::{NSArray, NSNumber, NSRunLoop, NSRunLoopCommonModes, NSString, ns_string};
use objc2_quartz_core::{
    CABasicAnimation, CADisplayLink, CAKeyframeAnimation, CALayer, CAMediaTiming,
    CAMediaTimingFunction, CATransaction, kCAFillModeBackwards,
};
use objc2_ui_kit::{
    UIAxis, UIPointerEffect, UIPointerShape, UIPointerStyle, UITargetedPreview, UIView,
};

use crate::{target::EventTarget, text_view::TextView};

/// An `NSArray` of numbers, as the untyped arrays keyframe values are.
fn numbers(values: &[f64]) -> Retained<NSArray> {
    let numbers: Vec<Retained<AnyObject>> = values
        .iter()
        .map(|&v| Retained::into_super(Retained::into_super(NSNumber::new_f64(v))).into())
        .collect();
    NSArray::from_retained_slice(&numbers)
}

/// Key of the running keyframe animation.
const KEYFRAMES: &str = "nshKeyframes";

fn timing(c: [f32; 4]) -> Retained<CAMediaTimingFunction> {
    CAMediaTimingFunction::functionWithControlPoints(c[0], c[1], c[2], c[3])
}

/// Layer properties a transition animates, by group.
fn keys(props: TransitionProps) -> Vec<&'static NSString> {
    let mut keys = Vec::new();
    if props.has(TransitionProps::COLORS) {
        keys.extend([ns_string!("backgroundColor"), ns_string!("borderColor")]);
    }
    if props.has(TransitionProps::OPACITY) {
        keys.push(ns_string!("opacity"));
    }
    if props.has(TransitionProps::TRANSFORM) {
        keys.push(ns_string!("transform"));
    }
    if props.has(TransitionProps::SHADOW) {
        keys.extend([
            ns_string!("shadowOpacity"),
            ns_string!("shadowRadius"),
            ns_string!("shadowOffset"),
        ]);
    }
    if props.has(TransitionProps::SHAPE) {
        keys.extend([ns_string!("cornerRadius"), ns_string!("borderWidth")]);
    }
    keys
}

fn value(layer: &CALayer, key: &NSString) -> Option<Retained<AnyObject>> {
    // SAFETY: key-value coding of animatable CALayer properties.
    unsafe { msg_send![layer, valueForKey: key] }
}

/// Runs `apply` (which restyles the view) so that the changes animate
/// along `t`: the view's own layer through explicit animations from its
/// current (presented) values, its sublayers through implicit ones.
pub(crate) fn transition(view: &UIView, t: &Transition, apply: impl FnOnce()) {
    let layer = view.layer();
    let keys = keys(t.properties);
    // From what is on screen now, mid-animation included.
    // SAFETY: a plain getter; the presentation copy is only read.
    let from_layer = unsafe { layer.presentationLayer() }.unwrap_or_else(|| layer.clone());
    let before: Vec<Option<Retained<AnyObject>>> =
        keys.iter().map(|k| value(&from_layer, k)).collect();
    let duration = t.duration as f64 / 1000.0;
    CATransaction::begin();
    CATransaction::setAnimationDuration(duration);
    CATransaction::setAnimationTimingFunction(Some(&timing(t.easing)));
    apply();
    CATransaction::commit();
    // SAFETY: a plain clock read.
    let now = objc2_quartz_core::CACurrentMediaTime();
    for (key, from) in keys.iter().zip(before) {
        let (Some(from), Some(to)) = (from, value(&layer, key)) else {
            continue;
        };
        // SAFETY: `isEqual:` of NSObject.
        let same: bool = unsafe { msg_send![&*from, isEqual: &*to] };
        if same {
            continue;
        }
        let a = CABasicAnimation::animationWithKeyPath(Some(key));
        // SAFETY: values read from the same property, as the animation
        // expects.
        unsafe { a.setFromValue(Some(&from)) };
        a.setDuration(duration);
        a.setTimingFunction(Some(&timing(t.easing)));
        if t.delay > 0.0 {
            a.setBeginTime(now + t.delay as f64 / 1000.0);
            // SAFETY: an immutable Core Animation constant.
            a.setFillMode(unsafe { kCAFillModeBackwards });
        }
        layer.addAnimation_forKey(&a, Some(key));
    }
}

/// The texts whose color transitions (`transition-colors`), stepped on a
/// display link that runs only while one does.
pub(crate) struct TextColors {
    link: Retained<CADisplayLink>,
    texts: Vec<Retained<TextView>>,
}

impl TextColors {
    pub(crate) fn new(target: &EventTarget) -> Self {
        // SAFETY: `textColorFrame:` is implemented by `EventTarget`, which
        // outlives the link (it is invalidated in `Drop`).
        let link =
            unsafe { CADisplayLink::displayLinkWithTarget_selector(target, sel!(textColorFrame:)) };
        crate::animation::full_rate(&link);
        link.setPaused(true);
        // SAFETY: the main run loop and standard modes. Common modes keep
        // the colors moving while a scroll view is tracking.
        unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
        Self {
            link,
            texts: Vec::new(),
        }
    }

    /// `view`'s text changed from `old` to `text`, its style being
    /// `style`: its color transitions as `transition::recolor` says, drawn
    /// over the new lines rather than laid out on every frame. As style
    /// transitions, only on a view on screen.
    pub(crate) fn text_changed(
        &mut self,
        view: &TextView,
        old: &AttributedText,
        text: &AttributedText,
        style: &ViewStyle,
    ) {
        let recolor = if style.transition.is_some() && view.window().is_some() {
            let reduce_motion = objc2_ui_kit::UIAccessibilityIsReduceMotionEnabled();
            transition::recolor(old, text, style, reduce_motion)
        } else {
            transition::Recolor::default()
        };
        if view.recolor(recolor) && !self.texts.iter().any(|t| std::ptr::eq(&**t, view)) {
            self.texts.push(view.retain());
            self.link.setPaused(false);
        }
    }

    /// A tick of the display link: the next color of every text that
    /// transitions; the link pauses once none does.
    pub(crate) fn frame(&mut self) {
        let now = self.link.targetTimestamp() * 1000.0;
        self.texts.retain(|t| t.step_color(now));
        if self.texts.is_empty() {
            self.link.setPaused(true);
        }
    }
}

impl Drop for TextColors {
    fn drop(&mut self) {
        // The link retains its target; invalidating breaks the cycle.
        self.link.invalidate();
    }
}

/// Starts (or stops) a built-in keyframe animation on `layer`.
pub(crate) fn keyframes(layer: &CALayer, animation: Option<&KeyframeAnimation>, height: f64) {
    let key = NSString::from_str(KEYFRAMES);
    layer.removeAnimationForKey(&key);
    let Some(a) = animation else { return };
    let repeat = a.iterations.map_or(f32::INFINITY, |n| n as f32);
    let num = |v: f64| NSNumber::new_f64(v);
    let animation: Retained<objc2_quartz_core::CAAnimation> = match a.keyframes {
        Keyframes::Spin => {
            let b =
                CABasicAnimation::animationWithKeyPath(Some(ns_string!("transform.rotation.z")));
            // SAFETY: numbers for a numeric key path.
            unsafe {
                b.setFromValue(Some(&num(0.0)));
                b.setToValue(Some(&num(std::f64::consts::TAU)));
            }
            b.setAdditive(true);
            b.setTimingFunction(Some(&timing(a.easing)));
            Retained::into_super(Retained::into_super(b))
        }
        Keyframes::Ping => {
            // Scale to 2× and fade out over three quarters, then hold.
            let scale =
                CAKeyframeAnimation::animationWithKeyPath(Some(ns_string!("transform.scale")));
            let fade = CAKeyframeAnimation::animationWithKeyPath(Some(ns_string!("opacity")));
            let times = NSArray::from_retained_slice(&[num(0.0), num(0.75), num(1.0)]);
            // SAFETY: arrays of numbers for numeric key paths.
            unsafe {
                scale.setValues(Some(&numbers(&[1.0, 2.0, 2.0])));
                fade.setValues(Some(&numbers(&[1.0, 0.0, 0.0])));
            }
            scale.setKeyTimes(Some(&times));
            fade.setKeyTimes(Some(&times));
            let group = objc2_quartz_core::CAAnimationGroup::new();
            let animations: [Retained<objc2_quartz_core::CAAnimation>; 2] = [
                Retained::into_super(Retained::into_super(scale)),
                Retained::into_super(Retained::into_super(fade)),
            ];
            group.setAnimations(Some(&NSArray::from_retained_slice(&animations)));
            group.setTimingFunction(Some(&timing(a.easing)));
            Retained::into_super(group)
        }
        Keyframes::Pulse => {
            let fade = CAKeyframeAnimation::animationWithKeyPath(Some(ns_string!("opacity")));
            // SAFETY: an array of numbers for a numeric key path.
            unsafe { fade.setValues(Some(&numbers(&[1.0, 0.5, 1.0]))) };
            fade.setKeyTimes(Some(&NSArray::from_retained_slice(&[
                num(0.0),
                num(0.5),
                num(1.0),
            ])));
            fade.setTimingFunctions(Some(&NSArray::from_retained_slice(&[
                timing(a.easing),
                timing(a.easing),
            ])));
            Retained::into_super(Retained::into_super(fade))
        }
        Keyframes::Bounce => {
            // Up by a quarter of the height and back, easing in to the top
            // and out to the ground (Tailwind's keyframes).
            let up = -0.25 * height;
            let jump = CAKeyframeAnimation::animationWithKeyPath(Some(ns_string!(
                "transform.translation.y"
            )));
            // SAFETY: an array of numbers for a numeric key path.
            unsafe { jump.setValues(Some(&numbers(&[up, 0.0, up]))) };
            jump.setKeyTimes(Some(&NSArray::from_retained_slice(&[
                num(0.0),
                num(0.5),
                num(1.0),
            ])));
            jump.setTimingFunctions(Some(&NSArray::from_retained_slice(&[
                timing([0.0, 0.0, 0.2, 1.0]),
                timing([0.8, 0.0, 1.0, 1.0]),
            ])));
            jump.setAdditive(true);
            Retained::into_super(Retained::into_super(jump))
        }
    };
    animation.setDuration(a.duration as f64 / 1000.0);
    animation.setRepeatCount(repeat);
    if a.delay > 0.0 {
        // SAFETY: a plain clock read.
        animation.setBeginTime(objc2_quartz_core::CACurrentMediaTime() + a.delay as f64 / 1000.0);
    }
    // Keeps running when the view leaves the window and comes back.
    animation.setRemovedOnCompletion(false);
    layer.addAnimation_forKey(&animation, Some(&key));
}

/// `mixBlendMode` as a Core Animation compositing filter name.
pub(crate) fn blend(layer: &CALayer, mode: BlendMode) {
    let name = match mode {
        BlendMode::Normal => None,
        BlendMode::Multiply => Some("multiplyBlendMode"),
        BlendMode::Screen => Some("screenBlendMode"),
        BlendMode::Overlay => Some("overlayBlendMode"),
        BlendMode::Darken => Some("darkenBlendMode"),
        BlendMode::Lighten => Some("lightenBlendMode"),
        BlendMode::ColorDodge => Some("colorDodgeBlendMode"),
        BlendMode::ColorBurn => Some("colorBurnBlendMode"),
        BlendMode::HardLight => Some("hardLightBlendMode"),
        BlendMode::SoftLight => Some("softLightBlendMode"),
        BlendMode::Difference => Some("differenceBlendMode"),
        BlendMode::Exclusion => Some("exclusionBlendMode"),
        BlendMode::Hue => Some("hueBlendMode"),
        BlendMode::Saturation => Some("saturationBlendMode"),
        BlendMode::Color => Some("colorBlendMode"),
        BlendMode::Luminosity => Some("luminosityBlendMode"),
        BlendMode::PlusDarker => Some("plusD"),
        BlendMode::PlusLighter => Some("plusL"),
    };
    let filter = name.map(NSString::from_str);
    // SAFETY: Core Animation takes filter names (strings) here.
    unsafe { layer.setCompositingFilter(filter.as_deref().map(|s| s.as_ref())) };
}

/// The pointer's look over `view` for `cursor` (iPad, Mac Catalyst);
/// `None` is the system pointer.
pub(crate) fn pointer_style(
    view: &UIView,
    cursor: Cursor,
    mtm: MainThreadMarker,
) -> Option<Retained<UIPointerStyle>> {
    Some(match cursor {
        Cursor::Auto | Cursor::Default => return None,
        Cursor::None => UIPointerStyle::hiddenPointerStyle(mtm),
        Cursor::Text => {
            let beam = UIPointerShape::beamWithPreferredLength_axis(
                (view.bounds().size.height as CGFloat).min(24.0),
                UIAxis::Vertical,
                mtm,
            );
            UIPointerStyle::styleWithShape_constrainedAxes(&beam, UIAxis::empty())
        }
        // Pressable things lift or highlight under the pointer.
        _ => {
            let preview = UITargetedPreview::initWithView(UITargetedPreview::alloc(mtm), view);
            let effect = UIPointerEffect::effectWithPreview(&preview);
            // SAFETY: a valid effect, no custom shape.
            unsafe { UIPointerStyle::styleWithEffect_shape(&effect, None) }
        }
    })
}
