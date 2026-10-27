//! `Switch`: an on / off control with no look of its own.

use nsh_core::{AccessibilityState, Checked, element::Style, prelude::*};

/// The props of [`Switch`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SwitchProps {
    /// On or off. The app owns the value: a press reports the next one
    /// with `onChange`, and the switch shows the value the app passes back.
    #[prop(default)]
    pub checked: Prop<bool>,
    /// No presses, no press feedback; `disabled:` styles apply to the
    /// switch and its parts, and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The style while `checked` (and not disabled), as `checked:`
    /// classes.
    #[prop(default)]
    pub checked_style: Prop<Style>,
    /// What screen readers say: what the switch turns on, when its children
    /// have no text that says it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the track, the part the thumb moves along;
    /// `checked:` and `disabled:` follow the switch.
    pub track_class: Prop<Option<SharedString>>,
    /// The style of the track, over `trackClass`.
    #[prop(default)]
    pub track_style: Prop<Style>,
    /// The Tailwind classes of the thumb, inside the track (`checked:`
    /// moves it: `checked:translate-x-4`); `checked:` and `disabled:`
    /// follow the switch.
    pub thumb_class: Prop<Option<SharedString>>,
    /// The style of the thumb, over `thumbClass`.
    #[prop(default)]
    pub thumb_style: Prop<Style>,
    /// The content after the track: a label, which screen readers say.
    pub children: Prop<Children>,
}

/// The events of a [`Switch`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SwitchEvent {
    /// The switch was pressed (a tap, a click, Space or Return): the value
    /// it asks for, the opposite of `checked`.
    #[args(checked)]
    Change(bool),
}

/// A control that is on or off and takes effect at once (a setting). It
/// owns its behavior (presses, keyboard activation, the disabled state,
/// the switch role and its value for screen readers) and leaves its look
/// to the app: no colors, sizes, motion or label of its own. Its parts are
/// a track and a thumb inside it, then its children; the app's `class` and
/// `style` style the switch, `trackClass` / `trackStyle` and `thumbClass` /
/// `thumbStyle` the parts, and `checked:` and `disabled:` classes on each
/// follow the switch's state (or `checkedStyle` and `disabledStyle` on the
/// switch).
#[component]
pub fn Switch(props: SwitchProps, cx: Scope<SwitchEvent>) -> impl IntoElement {
    let part = || {
        view()
            .project_checked(props.checked)
            .project_disabled(props.disabled)
    };
    view()
        .disabled(props.disabled)
        .role(AccessibilityRole::Switch)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            checked: Some(if props.checked.get() {
                Checked::True
            } else {
                Checked::False
            }),
            ..AccessibilityState::default()
        })
        .checked_style(props.checked_style)
        .on_press(move |_: &()| cx.emit(SwitchEvent::Change(!props.checked.get_untracked())))
        .child(
            part()
                .app_class(props.track_class)
                .inline_style(props.track_style)
                .child(
                    part()
                        .app_class(props.thumb_class)
                        .inline_style(props.thumb_style),
                ),
        )
        .child(props.children)
}
