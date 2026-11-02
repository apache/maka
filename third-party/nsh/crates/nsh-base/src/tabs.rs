//! `Tab` and `Tabs`: the tabs of a tab list and the list, with no look of
//! their own. The list is one stop of the keyboard focus whose arrow keys
//! move between its tabs (`roving.rs`), and its indicator, when the app
//! styles one, follows the selected tab natively (`View::follow`).

use nsh_core::{
    AccessibilityState,
    element::{LayoutCurve, LayoutTransition, Style},
    prelude::*,
};

use crate::roving::{Pattern, Roving, member};

/// How long the indicator takes to travel to another tab, in milliseconds:
/// as long as `gpui-component`'s `spring_move` (a 280 ms response, a damping
/// ratio of 0.85: `theme/motion.rs`) takes to come within a thousandth of
/// its end, which is where a layout spring of that damping fitted into
/// this duration does too (`nsh_core::transition`).
/// `ln 1000 / (0.85 · 2π / 0.28 s)`.
const INDICATOR_MS: f32 = 362.0;

/// The indicator's travel to another tab: `gpui-component`'s tab bar
/// indicator's `spring_move`, a little springy.
const INDICATOR: LayoutTransition =
    LayoutTransition::new(LayoutCurve::Spring { damping: 0.85 }, INDICATOR_MS);

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
    /// The Tailwind classes of the indicator, the view on the selected tab
    /// (an underline, a pill behind it): its look and its place across the
    /// list (`bottom-0 h-[2px]` for an underline in a row, `inset-y-1` for
    /// a pill). Along the list it spans the selected tab, inside its own
    /// margins on that axis (`mx-2` for a shorter underline), and travels
    /// to the next one natively. With neither this nor `indicatorStyle`,
    /// the list has no indicator.
    pub indicator_class: Prop<Option<SharedString>>,
    /// The style of the indicator, over `indicatorClass`.
    #[prop(default)]
    pub indicator_style: Prop<Style>,
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
///
/// Its indicator (`gpui-component`'s tab bar's: an underline, a pill or a
/// segmented highlight) is a part the app styles with `indicatorClass` and
/// `indicatorStyle`: a view drawn behind the tabs, absolutely positioned in
/// the list, which the core places on the selected tab after each layout.
/// Along the list's main axis (a row's: horizontal, a column's: vertical)
/// it spans the selected tab, inside the indicator's own margins on that
/// axis; across it, the app's classes place it. A change of the selected
/// tab moves it there natively with a spring (`gpui-component`'s
/// `spring_move`), and with reduced motion at once; a layout that moves
/// or resizes the tab moves it in the same frame. No JS runs and no
/// layout event is sent for it. While no tab is selected it is hidden;
/// while several are, it is on the first. It is hidden from screen
/// readers and takes no focus: the arrows, Home and End move between the
/// tabs only. The tabs it follows are in the list, or in views inside it;
/// a list that scrolls is in a scroll view around the `Tabs`.
#[component]
pub fn Tabs(props: TabsProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let list = Roving::new(Pattern::Tabs);
    provide_context(TabsContext(list.clone()));
    let (class, style) = (props.indicator_class, props.indicator_style);
    let styled = move || class.with(Option::is_some) || style.with(|s| *s != Style::default());
    view()
        .role(AccessibilityRole::Tablist)
        .child(when(styled, move || indicator(list.clone(), class, style)))
        .child(props.children)
}

/// The indicator of a tab list: on the selected tab (the first, when
/// several are), behind the tabs (its first child), taking no presses and
/// hidden from screen readers; hidden while no tab is selected.
fn indicator(list: Roving, class: Prop<Option<SharedString>>, style: Prop<Style>) -> View {
    let none = list.clone();
    view()
        .absolute()
        .pointer_events(PointerEvents::None)
        .accessibility_elements_hidden(true)
        .follow(move || list.current())
        .style_when(move || none.current().is_none(), |s| s.hidden())
        .follow_transition(move || (!reduce_motion()).then_some(INDICATOR))
        .app_class(class)
        .inline_style(style)
}
