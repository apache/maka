//! `Radio` and `RadioGroup`: a set of options the user picks one of, with
//! no look of their own.

use nsh_core::{AccessibilityState, Checked, element::Style, prelude::*};

/// The props of [`Radio`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct RadioProps {
    /// Checked or not. The app owns the value: a press on an unchecked
    /// radio reports `true` with `onChange`, and the app checks it (and
    /// unchecks the others of its set).
    #[prop(default)]
    pub checked: Prop<bool>,
    /// No presses, no press feedback; `disabled:` styles apply, and screen
    /// readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The style while checked (and not disabled), as `checked:` classes.
    #[prop(default)]
    pub checked_style: Prop<Style>,
    /// What screen readers say: the option, when its children have no text
    /// that says it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: the app's indicator (a dot, styled with
    /// `group-checked:` classes under `group` on the radio) and its label,
    /// which screen readers say.
    pub children: Prop<Children>,
}

/// The events of a [`Radio`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum RadioEvent {
    /// An unchecked radio was pressed (a tap, a click, Space or Return): it
    /// asks to be checked, so the value is `true`. It runs before anything
    /// changes: the radio shows the `checked` the app passes back. A
    /// checked radio stays checked and reports nothing, as a radio cannot
    /// uncheck itself.
    #[args(checked)]
    Change(bool),
}

/// One option of a set the user picks exactly one of (a plan, a sort
/// order), in a [`RadioGroup`] with the others. It owns
/// its behavior (presses, keyboard activation, the disabled state, the
/// radio role and its checked state for screen readers) and leaves its
/// look to the app: no circle, dot, colors, sizes or label of its own. The
/// app's `class` and `style` style it, `checked:` and `disabled:` classes
/// (or `checkedStyle` and `disabledStyle`) its states, and its children are
/// the app's indicator and label, whose `group-checked:` classes follow the
/// radio under `group` in its `class`.
#[component]
pub fn Radio(props: RadioProps, cx: Scope<RadioEvent>) -> impl IntoElement {
    let checked = props.checked;
    view()
        .disabled(props.disabled)
        .role(AccessibilityRole::Radio)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || {
            let on = checked.get();
            // Checked and selected both: some screen readers read one,
            // some the other (UI Automation's radios are selection items),
            // as `gpui-base`'s `Radio` states `toggled` and `selected`.
            AccessibilityState {
                checked: Some(if on { Checked::True } else { Checked::False }),
                selected: on,
                ..AccessibilityState::default()
            }
        })
        .checked_style(props.checked_style)
        .on_press(move |_: &()| {
            if !checked.get_untracked() {
                cx.emit(RadioEvent::Change(true));
            }
        })
        .child(props.children)
}

/// The props of [`RadioGroup`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct RadioGroupProps {
    /// The radios of the set, and whatever the app lays out between them.
    pub children: Prop<Children>,
}

/// The container of a set of [`Radio`]s: screen readers hear the radios
/// inside it as one set, each still an element of its own. It holds no
/// value: each radio is told whether it is checked and reports a press
/// with `onChange`, and the app keeps which one is. Its layout and look are
/// the app's `class` and `style` (`flex-row` for a row).
#[component]
pub fn RadioGroup(props: RadioGroupProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Radiogroup)
        .child(props.children)
}
