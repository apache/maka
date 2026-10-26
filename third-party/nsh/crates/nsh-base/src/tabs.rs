//! `Tab` and `Tabs`: the tabs of a tab list and the list, with no look of
//! their own.

use nsh_core::{AccessibilityState, element::Style, prelude::*};

/// The props of [`Tab`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TabProps {
    /// The current tab of its list: screen readers say it is selected, and
    /// `selected:` styles apply. The app owns the value: a press reports
    /// `onPress`, and the app selects the tab and shows its content.
    #[prop(default)]
    pub selected: Prop<bool>,
    /// No presses, no press feedback; `disabled:` styles apply, and screen
    /// readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The style while selected (and not disabled), as `selected:` classes.
    #[prop(default)]
    pub selected_style: Prop<Style>,
    /// What screen readers say: the tab's name, when its children have no
    /// text that says it (an icon).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: the app's label, icon or badge, which screen readers
    /// say.
    pub children: Prop<Children>,
}

/// The events of a [`Tab`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TabEvent {
    /// The tab was pressed (a tap, a click, Space or Return, a screen
    /// reader's activation), the selected tab included. It runs before
    /// anything changes: the tab shows the `selected` the app passes back.
    Press,
}

/// One tab of a tab list (a section of a page, a view of a document), in
/// [`Tabs`] with the others. It owns its behavior (presses, keyboard
/// activation, the disabled state, the tab role and its selected state for
/// screen readers) and leaves its look to the app: no colors, sizes,
/// indicator or label of its own. The app's `class` and `style` style it,
/// `selected:` and `disabled:` classes (or `selectedStyle` and
/// `disabledStyle`) its states, and its children are its content, whose
/// `group-selected:` classes follow the tab under `group` in its `class`.
#[component]
pub fn Tab(props: TabProps, cx: Scope<TabEvent>) -> impl IntoElement {
    view()
        .disabled(props.disabled)
        .role(AccessibilityRole::Tab)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            selected: props.selected.get(),
            ..AccessibilityState::default()
        })
        .selected_style(props.selected_style)
        .on_press(move |_: &()| cx.emit(TabEvent::Press))
        .child(props.children)
}

/// The props of [`Tabs`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TabsProps {
    /// The tabs of the list, and whatever the app lays out between them.
    pub children: Prop<Children>,
}

/// The tab list around a set of [`Tab`]s: screen readers hear the tabs
/// inside it as one list, each still an element of its own. It holds no
/// value and no content: each tab is told whether it is selected and
/// reports a press with `onPress`, and the app keeps which one is and shows
/// that tab's content next to the list. Its layout and look are the app's
/// `class` and `style` (`flex-row` for a row).
#[component]
pub fn Tabs(props: TabsProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Tablist)
        .child(props.children)
}
