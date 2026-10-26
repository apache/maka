//! `Button`: a press target with no look of its own.

use nsh_core::{AccessibilityState, element::Style, prelude::*};

/// The props of [`Button`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ButtonProps {
    /// No presses, no press feedback; `disabled:` styles apply and screen
    /// readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Selected (a toggled trigger, the current tab): screen readers say so.
    /// The app owns the value and styles it.
    #[prop(default)]
    pub selected: Prop<bool>,
    /// The style while `selected` (and not disabled), as `selected:`
    /// classes.
    #[prop(default)]
    pub selected_style: Prop<Style>,
    /// What screen readers say, when its content is not enough (an icon).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What it is for screen readers (default `"button"`: a link, a tab, a
    /// menu item, ...).
    pub role: Prop<Option<AccessibilityRole>>,
    /// The content.
    pub children: Prop<Children>,
}

/// The events of a [`Button`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ButtonEvent {
    /// The button was pressed.
    Press,
    /// A press went down on it (for the app's own press feedback).
    PressDown,
    /// The press ended: released, moved away or cancelled.
    PressUp,
}

/// A press target that owns its behavior (presses, the disabled and
/// selected states, its role for screen readers) and leaves its look to the
/// app: no colors, sizes or label of its own. The app's `class` and `style`
/// style it, its states with `active:`, `hover:`, `focus:`, `selected:` and
/// `disabled:` classes or `activeStyle`, `hoverStyle`, `focusStyle`,
/// `selectedStyle` and `disabledStyle`, and its children are its content.
#[component]
pub fn Button(props: ButtonProps, cx: Scope<ButtonEvent>) -> impl IntoElement {
    view()
        .disabled(props.disabled)
        .role(move || props.role.get().unwrap_or(AccessibilityRole::Button))
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            selected: props.selected.get(),
            ..AccessibilityState::default()
        })
        .selected_style(props.selected_style)
        .on_press(cx.forward(ButtonEvent::Press))
        .on_press_down(cx.forward(ButtonEvent::PressDown))
        .on_press_up(cx.forward(ButtonEvent::PressUp))
        .child(props.children)
}
