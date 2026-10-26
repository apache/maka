//! `Progress`: a linear progress bar with no look of its own.

use nsh_core::{AccessibilityValue, element::Style, prelude::*};

/// The range of [`ProgressProps::value`], as `gpui-base`'s: a percentage.
const MAX: f32 = 100.0;

/// The props of [`Progress`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ProgressProps {
    /// How far the work is, as a percentage from 0 to 100 (clamped). The
    /// app owns the value; the indicator is that share of the track's
    /// width, and screen readers say it.
    #[prop(default)]
    pub value: Prop<f32>,
    /// The work's extent is unknown (connecting, preparing): screen readers
    /// hear a progress bar with no value, and the indicator's width is the
    /// app's (`indicatorClass`), which it animates as it likes.
    #[prop(default)]
    pub indeterminate: Prop<bool>,
    /// What screen readers say: what is in progress, when its children have
    /// no text that says it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the track, the part the indicator fills.
    pub track_class: Prop<Option<SharedString>>,
    /// The style of the track, over `trackClass`.
    #[prop(default)]
    pub track_style: Prop<Style>,
    /// The Tailwind classes of the indicator, inside the track: its height,
    /// color and motion. Its width is `value` percent of the track's while
    /// determinate (a `w-*` class here wins: the app's, for an
    /// indeterminate bar).
    pub indicator_class: Prop<Option<SharedString>>,
    /// The style of the indicator, over `indicatorClass`.
    #[prop(default)]
    pub indicator_style: Prop<Style>,
    /// The content after the track: a label or the value as text, which
    /// screen readers say.
    pub children: Prop<Children>,
}

/// A linear progress bar: how far a task with a known extent is (a
/// download, an upload, a step of a setup), or that one with an unknown
/// extent is under way. It owns what screen readers get (the progress bar
/// role, the range 0 to 100 and the value, none while indeterminate) and
/// the indicator's width by the value, and leaves its look to the app: no
/// colors, sizes, radii, motion or label of its own. Its parts are a track
/// and an indicator inside it, then its children; the app's `class` and
/// `style` style the progress bar, `trackClass` / `trackStyle` and
/// `indicatorClass` / `indicatorStyle` the parts.
#[component]
pub fn Progress(props: ProgressProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let (value, indeterminate) = (props.value, props.indeterminate);
    // NaN is no progress yet; anything else is held to the range.
    let clamped = move || {
        let v = value.get();
        if v.is_nan() { 0.0 } else { v.clamp(0.0, MAX) }
    };
    view()
        // One element for screen readers, its children's text its label.
        .accessible(true)
        .role(AccessibilityRole::Progressbar)
        .optional_label(props.accessibility_label)
        .accessibility_value(move || {
            Some(AccessibilityValue {
                min: Some(0.0),
                max: Some(MAX),
                now: (!indeterminate.get()).then(clamped),
                text: None,
            })
        })
        .child(
            view()
                .app_class(props.track_class)
                .inline_style(props.track_style)
                .child(
                    view()
                        .style_with(move |s| match indeterminate.get() {
                            true => s,
                            false => s.w(relative(clamped() / MAX)),
                        })
                        .app_class(props.indicator_class)
                        .inline_style(props.indicator_style),
                ),
        )
        .child(props.children)
}
