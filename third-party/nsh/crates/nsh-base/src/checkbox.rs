//! `Checkbox`: a checked / unchecked / indeterminate control with no look
//! of its own.

use nsh_core::{AccessibilityState, Checked, element::Style, prelude::*};

/// The props of [`Checkbox`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CheckboxProps {
    /// Checked or not. The app owns the value: a press reports the next one
    /// with `onChange`, and the checkbox shows the value the app passes
    /// back.
    #[prop(default)]
    pub checked: Prop<bool>,
    /// Neither checked nor unchecked (a "select all" over a partial
    /// selection), over `checked` while it holds: screen readers say it is
    /// mixed, and a press asks for checked.
    #[prop(default)]
    pub indeterminate: Prop<bool>,
    /// No presses, no press feedback; `disabled:` styles apply to the
    /// checkbox and its indicator, and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The style while checked (and not disabled), as `checked:` classes.
    #[prop(default)]
    pub checked_style: Prop<Style>,
    /// The style while indeterminate (and not disabled), as
    /// `indeterminate:` classes.
    #[prop(default)]
    pub indeterminate_style: Prop<Style>,
    /// What screen readers say: what the checkbox selects, when its
    /// children have no text that says it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What it is for screen readers (default `"checkbox"`; a menu item
    /// that is checked, ...).
    pub role: Prop<Option<AccessibilityRole>>,
    /// The Tailwind classes of the indicator, the box that shows the value;
    /// `checked:`, `indeterminate:` and `disabled:` follow the checkbox.
    pub indicator_class: Prop<Option<SharedString>>,
    /// The style of the indicator, over `indicatorClass`.
    #[prop(default)]
    pub indicator_style: Prop<Style>,
    /// The content of the indicator: the mark (a check, a dash for
    /// indeterminate), which the app shows by the value it owns.
    pub indicator: Prop<Option<Slot>>,
    /// The content after the indicator: a label, which screen readers say.
    pub children: Prop<Children>,
}

/// The events of a [`Checkbox`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum CheckboxEvent {
    /// The checkbox was pressed (a tap, a click, Space or Return): the value
    /// it asks for, `true` from unchecked and from indeterminate, `false`
    /// from checked.
    #[args(checked)]
    Change(bool),
}

/// A control that is checked, unchecked or indeterminate (an option, an
/// item of a selection, "select all"). It owns its behavior (presses,
/// keyboard activation, the disabled state, the checkbox role and its value
/// for screen readers) and leaves its look to the app: no box, mark, colors,
/// sizes or label of its own. Its parts are an indicator (the box, with the
/// app's mark inside: `indicator`), then its children; the app's `class`
/// and `style` style the checkbox, `indicatorClass` / `indicatorStyle` the
/// indicator, and `checked:`, `indeterminate:` and `disabled:` classes on
/// each follow the checkbox's state (or `checkedStyle`,
/// `indeterminateStyle` and `disabledStyle` on the checkbox).
#[component]
pub fn Checkbox(props: CheckboxProps, cx: Scope<CheckboxEvent>) -> impl IntoElement {
    let (checked, indeterminate) = (props.checked, props.indeterminate);
    // Indeterminate wins over checked, as `gpui-base`'s `CheckboxState`
    // holds one of the three.
    let shows_checked = move || checked.get() && !indeterminate.get();
    view()
        .disabled(props.disabled)
        .role(move || props.role.get().unwrap_or(AccessibilityRole::Checkbox))
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            checked: Some(if indeterminate.get() {
                Checked::Mixed
            } else if checked.get() {
                Checked::True
            } else {
                Checked::False
            }),
            ..AccessibilityState::default()
        })
        .checked_style(props.checked_style)
        .indeterminate_style(props.indeterminate_style)
        .on_press(move |_: &()| {
            let next = indeterminate.get_untracked() || !checked.get_untracked();
            cx.emit(CheckboxEvent::Change(next))
        })
        .child(
            view()
                .project_checked(shows_checked)
                .project_indeterminate(indeterminate)
                .project_disabled(props.disabled)
                .app_class(props.indicator_class)
                .inline_style(props.indicator_style)
                .child(props.indicator.place(|mark| mark)),
        )
        .child(props.children)
}
