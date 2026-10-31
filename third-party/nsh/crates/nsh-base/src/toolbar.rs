//! `Toolbar`, `ToolbarGroup` and `ToolbarSeparator`: a bar of controls (a
//! text editor's formatting, a player's transport, a palette of tools),
//! with no look of its own. The toolbar is one stop of the keyboard focus
//! whose arrow keys move between its items (`roving.rs`): the `Button`s,
//! `Toggle`s and `Link`s inside it, in its groups and `ToggleGroup`s too.

use nsh_core::{geometry::Axis, prelude::*};

use crate::roving::{Bar, Pattern, Roving, bar, nested_bar, provide_bar};

/// The props of [`Toolbar`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ToolbarProps {
    /// The direction its items run (default `"horizontal"`): the arrow
    /// keys that move along it (Left and Right, or Up and Down) and the
    /// direction it lays its children out in (a row, or a column). Read
    /// when the toolbar is made.
    #[prop(default = Axis::Horizontal)]
    pub axis: Prop<Axis>,
    /// Every item of the toolbar is disabled, whatever its own `disabled`:
    /// no presses, no stop of the keyboard focus, dimmed for screen
    /// readers.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers call the toolbar ("Formatting"), when a page
    /// has more than one.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The items (`Button`, `Toggle`, `Link`, a `ToggleGroup`, a `Menu` or
    /// a `Popover`, whose trigger is an item), their [`ToolbarGroup`]s and
    /// [`ToolbarSeparator`]s, and whatever else the app lays out among
    /// them (a title, a spacer, an input).
    pub children: Prop<Children>,
}

/// A bar of controls (a text editor's formatting, a media player's
/// transport, a vertical palette of tools): screen readers hear it as one
/// toolbar, each control still an element of its own. It owns the keyboard
/// and the semantics and leaves the look to the app: no colors, sizes,
/// padding or gaps of its own. It lays its children out along `axis` (a
/// row by default); the rest of its layout and look are the app's `class`
/// and `style`. It holds no value: each control inside keeps its own (a
/// toggle's `pressed`, the app's state behind a button).
///
/// The keyboard, as WAI-ARIA's toolbar pattern has it, where views that
/// take presses are stops of the keyboard focus (macOS, the web): the
/// toolbar is one stop of Tab, at the item the focus last left (the first
/// that is not disabled until then); Left and Right (Up and Down in a
/// vertical toolbar) move the focus to the previous and next item, around
/// the ends, Home and End to the first and last, past disabled items,
/// without pressing them; Space and Return press the focused item. Its
/// items are the `Button`s, `Toggle`s and `Link`s inside it, a
/// [`ToolbarGroup`]'s and a `ToggleGroup`'s included, and the triggers of
/// its `Menu`s and `Popover`s (the views in their `trigger` slots, which
/// the popups give their presses); other controls (an
/// input, a select, a slider) stay stops of their own and keep their
/// arrow keys, and so does what a popup an item opens shows.
#[component]
pub fn Toolbar(props: ToolbarProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let axis = props.axis.get_untracked();
    provide_bar(Bar {
        roving: Roving::new(Pattern::Toolbar(axis)),
        disabled: props.disabled,
        axis: Some(axis),
    });
    view()
        .when(axis == Axis::Horizontal, |v| v.flex_row())
        .role(AccessibilityRole::Toolbar)
        .optional_label(props.accessibility_label)
        .child(props.children)
}

/// The props of [`ToolbarGroup`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ToolbarGroupProps {
    /// Every item of the group is disabled, whatever its own `disabled`.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers call the group ("History", "Alignment").
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The group's items, and whatever the app lays out among them.
    pub children: Prop<Children>,
}

/// A run of related items in a [`Toolbar`] (undo and redo, the paragraph's
/// alignment): screen readers hear the group and its
/// `accessibilityLabel`, so the run reads as one unit. Its items are the
/// toolbar's: the arrow keys move through them as through the toolbar's
/// other items, and the toolbar stays one stop of the keyboard focus. It
/// lays its children out along the toolbar's axis; the rest of its layout
/// and look are the app's `class` and `style`.
#[component]
pub fn ToolbarGroup(props: ToolbarGroupProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let axis = bar().map(|outer| {
        let axis = outer.axis;
        provide_bar(nested_bar(outer, props.disabled));
        axis
    });
    view()
        .when(axis.flatten() == Some(Axis::Horizontal), |v| v.flex_row())
        .role(AccessibilityRole::Group)
        .optional_label(props.accessibility_label)
        .child(props.children)
}

/// The props of [`ToolbarSeparator`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ToolbarSeparatorProps {}

/// A line between runs of a [`Toolbar`]'s items: a view the app styles
/// (`class`, `style`: a hairline across a row, `w-px h-5 bg-border`), never
/// a stop of the keyboard focus.
#[component]
pub fn ToolbarSeparator(_props: ToolbarSeparatorProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view().focusable(false)
}
