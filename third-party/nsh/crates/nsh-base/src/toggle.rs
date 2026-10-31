//! `Toggle` and `ToggleGroup`: a button that is on or off (bold in a text
//! toolbar, a favorite star) and a toolbar of them, with no look of their
//! own. The group is one stop of the keyboard focus whose arrow keys move
//! between its toggles without pressing them (`roving.rs`); inside a
//! `Toolbar` it is a group of the toolbar's, whose stop it shares.

use nsh_core::{AccessibilityState, Checked, element::Style, prelude::*};

use crate::roving::{Bar, Pattern, Roving, bar, bar_item, nested_bar, provide_bar};

/// The props of [`Toggle`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ToggleProps {
    /// On or off. The app owns the value: a press reports the next one
    /// with `onChange`, and the toggle shows the value the app passes back.
    #[prop(default)]
    pub pressed: Prop<bool>,
    /// No presses, no press feedback; `disabled:` styles apply, and screen
    /// readers say it is dimmed. A toggle in a disabled [`ToggleGroup`] or
    /// `Toolbar` is disabled too.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The style while `pressed` (and not disabled), as `aria-pressed:`
    /// classes.
    #[prop(default)]
    pub pressed_style: Prop<Style>,
    /// What screen readers say: what the toggle turns on, when its children
    /// have no text that says it (an icon).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: the app's icon or label, whose `group-aria-pressed:`
    /// classes follow the toggle under `group` in its `class`, and which
    /// screen readers say.
    pub children: Prop<Children>,
}

/// The events of a [`Toggle`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ToggleEvent {
    /// The toggle was pressed (a tap, a click, Space or Return, a screen
    /// reader's activation): the value it asks for, the opposite of
    /// `pressed`. It runs before anything changes: the toggle shows the
    /// `pressed` the app passes back.
    #[args(pressed)]
    Change(bool),
}

/// A button that is on or off (bold, a favorite, a view option), alone or
/// in a [`ToggleGroup`]. It owns its behavior (presses, keyboard
/// activation, the disabled state, the button role and its pressed state
/// for screen readers: a toggle button) and leaves its look to the app: no
/// colors, sizes, icon or label of its own. The app's `class` and `style`
/// style it, `aria-pressed:` and `disabled:` classes (or `pressedStyle`
/// and `disabledStyle`) its states, `active:` the press in progress, and
/// its children are its content, whose `group-aria-pressed:` classes
/// follow the toggle under `group` in its `class`. In a [`ToggleGroup`]
/// or a `Toolbar`, it is a stop of the keyboard focus only while it is the
/// item Tab enters the group at (see [`ToggleGroup`]).
#[component]
pub fn Toggle(props: ToggleProps, cx: Scope<ToggleEvent>) -> impl IntoElement {
    let pressed = props.pressed;
    // The toolbar pattern: an arrow key only moves the focus, so moving to
    // a toggle presses nothing.
    let (view, disabled) = bar_item(view(), Some(pressed), props.disabled);
    view.disabled(disabled)
        .role(AccessibilityRole::Button)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            pressed: Some(if pressed.get() {
                Checked::True
            } else {
                Checked::False
            }),
            ..AccessibilityState::default()
        })
        .pressed_style(props.pressed_style)
        .on_press(move |_: &()| cx.emit(ToggleEvent::Change(!pressed.get_untracked())))
        .child(props.children)
}

/// The props of [`ToggleGroup`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ToggleGroupProps {
    /// Every toggle of the group is disabled, whatever its own `disabled`;
    /// the arrow keys have nothing to move to.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The toggles of the group, and whatever the app lays out between
    /// them (a separator).
    pub children: Prop<Children>,
}

/// The toolbar around a set of [`Toggle`]s (bold, italic and underline;
/// left, center and right): screen readers hear the toggles inside it as
/// one toolbar, each still an element of its own. It holds no value: each
/// toggle is told whether it is pressed and reports a press with
/// `onChange`, and the app keeps which ones are, any number of them or
/// exactly one (an alignment, a view switcher: the app presses the one
/// asked for and lets go of the others). Its layout and look are the app's
/// `class` and `style` (`flex-row` for a row, a joined segmented outline).
///
/// The keyboard, as WAI-ARIA's toolbar pattern has it, where views that
/// take presses are stops of the keyboard focus (macOS, the web): the
/// group is one stop of Tab, at the first pressed toggle (else the first
/// that is not disabled); Left and Right, and Up and Down, move the focus
/// to the previous and next toggle, around the ends, Home and End to the
/// first and last, past disabled toggles, without pressing them; Space and
/// Return press the focused toggle.
///
/// Inside a `Toolbar` the toolbar is the stop and the group one of its
/// parts: its toggles join the toolbar's items, its arrows and its entry,
/// and screen readers hear the group's role (one toolbar, not one inside
/// another). Its `disabled` still disables its own toggles.
#[component]
pub fn ToggleGroup(props: ToggleGroupProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let (bar, role) = match bar() {
        Some(outer) => (nested_bar(outer, props.disabled), AccessibilityRole::Group),
        None => (
            Bar {
                roving: Roving::new(Pattern::Toggles),
                disabled: props.disabled,
                axis: None,
            },
            AccessibilityRole::Toolbar,
        ),
    };
    provide_bar(bar);
    view().role(role).child(props.children)
}
