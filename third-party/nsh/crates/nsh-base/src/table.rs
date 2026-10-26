//! `Table` and its parts: a static table of the app's own rows and cells,
//! with a table's semantics for screen readers and no look of its own (as
//! `gpui-base`'s `Table`, `TableHeader`, `TableBody`, `TableRow`,
//! `TableHead`, `TableCell` and `TableCaption`, which gpui-component styles).
//! For many rows, sorting, selection and resizing, `DataTable` is the
//! table; these parts lay out a few rows the app writes as children.

use nsh_core::prelude::*;

/// The props of [`Table`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TableProps {
    /// What screen readers call the table. A `TableCaption` is content the
    /// app shows, not the table's name.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Its parts: a `TableHeader`, `TableBody`, `TableFooter` and
    /// `TableCaption`, or rows directly.
    pub children: Prop<Children>,
}

/// A table of the app's own rows: an element screen readers know as a
/// table, laying its children out as a column. The app's `class` and
/// `style` give it its look.
#[component]
pub fn Table(props: TableProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Table)
        .optional_label(props.accessibility_label)
        .child(props.children)
}

/// The props of the parts that hold only children: [`TableHeader`],
/// [`TableBody`], [`TableFooter`], [`TableRow`], [`TableHead`],
/// [`TableCell`] and [`TableCaption`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TablePartProps {
    /// What the part holds.
    pub children: Prop<Children>,
}

/// The header group of a [`Table`]: the rows of column headers.
#[component]
pub fn TableHeader(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::RowGroup)
        .child(props.children)
}

/// The body group of a [`Table`]: its rows of data.
#[component]
pub fn TableBody(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::RowGroup)
        .child(props.children)
}

/// The footer group of a [`Table`]: totals, a summary row.
#[component]
pub fn TableFooter(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::RowGroup)
        .child(props.children)
}

/// A row of a [`Table`]: its cells side by side.
#[component]
pub fn TableRow(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .flex_row()
        .role(AccessibilityRole::Row)
        .child(props.children)
}

/// A column's header cell, in a [`TableHeader`]'s row.
#[component]
pub fn TableHead(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::ColumnHeader)
        .child(props.children)
}

/// A cell of a [`TableRow`].
#[component]
pub fn TableCell(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view().role(AccessibilityRole::Cell).child(props.children)
}

/// The caption of a [`Table`]: content the app shows about it (a title, a
/// note under it).
#[component]
pub fn TableCaption(props: TablePartProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    view().child(props.children)
}
