//! `Collapsible`: a region whose content is shown or left out, with no look
//! of its own.

use nsh_core::prelude::*;

/// The props of [`Collapsible`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CollapsibleProps {
    /// Expanded: the `content` is in the tree. The app owns the value: its
    /// trigger (a child: a view with `role="button"` and `onPress`) flips
    /// it, and the collapsible
    /// shows the value the app passes.
    #[prop(default)]
    pub open: Prop<bool>,
    /// What expands: placed after the children while `open`, out of the
    /// tree otherwise. It is made once and kept, so what is inside keeps
    /// its state (an input's text, a scroll position) from one opening to
    /// the next.
    pub content: Prop<Option<Slot>>,
    /// What shows either way: a header, the trigger that flips `open`, a
    /// summary.
    pub children: Prop<Children>,
}

/// A region whose content expands and collapses (a "show more", a section of
/// settings, details under a summary). It renders its children always and its
/// `content` after them only while `open`, and holds nothing else: no
/// trigger, chevron, motion or label of its own. The trigger is one of the
/// app's children that flips `open` (a view with `role="button"`), and
/// the app says the
/// expanded state to screen readers there (`accessibilityState={{ expanded:
/// open }}` on the view that takes the press). The app's `class` and
/// `style` lay out and style the region.
#[component]
pub fn Collapsible(props: CollapsibleProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view().child(props.children).child(when(
        move || props.open.get(),
        move || props.content.place(|content| content),
    ))
}
