//! The parts of a `RichEditor` the app styles: the editor's own (the root,
//! the content, the caret, the selection, the placeholder, ...) and those
//! of the document's nodes and marks, by type name. Classes
//! ([`RichEditorClasses`]) and inline styles ([`RichEditorStyles`]) both
//! name a node's part by its type (`heading`) or by its type and an
//! attribute's value (`heading[level=2]`), which comes after the type's.

use std::collections::BTreeMap;

use nsh_core::{
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, Style, TsTypes},
    prelude::*,
};
use serde_json::Value;

use crate::{
    rich_editor::model::{Attrs, Mark, Node},
    text_view::PartStyle,
};

/// Tailwind classes of a `RichEditor`'s parts (`classes={{ caret:
/// "bg-primary", nodes: { heading: "font-bold", "heading[level=1]":
/// "text-3xl" }, marks: { bold: "font-bold" } }}`), after the parts' own
/// styles.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct RichEditorClasses {
    /// The editor's box.
    #[prop(skip_none)]
    pub root: Option<SharedString>,
    /// The box of the document's blocks, in the editor's scroll view (its
    /// padding is the room around the text).
    #[prop(skip_none)]
    pub content: Option<SharedString>,
    /// The caret (2 points wide, in the theme's `foreground`).
    #[prop(skip_none)]
    pub caret: Option<SharedString>,
    /// The background of selected text (the theme's selection color).
    #[prop(skip_none)]
    pub selection: Option<SharedString>,
    /// The placeholder, a span after the empty textblock's (empty) text,
    /// in the block's typography (in the theme's `muted-foreground`).
    #[prop(skip_none)]
    pub placeholder: Option<SharedString>,
    /// The gap cursor, a horizontal caret between blocks where no text can
    /// go (20 points wide, 2 high, the caret's color).
    #[prop(skip_none)]
    pub gap_cursor: Option<SharedString>,
    /// Where a dragged selection drops: a caret in text, a line between
    /// blocks (in the caret's color).
    #[prop(skip_none)]
    pub drop_cursor: Option<SharedString>,
    /// The checkbox of a task item (a node whose spec's `extra.render` is
    /// `"task"`, with a `checked` attribute): the item is a row of the
    /// checkbox and its content; a `Checkbox` with no look.
    #[prop(skip_none)]
    pub task_checkbox: Option<SharedString>,
    /// A block the selection is in while the editor has the focus (after
    /// its node's classes), as `focusMode` picks them.
    #[prop(skip_none)]
    pub focused_node: Option<SharedString>,
    /// What an input method is composing at the caret (underlined).
    #[prop(skip_none)]
    pub composition: Option<SharedString>,
    /// A node a node selection holds (after its node's classes).
    #[prop(skip_none)]
    pub selected_node: Option<SharedString>,
    /// The marker of a list's item (`•`, `◦`, `▪` by depth, or `1.`), for
    /// lists whose node spec's `extra.listMarker` is `"bullet"` or
    /// `"ordered"`: placed in the indent before the item, its end against
    /// it (in the list's indent, the list's node classes', as a browser
    /// indents `ul`).
    #[prop(skip_none)]
    pub list_marker: Option<SharedString>,
    /// The nodes' boxes, by type name (`paragraph`) or by type and
    /// attribute (`heading[level=2]`).
    #[prop(skip_none)]
    pub nodes: Option<BTreeMap<String, String>>,
    /// The marks' text, by type name (`bold`) or by type and attribute
    /// (`link[href=…]`).
    #[prop(skip_none)]
    pub marks: Option<BTreeMap<String, String>>,
}

/// Inline styles of a `RichEditor`'s parts, over their classes, named as
/// [`RichEditorClasses`]'s.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct RichEditorStyles {
    /// The editor's box.
    #[prop(skip_none)]
    pub root: Option<PartStyle>,
    /// The box of the document's blocks.
    #[prop(skip_none)]
    pub content: Option<PartStyle>,
    /// The caret.
    #[prop(skip_none)]
    pub caret: Option<PartStyle>,
    /// The background of selected text.
    #[prop(skip_none)]
    pub selection: Option<PartStyle>,
    /// The placeholder.
    #[prop(skip_none)]
    pub placeholder: Option<PartStyle>,
    /// The gap cursor.
    #[prop(skip_none)]
    pub gap_cursor: Option<PartStyle>,
    /// The drop cursor.
    #[prop(skip_none)]
    pub drop_cursor: Option<PartStyle>,
    /// A task item's checkbox.
    #[prop(skip_none)]
    pub task_checkbox: Option<PartStyle>,
    /// A block the selection is in, while focused.
    #[prop(skip_none)]
    pub focused_node: Option<PartStyle>,
    /// What an input method is composing.
    #[prop(skip_none)]
    pub composition: Option<PartStyle>,
    /// A node a node selection holds.
    #[prop(skip_none)]
    pub selected_node: Option<PartStyle>,
    /// The marker of a list's item.
    #[prop(skip_none)]
    pub list_marker: Option<PartStyle>,
    /// The nodes' boxes, by type name or type and attribute.
    #[prop(skip_none)]
    pub nodes: Option<PartStyles>,
    /// The marks' text, by type name or type and attribute.
    #[prop(skip_none)]
    pub marks: Option<PartStyles>,
}

/// Styles by part name: `Record<string, StyleProp<TextStyle>>`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartStyles(pub BTreeMap<String, Style>);

impl JsValue for PartStyles {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Record<string, StyleProp<TextStyle>>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(Self::default());
        }
        let mut out = BTreeMap::new();
        for key in value.keys()? {
            let field = value.field(&key)?;
            out.insert(key, Style::from_js(field.get())?);
        }
        Ok(Self(out))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        for (key, style) in &self.0 {
            let value = style.to_js(host)?;
            host.set_field(object.get().raw(), key, value.into_raw())?;
        }
        Ok(object)
    }
}

/// One of the editor's own parts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    Root,
    Content,
    Caret,
    Selection,
    Placeholder,
    Composition,
    SelectedNode,
    ListMarker,
    GapCursor,
    DropCursor,
    TaskCheckbox,
    FocusedNode,
}

impl RichEditorClasses {
    pub(crate) fn part(&self, part: Part) -> Option<&SharedString> {
        match part {
            Part::Root => self.root.as_ref(),
            Part::Content => self.content.as_ref(),
            Part::Caret => self.caret.as_ref(),
            Part::Selection => self.selection.as_ref(),
            Part::Placeholder => self.placeholder.as_ref(),
            Part::Composition => self.composition.as_ref(),
            Part::SelectedNode => self.selected_node.as_ref(),
            Part::ListMarker => self.list_marker.as_ref(),
            Part::GapCursor => self.gap_cursor.as_ref(),
            Part::DropCursor => self.drop_cursor.as_ref(),
            Part::TaskCheckbox => self.task_checkbox.as_ref(),
            Part::FocusedNode => self.focused_node.as_ref(),
        }
    }
}

impl RichEditorStyles {
    pub(crate) fn part(&self, part: Part) -> Option<&Style> {
        let style = match part {
            Part::Root => &self.root,
            Part::Content => &self.content,
            Part::Caret => &self.caret,
            Part::Selection => &self.selection,
            Part::Placeholder => &self.placeholder,
            Part::Composition => &self.composition,
            Part::SelectedNode => &self.selected_node,
            Part::ListMarker => &self.list_marker,
            Part::GapCursor => &self.gap_cursor,
            Part::DropCursor => &self.drop_cursor,
            Part::TaskCheckbox => &self.task_checkbox,
            Part::FocusedNode => &self.focused_node,
        };
        style.as_ref().map(|s| &s.0)
    }
}

/// The part names of a node or mark of type `name` with `attrs`: the
/// type's, then one per attribute with a plain value.
pub(crate) fn part_names(name: &str, attrs: &Attrs) -> Vec<String> {
    let mut names = vec![name.to_owned()];
    for (key, value) in attrs {
        let value = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        names.push(format!("{name}[{key}={value}]"));
    }
    names
}

/// The classes of a node's part.
pub(crate) fn node_classes(classes: &RichEditorClasses, node: &Node) -> Vec<String> {
    lookup(classes.nodes.as_ref(), node.ty().name(), node.attrs())
}

/// The classes of a mark's part.
pub(crate) fn mark_classes(classes: &RichEditorClasses, mark: &Mark) -> Vec<String> {
    lookup(classes.marks.as_ref(), mark.ty().name(), mark.attrs())
}

fn lookup(map: Option<&BTreeMap<String, String>>, name: &str, attrs: &Attrs) -> Vec<String> {
    let Some(map) = map else {
        return Vec::new();
    };
    part_names(name, attrs)
        .iter()
        .filter_map(|n| map.get(n).cloned())
        .collect()
}

/// The styles of a node's part, in order.
pub(crate) fn node_styles(styles: &RichEditorStyles, node: &Node) -> Vec<Style> {
    lookup_style(styles.nodes.as_ref(), node.ty().name(), node.attrs())
}

/// The styles of a mark's part, in order.
pub(crate) fn mark_styles(styles: &RichEditorStyles, mark: &Mark) -> Vec<Style> {
    lookup_style(styles.marks.as_ref(), mark.ty().name(), mark.attrs())
}

fn lookup_style(map: Option<&PartStyles>, name: &str, attrs: &Attrs) -> Vec<Style> {
    let Some(map) = map else {
        return Vec::new();
    };
    part_names(name, attrs)
        .iter()
        .filter_map(|n| map.0.get(n).cloned())
        .collect()
}

/// `classes` joined, `None` when there are none.
pub(crate) fn join(classes: Vec<String>) -> Option<SharedString> {
    (!classes.is_empty()).then(|| SharedString::from(classes.join(" ")))
}

/// `styles` merged in order (later ones win).
pub(crate) fn merge(styles: &[Style]) -> Style {
    Style::from_decls(styles.iter().flat_map(|s| s.decls().iter().cloned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attribute_parts_follow_the_type() {
        let mut attrs = Attrs::new();
        attrs.insert("level".into(), Value::from(2));
        attrs.insert("id".into(), Value::Null);
        assert_eq!(
            part_names("heading", &attrs),
            ["heading", "heading[level=2]"]
        );
        let classes = RichEditorClasses {
            nodes: Some(BTreeMap::from([
                ("heading".into(), "font-bold".into()),
                ("heading[level=2]".into(), "text-xl".into()),
            ])),
            ..Default::default()
        };
        assert_eq!(
            lookup(classes.nodes.as_ref(), "heading", &attrs),
            ["font-bold", "text-xl"]
        );
    }
}
