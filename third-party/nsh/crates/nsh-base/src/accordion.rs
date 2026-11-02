//! `Accordion` and its parts: stacked sections that expand and collapse,
//! one at a time or several, with no look of their own (`gpui-base`'s
//! `Accordion`, `AccordionItem`, `AccordionHeader`, `AccordionTrigger` and
//! `AccordionPanel`; `gpui-component`'s `Accordion::multiple`).
//!
//! The root holds the app's `value`, the open items' values, and reports
//! the next one with `onChange`; each item finds it through context and
//! hands its trigger and panel whether it is open. A panel opens and
//! closes as a `Collapsible` does (`collapsible::follow_open`), with the
//! same reveal.

use std::rc::Rc;

use nsh_core::{AccessibilityState, element::Style, prelude::*};

use crate::collapsible::follow_open;

/// What an [`AccordionItem`] finds of its [`Accordion`] through context.
#[derive(Clone)]
struct AccordionContext {
    value: Prop<Vec<SharedString>>,
    multiple: Prop<bool>,
    disabled: Prop<bool>,
    change: Rc<dyn Fn(Vec<SharedString>)>,
}

/// What an [`AccordionTrigger`] and an [`AccordionPanel`] find of their
/// [`AccordionItem`] through context.
#[derive(Clone)]
struct ItemContext {
    open: Memo<bool>,
    disabled: Memo<bool>,
    toggle: Rc<dyn Fn()>,
}

/// The props of [`Accordion`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AccordionProps {
    /// The open items' `value`s. The app owns them: a trigger's press
    /// reports the next ones with `onChange`, and the accordion shows the
    /// ones the app passes back.
    #[prop(default)]
    pub value: Prop<Vec<SharedString>>,
    /// Several items open at once (`gpui-component`'s `multiple`): opening
    /// one leaves the others open. Without it, opening an item closes the
    /// one that was.
    #[prop(default)]
    pub multiple: Prop<bool>,
    /// Every item is disabled: no trigger takes presses, and screen
    /// readers say each is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The [`AccordionItem`]s, and whatever the app lays out between them.
    pub children: Prop<Children>,
}

/// The events of an [`Accordion`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum AccordionEvent {
    /// A trigger was pressed (a tap, a click, Space or Return, a screen
    /// reader's activation): the open items' values as they would be. An
    /// open item's value leaves the list; a closed one's joins it at the
    /// end, or, without `multiple`, replaces it. It runs before anything
    /// changes: set `value` to follow it.
    #[args(value)]
    Change(Vec<SharedString>),
}

/// Stacked sections that each expand and collapse under a header (the
/// questions of an FAQ, the groups of a settings page), one at a time or,
/// with `multiple`, several. It holds the app's `value`, the values of the
/// open [`AccordionItem`]s, and reports the next one with `onChange` when
/// a trigger is pressed; it has no look: its `class` and `style` lay out
/// and style the stack. Screen readers hear it as a group.
///
/// The keyboard: each [`AccordionTrigger`] is a stop of the keyboard focus
/// where views that take presses are (macOS, the web), in the order of the
/// tree, and Space and Return press it. `gpui-base` binds no arrow keys
/// between the triggers, and neither does this.
#[component]
pub fn Accordion(props: AccordionProps, cx: Scope<AccordionEvent>) -> impl IntoElement {
    provide_context(AccordionContext {
        value: props.value,
        multiple: props.multiple,
        disabled: props.disabled,
        change: Rc::new(move |value| cx.emit(AccordionEvent::Change(value))),
    });
    view().role(AccessibilityRole::Group).child(props.children)
}

/// The props of [`AccordionItem`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AccordionItemProps {
    /// What identifies the item in the accordion's `value`: the app's,
    /// never its title (which changes with the language).
    pub value: Prop<SharedString>,
    /// Its trigger takes no presses, and screen readers say it is dimmed;
    /// it stays open or closed as the accordion's `value` says.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The item's [`AccordionHeader`] (with its [`AccordionTrigger`]) and
    /// [`AccordionPanel`], and whatever else the app lays out in it.
    pub children: Prop<Children>,
}

/// One section of an [`Accordion`]: a header whose trigger expands and
/// collapses it, and the panel that shows while it is open. Open while the
/// accordion's `value` holds its `value`, which it hands its trigger and
/// panel; outside an accordion it stays closed. It has no look or role of
/// its own: its `class` and `style` lay out and style the section (a
/// divider between items, a card around each).
#[component]
pub fn AccordionItem(props: AccordionItemProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let accordion = use_context::<AccordionContext>();
    let open = {
        let accordion = accordion.clone();
        computed(move || {
            accordion.as_ref().is_some_and(|a| {
                let value = props.value.get();
                a.value.with(|open| open.contains(&value))
            })
        })
    };
    let disabled = {
        let accordion = accordion.clone();
        computed(move || {
            props.disabled.get() || accordion.as_ref().is_some_and(|a| a.disabled.get())
        })
    };
    let toggle = Rc::new(move || {
        let Some(a) = &accordion else { return };
        let value = props.value.get_untracked();
        let mut next = a.value.get_untracked();
        if let Some(at) = next.iter().position(|v| *v == value) {
            next.remove(at);
        } else if a.multiple.get_untracked() {
            next.push(value);
        } else {
            next = vec![value];
        }
        (a.change)(next);
    });
    provide_context(ItemContext {
        open,
        disabled,
        toggle,
    });
    view().child(props.children)
}

/// The props of [`AccordionHeader`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AccordionHeaderProps {
    /// Its level among the page's headings, for screen readers (1 the top;
    /// `gpui-base`'s default, 3).
    #[prop(default = 3)]
    pub level: Prop<u32>,
    /// The item's [`AccordionTrigger`], and whatever else the app puts in
    /// the header (an icon, a badge, an action of its own).
    pub children: Prop<Children>,
}

/// The heading of an [`AccordionItem`], around its [`AccordionTrigger`]:
/// screen readers hear a heading of its `level` and can move between the
/// items by their headings. Its `class` and `style` lay it out.
#[component]
pub fn AccordionHeader(props: AccordionHeaderProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Header)
        .accessibility_level(props.level)
        .child(props.children)
}

/// The props of [`AccordionTrigger`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AccordionTriggerProps {
    /// The style while its item is open, as `aria-expanded:` classes.
    #[prop(default)]
    pub expanded_style: Prop<Style>,
    /// What screen readers say, when its children have no text that says
    /// it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: the app's title and chevron (`group-aria-expanded:`
    /// classes, under `group` on the trigger, turn it as the item opens).
    pub children: Prop<Children>,
}

/// What expands and collapses its [`AccordionItem`], in the item's
/// [`AccordionHeader`]: a press (a tap, a click, Space or Return, a screen
/// reader's activation) reports the accordion's next `value` with its
/// `onChange`. It is a button that says whether its item is expanded, and
/// is disabled while its item or the accordion is. Its look is the app's:
/// `class` and `style`, `aria-expanded:` classes (or `expandedStyle`) while
/// open, `hover:`, `active:`, `focus:` and `disabled:`; its children are
/// the title and the chevron.
#[component]
pub fn AccordionTrigger(props: AccordionTriggerProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let item = use_context::<ItemContext>();
    let (open, disabled) = match &item {
        Some(item) => (item.open, item.disabled),
        None => (computed(|| false), computed(|| false)),
    };
    view()
        .disabled(disabled)
        .role(AccessibilityRole::Button)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            expanded: Some(open.get()),
            ..AccessibilityState::default()
        })
        .expanded_style(props.expanded_style)
        .on_press(move |_: &()| {
            if let Some(item) = &item {
                (item.toggle)();
            }
        })
        .child(props.children)
}

/// The props of [`AccordionPanel`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AccordionPanelProps {
    /// Opens and closes with a reveal, as `Collapsible`'s `reveal`: the
    /// panel clips its content and its height springs from zero to the
    /// content's own and back, critically damped (`gpui-component`'s
    /// accordion, `MotionReveal`), and the items after it move with it.
    /// Off by default (the panel comes and goes at once), and with reduced
    /// motion. The panel is in the layout while closed, zero high, so its
    /// padding and borders belong on a view of its content.
    #[prop(default)]
    pub reveal: Prop<bool>,
    /// The content stays in the tree while closed (`gpui-base`'s
    /// `keep_mounted`), out of sight, of the keyboard focus and of screen
    /// readers: a video keeps its place, a web view its page. Without it
    /// the content leaves the tree as the panel closes (after the reveal),
    /// and comes back as it was.
    #[prop(default)]
    pub keep_mounted: Prop<bool>,
    /// What screen readers call the region: the item's title, as its
    /// header says it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content.
    pub children: Prop<Children>,
}

/// The content of an [`AccordionItem`], shown while the item is open: a
/// region for screen readers, hidden from them while closed. Its `class`
/// and `style` lay out and style it; with `reveal` it opens and closes
/// with a springing height, run natively as a layout animation of the
/// frames it moves in the commit that opens or closes it (as
/// `Collapsible`'s), so no JS runs while it moves.
#[component]
pub fn AccordionPanel(props: AccordionPanelProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let open = use_context::<ItemContext>()
        .map(|item| item.open)
        .unwrap_or_else(|| computed(|| false));
    let (reveal, keep) = (props.reveal, props.keep_mounted);
    let region = element_ref();
    let mounted = follow_open(open.into_reactive(), reveal.into_reactive(), region);
    view()
        .element_ref(&region)
        .role(AccessibilityRole::Region)
        .optional_label(props.accessibility_label)
        .accessibility_elements_hidden(move || !open.get())
        .style_with(move |s| {
            if !reveal.get() {
                // Out of the layout while closed.
                return if open.get() { s } else { s.hidden() };
            }
            // In the layout, clipping, so its height can spring: zero high
            // while closed, and out of sight once the reveal has closed it.
            let s = s.overflow_hidden();
            match (open.get(), mounted.get()) {
                (true, _) => s,
                (false, true) => s.h(px(0.0)),
                (false, false) => s.h(px(0.0)).invisible(),
            }
        })
        .child(when(
            move || mounted.get() || keep.get(),
            move || props.children,
        ))
}
