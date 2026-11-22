//! The gallery's motion: [`Press`] sinks under the finger, [`Appear`]
//! brings content in. Both run natively: only press in / out reach Rust.

use nsh_core::{element::PropEnum, prelude::*};

use super::theme::motion;

/// What a [`Press`] is to assistive technologies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum PressRole {
    /// A button.
    #[default]
    Button,
    /// A tab.
    Tab,
    /// A switch.
    Switch,
    /// A link.
    Link,
}

impl PressRole {
    fn role(self) -> AccessibilityRole {
        match self {
            PressRole::Button => AccessibilityRole::Button,
            PressRole::Tab => AccessibilityRole::Tab,
            PressRole::Switch => AccessibilityRole::Switch,
            PressRole::Link => AccessibilityRole::Link,
        }
    }
}

/// The props of [`Press`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct PressProps {
    /// How far it shrinks.
    #[prop(default = 0.97)]
    pub(crate) scale: Prop<f32>,
    /// Takes no presses, at 40% opacity.
    #[prop(default)]
    pub(crate) disabled: Prop<bool>,
    /// What it is to assistive technologies.
    #[prop(default)]
    pub(crate) role: Prop<PressRole>,
    /// Its accessibility label.
    pub(crate) label: Prop<Option<SharedString>>,
    /// Selected (a tab).
    #[prop(default)]
    pub(crate) selected: Prop<bool>,
    /// Checked (a switch).
    pub(crate) checked: Prop<Option<bool>>,
    /// How far around it a touch still hits it, in points.
    pub(crate) hit_slop: Option<f32>,
    /// It reports long presses ([`PressEvent::LongPress`]) instead of the
    /// presses they end in.
    #[prop(default)]
    pub(crate) long_press: bool,
    /// The content.
    pub(crate) children: Children,
}

/// What a [`Press`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum PressEvent {
    /// It was pressed.
    Press,
    /// It was held (with `long_press`).
    LongPress,
}

/// A pressable that sinks a little under the finger and springs back (the
/// spring runs natively; only press in / out reach Rust). Its content is
/// its children: `press().on_press(..).child(..)`.
#[component]
pub(crate) fn Press(props: PressProps, cx: Scope<PressEvent>) -> impl IntoElement {
    let scale = animated_value(1.0);
    view()
        .bind_scale(&scale)
        .opacity(move || if props.disabled.get() { 0.4_f32 } else { 1.0 })
        .disabled(props.disabled)
        .role(props.role.get_untracked().role())
        .when(props.label.with_untracked(Option::is_some), |v| {
            v.label(move || props.label.get().unwrap_or_default())
        })
        .accessibility_state(move || AccessibilityState {
            disabled: props.disabled.get(),
            selected: props.selected.get(),
            checked: props.checked.get().map(|on| {
                if on {
                    nsh_core::Checked::True
                } else {
                    nsh_core::Checked::False
                }
            }),
            ..AccessibilityState::default()
        })
        .when_some(props.hit_slop, |v, slop| {
            v.hit_slop(EdgeInsets::all(px(slop)))
        })
        .on_press_down(move || {
            scale.spring(props.scale.get_untracked(), motion::PRESS);
        })
        .on_press_up(move || {
            scale.spring(1.0, motion::PRESS);
        })
        .on_press(move || cx.emit(PressEvent::Press))
        .when(props.long_press, |v| {
            v.on_long_press(move || cx.emit(PressEvent::LongPress))
        })
        .child(props.children)
}

/// The props of [`Appear`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct AppearProps {
    /// Its place among siblings coming in together: it waits 40 ms per
    /// place (8 at most).
    #[prop(default)]
    pub(crate) index: u32,
    /// It fills its parent.
    #[prop(default)]
    pub(crate) flex: bool,
    /// The content.
    pub(crate) children: Children,
}

/// Fades and lifts its content in once mounted; `index` staggers siblings
/// (40 ms apart). `flex` lets it wrap a page that fills its parent.
#[component]
pub(crate) fn Appear(props: AppearProps) -> impl IntoElement {
    let shown = animated_value(0.0);
    shown.timing_with(
        1.0,
        Timing {
            delay_ms: props.index.min(8) as f32 * 40.0,
            ..motion::ENTER
        },
    );
    view()
        .when(props.flex, |v| v.flex_1())
        .bind_opacity(&shown)
        .bind_translate_y(&shown.interpolate(&[0.0, 1.0], &[14.0, 0.0]))
        .child(props.children)
}
