//! `Tab` and `Tabs`: the tabs of a tab list and the list, with no look of
//! their own. The list is one stop of the keyboard focus whose arrow keys
//! move between its tabs (`roving.rs`).

use nsh_core::{AccessibilityState, element::Style, prelude::*};

use crate::roving::{Pattern, Roving, member};

/// What a [`Tab`] finds of its [`Tabs`] through context.
#[derive(Clone)]
struct TabsContext(Roving);

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
    /// reader's activation), the selected tab included, or an arrow key,
    /// Home or End of its [`Tabs`] moved the keyboard focus to it. It runs
    /// before anything changes: the tab shows the `selected` the app passes
    /// back.
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
/// In a [`Tabs`], it is a stop of the keyboard focus only while it is the
/// tab Tab enters the list at (see [`Tabs`]).
#[component]
pub fn Tab(props: TabProps, cx: Scope<TabEvent>) -> impl IntoElement {
    let node = element_ref();
    let list = use_context::<TabsContext>().map(|TabsContext(list)| {
        list.register(node, props.selected, props.disabled, move || {
            cx.emit(TabEvent::Press);
        })
    });
    member(view(), &node, list)
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
///
/// The keyboard, as WAI-ARIA's tab list pattern has it, where views that
/// take presses are stops of the keyboard focus (macOS, the web): the list
/// is one stop of Tab, at the selected tab (else the first that is not
/// disabled); Left and Right, and Up and Down, move the focus to the
/// previous and next tab, around the ends, Home and End to the first and
/// last, past disabled tabs. The tab the focus moves to reports `onPress`,
/// so the app selects it as the focus moves (automatic activation); Space
/// and Return press the focused tab.
#[component]
pub fn Tabs(props: TabsProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    provide_context(TabsContext(Roving::new(Pattern::Tabs)));
    view()
        .role(AccessibilityRole::Tablist)
        .child(props.children)
}
