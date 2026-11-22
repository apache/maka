//! Tiptap's helpers (`@tiptap/core`'s `helpers/`): the queries toolbars,
//! menus and commands ask of a state. `is_active` and its mark and node
//! halves answer as Tiptap's do: over a range, a mark is active when the
//! marked text (and text whose marks exclude it) covers the whole
//! selection; a node when the nodes of its type cover it.

use serde_json::Value;

use crate::rich_editor::{
    model::{Attrs, Mark, MarkType, Node, NodeType, ResolvedPos, utf16_to_byte},
    state::{EditorState, Selection, Transaction},
    transform::{ReplaceAroundStep, ReplaceStep},
};

/// Whether two attribute values are equal as JS's `===` compares JSON:
/// numbers by value (`2` and `2.0` are one number).
pub fn attr_value_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => a == b,
    }
}

/// Whether `object` has every attribute `wanted` names with its value
/// (Tiptap's `objectIncludes`): an empty `wanted` matches anything, and a
/// missing attribute equals `null`.
pub fn object_includes(object: &Attrs, wanted: &Attrs) -> bool {
    wanted
        .iter()
        .all(|(key, value)| attr_value_eq(object.get(key).unwrap_or(&Value::Null), value))
}

/// A node found around a position ([`find_parent_node`]).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ParentNode {
    /// The position before the node.
    pub pos: usize,
    /// The position where its content starts.
    pub start: usize,
    /// Its depth.
    pub depth: usize,
    /// The node.
    pub node: Node,
}

/// The innermost ancestor of `pos` (not the document) that `predicate`
/// accepts (Tiptap's `findParentNodeClosestToPos`).
pub fn find_parent_node_closest_to_pos(
    pos: &ResolvedPos,
    predicate: &dyn Fn(&Node) -> bool,
) -> Option<ParentNode> {
    (1..=pos.depth).rev().find_map(|depth| {
        let node = pos.node(depth);
        predicate(node).then(|| ParentNode {
            pos: pos.before(depth),
            start: pos.start(depth),
            depth,
            node: node.clone(),
        })
    })
}

/// The innermost ancestor of the selection's start that `predicate`
/// accepts (Tiptap's `findParentNode`).
pub fn find_parent_node(
    selection: &Selection,
    predicate: &dyn Fn(&Node) -> bool,
) -> Option<ParentNode> {
    find_parent_node_closest_to_pos(selection.resolved_from(), predicate)
}

fn find_mark_in_set<'a>(marks: &'a [Mark], ty: &MarkType, attrs: &Attrs) -> Option<&'a Mark> {
    marks
        .iter()
        .find(|mark| mark.ty() == ty && object_includes(mark.attrs(), attrs))
}

/// The range of text around `pos` marked with `ty` (with `attrs`; the
/// attributes of the first such mark there when `None`), in `pos`'s
/// textblock (Tiptap's `getMarkRange`).
pub fn get_mark_range(
    pos: &ResolvedPos,
    ty: &MarkType,
    attrs: Option<&Attrs>,
) -> Option<(usize, usize)> {
    let parent = pos.parent();
    let has = |node: &Option<Node>| {
        node.as_ref()
            .is_some_and(|node| node.marks().iter().any(|m| m.ty() == ty))
    };
    let mut start = parent.child_after(pos.parent_offset);
    if !has(&start.0) {
        start = parent.child_before(pos.parent_offset);
    }
    if !has(&start.0) {
        return None;
    }
    let (Some(node), index, offset) = start else {
        return None;
    };
    let first;
    let attrs = match attrs {
        Some(attrs) => attrs,
        None => {
            first = node
                .marks()
                .iter()
                .find(|m| m.ty() == ty)
                .map(|m| m.attrs().clone())
                .unwrap_or_default();
            &first
        }
    };
    find_mark_in_set(node.marks(), ty, attrs)?;
    let mut start_index = index;
    let mut start_pos = pos.start(pos.depth) + offset;
    let mut end_index = start_index + 1;
    let mut end_pos = start_pos + node.node_size();
    while start_index > 0
        && find_mark_in_set(parent.child(start_index - 1).marks(), ty, attrs).is_some()
    {
        start_index -= 1;
        start_pos -= parent.child(start_index).node_size();
    }
    while end_index < parent.child_count()
        && find_mark_in_set(parent.child(end_index).marks(), ty, attrs).is_some()
    {
        end_pos += parent.child(end_index).node_size();
        end_index += 1;
    }
    Some((start_pos, end_pos))
}

/// A mark and the range it covers ([`get_marks_between`]).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MarkRange {
    /// The mark.
    pub mark: Mark,
    /// Where it starts.
    pub from: usize,
    /// Where it ends.
    pub to: usize,
}

/// The marks between `from` and `to` with the nodes they are on; at a
/// cursor, the marks there with their whole ranges (Tiptap's
/// `getMarksBetween`).
pub fn get_marks_between(from: usize, to: usize, doc: &Node) -> Vec<MarkRange> {
    let mut out = Vec::new();
    if from == to {
        let Ok(pos) = doc.resolve(from) else {
            return out;
        };
        for mark in pos.marks() {
            if let Some((from, to)) = get_mark_range(&pos, mark.ty(), None) {
                out.push(MarkRange { mark, from, to });
            }
        }
    } else {
        doc.nodes_between(from, to, &mut |node, pos, _, _| {
            out.extend(node.marks().iter().map(|mark| MarkRange {
                mark: mark.clone(),
                from: pos,
                to: pos + node.node_size(),
            }));
            true
        });
    }
    out
}

/// Whether marks of `ty` (any type when `None`) with `attrs` are active at
/// the selection, as Tiptap's `isMarkActive`: at a cursor, among the
/// stored marks or those at the cursor; over a range, when the text they
/// mark, with text whose marks exclude `ty`, covers the whole selection.
pub fn is_mark_active(state: &EditorState, ty: Option<&MarkType>, attrs: &Attrs) -> bool {
    let selection = state.selection();
    if selection.empty() {
        let marks = match state.stored_marks() {
            Some(marks) => marks.to_vec(),
            None => selection.resolved_from().marks(),
        };
        return marks
            .iter()
            .filter(|mark| ty.is_none_or(|ty| mark.ty() == ty))
            .any(|mark| object_includes(mark.attrs(), attrs));
    }
    let mut selection_range = 0;
    let mut mark_ranges: Vec<MarkRange> = Vec::new();
    for range in selection.ranges() {
        let (from, to) = (range.from.pos, range.to.pos);
        state.doc().nodes_between(from, to, &mut |node, pos, _, _| {
            if let Some(ty) = ty
                && node.inline_content()
                && !node.ty().allows_mark_type(ty)
            {
                return false;
            }
            if !node.is_text() && node.marks().is_empty() {
                return true;
            }
            let relative_from = from.max(pos);
            let relative_to = to.min(pos + node.node_size());
            selection_range += relative_to - relative_from;
            mark_ranges.extend(node.marks().iter().map(|mark| MarkRange {
                mark: mark.clone(),
                from: relative_from,
                to: relative_to,
            }));
            true
        });
    }
    if selection_range == 0 {
        return false;
    }
    let matched: usize = mark_ranges
        .iter()
        .filter(|r| ty.is_none_or(|ty| r.mark.ty() == ty))
        .filter(|r| object_includes(r.mark.attrs(), attrs))
        .map(|r| r.to - r.from)
        .sum();
    let excluded: usize = mark_ranges
        .iter()
        .filter(|r| ty.is_none_or(|ty| r.mark.ty() != ty && r.mark.ty().excludes(ty)))
        .map(|r| r.to - r.from)
        .sum();
    let range = if matched > 0 {
        matched + excluded
    } else {
        matched
    };
    range >= selection_range
}

/// Whether nodes of `ty` (any type when `None`) with `attrs` are active at
/// the selection, as Tiptap's `isNodeActive`: at a cursor, one around it;
/// over a range, when they cover the whole selection.
pub fn is_node_active(state: &EditorState, ty: Option<&NodeType>, attrs: &Attrs) -> bool {
    let selection = state.selection();
    let (from, to) = (selection.from(), selection.to());
    let mut matched = 0;
    let mut any = false;
    state.doc().nodes_between(from, to, &mut |node, pos, _, _| {
        if node.is_text() {
            return true;
        }
        if ty.is_none_or(|ty| node.ty() == ty) && object_includes(node.attrs(), attrs) {
            any = true;
            matched += to.min(pos + node.node_size()) - from.max(pos);
        }
        true
    });
    if selection.empty() {
        return any;
    }
    matched >= to - from
}

/// Whether the node or mark type `name` (with `attrs`) is active at the
/// selection; with no name, whether any node or mark with `attrs` is
/// (Tiptap's `isActive`). A name the schema does not have is not active.
pub fn is_active(state: &EditorState, name: Option<&str>, attrs: &Attrs) -> bool {
    let schema = state.schema();
    match name {
        None => is_node_active(state, None, attrs) || is_mark_active(state, None, attrs),
        Some(name) => {
            if let Some(ty) = schema.node_type(name) {
                is_node_active(state, Some(&ty), attrs)
            } else if let Some(ty) = schema.mark_type(name) {
                is_mark_active(state, Some(&ty), attrs)
            } else {
                false
            }
        }
    }
}

/// The attributes of the first mark of `ty` at the selection: the stored
/// marks and those at the head at a cursor, else those in the selection
/// (Tiptap's `getMarkAttributes`); empty when there is none.
pub fn get_mark_attributes(state: &EditorState, ty: &MarkType) -> Attrs {
    let selection = state.selection();
    let mut marks = Vec::new();
    if selection.empty() {
        if let Some(stored) = state.stored_marks() {
            marks.extend_from_slice(stored);
        }
        marks.extend(selection.resolved_head().marks());
    } else {
        state
            .doc()
            .nodes_between(selection.from(), selection.to(), &mut |node, _, _, _| {
                marks.extend_from_slice(node.marks());
                true
            });
    }
    marks
        .iter()
        .find(|mark| mark.ty() == ty)
        .map(|mark| mark.attrs().clone())
        .unwrap_or_default()
}

/// The attributes of the innermost (last visited) node of `ty` in the
/// selection (Tiptap's `getNodeAttributes`); empty when there is none.
pub fn get_node_attributes(state: &EditorState, ty: &NodeType) -> Attrs {
    let selection = state.selection();
    let mut found = None;
    state
        .doc()
        .nodes_between(selection.from(), selection.to(), &mut |node, _, _, _| {
            if node.ty() == ty {
                found = Some(node.attrs().clone());
            }
            true
        });
    found.unwrap_or_default()
}

/// The attributes of the node or mark type `name` at the selection
/// (Tiptap's `getAttributes`); empty for a name the schema lacks.
pub fn get_attributes(state: &EditorState, name: &str) -> Attrs {
    let schema = state.schema();
    if let Some(ty) = schema.node_type(name) {
        get_node_attributes(state, &ty)
    } else if let Some(ty) = schema.mark_type(name) {
        get_mark_attributes(state, &ty)
    } else {
        Attrs::new()
    }
}

/// Whether the selection is a cursor at the start of its parent (Tiptap's
/// `isAtStartOfNode`).
pub fn is_at_start_of_node(state: &EditorState) -> bool {
    let selection = state.selection();
    selection.resolved_from().parent_offset == 0 && selection.from() == selection.to()
}

/// Whether the selection is a cursor at the end of its parent, or, with
/// `node_type`, at the end of its innermost ancestor of that type (Tiptap's
/// `isAtEndOfNode`).
pub fn is_at_end_of_node(state: &EditorState, node_type: Option<&str>) -> bool {
    let selection = state.selection();
    if let Some(name) = node_type {
        let Some(parent) = find_parent_node(selection, &|node| node.ty().name() == name) else {
            return false;
        };
        let Ok(inside) = state.doc().resolve(parent.pos + 1) else {
            return false;
        };
        return selection.anchor() + 1 == inside.end(inside.depth);
    }
    let to = selection.resolved_to();
    to.parent_offset + 2 >= to.parent().node_size() && selection.from() == selection.to()
}

/// How [`is_node_empty`] looks.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct NodeEmptyOptions {
    /// Also checks that every child is empty (default true).
    pub check_children: bool,
    /// Counts white space (and hard breaks) as empty (default false).
    pub ignore_whitespace: bool,
}

impl Default for NodeEmptyOptions {
    fn default() -> Self {
        Self {
            check_children: true,
            ignore_whitespace: false,
        }
    }
}

/// Whether `node` is empty (Tiptap's `isNodeEmpty`): no text, no atoms or
/// leaves; hard breaks (`hardBreak`, or the schema's line break
/// replacement) count as empty when white space is ignored.
pub fn is_node_empty(node: &Node, options: NodeEmptyOptions) -> bool {
    if options.ignore_whitespace {
        let is_break = node.ty().name() == "hardBreak"
            || node
                .schema()
                .linebreak_replacement()
                .is_some_and(|ty| node.ty() == &ty);
        if is_break {
            return true;
        }
        if let Some(text) = node.text() {
            return text.trim().is_empty();
        }
    }
    if let Some(text) = node.text() {
        return text.is_empty();
    }
    if node.is_atom() || node.is_leaf() {
        return false;
    }
    if node.child_count() == 0 {
        return true;
    }
    options.check_children
        && node
            .content()
            .iter()
            .all(|child| is_node_empty(child, options))
}

/// The text between `from` and `to` in `node`, `block_separator` before
/// each block after the first (Tiptap's `getTextBetween`; it separates
/// with a blank line, `"\n\n"`, by default).
pub fn get_text_between(node: &Node, from: usize, to: usize, block_separator: &str) -> String {
    let mut text = String::new();
    node.nodes_between(from, to, &mut |child, pos, _, _| {
        if child.is_block() && pos > from {
            text.push_str(block_separator);
        }
        if let Some(t) = child.text() {
            let start = utf16_to_byte(t, from.max(pos) - pos);
            let end = utf16_to_byte(t, to.saturating_sub(pos).min(child.node_size()));
            if start < end {
                text.push_str(&t[start..end]);
            }
        }
        true
    });
    text
}

/// Puts the selection of `tr` at the end of what its last step inserted,
/// when that step (one at index `start_len` or later) is a replace step
/// (Tiptap's `selectionToInsertionEnd`, after ProseMirror's).
pub fn selection_to_insertion_end(tr: &mut Transaction, start_len: usize, bias: i32) {
    let Some(last) = tr.steps.len().checked_sub(1) else {
        return;
    };
    if last < start_len {
        return;
    }
    let step = tr.steps[last].as_any();
    if !step.is::<ReplaceStep>() && !step.is::<ReplaceAroundStep>() {
        return;
    }
    let mut end = None;
    tr.mapping.maps[last].for_each(|_, _, _, new_to| {
        if end.is_none() {
            end = Some(new_to);
        }
    });
    let end = end.unwrap_or(0);
    if let Ok(pos) = tr.doc().resolve(end) {
        let selection = Selection::near(&pos, bias);
        tr.set_selection(selection);
    }
}

/// Whether the nodes on both sides of `pos` exist and neither is isolating
/// (Tiptap's `canJoinItemsAt`).
pub fn can_join_items_at(doc: &Node, pos: usize) -> bool {
    let Ok(at) = doc.resolve(pos) else {
        return false;
    };
    match (at.node_before(), at.node_after()) {
        (Some(before), Some(after)) => {
            !before.ty().spec().isolating && !after.ty().spec().isolating
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{super::test_util::*, *};

    fn attrs(value: Value) -> Attrs {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    #[test]
    fn object_includes_compares_the_wanted_keys() {
        let have = attrs(json!({"level": 2, "id": "x"}));
        assert!(object_includes(&have, &Attrs::new()));
        assert!(object_includes(&have, &attrs(json!({"level": 2.0}))));
        assert!(!object_includes(&have, &attrs(json!({"level": 3}))));
        assert!(object_includes(&have, &attrs(json!({"missing": null}))));
        assert!(!object_includes(&have, &attrs(json!({"missing": 1}))));
    }

    #[test]
    fn mark_activity_over_ranges_needs_the_whole_range() {
        let s = schema();
        let bold = s.mark_type("bold").unwrap();
        let text = s.text("ab", vec![bold.create(None).unwrap()]);
        let doc = n(&s, "doc", vec![n(&s, "paragraph", vec![text, t(&s, "cd")])]);
        let none = Attrs::new();
        assert!(is_mark_active(
            &state(doc.clone(), 1, 3),
            Some(&bold),
            &none
        ));
        assert!(!is_mark_active(
            &state(doc.clone(), 1, 4),
            Some(&bold),
            &none
        ));
        assert!(is_mark_active(
            &state(doc.clone(), 2, 2),
            Some(&bold),
            &none
        ));
        assert!(!is_mark_active(
            &state(doc.clone(), 4, 4),
            Some(&bold),
            &none
        ));
        assert!(is_active(&state(doc.clone(), 1, 3), Some("bold"), &none));
        assert!(is_active(&state(doc.clone(), 1, 3), None, &none));
        assert!(!is_active(&state(doc, 1, 3), Some("missing"), &none));
    }

    #[test]
    fn mark_activity_matches_attributes() {
        let s = schema();
        let link = s.mark_type("link").unwrap();
        let mark = link.create(Some(attrs(json!({"href": "a"})))).unwrap();
        let doc = n(
            &s,
            "doc",
            vec![n(&s, "paragraph", vec![s.text("ab", vec![mark])])],
        );
        let st = state(doc, 1, 3);
        assert!(is_mark_active(
            &st,
            Some(&link),
            &attrs(json!({"href": "a"}))
        ));
        assert!(!is_mark_active(
            &st,
            Some(&link),
            &attrs(json!({"href": "b"}))
        ));
        assert_eq!(get_attributes(&st, "link").get("href"), Some(&json!("a")));
    }

    #[test]
    fn node_activity_and_attributes() {
        let s = schema();
        let heading = s.node_type("heading").unwrap();
        let h = s
            .node(
                "heading",
                Some(attrs(json!({"level": 2}))),
                crate::rich_editor::model::Fragment::from(vec![t(&s, "ab")]),
                vec![],
            )
            .unwrap();
        let doc = n(&s, "doc", vec![h, p(&s, "cd")]);
        let st = state(doc.clone(), 2, 2);
        assert!(is_node_active(
            &st,
            Some(&heading),
            &attrs(json!({"level": 2}))
        ));
        assert!(is_node_active(
            &st,
            Some(&heading),
            &attrs(json!({"level": 2.0}))
        ));
        assert!(!is_node_active(
            &st,
            Some(&heading),
            &attrs(json!({"level": 3}))
        ));
        assert_eq!(get_attributes(&st, "heading").get("level"), Some(&json!(2)));
        // A range over both blocks: the heading covers only part.
        assert!(!is_node_active(
            &state(doc, 2, 6),
            Some(&heading),
            &Attrs::new()
        ));
    }

    #[test]
    fn mark_ranges_and_marks_between() {
        let s = schema();
        let bold = s.mark_type("bold").unwrap();
        let doc = n(
            &s,
            "doc",
            vec![n(
                &s,
                "paragraph",
                vec![
                    t(&s, "x"),
                    s.text("abc", vec![bold.create(None).unwrap()]),
                    t(&s, "y"),
                ],
            )],
        );
        let at = doc.resolve(3).unwrap();
        assert_eq!(get_mark_range(&at, &bold, None), Some((2, 5)));
        // At the end of the marked text, looking backward.
        assert_eq!(
            get_mark_range(&doc.resolve(5).unwrap(), &bold, None),
            Some((2, 5))
        );
        assert_eq!(get_mark_range(&doc.resolve(1).unwrap(), &bold, None), None);
        let between = get_marks_between(3, 3, &doc);
        assert_eq!(between.len(), 1);
        assert_eq!((between[0].from, between[0].to), (2, 5));
    }

    #[test]
    fn parents_positions_and_emptiness() {
        let s = schema();
        let doc = n(
            &s,
            "doc",
            vec![n(&s, "blockquote", vec![p(&s, "ab")]), p(&s, "")],
        );
        let st = state(doc.clone(), 2, 2);
        let found =
            find_parent_node(st.selection(), &|node| node.ty().name() == "blockquote").unwrap();
        assert_eq!((found.pos, found.start, found.depth), (0, 1, 1));
        assert!(is_at_start_of_node(&st));
        assert!(!is_at_end_of_node(&st, None));
        assert!(is_at_end_of_node(&state(doc.clone(), 4, 4), None));
        assert!(is_node_empty(doc.child(1), NodeEmptyOptions::default()));
        assert!(!is_node_empty(doc.child(0), NodeEmptyOptions::default()));
        // As Tiptap's: a separator before every block after `from`, the
        // paragraph in the quote and the empty one after it included.
        assert_eq!(
            get_text_between(&doc, 0, doc.content().size(), "\n\n"),
            "\n\nab\n\n"
        );
        let two = n(&s, "doc", vec![p(&s, "ab"), p(&s, "cd")]);
        assert_eq!(
            get_text_between(&two, 0, two.content().size(), "|"),
            "ab|cd"
        );
        assert_eq!(get_text_between(&two, 2, 6, "|"), "b|c");
    }
}
